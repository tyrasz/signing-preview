import { decodeAbiParameters, decodeErrorResult, encodeAbiParameters, keccak256, parseAbi, stringToBytes, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { recoverAuthorizationAddress } from 'viem/utils';
import { appliedSignature } from './authorization.ts';
import { builtinTokens, CHAINS, PERMIT2 } from './chains.ts';
import { knownError } from './errors.ts';
import { nodeOverrides, priceFields, type StateChanges } from './block.ts';
import { calldataCandidates, ProbeFailed, probeSimulate, ProbeUnsupported } from './simulation-probe.ts';
import type { SimulatedApproval, SimulatedNftTransfer, SimulatedTransfer, SimulationRequest, SimulationResult, Simulator } from './types.ts';

// Event topics (keccak256 of the signature).
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'; // Transfer(address,address,uint256), ERC-20 and ERC-721
const APPROVAL_TOPIC = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925'; // Approval(address,address,uint256), ERC-20 and ERC-721
// WETH9's Deposit(address indexed dst, uint wad) and Withdrawal(address indexed src, uint wad): a wrap mints the
// wrapped token to dst and an unwrap burns it from src, with no Transfer event.
const DEPOSIT_TOPIC = '0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c';
const WITHDRAWAL_TOPIC = '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65';
/**
 * Each chain's wrapped native token (WETH, WBNB, WPOL, WHYPE: WETH9 or its clones). Only theirs count: many other
 * contracts emit an event of the same signature (a vault's Deposit(address,uint256)) for something else.
 */
const WRAPPED_NATIVE = new Set(Object.entries(CHAINS).map(([id, c]) => builtinTokens(Number(id)).find(t => t.symbol === `W${c.nativeSymbol}`)?.address).filter((a): a is string => !!a));
const APPROVAL_FOR_ALL_TOPIC = '0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31'; // ApprovalForAll(address,address,bool)
const TRANSFER_SINGLE_TOPIC = '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62'; // ERC-1155 TransferSingle
const TRANSFER_BATCH_TOPIC = '0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb'; // ERC-1155 TransferBatch
const PERMIT2_APPROVAL_TOPIC = '0xda9fa7c1b00402c17d0161b249b1ab8bbec047c5a52207b9c112deffd817036b'; // Approval(owner,token,spender,uint160,uint48)
const PERMIT2_PERMIT_TOPIC = '0xc6a377bfc4eb120024a8ac08eef205be16b817020812c73223e81d1bdb9708ec'; // Permit(owner,token,spender,uint160,uint48,uint48)
const PERMIT2_LOCKDOWN_TOPIC = '0x89b1add15eff56b3dfe299ad94e01f2b52fbcb80ae1a3baea6ae8c04cb2b98a4'; // Lockdown(owner,token,spender)
/** HyperEVM's CoreWriter emits RawAction(msg.sender, data) for each HyperCore action sent through it. */
const CORE_WRITER = '0x3333333333333333333333333333333333333333';
const RAW_ACTION_TOPIC = '0x8c7f585fb295f7eb1e6aeb8fba61b23a4fe60beda405f0045073b185c74412e3'; // RawAction(address,bytes)
/** eth_simulateV1 with traceTransfers reports native transfers as ERC-20 logs from this address. */
const NATIVE_PSEUDO_TOKEN = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
/**
 * EIP-7708 (Amsterdam): the address a chain logs its own native transfers from, as ERC-20 Transfer events. They are
 * real logs (in receipts too), and a node that emits them adds no pseudo-logs for traceTransfers. They are the
 * native coin moving, not a token at that address.
 */
export const NATIVE_LOG_ADDRESS = '0xfffffffffffffffffffffffffffffffffffffffe';
/** Multicall3, at this address on every chain the previewer simulates on: getEthBalance(address) reads a native balance. */
const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';

type RawCallResult = { status: string; gasUsed: string; maxUsedGas?: string; returnData: Hex; logs?: { address: string; topics: string[]; data: string }[]; error?: { message?: string; data?: Hex } };

export interface RpcSimulatorOptions {
  fetchImpl?: typeof fetch;
  /**
   * On chains without eth_simulateV1, simulate with this first (ForkSimulator gives every log there). If it hasn't
   * finished within `forkBudgetMs` (default 3,500), the probe answers instead, while the fork run carries on in the
   * background, warming its caches for the next preview.
   */
  fork?: FallbackSimulator;
  forkBudgetMs?: number;
  /** How long a trace may take in the fork simulator (default 15,000 ms): a preview that asked for one waits that long at most. */
  traceBudgetMs?: number;
  /**
   * Replays (accuracy checks): simulate on top of `block` instead of 'latest', with these simulated-block fields,
   * and (eth_simulateV1) after `before`, calls run first in the same simulated block (the replayed block's earlier
   * transactions) whose results are dropped. `warm`: what the replayed transaction had warm from its start (its
   * EIP-7702 authorities) or by its turn (what a bundle's earlier operations touched): addresses, or addresses with
   * storage slots, added to each request's access list.
   */
  replay?: (chainId: number) => { block: string; blockOverrides?: Record<string, string>; before?: SimulationRequest[]; warm?: (string | { address: string; storageKeys: string[] })[]; state?: StateChanges } | undefined;
}

/**
 * The counterparty given to a balance change read from state when the call's target is the account itself: the
 * change is real, but who is on the other side isn't known.
 */
export const ELSEWHERE = '0x0000000000000000000000000000000000000000';

/** Code overrides of all the calls (EIP-7702 delegations), applied from the start of the simulated block. */
const overridesOf = (reqs: SimulationRequest[]) => {
  const all: Record<string, { code?: string; balance?: string; stateDiff?: Record<string, string>; movePrecompileToAddress?: string }> = {};
  for (const r of reqs) for (const [a, o] of Object.entries(r.stateOverrides ?? {})) {
    const k = a.toLowerCase(), prev = all[k] ?? {};
    all[k] = { ...prev, ...(o.code !== undefined && { code: o.code }), ...(o.balance !== undefined && { balance: o.balance }), ...(o.stateDiff && { stateDiff: { ...prev.stateDiff, ...o.stateDiff } }), ...(o.movePrecompileToAddress && { movePrecompileToAddress: o.movePrecompileToAddress }) };
  }
  return Object.keys(all).length ? all : undefined;
};

/**
 * A request's own gas limit, gas price, access list and signed authorizations, as eth_simulateV1 call fields, with
 * stand-ins for the authorizations the wallet has yet to sign (see standIns).
 */
const simulationFields = async (req: SimulationRequest) => {
  const authorizationList = authorizationsForNode([...(req.authorizationList ?? []), ...await unsignedStandIns(req)]);
  return {
    ...(req.gas !== undefined && { gas: '0x' + req.gas.toString(16) }),
    ...priceFields(req),
    ...(req.accessList && { accessList: req.accessList }),
    ...(authorizationList.length && { authorizationList }),
  };
};

/**
 * The state overrides eth_simulateV1 needs. The code standing in for a signed authorization, which the node applies
 * itself, is left out, so an authority's account isn't made to exist or to be delegated beforehand (what the
 * authorization costs depends on that); a balance or storage set for the authority stays.
 */
async function simulateV1Overrides(reqs: SimulationRequest[], state?: StateChanges) {
  const all: Record<string, { code?: string; balance?: string; nonce?: string; stateDiff?: Record<string, string>; movePrecompileToAddress?: string }> = overridesOf(reqs) ?? {};
  // The stand-in for unsigned authorizations: an existing account, without code, at nonce 0.
  if (reqs.some(r => r.unsignedAuthorizations?.length)) all[UNSIGNED_STAND_IN.address] = { ...UNSIGNED_STAND_IN.state };
  for (const r of reqs) for (const a of r.authorizationList ?? []) {
    try {
      if (!appliedSignature(a)) continue;
      const authority = await recoverAuthorizationAddress({ authorization: { address: a.address as Hex, chainId: Number(a.chainId), nonce: Number(a.nonce) }, signature: { r: a.r as Hex, s: a.s as Hex, yParity: Number(a.yParity) } });
      const own = all[authority.toLowerCase()];
      if (own) { delete own.code; if (!Object.keys(own).length) delete all[authority.toLowerCase()]; }
    } catch { /* unreadable: the chain skips it, and so does the override */ }
  }
  // Beneath them, what the simulated block had already changed (BlockAt.state: a replay's earlier transactions).
  for (const [a, s] of Object.entries(state ?? {})) all[a] = { ...s, ...all[a], ...((s.stateDiff || all[a]?.stateDiff) && { stateDiff: { ...s.stateDiff, ...all[a]?.stateDiff } }) };
  return Object.keys(all).length ? all : undefined;
}

/**
 * A replay's earlier transactions with gas limits that add up to no more than `room`, for a node that adds the
 * limits of a simulated block's calls up against the block's gas limit (BNB Chain's public node, reth-bsc: "Block
 * gas limit exceeded by the block's transactions"; it takes no higher block limit either; Ethereum's, Base's and OP
 * Mainnet's, on reth, don't add them up). The chain counts the gas used, and BNB Chain's transactions are given several times what they use: in every block
 * followed, the limits passed the block's 70 million somewhere in its last third, and nothing after that point
 * could be replayed.
 *
 * Each call gets what its transaction used and a margin: half as much again (a refund takes off at most a fifth of
 * what ran, and each call a transaction makes keeps a sixty-fourth back) and 50,000, then an equal share of what
 * room is left, never more than its own limit. What less gas can change is a call running short, so the caller
 * checks that none did (hadRoom) and takes nothing from a run where one might have. `used` is what each used on
 * the chain (BlockAt.beforeUsed). Undefined when that isn't known, or they can't fit.
 */
export function fitGas(earlier: SimulationRequest[], used: bigint[] | undefined, room: bigint): SimulationRequest[] | undefined {
  if (!earlier.length || used?.length !== earlier.length || earlier.some(r => r.gas === undefined)) return undefined;
  const needs = earlier.map((r, i) => { const need = used[i] * 3n / 2n + 50_000n; return need < r.gas! ? need : r.gas!; });
  const spare = room - needs.reduce((a, b) => a + b, 0n);
  if (spare < 0n) return undefined;
  const share = spare / BigInt(earlier.length);
  return earlier.map((r, i) => ({ ...r, gas: needs[i] + share < r.gas! ? needs[i] + share : r.gas! }));
}

/**
 * Whether every call given less gas than its transaction had (fitGas) finished with room to spare: what it used,
 * and three eighths more, within what it was given. A call that ran short anywhere inside would have used nearly
 * all of it (a call passes on all but a sixty-fourth). Not whether it came out as mined: on a node that runs a
 * same-second block a second late, calls differ from their receipts by a little on any gas limit.
 */
export function hadRoom(earlier: SimulationRequest[], fitted: SimulationRequest[], results: { gasUsed?: string }[] | undefined): boolean {
  // (A call on its own limit, or given more than it for the stand-ins' cost, roomForStandIns, has all it had.)
  return !!results && results.length >= fitted.length && fitted.every((r, i) => r.gas === undefined || earlier[i]?.gas === undefined || r.gas >= earlier[i].gas! || (results[i].gasUsed !== undefined && BigInt(results[i].gasUsed!) * 11n / 8n <= r.gas));
}

/** The gas an earlier call is given over its own limit where the calls' stand-ins made it fail (roomForStandIns). */
const STAND_IN_ROOM = 100_000n;
/** FailedOp(uint256,string), and "AA95 out of gas" as its reason's bytes: an EntryPoint's own check of the gas left for an operation (ranShort). */
/** Where the allowance probe's code is put for its one call (RpcSimulator.allowance), and the code: JUMPDEST, PUSH1 0, JUMP. */
const ALLOWANCE_PROBE = '0x00000000000000000000000000000000a110a11c', ENDLESS = '0x5b600056';
const FAILED_OP = '0x220266b6', AA95 = Array.from('AA95 out of gas', ch => ch.charCodeAt(0).toString(16)).join('');
/**
 * Whether a call that failed in a simulated block failed for want of gas. One that ran out used all it was given (a
 * revert gives the rest back); one whose inner call ran out, and that reverted on what it had kept back (a
 * sixty-fourth at each call), nearly all: within a sixteenth of its limit counts. On BNB Chain (block 135,185,849,
 * 2026-11-23) a transaction sent with 110,414 gas that used 108,387 reverted so, 109,188 used, once ecrecover was
 * moved. A bundle of UserOperations fails sooner, most of its gas unused: before it runs an
 * operation's calls its EntryPoint checks that the gas left covers what the operation asked for, and reverts with
 * FailedOp(index, "AA95 out of gas") where it doesn't. Bundlers send on just that much. On Base (block 60,397,164,
 * 2026-11-21) a bundle of 620,866 gas that used 240,585 failed so, 121,683 gas in, once ecrecover was moved; the
 * interest it had accrued in a Morpho market on the chain was then left for the operation after it, which came out
 * 8.8% over in gas.
 */
export function ranShort(c: { status: string; gasUsed?: string; returnData?: string; error?: { data?: string } }, limit: bigint | undefined): boolean {
  if (c.status === '0x1' || limit === undefined) return false;
  const data = (c.error?.data ?? c.returnData ?? '').toLowerCase();
  return BigInt(c.gasUsed ?? 0) * 16n >= limit * 15n || (data.startsWith(FAILED_OP) && data.includes(AA95));
}
/**
 * A replayed block's earlier calls with room for what the reported calls' stand-ins cost them, or undefined where none
 * needs it. State overrides hold for the whole simulated block, so a precompile moved to make room for a stand-in
 * (ecrecover, for a signature that doesn't exist yet: src/erc4337-sim.ts) is moved for the earlier calls as well:
 * each of their own calls to it goes on from the stand-in to the address it moved to, cold for them where the
 * precompile is always warm, about 2,700 gas more. A transaction sent on just the gas it needs then fails. On
 * Ethereum (block 26,454,693, 2026-11-20) a payout checked against one signature used 169,256 gas of a limit of
 * 191,339 that its contract's own check of the gas left holds it to: with the stand-in it ran out of gas (it runs
 * on 171,954 where nothing limits it), the transfer its sender made next had nothing to send, and the node refused
 * the block ("insufficient funds for gas * price + value").
 *
 * `failed`: the earlier calls that failed in a run for want of gas, as far as it shows (their indexes: ranShort), or 'unpaid' where the node refused the block for
 * one that couldn't pay (which isn't said). Those that succeeded on the chain (SimulationRequest.mined) on a gas limit
 * are given STAND_IN_ROOM more: what the stand-ins cost, not gas their code had on the chain to spend otherwise, so
 * one that still fails, or that failed on the chain, is left as it is.
 */
export function roomForStandIns(earlier: SimulationRequest[], reqs: SimulationRequest[], failed: number[] | 'unpaid'): SimulationRequest[] | undefined {
  if (!reqs.some(r => Object.values(r.stateOverrides ?? {}).some(o => o.movePrecompileToAddress))) return undefined;
  const short = (r: SimulationRequest, i: number) => !!r.mined?.succeeded && r.gas !== undefined && !r.roomy && (failed === 'unpaid' || failed.includes(i));
  return earlier.some(short) ? earlier.map((r, i) => (short(r, i) ? { ...r, gas: r.gas! + STAND_IN_ROOM, roomy: true } : r)) : undefined;
}

/**
 * EIP-7702 authorizations as a node takes them: every number without leading zeros. Wallets and signing libraries
 * write a signature's r and s as 32 padded bytes, and nodes built on go-ethereum refuse a number written so
 * ("cannot unmarshal hex number with leading zero digits": Arbitrum's and Polygon's did), which failed the whole
 * simulation whenever r or s happened to start with a zero: about one authorization in eight.
 */
export function authorizationsForNode<T extends { chainId: string; nonce: string; r: string; s: string; yParity: string }>(list: T[]): T[] {
  const quantity = (v: string) => { try { return `0x${BigInt(v).toString(16)}`; } catch { return v; } };
  return list.map(a => ({ ...a, chainId: quantity(a.chainId), nonce: quantity(a.nonce), r: quantity(a.r), s: quantity(a.s), yParity: quantity(a.yParity) }));
}

/** A throwaway account standing in for the sender in the gas of authorizations not signed yet (see unsignedStandIns). */
const STAND_IN = privateKeyToAccount(keccak256(stringToBytes('signing-preview: EIP-7702 gas stand-in')));
/** The stand-in's account as eth_simulateV1 is given it: an existing account, without code, at nonce 0 (see unsignedStandIns). */
export const UNSIGNED_STAND_IN = { address: STAND_IN.address.toLowerCase(), state: { balance: '0x1', nonce: '0x0', code: '0x' } } as const;
type AuthorizationJson = NonNullable<SimulationRequest['authorizationList']>[number];

/**
 * eth_simulateV1 can't apply an authorization nobody has signed yet: the code override stands in for its effect, and
 * for its gas, an authorization signed by a throwaway account set up the same way (it exists, its nonce matches) goes
 * in the call's list. The node charges 25,000 for it and refunds 12,500 within the refund cap, exactly as the chain
 * will for the wallet's own. One for another chain is signed for that chain, so it costs the same and doesn't apply.
 */
export async function unsignedStandIns(req: SimulationRequest): Promise<AuthorizationJson[]> {
  let nonce = 0;
  const out: AuthorizationJson[] = [];
  for (const a of req.unsignedAuthorizations ?? []) {
    const applies = a.chainId === 0 || a.chainId === req.chainId;
    const signed = await STAND_IN.signAuthorization({ address: ZERO_ADDRESS, chainId: applies ? req.chainId : a.chainId, nonce: applies ? nonce++ : 0 });
    out.push({ address: ZERO_ADDRESS, chainId: `0x${signed.chainId.toString(16)}`, nonce: `0x${signed.nonce.toString(16)}`, r: signed.r, s: signed.s, yParity: `0x${signed.yParity!.toString(16)}` });
  }
  return out;
}
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** Thrown by simulateBatch on chains whose RPC can't run calls in sequence (no eth_simulateV1 or state overrides). */
export class BatchSimulationUnsupported extends Error {
  constructor(chainId: number) { super(`The RPC for chain ${chainId} has neither eth_simulateV1 nor eth_call state overrides (or the calls have different senders), so batch calls can't be simulated in order`); this.name = 'BatchSimulationUnsupported'; }
}

/**
 * Simulates against a JSON-RPC node with eth_simulateV1 (traceTransfers on, validation off). Balance changes are
 * derived from Transfer events, so fee-on-transfer and rebasing tokens can differ. Batches run as consecutive calls
 * in one simulated block, so each call sees the previous calls' effects.
 *
 * An RPC without eth_simulateV1 (HyperEVM's public RPC) is simulated with SimulationProbe instead: eth_call with a
 * state override runs the calls from the sender and reads balances and permissions around each one (see
 * simulation-probe.ts). Only if the RPC ignores state overrides too is a single call merely checked with eth_call.
 */
/** A simulator that can stand in on chains without eth_simulateV1, e.g. ForkSimulator ('signing-preview/fork'). */
export interface FallbackSimulator extends Simulator {
  covers(chainId: number): boolean;
  /** The calls with their traces (ForkSimulator's): what RpcSimulator.trace runs. */
  trace?(requests: SimulationRequest[], options?: { budgetMs?: number }): Promise<SimulationResult[] | null>;
  simulateBatch(requests: SimulationRequest[]): Promise<SimulationResult[] | null>;
  /** Tokens a simulation still running has seen so far: passed on to the probe if it has to answer instead. */
  discovered?(requests: SimulationRequest[]): string[];
}

/** A simulation that failed on a block asked for: says so when the node no longer has that block's state. */
function unavailableState(error: unknown, block: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  const number = /^0x[0-9a-f]+$/i.test(block) ? BigInt(block).toLocaleString('en-US') : block;
  return /missing trie node|historical state|state .*(unavailable|not available|pruned)|is not available|pruned|header not found|unknown block|block not found|old data not available|distance to target block|archive/i.test(message)
    ? new Error(`This chain's node doesn't keep the state of block ${number} (most keep only recent blocks; an archive node keeps them all): ${message}`)
    : error instanceof Error ? error : new Error(message);
}

/** A node's answer when it is turning requests away. */
const RATE_LIMITED = /rate limit|too many requests|adjustable limit/i;
/** What the read pass allows each read of gas, where the block's limit is raised for them (see readState). */
const READ_GAS_ROOM = 200_000n;
/** An OP Stack node's refusal of a simulated block whose calls exceed its DA footprint (see daRoom). */
const DA_FULL = /DA footprint exceeds/i;
/** OP Stack's L1Block predeploy, the slot holding its daFootprintGasScalar, and the scalar's getter. */
const L1_BLOCK = '0x4200000000000000000000000000000000000015', L1_BLOCK_DA_SLOT = `0x${'0'.repeat(63)}8`, DA_FOOTPRINT_GAS_SCALAR = '0xfe3d5710';
/** The L1-attributes deposit's call (Jovian): 178 bytes of packed fields, the DA footprint scalar the last two. */
const SET_L1_BLOCK_VALUES_JOVIAN = '0x3db6be2b';

export class RpcSimulator implements Simulator {
  private urls: Record<number, string>;
  private fetchImpl: typeof fetch;
  private fork?: FallbackSimulator;
  private forkBudgetMs: number;
  private traceBudgetMs: number;
  private replay?: RpcSimulatorOptions['replay'];
  /** How many of a replayed block's earlier calls a run of this simulator's was given room for the calls' stand-ins (roomForStandIns). */
  roomGiven = 0;
  /**
   * A replayed block's earlier calls with the room a run found them to need (roomForStandIns), by the list they came
   * from and the addresses that run's calls put code at (the moved precompiles' and any other stand-in's): the
   * block's next run with code at the same ones starts with it. A
   * replayed operation is simulated several times over (each signer tried, each form of stand-in), and on Polygon,
   * where every block carries USDC transfers by signature sent on about 2,000 gas more than they use, each of those
   * runs otherwise failed them first and was asked again.
   */
  private roomyFor = new WeakMap<SimulationRequest[], Map<string, SimulationRequest[]>>();
  /** Chains whose RPC answered "method not found" for eth_simulateV1 (e.g. HyperEVM's public RPC). */
  private noSimulate = new Set<number>();
  /** ...and that also ignore eth_call state overrides: only success or failure can be checked. */
  private noProbe = new Set<number>();
  /** Chains whose node refused a call that names blob hashes (see buildable). */
  private noBlobCalls = new Set<number>();
  /** `urls`: an RPC per chain. See RpcSimulatorOptions for the fallback simulator and replays. */
  constructor(urls: Record<number, string>, options: RpcSimulatorOptions = {}) {
    this.urls = urls;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.fork = options.fork;
    this.forkBudgetMs = options.forkBudgetMs ?? 3500;
    this.traceBudgetMs = options.traceBudgetMs ?? 15_000;
    this.replay = options.replay;
  }

  /**
   * The block to simulate on top of, and the simulated block's header fields: a replay's, else the requests' own
   * (SimulationRequest.at), else the latest block and a header of the node's making.
   */
  private at(chainId: number, reqs?: SimulationRequest[]): { tag: string; overrides?: Record<string, string> } {
    const r = this.replay?.(chainId);
    if (r) return { tag: r.block, overrides: r.blockOverrides };
    const at = reqs?.[0]?.at;
    return at ? { tag: at.block, overrides: nodeOverrides(at.header) } : { tag: 'latest' };
  }
  /**
   * The calls traced in the local EVM (Simulator.trace), within the budget given to it on chains it answers for;
   * null without one that covers the chain, or when it fails or runs out of time.
   */
  async trace(reqs: SimulationRequest[], options?: { budgetMs?: number }): Promise<SimulationResult[] | null> {
    if (!reqs.length || !this.fork?.covers(reqs[0].chainId) || !this.fork.trace) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([this.fork.trace(reqs, options), new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), options?.budgetMs ?? this.traceBudgetMs); (timer as { unref?: () => void }).unref?.(); })]);
    } catch (e) {
      // Something a local EVM can't run (a contract the chain's node runs itself): the caller says so.
      if (e instanceof Error && e.name === 'ForkUnsupported') throw e;
      // A block that was asked for, whose state the node didn't serve the local EVM's reads (a public RPC can answer
      // a simulation from a backend that keeps it and a balance read from one that doesn't): said as that.
      const at = reqs[0].at;
      if (at?.required && unavailableState(e, at.block) !== e) {
        const number = /^0x[0-9a-f]+$/i.test(at.block) ? BigInt(at.block).toLocaleString('en-US') : at.block;
        throw Object.assign(new Error(`the local EVM reads the chain's state as it runs, and the chain's node didn't serve it block ${number}'s (most keep only recent blocks; an archive node keeps them all)`), { name: 'ForkUnsupported' });
      }
      // A node that kept refusing those reads for a rate limit (a public RPC's): said as that, not as a slow run.
      if (e instanceof Error && /HTTP 429|rate limit/i.test(e.message)) throw Object.assign(new Error("the local EVM reads the chain's state as it runs, and the chain's node rate limited those reads (a public RPC's limits: an RPC of your own has more room, or try again in a minute)"), { name: 'ForkUnsupported' });
      return null;
    } finally { clearTimeout(timer); }
  }
  /** The requests with a replay's warm addresses in their access lists (see RpcSimulatorOptions.replay). */
  private warmed(reqs: SimulationRequest[]): SimulationRequest[] {
    const warm = reqs.length ? this.replay?.(reqs[0].chainId)?.warm : undefined;
    return warm?.length ? reqs.map(r => ({ ...r, accessList: [...(r.accessList ?? []), ...warm.map(w => (typeof w === 'string' ? { address: w, storageKeys: [] } : w))] })) : reqs;
  }
  /** What the simulated block had already changed (a replay's, else the requests' own block's: BlockAt.state). */
  private stateOf(reqs: SimulationRequest[]): StateChanges | undefined {
    const r = reqs.length ? this.replay?.(reqs[0].chainId) : undefined;
    return r ? r.state : reqs[0]?.at?.state;
  }
  /** A replay's earlier calls (see RpcSimulatorOptions.replay), as eth_simulateV1 calls. */
  private async before(chainId: number, reqs?: SimulationRequest[], fitted?: SimulationRequest[]): Promise<unknown[]> {
    const before = fitted ?? this.replay?.(chainId)?.before ?? reqs?.[0]?.at?.before ?? [];
    return Promise.all(before.map(async req => ({ from: req.from, ...(req.to && { to: req.to }), data: req.data, value: '0x' + req.value.toString(16), ...await simulationFields(this.buildable(chainId, req)) })));
  }
  /**
   * A call as this chain's node will take it. BNB Chain's node refuses any call that names blob hashes ("Transaction
   * is not buildable", whatever else it is given), so a block with a blob transaction in it couldn't be replayed
   * past that transaction. On such a node a blob transaction is sent as the plain call it also is, at its price:
   * what it does to the chain's state is the same (the blobs are data for elsewhere); only BLOBHASH reads nothing.
   */
  private buildable(chainId: number, req: SimulationRequest): SimulationRequest {
    return this.noBlobCalls.has(chainId) && req.blobVersionedHashes?.length ? { ...req, blobVersionedHashes: undefined, maxFeePerBlobGas: undefined } : req;
  }
  /** eth_simulateV1's blockOverrides: the replayed block's header, and a base fee the calls ask for (see SimulationRequest.baseFee). */
  private blockOverrides(reqs: SimulationRequest[]): Record<string, string> | undefined {
    const replayed = this.at(reqs[0].chainId, reqs).overrides;
    const baseFee = reqs.find(r => r.baseFee !== undefined)?.baseFee;
    if (baseFee === undefined || replayed?.baseFeePerGas) return replayed;
    return { ...replayed, baseFeePerGas: `0x${baseFee.toString(16)}` };
  }
  async simulate(req: SimulationRequest): Promise<SimulationResult | null> {
    return (await this.simulateBatch([req]))?.[0] ?? null;
  }
  async simulateBatch(reqs: SimulationRequest[]): Promise<SimulationResult[] | null> {
    // A block the requests name (SimulationRequest.at) that the node can't serve (a public node that keeps seconds
    // of state, a backend a block behind): the simulation runs on the latest block instead, as it would unasked.
    // Naming a block is for a second run to match this one; it mustn't cost the first.
    if (reqs[0]?.at && !this.replay?.(reqs[0].chainId)) {
      // A block that was asked for is the point: without its state there is no answer.
      if (reqs[0].at.required) {
        try { return await this.simulateAt(reqs); } catch (error) { throw unavailableState(error, reqs[0].at.block); }
      }
      try { return await this.simulateAt(reqs); } catch {
        const latest = await this.simulateAt(reqs.map(({ at: _at, ...r }) => r));
        return latest && latest.map(r => ({ ...r, traceNote: "The chain's node no longer served the block named for the trace, so the simulation shown ran on its latest block and the trace on the one named, a little earlier." }));
      }
    }
    return this.simulateAt(reqs);
  }
  /**
   * The calls after those of their block's earlier transactions that bear on them and the latest of the rest
   * (BlockAt.related), where the node's gas allowance for one simulation doesn't hold them all and the calls: each
   * result says how many were left out. Undefined where there is nothing to narrow to, or that run fails too.
   */
  private async afterRelated(reqs: SimulationRequest[], retried: boolean): Promise<SimulationResult[] | undefined> {
    const all = !this.replay?.(reqs[0].chainId) ? reqs[0]?.at?.before : undefined;
    const kept = all && await reqs[0].at!.related?.().catch(() => undefined);
    if (!all || !kept || kept.length >= all.length) return undefined;
    const part = kept.map(i => all[i]);
    const ran = await this.simulateAt(reqs.map(r => (r.at ? { ...r, at: { ...r.at, before: part, related: undefined, beforeUsed: undefined } } : r)), undefined, retried).catch(() => null);
    return ran?.map(r => ({ ...r, earlierLeftOut: all.length - kept.length }));
  }

  /** What each chain's node allows one simulation in gas, once measured (allowance). */
  private allowances = new Map<number, Promise<bigint | undefined>>();
  /**
   * The gas a chain's node allows one eth_simulateV1 request in all (geth's RPC gas cap, 50 million by default,
   * where Ethereum's blocks hold 60): what a call that never ends uses when it is given no limit of its own (the
   * block's limit, where that is the lower). Measured once for a chain, when a replay needs it; undefined where
   * the node doesn't answer so (asked again the next time).
   */
  private allowance(url: string, chainId: number): Promise<bigint | undefined> {
    let known = this.allowances.get(chainId);
    if (!known) {
      known = (this.post(url, 'eth_simulateV1', [{ blockStateCalls: [{ calls: [{ to: ALLOWANCE_PROBE }], stateOverrides: { [ALLOWANCE_PROBE]: { code: ENDLESS } } }], validation: false }, 'latest']) as Promise<{ result?: { calls?: RawCallResult[] }[] }>)
        // (An answer that doesn't read is no answer: thrown from here, it would be remembered as one and thrown again.)
        .then(body => { try { const c = body?.result?.[0]?.calls?.[0]; return c && c.status !== '0x1' && BigInt(c.gasUsed) > 0n ? BigInt(c.gasUsed) : undefined; } catch { return undefined; } }, () => undefined);
      this.allowances.set(chainId, known);
      void known.then(v => { if (v === undefined) this.allowances.delete(chainId); });
    }
    return known;
  }

  private async simulateAt(reqs: SimulationRequest[], fitted?: SimulationRequest[], retried = false): Promise<SimulationResult[] | null> {
    if (!reqs.length) return [];
    const chainId = reqs[0].chainId;
    if (reqs.some(r => r.chainId !== chainId)) throw new Error('A batch must be on one chain');
    const url = this.urls[chainId];
    if (!url) return null;
    if (this.noSimulate.has(chainId)) return this.withoutSimulateV1(url, chainId, reqs);
    // (Earlier calls a run of this block found to need room for these stand-ins start with it: roomyFor.)
    const earlier = this.replay?.(chainId)?.before ?? reqs[0]?.at?.before;
    // (By what the calls put code at, moved precompile or not: what an earlier call costs under them turns on each.)
    const standIns = [...new Set(reqs.flatMap(r => Object.entries(r.stateOverrides ?? {}).filter(([, o]) => o.movePrecompileToAddress || o.code !== undefined).map(([address]) => address.toLowerCase())))].sort();
    const moved = reqs.some(r => Object.values(r.stateOverrides ?? {}).some(o => o.movePrecompileToAddress)) ? standIns.join(',') : '';
    const known = !fitted && earlier && moved ? this.roomyFor.get(earlier)?.get(moved) : undefined;
    if (known) {
      const ran = await this.simulateAt(reqs, known, retried).catch(() => null);
      if (ran) { this.roomGiven = Math.max(this.roomGiven, known.filter(r => r.roomy).length); return ran; }
    }
    const calls = await Promise.all(this.warmed(reqs).map(async req => ({ from: req.from, ...(req.to && { to: req.to }), data: req.data, value: '0x' + req.value.toString(16), ...await simulationFields(this.buildable(chainId, req)) })));
    const stateOverrides = await simulateV1Overrides(reqs, this.stateOf(reqs));
    const blockOverrides = this.blockOverrides(reqs);
    const before = await this.before(chainId, reqs, fitted);
    const body = await this.post(url, 'eth_simulateV1', [{ blockStateCalls: [{ calls: [...before, ...calls], ...(blockOverrides && { blockOverrides }), ...(stateOverrides && { stateOverrides }) }], traceTransfers: true, validation: false }, this.at(chainId, reqs).tag]) as { result?: { calls: RawCallResult[]; number?: string }[]; error?: { code?: number; message: string } };
    if (body.error?.code === -32601 || /method not found|does not exist|not supported/i.test(body.error?.message ?? '')) {
      this.noSimulate.add(chainId);
      return this.withoutSimulateV1(url, chainId, reqs);
    }
    // A node that won't build a call with blob hashes (see buildable): asked again without them, from now on.
    if (/not buildable/i.test(body.error?.message ?? '') && !this.noBlobCalls.has(chainId) && [...reqs, ...(this.replay?.(chainId)?.before ?? reqs[0]?.at?.before ?? [])].some(r => r.blobVersionedHashes?.length)) {
      this.noBlobCalls.add(chainId);
      return this.simulateAt(reqs, fitted, retried);
    }
    // Refused so with the blob calls already plain: once, a backend's passing refusal (1 replay of 80 on BNB Chain;
    // it ran when asked again), so asked once more after a pause.
    if (/not buildable/i.test(body.error?.message ?? '') && this.noBlobCalls.has(chainId) && !retried) {
      await new Promise(r => setTimeout(r, 500));
      return this.simulateAt(reqs, fitted, true);
    }
    // The stand-ins the calls install can make an earlier transaction fail that succeeded on the chain, and the node
    // refuse the block for one after it that then can't pay: asked again with room for them (roomForStandIns).
    const earlierNow = fitted ?? earlier ?? [];
    const roomy = before.length ? roomForStandIns(earlierNow, reqs, body.error
      ? (/insufficient funds for gas \* price \+ value/i.test(body.error.message ?? '') ? 'unpaid' : [])
      // (Failed for want of gas, ranShort: any other revert is the transaction's own, and more gas wouldn't change it.)
      : (body.result?.[0]?.calls ?? []).slice(0, before.length).flatMap((c, i) => (ranShort(c, earlierNow[i]?.gas) ? [i] : []))) : undefined;
    // (Where the node won't run them so, a node that adds up the calls' gas limits for one, this run stands.)
    const again = roomy && await this.simulateAt(reqs, roomy, retried).catch(() => null);
    // (A run that came back after fewer of the block's transactions, the node's allowance: not this list's.)
    if (again?.some(r => r.earlierLeftOut)) return again;
    if (again) {
      this.roomGiven = Math.max(this.roomGiven, roomy!.filter(r => r.roomy).length);
      // Remembered where it is the block's own list with room and nothing else (not one cut to fit a node's gas,
      // fitGas), and no fuller one is: a rerun that found more calls short remembers its own before this one returns.
      const roomIn = (list: SimulationRequest[]) => list.filter(r => r.roomy).length;
      const ownWithRoom = !!earlier && roomy!.length === earlier.length && roomy!.every((r, i) => r.roomy || r.gas === earlier[i].gas);
      if (earlier && moved && ownWithRoom && roomIn(this.roomyFor.get(earlier)?.get(moved) ?? []) < roomIn(roomy!)) this.roomyFor.set(earlier, (this.roomyFor.get(earlier) ?? new Map<string, SimulationRequest[]>()).set(moved, roomy!));
      return again;
    }
    // A node that adds up the gas limits of the block's calls and won't have them pass the block's (fitGas): the
    // earlier transactions are asked again on less gas each, and none may have run short on it (hadRoom).
    if (/block gas limit exceeded/i.test(body.error?.message ?? '') && before.length) {
      const earlier = this.replay?.(chainId)?.before ?? reqs[0]?.at?.before ?? [], limit = reqs[0]?.at?.header.gasLimit;
      const fit = !fitted && limit !== undefined ? fitGas(earlier, await reqs[0].at?.beforeUsed?.(), limit - reqs.reduce((sum, r) => sum + (r.gas ?? 0n), 0n)) : undefined;
      if (fit) return this.simulateAt(reqs, fit);
      throw new Error(`the chain's node won't run the ${before.length} transactions before this one in its block: it adds up their gas limits, which pass the block's, where the chain counts the gas they used (${body.error!.message}); a node that counts as the chain does can`);
    }
    if (fitted && !body.error && !hadRoom(this.replay?.(chainId)?.before ?? reqs[0]?.at?.before ?? [], fitted, body.result?.[0]?.calls)) throw new Error(`the chain's node won't run the ${before.length} transactions before this one in its block on their own gas limits (it adds them up, and they pass the block's), and on less gas one of them may have run short`);
    const results = body.result?.[0]?.calls?.slice(before.length);
    const source = `eth_simulateV1 @ chain ${chainId}`;
    // Errors that are the answer for a single transaction: the network would reject it the same way. Not when calls
    // ran before it (a replay's earlier transactions): the error may be about any of them, or about the node's own
    // allowance for one simulation, which a block's worth of transactions can use up (Sepolia's blocks hold 200
    // million gas, more than its public node allows one simulation).
    const rejected = body.error?.message && reqs.length === 1 && !before.length ? rejection(body.error.message) : null;
    if (rejected) return [{ status: 'reverted', source, revertReason: rejected, transfers: [], limited: true }];
    if (body.error && before.length && /intrinsic gas too low|gas limit reached|out of gas|gas required exceeds/i.test(body.error.message ?? '')) {
      // The node allows one simulation so much gas, and the block's earlier transactions used more: run again after
      // those of them that bear on the calls, and the latest of the rest (BlockAt.related), which the result says.
      const ran = !fitted ? await this.afterRelated(reqs, retried) : undefined;
      if (ran) return ran;
      throw new Error(`the chain's node couldn't run the ${before.length} transactions before this one in its block within its gas allowance for one simulation (${body.error.message}); a node with a higher allowance can`);
    }
    if (body.error || !results || results.length !== reqs.length) throw new Error(`eth_simulateV1 failed: ${body.error?.message ?? 'unexpected result'}`);
    // The same allowance, met without a word: what the block's earlier transactions used comes out of it, and a
    // call after them is given what is left where that is under its own limit. On Ethereum's public node a Safe
    // transaction with a limit of 8,964,428 ran on the 8,153,736 left after its block's 41,846,264, and its call
    // ran out (GS013) where on the chain it had succeeded (2026-11-23; run on the parent block alone it came out
    // as its receipt, to the gas). A call that ran out on less than it asked for is run again after the earlier
    // transactions that bear on it, as where the node refuses. Only one that ran out (ranShort, on what was left):
    // a call that fails on a fraction of its gas failed by itself, whatever the allowance had left, and after fewer
    // of the block's transactions it could come out as something that didn't happen. And the narrowed run is kept
    // only where such a call then runs: one that fails there too is shown as it failed after the whole block.
    if (before.length && reqs[0]?.at?.related && !this.replay?.(chainId) && results.some(r => r.status !== '0x1')) {
      const allowance = await this.allowance(url, chainId);
      let used = body.result![0].calls.slice(0, before.length).reduce((sum, c) => sum + BigInt(c.gasUsed), 0n);
      const short = allowance === undefined ? [] : results.flatMap((r, i) => {
        const left = allowance > used ? allowance - used : 1n;
        used += BigInt(r.gasUsed);
        return r.status !== '0x1' && (reqs[i].gas === undefined || reqs[i].gas! > left) && ranShort(r, left) ? [i] : [];
      });
      const ran = short.length ? await this.afterRelated(reqs, retried) : undefined;
      if (ran && short.some(i => ran[i]?.status === 'success')) return ran;
    }
    const parsed: SimulationResult[] = results.map(result => {
      const gasUsed = BigInt(result.gasUsed), peak = result.maxUsedGas ? BigInt(result.maxUsedGas) : undefined;
      const gasPeak = peak !== undefined && peak > gasUsed ? { gasPeak: peak } : {};
      return result.status !== '0x1'
        ? { status: 'reverted', source, gasUsed, ...gasPeak, revertReason: decodeRevert(result.error?.data ?? result.returnData) ?? result.error?.message, transfers: [], ...((result.error?.data ?? result.returnData) && { returnData: result.error?.data ?? result.returnData }) }
        : { status: 'success', source, gasUsed, ...gasPeak, ...parseLogs(result.logs ?? []), ...(result.returnData && { returnData: result.returnData }),
          // Without the native transfers traceTransfers adds (logged by a pseudo-address).
          logs: (result.logs ?? []).filter(l => l.address.toLowerCase() !== NATIVE_PSEUDO_TOKEN).map(l => ({ address: l.address.toLowerCase(), topics: l.topics, data: l.data })) };
    });
    // The reads on the state the run had: a request not pinned to a block ran on whichever was the latest, and on a
    // chain of five blocks a second (Base) the next request's latest is often another (eth_simulateV1 says which
    // block it simulated).
    const ranOn = this.at(chainId, reqs).tag === 'latest' && body.result?.[0]?.number ? `0x${(BigInt(body.result[0].number) - 1n).toString(16)}` : undefined;
    // Whatever stops the reads, the event-based values stand, and the results say why.
    try { await this.readState(url, reqs, parsed, ranOn, fitted); } catch (e) { for (const p of parsed) p.stateReadError ??= String((e as Error)?.message ?? e).slice(0, 200); }
    // (After the reads, which match the calls' gas to the node's own figure.)
    await this.amsterdamStandIns(url, reqs, parsed, ranOn ?? this.at(chainId, reqs).tag, body.result?.[0] as { blockAccessListHash?: string } | undefined);
    return parsed;
  }

  /**
   * Under Amsterdam (Glamsterdam: Sepolia), what an unsigned authorization's stand-in costs isn't what the sender's
   * own will: the stand-in, another account, pays 9,000 for the first write to its account, which the sender's own
   * doesn't (the transaction has written the sender already), and it clears a delegation it hasn't, where the
   * sender's own, delegating an account not delegated yet, pays for the delegation's 23 bytes (35,190). Measured on
   * Sepolia (2026-11-16): 31,816 gas with the stand-in for a fresh sender where its own authorization took 58,006,
   * and for one already delegated 31,816 where its own took 22,816. Each request's gas is corrected by the difference,
   * from the sender's code before the block (an authorization for another chain doesn't apply, and isn't counted).
   */
  private async amsterdamStandIns(url: string, reqs: SimulationRequest[], parsed: SimulationResult[], tag: string, simulated?: { blockAccessListHash?: string }) {
    const asked = reqs.map((r, i) => ({ r, i })).filter(({ r, i }) => parsed[i]?.gasUsed !== undefined && r.unsignedAuthorizations?.some(a => a.chainId === 0 || a.chainId === r.chainId));
    if (!asked.length) return;
    const amsterdam = reqs[0].at?.header.amsterdam ?? (simulated?.blockAccessListHash !== undefined
      || !!((await this.post(url, 'eth_getBlockByNumber', [tag, false]).catch(() => undefined)) as { result?: { blockAccessListHash?: string } } | undefined)?.result?.blockAccessListHash);
    if (!amsterdam) return;
    for (const { r, i } of asked) {
      // (The sender's code before the transaction: as the block's state beneath the request has it, else the chain's.
      // Not the request's own override, which is the authorization's effect standing in: its delegation.)
      const given = Object.entries(r.at?.state ?? {}).find(([k]) => k.toLowerCase() === r.from.toLowerCase())?.[1]?.code;
      const code = given ?? ((await this.post(url, 'eth_getCode', [r.from, tag]).catch(() => undefined)) as { result?: string } | undefined)?.result;
      if (typeof code !== 'string') continue;
      const delegated = /^0xef0100[0-9a-f]{40}$/i.test(code), applying = r.unsignedAuthorizations!.filter(a => a.chainId === 0 || a.chainId === r.chainId);
      const bytes = !delegated && applying.some(a => !/^0x0{40}$/i.test(a.address)) ? 23n * 1_530n : 0n;
      const p = parsed[i], fix = (g: bigint) => (g + bytes > 9_000n ? g + bytes - 9_000n : g);
      p.gasUsed = fix(p.gasUsed!);
      if (p.gasPeak !== undefined) p.gasPeak = fix(p.gasPeak);
    }
  }

  /**
   * One JSON-RPC request, retried when the node rate-limits: HTTP 429 or 5xx, or a rate-limit error inside an HTTP
   * 200 (Arbitrum's and HyperEVM's public RPCs do both). A rate limit is never mistaken for an answer. So is one
   * answered by a load-balanced node that hasn't the block asked for yet ("block not found", "header not found"),
   * three times: Ethereum's public node answered so for the parent of the block it had just served, and three
   * replays at their block's pre-state failed (2026-11-15). (A block that isn't there still fails, 3.5 seconds on.)
   */
  private async post(url: string, method: string, params: unknown[]): Promise<{ result?: unknown; error?: { code?: number; message?: string; data?: Hex } }> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(20_000), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const retry = () => attempt < 4 && new Promise(r => setTimeout(r, 500 * 2 ** attempt)).then(() => true);
      if ((res.status === 429 || res.status >= 500) && await retry()) continue;
      if (!res.ok) {
        // A node that refuses says why in the body (a public node asked for a block it counts as archive answers 403).
        const why = await res.json().then(b => (b as { error?: { message?: string } })?.error?.message, () => undefined);
        throw new Error(`RPC HTTP ${res.status}${typeof why === 'string' ? `: ${why}` : ''}`);
      }
      const body = await res.json() as { result?: unknown; error?: { code?: number; message?: string; data?: Hex } };
      if (body.error && (body.error.code === -32005 || body.error.code === 429 || /rate limit|too many requests|adjustable limit/i.test(body.error.message ?? '')) && await retry()) continue;
      if (body.error && /block not found|header not found|unknown block/i.test(body.error.message ?? '') && attempt < 3 && await retry()) continue;
      // An OP Stack block's transactions count against its DA footprint (Jovian), and a simulated block's calls do
      // too: a replay in a block that filled it can't fit the reads after its transaction ("transaction DA footprint
      // exceeds available block DA footprint", OP Mainnet, 2026-11-16). Asked again with room for them (daRoom).
      if (method === 'eth_simulateV1' && body.error && DA_FULL.test(body.error.message ?? '')) {
        const roomy = await this.daRoom(url, params);
        if (roomy) return this.post(url, method, roomy);
      }
      return body;
    }
  }
  /**
   * eth_simulateV1's params with room in the simulated block's DA footprint: L1Block's daFootprintGasScalar (16 bits
   * of its slot 8, above the operator fee's scalar and constant, on OP Mainnet and Base) set to 0 for the run, the
   * slot's other fields kept, so no call counts against it. A replay's block starts with its L1-attributes deposit
   * (setL1BlockValuesJovian, whose calldata ends with the scalar), which would write it back before the calls after
   * it: its last two bytes are set to 0 too. Only where the slot holds the scalar the contract reports (read at the
   * run's block), and its blocks don't already set that slot.
   */
  private async daRoom(url: string, params: unknown[]): Promise<unknown[] | null> {
    const [opts, tag] = params as [{ blockStateCalls: { stateOverrides?: Record<string, { state?: Record<string, Hex>; stateDiff?: Record<string, Hex> }> }[] }, string];
    const first = opts?.blockStateCalls?.[0];
    if (!first || opts.blockStateCalls.some(b => { const o = b.stateOverrides?.[L1_BLOCK]; return !!o?.state || !!o?.stateDiff?.[L1_BLOCK_DA_SLOT]; })) return null;
    try {
      const [word, scalar] = await Promise.all([
        this.post(url, 'eth_getStorageAt', [L1_BLOCK, L1_BLOCK_DA_SLOT, tag]), this.post(url, 'eth_call', [{ to: L1_BLOCK, data: DA_FOOTPRINT_GAS_SCALAR }, tag])]);
      const w = BigInt(String(word.result)), s = BigInt(String(scalar.result));
      if (!s || ((w >> 96n) & 0xffffn) !== s) return null;
      const kept = `0x${(w & ~(0xffffn << 96n)).toString(16).padStart(64, '0')}` as Hex;
      const at = first.stateOverrides?.[L1_BLOCK], tail = s.toString(16).padStart(4, '0');
      const deposit = (c: { to?: string; data?: string }) => c.to?.toLowerCase() === L1_BLOCK && typeof c.data === 'string' && c.data.length === 2 + 178 * 2
        && c.data.toLowerCase().startsWith(SET_L1_BLOCK_VALUES_JOVIAN) && c.data.toLowerCase().endsWith(tail) ? { ...c, data: `${c.data.slice(0, -4)}0000` } : c;
      const blocks = opts.blockStateCalls.map(b => ({ ...b, ...((b as { calls?: unknown[] }).calls && { calls: (b as { calls: { to?: string; data?: string }[] }).calls.map(deposit) }) }));
      return [{ ...opts, blockStateCalls: [{ ...blocks[0], stateOverrides: { ...first.stateOverrides, [L1_BLOCK]: { ...at, stateDiff: { ...at?.stateDiff, [L1_BLOCK_DA_SLOT]: kept } } } }, ...blocks.slice(1)] }, ...params.slice(1)];
    } catch { return null; }
  }

  private async withoutSimulateV1(url: string, chainId: number, reqs: SimulationRequest[]): Promise<SimulationResult[]> {
    // Calls that must run first (a replay's earlier transactions) need a simulator that runs several in one block.
    if (reqs[0]?.at?.before?.length && !this.fork?.covers(chainId)) throw new Error("This chain's node has no eth_simulateV1 and no local EVM is set up for it, so the block's earlier transactions can't be run before this one.");
    if (!this.fork?.covers(chainId)) return this.probeOrCall(url, chainId, reqs);
    const forked = this.fork.simulateBatch(reqs);
    forked.catch(() => { /* a late failure only means the probe's answer stood */ });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const first = await Promise.race([forked.then(r => ({ r }), () => null), new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), this.forkBudgetMs); })]);
    clearTimeout(timer);
    if (first?.r) return first.r;
    // The probe answers; the tokens the fork run has seen so far are worth reading too. If the fork run, which
    // carries on, finishes while the probe is still out, its fuller answer is taken instead.
    const hints = this.fork.discovered?.(reqs) ?? [];
    const probed = this.probeOrCall(url, chainId, hints.length ? reqs.map(r => ({ ...r, watch: [...new Set([...(r.watch ?? []), ...hints])] })) : reqs);
    probed.catch(() => { /* the fork's answer may still come */ });
    return Promise.race([probed, forked.then(r => r ?? probed, () => probed)]);
  }

  /** The probe's answer, or eth_call's where the probe can't run. */
  private async probeOrCall(url: string, chainId: number, reqs: SimulationRequest[]): Promise<SimulationResult[]> {
    // The probe takes over the sender's code, so it can't also apply code overrides (EIP-7702 delegations).
    // It also measures the sender, so a request about another account (a smart account called into) can't use it.
    const probeable = reqs.every(r => r.to && r.from.toLowerCase() === reqs[0].from.toLowerCase() && (!r.account || r.account.toLowerCase() === r.from.toLowerCase())) && !overridesOf(reqs);
    if (probeable && !this.noProbe.has(chainId)) {
      try {
        const results = await probeSimulate((method, params) => this.post(url, method, params), reqs, decodeRevert);
        // A contract that refuses senders with code fails under the probe; a plain eth_call says whether it would
        // really fail.
        if (reqs.length === 1 && results[0].status === 'reverted' && !results[0].revertReason?.startsWith('insufficient funds')) {
          const plain = (await this.ethCallFallback(url, chainId, reqs))[0];
          if (plain.status === 'success') return [{ ...plain, note: "The call succeeds, but its contract treats this simulation's sender differently (it refuses senders with code), so its balance changes couldn't be measured." }];
        }
        return results;
      } catch (e) {
        if (e instanceof ProbeUnsupported) this.noProbe.add(chainId);
        else if (!(e instanceof ProbeFailed)) throw e;
      }
    }
    return this.ethCallFallback(url, chainId, reqs);
  }

  /**
   * Without eth_simulateV1 or state overrides, eth_call still says whether a single call succeeds and why it would
   * revert, but nothing about transfers. Calls in a batch depend on each other, so only a single call is checked.
   */
  private async ethCallFallback(url: string, chainId: number, reqs: SimulationRequest[]): Promise<SimulationResult[]> {
    if (reqs.length > 1) throw new BatchSimulationUnsupported(chainId);
    const req = reqs[0];
    const body = await this.post(url, 'eth_call', [{ from: req.from, ...(req.to && { to: req.to }), data: req.data, value: '0x' + req.value.toString(16) }, this.at(chainId, reqs).tag, ...(req.stateOverrides ? [req.stateOverrides] : [])]);
    const source = `eth_call @ chain ${chainId} (the RPC has no eth_simulateV1)`;
    if (!body.error) return [{ status: 'success', source, transfers: [], limited: true }];
    // A revert comes back as an error carrying the revert data; anything else is a transport or node problem, except
    // a sender that can't cover the value, which fails just as surely.
    const message = body.error.message ?? '';
    if (/insufficient funds/i.test(message)) return [{ status: 'reverted', source, revertReason: "insufficient funds: the account can't cover the value it sends", transfers: [], limited: true }];
    if (!/revert/i.test(message) && !body.error.data) throw new Error(`eth_call failed: ${message}`);
    const reason = decodeRevert(body.error.data) ?? (message.replace(/^execution reverted:?\s*/i, '') || undefined);
    return [{ status: 'reverted', source, revertReason: reason, transfers: [], limited: true }];
  }

  /**
   * Re-runs the calls in one simulated block with view calls around them, reading the actual state:
   * - the senders' balances of every token their Transfer logs mention or the calls name, before the first call and
   *   after each one, so amounts are what balances do (share-based tokens round; WETH-style wrappers emit Deposit and
   *   Withdrawal rather than Transfer, which logs alone miss);
   * - every permission the senders granted so far, after each call (many tokens spend allowances without an event).
   * The reads come from the zero address, so they don't move the senders' nonces. If the re-run's outcomes differ
   * from the first (the state moved on), the event-based values stand.
   *
   * BNB Chain's public node (reth-bsc) splits the block's gas evenly among the calls that set none: 22
   * such calls got 3.2 million each of a 70 million block, and the seventy-odd reads around a swap got about a
   * million each, which one token's balanceOf (1.37 million gas: Open Genesis, on BNB Chain) ran out of, so its
   * misleading events stood (they netted to one unit where the sender's balance went down by 4.56e18). Reads of a
   * token the logs show moving for a sender that fail, and a re-run whose outcomes differ, are asked again in a lean
   * pass (leanReads).
   */
  /** (`fitted`: the earlier transactions on the gas the run gave them, where the node wouldn't take their own: fitGas.) */
  private async readState(url: string, reqs: SimulationRequest[], parsed: SimulationResult[], tag = this.at(reqs[0].chainId, reqs).tag, fitted?: SimulationRequest[]) {
    const owners = [...new Set(reqs.map(r => (r.account ?? r.from).toLowerCase()))];
    const touched = new Map<string, SimulatedApproval>();
    const after: SimulatedApproval[][] = [];
    const unconfirmed = new Set<SimulatedApproval>(); // named approvals: kept only if the state read confirms them
    parsed.forEach((r, i) => {
      // A call that sets a permission by name is listed even if its token emits no Approval event.
      const named = r.status === 'success' ? namedApproval(reqs[i], (reqs[i].account ?? reqs[i].from).toLowerCase(), r.approvals ?? []) : undefined;
      if (named && !(r.approvals ?? []).some(a => approvalKey(a) === approvalKey(named))) { (r.approvals ??= []).push(named); unconfirmed.add(named); }
      for (const a of r.approvals ?? []) if (owners.includes(a.owner)) touched.set(approvalKey(a), a);
      after.push([...touched.values()].slice(0, 24));
    });
    // Tokens: from the senders' Transfer logs, then the ones the calls name, then the chain's well-known ones.
    const skip = (a: string) => owners.includes(a) || /^0x0{40}$/.test(a) || BigInt(a) < 0x10000n || a === NATIVE_PSEUDO_TOKEN || a === NATIVE_LOG_ADDRESS;
    const nftCollections = new Set(parsed.flatMap(r => (r.nftTransfers ?? []).map(t => t.collection)));
    const logged = parsed.flatMap(r => r.transfers.filter(t => t.asset !== 'native' && (owners.includes(t.from) || owners.includes(t.to))).map(t => t.asset));
    const named = reqs.flatMap(r => [...(r.watch ?? []), ...(r.to ? [r.to] : []), ...calldataCandidates(r.data).addresses]).map(a => a.toLowerCase());
    const tokens = [...new Set([...logged, ...named, ...builtinTokens(reqs[0].chainId).map(t => t.address.toLowerCase())])].filter(a => !skip(a) && !nftCollections.has(a)).slice(0, 48);
    const calls: SimCall[] = [];
    const balanceReads = () => owners.flatMap(o => tokens.map(t => { calls.push({ from: READER, to: t, data: `0x70a08231${o.slice(2).padStart(64, '0')}` }); return { owner: o, token: t, index: calls.length - 1 }; }));
    // ERC-721 contracts count NFTs in balanceOf: those are shown per token ID instead.
    const nftChecks = tokens.map(t => { calls.push({ from: READER, to: t, data: `0x01ffc9a780ac58cd${'00'.repeat(28)}` }); return calls.length - 1; });
    // The native coin too (Multicall3's getEthBalance): what moves it without a call isn't always logged. OP
    // Mainnet's, Base's and BNB Chain's nodes log no transfer for a SELFDESTRUCT (2026-11-12), so neither a payout
    // to a sender nor an account delegated (EIP-7702) to code that selfdestructs, its whole balance gone, showed.
    const nativeReads = () => owners.map(o => { calls.push({ from: READER, to: MULTICALL3, data: `0x4d2301cc${o.slice(2).padStart(64, '0')}` }); return calls.length - 1; });
    const natives: number[][] = [nativeReads()];
    const balances: { owner: string; token: string; index: number }[][] = [balanceReads()];
    const reads: { call: number; approval: SimulatedApproval; index: number }[] = [];
    const callIndex: number[] = [];
    const fields = await Promise.all(this.warmed(reqs).map(simulationFields));
    reqs.forEach((req, i) => {
      calls.push({ from: req.from, ...(req.to && { to: req.to }), data: req.data, value: '0x' + req.value.toString(16), ...fields[i] });
      callIndex.push(calls.length - 1);
      for (const a of after[i]) { reads.push({ call: i, approval: a, index: calls.length }); calls.push({ from: READER, to: a.emitter, data: stateCall(a) }); }
      natives.push(nativeReads());
      balances.push(balanceReads());
    });
    const stateOverrides = await simulateV1Overrides(reqs, this.stateOf(reqs));
    const blockOverrides = this.blockOverrides(reqs);
    const before = await this.before(reqs[0].chainId, reqs, fitted);
    // The native coin: what the balance moved beyond the logged transfers (and the gas a priced run's sender paid,
    // exactly its gas used at its price on every node, 2026-11-12, an EIP-7702 call's too as priceFields prices it,
    // 2026-11-15) is added as a transfer of its own, the logged ones kept for whom they name. Not for a blob call
    // (its blob gas is paid too), nor the block's fee recipient (paid the tips).
    const recipient = blockOverrides?.feeRecipient?.toLowerCase();
    // (Whether the owner's native transfers now add up to what its balance did: a call that read it, its readAssets.)
    const unloggedNative = (p: SimulationResult, i: number, owner: string, x: bigint, y: bigint, gasUsed = p.gasUsed): boolean => {
      if (reqs[i].blobVersionedHashes?.length || owner === recipient) return false;
      const fee = reqs[i].gasPrice !== undefined && reqs[i].from.toLowerCase() === owner ? (gasUsed ?? 0n) * reqs[i].gasPrice! : 0n;
      const logged = p.transfers.reduce((sum, t) => t.asset !== 'native' ? sum : sum + (t.to === owner ? t.raw : 0n) - (t.from === owner ? t.raw : 0n), 0n);
      const unlogged = y - x + fee - logged;
      // (Elsewhere, too, for an account that isn't the call's sender, a UserOperation's: its call's target is the
      // EntryPoint, and what the account pays the EntryPoint is for the operation's preview to tell apart, its
      // prefund from its deposits: withoutGas, in src/erc4337-sim.ts.)
      const to = (reqs[i].to ?? READER).toLowerCase(), target = to === owner || owner !== reqs[i].from.toLowerCase() || owners.includes(to) ? ELSEWHERE : to;
      if (unlogged < 0n) p.transfers.push({ asset: 'native', from: owner, to: target, raw: -unlogged });
      else if (unlogged > 0n) p.transfers.push({ asset: 'native', from: target, to: owner, raw: unlogged });
      return true;
    };
    // (On a node that caps the calls it runs, the reads between calls go packed: packReads.)
    const pack = PACKED_READS.has(reqs[0].chainId) ? packReads(calls) : undefined;
    const sentOverrides = pack ? { ...stateOverrides, [VIEW_READER]: { code: VIEW_READER_CODE } } : stateOverrides;
    // (`roomier`: the block's gas limit raised by what the reads use, where the node refused it for its gas: below.)
    const ask = (roomier?: Record<string, string>) => this.post(url, 'eth_simulateV1', [{ blockStateCalls: [{ calls: [...before, ...(pack?.calls ?? calls)], ...((roomier ?? blockOverrides) && { blockOverrides: roomier ?? blockOverrides }), ...(sentOverrides && { stateOverrides: sentOverrides }) }], validation: false }, tag]);
    // (A public node that rate-limits for longer than post's quick retries, as Arbitrum One's does GitHub's runners:
    // asked once more after a pause, since without these reads the amounts are only the events'. It says so in an
    // error or with HTTP 429, which post throws once its own retries are spent. Once only: a preview waits on it.)
    const busy = (m?: string) => !!m && (RATE_LIMITED.test(m) || /HTTP 429/.test(m));
    const patiently = () => ask().catch((e: Error) => { if (busy(e.message)) return { error: { message: e.message } }; throw e; });
    let reply = await patiently();
    if (busy(reply.error?.message)) { await new Promise(r => setTimeout(r, 3000)); reply = await patiently(); }
    // The node refuses a call where the block's gas used so far and the call's own limit pass the block's limit
    // (go-ethereum's simulation), and the reads before a replayed transaction use gas its block didn't: in a full
    // block its own limit no longer fits (OP Mainnet, 2026-11-18: "Block gas limit exceeded by the block's
    // transactions", 9 replays of 80). Asked again with the limit raised by the reads' gas: only GASLIMIT reads it,
    // and a call that went otherwise than in the run (its status or gas) has its reads asked again apart (below).
    if (/block gas limit exceeded/i.test(reply.error?.message ?? '') && before.length) {
      // (The simulated block's limit is its base block's, unless the replay names its own header.)
      const limit = reqs[0]?.at?.header.gasLimit ?? await this.post(url, 'eth_getBlockByNumber', [tag, false]).then(b => BigInt((b.result as { gasLimit: string }).gasLimit), () => undefined);
      const reads = BigInt((pack?.calls ?? calls).length - callIndex.length);
      if (limit !== undefined) reply = await ask({ ...blockOverrides, gasLimit: `0x${(limit + reads * READ_GAS_ROOM).toString(16)}` }).catch((e: Error) => ({ error: { message: e.message } }));
    }
    const body = reply as { result?: { calls: RawCallResult[] }[] };
    const answered = body.result?.[0]?.calls?.slice(before.length), out = answered && pack ? pack.expand(answered) : answered;
    // Where the re-run didn't run, or didn't go the same way (its reads would describe a different execution), the
    // tokens the logs name are asked again in a lean pass (leanReads). On a node that splits the block's gas among
    // the calls that set none, a call that set none may have run short among the reads, and a batch's thousands of
    // reads can leave each less than a call's 21,000 ("intrinsic gas too low": BNB Chain's node, for 3,897 calls).
    // A call that set no gas must also have used the same gas: on such a node it can succeed on its share and still
    // have gone another way (an aggregator that catches a sub-swap running out).
    const differs = (ci: number, i: number) => (out![ci].status === '0x1') !== (parsed[i].status === 'success')
      || (reqs[i].gas === undefined && parsed[i].gasUsed !== undefined && BigInt(out![ci].gasUsed) !== parsed[i].gasUsed);
    const starved = !out || out.length !== calls.length ? /intrinsic gas too low/i.test((body as { error?: { message?: string } }).error?.message ?? '')
      : callIndex.some(differs) ? reqs.some(r => r.gas === undefined) : undefined;
    if (starved !== undefined) {
      // (The native coin too, as below. And a whole UserOperation's EntryPoint: its request, run for the account from
      // a bundler, watches its target, whose balanceOf is the account's deposit, which no event says the change of and
      // the operation's preview counts as the account's coin: withoutGas, in src/erc4337-sim.ts.)
      const deposits = reqs.filter(r => r.account && r.account.toLowerCase() !== r.from.toLowerCase() && r.to && r.watch?.some(w => w.toLowerCase() === r.to!.toLowerCase())).map(r => r.to!.toLowerCase());
      const pairs = owners.flatMap(owner => [...[...new Set([...logged, ...deposits])].filter(t => !skip(t) && !nftCollections.has(t)), 'native'].map(token => ({ owner, token })));
      const again = starved && pairs.length ? await this.leanReads(url, reqs, parsed, pairs, tag, fitted).catch(() => undefined) : undefined;
      if (!again) {
        if (!out) { const why = (body as { error?: { message?: string } }).error?.message ?? 'no answer'; for (const p of parsed) p.stateReadError = why; }
        return;
      }
      parsed.forEach((p, i) => {
        if (p.status !== 'success') return;
        const own = (reqs[i].account ?? reqs[i].from).toLowerCase(), readAssets: string[] = [];
        for (const { owner, token } of pairs) {
          const x = again.get(`${i}:${owner}:${token}`), y = again.get(`${i + 1}:${owner}:${token}`);
          if (x === undefined || y === undefined) continue;
          if (token === 'native') { if (unloggedNative(p, i, owner, x, y) && owner === own) readAssets.push(token); continue; }
          if (owner === own) readAssets.push(token);
          const to = (reqs[i].to ?? READER).toLowerCase(), target = to === owner || owners.includes(to) ? ELSEWHERE : to;
          p.transfers = p.transfers.filter(t => t.asset !== token || (t.from !== owner && t.to !== owner));
          if (y < x) p.transfers.push({ asset: token, from: owner, to: target, raw: x - y });
          else if (y > x) p.transfers.push({ asset: token, from: target, to: owner, raw: y - x });
        }
        p.balancesRead = true;
        p.readAssets = readAssets;
      });
      return;
    }
    if (!out) return;
    for (const { call, approval, index } of reads) {
      const r = out[index];
      if (r.status !== '0x1') continue; // non-standard token: keep the event value
      const state = decodeState(approval, r.returnData);
      if (state) { (parsed[call].approvalState ??= []).push(state); unconfirmed.delete(approval); }
    }
    for (const p of parsed) if (p.approvals) p.approvals = p.approvals.filter(a => !unconfirmed.has(a));
    const word = (r: RawCallResult | undefined) => r && r.status === '0x1' && r.returnData.length >= 66 ? BigInt(r.returnData.slice(0, 66)) : undefined;
    const isNft = new Set(tokens.filter((_, j) => word(out[nftChecks[j]]) === 1n));
    // Reads that failed (reverted, as one that runs out of gas does) for a token the logs show moving for its owner:
    // asked again on their own (leanReads). One that answered nothing is a token without balanceOf, and stays so.
    const movedFor = new Set(parsed.flatMap(r => r.transfers.flatMap(t => [`${t.from}:${t.asset}`, `${t.to}:${t.asset}`])));
    const failed = balances[0].filter((b, j) => !isNft.has(b.token) && movedFor.has(`${b.owner}:${b.token}`) && balances.some(at => out[at[j].index].status !== '0x1'));
    const again = failed.length ? await this.leanReads(url, reqs, parsed, failed.map(b => ({ owner: b.owner, token: b.token })), tag).catch(() => undefined) : undefined;
    const read = (at: number, j: number) => again?.get(`${at}:${balances[at][j].owner}:${balances[at][j].token}`) ?? word(out[balances[at][j].index]);
    parsed.forEach((p, i) => {
      if (p.status !== 'success') return;
      const own = (reqs[i].account ?? reqs[i].from).toLowerCase(), readAssets: string[] = [];
      for (const [j, b] of balances[i + 1].entries()) {
        if (isNft.has(b.token)) continue;
        const x = read(i, j), y = read(i + 1, j);
        if (x === undefined || y === undefined) continue; // balanceOf unreadable: keep the logs
        if (b.owner === own) readAssets.push(b.token);
        // The balance difference replaces whatever the logs said about this token and owner.
        // A call to the account itself (an EIP-7702 account running its own batch) moved the tokens elsewhere. And
        // so did a call to another account whose balances are read here (a Safe its owner sends a transaction to,
        // both read): that account's own change is what its own reads say, and it isn't named as where this one's
        // went. (A Safe transaction that had the Safe pull 1,140 USDC from its owner and repay a loan with them
        // showed the Safe receiving 1,140 USDC, its balance unchanged: Arbitrum One, 2026-11-23.)
        const to = (reqs[i].to ?? READER).toLowerCase(), target = to === b.owner || owners.includes(to) ? ELSEWHERE : to;
        p.transfers = p.transfers.filter(t => t.asset !== b.token || (t.from !== b.owner && t.to !== b.owner));
        if (y < x) p.transfers.push({ asset: b.token, from: b.owner, to: target, raw: x - y });
        else if (y > x) p.transfers.push({ asset: b.token, from: target, to: b.owner, raw: y - x });
      }
      // The native coin (unloggedNative).
      owners.forEach((owner, j) => {
        const x = word(out[natives[i][j]]), y = word(out[natives[i + 1][j]]);
        if (x !== undefined && y !== undefined && unloggedNative(p, i, owner, x, y, BigInt(out[callIndex[i]].gasUsed)) && owner === own) readAssets.push('native');
      });
      p.balancesRead = true;
      p.readAssets = readAssets;
    });
  }

  /**
   * Balance reads asked again on their own (readState): the calls as before, with the given owners' balances of the
   * given tokens read before the first and after each, and nothing else. Each call is given its own gas (what it set,
   * else what it used and half as much again and 100,000, or its gasFloor if more), so a node that splits the block's gas among the calls that
   * set none (BNB Chain's) gives the few reads a large share. Every call must come out as it did the first time: the same
   * outcome and the same gas used, or nothing is read. The values by `${callsBefore}:${owner}:${token}`.
   */
  private async leanReads(url: string, reqs: SimulationRequest[], parsed: SimulationResult[], pairs: { owner: string; token: string }[], tag: string, fitted?: SimulationRequest[]): Promise<Map<string, bigint> | undefined> {
    const max = (a: bigint, b: bigint) => (a > b ? a : b);
    const calls: SimCall[] = [], where: { key: string; index: number }[] = [], callIndex: number[] = [];
    const reads = (at: number) => { for (const { owner, token } of pairs) { where.push({ key: `${at}:${owner}:${token}`, index: calls.length }); calls.push(token === 'native' ? { from: READER, to: MULTICALL3, data: `0x4d2301cc${owner.slice(2).padStart(64, '0')}` } : { from: READER, to: token, data: `0x70a08231${owner.slice(2).padStart(64, '0')}` }); } };
    const fields = await Promise.all(this.warmed(reqs).map(simulationFields));
    reads(0);
    reqs.forEach((req, i) => {
      const used = parsed[i].gasUsed;
      if (req.gas === undefined && used === undefined) throw new Error('no gas to give the call');
      callIndex.push(calls.length);
      calls.push({ from: req.from, ...(req.to && { to: req.to }), data: req.data, value: '0x' + req.value.toString(16), ...fields[i], ...(req.gas === undefined && { gas: `0x${max(used! * 3n / 2n + 100_000n, req.gasFloor ?? 0n).toString(16)}` }) });
      reads(i + 1);
    });
    const stateOverrides = await simulateV1Overrides(reqs, this.stateOf(reqs));
    const blockOverrides = this.blockOverrides(reqs);
    const before = await this.before(reqs[0].chainId, reqs, fitted);
    const pack = PACKED_READS.has(reqs[0].chainId) ? packReads(calls) : undefined;
    const sentOverrides = pack ? { ...stateOverrides, [VIEW_READER]: { code: VIEW_READER_CODE } } : stateOverrides;
    const body = await this.post(url, 'eth_simulateV1', [{ blockStateCalls: [{ calls: [...before, ...(pack?.calls ?? calls)], ...(blockOverrides && { blockOverrides }), ...(sentOverrides && { stateOverrides: sentOverrides }) }], validation: false }, tag]) as { result?: { calls: RawCallResult[] }[] };
    const answered = body.result?.[0]?.calls?.slice(before.length), out = answered && pack ? pack.expand(answered) : answered;
    if (!out || out.length !== calls.length) return undefined;
    if (callIndex.some((ci, i) => (out[ci].status === '0x1') !== (parsed[i].status === 'success') || (parsed[i].gasUsed !== undefined && BigInt(out[ci].gasUsed) !== parsed[i].gasUsed))) return undefined;
    const values = new Map<string, bigint>();
    for (const { key, index } of where) { const r = out[index]; if (r.status === '0x1' && r.returnData.length >= 66) values.set(key, BigInt(r.returnData.slice(0, 66))); }
    return values;
  }
}

