// Simulating an ERC-4337 operation as the EntryPoint runs it. After validation, the EntryPoint deploys the account
// if it's new (through its SenderCreator, which calls the factory with factoryData) and then calls the account with
// the operation's callData, from the EntryPoint itself, or, when callData starts with executeUserOp's selector,
// with executeUserOp(userOp, userOpHash). Accounts that only take calls from the EntryPoint run as they will.
// What isn't simulated: validation (the signature), the gas prefund and refund, and a paymaster's postOp charge.
import { decodeAbiParameters, encodeAbiParameters, encodeFunctionData, parseAbi, type Hex } from 'viem';
import type { Dependencies, SimulationRequest, SimulationResult } from './types.ts';

/** Each EntryPoint's SenderCreator: v0.8 and v0.9 report theirs (senderCreator()); v0.6's and v0.7's are fixed. */
export const SENDER_CREATORS: Record<string, string> = {
  '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789': '0x7fc98430eaedbb6070b35b39d798725049088348',
  '0x0000000071727de22e5e9d8baf0edac6f37da032': '0xefc2c1444ebcc4db75e7613d20c6a62ff67a167c',
  '0x4337084d9e255ff0702461cf8895ce9e3b5ff108': '0x449ed7c3e6fee6a97311d4b55475df59c44add33',
  '0x433709009b8330fda32311df1c2afa402ed8d009': '0x0a630a99df908a81115a3022927be82f9299987e',
};
const EXECUTE_USER_OP = '0x8dd7712f';
const PACKED = parseAbi(['function executeUserOp((address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature) userOp, bytes32 userOpHash)']);

export interface ExecutionInput {
  chainId: number; entryPoint: string; sender: string; callData: Hex;
  /** Factory + factoryData, when the operation deploys the account. */
  initCode?: Hex;
  /** EIP-7702: the delegate the account will have when the operation runs, if it doesn't have it yet. */
  delegate?: string;
  /** For executeUserOp: the operation in the EntryPoint's packed form, and its hash (zero if unknown). */
  packed?: { nonce: bigint; initCode: Hex; accountGasLimits: Hex; preVerificationGas: bigint; gasFees: Hex; paymasterAndData: Hex };
  userOpHash?: Hex;
  /** The gas the EntryPoint gives the call (callGasLimit). */
  callGasLimit?: bigint;
  watch?: string[];
}

export interface Execution { result: SimulationResult; deployed: boolean; direct?: boolean; /** The account has no code: calling it runs nothing (it may get an EIP-7702 delegation in the same transaction). */ noCode?: boolean }

/** Cold-access costs a standalone call pays that the EntryPoint's call doesn't: a few accounts (2,600) and slots (2,100). */
const COLD_HEADROOM = 25_000n;

/** Calldata gas plus the 21,000 base: added to callGasLimit so the simulated call gets the gas the EntryPoint gives it. */
const intrinsic = (data: Hex) => { let g = 21_000n; for (let i = 2; i < data.length; i += 2) g += data.slice(i, i + 2) === '00' ? 4n : 16n; return g; };

const CALLS = [{ type: 'tuple[]', components: [{ name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }] }] as const;
const CALL = [{ type: 'address' }, { type: 'uint256' }, { type: 'bytes' }] as const;
/**
 * The calls an account's execute function makes, read from its arguments whatever the selector: a batch of
 * (target, value, data), or one (target, value, data). Only when the arguments are exactly that encoding.
 */
export function callsOf(callData: Hex): { to: string; value: bigint; data: Hex }[] | null {
  const args = `0x${callData.slice(10)}` as Hex;
  try { const [calls] = decodeAbiParameters(CALLS, args); if (encodeAbiParameters(CALLS, [calls]) === args.toLowerCase() && calls.length) return calls.map(c => ({ to: c.target.toLowerCase(), value: c.value, data: c.data })); } catch { /* not a batch */ }
  try { const [to, value, data] = decodeAbiParameters(CALL, args); if (encodeAbiParameters(CALL, [to, value, data]) === args.toLowerCase()) return [{ to: to.toLowerCase(), value, data }]; } catch { /* not one call */ }
  return null;
}

/** Whether code executes TLOAD (0x5c), skipping PUSH data: an account that keeps validation state in transient storage. */
export function readsTransientStorage(code: string): boolean {
  const hex = code.startsWith('0x') ? code.slice(2) : code;
  for (let i = 0; i < hex.length; i += 2) {
    const op = parseInt(hex.slice(i, i + 2), 16);
    if (op === 0x5c) return true;
    if (op >= 0x60 && op <= 0x7f) i += (op - 0x5f) * 2;
  }
  return false;
}

/** The code that runs for an account: its own, its EIP-7702 delegate's, or its EIP-1967 implementation's. */
async function runningCode(deps: Dependencies, chainId: number, account: string): Promise<string | undefined> {
  if (!deps.rpc?.has(chainId)) return undefined;
  const get = async (a: string) => String(await deps.rpc!.call(chainId, 'eth_getCode', [a, 'latest']));
  try {
    let code = await get(account);
    if (/^0xef0100[0-9a-f]{40}$/i.test(code)) code = await get(`0x${code.slice(8)}`);
    const slot = String(await deps.rpc.call(chainId, 'eth_getStorageAt', [account, '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc', 'latest']));
    if (code.length < 400 && /^0x0*[1-9a-f]/i.test(slot)) code = await get(`0x${slot.slice(-40)}`);
    return code;
  } catch { return undefined; }
}

