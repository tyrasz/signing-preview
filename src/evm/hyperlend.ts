// HyperLend (HyperEVM): an Aave v3 market ("HyperLend Market" per its PoolAddressesProvider). The Pool, hTokens
// and debt tokens follow aave-v3-origin; the Pool implementation (PoolInstance) and hTokens are verified on
// Sourcify. Decoded here: supply / withdraw / borrow / repay and their permit variants, collateral and e-mode
// switches, position managers, liquidations, the native-HYPE gateway, and credit delegation on debt tokens (any
// Aave-style market). With an RPC, positions are read live to show the health factor before and after.
import { decodeFunctionData, parseAbi } from 'viem';
import { compactUnits, formatUnits, isUnlimited, PreviewBuilder, sameAddress, shortAddress } from '../format.ts';
import { CHAINS } from '../chains.ts';
import type { AssetChange, TokenInfo } from '../types.ts';
import { decoded, tokenInfo, tokenSourceWarnings, type Adapter, type AdapterEnv, type Tx } from './common.ts';
import { read } from './onchain.ts';

export const HYPERLEND: Record<number, { pool: string; addressesProvider: string }> = {
  999: { pool: '0x00a89d7a5a02160f20150ebea7a2b5e4879a1a8b', addressesProvider: '0x72c98246a98bfe64022a3190e7710e157497170c' },
};

const POOL_ABI = parseAbi([
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',
  'function deposit(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',
  'function supplyWithPermit(address asset, uint256 amount, address onBehalfOf, uint16 referralCode, uint256 deadline, uint8 permitV, bytes32 permitR, bytes32 permitS)',
  'function withdraw(address asset, uint256 amount, address to)',
  'function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)',
  'function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf)',
  'function repayWithPermit(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf, uint256 deadline, uint8 permitV, bytes32 permitR, bytes32 permitS)',
  'function repayWithATokens(address asset, uint256 amount, uint256 interestRateMode)',
  'function setUserUseReserveAsCollateral(address asset, bool useAsCollateral)',
  'function setUserUseReserveAsCollateralOnBehalfOf(address asset, bool useAsCollateral, address onBehalfOf)',
  'function setUserEMode(uint8 categoryId)',
  'function setUserEModeOnBehalfOf(uint8 categoryId, address onBehalfOf)',
  'function approvePositionManager(address positionManager, bool approve)',
  'function liquidationCall(address collateralAsset, address debtAsset, address borrower, uint256 debtToCover, bool receiveAToken)',
]);
// aave-v3-origin WrappedTokenGatewayV3, plus the 3.0 variants that still take an interest-rate mode.
const GATEWAY_ABI = parseAbi([
  'function depositETH(address pool, address onBehalfOf, uint16 referralCode) payable',
  'function withdrawETH(address pool, uint256 amount, address to)',
  'function withdrawETHWithPermit(address pool, uint256 amount, address to, uint256 deadline, uint8 permitV, bytes32 permitR, bytes32 permitS)',
  'function repayETH(address pool, uint256 amount, address onBehalfOf) payable',
  'function repayETH(address pool, uint256 amount, uint256 rateMode, address onBehalfOf) payable',
  'function borrowETH(address pool, uint256 amount, uint16 referralCode)',
  'function borrowETH(address pool, uint256 amount, uint256 interestRateMode, uint16 referralCode)',
]);
const DELEGATION_ABI = parseAbi(['function approveDelegation(address delegatee, uint256 amount)']);

const WAD = 10n ** 18n;
interface Market { chainId: number; pool: string; provider: string }
interface Account { collateral: bigint; debt: bigint; available: bigint; lt: bigint; hf: bigint }
interface AssetRisk { price: bigint; decimals: number; lt: bigint; id: number; hToken: string; debtToken: string }

const marketFor = (chainId: number, pool: string | null | undefined): Market | null => {
  const m = HYPERLEND[chainId];
  return m && pool && sameAddress(pool, m.pool) ? { chainId, pool: m.pool, provider: m.addressesProvider } : null;
};

async function account(env: AdapterEnv, m: Market, user: string): Promise<Account | undefined> {
  const r = await read<readonly bigint[]>(env, m.chainId, m.pool, 'function getUserAccountData(address) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)', [user]);
  return r ? { collateral: r[0], debt: r[1], available: r[2], lt: r[3], hf: r[5] } : undefined;
}