/**
 * A reader for views, several static calls in one: ForkSimulator's runOnNode places it for the reads around a call
 * the chain's node runs, and readState for its reads on a node that caps the calls it runs (packReads). Its calldata
 * is 192 bytes for each (the address, the length of the calldata, the calldata in 128 bytes); it returns 160 bytes
 * for each: whether the call succeeded, the length of what it returned, and the first 96 bytes of that. Each call
 * gets 10 million gas (VIEW_GAS), as a view of its own did.
 *   PUSH1 0 PUSH1 0 [JUMPDEST DUP1 CALLDATASIZE GT ISZERO PUSH2 0x3c JUMPI
 *   DUP1 PUSH1 0x20 ADD CALLDATALOAD DUP1 DUP3 PUSH1 0x40 ADD CALLDATASIZE CALLDATACOPY
 *   PUSH1 0x60 DUP4 PUSH1 0x40 ADD DUP3 CALLDATASIZE DUP6 CALLDATALOAD PUSH3 10000000 STATICCALL DUP4 MSTORE POP
 *   RETURNDATASIZE DUP3 PUSH1 0x20 ADD MSTORE PUSH1 0xc0 ADD SWAP1 PUSH1 0xa0 ADD SWAP1 PUSH1 4 JUMP]
 *   JUMPDEST POP PUSH1 0 RETURN
 * (Each call's calldata is copied past the answers, at CALLDATASIZE, which is beyond them. No PUSH0.)
 */
