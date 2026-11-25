import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, encodeFunctionData, maxUint256, parseAbi } from 'viem';
import { previewRequest } from '../src/preview.ts';
import { StaticTokenRegistry } from '../src/chains.ts';
import { faultReason, RpcSimulator } from '../src/simulation.ts';
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

test('A call that uses up all the gas it is given leaves the calls after it none: the batch is run again with a limit for each', async () => {
  // Tether's USDT fails a transfer of more than is held on an invalid opcode (an assert of its day), which takes all
  // the gas the call has: with no limit of its own, all the node allows one simulation (50 million on geth and reth).
  // The next call then has none, and the node refuses the request: two such transfers were "could not be simulated".
  const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7', asked: (string | null)[][] = [];
  type Call = { to?: string; gas?: string };
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { method: string; params: [{ blockStateCalls: { calls: Call[]; stateOverrides?: Record<string, { code?: string }> }[] }] };
    if (body.method !== 'eth_simulateV1') return new Response(JSON.stringify({ result: '0x' }));
    const calls = body.params[0].blockStateCalls[0].calls, mine = calls.filter(c => c.to === USDT);
    // (What the node allows one simulation: its answer to a call that never ends.)
    if (!mine.length && calls.length === 1) return new Response(JSON.stringify({ result: [{ calls: [{ status: '0x0', gasUsed: '0x2faf080', returnData: '0x', error: { message: 'out of gas: gas required exceeds: 50000000' } }] }] }));
    asked.push(mine.map(c => c.gas ?? null));
    if (mine.some(c => c.gas === undefined)) return new Response(JSON.stringify({ error: { code: -32000, message: 'intrinsic gas too low' } }));
    let first = true;
    return new Response(JSON.stringify({ result: [{ calls: calls.map(c => {
      if (c.to !== USDT) return { status: '0x1', gasUsed: '0x5208', returnData: `0x${'00'.repeat(32)}`, logs: [] };
      if (first) { first = false; return { status: '0x0', gasUsed: c.gas, returnData: '0x', error: { message: 'EVM error: InvalidFEOpcode' } }; }
      return { status: '0x1', gasUsed: '0xa410', returnData: '0x', logs: [] };
    }) }] }));
  }) as typeof fetch;
  const transfer = `0xa9059cbb${'b0b'.padStart(64, '0')}${'1'.padStart(64, '0')}`;
  const request = { chainId: 1, from: ALICE, to: USDT, data: transfer as `0x${string}`, value: 0n };
  const results = await new RpcSimulator({ 1: 'http://rpc.invalid' }, { fetchImpl }).simulateBatch([request, request]);
  assert.deepEqual(results?.map(r => r.status), ['reverted', 'success']);
  // Each call on no more than a transaction may have there (16,777,216), which two fit in what the node allows.
  assert.deepEqual(asked[0], [null, null]);
  assert.deepEqual(asked[1], ['0x1000000', '0x1000000']);
  assert.match(results![0].revertReason ?? '', /^the contract stopped on a failed check of its own \(an invalid opcode, an older contract's assert: it gives no reason, and takes all the gas the call was given\)$/);
  // (Only the INVALID opcode, as each node words it: an opcode the chain doesn't have is another matter.)
  assert.deepEqual(['invalid opcode: INVALID', 'EVM error: InvalidFEOpcode', 'invalid opcode: opcode 0xfe not defined'].map(m => /failed check of its own/.test(faultReason(m)!)), [true, true, true]);
  assert.deepEqual(['invalid opcode: opcode 0x5f not defined', 'EVM error: OpcodeNotFound', 'out of gas', undefined].map(faultReason), ['invalid opcode: opcode 0x5f not defined', 'EVM error: OpcodeNotFound', 'out of gas', undefined]);
  // In the preview: the first call fails, where it was two calls that "could not be simulated", as information.
  const p = await previewRequest({ method: 'wallet_sendCalls', params: [{ version: '2.0.0', chainId: '0x1', from: ALICE, atomicRequired: true, calls: [{ to: USDT, data: transfer }, { to: USDT, data: transfer }] }] }, { now: NOW }, { tokens: new StaticTokenRegistry(), simulator: new RpcSimulator({ 1: 'http://rpc.invalid' }, { fetchImpl }) });
  assert.deepEqual([p.simulation?.status, codes(p).includes('batch_will_fail'), codes(p).includes('simulation_unavailable')], ['reverted', true, false]);
  assert.match(p.simulation?.revertReason ?? '', /^call 1: the contract stopped on a failed check of its own/);
});

