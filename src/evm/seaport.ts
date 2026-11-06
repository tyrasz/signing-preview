// Transactions to Seaport: buying (fulfilling a listing), selling into an offer, sweeping several orders, matching,
// cancelling and validating orders. See src/seaport.ts for how an order reads.
import { decodeFunctionData, parseAbi, type Hex } from 'viem';
import { PreviewBuilder, sameAddress, shortAddress } from '../format.ts';
import { describeFill, describeMatch, describeOrder, orderTerms, resolveCriteria, SEAPORTS, type SeaportItem, type SeaportOrder } from '../seaport.ts';
import { decoded, type Adapter } from './common.ts';

const ABI = parseAbi([
  'struct OfferItem { uint8 itemType; address token; uint256 identifierOrCriteria; uint256 startAmount; uint256 endAmount; }',
  'struct ConsiderationItem { uint8 itemType; address token; uint256 identifierOrCriteria; uint256 startAmount; uint256 endAmount; address recipient; }',
  'struct OrderParameters { address offerer; address zone; OfferItem[] offer; ConsiderationItem[] consideration; uint8 orderType; uint256 startTime; uint256 endTime; bytes32 zoneHash; uint256 salt; bytes32 conduitKey; uint256 totalOriginalConsiderationItems; }',
  'struct OrderComponents { address offerer; address zone; OfferItem[] offer; ConsiderationItem[] consideration; uint8 orderType; uint256 startTime; uint256 endTime; bytes32 zoneHash; uint256 salt; bytes32 conduitKey; uint256 counter; }',
  'struct Order { OrderParameters parameters; bytes signature; }',
  'struct AdvancedOrder { OrderParameters parameters; uint120 numerator; uint120 denominator; bytes signature; bytes extraData; }',
  'struct CriteriaResolver { uint256 orderIndex; uint8 side; uint256 index; uint256 identifier; bytes32[] criteriaProof; }',
  'struct FulfillmentComponent { uint256 orderIndex; uint256 itemIndex; }',
  'struct Fulfillment { FulfillmentComponent[] offerComponents; FulfillmentComponent[] considerationComponents; }',
  'struct AdditionalRecipient { uint256 amount; address recipient; }',
  'struct BasicOrderParameters { address considerationToken; uint256 considerationIdentifier; uint256 considerationAmount; address offerer; address zone; address offerToken; uint256 offerIdentifier; uint256 offerAmount; uint8 basicOrderType; uint256 startTime; uint256 endTime; bytes32 zoneHash; uint256 salt; bytes32 offererConduitKey; bytes32 fulfillerConduitKey; uint256 totalOriginalAdditionalRecipients; AdditionalRecipient[] additionalRecipients; bytes signature; }',
  'function fulfillBasicOrder(BasicOrderParameters parameters) payable returns (bool)',
  'function fulfillBasicOrder_efficient_6GL6yc(BasicOrderParameters parameters) payable returns (bool)',
  'function fulfillOrder(Order order, bytes32 fulfillerConduitKey) payable returns (bool)',
  'function fulfillAdvancedOrder(AdvancedOrder advancedOrder, CriteriaResolver[] criteriaResolvers, bytes32 fulfillerConduitKey, address recipient) payable returns (bool)',
  'function fulfillAvailableOrders(Order[] orders, FulfillmentComponent[][] offerFulfillments, FulfillmentComponent[][] considerationFulfillments, bytes32 fulfillerConduitKey, uint256 maximumFulfilled) payable returns (bool[], bytes)',
  'function fulfillAvailableAdvancedOrders(AdvancedOrder[] advancedOrders, CriteriaResolver[] criteriaResolvers, FulfillmentComponent[][] offerFulfillments, FulfillmentComponent[][] considerationFulfillments, bytes32 fulfillerConduitKey, address recipient, uint256 maximumFulfilled) payable returns (bool[], bytes)',
  'function matchOrders(Order[] orders, Fulfillment[] fulfillments) payable returns (bytes)',
  'function matchAdvancedOrders(AdvancedOrder[] orders, CriteriaResolver[] criteriaResolvers, Fulfillment[] fulfillments, address recipient) payable returns (bytes)',
  'function cancel(OrderComponents[] orders) returns (bool)',
  'function validate(Order[] orders) returns (bool)',
  'function incrementCounter() returns (uint256)',
]);
const MAX_ORDERS = 10;
const ZERO = '0x0000000000000000000000000000000000000000';

