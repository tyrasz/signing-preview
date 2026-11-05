import type { ClearinghouseState, HyperliquidInfo, OutcomeMeta, PerpAssetMeta, PerpDex, SpotBalance, SpotPair, SpotToken } from '../types.ts';

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
  private retries: number;
  private retryDelayMs: number;
  /** `retries` retries only HTTP 429 responses (off by default so previews stay fast). */
  constructor(url: string = INFO_URLS.mainnet, options: { fetchImpl?: typeof fetch; ttlMs?: number; retries?: number; retryDelayMs?: number } = {}) {
    this.url = url;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.ttlMs = options.ttlMs ?? 30_000;
    this.retries = options.retries ?? 0;
    this.retryDelayMs = options.retryDelayMs ?? 2000;
  }
  private post<T>(body: Record<string, unknown>, cacheable: boolean): Promise<T> {
    const key = JSON.stringify(body);
    const hit = this.cache.get(key);
    if (cacheable && hit && Date.now() - hit.at < this.ttlMs) return hit.value as Promise<T>;
    const attempt = async (n: number): Promise<T> => {
      const res = await this.fetchImpl(this.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: key, signal: AbortSignal.timeout(10_000) });
      if (res.status === 429 && n < this.retries) {
        await new Promise(r => setTimeout(r, this.retryDelayMs * (n + 1)));
        return attempt(n + 1);
      }
      if (!res.ok) throw new Error(`Hyperliquid info ${body.type} failed: HTTP ${res.status}`);
      return res.json() as Promise<T>;
    };
    const value = attempt(0);
    if (cacheable) {
      this.cache.set(key, { at: Date.now(), value });
      value.catch(() => this.cache.delete(key));
    }
    return value;
  }
  meta(dex?: string) { return this.post<{ universe: PerpAssetMeta[] }>(dex ? { type: 'meta', dex } : { type: 'meta' }, true); }
  spotMeta() { return this.post<{ tokens: SpotToken[]; universe: SpotPair[] }>({ type: 'spotMeta' }, true); }
  allMids(dex?: string) { return this.post<Record<string, string>>(dex ? { type: 'allMids', dex } : { type: 'allMids' }, false); }
  clearinghouseState(user: string, dex?: string) { return this.post<ClearinghouseState>(dex ? { type: 'clearinghouseState', user, dex } : { type: 'clearinghouseState', user }, false); }
  perpDexs() { return this.post<(PerpDex | null)[]>({ type: 'perpDexs' }, true); }
  outcomeMeta() { return this.post<OutcomeMeta>({ type: 'outcomeMeta' }, true); }
  spotClearinghouseState(user: string) { return this.post<{ balances: SpotBalance[] }>({ type: 'spotClearinghouseState', user }, false); }
  userAbstraction(user: string) { return this.post<'unifiedAccount' | 'portfolioMargin' | 'disabled' | 'default'>({ type: 'userAbstraction', user }, false); }
  delegatorSummary(user: string) { return this.post<{ delegated: string; undelegated: string; totalPendingWithdrawal: string; nPendingWithdrawals: number }>({ type: 'delegatorSummary', user }, false); }
  delegations(user: string) { return this.post<{ validator: string; amount: string; lockedUntilTimestamp: number }[]>({ type: 'delegations', user }, false); }
}

/** Fixed in-memory data, for tests and demos. */
export interface StaticInfoData {
  meta: { universe: PerpAssetMeta[] };
  spotMeta: { tokens: SpotToken[]; universe: SpotPair[] };
  allMids: Record<string, string>;
  clearinghouse: Record<string, ClearinghouseState>;
  perpDexs?: (PerpDex | null)[];
  /** Per HIP-3 DEX name. */
  dexMeta?: Record<string, { universe: PerpAssetMeta[] }>;
  dexMids?: Record<string, Record<string, string>>;
  outcomeMeta?: OutcomeMeta;
  spotBalances?: Record<string, SpotBalance[]>;
  abstraction?: Record<string, 'unifiedAccount' | 'portfolioMargin' | 'disabled' | 'default'>;
  /** Staking, by user. */
  staking?: Record<string, { undelegated: string; delegations: { validator: string; amount: string; lockedUntilTimestamp: number }[] }>;
}

export class StaticHyperliquidInfo implements HyperliquidInfo {
  private data: StaticInfoData;
  constructor(data: StaticInfoData) {
    this.data = data;
  }
  async meta(dex?: string) {
    if (!dex) return this.data.meta;
    const m = this.data.dexMeta?.[dex];
    if (!m) throw new Error('No mock meta for dex ' + dex);
    return m;
  }
  async spotMeta() { return this.data.spotMeta; }
  async allMids(dex?: string) { return dex ? this.data.dexMids?.[dex] ?? {} : this.data.allMids; }
  async clearinghouseState(user: string, dex?: string) {
    const state = this.data.clearinghouse[(dex ? dex + ':' : '') + user.toLowerCase()];
    if (!state) throw new Error('No mock clearinghouse state for ' + user);
    return state;
  }
  async perpDexs() { return this.data.perpDexs ?? [null]; }
  async outcomeMeta() { return this.data.outcomeMeta ?? { outcomes: [], questions: [] }; }
  async spotClearinghouseState(user: string) { return { balances: this.data.spotBalances?.[user.toLowerCase()] ?? [] }; }
  async userAbstraction(user: string) { return this.data.abstraction?.[user.toLowerCase()] ?? 'default'; }
  async delegatorSummary(user: string) {
    const st = this.data.staking?.[user.toLowerCase()];
    const delegated = (st?.delegations ?? []).reduce((t, d) => t + Number(d.amount), 0);
    return { delegated: String(delegated), undelegated: st?.undelegated ?? '0.0', totalPendingWithdrawal: '0.0', nPendingWithdrawals: 0 };
  }
  async delegations(user: string) { return this.data.staking?.[user.toLowerCase()]?.delegations ?? []; }
}
