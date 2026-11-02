import type { ClearinghouseState, HyperliquidInfo, PerpAssetMeta, SpotPair, SpotToken } from '../types.ts';

export const INFO_URLS = {
  mainnet: 'https://api.hyperliquid.xyz/info',
  testnet: 'https://api.hyperliquid-testnet.xyz/info',
};

/** Read-only client for Hyperliquid's public /info endpoint, with short-lived caching of metadata. */
export class HttpHyperliquidInfo implements HyperliquidInfo {
  private cache = new Map<string, { at: number; value: Promise<unknown> }>();
  private url: string;
  private fetchImpl: typeof fetch;
  private ttlMs: number;
  constructor(url: string = INFO_URLS.mainnet, options: { fetchImpl?: typeof fetch; ttlMs?: number } = {}) {
    this.url = url;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.ttlMs = options.ttlMs ?? 30_000;
  }
  private post<T>(body: Record<string, unknown>, cacheable: boolean): Promise<T> {
    const key = JSON.stringify(body);
    const hit = this.cache.get(key);
    if (cacheable && hit && Date.now() - hit.at < this.ttlMs) return hit.value as Promise<T>;
    const value = this.fetchImpl(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: key,
      signal: AbortSignal.timeout(10_000),
    }).then(async res => {
      if (!res.ok) throw new Error(`Hyperliquid info ${body.type} failed: HTTP ${res.status}`);
      return res.json() as Promise<T>;
    });
    if (cacheable) {
      this.cache.set(key, { at: Date.now(), value });
      value.catch(() => this.cache.delete(key));
    }
    return value;
  }
  meta() { return this.post<{ universe: PerpAssetMeta[] }>({ type: 'meta' }, true); }
  spotMeta() { return this.post<{ tokens: SpotToken[]; universe: SpotPair[] }>({ type: 'spotMeta' }, true); }
  allMids() { return this.post<Record<string, string>>({ type: 'allMids' }, false); }
  clearinghouseState(user: string) { return this.post<ClearinghouseState>({ type: 'clearinghouseState', user }, false); }
}

/** Fixed in-memory data, for tests and demos. */
export class StaticHyperliquidInfo implements HyperliquidInfo {
  private data: {
    meta: { universe: PerpAssetMeta[] };
    spotMeta: { tokens: SpotToken[]; universe: SpotPair[] };
    allMids: Record<string, string>;
    clearinghouse: Record<string, ClearinghouseState>;
  };
  constructor(data: StaticHyperliquidInfo['data']) {
    this.data = data;
  }
  async meta() { return this.data.meta; }
  async spotMeta() { return this.data.spotMeta; }
  async allMids() { return this.data.allMids; }
  async clearinghouseState(user: string) {
    const state = this.data.clearinghouse[user.toLowerCase()];
    if (!state) throw new Error('No mock clearinghouse state for ' + user);
    return state;
  }
}
