import { attentionOf, formatUnits, PreviewBuilder, sameAddress, shortAddress } from '../format.ts';
import { CHAINS, chainName, HYPERLIQUID } from '../chains.ts';
import type { ApprovalChange, Dependencies, Preview, PreviewContext, PreviewTrace, ReplayInfo, SimulationRequest, SimulationResult, SimulationSummary } from '../types.ts';
import { blockText, namedBlock, pinLatest, type BlockAt, type Pinned } from '../block.ts';
import { compareWithReceipt, noTrace, sameRun, tracePreviews, type TraceEnv } from './trace.ts';
import { approvalChanges, approvalWarnings, effectOf, netChanges, nftChanges, pricedNote, roomFor } from './effects.ts';
import { type Adapter, type AuthorizationRequest, type Decoded, type Tx } from './common.ts';
import { delegatedAbis, delegationEffects, ownDelegateAfter, SUPPORTS_7702 } from './eip7702.ts';
import { expectedGasPrice, transactionChecks } from './tx-checks.ts';
import { erc20Adapter, nativeAdapter, unknownCallAdapter } from './erc20.ts';
import { abiAdapter } from './abi-adapter.ts';
import { textCalldataAdapter } from './text.ts';
import { smartAccountAdapter } from './smart-account.ts';
import { entryPointAdapter } from './entry-point.ts';
import { seaportTxAdapter } from './seaport.ts';
import { safeExecAdapter } from './safe.ts';
import { seaDropAdapter } from './seadrop.ts';
import { lifiAdapter } from './lifi.ts';
import { relayAdapter } from './relay.ts';
import { binanceWalletAdapter } from './binance-wallet.ts';
import { hyperlendIsolatedAdapter } from './hyperlend-isolated.ts';
import { beaconDepositAdapter } from './beacon-deposit.ts';
import { orbitInboxAdapter } from './orbit-inbox.ts';
import { aggregatorAdapters } from './aggregators.ts';
import { uniswapForkAdapter, uniswapRoutersAdapter } from './uniswap-routers.ts';
import { universalRouterAdapter } from './universal-router.ts';
import { kinetiqAdapter } from './kinetiq.ts';
import { creditDelegationAdapter, hyperlendGatewayAdapter, hyperlendPoolAdapter } from './hyperlend.ts';
import { cctpAdapter, cctpExtensionAdapter } from './cctp.ts';
import { bridge2Adapter, coreDepositWalletAdapter, coreWriterAdapter, hyperCoreSystemTransferAdapter, simulatedCoreActions } from './hyperliquid.ts';

/** Order matters: specific routes before generic ERC-20 shapes. */
export const ADAPTERS: Adapter[] = [
  smartAccountAdapter,
  entryPointAdapter,
  seaportTxAdapter,
  safeExecAdapter,
  seaDropAdapter,
  lifiAdapter,
  relayAdapter,
  binanceWalletAdapter,
  hyperlendIsolatedAdapter,
  beaconDepositAdapter,
  orbitInboxAdapter,
  ...aggregatorAdapters,
  uniswapRoutersAdapter,
  uniswapForkAdapter,
  coreDepositWalletAdapter,
  hyperCoreSystemTransferAdapter,
  nativeAdapter,
  bridge2Adapter,
  cctpAdapter,
  cctpExtensionAdapter,
  coreWriterAdapter,
  kinetiqAdapter,
  hyperlendPoolAdapter,
  hyperlendGatewayAdapter,
  creditDelegationAdapter,
  erc20Adapter,
  universalRouterAdapter,
  abiAdapter,
  textCalldataAdapter,
  unknownCallAdapter,
];

export class RequestError extends Error {
  code = 'INVALID_REQUEST';
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX = /^0x([0-9a-fA-F]{2})*$/;

function quantity(value: unknown, field: string): bigint {
  if (value === undefined || value === null || value === '') return 0n;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value)) return BigInt(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  throw new RequestError(`${field} must be a hex or decimal quantity`);
}

