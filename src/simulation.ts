import { decodeAbiParameters, decodeErrorResult, encodeAbiParameters, keccak256, parseAbi, stringToBytes, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { recoverAuthorizationAddress } from 'viem/utils';
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

type RawCallResult = { status: string; gasUsed: string; returnData: Hex; logs?: { address: string; topics: string[]; data: string }[]; error?: { message?: string; data?: Hex } };

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
   * transactions) whose results are dropped. `warm`: addresses the replayed transaction had warm from its start
   * (its EIP-7702 authorities), added to each request's access list.
   */
  replay?: (chainId: number) => { block: string; blockOverrides?: Record<string, string>; before?: SimulationRequest[]; warm?: string[]; state?: StateChanges } | undefined;
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
  const authorizationList = authorizationsForNode([...(req.authorizationList ?? []), ...await standIns(req)]);
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
  if (reqs.some(r => r.unsignedAuthorizations?.length)) all[STAND_IN.address.toLowerCase()] = { balance: '0x1', nonce: '0x0', code: '0x' };
  for (const r of reqs) for (const a of r.authorizationList ?? []) {
    try {
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
  return !!results && results.length >= fitted.length && fitted.every((r, i) => r.gas === earlier[i]?.gas || (results[i].gasUsed !== undefined && BigInt(results[i].gasUsed!) * 11n / 8n <= r.gas!));
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

/** A throwaway account standing in for the sender in the gas of authorizations not signed yet (see standIns). */
const STAND_IN = privateKeyToAccount(keccak256(stringToBytes('signing-preview: EIP-7702 gas stand-in')));
type AuthorizationJson = NonNullable<SimulationRequest['authorizationList']>[number];

/**
 * eth_simulateV1 can't apply an authorization nobody has signed yet: the code override stands in for its effect, and
 * for its gas, an authorization signed by a throwaway account set up the same way (it exists, its nonce matches) goes
 * in the call's list. The node charges 25,000 for it and refunds 12,500 within the refund cap, exactly as the chain
 * will for the wallet's own. One for another chain is signed for that chain, so it costs the same and doesn't apply.
 */
async function standIns(req: SimulationRequest): Promise<AuthorizationJson[]> {
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

export class RpcSimulator implements Simulator {
  private urls: Record<number, string>;
  private fetchImpl: typeof fetch;
  private fork?: FallbackSimulator;
  private forkBudgetMs: number;
  private traceBudgetMs: number;
  private replay?: RpcSimulatorOptions['replay'];
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
    return warm?.length ? reqs.map(r => ({ ...r, accessList: [...(r.accessList ?? []), ...warm.map(address => ({ address, storageKeys: [] }))] })) : reqs;
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
  private async simulateAt(reqs: SimulationRequest[], fitted?: SimulationRequest[], retried = false): Promise<SimulationResult[] | null> {
    if (!reqs.length) return [];
    const chainId = reqs[0].chainId;
    if (reqs.some(r => r.chainId !== chainId)) throw new Error('A batch must be on one chain');
    const url = this.urls[chainId];
    if (!url) return null;
    if (this.noSimulate.has(chainId)) return this.withoutSimulateV1(url, chainId, reqs);
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
      throw new Error(`the chain's node couldn't run the ${before.length} transactions before this one in its block within its gas allowance for one simulation (${body.error.message}); a node with a higher allowance can`);
    }
    if (body.error || !results || results.length !== reqs.length) throw new Error(`eth_simulateV1 failed: ${body.error?.message ?? 'unexpected result'}`);
    const parsed: SimulationResult[] = results.map(result => {
      const gasUsed = BigInt(result.gasUsed);
      return result.status !== '0x1'
        ? { status: 'reverted', source, gasUsed, revertReason: decodeRevert(result.error?.data ?? result.returnData) ?? result.error?.message, transfers: [], ...((result.error?.data ?? result.returnData) && { returnData: result.error?.data ?? result.returnData }) }
        : { status: 'success', source, gasUsed, ...parseLogs(result.logs ?? []), ...(result.returnData && { returnData: result.returnData }),
          // Without the native transfers traceTransfers adds (logged by a pseudo-address).
          logs: (result.logs ?? []).filter(l => l.address.toLowerCase() !== NATIVE_PSEUDO_TOKEN).map(l => ({ address: l.address.toLowerCase(), topics: l.topics, data: l.data })) };
    });
    // The reads on the state the run had: a request not pinned to a block ran on whichever was the latest, and on a
    // chain of five blocks a second (Base) the next request's latest is often another (eth_simulateV1 says which
    // block it simulated).
    const ranOn = this.at(chainId, reqs).tag === 'latest' && body.result?.[0]?.number ? `0x${(BigInt(body.result[0].number) - 1n).toString(16)}` : undefined;
    try { await this.readState(url, reqs, parsed, ranOn); } catch { /* keep the event-based values */ }
    return parsed;
  }

  /**
   * One JSON-RPC request, retried when the node rate-limits: HTTP 429 or 5xx, or a rate-limit error inside an HTTP
   * 200 (Arbitrum's and HyperEVM's public RPCs do both). A rate limit is never mistaken for an answer.
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
      return body;
    }
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
  private async readState(url: string, reqs: SimulationRequest[], parsed: SimulationResult[], tag = this.at(reqs[0].chainId, reqs).tag) {
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
    const READER = '0x0000000000000000000000000000000000000000';
    const calls: unknown[] = [];
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
    const before = await this.before(reqs[0].chainId, reqs);
    const ask = () => this.post(url, 'eth_simulateV1', [{ blockStateCalls: [{ calls: [...before, ...calls], ...(blockOverrides && { blockOverrides }), ...(stateOverrides && { stateOverrides }) }], validation: false }, tag]);
    // (A public node that rate-limits for longer than post's quick retries, as Arbitrum One's does GitHub's runners:
    // asked once more after a pause, since without these reads the amounts are only the events'.)
    let reply = await ask();
    if (reply.error && RATE_LIMITED.test(reply.error.message ?? '')) { await new Promise(r => setTimeout(r, 3000)); reply = await ask(); }
    const body = reply as { result?: { calls: RawCallResult[] }[] };
    const out = body.result?.[0]?.calls?.slice(before.length);
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
      const pairs = owners.flatMap(owner => [...new Set(logged)].filter(t => !skip(t) && !nftCollections.has(t)).map(token => ({ owner, token })));
      const again = starved && pairs.length ? await this.leanReads(url, reqs, parsed, pairs, tag).catch(() => undefined) : undefined;
      if (!again) {
        if (!out) { const why = (body as { error?: { message?: string } }).error?.message ?? 'no answer'; for (const p of parsed) p.stateReadError = why; }
        return;
      }
      parsed.forEach((p, i) => {
        if (p.status !== 'success') return;
        for (const { owner, token } of pairs) {
          const x = again.get(`${i}:${owner}:${token}`), y = again.get(`${i + 1}:${owner}:${token}`);
          if (x === undefined || y === undefined) continue;
          const to = (reqs[i].to ?? READER).toLowerCase(), target = to === owner ? ELSEWHERE : to;
          p.transfers = p.transfers.filter(t => t.asset !== token || (t.from !== owner && t.to !== owner));
          if (y < x) p.transfers.push({ asset: token, from: owner, to: target, raw: x - y });
          else if (y > x) p.transfers.push({ asset: token, from: target, to: owner, raw: y - x });
        }
        p.balancesRead = true;
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
      for (const [j, b] of balances[i + 1].entries()) {
        if (isNft.has(b.token)) continue;
        const x = read(i, j), y = read(i + 1, j);
        if (x === undefined || y === undefined) continue; // balanceOf unreadable: keep the logs
        // The balance difference replaces whatever the logs said about this token and owner.
        // A call to the account itself (an EIP-7702 account running its own batch) moved the tokens elsewhere.
        const to = (reqs[i].to ?? READER).toLowerCase(), target = to === b.owner ? ELSEWHERE : to;
        p.transfers = p.transfers.filter(t => t.asset !== b.token || (t.from !== b.owner && t.to !== b.owner));
        if (y < x) p.transfers.push({ asset: b.token, from: b.owner, to: target, raw: x - y });
        else if (y > x) p.transfers.push({ asset: b.token, from: target, to: b.owner, raw: y - x });
      }
      // The native coin: what the balance moved beyond the logged transfers (and the gas a priced run's sender paid,
      // exactly its gas used at its price on every node, 2026-11-12) is added as a transfer of its own, the logged
      // ones kept for whom they name. Not for a blob call (its blob gas is paid too), nor the block's fee recipient
      // (paid the tips).
      const recipient = blockOverrides?.feeRecipient?.toLowerCase();
      if (!reqs[i].blobVersionedHashes?.length) owners.forEach((owner, j) => {
        const x = word(out[natives[i][j]]), y = word(out[natives[i + 1][j]]);
        if (x === undefined || y === undefined || owner === recipient) return;
        const fee = reqs[i].gasPrice !== undefined && reqs[i].from.toLowerCase() === owner ? BigInt(out[callIndex[i]].gasUsed) * reqs[i].gasPrice! : 0n;
        const logged = p.transfers.reduce((sum, t) => t.asset !== 'native' ? sum : sum + (t.to === owner ? t.raw : 0n) - (t.from === owner ? t.raw : 0n), 0n);
        const unlogged = y - x + fee - logged;
        const to = (reqs[i].to ?? READER).toLowerCase(), target = to === owner ? ELSEWHERE : to;
        if (unlogged < 0n) p.transfers.push({ asset: 'native', from: owner, to: target, raw: -unlogged });
        else if (unlogged > 0n) p.transfers.push({ asset: 'native', from: target, to: owner, raw: unlogged });
      });
      p.balancesRead = true;
    });
  }

  /**
   * Balance reads asked again on their own (readState): the calls as before, with the given owners' balances of the
   * given tokens read before the first and after each, and nothing else. Each call is given its own gas (what it set,
   * else what it used and half as much again and 100,000), so a node that splits the block's gas among the calls that
   * set none (BNB Chain's) gives the few reads a large share. Every call must come out as it did the first time: the same
   * outcome and the same gas used, or nothing is read. The values by `${callsBefore}:${owner}:${token}`.
   */
  private async leanReads(url: string, reqs: SimulationRequest[], parsed: SimulationResult[], pairs: { owner: string; token: string }[], tag: string): Promise<Map<string, bigint> | undefined> {
    const READER = '0x0000000000000000000000000000000000000000';
    const calls: unknown[] = [], where: { key: string; index: number }[] = [], callIndex: number[] = [];
    const reads = (at: number) => { for (const { owner, token } of pairs) { where.push({ key: `${at}:${owner}:${token}`, index: calls.length }); calls.push({ from: READER, to: token, data: `0x70a08231${owner.slice(2).padStart(64, '0')}` }); } };
    const fields = await Promise.all(this.warmed(reqs).map(simulationFields));
    reads(0);
    reqs.forEach((req, i) => {
      const used = parsed[i].gasUsed;
      if (req.gas === undefined && used === undefined) throw new Error('no gas to give the call');
      callIndex.push(calls.length);
      calls.push({ from: req.from, ...(req.to && { to: req.to }), data: req.data, value: '0x' + req.value.toString(16), ...fields[i], ...(req.gas === undefined && { gas: `0x${(used! * 3n / 2n + 100_000n).toString(16)}` }) });
      reads(i + 1);
    });
    const stateOverrides = await simulateV1Overrides(reqs, this.stateOf(reqs));
    const blockOverrides = this.blockOverrides(reqs);
    const before = await this.before(reqs[0].chainId, reqs);
    const body = await this.post(url, 'eth_simulateV1', [{ blockStateCalls: [{ calls: [...before, ...calls], ...(blockOverrides && { blockOverrides }), ...(stateOverrides && { stateOverrides }) }], validation: false }, tag]) as { result?: { calls: RawCallResult[] }[] };
    const out = body.result?.[0]?.calls?.slice(before.length);
    if (!out || out.length !== calls.length) return undefined;
    if (callIndex.some((ci, i) => (out[ci].status === '0x1') !== (parsed[i].status === 'success') || (parsed[i].gasUsed !== undefined && BigInt(out[ci].gasUsed) !== parsed[i].gasUsed))) return undefined;
    const values = new Map<string, bigint>();
    for (const { key, index } of where) { const r = out[index]; if (r.status === '0x1' && r.returnData.length >= 66) values.set(key, BigInt(r.returnData.slice(0, 66))); }
    return values;
  }
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
