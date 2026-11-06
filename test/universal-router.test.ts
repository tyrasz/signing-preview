import { test } from 'node:test';
import assert from 'node:assert/strict';
import { concat, encodeAbiParameters, encodeFunctionData, parseAbi, parseAbiParameters, toHex, type Hex } from 'viem';
import { previewRequest } from '../src/preview.ts';
import { PERMIT2, StaticTokenRegistry } from '../src/chains.ts';
import type { Dependencies, Simulator } from '../src/types.ts';
import { ALICE, BOB } from '../mocks/data.ts';
import { codes, detail, NOW } from './helpers.ts';
import { privateKeyToAccount } from 'viem/accounts';

const UR_ARB = '0xA51afAFe0263b40EdaEf0Df8781eA9aa03E381a3', UR_ETH = '0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af', UR_V12_ETH = '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD';
const USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', WETH = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', USDT = '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9';
const ETH_USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const MSG_SENDER = '0x0000000000000000000000000000000000000001', ROUTER_SELF = '0x0000000000000000000000000000000000000002';
const CONTRACT_BALANCE = 1n << 255n, MAX160 = (1n << 160n) - 1n;
const DEADLINE = BigInt(Math.floor(NOW / 1000) + 1800);
const EXECUTE = parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable']);

const v3path = (...hops: (string | number)[]) => concat(hops.map(h => typeof h === 'number' ? toHex(h, { size: 3 }) : (h as Hex)));
const swapIn = (recipient: string, amountIn: bigint, minOut: bigint, path: Hex, payerIsUser: boolean) => encodeAbiParameters(parseAbiParameters('address, uint256, uint256, bytes, bool'), [recipient as Hex, amountIn, minOut, path, payerIsUser]);
const swapV2 = (recipient: string, amountIn: bigint, minOut: bigint, path: string[], payerIsUser: boolean) => encodeAbiParameters(parseAbiParameters('address, uint256, uint256, address[], bool'), [recipient as Hex, amountIn, minOut, path as Hex[], payerIsUser]);
const pair = (a: string, n: bigint) => encodeAbiParameters(parseAbiParameters('address, uint256'), [a as Hex, n]);
const triple = (a: string, b: string, n: bigint) => encodeAbiParameters(parseAbiParameters('address, address, uint256'), [a as Hex, b as Hex, n]);
const permit = (token: string, amount: bigint, spender: string) => encodeAbiParameters(
  parseAbiParameters('((address token, uint160 amount, uint48 expiration, uint48 nonce) details, address spender, uint256 sigDeadline), bytes'),
  [{ details: { token: token as Hex, amount, expiration: Math.floor(NOW / 1000) + 30 * 86400, nonce: 0 }, spender: spender as Hex, sigDeadline: DEADLINE }, `0x${'11'.repeat(65)}`]);
const exec = (commands: number[], inputs: Hex[], deadline = DEADLINE) => encodeFunctionData({ abi: EXECUTE, functionName: 'execute', args: [toHex(new Uint8Array(commands)), inputs, deadline] });
const deps: Dependencies = { tokens: new StaticTokenRegistry() };
const send = (to: string, data: Hex, value = 0n, chainId = '0xa4b1') => previewRequest({ method: 'eth_sendTransaction', params: [{ from: ALICE, to, data, value: toHex(value), chainId }] }, { now: NOW }, deps);

test('ETH -> USDC: WRAP_ETH then a v3 exact-input swap paid by the router', async () => {
  const p = await send(UR_ARB, exec([0x0b, 0x00], [pair(ROUTER_SELF, CONTRACT_BALANCE), swapIn(MSG_SENDER, CONTRACT_BALANCE, 3_000_000_000n, v3path(WETH, 500, USDC), false)]), 10n ** 18n);
  assert.equal(p.title, 'Swap 1 ETH for at least 3,000 USDC');
  assert.equal(p.decoding.decoder, 'uniswap_universal_router');
  assert.equal(p.decoding.status, 'full');
  assert.equal(detail(p, 'Step 1'), 'Wrap all the ETH sent into WETH, for the router, for a later step');
  assert.equal(detail(p, 'Step 2'), "Swap all of the router's WETH for at least 3,000 USDC on Uniswap v3 (0.05% fee), paid from the router, to you");
  assert.match(detail(p, 'Contract')!, /^Uniswap Universal Router v2/);
  assert.equal(detail(p, 'Deadline'), new Date(Number(DEADLINE) * 1000).toISOString().replace('.000Z', 'Z'));
  assert.deepEqual(p.assetChanges.map(c => [c.direction, c.amount, c.symbol]), [['out', '1', 'ETH']]);
  assert.ok(!codes(p).some(c => ['output_to_other', 'no_slippage_protection', 'router_command_unknown'].includes(c)));
});

