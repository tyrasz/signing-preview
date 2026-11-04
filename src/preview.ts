import { attentionOf, PreviewBuilder } from './format.ts';
import { chainName } from './chains.ts';
import type { ApprovalChange, AssetChange, Dependencies, Preview, PreviewContext, SigningRequest, SimulationResult, SimulationSummary, Warning } from './types.ts';
import { normalizeTransaction, previewTransaction, RequestError, simulationRequest, type PresetSimulation } from './evm/transaction.ts';
import { approvalChanges, netChanges, nftChanges } from './evm/effects.ts';
import { parseTypedData, typedDataDigest, type TypedAdapter } from './typed-data/common.ts';
import { hyperliquidL1Adapter, hyperliquidUserSignedAdapter } from './typed-data/hyperliquid.ts';
import { genericTypedDataAdapter, permitAdapter } from './typed-data/permit.ts';
import { eip3009Adapter } from './typed-data/eip3009.ts';
import { creditDelegationTypedAdapter } from './typed-data/credit-delegation.ts';
import { previewMessage } from './message.ts';

export const TYPED_DATA_ADAPTERS: TypedAdapter[] = [hyperliquidL1Adapter, hyperliquidUserSignedAdapter, eip3009Adapter, creditDelegationTypedAdapter, permitAdapter, genericTypedDataAdapter];

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

const SKIPPED_IN_BATCH = "This call was not simulated: it may depend on the calls before it, and the simulator (or this chain's RPC) can only check one call at a time.";

/**
 * EIP-5792 wallet_sendCalls: preview each call, then summarise. Calls are simulated in order in one block, so a
 * call sees what the earlier ones did (an approval before a swap). Simulating them one by one would show the swap
 * as failing.
 */
async function previewBatch(raw: unknown, context: PreviewContext, deps: Dependencies): Promise<Preview> {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as Record<string, unknown>).calls)) throw new RequestError('wallet_sendCalls needs { calls: [...] }');
  const batch = raw as { chainId?: string; from?: string; atomicRequired?: boolean; calls: unknown[] };
  if (batch.calls.length === 0 || batch.calls.length > 32) throw new RequestError('wallet_sendCalls must contain 1 to 32 calls');
  const chainId = batch.chainId !== undefined ? Number(BigInt(batch.chainId)) : context.chainId;
  const txs = batch.calls.map(call => normalizeTransaction(call, context, batch.from, chainId));

  // Simulate the whole batch in order when the simulator can; otherwise only the first call is independent.
  let presets: (PresetSimulation | undefined)[] = txs.map(() => undefined);
  let results: SimulationResult[] | null = null;
  const sameChain = txs.every(t => t.chainId === txs[0].chainId);
  if (deps.simulator && txs.length > 1) {
    if (deps.simulator.simulateBatch && sameChain) {
      try {
        results = await deps.simulator.simulateBatch(txs.map(simulationRequest));
        if (results && results.length !== txs.length) throw new Error(`the simulator returned ${results.length} results for ${txs.length} calls`);
        presets = txs.map((_, i) => ({ result: results?.[i] ?? null }));
      } catch (error) {
        results = null;
        presets = (error as Error)?.name === 'BatchSimulationUnsupported'
          ? txs.map((_, i) => (i === 0 ? undefined : { skipped: SKIPPED_IN_BATCH })) // e.g. HyperEVM: eth_call can check call 1 alone
          : txs.map(() => ({ error: error instanceof Error ? error.message : String(error) }));
      }
    } else {
      presets = txs.map((_, i) => (i === 0 ? undefined : { skipped: SKIPPED_IN_BATCH }));
    }
  }
  const calls: Preview[] = [];
  for (const [i, tx] of txs.entries()) calls.push(await previewTransaction(tx, deps, context, 'wallet_sendCalls', presets[i]));

  const b = new PreviewBuilder();
  let assetChanges: AssetChange[] = calls.flatMap(c => c.assetChanges);
  let approvals: ApprovalChange[] = [];
  let simulation: SimulationSummary | undefined;
  if (results) {
    const failed = results.findIndex(r => r.status === 'reverted');
    const gasUsed = results.reduce((sum, r) => sum + (r.gasUsed ?? 0n), 0n);
    simulation = { status: failed === -1 ? 'success' : 'reverted', source: `${results[0].source}, ${results.length} calls in order`, gasUsed: gasUsed.toString(),
      ...(failed !== -1 && results[failed].revertReason && { revertReason: `call ${failed + 1}: ${results[failed].revertReason}` }) };
    b.note('The calls were simulated in order in one block, each seeing the effects of the calls before it.');
    if (failed === -1) {
      // Net across the batch: an intermediate token received by one call and spent by the next nets out, and an
      // approval used up or revoked by a later call shows its final state. (Each call's warnings already cover
      // approvals set along the way.)
      if (txs.every(t => t.from === txs[0].from)) {
        assetChanges = [...await netChanges(results.flatMap(r => r.transfers), txs[0], deps, b), ...await nftChanges(results.flatMap(r => r.nftTransfers ?? []), txs[0], deps, b)];
        // The state read after the last call covers every permission touched by the batch.
        approvals = await approvalChanges(results.flatMap((r, i) => (r.approvals ?? []).map(approval => ({ approval, callTo: txs[i].to }))), txs[0], deps, results[results.length - 1].approvalState);
      }
    } else if (batch.atomicRequired) {
      b.warn('danger', 'batch_will_fail', `This batch is all-or-nothing, and call ${failed + 1} is expected to fail, so none of the calls would take effect. You would still pay the network fee.`);
    } else {
      b.warn('caution', 'batch_partial_failure', `Call ${failed + 1} is expected to fail. The batch is not marked all-or-nothing, so the wallet may still carry out the other calls, leaving them in effect without it.`);
    }
  }
  const warnings: Warning[] = [...b.warnings, ...calls.flatMap((c, i) => c.warnings.map(w => ({ ...w, message: `Call ${i + 1}: ${w.message}` })))];
  const statuses = calls.map(c => c.decoding.status);
  return {
    schema: 'signing-preview/1', method: 'wallet_sendCalls', kind: 'batch',
    network: chainId ? { kind: 'evm', chainId, name: chainName(chainId) } : null,
    title: calls.length === 1 ? calls[0].title : `${calls.length} actions: ${calls.map(c => c.title).join(' → ')}`,
    summary: `Runs ${calls.length} call${calls.length === 1 ? '' : 's'} in order${batch.atomicRequired ? ', all or nothing' : ''}. ${calls.map((c, i) => `(${i + 1}) ${c.summary}`).join(' ')}`,
    details: [], assetChanges, ...(approvals.length ? { approvals } : {}), warnings, attention: attentionOf(warnings),
    decoding: { status: statuses.every(s => s === 'full') ? 'full' : statuses.every(s => s === 'opaque') ? 'opaque' : 'partial', decoder: 'batch', notes: b.notes },
    ...(simulation && { simulation }),
    calls,
  };
}