/** EIP-7702 `authorizationList` entries ({ address | contractAddress, chainId, nonce, r?, s?, yParity? | v? }). */
function authorizationList(raw: unknown): AuthorizationRequest[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new RequestError('"authorizationList" must be an array');
  return raw.map((entry, i) => {
    const field = `authorizationList[${i}]`;
    if (!entry || typeof entry !== 'object') throw new RequestError(`${field} must be an object`);
    const a = entry as Record<string, unknown>;
    const address = a.address ?? a.contractAddress;
    if (typeof address !== 'string' || !ADDRESS.test(address)) throw new RequestError(`${field}.address must be an address`);
    const out: AuthorizationRequest = { address: address.toLowerCase() };
    if (a.chainId !== undefined) out.chainId = Number(quantity(a.chainId, `${field}.chainId`));
    if (a.nonce !== undefined) out.nonce = quantity(a.nonce, `${field}.nonce`);
    if (a.r !== undefined || a.s !== undefined) {
      const word = (v: unknown, k: string) => {
        if (typeof v !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(v)) throw new RequestError(`${field}.${k} must be a 32-byte hex value`);
        return `0x${v.slice(2).padStart(64, '0')}` as `0x${string}`;
      };
      // Without the parity the signer can't be recovered, and guessing could attribute your own delegation to someone else.
      if (a.yParity === undefined && a.v === undefined) throw new RequestError(`${field} is signed but has no yParity`);
      const parity = Number(quantity(a.yParity ?? a.v, `${field}.yParity`));
      const yParity = parity >= 27 ? parity - 27 : parity;
      if (yParity !== 0 && yParity !== 1) throw new RequestError(`${field}.yParity must be 0 or 1`);
      out.signature = { r: word(a.r, 'r'), s: word(a.s, 's'), yParity };
    }
    return out;
  });
}

/** Normalises one eth_sendTransaction / wallet_sendCalls call object. */
export function normalizeTransaction(raw: unknown, context: PreviewContext, fallbackFrom?: string, fallbackChainId?: number): Tx {
  if (!raw || typeof raw !== 'object') throw new RequestError('Transaction must be an object');
  const t = raw as Record<string, unknown>;
  const from = (t.from ?? fallbackFrom ?? context.account) as string | undefined;
  if (typeof from !== 'string' || !ADDRESS.test(from)) throw new RequestError('Transaction is missing a valid "from" address');
  const to = t.to === undefined || t.to === null || t.to === '' ? null : t.to;
  if (to !== null && (typeof to !== 'string' || !ADDRESS.test(to))) throw new RequestError('"to" must be an address');
  const data = (t.data ?? t.input ?? '0x') as string;
  if (typeof data !== 'string' || !HEX.test(data)) throw new RequestError('"data" must be hex bytes');
  const chainId = t.chainId !== undefined ? Number(quantity(t.chainId, 'chainId')) : fallbackChainId ?? context.chainId;
  if (!chainId) throw new RequestError('Chain ID is unknown: include chainId in the transaction or the preview context');
  const authorizations = authorizationList(t.authorizationList);
  // Optional fields the wallet may already have filled in: kept only when present.
  const optional = (field: string) => t[field] === undefined || t[field] === null || t[field] === '' ? undefined : quantity(t[field], field);
  const fees = { gas: optional('gas') ?? optional('gasLimit'), gasPrice: optional('gasPrice'), maxFeePerGas: optional('maxFeePerGas'), maxPriorityFeePerGas: optional('maxPriorityFeePerGas'), nonce: optional('nonce') };
  // An access list in the standard shape ({ address, storageKeys }[]); anything else is left out.
  const accessList = Array.isArray(t.accessList) && t.accessList.length && t.accessList.every(a => a && typeof a === 'object' && ADDRESS.test(String((a as { address?: unknown }).address)) && Array.isArray((a as { storageKeys?: unknown }).storageKeys) && ((a as { storageKeys: unknown[] }).storageKeys).every(k => typeof k === 'string' && /^0x[0-9a-fA-F]{64}$/.test(k)))
    ? (t.accessList as { address: string; storageKeys: string[] }[]).map(a => ({ address: a.address.toLowerCase(), storageKeys: a.storageKeys.map(k => k.toLowerCase()) })) : undefined;
  return { chainId, from: from.toLowerCase(), to: to ? (to as string).toLowerCase() : null, data: data.toLowerCase() as `0x${string}`, value: quantity(t.value, 'value'), ...(authorizations?.length && { authorizations }),
    ...Object.fromEntries(Object.entries(fees).filter(([, v]) => v !== undefined)), ...(accessList && { accessList }) };
}

/**
 * A simulation outcome computed by the caller, e.g. a batch simulated in order. `result: null` means not covered;
 * `skipped` explains why this call was deliberately not simulated.
 */
export type PresetSimulation = { result: SimulationResult | null } | { error: string } | { skipped: string };

/** Runs the decoders; the generic unknown-call decoder always answers, so this always resolves. */
export async function decodeTransaction(tx: Tx, deps: Dependencies, context: PreviewContext): Promise<Decoded> {
  // A call to your own account in the transaction that delegates it runs the new delegate's code: decode against that.
  const delegate = tx.to && sameAddress(tx.to, tx.from) && deps.abis ? await ownDelegateAfter(tx) : undefined;
  const env = { deps: delegate ? { ...deps, abis: delegatedAbis(deps.abis!, tx.from, delegate) } : deps, context };
  for (const adapter of ADAPTERS) {
    const result = await adapter(tx, env);
    if (result) return result;
  }
  throw new Error('no decoder answered');
}

