// Fork simulation: the transaction runs in a local EVM (@ethereumjs/evm) whose state is fetched from the chain's RPC
// on demand, as Foundry's fork mode does. It needs only standard state reads (eth_getBalance, eth_getCode,
// eth_getTransactionCount, eth_getStorageAt), so it works where the RPC has no eth_simulateV1 or tracing (HyperEVM),
// and gives what those would: every log, so every token and NFT the transaction touches, and exact revert data.
//
// Fetching one value per round trip would take tens of seconds. Instead each run is speculative: a value not yet
// fetched reads as empty and is noted; everything noted is fetched in parallel JSON-RPC batches and the run repeats,
// until a run needs nothing new. Only the last run counts, and it saw real values throughout.
//
// Amounts come from the state, not the logs: the account's balance of each token its Transfer logs mention (and of
// the native coin) is read before and after each call, so fee-on-transfer and rebasing tokens come out exact.
// Approvals come from Approval logs and are read back from the token after each call.
import { createEVM, EVMError, type EVM } from '@ethereumjs/evm';
import { createCustomCommon, Mainnet } from '@ethereumjs/common';
import { SimpleStateManager } from '@ethereumjs/statemanager';
import { Account, bytesToHex, createAddressFromString, hexToBytes, unpadBytes, type Address } from '@ethereumjs/util';
import { keccak256 } from 'viem';
import { builtinTokens, CHAINS, PERMIT2 } from './chains.ts';
import { calldataCandidates } from './simulation-probe.ts';
import { formatUnits } from './format.ts';
import { approvalKey, decodeRevert, decodeState, parseLogs, stateCall } from './simulation.ts';
import type { SimulatedApproval, SimulatedTransfer, SimulationRequest, SimulationResult, Simulator } from './types.ts';

type Hex = `0x${string}`;
interface AccountData { balance: bigint; nonce: bigint; code: Uint8Array }
interface Misses { accounts: Set<string>; storage: Set<string>; calls: Set<string> }
const newMisses = (): Misses => ({ accounts: new Set(), storage: new Set(), calls: new Set() });
const missCount = (m: Misses) => m.accounts.size + m.storage.size + m.calls.size;

export interface ChainProfile {
  /** EVM rules, e.g. 'cancun' (HyperEVM) or 'osaka' (Ethereum). */
  hardfork: string;
  /** Seconds between blocks, for the simulated next block's timestamp. */
  blockTime: number;
  /** Precompiles the local EVM doesn't have; their calls are answered by eth_call on the chain (HyperEVM's HyperCore reads). */
  forwardedPrecompiles?: string[];
  /** Gas a forwarded precompile call costs. */
  precompileGas?: (inputBytes: number, outputBytes: number) => bigint;
}

/** HyperEVM's read precompiles (0x…0800 onward: positions, spot balances, prices, L1 block number...). */
const HYPERCORE_READS = Array.from({ length: 64 }, (_, i) => `0x${(0x800 + i).toString(16).padStart(40, '0')}`);

/** Measured on each chain (2026-11-05): HyperEVM runs Cancun rules (no CLZ, no BLS precompiles); Ethereum, Osaka. */
export const CHAIN_PROFILES: Record<number, ChainProfile> = {
  1: { hardfork: 'osaka', blockTime: 12 },
  11155111: { hardfork: 'osaka', blockTime: 12 },
  999: { hardfork: 'cancun', blockTime: 1, forwardedPrecompiles: HYPERCORE_READS, precompileGas: (i, o) => 2000n + 65n * BigInt(i + o) },
  998: { hardfork: 'cancun', blockTime: 1, forwardedPrecompiles: HYPERCORE_READS, precompileGas: (i, o) => 2000n + 65n * BigInt(i + o) },
};

