// A simulated call's trace, made readable: the tree of calls flattened in order (each call's own calls follow it, one
// level deeper), with the function and arguments of each call and the events it emitted named where they can be,
// and the state the call changed.
//
// Names come, in order of trust: from the contract's verified source (Sourcify, Etherscan: the ABI resolver, asked
// for the contracts called most, a few at a time); from a built-in list of standard functions and events (ERC-20,
// ERC-721, WETH, Uniswap pools); and from the signature databases, by selector alone, which is a guess and marked so.
// What can't be named keeps its selector and raw data.
import { decodeEventLog, decodeFunctionData, decodeFunctionResult, parseAbi, parseAbiItem, toEventSelector, toFunctionSelector, toFunctionSignature, type Abi, type AbiEvent, type AbiFunction, type AbiParameter, type Hex } from 'viem';
import { builtinTokens, CHAINS } from '../chains.ts';
import { NEXT_BLOCK } from '../block.ts';
import { NATIVE_LOG_ADDRESS } from '../simulation.ts';
import type { ContractAbi, Dependencies, PreviewTrace, ReplayContext, SimulationRequest, SimulationResult, StateChange, TraceCall, TraceEntry, TraceEvent, TraceValue } from '../types.ts';
import { COMMON_SIGNATURES } from '../abi.ts';

/** How much of a trace is described: calls beyond this are counted, not listed. */
const MAX_CALLS = 400;
/** How many contracts' verified ABIs are looked up for one trace, and how long each lookup may take. */
const MAX_ABIS = 12, ABI_TIMEOUT_MS = 2500;
/** How many selectors unknown after that are asked of the signature databases. */
const MAX_LOOKUPS = 24;
/** How many contracts are asked of the token registry for a name. */
const MAX_TOKENS = 16;
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', APPROVAL_TOPIC = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';
/** transfer, transferFrom, approve, balanceOf, allowance. */
const ERC20_SELECTORS = new Set(['0xa9059cbb', '0x23b872dd', '0x095ea7b3', '0x70a08231', '0xdd62ed3e']);
/** Raw bytes shown before they are cut (hex characters after 0x). */
const MAX_HEX = 2 * 256;

const STANDARD: Abi = parseAbi([
  // ERC-20, and what ERC-721 shares with it
  'function transfer(address to, uint256 amount) returns (bool)', 'function transferFrom(address from, address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)', 'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)', 'function totalSupply() view returns (uint256)',
  'function decimals() view returns (uint8)', 'function symbol() view returns (string)', 'function name() view returns (string)',
  'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
  'function increaseAllowance(address spender, uint256 addedValue) returns (bool)', 'function decreaseAllowance(address spender, uint256 subtractedValue) returns (bool)',
  // ERC-721 and ERC-1155
  'function ownerOf(uint256 tokenId) view returns (address)', 'function setApprovalForAll(address operator, bool approved)',
  'function isApprovedForAll(address owner, address operator) view returns (bool)', 'function getApproved(uint256 tokenId) view returns (address)',
  'function supportsInterface(bytes4 interfaceId) view returns (bool)',
  // Wrapped native tokens
  'function deposit() payable', 'function withdraw(uint256 amount)',
  // Uniswap v2 pairs and v3 pools
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)', 'function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes data)',
  'function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes data) returns (int256 amount0, int256 amount1)',
  'function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes data)', 'function token0() view returns (address)', 'function token1() view returns (address)',
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  // Proxies, ERC-1271, ERC-4337 accounts
  'function implementation() view returns (address)', 'function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)',
  'function execute(address target, uint256 value, bytes data)', 'function executeBatch(address[] targets, uint256[] values, bytes[] datas)',
  // Permit2
  'function transferFrom(address from, address to, uint160 amount, address token)',
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
  'event Transfer(address indexed from, address indexed to, uint256 value)', 'event Approval(address indexed owner, address indexed spender, uint256 value)',
  // EIP-7708 (Amsterdam): a chain's own log of native coin burnt, beside its Transfer logs of native coin moved
  'event Burn(address indexed account, uint256 value)',
  'event ApprovalForAll(address indexed owner, address indexed operator, bool approved)',
  'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
  'event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)',
  'event Deposit(address indexed dst, uint256 wad)', 'event Withdrawal(address indexed src, uint256 wad)',
  'event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)',
  'event Sync(uint112 reserve0, uint112 reserve1)',
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
  'event Mint(address indexed sender, uint256 amount0, uint256 amount1)', 'event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to)',
  'event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)', 'event Upgraded(address indexed implementation)',
]);
/** ERC-721's Transfer and Approval: the same topic as ERC-20's, with the token ID indexed (a fourth topic). */
const NFT_EVENTS: Abi = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)', 'event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId)']);