/** `decoded`: the result of decodeTransaction when the caller already has it (batches decode before simulating). */
export async function previewTransaction(tx: Tx, deps: Dependencies, context: PreviewContext, method: string, preset?: PresetSimulation, decoded?: Decoded): Promise<Preview> {
  const d = decoded ?? await decodeTransaction(tx, deps, context);
  const b = d.b;
  if (!CHAINS[tx.chainId]) b.warn('caution', 'unsupported_chain', `Chain ${tx.chainId} is not one of the supported networks (Ethereum, Arbitrum One, HyperEVM). Token names and routes were not checked for it.`);
  if (context.account && !sameAddress(context.account, tx.from)) b.warn('danger', 'sender_mismatch', `The transaction's sender (${tx.from}) is not the connected account (${context.account}).`);
  if (context.chainId && context.chainId !== tx.chainId) b.warn('caution', 'chain_mismatch', `The transaction targets ${chainName(tx.chainId)}, but the wallet is on ${chainName(context.chainId)}.`);
  if (tx.value > 0n && tx.data !== '0x' && !['weth_deposit', 'kinetiq_stake'].includes(d.decoder)) {
    const chain = CHAINS[tx.chainId];
    b.detail('Native value attached', `${formatUnits(tx.value, chain?.nativeDecimals ?? 18)} ${chain?.nativeSymbol ?? ''}`.trim(), tx.value.toString());
  }

  // EIP-7702: the authorization list can hand the account to a contract, whatever the call itself does.
  let { title, summary } = d;
  const delegation = await delegationEffects(tx, deps, b);
  if (delegation) {
    const own = delegation.ownDelegate, nothingElse = tx.value === 0n && tx.data === '0x';
    if (own && nothingElse) {
      title = `Delegate your account to ${own.name ?? shortAddress(own.address)} (EIP-7702)`;
      summary = `Sets your account's code to delegate to ${own.address}${own.name ? ` (${own.name})` : ''}: that contract's code will run as your account.`;
    } else if (delegation.ownRevoke && nothingElse) {
      title = "Remove your account's EIP-7702 delegation";
      summary = 'Clears the code your account delegates to, so it becomes a plain account again.';
    } else {
      summary = `${summary.replace(/\.$/, '')}. It also ${delegation.clause}.`;
    }
  }

  let assetChanges = d.assetChanges;
  let approvals: ApprovalChange[] = [];
  let simulation: SimulationSummary | undefined;
  let outcome = preset;
  // What was simulated for the result shown (the wallet's pending transactions, then this one), for tracing it.
  let ran: SimulationRequest[] | undefined;
  // A replay shown as the local EVM ran it, where the node's run wasn't what the receipt says: why (see below).
  let localRun: string | undefined;
  let trace: PreviewTrace | undefined;
  // A mined transaction replayed where it ran (src/replay.ts), or a past block named for the simulation
  // (PreviewContext.block); else the latest block, named only when a trace has to run on the same one.
  const replay = context.replay;
  let named: Pinned | undefined;
  let at: BlockAt | undefined;
  let replayed: ReplayInfo | undefined;
  // Simulating without the delegation would run the call against the account's old code, so it would show nothing
  // about what the delegate does.
  // With the delegations applied as code overrides, the simulation runs the transaction as it will be: calls to the
  // account run the delegate's code. Only on chains that apply EIP-7702.
  // A batch's call, simulated with the batch on the block its context names: the same block, read once.
  if (outcome && 'result' in outcome && !replay && context.block !== undefined) named = await namedBlock(context, deps.rpc, tx.chainId)?.catch(() => undefined);
  if (!outcome && delegation && deps.simulator && !SUPPORTS_7702.has(tx.chainId)) outcome = { skipped: "This chain doesn't apply EIP-7702 authorizations, so the transaction was not simulated." };
  if (!outcome && deps.simulator) {
    try {
      const request = simulationRequest(tx, d);
      if (delegation && Object.keys(delegation.codeOverrides).length) {
        request.stateOverrides = Object.fromEntries(Object.entries(delegation.codeOverrides).map(([a, code]) => [a, { code }]));
        const signed = (tx.authorizations ?? []).filter(a => a.signature);
        const hex = (v: bigint | number) => `0x${v.toString(16)}`;
        if (signed.length) request.authorizationList = signed.map(a => ({ address: a.address, chainId: hex(a.chainId ?? tx.chainId), nonce: hex(a.nonce ?? 0n), r: a.signature!.r, s: a.signature!.s, yParity: hex(a.signature!.yParity) }));
        const unsigned = (tx.authorizations ?? []).filter(a => !a.signature);
        if (unsigned.length) request.unsignedAuthorizations = unsigned.map(a => ({ address: a.address, chainId: a.chainId ?? tx.chainId }));
        b.note('Simulated with the EIP-7702 authorizations applied: the delegated accounts run their new code.');
      }
      // A trace is run apart, in a local EVM: the block is named (the latest, and the header of the one after it), so
      // that both simulations run in the same one.
      // State the caller set for the simulation (PreviewContext.stateOverrides), under the request's own.
      if (context.stateOverrides && !replay) request.stateOverrides = withOverrides(context.stateOverrides, request.stateOverrides);
      named = replay ? undefined : await namedBlock(context, deps.rpc, tx.chainId);
      // A gas limit over the cap on ordinary gas, on Ethereum or its testnet: the block is named too, to know whether
      // its rules are Amsterdam's (see below).
      const overCap = !replay && tx.gas !== undefined && tx.gas > ORDINARY_GAS_CAP && (tx.chainId === 1 || tx.chainId === 11155111);
      at = replay?.at ?? named?.at ?? (context.trace || overCap ? await pinLatest(deps.rpc, tx.chainId) : undefined);
      if (at) request.at = at;
      // A replay runs at the price the transaction paid, after the transactions before it in its block (named with
      // the block: they run first, and only this one is reported).
      if (replay) { request.gasPrice = replay.gasPrice; request.at = { ...replay.at, before: replay.before }; if (replay.receipt.gasForL1) request.gasForL1 = replay.receipt.gasForL1; if (replay.blobVersionedHashes) { request.blobVersionedHashes = replay.blobVersionedHashes; request.maxFeePerBlobGas = replay.maxFeePerBlobGas; } }
      const pending = replay ? [] : pendingRequests(tx, context).map(p => (at ? { ...p, at } : p));
      ran = [...pending, request];
      // What the transaction would pay now (or in the block named), read while the simulation runs (see the priced run below).
      const pricing = replay ? Promise.resolve(undefined) : expectedGasPrice(tx, deps, named?.at.header.baseFeePerGas).catch(() => undefined);
      if (pending.length && deps.simulator.simulateBatch) {
        // On top of the wallet's pending transactions, in order: this one is the last call of the batch.
        const results = await deps.simulator.simulateBatch([...pending, request]);
        const failed = results ? results.slice(0, -1).findIndex(r => r.status === 'reverted') : -1;
        if (failed !== -1) b.warn('caution', 'pending_transaction_fails', `Your pending transaction #${failed + 1} is expected to fail${results![failed].revertReason ? ` (${results![failed].revertReason})` : ''}, so this one was simulated after a failed transaction.`);
        b.note(`Simulated after your ${pending.length} pending transaction${pending.length === 1 ? '' : 's'}, in order, as they will run before it.`);
        outcome = { result: results ? results[results.length - 1] : null };
      } else {
        if (pending.length) b.note("Your pending transactions couldn't be simulated before this one on this chain, so the simulation runs on the latest state without them.");
        outcome = { result: await deps.simulator.simulate(request) };
        // A replay has its receipt to go by. Where the node's run isn't what the receipt says, the local EVM runs
        // the transaction too, and if its run is what happened, it is the one shown, and the one a trace is of.
        // Two ways a node's run is known to go wrong: a block in its parent's second (BNB Chain's often are) runs
        // a second later on the node, which takes no other time, so a transaction that reads the time comes out
        // differently (the local EVM runs it at the block's own); and from Amsterdam on, a gas limit over 16,777,216
        // holds the rest back for new state, which Sepolia's node doesn't do when it simulates (a transaction that
        // failed on a 70,000,000 limit used 16,777,216 on the chain and 50,000,000 in the node's simulation).
        if (replay && outcome.result && deps.simulator.trace) {
          const nodes = compareWithReceipt(outcome.result, replay.receipt);
          // A block in its parent's second: first the node again, at the right time, with the second's earlier
          // blocks merged into one (ReplayContext.sameSecond).
          const second = !nodes.matches && replay.sameSecond ? await replay.sameSecond().catch(() => undefined) : undefined;
          const together: SimulationRequest | undefined = second && { ...request, at: { ...second.at, before: second.before } };
          const merged = together && await deps.simulator.simulate(together).catch(() => null);
          if (second && together && merged && compareWithReceipt(merged, replay.receipt).matches) {
            outcome = { result: merged }; ran = [together];
            localRun = `${SAME_SECOND} It was run instead with the ${second.before.length} transactions before it in that second (${second.blocks === 1 ? 'those of the block before and' : `those of the ${second.blocks} blocks before and`} its own block's), as one block at the block's own time on the state of block ${(second.at.header.number - 1n).toLocaleString('en-US')}, and came out as its receipt says (there the block's number reads ${second.at.header.number.toLocaleString('en-US')}).`;
          } else if (!nodes.matches) {
            const exact: SimulationRequest = replay.ownTimestamp !== undefined ? { ...request, at: { ...request.at!, header: { ...request.at!.header, ownTimestamp: replay.ownTimestamp } } } : request;
            const own = (await deps.simulator.trace([exact], { budgetMs: REPLAY_TRACE_MS }).catch(() => null))?.[0];
            if (own && compareWithReceipt(own, replay.receipt).matches) { outcome = { result: { ...own, source: LOCAL_RUN } }; ran = [exact]; localRun = replay.ownTimestamp !== undefined ? OWN_TIME : `The chain's node ran this transaction differently from its receipt (${nodes.differences!.join('; ')}). The run shown is the local EVM's, which is what the receipt says.`; }
          }
        }
      }
      // From Amsterdam on, what a gas limit holds over 16,777,216 is kept back for new state: the code has the cap
      // to run on, and a transaction that burns all its gas burns that much. Sepolia's node doesn't simulate that
      // (it gives the whole limit as ordinary gas), so for such a request the local EVM runs it too, and where the
      // two come out differently, the local EVM's run is the one shown.
      if (overCap && at?.header.amsterdam && outcome.result && deps.simulator.trace) {
        const own = (await deps.simulator.trace([...pending, request]).catch(() => null))?.at(-1);
        if (own && (!sameRun(own, outcome.result) || own.gasUsed !== outcome.result.gasUsed)) {
          outcome = { result: { ...own, source: LOCAL_RUN } };
          b.note(`The gas limit (${tx.gas!.toLocaleString('en-US')}) is over what a transaction has to run on here (${ORDINARY_GAS_CAP.toLocaleString('en-US')}): the rest only pays for new state. The chain's node doesn't simulate that and its run came out differently, so the run shown is the local EVM's.`);
        }
      }
      // Contracts read the price the transaction pays (tx.gasprice, and the base fee): a pool taxing swaps by the
      // priority fee, a refund paid at the gas price. The first run is at no price (a price needs a gas limit the
      // sender can afford, which isn't known before it); the transaction then runs again at the price it would pay
      // now, with room over the gas it used, and if that changes what it does, the priced run is the one shown.
      const first = outcome.result;
      const price = first?.status === 'success' && !first.limited && first.gasUsed !== undefined ? await pricing : undefined;
      if (first && price) {
        try {
          const priced: SimulationRequest = { ...request, gas: tx.gas ?? roomFor(first.gasUsed!), gasPrice: price.gasPrice, baseFee: price.baseFee };
          const again = pending.length && deps.simulator.simulateBatch ? (await deps.simulator.simulateBatch([...pending, priced]))?.at(-1) : await deps.simulator.simulate(priced);
          // (Not a priced run whose balances couldn't be read, where the first run's were: what differs may be only that.)
          if (again && effectOf(again, tx.from) !== effectOf(first, tx.from) && !(again.stateReadError && !first.stateReadError)) {
            outcome = { result: again };
            ran = [...pending, priced];
            b.note(pricedNote('transaction', price));
          }
        } catch { /* the node refused the priced run (the balance doesn't cover its gas, say): the first stands */ }
      }
    } catch (error) {
      outcome = { error: error instanceof Error ? error.message : String(error) };
    }
  }
  if (outcome && 'skipped' in outcome) {
    simulation = { status: 'unavailable', source: 'simulator', error: outcome.skipped };
    b.warn('info', 'simulation_skipped', outcome.skipped);
  } else if (outcome && 'error' in outcome) {
    simulation = { status: 'unavailable', source: 'simulator', error: outcome.error };
    b.warn('info', 'simulation_unavailable', 'The transaction could not be simulated, so balance changes are based on the decoded request only.');
  } else if (outcome?.result) {
    // A null result means this simulator does not cover the call: show the decoded request only.
    let sim = outcome.result;
    // A revert under the request's own gas limit: run it again without the limit to see whether the limit is why.
    if (sim.status === 'reverted' && tx.gas !== undefined && deps.simulator && !context.pendingTransactions?.length && !replay) {
      try {
        const unlimited = await deps.simulator.simulate({ ...simulationRequest(tx, d), gas: undefined, ...(at && { at }), ...(context.stateOverrides && { stateOverrides: context.stateOverrides }) });
        if (unlimited?.status === 'success') sim = { ...sim, revertReason: `out of gas: the gas limit (${tx.gas.toLocaleString('en-US')}) is below the ${unlimited.gasUsed !== undefined ? `${unlimited.gasUsed.toLocaleString('en-US')} gas` : 'gas'} this call needs` };
      } catch { /* keep the first answer */ }
    }
    if (context.stateOverrides && !replay && !preset) b.warn('caution', 'state_overridden', overriddenWarning(context.stateOverrides));
    const stateBlock = replay ? BigInt(replay.at.block) : named?.number;
    simulation = { status: sim.status, source: sim.source, ...(sim.gasUsed !== undefined && { gasUsed: sim.gasUsed.toString() }), ...(sim.revertReason && { revertReason: sim.revertReason }), ...(stateBlock !== undefined && { block: stateBlock.toString() }), ...(sim.stateReadError && { stateReadError: sim.stateReadError }) };
    if (sim.status === 'reverted') {
      b.warn('danger', 'simulation_reverted', replay ? `The transaction failed${sim.revertReason ? `: ${sim.revertReason}` : ''}. Its sender still paid the network fee.` : `The transaction is expected to fail${sim.revertReason ? `: ${sim.revertReason}` : ''}. You would still pay the network fee.`);
    } else if (sim.limited) {
      b.note(sim.note ?? "Checked with eth_call: the call succeeds at the latest block. This chain's RPC can't simulate transfers, so balance changes are based on the decoded request.");
    } else {
      const basis = sim.basis === 'state' || sim.basis === 'fork' || sim.balancesRead ? 'simulated_state' as const : 'simulated_events' as const;
      const simulated = [...await netChanges(sim.transfers, tx, deps, b, basis), ...await nftChanges(sim.nftTransfers ?? [], tx, deps, b, basis)];
      if (simulated.length || !assetChanges.length) assetChanges = simulated;
      approvals = await approvalChanges((sim.approvals ?? []).map(approval => ({ approval, callTo: tx.to })), tx, deps, sim.approvalState);
      // Approvals the decoded request already shows (e.g. a router's Permit2 permit step) are not hidden.
      for (const a of approvals) if (d.declaredApprovals?.some(x => x.kind === a.kind && sameAddress(x.token, a.token) && sameAddress(x.spender, a.spender))) a.direct = true;
      approvalWarnings(b, approvals, context.now);
      if (sim.coreActions?.length && !sameAddress(tx.to ?? '', HYPERLIQUID.coreWriter)) await simulatedCoreActions(sim.coreActions, tx.from, b, { deps, context });
      // A batch's call leaves the block to the batch's own note.
      b.note(replay || named ? pastNote(sim, preset ? undefined : named) : simulationNote(sim));
      // A simulation the local EVM ran itself, under rules that may not be the chain's: it says so.
      if (sim.rulesNote) b.note(sim.rulesNote);
      // And one that ran contracts the node runs itself (Base's B20 tokens) from their Solidity references.
      if (sim.standIns?.length) b.note(`The simulation ran ${sim.standIns.length === 1 ? `${sim.standIns[0]}, which this chain's node runs itself,` : `${sim.standIns.length} contracts this chain's node runs itself (${sim.standIns.join(', ')})`} from the Base Standard Library's Solidity reference, which keeps its state where the node does, charged the gas the node charges.`);
    }
    // A replay against its receipt: the same outcome, events and gas say the run shown is what happened.
    if (replay) {
      const compared = compareWithReceipt(sim, replay.receipt);
      replayed = { ...replay.info, ...compared };
      const where = `Replayed where it ran: in ${blockText(BigInt(replay.info.block), Date.parse(replay.info.time) / 1000)}, ${replay.earlier ? `after the ${replay.earlier} transaction${replay.earlier === 1 ? '' : 's'} before it in the block${replay.at.state ? " (the state they left read from the block's access list)" : ''}` : 'first in the block'}, at the price it paid.`;
      if (localRun) b.note(localRun); else if (replay.shifted) b.note(SHIFTED);
      if (compared.matches) b.note(`${where} The run has the same outcome, events and gas as its receipt.`);
      else {
        b.note(where);
        b.warn('caution', 'replay_differs', `The replay doesn't match the transaction's receipt (${compared.differences!.join('; ')}), so what is shown here may not be what happened.`);
      }
    }
  }
  if (replay && !replayed) replayed = replay.info;
  // The trace of what was shown (PreviewContext.trace): the calls the transaction makes and the state it changes.
  if (context.trace && ran && outcome && 'result' in outcome && outcome.result && !outcome.result.limited) {
    // A replay's trace runs the block's earlier transactions first, in the local EVM: it is given longer.
    const env: TraceEnv = { chainId: tx.chainId, account: tx.from, deps, ...(replay && { budgetMs: REPLAY_TRACE_MS, ...(replay.recorded && { recorded: replay.recorded }) }) };
    const traced = await tracePreviews(ran, [...ran.slice(0, -1).map(() => null), outcome.result], env);
    trace = traced?.at(-1);
    if (trace?.stateAgrees) b.note("The state the trace shows changing is what the block's access list records for this transaction: every storage slot, balance, nonce and code.");
    if (!trace) b.note(traced ? "No trace: the run that would trace this transaction didn't produce one." : noTrace(env));
  }
  // What the network checks before including it, and the fee. A batch call's fee belongs to the whole batch.
  // A replay shows what was paid instead; a past block's preview has nothing to say about inclusion now.
  if (replay) {
    if (replay.info.receipt.fee) b.detail('Network fee paid', `${replay.info.receipt.fee} (${BigInt(replay.info.receipt.gasUsed).toLocaleString('en-US')} gas)`);
  } else if (method !== 'wallet_sendCalls' && context.block === undefined) {
    const gasUsed = outcome && 'result' in outcome && outcome.result ? outcome.result.gasUsed : undefined;
    try { await transactionChecks(tx, gasUsed, deps, context, b); } catch { /* no checks */ }
  }
  return {
    schema: 'signing-preview/1', method, kind: 'transaction',
    network: { kind: 'evm', chainId: tx.chainId, name: chainName(tx.chainId) },
    title, summary, details: b.details, assetChanges, ...(approvals.length ? { approvals } : {}), warnings: b.warnings, attention: attentionOf(b.warnings),
    decoding: { status: d.status, decoder: d.decoder, notes: b.notes },
    ...(simulation && { simulation }),
    ...((trace ?? b.trace) && { trace: trace ?? b.trace }),
    ...(replayed && { replay: replayed }),
  };
}

