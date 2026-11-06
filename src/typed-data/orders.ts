// Swap orders signed off-chain and filled by solvers or takers: CoW Protocol (GPv2Order) and 1inch limit orders.
// The signature is the trade: anyone can fill it at its terms until it expires, so the preview states the price and
// who receives the proceeds.
import { formatTimestamp, formatUnits, PreviewBuilder, sameAddress, shortAddress } from '../format.ts';
import { chainName, CHAINS } from '../chains.ts';
import type { AssetChange } from '../types.ts';
import { big, domainChainId, str, type TypedAdapter, type TypedEnv } from './common.ts';
import { canMoveNow } from './exposure.ts';

/** CoW's GPv2VaultRelayer, which pulls sell tokens (GPv2Settlement.vaultRelayer() on Ethereum and Arbitrum One). */
const COW_VAULT_RELAYER = '0xc92e8bdf79f0507f65a392b0ab4667716bfe0110';

const COW_SETTLEMENT = '0x9008d19f58aabd9ed0d60971565aa8510560ab41';
const ONEINCH_V6 = '0x111111125421ca6dc452d289314280a0f8842a65';
const NATIVE = ['0x0000000000000000000000000000000000000000', '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'];

async function amount(env: TypedEnv, chainId: number, token: string, raw: bigint): Promise<{ text: string; symbol?: string; decimals?: number }> {
  const chain = CHAINS[chainId];
  if (NATIVE.includes(token.toLowerCase())) return { text: `${formatUnits(raw, chain?.nativeDecimals ?? 18)} ${chain?.nativeSymbol ?? 'native'}`, symbol: chain?.nativeSymbol, decimals: chain?.nativeDecimals ?? 18 };
  let t;
  try { t = await env.deps.tokens?.get(chainId, token); } catch { t = undefined; }
  return t ? { text: `${formatUnits(raw, t.decimals)} ${t.symbol}`, symbol: t.symbol, decimals: t.decimals } : { text: `${raw} base units of ${shortAddress(token)}` };
}

/** Checks shared by both: the proceeds going to someone else, and a price of nothing. */
function priceChecks(b: PreviewBuilder, owner: string, receiver: string, buyRaw: bigint, sellText: string, protocol: string) {
  if (!sameAddress(receiver, owner)) {
    b.detail('Proceeds go to', receiver);
    b.warn('caution', 'recipient_not_sender', `What this ${protocol} order buys goes to ${shortAddress(receiver)}, not to you: signing it sends your ${sellText} worth to that address.`);
  }
  if (buyRaw === 0n) b.warn('danger', 'order_for_nothing', `This ${protocol} order sells ${sellText} for nothing: anyone can fill it and take the tokens.`);
}

function changes(owner: string, sell: { raw: bigint; token: string; a: Awaited<ReturnType<typeof amount>> }, buy: { raw: bigint; token: string; a: Awaited<ReturnType<typeof amount>> }, toOwner: boolean): AssetChange[] {
  const out: AssetChange[] = [];
  if (sell.a.decimals !== undefined) out.push({ direction: 'out', account: owner, amount: formatUnits(sell.raw, sell.a.decimals), symbol: sell.a.symbol!, raw: sell.raw.toString(), asset: sell.token, basis: 'requested' });
  if (toOwner && buy.a.decimals !== undefined) out.push({ direction: 'in', account: owner, amount: formatUnits(buy.raw, buy.a.decimals), symbol: buy.a.symbol!, raw: buy.raw.toString(), asset: buy.token, basis: 'requested' });
  return out;
}