export const VIEW_READER = '0x00000000000000000000000000000000ba1a9ce6';
export const VIEW_READER_CODE = '0x600060005b8036111561003c578060200135808260400136376060836040018236853562989680fa8352503d826020015260c0019060a001906004565b506000f3';
/** VIEW_READER's calldata for the views (address, calldata of at most 128 bytes). */
export const viewReads = (views: [string, Hex][]): Hex => `0x${views.map(([to, data]) => `${to.slice(2).toLowerCase().padStart(64, '0')}${((data.length - 2) / 2).toString(16).padStart(64, '0')}${data.slice(2).padEnd(256, '0')}`).join('')}`;
/** VIEW_READER's answer, as the `count` views' own results would have been (their status, and what they returned). */
export function viewResults(c: { status: string; returnData: Hex } | undefined, count: number): { status: string; returnData: Hex; gasUsed: Hex; logs: { address: string; topics: string[]; data: string }[] }[] {
  const out = c?.status === '0x1' ? c.returnData.slice(2) : '';
  return Array.from({ length: count }, (_, k) => {
    const e = out.slice(k * 320, (k + 1) * 320);
    const ok = e.length === 320 && BigInt(`0x${e.slice(0, 64)}`) === 1n, size = ok ? Math.min(Number(BigInt(`0x${e.slice(64, 128)}`)), 96) : 0;
    return { status: ok ? '0x1' : '0x0', returnData: `0x${e.slice(128, 128 + 2 * size)}` as Hex, gasUsed: '0x0', logs: [] };
  });
}

