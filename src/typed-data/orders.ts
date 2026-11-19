// Swap orders signed off-chain and filled by solvers or takers: CoW Protocol (GPv2Order) and 1inch limit orders.
// The signature is the trade: anyone can fill it at its terms until it expires, so the preview states the price and
// who receives the proceeds.
import { decodeAbiParameters, type Hex } from 'viem';
import { formatTimestamp, formatUnits, PreviewBuilder, sameAddress, shortAddress } from '../format.ts';
import { chainName, CHAINS } from '../chains.ts';
import type { AssetChange, TokenInfo } from '../types.ts';
import { big, domainChainId, str, type TypedAdapter, type TypedDecoded, type TypedEnv } from './common.ts';
import { wrappedNative } from '../evm/universal-router.ts';
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

/**
 * Velora's Delta orders (Portikus v2: the adapter `0x0000…c96d`, the same on every chain here, its modules verified on
 * Sourcify). The owner signs an Order under the domain "Portikus" 2.0.0; an agent settles it (swapSettle), checking
 * the deadline and that it received at least destAmount (a SELL order) before taking fees from what is returned, as
 * FeeManagerLib.processSellFees does: of any surplus over expectedAmount (at most 1% of it with the cap flag), half
 * for the protocol; then the partner's fee in basis points (at most 2%) of what is left, or with no fee and the
 * partner-takes-surplus flag the surplus's other half. What remains goes to the beneficiary (the owner, when zero), or
 * is bridged to it on another chain when the order names one. The settlement can return as little as what destAmount
 * leaves after those fees, so that is the least shown. A BUY order buys exactly destAmount, spending at most
 * srcAmount: its fees come out of what it didn't spend.
 */
const VELORA_ADAPTER = '0x0000000000bbf5c5fd284e657f01bd000933c96d';
const VELORA_ORDER = 'address owner,address beneficiary,address srcToken,address destToken,uint256 srcAmount,uint256 destAmount,uint256 expectedAmount,uint256 deadline,uint8 kind,uint256 nonce,uint256 partnerAndFee,bytes permit,bytes metadata,Bridge bridge';
const VELORA_BRIDGE = 'bytes4 protocolSelector,uint256 destinationChainId,address outputToken,int8 scalingFactor,bytes protocolData';
/** Velora's bridge modules, by the selector an order names (the adapter's getModules()). */
const VELORA_BRIDGES: Record<string, string> = {
  '0x2e09f389': 'Across', '0xb8829306': 'Relay', '0x01d4f1d4': 'CCTP', '0x00d8512c': 'Stargate', '0x66ad5736': 'Mayan', '0x8b64fd5e': 'Celer', '0x47f75fb6': 'Celer', '0xa56f8cff': 'Celer',
  '0x925b1b19': "Arbitrum's bridge", '0xa611c282': "Base's bridge", '0x061066a7': "OP Mainnet's bridge", '0xef55b8ec': "Polygon's bridge", '0x421a5d67': "Unichain's bridge", '0x151e9d94': "Robinhood's bridge",
};
/** Across's multicall handlers (its deployed-addresses list), which forward a deposit to the beneficiary. */
const ACROSS_HANDLERS = ['0x0f7ae28de1c8532170ad4ee566b5801485c13a0e', '0x5e7840e06faccb6d1c3b5f5e0d1d3d07f2829bba', '0x64a43393866dba0044879979faa7ad3d000622e9', '0xdd52f8134f85f3979fba24387ce0cec05937259e', '0xb6caafd8ecf18385ffc7c020327e111a1d40a2d4', '0xeaa13e675fb95821b99d34b9c94c3d60fecadd4a', '0xd7b719ed2b02bfa0247600edd6bd8fb3957e95c8', '0x9ee4300b6af03392be493fa769de33bb07242bfb'];

