// A mined transaction, run again where it ran: on its parent block's state, after the transactions before it in its
// block, in a block with its own header, at the price it paid. The result is a preview like any other (what it
// called, what moved, the approvals it left, its trace when asked for), with the run compared against the receipt:
// the same outcome, the same events in order and the same gas say the replay is what happened.
//
// The chain's node has to keep the parent block's state. Most keep recent blocks only (minutes to hours); an archive
// node keeps all of them.
import type { Hex } from 'viem';
import { recoverAuthorizationAddress } from 'viem/utils';
import { accessListChanges, afterParent, blobBaseFeeAfter, blockAccessList, headerOf, keepsToBlock, LATEST_ONLY, type BlockAt, type RpcHeader } from './block.ts';
import { chainName, CHAINS, OP_STACK } from './chains.ts';
import { formatUnits } from './format.ts';
import { previewRequest } from './preview.ts';
import type { Dependencies, Preview, PreviewContext, ReplayContext, SimulationRequest } from './types.ts';

export { compareWithReceipt } from './evm/trace.ts';

type Auth = { address: string; chainId: string; nonce: string; r: string; s: string; yParity: string };
type RpcTx = {
  hash: string; from: string; to: string | null; input: Hex; value: string; transactionIndex: string; type: string; gas: string; gasPrice?: string; nonce: string; blockNumber: string | null;
  maxFeePerGas?: string; maxPriorityFeePerGas?: string; accessList?: { address: string; storageKeys: string[] }[]; authorizationList?: Auth[]; blobVersionedHashes?: string[]; maxFeePerBlobGas?: string;
};
type RpcBlock = RpcHeader & { transactions: RpcTx[] };
type RpcReceipt = {
  status: string; gasUsed: string; gasUsedForL1?: string; l1Fee?: string; operatorFeeScalar?: string; operatorFeeConstant?: string; effectiveGasPrice?: string; blobGasUsed?: string; blobGasPrice?: string;
  logs: { address: string; topics: string[]; data: string }[];
};

/** Why a transaction can't be replayed: `code` is INVALID_REQUEST, NOT_FOUND, PENDING, UNSUPPORTED or UNAVAILABLE. */
export class ReplayError extends Error {
  code: 'INVALID_REQUEST' | 'NOT_FOUND' | 'PENDING' | 'UNSUPPORTED' | 'UNAVAILABLE';
  constructor(code: ReplayError['code'], message: string) { super(message); this.code = code; this.name = 'ReplayError'; }
}

const ZERO = '0x0000000000000000000000000000000000000000';
/** Arbitrum's own transaction types (ArbOS's deposits, retryables and internal calls). */
const ARBOS_TYPES = new Set(['0x64', '0x65', '0x66', '0x68', '0x69', '0x6a']);
/** An OP Stack block's first transaction, from this address, sets the L1 values its other transactions are priced with. */
const L1_INFO_DEPOSITOR = '0xdeaddeaddeaddeaddeaddeaddeaddeaddead0001';

/**
 * Transactions a chain makes itself, which aren't calls from an account and aren't replayed: ArbOS's on Arbitrum,
 * deposits on OP Stack chains, the validator's own calls at the end of a BNB Chain block, Polygon's state syncs.
 */
function isSystem(chainId: number, t: RpcTx, b: RpcHeader): boolean {
  if (chainId === 42161 || chainId === 421614) return ARBOS_TYPES.has(t.type);
  if (OP_STACK.has(chainId)) return t.type === '0x7e';
  if (chainId === 56) return t.from.toLowerCase() === b.miner.toLowerCase() && BigInt(t.gasPrice ?? '0x0') === 0n;
  if (chainId === 137) return t.from.toLowerCase() === ZERO && (t.to ?? '').toLowerCase() === ZERO;
  return false;
}

/** A function's result, worked out the first time it is asked for. */
function once<T>(f: () => Promise<T>): () => Promise<T> {
  let out: Promise<T> | undefined;
  return () => (out ??= f());
}

