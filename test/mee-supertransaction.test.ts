// What a Biconomy MEE supertransaction's preview (src/supertransaction.ts) says when an app builds its operations
// against the person signing: operations of an account of its own, a drain on another chain, steps that depend on one
// another, time bounds, and operations that can't be hashed. On test/evm-chain.ts with the real K1MeeValidator's code
// (test/fixtures/k1mee-session.json), Nexus-like accounts whose sessions name it, and EntryPoint v0.7's simulation code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { concatHex, encodeFunctionData, keccak256, parseAbi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { previewRequest } from '../src/preview.ts';
import { StaticTokenRegistry } from '../src/chains.ts';
import { RpcSimulator } from '../src/simulation.ts';
import { JsonRpcClient } from '../src/rpc.ts';
import { ForkSimulator } from '../src/fork-simulator.ts';
import { ENTRY_POINT_SIMULATIONS_V07 } from '../src/entrypoint-simulations.ts';
import { readOperation, userOpHash } from '../src/userop-hash.ts';
import { K1MEE_VALIDATOR } from '../src/erc4337-sim.ts';
import { meeLeaf, runOrder } from '../src/supertransaction.ts';
import { merkleTrees } from '../src/typed-data/safe.ts';
import type { Dependencies, Preview, PreviewContext } from '../src/types.ts';
import { NOW } from './helpers.ts';
import { compiled, testChain } from './evm-chain.ts';

const EP = '0x0000000071727de22e5e9d8baf0edac6f37da032';
const SS = '0x00000000008bdaba73cd9815d79069c247eb4bda';
const KEY = privateKeyToAccount('0x7777777777777777777777777777777777777777777777777777777777777777').address.toLowerCase();
const ATTACKER = '0xa77ac4e7000000000000000000000000000000aa';
const BOB = '0xb0b0000000000000000000000000000000000002';
const URL_ = 'http://hyperevm.invalid';
const E = 10n ** 18n;
const fx = JSON.parse(readFileSync(new URL('./fixtures/k1mee-session.json', import.meta.url), 'utf8')) as { validator: { address: string; code: Hex } };

const chain = await testChain();
const wrap = await chain.deploy('Token', 'string,uint8', ['WRAP', 18]);
const tkn = await chain.deploy('Token', 'string,uint8', ['TKN', 6]);
const sweeper = await chain.deploy('Sweeper', '', []);
await chain.putCode(EP, ENTRY_POINT_SIMULATIONS_V07 as Hex);
await chain.putCode(fx.validator.address, fx.validator.code);
await chain.putCode(SS, `0x${compiled('SmartSessionLike').evm.deployedBytecode.object}`);
const A = parseAbi(['function mint(address,uint256)', 'function transfer(address,uint256)', 'function approve(address,uint256)', 'function transferFrom(address,address,uint256)', 'function deposit()',
  'function execute(address,uint256,bytes)', 'function enableSessionWith(address,bytes32,address,bytes)', 'function sweep(address,address)', 'function onInstall(bytes)']);
