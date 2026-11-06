// Transactions that crashed the previewer when it was run over a day of mainnet traffic (npm run coverage). Each is
// rebuilt from the real calldata's shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionData, parseAbi, type Hex } from 'viem';
import { previewRequest } from '../src/preview.ts';
import { PERMIT2, StaticTokenRegistry } from '../src/chains.ts';
import type { AbiResolver, Dependencies } from '../src/types.ts';
import { formatTimestamp } from '../src/format.ts';
import { ALICE, BOB } from '../mocks/data.ts';
import { detail, NOW } from './helpers.ts';

const send = (to: string, data: Hex, deps: Dependencies) =>
  previewRequest({ method: 'eth_sendTransaction', params: [{ from: ALICE, to, data, chainId: '0x1' }] }, { now: NOW }, deps);

test('Permit2 approve that never expires (expiration 2^48-1) no longer throws "Invalid time value"', async () => {
  const PERMIT2_ABI = parseAbi(['function approve(address token, address spender, uint160 amount, uint48 expiration)']);
  const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
  const data = encodeFunctionData({ abi: PERMIT2_ABI, functionName: 'approve', args: [USDT, BOB, (1n << 160n) - 1n, 2 ** 48 - 1] });
  const p = await send(PERMIT2, data, { tokens: new StaticTokenRegistry() });
  assert.equal(p.decoding.decoder, 'permit2_approve');
  assert.equal(detail(p, 'Expires'), 'never (no real expiry date)');
  assert.equal(formatTimestamp(Date.UTC(2026, 0, 1)), '2026-01-01T00:00:00Z');
  assert.equal(formatTimestamp(-1000), 'invalid time (-1)');
});

test('multicall with struct items, e.g. (address target, bytes callData)[], no longer throws "data.slice is not a function"', async () => {
  const ROUTER = '0x0000000000000000000000000000000000c0ffee';
  const ABI = parseAbi([
    'function multicall((address target, bool allowFailure, uint256 value, bytes callData)[] calls) payable returns (bytes[])',
    'function transfer(address to, uint256 amount)',
  ]);
  const inner = encodeFunctionData({ abi: ABI, functionName: 'transfer', args: [BOB, 5n] });
  const data = encodeFunctionData({ abi: ABI, functionName: 'multicall', args: [[{ target: BOB, allowFailure: false, value: 0n, callData: inner }, { target: BOB, allowFailure: true, value: 0n, callData: '0x' }]] });
  const abis: AbiResolver = { resolve: async (_c, a) => a.toLowerCase() === ROUTER ? { abi: ABI, name: 'RelayRouter', source: 'test', verified: true } : null };
  const p = await send(ROUTER, data, { tokens: new StaticTokenRegistry(), abis });
  assert.equal(p.title, 'Call multicall on RelayRouter');
  assert.match(detail(p, 'Batched call 1')!, /^transfer\(/);
  assert.equal(detail(p, 'Batched call 2'), '0x (not decoded)');
});

test('A multicall whose calls are not swaps (a nested multicall, as The Graph’s SubgraphService sends) is not read as one', async () => {
  // Arbitrum 0xb06a1672… crashed the Uniswap-style reader: a nested multicall fell through to the exactInput branch.
  const abi = parseAbi(['function multicall(bytes[] data)']);
  const nested = encodeFunctionData({ abi, functionName: 'multicall', args: [[encodeFunctionData({ abi, functionName: 'multicall', args: [[]] })]] });
  const p = await previewRequest({ method: 'eth_sendTransaction', params: [{ from: '0xa11ce00000000000000000000000000000000001', to: '0xb2bb92d0de618878e438b55d5846cfecd9301105', data: nested, chainId: '0xa4b1' }] }, {}, {});
  assert.notEqual(p.decoding.decoder, 'uniswap_style_router');
});