/** Whether an account has code now (undefined without an RPC). */
async function hasCode(deps: Dependencies, chainId: number, address: string): Promise<boolean | undefined> {
  if (!deps.rpc?.has(chainId)) return undefined;
  try { return String(await deps.rpc.call(chainId, 'eth_getCode', [address, 'latest'])) !== '0x'; } catch { return undefined; }
}

/**
 * The operation's execution phase, simulated. Null when there's no simulator, the simulator doesn't cover the chain,
 * or (deploying) it can't run calls from two senders in order.
 */
export async function simulateExecution(op: ExecutionInput, deps: Dependencies): Promise<Execution | null> {
  const sim = deps.simulator;
  if (!sim) return null;
  const entryPoint = op.entryPoint.toLowerCase(), sender = op.sender.toLowerCase();
  let data = op.callData;
  if (data.toLowerCase().startsWith(EXECUTE_USER_OP) && op.packed) {
    data = encodeFunctionData({ abi: PACKED, functionName: 'executeUserOp', args: [{ sender: sender as Hex, ...op.packed, callData: op.callData, signature: '0x' }, op.userOpHash ?? `0x${'00'.repeat(32)}`] });
  }
  const exec: SimulationRequest = { chainId: op.chainId, from: entryPoint, account: sender, to: sender, data, value: 0n, ...(op.watch?.length && { watch: op.watch }),
    // With headroom: on-chain, validation (and a token paymaster's checks) has already warmed the contracts and
    // slots the call reads, so a standalone run pays cold-access costs the operation doesn't (EIP-2929).
    ...(op.callGasLimit !== undefined && op.callGasLimit > 0n && { gas: op.callGasLimit + op.callGasLimit / 10n + COLD_HEADROOM + intrinsic(data) }),
    ...(op.delegate && { stateOverrides: { [sender]: { code: `0xef0100${op.delegate.toLowerCase().slice(2)}` } } }) };
  // A new account: the SenderCreator calls the factory first, as the EntryPoint has it do.
  const factory = op.initCode && op.initCode.length >= 42 && !op.delegate ? `0x${op.initCode.slice(2, 42)}`.toLowerCase() : null;
  const creator = SENDER_CREATORS[entryPoint];
  if (factory && (await hasCode(deps, op.chainId, sender)) !== true) {
    if (!creator || !sim.simulateBatch) return null;
    const deploy: SimulationRequest = { chainId: op.chainId, from: creator, account: sender, to: factory, data: `0x${op.initCode!.slice(42)}` as Hex, value: 0n };
    const results = await sim.simulateBatch([deploy, exec]);
    if (!results) return null;
    if (results[0].status === 'reverted') return { result: { ...results[0], revertReason: `deploying the account failed${results[0].revertReason ? `: ${results[0].revertReason}` : ''}` }, deployed: true };
    return { result: results[1], deployed: true };
  }
  if (!factory && !op.delegate && (await hasCode(deps, op.chainId, sender)) === false) return { result: { status: 'success', source: 'no code at the account', transfers: [], limited: true }, deployed: false, noCode: true };
  const result = await sim.simulate(exec);
  if (!result) return null;
  // An account that only runs calls it validated in the same transaction (a flag in transient storage, set by
  // validateUserOp) can't be run this way before it's signed: its calls are simulated directly from the account.
  if (result.status === 'reverted' && !op.delegate) {
    const code = await runningCode(deps, op.chainId, sender);
    const calls = code && readsTransientStorage(code) ? callsOf(op.callData) : null;
    if (calls) {
      const reqs: SimulationRequest[] = calls.map(c => ({ chainId: op.chainId, from: sender, to: c.to, data: c.data, value: c.value, ...(op.watch?.length && { watch: op.watch }) }));
      const results = reqs.length === 1 ? [await sim.simulate(reqs[0])] : sim.simulateBatch ? await sim.simulateBatch(reqs) : null;
      if (results && results.every(r => r)) {
        const failed = results.find(r => r!.status === 'reverted');
        const merged: SimulationResult = failed ?? { ...results[results.length - 1]!, transfers: results.flatMap(r => r!.transfers), nftTransfers: results.flatMap(r => r!.nftTransfers ?? []), approvals: results.flatMap(r => r!.approvals ?? []) };
        return { result: merged, deployed: false, direct: true };
      }
    }
  }
  return { result, deployed: false };
}

/** The EntryPoint deposit of an account or paymaster (StakeManager.balanceOf), undefined without an RPC. */
export async function entryPointDeposit(deps: Dependencies, chainId: number, entryPoint: string, account: string): Promise<bigint | undefined> {
  if (!deps.rpc?.has(chainId)) return undefined;
  try { return BigInt(String(await deps.rpc.call(chainId, 'eth_call', [{ to: entryPoint, data: `0x70a08231${account.toLowerCase().slice(2).padStart(64, '0')}` }, 'latest']))); } catch { return undefined; }
}
