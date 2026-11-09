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
import type { Dependencies, Preview } from '../src/types.ts';
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
});
