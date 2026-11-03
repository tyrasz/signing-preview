import type { TokenInfo, TokenRegistry } from './types.ts';

// Addresses below are public deployment addresses. Verify them against the
// official sources listed in README.md before relying on them in production.

export const CHAINS: Record<number, { name: string; nativeSymbol: string; nativeDecimals: number }> = {
  1: { name: 'Ethereum', nativeSymbol: 'ETH', nativeDecimals: 18 },
  42161: { name: 'Arbitrum One', nativeSymbol: 'ETH', nativeDecimals: 18 },
  999: { name: 'HyperEVM', nativeSymbol: 'HYPE', nativeDecimals: 18 },
  // Testnets (CCTP routes to HyperCore testnet).
  11155111: { name: 'Ethereum Sepolia', nativeSymbol: 'ETH', nativeDecimals: 18 },
  421614: { name: 'Arbitrum Sepolia', nativeSymbol: 'ETH', nativeDecimals: 18 },
  998: { name: 'HyperEVM Testnet', nativeSymbol: 'HYPE', nativeDecimals: 18 },
};

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
  999: [
    { address: '0xb88339cb7199b77e23db6e890353e22632ba630f', symbol: 'USDC', decimals: 6, name: 'USD Coin' },
    { address: '0x5555555555555555555555555555555555555555', symbol: 'WHYPE', decimals: 18, name: 'Wrapped HYPE' },
  ],
};

/** In-memory registry seeded with well-known tokens; add your own list or on-chain lookups. */
export class StaticTokenRegistry implements TokenRegistry {
  private map = new Map<string, TokenInfo>();
  constructor(extra: Record<number, TokenInfo[]> = {}) {
    for (const source of [BUILTIN_TOKENS, extra]) {
      for (const [chainId, tokens] of Object.entries(source)) {
        for (const t of tokens) this.map.set(`${chainId}:${t.address.toLowerCase()}`, { ...t, address: t.address.toLowerCase() });
      }
    }
  }
  get(chainId: number, address: string): TokenInfo | undefined {
    return this.map.get(`${chainId}:${address.toLowerCase()}`);
  }
}
