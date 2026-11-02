import { formatUnits, PreviewBuilder } from '../format.ts';
import type { AssetChange, Dependencies, PreviewContext, TokenInfo } from '../types.ts';
import { CHAINS } from '../chains.ts';

export interface Tx {
  chainId: number;
  from: string;
  /** Null for contract creation. */
  to: string | null;
  data: `0x${string}`;
  value: bigint;
}

export interface Decoded {
  title: string;
  summary: string;
  decoder: string;
  status: 'full' | 'partial' | 'opaque';
  b: PreviewBuilder;
  assetChanges: AssetChange[];
}

export interface AdapterEnv {
  deps: Dependencies;
  context: PreviewContext;
}

export type Adapter = (tx: Tx, env: AdapterEnv) => Promise<Decoded | null>;

export function decoded(partial: Omit<Decoded, 'b' | 'assetChanges'> & { b?: PreviewBuilder; assetChanges?: AssetChange[] }): Decoded {
  return { b: partial.b ?? new PreviewBuilder(), assetChanges: partial.assetChanges ?? [], ...partial } as Decoded;
}

export async function tokenInfo(env: AdapterEnv, chainId: number, address: string): Promise<TokenInfo | undefined> {
  try {
    return (await env.deps.tokens?.get(chainId, address)) ?? undefined;
  } catch {
    return undefined;
  }
}

/** "100.5 USDC", or "1500000 raw units of token 0xabc…" when metadata is unknown. */
export function tokenAmount(raw: bigint, token: TokenInfo | undefined, address: string): string {
  return token ? `${formatUnits(raw, token.decimals)} ${token.symbol}` : `${raw.toString()} base units of token ${address}`;
}

export function nativeAmount(chainId: number, raw: bigint): string {
  const chain = CHAINS[chainId];
  return `${formatUnits(raw, chain?.nativeDecimals ?? 18)} ${chain?.nativeSymbol ?? 'native units'}`;
}

export function selectorOf(data: string): string | null {
  return data.length >= 10 ? data.slice(0, 10).toLowerCase() : null;
}