test('USDC -> ETH with the Uniswap app’s Permit2 step: permit, swap to the router, unwrap to you', async () => {
  const p = await send(UR_ARB, exec([0x0a, 0x00, 0x0c], [permit(USDC, MAX160, UR_ARB), swapIn(ROUTER_SELF, 100_000_000n, 30_000_000_000_000_000n, v3path(USDC, 500, WETH), true), pair(MSG_SENDER, 30_000_000_000_000_000n)]));
  assert.equal(p.title, 'Swap 100 USDC for at least 0.03 ETH');
  assert.match(detail(p, 'Step 1')!, /^Record your signed Permit2 allowance: the router may spend an unlimited amount of USDC until 2026-12-02/);
  assert.match(detail(p, 'Step 2')!, /paid from your wallet through Permit2, to the router, for a later step$/);
  assert.equal(detail(p, 'Step 3'), 'Unwrap the router\'s WETH into ETH (at least 0.03 ETH), to you');
  assert.ok(codes(p).includes('router_permit2_allowance'));
  assert.deepEqual(p.assetChanges.map(c => [c.direction, c.amount, c.symbol]), [['out', '100', 'USDC']]);
});

test('Split routes are summed; exact-output paths are read backwards', async () => {
  const split = await send(UR_ARB, exec([0x00, 0x08], [swapIn(MSG_SENDER, 60_000_000n, 18_000_000_000_000_000n, v3path(USDC, 500, WETH), true), swapV2(MSG_SENDER, 40_000_000n, 12_000_000_000_000_000n, [USDC, WETH], true)]));
  assert.equal(split.title, 'Swap 100 USDC for at least 0.03 WETH');
  assert.match(split.summary, /Uniswap \(v3 \+ v2, split across 2 routes\)/);
  // V3_SWAP_EXACT_OUT: path is (tokenOut, fee, tokenIn). Buy exactly 1 WETH for at most 3,500 USDC, through USDT.
  const out = await send(UR_ARB, exec([0x01], [swapIn(MSG_SENDER, 10n ** 18n, 3_500_000_000n, v3path(WETH, 500, USDT, 100, USDC), true)]));
  assert.equal(out.title, 'Swap up to 3,500 USDC for 1 WETH');
  assert.match(detail(out, 'Step 1')!, /^Swap at most 3,500 USDC for exactly 1 WETH on Uniswap v3 \(2 hops\)/);
  assert.deepEqual(out.assetChanges.map(c => [c.direction, c.amount, c.symbol]), [['in', '1', 'WETH']]);
});

test('Fees, recipients, slippage and deadlines are checked', async () => {
  const swap = (recipient: string, minOut: bigint) => swapIn(recipient, 100_000_000n, minOut, v3path(USDC, 500, WETH), true);
  const fee = await send(UR_ARB, exec([0x00, 0x06, 0x04], [swap(ROUTER_SELF, 10n ** 16n), triple(WETH, BOB, 25n), triple(WETH, MSG_SENDER, 0n)]));
  assert.equal(detail(fee, 'Interface fee'), `0.25% of the WETH to ${BOB}`);
  assert.ok(!codes(fee).includes('large_fee_portion'));
  const greedy = await send(UR_ARB, exec([0x00, 0x06, 0x04], [swap(ROUTER_SELF, 10n ** 16n), triple(WETH, BOB, 1500n), triple(WETH, MSG_SENDER, 0n)]));
  assert.equal(greedy.attention, 'danger');
  assert.match(greedy.warnings.find(w => w.code === 'large_fee_portion')!.message, /^15% of your WETH goes to/);

  const other = await send(UR_ARB, exec([0x00], [swap(BOB, 10n ** 16n)]));
  assert.match(other.warnings.find(w => w.code === 'output_to_other')!.message, new RegExp(`swap output \\(WETH\\) to ${BOB}`));
  const noMin = await send(UR_ARB, exec([0x00], [swap(MSG_SENDER, 0n)]));
  assert.ok(codes(noMin).includes('no_slippage_protection'));
  const late = await send(UR_ARB, exec([0x00], [swap(MSG_SENDER, 10n ** 16n)], BigInt(Math.floor(NOW / 1000) - 60)));
  assert.ok(codes(late).includes('deadline_passed'));
  const elsewhere = await send(UR_ARB, exec([0x0a, 0x00], [permit(USDC, MAX160, BOB), swap(MSG_SENDER, 10n ** 16n)]));
  assert.ok(codes(elsewhere).includes('permit2_spender_not_router'));
});