const functionsBySelector = new Map<string, AbiFunction[]>();
for (const item of [...STANDARD.filter((x): x is AbiFunction => x.type === 'function'), ...COMMON_SIGNATURES.map(s => parseAbiItem(`function ${s}`) as AbiFunction)]) {
  const sel = toFunctionSelector(item);
  functionsBySelector.set(sel, [...(functionsBySelector.get(sel) ?? []), item]);
}
const eventsByTopic = new Map<string, AbiEvent[]>();
for (const item of [...STANDARD, ...NFT_EVENTS].filter((x): x is AbiEvent => x.type === 'event')) {
  const topic = toEventSelector(item);
  eventsByTopic.set(topic, [...(eventsByTopic.get(topic) ?? []), item]);
}

const PRECOMPILES: Record<string, string> = {
  '0x01': 'ecrecover', '0x02': 'sha256', '0x03': 'ripemd160', '0x04': 'identity', '0x05': 'modexp', '0x06': 'bn254 add', '0x07': 'bn254 mul', '0x08': 'bn254 pairing', '0x09': 'blake2f',
  '0x0a': 'KZG point evaluation', '0x0b': 'BLS12 G1 add', '0x0c': 'BLS12 G1 msm', '0x0d': 'BLS12 G2 add', '0x0e': 'BLS12 G2 msm', '0x0f': 'BLS12 pairing', '0x10': 'BLS12 map Fp to G1', '0x11': 'BLS12 map Fp2 to G2',
  '0x100': 'P256 verify',
};
const precompileName = (address: string) => { try { return PRECOMPILES[`0x${BigInt(address).toString(16).padStart(2, '0')}`]; } catch { return undefined; } };

const cut = (hex: string) => (hex.length > 2 + MAX_HEX ? `${hex.slice(0, 2 + MAX_HEX)}… (${(hex.length - 2) / 2} bytes)` : hex);

/** A decoded value as text: numbers in decimal, bytes cut when long, arrays and tuples in brackets (cut when long). */
function text(v: unknown, depth = 0): string {
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'string') return /^0x[0-9a-fA-F]*$/.test(v) ? cut(v.toLowerCase()) : JSON.stringify(v.length > 200 ? `${v.slice(0, 200)}…` : v);
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) {
    if (depth > 3) return '[…]';
    const parts = v.slice(0, 12).map(x => text(x, depth + 1));
    return `[${parts.join(', ')}${v.length > 12 ? `, … (${v.length} in all)` : ''}]`;
  }
  if (v && typeof v === 'object') {
    if (depth > 3) return '{…}';
    return `{${Object.entries(v).slice(0, 16).map(([k, x]) => `${k}: ${text(x, depth + 1)}`).join(', ')}}`;
  }
  return String(v);
}
const values = (params: readonly AbiParameter[], decoded: readonly unknown[]): TraceValue[] =>
  params.map((p, i) => ({ ...(p.name && { name: p.name }), type: p.type, value: text(decoded[i]) }));

type Named = { fn: AbiFunction; from: 'verified' | 'standard' | 'signature'; contract?: string };
/** Whose preview the trace is for: `account` is named `accountLabel` in it ("you" unless said: a Safe, a smart account). */
export interface TraceEnv { chainId: number; account?: string; accountLabel?: string; deps: Dependencies; /** Set by tracePreviews when the calls reach something a local EVM can't run: why. */ unsupported?: string; /** How long the tracing run may take, over the simulator's default (a replay's runs its block's earlier transactions first). */ budgetMs?: number; /** A replay's: what the block's access list records the transaction changed, to check the last call's state changes against (compareWithAccessList). */ recorded?: ReplayContext['recorded'] }

