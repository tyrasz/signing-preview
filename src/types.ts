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
   * Hyperliquid L1 actions are signed as an opaque hash. To decode one, the
   * caller must supply the original action. It is checked against the hash.
   */
  hyperliquid?: {
    action: Record<string, unknown>;
    nonce: number;
    vaultAddress?: string | null;
    expiresAfter?: number | null;
  };
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

export interface SimulationRequest {
  chainId: number;
  from: string;
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
  gasPrice?: bigint;
  accessList?: { address: string; storageKeys: string[] }[];
  /** Code to give accounts for the simulation (EIP-7702 authorizations: the delegation designator, or none). */
  stateOverrides?: Record<string, { code?: string }>;
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
  /** The amounts were read from balances before and after the call (not taken from the logs). */
  balancesRead?: boolean;
}

export interface Simulator {
  /** Resolves null when this simulator does not cover the call (e.g. no RPC for that chain). Rejects on failure. */
  simulate(request: SimulationRequest): Promise<SimulationResult | null>;
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
}
