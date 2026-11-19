// A whole ERC-4337 operation simulated end to end: EntryPointSimulations in place of EntryPoint v0.7's code, run by
// the fork simulator on test/evm-chain.ts (a node without eth_simulateV1), with ecrecover standing in for the owner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { concatHex, encodeFunctionData, numberToHex, parseAbi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { previewRequest } from '../src/preview.ts';
import { StaticTokenRegistry } from '../src/chains.ts';
import { RpcSimulator } from '../src/simulation.ts';
import { JsonRpcClient } from '../src/rpc.ts';
import { ForkSimulator } from '../src/fork-simulator.ts';
import { ENTRY_POINT_SIMULATIONS_V06, ENTRY_POINT_SIMULATIONS_V07, ENTRY_POINT_SIMULATIONS_V08, ENTRY_POINT_SIMULATIONS_V09 } from '../src/entrypoint-simulations.ts';
import { readOperation, userOpHash } from '../src/userop-hash.ts';
import type { Dependencies, Preview, SimulationRequest, SimulationResult } from '../src/types.ts';
import { codes, detail, NOW } from './helpers.ts';
import { testChain } from './evm-chain.ts';

const EP = '0x0000000071727de22e5e9d8baf0edac6f37da032', EP6 = '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789';
const OWNER = privateKeyToAccount('0x7777777777777777777777777777777777777777777777777777777777777777').address.toLowerCase();
const BOB = '0xb0b0000000000000000000000000000000000002';
const URL_ = 'http://hyperevm.invalid';
const E = 10n ** 18n;

const chain = await testChain();
const usdc = await chain.deploy('Token', 'string,uint8', ['USDC', 6]);
const account = await chain.deploy('Account4337', 'address,address', [OWNER, EP]);
const paymaster = await chain.deploy('TokenPaymaster', 'address,address', [EP, usdc]);
const broke = await chain.deploy('TokenPaymaster', 'address,address', [EP, usdc]);
const account6 = await chain.deploy('Account4337V06', 'address,address', [OWNER, EP6]);
// EntryPoint v0.8 and v0.9 take the same packed operation as v0.7, signed as EIP-712 typed data.
const EP8 = '0x4337084d9e255ff0702461cf8895ce9e3b5ff108', EP9 = '0x433709009b8330fda32311df1c2afa402ed8d009';
const account8 = await chain.deploy('Account4337', 'address,address', [OWNER, EP8]);
const account9 = await chain.deploy('Account4337', 'address,address', [OWNER, EP9]);
// The EntryPoint's storage is what matters (deposits, nonces): its code here is the simulation's own, which has depositTo.
await chain.putCode(EP, ENTRY_POINT_SIMULATIONS_V07 as Hex);
const A = parseAbi(['function mint(address,uint256)', 'function approve(address,uint256)', 'function transfer(address,uint256)', 'function depositTo(address)', 'function execute(address,uint256,bytes)']);
const call = (fn: string, args: unknown[]) => encodeFunctionData({ abi: A, functionName: fn, args } as never);
await chain.exec(usdc, call('mint', [account, 100_000_000n]));
await chain.exec(usdc, call('mint', [account6, 100_000_000n]));
for (const [a, ep, code] of [[account8, EP8, ENTRY_POINT_SIMULATIONS_V08], [account9, EP9, ENTRY_POINT_SIMULATIONS_V09]] as const) {
  await chain.exec(usdc, call('mint', [a, 100_000_000n]));
  await chain.setBalance(a, E);
  await chain.putCode(ep, code as Hex);
}
await chain.setBalance(account6, E);
await chain.putCode(EP6, ENTRY_POINT_SIMULATIONS_V06 as Hex);
await chain.exec(usdc, call('approve', [paymaster, (1n << 256n) - 1n]), account);
await chain.setBalance(account, E);
await chain.setBalance('0xde9100000000000000000000000000000000d001', 10n * E);
await chain.exec(EP, call('depositTo', [paymaster]), '0xde9100000000000000000000000000000000d001', E);

const deps: Dependencies = {
  tokens: new StaticTokenRegistry({ 999: [{ address: usdc, symbol: 'USDC', decimals: 6, name: 'USD Coin' }] }),
  rpc: new JsonRpcClient({ 999: URL_ }, { fetchImpl: chain.fetchImpl }),
  simulator: new RpcSimulator({ 999: URL_ }, { fetchImpl: chain.fetchImpl, fork: new ForkSimulator({ 999: URL_ }, { fetchImpl: chain.fetchImpl }) }),
};
const word = (v: bigint) => numberToHex(v, { size: 16 });
const sendUsdc = call('execute', [usdc, 0n, call('transfer', [BOB, 50_000_000n])]);
const operation = (m: Record<string, unknown> = {}) => ({ sender: account, nonce: '0x0', callData: sendUsdc, callGasLimit: '0x30d40', verificationGasLimit: '0x30d40', preVerificationGas: '0xc350', maxFeePerGas: '0x77359400', maxPriorityFeePerGas: '0x3b9aca00', ...m });
const withPaymaster = (pm: string) => ({ paymaster: pm, paymasterVerificationGasLimit: '0x186a0', paymasterPostOpGasLimit: '0x186a0', paymasterData: '0x' });
async function preview(op: Record<string, unknown>, signer = OWNER, version: '0.6' | '0.7' = '0.7'): Promise<Preview> {
  const ep = version === '0.6' ? EP6 : EP;
  const hash = userOpHash(readOperation(op, version)!, ep, 999, version);
  return previewRequest({ method: 'personal_sign', params: [hash, signer] }, { now: NOW, chainId: 999, userOperation: { entryPoint: ep, operation: op } }, deps);
}
const usdcChange = (p: Preview) => p.assetChanges.filter(c => c.symbol === 'USDC').map(c => `${c.direction} ${c.amount}`);

test('A whole operation: validated as the owner will sign it, its calls run, and the gas it pays (the prefund set aside)', async () => {
  const p = await preview(operation());
  assert.deepEqual(usdcChange(p), ['out 50']);
  assert.ok(!p.assetChanges.some(c => c.symbol === 'HYPE' || c.asset === 'native'), 'the gas prefund is gas, not a balance change');
  const paid = BigInt(String(p.details.find(d => d.label === 'Gas cost (simulated)')?.raw));
  // At 1 gwei (the base fee is 0, the priority fee 1 gwei): the gas used, at least the 50,000 of pre-verification.
  assert.ok(paid > 50_000n * 10n ** 9n && paid < 450_000n * 10n ** 9n, String(paid));
  assert.match(String(detail(p, 'Gas cost (simulated)')), /paid by the account/);
  // The gas the EntryPoint counts for it, which the cost is the price of.
  const used = BigInt(String(p.details.find(d => d.label === 'Gas used (simulated)')?.raw));
  assert.ok(used > 50_000n && used < 500_000n, String(used));
  assert.equal(paid % used, 0n);
  assert.ok(p.decoding.notes.some(n => /whole operation was simulated as EntryPoint v0\.7 runs it/.test(n) && /attributes it to the signer\)/.test(n)), p.decoding.notes.join(' | '));
  assert.ok(!codes(p).includes('userop_execution_reverts'));
});

test('A token paymaster: its validation and its charge after the calls are simulated, and the charge is in the balance changes', async () => {
  const p = await preview(operation(withPaymaster(paymaster)));
  const paid = BigInt(String(p.details.find(d => d.label === 'Gas cost (simulated)')?.raw));
  assert.match(String(detail(p, 'Gas cost (simulated)')), /paid by the paymaster/);
  // postOp charges for the gas used before it runs (its own comes after): a little under the final cost's rate.
  const fee = Number(/^([\d.]+) USDC, from the account \(included in the balance changes\)$/.exec(String(detail(p, 'Paymaster charge')))?.[1]);
  assert.ok(fee > 0 && fee * 1e6 <= Number(paid / 10n ** 9n + 1n), `${fee} ${paid}`);
  assert.deepEqual(usdcChange(p), [`out ${(50_000_000 + Math.round(fee * 1e6)) / 1e6}`]);
});

