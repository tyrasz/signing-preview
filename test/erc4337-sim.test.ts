// A whole ERC-4337 operation simulated end to end: EntryPointSimulations in place of EntryPoint v0.7's code, run by
// the fork simulator on test/evm-chain.ts (a node without eth_simulateV1), with ecrecover standing in for the owner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { concatHex, encodeFunctionData, numberToHex, parseAbi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { previewRequest } from '../src/preview.ts';
import { StaticTokenRegistry } from '../src/chains.ts';
import { RpcSimulator } from '../src/simulation.ts';
import { JsonRpcClient } from '../src/rpc.ts';
import { ForkSimulator } from '../src/fork-simulator.ts';
import { ENTRY_POINT_SIMULATIONS_V06, ENTRY_POINT_SIMULATIONS_V07, ENTRY_POINT_SIMULATIONS_V08, ENTRY_POINT_SIMULATIONS_V09 } from '../src/entrypoint-simulations.ts';
import { readOperation, userOpHash } from '../src/userop-hash.ts';
import type { Dependencies, Preview, SimulationResult } from '../src/types.ts';
import { codes, detail, NOW } from './helpers.ts';
import { testChain } from './evm-chain.ts';

const EP = '0x0000000071727de22e5e9d8baf0edac6f37da032', EP6 = '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789';
const OWNER = privateKeyToAccount('0x7777777777777777777777777777777777777777777777777777777777777777').address.toLowerCase();
const BOB = '0xb0b0000000000000000000000000000000000002';
const URL_ = 'http://hyperevm.invalid';
const E = 10n ** 18n;

const chain = await testChain();
const usdc = await chain.deploy('Token', 'string,uint8', ['USDC', 6]);
const account = await chain.deploy('Account4337', 'address,address', [OWNER, EP]);
const paymaster = await chain.deploy('TokenPaymaster', 'address,address', [EP, usdc]);
const broke = await chain.deploy('TokenPaymaster', 'address,address', [EP, usdc]);
const account6 = await chain.deploy('Account4337V06', 'address,address', [OWNER, EP6]);
// EntryPoint v0.8 and v0.9 take the same packed operation as v0.7, signed as EIP-712 typed data.
const EP8 = '0x4337084d9e255ff0702461cf8895ce9e3b5ff108', EP9 = '0x433709009b8330fda32311df1c2afa402ed8d009';
const account8 = await chain.deploy('Account4337', 'address,address', [OWNER, EP8]);
const account9 = await chain.deploy('Account4337', 'address,address', [OWNER, EP9]);
// The EntryPoint's storage is what matters (deposits, nonces): its code here is the simulation's own, which has depositTo.
await chain.putCode(EP, ENTRY_POINT_SIMULATIONS_V07 as Hex);
const A = parseAbi(['function mint(address,uint256)', 'function approve(address,uint256)', 'function transfer(address,uint256)', 'function depositTo(address)', 'function execute(address,uint256,bytes)']);
const call = (fn: string, args: unknown[]) => encodeFunctionData({ abi: A, functionName: fn, args } as never);
await chain.exec(usdc, call('mint', [account, 100_000_000n]));
await chain.exec(usdc, call('mint', [account6, 100_000_000n]));
for (const [a, ep, code] of [[account8, EP8, ENTRY_POINT_SIMULATIONS_V08], [account9, EP9, ENTRY_POINT_SIMULATIONS_V09]] as const) {
  await chain.exec(usdc, call('mint', [a, 100_000_000n]));
  await chain.setBalance(a, E);
  await chain.putCode(ep, code as Hex);
}
await chain.setBalance(account6, E);
await chain.putCode(EP6, ENTRY_POINT_SIMULATIONS_V06 as Hex);
await chain.exec(usdc, call('approve', [paymaster, (1n << 256n) - 1n]), account);
await chain.setBalance(account, E);
await chain.setBalance('0xde9100000000000000000000000000000000d001', 10n * E);
await chain.exec(EP, call('depositTo', [paymaster]), '0xde9100000000000000000000000000000000d001', E);

const deps: Dependencies = {
  tokens: new StaticTokenRegistry({ 999: [{ address: usdc, symbol: 'USDC', decimals: 6, name: 'USD Coin' }] }),
  rpc: new JsonRpcClient({ 999: URL_ }, { fetchImpl: chain.fetchImpl }),
  simulator: new RpcSimulator({ 999: URL_ }, { fetchImpl: chain.fetchImpl, fork: new ForkSimulator({ 999: URL_ }, { fetchImpl: chain.fetchImpl }) }),
};
const word = (v: bigint) => numberToHex(v, { size: 16 });
const sendUsdc = call('execute', [usdc, 0n, call('transfer', [BOB, 50_000_000n])]);
const operation = (m: Record<string, unknown> = {}) => ({ sender: account, nonce: '0x0', callData: sendUsdc, callGasLimit: '0x30d40', verificationGasLimit: '0x30d40', preVerificationGas: '0xc350', maxFeePerGas: '0x77359400', maxPriorityFeePerGas: '0x3b9aca00', ...m });
const withPaymaster = (pm: string) => ({ paymaster: pm, paymasterVerificationGasLimit: '0x186a0', paymasterPostOpGasLimit: '0x186a0', paymasterData: '0x' });
async function preview(op: Record<string, unknown>, signer = OWNER, version: '0.6' | '0.7' = '0.7'): Promise<Preview> {
  const ep = version === '0.6' ? EP6 : EP;
  const hash = userOpHash(readOperation(op, version)!, ep, 999, version);
  return previewRequest({ method: 'personal_sign', params: [hash, signer] }, { now: NOW, chainId: 999, userOperation: { entryPoint: ep, operation: op } }, deps);
}
const usdcChange = (p: Preview) => p.assetChanges.filter(c => c.symbol === 'USDC').map(c => `${c.direction} ${c.amount}`);

test('A whole operation: validated as the owner will sign it, its calls run, and the gas it pays (the prefund set aside)', async () => {
  const p = await preview(operation());
  assert.deepEqual(usdcChange(p), ['out 50']);
  assert.ok(!p.assetChanges.some(c => c.symbol === 'HYPE' || c.asset === 'native'), 'the gas prefund is gas, not a balance change');
  const paid = BigInt(String(p.details.find(d => d.label === 'Gas cost (simulated)')?.raw));
  // At 1 gwei (the base fee is 0, the priority fee 1 gwei): the gas used, at least the 50,000 of pre-verification.
  assert.ok(paid > 50_000n * 10n ** 9n && paid < 450_000n * 10n ** 9n, String(paid));
  assert.match(String(detail(p, 'Gas cost (simulated)')), /paid by the account/);
  // The gas the EntryPoint counts for it, which the cost is the price of.
  const used = BigInt(String(p.details.find(d => d.label === 'Gas used (simulated)')?.raw));
  assert.ok(used > 50_000n && used < 500_000n, String(used));
  assert.equal(paid % used, 0n);
  assert.ok(p.decoding.notes.some(n => /whole operation was simulated as EntryPoint v0\.7 runs it/.test(n) && /attributes it to the signer\)/.test(n)), p.decoding.notes.join(' | '));
  assert.ok(!codes(p).includes('userop_execution_reverts'));
});

