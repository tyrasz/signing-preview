// What a delegation's caveats let its delegate do, found by trying the calls an attacker would make against every
// caveat's rule. Each enforcer of DelegationManager 1.3.0 is read as a rule on one execution (target, value, data) and
// on its call type, as its hooks check them (their verified Solidity): the single-call enforcers (AllowedTargets,
// AllowedMethods, AllowedCalldata, ExactCalldata, ExactExecution, ValueLte, the ERC-20 and native transfer, period and
// streaming enforcers, MultiTokenPeriod, ERC721Transfer, OwnershipTransfer, ApprovalRevocation) refuse batches, the
// batch ones (ExactExecutionBatch, ExactCalldataBatch, SpecificActionERC20TransferBatch) refuse single calls, and the
// rest (time, count, redeemer, balance checks) don't look at the call. A LogicalOrWrapperEnforcer passes when any of
// its groups does (the redeemer picks). An enforcer this preview doesn't know is taken to allow anything.
// The calls tried, each with the data the caveats pin laid over it (so "approve, but only to this spender" is tried
// as that), in single and batch mode:
//   - any call as the account: its own execute, executeFromExecutor, upgrade, owner and signer functions, called on
//     itself; and the DelegationManager's redeemDelegations (with no delegations it has the caller run any call);
//   - native coin sent to an address of the delegate's choosing (an EOA takes any data), or to the targets named;
//   - transfer, approve, transferFrom, setApprovalForAll and increaseAllowance to the delegate, on any token, or on
//     the targets named, with the recipient free or as pinned;
//   - any function at all on the targets named.
import { toFunctionSelector } from 'viem';

export interface Exec { target: string; value: bigint; data: string; batch: boolean }
/** One caveat's rule on an execution: its call type, and what it checks of the call. */
export interface Rule {
  mode?: 'single' | 'batch';
  allows?: (e: Exec) => boolean;
  /** Bytes it pins in the call's data (AllowedMethods' selectors, AllowedCalldata's range), laid over the calls tried. */
  pins?: { start: number; value: string }[];
  /** Whole call data it fixes (ExactCalldata and the exact enforcers). */
  datas?: string[];
  /** Contracts it names (AllowedTargets, OwnershipTransfer), tried for what else can be called on them. Not an exact
   * execution's target: its call is fixed, and simulated. */
  targets?: string[];
  /** Nested groups (LogicalOrWrapperEnforcer). */
  groups?: (Rule | null)[][];
  /** The most native coin one call may send (ValueLteEnforcer). */
  valueCap?: bigint;
}

