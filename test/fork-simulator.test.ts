// ForkSimulator end to end: a local EVM over state fetched from a chain (test/evm-chain.ts, a HyperEVM-shaped node
// without eth_simulateV1), run against real contracts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, getContractAddress, keccak256, parseAbi, serializeSignature, toHex, type Hex } from 'viem';
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

test('What a simulation sets in storage is not read over by the slots the node says a call touches', async () => {
  // A contract that returns its slot 0, which holds 0 on the chain; the simulation sets it to 7, and the node's
  // access list (eth_createAccessList, read to prefetch) names it. A Sepolia replay's earlier transactions, from the
  // block's access list, are set the same way: six started from the parent block's value instead (2026-11-12).
  const reader = '0x5100000000000000000000000000000000000051', SLOT0 = `0x${'00'.repeat(32)}`;
  await chain.putCode(reader, '0x60005460005260206000f3');
  const listing = (async (u: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)), reqs = (Array.isArray(body) ? body : [body]) as { id: number; method: string }[];
    if (!reqs.some(r => r.method === 'eth_createAccessList')) return chain.fetchImpl(u, init);
    const out = await Promise.all(reqs.map(async r => r.method === 'eth_createAccessList'
      ? { jsonrpc: '2.0', id: r.id, result: { accessList: [{ address: reader, storageKeys: [SLOT0] }], gasUsed: '0x0' } }
      : (await chain.fetchImpl(u, { ...init, body: JSON.stringify(r) })).json()));
    return new Response(JSON.stringify(Array.isArray(body) ? out : out[0]));
  }) as typeof fetch;
  // (As Ethereum: HyperEVM's RPC has no eth_createAccessList, so nothing is prefetched there.)
  const ethereum = new ForkSimulator({ 1: URL_ }, { fetchImpl: listing });
  const [r] = (await ethereum.simulateBatch([{ chainId: 1, from: USER, to: reader, data: '0x', value: 0n, stateOverrides: { [reader]: { stateDiff: { [SLOT0]: `0x${'00'.repeat(31)}07` } } } }]))!;
  assert.equal(BigInt(r.returnData!), 7n);
});

test('Failures: revert reasons, insufficient funds; a chain precompile is answered by the chain', async () => {
  const fail = await send(reverter, call('fail'));
  assert.deepEqual([fail.simulation?.status, fail.simulation?.revertReason], ['reverted', 'nope']);
  const broke = await send(BOB, '0x', 100n * E);
  assert.equal(broke.simulation?.revertReason, 'insufficient funds: the account holds 10 HYPE and the call sends 100 HYPE');
  // A transaction the account can't pay for is refused, not mined: it was "expected to fail. You would still pay
  // the network fee".
  assert.equal(broke.warnings.find(w => w.code === 'simulation_reverted')?.message, 'The network would refuse this transaction as it stands: insufficient funds: the account holds 10 HYPE and the call sends 100 HYPE. It would not be mined.');
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
  // A token only a later call shows, past the speculative rounds, is read like the rest too: a contract that sends
  // the user 101 stUSD (its event's figure; the balance moves by 100), named by neither call.
  const giver = '0x91fe000000000000000000000000000000000091';
  // CODECOPY the calldata after the code, CALL the token with it, STOP.
  await chain.putCode(giver, `0x6044602a6000396000600060446000600073${shares.slice(2)}5af15000${call('transfer', [USER, 101n]).slice(2)}` as Hex);
  await chain.exec(shares, call('mintShares', [giver, 300n]));
  const [, given] = (await fork({ maxRounds: 0 }).simulateBatch([{ chainId: 999, from: USER, to: BOB, data: '0x', value: 0n }, { chainId: 999, from: USER, to: giver, data: '0x', value: 0n }]))!;
  assert.deepEqual(given.transfers.map(t => [t.asset, t.to, t.raw]), [[shares, USER, 100n]]);
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
  // Signed so the chain won't apply it: s over half the group order (n - s, the same signature otherwise), or a parity
  // of 27. Every node skips it (on Ethereum, 2026-11-16: no code, 49,127 gas); it was applied here (81,362).
  const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const good = await signed(KEY, 1);
  for (const bad of [{ ...good, s: toHex(N - BigInt(good.s), { size: 32 }), yParity: toHex(1 - Number(good.yParity)) }, { ...good, yParity: toHex(27 + Number(good.yParity)) }]) {
    const [skipped] = (await sim.simulateBatch([{ ...base, authorizationList: [bad], stateOverrides: { [USER]: { code: '0x' } } }]))!;
    assert.deepEqual(skipped.transfers, []);
    assert.equal(skipped.gasUsed, 21_000n + 25_000n + calldataGas(execute));
  }
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
  // A sender that can't pay for the gas at its price fails without running, as every node refuses it ("insufficient
  // funds for gas * price + value"; it used to run here, at its whole balance).
  const unpaid = (await fork().simulate({ ...req, gas: 100_000n, gasPrice: whole }))!;
  assert.deepEqual([unpaid.status, unpaid.gasUsed], ['reverted', undefined]);
  assert.match(unpaid.revertReason ?? '', /^insufficient funds: the account holds .*, and the gas limit at its price and what the call sends come to/);
});

