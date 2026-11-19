// Biconomy MEE 3: Nexus 1.3.1 accounts whose default validator, K1MeeValidator 1.1.0, takes a supertransaction signed
// as EIP-712 typed data (src/supertransaction.ts, previewTypedSupertransaction; src/erc4337-sim.ts, k1meeOwnTyped). On
// test/evm-chain.ts with the real code of both (test/fixtures/nexus-mee3.json, from Base) at their addresses, and an
// EIP-7702 account delegating to Nexus 1.3.1 with no owner set, whose own key then signs. (In a file of its own: the
// fork simulator keeps the code it reads at an address for the process.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encodeFunctionData, encodePacked, hashTypedData, keccak256, parseAbi, stringToHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { previewRequest } from '../src/preview.ts';
import { StaticTokenRegistry, ecrecoverPrice } from '../src/chains.ts';
import { RpcSimulator } from '../src/simulation.ts';
import { JsonRpcClient } from '../src/rpc.ts';
import { ForkSimulator } from '../src/fork-simulator.ts';
import { ENTRY_POINT_SIMULATIONS_V07 } from '../src/entrypoint-simulations.ts';
import { readOperation, userOpHash } from '../src/userop-hash.ts';
import { k1meeOwnTyped } from '../src/erc4337-sim.ts';
import { meeLeaf, SUPER_TX_ARRAY_TYPEHASH } from '../src/supertransaction.ts';
import type { Dependencies, Preview } from '../src/types.ts';
import { NOW } from './helpers.ts';
import { testChain } from './evm-chain.ts';

const EP = '0x0000000071727de22e5e9d8baf0edac6f37da032';
const BOB = '0xb0b0000000000000000000000000000000000002';
const URL_ = 'http://hyperevm.invalid';
const E = 10n ** 18n;
const fx = JSON.parse(readFileSync(new URL('./fixtures/nexus-mee3.json', import.meta.url), 'utf8')) as Record<'nexus' | 'validator', { address: string; code: Hex }>;

const chain = await testChain();
const usdc = await chain.deploy('Token', 'string,uint8', ['USDC', 6]);
await chain.putCode(EP, ENTRY_POINT_SIMULATIONS_V07 as Hex);
for (const c of [fx.nexus, fx.validator]) await chain.putCode(c.address, c.code);
const deps: Dependencies = {
  tokens: new StaticTokenRegistry({ 999: [{ address: usdc, symbol: 'USDC', decimals: 6, name: 'USD Coin' }] }),
  rpc: new JsonRpcClient({ 999: URL_ }, { fetchImpl: chain.fetchImpl }),
  simulator: new RpcSimulator({ 999: URL_ }, { fetchImpl: chain.fetchImpl, fork: new ForkSimulator({ 999: URL_ }, { fetchImpl: chain.fetchImpl }) }),
};
const A = parseAbi(['function mint(address,uint256)', 'function transfer(address,uint256)', 'function execute(bytes32 mode, bytes executionCalldata)']);
const call = (fn: string, args: unknown[]) => encodeFunctionData({ abi: A, functionName: fn, args } as never);
const sendUsdc = call('execute', [`0x${'00'.repeat(32)}`, encodePacked(['address', 'uint256', 'bytes'], [usdc as Hex, 0n, call('transfer', [BOB, 50_000_000n])])]);
/** A nonce as MEE sends a Nexus account's: three bytes of its own, mode 0x00, the default validator (0), the sequence. */
const NONCE = `0x02ffbe00${'00'.repeat(20)}${'00'.repeat(8)}`;
const operation = (m: Record<string, unknown>) => ({ nonce: NONCE, callData: sendUsdc, callGasLimit: '0x30d40', verificationGasLimit: '0x7a120', preVerificationGas: '0xc350', maxFeePerGas: '0x77359400', maxPriorityFeePerGas: '0x3b9aca00', ...m });
const hashOf = (op: Record<string, unknown>) => userOpHash(readOperation(op, '0.7')!, EP, 999, '0.7');
const BOUNDS = { lowerBoundTimestamp: 1_790_000_000n, upperBoundTimestamp: 1_800_000_000n };
const MEE_USER_OP = [{ name: 'userOpHash', type: 'bytes32' }, { name: 'lowerBoundTimestamp', type: 'uint256' }, { name: 'upperBoundTimestamp', type: 'uint256' }];
/** The supertransaction as MEE 3 has it signed: an array of MeeUserOps, under the domain of the account's name. */
const superTx = (hashes: Hex[], name = 'Nexus') => ({ domain: { name }, types: { EIP712Domain: [{ name: 'name', type: 'string' }], SuperTx: [{ name: 'meeUserOps', type: 'MeeUserOp[]' }], MeeUserOp: MEE_USER_OP }, primaryType: 'SuperTx',
  message: { meeUserOps: hashes.map(userOpHash => ({ userOpHash, lowerBoundTimestamp: BOUNDS.lowerBoundTimestamp.toString(), upperBoundTimestamp: BOUNDS.upperBoundTimestamp.toString() })) } });
