import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, encodeFunctionData, maxUint256, parseAbi } from 'viem';
import { previewRequest } from '../src/preview.ts';
import { StaticTokenRegistry } from '../src/chains.ts';
import { RpcSimulator } from '../src/simulation.ts';
import type { Dependencies, SimulationRequest, SimulationResult, Simulator } from '../src/types.ts';
import { ALICE, ROUTER } from '../mocks/data.ts';
import { codes, NOW, sample } from './helpers.ts';

const USDC = '0xaf88d065e77c8cc2239327c5edb3a432268e5831', WETH = '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', USDT = '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9';
const ERC20 = parseAbi(['function approve(address,uint256)', 'function transfer(address,uint256)']);
const approve = (spender: string, amount: bigint) => ({ to: USDC, data: encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [spender as `0x${string}`, amount] }) });
// A router call the previewer doesn't decode: the simulation is the only source of balance changes.
const swap = (tag: string) => ({ to: ROUTER, data: ('0xdeadbeef' + tag.padStart(64, '0')) as `0x${string}` });

/**
 * A tiny in-memory chain: the router pulls 100 USDC (needs the approval) and pays out WETH; a second router call
 * swaps that WETH into USDT. It implements both one-at-a-time and in-order simulation, like RpcSimulator.
 */
function fakeChain(options: { batch?: boolean } = {}): Simulator & { batchCalls: number } {
  const run = (reqs: SimulationRequest[]): SimulationResult[] => {
    let allowance = 0n, weth = 0n;
    return reqs.map(req => {
      const ok = (transfers: SimulationResult['transfers']): SimulationResult => ({ status: 'success', source: 'fake', gasUsed: 50_000n, transfers });
      if (req.to === USDC && req.data.startsWith('0x095ea7b3')) { allowance = BigInt('0x' + req.data.slice(74)); return ok([]); }
      if (req.to === ROUTER && req.data.endsWith('1')) {
        if (allowance < 100_000_000n) return { status: 'reverted', source: 'fake', gasUsed: 30_000n, revertReason: 'ERC20: transfer amount exceeds allowance', transfers: [] };
        allowance -= 100_000_000n; weth += 10n ** 16n;
        return ok([{ asset: USDC, from: ALICE, to: ROUTER, raw: 100_000_000n }, { asset: WETH, from: ROUTER, to: ALICE, raw: 10n ** 16n }]);
      }
      if (req.to === ROUTER && req.data.endsWith('2')) {
        if (weth < 10n ** 16n) return { status: 'reverted', source: 'fake', gasUsed: 30_000n, revertReason: 'insufficient WETH', transfers: [] };
        return ok([{ asset: WETH, from: ALICE, to: ROUTER, raw: 10n ** 16n }, { asset: USDT, from: ROUTER, to: ALICE, raw: 45_000_000n }]);
      }
      return ok([]);
    });
  };
  const sim = {
    batchCalls: 0,
    simulate: async (req: SimulationRequest) => run([req])[0],
    ...(options.batch !== false && { simulateBatch: async (reqs: SimulationRequest[]) => { sim.batchCalls++; return run(reqs); } }),
  };
  return sim;
}
const deps = (simulator: Simulator): Dependencies => ({ tokens: new StaticTokenRegistry(), simulator });
const sendCalls = (calls: unknown[], extra: Record<string, unknown> = {}) => ({ method: 'wallet_sendCalls', params: [{ version: '2.0.0', chainId: '0xa4b1', from: ALICE, calls, ...extra }] });

test('Batches are simulated in order: approve then swap is not shown as failing', async () => {
  const chain = fakeChain();
  // Simulated on its own, the swap really does fail: that is what previews used to show for call 2.
  assert.equal((await chain.simulate({ chainId: 42161, from: ALICE, to: ROUTER, data: swap('1').data, value: 0n }))?.status, 'reverted');

  const p = await previewRequest(sendCalls([approve(ROUTER, 100_000_000n), swap('1')], { atomicRequired: true }), { now: NOW }, deps(chain));
  assert.equal(chain.batchCalls, 1, 'one in-order simulation for the whole batch');
  assert.ok(!codes(p).includes('simulation_reverted'));
  assert.equal(p.calls?.[1].simulation?.status, 'success');
  assert.equal(p.simulation?.status, 'success');
  assert.equal(p.simulation?.gasUsed, '100000');
  assert.deepEqual(p.assetChanges.map(c => [c.direction, c.amount, c.symbol, c.basis]), [['out', '100', 'USDC', 'simulated_events'], ['in', '0.01', 'WETH', 'simulated_events']]);
  assert.match(p.summary, /in order, all or nothing/);
  assert.ok(p.decoding.notes.some(n => /simulated in order/.test(n)));
});