/** A simulated block given a later second than the real one had (src/block.ts, afterParent). */
const SAME_SECOND = "The block shares its second with the one before it, which this chain's node won't simulate: run a second later there, the transaction didn't come out as its receipt says.";
const OWN_TIME = "The block shares its second with the one before it, which this chain's node won't simulate: run a second later there, the transaction didn't come out as its receipt says. The run shown is the local EVM's, at the block's own time.";
/** EIP-7825: the most ordinary gas one transaction has; from Amsterdam on, what its gas limit holds beyond pays for new state only. */
const ORDINARY_GAS_CAP = 16_777_216n;
/** What ran a simulation shown in place of the node's (the local EVM's own source says the RPC has no eth_simulateV1, which isn't why here). */
const LOCAL_RUN = "the local EVM, over the chain's state";
const SHIFTED = "The block shares its second with the one before it, which this chain's node won't simulate: it was run one second later than it was, so anything that reads the block's time saw a second more.";

/** How long a replay's tracing run may take: it runs the block's earlier transactions too. */
const REPLAY_TRACE_MS = 60_000;

/** The note for a simulation on a past block's state: a block the context names, or (without one) a replay's. */
function pastNote(sim: Pick<SimulationResult, 'basis' | 'balancesRead'>, named: Pinned | undefined): string {
  const how = sim.basis === 'state' || sim.basis === 'fork' || sim.balancesRead ? 'Balance changes were read from the state before and after.' : 'Balance changes are derived from transfer events.';
  return named
    ? `Simulated on the state after ${blockText(named.number, named.time)}, as the first transaction of the block that followed: what it would have done then, not now. ${how} The decoder's own lookups (names, balances and positions it describes) are of the latest block.${named.shifted ? ` ${SHIFTED}` : ''}`
    : how;
}

