// A mined transaction replayed where it ran (src/replay.ts), and a preview simulated on a past block
// (PreviewContext.block): the block named, what runs before the transaction, the comparison with its receipt, prices
// as of then, and a node that no longer has the state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { encodeAbiParameters, encodeFunctionData, parseAbi } from 'viem';
import Ajv2020Module from 'ajv/dist/2020.js';
import { compareWithReceipt, ReplayError, replayTransaction } from '../src/replay.ts';
import { compareWithAccessList } from '../src/evm/trace.ts';
import { afterParent, blobBaseFeeAfter, headerAfter, headerOf, keepsToBlock, nodeOverrides, parseBlock, pinBlock, priceFields, stateBefore } from '../src/block.ts';
import { chainsOwnLog, sameRun } from '../src/evm/trace.ts';
import { previewRequest } from '../src/preview.ts';
import { createPreviewServer } from '../src/server.ts';
import { fitGas, hadRoom, NATIVE_LOG_ADDRESS, parseLogs, RpcSimulator } from '../src/simulation.ts';
import { builtinTokens, StaticTokenRegistry } from '../src/chains.ts';
import { CHAINLINK_FEEDS, ChainlinkPrices } from '../src/prices.ts';
import type { Dependencies, SimulationRequest, SimulationResult, TraceCall } from '../src/types.ts';
import { ALICE, BOB } from '../mocks/data.ts';
import { codes, detail, NOW } from './helpers.ts';

const USDC = builtinTokens(8453).find(t => t.symbol === 'USDC')!.address.toLowerCase();
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const pad = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, '0')}`;
const hex = (n: number | bigint) => `0x${n.toString(16)}`;
const H = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const DEPOSITOR = '0xdeaddeaddeaddeaddeaddeaddeaddeaddead0001';
const transfer = encodeFunctionData({ abi: parseAbi(['function transfer(address,uint256)']), functionName: 'transfer', args: [BOB, 200_000_000n] });
const LOG = { address: USDC, topics: [TRANSFER, pad(ALICE), pad(BOB)], data: pad(hex(200_000_000n)) };

// A Base block, number 100, a second after its parent: the L1 info deposit, a user's deposit, a transfer by Bob,
// Alice's USDC transfer (the one replayed), and a transaction after it.
const tx = (index: number, t: Record<string, unknown>) => ({ hash: H(0xa0 + index), transactionIndex: hex(index), blockNumber: '0x64', type: '0x2', value: '0x0', input: '0x', gas: '0x5208', gasPrice: '0x5f5e100', nonce: '0x7', ...t });
const TXS = [
  tx(0, { from: DEPOSITOR, to: '0x4200000000000000000000000000000000000015', type: '0x7e', input: '0x098999be', gas: '0xf4240', gasPrice: '0x0' }),
  tx(1, { from: '0x9999999999999999999999999999999999999999', to: BOB, type: '0x7e', value: '0x1', gasPrice: '0x0' }),
  tx(2, { from: BOB, to: ALICE, value: '0xde0b6b3a7640000', gasPrice: '0x6000000' }),
  tx(3, { from: ALICE, to: USDC, input: transfer, gas: '0x186a0', maxFeePerGas: '0x77359400', maxPriorityFeePerGas: '0xf4240', accessList: [{ address: USDC, storageKeys: [H(1)] }] }),
  tx(4, { from: BOB, to: ALICE }),
];
const header = (n: number) => ({ number: hex(n), timestamp: hex(1_762_000_000 + n), miner: '0x4200000000000000000000000000000000000011', mixHash: H(n), gasLimit: '0x8f0d180', baseFeePerGas: '0x5e69ec0' });
const RECEIPT = { status: '0x1', gasUsed: hex(51_234), effectiveGasPrice: '0x5f5e100', l1Fee: hex(10n ** 10n), logs: [LOG] };

/** A chain with blocks up to `head`; the feed's answer is given for whichever block is asked. */
function chain(head = 101) {
  const calls: { method: string; params: unknown[] }[] = [];
  const rpc = {
    has: (c: number) => c === 8453,
    call: async (_c: number, method: string, params: unknown[]) => {
      calls.push({ method, params });
      if (method === 'eth_getTransactionByHash') return TXS.find(t => t.hash === params[0]) ?? (params[0] === H(0xff) ? { ...TXS[3], hash: H(0xff), blockNumber: null } : null);
      if (method === 'eth_getTransactionReceipt') return params[0] === TXS[3].hash ? RECEIPT : params[0] === TXS[1].hash ? { ...RECEIPT, logs: [] } : null;
      if (method === 'eth_getBlockByNumber') {
        const n = params[0] === 'latest' ? head : Number(BigInt(params[0] as string));
        return n > head ? null : { ...header(n), transactions: n === 100 && params[1] ? TXS : [] };
      }
      if (method === 'eth_call' && (params[0] as { to: string }).to === CHAINLINK_FEEDS[8453]['USDC / USD']) {
        const time = BigInt(1_762_000_000 + Number(BigInt(params[1] as string))) - 3600n;
        return encodeAbiParameters([{ type: 'uint80' }, { type: 'int256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint80' }], [1n, 99_990_000n, time, time, 1n]);
      }
      return method === 'eth_getCode' ? '0x' : '0x0';
    },
  };
  return { rpc: rpc as unknown as NonNullable<Dependencies['rpc']>, calls };
}
const ran = (over: Partial<SimulationResult> = {}): SimulationResult => ({ status: 'success', source: 'a test', gasUsed: 51_234n, ...parseLogs([LOG]), logs: [LOG], ...over });
function deps(result: SimulationResult, head?: number) {
  const { rpc, calls } = chain(head);
  const batches: SimulationRequest[][] = [], budgets: (number | undefined)[] = [];
  const simulator = {
    simulate: async (r: SimulationRequest) => { batches.push([r]); return result; },
    simulateBatch: async (reqs: SimulationRequest[]) => { batches.push(reqs); return reqs.map((_, i) => (i === reqs.length - 1 ? result : ran({ logs: [], transfers: [] }))); },
    trace: async (_reqs: SimulationRequest[], options?: { budgetMs?: number }) => { budgets.push(options?.budgetMs); return null; },
  };
  return { deps: { tokens: new StaticTokenRegistry(), rpc, simulator, prices: new ChainlinkPrices(rpc, { now: () => NOW }) } as Dependencies, batches, budgets, calls };
}

test('A mined transaction is replayed where it ran, and the run is compared with its receipt', async () => {
  const { deps: d, batches, budgets, calls } = deps(ran());
  const p = await replayTransaction({ chainId: 8453, hash: TXS[3].hash }, { trace: true }, d);
  assert.equal(p.title, 'Send 200 USDC');
  // On its parent's state, in a block with its own header; after the L1 info deposit and Bob's transfer (the other
  // deposit, the chain's own, is left out), each with its gas limit and price; then itself, at the price it paid.
  // The earlier ones run first and aren't reported: only the transaction itself is simulated for the preview.
  const target = batches[0][0], all = [...target.at!.before!, target];
  assert.deepEqual([batches.length, batches[0].length], [1, 1]);
  assert.deepEqual(all.map(r => [r.from, r.gas, r.gasPrice]), [[DEPOSITOR, 1_000_000n, 0n], [BOB.toLowerCase(), 21_000n, 0x6000000n], [ALICE.toLowerCase(), 100_000n, 0x5f5e100n]]);
  for (const r of all) assert.deepEqual([r.at!.block, r.at!.required, r.at!.header.number, r.at!.header.timestamp, r.at!.header.baseFeePerGas, r.at!.header.prevRandao], ['0x63', true, 100n, 1_762_000_100n, 0x5e69ec0n, H(100)]);
  assert.deepEqual(target.accessList, [{ address: USDC, storageKeys: [H(1)] }]);
  // What it did, and that the run is what the receipt says.
  assert.deepEqual(p.replay, { hash: TXS[3].hash, block: '100', index: 3, time: '2025-11-01T12:28:20.000Z', receipt: { status: 'success', gasUsed: '51234', fee: '0.0000051334 ETH' }, matches: true });
  assert.deepEqual(p.simulation, { status: 'success', source: 'a test', gasUsed: '51234', block: '99' });
  assert.match(p.decoding.notes.join(' '), /Replayed where it ran: in block 100 \(2025-11-01 12:28:20 UTC\), after the 2 transactions before it in the block, at the price it paid\. The run has the same outcome, events and gas as its receipt\./);
  // The fee is the one paid (the gas at its price, and the L1 data fee), not an estimate; nothing about inclusion now.
  assert.equal(detail(p, 'Network fee paid'), '0.0000051334 ETH (51,234 gas)');
  assert.equal(detail(p, 'Network fee'), undefined);
  // (The one nonce read is the sender's before the block, to see that the node answers from that block: below.)
  assert.deepEqual(calls.filter(c => c.method === 'eth_getTransactionCount' || c.method === 'eth_getBalance' || c.method === 'eth_maxPriorityFeePerGas').map(c => [c.method, c.params]), [['eth_getTransactionCount', [ALICE, '0x63']]]);
  // Its value then: the feed as of its block, an hour old there (a year old by now, which would be stale).
  assert.deepEqual(p.assetChanges.map(c => [c.direction, c.amount, c.symbol, c.usd, c.usdSource]), [['out', '200', 'USDC', '199.98', 'Chainlink USDC / USD']]);
  assert.equal(detail(p, 'Value then'), 'out ≈ $199.98');
  assert.deepEqual(calls.filter(c => c.method === 'eth_call').map(c => c.params[1]), ['0x64']);
  // The tracing run replays the block's earlier transactions too: it is given a minute.
  assert.deepEqual(budgets, [60_000]);
  assert.match(p.decoding.notes.join(' '), /No trace/);
});

test('A replay that doesn’t come out as the receipt says so', async () => {
  const other = { ...LOG, data: pad(hex(199_000_000n)) };
  const cases: [Partial<SimulationResult>, RegExp][] = [
    [{ gasUsed: 51_000n }, /the run used 51,000 gas where the receipt says 51,234/],
    [{ logs: [other] }, /event 1 of 1 differs from the receipt's/],
    [{ logs: [LOG, LOG] }, /the run emitted 2 events where the receipt has 1/],
    [{ status: 'reverted', revertReason: 'ERC20: transfer amount exceeds balance', logs: undefined, transfers: [] }, /the run reverted \(ERC20: transfer amount exceeds balance\) where the receipt says it succeeded/],
  ];
  for (const [over, said] of cases) {
    const p = await replayTransaction({ chainId: 8453, hash: TXS[3].hash }, {}, deps(ran(over)).deps);
    assert.equal(p.replay!.matches, false);
    assert.match(p.replay!.differences!.join('; '), said);
    assert.ok(codes(p).includes('replay_differs'));
    assert.match(p.warnings.find(w => w.code === 'replay_differs')!.message, said);
  }
  // A failed transaction is said to have failed, not to be about to.
  const failed = await replayTransaction({ chainId: 8453, hash: TXS[3].hash }, {}, deps(ran({ status: 'reverted', revertReason: 'paused', logs: undefined, transfers: [] })).deps);
  assert.match(failed.warnings.find(w => w.code === 'simulation_reverted')!.message, /^The transaction failed: paused\. Its sender still paid the network fee\.$/);
  // The comparison itself: Arbitrum's node adds its own charge for L1 data, up to twice the receipt's.
  const receipt = { status: 'success' as const, gasUsed: 100_000n, gasForL1: 20_000n, logs: [LOG] };
  assert.deepEqual(compareWithReceipt(ran({ gasUsed: 100_000n }), receipt), { matches: true });
  assert.deepEqual(compareWithReceipt(ran({ gasUsed: 135_000n }), receipt), { matches: true });
  assert.equal(compareWithReceipt(ran({ gasUsed: 141_000n }), receipt).matches, false);
  assert.equal(compareWithReceipt(ran({ gasUsed: 99_000n }), receipt).matches, false);
  assert.deepEqual(compareWithReceipt(ran({ logs: undefined }), { ...receipt, gasUsed: 51_234n }).differences, ["the run's events couldn't be read back to compare"]);
  assert.deepEqual(compareWithReceipt(ran({ status: 'reverted', logs: undefined }), { status: 'reverted', gasUsed: 51_234n, logs: [] }), { matches: true });
});

test('What can’t be replayed: no such transaction, one not mined, the chain’s own, a chain without an RPC', async () => {
  const { deps: d } = deps(ran());
  const refused = async (input: { chainId: number; hash: string }, code: string, said: RegExp, with_ = d) =>
    assert.rejects(replayTransaction(input, {}, with_), (e: unknown) => e instanceof ReplayError && e.code === code && said.test(e.message));
  await refused({ chainId: 8453, hash: H(0x01) }, 'NOT_FOUND', /No transaction 0x0+1 on Base/);
  await refused({ chainId: 8453, hash: H(0xff) }, 'PENDING', /isn't mined yet/);
  await refused({ chainId: 8453, hash: TXS[1].hash }, 'UNSUPPORTED', /one of Base's own transactions/);
  await refused({ chainId: 8453, hash: '0x1234' }, 'INVALID_REQUEST', /"hash" must be a transaction hash/);
  await refused({ chainId: 1, hash: TXS[3].hash }, 'UNAVAILABLE', /No RPC is configured for Ethereum/);
  await refused({ chainId: 8453, hash: TXS[3].hash }, 'UNAVAILABLE', /No RPC/, { ...d, simulator: undefined });
});

test('The replay endpoint returns a preview that matches the spec, and says why when it can’t', async () => {
  const Ajv2020 = (Ajv2020Module as unknown as { default?: typeof Ajv2020Module }).default ?? Ajv2020Module;
  const spec = JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8'));
  const ajv = new (Ajv2020 as unknown as new (o: object) => { addSchema(s: object): void; getSchema(k: string): ((d: unknown) => boolean) & { errors?: unknown[] } | undefined })({ strict: false, allErrors: true });
  ajv.addSchema({ ...spec, $id: 'spec' });
  const matches = (name: string, data: unknown) => { const v = ajv.getSchema(`spec#/components/schemas/${name}`)!; assert.ok(v(data), `${name}: ${JSON.stringify(v.errors?.slice(0, 3))}`); };
  const server = createPreviewServer({ deps: deps(ran()).deps });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const body = { chainId: 8453, hash: TXS[3].hash, trace: true };
    matches('ReplayRequest', body);
    const ok = await post('/v1/replay', body);
    assert.equal(ok.status, 200);
    const preview = await ok.json() as { replay: { matches: boolean }; simulation: { block: string } };
    matches('Preview', preview);
    assert.deepEqual([preview.replay.matches, preview.simulation.block], [true, '99']);
    for (const [input, status, code] of [[{ chainId: 8453, hash: H(1) }, 404, 'NOT_FOUND'], [{ chainId: 8453, hash: H(0xff) }, 409, 'PENDING'], [{ chainId: 8453, hash: TXS[1].hash }, 422, 'UNSUPPORTED'], [{ chainId: 8453 }, 400, 'INVALID_REQUEST'], [{ chainId: 10, hash: H(1) }, 503, 'UNAVAILABLE']] as const) {
      const res = await post('/v1/replay', input), error = await res.json() as { error: { code: string } };
      assert.deepEqual([res.status, error.error.code], [status, code]);
      matches('Error', error);
    }
    // A past block for a request, over HTTP: the context's block reaches the simulation, and the preview matches the spec.
    const past = await post('/v1/preview', { request: { method: 'eth_sendTransaction', params: [{ from: ALICE, to: USDC, data: transfer, chainId: '0x2105' }] }, context: { block: '0x64', replay: { gasPrice: 1 } } });
    const then = await past.json() as { simulation: { block: string }; replay?: unknown };
    matches('Preview', then);
    assert.deepEqual([then.simulation.block, then.replay], ['100', undefined]);
  } finally { await new Promise(r => server.close(r)); }
});