test('Uniswap v4: native ETH in through SWAP_EXACT_IN_SINGLE, SETTLE_ALL and TAKE_ALL; hooks are noted', async () => {
  const HOOK = '0x00000000000000000000000000000000000000c0';
  const key = { currency0: '0x0000000000000000000000000000000000000000', currency1: ETH_USDC, fee: 3000, tickSpacing: 60, hooks: HOOK } as const;
  const single = encodeAbiParameters(parseAbiParameters('((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, bytes hookData)'),
    [{ poolKey: key, zeroForOne: true, amountIn: 10n ** 18n, amountOutMinimum: 3_000_000_000n, hookData: '0x' }]);
  const v4 = encodeAbiParameters(parseAbiParameters('bytes, bytes[]'), ['0x060c0f', [single, pair('0x0000000000000000000000000000000000000000', 10n ** 18n), pair(ETH_USDC, 3_000_000_000n)]]);
  const p = await send(UR_ETH, exec([0x10], [v4]), 10n ** 18n, '0x1');
  assert.equal(p.title, 'Swap 1 ETH for at least 3,000 USDC');
  assert.equal(detail(p, 'Step 1'), 'Swap 1 ETH for at least 3,000 USDC on Uniswap v4 (0.3% fee)');
  assert.equal(detail(p, 'Step 2'), 'Pay for the v4 swap from your wallet: at most 1 ETH');
  assert.equal(detail(p, 'Step 3'), 'Receive the v4 swap output: at least 3,000 USDC, to you');
  assert.ok(codes(p).includes('v4_hook'));
  // Exact output single: the amounts are (amountOut, amountInMaximum).
  const outSingle = encodeAbiParameters(parseAbiParameters('((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 amountOut, uint128 amountInMaximum, bytes hookData)'),
    [{ poolKey: { ...key, hooks: '0x0000000000000000000000000000000000000000' }, zeroForOne: false, amountOut: 10n ** 18n, amountInMaximum: 3_500_000_000n, hookData: '0x' }]);
  const q = await send(UR_ETH, exec([0x10], [encodeAbiParameters(parseAbiParameters('bytes, bytes[]'), ['0x080c0f', [outSingle, pair(ETH_USDC, 3_500_000_000n), pair('0x0000000000000000000000000000000000000000', 10n ** 18n)]])]), 0n, '0x1');
  assert.equal(q.title, 'Swap up to 3,500 USDC for 1 ETH');
});

test('Router versions: 0x10 is a Seaport purchase on v1.2 and a v4 swap on the current router; unknown commands are partial', async () => {
  const seaport = encodeAbiParameters(parseAbiParameters('uint256, bytes'), [5n * 10n ** 17n, '0xabcdef']);
  const p = await send(UR_V12_ETH, exec([0x10], [seaport]), 5n * 10n ** 17n, '0x1');
  assert.equal(p.title, 'Buy NFTs on Seaport 1.5, paying 0.5 ETH (the order details are not decoded)');
  assert.match(detail(p, 'Contract')!, /Universal Router v1\.2/);
  const unknown = await send(UR_ARB, exec([0x1f, 0x80 | 0x04], ['0x', triple(USDC, MSG_SENDER, 0n)]));
  assert.equal(unknown.decoding.status, 'partial');
  assert.ok(codes(unknown).includes('router_command_unknown'));
  assert.equal(detail(unknown, 'Step 2'), "Send the router's remaining USDC to you (allowed to fail)");
  // A router address on the wrong chain is not treated as the router.
  const wrongChain = await send(UR_ARB, exec([0x0b], [pair(ROUTER_SELF, CONTRACT_BALANCE)]), 0n, '0x1');
  assert.notEqual(wrongChain.decoding.decoder, 'uniswap_universal_router');
});