/**
 * A block in its parent's second, run at its own time (ReplayContext.sameSecond). BNB Chain makes two or three
 * blocks a second, and its node won't simulate a block in its parent's second: a replay runs there a second late,
 * and one in ten of the transactions in such blocks then comes out otherwise than its receipt (a pool that writes once
 * a second writes again; a deadline of that second has passed). The node will take the second's earlier blocks and
 * this one's earlier transactions as one block at the right time, on the state of the last block of the second
 * before: of 260 such transactions it could run so on 2026-11-11, 255 came out as their receipts, among them every
 * one the run a second late had wrong. What the block's NUMBER reads is the merged block's (that block's plus one).
 * Up to three earlier blocks in the second; their own transactions (a validator's system calls) are left out, as
 * the block's are. Asked for only where the run a second late isn't what the receipt says.
 */
async function sameSecond(chainId: number, block: RpcBlock, index: number, header: BlockAt['header'], deps: Dependencies): Promise<{ at: BlockAt; before: SimulationRequest[]; blocks: number } | undefined> {
  const rpc = deps.rpc!, tag = (n: bigint) => `0x${n.toString(16)}`, time = BigInt(block.timestamp);
  const earlierBlocks: RpcBlock[] = [];
  let n = BigInt(block.number) - 1n;
  for (;; n--) {
    const b = await rpc.call(chainId, 'eth_getBlockByNumber', [tag(n), true]) as RpcBlock | null;
    if (!b?.transactions) return undefined;
    if (BigInt(b.timestamp) !== time) break;
    if (earlierBlocks.length === 3) return undefined;
    earlierBlocks.unshift(b);
  }
  if (!earlierBlocks.length) return undefined;
  const base = tag(n);
  // What a replay runs of a block (the chain's own transactions left out, but an OP Stack block's L1 info deposit).
  const runs = (t: RpcTx, b: RpcBlock) => !isSystem(chainId, t, b) || t.from.toLowerCase() === L1_INFO_DEPOSITOR;
  const txs = [...earlierBlocks.flatMap(b => b.transactions.filter(t => runs(t, b))), ...block.transactions.filter(t => Number(BigInt(t.transactionIndex)) < index && runs(t, block))];
  // What each used, for a node that adds up a block's gas limits (BlockAt.beforeUsed): the blocks' receipts.
  const beforeUsed = once(async () => {
    const receipts = await Promise.all([...earlierBlocks, block].map(b => rpc.call(chainId, 'eth_getBlockReceipts', [b.number]).catch(() => null))) as ((RpcReceipt & { transactionHash: string })[] | null)[];
    const byHash = new Map(receipts.flatMap(r => (Array.isArray(r) ? r : [])).map(r => [r.transactionHash.toLowerCase(), r]));
    const used = txs.map(t => { const r = byHash.get(t.hash.toLowerCase()); return r && BigInt(r.gasUsed) - BigInt(r.gasUsedForL1 ?? 0); });
    return used.every(u => u !== undefined) ? used as bigint[] : undefined;
  });
  const at: BlockAt = { block: base, header: { ...header, number: n + 1n }, required: true, beforeUsed };
  const before = await Promise.all(txs.map(async t => ({ ...await requestOf(chainId, t, base, deps), at })));
  return { at, before, blocks: earlierBlocks.length };
}

/** How long a replay waits before asking a node again for a transaction, block or receipt it didn't have. */
export const REREAD_MS = 1_000;

/**
 * Replays a mined transaction and previews what it did. `context.trace` adds its call trace. Throws a ReplayError
 * when there is no such transaction, it isn't mined yet, it is the chain's own, or the chain has no RPC here.
 */
