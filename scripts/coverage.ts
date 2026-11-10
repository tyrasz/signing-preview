// npm run coverage -- [--hours 24] [--eth 300] [--arb 1500] [--hyperevm 1500] [--chains 1,42161,999] [--offline] [--out report.json]
//   --chains also takes 8453 (Base, --base 1500), 10 (OP Mainnet, --op 1500), 137 (Polygon, --polygon 1500) and 56
//   (BNB Chain, --bsc 1500).
//
// How much real on-chain traffic the previewer can read. Samples blocks evenly across the last `hours` on Ethereum,
// Arbitrum One and HyperEVM, previews every transaction in them as an eth_sendTransaction request, and reports:
//   - decoding status (full / partial / opaque) and which decoder handled each transaction, per chain
//   - crashes (any exception is a bug)
//   - transaction types (EIP-7702 set-code, blobs, ...)
//   - the contracts and selectors behind the opaque remainder
//   - how much of it comes from automated senders (seen in several of the evenly spaced sampled blocks)
// Pass 1 is offline (built-in decoders, curated tokens, built-in signatures). Pass 2 (unless --offline) looks up the
// opaque remainder online: verified ABIs on Sourcify for the busiest contracts, and function names on OpenChain.
import { writeFileSync } from 'node:fs';
import { previewRequest } from '../src/preview.ts';
import { rpcUrlFor, StaticTokenRegistry } from '../src/chains.ts';
import { JsonRpcClient } from '../src/rpc.ts';
import { ChainedSignatures, ContractAbiResolver, SourcifyAbiSource } from '../src/abi.ts';
import type { AbiResolver, ContractAbi, Dependencies, Preview, SignatureCandidate, SignatureResolver } from '../src/types.ts';

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const HOURS = Number(arg('hours', '24'));
const OFFLINE = process.argv.includes('--offline');
const WANTED = arg('chains', '1,42161,999').split(',').map(Number);
const CHAINS = [
  { id: 1, name: 'Ethereum', blocks: Number(arg('eth', '300')) },
  { id: 42161, name: 'Arbitrum One', blocks: Number(arg('arb', '1500')) },
  { id: 999, name: 'HyperEVM', blocks: Number(arg('hyperevm', '1500')) },
  { id: 8453, name: 'Base', blocks: Number(arg('base', '1500')) },
  { id: 10, name: 'OP Mainnet', blocks: Number(arg('op', '1500')) },
  { id: 137, name: 'Polygon', blocks: Number(arg('polygon', '1500')) },
  { id: 56, name: 'BNB Chain', blocks: Number(arg('bsc', '1500')) },
].filter(c => WANTED.includes(c.id)).map(c => ({ ...c, url: rpcUrlFor(c.id, process.env)! }));
const TOP_CONTRACTS = Number(arg('top', '150')); // opaque contracts looked up on Sourcify per chain
const rpc = new JsonRpcClient(Object.fromEntries(CHAINS.map(c => [c.id, c.url])), { timeoutMs: 30_000, retries: 6, retryDelayMs: 500 });

interface RawTx { hash: string; from: string; to: string | null; input: string; value: string; type: string; authorizationList?: unknown[] }
interface Row { hash: string; from: string; block: number; to: string | null; selector: string; type: string; status: Preview['decoding']['status'] | 'error'; decoder: string; title: string; shape: Shape; eip7702: string[] }
/**
 * abi: 4-byte selector + 32-byte words (or empty); packed: any other length, i.e. custom encoding no ABI describes
 * (typically trading bots); vanity: ABI-shaped, but the selector starts with zero bytes, mined to save gas (bots).
 */
type Shape = 'abi' | 'packed' | 'vanity';
const shapeOf = (data: string): Shape => {
  if (data === '0x') return 'abi';
  const bytes = (data.length - 2) / 2;
  if (bytes < 4 || (bytes - 4) % 32 !== 0) return 'packed';
  return data.startsWith('0x0000') ? 'vanity' : 'abi';
};
/** Chains' own transaction types (Arbitrum's deposits, retryables and ArbOS internals; OP Stack deposits). */
const SYSTEM_TYPES: Record<number, Set<string>> = { 42161: new Set(['0x64', '0x65', '0x66', '0x68', '0x69', '0x6a']), 8453: new Set(['0x7e']), 10: new Set(['0x7e']) };

async function pool<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: size }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]); } }));
  return out;
}
const hexNum = (h: string) => Number(BigInt(h));