const signTyped = (typed: unknown, signer: string, ops: Record<string, unknown>[]): Promise<Preview> =>
  previewRequest({ method: 'eth_signTypedData_v4', params: [signer, JSON.stringify(typed)] }, { now: NOW, chainId: 999, meeOperations: ops.map(operation => ({ chainId: 999, entryPoint: EP, operation })) }, deps);
const preview = (op: Record<string, unknown>, signer: string): Promise<Preview> =>
  previewRequest({ method: 'personal_sign', params: [hashOf(op), signer] }, { now: NOW, chainId: 999, userOperation: { entryPoint: EP, operation: op } }, deps);
const usdcChange = (p: Preview) => p.assetChanges.filter(c => c.symbol === 'USDC').map(c => `${c.direction} ${c.amount}`);
const wholeNote = (p: Preview, i?: number) => p.decoding.notes.find(n => (i === undefined ? /^The whole operation was simulated/ : new RegExp(`^Operation ${i} \\(HyperEVM\\): The whole operation was simulated`)).test(n)) ?? p.decoding.notes.join(' | ');
const gasUsed = (p: Preview, i?: number) => BigInt(String(p.details.find(d => d.label === `${i === undefined ? '' : `Operation ${i} (HyperEVM): `}Gas used (simulated)`)?.raw));
const codes = (p: Preview) => p.warnings.map(w => w.code);
/** What each real ecrecover call the replaced one forwards costs over the stand-in's: HyperEVM's price (15,000), which this test's EVM charges 3,000 for. */
const priced = (calls: number) => BigInt(calls * (ecrecoverPrice(999) - 3000));
const mee = (h: Hex) => keccak256(`0x${keccak256(stringToHex('MeeUserOp(bytes32 userOpHash,uint256 lowerBoundTimestamp,uint256 upperBoundTimestamp)')).slice(2)}${h.slice(2)}${BOUNDS.lowerBoundTimestamp.toString(16).padStart(64, '0')}${BOUNDS.upperBoundTimestamp.toString(16).padStart(64, '0')}`);

/** An EIP-7702 account delegating to Nexus 1.3.1, no owner set (its own key signs), with 100 USDC and 1 ETH. */
async function account(n: number) {
  const key = privateKeyToAccount(`0x${(0x5100 + n).toString(16).padStart(64, '0')}`);
  const address = key.address.toLowerCase();
  await chain.putCode(address, `0xef0100${fx.nexus.address.slice(2)}` as Hex);
  await chain.exec(usdc, call('mint', [address, 100_000_000n]));
  await chain.setBalance(address, E);
  return { key, address, op: operation({ sender: address }) };
}

