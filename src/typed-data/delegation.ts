// MetaMask's Delegation Framework (ERC-7710): a smart account (a DeleGator: MetaMask's smart accounts, or an EOA
// delegating to one through EIP-7702) signs a Delegation as EIP-712 typed data, under DelegationManager 1.3.0's domain
// (name "DelegationManager", version "1", verified on Sourcify; the same address on every chain here but HyperEVM):
//   Delegation(address delegate, address delegator, bytes32 authority, Caveat[] caveats, uint256 salt)
//   Caveat(address enforcer, bytes terms)
// The delegate (or anyone, where it is ANY_DELEGATE, 0xa11) then redeems it through the DelegationManager
// (redeemDelegations), which has the delegator execute calls of the redeemer's choosing (executeFromExecutor), each
// checked by the caveats' enforcers before and after. Without a caveat that restricts what is called, the delegate can
// make any call as the account. `authority` is ROOT_AUTHORITY for the delegator's own authority, else the hash of a
// delegation the delegator holds, which this one passes on (the redeemer presents the chain).
// The enforcers here are the 37 of DelegationManager 1.3.0's deployment (its documents/Deployments.md; the same
// addresses on every chain), each verified on Sourcify and read for the layout of its terms (getTermsInfo), but the
// three MultiOperationIncreaseBalance enforcers other than ERC-20's, not on Sourcify, whose getTermsInfo was called on
// Ethereum instead; and an earlier ERC20StreamingEnforcer (0xe475…1a8d, the same source) still in use. Checked against
// real delegations (scripts kept out of the repo): 220 redeemed on Ethereum, Arbitrum One, BNB Chain, Base and Sepolia
// (RedeemedDelegation events, 2026-11-19), each signature recovering, over the digest computed here, to its delegator
// (an EIP-7702 account) or its owner (a HybridDeleGator).
import { decodeAbiParameters, toFunctionSelector, type Hex } from 'viem';
import { formatTimestamp, formatUnits, isUnlimited, PreviewBuilder, shortAddress } from '../format.ts';
import { chainName, CHAINS } from '../chains.ts';
import { COMMON_SIGNATURES } from '../abi.ts';
import { normalizeTransaction, previewTransaction } from '../evm/transaction.ts';
import type { ApprovalChange, AssetChange, Preview, TokenInfo } from '../types.ts';
import { big, domainChainId, str, type TypedAdapter, type TypedEnv } from './common.ts';
import { canMoveNow } from './exposure.ts';

export const DELEGATION_MANAGER = '0xdb9b1e94b5b69df7e401ddbede43491141047db3';
const ANY_DELEGATE = '0x0000000000000000000000000000000000000a11';
const ROOT_AUTHORITY = `0x${'f'.repeat(64)}`;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** An end (a timestamp, a block) this far off is none: 2^40 seconds is past the year 36,000. */
const FAR = 1n << 40n;
/** The addresses MetaMask redeems its users' permissions from (@metamask/7715-permission-types 2.0.0's METAMASK_FACILITATOR_ADDRESSES). */
export const METAMASK_FACILITATORS = new Set(['0xb01caea8c6c47bbf4f4b4c5080ca642043359c2e', '0xc066ac5d385419b1a8c43a0e146fa439837a8b8c', '0xb42f812a44c22cc6b861478900401ee759ebead6']);
const HEX = /^0x([0-9a-fA-F]{2})*$/;

/** What a caveat does to a delegation: its text, and what kind of rule it is. */
interface CaveatRead {
  name: string; text: string;
  /**
   * `scope`: it restricts the calls the delegate can make (their targets, functions or data): without one, any call;
   * `limit`: it bounds amounts (value sent, a balance's change) but not what is called; `condition`: when or by whom.
   */
  kind: 'scope' | 'limit' | 'condition';
  /** The exact calls it allows (ExactExecution, ExactExecutionBatch). */
  exact?: { target: string; value: bigint; data: Hex }[];
  /** Its validity window (TimestampEnforcer): seconds, 0 for none. */
  window?: { after: bigint; before: bigint };
  /** ERC-20 amounts the delegate can move (ERC20TransferAmount, ERC20Streaming's most, a period's): checked against the balance. */
  tokens?: { address: string; amount: bigint }[];
  /** It ends: a block number after which it can't be redeemed (BlockNumberEnforcer). */
  expires?: boolean;
  /** Native coin the delegate can send (NativeTokenTransferAmount, a period's, a stream's most): checked against the balance. */
  native?: bigint;
  /** How many times it can be redeemed: once (IdEnforcer), or a count (LimitedCallsEnforcer). */
  once?: boolean; redemptions?: bigint;
  /** A scope that names functions or data but not the contract they are called on. */
  anyContract?: boolean;
  /** The only contracts it may call (AllowedTargetsEnforcer), whatever the function and value. */
  targets?: string[];
  /** Functions it allows with any arguments, or data checked only in part (AllowedMethods, AllowedCalldata): open-ended. */
  open?: boolean;
  /** The only functions it may call (AllowedMethodsEnforcer). */
  selectors?: string[];
  /** Only calls with no data: plain transfers of native coin, to any address (ExactCalldataEnforcer with empty terms). */
  plain?: boolean;
  /** It bounds the native coin sent with the calls (ValueLte, NativeTokenTransferAmount, a period's, a stream's, a balance's fall). */
  nativeLimit?: boolean;
  /** Caveats inside it that this preview doesn't know (LogicalOrWrapperEnforcer's groups). */
  unread?: number;
  /** The only addresses that may redeem it (RedeemerEnforcer). */
  redeemers?: string[];
}

