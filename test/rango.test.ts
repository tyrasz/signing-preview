// Rango's router (src/evm/rango.ts): its swap and bridge calls, read from the facets' published sources and checked
// here against four mined transactions and what their receipts moved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encodeFunctionData, toHex, type Hex } from 'viem';
import { previewRequest } from '../src/preview.ts';
import { StaticTokenRegistry } from '../src/chains.ts';
import { RANGO, RANGO_ABI } from '../src/evm/rango.ts';
import { ALICE, BOB } from '../mocks/data.ts';
import { codes, detail, NOW } from './helpers.ts';

type Mined = { what: string; chainId: number; hash: string; from: string; to: string; value: string; moved: Record<string, string>; input: Hex };
const mined: Mined[] = JSON.parse(readFileSync(new URL('./fixtures/rango.json', import.meta.url), 'utf8'));
const deps = { tokens: new StaticTokenRegistry() };
const send = (data: Hex, o: { chainId?: number; value?: bigint; from?: string; to?: string } = {}) => previewRequest(
  { method: 'eth_sendTransaction', params: [{ from: o.from ?? ALICE, to: o.to ?? RANGO, data, value: toHex(o.value ?? 0n), chainId: toHex(o.chainId ?? 1) }] }, { now: NOW }, deps);
const replay = (m: Mined) => send(m.input, { chainId: m.chainId, value: BigInt(m.value), from: m.from });
/** What a preview says leaves the sender, per token, against what the receipt's logs moved. */
const paid = (p: Awaited<ReturnType<typeof send>>) => Object.fromEntries(p.assetChanges.filter(c => c.direction === 'out').map(c => [c.asset, `-${c.raw}`]));

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7', DAI = '0x6b175474e89094c44da98b954eedeac495271d0f', ZERO = '0x0000000000000000000000000000000000000000';
const DEX = '0x00000000000000000000000000000000000000d1', SERVICE = '0x00000000000000000000000000000000000000c5', AFFILIATE = '0x00000000000000000000000000000000000000af';
const step = (from: string, to: string, amount: bigint, o: { target?: string; needsTransferFromUser?: boolean } = {}) =>
  ({ spender: (o.target ?? DEX) as Hex, target: (o.target ?? DEX) as Hex, swapFromToken: from as Hex, swapToToken: to as Hex, needsTransferFromUser: o.needsTransferFromUser ?? false, amount, callData: '0xdeadbeef' as Hex });
const swap = (o: { from?: string; to?: string; amountIn?: bigint; fee?: bigint; min?: bigint; feeFromInputToken?: boolean; dApp?: string } = {}) => ({
  requestId: ZERO as Hex, fromToken: (o.from ?? USDC) as Hex, toToken: (o.to ?? USDT) as Hex, amountIn: o.amountIn ?? 990_000_000n,
  affiliateFees: o.fee ? [{ affiliatorAddress: AFFILIATE as Hex, amount: o.fee, feeType: 0 }] : [], totalAffiliateFee: o.fee ?? 0n,
  minimumAmountExpected: o.min ?? 980_000_000n, feeFromInputToken: o.feeFromInputToken ?? true, dAppTag: 0, dAppName: o.dApp ?? 'A Wallet' });
const onChainSwaps = (request: ReturnType<typeof swap>, calls: ReturnType<typeof step>[], receiver: string) => encodeFunctionData({ abi: RANGO_ABI, functionName: 'onChainSwaps', args: [request, calls, receiver as Hex] } as never);
const bridgeTo = (dstChainId: bigint, recipient: string, o: { message?: boolean } = {}) => ({ bridgeId: 56, calls: [{ target: SERVICE as Hex, spender: SERVICE as Hex, data: '0xdeadbeef' as Hex, startIndexForAmount: 0n, nativeValueToSend: 0n, valueIsBridgeAmount: false }],
  recipient: recipient as Hex, dstChainId, hasInterchainMessage: o.message ?? false, hasDestinationSwap: false, extraFee: 0n, extraERC20Fee: 0n });
const genericBridge = (bridge: ReturnType<typeof bridgeTo>, token: string, amount: bigint, fee = 0n) => encodeFunctionData({ abi: RANGO_ABI, functionName: 'genericBridge',
  args: [bridge, { requestId: ZERO as Hex, token: token as Hex, amount, affiliateFees: fee ? [{ affiliatorAddress: AFFILIATE as Hex, amount: fee, feeType: 0 }] : [], totalAffiliateFee: fee, dAppTag: 0, dAppName: 'A Wallet' }] });

