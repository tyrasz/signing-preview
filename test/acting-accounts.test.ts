// What a simulation says of the accounts a transaction has act (the account in the sender's place, the accounts its
// calls hand calls on to) beside the sender, and what a batch run as one transaction warns of: an independent
// review's findings (2026-11-25), each as it read before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionData, parseAbi, type Hex } from 'viem';
import { previewRequest } from '../src/preview.ts';
import { normalizeTransaction, previewTransaction } from '../src/evm/transaction.ts';
import { StaticTokenRegistry } from '../src/chains.ts';
import { ALICE, BOB } from '../mocks/data.ts';
import type { Dependencies, SimulationRequest, SimulationResult } from '../src/types.ts';
import { codes, NOW } from './helpers.ts';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', NFT = '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d';
const WALLET = '0x5ca1ab1e00000000000000000000000000c0ffee', EVIL = '0x96221423681a6d52e184d440a8efcebb105c7242', POOL = '0x00000000000000000000000000000000000900f1';
const alice = ALICE.toLowerCase(), bob = BOB.toLowerCase();
const ERC20 = parseAbi(['function transfer(address,uint256)']);
const ACCOUNT = parseAbi(['function execute(address target, uint256 value, bytes data)', 'function executeBatch((address target, uint256 value, bytes data)[] calls)']);
const transfer = (to: string, amount: bigint) => encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [to as Hex, amount] });
const execute = (target: string, data: Hex) => encodeFunctionData({ abi: ACCOUNT, functionName: 'execute', args: [target as Hex, 0n, data] });
const tokens = new StaticTokenRegistry();
const ok = (o: Partial<SimulationResult> = {}): SimulationResult => ({ status: 'success', source: 'mock', gasUsed: 100_000n, balancesRead: true, transfers: [], ...o });
const unlimited = (owner: string, token: string) => ({ kind: 'erc20' as const, emitter: token, token, owner, spender: EVIL, amount: (1n << 256n) - 1n });
const operator = (owner: string) => ({ kind: 'operator' as const, emitter: NFT, token: NFT, owner, spender: EVIL, approved: true });
const send = (from: string, to: string, data: Hex, d: Dependencies) => previewRequest({ method: 'eth_sendTransaction', params: [{ from, to, data, value: '0x0', chainId: '0x1' }] }, { now: NOW }, d);

test('A batch run as one transaction warns of the approvals set along the way, as its calls’ own runs would', async () => {
  // The calls have no runs of their own there: the operator approval a call leaves raised nothing, and a preview
  // that was a danger run a transaction each was a caution run as one (which a dApp can make it: a call that leans
  // on what another leaves for the transaction).
  const X = '0x5e55100000000000000000000000000000005e55', approvals = [operator(alice), unlimited(alice, WETH)], moved = [{ asset: USDC, from: alice, to: bob, raw: 5_000_000n }];
  const d: Dependencies = { tokens, rpc: { has: () => true, call: async (_c: number, m: string) => (m === 'eth_getCode' ? `0xef0100${'11'.repeat(20)}` : '0x') },
    simulator: { simulate: async () => ok({ transfers: moved, approvals }), simulateBatch: async rs => rs.map((_, i) => (i === 2 ? { status: 'reverted' as const, source: 'mock', gasUsed: 30_000n, transfers: [], revertReason: 'no session' } : ok({ transfers: i === 1 ? moved : [] }))) } };
  const p = await previewRequest({ method: 'wallet_sendCalls', params: [{ version: '2.0.0', chainId: '0x1', from: ALICE, atomicRequired: true, calls: [{ to: X, data: '0x' }, { to: USDC, data: transfer(BOB, 5_000_000n) }, { to: X, data: '0x01' }] }] }, { now: NOW }, d);
  assert.match(p.simulation?.source ?? '', /3 calls as one transaction$/);
  assert.deepEqual([p.attention, codes(p).includes('hidden_approval_for_all'), codes(p).includes('hidden_unlimited_approval')], ['danger', true, true]);
  assert.match(p.warnings.find(w => w.code === 'hidden_approval_for_all')!.message, /^Set by this transaction along the way: after it, 0x9622…7242 can transfer every NFT you hold/);
});

