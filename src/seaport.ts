// Seaport (OpenSea's marketplace protocol): what an order gives and takes. An order's offerer gives its `offer`
// items; whoever fills it pays the `consideration` items, each to its own recipient: mostly the offerer, plus the
// marketplace fee and creator royalties. Signing an order is how NFTs are listed and offers are made, and a signed
// order that gives your NFTs for (almost) nothing is how most NFT drainers work, so the preview spells out who gets
// what.
import { formatDuration, formatTimestamp, formatUnits, PreviewBuilder, sameAddress, shortAddress } from './format.ts';
import { CHAINS } from './chains.ts';
import { collectionLabel } from './evm/effects.ts';
import type { AssetChange, Dependencies } from './types.ts';

/** Seaport deployments, at the same address on every chain. */
export const SEAPORTS: Record<string, string> = {
  '0x0000000000000068f116a894984e2db1123eb395': 'Seaport 1.6',
  '0x00000000000000adc04c56bf30ac9d3c0aaf14dc': 'Seaport 1.5',
  '0x00000000000001ad428e4906ae43d8f9852d0dd6': 'Seaport 1.4',
  '0x00000000006c3852cbef3e08e8df289169ede581': 'Seaport 1.1',
};
const KNOWN_RECIPIENTS: Record<string, string> = { '0x0000a26b00c1f0df003000390027140000faa719': 'OpenSea fee' };
const KNOWN_CONDUITS: Record<string, string> = { '0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000': 'OpenSea conduit (0x1E0049783F008A0085193E00003D00cd54003c71)' };
const ORDER_TYPES = ['full, anyone can fill', 'partial fills, anyone can fill', 'full, only through its zone', 'partial fills, only through its zone', 'contract order'];
const ZERO = '0x0000000000000000000000000000000000000000';

/** 0 native, 1 ERC-20, 2 ERC-721, 3 ERC-1155, 4/5 ERC-721/1155 "with criteria" (any token, or any of a set). */
export interface SeaportItem { itemType: number; token: string; identifierOrCriteria: bigint; startAmount: bigint; endAmount: bigint; recipient?: string }
export interface SeaportOrder { offerer: string; zone: string; offer: SeaportItem[]; consideration: SeaportItem[]; orderType: number; startTime: bigint; endTime: bigint; conduitKey: string; counter?: bigint }

const isNft = (i: SeaportItem) => i.itemType >= 2 && i.itemType <= 5;
const isFungible = (i: SeaportItem) => i.itemType === 0 || i.itemType === 1;

interface Env { deps: Dependencies; chainId: number }

/** Formats one item: "1.5 ETH", "250 USDC", "BAYC #42", "3 × Parallel #10", "any BAYC" (a collection offer). */
export async function itemLabel(i: SeaportItem, env: Env): Promise<string> {
  const chain = CHAINS[env.chainId];
  const amount = async (raw: bigint) => {
    if (i.itemType === 0) return `${formatUnits(raw, chain?.nativeDecimals ?? 18)} ${chain?.nativeSymbol ?? 'native'}`;
    let t;
    try { t = await env.deps.tokens?.get(env.chainId, i.token); } catch { t = undefined; }
    return t ? `${formatUnits(raw, t.decimals)} ${t.symbol}` : `${raw} base units of ${shortAddress(i.token)}`;
  };
  if (isFungible(i)) return i.startAmount === i.endAmount ? amount(i.startAmount) : `${await amount(i.startAmount)} → ${await amount(i.endAmount)} over the order's time`;
  const { label } = await collectionLabel(env.deps, env.chainId, i.token);
  const count = i.startAmount === i.endAmount ? i.startAmount : i.endAmount;
  const many = (i.itemType === 3 || i.itemType === 5) && count !== 1n ? `${count} × ` : '';
  if (i.itemType >= 4) return i.identifierOrCriteria === 0n ? `${many}any ${label}` : `${many}one of a set of ${label} tokens`;
  return `${many}${label} #${i.identifierOrCriteria}`;
}

/** Fungible amounts by token ('native' or address). */
function sums(items: SeaportItem[]): Map<string, bigint> {
  const m = new Map<string, bigint>();
  for (const i of items) if (isFungible(i)) { const k = i.itemType === 0 ? 'native' : i.token.toLowerCase(); m.set(k, (m.get(k) ?? 0n) + (i.startAmount > i.endAmount ? i.startAmount : i.endAmount)); }
  return m;
}

