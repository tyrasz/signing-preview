// ERC-4337: UserOperations signed as EIP-712 typed data (EntryPoint v0.8/v0.9), and transactions to an EntryPoint.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { concatHex, encodeAbiParameters, encodeFunctionData, hashTypedData, numberToHex, pad, parseAbi, type Hex } from 'viem';
import { previewRequest } from '../src/preview.ts';
import { StaticTokenRegistry } from '../src/chains.ts';
import type { Dependencies, Simulator } from '../src/types.ts';
import { ALICE, BOB } from '../mocks/data.ts';
import { codes, detail, NOW } from './helpers.ts';

const EP8 = '0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const transfer = encodeFunctionData({ abi: parseAbi(['function transfer(address,uint256)']), args: [BOB, 1_000_000n] });
const CALLS = [{ type: 'tuple[]', components: [{ name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }] }] as const;
const execute = encodeFunctionData({ abi: parseAbi(['function execute(bytes32,bytes)']), args: [pad('0x01', { dir: 'right', size: 32 }), encodeAbiParameters(CALLS, [[{ target: USDC, value: 0n, data: transfer }]])] });
const packed = (high: bigint, low: bigint) => concatHex([numberToHex(high, { size: 16 }), numberToHex(low, { size: 16 })]);
const TYPES = { PackedUserOperation: [
  { name: 'sender', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'initCode', type: 'bytes' }, { name: 'callData', type: 'bytes' },
  { name: 'accountGasLimits', type: 'bytes32' }, { name: 'preVerificationGas', type: 'uint256' }, { name: 'gasFees', type: 'bytes32' }, { name: 'paymasterAndData', type: 'bytes' },
] };
const userOp = (m: Record<string, unknown> = {}, verifyingContract = EP8) => ({
  domain: { name: 'ERC4337', version: '1', chainId: 1, verifyingContract },
  types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }], ...TYPES },
  primaryType: 'PackedUserOperation',
  message: { sender: ALICE, nonce: '0x5', initCode: `0x7702${'00'.repeat(18)}`, callData: execute, accountGasLimits: packed(100_000n, 200_000n), preVerificationGas: '50000', gasFees: packed(1_000_000_000n, 3_000_000_000n), paymasterAndData: '0x', ...m },
});
const deps: Dependencies = { tokens: new StaticTokenRegistry() };
const sign = (data: unknown, signer = ALICE, d = deps) => previewRequest({ method: 'eth_signTypedData_v4', params: [signer, JSON.stringify(data)] }, { now: NOW }, d);

test('A UserOperation signed as typed data shows the calls it runs from the account, its setup and its gas', async () => {
  const data = userOp();
  const p = await sign(data);
  assert.equal(p.title, 'Sign a UserOperation: Send 1 USDC');
  assert.equal(p.decoding.decoder, 'erc4337_user_operation');
  assert.equal(detail(p, 'Account'), `your account (${ALICE})`);
  assert.equal(detail(p, 'EntryPoint'), `EntryPoint v0.8 (${EP8.toLowerCase()})`);
  assert.equal(detail(p, 'Account setup'), 'EIP-7702 account (its current delegation)');
  assert.equal(detail(p, 'Nonce'), '5 (key 0)');
  // (100,000 + 200,000 + 50,000) gas at 3 gwei.
  assert.equal(detail(p, 'Maximum gas cost'), '0.00105 ETH, from the account');
  assert.equal(detail(p, 'Call 1'), 'Send 1 USDC (0xa0b8…eb48)');
  // The digest shown is the standard EIP-712 one, which is the EntryPoint's getUserOpHash for this message.
  assert.equal(detail(p, 'EIP-712 digest'), hashTypedData({ ...data, domain: { ...data.domain, verifyingContract: EP8 as Hex }, message: { ...data.message, nonce: 5n, preVerificationGas: 50000n } } as never));
});

test('UserOperations: unknown EntryPoint, paymaster, an owner signing for a smart account, a factory deploying the account', async () => {
  assert.ok(codes(await sign(userOp({}, BOB))).includes('unknown_entrypoint'));
  const paymaster = '0x00000000000000000000000000000000000000aa';
  const sponsored = await sign(userOp({ paymasterAndData: concatHex([paymaster, numberToHex(60_000n, { size: 16 }), numberToHex(40_000n, { size: 16 }), '0x1234']) }));
  assert.equal(detail(sponsored, 'Gas paid by'), `paymaster ${paymaster} (at most 0.00135 ETH)`);
  assert.ok(codes(sponsored).includes('userop_paymaster'));
  const owner = await sign(userOp(), BOB);
  assert.ok(codes(owner).includes('userop_owner_signature'));
  // A counterfactual smart account, signed by its owner: no code on-chain yet, but the factory deploys it before the
  // calls run.
  const rpc = { has: () => true, call: async () => '0x' };
  const factory = await sign(userOp({ initCode: concatHex(['0x00000000000000000000000000000000000000fa', '0xabcdef']) }), BOB, { ...deps, rpc });
  assert.match(detail(factory, 'Account setup')!, /^deploys the account first, with factory 0x0000…00fa/);
  assert.equal(factory.title, 'Sign a UserOperation: Send 1 USDC');
  assert.ok(!codes(factory).includes('smart_account_no_code'));
});