/** Each view in a VIEW_READER call gets this much gas, as a view of its own had (ForkSimulator's VIEW_GAS). */
const READ_GAS = 10_000_000n;
/**
 * Chains whose public node caps the calls in an eth_simulateV1: Arbitrum One's answers one of more than 30 calls,
 * counted across its blocks, with HTTP 429, every time (30 ran, 31 never did, 2026-11-16). readState's reads are
 * three calls a token for one call (its balance before and after, and whether it is an NFT collection), so a call
 * naming twelve tokens more than its own took 51 and lost its reads to ten refusals ("RPC HTTP 429", 19.6 s).
 */
const PACKED_READS = new Set([42161]);
/** A call in an eth_simulateV1's block, as readState and leanReads build them. */
type SimCall = { from?: string; to?: string; data?: string; [field: string]: unknown };
/** The address readState's and leanReads' reads come from: it has no nonce to move. */
const READER = '0x0000000000000000000000000000000000000000';
/**
 * The calls of an eth_simulateV1 with each run of reads (calls from READER) packed into one call to VIEW_READER, as
 * static calls, and `expand`, which gives the answer back one result a call, as the calls unpacked would have had it.
 * (A read with calldata over VIEW_READER's 128 bytes stays a call of its own; none of readState's is.)
 */
