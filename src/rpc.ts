/** Minimal JSON-RPC client shared by token, proxy and ABI lookups. Read-only methods only. */
export interface RpcClient {
  call(chainId: number, method: string, params: unknown[]): Promise<unknown>;
  has(chainId: number): boolean;
}

/**
 * True when the node answered with a JSON-RPC error (e.g. "execution reverted"): a definitive answer about the
 * contract. Anything else (timeout, HTTP error, rate limit) is transient and must not be cached as a negative result.
 */
export const isRpcError = (e: unknown): boolean => !!e && typeof e === 'object' && 'rpcError' in e;

/** A small TTL cache. Entries can shorten their own lifetime, so transient failures are retried soon. */
export class TtlCache<T> {
  private map = new Map<string, { at: number; ttl: number; value: T }>();
  private max: number;
  constructor(options: { max?: number } = {}) { this.max = options.max ?? 5000; }
  get(key: string): T | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (Date.now() - e.at < e.ttl) return e.value;
    this.map.delete(key);
    return undefined;
  }
  /** Stores value and returns a function that changes how long it is kept. */
  set(key: string, value: T, ttl: number): (ttl: number) => void {
    this.map.delete(key);
    const e = { at: Date.now(), ttl, value };
    this.map.set(key, e);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
    return t => { e.ttl = t; };
  }
}

export class JsonRpcClient implements RpcClient {
  private urls: Record<number, string>;
  private fetchImpl: typeof fetch;
  private timeoutMs: number;
  private retries: number;
  private retryDelayMs: number;
  constructor(urls: Record<number, string>, options: { fetchImpl?: typeof fetch; timeoutMs?: number; retries?: number; retryDelayMs?: number } = {}) {
    this.urls = urls;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 8000;
    this.retries = options.retries ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 400;
  }
  has(chainId: number) { return !!this.urls[chainId]; }
  /**
   * Public RPCs (HyperEVM's in particular) rate-limit; a throttled call is retried a few times, briefly. So is one
   * answered by a load-balanced node a block behind the others ("invalid block height", "header not found").
   */
  async call(chainId: number, method: string, params: unknown[]): Promise<unknown> {
    const url = this.urls[chainId];
    if (!url) throw new Error(`No RPC URL for chain ${chainId}`);
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(this.timeoutMs),
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const limited = res.status === 429;
      const body = limited ? undefined : res.ok ? await res.json() as { result?: unknown; error?: { code?: number; message?: string } } : undefined;
      if ((limited || /rate limit|too many requests|invalid block height|header not found/i.test(body?.error?.message ?? '')) && attempt < this.retries) {
        await new Promise(r => setTimeout(r, this.retryDelayMs * 2 ** attempt));
        continue;
      }
      if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
      if (body!.error && !/rate limit|too many requests/i.test(body!.error.message ?? '')) throw Object.assign(new Error(`${method}: ${body!.error.message ?? 'error'}`), { rpcError: body!.error });
      if (body!.error) throw new Error(`${method}: rate limited`);
      return body!.result;
    }
  }
}