export interface ForkSimulatorOptions {
  fetchImpl?: typeof fetch;
  /** JSON-RPC requests per HTTP request; HyperEVM's public RPC accepts at most 20. */
  batchSize?: number;
  /** HTTP requests in flight at once. */
  concurrency?: number;
  /** Speculative rounds before the remaining values are fetched one at a time. */
  maxRounds?: number;
  /** Overall time budget; past it the simulation fails (a caller can fall back to something cheaper). */
  timeoutMs?: number;
  /** The state to simulate on: 'latest' (default), or a block number to replay a transaction at its pre-state. */
  block?: (chainId: number) => string;
  /**
   * The simulated block's header. By default, the next block after `block`: its number + 1, its timestamp plus the
   * chain's block time, and its fee recipient, randomness and base fee. Replays pass the real block's header.
   */
  header?: (chainId: number) => { number: bigint; timestamp: bigint; coinbase: string; prevRandao: Hex; gasLimit: bigint; baseFeePerGas: bigint } | undefined;
  profiles?: Record<number, ChainProfile>;
  /** Called after each speculative round with what it still needed (for tuning). */
  onRound?: (round: number, misses: { accounts: string[]; storage: string[]; calls: string[] }, grew: boolean) => void;
}

/** The simulation ran out of its time budget. */
export class ForkTimeout extends Error {
  constructor(message: string) { super(message); this.name = 'ForkTimeout'; }
}

const GAS = 30_000_000n;
/** EIP-1967 implementation and beacon slots, and ZeppelinOS's (USDC): fetched with every new contract, saving a round per proxy. */
const PROXY_SLOTS = ['0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc', '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50', '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3'];
/**
 * Contract code by chain and address, shared by all simulations: once deployed, code can't change (Cancun removed
 * self-destruct redeployment). Only non-empty code is kept, since an empty address can still be deployed to.
 */
const CODE_CACHE = new Map<string, Uint8Array>();
const CODE_CACHE_MAX = 4000;

/**
 * The last value seen of every balance, nonce, storage slot and forwarded call, by chain, shared by all simulations.
 * Speculative runs use them as guesses instead of zeros, so a long chain of dependent reads (a diamond router's
 * facet, then the facet's storage, then the contract it names...) is discovered in one run rather than one round per
 * link. A guess is only a guess: every value a run guessed is fetched fresh, and only a run that used fresh values
 * throughout is accepted.
 */
class Guesses<V> {
  private map = new Map<string, V>();
  private max: number;
  constructor(max: number) { this.max = max; }
  get(k: string) { return this.map.get(k); }
  set(k: string, v: V) {
    this.map.delete(k);
    this.map.set(k, v);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }
}
const GUESS_ACCOUNTS = new Guesses<{ balance: bigint; nonce: bigint; hasCode: boolean }>(20_000);
const GUESS_STORAGE = new Guesses<Uint8Array>(200_000);
const GUESS_CALLS = new Guesses<{ ok: boolean; data: Uint8Array }>(20_000);
const ZERO = '0x0000000000000000000000000000000000000000';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/** Fetches accounts, storage and forwarded calls from the RPC, in batches, and keeps them for the simulation. */
class StateSource {
  accounts = new Map<string, AccountData>();
  storage = new Map<string, Uint8Array>();
  calls = new Map<string, { ok: boolean; data: Uint8Array }>();
  requests = 0;
  /** Code given to accounts for this simulation (EIP-7702 delegation designators), instead of theirs. */
  codeOverrides = new Map<string, Uint8Array>();
  private url: string; private block: string; private fetchImpl: typeof fetch; private batchSize: number; private concurrency: number; private deadline: number;
  private chainId: number;
  constructor(chainId: number, url: string, block: string, fetchImpl: typeof fetch, batchSize: number, concurrency: number, deadline: number) {
    this.chainId = chainId; this.url = url; this.block = block; this.fetchImpl = fetchImpl; this.batchSize = batchSize; this.concurrency = concurrency; this.deadline = deadline;
  }

  /** The header of block `tag` (with the same retries as state reads). */
  async header(tag: string): Promise<{ number: Hex; timestamp: Hex; miner: Hex; mixHash?: Hex; gasLimit: Hex; baseFeePerGas?: Hex }> {
    let h: unknown;
    await this.send([{ method: 'eth_getBlockByNumber', params: [tag, false], done: r => { h = r; } }]);
    if (!h) throw new Error(`block ${tag} not found`);
    return h as { number: Hex; timestamp: Hex; miner: Hex; mixHash?: Hex; gasLimit: Hex; baseFeePerGas?: Hex };
  }

