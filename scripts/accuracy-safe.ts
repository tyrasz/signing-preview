// npm run accuracy:safe -- [--chain 1|42161|8453|10|137|56|11155111] [--blocks 100 | --follow 600 | --tx 0x…] [--max 40]
//   [--out report.json] [--summary-md summary.md] [--strict] [--dump preview.json]
//
// How well the preview of a Safe transaction's signature (SafeTx: src/typed-data/safe.ts, src/safe-sim.ts) says what
// the transaction goes on to do. Recent execTransaction calls sent to a Safe are rebuilt as the SafeTx an owner
// signed (the owner that sent it, else one its signatures recover to, else the Safe's first), and previewed on the
// state the transaction met: its parent block, its block's header and the block's earlier transactions (as a mined
// transaction is replayed: src/replay.ts), at the price it paid, with the coin it carried (but for what a plain
// call's SafeTx names where the Safe holds less: that the preview sends along by itself) and on its gas limit (with
// room for the stand-ins). No signature of the transaction's is used: the preview stands in for them, as it does
// before any exists.
// Compared with the receipt:
//   - the outcome (the Safe's ExecutionSuccess or ExecutionFailure; a receipt that reverted isn't judged: it can have
//     failed on its signatures or its gas, which a signature's preview doesn't have);
//   - the Safe's token movements, and its native coin where nothing else in the block touched the Safe;
//   - what it changed in the Safe (owners, threshold, modules, guard, fallback handler, singleton: its events), which
//     the preview has to warn of;
//   - the gas, reported and not judged: the signatures that ran weren't the stand-ins.
// Public nodes keep recent state only (Ethereum about 128 blocks, OP Mainnet and Polygon about two minutes, Arbitrum
// about 30 seconds): --blocks takes the latest blocks, newest first; --follow watches for new ones.
import { appendFileSync, writeFileSync } from 'node:fs';
import { decodeFunctionData, encodeFunctionData, hashMessage, parseAbi, recoverAddress, toEventSelector, type Hex } from 'viem';
import { previewRequest } from '../src/preview.ts';
import { liveDependencies } from '../src/server.ts';
import { JsonRpcClient } from '../src/rpc.ts';
import { replayContext, ReplayError } from '../src/replay.ts';
import { readConfig, SAFE_SINGLETONS } from '../src/safe-sim.ts';
import { chainName, EVM_RPCS, rpcUrlFor } from '../src/chains.ts';
import type { Preview, SimulationRequest, SimulationResult } from '../src/types.ts';
import { compareTokens, couldNotLook, differsIn, heldToBalance, type Compared } from './userop-tokens.ts';

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const CHAIN = Number(arg('chain', '1')), BLOCKS = Number(arg('blocks', '100')), FOLLOW = Number(arg('follow', '0')), MAX = Number(arg('max', '40'));
const ONE = arg('tx', ''), OUT = arg('out', ''), SUMMARY = arg('summary-md', ''), DUMP = arg('dump', ''), STRICT = process.argv.includes('--strict');
const URL_ = rpcUrlFor(CHAIN, process.env);
if (!URL_ || !EVM_RPCS[CHAIN]) { console.error(`no RPC for chain ${CHAIN}`); process.exit(2); }
const rpc = new JsonRpcClient({ [CHAIN]: URL_ }, { retries: 6, retryDelayMs: 400 });
const call = <T>(method: string, params: unknown[]) => rpc.call(CHAIN, method, params) as Promise<T>;
const hex = (v: bigint | number) => `0x${v.toString(16)}`;