function packReads(calls: SimCall[]): { calls: unknown[]; expand: <T extends { status: string; returnData: Hex }>(out: T[]) => T[] } {
  const packed: unknown[] = [], where: [number, number][] = [], counts = new Map<number, number>();
  const isRead = (c: SimCall) => c.from === READER && !!c.to && (c.data ?? '0x').length <= 2 + 256;
  for (let k = 0; k < calls.length;) {
    if (!isRead(calls[k])) { where.push([packed.length, -1]); packed.push(calls[k]); k++; continue; }
    const views: [string, Hex][] = [];
    while (k < calls.length && isRead(calls[k])) { where.push([packed.length, views.length]); views.push([calls[k].to!, (calls[k].data ?? '0x') as Hex]); k++; }
    counts.set(packed.length, views.length);
    packed.push({ from: READER, to: VIEW_READER, data: viewReads(views), gas: `0x${(READ_GAS * BigInt(views.length) + 1_000_000n).toString(16)}` });
  }
  return {
    calls: packed,
    expand: <T extends { status: string; returnData: Hex }>(out: T[]) => {
      // (An answer not whole stays as short as it was: the caller sees it isn't.)
      if (out.length !== packed.length) return out;
      const views = new Map<number, T[]>();
      return where.map(([p, v]) => {
        if (v < 0) return out[p];
        if (!views.has(p)) views.set(p, viewResults(out[p], counts.get(p)!) as unknown as T[]);
        return views.get(p)![v];
      });
    },
  };
}