test('The sender’s own hidden approval isn’t hidden behind the acting account’s of the same kind', async () => {
  // A preview carries each warning code once: the account's, told first, took the place of the sender's own, so an
  // "account" that grants something of its own masked what the transaction granted of the sender's.
  const d: Dependencies = { tokens, simulator: { simulate: async r => (r.account ? ok({ approvals: [unlimited(WALLET, WETH), operator(WALLET)] }) : ok({ approvals: [unlimited(alice, USDC), operator(alice)] })) } };
  const p = await send(ALICE, WALLET, execute(POOL, '0x12345678'), d);
  const said = (code: string) => p.warnings.find(w => w.code === code)?.message ?? '';
  assert.match(said('hidden_unlimited_approval'), /^Set by this transaction along the way: after it, 0x9622…7242 can spend an unlimited amount of your USDC\. For the account 0x5ca1…ffee: Set by this transaction along the way: after it, 0x9622…7242 can spend an unlimited amount of its WETH\.$/);
  assert.match(said('hidden_approval_for_all'), /can transfer every NFT you hold in .* For the account 0x5ca1…ffee: .* can transfer every NFT it holds in /);
  assert.deepEqual(p.approvals?.map(a => a.owner), [WALLET, WALLET, alice, alice]);
});

test('What the accounts a sender’s own batch hands calls on to move is read from the run too, not dropped', async () => {
  // A 7702 account's batch to itself: one call has another account send 1,000 USDC, another sends 1 of its own. Once
  // simulated, only the sender's 1 USDC showed: the other account's changes went with the decoded list, unsaid.
  const batch = encodeFunctionData({ abi: ACCOUNT, functionName: 'executeBatch', args: [[{ target: WALLET as Hex, value: 0n, data: execute(USDC, transfer(EVIL, 1_000_000_000n)) }, { target: USDC as Hex, value: 0n, data: transfer(BOB, 1_000_000n) }]] });
  const rpc = { has: () => true, call: async (_c: number, m: string) => (m === 'eth_getCode' ? `0xef0100${'11'.repeat(20)}` : m === 'eth_getTransactionCount' ? '0x0' : '0x') };
  const asked: (string | undefined)[] = [];
  const run = (forOthers: boolean): Dependencies => ({ tokens, rpc, simulator: { simulate: async r => { asked.push(r.account); return r.account ? (forOthers ? ok({ transfers: [{ asset: USDC, from: WALLET, to: EVIL, raw: 1_000_000_000n }] }) : null) : ok({ transfers: [{ asset: USDC, from: alice, to: bob, raw: 1_000_000n }] }); } } });
  const p = await send(ALICE, ALICE, batch, run(true));
  assert.equal(p.decoding.decoder, 'smart_account');
  assert.deepEqual(p.assetChanges.map(c => [c.account, c.direction, c.raw, c.basis]), [[alice, 'out', '1000000', 'simulated_state'], [WALLET, 'out', '1000000000', 'simulated_state']]);
  assert.match(p.decoding.notes.join(' '), /The run was read again for 0x5ca1…ffee, the account the calls hand calls on to: its balances and approvals are what those calls change\./);
  assert.deepEqual(asked, [undefined, WALLET]);
  // Where the run can't be read for it, what the call asks of it is kept, and said to be that.
  const kept = await send(ALICE, ALICE, batch, run(false));
  assert.deepEqual(kept.assetChanges.map(c => [c.account, c.direction, c.raw, c.basis]), [[alice, 'out', '1000000', 'simulated_state'], [WALLET, 'out', '1000000000', 'requested']]);
  assert.match(kept.decoding.notes.join(' '), /What the calls move for 0x5ca1…ffee is shown as they ask: the simulation read your own account's balances, not that account's\./);
});

