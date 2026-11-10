import { attentionOf, PreviewBuilder } from './format.ts';
import { chainName } from './chains.ts';
import type { ApprovalChange, AssetChange, Dependencies, Preview, PreviewContext, SigningRequest, SimulationRequest, SimulationResult, SimulationSummary, Warning } from './types.ts';
import { decodeTransaction, normalizeTransaction, previewTransaction, RequestError, simulationNote, simulationRequest, type PresetSimulation } from './evm/transaction.ts';
import { expectedGasPrice } from './evm/tx-checks.ts';
import { blockText, namedBlock, parseBlock, pinLatest, type Pinned } from './block.ts';
import { addUsdValues } from './prices.ts';
import { noTrace, tracePreviews, type TraceEnv } from './evm/trace.ts';
import type { Decoded } from './evm/common.ts';
import { approvalChanges, effectOf, netChanges, nftChanges, pricedNote, roomFor } from './evm/effects.ts';
import { parseTypedData, typedDataDigest, type TypedAdapter } from './typed-data/common.ts';
import { hyperliquidL1Adapter, hyperliquidUserSignedAdapter } from './typed-data/hyperliquid.ts';
import { genericTypedDataAdapter, permitAdapter } from './typed-data/permit.ts';
import { eip3009Adapter } from './typed-data/eip3009.ts';
import { userOperationAdapter } from './typed-data/user-operation.ts';
import { seaportAdapter } from './typed-data/seaport.ts';
import { safeTxAdapter } from './typed-data/safe.ts';
import { cowOrderAdapter, oneInchOrderAdapter } from './typed-data/orders.ts';
import { creditDelegationTypedAdapter } from './typed-data/credit-delegation.ts';
import { previewMessage } from './message.ts';
import { previewSignedOperation } from './userop-hash.ts';

export const TYPED_DATA_ADAPTERS: TypedAdapter[] = [hyperliquidL1Adapter, hyperliquidUserSignedAdapter, eip3009Adapter, creditDelegationTypedAdapter, userOperationAdapter, safeTxAdapter, seaportAdapter, cowOrderAdapter, oneInchOrderAdapter, permitAdapter, genericTypedDataAdapter];

/** Methods that ask the user to sign something. Everything else passes through an interceptor untouched. */
export const SIGNING_METHODS = ['eth_sendTransaction', 'eth_signTransaction', 'wallet_sendCalls', 'eth_signTypedData_v4', 'eth_signTypedData_v3', 'eth_signTypedData', 'personal_sign', 'eth_sign'] as const;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Turns any EIP-1193 signing request into a human-readable Preview.
 * Throws RequestError (code INVALID_REQUEST) when the request is malformed.
 */
export async function previewRequest(request: SigningRequest, context: PreviewContext = {}, deps: Dependencies = {}): Promise<Preview> {
  // A past block named for the simulation (PreviewContext.block) is read once, by whichever simulation needs it first.
  let ctx = context;
  if (context.block !== undefined && !context.replay) {
    try { parseBlock(context.block); } catch (e) { throw new RequestError(`context: ${(e as Error).message}`); }
    ctx = { ...context, pinned: new Map<number, Promise<Pinned>>() };
  }
  const preview = await previewOf(request, ctx, deps);
  // Prices as of then: a replay's block, or the block named.
  let when = context.replay?.when;
  if (ctx.pinned) {
    const pinned = preview.network?.kind === 'evm' ? await ctx.pinned.get(preview.network.chainId)?.catch(() => undefined) : undefined;
    if (pinned) when = { block: pinned.at.block, time: pinned.time };
    // Only transactions and batches are simulated on a named block.
    else if (preview.kind === 'typed_data' || preview.kind === 'message') preview.decoding.notes.push('A past block (context.block) applies to transactions and batches: this request was previewed against the latest block.');
  }
  // What the balance changes are worth (now, or then), where the dependencies have prices (src/prices.ts).
  return addUsdValues(preview, deps, when);
}

