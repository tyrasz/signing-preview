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
import { decodeAbiParameters, toFunctionSelector, type Hex } from 'viem';

export interface Exec { target: string; value: bigint; data: string; batch: boolean }
/** One caveat's rule on an execution: its call type, and what it checks of the call. */
export interface Rule {
  mode?: 'single' | 'batch';
  allows?: (e: Exec) => boolean;
  /** Bytes it pins in the call's data (AllowedMethods' selectors, AllowedCalldata's range), laid over the calls tried. */
  pins?: { start: number; value: string }[];
  /** Whole call data it fixes (ExactCalldata and the exact enforcers). */
  datas?: string[];
  /** Its calls are exact executions (target, value and data), which the preview simulates. */
  simulated?: boolean;
  /** Contracts it names (AllowedTargets, OwnershipTransfer), tried for what else can be called on them. Not an exact
   * execution's target: its call is fixed, and simulated. */
  targets?: string[];
  /** Nested groups (LogicalOrWrapperEnforcer). */
  groups?: (Rule | null)[][];
  /** The most native coin one call may send (ValueLteEnforcer). */
  valueCap?: bigint;
  /** The exact executions it allows (ExactExecution, ExactExecutionBatch): read for what they do where not simulated. */
  execs?: { target: string; value: bigint; data: string }[];
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
const CONTROL = new Set(SELF_CONTROL.map(([s]) => s));
const EXECUTIONS = [{ type: 'tuple[]', components: [{ name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'callData', type: 'bytes' }] }] as const;
/**
 * The calls an execute(…) on the account runs, read from its data (ERC-7579's single and batch modes, the DeleGator's
 * execute(Execution) and executeBatch); null where they don't read as a fixed set of calls (a delegatecall mode).
 */
export function innerCalls(data: string): { target: string; value: bigint; data: string }[] | null {
  const s = data.slice(0, 10), args = `0x${data.slice(10)}` as Hex;
  const list = (xs: readonly { target: string; value: bigint; callData: string }[]) => xs.map(x => ({ target: x.target.toLowerCase(), value: x.value, data: x.callData.toLowerCase() }));
  try {
    if (s === sel('execute(bytes32,bytes)') || s === sel('executeFromExecutor(bytes32,bytes)')) {
      const [mode, exec] = decodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes' }], args);
      const callType = mode.slice(2, 4), e = exec.slice(2).toLowerCase();
      if (callType === '00' && e.length >= 104) return [{ target: `0x${e.slice(0, 40)}`, value: BigInt(`0x${e.slice(40, 104)}`), data: `0x${e.slice(104)}` }];
      if (callType === '01') return list(decodeAbiParameters(EXECUTIONS, exec)[0]);
      return null;
    }
    if (s === sel('execute((address,uint256,bytes))')) return list([decodeAbiParameters([{ type: 'tuple', components: EXECUTIONS[0].components }], args)[0]]);
    if (s === sel('executeBatch((address,uint256,bytes)[])')) return list(decodeAbiParameters(EXECUTIONS, args)[0]);
  } catch { return null; }
  return null;
}

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
      // From 4 KB on, the bytes aren't laid over the calls tried: any call padded with them (the function ignores data
      // past its arguments) passes, up to the ~1 MB of call data a block can carry; beyond that, none can. Bytes that
      // start before are laid, however far they run.
      if (start >= FAR_PIN) return { mode: 'single', allows: () => start + value.length / 2 <= 1_000_000 };
      return { mode: 'single', pins: [{ start, value }], allows: e => at(e.data, start, value.length / 2) === value };
    }
    case '0x99f2e9bf15ce5ec84685604836f71ab835dbbded': // ExactCalldata
      return { mode: 'single', datas: [`0x${t}`], allows: e => e.data === `0x${t}` };
    case '0x146713078d39ecc1f5338309c28405ccf85abfbb': { // ExactExecution
      const target = addr(0), value = big(20), data = `0x${t.slice(104)}`;
      return { mode: 'single', datas: [data], simulated: true, execs: [{ target, value, data }], allows: e => e.target === target && e.value === value && e.data === data };
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
      // Its tokens are named targets: what else can be called on them is tried, and a token whose allowance is no cap
      // (unlimited, or back more often than hourly) is probed.
      return { mode: 'single', targets: tokens.filter(a => !/^0x0{40}$/.test(a)), allows: e => (e.data.length === 2 + 136 && selectorOf(e.data) === SELECTORS.transfer && e.value === 0n && tokens.includes(e.target)) || (e.data === '0x' && e.value > 0n && tokens.includes('0x0000000000000000000000000000000000000000')) };
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
/** Pinned bytes from here on are met by padding a call with them, not laid over it. */
const FAR_PIN = 4096;

/** A batch enforcer's rule, from its executions: exact ones fix target, value and data; ExactCalldataBatch only data. */
export function batchRule(executions: { target: string; value: bigint; data: string }[], dataOnly: boolean): Rule {
  return { mode: 'batch', datas: executions.map(x => x.data), simulated: !dataOnly, ...(!dataOnly && { execs: executions }),
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

type Pin = { start: number; value: string };
const lay = (data: string, list: Pin[]) => {
  let d = data.slice(2);
  for (const p of list) {
    const need = (p.start + p.value.length / 2) * 2;
    if (d.length < need) d = d.padEnd(need, '0');
    d = d.slice(0, p.start * 2) + p.value + d.slice(need);
  }
  return `0x${d}`;
};

/** What the search for calls did: whether it tried every combination of OR groups, and the bytes it laid so far. */
interface Search { incomplete: boolean; work: number }
/** Hex characters of call data laid in all, before the search stops (and says it didn't finish). */
const WORK = 40_000_000;
/** The call tried: where it goes, with what value, in which mode. */
type Attempt = { target: string; value: bigint; batch: boolean };

/**
 * The sets of pins a call can satisfy at once: the top-level caveats' and, for an OR, each of its groups'. Every
 * combination across several ORs while there are at most 256; past that (and the search says it is incomplete), one OR
 * at a time: each OR's group that changes the call least among those that pass on their own, and each group of each
 * OR with the others at theirs.
 */
function pinSets(rules: (Rule | null)[], template: string, e: Attempt, search: Search): Pin[][] {
  const top = rules.flatMap(r => r && !r.groups ? (r.pins ?? []).filter(p => p.start < FAR_PIN) : []);
  const ors = rules.filter((r): r is Rule => !!r?.groups?.length).map(r => r.groups!.flatMap(g => pinSets(g, template, e, search).map(pins => ({ pins, group: g }))));
  if (!ors.length) return [top];
  const size = ors.reduce((n, o) => n * Math.max(o.length, 1), 1);
  if (size <= 256) return ors.reduce<Pin[][]>((sets, o) => sets.flatMap(set => o.map(g => [...set, ...g.pins])), [top]);
  search.incomplete = true;
  const base = lay(template, top);
  // Bytes a set of pins changes in the call, counted over the pins alone.
  const changed = (pins: Pin[]) => pins.reduce((n, p) => {
    const from = 2 + p.start * 2, old = base.slice(from, from + p.value.length);
    let d = p.value.length - old.length;
    for (let i = 0; i < old.length; i++) if (old[i] !== p.value[i]) d++;
    return n + d;
  }, 0);
  const passing = (a: { pins: Pin[]; group: (Rule | null)[] }) => { search.work += base.length; return passes(a.group, { ...e, data: lay(base, a.pins) }); };
  const best = ors.map(o => {
    const able = o.filter(passing);
    return (able.length ? able : o).reduce<{ pins: Pin[] } | undefined>((a, g) => a === undefined || changed(g.pins) < changed(a.pins) ? g : a, undefined)?.pins ?? [];
  });
  const sets = [[...top, ...best.flat()]];
  ors.forEach((o, i) => { for (const g of o) sets.push([...top, ...best.flatMap((b, j) => j === i ? g.pins : b)]); });
  return sets;
}

/** The data an attacker would send for a call, with each set of the caveats' pinned bytes laid over it, and the data they fix outright. */
function variants(template: string, rules: (Rule | null)[], withFixed: boolean, e: Attempt, search: Search): string[] {
  const out = new Set<string>([template]);
  const add = (pins: Pin[]) => { if (search.work > WORK) { search.incomplete = true; return; } const d = lay(template, pins); search.work += d.length; out.add(d); };
  for (const pins of pinSets(rules, template, e, search)) {
    const args = pins.filter(p => p.start > 0), heads = pins.filter(p => p.start === 0);
    for (const p of pins) add([p]);
    add(args);
    for (const h of heads) add([...args, h]);
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
  /**
   * Fixed calls the preview doesn't simulate that the caveats let through: those an execute(…) on the account runs (its
   * data fixed by a LogicalOr group's exact execution or an ExactCalldata), and exact executions inside an OR.
   */
  unsimulated?: { target: string; value: bigint; data: string }[];
  /** The search didn't try every combination of the caveats' OR groups (or ran out of room): what they allow may be more. */
  incomplete?: boolean;
}

/** The attacker's calls against the caveats' rules: what gets through. */
export function probe(rules: (Rule | null)[], account: string, manager: string, capped: { tokens: Set<string>; simulated?: string[] }): Probe {
  const out: Probe = {};
  // A call tried with the caveats' pins laid over it, and the data they fix: it must still be the function tried
  // (sameFunction), but for native coin to an EOA, which takes any data.
  // The exact executions' calls the preview simulates (a top-level caveat's, not one inside an OR): an execute(…) among
  // them runs only the calls fixed inside it, a hand-over only if one of those is (handsOver).
  const fixed = new Set(capped.simulated ?? []), fixedData = new Set(collect(rules, r => r.datas)), unsimulated = new Map<string, { target: string; value: bigint; data: string }>();
  const search: Search = { incomplete: false, work: 0 };
  const handsOver = (data: string, depth: number): boolean => {
    const inner = depth < 4 ? innerCalls(data) : null;
    return inner === null || inner.some(c => (c.target === account && CONTROL.has(selectorOf(c.data)) && (!RUNS_FIXED.has(selectorOf(c.data)) || handsOver(c.data, depth + 1)))
      || (c.target === manager && selectorOf(c.data) === SELECTORS.redeemDelegations));
  };
  // Every call that gets through, of those tried (passing); the first (tries).
  function* passing(target: string, value: bigint, templates: string[], withFixed: boolean, sameFunction = true, fixedRunsCalls = true) {
    for (const batch of [false, true]) for (const t of templates) for (const data of variants(t, rules, withFixed, { target, value, batch }, search)) {
      if (sameFunction && selectorOf(data) !== selectorOf(t)) continue;
      // An execute(…) on the account with data a caveat fixes runs only the calls fixed inside it: not a hand-over
      // unless one of those is. Simulated when it is the exact execution the preview runs, else said (unsimulated).
      if (!fixedRunsCalls && (fixed.has(data) || fixedData.has(data)) && RUNS_FIXED.has(selectorOf(data)) && !handsOver(data, 0)) {
        if (!fixed.has(data) && passes(rules, { target, value, data, batch })) for (const c of innerCalls(data) ?? []) unsimulated.set(`${c.target}:${c.value}:${c.data}`, c);
        continue;
      }
      if (passes(rules, { target, value, data, batch })) yield data;
    }
  }
  const tries = (...args: Parameters<typeof passing>) => { for (const data of passing(...args)) return data; return null; };
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
    for (const c of perCallCaps.filter(c => c > 0n)) { const d = tries(target, c, data, true, false); if (d) return { perCall: c >= (1n << 128n) - 1n ? null : c, plain: d === '0x' }; }
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
    // Each call that gets through, not only the first: the recipient and amount the delegate can pick are the worst of them.
    for (const [name, t, to, amount] of templates) for (const d of new Set(passing(target, 0n, [t], true))) {
      found.push({ name, recipient: `0x${at(d, to, 32).slice(24)}`, amount: amount === null ? MAX : BigInt(`0x${at(d, amount, 32) || '0'}`) });
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
    // The delegate picks among them: any recipient where it can name itself, or several are pinned; the largest amount.
    const recipients = new Set(found.map(f => f.recipient));
    const largest = found.reduce((m, f) => f.amount > m ? f.amount : m, 0n);
    return { on, recipient: open || recipients.has(ATTACKER) || recipients.size > 1 ? null : found[0].recipient, amount: open || unlimited(largest) ? null : largest, functions: [...new Set(found.map(f => f.name))] };
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
  // Exact executions the preview doesn't simulate (inside an OR), where the caveats let them through: what they do.
  // (An execute(…) on the account among them is read above, by the calls inside it.)
  for (const x of collect(rules, r => r.execs)) {
    if (fixed.has(x.data) || (x.target === account && RUNS_FIXED.has(selectorOf(x.data)))) continue;
    if ([false, true].some(batch => passes(rules, { ...x, batch }))) unsimulated.set(`${x.target}:${x.value}:${x.data}`, x);
  }
  if (unsimulated.size) out.unsimulated = [...unsimulated.values()];
  if (search.incomplete) out.incomplete = true;
  return out;
}

/** The per-call value caps (ValueLte) among the rules, nested ones too: the values to try sending. */
function rulesValueCaps(rules: (Rule | null)[]): bigint[] {
  return [...new Set(collect(rules, r => r.valueCap !== undefined ? [r.valueCap] : []))].sort((a, b) => (a < b ? 1 : -1));
}