/** The function `data` calls among these, if its arguments decode as that function's. */
function match(fns: readonly AbiFunction[], data: Hex): { fn: AbiFunction; args: readonly unknown[] } | null {
  for (const fn of fns) {
    try { return { fn, args: decodeFunctionData({ abi: [fn], data }).args ?? [] }; } catch { /* another with this selector */ }
  }
  return null;
}

/** Each call's own events, in the order they were emitted, with the same naming as the calls. */
function eventOf(log: NonNullable<TraceCall['logs']>[number], abi: ContractAbi | undefined, label: string | undefined): TraceEvent {
  const base: TraceEvent = { index: log.index, address: log.address, ...(label && { label }), topics: log.topics, data: cut(log.data) };
  const topic0 = log.topics[0];
  if (!topic0) return base;
  const verified = ((abi?.abi ?? []) as Abi).filter((x): x is AbiEvent => x.type === 'event' && toEventSelector(x) === topic0);
  for (const [events, from] of [[verified, 'verified'], [eventsByTopic.get(topic0) ?? [], 'standard']] as const) {
    for (const event of events) {
      try {
        const d = decodeEventLog({ abi: [event], topics: log.topics as [Hex, ...Hex[]], data: log.data as Hex, strict: true });
        const args = d.args as unknown;
        const list = Array.isArray(args) ? args : event.inputs.map(p => (args as Record<string, unknown> | undefined)?.[p.name ?? '']);
        return { ...base, name: event.name, args: values(event.inputs, list), named: from };
      } catch { /* another event with this topic (ERC-721's Transfer) */ }
    }
  }
  return base;
}

/**
 * The trace as a preview shows it. `account` is the address the preview is for (shown as "you"); names are looked
 * up for the contracts and selectors it meets, within the limits above, and a lookup that fails only leaves a call
 * unnamed.
 */
