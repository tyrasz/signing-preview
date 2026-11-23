// npm run accuracy:batch -- [--chain 1|42161|8453|10|137|56|11155111] [--blocks 100 | --follow 600 | --tx 0x…] [--max 40]
//   [--out report.json] [--summary-md summary.md] [--strict] [--dump preview.json]
//
// How well the preview of a batch (wallet_sendCalls, EIP-5792: src/preview.ts, previewBatch) says what the batch
// goes on to do. A wallet asked to send calls for a smart account puts them on the chain as one call to the account,
// whose own code runs them: recent such calls to accounts running delegated code (EIP-7702) are read back into
// their calls (ERC-7579 / ERC-7821 execute, executeBatch: src/evm/smart-account.ts, batchCalls) and previewed as
// the request the wallet was given, from the account, on the state the transaction met: its parent block, its
// block's header and the block's earlier transactions (as a mined transaction is replayed: src/replay.ts).
// The preview runs the calls one after another from the account, as it does for any wallet; the chain ran them
// inside one call, by the account's code, sent by the account or by a relayer.
// Compared with the receipt:
//   - the outcome: a batch whose transaction succeeded, against a preview with no call expected to fail (a batch in
//     "try" mode, whose calls may fail one by one, and a transaction that reverted aren't judged);
//   - the account's token movements (a token whose logs carry its interest is held to the account's balance);
//   - its native coin, reported and not judged: an account's balance can move without a log.
// Gas isn't compared: the calls run apart here and together there.
// Public nodes keep recent state only (Ethereum about 128 blocks, OP Mainnet and Polygon about two minutes, Arbitrum
// about 30 seconds): --blocks takes the latest blocks, newest first; --follow watches for new ones.
import { appendFileSync, writeFileSync } from 'node:fs';
import type { Hex } from 'viem';
import { previewRequest } from '../src/preview.ts';
import { liveDependencies } from '../src/server.ts';
import { JsonRpcClient } from '../src/rpc.ts';
import { replayContext, ReplayError } from '../src/replay.ts';
import { batchCalls } from '../src/evm/smart-account.ts';
import { chainName, EVM_RPCS, rpcUrlFor } from '../src/chains.ts';
import type { Preview, SimulationRequest } from '../src/types.ts';
import { compareTokens, differsIn, heldToBalance, type Compared } from './userop-tokens.ts';

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const CHAIN = Number(arg('chain', '1')), BLOCKS = Number(arg('blocks', '100')), FOLLOW = Number(arg('follow', '0')), MAX = Number(arg('max', '40'));
const ONE = arg('tx', ''), OUT = arg('out', ''), SUMMARY = arg('summary-md', ''), DUMP = arg('dump', ''), STRICT = process.argv.includes('--strict');
const URL_ = rpcUrlFor(CHAIN, process.env);
if (!URL_ || !EVM_RPCS[CHAIN]) { console.error(`no RPC for chain ${CHAIN}`); process.exit(2); }
const rpc = new JsonRpcClient({ [CHAIN]: URL_ }, { retries: 6, retryDelayMs: 400 });
const call = <T>(method: string, params: unknown[]) => rpc.call(CHAIN, method, params) as Promise<T>;
const hex = (v: bigint | number) => `0x${v.toString(16)}`;
/**
 * The selectors batchCalls reads: execute(bytes32,bytes), executeBatch((address,uint256,bytes)[]),
 * execute(address,uint256,bytes), executeBatch(address[],bytes[]), executeBatch(address[],uint256[],bytes[]); and
 * WalletCore's executeFromSelf, executeWithValidator, initializeExecuteWithValidator and executeFromExecutor.
 */
const SELECTORS = new Set(['0xe9ae5c53', '0x34fcd5be', '0xb61d27f6', '0x18dfb3c7', '0x47e1da2a', '0x893aa9f6', '0xfcfbd33a', '0x32fba9bb', '0x4da6d8e5']);

