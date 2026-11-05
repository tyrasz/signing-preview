// npm run accuracy -- [--chain 1|42161] [--blocks 30] [--per-block 3] [--max-index 8] [--only-type 0x4] [--unsigned-7702] [--simulators eth_simulateV1,fork] [--out report.json]
//
// How accurate simulation is, measured against what actually happened. Recent Ethereum transactions from one-off
// senders are replayed at their exact pre-state: on top of the parent block, after the earlier transactions of their
// own block, with the real block's header. Each goes through both simulators the previewer uses:
//   - RpcSimulator: eth_simulateV1, with balances and approvals read back from state;
//   - ForkSimulator: a local EVM over the chain's state (what HyperEVM, which has no eth_simulateV1, uses).
// and is compared with the receipt: outcome, every token movement of the sender, the native coin change (balance
// before and after the block, net of the fee), approvals by the sender, and gas. Any difference is listed.
// Public RPCs keep only recent state (Ethereum about 128 blocks, ~25 minutes; Arbitrum about 30 seconds), so only
// the latest blocks can be replayed. On Arbitrum, ArbOS's own transactions are skipped and gas is compared without
// the L1 data part of the receipt (gasUsedForL1); the fork simulator doesn't model ArbOS, so it runs on Ethereum only.
// --unsigned-7702 replays the sender's own EIP-7702 authorizations as if the wallet had yet to sign them (code
// overrides and the request's unsignedAuthorizations), which is how a preview before signing sees them.
import { writeFileSync } from 'node:fs';
import { ForkSimulator } from '../src/fork-simulator.ts';
import { parseLogs, RpcSimulator } from '../src/simulation.ts';
import { JsonRpcClient } from '../src/rpc.ts';
import type { SimulationRequest, SimulationResult, Simulator } from '../src/types.ts';
import { recoverAuthorizationAddress } from 'viem/utils';

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const CHAIN = Number(arg('chain', '1'));
const URL_ = CHAIN === 42161 ? process.env.ARBITRUM_RPC_URL ?? 'https://arb1.arbitrum.io/rpc' : process.env.ETHEREUM_RPC_URL ?? 'https://ethereum-rpc.publicnode.com';
const SYSTEM = CHAIN === 42161 ? new Set(['0x64', '0x65', '0x66', '0x68', '0x69', '0x6a']) : new Set<string>();
const BLOCKS = Number(arg('blocks', '30')), PER_BLOCK = Number(arg('per-block', '3')), MAX_INDEX = Number(arg('max-index', '8'));
const UNSIGNED = process.argv.includes('--unsigned-7702');
const ONLY_TYPE = arg('only-type', ''), SIMULATORS = arg('simulators', 'eth_simulateV1,fork').split(',');
const rpc = new JsonRpcClient({ [CHAIN]: URL_ }, { timeoutMs: 20_000, retries: CHAIN === 42161 ? 8 : 4, retryDelayMs: CHAIN === 42161 ? 1000 : 400 });
type Hex = `0x${string}`;
type Auth = { address: Hex; chainId: Hex; nonce: Hex; r: Hex; s: Hex; yParity: Hex };
type T = { hash: string; from: string; to: string | null; input: Hex; value: string; transactionIndex: string; type: string; gas: string; gasPrice: string; accessList?: { address: string; storageKeys: string[] }[]; authorizationList?: Auth[] };
type B = { number: Hex; timestamp: Hex; miner: string; mixHash: Hex; gasLimit: Hex; baseFeePerGas: Hex; transactions: T[] };
type R = { transactionHash: string; status: string; gasUsed: string; gasUsedForL1?: string; effectiveGasPrice: string; logs: { address: string; topics: string[]; data: string }[] };

const head = Number(await rpc.call(CHAIN, 'eth_blockNumber', []));
const blocks: B[] = [];
for (let i = 0; i < BLOCKS; i++) blocks.push(await rpc.call(CHAIN, 'eth_getBlockByNumber', ['0x' + (head - 1 - i).toString(16), true]) as B);
const txsBySender = new Map<string, number>();
for (const b of blocks) for (const t of b.transactions) txsBySender.set(t.from.toLowerCase(), (txsBySender.get(t.from.toLowerCase()) ?? 0) + 1);
/**
 * EIP-7702 authorizations as code overrides, the way the previewer applies them: each one that is valid (this chain
 * or every chain, a readable signature, and the authority's nonce, counting the transaction's own when the authority
 * sends it) sets the authority's code to the delegation designator.
 */