export async function describeTrace(root: TraceCall, stateChanges: StateChange[] | undefined, env: TraceEnv,
  info: { source: string; agrees?: boolean; gasAgrees?: boolean; stateAgrees?: boolean; note?: string }): Promise<PreviewTrace> {
  const { chainId, deps } = env;
  const flat: { call: TraceCall; depth: number }[] = [];
  let total = 0;
  const walk = (call: TraceCall, depth: number) => {
    total++;
    if (flat.length < MAX_CALLS) flat.push({ call, depth });
    for (const k of call.calls ?? []) walk(k, depth + 1);
  };
  walk(root, 0);

  // Verified ABIs for the contracts called most often (the code that runs: a proxy's implementation).
  const counts = new Map<string, number>();
  for (const { call } of flat) if (call.to && !call.precompile && call.input.length >= 10) counts.set(call.to, (counts.get(call.to) ?? 0) + 1);
  const wanted = [...counts].sort((a, b) => b[1] - a[1]).slice(0, MAX_ABIS).map(([a]) => a);
  const abis = new Map<string, ContractAbi>();
  if (deps.abis) {
    await Promise.all(wanted.map(async address => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const abi = await Promise.race([deps.abis!.resolve(chainId, address), new Promise<null>(r => { timer = setTimeout(() => r(null), ABI_TIMEOUT_MS); (timer as { unref?: () => void }).unref?.(); })]);
        if (abi) abis.set(address, abi);
      } catch { /* unnamed */ } finally { clearTimeout(timer); }
    }));
  }
  // Selectors nothing names yet: the signature databases' best candidate, a guess.
  const guessed = new Map<string, AbiFunction[]>();
  const named = (call: TraceCall): { fn: AbiFunction; args: readonly unknown[]; from: Named['from'] } | null => {
    const data = call.input as Hex, selector = data.slice(0, 10);
    const abi = call.to ? abis.get(call.to) : undefined;
    const own = abi ? match((abi.abi as Abi).filter((x): x is AbiFunction => x.type === 'function' && toFunctionSelector(x) === selector), data) : null;
    if (own) return { ...own, from: abi!.verified ? 'verified' : 'signature' };
    const standard = match(functionsBySelector.get(selector) ?? [], data);
    if (standard) return { ...standard, from: 'standard' };
    const guess = match(guessed.get(selector) ?? [], data);
    return guess ? { ...guess, from: 'signature' } : null;
  };
  if (deps.signatures) {
    const unknown = [...new Set(flat.filter(({ call }) => !call.precompile && call.input.length >= 10 && call.type !== 'create' && call.type !== 'create2' && !named(call)).map(({ call }) => call.input.slice(0, 10)))].slice(0, MAX_LOOKUPS);
    await Promise.all(unknown.map(async selector => {
      try {
        const candidates = deps.signatures!.candidates ? (await deps.signatures!.candidates(selector)).filter(c => c.tier <= 1).map(c => c.signature) : [];
        const fns = candidates.slice(0, 3).flatMap(s => { try { return [parseAbiItem(`function ${s}`) as AbiFunction]; } catch { return []; } });
        if (fns.length) guessed.set(selector, fns);
      } catch { /* unnamed */ }
    }));
  }

  // Token names: the built-in list, and the registry for the contracts that moved or were asked like tokens (those
  // that emitted Transfer or Approval, or were called with ERC-20's functions), a few at most.
  const tokens = new Map(builtinTokens(chainId).map(t => [t.address.toLowerCase(), t.symbol]));
  if (deps.tokens) {
    const like = new Set<string>();
    for (const { call } of flat) {
      for (const l of call.logs ?? []) if (l.topics[0] === TRANSFER_TOPIC || l.topics[0] === APPROVAL_TOPIC) like.add(l.address.toLowerCase());
      if (call.to && ERC20_SELECTORS.has(call.input.slice(0, 10))) like.add(call.to.toLowerCase());
    }
    await Promise.all([...like].filter(a => !tokens.has(a)).slice(0, MAX_TOKENS).map(async address => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const info = await Promise.race([deps.tokens!.get(chainId, address), new Promise<undefined>(r => { timer = setTimeout(() => r(undefined), ABI_TIMEOUT_MS); (timer as { unref?: () => void }).unref?.(); })]);
        if (info?.symbol) tokens.set(address, info.symbol);
      } catch { /* unnamed */ } finally { clearTimeout(timer); }
    }));
  }
  const account = env.account?.toLowerCase();
  const label = (address: string | null): string | undefined => {
    if (!address) return undefined;
    const a = address.toLowerCase();
    // EIP-7708's log of a native transfer comes from an address of the chain's own, not a token's.
    if (a === NATIVE_LOG_ADDRESS) return `${CHAINS[env.chainId]?.nativeSymbol ?? 'native coin'} (the chain's own log)`;
    return a === account ? env.accountLabel ?? 'you' : tokens.get(a) ?? abis.get(a)?.name ?? precompileName(a);
  };

  const calls: TraceEntry[] = flat.map(({ call, depth }) => {
    const entry: TraceEntry = { depth, type: call.type, from: call.from, to: call.to, gasUsed: call.gasUsed.toString() };
    const toLabel = label(call.to), fromLabel = label(call.from);
    if (toLabel) entry.label = toLabel;
    if (fromLabel) entry.fromLabel = fromLabel;
    if (call.value > 0n) entry.value = call.value.toString();
    if (call.precompile) entry.precompile = true;
    const creating = call.type === 'create' || call.type === 'create2';
    if (creating) entry.function = `new contract (${(call.input.length - 2) / 2} bytes of creation code)`;
    else if (call.input.length >= 10 && !call.precompile) {
      entry.selector = call.input.slice(0, 10);
      const n = named(call);
      if (n) {
        entry.function = toFunctionSignature(n.fn);
        entry.args = values(n.fn.inputs, n.args);
        entry.named = n.from;
        if (call.output && !call.error && n.fn.outputs.length) {
          try {
            const out = decodeFunctionResult({ abi: [n.fn], data: call.output as Hex }) as unknown;
            entry.returns = values(n.fn.outputs, n.fn.outputs.length === 1 ? [out] : out as unknown[]);
          } catch { /* shown raw */ }
        }
      } else entry.input = cut(call.input);
    } else if (call.input.length > 2) entry.input = cut(call.input);
    if (call.output && !entry.returns && !creating) entry.output = cut(call.output);
    if (call.error) entry.error = call.error;
    if (call.logs?.length) entry.events = call.logs.map(l => eventOf(l, abis.get(l.address) ?? (call.to ? abis.get(call.to) : undefined), label(l.address)));
    // One line, as a reader would say it: who is called, what, with what.
    const who = entry.label ?? (call.to ? `${call.to.slice(0, 10)}…${call.to.slice(-4)}` : 'a new contract');
    const what = creating ? '' : entry.function ? `.${entry.function.slice(0, entry.function.indexOf('('))}(${(entry.args ?? []).map(a => (a.value.length > 48 ? `${a.value.slice(0, 48)}…` : a.value)).join(', ')})` : entry.selector ? `.${entry.selector}(…)` : '';
    entry.text = `${call.type === 'call' ? '' : `${call.type} `}${creating ? `${entry.function}${call.to ? ` at ${call.to}` : ''}` : `${who}${what}`}${call.value > 0n ? ` with ${nativeText(chainId, call.value)}` : ''}${call.error ? ` — failed: ${call.error}` : ''}`;
    return entry;
  });

  return {
    source: info.source, ...(info.agrees !== undefined && { agrees: info.agrees }), ...(info.gasAgrees !== undefined && { gasAgrees: info.gasAgrees }), ...(info.stateAgrees !== undefined && { stateAgrees: info.stateAgrees }), ...(info.note && { note: info.note }),
    calls, ...(total > flat.length && { truncated: true, totalCalls: total }),
    ...(stateChanges?.length && { stateChanges: stateChanges.map(s => ({
      address: s.address, ...(label(s.address) && { label: label(s.address) }),
      ...(s.balance && { balance: { before: s.balance.before.toString(), after: s.balance.after.toString(), change: `${s.balance.after >= s.balance.before ? '+' : '-'}${nativeText(chainId, s.balance.after >= s.balance.before ? s.balance.after - s.balance.before : s.balance.before - s.balance.after)}` } }),
      ...(s.nonce && { nonce: { before: s.nonce.before.toString(), after: s.nonce.after.toString() } }),
      ...(s.code && { code: true }),
      ...(s.storage && { storage: s.storage.slice(0, 64), ...(s.storage.length > 64 && { storageSlots: s.storage.length }) }),
    })) }),
  };
}

