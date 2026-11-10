import type { TokenInfo, TokenRegistry } from './types.ts';

// Addresses below are public deployment addresses. Verify them against the
// official sources listed in README.md before relying on them in production.

export const CHAINS: Record<number, { name: string; nativeSymbol: string; nativeDecimals: number }> = {
  1: { name: 'Ethereum', nativeSymbol: 'ETH', nativeDecimals: 18 },
  42161: { name: 'Arbitrum One', nativeSymbol: 'ETH', nativeDecimals: 18 },
  999: { name: 'HyperEVM', nativeSymbol: 'HYPE', nativeDecimals: 18 },
  8453: { name: 'Base', nativeSymbol: 'ETH', nativeDecimals: 18 },
  10: { name: 'OP Mainnet', nativeSymbol: 'ETH', nativeDecimals: 18 },
  137: { name: 'Polygon', nativeSymbol: 'POL', nativeDecimals: 18 },
  56: { name: 'BNB Chain', nativeSymbol: 'BNB', nativeDecimals: 18 },
  // Testnets (CCTP routes to HyperCore testnet).
  11155111: { name: 'Ethereum Sepolia', nativeSymbol: 'ETH', nativeDecimals: 18 },
  421614: { name: 'Arbitrum Sepolia', nativeSymbol: 'ETH', nativeDecimals: 18 },
  998: { name: 'HyperEVM Testnet', nativeSymbol: 'HYPE', nativeDecimals: 18 },
};

/**
 * The EVM chains previews simulate on: the environment variable that names each one's RPC (live mode simulates on a
 * chain only when it is set), and a public RPC the scripts and scheduled replays use when it isn't.
 */
export const EVM_RPCS: Record<number, { env: string; public: string }> = {
  1: { env: 'ETHEREUM_RPC_URL', public: 'https://ethereum-rpc.publicnode.com' },
  42161: { env: 'ARBITRUM_RPC_URL', public: 'https://arb1.arbitrum.io/rpc' },
  999: { env: 'HYPEREVM_RPC_URL', public: 'https://rpc.hyperliquid.xyz/evm' },
  8453: { env: 'BASE_RPC_URL', public: 'https://base-rpc.publicnode.com' },
  10: { env: 'OPTIMISM_RPC_URL', public: 'https://optimism-rpc.publicnode.com' },
  137: { env: 'POLYGON_RPC_URL', public: 'https://polygon-bor-rpc.publicnode.com' },
  56: { env: 'BSC_RPC_URL', public: 'https://bsc-rpc.publicnode.com' },
};
/** The RPC for a chain: its environment variable's (empty counts as unset, as an unset CI secret is), else the public one. */
export const rpcUrlFor = (chainId: number, env: Record<string, string | undefined>): string | undefined =>
  EVM_RPCS[chainId] && (env[EVM_RPCS[chainId].env] || EVM_RPCS[chainId].public);
/** OP Stack chains: each transaction also pays an L1 data fee, which the GasPriceOracle predeploy computes. */
export const OP_STACK = new Set([8453, 10]);

export function chainName(chainId: number): string {
  return CHAINS[chainId]?.name ?? `chain ${chainId}`;
}

export const HYPERLIQUID = {
  /** Bridge2 on Arbitrum One. Deposits are plain native-USDC transfers to it. */
  bridge2: '0x2df1c51e09aecf9cacb7bc98cb1742757f163df7',
  /** Deposits below this amount are not credited and are lost. */
  minDepositRaw: 5_000_000n,
  /** Withdrawals to Arbitrum pay a flat fee in USDC. */
  withdrawFeeUsd: '1',
  /** HyperEVM precompile that forwards actions to HyperCore. */
  coreWriter: '0x3333333333333333333333333333333333333333',
  /** Sending native HYPE here on HyperEVM moves it to HyperCore spot. */
  hypeSystemAddress: '0x2222222222222222222222222222222222222222',
  /** L1 actions are signed under this domain with this chain ID. */
  l1Domain: { name: 'Exchange', version: '1', chainId: 1337 },
  userSignedDomainName: 'HyperliquidSignTransaction',
} as const;