test('A request previewed on a past block: its state, the block that followed, prices as of then', async () => {
  const send = (context: Record<string, unknown>, d: Dependencies) => previewRequest({ method: 'eth_sendTransaction', params: [{ from: ALICE, to: USDC, data: transfer, chainId: '0x2105' }] }, { now: NOW, ...context }, d);
  const { deps: d, batches, calls } = deps(ran());
  const p = await send({ block: 100 }, d);
  // The state after block 100, in block 101 as it was (its own time and randomness): never the latest instead.
  assert.deepEqual(batches[0].map(r => [r.at!.block, r.at!.required, r.at!.header.number, r.at!.header.timestamp, r.at!.header.prevRandao]), [['0x64', true, 101n, 1_762_000_101n, H(101)]]);
  assert.equal(p.simulation!.block, '100');
  assert.match(p.decoding.notes.join(' '), /Simulated on the state after block 100 \(2025-11-01 12:28:20 UTC\), as the first transaction of the block that followed: what it would have done then, not now\./);
  // Whether it could be included now isn't the question, so the fee and nonce checks aren't run.
  assert.equal(detail(p, 'Network fee'), undefined);
  assert.equal(calls.some(c => c.method === 'eth_getTransactionCount'), false);
  assert.deepEqual([p.assetChanges[0].usd, detail(p, 'Value then'), p.replay], ['199.98', 'out ≈ $199.98', undefined]);
  assert.deepEqual(calls.filter(c => c.method === 'eth_call').map(c => c.params[1]), ['0x64']);
  // The priced run is at the named block's base fee, not the latest block's.
  const priced = batches.find(b => b[0].gasPrice !== undefined);
  assert.equal(priced?.[0].baseFee, 0x5e69ec0n);
  // The chain's latest block: the block after it doesn't exist yet, so its header is the one that would follow (on
  // Base, which makes several blocks a second, in the same second).
  const latest = deps(ran());
  await send({ block: '0x65' }, latest.deps);
  assert.deepEqual([latest.batches[0][0].at!.block, latest.batches[0][0].at!.header.number, latest.batches[0][0].at!.header.timestamp], ['0x65', 102n, 1_762_000_101n]);
  // A block the chain doesn't have: no simulation, and the reason.
  const beyond = await send({ block: '500' }, deps(ran()).deps);
  assert.deepEqual([beyond.simulation!.status, codes(beyond).includes('simulation_unavailable')], ['unavailable', true]);
  assert.match(beyond.simulation!.error!, /Block 500 isn't on this chain/);
  // Not a block number: the request is refused.
  await assert.rejects(send({ block: 'yesterday' }, d), /context: "block" must be a block number/);
  assert.deepEqual([parseBlock(7), parseBlock('12'), parseBlock('0x10')], [7n, 12n, 16n]);
  assert.throws(() => parseBlock(-1));
  await assert.rejects(pinBlock(undefined, 8453, 1n), /No RPC is configured/);

  // A batch: every call on the named block, and the batch says so.
  const many = deps(ran());
  const batch = await previewRequest({ method: 'wallet_sendCalls', params: [{ version: '2.0.0', from: ALICE, chainId: '0x2105', atomicRequired: true, calls: [{ to: USDC, data: transfer }, { to: USDC, data: transfer }] }] }, { now: NOW, block: 100 }, many.deps);
  assert.deepEqual(many.batches[0].map(r => r.at!.block), ['0x64', '0x64']);
  assert.equal(batch.simulation!.block, '100');
  assert.match(batch.decoding.notes.join(' '), /Simulated on the state after block 100 .*what the calls would have done then, not now\./);
  assert.doesNotMatch(batch.calls!.flatMap(c => c.decoding.notes).join(' '), /latest block|first transaction/);
  // A signature isn't simulated on a past block, and says so.
  const message = await previewRequest({ method: 'personal_sign', params: ['0x68656c6c6f', ALICE] }, { now: NOW, chainId: 8453, block: 100 }, d);
  assert.match(message.decoding.notes.join(' '), /A past block \(context\.block\) applies to transactions and batches/);
});

test('A node that no longer has a named block’s state is an error, not a simulation on the latest block', async () => {
  const { rpc } = chain();
  const tags: unknown[] = [];
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { method: string; params: unknown[] };
    tags.push(body.params.at(-1));
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'missing trie node 4f2a (path ) state 0x4f2a is not available' } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const simulator = new RpcSimulator({ 8453: 'http://rpc.invalid' }, { fetchImpl });
  const p = await previewRequest({ method: 'eth_sendTransaction', params: [{ from: ALICE, to: USDC, data: transfer, chainId: '0x2105' }] }, { now: NOW, block: 100 }, { tokens: new StaticTokenRegistry(), rpc, simulator });
  assert.equal(p.simulation!.status, 'unavailable');
  assert.match(p.simulation!.error!, /This chain's node doesn't keep the state of block 100 \(most keep only recent blocks; an archive node keeps them all\): .*missing trie node/);
  assert.deepEqual([...new Set(tags)], ['0x64']);
  // The same for a trace alone: a node that answers the simulation of a past block but not the local EVM's reads
  // of its state (a public RPC's backends differ) leaves no trace, and the preview says that is why.
  const reads = { covers: () => true, simulate: async () => null, simulateBatch: async () => null, trace: async () => { throw new Error('eth_getBalance failed: historical state 9369542c is not available'); } };
  const partly = new RpcSimulator({ 8453: 'http://rpc.invalid' }, { fork: reads, fetchImpl: (async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: [{ calls: [{ status: '0x1', gasUsed: '0x5208', returnData: '0x', logs: [] }] }] }))) as unknown as typeof fetch });
  const untraced = await previewRequest({ method: 'eth_sendTransaction', params: [{ from: ALICE, to: USDC, data: transfer, chainId: '0x2105' }] }, { now: NOW, block: 100, trace: true }, { tokens: new StaticTokenRegistry(), rpc, simulator: partly });
  assert.deepEqual([untraced.simulation!.status, untraced.trace], ['success', undefined]);
  assert.match(untraced.decoding.notes.join(' '), /No trace: the local EVM reads the chain's state as it runs, and the chain's node didn't serve it block 100's \(most keep only recent blocks; an archive node keeps them all\)\./);
  // Named only so that a trace matches (no block asked for): the latest block answers instead, as before.
  tags.length = 0;
  const traced = await previewRequest({ method: 'eth_sendTransaction', params: [{ from: ALICE, to: USDC, data: transfer, chainId: '0x2105' }] }, { now: NOW, trace: true }, { tokens: new StaticTokenRegistry(), rpc, simulator });
  assert.equal(traced.simulation!.status, 'unavailable');
  assert.ok(tags.includes('latest'));
});