/** The simulation request for a call, with the tokens its decoder knows it changes (for state-reading simulators). */
export function simulationRequest(tx: Tx, d?: Decoded): SimulationRequest {
  const watch = new Set<string>(d?.watch ?? []);
  for (const c of d?.assetChanges ?? []) if (/^0x[0-9a-fA-F]{40}$/.test(c.asset ?? '')) watch.add(c.asset!.toLowerCase());
  for (const a of d?.declaredApprovals ?? []) { watch.add(a.token.toLowerCase()); watch.add(a.spender.toLowerCase()); }
  // The request's gas limit, so a limit too low for the call shows as running out of gas.
  return { chainId: tx.chainId, from: tx.from, to: tx.to, data: tx.data, value: tx.value, ...(watch.size && { watch: [...watch] }), ...(tx.gas !== undefined && { gas: tx.gas }), ...(tx.accessList && { accessList: tx.accessList }) };
}

/**
 * State overrides as a caller gives them (PreviewContext.stateOverrides), checked and in the form simulators take:
 * lowercase addresses, a hex balance, hex code, 32-byte slots and values. Throws RequestError when malformed.
 */
export function normalizeOverrides(raw: unknown): NonNullable<SimulationRequest['stateOverrides']> {
  const bad = (what: string): never => { throw new RequestError(`context.stateOverrides: ${what}`); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad('must be an object keyed by address');
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > 32) bad('at most 32 accounts');
  const word = (v: unknown, what: string) => (typeof v === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(v) ? `0x${v.slice(2).toLowerCase().padStart(64, '0')}` : bad(`${what} must be hex of at most 32 bytes`));
  const out: NonNullable<SimulationRequest['stateOverrides']> = {};
  for (const [address, value] of entries) {
    if (!ADDRESS.test(address)) bad(`"${address.slice(0, 50)}" is not an address`);
    if (!value || typeof value !== 'object' || Array.isArray(value)) bad(`${address} must be an object`);
    const o = value as Record<string, unknown>, entry: NonNullable<SimulationRequest['stateOverrides']>[string] = {};
    for (const key of Object.keys(o)) if (!['balance', 'code', 'stateDiff'].includes(key)) bad(`${address}.${key} isn't something that can be set (balance, code, stateDiff)`);
    if (o.balance !== undefined) {
      if (typeof o.balance !== 'string' || !/^(0x[0-9a-fA-F]{1,64}|[0-9]{1,78})$/.test(o.balance)) bad(`${address}.balance must be an amount in wei (hex, or a decimal string)`);
      entry.balance = `0x${BigInt(o.balance as string).toString(16)}`;
    }
    if (o.code !== undefined) {
      if (typeof o.code !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(o.code) || o.code.length > 2 + 2 * 24_576) bad(`${address}.code must be hex, of at most 24,576 bytes`);
      entry.code = (o.code as string).toLowerCase();
    }
    if (o.stateDiff !== undefined) {
      if (!o.stateDiff || typeof o.stateDiff !== 'object' || Array.isArray(o.stateDiff)) bad(`${address}.stateDiff must be an object of slots`);
      const slots = Object.entries(o.stateDiff as Record<string, unknown>);
      if (slots.length > 256) bad(`${address}.stateDiff: at most 256 slots`);
      entry.stateDiff = Object.fromEntries(slots.map(([slot, v]) => [word(slot, `${address}.stateDiff slot`), word(v, `${address}.stateDiff value`)]));
    }
    out[address.toLowerCase()] = entry;
  }
  return out;
}

