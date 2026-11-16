// Session keys' operations through Rhinestone's SmartSession whose session's validator is Biconomy's K1MeeValidator
// (src/erc4337-sim.ts, k1meeSessionPart and smartSessionStub), and Biconomy MEE supertransactions' hashes
// (src/supertransaction.ts): the stand-in in the layout of a real one, the real validator's code
// (test/fixtures/k1mee-session.json) checking a real operation's signature, and whole operations run by the fork
// simulator on test/evm-chain.ts with that code at its address (in a file of its own: the fork simulator keeps the
// code it reads at an address for the process, and these tests put a mock at SmartSession's address).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { concatHex, decodeAbiParameters, encodeAbiParameters, encodeFunctionData, hashMessage, keccak256, parseAbi, parseAbiParameters, recoverAddress, toFunctionSelector, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createAddressFromString as at, hexToBytes } from '@ethereumjs/util';
import { previewRequest } from '../src/preview.ts';
import { StaticTokenRegistry, ecrecoverPrice } from '../src/chains.ts';
import { RpcSimulator } from '../src/simulation.ts';
import { JsonRpcClient } from '../src/rpc.ts';
import { ForkSimulator } from '../src/fork-simulator.ts';
import { ENTRY_POINT_SIMULATIONS_V07 } from '../src/entrypoint-simulations.ts';
import { readOperation, userOpHash } from '../src/userop-hash.ts';
import { K1MEE_VALIDATOR, k1meeSessionPart, STUB_COSIGNATURE } from '../src/erc4337-sim.ts';
import { meeLeaf } from '../src/supertransaction.ts';
import { merkleTrees, proofRoot } from '../src/typed-data/safe.ts';
import type { Dependencies, Preview } from '../src/types.ts';
import { NOW } from './helpers.ts';
import { compiled, testChain } from './evm-chain.ts';

const EP = '0x0000000071727de22e5e9d8baf0edac6f37da032';
const SS = '0x00000000008bdaba73cd9815d79069c247eb4bda';
const key = privateKeyToAccount('0x7777777777777777777777777777777777777777777777777777777777777777');
const KEY = key.address.toLowerCase();
const BOB = '0xb0b0000000000000000000000000000000000002';
const URL_ = 'http://hyperevm.invalid';
const E = 10n ** 18n;
const fx = JSON.parse(readFileSync(new URL('./fixtures/k1mee-session.json', import.meta.url), 'utf8')) as { validator: { address: string; code: Hex }; operation: Record<string, Hex> & { userOpHash: Hex; sender: string } };
const SESSION_SIG = parseAbiParameters('bytes32, bytes32[], bytes');