const SAFE = parseAbi([
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)',
  'function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)',
  'function nonce() view returns (uint256)', 'function VERSION() view returns (string)',
]);
const EXEC = '0x6a761202';
/** Gas over the mined transaction's limit that the stand-in run is given: the stand-ins cost a few thousand gas more a signature than the signatures that ran. */
const STAND_IN_ROOM = 100_000n;
const EXECUTION_SUCCESS = toEventSelector('ExecutionSuccess(bytes32,uint256)'), EXECUTION_FAILURE = toEventSelector('ExecutionFailure(bytes32,uint256)');
/** What a Safe logs when its own configuration changes (the owner, module, guard or handler in a topic from 1.4.1 on, in the data before). */
const CONFIG_EVENT = {
  added: toEventSelector('AddedOwner(address)'), removed: toEventSelector('RemovedOwner(address)'), threshold: toEventSelector('ChangedThreshold(uint256)'),
  enabled: toEventSelector('EnabledModule(address)'), disabled: toEventSelector('DisabledModule(address)'), guard: toEventSelector('ChangedGuard(address)'),
  fallback: toEventSelector('ChangedFallbackHandler(address)'), singleton: toEventSelector('ChangedMasterCopy(address)'),
};
/**
 * What a transaction's events leave changed in the Safe, by what the preview has to warn of: the net of them. A
 * module enabled and disabled again before the transaction ends (a flash loan's way in: DeFi Saver's recipes do it)
 * leaves the Safe as it was, and the preview, which compares the Safe before and after, rightly says nothing.
 */
function configChanged(logged: readonly { topics: readonly string[]; data: string }[], before: { threshold: bigint; guard: string; fallbackHandler: string; singleton: string }): string[] {
  const word = (l: { topics: readonly string[]; data: string }) => (l.topics[1] ?? l.data).slice(-64), address = (l: { topics: readonly string[]; data: string }) => `0x${word(l).slice(-40)}`.toLowerCase();
  const net = (plus: string, minus: string) => { const n = new Map<string, number>(); for (const l of logged) if (l.topics[0] === plus || l.topics[0] === minus) n.set(address(l), (n.get(address(l)) ?? 0) + (l.topics[0] === plus ? 1 : -1)); return [...n.values()].some(v => v !== 0); };
  const last = (topic: string) => logged.filter(l => l.topics[0] === topic).at(-1);
  const moved = (topic: string, was: string) => { const l = last(topic); return !!l && address(l) !== was.toLowerCase(); };
  const threshold = last(CONFIG_EVENT.threshold);
  return [
    ...(net(CONFIG_EVENT.added, CONFIG_EVENT.removed) ? ['owners'] : []), ...(threshold && BigInt(`0x${word(threshold)}`) !== before.threshold ? ['threshold'] : []),
    ...(net(CONFIG_EVENT.enabled, CONFIG_EVENT.disabled) ? ['modules'] : []), ...(moved(CONFIG_EVENT.guard, before.guard) ? ['guard'] : []),
    ...(moved(CONFIG_EVENT.fallback, before.fallbackHandler) ? ['fallback handler'] : []), ...(moved(CONFIG_EVENT.singleton, before.singleton) ? ['singleton'] : []),
  ];
}
/** The preview's warnings of the same (the calldata's own, or what the simulated run changed: src/safe.ts, src/safe-sim.ts). */
const CONFIG_WARNINGS: Record<string, string> = {
  safe_owners_change: 'owners', safe_owners_added: 'owners', safe_owners_removed: 'owners', safe_threshold_change: 'threshold', safe_threshold_changed: 'threshold',
  safe_enable_module: 'modules', safe_module_enabled: 'modules', safe_module_disabled: 'modules', safe_set_guard: 'guard', safe_guard_changed: 'guard',
  safe_fallback_handler: 'fallback handler', safe_fallback_changed: 'fallback handler', safe_upgrade: 'singleton', safe_code_replaced: 'singleton', safe_migration: 'singleton',
};

interface Row {
  hash: string; block: number; safe: string; version: string; owners: number; threshold: number;
  /** Who the SafeTx was previewed as signed by. */
  signer: 'the sender' | 'a signer of it' | "the Safe's first owner";
  /** The receipt: the Safe ran its call, the call failed and the Safe logged it, or the transaction reverted. */
  actual: 'success' | 'failure' | 'reverted';
  /** The preview: it runs, it is expected to fail, or execTransaction wasn't simulated (how it was previewed then). */
  preview: 'success' | 'fails' | 'not simulated';
  how?: string;
  /** `balance`: the Safe's balance change across the block, where the token's logs say another amount than the preview and the balance says the preview's. */
  tokens: (Compared & { balance?: string; unjudged?: string })[];
  native?: { actual: string; simulated: string };
  gas?: { actual: string; simulated: string };
  config: { actual: string[]; warned: string[] };
  differs: string[];
  warnings: string[];
}
const rows: Row[] = [], skipped: Record<string, number> = {};
const skip = (why: string) => { skipped[why] = (skipped[why] ?? 0) + 1; process.stdout.write('s'); };