async function delegations(t: T, tag: string): Promise<Record<string, { code: string }> | undefined> {
  if (!t.authorizationList?.length) return undefined;
  const out: Record<string, { code: string }> = {};
  for (const a of t.authorizationList) {
    if (![0, CHAIN].includes(Number(a.chainId))) continue;
    let authority: string;
    try { authority = (await recoverAuthorizationAddress({ authorization: { address: a.address, chainId: Number(a.chainId), nonce: Number(a.nonce) }, signature: { r: a.r, s: a.s, yParity: Number(a.yParity) } })).toLowerCase(); } catch { continue; }
    const nonce = BigInt(String(await rpc.call(CHAIN, 'eth_getTransactionCount', [authority, tag]))) + (authority === t.from.toLowerCase() ? 1n : 0n);
    if (BigInt(a.nonce) !== nonce) continue;
    out[authority] = { code: /^0x0{40}$/.test(a.address) ? '0x' : `0xef0100${a.address.slice(2).toLowerCase()}` };
  }
  return Object.keys(out).length ? out : undefined;
}
const authorityOf = async (a: Auth) => { try { return (await recoverAuthorizationAddress({ authorization: { address: a.address, chainId: Number(a.chainId), nonce: Number(a.nonce) }, signature: { r: a.r, s: a.s, yParity: Number(a.yParity) } })).toLowerCase(); } catch { return null; } };
/** Whether every authorization of the transaction is the sender's own (what a wallet would sign for its account). */
const selfSigned = async (t: T) => !!t.authorizationList?.length && (await Promise.all(t.authorizationList.map(authorityOf))).every(a => a === t.from.toLowerCase());
const reqOf = async (t: T, tag: string, unsigned = false): Promise<SimulationRequest> => {
  const stateOverrides = await delegations(t, tag);
  const auths = unsigned ? { unsignedAuthorizations: t.authorizationList!.map(a => ({ address: a.address.toLowerCase(), chainId: Number(a.chainId) })) }
    : t.authorizationList?.length ? { authorizationList: t.authorizationList } : {};
  return { chainId: CHAIN, from: t.from.toLowerCase(), to: t.to, data: t.input, value: BigInt(t.value), gas: BigInt(t.gas), gasPrice: BigInt(t.gasPrice), accessList: t.accessList, ...(stateOverrides && { stateOverrides }), ...auths };
};
const net = (transfers: { asset: string; from: string; to: string; raw: bigint }[], who: string) => {
  const m = new Map<string, bigint>();
  for (const x of transfers) { if (x.from === who) m.set(x.asset, (m.get(x.asset) ?? 0n) - x.raw); if (x.to === who) m.set(x.asset, (m.get(x.asset) ?? 0n) + x.raw); }
  return new Map([...m].filter(([, v]) => v !== 0n));
};

