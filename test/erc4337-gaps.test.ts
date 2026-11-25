// UserOperations that weren't previewed whole for reasons other than their signature, found by replaying 2,025
// operations on six chains against their receipts: an operation with no calls (on BNB Chain, Kernel accounts deployed
// so through ZeroDev's FactoryStaker), a paymaster that refuses other bundlers in its charge after the calls (postOp:
// Coinbase's VerifyingPaymaster on Base), and the node failing the simulation (Polygon, and Arbitrum One under HTTP 429).
// Run by the fork simulator on test/evm-chain.ts, with code read from the chains (test/fixtures/erc4337-gaps.json)
// where it matters: Kernel v3.1, its factories and ZeroDev's ECDSA validator at their own addresses (in a file of its
// own: the fork simulator keeps the code it reads at an address for the process, and other tests run other code there).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { concatHex, encodeAbiParameters, encodeFunctionData, getContractAddress, keccak256, numberToHex, pad, parseAbi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createAddressFromString, hexToBytes, unpadBytes } from '@ethereumjs/util';
import { previewRequest } from '../src/preview.ts';
import { StaticTokenRegistry } from '../src/chains.ts';
import { RpcSimulator } from '../src/simulation.ts';
import { JsonRpcClient } from '../src/rpc.ts';
import { ForkSimulator } from '../src/fork-simulator.ts';
import { ENTRY_POINT_SIMULATIONS_V06, ENTRY_POINT_SIMULATIONS_V07, ENTRY_POINT_SIMULATIONS_V08 } from '../src/entrypoint-simulations.ts';
import { simulateExecution } from '../src/erc4337-sim.ts';
import { readOperation, userOpHash } from '../src/userop-hash.ts';
import type { Dependencies, Preview, SimulationRequest } from '../src/types.ts';
import { codes, detail, NOW } from './helpers.ts';
import { compiled, testChain } from './evm-chain.ts';

const EP = '0x0000000071727de22e5e9d8baf0edac6f37da032', EP6 = '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789';
const OWNER = privateKeyToAccount('0x7777777777777777777777777777777777777777777777777777777777777777').address.toLowerCase();
const BOB = '0xb0b0000000000000000000000000000000000002';
const URL_ = 'http://hyperevm.invalid';
const E = 10n ** 18n;
const FUNDER = '0xde9100000000000000000000000000000000d001';
type Fixture = {
  kernelDeploy: { transaction: Hex; operation: Record<string, Hex> & { sender: string }; contracts: Record<string, Hex>; storage: Record<string, Record<string, Hex>> };
  verifyingPaymaster: { address: string; code: Hex; verifyingSignerSlot: Hex; isBundlerAllowedSlot: Hex; bundler: string };
};
const fx = JSON.parse(readFileSync(new URL('./fixtures/erc4337-gaps.json', import.meta.url), 'utf8')) as Fixture;