/** The permission an approve / increaseAllowance / setApprovalForAll / Permit2 approve call sets, by its arguments. */
export function namedApproval(req: SimulationRequest, from: string, logged: SimulatedApproval[] = []): SimulatedApproval | undefined {
  if (!req.to) return undefined;
  // ERC-721 approve(address,uint256) shares ERC-20's selector: an NFT approval in the logs settles which it was.
  if (logged.some(a => (a.kind === 'erc721' || a.kind === 'operator') && a.token === req.to!.toLowerCase())) return undefined;
  const sel = req.data.slice(0, 10), arg = (n: number) => `0x${req.data.slice(10 + 64 * n + 24, 10 + 64 * (n + 1))}`, num = (n: number) => BigInt(`0x${req.data.slice(10 + 64 * n, 10 + 64 * (n + 1)) || '0'}`);
  const to = req.to.toLowerCase();
  if (req.data.length < 10 + 64 * 2) return undefined;
  if (sel === '0x095ea7b3' || sel === '0x39509351') return { kind: 'erc20', emitter: to, token: to, owner: from, spender: arg(0), amount: num(1) };
  if (sel === '0xa22cb465') return { kind: 'operator', emitter: to, token: to, owner: from, spender: arg(0), approved: num(1) !== 0n };
  if (sel === '0x87517c45' && to === PERMIT2 && req.data.length >= 10 + 64 * 4) return { kind: 'permit2', emitter: to, token: arg(0), owner: from, spender: arg(1), amount: num(2), expiration: Number(num(3)) };
  return undefined;
}