/** Price (base currency, USD with 8 decimals), decimals and the liquidation threshold that applies to `user`. */
async function risk(env: AdapterEnv, m: Market, asset: string, user: string): Promise<AssetRisk | undefined> {
  const oracle = await read<string>(env, m.chainId, m.provider, 'function getPriceOracle() view returns (address)');
  const price = oracle ? await read<bigint>(env, m.chainId, oracle, 'function getAssetPrice(address) view returns (uint256)', [asset]) : undefined;
  const rd = await read<{ configuration: { data: bigint }; id: number; aTokenAddress: string; variableDebtTokenAddress: string }>(env, m.chainId, m.pool,
    'function getReserveData(address) view returns ((uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))', [asset]);
  if (price === undefined || !rd) return undefined;
  const cfg = BigInt((rd.configuration as unknown as bigint));
  let lt = (cfg >> 16n) & 0xffffn; // ReserveConfiguration: bits 16-31 liquidation threshold, 48-55 decimals
  const decimals = Number((cfg >> 48n) & 0xffn);
  // In an e-mode category, the category's threshold applies to the assets it lists as collateral.
  const cat = await read<bigint>(env, m.chainId, m.pool, 'function getUserEMode(address) view returns (uint256)', [user]);
  if (cat && cat > 0n) {
    const bitmap = await read<bigint>(env, m.chainId, m.pool, 'function getEModeCategoryCollateralBitmap(uint8) view returns (uint128)', [Number(cat)]);
    const conf = await read<{ liquidationThreshold: number }>(env, m.chainId, m.pool, 'function getEModeCategoryCollateralConfig(uint8) view returns ((uint16 ltv, uint16 liquidationThreshold, uint16 liquidationBonus))', [Number(cat)]);
    if (bitmap !== undefined && conf && (bitmap >> BigInt(rd.id)) & 1n) lt = BigInt(conf.liquidationThreshold);
  }
  return { price, decimals, lt, id: rd.id, hToken: rd.aTokenAddress.toLowerCase(), debtToken: rd.variableDebtTokenAddress.toLowerCase() };
}

const baseValue = (amount: bigint, r: AssetRisk) => amount * r.price / 10n ** BigInt(r.decimals);
const hfText = (hf: bigint | null) => hf === null ? 'no debt (∞)' : hf >= 1000n * WAD ? '> 1000' : formatUnits(hf * 100n / WAD, 2);
/** Health factor = collateral × liquidation threshold ÷ debt (Aave), as WAD; null when there is no debt. */
const healthFactor = (weighted: bigint, debt: bigint) => debt <= 0n ? null : weighted * WAD / (debt * 10_000n);

/** Shows the health factor change and warns as it approaches 1, where the position can be liquidated. */
function healthWarnings(b: PreviewBuilder, before: bigint | null, after: bigint | null, revertsBelowOne: boolean) {
  b.detail('Health factor (estimated)', `${hfText(before)} → ${hfText(after)}`);
  if (after === null || (before !== null && after >= before)) return;
  if (after < WAD) {
    if (revertsBelowOne) b.warn('caution', 'lending_will_fail', 'This will fail: it would take your health factor below 1, which HyperLend does not allow.');
    else b.warn('danger', 'liquidation_risk', `Your health factor would be ${hfText(after)}: the position could be liquidated right away.`);
  } else if (after < (11n * WAD) / 10n) {
    b.warn('danger', 'liquidation_risk', `Your health factor would drop to ${hfText(after)}. A price move of about ${formatUnits((after - WAD) * 100n * 100n / after, 2)}% against you would let anyone liquidate part of your position.`);
  } else if (after < (15n * WAD) / 10n) {
    b.warn('caution', 'low_health_factor', `Your health factor would drop to ${hfText(after)}; it can be liquidated below 1.`);
  }
}

