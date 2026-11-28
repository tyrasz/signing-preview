// Pieces of the UserOperation replay harness (scripts/accuracy-4337.ts): its token side, account by account
// (scripts/userop-tokens.ts), and what a replay has warm (src/simulation.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { balanceAtTime, compareTokens, couldNotLook, DEPOSIT, differsIn, firstDifference, heldToBalance, keptEarlier, stateGone, movedAlike, TRANSFER, transfersOf, WITHDRAWAL, type Compared, type Log } from '../scripts/userop-tokens.ts';
import { RpcSimulator } from '../src/simulation.ts';

const word = (a: string) => `0x${a.slice(2).padStart(64, '0')}`;
const amount = (v: bigint) => `0x${v.toString(16).padStart(64, '0')}`;
const transfer = (token: string, from: string, to: string, v: bigint): Log => ({ address: token, topics: [TRANSFER, word(from), word(to)], data: amount(v) });
const ACCOUNT = '0x91b3fa363a0cd1177edf6b6deb6a8de4233786e3', SAFE = '0x117232f4df15282f99522dc9f7dda84b562f1ff3';
const USDT = '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', WETH = '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', OTHER = '0x56fa326c5a17d9b6f34381d5d1e9df7656ab63ae';
const isToken = async () => true;

test("A Safe's movements, shown by the preview of an operation running a transaction on it, are compared with the Safe's", async () => {
  // Arbitrum One, 2026-11-14: the account (an owner) runs execTransaction on its Safe, which sends 14,783 USDT; the
  // account itself moves nothing. Compared as the account's, the Safe's change showed as the account's 14,783 out.
  const own = [transfer(USDT, SAFE, OTHER, 14_783_285_303n)];
  const tokens = await compareTokens(own, ACCOUNT, [{ account: SAFE, asset: USDT, raw: '14783285303', direction: 'out', basis: 'simulated_state' }], isToken);
  assert.deepEqual(tokens, [{ token: USDT, actual: '-14783285303', simulated: '-14783285303', account: SAFE }]);
});

test('The same token moving between the account and its Safe is two comparisons, not one', async () => {
  const own = [transfer(USDT, SAFE, ACCOUNT, 100n)];
  const tokens = await compareTokens(own, ACCOUNT, [
    { account: ACCOUNT, asset: USDT, raw: '100', direction: 'in', basis: 'simulated_state' },
    { account: SAFE, asset: USDT, raw: '100', direction: 'out', basis: 'simulated_state' },
  ], isToken);
  assert.deepEqual(tokens, [{ token: USDT, actual: '100', simulated: '100' }, { token: USDT, actual: '-100', simulated: '-100', account: SAFE }]);
});

test("The account's own: Transfers and a token's Deposit; a preview's requested amounts and other contracts' Deposit events left out", async () => {
  const own = [transfer(USDT, ACCOUNT, OTHER, 5n), { address: WETH, topics: [DEPOSIT, word(ACCOUNT)], data: amount(7n) }, { address: OTHER, topics: [DEPOSIT, word(ACCOUNT)], data: amount(9n) }];
  const tokens = await compareTokens(own, ACCOUNT, [
    { account: ACCOUNT, asset: USDT, raw: '5', direction: 'out', basis: 'simulated_events' },
    { account: ACCOUNT, asset: WETH, raw: '7', direction: 'in', basis: 'requested' },
  ], async a => a === WETH);
  assert.deepEqual(tokens, [{ token: USDT, actual: '-5', simulated: '-5' }, { token: WETH, actual: '7', simulated: '0' }]);
});

