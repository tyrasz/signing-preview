import { formatDecimalString, formatUsd, PreviewBuilder } from '../format.ts';
import type { HyperliquidInfo, SpotToken } from '../types.ts';

export interface ResolvedAsset {
  index: number;
  kind: 'perp' | 'spot' | 'outcome' | 'unknown';
  /** Display name, e.g. "BTC-PERP", "xyz:TSLA-PERP", "PURR/USDC" or an outcome label. */
  name: string;
  /** Key into allMids (for the asset's DEX). */
  midKey: string | null;
  maxLeverage?: number;
  /** HIP-3 builder-deployed perp DEX name (e.g. "xyz"); undefined for the main DEX. */
  dex?: string;
  dexFullName?: string;
  /** Spot pairs: base/quote token names and indices. */
  base?: { name: string; index: number };
  quote?: { name: string; index: number };
  /** Outcome markets: raw description and side, for full fidelity. */
  outcome?: { id: number; side: string; description: string; question?: string };
}

// Asset ID ranges (Hyperliquid; same as @nktkas/hyperliquid's symbol converter):
//   main-DEX perps: universe index (0..9999)
//   spot pairs:     10000 + pair index
//   HIP-3 perps:    100000 + perpDex index * 10000 + index within that DEX's universe
//   outcomes:       100000000 + 10 * outcome + side index
const SPOT_BASE = 10_000, HIP3_BASE = 100_000, OUTCOME_BASE = 100_000_000;

/** Resolves an asset ID to a market name. Unknown IDs stay "asset #N". */
export async function resolveAsset(info: HyperliquidInfo | undefined, index: number): Promise<ResolvedAsset> {
  const unknown: ResolvedAsset = { index, kind: 'unknown', name: `asset #${index}`, midKey: null };
  if (!info || !Number.isSafeInteger(index) || index < 0) return unknown;
  try {
    if (index < SPOT_BASE) {
      const meta = await info.meta();
      const asset = meta.universe[index];
      if (!asset) return unknown;
      return { index, kind: 'perp', name: `${asset.name}-PERP`, midKey: asset.name, maxLeverage: asset.maxLeverage };
    }
    if (index < HIP3_BASE) {
      const spot = await info.spotMeta();
      const pair = spot.universe.find(p => p.index === index - SPOT_BASE);
      if (!pair) return unknown;
      const [base, quote] = pair.tokens.map(t => ({ index: t, name: spot.tokens.find(token => token.index === t)?.name ?? `token ${t}` }));
      return { index, kind: 'spot', name: `${base.name}/${quote.name}`, midKey: pair.name, base, quote };
    }
    if (index < OUTCOME_BASE) {
      if (!info.perpDexs) return unknown;
      const dexIndex = Math.floor((index - HIP3_BASE) / 10_000), local = (index - HIP3_BASE) % 10_000;
      const dex = (await info.perpDexs())[dexIndex];
      if (!dex || dexIndex === 0) return unknown;
      const asset = (await info.meta(dex.name)).universe[local];
      if (!asset) return unknown;
      return { index, kind: 'perp', name: `${asset.name}-PERP`, midKey: asset.name, maxLeverage: asset.maxLeverage, dex: dex.name, dexFullName: dex.fullName };
    }
    if (!info.outcomeMeta) return unknown;
    const n = index - OUTCOME_BASE, outcomeId = Math.floor(n / 10), sideIndex = n % 10;
    const meta = await info.outcomeMeta();
    const outcome = meta.outcomes.find(o => o.outcome === outcomeId);
    const side = outcome?.sideSpecs[sideIndex];
    if (!outcome || !side) return unknown;
    const question = meta.questions.find(q => q.namedOutcomes.includes(outcomeId));
    const qFields = parseSpec(question?.description ?? ''), oFields = parseSpec(outcome.description);
    const sideName = templateText(side.name, { ...qFields, ...oFields });
    const bucket = question ? question.namedOutcomes.indexOf(outcomeId) : -1;
    return { index, kind: 'outcome', name: `${outcomeLabel(outcome.name, oFields, question ? { name: question.name, fields: qFields } : undefined, bucket)}: ${sideName}`, midKey: `#${n}`,
      outcome: { id: outcomeId, side: sideName, description: outcome.description, question: question?.description } };
  } catch {
    // Metadata unavailable: fall through to the index-only description.
  }
  return unknown;
}