test('A node that answers every read from its latest state, whatever block is asked for, is told from one that keeps to the block', async () => {
  // HyperEVM's public RPC: a state read at a past block comes back from the latest state, with no error. Run on
  // that, a replay showed what the transaction would do today under its old block's header (0 of 12 matched their
  // receipts). A nonce tells: Alice sent the transaction replayed with nonce 7, so before its block she had at most 7.
  const node = (nonceThen: string, head = 101) => {
    const { rpc, calls } = chain(head);
    const inner = rpc.call.bind(rpc);
    rpc.call = async (c: number, method: string, params: unknown[]) => {
      if (method === 'eth_getTransactionCount') { calls.push({ method, params }); return nonceThen; }
      // The latest blocks hold a transaction each (the past-block simulation's witness: it has none of its own).
      if (method === 'eth_getBlockByNumber' && !params[1]) return { ...(await inner(c, method, params) as object), transactions: [TXS[3].hash] };
      return inner(c, method, params);
    };
    return { rpc, calls };
  };
  const replayOn = (nonceThen: string) => { const d = deps(ran()); return replayTransaction({ chainId: 8453, hash: TXS[3].hash }, { now: NOW }, { ...d.deps, rpc: node(nonceThen).rpc }); };
  // The node answers 8 (her nonce now): not the state before block 100. No simulation is shown as if it were.
  await assert.rejects(replayOn('0x8'), (e: unknown) => e instanceof ReplayError && e.code === 'UNAVAILABLE' && /Base's node answers every read from its latest state, whatever block is asked for.*takes a node that serves past blocks' state/.test(e.message));
  // 7, or less (she sent others earlier in the block): the block's own state.
  assert.equal((await replayOn('0x7')).replay!.matches, true);
  assert.equal((await replayOn('0x5')).replay!.matches, true);

  // A request previewed on a past block has no transaction of its own to go by: one from the chain's latest blocks
  // is the witness (its sender's nonce at the past block can't be past that transaction's).
  const late = node('0x8'), kept = node('0x7');
  assert.deepEqual([await keepsToBlock(late.rpc, 8453, 90n), await keepsToBlock(kept.rpc, 8453, 90n)], [false, true]);
  assert.deepEqual(late.calls.filter(c => c.method === 'eth_getTransactionCount').map(c => c.params), [[ALICE, '0x5a']]);
  await assert.rejects(pinBlock(late.rpc, 8453, 90n), /answers every read from its latest state/);
  assert.equal((await pinBlock(kept.rpc, 8453, 90n)).at.block, '0x5a');
  const p = await previewRequest({ method: 'eth_sendTransaction', params: [{ from: ALICE, to: USDC, data: transfer, chainId: '0x2105' }] }, { now: NOW, block: 90 }, { ...deps(ran()).deps, rpc: late.rpc });
  assert.equal(p.simulation!.status, 'unavailable');
  assert.match(p.simulation!.error!, /answers every read from its latest state/);
  // The latest block itself has nothing after it to tell by, and needs nothing: its state is the latest. A node that
  // doesn't answer the nonce (one that refuses a past block says so itself) isn't judged here either.
  assert.equal(await keepsToBlock(late.rpc, 8453, 101n), undefined);
  const silent = { has: () => true, call: async () => { throw new Error('HTTP 403'); } };
  assert.equal(await keepsToBlock(silent, 8453, 90n), undefined);
});

test('Where a block’s gas limits add up past its own, a replay’s earlier transactions carry the gas they used', async () => {
  // BNB Chain's transactions are given several times the gas they use, and its node adds the limits of a simulated
  // block's calls up against the block's: the simulators then ask again with less each, sized by what each used
  // (fitGas, in the test below). The replay reads that from the block's receipts, only for such a block.
  const { deps: d, batches, calls } = deps(ran());
  const inner = d.rpc!.call.bind(d.rpc);
  let limit = '0x8f0d180';
  d.rpc!.call = async (c: number, method: string, params: unknown[]) => {
    if (method === 'eth_getBlockReceipts') return TXS.map((t, i) => ({ ...RECEIPT, transactionHash: t.hash, gasUsed: hex(30_000 + i) }));
    const out = await inner(c, method, params);
    return method === 'eth_getBlockByNumber' && params[1] ? { ...(out as object), gasLimit: limit } : out;
  };
  // The block holds 150 million and the transactions up to Alice's were given 1.1 million: nothing more is read.
  await replayTransaction({ chainId: 8453, hash: TXS[3].hash }, { now: NOW }, d);
  assert.deepEqual([batches[0][0].at!.before!.map(r => r.mined), calls.some(c => c.method === 'eth_getBlockReceipts')], [[undefined, undefined], false]);
  // In a block of a million they pass it: each earlier one goes with what its receipt says it used.
  limit = '0xf4240';
  await replayTransaction({ chainId: 8453, hash: TXS[3].hash }, { now: NOW }, d);
  assert.deepEqual(batches[1][0].at!.before!.map(r => [r.gas, r.mined]), [[1_000_000n, { gasUsed: 30_000n }], [21_000n, { gasUsed: 30_002n }]]);
});