test("A token's Transfers to and from an account, for telling whether a run moved it as the receipt did", () => {
  const mined = [transfer(USDT, OTHER, ACCOUNT, 315n), transfer(USDT, ACCOUNT, SAFE, 316n), transfer(WETH, ACCOUNT, SAFE, 1n), transfer(USDT, OTHER, SAFE, 2n)];
  assert.equal(transfersOf(mined, USDT, ACCOUNT), `${OTHER}>${ACCOUNT}:315,${ACCOUNT}>${SAFE}:316`);
  assert.equal(transfersOf([transfer(USDT, OTHER, ACCOUNT, 315n), transfer(USDT, ACCOUNT, SAFE, 316n)], USDT, ACCOUNT), transfersOf(mined, USDT, ACCOUNT));
  assert.notEqual(transfersOf([transfer(USDT, OTHER, ACCOUNT, 314n), transfer(USDT, ACCOUNT, SAFE, 316n)], USDT, ACCOUNT), transfersOf(mined, USDT, ACCOUNT));
});

test("A run moved a token as the receipt did only if it logged the same for the account, a wrapper's Deposit and Withdrawal included, and the receipt logged some", () => {
  // A WETH-style wrapper's Withdrawal moves the account's balance as a Transfer does (movedBy counts it): a receipt
  // withdrawing 10,000 and a replay withdrawing 7,000 moved it differently, and the replay's balance change can't
  // stand for the receipt's.
  const withdrawal = (v: bigint): Log => ({ address: WETH, topics: [WITHDRAWAL, word(ACCOUNT)], data: amount(v) });
  const deposit = (v: bigint): Log => ({ address: WETH, topics: [DEPOSIT, word(ACCOUNT)], data: amount(v) });
  assert.equal(transfersOf([withdrawal(10_000n), deposit(3n), { address: WETH, topics: [WITHDRAWAL, word(OTHER)], data: amount(5n) }], WETH, ACCOUNT), `${ACCOUNT}>withdrawal:10000,deposit>${ACCOUNT}:3`);
  assert.ok(!movedAlike([withdrawal(7_000n)], [withdrawal(10_000n)], WETH, ACCOUNT));
  assert.ok(movedAlike([withdrawal(10_000n)], [withdrawal(10_000n)], WETH, ACCOUNT));
  assert.ok(movedAlike([transfer(USDT, OTHER, ACCOUNT, 315n)], [transfer(USDT, OTHER, ACCOUNT, 315n)], USDT, ACCOUNT));
  // A receipt that logs nothing for the token and the account: nothing tells a run that did what happened from one that didn't.
  assert.ok(!movedAlike([], [], WETH, ACCOUNT));
  assert.ok(!movedAlike([], [transfer(USDT, OTHER, ACCOUNT, 315n)], WETH, ACCOUNT));
});

test("A replay's warm addresses and slots (a bundle's earlier operations') are in each simulated call's access list", async () => {
  const bodies: { method: string; params: unknown[] }[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { method: string; params: unknown[] };
    bodies.push(body);
    const result = body.method === 'eth_simulateV1' ? [{ number: '0x65', calls: [{ status: '0x1', gasUsed: '0x5208', logs: [], returnData: '0x' }] }] : '0x';
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
  }) as unknown as typeof fetch;
  const slot = `0x${'0'.repeat(63)}9`;
  const sim = new RpcSimulator({ 8453: 'http://base.invalid' }, { fetchImpl, replay: () => ({ block: '0x64', warm: [OTHER, { address: USDT, storageKeys: [slot] }] }) });
  await sim.simulate({ chainId: 8453, from: ACCOUNT, to: SAFE, data: '0x', value: 0n, accessList: [{ address: WETH, storageKeys: [] }] });
  const call = (bodies.find(b => b.method === 'eth_simulateV1')!.params[0] as { blockStateCalls: { calls: { accessList?: unknown }[] }[] }).blockStateCalls[0].calls[0];
  assert.deepEqual(call.accessList, [{ address: WETH, storageKeys: [] }, { address: OTHER, storageKeys: [] }, { address: USDT, storageKeys: [slot] }]);
});

