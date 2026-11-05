#!/usr/bin/env node
// `signing-preview` (npx signing-preview, or npm start): the HTTP API and demo.
//   SIGNING_PREVIEW_MODE=live  use real RPCs and Hyperliquid's /info API (see liveDependencies) instead of mock data
//   PORT (8787), HOST (127.0.0.1), CORS_ORIGIN (*)
//   SIGNING_PREVIEW_FORK_CACHE  live mode's HyperEVM simulator cache (~/.cache/signing-preview/fork-cache.json; "off" for none)
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createPreviewServer, liveDependencies } from './server.ts';
import { StaticTokenRegistry } from './chains.ts';
import { ChainedSignatures } from './abi.ts';
import type { Dependencies } from './types.ts';

const mode = process.env.SIGNING_PREVIEW_MODE === 'live' ? 'live' : 'mock';
const { buildSamples, mockHyperEvmRpc, mockHyperliquidInfo, mockSimulator } = await import('../mocks/data.ts');
// Live mode warms the HyperEVM simulator's caches in the background, so first previews there are fast.
// It also keeps that simulator's caches in a file (SIGNING_PREVIEW_FORK_CACHE, "off" for none), so restarts stay fast.
const cacheHome = process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache');
const env = { ...process.env, SIGNING_PREVIEW_FORK_CACHE: process.env.SIGNING_PREVIEW_FORK_CACHE ?? join(cacheHome, 'signing-preview', 'fork-cache.json') };
const deps: Dependencies = mode === 'live' ? liveDependencies(env, { warmUp: true })
  : { tokens: new StaticTokenRegistry(), signatures: new ChainedSignatures([]), simulator: mockSimulator(), hyperliquid: { mainnet: mockHyperliquidInfo() }, rpc: mockHyperEvmRpc() };
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '127.0.0.1';
createPreviewServer({ deps, corsOrigin: process.env.CORS_ORIGIN ?? '*', samples: () => buildSamples(), serveDemo: true, demoData: mode })
  .listen(port, host, () => console.log(`signing-preview (${mode} data) on http://${host}:${port}  ·  POST /v1/preview  ·  GET /v1/openapi.json`));