test('Mined Rango transactions preview as what their receipts moved: a bridge to Tron, a swap, a hand-over, a swap and bridge', async () => {
  const [tron, swapped, handed, both] = await Promise.all(mined.map(replay));
  // A bridge to a chain off the EVM: named by its letters, the recipient by the start of its address there.
  assert.equal(tron.title, 'Bridge 2,000 USDC to Tron (Rango)');
  assert.deepEqual([tron.decoding.decoder, tron.decoding.status], ['rango', 'partial']);
  assert.deepEqual(paid(tron), mined[0].moved);
  assert.equal(detail(tron, 'Fee'), '16 USDC, out of what you send');
  assert.equal(detail(tron, 'Integrator'), 'TrustWallet');
  assert.match(detail(tron, 'Recipient') ?? '', /^an address on Tron starting "T[1-9A-HJ-NP-Za-km-z]{19}"$/);
  assert.match(tron.warnings.find(w => w.code === 'bridge_non_evm')?.message ?? '', /^The destination is Tron: the recipient there is in the bridge's own data, which isn't decoded here\. The request names one starting "T/);
  assert.ok(tron.decoding.notes.some(n => /^The destination and recipient are what the request names/.test(n)));
  // A swap (the older request): what is taken is the amount and the fees; the minimum was met.
  assert.equal(swapped.title, 'Swap 71 USDT0 for at least 68.83347 USDC (Rango)');
  assert.equal(swapped.decoding.status, 'full');
  assert.equal(paid(swapped)['0xc2132d05d31c914a87c6611c10748aeb04b58e8f'], mined[1].moved['0xc2132d05d31c914a87c6611c10748aeb04b58e8f']);
  const got = swapped.assetChanges.find(c => c.direction === 'in')!;
  assert.ok(BigInt(mined[1].moved[got.asset!]) >= BigInt(got.raw!), 'the receipt shows at least the minimum');
  assert.equal(detail(swapped, 'Fee'), '0.6745 USDT0, out of what you send');
  // A "swap" that asks nothing back and buys nothing here: the tokens go into a cross-chain service.
  assert.match(handed.title, /^Send 500\.034703 USDC into 0xfa1b…[0-9a-f]{4} through Rango$/);
  assert.equal(paid(handed)[USDC], mined[2].moved[USDC]);
  assert.equal(handed.assetChanges.length, 1, 'nothing is shown coming back');
  assert.match(handed.warnings.find(w => w.code === 'bridge_terms_not_decoded')?.message ?? '', /^This asks for nothing back on this chain: the tokens go into 0xfa1b…/);
  assert.ok(!codes(handed).includes('no_slippage_limit'));
  // A swap, then a bridge of what it bought.
  assert.equal(both.title, 'Swap and bridge 50 USDT to Polygon (Rango)');
  assert.deepEqual(paid(both), mined[3].moved);
  assert.equal(detail(both, 'Swapped first into (at least)'), '48.223489 USDC');
  assert.match(detail(both, 'Recipient') ?? '', /^you \(0x73b6/);
  assert.ok(codes(both).includes('bridge_same_address') && codes(both).includes('bridge_message'));
});

test('Rango swaps: the newer request, fees out of what is bought, another receiver, no minimum, a call that takes tokens of its own', async () => {
  const fromOutput = await send(onChainSwaps(swap({ amountIn: 1_000_000_000n, fee: 5_000_000n, min: 985_000_000n, feeFromInputToken: false }), [step(USDC, USDT, 1_000_000_000n)], ALICE));
  assert.equal(fromOutput.title, 'Swap 1,000 USDC for at least 985 USDT (Rango)');
  assert.equal(detail(fromOutput, 'Fee'), '5 USDT, out of what is bought');
  assert.equal(detail(fromOutput, 'You receive at least'), '985 USDT, after the fee');
  assert.deepEqual(fromOutput.assetChanges.map(c => [c.direction, c.amount, c.symbol]), [['out', '1,000', 'USDC'], ['in', '985', 'USDT']]);
  assert.equal(fromOutput.attention, 'none');
  // Fees out of what is sent come on top of the amount.
  const fromInput = await send(onChainSwaps(swap({ amountIn: 990_000_000n, fee: 10_000_000n }), [step(USDC, USDT, 990_000_000n)], ALICE));
  assert.equal(detail(fromInput, 'You send'), '1,000 USDC');
  assert.match(fromInput.warnings.find(w => w.code === 'large_fee_portion')?.message ?? '', /^1% of what you send goes in fees\.$/);
  assert.equal((await send(onChainSwaps(swap({ amountIn: 800_000_000n, fee: 200_000_000n, min: 790_000_000n }), [step(USDC, USDT, 800_000_000n)], ALICE))).warnings.find(w => w.code === 'large_fee_portion')?.severity, 'danger');
  // What is bought goes to someone else.
  const other = await send(onChainSwaps(swap(), [step(USDC, USDT, 990_000_000n)], BOB));
  assert.match(other.warnings.find(w => w.code === 'recipient_not_sender')?.message ?? '', /^The tokens you buy go to 0x/);
  assert.equal(other.assetChanges.filter(c => c.direction === 'in').length, 0);
  // No minimum, with a call that does buy the token: a swap at any rate, unlike a hand-over.
  const open = await send(onChainSwaps(swap({ min: 0n }), [step(USDC, USDT, 990_000_000n)], ALICE));
  assert.equal(open.warnings.find(w => w.code === 'no_slippage_limit')?.severity, 'caution');
  assert.match(open.title, /^Swap 990 USDC for at least 0 USDT/);
  // A call marked to take tokens of its own from the sender.
  const extra = await send(onChainSwaps(swap(), [step(USDC, USDT, 990_000_000n), step(DAI, USDT, 5n * 10n ** 18n, { needsTransferFromUser: true })], ALICE));
  assert.match(extra.warnings.find(w => w.code === 'rango_call_takes_tokens')?.message ?? '', /a call of the route takes 5 DAI from you/);
  assert.deepEqual(extra.assetChanges.filter(c => c.direction === 'out').map(c => [c.amount, c.symbol]), [['990', 'USDC'], ['5', 'DAI']]);
  // Coin in: the amount and fee are what the call must carry.
  const coin = await send(onChainSwaps(swap({ from: ZERO, amountIn: 10n ** 18n, fee: 10n ** 16n, min: 3_000_000_000n }), [step(ZERO, USDT, 10n ** 18n)], ALICE), { value: 101n * 10n ** 16n });
  assert.equal(coin.title, 'Swap 1.01 ETH for at least 3,000 USDT (Rango)');
});

test('Rango bridges: a recipient that isn’t the sender, the bridge’s own fee, a destination named by letters; where each facet is read', async () => {
  const self = await send(genericBridge(bridgeTo(8453n, ALICE), USDC, 992_000_000n, 8_000_000n));
  assert.equal(self.title, 'Bridge 1,000 USDC to Base (Rango)');
  assert.equal(self.attention, 'info');
  assert.equal(detail(self, 'Bridge contract'), SERVICE);
  const other = await send(genericBridge(bridgeTo(8453n, BOB, { message: true }), USDC, 1_000_000_000n));
  assert.match(other.warnings.find(w => w.code === 'recipient_not_sender')?.message ?? '', /^The request names 0x[0-9a-f]{40} as the recipient on Base, not your address\.$/);
  assert.match(other.warnings.find(w => w.code === 'bridge_message')?.message ?? '', /also runs a call on Base/);
  // Coin: what is bridged and its fee, and what the call carries over that for the bridge.
  const coin = await send(genericBridge(bridgeTo(56n, ALICE), ZERO, 10n ** 18n, 10n ** 16n), { value: 102n * 10n ** 16n });
  assert.equal(coin.title, 'Bridge 1.01 ETH to BNB Chain (Rango)');
  assert.equal(detail(coin, "Bridge's own fee"), '0.01 ETH, sent with the call');
  // A destination off the EVM that isn't one of the three seen: the letters its number spells.
  const ton = await send(genericBridge(bridgeTo(0x544f4en, `0x${Buffer.from('UQBvW8Z5huBkMJYdnfAE').toString('hex')}`), USDC, 5_000_000n));
  assert.equal(detail(ton, 'Destination'), '"TON" (as Rango names it; not an EVM chain)');
  assert.equal(detail(ton, 'Recipient'), 'an address on "TON" starting "UQBvW8Z5huBkMJYdnfAE"');
  // HyperEVM: the bridge facet is the published build; the older swap facet isn't published, and isn't read.
  assert.equal((await send(genericBridge(bridgeTo(1n, ALICE), ZERO, 10n ** 18n), { chainId: 999, value: 10n ** 18n })).decoding.decoder, 'rango');
  assert.notEqual((await send(mined[1].input, { chainId: 999, from: mined[1].from })).decoding.decoder, 'rango');
  assert.equal((await send(mined[1].input, { chainId: 10, from: mined[1].from })).decoding.decoder, 'rango');
  // Another contract with the same call isn't Rango's.
  assert.notEqual((await send(mined[0].input, { to: BOB })).decoding.decoder, 'rango');
});
