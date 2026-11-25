// A batch an account with code runs is one transaction: what a call leaves for the length of a transaction, the next
// finds. Run one transaction per call that is gone, and a batch whose first call opens what its last closes was
// previewed as failing (src/evm/one-transaction.ts). Against a local EVM (test/evm-chain.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionData, parseAbi, type Hex } from 'viem';
import { previewRequest } from '../src/preview.ts';
import { StaticTokenRegistry } from '../src/chains.ts';
import { ForkSimulator } from '../src/fork-simulator.ts';
import { RpcSimulator } from '../src/simulation.ts';
import { accountStandInCode, asOneTransaction, asOneTransactionOfPlain, batchData, BATCHER, failedCall, MOVED } from '../src/evm/one-transaction.ts';
import type { Dependencies, SimulationRequest } from '../src/types.ts';
import { codes, NOW } from './helpers.ts';
import { testChain } from './evm-chain.ts';

const USER = '0x00000000000000000000000000000000000a11ce', BOB = '0xb0b0000000000000000000000000000000000002', URL_ = 'http://chain.invalid';
const chain = await testChain();
const usdc = await chain.deploy('Token', 'string,uint8', ['USDC', 6]);
const executor = await chain.deploy('Executor');
// A contract with a session that lasts a transaction (EIP-1153): called with nothing it opens one (TSTORE), called
// with anything it needs one open (TLOAD) and reverts without.
const SESSION = '0x5e55100000000000000000000000000000005e55';
await chain.putCode(SESSION, '0x36600a57600160005d005b60005c60165760006000fd5b00');
const T = parseAbi(['function mint(address,uint256)', 'function transfer(address,uint256)', 'function execute(address,bytes)']);
const transfer = (amount: bigint) => encodeFunctionData({ abi: T, functionName: 'transfer', args: [BOB as Hex, amount] });
await chain.exec(usdc, encodeFunctionData({ abi: T, functionName: 'mint', args: [USER as Hex, 1000_000_000n] }));
await chain.setBalance(USER, 10n ** 19n);
// The account runs delegated code (EIP-7702): the Executor.
const DELEGATED = `0xef0100${executor.slice(2)}` as Hex;
await chain.putCode(USER, DELEGATED);
const sim = new ForkSimulator({ 1: URL_ }, { fetchImpl: chain.fetchImpl });
const calls = [{ to: SESSION, value: 0n, data: '0x' }, { to: usdc, value: 0n, data: transfer(5_000_000n) }, { to: SESSION, value: 0n, data: '0x01' }];
const request = (c: { to: string; value: bigint; data: string }): SimulationRequest => ({ chainId: 1, from: USER, to: c.to, data: c.data, value: c.value });
const one = (cs: typeof calls, code: string = DELEGATED, account = USER) => { const o = asOneTransaction(account, code, cs)!; return sim.simulate({ chainId: 1, from: account, to: account, data: o.data, value: 0n, stateOverrides: o.overrides }); };

test('The calls of a batch run as one transaction, from the account, with what a call leaves for the transaction kept', async () => {
  // One transaction each, in order: the session the first call opens is gone by the third.
  const each = (await sim.simulateBatch(calls.map(request)))!;
  assert.deepEqual(each.map(r => r.status), ['success', 'success', 'reverted']);
  // As one: they all go through, and the token moves from the account.
  const whole = (await one(calls))!;
  assert.equal(whole.status, 'success');
  assert.deepEqual(whole.transfers.filter(t => t.asset === usdc).map(t => [t.from, t.raw]), [[USER, 5_000_000n]]);
  // A call that fails fails the transaction, and nothing of the calls before it stays.
  const failing = (await one([calls[0], { to: usdc, value: 0n, data: transfer(2000_000_000n) }, calls[2]]))!;
  assert.equal(failing.status, 'reverted');
  assert.deepEqual((await one([calls[1], calls[2]]))!.status, 'reverted');
  // Coin a call sends is the account's.
  const paying = (await one([calls[0], { to: BOB, value: 10n ** 18n, data: '0x' }, calls[2]]))!;
  assert.deepEqual([paying.status, paying.transfers.filter(t => t.asset === 'native').map(t => [t.from, t.raw])], ['success', [[USER, 10n ** 18n]]]);
});