/** A request's own overrides (an EIP-7702 delegation's code) over the caller's, account by account. */
export function withOverrides(given: SimulationRequest['stateOverrides'], own: SimulationRequest['stateOverrides']): SimulationRequest['stateOverrides'] {
  if (!given) return own;
  const out: NonNullable<SimulationRequest['stateOverrides']> = { ...given };
  for (const [a, o] of Object.entries(own ?? {})) out[a.toLowerCase()] = { ...out[a.toLowerCase()], ...o };
  return out;
}

/** What a preview says when the caller set state for the simulation. */
export function overriddenWarning(overrides: NonNullable<SimulationRequest['stateOverrides']>): string {
  const n = Object.keys(overrides).length, kinds = ['balance', 'code', 'stateDiff'].filter(k => Object.values(overrides).some(o => (o as Record<string, unknown>)[k] !== undefined)).map(k => (k === 'stateDiff' ? 'storage' : k));
  return `Simulated with state set by whoever asked for this preview (${kinds.join(', ')} of ${n} account${n === 1 ? '' : 's'}), not the chain's own: it shows what would happen if the chain were in that state.`;
}

/** The wallet's own transactions still waiting to be mined, as simulation requests run before this one. */
export function pendingRequests(tx: Tx, context: PreviewContext): SimulationRequest[] {
  return (context.pendingTransactions ?? []).filter(p => p && typeof p === 'object').map(p => ({
    chainId: tx.chainId, from: tx.from, to: typeof p.to === 'string' && ADDRESS.test(p.to) ? p.to.toLowerCase() : null,
    data: (typeof p.data === 'string' && HEX.test(p.data) ? p.data.toLowerCase() : '0x') as `0x${string}`, value: quantity(p.value, 'pendingTransactions[].value'),
  }));
}

