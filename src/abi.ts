// ABI and function-signature lookups. Verified ABIs (Sourcify, Etherscan, user-supplied) are preferred; public
// signature databases are a fallback and are marked unverified, because different functions can share a selector.
import { keccak256, toFunctionSelector, toFunctionSignature, toHex } from 'viem';
import { isRpcError, TtlCache, type RpcClient } from './rpc.ts';
import type { AbiResolver, ContractAbi, SignatureCandidate, SignatureResolver } from './types.ts';

export interface AbiSource {
  lookup(chainId: number, address: string): Promise<ContractAbi | null>;
}

const ZERO_WORD = /^0x0*$/;
const wordToAddress = (w: unknown) => typeof w === 'string' && /^0x[0-9a-f]{64}$/i.test(w) && !ZERO_WORD.test(w) ? '0x' + w.slice(26).toLowerCase() : null;

// Storage slots, derived from their defining labels (EIP-1967: keccak256(label) - 1; EIP-1822 and the older
// ZeppelinOS slot used by USDC: keccak256(label)) so a mistyped constant cannot slip in.
const minusOne = (label: string) => '0x' + (BigInt(keccak256(toHex(label))) - 1n).toString(16).padStart(64, '0');
export const PROXY_SLOTS = {
  eip1967Implementation: minusOne('eip1967.proxy.implementation'),
  eip1967Beacon: minusOne('eip1967.proxy.beacon'),
  zeppelinos: keccak256(toHex('org.zeppelinos.proxy.implementation')),
  eip1822: keccak256(toHex('PROXIABLE')),
} as const;
const SLOTS = PROXY_SLOTS;
const IMPLEMENTATION_SELECTOR = '5c60da1b'; // implementation()
const SAFE_MASTER_COPY_SELECTOR = 'a619486e'; // masterCopy()

export interface ProxyInfo {
  implementation: string;
  method: 'eip7702' | 'eip1167' | 'eip1967' | 'eip1967-beacon' | 'zeppelinos' | 'eip1822' | 'safe' | 'implementation()';
}

/** A reverted call means "not available"; network failures are rethrown so they are never read as "not a proxy". */
const revertedAsNull = (e: unknown): null => { if (isRpcError(e)) return null; throw e; };

/**
 * Finds the implementation behind a proxy (or an EIP-7702 delegated account). Returns null for non-proxies, and
 * throws on network failure.
 */
export async function detectProxy(rpc: RpcClient, chainId: number, address: string): Promise<ProxyInfo | null> {
  if (!rpc.has(chainId)) return null;
  const code = String(await rpc.call(chainId, 'eth_getCode', [address, 'latest'])).toLowerCase();
  if (code === '0x' || code === '0x0') return null;
  const hasCode = async (a: string) => String(await rpc.call(chainId, 'eth_getCode', [a, 'latest'])).length > 2;
  const accept = async (implementation: string | null, method: ProxyInfo['method']) => implementation && implementation !== address.toLowerCase() && await hasCode(implementation) ? { implementation, method } : null;

  const delegated = /^0xef0100([0-9a-f]{40})$/.exec(code);
  if (delegated) return accept('0x' + delegated[1], 'eip7702');
  const minimal = /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/.exec(code);
  if (minimal) return accept('0x' + minimal[1], 'eip1167');

  const slot = (s: string) => rpc.call(chainId, 'eth_getStorageAt', [address, s, 'latest']).then(wordToAddress);
  const impl1967 = await slot(SLOTS.eip1967Implementation);
  if (impl1967) return accept(impl1967, 'eip1967');
  const beacon = await slot(SLOTS.eip1967Beacon);
  if (beacon) {
    const fromBeacon = await rpc.call(chainId, 'eth_call', [{ to: beacon, data: '0x' + IMPLEMENTATION_SELECTOR }, 'latest']).then(wordToAddress, revertedAsNull);
    return accept(fromBeacon, 'eip1967-beacon');
  }
  for (const [key, method] of [['zeppelinos', 'zeppelinos'], ['eip1822', 'eip1822']] as const) {
    const found = await slot(SLOTS[key]);
    if (found) return accept(found, method);
  }
  if (code.includes(SAFE_MASTER_COPY_SELECTOR)) {
    const master = await rpc.call(chainId, 'eth_getStorageAt', [address, '0x0', 'latest']).then(wordToAddress);
    const safe = await accept(master, 'safe');
    if (safe) return safe;
  }
  // Last resort for proxies with a non-standard slot that expose an implementation() getter to anyone.
  if (code.length < 2 + 2 * 4096 && code.includes(IMPLEMENTATION_SELECTOR)) {
    const viaGetter = await rpc.call(chainId, 'eth_call', [{ to: address, data: '0x' + IMPLEMENTATION_SELECTOR }, 'latest']).then(wordToAddress, revertedAsNull);
    return accept(viaGetter, 'implementation()');
  }
  return null;
}

