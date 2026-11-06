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