/** How the simulated balance changes were found, for the preview's notes. */
export function simulationNote(sim: Pick<SimulationResult, 'basis' | 'tokensRead' | 'balancesRead' | 'stateReadError'>): string {
  if (sim.basis === 'state') return stateBasisNote(sim);
  if (sim.basis === 'fork') return "Simulated in a local EVM over this chain's latest state (its RPC has no eth_simulateV1), in the next block. Balance changes were read from the state before and after, for every token the transaction's events touch; the final result can differ if state changes before inclusion.";
  if (sim.balancesRead) return 'Simulated at the latest block. Balance changes were read from the state before and after, for every token the transaction\'s events or calldata mention; the final result can differ if state changes before inclusion.';
  // (Where the node didn't answer the reads of balances after the run, which would have given them, its answer.)
  return `Simulated balance changes are derived from transfer events at the latest block${sim.stateReadError ? ` (the balances couldn't be read after it: ${sim.stateReadError})` : ''}; the final result can differ if state changes before inclusion.`;
}

/** For results measured from balances (SimulationProbe) rather than logs. */
export const stateBasisNote = (sim: Pick<SimulationResult, 'tokensRead'>) =>
  `Simulated at the latest block by running the transaction from your address in an eth_call (this chain's RPC has no eth_simulateV1). Balance changes were read for ${sim.tokensRead ?? 0} token${sim.tokensRead === 1 ? '' : 's'}: those the transaction names and this chain's well-known tokens, so a change in another token wouldn't show.`;
