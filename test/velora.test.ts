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
  assert.equal(detail(fee, 'Partner'), '0xb0b0…0002: a 1% fee');
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

test('Tenth review: fees as Velora takes them, the bridge terms read, values read as signed, a permit', async () => {
  const EVIL = '0xba5ed0000000000000000000000000000000beef', partner = BigInt(EVIL) << 96n;
  // An expected amount of 0 with the partner taking the surplus: settled at the minimum, nothing is left for you.
  const drained = await sign(order({ expectedAmount: '0', partnerAndFee: String(partner | 0x100n) }));
  assert.equal(drained.title, 'Sell 1,000 USDC for at least 0 WETH (Velora Delta)');
  assert.ok(drained.warnings.some(w => w.code === 'velora_expected_below_minimum' && w.severity === 'danger'));
  assert.equal(detail(drained, 'Partner'), '0xba5e…beef: the rest of any surplus over the expected amount');
  // With no partner, Velora's half: 0.15 WETH.
  assert.match((await sign(order({ expectedAmount: '0' }))).title, /at least 0\.15 WETH/);
  // Across: a handler that isn't Across's keeps ETH or WETH; a relayer fee as large as the amount; decimals off.
  const across = (handler: string, maxFee: bigint, scalingFactor = 0) => order({ bridge: { protocolSelector: '0x2e09f389', destinationChainId: '8453', outputToken: '0x4200000000000000000000000000000000000006', scalingFactor,
    protocolData: `0x${handler.slice(2).padStart(64, '0')}${maxFee.toString(16).padStart(64, '0')}` } });
  const handled = await sign(across(EVIL, 0n));
  assert.ok(codes(handled).includes('velora_bridge_recipient'));
  assert.ok(!codes(await sign(across('0x0f7ae28de1c8532170ad4ee566b5801485c13a0e', 10n ** 15n))).includes('velora_bridge_recipient'));
  assert.ok(codes(await sign(across('0x0f7ae28de1c8532170ad4ee566b5801485c13a0e', 10n ** 30n))).includes('velora_bridge_fee'));
  assert.ok(codes(await sign(across('0x0f7ae28de1c8532170ad4ee566b5801485c13a0e', 0n, -18))).includes('velora_bridge_scaling'));
  // Another bridge's terms aren't read: said.
  const relay = await sign(order({ bridge: { protocolSelector: '0xb8829306', destinationChainId: '1', outputToken: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', scalingFactor: 0, protocolData: '0x1234' } }));
  assert.ok(codes(relay).includes('velora_bridge_unread'));
  assert.equal(relay.decoding.status, 'partial');
  // Numbers as BigInt reads them (whitespace, as viem signs them): the bridge and the fee aren't lost.
  const spaced = await sign(order({ partnerAndFee: ` ${partner | 200n}`, bridge: { protocolSelector: '0x2e09f389', destinationChainId: ' 8453', outputToken: '0x4200000000000000000000000000000000000006', scalingFactor: 0, protocolData: `0x${'0'.repeat(128)}` } }));
  assert.match(spaced.title, /bridged to Base/);
  assert.equal(detail(spaced, 'Partner'), '0xba5e…beef: a 2% fee');
  // A beneficiary or value that doesn't read is a danger, not the owner.
  const bad = await sign(order({ beneficiary: 'bad000000000000000000000000000000000000bad' }));
  assert.equal(bad.decoding.decoder, 'velora_delta_order');
  assert.ok(bad.warnings.some(w => w.code === 'velora_order_unreadable' && w.severity === 'danger'));
  // A permit in the order is how the settlement takes the token: no allowance check claims otherwise.
  const permitted = await previewRequest({ method: 'eth_signTypedData_v4', params: [ALICE, JSON.stringify(order({ permit: '0x01' }))] }, { now: NOW, chainId: 42161 },
    { tokens: new StaticTokenRegistry(), rpc: { has: () => true, call: async () => `0x${'0'.repeat(64)}` } });
  assert.ok(permitted.decoding.notes.some(n => /carries a permit \(1 bytes\).*through Permit2/.test(n)));
  assert.equal(detail(permitted, 'Can move now'), undefined);
});
