import { attentionOf, PreviewBuilder } from './format.ts';
import { chainName } from './chains.ts';
import type { Dependencies, Preview, PreviewContext, SigningRequest, Warning } from './types.ts';
import { normalizeTransaction, previewTransaction, RequestError } from './evm/transaction.ts';
import { parseTypedData, typedDataDigest, type TypedAdapter } from './typed-data/common.ts';
import { hyperliquidL1Adapter, hyperliquidUserSignedAdapter } from './typed-data/hyperliquid.ts';
import { genericTypedDataAdapter, permitAdapter } from './typed-data/permit.ts';
import { previewMessage } from './message.ts';

export const TYPED_DATA_ADAPTERS: TypedAdapter[] = [hyperliquidL1Adapter, hyperliquidUserSignedAdapter, permitAdapter, genericTypedDataAdapter];

/** Methods that ask the user to sign something. Everything else passes through an interceptor untouched. */
export const SIGNING_METHODS = ['eth_sendTransaction', 'eth_signTransaction', 'wallet_sendCalls', 'eth_signTypedData_v4', 'eth_signTypedData_v3', 'eth_signTypedData', 'personal_sign', 'eth_sign'] as const;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Turns any EIP-1193 signing request into a human-readable Preview.
 * Throws RequestError (code INVALID_REQUEST) when the request is malformed.
 */
export async function previewRequest(request: SigningRequest, context: PreviewContext = {}, deps: Dependencies = {}): Promise<Preview> {
  if (!request || typeof request.method !== 'string') throw new RequestError('Request must have a "method"');
  const params = Array.isArray(request.params) ? request.params : request.params === undefined ? [] : [request.params];
  const method = request.method;
  switch (method) {
    case 'eth_sendTransaction':
    case 'eth_signTransaction':
      return previewTransaction(normalizeTransaction(params[0], context), deps, context, method);
    case 'wallet_sendCalls':
      return previewBatch(params[0], context, deps);
    case 'eth_signTypedData_v4':
    case 'eth_signTypedData_v3':
    case 'eth_signTypedData':
      return previewTypedData(method, params, context, deps);
    case 'personal_sign':
    case 'eth_sign':
      return previewMessage(method, params, context);
  }
  const b = new PreviewBuilder().warn('info', 'not_a_signing_request', `${method} is not a signing request, so there is nothing to preview.`);
  return { schema: 'signing-preview/1', method, kind: 'unsupported', network: null, title: method, summary: 'Not a signing request.', details: [], assetChanges: [], warnings: b.warnings, attention: 'info', decoding: { status: 'opaque', decoder: 'none', notes: [] } };
}

async function previewTypedData(method: string, params: unknown[], context: PreviewContext, deps: Dependencies): Promise<Preview> {
  // v3/v4 params are [address, data]; tolerate the reversed order some dApps use.
  let [signer, raw] = params as [unknown, unknown];
  if (!(typeof signer === 'string' && ADDRESS.test(signer)) && typeof raw === 'string' && ADDRESS.test(raw)) [signer, raw] = [raw, signer];
  if (method === 'eth_signTypedData' && Array.isArray(signer ?? raw)) {
    throw new RequestError('Legacy eth_signTypedData (v1) is not supported; use eth_signTypedData_v4');
  }
  let data;
  try { data = parseTypedData(raw); } catch (error) { throw new RequestError(error instanceof Error ? error.message : String(error)); }
  const env = { deps, context, signer: typeof signer === 'string' && ADDRESS.test(signer) ? signer.toLowerCase() : null, now: context.now ?? Date.now() };
  let result = null;
  for (const adapter of TYPED_DATA_ADAPTERS) {
    result = await adapter(data, env);
    if (result) break;
  }
  const d = result!;
  if (env.signer && context.account && env.signer !== context.account.toLowerCase()) d.b.warn('danger', 'signer_mismatch', `The request asks ${env.signer} to sign, but the connected account is ${context.account}.`);
  const digest = typedDataDigest(data);
  if (digest) d.b.detail('EIP-712 digest', digest);
  else d.b.note('The EIP-712 digest could not be computed; the types may be malformed.');
  return {
    schema: 'signing-preview/1', method, kind: 'typed_data', network: d.network,
    title: d.title, summary: d.summary, details: d.b.details, assetChanges: d.assetChanges ?? [], warnings: d.b.warnings, attention: attentionOf(d.b.warnings),
    decoding: { status: d.status, decoder: d.decoder, notes: d.b.notes },
  };
}

/** EIP-5792 wallet_sendCalls: preview each call, then summarise. */
async function previewBatch(raw: unknown, context: PreviewContext, deps: Dependencies): Promise<Preview> {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as Record<string, unknown>).calls)) throw new RequestError('wallet_sendCalls needs { calls: [...] }');
  const batch = raw as { chainId?: string; from?: string; calls: unknown[] };
  if (batch.calls.length === 0 || batch.calls.length > 32) throw new RequestError('wallet_sendCalls must contain 1 to 32 calls');
  const chainId = batch.chainId !== undefined ? Number(BigInt(batch.chainId)) : context.chainId;
  const calls: Preview[] = [];
  for (const call of batch.calls) calls.push(await previewTransaction(normalizeTransaction(call, context, batch.from, chainId), deps, context, 'wallet_sendCalls'));
  const warnings: Warning[] = calls.flatMap((c, i) => c.warnings.map(w => ({ ...w, message: `Call ${i + 1}: ${w.message}` })));
  const statuses = calls.map(c => c.decoding.status);
  return {
    schema: 'signing-preview/1', method: 'wallet_sendCalls', kind: 'batch',
    network: chainId ? { kind: 'evm', chainId, name: chainName(chainId) } : null,
    title: calls.length === 1 ? calls[0].title : `${calls.length} actions: ${calls.map(c => c.title).join(' → ')}`,
    summary: `Runs ${calls.length} call${calls.length === 1 ? '' : 's'} in order. ${calls.map((c, i) => `(${i + 1}) ${c.summary}`).join(' ')}`,
    details: [], assetChanges: calls.flatMap(c => c.assetChanges), warnings, attention: attentionOf(warnings),
    decoding: { status: statuses.every(s => s === 'full') ? 'full' : statuses.every(s => s === 'opaque') ? 'opaque' : 'partial', decoder: 'batch', notes: [] },
    calls,
  };
}