test('An EIP-7702 account’s UserOperation as SDKs sign it (the delegate in the marker’s place); a delegation it doesn’t have yet', async () => {
  const DELEGATE = '0x63c0c19a282a1b52b07dd5a65b58948a07dae32b';
  const delegated = { has: () => true, call: async () => `0xef0100${DELEGATE.slice(2)}` };
  const p = await sign(userOp({ initCode: DELEGATE }), ALICE, { ...deps, rpc: delegated });
  assert.equal(detail(p, 'Account setup'), `EIP-7702 account, delegating to ${DELEGATE}`);
  assert.ok(!codes(p).includes('userop_delegation_differs'));
  const plain = { has: () => true, call: async () => '0x' };
  const q = await sign(userOp({ initCode: DELEGATE }), ALICE, { ...deps, rpc: plain });
  assert.match(q.warnings.find(w => w.code === 'userop_delegation_differs')!.message, /your account has no delegation now/);
});

test('UserOperation calls are simulated as the EntryPoint runs them: from the EntryPoint, after deploying a new account', async () => {
  const seen: { from: string; to: string | null }[][] = [];
  const ok: Simulator = {
    simulate: async r => { seen.push([{ from: r.from, to: r.to }]); return { status: 'success', source: 'test', transfers: [{ asset: USDC, from: r.to!, to: BOB, raw: 1_000_000n }] }; },
    simulateBatch: async rs => { seen.push(rs.map(r => ({ from: r.from, to: r.to }))); return rs.map(r => ({ status: 'success' as const, source: 'test', transfers: [{ asset: USDC, from: r.to!, to: BOB, raw: 1_000_000n }] })); },
  };
  const p = await sign(userOp({ initCode: '0x' }), ALICE, { ...deps, simulator: ok });
  assert.deepEqual(seen.at(-1), [{ from: EP8.toLowerCase(), to: ALICE.toLowerCase() }]);
  assert.deepEqual(p.assetChanges.map(c => `${c.direction} ${c.amount} ${c.symbol} ${c.basis}`), ['out 1 USDC simulated_events']);
  assert.match(p.decoding.notes.join(' '), /simulated as the EntryPoint runs it/);
  // A new smart account: v0.8's SenderCreator calls the factory, then the EntryPoint calls the account.
  const FACTORY = '0x00000000000000000000000000000000000fac70', ACCOUNT = '0x00000000000000000000000000000000000ac0c7';
  await sign(userOp({ sender: ACCOUNT, initCode: `${FACTORY}1234` }), ALICE, { ...deps, simulator: ok });
  assert.deepEqual(seen.at(-1), [{ from: '0x449ed7c3e6fee6a97311d4b55475df59c44add33', to: FACTORY }, { from: EP8.toLowerCase(), to: ACCOUNT }]);
  // A revert when the EntryPoint runs the calls is how the operation would fail.
  const reverts: Simulator = { simulate: async () => ({ status: 'reverted', source: 'test', revertReason: 'TRANSFER_FAILED', transfers: [] }) };
  const q = await sign(userOp({ initCode: '0x' }), ALICE, { ...deps, simulator: reverts });
  assert.match(q.warnings.find(w => w.code === 'userop_execution_reverts')!.message, /TRANSFER_FAILED/);
});

test('The gas prefund: the account’s deposit plus balance, or the paymaster’s deposit, must cover the most it can cost', async () => {
  const rpc = (deposit: bigint, balance: bigint) => ({ has: () => true, call: async (_c: number, method: string, params: unknown[]) =>
    method === 'eth_getBalance' ? `0x${balance.toString(16)}` : method === 'eth_getCode' ? '0x' : (params[0] as { data: string }).data.startsWith('0x70a08231') ? `0x${deposit.toString(16).padStart(64, '0')}` : `0x${'0'.repeat(64)}` });
  // At most (100,000 + 200,000 + 50,000) gas × 3 gwei = 0.00105 ETH.
  assert.ok(codes(await sign(userOp(), ALICE, { ...deps, rpc: rpc(0n, 10n ** 15n) })).includes('userop_cannot_prefund'));
  assert.ok(!codes(await sign(userOp(), ALICE, { ...deps, rpc: rpc(10n ** 15n, 10n ** 14n) })).includes('userop_cannot_prefund'));
});

