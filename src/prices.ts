// What a balance change is worth in dollars, now.
//
// Prices come from where no one else learns what is being previewed: Chainlink's price feeds, read through the
// chain's own RPC (the one the simulation already uses), and on HyperEVM Hyperliquid's mid prices, from the /info API
// the previewer reads anyway. Only the native token and the built-in tokens (src/chains.ts: addresses checked
// on-chain) are priced, each by its address: a token is never priced by the name it gives itself, so a fake "USDC"
// gets no dollar value. A wrapped or bridged token takes its underlying's feed (WETH: ETH / USD; cbBTC: BTC / USD),
// and the source says which. Anything else has no price here; a wallet with a price service of its own can pass
// one as Dependencies.prices.
import { decodeAbiParameters, type Hex } from 'viem';
import { builtinTokens } from './chains.ts';
import { TtlCache, type RpcClient } from './rpc.ts';
import type { AssetChange, Dependencies, HyperliquidInfo, Preview, Price, PriceSource } from './types.ts';

/**
 * Chainlink price feeds (the aggregator proxies), by chain and pair. Each was read on its chain on 2026-11-10: its
 * description() is the pair named here, its decimals() 8, its latest answer a plausible price.
 */
export const CHAINLINK_FEEDS: Record<number, Record<string, string>> = {
  1: { 'ETH / USD': '0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419', 'BTC / USD': '0xf4030086522a5beea4988f8ca5b36dbc97bee88c', 'USDC / USD': '0x8fffffd4afb6115b954bd326cbe7b4ba576818f6', 'USDT / USD': '0x3e7d1eab13ad0104d2750b8863b489d65364e32d', 'DAI / USD': '0xaed0c38402a5d19df6e4c03f4e2dced6e29c1ee9' },
  42161: { 'ETH / USD': '0x639fe6ab55c921f74e7fac1ee960c0b6293ba612', 'BTC / USD': '0x6ce185860a4963106506c203335a2910413708e9', 'USDC / USD': '0x50834f3163758fcc1df9973b6e91f0f0f0434ad3', 'USDT / USD': '0x3f3f5df88dc9f13eac63df89ec16ef6e7e25dde7', 'DAI / USD': '0xc5c8e77b397e531b8ec06bfb0048328b30e9ecfb' },
  8453: { 'ETH / USD': '0x71041dddad3595f9ced3dccfbe3d1f4b0a16bb70', 'BTC / USD': '0x64c911996d3c6ac71f9b455b1e8e7266bcbd848f', 'USDC / USD': '0x7e860098f58bbfc8648a4311b374b1d669a2bc6b', 'USDT / USD': '0xf19d560eb8d2adf07bd6d13ed03e1d11215721f9', 'DAI / USD': '0x591e79239a7d679378ec8c847e5038150364c78f' },
  10: { 'ETH / USD': '0x13e3ee699d1909e989722e753853ae30b17e08c5', 'BTC / USD': '0xd702dd976fb76fffc2d3963d037dfdae5b04e593', 'USDC / USD': '0x16a9fa2fda030272ce99b29cf780dfa30361e0f3', 'USDT / USD': '0xecef79e109e997bca29c1c0897ec9d7b03647f5e', 'DAI / USD': '0x8dba75e83da73cc766a7e5a0ee71f656bab470d6', 'OP / USD': '0x0d276fc14719f9292d5c1ea2198673d1f4269246' },
  137: { 'ETH / USD': '0xf9680d99d6c9589e2a93a78a04a279e509205945', 'BTC / USD': '0xc907e116054ad103354f2d350fd2514433d57f6f', 'USDC / USD': '0xfe4a8cc5b5b2366c1b58bea3858e81843581b2f7', 'USDT / USD': '0x0a6513e40db6eb1b165753ad52e80663aea50545', 'DAI / USD': '0x4746dec9e833a82ec7c2c1356372ccf2cfcd2f3d', 'MATIC / USD': '0xab594600376ec9fd91f8e885dadf0ce036862de0' },
  56: { 'ETH / USD': '0x9ef1b8c0e4f7dc8bf5719ea496883dc6401d5b2e', 'BTC / USD': '0x264990fbd0a4796a3e3d8e37c4d5f87a3aca5ebf', 'USDC / USD': '0x51597f405303c4377e36123cbc172b13269ea163', 'USDT / USD': '0xb97ad0e74fa7d920791e90258a6e2085088b4320', 'DAI / USD': '0x132d3c0b1d2cea0bc552588063bdbb210fdeecfa', 'BNB / USD': '0x0567f2323251f0aab15c8dfb1967e4e8a7d42aee' },
};
/** Each chain's native token's pair (POL's feed is still named for MATIC, which it replaced one for one). */
const NATIVE_PAIR: Record<number, string> = { 1: 'ETH / USD', 42161: 'ETH / USD', 8453: 'ETH / USD', 10: 'ETH / USD', 137: 'MATIC / USD', 56: 'BNB / USD' };
/** The built-in tokens' pairs, by the symbol the built-in list gives them (never a symbol read from a contract). */
const SYMBOL_PAIR: Record<string, string> = {
  WETH: 'ETH / USD', ETH: 'ETH / USD', USDC: 'USDC / USD', 'USDC.e': 'USDC / USD', USDbC: 'USDC / USD', USDT: 'USDT / USD', 'USD₮0': 'USDT / USD', USDT0: 'USDT / USD',
  DAI: 'DAI / USD', cbBTC: 'BTC / USD', BTCB: 'BTC / USD', WBTC: 'BTC / USD', WPOL: 'MATIC / USD', WBNB: 'BNB / USD', OP: 'OP / USD',
};
/** A feed not updated for this long isn't used (stablecoin feeds update once a day unless the price moves). */
const MAX_AGE_SECONDS = 2 * 86_400;

