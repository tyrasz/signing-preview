// Seaport order signatures: listings, offers, bulk listings, and the drainer pattern (giving NFTs for nothing).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previewRequest } from '../src/preview.ts';
import { StaticTokenRegistry } from '../src/chains.ts';
import type { Dependencies, TokenRegistry } from '../src/types.ts';
import { ALICE, BOB } from '../mocks/data.ts';
import { codes, detail, NOW } from './helpers.ts';

const SEAPORT = '0x0000000000000068F116a894984e2DB1123eB395';
const APES = '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d', WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const FEE = '0x0000a26b00c1F0DF003000390027140000fAa719', CONDUIT_KEY = '0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000';
const E = 10n ** 18n;
const tokens: TokenRegistry = { get: (c, a) => new StaticTokenRegistry().get(c, a), collection: async (_c, a) => (a.toLowerCase() === APES ? { symbol: 'BAYC', name: 'BoredApeYachtClub' } : undefined) };
const deps: Dependencies = { tokens };
const TYPES = {
  EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
  OrderComponents: [{ name: 'offerer', type: 'address' }, { name: 'zone', type: 'address' }, { name: 'offer', type: 'OfferItem[]' }, { name: 'consideration', type: 'ConsiderationItem[]' }, { name: 'orderType', type: 'uint8' },
    { name: 'startTime', type: 'uint256' }, { name: 'endTime', type: 'uint256' }, { name: 'zoneHash', type: 'bytes32' }, { name: 'salt', type: 'uint256' }, { name: 'conduitKey', type: 'bytes32' }, { name: 'counter', type: 'uint256' }],
  OfferItem: [{ name: 'itemType', type: 'uint8' }, { name: 'token', type: 'address' }, { name: 'identifierOrCriteria', type: 'uint256' }, { name: 'startAmount', type: 'uint256' }, { name: 'endAmount', type: 'uint256' }],
  ConsiderationItem: [{ name: 'itemType', type: 'uint8' }, { name: 'token', type: 'address' }, { name: 'identifierOrCriteria', type: 'uint256' }, { name: 'startAmount', type: 'uint256' }, { name: 'endAmount', type: 'uint256' }, { name: 'recipient', type: 'address' }],
};
const ZERO = '0x0000000000000000000000000000000000000000';
const nft = (id: number) => ({ itemType: '2', token: APES, identifierOrCriteria: String(id), startAmount: '1', endAmount: '1' });
const eth = (wei: bigint, recipient: string) => ({ itemType: '0', token: ZERO, identifierOrCriteria: '0', startAmount: wei.toString(), endAmount: wei.toString(), recipient });
const start = Math.floor(NOW / 1000), month = 30 * 86_400;
const components = (offer: unknown[], consideration: unknown[], o: Record<string, unknown> = {}) => ({ offerer: ALICE, zone: ZERO, offer, consideration, orderType: '0', startTime: String(start), endTime: String(start + month),
  zoneHash: `0x${'00'.repeat(32)}`, salt: '0x1', conduitKey: CONDUIT_KEY, counter: '0', ...o });
const sign = (message: unknown, primaryType = 'OrderComponents', types: Record<string, unknown> = TYPES, verifyingContract = SEAPORT) =>
  previewRequest({ method: 'eth_signTypedData_v4', params: [ALICE, JSON.stringify({ domain: { name: 'Seaport', version: '1.6', chainId: 1, verifyingContract }, types, primaryType, message })] }, { now: NOW }, deps);

test('An OpenSea listing: the NFT you give, what you receive, and the fee the buyer also pays', async () => {
  const p = await sign(components([nft(42)], [eth(9_750_000_000_000_000_000n, ALICE), eth(250_000_000_000_000_000n, FEE)]));
  assert.equal(p.title, 'List BAYC #42 for 9.75 ETH');
  assert.equal(p.decoding.decoder, 'seaport_order');
  assert.equal(detail(p, 'You give'), 'BAYC #42');
  assert.equal(detail(p, 'You receive'), '9.75 ETH');
  assert.equal(detail(p, 'Also paid by the buyer'), '0.25 ETH to OpenSea fee');
  assert.match(detail(p, 'Marketplace')!, /^Seaport 1\.6/);
  assert.match(detail(p, 'Conduit')!, /^OpenSea conduit/);
  assert.equal(p.attention, 'none');
  assert.deepEqual(p.assetChanges.map(c => `${c.direction} ${c.amount} ${c.symbol}`), ['out 1 BAYC #42', 'in 9.75 ETH']);
});

test('The drainer pattern: NFTs for nothing, or for dust, is danger; payment mostly elsewhere and long validity are cautions', async () => {
  const free = await sign(components([nft(42), nft(43)], [eth(1n, BOB)]));
  assert.equal(free.title, 'Give away BAYC #42 and BAYC #43');
  assert.equal(free.attention, 'danger');
  assert.ok(codes(free).includes('seaport_nothing_in_return'));
  const dust = await sign(components([nft(42)], [eth(1000n, ALICE)]));
  assert.ok(codes(dust).includes('seaport_almost_nothing'));
  const elsewhere = await sign(components([nft(42)], [eth(E / 10n, ALICE), eth(9n * E, BOB)]));
  assert.ok(codes(elsewhere).includes('seaport_payment_elsewhere'));
  const forever = await sign(components([nft(42)], [eth(10n * E, ALICE)], { endTime: ((1n << 256n) - 1n).toString() }));
  assert.ok(codes(forever).includes('long_expiry'));
  assert.ok(codes(await sign(components([nft(42)], [eth(10n * E, ALICE)]), 'OrderComponents', TYPES, BOB)).includes('unknown_seaport'));
});

test('A collection offer: WETH offered for any BAYC', async () => {
  const offer = await sign(components([{ itemType: '1', token: WETH, identifierOrCriteria: '0', startAmount: (5n * E).toString(), endAmount: (5n * E).toString() }],
    [{ itemType: '4', token: APES, identifierOrCriteria: '0', startAmount: '1', endAmount: '1', recipient: ALICE }]));
  assert.equal(offer.title, 'Offer 5 WETH for any BAYC');
  assert.equal(offer.attention, 'none');
});

test('A bulk listing: every order in the tree, padding left out', async () => {
  const empty = components([], [], { offerer: ZERO });
  const tree = [[components([nft(1)], [eth(E, ALICE)]), components([nft(2)], [eth(2n * E, ALICE)])], [components([nft(3)], [eth(3n * E, ALICE)]), empty]];
  const types = { ...TYPES, BulkOrder: [{ name: 'tree', type: 'OrderComponents[2][2]' }] };
  const p = await sign({ tree }, 'BulkOrder', types);
  assert.equal(p.title, 'List 3 items on Seaport');
  assert.equal(detail(p, 'Orders in this signature'), '3');
  assert.equal(detail(p, 'Order 2 gives'), 'BAYC #2');
  assert.ok(codes(p).includes('seaport_bulk_order'));
  // A bulk "listing" that hides one free order is still danger.
  const sneaky = await sign({ tree: [[components([nft(1)], [eth(E, ALICE)]), components([nft(2)], [eth(1n, BOB)])], [empty, empty]] }, 'BulkOrder', types);
  assert.equal(sneaky.attention, 'danger');
  assert.match(sneaky.warnings.find(w => w.code === 'seaport_nothing_in_return')!.message, /^Order 2: /);
});