  async fetch(m: Misses): Promise<void> {
    type Job = { method: string; params: unknown[]; done: (result: unknown, error?: { message?: string; data?: Hex }) => void };
    const jobs: Job[] = [];
    const pending: [string, AccountData][] = [];
    for (const a of m.accounts) {
      const cached = this.codeOverrides.get(a) ?? CODE_CACHE.get(`${this.chainId}:${a}`);
      const acc: AccountData = { balance: 0n, nonce: 0n, code: cached ?? new Uint8Array(0) };
      pending.push([a, acc]);
      jobs.push({ method: 'eth_getBalance', params: [a, this.block], done: r => { acc.balance = BigInt(r as string); } });
      jobs.push({ method: 'eth_getTransactionCount', params: [a, this.block], done: r => { acc.nonce = BigInt(r as string); } });
      if (!cached) jobs.push({ method: 'eth_getCode', params: [a, this.block], done: r => {
        acc.code = hexToBytes(r as Hex);
        if (acc.code.length && CODE_CACHE.size < CODE_CACHE_MAX) CODE_CACHE.set(`${this.chainId}:${a}`, acc.code);
      } });
      // Most contracts are proxies: their implementation is the next thing a call reads.
      for (const slot of PROXY_SLOTS) if (!this.storage.has(`${a}_${slot}`) && !m.storage.has(`${a}_${slot}`)) {
        jobs.push({ method: 'eth_getStorageAt', params: [a, slot, this.block], done: r => { this.setStorage(`${a}_${slot}`, unpadBytes(hexToBytes(r as Hex))); } });
      }
    }
    for (const k of m.storage) {
      const [a, slot] = k.split('_');
      jobs.push({ method: 'eth_getStorageAt', params: [a, slot, this.block], done: r => { this.setStorage(k, unpadBytes(hexToBytes(r as Hex))); } });
    }
    for (const k of m.calls) {
      const [to, data] = k.split('_');
      jobs.push({ method: 'eth_call', params: [{ to, data }, this.block], done: (r, e) => {
        const v = e ? { ok: false, data: e.data ? hexToBytes(e.data) : new Uint8Array(0) } : { ok: true, data: hexToBytes(r as Hex) };
        this.calls.set(k, v);
        GUESS_CALLS.set(`${this.chainId}:${k}`, v);
      } });
    }
    const batches: Job[][] = [];
    for (let i = 0; i < jobs.length; i += this.batchSize) batches.push(jobs.slice(i, i + this.batchSize));
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(this.concurrency, batches.length) }, async () => {
      while (next < batches.length) await this.send(batches[next++]);
    }));
    for (const [a, acc] of pending) {
      this.accounts.set(a, acc);
      GUESS_ACCOUNTS.set(`${this.chainId}:${a}`, { balance: acc.balance, nonce: acc.nonce, hasCode: acc.code.length > 0 });
    }
  }

  private setStorage(k: string, v: Uint8Array) {
    this.storage.set(k, v);
    GUESS_STORAGE.set(`${this.chainId}:${k}`, v);
  }

  /** A previously seen value, as a guess (accounts with code only when their code is cached). */
  guessAccount(a: string): AccountData | undefined {
    const g = GUESS_ACCOUNTS.get(`${this.chainId}:${a}`);
    if (!g) return undefined;
    const code = this.codeOverrides.get(a) ?? (g.hasCode ? CODE_CACHE.get(`${this.chainId}:${a}`) : new Uint8Array(0));
    return code ? { balance: g.balance, nonce: g.nonce, code } : undefined;
  }
  guessStorage(k: string) { return GUESS_STORAGE.get(`${this.chainId}:${k}`); }
  guessCall(k: string) { return GUESS_CALLS.get(`${this.chainId}:${k}`); }

  private async send(batch: { method: string; params: unknown[]; done: (r: unknown, e?: { message?: string; data?: Hex }) => void }[]) {
    for (let attempt = 0; ; attempt++) {
      if (Date.now() > this.deadline) throw new ForkTimeout('the simulation ran out of time fetching chain state');
      this.requests += batch.length;
      const res = await this.fetchImpl(this.url, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15_000),
        body: JSON.stringify(batch.map((j, i) => ({ jsonrpc: '2.0', id: i, method: j.method, params: j.params }))) });
      const body = res.ok ? await res.json() as unknown : undefined;
      // Rate limits, and load-balanced nodes a block behind ("invalid block height") are worth retrying.
      const transient = /rate limit|invalid block height|header not found|unknown block/i;
      const limited = res.status === 429 || (!Array.isArray(body) && transient.test(JSON.stringify(body ?? '')));
      if ((limited || res.status >= 500) && attempt < 5) { await new Promise(r => setTimeout(r, 300 * 2 ** attempt)); continue; }
      if (!Array.isArray(body)) throw new Error(`state fetch failed: HTTP ${res.status} ${JSON.stringify(body ?? '').slice(0, 160)}`);
      const byId = new Map((body as { id: number; result?: unknown; error?: { code?: number; message?: string; data?: Hex } }[]).map(r => [r.id, r]));
      const retry = batch.filter((_, i) => transient.test(byId.get(i)?.error?.message ?? ''));
      batch.forEach((j, i) => {
        const r = byId.get(i);
        if (!r || transient.test(r.error?.message ?? '')) return;
        // eth_call reverts are answers (a forwarded precompile can revert); a failed state read is not.
        if (r.error && j.method !== 'eth_call') throw new Error(`${j.method} failed: ${r.error.message}`);
        j.done(r.result, r.error);
      });
      if (!retry.length) return;
      if (attempt >= 5) throw new Error('state fetch: rate limited');
      batch = retry;
      await new Promise(r => setTimeout(r, 300 * 2 ** attempt));
    }
  }
}

