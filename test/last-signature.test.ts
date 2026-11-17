// The signature of an account's latest earlier operation (lastSignature), looked for back through a node's logs:
// a wide look on a node that caps a read's range and refuses a wide one outright.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionData, parseAbi, type Hex } from 'viem';
import { lastSignature } from '../src/erc4337-sim.ts';

const EP = '0x0000000071727de22e5e9d8baf0edac6f37da032', SENDER = '0x4720e8dd8fd538b4b36fce0f44adb59f7181fc0a';
const HANDLE_OPS = parseAbi(['function handleOps((address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature)[] ops, address beneficiary)']);
const word = `0x${'00'.repeat(32)}` as Hex;

test('A wide look for an account’s earlier operation, on a node that refuses a wide read (HTTP 403) and caps the rest at 50,000 blocks: 50,000 at a time, as far back as it was', async () => {
  const HEAD = 3_000_001n, SIGNED_AT = HEAD - 1n - 940_000n, SIGNATURE = '0xabcdef' as Hex;
  const input = encodeFunctionData({ abi: HANDLE_OPS, functionName: 'handleOps', args: [[{ sender: SENDER as Hex, nonce: 2n, initCode: '0x', callData: '0x', accountGasLimits: word, preVerificationGas: 0n, gasFees: word, paymasterAndData: '0x', signature: SIGNATURE }], SENDER as Hex] });
  const asked: [bigint, bigint][] = [];
  const rpc = { has: () => true, call: async (_c: number, method: string, params: unknown[]) => {
    if (method === 'eth_getBlockByNumber') return { number: `0x${HEAD.toString(16)}` };
    if (method === 'eth_getTransactionByHash') return { input };
    if (method !== 'eth_getLogs') throw new Error(`unexpected ${method}`);
    const { fromBlock, toBlock } = params[0] as { fromBlock: Hex; toBlock: Hex };
    const from = BigInt(fromBlock), to = BigInt(toBlock);
    asked.push([from, to]);
    // Base's public node, 2026-11-17: 10,000,000 blocks an HTTP 403, 100,000 its cap named.
    if (to - from + 1n >= 10_000_000n) throw new Error('eth_getLogs: HTTP 403');
    if (to - from + 1n > 50_000n) throw Object.assign(new Error('eth_getLogs: exceed maximum block range: 50000'), { rpcError: { message: 'exceed maximum block range: 50000' } });
    return from <= SIGNED_AT && SIGNED_AT <= to ? [{ transactionHash: `0x${'11'.repeat(32)}` }] : [];
  } };
  const found = await lastSignature({ deps: { rpc } as never, chainId: 8453, sender: SENDER, entryPoint: EP, wide: true, key: 'wide' });
  assert.equal(found, SIGNATURE);
  // Past the usual reach (100,000) in windows of 50,000, none past the one it was in.
  const windows = asked.filter(([f, t]) => t - f + 1n === 50_000n);
  assert.ok(windows.every(([, t]) => t <= HEAD - 1n - 100_000n), JSON.stringify(windows.map(w => w.map(String))));
  assert.ok(windows.some(([f, t]) => f <= SIGNED_AT && SIGNED_AT <= t));
});