test('A priced call’s fee goes where the chain pays it: the tip to the fee recipient, OP Stack’s base fee to its BaseFeeVault, Arbitrum’s to its fee accounts', async () => {
  // Measured on each node (2026-11-16): OP Mainnet's BaseFeeVault gained a priced call's gas at the base fee, which
  // the local EVM burnt; Arbitrum One paid its infrastructure account the gas at ArbOS's minimum price (here none is
  // read: the base fee), its network account the rest of the price, tip included, and COINBASE nothing.
  const AT = '0x00000000000000000000000000000000c0de0005', TIPPED = '0x00000000000000000000000000000000000c01b5';
  const VAULT = '0x4200000000000000000000000000000000000019', INFRA = '0xbf5041fc07e1c866d15c749156657b8eed0fb649', NETWORK = '0x32e7af5a8151934f3787d0cd59eb6edd0a736b1d';
  const watched = [TIPPED, VAULT, INFRA, NETWORK];
  // The code returns the balance of each watched account: PUSH20 it, BALANCE, MSTORE at its word.
  const code = `0x${watched.map((a, i) => `73${a.slice(2)}3160${(i * 32).toString(16).padStart(2, '0')}52`).join('')}60${(watched.length * 32).toString(16)}6000f3` as Hex;
  const header = { number: 100n, timestamp: 1_800_000_000n, coinbase: TIPPED, prevRandao: `0x${'00'.repeat(32)}` as Hex, gasLimit: 30_000_000n, baseFeePerGas: 10_000_000n };
  const read = async (chain: number, price?: bigint) => {
    const sim = fork({ profiles: { 999: { ...CHAIN_PROFILES[chain] } } });
    const out = (await sim.simulateBatch([{ chainId: 999, from: USER, to: BOB, data: '0x', value: 0n, ...(price && { gas: 100_000n, gasPrice: price }), at: { block: 'latest', header } },
      { chainId: 999, from: USER, to: AT, data: '0x', value: 0n, stateOverrides: { [AT]: { code } }, at: { block: 'latest', header } }]))!;
    return out[1].returnData!.slice(2).match(/.{64}/g)!.map(w => BigInt(`0x${w}`));
  };
  const paid = async (chain: number) => { const [a, b] = [await read(chain), await read(chain, 15_000_000n)]; return b.map((v, i) => v - a[i]); };
  // Ethereum: the tip to COINBASE, the base fee burnt.
  assert.deepEqual(await paid(1), [21_000n * 5_000_000n, 0n, 0n, 0n]);
  // OP Mainnet: the base fee to its BaseFeeVault too.
  assert.deepEqual(await paid(10), [21_000n * 5_000_000n, 21_000n * 10_000_000n, 0n, 0n]);
  // Arbitrum One: nothing to COINBASE; the gas at the minimum price to the infrastructure account, the rest to the network's.
  assert.deepEqual(await paid(42161), [0n, 0n, 21_000n * 10_000_000n, 21_000n * 5_000_000n]);
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

test('A precompile a fork adds, from its time on: BNB Chain’s MILLI_TIMESTAMP', async () => {
  const milli = CHAIN_PROFILES[56].timedPrecompiles![0];
  assert.deepEqual([milli.name, milli.address, milli.from, milli.gas], ['MILLI_TIMESTAMP', '0x0000000000000000000000000000000000000070', 1_796_697_000n, 20n]);
  const sim = fork({ profiles: { 999: { ...profiles[999], timedPrecompiles: [milli] } } });
  const header = (timestamp: bigint, milliseconds?: bigint) => ({ number: 100n, timestamp, coinbase: BOB, prevRandao: `0x${'00'.repeat(32)}` as Hex, gasLimit: 30_000_000n, baseFeePerGas: 0n, ...(milliseconds !== undefined && { milliseconds }) });
  const call = (timestamp: bigint, milliseconds?: bigint, gas?: bigint) => sim.simulate({ chainId: 999, from: USER, to: milli.address, data: '0x', value: 0n, ...(gas && { gas }), at: { block: 'latest', header: header(timestamp, milliseconds) } });
  const [at, later, before, short] = await Promise.all([call(1_796_697_000n, 550n), call(1_796_697_001n), call(1_796_696_999n), call(1_796_697_000n, 0n, 21_019n)]);
  // The block's time in milliseconds (its seconds, and the milliseconds its mixHash carries), for 20 gas.
  assert.deepEqual([at!.status, BigInt(at!.returnData!), at!.gasUsed], ['success', 1_796_697_000_550n, 21_020n]);
  assert.equal(BigInt(later!.returnData!), 1_796_697_001_000n);
  // Before the fork, an empty account; given less than its price, out of gas.
  assert.deepEqual([before!.status, before!.returnData ?? '0x', before!.gasUsed], ['success', '0x', 21_000n]);
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
  // Its balance read (the reads warmed up first run its marker code, which burns all it is given: not what the
  // run's own reads, from the reference, then answer).
  assert.deepEqual(sent.readAssets, ['native', TOKEN]);
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
  // And one of its functions given calldata it can't decode: the selector too, where the reference reverts empty.
  assert.deepEqual([(await call('0xa9059cbb'))!.returnData, (await call(`0x70a08231${'ff'.repeat(32)}`))!.returnData], ['0xa9059cbb', '0x70a08231']);
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
    // Unless what it read is a balance, an allowance, a nonce or the total supply, and what changed it a transfer or an
    // approval: those are read after the earlier calls through the token's own views, which the node runs. Here an
    // earlier approval (its event) let Bob spend 500 of the user's, which the parent block's storage doesn't have.
    const approving = (async (u: string, init: RequestInit) => {
      const res = await chain.fetchImpl(u, init), body = JSON.parse(String(init.body));
      if (!Array.isArray(body) || body[0]?.method !== 'eth_simulateV1') return res;
      const out = await res.json() as { result?: { calls: { status: string; returnData: string; logs: unknown[] }[] }[] }[];
      out[0].result?.[0]?.calls[0]?.logs.push({ address: TOKEN, topics: ['0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925'], data: '0x' });
      (body[0].params[0].blockStateCalls as { calls: { to: string; data: string }[] }[]).forEach((b, i) => b.calls.forEach((c, j) => {
        if (c.to !== TOKEN) return;
        // (The token's views, as Base's node answers them: the allowance the approval set, and the balances, which it left.)
        const answer = c.data.startsWith('0x70a08231') ? (c.data.endsWith(USER.slice(2)) ? 1_000_000 : 0) : c.data.startsWith('0xdd62ed3e') ? 500 : undefined;
        if (answer === undefined) return;
        if (c.data.startsWith('0xdd62ed3e')) assert.equal(c.data, `0xdd62ed3e${USER.slice(2).padStart(64, '0')}${BOB.slice(2).padStart(64, '0')}`);
        out[0].result![i].calls[j] = { status: '0x1', returnData: `0x${answer.toString(16).padStart(64, '0')}`, logs: [] };
      }));
      return new Response(JSON.stringify(out));
    }) as typeof fetch;
    const transferFrom = encodeFunctionData({ abi: parseAbi(['function transferFrom(address,address,uint256) returns (bool)']), functionName: 'transferFrom', args: [USER as `0x${string}`, BOB as `0x${string}`, 100n] });
    const spend: SimulationRequest = { chainId: 8453, from: BOB, to: TOKEN, data: transferFrom, value: 0n };
    const [spent] = (await new ForkSimulator({ 8453: URL_ }, { fetchImpl: approving, profiles: { 8453: CHAIN_PROFILES[8453] } }).trace([{ ...spend, at: { block: '0x10', header, before: [earlier] } }]))!;
    assert.deepEqual([spent.status, spent.standInsStale], ['success', undefined]);
    // A view that didn't answer leaves its slot read as of the block before: stale, whatever the token's events.
    const silent = (async (u: string, init: RequestInit) => {
      const res = await chain.fetchImpl(u, init), body = JSON.parse(String(init.body));
      if (!Array.isArray(body) || body[0]?.method !== 'eth_simulateV1') return res;
      const out = await res.json() as { result?: { calls: { logs: unknown[] }[] }[] }[];
      out[0].result?.[0]?.calls[0]?.logs.push({ address: TOKEN, topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'], data: '0x' });
      return new Response(JSON.stringify(out));
    }) as typeof fetch;
    const [unviewed] = (await new ForkSimulator({ 8453: URL_ }, { fetchImpl: silent, profiles: { 8453: CHAIN_PROFILES[8453] } }).trace([{ ...target, at: { block: '0x10', header, before: [earlier] } }]))!;
    assert.deepEqual(unviewed.standInsStale, [TOKEN]);
    // (Without it, the parent block's allowance: none, InsufficientAllowance.)
    const [refused] = (await new ForkSimulator({ 8453: URL_ }, { fetchImpl: touching, profiles: { 8453: CHAIN_PROFILES[8453] } }).trace([{ ...spend, at: { block: '0x10', header, before: [earlier] } }]))!;
    assert.deepEqual([refused.status, refused.returnData?.slice(0, 10)], ['reverted', '0x192b9e4e']);
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
  // nothing: 6 a word of its input (three; a registry, like the factory, isn't charged a token's 100 besides,
  // measured on Base with the call timed from a contract), and the transaction's own.
  const isAuthorized = encodeFunctionData({ abi: parseAbi(['function isAuthorized(uint64,address) view returns (bool)']), functionName: 'isAuthorized', args: [0n, BOB] });
  // (The call's own gas, in its trace: the transaction's is the calldata floor's, EIP-7623, so little does it use.)
  const [asked] = (await base.trace([{ chainId: 8453, from: USER, to: '0x8453000000000000000000000000000000000002', data: isAuthorized, value: 0n, at: { block: 'latest', header } }]))!;
  assert.deepEqual([asked.status, asked.trace!.gasUsed, BigInt(asked.returnData!)], ['success', 18n, 1n]);
  // Run as another contract's code (DELEGATECALL), the chain's token refuses: DelegateCallNotAllowed().
  const DELEGATOR = '0x00000000000000000000000000000000000de1e9';
  await chain.putCode(DELEGATOR, `0x365f5f375f5f365f73${TOKEN.slice(2)}5af43d5f5f3e6029573d5ffd5b3d5ff3`);
  const delegated = (await base.simulate({ chainId: 8453, from: USER, to: DELEGATOR, data: encodeFunctionData({ abi: erc20, functionName: 'decimals' }), value: 0n, at: { block: 'latest', header } }))!;
  assert.deepEqual([delegated.status, delegated.returnData], ['reverted', '0x0d89438e']);
  // So do the registries.
  await chain.putCode(DELEGATOR, `0x365f5f375f5f365f738453000000000000000000000000000000000000000002${'5af43d5f5f3e6029573d5ffd5b3d5ff3'}`);
  const toRegistry = (await base.simulate({ chainId: 8453, from: USER, to: DELEGATOR, data: isAuthorized, value: 0n, at: { block: 'latest', header } }))!;
  assert.deepEqual([toRegistry.status, toRegistry.returnData], ['reverted', '0x0d89438e']);
  // Sent value, a token or registry refuses it whatever the function, NonPayable(), and is charged nothing for the
  // call (the reference's view function would have reverted empty).
  for (const to of [TOKEN, '0x8453000000000000000000000000000000000002']) {
    const [paid] = (await base.trace([{ chainId: 8453, from: USER, to, data: encodeFunctionData({ abi: erc20, functionName: 'decimals' }), value: 1n, at: { block: 'latest', header } }]))!;
    assert.deepEqual([paid.status, paid.returnData, paid.trace!.gasUsed], ['reverted', '0x6fb1b0e9', 0n]);
  }
  // The account keeps the chain's code, the marker: EXTCODESIZE 1, EXTCODECOPY 0xef, as on Base's node.
  const READER = '0x00000000000000000000000000000000000c0de5';
  await chain.putCode(READER, `0x73${TOKEN.slice(2)}3b6000526020600060207${'3'}${TOKEN.slice(2)}3c60406000f3`);
  const read = (await base.simulate({ chainId: 8453, from: USER, to: READER, data: '0x', value: 0n, at: { block: 'latest', header } }))!;
  assert.deepEqual([read.status, BigInt(read.returnData!.slice(0, 66)), read.returnData!.slice(66, 68)], ['success', 1n, 'ef']);
  // An account delegated (EIP-7702) to a token runs that marker as code, as the node does: an undefined opcode, all
  // its gas. (The node finds a token's precompile by the address called, not by a delegate's.)
  const DELEGATED = '0x00000000000000000000000000000000000de1e8';
  await chain.putCode(DELEGATED, `0xef0100${TOKEN.slice(2)}`);
  const halted = (await base.simulate({ chainId: 8453, from: USER, to: DELEGATED, data: encodeFunctionData({ abi: erc20, functionName: 'decimals' }), value: 0n, gas: 100_000n, at: { block: 'latest', header } }))!;
  assert.deepEqual([halted.status, halted.gasUsed], ['reverted', 100_000n]);
  // Its EIP-712 hashing is charged as the node charges it: DOMAIN_SEPARATOR() is 100 and 6 a word of input, the
  // name's cold read (2,100), and the hashes of the name (10 bytes: 36), the version (36) and the domain (60).
  const [separator] = (await base.trace([{ chainId: 8453, from: USER, to: TOKEN, data: '0x3644e515', value: 0n, at: { block: 'latest', header } }]))!;
  assert.deepEqual([separator.status, separator.trace!.gasUsed], ['success', 106n + 2_100n + 36n + 36n + 60n]);
  // Base's factory (no code on the chain, listed as a precompile) runs its reference too: a token it creates is
  // written where the chain's factory writes it, with the marker for code, and answers as the chain's would.
  const FACTORY = '0xb20f000000000000000000000000000000000000', ACTIVATION = '0x8453000000000000000000000000000000000001';
  const assetFeature = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], ['0xcdcc772fe4cbdb1029f822861176d09e646db96723d4c1e82ddfdeb8163ef54c', 0x43ee1bbe25e988521cccd8b2c8fbd38c8287ebff8e074e825a70dfd3885cce00n]));
  await chain.evm.stateManager.putStorage(createAddressFromString(ACTIVATION), hexToBytes(assetFeature), word(1n));
  const factory = parseAbi(['function createB20(uint8 variant, bytes32 salt, bytes params, bytes[] initCalls) payable returns (address)']);
  const params = encodeAbiParameters([{ type: 'tuple', components: [{ type: 'uint8' }, { type: 'string' }, { type: 'string' }, { type: 'address' }, { type: 'uint8' }] }], [[1, 'New Token', 'NEW', '0x0000000000000000000000000000000000000000', 18]]);
  const salt = `0x${'11'.repeat(32)}` as Hex;
  const mint = encodeFunctionData({ abi: parseAbi(['function mint(address,uint256)']), functionName: 'mint', args: [USER as Hex, 1_000n] });
  const create: SimulationRequest = { chainId: 8453, from: USER, to: FACTORY, data: encodeFunctionData({ abi: factory, functionName: 'createB20', args: [0, salt, params, [mint]] }), value: 0n, at: { block: 'latest', header } };
  const NEW = `0xb2${'00'.repeat(10)}${keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [USER as Hex, salt])).slice(2, 20)}`;
  const [made] = (await base.trace([create]))!;
  assert.deepEqual([made.status, made.returnData?.slice(26)], ['success', NEW.slice(2)]);
  // B20Created from the factory, then the mint's Transfer from the token: one call in the trace, both its events.
  assert.deepEqual(made.logs!.map(l => [l.address, l.topics[0].slice(0, 10)]), [[FACTORY, '0xfd9bf273'], [NEW, '0xddf252ad']]);
  assert.deepEqual([made.trace!.calls ?? [], made.trace!.logs?.length], [[], 2]);
  // (The factory, the activation registry it asks, the token, and the policy registry the mint asks.)
  assert.deepEqual(made.standIns, [FACTORY, '0x8453000000000000000000000000000000000001', NEW, '0x8453000000000000000000000000000000000002']);
  // Read back after it in the same batch: its symbol and the minted balance; and made again, refused (TokenAlreadyExists).
  const readNew = parseAbi(['function symbol() view returns (string)', 'function balanceOf(address) view returns (uint256)']);
  const [, symbol, held, again] = (await base.simulateBatch([create, { ...create, to: NEW, data: encodeFunctionData({ abi: readNew, functionName: 'symbol' }) }, { ...create, to: NEW, data: encodeFunctionData({ abi: readNew, functionName: 'balanceOf', args: [USER as Hex] }) }, create]))!;
  assert.deepEqual([decodeFunctionResult({ abi: readNew, functionName: 'symbol', data: symbol.returnData! as Hex }), BigInt(held.returnData!)], ['NEW', 1_000n]);
  assert.deepEqual([again.status, again.returnData?.slice(0, 10)], ['reverted', '0x15ef3a57']);
  // In the bootstrap window an init call skips its role's check, as the mint above did, but for burn, burnWithMemo
  // and seizeWithMemo, which check it as the chain's do: such a creation fails AccessControlUnauthorizedAccount of
  // the factory and BURN_ROLE or SEIZE_ROLE (measured on Base's node), after the pause check and before the
  // function's own checks (a burn with no balance, a seize to the zero address: refused for the role too), the
  // role's flag read (2,100 cold); granted the role by an earlier init call, the burn goes through, or fails for its
  // own reasons (more than the balance: InsufficientBalance). burnBlocked keeps the window's bypass, as on the chain:
  // it fails for the account, which no policy blocks (AccountNotBlocked).
  const token = parseAbi(['function burn(uint256)', 'function burnWithMemo(uint256,bytes32)', 'function seizeWithMemo(address,address,uint256,bytes32)', 'function burnBlocked(address,uint256)', 'function grantRole(bytes32,address)', 'function pause(uint8[])']);
  const tokenCall = (functionName: string, args: unknown[]) => encodeFunctionData({ abi: token, functionName: functionName as never, args: args as never });
  const mintTo = (to: string) => encodeFunctionData({ abi: parseAbi(['function mint(address,uint256)']), functionName: 'mint', args: [to as Hex, 5n] });
  // (Each its own salt: a trace's requests run one after another, and a token made can't be made again.)
  let salts = 0;
  const creating = (inits: Hex[]): SimulationRequest => ({ ...create, data: encodeFunctionData({ abi: factory, functionName: 'createB20', args: [0, `0x${(++salts).toString(16).padStart(64, '2')}`, params, inits] }) });
  const refused = (role: string) => `0xe2517d3f${FACTORY.slice(2).padStart(64, '0')}${keccak256(toHex(role)).slice(2)}`;
  const memo = `0x${'4d'.repeat(32)}` as Hex;
  const [burnt, burntWithMemo, seized, unfunded, paused, burnGranted, blocked, burntRead, seizedToNobody, overBurnt] = (await base.trace([
    creating([mintTo(FACTORY), tokenCall('burn', [1n])]),
    creating([mintTo(FACTORY), tokenCall('burnWithMemo', [1n, memo])]),
    creating([mintTo(BOB), tokenCall('seizeWithMemo', [BOB, USER, 1n, memo])]),
    creating([tokenCall('burn', [1n])]),
    creating([tokenCall('pause', [[2]]), tokenCall('burn', [1n])]),
    creating([mintTo(FACTORY), tokenCall('grantRole', [keccak256(toHex('BURN_ROLE')), FACTORY]), tokenCall('burn', [1n])]),
    creating([mintTo(BOB), tokenCall('burnBlocked', [BOB, 1n])]),
    creating([mintTo(FACTORY)]),
    creating([tokenCall('seizeWithMemo', [BOB, '0x0000000000000000000000000000000000000000', 1n, memo])]),
    creating([mintTo(FACTORY), tokenCall('grantRole', [keccak256(toHex('BURN_ROLE')), FACTORY]), tokenCall('burn', [6n])]),
  ]))!;
  assert.deepEqual([burnt, burntWithMemo, unfunded].map(r => [r.status, r.returnData]), Array(3).fill(['reverted', refused('BURN_ROLE')]));
  assert.deepEqual([seized, seizedToNobody].map(r => [r.status, r.returnData]), Array(2).fill(['reverted', refused('SEIZE_ROLE')]));
  assert.deepEqual([paused.status, paused.returnData], ['reverted', `0xfd8c4245${'2'.padStart(64, '0')}`]);
  assert.deepEqual([burnGranted.status, blocked.status, blocked.returnData?.slice(0, 10)], ['success', 'reverted', '0x64a5cb46']);
  assert.deepEqual([overBurnt.status, overBurnt.returnData?.slice(0, 10)], ['reverted', '0xdb42144d']);
  // Refused, the burn is charged its init call (124) and the role's cold read (2,100) over the mint's creation alone,
  // nothing of its balance; burnWithMemo 6 more, its memo's word.
  assert.deepEqual([burnt.trace!.gasUsed - burntRead.trace!.gasUsed, burntWithMemo.trace!.gasUsed - burnt.trace!.gasUsed], [2_224n, 6n]);
  // A transaction sent from the factory's own address, which only a simulation can send, is any caller's, as on
  // Base's node, whose factory is native code: the token's bootstrap window is open to the factory only as it
  // creates the token (above, its init call's mint). A mint is refused for the role (AccessControlUnauthorizedAccount
  // of the factory's address and MINT_ROLE), the reference's own grantInitialAdmin with its selector, as a function
  // the token hasn't, and a store at the cheatcodes' address, an empty account, does nothing.
  const asFactory = (to: string, data: Hex): SimulationRequest => ({ chainId: 8453, from: FACTORY, to, data, value: 0n, at: { block: 'latest', header } });
  const mintRole = keccak256(toHex('MINT_ROLE'));
  const minted = (await base.simulate(asFactory(TOKEN, encodeFunctionData({ abi: parseAbi(['function mint(address,uint256)']), functionName: 'mint', args: [BOB, 1n] }))))!;
  assert.deepEqual([minted.status, minted.returnData, minted.logs ?? []], ['reverted', `0xe2517d3f${FACTORY.slice(2).padStart(64, '0')}${mintRole.slice(2)}`, []]);
  const granted = (await base.simulate(asFactory(TOKEN, encodeFunctionData({ abi: parseAbi(['function grantInitialAdmin(address)']), functionName: 'grantInitialAdmin', args: [BOB] }))))!;
  assert.deepEqual([granted.status, granted.returnData], ['reverted', '0x62a80d42']);
  const store = encodeFunctionData({ abi: parseAbi(['function store(address,bytes32,bytes32)']), functionName: 'store', args: [TOKEN, balanceSlot(BOB) as Hex, toHex(10n ** 30n, { size: 32 })] });
  const [stored, bobs] = (await base.simulateBatch([asFactory('0x7109709ecfa91a80626ff3989d68f67f5b1dd12d', store), { ...asFactory(TOKEN, encodeFunctionData({ abi: readNew, functionName: 'balanceOf', args: [BOB] })), from: USER }]))!;
  assert.deepEqual([stored.status, stored.returnData ?? '0x', BigInt(bobs.returnData!)], ['success', '0x', 0n]);
  // And a precompile moved onto a registry's address runs there for it as for anyone (it is a registry only to a
  // token's or the factory's reference that asks it, whose read of the registry's storage the node makes itself).
  const recover = `0x${'11'.repeat(32)}${'00'.repeat(31)}1b${'22'.repeat(32)}${'33'.repeat(32)}` as Hex;
  const moved = { '0x0000000000000000000000000000000000000001': { movePrecompileToAddress: '0x8453000000000000000000000000000000000002' } };
  const [fromFactory, fromUser] = await Promise.all([FACTORY, USER].map(async from => (await base.simulate({ ...asFactory('0x8453000000000000000000000000000000000002', recover), from, stateOverrides: moved }))!));
  assert.deepEqual([fromFactory.status, fromFactory.returnData, fromFactory.gasUsed], ['success', fromUser.returnData, fromUser.gasUsed]);
  assert.equal(fromFactory.returnData?.length, 66);
  // An address of the token kind with no token yet reverts with nothing, as on the chain.
  const unborn = (await base.simulate({ chainId: 8453, from: USER, to: '0xb200000000000000000000fedcba9876543210ff', data: encodeFunctionData({ abi: erc20, functionName: 'decimals' }), value: 0n, at: { block: 'latest', header } }))!;
  assert.deepEqual([unborn.status, unborn.returnData ?? '0x'], ['reverted', '0x']);
  // Not at a block from before that upgrade, when Base ran its tokens by other rules: refused, as before.
  await assert.rejects(base.simulate({ chainId: 8453, from: USER, to: TOKEN, data: encodeFunctionData({ abi: erc20, functionName: 'decimals' }), value: 0n, at: { block: 'latest', header: { ...header, timestamp: 1_793_901_599n } } }),
    (e: unknown) => e instanceof ForkUnsupported && /from Base's upgrade of 2026-11-05 on/.test(e.message));
  // Only on Base, only the variants and contracts it has references for.
  assert.ok(nativeStandIn(8453, TOKEN, new Uint8Array([0xef])));
  assert.ok(nativeStandIn(8453, '0xb200000000000000000001123456789abcdef012', new Uint8Array([0xef])));
  assert.equal(nativeStandIn(8453, '0xb200000000000000000002123456789abcdef012', new Uint8Array([0xef])), undefined);
  assert.equal(nativeStandIn(10, TOKEN, new Uint8Array([0xef])), undefined);
  // By address, as Base's node chooses: a token wherever there is code (an override's too, which the node ignores),
  // none where there is none; the factory and registries whatever code there is.
  assert.ok(nativeStandIn(8453, TOKEN, new Uint8Array([0x60, 0x00])));
  assert.equal(nativeStandIn(8453, TOKEN, new Uint8Array(0)), undefined);
  assert.ok(nativeStandIn(8453, '0xb20f000000000000000000000000000000000000', new Uint8Array(0)));
  assert.ok(nativeStandIn(8453, '0x8453000000000000000000000000000000000002', new Uint8Array([0x60, 0x00])));
});

test('Base’s policy registry: a write reads the activation registry’s flag first and writes its slots whole, as the node does', async () => {
  const POLICY = '0x8453000000000000000000000000000000000002', ACTIVATION = '0x8453000000000000000000000000000000000001';
  const POLICY_AT = 0x00503aeb06982fa1fe3151dc68f90b3946c55c449dfd447e49dcaece71ba4a00n, ACTIVATION_AT = 0x43ee1bbe25e988521cccd8b2c8fbd38c8287ebff8e074e825a70dfd3885cce00n;
  const feature = keccak256(toHex('base.policy_registry'));
  const flag = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [feature, ACTIVATION_AT]));
  const policySlot = (id: bigint) => keccak256(encodeAbiParameters([{ type: 'uint64' }, { type: 'uint256' }], [id, POLICY_AT]));
  const put = (a: string, slot: Hex, value: bigint) => chain.evm.stateManager.putStorage(createAddressFromString(a), hexToBytes(slot), setLengthLeft(hexToBytes(toHex(value)), 32));
  for (const r of [ACTIVATION, POLICY]) await chain.putCode(r, '0xef');
  // A caller that forwards the rest of its calldata to the registry on the gas its first word says, and returns
  // whether the call succeeded (a transaction's gas hides a cheap call's under the calldata floor).
  const CALLER = '0x00000000000000000000000000000000ca11e700';
  await chain.putCode(CALLER, `0x6020360380602060003760006000826000600073${POLICY.slice(2)}600035f160005260206000f3`);
  // The registry past its built-in policies (Base's counter is past 100), switched on; a policy the caller administers.
  const ALLOWLIST = (1n << 56n) | 0x1000001n;
  await put(POLICY, toHex(POLICY_AT + 3n, { size: 32 }), 139n);
  await put(POLICY, policySlot(ALLOWLIST), (1n << 255n) | BigInt(CALLER));
  await put(ACTIVATION, flag, 1n);
  const base = new ForkSimulator({ 8453: URL_ }, { fetchImpl: chain.fetchImpl, profiles: { 8453: CHAIN_PROFILES[8453] } });
  const header = { number: 17n, timestamp: 1_800_000_000n, coinbase: '0x0000000000000000000000000000000000000000', gasLimit: 30_000_000n, baseFeePerGas: 0n, prevRandao: `0x${'00'.repeat(32)}` as Hex };
  const registry = parseAbi(['function createPolicy(address,uint8) returns (uint64)', 'function renounceAdmin(uint64)', 'function isAuthorized(uint64,address) view returns (bool)']);
  const createPolicy = encodeFunctionData({ abi: registry, functionName: 'createPolicy', args: [USER as Hex, 1] });
  const at = { block: 'latest', header };
  // createPolicy, timed in its trace: 6 a word of input (3), the flag's cold read (2,100), the counter's read and
  // write (2,100 and 2,900: once each, where the reference read it three times), the policy's write (22,100) and
  // its two events (1,756 and 1,875): what Base's node charged it, measured from a contract.
  const [made] = (await base.trace([{ chainId: 8453, from: USER, to: POLICY, data: createPolicy, value: 0n, at }]))!;
  assert.deepEqual([made.status, made.trace!.gasUsed, BigInt(made.returnData!)], ['success', 18n + 2_100n + 2_100n + 2_900n + 22_100n + 1_756n + 1_875n, (1n << 56n) | 139n]);
  // One call in the trace, as the node's (its read of the flag is its own), and both registries read.
  assert.deepEqual([made.trace!.calls ?? [], made.standIns], [[], [POLICY, ACTIVATION]]);
  // A view doesn't read the flag.
  const [viewed] = (await base.trace([{ chainId: 8453, from: USER, to: POLICY, data: encodeFunctionData({ abi: registry, functionName: 'isAuthorized', args: [0n, BOB as Hex] }), value: 0n, at }]))!;
  assert.deepEqual([viewed.trace!.gasUsed, viewed.standIns], [18n, [POLICY]]);
  // renounceAdmin at its least gas, and 1 under it, from the caller: 12 for its input, the flag (2,100), the policy's
  // read and write (2,100, 2,900), the pending admin deleted as one write (2,200: the reference read it first, which
  // put its read before EIP-2200's sentry and made it succeed on as little as 9,413 here) and its event (1,875).
  const renounce = encodeFunctionData({ abi: registry, functionName: 'renounceAdmin', args: [ALLOWLIST] });
  const given = (gas: bigint) => ({ chainId: 8453, from: USER, to: CALLER, data: `0x${gas.toString(16).padStart(64, '0')}${renounce.slice(2)}` as Hex, value: 0n, at });
  const [enough, under] = await Promise.all([base.simulate(given(11_187n)), base.simulate(given(11_186n))]);
  assert.deepEqual([BigInt(enough!.returnData!), BigInt(under!.returnData!)], [1n, 0n]);
  // Switched off, a write is refused (FeatureNotActivated(feature)) once it has read the flag; its calldata decoded
  // first, so calldata it can't decode still reverts with the selector, reading nothing (6 for its one word).
  await put(ACTIVATION, flag, 0n);
  const [off, undecodable] = (await base.trace([{ chainId: 8453, from: USER, to: POLICY, data: createPolicy, value: 0n, at }, { chainId: 8453, from: USER, to: POLICY, data: createPolicy.slice(0, 10) as Hex, value: 0n, at }]))!;
  assert.deepEqual([off.status, off.returnData, off.trace!.gasUsed], ['reverted', `0xb9b2a425${feature.slice(2)}`, 18n + 2_100n]);
  assert.deepEqual([undecodable.returnData, undecodable.trace!.gasUsed], [createPolicy.slice(0, 10), 6n]);
  await put(ACTIVATION, flag, 1n);
});

