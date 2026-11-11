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
import { createEVM, EVMError, getActivePrecompiles, paramsEVM, type EVM } from '@ethereumjs/evm';
import { Common, createCustomCommon, Hardfork, Mainnet } from '@ethereumjs/common';
import { SimpleStateManager } from '@ethereumjs/statemanager';
import { Account, bytesToHex, createAddressFromString, hexToBytes, setLengthLeft, unpadBytes, type Address } from '@ethereumjs/util';
import { keccak256 } from 'viem';
import { recoverAuthorizationAddress } from 'viem/utils';
import { builtinTokens, CHAINS, PERMIT2 } from './chains.ts';
import { headerAfter, NEXT_BLOCK, nodeOverrides, priceFields } from './block.ts';
import { calldataCandidates } from './simulation-probe.ts';
import { formatUnits } from './format.ts';
import { approvalKey, decodeRevert, decodeState, ELSEWHERE, namedApproval, NATIVE_LOG_ADDRESS, parseLogs, stateCall } from './simulation.ts';
import type { SimulatedApproval, SimulatedTransfer, SimulationRequest, SimulationResult, Simulator, StateChange, TraceCall } from './types.ts';

type Hex = `0x${string}`;
interface AccountData { balance: bigint; nonce: bigint; code: Uint8Array }
interface Misses { accounts: Set<string>; storage: Set<string>; calls: Set<string>; blocks: Set<number> }
const newMisses = (): Misses => ({ accounts: new Set(), storage: new Set(), calls: new Set(), blocks: new Set() });
const missCount = (m: Misses) => m.accounts.size + m.storage.size + m.calls.size + m.blocks.size;