test('A run at the price it would pay is kept where the price changes what the acting account gets', async () => {
  // A pool that taxes by the fee: 1 WETH at no price, 0.9 at the price the transaction would pay. Whether the priced
  // run is kept went by the sender's own changes alone, which an account call leaves as they were: sent by the
  // wallet's owner the swap showed 1 WETH in, sent by the wallet itself 0.9.
  const rpc = { has: () => true, call: async (_c: number, m: string) => {
    if (m === 'eth_getBlockByNumber') return { baseFeePerGas: '0x3b9aca00', number: '0x10', timestamp: '0x65000000' };
    if (m === 'eth_maxPriorityFeePerGas') return '0x3b9aca00';
    if (m === 'eth_getCode') return '0x6000';
    throw new Error('not mocked');
  } };
  const swap = (r: SimulationRequest) => ok({ gasUsed: 120_000n, transfers: [{ asset: USDC, from: WALLET, to: POOL, raw: 2_000_000_000n }, { asset: WETH, from: POOL, to: WALLET, raw: r.gasPrice ? 9n * 10n ** 17n : 10n ** 18n }] });
  const p = await send(ALICE, WALLET, execute(POOL, '0x12345678'), { tokens, rpc, simulator: { simulate: async r => swap(r) } });
  assert.deepEqual(p.assetChanges.map(c => [c.account, c.direction, c.amount, c.symbol]), [[WALLET, 'out', '2,000', 'USDC'], [WALLET, 'in', '0.9', 'WETH']]);
  assert.ok(p.decoding.notes.some(n => /depends on the fee/.test(n)));
  // A batch whose call has the account act: the same.
  const batch = await previewRequest({ method: 'wallet_sendCalls', params: [{ version: '2.0.0', chainId: '0x1', from: ALICE, calls: [{ to: WALLET, data: execute(POOL, '0x12345678') }, { to: USDC, data: transfer(BOB, 1n) }] }] }, { now: NOW },
    { tokens, rpc, simulator: { simulate: async r => swap(r), simulateBatch: async rs => rs.map(r => (r.to === WALLET ? swap(r) : ok())) } });
  assert.deepEqual(batch.assetChanges.filter(c => c.symbol === 'WETH').map(c => [c.account, c.direction, c.amount]), [[WALLET, 'in', '0.9']]);
});

test('Where the run shown is the local EVM’s, the acting account’s changes are the local EVM’s too', async () => {
  // A replayed account call the node ran otherwise than its receipt (400 USDC, other gas), shown as the local EVM ran
  // it (1,000, the receipt's): the account's changes were read from the node again, "out 400 USDC" under a run said
  // to match its receipt.
  const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', word = (v: bigint | string) => `0x${(typeof v === 'bigint' ? v.toString(16) : v.slice(2)).padStart(64, '0')}`;
  const log = (amount: bigint) => ({ address: USDC, topics: [TRANSFER, word(WALLET), word(BOB)], data: word(amount) });
  const run = (amount: bigint, gasUsed: bigint) => ok({ gasUsed, logs: [log(amount)], transfers: [{ asset: USDC, from: WALLET, to: bob, raw: amount }] } as Partial<SimulationResult>);
  const asked: string[] = [];
  const simulator = { simulate: async (r: SimulationRequest) => { asked.push(`node${r.account ? ', for the account' : ''}`); return run(400_000_000n, 90_000n); },
    trace: async (rs: SimulationRequest[]) => { asked.push(`local EVM${rs.at(-1)?.account ? ', for the account' : ''}`); return rs.map(() => run(1_000_000_000n, 100_000n)); } };
  const replay = { at: { block: '0x10', header: { number: 17n, timestamp: 1_700_000_000n, baseFeePerGas: 1n, gasLimit: 30_000_000n, coinbase: `0x${'00'.repeat(20)}` } }, before: [], earlier: 0, gasPrice: 1n, receipt: { status: 'success' as const, gasUsed: 100_000n, logs: [log(1_000_000_000n)] },
    info: { hash: `0x${'11'.repeat(32)}`, block: '17', index: 0, time: new Date(1_700_000_000_000).toISOString(), receipt: { status: 'success', gasUsed: '100000', fee: '0.0001 ETH' } }, when: { block: '0x11', time: 1_700_000_000 } };
  const tx = normalizeTransaction({ from: ALICE, to: WALLET, data: execute(BOB, '0x12345678'), value: '0x0', chainId: '0x1', gas: '0x30d40' }, {});
  const p = await previewTransaction(tx, { tokens, simulator } as never, { now: NOW, replay } as never, 'eth_sendTransaction');
  assert.deepEqual(asked, ['node', 'local EVM', 'local EVM, for the account']);
  assert.deepEqual([p.replay?.matches, p.assetChanges.map(c => [c.account, c.direction, c.amount, c.symbol])], [true, [[WALLET, 'out', '1,000', 'USDC']]]);
});

