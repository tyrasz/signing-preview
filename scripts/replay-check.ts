// npm run replays -- [--chain 1|42161|8453|10|137|56|11155111] [--follow 600 | --blocks 3 | --tx 0x…] [--per-block 8]
//   [--max 200] [--concurrency 2] [--no-trace] [--strict [--tolerate 0]] [--out report.json] [--summary-md summary.md]
//
// Mined transactions put through the previewer's own replay (replayTransaction: what POST /v1/replay serves), each
// with its call trace, and what came out against what happened:
//   - the run against the receipt: the outcome, the events in order, the gas;
//   - the trace, which the local EVM runs, against the node's run: the outcome and events, and the gas where the
//     two are comparable;
//   - where the block carries its access list (EIP-7928, from Amsterdam on: Sepolia), the state the trace changed
//     against the list's entry for the transaction: every storage slot, balance, nonce and code.
// scripts/accuracy.ts measures the two simulators underneath, with machinery of its own (each transaction after its
// block's earlier ones, senders seen once). This goes through the product's path, and takes transactions from all
// through a block, preferring calls it hasn't seen (a contract and function at most three times in a run).
//
// --follow replays each new block as it arrives (public nodes keep recent state only: Arbitrum's about 30 seconds);
// --blocks takes the latest ones; --tx one transaction, printed in full. --strict exits with 1 when a replay doesn't
// match its receipt, or a trace differs from the node's run, its gas or the block's access list; --tolerate N lets
// that many be (a scheduled run on a chain with a known remainder: about one replay in 140 on BNB Chain, whose
// node runs same-second blocks a second late, and Arbitrum's events that carry the transaction's own L1 fee).
// Read-only: nothing is signed or sent.
import { appendFileSync, writeFileSync } from 'node:fs';
import { replayTransaction, ReplayError } from '../src/replay.ts';
import { liveDependencies } from '../src/server.ts';
import { chainName, EVM_RPCS, rpcUrlFor } from '../src/chains.ts';

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const CHAIN = Number(arg('chain', '1')), FOLLOW = Number(arg('follow', '0')), BLOCKS = Number(arg('blocks', '3')), PER_BLOCK = Number(arg('per-block', '8')), MAX = Number(arg('max', '200'));
const CONCURRENCY = Math.max(1, Number(arg('concurrency', '2'))), TRACE = !process.argv.includes('--no-trace'), STRICT = process.argv.includes('--strict');
const ONE = arg('tx', ''), OUT = arg('out', ''), SUMMARY_MD = arg('summary-md', ''), TOLERATE = Number(arg('tolerate', '0'));
const URL_: string = rpcUrlFor(CHAIN, process.env) ?? (() => { throw new Error(`no RPC for chain ${CHAIN}`); })();
// The replays' own lookups stay on the chain's node: no ABI or signature services, no prices.
const deps = liveDependencies({ [EVM_RPCS[CHAIN].env]: URL_, SIGNING_PREVIEW_FORK_CACHE: 'off', SIGNING_PREVIEW_OFFLINE_LOOKUPS: '1', SIGNING_PREVIEW_PRICES: 'off' }, { warmUp: false });
const rpc = deps.rpc!;
const call = async <T>(method: string, params: unknown[]): Promise<T | null> => {
  for (let i = 0; ; i++) {
    try { const out = await rpc.call(CHAIN, method, params) as T | null; if (out !== null || i >= 3) return out; } catch (e) { if (i >= 3) throw e; }
    await new Promise(r => setTimeout(r, 600 * (i + 1)));
  }
};

type Tx = { hash: string; to: string | null; input: string; transactionIndex: string; type: string };
type Row = { hash: string; block: number; index: number; title?: string; ms: number; kind: 'same' | 'receipt' | 'trace' | 'gas' | 'state' | 'untraced' | 'unavailable' | 'own' | 'error'; what?: string; gasCompared?: boolean; stateChecked?: boolean; /** A run shown in place of the node's first, which wasn't the receipt's: the merged same-second run, or the local EVM's. */ shownBy?: 'merged' | 'local' };
const rows: Row[] = [];
const seen = new Map<string, number>();

