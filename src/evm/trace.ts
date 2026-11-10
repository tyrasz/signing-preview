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
import type { ContractAbi, Dependencies, PreviewTrace, SimulationRequest, SimulationResult, StateChange, TraceCall, TraceEntry, TraceEvent, TraceValue } from '../types.ts';
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
export async function describeTrace(root: TraceCall, stateChanges: StateChange[] | undefined, env: { chainId: number; account?: string; deps: Dependencies },
  info: { source: string; agrees?: boolean; note?: string }): Promise<PreviewTrace> {
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
    return a === account ? 'you' : tokens.get(a) ?? abis.get(a)?.name ?? precompileName(a);
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
    source: info.source, ...(info.agrees !== undefined && { agrees: info.agrees }), ...(info.note && { note: info.note }),
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

/** Whether two simulations of the same call did the same thing: the same outcome and the same events, in order. */
export function sameRun(a: { status: string; logs?: { address: string; topics: string[]; data: string }[] }, b: { status: string; logs?: { address: string; topics: string[]; data: string }[] }): boolean {
  if (a.status !== b.status) return false;
  const key = (l: { address: string; topics: string[]; data: string }) => `${l.address.toLowerCase()}|${l.topics.join(',').toLowerCase()}|${l.data.toLowerCase()}`;
  const x = (a.logs ?? []).map(key), y = (b.logs ?? []).map(key);
  return x.length === y.length && x.every((k, i) => k === y[i]);
}

/**
 * The traces of `requests` (run in order, where they can be traced: Simulator.trace), each checked against the
 * simulation the preview shows for that call. Null when nothing can trace calls on this chain, or the tracing run
 * failed or ran out of time; a call the tracing run has no trace for gets none.
 */
export async function tracePreviews(requests: SimulationRequest[], shown: (SimulationResult | null | undefined)[], env: { chainId: number; account?: string; deps: Dependencies }): Promise<(PreviewTrace | undefined)[] | null> {
  const sim = env.deps.simulator;
  if (!sim?.trace || !requests.length) return null;
  let traced: SimulationResult[] | null;
  try { traced = await sim.trace(requests); } catch { traced = null; }
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
    const note = [s?.traceNote, differs].filter(Boolean).join(' ');
    return describeTrace(t.trace, t.stateChanges, env, { source: t.source === 'mock' ? 'mock data' : where, ...(agrees !== undefined && { agrees }), ...(note && { note }) });
  }));
}