test('A signer the account doesn’t accept, failing calls, and a paymaster that can’t pay: what bundlers and the EntryPoint would do', async () => {
  // Someone who isn't the owner: the account reports a failed signature, which the simulation notes and runs past.
  const stranger = await preview(operation(), BOB);
  assert.ok(stranger.decoding.notes.some(n => /doesn't accept it as theirs/.test(n)), `${stranger.decoding.notes.join(' | ')} ${codes(stranger)}`);
  // Calls that fail: the operation is still included and pays for its gas.
  const failing = await preview(operation({ callData: call('execute', [usdc, 0n, call('transfer', [BOB, 500_000_000n])]) }));
  assert.ok(codes(failing).includes('userop_execution_reverts'));
  assert.match(failing.warnings.find(w => w.code === 'userop_execution_reverts')!.message, /: balance\. It can still be included, and the account pays 0\.\d+ HYPE for the gas\./);
  // A paymaster without an EntryPoint deposit: the EntryPoint rejects the operation (AA31).
  const unfunded = await preview(operation(withPaymaster(broke)));
  assert.match(unfunded.warnings.find(w => w.code === 'userop_rejected')?.message ?? '', /the paymaster's EntryPoint deposit can't cover the gas \(AA31 paymaster deposit too low\)/);
  // A nonce ahead of the account's: it waits for the operations before it (noted), which isn't a rejection.
  const ahead = await preview(operation({ nonce: '0x5' }));
  assert.ok(!codes(ahead).includes('userop_rejected'), codes(ahead).join());
  assert.ok(ahead.decoding.notes.some(n => /5 other operations of this account must run before this one/.test(n)));
});

test('A paymaster that only pays for its own bundler: the operation runs as a bundler its recent operations came through', async () => {
  const ALLOWED = '0xb0d1e70000000000000000000000000000004337';
  const picky = await chain.deploy('BundlerPaymaster', 'address,address', [EP, ALLOWED]);
  await chain.exec(EP, call('depositTo', [picky]), '0xde9100000000000000000000000000000000d001', E);
  const op = operation(withPaymaster(picky));
  const hash = userOpHash(readOperation(op, '0.7')!, EP, 999, '0.7');
  const run = (d: Dependencies) => previewRequest({ method: 'personal_sign', params: [hash, OWNER] }, { now: NOW, chainId: 999, userOperation: { entryPoint: EP, operation: op } }, d);
  // This node has no logs to look in: the simulation's own address sends it, which the paymaster refuses.
  const refused = await run(deps);
  assert.match(refused.warnings.find(w => w.code === 'userop_rejected')?.message ?? '', /AA33/);
  // A node with the paymaster's latest UserOperationEvent, in a bundle ALLOWED sent.
  const lookups: unknown[] = [];
  const rpc = { has: (c: number) => deps.rpc!.has(c), call: async (c: number, m: string, ps: unknown[]) => {
    if (m === 'eth_blockNumber') return '0x100';
    if (m === 'eth_getLogs') { lookups.push(ps[0]); return [{ transactionHash: `0x${'ab'.repeat(32)}` }]; }
    if (m === 'eth_getTransactionByHash') return { from: ALLOWED, input: '0x' };
    return deps.rpc!.call(c, m, ps);
  } } as Dependencies['rpc'];
  const accepted = await run({ ...deps, rpc });
  assert.ok(!codes(accepted).includes('userop_rejected'), codes(accepted).join());
  assert.ok(accepted.decoding.notes.some(n => /whole operation was simulated as EntryPoint v0\.7 runs it/.test(n)), accepted.decoding.notes.join(' | '));
  assert.deepEqual(usdcChange(accepted), ['out 50']);
  // The lookup is the paymaster's UserOperationEvents, by its indexed address, and it is remembered.
  assert.equal((lookups[0] as { topics: string[] }).topics[3], `0x${'00'.repeat(12)}${picky.slice(2)}`);
  await run({ ...deps, rpc });
  assert.equal(lookups.length, 1);
});

test('A quiet paymaster that only pays for its own bundlers: its last bundles are looked for as far back as the node answers', async () => {
  const ALLOWED = '0xb0d1e70000000000000000000000000000014337', HEAD = 1_000_000;
  // Each node: the paymaster's last operation `last` blocks back; `refuse` gives the node's answer to a window it won't
  // read (from and to, blocks back from the head), if any. Returns the windows asked, as [newest, oldest] blocks back.
  const lookup = async (last: number, refuse: (newest: number, oldest: number) => Error | undefined) => {
    const picky = await chain.deploy('BundlerPaymaster', 'address,address', [EP, ALLOWED]);
    await chain.exec(EP, call('depositTo', [picky]), '0xde9100000000000000000000000000000000d001', E);
    const op = operation(withPaymaster(picky));
    const hash = userOpHash(readOperation(op, '0.7')!, EP, 999, '0.7');
    const windows: [number, number][] = [];
    const rpc = { has: (c: number) => deps.rpc!.has(c), call: async (c: number, m: string, ps: any[]) => {
      if (m === 'eth_blockNumber') return numberToHex(HEAD);
      if (m === 'eth_getLogs') {
        const newest = HEAD - Number(BigInt(ps[0].toBlock)), oldest = HEAD - Number(BigInt(ps[0].fromBlock));
        windows.push([newest, oldest]);
        const e = refuse(newest, oldest);
        if (e) throw e;
        return newest <= last && last <= oldest ? [{ transactionHash: `0x${'cd'.repeat(32)}` }] : [];
      }
      if (m === 'eth_getTransactionByHash') return { from: ALLOWED, input: '0x' };
      return deps.rpc!.call(c, m, ps);
    } } as Dependencies['rpc'];
    const p = await previewRequest({ method: 'personal_sign', params: [hash, OWNER] }, { now: NOW, chainId: 999, userOperation: { entryPoint: EP, operation: op } }, { ...deps, rpc });
    return { p, windows };
  };
  const ran = (p: Preview) => !codes(p).includes('userop_rejected') && p.decoding.notes.some(n => /whole operation was simulated as EntryPoint v0\.7 runs it/.test(n));
  // A node that answers any window (Base's, up to 50,000 blocks), the paymaster's last operation 74,000 blocks back:
  // found in the older windows of 20,000, each just before the last.
  const base = await lookup(74_000, () => undefined);
  assert.ok(ran(base.p), base.p.warnings.map(w => w.message).join(' | '));
  assert.deepEqual(base.windows, [[0, 200], [0, 2000], [0, 10_000], [0, 20_000], [20_000, 40_000], [40_000, 60_000], [60_000, 80_000]]);
  // Ethereum's public node: 10,000 blocks back and no further (HTTP 403, "Archive requests require a personal token").
  const archive = (newest: number, oldest: number) => (oldest > 10_000 ? new Error('eth_getLogs: HTTP 403') : undefined);
  const eth = await lookup(6_137, archive);
  assert.ok(ran(eth.p), eth.p.warnings.map(w => w.message).join(' | '));
  assert.deepEqual(eth.windows, [[0, 200], [0, 2000], [0, 10_000]]);
  // Further back than it answers: the 20,000 refused (asked again once), and no older window asked after it.
  const beyond = await lookup(15_000, archive);
  assert.match(beyond.p.warnings.find(w => w.code === 'userop_rejected')?.message ?? '', /AA33/);
  assert.ok(beyond.windows.every(([, oldest]) => oldest <= 20_000), JSON.stringify(beyond.windows));
  // A node that caps a query at 10,000 blocks, naming it (Polygon's): the older windows within the cap, none read twice.
  const capped = (newest: number, oldest: number) => (oldest - newest > 10_000 ? Object.assign(new Error('capped'), { rpcError: { message: 'exceed maximum block range: 10000' } }) : undefined);
  const polygon = await lookup(25_000, capped);
  assert.ok(ran(polygon.p), polygon.p.warnings.map(w => w.message).join(' | '));
  assert.deepEqual(polygon.windows, [[0, 200], [0, 2000], [0, 10_000], [0, 20_000], [10_000, 20_000], [20_000, 30_000]]);
});

// A factory whose accounts only deploy for its own bundler (BundlerFactory, as OKX Wallet's on Ethereum), one for each
// case (what a lookup finds is remembered by factory): the account it deploys, and a preview of the operation.
const ACCOUNT_DEPLOYED = '0xd51a9c61267aa6196961883ecf5ff2da6619c37dac0fa92122513fb32c032d2d';
const ELSEWHERE = '0xb0d1e70000000000000000000000000000034337';
const factoryData = encodeFunctionData({ abi: parseAbi(['function createAccount(address owner, uint256 salt)']), functionName: 'createAccount', args: [OWNER as Hex, 5n] });
async function bundlerFactory(allowed: string) {
  const { compiled } = await import('./evm-chain.ts');
  const { encodeAbiParameters, getContractAddress } = await import('viem');
  // The SenderCreator (the EntryPoint's first creation) calls the factory, as on-chain.
  await chain.putCode(getContractAddress({ from: EP as Hex, nonce: 1n }), `0x${compiled('SenderCreatorLike').evm.deployedBytecode.object}`);
  const factory = await chain.deploy('BundlerFactory', 'address,address', [EP, allowed]);
  const fresh = getContractAddress({ opcode: 'CREATE2', from: factory as Hex, salt: numberToHex(5n, { size: 32 }),
    bytecode: concatHex([`0x${compiled('Account4337').evm.bytecode.object}`, encodeAbiParameters([{ type: 'address' }, { type: 'address' }], [OWNER as Hex, EP as Hex])]) }).toLowerCase();
  await chain.exec(usdc, call('mint', [fresh, 100_000_000n]));
  await chain.setBalance(fresh, E);
  const op = operation({ sender: fresh, factory, factoryData, verificationGasLimit: '0xf4240' });
  const hash = userOpHash(readOperation(op, '0.7')!, EP, 999, '0.7');
  const run = (d: Dependencies) => previewRequest({ method: 'personal_sign', params: [hash, OWNER] }, { now: NOW, chainId: 999, userOperation: { entryPoint: EP, operation: op } }, d);
  return { factory, fresh, run };
}
/**
 * A node with recent deployments at `head`: `senders` sent this factory's, one each, and ELSEWHERE another factory's
 * (whose logs are skipped). Its log reads (and their windows, as [newest, oldest] blocks back) and the transactions
 * it was asked for.
 */
function deploymentsNode(factory: string, senders: string[], head = 0x100) {
  const lookups: any[] = [], windows: [number, number][] = [], fetched: string[] = [];
  const word = (a: string) => `0x${'00'.repeat(12)}${a.slice(2)}`;
  const rpc = { has: (c: number) => deps.rpc!.has(c), call: async (c: number, m: string, ps: any[]) => {
    if (m === 'eth_blockNumber') return numberToHex(head);
    if (m === 'eth_getLogs') {
      lookups.push(ps[0]);
      windows.push([head - Number(BigInt(ps[0].toBlock)), head - Number(BigInt(ps[0].fromBlock))]);
      return ps[0].topics[0] === ACCOUNT_DEPLOYED ? [{ transactionHash: `0x${'0e'.repeat(32)}`, data: `${word(ELSEWHERE)}${'00'.repeat(32)}` },
        ...senders.map((_, i) => ({ transactionHash: `0x${(i + 1).toString(16).padStart(64, '0')}`, data: `${word(factory)}${'00'.repeat(32)}` }))] : [];
    }
    if (m === 'eth_getTransactionByHash') { fetched.push(ps[0]); return { from: ps[0] === `0x${'0e'.repeat(32)}` ? ELSEWHERE : senders[Number(BigInt(ps[0])) - 1], input: '0x' }; }
    return deps.rpc!.call(c, m, ps);
  } } as Dependencies['rpc'];
  return { rpc, lookups, windows, fetched };
}
/** The test chain's simulator, answering no run sent by `failing` (null, as a node under load does), and who sent each run of an operation. */
function simulatorFailing(failing: string[] = []) {
  const real = deps.simulator!, sent: string[] = [];
  const fails = (rs: SimulationRequest[]) => {
    for (const r of rs) if (r.to && [EP, EP6, EP8, EP9].includes(r.to.toLowerCase())) sent.push(r.from.toLowerCase());
    return rs.some(r => failing.includes(r.from.toLowerCase()));
  };
  const simulator = { ...real, simulate: (r: SimulationRequest) => (fails([r]) ? Promise.resolve(null) : real.simulate(r)),
    simulateBatch: (rs: SimulationRequest[]) => (fails(rs) ? Promise.resolve(null) : real.simulateBatch!(rs)) } as unknown as Dependencies['simulator'];
  return { simulator, sent };
}
const rejectedOf = (p: Preview) => p.warnings.find(w => w.code === 'userop_rejected')?.message ?? '';

test('A factory whose accounts only deploy for its own bundler: the operation runs as a bundler its recent deployments came through', async () => {
  const { simulateExecution } = await import('../src/erc4337-sim.ts');
  const ALLOWED = '0xb0d1e70000000000000000000000000000024337', OTHER = '0xb0d1e70000000000000000000000000000044337', LATER = '0xb0d1e70000000000000000000000000000084337';
  const { factory, fresh, run } = await bundlerFactory(ALLOWED);
  // No deployments to look in: as the simulation's own bundler, deploying the account fails, and that stands.
  const alone = await run(deps);
  assert.match(rejectedOf(alone), /deploying the account fails \(AA13/);
  assert.doesNotMatch(rejectedOf(alone), /fails the same way/);
  // Its deployments came through ALLOWED: the operation runs as it, and the preview says so.
  const found = deploymentsNode(factory, [ALLOWED]);
  const accepted = await run({ ...deps, rpc: found.rpc });
  assert.equal(rejectedOf(accepted), '', codes(accepted).join());
  assert.ok(accepted.decoding.notes.some(n => /whole operation was simulated as EntryPoint v0\.7 runs it: deploying the account through its factory/.test(n)), accepted.decoding.notes.join(' | '));
  assert.ok(accepted.decoding.notes.some(n => n.startsWith(`Simulated as sent by ${ALLOWED}, a bundler that recently deployed accounts through this account's factory: sent by anyone else`) && /\(AA13 initCode failed or OOG/.test(n)), accepted.decoding.notes.join(' | '));
  assert.deepEqual(usdcChange(accepted), ['out 50']);
  // The lookup reads the EntryPoint's AccountDeployed logs (the factory isn't indexed) and keeps the factory's own.
  assert.deepEqual(found.lookups[0].topics, [ACCOUNT_DEPLOYED]);
  assert.ok(!found.fetched.includes(`0x${'0e'.repeat(32)}`), 'another factory’s deployment isn’t looked at');
  // Its deployments came only through bundlers it no longer takes: the rejection stands, and says so. The busiest
  // (OTHER, two deployments) is rejected exactly as anyone else is (the same revert data, for the same gas): the
  // failure doesn't turn on who sends it, so the other isn't run.
  const stale = await bundlerFactory(ALLOWED);
  const runs = simulatorFailing();
  const refused = await stale.run({ ...deps, rpc: deploymentsNode(stale.factory, [OTHER, LATER, OTHER]).rpc, simulator: runs.simulator });
  assert.match(rejectedOf(refused), /deploying the account fails \(AA13.*\)\. It fails the same way sent by the busiest of the 2 bundlers that recently deployed accounts through this account's factory\./);
  assert.deepEqual(runs.sent.filter(s => s === OTHER || s === LATER), [OTHER]);
  // A factory with no deployments: every deployment's log is read, so back 10,000 blocks and no further.
  const quiet = await bundlerFactory(ALLOWED);
  const far = deploymentsNode(quiet.factory, [], 1_000_000);
  assert.match(rejectedOf(await quiet.run({ ...deps, rpc: far.rpc })), /deploying the account fails \(AA13 initCode failed or OOG\)\. Nothing/);
  assert.deepEqual(far.windows, [[0, 200], [0, 2000], [0, 10_000]]);
  // Its calls alone deploy it as that bundler too (from it, through the SenderCreator's address), else deploying fails.
  const input = { chainId: 999, entryPoint: EP, sender: fresh, callData: sendUsdc, initCode: concatHex([factory as Hex, factoryData]) };
  assert.match((await simulateExecution(input, deps))?.result.revertReason ?? '', /deploying the account failed/);
  const deployed = await simulateExecution({ ...input, origin: ALLOWED }, deps);
  assert.equal(deployed?.result.status, 'success', deployed?.result.revertReason);
  assert.ok(deployed?.result.transfers.some(t => t.asset === usdc && t.from === fresh && t.raw === 50_000_000n), JSON.stringify(deployed?.result.transfers, (_, v) => (typeof v === 'bigint' ? `${v}` : v)));
});

test('A factory’s bundlers the node didn’t answer runs as aren’t said to fail: the rejection is the plain one, and a later preview runs as them', async () => {
  const ALLOWED = '0xb0d1e70000000000000000000000000000064337', B1 = '0xb0d1e70000000000000000000000000000074337';
  const plain = /deploying the account fails \(AA13 initCode failed or OOG\)\. Nothing it does happens unless that changes\.$/;
  // Every run as its bundlers fails on the node (null, as under load: HTTP 429): nothing is said of them.
  const down = await bundlerFactory(ALLOWED);
  const node = deploymentsNode(down.factory, [B1, ALLOWED]);
  assert.match(rejectedOf(await down.run({ ...deps, rpc: node.rpc, simulator: simulatorFailing([B1, ALLOWED]).simulator })), plain);
  // The node answering again, the next preview runs as ALLOWED (the bundlers found are remembered).
  const up = await down.run({ ...deps, rpc: node.rpc });
  assert.equal(rejectedOf(up), '', codes(up).join());
  assert.ok(up.decoding.notes.some(n => n.startsWith(`Simulated as sent by ${ALLOWED}`)), up.decoding.notes.join(' | '));
  // The run as the busiest (ALLOWED, the one it takes) not answered, the other's rejected: still the plain rejection.
  const partly = await bundlerFactory(ALLOWED);
  const runs = simulatorFailing([ALLOWED]);
  assert.match(rejectedOf(await partly.run({ ...deps, rpc: deploymentsNode(partly.factory, [B1, ALLOWED, ALLOWED]).rpc, simulator: runs.simulator })), plain);
  assert.deepEqual(runs.sent.filter(s => s === ALLOWED || s === B1), [ALLOWED, B1]);
});

test('An account whose validation only takes its own bundler: the operation runs as one its recent operations came through', async () => {
  const { compiled } = await import('./evm-chain.ts');
  const { executes } = await import('../src/erc4337-sim.ts');
  const ALLOWED = '0xb0d1e70000000000000000000000000000054337';
  const picky = await chain.deploy('BundlerAccount', 'address,address,address', [OWNER, EP, ALLOWED]);
  await chain.exec(usdc, call('mint', [picky, 100_000_000n]));
  await chain.setBalance(picky, E);
  const op = operation({ sender: picky });
  const hash = userOpHash(readOperation(op, '0.7')!, EP, 999, '0.7');
  const run = (d: Dependencies) => previewRequest({ method: 'personal_sign', params: [hash, OWNER] }, { now: NOW, chainId: 999, userOperation: { entryPoint: EP, operation: op } }, d);
  const lookups: any[] = [];
  const rpc = { has: (c: number) => deps.rpc!.has(c), call: async (c: number, m: string, ps: any[]) => {
    if (m === 'eth_blockNumber') return '0x100';
    if (m === 'eth_getLogs') { lookups.push(ps[0]); return ps[0].topics[2] === `0x${'00'.repeat(12)}${picky.slice(2)}` ? [{ transactionHash: `0x${'ac'.repeat(32)}`, data: '0x' }] : []; }
    if (m === 'eth_getTransactionByHash') return { from: ALLOWED, input: '0x' };
    return deps.rpc!.call(c, m, ps);
  } } as Dependencies['rpc'];
  // Without its operations to look in, validation reverts as any other bundler (only the calls are simulated).
  const alone = await run(deps);
  assert.ok(alone.decoding.notes.some(n => /validation reverts on a stand-in for the signature \(AA23/.test(n)), alone.decoding.notes.join(' | '));
  const accepted = await run({ ...deps, rpc });
  assert.ok(accepted.decoding.notes.some(n => n.startsWith(`Simulated as sent by ${ALLOWED}, a bundler that recently sent this account's operations: sent by anyone else (the transaction's origin), the account's validation reverts (AA23`)), accepted.decoding.notes.join(' | '));
  assert.ok(accepted.decoding.notes.some(n => /whole operation was simulated as EntryPoint v0\.7 runs it/.test(n) && !/doesn't accept/.test(n)), accepted.decoding.notes.join(' | '));
  assert.deepEqual(usdcChange(accepted), ['out 50']);
  // The lookup is the account's own UserOperationEvents, by its indexed address.
  assert.deepEqual(lookups[0].topics, ['0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f', null, `0x${'00'.repeat(12)}${picky.slice(2)}`]);
  // Only an account whose code reads tx.origin is looked up so: ORIGIN (0x32) as an instruction that can run, not as
  // PUSH data, in the compiler's metadata, or in bytes no instruction reaches (after one that ends execution, up to
  // the next JUMPDEST), where the compiler keeps its data.
  assert.equal(executes(`0x${compiled('BundlerAccount').evm.deployedBytecode.object}`, 0x32), true);
  assert.equal(executes(`0x${compiled('Account4337').evm.deployedBytecode.object}`, 0x32), false);
  assert.equal(executes('0x6032600055', 0x32), false); // PUSH1 0x32; PUSH1 0; SSTORE
  assert.equal(executes('0x60016000553200', 0x32), true); // ...; ORIGIN; STOP
  assert.equal(executes('0x600160005500a13232' + '0003', 0x32), false); // ...; STOP; then metadata (a1 32 32) and its length
  assert.equal(executes('0x600160005500a13232', 0x32), false); // the same bytes after STOP: nothing reaches them
  assert.equal(executes('0x600160005500a1325b32', 0x32), true); // ...but after a JUMPDEST, which a jump can reach
  assert.equal(executes('0x00615b3232', 0x32), false); // STOP; PUSH2 0x5b32 (no JUMPDEST: push data); then 0x32
  assert.equal(executes('0x60fe3200', 0x32), true); // PUSH1 0xfe (push data, not INVALID); ORIGIN
  // A Base account implementation's data after its code: "\x19Ethereum Signed Message:\n32", whose "32" is 0x33 0x32.
  assert.equal(executes(`0x6000600055fe${Buffer.from('\x19Ethereum Signed Message:\n32').toString('hex')}`, 0x32), false);
  assert.equal(executes('0x3200', 0x32), true);
});

test('An account that sends its own operations isn’t taken for its bundler: it isn’t run as sent by itself, with a bundler’s balance', async () => {
  // SelfAccount only validates what it sends itself (tx.origin): with 0.01 HYPE, its calls send 0.5.
  const self = await chain.deploy('SelfAccount', 'address,address', [OWNER, EP]);
  await chain.setBalance(self, E / 100n);
  const op = operation({ sender: self, callData: call('execute', [BOB, E / 2n, '0x']) });
  const hash = userOpHash(readOperation(op, '0.7')!, EP, 999, '0.7');
  // Its last operation came in a transaction it sent itself.
  const lookups: any[] = [];
  const rpc = { has: (c: number) => deps.rpc!.has(c), call: async (c: number, m: string, ps: any[]) => {
    if (m === 'eth_blockNumber') return '0x100';
    if (m === 'eth_getLogs') { lookups.push(ps[0]); return ps[0].topics[2] === `0x${'00'.repeat(12)}${self.slice(2)}` ? [{ transactionHash: `0x${'ad'.repeat(32)}`, data: '0x' }] : []; }
    if (m === 'eth_getTransactionByHash') return { from: self, input: '0x' };
    return deps.rpc!.call(c, m, ps);
  } } as Dependencies['rpc'];
  const runs = simulatorFailing();
  const p = await previewRequest({ method: 'personal_sign', params: [hash, OWNER] }, { now: NOW, chainId: 999, userOperation: { entryPoint: EP, operation: op } }, { ...deps, rpc, simulator: runs.simulator });
  // Its operations were looked up, and it was left out: run as itself, it validated on the bundler's balance (10^24
  // wei) and showed 0.5 HYPE sent, which it can't.
  assert.ok(lookups.some(l => l.topics[2] === `0x${'00'.repeat(12)}${self.slice(2)}`), JSON.stringify(lookups));
  assert.ok(!runs.sent.includes(self), runs.sent.join());
  assert.ok(!p.decoding.notes.some(n => n.startsWith('Simulated as sent by')), p.decoding.notes.join(' | '));
  assert.ok(p.decoding.notes.some(n => /validation reverts on a stand-in for the signature \(AA23/.test(n)), p.decoding.notes.join(' | '));
  assert.ok(codes(p).includes('userop_execution_reverts'), codes(p).join());
});

test('A paymaster whose recent operations the account sent itself: the account isn’t taken for the paymaster’s bundler either', async () => {
  // The account (0.01 HYPE; its calls send 0.5) sends its own operations, and its paymaster takes only bundles it
  // sends (tx.origin): the paymaster's latest operation came in a transaction the account sent.
  const self = await chain.deploy('Account4337', 'address,address', [OWNER, EP]);
  await chain.setBalance(self, E / 100n);
  const picky = await chain.deploy('BundlerPaymaster', 'address,address', [EP, self]);
  await chain.exec(EP, call('depositTo', [picky]), '0xde9100000000000000000000000000000000d001', E);
  const op = operation({ sender: self, callData: call('execute', [BOB, E / 2n, '0x']), ...withPaymaster(picky) });
  const hash = userOpHash(readOperation(op, '0.7')!, EP, 999, '0.7');
  const lookups: any[] = [];
  const rpc = { has: (c: number) => deps.rpc!.has(c), call: async (c: number, m: string, ps: any[]) => {
    if (m === 'eth_blockNumber') return '0x100';
    if (m === 'eth_getLogs') { lookups.push(ps[0]); return ps[0].topics[3] === `0x${'00'.repeat(12)}${picky.slice(2)}` ? [{ transactionHash: `0x${'ae'.repeat(32)}`, data: '0x' }] : []; }
    if (m === 'eth_getTransactionByHash') return { from: self, input: '0x' };
    return deps.rpc!.call(c, m, ps);
  } } as Dependencies['rpc'];
  const runs = simulatorFailing();
  const p = await previewRequest({ method: 'personal_sign', params: [hash, OWNER] }, { now: NOW, chainId: 999, userOperation: { entryPoint: EP, operation: op } }, { ...deps, rpc, simulator: runs.simulator });
  // The paymaster's operations were looked up, and the account left out: run as it, it validated and paid on the
  // bundler's balance (10^24 wei), and the paymaster, seeing its own bundler, took it.
  assert.ok(lookups.some(l => l.topics[3] === `0x${'00'.repeat(12)}${picky.slice(2)}`), JSON.stringify(lookups));
  assert.ok(!runs.sent.includes(self), runs.sent.join());
  assert.match(rejectedOf(p), /AA33/);
});

test('The operation runs at the price its bundle pays: a contract reading tx.gasprice sees the base fee plus the operation’s priority fee', async () => {
  const tips = await chain.deploy('TipReader', '', []);
  const T = parseAbi(['function requireTip(uint256 atLeast) view']);
  const needs = (tip: bigint) => operation({ callData: call('execute', [tips, 0n, encodeFunctionData({ abi: T, functionName: 'requireTip', args: [tip] })]) });
  // The operation pays a 1 gwei priority fee (up to 2 gwei in all): a contract wanting that much of a tip runs.
  assert.ok(!codes(await preview(needs(10n ** 9n))).includes('userop_execution_reverts'));
  // One wanting more doesn't: the simulation isn't run at the fee cap, or at no price at all.
  const more = await preview(needs(10n ** 9n + 1n));
  assert.match(more.warnings.find(w => w.code === 'userop_execution_reverts')?.message ?? '', /: tip\./);
});

test('EntryPoint v0.6: the patched EntryPoint returns its simulateHandleOp result, so the operation’s logs and gas are kept', async () => {
  const p = await preview(operation({ sender: account6, paymasterAndData: '0x' }), OWNER, '0.6');
  assert.deepEqual(usdcChange(p), ['out 50']);
  assert.ok(BigInt(String(p.details.find(d => d.label === 'Gas cost (simulated)')?.raw)) > 50_000n * 10n ** 9n);
  assert.ok(p.decoding.notes.some(n => /whole operation was simulated as EntryPoint v0\.6 runs it/.test(n)), p.decoding.notes.join(' | '));
  assert.ok(!p.decoding.notes.some(n => /doesn't accept it as theirs/.test(n)));
});

test('EntryPoint v0.8 and v0.9: typed-data operations run whole through their own simulation code', async () => {
  const types = { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
    PackedUserOperation: [{ name: 'sender', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'initCode', type: 'bytes' }, { name: 'callData', type: 'bytes' }, { name: 'accountGasLimits', type: 'bytes32' }, { name: 'preVerificationGas', type: 'uint256' }, { name: 'gasFees', type: 'bytes32' }, { name: 'paymasterAndData', type: 'bytes' }] };
  for (const [ep, account, name] of [[EP8, account8, 'v0.8'], [EP9, account9, 'v0.9']] as const) {
    const message = { sender: account, nonce: '0', initCode: '0x', callData: sendUsdc, accountGasLimits: concatHex([word(200_000n), word(200_000n)]), preVerificationGas: '50000', gasFees: concatHex([word(1_000_000_000n), word(2_000_000_000n)]), paymasterAndData: '0x' };
    const p = await previewRequest({ method: 'eth_signTypedData_v4', params: [OWNER, JSON.stringify({ domain: { name: 'ERC4337', version: '1', chainId: 999, verifyingContract: ep }, types, primaryType: 'PackedUserOperation', message })] }, { now: NOW }, deps);
    assert.deepEqual(usdcChange(p), ['out 50'], name);
    assert.ok(p.decoding.notes.some(n => new RegExp(`whole operation was simulated as EntryPoint ${name.replace('.', '\\.')} runs it`).test(n) && !/doesn't accept/.test(n)), p.decoding.notes.join(' | '));
    assert.ok(BigInt(String(p.details.find(d => d.label === 'Gas cost (simulated)')?.raw)) > 50_000n * 10n ** 9n, name);
  }
});

test('A typed operation validates with the wallet’s own stub when context.userOperation is the same operation', async () => {
  const owner = privateKeyToAccount('0x7777777777777777777777777777777777777777777777777777777777777777');
  const types = { PackedUserOperation: [{ name: 'sender', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'initCode', type: 'bytes' }, { name: 'callData', type: 'bytes' }, { name: 'accountGasLimits', type: 'bytes32' }, { name: 'preVerificationGas', type: 'uint256' }, { name: 'gasFees', type: 'bytes32' }, { name: 'paymasterAndData', type: 'bytes' }] };
  const domain = { name: 'ERC4337', version: '1', chainId: 999, verifyingContract: EP8 as Hex };
  const message = { sender: account8 as Hex, nonce: 0n, initCode: '0x' as Hex, callData: sendUsdc, accountGasLimits: concatHex([word(200_000n), word(200_000n)]), preVerificationGas: 50_000n, gasFees: concatHex([word(1_000_000_000n), word(2_000_000_000n)]), paymasterAndData: '0x' as Hex };
  // A signature that isn't the stand-in's goes to the real ecrecover: the owner's own here, so the account accepts it.
  const signature = await owner.signTypedData({ domain, types, primaryType: 'PackedUserOperation', message });
  const typed = JSON.stringify({ domain, types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }], ...types }, primaryType: 'PackedUserOperation',
    message: { ...message, nonce: '0', preVerificationGas: '50000' } });
  const run = (operation: Record<string, unknown>) => previewRequest({ method: 'eth_signTypedData_v4', params: [OWNER, typed] }, { now: NOW, userOperation: { entryPoint: EP8, operation } }, deps);
  const whole = (p: Preview) => p.decoding.notes.find(n => /whole operation was simulated/.test(n)) ?? p.decoding.notes.join(' | ');
  const stubbed = await run({ sender: account8, nonce: '0x0', callData: sendUsdc, signature });
  // (Signed by a key the account doesn't name, the stub is refused as it is; the stand-in in its form, for the signer
  // asked, is taken.)
  assert.match(whole(stubbed), /with a stand-in for the signature in the form of the wallet's own/);
  assert.deepEqual(usdcChange(stubbed), ['out 50']);
  // Another operation's (another nonce, or other calls): the wallet's stub isn't for this one, and the stand-in is used.
  for (const other of [{ sender: account8, nonce: '0x1', signature }, { sender: account8, nonce: '0x0', callData: '0x', signature }]) {
    assert.match(whole(await run(other)), /with a stand-in for the signature/, JSON.stringify(other));
  }
  // A stub with no ECDSA signature in it to put the stand-in in place of (the account reverts on it): the stand-in of
  // the account's own form, as with no stub at all, and the preview says the wallet's was refused.
  const odd = await run({ sender: account8, nonce: '0x0', callData: sendUsdc, signature: '0xdeadbeef' });
  assert.match(whole(odd), /with a stand-in for the signature in the account's own form, the wallet's stand-in signature refused, which doesn't exist until it's signed: ecrecover attributes it to the signer\)/);
  assert.deepEqual(usdcChange(odd), ['out 50']);
});

test('A passkey stand-in: a WebAuthn assertion over the operation hash, and a P256 verifier that accepts only it', async () => {
  const { webAuthnStub, p256Accepting, P256_STUB } = await import('../src/erc4337-sim.ts');
  const { decodeAbiParameters } = await import('viem');
  const { hexToBytes: toBytes, bytesToHex: toHex, createAddressFromString: at } = await import('@ethereumjs/util');
  const hash = `0x${'ab'.repeat(32)}` as Hex;
  const [auth] = decodeAbiParameters([{ type: 'tuple', components: [{ name: 'authenticatorData', type: 'bytes' }, { name: 'clientDataJSON', type: 'string' }, { name: 'challengeIndex', type: 'uint256' }, { name: 'typeIndex', type: 'uint256' }, { name: 'r', type: 'uint256' }, { name: 's', type: 'uint256' }] }], webAuthnStub(hash));
  const client = JSON.parse(auth.clientDataJSON);
  assert.equal(client.type, 'webauthn.get');
  assert.equal(`0x${Buffer.from(client.challenge, 'base64url').toString('hex')}`, hash); // the challenge is the hash, base64url
  assert.equal(auth.clientDataJSON.slice(Number(auth.challengeIndex), Number(auth.challengeIndex) + 11), '"challenge"');
  assert.equal(auth.clientDataJSON.slice(Number(auth.typeIndex), Number(auth.typeIndex) + 21), '"type":"webauthn.get"');
  assert.equal(auth.authenticatorData.length, 2 + 37 * 2);
  assert.equal(parseInt(auth.authenticatorData.slice(2 + 64, 2 + 66), 16) & 0x05, 0x05); // user present and verified
  assert.ok(auth.s <= 0x7fffffff800000007fffffffffffffffde737d56d38bcf4279dce5617e3192a8n); // low s
  // The verifier at 0x100 (no P256 precompile on this EVM): 1 for the stand-in, and nothing for anything else.
  await chain.putCode('0x0000000000000000000000000000000000000100', p256Accepting());
  const verify = async (r: Hex, s: Hex) => toHex((await chain.evm.runCall({ caller: at(OWNER), to: at('0x0000000000000000000000000000000000000100'), data: toBytes(concatHex([hash, r, s, `0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`])), gasLimit: 100_000n })).execResult.returnValue);
  assert.equal(BigInt(await verify(P256_STUB.r, P256_STUB.s)), 1n);
  assert.equal(await verify(P256_STUB.r, `0x${'26'.repeat(32)}`), '0x');
});

test('A Kernel passkey stand-in: ZeroDev’s WebAuthn validator form, and Daimo’s verifier answering it after running its own code', async () => {
  const { zeroDevWebAuthnStub, daimoAccepting, DAIMO_P256_VERIFIER, P256_STUB } = await import('../src/erc4337-sim.ts');
  const { decodeAbiParameters } = await import('viem');
  const { hexToBytes: toBytes, bytesToHex: toHex, createAddressFromString: at } = await import('@ethereumjs/util');
  const hash = `0x${'cd'.repeat(32)}` as Hex;
  for (const precompiled of [true, false]) {
    const [authenticatorData, clientDataJSON, responseTypeLocation, r, s, usePrecompiled] = decodeAbiParameters([{ type: 'bytes' }, { type: 'string' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bool' }], zeroDevWebAuthnStub(hash, precompiled));
    // Where ZeroDev's validator looks: the type at responseTypeLocation, the challenge (the hash, base64url) at 23.
    assert.equal(clientDataJSON.slice(Number(responseTypeLocation), Number(responseTypeLocation) + 21), '"type":"webauthn.get"');
    assert.equal(clientDataJSON.slice(23, 36), '"challenge":"');
    assert.equal(`0x${Buffer.from(JSON.parse(clientDataJSON).challenge, 'base64url').toString('hex')}`, hash);
    assert.equal(authenticatorData.length, 2 + 37 * 2);
    assert.equal(parseInt(authenticatorData.slice(2 + 64, 2 + 66), 16) & 0x1d, 0x05); // present and verified; no backup flags
    assert.deepEqual([r, s, usePrecompiled], [BigInt(P256_STUB.r), BigInt(P256_STUB.s), precompiled]);
  }
  // Daimo's verifier: its real code (here, one answering 0 to everything) runs first, at the address it moves to.
  const moved = '0x0000000000000000000000000000000000ec0da1';
  await chain.putCode(moved, '0x60006000526020' + '6000f3' as Hex); // mstore(0, 0); return(0, 32)
  await chain.putCode(DAIMO_P256_VERIFIER, daimoAccepting());
  const verify = async (r: Hex, s: Hex) => toHex((await chain.evm.runCall({ caller: at(OWNER), to: at(DAIMO_P256_VERIFIER), data: toBytes(concatHex([hash, r, s, `0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`])), gasLimit: 100_000n })).execResult.returnValue);
  assert.equal(BigInt(await verify(P256_STUB.r, P256_STUB.s)), 1n);
  assert.equal(BigInt(await verify(P256_STUB.r, `0x${'26'.repeat(32)}`)), 0n); // the real code's answer
});

test('A Kernel v3.1 passkey account: the stand-in passes ZeroDev’s own WebAuthn checks, through Daimo’s verifier', async () => {
  const { DAIMO_P256_VERIFIER } = await import('../src/erc4337-sim.ts');
  const { compiled } = await import('./evm-chain.ts');
  // Kernel v3.1's implementation address runs KernelPasskey (ZeroDev's validator checks, its WebAuthn.sol), behind
  // an ERC-1967 proxy as Kernel accounts are; its root validator is ZeroDev's WebAuthn validator.
  const KERNEL_V31 = '0xbac849bb641841b44e965fb01a4bf5f074f84b4d';
  await chain.putCode(KERNEL_V31, `0x${compiled('KernelPasskey').evm.deployedBytecode.object}`);
  const kernel = await chain.deploy('Proxy1967', 'address', [KERNEL_V31]);
  const key = { x: 0x65a2fa44daad46eab0278703edb6c4dcf5e30b8a9aec09fdc71a56f52aa392e4n, y: 0x4a7a9e4604aa36898209997288e902ac544a555e4b5e0a9efef2b59233f3f437n };
  await chain.exec(kernel, encodeFunctionData({ abi: parseAbi(['function init(address,uint256,uint256)']), functionName: 'init', args: [EP, key.x, key.y] }));
  await chain.exec(usdc, call('mint', [kernel, 100_000_000n]));
  await chain.setBalance(kernel, E);
  // Daimo's verifier on this chain (which has no P256 precompile, so ZeroDev's SDK signs for the verifier): here one
  // that accepts nothing. The stand-in runs it, then answers the stub.
  await chain.putCode(DAIMO_P256_VERIFIER, '0x600060005260206000f3' as Hex);
  // The account itself is asked to sign: a passkey wallet's way.
  const p = await preview(operation({ sender: kernel }), kernel);
  const whole = p.decoding.notes.find(n => /whole operation was simulated/.test(n)) ?? p.decoding.notes.join(' | ');
  assert.match(whole, /a passkey's assertion over the operation's hash/);
  assert.doesNotMatch(whole, /doesn't accept/);
  assert.deepEqual(usdcChange(p), ['out 50']);
});

test('Calls run alone on Kernel v3 (executeUserOp) run inside the execution hook their validation was installed with, which can refuse them', async () => {
  const { simulateExecution } = await import('../src/erc4337-sim.ts');
  const { compiled } = await import('./evm-chain.ts');
  const KERNEL_V33 = '0xd6cedde84be40893d153be9d467cd6ad37875b28';
  await chain.putCode(KERNEL_V33, `0x${compiled('KernelHooked').evm.deployedBytecode.object}`);
  const kernel = await chain.deploy('Proxy1967', 'address', [KERNEL_V33]);
  const MODULE = '0x00000000000000000000000000000000000d0d01';
  await chain.putCode(MODULE, '0x00' as Hex);
  const hook = await chain.deploy('RefusingHook', 'address', [MODULE]);
  const K = parseAbi(['function init(address,address,bytes21)', 'function install(bytes21,address)', 'function execute(address,uint256,bytes)']);
  await chain.exec(kernel, encodeFunctionData({ abi: K, functionName: 'init', args: [OWNER as Hex, EP, `0x01${'ec'.repeat(20)}`] }));
  // A permission (validation type 0x02, its id 0x4e48b87d) installed with the hook; the root with none.
  await chain.exec(kernel, encodeFunctionData({ abi: K, functionName: 'install', args: [`0x024e48b87d${'00'.repeat(16)}`, hook as Hex] }));
  const run = (nonce: bigint, to: string) => simulateExecution({ chainId: 999, entryPoint: EP, sender: kernel,
    callData: concatHex(['0x8dd7712f', encodeFunctionData({ abi: K, functionName: 'execute', args: [to as Hex, 0n, '0x'] })]),
    packed: { nonce, initCode: '0x', accountGasLimits: `0x${'00'.repeat(32)}`, preVerificationGas: 0n, gasFees: `0x${'00'.repeat(32)}`, paymasterAndData: '0x' }, userOpHash: `0x${'5a'.repeat(32)}` }, deps);
  const permission = BigInt(`0x00024e48b87d${'00'.repeat(16)}${'00'.repeat(10)}`);
  const refused = await run(permission, MODULE);
  assert.equal(refused?.result.status, 'reverted', 'the hook refuses the module call, as on-chain');
  assert.match(String(refused?.result.revertReason), /ModuleCallNotAllowed/);
  assert.equal((await run(permission, BOB))?.result.status, 'success', 'and lets other calls through');
  assert.equal((await run(0n, MODULE))?.result.status, 'success', 'the root has no hook');
  // A permission the nonce names that isn't installed (outside enable mode): Kernel refuses the operation, so its
  // calls fail too, rather than run as if it were.
  assert.equal((await run(BigInt(`0x0002deadbeef${'00'.repeat(26)}`), BOB))?.result.status, 'reverted');
});

test('A Kernel v3 account asked by a signer that isn’t its owner: the run that went through stands, not the 0xff form’s rejection', async () => {
  const { compiled } = await import('./evm-chain.ts');
  // Kernel v3.2's implementation address, whose stand-ins are the ECDSA one as it is and after 0xff; this account's
  // validator reverts on the 66-byte one, as Kernel's ECDSA validator does.
  const KERNEL_V32 = '0xd830d15d3dc0c269f3dbaa0f3e8626d33cfdabe1';
  await chain.putCode(KERNEL_V32, `0x${compiled('KernelHooked').evm.deployedBytecode.object}`);
  const kernel = await chain.deploy('Proxy1967', 'address', [KERNEL_V32]);
  await chain.exec(kernel, encodeFunctionData({ abi: parseAbi(['function init(address,address,bytes21)']), functionName: 'init', args: [OWNER as Hex, EP, `0x01${'ec'.repeat(20)}`] }));
  await chain.exec(usdc, call('mint', [kernel, 100_000_000n]));
  await chain.setBalance(kernel, E);
  const p = await preview(operation({ sender: kernel }), BOB);
  const whole = p.decoding.notes.find(n => /whole operation was simulated/.test(n)) ?? p.decoding.notes.join(' | ');
  assert.match(whole, /doesn't accept it as theirs/);
  assert.ok(!p.decoding.notes.some(n => /validation reverts on a stand-in/.test(n)), p.decoding.notes.join(' | '));
  assert.ok(detail(p, 'Gas cost (simulated)'), 'the whole operation’s gas is shown');
  assert.deepEqual(usdcChange(p), ['out 50']);
});

test('A whole operation whose balances the node didn’t read after it: its note says the amounts are the events’, with the node’s answer', async () => {
  const inner = deps.simulator!;
  // As RpcSimulator leaves a run whose reads a node rate-limited: amounts from its events, and why.
  const limited = (r: SimulationResult): SimulationResult => ({ ...r, basis: undefined, balancesRead: undefined, stateReadError: 'RPC HTTP 429: Too Many Requests' });
  const busy: Dependencies = { ...deps, simulator: { simulate: async q => { const r = await inner.simulate(q); return r && limited(r); }, simulateBatch: async qs => (await inner.simulateBatch!(qs))?.map(limited) ?? null } };
  const op = operation();
  const hash = userOpHash(readOperation(op, '0.7')!, EP, 999, '0.7');
  const p = await previewRequest({ method: 'personal_sign', params: [hash, OWNER] }, { now: NOW, chainId: 999, userOperation: { entryPoint: EP, operation: op } }, busy);
  const whole = p.decoding.notes.find(n => /whole operation was simulated/.test(n)) ?? p.decoding.notes.join(' | ');
  // (scripts/accuracy-4337.ts reads it so: such a run's amounts are reported, not judged.)
  assert.equal(/the balances couldn't be read after it: (.*)\); the final result/.exec(whole)?.[1], 'RPC HTTP 429: Too Many Requests');
  assert.deepEqual(usdcChange(p), ['out 50']);
});

test('A Kernel validator that keeps signers by id: a deploying account’s stand-in names the id of the signer asked, else the first', async () => {
  const { signerIdOf } = await import('../src/erc4337-sim.ts');
  const { encodeAbiParameters: enc } = await import('viem');
  const ROOT = '0x01933401632d92bc7005d7415242171a55e20004ba', MODULE = '0x9895a7b30a9dfcfbb1cd8f41595d2ad15fdcc9c3';
  const id = (b: string) => `0x${b.repeat(32)}` as Hex;
  const configs = enc([{ type: 'tuple[]', components: [{ name: 'id', type: 'bytes32' }, { name: 'signer', type: 'address' }, { name: 'data', type: 'bytes' }] }],
    [[{ id: id('11'), signer: MODULE, data: BOB }, { id: id('22'), signer: MODULE, data: OWNER as Hex }]]);
  const setup = { root: ROOT as Hex, installs: new Map<string, Hex>([[ROOT, configs]]) };
  const context = (signer: string) => ({ deps, chainId: 999, sender: BOB, signer, nonce: 0n, hash: async () => undefined }) as never;
  assert.equal(await signerIdOf(context(OWNER), ROOT, setup), id('22'));
  assert.equal(await signerIdOf(context('0x000000000000000000000000000000000000beef'), ROOT, setup), id('11'));
  // Install data it can't read: no id, so the plain ECDSA stand-in.
  assert.equal(await signerIdOf(context(OWNER), ROOT, { root: ROOT as Hex, installs: new Map([[ROOT, '0x1234' as Hex]]) }), undefined);
});

test('A Kernel validator that keeps signers by id: an existing account’s stand-in names the signer’s own id first, then its last operation’s', async () => {
  const { ownerSignerId, signerIdsOf } = await import('../src/erc4337-sim.ts');
  const { encodeFunctionData: enc, parseAbi: abi, concatHex: cat } = await import('viem');
  // A real SignerAdded event (Polygon, block 97,195,631): account 0x129f…2ff1, id 0xe51a…fae8, the ECDSA signer module, its owner.
  assert.equal(ownerSignerId('0x5832707543109d7a0ee8917ee13c86f80b0ae1b0'), '0xe51aa87b2bdc5cbd9485754bb0d5b3998c05b7f930376c49ed6efa95d848fae8');
  const ROOT = '0x01933401632d92bc7005d7415242171a55e20004ba', OWNER_ID = ownerSignerId(OWNER);
  const HANDLE = abi(['function handleOps((address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature)[] ops, address beneficiary)']);
  const zero = `0x${'00'.repeat(32)}` as Hex;
  // A node with no earlier operation of the account (older than the lookup reaches), or with one that named another id.
  const node = (sender: Hex, signature?: Hex) => ({ has: () => true, call: async (_: number, method: string) => {
    if (method === 'eth_getBlockByNumber') return { number: '0x30d41' };
    if (method === 'eth_getTransactionByHash') return { input: enc({ abi: HANDLE, functionName: 'handleOps', args: [[{ sender, nonce: 0n, initCode: '0x', callData: '0x', accountGasLimits: zero, preVerificationGas: 0n, gasFees: zero, paymasterAndData: '0x', signature: signature! }], BOB] }) };
    return signature ? [{ transactionHash: `0x${'78'.repeat(32)}` }] : [];
  } });
  const context = (sender: Hex, signature?: Hex, signer: string = OWNER) => ({ deps: { rpc: node(sender, signature) }, chainId: 137, sender, signer, nonce: 0n, entryPoint: EP, hash: async () => undefined }) as never;
  const none: Hex = '0x00000000000000000000000000000000005e1d11';
  assert.deepEqual(await signerIdsOf(context(none), ROOT), [OWNER_ID]);
  // Its last operation named the same id: once; another (a second owner's): after the signer's own.
  const same: Hex = '0x00000000000000000000000000000000005e1d12', other: Hex = '0x00000000000000000000000000000000005e1d13';
  assert.deepEqual(await signerIdsOf(context(same, cat([OWNER_ID, `0x${'ab'.repeat(65)}`])), ROOT), [OWNER_ID]);
  const second = `0x${'5f'.repeat(32)}` as Hex;
  assert.deepEqual(await signerIdsOf(context(other, cat([second, `0x${'ab'.repeat(65)}`])), ROOT), [OWNER_ID, second]);
  // A deploying account's: from its set-up only.
  const { encodeAbiParameters: abiEnc } = await import('viem');
  const configs = abiEnc([{ type: 'tuple[]', components: [{ name: 'id', type: 'bytes32' }, { name: 'signer', type: 'address' }, { name: 'data', type: 'bytes' }] }], [[{ id: second, signer: '0x9895a7b30a9dfcfbb1cd8f41595d2ad15fdcc9c3', data: OWNER as Hex }]]);
  assert.deepEqual(await signerIdsOf(context(none), ROOT, { root: ROOT as Hex, installs: new Map([[ROOT, configs]]) }), [second]);
});

test('An account’s last operation is looked for back in windows the node takes, from its own refusal, and a failed lookup isn’t remembered', async () => {
  const { signerIdOf } = await import('../src/erc4337-sim.ts');
  const { encodeFunctionData: enc, parseAbi: abi, concatHex: cat } = await import('viem');
  const HANDLE = abi(['function handleOps((address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature)[] ops, address beneficiary)']);
  const sender = '0x00000000000000000000000000000000005e1d01', id = `0x${'5f'.repeat(32)}` as Hex, zero = `0x${'00'.repeat(32)}` as Hex;
  const input = enc({ abi: HANDLE, functionName: 'handleOps', args: [[{ sender, nonce: 0n, initCode: '0x', callData: '0x', accountGasLimits: zero, preVerificationGas: 0n, gasFees: zero, paymasterAndData: '0x', signature: cat([id, `0x${'ab'.repeat(65)}`]) }], BOB] });
  const ranges: number[] = [];
  let failNext = false;
  // A node that refuses more than 5,000 blocks a query, naming its cap, and holds the operation 40,000 blocks back.
  const rpc = { has: () => true, call: async (_: number, method: string, params: any[]) => {
    if (method === 'eth_getBlockByNumber') return { number: '0x30d41' };
    if (method === 'eth_getTransactionByHash') { if (failNext) throw new Error('HTTP 429'); return { input }; }
    const from = Number(BigInt(params[0].fromBlock)), to = Number(BigInt(params[0].toBlock));
    ranges.push(to - from + 1);
    if (to - from + 1 > 5000) throw Object.assign(new Error('capped'), { rpcError: { message: 'exceed maximum block range: 5000' } });
    return from <= 160_000 && 160_000 <= to ? [{ transactionHash: `0x${'77'.repeat(32)}` }] : [];
  } };
  const context = (who: string) => ({ deps: { rpc }, chainId: 137, sender: who, signer: who, nonce: 0n, entryPoint: EP, hash: async () => undefined }) as never;
  assert.equal(await signerIdOf(context(sender), '0x01933401632d92bc7005d7415242171a55e20004ba'), id);
  assert.equal(ranges[0], 10_000, 'a 10,000-block window first');
  assert.ok(ranges.slice(1).every(r => r <= 5000), 'then within the cap the node named');
  // A read that fails: no id, and nothing remembered, so the next preview finds it.
  const other = '0x00000000000000000000000000000000005e1d02';
  failNext = true;
  assert.equal(await signerIdOf(context(other), '0x01933401632d92bc7005d7415242171a55e20004ba'), undefined);
  failNext = false;
  // (The operation is the first account's; the lookup reads it again, and finds the operation isn't the second's.)
  assert.equal(await signerIdOf(context(other), '0x01933401632d92bc7005d7415242171a55e20004ba'), undefined);
  assert.equal(ranges.filter(r => r === 10_000).length, 3, 'looked up again, not remembered from the failure');
});

test('The ecrecover stand-in: each stand-in signature recovers as its signer for exactly the precompile’s 3,000 gas', async () => {
  const { ecrecoverAs, STUB_SIGNATURE, STUB_COSIGNATURE } = await import('../src/erc4337-sim.ts');
  const { hexToBytes: toBytes, bytesToHex: toHex, createAddressFromString: at } = await import('@ethereumjs/util');
  const COSIGNER = '0xc051000000000000000000000000000000000c05';
  const digest = `0x${'d1'.repeat(32)}` as Hex;
  const input = (sig: Hex, hash: Hex) => concatHex([hash, `0x${sig.slice(130).padStart(64, '0')}`, `0x${sig.slice(2, 66)}`, `0x${sig.slice(66, 130)}`]);
  const where = '0x0000000000000000000000000000000000ec0bad';
  for (const [code, d, expect] of [
    [ecrecoverAs(OWNER), undefined, [[STUB_SIGNATURE, OWNER]]],
    [ecrecoverAs(OWNER, digest), digest, [[STUB_SIGNATURE, OWNER]]],
    [ecrecoverAs(OWNER, undefined, [{ signature: STUB_COSIGNATURE, signer: COSIGNER }]), undefined, [[STUB_SIGNATURE, OWNER], [STUB_COSIGNATURE, COSIGNER]]],
    [ecrecoverAs(OWNER, digest, [{ signature: STUB_COSIGNATURE, signer: COSIGNER }]), digest, [[STUB_SIGNATURE, OWNER], [STUB_COSIGNATURE, COSIGNER]]],
  ] as const) {
    await chain.putCode(where, code);
    for (const [sig, signer] of expect) {
      const r = await chain.evm.runCall({ caller: at(OWNER), to: at(where), data: toBytes(input(sig, d ?? `0x${'99'.repeat(32)}`)), gasLimit: 100_000n });
      assert.equal(`0x${toHex(r.execResult.returnValue).slice(-40)}`, signer);
      assert.equal(r.execResult.executionGasUsed, 3000n, `${signer} ${d ? 'over the digest' : ''}`);
    }
  }
  assert.notEqual(STUB_COSIGNATURE.slice(2, 66), STUB_SIGNATURE.slice(2, 66));
  // On a chain that charges its own price (HyperEVM's 15,000), the stand-in costs that.
  const { ecrecoverPrice } = await import('../src/chains.ts');
  assert.deepEqual([ecrecoverPrice(1), ecrecoverPrice(999)], [3000, 15_000]);
  for (const [code, d] of [[ecrecoverAs(OWNER, undefined, [], 15_000), undefined], [ecrecoverAs(OWNER, digest, [{ signature: STUB_COSIGNATURE, signer: COSIGNER }], 15_000), digest]] as const) {
    await chain.putCode(where, code);
    const r = await chain.evm.runCall({ caller: at(OWNER), to: at(where), data: toBytes(input(STUB_SIGNATURE, d ?? `0x${'99'.repeat(32)}`)), gasLimit: 100_000n });
    assert.deepEqual([`0x${toHex(r.execResult.returnValue).slice(-40)}`, r.execResult.executionGasUsed], [OWNER, 15_000n]);
  }
});

test('A paymaster field naming address 0 is no paymaster, as the EntryPoint takes it: the account pays', async () => {
  const p = await preview(operation({ ...withPaymaster('0x0000000000000000000000000000000000000000'), nonce: '0x0' }));
  assert.ok(!codes(p).includes('userop_rejected'), codes(p).join(','));
  assert.ok(!codes(p).includes('userop_paymaster'), 'no paymaster is named');
  assert.match(p.decoding.notes.find(n => /whole operation was simulated/.test(n)) ?? '', /and the gas payment\./);
  assert.match(detail(p, 'Gas cost (simulated)') ?? '', /paid by the account/);
  assert.deepEqual(usdcChange(p), ['out 50']);
});

test('The EntryPoint override hashes operations as the deployed EntryPoint does, for calls before a simulation too', async () => {
  const { entryPointOverride } = await import('../src/erc4337-sim.ts');
  const { hashTypedData, encodeFunctionData: enc, parseAbi: abi } = await import('viem');
  const HASH = abi(['function getUserOpHash((address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature) op) view returns (bytes32)']);
  const op = { sender: account8 as Hex, nonce: 7n, initCode: '0x' as Hex, callData: sendUsdc, accountGasLimits: concatHex([word(200_000n), word(200_000n)]), preVerificationGas: 50_000n, gasFees: concatHex([word(1_000_000_000n), word(2_000_000_000n)]), paymasterAndData: '0x' as Hex };
  const types = { PackedUserOperation: [{ name: 'sender', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'initCode', type: 'bytes' }, { name: 'callData', type: 'bytes' }, { name: 'accountGasLimits', type: 'bytes32' }, { name: 'preVerificationGas', type: 'uint256' }, { name: 'gasFees', type: 'bytes32' }, { name: 'paymasterAndData', type: 'bytes' }] };
  for (const ep of [EP8, EP9]) {
    // v0.8 on: the operation's hash is its EIP-712 digest under the EntryPoint's domain.
    const expected = hashTypedData({ domain: { name: 'ERC4337', version: '1', chainId: 999, verifyingContract: ep as Hex }, types, primaryType: 'PackedUserOperation', message: op });
    const data = enc({ abi: HASH, functionName: 'getUserOpHash', args: [{ ...op, signature: '0x' }] });
    // A plain call (as an earlier bundle's handleOps makes before the simulation starts) reads the domain the
    // simulation code keeps in storage: with the override's storage it is the EntryPoint's own; without, it was zero.
    const withOverride = await deps.rpc!.call(999, 'eth_call', [{ to: ep, data }, 'latest', { [ep]: entryPointOverride(ep, 999) }]);
    assert.equal(withOverride, expected, `v${ep === EP8 ? '0.8' : '0.9'}`);
    const codeOnly = await deps.rpc!.call(999, 'eth_call', [{ to: ep, data }, 'latest', { [ep]: { code: entryPointOverride(ep, 999)!.code } }]);
    assert.notEqual(codeOnly, expected);
  }
  // Its SenderCreator, which deploys accounts, is the EntryPoint's first creation, as on-chain (public from v0.8).
  const { getContractAddress } = await import('viem');
  const created = await deps.rpc!.call(999, 'eth_call', [{ to: EP8, data: enc({ abi: abi(['function senderCreator() view returns (address)']), functionName: 'senderCreator' }) }, 'latest', { [EP8]: entryPointOverride(EP8, 999) }]);
  assert.equal(`0x${String(created).slice(26)}`, getContractAddress({ from: EP8 as Hex, nonce: 1n }).toLowerCase());
});

test('A Safe being deployed: its owners, threshold and fallback handler from its setup, and a stand-in for each owner', async () => {
  const { safeSetupOf } = await import('../src/safe-sim.ts');
  const { ecrecoverAs, stubSignature } = await import('../src/erc4337-sim.ts');
  const { encodeFunctionData: enc, parseAbi: abi } = await import('viem');
  const { hexToBytes: toBytes, bytesToHex: toHex, createAddressFromString: at } = await import('@ethereumjs/util');
  const owners = ['0x3000000000000000000000000000000000000003', '0x1000000000000000000000000000000000000001', '0x2000000000000000000000000000000000000002'] as Hex[];
  const module = '0x75cf11467937ce3f2f357ce24ffc3dbf8fd5c226' as Hex;
  const setup = enc({ abi: abi(['function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)']), functionName: 'setup',
    args: [owners, 2n, '0x2dd68b007b46fbe91b9a7c3eda5a7a1063cb5b47', '0x', module, '0x0000000000000000000000000000000000000000', 0n, '0x0000000000000000000000000000000000000000'] });
  const factory = '0x4e1dcf7ad4e460cfd30791ccc4f9c8a4f820ec67';
  const initCode = concatHex([factory, enc({ abi: abi(['function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce)']), functionName: 'createProxyWithNonce', args: ['0x29fcb43b46531bca003ddc8fcb67ffe91900c762', setup, 7n] })]);
  assert.deepEqual(safeSetupOf(initCode), { owners: owners.map(o => o.toLowerCase()), threshold: 2n, fallbackHandler: module });
  assert.equal(safeSetupOf(`${factory}deadbeef`), null);
  // Up to 15 stand-ins, each told apart by its r, each recovered as its own signer for exactly 3,000 gas.
  const sigs = [0, 1, 2].map(stubSignature);
  assert.equal(new Set(sigs.map(x => x.slice(2, 66))).size, 3);
  const where = '0x0000000000000000000000000000000000ec0bae';
  await chain.putCode(where, ecrecoverAs(owners[0], undefined, [{ signature: sigs[1], signer: owners[1] }, { signature: sigs[2], signer: owners[2] }]));
  for (const [k, sig] of sigs.entries()) {
    const input = concatHex([`0x${'77'.repeat(32)}`, `0x${sig.slice(130).padStart(64, '0')}`, `0x${sig.slice(2, 66)}`, `0x${sig.slice(66, 130)}`]);
    const r = await chain.evm.runCall({ caller: at(OWNER), to: at(where), data: toBytes(input), gasLimit: 100_000n });
    assert.equal(`0x${toHex(r.execResult.returnValue).slice(-40)}`, owners[k].toLowerCase());
    assert.equal(r.execResult.executionGasUsed, 3000n);
  }
});

test('Calls run through executeUserOp that fail: the warning says the account was handed a stand-in signature', async () => {
  // The EntryPoint runs executeUserOp(op, hash) on the account, which here has none: the calls fail.
  const executeUserOp = `0x8dd7712f${'00'.repeat(64)}` as Hex;
  const p = await preview(operation({ nonce: '0x0', callData: executeUserOp }));
  const w = p.warnings.find(x => x.code === 'userop_execution_reverts');
  assert.ok(w, p.warnings.map(x => x.code).join(','));
  assert.match(w!.message, /handed the whole operation, its signature included/);
  // An ordinary failing call carries no such caveat.
  const q = await preview(operation({ nonce: '0x0', callData: call('execute', [usdc, 0n, call('transfer', [BOB, 10n ** 12n])]) }));
  assert.doesNotMatch(q.warnings.find(x => x.code === 'userop_execution_reverts')?.message ?? '', /handed the whole operation/);
});

test('OKX Wallet’s account: the stand-in names a key, so validation runs its checks and the calls run with that key’s permissions', async () => {
  const { OKX_IMPLEMENTATION, okxDigest } = await import('../src/erc4337-sim.ts');
  const { compiled } = await import('./evm-chain.ts');
  const { keccak256, encodeAbiParameters, getContractAddress } = await import('viem');
  const O = parseAbi(['struct Call { address to; uint256 value; bytes data; }', 'struct Owner { bytes32 keyHash; address keyType; }', 'function init(address ep, bytes32[] hashes, uint256[] types, uint256[] settings)',
    'function addOwner(bytes32 key, address keyType, uint256 settings)', 'function getOwnerKeys() view returns (bytes32[])', 'function createAccount(Owner[] owners, uint256 salt) returns (address)', 'function getAddress(Owner[] owners, uint256 salt) view returns (address)']);
  const ADMIN = 1n << 200n;
  // A passkey whose public key the previewer never sees (only its hash is in the account), and the owner's Ethereum key.
  const passkey = keccak256(concatHex([`0x${'a1'.repeat(32)}`, `0x${'b2'.repeat(32)}`])), ownerKey = keccak256(OWNER as Hex), other = keccak256(BOB as Hex);
  await chain.putCode(OKX_IMPLEMENTATION, `0x${compiled('OkxLike').evm.deployedBytecode.object}`);
  const make = async (keys: [Hex, bigint, bigint][]) => {
    const a = await chain.deploy('Proxy1967', 'address', [OKX_IMPLEMENTATION]);
    await chain.exec(a, encodeFunctionData({ abi: O, functionName: 'init', args: [EP, keys.map(k => k[0]), keys.map(k => k[1]), keys.map(k => k[2])] }));
    await chain.exec(usdc, call('mint', [a, 100_000_000n]));
    await chain.setBalance(a, E);
    return a;
  };
  // The operation pays Bob and adds a key: a call to the account itself, which only an admin key may make.
  const calls = (a: string) => concatHex(['0x8dd7712f', encodeAbiParameters([{ type: 'tuple[]', components: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }] }],
    [[{ to: usdc as Hex, value: 0n, data: call('transfer', [BOB, 50_000_000n]) }, { to: a as Hex, value: 0n, data: encodeFunctionData({ abi: O, functionName: 'addOwner', args: [`0x${'c3'.repeat(32)}`, '0x0000000000000000000000000000000000000001', ADMIN] }) }]])]);
  const whole = (p: Preview) => p.decoding.notes.find(n => /whole operation was simulated/.test(n)) ?? p.decoding.notes.join(' | ');

  // A passkey account, asked to sign itself: a stand-in passkey registered for the run with the real one's settings.
  const account = await make([[passkey, 2n, ADMIN], [ownerKey, 1n, ADMIN]]);
  let p = await preview(operation({ sender: account, callData: calls(account) }), account);
  assert.match(whole(p), /a passkey's assertion over the operation's hash/);
  assert.doesNotMatch(whole(p), /doesn't accept/);
  assert.deepEqual(codes(p).filter(c => c === 'userop_execution_reverts'), []);
  assert.deepEqual(usdcChange(p), ['out 50']);
  // Its Ethereum key asked to sign: that key itself, which ecrecover's stand-in signs.
  p = await preview(operation({ sender: account, callData: calls(account) }), OWNER);
  assert.match(whole(p), /ecrecover attributes it to the signer/);
  assert.doesNotMatch(whole(p), /doesn't accept/);
  assert.deepEqual(codes(p).filter(c => c === 'userop_execution_reverts'), []);
  assert.deepEqual(usdcChange(p), ['out 50']);

  // Asked by an Ethereum key that isn't one of its keys: no address but the account's can sign as its passkey, so the
  // stand-in is the passkey's real key, which the account refuses, and the preview says who signs.
  p = await preview(operation({ sender: account, callData: calls(account) }), BOB);
  assert.match(whole(p), /doesn't accept it as theirs \(OKX Wallet's account here is signed by its passkey \(a passkey wallet signs as the account itself\), and the signer asked is neither the account nor one of its Ethereum keys\)/);

  // An account whose only key isn't an admin: the stand-in key gets the same settings, so the call to itself fails as it will.
  const limited = await make([[passkey, 2n, 0n]]);
  p = await preview(operation({ sender: limited, callData: calls(limited) }), limited);
  assert.doesNotMatch(whole(p), /doesn't accept/);
  assert.match(p.warnings.find(w => w.code === 'userop_execution_reverts')?.message ?? '', /only lets an admin key make calls to itself/);
  assert.deepEqual(usdcChange(p), []);

  // An account whose Ethereum key is someone else's: a stand-in key for the signer, with that key's settings.
  const others = await make([[other, 1n, ADMIN]]);
  p = await preview(operation({ sender: others, callData: calls(others) }), OWNER);
  assert.doesNotMatch(whole(p), /doesn't accept/);
  assert.deepEqual(usdcChange(p), ['out 50']);

  // What the key signs: the operation's hash with validUntil and the implementation.
  assert.equal(okxDigest(`0x${'ab'.repeat(32)}`, 5n), keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }], [`0x${'ab'.repeat(32)}`, 5n, OKX_IMPLEMENTATION])));

  // An account the operation deploys through OKX's factory: its keys are createAccount's. Storage set for an account
  // not yet created wouldn't last, so the stand-in key takes the passkey's place in what the factory hands the
  // account's initializer (the implementation's address runs okxInitializing, its own code moved aside).
  const FACTORY = '0x5c328f3b5f117ffc693378a2c5b16c4f80f86295';
  await chain.putCode(FACTORY, `0x${compiled('OkxLikeFactory').evm.deployedBytecode.object}`);
  await chain.putCode(getContractAddress({ from: EP as Hex, nonce: 1n }), `0x${compiled('SenderCreatorLike').evm.deployedBytecode.object}`);
  const owners = [{ keyHash: passkey, keyType: '0x0000000000000000000000000000000000000002' as Hex }, { keyHash: other, keyType: '0x0000000000000000000000000000000000000001' as Hex }];
  const fresh = `0x${(await chain.evm.runCall({ to: (await import('@ethereumjs/util')).createAddressFromString(FACTORY), data: (await import('@ethereumjs/util')).hexToBytes(encodeFunctionData({ abi: O, functionName: 'getAddress', args: [owners, 9n] })), gasLimit: 1_000_000n })).execResult.returnValue.slice(12).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '')}`;
  await chain.exec(usdc, call('mint', [fresh, 100_000_000n]));
  await chain.setBalance(fresh, E);
  p = await preview(operation({ sender: fresh, callData: calls(fresh), factory: FACTORY, factoryData: encodeFunctionData({ abi: O, functionName: 'createAccount', args: [owners, 9n] }), verificationGasLimit: '0xf4240' }), fresh);
  assert.match(whole(p), /deploying the account through its factory/);
  assert.match(whole(p), /a passkey's assertion over the operation's hash/);
  assert.doesNotMatch(whole(p), /doesn't accept/);
  assert.deepEqual(codes(p).filter(c => c === 'userop_execution_reverts'), []);
  assert.deepEqual(usdcChange(p), ['out 50']);
  // The code that stands at the implementation's address: initialize((bytes32,address)[]) gets the stand-in key
  // where the word at its place is the real key's, and everything else goes on to the moved code unchanged.
  const { okxInitializing } = await import('../src/erc4337-sim.ts');
  const { hexToBytes: toBytes, bytesToHex: toHex, createAddressFromString: at } = await import('@ethereumjs/util');
  const MOVED = '0x0000000000000000000000000000000000ec0c0d', WRAPPED = '0x0000000000000000000000000000000000ec0c0e';
  await chain.putCode(MOVED, '0x366000600037366000f3' as Hex); // returns its calldata
  await chain.putCode(WRAPPED, okxInitializing(passkey, `0x${'5e'.repeat(32)}`, 4 + 64));
  const echo = async (data: Hex) => toHex((await chain.evm.runCall({ caller: at(OWNER), to: at(WRAPPED), data: toBytes(data), gasLimit: 200_000n })).execResult.returnValue);
  const init = encodeFunctionData({ abi: parseAbi(['struct Owner { bytes32 keyHash; address keyType; }', 'function initialize(Owner[] owners)']), functionName: 'initialize', args: [owners] });
  assert.equal(init.slice(0, 10), '0x466e5483');
  assert.equal(await echo(init), init.replace(passkey.slice(2), '5e'.repeat(32)));
  const otherCall = encodeFunctionData({ abi: O, functionName: 'createAccount', args: [owners, 9n] });
  assert.equal(await echo(otherCall), otherCall);
  assert.equal(await echo('0x'), '0x');
});

test('An EIP-7702 delegate in Biconomy Smart Account v2’s form with a cosigner: the stand-in passes its own code’s checks and its registry’s, for the gas a signed operation uses', async () => {
  // The delegate's and its registry's code as deployed (unpublished), and an account delegating to it whose key signs.
  const { readFileSync } = await import('node:fs');
  const { COSIGNED_7702_COSIGNER, STUB_SIGNATURE } = await import('../src/erc4337-sim.ts');
  const { ecrecoverPrice } = await import('../src/chains.ts');
  const { keccak256, encodeAbiParameters, encodePacked, parseAbiParameters, decodeAbiParameters } = await import('viem');
  const { createAddressFromString: at, hexToBytes: toBytes } = await import('@ethereumjs/util');
  const fx = JSON.parse(readFileSync(new URL('./fixtures/cosigned-7702.json', import.meta.url), 'utf8')) as Record<'delegate' | 'registry', { address: string; code: Hex }> & { operation: Record<string, Hex> & { userOpHash: Hex; sender: string } };
  await chain.putCode(fx.delegate.address, fx.delegate.code);
  await chain.putCode(fx.registry.address, fx.registry.code);
  const key = privateKeyToAccount(`0x${'7a'.repeat(32)}`), cosigner = privateKeyToAccount(`0x${'c0'.repeat(32)}`);
  const user = key.address.toLowerCase();
  // The registry's verifying signers: a mapping at slot 1 (the stand-in's cosigner, and the one signing for real below).
  const slot = (a: string) => toBytes(keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [a as Hex, 1n])));
  const list = async (a: string, on: boolean) => chain.evm.stateManager.putStorage(at(fx.registry.address), slot(a), on ? new Uint8Array([1]) : new Uint8Array(0));
  await list(COSIGNED_7702_COSIGNER, true);
  await list(cosigner.address, true);
  await chain.putCode(user, `0xef0100${fx.delegate.address.slice(2)}` as Hex);
  await chain.exec(usdc, call('mint', [user, 100_000_000n]));
  await chain.setBalance(user, E);
  const execute = encodeFunctionData({ abi: parseAbi(['function execute_ncC(address dest, uint256 value, bytes func)']), functionName: 'execute_ncC', args: [usdc as Hex, 0n, call('transfer', [BOB, 50_000_000n])] });
  const op = operation({ sender: user, callData: execute, paymasterAndData: '0x' });
  const notes = (p: Preview) => p.decoding.notes.join(' | ');
  const whole = (p: Preview) => p.decoding.notes.find(n => /whole operation was simulated as EntryPoint v0\.6/.test(n));
  const gasUsed = (p: Preview) => BigInt(String(p.details.find(d => d.label === 'Gas used (simulated)')?.raw));

  // Before: the bare stand-in isn't the form the account decodes, so its validation reverted and only the calls ran.
  // Supplied as the wallet's stub, it still reverts, and the stand-in of the account's own form (below) is taken.
  let p = await preview({ ...op, signature: STUB_SIGNATURE }, user, '0.6');
  assert.match(whole(p) ?? notes(p), /in the account's own form, the wallet's stand-in signature refused/);

  // The stand-in: the account asked to sign, its cosigner listed. Validated, and the calls run.
  p = await preview(op, user, '0.6');
  assert.ok(whole(p) && !/doesn't accept/.test(whole(p)!), notes(p));
  assert.deepEqual(codes(p).filter(c => c === 'userop_execution_reverts' || c === 'userop_rejected'), []);
  assert.deepEqual(usdcChange(p), ['out 50']);
  const standIn = gasUsed(p);

  // A real signature in the account's form, by its key and a listed cosigner: the cosigner's over the operation's hash,
  // the key's over the root of a tree of two leaves, the operation's (with a validity window) and another.
  const hash = userOpHash(readOperation(op, '0.6')!, EP6, 999, '0.6');
  const validUntil = 1_900_000_000, validAfter = 1_700_000_000, other = `0x${'ab'.repeat(32)}` as Hex;
  const leaf = keccak256(encodePacked(['uint48', 'uint48', 'bytes32'], [validUntil, validAfter, hash]));
  const root = keccak256(BigInt(leaf) < BigInt(other) ? concatHex([leaf, other]) : concatHex([other, leaf]));
  const owner = encodeAbiParameters(parseAbiParameters('uint48, uint48, bytes32, bytes32[], bytes'), [validUntil, validAfter, root, [other], await key.signMessage({ message: { raw: root } })]);
  const module = encodeAbiParameters(parseAbiParameters('bytes, bytes'), [await cosigner.signMessage({ message: { raw: hash } }), owner]);
  const signed = { ...op, signature: encodeAbiParameters(parseAbiParameters('bytes, address'), [module, '0xd88b687ba4237e6b9893020285103f45d8949ea3']) };
  p = await preview(signed, user, '0.6');
  assert.ok(whole(p) && !/doesn't accept/.test(whole(p)!), notes(p));
  assert.deepEqual(usdcChange(p), ['out 50']);
  // Its two signatures pass through the replaced ecrecover to the real precompile, about 200 gas more each than calling
  // it, where the stand-in's cost exactly the chain's price for it (HyperEVM's 15,000 here, which this test's EVM
  // charges 3,000): otherwise the stand-in uses the gas the signed operation does.
  const real = gasUsed(p), priced = 2n * BigInt(ecrecoverPrice(999) - 3000);
  assert.ok(real + priced - standIn >= 350n && real + priced - standIn <= 450n, `${real} ${standIn}`);
  // A cosignature over another hash: the supplied signature refused, and the preview says so; the stand-ins of the
  // account's own form (the signer's and its cosigner's) run instead, as they would with no signature supplied.
  const miscosigned = { ...op, signature: encodeAbiParameters(parseAbiParameters('bytes, address'), [encodeAbiParameters(parseAbiParameters('bytes, bytes'), [await cosigner.signMessage({ message: { raw: keccak256(hash) } }), owner]), '0xd88b687ba4237e6b9893020285103f45d8949ea3']) };
  assert.match(whole(await preview(miscosigned, user, '0.6')) ?? '', /in the account's own form, the wallet's stand-in signature refused/);

  // A real operation of the delegate's (BNB Chain), its validateUserOp run here as the EntryPoint calls it, with the
  // hash it was signed over: its cosignature is the stand-in's cosigner's, and its form is the one the stand-in takes.
  const onChain = fx.operation;
  await chain.putCode(onChain.sender, `0xef0100${fx.delegate.address.slice(2)}` as Hex);
  const VALIDATE = parseAbi(['struct UserOperation { address sender; uint256 nonce; bytes initCode; bytes callData; uint256 callGasLimit; uint256 verificationGasLimit; uint256 preVerificationGas; uint256 maxFeePerGas; uint256 maxPriorityFeePerGas; bytes paymasterAndData; bytes signature; }',
    'function validateUserOp(UserOperation op, bytes32 hash, uint256 missing) returns (uint256)']);
  const fields = { sender: onChain.sender as Hex, initCode: onChain.initCode, callData: onChain.callData, paymasterAndData: onChain.paymasterAndData, signature: onChain.signature,
    ...Object.fromEntries((['nonce', 'callGasLimit', 'verificationGasLimit', 'preVerificationGas', 'maxFeePerGas', 'maxPriorityFeePerGas'] as const).map(k => [k, BigInt(onChain[k])])) } as never;
  const validate = async (h: Hex) => {
    const r = await chain.evm.runCall({ caller: at(EP6), to: at(onChain.sender), data: toBytes(encodeFunctionData({ abi: VALIDATE, functionName: 'validateUserOp', args: [fields, h, 0n] })), gasLimit: 1_000_000n });
    assert.equal(r.execResult.exceptionError, undefined);
    return BigInt(`0x${Buffer.from(r.execResult.returnValue).toString('hex')}`);
  };
  const [moduleSig] = decodeAbiParameters(parseAbiParameters('bytes, address'), onChain.signature);
  const [, ownerSig] = decodeAbiParameters(parseAbiParameters('bytes, bytes'), moduleSig);
  const [until, after, , proof] = decodeAbiParameters(parseAbiParameters('uint48, uint48, bytes32, bytes32[], bytes'), ownerSig);
  assert.equal(proof.length, 1);
  // Validated (no failure or aggregator in the low bits), within the window its key signed.
  assert.equal(await validate(onChain.userOpHash), (BigInt(after) << 208n) | (BigInt(until) << 160n));
  // Over any other hash: refused (1), not reverted.
  assert.equal(await validate(keccak256(onChain.userOpHash)), 1n);

  // Another key asked: the account takes only its own.
  p = await preview(op, OWNER, '0.6');
  assert.match(whole(p) ?? notes(p), /doesn't accept/);
  // The registry no longer listing the stand-in's cosigner: refused, as the cosigner's signature will be.
  await list(COSIGNED_7702_COSIGNER, false);
  p = await preview(op, user, '0.6');
  assert.match(whole(p) ?? notes(p), /doesn't accept/);
});

test('The cosigned EIP-7702 delegate’s second deployment: its registry’s signer read from the chain, the owner’s tree the operation alone', async () => {
  // The delegate's and its registry's code as deployed (unpublished), and an account delegating to it whose key signs.
  const { readFileSync } = await import('node:fs');
  const { STUB_SIGNATURE } = await import('../src/erc4337-sim.ts');
  const { ecrecoverPrice } = await import('../src/chains.ts');
  const { keccak256, encodeAbiParameters, encodePacked, parseAbiParameters, decodeAbiParameters, pad } = await import('viem');
  const { createAddressFromString: at, hexToBytes: toBytes } = await import('@ethereumjs/util');
  const fx = JSON.parse(readFileSync(new URL('./fixtures/cosigned-7702-v2.json', import.meta.url), 'utf8')) as { delegate: { address: string; code: Hex }; registry: { address: string; code: Hex; signer: string }; operation: Record<string, Hex> & { userOpHash: Hex; sender: string } };
  await chain.putCode(fx.delegate.address, fx.delegate.code);
  await chain.putCode(fx.registry.address, fx.registry.code);
  const key = privateKeyToAccount(`0x${'7b'.repeat(32)}`), cosigner = privateKeyToAccount(`0x${'c1'.repeat(32)}`), next = privateKeyToAccount(`0x${'c2'.repeat(32)}`);
  const user = key.address.toLowerCase();
  // The registry's one verifying signer (getVerifyingSigner(), slot 1).
  const verifying = async (a: string) => chain.evm.stateManager.putStorage(at(fx.registry.address), toBytes(pad('0x01')), toBytes(a as Hex));
  await verifying(cosigner.address);
  await chain.putCode(user, `0xef0100${fx.delegate.address.slice(2)}` as Hex);
  await chain.exec(usdc, call('mint', [user, 100_000_000n]));
  await chain.setBalance(user, E);
  const execute = encodeFunctionData({ abi: parseAbi(['function execute_ncC(address dest, uint256 value, bytes func)']), functionName: 'execute_ncC', args: [usdc as Hex, 0n, call('transfer', [BOB, 50_000_000n])] });
  const op = operation({ sender: user, callData: execute, paymasterAndData: '0x' });
  const notes = (p: Preview) => p.decoding.notes.join(' | ');
  const whole = (p: Preview) => p.decoding.notes.find(n => /whole operation was simulated as EntryPoint v0\.6/.test(n));
  const gasUsed = (p: Preview) => BigInt(String(p.details.find(d => d.label === 'Gas used (simulated)')?.raw));

  // The stand-in: the account asked to sign, the cosignature its registry's signer's. Validated, and the calls run.
  let p = await preview(op, user, '0.6');
  assert.ok(whole(p) && !/doesn't accept/.test(whole(p)!), notes(p));
  assert.deepEqual(codes(p).filter(c => c === 'userop_execution_reverts' || c === 'userop_rejected'), []);
  assert.deepEqual(usdcChange(p), ['out 50']);
  const standIn = gasUsed(p);

  // A real signature in the account's form, as its operations are signed: the cosigner's over the operation's hash,
  // the key's over the root of a tree of the operation alone (with a validity window), and no proof.
  const hash = userOpHash(readOperation(op, '0.6')!, EP6, 999, '0.6');
  const validUntil = 1_900_000_000, validAfter = 0;
  const root = keccak256(encodePacked(['uint48', 'uint48', 'bytes32'], [validUntil, validAfter, hash]));
  const owner = encodeAbiParameters(parseAbiParameters('uint48, uint48, bytes32, bytes32[], bytes'), [validUntil, validAfter, root, [], await key.signMessage({ message: { raw: root } })]);
  const signed = { ...op, signature: encodeAbiParameters(parseAbiParameters('bytes, address'), [encodeAbiParameters(parseAbiParameters('bytes, bytes'), [await cosigner.signMessage({ message: { raw: hash } }), owner]), '0xba418fa699622de824b258c61eb150ed7a13967b']) };
  p = await preview(signed, user, '0.6');
  assert.ok(whole(p) && !/doesn't accept/.test(whole(p)!), notes(p));
  // The same gas but for the two signatures passing through the replaced ecrecover (about 200 gas each more than
  // calling the precompile, where the stand-in's cost exactly the chain's price for it) and the window's bytes.
  const real = gasUsed(p), priced = 2n * BigInt(ecrecoverPrice(999) - 3000);
  assert.ok(real + priced - standIn >= 350n && real + priced - standIn <= 450n, `${real} ${standIn}`);

  // The registry's signer changes: the stand-in's cosignature follows it, read from the registry, and the operation
  // the old signer cosigned is refused, as it will be.
  await verifying(next.address);
  p = await preview(op, user, '0.6');
  assert.ok(whole(p) && !/doesn't accept/.test(whole(p)!), notes(p));
  // (This delegate pays nothing toward its gas for a cosignature its registry refuses, so the EntryPoint rejects the
  // operation as unpaid, AA21, as bundlers will: the preview says it's the signature, not the account's funds.)
  const q = await preview(signed, user, '0.6');
  assert.equal(whole(q), undefined);
  assert.equal(q.warnings.find(w => w.code === 'userop_rejected'), undefined);
  assert.match(notes(q), /The account doesn't accept the signature the wallet supplied and pays nothing toward its gas for a signature it refuses, so the EntryPoint rejects the operation \(AA21 didn't pay prefund\) and only its calls were simulated/);

  // A real operation of the delegate's (BNB Chain), its validateUserOp run here as the EntryPoint calls it, with the
  // hash it was signed over and the registry's signer of the chain: its tree is the operation alone, as the stand-in's.
  await verifying(fx.registry.signer);
  const onChain = fx.operation;
  await chain.putCode(onChain.sender, `0xef0100${fx.delegate.address.slice(2)}` as Hex);
  const VALIDATE = parseAbi(['struct UserOperation { address sender; uint256 nonce; bytes initCode; bytes callData; uint256 callGasLimit; uint256 verificationGasLimit; uint256 preVerificationGas; uint256 maxFeePerGas; uint256 maxPriorityFeePerGas; bytes paymasterAndData; bytes signature; }',
    'function validateUserOp(UserOperation op, bytes32 hash, uint256 missing) returns (uint256)']);
  const fields = { sender: onChain.sender as Hex, initCode: onChain.initCode, callData: onChain.callData, paymasterAndData: onChain.paymasterAndData, signature: onChain.signature,
    ...Object.fromEntries((['nonce', 'callGasLimit', 'verificationGasLimit', 'preVerificationGas', 'maxFeePerGas', 'maxPriorityFeePerGas'] as const).map(k => [k, BigInt(onChain[k])])) } as never;
  const validate = async (h: Hex) => {
    const r = await chain.evm.runCall({ caller: at(EP6), to: at(onChain.sender), data: toBytes(encodeFunctionData({ abi: VALIDATE, functionName: 'validateUserOp', args: [fields, h, 0n] })), gasLimit: 1_000_000n });
    assert.equal(r.execResult.exceptionError, undefined);
    return BigInt(`0x${Buffer.from(r.execResult.returnValue).toString('hex')}`);
  };
  const [moduleSig, named] = decodeAbiParameters(parseAbiParameters('bytes, address'), onChain.signature);
  assert.equal(named.toLowerCase(), '0xba418fa699622de824b258c61eb150ed7a13967b');
  const [, ownerSig] = decodeAbiParameters(parseAbiParameters('bytes, bytes'), moduleSig);
  const [until, after, onChainRoot, proof] = decodeAbiParameters(parseAbiParameters('uint48, uint48, bytes32, bytes32[], bytes'), ownerSig);
  assert.equal(proof.length, 0);
  assert.equal(onChainRoot, keccak256(encodePacked(['uint48', 'uint48', 'bytes32'], [until, after, onChain.userOpHash])));
  assert.equal(await validate(onChain.userOpHash), (BigInt(after) << 208n) | (BigInt(until) << 160n));
  assert.equal(await validate(keccak256(onChain.userOpHash)), 1n);
  // The bare stand-in, which the account got before: supplied as the wallet's stub its validation reverts, and the
  // stand-in of the account's own form is taken instead.
  p = await preview({ ...op, signature: STUB_SIGNATURE }, user, '0.6');
  assert.match(whole(p) ?? notes(p), /in the account's own form, the wallet's stand-in signature refused/);

  // Another key asked: the account takes only its own.
  p = await preview(op, OWNER, '0.6');
  assert.match(whole(p) ?? notes(p), /doesn't accept it as theirs \(it takes its own key's signature \(it is an EIP-7702 account\), with its registry's cosignature, and the signer asked isn't the account\)/);
  await verifying(fx.registry.signer);
});

test('Modular Account v2 validating through Aave Labs’ 2-of-2 multisig module: the signer’s stand-in in its place and the other signer’s, and the preview says that one must sign too', async () => {
  // Alchemy's implementation, Aave Labs' module and an account's proxy as deployed (Arbitrum One), set up as the
  // chain has them: the account's validation for entity ID 1 (its storage word) and the module's two signers for it.
  const { readFileSync } = await import('node:fs');
  const { ecrecoverPrice } = await import('../src/chains.ts');
  const { keccak256, encodeAbiParameters, parseAbiParameters, pad, concatHex: cat } = await import('viem');
  const { createAddressFromString: at, hexToBytes: toBytes } = await import('@ethereumjs/util');
  const fx = JSON.parse(readFileSync(new URL('./fixtures/mav2-multisig.json', import.meta.url), 'utf8')) as Record<'account' | 'implementation' | 'module', { address: string; code: Hex }> & { validation: { slot: Hex; word: Hex }; signers: string[]; operation: Record<string, Hex> & { userOpHash: Hex; sender: string } };
  await chain.putCode(fx.implementation.address, fx.implementation.code);
  await chain.putCode(fx.module.address, fx.module.code);
  const put = (a: string, slot: Hex, v: Hex) => chain.evm.stateManager.putStorage(at(a), toBytes(slot), toBytes(v));
  // signersInEntity[entityId][account] (the module's first slot): signer1, then signer2.
  const signersSlot = (account: string) => BigInt(keccak256(encodeAbiParameters(parseAbiParameters('address, bytes32'), [account as Hex, keccak256(encodeAbiParameters(parseAbiParameters('uint256, uint256'), [1n, 0n]))])));
  const install = async (account: string, signers: string[]) => {
    await chain.putCode(account, fx.account.code);
    await put(account, '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc', pad(fx.implementation.address as Hex));
    await put(account, fx.validation.slot, fx.validation.word);
    for (const [i, s] of signers.entries()) await put(fx.module.address, pad(`0x${(signersSlot(account) + BigInt(i)).toString(16)}`), pad(s as Hex));
  };
  const user = privateKeyToAccount(`0x${'a1'.repeat(32)}`), app = privateKeyToAccount(`0x${'a2'.repeat(32)}`);
  const account = '0x226f000000000000000000000000000000000001';
  await install(account, [user.address, app.address]);
  await chain.exec(usdc, call('mint', [account, 100_000_000n]));
  await chain.setBalance(account, E);
  // Its nonce names the validation: parallel key 1, entity ID 1, global (options 0x01).
  const op = operation({ sender: account, nonce: numberToHex(((1n << 40n) | (1n << 8n) | 1n) << 64n) });
  const notes = (p: Preview) => p.decoding.notes.join(' | ');
  const whole = (p: Preview) => p.decoding.notes.find(n => /whole operation was simulated as EntryPoint v0\.7/.test(n));
  const gasUsed = (p: Preview) => BigInt(String(p.details.find(d => d.label === 'Gas used (simulated)')?.raw));

  // Asked by the account's own key: validated, the calls run, and the preview says the other signer must sign too.
  let p = await preview(op, user.address.toLowerCase());
  assert.ok(whole(p) && !/doesn't accept/.test(whole(p)!), notes(p));
  assert.deepEqual(codes(p).filter(c => c === 'userop_execution_reverts' || c === 'userop_rejected'), []);
  assert.deepEqual(usdcChange(p), ['out 50']);
  assert.match(notes(p), new RegExp(`MultiSigValidationModule \\(0xcbec…a3e6, named by its nonce\\), which takes the signatures of both of the account's signers: the signer's key is one of the 2, and the other, ${app.address.toLowerCase()}, must sign the operation too before any bundler can include it`));
  const standIn = gasUsed(p);
  // Asked by the other signer: the same, naming the account's own key as the one still to sign.
  p = await preview(op, app.address.toLowerCase());
  assert.ok(whole(p) && !/doesn't accept/.test(whole(p)!), notes(p));
  assert.match(notes(p), new RegExp(`and the other, ${user.address.toLowerCase()}, must sign`));
  // Asked by a key that is neither: refused, and the preview names the two.
  p = await preview(op, OWNER);
  assert.match(whole(p) ?? '', new RegExp(`doesn't accept it as theirs \\(it validates through Aave Labs' MultiSigValidationModule .*${user.address.toLowerCase()} and ${app.address.toLowerCase()}, and the signer asked isn't one of them\\)`));

  // Both keys' real signatures of the operation's hash as a message, in the module's order (getSigners'): validated,
  // for the stand-in's gas but the two passing through the replaced ecrecover (about 200 gas each more than calling
  // the precompile). In the other order too, for about 170 more (each recovered key compared with the other slot first).
  const hash = userOpHash(readOperation(op, '0.7')!, EP, 999, '0.7');
  const [a, b] = [await user.signMessage({ message: { raw: hash } }), await app.signMessage({ message: { raw: hash } })];
  const priced = 2n * BigInt(ecrecoverPrice(999) - 3000), gas: bigint[] = [];
  for (const signature of [cat(['0xff', a, b]), cat(['0xff', b, a])]) {
    p = await preview({ ...op, signature }, user.address.toLowerCase());
    assert.ok(whole(p) && !/doesn't accept/.test(whole(p)!), notes(p));
    gas.push(gasUsed(p));
  }
  assert.ok(gas[0] + priced - standIn >= 350n && gas[0] + priced - standIn <= 450n, `${gas[0]} ${standIn}`);
  assert.ok(gas[1] - gas[0] >= 100n && gas[1] - gas[0] <= 250n, `${gas}`);
  // Modular Account v2's own form, which the account got before: supplied as the wallet's stub the module reverts on
  // its length (AA23), and the stand-in of the account's own form (the multisig's, above) is taken instead.
  p = await preview({ ...op, signature: cat(['0xff00', a]) }, user.address.toLowerCase());
  assert.match(whole(p) ?? notes(p), /in the account's own form, the wallet's stand-in signature refused/);

  // A real operation of such an account (Arbitrum One), its validateUserOp run here as the EntryPoint calls it, with
  // the hash it was signed over and its signers as the module has them: 0xff, then each signer's signature in turn.
  const onChain = fx.operation;
  await install(onChain.sender, fx.signers);
  const PACKED_OP = parseAbi(['struct PackedUserOperation { address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits; uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature; }',
    'function validateUserOp(PackedUserOperation op, bytes32 hash, uint256 missing) returns (uint256)']);
  const fields = { sender: onChain.sender as Hex, nonce: BigInt(onChain.nonce), initCode: onChain.initCode, callData: onChain.callData, accountGasLimits: onChain.accountGasLimits, preVerificationGas: BigInt(onChain.preVerificationGas), gasFees: onChain.gasFees, paymasterAndData: onChain.paymasterAndData, signature: onChain.signature } as never;
  const validate = async (h: Hex) => {
    const r = await chain.evm.runCall({ caller: at(EP), to: at(onChain.sender), data: toBytes(encodeFunctionData({ abi: PACKED_OP, functionName: 'validateUserOp', args: [fields, h, 0n] })), gasLimit: 1_000_000n });
    assert.equal(r.execResult.exceptionError, undefined);
    return BigInt(`0x${Buffer.from(r.execResult.returnValue).toString('hex')}`);
  };
  assert.equal(onChain.signature.length, 2 + 131 * 2);
  assert.equal(await validate(onChain.userOpHash), 0n);
  assert.equal(await validate(keccak256(onChain.userOpHash)), 1n);
});

test('The cosigned delegate’s second deployment, its registry switched by its owner: taking every cosignature validates, refusing every one is said to be the signature, not the account’s funds', async () => {
  // The registry keeps a mode next to its signer (slot 1's byte above it; its owner sets it): 0 takes the signer's
  // cosignature, 1 any, 2 none. Refusing a cosignature, this delegate pays nothing toward its gas, so without a
  // paymaster the EntryPoint rejects the operation as unpaid (AA21) though the account can pay.
  const { readFileSync } = await import('node:fs');
  const { encodeAbiParameters, encodePacked, keccak256, parseAbiParameters, pad } = await import('viem');
  const { createAddressFromString: at, hexToBytes: toBytes } = await import('@ethereumjs/util');
  const fx = JSON.parse(readFileSync(new URL('./fixtures/cosigned-7702-v2.json', import.meta.url), 'utf8')) as { delegate: { address: string; code: Hex }; registry: { address: string; code: Hex; signer: string } };
  await chain.putCode(fx.delegate.address, fx.delegate.code);
  await chain.putCode(fx.registry.address, fx.registry.code);
  const key = privateKeyToAccount(`0x${'7d'.repeat(32)}`), cosigner = privateKeyToAccount(`0x${'c3'.repeat(32)}`);
  const user = key.address.toLowerCase();
  const slot1 = (mode: bigint, signer: string) => chain.evm.stateManager.putStorage(at(fx.registry.address), toBytes(pad('0x01')), toBytes(pad(numberToHex((mode << 160n) | BigInt(signer)))));
  await chain.putCode(user, `0xef0100${fx.delegate.address.slice(2)}` as Hex);
  await chain.exec(usdc, call('mint', [user, 100_000_000n]));
  await chain.setBalance(user, E);
  const execute = encodeFunctionData({ abi: parseAbi(['function execute_ncC(address dest, uint256 value, bytes func)']), functionName: 'execute_ncC', args: [usdc as Hex, 0n, call('transfer', [BOB, 50_000_000n])] });
  const op = operation({ sender: user, callData: execute, paymasterAndData: '0x' });
  const notes = (p: Preview) => p.decoding.notes.join(' | ');
  const whole = (p: Preview) => p.decoding.notes.find(n => /whole operation was simulated as EntryPoint v0\.6/.test(n));
  const validated = (p: Preview) => assert.ok(whole(p) && !/doesn't (accept|take)/.test(whole(p)!), notes(p));

  // Taking its signer's cosignature, or any: the stand-in validates and the calls run.
  for (const mode of [0n, 1n]) {
    await slot1(mode, cosigner.address);
    const p = await preview(op, user, '0.6');
    validated(p);
    assert.deepEqual(usdcChange(p), ['out 50']);
  }
  // Refusing every cosignature: the stand-in refused for that reason, which every signature will be, and no caution
  // that the account can't pay; only its calls simulated.
  await slot1(2n, cosigner.address);
  let p = await preview(op, user, '0.6');
  assert.equal(whole(p), undefined);
  assert.deepEqual(codes(p).filter(c => c === 'userop_rejected' || c === 'userop_cannot_prefund'), []);
  assert.match(notes(p), /The account doesn't accept a stand-in for the signature as theirs \(its registry \(0x82ea…e4dc\) is switched to refuse every cosignature: the account takes no operation, whoever signs it, until the registry's owner switches it back\) and pays nothing toward its gas for a signature it refuses, so the EntryPoint rejects the operation \(AA21 didn't pay prefund\) and only its calls were simulated/);
  assert.match(notes(p), /The operation's calls were simulated as the EntryPoint runs it/);
  // The signature itself, by the key and the registry's signer, refused the same way.
  const hash = userOpHash(readOperation(op, '0.6')!, EP6, 999, '0.6');
  const root = keccak256(encodePacked(['uint48', 'uint48', 'bytes32'], [0, 0, hash]));
  const owner = encodeAbiParameters(parseAbiParameters('uint48, uint48, bytes32, bytes32[], bytes'), [0, 0, root, [], await key.signMessage({ message: { raw: root } })]);
  const signed = { ...op, signature: encodeAbiParameters(parseAbiParameters('bytes, address'), [encodeAbiParameters(parseAbiParameters('bytes, bytes'), [await cosigner.signMessage({ message: { raw: hash } }), owner]), '0xba418fa699622de824b258c61eb150ed7a13967b']) };
  p = await preview(signed, user, '0.6');
  assert.match(notes(p), /The account doesn't accept the signature the wallet supplied and pays nothing toward its gas for a signature it refuses, so the EntryPoint rejects the operation \(AA21 didn't pay prefund\)/);
  // An account that can't pay is told so, as before: not put down to the signature.
  await chain.setBalance(user, 0n);
  p = await preview(op, user, '0.6');
  assert.ok(codes(p).includes('userop_cannot_prefund'), codes(p).join());
  assert.doesNotMatch(notes(p), /pays nothing toward its gas/);
  await chain.setBalance(user, E);
  // Switched back: validated, the same signature too.
  await slot1(0n, cosigner.address);
  validated(await preview(op, user, '0.6'));
  validated(await preview(signed, user, '0.6'));
  await slot1(0n, fx.registry.signer);
});

test('The cosigned delegate’s second deployment: asked by a key that isn’t the account, refused for certain whether or not its registry is read; a registry with no signer read as such', async () => {
  const { readFileSync } = await import('node:fs');
  const { pad } = await import('viem');
  const { createAddressFromString: at, hexToBytes: toBytes } = await import('@ethereumjs/util');
  const fx = JSON.parse(readFileSync(new URL('./fixtures/cosigned-7702-v2.json', import.meta.url), 'utf8')) as { delegate: { address: string; code: Hex }; registry: { address: string; code: Hex; signer: string } };
  await chain.putCode(fx.delegate.address, fx.delegate.code);
  await chain.putCode(fx.registry.address, fx.registry.code);
  const user = privateKeyToAccount(`0x${'7e'.repeat(32)}`).address.toLowerCase();
  const slot1 = (v: Hex) => chain.evm.stateManager.putStorage(at(fx.registry.address), toBytes(pad('0x01')), toBytes(pad(v)));
  await chain.putCode(user, `0xef0100${fx.delegate.address.slice(2)}` as Hex);
  await chain.exec(usdc, call('mint', [user, 100_000_000n]));
  await chain.setBalance(user, E);
  const execute = encodeFunctionData({ abi: parseAbi(['function execute_ncC(address dest, uint256 value, bytes func)']), functionName: 'execute_ncC', args: [usdc as Hex, 0n, call('transfer', [BOB, 50_000_000n])] });
  const op = operation({ sender: user, callData: execute, paymasterAndData: '0x' });
  const notes = (p: Preview) => p.decoding.notes.join(' | ');
  const other = "it takes its own key's signature \\(it is an EIP-7702 account\\), with its registry's cosignature, and the signer asked isn't the account";

  // The registry's signer unread (the node failing to answer for it): the cosignature's stand-in is no one's, and the
  // registry's check reverts on it. Asked by another key, the reason given is the certain one, the signer not being
  // the account, not the registry; asked by the account itself, the registry, unsure.
  const failing: Dependencies = { ...deps, rpc: { has: id => deps.rpc!.has(id), call: async (id, method, params) => {
    if (method === 'eth_call' && String((params[0] as { data?: string }).data).startsWith('0x521e47b9')) throw new Error('unavailable');
    return deps.rpc!.call(id, method, params);
  } } };
  const unread = async (signer: string) => {
    const hash = userOpHash(readOperation(op, '0.6')!, EP6, 999, '0.6');
    return previewRequest({ method: 'personal_sign', params: [hash, signer] }, { now: NOW, chainId: 999, userOperation: { entryPoint: EP6, operation: op } }, failing);
  };
  let p = await unread(OWNER);
  assert.match(notes(p), new RegExp(`validation reverts on a stand-in for the signature \\(AA23[^)]*\\): ${other}, so only its calls were simulated`));
  assert.doesNotMatch(notes(p), /couldn't be read/);
  p = await unread(user);
  assert.match(notes(p), /validation reverts on a stand-in for the signature \(AA23[^)]*\): its signature carries a cosignature that its registry checks, and the registry couldn't be read, so only its calls were simulated/);

  // The registry read, with no verifying signer (its slot zero, taking the signer's cosignature): every cosignature
  // refused, said for certain, as read, not as unread.
  await slot1('0x00');
  p = await preview(op, user, '0.6');
  assert.match(notes(p), /The account doesn't accept a stand-in for the signature as theirs \(its registry \(0x82ea…e4dc\) has no verifying signer, so it refuses every cosignature: the account takes no operation, whoever signs it, until the registry's owner sets one\) and pays nothing toward its gas for a signature it refuses, so the EntryPoint rejects the operation \(AA21 didn't pay prefund\)/);
  assert.doesNotMatch(notes(p), /couldn't be read|needn't mean/);
  // And another key asked: the certain reason that is its own.
  p = await preview(op, OWNER, '0.6');
  assert.match(notes(p), new RegExp(`doesn't accept a stand-in for the signature as theirs \\(${other}\\)`));
  await slot1(fx.registry.signer as Hex);
});

test('Modular Account v2 through Aave Labs’ 2-of-2 multisig: stood in for, and the other signer named, only for an account that runs Modular Account v2’s code', async () => {
  const { readFileSync } = await import('node:fs');
  const { keccak256, encodeAbiParameters, parseAbiParameters, pad } = await import('viem');
  const { createAddressFromString: at, hexToBytes: toBytes } = await import('@ethereumjs/util');
  const fx = JSON.parse(readFileSync(new URL('./fixtures/mav2-multisig.json', import.meta.url), 'utf8')) as Record<'account' | 'implementation' | 'module', { address: string; code: Hex }> & { validation: { slot: Hex; word: Hex } };
  await chain.putCode(fx.implementation.address, fx.implementation.code);
  await chain.putCode(fx.module.address, fx.module.code);
  const put = (a: string, slot: Hex, v: Hex) => chain.evm.stateManager.putStorage(at(a), toBytes(slot), toBytes(v));
  const signersSlot = (account: string) => BigInt(keccak256(encodeAbiParameters(parseAbiParameters('address, bytes32'), [account as Hex, keccak256(encodeAbiParameters(parseAbiParameters('uint256, uint256'), [1n, 0n]))])));
  // An account set up as Modular Account v2's are, with `code`: its ERC-1967 slot naming Alchemy's implementation,
  // its validation for entity ID 1 Aave Labs' module, and the module's two signers for it (which any contract can
  // register for itself, installing the module).
  const install = async (account: string, signers: string[], code: Hex) => {
    await chain.putCode(account, code);
    await put(account, '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc', pad(fx.implementation.address as Hex));
    await put(account, fx.validation.slot, fx.validation.word);
    for (const [i, s] of signers.entries()) await put(fx.module.address, pad(`0x${(signersSlot(account) + BigInt(i)).toString(16)}`), pad(s as Hex));
    await chain.exec(usdc, call('mint', [account, 100_000_000n]));
    await chain.setBalance(account, E);
  };
  const user = privateKeyToAccount(`0x${'a3'.repeat(32)}`).address.toLowerCase(), app = privateKeyToAccount(`0x${'a4'.repeat(32)}`).address.toLowerCase();
  const nonce = numberToHex(((1n << 40n) | (1n << 8n) | 1n) << 64n);
  const notes = (p: Preview) => p.decoding.notes.join(' | ');
  const whole = (p: Preview) => p.decoding.notes.find(n => /whole operation was simulated as EntryPoint v0\.7/.test(n));

  // The factory's proxy (Solady's ERC-1967 proxy, as deployed): validated through the module, the other signer named.
  const real = '0x226f000000000000000000000000000000000041';
  await install(real, [user, app], fx.account.code);
  let p = await preview(operation({ sender: real, nonce }), user);
  assert.ok(whole(p) && !/doesn't accept/.test(whole(p)!), notes(p));
  assert.match(notes(p), new RegExp(`MultiSigValidationModule \\(0xcbec…a3e6, named by its nonce\\), which takes the signatures of both of the account's signers: the signer's key is one of the 2, and the other, ${app}, must sign`));

  // A look-alike: code of its own that pays its prefund and takes any operation (returning 0 for validateUserOp), the
  // same slot, validation and signers. Its run validates, as it would on-chain, with no signature needed: nothing is
  // said of a second signer it doesn't need.
  //   selector == validateUserOp ? (call(gas, caller, missingAccountFunds) ; return 0) : stop
  const acceptsAny = '0x60003560e01c6319822f7c14601057005b6000600060006000604435335af150600060005260206000f3' as Hex;
  const fake = '0x226f000000000000000000000000000000000042';
  await install(fake, [user, app], acceptsAny);
  p = await preview(operation({ sender: fake, nonce }), user);
  assert.ok(whole(p) && !/doesn't accept/.test(whole(p)!), notes(p));
  assert.doesNotMatch(notes(p), /MultiSigValidationModule|must sign the operation too/);
});

test('A whole operation’s trace: the EntryPoint’s run of it, from validation to the calls and the gas payment', async () => {
  const hash = userOpHash(readOperation(operation(), '0.7')!, EP, 999, '0.7');
  const p = await previewRequest({ method: 'personal_sign', params: [hash, OWNER] }, { now: NOW, chainId: 999, trace: true, userOperation: { entryPoint: EP, operation: operation() } }, deps);
  assert.deepEqual(usdcChange(p), ['out 50']);
  const t = p.trace!;
  assert.equal(t.agrees, true);
  // The EntryPoint's simulation call first, the account under it: its validation, then its execute, which transfers.
  assert.equal(t.calls[0].to, EP);
  const to = (a: string, selector: string) => t.calls.filter(c => c.to === a && c.selector === selector);
  assert.equal(to(account, '0x19822f7c').length, 1, 'validateUserOp');
  const transfer = t.calls.find(c => c.to === usdc && c.function === 'transfer(address,uint256)')!;
  assert.deepEqual([transfer.from, transfer.label, transfer.args!.map(a => a.value)], [account, 'USDC', [BOB, '50000000']]);
  assert.deepEqual(transfer.events!.map(e => e.name), ['Transfer']);
  // The stand-in for the signature shows as the call it is: ecrecover, asked by the account during validation.
  assert.ok(t.calls.some(c => c.to === '0x0000000000000000000000000000000000000001' && c.from === account));
  // The token's balances and the EntryPoint's books are among the state changed.
  assert.ok(t.stateChanges!.some(s => s.address === usdc && s.storage!.length === 2));
  assert.ok(t.stateChanges!.some(s => s.address === EP));
  // Not asked for: none.
  assert.equal((await preview(operation())).trace, undefined);
});

test('State the caller sets (context.stateOverrides) is what a whole operation runs on, beneath the stand-ins it needs', async () => {
  const runs: SimulationRequest[][] = [];
  const sim = deps.simulator!;
  const watched: Dependencies = { ...deps, simulator: { simulate: async r => { runs.push([r]); return sim.simulate(r); }, simulateBatch: async rs => { runs.push(rs); return sim.simulateBatch!(rs); } } };
  const run = (op: Record<string, unknown>, context: Record<string, unknown>, version: '0.6' | '0.7' = '0.7') => {
    const ep = version === '0.6' ? EP6 : EP;
    return previewRequest({ method: 'personal_sign', params: [userOpHash(readOperation(op, version)!, ep, 999, version), OWNER] }, { now: NOW, chainId: 999, userOperation: { entryPoint: ep, operation: op }, ...context }, watched);
  };
  const native = (p: Preview) => p.assetChanges.filter(c => c.asset === 'native').map(c => `${c.direction} ${c.amount}`);
  // The account holds 1 HYPE: sending 2 fails when the EntryPoint runs the calls.
  const sendTwo = operation({ callData: call('execute', [BOB, 2n * E, '0x']) });
  const own = await run(sendTwo, {});
  assert.ok(codes(own).includes('userop_execution_reverts') && !codes(own).includes('state_overridden'), codes(own).join());
  assert.ok(!own.decoding.notes.some(n => /context\.stateOverrides/.test(n)));
  // Given 5, it runs: the same whole operation (validation, the calls and the gas), on the state set, and said so.
  // The caller's code for ecrecover and the EntryPoint, and the slot the simulation code keeps its SenderCreator in,
  // give way to the stand-ins'; the caller's other slot at the EntryPoint stays.
  const SENDER_CREATOR_SLOT = `0x${'0'.repeat(63)}6`, OTHER_SLOT = `0x${'0'.repeat(62)}77`;
  runs.length = 0;
  const set = await run(sendTwo, { stateOverrides: { [account]: { balance: (5n * E).toString() }, '0x0000000000000000000000000000000000000001': { code: '0x00' }, [EP]: { code: '0x00', balance: '0x1', stateDiff: { '0x6': '0x1234', '0x77': '0x1' } } } });
  assert.ok(!codes(set).includes('userop_execution_reverts'), codes(set).join());
  assert.deepEqual(native(set), ['out 2']);
  assert.ok(set.decoding.notes.some(n => /whole operation was simulated as EntryPoint v0\.7 runs it/.test(n) && !/doesn't accept it as theirs/.test(n)), set.decoding.notes.join(' | '));
  assert.ok(set.details.some(d => d.label === 'Gas cost (simulated)'));
  assert.match(set.warnings.find(w => w.code === 'state_overridden')?.message ?? '', /^Simulated with state set by whoever asked for this preview \(balance, code, storage of 3 accounts\)/);
  assert.equal(set.warnings.filter(w => w.code === 'state_overridden').length, 1);
  assert.ok(!set.decoding.notes.some(n => /context\.stateOverrides/.test(n)), 'simulated with them: no note saying they were not');
  const whole = runs.find(rs => rs[0].to === EP)![0].stateOverrides!;
  assert.equal(whole[account].balance, `0x${(5n * E).toString(16)}`);
  assert.ok(whole['0x0000000000000000000000000000000000000001'].code!.includes(OWNER.slice(2)), 'ecrecover is the stand-in');
  assert.equal(whole['0x0000000000000000000000000000000000000001'].movePrecompileToAddress, '0x0000000000000000000000000000000000ec0001');
  assert.equal(whole[EP].code, ENTRY_POINT_SIMULATIONS_V07);
  assert.deepEqual([whole[EP].balance, whole[EP].stateDiff![OTHER_SLOT], whole[EP].stateDiff![SENDER_CREATOR_SLOT]], ['0x1', `0x${'0'.repeat(62)}01`, `0x${'0'.repeat(24)}efc2c1444ebcc4db75e7613d20c6a62ff67a167c`]);
  // EntryPoint v0.6 takes them too, and v0.9's typed operations.
  const v06 = await run(operation({ sender: account6, paymasterAndData: '0x', callData: call('execute', [BOB, 2n * E, '0x']) }), { stateOverrides: { [account6]: { balance: (5n * E).toString() } } }, '0.6');
  assert.deepEqual([native(v06), codes(v06).includes('state_overridden'), codes(v06).includes('userop_execution_reverts')], [['out 2'], true, false]);
  const typed = JSON.stringify({ domain: { name: 'ERC4337', version: '1', chainId: 999, verifyingContract: EP9 }, primaryType: 'PackedUserOperation',
    types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
      PackedUserOperation: [{ name: 'sender', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'initCode', type: 'bytes' }, { name: 'callData', type: 'bytes' }, { name: 'accountGasLimits', type: 'bytes32' }, { name: 'preVerificationGas', type: 'uint256' }, { name: 'gasFees', type: 'bytes32' }, { name: 'paymasterAndData', type: 'bytes' }] },
    message: { sender: account9, nonce: '0', initCode: '0x', callData: call('execute', [BOB, 2n * E, '0x']), accountGasLimits: concatHex([word(200_000n), word(200_000n)]), preVerificationGas: '50000', gasFees: concatHex([word(1_000_000_000n), word(2_000_000_000n)]), paymasterAndData: '0x' } });
  const v09 = (context: Record<string, unknown>) => previewRequest({ method: 'eth_signTypedData_v4', params: [OWNER, typed] }, { now: NOW, ...context }, deps);
  assert.ok(codes(await v09({})).includes('userop_execution_reverts'));
  const v09set = await v09({ stateOverrides: { [account9]: { balance: (5n * E).toString() } } });
  assert.deepEqual([native(v09set), codes(v09set).includes('state_overridden'), codes(v09set).includes('userop_execution_reverts')], [['out 2'], true, false]);
  assert.ok(v09set.decoding.notes.some(n => /whole operation was simulated as EntryPoint v0\.9 runs it/.test(n)));
});

test('An operation whose calls are run alone (the whole one is rejected) runs them on the state the caller set too', async () => {
  // A paymaster with no deposit: the EntryPoint rejects the operation (AA31), and its calls are simulated on their own.
  const sendTwo = operation({ ...withPaymaster(broke), callData: call('execute', [BOB, 2n * E, '0x']) });
  const hash = userOpHash(readOperation(sendTwo, '0.7')!, EP, 999, '0.7');
  const run = (context: Record<string, unknown>) => previewRequest({ method: 'personal_sign', params: [hash, OWNER] }, { now: NOW, chainId: 999, userOperation: { entryPoint: EP, operation: sendTwo }, ...context }, deps);
  const own = await run({});
  assert.ok(codes(own).includes('userop_rejected') && codes(own).includes('userop_execution_reverts'), codes(own).join());
  const set = await run({ stateOverrides: { [account]: { balance: (5n * E).toString() } } });
  assert.ok(codes(set).includes('userop_rejected') && !codes(set).includes('userop_execution_reverts'), codes(set).join());
  assert.deepEqual(set.assetChanges.filter(c => c.asset === 'native').map(c => `${c.direction} ${c.amount}`), ['out 2']);
  assert.ok(set.decoding.notes.some(n => /operation's calls were simulated as the EntryPoint runs it/.test(n)), set.decoding.notes.join(' | '));
  assert.ok(codes(set).includes('state_overridden'));
});

test('The caller’s state and a run’s own merge account by account and slot by slot, the run’s own winning where both set the same', async () => {
  const { mergeOverrides } = await import('../src/erc4337-sim.ts');
  const own = { '0x0000000000000000000000000000000000000001': { code: '0xaa', movePrecompileToAddress: '0x0000000000000000000000000000000000ec0001' }, [account]: { stateDiff: { [`0x${'0'.repeat(63)}1`]: '0x02' } } };
  assert.equal(mergeOverrides(undefined, own), own, 'nothing given: the run’s own as it is');
  assert.equal(mergeOverrides({}, own), own);
  const given = { '0x0000000000000000000000000000000000000001': { code: '0xbb', balance: '0x5' }, [account.toUpperCase().replace('0X', '0x')]: { balance: '0x9', stateDiff: { '0x1': '0x07', '0x2': '0x08' } }, [BOB]: { code: '0xcc' } };
  assert.deepEqual(mergeOverrides(given, own), {
    '0x0000000000000000000000000000000000000001': { code: '0xaa', balance: '0x5', movePrecompileToAddress: '0x0000000000000000000000000000000000ec0001' },
    [account]: { balance: '0x9', stateDiff: { [`0x${'0'.repeat(63)}1`]: '0x02', [`0x${'0'.repeat(63)}2`]: '0x08' } },
    [BOB]: { code: '0xcc' },
  });
  // Nothing of its own: the caller's, keyed and slotted as simulators take them.
  assert.deepEqual(mergeOverrides(given, undefined), { '0x0000000000000000000000000000000000000001': { code: '0xbb', balance: '0x5' }, [account]: { balance: '0x9', stateDiff: { [`0x${'0'.repeat(63)}1`]: '0x07', [`0x${'0'.repeat(63)}2`]: '0x08' } }, [BOB]: { code: '0xcc' } });
});

test('From Amsterdam on, calls that fail only for want of gas for new state run again with the reservoir bundlers give them', async () => {
  // Sepolia, 2026-11-19: a Safe app's operations signed with a call gas limit of 700,000 came in bundles of about 18
  // million gas, whose 1.2 million over the cap paid for the new state their calls wrote; the chain's node, which
  // gives a simulation's whole gas to the code, ran them out of gas (5 of 433 replayed, shown failing). Here an
  // operation whose call writes ten new slots on a call gas limit of 200,000: under Amsterdam's rules that state
  // (about 1.1 million gas) costs more than the call is given, unless the transaction carries gas over the cap for it.
  const SEPOLIA = 11155111, WRITER = '0x00000000000000000000000000000000c0de8037';
  await chain.putCode(WRITER, `0x${Array.from({ length: 10 }, (_, i) => `600160${(i + 1).toString(16).padStart(2, '0')}55`).join('')}00`);
  // The test chain as Sepolia, its blocks Amsterdam's (their headers carry a block access list hash) or not.
  const as = (amsterdam: boolean): typeof fetch => async (url, init) => {
    const body = JSON.parse(String(init!.body)) as { id: number; method: string } | { id: number; method: string }[];
    const blocks = new Set((Array.isArray(body) ? body : [body]).filter(c => c.method === 'eth_getBlockByNumber').map(c => c.id));
    const res = await chain.fetchImpl(url, init);
    if (!amsterdam || !blocks.size) return res;
    const out = await res.json() as { id: number; result?: Record<string, unknown> | null } | { id: number; result?: Record<string, unknown> | null }[];
    const add = (r: { id: number; result?: Record<string, unknown> | null }) => blocks.has(r.id) && r.result ? { ...r, result: { ...r.result, blockAccessListHash: `0x${'11'.repeat(32)}`, slotNumber: '0x1' } } : r;
    return new Response(JSON.stringify(Array.isArray(out) ? out.map(add) : add(out)), { headers: { 'content-type': 'application/json' } });
  };
  const on = (amsterdam: boolean): Dependencies => {
    const fetchImpl = as(amsterdam);
    return { tokens: new StaticTokenRegistry({}), rpc: new JsonRpcClient({ [SEPOLIA]: URL_ }, { fetchImpl }),
      simulator: new RpcSimulator({ [SEPOLIA]: URL_ }, { fetchImpl, fork: new ForkSimulator({ [SEPOLIA]: URL_ }, { fetchImpl }) }) };
  };
  const op = operation({ callData: call('execute', [WRITER, 0n, '0x']), callGasLimit: numberToHex(200_000n) });
  const ask = (deps_: Dependencies) => previewRequest({ method: 'personal_sign', params: [userOpHash(readOperation(op, '0.7')!, EP, SEPOLIA, '0.7'), OWNER] }, { now: NOW, chainId: SEPOLIA, userOperation: { entryPoint: EP, operation: op } }, deps_);
  const p = await ask(on(true));
  const notes = p.decoding.notes.join(' | ');
  assert.ok(!codes(p).includes('userop_execution_reverts'), `${codes(p)} ${notes}`);
  assert.match(notes, /Its calls run out of gas unless the bundle's transaction carries gas beyond the 16,777,216 a transaction's code runs on, which from Amsterdam on pays for new state only/);
  assert.match(notes, /on a transaction carrying 16,777,216 gas more for new state, as bundlers send such operations; sent without it, the calls fail and the account still pays for the gas/);
  // The new state, paid from the reservoir, isn't in the gas the EntryPoint counts (234,960 here, with validation and
  // the 50,000 of pre-verification): well under the 1.1 million it costs.
  const used = BigInt(String(p.details.find(d => d.label === 'Gas used (simulated)')?.raw));
  assert.ok(used < 400_000n, String(used));
  // Before Amsterdam (headers without the hash) there is no reservoir: the calls fail, as they would on-chain.
  const q = await ask(on(false));
  assert.ok(codes(q).includes('userop_execution_reverts'), codes(q).join());
  assert.ok(!q.decoding.notes.some(n => /Its calls run out of gas unless/.test(n)));
});
