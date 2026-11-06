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

test('UserOperation calls are simulated as the account; a revert there (EntryPoint-only accounts) is not called a failure', async () => {
  const ok: Simulator = { simulate: async r => ({ status: 'success', source: 'test', transfers: [{ asset: USDC, from: r.from, to: BOB, raw: 1_000_000n }] }) };
  const p = await sign(userOp(), ALICE, { ...deps, simulator: ok });
  assert.deepEqual(p.assetChanges.map(c => `${c.direction} ${c.amount} ${c.symbol} ${c.basis}`), ['out 1 USDC simulated_events']);
  const reverts: Simulator = { simulate: async () => ({ status: 'reverted', source: 'test', revertReason: 'only EntryPoint', transfers: [] }) };
  const q = await sign(userOp(), ALICE, { ...deps, simulator: reverts });
  assert.equal(q.attention === 'danger', false);
  assert.ok(q.decoding.notes.some(n => /doesn't mean the operation fails/.test(n)));
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