export interface ChainProfile {
  /** EVM rules, e.g. 'cancun' (HyperEVM) or 'osaka' (Ethereum). */
  hardfork: string;
  /**
   * The chain's fork id as its node gave it (eth_config, EIP-7910) when this profile was last checked against the
   * chain's receipts, and when that was. A node on another fork id runs rules the local EVM hasn't been checked
   * against: its runs then say so (SimulationResult.rulesNote).
   */
  checked?: { forkId: string; on: string };
  /** Seconds between blocks, for the simulated next block's timestamp. */
  blockTime: number;
  /** Precompiles the local EVM doesn't have; their calls are answered by eth_call on the chain (HyperEVM's HyperCore reads). */
  forwardedPrecompiles?: string[];
  /** Gas a forwarded precompile call costs. */
  precompileGas?: (inputBytes: number, outputBytes: number) => bigint;
  /**
   * What the chain's opcode 0x44 returns: the block's mixHash (PREVRANDAO, the default), its difficulty (BNB Chain
   * and Polygon, whose blocks still carry one), or 1 (Arbitrum).
   */
  randomness?: 'mixHash' | 'difficulty' | 'one';
  /**
   * Arbitrum: NUMBER is the L1 block the chain last saw (the header's l1BlockNumber), and ArbSys answers
   * arbBlockNumber() with the chain's own.
   */
  arbitrum?: boolean;
  /** See NEXT_BLOCK (src/block.ts), where these last four come from. */
  difficultyOverride?: boolean;
  /**
   * Storage prices where the chain's differ from Ethereum's: what the first read of a slot in a transaction costs
   * (SLOAD: 2,100 on Ethereum), and what the first write to one adds (SSTORE's cold surcharge, also 2,100 there, on
   * which the price of changing a set slot, 5,000 less it, and the refund for clearing one follow).
   */
  storageGas?: { coldRead: number; coldWrite: number };
  /**
   * The chain's prices for the bn254 precompiles where they aren't Ethereum's (150 to add, 6,000 to multiply,
   * 45,000 for a pairing and 34,000 a pair): Polygon charges 540, 12,600, 67,500 and 51,000, measured on its node
   * by the gas a STATICCALL to each spends. Applied with `storageGas` (the chain that has one has the other).
   */
  bn254Gas?: { add: number; mul: number; pairing: number; pair: number };
  /** The chain has no point-evaluation precompile at 0x0a (it carries no blobs): the address is an empty account there. */
  noPointEvaluation?: boolean;
  /**
   * Opcodes of the profile's fork that the chain's node refuses as invalid, measured by running each on the node:
   * chains without blobs have no BLOBBASEFEE (Arbitrum, Polygon), and Polygon no BLOBHASH either.
   */
  missingOpcodes?: number[];
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

const low = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
/**
 * ArbOS's precompiles (ArbSys at 0x64 to ArbWasmCache at 0x72, and ArbDebug at 0xff): the chain answers them, as it
 * does HyperCore's reads. What one of them would change (ArbSys sending a message to L1) isn't kept.
 */
const ARBOS = [...Array.from({ length: 15 }, (_, i) => low(0x64 + i)), low(0xff)];
/** BNB Chain's own precompiles (light-client and BLS checks at 0x64 to 0x69), answered by the chain. */
const BSC_PRECOMPILES = Array.from({ length: 6 }, (_, i) => low(0x64 + i));

/**
 * Measured on each chain with a code override (2026-11-05, the others 2026-11-10): HyperEVM runs Cancun rules (no
 * CLZ, no BLS precompiles); Ethereum, Arbitrum One, Base, OP Mainnet, Polygon and BNB Chain run Osaka's (CLZ, the
 * BLS precompiles, P256VERIFY at 6,900 gas). Block times are for the simulated next block's timestamp, in whole
 * seconds: chains that make several blocks a second get the next second (BNB Chain) or the same one (Arbitrum).
 */
export const CHAIN_PROFILES: Record<number, ChainProfile> = {
  1: { hardfork: 'osaka', checked: { forkId: '0x07c9462e', on: '2026-11-10' }, ...NEXT_BLOCK[1] },
  // Sepolia runs Amsterdam (Glamsterdam) since 2026-10-06: its blocks say so, and run under those rules (see ETHEREUM_RULES).
  11155111: { hardfork: 'osaka', checked: { forkId: '0x6c1d9423', on: '2026-11-11' }, ...NEXT_BLOCK[11155111] },
  42161: { hardfork: 'osaka', checked: { forkId: '0x92f58d00', on: '2026-11-10' }, ...NEXT_BLOCK[42161], forwardedPrecompiles: ARBOS, missingOpcodes: [0x4a] },
  8453: { hardfork: 'osaka', checked: { forkId: '0x169d85a3', on: '2026-11-10' }, ...NEXT_BLOCK[8453] },
  10: { hardfork: 'osaka', checked: { forkId: '0xc29239af', on: '2026-11-10' }, ...NEXT_BLOCK[10] },
  // Polygon prices storage its own way. Measured on its node with code overrides (2026-11-10): a cold SLOAD costs
  // 5,460; a cold SSTORE adds 2,940 (setting an empty slot 22,940, changing a set one 5,000 as on Ethereum, writing
  // back the same value 3,040), and clearing a slot refunds 3,960. Warm reads, accounts, calls, logs, hashing and
  // creation cost what they do on Ethereum. With Ethereum's prices every transaction that touched storage came out
  // low, by a multiple of 840.
  137: { hardfork: 'osaka', ...NEXT_BLOCK[137], storageGas: { coldRead: 5460, coldWrite: 2940 }, bn254Gas: { add: 540, mul: 12_600, pairing: 67_500, pair: 51_000 }, missingOpcodes: [0x49, 0x4a], noPointEvaluation: true },
  56: { hardfork: 'osaka', checked: { forkId: '0xd38cc282', on: '2026-11-10' }, ...NEXT_BLOCK[56], forwardedPrecompiles: BSC_PRECOMPILES },
  999: { hardfork: 'cancun', ...NEXT_BLOCK[999], forwardedPrecompiles: HYPERCORE_READS, precompileGas: hyperCoreReadGas },
  998: { hardfork: 'cancun', ...NEXT_BLOCK[998], forwardedPrecompiles: HYPERCORE_READS, precompileGas: hyperCoreReadGas },
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
  header?: (chainId: number) => { number: bigint; timestamp: bigint; coinbase: string; prevRandao: Hex; gasLimit: bigint; baseFeePerGas: bigint; /** Arbitrum: the chain's own block number (`number` is then the L1 block's). */ arbBlockNumber?: bigint; /** The block's blob base fee (BLOBBASEFEE). */ blobBaseFee?: bigint; /** The block is one of Amsterdam's. */ amsterdam?: boolean; /** The beacon slot (SLOTNUM), from Amsterdam on. */ slotNumber?: bigint } | undefined;
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

/** The call reaches something the local EVM can't run as the chain does (a Stylus contract on Arbitrum). */
export class ForkUnsupported extends Error {
  constructor(message: string) { super(message); this.name = 'ForkUnsupported'; }
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


/**
 * The readers fetchAfter places: each takes 32-byte words of calldata and returns a word for each (the balance of
 * the address, or the value of the storage slot), or the code of the one address given.
 *   PUSH1 0 [JUMPDEST DUP1 CALLDATASIZE GT ISZERO PUSH1 0x15 JUMPI DUP1 CALLDATALOAD <BALANCE|SLOAD> DUP2 MSTORE
 *   PUSH1 0x20 ADD PUSH1 0x02 JUMP] JUMPDEST CALLDATASIZE PUSH1 0 RETURN
 *   PUSH1 0 CALLDATALOAD DUP1 EXTCODESIZE DUP1 PUSH1 0 PUSH1 0 DUP5 EXTCODECOPY PUSH1 0 RETURN
 * (No PUSH0: a block from before Shanghai has none.)
 */
const BALANCE_READER = '0x00000000000000000000000000000000ba1a9ce5', CODE_READER = '0x00000000000000000000000000000000c0de9ead';
const BALANCE_READER_CODE = '0x60005b8036111560155780353181526020016002565b366000f3', SLOT_READER_CODE = '0x60005b8036111560155780355481526020016002565b366000f3';
const CODE_READER_CODE = '0x600035803b8060006000843c6000f3';

/** Fetches accounts, storage and forwarded calls from the RPC, in batches, and keeps them for the simulation. */
class StateSource {
  accounts = new Map<string, AccountData>();
  storage = new Map<string, Uint8Array>();
  calls = new Map<string, { ok: boolean; data: Uint8Array }>();
  blocks = new Map<number, Uint8Array>();
  requests = 0;
  /** Code given to accounts for this simulation (EIP-7702 delegation designators), instead of theirs. */
  codeOverrides = new Map<string, Uint8Array>();
  /** Native balances set for this simulation (a request's state overrides), instead of the chain's. */
  balanceOverrides = new Map<string, bigint>();
  /** Precompiles the chain's node lists that the local EVM neither has nor forwards (address to name): a call reaching one is refused. */
  nodeOnly = new Map<string, string>();

  /** The node's own account of the rules it runs (eth_config, EIP-7910); undefined where it gives none. */
  async config(): Promise<unknown> {
    let c: unknown;
    try { await this.send([{ method: 'eth_config', params: [], done: r => { c = r; } }]); } catch { return undefined; }
    return c;
  }
  private url: string; private block: string; private fetchImpl: typeof fetch; private batchSize: number; private concurrency: number; private deadline: number;
  readonly chainId: number;
  constructor(chainId: number, url: string, block: string, fetchImpl: typeof fetch, batchSize: number, concurrency: number, deadline: number) {
    this.chainId = chainId; this.url = url; this.block = block; this.fetchImpl = fetchImpl; this.batchSize = batchSize; this.concurrency = concurrency; this.deadline = deadline;
  }

  /** The header of block `tag` (with the same retries as state reads). */
  async header(tag: string): Promise<{ number: Hex; timestamp: Hex; miner: Hex; mixHash?: Hex; gasLimit: Hex; baseFeePerGas?: Hex; difficulty?: Hex; l1BlockNumber?: Hex }> {
    let h: unknown;
    await this.send([{ method: 'eth_getBlockByNumber', params: [tag, false], done: r => { h = r; } }]);
    if (!h) throw new Error(`block ${tag} not found`);
    return h as { number: Hex; timestamp: Hex; miner: Hex; mixHash?: Hex; gasLimit: Hex; baseFeePerGas?: Hex; difficulty?: Hex; l1BlockNumber?: Hex };
  }

  /**
   * A block that was asked for (a past block, a replay): what the caches hold of other blocks isn't taken for its
   * state (code an account has now, it may not have had then), and what is read of it isn't kept as the latest seen.
   */
  historic = false;
  /**
   * Reads are of the state after these calls (the transactions before a replayed one in its block), which the node
   * runs first, in a simulated block of their own (see fetchAfter). `sent`: how many of them each address sent.
   */
  after?: { calls: unknown[]; blockOverrides: Record<string, string>; sent: Map<string, bigint> };

  async fetch(m: Misses): Promise<void> {
    if (!this.after) return this.fetchAt(m);
    await Promise.all([this.fetchAfter(m), this.fetchAt({ accounts: new Set(), storage: new Set(), calls: m.calls, blocks: m.blocks })]);
  }

  /**
   * Accounts and storage as they were after `after.calls`: one eth_simulateV1 of three blocks on the parent's state.
   * The first runs those calls. The second reads balances and code through two small contracts placed at unused
   * addresses. The third reads storage: each contract's code is replaced by a reader that returns the slots asked
   * for (an override in a later block doesn't touch the calls of the first). Nonces have no opcode: the parent
   * block's, plus the earlier transactions the address sent.
   */
  private async fetchAfter(m: Misses): Promise<void> {
    const after = this.after!;
    const accounts = [...m.accounts];
    const word = (h: string) => h.slice(2).padStart(64, '0');
    const nonces = new Map<string, bigint>();
    const nonceJobs = accounts.map(a => ({ method: 'eth_getTransactionCount', params: [a, this.block], done: (r: unknown) => { nonces.set(a, BigInt(r as string) + (after.sent.get(a) ?? 0n)); } }));
    const slots = new Map<string, string[]>();
    const want = (a: string, slot: string) => { const l = slots.get(a) ?? []; if (!l.includes(slot)) l.push(slot); slots.set(a, l); };
    for (const a of accounts) for (const slot of PROXY_SLOTS) if (!this.storage.has(`${a}_${slot}`)) want(a, slot);
    for (const k of m.storage) { const [a, slot] = k.split('_'); want(a, slot); }
    const needCode = accounts.filter(a => !this.codeOverrides.has(a));
    const accountCalls = [...(accounts.length ? [{ to: BALANCE_READER, data: `0x${accounts.map(word).join('')}` }] : []), ...needCode.map(a => ({ to: CODE_READER, data: `0x${word(a)}` }))];
    const contracts = [...slots.keys()];
    const blocks: unknown[] = [{ calls: after.calls, blockOverrides: after.blockOverrides }];
    if (accountCalls.length) blocks.push({ stateOverrides: { [BALANCE_READER]: { code: BALANCE_READER_CODE }, [CODE_READER]: { code: CODE_READER_CODE } }, calls: accountCalls });
    if (contracts.length) blocks.push({ stateOverrides: Object.fromEntries(contracts.map(a => [a, { code: SLOT_READER_CODE }])), calls: contracts.map(a => ({ to: a, data: `0x${slots.get(a)!.map(word).join('')}` })) });
    let out: { calls: { status: string; returnData: Hex }[] }[] | undefined;
    await Promise.all([
      this.sendAll(nonceJobs),
      this.send([{ method: 'eth_simulateV1', params: [{ blockStateCalls: blocks, validation: false }, this.block], done: r => { out = r as typeof out; } }]),
    ]);
    const failed = new Error('reading the state after the block\'s earlier transactions failed');
    if (!out || out.length !== blocks.length) throw failed;
    const words = (data: Hex, n: number) => Array.from({ length: n }, (_, i) => `0x${data.slice(2 + 64 * i, 66 + 64 * i).padEnd(64, '0')}` as Hex);
    let at = 1;
    if (accountCalls.length) {
      const r = out[at++].calls;
      if (r.some(c => c.status !== '0x1')) throw failed;
      const balances = words(r[0].returnData, accounts.length);
      const code = new Map(needCode.map((a, i) => [a, hexToBytes(r[1 + i].returnData)]));
      accounts.forEach((a, i) => this.accounts.set(a, { balance: BigInt(balances[i]), nonce: nonces.get(a) ?? 0n, code: this.codeOverrides.get(a) ?? code.get(a) ?? new Uint8Array(0) }));
    }
    if (contracts.length) {
      const r = out[at].calls;
      contracts.forEach((a, i) => {
        // A contract the node runs itself keeps its own code whatever the override says, so its storage can't be
        // read this way: left unread, and running it is refused (LazyState.load).
        if (r[i].status !== '0x1') { if (isNative(this.accounts.get(a)?.code ?? new Uint8Array(0))) return; throw failed; }
        words(r[i].returnData, slots.get(a)!.length).forEach((v, j) => this.storage.set(`${a}_${slots.get(a)![j]}`, unpadBytes(hexToBytes(v))));
      });
    }
  }

  private async fetchAt(m: Misses): Promise<void> {
    type Job = { method: string; params: unknown[]; done: (result: unknown, error?: { message?: string; data?: Hex }) => void };
    const jobs: Job[] = [];
    const pending: [string, AccountData][] = [];
    for (const a of m.accounts) {
      const cached = this.codeOverrides.get(a) ?? (this.historic ? undefined : CODE_CACHE.get(`${this.chainId}:${a}`));
      const acc: AccountData = { balance: 0n, nonce: 0n, code: cached ?? new Uint8Array(0) };
      pending.push([a, acc]);
      jobs.push({ method: 'eth_getBalance', params: [a, this.block], done: r => { acc.balance = BigInt(r as string); } });
      jobs.push({ method: 'eth_getTransactionCount', params: [a, this.block], done: r => { acc.nonce = BigInt(r as string); } });
      if (!cached) jobs.push({ method: 'eth_getCode', params: [a, this.block], done: r => {
        acc.code = hexToBytes(r as Hex);
        if (acc.code.length && !isDelegation(acc.code) && CODE_CACHE.size < CODE_CACHE_MAX && !this.historic) CODE_CACHE.set(`${this.chainId}:${a}`, acc.code);
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
    await this.sendAll(jobs);
    for (const [a, acc] of pending) {
      this.accounts.set(a, acc);
      if (!this.historic) GUESS_ACCOUNTS.set(`${this.chainId}:${a}`, { balance: acc.balance, nonce: acc.nonce, hasCode: acc.code.length > 0 });
    }
  }

  /** The jobs in batches of the source's size, a few at a time. */
  private async sendAll(jobs: { method: string; params: unknown[]; done: (r: unknown, e?: { message?: string; data?: Hex }) => void }[]) {
    const batches: (typeof jobs)[] = [];
    for (let i = 0; i < jobs.length; i += this.batchSize) batches.push(jobs.slice(i, i + this.batchSize));
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(this.concurrency, batches.length) }, async () => {
      while (next < batches.length) await this.send(batches[next++]);
    }));
  }

  private setStorage(k: string, v: Uint8Array) {
    this.storage.set(k, v);
    if (!this.historic) GUESS_STORAGE.set(`${this.chainId}:${k}`, v);
  }

  /** A previously seen value, as a guess (accounts with code only when their code is cached). */
  guessAccount(a: string): AccountData | undefined {
    const g = GUESS_ACCOUNTS.get(`${this.chainId}:${a}`);
    if (!g) return undefined;
    // For a block asked for, code kept from another block isn't a guess worth running: the account is fetched first.
    const code = this.codeOverrides.get(a) ?? (g.hasCode ? (this.historic ? undefined : CODE_CACHE.get(`${this.chainId}:${a}`)) : new Uint8Array(0));
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
  /**
   * While set (a traced call is running): every account read and every storage slot written, as each was when the
   * call first came to it (an account is noted when read, not when written: the EVM changes the account it was
   * handed before writing it back). What they hold afterwards is read once the call is done, so what a revert undid
   * shows no change.
   */
  written?: { accounts: Map<string, { balance: bigint; nonce: bigint; code: string }>; storage: Map<string, { address: string; slot: string; before: string }> };

  override async putStorage(address: Address, key: Uint8Array, value: Uint8Array): Promise<void> {
    const k = `${address.toString()}_${bytesToHex(key)}`;
    if (this.written && !this.written.storage.has(k)) this.written.storage.set(k, { address: address.toString(), slot: bytesToHex(key), before: bytesToHex(setLengthLeft(await this.getStorage(address, key), 32)) });
    return super.putStorage(address, key, value);
  }

  private async data(key: string): Promise<AccountData | undefined> {
    const a = await this.chainData(key), balance = this.source.balanceOverrides.get(key);
    // A balance set for the simulation stands in for the chain's, whatever else the account holds.
    return balance === undefined ? a : { nonce: a?.nonce ?? 0n, code: a?.code ?? new Uint8Array(0), balance };
  }
  private async chainData(key: string): Promise<AccountData | undefined> {
    if (this.source.accounts.has(key)) return this.source.accounts.get(key);
    if (this.misses) { this.misses.accounts.add(key); return this.source.guessAccount(key); }
    await this.source.fetch({ ...newMisses(), accounts: new Set([key]) });
    return this.source.accounts.get(key);
  }

  override async getAccount(address: Address): Promise<Account | undefined> {
    const key = address.toString() as Hex;
    const account = await this.load(key);
    if (this.written && !this.written.accounts.has(key)) {
      this.written.accounts.set(key, { balance: account?.balance ?? 0n, nonce: account?.nonce ?? 0n, code: bytesToHex(this.topCodeStack().get(key) ?? new Uint8Array(0)) });
    }
    return account;
  }
  private async load(key: Hex): Promise<Account | undefined> {
    if (this.topAccountStack().has(key)) return this.topAccountStack().get(key);
    // A precompile the chain's node has and this EVM doesn't would run here as an empty account: refused instead.
    const nodeOnly = this.source.nodeOnly.get(key);
    if (nodeOnly) throw new ForkUnsupported(`${key} is ${nodeOnly}, a precompile this chain's node has and the local EVM doesn't`);
    const a = await this.data(key);
    if (!a) return undefined;
    // Arbitrum's Stylus contracts are WASM behind a 0xEFF000 prefix, which no EVM runs: better no answer than a wrong one.
    if (NEXT_BLOCK[this.source.chainId]?.arbitrum && a.code.length > 3 && a.code[0] === 0xef && a.code[1] === 0xf0 && a.code[2] === 0x00) throw new ForkUnsupported(`${key} is a Stylus (WASM) contract, which the local EVM can't run`);
    // Any other code that starts with 0xEF and isn't an EIP-7702 delegation is a marker, not EVM code (none can be
    // deployed since London): a contract the chain's node runs itself, as Base does at 0xb200…10c5.
    if (isNative(a.code)) throw new ForkUnsupported(`${key} is a contract this chain's node runs itself (its code is a marker, not EVM code), which the local EVM can't run`);
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


/** The rules a chain's node says it runs (eth_config): its fork id, when that fork took effect, and its precompiles (address to name). */
export interface NodeRules { forkId?: string; activation?: number; precompiles: Map<string, string> }

/** eth_config's answer as NodeRules; undefined when the node gives no current fork with its precompiles (Polygon's lists none). */
export function nodeRulesOf(config: unknown): NodeRules | undefined {
  const current = (config as { current?: { forkId?: unknown; activationTime?: unknown; precompiles?: unknown } } | null | undefined)?.current;
  if (!current || typeof current !== 'object' || !current.precompiles || typeof current.precompiles !== 'object') return undefined;
  const precompiles = new Map<string, string>();
  for (const [name, address] of Object.entries(current.precompiles as Record<string, unknown>)) {
    if (typeof address === 'string' && /^0x[0-9a-fA-F]{1,40}$/.test(address)) precompiles.set(`0x${address.slice(2).toLowerCase().padStart(40, '0')}`, name);
  }
  const activation = Number(current.activationTime);
  return { ...(typeof current.forkId === 'string' && { forkId: current.forkId.toLowerCase() }), ...(Number.isFinite(activation) && activation > 0 && { activation }), precompiles };
}

/** Forks before Prague, of those the local EVM runs (for the transaction-level gas rules that came with it). */
const BEFORE_PRAGUE = new Set(['paris', 'shanghai', 'cancun']);
const MAINNET = new Common({ chain: Mainnet });
const FORK_ORDER = Object.values(Hardfork) as string[];

/**
 * The fork Ethereum ran at a block, by its number and time (the EVM library's schedule). The blob-parameter forks
 * change no EVM rule, so they run as the fork before them; a block after the library's last scheduled fork runs
 * as `latest`. Blocks from before the Merge are refused: the block this EVM is given has no proof-of-work fields.
 */
export function mainnetForkAt(header: { number: bigint; timestamp: bigint }, latest: string): string {
  let fork = MAINNET.getHardforkBy({ blockNumber: header.number, timestamp: header.timestamp });
  if (fork === Hardfork.MergeNetsplitBlock) fork = Hardfork.Paris;
  if (FORK_ORDER.indexOf(fork) < FORK_ORDER.indexOf(Hardfork.Paris)) throw new ForkUnsupported('this block is from before the Merge (September 2022), which the local EVM here is not set up to run');
  if (/^bpo\d+$/.test(fork)) fork = Hardfork.Osaka;
  return FORK_ORDER.indexOf(fork) >= FORK_ORDER.indexOf(latest) ? latest : fork;
}

/**
 * What a local run says about the rules it ran under, when they may not be the chain's: the node is on a fork the
 * profile wasn't checked against, or the block named is from before the node's current fork (on a chain whose past
 * forks this EVM doesn't select between).
 */
function rulesNoteOf(chainId: number, profile: ChainProfile, rules: NodeRules | undefined, at: SimulationRequest['at']): string | undefined {
  const name = CHAINS[chainId]?.name ?? `Chain ${chainId}`, day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
  if (rules?.forkId && profile.checked && rules.forkId !== profile.checked.forkId) {
    return `${name}'s rules changed${rules.activation ? ` on ${day(rules.activation)}` : ''} since the local EVM here was last checked against the chain (${profile.checked.on}), so its run may differ from the chain's, in gas above all.`;
  }
  if (chainId !== 1 && at?.required && rules?.activation && Number(at.header.timestamp) < rules.activation) {
    return `This block is from before ${name}'s current rules took effect (${day(rules.activation)}). The local EVM runs today's rules, so its run may differ from what the block's rules gave, in gas above all.`;
  }
  return undefined;
}

/**
 * The EVM options for a chain's own storage prices (ChainProfile.storageGas): the cold write surcharge as the
 * EIP-2929 parameter the SSTORE rules read, with what follows from it (EIP-2929's reset price, EIP-3529's refund
 * for clearing: the reset price plus an access-list slot's 1,900), and SLOAD replaced by one that charges the cold
 * read price, which those rules would otherwise take from the same parameter.
 */
function storagePricing(profile: ChainProfile) {
  const g = profile.storageGas;
  // Opcodes the chain's node doesn't have (ChainProfile.missingOpcodes) are taken out of the local EVM too.
  const gone = (profile.missingOpcodes ?? []).map(opcode => ({ opcode }));
  if (!g) return gone.length ? { customOpcodes: gone as never } : {};
  const params = JSON.parse(JSON.stringify(paramsEVM)) as Record<string, Record<string, number>>;
  Object.assign(params[2929], { coldsloadGas: g.coldWrite, sstoreCleanEIP2200Gas: 5000 - g.coldWrite });
  Object.assign(params[3529], { sstoreClearRefundEIP2200Gas: 5000 - g.coldWrite + 1900 });
  // The chain's own prices for the bn254 precompiles (ChainProfile.bn254Gas), in place of Istanbul's.
  if (profile.bn254Gas) Object.assign(params[1679], { bn254AddGas: profile.bn254Gas.add, bn254MulGas: profile.bn254Gas.mul, bn254PairingGas: profile.bn254Gas.pairing, bn254PairingWordGas: profile.bn254Gas.pair });
  type RunState = { stack: { peek(): bigint[]; pop(): bigint; push(v: bigint): void }; interpreter: { getAddress(): Address; storageLoad(key: Uint8Array): Promise<Uint8Array>; journal: { isWarmedStorage(a: Uint8Array, k: Uint8Array): boolean; addWarmedStorage(a: Uint8Array, k: Uint8Array): void } } };
  const slot = (key: bigint) => hexToBytes(`0x${key.toString(16).padStart(64, '0')}`);
  const sload = {
    opcode: 0x54, opcodeName: 'SLOAD', baseFee: 0,
    gasFunction: (runState: RunState, gas: bigint) => {
      const address = runState.interpreter.getAddress().bytes, key = slot(runState.stack.peek()[0]);
      if (runState.interpreter.journal.isWarmedStorage(address, key)) return gas + 100n;
      runState.interpreter.journal.addWarmedStorage(address, key);
      return gas + BigInt(g.coldRead);
    },
    logicFunction: async (runState: RunState) => {
      const value = await runState.interpreter.storageLoad(slot(runState.stack.pop()));
      runState.stack.push(value.length ? BigInt(bytesToHex(value)) : 0n);
    },
  };
  return { params, customOpcodes: [sload, ...gone] } as unknown as { params: never; customOpcodes: never };
}

const POINT_EVALUATION = '0x000000000000000000000000000000000000000a';
/** Chains that run Ethereum's own fork schedule: mainnet and Sepolia. */
const ETHEREUM_RULES = new Set([1, 11155111]);
const isDelegation = (code: Uint8Array) => code.length === 23 && code[0] === 0xef && code[1] === 0x01 && code[2] === 0x00;
/** Code that is a marker for something the chain's node runs itself: it starts with 0xEF and is no delegation. */
const isNative = (code: Uint8Array) => code.length > 0 && code[0] === 0xef && !isDelegation(code);

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
function transactionGas(req: SimulationRequest, execution: bigint, refund: bigint, prague: boolean, amsterdam = false): bigint {
  const { intrinsic, floor } = intrinsicGas(req, amsterdam);
  const used = intrinsic + execution;
  const net = used - (refund < used / 5n ? refund : used / 5n);
  return (prague || amsterdam) && floor > net ? floor : net;
}

/** What a transaction pays before its call runs (what its gas limit is less, for the call), and the least it can pay (the calldata floor). */
function intrinsicGas(req: SimulationRequest, amsterdam: boolean): { intrinsic: bigint; floor: bigint } {
  const data = req.data, creation = !req.to;
  let zero = 0n, nonzero = 0n;
  for (let i = 2; i < data.length; i += 2) if (data.slice(i, i + 2) === '00') zero++; else nonzero++;
  const words = creation ? (BigInt(data.length - 2) / 2n + 31n) / 32n : 0n;
  if (amsterdam) {
    // Amsterdam (EIP-2780, 7976, 7981, 8037, 8038), as the chain's node charges it on Sepolia: a base of 12,000;
    // 3,000 for the recipient's account unless the sender calls itself, and 6,000 more when value moves; a creation
    // pays 12,000 instead. An access list costs 2,900 an address and 2,000 a key, plus its bytes at the floor's
    // price. The floor counts every calldata byte as four tokens, at 16 each, over the same base.
    const base = 12_000n + (creation ? 12_000n : hexOf(req.to!) === hexOf(req.from) ? 0n : 3_000n + (req.value > 0n ? 6_000n : 0n));
    const list = req.accessList ?? [], keys = list.reduce((n, e) => n + BigInt(e.storageKeys.length), 0n);
    const listBytes = 20n * BigInt(list.length) + 32n * keys;
    return {
      intrinsic: base + 4n * zero + 16n * nonzero + 2n * words + 2_900n * BigInt(list.length) + 2_000n * keys + 64n * listBytes + AMSTERDAM_AUTHORIZATION * BigInt(authorizationCount(req)),
      floor: base + 64n * (zero + nonzero + listBytes),
    };
  }
  const listed = (req.accessList ?? []).reduce((g, e) => g + 2400n + 1900n * BigInt(e.storageKeys.length), 0n);
  return {
    intrinsic: 21_000n + 4n * zero + 16n * nonzero + (creation ? 32_000n + 2n * words : 0n) + listed + 25_000n * BigInt(authorizationCount(req)),
    floor: 21_000n + 10n * (zero + 4n * nonzero),
  };
}

/**
 * Amsterdam's charge for each EIP-7702 authorization a transaction carries, applied or not: 7,816 for the tuple and
 * its checks. One that is applied also pays for the state it adds (see ForkSimulator.authorize).
 */
const AMSTERDAM_AUTHORIZATION = 7_816n;

const requestKey = (reqs: SimulationRequest[]) => reqs.map(r => `${r.chainId}:${r.from}:${r.to}:${r.value}:${r.data}`).join('|').toLowerCase();

const word = (b: Uint8Array) => b.length >= 32 ? BigInt(bytesToHex(b.slice(0, 32))) : undefined;
const hexOf = (a: string) => a.toLowerCase();

export class ForkSimulator implements Simulator {
  private urls: Record<number, string>;
  /** Each chain's rules as its node gives them, read again every ten minutes (a fork can activate while this runs). */
  private rules = new Map<number, { read: number; value: Promise<NodeRules | undefined> }>();
  private rulesOf(chainId: number, source: StateSource): Promise<NodeRules | undefined> {
    const kept = this.rules.get(chainId);
    if (kept && Date.now() - kept.read < 600_000) return kept.value;
    const value = source.config().then(nodeRulesOf, () => undefined);
    this.rules.set(chainId, { read: Date.now(), value });
    return value;
  }
  /** Chains whose node has no eth_simulateV1: a replay's earlier transactions are run here instead. */
  private noSimulate = new Set<number>();
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

  /** The calls with their traces and state changes (Simulator.trace). */
  trace(reqs: SimulationRequest[], options?: { budgetMs?: number }): Promise<SimulationResult[] | null> {
    return this.simulateBatch(reqs.map(r => ({ ...r, trace: true })), options?.budgetMs !== undefined ? { timeoutMs: options.budgetMs } : undefined);
  }

  async simulateBatch(reqs: SimulationRequest[], options?: { /** How long this run may take, over the simulator's own limit. */ timeoutMs?: number; /** Calls the node runs first, for the state these start from (set here, for a replay). */ after?: SimulationRequest[] }): Promise<SimulationResult[] | null> {
    if (!reqs.length) return [];
    const chainId = reqs[0].chainId;
    if (reqs.some(r => r.chainId !== chainId)) throw new Error('A batch must be on one chain');
    const url = this.urls[chainId];
    let profile = this.opts.profiles[chainId];
    if (!url || !profile) return null;
    // Calls that run first in the block (SimulationRequest.at.before: the transactions before a replayed one). The
    // chain's node runs them, and this EVM starts from the state they leave (StateSource.after): running hundreds of
    // transactions here would mean fetching all the state they touch. Where the node has no eth_simulateV1, they are
    // run here with the rest, their results left out.
    const earlier = reqs[0].at?.before;
    if (earlier?.length) {
      const at = { ...reqs[0].at!, before: undefined };
      if (!this.noSimulate.has(chainId)) {
        try { return await this.simulateBatch(reqs.map(r => ({ ...r, at })), { ...options, after: earlier }); } catch (e) {
          if (!/method not found|does not exist|not supported|not available|-32601/i.test(e instanceof Error ? e.message : String(e))) throw e;
          this.noSimulate.add(chainId);
        }
      }
      const all = await this.simulateBatch([...earlier.map(r => ({ ...r, at, trace: false })), ...reqs.map(r => ({ ...r, at }))], { timeoutMs: options?.timeoutMs });
      return all && all.slice(earlier.length);
    }
    const started = Date.now(), deadline = started + Math.max(this.opts.timeoutMs, options?.timeoutMs ?? 0);
    // The requests' own block (SimulationRequest.at), else this simulator's (a replay's), else the latest.
    const at = reqs[0].at;
    const tag = at?.block ?? this.opts.block?.(chainId) ?? 'latest';
    const source = new StateSource(chainId, url, tag, this.opts.fetchImpl, this.opts.batchSize, this.opts.concurrency, deadline);
    source.historic = !!at?.required;
    if (options?.after?.length && at) {
      const hex = (v: bigint) => `0x${v.toString(16)}`, sent = new Map<string, bigint>();
      for (const r of options.after) sent.set(hexOf(r.from), (sent.get(hexOf(r.from)) ?? 0n) + 1n);
      source.after = { sent, blockOverrides: nodeOverrides(at.header), calls: options.after.map(r => ({ from: r.from, ...(r.to && { to: r.to }), data: r.data, value: hex(r.value), ...(r.gas !== undefined && { gas: hex(r.gas) }), ...priceFields(r),
        ...(r.accessList && { accessList: r.accessList }), ...(r.authorizationList?.length && { authorizationList: r.authorizationList }) })) };
    }
    // EIP-7702 authorizations are applied as the chain does, before each call; the code overrides standing in for
    // them (for simulators that can't) are left out, so each authority's real code and nonce decide whether it applies.
    const auths = await Promise.all(reqs.map(authorizationsOf));
    const authorities = new Set(auths.flat().map(a => a.authority));
    for (const r of reqs) for (const [a, o] of Object.entries(r.stateOverrides ?? {})) {
      if (o.code !== undefined && !authorities.has(hexOf(a))) source.codeOverrides.set(hexOf(a), hexToBytes(o.code as Hex));
      if (o.balance !== undefined) source.balanceOverrides.set(hexOf(a), BigInt(o.balance));
      // Storage set for the simulation: read before the chain's value, never cached as the chain's.
      for (const [slot, value] of Object.entries(o.stateDiff ?? {})) source.storage.set(`${hexOf(a)}_${bytesToHex(setLengthLeft(hexToBytes(slot as Hex), 32))}`, unpadBytes(hexToBytes(value as Hex)));
    }
    // The senders and targets are certain to be read: fetch them before the first run.
    const first = newMisses();
    for (const r of reqs) { first.accounts.add(hexOf(r.from)); if (r.account) first.accounts.add(hexOf(r.account)); if (r.to) first.accounts.add(hexOf(r.to)); }
    const prefetch = source.fetch(first);
    const fixed = at?.header ?? this.opts.header?.(chainId);
    const [block, , rules] = await Promise.all([fixed ? { header: { ...fixed, coinbase: createAddressFromString(fixed.coinbase), difficulty: 0n, prevRandao: hexToBytes(fixed.prevRandao), getBlobGasPrice: () => fixed.blobBaseFee ?? 1n }, arbBlockNumber: fixed.arbBlockNumber ?? fixed.number, amsterdam: fixed.amsterdam }
      : this.blockContext(source, tag, profile), prefetch, this.rulesOf(chainId, source)]);
    // Ethereum's past blocks run under the rules of their time; every other chain's under today's (see rulesNote).
    // A block of Amsterdam's (Glamsterdam: its header says so) runs Amsterdam's rules, on Ethereum and its testnet.
    const amsterdam = ETHEREUM_RULES.has(chainId) && !!block.amsterdam;
    const hardfork = amsterdam ? 'amsterdam' : chainId === 1 && at?.required ? mainnetForkAt(at.header, profile.hardfork) : profile.hardfork;
    if (hardfork !== profile.hardfork) profile = { ...profile, hardfork };
    const common = createCustomCommon({ chainId }, Mainnet, { hardfork: profile.hardfork as never });
    // Precompiles the node lists that this EVM neither has nor forwards (Base's own since November 2026): refused.
    const own = getActivePrecompiles(common), forwards = new Set((profile.forwardedPrecompiles ?? []).map(hexOf));
    for (const [address, name] of rules?.precompiles ?? []) if (!own.has(address.slice(2)) && !forwards.has(address)) source.nodeOnly.set(address, name);
    const rulesNote = rulesNoteOf(chainId, profile, rules, at);
    // Tokens and approvals to read around each call: those the calls name (targets, calldata, decoder hints) and the
    // chain's well-known tokens, then those the logs reveal. Named ones matter: WETH-style wrappers emit Deposit and
    // Withdrawal, not Transfer, so logs alone miss the wrapped token.
    const skip = (a: string) => reqs.some(r => hexOf(r.from) === a || (r.account && hexOf(r.account) === a)) || a === ZERO || BigInt(a) < 0x10000n;
    const tokens = new Set<string>([
      ...reqs.flatMap(r => [...(r.watch ?? []), ...(r.to ? [r.to] : []), ...calldataCandidates(r.data).addresses]).map(hexOf).slice(0, 40),
      ...builtinTokens(chainId).map(t => hexOf(t.address)),
    ].filter(a => !skip(a)));
    const approvals = new Map<string, SimulatedApproval>();
    const key = requestKey(reqs);
    this.seen.set(key, new Set());
    try {
      const results = await this.rounds(reqs, auths, source, common, block, profile, tokens, approvals, chainId, started, deadline, key);
      return rulesNote ? results.map(r => ({ ...r, rulesNote })) : results;
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
        if (e instanceof ForkTimeout || e instanceof ForkUnsupported || !misses || !missCount(misses)) throw e;
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
    // Replaying at a block's pre-state (tag = that block's parent) means simulating the next block: the parent + 1,
    // a block time later, with opcode 0x44 as the chain answers it (src/block.ts).
    const next = headerAfter(source.chainId, await source.header(tag));
    return { header: { number: next.number, coinbase: createAddressFromString(next.coinbase), timestamp: next.timestamp, difficulty: 0n, prevRandao: hexToBytes(next.prevRandao),
      gasLimit: next.gasLimit > GAS ? next.gasLimit : GAS, baseFeePerGas: next.baseFeePerGas, getBlobGasPrice: () => 1n, ...(next.slotNumber !== undefined && { slotNumber: next.slotNumber }) }, arbBlockNumber: next.arbBlockNumber ?? next.number, amsterdam: next.amsterdam };
  }

  /** One run of the calls, in order, on a fresh state over `source`. */
  private async run(reqs: SimulationRequest[], auths: Authorization[][], source: StateSource, misses: Misses | null, common: ReturnType<typeof createCustomCommon>, block: Awaited<ReturnType<ForkSimulator['blockContext']>>,
    profile: ChainProfile, tokens: Set<string>, watchedApprovals: Map<string, SimulatedApproval>, chainId: number) {
    const state = new LazyState(source, misses, { common });
    // The point-evaluation precompile (EIP-4844's, at 0x0a) needs a KZG library and trusted setup this package doesn't
    // carry. It is a pure function of its input, so the chain's node answers it, at the precompile's fixed price.
    const pointEvaluation = getActivePrecompiles(common).has(POINT_EVALUATION.slice(2)) && !profile.noPointEvaluation ? [POINT_EVALUATION] : [];
    const forwarded = [...(profile.forwardedPrecompiles ?? []), ...pointEvaluation].map(address => ({ address: address as Hex, function: async (input: { data: Uint8Array; gasLimit: bigint }) => {
      // ArbSys.arbBlockNumber(): the simulated block's own number, which the chain can't be asked for yet.
      if (profile.arbitrum && address === ARBOS[0] && bytesToHex(input.data.subarray(0, 4)) === '0xa3b1b31d') return { executionGasUsed: 2000n, returnValue: hexToBytes(`0x${block.arbBlockNumber.toString(16).padStart(64, '0')}`) };
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
      const gas = address === POINT_EVALUATION ? 50_000n : profile.precompileGas?.(input.data.length, c.data.length) ?? 2000n;
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
    // Precompiles given code for the simulation (eth_simulateV1's movePrecompileToAddress): the code runs at the
    // precompile's address, which is no longer a precompile, and the precompile at the address it moves to.
    const active = getActivePrecompiles(common);
    const moved = reqs.flatMap(r => Object.entries(r.stateOverrides ?? {})).flatMap(([a, o]) => {
      const fn = o.movePrecompileToAddress ? active.get(hexOf(a).slice(2)) : undefined;
      return fn ? [{ address: hexOf(a) as Hex }, { address: hexOf(o.movePrecompileToAddress!) as Hex, function: fn }] : [];
    });
    // A chain without the point-evaluation precompile has an ordinary empty account at 0x0a.
    const absent = profile.noPointEvaluation && active.has(POINT_EVALUATION.slice(2)) ? [{ address: POINT_EVALUATION as Hex }] : [];
    const precompiles = [...forwarded, ...moved, ...absent];
    const evm: EVM = await createEVM({ common, stateManager: state, customPrecompiles: precompiles, blockchain, ...storagePricing(profile) });
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
    // The call tree of each traced call (SimulationRequest.trace): a frame opens at each message and closes with its
    // result. A frame's own events are those in its result that none of the calls under it returned; the events of a
    // call that failed aren't in any result, as on the chain.
    type Frame = { call: TraceCall; context: string; isStatic: boolean; own: unknown[]; under: Set<unknown> };
    const frames: Frame[] = [];
    let root: Frame | undefined;
    const owned = new Map<TraceCall, unknown[]>();
    if (reqs.some(r => r.trace)) {
      evm.events!.on('beforeMessage', (m: { to?: Address; _codeAddress?: Address; caller: Address; value: bigint; data: Uint8Array; gasLimit: bigint; isStatic: boolean; isCompiled: boolean; delegatecall: boolean; salt?: Uint8Array }, next?: () => void) => {
        if (recording) {
          const parent = frames.at(-1);
          const to = m.to?.toString(), code = (m._codeAddress ?? m.to)?.toString() ?? null;
          const callcode = !!parent && !m.delegatecall && !!to && to === parent.context && code !== to;
          const type = !to ? (m.salt ? 'create2' : 'create') : m.delegatecall ? 'delegatecall' : callcode ? 'callcode' : m.isStatic ? 'staticcall' : 'call';
          const call: TraceCall = { type, from: parent ? parent.context : m.caller.toString(), to: code, value: m.delegatecall ? 0n : m.value, input: bytesToHex(m.data), gas: m.gasLimit, gasUsed: 0n,
            ...((m.isCompiled || (!!code && evm.precompiles.has(code.slice(2)))) && { precompile: true }) };
          frames.push({ call, context: m.delegatecall || callcode ? parent?.context ?? to! : to ?? '', isStatic: m.isStatic, own: [], under: new Set() });
        }
        next?.();
      });
      evm.events!.on('afterMessage', (r: { createdAddress?: Address; execResult: { executionGasUsed: bigint; returnValue: Uint8Array; exceptionError?: { error: string }; logs?: unknown[] } }, next?: () => void) => {
        const f = recording ? frames.pop() : undefined;
        if (f) {
          const ex = r.execResult, parent = frames.at(-1);
          f.call.gasUsed = ex.executionGasUsed;
          if (r.createdAddress) f.call.to = r.createdAddress.toString();
          if (ex.exceptionError) {
            const data = bytesToHex(ex.returnValue) as Hex;
            f.call.error = ex.exceptionError.error === 'revert' ? decodeRevert(data) ?? 'reverted' : ex.exceptionError.error;
            if (ex.returnValue.length) f.call.output = data;
          } else {
            if (f.call.type !== 'create' && f.call.type !== 'create2' && ex.returnValue.length) f.call.output = bytesToHex(ex.returnValue);
            owned.set(f.call, (ex.logs ?? []).filter(l => !f.under.has(l)));
            if (parent) for (const l of ex.logs ?? []) parent.under.add(l);
          }
          if (parent) (parent.call.calls ??= []).push(f.call);
          else root = f;
        }
        next?.();
      });
    }
    /** The finished trace of the call just run: each frame's events numbered by their place among the call's. */
    const traceOf = (logs: unknown[]): TraceCall | undefined => {
      const done = root?.call;
      root = undefined; frames.length = 0;
      if (!done) return undefined;
      const index = new Map(logs.map((l, i) => [l, i]));
      const number = (c: TraceCall) => {
        const mine = (owned.get(c) ?? []).filter(l => index.has(l)) as [Uint8Array, Uint8Array[], Uint8Array][];
        if (mine.length) c.logs = mine.map(l => ({ index: index.get(l)!, address: bytesToHex(l[0]).toLowerCase(), topics: l[1].map(t => bytesToHex(t)), data: bytesToHex(l[2]) }));
        for (const k of c.calls ?? []) number(k);
      };
      number(done);
      owned.clear();
      return done;
    };
    /** What the call just run changed, from what it wrote (LazyState.written) and what those hold now. */
    const changesOf = async (): Promise<StateChange[]> => {
      const w = state.written;
      state.written = undefined;
      if (!w) return [];
      const out = new Map<string, StateChange>();
      const at = (a: string) => { if (!out.has(a)) out.set(a, { address: a }); return out.get(a)!; };
      for (const [a, before] of w.accounts) {
        const address = createAddressFromString(a), now = await state.getAccount(address);
        const balance = now?.balance ?? 0n, nonce = now?.nonce ?? 0n;
        if (balance !== before.balance) at(a).balance = { before: before.balance, after: balance };
        if (nonce !== before.nonce) at(a).nonce = { before: before.nonce, after: nonce };
        if (bytesToHex(await state.getCode(address)) !== before.code) at(a).code = true;
      }
      for (const s of w.storage.values()) {
        const after = bytesToHex(setLengthLeft(await state.getStorage(createAddressFromString(s.address), hexToBytes(s.slot as Hex)), 32));
        if (after !== s.before) (at(s.address).storage ??= []).push({ slot: s.slot, before: s.before, after });
      }
      return [...out.values()];
    };
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
      pre ??= await createEVM({ common, stateManager: new LazyState(source, misses, { common }), customPrecompiles: precompiles, blockchain, ...storagePricing(profile) });
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
      // `from` is the account whose balances are reported; `caller` sends the call (the same, unless the request
      // names another account, e.g. a smart account the EntryPoint calls into).
      const caller = hexOf(req.from), from = hexOf(req.account ?? req.from), target = req.to ? hexOf(req.to) : ZERO;
      const watch = [...tokens];
      const before = new Map<string, bigint | undefined>();
      for (const t of watch) before.set(t, await balanceOf(t, from));
      const nativeBefore = await native(from);
      if (req.value > await native(caller)) {
        results.push({ status: 'reverted', source: source_, revertReason: `insufficient funds: the account holds ${units(chainId, nativeBefore)} and the call sends ${units(chainId, req.value)}`, transfers: [], basis: 'fork' });
        continue;
      }
      // As at the start of a transaction: nothing warm but the sender, the target, the fee recipient, the precompiles
      // and the access list (EIP-2929, EIP-3651), and "original" storage values taken afresh (EIP-2200).
      await evm.journal.cleanup();
      state.originalStorageCache.clear();
      for (const a of [caller, target, block.header.coinbase.toString(), ...evm.precompiles.keys()]) evm.journal.addAlwaysWarmAddress(a);
      for (const e of req.accessList ?? []) { evm.journal.addAlwaysWarmAddress(e.address); for (const k of e.storageKeys) evm.journal.addAlwaysWarmSlot(e.address, k); }
      // The sender's nonce goes up first, then the EIP-7702 authorizations apply (and stay, whatever the call does).
      const sender = createAddressFromString(caller);
      const senderAccount = (await state.getAccount(sender)) ?? new Account();
      senderAccount.nonce++;
      await state.putAccount(sender, senderAccount);
      const authorized = await this.authorize(state, evm, auths[i], chainId);
      // Amsterdam charges an applied authorization for the state it adds, out of the transaction's gas, not as a refund.
      const authRefund = profile.hardfork === 'amsterdam' ? 0n : authorized.refund, authState = profile.hardfork === 'amsterdam' ? authorized.state : 0n;
      const gasLimit = req.gas ? req.gas - intrinsicGas(req, profile.hardfork === 'amsterdam').intrinsic - authState : GAS;
      callIndex = i;
      recording = true;
      if (req.trace) state.written = { accounts: new Map(), storage: new Map() };
      const res = await evm.runCall({ caller: sender, origin: sender, ...(req.to && { to: createAddressFromString(req.to) }), skipNonceIncrement: true,
        data: hexToBytes(req.data as Hex), value: req.value, gasLimit: gasLimit > 0n ? gasLimit : 0n, gasPrice: req.gasPrice ?? 0n, block, ...(req.blobVersionedHashes?.length && { blobVersionedHashes: req.blobVersionedHashes as Hex[] }) });
      recording = false;
      const ex = res.execResult;
      const traced = req.trace ? { trace: traceOf(ex.logs ?? []), stateChanges: await changesOf() } : undefined;
      const gasUsed = transactionGas(req, ex.executionGasUsed + authState, (ex.gasRefund ?? 0n) + authRefund, !BEFORE_PRAGUE.has(profile.hardfork), profile.hardfork === 'amsterdam');
      if (ex.exceptionError) {
        const data = bytesToHex(ex.returnValue) as Hex;
        results.push({ status: 'reverted', source: source_, gasUsed, revertReason: ex.exceptionError.error === 'revert' ? decodeRevert(data) : ex.exceptionError.error, transfers: [], basis: 'fork', returnData: data, ...(traced?.trace && { trace: traced.trace }) });
        continue;
      }
      const logs = (ex.logs ?? []).map(([address, topics, data]) => ({ address: bytesToHex(address), topics: topics.map(t => bytesToHex(t)), data: bytesToHex(data) }));
      const parsed = parseLogs(logs);
      // Tokens whose Transfer logs involve the account: read its balance of each, before and after.
      for (const l of logs) if (l.topics[0] === TRANSFER && l.topics.length === 3 && hexOf(l.address) !== NATIVE_LOG_ADDRESS && [l.topics[1], l.topics[2]].some(t => `0x${t.slice(26)}` === from)) {
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
      results.push({ status: 'success', source: source_, gasUsed, transfers, nftTransfers: parsed.nftTransfers, approvals: parsed.approvals, ...(approvalState.length && { approvalState }), ...(parsed.coreActions && { coreActions: parsed.coreActions }), basis: 'fork', returnData: bytesToHex(ex.returnValue), logs: logs.map(l => ({ ...l, address: l.address.toLowerCase() })),
        ...(traced?.trace && { trace: traced.trace, stateChanges: traced.stateChanges }) });
    }
    return { results, tokens: [...seenTokens], approvals: seenApprovals, rerun, trace };
  }

  /**
   * Applies EIP-7702 authorizations as the chain does at the start of a transaction: each one for this chain (or
   * every chain) whose authority has no code or a delegation, and whose nonce matches the authority's (checked for
   * signed ones only), sets the authority's code and bumps its nonce. Returns the refund they earn before Amsterdam
   * (12,500 for each whose authority already existed), and what Amsterdam charges for the state they add: for an
   * authority with no account yet, the account's write (9,000) and its 120 bytes; for one not yet delegated, the
   * delegation's 23 bytes; each byte 1,530. (Two mined on Sepolia, by new accounts, cost 494,493 gas each: the node's
   * figure and, with these, the local EVM's.)
   */
  private async authorize(state: LazyState, evm: EVM, list: Authorization[], chainId: number): Promise<{ refund: bigint; state: bigint }> {
    let refund = 0n, added = 0n;
    for (const a of list) {
      if (!a.authority || (a.chainId !== 0n && a.chainId !== BigInt(chainId))) continue;
      const who = createAddressFromString(a.authority);
      evm.journal.addAlwaysWarmAddress(a.authority);
      const code = await state.getCode(who);
      if (code.length && !isDelegation(code)) continue;
      const account = await state.getAccount(who);
      if (a.nonce !== undefined && (account?.nonce ?? 0n) !== a.nonce) continue;
      if (account) refund += 12_500n;
      added += (account ? 0n : 9_000n + 120n * 1_530n) + (isDelegation(code) || a.address === ZERO ? 0n : 23n * 1_530n);
      const next = account ?? new Account();
      next.nonce++;
      await state.putAccount(who, next);
      await state.putCode(who, a.address === ZERO ? new Uint8Array(0) : hexToBytes(`0xef0100${a.address.slice(2)}`));
    }
    return { refund, state: added };
  }
}

const units = (chainId: number, v: bigint) => `${formatUnits(v, CHAINS[chainId]?.nativeDecimals ?? 18)} ${CHAINS[chainId]?.nativeSymbol ?? ''}`.trim();