/** What a SELL order's settlement returns from `received`, after Velora's fees (FeeManagerLib.processSellFees). */
export function veloraSellReturn(received: bigint, expected: bigint, partnerAndFee: bigint): bigint {
  const partner = partnerAndFee >> 96n, bps = (partnerAndFee & 0xffn) > 200n ? 200n : partnerAndFee & 0xffn;
  const takesSurplus = (partnerAndFee & 0x100n) !== 0n, cap = (partnerAndFee & 0x200n) !== 0n;
  let ret = received;
  if (received > expected) {
    let surplus = received - expected;
    if (cap && surplus > (100n * expected) / 10_000n) surplus = (100n * expected) / 10_000n;
    const protocol = (surplus * 5_000n) / 10_000n;
    ret -= protocol;
    if (partner !== 0n) ret -= bps !== 0n ? (ret * bps) / 10_000n : takesSurplus ? surplus - protocol : 0n;
  } else if (partner !== 0n && bps > 0n) ret -= (ret * bps) / 10_000n;
  return ret;
}

/** A Delta order whose values don't read as signers read them: what it would do can't be shown. */
function veloraUnreadable(chainId: number | null): TypedDecoded {
  const b = new PreviewBuilder().detail('Protocol', 'Velora Delta');
  b.warn('danger', 'velora_order_unreadable', "This is a Velora Delta order, but some of its values (an address, an amount, its fee or its bridge) don't read: what it sells, for what and to whom can't be shown. Don't sign it.");
  return { title: "Sign a Velora Delta order that can't be read", summary: "A Velora Delta order whose terms can't be read.", decoder: 'velora_delta_order', status: 'opaque', b, network: chainId !== null ? { kind: 'evm', chainId, name: chainName(chainId) } : null };
}