const chain = await testChain();
const usdc = await chain.deploy('Token', 'string,uint8', ['USDC', 6]);
await chain.putCode(EP, ENTRY_POINT_SIMULATIONS_V07 as Hex);
await chain.putCode(EP6, ENTRY_POINT_SIMULATIONS_V06 as Hex);
await chain.setBalance(FUNDER, 100n * E);
const put = (a: string, slot: Hex, value: Hex) => chain.evm.stateManager.putStorage(createAddressFromString(a), hexToBytes(pad(slot, { size: 32 })), unpadBytes(hexToBytes(pad(value, { size: 32 }))));
const A = parseAbi(['function mint(address,uint256)', 'function transfer(address,uint256)', 'function approve(address,uint256)', 'function depositTo(address)', 'function execute(address,uint256,bytes)', 'function installModule(uint256,address,bytes)']);
const call = (fn: string, args: unknown[]) => encodeFunctionData({ abi: A, functionName: fn, args } as never);
const sendUsdc = call('execute', [usdc, 0n, call('transfer', [BOB, 50_000_000n])]);
const deps: Dependencies = {
  tokens: new StaticTokenRegistry({ 999: [{ address: usdc, symbol: 'USDC', decimals: 6, name: 'USD Coin' }] }),
  rpc: new JsonRpcClient({ 999: URL_ }, { fetchImpl: chain.fetchImpl }),
  simulator: new RpcSimulator({ 999: URL_ }, { fetchImpl: chain.fetchImpl, fork: new ForkSimulator({ 999: URL_ }, { fetchImpl: chain.fetchImpl }) }),
};
const preview = (op: Record<string, unknown>, signer: string, d: Dependencies = deps, version: '0.6' | '0.7' = '0.7'): Promise<Preview> => {
  const ep = version === '0.6' ? EP6 : EP;
  return previewRequest({ method: 'personal_sign', params: [userOpHash(readOperation(op, version)!, ep, 999, version), signer] }, { now: NOW, chainId: 999, userOperation: { entryPoint: ep, operation: op } }, d);
};
const whole = (p: Preview) => p.decoding.notes.find(n => /whole operation was simulated/.test(n));
const usdcChange = (p: Preview) => p.assetChanges.filter(c => c.symbol === 'USDC').map(c => `${c.direction} ${c.amount}`);
const account = async () => {
  const a = await chain.deploy('ModularAccount4337', 'address,address', [OWNER, EP]);
  await chain.exec(usdc, call('mint', [a, 100_000_000n]));
  await chain.setBalance(a, E);
  return a;
};
const v07 = (sender: string, m: Record<string, unknown> = {}) => ({ sender, nonce: '0x0', callData: sendUsdc, callGasLimit: '0x30d40', verificationGasLimit: '0x30d40', preVerificationGas: '0xc350', maxFeePerGas: '0x77359400', maxPriorityFeePerGas: '0x3b9aca00', ...m });

test('An operation that only deploys a Kernel account (empty callData, ZeroDev’s FactoryStaker): simulated whole, its deployment, validation and gas, and the validator it installs', async () => {
  // Kernel v3.1, its FactoryStaker (the KernelFactory approved there), the KernelFactory, ZeroDev's ECDSA validator and
  // EntryPoint v0.7's SenderCreator, as on BNB Chain; the operation is the one mined in the fixture's transaction.
  const k = fx.kernelDeploy;
  for (const [a, code] of Object.entries(k.contracts)) await chain.putCode(a, code);
  for (const [a, slots] of Object.entries(k.storage)) for (const [slot, v] of Object.entries(slots)) await put(a, slot as Hex, v);
  const o = k.operation;
  const limits = (w: Hex) => [BigInt(`0x${w.slice(2, 34)}`), BigInt(`0x${w.slice(34)}`)];
  const [verification, callGas] = limits(o.accountGasLimits), [priority, maxFee] = limits(o.gasFees);
  const op = { sender: o.sender, nonce: o.nonce, factory: `0x${o.initCode.slice(2, 42)}`, factoryData: `0x${o.initCode.slice(42)}`, callData: '0x', callGasLimit: numberToHex(callGas), verificationGasLimit: numberToHex(verification),
    preVerificationGas: o.preVerificationGas, maxFeePerGas: numberToHex(maxFee), maxPriorityFeePerGas: numberToHex(priority) };
  // Its owner, in the ECDSA validator's install data (the operation's real signature recovers to it too).
  const owner = '0x9e9ea23ffdcd35cfad22146c7e1a32eee59abfaa';
  const p = await preview(op, owner);
  assert.equal(p.title, 'Sign a UserOperation: deploy 0x7622…3ece');
  assert.match(p.summary, /deploys the account through its factory 0xd703…42d5 and makes no calls after/);
  assert.match(whole(p) ?? p.decoding.notes.join(' | '), /deploying the account through its factory, validation \(with a stand-in .*attributes it to the signer\), and the gas payment \(it makes no calls\)/);
  assert.ok(!codes(p).includes('userop_rejected'), codes(p).join());
  // The gas the EntryPoint counts: its pre-verification gas and the deployment's and validation's, within its limits
  // (this chain's rules aren't BNB Chain's; replayed there, against its receipt, it is 0.09% over).
  const used = BigInt(String(p.details.find(d => d.label === 'Gas used (simulated)')?.raw));
  assert.ok(used > BigInt(o.preVerificationGas) + 100_000n && used <= BigInt(o.preVerificationGas) + verification, String(used));
  // What the deployment installs: Kernel logs its root validator (ERC-7579's ModuleInstalled).
  assert.equal(detail(p, 'Modules installed (simulated)'), 'validator 0x845adb2c711129d4f3966735ed98a9f09fc4ce57');
  // (Its root, the one validator its deployment installs, which took the owner's stand-in: not a caution.)
  assert.ok(!codes(p).includes('userop_installs_validator'), codes(p).join());
  // Where it can't run whole, its deployment alone runs, not a call to the account with no data.
  const alone = await simulateExecution({ chainId: 999, entryPoint: EP, sender: o.sender, callData: '0x', initCode: o.initCode }, deps);
  assert.equal(alone?.requests?.length, 1);
  assert.equal(alone?.result.status, 'success');
});

