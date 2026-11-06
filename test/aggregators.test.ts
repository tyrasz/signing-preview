// 1inch v6, MetaMask Swaps/Bridge and Across deposits: headlines from calldata.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionData, pad, parseAbi, type Hex } from 'viem';
import { previewRequest } from '../src/preview.ts';
import { StaticTokenRegistry } from '../src/chains.ts';
import type { Dependencies } from '../src/types.ts';
import { ALICE, BOB } from '../mocks/data.ts';
import { codes, detail, NOW } from './helpers.ts';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7', WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const POOL = '0x3416cf6c708da44db2624d63ea0aaef7113527c6'; // Uniswap v3 USDC/USDT
const rpc = { has: () => true, call: async (_c: number, _m: string, p: unknown[]) => { const { to, data } = p[0] as { to: string; data: string }; if (to.toLowerCase() !== POOL) throw new Error('no'); return pad(data === '0x0dfe1681' ? USDC : USDT); } };
const deps: Dependencies = { tokens: new StaticTokenRegistry(), rpc };
const send = (to: string, data: Hex, value = 0n, chainId = '0x1') => previewRequest({ method: 'eth_sendTransaction', params: [{ from: ALICE, to, data, value: `0x${value.toString(16)}`, chainId }] }, { now: NOW }, deps);
const ONEINCH = '0x111111125421cA6dc452d289314280a0f8842A65';
const ABI = parseAbi([
  'function swap(address executor, (address srcToken, address dstToken, address srcReceiver, address dstReceiver, uint256 amount, uint256 minReturnAmount, uint256 flags) desc, bytes data) payable returns (uint256, uint256)',
  'function unoswap(uint256 token, uint256 amount, uint256 minReturn, uint256 dex) returns (uint256)',
  'function cancelOrder(uint256 makerTraits, bytes32 orderHash)',
  'function swap(string aggregatorId, address tokenFrom, uint256 amount, bytes data) payable',
  'function depositV3(address depositor, address recipient, address inputToken, address outputToken, uint256 inputAmount, uint256 outputAmount, uint256 destinationChainId, address exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes message) payable',
]);

test('1inch v6: swap with its description, unoswap through a pool read on-chain, a recipient elsewhere, a limit-order cancel', async () => {
  const desc = (dstReceiver: string, minReturnAmount: bigint) => ({ srcToken: USDC as Hex, dstToken: USDT as Hex, srcReceiver: BOB as Hex, dstReceiver: dstReceiver as Hex, amount: 100_000_000n, minReturnAmount, flags: 0n });
  const p = await send(ONEINCH, encodeFunctionData({ abi: ABI, functionName: 'swap', args: ['0x00000000000000000000000000000000000000e1', desc(ALICE, 99_800_000n), '0x'] }));
  assert.equal(p.title, 'Swap 100 USDC for at least 99.8 USDT on 1inch');
  assert.equal(p.attention, 'none');
  const elsewhere = await send(ONEINCH, encodeFunctionData({ abi: ABI, functionName: 'swap', args: ['0x00000000000000000000000000000000000000e1', desc(BOB, 0n), '0x'] }));
  assert.ok(codes(elsewhere).includes('recipient_not_sender'));
  assert.ok(codes(elsewhere).includes('no_slippage_limit'));
  // unoswap: token and pool packed into uint256 words (Uniswap v3: protocol 1 in the top 3 bits).
  const uno = await send(ONEINCH, encodeFunctionData({ abi: ABI, functionName: 'unoswap', args: [BigInt(USDC), 50_000_000n, 49_900_000n, (1n << 253n) | BigInt(POOL)] }));
  assert.equal(uno.title, 'Swap 50 USDC for at least 49.9 USDT on 1inch');
  assert.match(detail(uno, 'Pools')!, /^Uniswap v3 0x3416/);
  assert.equal((await send(ONEINCH, encodeFunctionData({ abi: ABI, functionName: 'cancelOrder', args: [0n, `0x${'ab'.repeat(32)}`] }))).title, 'Cancel a 1inch limit order');
});

