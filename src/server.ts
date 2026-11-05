import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { previewRequest } from './preview.ts';
import { RequestError } from './evm/transaction.ts';
import { StaticTokenRegistry } from './chains.ts';
import { HttpHyperliquidInfo, INFO_URLS } from './hyperliquid/info.ts';
import { RpcSimulator } from './simulation.ts';
import { ForkSimulator } from './fork-simulator.ts';
import type { Dependencies, PreviewContext, SimulationRequest, TokenRegistry } from './types.ts';
import { KINETIQ } from './evm/kinetiq.ts';
import { HYPERLEND } from './evm/hyperlend.ts';
import { JsonRpcClient } from './rpc.ts';
import { ChainedTokenRegistry, OnchainTokenRegistry, TokenListRegistry } from './tokens.ts';
import { ChainedSignatures, ContractAbiResolver, EtherscanAbiSource, FourByteSignatures, OpenChainSignatures, SourcifyAbiSource, type AbiSource } from './abi.ts';

/** The package root, where demo/ and openapi.json live: one level above src/, three above dist/lib/src/. */
const ROOT = [new URL('..', import.meta.url), new URL('../../..', import.meta.url)].map(u => fileURLToPath(u))
  .find(p => existsSync(join(p, 'openapi.json'))) ?? fileURLToPath(new URL('..', import.meta.url));
let openapi: string | undefined;
/** The OpenAPI 3.1 document for this server (openapi.json in the package). */
export function openApiDocument(): Record<string, unknown> {
  openapi ??= readFileSync(join(ROOT, 'openapi.json'), 'utf8');
  return JSON.parse(openapi);
}
const MAX_BODY = 256 * 1024;
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.map': 'application/json' };

export interface ServerOptions {
  deps: Dependencies;
  /** Value of Access-Control-Allow-Origin. "*" lets any wallet, extension or web app call the API. */
  corsOrigin?: string;
  /** Sample requests served at /v1/samples (demo only). */
  samples?: () => unknown;
  /** Serve the demo page and browser bundles. */
  serveDemo?: boolean;
  /** What the demo page says its previews are made from (served at /demo/config.json). Default "mock". */
  demoData?: 'mock' | 'live';
}

export function createPreviewServer(options: ServerOptions) {
  const cors = options.corsOrigin ?? '*';
  return createServer(async (req, res) => {
    res.setHeader('access-control-allow-origin', cors);
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type');
    res.setHeader('access-control-max-age', '600');
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'OPTIONS') return void res.writeHead(204).end();
      if (req.method === 'GET' && url.pathname === '/v1/health') return json(res, 200, { status: 'ok' });
      if (req.method === 'GET' && url.pathname === '/v1/openapi.json') return json(res, 200, openApiDocument());
      if (req.method === 'POST' && url.pathname === '/v1/preview') return await handlePreview(req, res, options.deps);
      if (req.method === 'GET' && url.pathname === '/v1/samples' && options.samples) return json(res, 200, options.samples());
      if (req.method === 'GET' && options.serveDemo && url.pathname === '/demo/config.json') return json(res, 200, { data: options.demoData ?? 'mock' });
      if (req.method === 'GET' && options.serveDemo) return await serveStatic(url.pathname, res);
      return json(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
    } catch (error) {
      if (!res.headersSent) json(res, 500, { error: { code: 'INTERNAL', message: error instanceof Error ? error.message : 'Internal error' } });
    }
  });
}

