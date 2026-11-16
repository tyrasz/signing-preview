// Biconomy Nexus 1.2 accounts whose owner signs through their default validator, K1MeeValidator 1.0.3
// (src/erc4337-sim.ts, nexusStub and nexusDeployStub): the stand-in in the layout of a real operation's, the real
// validator checking a real operation's signature (test/fixtures/nexus-k1mee.json, from Base), and whole operations run
// by the fork simulator on test/evm-chain.ts with the real code of Nexus, its factory, its bootstrap and the validator
// at their addresses: accounts deployed through the factory as Biconomy's SDK sets them up, and an EIP-7702 account
// delegating to Nexus. (In a file of its own: the fork simulator keeps the code it reads at an address for the process.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { concatHex, decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData, encodePacked, getContractAddress, hashMessage, keccak256, parseAbi, parseAbiParameters, recoverAddress, toFunctionSelector, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createAddressFromString as at, hexToBytes } from '@ethereumjs/util';
import { previewRequest } from '../src/preview.ts';
import { StaticTokenRegistry, ecrecoverPrice } from '../src/chains.ts';
import { RpcSimulator } from '../src/simulation.ts';
import { JsonRpcClient } from '../src/rpc.ts';
import { ForkSimulator } from '../src/fork-simulator.ts';
import { ENTRY_POINT_SIMULATIONS_V07 } from '../src/entrypoint-simulations.ts';
import { readOperation, userOpHash } from '../src/userop-hash.ts';
import { K1MEE_VALIDATOR, k1meeOwnSimple, simulateOperation, STUB_COSIGNATURE } from '../src/erc4337-sim.ts';
import { meeLeaf } from '../src/supertransaction.ts';
import { proofRoot } from '../src/typed-data/safe.ts';
import type { Dependencies, Preview } from '../src/types.ts';
import { NOW } from './helpers.ts';
import { compiled, testChain } from './evm-chain.ts';

const EP = '0x0000000071727de22e5e9d8baf0edac6f37da032';
const key = privateKeyToAccount('0x7777777777777777777777777777777777777777777777777777777777777777');
const KEY = key.address.toLowerCase();
const BOB = '0xb0b0000000000000000000000000000000000002';
const URL_ = 'http://hyperevm.invalid';
const E = 10n ** 18n;
const fx = JSON.parse(readFileSync(new URL('./fixtures/nexus-k1mee.json', import.meta.url), 'utf8')) as Record<'nexus' | 'factory' | 'bootstrap', { address: string; code: Hex }> & { operation: Record<string, Hex> & { userOpHash: Hex; sender: string; owner: string } };
const validator = (JSON.parse(readFileSync(new URL('./fixtures/k1mee-session.json', import.meta.url), 'utf8')) as { validator: { address: string; code: Hex } }).validator;
const OWN_SIMPLE = parseAbiParameters('bytes32, uint256, uint256, bytes32[], bytes');

const chain = await testChain();
const usdc = await chain.deploy('Token', 'string,uint8', ['USDC', 6]);
await chain.putCode(EP, ENTRY_POINT_SIMULATIONS_V07 as Hex);
// The SenderCreator (the EntryPoint's first creation) calls the factory, as on-chain.
await chain.putCode(getContractAddress({ from: EP as Hex, nonce: 1n }), `0x${compiled('SenderCreatorLike').evm.deployedBytecode.object}`);
await chain.putCode(validator.address, validator.code);
for (const c of [fx.nexus, fx.factory, fx.bootstrap]) await chain.putCode(c.address, c.code);
const deps: Dependencies = {
  tokens: new StaticTokenRegistry({ 999: [{ address: usdc, symbol: 'USDC', decimals: 6, name: 'USD Coin' }] }),
  rpc: new JsonRpcClient({ 999: URL_ }, { fetchImpl: chain.fetchImpl }),
  simulator: new RpcSimulator({ 999: URL_ }, { fetchImpl: chain.fetchImpl, fork: new ForkSimulator({ 999: URL_ }, { fetchImpl: chain.fetchImpl }) }),
};
const A = parseAbi(['function mint(address,uint256)', 'function transfer(address,uint256)', 'function execute(bytes32 mode, bytes executionCalldata)', 'function onInstall(bytes)',
  'function createAccount(bytes initData, bytes32 salt)', 'function computeAccountAddress(bytes initData, bytes32 salt) view returns (address)',
  'function validateUserOp((address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature) userOp, bytes32 userOpHash) returns (uint256)']);