/** HyperCore system address for a spot token: 0x20 followed by the big-endian token index. */
export function spotSystemAddress(tokenIndex: number): string {
  return '0x20' + tokenIndex.toString(16).padStart(38, '0');
}

/** Returns the token index if `address` is a HyperCore spot system address. */
export function parseSpotSystemAddress(address: string): number | null {
  const a = address.toLowerCase();
  if (!/^0x20[0-9a-f]{38}$/.test(a)) return null;
  return Number.parseInt(a.slice(4), 16);
}

// Circle CCTP V2 + HyperCore deployments. Sources (snapshot 2026-10-29, saved in
// tyrasz/transaction-lab: research/arbitrum-deposit-v1/sources/docs): contract-addresses.md, usdc-addresses.md,
// hypercore-addresses.md. Contract behaviour: circlefin/hyperevm-circle-contracts @ ffcc978
// (still master on 2026-11-03) and circlefin/evm-cctp-contracts @ a92a2b4.
export interface HyperEvmDeployment {
  chainId: number;
  name: string;
  usdc: string;
  /** CctpForwarder: must be both mintRecipient and destinationCaller for HyperCore deposits. */
  forwarder: string;
  /** CoreDepositWallet: credits HyperCore; rejected as a forward recipient. */
  coreDepositWallet: string;
}

export const HYPEREVM_MAINNET: HyperEvmDeployment = {
  chainId: 999, name: 'HyperEVM', usdc: '0xb88339cb7199b77e23db6e890353e22632ba630f',
  forwarder: '0xb21d281dedb17ae5b501f6aa8256fe38c4e45757', coreDepositWallet: '0x6b9e773128f453f5c2c60935ee2de2cbc5390a24',
};
export const HYPEREVM_TESTNET: HyperEvmDeployment = {
  chainId: 998, name: 'HyperEVM Testnet', usdc: '0x2b3370ee501b4a559b57d449569354196457d8ab',
  forwarder: '0x02e39ecb8368b41bf68ff99ff351ac9864e5e2a2', coreDepositWallet: '0x0b80659a4076e9e93c7dbe0f10675a16a3e5c206',
};

export interface CctpSourceNetwork {
  name: string;
  domain: number;
  testnet: boolean;
  usdc: string;
  tokenMessengerV2: string;
  /** Arbitrum only: batchDepositForBurnWithAuth (EIP-3009 ReceiveWithAuthorization). */
  cctpExtension?: string;
  /** Arbitrum only: relayer-submitted sponsored deposits. */
  cctpExtensionV2?: string;
  hyperEvm: HyperEvmDeployment;
  /** Documented fees for deposits to HyperCore (Circle's fee API returns the live values). */
  fees: { fastFeeBps: number; forwardFeeRaw: bigint; forwardFeeDynamic: boolean };
}

export const CCTP_NETWORKS: Record<number, CctpSourceNetwork> = {
  1: { name: 'Ethereum', domain: 0, testnet: false, usdc: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    tokenMessengerV2: '0x28b5a0e9c621a5badaa536219b3a228c8168cf5d', hyperEvm: HYPEREVM_MAINNET,
    fees: { fastFeeBps: 1, forwardFeeRaw: 200_000n, forwardFeeDynamic: true } },
  42161: { name: 'Arbitrum One', domain: 3, testnet: false, usdc: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
    tokenMessengerV2: '0x28b5a0e9c621a5badaa536219b3a228c8168cf5d',
    cctpExtension: '0xa95d9c1f655341597c94393fddc30cf3c08e4fce', cctpExtensionV2: '0x3289e443a95b28bcedacc4b33c689b0c9b84ffab',
    hyperEvm: HYPEREVM_MAINNET, fees: { fastFeeBps: 0, forwardFeeRaw: 200_000n, forwardFeeDynamic: false } },
  11155111: { name: 'Ethereum Sepolia', domain: 0, testnet: true, usdc: '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238',
    tokenMessengerV2: '0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa', hyperEvm: HYPEREVM_TESTNET,
    fees: { fastFeeBps: 1, forwardFeeRaw: 200_000n, forwardFeeDynamic: true } },
  // HyperEVM as a CCTP source (HyperEVM -> other chains). The HyperCore-deposit fee fields do not apply.
  999: { name: 'HyperEVM', domain: 19, testnet: false, usdc: HYPEREVM_MAINNET.usdc,
    tokenMessengerV2: '0x28b5a0e9c621a5badaa536219b3a228c8168cf5d', hyperEvm: HYPEREVM_MAINNET,
    fees: { fastFeeBps: 0, forwardFeeRaw: 0n, forwardFeeDynamic: false } },
  998: { name: 'HyperEVM Testnet', domain: 19, testnet: true, usdc: HYPEREVM_TESTNET.usdc,
    tokenMessengerV2: '0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa', hyperEvm: HYPEREVM_TESTNET,
    fees: { fastFeeBps: 0, forwardFeeRaw: 0n, forwardFeeDynamic: false } },
  421614: { name: 'Arbitrum Sepolia', domain: 3, testnet: true, usdc: '0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d',
    tokenMessengerV2: '0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa',
    cctpExtension: '0x8e4e3d0e95c1bec4f3ec7f69aa48473e0ab6eb8d', cctpExtensionV2: '0xc1fec4e5daf8796a490653359536f9c2a9c158ae',
    hyperEvm: HYPEREVM_TESTNET, fees: { fastFeeBps: 0, forwardFeeRaw: 200_000n, forwardFeeDynamic: false } },
};

