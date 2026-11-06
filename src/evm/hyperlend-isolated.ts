// HyperLend's isolated pools (HyperEVM): Fraxlend-style pairs, each lending one asset against one collateral token,
// ERC-4626 for lenders (hTokens are the pair's shares). Source: hyperlendx/hyperlend-isolated (HyperlendPairCore.sol);
// addresses from docs.hyperlend.finance (contract addresses, 2026-11-06). Pairs are the PairRegistry's
// (getAllPairAddresses): the four listed below then, and any added later when an RPC can read the registry.
import { decodeFunctionData, parseAbi } from 'viem';
import { formatUnits, PreviewBuilder, sameAddress, shortAddress } from '../format.ts';
import type { AssetChange, TokenInfo } from '../types.ts';
import { decoded, tokenInfo, tokenSourceWarnings, type Adapter, type AdapterEnv, type Tx } from './common.ts';
import { read } from './onchain.ts';

export const HYPERLEND_PAIR_REGISTRY = '0xf55af86c9ec3a7d5fa6367c00a120e6b262f718d';
/** The registry's pairs on 2026-11-06: collateral -> asset, maximum LTV (1e5 = 100%). */
export const HYPERLEND_PAIRS: Record<string, { collateral: string; asset: string; maxLtv: number }> = {
  '0x06fd9d03b3d0f18e4919919b72d30c582f0a97e5': { collateral: '0x1359b05241ca5076c9f59605214f4f84114c0de8', asset: '0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb', maxLtv: 83_000 }, // WHLP -> USD₮0
  '0xb8fec5f81bc7be9dd5f9bc6de8e34e244a726d2f': { collateral: '0xac962fa04bf91b7fd0dc0c5c32414e0ce3c51e03', asset: '0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb', maxLtv: 75_000 }, // xHYPE -> USD₮0
  '0x78dd09e369f35d033a1d4ec1df39bc8a51c8b6fd': { collateral: '0xac962fa04bf91b7fd0dc0c5c32414e0ce3c51e03', asset: '0xb88339cb7199b77e23db6e890353e22632ba630f', maxLtv: 75_000 }, // xHYPE -> USDC
  '0x9465c9218668b54939a7e09467d1dff9d8704882': { collateral: '0x360c140e5344a1a0593d44b4ea6fc7c3daf0c473', asset: '0x5555555555555555555555555555555555555555', maxLtv: 80_000 }, // kmHYPE -> WHYPE
};
const ABI = parseAbi([
  'function deposit(uint256 amount, address receiver)',
  'function mint(uint256 shares, address receiver)',
  'function redeem(uint256 shares, address receiver, address owner)',
  'function withdraw(uint256 amount, address receiver, address owner)',
  'function borrowAsset(uint256 borrowAmount, uint256 collateralAmount, address receiver)',
  'function addCollateral(uint256 collateralAmount, address borrower)',
  'function removeCollateral(uint256 collateralAmount, address receiver)',
  'function repayAsset(uint256 shares, address borrower)',
  'function liquidate(uint128 sharesToLiquidate, uint256 deadline, address borrower)',
  'function leveragedPosition(address swapperAddress, uint256 borrowAmount, uint256 initialCollateralAmount, uint256 amountCollateralOutMin, address[] path)',
  'function repayAssetWithCollateral(address swapperAddress, uint256 collateralToSwap, uint256 amountAssetOutMin, address[] path)',
]);

let registry: { at: number; pairs: Set<string> } | undefined;
/** Is this one of the registry's pairs? The static list, else the registry itself (cached for 10 minutes). */
async function isPair(env: AdapterEnv, chainId: number, address: string): Promise<boolean> {
  if (chainId !== 999) return false;
  if (HYPERLEND_PAIRS[address]) return true;
  if (!registry || Date.now() - registry.at > 600_000) {
    const all = await read<readonly string[]>(env, 999, HYPERLEND_PAIR_REGISTRY, 'function getAllPairAddresses() view returns (address[])');
    if (!all) return false;
    registry = { at: Date.now(), pairs: new Set(all.map(a => a.toLowerCase())) };
  }
  return registry.pairs.has(address);
}

async function token(env: AdapterEnv, b: PreviewBuilder, address: string): Promise<{ symbol: string; info?: TokenInfo }> {
  const info = await tokenInfo(env, 999, address);
  if (info) tokenSourceWarnings(b, 999, info);
  return { symbol: info?.symbol ?? shortAddress(address), info };
}
const amt = (raw: bigint, t: { symbol: string; info?: TokenInfo }) => t.info ? `${formatUnits(raw, t.info.decimals)} ${t.symbol}` : `${raw} base units of ${t.symbol}`;
const change = (tx: Tx, direction: 'in' | 'out', raw: bigint, address: string, t: { symbol: string; info?: TokenInfo }): AssetChange[] =>
  t.info ? [{ direction, account: tx.from, amount: formatUnits(raw, t.info.decimals), symbol: t.symbol, raw: raw.toString(), asset: address, basis: 'requested', standard: 'erc20' }] : [];

