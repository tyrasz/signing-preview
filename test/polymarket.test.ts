// Polymarket orders (CTF Exchange V2, and the first exchange, which no longer trades) and the order book's sign-in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previewRequest } from '../src/preview.ts';
import { StaticTokenRegistry } from '../src/chains.ts';
import { POLYMARKET } from '../src/typed-data/polymarket.ts';
import type { Dependencies } from '../src/types.ts';
import { ALICE } from '../mocks/data.ts';
import { codes, detail, NOW } from './helpers.ts';

const word = (v: bigint) => v.toString(16).padStart(64, '0');
/** 57 pUSD, the exchange approved for all of it; 40 shares, the exchange approved; max fee rate 0; not paused. */
const deps = (): Dependencies => ({ tokens: new StaticTokenRegistry(), rpc: { has: () => true, call: async (_c: number, _m: string, params: unknown[]) => {
  const { data } = params[0] as { data: string };
  const sel = data.slice(0, 10);
  if (sel === '0x70a08231') return `0x${word(57_000_000n)}`;
  if (sel === '0xdd62ed3e') return `0x${word((1n << 256n) - 1n)}`;
  if (sel === '0x00fdd58e') return `0x${word(40_000_000n)}`;
  if (sel === '0xe985e9c5') return `0x${word(1n)}`;
  return `0x${word(0n)}`;
} } });
const EIP712 = [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }];
const fields = (spec: string) => spec.split(',').map(s => ({ type: s.split(' ')[0], name: s.split(' ')[1] }));
const TOKEN = '114687722877560169907772269642416772785020497348544401545773794828418483019030';
const v2 = (o: Record<string, unknown>, exchange = POLYMARKET.v2[0]) => ({
  domain: { name: 'Polymarket CTF Exchange', version: '2', chainId: 137, verifyingContract: exchange }, primaryType: 'Order',
  types: { EIP712Domain: EIP712, Order: fields('uint256 salt,address maker,address signer,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint8 side,uint8 signatureType,uint256 timestamp,bytes32 metadata,bytes32 builder') },
  message: { salt: '1', maker: ALICE, signer: ALICE, tokenId: TOKEN, makerAmount: '5000000', takerAmount: '10000000', side: 0, signatureType: 0, timestamp: String(NOW), metadata: `0x${'0'.repeat(64)}`, builder: `0x${'0'.repeat(64)}`, ...o },
});
const sign = (data: unknown) => previewRequest({ method: 'eth_signTypedData_v4', params: [ALICE, JSON.stringify(data)] }, { now: NOW, chainId: 137 }, deps());

test('A V2 buy: the price, no fee now, no expiry on chain, what can be spent now', async () => {
  const p = await sign(v2({}));
  assert.equal(p.decoding.decoder, 'polymarket_order');
  assert.equal(p.title, 'Buy 10 shares of outcome token 11468772…019030 for 5 pUSD on Polymarket');
  assert.equal(detail(p, 'Price'), '0.5 pUSD a share (at most)');
  assert.equal(detail(p, 'Fee'), "none now (the exchange's maximum fee rate is 0)");
  assert.match(detail(p, 'Expires')!, /^never on chain/);
  assert.equal(detail(p, 'Can be spent now'), '5 pUSD (the permitted amount; you hold 57 pUSD)');
  assert.equal(p.attention, 'none');
});

test('A V2 sell for nothing, a buy above 1 a share, under a cent, another exchange', async () => {
  const nothing = await sign(v2({ side: 1, makerAmount: '40000000', takerAmount: '0' }));
  assert.equal(nothing.warnings.find(w => w.code === 'polymarket_sell_for_nothing')!.severity, 'danger');
  assert.equal(detail(nothing, 'Shares held'), '40 shares');
  assert.equal((await sign(v2({ makerAmount: '12000000', takerAmount: '10000000' }))).warnings.find(w => w.code === 'polymarket_overpay')!.severity, 'danger');
  assert.ok(codes(await sign(v2({ side: 1, makerAmount: '40000000', takerAmount: '100000' }))).includes('polymarket_sell_cheap'));
  assert.ok(codes(await sign(v2({}, '0x2222222222222222222222222222222222222222'))).includes('polymarket_exchange_unknown'));
});

test("The first exchange's orders: no longer traded there; the order book's sign-in", async () => {
  const v1 = { domain: { name: 'Polymarket CTF Exchange', version: '1', chainId: 137, verifyingContract: POLYMARKET.v1[0] }, primaryType: 'Order',
    types: { EIP712Domain: EIP712, Order: fields('uint256 salt,address maker,address signer,address taker,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint256 expiration,uint256 nonce,uint256 feeRateBps,uint8 side,uint8 signatureType') },
    message: { salt: '1', maker: ALICE, signer: ALICE, taker: '0x0000000000000000000000000000000000000000', tokenId: TOKEN, makerAmount: '5000000', takerAmount: '10000000', expiration: '0', nonce: '0', feeRateBps: '0', side: 0, signatureType: 0 } };
  const p = await sign(v1);
  assert.match(p.title, /for 5 USDC\.e on Polymarket$/);
  assert.ok(codes(p).includes('polymarket_legacy_exchange'));
  const auth = await sign({ domain: { name: 'ClobAuthDomain', version: '1', chainId: 137 }, primaryType: 'ClobAuth',
    types: { EIP712Domain: EIP712.slice(0, 3), ClobAuth: fields('address address,string timestamp,uint256 nonce,string message') },
    message: { address: ALICE, timestamp: String(NOW / 1000), nonce: 0, message: 'This message attests that I control the given wallet' } });
  assert.equal(auth.title, "Sign in to Polymarket's order book");
  assert.ok(codes(auth).includes('clob_auth'));
  assert.ok(!codes(auth).includes('clob_auth_message'));
});
