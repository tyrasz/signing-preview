// Binance Web3 Wallet's swap and bridge router: an EIP-2535 diamond whose facet's source isn't published (the diamond
// itself is verified on Sourcify; its storage namespace is "com.binance.w3w.diamond.storage"). Its one entry point
// wraps an aggregator call (LI.FI, 1inch, a bridge, Binance's own router) in the trade's own terms:
//
//   0x810c705b(address feeReceiver, address target, bytes32 tokenInAndFlags, uint256 amountIn,
//              uint256 feeBpsAndTokenOut, uint256 minOut, bytes data)
//
// The layout was read from real calls and checked against their receipts (Ethereum, 2026-11-06): in 56 of 56 the
// sender paid exactly amountIn of the token in the low 20 bytes of the third word (ETH when zero, as msg.value); in
// 28 of 28 swaps with a token output the sender received at least minOut of the token in the low 160 bits of the
// fifth word; and the bits above it are a fee in basis points of the output, paid to feeReceiver (50 bps in 5 of 5).
// A zero fifth word means no output on this chain: a bridge, read from the wrapped aggregator call.
import { decodeAbiParameters, type Hex } from 'viem';
import { formatUnits, PreviewBuilder, shortAddress } from '../format.ts';
import { CHAINS } from '../chains.ts';
import type { AssetChange } from '../types.ts';
import { decoded, tokenInfo, type Adapter, type AdapterEnv } from './common.ts';
import { decodeTransaction } from './transaction.ts';

const ROUTER = '0xb300000b72deaeb607a12d5f54773d1c19c7028d';
const SELECTOR = '0x810c705b';
/** Only Ethereum's facet was checked against receipts; Arbitrum's diamond has different facet code. */
const CHAIN_IDS = [1];
const LOW160 = (1n << 160n) - 1n;
const isZero = (a: string) => /^0x0{40}$/.test(a);

async function asset(env: AdapterEnv, chainId: number, token: string, raw: bigint): Promise<{ text: string; change?: Omit<AssetChange, 'direction' | 'account'> }> {
  const chain = CHAINS[chainId];
  if (isZero(token)) {
    const decimals = chain?.nativeDecimals ?? 18, symbol = chain?.nativeSymbol ?? 'ETH';
    return { text: `${formatUnits(raw, decimals)} ${symbol}`, change: { amount: formatUnits(raw, decimals), symbol, raw: raw.toString(), asset: 'native', basis: 'requested', standard: 'native' } };
  }
  const t = await tokenInfo(env, chainId, token);
  return t ? { text: `${formatUnits(raw, t.decimals)} ${t.symbol}`, change: { amount: formatUnits(raw, t.decimals), symbol: t.symbol, raw: raw.toString(), asset: token, basis: 'requested', standard: 'erc20' } }
    : { text: `${raw} base units of ${shortAddress(token)}` };
}

export const binanceWalletAdapter: Adapter = async (tx, env) => {
  if (!tx.to || tx.to.toLowerCase() !== ROUTER || !CHAIN_IDS.includes(tx.chainId) || !tx.data.toLowerCase().startsWith(SELECTOR)) return null;
  let args: readonly unknown[];
  try { args = decodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }], `0x${tx.data.slice(10)}`); } catch { return null; }
  const [feeReceiver, target, tokenWord, amountIn, outWord, minOut, data] = args as [string, string, Hex, bigint, bigint, bigint, Hex];
  const tokenIn = `0x${tokenWord.slice(26)}`.toLowerCase();
  const tokenOut = `0x${(outWord & LOW160).toString(16).padStart(40, '0')}`, feeBps = outWord >> 160n;
  const paid = await asset(env, tx.chainId, tokenIn, amountIn);
  const b = new PreviewBuilder().detail('Contract', `Binance Web3 Wallet router (${ROUTER})`, ROUTER).detail('You pay', paid.text, isZero(tokenIn) ? undefined : tokenIn);
  // The wrapped call, as the aggregator would read it from you (its recipient checks then apply to you).
  const inner = await decodeTransaction({ chainId: tx.chainId, from: tx.from, to: target.toLowerCase(), data, value: isZero(tokenIn) ? amountIn : 0n }, env.deps, env.context);
  b.detail('Route', `${inner.title} (${shortAddress(target.toLowerCase())})`, target.toLowerCase());
  b.note("Binance hasn't published this router's code. Its fields were read from the calldata layout, which matched the receipts of real transactions: what you pay, the minimum you receive and the fee.");
  const changes: AssetChange[] = paid.change ? [{ ...paid.change, direction: 'out', account: tx.from }] : [];

  // No output token and no minimum: nothing comes back on this chain, so a bridge. (ETH out with no fee also has a
  // zero fifth word, but a minimum.)
  if (outWord === 0n && minOut === 0n) {
    for (const w of inner.b.warnings) b.warnings.push(w);
    for (const d of inner.b.details) if (!b.details.some(x => x.label === d.label) && d.label !== 'Contract') b.details.push(d);
    // A wrapped call read only by its ABI ("Call genericBridge on RangoDiamond") says less than what is sent where.
    const generic = /^Call /.test(inner.title);
    const through = inner.title.match(/ on (.+)$/)?.[1] ?? shortAddress(target.toLowerCase());
    if (generic) b.warn('info', 'bridge_terms_not_decoded', `The bridge's own terms (destination, recipient, amount out) are in the call to ${through}, which isn't decoded here.`);
    return decoded({
      title: generic ? `Send ${paid.text} through ${through} (Binance Web3 Wallet)` : inner.title.endsWith(')') ? `${inner.title.slice(0, -1)}, Binance Web3 Wallet)` : `${inner.title} (Binance Web3 Wallet)`,
      summary: `Sends ${paid.text} through Binance Web3 Wallet's router to ${shortAddress(target.toLowerCase())}: ${inner.summary}`,
      decoder: 'binance_wallet', status: 'partial', b, assetChanges: changes,
    });
  }
  const got = await asset(env, tx.chainId, tokenOut, minOut);
  b.detail('You receive at least', got.text, isZero(tokenOut) ? undefined : tokenOut);
  if (feeBps > 0n) b.detail('Fee', `${formatUnits(feeBps, 2)}% of the output, to ${shortAddress(feeReceiver.toLowerCase())}`, feeReceiver.toLowerCase());
  else b.note('Any fee Binance Web3 Wallet takes from what you pay is already allowed for in the minimum you receive.');
  if (feeBps >= 1000n) b.warn('danger', 'large_fee_portion', `${formatUnits(feeBps, 2)}% of what you buy goes to ${feeReceiver} as a fee. Wallet fees are normally well under 1%.`);
  else if (feeBps >= 100n) b.warn('caution', 'large_fee_portion', `${formatUnits(feeBps, 2)}% of what you buy goes to ${feeReceiver} as a fee.`);
  if (minOut <= 1n) b.warn('caution', 'no_slippage_limit', 'Nothing limits the price: the minimum received is zero, so the swap would go through at any rate.');
  if (got.change) changes.push({ ...got.change, direction: 'in', account: tx.from });
  return decoded({
    title: `Swap ${paid.text} for at least ${got.text} (Binance Web3 Wallet)`,
    summary: `Swaps ${paid.text} for at least ${got.text} through Binance Web3 Wallet's router${feeBps ? `, with a ${formatUnits(feeBps, 2)}% fee` : ''}.`,
    decoder: 'binance_wallet', status: 'partial', b, assetChanges: changes,
  });
};
