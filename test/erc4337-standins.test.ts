// Stand-ins in the layout of accounts that rejected the plain one (src/erc4337-sim.ts): Bleap's first cosigning
// module (CosigningModuleV1) on Kernel v3 accounts its FactoryStaker deploys, Send's passkey account, and session keys'
// operations through Rhinestone's SmartSession. Whole operations run by the fork simulator on test/evm-chain.ts (in a
// file of its own: the fork simulator keeps the code it reads at an address for the process, and these tests put mocks
// at Send's implementation and SmartSession's addresses).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { concatHex, decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData, numberToHex, parseAbi, sha256, stringToHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { previewRequest } from '../src/preview.ts';
import { StaticTokenRegistry } from '../src/chains.ts';
import { RpcSimulator } from '../src/simulation.ts';
import { JsonRpcClient } from '../src/rpc.ts';
import { ForkSimulator } from '../src/fork-simulator.ts';
import { ENTRY_POINT_SIMULATIONS_V07 } from '../src/entrypoint-simulations.ts';
import { readOperation, userOpHash } from '../src/userop-hash.ts';
import { cosigningOwner, kernelEnableStub, P256_STUB, SEND_IMPLEMENTATION, sendStandIn, simulateOperation, smartSessionOf, STUB_COSIGNATURE, STUB_SIGNATURE, stubSignature, type KernelEnable } from '../src/erc4337-sim.ts';
import type { Dependencies, Preview, SimulationRequest } from '../src/types.ts';
import { NOW } from './helpers.ts';
import { compiled, testChain } from './evm-chain.ts';

const EP = '0x0000000071727de22e5e9d8baf0edac6f37da032';
const KEY = privateKeyToAccount('0x7777777777777777777777777777777777777777777777777777777777777777').address.toLowerCase();
const BOB = '0xb0b0000000000000000000000000000000000002';
const URL_ = 'http://hyperevm.invalid';
const E = 10n ** 18n;
const V1 = '0x61576d9ef23514bfe6f080e22ccfff473cf11a1a', BLEAP_COSIGNER = '0x9162521efc719578b3e238b153df04ad248c0569';

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
const operation = (m: Record<string, unknown>) => ({ nonce: '0x0', callData: sendUsdc, callGasLimit: '0x30d40', verificationGasLimit: '0x30d40', preVerificationGas: '0xc350', maxFeePerGas: '0x77359400', maxPriorityFeePerGas: '0x3b9aca00', ...m });
const preview = (op: Record<string, unknown>, signer: string): Promise<Preview> =>
  previewRequest({ method: 'personal_sign', params: [userOpHash(readOperation(op, '0.7')!, EP, 999, '0.7'), signer] }, { now: NOW, chainId: 999, userOperation: { entryPoint: EP, operation: op } }, deps);
const usdcChange = (p: Preview) => p.assetChanges.filter(c => c.symbol === 'USDC').map(c => `${c.direction} ${c.amount}`);
const wholeNote = (p: Preview) => p.decoding.notes.find(n => /whole operation was simulated/.test(n)) ?? p.decoding.notes.join(' | ');
const funded = async (account: string) => { await chain.exec(usdc, call('mint', [account, 100_000_000n])); await chain.setBalance(account, E); };

test('Bleap’s cosigning modules: the owner in either’s install data, V1’s its 20 bytes, V2’s abi-encoded', () => {
  assert.equal(cosigningOwner('0x263255d53d33426a01d9e5dd761baa06f95555ce'), '0x263255d53d33426a01d9e5dd761baa06f95555ce');
  assert.equal(cosigningOwner(encodeAbiParameters([{ type: 'address' }], ['0x263255D53D33426A01d9E5DD761BAa06f95555CE'])), '0x263255d53d33426a01d9e5dd761baa06f95555ce');
  for (const data of ['0x', `0x${'00'.repeat(20)}`, `0x${'ff'.repeat(32)}`, `0x${'12'.repeat(21)}`] as Hex[]) assert.equal(cosigningOwner(data), undefined, data);
});