function nativeText(chainId: number, v: bigint): string {
  const decimals = CHAINS[chainId]?.nativeDecimals ?? 18, symbol = CHAINS[chainId]?.nativeSymbol ?? 'native';
  const whole = v / 10n ** BigInt(decimals), frac = (v % 10n ** BigInt(decimals)).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${whole}${frac ? `.${frac}` : ''} ${symbol}`;
}

/**
 * Logs a chain writes itself, outside the EVM: Polygon's node logs every native transfer and every fee payment
 * from its 0x…1010 contract (LogTransfer, LogFeeTransfer). A local EVM run has none, and they say nothing a
 * balance change doesn't, so runs are compared without them.
 */
export function chainsOwnLog(l: { address: string; topics: string[] }): boolean {
  return l.address.toLowerCase() === '0x0000000000000000000000000000000000001010' && (l.topics[0] === '0xe6497e3ee548a3372136af2fcb0696db31fc6cf20260707645068bd3fe97f3c4' || l.topics[0] === '0x4dfe1bbbcf077ddc3e01291eea2d5c70c2b422b415d95645b9adcfd678cb1d63');
}

/** Why a preview asked for a trace has none, for its notes (after tracePreviews returned null). */
export function noTrace(env: TraceEnv): string {
  return env.unsupported ? `No trace: ${env.unsupported}.` : "No trace: a trace is run in a local EVM over the chain's state, which isn't set up for this chain here, or didn't finish in time.";
}

/** Whether two simulations of the same call did the same thing: the same outcome and the same events, in order. */
export function sameRun(a: { status: string; logs?: { address: string; topics: string[]; data: string }[] }, b: { status: string; logs?: { address: string; topics: string[]; data: string }[] }): boolean {
  if (a.status !== b.status) return false;
  const key = (l: { address: string; topics: string[]; data: string }) => `${l.address.toLowerCase()}|${l.topics.join(',').toLowerCase()}|${l.data.toLowerCase()}`;
  const x = (a.logs ?? []).filter(l => !chainsOwnLog(l)).map(key), y = (b.logs ?? []).filter(l => !chainsOwnLog(l)).map(key);
  return x.length === y.length && x.every((k, i) => k === y[i]);
}

/** A B20 token's address (Base: the stand-ins that aren't one are the registries its tokens ask). */
const B20_TOKEN = /^0xb2000000000000000000/i;

/** Whether a call in the tree runs `address`'s code (the call itself, or one under it). */
function reaches(call: TraceCall, address: string): boolean {
  return call.to?.toLowerCase() === address || (call.calls ?? []).some(c => reaches(c, address));
}

/**
 * The traces of `requests` (run in order, where they can be traced: Simulator.trace), each checked against the
 * simulation the preview shows for that call. Null when nothing can trace calls on this chain, or the tracing run
 * failed or ran out of time; a call the tracing run has no trace for gets none.
 */
export async function tracePreviews(requests: SimulationRequest[], shown: (SimulationResult | null | undefined)[], env: TraceEnv): Promise<(PreviewTrace | undefined)[] | null> {
  const sim = env.deps.simulator;
  if (!sim?.trace || !requests.length) return null;
  let traced: SimulationResult[] | null;
  try { traced = await sim.trace(requests, env.budgetMs !== undefined ? { budgetMs: env.budgetMs } : undefined); } catch (e) {
    if (e instanceof Error && e.name === 'ForkUnsupported') env.unsupported = e.message;
    traced = null;
  }
  if (!traced) return null;
  const at = requests[0].at;
  const where = `a local EVM over ${CHAINS[env.chainId]?.name ?? `chain ${env.chainId}`}'s state${at && /^0x[0-9a-f]+$/i.test(at.block) ? ` at block ${BigInt(at.block)}` : ''}`;
  return Promise.all(traced.map(async (t, i) => {
    if (!t.trace) return undefined;
    const s = shown[i];
    // The run shown is the node's: the trace is of it only as far as the local run did the same.
    const agrees = !s || s === t ? undefined : sameRun(t, s);
    const differs = agrees === false ? `The traced run ${t.status !== s!.status ? `ended differently (${t.status === 'success' ? 'it succeeded' : `it failed${t.revertReason ? `: ${t.revertReason}` : ''}`})` : 'emitted different events'} from the simulation shown above, which the chain's own node ran: take the trace as a guide to what the transaction does, not as its record.` : undefined;
    // The simulation shown ran on another block than the trace (the node couldn't serve the one named).
    // Two runs that did the same should have used the same gas: where they didn't, the local EVM's gas rules aren't
    // the chain's here (a fork it wasn't checked against, an older block's rules). Compared for calls that succeeded
    // (a failure that burns its gas limit burns each simulator's own default), and not on Arbitrum, whose node adds
    // a charge for L1 data that no EVM run has.
    // A run that reached a contract the node runs itself from its Solidity reference (Base's B20 tokens) is compared
    // too: the reference's calls are charged what the node charges (see ForkSimulator's rounds), and say so.
    // (A registry a B20 token asked is left out of the tree, as the chain's token reads it with no call: it counts as
    // reached when such a token is.)
    const tokenReached = !!t.trace && !!t.standIns?.some(a => B20_TOKEN.test(a) && reaches(t.trace!, a));
    const standIns = t.standIns && t.trace ? t.standIns.filter(a => reaches(t.trace!, a) || (tokenReached && !B20_TOKEN.test(a))) : [], stale = standIns.filter(a => t.standInsStale?.includes(a));
    const gasAgrees = agrees && s!.status === 'success' && s!.gasUsed !== undefined && t.gasUsed !== undefined && !NEXT_BLOCK[env.chainId]?.arbitrum && t.source !== 'mock' ? s!.gasUsed === t.gasUsed : undefined;
    const standInNote = standIns.length ? `${standIns.length === 1 ? `${standIns[0]}, which this chain's node runs itself,` : `${standIns.length} contracts this chain's node runs itself (${standIns.join(', ')})`} ran in the trace from ${standIns.length === 1 ? 'its' : 'their'} Solidity reference (the Base Standard Library's), which keeps its state where the node does, charged the gas the node charges.${stale.length ? ` An earlier transaction in the block changed ${stale.join(', ')}, whose state could be read only as of the block before: the trace ran on that, and may not be what happened.` : ''}` : undefined;
    const gasDiffers = gasAgrees === false ? `The traced run used ${t.gasUsed!.toLocaleString('en-US')} gas where the simulation shown above used ${s!.gasUsed!.toLocaleString('en-US')}: the local EVM's gas rules differ from this chain's here, so the gas figures in the trace are approximate.` : undefined;
    // A replay in a block that carries its access list: the state the traced run changed against what the chain
    // recorded for the transaction (the last call traced).
    const state = env.recorded && i === traced.length - 1 ? compareWithAccessList(t.stateChanges, env.recorded) : undefined;
    const stateDiffers = state && !state.agrees ? `The state the traced run changed isn't what the block's access list records for this transaction (${state.differences!.slice(0, 3).join('; ')}${state.differences!.length > 3 ? `; and ${state.differences!.length - 3} more` : ''}): the trace is a guide to what it did, not its record.` : undefined;
    const note = [s?.traceNote, differs, gasDiffers, stateDiffers, standInNote, t.rulesNote].filter(Boolean).join(' ');
    return describeTrace(t.trace, t.stateChanges, env, { source: t.source === 'mock' ? 'mock data' : where, ...(agrees !== undefined && { agrees }), ...(gasAgrees !== undefined && { gasAgrees }), ...(state && { stateAgrees: state.agrees }), ...(note && { note }) });
  }));
}