/**
 * SimpleStateManager whose missing values come from the StateSource. With `misses` set (a speculative run), a value
 * not fetched yet reads as empty and is noted; without it, it is fetched on the spot.
 */
class LazyState extends SimpleStateManager {
  private cleared = new Set<string>();
  private source: StateSource; private misses: Misses | null;
  constructor(source: StateSource, misses: Misses | null, opts: ConstructorParameters<typeof SimpleStateManager>[0]) { super(opts); this.source = source; this.misses = misses; }

  private async data(key: string): Promise<AccountData | undefined> {
    if (this.source.accounts.has(key)) return this.source.accounts.get(key);
    if (this.misses) { this.misses.accounts.add(key); return this.source.guessAccount(key); }
    await this.source.fetch({ ...newMisses(), accounts: new Set([key]) });
    return this.source.accounts.get(key);
  }

  override async getAccount(address: Address): Promise<Account | undefined> {
    const key = address.toString();
    if (this.topAccountStack().has(key)) return this.topAccountStack().get(key);
    const a = await this.data(key);
    if (!a) return undefined;
    const exists = a.balance > 0n || a.nonce > 0n || a.code.length > 0;
    const make = () => exists ? new Account(a.nonce, a.balance, undefined, hexToBytes(keccak256(a.code))) : undefined;
    for (const layer of this.accountStack) if (!layer.has(key)) layer.set(key, make());
    for (const layer of this.codeStack) if (!layer.has(key)) layer.set(key, a.code);
    return this.topAccountStack().get(key);
  }

  override async getCode(address: Address): Promise<Uint8Array> {
    const key = address.toString();
    if (!this.topCodeStack().has(key)) await this.getAccount(address);
    return this.topCodeStack().get(key) ?? new Uint8Array(0);
  }

  override async getStorage(address: Address, slot: Uint8Array): Promise<Uint8Array> {
    const k = `${address.toString()}_${bytesToHex(slot)}`;
    const top = this.topStorageStack();
    if (top.has(k)) return top.get(k)!;
    if (this.cleared.has(address.toString())) return new Uint8Array(0);
    let v = this.source.storage.get(k);
    if (v === undefined) {
      if (this.misses) { this.misses.storage.add(k); return this.source.guessStorage(k) ?? new Uint8Array(0); }
      await this.source.fetch({ ...newMisses(), storage: new Set([k]) });
      v = this.source.storage.get(k) ?? new Uint8Array(0);
    }
    for (const layer of this.storageStack) if (!layer.has(k)) layer.set(k, v);
    return v;
  }