test('MetaMask Swaps names the aggregator; Across deposits name the destination and recipient', async () => {
  const mm = await send('0x881D40237659C251811CEC9c364ef91dC08D300C', encodeFunctionData({ abi: ABI, functionName: 'swap', args: ['oneInchV6FeeDynamic', USDC, 3_500_000_000n, '0x'] }));
  assert.equal(mm.title, 'Swap 3,500 USDC with MetaMask Swaps (oneInchV6FeeDynamic)');
  const deposit = encodeFunctionData({ abi: ABI, functionName: 'depositV3', args: [ALICE, BOB, WETH, '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', 5n * 10n ** 17n, 499n * 10n ** 15n, 42161n, '0x0000000000000000000000000000000000000000', 1762000000, 1762003600, 0, '0x'] });
  const across = await send('0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5', deposit, 5n * 10n ** 17n);
  assert.equal(across.title, 'Bridge 0.5 ETH to Arbitrum One through Across');
  assert.equal(detail(across, 'Received there (at least)'), '0.499 WETH');
  assert.ok(codes(across).includes('recipient_not_sender'));
  // Ethereum's SpokePool address on another chain is left to the other decoders.
  assert.notEqual((await send('0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5', deposit, 0n, '0xa4b1')).decoding.decoder, 'across_deposit');
});

test('OKX DEX router: the request it carries, and pool-only swaps with the output read on-chain (and paid as ETH when the last pool says so)', async () => {
  const OKX = '0x8feab81d36e7576107d5de0758c1b839be31b4f6';
  const A = parseAbi([
    'function dagSwapTo(uint256 orderId, address receiver, (uint256 fromToken, address toToken, uint256 fromTokenAmount, uint256 minReturnAmount, uint256 deadLine) baseRequest, (address[] mixAdapters, address[] assetTo, uint256[] rawData, bytes[] extraData, uint256 fromToken)[] paths) payable returns (uint256)',
    'function unxswapTo(uint256 srcToken, uint256 amount, uint256 minReturn, address receiver, bytes32[] pools) payable returns (uint256)',
  ]);
  const dag = await send(OKX, encodeFunctionData({ abi: A, functionName: 'dagSwapTo', args: [1n, ALICE, { fromToken: BigInt(USDC), toToken: USDT, fromTokenAmount: 10_000_000n, minReturnAmount: 9_990_000n, deadLine: 0n }, []] }));
  assert.equal(dag.title, 'Swap 10 USDC for at least 9.99 USDT on OKX DEX');
  // A USDC/WETH v2 pool (token0 USDC, token1 WETH); bit 254 on the last pool unwraps the WETH.
  const PAIR = '0xb4e16d0168e52d35cacd2c6185b44281ec28c9dc';
  const pairs = { has: () => true, call: async (_c: number, _m: string, p: unknown[]) => { const { to, data } = p[0] as { to: string; data: string }; if (to.toLowerCase() !== PAIR) throw new Error('no'); return pad((data === '0x0dfe1681' ? USDC : WETH) as Hex); } };
  const unx = (flags: bigint) => previewRequest({ method: 'eth_sendTransaction', params: [{ from: ALICE, to: OKX, chainId: '0x1', data: encodeFunctionData({ abi: A, functionName: 'unxswapTo', args: [BigInt(USDC), 100_000_000n, 3n * 10n ** 16n, ALICE, [pad(`0x${(flags | BigInt(PAIR)).toString(16)}` as Hex)]] }) }] }, { now: NOW }, { tokens: new StaticTokenRegistry(), rpc: pairs });
  assert.equal((await unx(0n)).title, 'Swap 100 USDC for at least 0.03 WETH on OKX DEX');
  assert.equal((await unx(1n << 254n)).title, 'Swap 100 USDC for at least 0.03 ETH on OKX DEX');
});