const call = (fn: string, args: unknown[]) => encodeFunctionData({ abi: A, functionName: fn, args } as never);
const deps: Dependencies = {
  tokens: new StaticTokenRegistry({ 999: [{ address: wrap, symbol: 'WRAP', decimals: 18, name: 'Wrapped' }, { address: tkn, symbol: 'TKN', decimals: 6, name: 'Token' }] }),
  rpc: new JsonRpcClient({ 999: URL_ }, { fetchImpl: chain.fetchImpl }),
  simulator: new RpcSimulator({ 999: URL_ }, { fetchImpl: chain.fetchImpl, fork: new ForkSimulator({ 999: URL_ }, { fetchImpl: chain.fetchImpl }) }),
};
const operation = (m: Record<string, unknown>) => ({ nonce: '0x0', callGasLimit: '0x30d40', verificationGasLimit: '0x30d40', preVerificationGas: '0xc350', maxFeePerGas: '0x77359400', maxPriorityFeePerGas: '0x3b9aca00', ...m });
const hashOf = (op: Record<string, unknown>, chainId = 999) => userOpHash(readOperation(op, '0.7')!, EP, chainId, '0.7');
const pair = (a: Hex, b: Hex) => keccak256(BigInt(a) < BigInt(b) ? concatHex([a, b]) : concatHex([b, a]));
/** A Nexus nonce naming SmartSession (its first three bytes MEE's own), and its sequence. */
const nonceKey = (prefix: string, seq = 0) => `0x${prefix}0000000000${SS.slice(12)}${seq.toString(16).padStart(16, '0')}`;
/** A Nexus account with a K1MeeValidator session for KEY (any account can name any key so), 1 HYPE and `tokens` TKN. */
async function nexus(id: number, tokens = 0n) {
  const n = await chain.deploy('NexusLike', 'address', [EP]);
  await chain.exec(n, call('enableSessionWith', [SS, `0x${id.toString(16).padStart(64, '0')}`, K1MEE_VALIDATOR, KEY]));
  await chain.setBalance(n, E);
  if (tokens) await chain.exec(tkn, call('mint', [n, tokens]));
  return n;
}
type Supplied = { chainId?: number; operation: Record<string, unknown>; proof?: Hex[]; lowerBoundTimestamp?: number | string; upperBoundTimestamp?: number | string };
const sign = (root: Hex, ops: Supplied[], context: PreviewContext = {}, method = 'personal_sign'): Promise<Preview> =>
  previewRequest({ method, params: method === 'eth_sign' ? [KEY, root] : [root, KEY] }, { now: NOW, chainId: 999, ...context, meeOperations: ops.map(o => ({ chainId: 999, entryPoint: EP, ...o })) }, deps);
const codes = (p: Preview) => p.warnings.map(w => w.code);
const changes = (p: Preview, symbol: string) => p.assetChanges.filter(c => c.symbol === symbol).map(c => `${c.direction} ${c.amount}`);
const warning = (p: Preview, code: string) => p.warnings.find(w => w.code === code);

