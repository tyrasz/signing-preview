// Whether the transaction itself can be included, and what it costs. Simulation runs the call; it doesn't check what
// the network checks before including a transaction (eth_simulateV1 runs with validation off): the nonce, the fee cap
// against the base fee, and that the balance covers the value plus the most the gas can cost. Those are read here,
// with the network fee: gas used (from the simulation) at the current price, plus, on Arbitrum One, the gas charged
// for the L1 data, which ArbOS reports through NodeInterface.gasEstimateL1Component, and on OP Stack chains (Base,
// OP Mainnet) the L1 data fee charged on top of the gas, which the GasPriceOracle predeploy computes.
import { decodeAbiParameters, encodeFunctionData, keccak256, parseAbi, serializeTransaction, toHex, type Hex } from 'viem';
import { formatUnits, type PreviewBuilder } from '../format.ts';
import { CHAINS, OP_STACK } from '../chains.ts';
import type { Dependencies, PreviewContext } from '../types.ts';
import type { Tx } from './common.ts';

const NODE_INTERFACE = '0x00000000000000000000000000000000000000c8';
const L1_COMPONENT = parseAbi(['function gasEstimateL1Component(address to, bool contractCreation, bytes data) payable returns (uint64 gasEstimateForL1, uint256 baseFee, uint256 l1BaseFeeEstimate)']);
/** Arbitrum chains: L2 gas is charged at the base fee (no tip), and the L1 data is charged as extra gas. */
const ARBITRUM = new Set([42161, 421614]);
const gwei = (v: bigint) => `${formatUnits(v, 9)} gwei`;
const GAS_PRICE_ORACLE = '0x420000000000000000000000000000000000000f';
const L1_FEE = parseAbi(['function getL1Fee(bytes _data) view returns (uint256)']);

/**
 * `l1Gas`: Arbitrum's gas for the L1 data (part of `gas`); `l1Fee`: an OP Stack chain's L1 data fee in wei, charged on
 * top of the gas (in `estimate` and `maximum`).
 */
/**
 * The price a transaction would pay now (tx.gasprice), for simulating it as it will run: the latest base fee plus
 * its tip (the request's, or the node's suggestion; none on Arbitrum), up to its fee cap. Undefined without an RPC or
 * a base fee, when the cap is under the base fee (the transaction waits), or when the price is zero.
 */
export async function expectedGasPrice(tx: Tx, deps: Dependencies, baseFeeOf?: bigint): Promise<{ gasPrice: bigint; baseFee: bigint; tip: bigint } | undefined> {
  const rpc = deps.rpc;
  if (!rpc?.has(tx.chainId)) return undefined;
  const call = <T>(method: string, params: unknown[]) => rpc.call(tx.chainId, method, params).then(r => r as T, () => undefined);
  const arbitrum = ARBITRUM.has(tx.chainId);
  const [block, suggested] = await Promise.all([
    // `baseFeeOf`: the base fee of a block named for the simulation (a past one), in place of the latest block's.
    baseFeeOf !== undefined ? Promise.resolve({ baseFeePerGas: `0x${baseFeeOf.toString(16)}` }) : call<{ baseFeePerGas?: string }>('eth_getBlockByNumber', ['latest', false]),
    tx.maxPriorityFeePerGas === undefined && tx.gasPrice === undefined && !arbitrum ? call<string>('eth_maxPriorityFeePerGas', []) : Promise.resolve(undefined),
  ]);
  if (block?.baseFeePerGas === undefined) return undefined;
  try {
    const baseFee = BigInt(block.baseFeePerGas);
    const tip = arbitrum ? 0n : tx.maxPriorityFeePerGas ?? (tx.gasPrice !== undefined ? (tx.gasPrice > baseFee ? tx.gasPrice - baseFee : 0n) : suggested !== undefined ? BigInt(suggested) : 0n);
    const cap = tx.maxFeePerGas ?? tx.gasPrice;
    const gasPrice = cap !== undefined && baseFee + tip > cap ? cap : baseFee + tip;
    return gasPrice > 0n && gasPrice >= baseFee ? { gasPrice, baseFee, tip: gasPrice - baseFee } : undefined;
  } catch { return undefined; }
}

export interface NetworkFee { gas: bigint; l1Gas: bigint; l1Fee?: bigint; price: bigint; estimate: bigint; maximum?: bigint }