async function replay(hash: string, block: number): Promise<void> {
  const started = Date.now();
  const row = (kind: Row['kind'], more: Partial<Row> = {}) => { rows.push({ hash, block, index: -1, ms: Date.now() - started, kind, ...more }); process.stdout.write(kind === 'same' ? '.' : kind === 'own' ? '' : `\n  ${kind}: ${hash} ${more.title ? `(${more.title}) ` : ''}${more.what ?? ''}\n`); };
  try {
    const p = await replayTransaction({ chainId: CHAIN, hash }, { trace: TRACE }, deps);
    if (ONE) console.log(JSON.stringify(p, null, 1));
    const notes = p.decoding.notes.join(' ');
    const shownBy = /It was run instead with the \d+ transactions before it in that second/.test(notes) ? 'merged' as const : /local EVM/.test(p.simulation?.source ?? '') ? 'local' as const : undefined;
    const base = { index: p.replay!.index, title: p.title, gasCompared: p.trace?.gasAgrees !== undefined, stateChecked: p.trace?.stateAgrees !== undefined, ...(shownBy && { shownBy }) };
    // A node that didn't hold the replay (state it no longer keeps, its allowance for one simulation) leaves nothing to compare.
    if (p.simulation?.status === 'unavailable') return row('unavailable', { ...base, what: p.simulation.error?.slice(0, 200) });
    if (!p.replay!.matches) return row('receipt', { ...base, what: p.replay!.differences?.join('; ').slice(0, 300) });
    if (!TRACE) return row('same', base);
    if (!p.trace) return row('untraced', { ...base, what: p.decoding.notes.filter(n => /^No trace/.test(n)).join(' ').slice(0, 240) });
    if (p.trace.agrees === false) return row('trace', { ...base, what: p.trace.note?.slice(0, 300) });
    if (p.trace.stateAgrees === false) return row('state', { ...base, what: p.trace.note?.slice(0, 400) });
    if (p.trace.gasAgrees === false) return row('gas', { ...base, what: p.trace.note?.slice(0, 200) });
    row('same', base);
  } catch (e) {
    // The chain's own transactions (deposits, system calls) aren't replayed.
    if (e instanceof ReplayError && e.code === 'UNSUPPORTED') return row('own');
    row(e instanceof ReplayError && e.code === 'UNAVAILABLE' ? 'unavailable' : 'error', { what: (e as Error).message.slice(0, 240) });
  }
}

/** A block's transactions to replay: spread through it, a contract and function at most three times in the run. */
function pick(txs: Tx[]): string[] {
  const out: string[] = [], step = Math.max(1, Math.floor(txs.length / (PER_BLOCK * 3)));
  for (let i = 0; i < txs.length && out.length < PER_BLOCK; i += step) {
    const t = txs[i], key = `${t.to ?? 'creation'}:${t.input.slice(0, 10)}:${t.type}`;
    if ((seen.get(key) ?? 0) >= 3) continue;
    seen.set(key, (seen.get(key) ?? 0) + 1);
    out.push(t.hash);
  }
  return out;
}

async function block(n: number): Promise<void> {
  // A node that is turning requests away (HTTP 429 on a busy public endpoint) costs this block, not the run.
  const b = await call<{ transactions: Tx[] }>('eth_getBlockByNumber', [`0x${n.toString(16)}`, true]).catch(() => null);
  if (!b) return void await new Promise(r => setTimeout(r, 3000));
  const hashes = pick(b?.transactions ?? []).slice(0, Math.max(0, MAX - rows.length));
  for (let i = 0; i < hashes.length; i += CONCURRENCY) await Promise.all(hashes.slice(i, i + CONCURRENCY).map(h => replay(h, n)));
}

