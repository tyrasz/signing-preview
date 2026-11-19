// ERC-7715 wallet_requestExecutionPermissions: a dApp asks the wallet for permissions to act for the user's account,
// each a typed permission (`permission: { type, isAdjustmentAllowed, data }`) with rules (`expiry`, `redeemer`, `payee`),
// granted to the dApp's session account (`to`). MetaMask grants them (its gator-permissions snap) by signing a
// Delegation (ERC-7710, src/typed-data/delegation.ts) from the account to `to`, with the caveats that
// @metamask/7715-permission-types 2.0.0 creates for each type (createNativeTokenStreamCaveats and the others; the rules'
// decoders for theirs), on DelegationManager 1.3.0's enforcers:
//   native-token-stream     NativeTokenStreamingEnforcer(initial, max, per second, start) + ExactCalldataEnforcer(0x)
//   native-token-periodic   NativeTokenPeriodTransferEnforcer(amount, period, start)      + ExactCalldataEnforcer(0x)
//   native-token-allowance  NativeTokenPeriodTransferEnforcer(amount, 2^256 - 1, start)   + ExactCalldataEnforcer(0x)
//   erc20-token-stream      ERC20StreamingEnforcer(token, initial, max, per second, start) + ValueLteEnforcer(0)
//   erc20-token-periodic    ERC20PeriodTransferEnforcer(token, amount, period, start)      + ValueLteEnforcer(0)
//   erc20-token-allowance   ERC20PeriodTransferEnforcer(token, amount, 2^256 - 1, start)   + ValueLteEnforcer(0)
//   token-approval-revocation  ApprovalRevocationEnforcer(flags: erc20Approve 1, erc721Approve 2,
//                              erc721SetApprovalForAll 4, permit2Approve 8, permit2Lockdown 16, permit2InvalidateNonces 32)
//   rules: expiry -> TimestampEnforcer(0, timestamp); redeemer -> RedeemerEnforcer(addresses);
//          payee -> AllowedCalldataEnforcer(4, recipient) for tokens, AllowedTargetsEnforcer(addresses) for native coin.
// A stream's missing initialAmount is 0, its missing maxAmount 2^256 - 1 (no cap), a missing startTime now (the snap's
// populatePermission). MetaMask also adds a NonceEnforcer caveat (its current nonce, for revoking all at once), left
// out here: it only ends a delegation.
// The delegation is then previewed as any other (its caveats read, "Can move now" for its caps), under a title that says
// what the permission is.
import { PreviewBuilder, attentionOf, formatTimestamp, formatUnits, isUnlimited, shortAddress } from './format.ts';
import { chainName, CHAINS } from './chains.ts';
import type { Dependencies, Preview, PreviewContext, TokenInfo } from './types.ts';
import { DELEGATION_MANAGER, delegationAdapter, duration } from './typed-data/delegation.ts';

const MAX = (1n << 256n) - 1n;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO = '0x0000000000000000000000000000000000000000';
const ENFORCER = {
  nativeStreaming: '0xd10b97905a320b13a0608f7e9cc506b56747df19', nativePeriod: '0x9bc0faf4aca5ae429f4c06aeeac517520cb16bd9',
  erc20Streaming: '0x56c97ae02f233b29fa03502ecc0457266d9be00e', erc20Period: '0x474e3ae7e169e940607cc624da8a15eb120139ab',
  approvalRevocation: '0xe264f1f09a19505a1ca1a86d5b01e8bfdb64324a', exactCalldata: '0x99f2e9bf15ce5ec84685604836f71ab835dbbded',
  valueLte: '0x92bf12322527caa612fd31a0e810472bbb106a8f', timestamp: '0x1046bb45c8d673d4ea75321280db34899413c069',
  redeemer: '0xe144b0b2618071b4e56f746313528a669c7e65c5', allowedCalldata: '0xc2b0d624c1c4319760c96503ba27c347f3260f55',
  allowedTargets: '0x7f20f61b1f09b08d970938f6fa563634d65c4eeb',
};
const REVOCATIONS = ['erc20Approve', 'erc721Approve', 'erc721SetApprovalForAll', 'permit2Approve', 'permit2Lockdown', 'permit2InvalidateNonces'];
const TYPES = ['native-token-stream', 'native-token-periodic', 'native-token-allowance', 'erc20-token-stream', 'erc20-token-periodic', 'erc20-token-allowance', 'token-approval-revocation'];
const RULES = ['expiry', 'redeemer', 'payee'];