test('Base’s policy registry: a composite’s children and a bool word, read as the node reads them', async () => {
  const POLICY = '0x8453000000000000000000000000000000000002', ACTIVATION = '0x8453000000000000000000000000000000000001';
  const POLICY_AT = 0x00503aeb06982fa1fe3151dc68f90b3946c55c449dfd447e49dcaece71ba4a00n, ACTIVATION_AT = 0x43ee1bbe25e988521cccd8b2c8fbd38c8287ebff8e074e825a70dfd3885cce00n;
  const flag = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [keccak256(toHex('base.policy_registry')), ACTIVATION_AT]));
  const slotOf = (id: bigint, field: bigint) => keccak256(encodeAbiParameters([{ type: 'uint64' }, { type: 'uint256' }], [id, POLICY_AT + field]));
  const put = (a: string, slot: Hex, value: bigint) => chain.evm.stateManager.putStorage(createAddressFromString(a), hexToBytes(slot), setLengthLeft(hexToBytes(toHex(value)), 32));
  for (const r of [ACTIVATION, POLICY]) await chain.putCode(r, '0xef');
  await put(ACTIVATION, flag, 1n);
  // Three allowlists and a blocklist the user administers, and a UNION of the four: one slot of children, four ids.
  const id = (type: bigint, n: bigint) => (type << 56n) | n;
  const [AL, AL2, AL3, BL, UNION, ABSENT] = [id(1n, 0x2000001n), id(1n, 0x2000002n), id(1n, 0x2000003n), id(0n, 0x2000004n), id(2n, 0x2000005n), id(2n, 0x2000006n)];
  for (const p of [AL, AL2, AL3, BL, UNION]) await put(POLICY, slotOf(p, 0n), (1n << 255n) | BigInt(USER));
  const children = slotOf(UNION, 4n), first = BigInt(keccak256(children));
  await put(POLICY, children, 4n);
  await put(POLICY, toHex(first, { size: 32 }), AL | (AL2 << 64n) | (AL3 << 128n) | (BL << 192n));
  const base = new ForkSimulator({ 8453: URL_ }, { fetchImpl: chain.fetchImpl, profiles: { 8453: CHAIN_PROFILES[8453] } });
  const header = { number: 17n, timestamp: 1_800_000_000n, coinbase: '0x0000000000000000000000000000000000000000', gasLimit: 30_000_000n, baseFeePerGas: 0n, prevRandao: `0x${'00'.repeat(32)}` as Hex };
  const registry = parseAbi(['function isAuthorized(uint64,address) view returns (bool)', 'function compositePolicyChildIds(uint64) view returns (uint64[])', 'function updateComposite(uint64,uint64[])', 'function updateAllowlist(uint64,bool,address[])']);
  const at = { block: 'latest', header };
  const run = (...data: Hex[]) => base.trace(data.map(d => ({ chainId: 8453, from: USER, to: POLICY, data: d, value: 0n, at })));
  const childIds = (r: SimulationResult) => decodeFunctionResult({ abi: registry, functionName: 'compositePolicyChildIds', data: r.returnData as Hex });
  // Bob is on none of the allowlists and not blocked: the UNION asks all four. Its length and its one slot read once
  // each, before the first child, then each child's member (6 for its input, 6 reads at 2,100): what Base's node
  // charges, measured from a contract, where a copy to memory read a second slot (2,100 more, or 100 warm).
  const [authorized, listed, absent] = (await run(encodeFunctionData({ abi: registry, functionName: 'isAuthorized', args: [UNION, BOB as Hex] }),
    encodeFunctionData({ abi: registry, functionName: 'compositePolicyChildIds', args: [UNION] }), encodeFunctionData({ abi: registry, functionName: 'compositePolicyChildIds', args: [ABSENT] })))!;
  assert.deepEqual([BigInt(authorized.returnData!), authorized.trace!.gasUsed], [1n, 18n + 6n * 2_100n]);
  assert.deepEqual([childIds(listed), listed.trace!.gasUsed], [[AL, AL2, AL3, BL], 12n + 2n * 2_100n]);
  // A composite with no children (none was created) reads its length alone.
  assert.deepEqual([childIds(absent), absent.trace!.gasUsed], [[], 12n + 2_100n]);
  // Shrunk from four children to two: the flag, the composite and the two children read (8,400), the slot written
  // whole once (5,000: the reference cleared the old tail, then wrote it again, 100 more), the length (5,000) and
  // its event (2,524), 6 a word of its input.
  const [shrunk, after] = (await run(encodeFunctionData({ abi: registry, functionName: 'updateComposite', args: [UNION, [AL, BL]] }), encodeFunctionData({ abi: registry, functionName: 'compositePolicyChildIds', args: [UNION] })))!;
  assert.deepEqual([shrunk.status, shrunk.trace!.gasUsed], ['success', 36n + 4n * 2_100n + 5_000n + 5_000n + 2_524n]);
  assert.deepEqual(childIds(after), [AL, BL]);
  // A bool word of 2 the node takes as true (any word with its upper 31 bytes zero; nonzero is true): the member is
  // written, and logged, as 1, where the reference's decoder refused it. The trace keeps the input as it was sent.
  const allow = encodeFunctionData({ abi: registry, functionName: 'updateAllowlist', args: [AL, true, [BOB as Hex]] });
  const word = (w: string) => `${allow.slice(0, 74)}${w.padStart(64, '0')}${allow.slice(138)}` as Hex;
  const [two, asked] = (await run(word('02'), encodeFunctionData({ abi: registry, functionName: 'isAuthorized', args: [AL, BOB as Hex] })))!;
  assert.deepEqual([two.status, two.trace!.gasUsed, two.trace!.input], ['success', 36n + 2_100n + 2_100n + 22_100n + 2_524n, word('02')]);
  assert.equal(BigInt(`0x${two.logs![0].data.slice(2, 66)}`), 1n);
  assert.equal(BigInt(asked.returnData!), 1n);
  // An upper byte set, the node refuses it as calldata it can't decode: the selector, nothing read.
  const [upper] = (await run(word('0100')))!;
  assert.deepEqual([upper.status, upper.returnData, upper.trace!.gasUsed], ['reverted', allow.slice(0, 10), 36n]);
});

