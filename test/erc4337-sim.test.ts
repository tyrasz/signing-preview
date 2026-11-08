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
import { ENTRY_POINT_SIMULATIONS_V06, ENTRY_POINT_SIMULATIONS_V07 } from '../src/entrypoint-simulations.ts';
import { readOperation, userOpHash } from '../src/userop-hash.ts';
import type { Dependencies, Preview } from '../src/types.ts';
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
// The EntryPoint's storage is what matters (deposits, nonces): its code here is the simulation's own, which has depositTo.
await chain.putCode(EP, ENTRY_POINT_SIMULATIONS_V07 as Hex);
const A = parseAbi(['function mint(address,uint256)', 'function approve(address,uint256)', 'function transfer(address,uint256)', 'function depositTo(address)', 'function execute(address,uint256,bytes)']);
const call = (fn: string, args: unknown[]) => encodeFunctionData({ abi: A, functionName: fn, args } as never);
await chain.exec(usdc, call('mint', [account, 100_000_000n]));
await chain.exec(usdc, call('mint', [account6, 100_000_000n]));
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

test('EntryPoint v0.6: the patched EntryPoint returns its simulateHandleOp result, so the operation’s logs and gas are kept', async () => {
  const p = await preview(operation({ sender: account6, paymasterAndData: '0x' }), OWNER, '0.6');
  assert.deepEqual(usdcChange(p), ['out 50']);
  assert.ok(BigInt(String(p.details.find(d => d.label === 'Gas cost (simulated)')?.raw)) > 50_000n * 10n ** 9n);
  assert.ok(p.decoding.notes.some(n => /whole operation was simulated as EntryPoint v0\.6 runs it/.test(n)), p.decoding.notes.join(' | '));
  assert.ok(!p.decoding.notes.some(n => /doesn't accept it as theirs/.test(n)));
});
