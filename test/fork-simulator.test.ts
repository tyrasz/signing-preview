// ForkSimulator end to end: a local EVM over state fetched from a chain (test/evm-chain.ts, a HyperEVM-shaped node
// without eth_simulateV1), run against real contracts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, encodeFunctionData, getContractAddress, keccak256, parseAbi, serializeSignature, toHex, type Hex } from 'viem';
import { privateKeyToAccount, sign } from 'viem/accounts';
import { previewRequest } from '../src/preview.ts';
import { PERMIT2, StaticTokenRegistry } from '../src/chains.ts';
import { RpcSimulator } from '../src/simulation.ts';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHAIN_PROFILES, clearForkCaches, ForkSimulator, ForkTimeout, ForkUnsupported, mainnetForkAt, nativeStandIn, nodeRulesOf } from '../src/fork-simulator.ts';
import { createAddressFromString, hexToBytes, setLengthLeft } from '@ethereumjs/util';
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
  // ArbOS's precompiles at the chain's prices (measured on Arbitrum One's node): 800 to open its state, 800 a
  // storage slot read, 3 a word given or returned. The block number reads none; getPricesInWei() reads two and
  // returns six words; a method that isn't listed is taken to read one.
  const price = CHAIN_PROFILES[42161].precompileGas!;
  assert.deepEqual([price(4, 32, '0xa3b1b31d'), price(4, 192, '0x41b247a8'), price(4, 96, '0x612af178'), price(4, 32, '0xf5d6ded7'), price(36, 32, '0x12345678')], [803n, 2_418n, 2_409n, 1_603n, 1_606n]);
  // The request's block wins over the simulator's own: the same code on another header sees that one.
  const again = await arbitrum.simulate({ chainId: 999, from: FROM, to: AT, data: '0x', value: 0n, stateOverrides: { [AT]: { code: reads } }, at: { block: 'latest', header: { ...header, number: 5n, arbBlockNumber: 9n } } });
  assert.deepEqual(again!.returnData!.slice(2).match(/.{64}/g)!.map(w => BigInt(`0x${w}`)).filter((_, i) => i !== 1), [5n, 9n, 1n]);
});

test('HyperEVM follows an EIP-7702 delegation: a call into a delegated account runs the delegate’s code', async () => {
  // Its rules are Cancun's, which have no such accounts, yet its node runs the delegate's code for one (measured
  // with the code given to an account). The local EVM does the same there; on plain Cancun rules the call fails.
  const DELEGATED = '0x00000000000000000000000000000000de1e9a7e', DELEGATE = '0x00000000000000000000000000000000c0de7704';
  const req: SimulationRequest = { chainId: 999, from: USER, to: DELEGATED, data: '0x', value: 0n, stateOverrides: { [DELEGATE]: { code: '0x602a60005260206000f3' }, [DELEGATED]: { code: `0xef0100${DELEGATE.slice(2)}` } } };
  const followed = await fork().simulate(req);
  assert.deepEqual([followed!.status, BigInt(followed!.returnData!)], ['success', 42n]);
  const { eips: _eips, ...cancun } = CHAIN_PROFILES[999];
  assert.equal((await fork({ profiles: { 999: cancun } }).simulate(req))!.status, 'reverted');
});

test('Gas is bought before a transaction runs: its sender’s balance is lower by it while it runs, and whole again after', async () => {
  // The code returns the caller's balance. A run with a gas limit and a price sees the balance less the gas limit
  // at that price, as on the chain; one without sees it whole.
  const AT = '0x00000000000000000000000000000000c0de0004';
  const req: SimulationRequest = { chainId: 999, from: USER, to: AT, data: '0x', value: 0n, stateOverrides: { [AT]: { code: '0x333160005260206000f3' } } };
  const whole = BigInt((await fork().simulate(req))!.returnData!);
  const [priced] = (await fork().trace([{ ...req, gas: 100_000n, gasPrice: 10n ** 9n }]))!;
  assert.equal(BigInt(priced.returnData!), whole - 100_000n * 10n ** 9n);
  // What the run reports is the call's own: no change to the sender's balance (the fee is counted apart).
  assert.equal(priced.stateChanges?.some(c => c.address === USER.toLowerCase() && c.balance), false);
  // The calls of a batch are transactions one after another: the second meets a sender that has paid the first's fee
  // (21,000 gas at the price), and has bought its own gas.
  const [, second] = (await fork().simulateBatch([{ chainId: 999, from: USER, to: BOB, data: '0x', value: 0n, gas: 100_000n, gasPrice: 10n ** 9n }, { ...req, gas: 100_000n, gasPrice: 10n ** 9n }]))!;
  assert.equal(BigInt(second.returnData!), whole - 21_000n * 10n ** 9n - 100_000n * 10n ** 9n);
  // A sender that couldn't pay for the gas is left as it is (the chain would refuse the transaction).
  assert.equal(BigInt((await fork().simulate({ ...req, gas: 100_000n, gasPrice: whole }))!.returnData!), whole);
});

test('A block given a later time for the chain’s node runs at its own time in the local EVM', async () => {
  // BNB Chain's blocks often share their second with their parent, which no node will simulate: a replay gives the
  // node the next second, and keeps the block's own for the local EVM. The code returns TIMESTAMP.
  const AT = '0x00000000000000000000000000000000c0de0002';
  const header = { number: 17n, timestamp: 0x65000002n, coinbase: '0x0000000000000000000000000000000000000000', gasLimit: 30_000_000n, baseFeePerGas: 0n, prevRandao: `0x${'00'.repeat(32)}` as Hex };
  const time = async (h: typeof header & { ownTimestamp?: bigint }) => BigInt((await fork().simulate({ chainId: 999, from: USER, to: AT, data: '0x', value: 0n, stateOverrides: { [AT]: { code: '0x4260005260206000f3' } }, at: { block: 'latest', header: h } }))!.returnData!);
  assert.deepEqual([await time(header), await time({ ...header, ownTimestamp: 0x65000001n })], [0x65000002n, 0x65000001n]);
});

test('A token whose balanceOf costs over a million gas is read for what it holds, not for what its events say', async () => {
  // Open Genesis, on BNB Chain, works a holder's balance out for 1.37 million gas, and its events netted to one unit
  // where a sender's balance went down by 4.56e18. The local EVM's views had a million gas, so the read failed and
  // the events stood.
  const heavy = await chain.deploy('HeavyToken');
  const H = parseAbi(['function mint(address,uint256)', 'function sweep(address)', 'function balanceOf(address) view returns (uint256)']);
  await chain.exec(heavy, encodeFunctionData({ abi: H, functionName: 'mint', args: [USER as Hex, 1_000n] }));
  const [r] = (await fork().simulateBatch([{ chainId: 999, from: USER, to: heavy, data: encodeFunctionData({ abi: H, functionName: 'sweep', args: [BOB as Hex] }), value: 0n }]))!;
  const net = r.transfers.filter(t => t.asset === heavy).reduce((sum, t) => sum + (t.to === USER ? t.raw : 0n) - (t.from === USER ? t.raw : 0n), 0n);
  assert.deepEqual([r.status, net], ['success', -1_000n]);
  // What its balanceOf costs, measured: over a million.
  const [read] = (await fork().simulateBatch([{ chainId: 999, from: USER, to: heavy, data: encodeFunctionData({ abi: H, functionName: 'balanceOf', args: [USER as Hex] }), value: 0n }]))!;
  assert.ok(read.gasUsed! > 1_000_000n && read.gasUsed! < 10_000_000n, String(read.gasUsed));
});

test('A chain that charges a multiple of Ethereum’s price for a precompile: charged so, and out of gas below it', async () => {
  // HyperEVM's ecrecover costs 15,000 (Ethereum's 3,000): a call to it with no input is 21,000 and that.
  const ECRECOVER = '0x0000000000000000000000000000000000000001';
  assert.equal(CHAIN_PROFILES[999].precompileScale?.[1], 5n);
  const scaled = fork({ profiles: { 999: { ...profiles[999], precompileScale: { 1: 5n } } } });
  const [plain, five, short] = await Promise.all([
    fork({ profiles: { 999: { ...profiles[999], precompileScale: undefined } } }).simulate({ chainId: 999, from: USER, to: ECRECOVER, data: '0x', value: 0n }),
    scaled.simulate({ chainId: 999, from: USER, to: ECRECOVER, data: '0x', value: 0n }),
    scaled.simulate({ chainId: 999, from: USER, to: ECRECOVER, data: '0x', value: 0n, gas: 30_000n }),
  ]);
  assert.deepEqual([plain!.gasUsed, five!.gasUsed], [24_000n, 36_000n]);
  // Given what Ethereum's price needs but not five times it, it runs out, as on the chain.
  assert.equal(short!.status, 'reverted');
});

