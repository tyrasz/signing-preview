import { formatDecimalString, formatUsd, PreviewBuilder } from '../format.ts';
import type { HyperliquidInfo, SpotToken } from '../types.ts';

export interface ResolvedAsset {
  index: number;
  kind: 'perp' | 'spot' | 'unknown';
  /** Display name, e.g. "BTC-PERP" or "PURR/USDC". */
  name: string;
  /** Key into allMids. */
  midKey: string | null;
  maxLeverage?: number;
}

/** Perp assets use their universe index; spot pairs use 10000 + pair index. */
export async function resolveAsset(info: HyperliquidInfo | undefined, index: number): Promise<ResolvedAsset> {
  const unknown: ResolvedAsset = { index, kind: 'unknown', name: `asset #${index}`, midKey: null };
  if (!info) return unknown;
  try {
    if (index >= 10_000 && index < 100_000) {
      const spot = await info.spotMeta();
      const pair = spot.universe.find(p => p.index === index - 10_000);
      if (!pair) return unknown;
      const [base, quote] = pair.tokens.map(t => spot.tokens.find(token => token.index === t)?.name ?? `token ${t}`);
      return { index, kind: 'spot', name: `${base}/${quote}`, midKey: pair.name };
    }
    if (index < 10_000) {
      const meta = await info.meta();
      const asset = meta.universe[index];
      if (!asset) return unknown;
      return { index, kind: 'perp', name: `${asset.name}-PERP`, midKey: asset.name, maxLeverage: asset.maxLeverage };
    }
  } catch {
    // Metadata unavailable: fall through to the index-only description.
  }
  return unknown;
}

export async function findSpotToken(info: HyperliquidInfo | undefined, match: { index?: number; tokenId?: string; evmContract?: string }): Promise<SpotToken | undefined> {
  if (!info) return undefined;
  try {
    const { tokens } = await info.spotMeta();
    return tokens.find(t =>
      (match.index !== undefined && t.index === match.index) ||
      (match.tokenId !== undefined && t.tokenId.toLowerCase() === match.tokenId.toLowerCase()) ||
      (match.evmContract !== undefined && t.evmContract?.address.toLowerCase() === match.evmContract.toLowerCase()));
  } catch {
    return undefined;
  }
}

export async function midPrice(info: HyperliquidInfo | undefined, asset: ResolvedAsset): Promise<number | null> {
  if (!info || !asset.midKey) return null;
  try {
    const mids = await info.allMids();
    const value = Number(mids[asset.midKey]);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

export interface OrderSpec {
  isBuy: boolean;
  /** Decimal strings, exactly as signed. */
  price: string;
  size: string;
  reduceOnly: boolean;
  /** Human label: "Good til cancelled", "Market (trigger)", … */
  orderType: string;
  /** For trigger orders: trigger price. */
  triggerPrice?: string;
  isMarket?: boolean;
}

const FAR_FROM_MID = 0.05;

/** Describes one order line and adds market-context warnings. Returns the headline. */
export async function describeOrder(b: PreviewBuilder, info: HyperliquidInfo | undefined, asset: ResolvedAsset, order: OrderSpec, prefix = ''): Promise<string> {
  const side = order.isBuy ? (asset.kind === 'perp' ? 'Long' : 'Buy') : (asset.kind === 'perp' ? 'Short' : 'Sell');
  const verb = order.reduceOnly ? `${side} (reduce-only)` : side;
  const headline = order.triggerPrice
    ? `${order.orderType.split(' ')[0] === 'Take' ? 'Take profit' : 'Stop loss'}: ${verb} ${formatDecimalString(order.size)} ${asset.name} ${order.isMarket ? 'at market' : `@ ${formatDecimalString(order.price)}`} when price reaches ${formatDecimalString(order.triggerPrice)}`
    : `${verb} ${formatDecimalString(order.size)} ${asset.name} @ ${formatDecimalString(order.price)}`;
  b.detail(`${prefix}Market`, asset.name, String(asset.index));
  b.detail(`${prefix}Side`, verb);
  b.detail(`${prefix}Size`, formatDecimalString(order.size));
  b.detail(`${prefix}Limit price`, formatDecimalString(order.price));
  if (order.triggerPrice) b.detail(`${prefix}Trigger price`, formatDecimalString(order.triggerPrice));
  b.detail(`${prefix}Order type`, order.orderType);
  const price = Number(order.price), size = Number(order.size);
  if (Number.isFinite(price) && Number.isFinite(size)) b.detail(`${prefix}Notional (approx.)`, formatUsd(price * size));
  if (asset.kind === 'unknown') b.warn('caution', 'unknown_asset', `Asset index ${asset.index} could not be matched to a market, so its name and price can't be checked.`);
  const mid = await midPrice(info, asset);
  if (mid !== null && Number.isFinite(price) && !order.isMarket) {
    b.detail(`${prefix}Current mid price`, formatDecimalString(String(mid)));
    const deviation = (price - mid) / mid;
    const marketable = order.isBuy ? price >= mid : price <= mid;
    if (Math.abs(deviation) > FAR_FROM_MID) {
      const pct = (Math.abs(deviation) * 100).toFixed(1);
      if (marketable && !order.triggerPrice) {
        b.warn('caution', 'price_far_through_market', `The limit price is ${pct}% ${order.isBuy ? 'above' : 'below'} the current mid. It can fill immediately at much worse prices than the mid (Hyperliquid caps slippage, but check this is intended).`);
      } else if (!order.triggerPrice) {
        b.warn('info', 'price_far_from_market', `The limit price is ${pct}% away from the current mid, so the order will probably rest on the book.`);
      }
    }
  }
  return prefix + headline;
}

export const TIF_LABELS: Record<string, string> = {
  Gtc: 'Limit, good til cancelled',
  Ioc: 'Limit, immediate or cancel',
  Alo: 'Limit, add liquidity only (post-only)',
  FrontendMarket: 'Market',
};
