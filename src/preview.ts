import { attentionOf, PreviewBuilder, sameAddress, shortAddress } from './format.ts';
import { chainName } from './chains.ts';
import type { ApprovalChange, AssetChange, Dependencies, Preview, PreviewContext, SigningRequest, SimulationRequest, SimulationResult, SimulationSummary, Warning } from './types.ts';
import { accountApprovalWarnings, decodeTransaction, forAccount, normalizeTransaction, standInsNote, previewTransaction, RequestError, simulationNote, simulationRequest, type PresetSimulation, normalizeOverrides, overriddenWarning } from './evm/transaction.ts';
import { expectedGasPrice } from './evm/tx-checks.ts';
import { blockText, namedBlock, parseBlock, pinLatest, type Pinned } from './block.ts';
import { decodeRevert } from './simulation.ts';
import { addUsdValues } from './prices.ts';
import { noTrace, tracePreviews, type TraceEnv } from './evm/trace.ts';
import type { Decoded } from './evm/common.ts';
import { approvalChanges, approvalWarnings, effectOf, netChanges, nftChanges, pricedNote, roomFor } from './evm/effects.ts';
import { simulatedCoreActions } from './evm/hyperliquid.ts';
import { parseTypedData, typedDataDigest, type TypedAdapter } from './typed-data/common.ts';
import { hyperliquidL1Adapter, hyperliquidUserSignedAdapter } from './typed-data/hyperliquid.ts';
import { genericTypedDataAdapter, permitAdapter } from './typed-data/permit.ts';
import { eip3009Adapter } from './typed-data/eip3009.ts';
import { userOperationAdapter } from './typed-data/user-operation.ts';
import { seaportAdapter } from './typed-data/seaport.ts';
import { safeTxAdapter } from './typed-data/safe.ts';
import { cowOrderAdapter, veloraDeltaAdapter, oneInchOrderAdapter } from './typed-data/orders.ts';
import { creditDelegationTypedAdapter } from './typed-data/credit-delegation.ts';
import { kernelEnableAdapter } from './typed-data/kernel-enable.ts';
import { delegationAdapter } from './typed-data/delegation.ts';
import { spendPermissionAdapter } from './typed-data/spend-permission.ts';
import { polymarketAdapter } from './typed-data/polymarket.ts';
import { morphoAuthorizationAdapter } from './typed-data/morpho.ts';
import { cometAuthorizationAdapter } from './typed-data/comet.ts';
import { snapshotAdapter } from './typed-data/snapshot.ts';
import { governanceAdapter } from './typed-data/governance.ts';
import { relayMulticallAdapter } from './typed-data/relay.ts';
import { previewMessage } from './message.ts';
import { readAttribution } from './attribution.ts';
import { previewSignedOperation } from './userop-hash.ts';
import { previewSupertransaction, previewTypedSupertransaction } from './supertransaction.ts';
import { previewPermissionRequests } from './permissions.ts';
import { metaTransactionAdapter } from './typed-data/meta-transaction.ts';
import { authorizedExecutionsAdapter } from './typed-data/authorized-executions.ts';
import { walletCoreSessionAdapter } from './typed-data/wallet-core-session.ts';
import { caliburSignedBatchAdapter } from './typed-data/calibur.ts';
import { CALIBUR_CODES } from './evm/smart-account.ts';
import { asOneTransaction, asOneTransactionOfPlain, failedCall } from './evm/one-transaction.ts';

export const TYPED_DATA_ADAPTERS: TypedAdapter[] = [hyperliquidL1Adapter, hyperliquidUserSignedAdapter, eip3009Adapter, creditDelegationTypedAdapter, userOperationAdapter, safeTxAdapter, seaportAdapter, cowOrderAdapter, oneInchOrderAdapter, veloraDeltaAdapter, permitAdapter, kernelEnableAdapter, delegationAdapter, spendPermissionAdapter, polymarketAdapter, morphoAuthorizationAdapter, cometAuthorizationAdapter, snapshotAdapter, governanceAdapter, relayMulticallAdapter, metaTransactionAdapter, authorizedExecutionsAdapter, caliburSignedBatchAdapter, walletCoreSessionAdapter, genericTypedDataAdapter];

