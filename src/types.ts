// Public shapes. A Preview is plain JSON so any wallet, extension or backend
// can render it without depending on this library.

export type Hex = `0x${string}`;
export type Address = `0x${string}`;

/** An EIP-1193 request, exactly as a dApp sends it to `provider.request()`. */
export interface SigningRequest {
  method: string;
  params?: unknown;
}

export type Severity = 'info' | 'caution' | 'danger';

export interface Warning {
  severity: Severity;
  code: string;
  message: string;
}

export interface Detail {
  label: string;
  value: string;
  /** Exact machine value (raw integer, full address, hex) when `value` is formatted. */
  raw?: string;
}

export interface AssetChange {
  direction: 'out' | 'in';
  account: string;
  /** Formatted amount, e.g. "100.5". */
  amount: string;
  symbol: string;
  /** Exact integer amount in the asset's smallest unit, when known. */
  raw?: string;
  asset?: string;
  /**
   * Where the number comes from: the request itself (not a settled amount), a simulation's transfer events, or
   * balances read before and after a simulation (SimulationProbe, on RPCs without eth_simulateV1).
   */
  basis: 'requested' | 'simulated_events' | 'simulated_state' | 'mock';
  /** Set for simulated changes. NFTs (erc721/erc1155) also carry the token ID; `symbol` then reads e.g. "BAYC #42". */
  standard?: 'native' | 'erc20' | 'erc721' | 'erc1155';
  tokenId?: string;
  /**
   * What the amount is worth in dollars ("1,234.56"), when the asset has a price (Dependencies.prices), and where the
   * price is from: now, or for a past block or a replay (PreviewContext.block, Preview.replay) at that block.
   */
  usd?: string;
  usdSource?: string;
}

/** A price in dollars for one whole unit of an asset. */
export interface Price { usd: number; source: string; updatedAt?: number }
/** Prices for a chain's native token ('native') and tokens (by address). See src/prices.ts. */
export interface PriceSource {
  /** `at`: the price as of a past block (its number in hex, and its time in seconds); a source that only knows the price now gives none. */
  price(chainId: number, asset: string, at?: { block: string; time: number }): Promise<Price | undefined>;
}

/** A permission the transaction leaves in place (or removes), from simulated approval events. */
export interface ApprovalChange {
  /** erc20 / permit2: an allowance; erc721: one NFT; operator: every NFT of a collection (setApprovalForAll). */
  kind: 'erc20' | 'permit2' | 'erc721' | 'operator';
  owner: string;
  spender: string;
  /** The token or collection. */
  token: string;
  symbol?: string;
  /** Human-readable: "unlimited", "250 USDC", "BAYC #42", "all NFTs in the collection", "none" (allowance zero: revoked or used up) or "revoked". */
  allowance: string;
  raw?: string;
  tokenId?: string;
  /** Permit2 expiry (unix seconds). */
  expiration?: number;
  revoked: boolean;
  /**
   * True when the decoded request shows the approval (approve(), or a router's Permit2 permit step); false when
   * another call set it along the way, unseen.
   */
  direct: boolean;
  /** simulated_state: read from the token after the simulated transaction; simulated_events: from approval events. */
  basis: 'simulated_events' | 'simulated_state';
}

export type Network =
  | { kind: 'evm'; chainId: number; name: string }
  | { kind: 'hypercore'; name: string; testnet: boolean };

export interface SimulationSummary {
  status: 'success' | 'reverted' | 'unavailable';
  source: string;
  gasUsed?: string;
  revertReason?: string;
  error?: string;
  /** The block whose state it ran on, when one was named (PreviewContext.block) or the transaction is a replay: a decimal number. */
  block?: string;
}

/** A mined transaction run again where it ran (replayTransaction), and how the run compares with its receipt. */
export interface ReplayInfo {
  hash: string;
  /** The block it was mined in (decimal), its position there, and the block's time (ISO 8601). */
  block: string;
  index: number;
  time: string;
  receipt: { status: 'success' | 'reverted'; gasUsed: string; /** What its sender paid for it, in the native token ("0.000123 ETH"). */ fee?: string };
  /** Whether the run came out as the receipt says: the same outcome, the same events in order, the same gas. Absent when it couldn't be run. */
  matches?: boolean;
  differences?: string[];
}