test('Base’s B20 tokens run in the local EVM from their Solidity reference, on the token’s own storage', async () => {
  // A B20 asset token (variant byte 0) as Base keeps one: the marker code 0xef, its state in the base.b20 namespace.
  const TOKEN = '0xb200000000000000000000123456789abcdef012';
  const LOC = 0xc78b71fee795ddd74aff64ea9b2474194c938c3196430e10bb5f01ed48434000n, ASSET = 0xfdc6d4552d1286ade4d9facdbf0fb50d2ec9b89a90e104f26fd277585e374b00n;
  const word = (n: bigint) => setLengthLeft(hexToBytes(toHex(n)), 32);
  const put = (slot: bigint | Hex, value: bigint) => chain.evm.stateManager.putStorage(createAddressFromString(TOKEN), typeof slot === 'bigint' ? word(slot) : hexToBytes(slot), word(value));
  const shortString = (text: string) => BigInt(`0x${Buffer.from(text).toString('hex').padEnd(62, '0')}${(text.length * 2).toString(16).padStart(2, '0')}`);
  const balanceSlot = (who: string) => keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [who as Hex, LOC + 4n]));
  await chain.putCode(TOKEN, '0xef');
  for (const registry of ['0x8453000000000000000000000000000000000001', '0x8453000000000000000000000000000000000002']) await chain.putCode(registry, '0xef');
  await put(LOC, shortString('Test Asset'));
  await put(LOC + 1n, shortString('TA'));
  await put(LOC + 3n, 1_000_000n);
  await put(balanceSlot(USER), 1_000_000n);
  await put(ASSET, 6n);
  const base = new ForkSimulator({ 8453: URL_ }, { fetchImpl: chain.fetchImpl, profiles: { 8453: CHAIN_PROFILES[8453] } });
  // A block from after Base's upgrade of 2026-11-05, whose B20 rules the references have.
  const header = { number: 17n, timestamp: 1_800_000_000n, coinbase: '0x0000000000000000000000000000000000000000', gasLimit: 30_000_000n, baseFeePerGas: 0n, prevRandao: `0x${'00'.repeat(32)}` as Hex };
  const call = (data: Hex) => base.simulate({ chainId: 8453, from: USER, to: TOKEN, data, value: 0n, at: { block: 'latest', header } });
  const erc20 = parseAbi(['function transfer(address,uint256) returns (bool)', 'function decimals() view returns (uint8)', 'function symbol() view returns (string)']);
  const sent = (await call(encodeFunctionData({ abi: erc20, functionName: 'transfer', args: [BOB, 250n] })))!;
  assert.equal(sent.status, 'success');
  // The sender's balance, read back, is 250 down; the token says so to Bob (Transfer).
  assert.deepEqual(sent.transfers.map(t => [t.asset.toLowerCase(), t.from.toLowerCase(), t.raw]), [[TOKEN, USER, 250n]]);
  assert.deepEqual(sent.logs!.map(l => [l.address, l.topics[0].slice(0, 10), `0x${l.topics[2].slice(26)}`, BigInt(l.data)]), [[TOKEN, '0xddf252ad', BOB, 250n]]);
  // The token, and the policy registry it asked whether the two may send and receive.
  assert.deepEqual(sent.standIns, [TOKEN, '0x8453000000000000000000000000000000000002']);
  // What it reads is the chain's: its decimals (the asset variant's own slot) and symbol.
  const decimals = (await call(encodeFunctionData({ abi: erc20, functionName: 'decimals' })))!;
  assert.equal(BigInt(decimals.returnData!), 6n);
  // Charged as Base's node charges it, not what the reference's code burns: 100 and 6 a word of input, and one cold
  // read (2,100), on top of the transaction's 21,064.
  assert.equal(decimals.gasUsed, 21_064n + 106n + 2_100n);
  // As on Base, a token won't be sent to itself (InvalidReceiver).
  const self = (await call(encodeFunctionData({ abi: erc20, functionName: 'transfer', args: [TOKEN, 1n] })))!;
  assert.equal(self.status, 'reverted');
  assert.match(self.returnData!, /^0x9cfea583/);
  // A call to no function of the token's reverts as the chain's does: with its first four bytes, or zeros.
  assert.deepEqual([(await call('0xdeadbeef00'))!.returnData, (await call('0x12'))!.returnData], ['0xdeadbeef', '0x00000000']);
  // After a block's earlier transactions: the node runs the token itself whatever code is put in its place, so its
  // storage is read as of the block before them, and said to be stale where one of them changed it (its events).
  const earlier: SimulationRequest = { chainId: 8453, from: BOB, to: BOB, data: '0x', value: 0n };
  const target: SimulationRequest = { chainId: 8453, from: USER, to: TOKEN, data: encodeFunctionData({ abi: erc20, functionName: 'transfer', args: [BOB, 100n] }), value: 0n };
  chain.simulateV1 = true;
  try {
    const [after] = (await base.trace([{ ...target, at: { block: '0x10', header, before: [earlier] } }]))!;
    assert.deepEqual([after.status, after.standInsStale], ['success', undefined]);
    assert.deepEqual(after.logs!.map(l => [l.address, BigInt(l.data)]), [[TOKEN, 100n]]);
    // An earlier call that emitted an event from the token changed it.
    const touching = (async (u: string, init: RequestInit) => {
      const res = await chain.fetchImpl(u, init), body = JSON.parse(String(init.body));
      if (!Array.isArray(body) || body[0]?.method !== 'eth_simulateV1') return res;
      const out = await res.json() as { result?: { calls: { logs: unknown[] }[] }[] }[];
      out[0].result?.[0]?.calls[0]?.logs.push({ address: TOKEN, topics: [], data: '0x' });
      return new Response(JSON.stringify(out));
    }) as typeof fetch;
    const [stale] = (await new ForkSimulator({ 8453: URL_ }, { fetchImpl: touching, profiles: { 8453: CHAIN_PROFILES[8453] } }).trace([{ ...target, at: { block: '0x10', header, before: [earlier] } }]))!;
    assert.deepEqual([stale.status, stale.standInsStale], ['success', [TOKEN]]);
  } finally { chain.simulateV1 = false; }
  // Given less gas than the node charges for it, the token's call runs out, as on the chain (its reference is given
  // gas to spare, which isn't the call's).
  const short = (await base.simulate({ chainId: 8453, from: USER, to: TOKEN, data: encodeFunctionData({ abi: erc20, functionName: 'decimals' }), value: 0n, gas: 22_000n, at: { block: 'latest', header } }))!;
  assert.equal(short.status, 'reverted');
  // In a batch, each result names the stand-ins its own call reached.
  const [toToken, toBob] = (await base.simulateBatch([
    { chainId: 8453, from: USER, to: TOKEN, data: encodeFunctionData({ abi: erc20, functionName: 'decimals' }), value: 0n, at: { block: 'latest', header } },
    { chainId: 8453, from: USER, to: BOB, data: '0x', value: 0n, at: { block: 'latest', header } },
  ]))!;
  assert.deepEqual([toToken.standIns, toBob.standIns], [[TOKEN], undefined]);
  // A registry called itself is charged as the node charges it: isAuthorized(0, …), the always-allow policy, reads
  // nothing: 100 and 6 a word of its input (three), and the transaction's own.
  const isAuthorized = encodeFunctionData({ abi: parseAbi(['function isAuthorized(uint64,address) view returns (bool)']), functionName: 'isAuthorized', args: [0n, BOB] });
  // (The call's own gas, in its trace: the transaction's is the calldata floor's, EIP-7623, so little does it use.)
  const [asked] = (await base.trace([{ chainId: 8453, from: USER, to: '0x8453000000000000000000000000000000000002', data: isAuthorized, value: 0n, at: { block: 'latest', header } }]))!;
  assert.deepEqual([asked.status, asked.trace!.gasUsed, BigInt(asked.returnData!)], ['success', 118n, 1n]);
  // Run as another contract's code (DELEGATECALL), the chain's token refuses: DelegateCallNotAllowed().
  const DELEGATOR = '0x00000000000000000000000000000000000de1e9';
  await chain.putCode(DELEGATOR, `0x365f5f375f5f365f73${TOKEN.slice(2)}5af43d5f5f3e6029573d5ffd5b3d5ff3`);
  const delegated = (await base.simulate({ chainId: 8453, from: USER, to: DELEGATOR, data: encodeFunctionData({ abi: erc20, functionName: 'decimals' }), value: 0n, at: { block: 'latest', header } }))!;
  assert.deepEqual([delegated.status, delegated.returnData], ['reverted', '0x0d89438e']);
  // So do the registries.
  await chain.putCode(DELEGATOR, `0x365f5f375f5f365f738453000000000000000000000000000000000000000002${'5af43d5f5f3e6029573d5ffd5b3d5ff3'}`);
  const toRegistry = (await base.simulate({ chainId: 8453, from: USER, to: DELEGATOR, data: isAuthorized, value: 0n, at: { block: 'latest', header } }))!;
  assert.deepEqual([toRegistry.status, toRegistry.returnData], ['reverted', '0x0d89438e']);
  // Not at a block from before that upgrade, when Base ran its tokens by other rules: refused, as before.
  await assert.rejects(base.simulate({ chainId: 8453, from: USER, to: TOKEN, data: encodeFunctionData({ abi: erc20, functionName: 'decimals' }), value: 0n, at: { block: 'latest', header: { ...header, timestamp: 1_793_901_599n } } }),
    (e: unknown) => e instanceof ForkUnsupported && /from Base's upgrade of 2026-11-05 on/.test(e.message));
  // Only on Base, only behind the marker, only the variants and registries it has references for.
  assert.ok(nativeStandIn(8453, TOKEN, new Uint8Array([0xef])));
  assert.ok(nativeStandIn(8453, '0xb200000000000000000001123456789abcdef012', new Uint8Array([0xef])));
  assert.equal(nativeStandIn(8453, '0xb200000000000000000002123456789abcdef012', new Uint8Array([0xef])), undefined);
  assert.equal(nativeStandIn(10, TOKEN, new Uint8Array([0xef])), undefined);
  assert.equal(nativeStandIn(8453, TOKEN, new Uint8Array([0x60, 0x00])), undefined);
  assert.equal(nativeStandIn(8453, '0xb20f000000000000000000000000000000000000', new Uint8Array([0xef])), undefined);
});

