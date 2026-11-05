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
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createEVM, EVMError, type EVM } from '@ethereumjs/evm';
import { createCustomCommon, Mainnet } from '@ethereumjs/common';
import { SimpleStateManager } from '@ethereumjs/statemanager';
import { Account, bytesToHex, createAddressFromString, hexToBytes, unpadBytes, type Address } from '@ethereumjs/util';
import { keccak256 } from 'viem';
import { recoverAuthorizationAddress } from 'viem/utils';
import { builtinTokens, CHAINS, PERMIT2 } from './chains.ts';
import { calldataCandidates } from './simulation-probe.ts';
import { formatUnits } from './format.ts';
import { approvalKey, decodeRevert, decodeState, ELSEWHERE, namedApproval, parseLogs, stateCall } from './simulation.ts';
import type { SimulatedApproval, SimulatedTransfer, SimulationRequest, SimulationResult, Simulator } from './types.ts';

type Hex = `0x${string}`;
interface AccountData { balance: bigint; nonce: bigint; code: Uint8Array }
interface Misses { accounts: Set<string>; storage: Set<string>; calls: Set<string>; blocks: Set<number> }
const newMisses = (): Misses => ({ accounts: new Set(), storage: new Set(), calls: new Set(), blocks: new Set() });
const missCount = (m: Misses) => m.accounts.size + m.storage.size + m.calls.size + m.blocks.size;

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

/**
 * HyperCore read precompile gas, measured on HyperEVM mainnet (2026-11-05) with a contract reading gasleft() around
 * STATICCALLs to six of them (inputs of 0-64 bytes, outputs of 32-256): 1,000 + 33 per input and output byte, on top
 * of the warm access (100; they are warm from the start). With it, real transactions' gas matches their receipts. A
 * call that fails (missing input, an unknown asset) uses all the gas it is given and returns nothing, also measured.
 */
const hyperCoreReadGas = (input: number, output: number) => 1000n + 33n * BigInt(input + output);

/** Measured on each chain (2026-11-05): HyperEVM runs Cancun rules (no CLZ, no BLS precompiles); Ethereum, Osaka. */
export const CHAIN_PROFILES: Record<number, ChainProfile> = {
  1: { hardfork: 'osaka', blockTime: 12 },
  11155111: { hardfork: 'osaka', blockTime: 12 },
  999: { hardfork: 'cancun', blockTime: 1, forwardedPrecompiles: HYPERCORE_READS, precompileGas: hyperCoreReadGas },
  998: { hardfork: 'cancun', blockTime: 1, forwardedPrecompiles: HYPERCORE_READS, precompileGas: hyperCoreReadGas },
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
  /**
   * A file to keep the caches shared by all simulations in (contract code and the last value seen of each slot), so
   * a restarted server's first previews are as fast as before it stopped. Loaded when the simulator is created,
   * saved a few seconds after simulations. The values in it are only guesses, so a stale file costs rounds, never
   * accuracy.
   */
  cacheFile?: string;
  /**
   * Record every storage read and write of the accepted run, with its gas, in `last.trace` (for diagnosing a gas
   * difference; slows simulation).
   */
  trace?: boolean;
  /** Called after each speculative round with what it still needed (for tuning). */
  onRound?: (round: number, misses: { accounts: string[]; storage: string[]; calls: string[] }, grew: boolean) => void;
}

/** A storage read or write of a traced run: the call it was in (by index), the contract, slot, value written and gas charged. */
export interface StorageStep { call: number; op: 'SLOAD' | 'SSTORE'; address: string; slot: string; value?: string; gas: string; refund: string; depth: number }

/** The simulation ran out of its time budget. */
export class ForkTimeout extends Error {
  constructor(message: string) { super(message); this.name = 'ForkTimeout'; }
}

