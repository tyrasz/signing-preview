// Binance Web3 Wallet's router (an unpublished diamond facet): its layout was read from real calls and their receipts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encodeAbiParameters, toHex, type Hex } from 'viem';
import { previewRequest } from '../src/preview.ts';
import { StaticTokenRegistry } from '../src/chains.ts';
import type { Dependencies } from '../src/types.ts';
import { ALICE, BOB } from '../mocks/data.ts';
import { codes, detail, NOW } from './helpers.ts';

const ROUTER = '0xb300000b72deaeb607a12d5f54773d1c19c7028d', FEE = '0x071e944d0ec39b4f8fdc3903824bb99c86cc41c0';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7', ZERO = '0x0000000000000000000000000000000000000000';
const deps: Dependencies = { tokens: new StaticTokenRegistry() };
const inner = `0xdeadbeef${'00'.repeat(32)}` as Hex; // a call no decoder knows
const call = (tokenIn: string, amountIn: bigint, feeBps: bigint, tokenOut: string, minOut: bigint, target = BOB) => `0x810c705b${encodeAbiParameters(
  [{ type: 'address' }, { type: 'address' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }],
  [FEE, target as Hex, `0xa0${'00'.repeat(11)}${tokenIn.slice(2)}` as Hex, amountIn, (feeBps << 160n) | BigInt(tokenOut), minOut, inner]).slice(2)}` as Hex;
const send = (data: Hex, value = 0n, from = ALICE) => previewRequest({ method: 'eth_sendTransaction', params: [{ from, to: ROUTER, data, value: toHex(value), chainId: '0x1' }] }, { now: NOW }, deps);

test('Binance Web3 Wallet swaps: what you pay, the minimum you get, and a fee taken from the output', async () => {
  const p = await send(call(USDT, 1_500_000_000n, 50n, USDC, 1_486_732_979n));
  assert.equal(p.title, 'Swap 1,500 USDT for at least 1,486.732979 USDC (Binance Web3 Wallet)');
  assert.equal(p.decoding.decoder, 'binance_wallet');
  assert.equal(p.decoding.status, 'partial');
  assert.equal(detail(p, 'Fee'), `0.5% of the output, to 0x071e…41c0`);
  assert.deepEqual(p.assetChanges.map(c => [c.direction, c.amount, c.symbol]), [['out', '1,500', 'USDT'], ['in', '1,486.732979', 'USDC']]);
  // ETH out with no fee: the fifth word is zero, but the minimum says it is a swap, not a bridge.
  const eth = await send(call(USDT, 10_637_560n, 0n, ZERO, 4_692_902_927_440_425n));
  assert.equal(eth.title, 'Swap 10.63756 USDT for at least 0.004692902927440425 ETH (Binance Web3 Wallet)');
  assert.ok(codes(await send(call(USDT, 1n, 1000n, USDC, 1n))).includes('large_fee_portion'));
  // No output and no minimum: a bridge, named by the wrapped call when it isn't decoded.
  const bridge = await send(call(USDT, 20_028_166n, 0n, ZERO, 0n));
  assert.equal(bridge.title, 'Send 20.028166 USDT through 0xb0b0…0002 (Binance Web3 Wallet)');
  assert.ok(codes(bridge).includes('bridge_terms_not_decoded'));
});

test('A real Binance Web3 Wallet bridge through LI.FI reads as the LI.FI bridge it wraps', async () => {
  const t = JSON.parse(readFileSync(new URL('./fixtures/binance-wallet-bridge.json', import.meta.url), 'utf8'));
  const p = await send(t.input, BigInt(t.value), t.from);
  assert.equal(p.title, 'Bridge 0.001 ETH to Arbitrum One via across (LI.FI, Binance Web3 Wallet)');
  assert.equal(detail(p, 'You pay'), '0.001 ETH');
  assert.ok(codes(p).includes('bridge_same_address'));
});
