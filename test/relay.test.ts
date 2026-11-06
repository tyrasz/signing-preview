// Relay's depository: deposits against a request ID, and payouts signed by Relay's allocator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionData, parseAbi, toHex, type Hex } from 'viem';
import { previewRequest } from '../src/preview.ts';
import { StaticTokenRegistry } from '../src/chains.ts';
import type { Dependencies } from '../src/types.ts';
import { ALICE, BOB } from '../mocks/data.ts';
import { codes, detail, NOW } from './helpers.ts';

const DEPOSITORY = '0x4cd00e387622c35bddb9b4c962c136462338bc31', USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', ZERO = '0x0000000000000000000000000000000000000000';
const ID = `0x${'ab'.repeat(32)}` as Hex;
const ABI = parseAbi([
  'function depositNative(address depositor, bytes32 id) payable',
  'function depositErc20(address depositor, address token, uint256 amount, bytes32 id)',
  'function depositErc20(address depositor, address token, bytes32 id)',
  'function execute(((address to, bytes data, uint256 value, bool allowFailure)[] calls, uint256 nonce, uint256 expiration) request, bytes signature)',
  'function transfer(address to, uint256 amount)',
]);
const deps: Dependencies = { tokens: new StaticTokenRegistry() };
const send = (data: Hex, value = 0n, d = deps) => previewRequest({ method: 'eth_sendTransaction', params: [{ from: ALICE, to: DEPOSITORY, data, value: toHex(value), chainId: '0x1' }] }, { now: NOW }, d);

test('Relay deposits: what goes in, the request ID, and who is credited', async () => {
  const native = await send(encodeFunctionData({ abi: ABI, functionName: 'depositNative', args: [ZERO, ID] }), 10n ** 17n);
  assert.equal(native.title, 'Deposit 0.1 ETH to Relay');
  assert.equal(native.decoding.decoder, 'relay_deposit');
  assert.equal(detail(native, 'Relay request'), ID);
  assert.match(detail(native, 'Credited to')!, /^you /);
  assert.deepEqual(native.assetChanges.map(c => [c.direction, c.amount, c.symbol]), [['out', '0.1', 'ETH']]);
  assert.match(native.decoding.notes.join(' '), /not in this transaction/);
  const usdc = await send(encodeFunctionData({ abi: ABI, functionName: 'depositErc20', args: [BOB, USDC, 2_400_000_000n, ID] }));
  assert.equal(usdc.title, 'Deposit 2,400 USDC to Relay');
  assert.ok(codes(usdc).includes('relay_credit_other'));
  // The three-argument form deposits the whole allowance, read from the token.
  const rpc = { has: () => true, call: async () => toHex(5_000_000n, { size: 32 }) };
  const all = await send(encodeFunctionData({ abi: ABI, functionName: 'depositErc20', args: [ZERO, USDC, ID] }), 0n, { ...deps, rpc });
  assert.equal(all.title, 'Deposit 5 USDC to Relay');
});

test('Relay payouts: the allocator’s calls run from the depository; one to you is money in', async () => {
  const transfer = (to: string) => encodeFunctionData({ abi: ABI, functionName: 'transfer', args: [to as Hex, 1_000_000n] });
  const exec = (to: string, expiration: bigint) => encodeFunctionData({ abi: ABI, functionName: 'execute', args: [{ calls: [{ to: USDC, data: transfer(to), value: 0n, allowFailure: false }], nonce: 1n, expiration }, '0x1234'] });
  const later = BigInt(NOW / 1000 + 600);
  const mine = await send(exec(ALICE, later));
  assert.equal(mine.title, 'Relay payout: Send 1 USDC to you');
  assert.equal(mine.decoding.decoder, 'relay_execute');
  assert.deepEqual(mine.assetChanges.map(c => [c.direction, c.amount, c.symbol]), [['in', '1', 'USDC']]);
  const other = await send(exec(BOB, BigInt(NOW / 1000 - 60)));
  assert.equal(other.title, 'Relay payout: Send 1 USDC to 0xb0b0…0002');
  assert.equal(other.assetChanges.length, 0);
  assert.ok(codes(other).includes('relay_request_expired'));
});
