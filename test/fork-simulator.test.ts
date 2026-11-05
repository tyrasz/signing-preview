// ForkSimulator end to end: a local EVM over state fetched from a chain (test/evm-chain.ts, a HyperEVM-shaped node
// without eth_simulateV1), run against real contracts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, serializeSignature, toHex, type Hex } from 'viem';
import { privateKeyToAccount, sign } from 'viem/accounts';
import { previewRequest } from '../src/preview.ts';
import { PERMIT2, StaticTokenRegistry } from '../src/chains.ts';
import { RpcSimulator } from '../src/simulation.ts';
import { CHAIN_PROFILES, ForkSimulator, ForkTimeout } from '../src/fork-simulator.ts';
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
