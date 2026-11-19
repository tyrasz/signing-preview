// Velora's Delta orders (src/typed-data/orders.ts): a real signed order, and the order's terms.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { recoverAddress } from 'viem';
import { previewRequest } from '../src/preview.ts';
import { StaticTokenRegistry } from '../src/chains.ts';
import { typedDataDigest } from '../src/typed-data/common.ts';
import { ALICE, BOB } from '../mocks/data.ts';
import { codes, detail, NOW } from './helpers.ts';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/velora-delta-arbitrum.json', import.meta.url), 'utf8'));
const USDC = '0xaf88d065e77c8cc2239327c5edb3a432268e5831', WETH = '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', ADAPTER = '0x0000000000bbf5c5fd284e657f01bd000933c96d';
const order = (m: Record<string, unknown> = {}, domain: Record<string, unknown> = {}) => ({
  ...fixture.typedData,
  domain: { ...fixture.typedData.domain, ...domain },
  message: { ...fixture.typedData.message, owner: ALICE, beneficiary: '0x0000000000000000000000000000000000000000', srcToken: USDC, destToken: WETH, srcAmount: '1000000000', destAmount: '300000000000000000', expectedAmount: '310000000000000000', deadline: String(NOW / 1000 + 3600), kind: 0, partnerAndFee: '0', permit: '0x', bridge: { protocolSelector: '0x00000000', destinationChainId: '0', outputToken: '0x0000000000000000000000000000000000000000', scalingFactor: 0, protocolData: '0x' }, ...m },
});
const sign = (data: unknown, signer = ALICE) => previewRequest({ method: 'eth_signTypedData_v4', params: [signer, JSON.stringify(data)] }, { now: NOW, chainId: 42161 }, { tokens: new StaticTokenRegistry() });

test('A real Delta order recovers to its owner over the digest computed here, and reads as its trade', async () => {
  assert.equal((await recoverAddress({ hash: typedDataDigest(fixture.typedData)!, signature: fixture.signature })).toLowerCase(), fixture.owner);
  const p = await previewRequest({ method: 'eth_signTypedData_v4', params: [fixture.owner, JSON.stringify(fixture.typedData)] }, { now: Number(fixture.typedData.message.deadline) * 1000 - 60_000, chainId: 42161 }, { tokens: new StaticTokenRegistry() });
  assert.equal(p.decoding.decoder, 'velora_delta_order');
  assert.match(p.title, /^Sell 27,155\.078957 USDC for at least .* \(Velora Delta\)$/);
  // Its beneficiary is another address: said.
  assert.ok(codes(p).includes('recipient_not_sender'));
});

test('Delta orders: sell and buy, the partner fee taken before the least shown, cross-chain, the adapter, the deadline', async () => {
  const sell = await sign(order());
  assert.equal(sell.title, 'Sell 1,000 USDC for at least 0.3 WETH (Velora Delta)');
  assert.deepEqual(sell.assetChanges.map(c => [c.direction, c.amount, c.symbol]), [['out', '1,000', 'USDC'], ['in', '0.3', 'WETH']]);
  // A 1% partner fee (100 bps, partner in the top 160 bits) comes out of what is returned: at least 0.297 WETH.
  const partner = BigInt(BOB) << 96n;
  const fee = await sign(order({ partnerAndFee: String(partner | 100n) }));
  assert.equal(fee.title, 'Sell 1,000 USDC for at least 0.297 WETH (Velora Delta)');
  assert.match(detail(fee, 'Partner fee') ?? '', /^1% to 0xb0b0…0002/);
  // A buy order: exactly that much, paying at most.
  assert.equal((await sign(order({ kind: 1 }))).title, 'Buy 0.3 WETH for at most 1,000 USDC (Velora Delta)');
  // Bridged to another chain: nothing arrives here.
  const bridged = await sign(order({ bridge: { protocolSelector: '0x2e09f389', destinationChainId: '8453', outputToken: '0x4200000000000000000000000000000000000006', scalingFactor: 0, protocolData: '0x' } }));
  assert.equal(bridged.title, 'Sell 1,000 USDC for at least 0.3 WETH, bridged to Base (Velora Delta)');
  assert.deepEqual(bridged.assetChanges.map(c => c.direction), ['out']);
  // Another verifying contract; an owner other than the signer; past its deadline.
  assert.ok(codes(await sign(order({}, { verifyingContract: BOB }))).includes('unknown_settlement'));
  assert.ok(codes(await sign(order(), BOB)).includes('order_maker_mismatch'));
  assert.ok(codes(await sign(order({ deadline: String(NOW / 1000 - 60) }))).includes('order_expired'));
  assert.equal((await sign(order({}, { verifyingContract: ADAPTER }))).decoding.decoder, 'velora_delta_order');
  // A type other than Delta's isn't read as one.
  const odd = order();
  odd.types = { ...odd.types, Order: odd.types.Order.slice(1) };
  assert.notEqual((await sign(odd)).decoding.decoder, 'velora_delta_order');
});
