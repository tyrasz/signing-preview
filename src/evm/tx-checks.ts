// Whether the transaction itself can be included, and what it costs. Simulation runs the call; it doesn't check what
// the network checks before including a transaction (eth_simulateV1 runs with validation off): the nonce, the fee cap
// against the base fee, and that the balance covers the value plus the most the gas can cost. Those are read here,
// with the network fee: gas used (from the simulation) at the current price, plus, on Arbitrum One, the gas charged
// for the L1 data, which ArbOS reports through NodeInterface.gasEstimateL1Component.
import { decodeAbiParameters, encodeFunctionData, parseAbi, type Hex } from 'viem';
import { formatUnits, type PreviewBuilder } from '../format.ts';
import { CHAINS } from '../chains.ts';
import type { Dependencies, PreviewContext } from '../types.ts';
import type { Tx } from './common.ts';

const NODE_INTERFACE = '0x00000000000000000000000000000000000000c8';
const L1_COMPONENT = parseAbi(['function gasEstimateL1Component(address to, bool contractCreation, bytes data) payable returns (uint64 gasEstimateForL1, uint256 baseFee, uint256 l1BaseFeeEstimate)']);
/** Arbitrum chains: L2 gas is charged at the base fee (no tip), and the L1 data is charged as extra gas. */
const ARBITRUM = new Set([42161, 421614]);
const gwei = (v: bigint) => `${formatUnits(v, 9)} gwei`;

export interface NetworkFee { gas: bigint; l1Gas: bigint; price: bigint; estimate: bigint; maximum?: bigint }

/**
 * Adds nonce, fee-cap and balance checks and the network fee to a transaction preview. `gasUsed` is the simulated
 * gas; without it, the fee is only shown as the maximum the request allows. Needs an RPC for the chain.
 */
