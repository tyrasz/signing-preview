// Dollar values for balance changes (src/prices.ts): Chainlink's feeds through the chain's RPC, Hyperliquid's mids on
// HyperEVM, only for the native token and the built-in tokens, by address.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters } from 'viem';
import { addUsdValues, ChainedPrices, CHAINLINK_FEEDS, ChainlinkPrices, HyperliquidPrices, StaticPrices, usdText } from '../src/prices.ts';
import { previewRequest } from '../src/preview.ts';
import { builtinTokens, StaticTokenRegistry } from '../src/chains.ts';
import type { HyperliquidInfo, Preview } from '../src/types.ts';
import { ALICE, BOB } from '../mocks/data.ts';
import { NOW } from './helpers.ts';

const token = (chainId: number, symbol: string) => builtinTokens(chainId).find(t => t.symbol === symbol)!.address.toLowerCase();
const round = (answer: bigint, updatedAt: number) => encodeAbiParameters([{ type: 'uint80' }, { type: 'int256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint80' }], [1n, answer, BigInt(updatedAt), BigInt(updatedAt), 1n]);
const AT = Math.floor(NOW / 1000);

test('Chainlink prices: the native token and built-in tokens by address, through the chain’s own RPC', async () => {
  const asked: string[] = [];
  const answers: Record<string, string> = {
    [CHAINLINK_FEEDS[1]['ETH / USD']]: round(2024_94512741n, AT - 1000),
    [CHAINLINK_FEEDS[1]['USDC / USD']]: round(99977704n, AT - 42_000),
    [CHAINLINK_FEEDS[1]['DAI / USD']]: round(99996500n, AT - 3 * 86_400), // not updated for three days
    [CHAINLINK_FEEDS[1]['USDT / USD']]: round(0n, AT),                     // no answer
    [CHAINLINK_FEEDS[137]['MATIC / USD']]: round(8586755n, AT - 20),
    [CHAINLINK_FEEDS[8453]['BTC / USD']]: round(73040_42346992n, AT - 275),
  };
  const rpc = { has: (c: number) => c !== 10, call: async (_c: number, _m: string, params: unknown[]) => { const to = (params[0] as { to: string }).to; asked.push(to); return answers[to] ?? '0x'; } };
  const prices = new ChainlinkPrices(rpc, { now: () => NOW });
  // The native token, and its wrapper by the same feed, asked once and kept.
  assert.deepEqual(await prices.price(1, 'native'), { usd: 2024.94512741, source: 'Chainlink ETH / USD', updatedAt: AT - 1000 });
  assert.equal((await prices.price(1, token(1, 'WETH')))!.usd, 2024.94512741);
  assert.equal((await prices.price(1, token(1, 'WETH').toUpperCase().replace('0X', '0x')))!.source, 'Chainlink ETH / USD');
  assert.equal(asked.filter(a => a === CHAINLINK_FEEDS[1]['ETH / USD']).length, 1);
  assert.equal((await prices.price(1, token(1, 'USDC')))!.usd, 0.99977704);
  // POL takes the feed still named for MATIC; a wrapped bitcoin takes BTC / USD, and says so.
  assert.deepEqual([(await prices.price(137, 'native'))!.usd, (await prices.price(137, token(137, 'WPOL')))!.source], [0.08586755, 'Chainlink MATIC / USD']);
  assert.deepEqual([(await prices.price(8453, token(8453, 'cbBTC')))!.usd, (await prices.price(8453, token(8453, 'cbBTC')))!.source], [73040.42346992, 'Chainlink BTC / USD']);
  // No price: a token that isn't built in (whatever it calls itself), a stale feed, a feed with no answer, a chain
  // without an RPC, a chain without feeds.
  assert.equal(await prices.price(1, '0x000000000000000000000000000000000000dead'), undefined);
  assert.equal(await prices.price(1, token(1, 'DAI')), undefined);
  assert.equal(await prices.price(1, token(1, 'USDT')), undefined);
  assert.equal(await prices.price(10, 'native'), undefined);
  assert.equal(await prices.price(999, 'native'), undefined);
  // Every feed address is one a built-in token or a native token uses, lowercase.
  for (const feeds of Object.values(CHAINLINK_FEEDS)) for (const a of Object.values(feeds)) assert.match(a, /^0x[0-9a-f]{40}$/);
});