/** One key per permission: an allowance per token and spender, one NFT, or an operator per collection. */
export const approvalKey = (a: SimulatedApproval) => a.kind === 'erc721' ? `erc721:${a.token}:${a.tokenId}` : `${a.kind}:${a.token}:${a.spender}`;

/** The view call that reads a permission's current state (allowance, Permit2 allowance, isApprovedForAll, getApproved). */
export function stateCall(a: SimulatedApproval): Hex {
  if (a.kind === 'erc20') return ('0xdd62ed3e' + encodeAbiParameters([{ type: 'address' }, { type: 'address' }], [a.owner as Hex, a.spender as Hex]).slice(2)) as Hex; // allowance(owner,spender)
  if (a.kind === 'permit2') return ('0x927da105' + encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'address' }], [a.owner as Hex, a.token as Hex, a.spender as Hex]).slice(2)) as Hex; // Permit2 allowance(owner,token,spender)
  if (a.kind === 'operator') return ('0xe985e9c5' + encodeAbiParameters([{ type: 'address' }, { type: 'address' }], [a.owner as Hex, a.spender as Hex]).slice(2)) as Hex; // isApprovedForAll(owner,operator)
  return ('0x081812fc' + encodeAbiParameters([{ type: 'uint256' }], [a.tokenId ?? 0n]).slice(2)) as Hex; // getApproved(tokenId)
}

