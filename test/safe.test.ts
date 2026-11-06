// Safe multisig: owner signatures (SafeTx) and execTransaction, with the delegatecall danger (the Bybit pattern).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { concatHex, encodeFunctionData, encodePacked, parseAbi, size, type Hex } from 'viem';
import { previewRequest } from '../src/preview.ts';
import { StaticTokenRegistry } from '../src/chains.ts';
import type { Dependencies } from '../src/types.ts';
import { ALICE, BOB } from '../mocks/data.ts';
import { codes, detail, NOW } from './helpers.ts';

const SAFE = '0x5afe00000000000000000000000000000000cafe', USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', ZERO = '0x0000000000000000000000000000000000000000';
const MULTISEND_CALL_ONLY = '0x9641d764fc13c8B624c04430C7356C1C7C8102e2';
const ABI = parseAbi(['function transfer(address,uint256)', 'function addOwnerWithThreshold(address owner, uint256 threshold)', 'function enableModule(address module)', 'function multiSend(bytes transactions)',
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)']);
const transfer = encodeFunctionData({ abi: ABI, functionName: 'transfer', args: [BOB, 1_000_000_000n] });
const deps: Dependencies = { tokens: new StaticTokenRegistry() };
const safeTx = (m: Record<string, unknown>) => ({
  domain: { chainId: 1, verifyingContract: SAFE },
  types: { EIP712Domain: [{ name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
    SafeTx: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }, { name: 'operation', type: 'uint8' }, { name: 'safeTxGas', type: 'uint256' }, { name: 'baseGas', type: 'uint256' },
      { name: 'gasPrice', type: 'uint256' }, { name: 'gasToken', type: 'address' }, { name: 'refundReceiver', type: 'address' }, { name: 'nonce', type: 'uint256' }] },
  primaryType: 'SafeTx',
  message: { to: USDC, value: '0', data: transfer, operation: 0, safeTxGas: '0', baseGas: '0', gasPrice: '0', gasToken: ZERO, refundReceiver: ZERO, nonce: '5', ...m },
});
const sign = (m: Record<string, unknown>, d = deps) => previewRequest({ method: 'eth_signTypedData_v4', params: [ALICE, JSON.stringify(safeTx(m))] }, { now: NOW }, d);
const multiSend = (calls: [number, string, bigint, Hex][]) => encodeFunctionData({ abi: ABI, functionName: 'multiSend', args: [concatHex(calls.map(([op, to, value, data]) => encodePacked(['uint8', 'address', 'uint256', 'uint256', 'bytes'], [op, to as Hex, value, BigInt(size(data)), data])))] });

test('A SafeTx signature: the call the Safe makes, decoded as its own transaction', async () => {
  const p = await sign({});
  assert.equal(p.title, 'Safe transaction: Send 1,000 USDC');
  assert.equal(p.decoding.decoder, 'safe_tx');
  assert.equal(detail(p, 'Safe'), SAFE);
  assert.equal(p.attention, 'none');
});

test('A delegatecall to anything but Safe’s libraries is danger (the Bybit pattern); MultiSend batches are unpacked', async () => {
  const bybit = await sign({ to: '0x96221423681a6d52e184d440a8efcebb105c7242', data: '0xa9059cbb', operation: 1 });
  assert.equal(bybit.attention, 'danger');
  assert.match(bybit.warnings.find(w => w.code === 'safe_delegatecall')!.message, /Bybit/);
  assert.equal(bybit.title, 'Safe transaction: Let 0x9622…7242 run its code as the Safe (delegatecall)');
  const batch = await sign({ to: MULTISEND_CALL_ONLY, operation: 1, data: multiSend([[0, USDC, 0n, transfer], [0, SAFE, 0n, encodeFunctionData({ abi: ABI, functionName: 'addOwnerWithThreshold', args: [BOB, 2n] })]]) });
  assert.equal(batch.title, 'Safe transaction: Run 2 calls from the Safe');
  assert.equal(detail(batch, 'Call 1'), 'Send 1,000 USDC (0xa0b8…eb48)');
  assert.equal(detail(batch, 'Call 2'), 'Add owner 0xb0b0…0002 (threshold 2) (0x5afe…cafe)');
  assert.ok(codes(batch).includes('safe_owners_change'));
  assert.ok(!codes(batch).includes('safe_delegatecall'));
  const module = await sign({ to: SAFE, data: encodeFunctionData({ abi: ABI, functionName: 'enableModule', args: [BOB] }) });
  assert.equal(module.title, 'Safe transaction: Enable module 0xb0b0…0002');
  assert.equal(module.attention, 'danger');
});

test('Gas refunds to a named receiver, a used nonce, and a signer who is not an owner', async () => {
  const refund = await sign({ gasPrice: '1000000000', baseGas: '50000', refundReceiver: BOB });
  assert.ok(codes(refund).includes('safe_gas_refund'));
  const rpc = { has: () => true, call: async (_c: number, _m: string, p: unknown[]) => ((p[0] as { data: string }).data === '0xaffed0e0' ? '0x9' : `0x${'0'.repeat(64)}`) };
  const stale = await sign({}, { ...deps, rpc });
  assert.ok(codes(stale).includes('safe_nonce_used'));
  assert.ok(codes(stale).includes('safe_not_owner'));
});

test('execTransaction: the same reading of what the Safe does, whoever submits it', async () => {
  const data = encodeFunctionData({ abi: ABI, functionName: 'execTransaction', args: [USDC, 0n, transfer, 0, 0n, 0n, 0n, ZERO, ZERO, `0x${'11'.repeat(130)}`] });
  const p = await previewRequest({ method: 'eth_sendTransaction', params: [{ from: ALICE, to: SAFE, data, chainId: '0x1' }] }, { now: NOW }, deps);
  assert.equal(p.title, 'Execute a Safe transaction: Send 1,000 USDC');
  assert.equal(detail(p, 'Owner signatures'), '2');
});

test('A SafeMessage: a message signed in the Safe’s name, its text shown when it is text', async () => {
  const msg = (message: string) => previewRequest({ method: 'eth_signTypedData_v4', params: [ALICE, JSON.stringify({ domain: { chainId: 1, verifyingContract: SAFE }, types: { EIP712Domain: [{ name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }], SafeMessage: [{ name: 'message', type: 'bytes' }] }, primaryType: 'SafeMessage', message: { message } })] }, { now: NOW }, deps);
  const text = await msg(`0x${Buffer.from('Sign in to app.example.com').toString('hex')}`);
  assert.equal(text.title, 'Sign a message as the Safe 0x5afe…cafe');
  assert.equal(detail(text, 'Message'), 'Sign in to app.example.com');
  const hash = await msg(`0x${'ab'.repeat(32)}`);
  assert.equal(detail(hash, 'Message hash'), `0x${'ab'.repeat(32)}`);
});

test('Safe 1.5.0 libraries are known, and an official migration is a caution, not a danger', async () => {
  const batch = await sign({ to: '0xA83c336B20401Af773B6219BA5027174338D1836', operation: 1, data: multiSend([[0, USDC, 0n, transfer]]) });
  assert.ok(!codes(batch).includes('safe_delegatecall'));
  const upgrade = await sign({ to: '0x6439e7ABD8Bb915A5263094784C5CF561c4172AC', operation: 1, data: '0xed007fc6' });
  assert.equal(upgrade.title, 'Safe transaction: Upgrade the Safe (SafeMigration 1.5.0)');
  assert.equal(upgrade.attention, 'caution');
});

// Safe's ERC-4337 module: SafeOp signatures. The two real operations below ran on-chain (Ethereum 0x064f9624…,
// Arbitrum 0xe5ed98a4…); their digests equal the module's own getOperationHash, and each signature recovers to an
// owner of its Safe (checked on 12 v0.3.0 operations on Ethereum and 9 v0.2.0 ones on Arbitrum, 2026-11-06).
const SAFE_OP_V03 = { domain: { chainId: 1, verifyingContract: '0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226' }, primaryType: 'SafeOp',
  types: { EIP712Domain: [{ name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
    SafeOp: [{ type: 'address', name: 'safe' }, { type: 'uint256', name: 'nonce' }, { type: 'bytes', name: 'initCode' }, { type: 'bytes', name: 'callData' }, { type: 'uint128', name: 'verificationGasLimit' }, { type: 'uint128', name: 'callGasLimit' }, { type: 'uint256', name: 'preVerificationGas' }, { type: 'uint128', name: 'maxPriorityFeePerGas' }, { type: 'uint128', name: 'maxFeePerGas' }, { type: 'bytes', name: 'paymasterAndData' }, { type: 'uint48', name: 'validAfter' }, { type: 'uint48', name: 'validUntil' }, { type: 'address', name: 'entryPoint' }] },
  message: { safe: '0x33a25CfB3064c9F23Ceb852095E9558B26D048c0', nonce: '33091642621071838969604660527104', initCode: '0x', callData: '0x541d63c8000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb480000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000044a9059cbb0000000000000000000000003282e08ea72e471b63f974e115147c4ab82580c1000000000000000000000000000000000000000000000000000000086721b28000000000000000000000000000000000000000000000000000000000',
    verificationGasLimit: '81360', callGasLimit: '42124', preVerificationGas: '49161', maxPriorityFeePerGas: '191316258', maxFeePerGas: '1044394660', paymasterAndData: '0x', validAfter: '0', validUntil: '0', entryPoint: '0x0000000071727de22e5e9d8baf0edac6f37da032' } };
const SAFE_OP_V02 = { domain: { chainId: 42161, verifyingContract: '0xa581c4A4DB7175302464fF3C06380BC3270b4037' }, primaryType: 'SafeOp',
  types: { EIP712Domain: SAFE_OP_V03.types.EIP712Domain,
    SafeOp: [{ type: 'address', name: 'safe' }, { type: 'uint256', name: 'nonce' }, { type: 'bytes', name: 'initCode' }, { type: 'bytes', name: 'callData' }, { type: 'uint256', name: 'callGasLimit' }, { type: 'uint256', name: 'verificationGasLimit' }, { type: 'uint256', name: 'preVerificationGas' }, { type: 'uint256', name: 'maxFeePerGas' }, { type: 'uint256', name: 'maxPriorityFeePerGas' }, { type: 'bytes', name: 'paymasterAndData' }, { type: 'uint48', name: 'validAfter' }, { type: 'uint48', name: 'validUntil' }, { type: 'address', name: 'entryPoint' }] },
  message: { safe: '0x7e395F30Dc457832dF7990FBaF59ec60F968d1ED', nonce: '206276', initCode: '0x', callData: '0x7bb37428000000000000000000000000af88d065e77c8cc2239327c5edb3a432268e58310000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000044a9059cbb000000000000000000000000aec850549ce6ba2bd7607c9fbcbff6a4b92b219000000000000000000000000000000000000000000000000000000000042c1d80000000000000000000000000000000000000000000000000000000005afe003134623562383766346530326233353866303664343432343537373263',
    callGasLimit: '132458', verificationGasLimit: '131638', preVerificationGas: '64055', maxFeePerGas: '0', maxPriorityFeePerGas: '0', paymasterAndData: '0x', validAfter: '0', validUntil: '0', entryPoint: '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789' } };
/** Safe4337Module.getOperationHash for each operation, read on-chain. */
const V03_DIGEST = '0x53123bfaa9c0f0a00abf31a45b1174695e590cc28c1fc223c9e0b4f2f046fe7b', V02_DIGEST = '0xdf68431664e31c5a3b7f3549b4e3fea2d4114eacc3926635a7802681f6bbce1b';
const signOp = (op: typeof SAFE_OP_V03, m: Record<string, unknown> = {}, domain: Record<string, unknown> = {}, d = deps) =>
  previewRequest({ method: 'eth_signTypedData_v4', params: [ALICE, JSON.stringify({ ...op, domain: { ...op.domain, ...domain }, message: { ...op.message, ...m } })] }, { now: NOW }, d);
const execute = (to: string, data: Hex, operation: number) => encodeFunctionData({ abi: parseAbi(['function executeUserOp(address to, uint256 value, bytes data, uint8 operation)']), functionName: 'executeUserOp', args: [to as Hex, 0n, data, operation] });

test('A SafeOp (Safe’s 4337 module, v0.3.0 and v0.2.0): the call the Safe makes, as for a Safe transaction', async () => {
  const v03 = await signOp(SAFE_OP_V03);
  assert.equal(v03.title, 'Safe operation: Send 36,090 USDC');
  assert.equal(v03.decoding.decoder, 'safe_4337_op');
  assert.equal(detail(v03, 'Module'), 'Safe4337Module v0.3.0 (0x75cf11467937ce3f2f357ce24ffc3dbf8fd5c226)');
  assert.equal(detail(v03, 'EntryPoint'), 'EntryPoint v0.7 (0x0000000071727de22e5e9d8baf0edac6f37da032)');
  assert.equal(detail(v03, 'Valid until'), 'no expiry');
  assert.match(String(detail(v03, 'Maximum gas cost')), /ETH, from the account$/);
  assert.equal(detail(v03, 'EIP-712 digest'), V03_DIGEST);
  assert.equal(v03.attention, 'none');
  const v02 = await signOp(SAFE_OP_V02 as unknown as typeof SAFE_OP_V03);
  assert.equal(v02.title, 'Safe operation: Send 70 USDC');
  assert.equal(detail(v02, 'EntryPoint'), 'EntryPoint v0.6 (0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789)');
  assert.equal(detail(v02, 'EIP-712 digest'), V02_DIGEST);
});

test('SafeOp checks: delegatecalls, an unknown module or EntryPoint, a plain call to MultiSend, and a used nonce', async () => {
  const rogue = await signOp(SAFE_OP_V03, { callData: execute('0x96221423681a6d52e184d440a8efcebb105c7242', '0xa9059cbb', 1) });
  assert.equal(rogue.attention, 'danger');
  assert.equal(rogue.title, 'Safe operation: Let 0x9622…7242 run its code as the Safe (delegatecall)');
  assert.ok(codes(await signOp(SAFE_OP_V03, {}, { verifyingContract: BOB })).includes('unknown_safe_module'));
  assert.ok(codes(await signOp(SAFE_OP_V03, { entryPoint: '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789' })).includes('safe_op_entrypoint_mismatch'));
  const plain = await signOp(SAFE_OP_V03, { callData: execute(MULTISEND_CALL_ONLY, multiSend([[0, USDC, 0n, transfer]]), 0) });
  assert.match(plain.warnings.find(w => w.code === 'safe_multisend_call')!.message, /runs from the MultiSend contract, not from the Safe/);
  const batch = await signOp(SAFE_OP_V03, { callData: execute(MULTISEND_CALL_ONLY, multiSend([[0, USDC, 0n, transfer], [0, USDC, 0n, transfer]]), 1) });
  assert.equal(batch.title, 'Safe operation: Run 2 calls from the Safe');
  assert.ok(codes(await signOp(SAFE_OP_V03, { callData: transfer })).includes('safe_op_unsupported_call'));
  assert.ok(codes(await signOp(SAFE_OP_V03, { validUntil: String(NOW / 1000 - 60) })).includes('safe_op_expired'));
  // EntryPoint.getNonce past the operation's nonce: it has run. isOwner and isModuleEnabled answer 1.
  const rpc = { has: () => true, call: async (_c: number, _m: string, p: unknown[]) => (p[0] as { data: string }).data.startsWith('0x35567e1a') ? `0x${'0'.repeat(63)}9` : `0x${'0'.repeat(63)}1` };
  const used = await signOp(SAFE_OP_V03, {}, {}, { ...deps, rpc });
  assert.ok(codes(used).includes('userop_nonce_used'));
  assert.ok(!codes(used).includes('safe_not_owner') && !codes(used).includes('safe_module_not_enabled'));
});
