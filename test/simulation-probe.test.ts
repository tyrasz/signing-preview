// The HyperEVM simulator end to end: previewRequest -> RpcSimulator -> SimulationProbe's real bytecode, run in an
// in-process EVM behind a fake JSON-RPC node that, like HyperEVM's, has eth_call with state overrides but no
// eth_simulateV1. The contracts are test/fixtures/SimulationMocks.sol, compiled here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createEVM } from '@ethereumjs/evm';
import { Account, bytesToHex, createAddressFromString, hexToBytes } from '@ethereumjs/util';
import { encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, serializeSignature, toHex, type Hex } from 'viem';
import { privateKeyToAccount, sign } from 'viem/accounts';
import { previewRequest } from '../src/preview.ts';
import { PERMIT2, StaticTokenRegistry } from '../src/chains.ts';
import { RpcSimulator } from '../src/simulation.ts';
import { calldataCandidates } from '../src/simulation-probe.ts';
import type { Dependencies, Preview } from '../src/types.ts';
import { codes, NOW } from './helpers.ts';

const solc = createRequire(import.meta.url)('solc');
const KEY = '0x5555555555555555555555555555555555555555555555555555555555555555' as const;
const USER = privateKeyToAccount(KEY).address.toLowerCase();
const OTHER_KEY = '0x6666666666666666666666666666666666666666666666666666666666666666' as const;
const BOB = '0xb0b0000000000000000000000000000000000002', DEPLOYER = '0xde9100000000000000000000000000000000d001';
const E = 10n ** 18n, MAX = (1n << 256n) - 1n, MAX160 = (1n << 160n) - 1n;

// --- an EVM, the mock contracts, and a JSON-RPC node in front of them --------------------------------------------
const out = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { 'M.sol': { content: readFileSync(new URL('./fixtures/SimulationMocks.sol', import.meta.url), 'utf8') } },
  settings: { evmVersion: 'paris', optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } } })));
for (const e of out.errors ?? []) if (e.severity === 'error') throw new Error(e.formattedMessage);
const C = (name: string) => out.contracts['M.sol'][name] as { abi: unknown[]; evm: { bytecode: { object: string }; deployedBytecode: { object: string } } };

const evm = await createEVM();
const sm = evm.stateManager;
const at = (a: string) => createAddressFromString(a);
async function setBalance(a: string, balance: bigint) {
  const acct = (await sm.getAccount(at(a))) ?? new Account();
  acct.balance = balance;
  await sm.putAccount(at(a), acct);
}
async function deploy(name: string, types = '', args: unknown[] = []): Promise<string> {
  const ctor = types ? encodeAbiParameters(types.split(',').map(type => ({ type })), args).slice(2) : '';
  const res = await evm.runCall({ caller: at(DEPLOYER), origin: at(DEPLOYER), data: hexToBytes(`0x${C(name).evm.bytecode.object}${ctor}`), gasLimit: 10_000_000n });
  if (res.execResult.exceptionError || !res.createdAddress) throw new Error(`deploy ${name}: ${res.execResult.exceptionError?.error}`);
  return res.createdAddress.toString().toLowerCase();
}
async function exec(to: string, data: Hex, from = DEPLOYER, value = 0n) {
  const res = await evm.runCall({ caller: at(from), origin: at(from), to: at(to), data: hexToBytes(data), value, gasLimit: 10_000_000n });
  if (res.execResult.exceptionError) throw new Error(`setup call failed: ${res.execResult.exceptionError.error}`);
}