const rows: Record<string, unknown>[] = [];
for (const b of blocks) {
  const n = Number(b.number), parent = '0x' + (n - 1).toString(16);
  const receipts = await rpc.call(CHAIN, 'eth_getBlockReceipts', [b.number]) as R[];
  const simulators = ([
    ['eth_simulateV1', new RpcSimulator({ [CHAIN]: URL_ }, { replay: () => ({ block: parent, blockOverrides: { number: b.number, time: b.timestamp, feeRecipient: b.miner, prevRandao: b.mixHash, baseFeePerGas: b.baseFeePerGas, gasLimit: b.gasLimit } }) })],
    ['fork', new ForkSimulator({ [CHAIN]: URL_ }, { block: () => parent, header: () => ({ number: BigInt(n), timestamp: BigInt(b.timestamp), coinbase: b.miner, prevRandao: b.mixHash, gasLimit: BigInt(b.gasLimit), baseFeePerGas: BigInt(b.baseFeePerGas) }), timeoutMs: 120_000 })],
  ] as [string, Simulator][]).filter(([name]) => SIMULATORS.includes(name) && !(CHAIN === 42161 && name === 'fork'));
  let taken = 0;
  for (const t of b.transactions) {
    const from = t.from.toLowerCase(), index = Number(t.transactionIndex);
    if (taken >= PER_BLOCK || !t.to || index > MAX_INDEX || txsBySender.get(from)! > 1 || t.type === '0x3' || SYSTEM.has(t.type) || (ONLY_TYPE && t.type !== ONLY_TYPE)) continue;
    // Senders without code (EOAs; for type-4 transactions the code can be a delegation, which is what they set).
    const code = String(await rpc.call(CHAIN, 'eth_getCode', [from, parent]));
    if (code !== '0x' && !code.startsWith('0xef0100')) continue;
    taken++;
    const r = receipts.find(x => x.transactionHash === t.hash)!;
    const logs = parseLogs(r.logs);
    const logged = net(logs.transfers, from);
    // What actually moved: the sender's balance of each token across the block (it sent nothing else in it), which
    // for share-based tokens can differ from the Transfer events by a unit; the events where balanceOf can't be read.
    const balanceAt = async (token: string, tag: string) => { try { return BigInt(String(await rpc.call(CHAIN, 'eth_call', [{ to: token, data: `0x70a08231${from.slice(2).padStart(64, '0')}` }, tag]))); } catch { return undefined; } };
    const actual = new Map<string, bigint>();
    const actualOf = async (a: string) => {
      if (!actual.has(a)) { const x = await balanceAt(a, parent), y = await balanceAt(a, b.number); actual.set(a, x !== undefined && y !== undefined ? y - x : (logged.get(a) ?? 0n)); }
      return actual.get(a)!;
    };
    for (const a of logged.keys()) await actualOf(a);
    // Native: the sender's balance across the block, plus the fee it paid (it sent nothing else in this block).
    const bal = async (tag: string) => BigInt(String(await rpc.call(CHAIN, 'eth_getBalance', [from, tag])));
    const nativeActual = (await bal(b.number)) - (await bal(parent)) + BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice);
    const approvals = logs.approvals.filter(a => a.owner === from && !(a.kind === 'erc721' && /^0x0{40}$/.test(a.spender))).map(a => `${a.kind}:${a.token}:${a.spender}`);
    const row: Record<string, unknown> = { hash: t.hash, block: n, index, to: t.to, selector: t.input.slice(0, 10), receipt: r.status === '0x1' ? 'success' : 'reverted', receiptGas: (BigInt(r.gasUsed) - BigInt(r.gasUsedForL1 ?? 0)).toString() };
    const before = await Promise.all(b.transactions.slice(0, index).filter(x => !SYSTEM.has(x.type)).map(x => reqOf(x, parent)));
    const unsigned = UNSIGNED && await selfSigned(t);
    if (UNSIGNED && !unsigned) { taken--; continue; }
    const target = await reqOf(t, parent, unsigned);
    row.type = t.type;
    for (const [name, sim] of simulators) {
      const t0 = Date.now();
      try {
        const out = (await sim.simulateBatch!([...before, target]))!;
        const res: SimulationResult = out[out.length - 1];
        const got = net(res.transfers, from);
        const nativeGot = got.get('native') ?? 0n;
        got.delete('native');
        // Tokens either side saw (a wrap's WETH has no Transfer event, so only the simulation names it).
        const tokenRows = [];
        for (const a of new Set([...logged.keys(), ...got.keys()])) {
          const want = await actualOf(a);
          if (want !== 0n || got.has(a)) tokenRows.push({ token: a, actual: want.toString(), simulated: (got.get(a) ?? 0n).toString() });
        }
        row[name] = {
          outcome: res.status === row.receipt, status: res.status, revert: res.revertReason,
          tokens: tokenRows.filter(x => x.actual === x.simulated).length, tokenTotal: tokenRows.length, tokenDiffs: tokenRows.filter(x => x.actual !== x.simulated),
          native: nativeGot === (res.status === 'success' ? nativeActual : 0n) || (res.status !== 'success' && row.receipt !== 'success'), nativeActual: nativeActual.toString(), nativeSimulated: nativeGot.toString(),
          approvals: approvals.filter(a => (res.approvals ?? []).some(x => `${x.kind}:${x.token}:${x.spender}` === a)).length, approvalTotal: approvals.length,
          gas: String(res.gasUsed) === row.receiptGas, gasUsed: String(res.gasUsed), ms: Date.now() - t0,
        };
      } catch (e) {
        row[name] = { error: (e as Error).message.slice(0, 160), ms: Date.now() - t0 };
      }
    }
    rows.push(row);
  }
}

const out = arg('out', '');
if (out) writeFileSync(out, JSON.stringify(rows, null, 1));
const pct = (a: number, b: number) => b ? `${(100 * a / b).toFixed(1)}%` : '-';
console.log(`${rows.length} ${CHAIN === 42161 ? 'Arbitrum One' : 'Ethereum'} transactions from one-off senders (blocks ${Number(blocks.at(-1)!.number)}-${Number(blocks[0].number)}), replayed at their exact pre-state:`);
for (const name of SIMULATORS) {
  const rs = rows.map(r => r[name] as Record<string, any>), ok = rs.filter(r => !r.error);
  const sum = (k: string) => ok.reduce((s, r) => s + r[k], 0);
  console.log(`  ${name.padEnd(15)} outcome ${pct(ok.filter(r => r.outcome).length, ok.length)} | token movements ${sum('tokens')}/${sum('tokenTotal')} (${pct(sum('tokens'), sum('tokenTotal'))}) | native ${pct(ok.filter(r => r.native).length, ok.length)} | approvals ${sum('approvals')}/${sum('approvalTotal')} | gas exact ${pct(ok.filter(r => r.gas).length, ok.length)} | errors ${rs.length - ok.length} | median ${ok.map(r => r.ms).sort((a, b) => a - b)[ok.length >> 1]} ms`);
  for (const [i, r] of rs.entries()) {
    if (r.error) { console.log(`    error ${rows[i].hash}: ${r.error}`); continue; }
    const issues = [!r.outcome && `outcome ${r.status} (${r.revert}) vs ${rows[i].receipt}`, r.tokenDiffs.length && `tokens ${JSON.stringify(r.tokenDiffs)}`, !r.native && `native ${r.nativeSimulated} vs ${r.nativeActual}`,
      r.approvals < r.approvalTotal && `approvals ${r.approvals}/${r.approvalTotal}`, !r.gas && `gas ${r.gasUsed} vs ${rows[i].receiptGas}`].filter(Boolean);
    if (issues.length) console.log(`    ${rows[i].hash} ${rows[i].selector}: ${issues.join('; ')}`);
  }
}
