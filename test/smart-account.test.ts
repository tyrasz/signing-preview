// A smart account (an EIP-7702 delegated EOA or a smart wallet) calling itself to run a batch: each call is decoded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { concatHex, encodeAbiParameters, encodeFunctionData, numberToHex, pad, parseAbi, type Hex } from 'viem';
import { previewRequest } from '../src/preview.ts';
import { StaticTokenRegistry } from '../src/chains.ts';
import { ALICE, BOB } from '../mocks/data.ts';
import { codes, detail, NOW } from './helpers.ts';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const ERC20 = parseAbi(['function transfer(address,uint256)', 'function approve(address,uint256)']);
const ACCOUNT = parseAbi(['function execute(bytes32 mode, bytes executionData)', 'function executeBatch((address target, uint256 value, bytes data)[] calls)', 'function execute(address target, uint256 value, bytes data)']);
const CALLS = [{ type: 'tuple[]', components: [{ name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }] }] as const;
const transfer = encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [BOB, 1_000_000n] });
const approve = encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [BOB, (1n << 256n) - 1n] });
const send = (data: Hex) => previewRequest({ method: 'eth_sendTransaction', params: [{ from: ALICE, to: ALICE, data, chainId: '0x1' }] }, { now: NOW }, { tokens: new StaticTokenRegistry() });
const mode = (callType: string, execType = '00') => pad(`0x${callType}${execType}`, { dir: 'right', size: 32 });

test('ERC-7579 / ERC-7821 batches: every call decoded, with its own warnings numbered', async () => {
  const batch = encodeAbiParameters(CALLS, [[{ target: USDC, value: 0n, data: transfer }, { target: WETH, value: 0n, data: approve }]]);
  const p = await send(encodeFunctionData({ abi: ACCOUNT, functionName: 'execute', args: [mode('01'), batch] }));
  assert.equal(p.title, 'Run 2 calls from your account');
  assert.equal(detail(p, 'Call 1'), 'Send 1 USDC (0xa0b8…eb48)');
  assert.equal(detail(p, 'Call 2'), 'Allow 0xb0b0…0002 to spend unlimited WETH (0xc02a…6cc2)');
  assert.match(p.warnings.find(w => w.code === 'unlimited_approval')!.message, /^Call 2: /);
  assert.equal(p.decoding.decoder, 'smart_account');
  assert.equal(p.decoding.status, 'full');
  assert.deepEqual(p.assetChanges.map(c => `${c.direction} ${c.amount} ${c.symbol}`), ['out 1 USDC']);
  // ERC-7821 with opData after the calls; "try" mode noted.
  const withOp = encodeAbiParameters([...CALLS, { type: 'bytes' }], [[{ target: USDC, value: 0n, data: transfer }, { target: WETH, value: 0n, data: approve }], '0x1234']);
  const q = await send(encodeFunctionData({ abi: ACCOUNT, functionName: 'execute', args: [mode('01', '01'), withOp] }));
  assert.equal(q.title, 'Run 2 calls from your account');
  assert.ok(q.decoding.notes.some(n => /"try" mode/.test(n)));
});

test('Single calls (packed ERC-7579, execute(address,uint256,bytes)), executeBatch, and delegatecall', async () => {
  const single = concatHex([USDC, numberToHex(0n, { size: 32 }), transfer]);
  assert.equal((await send(encodeFunctionData({ abi: ACCOUNT, functionName: 'execute', args: [mode('00'), single] }))).title, 'Send 1 USDC');
  assert.equal((await send(encodeFunctionData({ abi: ACCOUNT, functionName: 'execute', args: [USDC, 0n, transfer] }))).title, 'Send 1 USDC');
  const coinbase = await send(encodeFunctionData({ abi: ACCOUNT, functionName: 'executeBatch', args: [[{ target: USDC, value: 0n, data: transfer }, { target: BOB, value: 10n ** 17n, data: '0x' }]] }));
  assert.equal(coinbase.title, 'Run 2 calls from your account');
  assert.match(detail(coinbase, 'Call 2')!, /^Send 0\.1 ETH/);
  const dc = await send(encodeFunctionData({ abi: ACCOUNT, functionName: 'execute', args: [mode('ff'), concatHex([BOB, '0xdeadbeef'])] }));
  assert.ok(codes(dc).includes('smart_account_delegatecall'));
  assert.equal(dc.attention, 'danger');
  // Not a self-call: an ordinary contract's execute is left to the other decoders.
  const other = await previewRequest({ method: 'eth_sendTransaction', params: [{ from: ALICE, to: BOB, data: encodeFunctionData({ abi: ACCOUNT, functionName: 'execute', args: [USDC, 0n, transfer] }), chainId: '0x1' }] }, { now: NOW }, { tokens: new StaticTokenRegistry() });
  assert.notEqual(other.decoding.decoder, 'smart_account');
});