test('What chains do their own way: blob transactions, Arbitrum’s header, Polygon’s own logs, a node that refuses single receipts', async () => {
  // A blob transaction's hashes go to the node with EIP-1559 fees (it takes them no other way) at the same price.
  assert.deepEqual(priceFields({ gasPrice: 7n }), { gasPrice: '0x7' });
  assert.deepEqual(priceFields({}), {});
  assert.deepEqual(priceFields({ gasPrice: 7n, blobVersionedHashes: [H(1)], maxFeePerBlobGas: 9n }), { blobVersionedHashes: [H(1)], maxFeePerBlobGas: '0x9', maxFeePerGas: '0x7', maxPriorityFeePerGas: '0x7' });
  // Arbitrum keeps the ArbOS version in the header field other chains use for randomness: it isn't overridden.
  const header = { number: 100n, timestamp: 5n, coinbase: BOB, gasLimit: 1n, baseFeePerGas: 2n, prevRandao: H(1) as `0x${string}` };
  assert.deepEqual(nodeOverrides(header), { time: '0x5', feeRecipient: BOB, prevRandao: H(1), baseFeePerGas: '0x2' });
  assert.deepEqual(nodeOverrides({ ...header, arbBlockNumber: 7n }), { time: '0x5', feeRecipient: BOB, baseFeePerGas: '0x2' });
  // A block in the same second as its parent (BNB Chain's often are) is one no node will simulate: it runs a second
  // later, and says so. Arbitrum's node takes the same second, and so does Base's (most of its blocks share one).
  assert.deepEqual(afterParent(56, header, 5n), { header: { ...header, timestamp: 6n }, shifted: true });
  assert.deepEqual([afterParent(56, header, 4n).shifted, afterParent(56, header, 4n).header, afterParent(42161, header, 5n).shifted, afterParent(8453, header, 5n).shifted, afterParent(10, header, 5n).shifted], [false, header, false, false, true]);
  const sameSecond = chain();
  // (The fixture's blocks, as OP Mainnet's: its node refuses a block at its parent's time.)
  const crowded = { has: () => true, call: async (c: number, method: string, params: unknown[]) => {
    const r = await sameSecond.rpc.call(c, method, params) as Record<string, unknown>;
    return method === 'eth_getBlockByNumber' && params[0] === '0x63' ? { ...r, timestamp: hex(1_762_000_100) } : r;
  } } as unknown as NonNullable<Dependencies['rpc']>;
  const shiftedRuns: SimulationRequest[] = [];
  const late = await replayTransaction({ chainId: 10, hash: TXS[3].hash }, {}, { tokens: new StaticTokenRegistry(), rpc: crowded, simulator: { simulate: async r => { shiftedRuns.push(r); return ran(); } } });
  assert.deepEqual([shiftedRuns[0].at!.header.timestamp, shiftedRuns[0].at!.header.ownTimestamp], [1_762_000_101n, undefined]);
  assert.match(late.decoding.notes.join(' '), /The block shares its second with the one before it, which this chain's node won't simulate: it was run one second later/);
  // Where the node's run, a second late, isn't what the receipt says (the transaction read the time), the local EVM
  // runs it at the block's own time: if that is what happened, it is the run shown, and the preview says so. (In a
  // BNB Chain block of 73 transactions, 10 of 70 replayed needed this.) Only then: the block's earlier transactions
  // still run a second late on the node, and a run at their time is the better match for everything else.
  const localRuns: SimulationRequest[] = [];
  const timed = { simulate: async () => ran({ gasUsed: 60_000n }), trace: async (reqs: SimulationRequest[]) => { localRuns.push(...reqs); return [ran({ source: 'the local EVM' })]; } };
  const own = await replayTransaction({ chainId: 10, hash: TXS[3].hash }, {}, { tokens: new StaticTokenRegistry(), rpc: crowded, simulator: timed });
  assert.deepEqual([own.replay!.matches, own.simulation!.source, own.simulation!.gasUsed, localRuns.length, localRuns[0].at!.header.ownTimestamp], [true, "the local EVM, over the chain's state", '51234', 1, 1_762_000_100n]);
  assert.match(own.decoding.notes.join(' '), /run a second later there, the transaction didn't come out as its receipt says\. The run shown is the local EVM's, at the block's own time\./);
  assert.equal(codes(own).includes('replay_differs'), false);
  // The same wherever the node's run isn't what the receipt says and the local EVM's is: a transaction that failed on
  // a gas limit over Amsterdam's cap used 16,777,216 on the chain and all the gas it was given in the node's
  // simulation. No shifted block here: the local EVM runs the same request.
  const { deps: plain } = deps(ran());
  const burnt: SimulationRequest[] = [];
  const local = await replayTransaction({ chainId: 8453, hash: TXS[3].hash }, {}, { ...plain, simulator: { simulate: async () => ran({ gasUsed: 50_000_000n }), trace: async (reqs: SimulationRequest[]) => { burnt.push(...reqs); return [ran({ source: 'the local EVM' })]; } } });
  assert.deepEqual([local.replay!.matches, local.simulation!.source, local.simulation!.gasUsed, burnt[0].at!.header.ownTimestamp, codes(local).includes('replay_differs')], [true, "the local EVM, over the chain's state", '51234', undefined, false]);
  assert.match(local.decoding.notes.join(' '), /The chain's node ran this transaction differently from its receipt \(the run used 50,000,000 gas where the receipt says 51,234\)\. The run shown is the local EVM's, which is what the receipt says\./);
  // A request not yet mined has no receipt to go by, but one case is known: on a chain whose blocks are Amsterdam's,
  // a gas limit over 16,777,216 leaves the code that much to run on, which the node's simulation doesn't hold to.
  // The local EVM runs such a request too, and where the two differ, its run is shown.
  const amsterdam = { has: () => true, call: async (_c: number, method: string) => (method === 'eth_getBlockByNumber' ? { number: '0x64', timestamp: hex(1_762_000_100), miner: BOB, mixHash: H(1), gasLimit: '0x8f0d180', baseFeePerGas: '0x5e69ec0', blockAccessListHash: H(9), slotNumber: '0x1' } : method === 'eth_feeHistory' ? { baseFeePerBlobGas: ['0x1', '0x1'] } : method === 'eth_getCode' ? '0x' : '0x0') } as unknown as NonNullable<Dependencies['rpc']>;
  const failing = { status: 'reverted' as const, logs: undefined, transfers: [] };
  const over = (gas: bigint, chainId = '0xaa36a7') => previewRequest({ method: 'eth_sendTransaction', params: [{ from: ALICE, to: USDC, data: transfer, gas: hex(gas), chainId }] }, { now: NOW },
    { tokens: new StaticTokenRegistry(), rpc: amsterdam, simulator: { simulate: async () => ran({ ...failing, gasUsed: 50_000_000n }), trace: async () => [ran({ ...failing, gasUsed: 16_777_216n, source: 'local' })] } });
  const capped = await over(70_000_000n);
  assert.deepEqual([capped.simulation!.status, capped.simulation!.gasUsed, capped.simulation!.source], ['reverted', '16777216', "the local EVM, over the chain's state"]);
  assert.match(capped.decoding.notes.join(' '), /The gas limit \(70,000,000\) is over what a transaction has to run on here \(16,777,216\): the rest only pays for new state\. The chain's node doesn't simulate that and its run came out differently, so the run shown is the local EVM's\./);
  // Under the cap, or on a chain that isn't Ethereum's, the node's run stands.
  assert.deepEqual([(await over(500_000n)).simulation!.gasUsed, (await over(70_000_000n, '0x2105')).simulation!.gasUsed], ['50000000', '50000000']);
  // If the local EVM's run isn't what happened either, the node's stays, with what differs.
  const neither = await replayTransaction({ chainId: 10, hash: TXS[3].hash }, {}, { tokens: new StaticTokenRegistry(), rpc: crowded, simulator: { ...timed, trace: async () => [ran({ gasUsed: 70_000n })] } });
  assert.deepEqual([neither.replay!.matches, neither.simulation!.gasUsed, codes(neither).includes('replay_differs')], [false, '60000', true]);
  // Polygon's node logs native transfers and fee payments from 0x…1010; a local EVM has none. Runs are compared without them.
  const fee = { address: '0x0000000000000000000000000000000000001010', topics: ['0x4dfe1bbbcf077ddc3e01291eea2d5c70c2b422b415d95645b9adcfd678cb1d63', pad(ALICE)], data: '0x' };
  assert.deepEqual([chainsOwnLog(fee), chainsOwnLog(LOG), chainsOwnLog({ ...fee, topics: [TRANSFER] })], [true, false, false]);
  assert.equal(sameRun({ status: 'success', logs: [LOG, fee] }, { status: 'success', logs: [LOG] }), true);
  assert.deepEqual(compareWithReceipt(ran(), { status: 'success', gasUsed: 51_234n, logs: [LOG, fee] }), { matches: true });

  // A node that refuses eth_getTransactionReceipt: the block's receipts have it. And a blob transaction: its hashes
  // reach the simulation, and its blob gas is in what it paid.
  const { rpc } = chain();
  const blob = { ...TXS[3], blobVersionedHashes: [H(0x77)], maxFeePerBlobGas: '0x64' };
  const asked: string[] = [];
  const picky = { has: rpc.has.bind(rpc), call: async (c: number, method: string, params: unknown[]) => {
    asked.push(method);
    if (method === 'eth_getTransactionReceipt') throw new Error('eth_getTransactionReceipt: HTTP 403');
    if (method === 'eth_getBlockReceipts') return [{ ...RECEIPT, transactionHash: TXS[3].hash, blobGasUsed: '0x20000', blobGasPrice: '0x3' }];
    if (method === 'eth_getTransactionByHash') return blob;
    return rpc.call(c, method, params);
  } } as unknown as NonNullable<Dependencies['rpc']>;
  const seen: SimulationRequest[] = [];
  const p = await replayTransaction({ chainId: 8453, hash: TXS[3].hash }, {}, { tokens: new StaticTokenRegistry(), rpc: picky, simulator: { simulate: async r => { seen.push(r); return ran(); } } });
  assert.ok(asked.includes('eth_getBlockReceipts'));
  assert.deepEqual([seen[0].blobVersionedHashes, seen[0].maxFeePerBlobGas, p.replay!.matches], [[H(0x77)], 100n, true]);
  // 51,234 gas at 0.1 gwei, the L1 data fee, and 131,072 blob gas at 3 wei.
  assert.equal(p.replay!.receipt.fee, '0.000005133400393216 ETH');

  // The node runs the earlier transactions first and reports only the one asked for.
  const sent: { calls: { from: string; maxFeePerGas?: string; blobVersionedHashes?: string[] }[] }[] = [];
  const fetchImpl = (async (_u: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { params: [{ blockStateCalls: typeof sent }] };
    sent.push(body.params[0].blockStateCalls[0]);
    const calls = body.params[0].blockStateCalls[0].calls.map((_, i) => ({ status: '0x1', gasUsed: `0x${(21_000 + i).toString(16)}`, returnData: '0x', logs: [] }));
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: [{ calls }] }));
  }) as unknown as typeof fetch;
  const at = { block: '0x63', header: { ...header, coinbase: BOB.toLowerCase() }, required: true, before: [{ chainId: 8453, from: BOB.toLowerCase(), to: ALICE, data: '0x', value: 1n, gas: 21_000n, gasPrice: 5n, blobVersionedHashes: [H(2)], maxFeePerBlobGas: 1n }] };
  const [only, ...rest] = (await new RpcSimulator({ 8453: 'http://rpc.invalid' }, { fetchImpl }).simulateBatch([{ chainId: 8453, from: ALICE.toLowerCase(), to: BOB, data: '0x', value: 0n, at }]))!;
  assert.deepEqual([rest.length, only.gasUsed], [0, 21_001n]);
  assert.deepEqual(sent[0].calls.map(c => [c.from, c.maxFeePerGas, c.blobVersionedHashes]), [[BOB.toLowerCase(), '0x5', [H(2)]], [ALICE.toLowerCase(), undefined, undefined]]);

  // BNB Chain's node refuses any call that names blob hashes. Asked again without them (the blob transaction as the
  // plain call it also is, at its price), it runs the block; from then on that chain is plainly that way at once.
  const plainly: { from: string; gasPrice?: string; maxFeePerGas?: string; blobVersionedHashes?: string[]; maxFeePerBlobGas?: string }[][] = [];
  const unbuilding = (async (_u: string, init: { body: string }) => {
    const calls = (JSON.parse(init.body) as { params: [{ blockStateCalls: { calls: (typeof plainly)[number] }[] }] }).params[0].blockStateCalls[0].calls;
    plainly.push(calls);
    if (calls.some(c => c.blobVersionedHashes)) return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'Transaction is not buildable' } }));
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: [{ calls: calls.map((_, i) => ({ status: '0x1', gasUsed: `0x${(21_000 + i).toString(16)}`, returnData: '0x', logs: [] })) }] }));
  }) as unknown as typeof fetch;
  const bnb = new RpcSimulator({ 56: 'http://rpc.invalid' }, { fetchImpl: unbuilding });
  const after = { chainId: 56, from: ALICE.toLowerCase(), to: BOB, data: '0x' as const, value: 0n, at: { ...at, before: at.before.map(b => ({ ...b, chainId: 56 })) } };
  assert.equal((await bnb.simulateBatch([after]))![0].gasUsed, 21_001n);
  assert.deepEqual(plainly.slice(0, 2).map(calls => calls.slice(0, 2).map(c => [c.gasPrice, c.maxFeePerGas, c.blobVersionedHashes, c.maxFeePerBlobGas])), [[[undefined, '0x5', [H(2)], '0x1'], [undefined, undefined, undefined, undefined]], [['0x5', undefined, undefined, undefined], [undefined, undefined, undefined, undefined]]]);
  assert.equal((await bnb.simulateBatch([after]))![0].gasUsed, 21_001n);
  assert.equal(plainly.filter(calls => calls.some(c => c.blobVersionedHashes)).length, 1);
  // A refusal with no blob call in it is the node's answer, not something to ask again about.
  const never = (async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'Transaction is not buildable' } }))) as unknown as typeof fetch;
  await assert.rejects(new RpcSimulator({ 56: 'http://rpc.invalid' }, { fetchImpl: never }).simulateBatch([{ ...after, at: { ...at, before: undefined } }]), /not buildable/);

  // BNB Chain's node also adds up the gas limits of a block's calls, and refuses when they pass the block's (the
  // chain counts the gas used; it takes no higher block limit either). The earlier transactions are asked again on
  // less gas each: what each used, half as much again and 50,000, and a share of the room left.
  const summed: { gas?: string }[][] = [];
  let ranShort = false;
  const adding = (async (_u: string, init: { body: string }) => {
    const calls = (JSON.parse(init.body) as { params: [{ blockStateCalls: { calls: { gas?: string }[] }[] }] }).params[0].blockStateCalls[0].calls;
    summed.push(calls);
    if (calls.reduce((sum, c) => sum + BigInt(c.gas ?? 0), 0n) > 150_000_000n) return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -38015, message: "Block gas limit exceeded by the block's transactions" } }));
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: [{ calls: calls.map((c, i) => ({ status: '0x1', gasUsed: i === 0 && ranShort ? c.gas : '0x186a0', returnData: '0x', logs: [] })) }] }));
  }) as unknown as typeof fetch;
  const earlierTx = (gas: bigint, used?: bigint): SimulationRequest => ({ chainId: 56, from: BOB.toLowerCase(), to: ALICE, data: '0x', value: 0n, gas, gasPrice: 5n, ...(used !== undefined && { mined: { gasUsed: used } }) });
  // Two transactions given 100 million and 50 million that used 100,000 each, then one given 100,000: 150.1 million
  // of limits in a block of 150 million.
  const lateIn = (before: SimulationRequest[]) => ({ chainId: 56, from: ALICE.toLowerCase(), to: BOB, data: '0x' as const, value: 0n, gas: 100_000n, at: { ...at, header: { ...at.header, gasLimit: 150_000_000n }, before } });
  const full = [earlierTx(100_000_000n, 100_000n), earlierTx(50_000_000n, 100_000n)];
  assert.equal((await new RpcSimulator({ 56: 'http://rpc.invalid' }, { fetchImpl: adding }).simulateBatch([lateIn(full)]))![0].status, 'success');
  // Each gets its 200,000 and half the room left (150,000,000 less the last one's 100,000 and their 400,000);
  // the second would pass its own limit, and keeps that.
  assert.deepEqual(summed.slice(0, 2).map(calls => calls.slice(0, 3).map(c => BigInt(c.gas!))), [[100_000_000n, 50_000_000n, 100_000n], [74_950_000n, 50_000_000n, 100_000n]]);
  assert.deepEqual(fitGas(full, 149_900_000n)!.map(r => r.gas), [74_950_000n, 50_000_000n]);
  // What less gas can change is a call running short: one that used nearly all it was given isn't taken on trust.
  ranShort = true;
  await assert.rejects(new RpcSimulator({ 56: 'http://rpc.invalid' }, { fetchImpl: adding }).simulateBatch([lateIn(full)]), /on less gas one of them may have run short/);
  assert.deepEqual([hadRoom(full, fitGas(full, 149_900_000n)!, [{ gasUsed: '0x186a0' }, { gasUsed: '0x2faf080' }]), hadRoom(full, fitGas(full, 149_900_000n)!, [{ gasUsed: '0x47868c0' }, { gasUsed: '0x186a0' }])], [true, false]);
  // Without what the earlier transactions used (their receipts weren't served), or where even that doesn't fit,
  // the node's refusal is said for what it is.
  await assert.rejects(new RpcSimulator({ 56: 'http://rpc.invalid' }, { fetchImpl: adding }).simulateBatch([lateIn([earlierTx(100_000_000n), earlierTx(50_000_000n)])]), /it adds up their gas limits, which pass the block's, where the chain counts the gas they used/);
  assert.equal(fitGas([earlierTx(100_000_000n, 60_000_000n), earlierTx(100_000_000n, 60_000_000n)], 150_000_000n), undefined);

  // A node that takes a past block for an archive request it won't serve: the same plain answer.
  const refusing = (async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Archive requests require a personal token.' } }), { status: 403 })) as unknown as typeof fetch;
  await assert.rejects(new RpcSimulator({ 8453: 'http://rpc.invalid' }, { fetchImpl: refusing }).simulateBatch([{ chainId: 8453, from: ALICE, to: BOB, data: '0x', value: 0n, at: { ...at, before: undefined } }]), /doesn't keep the state of block 99/);

  // A trace the local EVM can't make says why: a contract the chain's node runs itself.
  const native = Object.assign(new Error("0xb200000000000000000000397293cb8cda9a10c5 is a contract this chain's node runs itself (its code is a marker, not EVM code), which the local EVM can't run"), { name: 'ForkUnsupported' });
  const untraced = await replayTransaction({ chainId: 8453, hash: TXS[3].hash }, { trace: true }, { ...deps(ran()).deps, simulator: { simulate: async () => ran(), trace: async () => { throw native; } } });
  assert.equal(untraced.trace, undefined);
  assert.match(untraced.decoding.notes.join(' '), /No trace: 0xb200000000000000000000397293cb8cda9a10c5 is a contract this chain's node runs itself/);
});

test('State the caller sets for a simulation reaches it, is checked, and the preview says so', async () => {
  const send = (context: Record<string, unknown>, d: Dependencies) => previewRequest({ method: 'eth_sendTransaction', params: [{ from: ALICE, to: USDC, data: transfer, chainId: '0x2105' }] }, { now: NOW, ...context }, d);
  const { deps: d, batches } = deps(ran());
  const slot = `0x${'00'.repeat(31)}09`;
  const p = await send({ stateOverrides: { [ALICE.toUpperCase().replace('0X', '0x')]: { balance: '1000000000000000000' }, [USDC]: { stateDiff: { '0x9': '0x2a' }, code: '0x6001' } } }, d);
  // In the form simulators take: lowercase addresses, a hex balance, whole 32-byte slots and values.
  assert.deepEqual(batches[0][0].stateOverrides, { [ALICE.toLowerCase()]: { balance: '0xde0b6b3a7640000' }, [USDC]: { stateDiff: { [slot]: `0x${'00'.repeat(31)}2a` }, code: '0x6001' } });
  assert.ok(batches.every(b => b[0].stateOverrides));
  assert.match(p.warnings.find(w => w.code === 'state_overridden')!.message, /^Simulated with state set by whoever asked for this preview \(balance, code, storage of 2 accounts\), not the chain's own/);
  assert.equal(p.attention, 'caution');
  // Without any: nothing set, nothing said.
  const plain = deps(ran());
  assert.deepEqual([(await send({}, plain.deps)).warnings.some(w => w.code === 'state_overridden'), plain.batches[0][0].stateOverrides], [false, undefined]);
  // A batch: every call carries them, and the batch says so once.
  const many = deps(ran());
  const batch = await previewRequest({ method: 'wallet_sendCalls', params: [{ version: '2.0.0', from: ALICE, chainId: '0x2105', atomicRequired: true, calls: [{ to: USDC, data: transfer }, { to: USDC, data: transfer }] }] }, { now: NOW, stateOverrides: { [ALICE]: { balance: '0x1' } } }, many.deps);
  assert.deepEqual(many.batches[0].map(r => r.stateOverrides), [{ [ALICE.toLowerCase()]: { balance: '0x1' } }, { [ALICE.toLowerCase()]: { balance: '0x1' } }]);
  assert.equal(batch.warnings.filter(w => w.code === 'state_overridden').length, 1);
  // Malformed ones are refused, not ignored.
  for (const [bad, said] of [[{ nope: {} }, /"nope" is not an address/], [{ [ALICE]: { balance: 'lots' } }, /balance must be an amount in wei/], [{ [ALICE]: { nonce: '0x1' } }, /nonce isn't something that can be set/],
    [{ [ALICE]: { code: '0x123' } }, /code must be hex/], [{ [ALICE]: { stateDiff: { '0x1': 'x' } } }, /stateDiff value must be hex/], [[], /must be an object keyed by address/]] as const) {
    await assert.rejects(send({ stateOverrides: bad }, d), (e: Error & { code?: string }) => e.code === 'INVALID_REQUEST' && said.test(e.message));
  }
  // A signature isn't simulated with them, and says so.
  const message = await previewRequest({ method: 'personal_sign', params: ['0x68656c6c6f', ALICE] }, { now: NOW, chainId: 8453, stateOverrides: { [ALICE]: { balance: '0x1' } } }, d);
  assert.match(message.decoding.notes.join(' '), /State overrides \(context\.stateOverrides\) apply to transactions and batches/);
  // Over HTTP: the spec has them, a preview with them matches it, and a malformed one is a 400.
  const Ajv2020 = (Ajv2020Module as unknown as { default?: typeof Ajv2020Module }).default ?? Ajv2020Module;
  const spec = JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8'));
  const ajv = new (Ajv2020 as unknown as new (o: object) => { addSchema(s: object): void; getSchema(k: string): ((d: unknown) => boolean) & { errors?: unknown[] } | undefined })({ strict: false, allErrors: true });
  ajv.addSchema({ ...spec, $id: 'spec2' });
  const matches = (name: string, data: unknown) => { const v = ajv.getSchema(`spec2#/components/schemas/${name}`)!; assert.ok(v(data), `${name}: ${JSON.stringify(v.errors?.slice(0, 3))}`); };
  const server = createPreviewServer({ deps: deps(ran()).deps });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const body = { request: { method: 'eth_sendTransaction', params: [{ from: ALICE, to: USDC, data: transfer, chainId: '0x2105' }] }, context: { stateOverrides: { [ALICE]: { balance: '0x1', stateDiff: { [slot]: '0x1' } } } } };
    matches('PreviewRequest', body);
    const ok = await fetch(`${base}/v1/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const preview = await ok.json() as { warnings: { code: string }[] };
    matches('Preview', preview);
    assert.deepEqual([ok.status, preview.warnings.some(w => w.code === 'state_overridden')], [200, true]);
    const refused = await fetch(`${base}/v1/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, context: { stateOverrides: { [ALICE]: { balance: -1 } } } }) });
    assert.equal(refused.status, 400);
  } finally { await new Promise(r => server.close(r)); }
});