async function decimalsOf(token: string, env: Env): Promise<number | undefined> {
  if (token === 'native') return CHAINS[env.chainId]?.nativeDecimals ?? 18;
  try { return (await env.deps.tokens?.get(env.chainId, token))?.decimals; } catch { return undefined; }
}

export interface OrderSummary { title: string; gives: string[]; gets: string[]; assetChanges: AssetChange[] }

/**
 * Details and warnings for one order, from the point of view of `signer` (normally its offerer). `n` numbers the
 * order in a bulk listing.
 */
export async function describeOrder(o: SeaportOrder, signer: string | null, env: Env, b: PreviewBuilder, n = ''): Promise<OrderSummary> {
  const offerer = o.offerer.toLowerCase();
  const toOfferer = o.consideration.filter(i => sameAddress(i.recipient ?? '', offerer));
  const toOthers = o.consideration.filter(i => !sameAddress(i.recipient ?? '', offerer));
  const gives = await Promise.all(o.offer.map(i => itemLabel(i, env)));
  const gets = await Promise.all(toOfferer.map(i => itemLabel(i, env)));
  const p = n ? `${n}: ` : '';
  b.detail(n ? `${n} gives` : 'You give', gives.join(', ') || 'nothing');
  b.detail(n ? `${n} receives` : 'You receive', gets.join(', ') || 'nothing');
  for (const i of toOthers) {
    const who = KNOWN_RECIPIENTS[(i.recipient ?? '').toLowerCase()] ?? shortAddress(i.recipient ?? ZERO);
    b.detail(`${p}Also paid by the buyer`, `${await itemLabel(i, env)} to ${who}`, i.recipient);
  }

  // Giving items away: nothing (or dust) back to the offerer.
  const giving = o.offer.length > 0;
  const back = sums(toOfferer);
  let dust = back.size > 0;
  for (const [token, raw] of back) {
    const d = await decimalsOf(token, env);
    if (d === undefined || raw >= 10n ** BigInt(Math.max(0, d - 6))) dust = false;
  }
  const nftBack = toOfferer.some(isNft);
  if (giving && !toOfferer.length) b.warn('danger', 'seaport_nothing_in_return', `${p}This order gives away ${gives.join(', ')}, and nothing the buyer pays goes to you. Signing an order like this is how NFT drainers take NFTs.`);
  else if (giving && dust && !nftBack) b.warn('danger', 'seaport_almost_nothing', `${p}This order gives ${gives.join(', ')} for ${gets.join(', ')}: almost nothing. Signing an order like this is how NFT drainers take NFTs.`);
  // Most of the payment to others, in the same token.
  const others = sums(toOthers);
  for (const [token, raw] of others) if (raw > (back.get(token) ?? 0n) && back.size) b.warn('caution', 'seaport_payment_elsewhere', `${p}Most of what the buyer pays goes to ${toOthers.map(i => KNOWN_RECIPIENTS[(i.recipient ?? '').toLowerCase()] ?? shortAddress(i.recipient ?? ZERO)).join(', ')}, not to you.`);
  if (o.offer.some(i => i.itemType >= 4)) b.warn('caution', 'seaport_criteria_offer', `${p}The order offers "any" token of a collection: whoever fills it picks which of your tokens to take.`);
  if (signer && !sameAddress(offerer, signer)) b.warn('caution', 'seaport_offerer_mismatch', `${p}The order's offerer is ${shortAddress(offerer)}, not ${shortAddress(signer)}, who is asked to sign it.`);

  const assetChanges: AssetChange[] = [];
  const nftChange = (i: SeaportItem, direction: 'in' | 'out', label: string) => ({ direction, account: offerer, amount: i.itemType === 3 || i.itemType === 5 ? String(i.endAmount) : '1', symbol: label, asset: i.token.toLowerCase(), basis: 'requested' as const, standard: (i.itemType === 2 || i.itemType === 4 ? 'erc721' : 'erc1155') as 'erc721' | 'erc1155', ...(i.itemType < 4 && { tokenId: i.identifierOrCriteria.toString() }) });
  for (const [k, i] of o.offer.entries()) if (isNft(i)) assetChanges.push(nftChange(i, 'out', gives[k]));
  for (const [k, i] of toOfferer.entries()) if (isNft(i)) assetChanges.push(nftChange(i, 'in', gets[k]));
  for (const [dir, list, labels] of [['out', o.offer, gives], ['in', toOfferer, gets]] as const) for (const [k, i] of list.entries()) if (isFungible(i)) {
    const raw = i.startAmount > i.endAmount ? i.startAmount : i.endAmount;
    const d = await decimalsOf(i.itemType === 0 ? 'native' : i.token, env);
    if (d === undefined) continue;
    const symbol = labels[k].replace(/^[\d,.]+ /, '').replace(/ → .*$/, '');
    assetChanges.push({ direction: dir, account: offerer, amount: formatUnits(raw, d), symbol, raw: raw.toString(), asset: i.itemType === 0 ? 'native' : i.token.toLowerCase(), basis: 'requested', standard: i.itemType === 0 ? 'native' : 'erc20' });
  }

  const givesNft = o.offer.some(isNft), givesFungible = o.offer.some(isFungible);
  const list = (xs: string[]) => xs.length <= 2 ? xs.join(' and ') : `${xs.slice(0, 2).join(', ')} and ${xs.length - 2} more`;
  const title = !giving ? `Seaport order: receive ${list(gets)}`
    : !toOfferer.length ? `Give away ${list(gives)}`
      : givesNft && !nftBack ? `List ${list(gives)} for ${list(gets)}`
        : givesFungible && !givesNft && nftBack ? `Offer ${list(gives)} for ${list(gets)}`
          : `Trade ${list(gives)} for ${list(gets)}`;
  return { title, gives, gets, assetChanges };
}

