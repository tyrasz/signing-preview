// CoW Protocol and 1inch limit orders: signatures that are trades.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previewRequest } from '../src/preview.ts';
import { StaticTokenRegistry } from '../src/chains.ts';
import { ALICE, BOB } from '../mocks/data.ts';
import { codes, detail, NOW } from './helpers.ts';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', ZERO = '0x0000000000000000000000000000000000000000';
const DOMAIN = [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }];
const sign = (data: unknown) => previewRequest({ method: 'eth_signTypedData_v4', params: [ALICE, JSON.stringify(data)] }, { now: NOW }, { tokens: new StaticTokenRegistry() });

const cow = (m: Record<string, unknown> = {}) => ({
  domain: { name: 'Gnosis Protocol', version: 'v2', chainId: 1, verifyingContract: '0x9008D19f58AAbD9eD0D60971565AA8510560ab41' },
  types: { EIP712Domain: DOMAIN, Order: [{ name: 'sellToken', type: 'address' }, { name: 'buyToken', type: 'address' }, { name: 'receiver', type: 'address' }, { name: 'sellAmount', type: 'uint256' }, { name: 'buyAmount', type: 'uint256' },
    { name: 'validTo', type: 'uint32' }, { name: 'appData', type: 'bytes32' }, { name: 'feeAmount', type: 'uint256' }, { name: 'kind', type: 'string' }, { name: 'partiallyFillable', type: 'bool' }, { name: 'sellTokenBalance', type: 'string' }, { name: 'buyTokenBalance', type: 'string' }] },
  primaryType: 'Order',
  message: { sellToken: USDC, buyToken: WETH, receiver: ZERO, sellAmount: '1000000000', buyAmount: '300000000000000000', validTo: String(Math.floor(NOW / 1000) + 1800), appData: `0x${'00'.repeat(32)}`, feeAmount: '0', kind: 'sell', partiallyFillable: false, sellTokenBalance: 'erc20', buyTokenBalance: 'erc20', ...m },
});

test('CoW Swap orders: the trade, proceeds sent elsewhere, and a price of nothing', async () => {
  const p = await sign(cow());
  assert.equal(p.title, 'Sell 1,000 USDC for at least 0.3 WETH (CoW Swap)');
  assert.equal(p.attention, 'none');
  assert.deepEqual(p.assetChanges.map(c => `${c.direction} ${c.amount} ${c.symbol}`), ['out 1,000 USDC', 'in 0.3 WETH']);
  const buy = await sign(cow({ kind: 'buy' }));
  assert.equal(buy.title, 'Buy 0.3 WETH for at most 1,000 USDC (CoW Swap)');
  const elsewhere = await sign(cow({ receiver: BOB }));
  assert.ok(codes(elsewhere).includes('recipient_not_sender'));
  assert.equal(detail(elsewhere, 'Proceeds go to'), BOB);
  assert.equal((await sign(cow({ buyAmount: '0' }))).attention, 'danger');
});

test('1inch limit orders: the price, and an order for nothing', async () => {
  const order = (m: Record<string, unknown> = {}) => ({
    domain: { name: '1inch Aggregation Router', version: '6', chainId: 1, verifyingContract: '0x111111125421cA6dc452d289314280a0f8842A65' },
    types: { EIP712Domain: DOMAIN, Order: [{ name: 'salt', type: 'uint256' }, { name: 'maker', type: 'address' }, { name: 'receiver', type: 'address' }, { name: 'makerAsset', type: 'address' }, { name: 'takerAsset', type: 'address' },
      { name: 'makingAmount', type: 'uint256' }, { name: 'takingAmount', type: 'uint256' }, { name: 'makerTraits', type: 'uint256' }] },
    primaryType: 'Order',
    message: { salt: '1', maker: ALICE, receiver: ZERO, makerAsset: WETH, takerAsset: USDC, makingAmount: '1000000000000000000', takingAmount: '3500000000', makerTraits: '0', ...m },
  });
  const p = await sign(order());
  assert.equal(p.title, 'Sell 1 WETH for 3,500 USDC (1inch limit order)');
  assert.equal(p.attention, 'none');
  assert.ok(codes(await sign(order({ takingAmount: '0' }))).includes('order_for_nothing'));
  assert.ok(codes(await sign(order({ maker: BOB }))).includes('order_maker_mismatch'));
});