/** The pair that prices an asset on a chain (the native token, or a built-in token by its address), if any. */
function pairOf(chainId: number, asset: string): string | undefined {
  if (asset === 'native') return NATIVE_PAIR[chainId];
  const token = builtinTokens(chainId).find(t => t.address.toLowerCase() === asset.toLowerCase());
  const pair = token && SYMBOL_PAIR[token.symbol];
  return pair && CHAINLINK_FEEDS[chainId]?.[pair] ? pair : undefined;
}

/** Prices from Chainlink's feeds, read with eth_call on the chain's own RPC and kept for a minute. */
export class ChainlinkPrices implements PriceSource {
  private rpc: RpcClient;
  private cache = new TtlCache<Promise<Price | undefined>>();
  private now: () => number;
  constructor(rpc: RpcClient, options: { now?: () => number } = {}) { this.rpc = rpc; this.now = options.now ?? Date.now; }
  price(chainId: number, asset: string): Promise<Price | undefined> {
    const pair = pairOf(chainId, asset), feed = pair && CHAINLINK_FEEDS[chainId]?.[pair];
    if (!pair || !feed || !this.rpc.has(chainId)) return Promise.resolve(undefined);
    const key = `${chainId}:${feed}`, hit = this.cache.get(key);
    if (hit) return hit;
    const value = (async (): Promise<Price | undefined> => {
      try {
        // latestRoundData(): (roundId, answer, startedAt, updatedAt, answeredInRound); every feed here has 8 decimals.
        const out = String(await this.rpc.call(chainId, 'eth_call', [{ to: feed, data: '0xfeaf968c' }, 'latest'])) as Hex;
        const [, answer, , updatedAt] = decodeAbiParameters([{ type: 'uint80' }, { type: 'int256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint80' }], out);
        if (answer <= 0n || this.now() / 1000 - Number(updatedAt) > MAX_AGE_SECONDS) return undefined;
        return { usd: Number(answer) / 1e8, source: `Chainlink ${pair}`, updatedAt: Number(updatedAt) };
      } catch { return undefined; }
    })();
    this.cache.set(key, value, 60_000);
    return value;
  }
}

/** HyperEVM's tokens that Hyperliquid quotes: the native HYPE and its wrapper, and the bridged assets, by their coin there. */
const HYPERLIQUID_COINS: Record<string, string> = { native: 'HYPE', WHYPE: 'HYPE', UBTC: 'BTC', UETH: 'ETH', USOL: 'SOL' };
/** Prices on HyperEVM from Hyperliquid's mid prices (in USDC, its quote currency, taken as dollars); USDC itself is 1. */
export class HyperliquidPrices implements PriceSource {
  private info: HyperliquidInfo;
  private cache = new TtlCache<Promise<Record<string, string>>>();
  constructor(info: HyperliquidInfo) { this.info = info; }
  async price(chainId: number, asset: string): Promise<Price | undefined> {
    if (chainId !== 999) return undefined;
    const symbol = asset === 'native' ? 'native' : builtinTokens(chainId).find(t => t.address.toLowerCase() === asset.toLowerCase())?.symbol;
    if (symbol === 'USDC') return { usd: 1, source: 'USDC, taken as a dollar' };
    const coin = symbol && HYPERLIQUID_COINS[symbol];
    if (!coin) return undefined;
    try {
      let mids = this.cache.get('mids');
      if (!mids) { mids = this.info.allMids(); this.cache.set('mids', mids, 30_000); }
      const mid = Number((await mids)[coin]);
      return mid > 0 ? { usd: mid, source: `Hyperliquid ${coin} mid price` } : undefined;
    } catch { return undefined; }
  }
}