export async function replayTransaction(input: { chainId: number; hash: string }, context: Pick<PreviewContext, 'trace' | 'now'>, deps: Dependencies): Promise<Preview> {
  const { chainId, hash } = input;
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new ReplayError('INVALID_REQUEST', '"chainId" must be a chain\'s number');
  if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new ReplayError('INVALID_REQUEST', '"hash" must be a transaction hash (32 bytes in hex)');
  const rpc = deps.rpc;
  if (!rpc?.has(chainId) || !deps.simulator) throw new ReplayError('UNAVAILABLE', `No RPC is configured for ${chainName(chainId)}, so its transactions can't be replayed.`);
  const read = async <T>(method: string, params: unknown[]): Promise<T> => {
    try { return await rpc.call(chainId, method, params) as T; } catch (e) { throw new ReplayError('UNAVAILABLE', `${chainName(chainId)}'s node didn't answer ${method}: ${e instanceof Error ? e.message : String(e)}`); }
  };
  // A public node is often several behind a load balancer, one of them a moment behind the others: a transaction
  // just mined, or its block or receipt, is asked for once more before it is said not to be there (two replays in 18
  // at Arbitrum One's tip were told there was no such transaction).
  const again = () => new Promise(r => setTimeout(r, REREAD_MS));
  const tx = await read<RpcTx | null>('eth_getTransactionByHash', [hash]) ?? await again().then(() => read<RpcTx | null>('eth_getTransactionByHash', [hash]));
  if (!tx) throw new ReplayError('NOT_FOUND', `No transaction ${hash} on ${chainName(chainId)}.`);
  if (!tx.blockNumber) throw new ReplayError('PENDING', 'The transaction isn\'t mined yet: there is nothing to replay. Preview it as a request instead.');
  // Some public nodes refuse eth_getTransactionReceipt: the block's receipts have it too.
  const receiptOf = async () => {
    try { return await rpc.call(chainId, 'eth_getTransactionReceipt', [hash]) as RpcReceipt | null; } catch {
      return (await read<(RpcReceipt & { transactionHash: string })[] | null>('eth_getBlockReceipts', [tx.blockNumber]))?.find(r => r.transactionHash.toLowerCase() === hash.toLowerCase()) ?? null;
    }
  };
  const both = () => Promise.all([read<RpcBlock | null>('eth_getBlockByNumber', [tx.blockNumber, true]), receiptOf()]);
  let [block, receipt] = await both();
  if (!block?.transactions || !receipt) [block, receipt] = await again().then(both);
  if (!block?.transactions || !receipt) throw new ReplayError('UNAVAILABLE', `${chainName(chainId)}'s node has the transaction but not its block or receipt.`);
  if (isSystem(chainId, tx, block)) throw new ReplayError('UNSUPPORTED', `This is one of ${chainName(chainId)}'s own transactions (a deposit or a system call), not a call from an account, so it isn't replayed.`);

  const number = BigInt(tx.blockNumber), index = Number(BigInt(tx.transactionIndex));
  const parent = `0x${(number - 1n).toString(16)}`;
  // The node has to answer from the parent block's state. One that answers from its latest whatever block is named
  // (HyperEVM's public RPC) would run the transaction on today's state without a word: its own sender tells, whose
  // nonce before the block can't be past the transaction's.
  if (await keepsToBlock(rpc, chainId, number - 1n, { from: tx.from, nonce: BigInt(tx.nonce) }) === false) throw new ReplayError('UNAVAILABLE', `${chainName(chainId)}'s node ${LATEST_ONLY}`);
  // The block's blob base fee, for a call that reads it: what follows from its parent (a blob transaction's receipt has it too).
  const blobBaseFee = await blobBaseFeeAfter(rpc, chainId, parent) ?? (receipt.blobGasPrice !== undefined ? BigInt(receipt.blobGasPrice) : undefined);
  // A block in the same second as its parent (BNB Chain's often are) runs one second later: nodes take no other.
  const before_ = await read<RpcHeader | null>('eth_getBlockByNumber', [parent, false]);
  const { header, shifted } = afterParent(chainId, headerOf(chainId, block), BigInt(before_?.timestamp ?? '0x0'));
  // What the block had changed before this transaction. From Amsterdam on a block carries the list of it (its
  // access list, EIP-7928), so the state the transaction met is read, exactly, whatever came before it. Otherwise,
  // and where the node doesn't serve the list, the block's earlier transactions are run first, as they ran: with
  // their own gas limits and prices (the chain's own left out, except an OP Stack block's L1 info deposit).
  const accessList = block.blockAccessListHash !== undefined ? await blockAccessList(rpc, chainId, tx.blockNumber) : undefined;
  const state = accessList && accessListChanges(accessList, 0, index);
  // The list also has what the transaction itself changed (its own entry): a trace is checked against it.
  const own = state && accessList && accessListChanges(accessList, index + 1, index + 1);
  const at = { block: parent, header: { ...header, ...(blobBaseFee !== undefined && { blobBaseFee }) }, required: true, ...(state && { state }) };
  const earlier = block.transactions.filter(t => Number(BigInt(t.transactionIndex)) < index && (!isSystem(chainId, t, block) || t.from.toLowerCase() === L1_INFO_DEPOSITOR));
  // Where the gas limits of the transactions up to this one add up to more than the block's (BNB Chain's blocks:
  // each is given far more than it uses), a node that adds them up won't run them as they are. What each earlier
  // one used can then be asked for (the block's receipts, read once and only then), to size a run on less gas each
  // (BlockAt.beforeUsed).
  const over = !state && earlier.reduce((sum, t) => sum + BigInt(t.gas), BigInt(tx.gas)) > BigInt(block.gasLimit);
  let used: Promise<bigint[] | undefined> | undefined;
  const beforeUsed = () => used ??= rpc.call(chainId, 'eth_getBlockReceipts', [tx.blockNumber]).then(r => {
    const byHash = new Map((Array.isArray(r) ? r as (RpcReceipt & { transactionHash: string })[] : []).map(r => [r.transactionHash.toLowerCase(), r]));
    const all = earlier.map(t => { const r = byHash.get(t.hash.toLowerCase()); return r && BigInt(r.gasUsed) - BigInt(r.gasUsedForL1 ?? 0); });
    return all.every(u => u !== undefined) ? all as bigint[] : undefined;
  }, () => undefined);
  if (over) Object.assign(at, { beforeUsed });
  const before = state ? [] : await Promise.all(earlier.map(async t => ({ ...await requestOf(chainId, t, parent, deps), at })));

  const gasUsed = BigInt(receipt.gasUsed), gasForL1 = receipt.gasUsedForL1 !== undefined ? BigInt(receipt.gasUsedForL1) : undefined;
  const gasPrice = BigInt(receipt.effectiveGasPrice ?? tx.gasPrice ?? '0x0');
  // What the sender paid: the gas at its price, on OP Stack chains the L1 data fee and the operator's, and a blob
  // transaction's blob gas.
  const extra = BigInt(receipt.blobGasUsed ?? 0) * BigInt(receipt.blobGasPrice ?? 0) + BigInt(receipt.l1Fee ?? 0) + (receipt.operatorFeeScalar || receipt.operatorFeeConstant ? gasUsed * BigInt(receipt.operatorFeeScalar ?? 0) / 1_000_000n + BigInt(receipt.operatorFeeConstant ?? 0) : 0n);
  const chain = CHAINS[chainId];
  const time = Number(BigInt(block.timestamp));
  const replay: ReplayContext = {
    at, before, earlier: earlier.length, gasPrice, ...(tx.blobVersionedHashes?.length && { blobVersionedHashes: tx.blobVersionedHashes, maxFeePerBlobGas: BigInt(tx.maxFeePerBlobGas ?? '0x1') }),
    receipt: { status: receipt.status === '0x1' ? 'success' : 'reverted', gasUsed: gasUsed - (gasForL1 ?? 0n), ...(gasForL1 !== undefined && { gasForL1 }), logs: receipt.logs.map(l => ({ address: l.address.toLowerCase(), topics: l.topics, data: l.data })) },
    info: {
      hash: tx.hash, block: number.toString(), index, time: new Date(time * 1000).toISOString(),
      receipt: { status: receipt.status === '0x1' ? 'success' : 'reverted', gasUsed: gasUsed.toString(), fee: `${formatUnits(gasUsed * gasPrice + extra, chain?.nativeDecimals ?? 18)} ${chain?.nativeSymbol ?? 'native'}` },
    },
    when: { block: tx.blockNumber, time }, ...(shifted && { shifted, ownTimestamp: BigInt(block.timestamp), ...(!state && { sameSecond: once(() => sameSecond(chainId, block, index, { ...header, timestamp: BigInt(block.timestamp), ...(blobBaseFee !== undefined && { blobBaseFee }) }, deps)) }) }),
    ...(own && { recorded: { changes: own, sender: tx.from.toLowerCase(), nonce: BigInt(tx.nonce), coinbase: header.coinbase.toLowerCase(), fee: gasUsed * gasPrice + extra, tip: gasUsed * (gasPrice > header.baseFeePerGas ? gasPrice - header.baseFeePerGas : 0n) } }),
  };
  const request = {
    method: 'eth_sendTransaction',
    params: [{
      from: tx.from, ...(tx.to && { to: tx.to }), data: tx.input, value: tx.value, gas: tx.gas, nonce: tx.nonce, chainId: `0x${chainId.toString(16)}`,
      ...(tx.maxFeePerGas !== undefined ? { maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas ?? '0x0' } : tx.gasPrice !== undefined && { gasPrice: tx.gasPrice }),
      ...(tx.accessList?.length && { accessList: tx.accessList }), ...(tx.authorizationList?.length && { authorizationList: tx.authorizationList }),
    }],
  };
  return previewRequest(request as never, { chainId, account: tx.from, ...(context.trace && { trace: true }), ...(context.now !== undefined && { now: context.now }), replay }, deps);
}