test('A rate limit on state reads: the node’s wait is kept to, and a trace it denies says why', async () => {
  // A public node refusing reads for a while (HTTP 429), asking for a short wait: kept to, not the usual backoff.
  let refused = 0;
  const throttled = (times: number) => (async (u: string, init: RequestInit) => {
    if (String(init.body).startsWith('[') && refused < times) { refused++; return new Response('', { status: 429, headers: { 'retry-after': '0.01' } }); }
    return chain.fetchImpl(u, init);
  }) as typeof fetch;
  const req = { chainId: 999, from: '0x00000000000000000000000000000000000fa110', to: '0x00000000000000000000000000000000000fa111', data: '0x' as const, value: 0n };
  const started = Date.now();
  const r = await fork({ fetchImpl: throttled(6) }).simulate(req);
  assert.deepEqual([r?.status, refused], ['success', 6]);
  assert.ok(Date.now() - started < 2_000, 'the backoff would have taken over 9 seconds');
  // One that doesn't let up: a trace says the node rate limited its reads, not that it didn't finish in time.
  refused = 0;
  const sim = new RpcSimulator({ 999: URL_ }, { fetchImpl: chain.fetchImpl, fork: fork({ fetchImpl: throttled(Infinity) }) });
  await assert.rejects(sim.trace([req]), (e: unknown) => e instanceof Error && e.name === 'ForkUnsupported' && /rate limited those reads/.test(e.message));
});

test('Arbitrum: a replay’s local run has the gas the chain left it after the L1 data charge', async () => {
  // Arbitrum takes the gas for a transaction's L1 data out of its limit before running it (the receipt's
  // gasUsedForL1). A call given just what it needs runs; the same call, with 10,000 of its gas taken for L1 data,
  // runs out, as it would have on the chain.
  const LOOP = '0x00000000000000000000000000000000000c0dec';
  // i = 0x0200; loop: i--; until i == 0; STOP.
  await chain.putCode(LOOP, `0x${'610200' + '5b' + '6001' + '90' + '03' + '80' + '6003' + '57' + '00'}`);
  const arbitrum = fork({ profiles: { 999: { ...CHAIN_PROFILES[999], arbitrum: true } } });
  const [free] = (await arbitrum.simulateBatch([{ chainId: 999, from: USER, to: LOOP, data: '0x', value: 0n }]))!;
  const enough = free.gasUsed! + 2_000n;
  const [fits] = (await arbitrum.simulateBatch([{ chainId: 999, from: USER, to: LOOP, data: '0x', value: 0n, gas: enough }]))!;
  const [short] = (await arbitrum.simulateBatch([{ chainId: 999, from: USER, to: LOOP, data: '0x', value: 0n, gas: enough, gasForL1: 10_000n }]))!;
  assert.deepEqual([fits.status, short.status], ['success', 'reverted']);
  // Elsewhere the field means nothing.
  const [elsewhere] = (await fork().simulateBatch([{ chainId: 999, from: USER, to: LOOP, data: '0x', value: 0n, gas: enough, gasForL1: 10_000n }]))!;
  assert.equal(elsewhere.status, 'success');
});