test('Base’s NonceManager and TxContext (EIP-8130’s) run from its upgrade of 2026-11-05 on, as its node answers and charges them', async () => {
  // What each is given and what it answers, gas included, as measured on Base's node on 2026-11-15.
  const NM = '0x813000000000000000000000000000000000aa01', TC = '0x813000000000000000000000000000000000aa02';
  const base = new ForkSimulator({ 8453: URL_ }, { fetchImpl: chain.fetchImpl, profiles: { 8453: CHAIN_PROFILES[8453] } });
  const header = (timestamp: bigint) => ({ number: 17n, timestamp, coinbase: '0x0000000000000000000000000000000000000000', gasLimit: 30_000_000n, baseFeePerGas: 0n, prevRandao: `0x${'00'.repeat(32)}` as Hex });
  const at = { block: 'latest', header: header(1_800_000_000n) };
  const abi = parseAbi(['function getNonce(address account, uint256 nonceKey) view returns (uint64)', 'function getTransactionSender() view returns (address)',
    'function getTransactionPayer() view returns (address)', 'function getTransactionSenderActorId() view returns (bytes32)']);
  const getNonce = (account: string, key: bigint) => encodeFunctionData({ abi, functionName: 'getNonce', args: [account as Hex, key] });
  const sender = encodeFunctionData({ abi, functionName: 'getTransactionSender' });
  const trace = async (to: string, data: Hex, value = 0n) => (await base.trace([{ chainId: 8453, from: USER, to, data, value, at }]))![0];
  const word = (n: bigint) => setLengthLeft(hexToBytes(toHex(n)), 32);
  // nonces[account][key] in NonceManager's own storage, at ERC-7201's base.nonce_manager.
  const LOCATION = 0x9d3ea32ad25774a46482ebbae019e8da4242109d164d324a59aa787515b9fe00n;
  const slot = (account: string, key: bigint) => keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes32' }], [key, keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [account as Hex, LOCATION]))]));

  // A key never used: 0, for 6 gas a word of its input and the slot's cold read.
  const unused = await trace(NM, getNonce(BOB, 1n));
  assert.deepEqual([unused.status, BigInt(unused.returnData!), unused.trace!.gasUsed], ['success', 0n, 18n + 2_100n]);
  // One used: what the chain's slot holds.
  await chain.evm.stateManager.putStorage(createAddressFromString(NM), hexToBytes(slot(BOB, 5n)), word(42n));
  const used = await trace(NM, getNonce(BOB, 5n));
  assert.deepEqual([used.status, BigInt(used.returnData!)], ['success', 42n]);
  // The account has no code, nonce or balance: once a transaction has called it, it is removed as empty (EIP-161)
  // with its storage, and a later transaction reads 0, as Base's node has it (measured with a state override).
  const [first, after] = (await base.simulateBatch([{ chainId: 8453, from: USER, to: NM, data: getNonce(BOB, 5n), value: 0n, at }, { chainId: 8453, from: USER, to: NM, data: getNonce(BOB, 5n), value: 0n, at }]))!;
  assert.deepEqual([BigInt(first.returnData!), BigInt(after.returnData!)], [42n, 0n]);
  // A value there too large for a uint64 (only a state override puts one there): Panic(0x11).
  await chain.evm.stateManager.putStorage(createAddressFromString(NM), hexToBytes(slot(BOB, 6n)), word(1n << 64n));
  assert.equal((await trace(NM, getNonce(BOB, 6n))).returnData, '0x4e487b710000000000000000000000000000000000000000000000000000000000000011');
  // Key 0 is the account's own nonce: ProtocolNonceNotSupported(), charged its input alone.
  const protocol = await trace(NM, getNonce(BOB, 0n));
  assert.deepEqual([protocol.status, protocol.returnData, protocol.trace!.gasUsed], ['reverted', '0x1bc81ca9', 18n]);
  // Calldata it can't decode reverts with its selector (zeros short of one), at 6 a word.
  const shortOf = await trace(NM, getNonce(BOB, 1n).slice(0, 74) as Hex);
  const dirty = await trace(NM, `${getNonce(BOB, 1n).slice(0, 10)}ff${getNonce(BOB, 1n).slice(12)}` as Hex);
  const lacks = await trace(NM, `0xdeadbeef${'00'.repeat(96)}`);
  assert.deepEqual([shortOf, dirty, lacks].map(r => [r.status, r.returnData, r.trace!.gasUsed]), [['reverted', '0x89535803', 12n], ['reverted', '0x89535803', 18n], ['reverted', '0xdeadbeef', 24n]]);
  assert.deepEqual([(await trace(NM, '0x895358')).returnData, (await trace(NM, '0x')).trace!.gasUsed], ['0x00000000', 0n]);
  // Read twice in a transaction (a contract asking for it twice), the second read is warm: 118.
  const TWICE = '0x00000000000000000000000000000000000aa0a1', call = (to: string, op = 'fa') => `5f5f365f73${to.slice(2)}5a${op}`;
  await chain.putCode(TWICE, `0x365f5f37${call(NM)}50${call(NM)}503d5f5f3e3d5ff3`);
  const twice = await trace(TWICE, getNonce(BOB, 1n));
  assert.deepEqual(twice.trace!.calls!.map(c => c.gasUsed), [2_118n, 118n]);

  // TxContext: from a contract, the transaction's sender (not the contract that asks), for 3 gas; so for the
  // payer, and the sender's own actor id. Another function, or none: its selector back, for nothing.
  const RELAY = '0x00000000000000000000000000000000000aa0a2';
  await chain.putCode(RELAY, `0x365f5f37${call(TC)}3d5f5f3e6029573d5ffd5b3d5ff3`);
  const asked = await trace(RELAY, sender);
  assert.deepEqual([asked.status, asked.returnData, asked.trace!.calls![0].gasUsed], ['success', `0x${USER.slice(2).padStart(64, '0')}`, 3n]);
  for (const f of ['getTransactionPayer', 'getTransactionSenderActorId'] as const) assert.equal((await trace(TC, encodeFunctionData({ abi, functionName: f }))).returnData, `0x${USER.slice(2).padStart(64, '0')}`);
  const calls = await trace(TC, '0xdf66b5cb');
  assert.deepEqual([calls.status, calls.returnData, calls.trace!.gasUsed], ['reverted', '0xdf66b5cb', 0n]);
  // Run as another's code, either refuses: DelegateCallNotAllowed(). Sent value: NonPayable(), charging nothing.
  const DELEGATOR = '0x00000000000000000000000000000000000aa0a3';
  for (const to of [NM, TC]) {
    await chain.putCode(DELEGATOR, `0x365f5f37${call(to, 'f4')}3d5f5f3e6029573d5ffd5b3d5ff3`);
    const delegated = await trace(DELEGATOR, to === NM ? getNonce(BOB, 1n) : sender);
    assert.deepEqual([delegated.status, delegated.returnData], ['reverted', '0x0d89438e']);
    const paid = await trace(to, to === NM ? getNonce(BOB, 1n) : sender, 1n);
    assert.deepEqual([paid.status, paid.returnData, paid.trace!.gasUsed], ['reverted', '0x6fb1b0e9', 0n]);
  }
  // Moved elsewhere for a simulation: refused (the local EVM has them at their own addresses only).
  await assert.rejects(base.simulateBatch([{ chainId: 8453, from: USER, to: NM, data: getNonce(BOB, 1n), value: 0n, at, stateOverrides: { [NM]: { movePrecompileToAddress: BOB } } }]),
    (e: Error) => e instanceof ForkUnsupported && /NonceManager, which the local EVM has at its own address only/.test(e.message));
  // Nor another precompile moved onto one of them: Base's node runs the one moved there (sha256 onto NonceManager
  // returns the input's hash), which the local EVM wouldn't.
  for (const onto of [NM, TC]) await assert.rejects(base.simulateBatch([{ chainId: 8453, from: USER, to: onto, data: getNonce(BOB, 1n), value: 0n, at, stateOverrides: { '0x0000000000000000000000000000000000000002': { movePrecompileToAddress: onto } } }]),
    (e: Error) => e instanceof ForkUnsupported && /a precompile moved onto it isn't run by the local EVM/.test(e.message));
  // Before Base's upgrade, where the node lists them, a call reaching one is refused, not run as an empty account.
  chain.config = { current: { forkId: '0x169d85a3', activationTime: 1_793_901_600, precompiles: { NonceManager: NM, TxContext: TC } } };
  try {
    await assert.rejects(new ForkSimulator({ 8453: URL_ }, { fetchImpl: chain.fetchImpl }).simulateBatch([{ chainId: 8453, from: USER, to: NM, data: getNonce(BOB, 1n), value: 0n, at: { block: 'latest', header: header(1_793_901_599n) } }]),
      (e: Error) => e instanceof ForkUnsupported && /is NonceManager, a precompile this chain's node has/.test(e.message));
    const [now] = (await new ForkSimulator({ 8453: URL_ }, { fetchImpl: chain.fetchImpl }).simulateBatch([{ chainId: 8453, from: USER, to: TC, data: sender, value: 0n, at }]))!;
    assert.deepEqual([now.status, now.returnData], ['success', `0x${USER.slice(2).padStart(64, '0')}`]);
  } finally { chain.config = undefined; }
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

test("Arbitrum charges no calldata floor (EIP-7623); the other chains from Prague on do", async () => {
  // 1,000 bytes of calldata to an account with no code: 21,000 + 16 a byte = 37,000 on Arbitrum's node, the floor's
  // 21,000 + 40 a byte = 61,000 on Ethereum's, Base's, OP Mainnet's, Polygon's and BNB Chain's (2026-11-15).
  const call = { chainId: 999, from: USER, to: '0x0000000000000000000000000000000000001111', data: `0x${'ab'.repeat(1000)}` as Hex, value: 0n };
  const gasOn = async (profile: typeof CHAIN_PROFILES[number]) => (await fork({ profiles: { 999: { ...profile } } }).simulateBatch([call]))![0].gasUsed;
  assert.deepEqual([await gasOn(CHAIN_PROFILES[42161]), await gasOn(CHAIN_PROFILES[1]), await gasOn(CHAIN_PROFILES[8453])], [37_000n, 61_000n, 61_000n]);
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

test('A node that can’t run all of a block’s earlier transactions within its gas for one simulation gets those that bear on the replayed one', async () => {
  // Ethereum's public node allows a simulation 50 million gas, its blocks hold 60: a trace of a transaction past that
  // in its block had none. Here Bob's transfer of 30 USDC only works after the user's 50 to him, the first of two
  // earlier transactions, and the node refuses a simulated block with both.
  const CAROL = '0xca401000000000000000000000000000000000c4';
  const header = { number: 17n, timestamp: 0x65000001n, coinbase: '0x0000000000000000000000000000000000000000', gasLimit: 30_000_000n, baseFeePerGas: 0n, prevRandao: `0x${'00'.repeat(32)}` as Hex };
  const earlier: SimulationRequest[] = [50_000_000n, 1n].map(amount => ({ chainId: 999, from: USER, to: usdc, data: call('transfer', [BOB, amount]), value: 0n, gas: 100_000n }));
  const target: SimulationRequest = { chainId: 999, from: BOB, to: usdc, data: call('transfer', [CAROL, 30_000_000n]), value: 0n };
  await chain.setBalance(BOB, E);
  const asked: number[] = [];
  const capped = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { id: number; method: string; params: [{ blockStateCalls: { calls: unknown[] }[] }] }[];
    const sim = Array.isArray(body) ? body.find(b => b.method === 'eth_simulateV1') : undefined;
    if (sim) asked.push(sim.params[0].blockStateCalls[0].calls.length);
    if (sim && sim.params[0].blockStateCalls[0].calls.length > 1) return new Response(JSON.stringify(body.map(b => ({ jsonrpc: '2.0', id: b.id, error: { code: -38013, message: 'intrinsic gas too low' } }))), { headers: { 'content-type': 'application/json' } });
    return chain.fetchImpl(url, init);
  }) as typeof fetch;
  chain.simulateV1 = true;
  try {
    const [r] = (await fork({ fetchImpl: capped }).trace([{ ...target, at: { block: '0x10', header, before: earlier, related: async () => [0] } }]))!;
    assert.equal(r.status, 'success');
    assert.deepEqual([asked[0], [...new Set(asked.slice(1))]], [2, [1]]);
    // With nothing to narrow to (none worked out, or all of them named), the node's refusal stands.
    await assert.rejects(fork({ fetchImpl: capped }).trace([{ ...target, at: { block: '0x10', header, before: earlier } }]), /intrinsic gas too low/);
    await assert.rejects(fork({ fetchImpl: capped }).trace([{ ...target, at: { block: '0x10', header, before: earlier, related: async () => [0, 1] } }]), /intrinsic gas too low/);
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
  // A transaction whose gas, after the 19,816 it pays before its call, can't pay for its authorization's state
  // (here 35,190) runs out of gas: all its gas used, and its authorization not applied, the sender's nonce alone
  // taken. Sepolia's 0xeb79d200… (2026-11-16): 29,724 gas, the account left without code, its nonce up by one.
  const SHORT = `0x${'f4'.repeat(32)}` as Hex, short = privateKeyToAccount(SHORT).address.toLowerCase();
  await chain.setBalance(short, E);
  // (To an address with no code, so the call itself runs nothing.)
  const nowhere = async (key: Hex, nonce: number) => {
    const a = await privateKeyToAccount(key).signAuthorization({ address: '0x00000000000000000000000000000000000d0e5e', chainId: 11155111, nonce });
    return { address: '0x00000000000000000000000000000000000d0e5e', chainId: toHex(11155111), nonce: toHex(nonce), r: a.r, s: a.s, yParity: toHex(a.yParity!) };
  };
  const self = async (gas: bigint) => (await new ForkSimulator({ 11155111: URL_ }, { fetchImpl: chain.fetchImpl }).trace([{ chainId: 11155111, from: short, to: short, data: '0x', value: 0n, gas,
    at: { block: '0x10', header: amsterdam }, authorizationList: [await nowhere(SHORT, 1)] }]))![0];
  const exhausted = await self(29_724n);
  // (What a transaction changes is counted from after its sender's nonce goes up: here, nothing.)
  assert.deepEqual([exhausted.status, exhausted.gasUsed, exhausted.revertReason?.startsWith('out of gas'), exhausted.stateChanges], ['reverted', 29_724n, true, undefined]);
  assert.deepEqual([exhausted.trace?.error, exhausted.trace?.gasUsed], ['out of gas', 0n]);
  // Given enough, it applies: 19,816, the 35,190, and 3,000 to reach the delegate's code (a cold account).
  const applied = await self(60_000n);
  assert.deepEqual([applied.status, applied.gasUsed, applied.stateChanges], ['success', 19_816n + 35_190n + 3_000n, [{ address: short, nonce: { before: 1n, after: 2n }, code: true }]]);
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

test('BNB Chain’s own precompiles at its node’s prices: secp256k1 run here, BLS, light-block and evidence checks answered by the chain', async () => {
  // A contract that STATICCALLs the precompile with its calldata and returns whether the call succeeded, the gas it
  // spent (118 of it the contract's own: its pushes, the warm call, GAS) and what came back.
  const callerOf = (t: number) => `0x3660006000375a6000600036600060${t.toString(16)}5afa5a9060005290036020523d600060403e3d6040016000f3` as Hex;
  const AT = '0x00000000000000000000000000000000c0de0056', at = (a: number) => `0x${a.toString(16).padStart(40, '0')}`;
  // The chain's answers (eth_call to each), here from code that answers 0x01 to any input and reverts on none.
  for (const a of [0x66, 0x67, 0x68]) await chain.putCode(at(a), '0x3615600d5760015f5360015ff35b5f5ffd');
  try {
    const bsc = new ForkSimulator({ 56: URL_ }, { fetchImpl: chain.fetchImpl });
    const run = async (t: number, data: string) => {
      const r = (await bsc.simulateBatch([{ chainId: 56, from: USER, to: AT, data: `0x${data}`, value: 0n, gas: 1_000_000n, stateOverrides: { [AT]: { code: callerOf(t) } } }]))![0];
      const out = r.returnData!.slice(2), spent = Number(BigInt(`0x${out.slice(64, 128)}`)) - 118;
      // (A call that fails taking all its gas: said as such, the figure being what the call was given.)
      return [BigInt(`0x${out.slice(0, 64)}`) === 1n, spent > 900_000 ? 'all' : spent, `0x${out.slice(128)}`];
    };
    // secp256k1, as the chain's node answered it for this input (measured 2026-11-15): a Tendermint key's address
    // for 3,000 gas; with s high it fails, taking all the gas.
    const pub = '0324653eac434488002cc06bbfb7f10fe18991e35f9fe4302dbea6d2353dc0ab1c', r = '1172c11d559a8ebbd6684e02ffac7b7605803d7253d44aed1d681b8814a96b60', s = 0x3d0f3081364d3671f28071abe6f99825e1eac50b88746f5fa6d762ecabcb9eben;
    const digest = '07'.repeat(32), n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    assert.deepEqual(await run(0x69, `${pub}${r}${s.toString(16)}${digest}`), [true, 3_000, '0x14db4138d56a2ecfb10881a9be394d9f321985b2']);
    assert.deepEqual(await run(0x69, `${pub}${r}${(n - s).toString(16).padStart(64, '0')}${digest}`), [false, 'all', '0x']);
    assert.deepEqual(await run(0x69, `${pub}${r}${s.toString(16)}${digest}00`), [false, 'all', '0x']);
    // BLS: 1,000 and 3,500 a key; an input it can't read reverts, and the rest of the gas comes back.
    assert.deepEqual(await run(0x66, 'ab'.repeat(128 + 48)), [true, 4_500, '0x01']);
    assert.deepEqual(await run(0x66, 'ab'.repeat(128 + 3 * 48)), [true, 11_500, '0x01']);
    assert.deepEqual(await run(0x66, 'ab'.repeat(129)), [true, 1_000, '0x01']);
    assert.deepEqual(await run(0x66, ''), [false, 1_000, '0x']);
    // The light-block check: 3,000 and 16 a byte; a failure takes all the gas. Double-sign evidence: 10,000, reverting.
    assert.deepEqual(await run(0x67, 'ab'.repeat(100)), [true, 4_600, '0x01']);
    assert.deepEqual(await run(0x67, ''), [false, 'all', '0x']);
    assert.deepEqual(await run(0x68, ''), [false, 10_000, '0x']);
    // The two deprecated ones fail whatever they are given.
    assert.deepEqual([await run(0x64, 'ab'.repeat(100)), await run(0x65, '')], [[false, 'all', '0x'], [false, 'all', '0x']]);
    // None of them is forwarded at a flat price any more. From the chain's fork of 2026-12-08 the double-sign check
    // costs 16 more a byte (measured on its node in a block at that time).
    assert.equal(CHAIN_PROFILES[56].forwardedPrecompiles, undefined);
    const evidence = CHAIN_PROFILES[56].ownPrecompiles![at(0x68)].gas, kilobyte = new Uint8Array(1000);
    assert.deepEqual([evidence(kilobyte, 1_796_696_999n), evidence(kilobyte, 1_796_697_000n), evidence(new Uint8Array(0), 1_796_697_000n)], [10_000n, 26_000n, 10_000n]);
  } finally {
    for (const a of [0x66, 0x67, 0x68]) await chain.putCode(at(a), '0x');
  }
});

// Sepolia's gas burner (0x4a65…3441, in most of its blocks since November 2026): whatever it is sent, it loops until
// less than 10,000 gas is left, then logs and stops. 2.5 million gas a transaction there; 300,000 here.
const BURNER = '0x4a65000000000000000000000000000000003441', BURNER_CODE = '0x5f5a5f600e565b5f5260205fa1005b6127105a1060065760010161133750600e56';
const SENDERS = ['0x5e00000000000000000000000000000000000001', '0x5e00000000000000000000000000000000000002', '0x5e00000000000000000000000000000000000003'];
const burns = () => SENDERS.map(from => ({ chainId: 999, from, to: BURNER, data: '0x001e37cd' as Hex, value: 0n, gas: 300_000n }));
const outcome = (rs: SimulationResult[]) => rs.map(r => [r.status, r.gasUsed, r.returnData, r.transfers.map(t => [t.asset, t.from, t.to, t.raw]), r.logs?.length]);

test('A contract that burns the gas of any call it gets is read once, not before and after every call and in every round', async () => {
  await chain.putCode(BURNER, BURNER_CODE);
  for (const s of SENDERS) await chain.setBalance(s, E);
  clearForkCaches();
  // Each call's target is read as a token too (a wrapper that emits no Transfer). This one would burn all of a
  // view's 10 million gas, three views a call (its balance before and after, the NFT interface) and every round, and
  // can't answer any (no RETURN in its code): none is run.
  const sim = fork({ watchTokens: false });
  const reqs = burns().map(r => ({ ...r, watch: [BURNER] }));
  const out = (await sim.simulateBatch(reqs))!;
  assert.deepEqual(out.map(r => [r.status, r.gasUsed]), SENDERS.map(() => ['success', out[0].gasUsed]));
  assert.ok(out[0].gasUsed! > 290_000n, String(out[0].gasUsed));
  assert.deepEqual([sim.last!.views, sim.last!.calls, sim.last!.rounds], [0, 3, 1]);
  // The same as a run that fetches each value as it goes, with no rounds.
  assert.deepEqual(outcome(out), outcome((await fork({ watchTokens: false, maxRounds: 0 }).simulateBatch(reqs))!));
  // One that could answer but spends all of a view's gas (here at once, growing its memory past it) is run once for
  // each function asked of it, and then answers as it did.
  const greedy = '0x6eed000000000000000000000000000000000001';
  await chain.putCode(greedy, '0x5f622a0000525f5ff3');
  clearForkCaches();
  const watching = fork({ watchTokens: false });
  const read = (await watching.simulateBatch(burns().map(r => ({ ...r, watch: [greedy] }))))!;
  // (Once where the reads around the calls are warmed up, and once in the run: what the warm-up's EVM answered,
  // without the chain's precompiles and hooks, isn't taken for the run's.)
  assert.deepEqual([watching.last!.views, watching.last!.calls], [4, 3]);
  assert.deepEqual(outcome(read), outcome(out));
});

test('A round starts where the last got to on fetched values alone: the calls before are not run again', async () => {
  // Three burners first, as in a Sepolia replay, then a call that only a round a hop finds what it reads next.
  let hop = '0x0000000000000000000000000000000000000000';
  for (let i = 1; i <= 6; i++) hop = await chain.deploy('Hop', 'address,uint256', [hop, BigInt(i)]);
  const batch = [...burns(), { chainId: 999, from: USER, to: hop, data: encodeFunctionData({ abi: parseAbi(['function total() view returns (uint256)']), functionName: 'total' }), value: 0n }];
  clearForkCaches();
  const sim = fork({ watchTokens: false });
  const out = (await sim.simulateBatch(batch))!;
  assert.equal(BigInt(out[3].returnData!), 21n);
  const { rounds, calls } = sim.last!;
  assert.ok(rounds >= 6, `${rounds} rounds`);
  // The burners ran in the first round only; the last call in each.
  assert.equal(calls, SENDERS.length + rounds);
  assert.deepEqual(outcome(out), outcome((await fork({ watchTokens: false, maxRounds: 0 }).simulateBatch(batch))!));
  // A token a later call shows is read around the calls before it too: those run again, as they must.
  clearForkCaches();
  const giver = '0x91fe000000000000000000000000000000000092';
  await chain.putCode(giver, `0x6044602a6000396000600060446000600073${shares.slice(2)}5af15000${call('transfer', [USER, 101n]).slice(2)}` as Hex);
  await chain.exec(shares, call('mintShares', [giver, 300n]));
  const shown = [{ chainId: 999, from: USER, to: BOB, data: '0x' as Hex, value: 0n }, ...burns().slice(0, 1), { chainId: 999, from: USER, to: giver, data: '0x' as Hex, value: 0n }];
  const got = (await fork({ watchTokens: false }).simulateBatch(shown))!;
  assert.deepEqual(got[2].transfers.map(t => [t.asset, t.to, t.raw]), [[shares, USER, 100n]]);
  assert.deepEqual(outcome(got), outcome((await fork({ watchTokens: false, maxRounds: 0 }).simulateBatch(shown))!));
});

test('A token behind a proxy is read ahead, not found a round at a time with every call run again', async () => {
  // A delegating proxy (its implementation in the EIP-1967 slot) in front of a Token: its balanceOf reads the slot,
  // then the implementation's code, then the balance in the proxy's storage. Watched around a call to the burner.
  const proxy = '0x9100000000000000000000000000000000001967', impl = await chain.deploy('Token', 'string,uint8', ['PUSD', 6]);
  const SLOT = '360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
  // CALLDATACOPY it all, DELEGATECALL the implementation with it, and RETURN (or REVERT) what came back.
  await chain.putCode(proxy, `0x365f5f375f5f365f7f${SLOT}545af43d5f5f3e6036573d5ffd5b3d5ff3` as Hex);
  const sm = chain.evm.stateManager;
  await sm.putStorage(createAddressFromString(proxy), hexToBytes(`0x${SLOT}`), setLengthLeft(hexToBytes(impl as Hex), 32));
  await chain.exec(proxy, call('mint', [SENDERS[0], 5_000_000n]));
  clearForkCaches();
  const sim = fork({ watchTokens: false });
  const req = { ...burns()[0], watch: [proxy] };
  const [r] = (await sim.simulateBatch([req]))!;
  assert.equal(r.status, 'success');
  assert.deepEqual(r.readAssets, ['native', proxy]);
  // One round: the reads around the call found what they need on their own first (before: three, the call run in each).
  assert.deepEqual([sim.last!.rounds, sim.last!.calls], [1, 1]);
});

test('The node is asked what the calls touch in one request, the last calls of a long batch among them', async () => {
  const asked: { to?: string }[][] = [];
  const recording = (async (u: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { method: string; params: { to?: string }[] }[];
    if (Array.isArray(body) && body.some(r => r.method === 'eth_createAccessList')) asked.push(body.filter(r => r.method === 'eth_createAccessList').map(r => r.params[0]));
    return chain.fetchImpl(u, init);
  }) as typeof fetch;
  const to = (i: number) => `0x70${(100 + i).toString(16).padStart(38, '0')}`;
  const batch = Array.from({ length: 10 }, (_, i) => ({ chainId: 1, from: USER, to: to(i), data: '0x' as Hex, value: 0n }));
  // (The test chain has no eth_createAccessList: each is refused, and the run goes on without.)
  const sim = new ForkSimulator({ 1: URL_ }, { fetchImpl: recording, watchTokens: false });
  const out = (await sim.simulateBatch(batch))!;
  assert.deepEqual(out.map(r => r.status), batch.map(() => 'success'));
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0].map(c => c.to), [0, 1, 2, 3, 6, 7, 8, 9].map(to));
  // A node that said it has no such method isn't asked again (Arbitrum One's public node, which rate-limits by
  // request), by this simulator or another.
  await sim.simulateBatch(batch.slice(0, 2));
  await new ForkSimulator({ 1: URL_ }, { fetchImpl: recording, watchTokens: false }).simulateBatch(batch.slice(0, 2));
  assert.equal(asked.length, 1);
  clearForkCaches();
});

test('A state read that got no answer is asked again: a timeout, a reset connection, a batch answered short, a node a block behind', async () => {
  let n = 0;
  const flaky = (async (u: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { id: number; method: string }[];
    if (!Array.isArray(body) || !body.some(r => r.method === 'eth_getBalance')) return chain.fetchImpl(u, init);
    n++;
    if (n === 1) throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    if (n === 2) throw new TypeError('fetch failed');
    const answer = await (await chain.fetchImpl(u, init)).json() as { id: number }[];
    if (n === 3) return new Response(JSON.stringify(answer.slice(1)));
    if (n === 4) return new Response(JSON.stringify(answer.map((a, i) => i === 0 ? { jsonrpc: '2.0', id: a.id, error: { code: -32000, message: 'block not found: 0x1932389' } } : a)));
    return new Response(JSON.stringify(answer));
  }) as typeof fetch;
  const req = { chainId: 999, from: USER, to: usdc, data: call('transfer', [BOB, 4n]), value: 0n };
  clearForkCaches();
  const [r] = (await fork({ fetchImpl: flaky }).simulateBatch([req]))!;
  assert.ok(n >= 5, `${n} requests of balances`);
  clearForkCaches();
  const [clean] = (await fork().simulateBatch([req]))!;
  assert.deepEqual(outcome([r]), outcome([clean]));
  // A node that never answers fails the simulation once its time is up, saying so.
  const silent = (async (u: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { method: string }[];
    if (Array.isArray(body) && body.some(x => x.method === 'eth_getBalance')) throw new TypeError('fetch failed');
    return chain.fetchImpl(u, init);
  }) as typeof fetch;
  clearForkCaches();
  await assert.rejects(fork({ fetchImpl: silent, timeoutMs: 1500 }).simulateBatch([req]), /state fetch failed: fetch failed|ran out of time/);
});

test('eth_simulateV1 answered by a node that has not the block yet is asked again', async () => {
  // A load-balanced public node: one behind it hasn't the parent of the block just served (Ethereum, 2026-11-15).
  let refused = 0;
  const behind = (async (u: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (!Array.isArray(body) && body.method === 'eth_simulateV1' && refused < 2) { refused++; return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message: 'block not found: 0x1932389' } })); }
    return chain.fetchImpl(u, init);
  }) as typeof fetch;
  chain.simulateV1 = true;
  try {
    const r = await new RpcSimulator({ 999: URL_ }, { fetchImpl: behind }).simulate({ chainId: 999, from: USER, to: usdc, data: call('transfer', [BOB, 3n]), value: 0n });
    assert.equal(refused, 2);
    assert.equal(r?.status, 'success');
    assert.deepEqual(r?.transfers.map(t => [t.asset, t.raw]), [[usdc, 3n]]);
  } finally { chain.simulateV1 = false; }
});

test('The node not answering what the calls touch costs a few seconds, not the 15 a state read may wait', async () => {
  // (Sepolia's public node left a replay's eth_createAccessList unanswered for 15 seconds, three times in six.)
  const hanging = (async (u: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { method: string }[];
    if (Array.isArray(body) && body.some(r => r.method === 'eth_createAccessList')) return new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)));
    return chain.fetchImpl(u, init);
  }) as typeof fetch;
  const started = Date.now(), open = setInterval(() => {}, 1000); // (as a socket waiting would keep the process up)
  try {
    const [r] = (await new ForkSimulator({ 1: URL_ }, { fetchImpl: hanging, watchTokens: false }).simulateBatch([{ chainId: 1, from: USER, to: usdc, data: call('transfer', [BOB, 1n]), value: 0n }]))!;
    assert.equal(r.status, 'success');
    assert.ok(Date.now() - started < 10_000, `${Date.now() - started} ms`);
  } finally { clearInterval(open); }
});

