// The call trace as a preview shows it (src/evm/trace.ts), the block a simulation names (src/block.ts), and how a
// trace from the local EVM is checked against the simulation the node ran.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, encodeFunctionData, parseAbi, toFunctionSelector, type Hex } from 'viem';
import { describeTrace, sameRun } from '../src/evm/trace.ts';
import { headerAfter, headerOf, nodeOverrides, pinLatest } from '../src/block.ts';
import { previewRequest } from '../src/preview.ts';
import { RpcSimulator } from '../src/simulation.ts';
import { StaticTokenRegistry } from '../src/chains.ts';
import type { AbiResolver, Dependencies, SimulationRequest, SimulationResult, TraceCall } from '../src/types.ts';
import { ALICE, BOB } from '../mocks/data.ts';
import { NOW } from './helpers.ts';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', VAULT = '0x1111111111111111111111111111111111111111', IMPL = '0x2222222222222222222222222222222222222222', OTHER = '0x3333333333333333333333333333333333333333';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const pad = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, '0')}`;
const VAULT_ABI = parseAbi(['function stake(address token, uint256 amount, (uint256 id, bytes note) meta) returns (uint256 shares)', 'event Staked(address indexed who, uint256 amount, uint256 shares)']);
const call = (c: Partial<TraceCall> & { to: string | null; input: string }): TraceCall => ({ type: 'call', from: ALICE.toLowerCase(), value: 0n, gas: 1_000_000n, gasUsed: 21_000n, ...c });

