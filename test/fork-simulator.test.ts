// ForkSimulator end to end: a local EVM over state fetched from a chain (test/evm-chain.ts, a HyperEVM-shaped node
// without eth_simulateV1), run against real contracts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, serializeSignature, toHex, type Hex } from 'viem';
import { privateKeyToAccount, sign } from 'viem/accounts';
import { previewRequest } from '../src/preview.ts';
import { PERMIT2, StaticTokenRegistry } from '../src/chains.ts';
import { RpcSimulator } from '../src/simulation.ts';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHAIN_PROFILES, clearForkCaches, ForkSimulator, ForkTimeout } from '../src/fork-simulator.ts';
import type { Dependencies, Preview, SimulationRequest, SimulationResult } from '../src/types.ts';
import { codes, NOW } from './helpers.ts';
import { compiled, PRECOMPILE, testChain } from './evm-chain.ts';

const KEY = '0x5555555555555555555555555555555555555555555555555555555555555555' as const;
const USER = privateKeyToAccount(KEY).address.toLowerCase();
const BOB = '0xb0b0000000000000000000000000000000000002';
const E = 10n ** 18n, MAX = (1n << 256n) - 1n, MAX160 = (1n << 160n) - 1n;
const URL_ = 'http://hyperevm.invalid';

const chain = await testChain();
const usdc = await chain.deploy('Token', 'string,uint8', ['USDC', 6]);
const weth = await chain.deploy('Token', 'string,uint8', ['WHYPE', 18]);
const vault = await chain.deploy('Vault', 'address', [usdc]);
const nft = await chain.deploy('NFT');
const router = await chain.deploy('Router');
const eoaOnly = await chain.deploy('EoaOnly', 'address', [usdc]);
const reverter = await chain.deploy('Reverter');
const shares = await chain.deploy('SharesToken');
const reader = await chain.deploy('CoreReader');
await chain.putCode(PERMIT2, `0x${compiled('Permit2Like').evm.deployedBytecode.object}`);
const T = parseAbi([
  'function mint(address,uint256)', 'function mintShares(address,uint256)', 'function transfer(address,uint256)', 'function approve(address,uint256)', 'function withdraw(uint256)',
  'function deposit(uint256)', 'function buy(uint256)', 'function permitSelf(address,uint160,uint48,bytes)', 'function claim()', 'function fail()', 'function read(uint32)',
]);
const call = (fn: string, args: unknown[] = []) => encodeFunctionData({ abi: T, functionName: fn, args } as never);
await chain.exec(usdc, call('mint', [USER, 1000_000_000n]));
await chain.exec(weth, call('mint', [USER, 2n * E]));
await chain.setBalance(weth, 2n * E);
await chain.exec(shares, call('mintShares', [USER, 300_000_000n])); // worth 1,000 stUSD
await chain.setBalance(USER, 10n * E);
await chain.exec(nft, encodeFunctionData({ abi: parseAbi(['function mint(address,uint256)']), functionName: 'mint', args: [USER as Hex, 7n] }));

// The precompile at 0x…0800 is forwarded to the chain, as HyperEVM's HyperCore reads are.
const profiles = { 999: { ...CHAIN_PROFILES[999], forwardedPrecompiles: [PRECOMPILE] } };
const fork = (o: Partial<ConstructorParameters<typeof ForkSimulator>[1]> = {}) => new ForkSimulator({ 999: URL_ }, { fetchImpl: chain.fetchImpl, profiles, ...o });
const tokens = new StaticTokenRegistry({ 999: [
  { address: usdc, symbol: 'USDC', decimals: 6, name: 'USD Coin' }, { address: weth, symbol: 'WHYPE', decimals: 18, name: 'Wrapped HYPE' },
  { address: vault, symbol: 'vUSD', decimals: 6, name: 'Vault USD' }, { address: shares, symbol: 'stUSD', decimals: 6, name: 'Shares USD' },
] });
const deps: Dependencies = { tokens, simulator: new RpcSimulator({ 999: URL_ }, { fetchImpl: chain.fetchImpl, fork: fork() }) };
const send = (to: string, data: Hex, value = 0n) => previewRequest({ method: 'eth_sendTransaction', params: [{ from: USER, to, data, value: toHex(value), chainId: '0x3e7' }] }, { now: NOW }, deps);
const changes = (p: Preview) => p.assetChanges.map(c => [c.direction, c.amount, c.symbol, c.basis]).sort();