const chain = await testChain();
const usdc = await chain.deploy('Token', 'string,uint8', ['USDC', 6]);
await chain.putCode(EP, ENTRY_POINT_SIMULATIONS_V07 as Hex);
await chain.putCode(fx.validator.address, fx.validator.code);
await chain.putCode(SS, `0x${compiled('SmartSessionLike').evm.deployedBytecode.object}`);
const A = parseAbi(['function mint(address,uint256)', 'function transfer(address,uint256)', 'function execute(address,uint256,bytes)', 'function enableSessionWith(address,bytes32,address,bytes)']);
const call = (fn: string, args: unknown[]) => encodeFunctionData({ abi: A, functionName: fn, args } as never);
// The session reads SmartSession answers (getSessionValidatorAndConfig), and Multicall3's batches of them, counted.
const READ_SESSION = toFunctionSelector('function getSessionValidatorAndConfig(address,bytes32)');
const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11', AGGREGATE3 = '0x82ad56cb';
let sessionReads = 0, batches = 0;
const counting: typeof fetch = async (url, init) => {
  const body = JSON.parse(String(init?.body ?? '{}')) as { method?: string; params?: [{ to?: string; data?: string }] } | { method?: string; params?: [{ to?: string; data?: string }] }[];
  for (const r of [body].flat()) if (r.method === 'eth_call') {
    if (r.params?.[0]?.data?.startsWith(READ_SESSION)) sessionReads++;
    if (r.params?.[0]?.to?.toLowerCase() === MULTICALL3 && r.params[0].data?.startsWith(AGGREGATE3)) batches++;
  }
  return chain.fetchImpl(url, init);
};
const deps: Dependencies = {
  tokens: new StaticTokenRegistry({ 999: [{ address: usdc, symbol: 'USDC', decimals: 6, name: 'USD Coin' }] }),
  rpc: new JsonRpcClient({ 999: URL_ }, { fetchImpl: counting }),
  simulator: new RpcSimulator({ 999: URL_ }, { fetchImpl: chain.fetchImpl, fork: new ForkSimulator({ 999: URL_ }, { fetchImpl: chain.fetchImpl }) }),
};
const sendUsdc = call('execute', [usdc, 0n, call('transfer', [BOB, 50_000_000n])]);
const operation = (m: Record<string, unknown>) => ({ nonce: '0x0', callData: sendUsdc, callGasLimit: '0x30d40', verificationGasLimit: '0x30d40', preVerificationGas: '0xc350', maxFeePerGas: '0x77359400', maxPriorityFeePerGas: '0x3b9aca00', ...m });
const hashOf = (op: Record<string, unknown>) => userOpHash(readOperation(op, '0.7')!, EP, 999, '0.7');
const preview = (op: Record<string, unknown>, signer: string, method = 'personal_sign'): Promise<Preview> =>
  previewRequest({ method, params: method === 'eth_sign' ? [signer, hashOf(op)] : [hashOf(op), signer] }, { now: NOW, chainId: 999, userOperation: { entryPoint: EP, operation: op } }, deps);
type Supplied = { operation: Record<string, unknown>; proof?: Hex[]; lowerBoundTimestamp?: number; upperBoundTimestamp?: number };
/** A supertransaction's hash signed (personal_sign, or eth_sign), its operations supplied as the wallet holds them. */
const signRoot = (root: Hex, signer: string, ops: Supplied[], method = 'personal_sign'): Promise<Preview> =>
  previewRequest({ method, params: method === 'eth_sign' ? [signer, root] : [root, signer] }, { now: NOW, chainId: 999, meeOperations: ops.map(o => ({ chainId: 999, entryPoint: EP, ...o })) }, deps);
const usdcChange = (p: Preview) => p.assetChanges.filter(c => c.symbol === 'USDC').map(c => `${c.direction} ${c.amount}`);
const wholeNote = (p: Preview, i?: number) => p.decoding.notes.find(n => (i === undefined ? /^The whole operation was simulated/ : new RegExp(`^Operation ${i} \\(HyperEVM\\): The whole operation was simulated`)).test(n)) ?? p.decoding.notes.join(' | ');
const gasUsed = (p: Preview, i?: number) => BigInt(String(p.details.find(d => d.label === `${i === undefined ? '' : `Operation ${i} (HyperEVM): `}Gas used (simulated)`)?.raw));
const codes = (p: Preview) => p.warnings.map(w => w.code);
/** A Nexus account (its nonce: 3 bytes of its own, as MEE sends them, its mode byte, the validator, the sequence) with K1MeeValidator sessions, one key each. */
async function nexusWith(keys: string[], id: number) {
  const nexus = await chain.deploy('NexusLike', 'address', [EP]);
  for (const [i, k] of keys.entries()) await chain.exec(nexus, call('enableSessionWith', [SS, `0x${(id + i).toString(16).padStart(64, '0')}`, K1MEE_VALIDATOR, k]));
  await chain.exec(usdc, call('mint', [nexus, 100_000_000n]));
  await chain.setBalance(nexus, E);
  return { nexus, op: operation({ sender: nexus, nonce: `0x5694340000000000${SS.slice(12)}${'00'.repeat(8)}` }) };
}
const permission = (id: number) => `0x${id.toString(16).padStart(64, '0')}` as Hex;
/** OpenZeppelin's MerkleProof: each pair hashed in order. */
const pair = (a: Hex, b: Hex) => keccak256(BigInt(a) < BigInt(b) ? concatHex([a, b]) : concatHex([b, a]));
/** What each real ecrecover call the replaced one forwards costs over the stand-in's: HyperEVM's price (15,000), which this test's EVM charges 3,000 for. */
const priced = (calls: number) => BigInt(calls * (ecrecoverPrice(999) - 3000));