// A Kernel v3 account deployed through ZeroDev's FactoryStaker with Bleap's CosigningModuleV1 as its root permission:
// the initCode of an operation on Arbitrum One (0x933f…3c40), whose owner (the install data) and Bleap's cosigner
// signed it, each over the operation's hash as a message.
const BLEAP_INIT = '0xd703aae79538628d27099b8c4f621be4ccd142d5c5265d5d000000000000000000000000aac5d4240af87249b3f71bc8e4a2cae074a3e4190000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001c43c3b752b02ac0dfb91000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a0000000000000000000000000000000000000000000000000000000000000018000000000000000000000000000000000000000000000000000000000000001a000000000000000000000000000000000000000000000000000000000000000c0000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000002a000061576d9ef23514bfe6f080e22ccfff473cf11a1a263255d53d33426a01d9e5dd761baa06f95555ce000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' as Hex;
const BLEAP_OWNER = '0x263255d53d33426a01d9e5dd761baa06f95555ce';

test('A Kernel v3 being deployed with Bleap’s CosigningModuleV1 as its root: 0xff, the owner’s stand-in and the cosigner’s; asked by anyone else, the preview names the owner', async () => {
  const OP = '(address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature)';
  const HANDLE = parseAbi([`function simulateHandleOp(${OP} op, address target, bytes targetCallData)`]);
  // A node that answers the module's cosigner(), the operation's hash and the latest block; and a simulator that keeps
  // what it was asked to run and answers as the EntryPoint does a validation that reverts (AA23).
  const tried: SimulationRequest[] = [];
  const word = (a: string) => `0x${a.slice(2).padStart(64, '0')}`;
  const node = { has: () => true, call: async (_c: number, method: string, params: unknown[]) => {
    if (method === 'eth_getBlockByNumber') return { number: '0x10', baseFeePerGas: '0x1' };
    if (method === 'eth_maxPriorityFeePerGas') return '0x0';
    if (method === 'eth_call') {
      const { to, data } = params[0] as { to: string; data: string };
      if (to === V1 && data === '0x681232ad') return word(BLEAP_COSIGNER); // cosigner()
      if (to === EP) return `0x${'4a'.repeat(32)}`; // getUserOpHash
    }
    throw new Error(`unexpected ${method}`);
  } };
  const failed = concatHex(['0x220266b6', encodeAbiParameters([{ type: 'uint256' }, { type: 'string' }], [0n, 'AA23 reverted'])]);
  const simulator = { simulate: async (q: SimulationRequest) => { tried.push(q); return { status: 'reverted' as const, returnData: failed, transfers: [] }; } };
  const sender = '0x1562fcfc045e2265a43cf45887726096c6c8581c';
  const op = { chainId: 42161, entryPoint: EP, sender, nonce: BigInt(`0x0000ac0dfb91${'00'.repeat(16)}5c2b${'00'.repeat(8)}`), initCode: BLEAP_INIT, callData: '0x' as Hex,
    callGasLimit: 100_000n, verificationGasLimit: 400_000n, preVerificationGas: 50_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 0n, paymasterAndData: '0x' as Hex };
  const signatureOf = (q: SimulationRequest) => (decodeFunctionData({ abi: HANDLE, data: q.data as Hex }).args[0] as { signature: Hex }).signature;
  const asOwner = await simulateOperation({ ...op, signer: BLEAP_OWNER }, { rpc: node, simulator } as never);
  assert.equal(signatureOf(tried[0]), concatHex(['0xff', STUB_SIGNATURE, STUB_COSIGNATURE]));
  // ecrecover's stand-in recovers the cosigner's stand-in as Bleap's cosigner (and the owner's as the signer).
  const recover = String(tried[0].stateOverrides?.['0x0000000000000000000000000000000000000001']?.code);
  assert.ok(recover.includes(BLEAP_COSIGNER.slice(2)) && recover.includes(BLEAP_OWNER.slice(2)) && recover.includes(STUB_COSIGNATURE.slice(2, 66)));
  assert.equal(asOwner?.why, undefined);
  tried.length = 0;
  const asBob = await simulateOperation({ ...op, signer: BOB }, { rpc: node, simulator } as never);
  assert.equal(signatureOf(tried[0]), concatHex(['0xff', STUB_SIGNATURE, STUB_COSIGNATURE]));
  assert.match(asBob?.why ?? '', new RegExp(`Bleap's cosigning module \\(0x6157…1a1a\\) takes the signature of the owner it records for the account, ${BLEAP_OWNER}`));
});

