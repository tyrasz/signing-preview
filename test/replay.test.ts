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
import { nodeOverrides, parseBlock, pinBlock, priceFields } from '../src/block.ts';
import { chainsOwnLog, sameRun } from '../src/evm/trace.ts';
import { previewRequest } from '../src/preview.ts';
import { createPreviewServer } from '../src/server.ts';
import { parseLogs, RpcSimulator } from '../src/simulation.ts';
import { builtinTokens, StaticTokenRegistry } from '../src/chains.ts';
import { CHAINLINK_FEEDS, ChainlinkPrices } from '../src/prices.ts';
import type { Dependencies, SimulationRequest, SimulationResult } from '../src/types.ts';
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
  assert.equal(calls.some(c => c.method === 'eth_getTransactionCount' || c.method === 'eth_getBalance' || c.method === 'eth_maxPriorityFeePerGas'), false);
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
  // The chain's latest block: the block after it doesn't exist yet, so its header is the one that would follow.
  const latest = deps(ran());
  await send({ block: '0x65' }, latest.deps);
  assert.deepEqual([latest.batches[0][0].at!.block, latest.batches[0][0].at!.header.number, latest.batches[0][0].at!.header.timestamp], ['0x65', 102n, 1_762_000_103n]);
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
  // Named only so that a trace matches (no block asked for): the latest block answers instead, as before.
  tags.length = 0;
  const traced = await previewRequest({ method: 'eth_sendTransaction', params: [{ from: ALICE, to: USDC, data: transfer, chainId: '0x2105' }] }, { now: NOW, trace: true }, { tokens: new StaticTokenRegistry(), rpc, simulator });
  assert.equal(traced.simulation!.status, 'unavailable');
  assert.ok(tags.includes('latest'));
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