test('Every log, and amounts read from state: a transfer, an unwrap, and a token whose event overstates the amount', async () => {
  const p = await send(usdc, call('transfer', [BOB, 50_000_000n]));
  assert.equal(p.simulation?.status, 'success');
  assert.match(p.simulation!.source, /local EVM over chain 999 state/);
  assert.deepEqual(changes(p), [['out', '50', 'USDC', 'simulated_state']]);
  assert.ok(p.decoding.notes.some(n => /local EVM over this chain's latest state/.test(n)));
  assert.deepEqual(changes(await send(weth, call('withdraw', [E]))), [['in', '1', 'HYPE', 'simulated_state'], ['out', '1', 'WHYPE', 'simulated_state']]);
  // The event says 101 base units, but 30 shares move, worth 100. Log-based simulators would say 101.
  const s = await send(shares, call('transfer', [BOB, 101n]));
  assert.deepEqual(changes(s), [['out', '0.0001', 'stUSD', 'simulated_state']]);
});

test('Batches run in order with approvals read back; signatures, NFTs and EOA-only contracts behave as on-chain', async () => {
  const batch = await previewRequest({ method: 'wallet_sendCalls', params: [{ version: '2.0.0', chainId: '0x3e7', from: USER, atomicRequired: true, calls: [
    { to: usdc, data: call('approve', [vault, 100_000_000n]) }, { to: vault, data: call('deposit', [100_000_000n]) },
  ] }] }, { now: NOW }, deps);
  assert.equal(batch.simulation?.status, 'success');
  assert.deepEqual(changes(batch), [['in', '100', 'vUSD', 'simulated_state'], ['out', '100', 'USDC', 'simulated_state']]);
  assert.deepEqual(batch.approvals?.map(a => [a.spender, a.allowance, a.direct]), [[vault, 'none', true]]);
  // The account has no code here, so Permit2 checks the signature with ecrecover, as on-chain; a forged one fails.
  const exp = Math.floor(NOW / 1000) + 86400;
  const sig = async (key: Hex) => serializeSignature(await sign({ hash: keccak256(encodeAbiParameters(parseAbi(['function f(address,address,address,uint160,uint48)'])[0].inputs, [USER as Hex, usdc as Hex, router as Hex, MAX160, exp])), privateKey: key }));
  const along = await send(router, call('permitSelf', [usdc, MAX160, exp, await sig(KEY)]));
  assert.deepEqual(along.approvals?.map(a => [a.kind, a.spender, a.allowance, a.direct]), [['permit2', router, 'unlimited', false]]);
  assert.ok(codes(along).includes('hidden_unlimited_approval'));
  assert.equal((await send(router, call('permitSelf', [usdc, MAX160, exp, await sig('0x6666666666666666666666666666666666666666666666666666666666666666')]))).simulation?.revertReason, 'sig');
  const bought = await send(nft, call('buy', [42n]), E);
  assert.deepEqual(bought.assetChanges.map(c => [c.direction, c.standard, c.tokenId ?? c.amount]).sort(), [['in', 'erc721', '42'], ['out', 'native', '1']]);
  // The probe can't measure this (the account has code under it); the fork simulator runs it as it is.
  assert.deepEqual(changes(await send(eoaOnly, call('claim'))), [['in', '1', 'USDC', 'simulated_state']]);
  const approve = await send(usdc, call('approve', [BOB, MAX]));
  assert.deepEqual(approve.approvals?.map(a => [a.spender, a.allowance, a.direct]), [[BOB, 'unlimited', true]]);
  // approve(address,uint256) on an NFT is a token approval, not an ERC-20 allowance of "7".
  const nftApprove = await send(nft, call('approve', [BOB, 7n]));
  assert.equal(nftApprove.simulation?.status, 'success');
  assert.ok(!(nftApprove.approvals ?? []).some(a => a.kind === 'erc20'), JSON.stringify(nftApprove.approvals));
});

test('Failures: revert reasons, insufficient funds; a chain precompile is answered by the chain', async () => {
  const fail = await send(reverter, call('fail'));
  assert.deepEqual([fail.simulation?.status, fail.simulation?.revertReason], ['reverted', 'nope']);
  assert.equal((await send(BOB, '0x', 100n * E)).simulation?.revertReason, 'insufficient funds: the account holds 10 HYPE and the call sends 100 HYPE');
  const [r] = (await fork().simulateBatch([{ chainId: 999, from: USER, to: reader, data: call('read', [5]), value: 0n }]))!;
  assert.equal(r.status, 'success');
  assert.equal(BigInt(r.returnData!), 17n);
});

test('Speculative rounds converge, guesses from earlier simulations cut them, and the budget falls back to the probe', async () => {
  const req = { chainId: 999, from: USER, to: vault, data: call('deposit', [1n]), value: 0n };
  const approve = { chainId: 999, from: USER, to: usdc, data: call('approve', [vault, 1n]), value: 0n };
  const cold = fork();
  await cold.simulateBatch([approve, req]);
  const warm = fork();
  const [, again] = (await warm.simulateBatch([approve, req]))!;
  assert.equal(again.status, 'success');
  assert.ok(warm.last!.rounds <= 2 && warm.last!.rounds <= cold.last!.rounds, `${cold.last!.rounds} cold, ${warm.last!.rounds} warm`);
  // A traced run lists the call's storage reads and writes with their gas: each balance is read first (2,100 cold),
  // then written, nonzero to nonzero (2,900) for the sender and zero to nonzero (20,000) for a new recipient.
  const traced = fork({ trace: true });
  await traced.simulate({ chainId: 999, from: USER, to: usdc, data: call('transfer', ['0x' + 'b1'.repeat(20), 3n]), value: 0n });
  const writes = traced.last!.trace!.filter(t => t.op === 'SSTORE');
  assert.deepEqual(writes.map(t => [t.address, t.gas]), [[usdc, '2900'], [usdc, '20000']]);
  assert.equal(writes[1].value, '0x3');
  assert.ok(traced.last!.trace!.filter(t => t.op === 'SLOAD' && t.slot === writes[1].slot).every(t => t.gas === '2100'), 'the recipient’s slot is read cold once');
  // With no speculative rounds allowed, values are fetched one at a time: slower, same answer.
  const [slow] = (await fork({ maxRounds: 0 }).simulateBatch([{ chainId: 999, from: USER, to: usdc, data: call('transfer', [BOB, 1n]), value: 0n }]))!;
  assert.deepEqual(slow.transfers.map(t => [t.asset, t.raw]), [[usdc, 1n]]);
  await assert.rejects(fork({ timeoutMs: 1 }).simulate(req), ForkTimeout);
  // Past the budget, RpcSimulator asks the probe, and takes whichever of the two answers first: the probe when the
  // fork run is slow to fetch state, the fork's fuller answer when it finishes while the probe is still out.
  const delayed = (ms: number) => (async (u: string, init: RequestInit) => { await new Promise(r => setTimeout(r, ms)); return chain.fetchImpl(u, init); }) as typeof fetch;
  const transferReq = { chainId: 999, from: USER, to: usdc, data: call('transfer', [BOB, 2n]), value: 0n };
  const probeWins = await new RpcSimulator({ 999: URL_ }, { fetchImpl: chain.fetchImpl, fork: fork({ fetchImpl: delayed(400), timeoutMs: 5000 }), forkBudgetMs: 50 }).simulate(transferReq);
  assert.equal(probeWins?.basis, 'state');
  assert.match(probeWins!.source, /state-override probe/);
  const forkWins = await new RpcSimulator({ 999: URL_ }, { fetchImpl: delayed(1500), fork: fork(), forkBudgetMs: 1 }).simulate(transferReq);
  assert.equal(forkWins?.basis, 'fork');
});

test('BLOCKHASH gives the recent blocks’ real hashes (a contract checkpointing one reverts without them)', async () => {
  const readerAt = await chain.deploy('BlockHashReader');
  const checkpoint = (n: bigint) => ({ chainId: 999, from: USER, to: readerAt, data: encodeFunctionData({ abi: parseAbi(['function checkpoint(uint256) view returns (bytes32)']), functionName: 'checkpoint', args: [n] }), value: 0n });
  // The simulated block is the next one (17); block 16's hash comes from the chain.
  const [latest] = (await fork().simulateBatch([checkpoint(16n)]))!;
  assert.equal(latest.status, 'success');
  assert.equal(latest.returnData, keccak256(encodeAbiParameters([{ type: 'uint256' }], [16n])));
  // The current block's own hash isn't available to it, as on-chain.
  assert.equal((await fork().simulate(checkpoint(17n)))!.status, 'reverted');
});

test('EIP-7702: an account delegated to a smart-account contract runs its code (chain 1, Osaka rules)', async () => {
  const executor = await chain.deploy('Executor');
  const transfer = call('transfer', [BOB, 5_000_000n]);
  const execute = encodeFunctionData({ abi: parseAbi(['function execute(address,bytes)']), functionName: 'execute', args: [usdc as Hex, transfer] });
  const sim = new ForkSimulator({ 1: URL_ }, { fetchImpl: chain.fetchImpl });
  const req = { chainId: 1, from: USER, to: USER, data: execute, value: 0n };
  // Without the delegation the account has no code: the call does nothing.
  assert.deepEqual((await sim.simulate(req))!.transfers, []);
  const [delegated] = (await sim.simulateBatch([{ ...req, stateOverrides: { [USER]: { code: `0xef0100${executor.slice(2)}` } } }]))!;
  assert.equal(delegated.status, 'success');
  assert.deepEqual(delegated.transfers.filter(t => t.asset === usdc).map(t => [t.from, t.raw]), [[USER, 5_000_000n]]);
});

test('EIP-7702 authorizations are applied as the chain does: validity, nonces, persistence and their gas', async () => {
  const executor = await chain.deploy('Executor');
  const sim = new ForkSimulator({ 1: URL_ }, { fetchImpl: chain.fetchImpl });
  const execute = encodeFunctionData({ abi: parseAbi(['function execute(address,bytes)']), functionName: 'execute', args: [usdc as Hex, call('transfer', [BOB, 5_000_000n])] });
  const base = { chainId: 1, from: USER, to: USER, data: execute, value: 0n };
  const signed = async (key: Hex, nonce: number) => {
    const a = await privateKeyToAccount(key).signAuthorization({ address: executor as Hex, chainId: 1, nonce });
    return { address: executor, chainId: '0x1', nonce: toHex(nonce), r: a.r, s: a.s, yParity: toHex(a.yParity!) };
  };
  // The code override alone (what a simulator without EIP-7702 processing does) costs nothing extra.
  const [override] = (await sim.simulateBatch([{ ...base, stateOverrides: { [USER]: { code: `0xef0100${executor.slice(2)}` } } }]))!;
  // Signed by the sender, with its nonce after this transaction's own (0 → 1): applied. 25,000 for the
  // authorization, less 12,500 back because the account exists.
  const [mine] = (await sim.simulateBatch([{ ...base, authorizationList: [await signed(KEY, 1)], stateOverrides: { [USER]: { code: '0x' } } }]))!;
  assert.equal(mine.status, 'success');
  // The account called itself, so the other side is unknown: not the account, which would cancel the change out.
  assert.deepEqual(mine.transfers.filter(t => t.asset === usdc).map(t => [t.from, t.to, t.raw]), [[USER, '0x0000000000000000000000000000000000000000', 5_000_000n]]);
  assert.equal(mine.gasUsed, override.gasUsed! + 12_500n);
  // The wallet's own, unsigned: the same gas.
  const unsigned = { ...base, unsignedAuthorizations: [{ address: executor, chainId: 1 }], stateOverrides: { [USER]: { code: `0xef0100${executor.slice(2)}` } } };
  assert.equal((await sim.simulate(unsigned))!.gasUsed, mine.gasUsed);
  // A stale nonce: the chain skips the authorization (and the override standing in for it), so the call reaches an
  // account without code and does nothing; the 25,000 is still paid.
  const [stale] = (await sim.simulateBatch([{ ...base, authorizationList: [await signed(KEY, 0)], stateOverrides: { [USER]: { code: `0xef0100${executor.slice(2)}` } } }]))!;
  assert.deepEqual(stale.transfers, []);
  assert.equal(stale.gasUsed, 21_000n + 25_000n + calldataGas(execute));
  // Another account's authorization, sponsored by this one: no refund (the account didn't exist), and the delegation
  // stays for the next call of the batch, which runs the delegate's code as that (empty) account.
  const OTHER = '0x6666666666666666666666666666666666666666666666666666666666666666' as const;
  const other = privateKeyToAccount(OTHER).address.toLowerCase();
  const plain = { chainId: 1, from: USER, to: usdc, data: call('transfer', [BOB, 1n]), value: 0n };
  const [without] = (await sim.simulateBatch([plain]))!;
  const [sponsored, next] = (await sim.simulateBatch([{ ...plain, authorizationList: [await signed(OTHER, 0)] }, { ...base, to: other }]))!;
  assert.equal(sponsored.gasUsed, without.gasUsed! + 25_000n);
  assert.equal(next.status, 'reverted');
  assert.equal(next.revertReason, 'balance');
});

test('A wallet upgrading its own account and running a batch through it shows the batch’s balance changes', async () => {
  const executor = await chain.deploy('Executor');
  const sim = new RpcSimulator({ 1: URL_ }, { fetchImpl: chain.fetchImpl, fork: new ForkSimulator({ 1: URL_ }, { fetchImpl: chain.fetchImpl }) });
  const tokens1 = new StaticTokenRegistry({ 1: [{ address: usdc, symbol: 'USDC', decimals: 6, name: 'USD Coin' }] });
  const execute = encodeFunctionData({ abi: parseAbi(['function execute(address,bytes)']), functionName: 'execute', args: [usdc as Hex, call('transfer', [BOB, 5_000_000n])] });
  const p = await previewRequest({ method: 'eth_sendTransaction', params: [{ from: USER, to: USER, data: execute, chainId: '0x1', authorizationList: [{ address: executor, chainId: '0x1' }] }] }, { now: NOW }, { tokens: tokens1, simulator: sim });
  assert.ok(codes(p).includes('eip7702_delegation'));
  assert.deepEqual(changes(p), [['out', '5', 'USDC', 'simulated_state']]);
});

const calldataGas = (data: Hex) => { let g = 0n; for (let i = 2; i < data.length; i += 2) g += data.slice(i, i + 2) === '00' ? 4n : 16n; return g; };

test('A cache file keeps what simulations have seen across restarts: the first preview after one is fast', async () => {
  let hop = '0x0000000000000000000000000000000000000000';
  for (let i = 1; i <= 8; i++) hop = await chain.deploy('Hop', 'address,uint256', [hop, BigInt(i)]);
  const req = { chainId: 999, from: USER, to: hop, data: encodeFunctionData({ abi: parseAbi(['function total() view returns (uint256)']), functionName: 'total' }), value: 0n };
  const file = join(mkdtempSync(join(tmpdir(), 'fork-cache-')), 'cache.json');
  clearForkCaches();
  const first = fork({ cacheFile: file });
  assert.equal(first.loaded, 0);
  const [r] = (await first.simulateBatch([req]))!;
  assert.equal(BigInt(r.returnData!), 36n);
  const cold = first.last!.rounds;
  first.persist();
  // A restart: the in-memory caches are gone, and come back from the file.
  clearForkCaches();
  const restarted = fork({ cacheFile: file });
  assert.ok(restarted.loaded > 0);
  const [again] = (await restarted.simulateBatch([req]))!;
  assert.equal(BigInt(again.returnData!), 36n);
  assert.ok(cold >= 8 && restarted.last!.rounds <= 2, `${cold} rounds cold, ${restarted.last!.rounds} after the restart`);
  // Without the file, a restart starts cold again.
  clearForkCaches();
  const blank = fork();
  await blank.simulateBatch([req]);
  assert.equal(blank.last!.rounds, cold);
  // A missing or broken file is no cache, not an error.
  writeFileSync(file, '{');
  assert.equal(fork({ cacheFile: file }).loaded, 0);
});

test('HyperCore actions a contract sends through CoreWriter are listed, checked against the account they run on', async () => {
  await chain.putCode('0x3333333333333333333333333333333333333333', `0x${compiled('CoreWriterLike').evm.deployedBytecode.object}`);
  const sender = await chain.deploy('CoreSender');
  // Spot send (action 6): 6 HYPE to BOB, from the contract's HyperCore account, which holds none.
  const action = `0x01000006${encodeAbiParameters([{ type: 'address' }, { type: 'uint64' }, { type: 'uint64' }], [BOB, 150n, 6_00000000n]).slice(2)}` as Hex;
  const data = encodeFunctionData({ abi: parseAbi(['function act(bytes)']), functionName: 'act', args: [action] });
  const { mockHyperliquidInfo } = await import('../mocks/data.ts');
  const p = await previewRequest({ method: 'eth_sendTransaction', params: [{ from: USER, to: sender, data, chainId: '0x3e7' }] }, { now: NOW }, { ...deps, hyperliquid: { mainnet: mockHyperliquidInfo() } });
  assert.equal(p.details.find(d => d.label === 'HyperCore action')?.value, `Send 6 HYPE on HyperCore to 0xb0b0…0002 (sent by ${sender.slice(0, 6)}…${sender.slice(-4)}, for its own HyperCore account)`);
  assert.match(p.warnings.find(w => w.code === 'insufficient_balance')!.message, /^HyperCore action: This transfer needs 6 HYPE, but .* has only 0 free in HyperCore spot/);
  assert.ok(codes(p).includes('corewriter_async'));
});

test('When the fork simulator runs out of budget, the probe reads the tokens it had already seen', async () => {
  const hUsdc = await chain.deploy('Token', 'string,uint8', ['hUSDC', 6]);
  const pool = await chain.deploy('Pool', 'address,address', [usdc, hUsdc]);
  const reqs = [
    { chainId: 999, from: USER, to: usdc, data: call('approve', [pool, 3_000_000n]), value: 0n },
    { chainId: 999, from: USER, to: pool, data: encodeFunctionData({ abi: parseAbi(['function supply(uint256)']), functionName: 'supply', args: [3_000_000n] }), value: 0n },
  ];
  // A real run reports what it saw: the receipt token minted to the account, which the calldata never names.
  const real = fork();
  await real.simulateBatch(reqs);
  assert.ok(real.discovered(reqs).includes(hUsdc));
  // A fork run that doesn't finish in time: the probe answers, reading the token the fork had seen.
  const stuck = { covers: () => true, simulate: async () => null, simulateBatch: () => new Promise<never>(() => {}), discovered: () => [hUsdc] };
  const out = (await new RpcSimulator({ 999: URL_ }, { fetchImpl: chain.fetchImpl, fork: stuck, forkBudgetMs: 50 }).simulateBatch(reqs))!;
  assert.equal(out[1].basis, 'state');
  assert.deepEqual(out[1].transfers.filter(t => t.asset === hUsdc).map(t => t.raw), [3_000_000n]);
  // Without the hint the probe can't know about it.
  const blind = (await new RpcSimulator({ 999: URL_ }, { fetchImpl: chain.fetchImpl, fork: { ...stuck, discovered: () => [] }, forkBudgetMs: 50 }).simulateBatch(reqs))!;
  assert.deepEqual(blind[1].transfers.filter(t => t.asset === hUsdc), []);
});

test('A call trace: every call in order, with its kind, its own events, why one failed, and the state changed', async () => {
  const target = await chain.deploy('TraceTarget'), lib = await chain.deploy('TraceLib'), noisy = await chain.deploy('Noisy');
  await chain.exec(usdc, call('mint', [target, 100n]));
  const RUN = parseAbi(['function run(address token, address to, address noisy, address lib) payable returns (uint256)']);
  const data = encodeFunctionData({ abi: RUN, functionName: 'run', args: [usdc as Hex, BOB as Hex, noisy as Hex, lib as Hex] });
  const r = await fork().simulate({ chainId: 999, from: USER, to: target, data, value: 7n, trace: true });
  assert.equal(r?.status, 'success');
  const t = r!.trace!;
  assert.deepEqual([t.type, t.from, t.to, t.value], ['call', USER, target, 7n]);
  // The calls it makes, in order: a token transfer, a call that fails, a delegatecall, a read, a payment, a creation.
  const kinds = t.calls!.map(c => [c.type, c.to === target ? 'target' : c.to === usdc ? 'usdc' : c.to === noisy ? 'noisy' : c.to === lib ? 'lib' : c.to === BOB ? 'bob' : 'new', c.error ?? '']);
  assert.deepEqual(kinds, [['call', 'usdc', ''], ['call', 'noisy', 'after an event'], ['delegatecall', 'lib', ''], ['staticcall', 'usdc', ''], ['call', 'bob', ''], ['create', 'new', '']]);
  const [transfer, failed, bump, read, pay, created] = t.calls!;
  // A delegatecall runs as its caller: it comes from the target, and so does its event.
  assert.equal(bump.from, target);
  assert.deepEqual(bump.logs!.map(l => [l.index, l.address]), [[2, target]]);
  // Events are numbered across the transaction, each under the call whose code emitted it; the failed call's is gone.
  assert.deepEqual(t.logs!.map(l => l.index), [0, 3]);
  assert.deepEqual(transfer.logs!.map(l => [l.index, l.address, l.topics[0]]), [[1, usdc, '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef']]);
  assert.equal(failed.logs, undefined);
  assert.deepEqual(r!.logs!.map(l => l.address), [target, usdc, target, target]);
  // Inputs, outputs and value: the read returns Bob's balance, which the call itself returns; the payment carries 7.
  assert.equal(read.input.slice(0, 10), '0x70a08231');
  assert.equal(BigInt(read.output!), 5n);
  assert.equal(BigInt(t.output!), 5n);
  assert.deepEqual([pay.value, pay.input], [7n, '0x']);
  assert.ok(created.to && created.to !== target && created.output === undefined);
  assert.ok(t.gasUsed > transfer.gasUsed && transfer.gasUsed > 0n);

  // The state it changed, account by account: balances moved in the token, the target's counter (written by the
  // delegatecall) and nonce (it created a contract), the new contract's code, and 7 wei from the sender to Bob.
  const by = new Map(r!.stateChanges!.map(s => [s.address, s]));
  assert.equal(by.get(usdc)!.storage!.length, 2);
  assert.deepEqual(by.get(target)!.storage!.map(s => [BigInt(s.slot), BigInt(s.before), BigInt(s.after)]), [[0n, 0n, 1n]]);
  assert.deepEqual([by.get(target)!.nonce!.after - by.get(target)!.nonce!.before, by.get(target)!.balance], [1n, undefined]);
  assert.equal(by.get(created.to!)!.code, true);
  assert.equal(by.get(BOB)!.balance!.after - by.get(BOB)!.balance!.before, 7n);
  assert.equal(by.get(USER)!.balance!.after - by.get(USER)!.balance!.before, -7n);
  // What the failed call wrote or emitted isn't among them.
  assert.equal(by.has(noisy), false);
  // Without the flag, no trace is kept.
  assert.equal((await fork().simulate({ chainId: 999, from: USER, to: target, data, value: 7n }))!.trace, undefined);

  // In a preview: the trace decoded with what is known (standard functions and events, the tokens' names, "you").
  const p = await previewRequest({ method: 'eth_sendTransaction', params: [{ from: USER, to: target, data, value: '0x7', chainId: '0x3e7' }] }, { now: NOW, trace: true }, deps);
  const calls = p.trace!.calls;
  assert.equal(calls.length, 7);
  assert.deepEqual(calls.map(c => c.depth), [0, 1, 1, 1, 1, 1, 1]);
  assert.equal(calls[0].fromLabel, 'you');
  assert.deepEqual([calls[1].label, calls[1].function, calls[1].named, calls[1].text], ['USDC', 'transfer(address,uint256)', 'standard', `USDC.transfer(${BOB}, 5)`]);
  assert.deepEqual(calls[1].args, [{ name: 'to', type: 'address', value: BOB }, { name: 'amount', type: 'uint256', value: '5' }]);
  assert.deepEqual(calls[1].events!.map(e => [e.index, e.label, e.name, e.args!.map(a => a.value).join(' ')]), [[1, 'USDC', 'Transfer', `${target} ${BOB} 5`]]);
  assert.match(calls[2].text!, /failed: after an event$/);
  assert.deepEqual([calls[4].function, calls[4].returns], ['balanceOf(address)', [{ type: 'uint256', value: '5' }]]);
  assert.match(calls[5].text!, /with 0\.000000000000000007 HYPE$/);
  assert.match(calls[6].text!, /^create new contract \(\d+ bytes of creation code\) at 0x[0-9a-f]{40}$/);
  // The traced run did what the simulation shown did: the same outcome and events.
  assert.equal(p.trace!.agrees, true);
  assert.equal(p.trace!.note, undefined);
  assert.equal(p.trace!.source, "a local EVM over HyperEVM's state");
  assert.equal(p.trace!.stateChanges!.find(s => s.address === BOB)!.balance!.change, '+0.000000000000000007 HYPE');
  // Not asked for, not there.
  assert.equal((await send(target, data, 7n)).trace, undefined);
});

test('Chains with their own rules: Polygon’s storage prices, Arbitrum’s two block numbers, and a block named by the request', async () => {
  const AT = '0x00000000000000000000000000000000000c0de1', FROM = '0x00000000000000000000000000000000000c0de2';
  const SLOT1 = `0x${'00'.repeat(31)}01`;
  const gasOf = async (sim: ForkSimulator, code: string, extra: Record<string, unknown> = {}) =>
    Number((await sim.simulate({ chainId: 999, from: FROM, to: AT, data: '0x', value: 0n, stateOverrides: { [AT]: { code, ...extra } } }))!.gasUsed) - 21000;
  // Polygon's rules on this chain: what its node charged for each of these (measured 2026-11-10), and Ethereum's.
  const polygon = fork({ profiles: { 999: { ...CHAIN_PROFILES[137] } } }), ethereum = fork({ profiles: { 999: { ...CHAIN_PROFILES[1] } } });
  const set = { stateDiff: { [SLOT1]: `0x${'00'.repeat(31)}07` } };
  const cases: [string, string, Record<string, unknown>, number, number][] = [
    ['a cold SLOAD', '0x6000545000', {}, 5465, 2105],
    ['a cold SLOAD, then the same slot again', '0x600054506000545000', {}, 5570, 2210],
    ['SSTORE to an empty slot', '0x600160005500', {}, 22946, 22106],
    ['SSTORE changing a set slot', '0x600860015500', set, 5006, 5006],
    ['SSTORE of the value already there', '0x600760015500', set, 3046, 2206],
    ['SSTORE clearing a slot (with its refund)', '0x600060015500', set, 1046, 206],
    ['SLOAD, then SSTORE to the same empty slot', '0x60005450600160005500', {}, 25471, 22111],
    ['a cold account read', '0x61dead3b5000', {}, 2605, 2605],
  ];
  for (const [name, code, extra, onPolygon, onEthereum] of cases) {
    assert.equal(await gasOf(polygon, code, extra), onPolygon, `Polygon: ${name}`);
    assert.equal(await gasOf(ethereum, code, extra), onEthereum, `Ethereum: ${name}`);
  }

  // Arbitrum: NUMBER is the L1 block the chain last saw, and ArbSys.arbBlockNumber() the chain's own; opcode 0x44 is 1.
  // The code returns NUMBER, what ArbSys (0x64) answers arbBlockNumber() with, and PREVRANDAO.
  const reads = '0x4360005263a3b1b31d60e01b60205260206040600460206064' + '5afa50' + '4460605260806000f3';
  const arbitrum = fork({ profiles: { 999: { ...CHAIN_PROFILES[42161] } } });
  const header = { number: 21_000_000n, arbBlockNumber: 523_000_000n, timestamp: 1_800_000_000n, coinbase: BOB, prevRandao: `0x${'00'.repeat(31)}01` as Hex, gasLimit: 30_000_000n, baseFeePerGas: 10_000_000n };
  const r = await arbitrum.simulate({ chainId: 999, from: FROM, to: AT, data: '0x', value: 0n, stateOverrides: { [AT]: { code: reads } }, at: { block: 'latest', header } });
  const words = r!.returnData!.slice(2).match(/.{64}/g)!.map(w => BigInt(`0x${w}`));
  assert.deepEqual([words[0], words[2], words[3]], [21_000_000n, 523_000_000n, 1n]);
  // The request's block wins over the simulator's own: the same code on another header sees that one.
  const again = await arbitrum.simulate({ chainId: 999, from: FROM, to: AT, data: '0x', value: 0n, stateOverrides: { [AT]: { code: reads } }, at: { block: 'latest', header: { ...header, number: 5n, arbBlockNumber: 9n } } });
  assert.deepEqual(again!.returnData!.slice(2).match(/.{64}/g)!.map(w => BigInt(`0x${w}`)).filter((_, i) => i !== 1), [5n, 9n, 1n]);
});

test('Calls that run first in the block: the node runs them and the local EVM starts from the state they leave', async () => {
  // Bob holds no USDC: his transfer of 30 only works after the user's transfer of 50 to him, earlier in the block.
  const CAROL = '0xca401000000000000000000000000000000000c3';
  const header = { number: 17n, timestamp: 0x65000001n, coinbase: '0x0000000000000000000000000000000000000000', gasLimit: 30_000_000n, baseFeePerGas: 0n, prevRandao: `0x${'00'.repeat(32)}` as Hex };
  const earlier: SimulationRequest = { chainId: 999, from: USER, to: usdc, data: call('transfer', [BOB, 50_000_000n]), value: 0n };
  const target: SimulationRequest = { chainId: 999, from: BOB, to: usdc, data: call('transfer', [CAROL, 30_000_000n]), value: 0n };
  await chain.setBalance(BOB, E);
  // What left Bob (balances read before and after: the token, the account, the amount).
  const net = (r: SimulationResult) => r.transfers.map(t => [t.asset, t.from, t.raw]);
  // Alone, it fails.
  const [alone] = (await fork().simulateBatch([{ ...target, at: { block: '0x10', header } }]))!;
  assert.equal(alone.status, 'reverted');
  // This chain's node has no eth_simulateV1: the earlier call is run here too, and only the target is reported.
  const local = fork();
  const [here] = (await local.simulateBatch([{ ...target, at: { block: '0x10', header, before: [earlier] } }]))!;
  assert.deepEqual([here.status, net(here)], ['success', [[usdc, BOB, 30_000_000n]]]);
  // A node with eth_simulateV1 runs it, and answers every read from the state it leaves: balances and code through
  // readers at unused addresses, storage through a reader put in each contract's place.
  chain.simulateV1 = true;
  try {
    const before = chain.stats.calls.eth_simulateV1 ?? 0;
    const viaNode = fork();
    const [there] = (await viaNode.trace([{ ...target, at: { block: '0x10', header, before: [earlier] } }]))!;
    assert.deepEqual([there.status, net(there), there.gasUsed], ['success', [[usdc, BOB, 30_000_000n]], here.gasUsed]);
    assert.ok((chain.stats.calls.eth_simulateV1 ?? 0) > before);
    // The trace and the state changes are the target's alone, from where the earlier call left things: Bob had 50.
    assert.equal(there.trace!.to, usdc);
    const slots = there.stateChanges!.find(c => c.address === usdc)!.storage!;
    assert.deepEqual(slots.map(s => [BigInt(s.before), BigInt(s.after)]).sort((a, b) => Number(b[0] - a[0])), [[50_000_000n, 20_000_000n], [0n, 30_000_000n]]);
    // The chain itself is untouched.
    const balance = await chain.fetchImpl(URL_, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: usdc, data: encodeFunctionData({ abi: parseAbi(['function balanceOf(address) view returns (uint256)']), functionName: 'balanceOf', args: [BOB as Hex] }) }, 'latest'] }) }).then(r => r.json()) as { result: Hex };
    assert.equal(BigInt(balance.result), 0n);
  } finally { chain.simulateV1 = false; }
});