interface Row {
  hash: string; block: number; account: string;
  /** The code the account runs (its EIP-7702 delegate), the batch's format and how many calls it holds. */
  delegate: string; format: string; calls: number;
  /** Sent by the account itself, or by another (a relayer: the account's code checks a signature the batch carries). */
  sentBy: 'the account' | 'a relayer';
  actual: 'success' | 'reverted';
  preview: 'success' | 'fails' | 'not simulated';
  how?: string;
  tokens: (Compared & { balance?: string; unjudged?: string })[];
  native?: { actual: string; simulated: string };
  differs: string[];
  /** Why the batch isn't judged though it was previewed (a try-mode batch, a reverted transaction). */
  unjudged?: string;
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
type Receipt = { transactionHash: string; from: string; to: string | null; gasUsed: Hex; effectiveGasPrice?: Hex; l1Fee?: Hex; logs: { address: string; topics: Hex[]; data: Hex }[] };
const RECEIPTS = new Map<string, Promise<Receipt[]>>();
const blockReceipts = (block: string) => { let r = RECEIPTS.get(block); if (!r) { RECEIPTS.clear(); RECEIPTS.set(block, r = call<Receipt[]>('eth_getBlockReceipts', [block])); } return r; };

async function replay(hash: string): Promise<void> {
  const base = liveDependencies({ [EVM_RPCS[CHAIN].env]: URL_, SIGNING_PREVIEW_FORK_CACHE: 'off' }, { warmUp: false });
  let found: Awaited<ReturnType<typeof replayContext>>;
  try { found = await replayContext({ chainId: CHAIN, hash }, base); } catch (e) { return skip(e instanceof ReplayError ? `not replayable (${e.code})` : `error: ${(e as Error).message.slice(0, 80)}`); }
  const { tx, replay: where } = found;
  const account = tx.to!.toLowerCase(), parent = where.at.block, number = Number(where.info.block);
  const batch = batchCalls(tx.input);
  if (!batch?.calls.length) return skip("calldata that isn't a batch's");
  if (batch.delegatecall) return skip('a delegatecall, which a wallet_sendCalls request has no call for');
  if (batch.calls.length > 32) return skip('more than 32 calls, which a wallet_sendCalls request may not hold');
  // An account running delegated code (EIP-7702): at its parent block, or from this transaction's own authorization
  // where it calls itself (only an account with code runs a call to itself).
  let code: string;
  try { code = String(await call('eth_getCode', [account, parent])).toLowerCase(); } catch { return skip('its state is no longer served by the node'); }
  const self = tx.from.toLowerCase() === account;
  if (!code.startsWith('0xef0100') && !(self && tx.authorizationList?.length)) return skip('not an account running delegated code (a contract account: its batches are UserOperations, or its own format)');
  const delegate = code.startsWith('0xef0100') ? `0x${code.slice(8)}` : 'set in the transaction';
  const receipts = await blockReceipts(hex(number)).catch(() => undefined);
  const own = receipts?.find(r => r.transactionHash.toLowerCase() === hash.toLowerCase());
  if (!receipts || !own) return skip("its block's receipts could not be read");
  const others = receipts.filter(r => r !== own);
  // The account earlier in its own block: its state then isn't the parent block's, which the preview's reads are of.
  if (receipts.slice(0, receipts.indexOf(own)).some(r => r.to?.toLowerCase() === account || r.from.toLowerCase() === account)) return skip('the account was used earlier in the same block');
  // Reads on the parent block, and the block itself for its header.
  const atParent = { has: (c: number) => c === CHAIN, call: (c: number, m: string, ps: unknown[]) => m === 'eth_getBlockByNumber' && ps[0] === 'latest' ? rpc.call(c, m, [hex(number), ps[1]]) : rpc.call(c, m, ps.map(x => x === 'latest' ? parent : x)) };
  // Every simulation where the transaction ran, a priced one at the price it paid.
  const at = { ...where.at, before: where.before };
  // And with the coin a relayer's transaction carried to the account, which its calls then spend: a request doesn't
  // say that (three executions through UniversalGaslessDelegate, on Arbitrum One and Sepolia, were previewed as
  // sending coin the account didn't have).
  const carried = self ? 0n : BigInt(tx.value);
  let funded: string | undefined;
  if (carried > 0n) try { funded = hex(BigInt(await call<string>('eth_getBalance', [account, parent])) + carried); } catch { return skip('its state is no longer served by the node'); }
  // Each call on the gas limit the transaction had for them all: a call that names none gets what the node has left,
  // and on BNB Chain's node an equal share of it with every other call of the simulated block that names none (a
  // batch's second call there ran out on 140,352 gas).
  const placed = (q: SimulationRequest): SimulationRequest => ({ ...q, at: q.at ?? at, ...(q.gasPrice !== undefined && { gasPrice: where.gasPrice }),
    ...(q.from.toLowerCase() === account && { gas: q.gas ?? BigInt(tx.gas) }),
    ...(funded && { stateOverrides: { ...q.stateOverrides, [account]: { ...q.stateOverrides?.[account], balance: funded } } }) });
  const simulator = { simulate: (q: SimulationRequest) => base.simulator!.simulate(placed(q)), simulateBatch: (qs: SimulationRequest[]) => base.simulator!.simulateBatch!(qs.map(placed)) };
  const request = { method: 'wallet_sendCalls', params: [{ version: '2.0.0', chainId: hex(CHAIN), from: account, atomicRequired: !batch.tryMode,
    calls: batch.calls.map(c => ({ to: c.target, data: c.data, value: hex(c.value) })) }] };
  let p: Preview;
  try { p = await previewRequest(request as never, { chainId: CHAIN, account, now: where.when.time * 1000 }, { ...base, rpc: atParent, simulator }); } catch (e) { return skip(`error: ${(e as Error).message.slice(0, 80)}`); }
  if (DUMP) writeFileSync(DUMP, JSON.stringify(p, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 1));
  // The batch's own simulation, or its one call's.
  const sim = p.simulation ?? p.calls?.[0]?.simulation;
  const preview: Row['preview'] = sim?.status === 'success' ? 'success' : sim?.status === 'reverted' ? 'fails' : 'not simulated';
  const how = preview === 'fails' ? sim!.revertReason ?? 'reverted' : preview === 'not simulated' ? sim?.error ?? p.warnings.find(w => /simulation/.test(w.code))?.message.slice(0, 160) ?? 'no simulation' : undefined;
  const actual: Row['actual'] = where.receipt.status;
  const unjudged = actual === 'reverted' ? 'the transaction reverted (on its signature or its gas, perhaps: a request has neither)' : batch.tryMode ? 'a batch in "try" mode: its calls may fail one by one' : undefined;
  const differs: string[] = [];
  if (!unjudged && preview === 'fails') differs.push('outcome');
  const tokens: Row['tokens'] = actual === 'success' && preview === 'success' && !batch.tryMode ? await compareTokens(own.logs, account, p.assetChanges ?? [], tokenLike) : [];
  await heldToBalance(tokens, account, others, async (token, when) => BigInt(String(await call('eth_call', [{ to: token, data: `0x70a08231${account.slice(2).padStart(64, '0')}` }, when === 'before' ? parent : hex(number)]))));
  if (tokens.some(differsIn)) differs.push('tokens');
  // Its native coin across the block, with the fee it paid where it sent the transaction itself: reported.
  let native: Row['native'];
  if (actual === 'success' && preview === 'success' && !batch.tryMode && !others.some(r => r.to?.toLowerCase() === account || r.from.toLowerCase() === account)) {
    try {
      const [b0, b1] = await Promise.all([parent, hex(number)].map(async b => BigInt(String(await call('eth_getBalance', [account, b])))));
      const fee = self ? BigInt(own.gasUsed) * BigInt(own.effectiveGasPrice ?? 0) + BigInt(own.l1Fee ?? 0) : 0n;
      const simulated = (p.assetChanges ?? []).filter(c => c.asset === 'native' && c.raw && c.basis !== 'requested' && (c.account ?? account).toLowerCase() === account).reduce((sum, c) => sum + (c.direction === 'out' ? -1n : 1n) * BigInt(c.raw!), 0n);
      native = { actual: (b1 - b0 + fee - carried).toString(), simulated: simulated.toString() };
    } catch { /* a balance the node no longer has */ }
  }
  rows.push({ hash, block: number, account, delegate, format: batch.standard, calls: batch.calls.length, sentBy: self ? 'the account' : 'a relayer', actual, preview, ...(how && { how }), tokens, ...(native && { native }), differs, ...(unjudged && { unjudged }),
    warnings: p.warnings.filter(w => w.severity !== 'info').map(w => w.code) });
  process.stdout.write(differs.length ? 'X' : preview === 'not simulated' ? '?' : '.');
}

const seen = new Set<string>();
async function blockAt(n: number): Promise<void> {
  const b = await call<{ transactions: { hash: string; to: string | null; input: string }[] } | null>('eth_getBlockByNumber', [hex(n), true]).catch(() => null);
  for (const t of b?.transactions ?? []) {
    if (rows.length >= MAX) return;
    if (!t.to || !SELECTORS.has(t.input.slice(0, 10)) || seen.has(t.hash)) continue;
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

const judged = rows.filter(r => !r.unjudged && r.preview !== 'not simulated');
const nativeOf = rows.filter(r => r.native);
const delegates = [...new Set(rows.map(r => r.delegate))];
const lines = [
  `${rows.length} batches on ${chainName(CHAIN)} previewed as the calls their wallets were asked to send, where each ran${rows.length ? ` (blocks ${Math.min(...rows.map(r => r.block))}-${Math.max(...rows.map(r => r.block))})` : ''}:`,
  `  outcome: ${judged.filter(r => !r.differs.includes('outcome')).length} of ${judged.length} that went through previewed with no call failing`,
  `  tokens: ${rows.filter(r => r.tokens.length && !r.differs.includes('tokens')).length} of ${rows.filter(r => r.tokens.length).length} that moved the account's tokens move the receipt's amounts${rows.some(r => r.tokens.some(t => t.balance !== undefined)) ? ` (${rows.filter(r => r.tokens.some(t => t.balance !== undefined)).length} of them by the account's balance, where a token's logs carry its interest)` : ''}`,
  ...(rows.some(r => r.tokens.some(t => t.unjudged)) ? [`  tokens not judged: in ${rows.filter(r => r.tokens.some(t => t.unjudged)).length}, a token whose logs say another amount than the preview and whose balance can't say (${[...new Set(rows.flatMap(r => r.tokens.map(t => t.unjudged).filter(Boolean)))].join('; ')})`] : []),
  `  native coin (reported, not judged): ${nativeOf.filter(r => r.native!.actual === r.native!.simulated).length} of ${nativeOf.length} with the account's balance change across the block`,
  ...(rows.some(r => r.unjudged) ? [`  not judged: ${rows.filter(r => r.actual === 'reverted').length} whose transaction reverted (the preview: ${rows.filter(r => r.actual === 'reverted' && r.preview === 'fails').length} with a call expected to fail), ${rows.filter(r => r.actual !== 'reverted' && r.unjudged).length} in "try" mode`] : []),
  ...(rows.some(r => r.preview === 'not simulated') ? [`  not simulated: ${rows.filter(r => r.preview === 'not simulated').length}`] : []),
  `  ${rows.filter(r => r.calls > 1).length} of several calls, ${rows.filter(r => r.calls === 1).length} of one; ${rows.filter(r => r.sentBy === 'the account').length} sent by the account, ${rows.filter(r => r.sentBy === 'a relayer').length} by a relayer; ${delegates.length} kind${delegates.length === 1 ? '' : 's'} of account code`,
  ...Object.entries(skipped).map(([why, n]) => `  skipped: ${n} ${why}`),
  ...rows.filter(r => r.differs.length).map(r => `  DIFFERS ${r.hash} (${r.calls} call${r.calls === 1 ? '' : 's'}, ${r.format}, code ${r.delegate}): ${r.differs.join(', ')}${r.differs.includes('outcome') ? ` (the preview: ${r.how})` : ''}`),
];
console.log(`\n${lines.join('\n')}`);
if (OUT) writeFileSync(OUT, JSON.stringify({ chainId: CHAIN, generatedAt: new Date().toISOString(), rows, skipped }, null, 1));
if (SUMMARY) appendFileSync(SUMMARY, `### Batches, ${chainName(CHAIN)}\n\n\`\`\`\n${lines.join('\n')}\n\`\`\`\n\n`);
if (STRICT && rows.some(r => r.differs.length)) process.exit(1);
