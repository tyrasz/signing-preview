// Polymarket on Polygon. Each trade is an Order signed for its CTF Exchange, under the domain "Polymarket CTF Exchange".
// Since 2026-04-28 (Polymarket's exchange upgrade) trading runs on CTF Exchange V2 (version "2": 0xe111…996b, and the
// neg-risk 0xe222…0f59, both verified on Sourcify; and V3, version "3", 0xe333…00aa, not verified, read the same way when
// its order has V2's fields), whose order is (src/exchange/libraries/Structs.sol):
//   Order(uint256 salt,address maker,address signer,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint8 side,
//         uint8 signatureType,uint256 timestamp,bytes32 metadata,bytes32 builder)
// with no expiry and no nonce: it stays fillable until filled, cancelled on Polymarket's order book, or the maker
// pauses (pauseUser, after a block interval). The operator sets each fill's fee, up to the exchange's getMaxFeeRate()
// of the trade's cash value: a buyer pays it on top, a seller from what they get. Collateral is pUSD (getCollateral()),
// shares are ConditionalTokens ERC-1155 positions (getCtf()). The first exchanges (version "1", 0x4bfb…982e and the
// neg-risk 0xc5d5…0f80a, USDC.e collateral) take an order with a taker, an expiration, a nonce and a fee rate; they
// have had no fills since (none in 200,000 blocks to 2026-11-19).
// A BUY gives makerAmount of collateral for takerAmount shares; a SELL gives makerAmount shares for takerAmount of
// collateral. A share pays at most 1. The maker holds the funds: the signer's own account (EOA), its Polymarket proxy
// wallet, its Safe, or (V2) a contract that checks the signature (ERC-1271).
// ClobAuth (domain "ClobAuthDomain" version 1, Polymarket's clob-client) signs in to the order book's API.
import { formatTimestamp, formatUnits, PreviewBuilder, shortAddress } from '../format.ts';
import { chainName } from '../chains.ts';
import type { TokenInfo } from '../types.ts';
import { big, domainChainId, str, type TypedAdapter } from './common.ts';
import { callWords, canMoveNow, pad } from './exposure.ts';

export const POLYMARKET = {
  v1: ['0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e', '0xc5d563a36ae78145c45a50134d48a1215220f80a'],
  v2: ['0xe111180000d2663c0091e4f400237545b87b996b', '0xe2222d279d744050d28e00520010520000310f59', '0xe3333700ca9d93003f00f0f71f8515005f6c00aa'],
  ctf: '0x4d97dcd97ec945f40cf65f87097ace5ea0476045', negRiskAdapter: '0xd91e80cf2e7be2e162c6513ced06f1dd0da35296',
};
const PUSD: TokenInfo = { address: '0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb', symbol: 'pUSD', decimals: 6, name: 'Polymarket USD', source: 'builtin' };
const USDC_E: TokenInfo = { address: '0x2791bca1f2de4661ed88a30c99a7a9449aa84174', symbol: 'USDC.e', decimals: 6, name: 'USD Coin (PoS)', source: 'builtin' };
const V1 = 'uint256 salt,address maker,address signer,address taker,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint256 expiration,uint256 nonce,uint256 feeRateBps,uint8 side,uint8 signatureType';
const V2 = 'uint256 salt,address maker,address signer,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint8 side,uint8 signatureType,uint256 timestamp,bytes32 metadata,bytes32 builder';
const CLOB_MESSAGE = 'This message attests that I control the given wallet';
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO = '0x0000000000000000000000000000000000000000';
const SIGNATURE_TYPES = ['its own key (EOA)', 'its Polymarket proxy wallet', 'its Polymarket Safe', 'a contract that checks the signature (ERC-1271)'];

/** A price per share, to 4 places. */
const price = (cash: bigint, shares: bigint) => shares === 0n ? 'no' : (Number(cash * 1_000_000n / shares) / 1_000_000).toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
const shares = (v: bigint) => `${formatUnits(v, 6)} share${v === 1_000_000n ? '' : 's'}`;