export const veloraDeltaAdapter: TypedAdapter = async (data, env) => {
  if (str(data.domain.name) !== 'Portikus' || data.primaryType !== 'Order') return null;
  const shape = (t: string) => data.types[t]?.map(f => `${f.type} ${f.name}`).join(',');
  if (shape('Order') !== VELORA_ORDER || shape('Bridge') !== VELORA_BRIDGE) return null;
  const chainId = domainChainId(data);
  if (chainId === null) return veloraUnreadable(null);
  const m = data.message;
  const ADDRESS = /^0x[0-9a-fA-F]{40}$/, HEX = /^0x([0-9a-fA-F]{2})*$/;
  const address = (v: unknown) => (typeof v === 'string' && ADDRESS.test(v) ? v.toLowerCase() : null);
  const owner = address(m.owner), src = address(m.srcToken), dst = address(m.destToken), beneficiaryRaw = address(m.beneficiary);
  const srcRaw = big(m.srcAmount), dstRaw = big(m.destAmount), expected = big(m.expectedAmount), deadline = big(m.deadline), kind = big(m.kind), fee = big(m.partnerAndFee), nonce = big(m.nonce);
  const bridge = (m.bridge && typeof m.bridge === 'object' ? m.bridge : {}) as Record<string, unknown>;
  const destChain = big(bridge.destinationChainId), outputToken = address(bridge.outputToken), selector = str(bridge.protocolSelector).toLowerCase(), protocolData = str(bridge.protocolData), permit = str(m.permit), metadata = str(m.metadata);
  const scaling = typeof bridge.scalingFactor === 'number' ? bridge.scalingFactor : /^-?\d{1,3}$/.test(str(bridge.scalingFactor).trim()) ? Number(str(bridge.scalingFactor).trim()) : NaN;
  // Every value read as signers read it; one that doesn't is no order to show (not one read with a default).
  if (!owner || !src || !dst || !beneficiaryRaw || srcRaw === null || dstRaw === null || expected === null || deadline === null || kind === null || kind > 1n || fee === null || nonce === null
    || destChain === null || !outputToken || !/^0x[0-9a-f]{8}$/.test(selector) || !HEX.test(protocolData) || !HEX.test(permit) || !HEX.test(metadata) || !Number.isInteger(scaling) || scaling < -128 || scaling > 127) return veloraUnreadable(chainId);
  const buy = kind === 1n;
  const beneficiary = /^0x0{40}$/.test(beneficiaryRaw) ? owner : beneficiaryRaw;
  const crossChain = destChain !== 0n && destChain !== BigInt(chainId);
  const partner = `0x${(fee >> 96n).toString(16).padStart(40, '0')}`, hasPartner = !/^0x0{40}$/.test(partner);
  const feeBps = (fee & 0xffn) > 200n ? 200n : fee & 0xffn, takesSurplus = (fee & 0x100n) !== 0n, capSurplus = (fee & 0x200n) !== 0n;
  // The least the settlement can return: destAmount, after the fees taken from it.
  let least = buy ? dstRaw : veloraSellReturn(dstRaw, expected, fee);
  const sell = await amount(env, chainId, src, srcRaw);
  const b = new PreviewBuilder();
  const contract = str(data.domain.verifyingContract).toLowerCase();
  b.detail('Protocol', `Velora Delta (${contract})`, contract);
  if (contract !== VELORA_ADAPTER) b.warn('caution', 'unknown_settlement', `${contract} is not Velora's Delta adapter, though the request is signed for "Portikus".`);
  if (env.signer && !sameAddress(owner, env.signer)) b.warn('caution', 'order_maker_mismatch', `The order's owner is ${shortAddress(owner)}, not ${shortAddress(env.signer)}, who is asked to sign it.`);
  const destName = CHAINS[Number(destChain)]?.name ?? `chain ${destChain}`;
  let status: 'full' | 'partial' = 'full';
  if (crossChain) {
    // What the bridge does with it: Across's terms are read; another bridge's aren't.
    const bridgeName = VELORA_BRIDGES[selector];
    b.detail('Bridged to', `${destName}${bridgeName ? `, through ${bridgeName}` : ''}`, destChain.toString());
    if (selector === '0x00000000') b.note("Which bridge carries it, and its terms, are left to Velora's co-signer when it settles: what is signed is the destination chain and the token there.");
    else if (selector === '0x2e09f389') {
      let handler: string | undefined, maxRelayerFee: bigint | undefined;
      try { [handler, maxRelayerFee] = (decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], protocolData as Hex) as [string, bigint]).map((v, i) => (i === 0 ? String(v).toLowerCase() : v)) as [string, bigint]; } catch { handler = undefined; }
      if (handler === undefined || maxRelayerFee === undefined) { b.warn('caution', 'velora_bridge_unread', "Its bridge terms for Across (protocolData) don't read: what arrives, and where, isn't known here."); status = 'partial'; }
      else {
        // ETH or WETH is deposited to the handler, which forwards it to the beneficiary: another address keeps it.
        const ethLike = NATIVE.includes(dst) || sameAddress(dst, wrappedNative(chainId) ?? '');
        if (!/^0x0{40}$/.test(handler) && !ACROSS_HANDLERS.includes(handler) && ethLike) b.warn('danger', 'velora_bridge_recipient', `Across would pay it on ${destName} to ${handler}, not to the beneficiary: that address isn't one of Across's multicall handlers, which forward it.`);
        const relayerFee = maxRelayerFee > least ? least : maxRelayerFee;
        if (maxRelayerFee > 0n) b.detail('Bridge fee', `up to ${(await amount(env, chainId, dst, maxRelayerFee)).text}, taken before it is bridged`, maxRelayerFee.toString());
        if (maxRelayerFee >= least && least > 0n) b.warn('danger', 'velora_bridge_fee', `The bridge fee it allows (up to ${(await amount(env, chainId, dst, maxRelayerFee)).text}) is as much as what it bridges: nothing need arrive.`);
        least -= relayerFee;
      }
    } else {
      b.warn('caution', 'velora_bridge_unread', `${bridgeName ? `${bridgeName}'s` : 'Its bridge\'s'} terms (signed in the order's protocolData) aren't read here: where it is paid on ${destName}, and what arrives there, depend on them${selector === '0xb8829306' ? ", and on Relay's quote, made off chain" : ''}.`);
      status = 'partial';
    }
    // The amount is converted for the token there by 10^scalingFactor (its decimals less the token's here).
    let there: TokenInfo | undefined;
    try { there = CHAINS[Number(destChain)] && !NATIVE.includes(outputToken) ? (await env.deps.tokens?.get(Number(destChain), outputToken)) ?? undefined : undefined; } catch { there = undefined; }
    const hereDecimals = NATIVE.includes(dst) ? CHAINS[chainId]?.nativeDecimals ?? 18 : (await amount(env, chainId, dst, 0n)).decimals;
    const thereDecimals = NATIVE.includes(outputToken) ? CHAINS[Number(destChain)]?.nativeDecimals ?? 18 : there?.decimals;
    b.detail('Arrives as', NATIVE.includes(outputToken) ? `${CHAINS[Number(destChain)]?.nativeSymbol ?? 'the native coin'} (native coin)` : there ? `${there.symbol} (${outputToken})` : outputToken, outputToken);
    if (hereDecimals !== undefined && thereDecimals !== undefined && scaling !== thereDecimals - hereDecimals) b.warn('danger', 'velora_bridge_scaling', `It converts the amount for ${destName} by 10^${scaling}, but the token there has ${thereDecimals} decimals and the one here ${hereDecimals}: what arrives would be off by a factor of 10^${Math.abs(thereDecimals - hereDecimals - scaling)}.`);
    else if ((hereDecimals === undefined || thereDecimals === undefined) && scaling !== 0) b.warn('caution', 'velora_bridge_scaling', `It converts the amount for ${destName} by 10^${scaling}, which can't be checked against the tokens' decimals here.`);
  }
  const got = await amount(env, chainId, dst, least);
  const where = crossChain ? `, bridged to ${destName}` : '';
  b.detail(buy ? 'You pay at most' : 'You sell', sell.text).detail(buy ? 'You buy' : 'You receive at least', got.text);
  if (!buy) b.detail('Expected', (await amount(env, chainId, dst, expected)).text, expected.toString());
  if (!buy && expected < dstRaw) b.warn('danger', 'velora_expected_below_minimum', `Its expected amount is below its minimum: Velora takes half of anything over the expected amount${hasPartner && (feeBps > 0n || takesSurplus) ? ', and the partner more' : ''}, so of the ${(await amount(env, chainId, dst, dstRaw)).text} minimum you could get only ${got.text}${crossChain ? ' (before the bridge)' : ''}.`);
  if (hasPartner) b.detail('Partner', `${shortAddress(partner)}: ${feeBps > 0n ? `a ${formatUnits(feeBps, 2)}% fee` : takesSurplus ? 'the rest of any surplus over the expected amount' : 'no fee'}${capSurplus ? ' (surplus capped at 1% of the expected amount)' : ''}`, partner);
  if (buy && hasPartner && takesSurplus) b.note('What it saves below the expected spend goes to Velora and the partner, not back to you.');
  if (deadline !== null) b.detail('Valid until', formatTimestamp(Number(deadline < 1n << 47n ? deadline : 1n << 47n) * 1000));
  if (deadline * 1000n < BigInt(env.now)) b.warn('info', 'order_expired', 'Its deadline has passed: the order can no longer be settled.');
  priceChecks(b, owner, beneficiary, buy ? dstRaw : least, sell.text, 'Velora');
  // A permit in the order is how the settlement takes the tokens (directly, or through Permit2): an allowance read
  // now says nothing about that.
  if (permit !== '0x') b.note(`The order carries a permit (${(permit.length - 2) / 2} bytes) that the settlement uses to take the token sold${(permit.length - 2) / 2 === 1 ? ', through Permit2' : ''}, whatever is approved now.`);
  else if (!NATIVE.includes(src) && sell.decimals !== undefined) await canMoveNow(env, b, chainId, owner, src, { address: src, symbol: sell.symbol!, decimals: sell.decimals }, srcRaw, { address: VELORA_ADAPTER, name: "Velora's Delta adapter" });
  b.note("This is an off-chain signature; it costs no gas. Velora's agents can settle the order at these terms (or better) until its deadline; half of any surplus over the expected amount goes to Velora.");
  return {
    title: buy ? `Buy ${got.text}${where} for at most ${sell.text} (Velora Delta)` : `Sell ${sell.text} for at least ${got.text}${where} (Velora Delta)`,
    summary: `Signs a Velora Delta order: ${buy ? `buy ${got.text}${where}, paying at most ${sell.text}` : `sell ${sell.text} for at least ${got.text}${where}`}${sameAddress(beneficiary, owner) ? '' : `, paid to ${shortAddress(beneficiary)}`}.`,
    decoder: 'velora_delta_order', status: sell.decimals !== undefined && got.decimals !== undefined ? status : 'partial', b, network: { kind: 'evm', chainId, name: chainName(chainId) },
    assetChanges: changes(owner, { raw: srcRaw, token: src, a: sell }, { raw: least, token: dst, a: got }, sameAddress(beneficiary, owner) && !crossChain),
  };
};