type RawItem = { itemType: number; token: string; identifierOrCriteria: bigint; startAmount: bigint; endAmount: bigint; recipient?: string };
type RawOrder = { offerer: string; zone: string; offer: readonly RawItem[]; consideration: readonly RawItem[]; orderType: number; startTime: bigint; endTime: bigint; conduitKey: Hex; counter?: bigint };
const toOrder = (o: RawOrder): SeaportOrder => ({
  offerer: o.offerer.toLowerCase(), zone: o.zone.toLowerCase(), orderType: o.orderType, startTime: o.startTime, endTime: o.endTime, conduitKey: o.conduitKey, counter: o.counter,
  offer: o.offer.map(i => ({ itemType: i.itemType, token: i.token.toLowerCase(), identifierOrCriteria: i.identifierOrCriteria, startAmount: i.startAmount, endAmount: i.endAmount })),
  consideration: o.consideration.map(i => ({ itemType: i.itemType, token: i.token.toLowerCase(), identifierOrCriteria: i.identifierOrCriteria, startAmount: i.startAmount, endAmount: i.endAmount, recipient: (i.recipient ?? ZERO).toLowerCase() })),
});

/**
 * A basic order (one NFT for a native or ERC-20 payment, fees as additional recipients) as a full order. Its type
 * is route × 4 + order type: routes 0-3 sell an NFT for a payment (the fulfiller buys), 4-5 sell a payment for an NFT
 * (an offer: the fulfiller sells, and the fees come out of the payment).
 */
function basicToOrder(p: { considerationToken: string; considerationIdentifier: bigint; considerationAmount: bigint; offerer: string; zone: string; offerToken: string; offerIdentifier: bigint; offerAmount: bigint; basicOrderType: number; startTime: bigint; endTime: bigint; offererConduitKey: Hex; additionalRecipients: readonly { amount: bigint; recipient: string }[] }): SeaportOrder {
  const route = Math.floor(p.basicOrderType / 4), orderType = p.basicOrderType % 4;
  const nftType = route === 0 || route === 2 || route === 4 ? 2 : 3;
  const payType = route <= 1 ? 0 : 1;
  const item = (itemType: number, token: string, id: bigint, amount: bigint, recipient?: string): SeaportItem => ({ itemType, token: token.toLowerCase(), identifierOrCriteria: id, startAmount: amount, endAmount: amount, ...(recipient && { recipient: recipient.toLowerCase() }) });
  const offerer = p.offerer.toLowerCase();
  if (route <= 3) {
    return { offerer, zone: p.zone.toLowerCase(), orderType, startTime: p.startTime, endTime: p.endTime, conduitKey: p.offererConduitKey,
      offer: [item(nftType, p.offerToken, p.offerIdentifier, p.offerAmount)],
      consideration: [item(payType, p.considerationToken, 0n, p.considerationAmount, offerer), ...p.additionalRecipients.map(r => item(payType, p.considerationToken, 0n, r.amount, r.recipient))] };
  }
  // An offer: the offerer pays offerAmount of an ERC-20; the fees are paid out of it, the NFT goes to the offerer.
  return { offerer, zone: p.zone.toLowerCase(), orderType, startTime: p.startTime, endTime: p.endTime, conduitKey: p.offererConduitKey,
    offer: [item(1, p.offerToken, 0n, p.offerAmount - p.additionalRecipients.reduce((s, r) => s + r.amount, 0n))],
    consideration: [item(route === 4 ? 2 : 3, p.considerationToken, p.considerationIdentifier, p.considerationAmount, offerer)] };
}