test('Polygon lets a contract be 32,768 bytes long: a creation Ethereum’s limit refuses succeeds there', async () => {
  // The code creates a contract of `size` zero bytes and returns its address, or zero where the creation failed.
  const creating = (size: number) => `0x6561${size.toString(16).padStart(4, '0')}6000f360d01b600052600660006000f060005260206000f3`;
  const AT = '0x00000000000000000000000000000000c0de0001';
  const created = async (simulator: ForkSimulator, size: number) => {
    const r = await simulator.simulate({ chainId: 999, from: USER, to: AT, data: '0x', value: 0n, gas: 16_000_000n, stateOverrides: { [AT]: { code: creating(size) } } });
    return BigInt(r!.returnData!) !== 0n;
  };
  const polygon = fork({ profiles: { 999: { ...CHAIN_PROFILES[137] } } });
  // Measured on Polygon's node: 32,768 bytes of code are accepted, 32,769 are not. Elsewhere the limit is 24,576.
  assert.deepEqual([await created(polygon, 24_577), await created(polygon, 32_768), await created(polygon, 32_769)], [true, true, false]);
  assert.deepEqual([await created(fork(), 24_576), await created(fork(), 24_577)], [true, false]);
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

test('After a block’s earlier transactions, a precompile is asked for no storage, and one that won’t run the reader has none', async () => {
  // Storage after earlier transactions is read by putting a reader in each contract's place. A node runs a
  // precompile at its address whatever code is put there: Ethereum's point-evaluation precompile answered the
  // reader's input with an error, and a rollup's blob transaction that calls it had no trace.
  const header = { number: 17n, timestamp: 0x65000001n, coinbase: '0x0000000000000000000000000000000000000000', gasLimit: 30_000_000n, baseFeePerGas: 0n, prevRandao: `0x${'00'.repeat(32)}` as Hex };
  const IDENTITY = '0x0000000000000000000000000000000000000004', FAR = '0x00000000000000000000000000000000000fffff';
  const earlier: SimulationRequest = { chainId: 999, from: USER, to: BOB, data: '0x', value: 1n };
  const read: string[][] = [];
  // A node whose precompile at FAR (an address outside the usual range, as some chains have) fails on the reader.
  const node = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { method: string; params: [{ blockStateCalls: { stateOverrides?: Record<string, unknown>; calls: { to: string }[] }[] }] }[];
    const sim = Array.isArray(body) ? body.find(b => b.method === 'eth_simulateV1') : undefined;
    const res = await chain.fetchImpl(url, init);
    if (!sim) return res;
    const blocks = sim.params[0].blockStateCalls, storage = blocks.length > 1 ? blocks.at(-1)! : undefined;
    // The storage block is the one whose calls go to the contracts themselves (the readers put in their place).
    const reads = storage && storage.calls.every(c => Object.keys(storage.stateOverrides ?? {}).includes(c.to)) ? storage.calls.map(c => c.to) : [];
    read.push(reads);
    const out = await res.json() as { id: number; result?: { calls: { status: string }[] }[] }[];
    for (const o of out) if (o.result && reads.length) o.result.at(-1)!.calls.forEach((c, i) => { if (reads[i] === FAR) c.status = '0x0'; });
    return new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  chain.simulateV1 = true;
  try {
    for (const to of [IDENTITY, FAR]) {
      const [r] = (await fork({ fetchImpl: node }).trace([{ chainId: 999, from: USER, to, data: '0x1234', value: 0n, at: { block: '0x10', header, before: [earlier] } }]))!;
      assert.equal(r.status, 'success');
    }
    // The identity precompile's storage was never asked for; FAR's was, failed, and counted as empty.
    assert.deepEqual([read.flat().includes(IDENTITY), read.flat().includes(FAR)], [false, true]);
  } finally { chain.simulateV1 = false; }
});

test('A node that adds up a block’s gas limits gets the earlier transactions on less gas each, and none may run short', async () => {
  // As in the test above, Bob's transfer of 30 USDC only works after the user's 50 to him. Here the two earlier
  // transactions were given 20 million gas each in a block of 30 million, and the node (reth's eth_simulateV1, as
  // BNB Chain's public node runs it) refuses calls whose limits add up past the block's.
  const CAROL = '0xca401000000000000000000000000000000000c3';
  const header = { number: 17n, timestamp: 0x65000001n, coinbase: '0x0000000000000000000000000000000000000000', gasLimit: 30_000_000n, baseFeePerGas: 0n, prevRandao: `0x${'00'.repeat(32)}` as Hex };
  const earlier: SimulationRequest[] = [50_000_000n, 1n].map(amount => ({ chainId: 999, from: USER, to: usdc, data: call('transfer', [BOB, amount]), value: 0n, gas: 20_000_000n }));
  const target: SimulationRequest = { chainId: 999, from: BOB, to: usdc, data: call('transfer', [CAROL, 30_000_000n]), value: 0n };
  await chain.setBalance(BOB, E);
  const asked: bigint[][] = [];
  const adding = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { id: number; method: string; params: [{ blockStateCalls: { calls: { gas?: string }[] }[] }] }[];
    const sim = Array.isArray(body) ? body.find(b => b.method === 'eth_simulateV1') : undefined;
    const limits = sim?.params[0].blockStateCalls[0].calls.map(c => BigInt(c.gas ?? 0)) ?? [];
    if (sim) asked.push(limits);
    if (limits.reduce((a, b) => a + b, 0n) > header.gasLimit) return new Response(JSON.stringify(body.map(b => ({ jsonrpc: '2.0', id: b.id, error: { code: -38015, message: "Block gas limit exceeded by the block's transactions" } }))), { headers: { 'content-type': 'application/json' } });
    return chain.fetchImpl(url, init);
  }) as typeof fetch;
  chain.simulateV1 = true;
  try {
    // Each used about 60,000: it gets 140,000 and half the room left, 15 million in all.
    const [r] = (await fork({ fetchImpl: adding }).trace([{ ...target, at: { block: '0x10', header, before: earlier, beforeUsed: async () => [60_000n, 60_000n] } }]))!;
    assert.equal(r.status, 'success');
    assert.deepEqual([asked[0], [...new Set(asked.slice(1).map(l => l.join()))]], [[20_000_000n, 20_000_000n], ['15000000,15000000']]);
    // A call that uses all of the little it was sized for isn't taken on trust. This one grows its memory for
    // 92,000 gas; sized as if it had used 100, in a block of 200,000, it gets 55,075 and runs out.
    const HEAVY = '0x00000000000000000000000000000000000c0dea';
    await chain.putCode(HEAVY, '0x6001620300005200');
    const heavy: SimulationRequest = { chainId: 999, from: USER, to: HEAVY, data: '0x', value: 0n, gas: 20_000_000n };
    await assert.rejects(fork({ fetchImpl: adding }).trace([{ ...target, at: { block: '0x10', header: { ...header, gasLimit: 200_000n }, before: [heavy, earlier[0]], beforeUsed: async () => [100n, 60_000n] } }]), /may have run short/);
    assert.deepEqual(asked.at(-1), [55_075n, 144_925n]);
    // Without what they used, the node's refusal stands.
    await assert.rejects(fork({ fetchImpl: adding }).trace([{ ...target, at: { block: '0x10', header, before: earlier } }]), /Block gas limit exceeded/);
  } finally { chain.simulateV1 = false; }
});

test('After a block’s earlier transactions, each storage reader is given gas for the chain’s price of a cold read', async () => {
  // Polygon charges 5,460 for a cold read, not 2,100: a reader of 65 slots on 3,000 each ran out there.
  const header = { number: 17n, timestamp: 0x65000001n, coinbase: '0x0000000000000000000000000000000000000000', gasLimit: 30_000_000n, baseFeePerGas: 0n, prevRandao: `0x${'00'.repeat(32)}` as Hex };
  const earlier: SimulationRequest = { chainId: 999, from: USER, to: BOB, data: '0x', value: 1n };
  const given: [number, number][] = [];
  const node = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { method: string; params: [{ blockStateCalls: { stateOverrides?: Record<string, unknown>; calls: { to: string; data: string; gas?: string }[] }[] }] }[];
    const sim = Array.isArray(body) ? body.find(b => b.method === 'eth_simulateV1') : undefined;
    const storage = sim?.params[0].blockStateCalls.at(-1);
    if (storage && storage.calls.every(c => Object.keys(storage.stateOverrides ?? {}).includes(c.to))) for (const c of storage.calls) given.push([(c.data.length - 2) / 64, Number(c.gas)]);
    return chain.fetchImpl(url, init);
  }) as typeof fetch;
  chain.simulateV1 = true;
  try {
    const polygonLike = fork({ fetchImpl: node, profiles: { 999: { ...profiles[999], storageGas: { coldRead: 5460, coldWrite: 2940 } } } });
    const [r] = (await polygonLike.trace([{ chainId: 999, from: USER, to: usdc, data: call('transfer', [BOB, 1n]), value: 0n, at: { block: '0x10', header, before: [earlier] } }]))!;
    assert.equal(r.status, 'success');
    assert.ok(given.length > 0);
    for (const [slots, gas] of given) assert.equal(gas, 50_000 + 6_360 * slots);
  } finally { chain.simulateV1 = false; }
});

test('After a block’s earlier transactions, the reads of many accounts aren’t starved by a node that splits a block’s gas', async () => {
  // BNB Chain's node gives each call that sets no gas an even share of the block's: beside 151 code readers, the one
  // reading 152 accounts' balances got 460,526 gas and ran out. A call that reads the balances of 150 accounts:
  // 0x1000 to 0x1095, by BALANCE in a loop.
  const header = { number: 17n, timestamp: 0x65000001n, coinbase: '0x0000000000000000000000000000000000000000', gasLimit: 30_000_000n, baseFeePerGas: 0n, prevRandao: `0x${'00'.repeat(32)}` as Hex };
  const MANY = '0x00000000000000000000000000000000000c0deb';
  // i = 0x1000; loop: BALANCE(i) POP; i++; until i == 0x1096; STOP.
  await chain.putCode(MANY, `0x${'611000' + '5b' + '80' + '31' + '50' + '6001' + '01' + '80' + '611096' + '14' + '6015' + '57' + '6003' + '56' + '5b' + '00'}`);
  for (let i = 0; i < 150; i++) await chain.putCode(`0x${(0x1000 + i).toString(16).padStart(40, '0')}` as Hex, '0x00');
  const earlier: SimulationRequest = { chainId: 999, from: USER, to: BOB, data: '0x', value: 1n };
  const splitting = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    for (const b of Array.isArray(body) ? body : [body]) if (b.method === 'eth_simulateV1') for (const block of b.params[0].blockStateCalls as { calls: { gas?: string }[] }[]) {
      const set = block.calls.reduce((sum, c) => sum + (c.gas ? BigInt(c.gas) : 0n), 0n), unset = BigInt(block.calls.filter(c => !c.gas).length);
      for (const c of block.calls) if (!c.gas && unset) c.gas = `0x${((header.gasLimit - set) / unset).toString(16)}`;
    }
    return chain.fetchImpl(url, { ...init, body: JSON.stringify(body) });
  }) as typeof fetch;
  chain.simulateV1 = true;
  try {
    const [r] = (await fork({ fetchImpl: splitting }).trace([{ chainId: 999, from: USER, to: MANY, data: '0x', value: 0n, gas: 5_000_000n, at: { block: '0x10', header, before: [earlier] } }]))!;
    assert.equal(r.status, 'success');
    assert.ok(r.trace);
  } finally { chain.simulateV1 = false; }
});