/** Order-wide details: validity, type, zone, conduit, with a caution for orders that stay valid a long time. */
export function orderTerms(o: SeaportOrder, b: PreviewBuilder, now: number, n = '') {
  const p = n ? `${n}: ` : '';
  const end = Number(o.endTime) * 1000;
  b.detail(`${p}Valid`, `${formatTimestamp(Number(o.startTime) * 1000)} → ${o.endTime >= 1n << 40n ? 'never expires' : formatTimestamp(end)}`);
  if (end - now > 180 * 86_400_000) b.warn('caution', 'long_expiry', `${p}This order stays valid ${o.endTime >= 1n << 40n ? 'forever' : `for ${formatDuration(end - now)}`}: anyone holding the signature can fill it until then, unless you cancel it.`);
  else if (end <= now) b.warn('info', 'expired', `${p}This order has already expired and can't be filled.`);
  b.detail(`${p}Order type`, ORDER_TYPES[o.orderType] ?? `unknown (${o.orderType})`);
  if (!sameAddress(o.zone, ZERO)) b.detail(`${p}Zone`, o.zone);
  const conduit = KNOWN_CONDUITS[o.conduitKey.toLowerCase()];
  if (!/^0x0{64}$/.test(o.conduitKey)) b.detail(`${p}Conduit`, conduit ?? o.conduitKey);
}

/**
 * One order from the side of whoever fills it (`fulfiller`): they receive the offer items and provide the
 * consideration items, so per token the net is what the offer gives less what the consideration takes.
 */
