// Checks against an account's HyperCore state (balances, margin, staking), shared by the HyperCore action decoders
// (signed L1 and user actions) and HyperEVM's CoreWriter actions.
import { decimalString, formatDecimalString, formatTimestamp, formatUsd, PreviewBuilder, sameAddress, shortAddress } from '../format.ts';
import type { ResolvedAsset } from './assets.ts';
import type { HyperliquidInfo, SpotToken } from '../types.ts';

/** Checks the USDC being withdrawn against the account (skipped for shared-collateral accounts). */
export async function checkUsdcAvailable(b: PreviewBuilder, info: HyperliquidInfo | undefined, account: string | null, source: 'perps' | 'spot', amount: number) {
  if (!info || !account || !Number.isFinite(amount)) return;
  let mode: string | undefined;
  try { mode = await info.userAbstraction?.(account); } catch { mode = undefined; }
  if (mode === 'unifiedAccount' || mode === 'portfolioMargin') { b.note('The balance was not checked because this account shares collateral across spot and perps.'); return; }
  let have: number;
  try {
    if (source === 'spot') {
      if (!info.spotClearinghouseState) return;
      const bal = (await info.spotClearinghouseState(account)).balances.find(x => x.token === 0);
      have = bal ? Number(bal.total) - Number(bal.hold) : 0;
    } else {
      have = Number((await info.clearinghouseState(account)).withdrawable);
    }
  } catch { return; }
  b.detail(`Withdrawable USDC (${source})`, formatDecimalString(String(have)));
  if (amount > have) b.warn('caution', 'insufficient_balance', `This needs ${formatDecimalString(String(amount))} USDC but only ${formatDecimalString(String(have))} is withdrawable from your ${source} balance, so Hyperliquid will reject it.`);
}


/** Checks the order against the account: margin for perps (per DEX), balances for spot. */
export async function fundsCheck(b: PreviewBuilder, info: HyperliquidInfo | undefined, account: string | null, asset: ResolvedAsset, spec: { isBuy: boolean; price: string; size: string; reduceOnly: boolean }) {
  const price = Number(spec.price), size = Number(spec.size), notional = price * size;
  if (!info || !account || spec.reduceOnly || !Number.isFinite(notional)) return;
  if (asset.kind === 'spot' && asset.base && asset.quote && info.spotClearinghouseState) {
    let balances;
    try { balances = (await info.spotClearinghouseState(account)).balances; } catch { return; }
    const free = (token: number) => { const x = balances.find(bal => bal.token === token); return x ? Number(x.total) - Number(x.hold) : 0; };
    const [token, need] = spec.isBuy ? [asset.quote, notional] : [asset.base, size];
    const have = free(token.index);
    b.detail(`Available ${token.name}`, formatDecimalString(String(have)));
    if (have < need) b.warn('caution', 'insufficient_balance', `This order needs ${formatDecimalString(String(need))} ${token.name} but only ${formatDecimalString(String(have))} is available in spot. It may be rejected.`);
    return;
  }
  if (asset.kind !== 'perp' || !asset.midKey) return;
  let mode: string | undefined;
  try { mode = await info.userAbstraction?.(account); } catch { mode = undefined; }
  if (mode === 'unifiedAccount' || mode === 'portfolioMargin') {
    b.detail('Account mode', mode === 'unifiedAccount' ? 'Unified account (collateral shared)' : 'Portfolio margin (collateral shared)');
    b.note('Margin was not checked per market because this account shares collateral across spot, perps and DEXes.');
    return;
  }
  let state;
  try { state = await info.clearinghouseState(account, asset.dex); } catch { return; }
  const withdrawable = Number(state.withdrawable);
  const where = asset.dex ? ` on ${asset.dexFullName ?? asset.dex}` : '';
  b.detail(`Account value${where}`, formatUsd(Number(state.marginSummary.accountValue))).detail(`Available margin${where}`, formatUsd(withdrawable));
  const coin = asset.midKey;
  const position = state.assetPositions.find(p => p.position.coin === coin)?.position;
  const leverage = position?.leverage.value ?? asset.maxLeverage;
  if (position) {
    b.detail(`Current ${coin} position`, `${formatDecimalString(position.szi)} @ ${formatDecimalString(position.entryPx ?? '?')} (${position.leverage.value}× ${position.leverage.type})`);
    if (position.liquidationPx) b.detail(`Current ${coin} liquidation price`, formatDecimalString(position.liquidationPx));
  }
  if (!leverage) return;
  const required = notional / leverage;
  b.detail(position ? 'Margin required (approx.)' : 'Margin required at max leverage (approx.)', `${formatUsd(required)} at ${leverage}×`);
  if (required > withdrawable) {
    const msg = `This order needs about ${formatUsd(required)} of margin at ${leverage}×${position ? '' : ' (the maximum)'}, but only ${formatUsd(withdrawable)} is available${where}. It may be rejected.`;
    // HIP-3 DEX accounts can be funded via DEX abstraction, which this check does not see.
    b.warn(asset.dex ? 'info' : 'caution', 'insufficient_margin', asset.dex ? `${msg} (If DEX abstraction is on, collateral may come from your main account.)` : msg);
  }
}