test('A node that refuses a block’s earlier transactions two ways at once gets both met: less gas each, and blob calls plain', async () => {
  // BNB Chain's node, for a replay merged with its second's earlier block: their gas limits add up past the block's,
  // and once they don't, a blob transaction among them isn't buildable.
  const header = { number: 17n, timestamp: 0x65000001n, coinbase: '0x0000000000000000000000000000000000000000', gasLimit: 30_000_000n, baseFeePerGas: 0n, prevRandao: `0x${'00'.repeat(32)}` as Hex };
  const earlier: SimulationRequest[] = [
    { chainId: 999, from: USER, to: usdc, data: call('transfer', [BOB, 50_000_000n]), value: 0n, gas: 20_000_000n },
    { chainId: 999, from: USER, to: BOB, data: '0x', value: 1n, gas: 20_000_000n, gasPrice: 5n, blobVersionedHashes: [`0x01${'00'.repeat(31)}`], maxFeePerBlobGas: 1n },
  ];
  const refusals: string[] = [];
  const picky = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { id: number; method: string; params: [{ blockStateCalls: { calls: { gas?: string; blobVersionedHashes?: string[] }[] }[] }] }[];
    const sim = Array.isArray(body) ? body.find(b => b.method === 'eth_simulateV1') : undefined;
    const calls = sim?.params[0].blockStateCalls[0].calls ?? [];
    const refuse = (message: string) => { refusals.push(message); return new Response(JSON.stringify(body.map(b => ({ jsonrpc: '2.0', id: b.id, error: { code: -32000, message } }))), { headers: { 'content-type': 'application/json' } }); };
    if (sim && calls.reduce((a, c) => a + BigInt(c.gas ?? 0), 0n) > header.gasLimit) return refuse("Block gas limit exceeded by the block's transactions");
    if (sim && calls.some(c => c.blobVersionedHashes)) return refuse('Transaction is not buildable');
    return chain.fetchImpl(url, init);
  }) as typeof fetch;
  chain.simulateV1 = true;
  try {
    const [r] = (await fork({ fetchImpl: picky }).trace([{ chainId: 999, from: BOB, to: usdc, data: call('transfer', ['0xca401000000000000000000000000000000000c3', 30_000_000n]), value: 0n, at: { block: '0x10', header, before: earlier, beforeUsed: async () => [60_000n, 21_000n] } }]))!;
    assert.equal(r.status, 'success');
    assert.deepEqual([...new Set(refusals)], ["Block gas limit exceeded by the block's transactions", 'Transaction is not buildable']);
  } finally { chain.simulateV1 = false; }
});

test('After a block’s earlier transactions, an account’s nonce counts its authorizations; a node that won’t build blob calls gets them plain', async () => {
  const header = { number: 17n, timestamp: 0x65000001n, coinbase: '0x0000000000000000000000000000000000000000', gasLimit: 30_000_000n, baseFeePerGas: 0n, prevRandao: `0x${'00'.repeat(32)}` as Hex };
  const KEY = `0x${'9a'.repeat(32)}` as Hex, sender = privateKeyToAccount(KEY).address.toLowerCase();
  await chain.setBalance(sender, E);
  const authorization = async (nonce: number, chainId = 999) => {
    const a = await privateKeyToAccount(KEY).signAuthorization({ address: weth as Hex, chainId, nonce });
    return { address: weth, chainId: toHex(chainId), nonce: toHex(nonce), r: a.r, s: a.s, yParity: toHex(a.yParity!) };
  };
  // The sender (nonce 0 before the block) delegated itself in an earlier transaction: sending it took its nonce to
  // 1, and its authorization, for 1, to 2. One for another chain, or for a nonce that isn't the account's, moves
  // nothing. So the transaction replayed is sent at 2, and its own authorization, for 3, is good: it is applied.
  const earlier: SimulationRequest[] = [
    { chainId: 999, from: sender, to: BOB, data: '0x', value: 0n, authorizationList: [await authorization(1), await authorization(2, 5), await authorization(7)] },
    { chainId: 999, from: USER, to: BOB, data: '0x', value: 1n, gasPrice: 5n, blobVersionedHashes: [`0x01${'00'.repeat(31)}`], maxFeePerBlobGas: 1n },
  ];
  const target: SimulationRequest = { chainId: 999, from: sender, to: BOB, data: '0x', value: 0n, authorizationList: [await authorization(3)] };
  // This node, like BNB Chain's, refuses a call that names blob hashes.
  const asked: Record<string, unknown>[][] = [];
  const picky = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { id: number; method: string; params: [{ blockStateCalls: { calls: Record<string, unknown>[] }[] }] }[];
    const sim = Array.isArray(body) ? body.find(b => b.method === 'eth_simulateV1') : undefined;
    if (sim) asked.push(sim.params[0].blockStateCalls[0].calls);
    if (sim?.params[0].blockStateCalls[0].calls.some(c => c.blobVersionedHashes)) return new Response(JSON.stringify(body.map(b => ({ jsonrpc: '2.0', id: b.id, error: { code: -32000, message: 'Transaction is not buildable' } }))), { headers: { 'content-type': 'application/json' } });
    return chain.fetchImpl(url, init);
  }) as typeof fetch;
  chain.simulateV1 = true;
  try {
    const [r] = (await fork({ fetchImpl: picky }).trace([{ ...target, at: { block: '0x10', header, before: earlier } }]))!;
    assert.deepEqual([r.status, r.stateChanges!.find(c => c.address === sender)], ['success', { address: sender, nonce: { before: 3n, after: 4n }, code: true }]);
    // Asked twice: as the transactions were, then with the blob transaction as a plain call at its price.
    const shapes = asked.map(calls => JSON.stringify(calls.map(c => [c.gasPrice ?? null, c.maxFeePerGas ?? null, c.blobVersionedHashes !== undefined])));
    assert.deepEqual([shapes[0], [...new Set(shapes.slice(1))]], ['[[null,null,false],[null,"0x5",true]]', ['[[null,null,false],["0x5",null,false]]']]);
  } finally { chain.simulateV1 = false; }
});

test('A replay that starts from what its block had changed (the block’s access list): balances, nonces, code and storage', async () => {
  // As above, Bob's transfer of 30 USDC only works after the user's 50 to him. Here nothing is run first: the state
  // the earlier transaction left is given (BlockAt.state), as a block's access list has it from Amsterdam on.
  const CAROL = '0xca401000000000000000000000000000000000c3', MADE = '0xca401000000000000000000000000000000000c4';
  const header = { number: 17n, timestamp: 0x65000001n, coinbase: '0x0000000000000000000000000000000000000000', gasLimit: 30_000_000n, baseFeePerGas: 0n, prevRandao: `0x${'00'.repeat(32)}` as Hex };
  const earlier: SimulationRequest = { chainId: 999, from: USER, to: usdc, data: call('transfer', [BOB, 50_000_000n]), value: 0n };
  const target: SimulationRequest = { chainId: 999, from: BOB, to: usdc, data: call('transfer', [CAROL, 30_000_000n]), value: 0n };
  // The slots the earlier transfer writes, from a traced run of it: the user's balance and Bob's.
  const [ran] = (await fork().trace([{ ...earlier, at: { block: '0x10', header } }]))!;
  const written = ran.stateChanges!.find(c => c.address === usdc)!.storage!;
  assert.equal(written.length, 2);
  const state = {
    [usdc]: { stateDiff: Object.fromEntries(written.map(s => [s.slot, s.after])) },
    // Bob had sent four more transactions and holds 3 HYPE by then; a contract made earlier in the block returns 42.
    [BOB]: { nonce: '0x9', balance: toHex(3n * E) },
    [MADE]: { nonce: '0x1', code: '0x602a60005260206000f3' },
  };
  const [alone] = (await fork().simulateBatch([{ ...target, at: { block: '0x10', header } }]))!;
  assert.equal(alone.status, 'reverted');
  const at = { block: '0x10', header, state };
  const [there, made, creation] = (await fork().trace([{ ...target, at }, { chainId: 999, from: BOB, to: MADE, data: '0x', value: 1n, at }, { chainId: 999, from: BOB, to: null, data: '0x60646000f3', value: 0n, at }]))!;
  assert.deepEqual([there.status, there.transfers.map(t => [t.asset, t.from, t.raw])], ['success', [[usdc, BOB, 30_000_000n]]]);
  // What the run changed is counted from that state: Bob had 50 USDC.
  const slots = there.stateChanges!.find(c => c.address === usdc)!.storage!;
  assert.deepEqual(slots.map(s => [BigInt(s.before), BigInt(s.after)]).sort((a, b) => Number(b[0] - a[0])), [[50_000_000n, 20_000_000n], [0n, 30_000_000n]]);
  // The contract made earlier in the block is there to call, and the wei sent to it leaves the 3 HYPE Bob had by then.
  assert.deepEqual([made.status, BigInt(made.returnData!)], ['success', 42n]);
  assert.deepEqual(made.stateChanges!.find(c => c.address === BOB.toLowerCase())!.balance, { before: 3n * E, after: 3n * E - 1n });
  // A contract Bob creates is at the address his nonce gives it: 9 by then, and the two calls before it here.
  assert.equal(creation.status, 'success');
  assert.ok(creation.stateChanges!.some(c => c.address === getContractAddress({ from: BOB as Hex, nonce: 11n }).toLowerCase() && c.code));
  // A request's own state overrides go on top of it.
  const [over] = (await fork().simulateBatch([{ ...target, at: { block: '0x10', header, state }, stateOverrides: { [usdc]: { stateDiff: Object.fromEntries(written.map(s => [s.slot, `0x${'00'.repeat(32)}`])) } } }]))!;
  assert.equal(over.status, 'reverted');
});

