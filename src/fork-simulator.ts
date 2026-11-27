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
import { createEVM, EVMError, getActivePrecompiles, paramsEVM, type EVM, type PrecompileInput } from '@ethereumjs/evm';
import { Common, createCustomCommon, Hardfork, Mainnet } from '@ethereumjs/common';
import { SimpleStateManager } from '@ethereumjs/statemanager';
import { Account, bigIntToBytes, bytesToHex, createAddressFromString, hexToBytes, setLengthLeft, unpadBytes, type Address } from '@ethereumjs/util';
import { decodeAbiParameters, encodeAbiParameters, keccak256 } from 'viem';
import { createHash } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1';
import { recoverAuthorizationAddress } from 'viem/utils';
import { appliedSignature } from './authorization.ts';
import { builtinTokens, CHAINS, PERMIT2, PRECOMPILE_SCALE } from './chains.ts';
import { headerAfter, NEXT_BLOCK, nodeOverrides, priceFields, type StateChanges } from './block.ts';
import { calldataCandidates } from './simulation-probe.ts';
import { ACTIVATION_REGISTRY_CODE, B20_ASSET_CODE, B20_BOOTSTRAP_SLOT, B20_FACTORY_CODE, B20_STABLECOIN_CODE, POLICY_REGISTRY_CODE } from './b20-reference.ts';
import { formatUnits } from './format.ts';
import { ARBOS_STATE, ARBSYS, l1Send, SEND_TX_TO_L1, WITHDRAW_ETH } from './evm/arbos.ts';
import { approvalKey, authorizationsForNode, decodeRevert, decodeState, ELSEWHERE, fitGas, hadRoom, namedApproval, NATIVE_LOG_ADDRESS, parseLogs, stateCall, UNSIGNED_STAND_IN, unsignedStandIns, VIEW_READER, VIEW_READER_CODE, viewReads, viewResults } from './simulation.ts';
import type { SimulatedApproval, SimulatedTransfer, SimulationRequest, SimulationResult, Simulator, StateChange, TraceCall } from './types.ts';

type Hex = `0x${string}`;
interface AccountData { balance: bigint; nonce: bigint; code: Uint8Array }
/** A call's result in eth_simulateV1's answer. */
interface NodeCallResult { status: string; returnData: Hex; gasUsed: Hex; maxUsedGas?: Hex; logs?: { address: string; topics: string[]; data: string }[]; error?: { message?: string; data?: Hex } }
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
  /**
   * The chain's own precompiles, each priced and failing as the chain's node does (address to how): the local EVM
   * runs what it can compute itself and has the chain answer the rest (BNB Chain's: BSC_OWN).
   */
  ownPrecompiles?: Record<string, OwnPrecompile>;
  /** Gas a forwarded precompile call costs (`address`: which precompile, where they are priced apart). */
  precompileGas?: (inputBytes: number, outputBytes: number, selector?: string, address?: string) => bigint;
  /**
   * Of the forwarded precompiles, those whose reverts can keep the gas they weren't charged (ArbOS's). The chain's
   * answer to the forwarded eth_call doesn't say what the call cost, so where it is a revert the node is asked again,
   * from a contract that reports the gas the call spent (REVERT_METER), and the local call is charged that: it keeps
   * the rest where the node's call did (an error raised by the method, with data to decode, as ArbRetryableTx's
   * NoTicketWithID(), or with none, as ArbAddressTable.lookup of an address it hasn't), and burns all it was given
   * where the node's burnt all (ArbOS turned the call away before its method ran: a method it hasn't, arguments it
   * can't decode) or where the charge is more than it was given. Where the node can't be asked, an error to decode
   * keeps the rest at `precompileGas` and a revert with nothing burns all. What ArbOS checks of how it is called (a
   * write in a static call, a delegate call or callcode, value) the forwarded eth_call can't show: the local EVM
   * checks those itself (ARBOS_METHODS).
   */
  revertsKeepGas?: string[];
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
   * Who is paid a transaction's base fee, where it isn't burnt: OP Stack's BaseFeeVault, which a later call in a batch
   * may read (on OP Mainnet, 2026-11-16, a priced call's 21,000 gas at the base fee were in it on the node and not in
   * the local EVM; in block 159,602,470 the vault gained exactly its 33 transactions' base fee).
   */
  baseFeeTo?: string;
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

/**
 * A chain's own precompile as its node runs it. `gas` is its price, from the input and the block's time (a fork can
 * change it). A call it can't answer
 * either reverts, giving back the gas it didn't use (`fails: 'revert'`), or fails taking all the gas it was given
 * (`'all'`). `run` computes the answer locally (undefined: a call that fails); without it the chain answers (eth_call).
 */
export interface OwnPrecompile { name: string; gas: (input: Uint8Array, time: bigint) => bigint; fails: 'revert' | 'all'; run?: (input: Uint8Array) => Uint8Array | undefined }

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

/**
 * HyperEVM's read precompiles, 0x…0800 to 0x…0814 (positions, spot balances, prices, the L1 block number...): the
 * node has none above (2026-11-16: a call to 0x…0815 to 0x…083f was a cold empty account's there, 2,622 gas, and had
 * been a warm forwarded read here, 1,122). To be probed again when HyperCore adds a read.
 */
const HYPERCORE_READS = Array.from({ length: 0x15 }, (_, i) => `0x${(0x800 + i).toString(16).padStart(40, '0')}`);

/**
 * HyperCore read precompile gas, measured on HyperEVM mainnet (2026-11-05) with a contract reading gasleft() around
 * STATICCALLs to six of them (inputs of 0-64 bytes, outputs of 32-256): 1,000 + 33 per input and output byte, on top
 * of the warm access (100; they are warm from the start). With it, real transactions' gas matches their receipts. A
 * call that fails (missing input, an unknown asset) uses all the gas it is given and returns nothing, also measured.
 */
const hyperCoreReadGas = (input: number, output: number) => 1000n + 33n * BigInt(input + output);
const low = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
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
  // ArbRetryableTx.redeem of a ticket that doesn't exist reads it twice before NoTicketWithID() (2,406, measured);
  // keepalive, cancel and getTimeout once (1,606). Redeeming or keeping alive one that exists is refused (ARBOS_WRITES).
  '0xeda1122c': 2,
  // Measured on Arbitrum One's node, 2026-11-16 (each had been taken to read one): getL1PricingSurplus three;
  // getPreferredAggregator, ArbRetryableTx's getLifetime and getCurrentRedeemer, ArbStatistics' getStats none.
  '0x520acdd7': 3, '0x52f10740': 0, '0x81e6e083': 0, '0xde4ba2b3': 0, '0xc59d4847': 0,
};
/**
 * ArbOS methods that return a list and read a slot for its length and one for each entry: getAllChainOwners and
 * getBatchPosters, each 4,000 and 3 a word for a list of three (2026-11-16; they had been taken to read one).
 */
const ARBOS_LISTS = new Set(['0x516b4e0f', '0xe10573a3']);
/**
 * ArbWasm's parameters (stylusVersion, inkPrice), read from one slot kept warm: 800, 100 for the read, 3 a word
 * (1,021 spent around the call where 1,721 had been taken, 2026-11-16).
 */
const ARBWASM_PARAMS = new Set(['0xa996e0c2', '0xd1c17abc']);
/**
 * ArbInfo (0x65): getBalance and getCode, answered from the simulation's own state (forwarded, they had answered
 * with the chain's, which hasn't what the simulation changed: an overridden balance came back as the chain's).
 * getBalance costs 1,500 (ArbOS's 800 and an account's balance, 700), getCode 2,900 (800 and a cold slot's 2,100)
 * and 3 a word of the code, and each 3 a word given and returned: 1,506 and, for a 1-byte code, 2,915 (measured).
 */
const ARB_INFO = low(0x65), ARB_GET_BALANCE = '0xf8b2cb4f', ARB_GET_CODE = '0x7e105ce2';
/**
 * ArbFilteredTransactionsManager (0x74, as eth_config names it): 1,600 gas whatever it is given
 * (none, a byte, 36 or 1,036 bytes), and when it refuses a call (addFilteredTransaction from an account that isn't
 * a filterer, a method it hasn't) it reverts with nothing and keeps the rest; isTransactionFiltered answers false.
 * ArbosActs (0xa4b05) refuses every method with CallerNotArbOS() before it reads anything: 800 and 3 a word.
 */
const ARB_FILTERED_TRANSACTIONS = low(0x74), ARBOS_ACTS = low(0xa4b05);
const arbosGas = (input: number, output: number, selector?: string, address?: string) => {
  const words = 3n * BigInt(Math.ceil(Math.max(0, input - 4) / 32) + Math.ceil(output / 32));
  if (address === ARB_FILTERED_TRANSACTIONS) return 1_600n;
  // A pure method doesn't open ArbOS's state: 3 a word (mapL1SenderContractAddressToL2Alias 9, measured).
  if (address && selector && ARBOS_METHODS[address]?.pure?.includes(selector)) return words;
  if (selector && ARBWASM_PARAMS.has(selector)) return 900n + words;
  const slots = address === ARBOS_ACTS ? 0 : selector && ARBOS_LISTS.has(selector) ? 1 + Math.max(0, Math.ceil(output / 32) - 2) : ARBOS_READS[selector ?? ''] ?? 1;
  return 800n + 800n * BigInt(slots) + words;
};

/**
 * What ArbOS checks before a method runs (Nitro's precompiles/precompile.go), each failing the call with nothing
 * and burning all it was given: an unknown method, a method that writes (any but view and pure) in a static call or
 * a call made inside one, a method that isn't pure in a delegate call or callcode (run as another account), value
 * to a method that isn't payable, and arguments it can't decode. The first and last show in the forwarded eth_call's
 * answer (REVERT_METER); how the call is made doesn't (it is a plain call, sent nothing), so the local EVM checks the
 * call it is in, by precompile, against the methods that write, from Nitro's interfaces (nitro-precompile-interfaces,
 * 2026-11-15), those of them that are payable, and the pure ones. Not listed: ArbOwner (0x70), which refuses every
 * call from an account that isn't a chain owner, burning all; ArbNativeTokenManager (0x73), which refuses every call
 * on Arbitrum One; and ArbDebug (0xff), off there. ArbFilteredTransactionsManager (0x74) charges its 1,600 before its
 * checks: a call it turns away reverts at 1,600 and keeps the rest (measured: in a static call, a delegate call, a
 * callcode, and with 1 wei).
 */
const ARBOS_TEST = low(0x69), BURN_ARB_GAS = '0xbb3480f9';
const ARBOS_METHODS: Record<string, { writes: string[]; payable?: string[]; pure?: string[] }> = {
  [low(0x64)]: { writes: ['0x928c169a', '0x25e16063'], payable: ['0x928c169a', '0x25e16063'], pure: ['0x4dbbd506'] }, // ArbSys: sendTxToL1, withdrawEth; mapL1SenderContractAddressToL2Alias
  [low(0x66)]: { writes: ['0xf6a455a2', '0x4420e486'] }, // ArbAddressTable: compress, register
  [low(0x68)]: { writes: ['0xce2ae159'] }, // ArbFunctionTable: upload
  [ARBOS_TEST]: { writes: [], pure: [BURN_ARB_GAS] }, // ArbosTest: burnArbGas
  [low(0x6b)]: { writes: ['0x6fe86373'] }, // ArbOwnerPublic: rectifyChainOwner
  [low(0x6d)]: { writes: ['0xdf41e1e2', '0x29149799', '0x5be6888b'] }, // ArbAggregator: addBatchPoster, setFeeCollector, setTxBaseFee
  [low(0x6e)]: { writes: ['0xeda1122c', '0xf0b21a41', '0xc4d252f5', '0xc9f95d32'] }, // ArbRetryableTx: redeem, keepalive, cancel, submitRetryable
  [low(0x71)]: { writes: ['0x58c780c2', '0xc689bad5', '0x2dfc5bcd'], payable: ['0x58c780c2', '0xc689bad5'] }, // ArbWasm: activateProgram, codehashKeepalive; deactivateCodehash
  [low(0x72)]: { writes: ['0x4ceac817', '0xe73ac9f2', '0xce972013'] }, // ArbWasmCache: cacheCodehash, cacheProgram, evictCodehash
  [low(0x74)]: { writes: ['0xcb470491', '0xd26374b1'] }, // ArbFilteredTransactionsManager: addFilteredTransaction, deleteFilteredTransaction
  [low(0xa4b05)]: { writes: ['0xb6693771', '0x9998269e', '0x6bf6a42d'] }, // ArbosActs: batchPostingReport, batchPostingReportV2, startBlock
};
/** How ArbOS's precompiles are called: the last message to each, as it is about to run (see ARBOS_METHODS). */
interface ArbOsCall { caller: string; value: bigint; isStatic: boolean; /** A delegate call or callcode: run as the calling account. */ foreign: boolean }
/** Whether ArbOS turns the call away before its method runs (ARBOS_METHODS). */
const turnedAway = (address: string, selector: string, m: ArbOsCall) => {
  const methods = ARBOS_METHODS[address];
  return (m.foreign && !methods?.pure?.includes(selector)) || (m.value > 0n && !methods?.payable?.includes(selector)) || (m.isStatic && !!methods?.writes.includes(selector));
};

/**
 * ArbOS's precompiles (ArbSys at 0x64 to ArbFilteredTransactionsManager at 0x74, ArbDebug at 0xff and ArbosActs at
 * 0xa4b05): the chain answers them, as it does HyperCore's reads, but for ArbSys's sends to L1, which run here
 * (src/evm/arbos.ts), the writes in ARBOS_WRITES, refused, and the calls ArbOS turns away for how they are made
 * (ARBOS_METHODS). 0x73 is ArbNativeTokenManager and 0x74 ArbFilteredTransactionsManager, as eth_config names them:
 * on Arbitrum One every call to 0x73 (mintNativeToken, burnNativeToken, none) reverts with nothing and burns all it
 * was given, as does a call to ArbosActs with no method (measured 2026-11-15). Not 0x6a: Arbitrum One's eth_config
 * lists no precompile there, and its node runs a call to it as one to an empty account, cold (2,600; measured
 * 2026-11-15 with and without value, in a static and a delegate call and by callcode), as the local EVM does. It had
 * been forwarded with the rest, at ArbOS's price (1,600), and turned away with value, in a delegate call or by
 * callcode, where the node's call succeeds.
 */
const ARBOS = [...Array.from({ length: 17 }, (_, i) => low(0x64 + i)).filter(a => a !== low(0x6a)), low(0xff), ARBOS_ACTS];
/**
 * ArbOS's writes whose effect the chain's answer to an eth_call can't stand for, refused when they would do
 * something: ArbRetryableTx's redeem (which gives the ticket's retry all the gas the call has left, and the chain
 * runs the retry as a transaction of its own after this one), keepalive and cancel, of a ticket that exists. Of one
 * that doesn't they revert with NoTicketWithID(), as the node does, at its price. 3 manual redeems on Arbitrum One
 * in the week to 2026-11-15 (its logs: RedeemScheduled without TicketCreated), none of them keepalive or cancel.
 */
const ARB_RETRYABLE_TX = low(0x6e), NO_TICKET_WITH_ID = '0x80698456';
const ARBOS_WRITES: Record<string, string> = { '0xeda1122c': 'redeem', '0xf0b21a41': 'keepalive', '0xc4d252f5': 'cancel' };
/**
 * BNB Chain's SECP256K1_SIGNATURE_RECOVER (0x69) as its node runs it: exactly 129 bytes, a compressed public key
 * (33), a signature's r and s (64, s in the lower half of the order) and the 32-byte digest it signs. It answers the
 * key's Tendermint address, RIPEMD-160 of the key's SHA-256 (20 bytes); anything else fails. Measured on its node
 * (2026-11-15) with signatures made on the spot: a valid one answers that address; a high s, the wrong digest, an r
 * of 0, a 33-byte key starting 04, a 65-byte key (161 bytes in) and a byte more fail.
 */
