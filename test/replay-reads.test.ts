// The transaction replays' reads of a public RPC (scripts/replay-reads.ts): a load-balanced node that hasn't the
// newest block yet, and one that doesn't answer in time, cost neither a block nor the run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JsonRpcClient } from '../src/rpc.ts';
import { blockReceipts, isTransportFailure, retryingTransport } from '../scripts/replay-reads.ts';

const BLOCK = { hash: '0x' + 'ab'.repeat(32), transactions: [{ hash: '0x' + '01'.repeat(32) }, { hash: '0x' + '02'.repeat(32) }] };
const receipt = (hash: string) => ({ transactionHash: hash, status: '0x1', gasUsed: '0x5208', logs: [] });

/** A fake endpoint answering each call from `answer` (call number, method, params), and counting them. */
function node(answer: (n: number, method: string, params: unknown[]) => unknown) {
  const seen: { method: string; params: unknown[] }[] = [];
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    const { method, params } = JSON.parse(init.body) as { method: string; params: unknown[] };
    seen.push({ method, params });
    const a = answer(seen.length, method, params);
    if (a instanceof Error) throw a;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, ...(a as object) }));
  }) as unknown as typeof fetch;
  return { seen, rpc: new JsonRpcClient({ 1: 'http://rpc.invalid' }, { fetchImpl, retryDelayMs: 1 }) };
}

test('A block\'s receipts are asked for by its hash and waited for while the answering node hasn\'t the block (null)', async () => {
  // Sepolia's public endpoint, 2026-11-15: null for a new block from a node behind, the receipts a second later.
  const { rpc, seen } = node(n => ({ result: n < 3 ? null : BLOCK.transactions.map(t => receipt(t.hash)) }));
  const receipts = await blockReceipts(rpc, 1, BLOCK, { pollMs: 1 });
  assert.deepEqual(receipts.map(r => r.transactionHash), BLOCK.transactions.map(t => t.hash));
  assert.equal(seen.length, 3);
  assert.ok(seen.every(c => c.method === 'eth_getBlockReceipts' && c.params[0] === BLOCK.hash));
});

test('Polygon\'s "header for hash not found" for a block its node hasn\'t yet is waited out like null; other errors are not', async () => {
  // publicnode's Polygon endpoint, 2026-11-15: by hash, a node behind answers with an error rather than null.
  const { rpc, seen } = node(n => n < 3 ? { error: { code: -32000, message: 'header for hash not found' } } : { result: BLOCK.transactions.map(t => receipt(t.hash)) });
  assert.equal((await blockReceipts(rpc, 1, BLOCK, { pollMs: 1 })).length, 2);
  assert.equal(seen.length, 3);
  const never = node(() => ({ error: { code: -32000, message: 'header for hash not found' } }));
  await assert.rejects(blockReceipts(never.rpc, 1, BLOCK, { waitMs: 30, pollMs: 5 }), /no receipts for the block 0\.03 s after serving it \(eth_getBlockReceipts: header for hash not found\)/);
  const refusing = node(() => ({ error: { code: -32601, message: 'the method eth_getBlockReceipts does not exist' } }));
  await assert.rejects(blockReceipts(refusing.rpc, 1, BLOCK, { pollMs: 1 }), /does not exist/);
  assert.equal(refusing.seen.length, 1);
});

test('Receipts that leave out a transaction of the block are asked for again too', async () => {
  const { rpc, seen } = node(n => ({ result: (n === 1 ? BLOCK.transactions.slice(0, 1) : BLOCK.transactions).map(t => receipt(t.hash)) }));
  assert.equal((await blockReceipts(rpc, 1, BLOCK, { pollMs: 1 })).length, 2);
  assert.equal(seen.length, 2);
});

test('Receipts that never come end in an error that says why, not a crash on null', async () => {
  const { rpc } = node(() => ({ result: null }));
  await assert.rejects(blockReceipts(rpc, 1, BLOCK, { waitMs: 30, pollMs: 5 }), /the node had no receipts for the block 0\.03 s after serving it/);
  const partial = node(() => ({ result: [receipt(BLOCK.transactions[0].hash)] }));
  await assert.rejects(blockReceipts(partial.rpc, 1, BLOCK, { waitMs: 30, pollMs: 5 }), /leave out 1 of its 2 transactions/);
});

test('A read that timed out is asked again once; the node\'s own errors and a second failure are not hidden', async () => {
  const timeout = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  // BNB Chain's public node, 2026-11-14: a state read timed out at 20 s, and the rest of its block went unreplayed.
  const once = node(n => n === 1 ? timeout() : { result: '0x' });
  assert.equal(await retryingTransport(once.rpc, { delayMs: 1 }).call(1, 'eth_getCode', ['0x' + '00'.repeat(20), '0x1']), '0x');
  assert.equal(once.seen.length, 2);
  const twice = node(() => timeout());
  await assert.rejects(retryingTransport(twice.rpc, { delayMs: 1 }).call(1, 'eth_getCode', []), /aborted due to timeout/);
  assert.equal(twice.seen.length, 2);
  const reverted = node(() => ({ error: { code: 3, message: 'execution reverted' } }));
  await assert.rejects(retryingTransport(reverted.rpc, { delayMs: 1 }).call(1, 'eth_call', []), /execution reverted/);
  assert.equal(reverted.seen.length, 1);
  assert.ok(isTransportFailure(new TypeError('fetch failed')) && isTransportFailure(new Error('eth_call: HTTP 502')));
  assert.ok(!isTransportFailure(new Error('eth_call: HTTP 400')) && !isTransportFailure(new Error('eth_call: rate limited')));
});