export interface Preview {
  schema: 'signing-preview/1';
  method: string;
  kind: 'transaction' | 'batch' | 'typed_data' | 'message' | 'unsupported';
  network: Network | null;
  /** Short headline, e.g. "Deposit 100 USDC to Hyperliquid". */
  title: string;
  /** One or two plain-language sentences. */
  summary: string;
  details: Detail[];
  assetChanges: AssetChange[];
  /** Permissions the transaction leaves in place, from simulation (state after the transaction). */
  approvals?: ApprovalChange[];
  warnings: Warning[];
  /** Highest warning severity, or 'none'. A display hint, not a security verdict. */
  attention: 'none' | Severity;
  decoding: {
    /** full: every field understood; partial: some fields understood; opaque: nothing meaningful decoded. */
    status: 'full' | 'partial' | 'opaque';
    decoder: string;
    notes: string[];
  };
  simulation?: SimulationSummary;
  /** Per-call previews for batches (wallet_sendCalls). */
  calls?: Preview[];
  /** The simulated call's trace and state changes, when the context asked for them (PreviewContext.trace) and the simulator could. */
  trace?: PreviewTrace;
  /** A mined transaction replayed (replayTransaction): where it ran, and whether the run matches its receipt. */
  replay?: ReplayInfo;
}

/** A decoded argument, return value or event field. */
export interface TraceValue { name?: string; type: string; value: string }

/** An event a call emitted. Named from the contract's verified source or the standard events; otherwise its topics and data. */
export interface TraceEvent {
  /** Its place among the transaction's events. */
  index: number;
  address: string;
  /** A name for the emitting contract: a known token's symbol, a verified contract's name. */
  label?: string;
  name?: string;
  args?: TraceValue[];
  named?: 'verified' | 'standard';
  topics: string[];
  data: string;
}

/** One call of the trace. */
export interface TraceEntry {
  /** 0 for the transaction's own call; a call's own calls follow it, one deeper. */
  depth: number;
  type: 'call' | 'staticcall' | 'delegatecall' | 'callcode' | 'create' | 'create2';
  from: string;
  /** The code that runs: the contract called or created (null when the creation fails). */
  to: string | null;
  /** Names for `to` and `from`: "you", a known token's symbol, a verified contract's name, a precompile's. */
  label?: string;
  fromLabel?: string;
  /** The call in a line: "USDC.transfer(0x…, 1000000)". */
  text?: string;
  /** The native amount sent, in base units. */
  value?: string;
  precompile?: boolean;
  selector?: string;
  /** The function called, as its signature ("transfer(address,uint256)"). */
  function?: string;
  args?: TraceValue[];
  returns?: TraceValue[];
  /**
   * Where the function's name comes from: the contract's verified source, the built-in list of standard functions,
   * or a signature database by selector alone (a guess: different functions can share a selector).
   */
  named?: 'verified' | 'standard' | 'signature';
  /** The raw input and output, when not decoded (cut when long). */
  input?: string;
  output?: string;
  /** The gas the call used, the calls it makes included. */
  gasUsed: string;
  /** Why the call failed. What a failed call did is undone, the calls under it included. */
  error?: string;
  events?: TraceEvent[];
}

export interface PreviewTrace {
  /** What ran the trace. */
  source: string;
  /** False when the run that was traced did not do what the simulation shown did (its outcome or events differ): the trace is then a guide only. */
  agrees?: boolean;
  /**
   * Whether the traced run used the same gas as the simulation shown, when both succeeded: false means the local
   * EVM's gas rules aren't the chain's for this call, and the trace's gas figures are approximate. Absent when it
   * wasn't compared (Arbitrum, whose node adds a charge for L1 data; a failed call; no second simulation).
   */
  gasAgrees?: boolean;
  /**
   * A replay in a block that carries its access list (EIP-7928, from Amsterdam on): whether the state the traced
   * run changed (every storage slot, balance, nonce and code) is what the list records for the transaction. False
   * means the trace isn't a record of what the transaction did to the chain's state; the note says what differs.
   */
  stateAgrees?: boolean;
  note?: string;
  calls: TraceEntry[];
  /** The trace has more calls than are listed. */
  truncated?: boolean;
  totalCalls?: number;
  /** What the call changed, account by account (the gas payment apart). */
  stateChanges?: {
    address: string; label?: string;
    balance?: { before: string; after: string; change: string };
    nonce?: { before: string; after: string };
    code?: boolean;
    storage?: { slot: string; before: string; after: string }[];
    /** How many slots changed, when more than are listed. */
    storageSlots?: number;
  }[];
}