const TOKEN_LIKE = new Map<string, Promise<boolean>>();
const tokenLike = (address: string): Promise<boolean> => {
  let known = TOKEN_LIKE.get(address);
  if (!known) TOKEN_LIKE.set(address, known = call('eth_call', [{ to: address, data: '0x313ce567' }, 'latest']).then(r => /^0x[0-9a-f]{64}$/i.test(String(r))).catch((e: { rpcError?: unknown }) => !e?.rpcError));
  return known;
};
type Receipt = { transactionHash: string; from: string; to: string | null; logs: { address: string; topics: Hex[]; data: Hex }[] };
const RECEIPTS = new Map<string, Promise<Receipt[]>>();
const blockReceipts = (block: string) => { let r = RECEIPTS.get(block); if (!r) { RECEIPTS.clear(); RECEIPTS.set(block, r = call<Receipt[]>('eth_getBlockReceipts', [block])); } return r; };

/** The owners a Safe's signatures recover to: its ECDSA parts (v 27/28 over the hash, v 31/32 over it as a signed message). */
async function signersOf(signatures: Hex, hash: Hex): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; 2 + (i + 1) * 130 <= signatures.length; i++) {
    const part = signatures.slice(2 + i * 130, 2 + (i + 1) * 130), v = parseInt(part.slice(128), 16);
    if (v !== 27 && v !== 28 && v !== 31 && v !== 32) continue;
    try { out.push((await recoverAddress({ hash: v > 30 ? hashMessage({ raw: hash }) : hash, signature: `0x${part.slice(0, 128)}${(v > 30 ? v - 4 : v).toString(16)}` })).toLowerCase()); } catch { /* not a signature */ }
  }
  return out;
}