const word = (v: bigint) => v.toString(16).padStart(64, '0');
const half = (v: bigint) => v.toString(16).padStart(32, '0');
const addressHex = (a: string) => a.slice(2).toLowerCase();
/** A hex quantity (the ERC's amounts), or a number; null when neither. */
const quantity = (v: unknown): bigint | null => {
  if (typeof v === 'string' && /^0x[0-9a-fA-F]+$/.test(v) && v.length <= 66) return BigInt(v);
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  return null;
};
const nameOf = (t: unknown) => typeof t === 'string' ? t : t && typeof t === 'object' && typeof (t as { name?: unknown }).name === 'string' ? (t as { name: string }).name : '';

class Malformed extends Error {}

/** One permission request: the delegation MetaMask would sign for it, and how to say what it is. */
async function permissionDelegation(req: Record<string, unknown>, chainId: number, from: string, to: string, deps: Dependencies, now: number) {
  const permission = req.permission as { type?: unknown; data?: Record<string, unknown> };
  const type = nameOf(permission.type), data = permission.data ?? {};
  const native = CHAINS[chainId]?.nativeSymbol ?? 'ETH';
  const need = (key: string, ok = (v: bigint) => v > 0n) => {
    const v = quantity(data[key]);
    if (v === null || !ok(v)) throw new Malformed(`its ${key} is missing or not a positive amount`);
    return v;
  };
  const optional = (key: string, fallback: bigint) => data[key] === undefined || data[key] === null ? fallback : need(key, () => true);
  // Times and periods are numbers of seconds in MetaMask's schema (zod numbers): a hex string or a huge value is refused.
  const seconds = (v: unknown, what: string) => {
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) throw new Malformed(`its ${what} isn't a positive number of seconds`);
    return BigInt(v);
  };
  const start = data.startTime === undefined || data.startTime === null ? BigInt(Math.floor(now / 1000)) : seconds(data.startTime, 'startTime');
  const token = async (): Promise<{ address: string; info?: TokenInfo }> => {
    const address = String(data.tokenAddress ?? '');
    if (!ADDRESS.test(address) || /^0x0{40}$/.test(address)) throw new Malformed('its tokenAddress is missing or not a token');
    let info: TokenInfo | undefined;
    try { info = (await deps.tokens?.get(chainId, address.toLowerCase())) ?? undefined; } catch { /* unnamed */ }
    return { address: address.toLowerCase(), info };
  };
  const coin = (v: bigint) => isUnlimited(v) ? `unlimited ${native}` : `${formatUnits(v, CHAINS[chainId]?.nativeDecimals ?? 18)} ${native}`;
  const tokenText = (v: bigint, t: { address: string; info?: TokenInfo }) => isUnlimited(v) ? `unlimited ${t.info?.symbol ?? 'tokens'}` : t.info ? `${formatUnits(v, t.info.decimals)} ${t.info.symbol}` : `${v} base units of ${shortAddress(t.address)}`;
  const per = (s: bigint) => s === 86_400n ? 'a day' : s === 604_800n ? 'a week' : s === 3_600n ? 'an hour' : `every ${duration(s)}`;
  const caveats: { enforcer: string; terms: string }[] = [];
  const warnings: [Preview['warnings'][number]['severity'], string, string][] = [];
  let what: string, erc20 = false;
  switch (type) {
    case 'native-token-stream':
    case 'erc20-token-stream': {
      erc20 = type.startsWith('erc20');
      const t = erc20 ? await token() : null;
      const initial = optional('initialAmount', 0n), max = optional('maxAmount', MAX), rate = need('amountPerSecond');
      if (max <= initial) throw new Malformed('its maxAmount is not more than its initialAmount');
      const text = (v: bigint) => t ? tokenText(v, t) : coin(v);
      caveats.push(t ? { enforcer: ENFORCER.erc20Streaming, terms: `0x${addressHex(t.address)}${word(initial)}${word(max)}${word(rate)}${word(start)}` }
        : { enforcer: ENFORCER.nativeStreaming, terms: `0x${word(initial)}${word(max)}${word(rate)}${word(start)}` });
      what = `take ${text(rate)} a second from your account${initial ? ` (${text(initial)} at once)` : ''}, ${isUnlimited(max) ? 'with no total cap' : `up to ${text(max)} in all`}`;
      if (isUnlimited(max)) warnings.push(['caution', 'permission_no_cap', `It has no total cap: ${text(rate * 86_400n)} more becomes available each day, for as long as it lasts${data.maxAmount === undefined || data.maxAmount === null ? ' (no maxAmount was given, and MetaMask then sets none)' : ''}.`]);
      break;
    }
    case 'native-token-periodic':
    case 'erc20-token-periodic':
    case 'native-token-allowance':
    case 'erc20-token-allowance': {
      erc20 = type.startsWith('erc20');
      const allowance = type.endsWith('allowance');
      const t = erc20 ? await token() : null;
      const amount = need(allowance ? 'allowanceAmount' : 'periodAmount');
      const period = allowance ? MAX : (() => { const p = seconds(data.periodDuration, 'periodDuration'); if (p > 315_360_000n) throw new Malformed('its periodDuration is over ten years'); return p; })();
      caveats.push(t ? { enforcer: ENFORCER.erc20Period, terms: `0x${addressHex(t.address)}${word(amount)}${word(period)}${word(start)}` }
        : { enforcer: ENFORCER.nativePeriod, terms: `0x${word(amount)}${word(period)}${word(start)}` });
      what = `spend up to ${t ? tokenText(amount, t) : coin(amount)}${allowance ? '' : ` ${per(period)}`} from your account`;
      break;
    }
    case 'token-approval-revocation': {
      const flags = REVOCATIONS.reduce((m, k, i) => data[k] === true ? m | (1 << i) : m, 0);
      if (!flags) throw new Malformed('it names no kind of approval to revoke');
      caveats.push({ enforcer: ENFORCER.approvalRevocation, terms: `0x${flags.toString(16).padStart(2, '0')}` });
      what = 'revoke approvals your account has given (it can only take permissions away)';
      break;
    }
    default:
      throw new Malformed(`its type, ${type}, isn't one this preview builds`);
  }
  // The other half of each kind: native coin only as plain transfers; tokens with no native coin sent.
  if (type.startsWith('native')) caveats.push({ enforcer: ENFORCER.exactCalldata, terms: '0x' });
  else if (erc20) caveats.push({ enforcer: ENFORCER.valueLte, terms: `0x${word(0n)}` });
  // Rules: those MetaMask takes for the type (SUPPORTED_RULE_TYPES), once each.
  const list = Array.isArray(req.rules) ? req.rules as { type?: unknown; data?: Record<string, unknown> }[] : [];
  const names = list.map(r => nameOf(r?.type));
  if (new Set(names).size !== names.length) throw new Malformed('it repeats a rule type');
  const supported = type === 'token-approval-revocation' ? ['expiry', 'redeemer'] : RULES;
  for (const n of names) if (!supported.includes(n)) throw new Malformed(`its "${n || 'unnamed'}" rule isn't one MetaMask takes for ${type} (${supported.join(', ')})`);
  for (const rule of list) {
    const name = nameOf(rule?.type), d = rule?.data ?? {};
    const addresses = Array.isArray(d.addresses) ? (d.addresses as unknown[]).filter((a): a is string => typeof a === 'string' && ADDRESS.test(a)).map(a => a.toLowerCase()) : [];
    if (name === 'expiry') caveats.push({ enforcer: ENFORCER.timestamp, terms: `0x${half(0n)}${half(seconds(d.timestamp, 'expiry timestamp'))}` });
    else {
      if (!addresses.length) throw new Malformed(`its ${name} rule names no addresses`);
      if (name === 'redeemer') caveats.push({ enforcer: ENFORCER.redeemer, terms: `0x${addresses.map(addressHex).join('')}` });
      else {
        caveats.push(erc20 ? { enforcer: ENFORCER.allowedCalldata, terms: `0x${word(4n)}${addressHex(addresses[0]).padStart(64, '0')}` }
          : { enforcer: ENFORCER.allowedTargets, terms: `0x${addresses.map(addressHex).join('')}` });
        what += `, paid only to ${addresses.map(shortAddress).join(', ')}`;
        if (erc20 && addresses.length > 1) warnings.push(['info', 'permission_payee_first', `Its payee rule names ${addresses.length} addresses; MetaMask's caveat for a token holds one, so only ${shortAddress(addresses[0])} is shown.`]);
      }
    }
  }
  const typed = {
    domain: { name: 'DelegationManager', version: '1', chainId, verifyingContract: DELEGATION_MANAGER },
    types: {
      EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
      Delegation: [{ name: 'delegate', type: 'address' }, { name: 'delegator', type: 'address' }, { name: 'authority', type: 'bytes32' }, { name: 'caveats', type: 'Caveat[]' }, { name: 'salt', type: 'uint256' }],
      Caveat: [{ name: 'enforcer', type: 'address' }, { name: 'terms', type: 'bytes' }],
    },
    primaryType: 'Delegation',
    message: { delegate: to, delegator: from, authority: `0x${'f'.repeat(64)}`, caveats, salt: '0' },
  };
  return { type, what, typed, warnings };
}