/** Extra context that is not part of the signing request itself. */
export interface PreviewContext {
  /** Wallet's active chain, used when the request omits chainId. */
  chainId?: number;
  /** Origin of the dApp asking for the signature. */
  origin?: string;
  /** Signing account, when the wallet knows it. */
  account?: string;
  /**
   * Also return the simulated call's trace (the calls it makes, decoded, with their events) and the state it
   * changes: Preview.trace. It takes a second run, in a local EVM, so it is off unless asked for.
   */
  trace?: boolean;
  /**
   * Simulate on the state after this block (a number, or one in hex) instead of the latest: what the request would
   * have done then, as the first transaction of the block that followed. For transactions and batches. The chain's
   * node has to keep that block's state (most keep recent blocks only; an archive node keeps all).
   */
  block?: number | string;
  /**
   * State to give accounts for the simulation, in place of the chain's: a native balance, code, storage slots. The
   * preview then shows what would happen if the chain were in that state, and says so. For transactions and batches.
   * Addresses are the keys; `balance` is in wei (hex, or a decimal string); `stateDiff` maps 32-byte slots to values.
   */
  stateOverrides?: Record<string, { balance?: string; code?: string; stateDiff?: Record<string, string> }>;
  /** Set by replayTransaction (src/replay.ts), never taken from a caller over HTTP: where a mined transaction ran. */
  replay?: ReplayContext;
  /** Set by previewRequest: the block `block` names, read once per chain (src/block.ts). */
  pinned?: Map<number, Promise<import('./block.ts').Pinned>>;
  /**
   * Hyperliquid L1 actions are signed as an opaque hash. To decode one, the
   * caller must supply the original action. It is checked against the hash.
   */
  hyperliquid?: {
    action: Record<string, unknown>;
    nonce: number;
    vaultAddress?: string | null;
    expiresAfter?: number | null;
  };
  /**
   * ERC-4337 operations for EntryPoint v0.6 and v0.7 are signed as their bare hash (personal_sign of
   * getUserOpHash). To decode one, the caller supplies the operation, as bundlers' RPC carries it. It is hashed as
   * the EntryPoint does and checked against the message being signed. A `signature` in it (the wallet's stub for
   * the account, as for gas estimation) is what the simulation validates with; without one, a stand-in is used.
   * A typed PackedUserOperation (v0.8, v0.9) needs no help to decode; for one, this supplies only the wallet's stub:
   * `{ sender, nonce, signature }` of the same operation (and its callData, checked if given).
   */
  userOperation?: {
    entryPoint: string;
    /** Defaults to the context's chainId. */
    chainId?: number;
    operation: Record<string, unknown>;
  };
  /**
   * A Safe4337MultiChainSignatureModule MerkleTreeRoot signature covers SafeOps on several chains, none of which the
   * message shows. The wallet that built the tree supplies them (each with its chain and its SafeOp message); the
   * root is recomputed from them, and they are shown only if it matches the root being signed.
   */
  safeOperations?: { chainId: number; operation: Record<string, unknown> }[];
  /**
   * The account's transactions the wallet has sent and that aren't mined yet, oldest first. The transaction being
   * previewed is simulated after them, as it will run, instead of on the latest state alone.
   */
  pendingTransactions?: { to: string | null; data?: string; value?: string }[];
  /** Current time in ms; injectable for tests. */
  now?: number;
}

export interface TokenInfo {
  address: string;
  symbol: string;
  decimals: number;
  name?: string;
  /**
   * Where the metadata came from. 'builtin' (curated, address-checked) and token lists are trusted for display;
   * 'onchain' means the token contract reported it about itself, which anyone can fake.
   */
  source?: 'builtin' | 'tokenlist' | 'onchain' | 'user';
}

