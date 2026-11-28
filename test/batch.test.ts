import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, encodeFunctionData, maxUint256, parseAbi, toHex } from 'viem';
import { previewRequest } from '../src/preview.ts';
import { StaticTokenRegistry } from '../src/chains.ts';
import { faultReason, rejection, RpcSimulator } from '../src/simulation.ts';
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

test('A failure of the transactions run before a batch isn’t read as the node refusing one of its calls', async () => {
  // A batch replayed behind its block's earlier transactions, which used up what the node allows one simulation: the
  // node's words for that ("intrinsic gas too low") are in the failure, and were taken for its refusal of a call.
  const { batchRefusal } = await import('../src/simulation.ts');
  const earlier = "the chain's node couldn't run the 670 transactions before this one in its block within its gas allowance for one simulation (intrinsic gas too low); a node with a higher allowance can";
  const send = { to: USDC, data: approve(ROUTER, 1n).data };
  const reqs: SimulationRequest[] = [{ chainId: 1, from: ALICE, to: USDC, data: '0x', value: 0n, gas: 108_831n }];
  assert.equal(batchRefusal(earlier, reqs), null);
  assert.equal(batchRefusal("the chain's node won't run the 190 transactions before this one in its block: it adds up their gas limits, which pass the block's, where the chain counts the gas they used (Block gas limit exceeded by the block's transactions); a node that counts as the chain does can", reqs), null);
  // (The node's own refusals are still read.)
  assert.deepEqual(batchRefusal('eth_simulateV1 failed: intrinsic gas too low', reqs), { first: 'out of gas: the gas limit is below the minimum any transaction with this calldata needs', overBlock: false });
  let asked = 0;
  const simulator: Simulator = { simulate: async () => { asked++; throw new Error(earlier); }, simulateBatch: async () => { asked++; throw new Error(earlier); } };
  const p = await previewRequest({ method: 'wallet_sendCalls', params: [{ version: '2.0.0', chainId: '0x1', from: ALICE, atomicRequired: true, calls: [send, send] }] }, { now: NOW }, { tokens: new StaticTokenRegistry(), simulator });
  // Not simulated, and said so: no call is shown failing, and the node isn't asked call by call for one that would.
  assert.deepEqual([p.simulation?.status, p.calls?.map(c => c.simulation?.status), codes(p).includes('simulation_reverted'), codes(p).includes('batch_partial_failure'), asked], [undefined, ['unavailable', 'unavailable'], false, false, 1]);
  assert.match(p.calls?.[0]?.simulation?.error ?? '', /couldn't run the 670 transactions before this one/);
});

test('A batch with a call the account can’t pay for says which call, where the node refuses the lot', async () => {
  // The node refuses the whole request for one call that sends coin the account hasn't, and doesn't say which: the
  // batch was two or three calls that "could not be simulated", as information, each listed as the request asks.
  const pay = { to: '0x00000000000000000000000000000000000b0b0b', value: '0x1' }, send = { to: USDC, data: approve(ROUTER, 1n).data };
  const refusal = 'eth_simulateV1 failed: err: insufficient funds for gas * price + value: address 0xA11cE00000000000000000000000000000000001 have 0 want 1 (supplied gas 50000000)';
  const ok = (): SimulationResult => ({ status: 'success', source: 'mock', gasUsed: 46_000n, balancesRead: true, transfers: [] });
  const simulator: Simulator = {
    // (As the node simulator answers: a transaction alone that can't be paid is refused with the reason; a batch throws.)
    simulate: async r => (r.value > 0n ? { status: 'reverted', source: 'mock', revertReason: "insufficient funds: the account can't cover the value it sends", transfers: [], limited: true, refused: true } : ok()),
    simulateBatch: async rs => { if (rs.some(r => r.value > 0n)) throw new Error(refusal); return rs.map(ok); },
  };
  const batch = (calls: unknown[], atomicRequired = false) => previewRequest({ method: 'wallet_sendCalls', params: [{ version: '2.0.0', chainId: '0xa4b1', from: ALICE, atomicRequired, calls }] }, { now: NOW }, { tokens: new StaticTokenRegistry(), simulator });
  const p = await batch([send, pay, send]);
  assert.deepEqual([p.simulation?.status, p.simulation?.revertReason], ['reverted', "call 2: insufficient funds: the account can't cover the value it sends"]);
  // The call before it as it ran, it as refused, and the one after it run without it: a transaction the network
  // doesn't take changes nothing for those after it.
  assert.deepEqual(p.calls?.map(c => c.simulation?.status), ['success', 'reverted', 'success']);
  assert.match(p.warnings.find(w => w.code === 'simulation_reverted')?.message ?? '', /^Call 2: The network would refuse this transaction as it stands: insufficient funds: the account can't cover the value it sends\. It would not be mined\.$/);
  assert.match(p.warnings.find(w => w.code === 'batch_partial_failure')?.message ?? '', /^The network would refuse call 2 as it stands \(insufficient funds: the account can't cover the value it sends\)\. The batch is not marked all-or-nothing/);
  assert.ok(!codes(p).includes('simulation_unavailable') && !codes(p).includes('simulation_skipped'), codes(p).join());
  // All or nothing: none of it happens. Such a batch is one transaction, which is mined, fails at the call that
  // sends coin the account hasn't, and pays its fee: the call isn't a transaction the network refuses there (it
  // read "the network would refuse call 2", with "It would not be mined" of the call).
  const atomic = await batch([send, pay], true);
  assert.equal(atomic.warnings.find(w => w.code === 'batch_will_fail')?.message, 'This batch is all-or-nothing, and call 2 is expected to fail, so none of the calls would take effect. You would still pay the network fee.');
  assert.match(atomic.warnings.find(w => w.code === 'simulation_reverted')?.message ?? '', /^Call 2: The transaction is expected to fail: insufficient funds: the account can't cover the value it sends\. You would still pay the network fee\.$/);
  assert.equal(atomic.attention, 'danger');
  // The first call: found from the call alone.
  const first = await batch([pay, send]);
  assert.deepEqual([first.simulation?.revertReason, first.calls?.map(c => c.simulation?.status)], ["call 1: insufficient funds: the account can't cover the value it sends", ['reverted', 'success']]);
  // A long batch: found by halving (the tenth of twelve), and two of them (the third and the seventh of eight).
  const long = await batch(Array.from({ length: 12 }, (_, i) => (i === 9 ? pay : send)));
  assert.deepEqual([long.simulation?.revertReason, long.calls?.map(c => c.simulation?.status[0]).join('')], ["call 10: insufficient funds: the account can't cover the value it sends", 'sssssssssrss']);
  const two = await batch(Array.from({ length: 8 }, (_, i) => (i === 2 || i === 6 ? pay : send)));
  assert.equal(two.calls?.map(c => c.simulation?.status[0]).join(''), 'ssrsssrs');
  // More than three of them (it was three at most, and seven calls with four refused "could not be simulated", all
  // seven, as information): each is found, next to the last where they come together.
  const many = await batch([pay, pay, pay, pay, send]);
  assert.equal(many.calls?.map(c => c.simulation?.status[0]).join(''), 'rrrrs');
  assert.ok(!codes(many).includes('simulation_unavailable') && !codes(many).includes('simulation_skipped'), codes(many).join());
  const spread = await batch([send, pay, pay, pay, pay, send, pay]);
  assert.equal(spread.calls?.map(c => c.simulation?.status[0]).join(''), 'srrrrsr');
  assert.match(spread.warnings.find(w => w.code === 'batch_partial_failure')?.message ?? '', /^The network would refuse call 2 as it stands/);
  let asked = 0;
  const counting: Simulator = { simulate: r => { asked++; return simulator.simulate(r); }, simulateBatch: rs => { asked++; return simulator.simulateBatch!(rs); } };
  const all = await previewRequest({ method: 'wallet_sendCalls', params: [{ version: '2.0.0', chainId: '0xa4b1', from: ALICE, calls: Array.from({ length: 10 }, () => pay) }] }, { now: NOW }, { tokens: new StaticTokenRegistry(), simulator: counting });
  assert.equal(all.calls?.map(c => c.simulation?.status[0]).join(''), 'rrrrrrrrrr');
  assert.ok(asked <= 20, `the node was asked ${asked} times`);
  // More than the node is asked about: what was found is kept, and the calls after it are said not to have been
  // simulated (they were all "could not be simulated").
  const flood = await batch([...Array.from({ length: 14 }, () => pay), send, send]);
  assert.equal(flood.calls?.map(c => c.simulation?.status[0]).join(''), 'rrrrrrrrrrrruuuu');
  assert.equal(flood.simulation?.status, 'reverted');
  assert.match(flood.simulation?.source ?? '', /, 12 calls in order$/);
  assert.match(flood.warnings.find(w => w.code === 'simulation_skipped' && /^Call 13:/.test(w.message))?.message ?? '', /^Call 13: This call was not simulated: the network would refuse others of this batch's calls as they stand, and the preview didn't get to this one/);
  assert.ok(flood.decoding.notes.some(n => n === "The network would refuse 12 of this batch's calls as they stand, and the preview stopped looking for more: calls 13 to 16 were not simulated."), flood.decoding.notes.join(' | '));
  assert.ok(!codes(flood).includes('simulation_unavailable'));
  // The node is asked 24 times at most to find them, whatever the batch (it was checked between calls found only:
  // 32 calls, every other one unpaid, took 32).
  for (const calls of [[...Array.from({ length: 14 }, () => pay), send, send], Array.from({ length: 32 }, (_, i) => (i % 2 ? pay : send))]) {
    asked = 0;
    const p = await previewRequest({ method: 'wallet_sendCalls', params: [{ version: '2.0.0', chainId: '0xa4b1', from: ALICE, calls }] }, { now: NOW }, { tokens: new StaticTokenRegistry(), simulator: counting });
    assert.ok(asked <= 25, `the node was asked ${asked} times (the batch, and 24 to find the calls)`);
    assert.ok(p.calls?.some(c => c.simulation?.status === 'reverted') && p.calls?.some(c => c.simulation?.status === 'unavailable'));
    // What ran before the last call found is kept as it ran; nothing found is said of a call that wasn't asked about.
    const statuses = p.calls!.map(c => c.simulation?.status[0]).join('');
    assert.match(statuses, /^[sr]+u+$/, statuses);
    for (const [i, c] of p.calls!.entries()) if (c.simulation?.status !== 'unavailable') assert.equal(c.simulation?.status, calls[i] === pay ? 'reverted' : 'success', `call ${i + 1}`);
  }
  // A node that stops answering midway (a rate limit) leaves what was found standing: it was all dropped.
  let left = 5;
  const tiring: Simulator = { simulate: r => { if (left-- <= 0) throw new Error('RPC HTTP 429: Too Many Requests'); return simulator.simulate(r); }, simulateBatch: rs => { if (left-- <= 0) throw new Error('RPC HTTP 429: Too Many Requests'); return simulator.simulateBatch!(rs); } };
  const tired = await previewRequest({ method: 'wallet_sendCalls', params: [{ version: '2.0.0', chainId: '0xa4b1', from: ALICE, calls: [pay, pay, pay, pay, send] }] }, { now: NOW }, { tokens: new StaticTokenRegistry(), simulator: tiring });
  assert.equal(tired.calls?.map(c => c.simulation?.status[0]).join(''), 'rruuu');
  // A node error that says nothing of the kind is as it was.
  const other = await previewRequest({ method: 'wallet_sendCalls', params: [{ version: '2.0.0', chainId: '0xa4b1', from: ALICE, calls: [send, send] }] }, { now: NOW }, { tokens: new StaticTokenRegistry(), simulator: { simulate: async () => ok(), simulateBatch: async () => { throw new Error('RPC HTTP 503'); } } });
  assert.ok(codes(other).includes('simulation_unavailable'));
});

test('What a node says in place of a simulation is said where it tells something: a gas limit no block holds, a rate limit', async () => {
  const send = { to: USDC, data: approve(ROUTER, 1n).data };
  // A transaction whose own gas limit is more than a block holds is one no block can include: the node says so in
  // its own words, and it was "could not be simulated" (on Polygon, with no other warning).
  for (const words of ["Block gas limit exceeded by the block's transactions", 'block gas limit reached: remaining: 160000000, required: 1000000000'])
    assert.equal(rejection(words, { value: 0n, gas: 1_000_000_000n }), 'gas limit too high: the gas limit (1,000,000,000) is more than a block holds here, so no block can include the transaction');
  // (Only of a request that names its limit: the same words are a node's of a block's worth of calls.)
  assert.equal(rejection("Block gas limit exceeded by the block's transactions", { value: 0n }), null);
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { method: string };
    return new Response(JSON.stringify(body.method === 'eth_simulateV1' ? { error: { code: -32000, message: "Block gas limit exceeded by the block's transactions" } } : { result: '0x' }));
  }) as typeof fetch;
  const high = await previewRequest({ method: 'eth_sendTransaction', params: [{ from: ALICE, ...send, gas: '0x3b9aca00', chainId: '0x89' }] }, { now: NOW }, { tokens: new StaticTokenRegistry(), simulator: new RpcSimulator({ 137: 'http://rpc.invalid' }, { fetchImpl }) });
  assert.deepEqual([high.simulation?.status, high.attention], ['reverted', 'danger']);
  assert.match(high.warnings.find(w => w.code === 'simulation_reverted')?.message ?? '', /^The network would refuse this transaction as it stands: gas limit too high: the gas limit \(1,000,000,000\) is more than a block holds here, so no block can include the transaction\. It would not be mined\.$/);

  // A node that is limiting requests: said, with what to do, where it was only "could not be simulated".
  const limited = (message: string) => previewRequest({ method: 'eth_sendTransaction', params: [{ from: ALICE, ...send, chainId: '0xa4b1' }] }, { now: NOW }, { tokens: new StaticTokenRegistry(), simulator: { simulate: async () => { throw new Error(message); } } });
  assert.match((await limited('RPC HTTP 429: Too Many Requests')).warnings.find(w => w.code === 'simulation_unavailable')?.message ?? '', /could not be simulated, so balance changes are based on the decoded request only\. The chain's node is limiting requests \(a public RPC's limits\): try again in a moment, or use an RPC of your own\.$/);
  assert.match((await limited('The operation was aborted due to timeout')).warnings.find(w => w.code === 'simulation_unavailable')?.message ?? '', /The chain's node didn't answer: try again in a moment\.$/);
  assert.match((await limited('eth_simulateV1 failed: something else')).warnings.find(w => w.code === 'simulation_unavailable')?.message ?? '', /based on the decoded request only\.$/);

  // A batch of one call is that call: its simulation is the batch's.
  const one = await previewRequest({ method: 'wallet_sendCalls', params: [{ version: '2.0.0', chainId: '0xa4b1', from: ALICE, calls: [send] }] }, { now: NOW }, { tokens: new StaticTokenRegistry(), simulator: { simulate: async () => ({ status: 'success', source: 'mock', gasUsed: 46_000n, transfers: [] }) } });
  assert.deepEqual([one.simulation?.status, one.simulation?.source], ['success', 'mock']);
});

test('A batch of more calls than a node takes in one simulation is run by the local EVM', async () => {
  // Arbitrum One's public node answers a simulation of more than 30 calls with HTTP 429, every time: a batch of 32
  // was "could not be simulated", after seconds of asking again. Where a local EVM is set up, it runs the batch.
  const asked: string[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    asked.push((JSON.parse(String(init.body)) as { method: string }).method);
    return new Response('', { status: 429 });
  }) as typeof fetch;
  const ran: number[] = [];
  const fork = { covers: (chainId: number) => chainId === 42161, simulateBatch: async (reqs: SimulationRequest[]): Promise<SimulationResult[]> => { ran.push(reqs.length); return reqs.map(() => ({ status: 'success', source: 'the local EVM', gasUsed: 21_000n, transfers: [], basis: 'fork' })); } };
  const sim = new RpcSimulator({ 42161: 'http://rpc.invalid' }, { fetchImpl, fork: fork as never });
  const pay = (n: number): SimulationRequest[] => Array.from({ length: n }, () => ({ chainId: 42161, from: ALICE, to: USDC, data: '0x' as const, value: 1n }));
  const results = await sim.simulateBatch(pay(31));
  assert.deepEqual([results?.length, results?.every(r => r.status === 'success'), ran, asked.includes('eth_simulateV1')], [31, true, [31], false]);
});

test('From Amsterdam on, a call on a gas limit over the cap is run by the local EVM: the node’s simulation counts that gas otherwise', async () => {
  // Sepolia's node gives the whole limit as ordinary gas when it simulates, where the chain keeps what is over
  // 16,777,216 back for new state: a creation mined on a limit of 36,147,392 (35,861,609 used) reverted there.
  const asked: string[] = [];
  const node = (amsterdam: boolean) => (async (_url: string, init: RequestInit) => {
    const one = (b: { id: number; method: string }) => {
      asked.push(b.method);
      const header = { number: '0x10', ...(amsterdam && { blockAccessListHash: `0x${'11'.repeat(32)}` }) };
      return { jsonrpc: '2.0', id: b.id, result: b.method === 'eth_simulateV1' ? [{ ...header, number: '0x11', calls: [{ status: '0x0', gasUsed: '0x21c493d', returnData: '0x', error: { code: 3, message: 'execution reverted', data: '0x' } }] }] : b.method === 'eth_getBlockByNumber' ? header : '0x' };
    };
    const body = JSON.parse(String(init.body)) as { id: number; method: string } | { id: number; method: string }[];
    return new Response(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)));
  }) as typeof fetch;
  const ran: bigint[] = [];
  const fork = (covers = true) => ({ covers: () => covers, simulateBatch: async (reqs: SimulationRequest[]): Promise<SimulationResult[]> => { ran.push(...reqs.map(r => r.gas ?? 0n)); return reqs.map(() => ({ status: 'success', source: 'local EVM over chain 11155111 state (the RPC has no eth_simulateV1)', gasUsed: 35_861_609n, transfers: [], basis: 'fork' })); } });
  const create = (gas?: bigint, chainId = 11155111): SimulationRequest => ({ chainId, from: ALICE, to: '0x4e59b44847b379578588920ca78fbf26c0b4956c', data: '0x00', value: 0n, ...(gas !== undefined && { gas }) });
  const run = async (req: SimulationRequest, amsterdam = true, covers = true) => { ran.length = 0; asked.length = 0; return (await new RpcSimulator({ [req.chainId]: 'http://rpc.invalid' }, { fetchImpl: node(amsterdam), fork: fork(covers) as never }).simulateBatch([req]))![0]; };
  // Over the cap, on an Amsterdam chain: the local EVM's run, said to be so and why.
  const over = await run(create(36_147_392n));
  assert.deepEqual([over.status, over.gasUsed, ran], ['success', 35_861_609n, [36_147_392n]]);
  assert.equal(over.source, "local EVM over chain 11155111 state (a gas limit over 16,777,216, which the chain's node simulates otherwise)");
  // At the cap or under it, or with no limit named, the node's own (there is nothing kept back to count otherwise).
  for (const gas of [16_777_216n, 5_000_000n, undefined]) {
    const under = await run(create(gas));
    assert.deepEqual([under.status, under.source, ran], ['reverted', 'eth_simulateV1 @ chain 11155111', []], String(gas));
  }
  // Before Amsterdam (no block access list hash in the headers), and with no local EVM for the chain: the node's.
  const before = await run(create(36_147_392n), false);
  assert.deepEqual([before.status, ran, asked.includes('eth_getBlockByNumber')], ['reverted', [], true]);
  const none = await run(create(36_147_392n), true, false);
  assert.deepEqual([none.status, ran], ['reverted', []]);
});

