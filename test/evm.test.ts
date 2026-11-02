import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionData, parseAbi } from 'viem';
import { previewRequest } from '../src/preview.ts';
import { RpcSimulator, parseTransfers } from '../src/simulation.ts';
import { StaticTokenRegistry } from '../src/chains.ts';
import { formatUnits, parseUnits } from '../src/format.ts';
import { ALICE, BOB } from '../mocks/data.ts';
import { codes, detail, mockDeps, NOW, sample } from './helpers.ts';

test('HyperEVM → HyperCore transfers via system addresses', async () => {
  const hype = await sample('evm-hype-to-core');
  assert.equal(hype.title, 'Move 3 HYPE to HyperCore');
  const purr = await sample('evm-purr-to-core');
  assert.equal(purr.title, 'Move 2,500 PURR to HyperCore');
  assert.ok(!codes(purr).includes('core_token_mismatch'));
});

test('A token sent to a system address it is not linked to is dangerous', async () => {
  const abi = parseAbi(['function transfer(address to, uint256 amount)']);
  const data = encodeFunctionData({ abi, functionName: 'transfer', args: ['0x2000000000000000000000000000000000000001', 10n] });
  const p = await previewRequest({ method: 'eth_sendTransaction', params: [{ from: ALICE, to: '0x5555555555555555555555555555555555555555', data, chainId: '0x3e7' }] }, { now: NOW }, mockDeps());
  assert.ok(codes(p).includes('core_token_mismatch'));
});

test('CoreWriter actions are decoded with scaled prices and sizes', async () => {
  const order = await sample('corewriter-order');
  assert.equal(order.title, 'HyperCore order: Long 10 HYPE-PERP @ 39.5');
  assert.ok(codes(order).includes('corewriter_async'));
  const cls = await sample('corewriter-class');
  assert.equal(cls.title, 'Move 500 USDC from spot to perps');
});

test('CoreWriter borrow/lend and account-mode actions', async () => {
  const abi = parseAbi(['function sendRawAction(bytes data)']);
  const { encodeAbiParameters, parseAbiParameters } = await import('viem');
  const raw = (id: number, params: string, values: unknown[]) => encodeFunctionData({ abi, functionName: 'sendRawAction', args: [('0x01' + id.toString(16).padStart(6, '0') + encodeAbiParameters(parseAbiParameters(params), values as never).slice(2)) as `0x${string}`] });
  const send = (data: string) => previewRequest({ method: 'eth_sendTransaction', params: [{ from: ALICE, to: '0x3333333333333333333333333333333333333333', data, chainId: '0x3e7' }] }, { now: NOW }, mockDeps());
  const supply = await send(raw(15, 'uint8, uint64, uint64', [0, 150n, 250_000_000n]));
  assert.equal(supply.title, 'Supply 2.5 HYPE to HyperCore lending');
  const mode = await send(raw(16, 'address, uint8', [ALICE, 3]));
  assert.equal(mode.title, 'Set HyperCore account mode to portfolio margin');
  const unknown = await send(raw(99, 'uint8', [1]));
  assert.equal(unknown.decoding.status, 'opaque');
});

test('ERC-20 unlimited approval and Permit2 signatures', async () => {
  const approve = await sample('eth-approve-unlimited');
  assert.ok(codes(approve).includes('unlimited_approval'));
  assert.equal(detail(approve, 'Allowance'), 'Unlimited');
  const permit2 = await sample('eth-permit2');
  assert.equal(permit2.decoding.decoder, 'permit2_allowance');
  assert.ok(codes(permit2).includes('unlimited_permit'));
});

test('Unknown calls are opaque but show simulated balance changes', async () => {
  const p = await sample('eth-unknown-swap');
  assert.equal(p.decoding.status, 'opaque');
  assert.deepEqual(p.assetChanges.map(c => `${c.direction} ${c.amount} ${c.symbol}`), ['out 1,000 USDC', 'in 0.28435 WETH']);
});

test('Simulated reverts are dangerous', async () => {
  const p = await sample('eth-reverting');
  assert.equal(p.simulation?.status, 'reverted');
  assert.ok(codes(p).includes('simulation_reverted'));
});

test('Sender/account mismatch and SIWE domain mismatch', async () => {
  const p = await sample('eth-send', { account: BOB });
  assert.ok(codes(p).includes('sender_mismatch'));
  const siwe = await sample('siwe-phish');
  assert.equal(siwe.title, 'Sign in to app.hyperliquid.xyz');
  assert.ok(codes(siwe).includes('siwe_domain_mismatch'));
});

test('eth_sign is always dangerous; malformed requests throw INVALID_REQUEST', async () => {
  const p = await previewRequest({ method: 'eth_sign', params: [ALICE, '0x' + '11'.repeat(32)] });
  assert.equal(p.attention, 'danger');
  await assert.rejects(previewRequest({ method: 'eth_sendTransaction', params: [{ to: BOB }] }), (e: { code?: string }) => e.code === 'INVALID_REQUEST');
  await assert.rejects(previewRequest({ method: 'eth_signTypedData_v4', params: [ALICE, '{nope'] }), (e: { code?: string }) => e.code === 'INVALID_REQUEST');
});

test('RpcSimulator sends eth_simulateV1 and nets ERC-20 and native transfer logs', async () => {
  const USDC = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
  const topic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const word = (a: string) => '0x' + a.slice(2).padStart(64, '0');
  let sent: { method: string; params: [{ traceTransfers: boolean }] } | undefined;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    sent = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ result: [{ calls: [{ status: '0x1', gasUsed: '0xc350', returnData: '0x', logs: [
      { address: USDC, topics: [topic, word(ALICE), word(BOB)], data: '0x' + (7_000_000n).toString(16).padStart(64, '0') },
      { address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', topics: [topic, word(BOB), word(ALICE)], data: '0x' + (10n ** 15n).toString(16).padStart(64, '0') },
    ] }] }] }));
  }) as typeof fetch;
  const simulator = new RpcSimulator({ 42161: 'http://rpc.invalid' }, { fetchImpl });
  const p = await previewRequest({ method: 'eth_sendTransaction', params: [{ from: ALICE, to: BOB, data: '0x1234', chainId: '0xa4b1' }] }, { now: NOW }, { tokens: new StaticTokenRegistry(), simulator });
  assert.equal(sent?.method, 'eth_simulateV1');
  assert.equal(sent?.params[0].traceTransfers, true);
  assert.deepEqual(p.assetChanges.map(c => `${c.direction} ${c.amount} ${c.symbol}`), ['out 7 USDC', 'in 0.001 ETH']);
  assert.equal(p.simulation?.gasUsed, '50000');
  // No RPC for this chain: simulation is skipped silently.
  const skipped = await previewRequest({ method: 'eth_sendTransaction', params: [{ from: ALICE, to: BOB, data: '0x', value: '0x1', chainId: '0x1' }] }, {}, { simulator });
  assert.equal(skipped.simulation, undefined);
  assert.equal(parseTransfers([{ address: USDC, topics: [topic, word(ALICE), word(BOB), word(ALICE)], data: '0x' }]).length, 0);
});

test('Exact decimal formatting', () => {
  assert.equal(formatUnits(123456789n, 6), '123.456789');
  assert.equal(formatUnits(10n ** 24n, 6), '1,000,000,000,000,000,000');
  assert.equal(formatUnits(-1n, 18), '-0.000000000000000001');
  assert.equal(parseUnits('1.5', 6), 1_500_000n);
  assert.equal(parseUnits('1.1234567', 6), null);
});