const call = (fn: string, args: unknown[]) => encodeFunctionData({ abi: A, functionName: fn, args } as never);
/** Nexus's execute in single-call mode (mode 0): the target, the value and the call, packed. */
const execute = (to: string, data: Hex) => call('execute', [`0x${'00'.repeat(32)}`, encodePacked(['address', 'uint256', 'bytes'], [to as Hex, 0n, data])]);
const sendUsdc = execute(usdc, call('transfer', [BOB, 50_000_000n]));
/** NexusBootstrap's set-up as Biconomy's SDK sends it: the default validator's install data (its owner), no other modules. */
const SETUP = toFunctionSelector('initNexusWithDefaultValidatorAndOtherModulesNoRegistry(bytes,(address,bytes)[],(address,bytes)[],(address,bytes),(address,bytes)[],(uint256,address,bytes)[])');
const initData = (owner: string) => encodeAbiParameters([{ type: 'address' }, { type: 'bytes' }], [fx.bootstrap.address as Hex,
  concatHex([SETUP, encodeAbiParameters(parseAbiParameters('bytes, (address,bytes)[], (address,bytes)[], (address,bytes), (address,bytes)[], (uint256,address,bytes)[]'), [owner as Hex, [], [], [`0x${'00'.repeat(20)}`, '0x'], [], []])])]);
const salt = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
const rpc = deps.rpc!;
const addressOf = async (owner: string, n: number) => `0x${String(await rpc.call(999, 'eth_call', [{ to: fx.factory.address, data: call('computeAccountAddress', [initData(owner), salt(n)]) }, 'latest'])).slice(26)}`;
/** A nonce as MEE sends a Nexus account's: three bytes of its own, mode 0x00, the default validator (0), the sequence. */
const NONCE = `0x5c1c2400${'00'.repeat(20)}${'00'.repeat(8)}`;
const operation = (m: Record<string, unknown>) => ({ nonce: NONCE, callData: sendUsdc, callGasLimit: '0x30d40', verificationGasLimit: '0x7a120', preVerificationGas: '0xc350', maxFeePerGas: '0x77359400', maxPriorityFeePerGas: '0x3b9aca00', ...m });
/** A Nexus account its factory deploys, set up with `owner`, holding 100 USDC and 1 ETH; deployed now unless `later`. */
async function nexusOf(owner: string, n: number, later = false) {
  const account = await addressOf(owner, n);
  if (!later) await chain.exec(fx.factory.address, call('createAccount', [initData(owner), salt(n)]));
  await chain.exec(usdc, call('mint', [account, 100_000_000n]));
  await chain.setBalance(account, E);
  const deploy = later ? { factory: fx.factory.address, factoryData: call('createAccount', [initData(owner), salt(n)]) } : {};
  return { account, op: operation({ sender: account, ...deploy }) };
}
const hashOf = (op: Record<string, unknown>) => userOpHash(readOperation(op, '0.7')!, EP, 999, '0.7');
const preview = (op: Record<string, unknown>, signer: string): Promise<Preview> =>
  previewRequest({ method: 'personal_sign', params: [hashOf(op), signer] }, { now: NOW, chainId: 999, userOperation: { entryPoint: EP, operation: op } }, deps);
type Supplied = { operation: Record<string, unknown>; proof?: Hex[]; lowerBoundTimestamp?: number; upperBoundTimestamp?: number };
const signRoot = (root: Hex, signer: string, ops: Supplied[]): Promise<Preview> =>
  previewRequest({ method: 'personal_sign', params: [root, signer] }, { now: NOW, chainId: 999, meeOperations: ops.map(o => ({ chainId: 999, entryPoint: EP, ...o })) }, deps);
