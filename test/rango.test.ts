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

type Mined = { what: string; chainId: number; hash: string; from: string; to: string; value: string; moved: Record<string, string>; fromRouter: { token: string; to: string; value: string }[]; input: Hex };
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

/** Where the router sent most of a token, by the receipt's logs: past the fees, where the tokens went on this chain. */
const sentOn = (m: Mined, token: string) => m.fromRouter.filter(t => t.token === token).sort((a, b) => (BigInt(b.value) > BigInt(a.value) ? 1 : -1))[0].to;

test('Mined Rango transactions preview as what their receipts moved, and say where the tokens went only where it is read', async () => {
  const [tron, swapped, handed, both, routed] = await Promise.all(mined.map(replay));
  // A bridge to a chain off the EVM: named by its letters, the recipient by the start of its address there. Its
  // route's call is RangoRouter.route, which sends the tokens straight to an address the call names: read, shown,
  // and a caution (the request's recipient binds nothing: it read "Bridge contract 0xb8cf…" at information level,
  // the same whoever the call sent the tokens to).
  assert.equal(tron.title, 'Bridge 2,000 USDC to Tron (Rango)');
  assert.deepEqual([tron.decoding.decoder, tron.decoding.status, tron.attention], ['rango', 'partial', 'caution']);
  assert.deepEqual(paid(tron), mined[0].moved);
  assert.equal(detail(tron, 'Fee'), '16 USDC, out of what you send');
  assert.equal(detail(tron, 'Integrator'), 'TrustWallet');
  assert.match(detail(tron, 'Named recipient') ?? '', /^an address on Tron starting "T[1-9A-HJ-NP-Za-km-z]{19}"$/);
  assert.match(tron.warnings.find(w => w.code === 'bridge_non_evm')?.message ?? '', /^The destination is Tron: the recipient there is in the bridge's own data, which isn't decoded here\. The request names one starting "T/);
  assert.equal(detail(tron, 'Sent on this chain to'), sentOn(mined[0], USDC), 'where the receipt shows the router sending the tokens');
  assert.match(tron.warnings.find(w => w.code === 'route_forwards_tokens')?.message ?? '', /^On this chain the route sends the tokens straight to 0x9453a666a0c88b32095c92a3fe2ede9c82acfbbc, an address its call names/);
  assert.ok(!codes(tron).includes('route_call_not_read'));
  assert.ok(tron.decoding.notes.some(n => /^The destination and recipient are what the request names/.test(n)));
  // A swap (the older request): what is taken is the amount and the fees; the minimum was met, and went to the sender.
  assert.equal(swapped.title, 'Swap 71 USDT0 for at least 68.83347 USDC (Rango)');
  assert.deepEqual([swapped.decoding.status, swapped.attention], ['full', 'none']);
  assert.equal(paid(swapped)['0xc2132d05d31c914a87c6611c10748aeb04b58e8f'], mined[1].moved['0xc2132d05d31c914a87c6611c10748aeb04b58e8f']);
  const got = swapped.assetChanges.find(c => c.direction === 'in')!;
  assert.ok(BigInt(mined[1].moved[got.asset!]) >= BigInt(got.raw!), 'the receipt shows at least the minimum');
  assert.equal(sentOn(mined[1], got.asset!), mined[1].from, 'and the router sent what was bought to the sender');
  assert.equal(detail(swapped, 'Fee'), '0.6745 USDT0, out of what you send');
  // A "swap" that asks nothing back and buys nothing here, through a call that isn't read: nothing is said of where
  // the tokens go but that the call decides (here they did go into its contract; in half of those mined they didn't).
  assert.equal(handed.title, "Send 500.034703 USDC through Rango's router");
  assert.equal(handed.attention, 'caution');
  assert.equal(paid(handed)[USDC], mined[2].moved[USDC]);
  assert.equal(handed.assetChanges.length, 1, 'nothing is shown coming back');
  assert.equal(detail(handed, "Route's call"), '0xfa1b28052bd8087b1cf64ee9429feb324e95b0ff (function 0x966ca0ac)');
  assert.match(handed.warnings.find(w => w.code === 'route_call_not_read')?.message ?? '', /^Where the tokens go on this chain is decided by the route's call to 0xfa1b…b0ff, which isn't read here\./);
  assert.ok(!JSON.stringify([handed.title, handed.summary, handed.warnings]).includes('go into 0x'), 'no claim that they go into the target');
  assert.ok(!codes(handed).includes('no_slippage_limit'));
  // The same through RangoRouter.route: the address the tokens went to is the call's, not the contract's.
  assert.equal(routed.title, 'Send 69 USDT0 to 0x040a…64e8 through Rango');
  assert.equal(detail(routed, 'Sent on this chain to'), sentOn(mined[4], '0xc2132d05d31c914a87c6611c10748aeb04b58e8f'));
  assert.notEqual(detail(routed, 'Sent on this chain to'), '0xb8cf3cdbc390180257295bf08cfdeca80dca9e8a');
  assert.equal(routed.warnings.find(w => w.code === 'route_forwards_tokens')?.severity, 'caution');
  // A swap, then a bridge of what it bought, by a call that isn't read.
  assert.equal(both.title, 'Swap and bridge 50 USDT to Polygon (Rango)');
  assert.deepEqual(paid(both), mined[3].moved);
  assert.equal(detail(both, 'Swapped first into (at least)'), '48.223489 USDC');
  assert.match(detail(both, 'Named recipient') ?? '', /^you \(0x73b6/);
  assert.ok(codes(both).includes('bridge_same_address') && codes(both).includes('bridge_message') && codes(both).includes('route_call_not_read'));
});

test('A Rango route whose call sends the tokens elsewhere doesn’t preview as the same request', async () => {
  // The router checks the route's contract and function against its owner's list, not what the call says: the
  // mined bridge to Tron with another address in its route() call sends the tokens there (run on Ethereum's state,
  // it moved 1,984 USDC to the address put in), and previewed word for word as the original.
  const to = '7e57ab1e00000000000000000000000000c0ffee', original = mined[0].input, at = original.indexOf('58b4e548');
  assert.ok(at > 0, 'the fixture is a route() call');
  const crafted = `${original.slice(0, at + 8 + 64 + 24)}${to}${original.slice(at + 8 + 128)}` as Hex;
  const [was, now] = await Promise.all([replay(mined[0]), send(crafted, { from: mined[0].from })]);
  assert.equal(detail(now, 'Sent on this chain to'), `0x${to}`);
  assert.notEqual(detail(now, 'Sent on this chain to'), detail(was, 'Sent on this chain to'));
  assert.match(now.warnings.find(w => w.code === 'route_forwards_tokens')?.message ?? '', new RegExp(`straight to 0x${to}`));
  // To the sender's own address there is nothing to caution of.
  const own = `${original.slice(0, at + 8 + 64 + 24)}${mined[0].from.slice(2)}${original.slice(at + 8 + 128)}` as Hex;
  const mine = await send(own, { from: mined[0].from });
  assert.match(detail(mine, 'Sent on this chain to') ?? '', /^you \(/);
  assert.ok(!codes(mine).includes('route_forwards_tokens'));
  // Any other call of a route isn't read, and is never ranked under an unread call anywhere: a caution.
  const unread = await send(genericBridge(bridgeTo(8453n, ALICE), USDC, 1_000_000_000n));
  assert.equal(unread.attention, 'caution');
  assert.equal(unread.warnings.find(w => w.code === 'route_call_not_read')?.severity, 'caution');
  // route()'s selector on another contract is another function.
  const lookalike = await send(genericBridge({ ...bridgeTo(8453n, ALICE), calls: [{ target: SERVICE as Hex, spender: SERVICE as Hex, data: `0x58b4e548${'00'.repeat(96)}` as Hex, startIndexForAmount: 0n, nativeValueToSend: 0n, valueIsBridgeAmount: false }] }, USDC, 1_000_000_000n));
  assert.equal(detail(lookalike, 'Sent on this chain to'), undefined);
  assert.ok(codes(lookalike).includes('route_call_not_read'));
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
  // Fees out of what is bought with no minimum asked: there is nothing to take a share of (it read "100% of what
  // is bought goes in fees", as a danger).
  const noBasis = await send(onChainSwaps(swap({ fee: 5_000_000n, min: 0n, feeFromInputToken: false }), [step(USDC, USDT, 990_000_000n)], ALICE));
  assert.ok(!codes(noBasis).includes('large_fee_portion') && codes(noBasis).includes('no_slippage_limit'), codes(noBasis).join());
  // Coin sent beside a swap from a token leaves the sender, and the swap has no use for it.
  const beside = await send(onChainSwaps(swap(), [step(USDC, USDT, 990_000_000n)], ALICE), { value: 10n ** 18n });
  assert.match(beside.warnings.find(w => w.code === 'value_not_used')?.message ?? '', /^The call carries 1 ETH that a swap from a token has no use for/);
  assert.deepEqual(beside.assetChanges.map(c => [c.direction, c.amount, c.symbol]), [['out', '990', 'USDC'], ['out', '1', 'ETH'], ['in', '980', 'USDT']]);
  // Coin in: the amount and fee are what the call must carry.
  const coin = await send(onChainSwaps(swap({ from: ZERO, amountIn: 10n ** 18n, fee: 10n ** 16n, min: 3_000_000_000n }), [step(ZERO, USDT, 10n ** 18n)], ALICE), { value: 101n * 10n ** 16n });
  assert.equal(coin.title, 'Swap 1.01 ETH for at least 3,000 USDT (Rango)');
});

test('Rango bridges: a recipient that isn’t the sender, the bridge’s own fee, a destination named by letters; where each facet is read', async () => {
  const self = await send(genericBridge(bridgeTo(8453n, ALICE), USDC, 992_000_000n, 8_000_000n));
  assert.equal(self.title, 'Bridge 1,000 USDC to Base (Rango)');
  assert.equal(detail(self, "Route's call"), `${SERVICE} (function 0xdeadbeef)`);
  assert.match(detail(self, 'Named recipient') ?? '', /^you \(/);
  const other = await send(genericBridge(bridgeTo(8453n, BOB, { message: true }), USDC, 1_000_000_000n));
  assert.match(other.warnings.find(w => w.code === 'recipient_not_sender')?.message ?? '', /^The request names 0x[0-9a-f]{40} as the recipient on Base, not your address\.$/);
  assert.match(other.warnings.find(w => w.code === 'bridge_message')?.message ?? '', /also runs a call on Base/);
  // Coin: what is bridged and its fee, and what the call carries over that for the bridge.
  const coin = await send(genericBridge(bridgeTo(56n, ALICE), ZERO, 10n ** 18n, 10n ** 16n), { value: 102n * 10n ** 16n });
  assert.equal(coin.title, 'Bridge 1.01 ETH to BNB Chain (Rango)');
  assert.equal(detail(coin, "Bridge's own fee"), '0.01 ETH, sent with the call');
  // All the coin the call carries leaves (the router gives none back): it showed 1.01 leaving of 1.02.
  assert.deepEqual(coin.assetChanges.map(c => [c.direction, c.amount, c.symbol]), [['out', '1.02', 'ETH']]);
  const withToken = await send(genericBridge(bridgeTo(56n, ALICE), USDC, 1_000_000_000n), { value: 5n * 10n ** 16n });
  assert.deepEqual(withToken.assetChanges.map(c => [c.direction, c.amount, c.symbol]), [['out', '1,000', 'USDC'], ['out', '0.05', 'ETH']]);
  // Before a bridge, a swap from coin keeps the bridge's fee (extraFee) on top of the amount and the fees.
  const swapAndBridge = (request: ReturnType<typeof swap>, extraFee: bigint) => encodeFunctionData({ abi: RANGO_ABI, functionName: 'genericSwapAndBridge', args: [request, [step(request.fromToken, request.toToken, request.amountIn)], { ...bridgeTo(8453n, ALICE), extraFee }] });
  const kept = await send(swapAndBridge(swap({ from: ZERO, to: USDC, amountIn: 10n ** 18n, fee: 10n ** 16n, min: 3_000_000_000n }), 5n * 10n ** 16n), { value: 106n * 10n ** 16n });
  assert.equal(detail(kept, 'You send'), '1.01 ETH');
  assert.equal(detail(kept, "Bridge's own fee"), '0.05 ETH, sent with the call');
  assert.deepEqual(kept.assetChanges.map(c => [c.direction, c.amount, c.symbol]), [['out', '1.06', 'ETH']]);
  const tokenIn = await send(swapAndBridge(swap(), 5n * 10n ** 16n), { value: 5n * 10n ** 16n });
  assert.deepEqual(tokenIn.assetChanges.map(c => [c.direction, c.amount, c.symbol]), [['out', '990', 'USDC'], ['out', '0.05', 'ETH']]);
  // A destination off the EVM that isn't one of the three seen: the letters its number spells.
  const ton = await send(genericBridge(bridgeTo(0x544f4en, `0x${Buffer.from('UQBvW8Z5huBkMJYdnfAE').toString('hex')}`), USDC, 5_000_000n));
  assert.equal(detail(ton, 'Destination'), '"TON" (as Rango names it; not an EVM chain)');
  assert.equal(detail(ton, 'Named recipient'), 'an address on "TON" starting "UQBvW8Z5huBkMJYdnfAE"');
  // A chain id can spell letters (Aurora's is "NEAR"): with an address for its recipient it is an EVM chain, and a
  // recipient that isn't the sender is cautioned of (it was information, as a chain off the EVM).
  const aurora = await send(genericBridge(bridgeTo(1313161554n, BOB), USDC, 5_000_000n));
  assert.equal(detail(aurora, 'Destination'), 'Aurora');
  assert.equal(aurora.warnings.find(w => w.code === 'recipient_not_sender')?.severity, 'caution');
  const spelled = await send(genericBridge(bridgeTo(0x414243n, BOB), USDC, 5_000_000n));
  assert.equal(detail(spelled, 'Destination'), 'chain 4276803');
  assert.ok(codes(spelled).includes('recipient_not_sender'));
  // HyperEVM: the bridge facet is the published build; the older swap facet isn't published, and isn't read.
  assert.equal((await send(genericBridge(bridgeTo(1n, ALICE), ZERO, 10n ** 18n), { chainId: 999, value: 10n ** 18n })).decoding.decoder, 'rango');
  assert.notEqual((await send(mined[1].input, { chainId: 999, from: mined[1].from })).decoding.decoder, 'rango');
  assert.equal((await send(mined[1].input, { chainId: 10, from: mined[1].from })).decoding.decoder, 'rango');
  // Another contract with the same call isn't Rango's.
  assert.notEqual((await send(mined[0].input, { to: BOB })).decoding.decoder, 'rango');
});