test('A K1MeeValidator session’s stand-in: in simple mode, the layout of a real operation’s, word by word; the plain form, the signature alone', async () => {
  const real = fx.operation.signature, hash = fx.operation.userOpHash;
  assert.equal(fx.operation.sessionValidator, K1MEE_VALIDATOR);
  const [theirRoot, theirProof, theirSig] = decodeAbiParameters(SESSION_SIG, `0x${real.slice(76)}`);
  const stand = k1meeSessionPart(STUB_COSIGNATURE, { root: theirRoot, proof: theirProof });
  // SmartSession's use mode and the permission ID, then the validator's part: the real one's, all but the 65 bytes of
  // the key's signature.
  assert.equal(real.slice(0, 4), '0x00');
  assert.equal(stand.length, real.length - 66);
  assert.equal(stand.slice(0, 10), '0x177eee00');
  const at = 2 + 8 + 64 * 6; // the type, then the root, two offsets, the proof's length and element, the signature's length
  assert.equal(stand.slice(0, at), `0x${real.slice(68, 68 + at - 2)}`);
  assert.equal(`0x${stand.slice(at, at + 130)}`, STUB_COSIGNATURE);
  assert.equal(stand.slice(at + 130), real.slice(68 + at - 2 + 130));
  // The real one: the operation's hash a leaf of the root, which the session's key signed as a message.
  assert.equal(proofRoot(theirProof, hash), theirRoot);
  assert.equal((await recoverAddress({ hash: hashMessage({ raw: theirRoot }), signature: theirSig })).toLowerCase(), `0x${fx.operation.sessionValidatorData.slice(2, 42)}`);
  // The plain form: the key's signature over the operation's hash, nothing around it.
  assert.equal(k1meeSessionPart(STUB_COSIGNATURE), STUB_COSIGNATURE);
});

test('The real K1MeeValidator checks a real session operation’s signature as SmartSession calls it: by the session’s key, over its hash', async () => {
  const VALIDATE = parseAbi(['function validateSignatureWithData(bytes32 hash, bytes sig, bytes data) view returns (bool)']);
  const validate = async (hash: Hex, data: Hex) => {
    const r = await chain.evm.runCall({ caller: at(SS), to: at(K1MEE_VALIDATOR), data: hexToBytes(encodeFunctionData({ abi: VALIDATE, functionName: 'validateSignatureWithData', args: [hash, `0x${fx.operation.signature.slice(68)}`, data] })), gasLimit: 1_000_000n });
    assert.equal(r.execResult.exceptionError, undefined);
    return BigInt(`0x${Buffer.from(r.execResult.returnValue).toString('hex')}`) === 1n;
  };
  assert.equal(await validate(fx.operation.userOpHash, fx.operation.sessionValidatorData), true);
  // Over another hash, or for another key: refused, not reverted.
  assert.equal(await validate(keccak256(fx.operation.userOpHash), fx.operation.sessionValidatorData), false);
  assert.equal(await validate(fx.operation.userOpHash, BOB), false);
});