test('Batch balance changes are netted across calls, so intermediate tokens cancel out', async () => {
  const p = await previewRequest(sendCalls([approve(ROUTER, 100_000_000n), swap('1'), swap('2')]), { now: NOW }, deps(fakeChain()));
  assert.deepEqual(p.assetChanges.map(c => [c.direction, c.amount, c.symbol]), [['out', '100', 'USDC'], ['in', '45', 'USDT']]);
  // Each call still shows its own effect.
  assert.deepEqual(p.calls?.[2].assetChanges.map(c => [c.direction, c.symbol]), [['out', 'WETH'], ['in', 'USDT']]);
});

test('A failing call: all-or-nothing batches fail entirely; other batches may go through partly', async () => {
  const tooSmall = approve(ROUTER, 1n); // not enough for the swap
  const atomic = await previewRequest(sendCalls([tooSmall, swap('1')], { atomicRequired: true }), { now: NOW }, deps(fakeChain()));
  assert.equal(atomic.attention, 'danger');
  assert.match(atomic.warnings.find(w => w.code === 'batch_will_fail')!.message, /call 2 is expected to fail, so none of the calls would take effect/);
  assert.equal(atomic.simulation?.status, 'reverted');
  assert.equal(atomic.simulation?.revertReason, 'call 2: ERC20: transfer amount exceeds allowance');
  assert.ok(codes(atomic).includes('simulation_reverted'));

  const loose = await previewRequest(sendCalls([tooSmall, swap('1')]), { now: NOW }, deps(fakeChain()));
  assert.ok(codes(loose).includes('batch_partial_failure'));
  assert.ok(!codes(loose).includes('batch_will_fail'));
});

test('A simulator that can only run one call at a time simulates call 1 only, instead of reporting false failures', async () => {
  const p = await previewRequest(sendCalls([approve(ROUTER, maxUint256), swap('1')]), { now: NOW }, deps(fakeChain({ batch: false })));
  assert.equal(p.calls?.[0].simulation?.status, 'success');
  assert.equal(p.calls?.[1].simulation?.status, 'unavailable');
  assert.ok(!codes(p).includes('simulation_reverted'));
  assert.match(p.warnings.find(w => w.code === 'simulation_skipped')!.message, /^Call 2: This call was not simulated: it may depend on the calls before it/);
});

test('A batch simulation failure marks every call unavailable', async () => {
  const broken: Simulator = { simulate: async () => null, simulateBatch: async () => { throw new Error('RPC HTTP 503'); } };
  const p = await previewRequest(sendCalls([approve(ROUTER, 1n), swap('1')]), { now: NOW }, deps(broken));
  assert.deepEqual(p.calls?.map(c => c.simulation?.status), ['unavailable', 'unavailable']);
  assert.equal(p.simulation, undefined);
});

test('RpcSimulator runs a batch as consecutive calls in one eth_simulateV1 block', async () => {
  let sent: { method: string; params: [{ blockStateCalls: { calls: { to: string }[] }[] }] } | undefined;
  const revert = encodeAbiParameters([{ type: 'string' }], ['Hook data is empty']);
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    sent ??= JSON.parse(String(init.body)); // the simulation itself (a second request reads balances back)
    return new Response(JSON.stringify({ result: [{ calls: [
      { status: '0x1', gasUsed: '0xb44b', returnData: '0x', logs: [] },
      { status: '0x0', gasUsed: '0x7a12', returnData: '0x08c379a0' + revert.slice(2), logs: [] },
    ] }] }));
  }) as typeof fetch;
  const results = await new RpcSimulator({ 42161: 'http://rpc.invalid' }, { fetchImpl }).simulateBatch([
    { chainId: 42161, from: ALICE, to: USDC, data: approve(ROUTER, 1n).data, value: 0n },
    { chainId: 42161, from: ALICE, to: ROUTER, data: swap('1').data, value: 0n },
  ]);
  assert.equal(sent?.method, 'eth_simulateV1');
  assert.equal(sent?.params[0].blockStateCalls.length, 1, 'one block, so state carries over between calls');
  assert.deepEqual(sent?.params[0].blockStateCalls[0].calls.map(c => c.to), [USDC, ROUTER.toLowerCase()]);
  assert.deepEqual(results?.map(r => r.status), ['success', 'reverted']);
  assert.equal(results?.[1].revertReason, 'Hook data is empty');
  await assert.rejects(new RpcSimulator({ 1: 'x', 42161: 'y' }).simulateBatch([{ chainId: 1, from: ALICE, to: USDC, data: '0x', value: 0n }, { chainId: 42161, from: ALICE, to: USDC, data: '0x', value: 0n }]), /one chain/);
});

test('The demo batch (approve + Bridge2 deposit) shows the simulated 20 USDC deposit', async () => {
  const p = await sample('arb-batch');
  assert.equal(p.simulation?.status, 'success');
  assert.deepEqual(p.assetChanges.map(c => [c.direction, c.amount, c.symbol, c.basis]), [['out', '20', 'USDC', 'simulated_events']]);
  assert.ok(codes(p).includes('unlimited_approval'));
});