/** Shared-collateral accounts pool USDC across spot and perps, so per-balance checks of USDC don't apply. */
async function sharesCollateral(info: HyperliquidInfo, account: string): Promise<boolean> {
  try { const mode = await info.userAbstraction?.(account); return mode === 'unifiedAccount' || mode === 'portfolioMargin'; } catch { return false; }
}

/**
 * Checks a spot token amount (raw, in the token's wei decimals) against what the account has free in HyperCore spot
 * (its total less what open orders hold). `what` names the action, e.g. "This transfer".
 */
export async function checkSpotAvailable(b: PreviewBuilder, info: HyperliquidInfo | undefined, account: string, token: SpotToken, raw: bigint, what: string) {
  if (!info?.spotClearinghouseState || raw <= 0n) return;
  if (token.index === 0 && await sharesCollateral(info, account)) { b.note('The USDC balance was not checked because this account shares collateral across spot and perps.'); return; }
  let balances;
  try { balances = (await info.spotClearinghouseState(account)).balances; } catch { return; }
  const x = balances.find(bal => bal.token === token.index);
  const have = x ? Number(x.total) - Number(x.hold) : 0;
  const need = Number(decimalString(raw, token.weiDecimals));
  b.detail(`Available ${token.name} (HyperCore spot)`, formatDecimalString(String(have)));
  if (need > have) b.warn('caution', 'insufficient_balance', `${what} needs ${formatDecimalString(decimalString(raw, token.weiDecimals))} ${token.name}, but ${shortAddress(account)} has only ${formatDecimalString(String(have))} free in HyperCore spot, so HyperCore will reject it.`);
}

/**
 * Checks a HYPE staking action against the account's staking balances: delegating and withdrawing to spot need
 * that much undelegated stake; undelegating needs that much delegated to the validator, past its lock-up.
 */
export async function checkStaking(b: PreviewBuilder, info: HyperliquidInfo | undefined, account: string, op: 'delegate' | 'undelegate' | 'withdraw', hype: string, validator?: string, now = Date.now()) {
  const need = Number(hype);
  if (!info || !(need > 0)) return;
  if (op === 'undelegate') {
    if (!info.delegations) return;
    let list;
    try { list = await info.delegations(account); } catch { return; }
    const d = list.find(x => sameAddress(x.validator, validator ?? ''));
    const have = d ? Number(d.amount) : 0;
    b.detail('Delegated to this validator', `${formatDecimalString(d?.amount ?? '0')} HYPE`);
    if (need > have) b.warn('caution', 'insufficient_balance', `This undelegates ${formatDecimalString(hype)} HYPE, but only ${formatDecimalString(d?.amount ?? '0')} HYPE is delegated to ${shortAddress(validator ?? '')}, so HyperCore will reject it.`);
    else if (d && d.lockedUntilTimestamp > now) b.warn('caution', 'stake_locked', `This delegation is locked until ${formatTimestamp(d.lockedUntilTimestamp)} (delegations are locked for a day), so HyperCore will reject undelegating it before then.`);
    return;
  }
  if (!info.delegatorSummary) return;
  let summary;
  try { summary = await info.delegatorSummary(account); } catch { return; }
  b.detail('Undelegated staking balance', `${formatDecimalString(summary.undelegated)} HYPE`);
  if (need > Number(summary.undelegated)) {
    const verb = op === 'delegate' ? 'delegates' : 'moves to spot';
    b.warn('caution', 'insufficient_balance', `This ${verb} ${formatDecimalString(hype)} HYPE, but the account's undelegated staking balance is ${formatDecimalString(summary.undelegated)} HYPE, so HyperCore will reject it.`);
  }
}