export const hyperlendIsolatedAdapter: Adapter = async (tx, env) => {
  const pair = tx.to?.toLowerCase();
  if (!pair || !(await isPair(env, tx.chainId, pair))) return null;
  let call;
  try { call = decodeFunctionData({ abi: ABI, data: tx.data }); } catch { return null; }
  const known = HYPERLEND_PAIRS[pair];
  const assetAddr = (known?.asset ?? await read<string>(env, 999, pair, 'function asset() view returns (address)'))?.toLowerCase();
  const collateralAddr = (known?.collateral ?? await read<string>(env, 999, pair, 'function collateralContract() view returns (address)'))?.toLowerCase();
  if (!assetAddr || !collateralAddr) return null;
  const b = new PreviewBuilder();
  const asset = await token(env, b, assetAddr), collateral = await token(env, b, collateralAddr);
  const market = `${collateral.symbol} → ${asset.symbol}`;
  b.detail('Market', `HyperLend isolated pool: borrow ${asset.symbol} against ${collateral.symbol} (${pair})`, pair);
  if (known) b.detail('Maximum LTV', `${known.maxLtv / 1000}%`);
  const other = (who: string, what: string) => { if (!sameAddress(who, tx.from)) { b.detail('Receiver', who); b.warn('caution', 'recipient_not_sender', `${what} goes to ${shortAddress(who)}, not to you.`); } };
  const out = (title: string, summary: string, assetChanges: AssetChange[] = []) => decoded({ title: `${title} (HyperLend isolated ${market})`, summary, decoder: 'hyperlend_isolated', status: asset.info && collateral.info ? 'full' : 'partial', b, assetChanges });

  switch (call.functionName) {
    case 'deposit': {
      const [amount, receiver] = call.args;
      b.detail('You lend', amt(amount, asset));
      other(receiver, `The pool's hTokens for your ${asset.symbol}`);
      b.note(`Lenders earn the interest borrowers pay. Your ${asset.symbol} can be borrowed by anyone posting ${collateral.symbol}, and is only as safe as that collateral and its oracle.`);
      return out(`Lend ${amt(amount, asset)}`, `Deposits ${amt(amount, asset)} into HyperLend's isolated ${market} pool, for hTokens.`, change(tx, 'out', amount, assetAddr, asset));
    }
    case 'mint': {
      const [shares, receiver] = call.args;
      const cost = await read<bigint>(env, 999, pair, 'function previewMint(uint256) view returns (uint256)', [shares]);
      b.detail('You get', `${formatUnits(shares, asset.info?.decimals ?? 18)} hTokens`);
      if (cost !== undefined) b.detail('You lend (about)', amt(cost, asset));
      other(receiver, 'The hTokens');
      return out(`Lend ${cost !== undefined ? `about ${amt(cost, asset)}` : asset.symbol}`, `Mints hTokens of HyperLend's isolated ${market} pool, paid in ${asset.symbol}.`, cost !== undefined ? change(tx, 'out', cost, assetAddr, asset) : []);
    }
    case 'redeem':
    case 'withdraw': {
      const [n, receiver, owner] = call.args;
      const amount = call.functionName === 'withdraw' ? n : await read<bigint>(env, 999, pair, 'function previewRedeem(uint256) view returns (uint256)', [n]);
      const what = amount !== undefined ? amt(amount, asset) : `${formatUnits(n, asset.info?.decimals ?? 18)} hTokens' worth of ${asset.symbol}`;
      b.detail('You withdraw', what);
      other(receiver, `The ${asset.symbol}`);
      if (!sameAddress(owner, tx.from)) b.detail('From the hTokens of', owner);
      return out(`Withdraw ${what}`, `Withdraws ${what} from HyperLend's isolated ${market} pool.`, amount !== undefined && sameAddress(receiver, tx.from) ? change(tx, 'in', amount, assetAddr, asset) : []);
    }
    case 'borrowAsset': {
      const [borrowAmount, collateralAmount, receiver] = call.args;
      b.detail('You borrow', amt(borrowAmount, asset));
      if (collateralAmount > 0n) b.detail('Collateral you add', amt(collateralAmount, collateral));
      other(receiver, `The borrowed ${asset.symbol}`);
      b.note(`If your loan grows past ${known ? `${known.maxLtv / 1000}% of` : 'the pool\'s maximum share of'} your collateral's value (prices move, interest accrues), it can be liquidated and you lose collateral.`);
      const changes = [...(collateralAmount > 0n ? change(tx, 'out', collateralAmount, collateralAddr, collateral) : []), ...(sameAddress(receiver, tx.from) ? change(tx, 'in', borrowAmount, assetAddr, asset) : [])];
      return out(`Borrow ${amt(borrowAmount, asset)}${collateralAmount > 0n ? `, adding ${amt(collateralAmount, collateral)} as collateral` : ''}`, `Borrows ${amt(borrowAmount, asset)} from HyperLend's isolated ${market} pool against your ${collateral.symbol}.`, changes);
    }
    case 'addCollateral': {
      const [amount, borrower] = call.args;
      b.detail('Collateral you add', amt(amount, collateral));
      if (!sameAddress(borrower, tx.from)) { b.detail('For the position of', borrower); b.warn('info', 'collateral_for_other', `The collateral backs ${shortAddress(borrower)}'s loan, not yours: only they can withdraw it.`); }
      return out(`Add ${amt(amount, collateral)} as collateral`, `Adds ${amt(amount, collateral)} of collateral to a position in HyperLend's isolated ${market} pool.`, change(tx, 'out', amount, collateralAddr, collateral));
    }
    case 'removeCollateral': {
      const [amount, receiver] = call.args;
      b.detail('Collateral you withdraw', amt(amount, collateral));
      other(receiver, `The ${collateral.symbol}`);
      b.note('Less collateral brings your loan closer to liquidation; the pool refuses a withdrawal that would leave it unhealthy.');
      return out(`Withdraw ${amt(amount, collateral)} of collateral`, `Removes ${amt(amount, collateral)} of collateral from your position in HyperLend's isolated ${market} pool.`, sameAddress(receiver, tx.from) ? change(tx, 'in', amount, collateralAddr, collateral) : []);
    }
    case 'repayAsset': {
      const [shares, borrower] = call.args;
      const amount = await read<bigint>(env, 999, pair, 'function toBorrowAmount(uint256 shares, bool roundUp, bool previewInterest) view returns (uint256)', [shares, true, true]);
      const what = amount !== undefined ? `about ${amt(amount, asset)}` : `${shares} borrow shares of ${asset.symbol}`;
      b.detail('You repay', what);
      if (!sameAddress(borrower, tx.from)) b.detail('The loan of', borrower);
      return out(`Repay ${what}`, `Repays ${what} of a loan in HyperLend's isolated ${market} pool.`, amount !== undefined ? change(tx, 'out', amount, assetAddr, asset) : []);
    }
    case 'leveragedPosition': {
      const [swapper, borrowAmount, initial, minOut] = call.args;
      b.detail('Collateral you add', amt(initial, collateral)).detail('You borrow', amt(borrowAmount, asset)).detail(`Swapped into at least`, amt(minOut, collateral)).detail('Swapper', swapper, swapper);
      b.warn('caution', 'leveraged_position', `This opens a leveraged position: the borrowed ${asset.symbol} is swapped into more ${collateral.symbol} as collateral, so a fall in ${collateral.symbol}'s price is magnified and can get the position liquidated.`);
      return out(`Leverage ${amt(initial, collateral)}: borrow ${amt(borrowAmount, asset)} and swap it into at least ${amt(minOut, collateral)}`, `Opens a leveraged ${collateral.symbol} position in HyperLend's isolated ${market} pool.`, change(tx, 'out', initial, collateralAddr, collateral));
    }
    case 'repayAssetWithCollateral': {
      const [swapper, collateralToSwap, minOut] = call.args;
      b.detail('Collateral swapped', amt(collateralToSwap, collateral)).detail('Into at least', amt(minOut, asset)).detail('Swapper', swapper, swapper);
      return out(`Repay with collateral: swap ${amt(collateralToSwap, collateral)} into at least ${amt(minOut, asset)}`, `Sells ${amt(collateralToSwap, collateral)} of your collateral to repay your loan in HyperLend's isolated ${market} pool.`);
    }
    case 'liquidate': {
      const [shares, , borrower] = call.args;
      b.detail('Borrower', borrower).detail('Borrow shares repaid', shares.toString());
      return out(`Liquidate ${shortAddress(borrower)}'s loan`, `Repays part of ${shortAddress(borrower)}'s unhealthy loan in HyperLend's isolated ${market} pool, for their collateral at a discount.`);
    }
  }
};