  override async clearStorage(address: Address): Promise<void> {
    await super.clearStorage(address);
    this.cleared.add(address.toString());
  }
}

/**
 * The gas a transaction with this call would use: the 21,000 base and calldata, the execution, less the refund
 * (at most a fifth of the total), and from Prague on, at least EIP-7623's calldata floor.
 */
function transactionGas(req: SimulationRequest, execution: bigint, refund: bigint, prague: boolean): bigint {
  const data = req.data, creation = !req.to;
  let zero = 0n, nonzero = 0n;
  for (let i = 2; i < data.length; i += 2) if (data.slice(i, i + 2) === '00') zero++; else nonzero++;
  const words = creation ? (BigInt(data.length - 2) / 2n + 31n) / 32n : 0n;
  const listed = (req.accessList ?? []).reduce((g, e) => g + 2400n + 1900n * BigInt(e.storageKeys.length), 0n);
  const intrinsic = 21_000n + 4n * zero + 16n * nonzero + (creation ? 32_000n + 2n * words : 0n) + listed;
  const used = intrinsic + execution;
  const net = used - (refund < used / 5n ? refund : used / 5n);
  const floor = 21_000n + 10n * (zero + 4n * nonzero);
  return prague && floor > net ? floor : net;
}

/** The permission an approve / increaseAllowance / setApprovalForAll / Permit2 approve call sets, by its arguments. */
function namedApproval(req: SimulationRequest, from: string): SimulatedApproval | undefined {
  if (!req.to) return undefined;
  const sel = req.data.slice(0, 10), arg = (n: number) => `0x${req.data.slice(10 + 64 * n + 24, 10 + 64 * (n + 1))}`, num = (n: number) => BigInt(`0x${req.data.slice(10 + 64 * n, 10 + 64 * (n + 1)) || '0'}`);
  const to = hexOf(req.to);
  if (req.data.length < 10 + 64 * 2) return undefined;
  if (sel === '0x095ea7b3' || sel === '0x39509351') return { kind: 'erc20', emitter: to, token: to, owner: from, spender: arg(0), amount: num(1) };
  if (sel === '0xa22cb465') return { kind: 'operator', emitter: to, token: to, owner: from, spender: arg(0), approved: num(1) !== 0n };
  if (sel === '0x87517c45' && to === PERMIT2 && req.data.length >= 10 + 64 * 4) return { kind: 'permit2', emitter: to, token: arg(0), owner: from, spender: arg(1), amount: num(2), expiration: Number(num(3)) };
  return undefined;
}

const word = (b: Uint8Array) => b.length >= 32 ? BigInt(bytesToHex(b.slice(0, 32))) : undefined;
const hexOf = (a: string) => a.toLowerCase();

export class ForkSimulator implements Simulator {
  private urls: Record<number, string>;
  private opts: Required<Omit<ForkSimulatorOptions, 'profiles' | 'block' | 'header' | 'onRound'>> & Pick<ForkSimulatorOptions, 'block' | 'header' | 'onRound'> & { profiles: Record<number, ChainProfile> };
  /** Counters from the last simulation, for tuning and tests. */
  last?: { rounds: number; requests: number; ms: number };

  constructor(urls: Record<number, string>, options: ForkSimulatorOptions = {}) {
    this.urls = urls;
    this.opts = { fetchImpl: options.fetchImpl ?? fetch, batchSize: options.batchSize ?? 20, concurrency: options.concurrency ?? 4, maxRounds: options.maxRounds ?? 24,
      timeoutMs: options.timeoutMs ?? 20_000, block: options.block, header: options.header, onRound: options.onRound, profiles: { ...CHAIN_PROFILES, ...options.profiles } };
  }

  /** Whether this simulator can run calls on `chainId` (an RPC URL and a known EVM profile). */
  covers(chainId: number): boolean { return !!this.urls[chainId] && !!this.opts.profiles[chainId]; }

  async simulate(req: SimulationRequest): Promise<SimulationResult | null> {
    return (await this.simulateBatch([req]))?.[0] ?? null;
  }