test('A traced preview, sent through the HTTP server, matches the API’s schema', async () => {
  const { createPreviewServer, openApiDocument } = await import('../src/server.ts');
  const Ajv2020Module = (await import('ajv/dist/2020.js')).default as unknown as { default?: unknown };
  const Ajv2020 = (Ajv2020Module.default ?? Ajv2020Module) as new (o: object) => { addSchema(s: object): void; getSchema(k: string): (((d: unknown) => boolean) & { errors?: unknown[] }) | undefined };
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  ajv.addSchema({ ...openApiDocument(), $id: 'signing-preview-openapi' });
  const target = await chain.deploy('TraceTarget'), lib = await chain.deploy('TraceLib'), noisy = await chain.deploy('Noisy');
  await chain.exec(usdc, call('mint', [target, 100n]));
  const data = encodeFunctionData({ abi: parseAbi(['function run(address token, address to, address noisy, address lib) payable returns (uint256)']), functionName: 'run', args: [usdc as Hex, BOB as Hex, noisy as Hex, lib as Hex] });
  const server = createPreviewServer({ deps });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as { port: number };
    const body = { request: { method: 'eth_sendTransaction', params: [{ from: USER, to: target, data, value: '0x7', chainId: '0x3e7' }] }, context: { trace: true } };
    const request = ajv.getSchema('signing-preview-openapi#/components/schemas/PreviewRequest')!;
    assert.ok(request(body), JSON.stringify(request.errors?.slice(0, 3)));
    const res = await fetch(`http://127.0.0.1:${port}/v1/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const preview = await res.json() as Preview;
    assert.equal(res.status, 200);
    assert.equal(preview.trace!.calls.length, 7);
    assert.ok(preview.trace!.stateChanges!.length >= 4);
    const valid = ajv.getSchema('signing-preview-openapi#/components/schemas/Preview')!;
    assert.ok(valid(preview), JSON.stringify(valid.errors?.slice(0, 3)));
  } finally { server.close(); }
});