test('What isn’t the batch goes to the account’s real code: a call the batch makes to the account itself, and a call from outside', async () => {
  // A call back into the account inside the batch runs the account's own code (the Executor's execute), as the account.
  const viaSelf = encodeFunctionData({ abi: T, functionName: 'execute', args: [usdc as Hex, transfer(7_000_000n)] });
  const self = (await one([calls[0], { to: USER, value: 0n, data: viaSelf }, calls[2]]))!;
  assert.deepEqual([self.status, self.transfers.filter(t => t.asset === usdc).map(t => [t.from, t.raw])], ['success', [[USER, 7_000_000n]]]);
  // From another sender, the account is what it was: its real code runs, whatever the calldata (the batch's too).
  const o = asOneTransaction(USER, DELEGATED, calls)!;
  const outside = (await sim.simulate({ chainId: 1, from: BOB, to: USER, data: viaSelf, value: 0n, stateOverrides: o.overrides }))!;
  assert.deepEqual([outside.status, outside.transfers.filter(t => t.asset === usdc).map(t => [t.from, t.raw])], ['success', [[USER, 7_000_000n]]]);
  const notTheAccount = (await sim.simulate({ chainId: 1, from: BOB, to: USER, data: batchData(calls), value: 0n, stateOverrides: o.overrides }))!;
  assert.deepEqual(notTheAccount.transfers, []);
  // What is set for the run: the account delegated to the batching code, which hands on to the code it delegated to.
  assert.deepEqual([Object.keys(o.overrides).sort(), o.overrides[USER].code, o.overrides[BATCHER].code!.includes(executor.slice(2))], [[USER, BATCHER].sort(), `0xef0100${BATCHER.slice(2)}`, true]);
  // A contract account's own code is moved for the run, and runs from there as the account.
  const CONTRACT = '0xc0de00000000000000000000000000000000c0de';
  const code = `0x${Buffer.from(await chain.evm.stateManager.getCode((await import('@ethereumjs/util')).createAddressFromString(executor))).toString('hex')}`;
  await chain.putCode(CONTRACT, code as Hex);
  await chain.exec(usdc, encodeFunctionData({ abi: T, functionName: 'mint', args: [CONTRACT as Hex, 50_000_000n] }));
  const moved = asOneTransaction(CONTRACT, code, [calls[0], { to: CONTRACT, value: 0n, data: viaSelf }, calls[2]])!;
  assert.deepEqual([Object.keys(moved.overrides).sort(), moved.overrides[MOVED].code], [[CONTRACT, BATCHER, MOVED].sort(), code]);
  const ran = (await sim.simulate({ chainId: 1, from: CONTRACT, to: CONTRACT, data: moved.data, value: 0n, stateOverrides: moved.overrides }))!;
  assert.deepEqual([ran.status, ran.transfers.filter(t => t.asset === usdc).map(t => [t.from, t.raw])], ['success', [[CONTRACT, 7_000_000n]]]);
  // A plain account's calls are a transaction each, and a creation isn't a call: neither is run so.
  assert.equal(asOneTransaction(USER, '0x', calls), null);
  assert.equal(asOneTransaction(USER, DELEGATED, [{ to: null, value: 0n, data: '0x6000' }]), null);
});

