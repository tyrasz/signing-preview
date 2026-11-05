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
import type { Dependencies, Preview } from '../src/types.ts';
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
  // With no speculative rounds allowed, values are fetched one at a time: slower, same answer.
  const [slow] = (await fork({ maxRounds: 0 }).simulateBatch([{ chainId: 999, from: USER, to: usdc, data: call('transfer', [BOB, 1n]), value: 0n }]))!;
  assert.deepEqual(slow.transfers.map(t => [t.asset, t.raw]), [[usdc, 1n]]);
  await assert.rejects(fork({ timeoutMs: 1 }).simulate(req), ForkTimeout);
  // A slow chain: past the budget, RpcSimulator answers with the probe.
  chain.delayMs = 120;
  try {
    const sim = new RpcSimulator({ 999: URL_ }, { fetchImpl: chain.fetchImpl, fork: fork({ timeoutMs: 5000 }), forkBudgetMs: 150 });
    const p = await sim.simulate({ chainId: 999, from: USER, to: usdc, data: call('transfer', [BOB, 2n]), value: 0n });
    assert.equal(p?.basis, 'state');
    assert.match(p!.source, /state-override probe/);
  } finally {
    chain.delayMs = 0;
  }
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