export async function transactionChecks(tx: Tx, gasUsed: bigint | undefined, deps: Dependencies, context: PreviewContext, b: PreviewBuilder): Promise<NetworkFee | undefined> {
  const rpc = deps.rpc;
  if (!rpc?.has(tx.chainId)) return undefined;
  const call = <T>(method: string, params: unknown[]) => rpc.call(tx.chainId, method, params).then(r => r as T, () => undefined);
  const arbitrum = ARBITRUM.has(tx.chainId);
  const [latestNonce, pendingNonce, balance, block, tip, l1] = await Promise.all([
    call<string>('eth_getTransactionCount', [tx.from, 'latest']),
    call<string>('eth_getTransactionCount', [tx.from, 'pending']),
    call<string>('eth_getBalance', [tx.from, 'latest']),
    call<{ baseFeePerGas?: string }>('eth_getBlockByNumber', ['latest', false]),
    tx.maxPriorityFeePerGas === undefined && tx.gasPrice === undefined && !arbitrum ? call<string>('eth_maxPriorityFeePerGas', []) : Promise.resolve(undefined),
    arbitrum ? call<string>('eth_call', [{ to: NODE_INTERFACE, data: encodeFunctionData({ abi: L1_COMPONENT, functionName: 'gasEstimateL1Component', args: [(tx.to ?? '0x0000000000000000000000000000000000000000') as Hex, tx.to === null, tx.data] }) }, 'latest']) : Promise.resolve(undefined),
  ]);
  const chain = CHAINS[tx.chainId];
  const native = (v: bigint) => `${formatUnits(v, chain?.nativeDecimals ?? 18)} ${chain?.nativeSymbol ?? 'native'}`;

  // Nonce: the request's own (a replacement or a queued transaction), or the account's pending transactions.
  const mined = latestNonce !== undefined ? BigInt(latestNonce) : undefined, queued = pendingNonce !== undefined ? BigInt(pendingNonce) : undefined;
  const supplied = context.pendingTransactions?.length ?? 0;
  if (tx.nonce !== undefined && mined !== undefined) {
    if (tx.nonce < mined) b.warn('danger', 'nonce_used', `Nonce ${tx.nonce} is already used by a mined transaction from this account (its next nonce is ${mined}): the network will reject this one.`);
    else if (queued !== undefined && tx.nonce < queued) b.warn('caution', 'nonce_replaces', `Nonce ${tx.nonce} belongs to a transaction of yours that is still pending: if this one's fee is high enough it replaces it (a speed-up or cancel), and the pending one never runs.`);
    else if (tx.nonce > (queued ?? mined)) b.warn('info', 'nonce_gap', `This transaction waits until nonces ${queued ?? mined}${tx.nonce - (queued ?? mined) > 1n ? `–${tx.nonce - 1n}` : ''} are used: it can't be included before them.`);
  } else if (mined !== undefined && queued !== undefined && queued > mined && supplied < Number(queued - mined)) {
    const n = queued - mined;
    b.warn('info', 'pending_transactions', `You have ${n} transaction${n === 1n ? '' : 's'} still pending; this one runs after ${n === 1n ? 'it' : 'them'}, but the preview doesn't include ${n === 1n ? 'its' : 'their'} effects.`);
  }

  // Fee cap against the base fee.
  const baseFee = block?.baseFeePerGas !== undefined ? BigInt(block.baseFeePerGas) : undefined;
  const cap = tx.maxFeePerGas ?? tx.gasPrice;
  if (cap !== undefined && baseFee !== undefined && cap < baseFee) b.warn('caution', 'fee_below_base_fee', `The fee cap (${gwei(cap)}) is below the current base fee (${gwei(baseFee)}): the transaction waits until the base fee falls that low.`);

  // The network fee: gas used at the price the transaction would pay now (Arbitrum: the base fee, plus L1 data gas).
  let l1Gas = 0n;
  if (l1) { try { l1Gas = (decodeAbiParameters([{ type: 'uint64' }, { type: 'uint256' }, { type: 'uint256' }], l1 as Hex) as [bigint, bigint, bigint])[0]; } catch { l1Gas = 0n; } }
  const priority = arbitrum ? 0n : tx.maxPriorityFeePerGas ?? (tx.gasPrice !== undefined && baseFee !== undefined ? (tx.gasPrice > baseFee ? tx.gasPrice - baseFee : 0n) : tip !== undefined ? BigInt(tip) : 0n);
  let price = baseFee !== undefined ? baseFee + priority : tx.gasPrice;
  if (price !== undefined && cap !== undefined && price > cap) price = cap;
  const maximum = tx.gas !== undefined && cap !== undefined ? tx.gas * cap : undefined;
  let fee: NetworkFee | undefined;
  if (gasUsed !== undefined && price !== undefined) {
    const gas = gasUsed + l1Gas;
    fee = { gas, l1Gas, price, estimate: gas * price, ...(maximum !== undefined && { maximum }) };
    b.detail('Network fee', `≈ ${native(fee.estimate)} (${gas.toLocaleString('en-US')} gas at ${gwei(price)}${l1Gas ? `, ${l1Gas.toLocaleString('en-US')} of it for the data posted to Ethereum` : ''})${maximum !== undefined ? `; at most ${native(maximum)}` : ''}`, fee.estimate.toString());
  } else if (maximum !== undefined) {
    b.detail('Network fee', `at most ${native(maximum)} (gas limit ${tx.gas!.toLocaleString('en-US')} at up to ${gwei(cap!)})`, maximum.toString());
  }

  // Balance: the network only accepts a transaction whose sender can pay the value plus gas limit × fee cap.
  if (balance !== undefined) {
    const have = BigInt(balance);
    const worst = maximum ?? (fee ? fee.estimate : undefined);
    if (worst !== undefined && have >= tx.value && have < tx.value + worst) {
      b.warn(maximum !== undefined ? 'danger' : 'caution', 'insufficient_funds_for_gas', maximum !== undefined
        ? `Your balance (${native(have)}) doesn't cover the value plus the most the gas can cost (${native(tx.value + maximum)}): the network will reject this transaction.`
        : `Your balance (${native(have)}) may not cover the value plus the network fee (about ${native(tx.value + worst)}).`);
    }
  }
  return fee;
}
