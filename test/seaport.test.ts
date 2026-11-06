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

// Transactions to Seaport, from the side of whoever sends them.
import { encodeFunctionData, parseAbi, type Hex } from 'viem';
const TX_ABI = parseAbi([
  'struct OfferItem { uint8 itemType; address token; uint256 identifierOrCriteria; uint256 startAmount; uint256 endAmount; }',
  'struct ConsiderationItem { uint8 itemType; address token; uint256 identifierOrCriteria; uint256 startAmount; uint256 endAmount; address recipient; }',
  'struct OrderParameters { address offerer; address zone; OfferItem[] offer; ConsiderationItem[] consideration; uint8 orderType; uint256 startTime; uint256 endTime; bytes32 zoneHash; uint256 salt; bytes32 conduitKey; uint256 totalOriginalConsiderationItems; }',
  'struct Order { OrderParameters parameters; bytes signature; }',
  'struct AdditionalRecipient { uint256 amount; address recipient; }',
  'struct BasicOrderParameters { address considerationToken; uint256 considerationIdentifier; uint256 considerationAmount; address offerer; address zone; address offerToken; uint256 offerIdentifier; uint256 offerAmount; uint8 basicOrderType; uint256 startTime; uint256 endTime; bytes32 zoneHash; uint256 salt; bytes32 offererConduitKey; bytes32 fulfillerConduitKey; uint256 totalOriginalAdditionalRecipients; AdditionalRecipient[] additionalRecipients; bytes signature; }',
  'struct Fulfillment { FulfillmentComponent[] offerComponents; FulfillmentComponent[] considerationComponents; }',
  'struct FulfillmentComponent { uint256 orderIndex; uint256 itemIndex; }',
  'function fulfillBasicOrder_efficient_6GL6yc(BasicOrderParameters parameters) payable returns (bool)',
  'function matchOrders(Order[] orders, Fulfillment[] fulfillments) payable returns (bytes)',
  'function validate(Order[] orders) returns (bool)',
  'function incrementCounter() returns (uint256)',
]);
const send = (data: Hex, value = 0n) => previewRequest({ method: 'eth_sendTransaction', params: [{ from: BOB, to: SEAPORT, data, value: `0x${value.toString(16)}`, chainId: '0x1' }] }, { now: NOW }, deps);
const basic = (basicOrderType: number, o: Record<string, unknown>) => encodeFunctionData({ abi: TX_ABI, functionName: 'fulfillBasicOrder_efficient_6GL6yc', args: [{
  considerationToken: ZERO, considerationIdentifier: 0n, considerationAmount: 0n, offerer: ALICE, zone: ZERO, offerToken: APES, offerIdentifier: 42n, offerAmount: 1n, basicOrderType, startTime: BigInt(start), endTime: BigInt(start + month),
  zoneHash: `0x${'00'.repeat(32)}`, salt: 1n, offererConduitKey: CONDUIT_KEY, fulfillerConduitKey: CONDUIT_KEY, totalOriginalAdditionalRecipients: 1n, additionalRecipients: [], signature: '0x', ...o,
} as never] });
const params = (offerer: string, offer: unknown[], consideration: unknown[]) => ({ offerer, zone: ZERO, offer, consideration, orderType: 0, startTime: BigInt(start), endTime: BigInt(start + month), zoneHash: `0x${'00'.repeat(32)}` as Hex, salt: 1n, conduitKey: CONDUIT_KEY as Hex, totalOriginalConsiderationItems: BigInt(consideration.length) });
const item = (itemType: number, token: string, id: bigint, amount: bigint, recipient?: string) => ({ itemType, token, identifierOrCriteria: id, startAmount: amount, endAmount: amount, ...(recipient && { recipient }) });

test('Buying a listing, and selling into an offer, with fees counted', async () => {
  const buy = await send(basic(0, { considerationAmount: 9_750_000_000_000_000_000n, additionalRecipients: [{ amount: 250_000_000_000_000_000n, recipient: FEE }] }), 10n * E);
  assert.equal(buy.title, 'Buy BAYC #42 for 10 ETH');
  assert.equal(detail(buy, 'Net'), '-10 ETH');
  // Route 4 (ERC721_TO_ERC20): ALICE offers 5 WETH for BAYC #42; the fees (0.125 WETH) come out of the offer.
  const sell = await send(basic(16, { considerationToken: APES, considerationIdentifier: 42n, considerationAmount: 1n, offerToken: WETH, offerIdentifier: 0n, offerAmount: 5n * E, additionalRecipients: [{ amount: 125_000_000_000_000_000n, recipient: FEE }] }));
  assert.equal(sell.title, 'Sell BAYC #42 for 4.875 WETH');
});

test('A matched buy is judged as a whole; validating a give-away order and cancelling everything are flagged', async () => {
  // OpenSea's matched buy: BOB's own order offers 2 ETH and asks nothing; the listing sends BAYC #42 to BOB.
  const listing = params(ALICE, [item(2, APES, 42n, 1n)], [item(0, ZERO, 0n, 2n * E, ALICE)]);
  const counter = params(BOB, [item(0, ZERO, 0n, 2n * E)], [item(2, APES, 42n, 1n, BOB)]);
  const m = await send(encodeFunctionData({ abi: TX_ABI, functionName: 'matchOrders', args: [[{ parameters: listing, signature: '0x' }, { parameters: counter, signature: '0x' }] as never, []] }), 2n * E);
  assert.equal(m.title, 'Buy BAYC #42 for 2 ETH');
  assert.ok(!codes(m).includes('seaport_nothing_in_return'));
  // Validating an order that gives BOB's NFT to someone else for nothing: as binding as signing it.
  const giveaway = params(BOB, [item(2, APES, 7n, 1n)], [item(0, ZERO, 0n, 1n, ALICE)]);
  const v = await send(encodeFunctionData({ abi: TX_ABI, functionName: 'validate', args: [[{ parameters: giveaway, signature: '0x' }] as never] }));
  assert.equal(v.attention, 'danger');
  assert.ok(codes(v).includes('seaport_validate'));
  const all = await send(encodeFunctionData({ abi: TX_ABI, functionName: 'incrementCounter' }));
  assert.equal(all.title, 'Cancel all your Seaport orders');
});
