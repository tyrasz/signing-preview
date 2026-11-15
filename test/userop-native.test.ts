// The native coin a whole ERC-4337 operation moves for its account: what its calls send and receive, apart from the
// gas. The account pays its gas into its EntryPoint deposit (the prefund, during validation) and the gas is charged
// from that deposit, so the coin leaving its balance is the prefund and what its calls send together. On
// test/evm-chain.ts, by the fork simulator (a node without eth_simulateV1) and by eth_simulateV1 with
// traceTransfers, with EntryPoint v0.6 to v0.9's simulation code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { concatHex, encodeAbiParameters, encodeEventTopics, encodeFunctionData, numberToHex, parseAbi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { previewRequest } from '../src/preview.ts';
import { StaticTokenRegistry } from '../src/chains.ts';
import { RpcSimulator } from '../src/simulation.ts';
import { JsonRpcClient } from '../src/rpc.ts';
import { ForkSimulator } from '../src/fork-simulator.ts';
import { ENTRY_POINT_SIMULATIONS_V06, ENTRY_POINT_SIMULATIONS_V07, ENTRY_POINT_SIMULATIONS_V08, ENTRY_POINT_SIMULATIONS_V09 } from '../src/entrypoint-simulations.ts';
import { readOperation, userOpHash } from '../src/userop-hash.ts';
import { withoutGas } from '../src/erc4337-sim.ts';
import type { Dependencies, Preview, SimulationResult } from '../src/types.ts';
import { codes, NOW } from './helpers.ts';
import { testChain } from './evm-chain.ts';

const EP = '0x0000000071727de22e5e9d8baf0edac6f37da032', EP6 = '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789';
const EP8 = '0x4337084d9e255ff0702461cf8895ce9e3b5ff108', EP9 = '0x433709009b8330fda32311df1c2afa402ed8d009';
const OWNER = privateKeyToAccount('0x7777777777777777777777777777777777777777777777777777777777777777').address.toLowerCase();
const BOB = '0xb0b0000000000000000000000000000000000002', ATTACKER = '0xa77ac4e7000000000000000000000000000000aa';
const FUNDER = '0xde9100000000000000000000000000000000d001';
const URL_ = 'http://hyperevm.invalid';
const E = 10n ** 18n;

const chain = await testChain();
const wrap = await chain.deploy('Token', 'string,uint8', ['WRAP', 18]);
const usdc = await chain.deploy('Token', 'string,uint8', ['USDC', 6]);
for (const [ep, code] of [[EP, ENTRY_POINT_SIMULATIONS_V07], [EP6, ENTRY_POINT_SIMULATIONS_V06], [EP8, ENTRY_POINT_SIMULATIONS_V08], [EP9, ENTRY_POINT_SIMULATIONS_V09]] as const) await chain.putCode(ep, code as Hex);
const A = parseAbi(['function mint(address,uint256)', 'function approve(address,uint256)', 'function transfer(address,uint256)', 'function deposit()', 'function withdraw(uint256)',
  'function depositTo(address)', 'function withdrawTo(address,uint256)', 'function execute(address,uint256,bytes)']);
const call = (fn: string, args: unknown[]) => encodeFunctionData({ abi: A, functionName: fn, args } as never);
await chain.setBalance(FUNDER, 100n * E);
// The wrapped token holds what it pays out on withdraw.
await chain.setBalance(wrap, 10n * E);
/** An account of EntryPoint `ep`'s holding 2 HYPE (and 1 WRAP), with `deposit` in the EntryPoint already. */
async function account(ep = EP, deposit = 0n): Promise<string> {
  const a = await chain.deploy(ep === EP6 ? 'Account4337V06' : 'Account4337', 'address,address', [OWNER, ep]);
  await chain.setBalance(a, 2n * E);
  await chain.exec(wrap, call('mint', [a, E]));
  if (deposit) await chain.exec(ep, call('depositTo', [a]), FUNDER, deposit);
  return a;
}
const paymaster = await chain.deploy('TokenPaymaster', 'address,address', [EP, usdc]);
await chain.exec(EP, call('depositTo', [paymaster]), FUNDER, E);