test('MEE 3: the account’s key signs a supertransaction as typed data; its operation runs whole in K1MeeValidator 1.1.0’s simple mode, for a real signature’s gas', async () => {
  const { key, address, op } = await account(1);
  const typed = superTx([hashOf(op)]);
  const p = await signTyped(typed, address, [op]);
  assert.equal(p.kind, 'typed_data');
  assert.equal(p.decoding.decoder, 'mee_supertransaction');
  assert.ok(codes(p).includes('mee_supertransaction_verified'), codes(p).join());
  assert.ok(codes(p).includes('mee_supertransaction_domain'));
  assert.match(wholeNote(p, 1), /ecrecover attributes it to the signer/);
  assert.doesNotMatch(wholeNote(p, 1), /doesn't accept/);
  assert.deepEqual(usdcChange(p), ['out 50']);
  assert.ok(p.decoding.notes.some(n => /^Operation 1 \(HyperEVM\): The account's owner signs the supertransaction as EIP-712 typed data/.test(n)), p.decoding.notes.join(' | '));
  assert.equal(p.details.find(d => d.label === 'EIP-712 digest')?.value, hashTypedData({ ...typed, message: { meeUserOps: [{ userOpHash: hashOf(op), ...BOUNDS }] } } as never));
  // The real signature in that layout: the key's over the typed data, through the replaced ecrecover once (the
  // validator recovers over the digest as it is first).
  const signature = await key.signTypedData({ ...typed, message: { meeUserOps: [{ userOpHash: hashOf(op), ...BOUNDS }] } } as never);
  const real = await preview({ ...op, signature: k1meeOwnTyped(signature, { root: '0x', proof: [], bounds: BOUNDS, typed: { outerTypeHash: SUPER_TX_ARRAY_TYPEHASH, itemHashes: [mee(hashOf(op))], itemIndex: 0 } }) }, address);
  assert.match(wholeNote(real), /with the wallet's stand-in signature\)/);
  assert.doesNotMatch(wholeNote(real), /doesn't accept/);
  const forwarding = gasUsed(real) + priced(1) - gasUsed(p, 1);
  assert.ok(forwarding >= 150n && forwarding <= 260n, `${gasUsed(real)} ${gasUsed(p, 1)}`);
  // What simple mode costs over the plain form (the key's signature over the operation's hash as it is), the real
  // signatures of both on Nexus's and the validator's own code: one item, and each further one.
  const plain = gasUsed(await preview({ ...op, signature: await key.sign({ hash: hashOf(op) }) }, address));
  const items = async (n: number) => {
    const others = Array.from({ length: n - 1 }, (_, i) => keccak256(`0x${(i + 1).toString(16).padStart(2, '0')}`));
    const t = superTx([hashOf(op), ...others]);
    const sig = await key.signTypedData({ ...t, message: { meeUserOps: [hashOf(op), ...others].map(userOpHash => ({ userOpHash, ...BOUNDS })) } } as never);
    return gasUsed(await preview({ ...op, signature: k1meeOwnTyped(sig, { root: '0x', proof: [], bounds: BOUNDS, typed: { outerTypeHash: SUPER_TX_ARRAY_TYPEHASH, itemHashes: [mee(hashOf(op)), ...others.map(mee)], itemIndex: 0 } }) }, address));
  };
  const costs = [await items(1), await items(2), await items(5)];
  assert.deepEqual([costs[0] - plain, costs[1] - costs[0], costs[2] - costs[1]], [4589n, 191n, 577n]);
  // Asked by someone else: refused, as the account's own key is its owner.
  const b = await signTyped(typed, BOB, [op]);
  assert.match(wholeNote(b, 1), /doesn't accept it as theirs/);
});

test('MEE 3: a supertransaction of two operations, one supplied: the other is shown by its hash only, a danger; one supplied that isn’t an item isn’t previewed', async () => {
  const one = await account(2), two = await account(3);
  const p = await signTyped(superTx([hashOf(one.op), hashOf(two.op)]), one.address, [one.op]);
  assert.ok(codes(p).includes('mee_supertransaction_partial'), codes(p).join());
  assert.match(p.warnings.find(w => w.code === 'mee_supertransaction_partial')!.message, /1 operation besides the ones supplied, shown only by its hash \(item 2\)/);
  assert.match(wholeNote(p, 1), /ecrecover attributes it to the signer/);
  assert.doesNotMatch(wholeNote(p, 1), /doesn't accept/);
  assert.match(p.title, /, and others not shown$/);
  assert.ok(p.details.some(d => d.label === 'Item 2 (meeUserOps[1])' && d.value.includes(hashOf(two.op))));
  // With none supplied: every operation only a hash.
  const none = await signTyped(superTx([hashOf(one.op)]), one.address, []);
  assert.equal(none.title, 'Sign a supertransaction: 1 operation not shown');
  assert.ok(codes(none).includes('mee_supertransaction_partial'));
  // An operation supplied that isn't one of the items.
  const stray = await signTyped(superTx([hashOf(one.op)]), one.address, [one.op, two.op]);
  assert.match(stray.warnings.find(w => w.code === 'mee_operation_not_in_supertransaction')!.message, /^Operation 2 supplied with it isn't among its items/);
});

test('MEE 3: a supertransaction as a struct of items of other types too: the outer type hash is EIP-712’s, the operation validates, and the other item is said to be unread', async () => {
  const { address, op } = await account(4);
  const typed = { domain: { name: 'Nexus' }, primaryType: 'SuperTx',
    types: { EIP712Domain: [{ name: 'name', type: 'string' }], SuperTx: [{ name: 'entry0', type: 'Note' }, { name: 'entry1', type: 'MeeUserOp' }], Note: [{ name: 'text', type: 'string' }], MeeUserOp: MEE_USER_OP },
    message: { entry0: { text: 'hello' }, entry1: { userOpHash: hashOf(op), lowerBoundTimestamp: BOUNDS.lowerBoundTimestamp.toString(), upperBoundTimestamp: BOUNDS.upperBoundTimestamp.toString() } } };
  const p = await signTyped(typed, address, [op]);
  assert.equal(p.decoding.decoder, 'mee_supertransaction');
  assert.match(p.warnings.find(w => w.code === 'mee_supertransaction_partial')!.message, /1 item that isn't an operation \(entry0: Note\)/);
  assert.match(wholeNote(p, 1), /ecrecover attributes it to the signer/);
  assert.doesNotMatch(wholeNote(p, 1), /doesn't accept/);
});

test('MEE 3: typed data under a domain with a chain or an account isn’t a supertransaction; a Nexus 1.3.1 account asked for a supertransaction’s hash (MEE 2.1) refuses it, and says why', async () => {
  const { address, op } = await account(5);
  const other = await signTyped({ ...superTx([hashOf(op)]), domain: { name: 'Nexus', chainId: 999 }, types: { ...superTx([hashOf(op)]).types, EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }] } }, address, [op]);
  assert.notEqual(other.decoding.decoder, 'mee_supertransaction');
  // A supertransaction's hash, as MEE 2.1 has it signed: K1MeeValidator 1.1.0 doesn't take it.
  const root = meeLeaf(hashOf(op), BOUNDS);
  const p = await previewRequest({ method: 'personal_sign', params: [root, address] }, { now: NOW, chainId: 999, meeOperations: [{ chainId: 999, entryPoint: EP, operation: op, lowerBoundTimestamp: BOUNDS.lowerBoundTimestamp.toString(), upperBoundTimestamp: BOUNDS.upperBoundTimestamp.toString() }] }, deps);
  // (It reads the root's layout as its own, and reverts.)
  assert.match(p.decoding.notes.join(' | '), /Operation 1 \(HyperEVM\): The account's validation reverts on a stand-in for the signature \(AA23 reverted: Panic\(0x32\)\): .*its K1MeeValidator \(1\.1\.0, MEE 3\) takes a supertransaction signed as EIP-712 typed data, not its hash signed as a message, so only its calls were simulated/);
  // The operation's own hash (the plain form): taken, with a note of MEE 3's typed data.
  const plain = await preview(op, address);
  assert.doesNotMatch(wholeNote(plain), /doesn't accept/);
  assert.ok(plain.decoding.notes.some(n => /K1MeeValidator 1\.1\.0\) takes as it is \(its plain form\)\. Sent through Biconomy's MEE node, the owner would sign the supertransaction as EIP-712 typed data instead/.test(n)), plain.decoding.notes.join(' | '));
});
