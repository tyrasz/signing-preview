// The reads scripts/accuracy.ts makes of a public RPC as it follows the chain, where a node of the load balancer that
// hasn't the newest block yet, or one slow to answer, would otherwise cost a block or a transaction of the sample.
import { isRpcError, type RpcClient } from '../src/rpc.ts';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** A read that got no answer at all (it timed out, its connection failed, the load balancer answered 5xx), not the node's. */
export const isTransportFailure = (e: unknown): boolean => {
  if (isRpcError(e)) return false;
  const text = e && typeof e === 'object' ? `${(e as Error).name ?? ''} ${(e as Error).message ?? ''}` : String(e);
  return /TimeoutError|aborted due to timeout|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|other side closed|: HTTP 5\d\d/i.test(text);
};

/**
 * The client, with a read that got no answer asked again (`retries` times, `delayMs` and then twice that later). The
 * client retries rate limits and a node a block behind itself, but not a read that timed out: on BNB Chain's public
 * node (2026-11-14) two did, at 20 s, each taking the rest of its block out of the sample. One that still gets none
 * is thrown, for the caller to leave out what needed it.
 */
export function retryingTransport(client: RpcClient, options: { retries?: number; delayMs?: number } = {}): RpcClient {
  const retries = options.retries ?? 1, delayMs = options.delayMs ?? 1000;
  return {
    has: chainId => client.has(chainId),
    async call(chainId, method, params) {
      for (let attempt = 0; ; attempt++) {
        try { return await client.call(chainId, method, params); } catch (e) {
          if (attempt >= retries || !isTransportFailure(e)) throw e;
          await sleep(delayMs * 2 ** attempt);
        }
      }
    },
  };
}

/** A block as eth_getBlockByNumber gives it, with its transactions. */
export type BlockWithTransactions = { hash: string; transactions: { hash: string }[] };

/**
 * A node's answer that it hasn't the block a hash names: Polygon's (bor) says "header for hash not found" where the
 * others answer null (publicnode's Polygon endpoint, 2026-11-15: for 2 of 160 new heads, the receipts there 0.8 s later).
 */
const NO_SUCH_BLOCK = /header for hash not found|header not found|block not found|unknown block/i;

/**
 * A block's receipts, every transaction's, asked for by the block's hash (so they are that block's, whatever block of
 * its number the answering node holds). A public RPC is a load balancer over nodes that don't all have the newest
 * block yet, and one that hasn't answers null (or, on Polygon, that it has no such block: NO_SUCH_BLOCK): on
 * Sepolia's (publicnode, 2026-11-15) for 17 of the 80 blocks the harness followed, which it then skipped ("Cannot
 * read properties of null (reading 'find')"); asked again, the receipts were there within one or two seconds. So
 * they are asked for again every `pollMs`, for up to `waitMs`, and if they still aren't there, the error says so.
 */
export async function blockReceipts<R extends { transactionHash: string }>(rpc: RpcClient, chainId: number, block: BlockWithTransactions,
  options: { waitMs?: number; pollMs?: number } = {}): Promise<R[]> {
  const waitMs = options.waitMs ?? 15_000, pollMs = options.pollMs ?? 500, deadline = Date.now() + waitMs;
  for (;;) {
    let receipts: R[] | null, refused: string | undefined;
    try { receipts = await rpc.call(chainId, 'eth_getBlockReceipts', [block.hash]) as R[] | null; } catch (e) {
      if (!isRpcError(e) || !NO_SUCH_BLOCK.test((e as Error).message)) throw e;
      receipts = null; refused = (e as Error).message;
    }
    const have = new Set(Array.isArray(receipts) ? receipts.map(r => r.transactionHash.toLowerCase()) : []);
    const missing = block.transactions.filter(t => !have.has(t.hash.toLowerCase())).length;
    if (Array.isArray(receipts) && !missing) return receipts;
    if (Date.now() >= deadline) {
      throw new Error(Array.isArray(receipts) ? `the node's receipts for the block leave out ${missing} of its ${block.transactions.length} transactions`
        : `the node had no receipts for the block ${waitMs / 1000} s after serving it${refused ? ` (${refused})` : ''}`);
    }
    await sleep(pollMs);
  }
}
