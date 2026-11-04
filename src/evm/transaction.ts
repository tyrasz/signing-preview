import { attentionOf, formatUnits, PreviewBuilder, sameAddress } from '../format.ts';
import { CHAINS, chainName } from '../chains.ts';
import type { ApprovalChange, Dependencies, Preview, PreviewContext, SimulationResult, SimulationSummary } from '../types.ts';
import { approvalChanges, approvalWarnings, netChanges, nftChanges } from './effects.ts';
import { type Adapter, type Decoded, type Tx } from './common.ts';
import { erc20Adapter, nativeAdapter, unknownCallAdapter } from './erc20.ts';
import { abiAdapter } from './abi-adapter.ts';
import { cctpAdapter, cctpExtensionAdapter } from './cctp.ts';
import { bridge2Adapter, coreDepositWalletAdapter, coreWriterAdapter, hyperCoreSystemTransferAdapter } from './hyperliquid.ts';

/** Order matters: specific routes before generic ERC-20 shapes. */
export const ADAPTERS: Adapter[] = [
  coreDepositWalletAdapter,
  hyperCoreSystemTransferAdapter,
  nativeAdapter,
  bridge2Adapter,
  cctpAdapter,
  cctpExtensionAdapter,
  coreWriterAdapter,
  erc20Adapter,
  abiAdapter,
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
  return { chainId, from: from.toLowerCase(), to: to ? (to as string).toLowerCase() : null, data: data.toLowerCase() as `0x${string}`, value: quantity(t.value, 'value') };
}

/**
 * A simulation outcome computed by the caller, e.g. a batch simulated in order. `result: null` means not covered;
 * `skipped` explains why this call was deliberately not simulated.
 */
export type PresetSimulation = { result: SimulationResult | null } | { error: string } | { skipped: string };

export async function previewTransaction(tx: Tx, deps: Dependencies, context: PreviewContext, method: string, preset?: PresetSimulation): Promise<Preview> {
  const env = { deps, context };
  let result: Decoded | null = null;
  for (const adapter of ADAPTERS) {
    result = await adapter(tx, env);
    if (result) break;
  }
  const d = result!;
  const b = d.b;
  if (!CHAINS[tx.chainId]) b.warn('caution', 'unsupported_chain', `Chain ${tx.chainId} is not one of the supported networks (Ethereum, Arbitrum One, HyperEVM). Token names and routes were not checked for it.`);
  if (context.account && !sameAddress(context.account, tx.from)) b.warn('danger', 'sender_mismatch', `The transaction's sender (${tx.from}) is not the connected account (${context.account}).`);
  if (context.chainId && context.chainId !== tx.chainId) b.warn('caution', 'chain_mismatch', `The transaction targets ${chainName(tx.chainId)}, but the wallet is on ${chainName(context.chainId)}.`);
  if (tx.value > 0n && tx.data !== '0x' && d.decoder !== 'weth_deposit') {
    const chain = CHAINS[tx.chainId];
    b.detail('Native value attached', `${formatUnits(tx.value, chain?.nativeDecimals ?? 18)} ${chain?.nativeSymbol ?? ''}`.trim(), tx.value.toString());
  }

  let assetChanges = d.assetChanges;
  let approvals: ApprovalChange[] = [];
  let simulation: SimulationSummary | undefined;
  let outcome = preset;
  if (!outcome && deps.simulator) {
    try {
      outcome = { result: await deps.simulator.simulate(simulationRequest(tx)) };
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
    const sim = outcome.result;
    simulation = { status: sim.status, source: sim.source, ...(sim.gasUsed !== undefined && { gasUsed: sim.gasUsed.toString() }), ...(sim.revertReason && { revertReason: sim.revertReason }) };
    if (sim.status === 'reverted') {
      b.warn('danger', 'simulation_reverted', `The transaction is expected to fail${sim.revertReason ? `: ${sim.revertReason}` : ''}. You would still pay the network fee.`);
    } else {
      const simulated = [...await netChanges(sim.transfers, tx, deps, b), ...await nftChanges(sim.nftTransfers ?? [], tx, deps, b)];
      if (simulated.length || !assetChanges.length) assetChanges = simulated;
      approvals = await approvalChanges((sim.approvals ?? []).map(approval => ({ approval, callTo: tx.to })), tx, deps, sim.approvalState);
      approvalWarnings(b, approvals, context.now);
      b.note('Simulated balance changes are derived from transfer events at the latest block; the final result can differ if state changes before inclusion.');
    }
  }
  return {
    schema: 'signing-preview/1', method, kind: 'transaction',
    network: { kind: 'evm', chainId: tx.chainId, name: chainName(tx.chainId) },
    title: d.title, summary: d.summary, details: b.details, assetChanges, ...(approvals.length ? { approvals } : {}), warnings: b.warnings, attention: attentionOf(b.warnings),
    decoding: { status: d.status, decoder: d.decoder, notes: b.notes },
    ...(simulation && { simulation }),
  };
}

export const simulationRequest = (tx: Tx) => ({ chainId: tx.chainId, from: tx.from, to: tx.to, data: tx.data, value: tx.value });