test('An operation with no calls and nothing to deploy: simulated whole, its nonce used up and its gas paid', async () => {
  const a = await account();
  const p = await preview(v07(a, { callData: '0x' }), OWNER);
  assert.equal(p.title, 'Sign a UserOperation: no calls from 0x' + a.slice(2, 6) + '…' + a.slice(-4));
  assert.match(p.summary, /It makes no calls: it runs the account's validation, uses up nonce 0 \(no other operation signed with it can run after it\) and pays for its gas\./);
  assert.match(whole(p) ?? p.decoding.notes.join(' | '), /validation \(with a stand-in .*\), and the gas payment \(it makes no calls\)/);
  assert.match(String(detail(p, 'Gas cost (simulated)')), /paid by the account/);
  assert.deepEqual(usdcChange(p), []);
});

test('Modules an operation installs on the account are listed, and an executor is a caution', async () => {
  const a = await account();
  const EXECUTOR = '0xe8ec000000000000000000000000000000000e8e';
  const p = await preview(v07(a, { callData: call('installModule', [2n, EXECUTOR, '0x']) }), OWNER);
  assert.ok(whole(p), p.decoding.notes.join(' | '));
  assert.equal(detail(p, 'Modules installed (simulated)'), `executor ${EXECUTOR}`);
  assert.match(p.warnings.find(w => w.code === 'userop_installs_executor')?.message ?? '', /installs an executor module on the account \(0xe8ec…0e8e\): an executor can have the account make calls with no signature from its owners/);
});

/** A node whose lookup of a paymaster's recent bundles (its UserOperationEvents) answers `delayMs` late: `bundler` sent them. */
function lookupNode(bundler: string, delayMs: number): Dependencies['rpc'] {
  return { has: (c: number) => deps.rpc!.has(c), call: async (c: number, m: string, ps: unknown[]) => {
    if (m === 'eth_blockNumber') return '0x100';
    if (m === 'eth_getLogs') { await new Promise(r => setTimeout(r, delayMs)); return [{ transactionHash: `0x${'ab'.repeat(32)}`, data: '0x' }]; }
    if (m === 'eth_getTransactionByHash') return { from: bundler, input: '0x' };
    return deps.rpc!.call(c, m, ps);
  } } as Dependencies['rpc'];
}

test('Coinbase’s VerifyingPaymaster refusing other bundlers in postOp (EntryPoint v0.6, AA50): run again as the bundler its operations came through', async () => {
  // Its code as on Base (at its own address, and at another for a second case: what a lookup finds is remembered by
  // paymaster), with a signer of the test's own and one bundler on its list.
  const pm = fx.verifyingPaymaster, SIGNER = privateKeyToAccount('0x3333333333333333333333333333333333333333333333333333333333333333');
  const ALLOWED = '0xb0d1e70000000000000000000000000000054337';
  const a = await chain.deploy('Account4337V06', 'address,address', [OWNER, EP6]);
  await chain.exec(usdc, call('mint', [a, 100_000_000n]));
  const GET_HASH = parseAbi(['struct UserOperation { address sender; uint256 nonce; bytes initCode; bytes callData; uint256 callGasLimit; uint256 verificationGasLimit; uint256 preVerificationGas; uint256 maxFeePerGas; uint256 maxPriorityFeePerGas; bytes paymasterAndData; bytes signature; }',
    'struct PaymasterData { uint48 validUntil; uint48 validAfter; uint128 sponsorUUID; bool allowAnyBundler; bool precheckBalance; bool prepaymentRequired; address token; address receiver; uint256 exchangeRate; uint48 postOpGas; }',
    'function getHash(UserOperation userOp, PaymasterData paymasterData) view returns (bytes32)']);
  const ZERO = `0x${'00'.repeat(20)}` as Hex;
  // The operation sponsored by the paymaster at `at`: its data (validUntil, validAfter, sponsorUUID, allowAnyBundler 0,
  // precheckBalance, prepaymentRequired, token, receiver, exchangeRate, postOpGas), then its signer's signature over
  // getHash's hash, as the paymaster computes it.
  const sponsored = async (at: string, nonce: bigint) => {
    await chain.putCode(at, pm.code);
    await put(at, pm.verifyingSignerSlot, SIGNER.address);
    await put(at, keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [ALLOWED as Hex, BigInt(pm.isBundlerAllowedSlot)])), '0x01');
    await chain.exec(EP6, call('depositTo', [at]), FUNDER, E);
    const op = { sender: a, nonce: numberToHex(nonce), initCode: '0x', callData: sendUsdc, callGasLimit: '0x30d40', verificationGasLimit: '0x30d40', preVerificationGas: '0xc350', maxFeePerGas: '0x77359400', maxPriorityFeePerGas: '0x3b9aca00' };
    const data = { validUntil: 0, validAfter: 0, sponsorUUID: 7n, allowAnyBundler: false, precheckBalance: false, prepaymentRequired: false, token: ZERO, receiver: ZERO, exchangeRate: 0n, postOpGas: 0 };
    const unsigned = { sender: a as Hex, nonce, initCode: '0x' as Hex, callData: sendUsdc, callGasLimit: 200_000n, verificationGasLimit: 200_000n, preVerificationGas: 50_000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, paymasterAndData: '0x' as Hex, signature: '0x' as Hex };
    const hash = String(await deps.rpc!.call(999, 'eth_call', [{ to: at, data: encodeFunctionData({ abi: GET_HASH, functionName: 'getHash', args: [unsigned, data] }) }, 'latest'])) as Hex;
    const signature = await SIGNER.signMessage({ message: { raw: hash } });
    return { ...op, paymasterAndData: concatHex([at as Hex, '0x000000000000', '0x000000000000', numberToHex(7n, { size: 16 }), '0x00', '0x00', '0x00', ZERO, ZERO, `0x${'00'.repeat(32)}`, '0x000000000000', signature]) };
  };
  // Who each whole run is sent as (tx.origin).
  const sent: string[] = [];
  const real = deps.simulator!;
  const simulator = { ...real, simulate: (r: SimulationRequest) => { if (r.to?.toLowerCase() === EP6) sent.push(r.from); return real.simulate(r); } } as unknown as Dependencies['simulator'];
  // Its bundler found 1.6 s on, later than the first run waits for it: the first run is the simulation's own address's,
  // which postOp refuses, and the next its bundler's.
  const p = await preview(await sponsored(pm.address, 0n), OWNER, { ...deps, rpc: lookupNode(ALLOWED, 1600), simulator }, '0.6');
  assert.ok(!codes(p).includes('userop_rejected'), p.warnings.map(w => w.message).join(' | '));
  assert.ok(whole(p), p.decoding.notes.join(' | '));
  assert.deepEqual(sent, ['0x0000000000000000000000000000000000004337', ALLOWED]);
  assert.match(String(detail(p, 'Gas cost (simulated)')), /paid by the paymaster 0x8bf5…e105/);
  assert.deepEqual(usdcChange(p), ['out 50']);
  // With none of its bundlers found, run as anyone else: the postOp refusal stands (AA50), as before.
  const nobody = { has: (c: number) => deps.rpc!.has(c), call: async (c: number, m: string, ps: unknown[]) => (m === 'eth_blockNumber' ? '0x100' : m === 'eth_getLogs' ? [] : deps.rpc!.call(c, m, ps)) } as Dependencies['rpc'];
  const refused = await preview(await sponsored('0x8bf5000000000000000000000000000000008bf5', 0n), OWNER, { ...deps, rpc: nobody }, '0.6');
  assert.match(refused.warnings.find(w => w.code === 'userop_rejected')?.message ?? '', /the paymaster's charge after the calls \(postOp\) fails \(AA50 postOp revert\)/);
});

