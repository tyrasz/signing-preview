// A swap router on BNB Chain that takes a 0.6% fee (`0xd36b…6deb`, an OpenZeppelin TransparentUpgradeableProxy whose
// implementation's source isn't published). Who runs it isn't known; it carries a large share of BNB Chain's swaps
// from occasional senders (about 0.6% of a sample of all transactions on 2026-11-10). Its entry point takes one struct:
//
//   0x27772d13((address srcToken, address dstToken, uint256 amount, uint256 minReturn, uint256 kind, uint256 feeBps,
//               address feeReceiver, uint256, uint256, bytes, bytes, bytes …))
//
// (the native coin as 0xEeee…EEeE). The layout was read from real calls and checked against their receipts and the
// router's own Swap(sender, srcToken, dstToken, dstReceiver, amount, returnAmount) events (2026-11-19, 200 of the
// latest): in 200 of 200 the sender paid exactly `amount` (as value, or as a token transfer) and received what it
// bought (dstReceiver was the sender in all of them); in 164 of 164 with a token output it received at least
// `minReturn`; with the native coin out, the fee is taken from what the swap returns after `minReturn` is checked
// (in 4 of 36 the sender got less than it), so the least received is `minReturn` less the fee. The two words after
// the fee receiver were zero in all 200: calls where they aren't are left to the other decoders.
import { formatUnits, PreviewBuilder, shortAddress } from '../format.ts';
import { CHAINS } from '../chains.ts';
import type { AssetChange } from '../types.ts';
import { decoded, tokenInfo, tokenSourceWarnings, type Adapter } from './common.ts';

const ROUTER = '0xd36b6d646ac6e23672e9eedec558164c7f2d6deb';
const SELECTOR = '0x27772d13';
const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

export const bscFeeRouterAdapter: Adapter = async (tx, env) => {
  if (tx.chainId !== 56 || !tx.to || tx.to.toLowerCase() !== ROUTER || !tx.data.toLowerCase().startsWith(SELECTOR)) return null;
  const words = tx.data.slice(10).match(/.{64}/g) ?? [];
  if (words.length < 10 || BigInt(`0x${words[0]}`) !== 32n) return null;
  const w = (i: number) => BigInt(`0x${words[i + 1]}`);
  const address = (i: number) => (words[i + 1].startsWith('0'.repeat(24)) ? `0x${words[i + 1].slice(24)}` : null);
  const src = address(0), dst = address(1), feeTo = address(6), amount = w(2), minReturn = w(3), feeBps = w(5);
  if (!src || !dst || !feeTo || w(7) !== 0n || w(8) !== 0n || feeBps >= 10_000n) return null;
  const chain = CHAINS[56];
  const read = async (token: string, raw: bigint) => {
    if (token === NATIVE) return { text: `${formatUnits(raw, chain.nativeDecimals)} ${chain.nativeSymbol}`, change: { amount: formatUnits(raw, chain.nativeDecimals), symbol: chain.nativeSymbol, raw: raw.toString(), asset: 'native', basis: 'requested' as const, standard: 'native' as const }, info: undefined };
    const info = await tokenInfo(env, 56, token);
    return info ? { text: `${formatUnits(raw, info.decimals)} ${info.symbol}`, change: { amount: formatUnits(raw, info.decimals), symbol: info.symbol, raw: raw.toString(), asset: token, basis: 'requested' as const, standard: 'erc20' as const }, info }
      : { text: `${raw} base units of ${shortAddress(token)}`, change: undefined, info };
  };
  // With the native coin out, the fee comes out of what the swap returns after the minimum is checked.
  const least = dst === NATIVE ? minReturn - (minReturn * feeBps) / 10_000n : minReturn;
  const [paid, got] = await Promise.all([read(src, amount), read(dst, least)]);
  const b = new PreviewBuilder().detail('Contract', `Swap router (${ROUTER}), its code unpublished`, ROUTER)
    .detail('You pay', paid.text, src === NATIVE ? undefined : src).detail('You receive at least', got.text, dst === NATIVE ? undefined : dst)
    .detail('Fee', `${formatUnits(feeBps, 2)}% to ${shortAddress(feeTo)}`, feeTo);
  if (src === NATIVE && tx.value !== amount) b.warn('caution', 'value_mismatch', `It swaps ${paid.text} but sends ${formatUnits(tx.value, chain.nativeDecimals)} ${chain.nativeSymbol} with the call.`);
  if (dst !== NATIVE) {
    tokenSourceWarnings(b, 56, got.info);
    if (!got.info) b.warn('caution', 'unknown_token', `The token bought (${dst}) isn't in the known-token list: the minimum is in its units, whatever it is worth.`);
  }
  if (minReturn <= 1n) b.warn('caution', 'no_slippage_limit', 'Nothing limits the price: the minimum received is zero, so the swap would go through at any rate.');
  if (feeBps >= 1000n) b.warn('danger', 'large_fee_portion', `${formatUnits(feeBps, 2)}% of the swap goes to ${feeTo} as a fee. Swap fees are normally well under 1%.`);
  else if (feeBps >= 100n) b.warn('caution', 'large_fee_portion', `${formatUnits(feeBps, 2)}% of the swap goes to ${feeTo} as a fee.`);
  b.note("This router's code isn't published and who runs it isn't known. Its fields were read from the calldata layout, which matched the receipts of real transactions: what you pay, the minimum you receive (to you, the sender) and the fee.");
  const changes: AssetChange[] = [];
  if (paid.change) changes.push({ ...paid.change, direction: 'out', account: tx.from });
  if (got.change) changes.push({ ...got.change, direction: 'in', account: tx.from });
  return decoded({
    title: `Swap ${paid.text} for at least ${got.text} (swap router ${shortAddress(ROUTER)})`,
    summary: `Swaps ${paid.text} for at least ${got.text} through an unpublished swap router, with a ${formatUnits(feeBps, 2)}% fee to ${shortAddress(feeTo)}.`,
    decoder: 'bsc_fee_router', status: 'partial', b, assetChanges: changes,
  });
};