export interface TokenRegistry {
  get(chainId: number, address: string): TokenInfo | undefined | Promise<TokenInfo | undefined>;
  /** NFT collection name/symbol (self-reported by the contract when read on-chain). */
  collection?(chainId: number, address: string): Promise<{ symbol?: string; name?: string } | undefined>;
}

/** A mined transaction's place: its block's header on its parent's state, the block's earlier transactions, the price it paid and its receipt. */
export interface ReplayContext {
  /** The parent block and the block's own header; with `state`, what the block had changed before the transaction. */
  at: import('./block.ts').BlockAt;
  /** The block's earlier transactions, to run first: none when `at.state` has what they left. */
  before: SimulationRequest[];
  /** How many transactions the block has before this one. */
  earlier: number;
  gasPrice: bigint;
  /** A blob transaction's blob hashes, and the most it would pay for blob gas. */
  blobVersionedHashes?: string[];
  maxFeePerBlobGas?: bigint;
  /** `gasUsed` is the execution's (on Arbitrum, without the part charged for L1 data, `gasForL1`). */
  receipt: { status: 'success' | 'reverted'; gasUsed: bigint; gasForL1?: bigint; logs: { address: string; topics: string[]; data: string }[] };
  info: Omit<ReplayInfo, 'matches' | 'differences'>;
  /** The transaction's block (hex) and its time, for prices as of then. */
  when: { block: string; time: number };
  /**
   * The block shares its second with its parent, and is run one second later than it was (src/block.ts,
   * afterParent); `ownTimestamp` is the time it had, which the local EVM can run it at.
   */
  shifted?: boolean;
  ownTimestamp?: bigint;
  /**
   * For a block in its parent's second (`shifted`), a run at the right time, read when asked for: the earlier blocks
   * of that second and this block's earlier transactions, as one simulated block at the block's own time, on the
   * state of the last block of the second before (src/replay.ts, sameSecond). Its NUMBER reads that block's plus
   * one. Undefined where the second goes back further than a few blocks.
   */
  sameSecond?: () => Promise<{ at: import('./block.ts').BlockAt; before: SimulationRequest[]; blocks: number } | undefined>;
  /**
   * What the block's access list records the transaction itself changed (from Amsterdam on): a trace's state
   * changes are checked against it. With who paid the fee and who was paid the tip, which the list counts in
   * their balances and a traced call doesn't.
   */
  recorded?: { changes: import('./block.ts').StateChanges; sender: string; nonce: bigint; coinbase: string; fee: bigint; tip: bigint };
}

