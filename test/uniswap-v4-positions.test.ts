// Uniswap v4's PositionManager, called directly: liquidity added and removed and positions opened, on mined
// transactions (Ethereum, 2026-11-23) and on the same calls changed to what an attacker would ask for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, parseAbi, parseAbiParameters, type Hex } from 'viem';
import { previewRequest } from '../src/preview.ts';
import { StaticTokenRegistry } from '../src/chains.ts';
import type { Dependencies, Simulator } from '../src/types.ts';
import { codes, detail } from './helpers.ts';

type Mined = { from: string; to: string; value: Hex; input: Hex; transfers: { token: string; from: string; to: string; raw: string }[] };
const F = JSON.parse(readFileSync(new URL('./fixtures/uniswap-v4-positions.json', import.meta.url), 'utf8')) as Record<'add' | 'openNewPool' | 'remove' | 'openWithCoin' | 'openWithPermit' | 'addWithSweep', Mined>;
const MANAGER = '0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e', POOL_MANAGER = '0x000000000004444c5dc75cb358380d2e3de08a90', PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7', NATIVE = '0x0000000000000000000000000000000000000000';
const ALICE = '0x00000000000000000000000000000000000a11ce', EVIL = '0x96221423681a6d52e184d440a8efcebb105c7242', HOOK = '0x00000000000000000000000000000000000c0de0';
const SENDER = '0x0000000000000000000000000000000000000001', THIS = '0x0000000000000000000000000000000000000002';
const KEY = '(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)';
const ABI = parseAbi(['function modifyLiquidities(bytes unlockData, uint256 deadline) payable', 'function multicall(bytes[] data) payable returns (bytes[])',
  'function permitBatch(address owner, ((address token, uint160 amount, uint48 expiration, uint48 nonce)[] details, address spender, uint256 sigDeadline) permitBatch, bytes signature) payable returns (bytes)',
  'function subscribe(uint256 tokenId, address newSubscriber, bytes data) payable', 'function transferFrom(address from, address to, uint256 id)']);
// Mined calls are previewed at a time before their deadlines (they were mined on 2026-11-23).
const WHEN = Date.UTC(2026, 10, 23, 9, 0, 0), LATER = BigInt(Math.floor(WHEN / 1000) + 1800);
const offline: Dependencies = { tokens: new StaticTokenRegistry() };
/** A chain that answers the manager's getPoolAndPositionInfo with this pool. */
const withPool = (k: { currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string }): Dependencies => ({ tokens: new StaticTokenRegistry(), rpc: { has: () => true, call: async (_c: number, m: string, p: unknown[]) => {
  const q = p[0] as { to?: string; data?: string };
  if (m === 'eth_call' && q.to === MANAGER && q.data?.startsWith('0x7ba03aad')) return encodeAbiParameters(parseAbiParameters(`${KEY} k, uint256 info`), [k as never, 1n]);
  return '0x';
} } });
const send = (t: { from: string; to?: string; input: Hex; value?: Hex | bigint }, d = offline, now = WHEN, chainId = '0x1') =>
  previewRequest({ method: 'eth_sendTransaction', params: [{ from: t.from, to: t.to ?? MANAGER, data: t.input, value: typeof t.value === 'bigint' ? `0x${t.value.toString(16)}` : t.value ?? '0x0', chainId }] }, { now }, d);
/** modifyLiquidities calldata from action bytes and their parameters. */
const plan = (actions: number[], params: Hex[], deadline = LATER) => encodeFunctionData({ abi: ABI, functionName: 'modifyLiquidities',
  args: [encodeAbiParameters(parseAbiParameters('bytes, bytes[]'), [`0x${actions.map(a => a.toString(16).padStart(2, '0')).join('')}`, params]), deadline] });
