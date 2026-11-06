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

test('UniswapX orders inside a Permit2 witness: what the swapper gets at least, fees, and an order that pays nothing', async () => {
  const REACTOR = '0x00000011F84B9aa48e5f8aA8B9897600006289Be', PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
  const order = (outputs: unknown[], swapper = ALICE) => ({
    domain: { name: 'Permit2', chainId: 1, verifyingContract: PERMIT2 },
    types: {
      EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
      PermitWitnessTransferFrom: [{ name: 'permitted', type: 'TokenPermissions' }, { name: 'spender', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'witness', type: 'ExclusiveDutchOrder' }],
      TokenPermissions: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }],
      ExclusiveDutchOrder: [{ name: 'info', type: 'OrderInfo' }, { name: 'decayStartTime', type: 'uint256' }, { name: 'decayEndTime', type: 'uint256' }, { name: 'exclusiveFiller', type: 'address' }, { name: 'exclusivityOverrideBps', type: 'uint256' },
        { name: 'inputToken', type: 'address' }, { name: 'inputStartAmount', type: 'uint256' }, { name: 'inputEndAmount', type: 'uint256' }, { name: 'outputs', type: 'DutchOutput[]' }],
      OrderInfo: [{ name: 'reactor', type: 'address' }, { name: 'swapper', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'additionalValidationContract', type: 'address' }, { name: 'additionalValidationData', type: 'bytes' }],
      DutchOutput: [{ name: 'token', type: 'address' }, { name: 'startAmount', type: 'uint256' }, { name: 'endAmount', type: 'uint256' }, { name: 'recipient', type: 'address' }],
    },
    primaryType: 'PermitWitnessTransferFrom',
    message: { permitted: { token: USDC, amount: '1000000000' }, spender: REACTOR, nonce: '1', deadline: String(Math.floor(NOW / 1000) + 600),
      witness: { info: { reactor: REACTOR, swapper, nonce: '1', deadline: String(Math.floor(NOW / 1000) + 600), additionalValidationContract: ZERO, additionalValidationData: '0x' },
        decayStartTime: '0', decayEndTime: '0', exclusiveFiller: ZERO, exclusivityOverrideBps: '0', inputToken: USDC, inputStartAmount: '1000000000', inputEndAmount: '1000000000', outputs } },
  });
  const p = await sign(order([{ token: WETH, startAmount: '300000000000000000', endAmount: '295000000000000000', recipient: ALICE }, { token: WETH, startAmount: '750000000000000', endAmount: '750000000000000', recipient: '0x000000fee13a103a10d593b9ae06b3e05f2e7e1c' }]));
  assert.equal(p.title, 'Swap 1,000 USDC for at least 0.295 WETH (UniswapX)');
  assert.equal(p.decoding.decoder, 'uniswapx_order');
  assert.match(detail(p, 'Also paid out')!, /^0\.00075 WETH to 0x0000…7e1c$/);
  assert.equal(p.attention, 'none');
  const robbed = await sign(order([{ token: WETH, startAmount: '300000000000000000', endAmount: '300000000000000000', recipient: BOB }]));
  assert.equal(robbed.attention, 'danger');
});