const requests: { method: string; overrides: boolean }[] = [];
const json = (body: object) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }));
/** eth_call with state overrides (code, balance) against the EVM's state, rolled back afterwards; no eth_simulateV1. */
const fetchImpl = (async (_url: string, init: RequestInit) => {
  const { method, params } = JSON.parse(String(init.body));
  requests.push({ method, overrides: !!params?.[2] });
  if (method !== 'eth_call') return json({ error: { code: -32601, message: 'Method not found' } });
  const [tx, , overrides] = params as [{ from: string; to: string; data: string; value?: string; gas?: string }, string, Record<string, { code?: Hex; balance?: Hex }> | undefined];
  await sm.checkpoint();
  try {
    for (const [a, o] of Object.entries(overrides ?? {})) {
      if (o.balance) await setBalance(a, BigInt(o.balance));
      if (o.code) await sm.putCode(at(a), hexToBytes(o.code));
    }
    const value = BigInt(tx.value ?? 0), balance = (await sm.getAccount(at(tx.from)))?.balance ?? 0n;
    if (value > balance) return json({ error: { code: -32000, message: `insufficient funds for gas * price + value: have ${balance} want ${value}` } });
    const res = await evm.runCall({ caller: at(tx.from), origin: at(tx.from), to: at(tx.to), data: hexToBytes(tx.data as Hex), value, gasLimit: BigInt(tx.gas ?? 30_000_000) });
    const ret = bytesToHex(res.execResult.returnValue);
    return json(res.execResult.exceptionError ? { error: { code: 3, message: 'execution reverted', data: ret } } : { result: ret });
  } finally {
    await sm.revert();
  }
}) as typeof fetch;

const usdc = await deploy('Token', 'string,uint8', ['USDC', 6]);
const hUsdc = await deploy('Token', 'string,uint8', ['hUSDC', 6]);
const weth = await deploy('Token', 'string,uint8', ['WHYPE', 18]);
const vault = await deploy('Vault', 'address', [usdc]);
const pool = await deploy('Pool', 'address,address', [usdc, hUsdc]);
const nft = await deploy('NFT');
const router = await deploy('Router');
const eoaOnly = await deploy('EoaOnly', 'address', [usdc]);
const reverter = await deploy('Reverter');
await sm.putCode(at(PERMIT2), hexToBytes(`0x${C('Permit2Like').evm.deployedBytecode.object}`)); // at the canonical address
const T = parseAbi([
  'function mint(address,uint256)', 'function transfer(address,uint256)', 'function approve(address,uint256)', 'function withdraw(uint256)', 'function deposit(uint256)',
  'function supply(uint256)', 'function buy(uint256)', 'function safeTransferFrom(address,address,uint256)', 'function setApprovalForAll(address,bool)',
  'function permitSelf(address,uint160,uint48,bytes)', 'function claim()', 'function fail()',
]);
const call = (fn: string, args: unknown[] = []) => encodeFunctionData({ abi: T, functionName: fn, args } as never);
await exec(usdc, call('mint', [USER, 1000_000_000n]));
await exec(weth, call('mint', [USER, 2n * E]));
await setBalance(weth, 2n * E); // the native HYPE behind the minted WHYPE
await exec(nft, call('mint', [USER, 7n]));
await setBalance(USER, 10n * E);

const tokens = new StaticTokenRegistry({ 999: [
  { address: usdc, symbol: 'USDC', decimals: 6, name: 'USD Coin' }, { address: hUsdc, symbol: 'hUSDC', decimals: 6, name: 'HyperLend USDC' },
  { address: weth, symbol: 'WHYPE', decimals: 18, name: 'Wrapped HYPE' }, { address: vault, symbol: 'vUSD', decimals: 6, name: 'Vault USD' },
] });
const simulator = new RpcSimulator({ 999: 'http://hyperevm.invalid' }, { fetchImpl });
const deps: Dependencies = { tokens, simulator };
const send = (to: string, data: Hex, value = 0n) =>
  previewRequest({ method: 'eth_sendTransaction', params: [{ from: USER, to, data, value: toHex(value), chainId: '0x3e7' }] }, { now: NOW }, deps);
const changes = (p: Preview) => p.assetChanges.map(c => [c.direction, c.amount, c.symbol, c.basis]);
const permitSig = async (key: Hex, token: string, spender: string, amount: bigint, expiration: number) =>
  serializeSignature(await sign({ hash: keccak256(encodeAbiParameters(parseAbi(['function f(address,address,address,uint160,uint48)'])[0].inputs, [USER as Hex, token as Hex, spender as Hex, amount, expiration])), privateKey: key }));