/**
 * A traced run's state changes against what a block's access list records its transaction changed (EIP-7928, from
 * Amsterdam on): every storage slot, nonce, balance and code, each as it stood after the transaction.
 *
 * Two things the list counts that a traced call doesn't are put back first. The fee: the sender's balance on the
 * chain is lower by what was paid, the fee recipient's higher by the tip; a balance the list has for either that
 * the trace doesn't touch is taken to be the fee alone. And the sender's nonce, which goes up by one with every
 * transaction: checked against the transaction's own.
 */
export function compareWithAccessList(changes: StateChange[] | undefined, r: NonNullable<ReplayContext['recorded']>): { agrees: boolean; differences?: string[]; compared: number } {
  const chain = { slot: new Map<string, bigint>(), nonce: new Map<string, bigint>(), balance: new Map<string, bigint>(), code: new Set<string>() };
  for (const [address, c] of Object.entries(r.changes)) {
    for (const [slot, value] of Object.entries(c.stateDiff ?? {})) chain.slot.set(`${address} slot 0x${BigInt(slot).toString(16)}`, BigInt(value));
    if (c.balance !== undefined) chain.balance.set(address, BigInt(c.balance));
    if (c.nonce !== undefined) chain.nonce.set(address, BigInt(c.nonce));
    if (c.code !== undefined) chain.code.add(address);
  }
  const local = { slot: new Map<string, bigint>(), nonce: new Map<string, bigint>(), balance: new Map<string, bigint>(), code: new Set<string>() };
  for (const c of changes ?? []) {
    const address = c.address.toLowerCase();
    for (const s of c.storage ?? []) local.slot.set(`${address} slot 0x${BigInt(s.slot).toString(16)}`, BigInt(s.after));
    if (c.balance) local.balance.set(address, c.balance.after);
    if (c.nonce) local.nonce.set(address, c.nonce.after);
    if (c.code) local.code.add(address);
  }
  const differences: string[] = [];
  let compared = chain.slot.size + chain.nonce.size + chain.balance.size + chain.code.size;
  // The sender's nonce: the transaction's own, and one more.
  if (!local.nonce.has(r.sender) && chain.nonce.has(r.sender)) {
    if (chain.nonce.get(r.sender) !== r.nonce + 1n) differences.push(`the sender's nonce is ${chain.nonce.get(r.sender)} in the list, ${r.nonce + 1n} after this transaction`);
    chain.nonce.delete(r.sender);
  }
  // The fee, put back; a balance of the sender's or the fee recipient's the trace doesn't touch is the fee alone.
  if (chain.balance.has(r.sender)) { if (local.balance.has(r.sender)) chain.balance.set(r.sender, chain.balance.get(r.sender)! + r.fee); else chain.balance.delete(r.sender); }
  if (chain.balance.has(r.coinbase) && r.coinbase !== r.sender) { if (local.balance.has(r.coinbase)) chain.balance.set(r.coinbase, chain.balance.get(r.coinbase)! - r.tip); else chain.balance.delete(r.coinbase); }
  const both = (what: string, theirs: Map<string, bigint>, ours: Map<string, bigint>, name: (k: string) => string) => {
    for (const [k, v] of theirs) { if (!ours.has(k)) differences.push(`${name(k)} is ${what === 'slot' ? `0x${v.toString(16)}` : v} in the list and unchanged in the trace`); else if (ours.get(k) !== v) differences.push(`${name(k)} is ${what === 'slot' ? `0x${v.toString(16)}` : v} in the list, ${what === 'slot' ? `0x${ours.get(k)!.toString(16)}` : ours.get(k)} in the trace`); }
    for (const k of ours.keys()) if (!theirs.has(k)) differences.push(`${name(k)} changes in the trace and not in the list`);
  };
  both('slot', chain.slot, local.slot, k => k);
  both('nonce', chain.nonce, local.nonce, k => `${k}'s nonce`);
  both('balance', chain.balance, local.balance, k => `${k}'s balance`);
  for (const a of chain.code) if (!local.code.has(a)) differences.push(`${a}'s code changes in the list and not in the trace`);
  for (const a of local.code) if (!chain.code.has(a)) differences.push(`${a}'s code changes in the trace and not in the list`);
  return differences.length ? { agrees: false, differences, compared } : { agrees: true, compared };
}

