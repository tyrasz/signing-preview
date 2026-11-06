// Seaport order signatures (EIP-712, domain "Seaport"): an OrderComponents is one listing or offer; a BulkOrder is a
// Merkle tree of them, one signature for many listings (OpenSea's "list several items"). See src/seaport.ts.
import { PreviewBuilder } from '../format.ts';
import { chainName } from '../chains.ts';
import { describeOrder, orderTerms, SEAPORTS, type SeaportItem, type SeaportOrder } from '../seaport.ts';
import type { AssetChange } from '../types.ts';
import { big, domainChainId, str, type TypedAdapter, type TypedEnv } from './common.ts';
import { callWords, canMoveNow, pad } from './exposure.ts';
import { collectionLabel } from '../evm/effects.ts';
import { shortAddress } from '../format.ts';

const CONDUIT_CONTROLLER = '0x00000000f9490004c11cef243f5400493c00ad63';
const asAddress = (w: bigint | undefined) => w === undefined ? undefined : `0x${w.toString(16).padStart(40, '0')}`;

/**
 * Whether the order could be filled now: Seaport moves the offer with the approvals the offerer has given its
 * operator (Seaport itself, or the conduit the order names), so each offered item is checked for ownership and that
 * approval; the order's counter must be Seaport's current one for the offerer (incrementCounter cancels all older).
 */
async function fillableNow(o: SeaportOrder, seaport: string, chainId: number, env: TypedEnv, b: PreviewBuilder, p: string): Promise<void> {
  if (!env.deps.rpc?.has(chainId)) return;
  const counter = (await callWords(env, chainId, seaport, `0xf07ec373${pad(o.offerer)}`))?.[0];
  if (counter !== undefined && o.counter !== undefined && o.counter !== counter) b.warn('info', 'seaport_counter_stale', `${p}This order is signed with counter ${o.counter}, but your Seaport counter is ${counter}: ${o.counter < counter ? 'it was cancelled (incrementCounter), so it' : 'it'} can't be filled.`);
  const operator = /^0x0{64}$/.test(o.conduitKey) ? seaport : asAddress((await callWords(env, chainId, CONDUIT_CONTROLLER, `0x6e9bfd9f${pad(o.conduitKey)}`))?.[0]);
  if (!operator || /^0x0{40}$/.test(operator)) return;
  const name = operator === seaport ? 'Seaport' : "the order's conduit";
  for (const [i, it] of o.offer.slice(0, 6).entries()) {
    const label = `${p}${o.offer.length > 1 ? `Item ${i + 1}: ` : ''}can transfer now`;
    if (it.itemType === 1) {
      let info;
      try { info = await env.deps.tokens?.get(chainId, it.token); } catch { info = undefined; }
      await canMoveNow(env, b, chainId, o.offerer, it.token, info ?? undefined, it.startAmount, { address: operator, name }, label);
      continue;
    }
    if (it.itemType < 2) continue;
    const approved = (await callWords(env, chainId, it.token, `0xe985e9c5${pad(o.offerer)}${pad(operator)}`))?.[0];
    const collection = (await collectionLabel(env.deps, chainId, it.token)).label;
    if (it.itemType === 4 || it.itemType === 5) { if (approved !== undefined) b.detail(label, approved ? `any ${collection} you own: ${name} is approved for the collection` : `nothing yet: ${name} isn't approved for ${collection}`); continue; }
    const id = it.identifierOrCriteria;
    let owns: boolean | undefined;
    if (it.itemType === 2) { const owner = asAddress((await callWords(env, chainId, it.token, `0x6352211e${pad(id)}`))?.[0]); owns = owner === undefined ? undefined : owner === o.offerer; }
    else { const held = (await callWords(env, chainId, it.token, `0x00fdd58e${pad(o.offerer)}${pad(id)}`))?.[0]; owns = held === undefined ? undefined : held >= it.startAmount; }
    const single = it.itemType === 2 && !approved ? asAddress((await callWords(env, chainId, it.token, `0x081812fc${pad(id)}`))?.[0]) === operator : false;
    if (owns === undefined || approved === undefined) continue;
    b.detail(label, !owns ? `no: you don't ${it.itemType === 2 ? 'own' : 'hold enough of'} ${collection} #${id}` : approved || single ? `${collection} #${id} (you own it, and ${name} is approved)` : `not yet: ${name} isn't approved for ${collection}, so the order can't be filled until you approve it`);
  }
}

const MAX_ORDERS = 20;