export const seaportTxAdapter: Adapter = async (tx, env) => {
  const name = tx.to && SEAPORTS[tx.to.toLowerCase()];
  if (!name) return null;
  let call;
  try { call = decodeFunctionData({ abi: ABI, data: tx.data }); } catch { return null; }
  const b = new PreviewBuilder().detail('Marketplace', `${name} (${tx.to})`, tx.to!);
  const e = { deps: env.deps, chainId: tx.chainId };
  const from = tx.from.toLowerCase();
  const recipientCheck = (recipient: string) => {
    if (!sameAddress(recipient, ZERO) && !sameAddress(recipient, from)) {
      b.detail('Items go to', recipient);
      b.warn('caution', 'seaport_recipient', `What you buy goes to ${shortAddress(recipient)}, not to you.`);
    }
  };
  switch (call.functionName) {
    case 'incrementCounter':
      b.warn('info', 'seaport_cancel_all', 'This cancels every Seaport order you have signed so far (listings and offers): their signatures stop working.');
      return decoded({ title: 'Cancel all your Seaport orders', summary: 'Raises your Seaport counter, which invalidates every order you have signed until now.', decoder: 'seaport', status: 'full', b });
    case 'cancel': {
      const orders = call.args[0].map(o => toOrder(o as RawOrder));
      const titles = [];
      for (const [i, o] of orders.slice(0, MAX_ORDERS).entries()) titles.push((await describeOrder(o, from, e, new PreviewBuilder())).title);
      titles.forEach((t, i) => b.detail(`Order ${i + 1}`, t));
      return decoded({ title: orders.length === 1 ? `Cancel a Seaport order (${titles[0]})` : `Cancel ${orders.length} Seaport orders`, summary: 'Cancels the orders, so their signatures can no longer be used.', decoder: 'seaport', status: 'full', b });
    }
    case 'validate': {
      // Validating publishes the orders on-chain: they can then be filled with no signature at all.
      const orders = call.args[0].map(o => toOrder(o.parameters as RawOrder));
      const titles = [];
      for (const [i, o] of orders.slice(0, MAX_ORDERS).entries()) {
        const n = orders.length > 1 ? `Order ${i + 1}` : '';
        titles.push((await describeOrder(o, from, e, b, n)).title);
        orderTerms(o, b, env.context.now ?? Date.now(), n);
      }
      b.warn('info', 'seaport_validate', 'Validating an order publishes it on-chain: anyone can then fill it without a signature, until it expires or you cancel it.');
      return decoded({ title: orders.length === 1 ? `Publish a Seaport order: ${titles[0]}` : `Publish ${orders.length} Seaport orders`, summary: 'Validates the orders on-chain, so they can be filled without your signature.', decoder: 'seaport', status: 'full', b });
    }
    case 'fulfillBasicOrder':
    case 'fulfillBasicOrder_efficient_6GL6yc': {
      const o = basicToOrder(call.args[0] as never);
      const { title } = await describeFill(o, from, e, b);
      return decoded({ title, summary: `Fills a Seaport order from ${shortAddress(o.offerer)}: ${title.charAt(0).toLowerCase()}${title.slice(1)}.`, decoder: 'seaport', status: 'full', b });
    }
    case 'fulfillOrder':
    case 'fulfillAdvancedOrder': {
      const o = toOrder(call.args[0].parameters as RawOrder);
      if (call.functionName === 'fulfillAdvancedOrder') { recipientCheck(call.args[3]); resolveCriteria([o], call.args[1]); }
      const { title } = await describeFill(o, from, e, b);
      return decoded({ title, summary: `Fills a Seaport order from ${shortAddress(o.offerer)}: ${title.charAt(0).toLowerCase()}${title.slice(1)}.`, decoder: 'seaport', status: 'full', b });
    }
    case 'fulfillAvailableOrders':
    case 'fulfillAvailableAdvancedOrders':
    case 'matchOrders':
    case 'matchAdvancedOrders': {
      const orders = (call.args[0] as readonly { parameters: RawOrder }[]).map(r => toOrder(r.parameters));
      if (call.functionName === 'fulfillAvailableAdvancedOrders') { recipientCheck(call.args[5] as string); resolveCriteria(orders, call.args[1] as never); }
      if (call.functionName === 'matchAdvancedOrders') { recipientCheck(call.args[3] as string); resolveCriteria(orders, call.args[1] as never); }
      if (call.functionName.startsWith('match')) {
        const { title } = await describeMatch(orders.slice(0, MAX_ORDERS), from, e, b);
        return decoded({ title, summary: `Matches ${orders.length} Seaport orders in one transaction: ${title.charAt(0).toLowerCase()}${title.slice(1)}.`, decoder: 'seaport', status: 'full', b });
      }
      const titles = [];
      for (const [i, o] of orders.slice(0, MAX_ORDERS).entries()) titles.push((await describeFill(o, from, e, b, orders.length > 1 ? `Order ${i + 1}` : '')).title);
      return decoded({ title: orders.length === 1 ? titles[0] : `Fill ${orders.length} Seaport orders: ${titles.slice(0, 2).join('; ')}${orders.length > 2 ? '; …' : ''}`,
        summary: `Fills ${orders.length} Seaport order${orders.length === 1 ? '' : 's'} in one transaction (a sweep: those already taken are skipped).`, decoder: 'seaport', status: 'full', b });
    }
  }
  return null;
};