/** CoW Protocol orders (domain "Gnosis Protocol" v2, the GPv2Settlement contract on every chain). */
export const cowOrderAdapter: TypedAdapter = async (data, env) => {
  if (str(data.domain.name) !== 'Gnosis Protocol' || data.primaryType !== 'Order') return null;
  const chainId = domainChainId(data);
  if (chainId === null) return null;
  const m = data.message;
  const sellToken = str(m.sellToken).toLowerCase(), buyToken = str(m.buyToken).toLowerCase();
  const sellRaw = big(m.sellAmount), buyRaw = big(m.buyAmount), fee = big(m.feeAmount) ?? 0n, validTo = big(m.validTo);
  if (sellRaw === null || buyRaw === null) return null;
  const owner = env.signer ?? '';
  // A zero receiver means the order's owner.
  const receiver = /^0x0{40}$/.test(str(m.receiver)) || !str(m.receiver) ? owner : str(m.receiver).toLowerCase();
  const sell = await amount(env, chainId, sellToken, sellRaw + fee), buy = await amount(env, chainId, buyToken, buyRaw);
  const kind = str(m.kind);
  const b = new PreviewBuilder();
  const contract = str(data.domain.verifyingContract).toLowerCase();
  b.detail('Protocol', `CoW Protocol (${contract})`, contract);
  if (contract !== COW_SETTLEMENT) b.warn('caution', 'unknown_settlement', `${contract} is not CoW Protocol's settlement contract, though the request calls it Gnosis Protocol.`);
  b.detail(kind === 'buy' ? 'You pay at most' : 'You sell', sell.text).detail(kind === 'buy' ? 'You buy' : 'You receive at least', buy.text);
  if (fee > 0n) b.detail('Fee (included above)', (await amount(env, chainId, sellToken, fee)).text);
  if (validTo !== null) b.detail('Valid until', formatTimestamp(Number(validTo) * 1000));
  if (m.partiallyFillable === true) b.detail('Partial fills', 'allowed');
  priceChecks(b, owner, receiver, buyRaw, sell.text, 'CoW');
  if (!NATIVE.includes(sellToken) && sell.decimals !== undefined) await canMoveNow(env, b, chainId, owner, sellToken, { address: sellToken, symbol: sell.symbol!, decimals: sell.decimals }, sellRaw + fee, { address: COW_VAULT_RELAYER, name: "CoW Protocol's vault relayer" });
  b.note('This is an off-chain signature; it costs no gas. CoW Protocol solvers can fill the order at these terms (or better) until it expires.');
  return {
    title: kind === 'buy' ? `Buy ${buy.text} for at most ${sell.text} (CoW Swap)` : `Sell ${sell.text} for at least ${buy.text} (CoW Swap)`,
    summary: `Signs a CoW Protocol order: ${kind === 'buy' ? `buy ${buy.text}, paying at most ${sell.text}` : `sell ${sell.text} for at least ${buy.text}`}${sameAddress(receiver, owner) ? '' : `, paid to ${shortAddress(receiver)}`}.`,
    decoder: 'cow_order', status: sell.decimals !== undefined && buy.decimals !== undefined ? 'full' : 'partial', b, network: { kind: 'evm', chainId, name: chainName(chainId) },
    assetChanges: changes(owner, { raw: sellRaw + fee, token: sellToken, a: sell }, { raw: buyRaw, token: buyToken, a: buy }, sameAddress(receiver, owner)),
  };
};

/** 1inch limit orders (domain "1inch Aggregation Router" v6, filled through the router). */
export const oneInchOrderAdapter: TypedAdapter = async (data, env) => {
  if (str(data.domain.name) !== '1inch Aggregation Router' || data.primaryType !== 'Order') return null;
  const chainId = domainChainId(data);
  if (chainId === null) return null;
  const m = data.message;
  const maker = str(m.maker).toLowerCase(), makerAsset = str(m.makerAsset).toLowerCase(), takerAsset = str(m.takerAsset).toLowerCase();
  const making = big(m.makingAmount), taking = big(m.takingAmount);
  if (making === null || taking === null) return null;
  const receiver = /^0x0{40}$/.test(str(m.receiver)) || !str(m.receiver) ? maker : str(m.receiver).toLowerCase();
  const sell = await amount(env, chainId, makerAsset, making), buy = await amount(env, chainId, takerAsset, taking);
  const b = new PreviewBuilder();
  const contract = str(data.domain.verifyingContract).toLowerCase();
  b.detail('Protocol', `1inch limit order (${contract})`, contract).detail('You sell', sell.text).detail('You receive', buy.text);
  if (contract !== ONEINCH_V6) b.warn('caution', 'unknown_settlement', `${contract} is not 1inch's Aggregation Router v6, though the request calls it that.`);
  if (env.signer && !sameAddress(maker, env.signer)) b.warn('caution', 'order_maker_mismatch', `The order's maker is ${shortAddress(maker)}, not ${shortAddress(env.signer)}, who is asked to sign it.`);
  priceChecks(b, maker, receiver, taking, sell.text, '1inch');
  if (!NATIVE.includes(makerAsset) && sell.decimals !== undefined) await canMoveNow(env, b, chainId, maker, makerAsset, { address: makerAsset, symbol: sell.symbol!, decimals: sell.decimals }, making, { address: ONEINCH_V6, name: "1inch's router" });
  b.note('This is an off-chain signature; it costs no gas. Anyone can fill the order at this price until it expires or you cancel it.');
  return {
    title: `Sell ${sell.text} for ${buy.text} (1inch limit order)`, summary: `Signs a 1inch limit order: ${sell.text} for ${buy.text}${sameAddress(receiver, maker) ? '' : `, paid to ${shortAddress(receiver)}`}.`,
    decoder: 'oneinch_limit_order', status: sell.decimals !== undefined && buy.decimals !== undefined ? 'full' : 'partial', b, network: { kind: 'evm', chainId, name: chainName(chainId) },
    assetChanges: changes(maker, { raw: making, token: makerAsset, a: sell }, { raw: taking, token: takerAsset, a: buy }, sameAddress(receiver, maker)),
  };
};