test('Transactions to an EntryPoint: a bundle of UserOperations, and gas deposits', async () => {
  const OP = parseAbi(['function handleOps((address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature)[] ops, address beneficiary)', 'function depositTo(address)']);
  const op = (sender: Hex) => ({ sender, nonce: 0n, initCode: '0x' as Hex, callData: execute, accountGasLimits: packed(1n, 1n), preVerificationGas: 1n, gasFees: packed(1n, 1n), paymasterAndData: '0x' as Hex, signature: '0x' as Hex });
  const data = encodeFunctionData({ abi: OP, functionName: 'handleOps', args: [[op(BOB as Hex), op('0x00000000000000000000000000000000000000cc')], ALICE as Hex] });
  const p = await previewRequest({ method: 'eth_sendTransaction', params: [{ from: ALICE, to: EP8, data, chainId: '0x1' }] }, { now: NOW }, deps);
  assert.equal(p.title, 'Submit 2 UserOperations (an ERC-4337 bundle)');
  assert.equal(detail(p, 'UserOperation 1'), 'from 0xb0b0…0002: Send 1 USDC');
  assert.ok(codes(p).includes('erc4337_bundle'));
  const deposit = await previewRequest({ method: 'eth_sendTransaction', params: [{ from: ALICE, to: EP8, value: '0x2386f26fc10000', data: encodeFunctionData({ abi: OP, functionName: 'depositTo', args: [ALICE as Hex] }), chainId: '0x1' }] }, { now: NOW }, deps);
  assert.equal(deposit.title, "Deposit 0.01 ETH for your account's ERC-4337 gas");
});

// EntryPoint v0.6 and v0.7: the account's owner signs the bare userOpHash (personal_sign). Two real operations (Ethereum
// 0xee244eaa…, v0.7; Arbitrum 0x14efb41e…, v0.6), in the form bundlers' RPC carries them. Their hashes are the
// EntryPoint's own getUserOpHash, and the owners' real signatures are personal_sign of exactly these hashes (checked on
// 30 v0.7 and 26 v0.6 operations, 2026-11-06).
const OP_V07 = { sender: '0xA59f653372D92A47F60370f38e4F3F68bf8E41AE', nonce: '0x63', callData: '0xb61d27f6000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000044a9059cbb00000000000000000000000093cbfd95254a3fdd5534fb3b80b89d29ba3bae750000000000000000000000000000000000000000000000000000000000e4e1c000000000000000000000000000000000000000000000000000000000',
  preVerificationGas: '0xbb08', verificationGasLimit: '0x7302', callGasLimit: '0x7c6a', maxPriorityFeePerGas: '0x12c684c', maxFeePerGas: '0x8f78835', paymaster: '0x2cc0c7981d846b9f2a16276556f6e8cb52bfb633', paymasterVerificationGasLimit: '0x7302', paymasterPostOpGasLimit: '0x0',
  paymasterData: '0x00000000000000006aed37c9997f588e83193ac91ff6670f71ba6f8964f6864d8ea1e281897fe9e8bff9f34f7ec975f53eee24f9bfba0e5d8a41f7e4ab6b6294907f241647c20f591470b8011c' };
const HASH_V07 = '0x40131522ed86c88d97637947247c0bac60fee0fa64579b852dfe5f701c03f636', OWNER_V07 = '0x0ec3d2657eee1bef2939722dd78ff94f62562181';
const OP_V06 = { sender: '0x078Bf499222bFcbbFB50EbB191270A9baC93ce44', nonce: '0x68eca936d5b5d0c1c82467f1ffb7fb29fee09af672fc7a0f0000000000000000', initCode: '0x',
  callData: '0x18dfb3c7000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000000000002000000000000000000000000af88d065e77c8cc2239327c5edb3a432268e5831000000000000000000000000af88d065e77c8cc2239327c5edb3a432268e583100000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000016000000000000000000000000000000000000000000000000000000000000000e4d505accf00000000000000000000000075ab498536b0324b374feb02b21a4c7f2e4d59e8000000000000000000000000078bf499222bfcbbfb50ebb191270a9bac93ce440000000000000000000000000000000000000000000000000000000005f5e100000000000000000000000000000000000000000000000000000000006aed794c000000000000000000000000000000000000000000000000000000000000001cc135bec867b30d8ef8d8c9dd8bac26b89756d22ab89b169b26a104893154c4c00f115e72384baa60803d14ad47f6abfd8cb3a372fad85ec5a8f96ffd7a2be0d700000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000006423b872dd00000000000000000000000075ab498536b0324b374feb02b21a4c7f2e4d59e80000000000000000000000009ccf8e76b5aa8ff516d0bbcf3467531ba4bc48330000000000000000000000000000000000000000000000000000000005f5e10000000000000000000000000000000000000000000000000000000000',
  callGasLimit: '0x2b7a6', verificationGasLimit: '0x1491c', preVerificationGas: '0x0', maxFeePerGas: '0x0', maxPriorityFeePerGas: '0x0', paymasterAndData: '0x' };