test('A trace says when the local EVM’s gas, or its rules, aren’t the chain’s', async () => {
  const root: TraceCall = { type: 'call', from: ALICE.toLowerCase(), to: USDC, input: transfer, value: 0n, gas: 100_000n, gasUsed: 30_000n, output: pad('0x01'), logs: [{ index: 0, ...LOG }] };
  const traced = async (chainId: string, local: Partial<SimulationResult>, node: Partial<SimulationResult> = {}) => (await previewRequest({ method: 'eth_sendTransaction', params: [{ from: ALICE, to: USDC, data: transfer, chainId }] }, { now: NOW, trace: true },
    { tokens: new StaticTokenRegistry(), simulator: { simulate: async () => ran(node), trace: async () => [{ ...ran({ source: 'local' }), trace: root, stateChanges: [], ...local }] } })).trace!;
  // The same run, the same gas: nothing to say.
  const same = await traced('0x2105', {});
  assert.deepEqual([same.agrees, same.gasAgrees, same.note], [true, true, undefined]);
  // The same outcome and events on different gas: the local EVM's gas rules aren't the chain's here.
  const off = await traced('0x2105', { gasUsed: 51_000n });
  assert.deepEqual([off.agrees, off.gasAgrees], [true, false]);
  assert.equal(off.note, "The traced run used 51,000 gas where the simulation shown above used 51,234: the local EVM's gas rules differ from this chain's here, so the gas figures in the trace are approximate.");
  // Not compared: Arbitrum (its node adds a charge for L1 data), a failed call (it burns each simulator's own limit), runs that differ anyway.
  assert.deepEqual([(await traced('0xa4b1', { gasUsed: 51_000n })).gasAgrees, (await traced('0xa4b1', { gasUsed: 51_000n })).note], [undefined, undefined]);
  const failed = { status: 'reverted' as const, logs: undefined, transfers: [] };
  assert.equal((await traced('0x2105', { ...failed, gasUsed: 30_000_000n }, { ...failed, gasUsed: 50_000_000n })).gasAgrees, undefined);
  assert.deepEqual([(await traced('0x2105', { logs: [], gasUsed: 1n })).agrees, (await traced('0x2105', { logs: [], gasUsed: 1n })).gasAgrees], [false, undefined]);
  // Rules the local EVM wasn't checked against: its note is the trace's.
  const moved = await traced('0x2105', { rulesNote: "Base's rules changed on 2026-12-08 since the local EVM here was last checked against the chain (2026-11-10), so its run may differ from the chain's, in gas above all." });
  assert.match(moved.note!, /^Base's rules changed on 2026-12-08 since the local EVM here was last checked/);
  // The spec has the field.
  const Ajv2020 = (Ajv2020Module as unknown as { default?: typeof Ajv2020Module }).default ?? Ajv2020Module;
  const spec = JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8'));
  const ajv = new (Ajv2020 as unknown as new (o: object) => { addSchema(s: object): void; getSchema(k: string): ((d: unknown) => boolean) & { errors?: unknown[] } | undefined })({ strict: false, allErrors: true });
  ajv.addSchema({ ...spec, $id: 'spec3' });
  const check = ajv.getSchema('spec3#/components/schemas/PreviewTrace')!;
  assert.ok(check(JSON.parse(JSON.stringify(off))), JSON.stringify(check.errors?.slice(0, 3)));
});

test('Glamsterdam, as a preview sees it: the chain’s own transfer log is the native coin, and a header says which rules its block runs', async () => {
  // EIP-7708: a chain that logs its native transfers itself does so from an address of its own, as ERC-20 Transfer
  // events. They are the native coin moving, never a token at that address.
  const native = { address: NATIVE_LOG_ADDRESS, topics: [TRANSFER, pad(ALICE), pad(BOB)], data: pad(hex(10n ** 18n)) };
  assert.deepEqual(parseLogs([native, LOG]).transfers.map(t => [t.asset, t.raw]), [['native', 10n ** 18n], [USDC, 200_000_000n]]);
  // A node that also adds the pseudo-log traceTransfers asks for would count the transfer twice: the chain's own is kept.
  const pseudo = { ...native, address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' };
  assert.deepEqual(parseLogs([pseudo, native]).transfers.map(t => [t.asset, t.raw]), [['native', 10n ** 18n]]);
  assert.deepEqual(parseLogs([pseudo]).transfers.map(t => [t.asset, t.raw]), [['native', 10n ** 18n]]);
  // Through a preview: sending 1 ETH on such a chain shows 1 ETH leaving, not a token called by an address.
  const send = await previewRequest({ method: 'eth_sendTransaction', params: [{ from: ALICE, to: BOB, value: hex(10n ** 18n), chainId: '0xaa36a7' }] }, { now: NOW },
    { tokens: new StaticTokenRegistry(), simulator: { simulate: async () => ({ status: 'success', source: 'a test', gasUsed: 21_000n, ...parseLogs([native]), logs: [native] }) } });
  assert.deepEqual(send.assetChanges.map(c => [c.direction, c.amount, c.symbol, c.asset]), [['out', '1', 'ETH', 'native']]);
  assert.equal(send.warnings.length, 0);

  // A header from Amsterdam on carries a block access list hash and a slot number: the block after it runs
  // Amsterdam's rules, in the next slot; a block replayed as it was, in its own.
  const h = { number: '0x64', timestamp: '0x3e8', miner: BOB, mixHash: H(1), gasLimit: '0xbebc200', baseFeePerGas: '0x7' };
  const glam = { ...h, blockAccessListHash: H(9), slotNumber: '0xb046bd' };
  assert.deepEqual([headerAfter(1, glam).amsterdam, headerAfter(1, glam).slotNumber, headerOf(1, glam).slotNumber], [true, 11_552_446n, 11_552_445n]);
  assert.deepEqual([headerAfter(1, h).amsterdam, headerAfter(1, h).slotNumber, headerOf(1, h).amsterdam], [undefined, undefined, undefined]);
  // Polygon's blocks name no miner, and COINBASE there is one fixed address in every block.
  assert.deepEqual([headerAfter(137, { ...h, miner: `0x${'00'.repeat(20)}` }).coinbase, headerOf(137, h).coinbase, headerAfter(1, h).coinbase], ['0x7ee41d8a25641000661b1ef5e6ae8a00400466b0', '0x7ee41d8a25641000661b1ef5e6ae8a00400466b0', BOB.toLowerCase()]);

  // A node's allowance for one simulation can run out on a block's earlier transactions (Sepolia's blocks hold 200
  // million gas): said as that, not as this transaction's gas limit being too low.
  const exhausted = (async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -38013, message: 'intrinsic gas too low' } }))) as unknown as typeof fetch;
  const header = { number: 100n, timestamp: 5n, coinbase: BOB.toLowerCase(), gasLimit: 1n, baseFeePerGas: 2n, prevRandao: H(1) as `0x${string}` };
  const request = { chainId: 8453, from: ALICE.toLowerCase(), to: BOB, data: '0x', value: 0n };
  await assert.rejects(new RpcSimulator({ 8453: 'http://rpc.invalid' }, { fetchImpl: exhausted }).simulateBatch([{ ...request, at: { block: '0x63', header, required: true, before: [request, request] } }]),
    /the chain's node couldn't run the 2 transactions before this one in its block within its gas allowance for one simulation \(intrinsic gas too low\)/);
  // Alone, the same error is the transaction's own: the network would refuse it too.
  const [alone] = (await new RpcSimulator({ 8453: 'http://rpc.invalid' }, { fetchImpl: exhausted }).simulateBatch([request]))!;
  assert.match(alone.revertReason!, /the gas limit is below the minimum/);
});

