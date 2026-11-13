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
import { builtinTokens, CHAINS, PERMIT2, PRECOMPILE_SCALE } from './chains.ts';
import { headerAfter, NEXT_BLOCK, nodeOverrides, priceFields, type StateChanges } from './block.ts';
import { calldataCandidates } from './simulation-probe.ts';
import { ACTIVATION_REGISTRY_CODE, B20_ASSET_CODE, B20_BOOTSTRAP_SLOT, B20_FACTORY_CODE, B20_STABLECOIN_CODE, POLICY_REGISTRY_CODE } from './b20-reference.ts';
import { formatUnits } from './format.ts';
import { approvalKey, authorizationsForNode, decodeRevert, decodeState, ELSEWHERE, fitGas, hadRoom, namedApproval, NATIVE_LOG_ADDRESS, parseLogs, stateCall } from './simulation.ts';
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
  checked?: { forkId: string; on: string; /** The fork the chain has scheduled, checked ahead: its programs run on the node in a block at the fork's time (npm run rules -- --next). */ next?: { forkId: string; on: string } };
  /** Seconds between blocks, for the simulated next block's timestamp. */
  blockTime: number;
  /** Precompiles the local EVM doesn't have; their calls are answered by eth_call on the chain (HyperEVM's HyperCore reads). */
  forwardedPrecompiles?: string[];
  /** Gas a forwarded precompile call costs. */
  precompileGas?: (inputBytes: number, outputBytes: number, selector?: string) => bigint;
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
   * The chain's prices for precompiles where they aren't Ethereum's, as the EVM library's parameters by the EIP that
   * set them (1679: Istanbul's bn254 prices; 2537: BLS12-381's). Polygon's were measured on its node by the gas a
   * STATICCALL to each spends: bn254 add 540 (Ethereum 150), multiply 12,600 (6,000), pairing 67,500 and 51,000 a
   * pair (45,000 and 34,000); BLS12-381 G1 add 1,050 (375), G1 multiply 73,200 (12,000), G2 add 1,620 (600), G2
   * multiply 144,000 (22,500), pairing 109,330 and 94,540 a pair (37,700 and 32,600), map to G1 15,400 (5,500), map
   * to G2 66,640 (23,800); the multi-scalar discounts are Ethereum's; blake2f 22 a round (1). Applied with `storageGas`.
   */
  precompilePrices?: Record<number, Record<string, number>>;
  /**
   * Precompiles the chain charges a multiple of Ethereum's price for (address in hex, without 0x and leading zeros:
   * '1' for ecrecover), the formula otherwise its own (the chain's EIPs, as `eips` gives them).
   */
  precompileScale?: Record<string, bigint>;
  /** What the point-evaluation precompile (0x0a, answered by the chain's node) costs there, where not Ethereum's 50,000. */
  pointEvaluationGas?: bigint;
  /**
   * Who is paid a transaction's tip as the block goes, where it isn't the block's fee recipient (COINBASE), which
   * a later call in a batch may read: BNB Chain collects fees at its system address and pays its validator at the
   * end of the block. (Arbitrum pays its own fee accounts, none of them COINBASE: see `arbitrum`.) Measured on
   * each node with two priced calls in one simulated block.
   */
  tipsTo?: string;
  /**
   * EIPs the chain runs that its fork doesn't have. HyperEVM, on Cancun's rules, follows an EIP-7702 delegation: a
   * call into an account whose code is 0xef0100 and an address runs that address's code (measured on its node with
   * such code given to an account; it mined no EIP-7702 transaction in 400 blocks, so whether an account there
   * can come to hold one wasn't seen).
   */
  eips?: number[];
  /**
   * The longest code a contract may have, where it isn't Ethereum's 24,576 bytes (before Amsterdam). Polygon's is
   * 32,768: measured on its node, where a creation of 32,768 bytes of code succeeds and one of 32,769 fails. (Its
   * limit on initcode is Ethereum's 49,152.)
   */
  maxCodeSize?: number;
  /** The chain has no point-evaluation precompile at 0x0a (it carries no blobs): the address is an empty account there. */
  noPointEvaluation?: boolean;
  /**
   * Precompiles of the chain's own that a fork adds, from its time on (seconds): before it, the address is an empty
   * account. Each costs a fixed price, whatever its input, and answers from the block.
   */
  timedPrecompiles?: TimedPrecompile[];
  /**
   * Opcodes of the profile's fork that the chain's node refuses as invalid, measured by running each on the node:
   * chains without blobs have no BLOBBASEFEE (Arbitrum, Polygon), and Polygon no BLOBHASH either.
   */
  missingOpcodes?: number[];
}

export interface TimedPrecompile { name: string; address: string; from: bigint; gas: bigint; answer: (block: { timestamp: bigint; milliseconds: bigint }) => Uint8Array }

/**
 * BNB Chain's fork of 2026-12-08 (its eth_config's next: fork id 0x23d35e07, activation 1,796,697,000): one precompile,
 * MILLI_TIMESTAMP at 0x70, which returns the block's time in milliseconds, its seconds times 1,000 and the
 * milliseconds its mixHash carries (BEP-520), as a 32-byte word. Measured on its node, whose eth_simulateV1 runs a
 * block at the fork's time under the fork's rules: 20 gas whatever the input (none, 1, 32, 33 or 1,000 bytes), warm
 * from the start, given 19 it runs out; with a prevRandao override of 550 it answers 1,796,697,000,550. Before the
 * fork the address is an empty account (a call to it 2,600, cold).
 */
const BNB_MILLI_TIMESTAMP: TimedPrecompile = {
  name: 'MILLI_TIMESTAMP', address: '0x0000000000000000000000000000000000000070', from: 1_796_697_000n, gas: 20n,
  answer: b => hexToBytes(`0x${(b.timestamp * 1000n + b.milliseconds).toString(16).padStart(64, '0')}`),
};
/** The chain's own precompiles in effect at `time` (ChainProfile.timedPrecompiles). */
export const timedPrecompilesAt = (profile: ChainProfile | undefined, time: bigint) => (profile?.timedPrecompiles ?? []).filter(p => time >= p.from);

/** HyperEVM's read precompiles (0x…0800 onward: positions, spot balances, prices, L1 block number...). */
const HYPERCORE_READS = Array.from({ length: 64 }, (_, i) => `0x${(0x800 + i).toString(16).padStart(40, '0')}`);

/**
 * HyperCore read precompile gas, measured on HyperEVM mainnet (2026-11-05) with a contract reading gasleft() around
 * STATICCALLs to six of them (inputs of 0-64 bytes, outputs of 32-256): 1,000 + 33 per input and output byte, on top
 * of the warm access (100; they are warm from the start). With it, real transactions' gas matches their receipts. A
 * call that fails (missing input, an unknown asset) uses all the gas it is given and returns nothing, also measured.
 */
const hyperCoreReadGas = (input: number, output: number) => 1000n + 33n * BigInt(input + output);
/**
 * What ArbOS's precompiles charge, measured on Arbitrum One's node (2026-11-11) by the gas a STATICCALL to each
 * spends: 800 to open the chain's own state, 800 for each storage slot the method reads, and 3 for each word it is
 * given and each it returns. ArbSys.arbBlockNumber() is 803; ArbGasInfo.getPricesInWei(), which reads two slots
 * and returns six words, 2,418. Here are the slots read by the methods contracts call most (ArbSys's block number,
 * chain id, version, isTopLevelCall and getStorageGasAvailable, and ArbGasInfo's getCurrentTxL1GasFees read none);
 * a method not listed is taken to read one. Before, every call was charged a flat 2,000: a transaction that asked
 * for the block number came out 1,197 gas high in the local EVM (4 of 17 replayed).
 */
const ARBOS_READS: Record<string, number> = {
  '0xa3b1b31d': 0, '0xd127f54a': 0, '0x051038f2': 0, '0x08bd624c': 0, '0xa94597ff': 0, '0xc6f7de0e': 0,
  '0xf5d6ded7': 1, '0xf918379a': 1, '0x055f362f': 1, '0x02199f34': 1, // getL1BaseFeeEstimate, getMinimumGasPrice, getL1GasPriceEstimate, getPricesInArbGas
  '0x612af178': 2, '0x41b247a8': 2, // getGasAccountingParams, getPricesInWei
};
const arbosGas = (input: number, output: number, selector?: string) => 800n + 800n * BigInt(ARBOS_READS[selector ?? ''] ?? 1) + 3n * BigInt(Math.ceil(Math.max(0, input - 4) / 32) + Math.ceil(output / 32));

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
const POLYGON_PRECOMPILES = {
  1679: { bn254AddGas: 540, bn254MulGas: 12_600, bn254PairingGas: 67_500, bn254PairingWordGas: 51_000, blake2RoundGas: 22 },
  2537: { bls12381G1AddGas: 1_050, bls12381G1MulGas: 73_200, bls12381G2AddGas: 1_620, bls12381G2MulGas: 144_000, bls12381PairingBaseGas: 109_330, bls12381PairingPerPairGas: 94_540, bls12381MapG1Gas: 15_400, bls12381MapG2Gas: 66_640 },
};