/**
 * How a replay's run compares with the receipt: the outcome; then, when that is the same, the events in order and
 * the gas. On Arbitrum the node adds its own charge for L1 data to the gas, between none and twice the receipt's.
 */
export function compareWithReceipt(sim: SimulationResult, r: ReplayContext['receipt']): { matches: boolean; differences?: string[] } {
  const differences: string[] = [];
  const said = (s: 'success' | 'reverted') => (s === 'success' ? 'succeeded' : 'reverted');
  if (sim.status !== r.status) {
    differences.push(`the run ${said(sim.status)}${sim.status === 'reverted' && sim.revertReason ? ` (${sim.revertReason})` : ''} where the receipt says it ${said(r.status)}`);
  } else {
    const logs = (sim.logs ?? (sim.status === 'reverted' ? [] : undefined))?.filter(l => !chainsOwnLog(l));
    const theirs = r.logs.filter(l => !chainsOwnLog(l));
    if (!logs) differences.push('the run\'s events couldn\'t be read back to compare');
    else {
      const same = (a: { address: string; topics: string[]; data: string }, b: typeof a) => a.address.toLowerCase() === b.address.toLowerCase() && a.data.toLowerCase() === b.data.toLowerCase() && a.topics.length === b.topics.length && a.topics.every((t, i) => t.toLowerCase() === b.topics[i].toLowerCase());
      const first = theirs.findIndex((l, i) => !logs[i] || !same(l, logs[i]));
      if (logs.length !== theirs.length) differences.push(`the run emitted ${logs.length} event${logs.length === 1 ? '' : 's'} where the receipt has ${theirs.length}`);
      else if (first !== -1) differences.push(`event ${first + 1} of ${theirs.length} differs from the receipt's`);
    }
    const gas = sim.gasUsed;
    const inBand = gas !== undefined && (gas === r.gasUsed || (r.gasForL1 !== undefined && gas >= r.gasUsed && gas - r.gasUsed <= 2n * r.gasForL1));
    if (!inBand) differences.push(gas === undefined ? 'the run reported no gas to compare' : `the run used ${gas.toLocaleString('en-US')} gas where the receipt says ${r.gasUsed.toLocaleString('en-US')}`);
  }
  return differences.length ? { matches: false, differences } : { matches: true };
}