export const tendermintSignatureRecover = (input: Uint8Array): Uint8Array | undefined => {
  if (input.length !== 129) return undefined;
  const key = input.subarray(0, 33);
  try {
    if (!secp256k1.verify(input.subarray(33, 97), input.subarray(97), key, { lowS: true, prehash: false, format: 'compact' })) return undefined;
  } catch { return undefined; }
  return new Uint8Array(createHash('ripemd160').update(createHash('sha256').update(key).digest()).digest());
};
/**
 * BNB Chain's own precompiles at 0x64 to 0x69 (its eth_config's names), each priced as its node prices it: measured
 * on the node (reth-bsc 0.1.4, 2026-11-15) by the gas a STATICCALL to each spends from a contract, and, where a call
 * that fails takes all the gas it is given, by the least gas a call straight to it needs to fail some other way than
 * running out. Before, each was answered by the chain at a flat 2,000 gas, and a call that failed took all its gas:
 * a valid BLS signature with one key came out 2,500 low, a secp256k1 one 1,000 low, and a BLS or double-sign check
 * that reverts (with the rest of its gas given back on the node) took all the gas it was given.
 * - 0x64 HEADER_VALIDATE_DEPRECATED, 0x65 IAVL_MERKLE_PROOF_VALIDATE_DEPRECATED: fail whatever the input (none, 1,
 *   32, 100, 129 or 1,000 bytes), taking all the gas.
 * - 0x66 BLS_SIGNATURE_VERIFY: a 32-byte message, a 96-byte signature and 48-byte public keys; 1,000 gas and 3,500 a
 *   key (1 key 4,500, 2 keys 8,000, 10 keys 36,000), 1,000 for an input of any other length. It answers 0x01 when the
 *   signature holds (one key, or two aggregated: signed on the spot with the proof-of-possession domain) and nothing
 *   when it doesn't; an input it can't read reverts, keeping the rest of the gas. Answered by the chain.
 * - 0x67 COMET_BFT_LIGHT_BLOCK_VALIDATE_PASTEUR: 3,000 gas and 16 a byte of input (1 byte 3,016, 100 bytes 4,600,
 *   1,000 bytes 19,000, zero bytes or not); an input it can't read fails, taking all the gas. Answered by the chain.
 * - 0x68 VERIFY_DOUBLE_SIGN_EVIDENCE: 10,000 gas (none to 2,000 bytes in); evidence it can't read reverts, keeping
 *   the rest. Answered by the chain. From the chain's fork of 2026-12-08 (its node's eth_simulateV1 in a block at
 *   that time) 16 more a byte of input: 1 byte 10,016, 100 bytes 11,600, 1,000 bytes 26,000; the other five's prices
 *   are the same then.
 * - 0x69 SECP256K1_SIGNATURE_RECOVER: 3,000 gas; run here (tendermintSignatureRecover). A failure takes all the gas.
 */
const BSC_OWN: Record<string, OwnPrecompile> = {
  [low(0x64)]: { name: 'HEADER_VALIDATE_DEPRECATED', gas: () => 0n, fails: 'all', run: () => undefined },
  [low(0x65)]: { name: 'IAVL_MERKLE_PROOF_VALIDATE_DEPRECATED', gas: () => 0n, fails: 'all', run: () => undefined },
  [low(0x66)]: { name: 'BLS_SIGNATURE_VERIFY', gas: i => 1_000n + (i.length > 128 && (i.length - 128) % 48 === 0 ? 3_500n * BigInt((i.length - 128) / 48) : 0n), fails: 'revert' },
  [low(0x67)]: { name: 'COMET_BFT_LIGHT_BLOCK_VALIDATE_PASTEUR', gas: i => 3_000n + 16n * BigInt(i.length), fails: 'all' },
  [low(0x68)]: { name: 'VERIFY_DOUBLE_SIGN_EVIDENCE', gas: (i, time) => 10_000n + (time >= BNB_MILLI_TIMESTAMP.from ? 16n * BigInt(i.length) : 0n), fails: 'revert' },
  [low(0x69)]: { name: 'SECP256K1_SIGNATURE_RECOVER', gas: () => 3_000n, fails: 'all', run: tendermintSignatureRecover },
};

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

/** EIP-2935's history contract and EIP-4788's beacon roots contract, which a block's start writes into (run). */
const HISTORY_STORAGE = '0x0000f90827f1c53a10cb7a02335b175320002935', BEACON_ROOTS = '0x000f3df6d732807ef1319fb7b8bb8522d0beac02';
/** OP Stack's BaseFeeVault predeploy (ChainProfile.baseFeeTo). */
const BASE_FEE_VAULT = '0x4200000000000000000000000000000000000019';
/**
 * Where Arbitrum One pays a transaction's fee, none of it to COINBASE. Measured on its node, 2026-11-16, a call priced
 * at the base fee (20,012,000) and a tip of 1 gwei, 21,000 gas of L2 and 9 of L1: its infrastructure fee account was
 * paid the L2 gas at ArbOS's minimum gas price (20,000,000, ArbGasInfo.getMinimumGasPrice), its network fee account
 * the L2 gas at the rest of the price (the base fee over the minimum, and the tip), and the L1 pricer's pool the L1
 * gas at the whole price. The chain charges every tip a transaction names, up to its fee cap.
 */
const ARBITRUM_FEES = { infra: '0xbf5041fc07e1c866d15c749156657b8eed0fb649', network: '0x32e7af5a8151934f3787d0cd59eb6edd0a736b1d', l1: '0xa4b00000000000000000000000000000000000f6' };
const ARB_GAS_INFO = '0x000000000000000000000000000000000000006c';