  async simulateBatch(reqs: SimulationRequest[]): Promise<SimulationResult[] | null> {
    if (!reqs.length) return [];
    const chainId = reqs[0].chainId;
    if (reqs.some(r => r.chainId !== chainId)) throw new Error('A batch must be on one chain');
    const url = this.urls[chainId], profile = this.opts.profiles[chainId];
    if (!url || !profile) return null;
    const started = Date.now(), deadline = started + this.opts.timeoutMs;
    const tag = this.opts.block?.(chainId) ?? 'latest';
    const source = new StateSource(chainId, url, tag, this.opts.fetchImpl, this.opts.batchSize, this.opts.concurrency, deadline);
    for (const r of reqs) for (const [a, o] of Object.entries(r.stateOverrides ?? {})) if (o.code !== undefined) source.codeOverrides.set(hexOf(a), hexToBytes(o.code as Hex));
    // The senders and targets are certain to be read: fetch them before the first run.
    const first = newMisses();
    for (const r of reqs) { first.accounts.add(hexOf(r.from)); if (r.to) first.accounts.add(hexOf(r.to)); }
    const prefetch = source.fetch(first);
    const fixed = this.opts.header?.(chainId);
    const [block] = await Promise.all([fixed ? { header: { ...fixed, coinbase: createAddressFromString(fixed.coinbase), difficulty: 0n, prevRandao: hexToBytes(fixed.prevRandao), getBlobGasPrice: () => 1n } }
      : this.blockContext(source, tag, profile), prefetch]);
    const common = createCustomCommon({ chainId }, Mainnet, { hardfork: profile.hardfork as never });
    // Tokens and approvals to read around each call: those the calls name (targets, calldata, decoder hints) and the
    // chain's well-known tokens, then those the logs reveal. Named ones matter: WETH-style wrappers emit Deposit and
    // Withdrawal, not Transfer, so logs alone miss the wrapped token.
    const skip = (a: string) => reqs.some(r => hexOf(r.from) === a) || a === ZERO || BigInt(a) < 0x10000n;
    const tokens = new Set<string>([
      ...reqs.flatMap(r => [...(r.watch ?? []), ...(r.to ? [r.to] : []), ...calldataCandidates(r.data).addresses]).map(hexOf).slice(0, 40),
      ...builtinTokens(chainId).map(t => hexOf(t.address)),
    ].filter(a => !skip(a)));
    const approvals = new Map<string, SimulatedApproval>();
    for (let round = 1; ; round++) {
      const misses = round <= this.opts.maxRounds ? newMisses() : null;
      let run: Awaited<ReturnType<ForkSimulator['run']>>;
      try {
        run = await this.run(reqs, source, misses, common, block, profile, tokens, approvals, chainId);
      } catch (e) {
        if (e instanceof ForkTimeout || !misses || !missCount(misses)) throw e;
        run = undefined as never; // a speculative run broke on made-up values: fetch what it asked for and retry
      }
      const grew = !!run && (run.tokens.some(t => !tokens.has(t)) || run.approvals.some(a => !approvals.has(approvalKey(a))));
      if (misses) this.opts.onRound?.(round, { accounts: [...misses.accounts], storage: [...misses.storage], calls: [...misses.calls] }, grew);
      if (run && (!misses || (!missCount(misses) && !grew))) {
        this.last = { rounds: round, requests: source.requests, ms: Date.now() - started };
        return run.results;
      }
      if (run) { for (const t of run.tokens) tokens.add(t); for (const a of run.approvals) approvals.set(approvalKey(a), a); }
      if (Date.now() > deadline) throw new ForkTimeout(`the simulation needed more than ${this.opts.timeoutMs} ms`);
      if (misses && missCount(misses)) await source.fetch(misses);
    }
  }

  private async blockContext(source: StateSource, tag: string, profile: ChainProfile) {
    const h = await source.header(tag);
    // Replaying at a block's pre-state (tag = that block's parent) means simulating the next block: the parent + 1.
    return { header: { number: BigInt(h.number) + 1n, coinbase: createAddressFromString(h.miner), timestamp: BigInt(h.timestamp) + BigInt(profile.blockTime),
      difficulty: 0n, prevRandao: hexToBytes(h.mixHash ?? `0x${'00'.repeat(32)}`), gasLimit: BigInt(h.gasLimit) > GAS ? BigInt(h.gasLimit) : GAS,
      baseFeePerGas: h.baseFeePerGas ? BigInt(h.baseFeePerGas) : 0n, getBlobGasPrice: () => 1n } };
  }

