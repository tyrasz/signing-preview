import { decodeAbiParameters, hexToString, type Hex } from 'viem';
import { builtinTokens } from './chains.ts';
import { isRpcError, TtlCache, type RpcClient } from './rpc.ts';
import type { TokenInfo, TokenRegistry } from './types.ts';

const SELECTORS = { symbol: '0x95d89b41', name: '0x06fdde03', decimals: '0x313ce567' } as const;

/** Decodes a `string` or legacy `bytes32` return value (e.g. MKR). Returns null for anything else. */
export function decodeStringOrBytes32(data: string): string | null {
  if (!/^0x([0-9a-f]{2})*$/i.test(data) || data.length < 66) return null;
  let text: string | null = null;
  if (data.length >= 130) {
    try { text = decodeAbiParameters([{ type: 'string' }], data as Hex)[0]; } catch { text = null; }
  }
  if (text === null && data.length === 66) text = hexToString(data as Hex, { size: 32 }).replace(/\0+$/, '');
  if (text === null) return null;
  text = text.trim();
  // Reject control characters and absurd lengths rather than displaying them.
  return text.length > 0 && text.length <= 64 && !/[\u0000-\u001f\u007f]/.test(text) ? text : null;
}

/**
 * Reads symbol(), decimals() and name() from the token contract. The values are whatever the contract says about
 * itself, so results are marked source 'onchain' (unverified). Results are cached, including "not a token" when the
 * node says so; a network failure or rate limit is retried after `retryMs` instead.
 */
export class OnchainTokenRegistry implements TokenRegistry {
  private rpc: RpcClient;
  private cache = new TtlCache<Promise<TokenInfo | undefined>>();
  private ttlMs: number;
  private retryMs: number;
  constructor(rpc: RpcClient, options: { ttlMs?: number; retryMs?: number } = {}) {
    this.rpc = rpc;
    this.ttlMs = options.ttlMs ?? 10 * 60_000;
    this.retryMs = options.retryMs ?? 30_000;
  }
  get(chainId: number, address: string): Promise<TokenInfo | undefined> {
    const key = `${chainId}:${address.toLowerCase()}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    let expire = (_ttl: number) => {};
    const value = this.read(chainId, address.toLowerCase()).catch(() => { expire(this.retryMs); return undefined; });
    expire = this.cache.set(key, value, this.ttlMs);
    return value;
  }
  private collections = new TtlCache<Promise<{ symbol?: string; name?: string } | undefined>>();
  /** NFT collection symbol/name (ERC-721 metadata; many ERC-1155 contracts have neither). Self-reported. */
  collection(chainId: number, address: string): Promise<{ symbol?: string; name?: string } | undefined> {
    const key = `${chainId}:${address.toLowerCase()}`;
    const hit = this.collections.get(key);
    if (hit) return hit;
    let expire = (_ttl: number) => {};
    const value = (async () => {
      if (!this.rpc.has(chainId)) return undefined;
      const call = (data: string) => this.rpc.call(chainId, 'eth_call', [{ to: address, data }, 'latest']).then(r => String(r), e => { if (isRpcError(e)) return '0x'; throw e; });
      const [sym, nm] = await Promise.all([call(SELECTORS.symbol), call(SELECTORS.name)]);
      const symbol = decodeStringOrBytes32(sym) ?? undefined, name = decodeStringOrBytes32(nm) ?? undefined;
      return symbol || name ? { symbol, name } : undefined;
    })().catch(() => { expire(this.retryMs); return undefined; });
    expire = this.collections.set(key, value, this.ttlMs);
    return value;
  }
  private async read(chainId: number, address: string): Promise<TokenInfo | undefined> {
    if (!this.rpc.has(chainId)) return undefined;
    // A revert means "no such function"; any other failure rejects, so the miss is not cached for long.
    const call = (data: string) => this.rpc.call(chainId, 'eth_call', [{ to: address, data }, 'latest']).then(r => String(r), e => { if (isRpcError(e)) return '0x'; throw e; });
    const [sym, dec, nm] = await Promise.all([call(SELECTORS.symbol), call(SELECTORS.decimals), call(SELECTORS.name)]);
    const symbol = decodeStringOrBytes32(sym);
    if (!symbol || !/^0x[0-9a-f]{64}$/i.test(dec)) return undefined;
    const decimals = BigInt(dec);
    if (decimals > 36n) return undefined;
    return { address, symbol, decimals: Number(decimals), name: decodeStringOrBytes32(nm) ?? undefined, source: 'onchain' };
  }
}

/** Standard token list (https://tokenlists.org schema: { tokens: [{ chainId, address, symbol, decimals, name }] }). */
export class TokenListRegistry implements TokenRegistry {
  private map = new Map<string, TokenInfo>();
  constructor(list: { tokens?: { chainId: number; address: string; symbol: string; decimals: number; name?: string }[] }) {
    for (const t of list.tokens ?? []) {
      if (!Number.isSafeInteger(t.chainId) || !/^0x[0-9a-fA-F]{40}$/.test(t.address) || typeof t.symbol !== 'string' || !Number.isInteger(t.decimals) || t.decimals < 0 || t.decimals > 36) continue;
      this.map.set(`${t.chainId}:${t.address.toLowerCase()}`, { address: t.address.toLowerCase(), symbol: t.symbol, decimals: t.decimals, name: t.name, source: 'tokenlist' });
    }
  }
  get size() { return this.map.size; }
  get(chainId: number, address: string): TokenInfo | undefined {
    return this.map.get(`${chainId}:${address.toLowerCase()}`);
  }
}

/** Tries registries in order (e.g. curated -> token list -> on-chain) and returns the first hit. */
export class ChainedTokenRegistry implements TokenRegistry {
  private registries: TokenRegistry[];
  constructor(registries: TokenRegistry[]) { this.registries = registries; }
  async get(chainId: number, address: string): Promise<TokenInfo | undefined> {
    for (const r of this.registries) {
      try {
        const hit = await r.get(chainId, address);
        if (hit) return hit;
      } catch { /* try the next source */ }
    }
    return undefined;
  }
  async collection(chainId: number, address: string): Promise<{ symbol?: string; name?: string } | undefined> {
    for (const r of this.registries) {
      if (!r.collection) continue;
      try { const hit = await r.collection(chainId, address); if (hit) return hit; } catch { /* next */ }
    }
    return undefined;
  }
}

// Look-alike characters common in token symbols (USD₮0) count as the letter they imitate.
const normalise = (s: string) => s.replace(/₮/g, 'T').toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * A token whose self-reported (on-chain) symbol copies a curated token on the same chain, from a different
 * address, is very likely a fake (common in airdrop and address-poisoning scams).
 */
export function impersonatedToken(chainId: number, info: TokenInfo): TokenInfo | null {
  if (info.source === 'builtin' || info.source === 'tokenlist') return null;
  const sym = normalise(info.symbol);
  if (!sym) return null;
  return builtinTokens(chainId).find(t => normalise(t.symbol) === sym && t.address !== info.address.toLowerCase()) ?? null;
}