test('A trace made readable: verified names first, standard ones, then a guess; the rest raw', async () => {
  const stake = encodeFunctionData({ abi: VAULT_ABI, functionName: 'stake', args: [USDC, 5_000_000n, { id: 7n, note: `0x${'ab'.repeat(300)}` }] });
  const root = call({ to: VAULT, input: stake, output: encodeAbiParameters([{ type: 'uint256' }], [4_900_000n]), gasUsed: 90_000n,
    logs: [{ index: 1, address: VAULT, topics: ['0x' + '00'.repeat(32)].slice(0, 0).concat([`0x${'9e'.repeat(32)}`]), data: '0x' }],
    calls: [
      // A delegatecall to the implementation, whose verified ABI names the call and the event it emits as the vault.
      call({ type: 'delegatecall', from: VAULT, to: IMPL, input: stake, output: encodeAbiParameters([{ type: 'uint256' }], [4_900_000n]), gasUsed: 80_000n,
        logs: [{ index: 2, address: VAULT, topics: ['0x' + 'Staked(address,uint256,uint256)'.length.toString(16).padStart(64, '0')], data: '0x' }],
        calls: [
          call({ from: VAULT, to: USDC, input: encodeFunctionData({ abi: parseAbi(['function transferFrom(address,address,uint256)']), functionName: 'transferFrom', args: [ALICE, VAULT, 5_000_000n] }), output: pad('0x01'), gasUsed: 30_000n,
            logs: [{ index: 0, address: USDC, topics: [TRANSFER, pad(ALICE), pad(VAULT)], data: pad('0x4c4b40') }] }),
          call({ type: 'staticcall', from: VAULT, to: '0x0000000000000000000000000000000000000001', input: `0x${'11'.repeat(128)}`, output: pad(BOB), gasUsed: 3000n, precompile: true }),
          // A function only a signature database knows, and one nothing knows; a call that fails; a contract created.
          call({ from: VAULT, to: OTHER, input: `${toFunctionSelector('function poke(uint256)')}${'00'.repeat(31)}09`, gasUsed: 5000n }),
          call({ from: VAULT, to: OTHER, input: '0xdeadbeef0102', gasUsed: 100n, error: 'out of gas' }),
          call({ type: 'create2', from: VAULT, to: '0x4444444444444444444444444444444444444444', input: `0x${'60'.repeat(40)}`, gasUsed: 60_000n }),
          call({ from: VAULT, to: BOB.toLowerCase(), input: '0x', value: 10n ** 16n, gasUsed: 0n }),
        ] }),
    ] });
  const abis: AbiResolver = { resolve: async (_c, a) => a === VAULT || a === IMPL ? { abi: VAULT_ABI, name: a === VAULT ? 'VaultProxy' : 'Vault', source: 'sourcify', verified: true } : null };
  const asked: string[] = [];
  const signatures = { lookup: async () => [], candidates: async (sel: string) => { asked.push(sel); return sel === toFunctionSelector('function poke(uint256)') ? [{ signature: 'poke(uint256)', tier: 1 }, { signature: 'spam(uint256)', tier: 2 }] : []; } };
  const deps: Dependencies = { tokens: new StaticTokenRegistry(), abis, signatures };
  const t = await describeTrace(root, [{ address: VAULT, storage: [{ slot: '0x01', before: pad('0x00'), after: pad('0x07') }], balance: { before: 10n ** 18n, after: 10n ** 18n - 10n ** 16n } }], { chainId: 1, account: ALICE, deps }, { source: 'a test' });
  assert.deepEqual(t.calls.map(c => c.depth), [0, 1, 2, 2, 2, 2, 2, 2]);
  const [outer, inner, pull, recover, poke, raw, created, pay] = t.calls;
  // From the verified source: the function with its argument names, a tuple and long bytes cut, and what it returned.
  assert.deepEqual([outer.label, outer.fromLabel, outer.function, outer.named], ['VaultProxy', 'you', 'stake(address,uint256,(uint256,bytes))', 'verified']);
  assert.deepEqual(outer.args!.map(a => [a.name, a.type]), [['token', 'address'], ['amount', 'uint256'], ['meta', '(uint256,bytes)'.replace('(uint256,bytes)', 'tuple')]]);
  assert.match(outer.args![2].value, /^\{id: 7, note: 0x(ab){256}… \(300 bytes\)\}$/);
  assert.deepEqual(outer.returns, [{ name: 'shares', type: 'uint256', value: '4900000' }]);
  assert.equal(outer.text!.startsWith(`VaultProxy.stake(${USDC}, 5000000, {id: 7, note: 0xabab`), true);
  assert.deepEqual([inner.type, inner.label, inner.text!.startsWith('delegatecall Vault.stake(')], ['delegatecall', 'Vault', true]);
  // A standard function on a token the list knows, with its event decoded.
  assert.deepEqual([pull.label, pull.function, pull.named, pull.returns?.[0].value], ['USDC', 'transferFrom(address,address,uint256)', 'standard', 'true']);
  assert.deepEqual(pull.events!.map(e => [e.label, e.name, e.named, e.args!.map(a => `${a.name}=${a.value}`).join(' ')]), [['USDC', 'Transfer', 'standard', `from=${ALICE.toLowerCase()} to=${VAULT} value=5000000`]]);
  // A precompile by its name; no selector is read into its input.
  assert.deepEqual([recover.label, recover.precompile, recover.selector, recover.text], ['ecrecover', true, undefined, 'staticcall ecrecover']);
  // A database's candidate (the spam-filtered tier only) is a guess and says so; what nothing names stays raw.
  assert.deepEqual([poke.function, poke.named, poke.args?.[0].value], ['poke(uint256)', 'signature', '9']);
  assert.deepEqual([raw.function, raw.selector, raw.input, raw.error], [undefined, '0xdeadbeef', '0xdeadbeef0102', 'out of gas']);
  assert.match(raw.text!, /^0x33333333…3333\.0xdeadbeef\(…\) — failed: out of gas$/);
  assert.deepEqual(asked.sort(), ['0xdeadbeef', toFunctionSelector('function poke(uint256)')].sort());
  assert.equal(created.text, 'create2 new contract (40 bytes of creation code) at 0x4444444444444444444444444444444444444444');
  assert.equal(pay.text, `${BOB.toLowerCase().slice(0, 10)}…${BOB.toLowerCase().slice(-4)} with 0.01 ETH`);
  // State changes carry names and a readable balance change.
  assert.deepEqual(t.stateChanges, [{ address: VAULT, label: 'VaultProxy', balance: { before: (10n ** 18n).toString(), after: (10n ** 18n - 10n ** 16n).toString(), change: '-0.01 ETH' }, storage: [{ slot: '0x01', before: pad('0x00'), after: pad('0x07') }] }]);

  // A long trace is cut at 400 calls and says how many there were.
  const wide = call({ to: VAULT, input: '0x', calls: Array.from({ length: 450 }, () => call({ from: VAULT, to: OTHER, input: '0x' })) });
  const cut = await describeTrace(wide, undefined, { chainId: 1, deps: {} }, { source: 'a test' });
  assert.deepEqual([cut.calls.length, cut.truncated, cut.totalCalls], [400, true, 451]);
});

