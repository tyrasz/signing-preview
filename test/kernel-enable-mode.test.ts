// ZeroDev Kernel v3's enable mode, simulated whole (src/erc4337-sim.ts, kernelEnableStub): an operation that installs
// a session key (a permission) and is signed by it, the owner's approval (its Enable signature) in the operation's own
// signature. The stand-in's layout, and the whole operation run by the fork simulator on test/evm-chain.ts with
// Kernel's enable mode (test/fixtures/SimulationMocks.sol, KernelEnable) at Kernel v3.1's implementation address (in a
// file of its own: the fork simulator keeps the code it reads at an address for the process, and other tests run other
// code there).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { concatHex, decodeFunctionData, encodeFunctionData, keccak256, parseAbi, stringToHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { previewRequest } from '../src/preview.ts';
import { StaticTokenRegistry } from '../src/chains.ts';
import { RpcSimulator } from '../src/simulation.ts';
import { JsonRpcClient } from '../src/rpc.ts';
import { ForkSimulator } from '../src/fork-simulator.ts';
import { ENTRY_POINT_SIMULATIONS_V07 } from '../src/entrypoint-simulations.ts';
import { readOperation, userOpHash } from '../src/userop-hash.ts';
import type { Dependencies, Preview } from '../src/types.ts';
import { detail, NOW } from './helpers.ts';
import { compiled, testChain } from './evm-chain.ts';

const EP = '0x0000000071727de22e5e9d8baf0edac6f37da032';
const OWNER_KEY = privateKeyToAccount('0x7777777777777777777777777777777777777777777777777777777777777777'), OWNER = OWNER_KEY.address.toLowerCase();
// The session key the operation installs (a permission with ZeroDev's ECDSA signer), and signs with.
const SESSION_KEY = privateKeyToAccount('0x5555555555555555555555555555555555555555555555555555555555555555'), KEY = SESSION_KEY.address.toLowerCase() as Hex;
const BOB = '0xb0b0000000000000000000000000000000000002';
const URL_ = 'http://hyperevm.invalid';
const E = 10n ** 18n;

const chain = await testChain();
const usdc = await chain.deploy('Token', 'string,uint8', ['USDC', 6]);
await chain.putCode(EP, ENTRY_POINT_SIMULATIONS_V07 as Hex);
const A = parseAbi(['function mint(address,uint256)', 'function transfer(address,uint256)', 'function execute(address,uint256,bytes)']);
const call = (fn: string, args: unknown[]) => encodeFunctionData({ abi: A, functionName: fn, args } as never);
const deps: Dependencies = {
  tokens: new StaticTokenRegistry({ 999: [{ address: usdc, symbol: 'USDC', decimals: 6, name: 'USD Coin' }] }),
  rpc: new JsonRpcClient({ 999: URL_ }, { fetchImpl: chain.fetchImpl }),
  simulator: new RpcSimulator({ 999: URL_ }, { fetchImpl: chain.fetchImpl, fork: new ForkSimulator({ 999: URL_ }, { fetchImpl: chain.fetchImpl }) }),
};
const sendUsdc = call('execute', [usdc, 0n, call('transfer', [BOB, 50_000_000n])]);
const operation = (m: Record<string, unknown> = {}) => ({ nonce: '0x0', callData: sendUsdc, callGasLimit: '0x30d40', verificationGasLimit: '0x30d40', preVerificationGas: '0xc350', maxFeePerGas: '0x77359400', maxPriorityFeePerGas: '0x3b9aca00', ...m });
const preview = (op: Record<string, unknown>, signer: string): Promise<Preview> =>
  previewRequest({ method: 'personal_sign', params: [userOpHash(readOperation(op, '0.7')!, EP, 999, '0.7'), signer] }, { now: NOW, chainId: 999, userOperation: { entryPoint: EP, operation: op } }, deps);
const usdcChange = (p: Preview) => p.assetChanges.filter(c => c.symbol === 'USDC').map(c => `${c.direction} ${c.amount}`);