test("Past 400 earlier transactions, a replay keeps those that logged the bundle's own contracts' events, not its tokens'", () => {
  // Ethereum, block 26,449,645: the operation's bundle was its 689th transaction; the 91st had traded in the same
  // DacityCoin/WETH pair (Sync, Swap) and Uniswap v4 pool. With only the last 400 run first, the operation met the
  // pool without that trade: 0.4% short in USDC and 6% over in gas, and judged as if it had met the block.
  const PAIR = '0x2405e4c5417321976256018b683b31383cd9acba', V4 = '0x000000000004444c5dc75cb358380d2e3de08a90', USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
  const SYNC = '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1', V4_SWAP = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f';
  const event = (address: string, topic: string): Log => ({ address, topics: [topic, word(ACCOUNT)], data: '0x' });
  const earlier = Array.from({ length: 689 }, (_, i) => ({ hash: `0x${i.toString(16).padStart(64, '0')}` }));
  const receipts = new Map(earlier.map(t => [t.hash, { logs: [] as Log[] }]));
  receipts.get(earlier[91].hash)!.logs.push(event(PAIR, SYNC), event(V4, V4_SWAP));
  // Moving the same token, or another pool's events, isn't trading in the bundle's pool.
  receipts.get(earlier[50].hash)!.logs.push(transfer(USDC, OTHER, ACCOUNT, 5n));
  receipts.get(earlier[60].hash)!.logs.push(event(OTHER, SYNC));
  const own = [transfer(USDC, ACCOUNT, OTHER, 1n), event(PAIR, SYNC), event(V4, V4_SWAP)];
  const kept = keptEarlier(earlier, receipts, own, 400);
  // No more than 400 all told: the 91st, then the latest 399.
  assert.equal(kept.length, 400);
  assert.deepEqual(kept.slice(0, 2), [91, 290]);
  assert.equal(kept.at(-1), 688);
  // More related ones than room: the latest of them.
  const busy = new Map(earlier.map((t, i) => [t.hash, { logs: i % 2 ? [event(PAIR, SYNC)] : [] as Log[] }]));
  const most = keptEarlier(earlier, busy, own, 400);
  assert.equal(most.length, 400);
  assert.ok(most.every((i, n) => n === 0 || i > most[n - 1]));
  assert.ok(most.slice(0, -1).every(i => i % 2 === 1 || i >= 689 - 400), String(most.slice(0, 5)));
  // No more than the cap: all of them, in order.
  assert.deepEqual(keptEarlier(earlier.slice(0, 3), receipts, own, 400), [0, 1, 2]);
});

test("A balance that time alone wears away is read, before the transaction, at the time of the transaction's block", async () => {
  // Inverse FiRM's borrowing-rights token (DBR): a debt wears the balance away by the second, and the token logs
  // what was worn away as burned at the borrower's next movement. A batch on Ethereum (2026-11-24, 0x5c20ffdd…4055)
  // repaid part of a debt of 50,000: its receipt burned 11,495.6 DBR, its preview showed none moving, and the
  // balance, 2,617.14 after it, was 0.019 more on the parent block: twelve seconds of the debt.
  type Row = Compared & { balance?: string; unjudged?: string };
  const E = 10n ** 18n, burned = 11_495_605022831050228310n, after = 2_617_146081304479787386n, twelveSeconds = 50_000n * E * 12n / 31_536_000n;
  const row = (): Row[] => [{ token: USDT, actual: (-burned).toString(), simulated: '0' }];
  const balances = (before: bigint) => async (_t: string, when: 'before' | 'after') => (when === 'before' ? before : after);
  // Read at the parent's own time, the balance across the block is neither the logs' nor the preview's: seven
  // millionths of what is held, where a block's interest is allowed one.
  const drifted = row();
  await heldToBalance(drifted, ACCOUNT, [], balances(after + twelveSeconds));
  assert.deepEqual([drifted[0].balance, differsIn(drifted[0])], [undefined, true]);
  // Read at the block's time, it didn't move: the preview's.
  const aligned = row();
  await heldToBalance(aligned, ACCOUNT, [], balances(after));
  assert.deepEqual([aligned[0].balance, differsIn(aligned[0])], ['0', false]);

  // balanceAtTime asks the node's simulation for the balance on a block's state at another time.
  const asked: [string, unknown[]][] = [];
  const word = (v: bigint) => `0x${v.toString(16).padStart(64, '0')}`;
  const node = (simulate: () => unknown) => async (method: string, params: unknown[]) => { asked.push([method, params]); if (method === 'eth_simulateV1') return simulate(); return word(after + twelveSeconds); };
  assert.equal(await balanceAtTime(node(() => [{ calls: [{ status: '0x1', returnData: word(after) }] }]), USDT, ACCOUNT, '0x1942737', 1_795_532_435), after);
  assert.deepEqual(asked, [['eth_simulateV1', [{ blockStateCalls: [{ blockOverrides: { time: '0x6b05a693' }, calls: [{ to: USDT, data: `0x70a08231${ACCOUNT.slice(2).toLowerCase().padStart(64, '0')}` }] }] }, '0x1942737']]]);
  // A node that won't simulate, or whose simulated call fails, answers with the balance at the block's own time.
  for (const simulate of [() => { throw new Error('the method eth_simulateV1 does not exist/is not available'); }, () => [{ calls: [{ status: '0x0', returnData: '0x' }] }], () => undefined])
    assert.equal(await balanceAtTime(node(simulate), USDT, ACCOUNT, '0x1942737', 1_795_532_435), after + twelveSeconds);
  // State the node no longer has is said, not answered around.
  await assert.rejects(balanceAtTime(async () => { throw new Error('missing trie node'); }, USDT, ACCOUNT, '0x1942737', 1_795_532_435), /missing trie node/);
});