test('A view that burnt its gas on a value guessed earlier in the run is not remembered as answering nothing', async () => {
  // A token whose balanceOf, once a call has set its slot 5, reads slot 7 and runs out of gas (expanding its memory)
  // where that is 0; slot 7 is 1 on the chain. A call with no calldata reads slot 7 (not fetched yet: guessed, 0) and
  // sets slot 5, so in the first round the balance read after it reads the guess again and burns all its gas.
  const X = '0x6eed000000000000000000000000000000000007';
  await chain.putCode(X, '0x36600e57600754506001600555005b60003560e01c6370a0823114601f57005b600554600114156036576007546036575f622a0000525b602a60005260206000f3');
  await chain.evm.stateManager.putStorage(createAddressFromString(X), setLengthLeft(hexToBytes('0x07'), 32), hexToBytes('0x01'));
  clearForkCaches();
  const sim = fork({ watchTokens: false });
  const [r] = (await sim.simulateBatch([{ chainId: 999, from: USER, to: X, data: '0x', value: 0n, watch: [X] }]))!;
  assert.equal(r.status, 'success');
  assert.ok(sim.last!.rounds >= 2, `${sim.last!.rounds} rounds`);
  // Its balance is read in the round that has slot 7 (42 before, 42 after): not taken from the guess's burnt read.
  assert.deepEqual(r.readAssets, ['native', X]);
  clearForkCaches();
  assert.deepEqual(outcome([r]), outcome((await fork({ watchTokens: false, maxRounds: 0 }).simulateBatch([{ chainId: 999, from: USER, to: X, data: '0x', value: 0n, watch: [X] }]))!));
});