/** One request's preview. */
async function previewOne(raw: unknown, context: PreviewContext, deps: Dependencies, method: string): Promise<Preview> {
  const b = new PreviewBuilder();
  const req = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const permission = req.permission && typeof req.permission === 'object' ? req.permission as { type?: unknown; isAdjustmentAllowed?: unknown; data?: Record<string, unknown> } : null;
  const type = nameOf(permission?.type);
  let chainId: number | null = null;
  try { chainId = req.chainId !== undefined ? Number(BigInt(req.chainId as string)) : context.chainId ?? null; } catch { chainId = null; }
  const network = chainId !== null ? { kind: 'evm' as const, chainId, name: chainName(chainId) } : null;
  const to = typeof req.to === 'string' && ADDRESS.test(req.to) ? req.to.toLowerCase() : null;
  const named = typeof req.from === 'string' && ADDRESS.test(req.from) ? req.from.toLowerCase() : null;
  const from = named ?? (context.account && ADDRESS.test(context.account) ? context.account.toLowerCase() : null);
  const base = (title: string, summary: string, status: Preview['decoding']['status']): Preview => ({
    schema: 'signing-preview/1', method, kind: 'typed_data', network, title, summary, details: b.details, assetChanges: [], warnings: b.warnings, attention: attentionOf(b.warnings),
    decoding: { status, decoder: 'erc7715_permission', notes: b.notes },
  });
  b.detail('Permission', type || 'none named');
  if (to) b.detail('Granted to (the site\'s session account)', to);
  b.detail('From account', from ?? 'the account you choose in the wallet');
  const justification = permission?.data?.justification;
  if (typeof justification === 'string' && justification.trim()) b.detail('Reason given by the site', justification.trim().slice(0, 300));
  if (permission?.isAdjustmentAllowed === true) b.warn('info', 'permission_adjustable', 'The site lets the wallet change its amounts before granting it: what is shown is what was asked for.');
  if (named && context.account && named !== context.account.toLowerCase()) b.warn('danger', 'signer_mismatch', `The request asks ${named} to grant it, but the connected account is ${context.account}.`);
  if (chainId !== null && context.chainId && context.chainId !== chainId) b.warn('caution', 'chain_mismatch', `The permission is for ${chainName(chainId)}, but the wallet is on ${chainName(context.chainId)}.`);
  if (!from) b.warn('info', 'permission_account_unknown', 'The request names no account, so the wallet asks you to choose one: what it can move now is read once one is named.');
  b.note("A permission request (ERC-7715): nothing is sent now. The wallet grants it by signing a delegation (ERC-7710) from your account to the site's session account, which then redeems it through MetaMask's DelegationManager to make the calls it allows. The caveats below are those MetaMask creates for this permission and its rules (it also adds a nonce caveat, which lets you revoke all your permissions at once).");
  if (!permission || !to || chainId === null) {
    b.warn('caution', 'permission_malformed', `The request is incomplete (${[!permission && 'no permission', !to && 'no session account (to)', chainId === null && 'no chain'].filter(Boolean).join(', ')}): the wallet will refuse it.`);
    return base('Malformed permission request', 'A permission request (ERC-7715) that is missing what it needs.', 'opaque');
  }
  if (!TYPES.includes(type)) {
    b.warn('caution', 'permission_type_unknown', `"${type || 'unnamed'}" isn't a permission type this preview knows (${TYPES.join(', ')}): the wallet decides what it signs for it, and what that allows isn't shown here.`);
    return base(`Grant ${shortAddress(to)} a "${type || 'unnamed'}" permission`, `A permission request (ERC-7715) of a type this preview doesn't know, from your account to ${shortAddress(to)}.`, 'opaque');
  }
  let built;
  try { built = await permissionDelegation(req, chainId, from ?? ZERO, to, deps, context.now ?? Date.now()); } catch (error) {
    if (!(error instanceof Malformed)) throw error;
    b.warn('caution', 'permission_malformed', `The ${type} permission can't be granted as asked: ${error.message}. MetaMask refuses it.`);
    return base(`Malformed ${type} permission`, `A ${type} permission request (ERC-7715) that the wallet would refuse.`, 'partial');
  }
  // The delegation, previewed as signed: its caveats, warnings and exposure; without an account, no balance to read.
  const env = { deps: from ? deps : { ...deps, rpc: undefined }, context, signer: from, now: context.now ?? Date.now() };
  const d = (await delegationAdapter(built.typed, env))!;
  for (const [severity, code, message] of built.warnings) b.warn(severity, code, message);
  for (const w of d.b.warnings) b.warn(w.severity, w.code, w.message);
  for (const det of d.b.details) if (!['Salt', 'Account (delegator)', 'Delegate', 'Authority'].includes(det.label)) b.details.push(det);
  for (const n of d.b.notes) if (!/^This is an off-chain signature/.test(n)) b.note(n);
  return { ...base(`Let ${shortAddress(to)} ${built.what}`, `An ERC-7715 permission (${type}) for ${shortAddress(to)}, granted by a delegation from ${from ? `your account ${shortAddress(from)}` : 'the account you choose'}${caveatsDuring(built.typed.message.caveats)}.`, d.status), ...(d.assetChanges && { assetChanges: d.assetChanges }) };
}