test('Sub-plans are decoded recursively', async () => {
  const sub = encodeAbiParameters(parseAbiParameters('bytes, bytes[]'), ['0x00', [swapIn(MSG_SENDER, 100_000_000n, 10n ** 16n, v3path(USDC, 500, WETH), true)]]);
  const p = await send(UR_ARB, exec([0x21], [sub]));
  assert.equal(detail(p, 'Step 1'), 'Run a sub-plan of 1 step:');
  assert.match(detail(p, 'Step 2')!, /^Swap 100 USDC for at least 0.01 WETH/);
});

test('A Permit2 allowance shown as a router step is not reported again as hidden by the simulation', async () => {
  const sim: Simulator = { simulate: async () => ({ status: 'success', source: 'test', transfers: [],
    approvals: [{ kind: 'permit2', emitter: PERMIT2, token: USDC.toLowerCase(), owner: ALICE, spender: UR_ARB.toLowerCase(), amount: MAX160, expiration: Math.floor(NOW / 1000) + 30 * 86400 }] }) };
  const p = await previewRequest({ method: 'eth_sendTransaction', params: [{ from: ALICE, to: UR_ARB, data: exec([0x0a], [permit(USDC, MAX160, UR_ARB)]), chainId: '0xa4b1' }] }, { now: NOW }, { tokens: new StaticTokenRegistry(), simulator: sim });
  assert.equal(p.approvals?.[0].direct, true);
  assert.ok(!codes(p).includes('hidden_unlimited_approval'));
  assert.ok(codes(p).includes('router_permit2_allowance'));
});

test('Real-world edge cases: a "never expires" Permit2 (2^48-1), no deadline, no settle cap, and compact headline amounts', async () => {
  const { compactUnits, utcDate } = await import('../src/format.ts');
  assert.equal(compactUnits(1_401_117_588_472_729_335_193_644n, 18), '1,401,117');
  assert.equal(compactUnits(50_325_123_400_000_000n, 18), '0.0503251');
  assert.equal(compactUnits(549_622_684_047_769_352_542n, 18), '549.622');
  assert.equal(compactUnits(12_345n, 18), '0.000000000000012345');
  assert.equal(utcDate(2n ** 48n - 1n), null);
  assert.equal(utcDate(1_798_761_600), '2027-01-01');
  // Seen on Ethereum mainnet: PERMIT2_PERMIT with expiration 0xffffffffffff, then a v4 swap.
  const never = encodeAbiParameters(
    parseAbiParameters('((address token, uint160 amount, uint48 expiration, uint48 nonce) details, address spender, uint256 sigDeadline), bytes'),
    [{ details: { token: USDC as Hex, amount: MAX160, expiration: 2 ** 48 - 1, nonce: 0 }, spender: UR_ARB as Hex, sigDeadline: DEADLINE }, `0x${'11'.repeat(65)}`]);
  const p = await send(UR_ARB, exec([0x0a], [never], 2n ** 256n - 1n));
  assert.match(detail(p, 'Step 1')!, /may spend an unlimited amount of USDC with no expiry$/);
  assert.equal(detail(p, 'Deadline'), 'none (no deadline set)');
  assert.equal(p.decoding.status, 'full');
  const v4 = encodeAbiParameters(parseAbiParameters('bytes, bytes[]'), ['0x0c', [pair(USDC, 2n ** 256n - 1n)]]);
  const q = await send(UR_ARB, exec([0x10], [v4]));
  assert.equal(detail(q, 'Step 1'), 'Pay what the v4 swap needs in USDC from your wallet (no maximum set)');
});

test('Demo sample: Uniswap swap of 1 ETH for USDC on Ethereum', async () => {
  const { sample } = await import('./helpers.ts');
  const p = await sample('eth-uniswap-swap');
  assert.equal(p.title, 'Swap 1 ETH for at least 3,150 USDC');
  assert.equal(p.decoding.decoder, 'uniswap_universal_router');
});