/**
 * HyperCore -> other chains via Circle CCTP (sendToEvmWithData with USDC, handled by CoreDepositWallet.coreReceiveWithData).
 * Fees read live on 2026-11-03 with CoreDepositWallet.calculateCrossChainWithdrawalFee; they match Circle's Forwarding
 * Service table (HyperCore withdrawals: Ethereum 1.20, Solana 0.50, other chains 0.20 USDC). cctpMaxFee was 0.
 */
export const HYPERCORE_CCTP_WITHDRAWAL = {
  cctpMaxFeeRaw: 0n,
  defaultForwardFeeRaw: 200_000n,
  forwardFeeByDomain: { 0: 1_200_000n, 5: 500_000n } as Record<number, bigint>,
  /** CoreDepositWallet MAX_HOOK_DATA_SIZE. */
  maxDataBytes: 1024,
} as const;

export const CCTP = {
  /** TokenMessengerV2 is deployed at the same address on Ethereum and Arbitrum (mainnets). */
  tokenMessengerV2: CCTP_NETWORKS[42161].tokenMessengerV2,
  hyperCoreForwarder: HYPEREVM_MAINNET.forwarder,
  usdcByChain: {
    1: CCTP_NETWORKS[1].usdc, 42161: CCTP_NETWORKS[42161].usdc, 999: HYPEREVM_MAINNET.usdc,
    11155111: CCTP_NETWORKS[11155111].usdc, 421614: CCTP_NETWORKS[421614].usdc, 998: HYPEREVM_TESTNET.usdc,
  } as Record<number, string>,
  /** Circle's CCTP domain table (supported-chains-and-domains, unchanged 2026-10-29 -> 2026-11-03). */
  domains: { 0: 'Ethereum', 1: 'Avalanche', 2: 'OP Mainnet', 3: 'Arbitrum', 5: 'Solana', 6: 'Base', 7: 'Polygon PoS', 8: 'Sui', 9: 'Aptos', 10: 'Unichain',
    11: 'Linea', 12: 'Codex', 13: 'Sonic', 14: 'World Chain', 15: 'Monad', 16: 'Sei', 17: 'BNB Smart Chain', 18: 'XDC', 19: 'HyperEVM', 21: 'Ink', 22: 'Plume',
    25: 'Starknet', 26: 'Arc', 27: 'Stellar', 28: 'EDGE', 29: 'Injective', 30: 'Morph', 31: 'Pharos', 32: 'Cronos', 33: 'Plasma', 37: 'X Layer' } as Record<number, string>,
  hyperEvmDomain: 19,
  /** CoreDepositWallet: 0 = perps (enabled by default), uint32.max = spot; other DEX IDs fall back to spot unless enabled. */
  dexes: { 0: 'perps', 4294967295: 'spot' } as Record<number, string>,
  /** HyperCore USDC system address (token index 0); CoreDepositWallet rejects it as a recipient. */
  usdcSystemAddress: '0x2000000000000000000000000000000000000000',
  /** CoreDepositWallet MAX_TRANSFER_VALUE_FROM_EVM = uint64.max / 100 (6-decimal units). */
  maxTransferFromEvm: ((1n << 64n) - 1n) / 100n,
} as const;