export function decodeState(a: SimulatedApproval, data: Hex): SimulatedApproval | null {
  try {
    if (a.kind === 'erc20') return { ...a, amount: decodeAbiParameters([{ type: 'uint256' }], data)[0] };
    if (a.kind === 'permit2') { const [amount, expiration] = decodeAbiParameters([{ type: 'uint160' }, { type: 'uint48' }, { type: 'uint48' }], data); return { ...a, amount, expiration }; }
    if (a.kind === 'operator') return { ...a, approved: decodeAbiParameters([{ type: 'bool' }], data)[0] };
    return { ...a, spender: decodeAbiParameters([{ type: 'address' }], data)[0].toLowerCase() };
  } catch { return null; }
}

type Log = { address: string; topics: string[]; data: string };
const topicAddress = (t: string) => '0x' + t.slice(26).toLowerCase();
const isWords = (data: string, n: number) => new RegExp(`^0x[0-9a-fA-F]{${64 * n}}$`).test(data);
const isEmpty = (data: string) => data === '0x' || data === '';

/** A node's refusal that says why the transaction can't run at all, worded for the preview; null for other errors. */
export function rejection(message: string): string | null {
  if (/insufficient funds/i.test(message)) return "insufficient funds: the account can't cover the value it sends";
  if (/intrinsic gas too low/i.test(message)) return 'out of gas: the gas limit is below the minimum any transaction with this calldata needs';
  return null;
}

/** Fungible transfers only (ERC-20 and, with traceTransfers, native). */
export function parseTransfers(logs: Log[]): SimulatedTransfer[] {
  return parseLogs(logs).transfers;
}

/**
 * Reads transfers and approvals from simulated logs. The emitting contract is taken from the log itself, so a
 * contract can't fake events for another token; Permit2 events are only read from the canonical Permit2.
 */
export function parseLogs(logs: Log[]): { transfers: SimulatedTransfer[]; nftTransfers: SimulatedNftTransfer[]; approvals: SimulatedApproval[]; coreActions?: { user: string; data: string }[] } {
  const transfers: SimulatedTransfer[] = [], nftTransfers: SimulatedNftTransfer[] = [], approvals: SimulatedApproval[] = [], coreActions: { user: string; data: string }[] = [];
  // A chain that logs native transfers itself (EIP-7708): those are the record, and a pseudo-log beside one would count it twice.
  const chainLogsNative = logs.some(l => l.address.toLowerCase() === NATIVE_LOG_ADDRESS);
  for (const log of logs) {
    const address = log.address.toLowerCase();
    const [topic0, t1, t2, t3] = log.topics.map(t => t.toLowerCase());
    const n = log.topics.length;
    if (address === NATIVE_PSEUDO_TOKEN && chainLogsNative) continue;
    if (topic0 === TRANSFER_TOPIC) {
      // ERC-20: 3 topics + amount; ERC-721: 4 topics (tokenId indexed), no data.
      if (n === 3 && isWords(log.data, 1)) transfers.push({ asset: address === NATIVE_PSEUDO_TOKEN || address === NATIVE_LOG_ADDRESS ? 'native' : address, from: topicAddress(t1), to: topicAddress(t2), raw: BigInt(log.data) });
      else if (n === 4 && isEmpty(log.data)) nftTransfers.push({ standard: 'erc721', collection: address, from: topicAddress(t1), to: topicAddress(t2), tokenId: BigInt(t3), amount: 1n });
    } else if (topic0 === TRANSFER_SINGLE_TOPIC && n === 4 && isWords(log.data, 2)) {
      nftTransfers.push({ standard: 'erc1155', collection: address, from: topicAddress(t2), to: topicAddress(t3), tokenId: BigInt('0x' + log.data.slice(2, 66)), amount: BigInt('0x' + log.data.slice(66)) });
    } else if (topic0 === TRANSFER_BATCH_TOPIC && n === 4) {
      try {
        const [ids, values] = decodeAbiParameters([{ type: 'uint256[]' }, { type: 'uint256[]' }], log.data as Hex);
        if (ids.length === values.length) ids.forEach((id, i) => nftTransfers.push({ standard: 'erc1155', collection: address, from: topicAddress(t2), to: topicAddress(t3), tokenId: id, amount: values[i] }));
      } catch { /* malformed */ }
    } else if ((topic0 === DEPOSIT_TOPIC || topic0 === WITHDRAWAL_TOPIC) && n === 2 && isWords(log.data, 1) && WRAPPED_NATIVE.has(address)) {
      // A wrap (the token minted to dst) or an unwrap (burnt from src); the native coin moves as a transfer of its own.
      transfers.push(topic0 === DEPOSIT_TOPIC ? { asset: address, from: ZERO_ADDRESS, to: topicAddress(t1), raw: BigInt(log.data) } : { asset: address, from: topicAddress(t1), to: ZERO_ADDRESS, raw: BigInt(log.data) });
    } else if (topic0 === APPROVAL_TOPIC) {
      if (n === 3 && isWords(log.data, 1)) approvals.push({ kind: 'erc20', emitter: address, token: address, owner: topicAddress(t1), spender: topicAddress(t2), amount: BigInt(log.data) });
      else if (n === 4 && isEmpty(log.data)) approvals.push({ kind: 'erc721', emitter: address, token: address, owner: topicAddress(t1), spender: topicAddress(t2), tokenId: BigInt(t3) });
    } else if (topic0 === APPROVAL_FOR_ALL_TOPIC && n === 3 && isWords(log.data, 1)) {
      approvals.push({ kind: 'operator', emitter: address, token: address, owner: topicAddress(t1), spender: topicAddress(t2), approved: BigInt(log.data) !== 0n });
    } else if (address === PERMIT2 && n === 4 && (topic0 === PERMIT2_APPROVAL_TOPIC || topic0 === PERMIT2_PERMIT_TOPIC || topic0 === PERMIT2_LOCKDOWN_TOPIC)) {
      const base = { kind: 'permit2' as const, emitter: address, owner: topicAddress(t1), token: topicAddress(t2), spender: topicAddress(t3) };
      if (topic0 === PERMIT2_LOCKDOWN_TOPIC) approvals.push({ ...base, amount: 0n });
      else if (isWords(log.data, topic0 === PERMIT2_PERMIT_TOPIC ? 3 : 2)) approvals.push({ ...base, amount: BigInt('0x' + log.data.slice(2, 66)), expiration: Number(BigInt('0x' + log.data.slice(66, 130))) });
    } else if (address === CORE_WRITER && topic0 === RAW_ACTION_TOPIC && n === 2) {
      try { coreActions.push({ user: topicAddress(t1), data: decodeAbiParameters([{ type: 'bytes' }], log.data as Hex)[0] }); } catch { /* malformed */ }
    }
  }
  return { transfers, nftTransfers, approvals, ...(coreActions.length && { coreActions }) };
}

const ERRORS = parseAbi(['error Error(string message)', 'error Panic(uint256 code)']);

export function decodeRevert(data: Hex | undefined): string | undefined {
  if (!data || data === '0x') return undefined;
  try {
    const decoded = decodeErrorResult({ abi: ERRORS, data });
    return decoded.errorName === 'Error' ? String(decoded.args[0]) : `Panic(0x${(decoded.args[0] as bigint).toString(16)})`;
  } catch {
    return knownError(data) ?? `custom error ${data.slice(0, 10)}`;
  }
}

/** Returns canned results keyed by `${chainId}:${to}:${data}`; for tests and demos. */
export class MockSimulator implements Simulator {
  private fixtures: Map<string, SimulationResult>;
  constructor(fixtures: Record<string, SimulationResult>) {
    this.fixtures = new Map(Object.entries(fixtures).map(([k, v]) => [k.toLowerCase(), v]));
  }
  static key(req: { chainId: number; to: string | null; data: string }): string {
    return `${req.chainId}:${req.to ?? 'create'}:${req.data}`.toLowerCase();
  }
  async simulate(req: SimulationRequest): Promise<SimulationResult | null> {
    return this.fixtures.get(MockSimulator.key(req)) ?? null;
  }
  /** Per-call fixtures, in order; null unless every call has one. */
  async simulateBatch(reqs: SimulationRequest[]): Promise<SimulationResult[] | null> {
    const results = reqs.map(r => this.fixtures.get(MockSimulator.key(r)));
    return results.every(r => r) ? results as SimulationResult[] : null;
  }
  /** The fixtures again, where each carries a trace (Simulator.trace); null otherwise. */
  async trace(reqs: SimulationRequest[]): Promise<SimulationResult[] | null> {
    const results = reqs.map(r => this.fixtures.get(MockSimulator.key(r)));
    return results.every(r => r?.trace) ? results as SimulationResult[] : null;
  }
}