test('The operation’s hash signed by a K1MeeValidator session’s key: the plain form, for the gas the real signature uses, and a note of what MEE’s simple mode costs more', async () => {
  const { op } = await nexusWith([KEY], 0x41);
  const ID = permission(0x41);
  const p = await preview(op, KEY);
  assert.match(wholeNote(p), /ecrecover attributes it to the signer/);
  assert.doesNotMatch(wholeNote(p), /doesn't accept/);
  assert.deepEqual(usdcChange(p), ['out 50']);
  const standIn = gasUsed(p);
  // The real signature in the plain form: the key's over the operation's hash as a message. The validator recovers it
  // over the bare hash first (someone else), then over its message form, each time through the replaced ecrecover to
  // the real precompile, about 190 gas more each than calling it; the stand-in's each cost exactly the chain's price.
  const hash = hashOf(op);
  const plain = gasUsed(await preview({ ...op, signature: concatHex(['0x00', ID, await key.signMessage({ message: { raw: hash } })]) }, KEY));
  const forwarding = plain + priced(2) - standIn;
  assert.ok(forwarding >= 350n && forwarding <= 420n, `${plain} ${standIn}`);
  // The same operation in the layout Biconomy's MEE node sends (simple mode: a supertransaction of its hash and
  // another leaf, the key's signature over the root as a message): 2,117 gas more in these mock accounts, which copy
  // the signature more than real ones (on chain about 1,300, as the note says: README).
  const other = `0x${'ab'.repeat(32)}` as Hex, root = pair(hash, other);
  const simple = gasUsed(await preview({ ...op, signature: concatHex(['0x00', ID, k1meeSessionPart(await key.signMessage({ message: { raw: root } }), { root, proof: [other] })]) }, KEY));
  assert.equal(simple - plain, 2117n);
  assert.ok(p.decoding.notes.some(n => /^The session's key signs the operation's hash itself, which Biconomy's K1MeeValidator takes as it is \(its plain form\)\..*its validation costs about 1,300 gas more than simulated here/.test(n)), p.decoding.notes.join(' | '));
  // eth_sign of the hash: the validator's first form, one ecrecover (the real signature over the bare hash, the same).
  const e = await preview(op, KEY, 'eth_sign');
  assert.doesNotMatch(wholeNote(e), /doesn't accept/);
  const bare = gasUsed(await preview({ ...op, signature: concatHex(['0x00', ID, await key.sign({ hash })]) }, KEY, 'eth_sign'));
  const once = bare + priced(1) - gasUsed(e);
  assert.ok(once >= 150n && once <= 220n, `${bare} ${gasUsed(e)}`);
  // The key's signature over another hash: refused.
  assert.match(wholeNote(await preview({ ...op, signature: concatHex(['0x00', ID, await key.signMessage({ message: { raw: keccak256(hash) } })]) }, KEY)), /doesn't accept/);

  // Asked by someone else: the session's check runs on the stand-in, refuses it, and the note names the key.
  const b = await preview(op, BOB);
  assert.match(wholeNote(b), new RegExp(`doesn't accept it as theirs \\(it validates through Rhinestone's SmartSession \\(0x0000…4bda\\), as a session key's operation signed by its session's key \\(${KEY.slice(0, 6)}…${KEY.slice(-4)}, through Biconomy's K1MeeValidator, which takes the key's signature over the operation's hash, or over a supertransaction's hash with the operation's proof\\), not by the account's owners, and the signer asked isn't it\\)`));
  assert.ok(!b.decoding.notes.some(n => /plain form/.test(n)));
  assert.deepEqual(usdcChange(b), ['out 50']);
});

test('An account with several K1MeeValidator sessions, a key each: the signer’s own session, wherever it is; anyone else, the note names the newest keys', async () => {
  const others = ['0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222', '0x3333333333333333333333333333333333333333'];
  const { op } = await nexusWith([others[0], KEY, others[1], others[2]], 0x51);
  const p = await preview(op, KEY);
  assert.match(wholeNote(p), /ecrecover attributes it to the signer/);
  assert.doesNotMatch(wholeNote(p), /doesn't accept/);
  assert.deepEqual(usdcChange(p), ['out 50']);
  const b = await preview(op, BOB);
  assert.match(wholeNote(b), /signed by one of its sessions' keys \(4 sessions, each a key of its own through Biconomy's K1MeeValidator, the newest 0x3333…3333, 0x2222…2222, 0x[0-9a-f]{4}…[0-9a-f]{4} and 1 more, which takes the key's signature over the operation's hash, or over a supertransaction's hash with the operation's proof\), not by the account's owners, and the signer asked isn't one of them\)/);
});

test('An account with more K1MeeValidator sessions than are read at once (40): an old session’s key signs; the sessions are read newest first until it turns up; anyone else, all of them are counted', async () => {
  const keys = Array.from({ length: 40 }, (_, i) => `0x${(0xa0 + i).toString(16).repeat(20)}`);
  keys[2] = KEY; // the 3rd oldest, 38th newest: not among the newest 32
  const { op } = await nexusWith(keys, 0x100);
  sessionReads = 0;
  const p = await preview(op, KEY);
  assert.match(wholeNote(p), /ecrecover attributes it to the signer/);
  assert.doesNotMatch(wholeNote(p), /doesn't accept/);
  assert.deepEqual(usdcChange(p), ['out 50']);
  assert.equal(sessionReads, 40);
  // The newest session's key: one chunk of 32 read.
  sessionReads = 0;
  assert.doesNotMatch(wholeNote(await preview(op, keys[39])), /doesn't accept/);
  assert.equal(sessionReads, 32);
  // Anyone else: all 40 read, and counted.
  const b = await preview(op, BOB);
  assert.match(wholeNote(b), /signed by one of its sessions' keys \(40 sessions, each a key of its own through Biconomy's K1MeeValidator, the newest 0xc7c7…c7c7, 0xc6c6…c6c6, 0xc5c5…c5c5 and 37 more,/);
  // Where Multicall3 is (every chain the previewer simulates on; not this test's, until now), a chunk is one call.
  await chain.putCode(MULTICALL3, `0x${compiled('Multicall3Like').evm.deployedBytecode.object}`);
  sessionReads = 0; batches = 0;
  assert.doesNotMatch(wholeNote(await preview(op, KEY)), /doesn't accept/);
  assert.deepEqual([sessionReads, batches], [0, 2]);
  sessionReads = 0; batches = 0;
  assert.match(wholeNote(await preview(op, BOB)), /\(40 sessions, each a key of its own .* and 37 more,/);
  assert.deepEqual([sessionReads, batches], [0, 2]);
  await chain.putCode(MULTICALL3, '0x');
});

test('Merkle trees as tree builders lay them out (OpenZeppelin’s SimpleMerkleTree, its leaves sorted, as Biconomy’s SDK builds a supertransaction’s): each leaf’s proof reaches the root', () => {
  const leaves = Array.from({ length: 7 }, (_, i) => keccak256(`0x${(i + 1).toString(16).padStart(2, '0')}`));
  for (let n = 1; n <= leaves.length; n++) {
    const trees = merkleTrees(leaves.slice(0, n));
    assert.equal(trees.length, 6);
    for (const t of trees) for (const [i, proof] of t.proofs.entries()) assert.equal(proofRoot(proof, leaves[i]), t.root, `${n} leaves, leaf ${i}`);
  }
  // Three leaves, sorted, in OpenZeppelin's array: the two smallest paired, then the largest.
  const [s0, s1, s2] = [...leaves.slice(0, 3)].sort((a, z) => (BigInt(a) < BigInt(z) ? -1 : 1));
  assert.ok(merkleTrees(leaves.slice(0, 3)).some(t => t.root === pair(pair(s0, s1), s2)));
  // MEE's hash of an operation's hash and its time bounds (MEEUserOpHashLib.getMEEUserOpHash).
  const h = leaves[0];
  assert.equal(meeLeaf(h, { lowerBoundTimestamp: 1n, upperBoundTimestamp: 2n }), keccak256(keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' }], [h, 1n, 2n]))));
  assert.equal(meeLeaf(h), h);
});

test('A supertransaction’s hash signed by a session’s key, its operations supplied: verified against the root, each operation run whole in simple mode with its real proof, for a real signature’s gas', async () => {
  const one = await nexusWith([KEY], 0x61), two = await nexusWith([KEY], 0x62);
  const a = hashOf(one.op), z = hashOf(two.op), root = pair(a, z);
  const p = await signRoot(root, KEY, [{ operation: one.op }, { operation: two.op }]);
  assert.equal(p.decoding.decoder, 'mee_supertransaction');
  assert.ok(codes(p).includes('mee_supertransaction_verified'), codes(p).join());
  // (The test's token calls itself USDC, which on HyperEVM it isn't: that danger is each operation's own.)
  assert.deepEqual(p.warnings.filter(w => w.severity === 'danger').map(w => w.code), ['token_impersonation', 'token_impersonation']);
  assert.match(p.title, /^Sign a supertransaction: 2 operations on 1 chain$/);
  for (const i of [1, 2]) {
    assert.match(wholeNote(p, i), /ecrecover attributes it to the signer/);
    assert.doesNotMatch(wholeNote(p, i), /doesn't accept/);
  }
  assert.equal(p.details.find(d => d.label === 'Operation 1 (HyperEVM): Proof')?.value, z);
  assert.deepEqual(usdcChange(p), ['out 50', 'out 50']);
  assert.ok(!p.decoding.notes.some(n => /plain form/.test(n)));
  // The first operation with the real signature in that layout: the key's over the root as a message, the other
  // operation's hash its proof. Through the replaced ecrecover twice (the root as it is, then as a message).
  const real = gasUsed(await preview({ ...one.op, signature: concatHex(['0x00', permission(0x61), k1meeSessionPart(await key.signMessage({ message: { raw: root } }), { root, proof: [z] })]) }, KEY));
  const forwarding = real + priced(2) - gasUsed(p, 1);
  assert.ok(forwarding >= 350n && forwarding <= 420n, `${real} ${gasUsed(p, 1)}`);
  // eth_sign of the root: the validator's first form, validated too.
  const e = await signRoot(root, KEY, [{ operation: one.op }, { operation: two.op }], 'eth_sign');
  assert.ok(codes(e).includes('mee_supertransaction_verified') && codes(e).includes('eth_sign_supertransaction'), codes(e).join());
  assert.doesNotMatch(wholeNote(e, 1), /doesn't accept/);
  // Asked by someone else: each operation's session refuses the stand-in, and the note names the key.
  const b = await signRoot(root, BOB, [{ operation: one.op }, { operation: two.op }]);
  assert.match(wholeNote(b, 1), /doesn't accept it as theirs \(.*signed by its session's key \(0x/);
});

test('A supertransaction’s hash the operations supplied don’t make up: a danger, nothing shown; one supplied with its proof: shown, with a danger that the hash covers others', async () => {
  const one = await nexusWith([KEY], 0x71), two = await nexusWith([KEY], 0x72);
  const a = hashOf(one.op), z = hashOf(two.op), root = pair(a, z);
  // One of its two operations, without a proof.
  const half = await signRoot(root, KEY, [{ operation: one.op }]);
  assert.ok(codes(half).includes('mee_supertransaction_mismatch'), codes(half).join());
  assert.equal(half.warnings.find(w => w.code === 'mee_supertransaction_mismatch')!.severity, 'danger');
  assert.equal(half.decoding.decoder, 'personal_sign');
  assert.ok(!half.details.some(d => /simulated/.test(d.label)));
  // An operation on another chain, or another EntryPoint: not its leaves.
  const elsewhere = await previewRequest({ method: 'personal_sign', params: [root, KEY] }, { now: NOW, chainId: 999, meeOperations: [{ chainId: 1, entryPoint: EP, operation: one.op }, { chainId: 999, entryPoint: EP, operation: two.op }] }, deps);
  assert.ok(codes(elsewhere).includes('mee_supertransaction_mismatch'));
  const v08 = await previewRequest({ method: 'personal_sign', params: [root, KEY] }, { now: NOW, chainId: 999, meeOperations: [{ chainId: 999, entryPoint: '0x4337084d9e255ff0702461cf8895ce9e3b5ff108', operation: one.op }] }, deps);
  assert.match(v08.warnings.find(w => w.code === 'mee_supertransaction_mismatch')!.message, /operation 1's EntryPoint \(0x4337…f108\) is not v0\.6 or v0\.7/);
  // The one operation the wallet holds, with its proof (the other's hash): shown and run whole, the root covering more.
  const partial = await signRoot(root, KEY, [{ operation: one.op, proof: [z] }]);
  assert.ok(codes(partial).includes('mee_supertransaction_partial'), codes(partial).join());
  assert.equal(partial.warnings.find(w => w.code === 'mee_supertransaction_partial')!.severity, 'danger');
  assert.match(partial.title, /, and others not shown$/);
  assert.doesNotMatch(wholeNote(partial, 1), /doesn't accept/);
  assert.match(wholeNote(partial, 1), /ecrecover attributes it to the signer/);
  assert.deepEqual(usdcChange(partial), ['out 50']);
  // A proof that doesn't reach the root: a mismatch.
  assert.ok(codes(await signRoot(root, KEY, [{ operation: one.op, proof: [a] }])).includes('mee_supertransaction_mismatch'));
  // A leaf with time bounds (MEE's hash of the operation's hash and them, as an account's own validator checks it):
  // the root rebuilt from it. Through SmartSession, the session's validator checks the proof of the operation's hash
  // itself, which this tree doesn't hold: the stand-in is refused, as the real signature would be.
  const timed = meeLeaf(a, { lowerBoundTimestamp: 100n, upperBoundTimestamp: 200n });
  const t = await signRoot(pair(timed, z), KEY, [{ operation: one.op, lowerBoundTimestamp: 100, upperBoundTimestamp: 200 }, { operation: two.op }]);
  assert.ok(codes(t).includes('mee_supertransaction_verified'), codes(t).join());
  assert.match(wholeNote(t, 1), /doesn't accept it as theirs/);
  assert.doesNotMatch(wholeNote(t, 2), /doesn't accept/);
});

test('A supertransaction’s hash covering operations whose accounts take no signature of it here: refused, not run over any digest (an ECDSA account checking the operation’s hash; an account that isn’t Nexus with its own K1MeeValidator, its leaf with time bounds)', async () => {
  // An account that checks its owner's signature over the operation's hash as a message: the key's signature of the
  // root doesn't validate there, though a stand-in recovered over any digest would.
  const plain = await chain.deploy('Account4337', 'address,address', [KEY, EP]);
  await chain.exec(usdc, call('mint', [plain, 100_000_000n]));
  await chain.setBalance(plain, E);
  const own = operation({ sender: plain });
  const session = await nexusWith([KEY], 0x81);
  const root = pair(hashOf(own), hashOf(session.op));
  for (const method of ['personal_sign', 'eth_sign']) {
    const p = await signRoot(root, KEY, [{ operation: own }, { operation: session.op }], method);
    assert.ok(codes(p).includes('mee_supertransaction_verified'), codes(p).join());
    assert.match(wholeNote(p, 1), /doesn't accept it as theirs \(the signature of a supertransaction's hash is stood in for only as Biconomy's K1MeeValidator takes it, in simple mode: a session's \(SmartSession\), or the owner's for a Biconomy Nexus account whose default validator it is; an account that checks the operation's hash doesn't take it\)/);
    assert.doesNotMatch(wholeNote(p, 2), /doesn't accept/);
  }
  // The same with only the plain account's operation and its proof (the root covering more).
  assert.match(wholeNote(await signRoot(root, KEY, [{ operation: own, proof: [hashOf(session.op)] }]), 1), /doesn't accept it as theirs/);
  // An account whose own validator is K1MeeValidator, its owner the key (installed as the account installs it), but
  // which isn't Nexus's code (a mock naming the validator in its nonce): not one the stand-in is shaped for, refused
  // (Nexus itself: test/nexus-k1mee-owner.test.ts).
  const nexus = await chain.deploy('NexusLike', 'address', [EP]);
  await chain.exec(K1MEE_VALIDATOR, encodeFunctionData({ abi: parseAbi(['function onInstall(bytes)']), functionName: 'onInstall', args: [KEY as Hex] }), nexus);
  await chain.exec(usdc, call('mint', [nexus, 100_000_000n]));
  await chain.setBalance(nexus, E);
  const mine = operation({ sender: nexus, nonce: `0x56943400${K1MEE_VALIDATOR.slice(2)}${'00'.repeat(8)}` });
  const timed = meeLeaf(hashOf(mine), { lowerBoundTimestamp: 100n, upperBoundTimestamp: 2_000_000_000n });
  const t = await signRoot(pair(timed, hashOf(session.op)), KEY, [{ operation: mine, lowerBoundTimestamp: 100, upperBoundTimestamp: 2_000_000_000 }, { operation: session.op }]);
  assert.ok(codes(t).includes('mee_supertransaction_verified'), codes(t).join());
  assert.match(wholeNote(t, 1), /doesn't accept it as theirs \(the signature of a supertransaction's hash is stood in for only as Biconomy's K1MeeValidator takes it, in simple mode: a session's \(SmartSession\), or the owner's for a Biconomy Nexus account whose default validator it is/);
  // (Asked to sign that operation's own hash, its owner validates as before.)
  assert.doesNotMatch(wholeNote(await preview(mine, KEY)), /doesn't accept/);
});

test('Rhinestone SmartSession’s errors (verified on Sourcify; each in its deployed code) read by name: a session operation that fails validation says why', async () => {
  const { decodeRevert } = await import('../src/simulation.ts');
  const { encodeErrorResult, getAddress, parseAbiItem } = await import('viem');
  const ID = `0x${'5e'.repeat(32)}` as Hex, POLICY = '0x0000000000000000000000000000000000000b01';
  const sample: Record<string, unknown> = { bytes32: ID, address: POLICY, uint256: 7n, uint64: 999n, uint8: 2, bytes1: '0xfe' };
  const errors = ['NoPoliciesSet(bytes32)', 'PolicyViolation(bytes32,address)', 'SignerNotFound(bytes32,address)', 'InvalidSession(bytes32)', 'InvalidPermissionId(bytes32)',
    'InvalidISessionValidator(address)', 'InvalidUserOpSender(address)', 'InvalidEnableSignature(address,bytes32)', 'UnsupportedPolicy(address)', 'UnsupportedSmartSessionMode(uint8)',
    'UnsupportedCallType(bytes1)', 'UnsupportedExecutionType()', 'PaymasterValidationNotEnabled(bytes32)', 'ForbiddenValidationData()', 'ChainIdMismatch(uint64)',
    'HashMismatch(bytes32,bytes32)', 'InvalidActionId()', 'InvalidData()', 'InvalidMode()', 'InvalidSelfCall()', 'InvalidTarget()', 'NoExecutionsInBatch()',
    'SmartSessionModuleAlreadyInstalled(address)', 'AssociatedArray_OutOfBounds(uint256)'];
  for (const e of errors) {
    const item = parseAbiItem(`error ${e}`) as unknown as { name: string; inputs: { type: string }[] };
    const data = encodeErrorResult({ abi: [item], errorName: item.name, args: item.inputs.map(i => sample[i.type]) } as never) as Hex;
    const read = decodeRevert(data);
    assert.ok(read?.startsWith(item.name) && !read.startsWith('custom error'), `${e}: ${read}`);
  }
  // The two a session's operation meets most: with what they name, and what they mean.
  const violation = encodeErrorResult({ abi: [parseAbiItem('error PolicyViolation(bytes32,address)')], errorName: 'PolicyViolation', args: [ID, POLICY] });
  assert.equal(decodeRevert(violation), `PolicyViolation(${ID}, ${getAddress(POLICY)}): a policy of the session key's session (the address after its permission ID) refuses this operation`);
  assert.match(decodeRevert(encodeErrorResult({ abi: [parseAbiItem('error NoPoliciesSet(bytes32)')], errorName: 'NoPoliciesSet', args: [ID] }))!, /^NoPoliciesSet\(0x5e5e.*\): the session key's session has no policy for this call/);
});