test('A batch with a call naming a gas limit no block holds says which call; limits that only together pass a block’s are no call’s fault', async () => {
  // The node refuses the lot ("Block gas limit exceeded by the block's transactions"), as it does a transaction
  // alone: three transfers, the second naming a thousand million, were "could not be simulated" on Ethereum, BNB
  // Chain and Base.
  const BLOCK = 60_000_000n, over = "eth_simulateV1 failed: Block gas limit exceeded by the block's transactions";
  const ok = (): SimulationResult => ({ status: 'success', source: 'mock', gasUsed: 21_000n, balancesRead: true, transfers: [] });
  const tooHigh = (gas: bigint): SimulationResult => ({ status: 'reverted', source: 'mock', revertReason: `gas limit too high: the gas limit (${gas.toLocaleString('en-US')}) is more than a block holds here, so no block can include the transaction`, transfers: [], limited: true, refused: true });
  const asked: number[] = [];
  const simulator: Simulator = {
    simulate: async r => { asked.push(1); return r.gas !== undefined && r.gas > BLOCK ? tooHigh(r.gas) : ok(); },
    simulateBatch: async rs => { asked.push(rs.length); if (rs.reduce((sum, r) => sum + (r.gas ?? 0n), 0n) > BLOCK) throw new Error(over); return rs.map(ok); },
  };
  const call = (gas?: bigint) => ({ to: '0x00000000000000000000000000000000000b0b0b', value: '0x0', ...(gas !== undefined && { gas: toHex(gas) }) });
  const batch = (calls: unknown[]) => previewRequest({ method: 'wallet_sendCalls', params: [{ version: '2.0.0', chainId: '0x1', from: ALICE, calls }] }, { now: NOW }, { tokens: new StaticTokenRegistry(), simulator });
  const p = await batch([call(), call(10n ** 9n), call()]);
  assert.deepEqual(p.calls?.map(c => c.simulation?.status), ['success', 'reverted', 'success']);
  assert.match(p.warnings.find(w => w.code === 'batch_partial_failure')?.message ?? '', /^The network would refuse call 2 as it stands \(gas limit too high: the gas limit \(1,000,000,000\) is more than a block holds here, so no block can include the transaction\)\./);
  assert.ok(!codes(p).includes('simulation_unavailable'), codes(p).join());
  // Found from the highest limit down, asked alone: the same limit again isn't asked about, and a limit a block
  // holds ends it (the batch, the two over, one a block holds, then the rest together).
  asked.length = 0;
  const several = await batch([call(10n ** 9n), call(50_000n), call(10n ** 9n), call(2n * 10n ** 9n), call(100_000n)]);
  assert.equal(several.calls?.map(c => c.simulation?.status[0]).join(''), 'rsrrs');
  assert.deepEqual(asked, [5, 1, 1, 1, 2]);
  // With a call that can't be paid for as well, whichever the node complains of first: geth says the unpaid call
  // before it adds up the limits (the batch was left unsimulated), reth the limits first.
  const unpaid = { to: '0x00000000000000000000000000000000000b0b0b', value: '0x1' };
  const fundsRefusal = 'eth_simulateV1 failed: insufficient funds for gas * price + value: have 0 want 1';
  const refusedForFunds = (): SimulationResult => ({ status: 'reverted', source: 'mock', revertReason: "insufficient funds: the account can't cover the value it sends", transfers: [], limited: true, refused: true });
  for (const gasFirst of [false, true]) {
    const both: Simulator = {
      simulate: async r => (r.gas !== undefined && r.gas > BLOCK ? tooHigh(r.gas) : r.value > 0n ? refusedForFunds() : ok()),
      simulateBatch: async rs => {
        const overLimit = rs.reduce((sum, r) => sum + (r.gas ?? 0n), 0n) > BLOCK, short = rs.some(r => r.value > 0n);
        if (overLimit && (gasFirst || !short)) throw new Error(over);
        if (short) throw new Error(fundsRefusal);
        return rs.map(ok);
      },
    };
    const mixed = await previewRequest({ method: 'wallet_sendCalls', params: [{ version: '2.0.0', chainId: '0x1', from: ALICE, calls: [unpaid, call(), call(10n ** 9n)] }] }, { now: NOW }, { tokens: new StaticTokenRegistry(), simulator: both });
    assert.equal(mixed.calls?.map(c => c.simulation?.status[0]).join(''), 'rsr', gasFirst ? 'limits first' : 'funds first');
    // More unpaid calls than are looked for, and a call found for its gas limit after them: the note counts what was
    // found and names the calls not got to (it said "12 of the first 11 calls", the last call among those "not simulated").
    const long = await previewRequest({ method: 'wallet_sendCalls', params: [{ version: '2.0.0', chainId: '0x1', from: ALICE, calls: [...Array.from({ length: 14 }, () => unpaid), call(), call(10n ** 9n)] }] }, { now: NOW }, { tokens: new StaticTokenRegistry(), simulator: both });
    const statuses = long.calls!.map(c => c.simulation?.status[0]).join('');
    assert.match(statuses, /^r{11,12}u+r$/, statuses);
    const found = statuses.split('r').length - 1, first = statuses.indexOf('u') + 1;
    assert.ok(long.decoding.notes.includes(`The network would refuse ${found} of this batch's calls as they stand, and the preview stopped looking for more: calls ${first} to 15 were not simulated.`), long.decoding.notes.join(' | '));
  }
  // Limits that together pass a block's and each fit one: transactions that go into blocks of their own. No call
  // is blamed.
  const together = await batch([call(30_000_000n), call(30_000_000n), call(30_000_000n)]);
  assert.deepEqual(together.calls?.map(c => c.simulation?.status), ['unavailable', 'unavailable', 'unavailable']);
  assert.ok(!codes(together).includes('batch_partial_failure') && !codes(together).includes('simulation_reverted'));
});