function item(raw: unknown, consideration: boolean): SeaportItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const itemType = big(r.itemType), id = big(r.identifierOrCriteria), start = big(r.startAmount), end = big(r.endAmount);
  if (itemType === null || id === null || start === null || end === null) return null;
  return { itemType: Number(itemType), token: str(r.token).toLowerCase(), identifierOrCriteria: id, startAmount: start, endAmount: end, ...(consideration && { recipient: str(r.recipient).toLowerCase() }) };
}

function order(raw: unknown): SeaportOrder | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.offer) || !Array.isArray(r.consideration)) return null;
  const offer = r.offer.map(i => item(i, false)), consideration = r.consideration.map(i => item(i, true));
  if (offer.some(i => !i) || consideration.some(i => !i)) return null;
  return { offerer: str(r.offerer).toLowerCase(), zone: str(r.zone).toLowerCase(), offer: offer as SeaportItem[], consideration: consideration as SeaportItem[], orderType: Number(big(r.orderType) ?? 0n),
    startTime: big(r.startTime) ?? 0n, endTime: big(r.endTime) ?? 0n, conduitKey: str(r.conduitKey), counter: big(r.counter) ?? undefined };
}

/** A bulk order's leaves: its tree flattened, without the empty orders that pad it to a power of two. */
function leaves(tree: unknown): unknown[] {
  return Array.isArray(tree) ? tree.flatMap(leaves) : [tree];
}

export const seaportAdapter: TypedAdapter = async (data, env) => {
  if (str(data.domain.name) !== 'Seaport' || (data.primaryType !== 'OrderComponents' && data.primaryType !== 'BulkOrder')) return null;
  const chainId = domainChainId(data);
  if (chainId === null) return null;
  const network = { kind: 'evm' as const, chainId, name: chainName(chainId) };
  const raw = data.primaryType === 'BulkOrder' ? leaves((data.message as Record<string, unknown>).tree) : [data.message];
  const orders = raw.map(order).filter((o): o is SeaportOrder => !!o && !(/^0x0{40}$/.test(o.offerer) && !o.offer.length && !o.consideration.length));
  if (!orders.length) return null;
  const b = new PreviewBuilder();
  const contract = str(data.domain.verifyingContract).toLowerCase();
  b.detail('Marketplace', `${SEAPORTS[contract] ?? `Seaport ${str(data.domain.version)}`} (${contract})`, contract);
  if (!SEAPORTS[contract]) b.warn('caution', 'unknown_seaport', `${contract} is not one of Seaport's official deployments, though the request calls it Seaport. An order signed for it may not be what it seems.`);
  b.detail('Offerer', orders[0].offerer);
  const env2 = { deps: env.deps, chainId };
  const bulk = data.primaryType === 'BulkOrder';
  if (bulk) b.detail('Orders in this signature', String(orders.length));
  const summaries = [];
  const assetChanges: AssetChange[] = [];
  for (const [i, o] of orders.slice(0, MAX_ORDERS).entries()) {
    const n = bulk ? `Order ${i + 1}` : '';
    const s = await describeOrder(o, env.signer, env2, b, n);
    orderTerms(o, b, env.now, n);
    if (i < 5) { try { await fillableNow(o, contract, chainId, env, b, n ? `${n}: ` : ''); } catch { /* not checked */ } }
    summaries.push(s);
    assetChanges.push(...s.assetChanges);
  }
  if (orders.length > MAX_ORDERS) b.detail('More orders', String(orders.length - MAX_ORDERS));
  if (bulk && orders.length > 1) b.warn('info', 'seaport_bulk_order', `One signature for ${orders.length} orders: each can be filled on its own until it expires or you cancel it.`);
  b.note("This is an off-chain signature; it costs no gas now. Anyone holding it can fill the order until it expires or you cancel it (Seaport's cancel, or incrementCounter for all your orders at once).");
  const listing = summaries.every(s => s.title.startsWith('List '));
  const title = !bulk || summaries.length === 1 ? summaries[0].title : listing ? `List ${orders.length} items on Seaport` : `Sign ${orders.length} Seaport orders`;
  return {
    title, summary: summaries.length === 1 ? `Signs a Seaport order: you give ${summaries[0].gives.join(', ') || 'nothing'} and receive ${summaries[0].gets.join(', ') || 'nothing'}.`
      : `Signs ${orders.length} Seaport orders at once: ${summaries.slice(0, 3).map(s => s.title).join('; ')}${orders.length > 3 ? '; …' : ''}.`,
    decoder: bulk ? 'seaport_bulk_order' : 'seaport_order', status: 'full', b, network, assetChanges,
  };
};