const usdcChange = (p: Preview) => p.assetChanges.filter(c => c.symbol === 'USDC').map(c => `${c.direction} ${c.amount}`);
const wholeNote = (p: Preview, i?: number) => p.decoding.notes.find(n => (i === undefined ? /^The whole operation was simulated/ : new RegExp(`^Operation ${i} \\(HyperEVM\\): The whole operation was simulated`)).test(n)) ?? p.decoding.notes.join(' | ');
const gasUsed = (p: Preview, i?: number) => BigInt(String(p.details.find(d => d.label === `${i === undefined ? '' : `Operation ${i} (HyperEVM): `}Gas used (simulated)`)?.raw));
const codes = (p: Preview) => p.warnings.map(w => w.code);
/** OpenZeppelin's MerkleProof: each pair hashed in order. */
const pair = (a: Hex, b: Hex) => keccak256(BigInt(a) < BigInt(b) ? concatHex([a, b]) : concatHex([b, a]));
/** What each real ecrecover call the replaced one forwards costs over the stand-in's: HyperEVM's price (15,000), which this test's EVM charges 3,000 for. */
const priced = (calls: number) => BigInt(calls * (ecrecoverPrice(999) - 3000));
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
/** Time bounds as MEE gives an operation: from before NOW to after it. */
const BOUNDS = { lowerBoundTimestamp: 1_790_000_000, upperBoundTimestamp: 1_800_000_000 };
const timed = (op: Record<string, unknown>, b = BOUNDS) => meeLeaf(hashOf(op), { lowerBoundTimestamp: BigInt(b.lowerBoundTimestamp), upperBoundTimestamp: BigInt(b.upperBoundTimestamp) });

test('The stand-in for a Nexus owner’s operation in simple mode: the layout of a real one’s (Base), word by word, but the owner’s 65 bytes; the real validator takes the real one, its leaf MEE’s hash of the operation’s hash and its time bounds', async () => {
  const o = fx.operation, real = o.signature;
  // The operation's hash as the EntryPoint computes it (its UserOperationEvent's).
  const gas = (w: Hex) => [BigInt(`0x${w.slice(2, 34)}`), BigInt(`0x${w.slice(34)}`)];
  const [verification, callGas] = gas(o.accountGasLimits), [priority, maxFee] = gas(o.gasFees);
  const rpcForm = { sender: o.sender, nonce: o.nonce, factory: `0x${o.initCode.slice(2, 42)}`, factoryData: `0x${o.initCode.slice(42)}`, callData: o.callData, callGasLimit: callGas, verificationGasLimit: verification, preVerificationGas: o.preVerificationGas, maxFeePerGas: maxFee, maxPriorityFeePerGas: priority,
    paymaster: `0x${o.paymasterAndData.slice(2, 42)}`, paymasterVerificationGasLimit: BigInt(`0x${o.paymasterAndData.slice(42, 74)}`), paymasterPostOpGasLimit: BigInt(`0x${o.paymasterAndData.slice(74, 106)}`), paymasterData: `0x${o.paymasterAndData.slice(106)}` };
  assert.equal(userOpHash(readOperation(rpcForm, '0.7')!, EP, 8453, '0.7'), o.userOpHash);
  // Its nonce: three bytes of MEE's, mode 0x00, the default validator.
  assert.match(o.nonce, /^0x[0-9a-f]{6}00(00){20}/);
  assert.equal(real.slice(0, 10), '0x177eee00');
  const [root, lower, upper, proof, theirs] = decodeAbiParameters(OWN_SIMPLE, `0x${real.slice(10)}`);
  const bounds = { lowerBoundTimestamp: lower, upperBoundTimestamp: upper };
  assert.equal(proofRoot(proof, meeLeaf(o.userOpHash, bounds)), root);
  assert.equal((await recoverAddress({ hash: hashMessage({ raw: root }), signature: theirs })).toLowerCase(), o.owner);
  // The stand-in the simulation sends for it, signed by its owner as a supertransaction's hash (the simulateHandleOp
  // call's operation, as the EntryPoint gets it).
  const sent: Hex[] = [];
  const recording: Dependencies = { ...deps, simulator: { simulate: async q => { sent.push(q.data as Hex); return deps.simulator!.simulate(q); }, simulateBatch: async qs => { sent.push(...qs.map(q => q.data as Hex)); return deps.simulator!.simulateBatch!(qs); } } };
  const ours = readOperation(rpcForm, '0.7')!;
  await simulateOperation({ chainId: 999, entryPoint: EP, sender: o.sender, nonce: ours.nonce, initCode: ours.initCode, callData: ours.callData, callGasLimit: ours.callGasLimit, verificationGasLimit: ours.verificationGasLimit, preVerificationGas: ours.preVerificationGas,
    maxFeePerGas: ours.maxFeePerGas, maxPriorityFeePerGas: ours.maxPriorityFeePerGas, paymasterAndData: ours.paymasterAndData, signer: o.owner, digest: hashMessage({ raw: root }), supertransaction: { root, proof, bounds } }, recording);
  const HANDLE = parseAbi(['function simulateHandleOp((address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature) op, address target, bytes targetCallData)']);
  const handled = sent.filter(d => d?.startsWith(toFunctionSelector(HANDLE[0])));
  assert.ok(handled.length > 0);
  const stand = decodeFunctionData({ abi: HANDLE, data: handled[0] }).args[0].signature;
  assert.equal(stand, k1meeOwnSimple(STUB_COSIGNATURE, { root, proof, bounds }));
  assert.equal(stand.length, real.length);
  const sigAt = 2 + 8 + 64 * 8; // the type, the root, the bounds, two offsets, the proof's length and element, the signature's length
  assert.equal(stand.slice(0, sigAt), real.slice(0, sigAt));
  assert.equal(`0x${stand.slice(sigAt, sigAt + 130)}`, STUB_COSIGNATURE);
  assert.equal(stand.slice(sigAt + 130), real.slice(sigAt + 130));

  // The real validator (validateUserOp, as Nexus calls its default validator) with the owner its set-up installed:
  // the signature takes, and the validation data is the bounds (validAfter, validUntil), the signature not failed.
  await chain.exec(K1MEE_VALIDATOR, call('onInstall', [o.owner]), o.sender);
  const validate = async (signature: Hex, hash: Hex) => {
    const packed = { sender: o.sender as Hex, nonce: BigInt(o.nonce), initCode: o.initCode, callData: o.callData, accountGasLimits: o.accountGasLimits, preVerificationGas: BigInt(o.preVerificationGas), gasFees: o.gasFees, paymasterAndData: o.paymasterAndData, signature };
    const r = await chain.evm.runCall({ caller: at(o.sender), to: at(K1MEE_VALIDATOR), data: hexToBytes(call('validateUserOp', [packed, hash])), gasLimit: 1_000_000n });
    assert.equal(r.execResult.exceptionError, undefined);
    return BigInt(`0x${Buffer.from(r.execResult.returnValue).toString('hex')}`);
  };
  assert.equal(await validate(real, o.userOpHash), (lower << 208n) | (upper << 160n));
  // Another operation's hash: its leaf isn't the root's, refused (1).
  assert.equal(await validate(real, keccak256(o.userOpHash)), 1n);
  // The same signature with other time bounds: another leaf, refused.
  assert.equal(await validate(k1meeOwnSimple(theirs, { root, proof, bounds: { lowerBoundTimestamp: lower, upperBoundTimestamp: upper + 1n } }), o.userOpHash), 1n);
});