/** Fixed prices by `${chainId}:${asset}` (asset: 'native' or a token address): for tests and mock data. */
export class StaticPrices implements PriceSource {
  private map: Map<string, number>;
  private source: string;
  constructor(prices: Record<string, number>, source = 'a fixed price') { this.map = new Map(Object.entries(prices).map(([k, v]) => [k.toLowerCase(), v])); this.source = source; }
  async price(chainId: number, asset: string): Promise<Price | undefined> {
    const usd = this.map.get(`${chainId}:${asset.toLowerCase()}`);
    return usd === undefined ? undefined : { usd, source: this.source };
  }
}

/** The first source that has a price. */
export class ChainedPrices implements PriceSource {
  private sources: PriceSource[];
  constructor(sources: PriceSource[]) { this.sources = sources; }
  async price(chainId: number, asset: string): Promise<Price | undefined> {
    for (const s of this.sources) {
      try { const p = await s.price(chainId, asset); if (p) return p; } catch { /* the next */ }
    }
    return undefined;
  }
}

/** Dollars as text: cents above a dollar, three significant digits below. */
export function usdText(v: number): string {
  if (v >= 1) return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (v <= 0) return '0.00';
  return Number(v.toPrecision(3)).toString();
}

/** How long a preview waits for prices in all. */
const PRICE_BUDGET_MS = 2500;

/**
 * Adds what each fungible balance change is worth (AssetChange.usd, from its formatted amount and the asset's
 * price) to a preview and its batch calls, and a "Value now" line when something was priced. A preview on a chain
 * without prices, or of assets that have none, is left as it is; so is one whose prices don't come in time.
 */
export async function addUsdValues(preview: Preview, deps: Dependencies): Promise<Preview> {
  const prices = deps.prices, network = preview.network;
  if (!prices || !network || network.kind !== 'evm') return preview;
  const chainId = network.chainId;
  const priced = async (c: AssetChange): Promise<void> => {
    if (!c.asset || c.standard === 'erc721' || c.standard === 'erc1155') return;
    const amount = Number(c.amount.replace(/,/g, ''));
    if (!Number.isFinite(amount) || amount <= 0) return;
    const p = await prices.price(chainId, c.asset);
    if (!p || closed) return; // a price that comes after the wait isn't added: the sum below wouldn't count it
    worth.set(c, amount * p.usd);
    c.usd = usdText(amount * p.usd);
    c.usdSource = p.source;
  };
  const worth = new Map<AssetChange, number>();
  let closed = false;
  const all = [preview, ...(preview.calls ?? [])];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([Promise.all(all.flatMap(p => p.assetChanges.map(c => priced(c).catch(() => undefined)))), new Promise<void>(r => { timer = setTimeout(r, PRICE_BUDGET_MS); (timer as { unref?: () => void }).unref?.(); })]);
  } finally { clearTimeout(timer); closed = true; }
  for (const p of all) {
    const fungible = p.assetChanges.filter(c => c.standard !== 'erc721' && c.standard !== 'erc1155');
    const withPrice = fungible.filter(c => worth.has(c));
    if (!withPrice.length) continue;
    const total = (direction: 'out' | 'in') => withPrice.filter(c => c.direction === direction).reduce((sum, c) => sum + worth.get(c)!, 0);
    const out = total('out'), inn = total('in');
    const parts = [out > 0 && `out ≈ $${usdText(out)}`, inn > 0 && `in ≈ $${usdText(inn)}`].filter(Boolean);
    const unpriced = fungible.length - withPrice.length;
    p.details.push({ label: 'Value now', value: `${parts.join(', ')}${unpriced ? ` (${unpriced} asset${unpriced === 1 ? '' : 's'} without a price not counted)` : ''}` });
  }
  return preview;
}
