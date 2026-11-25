// A smart account's execute functions called by another sender (its owner, a relayer): the calls are the account's,
// and so is what the simulation is read for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, encodeFunctionData, pad, parseAbi, type Hex } from 'viem';
import { previewRequest } from '../src/preview.ts';
import { StaticTokenRegistry } from '../src/chains.ts';
import { ALICE, BOB } from '../mocks/data.ts';
import type { Dependencies, SimulationRequest, SimulationResult } from '../src/types.ts';
import { codes, detail, NOW } from './helpers.ts';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const WALLET = '0x5ca1ab1e00000000000000000000000000c0ffee', EVIL = '0x96221423681a6d52e184d440a8efcebb105c7242';
const ERC20 = parseAbi(['function transfer(address,uint256)', 'function approve(address,uint256)']);
const ACCOUNT = parseAbi(['function execute(address target, uint256 value, bytes data)', 'function executeBatch((address target, uint256 value, bytes data)[] calls)', 'function execute(bytes32 mode, bytes executionData)']);
const transfer = encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [BOB, 1_000_000_000n] });
const approve = encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [BOB, (1n << 256n) - 1n] });
const one = encodeFunctionData({ abi: ACCOUNT, functionName: 'execute', args: [USDC, 0n, transfer] });
const offline: Dependencies = { tokens: new StaticTokenRegistry() };
const send = (data: Hex, d: Dependencies = offline, o: { to?: string; value?: string } = {}) =>
  previewRequest({ method: 'eth_sendTransaction', params: [{ from: ALICE, to: o.to ?? WALLET, data, value: o.value ?? '0x0', chainId: '0x1' }] }, { now: NOW }, d);

