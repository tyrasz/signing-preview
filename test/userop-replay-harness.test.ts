// Pieces of the UserOperation replay harness (scripts/accuracy-4337.ts): its token side, account by account
// (scripts/userop-tokens.ts), and what a replay has warm (src/simulation.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareTokens, DEPOSIT, keptEarlier, movedAlike, TRANSFER, transfersOf, WITHDRAWAL, type Log } from '../scripts/userop-tokens.ts';
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
  assert.equal(kept.length, 401);
  assert.deepEqual(kept.slice(0, 2), [91, 289]);
  assert.equal(kept.at(-1), 688);
  // No more than the cap: all of them, in order.
  assert.deepEqual(keptEarlier(earlier.slice(0, 3), receipts, own, 400), [0, 1, 2]);
});