test('A node whose backend has not the block’s state is asked what the calls touch again; one without the method is not', async () => {
  const asked: number[] = [];
  let refusal: { code: number; message: string } = { code: -32000, message: 'historical state 87db481a8b0f405e58c5366749e46006bfd5eae094504723bb8df83fe054e872 is not available' };
  const pruned = (async (u: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { id: number; method: string }[];
    if (Array.isArray(body) && body.some(r => r.method === 'eth_createAccessList')) {
      asked.push(body.length);
      return new Response(JSON.stringify(body.map(r => ({ jsonrpc: '2.0', id: r.id, error: refusal }))));
    }
    return chain.fetchImpl(u, init);
  }) as typeof fetch;
  const req = { chainId: 1, from: USER, to: usdc, data: call('transfer', [BOB, 1n]), value: 0n };
  clearForkCaches();
  const url = 'http://pruned.invalid';
  for (let i = 0; i < 2; i++) assert.equal((await new ForkSimulator({ 1: url }, { fetchImpl: pruned, watchTokens: false }).simulateBatch([req]))![0].status, 'success');
  // (Sepolia's public node, 2026-11-15: one backend in four or five had pruned a block 300 old, the others not.)
  assert.equal(asked.length, 2);
  // JSON-RPC's "method not found" (Arbitrum One's: "the method eth_createAccessList does not exist/is not available").
  refusal = { code: -32601, message: 'the method eth_createAccessList does not exist/is not available' };
  for (let i = 0; i < 2; i++) await new ForkSimulator({ 1: url }, { fetchImpl: pruned, watchTokens: false }).simulateBatch([req]);
  assert.equal(asked.length, 3);
  clearForkCaches();
});

test('A state read the node answers only after the simulation’s time is up says it ran out of time', async () => {
  // Every request takes 2 seconds, and the simulation has 2.5: the first round's reads are asked with half a second
  // left, and cut at the deadline. (A read that ends past it is a timeout, which a caller can tell from a failed read,
  // and which lets an extra run's earlier answer stand.)
  const slow = (async (u: string, init: RequestInit) => {
    await new Promise((answer, abort) => { const t = setTimeout(answer, 2000); init.signal?.addEventListener('abort', () => { clearTimeout(t); abort(init.signal!.reason); }); });
    return chain.fetchImpl(u, init);
  }) as typeof fetch;
  let hop = '0x0000000000000000000000000000000000000000';
  for (let i = 1; i <= 3; i++) hop = await chain.deploy('Hop', 'address,uint256', [hop, BigInt(i)]);
  clearForkCaches();
  const started = Date.now();
  await assert.rejects(new ForkSimulator({ 999: URL_ }, { fetchImpl: slow, profiles, watchTokens: false, timeoutMs: 2500 })
    .simulateBatch([{ chainId: 999, from: USER, to: hop, data: encodeFunctionData({ abi: parseAbi(['function total() view returns (uint256)']), functionName: 'total' }), value: 0n }]),
  (e: Error) => e instanceof ForkTimeout && /ran out of time|needed more than/.test(e.message));
  assert.ok(Date.now() - started < 8000, `${Date.now() - started} ms`);
  clearForkCaches();
});

