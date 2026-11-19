// Coinbase Smart Wallet (Base Account) spend permissions: the account signs a SpendPermission (or a
// SpendPermissionBatch: several spenders and tokens sharing a period and a time window) under SpendPermissionManager's
// domain (name "Spend Permission Manager", version "1"; 0xf852…67ad, verified on Sourcify). Anyone can then approve it on
// chain (approveWithSignature); from then on the spender takes up to `allowance` of `token` per `period`, between `start`
// and `end` (spend: the manager has the account approve it and transfer, so no ERC-20 allowance is needed beforehand;
// native coin is ERC-7528's 0xEeee…EEeE). The account revokes it with revoke(). Types, from the manager's source:
//   SpendPermission(address account,address spender,address token,uint160 allowance,uint48 period,uint48 start,uint48 end,uint256 salt,bytes extraData)
//   SpendPermissionBatch(address account,uint48 period,uint48 start,uint48 end,PermissionDetails[] permissions)
//   PermissionDetails(address spender,address token,uint160 allowance,uint256 salt,bytes extraData)
import { encodeFunctionData, parseAbi, type Hex } from 'viem';
import { formatTimestamp, formatUnits, isUnlimited, PreviewBuilder, shortAddress } from '../format.ts';
import { chainName, CHAINS } from '../chains.ts';
import { tokenSourceWarnings } from '../evm/common.ts';
import type { TokenInfo } from '../types.ts';
import { big, domainChainId, str, type TypedAdapter } from './common.ts';
import { callWords, canMoveNow } from './exposure.ts';
import { duration, nativeCanMoveNow } from './delegation.ts';

export const SPEND_PERMISSION_MANAGER = '0xf85210b21cc50302f477ba56686d2019dc9b67ad';
const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const UINT160_MAX = (1n << 160n) - 1n, UINT48_MAX = (1n << 48n) - 1n;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SINGLE = 'address account,address spender,address token,uint160 allowance,uint48 period,uint48 start,uint48 end,uint256 salt,bytes extraData';
const BATCH = 'address account,uint48 period,uint48 start,uint48 end,PermissionDetails[] permissions';
const DETAILS = 'address spender,address token,uint160 allowance,uint256 salt,bytes extraData';
const ABI = parseAbi(['struct SpendPermission { address account; address spender; address token; uint160 allowance; uint48 period; uint48 start; uint48 end; uint256 salt; bytes extraData; }', 'function isRevoked(SpendPermission spendPermission) view returns (bool)', 'function isApproved(SpendPermission spendPermission) view returns (bool)']);

/** An amount, also from a JSON number past 2^53 (only its magnitude matters then). */
const amountOf = (v: unknown) => big(v) ?? (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? BigInt(v.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 0 })) : null);
/** "a day", "a week", "every 30 days", or "in all" when one period covers the whole window. */
const per = (period: bigint, start: bigint, end: bigint) => period >= end - start ? 'in all' : period === 86_400n ? 'a day' : period === 604_800n ? 'a week' : period === 3_600n ? 'an hour' : `every ${duration(period)}`;