async function replay(hash: string): Promise<void> {
  const base = liveDependencies({ [EVM_RPCS[CHAIN].env]: URL_, SIGNING_PREVIEW_FORK_CACHE: 'off' }, { warmUp: false });
  let found: Awaited<ReturnType<typeof replayContext>>;
  try { found = await replayContext({ chainId: CHAIN, hash }, base); } catch (e) { return skip(e instanceof ReplayError ? `not replayable (${e.code})` : `error: ${(e as Error).message.slice(0, 80)}`); }
  const { tx, replay: where } = found;
  const safe = tx.to!.toLowerCase(), parent = where.at.block, number = Number(where.info.block);
  let args: readonly unknown[];
  try { args = decodeFunctionData({ abi: SAFE, data: tx.input }).args as readonly unknown[]; } catch { return skip('calldata that isn\'t execTransaction\'s'); }
  const [to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, signatures] = args as [Hex, bigint, Hex, number, bigint, bigint, bigint, Hex, Hex, Hex];
  // Reads on the parent block (the state the Safe was in), and the block itself for its header.
  const atParent = { has: (c: number) => c === CHAIN, call: (c: number, m: string, ps: unknown[]) => m === 'eth_getBlockByNumber' && ps[0] === 'latest' ? rpc.call(c, m, [hex(number), ps[1]]) : rpc.call(c, m, ps.map(x => x === 'latest' ? parent : x)) };
  const before = await readConfig({ ...base, rpc: atParent }, CHAIN, safe).catch(() => undefined);
  if (!before) return skip("not a Safe whose configuration reads (another contract's execTransaction, or its state is gone)");
  // The Safe earlier in its own block (another transaction of its own first): its nonce and state then aren't the
  // parent block's, which the preview's reads are of.
  const receipts = await blockReceipts(hex(number)).catch(() => undefined);
  const own = receipts?.find(r => r.transactionHash.toLowerCase() === hash.toLowerCase());
  if (!receipts || !own) return skip("its block's receipts could not be read");
  const others = receipts.filter(r => r !== own);
  const touched = others.some(r => r.to?.toLowerCase() === safe || r.from.toLowerCase() === safe || r.logs.some(l => l.address.toLowerCase() === safe));
  const index = receipts.indexOf(own);
  if (receipts.slice(0, index).some(r => r.to?.toLowerCase() === safe || r.logs.some(l => l.address.toLowerCase() === safe))) return skip('the Safe was used earlier in the same block');
  let nonce: bigint, safeTxHash: Hex, version: string;
  try {
    nonce = BigInt(String(await atParent.call(CHAIN, 'eth_call', [{ to: safe, data: encodeFunctionData({ abi: SAFE, functionName: 'nonce' }) }, 'latest'])));
    safeTxHash = String(await atParent.call(CHAIN, 'eth_call', [{ to: safe, data: encodeFunctionData({ abi: SAFE, functionName: 'getTransactionHash', args: [to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, nonce] }) }, 'latest'])) as Hex;
    const v = String(await atParent.call(CHAIN, 'eth_call', [{ to: safe, data: encodeFunctionData({ abi: SAFE, functionName: 'VERSION' }) }, 'latest'])).slice(2);
    version = Buffer.from(v.slice(128, 128 + parseInt(v.slice(64, 128), 16) * 2), 'hex').toString();
  } catch { return skip('a read of the Safe failed'); }
  // The receipt: what the Safe logged of its own transaction (a reverted one logs nothing).
  const logged = own.logs.filter(l => l.address.toLowerCase() === safe);
  const actual: Row['actual'] = where.receipt.status === 'reverted' ? 'reverted' : logged.some(l => l.topics[0] === EXECUTION_FAILURE) ? 'failure' : 'success';
  // The signing owner: the sender where it is one (most are sent by an owner, whose own approval is its being the
  // sender), else an owner the signatures recover to.
  const sender = tx.from.toLowerCase(), recovered = await signersOf(signatures, safeTxHash);
  const signer = before.owners.includes(sender) ? sender : recovered.find(o => before.owners.includes(o)) ?? before.owners[0];
  const as: Row['signer'] = signer === sender ? 'the sender' : recovered.includes(signer) ? 'a signer of it' : "the Safe's first owner";
  // Before 1.3.0 the domain has no chain ID, and 1.0.0 calls baseGas dataGas.
  const old = /^(0|1\.[0-2])\./.test(version);
  const typed = {
    domain: { ...(!old && { chainId: CHAIN }), verifyingContract: safe },
    types: {
      EIP712Domain: [...(old ? [] : [{ name: 'chainId', type: 'uint256' }]), { name: 'verifyingContract', type: 'address' }],
      SafeTx: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }, { name: 'operation', type: 'uint8' }, { name: 'safeTxGas', type: 'uint256' }, { name: 'baseGas', type: 'uint256' },
        { name: 'gasPrice', type: 'uint256' }, { name: 'gasToken', type: 'address' }, { name: 'refundReceiver', type: 'address' }, { name: 'nonce', type: 'uint256' }],
    },
    primaryType: 'SafeTx',
    message: { to, value: value.toString(), data, operation, safeTxGas: safeTxGas.toString(), baseGas: baseGas.toString(), gasPrice: gasPrice.toString(), gasToken, refundReceiver, nonce: nonce.toString() },
  };
  // Every simulation where the transaction ran, and a priced one at the price it paid (the Safe's refund in the
  // native coin is paid at the lower of its gasPrice and the transaction's). execTransaction's own results are kept:
  // the preview shows the last of them that ran (src/safe-sim.ts), and doesn't report its gas.
  // And execTransaction as the mined one was sent, in what a signature doesn't say: with the coin it carried (a
  // transaction can send the Safe what its call then spends: one on Ethereum sent 0.537 ETH with a call that wraps
  // and lends them, which fails on the Safe's own balance) and on its gas limit, with room for the stand-ins' cost
  // (a call that names none gets what the node has left, and on BNB Chain's node an equal share of it with every
  // other call that names none: six previews there failed the Safe's own check of its gas, GS010).
  const at = { ...where.at, before: where.before };
  const isExec = (q: SimulationRequest) => q.to?.toLowerCase() === safe && !!q.data?.startsWith(EXEC);
  // (Coin the SafeTx itself names is the preview's to find: a call that fails on the Safe's own balance runs again
  // with it sent along, src/safe-sim.ts. Only coin the signature doesn't name is put in here.)
  // And only a plain call's, where the Safe holds less than it spends: a Safe that could pay by itself was still
  // sent the coin, which its balance across the block has, and a delegatecall's code may leave it unspent.
  const carried = BigInt(tx.value);
  const held = carried === value && operation === 0 ? await call<string>('eth_getBalance', [safe, parent]).then(b => BigInt(b), () => undefined) : undefined;
  const sent = held !== undefined && held < value ? 0n : carried;
  const placed = (q: SimulationRequest): SimulationRequest => ({ ...q, at: q.at ?? at, ...(q.gasPrice !== undefined && { gasPrice: where.gasPrice }),
    ...(isExec(q) && { gas: q.gas ?? BigInt(tx.gas) + STAND_IN_ROOM, ...(sent > 0n && { value: sent, stateOverrides: { ...q.stateOverrides, [q.from.toLowerCase()]: { ...q.stateOverrides?.[q.from.toLowerCase()], balance: hex(sent * 2n + 10n ** 18n) } } }) }) });
  const runs: SimulationResult[] = [];
  const keep = (qs: SimulationRequest[], rs: (SimulationResult | null)[] | null) => { if (qs[0] && isExec(qs[0]) && rs?.[0]) runs.push(rs[0]); return rs; };
  const simulator = {
    simulate: (q: SimulationRequest) => base.simulator!.simulate(placed(q)),
    simulateBatch: async (qs: SimulationRequest[]) => keep(qs, await base.simulator!.simulateBatch!(qs.map(placed))) as SimulationResult[] | null,
  };
  let p: Preview;
  try { p = await previewRequest({ method: 'eth_signTypedData_v4', params: [signer, JSON.stringify(typed)] }, { chainId: CHAIN, now: where.when.time * 1000 }, { ...base, rpc: atParent, simulator }); } catch (e) { return skip(`error: ${(e as Error).message.slice(0, 80)}`); }
  if (DUMP) writeFileSync(DUMP, JSON.stringify(p, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 1));
  if (p.decoding.decoder !== 'safe_tx') return skip(`previewed by ${p.decoding.decoder}`);
  const fails = p.warnings.find(w => w.code === 'safe_tx_reverts');
  const ranWhole = p.decoding.notes.some(n => n.startsWith('Simulated as the Safe runs it'));
  const preview: Row['preview'] = fails ? 'fails' : ranWhole ? 'success' : 'not simulated';
  const how = fails ? fails.message : ranWhole ? undefined : p.decoding.notes.find(n => /^Simulated|simulat/i.test(n))?.slice(0, 160) ?? 'no simulation';
  const differs: string[] = [];
  if (actual !== 'reverted' && preview !== 'not simulated' && (actual === 'success') !== (preview === 'success')) differs.push('outcome');
  // The Safe's tokens, where both ran the call (the preview of a call that fails shows what it asks for).
  const tokens: Row['tokens'] = actual === 'success' && preview === 'success' ? await compareTokens(own.logs, safe, p.assetChanges ?? [], tokenLike) : [];
  const abs = (x: bigint) => (x < 0n ? -x : x);
  // A token whose logs say another amount than the preview is held to the Safe's balance across the block (an
  // aToken's logs carry its interest: scripts/userop-tokens.ts, heldToBalance).
  await heldToBalance(tokens, safe, others, async (token, when) => BigInt(String(await call('eth_call', [{ to: token, data: `0x70a08231${safe.slice(2).padStart(64, '0')}` }, when === 'before' ? parent : hex(number)]))));
  if (tokens.some(differsIn)) differs.push('tokens');
  // Its native coin: its balance across the block, where nothing else in the block touched the Safe (a Safe logs
  // what it receives, and sends only by a transaction or a module's, which it logs too).
  let native: Row['native'];
  if (actual === 'success' && preview === 'success' && !touched) {
    try {
      const [b0, b1] = await Promise.all([parent, hex(number)].map(async b => BigInt(String(await call('eth_getBalance', [safe, b])))));
      const simulated = (p.assetChanges ?? []).filter(c => c.asset === 'native' && c.raw && c.basis !== 'requested' && (c.account ?? safe).toLowerCase() === safe).reduce((sum, c) => sum + (c.direction === 'out' ? -1n : 1n) * BigInt(c.raw!), 0n);
      native = { actual: (b1 - b0).toString(), simulated: simulated.toString() };
      // A refund in the native coin is the gas the transaction used at its price: the stand-ins' gas isn't the
      // signatures', so it is within the gas difference at that price (and 1%).
      const run = runs.filter(r => r.status === 'success').at(-1);
      const slack = gasPrice > 0n && /^0x0{40}$/.test(gasToken) ? abs(BigInt(run?.gasUsed ?? 0n) - where.receipt.gasUsed) * (gasPrice < where.gasPrice ? gasPrice : where.gasPrice) + abs(b1 - b0) / 100n : 0n;
      if (abs(b1 - b0 - simulated) > slack) differs.push('native');
    } catch { /* a balance the node no longer has */ }
  }
  const run = runs.filter(r => r.status === 'success').at(-1) ?? runs.at(-1);
  const gas = run?.gasUsed !== undefined && actual !== 'reverted' && preview !== 'not simulated' ? { actual: where.receipt.gasUsed.toString(), simulated: BigInt(run.gasUsed).toString() } : undefined;
  // What the transaction left changed in the Safe, which its events say (configChanged): each has to be warned of.
  const changed = actual === 'success' ? configChanged(logged, before) : [];
  const warned = [...new Set(p.warnings.map(w => CONFIG_WARNINGS[w.code]).filter(Boolean))];
  if (preview === 'success' && changed.some(c => !warned.includes(c))) differs.push('configuration');
  rows.push({ hash, block: number, safe, version: SAFE_SINGLETONS[before.singleton] ?? `${version} (${before.singleton})`, owners: before.owners.length, threshold: Number(before.threshold), signer: as, actual, preview, ...(how && { how }),
    tokens, ...(native && { native }), ...(gas && { gas }), config: { actual: changed, warned }, differs, warnings: p.warnings.filter(w => w.severity !== 'info').map(w => w.code) });
  process.stdout.write(differs.length ? 'X' : preview === 'not simulated' ? '?' : '.');
}