test('Kernel’s enable mode installing a CosigningModuleV1 permission: the key from its 20-byte install data, and the cosigner, after the policies’ parts', async () => {
  const ACCOUNT = '0xacc0000000000000000000000000000000000acc', KERNEL_V31 = '0xbac849bb641841b44e965fb01a4bf5f074f84b4d', VALIDATOR = '0x845adb2c711129d4f3966735ed98a9f09fc4ce57';
  const OWNER = '0x0000000000000000000000000000000000000a11';
  const word = (v: string) => `0x${v.replace(/^0x/, '').padStart(64, '0')}`;
  const rpc = { has: () => true, call: async (_c: number, method: string, params: unknown[]) => {
    const { to, data } = params[0] as { to: string; data: string };
    if (method !== 'eth_call') throw new Error(method);
    if (data.startsWith('0xf1f7f0f9')) return `0x01${VALIDATOR.slice(2)}${'00'.repeat(11)}`; // rootValidator()
    if (data.startsWith('0xadb610a3')) return word('2'); // currentNonce()
    if (data.startsWith('0x20709efc')) return word(OWNER); // ecdsaValidatorStorage(account)
    if (to === V1 && data === '0x681232ad') return word(BLEAP_COSIGNER); // cosigner()
    throw new Error(`unexpected ${data.slice(0, 10)}`);
  } };
  const policy = concatHex(['0x00', '0x0000000000000002', '0xabcd']);
  const validatorData = encodeAbiParameters([{ type: 'bytes[]' }], [[concatHex(['0x0000', V1, KEY as Hex])]]);
  const e: KernelEnable = { replayable: false, hook: `0x${'00'.repeat(20)}`, validatorData, hookData: '0x', selectorData: '0xe9ae5c53', enableSig: STUB_SIGNATURE, userOpSig: concatHex([policy, '0xff', STUB_SIGNATURE, STUB_SIGNATURE]) };
  const context = { deps: { rpc }, chainId: 8453, sender: ACCOUNT, signer: KEY, nonce: BigInt(`0x01024e48b87d${'00'.repeat(26)}`), runs: KERNEL_V31, hash: async () => `0x${'4a'.repeat(32)}` as Hex, replayableHash: () => undefined } as never;
  const [stub] = await kernelEnableStub(context, e);
  assert.ok(stub?.enable, 'a stand-in is made');
  assert.deepEqual(stub.cosigners!.map(c => [c.signature, c.signer]), [[stubSignature(6), OWNER], [stubSignature(3), KEY], [stubSignature(14), BLEAP_COSIGNER]]);
  assert.ok(stub.signature.toLowerCase().includes(concatHex([policy, '0xff', stubSignature(3), stubSignature(14)]).slice(2)));
});

test('Send’s account: version 1, validUntil, the key’s slot and its WebAuthn assertion, laid out as its app’s own', () => {
  // An operation's real signature on Base (0xf6f1…a2bf), key slot 0.
  const real = '0x0100006af9771400000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000c000000000000000000000000000000000000000000000000000000000000001200000000000000000000000000000000000000000000000000000000000000017000000000000000000000000000000000000000000000000000000000000000175777295ae6b628b1f7368d67742e4feeabf184f18139d553e3425268eb599e21ed47d429fd2039b61c29f46c5b691f251730ea8b0e34ab48ba7a06c700067a3000000000000000000000000000000000000000000000000000000000000002524cc9f9995c0d360cc08f23cfca3d1c8020687f1047d78064a0783ad6ea3f0221d00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000008a7b2274797065223a22776562617574686e2e676574222c226368616c6c656e6765223a224151414161766c3346446a713454374b5049636255306b7150357a7576514f524b4f69493045754f5a557a4f66304d6362397373222c226f726967696e223a2268747470733a2f2f73656e642e617070222c2263726f73734f726967696e223a66616c73657d00000000000000000000000000000000000000000000' as Hex;
  const SIG = [{ type: 'tuple', components: [{ name: 'authenticatorData', type: 'bytes' }, { name: 'clientDataJSON', type: 'string' }, { name: 'challengeLocation', type: 'uint256' }, { name: 'responseTypeLocation', type: 'uint256' }, { name: 'r', type: 'uint256' }, { name: 's', type: 'uint256' }] }] as const;
  const hash = `0x${'38'.repeat(32)}` as Hex, until = 0x6af97714n;
  const stand = sendStandIn(hash, 0, until);
  assert.equal(stand.length, real.length, 'the same length: its checks walk the same bytes');
  assert.equal(stand.slice(0, 18), real.slice(0, 18), 'version, validUntil and slot');
  const [mine] = decodeAbiParameters(SIG, `0x${stand.slice(18)}`), [theirs] = decodeAbiParameters(SIG, `0x${real.slice(18)}`);
  assert.equal(mine.authenticatorData, theirs.authenticatorData);
  assert.equal(mine.authenticatorData, concatHex([sha256(stringToHex('send.app')), '0x1d', '0x00000000']));
  assert.deepEqual([mine.challengeLocation, mine.responseTypeLocation], [theirs.challengeLocation, theirs.responseTypeLocation]);
  const client = JSON.parse(mine.clientDataJSON);
  assert.deepEqual(Object.keys(client), Object.keys(JSON.parse(theirs.clientDataJSON)));
  assert.equal(`0x${Buffer.from(client.challenge, 'base64url').toString('hex')}`, concatHex(['0x01', numberToHex(until, { size: 6 }), hash]));
  assert.deepEqual([mine.r, mine.s], [BigInt(P256_STUB.r), BigInt(P256_STUB.s)]);
  assert.equal(sendStandIn(hash, 3, until).slice(16, 18), '03');
});