test('A balance the caller sets for the simulation: the local EVM and the chain’s own eth_call both run with it', async () => {
  // An account with nothing sends 1 HYPE: it can't, unless the simulation is told it holds two.
  const POOR = '0x9007000000000000000000000000000000000001';
  const req: SimulationRequest = { chainId: 999, from: POOR, to: BOB, data: '0x', value: E };
  const [without] = (await fork().simulateBatch([req]))!;
  assert.equal(without.status, 'reverted');
  const [withIt] = (await fork().simulateBatch([{ ...req, stateOverrides: { [POOR]: { balance: toHex(2n * E) } } }]))!;
  assert.deepEqual([withIt.status, withIt.transfers.map(t => [t.asset, t.from, t.raw])], ['success', [['native', POOR, E]]]);
  // Through a preview: the context's overrides reach the simulation, and the preview says the state was set.
  const p = await previewRequest({ method: 'eth_sendTransaction', params: [{ from: POOR, to: BOB, value: toHex(E), chainId: '0x3e7' }] }, { now: NOW, stateOverrides: { [POOR]: { balance: (2n * E).toString() } } }, deps);
  assert.equal(p.simulation?.status, 'success');
  assert.ok(codes(p).includes('state_overridden'));
  assert.deepEqual(changes(p), [['out', '1', 'HYPE', 'simulated_state']]);
});

test('Rules that aren’t today’s or aren’t the local EVM’s: a past Ethereum block, a fork not checked, a precompile only the node has', async () => {
  // Ethereum's fork at a block, by its number and time; the blob-parameter forks run as Osaka; nothing later than the profile's.
  const at = (number: bigint, timestamp: bigint) => mainnetForkAt({ number, timestamp }, 'osaka');
  assert.deepEqual([at(16_000_000n, 1_670_000_000n), at(17_500_000n, 1_690_000_000n), at(19_500_000n, 1_711_000_000n), at(22_500_000n, 1_747_000_000n), at(24_000_000n, 1_765_000_000n), at(25_000_000n, 1_770_000_000n), at(30_000_000n, 1_900_000_000n)],
    ['paris', 'shanghai', 'cancun', 'prague', 'osaka', 'osaka', 'osaka']);
  assert.equal(mainnetForkAt({ number: 19_500_000n, timestamp: 1_711_000_000n }, 'cancun'), 'cancun');
  assert.throws(() => at(15_000_000n, 1_655_000_000n), (e: Error) => e instanceof ForkUnsupported && /before the Merge/.test(e.message));
  // A contract using PUSH0 (Shanghai): invalid in a block from before it, fine after. Only a block that was asked for
  // is run under its own rules; the latest block runs under today's.
  const PUSH0 = '0x00000000000000000000000000000000000c0de0';
  await chain.putCode(PUSH0, '0x5f60005260206000f3');
  const mainnet = () => new ForkSimulator({ 1: URL_ }, { fetchImpl: chain.fetchImpl });
  const header = (number: bigint, timestamp: bigint) => ({ number, timestamp, coinbase: '0x0000000000000000000000000000000000000000', gasLimit: 30_000_000n, baseFeePerGas: 0n, prevRandao: `0x${'00'.repeat(32)}` as Hex });
  const req: SimulationRequest = { chainId: 1, from: USER, to: PUSH0, data: '0x', value: 0n };
  const run = async (h: ReturnType<typeof header>, required = true) => (await mainnet().simulateBatch([{ ...req, at: { block: '0x10', header: h, required } }]))![0];
  assert.match((await run(header(16_000_000n, 1_670_000_000n))).revertReason ?? '', /invalid opcode/i);
  assert.equal((await run(header(17_500_000n, 1_690_000_000n))).status, 'success');
  assert.equal((await run(header(16_000_000n, 1_670_000_000n), false)).status, 'success');
  await assert.rejects(run(header(15_000_000n, 1_655_000_000n)), ForkUnsupported);
  // Arbitrum's BLOCKHASH is the chain's own function of the number (it takes L1 block numbers), which only its node
  // can answer: the opcode is run there, where another chain's is the hash of the block with that number.
  const PREVIOUS = '0x00000000000000000000000000000000000c0de7';
  await chain.putCode(PREVIOUS, '0x600143034060005260206000f3');
  const previous = async (chainId: number) => (await new ForkSimulator({ [chainId]: URL_ }, { fetchImpl: chain.fetchImpl }).simulateBatch([{ chainId, from: USER, to: PREVIOUS, data: '0x', value: 0n }]))![0].returnData;
  clearForkCaches();
  const calls = chain.stats.calls.eth_call ?? 0;
  assert.equal(await previous(1), keccak256(encodeAbiParameters([{ type: 'uint256' }], [16n])));
  assert.equal(chain.stats.calls.eth_call ?? 0, calls);
  assert.notEqual(await previous(42161), await previous(1));
  assert.ok((chain.stats.calls.eth_call ?? 0) > calls);
  // Arbitrum has no BLOBBASEFEE: its node refuses the opcode, and so does the local EVM for it.
  const BLOBFEE = '0x00000000000000000000000000000000000c0de1';
  await chain.putCode(BLOBFEE, '0x4a60005260206000f3');
  const blobFee = async (chainId: number) => (await new ForkSimulator({ [chainId]: URL_ }, { fetchImpl: chain.fetchImpl }).simulateBatch([{ chainId, from: USER, to: BLOBFEE, data: '0x', value: 0n }]))![0].status;
  assert.deepEqual([await blobFee(1), await blobFee(42161), await blobFee(137)], ['success', 'reverted', 'reverted']);
  // Polygon prices the bn254 precompiles its own way: adding two points costs 540 there (150 on Ethereum), a pairing
  // of no pairs 67,500 (45,000). A call straight to each, with no input: the 21,000 base and the precompile's price.
  const precompileGas = async (chainId: number, address: number) => (await new ForkSimulator({ [chainId]: URL_ }, { fetchImpl: chain.fetchImpl }).simulateBatch([{ chainId, from: USER, to: `0x${address.toString(16).padStart(40, '0')}`, data: '0x', value: 0n }]))![0].gasUsed! - 21_000n;
  assert.deepEqual([await precompileGas(1, 6), await precompileGas(1, 7), await precompileGas(1, 8)], [150n, 6_000n, 45_000n]);
  assert.deepEqual([await precompileGas(137, 6), await precompileGas(137, 7), await precompileGas(137, 8)], [540n, 12_600n, 67_500n]);
  // ...blake2f 22 gas a round where Ethereum charges 1. A thousand rounds: 21,000, the calldata's 3,204 and 22,000
  // there; on Ethereum the 1,000 leave the transaction under its calldata floor, which is what it pays.
  const blake = async (chainId: number) => (await new ForkSimulator({ [chainId]: URL_ }, { fetchImpl: chain.fetchImpl }).simulateBatch([{ chainId, from: USER, to: `0x${'0'.repeat(39)}9`, data: `0x000003e8${'5a'.repeat(64)}${'c3'.repeat(128)}${'00'.repeat(15)}0301`, value: 0n }]))![0].gasUsed!;
  assert.deepEqual([await blake(137), await blake(1)], [46_204n, 29_010n]);
  // ...and has no point-evaluation precompile: 0x0a is an empty account there, a call to it the bare 21,000.
  assert.equal(await precompileGas(137, 10), 0n);
  // Polygon, which carries no blobs, has no BLOBHASH either.
  const BLOBHASH = '0x00000000000000000000000000000000000c0de2';
  await chain.putCode(BLOBHASH, '0x60004960005260206000f3');
  const blobHash = async (chainId: number) => (await new ForkSimulator({ [chainId]: URL_ }, { fetchImpl: chain.fetchImpl }).simulateBatch([{ chainId, from: USER, to: BLOBHASH, data: '0x', value: 0n }]))![0].status;
  assert.deepEqual([await blobHash(1), await blobHash(42161), await blobHash(137)], ['success', 'success', 'reverted']);

  // The point-evaluation precompile (0x0a) needs a KZG library this package doesn't carry: the chain's node answers
  // it (a pure function of its input), at the precompile's own price. A contract that calls it and returns its answer:
  const VERIFIER = '0x00000000000000000000000000000000000c0de3', KZG = '0x000000000000000000000000000000000000000a';
  await chain.putCode(VERIFIER, '0x36600060003760406000366000600a5afa503d600060003e3d6000f3');
  const answer = `0x${'00'.repeat(30)}1000${'73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001'}`;
  const asked: string[] = [];
  const nodeWithKzg = (ok: boolean) => (async (u: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const one = async (r: { id: number; method: string; params: [{ to?: string; data?: string }] }) => {
      if (r.method !== 'eth_call' || r.params[0].to !== KZG) return (await chain.fetchImpl(u, { ...init, body: JSON.stringify(r) })).json();
      asked.push(r.params[0].data!);
      return ok ? { jsonrpc: '2.0', id: r.id, result: answer } : { jsonrpc: '2.0', id: r.id, error: { code: -32000, message: 'execution reverted', data: '0x' } };
    };
    return new Response(JSON.stringify(Array.isArray(body) ? await Promise.all(body.map(one)) : await one(body)));
  }) as typeof fetch;
  const proof = `0x${'11'.repeat(192)}` as Hex;
  const verify = async (ok: boolean) => (await new ForkSimulator({ 1: URL_ }, { fetchImpl: nodeWithKzg(ok) }).simulateBatch([{ chainId: 1, from: USER, to: VERIFIER, data: proof, value: 0n }]))![0];
  clearForkCaches();
  const good = await verify(true);
  assert.deepEqual([good.status, good.returnData, asked.includes(proof)], ['success', answer, true]);
  assert.ok(good.gasUsed! > 21_000n + 50_000n && good.gasUsed! < 21_000n + 50_000n + 12_000n, `gas ${good.gasUsed}`);
  // A proof the node rejects: the call to the precompile fails, and the contract returns nothing.
  clearForkCaches();
  assert.deepEqual([(await verify(false)).status, (await verify(false)).returnData ?? '0x'], ['success', '0x']);

  // What a node says of its rules (eth_config): its fork id, when the fork took effect, its precompiles by address.
  assert.deepEqual(nodeRulesOf({ current: { forkId: '0xAB', activationTime: 1_700_000_000, precompiles: { ECREC: '0x01', TxContext: '0x813000000000000000000000000000000000AA02' } } }),
    { forkId: '0xab', activation: 1_700_000_000, precompiles: new Map([['0x0000000000000000000000000000000000000001', 'ECREC'], ['0x813000000000000000000000000000000000aa02', 'TxContext']]) });
  // A node that lists no current fork (Polygon's), or has no eth_config: nothing is taken from it.
  assert.deepEqual([nodeRulesOf({ next: { precompiles: { ECREC: '0x01' } } }), nodeRulesOf(undefined), nodeRulesOf({ current: {} })], [undefined, undefined, undefined]);

  const NATIVE = '0x813000000000000000000000000000000000aa02';
  const caller = await chain.deploy('Router'); // any contract: the request below calls the precompile directly
  void caller;
  try {
    // The node lists a precompile the local EVM doesn't have: a call reaching it is refused, not run as an empty account.
    chain.config = { current: { forkId: '0x169d85a3', activationTime: 1_793_901_600, precompiles: { ECREC: '0x0000000000000000000000000000000000000001', TxContext: NATIVE } } };
    const base = () => new ForkSimulator({ 8453: URL_ }, { fetchImpl: chain.fetchImpl });
    await assert.rejects(base().simulateBatch([{ chainId: 8453, from: USER, to: NATIVE, data: '0x', value: 0n }]), (e: Error) => e instanceof ForkUnsupported && /is TxContext, a precompile this chain's node has and the local EVM doesn't/.test(e.message));
    // Anything else runs, and on the fork the profile was checked against nothing is said.
    const [fine] = (await base().simulateBatch([{ chainId: 8453, from: USER, to: usdc, data: call('transfer', [BOB, 1n]), value: 0n }]))!;
    assert.deepEqual([fine.status, fine.rulesNote], ['success', undefined]);
    // The node has moved to another fork: the run says its rules weren't checked against it.
    chain.config = { current: { forkId: '0xdeadbeef', activationTime: 1_796_697_000, precompiles: { ECREC: '0x0000000000000000000000000000000000000001' } } };
    const [moved] = (await base().simulateBatch([{ chainId: 8453, from: USER, to: usdc, data: call('transfer', [BOB, 1n]), value: 0n }]))!;
    assert.equal(moved.rulesNote, "Base's rules changed on 2026-12-08 since the local EVM here was last checked against the chain (2026-11-10), so its run may differ from the chain's, in gas above all.");
    // A block asked for from before the node's current fork, on a chain whose past forks aren't selected between.
    chain.config = { current: { forkId: '0x169d85a3', activationTime: 1_793_901_600, precompiles: {} } };
    const [old] = (await base().simulateBatch([{ chainId: 8453, from: USER, to: usdc, data: call('transfer', [BOB, 1n]), value: 0n, at: { block: '0x10', header: header(40_000_000n, 1_780_000_000n), required: true } }]))!;
    assert.match(old.rulesNote!, /^This block is from before Base's current rules took effect \(2026-11-05\)\. The local EVM runs today's rules/);
  } finally { chain.config = undefined; }
});