async function handlePreview(req: IncomingMessage, res: ServerResponse, deps: Dependencies) {
  if (!(req.headers['content-type'] ?? '').includes('application/json')) return json(res, 415, { error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Send application/json' } });
  let body: { request?: unknown; context?: PreviewContext };
  try { body = JSON.parse(await readBody(req)); } catch (error) {
    if (error instanceof BodyTooLarge) res.setHeader('connection', 'close');
    return json(res, error instanceof BodyTooLarge ? 413 : 400, { error: { code: 'INVALID_JSON', message: error instanceof Error ? error.message : 'Invalid JSON' } });
  }
  if (!body || typeof body !== 'object' || !body.request) return json(res, 400, { error: { code: 'INVALID_REQUEST', message: 'Body must be { request: { method, params }, context? }' } });
  const context = sanitizeContext(body.context);
  try {
    const preview = await previewRequest(body.request as never, context, deps);
    return json(res, 200, preview);
  } catch (error) {
    if (error instanceof RequestError || (error as { code?: string })?.code === 'INVALID_REQUEST') return json(res, 400, { error: { code: 'INVALID_REQUEST', message: (error as Error).message } });
    throw error;
  }
}

function sanitizeContext(raw: unknown): PreviewContext {
  if (!raw || typeof raw !== 'object') return {};
  const c = raw as Record<string, unknown>;
  const out: PreviewContext = {};
  if (typeof c.chainId === 'number' && Number.isSafeInteger(c.chainId)) out.chainId = c.chainId;
  if (typeof c.origin === 'string') out.origin = c.origin.slice(0, 256);
  if (typeof c.account === 'string' && /^0x[0-9a-fA-F]{40}$/.test(c.account)) out.account = c.account;
  const hl = c.hyperliquid as Record<string, unknown> | undefined;
  if (hl && typeof hl === 'object' && hl.action && typeof hl.action === 'object' && typeof hl.nonce === 'number') {
    out.hyperliquid = {
      action: hl.action as Record<string, unknown>, nonce: hl.nonce,
      vaultAddress: typeof hl.vaultAddress === 'string' && /^0x[0-9a-fA-F]{40}$/.test(hl.vaultAddress) ? hl.vaultAddress : null,
      expiresAfter: typeof hl.expiresAfter === 'number' ? hl.expiresAfter : null,
    };
  }
  return out;
}

class BodyTooLarge extends Error {}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0, tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return; // discard the rest, so the client still receives the 413
      size += chunk.length;
      if (size > MAX_BODY) { tooLarge = true; chunks.length = 0; reject(new BodyTooLarge(`Body exceeds ${MAX_BODY} bytes`)); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function serveStatic(pathname: string, res: ServerResponse) {
  const path = pathname === '/' ? '/demo/index.html' : pathname;
  if (!/^\/(demo|dist)\//.test(path)) return json(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
  const file = normalize(join(ROOT, path));
  if (!file.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep)) return json(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
  try {
    const content = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' }).end(content);
  } catch {
    json(res, 404, { error: { code: 'NOT_FOUND', message: path.startsWith('/dist/') ? 'Not built yet: run npm run build' : 'Not found' } });
  }
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

/** Dependencies for live mode: Hyperliquid's public /info API and eth_simulateV1 against configured RPCs. */
/**
 * Dependencies for live mode. RPC URLs enable simulation, on-chain token metadata and proxy detection; ABIs come
 * from Sourcify (plus Etherscan when ETHERSCAN_API_KEY is set); TOKEN_LIST_FILE adds a tokenlists.org-format list.
 * Set SIGNING_PREVIEW_OFFLINE_LOOKUPS=1 to skip the public ABI and signature services.
 */
export function liveDependencies(env = process.env, options: { warmUp?: boolean } = {}): Dependencies {
  const rpcs: Record<number, string> = {};
  if (env.ETHEREUM_RPC_URL) rpcs[1] = env.ETHEREUM_RPC_URL;
  if (env.ARBITRUM_RPC_URL) rpcs[42161] = env.ARBITRUM_RPC_URL;
  if (env.HYPEREVM_RPC_URL) rpcs[999] = env.HYPEREVM_RPC_URL;
  const rpc = new JsonRpcClient(rpcs);
  const fork = new ForkSimulator(rpcs);
  if (options.warmUp && rpcs[999]) setTimeout(() => warmHyperEvm(fork, rpc).catch(() => { /* only warming */ }), 0).unref?.();
  const tokenSources: TokenRegistry[] = [new StaticTokenRegistry()];
  if (env.TOKEN_LIST_FILE) tokenSources.push(new TokenListRegistry(JSON.parse(readFileSync(env.TOKEN_LIST_FILE, 'utf8'))));
  tokenSources.push(new OnchainTokenRegistry(rpc));
  const online = env.SIGNING_PREVIEW_OFFLINE_LOOKUPS !== '1';
  const abiSources: AbiSource[] = online ? [new SourcifyAbiSource(), ...(env.ETHERSCAN_API_KEY ? [new EtherscanAbiSource(env.ETHERSCAN_API_KEY)] : [])] : [];
  return {
    rpc,
    tokens: new ChainedTokenRegistry(tokenSources),
    abis: new ContractAbiResolver({ sources: abiSources, rpc }),
    signatures: new ChainedSignatures(online ? [new OpenChainSignatures(), new FourByteSignatures()] : []),
    hyperliquid: { mainnet: new HttpHyperliquidInfo(INFO_URLS.mainnet), testnet: new HttpHyperliquidInfo(INFO_URLS.testnet) },
    ...(Object.keys(rpcs).length && { simulator: new RpcSimulator(rpcs, { fork }) }),
  };
}

/**
 * Background simulations of HyperEVM's main protocol paths (a Kinetiq stake; HyperLend's reserves and their oracle
 * prices), so their first real previews get the fork simulator's full answer within its budget.
 */
async function warmHyperEvm(fork: ForkSimulator, rpc: JsonRpcClient): Promise<void> {
  const view = (to: string, data: string) => [{ chainId: 999, from: '0x0000000000000000000000000000000000000000', to, data, value: 0n }];
  const word = (a: string) => a.slice(2).toLowerCase().padStart(64, '0');
  const batches: SimulationRequest[][] = [
    // From WHYPE's own address: it holds plenty of HYPE.
    [{ chainId: 999, from: '0x5555555555555555555555555555555555555555', to: KINETIQ[999].stakingManager, data: '0x3a4b66f1', value: 10n ** 19n }],
  ];
  const pool = HYPERLEND[999].pool;
  const list = String(await rpc.call(999, 'eth_call', [{ to: pool, data: '0xd1946dbc' }, 'latest']));
  const reserves = list.length > 130 ? Array.from({ length: Number(BigInt('0x' + list.slice(66, 130))) }, (_, i) => '0x' + list.slice(130 + 64 * i + 24, 130 + 64 * (i + 1))) : [];
  const oracle = '0x' + String(await rpc.call(999, 'eth_call', [{ to: HYPERLEND[999].addressesProvider, data: '0xfca513a8' }, 'latest'])).slice(26);
  // One batch: the calls share one fetch of each slot and contract, keeping a public RPC's rate limit in mind.
  batches[0].push(...reserves.flatMap(r => [...view(pool, `0x35ea6a75${word(r)}`), ...view(oracle, `0xb3596f07${word(r)}`)])); // getReserveData, getAssetPrice
  await fork.warm(batches);
}