const GAS = 30_000_000n;
/** EIP-1967 implementation and beacon slots, and ZeppelinOS's (USDC): fetched with every new contract, saving a round per proxy. */
const PROXY_SLOTS = ['0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc', '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50', '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3'];
/**
 * Contract code by chain and address, shared by all simulations: once deployed, code can't change (Cancun removed
 * self-destruct redeployment). Only non-empty code is kept, since an empty address can still be deployed to, and not
 * EIP-7702 delegations, which their account can change.
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
  get size() { return this.map.size; }
  clear() { this.map.clear(); }
  /** Most recently set first. */
  recent(): [string, V][] { return [...this.map].reverse(); }
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
/** Block hashes by chain and number, for BLOCKHASH: a past block's hash doesn't change. */
const BLOCK_HASHES = new Guesses<Uint8Array>(5_000);

/** What the cache file holds, most recent first, within these limits (about 25 MB). */
const SAVED = { accounts: 20_000, storage: 100_000, calls: 10_000, codeHexChars: 16_000_000 };
interface CacheFile {
  version: 1;
  code: [string, string][];
  accounts: [string, string, string, boolean][];
  storage: [string, string][];
  calls: [string, boolean, string][];
}

/** Loads a cache file written by saveForkCache into the shared caches. Returns the number of values loaded (0 when there is no file). */
export function loadForkCache(file: string): number {
  let c: CacheFile;
  try { c = JSON.parse(readFileSync(file, 'utf8')); } catch { return 0; }
  if (c?.version !== 1) return 0;
  // Oldest first, so the most recent end up most recent again.
  for (const [k, v] of c.code) if (CODE_CACHE.size < CODE_CACHE_MAX) CODE_CACHE.set(k, hexToBytes(v as Hex));
  for (const [k, b, n, hasCode] of [...c.accounts].reverse()) GUESS_ACCOUNTS.set(k, { balance: BigInt(b), nonce: BigInt(n), hasCode });
  for (const [k, v] of [...c.storage].reverse()) GUESS_STORAGE.set(k, hexToBytes(v as Hex));
  for (const [k, ok, v] of [...c.calls].reverse()) GUESS_CALLS.set(k, { ok, data: hexToBytes(v as Hex) });
  return c.code.length + c.accounts.length + c.storage.length + c.calls.length;
}

/** Empties the caches shared by all simulations (code and last values seen). */
export function clearForkCaches(): void {
  CODE_CACHE.clear();
  GUESS_ACCOUNTS.clear();
  GUESS_STORAGE.clear();
  GUESS_CALLS.clear();
}

/** Writes the shared caches to `file` (atomically: a temporary file, then a rename). */
export function saveForkCache(file: string): void {
  const accounts = GUESS_ACCOUNTS.recent().slice(0, SAVED.accounts);
  // The code of recently seen contracts: without it, their guesses can't be used.
  const code: [string, string][] = [];
  let chars = 0;
  for (const [k, a] of accounts) {
    const c = a.hasCode && CODE_CACHE.get(k);
    if (!c || chars + c.length * 2 > SAVED.codeHexChars) continue;
    code.push([k, bytesToHex(c)]);
    chars += c.length * 2;
  }
  const out: CacheFile = { version: 1, code,
    accounts: accounts.map(([k, a]) => [k, `0x${a.balance.toString(16)}`, `0x${a.nonce.toString(16)}`, a.hasCode]),
    storage: GUESS_STORAGE.recent().slice(0, SAVED.storage).map(([k, v]) => [k, bytesToHex(v)]),
    calls: GUESS_CALLS.recent().slice(0, SAVED.calls).map(([k, v]) => [k, v.ok, bytesToHex(v.data)]) };
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(out));
  renameSync(tmp, file);
}