test('Run as one transaction, a batch has the sender’s code as the simulation has it; and calls of several senders aren’t read twice', async () => {
  const X = '0x5e55100000000000000000000000000000005e55', calls = [{ to: X, data: '0x' }, { to: X, data: '0x01' }];
  const seen: SimulationRequest[] = [];
  const d = (chainCode: string): Dependencies => ({ tokens, rpc: { has: () => true, call: async (_c: number, m: string) => (m === 'eth_getCode' ? chainCode : '0x') },
    simulator: { simulate: async r => { seen.push(r); return ok(); }, simulateBatch: async rs => rs.map((_, i) => (i === 1 ? { status: 'reverted' as const, source: 'mock', gasUsed: 30_000n, transfers: [] } : ok())) } });
  const batch = (overrides?: Record<string, { code: string }>) => previewRequest({ method: 'wallet_sendCalls', params: [{ version: '2.0.0', chainId: '0x1', from: ALICE, calls }] }, { now: NOW, ...(overrides && { stateOverrides: overrides }) }, d(`0xef0100${'11'.repeat(20)}`));
  // The code the caller's state overrides give the sender is the code the run has: the chain's own took its place.
  seen.length = 0;
  const given = await batch({ [ALICE]: { code: `0xef0100${'22'.repeat(20)}` } });
  assert.match(given.simulation?.source ?? '', /as one transaction$/);
  const handsOnTo = Object.values(seen.at(-1)!.stateOverrides ?? {}).map(o => o.code ?? '').find(c => c.includes('22'.repeat(20)) && !c.startsWith('0xef0100'));
  assert.ok(handsOnTo, 'the batching code hands on to the code the overrides name');
  // A sender the overrides leave without code isn't an account with code.
  const none = await batch({ [ALICE]: { code: '0x' } });
  assert.match(none.simulation?.source ?? '', /2 calls in order$/);

  // Calls that carry senders of their own keep each call's list: the acting account's change isn't added to it again.
  const two = await previewRequest({ method: 'wallet_sendCalls', params: [{ version: '2.0.0', chainId: '0x1', from: ALICE, calls: [{ to: WALLET, data: execute(USDC, transfer(BOB, 1_000_000_000n)) }, { from: BOB, to: USDC, data: transfer(ALICE, 1n) }] }] }, { now: NOW },
    { tokens, simulator: { simulate: async () => ok(), simulateBatch: async rs => rs.map(r => (r.account ? ok({ transfers: [{ asset: USDC, from: WALLET, to: bob, raw: 1_000_000_000n }] }) : ok())) } });
  assert.equal(two.assetChanges.filter(c => c.account === WALLET).length, 1);
});
