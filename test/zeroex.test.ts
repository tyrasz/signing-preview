// 0x: calls to AllowanceHolder and through it to the Settlers (swaps a taker submits, bridges), on mined transactions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeFunctionData, encodeFunctionData, parseAbi, type Hex } from 'viem';
import { previewRequest } from '../src/preview.ts';
import { StaticTokenRegistry } from '../src/chains.ts';
import type { Dependencies } from '../src/types.ts';
import { codes, detail, NOW } from './helpers.ts';

type Mined = { from: string; to: string; value: Hex; input: Hex; transfers: { token: string; from: string; to: string; raw: string }[] };
const F = JSON.parse(readFileSync(new URL('./fixtures/zeroex-allowance-holder.json', import.meta.url), 'utf8')) as { sell: Mined; native: Mined; bridge: Mined };
const HOLDER = '0x0000000000001ff3684f28c67538d4d072c22734', DEPLOYER = '0x00000000000004533fe15556b1e086bb1a72ceae';
const SETTLER = '0xaddc26a3854feabfd20d6bf658254088d83a425a', BRIDGE_SETTLER = '0x0038dfb2bbc353daa6ad22cb11ee1d78f41b59cd', EVIL = '0x96221423681a6d52e184d440a8efcebb105c7242';
const ABI = parseAbi(['function exec(address operator, address token, uint256 amount, address target, bytes data) payable returns (bytes)',
  'function execute((address recipient, address buyToken, uint256 minAmountOut) slippage, bytes[] actions, bytes32 zidAndAffiliate) payable returns (bool)']);
// 0x's deployer, as it answered on Ethereum on 2026-11-23: the Settler for each feature (ownerOf), and the one before (prev).
const NAMED: Record<string, string> = { '0x6352211e-2': SETTLER, '0xe2603dc2-2': '0x0cef320d0c5793ade37964e2661a033771e53cd5', '0x6352211e-5': BRIDGE_SETTLER, '0xe2603dc2-5': '0xd7185c486dd88eb9f3573b878a1469485644091f' };
const registry: Dependencies = { tokens: new StaticTokenRegistry(), rpc: { has: () => true, call: async (_c: number, m: string, p: unknown[]) => {
  const q = p[0] as { to?: string; data?: string };
  if (m === 'eth_call' && q.to === DEPLOYER) { const a = NAMED[`${q.data!.slice(0, 10)}-${Number(BigInt(`0x${q.data!.slice(10)}`))}`]; return a ? `0x${'00'.repeat(12)}${a.slice(2)}` : '0x'; }
  return '0x';
} } };
const offline: Dependencies = { tokens: new StaticTokenRegistry() };
const send = (t: { from: string; to: string; input: Hex; value?: Hex }, d = registry) => previewRequest({ method: 'eth_sendTransaction', params: [{ from: t.from, to: t.to, data: t.input, value: t.value ?? '0x0', chainId: '0x1' }] }, { now: NOW }, d);

test('A swap through 0x’s AllowanceHolder: what Settler may take, the least it must give, and to whom', async () => {
  // It was a call that couldn't be decoded. Mined: 2 USDT sold, which is what its receipt shows leaving the sender.
  const p = await send(F.sell);
  assert.match(p.title, /^Swap up to 2 USDT for at least 0\.\d+ ETH on 0x$/);
  assert.deepEqual([p.decoding.decoder, p.decoding.status, p.attention], ['zeroex', 'full', 'none']);
  assert.equal(detail(p, 'May take from you'), 'up to 2 USDT, during this call');
  assert.deepEqual(F.sell.transfers.map(t => [t.token, t.from, t.to, t.raw]), [['0xdac17f958d2ee523a2206206994597c13d831ec7', F.sell.from, SETTLER, '2000000']]);
  assert.match(detail(p, 'Called through it') ?? '', /^0x's Settler for swaps \(0xaddc26a3/);
  // Without an RPC, whether the operator is one of 0x's Settlers isn't checked: said.
  assert.equal((await send(F.sell, offline)).warnings.find(w => w.code === 'zeroex_unchecked_operator')?.severity, 'caution');
  // The same call naming another operator: it may take the tokens, bound by nothing shown.
  const [, token, amount, , data] = decodeFunctionData({ abi: ABI, data: F.sell.input }).args as readonly [string, Hex, bigint, string, Hex];
  const hostile = await send({ ...F.sell, input: encodeFunctionData({ abi: ABI, functionName: 'exec', args: [EVIL, token, amount, EVIL, data] }) });
  assert.deepEqual([hostile.attention, hostile.decoding.status], ['danger', 'opaque']);
  assert.match(hostile.warnings.find(w => w.code === 'zeroex_unknown_operator')?.message ?? '', /^This lets 0x96221423681a6d52e184d440a8efcebb105c7242 take up to 2 USDT from you during the call, and it isn't one of 0x's Settlers/);
  // What is bought going to someone else, and no minimum.
  const [slippage, actions, zid] = decodeFunctionData({ abi: ABI, data }).args as readonly [{ recipient: Hex; buyToken: Hex; minAmountOut: bigint }, readonly Hex[], Hex];
  const inner = (s: typeof slippage) => encodeFunctionData({ abi: ABI, functionName: 'exec', args: [SETTLER, token, amount, SETTLER, encodeFunctionData({ abi: ABI, functionName: 'execute', args: [s, actions, zid] })] });
  const elsewhere = await send({ ...F.sell, input: inner({ ...slippage, recipient: EVIL }) });
  assert.deepEqual([codes(elsewhere).includes('recipient_not_sender'), detail(elsewhere, 'Recipient')], [true, EVIL]);
  assert.ok(codes(await send({ ...F.sell, input: inner({ ...slippage, minAmountOut: 0n }) })).includes('no_slippage_limit'));
  // A call of the same shape to another contract isn't 0x's.
  assert.notEqual((await send({ ...F.sell, to: EVIL })).decoding.decoder, 'zeroex');
});

test('ETH sold through 0x with nothing named to hold the swap to, and a bridge whose destination isn’t read', async () => {
  // Mined: 0.00000001 ETH sold, with no buy token and no minimum in what Settler checks.
  const p = await send(F.native);
  assert.deepEqual([p.title, p.decoding.status, codes(p).includes('no_slippage_limit')], ['Swap up to 0.00000001 ETH on 0x, with no minimum', 'partial', true]);
  assert.match(detail(p, 'You receive at least') ?? '', /^nothing is checked: no token and no minimum are named/);
  // A bridge through 0x's bridge Settler: what it takes, and that where it goes isn't read.
  const bridge = await send(F.bridge);
  assert.match(bridge.title, /^Bridge up to 240000464200 base units of 0xe343…491d and 0\.001026484214027537 ETH through 0x$/);
  assert.deepEqual([bridge.decoding.status, codes(bridge).includes('zeroex_bridge_unread')], ['partial', true]);
  assert.match(detail(bridge, 'Called through it') ?? '', /^0x's Settler for bridges/);
});