/** Sourcify (https://sourcify.dev) verified-contract ABIs. No API key needed. */
export class SourcifyAbiSource implements AbiSource {
  private base: string;
  private fetchImpl: typeof fetch;
  constructor(options: { baseUrl?: string; fetchImpl?: typeof fetch } = {}) {
    this.base = (options.baseUrl ?? 'https://sourcify.dev/server').replace(/\/$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
  }
  async lookup(chainId: number, address: string): Promise<ContractAbi | null> {
    const res = await this.fetchImpl(`${this.base}/v2/contract/${chainId}/${address}?fields=abi,compilation`, { signal: AbortSignal.timeout(8000) });
    if (res.status === 404 || res.status === 400) return null; // not verified, or a chain Sourcify doesn't support
    if (!res.ok) throw new Error(`Sourcify HTTP ${res.status}`);
    const body = await res.json() as { abi?: unknown[]; compilation?: { name?: string }; match?: string | null };
    if (!Array.isArray(body.abi) || !body.match) return null;
    return { abi: body.abi, name: body.compilation?.name, source: `sourcify (${body.match})`, verified: true };
  }
}

/** Etherscan API v2 (one key covers Ethereum, Arbitrum, HyperEVM and other supported chains). */
export class EtherscanAbiSource implements AbiSource {
  private apiKey: string;
  private base: string;
  private fetchImpl: typeof fetch;
  constructor(apiKey: string, options: { baseUrl?: string; fetchImpl?: typeof fetch } = {}) {
    this.apiKey = apiKey;
    this.base = options.baseUrl ?? 'https://api.etherscan.io/v2/api';
    this.fetchImpl = options.fetchImpl ?? fetch;
  }
  async lookup(chainId: number, address: string): Promise<ContractAbi | null> {
    const url = `${this.base}?chainid=${chainId}&module=contract&action=getsourcecode&address=${address}&apikey=${encodeURIComponent(this.apiKey)}`;
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Etherscan HTTP ${res.status}`);
    const body = await res.json() as { status?: string; result?: { ABI?: string; ContractName?: string }[] | string };
    // Rate limits and key errors come back as status "0" with a string result: transient, so throw.
    if (!Array.isArray(body.result)) throw new Error(`Etherscan: ${typeof body.result === 'string' ? body.result : 'unexpected response'}`);
    const row = body.result[0];
    // An unverified contract has ABI "Contract source code not verified".
    if (body.status !== '1' || !row?.ABI || !row.ABI.startsWith('[')) return null;
    try { return { abi: JSON.parse(row.ABI), name: row.ContractName || undefined, source: 'etherscan', verified: true }; } catch { return null; }
  }
}

/** ABIs you supply, e.g. for your own contracts: { "42161:0xabc…": abi }. */
export class StaticAbiSource implements AbiSource {
  private map = new Map<string, ContractAbi>();
  constructor(entries: Record<string, { abi: readonly unknown[]; name?: string }>) {
    for (const [key, v] of Object.entries(entries)) this.map.set(key.toLowerCase(), { abi: v.abi, name: v.name, source: 'user', verified: true });
  }
  async lookup(chainId: number, address: string) { return this.map.get(`${chainId}:${address.toLowerCase()}`) ?? null; }
}

/**
 * Resolves an address to its ABI: verified sources in order, plus the implementation's ABI when the address is a
 * proxy. The implementation's functions are added only where the proxy's own ABI lacks them.
 */
export class ContractAbiResolver implements AbiResolver {
  private sources: AbiSource[];
  private rpc?: RpcClient;
  private cache = new TtlCache<Promise<ContractAbi | null>>();
  private ttlMs: number;
  private retryMs: number;
  constructor(options: { sources: AbiSource[]; rpc?: RpcClient; ttlMs?: number; retryMs?: number }) {
    this.sources = options.sources;
    this.rpc = options.rpc;
    this.ttlMs = options.ttlMs ?? 10 * 60_000;
    this.retryMs = options.retryMs ?? 30_000;
  }
  /** Cached for ttlMs; a result affected by a network failure (source or proxy lookup) only for retryMs. */
  resolve(chainId: number, address: string): Promise<ContractAbi | null> {
    const key = `${chainId}:${address.toLowerCase()}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    let expire = (_ttl: number) => {};
    const value = this.load(chainId, address.toLowerCase()).then(
      r => { if (r.transient) expire(this.retryMs); return r.abi; },
      () => { expire(this.retryMs); return null; });
    expire = this.cache.set(key, value, this.ttlMs);
    return value;
  }
  private async first(chainId: number, address: string): Promise<{ abi: ContractAbi | null; failed: boolean }> {
    let failed = false;
    for (const s of this.sources) {
      try { const r = await s.lookup(chainId, address); if (r) return { abi: r, failed }; } catch { failed = true; }
    }
    return { abi: null, failed };
  }
  private async load(chainId: number, address: string): Promise<{ abi: ContractAbi | null; transient: boolean }> {
    const first = await this.first(chainId, address);
    const own = first.abi;
    let transient = first.failed;
    let proxy: ProxyInfo | null = null;
    if (this.rpc) { try { proxy = await detectProxy(this.rpc, chainId, address); } catch { transient = true; } }
    if (!proxy) return { abi: own, transient };
    const second = await this.first(chainId, proxy.implementation);
    const impl = second.abi;
    transient ||= second.failed;
    if (!impl) return { abi: own ? { ...own, implementation: proxy.implementation } : null, transient };
    const ownAbi = (own?.abi ?? []) as { type?: string; name?: string }[];
    const ownFns = new Set(ownAbi.filter(i => i.type === 'function').map(i => i.name));
    const merged = [...ownAbi, ...(impl.abi as { type?: string; name?: string }[]).filter(i => i.type !== 'function' || !ownFns.has(i.name))];
    return { abi: { abi: merged, name: impl.name ?? own?.name, source: `${impl.source} via ${proxy.method} proxy`, verified: impl.verified, implementation: proxy.implementation }, transient };
  }
}

/**
 * OpenChain signature database (https://openchain.xyz), with its spam filter on. Its `hasVerifiedContract` flag is
 * not used: spam collisions such as "permit8355429682040(address,uint256)" for 0xa9059cbb carry it too.
 */
export class OpenChainSignatures implements SignatureResolver {
  private fetchImpl: typeof fetch;
  private base: string;
  constructor(options: { baseUrl?: string; fetchImpl?: typeof fetch } = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.base = options.baseUrl ?? 'https://api.openchain.xyz/signature-database/v1/lookup';
  }
  async lookup(selector: string): Promise<string[]> {
    const res = await this.fetchImpl(`${this.base}?function=${selector}&filter=true`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`OpenChain HTTP ${res.status}`);
    const body = await res.json() as { ok?: boolean; result?: { function?: Record<string, { name: string }[] | null> } };
    return (body.result?.function?.[selector.toLowerCase()] ?? []).map(x => x.name);
  }
  async candidates(selector: string): Promise<SignatureCandidate[]> {
    return (await this.lookup(selector)).map(signature => ({ signature, tier: 1, source: 'OpenChain' }));
  }
}

/**
 * 4byte.directory signature database. Anyone can register a signature and there is no spam filter, but entries
 * can't be backdated, so results are returned oldest registration first: a genuine function usually predates the
 * collisions crafted for it (0xa9059cbb: "transfer(address,uint256)" is #145 from 2016, the spam is younger).
 */
export class FourByteSignatures implements SignatureResolver {
  private fetchImpl: typeof fetch;
  private base: string;
  constructor(options: { baseUrl?: string; fetchImpl?: typeof fetch } = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.base = options.baseUrl ?? 'https://www.4byte.directory/api/v1/signatures/';
  }
  async lookup(selector: string): Promise<string[]> {
    const res = await this.fetchImpl(`${this.base}?hex_signature=${selector}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`4byte HTTP ${res.status}`);
    const body = await res.json() as { results?: { id?: number; text_signature: string }[] };
    return [...(body.results ?? [])].sort((a, b) => (a.id ?? Infinity) - (b.id ?? Infinity)).map(x => x.text_signature);
  }
  async candidates(selector: string): Promise<SignatureCandidate[]> {
    return (await this.lookup(selector)).map(signature => ({ signature, tier: 2, ordered: true, source: '4byte' }));
  }
}

/**
 * A small built-in list of common functions, so frequent calls are recognised offline. Parameter names follow each
 * protocol's source, which lets amounts be shown in token units; databases only return types.
 */
export const COMMON_SIGNATURES = [
  // Batching: Uniswap routers / Multicall3 / Universal Router
  'multicall(bytes[] data)', 'multicall(uint256 deadline, bytes[] data)',
  'aggregate((address target, bytes callData)[] calls)', 'aggregate3((address target, bool allowFailure, bytes callData)[] calls)',
  'aggregate3Value((address target, bool allowFailure, uint256 value, bytes callData)[] calls)',
  'execute(bytes commands, bytes[] inputs, uint256 deadline)', 'execute(bytes commands, bytes[] inputs)',
  // Uniswap V2 Router02
  'swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)',
  'swapTokensForExactTokens(uint256 amountOut, uint256 amountInMax, address[] path, address to, uint256 deadline)',
  'swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline)',
  'swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)',
  // Uniswap V3 SwapRouter02 (no deadline) and SwapRouter
  'exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params)',
  'exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params)',
  'exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum) params)',
  'exactInput((bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum) params)',
  // Aave V3 Pool
  'supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)', 'withdraw(address asset, uint256 amount, address to)',
  'borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)',
  'repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf)',
  // ERC-4626 vaults
  'deposit(uint256 assets, address receiver)', 'redeem(uint256 shares, address receiver, address owner)', 'mint(uint256 shares, address receiver)',
  // NFTs (ERC-721 / ERC-1155)
  'safeTransferFrom(address from, address to, uint256 tokenId)', 'safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes data)',
  'safeBatchTransferFrom(address from, address to, uint256[] ids, uint256[] values, bytes data)',
  // Admin
  'transferOwnership(address newOwner)', 'renounceOwnership()', 'upgradeTo(address newImplementation)', 'upgradeToAndCall(address newImplementation, bytes data)',
  'grantRole(bytes32 role, address account)',
  'claim()', 'stake(uint256 amount)', 'unstake(uint256 amount)',
];

/** "supply(address asset, uint256 amount)" and "supply(address,uint256)" are the same function. */
export function canonicalSignature(sig: string): string {
  try { return toFunctionSignature(`function ${sig.replace(/^function\s+/, '')}`); } catch { return sig.replace(/\s+/g, ''); }
}

/**
 * Combines signature sources: the built-in list (tier 0), then databases by their tier. Duplicates (same function,
 * with or without parameter names) keep the most trusted entry.
 */
export class ChainedSignatures implements SignatureResolver {
  private sources: SignatureResolver[];
  private builtIn: Map<string, string[]> | null = null;
  private useBuiltIn: boolean;
  private cache = new TtlCache<Promise<SignatureCandidate[]>>();
  private ttlMs: number;
  private retryMs: number;
  constructor(sources: SignatureResolver[], options: { builtIn?: boolean; ttlMs?: number; retryMs?: number } = {}) {
    this.sources = sources;
    this.useBuiltIn = options.builtIn ?? true;
    this.ttlMs = options.ttlMs ?? 60 * 60_000;
    this.retryMs = options.retryMs ?? 30_000;
  }
  private async builtInFor(selector: string): Promise<string[]> {
    if (!this.useBuiltIn) return [];
    if (!this.builtIn) {
      this.builtIn = new Map();
      for (const sig of COMMON_SIGNATURES) {
        const sel = toFunctionSelector(`function ${sig}`);
        this.builtIn.set(sel, [...(this.builtIn.get(sel) ?? []), sig]); // names included
      }
    }
    return this.builtIn.get(selector.toLowerCase()) ?? [];
  }
  async lookup(selector: string): Promise<string[]> {
    return (await this.candidates(selector)).map(c => c.signature);
  }
  /** Most trusted first. Cached per selector; if a database could not be reached, only for retryMs. */
  candidates(selector: string): Promise<SignatureCandidate[]> {
    const key = selector.toLowerCase();
    const hit = this.cache.get(key);
    if (hit) return hit;
    let expire = (_ttl: number) => {};
    const value = (async () => {
      const all: SignatureCandidate[] = (await this.builtInFor(key)).map(signature => ({ signature, tier: 0, source: 'built-in' }));
      for (const s of this.sources) {
        try {
          all.push(...(s.candidates ? await s.candidates(key) : (await s.lookup(key)).map(signature => ({ signature, tier: 2 }))));
        } catch { expire(this.retryMs); }
      }
      all.sort((a, b) => a.tier - b.tier); // stable: keeps each source's own order within a tier
      const seen = new Set<string>();
      return all.filter(c => { const k = canonicalSignature(c.signature); if (seen.has(k)) return false; seen.add(k); return true; });
    })();
    expire = this.cache.set(key, value, this.ttlMs);
    return value;
  }
}