test('A paymaster refusing other bundlers in postOp on EntryPoint v0.7 (the calls undone): run again as its bundler, the calls standing', async () => {
  const ALLOWED = '0xb0d1e70000000000000000000000000000064337';
  const picky = await chain.deploy('PostOpBundlerPaymaster', 'address,address', [EP, ALLOWED]);
  await chain.exec(EP, call('depositTo', [picky]), FUNDER, E);
  const a = await account();
  // (Its bundler found later than the first run waits for it, as above.)
  const p = await preview(v07(a, { paymaster: picky, paymasterVerificationGasLimit: '0x186a0', paymasterPostOpGasLimit: '0x186a0', paymasterData: '0x' }), OWNER, { ...deps, rpc: lookupNode(ALLOWED, 1600) });
  assert.ok(!codes(p).includes('userop_postop_reverts'), p.warnings.map(w => w.message).join(' | '));
  assert.ok(whole(p), p.decoding.notes.join(' | '));
  assert.deepEqual(usdcChange(p), ['out 50']);
});

test('A paymaster that works otherwise for a bundler it doesn’t know, without refusing it: run again as its bundler once the lookup answers', async () => {
  // It pays for anyone, and takes its fee (0.03654 USDC, after the calls) only from a bundle its own bundler sends.
  // On Arbitrum One (2026-11-25) such a paymaster's operation, previewed with the lookup of its bundlers still
  // unanswered when the run started, showed no fee and 39.8% less gas than it used: nothing was refused, so the run
  // as the simulation's own address stood.
  const OWN = '0xb0d1e70000000000000000000000000000074337';
  const quiet = await chain.deploy('OwnBundlerFeePaymaster', 'address,address,address', [EP, usdc, OWN]);
  await chain.exec(EP, call('depositTo', [quiet]), FUNDER, E);
  const a = await account();
  await chain.exec(usdc, call('approve', [quiet, (1n << 256n) - 1n]), a);
  const sent: string[] = [];
  const real = deps.simulator!;
  const simulator = { ...real, simulate: (r: SimulationRequest) => { if (r.to?.toLowerCase() === EP) sent.push(r.from); return real.simulate(r); } } as unknown as Dependencies['simulator'];
  const op = v07(a, { paymaster: quiet, paymasterVerificationGasLimit: '0x186a0', paymasterPostOpGasLimit: '0x186a0', paymasterData: '0x' });
  // Its bundler found 1.6 s on, after the first run has started as the simulation's own address: run again as it.
  const p = await preview(op, OWNER, { ...deps, rpc: lookupNode(OWN, 1600), simulator });
  assert.ok(whole(p), p.decoding.notes.join(' | '));
  assert.deepEqual(sent, ['0x0000000000000000000000000000000000004337', OWN]);
  assert.deepEqual(usdcChange(p), ['out 50.03654'], 'the fee its own bundler\'s bundle pays is in what leaves');
  // (Remembered: the next preview runs as its bundler from the start.)
  sent.length = 0;
  const again = await preview(op, OWNER, { ...deps, rpc: lookupNode(OWN, 0), simulator });
  assert.deepEqual([sent, usdcChange(again)], [[OWN], ['out 50.03654']]);
});