async function label(env: AdapterEnv, chainId: number, address: string, b: PreviewBuilder): Promise<{ symbol: string; info?: TokenInfo }> {
  const info = await tokenInfo(env, chainId, address);
  if (info) tokenSourceWarnings(b, chainId, info);
  return { symbol: info?.symbol ?? shortAddress(address), info };
}
const amountText = (raw: bigint, t: { symbol: string; info?: TokenInfo }, all: string) => isUnlimited(raw) ? all : t.info ? `${formatUnits(raw, t.info.decimals)} ${t.symbol}` : `${raw} base units of ${t.symbol}`;
const titleAmount = (raw: bigint, t: { symbol: string; info?: TokenInfo }) => t.info ? `${compactUnits(raw, t.info.decimals)} ${t.symbol}` : `${t.symbol}`;
const who = (tx: Tx, a: string) => sameAddress(a, tx.from) ? 'you' : a;

export const hyperlendPoolAdapter: Adapter = async (tx, env) => {
  const m = marketFor(tx.chainId, tx.to);
  if (!m) return null;
  let call;
  try { call = decodeFunctionData({ abi: POOL_ABI, data: tx.data }); } catch { return null; } // others (flash loans, admin): generic ABI decoder
  const b = new PreviewBuilder();
  b.detail('Protocol', `HyperLend (Pool ${m.pool})`, m.pool);
  const changes: AssetChange[] = [];
  const change = (direction: 'in' | 'out', raw: bigint, t: { symbol: string; info?: TokenInfo }, asset: string) => {
    if (t.info && !isUnlimited(raw)) changes.push({ direction, account: tx.from, amount: formatUnits(raw, t.info.decimals), symbol: t.symbol, raw: raw.toString(), asset: asset.toLowerCase(), basis: 'requested' });
  };
  const done = (title: string, summary: string, decoder: string) => decoded({ title, summary, decoder, status: 'full', b, assetChanges: changes });
  const position = async (user: string) => account(env, m, user);
  const fn = call.functionName;

  if (fn === 'supply' || fn === 'deposit' || fn === 'supplyWithPermit') {
    const [asset, amount, onBehalfOf] = call.args as unknown as readonly [string, bigint, string];
    const t = await label(env, tx.chainId, asset, b);
    b.detail('Supply', amountText(amount, t, 'all'), amount.toString()).detail('Credited to', who(tx, onBehalfOf));
    if (fn === 'supplyWithPermit') b.detail('Approval', 'included as a signed permit for the token');
    const acct = await position(onBehalfOf), r = acct && await risk(env, m, asset, onBehalfOf);
    if (acct && r && acct.debt > 0n && r.lt > 0n) healthWarnings(b, acct.hf >= 2n ** 255n ? null : acct.hf, healthFactor(acct.collateral * acct.lt + baseValue(amount, r) * r.lt, acct.debt), false);
    if (!sameAddress(onBehalfOf, tx.from)) b.warn('info', 'lending_on_behalf', `The supplied ${t.symbol} is credited to ${onBehalfOf}, not to you.`);
    b.note('You receive interest-bearing hTokens for the supply; they can be used as collateral to borrow.');
    change('out', amount, t, asset);
    return done(`Supply ${titleAmount(amount, t)} to HyperLend`, `Supplies ${amountText(amount, t, 'all')} to HyperLend${sameAddress(onBehalfOf, tx.from) ? '' : ` for ${shortAddress(onBehalfOf)}`}.`, 'hyperlend_supply');
  }
  if (fn === 'withdraw') {
    const [asset, amount, to] = call.args;
    const t = await label(env, tx.chainId, asset, b);
    const acct = await position(tx.from), r = acct && await risk(env, m, asset, tx.from);
    let raw = amount;
    if (r && isUnlimited(amount)) raw = (await read<bigint>(env, tx.chainId, r.hToken, 'function balanceOf(address) view returns (uint256)', [tx.from])) ?? amount;
    b.detail('Withdraw', isUnlimited(amount) ? `all your supplied ${t.symbol}${raw !== amount && t.info ? ` (${formatUnits(raw, t.info.decimals)} ${t.symbol} now)` : ''}` : amountText(amount, t, 'all'), amount.toString()).detail('Sent to', who(tx, to));
    if (acct && r && acct.debt > 0n && !isUnlimited(raw)) {
      const userCfg = await read<{ data: bigint }>(env, tx.chainId, m.pool, 'function getUserConfiguration(address) view returns ((uint256 data))', [tx.from]);
      const usedAsCollateral = userCfg ? ((BigInt(userCfg.data as unknown as bigint) >> BigInt(r.id * 2 + 1)) & 1n) === 1n : true;
      if (usedAsCollateral) healthWarnings(b, acct.hf, healthFactor(acct.collateral * acct.lt - baseValue(raw, r) * r.lt, acct.debt), true);
    }
    if (!sameAddress(to, tx.from)) b.warn('caution', 'output_to_other', `The withdrawn ${t.symbol} is sent to ${to}, not to you.`);
    if (!isUnlimited(raw)) change('in', raw, t, asset);
    return done(isUnlimited(amount) ? `Withdraw all your ${t.symbol} from HyperLend` : `Withdraw ${titleAmount(amount, t)} from HyperLend`, `Withdraws ${t.symbol} you supplied to HyperLend.`, 'hyperlend_withdraw');
  }
  if (fn === 'borrow') {
    const [asset, amount, mode, , onBehalfOf] = call.args;
    const t = await label(env, tx.chainId, asset, b);
    b.detail('Borrow', amountText(amount, t, 'all'), amount.toString()).detail('Interest rate', mode === 2n ? 'variable' : mode === 1n ? 'stable (deprecated in Aave v3.2+; likely to fail)' : `mode ${mode}`);
    const debtor = onBehalfOf;
    const acct = await position(debtor), r = acct && await risk(env, m, asset, debtor);
    if (acct && r) {
      const value = baseValue(amount, r);
      if (value > acct.available) b.warn('caution', 'lending_will_fail', `This will fail: the collateral allows borrowing only about $${formatUnits(acct.available, 8)} more; this borrow is worth about $${formatUnits(value, 8)}.`);
      else healthWarnings(b, acct.debt === 0n ? null : acct.hf, healthFactor(acct.collateral * acct.lt, acct.debt + value), false);
    }
    if (!sameAddress(onBehalfOf, tx.from)) b.warn('info', 'lending_on_behalf', `The debt is taken on by ${onBehalfOf} through credit delegation; you receive the ${t.symbol}.`);
    b.note('Borrowed amounts accrue interest. If the health factor falls below 1, part of the collateral can be liquidated.');
    change('in', amount, t, asset);
    return done(`Borrow ${titleAmount(amount, t)} from HyperLend`, `Borrows ${amountText(amount, t, 'all')} from HyperLend${sameAddress(onBehalfOf, tx.from) ? ' against your collateral' : ` against ${shortAddress(onBehalfOf)}'s collateral`}.`, 'hyperlend_borrow');
  }
  if (fn === 'repay' || fn === 'repayWithPermit' || fn === 'repayWithATokens') {
    const asset = call.args[0] as string, amount = call.args[1] as bigint;
    const onBehalfOf = fn === 'repayWithATokens' ? tx.from : call.args[3] as string;
    const t = await label(env, tx.chainId, asset, b);
    const acct = await position(onBehalfOf), r = acct && await risk(env, m, asset, onBehalfOf);
    const owed = r ? await read<bigint>(env, tx.chainId, r.debtToken, 'function balanceOf(address) view returns (uint256)', [onBehalfOf]) : undefined;
    const paid = owed !== undefined ? (isUnlimited(amount) || amount > owed ? owed : amount) : amount;
    b.detail('Repay', isUnlimited(amount) ? `all of the ${t.symbol} debt${owed !== undefined && t.info ? ` (${formatUnits(owed, t.info.decimals)} ${t.symbol} now)` : ''}` : amountText(amount, t, 'all'), amount.toString());
    if (owed !== undefined && t.info) b.detail('Debt in this market', `${formatUnits(owed, t.info.decimals)} ${t.symbol}`);
    b.detail('Paid from', fn === 'repayWithATokens' ? `your supplied ${t.symbol} (hTokens)` : 'your wallet').detail('Debt of', who(tx, onBehalfOf));
    if (fn === 'repayWithPermit') b.detail('Approval', 'included as a signed permit for the token');
    if (isUnlimited(amount) && !sameAddress(onBehalfOf, tx.from)) b.warn('caution', 'lending_will_fail', "This will fail: repaying someone else's debt needs an exact amount, not \"all\".");
    if (acct && r && acct.debt > 0n && !isUnlimited(paid)) healthWarnings(b, acct.hf, healthFactor(acct.collateral * acct.lt - (fn === 'repayWithATokens' ? baseValue(paid, r) * r.lt : 0n), acct.debt - baseValue(paid, r)), false);
    if (fn !== 'repayWithATokens' && !isUnlimited(paid)) change('out', paid, t, asset);
    return done(isUnlimited(amount) ? `Repay all your ${t.symbol} debt on HyperLend` : `Repay ${titleAmount(amount, t)} of HyperLend debt`, `Repays ${t.symbol} borrowed on HyperLend${sameAddress(onBehalfOf, tx.from) ? '' : ` for ${shortAddress(onBehalfOf)}`}.`, 'hyperlend_repay');
  }
  if (fn === 'setUserUseReserveAsCollateral' || fn === 'setUserUseReserveAsCollateralOnBehalfOf') {
    const [asset, use] = call.args as unknown as readonly [string, boolean];
    const user = fn === 'setUserUseReserveAsCollateral' ? tx.from : call.args[2] as string;
    const t = await label(env, tx.chainId, asset, b);
    b.detail('Collateral', `${use ? 'use' : 'stop using'} ${t.symbol}`).detail('Account', who(tx, user));
    if (!use) {
      const acct = await position(user), r = acct && await risk(env, m, asset, user);
      const bal = r ? await read<bigint>(env, tx.chainId, r.hToken, 'function balanceOf(address) view returns (uint256)', [user]) : undefined;
      if (acct && r && bal !== undefined && acct.debt > 0n) healthWarnings(b, acct.hf, healthFactor(acct.collateral * acct.lt - baseValue(bal, r) * r.lt, acct.debt), true);
    }
    return done(`${use ? 'Use' : 'Stop using'} ${t.symbol} as collateral on HyperLend`, `${use ? 'Lets' : 'Stops'} your supplied ${t.symbol} ${use ? 'back' : ''} your HyperLend borrowing.`.replace('  ', ' '), 'hyperlend_collateral');
  }
  if (fn === 'setUserEMode' || fn === 'setUserEModeOnBehalfOf') {
    const cat = Number(call.args[0]);
    const user = fn === 'setUserEMode' ? tx.from : call.args[1] as string;
    const name = cat === 0 ? 'none' : await read<string>(env, tx.chainId, m.pool, 'function getEModeCategoryLabel(uint8) view returns (string)', [cat]);
    const conf = cat ? await read<{ ltv: number; liquidationThreshold: number }>(env, tx.chainId, m.pool, 'function getEModeCategoryCollateralConfig(uint8) view returns ((uint16 ltv, uint16 liquidationThreshold, uint16 liquidationBonus))', [cat]) : undefined;
    b.detail('E-mode category', cat === 0 ? 'none (leave e-mode)' : `${cat}${name ? ` (${name})` : ''}`).detail('Account', who(tx, user));
    if (conf) b.detail('Category limits', `borrow up to ${conf.ltv / 100}% of collateral value; liquidation at ${conf.liquidationThreshold / 100}%`);
    b.note('E-mode raises borrowing limits for correlated assets but only allows borrowing assets in the category. HyperLend refuses the change if it would leave the health factor below 1.');
    return done(cat === 0 ? 'Leave HyperLend e-mode' : `Switch HyperLend e-mode to ${name ?? `category ${cat}`}`, 'Changes the e-mode category that sets your borrowing limits on HyperLend.', 'hyperlend_emode');
  }
  if (fn === 'approvePositionManager') {
    const [manager, approve] = call.args;
    b.detail('Position manager', manager).detail('Change', approve ? 'approve' : 'revoke');
    // Pool.sol: a position manager may call setUserUseReserveAsCollateralOnBehalfOf and setUserEModeOnBehalfOf.
    if (approve) b.warn('caution', 'position_manager', `${manager} will be able to change which of your HyperLend assets count as collateral and your e-mode category. It cannot move your funds, but these switches can bring your position close to liquidation.`);
    return done(approve ? `Let ${shortAddress(manager)} manage your HyperLend collateral settings` : `Revoke ${shortAddress(manager)} as your HyperLend position manager`,
      approve ? 'Approves a position manager for your HyperLend account.' : 'Removes a position manager from your HyperLend account.', 'hyperlend_position_manager');
  }
  if (fn === 'liquidationCall') {
    const [collateralAsset, debtAsset, borrower, debtToCover, receiveAToken] = call.args;
    const c = await label(env, tx.chainId, collateralAsset, b), d = await label(env, tx.chainId, debtAsset, b);
    const acct = await position(borrower);
    b.detail('Borrower', borrower).detail('Repay up to', amountText(debtToCover, d, `as much ${d.symbol} debt as allowed`), debtToCover.toString())
      .detail('Receive', `${c.symbol} collateral${receiveAToken ? ' as hTokens' : ''}, with the liquidation bonus`);
    if (acct) b.detail("Borrower's health factor", hfText(acct.debt === 0n ? null : acct.hf));
    if (acct && acct.hf >= WAD) b.warn('caution', 'lending_will_fail', "This will fail: the borrower's health factor is not below 1, so the position can't be liquidated.");
    return done(`Liquidate ${shortAddress(borrower)}'s HyperLend position`, `Repays ${d.symbol} debt of ${shortAddress(borrower)} to buy their ${c.symbol} collateral at a discount.`, 'hyperlend_liquidation');
  }
  return null;
};

/**
 * WrappedTokenGatewayV3: native HYPE in and out of HyperLend. Any contract can claim to be a gateway, so it is
 * trusted only when its verified source (Sourcify/Etherscan) is a WrappedTokenGateway pointing at the HyperLend
 * Pool; otherwise sending HYPE to it gets a caution.
 */
export const hyperlendGatewayAdapter: Adapter = async (tx, env) => {
  if (!tx.to) return null;
  let call;
  try { call = decodeFunctionData({ abi: GATEWAY_ABI, data: tx.data }); } catch { return null; }
  const m = marketFor(tx.chainId, call.args[0] as string);
  if (!m) return null;
  const b = new PreviewBuilder();
  const native = CHAINS[tx.chainId]?.nativeSymbol ?? 'HYPE';
  const fmt = (raw: bigint) => isUnlimited(raw) ? `all your ${native}` : `${formatUnits(raw, 18)} ${native}`;
  const short = (raw: bigint) => isUnlimited(raw) ? `all your ${native}` : `${compactUnits(raw, 18)} ${native}`;
  let verified = false;
  try {
    const abi = await env.deps.abis?.resolve(tx.chainId, tx.to);
    const pool = await read<string>(env, tx.chainId, tx.to, 'function POOL() view returns (address)');
    verified = !!abi?.verified && /WrappedTokenGateway/i.test(abi.name ?? '') && (!pool || sameAddress(pool, m.pool));
  } catch { verified = false; }
  b.detail('Protocol', `HyperLend native ${native} gateway (${tx.to})`, tx.to);
  if (!verified) b.warn('caution', 'unverified_gateway', `This contract says it routes ${native} into HyperLend's Pool, but its source is not verified as HyperLend's WrappedTokenGateway. Use the gateway linked from HyperLend's app.`);
  const changes: AssetChange[] = [];
  const change = (direction: 'in' | 'out', raw: bigint) => { if (!isUnlimited(raw)) changes.push({ direction, account: tx.from, amount: formatUnits(raw, 18), symbol: native, raw: raw.toString(), asset: 'native', basis: 'requested' }); };
  const fn = call.functionName;
  let title: string, summary: string;
  if (fn === 'depositETH') {
    const onBehalfOf = call.args[1] as string;
    b.detail('Supply', fmt(tx.value)).detail('Credited to', who(tx, onBehalfOf));
    change('out', tx.value);
    title = `Supply ${short(tx.value)} to HyperLend`; summary = `Wraps ${fmt(tx.value)} and supplies it to HyperLend.`;
  } else if (fn === 'withdrawETH' || fn === 'withdrawETHWithPermit') {
    const amount = call.args[1] as bigint, to = call.args[2] as string;
    b.detail('Withdraw', fmt(amount)).detail('Sent to', who(tx, to));
    if (!sameAddress(to, tx.from)) b.warn('caution', 'output_to_other', `The ${native} is sent to ${to}, not to you.`);
    b.note(`The gateway needs an allowance on your HyperLend W${native} hTokens${fn === 'withdrawETHWithPermit' ? ' (included here as a signed permit)' : ''}.`);
    change('in', amount);
    title = `Withdraw ${short(amount)} from HyperLend`; summary = `Withdraws your supplied W${native} from HyperLend and unwraps it to ${native}.`;
  } else if (fn === 'repayETH') {
    const amount = call.args[1] as bigint, onBehalfOf = call.args[call.args.length - 1] as string;
    b.detail('Repay', fmt(amount)).detail('Sent', fmt(tx.value)).detail('Debt of', who(tx, onBehalfOf));
    b.note(`Any ${native} sent beyond the debt is refunded.`);
    change('out', tx.value);
    title = `Repay ${short(amount)} of HyperLend debt`; summary = `Repays W${native} debt on HyperLend with native ${native}.`;
  } else {
    const amount = call.args[1] as bigint;
    b.detail('Borrow', fmt(amount));
    b.warn('caution', 'credit_delegation_needed', `Borrowing through the gateway needs credit delegation from you to the gateway (approveDelegation on the W${native} debt token). The debt is yours.`);
    change('in', amount);
    title = `Borrow ${short(amount)} from HyperLend`; summary = `Borrows W${native} from HyperLend against your collateral and unwraps it to ${native}.`;
  }
  return decoded({ title, summary, decoder: 'hyperlend_gateway', status: 'full', b, assetChanges: changes });
};

/**
 * approveDelegation on an Aave-style debt token: lets someone else borrow in your name. The debt and the
 * liquidation risk stay with you, so a grant is always danger.
 */
export const creditDelegationAdapter: Adapter = async (tx, env) => {
  if (!tx.to) return null;
  let call;
  try { call = decodeFunctionData({ abi: DELEGATION_ABI, data: tx.data }); } catch { return null; }
  const [delegatee, amount] = call.args;
  const b = new PreviewBuilder();
  const d = await delegationTarget(env, tx.chainId, tx.to, b);
  b.detail('Debt token', `${d.debtName} (${tx.to})`, tx.to).detail('Delegatee', delegatee).detail('Borrowing allowance', amount === 0n ? 'none (revoke)' : isUnlimited(amount) ? 'unlimited' : `${d.format(amount)}`, amount.toString());
  if (amount === 0n) return decoded({ title: `Revoke ${shortAddress(delegatee)}'s credit delegation on ${d.protocol}`, summary: `Stops ${delegatee} from borrowing ${d.symbol} in your name.`, decoder: 'credit_delegation', status: 'full', b });
  b.warn('danger', 'credit_delegation', `${delegatee} will be able to borrow ${isUnlimited(amount) ? 'any amount of' : `up to ${d.format(amount)}`} ${isUnlimited(amount) ? d.symbol : ''} from ${d.protocol} in your name. The debt is yours, it is backed by your collateral, and they keep what they borrow. Only delegate to someone you trust completely.`.replace(/\s+\./, '.').replace(/  +/g, ' '));
  return decoded({ title: `Let ${shortAddress(delegatee)} borrow ${isUnlimited(amount) ? 'unlimited' : `up to ${d.format(amount)}`}${isUnlimited(amount) ? ` ${d.symbol}` : ''} in your name on ${d.protocol}`,
    summary: `Grants credit delegation: ${delegatee} can borrow ${d.symbol} with your collateral, and the debt is yours.`, decoder: 'credit_delegation', status: 'full', b });
};

/** What a debt token belongs to: HyperLend when its POOL() is HyperLend's Pool and the Pool lists it. */
export async function delegationTarget(env: AdapterEnv, chainId: number, debtToken: string, b: PreviewBuilder) {
  const pool = await read<string>(env, chainId, debtToken, 'function POOL() view returns (address)');
  const underlying = await read<string>(env, chainId, debtToken, 'function UNDERLYING_ASSET_ADDRESS() view returns (address)');
  const m = marketFor(chainId, pool);
  const listed = m && underlying ? await read<string>(env, chainId, m.pool, 'function getReserveVariableDebtToken(address) view returns (address)', [underlying]) : undefined;
  const isHyperLend = !!m && !!listed && sameAddress(listed, debtToken);
  const u = underlying ? await label(env, chainId, underlying, b) : undefined;
  const debtName = await read<string>(env, chainId, debtToken, 'function name() view returns (string)') ?? 'debt token';
  return {
    protocol: isHyperLend ? 'HyperLend' : 'this lending market', debtName, symbol: u?.symbol ?? 'the underlying token',
    format: (raw: bigint) => u?.info ? `${formatUnits(raw, u.info.decimals)} ${u.symbol}` : `${raw} base units`,
  };
}