test('Headlines agree with what your wallet pays and receives: refunds are fine, round trips get no "X for Y"', async () => {
  // ETH in, exactly 3,000 USDC out, the unused ETH refunded (WRAP_ETH, V3_SWAP_EXACT_OUT, UNWRAP_WETH).
  const refund = await send(UR_ARB, exec([0x0b, 0x01, 0x0c], [pair(ROUTER_SELF, CONTRACT_BALANCE), swapIn(MSG_SENDER, 3_000_000_000n, 10n ** 18n, v3path(USDC, 500, WETH), false), pair(MSG_SENDER, 0n)]), 10n ** 18n);
  assert.equal(refund.title, 'Swap up to 1 ETH for 3,000 USDC');
  // Seen on Arbitrum: sell Dory for USDC, add USDC from the wallet, buy Dory back (a round trip with extra input).
  const v4 = (actions: Hex, params: Hex[]) => encodeAbiParameters(parseAbiParameters('bytes, bytes[]'), [actions, params]);
  const DORY = '0x00000000000000000000000000000000000d0e11';
  const key = { currency0: DORY, currency1: USDC, fee: 10_000, tickSpacing: 200, hooks: '0x0000000000000000000000000000000000000000' } as const;
  const single = (zeroForOne: boolean, amountIn: bigint) => encodeAbiParameters(parseAbiParameters('((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, bytes hookData)'),
    [{ poolKey: key, zeroForOne, amountIn, amountOutMinimum: 0n, hookData: '0x' }]);
  const settle = (cur: string, payerIsUser: boolean) => encodeAbiParameters(parseAbiParameters('address, uint256, bool'), [cur as Hex, 0n, payerIsUser]);
  const take = (cur: string) => encodeAbiParameters(parseAbiParameters('address, address, uint256'), [cur as Hex, ROUTER_SELF, 0n]);
  const p = await send(UR_ARB, exec([0x10, 0x02, 0x10, 0x04], [
    v4('0x060b0e', [single(true, 3n * 10n ** 18n), settle(DORY, true), take(USDC)]),
    triple(USDC, ROUTER_SELF, 740_000_000n),
    v4('0x0b060e', [settle(USDC, false), single(false, 0n), take(DORY)]),
    triple(DORY, MSG_SENDER, 0n),
  ]));
  assert.match(p.title, /^Uniswap: pay 0x0000…0e11 \+ USDC, receive 0x0000…0e11 \(\d+ steps\)$/);
  assert.ok(p.details.some(d => /^Swap the open USDC balance for at least 0/.test(d.value)));
  assert.ok(p.details.some(d => d.value === 'Move 740 USDC from your wallet through Permit2 to the router, for a later step'));
});

// Router 2.1.x / 2.2.0 (one command table): swaps end with per-hop minimum prices, the v4 swap structs carry them
// too, 0x07 pays a full-precision portion, 0x40 deposits into Across, and the command mask is 0x7f.
const UR21_ARB = '0x2d01411773c8C24805306E89A41F7855C3c4Fe65', UR22_HYPER = '0x9aFe3C497e19501DB228F28CdBdD29bC98F65DBa';
const ZERO = '0x0000000000000000000000000000000000000000';
const swapIn21 = (recipient: string, amountIn: bigint, minOut: bigint, path: Hex, payerIsUser: boolean, minHopPriceX36: bigint[] = []) =>
  encodeAbiParameters(parseAbiParameters('address, uint256, uint256, bytes, bool, uint256[]'), [recipient as Hex, amountIn, minOut, path, payerIsUser, minHopPriceX36]);
const acrossInput = (o: { depositor?: string; recipient?: string; inputToken?: string; outputToken?: string; inputAmount?: bigint; outputAmount?: bigint; chain?: bigint; message?: Hex } = {}) => encodeAbiParameters(
  parseAbiParameters('(address depositor, address recipient, address inputToken, address outputToken, uint256 inputAmount, uint256 outputAmount, uint256 destinationChainId, address exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes message, bool useNative)'),
  [{ depositor: (o.depositor ?? ALICE) as Hex, recipient: (o.recipient ?? ALICE) as Hex, inputToken: (o.inputToken ?? USDC) as Hex, outputToken: (o.outputToken ?? ETH_USDC) as Hex,
    inputAmount: o.inputAmount ?? CONTRACT_BALANCE, outputAmount: o.outputAmount ?? 99_500_000n, destinationChainId: o.chain ?? 1n, exclusiveRelayer: ZERO,
    quoteTimestamp: Math.floor(NOW / 1000), fillDeadline: Math.floor(NOW / 1000) + 4 * 3600, exclusivityDeadline: 0, message: o.message ?? '0x', useNative: false }]);