export interface SimulationRequest {
  chainId: number;
  from: string;
  /**
   * The account whose balances and approvals the result reports, when it isn't the caller: a smart account the
   * EntryPoint or a Safe calls into. Defaults to `from`.
   */
  account?: string;
  to: string | null;
  data: string;
  value: bigint;
  /**
   * Tokens whose balances and allowances the call may change without naming them in its calldata (e.g. the
   * HyperLend hToken a supply mints). Only simulators that read state rather than logs need them.
   */
  watch?: string[];
  /** The transaction's gas limit, gas price and EIP-2930 access list, when the request sets them (contracts can read gasleft() and tx.gasprice). */
  gas?: bigint;
  /**
   * Arbitrum: the gas the chain took out of `gas` for the transaction's L1 data before running it (a replay's, from
   * its receipt's gasUsedForL1). The chain's node works it out itself; the local EVM runs on the rest.
   */
  gasForL1?: bigint;
  gasPrice?: bigint;
  /**
   * The simulated block's base fee, for calls that read it (BASEFEE): eth_simulateV1 without validation otherwise
   * runs at 0. An ERC-4337 EntryPoint prices an operation's gas with it, and token paymasters charge from that.
   */
  baseFee?: bigint;
  accessList?: { address: string; storageKeys: string[] }[];
  /** A blob transaction's blob hashes (EIP-4844), which its call can read (BLOBHASH): a replayed rollup batch checks them. */
  blobVersionedHashes?: string[];
  maxFeePerBlobGas?: bigint;
  /** Code to give accounts for the simulation (EIP-7702 authorizations: the delegation designator, or none). */
  stateOverrides?: Record<string, {
    code?: string;
    /** The account's native balance for the simulation (hex wei): for a sender that must afford a priced call's gas. */
    balance?: string;
    /** Storage slots (32-byte hex) set for the simulation, as eth_simulateV1 and eth_call take them. */
    stateDiff?: Record<string, string>;
    /** For a precompile given code: the address its original moves to (eth_simulateV1's movePrecompileToAddress). */
    movePrecompileToAddress?: string;
  }>;
  /**
   * Signed EIP-7702 authorizations, in JSON-RPC form. Simulators that can apply them natively (eth_simulateV1) do,
   * so validity, nonces and their gas are exact; the others use `stateOverrides`.
   */
  authorizationList?: { address: string; chainId: string; nonce: string; r: string; s: string; yParity: string }[];
  /**
   * EIP-7702 authorizations the wallet has yet to sign, all for the sender's account (address zero clears its
   * delegation; chainId 0 means every chain). Their code is in `stateOverrides`; simulators add what processing them
   * costs, and ForkSimulator applies them as the chain will.
   */
  unsignedAuthorizations?: { address: string; chainId: number }[];
  /**
   * Also report the call's trace (the tree of calls it makes, with the events each emits) and the state it changes.
   * Simulators that can't trace leave both out.
   */
  trace?: boolean;
  /**
   * The block to simulate on top of and the header of the block the call runs in, instead of the chain's latest and a
   * header of the simulator's making (src/block.ts): for a simulation that has to be the same in two simulators, or
   * one that looks back at a past block. A batch runs in its first request's.
   */
  at?: import('./block.ts').BlockAt;
}

/** One call in a simulated call's tree: the call itself first, then the calls its code makes, in order. */
export interface TraceCall {
  type: 'call' | 'staticcall' | 'delegatecall' | 'callcode' | 'create' | 'create2';
  /** Who makes the call: the sender, or the contract whose code is running (for a delegatecall, the account it runs as). */
  from: string;
  /** The code that runs: the contract called, or created (null when the creation fails). */
  to: string | null;
  /** The native amount sent with it. */
  value: bigint;
  input: string;
  /** What it returned (a created contract's code is left out). */
  output?: string;
  /** The gas it was given and the gas it used, the calls it makes included. */
  gas: bigint; gasUsed: bigint;
  /** Why it failed: the revert reason, or the EVM's error (out of gas, invalid opcode...). What a failed call did is undone, the calls under it included. */
  error?: string;
  /** A precompile (ecrecover, sha256...), not a contract. */
  precompile?: boolean;
  /** The events this call's own code emitted, numbered across the transaction. Those of a call that failed, or under one, aren't kept. */
  logs?: { index: number; address: string; topics: string[]; data: string }[];
  calls?: TraceCall[];
}

/** What a simulated call changed in one account: its balance, nonce, code and storage (before and after, each only if changed). */
export interface StateChange {
  address: string;
  balance?: { before: bigint; after: bigint };
  nonce?: { before: bigint; after: bigint };
  /** Its code changed: a contract created, or an EIP-7702 delegation set or cleared. */
  code?: boolean;
  storage?: { slot: string; before: string; after: string }[];
}

export interface SimulatedTransfer {
  /** Token contract, or 'native' for the chain's native asset. */
  asset: string;
  from: string;
  to: string;
  raw: bigint;
}

export interface SimulatedNftTransfer {
  standard: 'erc721' | 'erc1155';
  collection: string;
  from: string;
  to: string;
  tokenId: bigint;
  /** 1 for ERC-721. */
  amount: bigint;
}

export interface SimulatedApproval {
  kind: 'erc20' | 'permit2' | 'erc721' | 'operator';
  /** The contract that emitted the event: the token, or Permit2. */
  emitter: string;
  token: string;
  owner: string;
  spender: string;
  /** erc20 / permit2 allowance (0 = revoked). */
  amount?: bigint;
  tokenId?: bigint;
  /** operator: granted (true) or revoked (false). */
  approved?: boolean;
  expiration?: number;
}