const tokens = new StaticTokenRegistry({ 999: [{ address: wrap, symbol: 'WRAP', decimals: 18, name: 'Wrapped' }, { address: usdc, symbol: 'USDC', decimals: 6, name: 'USD Coin' }] });
const fork: Dependencies = {
  tokens, rpc: new JsonRpcClient({ 999: URL_ }, { fetchImpl: chain.fetchImpl }),
  simulator: new RpcSimulator({ 999: URL_ }, { fetchImpl: chain.fetchImpl, fork: new ForkSimulator({ 999: URL_ }, { fetchImpl: chain.fetchImpl }) }),
};
// A node with eth_simulateV1 (traceTransfers: its native transfers per call frame), whose state is read around each
// call through Multicall3's getEthBalance: here code that answers any call with the balance of its first argument.
const withSimulateV1 = (async (u: string, init: RequestInit) => {
  chain.simulateV1 = true;
  try { return await chain.fetchImpl(u, init); } finally { chain.simulateV1 = false; }
}) as typeof fetch;
await chain.putCode('0xca11bde05977b3631167028862be2a173976ca11', '0x6004353160005260206000f3');
const simulateV1: Dependencies = { tokens, rpc: new JsonRpcClient({ 999: URL_ }, { fetchImpl: withSimulateV1 }), simulator: new RpcSimulator({ 999: URL_ }, { fetchImpl: withSimulateV1 }) };
// The HyperEVM public node's own: no eth_simulateV1 and no local EVM, so the state-override probe or eth_call.
const probe: Dependencies = { tokens, rpc: fork.rpc, simulator: new RpcSimulator({ 999: URL_ }, { fetchImpl: chain.fetchImpl }) };

const word = (v: bigint) => numberToHex(v, { size: 16 });
const operation = (sender: string, callData: Hex, m: Record<string, unknown> = {}) => ({ sender, nonce: '0x0', callData, callGasLimit: '0x30d40', verificationGasLimit: '0x30d40', preVerificationGas: '0xc350', maxFeePerGas: '0x77359400', maxPriorityFeePerGas: '0x3b9aca00', ...m });
const withPaymaster = (pm: string) => ({ paymaster: pm, paymasterVerificationGasLimit: '0x186a0', paymasterPostOpGasLimit: '0x186a0', paymasterData: '0x' });
async function preview(op: Record<string, unknown>, deps: Dependencies, version: '0.6' | '0.7' = '0.7'): Promise<Preview> {
  const ep = version === '0.6' ? EP6 : EP;
  const hash = userOpHash(readOperation(op, version)!, ep, 999, version);
  return previewRequest({ method: 'personal_sign', params: [hash, OWNER] }, { now: NOW, chainId: 999, userOperation: { entryPoint: ep, operation: op } }, deps);
}
/** A v0.8 or v0.9 operation, as the PackedUserOperation typed data the wallet signs. */
function typed(ep: string, sender: string, callData: Hex, deps: Dependencies): Promise<Preview> {
  const types = { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
    PackedUserOperation: [{ name: 'sender', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'initCode', type: 'bytes' }, { name: 'callData', type: 'bytes' }, { name: 'accountGasLimits', type: 'bytes32' }, { name: 'preVerificationGas', type: 'uint256' }, { name: 'gasFees', type: 'bytes32' }, { name: 'paymasterAndData', type: 'bytes' }] };
  const message = { sender, nonce: '0', initCode: '0x', callData, accountGasLimits: concatHex([word(200_000n), word(200_000n)]), preVerificationGas: '50000', gasFees: concatHex([word(1_000_000_000n), word(2_000_000_000n)]), paymasterAndData: '0x' };
  return previewRequest({ method: 'eth_signTypedData_v4', params: [OWNER, JSON.stringify({ domain: { name: 'ERC4337', version: '1', chainId: 999, verifyingContract: ep }, types, primaryType: 'PackedUserOperation', message })] }, { now: NOW }, deps);
}
const of = (p: Preview, asset: string) => p.assetChanges.filter(c => (c.asset ?? '').toLowerCase() === asset).map(c => [c.direction, c.amount, c.basis]);
const whole = (p: Preview) => p.decoding.notes.some(n => /^The whole operation was simulated/.test(n));
const sendHalf = call('execute', [BOB, E / 2n, '0x']);
const wrapHalf = call('execute', [wrap, E / 2n, call('deposit', [])]);
const unwrapHalf = call('execute', [wrap, 0n, call('withdraw', [E / 2n])]);