async function previewOf(request: SigningRequest, context: PreviewContext, deps: Dependencies): Promise<Preview> {
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
      return await previewSignedOperation(method, params, context, deps) ?? previewMessage(method, params, context);
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
    ...(d.b.trace && { trace: d.b.trace }),
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
  // Decoded first: decoders name tokens the calls change without mentioning them, which state-reading simulators need.
  const decoded: Decoded[] = [];
  for (const tx of txs) decoded.push(await decodeTransaction(tx, deps, context));

  // Simulate the whole batch in order when the simulator can; otherwise only the first call is independent.
  let presets: (PresetSimulation | undefined)[] = txs.map(() => undefined);
  let results: SimulationResult[] | null = null;
  let priced: { gasPrice: bigint; tip: bigint } | undefined;
  // What was simulated for the results shown, for tracing them.
  let ran: SimulationRequest[] | undefined;
  let named: Pinned | undefined;
  const sameChain = txs.every(t => t.chainId === txs[0].chainId);
  if (deps.simulator && txs.length > 1) {
    if (deps.simulator.simulateBatch && sameChain) {
      try {
        // For a trace, the block is named, so that the tracing run is of the same one (src/block.ts).
        named = await namedBlock(context, deps.rpc, txs[0].chainId);
        const at = named?.at ?? (context.trace ? await pinLatest(deps.rpc, txs[0].chainId) : undefined);
        const requests = txs.map((tx, i) => ({ ...simulationRequest(tx, decoded[i]), ...(at && { at }) }));
        ran = requests;
        results = await deps.simulator.simulateBatch(requests);
        if (results && results.length !== txs.length) throw new Error(`the simulator returned ${results.length} results for ${txs.length} calls`);
        // Once more at the price the batch would pay now, as a single transaction is (src/evm/transaction.ts): if
        // that changes what a call does, the priced run is the one shown.
        if (results?.every(r => r.status === 'success' && !r.limited && r.gasUsed !== undefined)) {
          try {
            const price = await expectedGasPrice(txs[0], deps, named?.at.header.baseFeePerGas);
            const pricedRequests = requests.map((q, i) => ({ ...q, gas: txs[i].gas ?? roomFor(results![i].gasUsed!), gasPrice: price?.gasPrice, baseFee: price?.baseFee }));
            const again = price && await deps.simulator.simulateBatch(pricedRequests);
            if (price && again && again.length === txs.length && again.some((r, i) => effectOf(r, txs[i].from) !== effectOf(results![i], txs[i].from))) { results = again; priced = price; ran = pricedRequests; }
          } catch { /* the node refused the priced run: the first stands */ }
        }
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
  for (const [i, tx] of txs.entries()) calls.push(await previewTransaction(tx, deps, context, 'wallet_sendCalls', presets[i], decoded[i]));
  // Each call's trace (PreviewContext.trace), from the calls run in order where they can be traced.
  let untraced: string | undefined;
  if (context.trace && results && ran) {
    const env: TraceEnv = { chainId: txs[0].chainId, account: txs[0].from, deps };
    const traces = await tracePreviews(ran, results, env);
    for (const [i, t] of (traces ?? []).entries()) if (t) calls[i].trace = t;
    if (!traces) untraced = noTrace(env);
  }

  const b = new PreviewBuilder();
  let assetChanges: AssetChange[] = calls.flatMap(c => c.assetChanges);
  let approvals: ApprovalChange[] = [];
  let simulation: SimulationSummary | undefined;
  if (results) {
    const failed = results.findIndex(r => r.status === 'reverted');
    const gasUsed = results.reduce((sum, r) => sum + (r.gasUsed ?? 0n), 0n);
    simulation = { status: failed === -1 ? 'success' : 'reverted', source: `${results[0].source}, ${results.length} calls in order`, gasUsed: gasUsed.toString(),
      ...(failed !== -1 && results[failed].revertReason && { revertReason: `call ${failed + 1}: ${results[failed].revertReason}` }), ...(named && { block: named.number.toString() }) };
    b.note('The calls were simulated in order in one block, each seeing the effects of the calls before it.');
    if (named) b.note(`Simulated on the state after ${blockText(named.number, named.time)}, in the block that followed: what the calls would have done then, not now.`);
    if (untraced) b.note(untraced);
    if (priced) b.note(pricedNote('calls', priced));
    if (results[0].basis === 'state' || results[0].basis === 'fork' || results.some(r => r.balancesRead)) b.note(simulationNote({ basis: results[0].basis, tokensRead: Math.max(...results.map(r => r.tokensRead ?? 0)), balancesRead: results.some(r => r.balancesRead) }));
    if (failed === -1) {
      // Net across the batch: an intermediate token received by one call and spent by the next nets out, and an
      // approval used up or revoked by a later call shows its final state. (Each call's warnings already cover
      // approvals set along the way.)
      if (txs.every(t => t.from === txs[0].from)) {
        const basis = results[0].basis === 'state' || results[0].basis === 'fork' || results.every(r => r.balancesRead) ? 'simulated_state' as const : 'simulated_events' as const;
        assetChanges = [...await netChanges(results.flatMap(r => r.transfers), txs[0], deps, b, basis), ...await nftChanges(results.flatMap(r => r.nftTransfers ?? []), txs[0], deps, b, basis)];
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