test("A token whose logs carry its interest is held to the account's balance across the block, within what a block adds to the whole of it", async () => {
  // Aave's aTokens log the interest since their holder's last movement with the next one: a withdrawal of 5,000
  // from a position of a million logs less than 5,000, and the preview shows the 5,000 the balance loses. Across
  // the block the balance also grows by the block's interest on all of it (0.0152 at 4% a year in twelve seconds).
  type Row = Compared & { balance?: string; unjudged?: string };
  const M = 1_000_000n, held = 1_000_000n * M, token = (actual: bigint, simulated: bigint): Row => ({ token: USDT, actual: actual.toString(), simulated: simulated.toString() });
  const balances = (before: bigint, after: bigint) => async (_t: string, when: 'before' | 'after') => (when === 'before' ? before : after);
  // The logs say 4,990, the preview 5,000, and the balance fell 5,000 less a block's interest: the preview's.
  const aave = [token(-4_990n * M, -5_000n * M)];
  await heldToBalance(aave, ACCOUNT, [], balances(held, held - 5_000n * M + 15_210n));
  assert.deepEqual([aave[0].balance, differsIn(aave[0])], [(-(5_000n * M) + 15_210n).toString(), false]);
  // (A millionth of the amount moved, the tolerance it had, is 5,000 base units: under the interest.)
  // A balance that says something else than the preview is a difference.
  const off = [token(-4_990n * M, -5_000n * M)];
  await heldToBalance(off, ACCOUNT, [], balances(held, held - 4_000n * M));
  assert.deepEqual([off[0].balance, off[0].unjudged, differsIn(off[0])], [undefined, undefined, true]);
  // Where the balance can't say, the token isn't judged: another transaction of the block moved it for the
  // account, or the node no longer has the balance.
  const moved = [token(-4_990n * M, -5_000n * M)];
  await heldToBalance(moved, ACCOUNT, [{ logs: [transfer(USDT, OTHER, ACCOUNT, 1n)] }], balances(held, held));
  assert.deepEqual([moved[0].unjudged, differsIn(moved[0])], ['another transaction of the block moved the token for the account', false]);
  const gone = [token(-4_990n * M, -5_000n * M)];
  await heldToBalance(gone, ACCOUNT, [], async () => { throw new Error('missing trie node'); });
  assert.deepEqual([gone[0].unjudged, differsIn(gone[0])], ["its balance across the block isn't served by the node any more", false]);
  // Amounts that agree are left alone, and so is another account's token (the preview's own account is what is read).
  const same = [token(-5n, -5n), { ...token(-4_990n * M, -5_000n * M), account: SAFE }];
  await heldToBalance(same, ACCOUNT, [], async () => { throw new Error('not asked'); });
  assert.deepEqual(same.map(t => [t.balance, t.unjudged]), [[undefined, undefined], [undefined, undefined]]);
  assert.deepEqual(same.map(differsIn), [false, true]);
});