test('Amsterdam (Glamsterdam) blocks run Amsterdam’s rules: what Sepolia’s node charges, and the chain’s own transfer log', async () => {
  // A block whose header says it is Amsterdam's, on Ethereum's testnet. The gas figures are those Sepolia's node gave
  // for the same requests on 2026-11-11.
  const amsterdam = { number: 17n, timestamp: 0x65000001n, coinbase: '0x0000000000000000000000000000000000000000', gasLimit: 200_000_000n, baseFeePerGas: 0n, prevRandao: `0x${'00'.repeat(32)}` as Hex, amsterdam: true, slotNumber: 11_552_491n };
  const osaka = { ...amsterdam, amsterdam: undefined, slotNumber: undefined };
  const FROM = '0x00000000000000000000000000000000000a11ce', EOA = BOB, NEW = '0x00000000000000000000000000000000beef0456';
  await chain.setBalance(FROM, 10n * E);
  const run = async (extra: Partial<SimulationRequest>, header: typeof amsterdam | typeof osaka = amsterdam, chainId = 11155111) =>
    (await new ForkSimulator({ [chainId]: URL_ }, { fetchImpl: chain.fetchImpl }).simulateBatch([{ chainId, from: FROM, to: EOA, data: '0x', value: 0n, at: { block: '0x10', header }, ...extra }]))![0];
  const gas = async (extra: Partial<SimulationRequest>, header: typeof amsterdam | typeof osaka = amsterdam) => (await run(extra, header)).gasUsed;
  // A base of 12,000; 3,000 for the recipient unless the sender calls itself; 6,000 more when value moves.
  assert.deepEqual([await gas({}), await gas({ to: FROM }), await gas({ value: 1n })], [15_000n, 12_000n, 21_000n]);
  // A new account's state is paid for: 120 bytes at 1,530 each.
  assert.equal(await gas({ to: NEW, value: 1n }), 204_600n);
  // The calldata floor counts every byte, zero or not, as four tokens at 16.
  assert.deepEqual([await gas({ data: `0x${'11'.repeat(1000)}` }), await gas({ data: `0x${'00'.repeat(1000)}` })], [79_000n, 79_000n]);
  // An access list: 2,900 an address, 2,000 a key, and its bytes at the floor's price.
  const slot = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
  assert.equal(await gas({ accessList: [{ address: usdc, storageKeys: [slot(1), slot(2)] }, { address: weth, storageKeys: [slot(3)] }] }), 35_504n);
  // A creation: 100 bytes of code, whose state is paid for too.
  assert.equal(await gas({ to: null, data: '0x60646000f3' }), 360_712n);
  // The same requests under Osaka's rules (a block that isn't Amsterdam's): the 21,000 base.
  assert.deepEqual([await gas({}, osaka), await gas({ to: FROM }, osaka), await gas({ value: 1n }, osaka)], [21_000n, 21_000n, 21_000n]);
  // Only Ethereum and its testnet take the header's word: another chain keeps its own profile.
  assert.equal((await run({}, amsterdam, 8453)).gasUsed, 21_000n);

  // A native transfer is logged by the chain itself (EIP-7708), from an address of its own: the native coin moving,
  // not a token there.
  const sent = await run({ value: E });
  assert.deepEqual(sent.logs!.map(l => [l.address, l.topics.length]), [['0xfffffffffffffffffffffffffffffffffffffffe', 3]]);
  assert.deepEqual(sent.transfers.map(t => [t.asset, t.from, t.raw]), [['native', FROM, E]]);
  assert.equal((await run({ value: E }, osaka)).logs!.length, 0);
  // SLOTNUM (EIP-7843) reads the block's slot; before Amsterdam it is no opcode.
  const SLOT = '0x00000000000000000000000000000000000c0de4';
  await chain.putCode(SLOT, '0x4b60005260206000f3');
  assert.equal(BigInt((await run({ to: SLOT })).returnData!), 11_552_491n);
  assert.equal((await run({ to: SLOT }, osaka)).status, 'reverted');
  // EIP-7702 authorizations under Amsterdam: 7,816 each, applied or not. One that is applied pays 9,000 for the first
  // write to the authority's account, and for the state it adds: an authority with no account yet, 143 bytes at
  // 1,530; one that exists, the delegation's 23 bytes; one already delegated, nothing more. (What Sepolia charged
  // transactions mined by each kind of authority, and its node each of these; the EVM library's reference has the
  // 9,000 for new accounts only.)
  const authorization = async (key: Hex, nonce: number) => {
    const a = await privateKeyToAccount(key).signAuthorization({ address: weth as Hex, chainId: 11155111, nonce });
    return { address: weth, chainId: toHex(11155111), nonce: toHex(nonce), r: a.r, s: a.s, yParity: toHex(a.yParity!) };
  };
  const NOBODY = `0x${'a7'.repeat(32)}` as Hex, SOMEBODY = `0x${'b8'.repeat(32)}` as Hex, DELEGATED = `0x${'c9'.repeat(32)}` as Hex;
  await chain.setBalance(privateKeyToAccount(SOMEBODY).address.toLowerCase(), 1n);
  await chain.setBalance(privateKeyToAccount(DELEGATED).address.toLowerCase(), 1n);
  await chain.putCode(privateKeyToAccount(DELEGATED).address.toLowerCase(), `0xef0100${'11'.repeat(20)}`);
  assert.deepEqual([await gas({ authorizationList: [await authorization(NOBODY, 0)] }), await gas({ authorizationList: [await authorization(SOMEBODY, 0)] }), await gas({ authorizationList: [await authorization(DELEGATED, 0)] }), await gas({ authorizationList: [await authorization(NOBODY, 7)] })],
    [15_000n + 7_816n + 9_000n + 143n * 1_530n, 15_000n + 7_816n + 9_000n + 23n * 1_530n, 15_000n + 7_816n + 9_000n, 15_000n + 7_816n]);
  // The write is paid once for an account: an authority's second authorization in the transaction pays for no
  // write, and the sender's own account, which the transaction writes anyway, for none at all.
  const TWICE = `0x${'d1'.repeat(32)}` as Hex, SENDER = `0x${'e2'.repeat(32)}` as Hex, sender = privateKeyToAccount(SENDER).address.toLowerCase();
  await chain.setBalance(sender, E);
  assert.deepEqual([await gas({ authorizationList: [await authorization(TWICE, 0), await authorization(TWICE, 1)] }), await gas({ from: sender, authorizationList: [await authorization(SENDER, 1)] }), await gas({ from: sender, authorizationList: [await authorization(SENDER, 1), await authorization(SENDER, 2)] })],
    [15_000n + 2n * 7_816n + 9_000n + 143n * 1_530n, 15_000n + 7_816n + 23n * 1_530n, 15_000n + 2n * 7_816n + 23n * 1_530n]);
  // What a cleared slot gives back, across calls (no reservoir: the gas limit is under the cap). A contract sets
  // its slot 7 in one call and clears it in the next, as a token's allowance is approved and then spent. The gas
  // the slot's state cost comes back to the caller that paid for it, when the clearing call returns: the caller can
  // then grow its memory by 92,160 gas on a limit that holds it only so. The call that clears can't spend it on
  // that itself (it runs out of gas, and the caller reads 0), but can on new state (another slot). The gas figures
  // are Sepolia's node's for the same code (scripts/rules-check.ts); by the EVM library's rule the first ran out.
  const KEEPER = '0x00000000000000000000000000000000c0de7705', KEEPER2 = '0x00000000000000000000000000000000c0de7706', PROGRAM = '0x00000000000000000000000000000000c0de7707';
  const KEEPER3 = '0x00000000000000000000000000000000c0de7708';
  const keepers = { [KEEPER]: { code: '0x60003560075560203515601457600162030000525b00' }, [KEEPER2]: { code: '0x6000356007556020351560125760016008555b00' }, [KEEPER3]: { code: '0x6000356007556020351560125760006000fd5b00' } };
  const across = async (code: string, limit: bigint) => { const r = await run({ to: PROGRAM, gas: limit, stateOverrides: { ...keepers, [PROGRAM]: { code } } }); return [r.status, r.gasUsed, r.status === 'success' ? BigInt(r.returnData!) : undefined]; };
  assert.deepEqual(await across('0x602a600052600060006020600060007300000000000000000000000000000000c0de77055af1506000600052600060006020600060007300000000000000000000000000000000c0de77055af15060016203000052600060005260206000f3', 170_000n), ['success', 112_637n, 0n]);
  assert.deepEqual(await across('0x602a600052600060006040600060007300000000000000000000000000000000c0de77055af15060006000526001602052600060006040600060007300000000000000000000000000000000c0de77055af160005260206000f3', 170_000n), ['success', 169_360n, 0n]);
  assert.deepEqual(await across('0x602a600052600060006040600060007300000000000000000000000000000000c0de77065af15060006000526001602052600060006040600060007300000000000000000000000000000000c0de77065af160005260206000f3', 150_000n), ['success', 130_477n, 1n]);
  // A call that clears the slot and then reverts gives nothing back (the slot is as it was): the caller, growing
  // its memory on the same limit, runs out of gas, as on Sepolia's node.
  assert.deepEqual(await across('0x602a600052600060006040600060007300000000000000000000000000000000c0de77085af15060006000526001602052600060006040600060007300000000000000000000000000000000c0de77085af15060016203000052600060005260206000f3', 170_000n), ['reverted', 170_000n, undefined]);
  // A call that fails changes nothing itself, but its transaction's authorizations stay applied on the chain: a
  // trace shows them (the authority's nonce and its new code).
  const KEPT = `0x${'f3'.repeat(32)}` as Hex, REVERTS = '0x00000000000000000000000000000000c0de0003';
  const [failed] = (await new ForkSimulator({ 11155111: URL_ }, { fetchImpl: chain.fetchImpl }).trace([{ chainId: 11155111, from: FROM, to: REVERTS, data: '0x', value: 0n, at: { block: '0x10', header: amsterdam },
    stateOverrides: { [REVERTS]: { code: '0x60006000fd' } }, authorizationList: [await authorization(KEPT, 0)] }]))!;
  assert.deepEqual([failed.status, failed.stateChanges], ['reverted', [{ address: privateKeyToAccount(KEPT).address.toLowerCase(), nonce: { before: 0n, after: 1n }, code: true }]]);
  // Gas over the cap on ordinary gas (16,777,216) pays for new state only: a call given 20 million has the cap, less
  // what the transaction pays first, to run on; a new account's state comes out of the rest, and is counted.
  await chain.putCode('0x00000000000000000000000000000000000c0de8', '0x5a60005260206000f3');
  assert.equal(BigInt((await run({ to: '0x00000000000000000000000000000000000c0de8', gas: 20_000_000n })).returnData!), 16_777_216n - 15_000n - 2n);
  assert.equal(await gas({ to: '0x00000000000000000000000000000000beef0789', value: 1n, gas: 20_000_000n }), 204_600n);
  // A gas limit leaves the call what Amsterdam leaves it: the limit less 15,000 here, not less 21,000.
  const GASLEFT = '0x00000000000000000000000000000000000c0de6';
  await chain.putCode(GASLEFT, '0x5a60005260206000f3');
  assert.equal(BigInt((await run({ to: GASLEFT, gas: 100_000n })).returnData!), 100_000n - 15_000n - 2n);
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