test('Shared gas: a call that uses up a share smaller than a transaction may have is run again on that much', async () => {
  // A node that allows one simulation 50 million gas. Each call needs what `needs` says (Infinity: it takes all it is
  // given, as an invalid opcode does); one that names no limit has what is left of the allowance.
  const T = (n: number) => `0x${n.toString(16).padStart(40, '0')}`, ALLOWANCE = 50_000_000;
  const node = (needs: number[]) => {
    const asked: (number | null)[][] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { method: string; params: [{ blockStateCalls: { calls: { to?: string; gas?: string }[] }[] }] };
      if (body.method !== 'eth_simulateV1') return new Response(JSON.stringify({ result: '0x' }));
      const calls = body.params[0].blockStateCalls[0].calls, index = (c: { to?: string }) => needs.findIndex((_, i) => T(i + 1) === c.to);
      if (calls.length === 1 && index(calls[0]) === -1) return new Response(JSON.stringify({ result: [{ calls: [{ status: '0x0', gasUsed: `0x${ALLOWANCE.toString(16)}`, returnData: '0x', error: { message: 'out of gas' } }] }] }));
      asked.push(calls.filter(c => index(c) !== -1).map(c => (c.gas ? Number(c.gas) : null)));
      let left = ALLOWANCE;
      const out: unknown[] = [];
      for (const c of calls) {
        const i = index(c), need = i === -1 ? 30_000 : needs[i], given = c.gas ? Number(c.gas) : left;
        if (given < 21_000 || given > left) return new Response(JSON.stringify({ error: { code: -32000, message: 'intrinsic gas too low' } }));
        const used = Math.min(need, given);
        left -= used;
        out.push(need > given ? { status: '0x0', gasUsed: `0x${used.toString(16)}`, returnData: '0x', error: { message: need === Infinity ? 'invalid opcode: INVALID' : 'out of gas' } } : { status: '0x1', gasUsed: `0x${used.toString(16)}`, returnData: i === -1 ? `0x${'00'.repeat(32)}` : '0x', logs: [] });
      }
      return new Response(JSON.stringify({ result: [{ calls: out }] }));
    }) as typeof fetch;
    return { asked, run: () => new RpcSimulator({ 1: 'http://rpc.invalid' }, { fetchImpl }).simulateBatch(needs.map((_, i) => ({ chainId: 1, from: ALICE, to: T(i + 1), data: '0x' as const, value: 0n }))) };
  };
  // Five calls, the third taking all it is given: a fifth of the allowance each (9,980,000) is less than a
  // transaction may have, so the third is run again on that much (16,777,216), and fails on it too: it does fail.
  const burner = node([50_000, 50_000, Infinity, 50_000, 50_000]);
  assert.deepEqual((await burner.run())?.map(r => r.status), ['success', 'success', 'reverted', 'success', 'success']);
  assert.deepEqual(burner.asked[0], [null, null, null, null, null]);
  assert.deepEqual(burner.asked[1], [9_980_000, 9_980_000, 9_980_000, 9_980_000, 9_980_000]);
  assert.deepEqual(burner.asked.find(a => a[2] === 16_777_216), [125_000, 125_000, 16_777_216, 125_000, 125_000]);
  // A call after it that needs more than the share (12 million) isn't one that fails: run again on as much as a
  // transaction may have, it goes through.
  const heavy = node([50_000, Infinity, 12_000_000, 50_000, 50_000]);
  const ran = (await heavy.run())!;
  assert.deepEqual(ran.map(r => r.status), ['success', 'reverted', 'success', 'success', 'success']);
  assert.equal(ran[2].gasUsed, 12_000_000n);
  // Nothing is asked twice of a batch the node runs as it is.
  const plain = node([50_000, 12_000_000, 50_000]);
  assert.deepEqual((await plain.run())?.map(r => r.status), ['success', 'success', 'success']);
  assert.ok(plain.asked.every(a => a.every(g => g === null)), JSON.stringify(plain.asked));
});