export const CHAIN_PROFILES: Record<number, ChainProfile> = {
  1: { hardfork: 'osaka', checked: { forkId: '0x07c9462e', on: '2026-11-10' }, ...NEXT_BLOCK[1] },
  // Sepolia runs Amsterdam (Glamsterdam) since 2026-10-06: its blocks say so, and run under those rules (see ETHEREUM_RULES).
  11155111: { hardfork: 'osaka', checked: { forkId: '0x6c1d9423', on: '2026-11-11' }, ...NEXT_BLOCK[11155111] },
  42161: { hardfork: 'osaka', checked: { forkId: '0x92f58d00', on: '2026-11-10' }, ...NEXT_BLOCK[42161], forwardedPrecompiles: ARBOS, precompileGas: arbosGas, missingOpcodes: [0x4a] },
  8453: { hardfork: 'osaka', checked: { forkId: '0x169d85a3', on: '2026-11-10' }, ...NEXT_BLOCK[8453] },
  10: { hardfork: 'osaka', checked: { forkId: '0xc29239af', on: '2026-11-10' }, ...NEXT_BLOCK[10] },
  // Polygon prices storage its own way. Measured on its node with code overrides (2026-11-10): a cold SLOAD costs
  // 5,460; a cold SSTORE adds 2,940 (setting an empty slot 22,940, changing a set one 5,000 as on Ethereum, writing
  // back the same value 3,040), and clearing a slot refunds 3,960. Warm reads, accounts, calls, logs, hashing and
  // creation cost what they do on Ethereum. With Ethereum's prices every transaction that touched storage came out
  // low, by a multiple of 840.
  137: { hardfork: 'osaka', ...NEXT_BLOCK[137], storageGas: { coldRead: 5460, coldWrite: 2940 }, precompilePrices: POLYGON_PRECOMPILES, missingOpcodes: [0x49, 0x4a], noPointEvaluation: true, maxCodeSize: 32_768 },
  // (Its fork of 2026-12-08 checked ahead: the rules check's 370 programs alike on its node at the fork's time.)
  56: { hardfork: 'osaka', checked: { forkId: '0xd38cc282', on: '2026-11-10', next: { forkId: '0x23d35e07', on: '2026-11-12' } }, ...NEXT_BLOCK[56], forwardedPrecompiles: BSC_PRECOMPILES, tipsTo: '0xfffffffffffffffffffffffffffffffffffffffe',
    timedPrecompiles: [BNB_MILLI_TIMESTAMP] },
  // HyperEVM prices most precompiles its own way, measured on its node (2026-11-12; until a day before it charged
  // Ethereum's): ecrecover 15,000; modexp ten times Osaka's formula (EIP-7883, at least 5,000, inputs to 1,024 bytes
  // as EIP-7823 has them); bn254 and blake2f ten times Ethereum's (a pairing 450,000 and 340,000 a pair); point
  // evaluation 2,000,000. sha256, ripemd160 and identity cost what they do on Ethereum; P256VERIFY isn't there.
  999: { hardfork: 'cancun', eips: [7702, 7823, 7883], ...NEXT_BLOCK[999], forwardedPrecompiles: HYPERCORE_READS, precompileGas: hyperCoreReadGas,
    precompileScale: PRECOMPILE_SCALE[999], pointEvaluationGas: 2_000_000n },
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
  /**
   * False: only the tokens a request names (SimulationRequest.watch) are read around its call, not its target, the
   * addresses in its calldata and the chain's well-known tokens. For runs that want the call itself, not what it
   * moved (scripts/rules-check.ts): each token read is state to fetch.
   */
  watchTokens?: boolean;
  /**
   * Ask the node what the calls will touch (eth_createAccessList) and read it before the first run (default true):
   * fewer rounds of reads. SIGNING_PREVIEW_FORK_PREFETCH=off turns it off.
   */
  prefetch?: boolean;
  /** The state to simulate on: 'latest' (default), or a block number to replay a transaction at its pre-state. */
  block?: (chainId: number) => string;
  /**
   * The simulated block's header. By default, the next block after `block`: its number + 1, its timestamp plus the
   * chain's block time, and its fee recipient, randomness and base fee. Replays pass the real block's header.
   */
  header?: (chainId: number) => { number: bigint; timestamp: bigint; coinbase: string; prevRandao: Hex; gasLimit: bigint; baseFeePerGas: bigint; /** Arbitrum: the chain's own block number (`number` is then the L1 block's). */ arbBlockNumber?: bigint; /** The block's blob base fee (BLOBBASEFEE). */ blobBaseFee?: bigint; /** The block is one of Amsterdam's. */ amsterdam?: boolean; /** The beacon slot (SLOTNUM), from Amsterdam on. */ slotNumber?: bigint ; /** The milliseconds of the block's time (BNB Chain: its mixHash, BEP-520). */ milliseconds?: bigint } | undefined;
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
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', APPROVAL = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';


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
  /** Nonces the simulated block had already moved (BlockAt.state: a replay's earlier transactions), instead of the chain's. */
  nonceOverrides = new Map<string, bigint>();
  /** Precompiles the chain's node lists that the local EVM neither has nor forwards (address to name): a call reaching one is refused. */
  nodeOnly = new Map<string, string>();
  /** Contracts the chain's node runs itself that this simulation ran from a Solidity reference instead (nativeStandIn). */
  standIns = new Set<string>();
  /** Of those whose storage was read for after a block's earlier transactions, the ones those transactions changed (fetchAfter). */
  staleNative = new Set<string>();
  /**
   * What the references hashed into a storage slot (each 64-byte input of a KECCAK256 they ran, by its hash): a key
   * and the mapping's slot, which tells fetchAfter what a B20 token's slot holds (whose balance, which allowance).
   */
  preimages = new Map<string, Uint8Array>();
  /** The simulated block's time: which references apply (nativeStandIn). */
  time?: bigint;
  /** What the chain charges for a cold storage read (ChainProfile.storageGas): what a storage reader is given for each. */
  coldRead = 2_100;

  /**
   * What the node says a call will touch (eth_createAccessList, on the block the reads are of): the accounts and
   * slots to read before the first run. Undefined where it won't say (no such method, an error).
   */
  async accessList(call: Record<string, unknown>): Promise<{ address: string; storageKeys: string[] }[] | undefined> {
    let out: { accessList?: { address: string; storageKeys: string[] }[] } | undefined;
    try { await this.send([{ method: 'eth_createAccessList', params: [call, this.block], done: r => { out = r as typeof out; } }]); } catch { return undefined; }
    return Array.isArray(out?.accessList) ? out.accessList : undefined;
  }

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
  after?: { calls: unknown[]; blockOverrides: Record<string, string>; /** What moved each address's nonce among those calls, in order: a transaction it sent, or an EIP-7702 authorization it signed for the nonce given (applied only if that is its nonce by then). */ bumps: Map<string, (bigint | 'sent')[]>; /** What the block had changed before those calls (BlockAt.state): they run on it. */ state?: StateChanges; /** The calls on less gas each, for a node that adds their limits up against the block's (fitGas); undefined when they can't be. */ fit?: () => Promise<{ requests: SimulationRequest[]; calls: unknown[] } | undefined>; /** Set once the calls are the fitted ones: none may have run short on its gas (hadRoom, against `earlier`). */ fitted?: SimulationRequest[]; earlier?: SimulationRequest[] };

  async fetch(m: Misses): Promise<void> {
    // What is already set isn't read over: a simulation's storage overrides, or what a block's earlier transactions
    // left (its access list). The node's access list names slots whatever they hold (prefetching read them over,
    // 2026-11-12: six Sepolia replays started a slot from the parent block's value).
    if ([...m.storage].some(k => this.storage.has(k))) m = { ...m, storage: new Set([...m.storage].filter(k => !this.storage.has(k))) };
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
    // A nonce after the earlier calls: the parent block's, up by one for each transaction the address sent and for
    // each authorization of its own that named the nonce it had by then (an account that delegates itself in two
    // transactions of a block: BNB Chain's busiest sender does, and a trace of the second took its authorization
    // for stale).
    const moved = (a: string, nonce: bigint) => { for (const b of after.bumps.get(a) ?? []) if (b === 'sent' || b === nonce) nonce++; return nonce; };
    const nonceJobs = accounts.map(a => ({ method: 'eth_getTransactionCount', params: [a, this.block], done: (r: unknown) => { nonces.set(a, moved(a, BigInt(r as string))); } }));
    const slots = new Map<string, string[]>();
    const want = (a: string, slot: string) => { const l = slots.get(a) ?? []; if (!l.includes(slot)) l.push(slot); slots.set(a, l); };
    // A precompile keeps no storage, and can't be asked for any this way: the node runs the precompile at its
    // address whatever code an override puts there (the point-evaluation precompile, which a rollup's blob
    // transaction calls, answered the reader's input with "PrecompileError", and the transaction had no trace).
    for (const a of accounts) if (!lowAddress(a)) for (const slot of PROXY_SLOTS) if (!this.storage.has(`${a}_${slot}`)) want(a, slot);
    for (const k of m.storage) { const [a, slot] = k.split('_'); want(a, slot); }
    const needCode = accounts.filter(a => !this.codeOverrides.has(a));
    const balanceCall = { to: BALANCE_READER, data: `0x${accounts.map(word).join('')}` }, codeCalls = needCode.map(a => ({ to: CODE_READER, data: `0x${word(a)}` }));
    const contracts = [...slots.keys()];
    // A B20 token's storage can't be read through a reader (below): where the slot is one of its balances,
    // allowances, nonces or its total supply (what the reference hashed to find it says which), the token's own view
    // of it after the calls, a call the node runs.
    const views = contracts.flatMap(a => {
      const code = this.accounts.get(a)?.code;
      if (!B20.test(a) || !code || !isNative(code)) return [];
      return slots.get(a)!.flatMap(slot => { const data = this.b20View(slot); return data ? [{ a, slot, data }] : []; });
    });
    const blocks: unknown[] = [{ calls: after.calls, blockOverrides: after.blockOverrides, ...(after.state && { stateOverrides: after.state }) }];
    // The balance reader in a block of its own: BNB Chain's node splits a block's gas evenly among calls that set
    // none, and beside 151 code readers the one reading 152 balances got 460,526, short of what they cost.
    if (accounts.length) blocks.push({ stateOverrides: { [BALANCE_READER]: { code: BALANCE_READER_CODE } }, calls: [balanceCall] });
    if (codeCalls.length) blocks.push({ stateOverrides: { [CODE_READER]: { code: CODE_READER_CODE } }, calls: codeCalls });
    // (Before the slot readers, whose code overrides last into later blocks.)
    // 150 a block, 200,000 gas each: within a block's limit however a node adds them up (Base's is 40,000,000; a
    // block of 1,700 such views was refused).
    const VIEWS_PER_BLOCK = 150, viewBlocks = Math.ceil(views.length / VIEWS_PER_BLOCK);
    for (let i = 0; i < views.length; i += VIEWS_PER_BLOCK) blocks.push({ calls: views.slice(i, i + VIEWS_PER_BLOCK).map(v => ({ to: v.a, data: v.data, gas: '0x30d40' })) });
    // Each slot reader with gas of its own for its slots (a cold read is 2,100 on most chains), not a share of the block's: unless
    // their limits would add up to more than 30,000,000 (a node that adds them up refuses past its block's).
    // (A cold read costs what the chain charges: Polygon 5,460, not 2,100; a reader of 65 slots on 3,000 each ran out.)
    const perSlot = this.coldRead + 900;
    const slotGas = contracts.map(a => 50_000 + perSlot * slots.get(a)!.length), own = slotGas.reduce((x, y) => x + y, 0) <= 30_000_000;
    if (contracts.length) blocks.push({ stateOverrides: Object.fromEntries(contracts.map(a => [a, { code: SLOT_READER_CODE }])), calls: contracts.map((a, i) => ({ to: a, data: `0x${slots.get(a)!.map(word).join('')}`, ...(own && { gas: `0x${slotGas[i].toString(16)}` }) })) });
    let out: { calls: { status: string; returnData: Hex; gasUsed?: string; logs?: { address: string; topics?: string[] }[] }[] }[] | undefined;
    const simulate = () => this.send([{ method: 'eth_simulateV1', params: [{ blockStateCalls: blocks, validation: false }, this.block], done: r => { out = r as typeof out; } }]);
    await Promise.all([
      this.sendAll(nonceJobs),
      (async () => {
        // A node may refuse the calls more than one way (BNB Chain's: their gas limits add up past the block's, and a
        // blob transaction among them isn't buildable): each refusal is met once, in whatever order it comes.
        const plain = (calls: unknown[]) => (calls as Record<string, unknown>[]).map(c => {
          if (!c.blobVersionedHashes) return c;
          const { blobVersionedHashes: _hashes, maxFeePerBlobGas: _cap, maxFeePerGas, maxPriorityFeePerGas: _tip, ...rest } = c;
          return { ...rest, ...(maxFeePerGas !== undefined && { gasPrice: maxFeePerGas }) };
        });
        let noBlobs = false;
        for (;;) {
          try { return await simulate(); } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            // A node that adds up the calls' gas limits against the block's (fitGas): asked again with each on
            // less gas, and checked below for any that may have run short.
            if (/block gas limit exceeded/i.test(message) && !after.fitted) {
              const fit = await after.fit?.();
              if (!fit) throw e;
              after.calls = noBlobs ? plain(fit.calls) : fit.calls; after.fitted = fit.requests;
            } else if (/not buildable/i.test(message) && !noBlobs && (after.calls as Record<string, unknown>[]).some(c => c.blobVersionedHashes)) {
              // A node that won't build a call with blob hashes (BNB Chain's: RpcSimulator.buildable): the earlier
              // blob transactions as the plain calls they also are, at their price.
              noBlobs = true;
              after.calls = plain(after.calls);
            } else throw e;
            (blocks[0] as { calls: unknown[] }).calls = after.calls;
          }
        }
      })(),
    ]);
    const failed = new Error('reading the state after the block\'s earlier transactions failed');
    if (!out || out.length !== blocks.length) throw failed;
    if (after.fitted && !hadRoom(after.earlier ?? [], after.fitted, out[0].calls)) throw new Error("one of the block's earlier transactions, run on less gas each for a node that adds their limits up, may have run short");
    const words = (data: Hex, n: number) => Array.from({ length: n }, (_, i) => `0x${data.slice(2 + 64 * i, 66 + 64 * i).padEnd(64, '0')}` as Hex);
    let at = 1;
    if (accounts.length) {
      const rb = out[at++].calls, rc = codeCalls.length ? out[at++].calls : [];
      if ([...rb, ...rc].some(c => c.status !== '0x1')) throw failed;
      const balances = words(rb[0].returnData, accounts.length);
      const code = new Map(needCode.map((a, i) => [a, hexToBytes(rc[i].returnData)]));
      accounts.forEach((a, i) => this.accounts.set(a, { balance: BigInt(balances[i]), nonce: nonces.get(a) ?? 0n, code: this.codeOverrides.get(a) ?? code.get(a) ?? new Uint8Array(0) }));
    }
    const viewed = new Set<string>();
    const viewResults = out.slice(at, at += viewBlocks).flatMap(b => b.calls);
    viewResults.forEach((c, i) => {
      if (c.status !== '0x1' || c.returnData.length !== 66) return;
      const k = `${views[i].a}_${views[i].slot}`;
      this.storage.set(k, unpadBytes(hexToBytes(c.returnData)));
      viewed.add(k);
    });
    if (contracts.length) {
      const r = out[at].calls, native: string[] = [];
      contracts.forEach((a, i) => {
        // A contract the node runs itself keeps its own code whatever the override says (Base's B20 tokens: an
        // override moving the precompile away is ignored too), so its storage can't be read this way: below.
        // So does a precompile, wherever its address is: an account with no code that won't run the reader has no
        // storage to read.
        if (r[i].status !== '0x1') {
          const code = this.accounts.get(a)?.code;
          if (code && isNative(code)) { native.push(a); return; }
          if (code?.length !== 0) throw failed;
          for (const slot of slots.get(a)!) this.storage.set(`${a}_${slot}`, new Uint8Array(0));
          return;
        }
        words(r[i].returnData, slots.get(a)!.length).forEach((v, j) => this.storage.set(`${a}_${slots.get(a)![j]}`, unpadBytes(hexToBytes(v))));
      });
      // The rest of its storage as of the block the earlier transactions ran on (the only way the node gives it):
      // what they left, unless one of them changed it, which its events tell (a B20 token's every change has one).
      // Transfers and approvals change only balances, allowances, nonces (a permit's) and the total supply (a mint's
      // or a burn's), read above after the calls where their views answered; any other event of the contract's, any
      // of a registry's, the factory's naming the token (one created among them), or any event at all where a view
      // of a slot didn't answer, may have changed what was read here. Such a contract is noted
      // (StateSource.staleNative): what it reads may not be what it held.
      if (native.length) {
        const logs = out[0].calls.flatMap(c => c.logs ?? []), word = (a: string) => `0x${a.slice(2).padStart(64, '0')}`;
        const touched = new Set(logs.map(l => l.address.toLowerCase()));
        const changed = new Set(logs.filter(l => !B20.test(l.address) || ![TRANSFER, APPROVAL].includes((l.topics?.[0] ?? '').toLowerCase())).map(l => l.address.toLowerCase()));
        const created = new Set(logs.filter(l => l.address.toLowerCase() === B20_FACTORY).map(l => (l.topics?.[1] ?? '').toLowerCase()));
        const meant = new Set(views.map(v => `${v.a}_${v.slot}`));
        const rest = native.flatMap(a => slots.get(a)!.filter(slot => !viewed.has(`${a}_${slot}`)).map(slot => [a, slot] as const));
        for (const [a, slot] of rest) if (changed.has(a) || created.has(word(a)) || (meant.has(`${a}_${slot}`) && touched.has(a))) this.staleNative.add(a);
        await this.sendAll(rest.map(([a, slot]) => ({ method: 'eth_getStorageAt', params: [a, slot, this.block], done: (v: unknown) => { this.storage.set(`${a}_${slot}`, unpadBytes(hexToBytes(v as Hex))); } })));
      }
    }
  }

  /** The call to a B20 token whose answer is what `slot` holds (see preimages), if it is one such a call answers. */
  private b20View(slot: string): Hex | undefined {
    if (BigInt(slot) === B20_LAYOUT + 3n) return '0x18160ddd'; // totalSupply()
    const p = this.preimages.get(slot);
    if (!p) return undefined;
    const key = bytesToHex(p.subarray(0, 32)), mapping = BigInt(bytesToHex(p.subarray(32)));
    const isAddress = (k: string) => BigInt(k) < 1n << 160n;
    if (!isAddress(key)) return undefined;
    if (mapping === B20_LAYOUT + 4n) return `0x70a08231${key.slice(2)}`; // balanceOf(account)
    if (mapping === B20_LAYOUT + 13n) return `0x7ecebe00${key.slice(2)}`; // nonces(owner)
    // allowances[owner][spender]: the spender hashed into the owner's own mapping.
    const outer = this.preimages.get(bytesToHex(p.subarray(32)));
    if (!outer || BigInt(bytesToHex(outer.subarray(32))) !== B20_LAYOUT + 5n) return undefined;
    const owner = bytesToHex(outer.subarray(0, 32));
    return isAddress(owner) ? `0xdd62ed3e${owner.slice(2)}${key.slice(2)}` : undefined; // allowance(owner, spender)
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
      // Arbitrum's BLOCKHASH takes the L1 block numbers NUMBER gives, and answers with a value of its own for each
      // (not that L1 block's hash, nor the hash of the L2 block with that number): the chain is asked, by running
      // the opcode there.
      if (NEXT_BLOCK[this.chainId]?.arbitrum) {
        jobs.push({ method: 'eth_call', params: [{ to: BLOCKHASH_PROBE, data: '0x' }, this.block, { [BLOCKHASH_PROBE]: { code: `0x67${n.toString(16).padStart(16, '0')}4060005260206000f3` } }], done: (r, e) => {
          const h = hexToBytes((e || typeof r !== 'string' || r.length !== 66 ? `0x${'00'.repeat(32)}` : r) as Hex);
          this.blocks.set(n, h);
          if (h.some(b => b !== 0)) BLOCK_HASHES.set(`${this.chainId}:${n}`, h);
        } });
        continue;
      }
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
    let throttled = false;
    for (let attempt = 0; ; attempt++) {
      // (Said as a rate limit where the node was refusing for one: a caller can tell it from a slow EVM.)
      if (Date.now() > this.deadline) throw new ForkTimeout(`the simulation ran out of time fetching chain state${throttled ? ' (the node rate limited its reads)' : ''}`);
      this.requests += batch.length;
      const res = await this.fetchImpl(this.url, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15_000),
        body: JSON.stringify(batch.map((j, i) => ({ jsonrpc: '2.0', id: i, method: j.method, params: j.params }))) });
      const body = res.ok ? await res.json() as unknown : undefined;
      // Rate limits, and load-balanced nodes a block behind ("invalid block height") are worth retrying.
      const transient = /rate limit|too many requests|invalid block height|header not found|unknown block/i;
      const text = Array.isArray(body) ? '' : JSON.stringify(body ?? '');
      const limited = res.status === 429 || transient.test(text);
      throttled = res.status === 429 || /rate limit|too many requests/i.test(text);
      // Public RPCs rate-limit per IP: back off (as long as the node asks, else twice as long each time, up to 4 s
      // between tries), within the simulation's deadline. (Waiting a rate limit out for all of a replay's minute
      // rescued no trace on Arbitrum One's public node, which refused for longer: eight tries, some twenty seconds.)
      const asked = Number(res.headers?.get?.('retry-after'));
      const wait = () => Math.min(asked > 0 ? asked * 1000 : 300 * 2 ** attempt, 4000);
      if ((limited || res.status >= 500) && attempt < 8) { await new Promise(r => setTimeout(r, wait())); continue; }
      if (!Array.isArray(body)) throw new Error(`state fetch failed: HTTP ${res.status} ${text.slice(0, 160)}`);
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
      await new Promise(r => setTimeout(r, wait()));
    }
  }
}