// Arbitrum's Stylus programs (WASM behind the code prefix 0xEFF000, which no EVM runs), on a chain of their own: its
// node answers eth_getCode for a program with the prefix, so the local EVM sees a Stylus program there, and runs the
// contract's EVM code when it is asked to simulate, standing in for the WASM. Each simulated call's gas is as
// Arbitrum's node gives it: the transaction's (21,000 and its calldata, on top of what ran) and a charge for L1 data.
const STYLUS_CODE = `0xeff00000${'1b'.repeat(40)}`, CODE_READER = '0x00000000000000000000000000000000c0de9ead', L1 = 2_544n, ARB_URL = 'http://arbitrum.invalid';
const txGas = (data: string) => 21_000n + [...(data.slice(2).match(/../g) ?? [])].reduce((g, b) => g + (b === '00' ? 4n : 16n), 0n);
type NodeCall = { status: string; returnData: Hex; gasUsed: Hex; logs: { address: string; topics: Hex[]; data: Hex }[] };
const arb = await testChain();
arb.simulateV1 = true;
const programs = new Set<string>();
/** Each eth_simulateV1 the node was asked: its blocks of calls and overrides. */
const simulated: { calls: { from?: string; to?: string; data?: Hex; value?: Hex; authorizationList?: { address: string }[] }[]; stateOverrides?: Record<string, { code?: Hex; balance?: Hex; nonce?: Hex }> }[][] = [];
const arbFetch = (async (url: string, init: RequestInit) => {
  const body = JSON.parse(String(init.body));
  const asked: { id: number; method: string; params: any[] }[] = Array.isArray(body) ? body : [body];
  const res = await (await arb.fetchImpl(url, init)).json();
  const answers = Array.isArray(res) ? res : [res];
  for (const a of answers) {
    const r = asked.find(x => x.id === a.id);
    if (!r || !a.result) continue;
    if (r.method === 'eth_getCode' && programs.has(String(r.params[0]).toLowerCase())) a.result = STYLUS_CODE;
    if (r.method === 'eth_simulateV1') {
      const blocks = r.params[0].blockStateCalls;
      simulated.push(blocks);
      a.result.forEach((b: { calls: NodeCall[] }, k: number) => b.calls.forEach((out, j) => {
        const c = blocks[k].calls[j];
        out.gasUsed = `0x${(BigInt(out.gasUsed) + txGas(c.data ?? '0x') + L1).toString(16)}`;
        // (The local EVM's read of code after a block's earlier transactions, through a reader: a program's prefix.)
        if (c.to?.toLowerCase() === CODE_READER && programs.has(`0x${c.data.slice(26)}`)) out.returnData = STYLUS_CODE as Hex;
      }));
    }
  }
  return new Response(JSON.stringify(Array.isArray(res) ? answers : answers[0]));
}) as typeof fetch;
const program = await arb.deploy('Token', 'string,uint8', ['USDC', 6]);
programs.add(program);
const dai = await arb.deploy('Token', 'string,uint8', ['DAI', 18]);
const sweeper = await arb.deploy('Sweeper');
await arb.exec(program, call('mint', [USER, 1000_000_000n]));
await arb.exec(dai, call('mint', [USER, 10n * E]));
await arb.exec(program, call('approve', [sweeper, MAX]), USER);
await arb.setBalance(USER, 10n * E);
const SW = parseAbi(['function sweep(address,address)']);
const sweepAll = encodeFunctionData({ abi: SW, functionName: 'sweep', args: [program as Hex, BOB] });
const callsProgram = (before = '') => `0x${before}600060006000600060007${'3'}${program.slice(2)}5af15000` as Hex; // CALL(gas, program, 0, 0, 0, 0, 0); POP; STOP
const arbFork = (o: Partial<ConstructorParameters<typeof ForkSimulator>[1]> = {}) => new ForkSimulator({ 42161: ARB_URL }, { fetchImpl: arbFetch, prefetch: false, ...o });
type ArbRequest = { from: string; to?: string; data: Hex; value?: bigint };
const arbReq = (r: ArbRequest): SimulationRequest => ({ chainId: 42161, value: 0n, ...r, to: r.to ?? null });
/** The last eth_simulateV1 the node was asked whose first block has a call that `has`. */
const lastAsked = (has: (c: (typeof simulated)[number][number]['calls'][number]) => boolean) => [...simulated].reverse().find(b => b[0].calls.some(has))!;
/** The node's own run of the calls, in order in one simulated block, as its eth_simulateV1 answers. */
async function nodeOwn(calls: ArbRequest[]): Promise<NodeCall[]> {
  const res = await arbFetch(ARB_URL, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_simulateV1', params: [{ blockStateCalls: [{ calls: calls.map(c => ({ from: c.from, ...(c.to && { to: c.to }), data: c.data, value: toHex(c.value ?? 0n) })) }], validation: false }, 'latest'] }) });
  return (await res.json()).result[0].calls;
}
/** What a result says of a call, against the node's own run of it: outcome, return data, events, gas less the L1 charge. */
const agrees = (r: SimulationResult, own: NodeCall) => {
  assert.equal(r.status, own.status === '0x1' ? 'success' : 'reverted');
  assert.equal(r.returnData, own.returnData);
  assert.deepEqual(r.logs ?? [], own.logs.map(l => ({ ...l, address: l.address.toLowerCase() })));
  assert.equal(r.gasUsed, BigInt(own.gasUsed) - L1);
};
const moved = (r: SimulationResult) => r.transfers.map(t => [t.asset, t.from, t.to, t.raw]);

test('Arbitrum: a Stylus program reached from inside another contract runs on the chain’s node, the call whole, its events, gas and amounts the node’s', async () => {
  clearForkCaches();
  const req = { from: USER, to: sweeper, data: sweepAll };
  const [r] = (await arbFork().trace([arbReq(req)]))!;
  const [ask] = simulated.slice(-1);
  agrees(r, (await nodeOwn([req]))[0]);
  assert.equal(r.source, `chain 42161's node, for the Stylus (WASM) program ${program}, which the local EVM can't run, reached from inside another contract`);
  // The amounts are the node's reads, before and after: all of the account's 1,000 USDC, swept.
  assert.deepEqual(moved(r), [[program, USER, sweeper, 1000_000_000n]]);
  assert.ok(r.readAssets?.includes('native') && r.readAssets.includes(program), String(r.readAssets));
  // One frame, the node's, saying why and which program; no state changes (the node doesn't say).
  assert.equal(r.trace?.to, sweeper);
  assert.equal(r.trace?.calls, undefined);
  assert.equal(r.trace?.node, `run by the chain's node, for the Stylus (WASM) program ${program}, which the local EVM can't run, reached from inside another contract: its outcome, return data, events and gas are the node's; the calls it made aren't known, so its events are all listed here`);
  assert.equal(r.stateChanges, undefined);
  // The node ran the call alone in its block (among the reads around it); the probe a block later, the caller's code
  // taken away.
  assert.equal(ask[0].calls.filter(c => c.data === sweepAll).length, 1);
  assert.deepEqual(ask[1].stateOverrides?.[sweeper], { code: '0x' });
  // Was refused before: "...is a Stylus (WASM) contract, which the local EVM can't run: the transaction reaches it
  // from inside another contract".
});

test('Arbitrum: what a call did before it reached a Stylus program is not kept: the node runs it whole, and the calls before it stay the local EVM’s', async () => {
  clearForkCaches();
  // A contract that writes its storage and emits an event, then calls the program (with no calldata, which the
  // program refuses: the call goes on).
  const writer = '0x00000000000000000000000000000000000057e1';
  await arb.putCode(writer, callsProgram('600160005560006000a0'));
  const batch = [{ from: USER, to: dai, data: call('transfer', [BOB, 5n]) }, { from: USER, to: writer, data: '0x' as Hex }];
  const sim = arbFork({ trace: true });
  const out = (await sim.simulateBatch(batch.map(r => ({ ...arbReq(r), trace: true }))))!;
  const own = await nodeOwn(batch);
  assert.match(out[0].source, /^local EVM/);
  assert.deepEqual(moved(out[0]), [[dai, USER, dai, 5n]]);
  agrees(out[1], own[1]);
  // One event (the writer's): not a second from the local run that stopped at the program. No state changes.
  assert.equal(out[1].logs?.length, 1);
  assert.equal(out[1].stateChanges, undefined);
  assert.ok(out[0].stateChanges?.some(s => s.address === dai));
  // The storage steps recorded are the first call's only: none of the second's local run.
  assert.ok(sim.last!.trace!.length > 0 && sim.last!.trace!.every(s => s.call === 0), JSON.stringify(sim.last!.trace!.map(s => s.call)));
  // The node ran the first call before it.
  const ask = lastAsked(c => c.to === writer);
  assert.deepEqual(ask[0].calls.filter(c => c.to === dai || c.to === writer).map(c => c.to), [dai, writer]);
});

test('Arbitrum: the calls after a Stylus one in a batch run on the node after it, on the state it left', async () => {
  clearForkCaches();
  // A call made straight to the program, then one that reaches it inside, then a plain EVM token's.
  const batch = [{ from: USER, to: program, data: call('transfer', [BOB, 100_000_000n]) }, { from: USER, to: sweeper, data: sweepAll }, { from: USER, to: dai, data: call('transfer', [BOB, 5n]) }];
  const out = (await arbFork().simulateBatch(batch.map(arbReq)))!;
  const own = await nodeOwn(batch);
  out.forEach((r, i) => agrees(r, own[i]));
  assert.equal(out[0].source, "chain 42161's node, for a Stylus (WASM) program the local EVM can't run");
  for (const r of out.slice(1)) assert.equal(r.source, `chain 42161's node, after call 1 of the batch, which is made straight to the Stylus (WASM) program ${program} (the local EVM can't run it, so hasn't the state the calls after it run on)`);
  // The sweep takes what the first call left: 900 USDC.
  assert.deepEqual(out.map(moved), [[[program, USER, program, 100_000_000n]], [[program, USER, sweeper, 900_000_000n]], [[dai, USER, dai, 5n]]]);
  // Each ran with the calls before it, in order.
  const last = lastAsked(c => c.to === dai);
  assert.deepEqual(last[0].calls.filter(c => [program, sweeper, dai].includes(c.to!) && c.data!.length > 10).map(c => c.to), [program, sweeper, dai]);
  // A local call first: it stays the local EVM's, and the node runs it before the one that reaches the program.
  clearForkCaches();
  const mixed = [batch[2], batch[1], batch[2]];
  const got = (await arbFork().simulateBatch(mixed.map(arbReq)))!;
  const theirs = await nodeOwn(mixed);
  assert.match(got[0].source, /^local EVM/);
  agrees(got[1], theirs[1]);
  agrees(got[2], theirs[2]);
  assert.match(got[1].source, /reached from inside another contract$/);
  assert.match(got[2].source, new RegExp(`after call 2 of the batch, which reaches the Stylus \\(WASM\\) program ${program}`));
  assert.deepEqual(got.map(moved), [[[dai, USER, dai, 5n]], [[program, USER, sweeper, 1000_000_000n]], [[dai, USER, dai, 5n]]]);
});

test('Arbitrum: a Stylus program reached on a value the run guessed is not taken for reached: the value is read first', async () => {
  // A contract that calls whatever address its slot 0 holds. The speculative rounds guess a slot not read yet from
  // the last value seen of it (shared by all simulations).
  const caller = '0x00000000000000000000000000000000ca11e400';
  await arb.putCode(caller, '0x600060006000600060006000545af15000');
  const holds = (a: string) => arb.evm.stateManager.putStorage(createAddressFromString(caller), setLengthLeft(hexToBytes('0x00'), 32), hexToBytes(a as Hex));
  const req = arbReq({ from: USER, to: caller, data: '0x' });
  // (No tokens watched: a read of the contract's balanceOf ahead of the rounds would read the slot first.)
  clearForkCaches();
  await holds(dai);
  assert.match((await arbFork({ watchTokens: false }).simulate(req))!.source, /^local EVM/);
  // Now the program: the first round guesses DAI, and runs; the next reads the slot, and reaches the program.
  await holds(program);
  const to = arbFork({ watchTokens: false });
  assert.match((await to.simulate(req))!.source, /^chain 42161's node, for the Stylus/);
  assert.ok(to.last!.rounds >= 2, `${to.last!.rounds} rounds`);
  // And back: the first round guesses the program and reaches it, which isn't an answer; the next reads DAI and runs.
  await holds(dai);
  const sim = arbFork({ watchTokens: false });
  const back = (await sim.simulate(req))!;
  assert.match(back.source, /^local EVM/);
  assert.ok(sim.last!.rounds >= 2, `${sim.last!.rounds} rounds`);
});

test('Arbitrum: an EIP-7702 authorization the wallet has yet to sign stands in on the node as its code, its gas a stand-in’s', async () => {
  clearForkCaches();
  const delegate = '0x00000000000000000000000000000000de1e9a7e';
  await arb.putCode(delegate, callsProgram());
  const req: SimulationRequest = { ...arbReq({ from: USER, to: USER, data: '0x' }), unsignedAuthorizations: [{ address: delegate, chainId: 42161 }], stateOverrides: { [USER]: { code: `0xef0100${delegate.slice(2)}` } } };
  const [r] = (await arbFork().simulateBatch([req]))!;
  assert.match(r.source, /reached from inside another contract$/);
  const [block] = simulated.at(-1)!;
  assert.equal(block.stateOverrides?.[USER]?.code, `0xef0100${delegate.slice(2)}`);
  const own = block.calls.find(c => c.to === USER)!;
  assert.deepEqual(own.authorizationList?.map(a => a.address), ['0x0000000000000000000000000000000000000000']);
  assert.ok(Object.values(block.stateOverrides ?? {}).some(o => o.balance === '0x1' && o.nonce === '0x0' && o.code === '0x'));
});

test('Arbitrum: an earlier call its sender can’t pay for is left out of the node’s calls, as it is out of the local run', async () => {
  clearForkCaches();
  const out = (await arbFork().simulateBatch([arbReq({ from: USER, to: BOB, data: '0x', value: 10n ** 30n }), arbReq({ from: USER, to: sweeper, data: sweepAll })]))!;
  assert.match(out[0].revertReason ?? '', /^insufficient funds: the account holds/);
  assert.equal(out[1].status, 'success');
  assert.ok(!simulated.at(-1)![0].calls.some(c => c.to === BOB && BigInt(c.value ?? '0x0') > 0n));
});

test('Arbitrum: a replay that reaches a Stylus program inside runs on the node after its block’s earlier transactions', async () => {
  clearForkCaches();
  const earlier = { from: USER, to: program, data: call('transfer', [BOB, 1_000_000n]) }, own = { from: USER, to: sweeper, data: sweepAll };
  const header = { number: 16n, arbBlockNumber: 17n, timestamp: 0x65000001n, coinbase: '0xa4b000000000000000000073657175656e636572', prevRandao: `0x${'00'.repeat(31)}01` as Hex, gasLimit: 30_000_000n, baseFeePerGas: 0n };
  const at = { block: 'latest', header, before: [arbReq(earlier)] };
  const [r] = (await arbFork().simulateBatch([{ ...arbReq(own), at }]))!;
  agrees(r, (await nodeOwn([earlier, own]))[1]);
  assert.deepEqual(moved(r), [[program, USER, sweeper, 999_000_000n]]);
  // Its block's earlier transaction first, then the replayed one.
  const ask = lastAsked(c => c.to === sweeper);
  assert.deepEqual(ask[0].calls.filter(c => c.to === program || c.to === sweeper).map(c => c.to), [program, sweeper]);
});

test('Arbitrum: where the node can’t be handed the call, it is refused, saying why: no eth_simulateV1, or a creation', async () => {
  clearForkCaches();
  const without = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if ((Array.isArray(body) ? body : [body]).some((r: { method: string }) => r.method === 'eth_simulateV1')) return new Response(JSON.stringify((Array.isArray(body) ? body : [body]).map((r: { id: number }) => ({ jsonrpc: '2.0', id: r.id, error: { code: -32601, message: 'the method eth_simulateV1 does not exist/is not available' } }))));
    return arbFetch(url, init);
  }) as typeof fetch;
  await assert.rejects(new ForkSimulator({ 42161: ARB_URL }, { fetchImpl: without, prefetch: false }).simulate(arbReq({ from: USER, to: sweeper, data: sweepAll })),
    (e: Error) => e instanceof ForkUnsupported && e.message === `the call is one the chain's node must run (for the Stylus (WASM) program ${program}, which the local EVM can't run, reached from inside another contract), and the node has no eth_simulateV1 to run it`);
  // A creation whose code reaches the program: the node's charge for its L1 data can't be told apart from its gas.
  clearForkCaches();
  await assert.rejects(arbFork().simulate(arbReq({ from: USER, data: callsProgram() })),
    (e: Error) => e instanceof ForkUnsupported && /^the transaction creates a contract whose code reaches the Stylus \(WASM\) program 0x[0-9a-f]{40}, which the local EVM can't run: the chain's node could run it, but its charge for a creation's L1 data can't be told apart/.test(e.message));
});