export const CHAIN_PROFILES: Record<number, ChainProfile> = {
  1: { hardfork: 'osaka', checked: { forkId: '0x07c9462e', on: '2026-11-10' }, ...NEXT_BLOCK[1] },
  // Sepolia runs Amsterdam (Glamsterdam) since 2026-10-06: its blocks say so, and run under those rules (see ETHEREUM_RULES).
  11155111: { hardfork: 'osaka', checked: { forkId: '0x6c1d9423', on: '2026-11-11' }, ...NEXT_BLOCK[11155111] },
  42161: { hardfork: 'osaka', checked: { forkId: '0x92f58d00', on: '2026-11-10' }, ...NEXT_BLOCK[42161], forwardedPrecompiles: ARBOS, precompileGas: arbosGas, revertsKeepGas: ARBOS, missingOpcodes: [0x4a] },
  8453: { hardfork: 'osaka', checked: { forkId: '0x169d85a3', on: '2026-11-10' }, ...NEXT_BLOCK[8453], baseFeeTo: BASE_FEE_VAULT },
  10: { hardfork: 'osaka', checked: { forkId: '0xc29239af', on: '2026-11-10', next: { forkId: '0x51cd8e22', on: '2026-11-27' } }, ...NEXT_BLOCK[10], baseFeeTo: BASE_FEE_VAULT },
  // Polygon prices storage its own way. Measured on its node with code overrides (2026-11-10): a cold SLOAD costs
  // 5,460; a cold SSTORE adds 2,940 (setting an empty slot 22,940, changing a set one 5,000 as on Ethereum, writing
  // back the same value 3,040), and clearing a slot refunds 3,960. Warm reads, accounts, calls, logs, hashing and
  // creation cost what they do on Ethereum. With Ethereum's prices every transaction that touched storage came out
  // low, by a multiple of 840.
  137: { hardfork: 'osaka', ...NEXT_BLOCK[137], storageGas: { coldRead: 5460, coldWrite: 2940 }, precompilePrices: POLYGON_PRECOMPILES, missingOpcodes: [0x49, 0x4a], noPointEvaluation: true, maxCodeSize: 32_768 },
  // (Its fork of 2026-12-08 checked ahead: the rules check's 370 programs alike on its node at the fork's time, and on
  // 2026-11-15 its 387, the chain's own precompiles among them.)
  56: { hardfork: 'osaka', checked: { forkId: '0xd38cc282', on: '2026-11-10', next: { forkId: '0x23d35e07', on: '2026-11-15' } }, ...NEXT_BLOCK[56], ownPrecompiles: BSC_OWN, tipsTo: '0xfffffffffffffffffffffffffffffffffffffffe',
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

/**
 * A run reached an Arbitrum Stylus program (WASM, which no EVM runs) from inside another contract, at request
 * `request` of the batch: by its own call (`call`), or by a read around it (a balance or a permission; `read`, the
 * token, where it was a read of a balance before the call). Not an answer: ForkSimulator.rounds runs that request,
 * and every one after it, on the chain's node instead (runOnNode).
 */
export class StylusReached extends ForkUnsupported {
  readonly program: string; readonly request: number; readonly call: boolean; readonly read?: string;
  constructor(program: string, request: number, call: boolean, read?: string) {
    super(`${program} is a Stylus (WASM) contract, which the local EVM can't run: the transaction reaches it from inside another contract`);
    this.program = program; this.request = request; this.call = call; this.read = read;
  }
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
  WITHOUT_ACCESS_LISTS.clear();
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
/**
 * What a forwarded call that reverts was charged (ChainProfile.revertsKeepGas): the node is asked with an eth_call
 * to a contract placed for it, which calls the precompile with the calldata on METERED_GAS and returns the
 * difference of two GAS readings around the call and whether it succeeded:
 *   CALLDATASIZE PUSH1 0 PUSH1 0 CALLDATACOPY GAS PUSH1 0 PUSH1 0 CALLDATASIZE PUSH1 0 PUSH1 0 PUSH20 <precompile>
 *   PUSH3 <METERED_GAS> CALL GAS SWAP1 PUSH1 0x20 MSTORE SWAP1 SUB PUSH1 0 MSTORE PUSH1 0x40 PUSH1 0 RETURN
 * The readings differ by what the call spent, its warm access (100) and the 22 of the code between them; a call
 * that burnt all it was given spent METERED_GAS. (Checked on Arbitrum One: ArbAddressTable.lookup of an address it
 * hasn't, 1,603, as a contract measured; ArbRetryableTx.redeem of no ticket, 2,406.)
 */
const REVERT_METER = '0x00000000000000000000000000000000a4b0ca11', METERED_GAS = 1_000_000n, METER_OVERHEAD = 122n;
const revertMeterCode = (precompile: string): Hex => `0x3660006000375a60006000366000600073${precompile.slice(2)}62${METERED_GAS.toString(16).padStart(6, '0')}f15a90602052900360005260406000f3`;

/** One JSON-RPC request of a batch, and what to do with its answer (`answers`: its error is one too, not a failure). */
type Job = { method: string; params: unknown[]; answers?: boolean; done: (result: unknown, error?: { code?: number; message?: string; data?: Hex }) => void };
/** How a request is sent: how long it may take (15 seconds), and whether one that gets no answer is left at that. */
type Asking = { timeoutMs?: number; once?: boolean };
/**
 * What is only asked to read ahead (the node's access lists) is left after 4 seconds without an answer, or refused
 * for a rate limit: Sepolia's public node left one replay's eth_createAccessList unanswered for the 15 seconds a
 * state read may take, in three of six tries, and the replay waited (2026-11-15). Its rules (eth_config) are asked
 * again sooner too.
 */
const AHEAD: Asking = { timeoutMs: 4000, once: true }, RULES: Asking = { timeoutMs: 4000 };

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
  /** Forwarded precompiles whose reverts are metered (ChainProfile.revertsKeepGas): what each was charged is asked with the answer. */
  metered = new Set<string>();
  /** What the simulation ran: calls (in all its rounds) and the views around them (StateSource.spent's answered none). */
  ran = { calls: 0, views: 0 };
  /** Views that spent half their gas and answered no word, by contract and selector, with the code they ran (viewCall). */
  spent = new Map<string, { code: Uint8Array; out: Uint8Array | undefined }>();

  /**
   * What the node says each call will touch (eth_createAccessList, on the block the reads are of), asked in one
   * batch: the accounts and slots to read before the first run. Undefined for a call it won't say for (no such
   * method, an error).
   */
  async accessLists(calls: Record<string, unknown>[]): Promise<{ lists: ({ address: string; storageKeys: string[] }[] | undefined)[]; /** The node has no such method. */ none: boolean }> {
    const lists: ({ address: string; storageKeys: string[] }[] | undefined)[] = calls.map(() => undefined);
    let absent = 0;
    try {
      await this.sendAll(calls.map((call, i) => ({ method: 'eth_createAccessList', params: [call, this.block], answers: true,
        done: (r: unknown, e?: { code?: number; message?: string }) => {
          const list = (r as { accessList?: unknown } | null)?.accessList;
          if (!e && Array.isArray(list)) lists[i] = list as { address: string; storageKeys: string[] }[];
          // (Only the method being missing: JSON-RPC's -32601, or an error that says so of a method. Not the state
          // the call needs: Sepolia's public node answers "historical state … is not available" for every call from
          // a backend that has pruned the block, and the next simulation's backend may have it.)
          if (e && (e.code === -32601 || /\bmethod\b[^.]*\b(not found|does not exist|not available|not supported|unsupported)\b|unsupported method/i.test(e.message ?? ''))) absent++;
        } })), AHEAD);
    } catch { /* none to read ahead */ }
    return { lists, none: calls.length > 0 && absent === calls.length };
  }

  /** The node's own account of the rules it runs (eth_config, EIP-7910); undefined where it gives none. */
  async config(): Promise<unknown> {
    let c: unknown;
    try { await this.send([{ method: 'eth_config', params: [], done: r => { c = r; } }], RULES); } catch { return undefined; }
    return c;
  }
  /** Arbitrum: ArbOS's minimum gas price, which its infrastructure fee account is paid at (ARBITRUM_FEES). */
  private minimumGasPrice?: Promise<bigint | undefined>;
  arbMinimumGasPrice(): Promise<bigint | undefined> {
    return this.minimumGasPrice ??= (async () => {
      let v: bigint | undefined;
      try { await this.send([{ method: 'eth_call', params: [{ to: ARB_GAS_INFO, data: '0xf918379a' }, this.block], done: r => { if (typeof r === 'string' && /^0x[0-9a-f]{64}$/i.test(r)) v = BigInt(r); } }]); } catch { v = undefined; }
      return v;
    })();
  }
  /** The node's runs of calls handed to it (nodeRun), by what was asked: a speculative round asks again. */
  private nodeRuns = new Map<string, Promise<NodeCallResult[][]>>();
  /** The chain's node runs `blocks` (eth_simulateV1 on this source's block): the calls' results, block by block. */
  nodeRun(blocks: unknown[]): Promise<NodeCallResult[][]> {
    const key = JSON.stringify(blocks);
    let out = this.nodeRuns.get(key);
    if (!out) {
      out = (async () => {
        let r: { calls: NodeCallResult[] }[] | undefined, error: string | undefined;
        await this.send([{ method: 'eth_simulateV1', params: [{ blockStateCalls: blocks, validation: false }, this.block], done: (x, e) => { r = x as typeof r; error = e?.message; } }]);
        if (!r || r.length !== blocks.length) throw new Error(`the chain's node didn't run the call${error ? `: ${error}` : ''}`);
        return r.map(b => b.calls);
      })();
      this.nodeRuns.set(key, out);
      out.catch(() => this.nodeRuns.delete(key));
    }
    return out;
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
  after?: { calls: unknown[]; blockOverrides: Record<string, string>; /** What moved each address's nonce among those calls, in order: a transaction it sent, or an EIP-7702 authorization it signed for the nonce given (applied only if that is its nonce by then). */ bumps: Map<string, (bigint | 'sent')[]>; /** What the block had changed before those calls (BlockAt.state): they run on it. */ state?: StateChanges; /** The calls on less gas each, for a node that adds their limits up against the block's (fitGas); undefined when they can't be. */ fit?: () => Promise<{ requests: SimulationRequest[]; calls: unknown[] } | undefined>; /** Set once the calls are the fitted ones: none may have run short on its gas (hadRoom, against `earlier`). */ fitted?: SimulationRequest[]; earlier?: SimulationRequest[];
    /** Those of the calls to run where the node can't run them all within the gas it allows one simulation (BlockAt.related), as the node's own simulation of the replay ran; undefined when there is no such choice. Set `narrowed` once they are the calls. */
    related?: () => Promise<{ calls: unknown[]; earlier: SimulationRequest[] } | undefined>; narrowed?: boolean };

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
            } else if (/intrinsic gas too low|gas limit reached|out of gas|gas required exceeds/i.test(message) && !after.narrowed && !after.fitted) {
              // The calls used more gas than the node allows one simulation (Ethereum's public node: 50 million):
              // those that bear on the replayed transaction, as the simulation shown ran after (RpcSimulator).
              const part = await after.related?.();
              if (!part) throw e;
              after.calls = noBlobs ? plain(part.calls) : part.calls; after.earlier = part.earlier; after.narrowed = true;
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

  /**
   * Reads in flight, by key (`a:` an account, a slot's key, `c:` a forwarded call, `b:` a block's hash): a read
   * another fetch asked for while this one is out (the reads around the calls being found while the node's access
   * lists are read: ForkSimulator.warmViews) waits for it instead of asking again.
   */
  private inflight = new Map<string, Promise<void>>();

  private async fetchAt(wanted: Misses): Promise<void> {
    const waits = new Set<Promise<void>>();
    const m = newMisses();
    const mine = (k: string) => { const p = this.inflight.get(k); if (p) waits.add(p); return !p; };
    for (const a of wanted.accounts) if (mine(`a:${a}`)) m.accounts.add(a);
    for (const k of wanted.storage) if (mine(k)) m.storage.add(k);
    for (const k of wanted.calls) if (mine(`c:${k}`)) m.calls.add(k);
    for (const n of wanted.blocks) if (mine(`b:${n}`)) m.blocks.add(n);
    const keys = [...[...m.accounts].map(a => `a:${a}`), ...m.storage, ...[...m.calls].map(k => `c:${k}`), ...[...m.blocks].map(n => `b:${n}`)];
    let finished!: () => void;
    const own = new Promise<void>(r => { finished = r; });
    for (const k of keys) this.inflight.set(k, own);
    try { if (keys.length) await this.fetchFresh(m); } finally {
      for (const k of keys) if (this.inflight.get(k) === own) this.inflight.delete(k);
      finished();
    }
    await Promise.all(waits);
  }

  private async fetchFresh(m: Misses): Promise<void> {
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
      if (!GUESS_ACCOUNTS.get(`${this.chainId}:${a}`)) for (const slot of PROXY_SLOTS) if (!this.storage.has(`${a}_${slot}`) && !m.storage.has(`${a}_${slot}`) && !this.inflight.has(`${a}_${slot}`)) {
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
    const answer = (k: string, v: { ok: boolean; data: Uint8Array }) => { this.calls.set(k, v); GUESS_CALLS.set(`${this.chainId}:${k}`, v); };
    // What a forwarded call that reverted was charged (`<call>_gas`, REVERT_METER): the meter's two words, or nothing.
    const meter = (k: string): Job => {
      const [to, data] = k.split('_');
      return { method: 'eth_call', params: [{ to: REVERT_METER, data }, this.block, { [REVERT_METER]: { code: revertMeterCode(to) } }], done: (r, e) => {
        answer(k, { ok: !e && typeof r === 'string' && r.length === 130, data: !e && typeof r === 'string' && r.length === 130 ? hexToBytes(r as Hex) : new Uint8Array(0) });
      } };
    };
    for (const k of m.calls) {
      if (k.endsWith('_gas')) { jobs.push(meter(k)); continue; }
      const [to, data] = k.split('_');
      jobs.push({ method: 'eth_call', params: [{ to, data }, this.block], done: (r, e) => {
        answer(k, e ? { ok: false, data: e.data ? hexToBytes(e.data) : new Uint8Array(0) } : { ok: true, data: hexToBytes(r as Hex) });
      } });
    }
    await this.sendAll(jobs);
    // A metered precompile's revert: what it was charged is asked right away, not in a round of its own.
    const reverted = [...m.calls].filter(k => !k.endsWith('_gas') && this.metered.has(k.split('_')[0]) && this.calls.get(k)?.ok === false && !this.calls.has(`${k}_gas`) && !m.calls.has(`${k}_gas`));
    if (reverted.length) await this.sendAll(reverted.map(k => meter(`${k}_gas`)));
    for (const [a, acc] of pending) {
      this.accounts.set(a, acc);
      if (!this.historic) GUESS_ACCOUNTS.set(`${this.chainId}:${a}`, { balance: acc.balance, nonce: acc.nonce, hasCode: acc.code.length > 0 });
    }
  }

  /** The jobs in batches of the source's size, a few at a time. */
  private async sendAll(jobs: Job[], ask?: Asking) {
    const batches: Job[][] = [];
    for (let i = 0; i < jobs.length; i += this.batchSize) batches.push(jobs.slice(i, i + this.batchSize));
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(this.concurrency, batches.length) }, async () => {
      while (next < batches.length) await this.send(batches[next++], ask);
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

  private async send(batch: Job[], ask: Asking = {}) {
    let throttled = false;
    for (let attempt = 0; ; attempt++) {
      // (Said as a rate limit where the node was refusing for one: a caller can tell it from a slow EVM.)
      if (Date.now() > this.deadline) throw new ForkTimeout(`the simulation ran out of time fetching chain state${throttled ? ' (the node rate limited its reads)' : ''}`);
      this.requests += batch.length;
      // Public RPCs rate-limit per IP: back off (as long as the node asks, else twice as long each time, up to 4 s
      // between tries), within the simulation's deadline. (Waiting a rate limit out for all of a replay's minute
      // rescued no trace on Arbitrum One's public node, which refused for longer: eight tries, some twenty seconds.)
      let asked = 0;
      const wait = () => Math.min(asked > 0 ? asked * 1000 : 300 * 2 ** attempt, 4000);
      let res: Response;
      try {
        // (No longer than the time left, nor 15 seconds: a request the node never answers is asked again.)
        res = await this.fetchImpl(this.url, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(Math.max(1000, Math.min(ask.timeoutMs ?? 15_000, this.deadline - Date.now()))),
          body: JSON.stringify(batch.map((j, i) => ({ jsonrpc: '2.0', id: i, method: j.method, params: j.params }))) });
      } catch (e) {
        // The request itself failed: it timed out (BNB Chain's public node left eleven of a run's replays without an
        // answer for 15 seconds, 2026-11-14, and each failed the whole simulation), or the connection was reset.
        // Asked again, like an HTTP 5xx, while there is time.
        if (!ask.once && attempt < 8 && Date.now() < this.deadline) { await new Promise(r => setTimeout(r, wait())); continue; }
        // (Cut short as the simulation's time ran out, the request no longer than that: said so, as a read asked past
        // it is. A caller can then keep an answer it had: an extra run's, with a later-seen token watched.)
        if (Date.now() >= this.deadline) throw new ForkTimeout(`the simulation ran out of time fetching chain state${throttled ? ' (the node rate limited its reads)' : ''}`);
        throw new Error(`state fetch failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      const body = res.ok ? await res.json().catch(() => undefined) as unknown : undefined;
      // Rate limits, and load-balanced nodes a block behind ("invalid block height", reth's "block not found") are
      // worth retrying.
      const transient = /rate limit|too many requests|invalid block height|header not found|unknown block|block not found/i;
      const text = Array.isArray(body) ? '' : JSON.stringify(body ?? '');
      const limited = res.status === 429 || transient.test(text);
      throttled = res.status === 429 || /rate limit|too many requests/i.test(text);
      asked = Number(res.headers?.get?.('retry-after'));
      if ((limited || res.status >= 500 || (res.ok && body === undefined)) && attempt < 8 && !ask.once) { await new Promise(r => setTimeout(r, wait())); continue; }
      if (!Array.isArray(body)) throw new Error(`state fetch failed: HTTP ${res.status} ${text.slice(0, 160)}`);
      const byId = new Map((body as { id: number; result?: unknown; error?: { code?: number; message?: string; data?: Hex } }[]).map(r => [r.id, r]));
      // (A request the answer left out is asked again too: its value is not known.)
      const retry = batch.filter((_, i) => !byId.has(i) || transient.test(byId.get(i)?.error?.message ?? ''));
      batch.forEach((j, i) => {
        const r = byId.get(i);
        if (!r || transient.test(r.error?.message ?? '')) return;
        // eth_call reverts are answers (a forwarded precompile can revert); a failed state read is not.
        if (r.error && j.method !== 'eth_call' && !j.answers) throw new Error(`${j.method} failed: ${r.error.message}`);
        j.done(r.result, r.error);
      });
      if (!retry.length || ask.once) return;
      if (attempt >= 8) throw new Error('state fetch: rate limited');
      batch = retry;
      await new Promise(r => setTimeout(r, wait()));
    }
  }
}

/** Chains whose RPC has no eth_createAccessList (HyperEVM's answers eth_call and state reads only). */
const NO_ACCESS_LIST = new Set([999, 998]);
/** RPCs that said they have no eth_createAccessList, for every call they were asked it for (Arbitrum One's public one). */
const WITHOUT_ACCESS_LISTS = new Set<string>();

/** Arbitrum's Stylus programs: WASM, compressed, behind the prefix 0xEFF000 (then the compression dictionary's byte). */
export const isStylus = (code: Uint8Array) => code.length > 3 && code[0] === 0xef && code[1] === 0xf0 && code[2] === 0x00;

/** An address in the range chains keep for precompiles and their own contracts (under 0x10000): its proxy slots aren't read ahead. */
const lowAddress = (a: string) => BigInt(a) < 0x10000n;

/** A run's state between two of its calls (LazyState.snapshot). */
interface StateSnapshot { accounts: Map<Hex, Account | undefined>; code: Map<Hex, Uint8Array>; storage: Map<string, Uint8Array>; cleared: Set<string> }
const copyAccounts = (m: Map<Hex, Account | undefined>) => new Map([...m].map(([k, a]) => [k, a && Object.assign(Object.create(Object.getPrototypeOf(a)), a) as Account]));

/**
 * Code that can't return data, whatever it is sent: no byte of it is RETURN (0xf3), nor a call to other code that
 * could (CALL, CALLCODE, DELEGATECALL, STATICCALL), counting push data too. (Not an EIP-7702 delegation or a marker
 * the chain's node runs itself, whose code isn't what runs.)
 */
const answersNothing = (code: Uint8Array) => code.length > 0 && code[0] !== 0xef && !code.some(b => b === 0xf3 || b === 0xf1 || b === 0xf2 || b === 0xf4 || b === 0xfa);

// A view (a balance, an allowance) gets 10 million gas: a token whose balanceOf works out what an account holds can
// take more than a million (Open Genesis, on BNB Chain: 1.37 million), and with less the read fails and the token's
// events stand, which for that one netted to a unit where the balance went down by 4.56e18.
const VIEW_GAS = 10_000_000n;

/**
 * A view (a balance, an allowance, an interface asked for) on `on`: its return data, undefined where it failed.
 * The contracts read so are each call's target and the addresses in its calldata as well as tokens, so some aren't:
 * Sepolia's blocks carry transactions to a contract that loops on whatever it is sent until its gas is spent
 * (0x4a65…3441, 2.5 million gas a transaction), and every view of it burnt all of its 10 million. A replay of one of
 * them behind three others read it 36 times, 35 of its 39 seconds (2026-11-15). So a view that spent half its gas
 * and answered no word is remembered for the simulation (StateSource.spent), by contract and function, with the
 * code it ran: asked again, while that code is there, it answers as it did, without running. (Only from a run that
 * has read nothing it had to guess, this view included: a value guessed earlier in the run is guessed again when the
 * view reads it, and what a call wrote from one is no fresher, and either could be what sent the view looping. A
 * token's view that answers takes a sliver of that: Open Genesis's 1.37 million is the most seen.) And code with no
 * RETURN in it, and no call to other code, can't answer at all: not run (that contract's 33 bytes are such).
 * `memo` is where such views are kept: the run's own (StateSource.spent), or warmViews' (whose EVM has none of the
 * chain's precompiles and hooks: a B20 token's marker code, run there, burns all it is given).
 */
async function viewCall(on: EVM, source: StateSource, misses: Misses | null, to: string, data: Uint8Array, block: unknown, memo = source.spent): Promise<Uint8Array | undefined> {
  const address = createAddressFromString(to), key = `${hexOf(to)}_${bytesToHex(data.subarray(0, 4))}`;
  const code = await on.stateManager.getCode(address), kept = memo.get(key);
  if (kept && kept.code === code) return kept.out;
  if (answersNothing(code)) return undefined;
  source.ran.views++;
  const r = await on.runCall({ caller: createAddressFromString(ZERO), to: address, data, gasLimit: VIEW_GAS, isStatic: true, block: block as never });
  const ex = r.execResult, out = ex.exceptionError ? undefined : ex.returnValue;
  if (ex.returnValue.length < 32 && ex.executionGasUsed * 2n >= VIEW_GAS && (!misses || !missCount(misses))) memo.set(key, { code, out });
  return out;
}

/**
 * Where a speculative run got to on fetched values alone: the calls before `at` read nothing they had to guess, so
 * their results and the state they left are what every later run would come to. What a run starts from instead of
 * running them again (ForkSimulator.rounds): the state, the accounts touched (EIP-161: the next call's start removes
 * the empty ones), the results and what they saw.
 */
interface RunSnapshot {
  at: number; state: StateSnapshot; touched: string[]; results: SimulationResult[]; byRequest: string[][]; seenTokens: string[]; seenApprovals: SimulatedApproval[];
  touchedApprovals: [string, SimulatedApproval][]; rerun: boolean; grewAt: number[]; nft: [string, boolean][];
}

/**
 * Where a run hands the batch to the chain's node (runOnNode): request `at`, which reaches the Stylus program
 * `program`, and every request after it, whose state the local EVM then doesn't have. `call`: reached by the
 * request's own call (else by a read around it); `ownRead`: by a read of the request's own target before its call;
 * `target`: the program is the request's own target.
 */
interface NodeFrom { at: number; program: string; call: boolean; ownRead?: boolean; target?: boolean }
/** Why a request is run on the node: where the batch was handed to it, and whether this request comes after that one. */
type NodeWhy = NodeFrom & { after: boolean };
/**
 * What a run on the node is for, as its result's source and its trace frame say ("chain 42161's node, ..."). A program
 * first reached by a read, before the call, of the call's own target (always a token watched) is reached from inside
 * another contract all the same, the one the call goes to: a proxy whose implementation is the program (live on
 * Arbitrum One, 2026-11-16: a call to such a proxy was handed over at the read of its balanceOf before the call). One
 * reached by any other read (a token watched behind such a proxy, or a read after a call that ran here without
 * reaching it) is said to be reached by a read: that the call reaches it isn't known.
 */
const nodeReason = (w: NodeWhy) => w.after
  ? `after call ${w.at + 1} of the batch, ${w.target ? 'which is made straight to' : w.call || w.ownRead ? 'which reaches' : 'a read around which reaches'} the Stylus (WASM) program ${w.program} (the local EVM can't run it, so hasn't the state the calls after it run on)`
  : w.target ? 'for a Stylus (WASM) program the local EVM can\'t run'
  : `for the Stylus (WASM) program ${w.program}, which the local EVM can't run, ${w.call ? 'reached from inside another contract' : w.ownRead ? 'reached from inside another contract (first by a read of a balance or a permission around the call)' : 'reached by a read around the call (a balance or a permission)'}`;

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
    // Arbitrum's Stylus contracts are WASM behind a 0xEFF000 prefix, which no EVM runs: better no answer than a wrong
    // one. (A call made straight to one, a request's own target, the chain's node runs instead: ForkSimulator's runOnNode.
    // Reached from inside the EVM, the program would have to run in the middle of the local run: the run stops here,
    // and the request is run on the node too, with those after it: StylusReached.)
    if (NEXT_BLOCK[this.source.chainId]?.arbitrum && isStylus(a.code)) throw new StylusReached(key, this.at.request, this.at.call, this.at.read);
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

  /** Whether `key`'s code is a Stylus program (Arbitrum), read without running into load()'s refusal. */
  async stylus(key: string): Promise<boolean> {
    if (!NEXT_BLOCK[this.source.chainId]?.arbitrum) return false;
    const a = await this.data(hexOf(key));
    return !!a && isStylus(a.code);
  }

  /**
   * The request run() is at, whether its own call is running (not a read around it), and the token a read of a
   * balance before the call is of: what StylusReached says.
   */
  at: { request: number; call: boolean; read?: string } = { request: 0, call: false };

  /** `key`'s balance and nonce as this run has them, read without load()'s refusals (a Stylus program's own account). */
  async peek(key: string): Promise<{ balance: bigint; nonce: bigint }> {
    const k = hexOf(key) as Hex, top = this.topAccountStack();
    const a = top.has(k) ? top.get(k) : await this.data(k);
    return { balance: a?.balance ?? 0n, nonce: a?.nonce ?? 0n };
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

  /** What this state holds between two calls of a run (one layer: no call is open), for a later run to start from. */
  snapshot(): StateSnapshot | undefined {
    if (this.accountStack.length !== 1) return undefined;
    return { accounts: copyAccounts(this.topAccountStack()), code: new Map(this.topCodeStack()), storage: new Map(this.topStorageStack()), cleared: new Set(this.cleared) };
  }

  /** Starts from a snapshot's state (copied: a run changes what it starts from). */
  restore(s: StateSnapshot): void {
    this.accountStack = [copyAccounts(s.accounts)];
    this.codeStack = [new Map(s.code)];
    this.storageStack = [new Map(s.storage)];
    this.cleared = new Set(s.cleared);
  }

  /**
   * An account removed as empty (EIP-161: touched by a transaction and left with no code, nonce or balance, which the
   * run's journal cleanup does before each call) goes with its storage, as the chain's node removes it. Only an
   * account a state override gives storage, or one a precompile keeps storage in, can hold any: Base's NonceManager
   * has none of the three, and its node reads a nonce an override gave it as 0 in a transaction after one that
   * called it (measured in a simulated block: a nonce of 7 given, read as 7 by the first transaction to call it and
   * as 0 by one after another had called it; with a balance or nonce of 1 given as well, 7).
   * (In a speculative run an account not read yet may only look empty: its storage is left to the run that knows.)
   */
  override async deleteAccount(address: Address): Promise<void> {
    await super.deleteAccount(address);
    // (Its code goes with it: SimpleStateManager keeps code apart from accounts, and a contract destroyed in the
    // transaction that made it read as having its code still, EXTCODESIZE 2, while its hash read as no account's.)
    this.topCodeStack().set(address.toString(), new Uint8Array(0));
    if (!this.misses || this.source.accounts.has(address.toString())) await this.clearStorage(address);
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
/**
 * Base's precompiles for EIP-8130's account-abstraction transactions, from its upgrade of 2026-11-05 on (its
 * eth_config lists them, by these names, with the fork of that time), which the local EVM runs as the node does.
 * Measured on Base's node (2026-11-15), each call from a contract that reports the gas it spent. They have no code,
 * are warm from the start, and answer:
 * - NonceManager's getNonce(address account, uint256 nonceKey): the account's nonce on that key, a uint64, kept in
 *   its own storage at nonces[account][nonceKey] in ERC-7201's namespace `base.nonce_manager` (NONCES_LOCATION: a
 *   state override of that slot is what it answers; of no other candidate). Key 0, the account's own nonce, reverts
 *   with ProtocolNonceNotSupported(). It costs 6 gas a word of its input and the slot's read, cold or warm as an
 *   SLOAD (2,100 or 100: getNonce 2,118, then 118 for the same key, 2,118 for another); given a gas less, it runs
 *   out. A value over 64 bits in the slot (which only an override can put there) reverts with Panic(0x11).
 * - TxContext's getTransactionSender(), getTransactionPayer() and getTransactionSenderActorId(): in a transaction
 *   of any type but EIP-8130's (none mined in the blocks scanned; the local EVM runs no other kind), the
 *   transaction's sender (tx.origin, not the calling contract), as a word; its actor id is the sender's own,
 *   the address as a bytes32. 3 gas each, its input whatever its length; EIP-8130's other functions
 *   (getTransactionCalls(), getTransactionGasLimit()) aren't on the node and revert as any it lacks.
 * Calldata either can't decode (a selector it lacks, arguments short, an address with upper bytes set) reverts
 * with its selector, or 4 zero bytes short of one, at the price above (NonceManager 6 a word, TxContext nothing).
 * Run as another's code (DELEGATECALL, CALLCODE) they revert with DelegateCallNotAllowed(), sent value with
 * NonPayable(), charging nothing (BASE_AA_REFUSED). Nonces only an EIP-8130 transaction writes; a call that reaches
 * NonceManager leaves its account (empty) to be removed after the transaction, as LazyState.deleteAccount has it.
 * At a block before the upgrade they aren't run: where the node lists them, a call reaching one is refused (what
 * was there then couldn't be measured: the public node keeps no state that old).
 */
const NONCE_MANAGER = '0x813000000000000000000000000000000000aa01', TX_CONTEXT = '0x813000000000000000000000000000000000aa02';
const BASE_AA_PRECOMPILES: Record<string, string> = { [NONCE_MANAGER]: 'NonceManager', [TX_CONTEXT]: 'TxContext' };
/** keccak256(abi.encode(uint256(keccak256("base.nonce_manager")) - 1)) & ~bytes32(uint256(0xff)): NonceManager's nonces mapping. */
const NONCES_LOCATION = hexToBytes('0x9d3ea32ad25774a46482ebbae019e8da4242109d164d324a59aa787515b9fe00');
const GET_NONCE = '0x89535803', PROTOCOL_NONCE_NOT_SUPPORTED = hexToBytes('0x1bc81ca9');
/** getTransactionSender(), getTransactionPayer(), getTransactionSenderActorId(): each the transaction's sender. */
const TX_SENDER = new Set(['0xbead3f50', '0x690b3a9d', '0xe14fe3f3']);
const PANIC_OVERFLOW = hexToBytes('0x4e487b710000000000000000000000000000000000000000000000000000000000000011');
/** The precompiles Base's node runs that the local EVM has at a block of this time (BASE_AA_PRECOMPILES), by address. */
export const chainPrecompilesAt = (chainId: number, time: bigint): string[] => (chainId === BASE && time >= BASE_DENIM ? Object.keys(BASE_AA_PRECOMPILES) : []);
const aaOutOfGas = (gasLimit: bigint) => ({ executionGasUsed: gasLimit, returnValue: new Uint8Array(0), exceptionError: new EVMError(EVMError.errorMessages.OUT_OF_GAS) });
/** An answer at `gas`, or out of gas where the call was given less. */
const aaAnswer = (gas: bigint, gasLimit: bigint, returnValue: Uint8Array, reverts = false) => (gas > gasLimit ? aaOutOfGas(gasLimit)
  : { executionGasUsed: gas, returnValue, ...(reverts && { exceptionError: new EVMError(EVMError.errorMessages.REVERT) }) });
/** What calldata a precompile can't decode reverts with: its selector, or 4 zero bytes short of one. */
const echoSelector = (data: Uint8Array) => (data.length >= 4 ? data.slice(0, 4) : new Uint8Array(4));
/** How Base's AA precompiles refuse a call by the way it is made, charging nothing: run as another's code, or sent value. */
const BASE_AA_REFUSED = { delegated: hexToBytes('0x0d89438e'), value: hexToBytes('0x6fb1b0e9') };

/**
 * NonceManager and TxContext as functions the EVM runs at their addresses (BASE_AA_PRECOMPILES). `originOf` gives
 * the sender of the transaction an EVM is running (see the run's hook): what TxContext answers.
 */
function baseAaPrecompiles(originOf: (evm: unknown) => Address | undefined) {
  const nonceManager = async (input: PrecompileInput) => {
    const { data, gasLimit } = input, gas = 6n * BigInt(Math.ceil(data.length / 32));
    // getNonce(address, uint256): two words, the first an address.
    if (data.length < 68 || bytesToHex(data.subarray(0, 4)) !== GET_NONCE || data.subarray(4, 16).some(b => b !== 0)) return aaAnswer(gas, gasLimit, echoSelector(data), true);
    if (data.subarray(36, 68).every(b => b === 0)) return aaAnswer(gas, gasLimit, PROTOCOL_NONCE_NOT_SUPPORTED, true);
    // nonces[account][nonceKey]: keccak256(nonceKey ‖ keccak256(account ‖ NONCES_LOCATION)).
    const slot = hexToBytes(keccak256(new Uint8Array([...data.subarray(36, 68), ...hexToBytes(keccak256(new Uint8Array([...data.subarray(4, 36), ...NONCES_LOCATION])))])));
    const evm = input._EVM as unknown as EVM, at = hexToBytes(NONCE_MANAGER);
    const cost = gas + (evm.journal.isWarmedStorage(at, slot) ? 100n : 2_100n);
    if (cost > gasLimit) return aaOutOfGas(gasLimit);
    evm.journal.addWarmedStorage(at, slot);
    const value = setLengthLeft(await evm.stateManager.getStorage(createAddressFromString(NONCE_MANAGER), slot), 32);
    return value.subarray(0, 24).some(b => b !== 0) ? aaAnswer(cost, gasLimit, PANIC_OVERFLOW, true) : aaAnswer(cost, gasLimit, value);
  };
  const txContext = (input: PrecompileInput) => {
    const { data, gasLimit } = input;
    if (data.length < 4 || !TX_SENDER.has(bytesToHex(data.subarray(0, 4)))) return aaAnswer(0n, gasLimit, echoSelector(data), true);
    return aaAnswer(3n, gasLimit, setLengthLeft((originOf(input._EVM) ?? createAddressFromString(ZERO)).bytes, 32));
  };
  return [{ address: NONCE_MANAGER as Hex, function: nonceManager }, { address: TX_CONTEXT as Hex, function: txContext }];
}

/**
 * A message hook for an EVM with Base's AA precompiles: notes each transaction's sender (a message at depth 0 is
 * sent by it) for TxContext, and gives a call that NonceManager or TxContext refuses for the way it is made
 * (BASE_AA_REFUSED) the refusal to run in their place.
 */
function baseAaHook(origins: WeakMap<object, Address>, evm: object) {
  return (m: { to?: Address; _codeAddress?: Address; caller: Address; value: bigint; depth: number; code?: unknown; isCompiled: boolean }, next?: () => void) => {
    if (m.depth === 0) origins.set(evm, m.caller);
    const code = (m._codeAddress ?? m.to)?.toString();
    if (code && code in BASE_AA_PRECOMPILES) {
      // (Run as another's code is refused first: CALLCODE with value is DelegateCallNotAllowed().)
      const refusal = m.to?.toString() !== code ? BASE_AA_REFUSED.delegated : m.value > 0n ? BASE_AA_REFUSED.value : undefined;
      if (refusal) { m.code = () => ({ executionGasUsed: 0n, returnValue: refusal, exceptionError: new EVMError(EVMError.errorMessages.REVERT) }); m.isCompiled = true; }
    }
    next?.();
  };
}
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
      if (appliedSignature(a)) authority = (await recoverAuthorizationAddress({ authorization: { address: a.address as Hex, chainId: Number(a.chainId), nonce: Number(a.nonce) }, signature: { r: a.r as Hex, s: a.s as Hex, yParity: Number(a.yParity) } })).toLowerCase();
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
 * authorizations, the execution, less the refund (at most a fifth of the total), and where the chain has it (`floored`:
 * from Prague on, Arbitrum aside), at least EIP-7623's calldata floor.
 */
function transactionGas(req: SimulationRequest, execution: bigint, refund: bigint, floored: boolean, amsterdam = false): bigint {
  const { intrinsic, floor } = intrinsicGas(req, amsterdam);
  const used = intrinsic + execution;
  const net = used - (refund < used / 5n ? refund : used / 5n);
  return (floored || amsterdam) && floor > net ? floor : net;
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

/** A request as eth_simulateV1 takes a call. */
const nodeCall = (r: SimulationRequest) => { const hex = (v: bigint) => `0x${v.toString(16)}`; return { from: r.from, ...(r.to && { to: r.to }), data: r.data, value: hex(r.value), ...(r.gas !== undefined && { gas: hex(r.gas) }), ...priceFields(r),
  ...(r.accessList && { accessList: r.accessList }), ...(r.authorizationList?.length && { authorizationList: authorizationsForNode(r.authorizationList) }) }; };
/**
 * At most this many calls in one eth_simulateV1 the node runs for the local EVM (runOnNode), counted across its blocks:
 * Arbitrum One's public node answers HTTP 429 to any more, every time (30 ran, 31 never did; 15+15 ran and 15+16 did
 * not, 2026-11-16).
 */
const NODE_CALLS = 30;
/** An empty account (no code, never used): runOnNode's call that takes a simulated block's first-call difference. */
const L1_PROBE = '0x5717e5a1c0de0000000000000000000000001ce5';
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
  last?: { rounds: number; requests: number; ms: number; /** Calls the EVM ran, in all the rounds (a round resumed past one doesn't run it again). */ calls?: number; /** Views run around them (a balance, an allowance), in all the rounds. */ views?: number; trace?: StorageStep[] };
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
    source.metered = new Set(profile.revertsKeepGas ?? []);
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
      source.after = { bumps, ...(at.state && { state: at.state }), blockOverrides: nodeOverrides(at.header), calls: earlier.map(toCall), earlier, fit: async () => { const requests = fitGas(earlier, await at.beforeUsed?.(), at.header.gasLimit); return requests && { requests, calls: requests.map(toCall) }; },
        related: async () => { const kept = await at.related?.().catch(() => undefined); const part = kept && kept.length < earlier.length ? kept.map(i => earlier[i]) : undefined; return part && { calls: part.map(toCall), earlier: part }; } };
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
    // Tokens and approvals to read around each call: those the calls name (targets, calldata, decoder hints) and the
    // chain's well-known tokens, then those the logs reveal. Named ones matter: WETH-style wrappers emit Deposit and
    // Withdrawal, not Transfer, so logs alone miss the wrapped token. The accounts whose balances are read aren't
    // tokens (as eth_simulateV1's reads have it), but a call's sender for another account is none of them: an
    // operation's calls alone are run from its EntryPoint, and an operation run whole after them needs the EntryPoint
    // read, for its account's deposit (withoutGas, in src/erc4337-sim.ts).
    const skip = (a: string) => reqs.some(r => hexOf(r.account ?? r.from) === a) || a === ZERO || BigInt(a) < 0x10000n;
    const tokens = new Set<string>((this.opts.watchTokens ? [
      ...reqs.flatMap(r => [...(r.watch ?? []), ...(r.to ? [r.to] : []), ...calldataCandidates(r.data).addresses]).map(hexOf).slice(0, 40),
      ...builtinTokens(chainId).map(t => hexOf(t.address)),
    ] : reqs.flatMap(r => r.watch ?? []).map(hexOf)).filter(a => !skip(a)));
    // The senders and targets are certain to be read, and so are the tokens read around each call (and the address
    // 0, which reads them), and the account a replay's priced calls tip: fetch them before the first run.
    const first = newMisses();
    for (const r of reqs) { first.accounts.add(hexOf(r.from)); if (r.account) first.accounts.add(hexOf(r.account)); if (r.to) first.accounts.add(hexOf(r.to)); }
    for (const t of tokens) first.accounts.add(t);
    if (tokens.size) first.accounts.add(ZERO);
    const fixed = at?.header ?? this.opts.header?.(chainId);
    const tipped = profile.arbitrum ? Object.values(ARBITRUM_FEES) : [profile.tipsTo ?? fixed?.coinbase, profile.baseFeeTo];
    if (reqs.some(r => r.gas !== undefined && r.gasPrice)) for (const a of tipped) if (a) first.accounts.add(hexOf(a));
    // (And the contracts a block's start writes into, and the parent's hash it writes: run.)
    if (!profile.arbitrum) { first.accounts.add(HISTORY_STORAGE); first.accounts.add(BEACON_ROOTS); if (fixed && fixed.number > 0n) first.blocks.add(Number(fixed.number - 1n)); }
    // And what the node says the calls will touch (eth_createAccessList), read with them: the local EVM then needs
    // fewer rounds of reads, each a wait on the node, longer where it rate limits, and each a run of every call again.
    // Asked in one batch for up to eight calls: the first four and the last four, where a replay's own transaction is
    // (asked for the first four only, a Sepolia replay's own transaction behind four of its block's earlier ones went
    // without, and its reads took nine rounds, 2026-11-15). (Not Base's native contracts, whose storage is read their
    // own way after a block's earlier transactions; not a chain whose RPC has no such method, HyperEVM's.)
    // (Both at once: the senders and targets are read while the node is asked, then what it named. Not after a
    // block's earlier transactions, which each read runs again on the node first: there, one read of it all.)
    const together = !!source.after;
    const known = together ? Promise.resolve() : source.fetch(first);
    const listed = this.opts.prefetch === false || NO_ACCESS_LIST.has(chainId) || WITHOUT_ACCESS_LISTS.has(url) ? (together ? source.fetch(first) : Promise.resolve()) : (async () => {
      const named = newMisses();
      const { lists, none } = await source.accessLists((reqs.length <= 8 ? reqs : [...reqs.slice(0, 4), ...reqs.slice(-4)]).map(nodeCall));
      // (A node without the method isn't asked again: Arbitrum One's public node, which rate-limits by request.)
      if (none) WITHOUT_ACCESS_LISTS.add(url);
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
    const context = fixed ? Promise.resolve({ header: { ...fixed, timestamp: at?.header.ownTimestamp ?? fixed.timestamp, ...(at?.header.ownTimestamp !== undefined && at.header.ownMilliseconds !== undefined && { milliseconds: at.header.ownMilliseconds }), coinbase: createAddressFromString(fixed.coinbase), difficulty: 0n, prevRandao: hexToBytes(fixed.prevRandao), getBlobGasPrice: () => fixed.blobBaseFee ?? 1n }, arbBlockNumber: fixed.arbBlockNumber ?? fixed.number, amsterdam: fixed.amsterdam })
      : this.blockContext(source, tag, profile);
    // Ethereum's past blocks run under the rules of their time; every other chain's under today's (see rulesNote).
    // A block of Amsterdam's (Glamsterdam: its header says so) runs Amsterdam's rules, on Ethereum and its testnet.
    const rulesAt = (b: Awaited<typeof context>) => {
      const amsterdam = ETHEREUM_RULES.has(chainId) && !!b.amsterdam;
      const hardfork = amsterdam ? 'amsterdam' : chainId === 1 && at?.required ? mainnetForkAt(at.header, profile.hardfork) : profile.hardfork;
      const p = hardfork !== profile.hardfork ? { ...profile, hardfork } : profile;
      return { profile: p, common: createCustomCommon({ chainId }, Mainnet, { hardfork: p.hardfork as never, ...(p.eips && { eips: p.eips }) }) };
    };
    // Meanwhile, what the reads around each call need (a token behind a proxy: its implementation, then the owner's
    // slot in it), found by running those reads alone (warmViews): each such round is a wait on the node, where as
    // part of the calls' rounds it is a run of every call too. (Not where the calls run after a block's earlier
    // transactions on the node, whose every read runs those again.)
    const warmed = together || !tokens.size ? undefined : Promise.all([known, context]).then(([, b]) => { const r = rulesAt(b); return this.warmViews(reqs, source, r.common, b, r.profile, tokens, deadline); }).catch(() => { /* only reading ahead */ });
    const [block, , rules] = await Promise.all([context, Promise.all([known, listed, warmed]), this.rulesOf(chainId, source)]);
    let common: ReturnType<typeof createCustomCommon>;
    ({ profile, common } = rulesAt(block));
    source.time = block.header.timestamp;
    // Precompiles the node lists that this EVM neither has nor forwards (Base's own since November 2026): refused.
    const own = getActivePrecompiles(common), forwards = new Set([...(profile.forwardedPrecompiles ?? []), ...Object.keys(profile.ownPrecompiles ?? {})].map(hexOf));
    // (The chain's own precompiles a fork adds the local EVM has on both sides of it, an empty account before: none
    // is refused, whatever the node's current fork lists.)
    for (const p of profile.timedPrecompiles ?? []) forwards.add(p.address);
    // (Base's NonceManager and TxContext the local EVM runs from Base's upgrade of 2026-11-05 on: BASE_AA_PRECOMPILES.)
    for (const a of chainPrecompilesAt(chainId, block.header.timestamp)) forwards.add(a);
    for (const [address, name] of rules?.precompiles ?? []) if (!own.has(address.slice(2)) && !forwards.has(address) && !hasReference(chainId, address)) source.nodeOnly.set(address, name);
    const rulesNote = rulesNoteOf(chainId, profile, rules, at);
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

  /**
   * The reads a run makes around each call (each account's balance of each token watched, whether a token is an
   * NFT contract, the fee recipient), run alone on the state the calls start from, a few rounds while they find
   * something new to fetch. A token behind a proxy takes three: the token, its implementation, the owner's slot in
   * it. Found as part of the calls' rounds, each of those is a run of every call again: four of the nine rounds of a
   * Sepolia replay behind three of its block's 2.5-million-gas transactions were USDC's (2026-11-15). Only finding
   * what to fetch: whatever these reads come to, the calls' own runs read again.
   */
  private async warmViews(reqs: SimulationRequest[], source: StateSource, common: ReturnType<typeof createCustomCommon>, block: Awaited<ReturnType<ForkSimulator['blockContext']>>, profile: ChainProfile, tokens: Set<string>, deadline: number): Promise<void> {
    const owners = [...new Set(reqs.map(r => hexOf(r.account ?? r.from)))];
    const reads: [string, Uint8Array][] = [];
    for (const t of tokens) {
      for (const o of owners) reads.push([t, hexToBytes(`0x70a08231${o.slice(2).padStart(64, '0')}`)]);
      reads.push([t, hexToBytes(`0x01ffc9a780ac58cd${'00'.repeat(28)}`)]);
    }
    source.time ??= block.header.timestamp;
    // (The views that burn their gas answering nothing, as this EVM runs them: kept apart from the run's own. This one
    // has none of the chain's precompiles or hooks, so a view here can fail where the run's answers: a B20 token's,
    // whose marker code the run's EVM swaps for its reference, or one that asks ArbSys.)
    const memo: StateSource['spent'] = new Map();
    for (let round = 0; round < 6 && Date.now() < deadline; round++) {
      const misses = newMisses();
      const state = new LazyState(source, misses, { common });
      const evm = await createEVM({ common, stateManager: state, ...storagePricing(profile) });
      try { await state.getAccount(block.header.coinbase); } catch { /* see below */ }
      for (const [to, data] of reads) {
        try { await viewCall(evm, source, misses, to, data, block, memo); } catch { /* a read the calls' runs will make, and say why it fails */ }
      }
      if (!missCount(misses)) return;
      await source.fetch(misses);
    }
  }

  private async rounds(reqs: SimulationRequest[], auths: Authorization[][], source: StateSource, common: ReturnType<typeof createCustomCommon>, block: Awaited<ReturnType<ForkSimulator['blockContext']>>,
    profile: ChainProfile, tokens: Set<string>, approvals: Map<string, SimulatedApproval>, chainId: number, started: number, deadline: number, key: string, reportedFrom = 0): Promise<SimulationResult[]> {
    let watched = 0, answer: Awaited<ReturnType<ForkSimulator['run']>> | undefined;
    // Where the last runs got to on fetched values alone (RunSnapshot): the next starts there, while the tokens and
    // approvals watched are the same.
    let resume: (RunSnapshot & { watching: string }) | undefined;
    const watching = () => `${[...tokens].join()}|${[...approvals.keys()].join()}`;
    // Where the runs hand the batch to the chain's node (a request that reached a Stylus program from inside another
    // contract: StylusReached), once a run has come to one on fetched values alone.
    let nodeFrom: NodeFrom | undefined;
    for (let round = 1; ; round++) {
      const misses = round <= this.opts.maxRounds ? newMisses() : null;
      const now = watching();
      let run: Awaited<ReturnType<ForkSimulator['run']>>;
      try {
        // (A snapshot is from before where the node takes over: none is kept past it.)
        run = await this.run(reqs, auths, source, misses, common, block, profile, tokens, approvals, chainId, resume?.watching === now && !(nodeFrom && resume.at > nodeFrom.at) ? resume : undefined, nodeFrom);
        if (run.snapshot) resume = { ...run.snapshot, watching: now };
      } catch (e) {
        // (An extra run, with a later-seen token watched, out of time: the answer it was to improve stands.)
        if (e instanceof ForkTimeout && answer) {
          this.last = { rounds: round - 1, requests: source.requests, ms: Date.now() - started, ...source.ran, ...(answer.trace && { trace: answer.trace }) };
          return answer.results;
        }
        // A Stylus program reached from inside another contract on values read from the chain, nothing guessed: the
        // run is thrown away, what it had begun of that request with it, and run again with that request and the
        // ones after it on the chain's node. (Reached on a value guessed, it may not be reached at all: the values
        // are fetched, and the round run again, as for any break.) Each time at an earlier request, or it is refused:
        // the calls before it read nothing guessed and ran as they will in every run.
        if (e instanceof StylusReached && (!misses || !missCount(misses)) && e.request < (nodeFrom?.at ?? reqs.length)) {
          const to = reqs[e.request].to;
          nodeFrom = { at: e.request, program: e.program, call: e.call, ...(!e.call && to && e.read === hexOf(to) && { ownRead: true }) };
          round--;
          continue;
        }
        if (e instanceof ForkTimeout || (e instanceof ForkUnsupported && !(e instanceof StylusReached)) || !misses || !missCount(misses)) throw e;
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
        this.last = { rounds: round, requests: source.requests, ms: Date.now() - started, ...source.ran, ...(run.trace && { trace: run.trace }) };
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
      gasLimit: next.gasLimit > GAS ? next.gasLimit : GAS, baseFeePerGas: next.baseFeePerGas, getBlobGasPrice: () => 1n, ...(next.slotNumber !== undefined && { slotNumber: next.slotNumber }), ...(next.milliseconds !== undefined && { milliseconds: next.milliseconds }), ...(next.beaconRoot && { beaconRoot: next.beaconRoot }) }, arbBlockNumber: next.arbBlockNumber ?? next.number, amsterdam: next.amsterdam };
  }

  /**
   * One run of the calls, in order, on a fresh state over `source`; or, given `resume`, of the calls from where an
   * earlier run got to on fetched values alone, on the state it had there (RunSnapshot). Given `nodeFrom`, the calls
   * from there on are the chain's node's (runOnNode).
   */
  private async run(reqs: SimulationRequest[], auths: Authorization[][], source: StateSource, misses: Misses | null, common: ReturnType<typeof createCustomCommon>, block: Awaited<ReturnType<ForkSimulator['blockContext']>>,
    profile: ChainProfile, tokens: Set<string>, watchedApprovals: Map<string, SimulatedApproval>, chainId: number, resume?: RunSnapshot, nodeFrom?: NodeFrom) {
    const state = new LazyState(source, misses, { common });
    if (resume) state.restore(resume.state);
    // The point-evaluation precompile (EIP-4844's, at 0x0a) needs a KZG library and trusted setup this package doesn't
    // carry. It is a pure function of its input, so the chain's node answers it, at the precompile's fixed price.
    const pointEvaluation = getActivePrecompiles(common).has(POINT_EVALUATION.slice(2)) && !profile.noPointEvaluation ? [POINT_EVALUATION] : [];
    // The chain's answer to a forwarded call (eth_call); undefined in a speculative run that hasn't fetched it yet.
    const ask = async (address: string, data: Uint8Array) => {
      const key = `${address}_${bytesToHex(data)}`;
      let c = source.calls.get(key);
      if (!c && misses) {
        misses.calls.add(key);
        c = source.guessCall(key);
        if (!c) return undefined;
      }
      if (!c) {
        await source.fetch({ ...newMisses(), calls: new Set([key]) });
        c = source.calls.get(key)!;
      }
      return c;
    };
    // ArbOS's precompiles need the call they are in (who calls, what value, a static call, a delegate call or
    // callcode), which a precompile isn't given: the last message to each, as it is about to run.
    const toArbOs = new Map<string, ArbOsCall>();
    const burnt = (gasLimit: bigint, error = EVMError.errorMessages.OUT_OF_GAS) => ({ executionGasUsed: gasLimit, returnValue: new Uint8Array(0), exceptionError: new EVMError(error) });
    /**
     * ArbSys.sendTxToL1 and withdrawEth, as the node runs them (src/evm/arbos.ts): the value sent leaves ArbSys's
     * balance (burned), the send joins ArbOS's send-merkle accumulator (its storage, read and written here), and
     * ArbSys's events are the call's. With arguments it can't decode the node's call fails and burns all it was
     * given; in a static call, a delegate call or callcode too, which are turned away before this (ARBOS_METHODS).
     */
    const arbSysSend = async (input: { data: Uint8Array; gasLimit: bigint }) => {
      const m = toArbOs.get(ARBSYS);
      if (!m || m.isStatic || m.foreign) return undefined;
      const withdraw = bytesToHex(input.data.subarray(0, 4)) === WITHDRAW_ETH;
      let destination: string, data: Hex;
      try {
        [destination, data] = withdraw ? [decodeAbiParameters([{ type: 'address' }], bytesToHex(input.data.subarray(4)))[0], '0x']
          : decodeAbiParameters([{ type: 'address' }, { type: 'bytes' }], bytesToHex(input.data.subarray(4))) as [string, Hex];
      } catch { return burnt(input.gasLimit, EVMError.errorMessages.REVERT); }
      const at = createAddressFromString(ARBOS_STATE);
      const send = await l1Send({ caller: m.caller, destination: destination.toLowerCase(), value: m.value, data, arbBlockNumber: block.arbBlockNumber, l1BlockNumber: block.header.number, timestamp: block.header.timestamp }, input.data.length, {
        get: async slot => { const v = await state.getStorage(at, hexToBytes(slot)); return v.length ? BigInt(bytesToHex(v)) : 0n; },
        set: async (slot, v) => state.putStorage(at, hexToBytes(slot), v === 0n ? new Uint8Array(0) : unpadBytes(hexToBytes(`0x${v.toString(16).padStart(64, '0')}`))),
      });
      if (send.gas > input.gasLimit) return burnt(input.gasLimit);
      await send.apply();
      if (m.value > 0n) {
        const arbSys = createAddressFromString(ARBSYS), account = (await state.getAccount(arbSys)) ?? new Account();
        account.balance = account.balance > m.value ? account.balance - m.value : 0n;
        await state.putAccount(arbSys, account);
      }
      return { executionGasUsed: send.gas, returnValue: hexToBytes(`0x${send.position.toString(16).padStart(64, '0')}`),
        logs: send.logs.map(l => [hexToBytes(l.address), l.topics.map(t => hexToBytes(t)), hexToBytes(l.data)] as [Uint8Array, Uint8Array[], Uint8Array]) };
    };
    const forwarded = [...(profile.forwardedPrecompiles ?? []), ...pointEvaluation].map(address => ({ address: address as Hex, function: async (input: { data: Uint8Array; gasLimit: bigint; _EVM?: unknown }) => {
      const selector = bytesToHex(input.data.subarray(0, 4));
      // What ArbOS turns away before a method runs, by how it is called here (ARBOS_METHODS): it burns all the call
      // was given, but ArbFilteredTransactionsManager's, which reverts at its 1,600 and keeps the rest.
      const made = profile.arbitrum && input._EVM === evm ? toArbOs.get(address) : undefined;
      if (made && turnedAway(address, selector, made)) {
        return address === ARB_FILTERED_TRANSACTIONS && input.gasLimit >= 1_600n ? { executionGasUsed: 1_600n, returnValue: new Uint8Array(0), exceptionError: new EVMError(EVMError.errorMessages.REVERT) } : burnt(input.gasLimit, EVMError.errorMessages.REVERT);
      }
      // ArbSys.arbBlockNumber(): the simulated block's own number, which the chain can't be asked for yet. (Given less
      // than its price, it fails as any of ArbOS's calls does, burning all it was given: 802 gas on Arbitrum One's node.)
      if (profile.arbitrum && address === ARBSYS && selector === '0xa3b1b31d') {
        const price = profile.precompileGas?.(4, 32, '0xa3b1b31d') ?? 2000n;
        if (price > input.gasLimit) return burnt(input.gasLimit);
        return { executionGasUsed: price, returnValue: hexToBytes(`0x${block.arbBlockNumber.toString(16).padStart(64, '0')}`) };
      }
      // ArbInfo's getBalance and getCode: the simulation's own (ARB_INFO).
      if (profile.arbitrum && address === ARB_INFO && (selector === ARB_GET_BALANCE || selector === ARB_GET_CODE) && input.data.length >= 36) {
        const who = createAddressFromString(bytesToHex(input.data.subarray(16, 36)));
        const words = (n: number) => BigInt(Math.ceil(n / 32));
        if (selector === ARB_GET_BALANCE) {
          const price = 1_500n + 3n * (words(input.data.length - 4) + 1n);
          if (price > input.gasLimit) return burnt(input.gasLimit);
          return { executionGasUsed: price, returnValue: setLengthLeft(bigIntToBytes((await state.getAccount(who))?.balance ?? 0n), 32) };
        }
        const code = await state.getCode(who), out = hexToBytes(encodeAbiParameters([{ type: 'bytes' }], [bytesToHex(code)]));
        const price = 2_900n + 3n * words(code.length) + 3n * (words(input.data.length - 4) + words(out.length));
        if (price > input.gasLimit) return burnt(input.gasLimit);
        return { executionGasUsed: price, returnValue: out };
      }
      // (Run here only in the transaction's own EVM, whose messages are followed; the views read around it never send.)
      if (profile.arbitrum && address === ARBSYS && (selector === SEND_TX_TO_L1 || selector === WITHDRAW_ETH) && input._EVM === evm) {
        const sent = await arbSysSend(input);
        if (sent) return sent;
      }
      const key = `${address}_${bytesToHex(input.data)}`;
      const c = await ask(address, input.data);
      if (!c) return { executionGasUsed: 2000n, returnValue: new Uint8Array(0) };
      // A retryable's redeem, keepalive or cancel that would do something (its ticket exists: the chain's answer is no
      // NoTicketWithID()) is refused: what it changes isn't in an eth_call's answer (ARBOS_WRITES). Only on an answer
      // fetched for this run, not a guess, and only with a ticket id to read (36 bytes): ArbOS can't decode shorter
      // calldata, and the node's call fails burning all it was given (as the meter below finds), the rest of the
      // transaction going on (measured 2026-11-15: the selector alone, 35 bytes, 20 bytes of argument).
      if (profile.arbitrum && address === ARB_RETRYABLE_TX && ARBOS_WRITES[selector] && input.data.length >= 36 && source.calls.has(key) && !(!c.ok && bytesToHex(c.data) === NO_TICKET_WITH_ID)) {
        throw new ForkUnsupported(`the call reaches ArbRetryableTx.${ARBOS_WRITES[selector]} (Arbitrum's 0x6e) for a ticket that exists, whose effect the local EVM doesn't run${ARBOS_WRITES[selector] === 'redeem' ? ' (the chain runs the retry as a transaction of its own, after this one, on all the gas this call has left)' : ''}`);
      }
      // A revert of ArbOS's: charged what the node's own call of it was (REVERT_METER), keeping the rest, or burning
      // all it was given where the node's burnt all or the charge is more than this call was given.
      if (!c.ok && profile.revertsKeepGas?.includes(address)) {
        const meterKey = `${key}_gas`;
        let m = source.calls.get(meterKey);
        if (!m && misses) {
          // (Fetched with the answer it follows; asked for here only where that answer is fresh.)
          if (source.calls.has(key)) misses.calls.add(meterKey);
          m = source.guessCall(meterKey);
        } else if (!m) {
          await source.fetch({ ...newMisses(), calls: new Set([meterKey]) });
          m = source.calls.get(meterKey);
        }
        // (Where the meter's call succeeded, the two calls' answers differ, as for a method that asks who calls: not used.)
        if (m?.ok && m.data.length === 64 && m.data[63] === 0) {
          const spent = BigInt(bytesToHex(m.data.subarray(0, 32))) - METER_OVERHEAD;
          return spent < METERED_GAS && spent <= input.gasLimit ? { executionGasUsed: spent, returnValue: c.data, exceptionError: new EVMError(EVMError.errorMessages.REVERT) } : burnt(input.gasLimit, EVMError.errorMessages.REVERT);
        }
      }
      let gas = address === POINT_EVALUATION ? profile.pointEvaluationGas ?? 50_000n : profile.precompileGas?.(input.data.length, c.data.length, selector, address) ?? 2000n;
      // ArbosTest.burnArbGas burns what it is asked to, on top (1,003 for 1,000, measured). Asked for more than the call
      // has left after its argument's 3 a word, it burns all of that and succeeds: ArbOS ignores its running out there
      // (measured 2026-11-15, on 10,000 gas: 9,997 spends 10,000; 9,998, 20,000 and 2^64 - 1 spend 10,000 too and
      // succeed, by a call, a static call or a delegate call; 5,000,000 on all a call can be given likewise).
      if (profile.arbitrum && address === ARBOS_TEST && selector === BURN_ARB_GAS && input.data.length >= 36) {
        const burn = BigInt(bytesToHex(input.data.subarray(4, 36)));
        if (c.ok && gas <= input.gasLimit && gas + burn > input.gasLimit) return { executionGasUsed: input.gasLimit, returnValue: c.data };
        gas += burn;
      }
      // (Given less than it costs, it runs out, as the node's does.)
      if (gas > input.gasLimit) return { executionGasUsed: input.gasLimit, returnValue: new Uint8Array(0), exceptionError: new EVMError(EVMError.errorMessages.OUT_OF_GAS) };
      // A revert burns all the call was given, but ArbOS's where the node couldn't be asked what it was charged:
      // with an error to decode (and every one of ArbFilteredTransactionsManager's), they keep what they weren't
      // charged (ChainProfile.revertsKeepGas).
      const keeps = !c.ok && !!profile.revertsKeepGas?.includes(address) && (c.data.length > 0 || address === ARB_FILTERED_TRANSACTIONS);
      return c.ok ? { executionGasUsed: gas, returnValue: c.data } : { executionGasUsed: keeps ? gas : input.gasLimit, returnValue: c.data, exceptionError: new EVMError(EVMError.errorMessages.REVERT) };
    } }));
    // The chain's own precompiles at their own prices (ChainProfile.ownPrecompiles): run here, or answered by the chain.
    const chainOwn = Object.entries(profile.ownPrecompiles ?? {}).map(([address, p]) => ({ address: address as Hex, function: async (input: { data: Uint8Array; gasLimit: bigint }) => {
      const gas = p.gas(input.data, block.header.timestamp), none = new Uint8Array(0);
      if (gas > input.gasLimit) return { executionGasUsed: input.gasLimit, returnValue: none, exceptionError: new EVMError(EVMError.errorMessages.OUT_OF_GAS) };
      const c = p.run ? (out => ({ ok: !!out, data: out ?? none }))(p.run(input.data)) : await ask(address, input.data);
      // (A speculative run without the chain's answer yet: the price, and nothing back.)
      if (!c) return { executionGasUsed: gas, returnValue: none };
      if (c.ok) return { executionGasUsed: gas, returnValue: c.data };
      return p.fails === 'revert' ? { executionGasUsed: gas, returnValue: c.data, exceptionError: new EVMError(EVMError.errorMessages.REVERT) }
        : { executionGasUsed: input.gasLimit, returnValue: none, exceptionError: new EVMError(`${p.name} failed` as EVMError['error']) };
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
    // (Nor NonceManager or TxContext, which the local EVM has at their own addresses only.)
    const aa = chainPrecompilesAt(chainId, block.header.timestamp);
    const aaAway = reqs.flatMap(r => Object.entries(r.stateOverrides ?? {})).find(([a, o]) => o.movePrecompileToAddress && aa.includes(hexOf(a)));
    if (aaAway) throw new ForkUnsupported(`${hexOf(aaAway[0])} is Base's ${BASE_AA_PRECOMPILES[hexOf(aaAway[0])]}, which the local EVM has at its own address only: it can't be moved for the simulation`);
    // (Nor another precompile moved onto theirs: Base's node then runs the one moved there.)
    const aaOnto = reqs.flatMap(r => Object.values(r.stateOverrides ?? {})).find(o => o.movePrecompileToAddress && aa.includes(hexOf(o.movePrecompileToAddress)));
    if (aaOnto) throw new ForkUnsupported(`${hexOf(aaOnto.movePrecompileToAddress!)} is Base's ${BASE_AA_PRECOMPILES[hexOf(aaOnto.movePrecompileToAddress!)]}: a precompile moved onto it isn't run by the local EVM`);
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
    // Base's NonceManager and TxContext (BASE_AA_PRECOMPILES), given the sender of the transaction each EVM runs.
    const origins = new WeakMap<object, Address>();
    const ownAa = aa.length ? baseAaPrecompiles(on => origins.get(on as object)) : [];
    const precompiles = [...scaled, ...timed, ...forwarded, ...chainOwn, ...moved, ...absent, ...ownAa];
    const evm: EVM = await createEVM({ common, stateManager: state, customPrecompiles: precompiles, blockchain, ...storagePricing(profile) });
    // (What the calls before touched, for the empty accounts among them that the next call's start removes, EIP-161.)
    const journal = evm.journal as unknown as { touched: Set<string> };
    if (resume) journal.touched = new Set(resume.touched);
    if (ownAa.length) evm.events!.on('beforeMessage', baseAaHook(origins, evm));
    if (profile.arbitrum) evm.events!.on('beforeMessage', (m: { to?: Address; _codeAddress?: Address; caller: Address; value: bigint; isStatic: boolean; delegatecall: boolean }, next?: () => void) => {
      // (A delegate call or callcode runs the precompile's code as the calling account: `to` isn't the precompile.)
      const code = (m._codeAddress ?? m.to)?.toString();
      if (code && ARBOS.includes(code)) toArbOs.set(code, { caller: m.caller.toString(), value: m.value, isStatic: m.isStatic, foreign: m.delegatecall || m.to?.toString() !== code });
      next?.();
    });
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
    // (A view gets 10 million gas, and one that burns it answering nothing isn't run again: viewCall.)
    const viewOn = (on: EVM, to: string, data: Hex) => viewCall(on, source, misses, to, hexToBytes(data), block);
    const view = (to: string, data: Hex) => viewOn(evm, to, data);
    const balanceOf = async (token: string, owner: string) => { const r = await view(token, `0x70a08231${owner.slice(2).padStart(64, '0')}` as Hex); return r ? word(r) : undefined; };
    // The state before the first call is the chain's own: a token its logs reveal can be read there afterwards, on a
    // second EVM, instead of running everything again with the token watched from the start.
    let pre: EVM | undefined;
    const balanceBefore = async (token: string, owner: string) => {
      if (!pre) {
        const preState = new LazyState(source, misses, { common });
        pre = await createEVM({ common, stateManager: preState, customPrecompiles: precompiles, blockchain, ...storagePricing(profile) });
        if (ownAa.length) pre.events!.on('beforeMessage', baseAaHook(origins, pre));
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
    const nft = new Map<string, boolean>(resume?.nft);
    const isNft = async (t: string) => {
      if (!nft.has(t)) { const r = await view(t, `0x01ffc9a780ac58cd${'00'.repeat(28)}` as Hex); nft.set(t, !!r && word(r) === 1n); }
      return nft.get(t)!;
    };

    const results: SimulationResult[] = [...resume?.results ?? []], byRequest: string[][] = [...resume?.byRequest ?? []];
    const seenTokens = new Set<string>(resume?.seenTokens), seenApprovals: SimulatedApproval[] = [...resume?.seenApprovals ?? []];
    // A token or approval first seen in a later call of a batch must be read around the calls before it too.
    let rerun = resume?.rerun ?? false;
    const grewAt: number[] = [...resume?.grewAt ?? []];
    const touched = new Map<string, SimulatedApproval>(resume?.touchedApprovals ?? watchedApprovals);
    const source_ = `local EVM over chain ${chainId} state (the RPC has no eth_simulateV1)`;
    // Between two calls of a speculative run that has read nothing it had to guess yet, the calls before are what
    // they will be in every later run, on the state they left: kept (RunSnapshot), so that the next round starts at
    // the first call that guessed instead of running them all again. A replay's earlier transactions can be most of
    // the time (a Sepolia block's that each loop through 2.5 million gas: a third of a second to over a second each
    // in this EVM), and a round is needed for each read that only an earlier one shows. (Not with storage steps
    // recorded, which number the calls of one run; not on Base, whose B20 tokens' bookkeeping runs across a run's
    // calls.)
    const keeps = !!misses && !this.opts.trace && chainId !== BASE;
    let snapshot: RunSnapshot | undefined;
    const start = resume?.at ?? 0;
    // What a block's start writes before its first transaction, as the chain's node does in its simulated block too:
    // EIP-2935's history (from Prague: the parent's hash, at slot (number - 1) % 8191) and EIP-4788's beacon root (at
    // the block's time: slot time % 8191 holds the time, the slot 8,191 after it the root), where their contracts have
    // code. Before, the local EVM wrote neither: on Ethereum, the history contract answered the block before with the
    // hash of the one 8,191 before it, and a read of the root at the block's own time reverted, so EigenLayer's
    // EigenPod.startCheckpoint failed (InvalidEIP4788Response) where the node's run succeeded (2026-11-16). Not on
    // Arbitrum, whose node's simulated block writes neither (ArbOS keeps its own history, which the chain's blocks
    // write); HyperEVM has neither contract.
    if (!resume && !profile.arbitrum) {
      const write = async (contract: string, slot: bigint, value: Uint8Array) => {
        const at = createAddressFromString(contract);
        if (!(await state.getCode(at)).length) return;
        await state.putStorage(at, setLengthLeft(hexToBytes(`0x${slot.toString(16)}`), 32), unpadBytes(value));
      };
      const n = block.header.number as bigint, time = block.header.timestamp as bigint, root = (block.header as { beaconRoot?: Hex }).beaconRoot;
      if (!BEFORE_PRAGUE.has(profile.hardfork) && n > 0n) await write(HISTORY_STORAGE, (n - 1n) % 8191n, (await blockchain.getBlock(Number(n - 1n))).hash());
      if (root !== undefined) {
        await write(BEACON_ROOTS, time % 8191n, hexToBytes(`0x${time.toString(16).padStart(64, '0')}`));
        await write(BEACON_ROOTS, time % 8191n + 8191n, hexToBytes(root));
      }
    }
    // From the request that reaches a Stylus program on, the calls are the chain's node's (rounds' `nodeFrom`, or a
    // request whose own target is one, found below).
    let onNode = nodeFrom;
    /** The node's results for requests asked with an earlier one (runOnNode's group), and whether to ask one by one. */
    const ahead = new Map<number, SimulationResult>();
    let oneByOne = false;
    /** Whether a call ran (one its sender couldn't pay for didn't, and has no gas). */
    const ran = (r: SimulationResult | undefined) => r?.gasUsed !== undefined;
    for (let i = start; i < reqs.length; i++) {
      const req = reqs[i];
      // (Not past where the node takes over: what this EVM holds there isn't the state the calls left.)
      if (keeps && i > start && !missCount(misses!) && !(onNode && i > onNode.at)) {
        const kept = state.snapshot();
        if (kept) snapshot = { at: i, state: kept, touched: [...journal.touched], results: [...results], byRequest: [...byRequest], seenTokens: [...seenTokens], seenApprovals: [...seenApprovals],
          touchedApprovals: [...touched], rerun, grewAt: [...grewAt], nft: [...nft] };
      }
      state.at = { request: i, call: false };
      // `from` is the account whose balances are reported; `caller` sends the call (the same, unless the request
      // names another account, e.g. a smart account the EntryPoint calls into).
      const caller = hexOf(req.from), from = hexOf(req.account ?? req.from), target = req.to ? hexOf(req.to) : ZERO;
      // A call made straight to a Stylus program (Arbitrum's WASM contracts, which the local EVM can't run): the
      // chain's node runs it, and its run is this call's result, its trace one frame (runOnNode). So too a call that
      // reaches one from inside another contract (StylusReached), and every call after either in the batch, which
      // would run here on state this EVM doesn't have: each is run on the node with the batch's calls before it.
      if (!(onNode && i >= onNode.at) && req.to && await state.stylus(target)) onNode = { at: i, program: target, call: true, target: true };
      if (onNode && i >= onNode.at) {
        // (A speculative run that has read something it had to guess isn't the answer: the round is run again once
        // that is fetched, so the node isn't asked yet. Its calls are requests to the node, which rate-limits.)
        if (misses && missCount(misses)) break;
        const why: NodeWhy = { ...onNode, after: i > onNode.at };
        // A call its sender can't pay for fails as any call here does (the node would refuse the whole simulation:
        // "insufficient funds for gas * price + value"): its value, here; with its gas at its price too, when the
        // node says so. (For the first call the node runs: this EVM's state is the one it starts from. For the ones
        // after, the node's refusal says so.)
        const ranBy = `chain ${chainId}'s node, ${nodeReason(why)}`;
        const unpaid = (reason: string) => { results.push({ status: 'reverted', source: ranBy, revertReason: `insufficient funds: ${reason}`, transfers: [], basis: 'fork', refused: true }); byRequest[i] = []; };
        // The sender's nonce as each call starts, which the node counts in its charge for L1 data: as this EVM has it
        // where the node takes over, then up by one for each call it sent that the node ran since, and for each
        // authorization of its own (EIP-7702) for the nonce it had by then.
        const nonceAt = async (j: number) => {
          const sender = hexOf(reqs[j].from);
          let n = (await state.peek(sender)).nonce;
          for (let k = onNode!.at; k < j; k++) {
            // (A call of the group asked with this one runs, or the node refuses them all.)
            if (k < i && !ran(results[k])) continue;
            if (hexOf(reqs[k].from) === sender) n++;
            for (const a of auths[k]) if (a.authority === sender && (a.chainId === 0n || a.chainId === BigInt(chainId)) && (a.nonce === undefined || a.nonce === n)) n++;
          }
          return n;
        };
        let result = ahead.get(i);
        if (!result) {
          if (!why.after && req.value > (await state.peek(caller)).balance) { unpaid(`the account holds ${units(chainId, (await state.peek(caller)).balance)} and the call sends ${units(chainId, req.value)}`); continue; }
          const earlier = reqs.slice(0, i).flatMap((_, k) => (ran(results[k]) ? [k] : []));
          // This call and the ones after it of the same account (up to a creation, refused when its turn comes) are
          // asked in one request, not one each: Arbitrum One's public node lets about one eth_simulateV1 through
          // every 3 to 5 s after a short burst, and a batch with four calls the node ran had taken longer than the
          // time a preview has (2026-11-16). One the node refuses whole (a sender that can't pay) is asked again
          // call by call, so the one that can't pay is told apart.
          let group = [i];
          if (!oneByOne) for (let j = i + 1; j < reqs.length && reqs[j].to && hexOf(reqs[j].account ?? reqs[j].from) === from; j++) group.push(j);
          for (;;) {
            try {
              const nonces = await Promise.all(group.map(nonceAt));
              const got = await this.runOnNode(reqs, group, earlier, auths, source, [...tokens], touched, chainId, profile, nonces, group.map(j => ({ ...onNode!, after: j > onNode!.at })));
              got.forEach((r, g) => ahead.set(group[g], r));
              break;
            } catch (e) {
              if (!/insufficient funds/i.test((e as Error).message ?? '')) throw e;
              if (group.length === 1) break;
              oneByOne = true; group = [i];
            }
          }
          result = ahead.get(i);
          if (!result) { unpaid(`the account can't pay for the call's gas at its price and what it sends (the chain's node refused it)`); continue; }
        }
        results.push(result);
        byRequest[i] = [];
        for (const l of results[i].logs ?? []) if (l.topics[0] === TRANSFER && l.topics.length === 3 && [l.topics[1], l.topics[2]].some(t => `0x${t.slice(26)}` === from) && !tokens.has(hexOf(l.address))) { seenTokens.add(hexOf(l.address)); rerun = true; grewAt.push(i); }
        // The approvals it set are read after the calls after it too, and around the calls before it (as a local run's).
        for (const a of results[i].approvals ?? []) if (a.owner === from) {
          if (i > 0 && !watchedApprovals.has(approvalKey(a))) { rerun = true; grewAt.push(i); }
          seenApprovals.push(a); touched.set(approvalKey(a), a);
        }
        continue;
      }
      // (A Stylus program among the tokens watched can't be read here: its amounts are its events'.)
      const watch: string[] = [];
      for (const t of tokens) if (!await state.stylus(t)) watch.push(t);
      const before = new Map<string, bigint | undefined>();
      // (Each token read noted, for StylusReached, should its read reach a Stylus program before the call has run.)
      for (const t of watch) { state.at.read = t; before.set(t, await balanceOf(t, from)); }
      state.at.read = undefined;
      const nativeBefore = await native(from);
      if (req.value > await native(caller)) {
        // (Refused, as the node refuses it: not mined, so no fee. It was "expected to fail. You would still pay
        // the network fee", where the same transaction on a chain whose node simulates is one "the network would
        // refuse".)
        results.push({ status: 'reverted', source: source_, revertReason: `insufficient funds: the account holds ${units(chainId, nativeBefore)} and the call sends ${units(chainId, req.value)}`, transfers: [], basis: 'fork', refused: true });
        continue;
      }
      // A transaction the network refuses before it runs, as every chain's node refuses it (with its validation off
      // too), so it fails here without running, as on the node's path (rejection, src/simulation.ts): a gas limit
      // under what it pays before its call, or (from Prague, Arbitrum aside, and under Amsterdam) under EIP-7623's
      // calldata floor; initcode over the most a creation may carry (EIP-3860; Amsterdam's EIP-7954); a creation with
      // EIP-7702 authorizations; a sender that can't pay for its gas at its price and what it sends. The local EVM ran
      // them (2026-11-16): a transfer on 20,999 gas succeeded at 21,000, 1,000 nonzero bytes on 60,999 at 61,000, a
      // 49,153-byte creation reverted burning all it had, an unaffordable priced call succeeded; on HyperEVM, where it
      // is the simulator, the preview said "success" for a transaction the chain refuses.
      {
        const amsterdam = profile.hardfork === 'amsterdam', { intrinsic, floor } = intrinsicGas(req, amsterdam);
        const floored = amsterdam || (!BEFORE_PRAGUE.has(profile.hardfork) && !profile.arbitrum);
        const blobs = BigInt(req.blobVersionedHashes?.length ?? 0) * 131_072n * (req.at?.header.blobBaseFee ?? 1n);
        const refused = req.gas !== undefined && req.gas < intrinsic ? `out of gas: the gas limit (${req.gas.toLocaleString('en-US')}) is below the ${intrinsic.toLocaleString('en-US')} any transaction with this calldata pays before it runs (the network refuses it: intrinsic gas too low)`
          : req.gas !== undefined && floored && req.gas < floor ? `out of gas: the gas limit (${req.gas.toLocaleString('en-US')}) is below the ${floor.toLocaleString('en-US')} a transaction with this calldata pays at least (EIP-7623's floor: the network refuses it)`
          : !req.to && (req.data.length - 2) / 2 > Number(common.param('maxInitCodeSize')) ? `max initcode size exceeded: the creation carries ${((req.data.length - 2) / 2).toLocaleString('en-US')} bytes, over the ${Number(common.param('maxInitCodeSize')).toLocaleString('en-US')} a creation may (the network refuses it)`
          : !req.to && (req.authorizationList?.length || req.unsignedAuthorizations?.length) ? 'a transaction with EIP-7702 authorizations can\'t create a contract: the network refuses it'
          : req.gas !== undefined && req.gasPrice && req.gas * req.gasPrice + blobs + req.value > await native(caller) ? `insufficient funds: the account holds ${units(chainId, await native(caller))}, and the gas limit at its price and what the call sends come to ${units(chainId, req.gas * req.gasPrice + blobs + req.value)}`
          : undefined;
        if (refused) { results.push({ status: 'reverted', source: source_, revertReason: refused, transfers: [], basis: 'fork', refused: true }); continue; }
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
      // (The authorities as the transaction found them: under Amsterdam, one that can't pay for the state its
      // authorizations add runs out of gas, and they don't apply. Below.)
      const found = new Map<string, { nonce: bigint; balance: bigint; code: Uint8Array } | null>();
      if (profile.hardfork === 'amsterdam' && req.gas !== undefined) for (const a of auths[i]) {
        if (!a.authority || found.has(a.authority)) continue;
        const at = createAddressFromString(a.authority), account = await state.getAccount(at);
        found.set(a.authority, account ? { nonce: account.nonce, balance: account.balance, code: await state.getCode(at) } : null);
      }
      const authorized = await this.authorize(state, evm, auths[i], chainId, caller);
      // Amsterdam charges an applied authorization for the state it adds, out of the transaction's gas, not as a refund.
      const authRefund = profile.hardfork === 'amsterdam' ? 0n : authorized.refund, authState = profile.hardfork === 'amsterdam' ? authorized.state : 0n;
      // (Arbitrum: less the gas the chain took for the transaction's L1 data before running it, where it is known.)
      // (With none given, 30,000,000 in all, as HyperEVM's node gives an eth_call: GAS read first came out 21,000 and
      // the calldata's cost higher here than there, 2026-11-16. The other nodes give their own caps, 32 to 160 million,
      // which code reading gasleft() alone sees; a call that burns all it is given would take that much longer here.)
      let gasLimit = req.gas ? req.gas - intrinsicGas(req, profile.hardfork === 'amsterdam').intrinsic - authState - (profile.arbitrum ? req.gasForL1 ?? 0n : 0n) : GAS - intrinsicGas(req, profile.hardfork === 'amsterdam').intrinsic - authState;
      // Under Amsterdam, a transaction whose gas, after what it pays before its call, can't pay for the state its
      // authorizations add runs out of gas: all its gas used, nothing run, and its authorizations not applied (its
      // nonce still taken). On Sepolia (2026-11-16) a delegation sent on 29,724 gas, 19,816 of it paid before its call
      // and the delegation's state 35,190, failed using all 29,724, the account left without code; the local EVM had
      // applied it and reported 55,006 gas, over the transaction's own limit.
      const exhausted = profile.hardfork === 'amsterdam' && req.gas !== undefined && gasLimit < 0n;
      if (exhausted) for (const [a, was] of found) {
        const at = createAddressFromString(a);
        if (!was) { await state.deleteAccount(at); continue; }
        const account = (await state.getAccount(at)) ?? new Account();
        account.nonce = was.nonce; account.balance = was.balance;
        await state.putAccount(at, account);
        await state.putCode(at, was.code);
      }
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
      source.ran.calls++;
      state.at.call = true;
      // (Its trace is its one call, failed before it ran.)
      if (exhausted && req.trace) root = { call: { type: req.to ? 'call' : 'create', from: caller, to: req.to?.toLowerCase() ?? null, value: req.value, input: req.data, gas: 0n, gasUsed: 0n, error: 'out of gas' }, context: req.to?.toLowerCase() ?? '', isStatic: false, own: [], under: new Set() };
      const res = exhausted ? { execResult: { executionGasUsed: 0n, returnValue: new Uint8Array(0), exceptionError: new EVMError(EVMError.errorMessages.OUT_OF_GAS), logs: [], gasRefund: 0n, selfdestruct: new Map(), createdAddresses: new Set() } } as unknown as Awaited<ReturnType<typeof evm.runCall>>
        : await evm.runCall({ caller: sender, origin: sender, ...(req.to && { to: createAddressFromString(req.to) }), skipNonceIncrement: true,
        data: hexToBytes(req.data as Hex), value: req.value, gasLimit: gasLimit > 0n ? gasLimit : 0n, gasPrice: req.gasPrice ?? 0n, block, ...(req.blobVersionedHashes?.length && { blobVersionedHashes: req.blobVersionedHashes as Hex[] }) });
      recording = false;
      state.at.call = false;
      byRequest[i] = [...reached];
      if (bought) { const account = (await state.getAccount(sender)) ?? new Account(); account.balance += bought; await state.putAccount(sender, account); }
      const ex = res.execResult;
      // An account the transaction destroyed (SELFDESTRUCT) goes at its end, as the chain's VM removes it: from Cancun
      // (EIP-6780) only one it created too; before, any. Under Amsterdam (EIP-8246) its code, nonce and storage go and
      // its balance stays. The local EVM runs calls, not transactions, and kept them: the next call of a batch found
      // the contract's code (EXTCODESIZE 2 where the node read 0), a CREATE2 to its address collided (104,337 gas
      // where the node's succeeded at 88,335), and the trace listed it as created (2026-11-16, on every chain).
      if (!ex.exceptionError) for (const [hex] of ex.selfdestruct ?? []) {
        const gone = createAddressFromString(hex);
        if (common.isActivatedEIP(6780) && !ex.createdAddresses?.has(gone.toString())) continue;
        const kept = common.isActivatedEIP(8246) ? (await state.getAccount(gone))?.balance ?? 0n : 0n;
        await state.deleteAccount(gone);
        if (kept > 0n) { const left = new Account(); left.balance = kept; await state.putAccount(gone, left); }
      }
      const traced = req.trace ? { trace: traceOf(ex.logs ?? []), stateChanges: await changesOf() } : undefined;
      // What the call spent, and under Amsterdam what its state took from the reservoir (less what it gave back to it).
      const spent = exhausted ? req.gas! - intrinsicGas(req, true).intrinsic : ex.executionGasUsed + authState + (metered ? reservoir - metered.stateGasReservoir : 0n);
      // EIP-7623's calldata floor from Prague on, but not on Arbitrum, whose node charges none (1,000 bytes of calldata
      // to an empty account: 37,000 gas there, the floor's 61,000 on Ethereum, Base, OP Mainnet, Polygon and BNB
      // Chain; 2026-11-15).
      const gasUsed = transactionGas(req, spent > 0n ? spent : 0n, (ex.gasRefund ?? 0n) + authRefund, !BEFORE_PRAGUE.has(profile.hardfork) && !profile.arbitrum, profile.hardfork === 'amsterdam');
      // (What it had used at its most, before the refund: SimulationResult.gasPeak.)
      const peakGas = transactionGas(req, spent > 0n ? spent : 0n, 0n, !BEFORE_PRAGUE.has(profile.hardfork) && !profile.arbitrum, profile.hardfork === 'amsterdam');
      const gasPeak = peakGas > gasUsed ? { gasPeak: peakGas } : {};
      // The fee itself is paid once everything this call reports has been read: the calls after it in the batch are
      // the transactions after it, and meet a sender that has paid (the gas used at its price) and a fee recipient
      // that has been tipped (the price over the base fee), as on the chain.
      const settle = async () => {
        if (!bought || !req.gasPrice) return;
        // (On Arbitrum the chain charges the L1 gas too, where a replay's receipt says what it was: gasForL1.)
        const l1Gas = profile.arbitrum ? req.gasForL1 ?? 0n : 0n;
        const paid = (gasUsed + l1Gas) * req.gasPrice + (bought - req.gas! * req.gasPrice), base = (block.header as { baseFeePerGas?: bigint }).baseFeePerGas ?? 0n;
        const payer = (await state.getAccount(sender)) ?? new Account();
        payer.balance = payer.balance > paid ? payer.balance - paid : 0n;
        await state.putAccount(sender, payer);
        const pay = async (who: string | Address, amount: bigint) => {
          if (amount <= 0n) return;
          const at = typeof who === 'string' ? createAddressFromString(who) : who, account = (await state.getAccount(at)) ?? new Account();
          account.balance += amount;
          await state.putAccount(at, account);
        };
        if (profile.arbitrum) {
          const least = await source.arbMinimumGasPrice() ?? base, floor = least < req.gasPrice ? least : req.gasPrice;
          await pay(ARBITRUM_FEES.infra, gasUsed * floor);
          await pay(ARBITRUM_FEES.network, gasUsed * (req.gasPrice - floor));
          await pay(ARBITRUM_FEES.l1, l1Gas * req.gasPrice);
          return;
        }
        const tip = req.gasPrice > base ? gasUsed * (req.gasPrice - base) : 0n;
        await pay(profile.tipsTo ?? block.header.coinbase, tip);
        if (profile.baseFeeTo) await pay(profile.baseFeeTo, gasUsed * (req.gasPrice < base ? req.gasPrice : base));
      };
      if (ex.exceptionError) {
        const data = bytesToHex(ex.returnValue) as Hex;
        await settle();
        results.push({ status: 'reverted', source: source_, gasUsed, ...gasPeak, revertReason: ex.exceptionError.error === 'revert' ? decodeRevert(data) : ex.exceptionError.error, transfers: [], basis: 'fork', returnData: data,
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
      if (named && await state.stylus(named.kind === 'permit2' ? named.emitter : named.token)) named = undefined;
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
      // (The native coin is always read: above.)
      const read = ['native'];
      for (const t of new Set([...watch, ...logNet.keys()])) {
        if (t === 'native' || nftLogs.has(t) || await state.stylus(t)) { if (t !== 'native' && !nftLogs.has(t)) add(t, logNet.get(t) ?? 0n); continue; }
        if (await isNft(t)) continue;
        // A token first seen in the first call's logs is read on the state before it (see balanceBefore).
        const b = before.has(t) ? before.get(t) : i === 0 ? await balanceBefore(t, from) : undefined;
        const a = before.has(t) || i === 0 ? await balanceOf(t, from) : undefined;
        // The balance read wins; a token whose balanceOf can't be read keeps its log amounts.
        if (b !== undefined && a !== undefined) read.push(t);
        add(t, b !== undefined && a !== undefined ? a - b : (logNet.get(t) ?? 0n));
      }
      const approvalState: SimulatedApproval[] = [];
      for (const ap of touched.values()) {
        if (await state.stylus(ap.kind === 'permit2' ? ap.emitter : ap.token)) continue;
        const r = await view(ap.kind === 'permit2' ? ap.emitter : ap.token, stateCall(ap));
        const s = r && decodeState(ap, bytesToHex(r) as Hex);
        if (s) approvalState.push(s);
      }
      results.push({ status: 'success', source: source_, gasUsed, ...gasPeak, transfers, nftTransfers: parsed.nftTransfers, approvals: parsed.approvals, ...(approvalState.length && { approvalState }), ...(parsed.coreActions && { coreActions: parsed.coreActions }), basis: 'fork', readAssets: read, returnData: bytesToHex(ex.returnValue), logs: logs.map(l => ({ ...l, address: l.address.toLowerCase() })),
        ...(traced?.trace && { trace: traced.trace, stateChanges: traced.stateChanges }) });
      await settle();
    }
    // Each result with the contracts the node runs itself that its own run reached, of those run from a reference.
    results.forEach((r, i) => { const own = byRequest[i]?.filter(a => source.standIns.has(a)); if (own?.length) r.standIns = own; });
    return { results, tokens: [...seenTokens], approvals: seenApprovals, rerun, grewAt, trace, snapshot };
  }

  /**
   * Requests the local EVM can't run, run by the chain's node: one whose own target is a Stylus program (Arbitrum's
   * WASM contracts, which no EVM runs), one that reaches a Stylus program from inside another contract, and each
   * request after either in the batch (`whys`). `group`: consecutive requests of one account, run in one
   * eth_simulateV1 (or as few as the node's cap on calls allows, NODE_CALLS), on the block the preview's own
   * simulation uses (a replay's, with its earlier transactions first), with the batch's calls before them that ran
   * (`earlier`: not one its sender couldn't pay for, which the node would refuse the whole simulation for), on what
   * every request of the batch sets (as the local EVM's run has it). Each one's outcome, return data, events and gas
   * are the node's own run; so is the whole of it: what the local EVM had begun of it, up to the program, is not
   * kept. Around each, in the same block, the node reads the account's native balance, its balance of each token
   * watched and the approvals touched: the amounts are the node's. The same calls with their targets' code taken
   * away, in a block after, give the charge for L1 data the node adds to each call's gas: it comes off, as the local
   * EVM's gas is the L2 part. Each trace is one frame (TraceCall.node): what it called, and what storage it wrote,
   * the node doesn't say, so the results have no state changes.
   */
  private async runOnNode(reqs: SimulationRequest[], group: number[], earlier: number[], auths: Authorization[][], source: StateSource, watch: string[],
    watchedApprovals: Map<string, SimulatedApproval>, chainId: number, profile: ChainProfile, nonces: bigint[], whys: NodeWhy[]): Promise<SimulationResult[]> {
    const from = hexOf(reqs[group[0]].account ?? reqs[group[0]].from);
    // A creation's charge for L1 data can't be measured apart from what its code uses: there is no code to take away,
    // the code it runs being its calldata, which the charge counts.
    group.forEach((i, g) => {
      const why = whys[g];
      if (!reqs[i].to) throw new ForkUnsupported(`the transaction creates a contract ${why.after ? `after a call the chain's node runs (${nodeReason(why)})` : `whose code reaches the Stylus (WASM) program ${why.program}, which the local EVM can't run`}: the chain's node could run it, but its charge for a creation's L1 data can't be told apart from the gas the creation uses`);
    });
    const hex = (v: bigint) => `0x${v.toString(16)}`, pad = (a: string) => a.slice(2).padStart(64, '0');
    // What the batch's requests set (and a replay's block had changed, beneath them), as the node takes it; not the
    // code standing in for a signed EIP-7702 authorization, which the node applies itself. An authorization the wallet
    // has yet to sign, the node can't apply: its code stands in, from the start of the block, and for its gas an
    // authorization signed by a throwaway account set up to be charged the same (as RpcSimulator's eth_simulateV1).
    type Override = { balance?: string; nonce?: string; code?: string; stateDiff?: Record<string, string>; movePrecompileToAddress?: string };
    const overrides: Record<string, Override> = {};
    const authorities = new Set(auths.flat().filter(a => a.nonce !== undefined).map(a => a.authority));
    const put = (a: string, o: Override) => {
      const k = hexOf(a), was = overrides[k] ?? {};
      overrides[k] = { ...was, ...o, ...((was.stateDiff || o.stateDiff) && { stateDiff: { ...was.stateDiff, ...o.stateDiff } }) };
    };
    if (!source.after) for (const [a, o] of Object.entries(reqs[0].at?.state ?? {})) put(a, o as Override);
    for (const r of reqs) for (const [a, o] of Object.entries(r.stateOverrides ?? {})) {
      put(a, { ...(o.balance !== undefined && { balance: o.balance }), ...(o.stateDiff && { stateDiff: o.stateDiff }), ...(o.code !== undefined && !authorities.has(hexOf(a)) && { code: o.code }), ...(o.movePrecompileToAddress && { movePrecompileToAddress: o.movePrecompileToAddress }) });
    }
    if (reqs.some(r => r.unsignedAuthorizations?.length)) put(UNSIGNED_STAND_IN.address, UNSIGNED_STAND_IN.state);
    const call = async (r: SimulationRequest) => ({ ...nodeCall(r), ...(r.unsignedAuthorizations?.length && { authorizationList: authorizationsForNode([...(r.authorizationList ?? []), ...await unsignedStandIns(r)]) }) });
    // A call with no gas limit is given one, the local EVM's, and its probe the same: the node prices a call's L1 data
    // with its gas limit, and one not given has the block's gas left, which differs from the call to its probe
    // (measured on Arbitrum One, 2026-11-16: the same 388-byte call charged 1,161 for L1 data first in its block,
    // 1,170 after three calls, and 1,170 at either place given 30,000,000; its L2 part had come out 6 gas over).
    const limit = (r: SimulationRequest) => (r.gas === undefined ? { gas: hex(GAS) } : {});
    put(BALANCE_READER, { code: BALANCE_READER_CODE });
    put(VIEW_READER, { code: VIEW_READER_CODE });
    // The reads around each call, in one call to VIEW_READER: the account's native balance (BALANCE_READER's), its
    // balance of each token watched and each approval touched, each a static call on 10 million gas, as the local
    // EVM's views are. As calls of their own, they ran as transactions in the node's block: a contract read as a
    // token (the call's own target is one) ran its code there, and the call ran on what it left. And they made the
    // request too big for Arbitrum One's public node, which answers an eth_simulateV1 of more than 30 calls (across
    // its blocks) with HTTP 429 every time (30 ran, 31 never did, 2026-11-16): a call that named ten more tokens took
    // 37 and ran out of time. The reads after a call are the ones before the next.
    const reads = (approvals: SimulatedApproval[]) => {
      const views: [string, Hex][] = [[BALANCE_READER, `0x${pad(from)}`], ...watch.map(t => [t, `0x70a08231${pad(from)}`] as [string, Hex]), ...approvals.map(ap => [ap.kind === 'permit2' ? ap.emitter : ap.token, stateCall(ap)] as [string, Hex])];
      return { to: VIEW_READER, data: viewReads(views), gas: hex(VIEW_GAS * BigInt(views.length) + 1_000_000n) };
    };
    /** The native read and the views of `reads`, as one result each (viewResults). */
    const readsOf = (c: NodeCallResult | undefined, views: number) => viewResults(c, 1 + views);
    const results: SimulationResult[] = [];
    // As many calls as fit in one request, with the ones before them, the reads before the first, each call and the
    // reads after it, and their probes (one each, behind one that takes the block's first-call difference): nine
    // with none before them. At least one.
    for (let start = 0, ran = [...earlier]; start < group.length;) {
      const room = Math.max(1, Math.floor((NODE_CALLS - (source.after?.calls.length ?? 0) - ran.length - 2) / 3));
      const part = group.slice(start, start + room);
      results.push(...await this.nodePart(reqs, part, ran, nonces.slice(start, start + room), whys.slice(start, start + room), source, from, watch, watchedApprovals, chainId, profile,
        { overrides, call, limit, reads, readsOf }));
      ran = [...ran, ...part];
      start += part.length;
    }
    return results;
  }

  /** runOnNode's requests `part`, in one eth_simulateV1: the calls `earlier` first, then each with the reads around it. */
  private async nodePart(reqs: SimulationRequest[], part: number[], earlier: number[], nonces: bigint[], whys: NodeWhy[], source: StateSource, from: string, watch: string[],
    watchedApprovals: Map<string, SimulatedApproval>, chainId: number, profile: ChainProfile, at: {
      overrides: Record<string, { balance?: string; nonce?: string; code?: string; stateDiff?: Record<string, string>; movePrecompileToAddress?: string }>;
      call: (r: SimulationRequest) => Promise<Record<string, unknown>>; limit: (r: SimulationRequest) => { gas?: string };
      reads: (approvals: SimulatedApproval[]) => Record<string, unknown>; readsOf: (c: NodeCallResult | undefined, views: number) => NodeCallResult[];
    }): Promise<SimulationResult[]> {
    const { overrides, call, limit, reads, readsOf } = at;
    const hex = (v: bigint) => `0x${v.toString(16)}`;
    const before = await Promise.all(earlier.map(k => call(reqs[k]))), own = await Promise.all(part.map(async i => ({ ...await call(reqs[i]), ...limit(reqs[i]) })));
    // The same calls with nothing to run: their targets' code taken away, in a block after (behind a call that takes
    // the block's first-call difference). Each one's `to` is the target's own and its nonce the call's, which the
    // charge counts with the calldata (measured: the same call sent again, a nonce later, was charged 10 gas more),
    // and its value, which the charge counts too: sent with none, the probe came out 35 gas short of the charge for a
    // call with 1 ETH and 44 for one with 5,373 ETH (base fee 0.02 gwei, 2026-11-15). Each sender is given the
    // balance to send it in that block. (Given a gas limit, a call's charge is the same wherever in its block.)
    const probes = part.map(i => ({ ...reqs[i], authorizationList: undefined, unsignedAuthorizations: undefined, stateOverrides: undefined }));
    const probeState: typeof overrides = {};
    for (const p of probes) {
      const s = hexOf(p.from), t = hexOf(p.to!);
      probeState[s] = { ...probeState[s], balance: hex(1n << 200n) };
      probeState[t] = { ...probeState[t], code: '0x' };
    }
    const ask = async (approvals: SimulatedApproval[]) => {
      const around = reads(approvals), calls = [...before, around, ...own.flatMap(o => [o, around])];
      const first = reqs[0].at, after = source.after;
      const blockOverrides = after ? after.blockOverrides : first ? nodeOverrides(first.header) : reqs[part[0]].baseFee !== undefined ? { baseFeePerGas: hex(reqs[part[0]].baseFee!) } : undefined;
      if (after) for (const [a, o] of Object.entries(after.state ?? {}).reverse()) overrides[hexOf(a)] = { ...(o as typeof overrides[string]), ...overrides[hexOf(a)], ...(((o as typeof overrides[string]).stateDiff || overrides[hexOf(a)]?.stateDiff) && { stateDiff: { ...(o as typeof overrides[string]).stateDiff, ...overrides[hexOf(a)]?.stateDiff } }) };
      const fee = blockOverrides?.baseFeePerGas;
      let answer: NodeCallResult[][];
      try {
        answer = await source.nodeRun([{ calls: [...(after?.calls ?? []), ...calls], ...(blockOverrides && { blockOverrides }), stateOverrides: overrides },
          { ...(fee && { blockOverrides: { baseFeePerGas: fee } }), stateOverrides: probeState, calls: [{ to: L1_PROBE, data: '0x' }, ...probes.map((p, g) => ({ ...nodeCall(p), ...limit(reqs[part[g]]), nonce: hex(nonces[g]) }))] }]);
      } catch (e) {
        // A node without eth_simulateV1 can't be handed the call: refused, saying why. (Only the method being missing:
        // not the state, which Arbitrum's node says "historical state … is not available" of, as the next may have it.)
        const m = e instanceof Error ? e.message : String(e);
        if (/\bmethod\b[^.]*\b(not found|does not exist|not available|not supported|unsupported)\b|unsupported method|-32601/i.test(m)) throw new ForkUnsupported(`the call is one the chain's node must run (${nodeReason(whys[0])}), and the node has no eth_simulateV1 to run it`);
        throw e;
      }
      const [out, probed] = answer;
      return { out: out.slice(after?.calls.length ?? 0), probed: probed.slice(1) };
    };
    /** Where call `g` of the part is in the block: the reads before it just before, the reads after it just after. */
    const at_ = (g: number) => earlier.length + 1 + 2 * g;
    /** Call `g`'s events, with the approval the request names when it succeeded. */
    const parse = (ran: NodeCallResult, g: number) => {
      const parsed = parseLogs((ran.logs ?? []).map(l => ({ ...l, address: l.address.toLowerCase() })));
      const named = ran.status === '0x1' ? namedApproval(reqs[part[g]], from, parsed.approvals) : undefined;
      if (named && !parsed.approvals.some(a => approvalKey(a) === approvalKey(named))) parsed.approvals.push(named);
      return parsed;
    };
    // The approvals their events show are read after each call too: asked again when they weren't already.
    let approvals = [...watchedApprovals.values()], asked = await ask(approvals);
    const more: SimulatedApproval[] = [];
    part.forEach((_, g) => {
      for (const a of parse(asked.out[at_(g)], g).approvals) if (a.owner === from && !watchedApprovals.has(approvalKey(a)) && !more.some(m => approvalKey(m) === approvalKey(a))) more.push(a);
    });
    if (more.length) { approvals = [...approvals, ...more]; asked = await ask(approvals); }
    const views = watch.length + approvals.length;
    return part.map((i, g) => {
      const req = reqs[i], why = whys[g], target = hexOf(req.to!), ran = asked.out[at_(g)], parsed = parse(ran, g);
      const readsBefore = readsOf(asked.out[at_(g) - 1], views).slice(0, 1 + watch.length);
      const afterReads = readsOf(asked.out[at_(g) + 1], views);
      const readsAfter = afterReads.slice(0, 1 + watch.length), approvalReads = afterReads.slice(1 + watch.length), l1 = asked.probed[g];
      // The node's charge for L1 data: what the call with no code to run used over what its calldata and access list
      // cost (no calldata floor: measured on Arbitrum One, 2026-11-15, a 68-byte call to an empty account used 21,620
      // with no base fee, the floor being 22,550). The charge counts the call's `to` with its calldata: with 200 zero
      // bytes of calldata, a probe to another (mostly zero) address came out 176 gas short of the program's call.
      const l1Charge = profile.arbitrum ? BigInt(l1.gasUsed) - intrinsicGas(probes[g], false).intrinsic : 0n;
      const less = (v: bigint) => v > l1Charge ? v - l1Charge : 0n;
      const gasUsed = less(BigInt(ran.gasUsed)), peak = less(BigInt(ran.maxUsedGas ?? ran.gasUsed));
      // A call that failed has its return data in `error.data` on Arbitrum's node, with `returnData` empty.
      const failed = ran.status !== '0x1', returnData = ((failed ? ran.error?.data : undefined) ?? ran.returnData ?? '0x') as Hex;
      const logs = failed ? [] : (ran.logs ?? []).map(l => ({ address: l.address.toLowerCase(), topics: l.topics, data: l.data }));
      const revertReason = failed ? decodeRevert(returnData) ?? ran.error?.message ?? 'reverted' : undefined;
      const source_ = `chain ${chainId}'s node, ${nodeReason(why)}`;
      const intrinsic = intrinsicGas(req, false).intrinsic;
      const gasLimit = req.gas ? req.gas - intrinsic - (profile.arbitrum ? req.gasForL1 ?? 0n : 0n) : GAS;
      const known = 'its outcome, return data, events and gas are the node\'s; the calls it made aren\'t known, so its events are all listed here';
      const trace: TraceCall | undefined = req.trace ? { type: 'call', from: hexOf(req.from), to: target, value: req.value, input: req.data, gas: gasLimit > 0n ? gasLimit : 0n, gasUsed: peak > intrinsic ? peak - intrinsic : 0n,
        node: why.target && !why.after ? `a Stylus (WASM) program, run by the chain's node: ${known}` : `run by the chain's node, ${nodeReason(why)}: ${known}`,
        ...(returnData.length > 2 && { output: returnData }), ...(failed && { error: revertReason }),
        ...(logs.length && { logs: logs.map((l, index) => ({ index, ...l })) }) } : undefined;
      if (failed) return { status: 'reverted', source: source_, gasUsed, revertReason, transfers: [], basis: 'fork', returnData, ...(trace && { trace }) };
      const transfers: SimulatedTransfer[] = [];
      const other = target === from ? ELSEWHERE : target;
      const add = (asset: string, delta: bigint) => {
        if (delta < 0n) transfers.push({ asset, from, to: other, raw: -delta });
        else if (delta > 0n) transfers.push({ asset, from: other, to: from, raw: delta });
      };
      const value = (c: NodeCallResult | undefined) => c?.status === '0x1' && c.returnData.length >= 66 ? BigInt(c.returnData.slice(0, 66)) : undefined;
      const nativeBefore = value(readsBefore[0]), nativeAfter = value(readsAfter[0]);
      // The sender's balance after the call is less its fee too, which the node takes at the call's price for all the
      // gas it used (its L1 charge included; at a price above the base fee as well, 2026-11-15): the fee is counted
      // apart, as the local EVM's runs leave it out of the amounts, so it is put back.
      const paidFee = hexOf(req.from) === from && req.gasPrice ? BigInt(ran.gasUsed) * req.gasPrice : 0n;
      // (What was read, as a local run's readAssets: the native coin and each token whose balance the node read both
      // times. A UserOperation's coin is counted from them, with its EntryPoint deposit: withoutGas, src/erc4337-sim.ts.)
      const read: string[] = [];
      if (nativeBefore !== undefined && nativeAfter !== undefined) { add('native', nativeAfter - nativeBefore + paidFee); read.push('native'); }
      const logNet = new Map<string, bigint>();
      for (const t of parsed.transfers) {
        if (t.from === from) logNet.set(t.asset, (logNet.get(t.asset) ?? 0n) - t.raw);
        if (t.to === from) logNet.set(t.asset, (logNet.get(t.asset) ?? 0n) + t.raw);
      }
      const nftLogs = new Set(logs.filter(l => l.topics[0] === TRANSFER && l.topics.length === 4).map(l => l.address));
      // Each token's balance as the node read it, before and after; one not watched (or unreadable) moves by its events.
      for (const t of new Set([...watch, ...logNet.keys()])) {
        if (t === 'native' || nftLogs.has(t)) continue;
        const k = watch.indexOf(t), b = k >= 0 ? value(readsBefore[1 + k]) : undefined, a = k >= 0 ? value(readsAfter[1 + k]) : undefined;
        if (b !== undefined && a !== undefined) read.push(t);
        // (A contract that answers balanceOf with something else, an NFT collection's count, moves by its events only.)
        if (b !== undefined && a !== undefined && (a !== b || logNet.has(t))) add(t, a - b);
        else if (logNet.has(t)) add(t, logNet.get(t)!);
      }
      const approvalState: SimulatedApproval[] = [];
      approvals.forEach((ap, k) => {
        const r = approvalReads[k];
        const st = r?.status === '0x1' ? decodeState(ap, r.returnData) : undefined;
        if (st) approvalState.push(st);
      });
      return { status: 'success', source: source_, gasUsed, transfers, nftTransfers: parsed.nftTransfers, approvals: parsed.approvals, ...(approvalState.length && { approvalState }), ...(parsed.coreActions && { coreActions: parsed.coreActions }), basis: 'fork', readAssets: read, returnData, logs, ...(trace && { trace }) } as SimulationResult;
    });
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
    // What Amsterdam charges for the state an authority gains is judged against the authority as the transaction
    // found it, once: a new account's bytes if it had none, a delegation's if it had none and one is set. Judged
    // against what the tuples before had left, a list that cleared a delegation and set one again paid the 23 bytes
    // twice (Sepolia, 2026-11-16: "D1, clear, D2" 301,428 gas here and 266,238 on the node; "delegated to D1: clear,
    // then D1" 74,822 and 39,632).
    const found = new Map<string, { existed: boolean; delegated: boolean; paid: { account: boolean; delegation: boolean } }>();
    for (const a of list) {
      if (!a.authority || (a.chainId !== 0n && a.chainId !== BigInt(chainId))) continue;
      const who = createAddressFromString(a.authority);
      evm.journal.addAlwaysWarmAddress(a.authority);
      const code = await state.getCode(who);
      if (code.length && !isDelegation(code)) continue;
      const account = await state.getAccount(who);
      if (!found.has(a.authority)) found.set(a.authority, { existed: !!account, delegated: isDelegation(code), paid: { account: false, delegation: false } });
      if (a.nonce !== undefined && (account?.nonce ?? 0n) !== a.nonce) continue;
      if (account) refund += 12_500n;
      const was = found.get(a.authority)!;
      const newAccount = !was.existed && !was.paid.account, newDelegation = !was.delegated && !was.paid.delegation && a.address !== ZERO;
      added += (written.has(a.authority) ? 0n : 9_000n) + (newAccount ? 120n * 1_530n : 0n) + (newDelegation ? 23n * 1_530n : 0n);
      if (newAccount) was.paid.account = true;
      if (newDelegation) was.paid.delegation = true;
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