/** Each path a whole operation can run on here: the local EVM (a node without eth_simulateV1), and eth_simulateV1. */
const paths = [['the fork simulator', fork], ['eth_simulateV1', simulateV1]] as const;

test('A whole operation that sends the native coin, or wraps it, lists what leaves the account, and not the gas prefund it pays', async () => {
  const a = await account();
  for (const [path, deps] of paths) {
    const sent = await preview(operation(a, sendHalf), deps);
    assert.ok(whole(sent), `${path}: ${sent.decoding.notes.join(' | ')}`);
    assert.deepEqual(of(sent, 'native'), [['out', '0.5', 'simulated_state']], path);
    const wrapped = await preview(operation(a, wrapHalf), deps);
    assert.deepEqual([of(wrapped, 'native'), of(wrapped, wrap)], [[['out', '0.5', 'simulated_state']], [['in', '0.5', 'simulated_state']]], path);
    // The gas is reported apart, paid by the account.
    assert.match(String(wrapped.details.find(d => d.label === 'Gas cost (simulated)')?.value), /paid by the account/, path);
  }
  // The HyperEVM node alone (no eth_simulateV1, no local EVM) runs no whole operation: the coin is what the calls ask
  // to send, as decoded.
  const asked = await preview(operation(a, sendHalf), probe);
  assert.ok(!whole(asked), asked.decoding.notes.join(' | '));
  assert.deepEqual(of(asked, 'native'), [['out', '0.5', 'requested']]);
});

test('What the account receives is listed whole, not less the prefund it pays; calls that fail send nothing', async () => {
  const a = await account();
  for (const [path, deps] of paths) {
    const unwrapped = await preview(operation(a, unwrapHalf), deps);
    assert.deepEqual([of(unwrapped, 'native'), of(unwrapped, wrap)], [[['in', '0.5', 'simulated_state']], [['out', '0.5', 'simulated_state']]], path);
    // Only the gas is paid: no coin is listed as simulated (what the calls ask for stays, as decoded, with the warning).
    const failing = await preview(operation(a, call('execute', [BOB, 5n * E, '0x'])), deps);
    assert.ok(codes(failing).includes('userop_execution_reverts'), `${path}: ${codes(failing).join()}`);
    assert.deepEqual(of(failing, 'native').filter(c => c[2] !== 'requested'), [], path);
  }
});

test('An account whose EntryPoint deposit already covers the gas, or whose paymaster pays it: what its calls send', async () => {
  const funded = await account(EP, E), sponsored = await account();
  await chain.exec(usdc, call('mint', [sponsored, 100_000_000n]));
  await chain.exec(usdc, call('approve', [paymaster, (1n << 256n) - 1n]), sponsored);
  for (const [path, deps] of paths) {
    const p = await preview(operation(funded, sendHalf), deps);
    assert.match(String(p.details.find(d => d.label === 'Gas cost (simulated)')?.value), /paid by the account/, `${path} ${JSON.stringify(p.warnings)} ${p.decoding.notes.join(" | ")}`);
    assert.deepEqual(of(p, 'native'), [['out', '0.5', 'simulated_state']], path);
    const q = await preview(operation(sponsored, sendHalf, withPaymaster(paymaster)), deps);
    assert.match(String(q.details.find(d => d.label === 'Gas cost (simulated)')?.value), /paid by the paymaster/, path);
    assert.deepEqual(of(q, 'native'), [['out', '0.5', 'simulated_state']], path);
    assert.equal(of(q, usdc).length, 1, `${path}: the paymaster’s charge`);
  }
});