export interface SimulationResult {
  status: 'success' | 'reverted';
  source: string;
  gasUsed?: bigint;
  revertReason?: string;
  /** Fungible transfers (ERC-20 and native). */
  transfers: SimulatedTransfer[];
  nftTransfers?: SimulatedNftTransfer[];
  /** Approval events in emission order. */
  approvals?: SimulatedApproval[];
  /**
   * The actual permission state after this call, read from the token (allowance, Permit2 allowance,
   * isApprovedForAll, getApproved) for every permission the batch has touched so far. Events alone can be stale:
   * USDC, OpenZeppelin 5 tokens and Permit2 lower an allowance without an event when it is spent.
   */
  approvalState?: SimulatedApproval[];
  /** HyperCore actions the calls sent through HyperEVM's CoreWriter (its RawAction events): who sent each, and its encoded action. */
  coreActions?: { user: string; data: string }[];
  /**
   * Only success or failure is known (the RPC has no eth_simulateV1, so the call was checked with eth_call):
   * no transfers, approvals or gas.
   */
  limited?: boolean;
  /**
   * How transfers and approvals were found: from the simulated logs (default); from balances and permissions read
   * before and after the call ('state', see SimulationProbe), which only covers the tokens that were read; or from a
   * local EVM over the chain's state ('fork', see ForkSimulator): tokens from its logs, amounts from balances.
   */
  basis?: 'logs' | 'state' | 'fork';
  /** basis 'state': how many tokens' balances were read. */
  tokensRead?: number;
  /** A caveat to show with the preview. */
  note?: string;
  /** What the call returned (or its revert data), when the simulator reports it. */
  returnData?: string;
  /** The call's logs as emitted, when the simulator reports them (native transfers aren't among them). */
  logs?: { address: string; topics: string[]; data: string }[];
  /**
   * Set by the local EVM when the rules it ran under may not be the chain's: the chain's node is on a fork the EVM
   * wasn't checked against, or the block is from before the node's current fork.
   */
  rulesNote?: string;
  /** The amounts were read from balances before and after the call (not taken from the logs). */
  balancesRead?: boolean;
  /** The call's trace and the state it changed, when the request asked for them and the simulator can (see SimulationRequest.trace). */
  trace?: TraceCall;
  stateChanges?: StateChange[];
  /** Why a requested trace is missing, or how far it can be relied on (a local run that differed from the node's). */
  traceNote?: string;
}

export interface Simulator {
  /** Resolves null when this simulator does not cover the call (e.g. no RPC for that chain). Rejects on failure. */
  simulate(request: SimulationRequest): Promise<SimulationResult | null>;
  /**
   * The same calls, in order, run where they can be traced (a local EVM): each result with its trace and the state it
   * changed. Null when nothing here can trace calls on that chain. A caller compares the outcome with its own
   * simulation's (same block: SimulationRequest.at) before trusting the trace to be of it.
   */
  trace?(requests: SimulationRequest[], options?: { /** How long the tracing run may take, over the simulator's own default. */ budgetMs?: number }): Promise<SimulationResult[] | null>;
  /**
   * Simulates calls in order in one block, each seeing the state the previous ones left (EIP-5792 batches, e.g.
   * approve then swap). Resolves one result per call, or null when this simulator does not cover the chain.
   * Simulators without it can't preview later batch calls faithfully, so only the first call is simulated.
   */
  simulateBatch?(requests: SimulationRequest[]): Promise<SimulationResult[] | null>;
}

// Hyperliquid /info shapes (subset used here).
export interface PerpAssetMeta { name: string; szDecimals: number; maxLeverage: number; onlyIsolated?: boolean }
export interface SpotToken { name: string; index: number; tokenId: string; szDecimals: number; weiDecimals: number; evmContract: { address: string; evm_extra_wei_decimals: number } | null }
export interface SpotPair { name: string; index: number; tokens: [number, number] }
export interface ClearinghouseState {
  marginSummary: { accountValue: string; totalNtlPos: string; totalMarginUsed: string };
  withdrawable: string;
  assetPositions: { position: { coin: string; szi: string; leverage: { type: string; value: number }; entryPx: string | null; liquidationPx: string | null } }[];
}