const word = (t: string, at: number) => BigInt(`0x${t.slice(at * 2, at * 2 + 64)}`);
const addr = (t: string, at: number) => `0x${t.slice(at * 2, at * 2 + 40)}`.toLowerCase();
const KNOWN_SELECTORS = new Map<string, string>([...COMMON_SIGNATURES, 'transfer(address to, uint256 amount)', 'approve(address spender, uint256 amount)', 'transferFrom(address from, address to, uint256 amount)', 'setApprovalForAll(address operator, bool approved)', 'permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)']
  .map(sig => { try { return [toFunctionSelector(`function ${sig}`), sig.replace(/\(.*/, '')] as [string, string]; } catch { return null; } }).filter((x): x is [string, string] => !!x));

/** Each enforcer's reading of its terms (hex without 0x), with token info where it names a token. */
type Reader = (t: string, token: (address: string) => Promise<TokenInfo | undefined>, native: string) => Promise<CaveatRead> | CaveatRead;
const amountOf = (raw: bigint, info: TokenInfo | undefined, address: string) => isUnlimited(raw) ? `unlimited ${info?.symbol ?? 'tokens'}` : info ? `${formatUnits(raw, info.decimals)} ${info.symbol}` : `${raw} base units of ${shortAddress(address)}`;
const nativeOf = (raw: bigint, native: string) => isUnlimited(raw) ? `unlimited ${native}` : `${formatUnits(raw, 18)} ${native}`;
const balanceChange = (what: 'native' | 'erc20' | 'erc721' | 'erc1155'): Reader => async (t, token, native) => {
  const decrease = parseInt(t.slice(0, 2), 16) !== 0;
  const asset = what === 'native' ? null : addr(t, 1), who = addr(t, what === 'native' ? 1 : 21);
  const id = what === 'erc1155' ? word(t, 41) : undefined, amount = word(t, what === 'native' ? 21 : what === 'erc1155' ? 73 : 41);
  const info = asset ? await token(asset) : undefined;
  const thing = what === 'native' ? nativeOf(amount, native) : what === 'erc20' ? amountOf(amount, info, asset!) : `${amount} ${what === 'erc721' ? 'NFT' : `of token ${id}`} of ${shortAddress(asset!)}`;
  return { name: `${what === 'native' ? 'Native' : what === 'erc20' ? 'ERC20' : what === 'erc721' ? 'ERC721' : 'ERC1155'}BalanceChangeEnforcer`, kind: 'limit',
    ...(what === 'native' && decrease && { nativeLimit: true }),
    text: decrease ? `each time it is redeemed, ${shortAddress(who)}'s balance may fall by at most ${thing}` : `each time it is redeemed, ${shortAddress(who)}'s balance must rise by at least ${thing}` };
};
async function erc20Streaming(t: string, token: (address: string) => Promise<TokenInfo | undefined>): Promise<CaveatRead> {
  const address = addr(t, 0), initial = word(t, 20), max = word(t, 52), rate = word(t, 84), start = word(t, 116), info = await token(address);
  return { name: 'ERC20StreamingEnforcer', kind: 'scope', tokens: [{ address, amount: max }], text: `only transfer() calls on ${info?.symbol ?? shortAddress(address)}: ${amountOf(initial, info, address)} from ${formatTimestamp(Number(start) * 1000)}, then ${amountOf(rate, info, address)} more each second, ${amountOf(max, info, address)} at most` };
}
/** A period, as "day", "7 days", "hour", "90 seconds". */
/** "each day", or "in all" for a period that never ends (MetaMask's allowances use 2^256 - 1). */
export const every = (s: bigint) => s >= 1n << 64n ? 'in all' : `each ${duration(s)}`;
export const duration = (s: bigint) => {
  const [n, unit] = s > 0n && s % 86_400n === 0n ? [s / 86_400n, 'day'] : s > 0n && s % 3_600n === 0n ? [s / 3_600n, 'hour'] : [s, 'second'];
  return n === 1n ? unit : `${n} ${unit}s`;
};
const pad = (v: string | bigint) => (typeof v === 'bigint' ? v.toString(16) : v.slice(2)).padStart(64, '0');
/**
 * Functions through which a call runs any other call as the account: its own execute (ERC-7579, and the DeleGator's
 * earlier execute(Execution)), executeFromExecutor, the DelegationManager's redeemDelegations (with no delegations it
 * has the caller run the calls), and an upgrade of the account's code.
 */
const GATEWAY_SELECTORS = new Map(['execute(bytes32 mode, bytes executionCalldata)', 'executeFromExecutor(bytes32 mode, bytes executionCalldata)', 'execute((address target, uint256 value, bytes callData) execution)', 'executeBatch((address target, uint256 value, bytes callData)[] executions)', 'redeemDelegations(bytes[] permissionContexts, bytes32[] modes, bytes[] executionCallDatas)', 'upgradeToAndCall(address implementation, bytes data)']
  .map(sig => [toFunctionSelector(`function ${sig}`), sig.replace(/\(.*/, '')] as [string, string]));
export const ENFORCERS: Record<string, { name: string; read: Reader }> = {
  '0x7f20f61b1f09b08d970938f6fa563634d65c4eeb': { name: 'AllowedTargetsEnforcer', read: t => {
    const targets = Array.from({ length: Math.floor(t.length / 40) }, (_, i) => addr(t, i * 20));
    return { name: 'AllowedTargetsEnforcer', kind: 'scope', targets, text: `calls only to ${targets.map(shortAddress).join(', ')}` };
  } },
  '0x2c21fd0cb9dc8445cb3fb0dc5e7bb0aca01842b5': { name: 'AllowedMethodsEnforcer', read: t => {
    const sels = Array.from({ length: Math.floor(t.length / 8) }, (_, i) => `0x${t.slice(i * 8, i * 8 + 8)}`);
    return { name: 'AllowedMethodsEnforcer', kind: 'scope', anyContract: true, open: true, selectors: sels, text: `only the functions ${sels.map(s => KNOWN_SELECTORS.has(s) ? `${KNOWN_SELECTORS.get(s)} (${s})` : s).join(', ')}` };
  } },
  '0xc2b0d624c1c4319760c96503ba27c347f3260f55': { name: 'AllowedCalldataEnforcer', read: t => {
    const start = word(t, 0), value = `0x${t.slice(64)}`;
    const named = start === 0n && value.length === 10 && KNOWN_SELECTORS.get(value);
    // A whole argument word: the nth argument, shown as an address where it is one.
    const nth = start >= 4n && (start - 4n) % 32n === 0n && value.length === 66 ? Number((start - 4n) / 32n) + 1 : 0;
    const arg = nth && (/^0x0{24}/.test(value) && !/^0x0{64}$/.test(value) ? shortAddress(`0x${value.slice(26)}`) : BigInt(value).toString());
    return { name: 'AllowedCalldataEnforcer', kind: 'scope', anyContract: true, open: true, text: named ? `only the function ${named} (${value})` : arg ? `the call's ${['first', 'second', 'third', 'fourth'][nth - 1] ?? `${nth}th`} argument must be ${arg}` : `the call's data from byte ${start} must be ${value.length > 2 + 66 * 2 ? `${value.slice(0, 66)}… (${(value.length - 2) / 2} bytes)` : value}` };
  } },
  '0x99f2e9bf15ce5ec84685604836f71ab835dbbded': { name: 'ExactCalldataEnforcer', read: (t, _, native) => !t ? { name: 'ExactCalldataEnforcer', kind: 'scope', plain: true, text: `no call data: only plain ${native} transfers, to any address` } : ({ name: 'ExactCalldataEnforcer', kind: 'scope', anyContract: true, text: `the call's data must be exactly ${t.length > 132 ? `0x${t.slice(0, 64)}… (${t.length / 2} bytes)` : `0x${t}`}, to any contract, with any value, unless other caveats limit those` }) },
  '0x146713078d39ecc1f5338309c28405ccf85abfbb': { name: 'ExactExecutionEnforcer', read: (t, _, native) => {
    const exact = { target: addr(t, 0), value: word(t, 20), data: `0x${t.slice(104)}` as Hex };
    return { name: 'ExactExecutionEnforcer', kind: 'scope', exact: [exact], text: `exactly one call: to ${shortAddress(exact.target)}${exact.value ? `, sending ${nativeOf(exact.value, native)}` : ''}, data ${exact.data.length > 2 + 72 ? `${exact.data.slice(0, 10)}… (${(exact.data.length - 2) / 2} bytes)` : exact.data}` };
  } },
  '0x1e141e455d08721dd5bcda1baa6ea5633afd5017': { name: 'ExactExecutionBatchEnforcer', read: (t, _, native) => {
    const [executions] = decodeAbiParameters([{ type: 'tuple[]', components: [{ name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'callData', type: 'bytes' }] }], `0x${t}`);
    const exact = executions.map(e => ({ target: e.target.toLowerCase(), value: e.value, data: e.callData }));
    return { name: 'ExactExecutionBatchEnforcer', kind: 'scope', exact, text: `exactly these ${exact.length} calls: ${exact.map(e => `to ${shortAddress(e.target)} (${e.data.length > 2 ? e.data.slice(0, 10) : 'no data'}${e.value ? `, sending ${nativeOf(e.value, native)}` : ''})`).join('; ')}` };
  } },
  '0xf100b0819427117ecf76ed94b358b1a5b5c6d2fc': { name: 'ERC20TransferAmountEnforcer', read: async (t, token) => {
    const address = addr(t, 0), amount = word(t, 20), info = await token(address);
    return { name: 'ERC20TransferAmountEnforcer', kind: 'scope', tokens: [{ address, amount }], text: `only transfer() calls on ${info?.symbol ?? shortAddress(address)}, ${amountOf(amount, info, address)} in all` };
  } },
  '0xe475d14d61756d6e940b74c20d2e44eb70c71a8d': { name: 'ERC20StreamingEnforcer', read: async (t, token) => erc20Streaming(t, token) },
  '0x56c97ae02f233b29fa03502ecc0457266d9be00e': { name: 'ERC20StreamingEnforcer', read: async (t, token) => erc20Streaming(t, token) },
  '0x474e3ae7e169e940607cc624da8a15eb120139ab': { name: 'ERC20PeriodTransferEnforcer', read: async (t, token) => {
    const address = addr(t, 0), amount = word(t, 20), period = word(t, 52), start = word(t, 84), info = await token(address);
    return { name: 'ERC20PeriodTransferEnforcer', kind: 'scope', tokens: [{ address, amount }], text: `only transfer() calls on ${info?.symbol ?? shortAddress(address)}: ${amountOf(amount, info, address)} ${every(period)}, from ${formatTimestamp(Number(start) * 1000)}` };
  } },
  '0xfb2f1a9bd76d3701b730e5d69c3219d42d80ebb7': { name: 'MultiTokenPeriodEnforcer', read: async (t, token, native) => {
    const configs = await Promise.all(Array.from({ length: Math.floor(t.length / 232) }, async (_, i) => {
      const o = i * 116, address = addr(t, o), amount = word(t, o + 20), period = word(t, o + 52), start = word(t, o + 84);
      const nativeCoin = /^0x0{40}$/.test(address), info = nativeCoin ? undefined : await token(address);
      return { address, amount, nativeCoin, text: `${nativeCoin ? nativeOf(amount, native) : amountOf(amount, info, address)} ${every(period)} from ${formatTimestamp(Number(start) * 1000)}` };
    }));
    // Each configuration has its own allowance (the redeemer picks one by index): two for one token add up.
    const sum = new Map<string, bigint>();
    for (const c of configs) sum.set(c.address, (sum.get(c.address) ?? 0n) + c.amount);
    const nativeCap = configs.some(c => c.nativeCoin) ? sum.get('0x0000000000000000000000000000000000000000') : undefined;
    const erc20 = configs.some(c => !c.nativeCoin);
    return { name: 'MultiTokenPeriodEnforcer', kind: 'scope', tokens: [...sum].filter(([a]) => !/^0x0{40}$/.test(a)).map(([address, amount]) => ({ address, amount })), ...(nativeCap !== undefined && { native: nativeCap, nativeLimit: true }),
      text: `only ${[erc20 && 'transfer() calls on these tokens', nativeCap !== undefined && `plain ${native} transfers`].filter(Boolean).join(', or ')}, up to: ${configs.map(c => c.text).join('; ')}` };
  } },
  '0x3790e6b7233f779b09da74c72b6e94813925b9af': { name: 'ERC721TransferEnforcer', read: t => ({ name: 'ERC721TransferEnforcer', kind: 'scope', text: `only transferring NFT #${word(t, 20)} of ${shortAddress(addr(t, 0))} (transferFrom or safeTransferFrom), to anyone` }) },
  '0x7eef9734e7092032b5c56310eb9bbd1f4a524681': { name: 'OwnershipTransferEnforcer', read: t => ({ name: 'OwnershipTransferEnforcer', kind: 'scope', text: `only transferOwnership() on ${shortAddress(addr(t, 0))}: the delegate can make anyone that contract's owner` }) },
  '0xe264f1f09a19505a1ca1a86d5b01e8bfdb64324a': { name: 'ApprovalRevocationEnforcer', read: t => {
    const flags = parseInt(t.slice(0, 2) || '0', 16);
    const kinds = ['ERC-20 approve(spender, 0)', "an NFT's approve(0x0, id)", 'setApprovalForAll(operator, false)', "Permit2's approve(token, spender, 0, 0)", "Permit2's lockdown", "Permit2's invalidateNonces"].filter((_, i) => flags & (1 << i));
    return { name: 'ApprovalRevocationEnforcer', kind: 'scope', text: `only revoking approvals your account has given: ${kinds.join(', ') || 'none'}` };
  } },
  '0x6649b61c873f6f9686a1e1ae9ee98ac380c7ba13': { name: 'SpecificActionERC20TransferBatchEnforcer', read: async (t, token, native) => {
    const address = addr(t, 0), recipient = addr(t, 20), amount = word(t, 40), first = { target: addr(t, 72), value: word(t, 92), data: `0x${t.slice(248)}` as Hex };
    const transfer = { target: address, value: 0n, data: `0xa9059cbb${pad(recipient)}${pad(amount)}` as Hex }, info = await token(address);
    return { name: 'SpecificActionERC20TransferBatchEnforcer', kind: 'scope', exact: [first, transfer], once: true,
      text: `once, exactly these 2 calls: to ${shortAddress(first.target)} (${first.data.length > 2 ? first.data.slice(0, 10) : 'no data'}${first.value ? `, sending ${nativeOf(first.value, native)}` : ''}), then a transfer of ${amountOf(amount, info, address)} to ${shortAddress(recipient)}` };
  } },
  '0x982fd5c86bbf425d7d1451f974192d4525113dfd': { name: 'ExactCalldataBatchEnforcer', read: t => {
    const [executions] = decodeAbiParameters([{ type: 'tuple[]', components: [{ name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'callData', type: 'bytes' }] }], `0x${t}`);
    return { name: 'ExactCalldataBatchEnforcer', kind: 'scope', anyContract: true, text: `a batch of exactly ${executions.length} calls with this data: ${executions.map(e => e.callData.length > 2 ? `${e.callData.slice(0, 10)}… (${(e.callData.length - 2) / 2} bytes)` : 'no data').join('; ')}; to any contracts, with any value, unless other caveats limit those` };
  } },
  '0x5d9818df0ae3f66e9c3d0c5029daf99d1823ca6c': { name: 'BlockNumberEnforcer', read: t => {
    const after = BigInt(`0x${t.slice(0, 32)}`), before = BigInt(`0x${t.slice(32, 64)}`);
    return { name: 'BlockNumberEnforcer', kind: 'condition', expires: before > 0n && before < FAR, text: `usable ${after ? `after block ${after}` : ''}${after && before ? ' and ' : ''}${before ? `before block ${before}` : ''}${!after && !before ? 'at any block' : ''}` };
  } },
  '0x24ff2aa430d53a8cd6788018e902e098083dccd2': { name: 'DeployedEnforcer', read: t => ({ name: 'DeployedEnforcer', kind: 'condition', text: `first deploys a contract at ${shortAddress(addr(t, 0))} (salt 0x${t.slice(40, 104)}, ${(t.length - 104) / 2} bytes of code), if none is there` }) },
  '0x44b8c6ae3c304213c3e298495e12497ed3e56e41': { name: 'ArgsEqualityCheckEnforcer', read: t => ({ name: 'ArgsEqualityCheckEnforcer', kind: 'condition', text: `the redeemer must pass ${t.length > 64 ? `0x${t.slice(0, 64)}… (${t.length / 2} bytes)` : `0x${t}`} with it (a check made by the contract redeeming it)` }) },
  '0x4803a326dded6ddbc60e659e5ed12d85c7582811': { name: 'NativeTokenPaymentEnforcer', read: (t, _, native) => ({ name: 'NativeTokenPaymentEnforcer', kind: 'condition', text: `whoever redeems it must pay ${nativeOf(word(t, 20), native)} to ${shortAddress(addr(t, 0))}` }) },
  '0xd10b97905a320b13a0608f7e9cc506b56747df19': { name: 'NativeTokenStreamingEnforcer', read: (t, _, native) => {
    const initial = word(t, 0), max = word(t, 32), rate = word(t, 64), start = word(t, 96);
    return { name: 'NativeTokenStreamingEnforcer', kind: 'limit', native: max, nativeLimit: true, text: `${native} sent with the calls: ${nativeOf(initial, native)} from ${formatTimestamp(Number(start) * 1000)}, then ${nativeOf(rate, native)} more each second, ${nativeOf(max, native)} at most` };
  } },
  '0xeaa1be91f0ea417820a765df9c5be542286bffdc': { name: 'ERC20MultiOperationIncreaseBalanceEnforcer', read: async (t, token) => {
    const address = addr(t, 0), info = await token(address);
    return { name: 'ERC20MultiOperationIncreaseBalanceEnforcer', kind: 'limit', text: `${shortAddress(addr(t, 20))}'s balance must rise by at least ${amountOf(word(t, 40), info, address)} over the whole redemption` };
  } },
  '0x44877cdafc0d529ab144bb6b0e202ee377c90229': { name: 'ERC721MultiOperationIncreaseBalanceEnforcer', read: t => ({ name: 'ERC721MultiOperationIncreaseBalanceEnforcer', kind: 'limit', text: `${shortAddress(addr(t, 20))} must hold at least ${word(t, 40)} more NFTs of ${shortAddress(addr(t, 0))} after the whole redemption` }) },
  '0x9eb86bbdaa71d4d8d5fb1b8a9457f04d3344797b': { name: 'ERC1155MultiOperationIncreaseBalanceEnforcer', read: t => ({ name: 'ERC1155MultiOperationIncreaseBalanceEnforcer', kind: 'limit', text: `${shortAddress(addr(t, 20))}'s balance of token ${word(t, 40)} of ${shortAddress(addr(t, 0))} must rise by at least ${word(t, 72)} over the whole redemption` }) },
  '0xad551e9b971c1b0c02c577bffcfaa20b81777276': { name: 'NativeTokenMultiOperationIncreaseBalanceEnforcer', read: (t, _, native) => ({ name: 'NativeTokenMultiOperationIncreaseBalanceEnforcer', kind: 'limit', text: `${shortAddress(addr(t, 0))}'s balance must rise by at least ${nativeOf(word(t, 20), native)} over the whole redemption` }) },
  '0xe1302607a3251af54c3a6e69318d6aa07f5eb46c': { name: 'LogicalOrWrapperEnforcer', read: async (t, token, native) => {
    // Groups of caveats, of which the redeemer picks one: it restricts the calls only if every group does.
    const [groups] = decodeAbiParameters([{ type: 'tuple[]', components: [{ name: 'caveats', type: 'tuple[]', components: [{ name: 'enforcer', type: 'address' }, { name: 'terms', type: 'bytes' }, { name: 'args', type: 'bytes' }] }] }], `0x${t}`);
    const read = await Promise.all(groups.map(g => Promise.all(g.caveats.map(async c => { const e = ENFORCERS[c.enforcer.toLowerCase()]; try { return e ? await e.read(c.terms.slice(2).toLowerCase(), token, native) : null; } catch { return null; } }))));
    const scoped = read.length > 0 && read.every(g => g.some(r => r?.kind === 'scope'));
    // The redeemer picks the group that allows most: what any group leaves open, the whole leaves open.
    const scopesOf = (g: (CaveatRead | null)[]) => g.filter((r): r is CaveatRead => r?.kind === 'scope');
    const targetOnly = read.filter(g => scopesOf(g).length && scopesOf(g).every(r => r.targets));
    return { name: 'LogicalOrWrapperEnforcer', kind: scoped ? 'scope' : 'condition', unread: read.flat().filter(r => !r).length,
      anyContract: read.some(g => scopesOf(g).length > 0 && scopesOf(g).every(r => r.anyContract)),
      open: read.some(g => scopesOf(g).length > 0 && scopesOf(g).every(r => r.anyContract) && scopesOf(g).some(r => r.open)),
      ...(targetOnly.length && { targets: [...new Set(targetOnly.flatMap(g => scopesOf(g).flatMap(r => r.targets!)))] }),
      selectors: [...new Set(read.flat().flatMap(r => r?.selectors ?? []))],
      plain: read.some(g => scopesOf(g).length > 0 && scopesOf(g).every(r => r.plain)),
      nativeLimit: read.length > 0 && read.every(g => g.some(r => r?.nativeLimit)),
      text: `the redeemer picks one of ${groups.length} groups of caveats: ${read.map((g, i) => `(${i + 1}) ${g.length ? g.map((r, j) => r ? `${r.name}: ${r.text}` : `an enforcer this preview doesn't know (${groups[i].caveats[j].enforcer.toLowerCase()})`).join('; ') : 'no caveats'}`).join(' ')}` };
  } },
  '0x9bc0faf4aca5ae429f4c06aeeac517520cb16bd9': { name: 'NativeTokenPeriodTransferEnforcer', read: (t, _, native) => {
    const amount = word(t, 0), period = word(t, 32), start = word(t, 64);
    // It checks only the value each call sends, not what is called (its comment expects no call data, but nothing
    // checks that: MetaMask pairs it with ExactCalldataEnforcer(0x)).
    return { name: 'NativeTokenPeriodTransferEnforcer', kind: 'limit', native: amount, nativeLimit: true, text: `${native} sent with the calls: ${nativeOf(amount, native)} ${every(period)}, from ${formatTimestamp(Number(start) * 1000)}` };
  } },
  '0xf71af580b9c3078fbc2bbf16fbb8eed82b330320': { name: 'NativeTokenTransferAmountEnforcer', read: (t, _, native) => {
    const amount = word(t, 0);
    return { name: 'NativeTokenTransferAmountEnforcer', kind: 'limit', native: amount, nativeLimit: true, text: `${nativeOf(amount, native)} sent with the calls, in all` };
  } },
  '0x92bf12322527caa612fd31a0e810472bbb106a8f': { name: 'ValueLteEnforcer', read: (t, _, native) => ({ name: 'ValueLteEnforcer', kind: 'limit', nativeLimit: true, text: `at most ${nativeOf(word(t, 0), native)} sent with each call` }) },
  '0xbd7b277507723490cd50b12eaafe87c616be6880': { name: 'NativeBalanceChangeEnforcer', read: balanceChange('native') },
  '0xcdf6ab796408598cea671d79506d7d48e97a5437': { name: 'ERC20BalanceChangeEnforcer', read: balanceChange('erc20') },
  '0x8afdf96edbbe7e1ed3f5cd89c7e084841e12a09e': { name: 'ERC721BalanceChangeEnforcer', read: balanceChange('erc721') },
  '0x63c322732695cafbbd488fc6937a0a7b66fc001a': { name: 'ERC1155BalanceChangeEnforcer', read: balanceChange('erc1155') },
  '0x1046bb45c8d673d4ea75321280db34899413c069': { name: 'TimestampEnforcer', read: t => {
    const after = BigInt(`0x${t.slice(0, 32)}`), before = BigInt(`0x${t.slice(32, 64)}`);
    return { name: 'TimestampEnforcer', kind: 'condition', window: { after, before }, text: `usable ${after ? `after ${formatTimestamp(Number(after) * 1000)}` : ''}${after && before ? ' and ' : ''}${before ? `before ${formatTimestamp(Number(before) * 1000)}` : ''}${!after && !before ? 'at any time' : ''}` };
  } },
  '0x04658b29f6b82ed55274221a06fc97d318e25416': { name: 'LimitedCallsEnforcer', read: t => ({ name: 'LimitedCallsEnforcer', kind: 'condition', redemptions: word(t, 0), text: `redeemable ${word(t, 0)} time${word(t, 0) === 1n ? '' : 's'} at most` }) },
  '0xe144b0b2618071b4e56f746313528a669c7e65c5': { name: 'RedeemerEnforcer', read: t => {
    const redeemers = Array.from({ length: Math.floor(t.length / 40) }, (_, i) => addr(t, i * 20));
    const named = redeemers.length && redeemers.every(r => METAMASK_FACILITATORS.has(r));
    return { name: 'RedeemerEnforcer', kind: 'condition', redeemers, text: `redeemable only by ${named ? `MetaMask's facilitators (${redeemers.map(shortAddress).join(', ')})` : redeemers.map(shortAddress).join(', ')}` };
  } },
  '0xc8b5d93463c893401094cc70e66a206fb5987997': { name: 'IdEnforcer', read: t => ({ name: 'IdEnforcer', kind: 'condition', once: true, text: `id ${word(t, 0)}: redeemable once; after that, none of your delegations with this id can be` }) },
  '0xde4f2fac4b3d87a1d9953ca5fc09fca7f366254f': { name: 'NonceEnforcer', read: t => ({ name: 'NonceEnforcer', kind: 'condition', text: `nonce ${word(t, 0)}: void once you raise your nonce with the enforcer` }) },
};

/** Warnings of a call's own transaction that don't apply where a redeemer submits it (its fee, nonce and sender). */
const TX_ONLY = new Set(['fee_below_base_fee', 'nonce_replaces', 'nonce_used', 'nonce_gap', 'gas_limit_above_cap', 'tip_above_fee_cap', 'insufficient_funds_for_gas', 'hyperevm_small_blocks', 'hyperevm_big_blocks', 'pending_transactions', 'sender_mismatch', 'chain_mismatch']);
const TX_DETAILS = /^Network fee\b/;
/** Warnings that a call would fail, said once for the delegation (delegation_calls_fail): the signer pays nothing for it. */
const FAILS = new Set(['simulation_reverted', 'batch_will_fail', 'batch_partial_failure']);

/** "Can move now" for native coin: the cap against the account's balance (eth_getBalance), or nothing without an RPC. */
async function nativeCanMoveNow(env: TypedEnv, b: PreviewBuilder, chainId: number, account: string, cap: bigint, native: string, label: string): Promise<void> {
  let balance: bigint;
  try {
    if (!env.deps.rpc?.has(chainId)) return;
    balance = BigInt(await env.deps.rpc.call(chainId, 'eth_getBalance', [account, 'latest']) as string);
  } catch { return; }
  const fmt = (v: bigint) => `${formatUnits(v, CHAINS[chainId]?.nativeDecimals ?? 18)} ${native}`;
  if (balance === 0n) b.detail(label, `nothing now: you hold no ${native} (it covers any you receive while it lasts)`);
  else if (!isUnlimited(cap) && cap < balance) b.detail(label, `${fmt(cap)} (the permitted amount; you hold ${fmt(balance)})`, cap.toString());
  else b.detail(label, `${fmt(balance)} (your whole balance${isUnlimited(cap) ? ', and any you receive while it lasts' : ''})`, balance.toString());
}

export const delegationAdapter: TypedAdapter = async (data, env) => {
  if (data.primaryType !== 'Delegation' || str(data.domain.name) !== 'DelegationManager') return null;
  const fields = data.types.Delegation?.map(f => `${f.type} ${f.name}`).join(',');
  const caveatFields = data.types.Caveat?.map(f => `${f.type} ${f.name}`).join(',');
  if (fields !== 'address delegate,address delegator,bytes32 authority,Caveat[] caveats,uint256 salt' || caveatFields !== 'address enforcer,bytes terms') return null;
  const chainId = domainChainId(data);
  const network = chainId !== null ? { kind: 'evm' as const, chainId, name: chainName(chainId) } : null;
  const b = new PreviewBuilder();
  const m = data.message;
  const delegate = str(m.delegate).toLowerCase(), delegator = str(m.delegator).toLowerCase(), authority = str(m.authority).toLowerCase();
  const manager = str(data.domain.verifyingContract).toLowerCase();
  const caveats = Array.isArray(m.caveats) ? (m.caveats as Record<string, unknown>[]).map(c => ({ enforcer: str(c?.enforcer).toLowerCase(), terms: str(c?.terms).toLowerCase() })) : null;
  if (!ADDRESS.test(delegate) || !ADDRESS.test(delegator) || !/^0x[0-9a-f]{64}$/.test(authority) || !caveats || caveats.some(c => !ADDRESS.test(c.enforcer) || !HEX.test(c.terms))) return null;
  const native = chainId !== null ? CHAINS[chainId]?.nativeSymbol ?? 'ETH' : 'ETH';
  const anyone = delegate === ANY_DELEGATE, root = authority === ROOT_AUTHORITY;
  // To the account itself: only it can redeem it, and it can already make any call (a wallet batching its own calls
  // through the DelegationManager, with caveats as checks on them).
  const self = delegate === delegator;
  let who = anyone ? 'anyone holding this signature' : self ? 'your account itself' : shortAddress(delegate);

  b.detail('Account (delegator)', delegator).detail('Delegate', anyone ? `anyone holding this signature (${ANY_DELEGATE})` : delegate, delegate)
    .detail('Authority', root ? "the account's own" : `a delegation the account holds (${authority}), passed on`, authority);
  if (manager !== DELEGATION_MANAGER) b.warn('caution', 'delegation_manager_unknown', `It is signed for ${shortAddress(manager)}, not MetaMask's DelegationManager (${shortAddress(DELEGATION_MANAGER)}): what that contract does with it, and what its caveats mean there, isn't known here.`);
  // Each caveat read by its enforcer; one this preview doesn't know is named, its rule unread.
  const token = async (address: string): Promise<TokenInfo | undefined> => { try { return chainId !== null ? (await env.deps.tokens?.get(chainId, address)) ?? undefined : undefined; } catch { return undefined; } };
  const reads: (CaveatRead | null)[] = [];
  for (const [i, c] of caveats.entries()) {
    const known = ENFORCERS[c.enforcer];
    let r: CaveatRead | null = null;
    try { r = known ? await known.read(c.terms.slice(2), token, native) : null; } catch { r = null; }
    reads.push(r);
    b.detail(`Caveat ${i + 1}`, r ? `${r.name}: ${r.text}` : `${known ? `${known.name}, its terms malformed` : `an enforcer this preview doesn't know (${c.enforcer})`}: ${c.terms.length > 2 + 64 * 2 ? `${c.terms.slice(0, 66)}… (${(c.terms.length - 2) / 2} bytes)` : c.terms}`, c.enforcer);
  }
  const unknown = caveats.filter((_, i) => !reads[i] || reads[i]!.unread);
  const known = reads.filter((r): r is CaveatRead => !!r);
  const scopes = known.filter(r => r.kind === 'scope');
  const limits = known.filter(r => r.kind === 'limit').map(r => r.text);
  const exact = known.find(r => r.exact)?.exact;
  // ANY_DELEGATE, but a RedeemerEnforcer names who may redeem it.
  const redeemers = known.find(r => r.redeemers)?.redeemers;
  if (anyone && redeemers) who = redeemers.length === 1 ? shortAddress(redeemers[0]) : `the ${redeemers.length} redeemers it names`;
  // What its caveats leave open. All of them must pass, so the narrowest scope decides; where none narrows what is
  // called, the delegate makes any call as the account. Calls to the DelegationManager (redeemDelegations with no
  // delegations has the caller, the account, run any call: its executeFromExecutor) or to the account itself (its
  // execute, which the account may call on itself) are any call too.
  const targets = known.find(r => r.targets && !r.anyContract)?.targets;
  const pinned = !!exact || scopes.some(r => r.tokens || r.name === 'ERC721TransferEnforcer' || r.name === 'OwnershipTransferEnforcer' || r.name === 'ApprovalRevocationEnforcer');
  const functions = scopes.filter(r => r.anyContract);
  const selectors = functions.flatMap(r => r.selectors ?? []);
  const nativeLimit = known.some(r => r.nativeLimit);
  const gateways = (targets ?? []).filter(t => t === DELEGATION_MANAGER || t === delegator);
  const through = gateways.length && (!functions.length || selectors.some(x => GATEWAY_SELECTORS.has(x)));
  const executes = !targets && !pinned && selectors.some(x => GATEWAY_SELECTORS.has(x));
  const full = !scopes.length || (!pinned && (!!through || executes));
  const account = root ? `your account ${shortAddress(delegator)}` : 'the account at the root of the delegation it passes on';
  const anyCall = `${who} can make any call as ${account}`;
  if (self) b.warn('info', 'delegation_to_self', `It delegates to your own account: only your account can redeem it, and it can already make any call. Its caveats are checks on what is done through it.`);
  else if (!root) b.warn(full ? 'caution' : 'info', 'delegation_redelegated', `It passes on a delegation your account holds (${shortAddress(authority)}): whoever redeems it acts as the account at the root of that chain, not yours, and ${full ? `${who} gets all that delegation allows` : `${who} can do at most what that delegation allows, within these caveats`}.`);
  else if (!caveats.length) b.warn('danger', 'delegation_unrestricted', `It has no caveats: ${anyCall}, at any time, as often as wanted: move every token and coin it holds, approve spenders, change its owners. This is full control of the account. Don't sign it unless you mean to hand the account over.`);
  else if (!scopes.length) b.warn('danger', 'delegation_unrestricted', `None of its caveats restricts what is called: ${anyCall}${limits.length ? `, within these limits only: ${limits.join('; ')}` : ''}${unknown.length ? ` (unless ${unknown.length === 1 ? 'the enforcer' : 'one of the enforcers'} this preview doesn't read restricts it)` : ''}: move its other tokens and coin, approve spenders, change its owners.`);
  else if (full) b.warn('danger', 'delegation_unrestricted', `Its calls may go to ${through ? gateways.map(g => g === delegator ? 'your account itself' : 'the DelegationManager').join(' and ') : 'any contract, with functions that run other calls'} (${through ? 'any function' : selectors.filter(x => GATEWAY_SELECTORS.has(x)).map(x => GATEWAY_SELECTORS.get(x)).join(', ')}): through ${through && gateways.length === 1 ? 'it' : 'them'}, ${anyCall}: move every token and coin it holds, approve spenders, change its owners.`);
  if (root && !self && !full) {
    // Functions or data, but on any contract: transfer() allowed on every token the account holds.
    if (!targets && !pinned && functions.length && scopes.every(r => r.anyContract)) {
      const open = functions.some(r => r.open);
      b.warn(open ? 'danger' : 'caution', 'delegation_any_contract', `Its caveats limit which functions are called (${functions.map(r => r.name).join(', ')}), but not on which contract: ${who} can call them on any contract your account uses, every token it holds included${open ? ' (a transfer or an approval of each, to anyone or for any amount the rest allows)' : ''}.`);
    }
    // Contracts, but any function on them with any value: a token's whole balance, coin sent to them.
    else if (targets && !pinned && !functions.length && !scopes.some(r => r.plain)) b.warn('caution', 'delegation_any_function', `Its caveats limit which contracts are called (${targets.map(shortAddress).join(', ')}), but not what is called on them: ${who} can call any of their functions${nativeLimit ? '' : `, sending any amount of ${native}`}, as your account. If one is a token, that is all of your balance of it, transferred or approved to anyone.`);
    // Plain transfers of native coin to anyone, with nothing bounding the amount.
    if (!pinned && scopes.some(r => r.plain) && !nativeLimit) b.warn(targets ? 'caution' : 'danger', 'delegation_native_unlimited', `It allows plain ${native} transfers${targets ? ` to ${targets.map(shortAddress).join(', ')}` : ' to any address'}, and nothing limits the amount: ${who} can send all of your account's ${native}.`);
  }
  if (unknown.length) b.warn('caution', 'delegation_caveat_unknown', `${unknown.length} of its caveats ${unknown.length === 1 ? 'is' : 'are'} enforced by ${unknown.length === 1 ? 'a contract' : 'contracts'} this preview doesn't know (${unknown.map(c => shortAddress(c.enforcer)).join(', ')}): ${unknown.length === 1 ? 'its' : 'their'} rules aren't read, so what they allow or forbid isn't shown.`);
  if (anyone && redeemers) b.warn('info', 'delegation_any_delegate', `Its delegate is ANY_DELEGATE, but a RedeemerEnforcer caveat lets only ${redeemers.map(shortAddress).join(', ')} redeem it.`);
  else if (anyone) b.warn(exact ? 'caution' : 'danger', 'delegation_any_delegate', `Its delegate is ANY_DELEGATE: anyone who gets this signature can redeem it, not one address you chose${exact ? ', for the exact calls shown' : ''}.`);
  // When it is usable: its time window, else none (an end in the far future is none).
  const window = known.find(r => r.window)?.window;
  const nowS = BigInt(Math.floor(env.now / 1000));
  const ends = (!!window?.before && window.before < FAR) || known.some(r => r.expires);
  if (window?.before) b.detail('Usable until', window.before < FAR ? formatTimestamp(Number(window.before) * 1000) : 'never (its end is set too far off to be one)', window.before.toString());
  if (window?.after) b.detail('Usable after', formatTimestamp(Number(window.after) * 1000), window.after.toString());
  if (window?.before && window.before <= nowS) b.warn('info', 'delegation_expired', 'Its time window has already ended: it can no longer be redeemed.');
  if (!ends && !self) b.warn('caution', 'delegation_no_expiry', `It has no expiry: it stays redeemable until you disable it (disableDelegation on the DelegationManager)${known.some(r => r.name === 'NonceEnforcer') ? ' or raise your nonce with its enforcer' : ''}, or its other caveats run out.`);
  // How often: once with an IdEnforcer, a count with LimitedCalls, else as often as its other caveats allow. Exact
  // calls are the same each time, so what they move repeats.
  const once = known.some(r => r.once), count = known.reduce<bigint | undefined>((m, r) => r.redemptions !== undefined && (m === undefined || r.redemptions < m) ? r.redemptions : m, undefined);
  if (exact && !once && count === undefined) b.warn('caution', 'delegation_repeatable', `Nothing limits how often it can be redeemed: the exact call${exact.length === 1 ? '' : 's'} can be made again and again, each time moving what is shown below, until you disable it${ends ? ' or it expires' : ''}.`);
  else if (exact && !once && count !== undefined && count > 1n) b.warn('info', 'delegation_repeatable', `It can be redeemed ${count} times: the exact call${exact.length === 1 ? '' : 's'} can be made ${count} times, each time moving what is shown below.`);
  if (env.signer && env.signer !== delegator) b.warn('info', 'delegation_owner_signature', `You sign as an owner of the smart account ${shortAddress(delegator)}: the delegation is the account's, not ${shortAddress(env.signer)}'s.`);
  b.detail('Salt', String(big(m.salt) ?? str(m.salt)));
  b.note("This is an off-chain signature; it costs no gas now. Whoever may redeem it submits it to the DelegationManager, which has your account make the calls they choose, each checked by its caveats' enforcers.");

  // What it lets the delegate move now: a token amount it is limited to, against the account's balance.
  // (Not for a delegation passed on: the account at the root of its chain makes the calls, not this one.)
  if (root) for (const r of reads) if (r?.native !== undefined && chainId !== null) await nativeCanMoveNow(env, b, chainId, delegator, r.native, native, `Can move now (${r.name}${r.tokens?.length ? `, ${native}` : ''})`);
  if (root) for (const r of reads) for (const t of r?.tokens ?? []) if (chainId !== null) await canMoveNow(env, b, chainId, delegator, t.address, await token(t.address), t.amount, undefined, `Can move now (${r!.name}${r!.tokens!.length > 1 ? `, ${(await token(t.address))?.symbol ?? shortAddress(t.address)}` : ''})`);

  // Exact calls: simulated as the account makes them, as redeeming it would.
  let assetChanges: AssetChange[] | undefined, approvals: ApprovalChange[] | undefined, title = self ? `Delegate ${shortAddress(delegator)} to itself, with ${caveats.length} caveat${caveats.length === 1 ? '' : 's'}` : `${root ? '' : 'Pass on a delegation: '}Delegate ${full ? 'full' : 'limited'} control of ${root ? shortAddress(delegator) : 'its root account'} to ${anyone ? (redeemers ? who : 'anyone') : shortAddress(delegate)}`;
  if (exact && chainId !== null && root) {
    try {
      const context = { ...env.context, chainId, account: undefined };
      const p: Preview = exact.length === 1
        ? await previewTransaction(normalizeTransaction({ from: delegator, to: exact[0].target, value: `0x${exact[0].value.toString(16)}`, data: exact[0].data }, context, delegator, chainId), env.deps, context, 'eth_sendTransaction')
        : await (await import('../preview.ts')).previewBatch({ chainId: `0x${chainId.toString(16)}`, from: delegator, atomicRequired: true, calls: exact.map(e => ({ to: e.target, value: `0x${e.value.toString(16)}`, data: e.data })) }, context, env.deps);
      if (p.simulation) b.detail('Authorized calls simulated', `${p.simulation.status === 'success' ? 'they succeed' : `they revert${p.simulation.revertReason ? `: ${p.simulation.revertReason}` : ''}`} (as your account, on the current state; ${p.simulation.source})`);
      for (const d of p.details) if (!TX_DETAILS.test(d.label)) b.detail(`Authorized call${exact.length === 1 ? '' : 's'}: ${d.label}`, d.value, d.raw);
      // A call that fails now: redeeming it would fail, at the redeemer's cost; nothing would move. (A batch run
      // without batch simulation says so only in its calls' warnings.)
      const failing = [p, ...(p.calls ?? [])].find(c => c.simulation?.status === 'reverted' || c.warnings.some(w => w.code === 'simulation_reverted'));
      const reason = failing?.simulation?.revertReason;
      if (failing) b.warn('caution', 'delegation_calls_fail', `The authorized call${exact.length === 1 ? '' : 's'} would fail if redeemed now${reason ? ` (${reason})` : ''}: nothing would move, and whoever redeems it pays the fee. It may succeed later, once the state changes.`);
      for (const w of p.warnings) if (!TX_ONLY.has(w.code) && !FAILS.has(w.code)) b.warn(w.severity, w.code, `The authorized call${exact.length === 1 ? '' : 's'}: ${w.message}`);
      for (const n of p.decoding.notes) b.note(`The authorized call${exact.length === 1 ? '' : 's'}: ${n}`);
      if (p.trace && !b.trace) b.trace = p.trace;
      assetChanges = failing ? [] : p.assetChanges;
      approvals = failing ? undefined : p.approvals;
      title = `Let ${anyone ? (redeemers ? who : 'anyone') : self ? 'your account' : shortAddress(delegate)} make ${exact.length === 1 ? 'one exact call' : `${exact.length} exact calls`} from ${shortAddress(delegator)}: ${p.title.replace(/^(Send|Sign|Submit) (a )?transaction: /i, '').replace(/^\d+ actions: /, '')}`;
    } catch { /* not simulated: the calls are listed in the caveat */ }
  }
  return {
    title, summary: `A MetaMask delegation (ERC-7710): ${who} may act as ${root ? `your account ${shortAddress(delegator)}` : 'the account at the root of the delegation it passes on'} through the DelegationManager, ${caveats.length ? `within ${caveats.length} caveat${caveats.length === 1 ? '' : 's'}` : 'with no caveats'}.`,
    decoder: 'metamask_delegation', status: unknown.length ? 'partial' : 'full', b, network, ...(assetChanges && { assetChanges }), ...(approvals?.length && { approvals }),
  };
};
