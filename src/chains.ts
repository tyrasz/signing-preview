import type { TokenInfo, TokenRegistry } from './types.ts';

// Addresses below are public deployment addresses. Verify them against the
// official sources listed in README.md before relying on them in production.

export const CHAINS: Record<number, { name: string; nativeSymbol: string; nativeDecimals: number }> = {
  1: { name: 'Ethereum', nativeSymbol: 'ETH', nativeDecimals: 18 },
  42161: { name: 'Arbitrum One', nativeSymbol: 'ETH', nativeDecimals: 18 },
  999: { name: 'HyperEVM', nativeSymbol: 'HYPE', nativeDecimals: 18 },
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

export const CCTP = {
  /** TokenMessengerV2 is deployed at the same address on Ethereum and Arbitrum. */
  tokenMessengerV2: '0x28b5a0e9c621a5badaa536219b3a228c8168cf5d',
  /** Circle's forwarder on HyperEVM that credits minted USDC to HyperCore. */
  hyperCoreForwarder: '0xb21d281dedb17ae5b501f6aa8256fe38c4e45757',
  usdcByChain: {
    1: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    42161: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
    999: '0xb88339cb7199b77e23db6e890353e22632ba630f',
  } as Record<number, string>,
  domains: { 0: 'Ethereum', 1: 'Avalanche', 2: 'OP Mainnet', 3: 'Arbitrum', 6: 'Base', 7: 'Polygon PoS', 19: 'HyperEVM' } as Record<number, string>,
  hyperEvmDomain: 19,
  /** Destination DEX field of the forwarding hook. */
  dexes: { 0: 'perps', 4294967295: 'spot' } as Record<number, string>,
  finality: { 1000: 'fast (soft finality)', 2000: 'standard (hard finality)' } as Record<number, string>,
} as const;

export const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3';

const BUILTIN_TOKENS: Record<number, TokenInfo[]> = {
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