/** Methods that ask the user to sign something. Everything else passes through an interceptor untouched. */
export const SIGNING_METHODS = ['eth_sendTransaction', 'eth_signTransaction', 'wallet_sendCalls', 'eth_signTypedData_v4', 'eth_signTypedData_v3', 'eth_signTypedData', 'personal_sign', 'eth_sign', 'wallet_requestExecutionPermissions'] as const;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Turns any EIP-1193 signing request into a human-readable Preview.
 * Throws RequestError (code INVALID_REQUEST) when the request is malformed.
 */
export async function previewRequest(request: SigningRequest, context: PreviewContext = {}, deps: Dependencies = {}): Promise<Preview> {
  // A past block named for the simulation (PreviewContext.block) is read once, by whichever simulation needs it first.
  let ctx = context;
  // State the caller sets for the simulation: checked once, here.
  if (context.stateOverrides !== undefined) ctx = { ...ctx, stateOverrides: normalizeOverrides(context.stateOverrides) };
  if (context.block !== undefined && !context.replay) {
    try { parseBlock(context.block); } catch (e) { throw new RequestError(`context: ${(e as Error).message}`); }
    ctx = { ...ctx, pinned: new Map<number, Promise<Pinned>>() };
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
  // State overrides reach whatever a preview simulates: transactions and batches, and the UserOperations, SafeOps and
  // Safe transactions a signature authorizes (each says so with its 'state_overridden' caution). Anything else signed
  // isn't simulated, and nothing here was simulated with them.
  if (ctx.stateOverrides && (preview.kind === 'typed_data' || preview.kind === 'message') && !preview.warnings.some(w => w.code === 'state_overridden')) preview.decoding.notes.push('State overrides (context.stateOverrides) apply to what a preview simulates (transactions, batches, and the UserOperations, SafeOps and Safe transactions a signature authorizes), and nothing in this request was simulated with them: it was previewed against the chain\'s own state.');
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
    case 'wallet_requestExecutionPermissions':
      // ERC-7715: permissions granted by a delegation the wallet signs (src/permissions.ts).
      return previewPermissionRequests(method, params, context, deps);
    case 'personal_sign':
    case 'eth_sign':
      // A supertransaction's hash, with its operations (context.meeOperations); an operation's own hash (context.userOperation).
      return await previewSupertransaction(method, params, context, deps) ?? await previewSignedOperation(method, params, context, deps) ?? previewMessage(method, params, context);
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
  // A Biconomy MEE 3 supertransaction (src/supertransaction.ts), previewed with the operations it covers.
  const superTx = await previewTypedSupertransaction(method, data, env.signer, context, deps);
  if (superTx) return superTx;
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
    title: d.title, summary: d.summary, details: d.b.details, assetChanges: d.assetChanges ?? [], ...(d.approvals?.length && { approvals: d.approvals }), warnings: d.b.warnings, attention: attentionOf(d.b.warnings),
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
export async function previewBatch(raw: unknown, context: PreviewContext, deps: Dependencies): Promise<Preview> {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as Record<string, unknown>).calls)) throw new RequestError('wallet_sendCalls needs { calls: [...] }');
  const batch = raw as { chainId?: string; from?: string; atomicRequired?: boolean; calls: unknown[]; capabilities?: { dataSuffix?: { value?: unknown; optional?: boolean } } };
  if (batch.calls.length === 0 || batch.calls.length > 32) throw new RequestError('wallet_sendCalls must contain 1 to 32 calls');
  const chainId = batch.chainId !== undefined ? Number(BigInt(batch.chainId)) : context.chainId;
  // The dataSuffix capability (as viem sends a client's data suffix, ERC-8021 attributions among them): bytes a wallet
  // that supports it appends to each call's data, which the calls are previewed and simulated with.
  const suffix = batch.capabilities?.dataSuffix?.value;
  if (suffix !== undefined && (typeof suffix !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(suffix) || suffix.length > 2 + 2 * 1024)) throw new RequestError('capabilities.dataSuffix.value must be hex bytes (at most 1,024)');
  const given = batch.calls.map(call => normalizeTransaction(call, context, batch.from, chainId));
  // A call to the zero address with calldata. An account whose code follows ERC-7821 runs it as a call to itself
  // ("to: replaced with address(this) if address(0)"), which Calibur does: sent so, a key registered on the account
  // read "Call contract 0x0000…". Where the sender runs Calibur it is read, and simulated, as the call to the account
  // it is; where its code isn't known to take it so, it is said that it may be one.
  const toZero = given.flatMap((t, i) => (t.to && /^0x0{40}$/.test(t.to) && t.data.length >= 10 ? [i] : []));
  let zeroIsSelf = false;
  if (toZero.length && deps.rpc?.has(given[0].chainId)) {
    const code = await deps.rpc.call(given[0].chainId, 'eth_getCode', [given[0].from, 'latest']).catch(() => undefined);
    zeroIsSelf = typeof code === 'string' && code.toLowerCase().startsWith('0xef0100') && !!CALIBUR_CODES[`0x${code.slice(8, 48)}`.toLowerCase()];
  }
  if (zeroIsSelf) for (const i of toZero) given[i] = { ...given[i], to: given[i].from };
  // Appended only to a call with data, as viem does: a plain transfer stays one. Decoded as the wallet sends it (an
  // ERC-8021 attribution is read past, src/evm/transaction.ts; other bytes can be the call's own arguments).
  const txs = given.map(tx => suffix && suffix !== '0x' && tx.to && tx.data !== '0x' ? { ...tx, data: `${tx.data}${suffix.slice(2).toLowerCase()}` as `0x${string}` } : tx);
  // Decoded first: decoders name tokens the calls change without mentioning them, which state-reading simulators need.
  const decoded: Decoded[] = [];
  // (Where a call with the suffix reads as nothing, as a strict ABI decoder may, it is read as the dApp gave it.)
  for (const [i, tx] of txs.entries()) {
    const d = await decodeTransaction(tx, deps, context);
    decoded.push(d.status === 'opaque' && tx !== given[i] ? await decodeTransaction(given[i], deps, context).then(g => g.status === 'opaque' ? d : g) : d);
  }

  // The accounts the calls have act in the sender's place or hand calls on to (Decoded.account, Decoded.actors).
  const acting = [...new Set(decoded.flatMap(d => [...(d.account ? [d.account] : []), ...(d.actors ?? [])]).map(a => a.toLowerCase()))].filter(a => !txs.some(t => t.from.toLowerCase() === a));
  // Simulate the whole batch in order when the simulator can; otherwise only the first call is independent.
  let presets: (PresetSimulation | undefined)[] = txs.map(() => undefined);
  let results: SimulationResult[] | null = null;
  let priced: { gasPrice: bigint; tip: bigint } | undefined;
  // What was simulated for the results shown, for tracing them.
  let ran: SimulationRequest[] | undefined;
  // The calls run as one transaction, where that is what the sender's code makes of them and they go through so
  // (src/evm/one-transaction.ts): its result, and which call failed run one transaction each, and why.
  let whole: { result: SimulationResult; failed: number; reason?: string; plain?: boolean } | undefined;
  // An all-or-nothing batch of a plain account's, whose calls go through a transaction each and fail as the one
  // transaction a wallet makes of them (the account given code, EIP-7702): which call, and why.
  let asOneFails: { call?: number; reason?: string } | undefined;
  let named: Pinned | undefined;
  const sameChain = txs.every(t => t.chainId === txs[0].chainId);
  if (deps.simulator && txs.length > 1) {
    if (deps.simulator.simulateBatch && sameChain) {
      try {
        // For a trace, the block is named, so that the tracing run is of the same one (src/block.ts).
        named = await namedBlock(context, deps.rpc, txs[0].chainId);
        const at = named?.at ?? (context.trace ? await pinLatest(deps.rpc, txs[0].chainId) : undefined);
        const requests = txs.map((tx, i) => ({ ...simulationRequest(tx, decoded[i]), ...(at && { at }), ...(context.stateOverrides && { stateOverrides: context.stateOverrides }) }));
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
            // (Not a priced run whose balances couldn't be read, where the first run's were: what differs may be only
            // that. Nor one with a call refused before it ran, as a single transaction's isn't: a batch from an
            // account with no coin for the fee, which a relayer or a paymaster pays, was shown failing.)
            const unread = again?.some((r, i) => (r.stateReadError && !results![i].stateReadError) || r.refused || r.limited);
            // (What it does for the accounts the calls have act counts as what it does for the sender: by the runs' events.)
            const parties = (i: number) => [txs[i].from, ...acting];
            if (price && again && again.length === txs.length && !unread && again.some((r, i) => parties(i).some(account => effectOf(r, account) !== effectOf(results![i], account)))) { results = again; priced = price; ran = pricedRequests; }
          } catch { /* the node refused the priced run: the first stands */ }
        }
        // A batch an account with code runs is one transaction, and what a call leaves for the transaction's length
        // the next one finds: where a call fails run one transaction each, they are run as the one they are.
        const failing = results?.findIndex(r => r.status === 'reverted') ?? -1;
        // A plain account (no code) sends its calls a transaction each, as they were run above, unless the batch
        // must be all or nothing: a wallet makes that of them by giving the account code (EIP-7702) and running
        // them as one transaction. So such a batch is run as one too, on a stand-in for that code: where it fails
        // a transaction each and goes through as one, the one is what it does; where it goes through a transaction
        // each and fails as one (a contract that takes no caller with code), that is said.
        if (results && (failing !== -1 || batch.atomicRequired) && txs.every(t => t.to && t.from === txs[0].from) && deps.rpc?.has(txs[0].chainId)) {
          try {
            // (As the run has it: on the block it is of, and what the caller's state overrides put there.)
            const given = Object.entries(context.stateOverrides ?? {}).find(([address]) => address.toLowerCase() === txs[0].from.toLowerCase())?.[1]?.code;
            const code = given ?? await deps.rpc.call(txs[0].chainId, 'eth_getCode', [txs[0].from, named ? `0x${named.number.toString(16)}` : 'latest']);
            const plain = code === '0x';
            const one = typeof code !== 'string' ? null : !plain ? (failing !== -1 ? asOneTransaction(txs[0].from, code, txs) : null) : batch.atomicRequired ? asOneTransactionOfPlain(txs[0].from, txs) : null;
            if (one) {
              const watch = [...new Set(requests.flatMap(q => q.watch ?? []))], gas = txs.every(t => t.gas !== undefined) ? txs.reduce((sum, t) => sum + t.gas!, 0n) : undefined;
              const request: SimulationRequest = { chainId: txs[0].chainId, from: txs[0].from, to: txs[0].from, data: one.data, value: 0n, ...(watch.length && { watch }), ...(gas !== undefined && { gas }), ...(at && { at }),
                stateOverrides: { ...context.stateOverrides, ...one.overrides, [txs[0].from.toLowerCase()]: { ...context.stateOverrides?.[txs[0].from.toLowerCase()], ...one.overrides[txs[0].from.toLowerCase()] } } };
              const result = await deps.simulator.simulate(request);
              if (failing !== -1) {
                if (result?.status === 'success' && !result.limited && !result.refused) {
                  whole = { result, failed: failing, reason: results[failing].revertReason, ...(plain && { plain }) }; ran = [request];
                  // Once more at the price it would pay now, as the calls in order are: shown where that changes what it does.
                  if (result.gasUsed !== undefined) try {
                    const price = await expectedGasPrice(txs[0], deps, named?.at.header.baseFeePerGas);
                    const at_ = price && { ...request, gas: gas ?? roomFor(result.gasUsed), gasPrice: price.gasPrice, baseFee: price.baseFee };
                    const again = at_ && await deps.simulator.simulate(at_);
                    if (price && at_ && again?.status === 'success' && !again.limited && !again.refused && !(again.stateReadError && !result.stateReadError) && [txs[0].from, ...acting].some(account => effectOf(again, account) !== effectOf(result, account))) { whole = { ...whole, result: again }; priced = price; ran = [at_]; }
                  } catch { /* the node refused the priced run: the first stands */ }
                }
              } else if (result?.status === 'reverted' && !result.limited && !result.refused) {
                const failed = failedCall(result.returnData);
                asOneFails = { ...(failed && failed.index < txs.length && { call: failed.index + 1 }), reason: failed ? decodeRevert(failed.data) : result.revertReason };
              }
            }
          } catch { /* not run so: the calls' own results stand */ }
        }
        // (Run as one, the calls have no results of their own: each is shown as it is decoded, the batch as it ran.)
        presets = txs.map((_, i) => ({ result: whole ? null : results?.[i] ?? null }));
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
  let wholeTrace: Preview['trace'];
  if (context.trace && results && ran) {
    const env: TraceEnv = { chainId: txs[0].chainId, account: txs[0].from, deps };
    const traces = await tracePreviews(ran, whole ? [whole.result] : results, env);
    // (Run as one transaction, the trace is the batch's: the account calling itself, and each call under that.)
    if (whole) wholeTrace = traces?.[0];
    else for (const [i, t] of (traces ?? []).entries()) if (t) calls[i].trace = t;
    if (!traces) untraced = noTrace(env);
  }

  const b = new PreviewBuilder();
  if (toZero.length) {
    const which = `Call${toZero.length === 1 ? '' : 's'} ${toZero.map(i => i + 1).join(', ')}`, is = toZero.length === 1 ? 'is' : 'are';
    if (zeroIsSelf) b.note(`${which} ${is} to the zero address, which your account's code (Calibur) takes to mean the account itself: ${toZero.length === 1 ? 'it is' : 'they are'} read, and simulated, as ${toZero.length === 1 ? 'a call' : 'calls'} to your own account.`);
    else b.warn('caution', 'zero_address_call', `${which} ${is} to the zero address with calldata: a wallet whose account code follows ERC-7821 (Calibur, Porto) runs that as a call into your own account, with the account's own authority (how its keys and settings are changed); other accounts call the zero address, where nothing runs. Which this account does isn't known here.`);
  }
  if (suffix && suffix !== '0x') {
    const attribution = readAttribution(suffix);
    b.detail(attribution ? 'Attribution (ERC-8021)' : 'Data suffix', attribution ? attribution.parts.join('; ') : suffix.length > 2 + 64 ? `${suffix.slice(0, 66)}… (${(suffix.length - 2) / 2} bytes)` : suffix, suffix);
    b.note(`The dApp asks the wallet to append ${attribution ? 'an ERC-8021 attribution' : `${(suffix.length - 2) / 2} bytes`} to each call's data (the dataSuffix capability${batch.capabilities?.dataSuffix?.optional ? ', optional' : ''}): each call with data is previewed and simulated with it.`);
  }
  let assetChanges: AssetChange[] = calls.flatMap(c => c.assetChanges);
  let approvals: ApprovalChange[] = [];
  let simulation: SimulationSummary | undefined;
  if (results && whole) {
    const r = whole.result, account = txs[0];
    simulation = { status: 'success', source: `${r.source}, ${txs.length} calls as one transaction`, ...(r.gasUsed !== undefined && { gasUsed: r.gasUsed.toString() }), ...(named && { block: named.number.toString() }), ...(r.stateReadError && { stateReadError: r.stateReadError }) };
    if (whole.plain) b.note(`Run one transaction each, call ${whole.failed + 1} fails${whole.reason ? ` (${whole.reason})` : ''}. The batch is all-or-nothing, which a wallet makes of a plain account's calls by giving the account smart-account code (EIP-7702) and running them as one transaction: run so, on a stand-in for that code (which code is the wallet's choice), they all go through, a call relying on what an earlier one leaves for the length of the transaction. What is shown is of the one transaction.`);
    else b.note(`Run one transaction each, call ${whole.failed + 1} fails${whole.reason ? ` (${whole.reason})` : ''}; run as one transaction, as an account with code runs a batch, they all go through: a call relies on what an earlier one leaves for the length of the transaction. What is shown is of the one transaction, the account making the calls in order.`);
    if (named) b.note(`Simulated on the state after ${blockText(named.number, named.time)}, in the block that followed: what the calls would have done then, not now.`);
    if (context.stateOverrides) b.warn('caution', 'state_overridden', overriddenWarning(context.stateOverrides));
    if (untraced) b.note(untraced);
    if (r.basis === 'state' || r.basis === 'fork' || r.balancesRead) b.note(simulationNote({ basis: r.basis, tokensRead: r.tokensRead ?? 0, balancesRead: !!r.balancesRead }));
    const basis = r.basis === 'state' || r.basis === 'fork' || r.balancesRead ? 'simulated_state' as const : 'simulated_events' as const;
    assetChanges = [...await netChanges(r.transfers, account, deps, b, basis), ...await nftChanges(r.nftTransfers ?? [], account, deps, b, basis)];
    // (An approval a call makes on its own target is one the call names: the others were set along the way.)
    approvals = await approvalChanges((r.approvals ?? []).map(approval => ({ approval, callTo: txs.find(t => t.to?.toLowerCase() === approval.emitter.toLowerCase())?.to ?? null })), account, deps, r.approvalState);
    // Warned of as a call's own run warns: the calls have no runs of their own here, and a batch made to run as one
    // (a call that leans on what another leaves) showed no warning of an operator approval set along the way.
    const declared = decoded.flatMap(d => d.declaredApprovals ?? []);
    for (const a of approvals) if (declared.some(x => x.kind === a.kind && sameAddress(x.token, a.token) && sameAddress(x.spender, a.spender))) a.direct = true;
    approvalWarnings(b, approvals, context.now);
    if (r.coreActions?.length) await simulatedCoreActions(r.coreActions, account.from, b, { deps, context });
    if (r.rulesNote) b.note(r.rulesNote);
    if (r.standIns?.length) b.note(standInsNote(r.standIns));
    if (priced) b.note(pricedNote('calls', priced));
  } else if (results) {
    const failed = results.findIndex(r => r.status === 'reverted');
    const gasUsed = results.reduce((sum, r) => sum + (r.gasUsed ?? 0n), 0n);
    simulation = { status: failed === -1 ? 'success' : 'reverted', source: `${results[0].source}, ${results.length} calls in order`, gasUsed: gasUsed.toString(),
      ...(failed !== -1 && results[failed].revertReason && { revertReason: `call ${failed + 1}: ${results[failed].revertReason}` }), ...(named && { block: named.number.toString() }),
      ...(results[0].stateReadError && { stateReadError: results[0].stateReadError }) };
    b.note('The calls were simulated in order in one block, each seeing the effects of the calls before it.');
    if (asOneFails) b.warn('caution', 'atomic_batch_fails_as_one', `This batch is all-or-nothing, which a wallet makes of a plain account's calls by giving the account smart-account code (EIP-7702) and running them as one transaction. Run so here, on a stand-in for that code (which code is the wallet's choice), ${asOneFails.call ? `call ${asOneFails.call}` : 'a call'} fails${asOneFails.reason ? ` (${asOneFails.reason})` : ''}, and with it the whole batch: a contract can refuse or treat differently a caller that has code. What is shown is the calls run a transaction each, which go through.`);
    if (named) b.note(`Simulated on the state after ${blockText(named.number, named.time)}, in the block that followed: what the calls would have done then, not now.`);
    if (context.stateOverrides) b.warn('caution', 'state_overridden', overriddenWarning(context.stateOverrides));
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
  // A call that has another account act (src/evm/smart-account.ts, accountCallAdapter): the batch's run read the
  // sender's balances. It is read again for that account (for the first three such accounts), as a single
  // transaction's run is (src/evm/transaction.ts): its changes and the approvals it leaves, beside the sender's.
  // Where it can't be, what the call has the account move is kept as the call asks it, and that is said.
  if (results && (whole || results.every(r => r.status === 'success')) && txs.every(t => t.from === txs[0].from)) {
    const sender = txs[0].from.toLowerCase();
    const read = new Set<string>();
    for (const account of acting.slice(0, 3)) {
      const theirs = ran && deps.simulator ? await forAccount(ran, { chainId: txs[0].chainId, from: account }, deps, b, true).catch(() => null) : null;
      if (!theirs) continue;
      read.add(account);
      assetChanges = [...assetChanges, ...theirs.assetChanges];
      accountApprovalWarnings(b, theirs.approvals, account, context.now);
      approvals = [...approvals, ...theirs.approvals];
    }
    if (read.size) b.note(`The batch's run was read again for ${[...read].map(a => shortAddress(a)).join(', ')}, the account${read.size === 1 ? '' : 's'} its calls have act: ${read.size === 1 ? 'its' : 'their'} balances and approvals are what those calls change.`);
    const asked = calls.flatMap((c, i) => c.assetChanges.filter(x => x.basis === 'requested' && acting.includes(x.account.toLowerCase()) && !read.has(x.account.toLowerCase())).map(x => ({ i, x })));
    if (asked.length) {
      const which = [...new Set(asked.map(t => t.i + 1))], one = which.length === 1;
      assetChanges = [...assetChanges, ...asked.map(t => t.x)];
      b.note(`Call${one ? '' : 's'} ${which.join(', ')} ${one ? 'has' : 'have'} another account make calls: what ${one ? 'it moves' : 'they move'} for that account is shown as the call${one ? ' asks' : 's ask'}. The batch's simulation read your own account's balances, not that account's.`);
    }
  }
  // A call's own 'state_overridden' (from a run its decoder made with them, as for a Safe's execTransaction) is said
  // once, for the batch.
  if (context.stateOverrides && calls.some(c => c.warnings.some(w => w.code === 'state_overridden'))) b.warn('caution', 'state_overridden', overriddenWarning(context.stateOverrides));
  const warnings: Warning[] = [...b.warnings, ...calls.flatMap((c, i) => c.warnings.filter(w => w.code !== 'state_overridden').map(w => ({ ...w, message: `Call ${i + 1}: ${w.message}` })))];
  const statuses = calls.map(c => c.decoding.status);
  return {
    schema: 'signing-preview/1', method: 'wallet_sendCalls', kind: 'batch',
    network: chainId ? { kind: 'evm', chainId, name: chainName(chainId) } : null,
    title: calls.length === 1 ? calls[0].title : `${calls.length} actions: ${calls.map(c => c.title).join(' → ')}`,
    summary: `Runs ${calls.length} call${calls.length === 1 ? '' : 's'} in order${batch.atomicRequired ? ', all or nothing' : ''}. ${calls.map((c, i) => `(${i + 1}) ${c.summary}`).join(' ')}`,
    details: b.details, assetChanges, ...(approvals.length ? { approvals } : {}), warnings, attention: attentionOf(warnings),
    decoding: { status: statuses.every(s => s === 'full') ? 'full' : statuses.every(s => s === 'opaque') ? 'opaque' : 'partial', decoder: 'batch', notes: b.notes },
    ...(simulation && { simulation }),
    ...(wholeTrace && { trace: wholeTrace }),
    calls,
  };
}