test('From Glamsterdam on, a replay starts from what the block’s access list says came before it, with nothing run first', async () => {
  // A block's access list (EIP-7928), as Sepolia's node serves it: each account the block touched, with every
  // change to its balance, nonce, code and storage and the entry that made it. Entry 0 is the block's own calls
  // before its transactions; entry i + 1 is transaction i.
  const HISTORY = '0x0000F90827F1C53a10cb7A02335B175320002935', DELEGATE = `0xef0100${'ab'.repeat(20)}`;
  const list = [
    { address: HISTORY, balanceChanges: [], codeChanges: [], nonceChanges: [], storageChanges: [{ key: '0xaeb', changes: [{ index: '0x0', value: H(0x1023) }] }], storageReads: [] },
    {
      address: BOB, storageReads: ['0x5'],
      balanceChanges: [{ index: '0x1', value: '0x10' }, { index: '0x3', value: '0x20' }, { index: '0x5', value: '0x30' }],
      nonceChanges: [{ index: '0x1', value: '0x8' }, { index: '0x5', value: '0x9' }],
      codeChanges: [{ index: '0x2', code: DELEGATE }, { index: '0x5', code: '0x' }],
      storageChanges: [{ key: '0x1', changes: [{ index: '0x2', value: '0x7' }, { index: '0x3', value: '0x0' }, { index: '0x4', value: '0x9' }] }, { key: '0x2', changes: [{ index: '0x5', value: '0x1' }] }],
    },
    // Changed by the fourth transaction itself (entry 4) and after: no part of what it met.
    { address: ALICE, balanceChanges: [{ index: '0x4', value: '0x1' }], codeChanges: [], nonceChanges: [{ index: '0x4', value: '0x8' }], storageChanges: [], storageReads: [] },
  ];
  const serving = (answer: () => unknown) => { const asked: unknown[][] = []; return { asked, client: { has: () => true, call: async (_c: number, method: string, params: unknown[]) => { asked.push([method, ...params]); return answer(); } } }; };
  const node = serving(() => list);
  // What the fourth transaction (index 3) met: each item's last change among entries 0 to 3. A slot cleared is zero.
  const met = { [HISTORY.toLowerCase()]: { stateDiff: { [H(0xaeb)]: H(0x1023) } }, [BOB.toLowerCase()]: { balance: '0x20', nonce: '0x8', code: DELEGATE, stateDiff: { [H(1)]: H(0) } } };
  assert.deepEqual(await stateBefore(node.client, 11155111, '0x64', 3), met);
  assert.deepEqual(node.asked, [['eth_getBlockAccessListByBlockNumber', '0x64']]);
  // The block's first transaction met only what the block itself did first; its last, everything before it.
  assert.deepEqual(await stateBefore(node.client, 11155111, '0x64', 0), { [HISTORY.toLowerCase()]: { stateDiff: { [H(0xaeb)]: H(0x1023) } } });
  assert.deepEqual((await stateBefore(node.client, 11155111, '0x64', 5))![BOB.toLowerCase()], { balance: '0x30', nonce: '0x9', code: '0x', stateDiff: { [H(1)]: H(9), [H(2)]: H(1) } });
  // A node without the method (some of the backends behind Sepolia's public RPC) is asked six times, then the
  // caller runs the earlier transactions instead; so too for an answer that doesn't read as a list of changes.
  const without = serving(() => { throw new Error('the method eth_getBlockAccessListByBlockNumber does not exist/is not available'); });
  assert.deepEqual([await stateBefore(without.client, 11155111, '0x64', 3), without.asked.length], [undefined, 6]);
  assert.equal(await stateBefore(serving(() => [{ address: BOB, balanceChanges: [{ txIndex: '0x1', value: '0x10' }], nonceChanges: [], codeChanges: [], storageChanges: [] }]).client, 11155111, '0x64', 3), undefined);

  // A replay in such a block: the state is read, the two transactions before it aren't run, and the note says so.
  const { deps: d, batches, calls } = deps(ran());
  const glam = (answer: () => unknown): Dependencies => ({ ...d, rpc: { has: d.rpc!.has, call: async (c: number, method: string, params: unknown[]) => {
    if (method === 'eth_getBlockAccessListByBlockNumber') { calls.push({ method, params }); return answer(); }
    const out = await d.rpc!.call(c, method, params);
    return method === 'eth_getBlockByNumber' && out ? { ...out as object, blockAccessListHash: H(9), slotNumber: '0xb046bd' } : out;
  } } as Dependencies['rpc'] });
  const p = await replayTransaction({ chainId: 8453, hash: TXS[3].hash }, {}, glam(() => list));
  const target = batches[0][0];
  assert.deepEqual([target.at!.state, target.at!.before, target.at!.block, target.at!.header.amsterdam], [met, [], '0x63', true]);
  assert.deepEqual(calls.filter(c => c.method === 'eth_getBlockAccessListByBlockNumber').map(c => c.params), [['0x64']]);
  assert.equal(p.replay!.matches, true);
  assert.match(p.decoding.notes.join(' '), /after the 2 transactions before it in the block \(the state they left read from the block's access list\), at the price it paid/);
  // Where the node doesn't serve the list, they are run first, as before Glamsterdam.
  await replayTransaction({ chainId: 8453, hash: TXS[3].hash }, {}, glam(() => { throw new Error('Method not found'); }));
  assert.deepEqual([batches[1][0].at!.state, batches[1][0].at!.before!.length], [undefined, 2]);

  // The node's simulation is given that state as overrides of the parent block's, beneath the request's own, and
  // runs the one call.
  const sent: { calls: unknown[]; stateOverrides?: Record<string, unknown> }[] = [];
  const fetchImpl = (async (_u: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { params: [{ blockStateCalls: typeof sent }] };
    sent.push(body.params[0].blockStateCalls[0]);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: [{ calls: [{ status: '0x1', gasUsed: '0x5208', returnData: '0x', logs: [] }] }] }));
  }) as unknown as typeof fetch;
  const bob = BOB.toLowerCase();
  await new RpcSimulator({ 8453: 'http://rpc.invalid' }, { fetchImpl }).simulateBatch([{ chainId: 8453, from: ALICE.toLowerCase(), to: BOB, data: '0x', value: 0n, at: { ...target.at!, state: met }, stateOverrides: { [bob]: { balance: '0x99', stateDiff: { [H(3)]: H(4) } } } }]);
  assert.equal(sent[0].calls.length, 1);
  assert.deepEqual(sent[0].stateOverrides, { [HISTORY.toLowerCase()]: met[HISTORY.toLowerCase()], [bob]: { balance: '0x99', nonce: '0x8', code: DELEGATE, stateDiff: { [H(1)]: H(0), [H(3)]: H(4) } } });
});