test('A Nexus account’s owner signs a supertransaction’s hash: each operation runs whole in its own validator’s simple mode, with its root, proof and time bounds, for a real signature’s gas; anyone else, refused, the owner named', async () => {
  const one = await nexusOf(KEY, 1), two = await nexusOf(KEY, 2);
  const root = pair(timed(one.op), timed(two.op));
  const ops = [{ operation: one.op, ...BOUNDS }, { operation: two.op, ...BOUNDS }];
  const p = await signRoot(root, KEY, ops);
  assert.ok(codes(p).includes('mee_supertransaction_verified'), codes(p).join());
  for (const i of [1, 2]) {
    assert.match(wholeNote(p, i), /ecrecover attributes it to the signer/);
    assert.doesNotMatch(wholeNote(p, i), /doesn't accept/);
    assert.ok(p.decoding.notes.includes(`Operation ${i} (HyperEVM): The account's owner signs the supertransaction's hash, which the account's own validator (Nexus's default, Biconomy's K1MeeValidator) checks with this operation's proof, its leaf MEE's hash of the operation's hash and its time bounds (simple mode), as Biconomy's MEE node submits it: the stand-in carries the hash, the proof and the bounds, which the validator returns as the operation's validity.`), p.decoding.notes.join(' | '));
  }
  assert.deepEqual(usdcChange(p), ['out 50', 'out 50']);
  assert.ok(codes(p).includes('userop_owner_signature'));
  // The first operation with the real signature in that layout: the owner's over the root as a message, the other
  // operation's leaf its proof. Through the replaced ecrecover twice (the root as it is, then as a message).
  const tree = { root, proof: [timed(two.op)], bounds: { lowerBoundTimestamp: BigInt(BOUNDS.lowerBoundTimestamp), upperBoundTimestamp: BigInt(BOUNDS.upperBoundTimestamp) } };
  const real = gasUsed(await preview({ ...one.op, signature: k1meeOwnSimple(await key.signMessage({ message: { raw: root } }), tree) }, KEY));
  const forwarding = real + priced(2) - gasUsed(p, 1);
  assert.ok(forwarding >= 350n && forwarding <= 420n, `${real} ${gasUsed(p, 1)}`);
  // Asked by someone else: the validator refuses the stand-in, and the note names the owner.
  const b = await signRoot(root, BOB, ops);
  for (const i of [1, 2]) assert.match(wholeNote(b, i), new RegExp(`doesn't accept it as theirs \\(it validates through its default validator, Biconomy's K1MeeValidator, which takes its owner's signature \\(${short(KEY)}\\), and the signer asked isn't its owner\\)`));
  assert.ok(!codes(b).includes('userop_owner_signature'));
});

test('A Nexus account’s operation in a supertransaction supplied without its time bounds (its leaf its hash): refused for its owner too, as the real signature would be, and the preview says why', async () => {
  const one = await nexusOf(KEY, 3), two = await nexusOf(KEY, 4);
  const p = await signRoot(pair(hashOf(one.op), hashOf(two.op)), KEY, [{ operation: one.op }, { operation: two.op }]);
  assert.ok(codes(p).includes('mee_supertransaction_verified'), codes(p).join());
  for (const i of [1, 2]) assert.match(wholeNote(p, i), new RegExp(`doesn't accept it as theirs \\(it validates through its default validator, Biconomy's K1MeeValidator, which takes its owner's signature \\(${short(KEY)}\\) over a supertransaction's hash with the proof of MEE's hash of the operation's hash and its time bounds, and the operation was supplied without them \\(its leaf its hash, as a session key's is\\)\\)`));
});

test('A Nexus owner’s operation in simple mode: its time bounds are the account’s validity (validAfter, validUntil), and an expired one is said once', async () => {
  const one = await nexusOf(KEY, 5);
  const other = `0x${'ab'.repeat(32)}` as Hex, root = pair(timed(one.op), other);
  const bounds = { lowerBoundTimestamp: BigInt(BOUNDS.lowerBoundTimestamp), upperBoundTimestamp: BigInt(BOUNDS.upperBoundTimestamp) };
  const o = readOperation(one.op, '0.7')!;
  const run = await simulateOperation({ chainId: 999, entryPoint: EP, sender: one.account, nonce: o.nonce, initCode: o.initCode, callData: o.callData, callGasLimit: o.callGasLimit, verificationGasLimit: o.verificationGasLimit,
    preVerificationGas: o.preVerificationGas, maxFeePerGas: o.maxFeePerGas, maxPriorityFeePerGas: o.maxPriorityFeePerGas, paymasterAndData: o.paymasterAndData, signer: KEY, digest: hashMessage({ raw: root }), supertransaction: { root, proof: [other], bounds } }, deps);
  assert.ok(run && !run.rejected);
  assert.deepEqual(run.account, { signatureFailed: false, aggregator: null, validAfter: BOUNDS.lowerBoundTimestamp, validUntil: BOUNDS.upperBoundTimestamp });
  // Expired before NOW: K1MeeValidator returns its end, which has passed; the supertransaction's own warning says so.
  const ended = { lowerBoundTimestamp: 1_700_000_000, upperBoundTimestamp: 1_700_000_100 };
  const p = await signRoot(pair(timed(one.op, ended), other), KEY, [{ operation: one.op, proof: [other], ...ended }]);
  assert.match(wholeNote(p, 1), /ecrecover attributes it to the signer/);
  assert.doesNotMatch(wholeNote(p, 1), /doesn't accept/);
  assert.ok(codes(p).includes('mee_operation_expired'), codes(p).join());
  assert.ok(!codes(p).includes('userop_expired'), codes(p).join());
});

test('A Nexus account its factory deploys in the operation: the owner its bootstrap installs signs, in simple mode; anyone else is told that owner', async () => {
  const { account, op } = await nexusOf(KEY, 6, true);
  assert.equal(String(await rpc.call(999, 'eth_getCode', [account, 'latest'])), '0x');
  const other = `0x${'cd'.repeat(32)}` as Hex, root = pair(timed(op), other);
  const p = await signRoot(root, KEY, [{ operation: op, proof: [other], ...BOUNDS }]);
  assert.ok(codes(p).includes('mee_supertransaction_partial'), codes(p).join());
  assert.match(wholeNote(p, 1), /The whole operation was simulated as EntryPoint v0\.7 runs it: deploying the account through its factory, validation \(with a stand-in for the signature, which doesn't exist until it's signed: ecrecover attributes it to the signer\)/);
  assert.doesNotMatch(wholeNote(p, 1), /doesn't accept/);
  assert.deepEqual(usdcChange(p), ['out 50']);
  const b = await signRoot(root, BOB, [{ operation: op, proof: [other], ...BOUNDS }]);
  assert.match(wholeNote(b, 1), new RegExp(`doesn't accept it as theirs \\(it validates through its default validator, Biconomy's K1MeeValidator, which takes its owner's signature \\(${short(KEY)}\\), and the signer asked isn't its owner\\)`));
  // Its operation's own hash, signed by that owner: the plain form, validated.
  const plain = await preview(op, KEY);
  assert.match(wholeNote(plain), /deploying the account through its factory, validation \(with a stand-in for the signature, which doesn't exist until it's signed: ecrecover attributes it to the signer\)/);
  assert.doesNotMatch(wholeNote(plain), /doesn't accept/);
});

test('A Nexus owner signs the operation’s own hash: the plain form, for the gas the real signature uses, with a note of what MEE’s simple mode costs more; anyone else is told the owner', async () => {
  const { op } = await nexusOf(KEY, 7);
  const p = await preview(op, KEY);
  assert.match(wholeNote(p), /ecrecover attributes it to the signer/);
  assert.doesNotMatch(wholeNote(p), /doesn't accept/);
  assert.deepEqual(usdcChange(p), ['out 50']);
  assert.ok(p.decoding.notes.some(n => /^The account's owner signs the operation's hash itself, which its validator \(Nexus's default, Biconomy's K1MeeValidator\) takes as it is \(its plain form\)\. Sent through Biconomy's MEE node, .*simple mode\): its validation costs about [\d,]+ gas more than simulated here with one proof element/.test(n)), p.decoding.notes.join(' | '));
  // The real signature: the owner's over the hash as a message, through the replaced ecrecover twice.
  const hash = hashOf(op);
  const plain = gasUsed(await preview({ ...op, signature: await key.signMessage({ message: { raw: hash } }) }, KEY));
  const forwarding = plain + priced(2) - gasUsed(p);
  assert.ok(forwarding >= 350n && forwarding <= 420n, `${plain} ${gasUsed(p)}`);
  // What MEE's simple mode costs over it, the real signatures of both, on Nexus's and the validator's own code: one
  // proof element, and each further one.
  const simple = async (proof: Hex[]) => {
    let root = timed(op);
    for (const h of proof) root = pair(root, h);
    const tree = { root, proof, bounds: { lowerBoundTimestamp: BigInt(BOUNDS.lowerBoundTimestamp), upperBoundTimestamp: BigInt(BOUNDS.upperBoundTimestamp) } };
    const r = await preview({ ...op, signature: k1meeOwnSimple(await key.signMessage({ message: { raw: root } }), tree) }, KEY);
    assert.match(wholeNote(r), /with the wallet's stand-in signature\)/);
    return gasUsed(r);
  };
  const leaves = Array.from({ length: 5 }, (_, i) => keccak256(`0x${(i + 1).toString(16).padStart(2, '0')}`));
  const costs = [await simple(leaves.slice(0, 1)), await simple(leaves.slice(0, 2)), await simple(leaves.slice(0, 5))];
  assert.deepEqual([costs[0] - plain, costs[1] - costs[0], costs[2] - costs[1]], [1624n, 313n, 943n]);
  // Asked by someone else: refused, the owner named.
  assert.match(wholeNote(await preview(op, BOB)), new RegExp(`doesn't accept it as theirs \\(it validates through its default validator, Biconomy's K1MeeValidator, which takes its owner's signature \\(${short(KEY)}\\), and the signer asked isn't its owner\\)`));
});

test('An EIP-7702 account delegating to Nexus, with no owner set: its own key signs, in simple mode as in the plain form; anyone else is told it is the account itself', async () => {
  const eoa = privateKeyToAccount('0x8888888888888888888888888888888888888888888888888888888888888888');
  const account = eoa.address.toLowerCase();
  await chain.putCode(account, `0xef0100${fx.nexus.address.slice(2)}` as Hex);
  await chain.exec(usdc, call('mint', [account, 100_000_000n]));
  await chain.setBalance(account, E);
  const op = operation({ sender: account });
  const other = `0x${'ef'.repeat(32)}` as Hex, root = pair(timed(op), other);
  const p = await signRoot(root, account, [{ operation: op, proof: [other], ...BOUNDS }]);
  assert.match(wholeNote(p, 1), /ecrecover attributes it to the signer/);
  assert.doesNotMatch(wholeNote(p, 1), /doesn't accept/);
  assert.deepEqual(usdcChange(p), ['out 50']);
  const plain = await preview(op, account);
  assert.match(wholeNote(plain), /ecrecover attributes it to the signer/);
  assert.doesNotMatch(wholeNote(plain), /doesn't accept/);
  const b = await signRoot(root, BOB, [{ operation: op, proof: [other], ...BOUNDS }]);
  assert.match(wholeNote(b, 1), /doesn't accept it as theirs \(it validates through its default validator, Biconomy's K1MeeValidator, which takes its owner's signature \(the account itself, as none is set for it\), and the signer asked isn't its owner\)/);
});

/** Another validator module (it answers 1 to every call: a validator, installed), which a set-up can install in place of the default validator's owner. */
const OTHER_VALIDATOR = '0x0000000000000000000000000000000000a11a11';
await chain.putCode(OTHER_VALIDATOR, '0x600160005260206000f3');
/** NexusBootstrap's single-validator set-up (no registry): another validator, and no owner for the default validator. */
const SINGLE = toFunctionSelector('initNexusWithSingleValidatorNoRegistry(address,bytes)');
const initSingle = encodeAbiParameters([{ type: 'address' }, { type: 'bytes' }], [fx.bootstrap.address as Hex, concatHex([SINGLE, encodeAbiParameters(parseAbiParameters('address, bytes'), [OTHER_VALIDATOR, '0x'])])]);
const GET_OWNER = parseAbi(['function getOwner(address) view returns (address)']);
const ownerOf = async (account: string) => `0x${String(await rpc.call(999, 'eth_call', [{ to: K1MEE_VALIDATOR, data: encodeFunctionData({ abi: GET_OWNER, functionName: 'getOwner', args: [account as Hex] }) }, 'latest'])).slice(26)}`;
/** A request without an address: the signer is then the account itself. */
const unnamed = (method: 'root' | 'hash', op: Record<string, unknown>, ops?: Supplied[], root?: Hex): Promise<Preview> => method === 'root'
  ? previewRequest({ method: 'personal_sign', params: [root!] }, { now: NOW, chainId: 999, meeOperations: ops!.map(o => ({ chainId: 999, entryPoint: EP, ...o })) }, deps)
  : previewRequest({ method: 'personal_sign', params: [hashOf(op)] }, { now: NOW, chainId: 999, userOperation: { entryPoint: EP, operation: op } }, deps);
const NONE_SET = "doesn't accept it as theirs \\(it validates through its default validator, Biconomy's K1MeeValidator, which takes its owner's signature, and keeps no owner for it: it then takes the account's own address as its owner, for which no key signs, the account being a contract, so no signature validates through it";

test('A Nexus account (a contract) whose default validator keeps no owner, set up through NexusBootstrap with another validator, deployed or deployed in the operation: no signature validates through that validator, so the stand-in is refused for the account itself, named or not, and for anyone, and the preview says why', async () => {
  // Deployed through the factory with the single-validator set-up: K1MeeValidator answers the account itself as its owner.
  const account = `0x${String(await rpc.call(999, 'eth_call', [{ to: fx.factory.address, data: call('computeAccountAddress', [initSingle, salt(20)]) }, 'latest'])).slice(26)}`;
  await chain.exec(fx.factory.address, call('createAccount', [initSingle, salt(20)]));
  await chain.exec(usdc, call('mint', [account, 100_000_000n]));
  await chain.setBalance(account, E);
  assert.equal(await ownerOf(account), account);
  assert.doesNotMatch(String(await rpc.call(999, 'eth_getCode', [account, 'latest'])), /^0xef0100/);
  const op = operation({ sender: account });
  const other = `0x${'ab'.repeat(32)}` as Hex, root = pair(timed(op), other);
  const ops = [{ operation: op, proof: [other], ...BOUNDS }];
  const ownerNote = (p: Preview) => p.decoding.notes.some(n => /The account's owner signs/.test(n));
  // Its root signed with no address given, or by the account itself: refused, no owner note.
  for (const p of [await unnamed('root', op, ops, root), await signRoot(root, account, ops)]) {
    assert.match(wholeNote(p, 1), new RegExp(`${NONE_SET} \\(here ecrecover recovered the stand-in as no one, as it would any signature\\)\\), so its own signature check isn't simulated`));
    assert.ok(!ownerNote(p), p.decoding.notes.join(' | '));
  }
  // By anyone else: refused, the owner not given as the account (which can't sign).
  const k = await signRoot(root, KEY, ops);
  assert.match(wholeNote(k, 1), new RegExp(`${NONE_SET}\\), so its own signature check isn't simulated`));
  assert.doesNotMatch(wholeNote(k, 1), /the account itself, as none is set/);
  // KEY's real signature in simple mode, as the wallet supplies it: the real validator refuses it too.
  const tree = { root, proof: [other], bounds: { lowerBoundTimestamp: BigInt(BOUNDS.lowerBoundTimestamp), upperBoundTimestamp: BigInt(BOUNDS.upperBoundTimestamp) } };
  assert.match(wholeNote(await preview({ ...op, signature: k1meeOwnSimple(await key.signMessage({ message: { raw: root } }), tree) }, KEY)), /with the wallet's stand-in signature, which the account doesn't accept as signed/);
  // The operation's own hash, signed with no address given: refused, no owner note.
  const plain = await unnamed('hash', op);
  assert.match(wholeNote(plain), new RegExp(`ecrecover attributes it to the account, but the account ${NONE_SET}`));
  assert.ok(!ownerNote(plain), plain.decoding.notes.join(' | '));
  // Deployed in the operation with the same set-up: refused, from its set-up, before the account exists.
  const account2 = `0x${String(await rpc.call(999, 'eth_call', [{ to: fx.factory.address, data: call('computeAccountAddress', [initSingle, salt(21)]) }, 'latest'])).slice(26)}`;
  await chain.exec(usdc, call('mint', [account2, 100_000_000n]));
  await chain.setBalance(account2, E);
  const op2 = operation({ sender: account2, factory: fx.factory.address, factoryData: call('createAccount', [initSingle, salt(21)]) });
  const root2 = pair(timed(op2), other), ops2 = [{ operation: op2, proof: [other], ...BOUNDS }];
  for (const p of [await unnamed('root', op2, ops2, root2), await signRoot(root2, BOB, ops2)]) {
    assert.match(wholeNote(p, 1), /deploying the account through its factory, validation/);
    assert.match(wholeNote(p, 1), new RegExp(NONE_SET));
    assert.ok(!ownerNote(p), p.decoding.notes.join(' | '));
  }
  assert.deepEqual(usdcChange(await unnamed('root', op2, ops2, root2)), ['out 50']);
});

test('A Nexus account with an owner, asked with no signer named: refused, the reason that the request names no signer (not "the signer asked"); an EIP-7702 account with no owner set, asked so, validates (its own key signs)', async () => {
  const { op } = await nexusOf(KEY, 22);
  const p = await unnamed('hash', op);
  assert.match(wholeNote(p), new RegExp(`ecrecover attributes it to the account, but the account doesn't accept it as theirs \\(it validates through its default validator, Biconomy's K1MeeValidator, which takes its owner's signature \\(${short(KEY)}\\), and the request names no signer: the stand-in was taken as the account's own, and the account isn't its owner\\)`));
  assert.doesNotMatch(wholeNote(p), /the signer asked/);
  const other = `0x${'12'.repeat(32)}` as Hex, root = pair(timed(op), other);
  const r = await unnamed('root', op, [{ operation: op, proof: [other], ...BOUNDS }], root);
  assert.match(wholeNote(r, 1), /and the request names no signer: the stand-in was taken as the account's own, and the account isn't its owner\)/);
  assert.doesNotMatch(wholeNote(r, 1), /the signer asked/);
  // An EIP-7702 account delegating to Nexus, no owner set: its own key signs as it.
  const eoa = privateKeyToAccount('0x9999999999999999999999999999999999999999999999999999999999999999');
  const account = eoa.address.toLowerCase();
  await chain.putCode(account, `0xef0100${fx.nexus.address.slice(2)}` as Hex);
  await chain.exec(usdc, call('mint', [account, 100_000_000n]));
  await chain.setBalance(account, E);
  assert.equal(await ownerOf(account), account);
  const own = operation({ sender: account }), ownRoot = pair(timed(own), other);
  const s = await unnamed('root', own, [{ operation: own, proof: [other], ...BOUNDS }], ownRoot);
  assert.match(wholeNote(s, 1), /ecrecover attributes it to the account\)/);
  assert.doesNotMatch(wholeNote(s, 1), /doesn't accept/);
  assert.ok(s.decoding.notes.some(n => /^Operation 1 \(HyperEVM\): The account's owner signs the supertransaction's hash/.test(n)));
  assert.deepEqual(usdcChange(s), ['out 50']);
});