test('The account’s EntryPoint deposit is its own coin: what its calls give someone else of it is listed, what they keep in it is not', async () => {
  const funded = await account(EP, E), a = await account();
  for (const [path, deps] of paths) {
    // Sent to an attacker from the deposit (withdrawTo), or deposited for another account (depositTo): both leave it.
    const drained = await preview(operation(funded, call('execute', [EP, 0n, call('withdrawTo', [ATTACKER, E / 2n])])), deps);
    assert.ok(!codes(drained).includes('userop_execution_reverts'), `${path}: ${codes(drained).join()}`);
    assert.deepEqual(of(drained, 'native'), [['out', '0.5', 'simulated_state']], path);
    const given = await preview(operation(a, call('execute', [EP, E / 2n, call('depositTo', [ATTACKER])])), deps);
    assert.deepEqual(of(given, 'native'), [['out', '0.5', 'simulated_state']], path);
    // Deposited for its own later operations, or taken back into its balance: still the account's.
    const kept = await preview(operation(a, call('execute', [EP, E / 2n, call('depositTo', [a])])), deps);
    assert.ok(whole(kept) && !codes(kept).includes('userop_execution_reverts'), `${path}: ${codes(kept).join()}`);
    assert.deepEqual(of(kept, 'native').filter(c => c[2] !== 'requested'), [], path);
    const back = await preview(operation(funded, call('execute', [EP, 0n, call('withdrawTo', [funded, E / 2n])])), deps);
    assert.ok(whole(back), `${path}: ${back.decoding.notes.join(' | ')}`);
    assert.deepEqual(of(back, 'native'), [], path);
  }
});

test('EntryPoint v0.6, v0.8 and v0.9 operations that send the native coin list it', async () => {
  const a6 = await account(EP6), a8 = await account(EP8), a9 = await account(EP9);
  for (const [path, deps] of paths) {
    const p6 = await preview(operation(a6, sendHalf, { paymasterAndData: '0x' }), deps, '0.6');
    assert.ok(p6.decoding.notes.some(n => /whole operation was simulated as EntryPoint v0\.6 runs it/.test(n)), `${path}: ${p6.decoding.notes.join(' | ')}`);
    assert.deepEqual(of(p6, 'native'), [['out', '0.5', 'simulated_state']], path);
    for (const [ep, a] of [[EP8, a8], [EP9, a9]]) {
      const p = await typed(ep, a, wrapHalf, deps);
      assert.ok(whole(p), `${path}: ${p.decoding.notes.join(' | ')}`);
      assert.deepEqual([of(p, 'native'), of(p, wrap)], [[['out', '0.5', 'simulated_state']], [['in', '0.5', 'simulated_state']]], `${path}, ${ep}`);
    }
  }
});

test('eth_simulateV1 on a node that logs no native transfers, or whose balances can’t be read after the run: the prefund is still left out', async () => {
  const a = await account();
  // No pseudo-logs: the account's coin comes from its balance and deposit, read around the run.
  const unlogged = (async (u: string, init: RequestInit) => {
    const res = await withSimulateV1(u, init), body = await res.json() as { result?: { calls: { logs?: { address: string }[] }[] }[] };
    for (const b of body.result ?? []) for (const c of b.calls) if (c.logs) c.logs = c.logs.filter(l => l.address !== '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
    return new Response(JSON.stringify(body));
  }) as typeof fetch;
  const quiet: Dependencies = { tokens, rpc: simulateV1.rpc, simulator: new RpcSimulator({ 999: URL_ }, { fetchImpl: unlogged }) };
  const sent = await preview(operation(a, sendHalf), quiet);
  assert.ok(whole(sent), sent.decoding.notes.join(' | '));
  assert.deepEqual(of(sent, 'native'), [['out', '0.5', 'simulated_state']]);
  // Reads refused (the run asked again without traceTransfers): its transfer per call frame stands, the prefund's left out.
  const unread = (async (u: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { method?: string; params?: [{ traceTransfers?: boolean }] };
    if (body.method === 'eth_simulateV1' && !body.params?.[0]?.traceTransfers) return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'reads refused' } }));
    return withSimulateV1(u, init);
  }) as typeof fetch;
  const busy: Dependencies = { tokens, rpc: simulateV1.rpc, simulator: new RpcSimulator({ 999: URL_ }, { fetchImpl: unread }) };
  const events = await preview(operation(a, sendHalf), busy);
  assert.ok(whole(events) && events.decoding.notes.some(n => /reads refused/.test(n)), events.decoding.notes.join(' | '));
  assert.deepEqual(of(events, 'native'), [['out', '0.5', 'simulated_events']]);
});