const enc = (types: string, values: unknown[]) => encodeAbiParameters(parseAbiParameters(types), values as never);
const decrease = (id: bigint, liquidity: bigint, min0: bigint, min1: bigint) => enc('uint256, uint256, uint128, uint128, bytes', [id, liquidity, min0, min1, '0x']);
const takePair = (to: string, c0 = USDC, c1 = USDT) => enc('address, address, address', [c0, c1, to]);
const mint = (owner: string, c0 = NATIVE, c1 = USDC, hooks = NATIVE) => enc(`${KEY}, int24, int24, uint256, uint128, uint128, address, bytes`, [{ currency0: c0, currency1: c1, fee: 3000, tickSpacing: 60, hooks }, -600, 600, 10n ** 12n, 10n ** 16n, 25_000_000n, owner, '0x']);
/** The unlock data of a mined modifyLiquidities call, and the calls of a mined multicall. */
const inner = (input: Hex) => decodeFunctionData({ abi: ABI, data: input }).args as readonly unknown[];

test('Liquidity removed from a Uniswap v4 position: the least it must pay out, and to whom', async () => {
  // It was a call that couldn't be decoded. Mined: [decrease, take pair], paid out to the sender.
  const p = await send(F.remove);
  assert.match(p.title, /^Remove liquidity from Uniswap v4 position #521804 \(0x8261…678a\/0xd82f…153d\): at least 0 base units of 0x8261…678a and 3949683531626006871705 base units of 0xd82f…153d$/);
  assert.deepEqual([p.decoding.decoder, p.decoding.status, p.attention], ['uniswap_v4_position', 'full', 'none']);
  assert.equal(detail(p, 'Action 2'), 'take out what is owed of 0x8261…678a and 0xd82f…153d to you');
  // What its receipt shows the sender got is no less than the minimum the preview states.
  const got = F.remove.transfers.filter(t => t.to === F.remove.from && t.from === POOL_MANAGER);
  assert.equal(got.length, 2);
  assert.ok(BigInt(got[1].raw) >= 3949683531626006871705n);

  // The same liquidity, paid out to another address: it is theirs.
  const id = 521804n, L = 10n ** 15n;
  const away = await send({ from: ALICE, input: plan([0x01, 0x11], [decrease(id, L, 1n, 1n), takePair(EVIL)]) });
  assert.equal(away.attention, 'danger');
  assert.equal(away.warnings.find(w => w.code === 'recipient_not_sender')!.message, `What is taken out of USDC and USDT goes to ${EVIL}, not to you.`);
  assert.equal(detail(away, 'Action 1'), 'remove liquidity from position #521804 (USDC/USDT), getting at least 0.000001 USDC and 0.000001 USDT');
  // The sender named in full, or by the constant that stands for it, is the sender.
  for (const to of [ALICE, SENDER]) assert.deepEqual(codes(await send({ from: ALICE, input: plan([0x01, 0x11], [decrease(id, L, 1n, 1n), takePair(to)]) })), []);
  // Left in the manager itself with no sweep after it: the next caller's to sweep.
  const left = await send({ from: ALICE, input: plan([0x01, 0x11], [decrease(id, L, 1n, 1n), takePair(THIS)]) });
  assert.deepEqual([left.attention, codes(left)], ['danger', ['v4_left_in_manager']]);
  assert.match(left.warnings[0].message, /^What is taken out of USDC and USDT is left in the position manager itself, and nothing in this call sends it on/);
  const sweep = (c: string, to: string) => enc('address, address', [c, to]);
  const sweptBack = await send({ from: ALICE, input: plan([0x01, 0x11, 0x14, 0x14], [decrease(id, L, 1n, 1n), takePair(THIS), sweep(USDC, SENDER), sweep(USDT, ALICE)]) });
  assert.deepEqual(codes(sweptBack), []);
  // A sweep before the take sends nothing of it on; nor does a sweep to the manager itself.
  for (const input of [plan([0x14, 0x14, 0x01, 0x11], [sweep(USDC, SENDER), sweep(USDT, SENDER), decrease(id, L, 1n, 1n), takePair(THIS)]), plan([0x01, 0x11, 0x14, 0x14], [decrease(id, L, 1n, 1n), takePair(THIS), sweep(USDC, THIS), sweep(USDT, THIS)])])
    assert.match((await send({ from: ALICE, input })).warnings.find(w => w.code === 'v4_left_in_manager')?.message ?? '', /of USDC and USDT is left/);
  // A sweep to someone else is theirs; what no sweep sends on is still left.
  const part = await send({ from: ALICE, input: plan([0x01, 0x11, 0x14], [decrease(id, L, 1n, 1n), takePair(THIS), sweep(USDC, EVIL)]) });
  assert.deepEqual(part.warnings.map(w => [w.code, w.message.slice(0, 40)]), [['v4_left_in_manager', 'What is taken out of USDT is left in the'], ['recipient_not_sender', 'What is taken out of USDC goes to 0x9622']]);
  // In a multicall, each call's warning is told, under the one code a preview carries.
  const two = await send({ from: ALICE, input: encodeFunctionData({ abi: ABI, functionName: 'multicall', args: [[plan([0x01, 0x11], [decrease(id, L, 1n, 1n), takePair(EVIL)]), plan([0x01, 0x11], [decrease(8n, L, 1n, 1n), takePair(HOOK)])]] }) });
  assert.equal(two.warnings.find(w => w.code === 'recipient_not_sender')!.message, `Call 1: what is taken out of USDC and USDT goes to ${EVIL}, not to you. Call 2: what is taken out of USDC and USDT goes to ${HOOK}, not to you.`);
  assert.match(two.title, /^2 Uniswap v4 position actions: Remove liquidity from Uniswap v4 position #521804/);
  // No minimum on either token: said. Fees collected (no liquidity removed) need none.
  const any = await send({ from: ALICE, input: plan([0x01, 0x11], [decrease(id, L, 0n, 0n), takePair(SENDER)]) });
  assert.deepEqual([any.attention, codes(any)], ['caution', ['no_slippage_limit']]);
  const fees = await send({ from: ALICE, input: plan([0x01, 0x11], [decrease(id, 0n, 0n, 0n), takePair(SENDER)]) });
  assert.deepEqual([fees.title, codes(fees)], ['Collect the fees of Uniswap v4 position #521804 (USDC/USDT)', []]);
  // A position closed (burned) is read the same way.
  const burn = await send({ from: ALICE, input: plan([0x03, 0x11], [enc('uint256, uint128, uint128, bytes', [id, 5_000_000n, 4_000_000n, '0x']), takePair(SENDER)]) });
  assert.equal(burn.title, 'Close Uniswap v4 position #521804 (USDC/USDT): at least 5 USDC and 4 USDT');
});

test('A position’s pool is read from the chain where it can be: its tokens, and a hook that runs on it', async () => {
  // [increase, close, close] names its two currencies; with a chain to ask, the pool is the position's own.
  const p = await send(F.add);
  assert.match(p.title, /^Add liquidity to Uniswap v4 position #525435 \(0x6440…b01d\/USDC\): up to 12687779829596418229079 base units of 0x6440…b01d and 12,699\.236975 USDC$/);
  assert.deepEqual([p.decoding.status, p.attention], ['full', 'none']);
  // Mined: what left the sender is within the maximum stated.
  const paid = F.add.transfers.filter(t => t.from === F.add.from);
  assert.deepEqual(paid.map(t => t.token), ['0x6440f144b7e50d6a8439336510312d2f54beb01d', USDC]);
  assert.ok(BigInt(paid[0].raw) <= 12687779829596418229079n && BigInt(paid[1].raw) <= 12_699_236975n);
  const hooked = await send(F.add, withPool({ currency0: USDC, currency1: USDT, fee: 100, tickSpacing: 1, hooks: HOOK }));
  assert.match(hooked.title, /^Add liquidity to Uniswap v4 position #525435 \(USDC\/USDT\)/);
  assert.deepEqual([hooked.attention, codes(hooked)], ['info', ['v4_hook']]);
  assert.match(hooked.warnings[0].message, new RegExp(`runs a hook contract \\(${HOOK}\\)`));
  // A position the chain doesn't know (an empty pool key) keeps the pair the call names.
  const unknown = await send(F.add, withPool({ currency0: NATIVE, currency1: NATIVE, fee: 0, tickSpacing: 0, hooks: NATIVE }));
  assert.match(unknown.title, /\(0x6440…b01d\/USDC\)/);
  // The amounts that stand for something else are told as what they stand for.
  const q = await send({ from: ALICE, input: plan([0x00, 0x0b, 0x0b, 0x0e, 0x0e, 0x15, 0x16, 0x13], [enc('uint256, uint256, uint128, uint128, bytes', [7n, 5n, 2_000_000n, 3_000_000n, '0x']),
    enc('address, uint256, bool', [USDC, 0n, true]), enc('address, uint256, bool', [USDT, 1n << 255n, false]), enc('address, address, uint256', [USDC, SENDER, 0n]), enc('address, address, uint256', [USDT, SENDER, 1_500_000n]),
    enc('uint256', [1n << 255n]), enc('uint256', [0n]), enc('address, uint256', [USDC, 10n])]) });
  assert.deepEqual([2, 3, 4, 5, 6, 7, 8].map(i => detail(q, `Action ${i}`)), ['pay in what is owed of USDC, from you', "pay in the manager's whole balance of USDT, from the manager's own balance", 'take out what is owed of USDC to you', 'take out 1.5 USDT to you',
    "wrap the manager's whole balance of ETH in the manager", 'unwrap as much wrapped ETH as the call owes of the other in the manager', 'settle USDC either way: pay in what is owed, or take out what is due, to you']);
  assert.deepEqual([q.decoding.status, codes(q)], ['full', []]);
});

test('A position opened: the most it may take in, who gets it, and the coin sent with it', async () => {
  // Mined: a multicall of permitBatch and [mint, settle pair, sweep], with the coin the position may take.
  const p = await send(F.openWithCoin);
  assert.match(p.title, /^Open a Uniswap v4 position in ETH\/0x00a6…cb12 \(fee 25%\): up to 0\.002863999499046685 ETH and 229757175632271385657 base units of 0x00a6…cb12$/);
  assert.deepEqual([p.decoding.decoder, p.decoding.status, p.attention, codes(p)], ['uniswap_v4_position', 'full', 'none', []]);
  assert.equal(detail(p, 'Coin sent with it'), "0.002863999499046685 ETH (what the position doesn't take is swept back)");
  assert.match(detail(p, 'Call 1: Permit2 allowance') ?? '', /^the position manager may take any amount of 0x00a6…cb12 from you until 2026-12-23/);
  assert.match(detail(p, 'Call 2: Action 1') ?? '', /the position goes to you$/);
  assert.ok(BigInt(F.openWithCoin.transfers[0].raw) <= 229757175632271385657n);
  // A new pool created on the way is said (mined: initializePool, permitBatch, then the position).
  const fresh = await send(F.openWithPermit);
  assert.match(fresh.title, /^Open a Uniswap v4 position in USDC\/0xe018…097c \(fee 10%\): up to 6\.585044 USDC and /);
  assert.equal(detail(fresh, 'Call 1: Creates the pool'), "0xa0b8…eb48 / 0xe018…097c, fee 10%, if it doesn't exist yet");
  assert.deepEqual([fresh.decoding.status, codes(fresh)], ['full', []]);
  assert.ok(F.openWithPermit.transfers[0].token === USDC && BigInt(F.openWithPermit.transfers[0].raw) <= 6_585044n);

  // Coin sent with no sweep to send back what the position doesn't take: it stays in the manager.
  const kept = await send({ from: ALICE, input: plan([0x02, 0x0d], [mint(SENDER), enc('address, address', [NATIVE, USDC])]), value: 10n ** 16n });
  assert.deepEqual([kept.attention, codes(kept)], ['caution', ['v4_coin_not_swept']]);
  assert.equal(detail(kept, 'Coin sent with it'), '0.01 ETH');
  assert.equal(kept.title, 'Open a Uniswap v4 position in ETH/USDC (fee 0.3%): up to 0.01 ETH and 25 USDC');
  const back = await send({ from: ALICE, input: plan([0x02, 0x0d, 0x14], [mint(ALICE), enc('address, address', [NATIVE, USDC]), enc('address, address', [NATIVE, SENDER])]), value: 10n ** 16n });
  assert.deepEqual(codes(back), []);
  // The position going to someone else is theirs to take out; a hook on the pool is said; a dynamic fee is the hook's.
  const gift = await send({ from: ALICE, input: plan([0x02, 0x0d], [mint(EVIL, USDC, USDT, HOOK), enc('address, address', [USDC, USDT])]) });
  assert.deepEqual([gift.attention, codes(gift)], ['caution', ['v4_hook', 'recipient_not_sender']]);
  assert.match(gift.warnings[1].message, new RegExp(`^The position opened goes to ${EVIL}, not to you`));
  const dynamic = enc(`${KEY}, int24, int24, uint256, uint128, uint128, address, bytes`, [{ currency0: USDC, currency1: USDT, fee: 0x800000, tickSpacing: 60, hooks: HOOK }, -600, 600, 1n, 1_000_000n, 1_000_000n, SENDER, '0x']);
  assert.equal((await send({ from: ALICE, input: plan([0x02, 0x0d], [dynamic, enc('address, address', [USDC, USDT])]) })).title, 'Open a Uniswap v4 position in USDC/USDT (a dynamic fee, set by its hook): up to 1 USDC and 1 USDT');
  // Sized from whatever the call is owed: what the manager's own source calls open to sandwiching.
  const deltas = enc(`${KEY}, int24, int24, uint128, uint128, address, bytes`, [{ currency0: USDC, currency1: USDT, fee: 500, tickSpacing: 10, hooks: NATIVE }, -600, 600, 1_000_000n, 1_000_000n, SENDER, '0x']);
  assert.deepEqual(codes(await send({ from: ALICE, input: plan([0x05, 0x0d], [deltas, enc('address, address', [USDC, USDT])]) })), ['v4_from_deltas']);
});

test('A Permit2 allowance submitted beside a position is for the manager, or it is said', async () => {
  const [calls] = inner(F.openWithPermit.input) as [Hex[]];
  const [owner, batch, signature] = decodeFunctionData({ abi: ABI, data: calls[1] }).args as readonly [string, { details: { token: string; amount: bigint; expiration: number; nonce: number }[]; spender: string; sigDeadline: bigint }, Hex];
  assert.equal(batch.spender.toLowerCase(), MANAGER);
  const permit = (o: string, spender: string) => encodeFunctionData({ abi: ABI, functionName: 'permitBatch', args: [o as Hex, { ...batch, spender: spender as Hex } as never, signature] });
  const other = await send({ ...F.openWithPermit, input: encodeFunctionData({ abi: ABI, functionName: 'multicall', args: [[calls[0], permit(owner, EVIL), calls[2]]] }) });
  assert.equal(other.attention, 'danger');
  assert.match(other.warnings.find(w => w.code === 'v4_permit_other_spender')!.message, new RegExp(`an allowance you signed for ${EVIL}, which isn't the position manager`));
  assert.match(detail(other, 'Call 2: Permit2 allowance') ?? '', new RegExp(`^${EVIL} may take any amount of 0xe018…097c from you`));
  const theirs = await send({ ...F.openWithPermit, input: encodeFunctionData({ abi: ABI, functionName: 'multicall', args: [[calls[0], permit(EVIL, MANAGER), calls[2]]] }) });
  assert.deepEqual([theirs.attention, codes(theirs)], ['caution', ['v4_permit_other_owner']]);

  // The allowance the simulation sees set through Permit2 is the one shown: not reported again as hidden.
  const sim: Simulator = { simulate: async () => ({ status: 'success', source: 'test', transfers: [],
    approvals: [{ kind: 'permit2', emitter: PERMIT2, token: batch.details[0].token.toLowerCase(), owner: F.openWithPermit.from, spender: MANAGER, amount: (1n << 160n) - 1n, expiration: batch.details[0].expiration }] }) };
  const shown = await send(F.openWithPermit, { tokens: new StaticTokenRegistry(), simulator: sim });
  assert.ok(shown.approvals?.length === 1 && !codes(shown).includes('hidden_unlimited_approval'));
  // One it doesn't show (another spender's) still is.
  const hidden: Simulator = { simulate: async () => ({ status: 'success', source: 'test', transfers: [], approvals: [{ kind: 'permit2', emitter: PERMIT2, token: batch.details[0].token.toLowerCase(), owner: F.openWithPermit.from, spender: EVIL, amount: (1n << 160n) - 1n, expiration: batch.details[0].expiration }] }) };
  assert.ok(codes(await send(F.openWithPermit, { tokens: new StaticTokenRegistry(), simulator: hidden })).includes('hidden_unlimited_approval'));
});

test('What of a position manager call isn’t read is said, and other calls are left to their own decoders', async () => {
  // An action the manager doesn't run, parameters that don't decode, actions and parameters that don't pair up.
  const id = 9n, dec = decrease(id, 1n, 1n, 1n);
  const odd = await send({ from: ALICE, input: plan([0x01, 0x07, 0x11], [dec, '0x', takePair(SENDER)]) });
  assert.deepEqual([odd.decoding.status, codes(odd)], ['partial', ['v4_unread']]);
  assert.equal(detail(odd, 'Action 2'), "action 0x07, which the position manager doesn't take");
  const cut = await send({ from: ALICE, input: plan([0x01, 0x11], [dec, '0x1234']) });
  assert.deepEqual([cut.decoding.status, detail(cut, 'Action 2')], ['partial', "action 0x11, whose parameters can't be read"]);
  const uneven = await send({ from: ALICE, input: plan([0x01, 0x11], [dec]) });
  assert.deepEqual([uneven.decoding.status, uneven.attention, uneven.title], ['partial', 'danger', 'Uniswap v4 position actions the manager rejects']);
  const garbage = await send({ from: ALICE, input: encodeFunctionData({ abi: ABI, functionName: 'modifyLiquidities', args: ['0x1234', LATER] }) });
  assert.deepEqual([garbage.decoding.status, codes(garbage)], ['partial', ['v4_unread']]);
  // A deadline that has passed: the manager reverts.
  const late = await send({ from: ALICE, input: plan([0x01, 0x11], [dec, takePair(SENDER)], BigInt(Math.floor(WHEN / 1000) - 60)) });
  assert.deepEqual([codes(late), detail(late, 'Valid until')], [['deadline_passed'], '2026-11-23T08:59:00Z']);
  // A multicall with a call that isn't read beside the liquidity.
  const sub = encodeFunctionData({ abi: ABI, functionName: 'subscribe', args: [id, EVIL as Hex, '0x'] });
  const mixed = await send({ from: ALICE, input: encodeFunctionData({ abi: ABI, functionName: 'multicall', args: [[plan([0x01, 0x11], [dec, takePair(SENDER)]), sub]] }) });
  assert.deepEqual([mixed.decoding.decoder, mixed.decoding.status, codes(mixed)], ['uniswap_v4_position', 'partial', ['v4_unread']]);
  assert.match(detail(mixed, 'Call 2: Call') ?? '', /^0x[0-9a-f]{8} on the position manager, which isn't read$/);
  // The position's own NFT moves, and a manager's address on a chain where it isn't the manager, aren't this decoder's.
  const nft = await send({ from: ALICE, input: encodeFunctionData({ abi: ABI, functionName: 'transferFrom', args: [ALICE as Hex, EVIL as Hex, id] }) });
  assert.notEqual(nft.decoding.decoder, 'uniswap_v4_position');
  const elsewhere = await send({ from: ALICE, input: plan([0x01, 0x11], [dec, takePair(SENDER)]) }, offline, WHEN, '0x2105');
  assert.notEqual(elsewhere.decoding.decoder, 'uniswap_v4_position');
});