test('Router 2.1: per-hop minimum prices count as slippage protection, and 0x07 is a full-precision fee', async () => {
  const priced = await send(UR21_ARB, exec([0x00], [swapIn21(MSG_SENDER, 100_000_000n, 0n, v3path(USDC, 500, WETH), true, [3n * 10n ** 32n])]));
  assert.equal(priced.decoding.status, 'full');
  assert.equal(detail(priced, 'Contract'), `Uniswap Universal Router v2.1.2 (${UR21_ARB.toLowerCase()})`);
  assert.match(detail(priced, 'Step 1')!, /on Uniswap v3 \(0\.05% fee, per-hop minimum prices\), paid from your wallet through Permit2, to you$/);
  assert.ok(!codes(priced).includes('no_slippage_protection'));
  const unpriced = await send(UR21_ARB, exec([0x08], [encodeAbiParameters(parseAbiParameters('address, uint256, uint256, address[], bool, uint256[]'), [MSG_SENDER, 100_000_000n, 0n, [USDC, WETH], true, []])]));
  assert.equal(unpriced.title, 'Swap 100 USDC for at least 0 WETH');
  assert.ok(codes(unpriced).includes('no_slippage_protection'));

  const fee = await send(UR21_ARB, exec([0x00, 0x07, 0x04], [swapIn21(ROUTER_SELF, 100_000_000n, 10n ** 16n, v3path(USDC, 500, WETH), true), triple(WETH, BOB, 25n * 10n ** 14n), triple(WETH, MSG_SENDER, 0n)]));
  assert.equal(detail(fee, 'Interface fee'), `0.25% of the WETH to ${BOB}`);
  const greedy = await send(UR21_ARB, exec([0x00, 0x07], [swapIn21(ROUTER_SELF, 100_000_000n, 10n ** 16n, v3path(USDC, 500, WETH), true), triple(WETH, BOB, 15n * 10n ** 16n)]));
  assert.match(greedy.warnings.find(w => w.code === 'large_fee_portion')!.message, /^15% of your WETH/);
  // 0x07 is only a placeholder on 2.0, and 0x40 isn't a command there.
  assert.ok(codes(await send(UR_ARB, exec([0x07], [triple(WETH, BOB, 1n)]))).includes('router_command_unknown'));
});

test('Router 2.1: v4 swaps use the new struct layouts', async () => {
  const path = [{ intermediateCurrency: WETH as Hex, fee: 500, tickSpacing: 10, hooks: ZERO as Hex, hookData: '0x' as Hex }];
  const multi = encodeAbiParameters(parseAbiParameters('(address currencyIn, (address intermediateCurrency, uint24 fee, int24 tickSpacing, address hooks, bytes hookData)[] path, uint256[] minHopPriceX36, uint128 amountIn, uint128 amountOutMinimum)'),
    [{ currencyIn: USDC, path, minHopPriceX36: [], amountIn: 100_000_000n, amountOutMinimum: 10n ** 16n }]);
  const p = await send(UR21_ARB, exec([0x10], [encodeAbiParameters(parseAbiParameters('bytes, bytes[]'), ['0x070c0f', [multi, pair(USDC, 100_000_000n), pair(WETH, 10n ** 16n)]])]));
  assert.equal(p.title, 'Swap 100 USDC for at least 0.01 WETH');
  assert.equal(detail(p, 'Step 1'), 'Swap 100 USDC for at least 0.01 WETH on Uniswap v4 (1 hop)');
  const single = encodeAbiParameters(parseAbiParameters('((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, uint256 minHopPriceX36, bytes hookData)'),
    [{ poolKey: { currency0: ZERO, currency1: ETH_USDC, fee: 500, tickSpacing: 10, hooks: ZERO }, zeroForOne: true, amountIn: 10n ** 18n, amountOutMinimum: 0n, minHopPriceX36: 3000n * 10n ** 24n, hookData: '0x' }]);
  const q = await send('0x23617e59A5925b2A4Bf75d73ff6711cD0b29De85', exec([0x10], [encodeAbiParameters(parseAbiParameters('bytes, bytes[]'), ['0x060c0f', [single, pair(ZERO, 10n ** 18n), pair(ETH_USDC, 0n)]])]), 10n ** 18n, '0x1');
  assert.equal(q.title, 'Swap 1 ETH for at least 0 USDC');
  assert.equal(detail(q, 'Step 1'), 'Swap 1 ETH for at least 0 USDC on Uniswap v4 (0.05% fee, per-hop minimum prices)');
  assert.ok(!codes(q).includes('no_slippage_protection'));
});