test('Hyperliquid’s mid prices on HyperEVM, and sources tried in order', async () => {
  let calls = 0;
  const info = { allMids: async () => { calls++; return { HYPE: '25.5', BTC: '73000', ETH: '2025', SOL: '0' }; } } as unknown as HyperliquidInfo;
  const hl = new HyperliquidPrices(info);
  assert.deepEqual(await hl.price(999, 'native'), { usd: 25.5, source: 'Hyperliquid HYPE mid price' });
  assert.equal((await hl.price(999, token(999, 'WHYPE')))!.usd, 25.5);
  assert.deepEqual([(await hl.price(999, token(999, 'UBTC')))!.usd, (await hl.price(999, token(999, 'UETH')))!.source], [73000, 'Hyperliquid ETH mid price']);
  assert.deepEqual(await hl.price(999, token(999, 'USDC')), { usd: 1, source: 'USDC, taken as a dollar' });
  // kHYPE isn't HYPE; a coin with no mid has no price; other chains aren't its to price.
  assert.equal(await hl.price(999, token(999, 'kHYPE')), undefined);
  assert.equal(await hl.price(999, token(999, 'USOL')), undefined);
  assert.equal(await hl.price(1, 'native'), undefined);
  assert.equal(calls, 1);
  const chained = new ChainedPrices([new StaticPrices({}), { price: async () => { throw new Error('down'); } }, hl, new StaticPrices({ '999:native': 1 })]);
  assert.equal((await chained.price(999, 'native'))!.usd, 25.5);
  assert.equal(await chained.price(1, 'native'), undefined);
});

test('A preview’s balance changes carry what they are worth now, and a line sums them', async () => {
  assert.deepEqual([usdText(1234.567), usdText(1), usdText(0.004512), usdText(0.5), usdText(1_000_000)], ['1,234.57', '1.00', '0.00451', '0.5', '1,000,000.00']);
  const USDC = token(1, 'USDC'), NFT = '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d', OTHER = '0x000000000000000000000000000000000000beef';
  const change = (c: Partial<Preview['assetChanges'][number]>) => ({ direction: 'out' as const, account: ALICE, amount: '1', symbol: 'X', basis: 'simulated_state' as const, ...c });
  const preview = (): Preview => ({ schema: 'signing-preview/1', method: 'eth_sendTransaction', kind: 'transaction', network: { kind: 'evm', chainId: 1, name: 'Ethereum' }, title: 't', summary: 's', details: [], warnings: [], attention: 'none', decoding: { status: 'full', decoder: 'x', notes: [] },
    assetChanges: [change({ amount: '1,500', symbol: 'USDC', asset: USDC, standard: 'erc20' }), change({ direction: 'in', amount: '0.5', symbol: 'ETH', asset: 'native', standard: 'native' }),
      change({ direction: 'in', amount: '1', symbol: 'BAYC #42', asset: NFT, standard: 'erc721', tokenId: '42' }), change({ direction: 'in', amount: '10', symbol: 'OTHER', asset: OTHER, standard: 'erc20' })] });
  const prices = new StaticPrices({ [`1:${USDC}`]: 0.9998, '1:native': 2000, [`1:${NFT}`]: 99 }, 'a test price');
  const p = await addUsdValues(preview(), { prices });
  assert.deepEqual(p.assetChanges.map(c => [c.symbol, c.usd, c.usdSource]), [['USDC', '1,499.70', 'a test price'], ['ETH', '1,000.00', 'a test price'], ['BAYC #42', undefined, undefined], ['OTHER', undefined, undefined]]);
  // NFTs aren't priced or counted; a token without a price is said to be left out of the sum.
  assert.deepEqual(p.details, [{ label: 'Value now', value: 'out ≈ $1,499.70, in ≈ $1,000.00 (1 asset without a price not counted)' }]);
  // No prices, no network, another kind of network: untouched.
  assert.deepEqual(await addUsdValues(preview(), {}), preview());
  assert.deepEqual((await addUsdValues({ ...preview(), network: null }, { prices })).details, []);
  // A price source that fails or hangs leaves the preview as it is.
  assert.deepEqual((await addUsdValues(preview(), { prices: { price: async () => { throw new Error('down'); } } })).details, []);

  // Through previewRequest: a plain send, and each call of a batch.
  const deps = { tokens: new StaticTokenRegistry(), prices };
  const send = await previewRequest({ method: 'eth_sendTransaction', params: [{ from: ALICE, to: BOB, value: '0x3782dace9d900000', chainId: '0x1' }] }, { now: NOW }, deps);
  assert.deepEqual(send.assetChanges.map(c => [c.amount, c.usd]), [['4', '8,000.00']]);
  assert.equal(send.details.at(-1)!.value, 'out ≈ $8,000.00');
});