export async function describeFill(o: SeaportOrder, fulfiller: string, env: Env, b: PreviewBuilder, n = ''): Promise<{ title: string }> {
  const p = n ? `${n}: ` : '';
  const gets = await Promise.all(o.offer.map(i => itemLabel(i, env)));
  const pays = await Promise.all(o.consideration.map(i => itemLabel(i, env)));
  b.detail(`${p}Seller`, sameAddress(o.offerer, fulfiller) ? `you (${o.offerer})` : o.offerer, o.offerer);
  b.detail(`${p}You get`, gets.join(', ') || 'nothing');
  for (const [k, i] of o.consideration.entries()) {
    const who = sameAddress(i.recipient ?? '', o.offerer) ? 'the seller' : KNOWN_RECIPIENTS[(i.recipient ?? '').toLowerCase()] ?? shortAddress(i.recipient ?? ZERO);
    b.detail(`${p}You provide`, `${pays[k]} to ${who}`, i.recipient);
  }
  const received = sums(o.offer), paid = sums(o.consideration);
  const net: string[] = [];
  for (const token of new Set([...received.keys(), ...paid.keys()])) {
    const d = await decimalsOf(token, env);
    const v = (received.get(token) ?? 0n) - (paid.get(token) ?? 0n);
    if (v === 0n || d === undefined) continue;
    let sym = token === 'native' ? CHAINS[env.chainId]?.nativeSymbol ?? 'native' : shortAddress(token);
    if (token !== 'native') { try { sym = (await env.deps.tokens?.get(env.chainId, token))?.symbol ?? sym; } catch { /* keep the address */ } }
    net.push(`${v < 0n ? '-' : '+'}${formatUnits(v < 0n ? -v : v, d)} ${sym}`);
  }
  if (net.length) b.detail(`${p}Net`, net.join(', '));
  const nftIn = o.offer.filter(isNft), nftOut = o.consideration.filter(isNft);
  const nftLabels = async (xs: SeaportItem[]) => (await Promise.all(xs.map(i => itemLabel(i, env)))).join(', ');
  const fungible = (sign: string) => net.filter(x => x.startsWith(sign)).map(x => x.slice(1)).join(' and ');
  const title = nftIn.length && !nftOut.length ? `Buy ${await nftLabels(nftIn)}${fungible('-') ? ` for ${fungible('-')}` : ''}`
    : nftOut.length && !nftIn.length ? `Sell ${await nftLabels(nftOut)}${fungible('+') ? ` for ${fungible('+')}` : ''}`
      : `Fill a Seaport order: get ${gets.join(', ') || 'nothing'}`;
  return { title };
}

/**
 * Orders matched against each other in one transaction (matchOrders), from `user`'s side: what they give is their
 * own orders' offers, what they get is every consideration item addressed to them, whichever order it is in. (A
 * buyer's own counter-order gives the payment and gets nothing itself: the NFT comes from the listing it matches.)
 */
export async function describeMatch(orders: SeaportOrder[], user: string, env: Env, b: PreviewBuilder): Promise<{ title: string }> {
  const mine = orders.filter(o => sameAddress(o.offerer, user));
  const give = mine.flatMap(o => o.offer);
  const get = orders.flatMap(o => o.consideration.filter(i => sameAddress(i.recipient ?? '', user)));
  const gives = await Promise.all(give.map(i => itemLabel(i, env))), gets = await Promise.all(get.map(i => itemLabel(i, env)));
  b.detail('You give', gives.join(', ') || 'nothing').detail('You get', gets.join(', ') || 'nothing');
  for (const [i, o] of orders.entries()) if (!sameAddress(o.offerer, user)) b.detail(`Order ${i + 1}`, `from ${shortAddress(o.offerer)}: offers ${(await Promise.all(o.offer.map(x => itemLabel(x, env)))).join(', ') || 'nothing'}`, o.offerer);
  if (give.length && !get.length) b.warn('danger', 'seaport_nothing_in_return', `This gives away ${gives.join(', ')}, and nothing in the matched orders comes to you.`);
  const nftIn = get.filter(isNft), nftOut = give.filter(isNft);
  const fungibleGive = gives.filter((_, k) => isFungible(give[k])), fungibleGet = gets.filter((_, k) => isFungible(get[k]));
  const title = nftIn.length && !nftOut.length ? `Buy ${gets.filter((_, k) => isNft(get[k])).join(', ')}${fungibleGive.length ? ` for ${fungibleGive.join(' and ')}` : ''}`
    : nftOut.length && !nftIn.length ? `Sell ${gives.filter((_, k) => isNft(give[k])).join(', ')}${fungibleGet.length ? ` for ${fungibleGet.join(' and ')}` : ''}`
      : `Match ${orders.length} Seaport orders`;
  return { title };
}

/** Applies criteria resolvers: an item offered as "any token" of a collection becomes the token actually chosen. */
export function resolveCriteria(orders: SeaportOrder[], resolvers: readonly { orderIndex: bigint; side: number; index: bigint; identifier: bigint }[]): void {
  for (const r of resolvers) {
    const o = orders[Number(r.orderIndex)];
    const item = o && (r.side === 0 ? o.offer : o.consideration)[Number(r.index)];
    if (item && item.itemType >= 4) { item.itemType -= 2; item.identifierOrCriteria = r.identifier; }
  }
}