/** A mined transaction as a simulation request: its call, its gas limit and price, its access list and authorizations. */
async function requestOf(chainId: number, t: RpcTx, tag: string, deps: Dependencies): Promise<SimulationRequest> {
  const stateOverrides = await delegations(chainId, t, tag, deps);
  return {
    chainId, from: t.from.toLowerCase(), to: t.to, data: t.input, value: BigInt(t.value), gas: BigInt(t.gas), gasPrice: BigInt(t.gasPrice ?? '0x0'),
    ...(t.accessList?.length && { accessList: t.accessList }), ...(t.blobVersionedHashes?.length && { blobVersionedHashes: t.blobVersionedHashes, maxFeePerBlobGas: BigInt(t.maxFeePerBlobGas ?? '0x1') }),
    ...(stateOverrides && { stateOverrides }), ...(t.authorizationList?.length && { authorizationList: t.authorizationList }),
  };
}

/**
 * An earlier transaction's EIP-7702 authorizations as code overrides, for simulators that don't apply them
 * themselves: each valid one (this chain or every chain, a readable signature, the authority's nonce at the parent
 * block, counting the transaction's own when the authority sends it) gives the authority its delegation.
 */
async function delegations(chainId: number, t: RpcTx, tag: string, deps: Dependencies): Promise<Record<string, { code: string }> | undefined> {
  if (!t.authorizationList?.length) return undefined;
  const out: Record<string, { code: string }> = {};
  for (const a of t.authorizationList) {
    try {
      if (![0, chainId].includes(Number(a.chainId))) continue;
      const authority = (await recoverAuthorizationAddress({ authorization: { address: a.address as Hex, chainId: Number(a.chainId), nonce: Number(a.nonce) }, signature: { r: a.r as Hex, s: a.s as Hex, yParity: Number(a.yParity) } })).toLowerCase();
      const nonce = BigInt(String(await deps.rpc!.call(chainId, 'eth_getTransactionCount', [authority, tag]))) + (authority === t.from.toLowerCase() ? 1n : 0n);
      if (BigInt(a.nonce) === nonce) out[authority] = { code: /^0x0{40}$/.test(a.address) ? '0x' : `0xef0100${a.address.slice(2).toLowerCase()}` };
    } catch { /* an unreadable authorization is skipped, as the chain skips it */ }
  }
  return Object.keys(out).length ? out : undefined;
}
