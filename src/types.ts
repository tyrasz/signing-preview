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
  /** Where the number comes from. Requested amounts are not settled amounts. */
  basis: 'requested' | 'simulated_events' | 'mock';
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
}

export interface SimulationRequest {
  chainId: number;
  from: string;
  to: string | null;
  data: string;
  value: bigint;
}

export interface SimulatedTransfer {
  /** Token contract, or 'native' for the chain's native asset. */
  asset: string;
  from: string;
  to: string;
  raw: bigint;
}

export interface SimulationResult {
  status: 'success' | 'reverted';
  source: string;
  gasUsed?: bigint;
  revertReason?: string;
  transfers: SimulatedTransfer[];
}

export interface Simulator {
  /** Resolves null when this simulator does not cover the call (e.g. no RPC for that chain). Rejects on failure. */
  simulate(request: SimulationRequest): Promise<SimulationResult | null>;
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
}

/** Function signature database (selector -> text signatures such as "transfer(address,uint256)"). */
export interface SignatureResolver {
  lookup(selector: string): Promise<string[]>;
}

export interface Dependencies {
  tokens?: TokenRegistry;
  abis?: AbiResolver;
  signatures?: SignatureResolver;
  simulator?: Simulator;
  hyperliquid?: { mainnet?: HyperliquidInfo; testnet?: HyperliquidInfo };
}