const caveatsDuring = (caveats: { enforcer: string; terms: string }[]) => {
  const t = caveats.find(c => c.enforcer === ENFORCER.timestamp);
  return t ? `, until ${formatTimestamp(Number(BigInt(`0x${t.terms.slice(34)}`)) * 1000)}` : ', with no expiry';
};

/** wallet_requestExecutionPermissions: params is the array of permission requests. */
export async function previewPermissionRequests(method: string, params: unknown[], context: PreviewContext, deps: Dependencies): Promise<Preview> {
  const requests = params.length === 1 && Array.isArray(params[0]) ? params[0] as unknown[] : params;
  if (!requests.length) {
    const b = new PreviewBuilder().warn('caution', 'permission_malformed', 'The request asks for no permissions.');
    return { schema: 'signing-preview/1', method, kind: 'typed_data', network: null, title: 'Empty permission request', summary: 'A permission request (ERC-7715) with no permissions.', details: [], assetChanges: [], warnings: b.warnings, attention: attentionOf(b.warnings), decoding: { status: 'opaque', decoder: 'erc7715_permission', notes: [] } };
  }
  const previews: Preview[] = [];
  for (const r of requests.slice(0, 16)) previews.push(await previewOne(r, context, deps, method));
  if (previews.length === 1 && requests.length === 1) return previews[0];
  const b = new PreviewBuilder();
  if (requests.length > 16) b.warn('caution', 'permission_many', `It asks for ${requests.length} permissions; the first 16 are shown.`);
  const warnings = [...b.warnings, ...previews.flatMap((p, i) => p.warnings.map(w => ({ ...w, message: `Permission ${i + 1}: ${w.message}` })))];
  const statuses = previews.map(p => p.decoding.status);
  const networks = new Set(previews.map(p => p.network?.kind === 'evm' ? p.network.chainId : null));
  return {
    schema: 'signing-preview/1', method, kind: 'typed_data', network: networks.size === 1 ? previews[0].network : null,
    title: `${requests.length} permissions: ${previews.map(p => p.title).join('; ')}`,
    summary: `A request (ERC-7715) for ${requests.length} permissions, each granted by its own delegation. ${previews.map((p, i) => `(${i + 1}) ${p.summary}`).join(' ')}`,
    details: [], assetChanges: previews.flatMap(p => p.assetChanges), warnings, attention: attentionOf(warnings),
    decoding: { status: statuses.every(s => s === 'full') ? 'full' : statuses.every(s => s === 'opaque') ? 'opaque' : 'partial', decoder: 'erc7715_permission', notes: b.notes },
    calls: previews,
  };
}