const seen = new Set<string>(), blocks = { read: 0, unread: 0 };
async function blockAt(n: number): Promise<void> {
  const b = await call<{ transactions: { hash: string; to: string | null; input: string }[] } | null>('eth_getBlockByNumber', [hex(n), true]).catch(() => null);
  blocks[b ? 'read' : 'unread']++;
  for (const t of b?.transactions ?? []) {
    if (rows.length >= MAX) return;
    if (!t.to || !t.input.startsWith(EXEC) || seen.has(t.hash)) continue;
    seen.add(t.hash);
    await replay(t.hash).catch(e => skip(`error: ${(e as Error).message.slice(0, 80)}`));
  }
}
if (ONE) await replay(ONE);
else {
  let head = Number(await call<string>('eth_blockNumber', []));
  if (FOLLOW) {
    const until = Date.now() + FOLLOW * 1000;
    let next = head;
    while (Date.now() < until && rows.length < MAX) {
      head = Number(await call<string>('eth_blockNumber', []).catch(() => hex(head)));
      // Where it fell behind, from twenty blocks back: the node's state for older ones is the first to go.
      if (head - next > 20) next = head - 20;
      for (; next <= head && rows.length < MAX; next++) await blockAt(next);
      await new Promise(r => setTimeout(r, 500));
    }
  } else for (let n = head; n > head - BLOCKS && rows.length < MAX; n--) await blockAt(n);
}