test('a run that could not look is not a pass: blocks unread, or more failed reads than transactions compared', () => {
  // The node answered for no block it was asked for.
  assert.match(couldNotLook({}, 0, { read: 0, unread: 40 })!, /none of the 40 blocks/);
  assert.equal(couldNotLook({}, 0, { read: 40, unread: 3 }), null);
  // A quiet chain: nothing found, or only transactions that aren't the harness's to judge.
  assert.equal(couldNotLook({}, 0, { read: 300, unread: 0 }), null);
  assert.equal(couldNotLook({ "calldata that isn't a batch's": 30, 'the account was used earlier in the same block': 12, 'not an account running delegated code': 50 }, 0, { read: 300, unread: 0 }), null);
  // Reads that failed: a few beside many compared pass, most of what was found does not.
  const failed = { "its block's receipts could not be read": 6, 'error: fetch failed': 5, 'its state is no longer served by the node': 2 };
  assert.equal(couldNotLook(failed, 80, { read: 300, unread: 0 }), null);
  assert.match(couldNotLook(failed, 4, { read: 300, unread: 0 })!, /13 transactions could not be looked at .* against 4 compared/);
  // The reasons the harnesses record when the node fails them, as they word them: a replay it can't serve
  // (src/replay.ts wraps every failed read so), state it no longer has. Forty of either with none compared passed.
  assert.match(couldNotLook({ 'not replayable (UNAVAILABLE)': 40 }, 0)!, /40 transactions could not be looked at/);
  assert.match(couldNotLook({ 'its state is no longer served by the node': 40 }, 0)!, /40 transactions/);
  assert.equal(couldNotLook({ 'not replayable (UNSUPPORTED)': 40, "not a Safe whose configuration reads (another contract's execTransaction)": 40 }, 0), null);
  // Most blocks unread, and nine reads failed against one compared.
  assert.match(couldNotLook({}, 5, { read: 1, unread: 99 })!, /99 of the 100 blocks asked for could not be read/);
  assert.equal(couldNotLook({}, 5, { read: 60, unread: 9 }), null);
  assert.match(couldNotLook({ 'error: fetch failed': 9 }, 1)!, /9 transactions .* against 1 compared/);
  assert.equal(couldNotLook({ 'error: fetch failed': 2 }, 0), null);
  // (Three or more, and more than were compared, isn't a quiet chain; nor are previews that weren't simulated a pass.)
  assert.match(couldNotLook({ 'error: fetch failed': 9 }, 0)!, /9 transactions/);
  assert.match(couldNotLook({ 'not simulated': 4 }, 0)!, /4 transactions could not be looked at/);
  assert.equal(couldNotLook({ 'not simulated': 4 }, 30), null);
  assert.match(couldNotLook({ 'a read of the Safe failed': 10 }, 0)!, /10 transactions/);
});

