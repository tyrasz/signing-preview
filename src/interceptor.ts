// Dependency-free EIP-1193 interceptor. Wrap any wallet provider (window.ethereum,
// an EIP-6963 provider, WalletConnect, an extension's own provider) so every
// signing request is previewed and confirmed before it reaches the wallet.
import type { Preview, PreviewContext, SigningRequest } from './types.ts';

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
  [key: string]: unknown;
}

export type PreviewFn = (request: SigningRequest, context: PreviewContext) => Promise<Preview>;

export interface InterceptorOptions {
  /** Produces the preview: `remotePreview(url)` for the HTTP API, or the library's `previewRequest` bound to deps. */
  preview: PreviewFn;
  /** Shows the preview to the user. Resolve true to forward the request to the wallet, false to reject it. */
  confirm: (preview: Preview, request: SigningRequest) => Promise<boolean>;
  /** Extra context per request, e.g. the Hyperliquid L1 action pre-image a trusted dApp provides. */
  context?: (request: SigningRequest) => Promise<Partial<PreviewContext>> | Partial<PreviewContext>;
  /** dApp origin; defaults to location.origin in browsers. */
  origin?: string;
  methods?: readonly string[];
}

export const DEFAULT_SIGNING_METHODS = ['eth_sendTransaction', 'eth_signTransaction', 'wallet_sendCalls', 'eth_signTypedData_v4', 'eth_signTypedData_v3', 'eth_signTypedData', 'personal_sign', 'eth_sign', 'wallet_requestExecutionPermissions'];

export class UserRejectedError extends Error {
  code = 4001;
  constructor(message = 'User rejected the request.') { super(message); }
}

/** Returns a provider that behaves like `provider` but previews signing requests first. */
export function withSigningPreview<P extends Eip1193Provider>(provider: P, options: InterceptorOptions): P {
  const methods = new Set(options.methods ?? DEFAULT_SIGNING_METHODS);
  const origin = options.origin ?? (typeof location !== 'undefined' ? location.origin : undefined);
  const request = async (args: { method: string; params?: unknown }) => {
    if (!methods.has(args.method)) return provider.request(args);
    const signing: SigningRequest = { method: args.method, params: args.params };
    const context: PreviewContext = { origin, ...(await baseContext(provider)), ...(await options.context?.(signing)) };
    let preview: Preview;
    try {
      preview = await options.preview(signing, context);
    } catch (error) {
      // Never forward silently when the preview fails: show an explicit fallback.
      preview = fallbackPreview(signing, error);
    }
    if (!(await options.confirm(preview, signing))) throw new UserRejectedError();
    return provider.request(args);
  };
  return new Proxy(provider, {
    get(target, key, receiver) {
      if (key === 'request') return request;
      const value = Reflect.get(target, key, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function baseContext(provider: Eip1193Provider): Promise<Partial<PreviewContext>> {
  const out: Partial<PreviewContext> = {};
  // Both calls are non-prompting; failures just leave the field unset.
  try { out.chainId = Number(BigInt(await provider.request({ method: 'eth_chainId' }) as string)); } catch { /* unknown */ }
  try {
    const accounts = await provider.request({ method: 'eth_accounts' }) as string[];
    if (accounts?.[0]) out.account = accounts[0];
  } catch { /* unknown */ }
  return out;
}

function fallbackPreview(request: SigningRequest, error: unknown): Preview {
  const message = error instanceof Error ? error.message : String(error);
  const warnings: Preview['warnings'] = [{ severity: 'caution', code: 'preview_unavailable', message: `A readable preview could not be produced (${message}). Check the raw request carefully.` }];
  // eth_sign is a blind signature whatever its preview would have said: a failed preview doesn't make it less of a
  // danger (context a dApp adds to the request must not be a way to turn that danger into a caution).
  const blind = request.method === 'eth_sign';
  if (blind) warnings.push({ severity: 'danger', code: 'eth_sign', message: 'eth_sign signs raw data that can be a transaction or permission. Legitimate dApps no longer need it. Reject unless you know exactly what this is.' });
  return {
    schema: 'signing-preview/1', method: request.method, kind: 'unsupported', network: null,
    title: 'Preview unavailable', summary: 'The signing request could not be decoded.', details: [{ label: 'Raw request', value: JSON.stringify(request.params) }],
    assetChanges: [], warnings, attention: blind ? 'danger' : 'caution', decoding: { status: 'opaque', decoder: 'none', notes: [] },
  };
}

/** Preview function that calls a deployed signing-preview HTTP API. */
export function remotePreview(endpoint: string, init: { headers?: Record<string, string>; timeoutMs?: number } = {}): PreviewFn {
  return async (request, context) => {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...init.headers },
      body: JSON.stringify({ request, context }),
      signal: AbortSignal.timeout(init.timeoutMs ?? 15_000),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error?.message ?? `Preview API returned HTTP ${res.status}`);
    return body as Preview;
  };
}