/** A block; a load-balanced node can answer null for one a backend doesn't have yet, so it is asked again a few times. */
async function blockOf(chainId: number, n: number, full: boolean): Promise<{ timestamp: string; transactions: RawTx[] }> {
  for (let i = 0; ; i++) {
    const b = await rpc.call(chainId, 'eth_getBlockByNumber', ['0x' + n.toString(16), full]) as { timestamp: string; transactions: RawTx[] } | null;
    if (b) return b;
    if (i >= 5) throw new Error(`block ${n} not returned by the node`);
    await new Promise(r => setTimeout(r, 500));
  }
}
/**
 * First block at or after `ts` (unix seconds), by binary search on timestamps. The search starts from an estimate
 * (block rate over the last 1,000 blocks), since public nodes prune old history.
 */
async function blockAt(chainId: number, ts: number, latest: number): Promise<number> {
  // A load-balanced node can answer for a block one of its backends doesn't have yet (null): asked again, a few times.
  const stamp = async (n: number) => {
    for (let i = 0; ; i++) {
      const b = await rpc.call(chainId, 'eth_getBlockByNumber', ['0x' + n.toString(16), false]) as { timestamp: string } | null;
      if (b) return hexNum(b.timestamp);
      if (i >= 5) throw new Error(`block ${n} not returned by the node`);
      await new Promise(r => setTimeout(r, 500));
    }
  };
  const now = await stamp(latest), before = await stamp(latest - 1000);
  const perBlock = (now - before) / 1000;
  const guess = Math.max(0, latest - Math.ceil((now - ts) / perBlock));
  let lo = Math.max(0, guess - Math.ceil(3600 / perBlock)), hi = Math.min(latest, guess + Math.ceil(3600 / perBlock));
  while (lo > 0 && await stamp(lo) > ts) lo = Math.max(0, lo - Math.ceil(3600 / perBlock));
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const b = await rpc.call(chainId, 'eth_getBlockByNumber', ['0x' + mid.toString(16), false]) as { timestamp: string } | null;
    if (b && hexNum(b.timestamp) < ts) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function preview(chainId: number, t: RawTx, ts: number, block: number, deps: Dependencies): Promise<Row> {
  const selector = t.input.length >= 10 ? t.input.slice(0, 10) : t.input === '0x' ? 'none' : 'short';
  const base = { hash: t.hash, from: t.from.toLowerCase(), block, to: t.to?.toLowerCase() ?? null, selector, type: t.type, shape: shapeOf(t.input) };
  const tx = { from: t.from, ...(t.to && { to: t.to }), data: t.input, value: t.value, chainId: '0x' + chainId.toString(16), ...(t.authorizationList && { authorizationList: t.authorizationList }) };
  return previewRequest({ method: 'eth_sendTransaction', params: [tx] }, { now: ts * 1000 }, deps)
    .then(p => ({ ...base, status: p.decoding.status, decoder: p.decoding.decoder, title: p.title, eip7702: p.warnings.map(w => w.code).filter(c => c.startsWith('eip7702_')) }))
    .catch(e => ({ ...base, status: 'error' as const, decoder: 'error', title: (e as Error).message.slice(0, 160), eip7702: [] }));
}

const count = <T>(xs: T[], key: (x: T) => string) => { const m = new Map<string, number>(); for (const x of xs) m.set(key(x), (m.get(key(x)) ?? 0) + 1); return [...m].sort((a, b) => b[1] - a[1]); };
const pct = (n: number, d: number) => d ? `${(100 * n / d).toFixed(1)}%` : '-';

/** OpenChain lookup for many selectors at once (comma-separated), as a static SignatureResolver. */
async function openChainBatch(selectors: string[]): Promise<SignatureResolver> {
  const found = new Map<string, string[]>();
  for (let i = 0; i < selectors.length; i += 60) {
    const chunk = selectors.slice(i, i + 60);
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await fetch(`https://api.openchain.xyz/signature-database/v1/lookup?function=${chunk.join(',')}&filter=true`, { signal: AbortSignal.timeout(30_000) });
        const body = await res.json() as { result?: { function?: Record<string, { name: string }[] | null> } };
        for (const [sel, list] of Object.entries(body.result?.function ?? {})) if (list?.length) found.set(sel.toLowerCase(), list.map(x => x.name));
        break;
      } catch { await new Promise(r => setTimeout(r, 1000 * (attempt + 1))); }
    }
  }
  return { lookup: async s => found.get(s.toLowerCase()) ?? [], candidates: async s => (found.get(s.toLowerCase()) ?? []).map((signature): SignatureCandidate => ({ signature, tier: 1, source: 'OpenChain' })) };
}

