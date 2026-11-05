import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JsonRpcClient } from '../src/rpc.ts';

test('The RPC client retries rate limits and lagging nodes, and reports other errors at once', async () => {
  const answers = [
    { status: 429, body: {} },
    { status: 200, body: { error: { code: -32005, message: 'rate limit exceeded' } } },
    // A load-balanced node a block behind (HyperEVM's public RPC does this).
    { status: 200, body: { error: { code: -32603, message: 'invalid block height: 50439414' } } },
    { status: 200, body: { result: '0x10' } },
  ];
  let calls = 0;
  const fetchImpl = (async () => { const a = answers[calls++]; return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, ...a.body }), { status: a.status }); }) as unknown as typeof fetch;
  const rpc = new JsonRpcClient({ 999: 'http://rpc.invalid' }, { fetchImpl, retryDelayMs: 1 });
  assert.equal(await rpc.call(999, 'eth_blockNumber', []), '0x10');
  assert.equal(calls, 4);
  const failing = new JsonRpcClient({ 999: 'http://rpc.invalid' }, { retryDelayMs: 1, fetchImpl: (async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted' } }))) as unknown as typeof fetch });
  await assert.rejects(failing.call(999, 'eth_call', []), /execution reverted/);
});