test('A replay’s trace is checked against what the block’s access list says the transaction changed', async () => {
  const sender = ALICE.toLowerCase(), coinbase = BOB.toLowerCase(), MADE = '0x00000000000000000000000000000000000c0de1';
  // The list's entry for a transaction: two of the token's slots, the sender's balance (less the 21 it paid in
  // fees) and its nonce, the fee recipient's balance (with its tip of 5), and a contract made.
  const recorded = { changes: { [USDC]: { stateDiff: { [H(1)]: H(50), [H(2)]: H(0) } }, [sender]: { balance: hex(900 - 21), nonce: '0x8' }, [coinbase]: { balance: hex(1_005) }, [MADE]: { nonce: '0x1', code: '0x6000' } }, sender, nonce: 7n, coinbase, fee: 21n, tip: 5n };
  // What the traced call changed: the same slots, the 100 wei the sender sent, the contract. A traced call pays no
  // fee and bumps no sender's nonce: those are the transaction's, and are put back or checked apart.
  const changes = [
    { address: USDC, storage: [{ slot: H(1), before: H(0), after: H(50) }, { slot: H(2), before: H(9), after: H(0) }] },
    { address: sender, balance: { before: 1_000n, after: 900n } },
    { address: MADE, nonce: { before: 0n, after: 1n }, code: true },
  ];
  assert.deepEqual(compareWithAccessList(changes, recorded), { agrees: true, compared: 7 });
  // A call that fails changes nothing: the list has the fee and the nonce alone.
  assert.equal(compareWithAccessList(undefined, { ...recorded, changes: { [sender]: { balance: hex(979), nonce: '0x8' }, [coinbase]: { balance: hex(1_005) } } }).agrees, true);
  // What differs is said: a slot with another value, one only the trace writes, a balance, code, the sender's nonce.
  const off = compareWithAccessList([{ address: USDC, storage: [{ slot: H(1), before: H(0), after: H(51) }, { slot: H(2), before: H(9), after: H(0) }, { slot: H(3), before: H(0), after: H(1) }] }, { address: sender, balance: { before: 1_000n, after: 901n } }],
    { ...recorded, changes: { ...recorded.changes, [sender]: { balance: hex(879), nonce: '0x9' } } });
  assert.deepEqual(off.differences, [
    "the sender's nonce is 9 in the list, 8 after this transaction",
    `${USDC} slot 0x1 is 0x32 in the list, 0x33 in the trace`,
    `${USDC} slot 0x3 changes in the trace and not in the list`,
    `${MADE}'s nonce is 1 in the list and unchanged in the trace`,
    `${sender}'s balance is 900 in the list, 901 in the trace`,
    `${MADE}'s code changes in the list and not in the trace`,
  ]);

  // Through a replay: the block's list has the transaction's own entry (the fourth transaction's is entry 4), the
  // local EVM's traced run is checked against it, and the trace and the preview say how it came out.
  const list = [
    { address: USDC, balanceChanges: [], codeChanges: [], nonceChanges: [], storageChanges: [{ key: '0x1', changes: [{ index: '0x4', value: '0x32' }] }], storageReads: [] },
    { address: ALICE, balanceChanges: [{ index: '0x4', value: '0x10' }], codeChanges: [], nonceChanges: [{ index: '0x4', value: '0x8' }], storageChanges: [], storageReads: [] },
  ];
  const root: TraceCall = { type: 'call', from: sender, to: USDC, input: transfer, value: 0n, gas: 100_000n, gasUsed: 30_000n, output: pad('0x01'), logs: [{ index: 0, ...LOG }] };
  const { deps: d } = deps(ran());
  const replayed = async (slot: string) => {
    const rpc = { has: d.rpc!.has, call: async (c: number, method: string, params: unknown[]) => {
      if (method === 'eth_getBlockAccessListByBlockNumber') return list;
      const out = await d.rpc!.call(c, method, params);
      return method === 'eth_getBlockByNumber' && out ? { ...out as object, blockAccessListHash: H(9), slotNumber: '0xb046bd' } : out;
    } } as Dependencies['rpc'];
    const simulator = { simulate: async () => ran(), trace: async () => [{ ...ran({ source: 'local' }), trace: root, stateChanges: [{ address: USDC, storage: [{ slot: H(1), before: H(0), after: slot }] }] }] };
    return replayTransaction({ chainId: 8453, hash: TXS[3].hash }, { trace: true }, { ...d, rpc, simulator });
  };
  const good = await replayed(H(50));
  assert.deepEqual([good.trace!.stateAgrees, good.trace!.note], [true, undefined]);
  assert.match(good.decoding.notes.join(' '), /The state the trace shows changing is what the block's access list records for this transaction: every storage slot, balance, nonce and code\./);
  const bad = await replayed(H(51));
  assert.equal(bad.trace!.stateAgrees, false);
  assert.equal(bad.trace!.note, `The state the traced run changed isn't what the block's access list records for this transaction (${USDC} slot 0x1 is 0x32 in the list, 0x33 in the trace): the trace is a guide to what it did, not its record.`);
  // The next block's blob base fee, which a local run needs to agree with the node's: from eth_feeHistory, and
  // where a backend doesn't answer that, from BLOBBASEFEE run in a block the node simulates after it.
  const fees = (history: () => unknown) => ({ has: () => true, call: async (_c: number, method: string) => {
    if (method === 'eth_feeHistory') return history();
    return [{ calls: [{ status: '0x1', returnData: H(2) }] }];
  } });
  assert.deepEqual([await blobBaseFeeAfter(fees(() => ({ baseFeePerBlobGas: ['0x1', '0x3'] })), 1, '0x64'), await blobBaseFeeAfter(fees(() => { throw new Error('method not available'); }), 1, '0x64'), await blobBaseFeeAfter(fees(() => ({})), 1, '0x64')], [3n, 2n, 2n]);
  // A chain without blobs has none.
  assert.equal(await blobBaseFeeAfter(fees(() => ({ baseFeePerBlobGas: ['0x1', '0x3'] })), 137, '0x64'), undefined);
  // A block without a list (before Amsterdam) has nothing to check against: the field is absent.
  const before = await replayTransaction({ chainId: 8453, hash: TXS[3].hash }, { trace: true }, { ...d, simulator: { simulate: async () => ran(), trace: async () => [{ ...ran({ source: 'local' }), trace: root, stateChanges: [] }] } });
  assert.equal(before.trace!.stateAgrees, undefined);
});