  /** One run of the calls, in order, on a fresh state over `source`. */
  private async run(reqs: SimulationRequest[], source: StateSource, misses: Misses | null, common: ReturnType<typeof createCustomCommon>, block: Awaited<ReturnType<ForkSimulator['blockContext']>>,
    profile: ChainProfile, tokens: Set<string>, watchedApprovals: Map<string, SimulatedApproval>, chainId: number) {
    const state = new LazyState(source, misses, { common });
    const forwarded = (profile.forwardedPrecompiles ?? []).map(address => ({ address: address as Hex, function: async (input: { data: Uint8Array; gasLimit: bigint }) => {
      const key = `${address}_${bytesToHex(input.data)}`;
      let c = source.calls.get(key);
      if (!c && misses) {
        misses.calls.add(key);
        c = source.guessCall(key);
        if (!c) return { executionGasUsed: 2000n, returnValue: new Uint8Array(0) };
      }
      if (!c) {
        await source.fetch({ ...newMisses(), calls: new Set([key]) });
        c = source.calls.get(key)!;
      }
      const gas = profile.precompileGas?.(input.data.length, c.data.length) ?? 2000n;
      return c.ok ? { executionGasUsed: gas, returnValue: c.data } : { executionGasUsed: input.gasLimit, returnValue: c.data, exceptionError: new EVMError(EVMError.errorMessages.REVERT) };
    } }));
    const evm: EVM = await createEVM({ common, stateManager: state, customPrecompiles: forwarded });
    const view = async (to: string, data: Hex) => {
      const r = await evm.runCall({ caller: createAddressFromString(ZERO), to: createAddressFromString(to), data: hexToBytes(data), gasLimit: 1_000_000n, isStatic: true, block });
      return r.execResult.exceptionError ? undefined : r.execResult.returnValue;
    };
    const balanceOf = async (token: string, owner: string) => { const r = await view(token, `0x70a08231${owner.slice(2).padStart(64, '0')}` as Hex); return r ? word(r) : undefined; };
    const native = async (a: string) => (await state.getAccount(createAddressFromString(a)))?.balance ?? 0n;
    const nft = new Map<string, boolean>();
    const isNft = async (t: string) => {
      if (!nft.has(t)) { const r = await view(t, `0x01ffc9a780ac58cd${'00'.repeat(28)}` as Hex); nft.set(t, !!r && word(r) === 1n); }
      return nft.get(t)!;
    };

    const results: SimulationResult[] = [];
    const seenTokens = new Set<string>(), seenApprovals: SimulatedApproval[] = [];
    const touched = new Map<string, SimulatedApproval>(watchedApprovals);
    const source_ = `local EVM over chain ${chainId} state (the RPC has no eth_simulateV1)`;
    for (const req of reqs) {
      const from = hexOf(req.from), target = req.to ? hexOf(req.to) : ZERO;
      const watch = [...tokens];
      const before = new Map<string, bigint | undefined>();
      for (const t of watch) before.set(t, await balanceOf(t, from));
      const nativeBefore = await native(from);
      if (req.value > nativeBefore) {
        results.push({ status: 'reverted', source: source_, revertReason: `insufficient funds: the account holds ${units(chainId, nativeBefore)} and the call sends ${units(chainId, req.value)}`, transfers: [], basis: 'fork' });
        continue;
      }
      // As at the start of a transaction: nothing warm but the sender, the target, the fee recipient, the precompiles
      // and the access list (EIP-2929, EIP-3651), and "original" storage values taken afresh (EIP-2200).
      await evm.journal.cleanup();
      state.originalStorageCache.clear();
      for (const a of [from, target, block.header.coinbase.toString(), ...evm.precompiles.keys()]) evm.journal.addAlwaysWarmAddress(a);
      for (const e of req.accessList ?? []) { evm.journal.addAlwaysWarmAddress(e.address); for (const k of e.storageKeys) evm.journal.addAlwaysWarmSlot(e.address, k); }
      const gasLimit = req.gas ? req.gas - transactionGas({ ...req, data: req.data }, 0n, 0n, false) : GAS;
      const res = await evm.runCall({ caller: createAddressFromString(from), origin: createAddressFromString(from), ...(req.to && { to: createAddressFromString(req.to) }),
        data: hexToBytes(req.data as Hex), value: req.value, gasLimit: gasLimit > 0n ? gasLimit : 0n, gasPrice: req.gasPrice ?? 0n, block });
      const ex = res.execResult;
      const gasUsed = transactionGas(req, ex.executionGasUsed, ex.gasRefund ?? 0n, profile.hardfork !== 'cancun');
      if (ex.exceptionError) {
        const data = bytesToHex(ex.returnValue) as Hex;
        results.push({ status: 'reverted', source: source_, gasUsed, revertReason: ex.exceptionError.error === 'revert' ? decodeRevert(data) : ex.exceptionError.error, transfers: [], basis: 'fork', returnData: data });
        continue;
      }
      const logs = (ex.logs ?? []).map(([address, topics, data]) => ({ address: bytesToHex(address), topics: topics.map(t => bytesToHex(t)), data: bytesToHex(data) }));
      const parsed = parseLogs(logs);
      // Tokens whose Transfer logs involve the account: read its balance of each, before and after.
      for (const l of logs) if (l.topics[0] === TRANSFER && l.topics.length === 3 && [l.topics[1], l.topics[2]].some(t => `0x${t.slice(26)}` === from)) seenTokens.add(hexOf(l.address));
      for (const a of parsed.approvals) if (a.owner === from) { seenApprovals.push(a); touched.set(approvalKey(a), a); }
      // A call that sets a permission by name is listed even if its token emits no Approval event (non-compliant
      // tokens exist); its state is read back below like the rest.
      const named = namedApproval(req, from);
      if (named && !parsed.approvals.some(a => approvalKey(a) === approvalKey(named))) { parsed.approvals.push(named); seenApprovals.push(named); touched.set(approvalKey(named), named); }
      const transfers: SimulatedTransfer[] = [];
      const add = (asset: string, delta: bigint) => {
        if (delta < 0n) transfers.push({ asset, from, to: target, raw: -delta });
        else if (delta > 0n) transfers.push({ asset, from: target, to: from, raw: delta });
      };
      add('native', (await native(from)) - nativeBefore);
      const logNet = new Map<string, bigint>();
      for (const t of parsed.transfers) {
        if (t.from === from) logNet.set(t.asset, (logNet.get(t.asset) ?? 0n) - t.raw);
        if (t.to === from) logNet.set(t.asset, (logNet.get(t.asset) ?? 0n) + t.raw);
      }
      // ERC-721 contracts count NFTs in balanceOf; those are shown per token ID from their Transfer events instead.
      const nftLogs = new Set(logs.filter(l => l.topics[0] === TRANSFER && l.topics.length === 4).map(l => hexOf(l.address)));
      for (const t of new Set([...watch, ...logNet.keys()])) {
        if (t === 'native' || nftLogs.has(t) || await isNft(t)) continue;
        const b = before.get(t), a = before.has(t) ? await balanceOf(t, from) : undefined;
        // The balance read wins; a token whose balanceOf can't be read keeps its log amounts.
        add(t, b !== undefined && a !== undefined ? a - b : (logNet.get(t) ?? 0n));
      }
      const approvalState: SimulatedApproval[] = [];
      for (const ap of touched.values()) {
        const r = await view(ap.kind === 'permit2' ? ap.emitter : ap.token, stateCall(ap));
        const s = r && decodeState(ap, bytesToHex(r) as Hex);
        if (s) approvalState.push(s);
      }
      results.push({ status: 'success', source: source_, gasUsed, transfers, nftTransfers: parsed.nftTransfers, approvals: parsed.approvals, ...(approvalState.length && { approvalState }), basis: 'fork', returnData: bytesToHex(ex.returnValue) });
    }
    return { results, tokens: [...seenTokens], approvals: seenApprovals };
  }
}

const units = (chainId: number, v: bigint) => `${formatUnits(v, CHAINS[chainId]?.nativeDecimals ?? 18)} ${CHAINS[chainId]?.nativeSymbol ?? ''}`.trim();