const head = Number(await call<string>('eth_blockNumber', []));
if (ONE) await replay(ONE, 0);
else if (FOLLOW) {
  const until = Date.now() + FOLLOW * 1000;
  let next = head;
  while (Date.now() < until && rows.length < MAX) {
    const latest = Number(await call<string>('eth_blockNumber', []).catch(() => null) ?? next - 1);
    // The newest block first, and no further back than a few: its state is the one a node still has.
    if (latest >= next) { next = latest + 1; await block(latest); } else await new Promise(r => setTimeout(r, 1500));
  }
} else for (let n = head - 1; n > head - 1 - BLOCKS && rows.length < MAX; n--) await block(n);

const count = (k: Row['kind']) => rows.filter(r => r.kind === k).length;
const replayed = rows.filter(r => !['own', 'unavailable', 'error'].includes(r.kind)), traced = replayed.filter(r => r.kind !== 'untraced');
const lines = [
  `${replayed.length} ${chainName(CHAIN)} transactions replayed through the previewer${rows.length ? ` (blocks ${Math.min(...rows.map(r => r.block))}-${Math.max(...rows.map(r => r.block))})` : ''}:`,
  `  against their receipts: ${replayed.length - count('receipt')} of ${replayed.length} match${count('receipt') ? `, ${count('receipt')} differ` : ''}`,
  ...(TRACE ? [
    `  traces: ${traced.length} of ${replayed.length} traced; ${traced.length - count('trace') - count('receipt')} agree with the node's run${count('trace') ? `, ${count('trace')} differ` : ''}`,
    `  gas, where the trace's and the node's are comparable: the same in ${rows.filter(r => r.gasCompared && r.kind !== 'gas').length} of ${rows.filter(r => r.gasCompared).length}`,
    ...(rows.some(r => r.stateChecked) ? [`  state changes against the block's access list: the same in ${rows.filter(r => r.stateChecked && r.kind !== 'state').length} of ${rows.filter(r => r.stateChecked).length}`] : []),
  ] : []),
  ...(count('untraced') ? [`  no trace for ${count('untraced')}: ${[...new Set(rows.filter(r => r.kind === 'untraced').map(r => r.what))].slice(0, 3).join(' | ')}`] : []),
  ...(count('unavailable') + count('error') ? [`  not replayed: ${count('unavailable')} the node didn't hold, ${count('error')} failed${count('error') ? ` (${rows.find(r => r.kind === 'error')!.what})` : ''}`] : []),
  ...(rows.some(r => r.shownBy) ? [`  shown by another run than the node's first, which wasn't the receipt's: ${rows.filter(r => r.shownBy === 'merged').length} by the node with the second's blocks merged, ${rows.filter(r => r.shownBy === 'local').length} by the local EVM`] : []),
  ...(count('own') ? [`  left out: ${count('own')} of the chain's own transactions`] : []),
  `  median ${[...replayed.map(r => r.ms)].sort((a, b) => a - b)[replayed.length >> 1] ?? 0} ms a replay`,
];
console.log(`\n${lines.join('\n')}`);
const differing = rows.filter(r => ['receipt', 'trace', 'gas', 'state'].includes(r.kind));
for (const r of differing) console.log(`    ${r.kind} ${r.hash} #${r.index} ${r.title ?? ''}: ${r.what ?? ''}`);
if (OUT) writeFileSync(OUT, JSON.stringify({ chainId: CHAIN, rows }, null, 1));
if (SUMMARY_MD) appendFileSync(SUMMARY_MD, `### Replays on ${chainName(CHAIN)}\n\n${lines.map(l => `- ${l.trim()}`).join('\n')}\n${differing.map(r => `- **${r.kind}** \`${r.hash}\` ${r.title ?? ''}: ${r.what ?? ''}`).join('\n')}\n`);
// The fork cache and lookups may hold timers open.
process.exit(STRICT && differing.length > TOLERATE ? 1 : 0);