export const polymarketAdapter: TypedAdapter = async (data, env) => {
  const name = str(data.domain.name);
  if (name === 'ClobAuthDomain' && data.primaryType === 'ClobAuth') return clobAuth(data, env);
  const fields = data.types.Order?.map(f => `${f.type} ${f.name}`).join(',');
  if (name !== 'Polymarket CTF Exchange' || data.primaryType !== 'Order' || (fields !== V1 && fields !== V2)) return null;
  const v2 = fields === V2;
  const m = data.message;
  const maker = str(m.maker).toLowerCase(), signer = str(m.signer).toLowerCase(), taker = v2 ? ZERO : str(m.taker).toLowerCase();
  const tokenId = big(m.tokenId), makerAmount = big(m.makerAmount), takerAmount = big(m.takerAmount), side = big(m.side), sigType = big(m.signatureType);
  const expiration = v2 ? 0n : big(m.expiration), nonce = v2 ? 0n : big(m.nonce), feeRate = v2 ? 0n : big(m.feeRateBps), timestamp = v2 ? big(m.timestamp) : 0n;
  if (![maker, signer, taker].every(a => ADDRESS.test(a)) || [tokenId, makerAmount, takerAmount, side, sigType, expiration, nonce, feeRate, timestamp].some(v => v === null) || side! > 1n) return null;
  const chainId = domainChainId(data);
  const network = chainId !== null ? { kind: 'evm' as const, chainId, name: chainName(chainId) } : null;
  const exchange = str(data.domain.verifyingContract).toLowerCase();
  const known = (v2 ? POLYMARKET.v2 : POLYMARKET.v1).includes(exchange);
  const live = known && chainId === 137;
  const collateral = v2 ? PUSD : USDC_E;
  const cash = (v: bigint) => `${formatUnits(v, 6)} ${collateral.symbol}`;
  const b = new PreviewBuilder();
  const buy = side === 0n;
  const cashAmount = buy ? makerAmount! : takerAmount!, shareAmount = buy ? takerAmount! : makerAmount!;
  const each = price(cashAmount, shareAmount);
  const id = tokenId!.toString();
  const outcome = `outcome token ${id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id}`;
  b.detail('Side', buy ? 'buy' : 'sell').detail('Outcome token', id)
    .detail(buy ? 'You pay' : 'You sell', buy ? cash(makerAmount!) : shares(makerAmount!), makerAmount!.toString())
    .detail(buy ? 'You get' : 'You get at least', buy ? shares(takerAmount!) : cash(takerAmount!), takerAmount!.toString())
    .detail('Price', `${each} ${collateral.symbol} a share${buy ? ' (at most)' : ' (at least)'}`)
    .detail('Funds from', `${maker} (${SIGNATURE_TYPES[Number(sigType)] ?? `signature type ${sigType}`})`, maker);
  if (v2) {
    // The fee is the operator's, up to the exchange's maximum rate of the trade's cash value.
    const [maxRate] = live ? await callWords(env, 137, exchange, '0x4a2a11f5') ?? [] : [];
    b.detail('Fee', maxRate === undefined ? `set when it is matched, up to the exchange's maximum rate (5% unless changed), ${buy ? 'paid on top of what you pay' : 'taken from what you get'}` : maxRate === 0n ? 'none now (the exchange\'s maximum fee rate is 0)' : `set when it is matched, up to ${Number(maxRate) / 100}% of the trade, ${buy ? 'paid on top of what you pay' : 'taken from what you get'}`, maxRate?.toString());
    b.detail('Expires', 'never on chain: it stays fillable until filled, cancelled on Polymarket, or you pause trading on the exchange (pauseUser)');
    if (timestamp! > 0n) b.detail('Created', formatTimestamp(Number(timestamp! > 10n ** 12n ? timestamp! : timestamp! * 1000n)), timestamp!.toString());
    const builder = str(m.builder).toLowerCase(), metadata = str(m.metadata).toLowerCase();
    if (/^0x0*[1-9a-f]/.test(builder)) b.detail('Builder code', builder);
    if (/^0x0*[1-9a-f]/.test(metadata)) b.detail('Metadata', metadata);
    if (exchange === POLYMARKET.v2[2]) b.note("It is signed for Polymarket's V3 exchange, whose source isn't verified: it is read as V2's order, whose fields it has.");
  } else {
    b.detail('Fee', `up to ${Number(feeRate) / 100}% of the trade (the rate times the lower of the price and 1 minus it), taken from what you get`, feeRate!.toString())
      .detail('Expires', expiration === 0n ? 'never: it stays fillable until filled or cancelled' : formatTimestamp(Number(expiration) * 1000), expiration!.toString());
    if (taker !== ZERO) b.detail('Only fillable by', taker);
    if (known) b.warn('info', 'polymarket_legacy_exchange', "It is signed for Polymarket's first exchange, which has had no trades since its upgrade of 2026-04-28 (trading moved to CTF Exchange V2): it will most likely never be filled.");
    if (feeRate! > 1000n) b.warn('info', 'polymarket_fee_refused', `Its fee rate, ${Number(feeRate) / 100}%, is above the exchange's 10% maximum: it refuses the order.`);
    if (expiration! > 0n && expiration! * 1000n < BigInt(env.now)) b.warn('info', 'polymarket_expired', 'It has already expired: the exchange refuses it.');
    if (taker !== ZERO) b.warn('info', 'polymarket_private', `Only ${shortAddress(taker)} can fill it.`);
  }
  if (!known) b.warn('caution', 'polymarket_exchange_unknown', `It is signed for ${shortAddress(exchange)}, not one of Polymarket's exchanges: what that contract does with it isn't known here.`);
  if (chainId !== null && chainId !== 137) b.warn('caution', 'polymarket_chain', `It is signed for ${chainName(chainId)}; Polymarket's exchanges are on Polygon.`);
  // A share pays out at most 1: a buy above that loses money whatever happens; a sell for (almost) nothing gives the shares away.
  if (buy && cashAmount > shareAmount) b.warn('danger', 'polymarket_overpay', `It pays ${each} ${collateral.symbol} a share, more than a share can ever pay out (1 ${collateral.symbol}): you lose money whatever the outcome.`);
  if (!buy && takerAmount === 0n) b.warn('danger', 'polymarket_sell_for_nothing', `It sells ${shares(makerAmount!)} for nothing: anyone can take them.`);
  else if (!buy && cashAmount * 100n < shareAmount) b.warn('caution', 'polymarket_sell_cheap', `It sells for ${each} ${collateral.symbol} a share, under a cent: check it is the price you meant.`);
  if (sigType === 0n && maker !== signer) b.warn('info', 'polymarket_signer_mismatch', `It is signed as an EOA order, but its maker (${shortAddress(maker)}) isn't its signer (${shortAddress(signer)}): the exchange refuses it.`);
  if (env.signer && env.signer !== signer) b.warn('caution', 'polymarket_other_signer', `Its signer is ${shortAddress(signer)}, but ${shortAddress(env.signer)} is asked to sign it.`);
  // With Polygon's RPC: whether it can still be filled, and what the maker holds for it.
  if (live) {
    if (v2) {
      const [pausedAt] = await callWords(env, 137, exchange, `0x234d81b9${pad(maker)}`) ?? [];
      if (pausedAt !== undefined && pausedAt > 0n) b.warn('info', 'polymarket_user_paused', `The maker has paused trading on the exchange (from block ${pausedAt}): from then on, the exchange refuses its orders.`);
    } else {
      const [current] = await callWords(env, 137, exchange, `0x7ecebe00${pad(maker)}`) ?? [];
      if (current !== undefined && current !== nonce) b.warn('info', 'polymarket_nonce', current > nonce! ? `Its nonce (${nonce}) is behind the maker's (${current}): it was cancelled with all the maker's orders, and the exchange refuses it.` : `Its nonce (${nonce}) is ahead of the maker's (${current}): the exchange refuses it until the maker raises theirs.`);
    }
    if (buy) await canMoveNow(env, b, 137, maker, collateral.address, collateral, makerAmount!, { address: exchange, name: "Polymarket's exchange" }, 'Can be spent now');
    else {
      const operator = !v2 && exchange === POLYMARKET.v1[1] ? POLYMARKET.negRiskAdapter : exchange;
      const [held] = await callWords(env, 137, POLYMARKET.ctf, `0x00fdd58e${pad(maker)}${pad(tokenId!)}`) ?? [];
      const [approved] = await callWords(env, 137, POLYMARKET.ctf, `0xe985e9c5${pad(maker)}${pad(operator)}`) ?? [];
      if (held !== undefined) b.detail('Shares held', `${shares(held)}${held < makerAmount! ? ` (fewer than it sells: it fills only up to ${shares(held)})` : ''}${approved === 0n ? `; ${operator === exchange ? 'the exchange' : 'the neg-risk adapter'} isn't approved for them yet` : ''}`, held.toString());
    }
  }
  b.note("An order for Polymarket's order book: signing it costs nothing and moves nothing now. Polymarket's operator matches it, partly or whole, and the exchange then moves the funds from the maker.");
  return {
    title: buy ? `Buy ${shares(takerAmount!)} of ${outcome} for ${cash(makerAmount!)} on Polymarket` : `Sell ${shares(makerAmount!)} of ${outcome} for ${cash(takerAmount!)} on Polymarket`,
    summary: `A Polymarket order (CTF Exchange ${v2 ? (exchange === POLYMARKET.v2[2] ? 'V3' : 'V2') : 'V1'}${exchange === POLYMARKET.v2[1] || exchange === POLYMARKET.v1[1] ? ', neg-risk' : ''}): ${buy ? 'buy' : 'sell'} ${shares(shareAmount)} at ${each} ${collateral.symbol} a share${expiration === 0n ? ', until filled or cancelled' : `, until ${formatTimestamp(Number(expiration) * 1000)}`}.`,
    decoder: 'polymarket_order', status: 'full', b, network,
  };
};

/** ClobAuth: proves control of the wallet to Polymarket's order-book API, which then creates or returns its API keys. */
const clobAuth: TypedAdapter = async (data, env) => {
  const m = data.message;
  const b = new PreviewBuilder();
  const address = str(m.address).toLowerCase(), message = str(m.message), timestamp = Number(str(m.timestamp));
  b.detail('Account', address).detail('Message', message);
  if (Number.isFinite(timestamp) && timestamp > 0) b.detail('Signed at', formatTimestamp(timestamp * 1000), String(timestamp));
  if (m.nonce !== undefined) b.detail('Nonce', String(big(m.nonce) ?? str(m.nonce)));
  if (message !== CLOB_MESSAGE) b.warn('caution', 'clob_auth_message', `Its message isn't the one Polymarket's client signs ("${CLOB_MESSAGE}").`);
  if (env.signer && ADDRESS.test(address) && env.signer !== address) b.warn('caution', 'clob_auth_other_account', `It names ${shortAddress(address)}, but ${shortAddress(env.signer)} is asked to sign it.`);
  b.warn('info', 'clob_auth', "Whoever holds this signature, while its timestamp is fresh, can get API keys for your account on Polymarket's order book: they can see and cancel your open orders there, but not trade for you (each order needs its own signature).");
  b.note('A sign-in message: it costs nothing and moves nothing.');
  const chainId = domainChainId(data);
  return { title: "Sign in to Polymarket's order book", summary: `Proves you control ${shortAddress(address)} to Polymarket's order-book API, which then creates or returns its API keys.`, decoder: 'polymarket_clob_auth', status: 'full', b, network: chainId !== null ? { kind: 'evm', chainId, name: chainName(chainId) } : null };
};