test('The block a simulation names: each chain’s next block, and what the node is told of it', async () => {
  const h = { number: '0x64', timestamp: '0x3e8', miner: '0x00000000000000000000000000000000000000AA', mixHash: `0x${'ab'.repeat(32)}`, gasLimit: '0x1c9c380', baseFeePerGas: '0x7', difficulty: '0x2', l1BlockNumber: '0x10' };
  // Ethereum: twelve seconds on, the fee recipient, base fee and randomness carried over.
  assert.deepEqual(headerAfter(1, h), { number: 101n, timestamp: 1012n, coinbase: '0x00000000000000000000000000000000000000aa', gasLimit: 30_000_000n, baseFeePerGas: 7n, prevRandao: `0x${'ab'.repeat(32)}` });
  // Arbitrum: NUMBER is the L1 block, the chain's own kept apart; the same second; opcode 0x44 is 1.
  assert.deepEqual(headerAfter(42161, h), { number: 16n, arbBlockNumber: 101n, timestamp: 1000n, coinbase: '0x00000000000000000000000000000000000000aa', gasLimit: 30_000_000n, baseFeePerGas: 7n, prevRandao: `0x${'00'.repeat(31)}01` });
  // BNB Chain and Polygon: opcode 0x44 is the difficulty; only Polygon's node takes it as an override of its own.
  assert.deepEqual([headerAfter(56, h).prevRandao, headerAfter(56, h).difficulty, headerAfter(56, h).timestamp], [`0x${'00'.repeat(31)}02`, undefined, 1001n]);
  assert.deepEqual([headerAfter(137, h).prevRandao, headerAfter(137, h).difficulty, headerAfter(137, h).timestamp], [`0x${'00'.repeat(31)}02`, 2n, 1002n]);
  // A block as it was (a replay): its own number and time.
  assert.deepEqual([headerOf(8453, h).number, headerOf(8453, h).timestamp, headerOf(42161, h).number, headerOf(42161, h).arbBlockNumber], [100n, 1000n, 16n, 100n]);
  // (Polygon's fee recipient is one fixed address in every block, whatever its header's miner field says.)
  assert.deepEqual(nodeOverrides(headerAfter(137, h)), { time: '0x3ea', feeRecipient: '0x7ee41d8a25641000661b1ef5e6ae8a00400466b0', prevRandao: `0x${'00'.repeat(31)}02`, baseFeePerGas: '0x7', difficulty: '0x2' });
  assert.deepEqual(Object.keys(nodeOverrides(headerAfter(1, h))), ['time', 'feeRecipient', 'prevRandao', 'baseFeePerGas']);
  const rpc = { has: (c: number) => c === 8453, call: async (_c: number, m: string) => (m === 'eth_getBlockByNumber' ? h : null) };
  assert.deepEqual(await pinLatest(rpc, 8453), { block: '0x64', header: headerAfter(8453, h) });
  assert.equal(await pinLatest(rpc, 1), undefined);

  // The node is asked for that block, with that header, when a request names one.
  const sent: { params: unknown[] }[] = [];
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    sent.push(body);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: [{ calls: [{ status: '0x1', gasUsed: '0x5208', returnData: '0x', logs: [] }] }] }));
  }) as unknown as typeof fetch;
  const sim = new RpcSimulator({ 8453: 'http://base.invalid' }, { fetchImpl });
  const req: SimulationRequest = { chainId: 8453, from: ALICE, to: BOB, data: '0x', value: 0n };
  await sim.simulate({ ...req, at: { block: '0x64', header: headerAfter(8453, h) } });
  const simulate = sent.find(s => (s as unknown as { method: string }).method === 'eth_simulateV1')!;
  assert.equal(simulate.params[1], '0x64');
  assert.deepEqual((simulate.params[0] as { blockStateCalls: { blockOverrides: unknown }[] }).blockStateCalls[0].blockOverrides, nodeOverrides(headerAfter(8453, h)));
  // Without one: the latest block, and a header of the node's making.
  sent.length = 0;
  await sim.simulate(req);
  const plain = sent.find(s => (s as unknown as { method: string }).method === 'eth_simulateV1')!;
  assert.deepEqual([plain.params[1], (plain.params[0] as { blockStateCalls: { blockOverrides?: unknown }[] }).blockStateCalls[0].blockOverrides], ['latest', undefined]);
  // No local EVM set up: nothing to trace with.
  assert.equal(await sim.trace([req]), null);
  // A node that can't serve the named block (it keeps seconds of state): the simulation runs on the latest instead.
  const tags: unknown[] = [];
  const pruning = new RpcSimulator({ 8453: 'http://base.invalid' }, { fetchImpl: (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    if (body.method === 'eth_simulateV1') tags.push(body.params[1]);
    return new Response(JSON.stringify(body.method === 'eth_simulateV1' && body.params[1] !== 'latest' ? { jsonrpc: '2.0', id: body.id, error: { code: -32000, message: 'missing trie node' } }
      : { jsonrpc: '2.0', id: body.id, result: [{ calls: [{ status: '0x1', gasUsed: '0x5208', returnData: '0x', logs: [] }] }] }));
  }) as unknown as typeof fetch });
  assert.equal((await pruning.simulate({ ...req, at: { block: '0x64', header: headerAfter(8453, h) } }))?.status, 'success');
  // (The named block once, then the latest: the run itself and its reading back of balances.)
  assert.deepEqual([tags[0], [...new Set(tags.slice(1))]], ['0x64', ['latest']]);
});