test('An account that is its own paymaster pays the gas from its own deposit: gas, not coin its calls send', async () => {
  const a = await chain.deploy('SelfPaymasterAccount', 'address,address', [OWNER, EP]);
  await chain.setBalance(a, 2n * E);
  await chain.exec(EP, call('depositTo', [a]), FUNDER, E);
  for (const [path, deps] of paths) {
    const p = await preview(operation(a, sendHalf, withPaymaster(a)), deps);
    assert.ok(whole(p), `${path}: ${p.decoding.notes.join(' | ')}`);
    assert.match(String(p.details.find(d => d.label === 'Gas cost (simulated)')?.value), /paid by the paymaster/, path);
    // Before: out 0.5 and the gas, the gas being reported apart too.
    assert.deepEqual(of(p, 'native'), [['out', '0.5', 'simulated_state']], path);
  }
});

test('The account’s stake: staking it shows as the coin leaving, taking it back as the coin returning, and withdrawing it to anyone else as the coin sent', async () => {
  const S = parseAbi(['function addStake(uint32)', 'function unlockStake()', 'function withdrawStake(address)']);
  const stake = (fn: string, args: unknown[] = []) => encodeFunctionData({ abi: S, functionName: fn, args } as never);
  const staked = await account(), a = await account();
  await chain.exec(EP, stake('addStake', [1]), staked, E);
  await chain.exec(EP, stake('unlockStake'), staked);
  for (const [path, deps] of paths) {
    const added = await preview(operation(a, call('execute', [EP, E / 2n, stake('addStake', [86_400])])), deps);
    assert.ok(whole(added) && !codes(added).includes('userop_execution_reverts'), `${path}: ${codes(added).join()}`);
    assert.deepEqual(of(added, 'native'), [['out', '0.5', 'simulated_state']], path);
  }
  // (The local EVM's runs alone: the test chain's eth_simulateV1 runs at time 0, before any unstake delay is over.)
  const drained = await preview(operation(staked, call('execute', [EP, 0n, stake('withdrawStake', [ATTACKER])])), fork);
  assert.ok(whole(drained) && !codes(drained).includes('userop_execution_reverts'), codes(drained).join());
  // Before: nothing listed, the account's balance and deposit unmoved.
  assert.deepEqual(of(drained, 'native'), [['out', '1', 'simulated_state']]);
  const back = await preview(operation(staked, call('execute', [EP, 0n, stake('withdrawStake', [staked])])), fork);
  assert.deepEqual(of(back, 'native'), [['in', '1', 'simulated_state']]);
});

test('withoutGas: a stake withdrawn to another address is listed as sent, from the EntryPoint’s event, whether the balances were read or not', () => {
  const a = '0xacc0000000000000000000000000000000000001', PREFUND = 3n * 10n ** 14n, GAS = 10n ** 14n;
  const [topic, account] = encodeEventTopics({ abi: parseAbi(['event StakeWithdrawn(address indexed account, address withdrawAddress, uint256 amount)']), eventName: 'StakeWithdrawn', args: { account: a as Hex } }) as Hex[];
  const logs = [{ address: EP, topics: [topic, account], data: encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [ATTACKER, E]) }];
  // eth_simulateV1's transfers per call frame: the prefund, and the EntryPoint paying the attacker.
  const frames = [{ asset: 'native', from: a, to: EP, raw: PREFUND }, { asset: 'native', from: EP, to: ATTACKER, raw: E }];
  const sent = { asset: 'native', from: a, to: ATTACKER, raw: E };
  const events: SimulationResult = { status: 'success', source: 'test', transfers: frames, logs };
  assert.deepEqual(withoutGas(events, a, EP, GAS).filter(t => t.from === a || t.to === a), [sent]);
  // Read: the balance down by the prefund, the deposit up by what's left of it.
  const read: SimulationResult = { ...events, readAssets: ['native', EP], transfers: [...frames, { asset: EP, from: EP, to: a, raw: PREFUND - GAS }] };
  assert.deepEqual(withoutGas(read, a, EP, GAS).filter(t => t.from === a || t.to === a), [sent]);
  // Withdrawn to the account itself, it is in its balance: the balance read says so, not the event.
  const home = { ...read, logs: [{ ...logs[0], data: encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [a as Hex, E]) }] };
  assert.deepEqual(withoutGas(home, a, EP, GAS).filter(t => t.from === a || t.to === a), []);
});

