// A swap router on BNB Chain with an unpublished implementation (src/evm/bsc-fee-router.ts): its layout was read
// from real calls and their receipts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHex, type Hex } from 'viem';
import { previewRequest } from '../src/preview.ts';
import { StaticTokenRegistry } from '../src/chains.ts';
import { ALICE } from '../mocks/data.ts';
import { codes, detail, NOW } from './helpers.ts';

const ROUTER = '0xd36b6d646ac6e23672e9eedec558164c7f2d6deb', FEE_TO = '0x69aaaff7419fd2ce58079f05ff06b2ff66d446d2';
const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', USDT = '0x55d398326f99059ff775485246999027b3197955';
const word = (v: string | bigint) => (typeof v === 'bigint' ? v.toString(16) : v.slice(2)).toLowerCase().padStart(64, '0');
const call = (src: string, dst: string, amount: bigint, min: bigint, { bps = 60n, w7 = 0n } = {}) => `0x27772d13${[32n, src, dst, amount, min, 0n, bps, FEE_TO, w7, 0n, 0x180n, 0x1a0n, 0x1c0n, 0n, 0n, 0n].map(word).join('')}` as Hex;
const send = (data: Hex, value = 0n, chainId = 56) => previewRequest({ method: 'eth_sendTransaction', params: [{ from: ALICE, to: ROUTER, data, value: toHex(value), chainId: toHex(chainId) }] }, { now: NOW }, { tokens: new StaticTokenRegistry() });

test('Swaps through the BNB Chain fee router: what you pay, the least you get, the fee', async () => {
  const p = await send(call(NATIVE, USDT, 40_000_000_000_000_000n, 24_000_000_000_000_000_000n), 40_000_000_000_000_000n);
  assert.equal(p.decoding.decoder, 'bsc_fee_router');
  assert.equal(p.decoding.status, 'partial');
  assert.equal(p.title, 'Swap 0.04 BNB for at least 24 USDT (swap router 0xd36b…6deb)');
  assert.equal(detail(p, 'Fee'), '0.6% to 0x69aa…46d2');
  assert.deepEqual(p.assetChanges.map(c => [c.direction, c.amount, c.symbol]), [['out', '0.04', 'BNB'], ['in', '24', 'USDT']]);
  // The native coin out: the minimum is what you get, checked after the fee (as the node runs a real call).
  const out = await send(call(USDT, NATIVE, 10n ** 19n, 10n ** 16n));
  assert.match(out.title, /for at least 0\.01 BNB/);
  assert.ok(codes(await send(call(USDT, NATIVE, 10n ** 19n, 0n))).includes('no_slippage_limit'));
  assert.ok(codes(await send(call(USDT, NATIVE, 10n ** 19n, 1n, { bps: 150n }))).includes('large_fee_portion'));
  assert.ok(codes(await send(call(NATIVE, USDT, 10n ** 16n, 1n), 10n ** 15n)).includes('value_mismatch'));
});

test('Only the shape checked against receipts, on BNB Chain', async () => {
  assert.notEqual((await send(call(NATIVE, USDT, 10n ** 16n, 1n, { w7: 5n }), 10n ** 16n)).decoding.decoder, 'bsc_fee_router');
  assert.notEqual((await send(call(NATIVE, USDT, 10n ** 16n, 1n), 10n ** 16n, 1)).decoding.decoder, 'bsc_fee_router');
  assert.notEqual((await send('0x27772d13' as Hex)).decoding.decoder, 'bsc_fee_router');
});