const report: Record<string, unknown> = { generatedAt: new Date().toISOString(), hours: HOURS, chains: [] as unknown[] };
for (const chain of CHAINS) {
  if (!chain.blocks) continue; // e.g. --arb 0 skips Arbitrum
  // A few blocks behind the head, which every backend of a load-balanced node has.
  const latest = hexNum(String(await rpc.call(chain.id, 'eth_blockNumber', []))) - 5;
  const latestTs = hexNum((await blockOf(chain.id, latest, false)).timestamp);
  const start = await blockAt(chain.id, latestTs - HOURS * 3600, latest);
  const span = latest - start;
  const picks = Array.from({ length: chain.blocks }, (_, i) => start + Math.floor((i + 0.5) * span / chain.blocks));
  console.log(`\n# ${chain.name}: blocks ${start}-${latest} (${span} blocks in ${HOURS} h); sampling ${picks.length} evenly`);
  const blocks = await pool(picks, 4, n => blockOf(chain.id, n, true));
  const all = blocks.flatMap((b, i) => b.transactions.map(t => ({ t, ts: hexNum(b.timestamp), block: picks[i] })));
  const system = all.filter(x => SYSTEM_TYPES[chain.id]?.has(x.t.type));
  const txs = all.filter(x => !SYSTEM_TYPES[chain.id]?.has(x.t.type));
  console.log(`${all.length} transactions in the sampled blocks; ${system.length} are chain system transactions (excluded)`);

  // Pass 1: offline.
  const offline: Dependencies = { tokens: new StaticTokenRegistry(), signatures: new ChainedSignatures([]) };
  const rows = await pool(txs, 16, ({ t, ts, block }) => preview(chain.id, t, ts, block, offline));
  const show = (label: string, rs: Row[]) => {
    const by = Object.fromEntries(count(rs, r => r.status));
    console.log(`${label.padEnd(26)} ${rs.length} txs | full ${pct(by.full ?? 0, rs.length)} | partial ${pct(by.partial ?? 0, rs.length)} | opaque ${pct(by.opaque ?? 0, rs.length)} | errors ${by.error ?? 0}`);
    return by;
  };
  const pass1 = show('offline', rows);

  // Pass 2: online lookups for the opaque remainder.
  let pass2: Record<string, number> | undefined, rows2 = rows;
  const opaque = rows.filter(r => r.status === 'opaque');
  const topContracts = count(opaque.filter(r => r.to), r => r.to!).slice(0, TOP_CONTRACTS).map(([a]) => a);
  if (!OFFLINE && opaque.length) {
    const selectors = [...new Set(opaque.map(r => r.selector).filter(s => /^0x[0-9a-f]{8}$/.test(s)))];
    const openchain = await openChainBatch(selectors);
    const resolver = new ContractAbiResolver({ sources: [new SourcifyAbiSource()], rpc });
    const verified = new Map<string, Promise<ContractAbi | null>>();
    await pool(topContracts, 4, async a => { const v = resolver.resolve(chain.id, a); verified.set(a, v); await v; });
    // Only the busiest contracts get an ABI lookup; the rest are identified by selector.
    const abis: AbiResolver = { resolve: async (_c, a) => verified.get(a.toLowerCase()) ?? null, resolveCall: async (c, a, s) => verified.has(a.toLowerCase()) ? resolver.resolveCall(c, a, s) : null };
    const online: Dependencies = { tokens: new StaticTokenRegistry(), signatures: new ChainedSignatures([openchain]), abis, rpc };
    const byHash = new Map(txs.map(x => [x.t.hash, x]));
    const redone = await pool(opaque, 8, r => { const x = byHash.get(r.hash)!; return preview(chain.id, x.t, x.ts, x.block, online); });
    const redoneByHash = new Map(redone.map(r => [r.hash, r]));
    rows2 = rows.map(r => redoneByHash.get(r.hash) ?? r);
    pass2 = show('with online lookups', rows2);
    const verifiedCount = (await Promise.all([...verified.values()])).filter(Boolean).length;
    console.log(`  Sourcify: ${verifiedCount}/${topContracts.length} of the busiest opaque contracts are verified; OpenChain knew ${selectors.length ? (await Promise.all(selectors.map(s => openchain.lookup(s)))).filter(x => x.length).length : 0}/${selectors.length} opaque selectors`);
  }

  const still = rows2.filter(r => r.status === 'opaque');
  const shapes = Object.fromEntries(count(still, r => r.shape));
  const abiShaped = rows2.filter(r => r.shape === 'abi');
  const abiOpaque = abiShaped.filter(r => r.status === 'opaque').length;
  console.log(`  opaque breakdown: packed calldata ${shapes.packed ?? 0}, vanity selectors ${shapes.vanity ?? 0}, ABI-shaped calls to unpublished contracts ${shapes.abi ?? 0}`);
  console.log(`  ABI-shaped transactions only (${abiShaped.length}): readable ${pct(abiShaped.length - abiOpaque, abiShaped.length)}, opaque ${pct(abiOpaque, abiShaped.length)}`);
  // Sampled blocks are spread evenly over the window (minutes apart), so a sender seen in 3+ of them is sending
  // around the clock: a bot, relayer or exchange, not someone confirming in a wallet.
  const blocksBySender = new Map<string, Set<number>>();
  for (const r of rows2) { let b = blocksBySender.get(r.from); if (!b) blocksBySender.set(r.from, b = new Set()); b.add(r.block); }
  const automated = (r: Row) => blocksBySender.get(r.from)!.size >= 3;
  const occasional = rows2.filter(r => !automated(r));
  const occasionalOpaque = occasional.filter(r => r.status === 'opaque').length;
  const senders = { automatedSenders: [...blocksBySender.values()].filter(b => b.size >= 3).length, senders: blocksBySender.size,
    automatedTransactions: rows2.length - occasional.length, opaqueFromAutomated: still.filter(automated).length,
    occasionalTransactions: occasional.length, occasionalOpaque };
  console.log(`  senders: ${senders.automatedSenders} of ${senders.senders} appear in 3+ sampled blocks (automated); they sent ${pct(senders.automatedTransactions, rows2.length)} of the transactions and ${pct(senders.opaqueFromAutomated, still.length)} of the opaque ones`);
  console.log(`  occasional senders only (${occasional.length}): readable ${pct(occasional.length - occasionalOpaque, occasional.length)}, opaque ${pct(occasionalOpaque, occasional.length)}`);
  const occasionalTop = count(occasional.filter(r => r.status === 'opaque' && r.to), r => r.to!);
  console.log(`    their opaque transactions go to ${occasionalTop.length} contracts; busiest: ${occasionalTop.slice(0, 5).map(([a, n]) => `${a} (${n}, ${count(occasional.filter(r => r.to === a && r.status === 'opaque'), r => r.shape).map(([k, v]) => `${k} ${v}`).join('/')})`).join(', ')}`);
  const setCode = rows2.filter(r => r.type === '0x4');
  // Signed authorizations in real blocks: the sender's own account (eip7702_delegation / _revoke) or a sponsored one.
  const auth = Object.fromEntries(count(setCode.flatMap(r => [...new Set(r.eip7702)]), c => c));
  if (setCode.length) console.log(`  EIP-7702 set-code transactions: ${setCode.length} (${pct(setCode.length, rows2.length)}); authorizations: ${Object.entries(auth).map(([c, n]) => `${c.replace('eip7702_', '')} in ${n}`).join(', ') || 'none read'}`);
  const decoders = count(rows2, r => r.decoder);
  const types = count(rows2, r => r.type);
  const errors = rows2.filter(r => r.status === 'error');
  console.log(`  decoders: ${decoders.slice(0, 14).map(([d, n]) => `${d} ${pct(n, rows2.length)}`).join(', ')}`);
  console.log(`  tx types: ${types.map(([t, n]) => `${t} ${n}`).join(', ')}`);
  const stillTop = count(still.filter(r => r.to), r => r.to!);
  const top10 = stillTop.slice(0, 10).reduce((s, [, n]) => s + n, 0);
  console.log(`  still opaque: ${still.length} txs to ${stillTop.length} contracts; the 10 busiest account for ${pct(top10, still.length)}`);
  for (const [a, n] of stillTop.slice(0, 8)) console.log(`    ${a}  ${n} txs  selectors ${count(still.filter(r => r.to === a), r => r.selector).slice(0, 3).map(([s, k]) => `${s}×${k}`).join(' ')}`);
  for (const e of errors.slice(0, 5)) console.log(`  ERROR ${e.hash}: ${e.title}`);
  (report.chains as unknown[]).push({
    chain: chain.name, chainId: chain.id, fromBlock: start, toBlock: latest, sampledBlocks: picks.length, transactions: rows2.length, systemTransactions: system.length,
    opaqueShapes: shapes, abiShaped: { transactions: abiShaped.length, opaque: abiOpaque }, setCodeTransactions: setCode.length, setCodeAuthorizations: auth, senders,
    offline: pass1, online: pass2, decoders, txTypes: types, errors: errors.map(e => ({ hash: e.hash, message: e.title })),
    opaqueContracts: stillTop.slice(0, 50).map(([address, txs]) => ({ address, txs, selectors: count(still.filter(r => r.to === address), r => r.selector).slice(0, 5) })),
    opaqueSelectors: count(still, r => r.selector).slice(0, 50),
    occasionalOpaqueContracts: count(rows2.filter(r => r.status === 'opaque' && r.to && blocksBySender.get(r.from)!.size < 3), r => r.to!).slice(0, 50),
    examples: Object.fromEntries(decoders.slice(0, 25).map(([d]) => [d, rows2.filter(r => r.decoder === d).slice(0, 3).map(r => ({ hash: r.hash, title: r.title }))])),
  });
}
const out = arg('out', '');
if (out) { writeFileSync(out, JSON.stringify(report, null, 2)); console.log(`\nreport: ${out}`); }