/** Parses "key:value|key:value" market specs (values may contain ':'). */
function parseSpec(spec: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of spec.split('|')) {
    const i = part.indexOf(':');
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

/** "template:{shortNameA}" -> participant A; "template:Yes" -> "Yes". */
function templateText(text: string, fields: Record<string, string>): string {
  return text.replace(/^template:/, '')
    .replace('{shortNameA}', fields.shortNameA ?? fields.participantA ?? 'A')
    .replace('{shortNameB}', fields.shortNameB ?? fields.participantB ?? 'B');
}

const when = (t?: string) => t && /^\d{8}-\d{4}$/.test(t) ? `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)} ${t.slice(9, 11)}:${t.slice(11, 13)}` : t;
const humanize = (name: string) => name.replace(/^template:/, '').replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/^./, c => c.toUpperCase());

/**
 * A faithful label from the market's structured fields. Only the recurring price classes have
 * semantics defined by the SDK ("above", price ranges); other templates are listed, not interpreted.
 * For multi-outcome questions the label names both the question and this outcome.
 */
function outcomeLabel(name: string, o: Record<string, string>, question: { name: string; fields: Record<string, string> } | undefined, bucket: number): string {
  const q = question?.fields ?? {};
  const f = { ...q, ...o };
  if (f.class === 'priceBinary' && f.underlying && f.targetPrice) return `${f.underlying} above ${f.targetPrice} at ${when(f.expiry)}`;
  if (f.class === 'priceBucket' && f.underlying && f.priceThresholds) {
    const [lo, hi] = f.priceThresholds.split(',');
    const range = bucket === 0 ? `below ${lo}` : bucket === 1 ? `${lo} to ${hi}` : `above ${hi}`;
    return `${f.underlying} price ${range} at ${when(f.expiry)}`;
  }
  const subject = (x: Record<string, string>) => x.participantA && x.participantB ? `${x.participantA} vs ${x.participantB}` : x.participant ?? x.company ?? x.perp ?? x.underlying ?? x.institution;
  const extra = (x: Record<string, string>) => [x.threshold && `threshold ${x.threshold}`, x.target && `target ${x.target}`, x.line && `line ${x.line}`, x.marketCapThresholdB && `${x.marketCapThresholdB}B market cap`, x.decisionLabel, when(x.time ?? x.dateTime ?? x.expiry ?? x.scheduledStart)].filter(Boolean).join(', ');
  const part = (label: string, x: Record<string, string>) => { const sub = subject(x), ex = extra(x); return sub || ex ? `${label} (${[sub, ex].filter(Boolean).join('; ')})` : label; };
  if (question && !question.name.startsWith('Recurring')) {
    const outcomeName = subject(o) ?? (extra(o) || humanize(name));
    return `${part(humanize(question.name), q)} · ${outcomeName}`;
  }
  return part(humanize(name), o) || 'Outcome market';
}

export async function findSpotToken(info: HyperliquidInfo | undefined, match: { index?: number; tokenId?: string; evmContract?: string; name?: string }): Promise<SpotToken | undefined> {
  if (!info) return undefined;
  try {
    const { tokens } = await info.spotMeta();
    return tokens.find(t =>
      (match.index !== undefined && t.index === match.index) ||
      (match.tokenId !== undefined && t.tokenId.toLowerCase() === match.tokenId.toLowerCase()) ||
      (match.evmContract !== undefined && t.evmContract?.address.toLowerCase() === match.evmContract.toLowerCase()) ||
      (match.name !== undefined && t.name === match.name));
  } catch {
    return undefined;
  }
}

export async function midPrice(info: HyperliquidInfo | undefined, asset: ResolvedAsset): Promise<number | null> {
  if (!info || !asset.midKey) return null;
  try {
    const mids = await info.allMids(asset.dex);
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
  if (asset.dex) {
    b.detail(`${prefix}Perp DEX`, `${asset.dexFullName ?? asset.dex} (builder-deployed, HIP-3)`, asset.dex);
    b.warn('info', 'hip3_market', `${asset.name} is on ${asset.dexFullName ?? asset.dex}, a builder-deployed (HIP-3) perp DEX. Its deployer sets the oracle, leverage limits and fees, and it has its own margin account.`);
  }
  if (asset.outcome) {
    b.detail(`${prefix}Market type`, 'Outcome (prediction) market; the price is the implied probability (0 to 1)');
    b.detail(`${prefix}Market spec`, asset.outcome.question ? `${asset.outcome.question} | ${asset.outcome.description}` : asset.outcome.description || '(none)');
  }
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