export const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3';

const BUILTIN_TOKENS: Record<number, TokenInfo[]> = {
  11155111: [{ address: '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238', symbol: 'USDC', decimals: 6, name: 'USD Coin (testnet)' }],
  421614: [{ address: '0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d', symbol: 'USDC', decimals: 6, name: 'USD Coin (testnet)' }],
  998: [{ address: '0x2b3370ee501b4a559b57d449569354196457d8ab', symbol: 'USDC', decimals: 6, name: 'USD Coin (testnet)' }],
  1: [
    { address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', symbol: 'USDC', decimals: 6, name: 'USD Coin' },
    { address: '0xdac17f958d2ee523a2206206994597c13d831ec7', symbol: 'USDT', decimals: 6, name: 'Tether USD' },
    { address: '0x6b175474e89094c44da98b954eedeac495271d0f', symbol: 'DAI', decimals: 18, name: 'Dai Stablecoin' },
    { address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', symbol: 'WETH', decimals: 18, name: 'Wrapped Ether' },
  ],
  42161: [
    { address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', symbol: 'USDC', decimals: 6, name: 'USD Coin' },
    { address: '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8', symbol: 'USDC.e', decimals: 6, name: 'Bridged USDC' },
    { address: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', symbol: 'USDT', decimals: 6, name: 'Tether USD' },
    { address: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', symbol: 'WETH', decimals: 18, name: 'Wrapped Ether' },
  ],
  // Base, OP Mainnet, Polygon and BNB Chain: symbol and decimals read on-chain 2026-11-10 (bridged USDC listed as
  // USDC.e, as on Arbitrum).
  8453: [
    { address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', symbol: 'USDC', decimals: 6, name: 'USD Coin' },
    { address: '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca', symbol: 'USDbC', decimals: 6, name: 'USD Base Coin' },
    { address: '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2', symbol: 'USDT', decimals: 6, name: 'Tether USD' },
    { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18, name: 'Wrapped Ether' },
    { address: '0x50c5725949a6f0c72e6c4a641f24049a917db0cb', symbol: 'DAI', decimals: 18, name: 'Dai Stablecoin' },
    { address: '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf', symbol: 'cbBTC', decimals: 8, name: 'Coinbase Wrapped BTC' },
  ],
  10: [
    { address: '0x0b2c639c533813f4aa9d7837caf62653d097ff85', symbol: 'USDC', decimals: 6, name: 'USD Coin' },
    { address: '0x7f5c764cbc14f9669b88837ca1490cca17c31607', symbol: 'USDC.e', decimals: 6, name: 'Bridged USDC' },
    { address: '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58', symbol: 'USDT', decimals: 6, name: 'Tether USD' },
    { address: '0x01bff41798a0bcf287b996046ca68b395dbc1071', symbol: 'USD₮0', decimals: 6, name: 'USD₮0' },
    { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18, name: 'Wrapped Ether' },
    { address: '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1', symbol: 'DAI', decimals: 18, name: 'Dai Stablecoin' },
    { address: '0x4200000000000000000000000000000000000042', symbol: 'OP', decimals: 18, name: 'Optimism' },
  ],
  137: [
    { address: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', symbol: 'USDC', decimals: 6, name: 'USD Coin' },
    { address: '0x2791bca1f2de4661ed88a30c99a7a9449aa84174', symbol: 'USDC.e', decimals: 6, name: 'USD Coin (PoS)' },
    { address: '0xc2132d05d31c914a87c6611c10748aeb04b58e8f', symbol: 'USDT0', decimals: 6, name: 'USDT0' },
    { address: '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619', symbol: 'WETH', decimals: 18, name: 'Wrapped Ether' },
    { address: '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270', symbol: 'WPOL', decimals: 18, name: 'Wrapped Polygon Ecosystem Token' },
    { address: '0x8f3cf7ad23cd3cadbd9735aff958023239c6a063', symbol: 'DAI', decimals: 18, name: '(PoS) Dai Stablecoin' },
  ],
  56: [
    { address: '0x55d398326f99059ff775485246999027b3197955', symbol: 'USDT', decimals: 18, name: 'Tether USD' },
    { address: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', symbol: 'USDC', decimals: 18, name: 'USD Coin' },
    { address: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', symbol: 'WBNB', decimals: 18, name: 'Wrapped BNB' },
    { address: '0x2170ed0880ac9a755fd29b2688956bd959f933f8', symbol: 'ETH', decimals: 18, name: 'Ethereum Token' },
    { address: '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c', symbol: 'BTCB', decimals: 18, name: 'BTCB Token' },
  ],
  999: [
    { address: '0xb88339cb7199b77e23db6e890353e22632ba630f', symbol: 'USDC', decimals: 6, name: 'USD Coin' },
    { address: '0x5555555555555555555555555555555555555555', symbol: 'WHYPE', decimals: 18, name: 'Wrapped HYPE' },
    // Linked to HyperCore spot tokens by Hyperliquid itself (spotMeta evmContract), on-chain symbol/decimals checked
    // 2026-11-04 (verify-live re-checks decimals). kHYPE is also the address in Kinetiq's docs.
    { address: '0xfd739d4e423301ce9385c1fb8850539d657c296d', symbol: 'kHYPE', decimals: 18, name: 'Kinetiq Staked HYPE' },
    { address: '0x9fdbda0a5e284c32744d2f17ee5c74b284993463', symbol: 'UBTC', decimals: 8, name: 'Unit Bitcoin' },
    { address: '0xbe6727b535545c67d5caa73dea54865b92cf7907', symbol: 'UETH', decimals: 18, name: 'Unit Ethereum' },
    { address: '0x068f321fa8fb9f0d135f290ef6a3e2813e1c8a29', symbol: 'USOL', decimals: 9, name: 'Unit Solana' },
    { address: '0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb', symbol: 'USDT0', decimals: 6, name: 'USD₮0' },
    { address: '0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34', symbol: 'USDe', decimals: 18, name: 'USDeOFT' },
    { address: '0x111111a1a0667d36bd57c0a9f569b98057111111', symbol: 'USDH', decimals: 6, name: 'USDH' },
    { address: '0xb50a96253abdf803d85efcdce07ad8becbc52bd5', symbol: 'USDHL', decimals: 6, name: 'Hyper USD' },
    { address: '0x02c6a2fa58cc01a18b8d9e00ea48d65e4df26c70', symbol: 'feUSD', decimals: 18, name: 'feUSD' },
    { address: '0x0ad339d66bf4aed5ce31c64bc37b3244b6394a77', symbol: 'USR', decimals: 18, name: 'Resolv USD' },
  ],
};

/** In-memory registry seeded with well-known tokens; add your own list or on-chain lookups. */
export class StaticTokenRegistry implements TokenRegistry {
  private map = new Map<string, TokenInfo>();
  constructor(extra: Record<number, TokenInfo[]> = {}) {
    for (const source of [BUILTIN_TOKENS, extra]) {
      for (const [chainId, tokens] of Object.entries(source)) {
        for (const t of tokens) this.map.set(`${chainId}:${t.address.toLowerCase()}`, { source: source === BUILTIN_TOKENS ? 'builtin' : 'user', ...t, address: t.address.toLowerCase() });
      }
    }
  }
  get(chainId: number, address: string): TokenInfo | undefined {
    return this.map.get(`${chainId}:${address.toLowerCase()}`);
  }
  /** Curated tokens on a chain, used to spot look-alike tokens. */
  list(chainId: number): TokenInfo[] {
    return [...this.map.entries()].filter(([k]) => k.startsWith(`${chainId}:`)).map(([, v]) => v);
  }
}

/** Curated (address-checked) token symbols per chain, for impersonation checks. */
export function builtinTokens(chainId: number): TokenInfo[] {
  return (BUILTIN_TOKENS[chainId] ?? []).map(t => ({ ...t, address: t.address.toLowerCase(), source: 'builtin' as const }));
}