// --- tests ---------------------------------------------------------------------------------------------------
test('Balance changes are read from state: an ERC-20 transfer, and unwrapping (native HYPE received leaves no log)', async () => {
  const p = await send(usdc, call('transfer', [BOB, 50_000_000n]));
  assert.equal(p.simulation?.status, 'success');
  assert.match(p.simulation!.source, /state-override probe @ chain 999/);
  assert.deepEqual(changes(p), [['out', '50', 'USDC', 'simulated_state']]);
  assert.ok(p.decoding.notes.some(n => /running the transaction from your address in an eth_call.*Balance changes were read for \d+ tokens?:/.test(n)), p.decoding.notes.join(' | '));
  assert.ok(Number(p.simulation!.gasUsed) > 21_000);
  const unwrap = await send(weth, call('withdraw', [E]));
  assert.deepEqual(changes(unwrap).sort(), [['in', '1', 'HYPE', 'simulated_state'], ['out', '1', 'WHYPE', 'simulated_state']]);
  assert.equal(requests.filter(r => r.method === 'eth_simulateV1').length, 1, 'eth_simulateV1 was asked once, then skipped');
});

test('Approvals: a direct approve is listed; a Permit2 allowance recorded along the way is flagged; a bad signature fails', async () => {
  const direct = await send(usdc, call('approve', [BOB, MAX]));
  assert.deepEqual(direct.approvals?.map(a => [a.kind, a.spender, a.allowance, a.direct, a.basis]), [['erc20', BOB, 'unlimited', true, 'simulated_state']]);
  assert.ok(!codes(direct).includes('hidden_unlimited_approval'));
  // The router asks Permit2, which asks the account (it has code during the simulation): ERC-1271, answered with
  // ecrecover as the account's key would.
  const exp = Math.floor(NOW / 1000) + 30 * 86400;
  const along = await send(router, call('permitSelf', [usdc, MAX160, exp, await permitSig(KEY, usdc, router, MAX160, exp)]));
  assert.equal(along.simulation?.status, 'success');
  assert.deepEqual(along.approvals?.map(a => [a.kind, a.spender, a.allowance, a.direct, a.expiration]), [['permit2', router, 'unlimited', false, exp]]);
  assert.match(along.warnings.find(w => w.code === 'hidden_unlimited_approval')!.message, /through Permit2 until 20/);
  const forged = await send(router, call('permitSelf', [usdc, MAX160, exp, await permitSig(OTHER_KEY, usdc, router, MAX160, exp)]));
  assert.equal(forged.simulation?.status, 'reverted');
  assert.equal(forged.simulation?.revertReason, '1271');
});

test('Batches run in order: approve then deposit; a token the calldata never names shows once a decoder watches it', async () => {
  const batch = (calls: { to: string; data: Hex }[]) => previewRequest({ method: 'wallet_sendCalls', params: [{ version: '2.0.0', chainId: '0x3e7', from: USER, atomicRequired: true, calls }] }, { now: NOW }, deps);
  const ok = await batch([{ to: usdc, data: call('approve', [vault, 100_000_000n]) }, { to: vault, data: call('deposit', [100_000_000n]) }]);
  assert.equal(ok.simulation?.status, 'success');
  assert.match(ok.simulation!.source, /2 calls in order/);
  assert.deepEqual(changes(ok).sort(), [['in', '100', 'vUSD', 'simulated_state'], ['out', '100', 'USDC', 'simulated_state']]);
  // The deposit used the approval up: none is left in place (as the log-based simulator reports it too).
  assert.deepEqual(ok.approvals?.map(a => [a.kind, a.spender, a.allowance, a.direct]), [['erc20', vault, 'none', true]]);
  const unapproved = await batch([{ to: vault, data: call('deposit', [100_000_000n]) }, { to: usdc, data: call('transfer', [BOB, 1n]) }]);
  assert.equal(unapproved.simulation?.status, 'reverted');
  assert.equal(unapproved.simulation?.revertReason, 'call 1: allowance');
  assert.ok(codes(unapproved).includes('batch_will_fail'));

  // Pool.supply mints hUSDC, which its calldata doesn't mention: seen only when watched (HyperLend's decoder
  // watches its hTokens and debt tokens).
  const reqs = (watch?: string[]) => [
    { chainId: 999, from: USER, to: usdc, data: call('approve', [pool, 5_000_000n]), value: 0n },
    { chainId: 999, from: USER, to: pool, data: call('supply', [5_000_000n]), value: 0n, ...(watch && { watch }) },
  ];
  const net = (r: Awaited<ReturnType<typeof simulator.simulateBatch>>) => Object.fromEntries(r![1].transfers.map(t => [t.asset, t.from === USER ? -t.raw : t.raw]));
  assert.deepEqual(net(await simulator.simulateBatch(reqs())), { [usdc]: -5_000_000n });
  assert.deepEqual(net(await simulator.simulateBatch(reqs([hUsdc]))), { [usdc]: -5_000_000n, [hUsdc]: 5_000_000n });
});

