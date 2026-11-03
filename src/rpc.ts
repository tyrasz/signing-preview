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
  constructor(urls: Record<number, string>, options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}) {
    this.urls = urls;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 8000;
  }
  has(chainId: number) { return !!this.urls[chainId]; }
  async call(chainId: number, method: string, params: unknown[]): Promise<unknown> {
    const url = this.urls[chainId];
    if (!url) throw new Error(`No RPC URL for chain ${chainId}`);
    const res = await this.fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
    const body = await res.json() as { result?: unknown; error?: { message?: string } };
    if (body.error) throw Object.assign(new Error(`${method}: ${body.error.message ?? 'error'}`), { rpcError: body.error });
    return body.result;
  }
}