const ZERO = '0x0000000000000000000000000000000000000000';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/** Fetches accounts, storage and forwarded calls from the RPC, in batches, and keeps them for the simulation. */
class StateSource {
  accounts = new Map<string, AccountData>();
  storage = new Map<string, Uint8Array>();
  calls = new Map<string, { ok: boolean; data: Uint8Array }>();
  blocks = new Map<number, Uint8Array>();
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
        if (acc.code.length && !isDelegation(acc.code) && CODE_CACHE.size < CODE_CACHE_MAX) CODE_CACHE.set(`${this.chainId}:${a}`, acc.code);
      } });
      // Most contracts are proxies: their implementation is the next thing a call reads. Only for an account not seen
      // before: one seen before is known to have no code, or its slots are guessed and fetched only if read.
      if (!GUESS_ACCOUNTS.get(`${this.chainId}:${a}`)) for (const slot of PROXY_SLOTS) if (!this.storage.has(`${a}_${slot}`) && !m.storage.has(`${a}_${slot}`)) {
        jobs.push({ method: 'eth_getStorageAt', params: [a, slot, this.block], done: r => { this.setStorage(`${a}_${slot}`, unpadBytes(hexToBytes(r as Hex))); } });
      }
    }
    for (const k of m.storage) {
      const [a, slot] = k.split('_');
      jobs.push({ method: 'eth_getStorageAt', params: [a, slot, this.block], done: r => { this.setStorage(k, unpadBytes(hexToBytes(r as Hex))); } });
    }
    for (const n of m.blocks) {
      const known = BLOCK_HASHES.get(`${this.chainId}:${n}`);
      if (known) { this.blocks.set(n, known); continue; }
      jobs.push({ method: 'eth_getBlockByNumber', params: [`0x${n.toString(16)}`, false], done: r => {
        const h = hexToBytes(((r as { hash?: Hex } | null)?.hash ?? `0x${'00'.repeat(32)}`) as Hex);
        this.blocks.set(n, h);
        if (r) BLOCK_HASHES.set(`${this.chainId}:${n}`, h);
      } });
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
      // Public RPCs rate-limit per IP: back off (up to 4 s between tries), within the simulation's deadline.
      if ((limited || res.status >= 500) && attempt < 8) { await new Promise(r => setTimeout(r, Math.min(4000, 300 * 2 ** attempt))); continue; }
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
      if (attempt >= 8) throw new Error('state fetch: rate limited');
      batch = retry;
      await new Promise(r => setTimeout(r, Math.min(4000, 300 * 2 ** attempt)));
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

const isDelegation = (code: Uint8Array) => code.length === 23 && code[0] === 0xef && code[1] === 0x01 && code[2] === 0x00;

/** An EIP-7702 authorization: signed (its authority recovered, null if the signature can't be read), or for the sender, to be signed by the wallet (no nonce to check). */
interface Authorization { authority: string | null; address: string; chainId: bigint; nonce?: bigint }

async function authorizationsOf(req: SimulationRequest): Promise<Authorization[]> {
  const out: Authorization[] = [];
  for (const a of req.authorizationList ?? []) {
    let authority: string | null = null;
    try {
      authority = (await recoverAuthorizationAddress({ authorization: { address: a.address as Hex, chainId: Number(a.chainId), nonce: Number(a.nonce) }, signature: { r: a.r as Hex, s: a.s as Hex, yParity: Number(a.yParity) } })).toLowerCase();
    } catch { /* the chain skips it */ }
    out.push({ authority, address: hexOf(a.address), chainId: BigInt(a.chainId), nonce: BigInt(a.nonce) });
  }
  for (const a of req.unsignedAuthorizations ?? []) out.push({ authority: hexOf(req.from), address: hexOf(a.address), chainId: BigInt(a.chainId) });
  return out;
}

/** Authorizations a transaction carries: each costs 25,000 gas whether or not it applies. */
const authorizationCount = (req: SimulationRequest) => (req.authorizationList?.length ?? 0) + (req.unsignedAuthorizations?.length ?? 0);

/**
 * The gas a transaction with this call would use: the 21,000 base, calldata, access list and EIP-7702
 * authorizations, the execution, less the refund (at most a fifth of the total), and from Prague on, at least
 * EIP-7623's calldata floor.
 */
function transactionGas(req: SimulationRequest, execution: bigint, refund: bigint, prague: boolean): bigint {
  const data = req.data, creation = !req.to;
  let zero = 0n, nonzero = 0n;
  for (let i = 2; i < data.length; i += 2) if (data.slice(i, i + 2) === '00') zero++; else nonzero++;
  const words = creation ? (BigInt(data.length - 2) / 2n + 31n) / 32n : 0n;
  const listed = (req.accessList ?? []).reduce((g, e) => g + 2400n + 1900n * BigInt(e.storageKeys.length), 0n);
  const intrinsic = 21_000n + 4n * zero + 16n * nonzero + (creation ? 32_000n + 2n * words : 0n) + listed + 25_000n * BigInt(authorizationCount(req));
  const used = intrinsic + execution;
  const net = used - (refund < used / 5n ? refund : used / 5n);
  const floor = 21_000n + 10n * (zero + 4n * nonzero);
  return prague && floor > net ? floor : net;
}

const requestKey = (reqs: SimulationRequest[]) => reqs.map(r => `${r.chainId}:${r.from}:${r.to}:${r.value}:${r.data}`).join('|').toLowerCase();

const word = (b: Uint8Array) => b.length >= 32 ? BigInt(bytesToHex(b.slice(0, 32))) : undefined;
const hexOf = (a: string) => a.toLowerCase();

export class ForkSimulator implements Simulator {
  private urls: Record<number, string>;
  private opts: Required<Omit<ForkSimulatorOptions, 'profiles' | 'block' | 'header' | 'onRound'>> & Pick<ForkSimulatorOptions, 'block' | 'header' | 'onRound'> & { profiles: Record<number, ChainProfile> };
  /** Counters from the last simulation, for tuning and tests. */
  last?: { rounds: number; requests: number; ms: number; trace?: StorageStep[] };
  /** Tokens that simulations still running have seen in their Transfer logs so far, by request (see discovered()). */
  private seen = new Map<string, Set<string>>();
  /** Values loaded from the cache file when the simulator was created. */
  readonly loaded: number = 0;
  private saveTimer?: ReturnType<typeof setTimeout>;

  constructor(urls: Record<number, string>, options: ForkSimulatorOptions = {}) {
    this.urls = urls;
    this.opts = { fetchImpl: options.fetchImpl ?? fetch, batchSize: options.batchSize ?? 20, concurrency: options.concurrency ?? 4, maxRounds: options.maxRounds ?? 24,
      timeoutMs: options.timeoutMs ?? 20_000, block: options.block, header: options.header, onRound: options.onRound, cacheFile: options.cacheFile ?? '', trace: options.trace ?? false, profiles: { ...CHAIN_PROFILES, ...options.profiles } };
    if (this.opts.cacheFile) this.loaded = loadForkCache(this.opts.cacheFile);
  }

  /** Saves the shared caches to the cache file now (they are also saved a few seconds after each simulation). */
  persist(): void {
    if (!this.opts.cacheFile) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    try { saveForkCache(this.opts.cacheFile); } catch { /* a cache, not a record */ }
  }

  private schedulePersist() {
    if (!this.opts.cacheFile || this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.persist(), 5000);
    this.saveTimer.unref?.();
  }

  /**
   * Runs `batches` only to fill the caches shared by all simulations (code, and the last value seen of each slot),
   * so the first real previews of these contracts take a round or two instead of one per dependent read. Failures are
   * ignored. Resolves when done.
   */
  async warm(batches: SimulationRequest[][]): Promise<void> {
    for (const b of batches) { try { await this.simulateBatch(b); } catch { /* only warming */ } }
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
    // EIP-7702 authorizations are applied as the chain does, before each call; the code overrides standing in for
    // them (for simulators that can't) are left out, so each authority's real code and nonce decide whether it applies.
    const auths = await Promise.all(reqs.map(authorizationsOf));
    const authorities = new Set(auths.flat().map(a => a.authority));
    for (const r of reqs) for (const [a, o] of Object.entries(r.stateOverrides ?? {})) if (o.code !== undefined && !authorities.has(hexOf(a))) source.codeOverrides.set(hexOf(a), hexToBytes(o.code as Hex));
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
    const key = requestKey(reqs);
    this.seen.set(key, new Set());
    try {
      return await this.rounds(reqs, auths, source, common, block, profile, tokens, approvals, chainId, started, deadline, key);
    } finally {
      // Kept briefly, for a caller that gave up waiting and wants what was seen.
      setTimeout(() => this.seen.delete(key), 30_000).unref?.();
      this.schedulePersist();
    }
  }

  /**
   * Tokens the speculative runs of a simulation still in progress (or just finished) have seen in Transfer logs
   * involving the account. A caller that stops waiting can hand these to a cheaper simulator, such as the probe.
   */
  discovered(reqs: SimulationRequest[]): string[] {
    return [...(this.seen.get(requestKey(reqs)) ?? [])];
  }

  private async rounds(reqs: SimulationRequest[], auths: Authorization[][], source: StateSource, common: ReturnType<typeof createCustomCommon>, block: Awaited<ReturnType<ForkSimulator['blockContext']>>,
    profile: ChainProfile, tokens: Set<string>, approvals: Map<string, SimulatedApproval>, chainId: number, started: number, deadline: number, key: string): Promise<SimulationResult[]> {
    for (let round = 1; ; round++) {
      const misses = round <= this.opts.maxRounds ? newMisses() : null;
      let run: Awaited<ReturnType<ForkSimulator['run']>>;
      try {
        run = await this.run(reqs, auths, source, misses, common, block, profile, tokens, approvals, chainId);
      } catch (e) {
        if (e instanceof ForkTimeout || !misses || !missCount(misses)) throw e;
        run = undefined as never; // a speculative run broke on made-up values: fetch what it asked for and retry
      }
      const grew = !!run && run.rerun;
      if (misses) this.opts.onRound?.(round, { accounts: [...misses.accounts], storage: [...misses.storage], calls: [...misses.calls] }, grew);
      if (run && (!misses || (!missCount(misses) && !grew))) {
        this.last = { rounds: round, requests: source.requests, ms: Date.now() - started, ...(run.trace && { trace: run.trace }) };
        return run.results;
      }
      if (run) {
        for (const t of run.tokens) { tokens.add(t); this.seen.get(key)?.add(t); }
        for (const a of run.approvals) approvals.set(approvalKey(a), a);
      }
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
  private async run(reqs: SimulationRequest[], auths: Authorization[][], source: StateSource, misses: Misses | null, common: ReturnType<typeof createCustomCommon>, block: Awaited<ReturnType<ForkSimulator['blockContext']>>,
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
    // BLOCKHASH: the recent blocks' hashes, fetched like the rest of the state (the EVM checks the 256-block window).
    const blockchain = {
      getBlock: async (n: number) => {
        let h = source.blocks.get(n);
        if (!h && misses) { misses.blocks.add(n); h = BLOCK_HASHES.get(`${chainId}:${n}`) ?? new Uint8Array(32); }
        if (!h) { await source.fetch({ ...newMisses(), blocks: new Set([n]) }); h = source.blocks.get(n)!; }
        return { hash: () => h };
      },
      putBlock: async () => {},
      shallowCopy() { return this; },
    };
    const evm: EVM = await createEVM({ common, stateManager: state, customPrecompiles: forwarded, blockchain });
    // Only the calls themselves are traced, not the balance and approval reads around them.
    let trace: StorageStep[] | undefined, callIndex = 0, recording = false;
    if (this.opts.trace) {
      trace = [];
      evm.events!.on('step', (e: { opcode: { name: string; fee: number; dynamicFee?: bigint }; stack: bigint[]; address: Address; depth: number; gasRefund: bigint }, next?: () => void) => {
        const op = e.opcode.name;
        if (recording && (op === 'SLOAD' || op === 'SSTORE')) {
          const top = e.stack.length - 1;
          trace!.push({ call: callIndex, op, address: e.address.toString(), slot: `0x${e.stack[top].toString(16)}`, ...(op === 'SSTORE' && { value: `0x${e.stack[top - 1].toString(16)}` }),
            gas: String(BigInt(e.opcode.fee) + (e.opcode.dynamicFee ?? 0n)), refund: String(e.gasRefund), depth: e.depth });
        }
        next?.();
      });
    }
    const viewOn = async (on: EVM, to: string, data: Hex) => {
      const r = await on.runCall({ caller: createAddressFromString(ZERO), to: createAddressFromString(to), data: hexToBytes(data), gasLimit: 1_000_000n, isStatic: true, block });
      return r.execResult.exceptionError ? undefined : r.execResult.returnValue;
    };
    const view = (to: string, data: Hex) => viewOn(evm, to, data);
    const balanceOf = async (token: string, owner: string) => { const r = await view(token, `0x70a08231${owner.slice(2).padStart(64, '0')}` as Hex); return r ? word(r) : undefined; };
    // The state before the first call is the chain's own: a token its logs reveal can be read there afterwards, on a
    // second EVM, instead of running everything again with the token watched from the start.
    let pre: EVM | undefined;
    const balanceBefore = async (token: string, owner: string) => {
      pre ??= await createEVM({ common, stateManager: new LazyState(source, misses, { common }), customPrecompiles: forwarded, blockchain });
      const r = await viewOn(pre, token, `0x70a08231${owner.slice(2).padStart(64, '0')}` as Hex);
      return r ? word(r) : undefined;
    };
    const native = async (a: string) => (await state.getAccount(createAddressFromString(a)))?.balance ?? 0n;
    const nft = new Map<string, boolean>();
    const isNft = async (t: string) => {
      if (!nft.has(t)) { const r = await view(t, `0x01ffc9a780ac58cd${'00'.repeat(28)}` as Hex); nft.set(t, !!r && word(r) === 1n); }
      return nft.get(t)!;
    };

    const results: SimulationResult[] = [];
    const seenTokens = new Set<string>(), seenApprovals: SimulatedApproval[] = [];
    // A token or approval first seen in a later call of a batch must be read around the calls before it too.
    let rerun = false;
    const touched = new Map<string, SimulatedApproval>(watchedApprovals);
    const source_ = `local EVM over chain ${chainId} state (the RPC has no eth_simulateV1)`;
    for (const [i, req] of reqs.entries()) {
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
      // The sender's nonce goes up first, then the EIP-7702 authorizations apply (and stay, whatever the call does).
      const sender = createAddressFromString(from);
      const senderAccount = (await state.getAccount(sender)) ?? new Account();
      senderAccount.nonce++;
      await state.putAccount(sender, senderAccount);
      const authRefund = await this.authorize(state, evm, auths[i], chainId);
      const gasLimit = req.gas ? req.gas - transactionGas({ ...req, data: req.data }, 0n, 0n, false) : GAS;
      callIndex = i;
      recording = true;
      const res = await evm.runCall({ caller: sender, origin: sender, ...(req.to && { to: createAddressFromString(req.to) }), skipNonceIncrement: true,
        data: hexToBytes(req.data as Hex), value: req.value, gasLimit: gasLimit > 0n ? gasLimit : 0n, gasPrice: req.gasPrice ?? 0n, block });
      recording = false;
      const ex = res.execResult;
      const gasUsed = transactionGas(req, ex.executionGasUsed, (ex.gasRefund ?? 0n) + authRefund, profile.hardfork !== 'cancun');
      if (ex.exceptionError) {
        const data = bytesToHex(ex.returnValue) as Hex;
        results.push({ status: 'reverted', source: source_, gasUsed, revertReason: ex.exceptionError.error === 'revert' ? decodeRevert(data) : ex.exceptionError.error, transfers: [], basis: 'fork', returnData: data });
        continue;
      }
      const logs = (ex.logs ?? []).map(([address, topics, data]) => ({ address: bytesToHex(address), topics: topics.map(t => bytesToHex(t)), data: bytesToHex(data) }));
      const parsed = parseLogs(logs);
      // Tokens whose Transfer logs involve the account: read its balance of each, before and after.
      for (const l of logs) if (l.topics[0] === TRANSFER && l.topics.length === 3 && [l.topics[1], l.topics[2]].some(t => `0x${t.slice(26)}` === from)) {
        const t = hexOf(l.address);
        seenTokens.add(t);
        if (i > 0 && !tokens.has(t)) rerun = true;
      }
      for (const a of parsed.approvals) if (a.owner === from) {
        if (i > 0 && !watchedApprovals.has(approvalKey(a))) rerun = true;
        seenApprovals.push(a); touched.set(approvalKey(a), a);
      }
      // A call that sets a permission by name is listed even if its token emits no Approval event (non-compliant
      // tokens exist); its state is read back below like the rest.
      let named = namedApproval(req, from, parsed.approvals);
      // Kept only if the token answers for it (an NFT contract's approve shares ERC-20's selector).
      if (named && !(await view(named.kind === 'permit2' ? named.emitter : named.token, stateCall(named)))) named = undefined;
      if (named && !parsed.approvals.some(a => approvalKey(a) === approvalKey(named!))) { parsed.approvals.push(named); seenApprovals.push(named); touched.set(approvalKey(named), named); }
      const transfers: SimulatedTransfer[] = [];
      // A call to the account itself (an EIP-7702 account running its own batch) moved the tokens elsewhere.
      const other = target === from ? ELSEWHERE : target;
      const add = (asset: string, delta: bigint) => {
        if (delta < 0n) transfers.push({ asset, from, to: other, raw: -delta });
        else if (delta > 0n) transfers.push({ asset, from: other, to: from, raw: delta });
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
        // A token first seen in the first call's logs is read on the state before it (see balanceBefore).
        const b = before.has(t) ? before.get(t) : i === 0 ? await balanceBefore(t, from) : undefined;
        const a = before.has(t) || i === 0 ? await balanceOf(t, from) : undefined;
        // The balance read wins; a token whose balanceOf can't be read keeps its log amounts.
        add(t, b !== undefined && a !== undefined ? a - b : (logNet.get(t) ?? 0n));
      }
      const approvalState: SimulatedApproval[] = [];
      for (const ap of touched.values()) {
        const r = await view(ap.kind === 'permit2' ? ap.emitter : ap.token, stateCall(ap));
        const s = r && decodeState(ap, bytesToHex(r) as Hex);
        if (s) approvalState.push(s);
      }
      results.push({ status: 'success', source: source_, gasUsed, transfers, nftTransfers: parsed.nftTransfers, approvals: parsed.approvals, ...(approvalState.length && { approvalState }), ...(parsed.coreActions && { coreActions: parsed.coreActions }), basis: 'fork', returnData: bytesToHex(ex.returnValue) });
    }
    return { results, tokens: [...seenTokens], approvals: seenApprovals, rerun, trace };
  }

  /**
   * Applies EIP-7702 authorizations as the chain does at the start of a transaction: each one for this chain (or
   * every chain) whose authority has no code or a delegation, and whose nonce matches the authority's (checked for
   * signed ones only), sets the authority's code and bumps its nonce. Returns the refund they earn: 12,500 for each
   * whose authority already existed.
   */
  private async authorize(state: LazyState, evm: EVM, list: Authorization[], chainId: number): Promise<bigint> {
    let refund = 0n;
    for (const a of list) {
      if (!a.authority || (a.chainId !== 0n && a.chainId !== BigInt(chainId))) continue;
      const who = createAddressFromString(a.authority);
      evm.journal.addAlwaysWarmAddress(a.authority);
      const code = await state.getCode(who);
      if (code.length && !isDelegation(code)) continue;
      const account = await state.getAccount(who);
      if (a.nonce !== undefined && (account?.nonce ?? 0n) !== a.nonce) continue;
      if (account) refund += 12_500n;
      const next = account ?? new Account();
      next.nonce++;
      await state.putAccount(who, next);
      await state.putCode(who, a.address === ZERO ? new Uint8Array(0) : hexToBytes(`0xef0100${a.address.slice(2)}`));
    }
    return refund;
  }
}

const units = (chainId: number, v: bigint) => `${formatUnits(v, CHAINS[chainId]?.nativeDecimals ?? 18)} ${CHAINS[chainId]?.nativeSymbol ?? ''}`.trim();