export interface PerpDex { name: string; fullName?: string }
export interface OutcomeSpec { outcome: number; name: string; description: string; sideSpecs: { name: string }[]; quoteToken?: string }
export interface OutcomeQuestion { question: number; name: string; description: string; fallbackOutcome: number; namedOutcomes: number[] }
export interface OutcomeMeta { outcomes: OutcomeSpec[]; questions: OutcomeQuestion[] }
export interface SpotBalance { coin: string; token: number; total: string; hold: string }

export interface HyperliquidInfo {
  /** Perp universe; `dex` selects a builder-deployed (HIP-3) perp DEX. */
  meta(dex?: string): Promise<{ universe: PerpAssetMeta[] }>;
  spotMeta(): Promise<{ tokens: SpotToken[]; universe: SpotPair[] }>;
  /** Mid prices; `dex` selects a HIP-3 perp DEX (keys look like "xyz:TSLA"). */
  allMids(dex?: string): Promise<Record<string, string>>;
  clearinghouseState(user: string, dex?: string): Promise<ClearinghouseState>;
  /** HIP-3 perp DEXes; index 0 is the main DEX (null). */
  perpDexs?(): Promise<(PerpDex | null)[]>;
  /** Outcome (prediction) markets. */
  outcomeMeta?(): Promise<OutcomeMeta>;
  spotClearinghouseState?(user: string): Promise<{ balances: SpotBalance[] }>;
  /** Account mode: collateral is shared across spot/perps/DEXes for unifiedAccount and portfolioMargin. */
  userAbstraction?(user: string): Promise<'unifiedAccount' | 'portfolioMargin' | 'disabled' | 'default'>;
  /** HYPE staking balances (decimal strings). */
  delegatorSummary?(user: string): Promise<{ delegated: string; undelegated: string; totalPendingWithdrawal: string; nPendingWithdrawals: number }>;
  /** HYPE delegations by validator, each locked until a time (ms). */
  delegations?(user: string): Promise<{ validator: string; amount: string; lockedUntilTimestamp: number }[]>;
}

/** A contract ABI found for an address. */
export interface ContractAbi {
  abi: readonly unknown[];
  /** Contract name from verified source, when known. */
  name?: string;
  /** e.g. 'sourcify', 'etherscan', 'user'. */
  source: string;
  /** True when the ABI comes from verified source code rather than a signature guess. */
  verified: boolean;
  /** Set when `address` is a proxy and the ABI is (or includes) its implementation's. */
  implementation?: string;
}

export interface AbiResolver {
  resolve(chainId: number, address: string): Promise<ContractAbi | null>;
  /**
   * The ABI for a call to `selector`. Diamond-style routers (EIP-2535 and similar) keep each function in a separate
   * facet contract, so the address's own ABI may lack it.
   */
  resolveCall?(chainId: number, address: string, selector: string): Promise<ContractAbi | null>;
}

/**
 * A function signature for a selector, with how far its source is trusted. Different functions can share a selector
 * and the same argument layout (address and uint256 are both one 32-byte word), so decoding alone can't choose.
 */
export interface SignatureCandidate {
  signature: string;
  /** 0: built-in list; 1: a database that filters spam (OpenChain); 2: an open registry (4byte, or unknown). */
  tier: number;
  /** Candidates of this tier are in trust order, e.g. oldest registration first, so the first may be preferred. */
  ordered?: boolean;
  source?: string;
}

/** Function signature database (selector -> text signatures such as "transfer(address,uint256)"). */
export interface SignatureResolver {
  lookup(selector: string): Promise<string[]>;
  /** Ranked lookup. Resolvers without it are treated as an unranked open registry (tier 2). */
  candidates?(selector: string): Promise<SignatureCandidate[]>;
}

export interface Dependencies {
  /** Read-only JSON-RPC, for protocol state such as exchange rates or a lending position's health factor. */
  rpc?: import('./rpc.ts').RpcClient;
  tokens?: TokenRegistry;
  abis?: AbiResolver;
  signatures?: SignatureResolver;
  simulator?: Simulator;
  hyperliquid?: { mainnet?: HyperliquidInfo; testnet?: HyperliquidInfo };
  /** Dollar prices for balance changes (AssetChange.usd). Without it, amounts carry no dollar value. */
  prices?: PriceSource;
}