test('NFTs: a safe-minted purchase, a transfer out by token ID, and an operator approval', async () => {
  const bought = await send(nft, call('buy', [42n]), E);
  assert.equal(bought.simulation?.status, 'success', bought.simulation?.revertReason);
  assert.deepEqual(bought.assetChanges.map(c => [c.direction, c.standard, c.tokenId ?? c.amount, c.basis]).sort(), [['in', 'erc721', '42', 'simulated_state'], ['out', 'native', '1', 'simulated_state']]);
  const sent = await send(nft, call('safeTransferFrom', [USER, BOB, 7n]));
  assert.deepEqual(sent.assetChanges.map(c => [c.direction, c.standard, c.tokenId]), [['out', 'erc721', '7']]);
  const operator = await send(nft, call('setApprovalForAll', [BOB, true]));
  assert.deepEqual(operator.approvals?.map(a => [a.kind, a.spender, a.allowance, a.direct]), [['operator', BOB, 'all NFTs in the collection', true]]);
});

test('Failures: revert reasons, insufficient funds, and a contract that refuses senders with code', async () => {
  const fail = await send(reverter, call('fail'));
  assert.equal(fail.simulation?.status, 'reverted');
  assert.equal(fail.simulation?.revertReason, 'nope');
  assert.ok(codes(fail).includes('simulation_reverted'));
  const broke = await send(BOB, '0x', 100n * E);
  assert.equal(broke.simulation?.status, 'reverted');
  assert.equal(broke.simulation?.revertReason, 'insufficient funds: the account holds 10 HYPE and the call sends 100 HYPE');
  // Under the probe the sender has code, so EoaOnly refuses it; a plain eth_call shows the claim works.
  const claim = await send(eoaOnly, call('claim'));
  assert.equal(claim.simulation?.status, 'success');
  assert.ok(claim.decoding.notes.some(n => /refuses senders with code/.test(n)));
  assert.deepEqual(claim.assetChanges, []);
});

test('Candidate tokens come from calldata words, nested calldata and packed v3 paths', () => {
  const tokenA = '0xaf88d065e77c8cc2239327c5edb3a432268e5831', tokenB = '0x82af49447d8a07e3bd95bd0d56f35241523fbab1';
  const path = `${tokenA}${'0001f4'}${tokenB.slice(2)}` as Hex;
  const inner = encodeFunctionData({ abi: parseAbi(['function swap(bytes path, address to, uint256 id)']), args: [path, '0x1111111111111111111111111111111111111111', 42n] });
  const outer = encodeFunctionData({ abi: parseAbi(['function multicall(bytes[])']), args: [[inner]] });
  const c = calldataCandidates(outer);
  for (const a of [tokenA, tokenB, '0x1111111111111111111111111111111111111111']) assert.ok(c.addresses.includes(a), a);
  assert.ok(c.ids.includes(42n));
});

test('When the probe call itself fails (e.g. the node runs out of gas), the call is still checked with eth_call', async () => {
  const seen: boolean[] = [];
  const failing = (async (_u: string, init: RequestInit) => {
    const { method, params } = JSON.parse(String(init.body));
    if (method !== 'eth_call') return json({ error: { code: -32601, message: 'Method not found' } });
    seen.push(!!params[2]);
    return json(params[2] ? { error: { code: -32000, message: 'out of gas' } } : { result: '0x' });
  }) as typeof fetch;
  const sim = new RpcSimulator({ 999: 'http://hyperevm.invalid' }, { fetchImpl: failing });
  const r = await sim.simulate({ chainId: 999, from: USER, to: usdc, data: call('transfer', [BOB, 1n]), value: 0n });
  assert.deepEqual([r?.status, r?.limited], ['success', true]);
  // The probe stays in use for the next call: one failure doesn't mean the RPC lacks state overrides.
  await sim.simulate({ chainId: 999, from: USER, to: usdc, data: call('transfer', [BOB, 2n]), value: 0n });
  assert.deepEqual(seen, [true, false, true, false]);
});