test('An operation of another account (an app’s own, which takes the signer’s key): what it receives isn’t netted against what yours sends, and a caution names both accounts', async () => {
  const mine = await nexus(0x10, 100_000_000n);
  // The app's account: it names KEY as a session key (anyone can, on their own account), so the root's signature
  // validates there too; its owner's EOA has approved it, and its operation pulls 100 TKN of the owner's into it.
  const theirs = await nexus(0x11);
  const OWNER = '0xa77ac4e7000000000000000000000000000000bb';
  await chain.exec(tkn, call('mint', [OWNER, 100_000_000n]));
  await chain.exec(tkn, call('approve', [theirs, (1n << 256n) - 1n]), OWNER);
  const drain = operation({ sender: mine, nonce: nonceKey('569434'), callData: call('execute', [tkn, 0n, call('transfer', [ATTACKER, 100_000_000n])]) });
  const cover = operation({ sender: theirs, nonce: nonceKey('569434'), callData: call('execute', [tkn, 0n, call('transferFrom', [OWNER, theirs, 100_000_000n])]) });
  const p = await sign(pair(hashOf(drain), hashOf(cover)), [{ operation: drain }, { operation: cover }], { account: KEY });
  assert.ok(codes(p).includes('mee_supertransaction_verified'), codes(p).join());
  // Before: [out 100, in 100] at attention info, read as "You send 100 TKN" and "You receive 100 TKN".
  assert.deepEqual(p.assetChanges.filter(c => c.symbol === 'TKN').map(c => [c.direction, c.amount, c.account, c.chainId]), [['out', '100', mine, 999]]);
  const several = warning(p, 'operations_multiple_accounts');
  assert.equal(several?.severity, 'caution');
  assert.ok(several!.message.includes(`${mine.slice(0, 6)}…${mine.slice(-4)}`) && several!.message.includes(`${theirs.slice(0, 6)}…${theirs.slice(-4)}`), several!.message);
  assert.equal(p.attention, 'caution');
  assert.equal(p.details.find(d => d.label === `Operation 2 (HyperEVM): received by ${theirs.slice(0, 6)}…${theirs.slice(-4)} (not in the balance changes)`)?.value, '+100 TKN');
  // With the user's account connected (context.account), its incoming amounts are listed too; the other's still aren't.
  const connected = await sign(pair(hashOf(drain), hashOf(cover)), [{ operation: drain }, { operation: cover }], { account: theirs });
  assert.deepEqual(changes(connected, 'TKN'), ['out 100', 'in 100']);
  assert.match(warning(connected, 'operations_multiple_accounts')!.message, /and what 0x[0-9a-f]{4}…[0-9a-f]{4}, the connected account, receives/);

  // The same with an account that takes no signature of the signer's at all (an ECDSA account the app owns): its
  // operation isn't one "you sign as an owner" of, and its incoming tokens aren't listed either.
  const ecdsa = await chain.deploy('Account4337', 'address,address', ['0xa77ac4e7000000000000000000000000000000cc', EP]);
  await chain.setBalance(ecdsa, E);
  await chain.exec(tkn, call('mint', [ecdsa, 0n]));
  const OWNER2 = '0xa77ac4e7000000000000000000000000000000dd';
  await chain.exec(tkn, call('mint', [OWNER2, 100_000_000n]));
  await chain.exec(tkn, call('approve', [ecdsa, (1n << 256n) - 1n]), OWNER2);
  const pull = operation({ sender: ecdsa, callData: call('execute', [tkn, 0n, call('transferFrom', [OWNER2, ecdsa, 100_000_000n])]) });
  const v = await sign(pair(hashOf(drain), hashOf(pull)), [{ operation: drain }, { operation: pull }]);
  assert.deepEqual(changes(v, 'TKN'), ['out 100']);
  assert.ok(codes(v).includes('operations_multiple_accounts'));
  assert.ok(!v.warnings.some(w => w.code === 'userop_owner_signature' && w.message.startsWith('Operation 2')), codes(v).join());
  assert.ok(v.warnings.some(w => w.code === 'userop_owner_signature' && w.message.startsWith('Operation 1')), codes(v).join());

  // An allowance an operation of yours grants the app's account, which its own operation (run after it) takes your
  // tokens with: what leaves your account is listed, though the operation that moves it is theirs.
  const grant = operation({ sender: mine, nonce: nonceKey('569435'), callData: call('execute', [tkn, 0n, call('approve', [theirs, 100_000_000n])]) });
  const take = operation({ sender: theirs, nonce: nonceKey('569435'), callData: call('execute', [tkn, 0n, call('transferFrom', [mine, theirs, 100_000_000n])]) });
  const t = await sign(pair(hashOf(grant), hashOf(take)), [{ operation: grant }, { operation: take }]);
  assert.deepEqual(t.assetChanges.filter(c => c.symbol === 'TKN').map(c => [c.direction, c.amount, c.account]), [['out', '100', mine]]);
  assert.equal(t.details.find(d => d.label === `Operation 2 (HyperEVM): received by ${theirs.slice(0, 6)}…${theirs.slice(-4)} (not in the balance changes)`)?.value, '+100 TKN');
  assert.equal(t.attention, 'caution');
});