test('A wallet_sendCalls batch from an account with code that fails one transaction per call is shown as the one transaction it is', async () => {
  const deps: Dependencies = { tokens: new StaticTokenRegistry(), simulator: new RpcSimulator({ 1: URL_ }, { fetchImpl: chain.fetchImpl, fork: sim }), rpc: { has: () => true, call: async (_c: number, m: string, p: unknown[]) => {
    const r = await chain.fetchImpl(URL_, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }) });
    const j = await r.json() as { result?: unknown; error?: { message: string } };
    if (j.error) throw new Error(j.error.message);
    return j.result;
  } } };
  const send = (cs: typeof calls, from = USER, atomicRequired = true) => previewRequest({ method: 'wallet_sendCalls', params: [{ version: '2.0.0', chainId: '0x1', from, atomicRequired, calls: cs.map(c => ({ to: c.to, data: c.data, value: `0x${c.value.toString(16)}` })) }] }, { now: NOW }, deps);
  // It was "This batch is all-or-nothing, and call 3 is expected to fail": a danger, of a batch that goes through.
  const p = await send(calls);
  assert.equal(p.simulation?.status, 'success');
  assert.match(p.simulation?.source ?? '', /3 calls as one transaction$/);
  assert.ok(!codes(p).includes('batch_will_fail') && !codes(p).includes('simulation_reverted'), codes(p).join());
  assert.deepEqual(p.assetChanges.map(c => [c.asset, c.direction, c.raw, c.basis]), [[usdc, 'out', '5000000', 'simulated_state']], JSON.stringify(p.assetChanges));
  assert.match(p.decoding.notes.join(' '), /Run one transaction each, call 3 fails; run as one transaction, as an account with code runs a batch, they all go through/);
  // One that fails as one transaction too is the failure it was.
  const failing = await send([calls[1], calls[2]]);
  assert.deepEqual([failing.simulation?.status, codes(failing).includes('batch_will_fail')], ['reverted', true]);
  // A plain account's calls are a transaction each, where the batch needn't be all or nothing: nothing is run again.
  const PLAIN = '0x00000000000000000000000000000000000b0b00';
  await chain.setBalance(PLAIN, 10n ** 18n);
  await chain.exec(usdc, encodeFunctionData({ abi: T, functionName: 'mint', args: [PLAIN as Hex, 100_000_000n] }));
  const each = await send([calls[0], calls[2]], PLAIN, false);
  assert.deepEqual([each.simulation?.status, codes(each).includes('batch_partial_failure'), /as one transaction/.test(each.simulation?.source ?? '')], ['reverted', true, false]);

  // An all-or-nothing batch of a plain account's is one transaction: the wallet gives the account code for it
  // (EIP-7702). It was "call 3 is expected to fail, so none of the calls would take effect", of a batch that goes
  // through so: run on a stand-in for that code, the session the first call opens is there for the third.
  const atomic = await send(calls, PLAIN);
  assert.equal(atomic.simulation?.status, 'success');
  assert.match(atomic.simulation?.source ?? '', /3 calls as one transaction$/);
  assert.ok(!codes(atomic).includes('batch_will_fail') && !codes(atomic).includes('simulation_reverted'), codes(atomic).join());
  assert.deepEqual(atomic.assetChanges.map(c => [c.asset, c.direction, c.raw, c.basis]), [[usdc, 'out', '5000000', 'simulated_state']], JSON.stringify(atomic.assetChanges));
  assert.match(atomic.decoding.notes.join(' '), /Run one transaction each, call 3 fails\. The batch is all-or-nothing, which a wallet makes of a plain account's calls by giving the account smart-account code \(EIP-7702\) and running them as one transaction: run so, on a stand-in for that code \(which code is the wallet's choice\), they all go through/);
  // One that fails as one transaction too is the failure it was.
  const stillFails = await send([calls[1], calls[2]], PLAIN);
  assert.deepEqual([stillFails.simulation?.status, codes(stillFails).includes('batch_will_fail')], ['reverted', true]);

  // And the other way: calls that go through a transaction each, and fail as the one transaction, where a contract
  // takes no caller that has code (EXTCODESIZE of its caller). Shown as run, a transaction each, with that said.
  const NO_CODE_ONLY = '0x0c0de00000000000000000000000000000000001';
  await chain.putCode(NO_CODE_ONLY, '0x333b600657005b60006000fd');
  const picky = await send([{ to: NO_CODE_ONLY, value: 0n, data: '0x' }, calls[1]], PLAIN);
  assert.equal(picky.simulation?.status, 'success');
  assert.match(picky.simulation?.source ?? '', /2 calls in order$/);
  assert.match(picky.warnings.find(w => w.code === 'atomic_batch_fails_as_one')?.message ?? '', /Run so here, on a stand-in for that code \(which code is the wallet's choice\), call 1 fails, and with it the whole batch: a contract can refuse or treat differently a caller that has code\. What is shown is the calls run a transaction each, which go through\.$/);
  assert.equal(picky.attention, 'caution');
  // (Not said of a batch that goes through both ways, nor of one that needn't be all or nothing.)
  assert.ok(!codes(await send([calls[1]].concat([calls[1]]), PLAIN)).includes('atomic_batch_fails_as_one'));
  assert.ok(!codes(await send([{ to: NO_CODE_ONLY, value: 0n, data: '0x' }, calls[1]], PLAIN, false)).includes('atomic_batch_fails_as_one'));
});

test('The stand-in for the code a wallet gives a plain account: coin is taken, and a call is answered with its selector', async () => {
  const PLAIN = '0x00000000000000000000000000000000000b0b01';
  await chain.setBalance(PLAIN, 10n ** 18n);
  const o = asOneTransactionOfPlain(PLAIN, calls)!;
  assert.deepEqual([Object.keys(o.overrides).sort(), o.overrides[PLAIN].code, o.overrides[MOVED].code], [[PLAIN, BATCHER, MOVED].sort(), `0xef0100${BATCHER.slice(2)}`, accountStandInCode()]);
  // From outside, as a token asks an account that has code whether it takes a transfer (onERC721Received), or a
  // contract whether a signature is the account's (isValidSignature): its own selector, in a word.
  for (const selector of ['150b7a02', '1626ba7e', 'f23a6e61']) {
    const asked = (await sim.simulate({ chainId: 1, from: BOB, to: PLAIN, data: `0x${selector}${'00'.repeat(96)}`, value: 0n, stateOverrides: o.overrides }))!;
    assert.deepEqual([asked.status, asked.returnData], ['success', `0x${selector}${'00'.repeat(28)}`]);
  }
  // Coin sent to it is taken.
  await chain.setBalance(BOB, 10n ** 18n);
  const paid = (await sim.simulate({ chainId: 1, from: BOB, to: PLAIN, data: '0x', value: 5n, stateOverrides: o.overrides }))!;
  assert.equal(paid.status, 'success');
  // A creation isn't a call.
  assert.equal(asOneTransactionOfPlain(PLAIN, [{ to: null, value: 0n, data: '0x6000' }]), null);
  // What the batching code reverts with says which call failed, and what it returned.
  assert.deepEqual(failedCall(`0x${'00'.repeat(31)}02deadbeef`), { index: 2, data: '0xdeadbeef' });
  assert.deepEqual(failedCall(`0x${'00'.repeat(32)}`), { index: 0, data: '0x' });
  assert.deepEqual([failedCall('0x08c379a0'), failedCall(undefined), failedCall(`0x${'ff'.repeat(32)}`)], [null, null, null]);
});