test('A transaction the network would refuse after the wallet’s pending transactions is said to be, and a pending one that is', async () => {
  // The node refuses the pending transactions and this one as a lot, and doesn't say which of them it wouldn't
  // take: after a pending transfer of all the account holds, a transfer of 1 wei was "could not be simulated".
  const BOB_ = '0x00000000000000000000000000000000000b0b0b', refusal = 'eth_simulateV1 failed: insufficient funds for gas * price + value: have 0 want 1';
  const ok = (): SimulationResult => ({ status: 'success', source: 'mock', gasUsed: 21_000n, balancesRead: true, transfers: [] });
  const refused = (): SimulationResult => ({ status: 'reverted', source: 'mock', revertReason: "insufficient funds: the account can't cover the value it sends", transfers: [], limited: true, refused: true });
  // An account holding 10 wei: what a run of transactions leaves of it decides which the node takes.
  const payable = (rs: SimulationRequest[]) => { let held = 10n; for (const r of rs) { if (r.value > held) return false; held -= r.value; } return true; };
  const simulator: Simulator = { simulate: async r => (payable([r]) ? ok() : refused()), simulateBatch: async rs => { if (!payable(rs)) throw new Error(refusal); return rs.map(ok); } };
  const send = (value: string, pending: { to: string; value: string }[]) => previewRequest({ method: 'eth_sendTransaction', params: [{ from: ALICE, to: BOB_, value, chainId: '0xa4b1' }] }, { now: NOW, pendingTransactions: pending }, { tokens: new StaticTokenRegistry(), simulator });
  // The pending transfer takes all ten: this one can't send its 1 wei.
  const after = await send('0x1', [{ to: BOB_, value: '0xa' }]);
  assert.equal(after.simulation?.status, 'reverted');
  assert.match(after.warnings.find(w => w.code === 'simulation_reverted')?.message ?? '', /^The network would refuse this transaction as it stands: insufficient funds: the account can't cover the value it sends\. It would not be mined\.$/);
  assert.match(after.decoding.notes.join(' '), /Simulated after your 1 pending transaction, in order, as they will run before it\./);
  assert.ok(!codes(after).includes('simulation_unavailable'));
  // A pending transaction that is the one the network wouldn't take: said, and this one run without it.
  const before = await send('0x1', [{ to: BOB_, value: '0x64' }]);
  assert.equal(before.simulation?.status, 'success');
  assert.match(before.warnings.find(w => w.code === 'pending_transaction_fails')?.message ?? '', /^Your pending transaction #1 is expected to fail \(insufficient funds: the account can't cover the value it sends\)/);
  // This one naming a gas limit no block holds: the node refuses the lot for that too, and it is said of this one.
  const tooHigh = "gas limit too high: the gas limit (1,000,000,000) is more than a block holds here, so no block can include the transaction";
  const gassy: Simulator = { simulate: async r => (r.gas !== undefined && r.gas > 60_000_000n ? { ...refused(), revertReason: tooHigh } : ok()),
    simulateBatch: async rs => { if (rs.some(r => r.gas !== undefined && r.gas > 60_000_000n)) throw new Error("eth_simulateV1 failed: Block gas limit exceeded by the block's transactions"); return rs.map(ok); } };
  const high = await previewRequest({ method: 'eth_sendTransaction', params: [{ from: ALICE, to: BOB_, value: '0x1', gas: '0x3b9aca00', chainId: '0xa4b1' }] }, { now: NOW, pendingTransactions: [{ to: BOB_, value: '0x1' }] }, { tokens: new StaticTokenRegistry(), simulator: gassy });
  assert.match(high.warnings.find(w => w.code === 'simulation_reverted')?.message ?? '', /^The network would refuse this transaction as it stands: gas limit too high: the gas limit \(1,000,000,000\) is more than a block holds here/);
  assert.ok(!codes(high).includes('simulation_unavailable') && !codes(high).includes('pending_transaction_fails'), codes(high).join());
});

test('A traced batch with a call the network would refuse traces the calls that ran', async () => {
  const BOB_ = '0x00000000000000000000000000000000000b0b0b';
  const ok = (): SimulationResult => ({ status: 'success', source: 'mock', gasUsed: 21_000n, balancesRead: true, transfers: [] });
  const traced: number[] = [];
  const simulator: Simulator = {
    simulate: async r => (r.value > 5n ? { status: 'reverted', source: 'mock', revertReason: "insufficient funds: the account can't cover the value it sends", transfers: [], limited: true, refused: true } : ok()),
    simulateBatch: async rs => { if (rs.some(r => r.value > 5n)) throw new Error('eth_simulateV1 failed: insufficient funds for gas * price + value'); return rs.map(ok); },
    // (What the trace holds isn't the matter here: which calls it is asked for is.)
    trace: async rs => { traced.push(rs.length); return rs.map(() => ok()); },
  };
  const p = await previewRequest({ method: 'wallet_sendCalls', params: [{ version: '2.0.0', chainId: '0xa4b1', from: ALICE, calls: [{ to: BOB_, value: '0x1' }, { to: BOB_, value: '0x64' }, { to: BOB_, value: '0x2' }] }] }, { now: NOW, trace: true }, { tokens: new StaticTokenRegistry(), simulator, rpc: { has: () => true, call: async (_c: number, m: string) => (m === 'eth_getBlockByNumber' ? { number: '0x10', timestamp: '0x65000000', baseFeePerGas: '0x1', gasLimit: '0x1c9c380', miner: `0x${'00'.repeat(20)}`, hash: `0x${'11'.repeat(32)}`, parentHash: `0x${'22'.repeat(32)}` } : '0x') } });
  assert.deepEqual(p.calls?.map(c => c.simulation?.status), ['success', 'reverted', 'success']);
  // The two calls that ran were the ones traced: it was none, with nothing said.
  assert.deepEqual(traced, [2]);
});

test('A batch the probe can’t run waits for the local EVM, which is all that can run it', async () => {
  // An RPC with no eth_simulateV1 and no state overrides (HyperEVM's): past the budget the local EVM has before the
  // probe answers in its place, a batch came back with only its first call simulated, the probe having no way to
  // run calls in order, though the local EVM's run of them all was a moment from done.
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { method: string };
    return new Response(JSON.stringify(body.method === 'eth_simulateV1' ? { error: { code: -32601, message: 'the method eth_simulateV1 does not exist/is not available' } }
      : body.method === 'eth_call' ? { error: { code: -32602, message: 'state override is not supported' } } : { result: '0x' }));
  }) as typeof fetch;
  const slow = { covers: () => true, simulate: async () => null, simulateBatch: (reqs: SimulationRequest[]) => new Promise<SimulationResult[]>(resolve => setTimeout(() => resolve(reqs.map(() => ({ status: 'success', source: 'the local EVM', gasUsed: 21_000n, transfers: [], basis: 'fork' }))), 150)) };
  const reqs: SimulationRequest[] = [1n, 2n].map(value => ({ chainId: 999, from: ALICE, to: USDC, data: '0x' as const, value }));
  const results = await new RpcSimulator({ 999: 'http://rpc.invalid' }, { fetchImpl, fork: slow as never, forkBudgetMs: 20 }).simulateBatch(reqs);
  assert.deepEqual(results?.map(r => [r.status, r.source]), [['success', 'the local EVM'], ['success', 'the local EVM']]);
  // (A local EVM that fails leaves the probe's answer: that such a batch can't be run in order here.)
  const failing = { ...slow, simulateBatch: () => new Promise<SimulationResult[]>((_, reject) => setTimeout(() => reject(new Error('ran out of time')), 60)) };
  await assert.rejects(new RpcSimulator({ 999: 'http://rpc.invalid' }, { fetchImpl, fork: failing as never, forkBudgetMs: 20 }).simulateBatch(reqs), { name: 'BatchSimulationUnsupported' });
});