test('Operations on one chain are simulated in the order they run: a send of what an earlier operation wrapped succeeds, as it will', async () => {
  const n = await nexus(0x20);
  // Two nonce keys, as MEE varies them: op 1 wraps 0.5 HYPE, op 2 sends that 0.5 WRAP on.
  const op1 = operation({ sender: n, nonce: nonceKey('569434'), callData: call('execute', [wrap, E / 2n, call('deposit', [])]) });
  const op2 = operation({ sender: n, nonce: nonceKey('569435'), callData: call('execute', [wrap, 0n, call('transfer', [ATTACKER, E / 2n])]) });
  const p = await sign(pair(hashOf(op1), hashOf(op2)), [{ operation: op1 }, { operation: op2 }]);
  // Before: op 2 was run alone on the latest state, "The operation's calls fail when the EntryPoint runs them: balance".
  assert.ok(!codes(p).includes('userop_execution_reverts'), codes(p).join());
  assert.ok(p.assetChanges.some(c => c.direction === 'out' && c.symbol === 'WRAP' && c.amount === '0.5' && c.basis === 'simulated_state'), JSON.stringify(p.assetChanges));
  assert.ok(p.decoding.notes.some(n => /simulated in the order they run/.test(n)), p.decoding.notes.join(' | '));
  // (Op 2 alone sends nothing more than in order: it fails without the WRAP. No danger.)
  assert.ok(!codes(p).includes('mee_operation_alone_differs'), codes(p).join());

  // One nonce key: the EntryPoint runs its operations in their nonce's order, whatever the order supplied.
  const first = operation({ sender: n, nonce: nonceKey('569436', 0), callData: call('execute', [wrap, E / 4n, call('deposit', [])]) });
  const second = operation({ sender: n, nonce: nonceKey('569436', 1), callData: call('execute', [wrap, 0n, call('transfer', [BOB, E / 4n])]) });
  assert.deepEqual(runOrder([{ chainId: 999, sender: n, nonce: BigInt(second.nonce) }, { chainId: 999, sender: n, nonce: BigInt(first.nonce) }]), [1, 0]);
  const q = await sign(pair(hashOf(second), hashOf(first)), [{ operation: second }, { operation: first }]);
  assert.ok(!codes(q).includes('userop_execution_reverts') && !codes(q).includes('userop_rejected'), codes(q).join());
  assert.ok(q.assetChanges.some(c => c.direction === 'out' && c.symbol === 'WRAP' && c.amount === '0.25' && c.basis === 'simulated_state'), JSON.stringify(q.assetChanges));
});