test('Router 2.1: an Across deposit (0x40) bridges the output, and other recipients, refunds and messages are flagged', async () => {
  const bridged = await send(UR21_ARB, exec([0x00, 0x40], [swapIn21(ROUTER_SELF, 100_000_000n, 99_000_000n, v3path(USDT, 100, USDC), true), acrossInput()]));
  assert.equal(bridged.decoding.status, 'full');
  assert.equal(bridged.title, 'Swap 100 USDT for at least 99 USDC, then bridge to Ethereum');
  assert.match(bridged.summary, /then bridges the output to Ethereum through Across\.$/);
  assert.match(detail(bridged, 'Step 2')!, /^Bridge all of the router's USDC to Ethereum through Across: you receive at least 99\.5 USDC there if a relayer fills it by 20/);
  assert.ok(codes(bridged).includes('bridge_same_address'));
  assert.ok(!codes(bridged).some(c => ['recipient_not_sender', 'bridge_refund_other', 'bridge_message'].includes(c)));

  const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const plain = await send(UR21_ARB, exec([0x02, 0x40], [triple(USDC, ROUTER_SELF, 100_000_000n), acrossInput({ inputAmount: 100_000_000n, recipient: BOB, depositor: BOB, outputToken: BASE_USDC, chain: 8453n, message: '0x1234' })]));
  assert.equal(plain.title, 'Bridge 100 USDC to Base through Across');
  assert.match(detail(plain, 'Step 2')!, new RegExp(`${BOB} receives at least 99500000 base units of token ${BASE_USDC}`));
  for (const c of ['recipient_not_sender', 'bridge_refund_other', 'bridge_message']) assert.ok(codes(plain).includes(c), c);
});

test('Router 2.1: executeSigned shows who signed the route; HyperEVM routes wrap HYPE into WHYPE', async () => {
  const signer = privateKeyToAccount('0x2222222222222222222222222222222222222222222222222222222222222222');
  const commands = '0x00' as Hex, inputs = [swapIn21(MSG_SENDER, 100_000_000n, 10n ** 16n, v3path(USDC, 500, WETH), true)];
  const intent = `0x${'aa'.repeat(32)}` as Hex, data = `0x${'00'.repeat(32)}` as Hex, nonce = `0x${'00'.repeat(31)}07` as Hex;
  const signature = await signer.signTypedData({
    domain: { name: 'UniversalRouter', version: '2', chainId: 42161, verifyingContract: UR21_ARB },
    types: { ExecuteSigned: [{ name: 'commands', type: 'bytes' }, { name: 'inputs', type: 'bytes[]' }, { name: 'intent', type: 'bytes32' }, { name: 'data', type: 'bytes32' }, { name: 'sender', type: 'address' }, { name: 'nonce', type: 'bytes32' }, { name: 'deadline', type: 'uint256' }] },
    primaryType: 'ExecuteSigned', message: { commands, inputs, intent, data, sender: ALICE, nonce, deadline: DEADLINE },
  });
  const SIGNED = parseAbi(['function executeSigned(bytes commands, bytes[] inputs, bytes32 intent, bytes32 data, bool verifySender, bytes32 nonce, bytes signature, uint256 deadline) payable']);
  const call = encodeFunctionData({ abi: SIGNED, functionName: 'executeSigned', args: [commands, inputs, intent, data, true, nonce, signature, DEADLINE] });
  const p = await send(UR21_ARB, call);
  assert.equal(p.title, 'Swap 100 USDC for at least 0.01 WETH');
  assert.equal(detail(p, 'Route signature'), `signed by ${signer.address}; only you can submit it`);
  assert.equal(detail(p, 'Deadline'), new Date(Number(DEADLINE) * 1000).toISOString().replace('.000Z', 'Z'));
  // Signed by someone else for any sender: the recovered address differs, and that is what is shown.
  const anySender = encodeFunctionData({ abi: SIGNED, functionName: 'executeSigned', args: [commands, inputs, intent, data, false, nonce, signature, DEADLINE] });
  assert.match(detail(await send(UR21_ARB, anySender), 'Route signature')!, /^signed by 0x[0-9a-fA-F]{40}; anyone can submit it$/);
  // executeSigned doesn't exist before 2.1.
  assert.notEqual((await send(UR_ARB, call)).decoding.decoder, 'uniswap_universal_router');

  const WHYPE = '0x5555555555555555555555555555555555555555', USDT0 = '0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb';
  const hype = await send(UR22_HYPER, exec([0x0b, 0x00], [pair(ROUTER_SELF, CONTRACT_BALANCE), swapIn21(MSG_SENDER, CONTRACT_BALANCE, 40_000_000n, v3path(WHYPE, 3000, USDT0), false)]), 10n ** 18n, '0x3e7');
  assert.equal(hype.title, 'Swap 1 HYPE for at least 40 USDT0');
  assert.equal(detail(hype, 'Step 1'), 'Wrap all the HYPE sent into WHYPE, for the router, for a later step');
  assert.match(detail(hype, 'Contract')!, /^Uniswap Universal Router v2\.2\.0/);
});

test('Router 1.0: its own command table (0x1f mask, NFT-era purchases naming the NFT and buyer, 0x0e a placeholder)', async () => {
  const UR_V10_ETH = '0xEf1c6E67703c7BD7107eed8303Fbe6EC2554BF6B', BAYC = '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d';
  const swap = await send(UR_V10_ETH, exec([0x0b, 0x00], [pair(ROUTER_SELF, CONTRACT_BALANCE), swapIn(MSG_SENDER, CONTRACT_BALANCE, 3_000_000_000n, v3path('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', 500, ETH_USDC), false)]), 10n ** 18n, '0x1');
  assert.equal(swap.title, 'Swap 1 ETH for at least 3,000 USDC');
  assert.match(detail(swap, 'Contract')!, /^Uniswap Universal Router v1\.0/);
  // LOOKS_RARE_721: (value, data, recipient, token, id); the NFT goes to the recipient.
  const buy = encodeAbiParameters(parseAbiParameters('uint256, bytes, address, address, uint256'), [10n ** 18n, '0x1234', MSG_SENDER, BAYC, 42n]);
  const nft = await send(UR_V10_ETH, exec([0x11], [buy]), 10n ** 18n, '0x1');
  assert.match(detail(nft, 'Step 1')!, /^Buy NFT #42 of .+ on LooksRare, paying 1 ETH, for you$/);
  const gift = await send(UR_V10_ETH, exec([0x18], [encodeAbiParameters(parseAbiParameters('uint256, bytes, address, address, uint256'), [10n ** 18n, '0x', BOB, BAYC, 7n])]), 10n ** 18n, '0x1');
  assert.ok(codes(gift).includes('output_to_other'));
  // 0x0e is a balance check on 1.2 and later, but a placeholder (which reverts) on 1.0.
  const placeholder = await send(UR_V10_ETH, exec([0x0e], [triple(ALICE, ETH_USDC, 1n)]), 0n, '0x1');
  assert.equal(detail(placeholder, 'Step 1'), 'Unknown command 0x0e');
  // 1.0 masks commands with 0x1f: 0x21 (a sub-plan on 1.2) is 0x01 there, a v3 exact-output swap.
  const masked = await send(UR_V10_ETH, exec([0x21], [swapIn(MSG_SENDER, 1_000_000n, 10n ** 18n, v3path(ETH_USDC, 500, '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'), true)]), 0n, '0x1');
  assert.match(detail(masked, 'Step 1')!, /^Swap at most/);
});