test('A token paymaster: its validation and its charge after the calls are simulated, and the charge is in the balance changes', async () => {
  const p = await preview(operation(withPaymaster(paymaster)));
  const paid = BigInt(String(p.details.find(d => d.label === 'Gas cost (simulated)')?.raw));
  assert.match(String(detail(p, 'Gas cost (simulated)')), /paid by the paymaster/);
  // postOp charges for the gas used before it runs (its own comes after): a little under the final cost's rate.
  const fee = Number(/^([\d.]+) USDC, from the account \(included in the balance changes\)$/.exec(String(detail(p, 'Paymaster charge')))?.[1]);
  assert.ok(fee > 0 && fee * 1e6 <= Number(paid / 10n ** 9n + 1n), `${fee} ${paid}`);
  assert.deepEqual(usdcChange(p), [`out ${(50_000_000 + Math.round(fee * 1e6)) / 1e6}`]);
});

test('A signer the account doesn’t accept, failing calls, and a paymaster that can’t pay: what bundlers and the EntryPoint would do', async () => {
  // Someone who isn't the owner: the account reports a failed signature, which the simulation notes and runs past.
  const stranger = await preview(operation(), BOB);
  assert.ok(stranger.decoding.notes.some(n => /doesn't accept it as theirs/.test(n)), `${stranger.decoding.notes.join(' | ')} ${codes(stranger)}`);
  // Calls that fail: the operation is still included and pays for its gas.
  const failing = await preview(operation({ callData: call('execute', [usdc, 0n, call('transfer', [BOB, 500_000_000n])]) }));
  assert.ok(codes(failing).includes('userop_execution_reverts'));
  assert.match(failing.warnings.find(w => w.code === 'userop_execution_reverts')!.message, /: balance\. It can still be included, and the account pays 0\.\d+ HYPE for the gas\./);
  // A paymaster without an EntryPoint deposit: the EntryPoint rejects the operation (AA31).
  const unfunded = await preview(operation(withPaymaster(broke)));
  assert.match(unfunded.warnings.find(w => w.code === 'userop_rejected')?.message ?? '', /the paymaster's EntryPoint deposit can't cover the gas \(AA31 paymaster deposit too low\)/);
  // A nonce ahead of the account's: it waits for the operations before it (noted), which isn't a rejection.
  const ahead = await preview(operation({ nonce: '0x5' }));
  assert.ok(!codes(ahead).includes('userop_rejected'), codes(ahead).join());
  assert.ok(ahead.decoding.notes.some(n => /5 other operations of this account must run before this one/.test(n)));
});

test('A paymaster that only pays for its own bundler: the operation runs as a bundler its recent operations came through', async () => {
  const ALLOWED = '0xb0d1e70000000000000000000000000000004337';
  const picky = await chain.deploy('BundlerPaymaster', 'address,address', [EP, ALLOWED]);
  await chain.exec(EP, call('depositTo', [picky]), '0xde9100000000000000000000000000000000d001', E);
  const op = operation(withPaymaster(picky));
  const hash = userOpHash(readOperation(op, '0.7')!, EP, 999, '0.7');
  const run = (d: Dependencies) => previewRequest({ method: 'personal_sign', params: [hash, OWNER] }, { now: NOW, chainId: 999, userOperation: { entryPoint: EP, operation: op } }, d);
  // This node has no logs to look in: the simulation's own address sends it, which the paymaster refuses.
  const refused = await run(deps);
  assert.match(refused.warnings.find(w => w.code === 'userop_rejected')?.message ?? '', /AA33/);
  // A node with the paymaster's latest UserOperationEvent, in a bundle ALLOWED sent.
  const lookups: unknown[] = [];
  const rpc = { has: (c: number) => deps.rpc!.has(c), call: async (c: number, m: string, ps: unknown[]) => {
    if (m === 'eth_blockNumber') return '0x100';
    if (m === 'eth_getLogs') { lookups.push(ps[0]); return [{ transactionHash: `0x${'ab'.repeat(32)}` }]; }
    if (m === 'eth_getTransactionByHash') return { from: ALLOWED, input: '0x' };
    return deps.rpc!.call(c, m, ps);
  } } as Dependencies['rpc'];
  const accepted = await run({ ...deps, rpc });
  assert.ok(!codes(accepted).includes('userop_rejected'), codes(accepted).join());
  assert.ok(accepted.decoding.notes.some(n => /whole operation was simulated as EntryPoint v0\.7 runs it/.test(n)), accepted.decoding.notes.join(' | '));
  assert.deepEqual(usdcChange(accepted), ['out 50']);
  // The lookup is the paymaster's UserOperationEvents, by its indexed address, and it is remembered.
  assert.equal((lookups[0] as { topics: string[] }).topics[3], `0x${'00'.repeat(12)}${picky.slice(2)}`);
  await run({ ...deps, rpc });
  assert.equal(lookups.length, 1);
});

test('The operation runs at the price its bundle pays: a contract reading tx.gasprice sees the base fee plus the operation’s priority fee', async () => {
  const tips = await chain.deploy('TipReader', '', []);
  const T = parseAbi(['function requireTip(uint256 atLeast) view']);
  const needs = (tip: bigint) => operation({ callData: call('execute', [tips, 0n, encodeFunctionData({ abi: T, functionName: 'requireTip', args: [tip] })]) });
  // The operation pays a 1 gwei priority fee (up to 2 gwei in all): a contract wanting that much of a tip runs.
  assert.ok(!codes(await preview(needs(10n ** 9n))).includes('userop_execution_reverts'));
  // One wanting more doesn't: the simulation isn't run at the fee cap, or at no price at all.
  const more = await preview(needs(10n ** 9n + 1n));
  assert.match(more.warnings.find(w => w.code === 'userop_execution_reverts')?.message ?? '', /: tip\./);
});

test('EntryPoint v0.6: the patched EntryPoint returns its simulateHandleOp result, so the operation’s logs and gas are kept', async () => {
  const p = await preview(operation({ sender: account6, paymasterAndData: '0x' }), OWNER, '0.6');
  assert.deepEqual(usdcChange(p), ['out 50']);
  assert.ok(BigInt(String(p.details.find(d => d.label === 'Gas cost (simulated)')?.raw)) > 50_000n * 10n ** 9n);
  assert.ok(p.decoding.notes.some(n => /whole operation was simulated as EntryPoint v0\.6 runs it/.test(n)), p.decoding.notes.join(' | '));
  assert.ok(!p.decoding.notes.some(n => /doesn't accept it as theirs/.test(n)));
});

test('EntryPoint v0.8 and v0.9: typed-data operations run whole through their own simulation code', async () => {
  const types = { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
    PackedUserOperation: [{ name: 'sender', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'initCode', type: 'bytes' }, { name: 'callData', type: 'bytes' }, { name: 'accountGasLimits', type: 'bytes32' }, { name: 'preVerificationGas', type: 'uint256' }, { name: 'gasFees', type: 'bytes32' }, { name: 'paymasterAndData', type: 'bytes' }] };
  for (const [ep, account, name] of [[EP8, account8, 'v0.8'], [EP9, account9, 'v0.9']] as const) {
    const message = { sender: account, nonce: '0', initCode: '0x', callData: sendUsdc, accountGasLimits: concatHex([word(200_000n), word(200_000n)]), preVerificationGas: '50000', gasFees: concatHex([word(1_000_000_000n), word(2_000_000_000n)]), paymasterAndData: '0x' };
    const p = await previewRequest({ method: 'eth_signTypedData_v4', params: [OWNER, JSON.stringify({ domain: { name: 'ERC4337', version: '1', chainId: 999, verifyingContract: ep }, types, primaryType: 'PackedUserOperation', message })] }, { now: NOW }, deps);
    assert.deepEqual(usdcChange(p), ['out 50'], name);
    assert.ok(p.decoding.notes.some(n => new RegExp(`whole operation was simulated as EntryPoint ${name.replace('.', '\\.')} runs it`).test(n) && !/doesn't accept/.test(n)), p.decoding.notes.join(' | '));
    assert.ok(BigInt(String(p.details.find(d => d.label === 'Gas cost (simulated)')?.raw)) > 50_000n * 10n ** 9n, name);
  }
});

test('A typed operation validates with the wallet’s own stub when context.userOperation is the same operation', async () => {
  const owner = privateKeyToAccount('0x7777777777777777777777777777777777777777777777777777777777777777');
  const types = { PackedUserOperation: [{ name: 'sender', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'initCode', type: 'bytes' }, { name: 'callData', type: 'bytes' }, { name: 'accountGasLimits', type: 'bytes32' }, { name: 'preVerificationGas', type: 'uint256' }, { name: 'gasFees', type: 'bytes32' }, { name: 'paymasterAndData', type: 'bytes' }] };
  const domain = { name: 'ERC4337', version: '1', chainId: 999, verifyingContract: EP8 as Hex };
  const message = { sender: account8 as Hex, nonce: 0n, initCode: '0x' as Hex, callData: sendUsdc, accountGasLimits: concatHex([word(200_000n), word(200_000n)]), preVerificationGas: 50_000n, gasFees: concatHex([word(1_000_000_000n), word(2_000_000_000n)]), paymasterAndData: '0x' as Hex };
  // A signature that isn't the stand-in's goes to the real ecrecover: the owner's own here, so the account accepts it.
  const signature = await owner.signTypedData({ domain, types, primaryType: 'PackedUserOperation', message });
  const typed = JSON.stringify({ domain, types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }], ...types }, primaryType: 'PackedUserOperation',
    message: { ...message, nonce: '0', preVerificationGas: '50000' } });
  const run = (operation: Record<string, unknown>) => previewRequest({ method: 'eth_signTypedData_v4', params: [OWNER, typed] }, { now: NOW, userOperation: { entryPoint: EP8, operation } }, deps);
  const whole = (p: Preview) => p.decoding.notes.find(n => /whole operation was simulated/.test(n)) ?? p.decoding.notes.join(' | ');
  const stubbed = await run({ sender: account8, nonce: '0x0', callData: sendUsdc, signature });
  assert.match(whole(stubbed), /with the wallet's stand-in signature/);
  assert.deepEqual(usdcChange(stubbed), ['out 50']);
  // Another operation's (another nonce, or other calls): the wallet's stub isn't for this one, and the stand-in is used.
  for (const other of [{ sender: account8, nonce: '0x1', signature }, { sender: account8, nonce: '0x0', callData: '0x', signature }]) {
    assert.match(whole(await run(other)), /with a stand-in for the signature/, JSON.stringify(other));
  }
});

test('A passkey stand-in: a WebAuthn assertion over the operation hash, and a P256 verifier that accepts only it', async () => {
  const { webAuthnStub, p256Accepting, P256_STUB } = await import('../src/erc4337-sim.ts');
  const { decodeAbiParameters } = await import('viem');
  const { hexToBytes: toBytes, bytesToHex: toHex, createAddressFromString: at } = await import('@ethereumjs/util');
  const hash = `0x${'ab'.repeat(32)}` as Hex;
  const [auth] = decodeAbiParameters([{ type: 'tuple', components: [{ name: 'authenticatorData', type: 'bytes' }, { name: 'clientDataJSON', type: 'string' }, { name: 'challengeIndex', type: 'uint256' }, { name: 'typeIndex', type: 'uint256' }, { name: 'r', type: 'uint256' }, { name: 's', type: 'uint256' }] }], webAuthnStub(hash));
  const client = JSON.parse(auth.clientDataJSON);
  assert.equal(client.type, 'webauthn.get');
  assert.equal(`0x${Buffer.from(client.challenge, 'base64url').toString('hex')}`, hash); // the challenge is the hash, base64url
  assert.equal(auth.clientDataJSON.slice(Number(auth.challengeIndex), Number(auth.challengeIndex) + 11), '"challenge"');
  assert.equal(auth.clientDataJSON.slice(Number(auth.typeIndex), Number(auth.typeIndex) + 21), '"type":"webauthn.get"');
  assert.equal(auth.authenticatorData.length, 2 + 37 * 2);
  assert.equal(parseInt(auth.authenticatorData.slice(2 + 64, 2 + 66), 16) & 0x05, 0x05); // user present and verified
  assert.ok(auth.s <= 0x7fffffff800000007fffffffffffffffde737d56d38bcf4279dce5617e3192a8n); // low s
  // The verifier at 0x100 (no P256 precompile on this EVM): 1 for the stand-in, and nothing for anything else.
  await chain.putCode('0x0000000000000000000000000000000000000100', p256Accepting());
  const verify = async (r: Hex, s: Hex) => toHex((await chain.evm.runCall({ caller: at(OWNER), to: at('0x0000000000000000000000000000000000000100'), data: toBytes(concatHex([hash, r, s, `0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`])), gasLimit: 100_000n })).execResult.returnValue);
  assert.equal(BigInt(await verify(P256_STUB.r, P256_STUB.s)), 1n);
  assert.equal(await verify(P256_STUB.r, `0x${'26'.repeat(32)}`), '0x');
});

test('A Kernel passkey stand-in: ZeroDev’s WebAuthn validator form, and Daimo’s verifier answering it after running its own code', async () => {
  const { zeroDevWebAuthnStub, daimoAccepting, DAIMO_P256_VERIFIER, P256_STUB } = await import('../src/erc4337-sim.ts');
  const { decodeAbiParameters } = await import('viem');
  const { hexToBytes: toBytes, bytesToHex: toHex, createAddressFromString: at } = await import('@ethereumjs/util');
  const hash = `0x${'cd'.repeat(32)}` as Hex;
  for (const precompiled of [true, false]) {
    const [authenticatorData, clientDataJSON, responseTypeLocation, r, s, usePrecompiled] = decodeAbiParameters([{ type: 'bytes' }, { type: 'string' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bool' }], zeroDevWebAuthnStub(hash, precompiled));
    // Where ZeroDev's validator looks: the type at responseTypeLocation, the challenge (the hash, base64url) at 23.
    assert.equal(clientDataJSON.slice(Number(responseTypeLocation), Number(responseTypeLocation) + 21), '"type":"webauthn.get"');
    assert.equal(clientDataJSON.slice(23, 36), '"challenge":"');
    assert.equal(`0x${Buffer.from(JSON.parse(clientDataJSON).challenge, 'base64url').toString('hex')}`, hash);
    assert.equal(authenticatorData.length, 2 + 37 * 2);
    assert.equal(parseInt(authenticatorData.slice(2 + 64, 2 + 66), 16) & 0x1d, 0x05); // present and verified; no backup flags
    assert.deepEqual([r, s, usePrecompiled], [BigInt(P256_STUB.r), BigInt(P256_STUB.s), precompiled]);
  }
  // Daimo's verifier: its real code (here, one answering 0 to everything) runs first, at the address it moves to.
  const moved = '0x0000000000000000000000000000000000ec0da1';
  await chain.putCode(moved, '0x60006000526020' + '6000f3' as Hex); // mstore(0, 0); return(0, 32)
  await chain.putCode(DAIMO_P256_VERIFIER, daimoAccepting());
  const verify = async (r: Hex, s: Hex) => toHex((await chain.evm.runCall({ caller: at(OWNER), to: at(DAIMO_P256_VERIFIER), data: toBytes(concatHex([hash, r, s, `0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`])), gasLimit: 100_000n })).execResult.returnValue);
  assert.equal(BigInt(await verify(P256_STUB.r, P256_STUB.s)), 1n);
  assert.equal(BigInt(await verify(P256_STUB.r, `0x${'26'.repeat(32)}`)), 0n); // the real code's answer
});

test('A Kernel v3.1 passkey account: the stand-in passes ZeroDev’s own WebAuthn checks, through Daimo’s verifier', async () => {
  const { DAIMO_P256_VERIFIER } = await import('../src/erc4337-sim.ts');
  const { compiled } = await import('./evm-chain.ts');
  // Kernel v3.1's implementation address runs KernelPasskey (ZeroDev's validator checks, its WebAuthn.sol), behind
  // an ERC-1967 proxy as Kernel accounts are; its root validator is ZeroDev's WebAuthn validator.
  const KERNEL_V31 = '0xbac849bb641841b44e965fb01a4bf5f074f84b4d';
  await chain.putCode(KERNEL_V31, `0x${compiled('KernelPasskey').evm.deployedBytecode.object}`);
  const kernel = await chain.deploy('Proxy1967', 'address', [KERNEL_V31]);
  const key = { x: 0x65a2fa44daad46eab0278703edb6c4dcf5e30b8a9aec09fdc71a56f52aa392e4n, y: 0x4a7a9e4604aa36898209997288e902ac544a555e4b5e0a9efef2b59233f3f437n };
  await chain.exec(kernel, encodeFunctionData({ abi: parseAbi(['function init(address,uint256,uint256)']), functionName: 'init', args: [EP, key.x, key.y] }));
  await chain.exec(usdc, call('mint', [kernel, 100_000_000n]));
  await chain.setBalance(kernel, E);
  // Daimo's verifier on this chain (which has no P256 precompile, so ZeroDev's SDK signs for the verifier): here one
  // that accepts nothing. The stand-in runs it, then answers the stub.
  await chain.putCode(DAIMO_P256_VERIFIER, '0x600060005260206000f3' as Hex);
  // The account itself is asked to sign: a passkey wallet's way.
  const p = await preview(operation({ sender: kernel }), kernel);
  const whole = p.decoding.notes.find(n => /whole operation was simulated/.test(n)) ?? p.decoding.notes.join(' | ');
  assert.match(whole, /a passkey's assertion over the operation's hash/);
  assert.doesNotMatch(whole, /doesn't accept/);
  assert.deepEqual(usdcChange(p), ['out 50']);
});

test('Calls run alone on Kernel v3 (executeUserOp) run inside the execution hook their validation was installed with, which can refuse them', async () => {
  const { simulateExecution } = await import('../src/erc4337-sim.ts');
  const { compiled } = await import('./evm-chain.ts');
  const KERNEL_V33 = '0xd6cedde84be40893d153be9d467cd6ad37875b28';
  await chain.putCode(KERNEL_V33, `0x${compiled('KernelHooked').evm.deployedBytecode.object}`);
  const kernel = await chain.deploy('Proxy1967', 'address', [KERNEL_V33]);
  const MODULE = '0x00000000000000000000000000000000000d0d01';
  await chain.putCode(MODULE, '0x00' as Hex);
  const hook = await chain.deploy('RefusingHook', 'address', [MODULE]);
  const K = parseAbi(['function init(address,address,bytes21)', 'function install(bytes21,address)', 'function execute(address,uint256,bytes)']);
  await chain.exec(kernel, encodeFunctionData({ abi: K, functionName: 'init', args: [OWNER as Hex, EP, `0x01${'ec'.repeat(20)}`] }));
  // A permission (validation type 0x02, its id 0x4e48b87d) installed with the hook; the root with none.
  await chain.exec(kernel, encodeFunctionData({ abi: K, functionName: 'install', args: [`0x024e48b87d${'00'.repeat(16)}`, hook as Hex] }));
  const run = (nonce: bigint, to: string) => simulateExecution({ chainId: 999, entryPoint: EP, sender: kernel,
    callData: concatHex(['0x8dd7712f', encodeFunctionData({ abi: K, functionName: 'execute', args: [to as Hex, 0n, '0x'] })]),
    packed: { nonce, initCode: '0x', accountGasLimits: `0x${'00'.repeat(32)}`, preVerificationGas: 0n, gasFees: `0x${'00'.repeat(32)}`, paymasterAndData: '0x' }, userOpHash: `0x${'5a'.repeat(32)}` }, deps);
  const permission = BigInt(`0x00024e48b87d${'00'.repeat(16)}${'00'.repeat(10)}`);
  const refused = await run(permission, MODULE);
  assert.equal(refused?.result.status, 'reverted', 'the hook refuses the module call, as on-chain');
  assert.match(String(refused?.result.revertReason), /ModuleCallNotAllowed/);
  assert.equal((await run(permission, BOB))?.result.status, 'success', 'and lets other calls through');
  assert.equal((await run(0n, MODULE))?.result.status, 'success', 'the root has no hook');
  // A permission the nonce names that isn't installed (outside enable mode): Kernel refuses the operation, so its
  // calls fail too, rather than run as if it were.
  assert.equal((await run(BigInt(`0x0002deadbeef${'00'.repeat(26)}`), BOB))?.result.status, 'reverted');
});

test('A Kernel v3 account asked by a signer that isn’t its owner: the run that went through stands, not the 0xff form’s rejection', async () => {
  const { compiled } = await import('./evm-chain.ts');
  // Kernel v3.2's implementation address, whose stand-ins are the ECDSA one as it is and after 0xff; this account's
  // validator reverts on the 66-byte one, as Kernel's ECDSA validator does.
  const KERNEL_V32 = '0xd830d15d3dc0c269f3dbaa0f3e8626d33cfdabe1';
  await chain.putCode(KERNEL_V32, `0x${compiled('KernelHooked').evm.deployedBytecode.object}`);
  const kernel = await chain.deploy('Proxy1967', 'address', [KERNEL_V32]);
  await chain.exec(kernel, encodeFunctionData({ abi: parseAbi(['function init(address,address,bytes21)']), functionName: 'init', args: [OWNER as Hex, EP, `0x01${'ec'.repeat(20)}`] }));
  await chain.exec(usdc, call('mint', [kernel, 100_000_000n]));
  await chain.setBalance(kernel, E);
  const p = await preview(operation({ sender: kernel }), BOB);
  const whole = p.decoding.notes.find(n => /whole operation was simulated/.test(n)) ?? p.decoding.notes.join(' | ');
  assert.match(whole, /doesn't accept it as theirs/);
  assert.ok(!p.decoding.notes.some(n => /validation reverts on a stand-in/.test(n)), p.decoding.notes.join(' | '));
  assert.ok(detail(p, 'Gas cost (simulated)'), 'the whole operation’s gas is shown');
  assert.deepEqual(usdcChange(p), ['out 50']);
});

test('A whole operation whose balances the node didn’t read after it: its note says the amounts are the events’, with the node’s answer', async () => {
  const inner = deps.simulator!;
  // As RpcSimulator leaves a run whose reads a node rate-limited: amounts from its events, and why.
  const limited = (r: SimulationResult): SimulationResult => ({ ...r, basis: undefined, balancesRead: undefined, stateReadError: 'RPC HTTP 429: Too Many Requests' });
  const busy: Dependencies = { ...deps, simulator: { simulate: async q => { const r = await inner.simulate(q); return r && limited(r); }, simulateBatch: async qs => (await inner.simulateBatch!(qs))?.map(limited) ?? null } };
  const op = operation();
  const hash = userOpHash(readOperation(op, '0.7')!, EP, 999, '0.7');
  const p = await previewRequest({ method: 'personal_sign', params: [hash, OWNER] }, { now: NOW, chainId: 999, userOperation: { entryPoint: EP, operation: op } }, busy);
  const whole = p.decoding.notes.find(n => /whole operation was simulated/.test(n)) ?? p.decoding.notes.join(' | ');
  // (scripts/accuracy-4337.ts reads it so: such a run's amounts are reported, not judged.)
  assert.equal(/the balances couldn't be read after it: (.*)\); the final result/.exec(whole)?.[1], 'RPC HTTP 429: Too Many Requests');
  assert.deepEqual(usdcChange(p), ['out 50']);
});

test('A Kernel validator that keeps signers by id: a deploying account’s stand-in names the id of the signer asked, else the first', async () => {
  const { signerIdOf } = await import('../src/erc4337-sim.ts');
  const { encodeAbiParameters: enc } = await import('viem');
  const ROOT = '0x01933401632d92bc7005d7415242171a55e20004ba', MODULE = '0x9895a7b30a9dfcfbb1cd8f41595d2ad15fdcc9c3';
  const id = (b: string) => `0x${b.repeat(32)}` as Hex;
  const configs = enc([{ type: 'tuple[]', components: [{ name: 'id', type: 'bytes32' }, { name: 'signer', type: 'address' }, { name: 'data', type: 'bytes' }] }],
    [[{ id: id('11'), signer: MODULE, data: BOB }, { id: id('22'), signer: MODULE, data: OWNER as Hex }]]);
  const setup = { root: ROOT as Hex, installs: new Map<string, Hex>([[ROOT, configs]]) };
  const context = (signer: string) => ({ deps, chainId: 999, sender: BOB, signer, nonce: 0n, hash: async () => undefined }) as never;
  assert.equal(await signerIdOf(context(OWNER), ROOT, setup), id('22'));
  assert.equal(await signerIdOf(context('0x000000000000000000000000000000000000beef'), ROOT, setup), id('11'));
  // Install data it can't read: no id, so the plain ECDSA stand-in.
  assert.equal(await signerIdOf(context(OWNER), ROOT, { root: ROOT as Hex, installs: new Map([[ROOT, '0x1234' as Hex]]) }), undefined);
});

test('A Kernel validator that keeps signers by id: an existing account’s stand-in names the signer’s own id first, then its last operation’s', async () => {
  const { ownerSignerId, signerIdsOf } = await import('../src/erc4337-sim.ts');
  const { encodeFunctionData: enc, parseAbi: abi, concatHex: cat } = await import('viem');
  // A real SignerAdded event (Polygon, block 97,195,631): account 0x129f…2ff1, id 0xe51a…fae8, the ECDSA signer module, its owner.
  assert.equal(ownerSignerId('0x5832707543109d7a0ee8917ee13c86f80b0ae1b0'), '0xe51aa87b2bdc5cbd9485754bb0d5b3998c05b7f930376c49ed6efa95d848fae8');
  const ROOT = '0x01933401632d92bc7005d7415242171a55e20004ba', OWNER_ID = ownerSignerId(OWNER);
  const HANDLE = abi(['function handleOps((address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature)[] ops, address beneficiary)']);
  const zero = `0x${'00'.repeat(32)}` as Hex;
  // A node with no earlier operation of the account (older than the lookup reaches), or with one that named another id.
  const node = (sender: Hex, signature?: Hex) => ({ has: () => true, call: async (_: number, method: string) => {
    if (method === 'eth_getBlockByNumber') return { number: '0x30d41' };
    if (method === 'eth_getTransactionByHash') return { input: enc({ abi: HANDLE, functionName: 'handleOps', args: [[{ sender, nonce: 0n, initCode: '0x', callData: '0x', accountGasLimits: zero, preVerificationGas: 0n, gasFees: zero, paymasterAndData: '0x', signature: signature! }], BOB] }) };
    return signature ? [{ transactionHash: `0x${'78'.repeat(32)}` }] : [];
  } });
  const context = (sender: Hex, signature?: Hex, signer: string = OWNER) => ({ deps: { rpc: node(sender, signature) }, chainId: 137, sender, signer, nonce: 0n, entryPoint: EP, hash: async () => undefined }) as never;
  const none: Hex = '0x00000000000000000000000000000000005e1d11';
  assert.deepEqual(await signerIdsOf(context(none), ROOT), [OWNER_ID]);
  // Its last operation named the same id: once; another (a second owner's): after the signer's own.
  const same: Hex = '0x00000000000000000000000000000000005e1d12', other: Hex = '0x00000000000000000000000000000000005e1d13';
  assert.deepEqual(await signerIdsOf(context(same, cat([OWNER_ID, `0x${'ab'.repeat(65)}`])), ROOT), [OWNER_ID]);
  const second = `0x${'5f'.repeat(32)}` as Hex;
  assert.deepEqual(await signerIdsOf(context(other, cat([second, `0x${'ab'.repeat(65)}`])), ROOT), [OWNER_ID, second]);
  // A deploying account's: from its set-up only.
  const { encodeAbiParameters: abiEnc } = await import('viem');
  const configs = abiEnc([{ type: 'tuple[]', components: [{ name: 'id', type: 'bytes32' }, { name: 'signer', type: 'address' }, { name: 'data', type: 'bytes' }] }], [[{ id: second, signer: '0x9895a7b30a9dfcfbb1cd8f41595d2ad15fdcc9c3', data: OWNER as Hex }]]);
  assert.deepEqual(await signerIdsOf(context(none), ROOT, { root: ROOT as Hex, installs: new Map([[ROOT, configs]]) }), [second]);
});

test('An account’s last operation is looked for back in windows the node takes, from its own refusal, and a failed lookup isn’t remembered', async () => {
  const { signerIdOf } = await import('../src/erc4337-sim.ts');
  const { encodeFunctionData: enc, parseAbi: abi, concatHex: cat } = await import('viem');
  const HANDLE = abi(['function handleOps((address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature)[] ops, address beneficiary)']);
  const sender = '0x00000000000000000000000000000000005e1d01', id = `0x${'5f'.repeat(32)}` as Hex, zero = `0x${'00'.repeat(32)}` as Hex;
  const input = enc({ abi: HANDLE, functionName: 'handleOps', args: [[{ sender, nonce: 0n, initCode: '0x', callData: '0x', accountGasLimits: zero, preVerificationGas: 0n, gasFees: zero, paymasterAndData: '0x', signature: cat([id, `0x${'ab'.repeat(65)}`]) }], BOB] });
  const ranges: number[] = [];
  let failNext = false;
  // A node that refuses more than 5,000 blocks a query, naming its cap, and holds the operation 40,000 blocks back.
  const rpc = { has: () => true, call: async (_: number, method: string, params: any[]) => {
    if (method === 'eth_getBlockByNumber') return { number: '0x30d41' };
    if (method === 'eth_getTransactionByHash') { if (failNext) throw new Error('HTTP 429'); return { input }; }
    const from = Number(BigInt(params[0].fromBlock)), to = Number(BigInt(params[0].toBlock));
    ranges.push(to - from + 1);
    if (to - from + 1 > 5000) throw Object.assign(new Error('capped'), { rpcError: { message: 'exceed maximum block range: 5000' } });
    return from <= 160_000 && 160_000 <= to ? [{ transactionHash: `0x${'77'.repeat(32)}` }] : [];
  } };
  const context = (who: string) => ({ deps: { rpc }, chainId: 137, sender: who, signer: who, nonce: 0n, entryPoint: EP, hash: async () => undefined }) as never;
  assert.equal(await signerIdOf(context(sender), '0x01933401632d92bc7005d7415242171a55e20004ba'), id);
  assert.equal(ranges[0], 10_000, 'a 10,000-block window first');
  assert.ok(ranges.slice(1).every(r => r <= 5000), 'then within the cap the node named');
  // A read that fails: no id, and nothing remembered, so the next preview finds it.
  const other = '0x00000000000000000000000000000000005e1d02';
  failNext = true;
  assert.equal(await signerIdOf(context(other), '0x01933401632d92bc7005d7415242171a55e20004ba'), undefined);
  failNext = false;
  // (The operation is the first account's; the lookup reads it again, and finds the operation isn't the second's.)
  assert.equal(await signerIdOf(context(other), '0x01933401632d92bc7005d7415242171a55e20004ba'), undefined);
  assert.equal(ranges.filter(r => r === 10_000).length, 3, 'looked up again, not remembered from the failure');
});

test('The ecrecover stand-in: each stand-in signature recovers as its signer for exactly the precompile’s 3,000 gas', async () => {
  const { ecrecoverAs, STUB_SIGNATURE, STUB_COSIGNATURE } = await import('../src/erc4337-sim.ts');
  const { hexToBytes: toBytes, bytesToHex: toHex, createAddressFromString: at } = await import('@ethereumjs/util');
  const COSIGNER = '0xc051000000000000000000000000000000000c05';
  const digest = `0x${'d1'.repeat(32)}` as Hex;
  const input = (sig: Hex, hash: Hex) => concatHex([hash, `0x${sig.slice(130).padStart(64, '0')}`, `0x${sig.slice(2, 66)}`, `0x${sig.slice(66, 130)}`]);
  const where = '0x0000000000000000000000000000000000ec0bad';
  for (const [code, d, expect] of [
    [ecrecoverAs(OWNER), undefined, [[STUB_SIGNATURE, OWNER]]],
    [ecrecoverAs(OWNER, digest), digest, [[STUB_SIGNATURE, OWNER]]],
    [ecrecoverAs(OWNER, undefined, [{ signature: STUB_COSIGNATURE, signer: COSIGNER }]), undefined, [[STUB_SIGNATURE, OWNER], [STUB_COSIGNATURE, COSIGNER]]],
    [ecrecoverAs(OWNER, digest, [{ signature: STUB_COSIGNATURE, signer: COSIGNER }]), digest, [[STUB_SIGNATURE, OWNER], [STUB_COSIGNATURE, COSIGNER]]],
  ] as const) {
    await chain.putCode(where, code);
    for (const [sig, signer] of expect) {
      const r = await chain.evm.runCall({ caller: at(OWNER), to: at(where), data: toBytes(input(sig, d ?? `0x${'99'.repeat(32)}`)), gasLimit: 100_000n });
      assert.equal(`0x${toHex(r.execResult.returnValue).slice(-40)}`, signer);
      assert.equal(r.execResult.executionGasUsed, 3000n, `${signer} ${d ? 'over the digest' : ''}`);
    }
  }
  assert.notEqual(STUB_COSIGNATURE.slice(2, 66), STUB_SIGNATURE.slice(2, 66));
  // On a chain that charges its own price (HyperEVM's 15,000), the stand-in costs that.
  const { ecrecoverPrice } = await import('../src/chains.ts');
  assert.deepEqual([ecrecoverPrice(1), ecrecoverPrice(999)], [3000, 15_000]);
  for (const [code, d] of [[ecrecoverAs(OWNER, undefined, [], 15_000), undefined], [ecrecoverAs(OWNER, digest, [{ signature: STUB_COSIGNATURE, signer: COSIGNER }], 15_000), digest]] as const) {
    await chain.putCode(where, code);
    const r = await chain.evm.runCall({ caller: at(OWNER), to: at(where), data: toBytes(input(STUB_SIGNATURE, d ?? `0x${'99'.repeat(32)}`)), gasLimit: 100_000n });
    assert.deepEqual([`0x${toHex(r.execResult.returnValue).slice(-40)}`, r.execResult.executionGasUsed], [OWNER, 15_000n]);
  }
});

test('A paymaster field naming address 0 is no paymaster, as the EntryPoint takes it: the account pays', async () => {
  const p = await preview(operation({ ...withPaymaster('0x0000000000000000000000000000000000000000'), nonce: '0x0' }));
  assert.ok(!codes(p).includes('userop_rejected'), codes(p).join(','));
  assert.ok(!codes(p).includes('userop_paymaster'), 'no paymaster is named');
  assert.match(p.decoding.notes.find(n => /whole operation was simulated/.test(n)) ?? '', /and the gas payment\./);
  assert.match(detail(p, 'Gas cost (simulated)') ?? '', /paid by the account/);
  assert.deepEqual(usdcChange(p), ['out 50']);
});

test('The EntryPoint override hashes operations as the deployed EntryPoint does, for calls before a simulation too', async () => {
  const { entryPointOverride } = await import('../src/erc4337-sim.ts');
  const { hashTypedData, encodeFunctionData: enc, parseAbi: abi } = await import('viem');
  const HASH = abi(['function getUserOpHash((address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature) op) view returns (bytes32)']);
  const op = { sender: account8 as Hex, nonce: 7n, initCode: '0x' as Hex, callData: sendUsdc, accountGasLimits: concatHex([word(200_000n), word(200_000n)]), preVerificationGas: 50_000n, gasFees: concatHex([word(1_000_000_000n), word(2_000_000_000n)]), paymasterAndData: '0x' as Hex };
  const types = { PackedUserOperation: [{ name: 'sender', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'initCode', type: 'bytes' }, { name: 'callData', type: 'bytes' }, { name: 'accountGasLimits', type: 'bytes32' }, { name: 'preVerificationGas', type: 'uint256' }, { name: 'gasFees', type: 'bytes32' }, { name: 'paymasterAndData', type: 'bytes' }] };
  for (const ep of [EP8, EP9]) {
    // v0.8 on: the operation's hash is its EIP-712 digest under the EntryPoint's domain.
    const expected = hashTypedData({ domain: { name: 'ERC4337', version: '1', chainId: 999, verifyingContract: ep as Hex }, types, primaryType: 'PackedUserOperation', message: op });
    const data = enc({ abi: HASH, functionName: 'getUserOpHash', args: [{ ...op, signature: '0x' }] });
    // A plain call (as an earlier bundle's handleOps makes before the simulation starts) reads the domain the
    // simulation code keeps in storage: with the override's storage it is the EntryPoint's own; without, it was zero.
    const withOverride = await deps.rpc!.call(999, 'eth_call', [{ to: ep, data }, 'latest', { [ep]: entryPointOverride(ep, 999) }]);
    assert.equal(withOverride, expected, `v${ep === EP8 ? '0.8' : '0.9'}`);
    const codeOnly = await deps.rpc!.call(999, 'eth_call', [{ to: ep, data }, 'latest', { [ep]: { code: entryPointOverride(ep, 999)!.code } }]);
    assert.notEqual(codeOnly, expected);
  }
  // Its SenderCreator, which deploys accounts, is the EntryPoint's first creation, as on-chain (public from v0.8).
  const { getContractAddress } = await import('viem');
  const created = await deps.rpc!.call(999, 'eth_call', [{ to: EP8, data: enc({ abi: abi(['function senderCreator() view returns (address)']), functionName: 'senderCreator' }) }, 'latest', { [EP8]: entryPointOverride(EP8, 999) }]);
  assert.equal(`0x${String(created).slice(26)}`, getContractAddress({ from: EP8 as Hex, nonce: 1n }).toLowerCase());
});

test('A Safe being deployed: its owners, threshold and fallback handler from its setup, and a stand-in for each owner', async () => {
  const { safeSetupOf } = await import('../src/safe-sim.ts');
  const { ecrecoverAs, stubSignature } = await import('../src/erc4337-sim.ts');
  const { encodeFunctionData: enc, parseAbi: abi } = await import('viem');
  const { hexToBytes: toBytes, bytesToHex: toHex, createAddressFromString: at } = await import('@ethereumjs/util');
  const owners = ['0x3000000000000000000000000000000000000003', '0x1000000000000000000000000000000000000001', '0x2000000000000000000000000000000000000002'] as Hex[];
  const module = '0x75cf11467937ce3f2f357ce24ffc3dbf8fd5c226' as Hex;
  const setup = enc({ abi: abi(['function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)']), functionName: 'setup',
    args: [owners, 2n, '0x2dd68b007b46fbe91b9a7c3eda5a7a1063cb5b47', '0x', module, '0x0000000000000000000000000000000000000000', 0n, '0x0000000000000000000000000000000000000000'] });
  const factory = '0x4e1dcf7ad4e460cfd30791ccc4f9c8a4f820ec67';
  const initCode = concatHex([factory, enc({ abi: abi(['function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce)']), functionName: 'createProxyWithNonce', args: ['0x29fcb43b46531bca003ddc8fcb67ffe91900c762', setup, 7n] })]);
  assert.deepEqual(safeSetupOf(initCode), { owners: owners.map(o => o.toLowerCase()), threshold: 2n, fallbackHandler: module });
  assert.equal(safeSetupOf(`${factory}deadbeef`), null);
  // Up to 15 stand-ins, each told apart by its r, each recovered as its own signer for exactly 3,000 gas.
  const sigs = [0, 1, 2].map(stubSignature);
  assert.equal(new Set(sigs.map(x => x.slice(2, 66))).size, 3);
  const where = '0x0000000000000000000000000000000000ec0bae';
  await chain.putCode(where, ecrecoverAs(owners[0], undefined, [{ signature: sigs[1], signer: owners[1] }, { signature: sigs[2], signer: owners[2] }]));
  for (const [k, sig] of sigs.entries()) {
    const input = concatHex([`0x${'77'.repeat(32)}`, `0x${sig.slice(130).padStart(64, '0')}`, `0x${sig.slice(2, 66)}`, `0x${sig.slice(66, 130)}`]);
    const r = await chain.evm.runCall({ caller: at(OWNER), to: at(where), data: toBytes(input), gasLimit: 100_000n });
    assert.equal(`0x${toHex(r.execResult.returnValue).slice(-40)}`, owners[k].toLowerCase());
    assert.equal(r.execResult.executionGasUsed, 3000n);
  }
});

test('Calls run through executeUserOp that fail: the warning says the account was handed a stand-in signature', async () => {
  // The EntryPoint runs executeUserOp(op, hash) on the account, which here has none: the calls fail.
  const executeUserOp = `0x8dd7712f${'00'.repeat(64)}` as Hex;
  const p = await preview(operation({ nonce: '0x0', callData: executeUserOp }));
  const w = p.warnings.find(x => x.code === 'userop_execution_reverts');
  assert.ok(w, p.warnings.map(x => x.code).join(','));
  assert.match(w!.message, /handed the whole operation, its signature included/);
  // An ordinary failing call carries no such caveat.
  const q = await preview(operation({ nonce: '0x0', callData: call('execute', [usdc, 0n, call('transfer', [BOB, 10n ** 12n])]) }));
  assert.doesNotMatch(q.warnings.find(x => x.code === 'userop_execution_reverts')?.message ?? '', /handed the whole operation/);
});

test('OKX Wallet’s account: the stand-in names a key, so validation runs its checks and the calls run with that key’s permissions', async () => {
  const { OKX_IMPLEMENTATION, okxDigest } = await import('../src/erc4337-sim.ts');
  const { compiled } = await import('./evm-chain.ts');
  const { keccak256, encodeAbiParameters, getContractAddress } = await import('viem');
  const O = parseAbi(['struct Call { address to; uint256 value; bytes data; }', 'struct Owner { bytes32 keyHash; address keyType; }', 'function init(address ep, bytes32[] hashes, uint256[] types, uint256[] settings)',
    'function addOwner(bytes32 key, address keyType, uint256 settings)', 'function getOwnerKeys() view returns (bytes32[])', 'function createAccount(Owner[] owners, uint256 salt) returns (address)', 'function getAddress(Owner[] owners, uint256 salt) view returns (address)']);
  const ADMIN = 1n << 200n;
  // A passkey whose public key the previewer never sees (only its hash is in the account), and the owner's Ethereum key.
  const passkey = keccak256(concatHex([`0x${'a1'.repeat(32)}`, `0x${'b2'.repeat(32)}`])), ownerKey = keccak256(OWNER as Hex), other = keccak256(BOB as Hex);
  await chain.putCode(OKX_IMPLEMENTATION, `0x${compiled('OkxLike').evm.deployedBytecode.object}`);
  const make = async (keys: [Hex, bigint, bigint][]) => {
    const a = await chain.deploy('Proxy1967', 'address', [OKX_IMPLEMENTATION]);
    await chain.exec(a, encodeFunctionData({ abi: O, functionName: 'init', args: [EP, keys.map(k => k[0]), keys.map(k => k[1]), keys.map(k => k[2])] }));
    await chain.exec(usdc, call('mint', [a, 100_000_000n]));
    await chain.setBalance(a, E);
    return a;
  };
  // The operation pays Bob and adds a key: a call to the account itself, which only an admin key may make.
  const calls = (a: string) => concatHex(['0x8dd7712f', encodeAbiParameters([{ type: 'tuple[]', components: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }] }],
    [[{ to: usdc as Hex, value: 0n, data: call('transfer', [BOB, 50_000_000n]) }, { to: a as Hex, value: 0n, data: encodeFunctionData({ abi: O, functionName: 'addOwner', args: [`0x${'c3'.repeat(32)}`, '0x0000000000000000000000000000000000000001', ADMIN] }) }]])]);
  const whole = (p: Preview) => p.decoding.notes.find(n => /whole operation was simulated/.test(n)) ?? p.decoding.notes.join(' | ');

  // A passkey account, asked to sign itself: a stand-in passkey registered for the run with the real one's settings.
  const account = await make([[passkey, 2n, ADMIN], [ownerKey, 1n, ADMIN]]);
  let p = await preview(operation({ sender: account, callData: calls(account) }), account);
  assert.match(whole(p), /a passkey's assertion over the operation's hash/);
  assert.doesNotMatch(whole(p), /doesn't accept/);
  assert.deepEqual(codes(p).filter(c => c === 'userop_execution_reverts'), []);
  assert.deepEqual(usdcChange(p), ['out 50']);
  // Its Ethereum key asked to sign: that key itself, which ecrecover's stand-in signs.
  p = await preview(operation({ sender: account, callData: calls(account) }), OWNER);
  assert.match(whole(p), /ecrecover attributes it to the signer/);
  assert.doesNotMatch(whole(p), /doesn't accept/);
  assert.deepEqual(codes(p).filter(c => c === 'userop_execution_reverts'), []);
  assert.deepEqual(usdcChange(p), ['out 50']);

  // An account whose only key isn't an admin: the stand-in key gets the same settings, so the call to itself fails as it will.
  const limited = await make([[passkey, 2n, 0n]]);
  p = await preview(operation({ sender: limited, callData: calls(limited) }), limited);
  assert.doesNotMatch(whole(p), /doesn't accept/);
  assert.match(p.warnings.find(w => w.code === 'userop_execution_reverts')?.message ?? '', /only lets an admin key make calls to itself/);
  assert.deepEqual(usdcChange(p), []);

  // An account whose Ethereum key is someone else's: a stand-in key for the signer, with that key's settings.
  const others = await make([[other, 1n, ADMIN]]);
  p = await preview(operation({ sender: others, callData: calls(others) }), OWNER);
  assert.doesNotMatch(whole(p), /doesn't accept/);
  assert.deepEqual(usdcChange(p), ['out 50']);

  // What the key signs: the operation's hash with validUntil and the implementation.
  assert.equal(okxDigest(`0x${'ab'.repeat(32)}`, 5n), keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }], [`0x${'ab'.repeat(32)}`, 5n, OKX_IMPLEMENTATION])));

  // An account the operation deploys through OKX's factory: its keys are createAccount's. Storage set for an account
  // not yet created wouldn't last, so the stand-in key takes the passkey's place in what the factory hands the
  // account's initializer (the implementation's address runs okxInitializing, its own code moved aside).
  const FACTORY = '0x5c328f3b5f117ffc693378a2c5b16c4f80f86295';
  await chain.putCode(FACTORY, `0x${compiled('OkxLikeFactory').evm.deployedBytecode.object}`);
  await chain.putCode(getContractAddress({ from: EP as Hex, nonce: 1n }), `0x${compiled('SenderCreatorLike').evm.deployedBytecode.object}`);
  const owners = [{ keyHash: passkey, keyType: '0x0000000000000000000000000000000000000002' as Hex }, { keyHash: other, keyType: '0x0000000000000000000000000000000000000001' as Hex }];
  const fresh = `0x${(await chain.evm.runCall({ to: (await import('@ethereumjs/util')).createAddressFromString(FACTORY), data: (await import('@ethereumjs/util')).hexToBytes(encodeFunctionData({ abi: O, functionName: 'getAddress', args: [owners, 9n] })), gasLimit: 1_000_000n })).execResult.returnValue.slice(12).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '')}`;
  await chain.exec(usdc, call('mint', [fresh, 100_000_000n]));
  await chain.setBalance(fresh, E);
  p = await preview(operation({ sender: fresh, callData: calls(fresh), factory: FACTORY, factoryData: encodeFunctionData({ abi: O, functionName: 'createAccount', args: [owners, 9n] }), verificationGasLimit: '0xf4240' }), fresh);
  assert.match(whole(p), /deploying the account through its factory/);
  assert.match(whole(p), /a passkey's assertion over the operation's hash/);
  assert.doesNotMatch(whole(p), /doesn't accept/);
  assert.deepEqual(codes(p).filter(c => c === 'userop_execution_reverts'), []);
  assert.deepEqual(usdcChange(p), ['out 50']);
  // The code that stands at the implementation's address: initialize((bytes32,address)[]) gets the stand-in key
  // where the word at its place is the real key's, and everything else goes on to the moved code unchanged.
  const { okxInitializing } = await import('../src/erc4337-sim.ts');
  const { hexToBytes: toBytes, bytesToHex: toHex, createAddressFromString: at } = await import('@ethereumjs/util');
  const MOVED = '0x0000000000000000000000000000000000ec0c0d', WRAPPED = '0x0000000000000000000000000000000000ec0c0e';
  await chain.putCode(MOVED, '0x366000600037366000f3' as Hex); // returns its calldata
  await chain.putCode(WRAPPED, okxInitializing(passkey, `0x${'5e'.repeat(32)}`, 4 + 64));
  const echo = async (data: Hex) => toHex((await chain.evm.runCall({ caller: at(OWNER), to: at(WRAPPED), data: toBytes(data), gasLimit: 200_000n })).execResult.returnValue);
  const init = encodeFunctionData({ abi: parseAbi(['struct Owner { bytes32 keyHash; address keyType; }', 'function initialize(Owner[] owners)']), functionName: 'initialize', args: [owners] });
  assert.equal(init.slice(0, 10), '0x466e5483');
  assert.equal(await echo(init), init.replace(passkey.slice(2), '5e'.repeat(32)));
  const otherCall = encodeFunctionData({ abi: O, functionName: 'createAccount', args: [owners, 9n] });
  assert.equal(await echo(otherCall), otherCall);
  assert.equal(await echo('0x'), '0x');
});

test('A whole operation’s trace: the EntryPoint’s run of it, from validation to the calls and the gas payment', async () => {
  const hash = userOpHash(readOperation(operation(), '0.7')!, EP, 999, '0.7');
  const p = await previewRequest({ method: 'personal_sign', params: [hash, OWNER] }, { now: NOW, chainId: 999, trace: true, userOperation: { entryPoint: EP, operation: operation() } }, deps);
  assert.deepEqual(usdcChange(p), ['out 50']);
  const t = p.trace!;
  assert.equal(t.agrees, true);
  // The EntryPoint's simulation call first, the account under it: its validation, then its execute, which transfers.
  assert.equal(t.calls[0].to, EP);
  const to = (a: string, selector: string) => t.calls.filter(c => c.to === a && c.selector === selector);
  assert.equal(to(account, '0x19822f7c').length, 1, 'validateUserOp');
  const transfer = t.calls.find(c => c.to === usdc && c.function === 'transfer(address,uint256)')!;
  assert.deepEqual([transfer.from, transfer.label, transfer.args!.map(a => a.value)], [account, 'USDC', [BOB, '50000000']]);
  assert.deepEqual(transfer.events!.map(e => e.name), ['Transfer']);
  // The stand-in for the signature shows as the call it is: ecrecover, asked by the account during validation.
  assert.ok(t.calls.some(c => c.to === '0x0000000000000000000000000000000000000001' && c.from === account));
  // The token's balances and the EntryPoint's books are among the state changed.
  assert.ok(t.stateChanges!.some(s => s.address === usdc && s.storage!.length === 2));
  assert.ok(t.stateChanges!.some(s => s.address === EP));
  // Not asked for: none.
  assert.equal((await preview(operation())).trace, undefined);
});