test('Arbitrum: a UserOperation’s run that reaches a Stylus program goes to the node with its stand-ins, and says what it read', async () => {
  // As src/erc4337-sim.ts asks it: from the bundler, for the account, its EntryPoint watched (whose balanceOf is the
  // account's deposit), ecrecover's stand-in code with the precompile moved. Here the "EntryPoint" is the sweeper,
  // and DAI stands for the deposit's token.
  clearForkCaches();
  const bundler = '0xb0d1e70000000000000000000000000000004337', moved = '0x0000000000000000000000000000000000c0ffee';
  const req: SimulationRequest = { ...arbReq({ from: bundler, to: sweeper, data: sweepAll }), account: USER, watch: [dai],
    stateOverrides: { '0x0000000000000000000000000000000000000001': { code: '0x00', movePrecompileToAddress: moved } } };
  const [r] = (await arbFork().simulateBatch([req]))!;
  assert.match(r.source, /reached from inside another contract$/);
  const [block] = simulated.at(-1)!;
  assert.deepEqual(block.stateOverrides?.['0x0000000000000000000000000000000000000001'], { code: '0x00', movePrecompileToAddress: moved });
  // The account's native coin and DAI were read before and after (readAssets: withoutGas counts the account's coin
  // from them, with its deposit).
  assert.ok(r.readAssets?.includes('native') && r.readAssets.includes(dai), String(r.readAssets));
});

test('Arbitrum: the reads around a call the node runs are one call on each side, however many tokens are watched', async () => {
  // Arbitrum One's public node answers an eth_simulateV1 of more than 30 calls with HTTP 429, every time (2026-11-16):
  // read as calls of their own, a call with twelve tokens watched took 2 × 13 + 1 of them and was never run.
  clearForkCaches();
  const others = Array.from({ length: 10 }, (_, i) => `0x${(0xe0a0e0 + i).toString(16).padStart(40, '0')}`);
  const req: SimulationRequest = { ...arbReq({ from: USER, to: sweeper, data: sweepAll }), watch: [program, dai, ...others] };
  const [r] = (await arbFork({ watchTokens: false }).simulateBatch([req]))!;
  const [block] = simulated.at(-1)!;
  // One call for the native balance and the twelve views, before; the call; the same after.
  assert.equal(block.calls.length, 3, JSON.stringify(block.calls.map(c => c.to)));
  agrees(r, (await nodeOwn([{ from: USER, to: sweeper, data: sweepAll }]))[0]);
  // The amounts are still the node's reads: all of USER's 1,000 USDC (the program, read through the reader), DAI read
  // and unmoved, the addresses with no code not read.
  assert.deepEqual(moved(r), [[program, USER, sweeper, 1000_000_000n]]);
  assert.deepEqual(r.readAssets, ['native', program, dai]);
});

test('Arbitrum: an approval a call the node runs sets is read back through the reader, after the call', async () => {
  clearForkCaches();
  // USER approves BOB on the program, a call made straight to it: an approval by name (the mock token emits no
  // Approval event), read back after the call, through the reader with the token's balance.
  const req: SimulationRequest = { ...arbReq({ from: USER, to: program, data: call('approve', [BOB, 77n]) }), watch: [program] };
  const [r] = (await arbFork({ watchTokens: false }).simulateBatch([req]))!;
  assert.equal(r.status, 'success');
  assert.deepEqual(r.approvalState?.map(a => [a.token, a.owner, a.spender, a.amount]), [[program, USER, BOB, 77n]]);
  // Asked again with the approval read after the call: the reader on each side, still.
  const [block] = simulated.at(-1)!;
  assert.equal(block.calls.length, 3, JSON.stringify(block.calls.map(c => c.to)));
});

test('Arbitrum: RpcSimulator\'s reads around each call go in one reader call, as static calls, and read what calls of their own did', async () => {
  // Arbitrum One's public node answers an eth_simulateV1 of more than 30 calls with HTTP 429, every time: read as calls
  // of their own (three a token for one call), a call that named twelve tokens took 51 and lost its reads (2026-11-16).
  clearForkCaches();
  const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
  // Multicall3's getEthBalance(address): CALLDATALOAD(4) BALANCE, returned.
  const getEthBalance = { [MULTICALL3]: { code: '0x6004353160005260206000f3' as Hex } };
  const others = Array.from({ length: 10 }, (_, i) => `0x${(0xe0a0f0 + i).toString(16).padStart(40, '0')}`);
  const batch = (chainId: number): SimulationRequest[] => [
    { chainId, from: USER, to: dai, data: call('transfer', [BOB, 5n]), value: 0n, watch: [dai, program, ...others], stateOverrides: getEthBalance },
    { chainId, from: USER, to: BOB, data: '0x', value: E / 4n, stateOverrides: getEthBalance },
  ];
  const sizes: number[] = [];
  const counting = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    for (const r of Array.isArray(body) ? body : [body]) if (r.method === 'eth_simulateV1') sizes.push(r.params[0].blockStateCalls.reduce((n: number, b: { calls: unknown[] }) => n + b.calls.length, 0));
    return arbFetch(url, init);
  }) as typeof fetch;
  // The same batch on another chain, whose reads are calls of their own, and on Arbitrum One.
  const plain = (await new RpcSimulator({ 1: ARB_URL }, { fetchImpl: counting }).simulateBatch(batch(1)))!;
  const plainSize = sizes.at(-1)!;
  const packed = (await new RpcSimulator({ 42161: ARB_URL }, { fetchImpl: counting }).simulateBatch(batch(42161)))!;
  // Five calls: the reads, each call, the reads after it.
  assert.equal(sizes.at(-1), 5);
  assert.ok(plainSize > 30, String(plainSize));
  const view = (r: SimulationResult) => [r.status, r.balancesRead, r.readAssets, moved(r), r.stateReadError];
  assert.deepEqual(packed.map(view), plain.map(view));
  // What they read: DAI moved, the program (a token here) read and unmoved, the native coin sent.
  assert.deepEqual(packed.map(moved), [[[dai, USER, dai, 5n]], [['native', USER, BOB, E / 4n]]]);
  assert.deepEqual(packed[0].readAssets, [dai, program, 'native']);
});

test('Arbitrum: a call to a proxy whose implementation is a Stylus program says it reaches the program from inside another contract, though a read of the proxy reached it first', async () => {
  // The call's target is watched, so the run reads its balanceOf before the call, and that read is what first reaches
  // the program (as live on Arbitrum One, 2026-11-16). It is reached from inside another contract all the same.
  clearForkCaches();
  const proxy = '0x00000000000000000000000000000000000d1e60';
  // CALLDATACOPY the calldata; DELEGATECALL the program with it; return or revert with what came back.
  await arb.putCode(proxy, `0x366000600037600060003660007${'3'}${program.slice(2)}5af43d600060003e6031573d6000fd5b3d6000f3` as Hex);
  const [r] = (await arbFork().simulateBatch([arbReq({ from: USER, to: proxy, data: call('approve', [BOB, 5n]) })]))!;
  assert.equal(r.status, 'success');
  assert.equal(r.source, `chain 42161's node, for the Stylus (WASM) program ${program}, which the local EVM can't run, reached from inside another contract (first by a read of a balance or a permission around the call)`);
});

test('Arbitrum: the node’s reads around a call it runs are static, as the local EVM’s are: a contract read as a token changes nothing the call runs on', async () => {
  clearForkCaches();
  // A contract that pays USER 1 DAI of its own the first time it is called (slot 0 records it), and, called with no
  // calldata, calls the program first. It is the call's target, so it is read around the call as a token
  // (balanceOf): a read that ran as a call would pay instead, and the call would find it paid.
  //   CALLDATASIZE ISZERO PUSH1 0x08 JUMPI PUSH1 0x2b JUMP JUMPDEST <CALL(gas, program, 0, 0, 0, 0, 0)> POP
  //   JUMPDEST PUSH1 0 SLOAD PUSH1 0xa6 JUMPI PUSH1 1 PUSH1 0 SSTORE <CALL(gas, dai, 0, transfer(USER, 1))> POP JUMPDEST STOP
  const once = '0x00000000000000000000000000000000017e0001', word = (a: string) => a.slice(2).padStart(64, '0');
  await arb.putCode(once, `0x36156008576${'0'}2b565b600060006000600060007${'3'}${program.slice(2)}5af1505b600054${'60a6'}576001600055` +
    `7fa9059cbb${'00'.repeat(28)}6000527f${word(USER)}6004526001602452600060006044600060007${'3'}${dai.slice(2)}5af1505b00` as Hex);
  await arb.exec(dai, call('mint', [once, 100n]));
  const req = { from: USER, to: once, data: '0x' as Hex };
  const [r] = (await arbFork().simulateBatch([{ ...arbReq(req), watch: [dai] }]))!;
  assert.match(r.source, /reached from inside another contract$/);
  // The node's own run of the call: it pays, and USER's DAI goes up by 1.
  agrees(r, (await nodeOwn([req]))[0]);
  assert.equal(r.logs?.length, 1);
  assert.deepEqual(moved(r), [[dai, once, USER, 1n]]);
  // Each read went through a reader, as a static call.
  const [block] = simulated.at(-1)!;
  assert.ok(!block.calls.some(c => c.to === once && c.data !== '0x'), JSON.stringify(block.calls.map(c => c.to)));
});

test('Arbitrum: a read around a call that reaches a Stylus program hands the call to the node, and the calls after it say so', async () => {
  clearForkCaches();
  // A "token" that forwards whatever it is asked to the program: its balanceOf, read around the call, reaches it.
  const wrapper = '0x00000000000000000000000000000000a11a0001';
  await arb.putCode(wrapper, `0x3660006000376000600036600060007${'3'}${program.slice(2)}5af1503d600060003e3d6000f3` as Hex);
  const batch = [{ from: USER, to: dai, data: call('transfer', [BOB, 5n]) }, { from: USER, to: BOB, data: '0x' as Hex, value: E }];
  const out = (await arbFork().simulateBatch(batch.map(r => ({ ...arbReq(r), watch: [wrapper] }))))!;
  const own = await nodeOwn(batch);
  out.forEach((r, i) => agrees(r, own[i]));
  assert.equal(out[0].source, `chain 42161's node, for the Stylus (WASM) program ${program}, which the local EVM can't run, reached by a read around the call (a balance or a permission)`);
  // Not "which reaches": call 1 itself doesn't.
  assert.equal(out[1].source, `chain 42161's node, after call 1 of the batch, a read around which reaches the Stylus (WASM) program ${program} (the local EVM can't run it, so hasn't the state the calls after it run on)`);
  assert.deepEqual(out.map(moved), [[[dai, USER, dai, 5n]], [['native', USER, BOB, E]]]);
  assert.ok(out[0].readAssets?.includes(wrapper), String(out[0].readAssets));
});

test('Arbitrum: across the hand-over, an approval made before it is read after each node-run call, and native coin sent after it is the node’s', async () => {
  clearForkCaches();
  const batch = [{ from: USER, to: dai, data: call('approve', [sweeper, 7n]) }, { from: USER, to: sweeper, data: sweepAll }, { from: USER, to: BOB, data: '0x' as Hex, value: E }];
  const out = (await arbFork().simulateBatch(batch.map(arbReq)))!;
  const own = await nodeOwn(batch);
  out.forEach((r, i) => agrees(r, own[i]));
  assert.match(out[0].source, /^local EVM/);
  assert.deepEqual(out.map(moved), [[], [[program, USER, sweeper, 1000_000_000n]], [['native', USER, BOB, E]]]);
  for (const r of out) assert.deepEqual(r.approvalState?.map(a => [a.token, a.spender, (a as { amount?: bigint }).amount]), [[dai, sweeper, 7n]]);
});

test('Arbitrum: a program first reached by a read after a call that ran here without reaching it is said to be reached by that read, not by the call', async () => {
  // A proxy with no implementation until a call with no calldata sets one (slot 0): its balanceOf answers 0 before
  // the call and delegates to the program after it. Neither the read before the call nor the call reaches the
  // program here; the reads after it do. (Read before the call, the proxy would have been taken for the way the call
  // goes, as above.)
  //   CALLDATASIZE ISZERO PUSH1 0x48 JUMPI PUSH1 0 SLOAD ISZERO PUSH1 0x42 JUMPI <CALLDATACOPY; DELEGATECALL the program;
  //   return or revert with what came back> 0x42: JUMPDEST PUSH1 0x20 PUSH1 0 RETURN 0x48: JUMPDEST PUSH1 1 PUSH1 0 SSTORE STOP
  clearForkCaches();
  const proxy = '0x00000000000000000000000000000000000d1e61';
  await arb.putCode(proxy, `0x36156048576000541560425736600060003760006000366000${'73'}${program.slice(2)}5af43d600060003e603d573d6000fd5b3d6000f35b60206000f35b600160005500` as Hex);
  const batch = [{ from: USER, to: proxy, data: '0x' as Hex }, { from: USER, to: BOB, data: '0x' as Hex, value: E }];
  const out = (await arbFork().simulateBatch(batch.map(arbReq)))!;
  const own = await nodeOwn(batch);
  out.forEach((r, i) => agrees(r, own[i]));
  assert.equal(out[0].source, `chain 42161's node, for the Stylus (WASM) program ${program}, which the local EVM can't run, reached by a read around the call (a balance or a permission)`);
  assert.equal(out[1].source, `chain 42161's node, after call 1 of the batch, a read around which reaches the Stylus (WASM) program ${program} (the local EVM can't run it, so hasn't the state the calls after it run on)`);
  assert.deepEqual(out.map(moved), [[], [['native', USER, BOB, E]]]);
});