/** The test chain's simulator, with the whole operation's runs (to an EntryPoint) failing as `fail` says, counted. */
function failingNode(fail: (n: number) => 'throw' | 'revert' | null) {
  const real = deps.simulator!;
  let n = 0;
  const wrap = async (rs: SimulationRequest[], go: () => Promise<unknown>) => {
    if (!rs.some(r => r.to && [EP, EP6].includes(r.to.toLowerCase()))) return go();
    const how = fail(n++);
    if (how === 'throw') throw new Error('RPC HTTP 429');
    if (how === 'revert') return rs.map(() => ({ status: 'reverted', source: 'test', revertReason: 'out of gas', transfers: [] }));
    return go();
  };
  const simulator = { ...real, simulate: (r: SimulationRequest) => wrap([r], () => real.simulate(r)).then(x => (Array.isArray(x) ? x[0] : x)),
    simulateBatch: (rs: SimulationRequest[]) => wrap(rs, () => real.simulateBatch!(rs)) } as unknown as Dependencies['simulator'];
  return { simulator, runs: () => n };
}

test('A node failure during the whole operation’s run: asked once more, and if it still fails, said to be the node’s, not left as the calls alone', async () => {
  const a = await account();
  // Refused once (HTTP 429, after the client's own retries): asked again, the whole operation runs.
  const once = failingNode(n => (n === 0 ? 'throw' : null));
  const p = await preview(v07(a), OWNER, { ...deps, simulator: once.simulator });
  assert.ok(whole(p), p.decoding.notes.join(' | '));
  assert.ok(!codes(p).includes('userop_simulation_failed'));
  assert.deepEqual(usdcChange(p), ['out 50']);
  // Refused every time: the node's failure is said, and the calls alone are what is shown.
  const always = failingNode(() => 'throw');
  const q = await preview(v07(a), OWNER, { ...deps, simulator: always.simulator });
  assert.equal(always.runs(), 2);
  assert.ok(!whole(q));
  assert.match(q.warnings.find(w => w.code === 'userop_simulation_failed')?.message ?? '', /^The chain's node failed the whole operation's simulation, asked twice \(RPC HTTP 429\): its validation, gas payment and any paymaster's charge aren't shown\. That is the node's failure, not the operation's or its account's; previewing it again can get past it\.$/);
  assert.ok(q.decoding.notes.some(n => /The operation's calls were simulated as the EntryPoint runs it/.test(n)), q.decoding.notes.join(' | '));
  assert.ok(!codes(q).includes('userop_rejected'));
  // A run that reverts without any of the EntryPoint's reasons (FailedOp): not asked again, said as the node's.
  const reverting = failingNode(() => 'revert');
  const r = await preview(v07(a), OWNER, { ...deps, simulator: reverting.simulator });
  assert.equal(reverting.runs(), 1);
  assert.match(r.warnings.find(w => w.code === 'userop_simulation_failed')?.message ?? '', /failed the whole operation's simulation \(its run reverted without any of the EntryPoint's reasons \(out of gas\)\)/);
});

test('Modules installed: a validator the calls install on an existing account is a caution; the one validator a deployment installs, its root, isn’t', async () => {
  const a = await account();
  const OTHER = '0xa77ac0000000000000000000000000000000a77a';
  const p = await preview(v07(a, { callData: call('installModule', [1n, OTHER, '0x']) }), OWNER);
  assert.ok(whole(p), p.decoding.notes.join(' | '));
  assert.equal(detail(p, 'Modules installed (simulated)'), `validator ${OTHER}`);
  assert.match(p.warnings.find(w => w.code === 'userop_installs_validator')?.message ?? '', /installs a validator module on the account \(0xa77a…a77a\): a validator decides whose signatures the account takes, so whoever it names can sign the account's operations\.$/);
  // (The Kernel account deployed above installs ZeroDev's ECDSA validator as its root, and its owner's stand-in
  // validated through it: listed, no caution.)
});

/** The test chain's simulator, failing (HTTP 429, after its own retries) every whole run sent by `failing`: who sent each. */
function failingFrom(failing: string) {
  const real = deps.simulator!, sent: string[] = [];
  const check = (rs: SimulationRequest[]) => {
    const ep = rs.filter(r => r.to?.toLowerCase() === EP);
    for (const r of ep) sent.push(r.from.toLowerCase());
    if (ep.some(r => r.from.toLowerCase() === failing)) throw new Error('RPC HTTP 429');
  };
  const simulator = { ...real, simulate: async (r: SimulationRequest) => { check([r]); return real.simulate(r); }, simulateBatch: async (rs: SimulationRequest[]) => { check(rs); return real.simulateBatch!(rs); } } as unknown as Dependencies['simulator'];
  return { simulator, sent };
}

test('A paymaster refusing the simulation’s own bundler, and the node failing the run as the bundler it takes: the node’s failure, not a rejection', async () => {
  const ALLOWED = '0xb0d1e70000000000000000000000000000074337';
  const picky = await chain.deploy('BundlerPaymaster', 'address,address', [EP, ALLOWED]);
  await chain.exec(EP, call('depositTo', [picky]), FUNDER, E);
  const a = await account();
  // Its bundler found later than the first run waits for it (as above), and every run sent as it failed by the node.
  const f = failingFrom(ALLOWED);
  const p = await preview(v07(a, { paymaster: picky, paymasterVerificationGasLimit: '0x186a0', paymasterPostOpGasLimit: '0x186a0', paymasterData: '0x' }), OWNER, { ...deps, rpc: lookupNode(ALLOWED, 1600), simulator: f.simulator });
  assert.deepEqual(f.sent, ['0x0000000000000000000000000000000000004337', ALLOWED, ALLOWED]);
  assert.ok(!codes(p).includes('userop_rejected'), p.warnings.map(w => w.message).join(' | '));
  assert.match(p.warnings.find(w => w.code === 'userop_simulation_failed')?.message ?? '', /asked twice \(the paymaster refused the simulation's own bundler \(AA33\), and the run as a bundler it took lately failed: RPC HTTP 429\)/);
  assert.ok(!whole(p));
  assert.deepEqual(usdcChange(p), ['out 50']);
});

test('A factory deploying only for its own bundler (AA13), and the node failing the run as that bundler: the node’s failure, not a rejection', async () => {
  const ALLOWED = '0xb0d1e700000000000000000000000000000b4337';
  await chain.putCode(getContractAddress({ from: EP as Hex, nonce: 1n }), `0x${compiled('SenderCreatorLike').evm.deployedBytecode.object}`);
  const factory = await chain.deploy('BundlerFactory', 'address,address', [EP, ALLOWED]);
  const factoryData = encodeFunctionData({ abi: parseAbi(['function createAccount(address owner, uint256 salt)']), functionName: 'createAccount', args: [OWNER as Hex, 6n] });
  const fresh = getContractAddress({ opcode: 'CREATE2', from: factory as Hex, salt: numberToHex(6n, { size: 32 }),
    bytecode: concatHex([`0x${compiled('Account4337').evm.bytecode.object}`, encodeAbiParameters([{ type: 'address' }, { type: 'address' }], [OWNER as Hex, EP as Hex])]) }).toLowerCase();
  await chain.exec(usdc, call('mint', [fresh, 100_000_000n]));
  await chain.setBalance(fresh, E);
  // Its factory's deployments came through ALLOWED (the EntryPoint's AccountDeployed events).
  const ACCOUNT_DEPLOYED = '0xd51a9c61267aa6196961883ecf5ff2da6619c37dac0fa92122513fb32c032d2d';
  const word = (x: string) => `0x${'00'.repeat(12)}${x.slice(2)}`;
  const rpc = { has: (c: number) => deps.rpc!.has(c), call: async (c: number, m: string, ps: { topics: string[] }[]) => {
    if (m === 'eth_blockNumber') return '0x100';
    if (m === 'eth_getLogs') return ps[0].topics[0] === ACCOUNT_DEPLOYED ? [{ transactionHash: `0x${'02'.padStart(64, '0')}`, data: `${word(factory)}${'00'.repeat(32)}` }] : [];
    if (m === 'eth_getTransactionByHash') return { from: ALLOWED, input: '0x' };
    return deps.rpc!.call(c, m, ps);
  } } as Dependencies['rpc'];
  const f = failingFrom(ALLOWED);
  const p = await preview(v07(fresh, { factory, factoryData, verificationGasLimit: '0xf4240' }), OWNER, { ...deps, rpc, simulator: f.simulator });
  assert.deepEqual(f.sent, ['0x0000000000000000000000000000000000004337', ALLOWED, ALLOWED]);
  assert.ok(!codes(p).includes('userop_rejected'), p.warnings.map(w => w.message).join(' | '));
  assert.match(p.warnings.find(w => w.code === 'userop_simulation_failed')?.message ?? '', /the account's factory refused the simulation's own bundler \(AA13\), and the run as a bundler it took lately failed: RPC HTTP 429/);
});

// Typed operations (EntryPoint v0.8): what is signed for each bytes field.
const EP8 = '0x4337084d9e255ff0702461cf8895ce9e3b5ff108';
await chain.putCode(EP8, ENTRY_POINT_SIMULATIONS_V08 as Hex);
const TYPES = { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
  PackedUserOperation: [{ name: 'sender', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'initCode', type: 'bytes' }, { name: 'callData', type: 'bytes' }, { name: 'accountGasLimits', type: 'bytes32' }, { name: 'preVerificationGas', type: 'uint256' }, { name: 'gasFees', type: 'bytes32' }, { name: 'paymasterAndData', type: 'bytes' }] };
const typed = (sender: string, callData: string, chainId: number | null = 999) => {
  const domain = { name: 'ERC4337', version: '1', ...(chainId !== null && { chainId }), verifyingContract: EP8 };
  const types = chainId !== null ? TYPES : { ...TYPES, EIP712Domain: TYPES.EIP712Domain.filter(f => f.name !== 'chainId') };
  const message = { sender, nonce: '0', initCode: '0x', callData, accountGasLimits: `0x${(200000n).toString(16).padStart(32, '0')}${(200000n).toString(16).padStart(32, '0')}`, preVerificationGas: '50000', gasFees: `0x${(1000000000n).toString(16).padStart(32, '0')}${(2000000000n).toString(16).padStart(32, '0')}`, paymasterAndData: '0x' };
  return previewRequest({ method: 'eth_signTypedData_v4', params: [OWNER, JSON.stringify({ domain, types, primaryType: 'PackedUserOperation', message })] }, { now: NOW, chainId: 999 }, deps);
};

test('A typed operation whose callData is odd-length hex is the call wallets sign (a 0 in front), not “no calls”', async () => {
  const a = await chain.deploy('Account4337', 'address,address', [OWNER, EP8]);
  await chain.setBalance(a, E);
  await chain.exec(usdc, call('mint', [a, 100_000_000n]));
  // A call whose selector starts with a 0 nibble (Biconomy's execute_ncC, 0x0000189a: USDC.transfer to someone else),
  // sent without that nibble: viem's and MetaMask's encoders, and the digest here, hash it as the full call.
  const full = `0x0000189a${encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'bytes' }], [usdc as Hex, 0n, call('transfer', ['0xbad0000000000000000000000000000000000bad', 100_000_000n])]).slice(2)}`;
  const odd = await typed(a, `0x${full.slice(3)}`), even = await typed(a, full);
  assert.equal(detail(odd, 'EIP-712 digest'), detail(even, 'EIP-712 digest'));
  assert.equal(odd.title, even.title);
  assert.doesNotMatch(`${odd.title} ${odd.summary}`, /no calls/);
  assert.equal(odd.summary, even.summary);
  assert.match(odd.warnings.find(w => w.code === 'userop_odd_length_hex')?.message ?? '', /callData is hex with an odd number of digits\. Wallets that sign it put a 0 in front/);
  assert.deepEqual(codes(odd).filter(c => c !== 'userop_odd_length_hex'), codes(even));
  assert.equal(whole(odd), whole(even));
  // callData that isn't hex: what is signed for it differs between wallets, so nothing of it is said or simulated.
  const text = await typed(a, 'transfer everything');
  assert.doesNotMatch(`${text.title} ${text.summary}`, /no calls/);
  assert.match(text.warnings.find(w => w.code === 'userop_unreadable')?.message ?? '', /^The operation's callData isn't hex bytes, so what it does can't be read or simulated/);
  assert.ok(!text.decoding.notes.some(n => /simulated/.test(n)), text.decoding.notes.join(' | '));
  // With no chain in its domain, its calls aren't decoded, and aren't "no calls" either.
  const nowhere = await typed(a, full, null);
  assert.doesNotMatch(`${nowhere.title} ${nowhere.summary}`, /no calls/);
  assert.ok(codes(nowhere).includes('userop_no_chain'), codes(nowhere).join());
});