const sel = (sig: string): string => toFunctionSelector(`function ${sig}`);
export const SELECTORS = {
  transfer: sel('transfer(address,uint256)'), approve: sel('approve(address,uint256)'), transferFrom: sel('transferFrom(address,address,uint256)'),
  safeTransferFrom: sel('safeTransferFrom(address,address,uint256)'), safeTransferFromData: sel('safeTransferFrom(address,address,uint256,bytes)'),
  setApprovalForAll: sel('setApprovalForAll(address,bool)'), increaseAllowance: sel('increaseAllowance(address,uint256)'), transferOwnership: sel('transferOwnership(address)'),
  permit2Approve: sel('approve(address,address,uint160,uint48)'), permit2Lockdown: sel('lockdown((address,address)[])'), permit2Invalidate: sel('invalidateNonces(address,address,uint48)'),
  redeemDelegations: sel('redeemDelegations(bytes[],bytes32[],bytes[])'),
  safeTransferFrom1155: sel('safeTransferFrom(address,address,uint256,uint256,bytes)'), safeBatchTransferFrom: sel('safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)'),
  transferAndCall: sel('transferAndCall(address,uint256,bytes)'), send777: sel('send(address,uint256,bytes)'), authorizeOperator: sel('authorizeOperator(address)'),
};
export const PERMIT2_ADDRESS = '0x000000000022d473030f116ddee9f6b43ac78ba3';
/** The account's own functions that run any call or change who controls it (DeleGatorCore, HybridDeleGator, MultiSigDeleGator, EIP7702StatelessDeleGator). */
const SELF_CONTROL = ['execute(bytes32,bytes)', 'executeFromExecutor(bytes32,bytes)', 'execute((address,uint256,bytes))', 'executeBatch((address,uint256,bytes)[])',
  'upgradeToAndCall(address,bytes)', 'upgradeToAndCallAndRetainStorage(address,bytes)', 'transferOwnership(address)', 'withdrawDeposit(address,uint256)',
  'addKey(string,uint256,uint256)', 'removeKey(string)', 'updateSigners(address,string[],uint256[],uint256[])', 'addSigner(address)', 'removeSigner(address)',
  'replaceSigner(address,address)', 'updateThreshold(uint256)', 'updateMultiSigParameters(address[],uint256,bool)',
  // DeleGatorCore's own redeemDelegations (onlyEntryPointOrSelf) forwards to the DelegationManager, which with no
  // delegations has the account run any call.
  'redeemDelegations(bytes[],bytes32[],bytes[])'].map(s => [sel(s), s.replace(/\(.*/, '')] as [string, string]);
/** Control functions that, with fixed data, run only the fixed calls inside them (not a hand-over when exact). */
const RUNS_FIXED = new Set(['execute(bytes32,bytes)', 'executeFromExecutor(bytes32,bytes)', 'execute((address,uint256,bytes))', 'executeBatch((address,uint256,bytes)[])'].map(sel));

const word = (v: bigint | string) => (typeof v === 'bigint' ? v.toString(16) : v.toLowerCase().replace(/^0x/, '')).padStart(64, '0');
const at = (data: string, start: number, bytes: number) => data.slice(2 + start * 2, 2 + (start + bytes) * 2);
const selectorOf = (data: string) => data.length >= 10 ? data.slice(0, 10) : '';

/** Each known enforcer's rule, from its terms (hex without 0x); {} for one that doesn't look at the call. */
export function ruleOf(enforcer: string, t: string): Rule | null {
  const addr = (i: number) => `0x${t.slice(i * 2, i * 2 + 40)}`;
  const big = (i: number) => BigInt(`0x${t.slice(i * 2, i * 2 + 64) || '0'}`);
  const transferOn = (token: string) => (e: Exec) => e.target === token && e.data.length === 2 + 136 && selectorOf(e.data) === SELECTORS.transfer;
  switch (enforcer) {
    case '0x7f20f61b1f09b08d970938f6fa563634d65c4eeb': { // AllowedTargets
      const targets = Array.from({ length: Math.floor(t.length / 40) }, (_, i) => addr(i * 20));
      return { mode: 'single', targets, allows: e => targets.includes(e.target) };
    }
    case '0x2c21fd0cb9dc8445cb3fb0dc5e7bb0aca01842b5': { // AllowedMethods
      const sels = Array.from({ length: Math.floor(t.length / 8) }, (_, i) => `0x${t.slice(i * 8, i * 8 + 8)}`);
      return { mode: 'single', pins: sels.map(value => ({ start: 0, value: value.slice(2) })), allows: e => sels.includes(selectorOf(e.data)) };
    }
    case '0xc2b0d624c1c4319760c96503ba27c347f3260f55': { // AllowedCalldata
      const start = Number(big(0)), value = t.slice(64);
      return { mode: 'single', pins: [{ start, value }], allows: e => at(e.data, start, value.length / 2) === value };
    }
    case '0x99f2e9bf15ce5ec84685604836f71ab835dbbded': // ExactCalldata
      return { mode: 'single', datas: [`0x${t}`], allows: e => e.data === `0x${t}` };
    case '0x146713078d39ecc1f5338309c28405ccf85abfbb': { // ExactExecution
      const target = addr(0), value = big(20), data = `0x${t.slice(104)}`;
      return { mode: 'single', datas: [data], allows: e => e.target === target && e.value === value && e.data === data };
    }
    case '0x1e141e455d08721dd5bcda1baa6ea5633afd5017': // ExactExecutionBatch
    case '0x982fd5c86bbf425d7d1451f974192d4525113dfd': // ExactCalldataBatch (data only: any target, any value)
    case '0x6649b61c873f6f9686a1e1ae9ee98ac380c7ba13': // SpecificActionERC20TransferBatch
      return { mode: 'batch' }; // its executions are set by the reader, which decodes them (batchRule)
    case '0x92bf12322527caa612fd31a0e810472bbb106a8f': { // ValueLte
      const max = big(0);
      return { mode: 'single', valueCap: max, allows: e => e.value <= max };
    }
    case '0xf100b0819427117ecf76ed94b358b1a5b5c6d2fc': // ERC20TransferAmount
    case '0xe475d14d61756d6e940b74c20d2e44eb70c71a8d': // ERC20Streaming
    case '0x56c97ae02f233b29fa03502ecc0457266d9be00e':
    case '0x474e3ae7e169e940607cc624da8a15eb120139ab': // ERC20PeriodTransfer
      return { mode: 'single', targets: [addr(0)], allows: transferOn(addr(0)) };
    case '0x9bc0faf4aca5ae429f4c06aeeac517520cb16bd9': // NativeTokenPeriodTransfer: the value only
    case '0xd10b97905a320b13a0608f7e9cc506b56747df19': // NativeTokenStreaming
    case '0xf71af580b9c3078fbc2bbf16fbb8eed82b330320': // NativeTokenTransferAmount
      return { mode: 'single' };
    case '0xfb2f1a9bd76d3701b730e5d69c3219d42d80ebb7': { // MultiTokenPeriod
      const tokens = Array.from({ length: Math.floor(t.length / 232) }, (_, i) => addr(i * 116));
      return { mode: 'single', allows: e => (e.data.length === 2 + 136 && selectorOf(e.data) === SELECTORS.transfer && e.value === 0n && tokens.includes(e.target)) || (e.data === '0x' && e.value > 0n && tokens.includes('0x0000000000000000000000000000000000000000')) };
    }
    case '0x3790e6b7233f779b09da74c72b6e94813925b9af': { // ERC721Transfer
      const contract = addr(0), id = word(big(20));
      return { mode: 'single', allows: e => e.target === contract && [SELECTORS.transferFrom, SELECTORS.safeTransferFrom, SELECTORS.safeTransferFromData].includes(selectorOf(e.data)) && at(e.data, 68, 32) === id };
    }
    case '0x7eef9734e7092032b5c56310eb9bbd1f4a524681': { // OwnershipTransfer
      const contract = addr(0);
      return { mode: 'single', targets: [contract], allows: e => e.target === contract && e.data.length === 2 + 72 && selectorOf(e.data) === SELECTORS.transferOwnership };
    }
    case '0xe264f1f09a19505a1ca1a86d5b01e8bfdb64324a': { // ApprovalRevocation
      const flags = parseInt(t.slice(0, 2) || '0', 16);
      return { mode: 'single', allows: e => {
        if (e.value !== 0n) return false;
        const s = selectorOf(e.data), first = at(e.data, 4, 32), second = at(e.data, 36, 32);
        if (s === SELECTORS.approve && e.data.length === 2 + 136) return /^0+$/.test(first) ? (flags & 2) !== 0 : (flags & 1) !== 0 && /^0+$/.test(second);
        if (s === SELECTORS.setApprovalForAll && e.data.length === 2 + 136) return (flags & 4) !== 0 && /^0+$/.test(second);
        if (e.target !== PERMIT2) return false;
        return (s === SELECTORS.permit2Approve && (flags & 8) !== 0 && /^0+$/.test(at(e.data, 68, 64))) || (s === SELECTORS.permit2Lockdown && (flags & 16) !== 0) || (s === SELECTORS.permit2Invalidate && (flags & 32) !== 0);
      } };
    }
    default:
      return {}; // it doesn't look at the call (time, count, redeemer, balance checks)
  }
}
const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3';

/** A batch enforcer's rule, from its executions: exact ones fix target, value and data; ExactCalldataBatch only data. */
export function batchRule(executions: { target: string; value: bigint; data: string }[], dataOnly: boolean): Rule {
  return { mode: 'batch', datas: executions.map(x => x.data),
    allows: e => executions.some(x => x.data === e.data && (dataOnly || (x.target === e.target && x.value === e.value))) };
}

/** Whether every rule lets this execution through. */
export function passes(rules: (Rule | null)[], e: Exec): boolean {
  return rules.every(r => {
    if (!r) return true; // unknown: taken to allow it
    if ((r.mode === 'single' && e.batch) || (r.mode === 'batch' && !e.batch)) return false;
    if (r.groups) return r.groups.some(g => passes(g, e));
    return !r.allows || r.allows(e);
  });
}

const collect = <T>(rules: (Rule | null)[], f: (r: Rule) => T[] | undefined): T[] => rules.flatMap(r => !r ? [] : [...(f(r) ?? []), ...(r.groups ?? []).flatMap(g => collect(g, f))]);

/** The sets of pins a call can satisfy at once: the top-level caveats' and, for an OR, each group's in turn. */
function pinSets(rules: (Rule | null)[]): { start: number; value: string }[][] {
  let sets: { start: number; value: string }[][] = [[]];
  for (const r of rules) {
    if (!r) continue;
    // A pin beyond 4 KB of call data no realistic call satisfies (and laying it would be huge).
    const own = (r.pins ?? []).filter(p => p.start + p.value.length / 2 <= 4096);
    if (r.groups?.length) sets = sets.flatMap(set => r.groups!.flatMap(g => pinSets(g).map(gs => [...set, ...gs]))).slice(0, 64);
    else if (own.length) sets = sets.map(set => [...set, ...own]);
  }
  return sets;
}

/** The data an attacker would send for a call, with each set of the caveats' pinned bytes laid over it, and the data they fix outright. */
function variants(template: string, rules: (Rule | null)[], withFixed: boolean): string[] {
  const lay = (data: string, list: { start: number; value: string }[]) => {
    let d = data.slice(2);
    for (const p of list) {
      const need = (p.start + p.value.length / 2) * 2;
      if (d.length < need) d = d.padEnd(need, '0');
      d = d.slice(0, p.start * 2) + p.value + d.slice(need);
    }
    return `0x${d}`;
  };
  const out = new Set<string>([template]);
  for (const pins of pinSets(rules)) {
    const args = pins.filter(p => p.start > 0), heads = pins.filter(p => p.start === 0);
    for (const p of pins) out.add(lay(template, [p]));
    out.add(lay(template, args));
    for (const h of heads) out.add(lay(template, [...args, h]));
  }
  if (withFixed) for (const d of collect(rules, r => r.datas)) out.add(d);
  return [...out];
}

export const ATTACKER = '0x000000000000000000000000000000000000a77a';
const SOME_TOKEN = '0x00000000000000000000000000000000000070c0';
const MAX = (1n << 255n);

export interface Probe {
  /** A route to any call as the account: [what, how]. */
  control?: [string, string];
  /** Native coin sent to an address of the delegate's choosing, with no cap per call (null) or up to one. */
  native?: { perCall: bigint | null };
  /** Native coin sent to the targets named: in a plain transfer (data-less), or with a call (which only an EOA or a payable function takes). */
  nativeTo?: { target: string; perCall: bigint | null; plain: boolean }[];
  /** Token functions that move or approve the account's tokens: on any token (null) or the targets named, the recipient and amount free (null) or fixed. */
  tokens?: { on: string[] | null; recipient: string | null; amount: bigint | null; functions: string[] };
  /** An approval on Permit2 it can make (for any token): of the delegate (ATTACKER), or of the spender pinned. */
  permit2?: { spender: string };
  /** Targets named on which any function can be called. */
  anyFunction?: string[];
}

/** The attacker's calls against the caveats' rules: what gets through. */
export function probe(rules: (Rule | null)[], account: string, manager: string, capped: { tokens: Set<string> }): Probe {
  const out: Probe = {};
  // A call tried with the caveats' pins laid over it, and the data they fix: it must still be the function tried
  // (sameFunction), but for native coin to an EOA, which takes any data.
  const fixed = new Set(collect(rules, r => r.datas));
  const tries = (target: string, value: bigint, templates: string[], withFixed: boolean, sameFunction = true, fixedRunsCalls = true) => {
    for (const batch of [false, true]) for (const t of templates) for (const data of variants(t, rules, withFixed)) {
      if (sameFunction && selectorOf(data) !== selectorOf(t)) continue;
      // An exact execute(…) on the account runs only the calls fixed inside it: those are simulated, not a hand-over.
      if (!fixedRunsCalls && fixed.has(data) && RUNS_FIXED.has(selectorOf(data))) continue;
      if (passes(rules, { target, value, data, batch })) return data;
    }
    return null;
  };
  // Any call as the account: its own control functions on itself, the DelegationManager's redeemDelegations.
  // (each with one to six argument words: some rules check the call's length)
  const lengths = (selector: string) => [1, 2, 3, 6].map(n => `${selector}${'0'.repeat(64 * n)}`);
  for (const [s, name] of SELF_CONTROL) if (!out.control && tries(account, 0n, lengths(s), true, true, false)) out.control = ['your account itself', `its ${name}`];
  if (!out.control && tries(manager, 0n, lengths(SELECTORS.redeemDelegations), true)) out.control = ['the DelegationManager', 'redeemDelegations, which with no delegations has your account run any call'];
  // Native coin: to an address the delegate picks (an EOA takes any data), else to a target named.
  const named = [...new Set(collect(rules, r => r.targets))].filter(t => t !== account && t !== manager);
  const data = ['0x', `0x12345678${'0'.repeat(64)}`];
  const perCallCaps = rulesValueCaps(rules);
  const nativeTo = (target: string) => {
    const full = tries(target, MAX, data, true, false);
    if (full) return { perCall: null, plain: full === '0x' };
    for (const c of perCallCaps.filter(c => c > 0n)) { const d = tries(target, c, data, true, false); if (d) return { perCall: c, plain: d === '0x' }; }
    return undefined;
  };
  const toAnyone = nativeTo(ATTACKER);
  if (toAnyone) out.native = { perCall: toAnyone.perCall };
  else {
    const reach = named.flatMap(t => { const r = nativeTo(t); return r ? [{ target: t, ...r }] : []; });
    if (reach.length) out.nativeTo = reach;
  }
  // Tokens: move or approve them, to the delegate (or as pinned), on any token, else on the targets named.
  // [name, data, the recipient's byte offset, the amount's (null: everything)]
  const bytesArg = (n: number) => `${word(BigInt(32 * n))}${word(0n)}`;
  const templates: [string, string, number, number | null][] = [
    ['transfer', `${SELECTORS.transfer}${word(ATTACKER)}${word(MAX)}`, 4, 36], ['approve', `${SELECTORS.approve}${word(ATTACKER)}${word(MAX)}`, 4, 36],
    ['transferFrom', `${SELECTORS.transferFrom}${word(account)}${word(ATTACKER)}${word(MAX)}`, 36, 68], ['setApprovalForAll', `${SELECTORS.setApprovalForAll}${word(ATTACKER)}${word(1n)}`, 4, null],
    ['increaseAllowance', `${SELECTORS.increaseAllowance}${word(ATTACKER)}${word(MAX)}`, 4, 36],
    ['safeTransferFrom', `${SELECTORS.safeTransferFrom}${word(account)}${word(ATTACKER)}${word(1n)}`, 36, null],
    ['safeTransferFrom', `${SELECTORS.safeTransferFromData}${word(account)}${word(ATTACKER)}${word(1n)}${bytesArg(4)}`, 36, null],
    ['safeTransferFrom (ERC-1155)', `${SELECTORS.safeTransferFrom1155}${word(account)}${word(ATTACKER)}${word(1n)}${word(MAX)}${bytesArg(5)}`, 36, 100],
    ['safeBatchTransferFrom', `${SELECTORS.safeBatchTransferFrom}${word(account)}${word(ATTACKER)}${word(160n)}${word(224n)}${word(288n)}${word(1n)}${word(1n)}${word(1n)}${word(MAX)}${word(0n)}`, 36, null],
    ['transferAndCall', `${SELECTORS.transferAndCall}${word(ATTACKER)}${word(MAX)}${bytesArg(3)}`, 4, 36], ['send', `${SELECTORS.send777}${word(ATTACKER)}${word(MAX)}${bytesArg(3)}`, 4, 36],
    ['authorizeOperator', `${SELECTORS.authorizeOperator}${word(ATTACKER)}`, 4, null]];
  const tokenCalls = (target: string) => {
    const found: { name: string; recipient: string; amount: bigint }[] = [];
    for (const [name, t, to, amount] of templates) {
      const d = tries(target, 0n, [t], true);
      if (d) found.push({ name, recipient: `0x${at(d, to, 32).slice(24)}`, amount: amount === null ? MAX : BigInt(`0x${at(d, amount, 32) || '0'}`) });
    }
    return found;
  };
  // Permit2: an approval there of the delegate, for any token, lets it take every token the account approved to Permit2.
  const permit2 = tries(PERMIT2_ADDRESS, 0n, [`${SELECTORS.permit2Approve}${word(SOME_TOKEN)}${word(ATTACKER)}${word((1n << 160n) - 1n)}${word((1n << 48n) - 1n)}`], true);
  if (permit2) out.permit2 = { spender: `0x${at(permit2, 36, 32).slice(24)}` };
  const summary = (on: string[] | null, found: { name: string; recipient: string; amount: bigint }[]) => {
    // An amount of 2^128 - 1 or more is unlimited (as format.ts's isUnlimited reads it).
    const unlimited = (v: bigint) => v >= (1n << 128n) - 1n;
    const open = found.find(f => f.recipient === ATTACKER && unlimited(f.amount));
    return { on, recipient: open || found.some(f => f.recipient === ATTACKER) ? null : found[0].recipient, amount: open || found.some(f => unlimited(f.amount)) ? null : found[0].amount, functions: [...new Set(found.map(f => f.name))] };
  };
  const any = tokenCalls(SOME_TOKEN);
  if (any.length) out.tokens = summary(null, any);
  else {
    const on = named.filter(t => !capped.tokens.has(t)).map(t => [t, tokenCalls(t)] as const).filter(([, f]) => f.length);
    if (on.length) out.tokens = summary(on.map(([t]) => t), on.flatMap(([, f]) => f));
  }
  // Any function on a target named.
  const free = named.filter(t => tries(t, 0n, [`0x5eedf00d${'0'.repeat(128)}`], false));
  if (free.length) out.anyFunction = free;
  return out;
}

/** The per-call value caps (ValueLte) among the rules, nested ones too: the values to try sending. */
function rulesValueCaps(rules: (Rule | null)[]): bigint[] {
  return [...new Set(collect(rules, r => r.valueCap !== undefined ? [r.valueCap] : []))].sort((a, b) => (a < b ? 1 : -1));
}