test('A Send account’s operation runs whole: the stand-in’s assertion passes the WebAuthn checks, through the P256 precompile’s stand-in', async () => {
  // Send's implementation address runs SendLike (its validation, Daimo's WebAuthn checks), behind an ERC-1967 proxy.
  await chain.putCode(SEND_IMPLEMENTATION, `0x${compiled('SendLike').evm.deployedBytecode.object}`);
  const send = await chain.deploy('Proxy1967', 'address', [SEND_IMPLEMENTATION]);
  await chain.exec(send, encodeFunctionData({ abi: parseAbi(['function init(address,uint8,bytes32,bytes32)']), functionName: 'init', args: [EP, 0, `0x${'65'.repeat(32)}`, `0x${'4a'.repeat(32)}`] }));
  await funded(send);
  // The account itself is asked to sign: a passkey wallet's way.
  const p = await preview(operation({ sender: send }), send);
  assert.match(wholeNote(p), /a passkey's assertion over the operation's hash/);
  assert.doesNotMatch(wholeNote(p), /doesn't accept/);
  assert.deepEqual(usdcChange(p), ['out 50']);
  // Asked by an Ethereum key, which isn't one of its keys: the plain stand-in, which the account refuses, and the note
  // says who signs (not a passkey's assertion validating for any signer).
  const q = await preview(operation({ sender: send }), BOB);
  assert.match(wholeNote(q), /ecrecover attributes it to the signer, but the account doesn't accept it as theirs \(Send's account is signed by its passkeys \(a passkey wallet signs as the account itself\), and the signer asked isn't the account\)/);
  assert.deepEqual(usdcChange(q), ['out 50']);
});

test('The SmartSession module an operation’s nonce names, whatever the account puts around it', () => {
  const SS = '0x00000000002b0ecfbd0496ee71e01257da0e37de', OLD = '0x00000000008bdaba73cd9815d79069c247eb4bda';
  assert.equal(smartSessionOf(BigInt(SS) << 96n | 0x3bn), SS); // Safe7579: the top 20 bytes
  assert.equal(smartSessionOf(0xc2f1fd0000000000008bdaba73cd9815d79069c247eb4bda0000000000000000n), OLD); // Biconomy Nexus (Base): after a key of its own
  // Nexus's key starts with 3 bytes of its own, which MEE varies, the first of them 0x01 too (Base, 0x0fb9…d93f): not
  // Kernel's enable mode, which names the module in its validator slot (after its mode and type bytes) to install it.
  assert.equal(smartSessionOf(0x010caa0000000000008bdaba73cd9815d79069c247eb4bda0000000000000000n), OLD);
  assert.equal(smartSessionOf(BigInt(`0x0101${SS.slice(2)}0000${'00'.repeat(7)}05`)), undefined);
  assert.equal(smartSessionOf(BigInt(`0x0001${SS.slice(2)}0000${'00'.repeat(7)}05`)), SS); // Kernel's default mode: a session
  assert.equal(smartSessionOf(0x3bn), undefined);
  // (Only the nonce's key: a sequence number can't name it.)
  assert.equal(smartSessionOf(BigInt(SS) & ((1n << 64n) - 1n)), undefined);
});

test('A session key’s operation through SmartSession: the session whose owners include the signer, with stand-ins to its threshold; anyone else, the preview names the session’s keys', async () => {
  const SS = '0x00000000002b0ecfbd0496ee71e01257da0e37de', ID = `0x${'32'.repeat(32)}` as Hex;
  const COSIGNER = '0xc051000000000000000000000000000000000c05';
  await chain.putCode(SS, `0x${compiled('SmartSessionLike').evm.deployedBytecode.object}`);
  const safe = await chain.deploy('Account7579', 'address', [EP]);
  // A 2-of-2 session (as Safes' on Arbitrum One and Base): the Safe's own key and a cosigner, sorted as OwnableValidator keeps them.
  const owners = [KEY, COSIGNER].sort() as Hex[];
  await chain.exec(safe, encodeFunctionData({ abi: parseAbi(['function enableSession(address,bytes32,uint256,address[])']), functionName: 'enableSession', args: [SS, ID, 2n, owners] }));
  await funded(safe);
  const op = operation({ sender: safe, nonce: numberToHex(BigInt(SS) << 96n) });
  const p = await preview(op, KEY);
  assert.match(wholeNote(p), /ecrecover attributes it to the signer/);
  assert.doesNotMatch(wholeNote(p), /doesn't accept/);
  assert.deepEqual(usdcChange(p), ['out 50']);
  // Asked by someone who isn't one of the session's keys: the session's check runs, fails, and the note says who signs.
  const q = await preview(op, BOB);
  assert.match(wholeNote(q), /doesn't accept it as theirs \(it validates through Rhinestone's SmartSession \(0x0000…37de\), as a session key's operation signed by its session's keys \(2 of 0x[0-9a-f]{4}…[0-9a-f]{4}, 0x[0-9a-f]{4}…[0-9a-f]{4}\), not by the account's owners, and the signer asked isn't one of them\)/);
  assert.deepEqual(usdcChange(q), ['out 50']);
  // An account with no session enabled: validation reverts, and the note says why.
  const bare = await chain.deploy('Account7579', 'address', [EP]);
  await funded(bare);
  const r = await preview(operation({ sender: bare, nonce: numberToHex(BigInt(SS) << 96n) }), KEY);
  // (Safe7579 reports the module's revert as ExecutionFailed(), which the note names.)
  assert.ok(r.decoding.notes.some(n => /validation reverts on a stand-in for the signature \(AA23 reverted: ExecutionFailed: .*\): it validates through Rhinestone's SmartSession \(0x0000…37de\), as a session key's operation, and the account has no session enabled, so only its calls were simulated/.test(n)), r.decoding.notes.join(' | '));
});

test('A Nexus account’s session operation whose nonce’s first byte is 0x01 (one of its own, not Kernel’s enable mode) takes the session’s stand-in', async () => {
  const SS = '0x00000000002b0ecfbd0496ee71e01257da0e37de', ID = `0x${'33'.repeat(32)}` as Hex;
  await chain.putCode(SS, `0x${compiled('SmartSessionLike').evm.deployedBytecode.object}`);
  const nexus = await chain.deploy('NexusLike', 'address', [EP]);
  await chain.exec(nexus, encodeFunctionData({ abi: parseAbi(['function enableSession(address,bytes32,uint256,address[])']), functionName: 'enableSession', args: [SS, ID, 1n, [KEY as Hex]] }));
  await funded(nexus);
  // 3 bytes of Nexus's own (0x010caa, as MEE sent one on Base), its mode byte, the validator, the sequence.
  const p = await preview(operation({ sender: nexus, nonce: `0x010caa00${SS.slice(2)}${'00'.repeat(8)}` }), KEY);
  assert.match(wholeNote(p), /ecrecover attributes it to the signer/);
  assert.doesNotMatch(wholeNote(p), /doesn't accept/);
  assert.deepEqual(usdcChange(p), ['out 50']);
});

test('A Kernel v3 account another factory deploys with deployWithFactory and a deployer’s signature (BNB Chain, Base): its root passkey validator’s stand-in, from the initialize call it hands on', async () => {
  // Factory 0xf928…7053's deployWithFactory(factory, createData, salt, signature): createData is Kernel's
  // initialize, whose root validator here is a passkey's in webauthn-sol's form (0xbbbe…5b1e). With the plain
  // stand-in, validation refused it and the passkey's check didn't run.
  const OP = '(address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature)';
  const HANDLE = parseAbi([`function simulateHandleOp(${OP} op, address target, bytes targetCallData)`]);
  const DEPLOY = parseAbi(['function deployWithFactory(address factory, bytes createData, bytes32 salt, bytes signature)', 'function initialize(bytes21 rootValidator, address hook, bytes validatorData, bytes hookData, bytes[] initConfig)']);
  const PASSKEY_VALIDATOR = '0xbbbe97d3d0e926231975e0b69acb54d534d35b1e', FACTORY = '0xf928242559279b7666ab9c9810b2ce53eac77053';
  const tried: SimulationRequest[] = [];
  const node = { has: () => true, call: async (_c: number, method: string, params: unknown[]) => {
    if (method === 'eth_getBlockByNumber') return { number: '0x10', baseFeePerGas: '0x1' };
    if (method === 'eth_maxPriorityFeePerGas') return '0x0';
    if (method === 'eth_call' && (params[0] as { to: string }).to === EP) return `0x${'4a'.repeat(32)}`; // getUserOpHash
    throw new Error(`unexpected ${method}`);
  } };
  const failed = concatHex(['0x220266b6', encodeAbiParameters([{ type: 'uint256' }, { type: 'string' }], [0n, 'AA23 reverted'])]);
  const simulator = { simulate: async (q: SimulationRequest) => { tried.push(q); return { status: 'reverted' as const, returnData: failed, transfers: [] }; } };
  const initialize = (root: Hex) => encodeFunctionData({ abi: DEPLOY, functionName: 'initialize', args: [root, `0x${'00'.repeat(20)}`, `0x${'ab'.repeat(96)}`, '0x', []] });
  const initCode = (createData: Hex) => concatHex([FACTORY, encodeFunctionData({ abi: DEPLOY, functionName: 'deployWithFactory', args: ['0x43d08cc6b19dd9ef558b3f5162fcb13fca18b9c0', createData, `0x${'9f'.repeat(32)}`, `0x${'65'.repeat(65)}`] })]);
  const op = { chainId: 56, entryPoint: EP, sender: '0x918c61660419e4f45d1584f2f83c9eb7f768036a', nonce: 0n, initCode: initCode(initialize(`0x01${PASSKEY_VALIDATOR.slice(2)}`)), callData: '0x' as Hex,
    callGasLimit: 100_000n, verificationGasLimit: 500_000n, preVerificationGas: 50_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 0n, paymasterAndData: '0x' as Hex };
  const signatureOf = (q: SimulationRequest) => (decodeFunctionData({ abi: HANDLE, data: q.data as Hex }).args[0] as { signature: Hex }).signature;
  const { webAuthnStub } = await import('../src/erc4337-sim.ts');
  await simulateOperation({ ...op, signer: op.sender }, { rpc: node, simulator } as never);
  assert.equal(signatureOf(tried[0]), webAuthnStub(`0x${'4a'.repeat(32)}`));
  assert.ok(tried[0].stateOverrides?.['0x0000000000000000000000000000000000000100'], 'P256VERIFY stood in for');
  // createData that isn't Kernel's initialize: the plain stand-in.
  tried.length = 0;
  await simulateOperation({ ...op, initCode: initCode('0x12345678'), signer: op.sender }, { rpc: node, simulator } as never);
  assert.equal(signatureOf(tried[0]), STUB_SIGNATURE);
});

test('ZeroDev passkey accounts: deployed by the KernelFactory’s own createAccount, and on its passkey validator 0.0.2, both stood in for in its WebAuthn form', async () => {
  // Arbitrum One, 2026-11-18: both got the plain stand-in, and their validation reverted (AA23).
  const OP = '(address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature)';
  const HANDLE = parseAbi([`function simulateHandleOp(${OP} op, address target, bytes targetCallData)`]);
  const ABI = parseAbi(['function createAccount(bytes data, bytes32 salt)', 'function initialize(bytes21 rootValidator, address hook, bytes validatorData, bytes hookData, bytes[] initConfig)']);
  const WEBAUTHN = '0x7ab16ff354acb328452f1d445b3ddee9a91e9e69', V002 = '0xba45a2bfb8de3d24ca9d7f1b551e14dff5d690fd', FACTORY = '0xaac5d4240af87249b3f71bc8e4a2cae074a3e419';
  const SENDER = '0xe6fec47dadb9203a4c31549d8b514631310c0fb7';
  const tried: SimulationRequest[] = [];
  const node = { has: () => true, call: async (_c: number, method: string, params: unknown[]) => {
    if (method === 'eth_getBlockByNumber') return { number: '0x10', baseFeePerGas: '0x1' };
    if (method === 'eth_maxPriorityFeePerGas') return '0x0';
    if (method === 'eth_getLogs') return [];
    if (method === 'eth_getCode') return (params[0] as string).toLowerCase() === SENDER ? '0x' : `0x363d3d373d3d363d7f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc545af43d6000803e6038573d6000fd5b3d6000f3`;
    if (method === 'eth_getStorageAt') return `0x${'00'.repeat(12)}bac849bb641841b44e965fb01a4bf5f074f84b4d`;
    if (method === 'eth_call') {
      const { to, data } = params[0] as { to: string; data: string };
      if (to === EP) return `0x${'4a'.repeat(32)}`; // getUserOpHash
      if (data === '0xf1f7f0f9') return `0x01${V002.slice(2)}${'00'.repeat(11)}`; // rootValidator()
    }
    throw new Error(`unexpected ${method}`);
  } };
  const failed = concatHex(['0x220266b6', encodeAbiParameters([{ type: 'uint256' }, { type: 'string' }], [0n, 'AA23 reverted'])]);
  const simulator = { simulate: async (q: SimulationRequest) => { tried.push(q); return { status: 'reverted' as const, returnData: failed, transfers: [] }; } };
  const signatureOf = (q: SimulationRequest) => (decodeFunctionData({ abi: HANDLE, data: q.data as Hex }).args[0] as { signature: Hex }).signature;
  const webAuthn = (sig: Hex) => decodeAbiParameters([{ type: 'bytes' }, { type: 'string' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bool' }], sig);
  const op = { chainId: 42161, entryPoint: EP, nonce: 0n, callData: '0x' as Hex, callGasLimit: 100_000n, verificationGasLimit: 500_000n, preVerificationGas: 50_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 0n, paymasterAndData: '0x' as Hex };
  // Deployed by the factory's createAccount, its root ZeroDev's WebAuthn validator.
  const data = encodeFunctionData({ abi: ABI, functionName: 'initialize', args: [`0x01${WEBAUTHN.slice(2)}`, `0x${'00'.repeat(20)}`, `0x${'ab'.repeat(96)}`, '0x', []] });
  await simulateOperation({ ...op, sender: SENDER, initCode: concatHex([FACTORY, encodeFunctionData({ abi: ABI, functionName: 'createAccount', args: [data, `0x${'00'.repeat(32)}`] })]), signer: SENDER }, { rpc: node, simulator } as never);
  assert.equal(JSON.parse(webAuthn(signatureOf(tried[0]))[1]).type, 'webauthn.get');
  // An existing account whose root is ZeroDev's passkey validator 0.0.2.
  tried.length = 0;
  const EXISTING = '0x7cdbc9592aa39df3e659e8d5fc498af3e9060817';
  await simulateOperation({ ...op, sender: EXISTING, initCode: '0x', signer: EXISTING }, { rpc: node, simulator } as never);
  assert.equal(JSON.parse(webAuthn(signatureOf(tried[0]))[1]).type, 'webauthn.get');
  // Another factory's createAccount whose data isn't Kernel's initialize: not taken for Kernel's.
  tried.length = 0;
  await simulateOperation({ ...op, sender: SENDER, initCode: concatHex([FACTORY, encodeFunctionData({ abi: ABI, functionName: 'createAccount', args: ['0x12345678', `0x${'00'.repeat(32)}`] })]), signer: SENDER }, { rpc: node, simulator } as never);
  assert.equal(signatureOf(tried[0]), STUB_SIGNATURE);
});

test('An account with session keys (Sepolia): its owner’s bare signature, a session key’s after a 0x01 type byte with an empty proof, else the proof of that key’s own last signature', async () => {
  // Sepolia, 2026-11-18: its session keys' operations were replayed as signed by its owner, 7-16% low.
  const OP = '(address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature)';
  const HANDLE = parseAbi([`function simulateHandleOp(${OP} op, address target, bytes targetCallData)`]);
  const HANDLE_OPS = parseAbi([`function handleOps(${OP}[] ops, address beneficiary)`]);
  const SENDER = '0x0cc1e0744bdfa58760669727daba167cc47a1fdb', UOE = '0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f';
  const key = privateKeyToAccount('0x5555555555555555555555555555555555555555555555555555555555555555');
  const sessionForm = (sig: Hex, proof: Hex[]) => concatHex(['0x01', encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes32[]' }], [sig, proof])]);
  // The key's earlier operation: its signature over that operation's hash (EIP-191), with a one-leaf proof.
  const leaf = `0x${'68'.repeat(32)}` as Hex, earlierHash = `0x${'4b'.repeat(32)}` as Hex;
  const earlier = sessionForm(await key.signMessage({ message: { raw: earlierHash } }), [leaf]);
  const word = (v: bigint) => v.toString(16).padStart(64, '0');
  const fields = { nonce: 0n, initCode: '0x' as Hex, callData: '0x' as Hex, accountGasLimits: `0x${word(1n)}` as Hex, preVerificationGas: 0n, gasFees: `0x${word(1n)}` as Hex, paymasterAndData: '0x' as Hex };
  const input = encodeFunctionData({ abi: HANDLE_OPS, functionName: 'handleOps', args: [[{ sender: SENDER, ...fields, signature: earlier }], SENDER] });
  const node = { has: () => true, call: async (_c: number, method: string, params: unknown[]) => {
    if (method === 'eth_getBlockByNumber') return { number: '0x100', baseFeePerGas: '0x1' };
    if (method === 'eth_maxPriorityFeePerGas') return '0x0';
    if (method === 'eth_getLogs') {
      const topics = (params[0] as { topics: (string | null)[] }).topics;
      return topics[0] === UOE && topics[2]?.endsWith(SENDER.slice(2)) ? [{ transactionHash: `0x${'aa'.repeat(32)}`, topics: [UOE, earlierHash, topics[2], `0x${'00'.repeat(32)}`] }] : [];
    }
    if (method === 'eth_getTransactionByHash') return { input };
    if (method === 'eth_getCode') return `0x363d3d373d3d363d7f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc545af43d6000803e6038573d6000fd5b3d6000f3`;
    if (method === 'eth_getStorageAt') return `0x${'00'.repeat(12)}7e92fa838fd4c3c7602094f0a9c70ec81f8991c7`;
    if (method === 'eth_call' && (params[0] as { to: string }).to === EP) return `0x${'4a'.repeat(32)}`; // getUserOpHash
    throw new Error(`unexpected ${method}`);
  } };
  // The account takes one signature (validation data 0), and refuses the rest (1: the signature failed).
  let accepted: Hex = '0x';
  const tried: Hex[] = [];
  const signatureOf = (q: SimulationRequest) => (decodeFunctionData({ abi: HANDLE, data: q.data as Hex }).args[0] as { signature: Hex }).signature;
  const simulator = { simulate: async (q: SimulationRequest) => {
    const signature = signatureOf(q);
    tried.push(signature);
    const returnData = encodeAbiParameters([{ type: 'tuple', components: [{ name: 'a', type: 'uint256' }, { name: 'b', type: 'uint256' }, { name: 'c', type: 'uint256' }, { name: 'd', type: 'uint256' }, { name: 'e', type: 'bool' }, { name: 'f', type: 'bytes' }] }],
      [{ a: 0n, b: 1n, c: signature === accepted ? 0n : 1n, d: 0n, e: true, f: '0x' }]);
    const event = { address: EP, topics: [UOE, `0x${'4a'.repeat(32)}`, `0x${'00'.repeat(12)}${SENDER.slice(2)}`, `0x${'00'.repeat(32)}`], data: encodeAbiParameters([{ type: 'uint256' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }], [0n, true, 1n, 1n]) };
    return { status: 'success' as const, returnData, transfers: [], logs: [event] };
  } };
  const op = { chainId: 11155111, entryPoint: EP, sender: SENDER, ...fields, callGasLimit: 100_000n, verificationGasLimit: 500_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 0n };
  // Its owner: the bare stand-in.
  accepted = STUB_SIGNATURE;
  let run = await simulateOperation({ ...op, signer: '0x478702d5736489c0b9eb608a750fa9683166b266' }, { rpc: node, simulator } as never);
  assert.equal(run?.account?.signatureFailed, false);
  assert.deepEqual([...new Set(tried)], [STUB_SIGNATURE]);
  // A session key whose root is the call's leaf: refused bare, then taken with an empty proof.
  tried.length = 0;
  accepted = sessionForm(STUB_SIGNATURE, []);
  run = await simulateOperation({ ...op, signer: key.address }, { rpc: node, simulator } as never);
  assert.equal(run?.account?.signatureFailed, false);
  assert.ok(!run?.lastForm);
  // One whose root has other leaves: refused both ways, then in the form of its own last signature, its proof kept.
  tried.length = 0;
  accepted = sessionForm(STUB_SIGNATURE, [leaf]);
  run = await simulateOperation({ ...op, signer: key.address }, { rpc: node, simulator } as never);
  assert.equal(run?.account?.signatureFailed, false);
  assert.equal(run?.lastForm, true);
  assert.equal(tried.at(-1), accepted);
  // A key with no earlier operation on the account: refused, and its run says so.
  tried.length = 0;
  run = await simulateOperation({ ...op, signer: '0x1111111111111111111111111111111111111111' }, { rpc: node, simulator } as never);
  assert.equal(run?.account?.signatureFailed, true);
  assert.ok(!tried.includes(accepted));
});