test('a balance that moved as the logs say leaves the difference standing, and only state the node no longer has excuses a token', async () => {
  type Row = Compared & { balance?: string; unjudged?: string };
  const M = 1_000_000n, held = 1_000_000n * M, row = (actual: bigint, simulated: bigint): Row => ({ token: USDT, actual: actual.toString(), simulated: simulated.toString() });
  // The logs and the balance both say 5,000 left; the preview, 4,999.5. Within a millionth of what is held, it passed.
  const off = [row(-5_000n * M, -4_999n * M - M / 2n)];
  await heldToBalance(off, ACCOUNT, [], async (_t, when) => (when === 'before' ? held : held - 5_000n * M));
  assert.deepEqual([off[0].balance, off[0].unjudged, differsIn(off[0])], [undefined, undefined, true]);
  // A balance three base units off its logs is no reason to take a preview half a token off both: the balance
  // is the one to hold the preview to only where it is nearer the preview than the logs are.
  const drift = [row(-5_000n * M, -4_999n * M - M / 2n)];
  await heldToBalance(drift, ACCOUNT, [], async (_t, when) => (when === 'before' ? held : held - 5_000n * M + 3n));
  assert.deepEqual([drift[0].balance, differsIn(drift[0])], [undefined, true]);
  // A token that doesn't answer balanceOf (a revert, or nothing to read) isn't one whose state is gone.
  for (const failure of ['execution reverted', 'Cannot convert 0x to a BigInt']) {
    const unanswered = [row(-5_000n * M, -4_000n * M)];
    await heldToBalance(unanswered, ACCOUNT, [], async () => { throw new Error(failure); });
    assert.deepEqual([unanswered[0].unjudged, differsIn(unanswered[0])], [undefined, true], failure);
  }
  // State the node no longer has is.
  for (const failure of ['missing trie node 5f3a (path ) state 0x12 is not available', 'header not found', 'state at block #123 is pruned', 'historical state not available', 'No state available for block 0x12']) {
    assert.equal(stateGone(new Error(failure)), true, failure);
    const gone = [row(-5_000n * M, -4_000n * M)];
    await heldToBalance(gone, ACCOUNT, [], async () => { throw new Error(failure); });
    assert.deepEqual([typeof gone[0].unjudged, differsIn(gone[0])], ['string', false], failure);
  }
  assert.equal(stateGone(new Error('execution reverted: ERC20: no such function')), false);
});

test("Where a run's events first part from a receipt's: the event, whose it is, and the words that differ", () => {
  // A swap as mined and as previewed: the pool's event carries another amount out, and the transfers after it follow.
  const ENTRY_POINT = '0x0000000071727de22e5e9d8baf0edac6f37da032', POOL = '0x28e2ea090877bf75740558f6bfb36a5ffee9e9df', SWAP = `0x40e9cecb${'00'.repeat(28)}`;
  const swap = (out: bigint, fee: bigint): Log => ({ address: POOL, topics: [SWAP, word(ACCOUNT)], data: `0x${[400n, out, 7n, fee].map(v => v.toString(16).padStart(64, '0')).join('')}` });
  const own = (gas: bigint): Log => ({ address: ENTRY_POINT, topics: [`0x49628fd1${'00'.repeat(28)}`], data: amount(gas) });
  const receipt = [own(1n), transfer(USDT, ACCOUNT, POOL, 400n), swap(399_779n, 95n), transfer(WETH, POOL, ACCOUNT, 399_779n), own(541_765n)];
  const run = [transfer(USDT, ACCOUNT, POOL, 400n), swap(399_912n, 77n), transfer(WETH, POOL, ACCOUNT, 399_912n), own(552_333n)];
  // The EntryPoint's own events are left out of both (their gas is never the same, and a simulation logs fewer).
  assert.equal(firstDifference(receipt, run, ENTRY_POINT), `event 2 of 3 (${POOL} 0x40e9cecb): word 2 is 399779 in the receipt and 399912 in the run; word 4 is 95 in the receipt and 77 in the run`);
  assert.equal(firstDifference(receipt, receipt.slice(1), ENTRY_POINT), undefined);
  // Another contract's event, one side stopping short, and indexed values that differ.
  assert.equal(firstDifference(receipt, [transfer(WETH, ACCOUNT, POOL, 400n)], ENTRY_POINT), `event 1: ${USDT} 0xddf252ad in the receipt, ${WETH} 0xddf252ad in the run`);
  assert.equal(firstDifference(receipt, receipt.slice(0, 3), ENTRY_POINT), `event 3: only the receipt has it (${WETH} 0xddf252ad); the receipt has 3 events, the run 2`);
  assert.equal(firstDifference(receipt, [transfer(USDT, ACCOUNT, SAFE, 400n)], ENTRY_POINT), `event 1 (${USDT} 0xddf252ad): its indexed values differ`);
  // A word too large for an amount is shown in hex.
  assert.match(firstDifference([{ address: POOL, topics: [SWAP], data: `0x${'ff'.repeat(32)}` }], [{ address: POOL, topics: [SWAP], data: amount(1n) }], ENTRY_POINT) ?? '', /word 1 is 0xf{64} in the receipt and 1 in the run$/);
});