test('An account’s execute called by its owner: the call is the account’s, and said to be', async () => {
  // It was "Call contract 0x5ca1…ffee", a function that isn't known, with nothing moving: a wallet's 1,000 USDC sent out.
  const p = await send(one);
  assert.equal(p.title, 'As the account 0x5ca1…ffee: Send 1,000 USDC');
  assert.deepEqual([p.decoding.decoder, p.decoding.status, p.attention], ['account_call', 'full', 'info']);
  assert.deepEqual([detail(p, 'Account'), detail(p, 'Format')], [`the account 0x5ca1…ffee (${WALLET})`, 'execute(address,uint256,bytes)']);
  assert.match(detail(p, 'Call 1') ?? '', /^Send 1,000 USDC \(0xa0b8…eb48\)$/);
  assert.match(p.warnings.find(w => w.code === 'account_call')!.message, new RegExp(`^This has the account ${WALLET} make the call below, not the account sending it: its code runs it as that account, and what it moves or approves is that account's\\.`));
  // What is decoded as moving is the account's, not the sender's.
  assert.deepEqual(p.assetChanges.map(c => [c.account, c.direction, c.raw, c.symbol, c.basis]), [[WALLET, 'out', '1000000000', 'USDC', 'requested']]);
  assert.match(p.decoding.notes.join(' '), /Each call is read as 0x5ca1…ffee's own: where a line says "you" or "your", that account is meant, not the one sending this\./);
  assert.match(p.summary, /The account 0x5ca1…ffee runs it through its own code\.$/);
  // A batch: each call numbered, with its own warnings, as when the account calls itself.
  const batch = await send(encodeFunctionData({ abi: ACCOUNT, functionName: 'executeBatch', args: [[{ target: WETH, value: 0n, data: approve }, { target: USDC, value: 0n, data: transfer }]] }));
  assert.equal(batch.title, 'Run 2 calls from the account 0x5ca1…ffee');
  assert.match(batch.warnings.find(w => w.code === 'unlimited_approval')?.message ?? '', /^Call 1: /);
  assert.match(batch.warnings.find(w => w.code === 'account_call')!.message, /make the 2 calls below/);
  // A delegatecall runs another contract's code inside that account: the danger it is on one's own.
  const delegated = await send(encodeFunctionData({ abi: ACCOUNT, functionName: 'execute', args: [pad('0xff', { dir: 'right', size: 32 }), `${EVIL}${transfer.slice(2)}` as Hex] }));
  assert.equal(delegated.attention, 'danger');
  assert.match(delegated.warnings.find(w => w.code === 'smart_account_delegatecall')?.message ?? '', /code inside the account 0x5ca1…ffee \(delegatecall\)/);
  // The same call from the account to itself is its own batch, as before; other calldata isn't this decoder's.
  const own = await previewRequest({ method: 'eth_sendTransaction', params: [{ from: WALLET, to: WALLET, data: one, chainId: '0x1' }] }, { now: NOW }, offline);
  assert.deepEqual([own.decoding.decoder, own.title, codes(own).includes('account_call')], ['smart_account', 'Send 1,000 USDC', false]);
  assert.notEqual((await send(transfer)).decoding.decoder, 'account_call');
  // An account with no code runs nothing.
  const empty: Dependencies = { ...offline, rpc: { has: () => true, call: async (_c: number, m: string) => (m === 'eth_getCode' ? '0x' : '0x') } };
  assert.match((await send(one, empty)).warnings.find(w => w.code === 'smart_account_no_code')?.message ?? '', /^The account 0x5ca1…ffee has no code/);
});

test('The simulation is read for the account that acts, beside the sender’s own', async () => {
  const alice = ALICE.toLowerCase();
  // A simulator reads one account's balances, the sender's unless another is named: asked again for the account.
  const sim = (o: { sender?: SimulationResult['transfers']; account?: Partial<SimulationResult> | null } = {}) => {
    const asked: SimulationRequest[] = [];
    const d: Dependencies = { ...offline, simulator: { simulate: async r => {
      asked.push(r);
      if (r.account) return o.account === null ? null : { status: 'success', source: 'mock', gasUsed: 60_000n, balancesRead: true, transfers: [{ asset: USDC, from: WALLET, to: BOB.toLowerCase(), raw: 1_000_000_000n }], ...o.account };
      return { status: 'success', source: 'mock', gasUsed: 60_000n, balancesRead: true, transfers: o.sender ?? [] };
    } } };
    return { d, asked };
  };
  const ok = sim();
  const p = await send(one, ok.d);
  assert.deepEqual(ok.asked.map(r => [r.from, r.to, r.account]), [[alice, WALLET, undefined], [alice, WALLET, WALLET]]);
  assert.deepEqual(p.assetChanges.map(c => [c.account, c.direction, c.raw, c.basis]), [[WALLET, 'out', '1000000000', 'simulated_state']]);
  assert.match(p.decoding.notes.join(' '), /The run was read twice: for your own account, and for 0x5ca1…ffee, whose balances and approvals are what the calls change\./);
  assert.ok(!codes(p).includes('account_call_takes_yours'));
  // What the transaction takes from the sender's own account is said, and listed under the sender.
  const taking = await send(one, sim({ sender: [{ asset: WETH, from: alice, to: EVIL, raw: 2n * 10n ** 18n }] }).d);
  assert.match(taking.warnings.find(w => w.code === 'account_call_takes_yours')?.message ?? '', /^The transaction also takes 2 WETH out of your own account \(0xa11c…0001\), not 0x5ca1…ffee's/);
  assert.deepEqual(taking.assetChanges.map(c => [c.account, c.direction, c.symbol]), [[WALLET, 'out', 'USDC'], [alice, 'out', 'WETH']]);
  assert.equal(taking.attention, 'caution');
  // Coin sent with the call is the sender's to send: listed, not warned of. What the sender receives is listed too.
  const funded = await send(one, sim({ sender: [{ asset: 'native', from: alice, to: WALLET, raw: 10n ** 17n }, { asset: USDC, from: WALLET, to: alice, raw: 5_000_000n }] }).d, { value: '0x16345785d8a0000' });
  assert.ok(!codes(funded).includes('account_call_takes_yours'));
  assert.deepEqual(funded.assetChanges.filter(c => c.account === alice).map(c => [c.direction, c.symbol]).sort(), [['in', 'USDC'], ['out', 'ETH']]);
  // An approval the account leaves along the way, which none of its calls names, is said of the account.
  const granting = await send(one, sim({ account: { approvals: [{ kind: 'erc20', emitter: WETH, token: WETH, owner: WALLET, spender: EVIL, amount: (1n << 256n) - 1n }] } }).d);
  assert.match(granting.warnings.find(w => w.code === 'hidden_unlimited_approval')?.message ?? '', /^For the account 0x5ca1…ffee: Set by this transaction along the way: after it, 0x9622…7242 can spend an unlimited amount of its WETH\.$/);
  assert.deepEqual(granting.approvals?.map(a => [a.owner, a.spender]), [[WALLET, EVIL]]);
  // Where the run can't be read for the account, what is shown for it is what the calls ask, and that is said.
  const unread = await send(one, sim({ account: null }).d);
  assert.deepEqual(unread.assetChanges.map(c => [c.account, c.basis]), [[WALLET, 'requested']]);
  assert.match(unread.decoding.notes.join(' '), /What the calls move for 0x5ca1…ffee is shown as they ask: the simulation read your own account's balances, not that account's\./);
});

test('Calls handed on from one account to others are told once, and accounts the transaction delegates run their new code', async () => {
  const OTHER = '0x0000000000000000000000000000000000b0b0b0', THIRD = '0x0000000000000000000000000000000000c0c0c0';
  const inner = (to: string) => ({ target: to as Hex, value: 0n, data: one });
  const hub = encodeFunctionData({ abi: ACCOUNT, functionName: 'executeBatch', args: [[inner(OTHER), inner(THIRD), { target: USDC as Hex, value: 0n, data: transfer }]] });
  const p = await send(hub);
  assert.equal(p.title, 'Run 3 calls from the account 0x5ca1…ffee');
  // One line for the calls that hand on, not one for each: a sponsor's batch over eleven accounts had twelve.
  const said = p.warnings.filter(w => w.code === 'account_call').map(w => w.message);
  assert.equal(said.length, 2);
  assert.match(said[0], new RegExp(`^This has the account ${WALLET} make the 3 calls below`));
  assert.match(said[1], /^Calls 1, 2 hand calls on to 2 other accounts \(0x0000…b0b0, 0x0000…c0c0\), whose code makes them as its own: what those move or approve is that account's, not the account 0x5ca1…ffee's\.$/);
  assert.match(detail(p, 'Call 1') ?? '', /^As the account 0x0000…b0b0: Send 1,000 USDC \(0x0000…b0b0\)$/);
  // An account with no code that the transaction itself delegates (EIP-7702) runs that code: not "no code".
  const noCode: Dependencies = { ...offline, rpc: { has: () => true, call: async (_c: number, m: string) => (m === 'eth_getCode' ? '0x' : m === 'eth_getTransactionCount' ? '0x0' : '0x') } };
  const plain = await send(one, noCode);
  assert.ok(codes(plain).includes('smart_account_no_code'));
  const { privateKeyToAccount } = await import('viem/accounts');
  const key = privateKeyToAccount(`0x${'77'.repeat(32)}`), DELEGATE = '0x63c0c19a282a1b52b07dd5a65b58948a07dae32b';
  const auth = await key.signAuthorization({ address: DELEGATE, chainId: 1, nonce: 0 });
  const delegated = await previewRequest({ method: 'eth_sendTransaction', params: [{ from: ALICE, to: key.address, data: one, chainId: '0x1',
    authorizationList: [{ address: DELEGATE, chainId: '0x1', nonce: '0x0', r: auth.r, s: auth.s, yParity: `0x${auth.yParity!.toString(16)}` }] }] }, { now: NOW }, noCode);
  assert.deepEqual([delegated.decoding.decoder, codes(delegated).includes('smart_account_no_code')], ['account_call', false]);
  // In a wallet_sendCalls batch, a call into another account is read the same way.
  const batch = await previewRequest({ method: 'wallet_sendCalls', params: [{ version: '2.0.0', chainId: '0x1', from: ALICE, calls: [{ to: WALLET, data: one }, { to: USDC, data: transfer }] }] }, { now: NOW }, offline);
  assert.deepEqual(batch.calls?.map(c => c.decoding.decoder), ['account_call', 'erc20_transfer']);
  // The batch's simulation nets the sender's own balances: it is read again for the account the first call has act,
  // whose changes are listed beside the sender's.
  const alice = ALICE.toLowerCase();
  const asked: (string | undefined)[][] = [];
  const result = (r: SimulationRequest): SimulationResult => ({ status: 'success', source: 'mock', gasUsed: 50_000n, balancesRead: true,
    transfers: r.account === WALLET ? (r.to === WALLET ? [{ asset: USDC, from: WALLET, to: BOB.toLowerCase(), raw: 1_000_000_000n }] : [])
      : r.to?.toLowerCase() === USDC ? [{ asset: USDC, from: alice, to: BOB.toLowerCase(), raw: 1_000_000_000n }] : [],
    ...(r.account === WALLET && r.to === WALLET && { approvals: [{ kind: 'erc20' as const, emitter: WETH, token: WETH, owner: WALLET, spender: EVIL, amount: (1n << 256n) - 1n }] }) });
  const sendCalls = (d: Dependencies) => previewRequest({ method: 'wallet_sendCalls', params: [{ version: '2.0.0', chainId: '0x1', from: ALICE, calls: [{ to: WALLET, data: one }, { to: USDC, data: transfer }] }] }, { now: NOW }, d);
  const ranBatch = await sendCalls({ ...offline, simulator: { simulate: async r => result(r), simulateBatch: async rs => { asked.push(rs.map(r => r.account)); return rs.map(result); } } });
  assert.equal(ranBatch.simulation?.status, 'success');
  assert.deepEqual(asked.at(-1), [WALLET, WALLET]);
  assert.deepEqual(ranBatch.assetChanges.map(c => [c.account, c.direction, c.raw, c.basis]), [[alice, 'out', '1000000000', 'simulated_state'], [WALLET, 'out', '1000000000', 'simulated_state']]);
  assert.match(ranBatch.decoding.notes.join(' '), /The batch's run was read again for 0x5ca1…ffee, the account its calls have act: its balances and approvals are what those calls change\./);
  // An approval that account leaves along the way is said of it.
  assert.match(ranBatch.warnings.find(w => w.code === 'hidden_unlimited_approval')?.message ?? '', /^For the account 0x5ca1…ffee: Set by this transaction along the way: after it, 0x9622…7242 can spend an unlimited amount of its WETH\.$/);
  assert.deepEqual(ranBatch.approvals?.map(a => [a.owner, a.spender]), [[WALLET, EVIL]]);
  // Where the run can't be read for that account, what the call has it move is kept as the call asks, and said to be.
  const unread = await sendCalls({ ...offline, simulator: { simulate: async r => result(r), simulateBatch: async rs => (rs.some(r => r.account) ? null : rs.map(result)) } });
  assert.deepEqual(unread.assetChanges.map(c => [c.account, c.direction, c.raw, c.basis]), [[alice, 'out', '1000000000', 'simulated_state'], [WALLET, 'out', '1000000000', 'requested']]);
  assert.match(unread.decoding.notes.join(' '), /Call 1 has another account make calls: what it moves for that account is shown as the call asks\. The batch's simulation read your own account's balances, not that account's\./);
});