test('Past a chain’s first 8 operations, each is simulated alone (in order, the work grows with the square of their number), and one that fails so may depend on the others', async () => {
  const n = await nexus(0x21);
  // Op 1 wraps 0.5 HYPE, ops 2 to 8 do nothing, op 9 sends the 0.5 WRAP on: the 9th of its chain, it runs alone.
  const wrapOp = operation({ sender: n, nonce: nonceKey('569434'), callData: call('execute', [wrap, E / 2n, call('deposit', [])]) });
  const idle = Array.from({ length: 7 }, (_, i) => operation({ sender: n, nonce: nonceKey((0x569435 + i).toString(16)), callData: call('execute', [BOB, 0n, '0x']) }));
  const send = operation({ sender: n, nonce: nonceKey('569440'), callData: call('execute', [wrap, 0n, call('transfer', [ATTACKER, E / 2n])]) });
  const all = [wrapOp, ...idle, send];
  const p = await sign(merkleTrees(all.map(o => hashOf(o)))[0].root as Hex, all.map(operation => ({ operation })));
  assert.match(warning(p, 'mee_operation_may_depend')?.message ?? codes(p).join(), /^Operation 9 \(HyperEVM\): its calls fail on the chain's state now, but the supertransaction's other operations on this chain couldn't be simulated before it/);
  assert.ok(p.decoding.notes.some(x => /the first 8 of each chain\. Past those, each was simulated alone/.test(x)), p.decoding.notes.join(' | '));
  assert.deepEqual(p.assetChanges.filter(c => c.symbol === 'WRAP').map(c => [c.direction, c.amount, c.basis]), [['in', '0.5', 'simulated_state'], ['out', '0.5', 'requested']]);
});

test('An operation that can be submitted without the ones before it, and then sends more: a danger', async () => {
  const n = await nexus(0x30, 100_000_000n);
  await chain.exec(tkn, call('approve', [sweeper, (1n << 256n) - 1n]), n);
  // Op 1 sends the 100 TKN to Bob; op 2 sweeps whatever TKN is left to the app. In order it sweeps nothing; its
  // nonce key is its own, so it can be submitted alone, and then sweeps all 100.
  const send = operation({ sender: n, nonce: nonceKey('569434'), callData: call('execute', [tkn, 0n, call('transfer', [BOB, 100_000_000n])]) });
  const sweep = operation({ sender: n, nonce: nonceKey('569435'), callData: call('execute', [sweeper, 0n, call('sweep', [tkn, ATTACKER])]) });
  const p = await sign(pair(hashOf(send), hashOf(sweep)), [{ operation: send }, { operation: sweep }]);
  assert.deepEqual(changes(p, 'TKN'), ['out 100']);
  const alone = warning(p, 'mee_operation_alone_differs');
  assert.equal(alone?.severity, 'danger', codes(p).join());
  assert.match(alone!.message, /^Operation 2 \(HyperEVM\): it was simulated after operation 1, .* submit it alone: then it sends 100 TKN, more than after them/);
  assert.equal(p.attention, 'danger');
  // Under the same nonce key, after op 1's: it can't run without it, and isn't simulated alone.
  const after = operation({ ...sweep, nonce: nonceKey('569434', 1) });
  const q = await sign(pair(hashOf(send), hashOf(after)), [{ operation: send }, { operation: after }]);
  assert.ok(!codes(q).includes('mee_operation_alone_differs'), codes(q).join());
  // An operation that does nothing, under the sweep's nonce key and before it: the sweep needs only that one, so it
  // can still be submitted without op 1 (after the no-op), and is simulated so: the same danger.
  const noop = operation({ sender: n, nonce: nonceKey('569436', 0), callData: call('execute', [BOB, 0n, '0x']) });
  const later = operation({ ...sweep, nonce: nonceKey('569436', 1) });
  const three = [send, noop, later];
  const r = await sign(merkleTrees(three.map(o => hashOf(o)))[0].root as Hex, three.map(operation => ({ operation })));
  assert.deepEqual(changes(r, 'TKN'), ['out 100']);
  assert.match(warning(r, 'mee_operation_alone_differs')?.message ?? codes(r).join(), /^Operation 3 \(HyperEVM\): it was simulated after operations 1, 2, .* doesn't wait for operation 1's \(only for operation 2's, under its own nonce key\), .* submit it without operation 1: then it sends 100 TKN/);
  assert.equal(r.attention, 'danger');
});

test('Operations on a chain other than the request’s: their balance changes are listed, each with its chain; one that fails there may wait for the others', async () => {
  const n = await nexus(0x40, 100_000_000n);
  const drain = operation({ sender: n, nonce: nonceKey('569434'), callData: call('execute', [tkn, 0n, call('transfer', [ATTACKER, 100_000_000n])]) });
  const elsewhere = operation({ sender: n, nonce: nonceKey('569436'), callData: '0x' });
  const root = pair(hashOf(drain), hashOf(elsewhere, 1));
  // The wallet on Ethereum (chainId 1), the drain on HyperEVM. Before: assetChanges [] at attention info.
  const p = await sign(root, [{ operation: drain }, { chainId: 1, operation: elsewhere }], { chainId: 1 });
  assert.ok(codes(p).includes('mee_supertransaction_verified'));
  assert.deepEqual(p.assetChanges.map(c => [c.direction, c.amount, c.symbol, c.chainId]), [['out', '100', 'TKN', 999]]);
  // A HyperEVM operation spending what a bridge on another chain would bring: it fails on HyperEVM's state now, and
  // the preview says the others may change that; what it asks for is still listed.
  const spend = operation({ sender: n, nonce: nonceKey('569437'), callData: call('execute', [tkn, 0n, call('transfer', [ATTACKER, 500_000_000n])]) });
  const q = await sign(pair(hashOf(spend), hashOf(elsewhere, 1)), [{ operation: spend }, { chainId: 1, operation: elsewhere }], { chainId: 1 });
  assert.ok(codes(q).includes('userop_execution_reverts'), codes(q).join());
  assert.match(warning(q, 'mee_operation_may_depend')?.message ?? '', /^Operation 1 \(HyperEVM\): its calls fail on the chain's state now, but operations of the supertransaction on other chains .* may run first/);
  assert.deepEqual(q.assetChanges.map(c => [c.direction, c.amount, c.symbol, c.basis, c.chainId]), [['out', '500', 'TKN', 'requested', 999]]);
});

test('Time bounds of an operation the account’s own K1MeeValidator checks: shown, and an operation not yet valid, without expiry or expired is said to be', async () => {
  const nx = await chain.deploy('NexusLike', 'address', [EP]);
  await chain.exec(K1MEE_VALIDATOR, call('onInstall', [KEY]), nx);
  await chain.exec(tkn, call('mint', [nx, 100_000_000n]));
  await chain.setBalance(nx, E);
  const mine = operation({ sender: nx, nonce: `0x56943400${K1MEE_VALIDATOR.slice(2)}${'00'.repeat(8)}`, callData: call('execute', [tkn, 0n, call('transfer', [ATTACKER, 100_000_000n])]) });
  const other = `0x${'ef'.repeat(32)}` as Hex, now = Math.floor(NOW / 1000);
  const timed = (lower: number, upper: number) => sign(pair(meeLeaf(hashOf(mine), { lowerBoundTimestamp: BigInt(lower), upperBoundTimestamp: BigInt(upper) }), other), [{ operation: mine, lowerBoundTimestamp: lower, upperBoundTimestamp: upper, proof: [other] }]);
  const detail = (p: Preview, label: string) => p.details.find(d => d.label === `Operation 1 (HyperEVM): ${label}`)?.value;
  // Valid a year from now, with no upper bound: before, nothing in the preview said so.
  const later = await timed(now + 365 * 86_400, 0);
  assert.equal(detail(later, 'Valid from'), new Date((now + 365 * 86_400) * 1000).toISOString().replace('.000Z', 'Z'));
  assert.equal(detail(later, 'Valid until'), 'no expiry');
  assert.equal(warning(later, 'mee_operation_not_yet_valid')?.severity, 'caution');
  assert.match(warning(later, 'mee_operation_no_expiry')!.message, /^Operation 1 \(HyperEVM\): It has no expiry/);
  // Expired: K1MeeValidator refuses it.
  const expired = await timed(0, now - 86_400);
  assert.match(warning(expired, 'mee_operation_expired')?.message ?? '', /can no longer run/);
  assert.equal(detail(expired, 'Valid from'), undefined);
  // MEE's default (now, three minutes on): the window, and nothing to warn of.
  const usual = await timed(now, now + 180);
  assert.equal(detail(usual, 'Valid until'), new Date((now + 180) * 1000).toISOString().replace('.000Z', 'Z'));
  assert.ok(!usual.warnings.some(w => w.code.startsWith('mee_operation_')), codes(usual).join());
  // Valid for a week: noted.
  assert.equal(warning(await timed(now, now + 7 * 86_400), 'mee_operation_long_validity')?.severity, 'info');
  // A bound past uint48, which K1MeeValidator can't take (its leaf, hashed with it as uint256, isn't what it checks).
  const big = 2n ** 48n;
  const p = await sign(pair(meeLeaf(hashOf(mine), { lowerBoundTimestamp: 0n, upperBoundTimestamp: big }), other), [{ operation: mine, lowerBoundTimestamp: 0, upperBoundTimestamp: big.toString(), proof: [other] }]);
  assert.match(warning(p, 'mee_supertransaction_mismatch')?.message ?? '', /operation 1's time bounds aren't K1MeeValidator's/);
});

test('Operations a wallet (or app) can supply that can’t be hashed: a malformed operation, a danger, not a failed preview', async () => {
  const n = await nexus(0x50);
  const op = operation({ sender: n, nonce: nonceKey('569434'), callData: '0x' });
  const hash = `0x${'ab'.repeat(32)}` as Hex;
  // A negative chain ID, a time bound past uint256, a v0.7 gas limit past uint128: each threw (HTTP 500), and the
  // interceptor's fallback turned eth_sign's danger into a caution.
  const bad: [Supplied, RegExp][] = [
    [{ chainId: -1, operation: op }, /operation 1's chain ID \(-1\) isn't a chain's/],
    [{ operation: op, lowerBoundTimestamp: `2${'0'.repeat(77)}`, upperBoundTimestamp: 0 }, /operation 1's time bounds aren't K1MeeValidator's/],
    [{ operation: { ...op, callGasLimit: `0x1${'0'.repeat(32)}` } }, /operation 1 is malformed/],
    [{ operation: { ...op, paymaster: ATTACKER, paymasterVerificationGasLimit: `0x1${'0'.repeat(32)}`, paymasterPostOpGasLimit: '0x0', paymasterData: '0x' } }, /operation 1 is malformed/],
  ];
  for (const method of ['eth_sign', 'personal_sign']) for (const [o, why] of bad) {
    const p = await sign(hash, [o], {}, method);
    assert.match(warning(p, 'mee_supertransaction_mismatch')?.message ?? '', why);
    assert.equal(p.attention, 'danger');
    if (method === 'eth_sign') assert.ok(codes(p).includes('eth_sign'), codes(p).join());
  }
  // The operation's own hash (context.userOperation), with a negative chain ID: a mismatch, not an exception.
  const own = await previewRequest({ method: 'personal_sign', params: [hash, KEY] }, { now: NOW, chainId: -1, userOperation: { entryPoint: EP, operation: op } }, deps);
  assert.match(warning(own, 'userop_hash_mismatch')?.message ?? '', /its chain ID \(-1\) isn't a chain's/);
});

test('More than 1,024 K1MeeValidator sessions, the signer’s the oldest: not read, and not said to be no session of the account’s', async () => {
  await chain.putCode('0xca11bde05977b3631167028862be2a173976ca11', `0x${compiled('Multicall3Like').evm.deployedBytecode.object}`);
  const nx = await chain.deploy('NexusLike', 'address', [EP]);
  await chain.exec(nx, call('enableSessionWith', [SS, `0x${(0x5000).toString(16).padStart(64, '0')}`, K1MEE_VALIDATOR, KEY]));
  for (let i = 1; i <= 1030; i++) await chain.exec(nx, call('enableSessionWith', [SS, `0x${(0x5000 + i).toString(16).padStart(64, '0')}`, K1MEE_VALIDATOR, `0x${(0x100000 + i).toString(16).padStart(40, '0')}`]));
  await chain.exec(tkn, call('mint', [nx, 100_000_000n]));
  await chain.setBalance(nx, E);
  const op = operation({ sender: nx, nonce: nonceKey('569434'), callData: call('execute', [tkn, 0n, call('transfer', [ATTACKER, 1n])]) });
  const p = await previewRequest({ method: 'personal_sign', params: [hashOf(op), KEY] }, { now: NOW, chainId: 999, userOperation: { entryPoint: EP, operation: op } }, deps);
  const note = p.decoding.notes.find(n => /^The whole operation/.test(n)) ?? '';
  // Before: "the account doesn't accept it as theirs (… and the signer asked isn't one of them)".
  assert.doesNotMatch(note, /doesn't accept it as theirs|isn't one of them/);
  assert.match(note, /the account doesn't take it \(.*1024 sessions among the newest 1024 of its 1031.*the signer asked holds none of the 1024 read, but may hold one of the 7 older ones, which weren't read\), which needn't mean it won't take theirs/);
  await chain.putCode('0xca11bde05977b3631167028862be2a173976ca11', '0x');
});