test('A Kernel operation in enable mode: its own enable data kept, the owner’s Enable signature and the new key’s stood in for, the whole operation run', async () => {
  const { STUB_SIGNATURE, kernelEnableSignature } = await import('../src/erc4337-sim.ts');
  const { encodeAbiParameters: enc } = await import('viem');
  // Kernel v3.1's implementation address runs KernelEnable (its enable mode for a permission), with ZeroDev's ECDSA
  // validator as the root (OWNER) and its ECDSA signer for the permission, at their own addresses.
  const KERNEL_V31 = '0xbac849bb641841b44e965fb01a4bf5f074f84b4d', VALIDATOR = '0x845adb2c711129d4f3966735ed98a9f09fc4ce57', SIGNER = '0x6a6f069e2a08c2468e7724ab3250cdbfba14d4ff';
  await chain.putCode(KERNEL_V31, `0x${compiled('KernelEnable').evm.deployedBytecode.object}`);
  await chain.putCode(VALIDATOR, `0x${compiled('KernelEcdsaValidatorMock').evm.deployedBytecode.object}`);
  await chain.putCode(SIGNER, `0x${compiled('KernelEcdsaSignerMock').evm.deployedBytecode.object}`);
  const kernel = await chain.deploy('Proxy1967', 'address', [KERNEL_V31]);
  await chain.exec(kernel, encodeFunctionData({ abi: parseAbi(['function init(address,address,address)']), functionName: 'init', args: [EP, VALIDATOR, OWNER as Hex] }));
  await chain.exec(usdc, call('mint', [kernel, 100_000_000n]));
  await chain.setBalance(kernel, E);
  // A session key with ZeroDev's sudo policy (its part of the signature, 2 bytes, kept as the dApp's SDK put it),
  // permission 0x4e48b87d; the SDK's dummy where both signatures go.
  const validatorData = enc([{ type: 'bytes[]' }], [[concatHex(['0x0000', '0x67b436cad8a6d025df6c82c5bb43fbf11fc5b9b7']), concatHex(['0x0000', SIGNER, KEY])]]);
  const policy = concatHex(['0x00', '0x0000000000000002', '0xabcd']);
  const enable = { replayable: false, hook: `0x${'00'.repeat(20)}` as Hex, validatorData, hookData: '0x' as Hex, selectorData: '0xe9ae5c53' as Hex, enableSig: STUB_SIGNATURE, userOpSig: concatHex([policy, '0xff', STUB_SIGNATURE]) };
  const nonce = `0x01024e48b87d${'00'.repeat(26)}`;
  // (Installing what it names costs gas in validation: a limit as enable-mode operations carry.)
  const p = await preview(operation({ sender: kernel, nonce, signature: kernelEnableSignature(enable), verificationGasLimit: '0x7a120' }), BOB);
  const whole = p.decoding.notes.find(n => /whole operation was simulated/.test(n)) ?? p.decoding.notes.join(' | ');
  assert.match(whole, /Kernel's enable mode/);
  assert.doesNotMatch(whole, /doesn't accept/);
  assert.ok(detail(p, 'Gas cost (simulated)'), 'the whole operation’s gas is shown');
  assert.deepEqual(usdcChange(p), ['out 50']);
  // Without the enable data (no signature with it), Kernel can't read what to install: only the calls are simulated.
  const bare = await preview(operation({ sender: kernel, nonce }), BOB);
  assert.ok(bare.decoding.notes.some(n => /validation reverts on a stand-in/.test(n)), bare.decoding.notes.join(' | '));
  // Enable data for a validator this stand-in doesn't know (type 0x01, an unknown address): the operation's own
  // signature runs as it is, as before (here this Kernel's validation reverts on it, and the calls run alone).
  const unknown = await preview(operation({ sender: kernel, nonce: `0x0101${'ab'.repeat(20)}${'00'.repeat(10)}`, signature: kernelEnableSignature(enable), verificationGasLimit: '0x7a120' }), BOB);
  assert.ok(!unknown.decoding.notes.some(n => /Kernel's enable mode/.test(n)), unknown.decoding.notes.join(' | '));
  assert.ok(unknown.decoding.notes.some(n => /validation reverts on a stand-in/.test(n)), unknown.decoding.notes.join(' | '));

  // Signed for real (the owner over the Enable digest, as a wallet signs typed data; the key over the operation's
  // hash as a message, as ZeroDev's SDK signs): the stand-ins' run costs exactly what the real signatures' does with
  // the real ecrecover, the key's check of the bare hash first (recovering someone else) included.
  const { simulateOperation, kernelEnableDigest, entryPointOverride } = await import('../src/erc4337-sim.ts');
  const op = operation({ sender: kernel, nonce, verificationGasLimit: '0x7a120' });
  const digest = kernelEnableDigest(enable, { account: kernel, chainId: 999, version: '0.3.1', vId: `0x024e48b87d${'00'.repeat(16)}`, nonce: 1 });
  const signed = kernelEnableSignature({ ...enable, enableSig: await OWNER_KEY.sign({ hash: digest }), userOpSig: concatHex([policy, '0xff', await SESSION_KEY.signMessage({ message: { raw: userOpHash(readOperation(op, '0.7')!, EP, 999, '0.7') } })]) });
  const input = { chainId: 999, entryPoint: EP, sender: kernel, nonce: BigInt(nonce), initCode: '0x' as Hex, callData: sendUsdc, callGasLimit: 200_000n, verificationGasLimit: 500_000n, preVerificationGas: 50_000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, paymasterAndData: '0x' as Hex, signer: BOB };
  const [standIn, dummies] = [await simulateOperation({ ...input, signature: signed }, deps), await simulateOperation({ ...input, signature: kernelEnableSignature(enable) }, deps)];
  assert.equal(standIn?.standIn, 'enable');
  assert.ok(standIn?.executed && !standIn.account?.signatureFailed && standIn.gasUsed, JSON.stringify(standIn?.rejected));
  const HANDLE = parseAbi(['function simulateHandleOp((address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature) op, address target, bytes targetCallData)']);
  const request = standIn.requests![0], { args } = decodeFunctionData({ abi: HANDLE, data: request.data as Hex });
  assert.notEqual(args[0].signature, signed, 'the stand-ins ran, not the real signatures');
  const { '0x0000000000000000000000000000000000000001': _, ...overrides } = request.stateOverrides!;
  const real = await deps.simulator!.simulate({ ...request, data: encodeFunctionData({ abi: HANDLE, functionName: 'simulateHandleOp', args: [{ ...args[0], signature: signed }, args[1], args[2]] }), stateOverrides: { ...overrides, [EP]: entryPointOverride(EP, 999)! } });
  const UOE = keccak256(stringToHex('UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)'));
  const event = real?.logs?.find(l => l.topics[0] === UOE);
  assert.ok(event, real?.status);
  assert.equal(BigInt(`0x${event.data.slice(2 + 64, 2 + 128)}`), 1n, 'the real signatures validate and the calls succeed');
  assert.equal(standIn.gasUsed, BigInt(`0x${event.data.slice(2 + 192, 2 + 256)}`), 'the same gas as the real signatures');
  // The SDK's dummies in their place: the same stand-ins, the same gas.
  assert.equal(dummies?.standIn, 'enable');
  assert.equal(dummies?.gasUsed, standIn.gasUsed);
});

test('Kernel enable mode’s stand-in: the operation’s enable data, policies’ parts kept, a stand-in for each signature recovered as its signer over what it signs', async () => {
  const { kernelEnableStub, kernelEnableSignature, kernelEnableDigest, readKernelEnable, stubSignature, STUB_SIGNATURE, zeroDevWebAuthnStub, ownerSignerId } = await import('../src/erc4337-sim.ts');
  const { encodeAbiParameters: enc, hashMessage, keccak256: k, decodeAbiParameters } = await import('viem');
  const ACCOUNT = '0xacc0000000000000000000000000000000000acc', KERNEL_V31 = '0xbac849bb641841b44e965fb01a4bf5f074f84b4d', KERNEL_V32 = '0xd830d15d3dc0c269f3dbaa0f3e8626d33cfdabe1';
  const ownerKey = privateKeyToAccount('0x7777777777777777777777777777777777777777777777777777777777777777');
  const HASH = `0x${'4a'.repeat(32)}` as Hex, AGNOSTIC = `0x${'0a'.repeat(32)}` as Hex;
  const word = (v: string) => `0x${v.replace(/^0x/, '').padStart(64, '0')}`;
  // The account's root (rootValidator(), a bytes21 left-aligned), its currentNonce() and the validator's owner.
  const rpc = (root: string) => ({ has: () => true, call: async (_c: number, method: string, params: unknown[]) => {
    if (method !== 'eth_call') throw new Error(method);
    const { to, data } = params[0] as { to: string; data: string };
    if (data.startsWith('0xf1f7f0f9')) return `${root}${'00'.repeat(11)}`; // rootValidator()
    if (data.startsWith('0xadb610a3')) return word('2'); // currentNonce()
    if (data.startsWith('0x20709efc') && to === '0x845adb2c711129d4f3966735ed98a9f09fc4ce57') return word(OWNER); // ecdsaValidatorStorage(account)
    throw new Error(`unexpected ${data.slice(0, 10)}`);
  } });
  const context = (root: string, signature?: Hex, nonce = BigInt(`0x01024e48b87d${'00'.repeat(26)}`), runs = KERNEL_V31, signer: string = KEY) => ({ deps: { rpc: rpc(root) }, chainId: 8453, sender: ACCOUNT, signer, nonce, runs,
    hash: async () => HASH, replayableHash: () => AGNOSTIC, ...(signature && { signature }) }) as never;
  const validatorData = enc([{ type: 'bytes[]' }], [[concatHex(['0x0000', '0x6a6f069e2a08c2468e7724ab3250cdbfba14d4ff', KEY])]]);
  const policy = concatHex(['0x00', '0x0000000000000002', '0xabcd']);
  const e = { replayable: false, hook: `0x${'00'.repeat(20)}` as Hex, validatorData, hookData: '0x' as Hex, selectorData: '0xe9ae5c53' as Hex, enableSig: STUB_SIGNATURE, userOpSig: concatHex([policy, '0xff', STUB_SIGNATURE]) };
  assert.deepEqual(readKernelEnable(kernelEnableSignature(e)), e);
  const vId = `0x024e48b87d${'00'.repeat(16)}` as Hex;
  const digest = kernelEnableDigest(e, { account: ACCOUNT, chainId: 8453, version: '0.3.1', vId, nonce: 2 });

  // ZeroDev's ECDSA validator as the root, ZeroDev's ECDSA signer installed: the owner over the digest (its wallet
  // signs the typed data), the key over the hash's personal_sign form (ZeroDev's SDK signs it as a message).
  const [stub] = await kernelEnableStub(context('0x01845adb2c711129d4f3966735ed98a9f09fc4ce57'), e);
  assert.equal(stub.enable, true);
  const built = readKernelEnable(stub.signature)!;
  assert.deepEqual({ ...built, enableSig: e.enableSig, userOpSig: e.userOpSig }, e, 'what it installs is the operation’s own');
  assert.equal(built.enableSig, stubSignature(6));
  assert.equal(built.userOpSig, concatHex([policy, '0xff', stubSignature(3)]), 'the policy’s part kept, then 0xff and the key’s');
  assert.deepEqual(stub.cosigners, [{ signature: stubSignature(6), signer: OWNER, digest }, { signature: stubSignature(3), signer: KEY, digest: hashMessage({ raw: HASH }) }]);
  // Each stand-in's r is a point of the curve, so that asked over another digest first the precompile recovers someone.
  const P = 2n ** 256n - 2n ** 32n - 977n;
  const pow = (b: bigint, x: bigint) => { let r = 1n; b %= P; for (; x; x >>= 1n, b = b * b % P) if (x & 1n) r = r * b % P; return r; };
  for (const c of stub.cosigners!) assert.equal(pow(BigInt(c.signature.slice(0, 66)) ** 3n + 7n, (P - 1n) / 2n), 1n, c.signature);
  // The owner's own signature over the digest's personal_sign form: then the stand-in recovers over that form.
  const own = await ownerKey.signMessage({ message: { raw: digest } });
  const [signed] = await kernelEnableStub(context('0x01845adb2c711129d4f3966735ed98a9f09fc4ce57'), { ...e, enableSig: own });
  assert.equal(signed.cosigners![0].digest, hashMessage({ raw: digest }));

  // Replayable (chain-agnostic, Kernel v3.2 on): the marker kept, the Enable domain's chain 0, and Kernel's
  // chain-agnostic hash. Kernel v3.1 has no such signatures (it would read the marker as the hook): none.
  const [agnostic] = await kernelEnableStub(context('0x01845adb2c711129d4f3966735ed98a9f09fc4ce57', undefined, undefined, KERNEL_V32), { ...e, replayable: true });
  assert.ok(agnostic.signature.startsWith(k(stringToHex('kernel.replayable.signature'))));
  // (A Kernel v3.2 owner signs the digest's personal_sign form: below.)
  assert.deepEqual(agnostic.cosigners!.map(c => c.digest), [hashMessage({ raw: kernelEnableDigest({ ...e, replayable: true }, { account: ACCOUNT, chainId: 8453, version: '0.3.2', vId, nonce: 2 }) }), hashMessage({ raw: AGNOSTIC })]);
  assert.notEqual(agnostic.cosigners![0].digest, hashMessage({ raw: kernelEnableDigest(e, { account: ACCOUNT, chainId: 8453, version: '0.3.2', vId, nonce: 2 }) }));
  assert.deepEqual(await kernelEnableStub(context('0x01845adb2c711129d4f3966735ed98a9f09fc4ce57'), { ...e, replayable: true }), []);
  // With the SDK's dummy, a Kernel v3.2 owner is taken to sign the digest's personal_sign form, as they do (48 of 48
  // on Base); v3.1's and v3.3's, the digest itself.
  const [v32] = await kernelEnableStub(context('0x01845adb2c711129d4f3966735ed98a9f09fc4ce57', undefined, undefined, KERNEL_V32), e);
  assert.equal(v32.cosigners![0].digest, hashMessage({ raw: kernelEnableDigest(e, { account: ACCOUNT, chainId: 8453, version: '0.3.2', vId, nonce: 2 }) }));

  // ZeroDev's passkey validator as the root: a passkey's assertion over the digest, usePrecompiled as in the
  // operation's own (here its dummy's), checked by P256VERIFY's stand-in.
  const [passkey] = await kernelEnableStub(context('0x017ab16ff354acb328452f1d445b3ddee9a91e9e69'), { ...e, enableSig: zeroDevWebAuthnStub(`0x${'00'.repeat(32)}`, true) });
  const [, clientDataJSON, , , , usePrecompiled] = decodeAbiParameters([{ type: 'bytes' }, { type: 'string' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bool' }], readKernelEnable(passkey.signature)!.enableSig);
  assert.equal(`0x${Buffer.from(JSON.parse(clientDataJSON).challenge, 'base64url').toString('hex')}`, digest);
  assert.equal(usePrecompiled, true);
  assert.equal(passkey.p256, true);
  assert.deepEqual(passkey.cosigners, [{ signature: stubSignature(3), signer: KEY, digest: hashMessage({ raw: HASH }) }]);

  // A deploying account whose root keeps signers by id (its set-up names each id's ECDSA owner): the operation's id,
  // then the stand-in recovered as that id's owner, over the digest's personal_sign form (as its owners sign), the
  // validation nonce 1 (initialize()'s).
  const SIGNER_ID = '0x01933401632d92bc7005d7415242171a55e20004ba', ID = `0x${'22'.repeat(32)}` as Hex;
  const configs = enc([{ type: 'tuple[]', components: [{ name: 'id', type: 'bytes32' }, { name: 'signer', type: 'address' }, { name: 'data', type: 'bytes' }] }],
    [[{ id: `0x${'11'.repeat(32)}`, signer: '0x9895a7b30a9dfcfbb1cd8f41595d2ad15fdcc9c3', data: KEY as Hex }, { id: ID, signer: '0x9895a7b30a9dfcfbb1cd8f41595d2ad15fdcc9c3', data: OWNER as Hex }]]);
  const [byId] = await kernelEnableStub(context(SIGNER_ID), { ...e, enableSig: concatHex([ID, STUB_SIGNATURE]) }, { root: SIGNER_ID as Hex, installs: new Map([[SIGNER_ID, configs]]), implementation: KERNEL_V31 });
  assert.equal(readKernelEnable(byId.signature)!.enableSig, concatHex([ID, stubSignature(6)]));
  assert.deepEqual(byId.cosigners![0], { signature: stubSignature(6), signer: OWNER, digest: hashMessage({ raw: kernelEnableDigest(e, { account: ACCOUNT, chainId: 8453, version: '0.3.1', vId, nonce: 1 }) }) });

  // An existing account whose root keeps signers by id, the SDK's dummy in place of the owner's signature: its owner
  // is the signer the preview is for, whose key has the operation's id (ownerSignerId); not the account itself.
  const ownerId = ownerSignerId(OWNER);
  const [existing] = await kernelEnableStub(context(SIGNER_ID, undefined, undefined, KERNEL_V31, OWNER), { ...e, enableSig: concatHex([ownerId, STUB_SIGNATURE]) });
  assert.deepEqual(existing.cosigners![0], { signature: stubSignature(6), signer: OWNER, digest: hashMessage({ raw: kernelEnableDigest(e, { account: ACCOUNT, chainId: 8453, version: '0.3.1', vId, nonce: 2 }) }) });
  assert.deepEqual(await kernelEnableStub(context(SIGNER_ID, undefined, undefined, KERNEL_V31, ACCOUNT), { ...e, enableSig: concatHex([ownerId, STUB_SIGNATURE]) }), []);

  // A root it doesn't know, or a signer it doesn't: none (the caller falls back).
  assert.deepEqual(await kernelEnableStub(context(`0x01${'ab'.repeat(20)}`), e), []);
  assert.deepEqual(await kernelEnableStub(context('0x01845adb2c711129d4f3966735ed98a9f09fc4ce57'), { ...e, validatorData: enc([{ type: 'bytes[]' }], [[concatHex(['0x0000', `0x${'cd'.repeat(20)}`, KEY])]]) }), []);
  // Not enable data at all: not read as such.
  assert.equal(readKernelEnable(STUB_SIGNATURE), undefined);
});

test('The ecrecover stand-in for several keys: a stand-in over its own digest recovers as its signer, over any other as no one’s key, each for exactly the precompile’s price', async () => {
  const { ecrecoverAsMany, stubSignature } = await import('../src/erc4337-sim.ts');
  const { hexToBytes: toBytes, bytesToHex: toHex, createAddressFromString: at } = await import('@ethereumjs/util');
  const A = '0xa000000000000000000000000000000000000a0a', B = '0xb000000000000000000000000000000000000b0b', C = '0xc000000000000000000000000000000000000c0c';
  const [sa, sb, sc] = [6, 3, 12].map(stubSignature), own = `0x${'d1'.repeat(32)}` as Hex, other = `0x${'99'.repeat(32)}` as Hex, theirs = `0x${'c3'.repeat(32)}` as Hex;
  const input = (sig: Hex, hash: Hex) => concatHex([hash, `0x${sig.slice(130).padStart(64, '0')}`, `0x${sig.slice(2, 66)}`, `0x${sig.slice(66, 130)}`]);
  const where = '0x0000000000000000000000000000000000ec0bad';
  for (const price of [3000, 15_000]) {
    // A over any digest; B only over `own`; C only over `theirs`.
    await chain.putCode(where, ecrecoverAsMany([{ signature: sa, signer: A }, { signature: sb, signer: B, digest: own }, { signature: sc, signer: C, digest: theirs }], price));
    for (const [sig, hash, expect] of [[sa, other, A], [sb, own, B], [sb, other, '0x0000000000000000000000000000000000ec0b0d'], [sc, theirs, C], [sc, own, '0x0000000000000000000000000000000000ec0b0d']] as const) {
      const r = await chain.evm.runCall({ caller: at(OWNER), to: at(where), data: toBytes(input(sig, hash)), gasLimit: 100_000n });
      assert.deepEqual([`0x${toHex(r.execResult.returnValue).slice(-40)}`, r.execResult.executionGasUsed], [expect, BigInt(price)], `${sig.slice(0, 66)} over ${hash.slice(0, 6)}`);
    }
    // Any other signature goes on to the real precompile (moved; here nothing is there to answer).
    const r = await chain.evm.runCall({ caller: at(OWNER), to: at(where), data: toBytes(input(stubSignature(9), own)), gasLimit: 100_000n });
    assert.equal(r.execResult.returnValue.length, 0);
  }
});