const pct = (a: string, b: string) => (100 * (Number(b) - Number(a)) / Number(a));
const judged = rows.filter(r => r.actual !== 'reverted' && r.preview !== 'not simulated');
const gasOff = rows.filter(r => r.gas).map(r => pct(r.gas!.actual, r.gas!.simulated)).sort((a, b) => a - b);
// A run that could not look (the node failing its reads) is not one that found nothing.
const blind = couldNotLook({ ...skipped, 'not simulated': rows.filter(r => r.preview === 'not simulated').length }, judged.length, blocks);
const lines = [
  `${rows.length} Safe transactions on ${chainName(CHAIN)} previewed as the SafeTx an owner signed, where each ran${rows.length ? ` (blocks ${Math.min(...rows.map(r => r.block))}-${Math.max(...rows.map(r => r.block))})` : ''}:`,
  `  outcome: ${judged.filter(r => !r.differs.includes('outcome')).length} of ${judged.length} as the Safe logged it (${judged.filter(r => r.actual === 'failure').length} of them a call that failed)`,
  `  tokens: ${rows.filter(r => r.tokens.length && !r.tokens.some(t => t.unjudged) && !r.differs.includes('tokens')).length} of ${rows.filter(r => r.tokens.length && !r.tokens.some(t => t.unjudged)).length} that moved the Safe's tokens move the receipt's amounts${rows.some(r => r.tokens.some(t => t.balance !== undefined)) ? ` (${rows.filter(r => r.tokens.some(t => t.balance !== undefined)).length} of them by the Safe's balance, where a token's logs carry its interest)` : ''}`,
  ...(rows.some(r => r.tokens.some(t => t.unjudged)) ? [`  tokens not judged: in ${rows.filter(r => r.tokens.some(t => t.unjudged)).length}, a token whose logs say another amount than the preview and whose balance can't say (${[...new Set(rows.flatMap(r => r.tokens.map(t => t.unjudged).filter(Boolean)))].join('; ')})`] : []),
  `  native coin: ${rows.filter(r => r.native && !r.differs.includes('native')).length} of ${rows.filter(r => r.native).length} with the Safe's balance change across the block`,
  `  configuration: ${rows.filter(r => r.config.actual.length && !r.differs.includes('configuration')).length} of ${rows.filter(r => r.config.actual.length).length} that changed the Safe warn of each change`,
  ...(gasOff.length ? [`  gas (not judged: the stand-ins aren't the signatures that ran): median ${gasOff[Math.floor(gasOff.length / 2)].toFixed(2)}%, from ${gasOff[0].toFixed(2)}% to ${gasOff.at(-1)!.toFixed(2)}%`] : []),
  ...(rows.some(r => r.actual === 'reverted') ? [`  not judged: ${rows.filter(r => r.actual === 'reverted').length} whose transaction reverted (the preview: ${rows.filter(r => r.actual === 'reverted' && r.preview === 'fails').length} expected to fail)`] : []),
  ...(rows.some(r => r.preview === 'not simulated') ? [`  not simulated through execTransaction: ${rows.filter(r => r.preview === 'not simulated').length}`] : []),
  `  signed as: ${(['the sender', 'a signer of it', "the Safe's first owner"] as const).map(s => `${rows.filter(r => r.signer === s).length} ${s}`).join(', ')}`,
  ...Object.entries(skipped).map(([why, n]) => `  skipped: ${n} ${why}`),
  ...(blind ? [`  NOT LOOKED AT: ${blind}`] : []),
  ...rows.filter(r => r.differs.length).map(r => `  DIFFERS ${r.hash} (${r.version}, ${r.threshold} of ${r.owners}): ${r.differs.join(', ')}${r.differs.includes('outcome') ? ` (receipt ${r.actual}, preview ${r.preview}${r.how ? `: ${r.how}` : ''})` : ''}`),
];
console.log(`\n${lines.join('\n')}`);
if (OUT) writeFileSync(OUT, JSON.stringify({ chainId: CHAIN, generatedAt: new Date().toISOString(), rows, skipped }, null, 1));
if (SUMMARY) appendFileSync(SUMMARY, `### Safe transactions, ${chainName(CHAIN)}\n\n\`\`\`\n${lines.join('\n')}\n\`\`\`\n\n`);
if (STRICT && (blind || rows.some(r => r.differs.length))) process.exit(1);