export const spendPermissionAdapter: TypedAdapter = async (data, env) => {
  if (str(data.domain.name) !== 'Spend Permission Manager' || str(data.domain.version) !== '1') return null;
  const fields = (t: string) => data.types[t]?.map(f => `${f.type} ${f.name}`).join(',');
  const batch = data.primaryType === 'SpendPermissionBatch';
  if (batch ? fields('SpendPermissionBatch') !== BATCH || fields('PermissionDetails') !== DETAILS : data.primaryType !== 'SpendPermission' || fields('SpendPermission') !== SINGLE) return null;
  const chainId = domainChainId(data);
  const network = chainId !== null ? { kind: 'evm' as const, chainId, name: chainName(chainId) } : null;
  const native = chainId !== null ? CHAINS[chainId]?.nativeSymbol ?? 'ETH' : 'ETH';
  const m = data.message;
  const account = str(m.account).toLowerCase();
  const period = big(m.period), start = big(m.start), end = big(m.end);
  const items = (batch ? Array.isArray(m.permissions) ? m.permissions as Record<string, unknown>[] : [] : [m])
    .map(p => ({ spender: str(p?.spender).toLowerCase(), token: str(p?.token).toLowerCase(), allowance: amountOf(p?.allowance), salt: big(p?.salt), extraData: str(p?.extraData) }));
  if (!ADDRESS.test(account) || period === null || start === null || end === null || !items.length || items.some(p => !ADDRESS.test(p.spender) || !ADDRESS.test(p.token) || p.allowance === null)) return null;
  const b = new PreviewBuilder();
  const manager = str(data.domain.verifyingContract).toLowerCase();
  const token = async (address: string): Promise<TokenInfo | undefined> => {
    if (address === NATIVE || chainId === null) return undefined;
    try { return (await env.deps.tokens?.get(chainId, address)) ?? undefined; } catch { return undefined; }
  };
  const nowS = BigInt(Math.floor(env.now / 1000));
  const window = per(period, start, end);
  b.detail('Account', account);
  if (manager !== SPEND_PERMISSION_MANAGER) b.warn('caution', 'spend_permission_manager_unknown', `It is signed for ${shortAddress(manager)}, not Coinbase's SpendPermissionManager (${shortAddress(SPEND_PERMISSION_MANAGER)}): what that contract does with it isn't known here.`);
  if (env.signer && env.signer !== account) b.warn('caution', 'spend_permission_other_account', `It grants spending from ${shortAddress(account)}, but ${shortAddress(env.signer)} is asked to sign it: only a signature the account itself accepts (its owners', through ERC-1271) approves it.`);
  const bySpender = new Map<string, string[]>();
  for (const [i, p] of items.entries()) {
    const label = items.length > 1 ? ` ${i + 1}` : '';
    const isNative = p.token === NATIVE, info = await token(p.token);
    const amount = (v: bigint) => isNative ? `${formatUnits(v, CHAINS[chainId ?? 0]?.nativeDecimals ?? 18)} ${native}` : info ? `${formatUnits(v, info.decimals)} ${info.symbol}` : `${v} base units of ${shortAddress(p.token)}`;
    const symbol = isNative ? native : info?.symbol ?? shortAddress(p.token);
    // 2^128 - 1 or more is unlimited, as format.ts's isUnlimited reads it (a uint160's largest is one such).
    const unlimited = isUnlimited(p.allowance!);
    b.detail(`Spender${label}`, p.spender).detail(`Token${label}`, isNative ? `${native} (native coin)` : info ? `${info.symbol} (${p.token})` : p.token, p.token)
      .detail(`Allowance${label}`, `${unlimited ? `unlimited ${symbol}` : amount(p.allowance!)} ${window}`, p.allowance!.toString());
    if (p.extraData && p.extraData !== '0x') b.detail(`Extra data${label}`, p.extraData.length > 2 + 64 * 2 ? `${p.extraData.slice(0, 66)}… (${(p.extraData.length - 2) / 2} bytes)` : p.extraData);
    if (chainId !== null && !isNative) tokenSourceWarnings(b, chainId, info);
    if (unlimited) b.warn('danger', 'spend_permission_unlimited', `${shortAddress(p.spender)} may take any amount of your ${symbol}, ${window === 'in all' ? 'at any time' : `again ${window}`}: all of it, and any you receive while the permission lasts.`);
    bySpender.set(p.spender, [...bySpender.get(p.spender) ?? [], unlimited ? `unlimited ${symbol}` : amount(p.allowance!)]);
    // The allowance comes back each period: what it allows over its whole window (to a century, for one with no end).
    if (!unlimited && window !== 'in all') {
      const from = start > nowS ? start : nowS, until = end - from > 100n * 365n * 86_400n ? from + 100n * 365n * 86_400n : end;
      const periods = until > from ? (until - from + period - 1n) / period : 0n;
      const total = p.allowance! * periods;
      if (periods > 1n) b.detail(`In all${label}`, `up to ${isUnlimited(total) ? `unlimited ${symbol}` : amount(total)} over ${end >= UINT48_MAX ? 'the next century' : 'its window'} (${amount(p.allowance!)} ${window}, ${periods.toLocaleString('en-US')} periods)`, total.toString());
      // A period under an hour returns the allowance so often that it is no limit in practice.
      if (period < 3_600n && periods > 1n) b.warn('danger', 'spend_permission_unlimited', `Its allowance comes back every ${duration(period)}: ${shortAddress(p.spender)} may take ${amount(p.allowance!)} that often, which is no limit in practice: all of your ${symbol}.`);
    }
    // What it could take now: the allowance against the balance (no ERC-20 approval is needed: the manager has the account give one each time).
    if (chainId !== null && start <= nowS && nowS < end) {
      const name = `Can move now${label}`;
      if (isNative) await nativeCanMoveNow(env, b, chainId, account, unlimited ? UINT160_MAX : p.allowance!, native, name);
      else await canMoveNow(env, b, chainId, account, p.token, info, unlimited ? UINT160_MAX : p.allowance!, undefined, name);
    }
    // Revoked already: the signature can't approve it (approve returns false for a revoked permission).
    if (!batch && chainId !== null && manager === SPEND_PERMISSION_MANAGER) {
      const permission = { account: account as Hex, spender: p.spender as Hex, token: p.token as Hex, allowance: p.allowance!, period: Number(period), start: Number(start), end: Number(end), salt: p.salt ?? 0n, extraData: (p.extraData || '0x') as Hex };
      const [revoked] = await callWords(env, chainId, manager, encodeFunctionData({ abi: ABI, functionName: 'isRevoked', args: [permission] })) ?? [];
      const [approved] = revoked ? [] : await callWords(env, chainId, manager, encodeFunctionData({ abi: ABI, functionName: 'isApproved', args: [permission] })) ?? [];
      if (revoked === 1n) b.warn('info', 'spend_permission_revoked', 'This exact permission was revoked already: the signature can no longer approve it.');
      else if (approved === 1n) b.warn('info', 'spend_permission_approved', 'This exact permission is already approved on chain: signing it again changes nothing.');
    }
  }
  b.detail('Period', window === 'in all' ? 'none: the allowance is for the whole window' : duration(period), period.toString())
    .detail('From', formatTimestamp(Number(start) * 1000), start.toString())
    .detail('Until', end >= UINT48_MAX ? 'no end' : formatTimestamp(Number(end) * 1000), end.toString());
  if (end >= UINT48_MAX || end - nowS > 100n * 365n * 86_400n) b.warn('caution', 'spend_permission_no_expiry', `It has no end${end < UINT48_MAX ? ' in practice' : ''}: it lasts until you revoke it (revoke on the SpendPermissionManager, or in your wallet's settings).`);
  if (end <= nowS) b.warn('info', 'spend_permission_expired', 'Its time window has already ended: nothing can be spent with it.');
  else if (start > nowS) b.warn('info', 'spend_permission_not_started', `Nothing can be spent with it before ${formatTimestamp(Number(start) * 1000)}.`);
  if (period === 0n || start >= end) b.warn('info', 'spend_permission_invalid', 'The SpendPermissionManager refuses it as signed (a period of 0, or a start not before its end): it can never be approved.');
  const phrases = [...bySpender].map(([spender, amounts]) => `${shortAddress(spender)} take up to ${amounts.join(' and ')} ${window}`);
  b.note('An off-chain signature: it costs no gas and moves nothing now. Anyone can submit it to the SpendPermissionManager to approve it; then the spender can take up to the allowance each period, with no further signature, until it ends or you revoke it.');
  return {
    title: `Let ${phrases.join('; and ')} from your account`,
    summary: `A Coinbase Smart Wallet spend permission${items.length > 1 ? ` (${items.length} in one signature)` : ''}: ${phrases.join('; ')}, from ${formatTimestamp(Number(start) * 1000)}${end >= UINT48_MAX ? ', with no end' : ` until ${formatTimestamp(Number(end) * 1000)}`}.`,
    decoder: 'coinbase_spend_permission', status: 'full', b, network,
  };
};