const HASH_V06 = '0x20e8bbeaf8ef88adec7ac7a1d775cbcb1497ca586f219f9e9d4bcf0ab279ff69', OWNER_V06 = '0x4850f18b6295bf28d9e48ace95587aa08083a58b';
const EP7 = '0x0000000071727De22E5E9d8BAf0edAc6f37da032', EP6 = '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789';
const signHash = (hash: string, owner: string, entryPoint: string, operation: Record<string, unknown>, chainId: number, method = 'personal_sign') =>
  previewRequest({ method, params: method === 'eth_sign' ? [owner, hash] : [hash, owner] }, { now: NOW, chainId, userOperation: { entryPoint, operation } }, deps);

test('A v0.7 or v0.6 UserOperation signed as its hash: decoded from the supplied operation when it hashes to the message', async () => {
  const v07 = await signHash(HASH_V07, OWNER_V07, EP7, OP_V07, 1);
  assert.equal(v07.title, 'Sign a UserOperation: Send 15 USDC');
  assert.equal(v07.decoding.decoder, 'erc4337_user_operation_hash');
  assert.equal(detail(v07, 'UserOperation hash'), HASH_V07);
  assert.equal(detail(v07, 'EntryPoint'), 'EntryPoint v0.7 (0x0000000071727de22e5e9d8baf0edac6f37da032)');
  assert.match(String(detail(v07, 'Gas paid by')), /^paymaster 0x2cc0c7981d846b9f2a16276556f6e8cb52bfb633/);
  assert.equal(v07.assetChanges[0]?.amount, '15');
  // The same operation in the EntryPoint's packed form hashes the same.
  const packedForm = { sender: OP_V07.sender, nonce: OP_V07.nonce, initCode: '0x', callData: OP_V07.callData, accountGasLimits: packed(0x7302n, 0x7c6an), preVerificationGas: OP_V07.preVerificationGas, gasFees: packed(0x12c684cn, 0x8f78835n),
    paymasterAndData: concatHex([OP_V07.paymaster as Hex, numberToHex(0x7302n, { size: 16 }), numberToHex(0n, { size: 16 }), OP_V07.paymasterData as Hex]) };
  assert.equal(detail(await signHash(HASH_V07, OWNER_V07, EP7, packedForm, 1), 'UserOperation hash'), HASH_V07);

  const v06 = await signHash(HASH_V06, OWNER_V06, EP6, OP_V06, 42161);
  assert.equal(v06.title, 'Sign a UserOperation: Run 2 calls from your account');
  assert.equal(detail(v06, 'Format'), 'executeBatch(address[],bytes[])');
  assert.equal(detail(v06, 'UserOperation hash'), HASH_V06);
  assert.ok((await signHash(HASH_V06, OWNER_V06, EP6, OP_V06, 42161, 'eth_sign')).warnings.every(w => w.severity !== 'danger'));
});

test('A hash that isn’t the supplied operation’s is danger; an unknown EntryPoint or no operation leaves it a binary message', async () => {
  const other = await signHash(HASH_V06, OWNER_V07, EP7, OP_V07, 1);
  assert.equal(other.attention, 'danger');
  assert.match(other.warnings.find(w => w.code === 'userop_hash_mismatch')!.message, new RegExp(HASH_V07));
  assert.equal(other.title, 'Sign a binary message');
  assert.equal((await signHash(HASH_V07, OWNER_V07, EP7, OP_V07, 42161)).attention, 'danger'); // hashed for another chain
  assert.ok(codes(await signHash(HASH_V07, OWNER_V07, EP8, OP_V07, 1)).includes('userop_hash_mismatch'));
  const plain = await previewRequest({ method: 'personal_sign', params: [HASH_V07, OWNER_V07] }, { now: NOW }, deps);
  assert.equal(plain.decoding.decoder, 'personal_sign');
});

test('A v0.7 operation the account itself is asked to sign, with a factory: a deployment, not an EIP-7702 delegation', async () => {
  const { readOperation, userOpHash } = await import('../src/userop-hash.ts');
  const op = { ...OP_V07, factory: '0x4e1dcf7ad4e460cfd30791ccc4f9c8a4f820ec67', factoryData: '0x1688f0b9' };
  const hash = userOpHash(readOperation(op, '0.7')!, EP7.toLowerCase(), 1, '0.7');
  const p = await signHash(hash, OP_V07.sender, EP7, op, 1);
  assert.match(String(detail(p, 'Account setup')), /^deploys the account first, with factory 0x4e1d/);
  assert.ok(!codes(p).includes('userop_delegation_differs'), codes(p).join());
});