/** Chains whose RPC has no eth_createAccessList (HyperEVM's answers eth_call and state reads only). */
const NO_ACCESS_LIST = new Set([999, 998]);

/** An address in the range chains keep for precompiles and their own contracts (under 0x10000): its proxy slots aren't read ahead. */
const lowAddress = (a: string) => BigInt(a) < 0x10000n;

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
    const a = await this.chainData(key), balance = this.source.balanceOverrides.get(key), nonce = this.source.nonceOverrides.get(key);
    // A balance or nonce set for the simulation stands in for the chain's, whatever else the account holds.
    return balance === undefined && nonce === undefined ? a : { nonce: nonce ?? a?.nonce ?? 0n, code: a?.code ?? new Uint8Array(0), balance: balance ?? a?.balance ?? 0n };
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
    // deployed since London): a contract the chain's node runs itself, as Base does its B20 tokens. Base's are run
    // from their Solidity references, on the chain's storage (nativeStandIn); any other is refused.
    // (Its code stays the chain's, the marker: what EXTCODESIZE, EXTCODECOPY and an EIP-7702 delegation to it see.
    // The reference is given to a call that runs at its address: standInFor, from run()'s Base beforeMessage hook
    // and the pre-state views EVM's.)
    const standIn = nativeStandIn(this.source.chainId, key, a.code, this.source.time);
    if (this.source.chainId === BASE && key === B20_FACTORY && this.source.time !== undefined && this.source.time < BASE_DENIM) throw new ForkUnsupported(`${key} is Base's B20 factory, which the local EVM runs as it is from Base's upgrade of 2026-11-05 on, not as it was at this block`);
    if (!standIn && isNative(a.code)) throw new ForkUnsupported(!B20.test(key) ? `${key} is a contract this chain's node runs itself (its code is a marker, not EVM code), which the local EVM can't run`
      : this.source.time !== undefined && this.source.time < BASE_DENIM ? `${key} is a B20 token (Base's native token standard, which its node runs itself), and the local EVM runs B20 tokens as they are from Base's upgrade of 2026-11-05 on, not as they were at this block`
      : `${key} is a B20 token of a kind the local EVM has no reference for (Base's native token standard: its node runs the token itself, behind the marker code 0xef)`);
    const exists = a.balance > 0n || a.nonce > 0n || a.code.length > 0;
    // (A stand-in keeps the chain's code hash: EXTCODEHASH reads what the chain has.)
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
  if (rules?.forkId && profile.checked && rules.forkId !== profile.checked.forkId && rules.forkId !== profile.checked.next?.forkId) {
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
  const params = JSON.parse(JSON.stringify(paramsEVM)) as Record<string, Record<string, number>>;
  // The chain's own limit on a contract's code (ChainProfile.maxCodeSize), in place of Spurious Dragon's.
  if (profile.maxCodeSize !== undefined) params[607].maxCodeSize = profile.maxCodeSize;
  if (!g) return { ...(profile.maxCodeSize !== undefined && { params: params as never }), ...(gone.length && { customOpcodes: gone as never }) };
  Object.assign(params[2929], { coldsloadGas: g.coldWrite, sstoreCleanEIP2200Gas: 5000 - g.coldWrite });
  Object.assign(params[3529], { sstoreClearRefundEIP2200Gas: 5000 - g.coldWrite + 1900 });
  // The chain's own prices for precompiles (ChainProfile.precompilePrices), in place of Ethereum's.
  for (const [eip, prices] of Object.entries(profile.precompilePrices ?? {})) Object.assign(params[eip], prices);
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
/** A call frame as the EVM library keeps it, as far as state gas goes. */
type GasFrame = { gasLeft: bigint; stateGasSpilled: bigint; env: { depth: number }; interpreter: object; stack: { peek(n?: number): bigint[] } };
/** What cleared slots have given back that sits in the reservoir, where a caller that paid out of its own gas can take it back. */
type GasBack = { pool: bigint };
const REPAYS_CALLERS = Symbol.for('signing-preview.repaysCallers');

/**
 * Amsterdam gives back what a new storage slot's state cost when the slot is cleared again in the same transaction
 * (EIP-8037). Where that cost came out of a call's own gas (no reservoir for state: a gas limit under the cap), the
 * EVM library gives it back to the call that clears the slot as far as that same call paid, and puts the rest in
 * the reservoir, where only new state can spend it. On Sepolia it comes back to the caller that paid. Measured on
 * its node, 2026-11-11, with a contract that sets a slot in one call and clears it in the next:
 *  - the caller can then spend that gas on anything (92,160 gas of memory, on a limit that holds it only so);
 *  - the call that clears can't (it runs out of gas growing the same memory);
 *  - and a mined transaction that approved two tokens, then had a router spend both allowances and mint, ran on its
 *    554,177 gas limit: the allowances' gas paid for the mint's new slots, two calls further in. By the library's
 *    rule it ran out of gas; either way it used 413,342 given more.
 * So: what a cleared slot gives back beyond what its own call paid goes to the reservoir, where the calls still
 * running can use it for state, and when a call returns to a caller that paid for state out of its own gas, the
 * caller takes back what is still there, up to what it paid. A call that fails takes its givings back with it.
 * Approving and then spending an allowance in one transaction is the commonest shape there is: without this, its
 * trace failed on any ordinary gas limit.
 */
function repayCallers(evm: EVM): GasBack {
  const map = (evm as unknown as { _opcodeMap: ({ opHandler: (frame: GasFrame, common: unknown) => unknown } | undefined)[] })._opcodeMap;
  const pools = evm as unknown as { stateGasReservoir: bigint; stateGasBack: GasBack };
  const back: GasBack = { pool: 0n };
  pools.stateGasBack = back;
  for (const opcode of [0xf0, 0xf1, 0xf2, 0xf4, 0xf5, 0xfa]) {
    const entry = map[opcode];
    if (!entry) continue;
    const inner = entry.opHandler;
    entry.opHandler = async (frame, common) => {
      const before = back.pool;
      await inner(frame, common);
      // The call failed (it left 0): the library has put the reservoir back as it was, and so is this.
      if (frame.stack.peek(1)[0] === 0n) { back.pool = before; return; }
      let repaid = frame.stateGasSpilled < back.pool ? frame.stateGasSpilled : back.pool;
      if (pools.stateGasReservoir < repaid) repaid = pools.stateGasReservoir;
      if (repaid > 0n) { frame.gasLeft += repaid; frame.stateGasSpilled -= repaid; pools.stateGasReservoir -= repaid; back.pool -= repaid; }
    };
  }
  const store = map[0x55];
  if (store) {
    const inner = store.opHandler;
    store.opHandler = (frame, common) => {
      const proto = Object.getPrototypeOf(frame.interpreter) as { creditStateGasRefund: (amount: bigint, context?: string) => void; [REPAYS_CALLERS]?: boolean };
      if (!proto[REPAYS_CALLERS]) {
        proto[REPAYS_CALLERS] = true;
        const original = proto.creditStateGasRefund;
        proto.creditStateGasRefund = function (this: { _evm: { stateGasBack?: GasBack; stateGasReservoir: bigint }; _runState: GasFrame }, amount: bigint, context?: string) {
          const reservoir = this._evm.stateGasReservoir;
          original.call(this, amount, context);
          // What went to the reservoir rather than back to this call's own gas.
          if (this._evm.stateGasBack) this._evm.stateGasBack.pool += this._evm.stateGasReservoir - reservoir;
        };
      }
      return inner(frame, common);
    };
  }
  return back;
}

/** EIP-7825: the most ordinary gas a transaction may use. Under Amsterdam, gas over it pays for new state only. */
const REGULAR_GAS_CAP = 16_777_216n;
/** The EVM library's per-transaction state-gas fields (EIP-8037), which its transaction runner sets before a call. */
interface StateGas { stateGasReservoir: bigint; executionStateGasUsed: bigint; eip2780PrepOog: boolean; eip7928CallPostTargetOog: boolean; _stateGasSnapshots: unknown[]; createdAccountStateGas: Map<unknown, unknown>; createdAccountIntrinsicStateGas: Map<unknown, unknown> }
/** An unused address given code that returns BLOCKHASH of a number, for chains whose BLOCKHASH only they can answer. */
const BLOCKHASH_PROBE = '0x00000000000000000000000000000000b10c4a54';
/** Chains that run Ethereum's own fork schedule: mainnet and Sepolia. */
const ETHEREUM_RULES = new Set([1, 11155111]);
const isDelegation = (code: Uint8Array) => code.length === 23 && code[0] === 0xef && code[1] === 0x01 && code[2] === 0x00;
/** Code that is a marker for something the chain's node runs itself: it starts with 0xEF and is no delegation. */
/**
 * A B20 token's address (Base, from its upgrade of June 2026): the ten-byte prefix 0xb2 00…00, a variant byte (0 an
 * asset, 1 a stablecoin), and nine bytes of a hash. Its node runs the token in Rust (6% of Base transactions
 * replayed on 2026-11-11 reached one).
 */
const B20 = /^0xb2000000000000000000/i;
/** Where a B20 token keeps its state (ERC-7201 \`base.b20\`): name, symbol, URI, total supply, balances, allowances, … from here (MockB20Storage). */
const B20_LAYOUT = 0xc78b71fee795ddd74aff64ea9b2474194c938c3196430e10bb5f01ed48434000n;
/** Base's B20 factory (its events name the tokens it creates); and the addresses the node has a token precompile at: variants 00 and 01. */
const B20_FACTORY = '0xb20f000000000000000000000000000000000000', B20_PRECOMPILE = /^0xb20000000000000000000[01]/i;
/** Base's own contracts by address: its node runs them whatever code an account there has (the factory none). */
const baseNative = (a: string) => B20_PRECOMPILE.test(a) || a in BASE_REGISTRIES || a === B20_FACTORY;
/**
 * Foundry's cheatcode address, which the factory's reference calls to write a new token's state (vm.etch, vm.store):
 * answered for the factory's reference alone (see the run's hooks), an empty account to anyone else, as on the chain
 * (a transaction sent from the factory's address included: measured on Base, a store or etch there does nothing).
 */
const HEVM = '0x7109709ecfa91a80626ff3989d68f67f5b1dd12d';
/**
 * A token's bootstrap window (B20_BOOTSTRAP_SLOT, in its transient storage), which its reference opens to the factory's
 * calls: marked as the factory's reference etches the token and cleared as its createB20 ends, so it is open while
 * the factory creates the token and never to a transaction sent from the factory's address, which Base's node takes
 * as any caller's (measured: mint, burn, seize, grantRole, pause and setters refused for the role, transfers checked
 * against the policies). The chain's factory is native code that calls a token only as it creates it.
 */
const BOOTSTRAP_KEY = hexToBytes(B20_BOOTSTRAP_SLOT as Hex), BOOTSTRAP_OPEN = setLengthLeft(new Uint8Array([1]), 32);
/**
 * What Base's node charges a creation beyond the storage it writes and the events it emits (which are charged as
 * a token's are), measured on its node by creations of each kind beside the local EVM's, each call's own gas timed
 * by a contract calling the factory (a transaction's gas hides a cheap one under the calldata floor). A call to the
 * factory, as one to a registry, is charged 6 a word of its input, not a token's 100 besides (isAuthorized(0, …)
 * 18, isActivated 2,118 with its cold read), and the factory is warm from the start, as the registries are. It
 * works out the token's address (a hash, 42) once its arguments decode (charged as it asks the activation
 * registry), before it checks the parameters' version and decimals; getB20Address is charged it too. Finding
 * whether the token exists is an account read, warm or cold as EIP-2929 prices it (100 or 2,600), isB20Initialized's
 * the same: a creation that would overwrite one fails with both (TokenAlreadyExists). Writing the token costs 34,436
 * more for an asset, 32,236 for a stablecoin; a role granted is charged one read of its flag (ROLES_AT). A
 * stablecoin's currency is checked after all that: an invalid one (lowercase) and an empty one fail with it charged
 * (the reference, patched, checks it after the existence check too, as the chain does). With these, 141 calls of 20 kinds of creation came out alike on the node
 * and here (asset and stablecoin; 6 or 18 decimals; names of 0 to 50 bytes; an admin or none; init calls that
 * succeed, revert, or can't be dispatched; each way it can fail), and so did eight early failures timed from a
 * contract.
 */
const B20_ADDRESS_GAS = 42n, B20_CREATED_GAS: Record<string, bigint> = { '00': 34_436n, '01': 32_236n };
/** The factory's functions (createB20, getB20Address, isB20Initialized) and the activation registry it asks. */
const CREATE_B20 = '0x62975e6a', GET_B20_ADDRESS = '0x8c30260f', IS_B20_INITIALIZED = '0x6a45ba98', ACTIVATION_REGISTRY = '0x8453000000000000000000000000000000000001';
/**
 * What the node charges a token's EIP-712 hashing, which its storage and events don't cover, measured on Base with
 * each call timed from a contract: DOMAIN_SEPARATOR() 132 more than those (the name's hash, 36 for an 18-byte
 * name; the version's, 36; the domain's, 60: the hashes the reference computes as it runs), a permit with a bad
 * signature 246 (those, the struct's hash and the digest's), a permit that succeeds 100 more besides. Hashes are
 * keccak's price, 30 and 6 a word; a slot's (32 or 64 bytes) isn't charged, as anywhere in a token (a string's
 * own hash, for a mapping keyed by one, isn't either: isAnnouncementIdUsed and extraMetadata cost the same).
 */
const EIP712_FUNCTIONS = new Set(['0xd505accf', '0x3644e515']), PERMIT = '0xd505accf', PERMIT_VERIFIED_GAS = 100n;
/** A stablecoin's currency the factory checks after it has charged the token's writing (see B20_CREATED_GAS). */
const B20_PARAM_ERRORS: Record<string, bigint> = { '0x997c1de8': B20_CREATED_GAS['01'], '0x4a43ae87': B20_CREATED_GAS['01'] }; // InvalidCurrency, MissingRequiredField
/** Panic(0x41): the reference's ABI decoder given a string too long to allocate, where the node echoes the selector. */
const PANIC_ALLOCATION = `0x4e487b71${'41'.padStart(64, '0')}`;
/** RoleGranted, RoleRevoked: renounceLastAdmin's 100 more after its write, at its RoleRevoked. */
const ROLE_EVENTS = new Set([0x2f8788117e7eff1d82e926ec794901d17c78024a50270940304540a733656f0dn, 0xf6391f5c32d9c69d2a47ea670b442974b53935d1edc7fd64eb21e047a839171bn]);
/**
 * A token's roles (roles[role][account]): a mapping of mappings at B20_LAYOUT + this. The reference reads a role's
 * flag again to write it, the node once (100 less, at the write).
 */
const ROLES_AT = 6n;
/**
 * roles[DEFAULT_ADMIN_ROLE], the mapping of its holders' flags, and its slot's preimage: the reference's compiler
 * works that slot out ahead where the role is a constant (the factory's grant of the initial admin), so a run never
 * hashes it.
 */
const ADMIN_FLAGS = (() => { const p = setLengthLeft(hexToBytes(`0x${(B20_LAYOUT + ROLES_AT).toString(16)}`), 64); return { slot: keccak256(p), preimage: p }; })();
/** renounceLastAdmin (see chargeStep). */
const RENOUNCE_LAST_ADMIN = '0x6f79e3d7';
/** EIP-2200's sentry: an SSTORE fails with this much gas left or less. */
const SSTORE_SENTRY = 2_300n;
/**
 * Where the reference's own storage reads differ from the node's for a token's function, measured on Base with each
 * call timed from a contract: what to add to its charge, at its first write in its own frame (so within the gas it
 * was given, as the node's: a call given its charge less a little runs out on the node, and one given a little more
 * than the charge succeeds; and whatever fails after it, an announce whose calls fail after its id is written).
 */
const B20_WRITE_GAS: Record<string, (data: Uint8Array, call: { bootstrap?: boolean }) => bigint> = {
  '0x1e4e0091': (_, call) => call.bootstrap ? 0n : -100n, // setRoleAdmin (as an init call, in the bootstrap window, the reference reads as the node does)
  '0x595135dd': () => -100n, // announce
  '0x5ffe6146': () => 100n, // updateMultiplier (more when it clears a pending update: B20_ENDED_GAS)
  '0x2c97a0f0': () => 200n, // cancelUIMultiplierUpdate
};
/** An asset's storage (base-std's MockB20Storage): its multiplier, and a pending update to it, at these slots. */
const ASSET_MULTIPLIER = 0xfdc6d4552d1286ade4d9facdbf0fb50d2ec9b89a90e104f26fd277585e374b01n, ASSET_PENDING = ASSET_MULTIPLIER + 3n;
/** UIMultiplierUpdateCancelled(uint256,uint256). */
const MULTIPLIER_CANCELLED = 0x883856335ba5f60c18b9817c4505d3c7d3f6223dcf39516b30c508c46a5e1cadn;
/**
 * An asset's functions that compute with its multiplier (multiplier, uiMultiplier, toUIAmount, fromUIAmount,
 * toScaledBalance, toRawBalance, scaledBalanceOf, balanceOfUI, totalSupplyUI), and newUIMultiplier. Where the
 * multiplier one takes is the pending update's (one that has taken effect; for newUIMultiplier, a live one too), the
 * node reads the pending slot again for it, where the reference uses the value it read: 100 more, the slot warm by
 * then. Measured on Base with each call timed from a contract, on a live asset given a pending update by an override
 * (live, taken effect, taking effect in that block's second; a multiplier set or none) and on new assets' init calls:
 * each of these 100 more, and once a call (newUIMultiplier on an update that took effect reads the slot twice here,
 * three times there), inside announce as anywhere. Charged as the reference first reads the slot, so within the
 * call's gas (given 1 less than the node's charge, the call runs out there, as on the node). A pending update yet to
 * take effect leaves the others the current multiplier, read alike; effectiveAt(), balances, the supply, transfers,
 * mints and burns cost the same whatever is pending. (updateMultiplier's own reads are B20_ENDED_GAS's; fromUIAmount
 * and toRawBalance read the multiplier before they multiply, as the node's do, patched in scripts/build-b20.ts.)
 */
const MULTIPLIER_VIEWS = new Set(['0x1b3ed722', '0xa60bf13d', '0x3248d4ff', '0x65cd9b3c', '0x04f04c99', '0x0ca06c44', '0x1da24f3e', '0x437a9958', '0x9bea6429']), NEW_UI_MULTIPLIER = '0xdc767007';
/** Whether a call to `selector` takes the pending update's multiplier, the pending slot holding `pending` at time `now`. */
const takesPending = (selector: string, pending: bigint, now: bigint) => {
  const effectiveAt = (pending >> 128n) & 0xffff_ffff_ffff_ffffn;
  return effectiveAt !== 0n && (selector === NEW_UI_MULTIPLIER || (MULTIPLIER_VIEWS.has(selector) && now >= effectiveAt));
};
/**
 * And what to add as the call ends, given what its own frame did (measured the same way): cancelUIMultiplierUpdate
 * with nothing pending; updateMultiplier cancelling a live update (100 more) or clearing one that took effect (200
 * more); setRoleAdmin on a token without admins, where the node reads the role's admin before it refuses.
 */
type TokenFrame = { ok: boolean; returned: Uint8Array; sloads: number; stored: Set<bigint>; topics: Set<bigint>; data: Uint8Array; warm: (slot: bigint) => boolean };
/** roleAdmins[role] (the mapping at B20_LAYOUT + 7) for a call whose first argument is the role. */
const roleAdminSlot = (data: Uint8Array) => BigInt(keccak256(new Uint8Array([...setLengthLeft(data.subarray(4, 36), 32), ...setLengthLeft(hexToBytes(`0x${(B20_LAYOUT + 7n).toString(16)}`), 32)])));
const B20_ENDED_GAS: Record<string, (f: TokenFrame) => bigint> = {
  '0x2c97a0f0': f => !f.ok && bytesToHex(f.returned.subarray(0, 4)) === '0xa7d6a5ca' ? 100n : 0n,
  '0x5ffe6146': f => !f.ok ? 0n : f.topics.has(MULTIPLIER_CANCELLED) ? 100n : f.stored.has(ASSET_PENDING) ? 200n : 0n,
  '0x1e4e0091': f => !f.ok && f.sloads === 1 ? (f.warm(roleAdminSlot(f.data)) ? 100n : 2_100n) : 0n,
  // batchMint refusing a recipient (InvalidReceiver): its 100, charged as each recipient is reached (chargeStep).
  '0x68573107': f => !f.ok && bytesToHex(f.returned.subarray(0, 4)) === '0x9cfea583' ? 100n : 0n,
};
/** Code that returns the word 1 (the cheatcodes' answer: see VM_SOURCE in scripts/build-b20.ts). */
const RETURN_ONE = hexToBytes('0x600160005260206000f3');
/** Code that reverts with no data: a call to a token's address before there is a token there (measured on Base). */
const NO_TOKEN = hexToBytes('0x60006000fd');
const isNative = (code: Uint8Array) => code.length > 0 && code[0] === 0xef && !isDelegation(code);
const BASE = 8453;
/** When Base's upgrade of 2026-11-05 (Denim) took effect: the B20 rules base-std's `main` has (its eth_config activationTime). */
const BASE_DENIM = 1_793_901_600n;
/** Base's registries a B20 token asks on its transfers: who may send and receive (policies), and what is switched on. */
const BASE_REGISTRIES: Record<string, string> = { '0x8453000000000000000000000000000000000001': ACTIVATION_REGISTRY_CODE, '0x8453000000000000000000000000000000000002': POLICY_REGISTRY_CODE };
/**
 * The policy registry's built-in policies (always allow, always block) are written by its first creation, while its
 * counter is under 2 (on Base long since: only a state override puts it back). Before writing them the node marks
 * the registry initialized, writing its code, the one-byte marker, at 200 a byte as a contract's code is charged:
 * charged here as the reference writes the first of them, policies[0] (measured on Base, the counter overridden to
 * 0 and to 1: a creation 200 more there than its reads, writes and events, which are charged as the node charges
 * them; nothing more in a static call, whose first write fails before it).
 */
const POLICY_REGISTRY = '0x8453000000000000000000000000000000000002', REGISTRY_INITIALIZED_GAS = 200n;
/** The policy registry's creations (createPolicy, createPolicyWithAccounts, createCompositePolicy): what writes its built-in policies. */
const POLICY_CREATIONS = new Set(['0xca5d55f6', '0xa2d3044f', '0x6fdd1491']);
/**
 * The policy registry's functions that take a bool, its second argument (updateAllowlist, updateBlocklist: no other
 * function of the tokens, registries or factory takes one). Base's node decodes a bool as any word whose upper 31
 * bytes are zero, true where its last byte isn't (measured on Base: 2, 0x80 and 0xff are taken as true, the member
 * written and logged as 1); a word with any upper byte set it refuses as calldata it can't decode, the selector,
 * reading nothing, as the reference's decoder does. The reference's decoder takes 0 and 1 alone.
 */
const BOOL_ARGUMENTS = new Set(['0x3388fb5b', '0x5c4e51b8']);
const ALWAYS_ALLOW_POLICY = BigInt(keccak256(new Uint8Array([...new Uint8Array(32), ...setLengthLeft(hexToBytes('0x00503aeb06982fa1fe3151dc68f90b3946c55c449dfd447e49dcaece71ba4a00'), 32)])));
/** Code that reverts with DelegateCallNotAllowed() (0x0d89438e): what a B20 token does when run as another's code. */
const NO_DELEGATECALL = hexToBytes('0x630d89438e60e01b60005260046000fd');
/** Code that reverts with NonPayable() (0x6fb1b0e9): what a B20 token or registry does when sent value, whatever the function. */
const NON_PAYABLE = hexToBytes('0x636fb1b0e960e01b60005260046000fd');
/** What a B20 token's call is charged for, as the node charges it (see rounds), and the gas it is given besides to run its reference. */
const NATIVE_CHARGED = new Set(['SLOAD', 'SSTORE', 'LOG0', 'LOG1', 'LOG2', 'LOG3', 'LOG4']), NATIVE_SPARE_GAS = 30_000_000n;
const STAND_IN_CODE = new Map<string, Uint8Array>();
const codeOf = (hex: string) => { let c = STAND_IN_CODE.get(hex); if (!c) STAND_IN_CODE.set(hex, c = hexToBytes(hex as Hex)); return c; };
/**
 * Code to run for a contract the chain's node runs itself (its code the marker 0xef), where there is a reference for
 * it: Base's B20 tokens, by variant, and the registries they call. The references are the Base Standard Library's
 * Solidity ones (src/b20-reference.ts, scripts/build-b20.ts), which keep their state in the slots the Rust
 * precompiles do (checked on Base: a token's name, symbol, total supply and balances are where they say), so they
 * run on the chain's own storage. What they do is the precompiles'; what they cost is what the node charges, not
 * what their code burns (see rounds: their calls are charged their storage and events, as the node's are). They
 * are base-std's `main`, what Base runs from its upgrade of 2026-11-05 (Denim): a block before it ran B20 tokens by
 * other rules (v1.1.0's from 2026-09-30, v1.0.0's before), and isn't given them.
 */
/** Whether a precompile the chain's node lists is one the local EVM runs from its Solidity reference (Base's registries). */
export const hasReference = (chainId: number, address: string) => chainId === BASE && (address.toLowerCase() in BASE_REGISTRIES || address.toLowerCase() === B20_FACTORY);

export function nativeStandIn(chainId: number, address: string, code: Uint8Array, time?: bigint): Uint8Array | undefined {
  if (chainId !== BASE || (time !== undefined && time < BASE_DENIM)) return undefined;
  const key = address.toLowerCase();
  // By address, as Base's node chooses: its factory and registries whatever code an account there has (the
  // factory none on the chain), a token wherever there is code (the marker; an override's, which it ignores).
  if (key === B20_FACTORY) return codeOf(B20_FACTORY_CODE);
  const registry = BASE_REGISTRIES[key];
  if (registry) return codeOf(registry);
  if (code.length === 0 || !B20.test(key)) return undefined;
  const variant = key.slice(22, 24);
  return variant === '00' ? codeOf(B20_ASSET_CODE) : variant === '01' ? codeOf(B20_STABLECOIN_CODE) : undefined;
}

/**
 * The reference to run for a call at `address`, where it is a contract the chain's node runs itself (nativeStandIn):
 * given to the call alone (Message.code), the account keeping the chain's code. On Base's node a token reads as its
 * marker (EXTCODESIZE 1, EXTCODECOPY 0xef, EXTCODEHASH that byte's hash), and an account delegated to one (EIP-7702)
 * runs the marker as code, an undefined opcode, all its gas (measured: 1,000,000 of 1,000,000, value or not); the
 * node finds a precompile by the address called, not the delegate's.
 */
async function standInFor(state: LazyState, chainId: number, address: string, time?: bigint): Promise<Uint8Array | undefined> {
  try { return nativeStandIn(chainId, address, await state.getCode(createAddressFromString(address)), time); }
  catch { return undefined; } // (the EVM's own read of the code fails the same way, and says why)
}

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
      timeoutMs: options.timeoutMs ?? 20_000, block: options.block, header: options.header, onRound: options.onRound, cacheFile: options.cacheFile ?? '', trace: options.trace ?? false, watchTokens: options.watchTokens ?? true, prefetch: options.prefetch ?? process.env.SIGNING_PREVIEW_FORK_PREFETCH !== 'off', profiles: { ...CHAIN_PROFILES, ...options.profiles } };
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

  async simulateBatch(reqs: SimulationRequest[], options?: { /** How long this run may take, over the simulator's own limit. */ timeoutMs?: number; /** Calls the node runs first, for the state these start from (set here, for a replay). */ after?: SimulationRequest[]; /** The first call whose result is wanted (the ones before are a block's earlier transactions, run for their state). */ reportedFrom?: number }): Promise<SimulationResult[] | null> {
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
      const all = await this.simulateBatch([...earlier.map(r => ({ ...r, at, trace: false })), ...reqs.map(r => ({ ...r, at }))], { timeoutMs: options?.timeoutMs, reportedFrom: earlier.length });
      return all && all.slice(earlier.length);
    }
    const started = Date.now(), deadline = started + Math.max(this.opts.timeoutMs, options?.timeoutMs ?? 0);
    // The requests' own block (SimulationRequest.at), else this simulator's (a replay's), else the latest.
    const at = reqs[0].at;
    const tag = at?.block ?? this.opts.block?.(chainId) ?? 'latest';
    const source = new StateSource(chainId, url, tag, this.opts.fetchImpl, this.opts.batchSize, this.opts.concurrency, deadline);
    source.historic = !!at?.required;
    source.coldRead = profile.storageGas?.coldRead ?? 2_100;
    if (options?.after?.length && at) {
      const hex = (v: bigint) => `0x${v.toString(16)}`, bumps = new Map<string, (bigint | 'sent')[]>();
      const bump = (a: string, by: bigint | 'sent') => { const l = bumps.get(a) ?? []; l.push(by); bumps.set(a, l); };
      for (const r of options.after) {
        bump(hexOf(r.from), 'sent');
        for (const a of await authorizationsOf(r)) if (a.authority && a.nonce !== undefined && (a.chainId === 0n || a.chainId === BigInt(chainId))) bump(a.authority, a.nonce);
      }
      const toCall = (r: SimulationRequest) => ({ from: r.from, ...(r.to && { to: r.to }), data: r.data, value: hex(r.value), ...(r.gas !== undefined && { gas: hex(r.gas) }), ...priceFields(r),
        ...(r.accessList && { accessList: r.accessList }), ...(r.authorizationList?.length && { authorizationList: authorizationsForNode(r.authorizationList) }) });
      const earlier = options.after;
      source.after = { bumps, ...(at.state && { state: at.state }), blockOverrides: nodeOverrides(at.header), calls: earlier.map(toCall), earlier, fit: async () => { const requests = fitGas(earlier, await at.beforeUsed?.(), at.header.gasLimit); return requests && { requests, calls: requests.map(toCall) }; } };
    }
    // EIP-7702 authorizations are applied as the chain does, before each call; the code overrides standing in for
    // them (for simulators that can't) are left out, so each authority's real code and nonce decide whether it applies.
    const auths = await Promise.all(reqs.map(authorizationsOf));
    const authorities = new Set(auths.flat().map(a => a.authority));
    const slotKey = (a: string, slot: string) => `${hexOf(a)}_${bytesToHex(setLengthLeft(hexToBytes(slot as Hex), 32))}`;
    // What the simulated block had already changed (BlockAt.state: a replay's earlier transactions, from the block's
    // access list): the state this run starts from, beneath anything a request sets.
    for (const [a, o] of Object.entries(at?.state ?? {})) {
      if (o.code !== undefined) source.codeOverrides.set(hexOf(a), hexToBytes(o.code as Hex));
      if (o.balance !== undefined) source.balanceOverrides.set(hexOf(a), BigInt(o.balance));
      if (o.nonce !== undefined) source.nonceOverrides.set(hexOf(a), BigInt(o.nonce));
      for (const [slot, value] of Object.entries(o.stateDiff ?? {})) source.storage.set(slotKey(a, slot), unpadBytes(hexToBytes(value as Hex)));
    }
    for (const r of reqs) for (const [a, o] of Object.entries(r.stateOverrides ?? {})) {
      if (o.code !== undefined && !authorities.has(hexOf(a))) source.codeOverrides.set(hexOf(a), hexToBytes(o.code as Hex));
      if (o.balance !== undefined) source.balanceOverrides.set(hexOf(a), BigInt(o.balance));
      // Storage set for the simulation: read before the chain's value, never cached as the chain's.
      for (const [slot, value] of Object.entries(o.stateDiff ?? {})) source.storage.set(slotKey(a, slot), unpadBytes(hexToBytes(value as Hex)));
    }
    // The senders and targets are certain to be read: fetch them before the first run.
    const first = newMisses();
    for (const r of reqs) { first.accounts.add(hexOf(r.from)); if (r.account) first.accounts.add(hexOf(r.account)); if (r.to) first.accounts.add(hexOf(r.to)); }
    // And what the node says the calls will touch (eth_createAccessList, for the first few), read with them: the
    // local EVM then needs fewer rounds of reads, each a wait on the node, longer where it rate limits. (Not Base's
    // native contracts, whose storage is read their own way after a block's earlier transactions; not a chain whose
    // RPC has no such method, HyperEVM's.)
    // (Both at once: the senders and targets are read while the node is asked, then what it named. Not after a
    // block's earlier transactions, which each read runs again on the node first: there, one read of it all.)
    const together = !!source.after;
    const known = together ? Promise.resolve() : source.fetch(first);
    const listed = this.opts.prefetch === false || NO_ACCESS_LIST.has(chainId) ? (together ? source.fetch(first) : Promise.resolve()) : (async () => {
      const hex = (v: bigint) => `0x${v.toString(16)}`;
      const named = newMisses();
      const lists = await Promise.all(reqs.slice(0, 4).map(r => source.accessList({ from: r.from, ...(r.to && { to: r.to }), data: r.data, value: hex(r.value), ...(r.gas !== undefined && { gas: hex(r.gas) }), ...priceFields(r),
        ...(r.accessList && { accessList: r.accessList }), ...(r.authorizationList?.length && { authorizationList: authorizationsForNode(r.authorizationList) }) })));
      for (const e of lists.flat()) {
        if (!e?.address) continue;
        const a = hexOf(e.address);
        if (chainId === BASE && (B20_PRECOMPILE.test(a) || a in BASE_REGISTRIES || a === B20_FACTORY)) continue;
        if (!first.accounts.has(a)) named.accounts.add(a);
        if (!lowAddress(a)) for (const k of e.storageKeys ?? []) named.storage.add(slotKey(a, k));
      }
      if (together) { for (const a of named.accounts) first.accounts.add(a); for (const k of named.storage) first.storage.add(k); await source.fetch(first); }
      else if (named.accounts.size || named.storage.size) await source.fetch(named);
    })();
    const prefetch = Promise.all([known, listed]);
    const fixed = at?.header ?? this.opts.header?.(chainId);
    const [block, , rules] = await Promise.all([fixed ? { header: { ...fixed, timestamp: at?.header.ownTimestamp ?? fixed.timestamp, ...(at?.header.ownTimestamp !== undefined && at.header.ownMilliseconds !== undefined && { milliseconds: at.header.ownMilliseconds }), coinbase: createAddressFromString(fixed.coinbase), difficulty: 0n, prevRandao: hexToBytes(fixed.prevRandao), getBlobGasPrice: () => fixed.blobBaseFee ?? 1n }, arbBlockNumber: fixed.arbBlockNumber ?? fixed.number, amsterdam: fixed.amsterdam }
      : this.blockContext(source, tag, profile), prefetch, this.rulesOf(chainId, source)]);
    // Ethereum's past blocks run under the rules of their time; every other chain's under today's (see rulesNote).
    // A block of Amsterdam's (Glamsterdam: its header says so) runs Amsterdam's rules, on Ethereum and its testnet.
    const amsterdam = ETHEREUM_RULES.has(chainId) && !!block.amsterdam;
    const hardfork = amsterdam ? 'amsterdam' : chainId === 1 && at?.required ? mainnetForkAt(at.header, profile.hardfork) : profile.hardfork;
    if (hardfork !== profile.hardfork) profile = { ...profile, hardfork };
    const common = createCustomCommon({ chainId }, Mainnet, { hardfork: profile.hardfork as never, ...(profile.eips && { eips: profile.eips }) });
    source.time = block.header.timestamp;
    // Precompiles the node lists that this EVM neither has nor forwards (Base's own since November 2026): refused.
    const own = getActivePrecompiles(common), forwards = new Set((profile.forwardedPrecompiles ?? []).map(hexOf));
    // (The chain's own precompiles a fork adds the local EVM has on both sides of it, an empty account before: none
    // is refused, whatever the node's current fork lists.)
    for (const p of profile.timedPrecompiles ?? []) forwards.add(p.address);
    for (const [address, name] of rules?.precompiles ?? []) if (!own.has(address.slice(2)) && !forwards.has(address) && !hasReference(chainId, address)) source.nodeOnly.set(address, name);
    const rulesNote = rulesNoteOf(chainId, profile, rules, at);
    // Tokens and approvals to read around each call: those the calls name (targets, calldata, decoder hints) and the
    // chain's well-known tokens, then those the logs reveal. Named ones matter: WETH-style wrappers emit Deposit and
    // Withdrawal, not Transfer, so logs alone miss the wrapped token.
    const skip = (a: string) => reqs.some(r => hexOf(r.from) === a || (r.account && hexOf(r.account) === a)) || a === ZERO || BigInt(a) < 0x10000n;
    const tokens = new Set<string>((this.opts.watchTokens ? [
      ...reqs.flatMap(r => [...(r.watch ?? []), ...(r.to ? [r.to] : []), ...calldataCandidates(r.data).addresses]).map(hexOf).slice(0, 40),
      ...builtinTokens(chainId).map(t => hexOf(t.address)),
    ] : reqs.flatMap(r => r.watch ?? []).map(hexOf)).filter(a => !skip(a)));
    const approvals = new Map<string, SimulatedApproval>();
    const key = requestKey(reqs);
    this.seen.set(key, new Set());
    try {
      const results = await this.rounds(reqs, auths, source, common, block, profile, tokens, approvals, chainId, started, deadline, key, options?.reportedFrom ?? 0);
      // Contracts the node runs itself that ran here from their references instead: said, with each result.
      return results.map(r => {
        const stale = r.standIns?.filter(a => source.staleNative.has(a)) ?? [];
        return rulesNote || stale.length ? { ...r, ...(rulesNote && { rulesNote }), ...(stale.length && { standInsStale: stale }) } : r;
      });
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
    profile: ChainProfile, tokens: Set<string>, approvals: Map<string, SimulatedApproval>, chainId: number, started: number, deadline: number, key: string, reportedFrom = 0): Promise<SimulationResult[]> {
    let watched = 0, answer: Awaited<ReturnType<ForkSimulator['run']>> | undefined;
    for (let round = 1; ; round++) {
      const misses = round <= this.opts.maxRounds ? newMisses() : null;
      let run: Awaited<ReturnType<ForkSimulator['run']>>;
      try {
        run = await this.run(reqs, auths, source, misses, common, block, profile, tokens, approvals, chainId);
      } catch (e) {
        // (An extra run, with a later-seen token watched, out of time: the answer it was to improve stands.)
        if (e instanceof ForkTimeout && answer) {
          this.last = { rounds: round - 1, requests: source.requests, ms: Date.now() - started, ...(answer.trace && { trace: answer.trace }) };
          return answer.results;
        }
        if (e instanceof ForkTimeout || e instanceof ForkUnsupported || !misses || !missCount(misses)) throw e;
        run = undefined as never; // a speculative run broke on made-up values: fetch what it asked for and retry
      }
      const grew = !!run && run.rerun;
      if (misses) this.opts.onRound?.(round, { accounts: [...misses.accounts], storage: [...misses.storage], calls: [...misses.calls] }, grew);
      // Past the speculative rounds a run fetches what it lacks as it goes, and is the answer, unless a later call
      // showed a token or approval it wasn't watching: its amount would be its logs' (a lending pool's debt token,
      // whose mint event adds the interest accrued before; Arbitrum One, 2026-11-12, after 24 rounds). Run again
      // with them watched, twice at most, and only within the time budget (past it, this answer stands).
      // (Not for what only a block's earlier transactions showed, run for their state: their results aren't wanted.)
      if (run && !misses && grew && run.grewAt.some(i => i >= reportedFrom) && watched < 2 && Date.now() <= deadline) {
        watched++;
        answer = run;
        for (const t of run.tokens) { tokens.add(t); this.seen.get(key)?.add(t); }
        for (const a of run.approvals) approvals.set(approvalKey(a), a);
        continue;
      }
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
      gasLimit: next.gasLimit > GAS ? next.gasLimit : GAS, baseFeePerGas: next.baseFeePerGas, getBlobGasPrice: () => 1n, ...(next.slotNumber !== undefined && { slotNumber: next.slotNumber }), ...(next.milliseconds !== undefined && { milliseconds: next.milliseconds }) }, arbBlockNumber: next.arbBlockNumber ?? next.number, amsterdam: next.amsterdam };
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
      if (profile.arbitrum && address === ARBOS[0] && bytesToHex(input.data.subarray(0, 4)) === '0xa3b1b31d') return { executionGasUsed: profile.precompileGas?.(4, 32, '0xa3b1b31d') ?? 2000n, returnValue: hexToBytes(`0x${block.arbBlockNumber.toString(16).padStart(64, '0')}`) };
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
      const gas = address === POINT_EVALUATION ? profile.pointEvaluationGas ?? 50_000n : profile.precompileGas?.(input.data.length, c.data.length, bytesToHex(input.data.subarray(0, 4))) ?? 2000n;
      // (Given less than it costs, it runs out, as the node's does.)
      if (gas > input.gasLimit) return { executionGasUsed: input.gasLimit, returnValue: new Uint8Array(0), exceptionError: new EVMError(EVMError.errorMessages.OUT_OF_GAS) };
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
    // (Base's factory or a registry moved away: their references run at their own addresses only, so refused. A
    // token moved away is ignored, as on the node: it isn't one of the chain's precompiles there.)
    const away = chainId === BASE ? reqs.flatMap(r => Object.entries(r.stateOverrides ?? {})).find(([a, o]) => o.movePrecompileToAddress && (hexOf(a) === B20_FACTORY || hexOf(a) in BASE_REGISTRIES)) : undefined;
    if (away) throw new ForkUnsupported(`${hexOf(away[0])} is one of Base's own contracts, which the local EVM runs from its Solidity reference at its own address only: it can't be moved for the simulation`);
    const moved = reqs.flatMap(r => Object.entries(r.stateOverrides ?? {})).flatMap(([a, o]) => {
      const fn = o.movePrecompileToAddress ? active.get(hexOf(a).slice(2)) : undefined;
      return fn ? [{ address: hexOf(a) as Hex }, { address: hexOf(o.movePrecompileToAddress!) as Hex, function: fn }] : [];
    });
    // A chain without the point-evaluation precompile has an ordinary empty account at 0x0a.
    const absent = profile.noPointEvaluation && active.has(POINT_EVALUATION.slice(2)) ? [{ address: POINT_EVALUATION as Hex }] : [];
    // Precompiles the chain charges a multiple of Ethereum's price for (ChainProfile.precompileScale): the EVM's own,
    // its gas multiplied, and out of gas where the multiple is more than the call was given.
    const scaled = Object.entries(profile.precompileScale ?? {}).flatMap(([a, by]) => {
      const key = a.padStart(40, '0'), fn = active.get(key);
      return fn ? [{ address: `0x${key}` as Hex, function: async (input: Parameters<typeof fn>[0]) => {
        const r = await fn(input);
        if (r.exceptionError) return r;
        const gas = r.executionGasUsed * by;
        return gas <= input.gasLimit ? { ...r, executionGasUsed: gas } : { executionGasUsed: input.gasLimit, returnValue: new Uint8Array(0), exceptionError: new EVMError(EVMError.errorMessages.OUT_OF_GAS) };
      } }] : [];
    });
    // The chain's own precompiles a fork added, as of the block's time (ChainProfile.timedPrecompiles).
    const timed = timedPrecompilesAt(profile, block.header.timestamp).map(p => ({ address: p.address as Hex, function: async (input: { gasLimit: bigint }) =>
      p.gas > input.gasLimit ? { executionGasUsed: input.gasLimit, returnValue: new Uint8Array(0), exceptionError: new EVMError(EVMError.errorMessages.OUT_OF_GAS) }
        : { executionGasUsed: p.gas, returnValue: p.answer({ timestamp: block.header.timestamp, milliseconds: block.header.milliseconds ?? 0n }) } }));
    const precompiles = [...scaled, ...timed, ...forwarded, ...moved, ...absent];
    const evm: EVM = await createEVM({ common, stateManager: state, customPrecompiles: precompiles, blockchain, ...storagePricing(profile) });
    // What a cleared slot gives back reaches the caller that paid for it, as on the chain (see repayCallers).
    const gasBack = profile.hardfork === 'amsterdam' ? repayCallers(evm) : undefined;
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
    // Base's B20 tokens run here from their Solidity references, whose code costs gas the node's doesn't: the node
    // charges a token's call 100 and 6 a word of its input, then what its storage reads and writes and its events
    // cost (cold or warm, as an EVM's), the policy registry's storage it reads included, and nothing for computation
    // or for asking the registry (measured on Base: name() 2,206, balanceOf 2,212, a transfer 37,374). So the call
    // is given gas to spare, and charged what the node would: the SLOADs, SSTOREs and LOGs it runs (those of the
    // registry's reference under it included) and its precompiles' gas, on top of that 100 and 6 a word. Without
    // this, a transaction given just the gas it needed on the chain ran out locally (2 of 66). The registries and the
    // factory, called themselves, are charged so too, without the 100 (B20_EXISTS_GAS). A call whose charge passes
    // the gas it was given runs out there, as the node's.
    type Charge = { code: string; limit: bigint; node: bigint; refused?: boolean; selector?: Uint8Array; looked?: boolean; hashed?: boolean; static?: boolean; hevmCold?: boolean;
      /** The token the factory's reference etched in this creation, whose bootstrap window it opened (BOOTSTRAP_KEY). */ created?: Address };
    /** A token's own call (not run as another's code, not refused): what is charged by its function (B20_WRITE_GAS, EIP-712). */
    type TokenCall = { code: string; caller: string; depth: number; selector: string; data: Uint8Array; eip712?: boolean; verified?: boolean; written?: boolean; ended?: boolean; sloads: number; stored: Set<bigint>; topics: Set<bigint>;
      /** The factory's call in its creation of the token (the bootstrap window: BOOTSTRAP_KEY), as its init calls are. */ bootstrap?: boolean;
      /** A multiplier view's first read of the pending slot (MULTIPLIER_VIEWS): its value on the stack at the next step, then seen. */ pending?: 'reading' | 'seen' };
    let charging: Charge | undefined;
    /** Each message's bookkeeping, popped as it ends: the charge it opened, a precompile, a token's own call. */
    const opened: { charge?: Charge; precompile?: boolean; token?: TokenCall; static?: boolean }[] = [];
    const tokenCalls: TokenCall[] = [];
    // The contracts the node runs itself that the request being run reached (SimulationResult.standIns).
    const reached = new Set<string>();
    const warmIn = (token: string) => (slot: bigint) => evm.journal.isWarmedStorage(hexToBytes(token as Hex), hexToBytes(`0x${slot.toString(16).padStart(64, '0')}`));
    source.preimages.set(ADMIN_FLAGS.slot, ADMIN_FLAGS.preimage);
    /** The token's mapping of mappings (B20_LAYOUT + n) a slot is an entry of, by its preimages (StateSource.preimages). */
    const nestedIn = (slot: bigint) => {
      const p = source.preimages.get(`0x${slot.toString(16).padStart(64, '0')}`), outer = p && source.preimages.get(bytesToHex(p.subarray(32)));
      return outer ? BigInt(bytesToHex(outer.subarray(32))) - B20_LAYOUT : undefined;
    };
    // EIP-2200's sentry: the node's write fails, out of gas, with 2,300 gas or less left, what the call was given less
    // what it has charged before the write (measured on Base, with a stipend each side of it: a write that costs 100
    // and is followed by less than 2,201 of events or writes, as a second transfer, approve, mint, burn, permit, pause,
    // grant or revoke in a transaction is, runs out where the reference, on spare gas, didn't), in a token's own
    // writes, its init calls, announce's and the registries' alike; in a static call the write fails first.
    const sentry = (charged: bigint) => {
      if (charging && charging.limit - charged <= SSTORE_SENTRY) { charging.node = charging.limit + 1n; throw new EVMError(EVMError.errorMessages.OUT_OF_GAS); }
    };
    const chargeStep = (e: { opcode: { name: string; fee: number; dynamicFee?: bigint }; stack?: bigint[]; memory?: Uint8Array; address?: Address; depth?: number }, next?: () => void) => {
      // (Less 375 an event: the step's dynamic fee counts LOG's base again. The node charges an event as an EVM's LOG.)
      const fee = charging && NATIVE_CHARGED.has(e.opcode.name) ? BigInt(e.opcode.fee) + (e.opcode.dynamicFee ?? 0n) - (e.opcode.name.startsWith('LOG') ? 375n : 0n) : 0n;
      if (charging) charging.node += fee;
      const at = e.address?.toString(), top = e.stack?.length ? `0x${e.stack[e.stack.length - 1].toString(16).padStart(40, '0')}` : '';
      if (charging?.code === B20_FACTORY && at === B20_FACTORY) {
        const selector = charging.selector ? bytesToHex(charging.selector) : '';
        // The factory reading an account, warm or cold as EIP-2929 prices it: whether the token to create exists
        // (once: the reference looks again before it calls the token, for its admin), or isB20Initialized's.
        if (e.opcode.name === 'EXTCODESIZE' && B20.test(top) && (selector === IS_B20_INITIALIZED || (!charging.looked && B20_PRECOMPILE.test(top)))) {
          charging.node += BigInt(e.opcode.fee) + (e.opcode.dynamicFee ?? 0n);
          if (selector !== IS_B20_INITIALIZED) charging.looked = true;
        }
        // getB20Address working out the address (B20_ADDRESS_GAS); createB20 is charged it as it asks the registry.
        if (e.opcode.name === 'KECCAK256' && selector === GET_B20_ADDRESS && !charging.hashed) { charging.node += B20_ADDRESS_GAS; charging.hashed = true; }
      }
      const t = tokenCalls.at(-1), own = !!t && e.depth === t.depth && at === t.code;
      // A permit's or the domain separator's hashing, in the token's own frame (EIP712_FUNCTIONS): any hash of
      // memory past Solidity's scratch space, where a slot's is found (a 32- or 64-byte hash at offset 0).
      if (charging && own && t.eip712 && e.opcode.name === 'KECCAK256' && e.stack) {
        const length = e.stack[e.stack.length - 2], offset = e.stack[e.stack.length - 1];
        if (offset >= 0x40n || (length !== 32n && length !== 64n)) charging.node += 30n + 6n * ((length + 31n) / 32n);
      }
      // A permit whose signature verified: the node writes the nonce, and reads it again (PERMIT_VERIFIED_GAS),
      // whatever follows (spender 0, a static call); the reference's first write is its nonce's.
      if (charging && own && t.selector === PERMIT && !t.verified && e.opcode.name === 'SSTORE') { charging.node += PERMIT_VERIFIED_GAS; t.verified = true; }
      // The function's own correction at its first write (B20_WRITE_GAS), and what its frame reads, writes and logs
      // (B20_ENDED_GAS); updateUIMultiplier writing the multiplier itself (a pending update that took effect) reads
      // it once more on the node.
      if (charging && own && e.opcode.name === 'SSTORE' && !t.written) { t.written = true; const fix = B20_WRITE_GAS[t.selector]; if (fix) charging.node += fix(t.data, t); }
      if (charging && e.opcode.name === 'SSTORE' && e.stack?.length) {
        const mapping = nestedIn(e.stack[e.stack.length - 1]);
        // A role's flag written (ROLES_AT; in a static call too, where the write fails): renounceLastAdmin reads once
        // more than the reference before it (a static one is charged the reference's reads), and again after.
        if (own && mapping === ROLES_AT && t.selector !== RENOUNCE_LAST_ADMIN) charging.node -= 100n;
        // The policy registry's first creation marking it initialized as it writes its built-in policies
        // (REGISTRY_INITIALIZED_GAS): in a creation only, since renounceAdmin or finalizeUpdateAdmin of policy 0
        // (from address 0, or with a state override) writes the same slot, and the node charges them nothing more.
        if (at === POLICY_REGISTRY && charging.code === POLICY_REGISTRY && charging.selector && POLICY_CREATIONS.has(bytesToHex(charging.selector))
          && e.stack[e.stack.length - 1] === ALWAYS_ALLOW_POLICY && !opened.at(-1)?.static) charging.node += REGISTRY_INITIALIZED_GAS;
        // The sentry (above), as of the charge before this write, with what this step stands for before it: a
        // function's first-write correction, a verified permit's read of its nonce, a role's flag read once, the
        // policy registry marked initialized. (The
        // allowance transferFrom spends, the reference, patched, writes where the node does: after the transfer and
        // its Transfer event, before transferFromWithMemo's Memo; see scripts/build-b20.ts.)
        if (!opened.at(-1)?.static) sentry(charging.node - fee);
      }
      // batchMint: 100 more a recipient, as each is reached (its mint asks the policy registry), the refused one too.
      if (charging && own && t.selector === '0x68573107' && e.opcode.name === 'STATICCALL' && e.stack && `0x${e.stack[e.stack.length - 2].toString(16).padStart(40, '0')}` === '0x8453000000000000000000000000000000000002') charging.node += 100n;
      // renounceLastAdmin: 100 over the reference, the rest of it (with its flag's write, ROLES_AT) at its RoleRevoked: a
      // static call, whose write fails, is charged none of it.
      if (charging && own && t.selector === RENOUNCE_LAST_ADMIN && e.opcode.name === 'LOG4' && e.stack && ROLE_EVENTS.has(e.stack[e.stack.length - 3])) charging.node += 100n;
      // A multiplier view taking the pending update's multiplier (MULTIPLIER_VIEWS): the node's read of the pending
      // slot again, as the reference has read it (the value it read on the stack now).
      if (charging && own && t.pending === 'reading' && e.stack?.length) { t.pending = 'seen'; if (takesPending(t.selector, e.stack[e.stack.length - 1], block.header.timestamp)) charging.node += 100n; }
      if (own && e.stack?.length) {
        const top = e.stack[e.stack.length - 1];
        if (e.opcode.name === 'SLOAD' && top === ASSET_PENDING && !t.pending && (MULTIPLIER_VIEWS.has(t.selector) || t.selector === NEW_UI_MULTIPLIER)) t.pending = 'reading';
        if (e.opcode.name === 'SLOAD') t.sloads++;
        else if (e.opcode.name === 'SSTORE') { if (charging && t.selector === '0x628e600f' && top === ASSET_MULTIPLIER && !t.stored.has(top)) charging.node += 100n; t.stored.add(top); }
        else if (e.opcode.name.startsWith('LOG') && e.opcode.name !== 'LOG0' && e.stack.length >= 3) t.topics.add(e.stack[e.stack.length - 3]);
      }
      // A success's end-of-call extra (B20_ENDED_GAS) as the frame returns, within its gas: given less, it runs out
      // there, its writes undone, as on the node.
      if (charging && own && !t.ended && (e.opcode.name === 'RETURN' || e.opcode.name === 'STOP')) {
        t.ended = true;
        const ended = B20_ENDED_GAS[t.selector];
        if (ended) charging.node += ended({ ok: true, returned: new Uint8Array(0), sloads: t.sloads, stored: t.stored, topics: t.topics, data: t.data, warm: warmIn(t.code) });
      }
      // A mapping's slot being found: kept, to read it after a block's earlier transactions (StateSource.preimages).
      if (e.opcode.name === 'KECCAK256' && e.stack && e.memory) {
        const n = e.stack.length, offset = Number(e.stack[n - 1]);
        if (e.stack[n - 2] === 64n && offset + 64 <= e.memory.length) { const p = e.memory.slice(offset, offset + 64); source.preimages.set(keccak256(p), p); }
      }
      if (charging && charging.node > charging.limit) throw new EVMError(EVMError.errorMessages.OUT_OF_GAS);
      next?.();
    };
    if (chainId === BASE) evm.events!.on('afterMessage', (r: { execResult: { executionGasUsed: bigint; returnValue: Uint8Array; exceptionError?: EVMError } }, next?: () => void) => {
      const o = opened.pop();
      if (o?.precompile && charging) charging.node += r.execResult.executionGasUsed;
      if (o?.token) {
        tokenCalls.pop();
        const ended = B20_ENDED_GAS[o.token.selector];
        // (Warmth seen as the call ends: a failed frame's own reads are undone by then, so it is what the node met.)
        if (ended && charging && !o.token.ended) charging.node += ended({ ok: !r.execResult.exceptionError, returned: r.execResult.returnValue, sloads: o.token.sloads, stored: o.token.stored, topics: o.token.topics, data: o.token.data, warm: warmIn(o.token.code) });
      }
      const c = o?.charge;
      if (c) {
        evm.events!.removeListener('step', chargeStep);
        charging = undefined;
        const ex = r.execResult;
        // (A stablecoin's currency the factory's reference checks before the write the node charges first; in a
        // static call the node's write fails first, with nothing to say.)
        if (c.code === B20_FACTORY && ex.exceptionError?.error === EVMError.errorMessages.REVERT) {
          const extra = B20_PARAM_ERRORS[bytesToHex(ex.returnValue.subarray(0, 4))];
          if (extra !== undefined && c.static) { ex.returnValue = new Uint8Array(0); c.refused = true; }
          else if (extra !== undefined) c.node += extra;
          // (Given less than that, it runs out on the node before its check: no data.)
          if (c.node > c.limit) { ex.exceptionError = new EVMError(EVMError.errorMessages.OUT_OF_GAS); ex.returnValue = new Uint8Array(0); }
        }
        // What was added as the call ended (a precompile's gas, a failed function's correction) can take it past
        // the gas it was given: it runs out, as on the node.
        if (c.node > c.limit && ex.exceptionError?.error !== EVMError.errorMessages.OUT_OF_GAS) { ex.exceptionError = new EVMError(EVMError.errorMessages.OUT_OF_GAS); ex.returnValue = new Uint8Array(0); }
        // (The cheatcode address, which only the factory's reference calls, cold again, as it is on the chain.)
        if (c.hevmCold) (evm.journal as unknown as { journal: Map<string, unknown> }).journal.delete(HEVM.slice(2));
        // (The created token's bootstrap window closed as the creation ends: undone with it where it failed.)
        if (c.created) evm.transientStorage.put(c.created, BOOTSTRAP_KEY, new Uint8Array(32));
        if (c.refused || source.standIns.has(c.code)) ex.executionGasUsed = c.node < c.limit ? c.node : c.limit;
        // Calldata a function can't decode: the chain reverts with the call's selector (4 zero bytes for calldata
        // shorter than one), the reference empty (its only empty revert: base-std's references revert with an
        // error everywhere else) or, for the factory's params, with Panic(0x41). Measured on Base: transfer and
        // approve short of an argument, or with an address's upper bytes set, balanceOf with none; the registries
        // and the factory given under four bytes; the gas the same either way.
        if (c.selector && !c.refused && source.standIns.has(c.code) && ex.exceptionError?.error === EVMError.errorMessages.REVERT
          && (ex.returnValue.length === 0 || (c.code === B20_FACTORY && bytesToHex(ex.returnValue) === PANIC_ALLOCATION))) ex.returnValue = c.selector;
      }
      next?.();
    });
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
            // (What a reference calls is left out of the tree, below: its events are the token's or the factory's.)
            if (parent && !(chainId === BASE && !!parent.call.to && baseNative(parent.call.to))) for (const l of ex.logs ?? []) parent.under.add(l);
          }
          // What a B20 token's reference calls (the registries, whose storage the node's token reads itself; ecrecover
          // for a permit, which it recovers natively; announce's calls to itself), what Base's factory calls (the
          // registry, the token it creates, the cheatcodes it writes the token with) and what the policy registry's
          // writes ask (the activation registry, whose flag the node's registry reads itself) are left out of the
          // tree: the chain's trace is one call whose events are all there, its gas the node's.
          const underNative = !!parent && chainId === BASE && !!parent.call.to && baseNative(parent.call.to);
          if (parent && !underNative) (parent.call.calls ??= []).push(f.call);
          else if (!parent) root = f;
        }
        next?.();
      });
    }
    type BaseMessage = { to?: Address; _codeAddress?: Address; caller: Address; data: Uint8Array; value: bigint; gasLimit: bigint; isCompiled: boolean; isStatic: boolean; depth: number; code?: unknown };
    const onBaseMessage = async (m: BaseMessage) => {
      // The factory's reference writing a new token (vm.etch, vm.store; vm.load reads): answered as the chain's
      // factory writes it, in the token's own account. Its code becomes the chain's marker, and a store is an
      // SSTORE run in the token's storage, so it is priced as one, cold or warm, as chargeStep counts it. (The
      // reference alone: a transaction sent from the factory's address to the cheatcodes' finds an empty account.)
      if (m.to?.toString() === HEVM && m.caller.toString() === B20_FACTORY && charging?.code === B20_FACTORY && m.data.length >= 68) {
        const word = (i: number) => m.data.subarray(4 + 32 * i, 36 + 32 * i), at = createAddressFromString(bytesToHex(word(0).subarray(12)));
        const selector = bytesToHex(m.data.subarray(0, 4));
        if (selector === '0xb4d6c782' && m.isStatic) {
          // (A creation in a static call: the node's write fails, with no data, charged what came before.)
          m.code = NO_TOKEN;
          if (charging?.code === B20_FACTORY) charging.refused = true;
        } else if (selector === '0xb4d6c782') { // etch(address,bytes)
          const offset = 4 + Number(BigInt(bytesToHex(word(1)))), length = Number(BigInt(bytesToHex(m.data.subarray(offset, offset + 32))));
          await state.putCode(at, m.data.slice(offset + 32, offset + 32 + length));
          // (Writing the token: B20_CREATED_GAS, charged here so that a creation short of it runs out, as the node's.)
          if (charging?.code === B20_FACTORY) charging.node += B20_CREATED_GAS[at.toString().slice(22, 24)] ?? 0n;
          // (Its bootstrap window opened to the factory's calls, for the rest of this creation: BOOTSTRAP_KEY.)
          evm.transientStorage.put(at, BOOTSTRAP_KEY, BOOTSTRAP_OPEN);
          if (charging) charging.created = at;
          // (An asset's multiplier, which the node writes as it creates one, is warm for the rest of the transaction:
          // an init call that reads it pays 100, not 2,100.)
          if (at.toString().slice(22, 24) === '00') evm.journal.addWarmedStorage(at.bytes, hexToBytes(`0x${ASSET_MULTIPLIER.toString(16).padStart(64, '0')}`));
          m.code = RETURN_ONE;
        } else if (selector === '0x70ca10bb') { // store(address,bytes32,bytes32)
          m.to = at; m._codeAddress = at;
          m.code = new Uint8Array([0x7f, ...word(2), 0x7f, ...word(1), 0x55, ...RETURN_ONE]);
        } else if (selector === '0x667f9d70') { // load(address,bytes32)
          m.code = new Uint8Array([0x7f, ...setLengthLeft(await state.getStorage(at, word(1)), 32), 0x60, 0x00, 0x52, 0x60, 0x20, 0x60, 0x00, 0xf3]);
        }
        opened.push({});
        return;
      }
      const code = (m._codeAddress ?? m.to)?.toString();
      // The chain's B20 tokens and registries refuse to run as another contract's code (DELEGATECALL, CALLCODE):
      // DelegateCallNotAllowed(), charging that frame nothing. (A token's own calls to itself, announce's, run.) Sent value, they refuse it
      // before anything else, whatever the function, with NonPayable(), and the node charges the call nothing
      // (measured on Base: a value call's frame used no gas, the token's or a registry's, the calldata's size
      // whatever it was); the references' own functions would revert empty.
      // (Not where a precompile was moved for the simulation: that runs there, as on the node.)
      // (A registry a token's or the factory's reference calls, or the activation registry the policy registry's
      // writes ask, stays the registry, whatever was moved onto its address: on the node those are its own storage
      // reads. Not for a transaction sent from one of these addresses, which only a simulation can send: for it, as
      // for anyone's, the node runs what was moved there.)
      const fromReference = m.depth > 0 && baseNative(m.caller.toString());
      const native = !!code && baseNative(code) && (!evm.precompiles.has(code.slice(2)) || (code in BASE_REGISTRIES && fromReference));
      const delegated = native && !!m.to && m.to.toString() !== code, refused = native && !delegated && m.value > 0n;
      if (delegated) m.code = NO_DELEGATECALL;
      else if (refused) m.code = NON_PAYABLE;
      // A token's address with no token yet (variant 00 or 01): the node reverts with no data and charges what it
      // charges any call (measured: decimals() there 21,170 gas in all).
      let empty = false;
      if (!delegated && !refused && native) { const ref = await standInFor(state, chainId, code!, source.time); if (ref) { m.code = ref; source.standIns.add(code!); } else if (B20_PRECOMPILE.test(code!) && (await state.getCode(createAddressFromString(code!))).length === 0) { m.code = NO_TOKEN; empty = true; } }
      if (native) reached.add(code!);
      // createB20 working out the token's address (B20_ADDRESS_GAS): after its arguments decode, as it asks the
      // activation registry, before its parameters' version and decimals are checked.
      if (charging?.code === B20_FACTORY && !charging.hashed && code === ACTIVATION_REGISTRY && m.caller.toString() === B20_FACTORY) { charging.node += B20_ADDRESS_GAS; charging.hashed = true; }
      // A token's own call, for what its function is charged (B20_WRITE_GAS, EIP-712), wherever it runs.
      const selector = m.data.length >= 4 ? bytesToHex(m.data.subarray(0, 4)) : '';
      // A bool argument (BOOL_ARGUMENTS) the node decodes as any word with its upper 31 bytes zero, true if its last
      // isn't, where the reference's decoder takes 0 and 1 alone: run as 1 (the trace's input is the call's as sent).
      if (native && !delegated && !refused && code === POLICY_REGISTRY && BOOL_ARGUMENTS.has(selector) && m.data.length >= 68 && m.data[67] > 1 && m.data.subarray(36, 67).every(b => b === 0)) {
        const data = m.data.slice();
        data[67] = 1;
        m.data = data;
      }
      const token: TokenCall | undefined = native && !delegated && !refused && !empty && B20_PRECOMPILE.test(code!)
        ? { code: code!, caller: m.caller.toString(), depth: m.depth, selector, data: m.data, sloads: 0, stored: new Set(), topics: new Set(), ...(EIP712_FUNCTIONS.has(selector) && { eip712: true }),
          ...(m.caller.toString() === B20_FACTORY && evm.transientStorage.get(createAddressFromString(code!), BOOTSTRAP_KEY)[31] === 1 && { bootstrap: true }) } : undefined;
      if (token) tokenCalls.push(token);
      if (!charging && native) {
        // (Short of a selector, the calldata's echo is four zero bytes.)
        opened.push({ token, charge: charging = { code: code!, limit: m.gasLimit, node: refused || delegated ? 0n : (B20_PRECOMPILE.test(code!) ? 100n : 0n) + 6n * BigInt(Math.ceil(m.data.length / 32)), refused: refused || delegated || empty,
          ...(!empty && { selector: m.data.length >= 4 ? m.data.slice(0, 4) : new Uint8Array(4) }),
          ...(code === B20_FACTORY && { static: m.isStatic, hevmCold: !evm.journal.isWarmedAddress(hexToBytes(HEVM)) }) } });
        m.gasLimit += NATIVE_SPARE_GAS;
        evm.events!.on('step', chargeStep);
      } else opened.push({ token, precompile: !!charging && !!code && !native && (m.isCompiled || evm.precompiles.has(code.slice(2))) });
    };
    // (The message always goes on, with what was found pushed once: a read that fails here, a block before Base's
    // upgrade, fails again as the EVM loads the code, and says why there.)
    if (chainId === BASE) evm.events!.on('beforeMessage', async (m: BaseMessage, next?: () => void) => {
      const before = opened.length;
      try { await onBaseMessage(m); } catch { /* see above */ } finally { if (opened.length === before) opened.push({}); opened.at(-1)!.static = m.isStatic; next?.(); }
    });
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
    // A view (a balance, an allowance) gets 10 million gas: a token whose balanceOf works out what an account holds
    // can take more than a million (Open Genesis, on BNB Chain: 1.37 million), and with less the read fails and the
    // token's events stand, which for that one netted to a unit where the balance went down by 4.56e18.
    const viewOn = async (on: EVM, to: string, data: Hex) => {
      const r = await on.runCall({ caller: createAddressFromString(ZERO), to: createAddressFromString(to), data: hexToBytes(data), gasLimit: 10_000_000n, isStatic: true, block });
      return r.execResult.exceptionError ? undefined : r.execResult.returnValue;
    };
    const view = (to: string, data: Hex) => viewOn(evm, to, data);
    const balanceOf = async (token: string, owner: string) => { const r = await view(token, `0x70a08231${owner.slice(2).padStart(64, '0')}` as Hex); return r ? word(r) : undefined; };
    // The state before the first call is the chain's own: a token its logs reveal can be read there afterwards, on a
    // second EVM, instead of running everything again with the token watched from the start.
    let pre: EVM | undefined;
    const balanceBefore = async (token: string, owner: string) => {
      if (!pre) {
        const preState = new LazyState(source, misses, { common });
        pre = await createEVM({ common, stateManager: preState, customPrecompiles: precompiles, blockchain, ...storagePricing(profile) });
        // (Base's tokens run their references here too: see standInFor.)
        if (chainId === BASE) pre.events!.on('beforeMessage', async (m: { to?: Address; _codeAddress?: Address; code?: unknown }, next?: () => void) => {
          const code = (m._codeAddress ?? m.to)?.toString();
          if (code && m.to?.toString() === code && baseNative(code) && !pre!.precompiles.has(code.slice(2))) { const ref = await standInFor(preState, chainId, code, source.time); if (ref) m.code = ref; }
          next?.();
        });
      }
      const r = await viewOn(pre, token, `0x70a08231${owner.slice(2).padStart(64, '0')}` as Hex);
      return r ? word(r) : undefined;
    };
    const native = async (a: string) => (await state.getAccount(createAddressFromString(a)))?.balance ?? 0n;
    const nft = new Map<string, boolean>();
    const isNft = async (t: string) => {
      if (!nft.has(t)) { const r = await view(t, `0x01ffc9a780ac58cd${'00'.repeat(28)}` as Hex); nft.set(t, !!r && word(r) === 1n); }
      return nft.get(t)!;
    };

    const results: SimulationResult[] = [], byRequest: string[][] = [];
    const seenTokens = new Set<string>(), seenApprovals: SimulatedApproval[] = [];
    // A token or approval first seen in a later call of a batch must be read around the calls before it too.
    let rerun = false;
    const grewAt: number[] = [];
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
      // (An address that isn't a precompile on this chain is an account like any other: cold until touched.)
      for (const a of [caller, target, block.header.coinbase.toString(), ...(chainId === BASE ? [...Object.keys(BASE_REGISTRIES), B20_FACTORY].map(r => r.slice(2)) : []), ...[...evm.precompiles.keys()].filter(k => !absent.some(x => x.address.slice(2) === k))]) evm.journal.addAlwaysWarmAddress(a);
      for (const e of req.accessList ?? []) { evm.journal.addAlwaysWarmAddress(e.address); for (const k of e.storageKeys) evm.journal.addAlwaysWarmSlot(e.address, k); }
      // The sender's nonce goes up first, then the EIP-7702 authorizations apply (and stay, whatever the call does).
      const sender = createAddressFromString(caller);
      const senderAccount = (await state.getAccount(sender)) ?? new Account();
      senderAccount.nonce++;
      await state.putAccount(sender, senderAccount);
      // What the transaction changes is recorded from here: its authorizations' effects (an authority's nonce and
      // code) are its own, as the call's are.
      if (req.trace) state.written = { accounts: new Map(), storage: new Map() };
      // Gas is bought before anything runs: while a transaction runs, its sender's balance is lower by the gas limit
      // at the price paid (and a blob transaction's blob gas at the block's price), and what isn't used comes back
      // after. A contract that reads the sender's balance sees it so: one on Sepolia stores it, and the trace's
      // slot came out 0.0024 ETH higher than the block's access list has it. Taken out here and put back whole
      // after the call, so what the run reports stays the call's own (fees are counted apart). Only for a run
      // given both a gas limit and a price, and a sender that can pay: a replay, a preview's priced run.
      let bought = 0n;
      if (req.gas !== undefined && req.gasPrice) {
        const blobs = BigInt(req.blobVersionedHashes?.length ?? 0) * 131_072n * (req.at?.header.blobBaseFee ?? 1n);
        const upfront = req.gas * req.gasPrice + blobs, account = await state.getAccount(sender);
        if (account && account.balance >= upfront + req.value) { account.balance -= upfront; await state.putAccount(sender, account); bought = upfront; }
      }
      const authorized = await this.authorize(state, evm, auths[i], chainId, caller);
      // Amsterdam charges an applied authorization for the state it adds, out of the transaction's gas, not as a refund.
      const authRefund = profile.hardfork === 'amsterdam' ? 0n : authorized.refund, authState = profile.hardfork === 'amsterdam' ? authorized.state : 0n;
      // (Arbitrum: less the gas the chain took for the transaction's L1 data before running it, where it is known.)
      let gasLimit = req.gas ? req.gas - intrinsicGas(req, profile.hardfork === 'amsterdam').intrinsic - authState - (profile.arbitrum ? req.gasForL1 ?? 0n : 0n) : GAS;
      // Amsterdam meters new state apart from the rest (EIP-8037). What a transaction's gas limit holds over the cap
      // on ordinary gas (EIP-7825's 16,777,216, less what it pays before its call) is a reservoir for state alone;
      // state gas is drawn from it first, then from the call's gas, and state gas given back (a slot set and cleared
      // again) goes to it. The EVM keeps these per transaction: set afresh here, as the library's own transaction
      // runner does, and what the reservoir gained or lost is settled after the call. Left as they were, one call's
      // refund paid for the next call's new slots.
      const metered = profile.hardfork === 'amsterdam' ? evm as unknown as StateGas : undefined;
      let reservoir = 0n;
      if (metered) {
        const budget = REGULAR_GAS_CAP - intrinsicGas(req, true).intrinsic;
        if (req.gas && gasLimit > budget) { reservoir = gasLimit - budget; gasLimit = budget; }
        if (gasBack) gasBack.pool = 0n;
        Object.assign(metered, { stateGasReservoir: reservoir, executionStateGasUsed: 0n, eip2780PrepOog: false, eip7928CallPostTargetOog: false, _stateGasSnapshots: [], createdAccountStateGas: new Map(), createdAccountIntrinsicStateGas: new Map() });
      }
      callIndex = i;
      recording = true;
      // (A run that stopped inside a B20 token's call leaves nothing behind for this one.)
      if (charging) { evm.events!.removeListener('step', chargeStep); charging = undefined; }
      opened.length = 0; reached.clear();
      const res = await evm.runCall({ caller: sender, origin: sender, ...(req.to && { to: createAddressFromString(req.to) }), skipNonceIncrement: true,
        data: hexToBytes(req.data as Hex), value: req.value, gasLimit: gasLimit > 0n ? gasLimit : 0n, gasPrice: req.gasPrice ?? 0n, block, ...(req.blobVersionedHashes?.length && { blobVersionedHashes: req.blobVersionedHashes as Hex[] }) });
      recording = false;
      byRequest[i] = [...reached];
      if (bought) { const account = (await state.getAccount(sender)) ?? new Account(); account.balance += bought; await state.putAccount(sender, account); }
      const ex = res.execResult;
      const traced = req.trace ? { trace: traceOf(ex.logs ?? []), stateChanges: await changesOf() } : undefined;
      // What the call spent, and under Amsterdam what its state took from the reservoir (less what it gave back to it).
      const spent = ex.executionGasUsed + authState + (metered ? reservoir - metered.stateGasReservoir : 0n);
      const gasUsed = transactionGas(req, spent > 0n ? spent : 0n, (ex.gasRefund ?? 0n) + authRefund, !BEFORE_PRAGUE.has(profile.hardfork), profile.hardfork === 'amsterdam');
      // The fee itself is paid once everything this call reports has been read: the calls after it in the batch are
      // the transactions after it, and meet a sender that has paid (the gas used at its price) and a fee recipient
      // that has been tipped (the price over the base fee), as on the chain.
      const settle = async () => {
        if (!bought || !req.gasPrice) return;
        const paid = gasUsed * req.gasPrice + (bought - req.gas! * req.gasPrice), base = (block.header as { baseFeePerGas?: bigint }).baseFeePerGas ?? 0n;
        const payer = (await state.getAccount(sender)) ?? new Account();
        payer.balance = payer.balance > paid ? payer.balance - paid : 0n;
        await state.putAccount(sender, payer);
        const tip = req.gasPrice > base ? gasUsed * (req.gasPrice - base) : 0n;
        const to = profile.arbitrum ? undefined : profile.tipsTo ? createAddressFromString(profile.tipsTo) : block.header.coinbase;
        if (tip > 0n && to) { const recipient = (await state.getAccount(to)) ?? new Account(); recipient.balance += tip; await state.putAccount(to, recipient); }
      };
      if (ex.exceptionError) {
        const data = bytesToHex(ex.returnValue) as Hex;
        await settle();
        results.push({ status: 'reverted', source: source_, gasUsed, revertReason: ex.exceptionError.error === 'revert' ? decodeRevert(data) : ex.exceptionError.error, transfers: [], basis: 'fork', returnData: data,
          // A call that fails changes nothing itself; the transaction's authorizations (EIP-7702) stay as applied.
          ...(traced?.trace && { trace: traced.trace, ...(traced.stateChanges.length && { stateChanges: traced.stateChanges }) }) });
        continue;
      }
      const logs = (ex.logs ?? []).map(([address, topics, data]) => ({ address: bytesToHex(address), topics: topics.map(t => bytesToHex(t)), data: bytesToHex(data) }));
      const parsed = parseLogs(logs);
      // Tokens whose Transfer logs involve the account: read its balance of each, before and after.
      for (const l of logs) if (l.topics[0] === TRANSFER && l.topics.length === 3 && hexOf(l.address) !== NATIVE_LOG_ADDRESS && [l.topics[1], l.topics[2]].some(t => `0x${t.slice(26)}` === from)) {
        const t = hexOf(l.address);
        seenTokens.add(t);
        if (i > 0 && !tokens.has(t)) { rerun = true; grewAt.push(i); }
      }
      for (const a of parsed.approvals) if (a.owner === from) {
        if (i > 0 && !watchedApprovals.has(approvalKey(a))) { rerun = true; grewAt.push(i); }
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
      await settle();
    }
    // Each result with the contracts the node runs itself that its own run reached, of those run from a reference.
    results.forEach((r, i) => { const own = byRequest[i]?.filter(a => source.standIns.has(a)); if (own?.length) r.standIns = own; });
    return { results, tokens: [...seenTokens], approvals: seenApprovals, rerun, grewAt, trace };
  }

  /**
   * Applies EIP-7702 authorizations as the chain does at the start of a transaction: each one for this chain (or
   * every chain) whose authority has no code or a delegation, and whose nonce matches the authority's (checked for
   * signed ones only), sets the authority's code and bumps its nonce. Returns the refund they earn before Amsterdam
   * (12,500 for each whose authority already existed), and what Amsterdam charges an applied one: 9,000 for the
   * first write to the authority's account in the transaction (none for the sender's own, which the transaction
   * has written already, nor for an authority's second authorization); for an authority with no account yet, its
   * 120 bytes; for one not yet delegated, the delegation's 23 bytes; each byte 1,530. Measured on Sepolia: mined
   * transactions by new, existing and delegated authorities, and each case here run on its node.
   */
  private async authorize(state: LazyState, evm: EVM, list: Authorization[], chainId: number, sender: string): Promise<{ refund: bigint; state: bigint }> {
    let refund = 0n, added = 0n;
    const written = new Set([sender]);
    for (const a of list) {
      if (!a.authority || (a.chainId !== 0n && a.chainId !== BigInt(chainId))) continue;
      const who = createAddressFromString(a.authority);
      evm.journal.addAlwaysWarmAddress(a.authority);
      const code = await state.getCode(who);
      if (code.length && !isDelegation(code)) continue;
      const account = await state.getAccount(who);
      if (a.nonce !== undefined && (account?.nonce ?? 0n) !== a.nonce) continue;
      if (account) refund += 12_500n;
      added += (written.has(a.authority) ? 0n : 9_000n) + (account ? 0n : 120n * 1_530n) + (isDelegation(code) || a.address === ZERO ? 0n : 23n * 1_530n);
      written.add(a.authority);
      const next = account ?? new Account();
      next.nonce++;
      await state.putAccount(who, next);
      await state.putCode(who, a.address === ZERO ? new Uint8Array(0) : hexToBytes(`0xef0100${a.address.slice(2)}`));
    }
    return { refund, state: added };
  }
}

const units = (chainId: number, v: bigint) => `${formatUnits(v, CHAINS[chainId]?.nativeDecimals ?? 18)} ${CHAINS[chainId]?.nativeSymbol ?? ''}`.trim();