test('An operation run by its calls alone: its EntryPoint deposit is its own coin, not a token', async () => {
  const a = await chain.deploy('RevertingAccount', 'address', [EP]);
  await chain.setBalance(a, 2n * E);
  await chain.exec(EP, call('depositTo', [a]), FUNDER, E);
  for (const [path, deps] of paths) {
    const kept = await preview(operation(a, call('execute', [EP, E / 2n, call('depositTo', [a])])), deps);
    assert.ok(kept.decoding.notes.some(n => /^The operation's calls were simulated as the EntryPoint runs it/.test(n)), `${path}: ${kept.decoding.notes.join(' | ')}`);
    // Before (eth_simulateV1): "in 500000000000000000" of a token at the EntryPoint's address, the account's deposit.
    assert.deepEqual(of(kept, EP), [], path);
    assert.deepEqual(of(kept, 'native').filter(c => c[2] !== 'requested'), [], path);
    // Before (eth_simulateV1): "out 500000000000000000" of that token.
    const drained = await preview(operation(a, call('execute', [EP, 0n, call('withdrawTo', [ATTACKER, E / 2n])])), deps);
    assert.deepEqual([of(drained, EP), of(drained, 'native')], [[], [['out', '0.5', 'simulated_state']]], path);
  }
});

// BNB Chain's node splits the block's gas among the calls that set none, and a run whose reads leave each less than
// a call's 21,000 is refused ("intrinsic gas too low"): the reads are asked again in a lean pass (leanReads), which
// reads the account's deposit too.
test('eth_simulateV1’s lean pass reads the account’s deposit: the prefund is left out and a drain of the deposit is listed, with native transfers logged or not', async () => {
  const lean = (logged: boolean) => (async (u: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { method?: string; params?: [{ traceTransfers?: boolean; blockStateCalls?: { calls: { gas?: string }[] }[] }] };
    const calls = body.params?.[0]?.blockStateCalls?.[0]?.calls ?? [];
    if (body.method === 'eth_simulateV1' && !body.params?.[0]?.traceTransfers && calls.every(c => !c.gas)) return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'intrinsic gas too low' } }));
    const res = await withSimulateV1(u, init), out = await res.json() as { result?: { calls: { logs?: { address: string }[] }[] }[] };
    if (!logged) for (const b of Array.isArray(out.result) ? out.result : []) for (const c of b.calls) if (c.logs) c.logs = c.logs.filter(l => l.address !== '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
    return new Response(JSON.stringify(out));
  }) as typeof fetch;
  const a = await account(), funded = await account(EP, E);
  for (const logged of [true, false]) {
    const deps: Dependencies = { tokens, rpc: simulateV1.rpc, simulator: new RpcSimulator({ 999: URL_ }, { fetchImpl: lean(logged) }) };
    const sent = await preview(operation(a, sendHalf), deps);
    assert.ok(whole(sent), sent.decoding.notes.join(' | '));
    // Before, without the logs: out 0.5009, the prefund with it.
    assert.deepEqual(of(sent, 'native'), [['out', '0.5', 'simulated_state']], `logged ${logged}`);
    const moved = await preview(operation(a, call('execute', [wrap, 0n, call('transfer', [BOB, E / 4n])])), deps);
    assert.deepEqual([of(moved, 'native'), of(moved, wrap)], [[], [['out', '0.25', 'simulated_state']]], `logged ${logged}`);
    // Before: nothing listed, the deposit unread. (Its call gas limit near what it uses: the lean pass gives the run
    // half as much gas again as it used and 100,000, short of what the EntryPoint asks for a higher limit, AA95.)
    const drained = await preview(operation(funded, call('execute', [EP, 0n, call('withdrawTo', [ATTACKER, E / 2n])]), { callGasLimit: '0x186a0' }), deps);
    assert.deepEqual(of(drained, 'native'), [['out', '0.5', 'simulated_state']], `logged ${logged}`);
  }
});