/**
 * The transaction as an OP Stack chain's GasPriceOracle takes it for getL1Fee: RLP-serialized and unsigned (it adds
 * the signature's size itself), with the request's fields or those the wallet will fill in. Authorizations not yet
 * signed get stand-in signatures of the same size that don't compress (the fee is on the compressed size).
 */
export function l1FeeInput(tx: Tx, f: { nonce: bigint; gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }): Hex {
  const to = (tx.to ?? undefined) as Hex | undefined;
  // The access list is part of what's posted (a long one more than doubled a Base transaction's L1 fee).
  const accessList = tx.accessList?.map(a => ({ address: a.address as Hex, storageKeys: a.storageKeys as Hex[] }));
  const filler = (i: number, k: string) => keccak256(toHex(`${k}${i}`));
  if (tx.authorizations?.length) {
    return serializeTransaction({ type: 'eip7702', chainId: tx.chainId, nonce: Number(f.nonce), gas: f.gas, maxFeePerGas: f.maxFeePerGas, maxPriorityFeePerGas: f.maxPriorityFeePerGas, to, value: tx.value, data: tx.data, ...(accessList && { accessList }),
      authorizationList: tx.authorizations.map((a, i) => ({ address: a.address as Hex, chainId: a.chainId ?? tx.chainId, nonce: Number(a.nonce ?? f.nonce + 1n + BigInt(i)), ...(a.signature ?? { r: filler(i, 'r'), s: filler(i, 's'), yParity: 1 }) })) } as never);
  }
  if (tx.gasPrice !== undefined && tx.maxFeePerGas === undefined) {
    return accessList ? serializeTransaction({ type: 'eip2930', chainId: tx.chainId, nonce: Number(f.nonce), gas: f.gas, gasPrice: tx.gasPrice, to, value: tx.value, data: tx.data, accessList })
      : serializeTransaction({ type: 'legacy', chainId: tx.chainId, nonce: Number(f.nonce), gas: f.gas, gasPrice: tx.gasPrice, to, value: tx.value, data: tx.data });
  }
  return serializeTransaction({ type: 'eip1559', chainId: tx.chainId, nonce: Number(f.nonce), gas: f.gas, maxFeePerGas: f.maxFeePerGas, maxPriorityFeePerGas: f.maxPriorityFeePerGas, to, value: tx.value, data: tx.data, ...(accessList && { accessList }) });
}

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
  // OP Stack: the L1 data fee, at the L1 prices the chain last took in, charged on top of the gas.
  let l1Fee: bigint | undefined;
  if (OP_STACK.has(tx.chainId) && (gasUsed !== undefined || tx.gas !== undefined)) {
    const input = l1FeeInput(tx, { nonce: tx.nonce ?? (latestNonce !== undefined ? BigInt(latestNonce) : 0n), gas: tx.gas ?? gasUsed!, maxFeePerGas: cap ?? (price ?? 0n) * 2n, maxPriorityFeePerGas: priority });
    const out = await call<string>('eth_call', [{ to: GAS_PRICE_ORACLE, data: encodeFunctionData({ abi: L1_FEE, functionName: 'getL1Fee', args: [input] }) }, 'latest']);
    if (out && /^0x[0-9a-f]{64}$/i.test(out)) l1Fee = BigInt(out);
  }
  const maximum = tx.gas !== undefined && cap !== undefined ? tx.gas * cap + (l1Fee ?? 0n) : undefined;
  const l1Part = l1Fee ? `, plus ${native(l1Fee)} for the data posted to Ethereum` : '';
  let fee: NetworkFee | undefined;
  if (gasUsed !== undefined && price !== undefined) {
    const gas = gasUsed + l1Gas;
    fee = { gas, l1Gas, ...(l1Fee !== undefined && { l1Fee }), price, estimate: gas * price + (l1Fee ?? 0n), ...(maximum !== undefined && { maximum }) };
    b.detail('Network fee', `≈ ${native(fee.estimate)} (${gas.toLocaleString('en-US')} gas at ${gwei(price)}${l1Gas ? `, ${l1Gas.toLocaleString('en-US')} of it for the data posted to Ethereum` : ''}${l1Part})${maximum !== undefined ? `; at most ${native(maximum)}` : ''}`, fee.estimate.toString());
  } else if (maximum !== undefined) {
    b.detail('Network fee', `at most ${native(maximum)} (gas limit ${tx.gas!.toLocaleString('en-US')} at up to ${gwei(cap!)}${l1Part})`, maximum.toString());
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