test('A trace is checked against the simulation shown: the same outcome and events, or it says it is only a guide', async () => {
  const log = (value: bigint) => ({ address: USDC, topics: [TRANSFER, pad(ALICE), pad(BOB)], data: pad(`0x${value.toString(16)}`) });
  const node: SimulationResult = { status: 'success', source: 'eth_simulateV1 @ chain 1', gasUsed: 50_000n, transfers: [{ asset: USDC, from: ALICE.toLowerCase(), to: BOB.toLowerCase(), raw: 5n }], logs: [log(5n)] };
  assert.equal(sameRun(node, { status: 'success', logs: [log(5n)] }), true);
  assert.equal(sameRun(node, { status: 'success', logs: [log(6n)] }), false);
  assert.equal(sameRun(node, { status: 'reverted' }), false);
  assert.equal(sameRun({ status: 'reverted' }, { status: 'reverted', logs: [] }), true);

  const data = encodeFunctionData({ abi: parseAbi(['function transfer(address,uint256)']), functionName: 'transfer', args: [BOB, 5n] });
  const root = (value: bigint): TraceCall => call({ to: USDC, input: data, output: pad('0x01'), logs: [{ index: 0, ...log(value) }] });
  const traced: SimulationRequest[][] = [];
  const simulator = (local: SimulationResult | null) => ({
    simulate: async () => node,
    trace: async (reqs: SimulationRequest[]) => { traced.push(reqs); return local ? [local] : null; },
  });
  const rpc = { has: () => true, call: async (_c: number, m: string) => (m === 'eth_getBlockByNumber' ? { number: '0x64', timestamp: '0x3e8', miner: BOB, mixHash: `0x${'ab'.repeat(32)}`, gasLimit: '0x1c9c380' } : m === 'eth_getCode' ? '0x' : '0x0') };
  const send = (sim: ReturnType<typeof simulator>, context: Record<string, unknown> = { trace: true }) =>
    previewRequest({ method: 'eth_sendTransaction', params: [{ from: ALICE, to: USDC, data, chainId: '0x1' }] }, { now: NOW, ...context }, { tokens: new StaticTokenRegistry(), rpc: rpc as unknown as Dependencies['rpc'], simulator: sim });

  // The local run did the same: the trace is the simulation's.
  const same = await send(simulator({ ...node, source: 'local', trace: root(5n), stateChanges: [] }));
  assert.equal(same.trace!.agrees, true);
  assert.equal(same.trace!.note, undefined);
  assert.equal(same.trace!.source, "a local EVM over Ethereum's state at block 100");
  assert.equal(same.trace!.calls[0].text, `USDC.transfer(${BOB.toLowerCase()}, 5)`);
  // Both runs were asked for the same block: the one named when the trace was asked for.
  assert.equal(traced[0][0].at!.block, '0x64');
  assert.equal(traced[0][0].at!.header.number, 101n);
  // The local run emitted something else: the trace is kept, marked as a guide; the simulation shown is the node's.
  const other = await send(simulator({ ...node, source: 'local', logs: [log(6n)], trace: root(6n) }));
  assert.equal(other.trace!.agrees, false);
  assert.match(other.trace!.note!, /emitted different events from the simulation shown above.*a guide/);
  assert.deepEqual(other.assetChanges.map(c => [c.direction, c.raw]), [['out', '5']]);
  // It ended differently.
  const failed = await send(simulator({ status: 'reverted', source: 'local', revertReason: 'nope', transfers: [], trace: { ...root(5n), error: 'nope', logs: undefined } }));
  assert.match(failed.trace!.note!, /ended differently \(it failed: nope\)/);
  // Nothing here can trace: the preview says so, and is otherwise the same.
  const none = await send(simulator(null));
  assert.equal(none.trace, undefined);
  assert.match(none.decoding.notes.join(' '), /No trace: a trace is run in a local EVM/);
  // Not asked for: no tracing run, no named block.
  traced.length = 0;
  const plain = await send(simulator({ ...node, trace: root(5n) }), {});
  assert.deepEqual([plain.trace, traced.length], [undefined, 0]);
});
