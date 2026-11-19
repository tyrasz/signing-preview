// Simulating an ERC-4337 operation as the EntryPoint runs it.
//
// simulateOperation runs the whole operation: the EntryPoint's code is replaced (by a state override) with
// eth-infinitism's EntryPointSimulations, which keeps the EntryPoint's storage and SenderCreator and whose
// simulateHandleOp validates the operation (deploying the account if it's new, the account's validateUserOp, the
// nonce, the prefund, the paymaster's validation), runs its calls and charges for gas (the paymaster's postOp
// included), returning instead of reverting: what the operation will do, gas and paymaster fees included. The
// owner's signature can't exist before they sign, so a stand-in is validated: accounts report it as failed (which
// simulateHandleOp doesn't stop at) unless their check reverts on its shape.
//
// simulateExecution runs only the execution phase, for EntryPoints and accounts the above can't run: the account
// deployed through its SenderCreator if it's new, then called with the operation's callData from the EntryPoint
// (or with executeUserOp(userOp, userOpHash) when callData starts with its selector). Validation, the gas prefund
// and refund, and a paymaster's postOp charge aren't part of it.
import { bytesToHex, concatHex, decodeAbiParameters, decodeFunctionData, decodeFunctionResult, encodeAbiParameters, getAddress, getContractAddress, hashMessage, hashTypedData, keccak256, encodeFunctionData, hexToBytes, numberToHex, parseAbi, parseAbiParameters, recoverAddress, sha256, stringToHex, toFunctionSelector, type Hex } from 'viem';
import { p256 } from '@noble/curves/nist';
import type { Dependencies, SimulationRequest, SimulationResult } from './types.ts';
import { pinLatest, type BlockAt } from './block.ts';
import { decodeRevert } from './simulation.ts';
import { ecrecoverPrice } from './chains.ts';
import { KERNEL_ENABLE_FIELDS, KERNEL_V3_IMPLEMENTATIONS } from './typed-data/kernel-enable.ts';
import { ENTRY_POINT_SIMULATIONS_V06, ENTRY_POINT_SIMULATIONS_V06_IMMUTABLES, ENTRY_POINT_SIMULATIONS_V06_SLOTS, ENTRY_POINT_SIMULATIONS_V07, ENTRY_POINT_SIMULATIONS_V07_IMMUTABLES, ENTRY_POINT_SIMULATIONS_V07_SLOTS,
  ENTRY_POINT_SIMULATIONS_V08, ENTRY_POINT_SIMULATIONS_V08_IMMUTABLES, ENTRY_POINT_SIMULATIONS_V08_SLOTS, ENTRY_POINT_SIMULATIONS_V09, ENTRY_POINT_SIMULATIONS_V09_IMMUTABLES, ENTRY_POINT_SIMULATIONS_V09_SLOTS } from './entrypoint-simulations.ts';

/** Each EntryPoint's SenderCreator: v0.8 and v0.9 report theirs (senderCreator()); v0.6's and v0.7's are fixed. */
export const SENDER_CREATORS: Record<string, string> = {
  '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789': '0x7fc98430eaedbb6070b35b39d798725049088348',
  '0x0000000071727de22e5e9d8baf0edac6f37da032': '0xefc2c1444ebcc4db75e7613d20c6a62ff67a167c',
  '0x4337084d9e255ff0702461cf8895ce9e3b5ff108': '0x449ed7c3e6fee6a97311d4b55475df59c44add33',
  '0x433709009b8330fda32311df1c2afa402ed8d009': '0x0a630a99df908a81115a3022927be82f9299987e',
};
const EXECUTE_USER_OP = '0x8dd7712f';
/** ZeroDev's FactoryStaker, which deploys Kernel v3 accounts (deployWithFactory). */
const KERNEL_FACTORY_STAKER = '0xd703aae79538628d27099b8c4f621be4ccd142d5';
/** Kernel v3.1, v3.2 and v3.3 (accountId()), which keep each operation's execution hook in executionHook[userOpHash] (slot 0). */
const KERNEL_V3_EXECUTION_HOOK = new Set(['0xbac849bb641841b44e965fb01a4bf5f074f84b4d', '0xd830d15d3dc0c269f3dbaa0f3e8626d33cfdabe1', '0xd6cedde84be40893d153be9d467cd6ad37875b28']);
const PACKED = parseAbi(['function executeUserOp((address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature) userOp, bytes32 userOpHash)']);

type Overrides = NonNullable<SimulationRequest['stateOverrides']>;
/** A storage slot as eth_simulateV1 takes it: 32 bytes of lowercase hex. */
const slotKey = (slot: string) => `0x${slot.replace(/^0x/i, '').toLowerCase().padStart(64, '0')}`;
/**
 * The state a run sets for itself (`own`: the stand-ins for signatures that can't exist yet, the EntryPoint's
 * simulation code, an EIP-7702 delegation the operation is signed for) over the state the caller set
 * (PreviewContext.stateOverrides, `given`), account by account and slot by slot: where both set the same field of an
 * account (its code, its balance) or the same storage slot, the run's own wins, since the stand-ins don't work
 * without it; the caller's other fields and slots stay. Without anything given, `own` as it is.
 */
export function mergeOverrides(given: SimulationRequest['stateOverrides'], own: SimulationRequest['stateOverrides']): SimulationRequest['stateOverrides'] {
  if (!given || !Object.keys(given).length) return own;
  const out: Overrides = {};
  for (const [a, o] of [...Object.entries(given), ...Object.entries(own ?? {})]) {
    const k = a.toLowerCase(), prev = out[k] ?? {};
    const stateDiff = prev.stateDiff || o.stateDiff ? Object.fromEntries([...Object.entries(prev.stateDiff ?? {}), ...Object.entries(o.stateDiff ?? {})].map(([s, v]) => [slotKey(s), v])) : undefined;
    out[k] = { ...prev, ...o, ...(stateDiff && { stateDiff }) };
  }
  return out;
}

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
  /** State the caller set for the simulation (PreviewContext.stateOverrides), beneath the run's own (see mergeOverrides). */
  stateOverrides?: SimulationRequest['stateOverrides'];
  /** The bundler to deploy the account as (tx.origin), for a factory that only deploys for its own (see simulateOperation). */
  origin?: string;
  /** Calls run first, for the state the calls start from: earlier operations of the same supertransaction (OperationInput.before). */
  before?: SimulationRequest[];
}

/**
 * Code for the SenderCreator's address that calls a factory as the SenderCreator does (calldata: the factory's
 * address, then its data), returning or reverting with what the factory does: a deployment sent by someone else
 * than the SenderCreator, for a factory that checks the transaction's origin.
 *   len = calldatasize - 20; calldatacopy(0, 20, len); ok = call(gas, calldata[0:20], 0, 0, len, 0, 0)
 *   returndatacopy(0, 0, returndatasize); if ok return(0, returndatasize) else revert(0, returndatasize)
 */
export const SENDER_FORWARDER = '0x366014900380601460003760006000826000600060003560601c5af13d600060003e6029573d6000fd5b3d6000f3' as Hex;

export interface Execution {
  result: SimulationResult; deployed: boolean; direct?: boolean;
  /** The account has no code: calling it runs nothing (it may get an EIP-7702 delegation in the same transaction). */
  noCode?: boolean;
  /** What was simulated for `result` (the deployment first, for a new account), without `before`: for operations after it. */
  requests?: SimulationRequest[];
}

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

/** Instructions that end execution: nothing after one runs unless it is jumped to (a JUMPDEST). */
const HALTS = new Set([0x00, 0x56, 0xf3, 0xfd, 0xfe, 0xff]); // STOP, JUMP, RETURN, REVERT, INVALID, SELFDESTRUCT
/**
 * Whether code has this opcode where it can run: not in PUSH data, the Solidity compiler's metadata (CBOR at the end,
 * its length in the last two bytes), or bytes no instruction can reach (after one that ends execution, up to the next
 * JUMPDEST), which can hold any byte. The compiler puts its data there, after the code: a Base account implementation
 * keeps "\x19Ethereum Signed Message:\n32" so, whose "32" is CALLER and ORIGIN's bytes (0x33 0x32).
 */
export function executes(code: string, opcode: number): boolean {
  let hex = (code.startsWith('0x') ? code.slice(2) : code).toLowerCase();
  const meta = hex.length >= 4 ? parseInt(hex.slice(-4), 16) : 0;
  if (meta > 0 && (meta + 2) * 2 <= hex.length && /^a[1-4]/.test(hex.slice(-(meta + 2) * 2))) hex = hex.slice(0, -(meta + 2) * 2);
  // `live`: the instruction at i can be reached (from the start, by running on, or by a jump to a JUMPDEST: the EVM's
  // own reading of where JUMPDESTs are, PUSH data skipped from the start, data regions included).
  let live = true;
  for (let i = 0; i < hex.length; i += 2) {
    const op = parseInt(hex.slice(i, i + 2), 16);
    if (op === 0x5b) live = true;
    if (live && op === opcode) return true;
    if (op >= 0x60 && op <= 0x7f) i += (op - 0x5f) * 2;
    else if (HALTS.has(op)) live = false;
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

const KERNEL_VALIDATION = parseAbi(['function rootValidator() view returns (bytes21)', 'function validationConfig(bytes21 vId) view returns (uint32 nonce, address hook)']);
/**
 * The execution hook Kernel v3's validateUserOp stores for an operation, as a storage word: its validation's
 * (validationConfig(vId).hook, vId from the nonce as Kernel decodes it: the type byte and the validator's 20 bytes, or
 * a permission's 4; the root's, rootValidator(), for type 0x00). address(1), none, where it can't be read or none is
 * installed yet (enable mode installs it in validation itself).
 */
async function kernelExecutionHook(deps: Dependencies, chainId: number, sender: string, nonce: bigint): Promise<Hex> {
  const none = `0x${'1'.padStart(64, '0')}` as Hex;
  const rpc = deps.rpc?.has(chainId) ? deps.rpc : undefined;
  if (!rpc) return none;
  const view = async (data: Hex) => String(await rpc.call(chainId, 'eth_call', [{ to: sender, data }, 'latest']));
  try {
    const n = nonce.toString(16).padStart(64, '0');
    const type = n.slice(2, 4);
    let vId = `0x${type}${type === '02' ? n.slice(4, 12).padEnd(40, '0') : n.slice(4, 44)}` as Hex;
    if (type === '00') {
      const root = await view(encodeFunctionData({ abi: KERNEL_VALIDATION, functionName: 'rootValidator' }));
      if (!/^0x[0-9a-f]{64}$/i.test(root)) return none;
      vId = root.slice(0, 44) as Hex;
    }
    const config = await view(encodeFunctionData({ abi: KERNEL_VALIDATION, functionName: 'validationConfig', args: [vId] }));
    if (!/^0x[0-9a-f]{128}$/i.test(config)) return none;
    const hook = BigInt(`0x${config.slice(66 + 24)}`);
    // A validator or permission the nonce names that isn't installed (no hook at all), outside enable mode (byte 0
    // 0x01, which installs it in validation): Kernel refuses the operation in validation (InvalidValidator), so the
    // calls are given no hook either, and fail, rather than run as if it were installed.
    if (hook === 0n && type !== '00' && n.slice(0, 2) !== '01') return `0x${'00'.repeat(32)}` as Hex;
    return hook > 1n ? `0x${hook.toString(16).padStart(64, '0')}` as Hex : none;
  } catch { return none; }
}

/**
 * The operation's execution phase, simulated. Null when there's no simulator, the simulator doesn't cover the chain,
 * or (deploying) it can't run calls from two senders in order.
 */
export async function simulateExecution(op: ExecutionInput, deps: Dependencies): Promise<Execution | null> {
  const sim = deps.simulator;
  if (!sim) return null;
  // The calls, after `before` where there is any (their results left out).
  const pre = op.before ?? [];
  const entryPoint = op.entryPoint.toLowerCase(), sender = op.sender.toLowerCase();
  // (The EntryPoint answers balanceOf with deposits: a simulator that reads it around the calls, where they or an
  // operation before them name it, reports the account's deposit as a token's balance. It is no token but the
  // account's own coin, as in a whole operation's changes (withoutGas, with no gas, which isn't paid here): what the
  // calls give someone else of it is listed as the native coin sent, and what they keep in it isn't.)
  const own = (r: SimulationResult | null) => r && { ...r, transfers: withoutGas(r, sender, entryPoint, 0n) };
  const batch = async (reqs: SimulationRequest[]): Promise<(SimulationResult | null)[] | null> => (pre.length
    ? (sim.simulateBatch ? (await sim.simulateBatch([...pre, ...reqs]))?.slice(pre.length) ?? null : null)
    : reqs.length === 1 ? [await sim.simulate(reqs[0])] : sim.simulateBatch ? await sim.simulateBatch(reqs) : null)?.map(own) ?? null;
  let data = op.callData;
  if (data.toLowerCase().startsWith(EXECUTE_USER_OP) && op.packed) {
    data = encodeFunctionData({ abi: PACKED, functionName: 'executeUserOp', args: [{ sender: sender as Hex, ...op.packed, callData: op.callData, signature: '0x' }, op.userOpHash ?? `0x${'00'.repeat(32)}`] });
  }
  // Kernel v3 runs executeUserOp's calls between the preCheck and postCheck of the execution hook validateUserOp
  // stored for the operation's hash (executionHook[userOpHash], the mapping in its slot 0): with none stored, it
  // calls address(0) as the hook and reverts, as calls of an operation that succeeded did on Polygon and Base. Stored
  // here as validation stores it (kernelExecutionHook): the hook its validator or permission was installed with, which
  // can refuse the calls (on Base, a permission's hook refusing calls to modules: ModuleCallNotAllowed).
  let hook: Record<string, Hex> | undefined;
  if (data !== op.callData && !op.initCode && op.packed) {
    const runs = op.delegate?.toLowerCase() ?? await implementationOf(deps, op.chainId, sender);
    if (runs && KERNEL_V3_EXECUTION_HOOK.has(runs)) {
      hook = { [keccak256(concatHex([op.userOpHash ?? `0x${'00'.repeat(32)}`, `0x${'00'.repeat(32)}`]))]: await kernelExecutionHook(deps, op.chainId, sender, op.packed.nonce) };
    }
  }
  const exec: SimulationRequest = { chainId: op.chainId, from: entryPoint, account: sender, to: sender, data, value: 0n, ...(op.watch?.length && { watch: op.watch }),
    // With headroom: on-chain, validation (and a token paymaster's checks) has already warmed the contracts and
    // slots the call reads, so a standalone run pays cold-access costs the operation doesn't (EIP-2929).
    ...(op.callGasLimit !== undefined && op.callGasLimit > 0n && { gas: op.callGasLimit + op.callGasLimit / 10n + COLD_HEADROOM + intrinsic(data) }),
    // The caller's state (op.stateOverrides) beneath the run's own: the delegation the operation expects and the hook.
    ...((op.delegate || hook || op.stateOverrides) && { stateOverrides: mergeOverrides(op.stateOverrides, (op.delegate || hook) ? { [sender]: { ...(op.delegate && { code: `0xef0100${op.delegate.toLowerCase().slice(2)}` as Hex }), ...(hook && { stateDiff: hook }) } } : undefined) }) };
  // Whether the account has code: the code the caller set for it, else the chain's.
  const given = op.stateOverrides?.[sender]?.code;
  const deployed = async () => (given !== undefined ? given !== '0x' : hasCode(deps, op.chainId, sender));
  // A new account: the SenderCreator calls the factory first, as the EntryPoint has it do.
  const factory = op.initCode && op.initCode.length >= 42 && !op.delegate ? `0x${op.initCode.slice(2, 42)}`.toLowerCase() : null;
  const creator = SENDER_CREATORS[entryPoint];
  if (factory && (await deployed()) !== true) {
    if (!creator || !sim.simulateBatch) return null;
    // As a bundler the factory takes, where it only deploys for its own: from it, through the SenderCreator's address.
    const deploy: SimulationRequest = op.origin
      ? { chainId: op.chainId, from: op.origin.toLowerCase(), account: sender, to: creator, data: op.initCode!, value: 0n, stateOverrides: { [creator]: { code: SENDER_FORWARDER } } }
      : { chainId: op.chainId, from: creator, account: sender, to: factory, data: `0x${op.initCode!.slice(42)}` as Hex, value: 0n };
    // An operation with no calls: its deployment alone (the EntryPoint calls the account only with callData).
    const noCalls = op.callData === '0x';
    const results = await batch(noCalls ? [deploy] : [deploy, exec]);
    if (!results?.[0] || (!noCalls && !results[1])) return null;
    if (results[0].status === 'reverted') return { result: { ...results[0], revertReason: `deploying the account failed${results[0].revertReason ? `: ${results[0].revertReason}` : ''}` }, deployed: true, requests: [deploy] };
    if (noCalls || !results[1]) return { result: results[0], deployed: true, requests: [deploy] };
    // A Kernel v3 that ZeroDev's FactoryStaker deploys has no execution hook stored for executeUserOp either (above),
    // and storage can't be set at an address before it's created: its calls as executeUserOp runs them, callData
    // after the selector, from the EntryPoint (which Kernel's execute accepts), without the hook.
    if (results[1].status === 'reverted' && data !== op.callData && factory === KERNEL_FACTORY_STAKER) {
      const plain = { ...exec, data: `0x${op.callData.slice(10)}` as Hex };
      const direct = await batch([deploy, plain]);
      if (direct?.[0] && direct[1] && direct[0].status !== 'reverted') return { result: direct[1], deployed: true, requests: [deploy, plain] };
    }
    return { result: results[1], deployed: true, requests: [deploy, exec] };
  }
  // No calls and nothing to deploy: nothing runs.
  if (op.callData === '0x') return null;
  // (After earlier operations, one of them may have deployed or delegated the account: the calls are run.)
  if (!pre.length && !factory && !op.delegate && (await deployed()) === false) return { result: { status: 'success', source: 'no code at the account', transfers: [], limited: true }, deployed: false, noCode: true };
  const result = (await batch([exec]))?.[0];
  if (!result) return null;
  // An account that only runs calls it validated in the same transaction (a flag in transient storage, set by
  // validateUserOp) can't be run this way before it's signed: its calls are simulated directly from the account.
  if (result.status === 'reverted' && !op.delegate) {
    const code = await runningCode(deps, op.chainId, sender);
    const calls = code && readsTransientStorage(code) ? callsOf(op.callData) : null;
    if (calls) {
      const reqs: SimulationRequest[] = calls.map(c => ({ chainId: op.chainId, from: sender, to: c.to, data: c.data, value: c.value, ...(op.watch?.length && { watch: op.watch }), ...(op.stateOverrides && { stateOverrides: op.stateOverrides }) }));
      const results = await batch(reqs);
      if (results && results.every(r => r)) {
        const failed = results.find(r => r!.status === 'reverted');
        const merged: SimulationResult = failed ?? { ...results[results.length - 1]!, transfers: results.flatMap(r => r!.transfers), nftTransfers: results.flatMap(r => r!.nftTransfers ?? []), approvals: results.flatMap(r => r!.approvals ?? []) };
        return { result: merged, deployed: false, direct: true, requests: reqs };
      }
    }
  }
  return { result, deployed: false, requests: [exec] };
}

/** The EntryPoint deposit of an account or paymaster (StakeManager.balanceOf), undefined without an RPC. */
export async function entryPointDeposit(deps: Dependencies, chainId: number, entryPoint: string, account: string): Promise<bigint | undefined> {
  if (!deps.rpc?.has(chainId)) return undefined;
  try { return BigInt(String(await deps.rpc.call(chainId, 'eth_call', [{ to: entryPoint, data: `0x70a08231${account.toLowerCase().slice(2).padStart(64, '0')}` }, 'latest']))); } catch { return undefined; }
}

/** The simulation code for each EntryPoint (see entrypoint-simulations.ts), with where its immutables and own storage are. */
const SIMULATIONS: Record<string, { version: '0.6' | '0.7' | '0.8' | '0.9'; code: string; immutables: Record<string, number[]>; slots: Record<string, string> }> = {
  '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789': { version: '0.6', code: ENTRY_POINT_SIMULATIONS_V06, immutables: ENTRY_POINT_SIMULATIONS_V06_IMMUTABLES, slots: ENTRY_POINT_SIMULATIONS_V06_SLOTS },
  '0x0000000071727de22e5e9d8baf0edac6f37da032': { version: '0.7', code: ENTRY_POINT_SIMULATIONS_V07, immutables: ENTRY_POINT_SIMULATIONS_V07_IMMUTABLES, slots: ENTRY_POINT_SIMULATIONS_V07_SLOTS },
  '0x4337084d9e255ff0702461cf8895ce9e3b5ff108': { version: '0.8', code: ENTRY_POINT_SIMULATIONS_V08, immutables: ENTRY_POINT_SIMULATIONS_V08_IMMUTABLES, slots: ENTRY_POINT_SIMULATIONS_V08_SLOTS },
  '0x433709009b8330fda32311df1c2afa402ed8d009': { version: '0.9', code: ENTRY_POINT_SIMULATIONS_V09, immutables: ENTRY_POINT_SIMULATIONS_V09_IMMUTABLES, slots: ENTRY_POINT_SIMULATIONS_V09_SLOTS },
};
/** OpenZeppelin's ShortString: a string of up to 31 bytes, left-aligned, its length in the last byte. */
const shortString = (text: string) => `${stringToHex(text).slice(2).padEnd(62, '0')}${text.length.toString(16).padStart(2, '0')}`;
const EIP712_DOMAIN = keccak256(stringToHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'));
/**
 * The state override that puts an EntryPoint's simulation code in its place on this chain: the code with the
 * immutables its constructor would have set (the EIP-712 name and version of v0.8 on), and the storage
 * EntryPointSimulations sets for itself when a simulation starts (its SenderCreator, the first contract the
 * EntryPoint created, and from v0.8 the EIP-712 domain separator operations are hashed with). Without that storage,
 * a plain handleOps in the same simulated block (an earlier bundle, replayed before the operation) hashed operations
 * with a zero domain and failed on its real signatures, and couldn't deploy accounts.
 */
export function entryPointOverride(entryPoint: string, chainId: number): { code: Hex; stateDiff?: Record<string, Hex> } | undefined {
  const ep = SIMULATIONS[entryPoint.toLowerCase()];
  if (!ep) return undefined;
  const words: Record<string, string> = { _name: shortString('ERC4337'), _version: shortString('1') };
  let code = ep.code.slice(2);
  for (const [name, starts] of Object.entries(ep.immutables)) {
    const word = words[name];
    if (word) for (const at of starts) code = `${code.slice(0, at * 2)}${word}${code.slice(at * 2 + 64)}`;
  }
  const word = (v: string) => `0x${v.replace(/^0x/, '').padStart(64, '0')}` as Hex;
  const domain = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
    [EIP712_DOMAIN, keccak256(stringToHex('ERC4337')), keccak256(stringToHex('1')), BigInt(chainId), getAddress(entryPoint)]));
  const values: Record<string, Hex> = { _senderCreator: word(getContractAddress({ from: getAddress(entryPoint), nonce: 1n }).toLowerCase()), __domainSeparatorV4: domain };
  const stateDiff = Object.fromEntries(Object.entries(ep.slots).filter(([name]) => values[name]).map(([name, slot]) => [slot, values[name]]));
  return { code: `0x${code}` as Hex, ...(Object.keys(stateDiff).length && { stateDiff }) };
}
const HANDLE = parseAbi(['function simulateHandleOp((address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature) op, address target, bytes targetCallData)']);
const HASH = parseAbi(['function getUserOpHash((address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature) op) view returns (bytes32)']);
const HASH_V06 = parseAbi(['function getUserOpHash((address sender, uint256 nonce, bytes initCode, bytes callData, uint256 callGasLimit, uint256 verificationGasLimit, uint256 preVerificationGas, uint256 maxFeePerGas, uint256 maxPriorityFeePerGas, bytes paymasterAndData, bytes signature) op) view returns (bytes32)']);
const HANDLE_V06 = parseAbi(['function simulateHandleOp((address sender, uint256 nonce, bytes initCode, bytes callData, uint256 callGasLimit, uint256 verificationGasLimit, uint256 preVerificationGas, uint256 maxFeePerGas, uint256 maxPriorityFeePerGas, bytes paymasterAndData, bytes signature) op, address target, bytes targetCallData)']);
const RESULT = [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bool' }, { type: 'bytes' }] as const;
const USER_OPERATION_EVENT = '0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f';
const USER_OPERATION_REVERT_REASON = '0x1c4fada7374c0a9ee8841fc38afe82932dc0f8e69012e927f061a8bae611a201';
const POST_OP_REVERT_REASON = '0xf62676f440ff169a3a9afdbf812e89e7f95975ee8e5c31214ffdef631c5f4792';
const STAKE_WITHDRAWN = '0xb7c918e0e249f999e965cafeb6c664271b3f4317d296461500e71da39f0cbda3'; // StakeWithdrawn(address indexed account, address withdrawAddress, uint256 amount), v0.6 to v0.9
const WITHDRAWN = '0xd1c19fbcd4551a5edfb66d43d2e337c04837afda3482b42bdf569a8fccdae5fb'; // Withdrawn(address indexed account, address withdrawAddress, uint256 amount), v0.6 to v0.9
const FAILED_OP = '0x220266b6', FAILED_OP_WITH_REVERT = '0x65c8fd4d';
/** The simulated bundler when no other is known (simulateHandleOp doesn't check its caller; paymasters can check tx.origin, see recentBundlers). */
const BUNDLER = '0x0000000000000000000000000000000000004337';
const BUNDLER_BALANCE = `0x${(10n ** 24n).toString(16)}`;

/**
 * Bundlers that recently submitted operations this paymaster paid for (at most five), which its operations are
 * simulated as: paymasters that only accept certain bundlers (tx.origin) refuse any other, which says nothing about
 * the operation itself, and some charge another bundler different gas. A paymaster can take any bundler for some of
 * its operations and only its own for others, by a setting in its data: bundlers whose operations had the same first
 * byte of paymaster data as this one come first, the busiest first. Looks back 200 blocks, then 2,000, 10,000 and
 * 20,000 (minutes on Arbitrum), then four older windows of 20,000 (or the node's cap) while that finds none, and
 * remembers what it found for ten minutes, none included when every read was answered: a busy paymaster's logs over
 * many blocks are a heavy read that nodes refuse under load, and an empty answer left the refusal standing. A quiet
 * paymaster's last bundles can be a day back: the one sponsoring an EIP-7702 delegate's operations (see
 * cosigned7702Stub) takes only its own bundlers, and its last operation was 6,600 blocks back on Ethereum (whose
 * public node answers 10,000 blocks back, no more) and 93,000 on Base when previewed (2026-11-15).
 */
const RECENT_BUNDLERS = new Map<string, { at: number; bundlers: string[] }>();
/** Lookups in flight, by key: concurrent operations of one paymaster share one (and so one node read), not one each. */
const RECENT_BUNDLERS_INFLIGHT = new Map<string, Promise<string[]>>();
/** What an empty answer is remembered for: a lull or a passing node failure stands only a minute, found bundlers ten. */
const FOUND_FOR = 600_000, EMPTY_FOR = 60_000;
/** A node's refusal of a log query's block range as such (not a refusal under load); its cap, where it names one. */
const RANGE_CAPPED = /block range|range (is )?too (large|wide|big)|range limit|exceeds? .*range|max(imum)? .*range/i;
const capMessage = (e: unknown) => String((e as { rpcError?: { message?: string } })?.rpcError?.message ?? '');
async function recentBundlers(deps: Dependencies, chainId: number, entryPoint: string, paymasterAndData: Hex): Promise<string[]> {
  const paymaster = paymasterAndData.slice(0, 42).toLowerCase();
  // The paymaster's own data starts after its address, and from v0.7 on its two gas limits.
  const at = SIMULATIONS[entryPoint]?.version === '0.6' ? 20 : 52;
  const config = paymasterAndData.length > 2 + at * 2 ? paymasterAndData.slice(2 + at * 2, 4 + at * 2).toLowerCase() : undefined;
  return bundlersFrom(deps, chainId, entryPoint, { key: `${paymaster}:${config ?? ''}`, topics: [USER_OPERATION_EVENT, null, null, `0x${'00'.repeat(12)}${paymaster.slice(2).toLowerCase()}`],
    weigh: t => {
      // The paymaster's data in the bundle's calldata: its address, then (at the same offset) its first byte.
      const input = (t?.input ?? '').toLowerCase(), i = input.indexOf(paymaster.slice(2));
      return config !== undefined && i >= 0 && input.slice(i + at * 2, i + at * 2 + 2) === config ? 100 : 1;
    } });
}
const ACCOUNT_DEPLOYED = '0xd51a9c61267aa6196961883ecf5ff2da6619c37dac0fa92122513fb32c032d2d';
/**
 * Bundlers that recently sent a factory's deployments (the EntryPoint's AccountDeployed, whose factory isn't indexed:
 * the logs of every deployment, kept where they name it), or an account's own operations (its UserOperationEvents),
 * the busiest first (at most five), looked for and remembered as a paymaster's are (recentBundlers), but a factory's
 * no further back than FACTORY_REACH. For an account whose deployment or validation checks the bundler sending it
 * (tx.origin), as a paymaster can: see simulateOperation.
 */
const originBundlers = (deps: Dependencies, chainId: number, entryPoint: string, by: 'factory' | 'account', address: string): Promise<string[]> => {
  const a = address.toLowerCase(), word = `0x${'00'.repeat(12)}${a.slice(2)}`;
  return bundlersFrom(deps, chainId, entryPoint, by === 'factory'
    ? { key: `factory:${a}`, topics: [ACCOUNT_DEPLOYED], keep: l => l.data.slice(0, 66).toLowerCase() === word, reach: FACTORY_REACH }
    : { key: `account:${a}`, topics: [USER_OPERATION_EVENT, null, word] });
};
/**
 * How far back (blocks from the head) a factory's deployments are looked for: every deployment's log is read, and
 * nearly every AA13 has nothing to do with the sender. Read as far back as a paymaster's (eight reads, 100,000
 * blocks), a preview of an operation whose factory had no deployments on Base took 4.6 s, against 1.3 s without the
 * lookup; reading 10,000 (three reads), 2.1 s. The OKX factory's bundler on Ethereum was found within 2,000 blocks
 * (4 of its deployments in 10,000), and Ethereum's public node answers no further back than 10,000.
 */
const FACTORY_REACH = 10_000n;
/**
 * A lookup of recent bundlers: an EntryPoint's logs with these topics (those `keep` takes), the transactions they
 * came in and who sent them, each counted by `weigh` (one each without it). `key` names it in the cache. `reach`:
 * the furthest back from the head it reads (the spans up to it, none of the older windows).
 */
interface BundlerQuery { key: string; topics: (string | null)[]; keep?: (log: { data: string }) => boolean; weigh?: (tx: { input?: string } | null) => number; reach?: bigint }
async function bundlersFrom(deps: Dependencies, chainId: number, entryPoint: string, query: BundlerQuery): Promise<string[]> {
  const key = `${chainId}:${entryPoint}:${query.key}`;
  const known = RECENT_BUNDLERS.get(key);
  if (known && Date.now() - known.at < (known.bundlers.length ? FOUND_FOR : EMPTY_FOR)) { return known.bundlers; }
  const inflight = RECENT_BUNDLERS_INFLIGHT.get(key);
  if (inflight) { return inflight; }
  const rpc = deps.rpc;
  if (!rpc?.has(chainId)) return [];
  const lookup = (async (): Promise<string[]> => {
    // `refused` marks a read the node couldn't answer (load, a block it lacks, all the transactions missing): the
    // empty it leaves is transient, so it is not remembered and the next operation tries again.
    let refused = false;
    const capped = (e: unknown) => RANGE_CAPPED.test(capMessage(e));
    try {
      const head = BigInt(String(await rpc.call(chainId, 'eth_blockNumber', [])));
      // The widest range the node will answer, learned from its own refusal (Polygon's 10,000, HyperEVM's 1,000): a
      // quiet paymaster's bundlers are over a wide span, which a capping node refuses whole, so the span is narrowed
      // to the cap and asked again rather than given up on (which used to be remembered as "no bundlers").
      let capBlocks: bigint | undefined;
      // Blocks back from the head the node has answered for: a span no wider (a capping node narrows every wider
      // one to its cap) is a window already read, and isn't read again.
      let covered = 0n;
      const SPANS = [200n, 2000n, 10_000n, 20_000n].filter(s => query.reach === undefined || s <= query.reach), PAGES = query.reach === undefined ? 4 : 0;
      for (let n = 0; n < SPANS.length + PAGES; n++) {
        // After the spans from the head, older windows as wide as the node answers, each just before the last: only
        // once the widest span was answered, and none past one the node refused (a node that keeps less history
        // refuses every deeper one: Ethereum's public node, 10,000 blocks back, with HTTP 403).
        const page = n >= SPANS.length;
        let span = page ? capBlocks ?? 20_000n : capBlocks !== undefined && SPANS[n] > capBlocks ? capBlocks : SPANS[n];
        if (page ? covered < span || covered >= head : span <= covered) { if (page) break; continue; }
        const end = head - (page ? covered : 0n);
        const read = (s: bigint) => rpc.call(chainId, 'eth_getLogs', [{ address: entryPoint, topics: query.topics, fromBlock: `0x${(end > s ? end - s : 0n).toString(16)}`, toBlock: `0x${end.toString(16)}` }]) as Promise<{ transactionHash: string; data: string }[]>;
        let logs: { transactionHash: string; data: string }[];
        try {
          logs = await read(span).catch(async e => { if (capped(e)) throw e; await new Promise(r => setTimeout(r, 500)); return read(span); });
        } catch (e) {
          if (!capped(e)) { refused = true; if (page) break; continue; }
          // The node named its cap: query within it. If that is no narrower than what we just asked, stop.
          const m = capMessage(e).match(/(\d[\d,]{2,})/); const named = m ? BigInt(m[1].replace(/,/g, '')) : (span > 2n ? span / 2n : 0n);
          if (named <= 0n || (capBlocks !== undefined && named >= capBlocks)) break;
          capBlocks = named;
          span = named;
          // Already read that far back from the head: on to the older windows.
          if (!page && span <= covered) continue;
          try { logs = await read(span); } catch { refused = true; if (page) break; continue; }
        }
        covered = (page ? covered : 0n) + span;
        const hashes = [...new Set((logs ?? []).filter(l => !query.keep || query.keep(l)).map(l => l.transactionHash).reverse())].slice(0, 16);
        if (!hashes.length) continue;
        const txs = await Promise.all(hashes.map(h => rpc.call(chainId, 'eth_getTransactionByHash', [h]).catch(() => null) as Promise<{ from?: string; input?: string } | null>));
        const score = new Map<string, number>();
        for (const t of txs) {
          const from = t?.from?.toLowerCase();
          if (!from) continue;
          score.set(from, (score.get(from) ?? 0) + (query.weigh?.(t) ?? 1));
        }
        const bundlers = [...score].sort((a, b) => b[1] - a[1]).map(([f]) => f).slice(0, 5);
        if (bundlers.length) { RECENT_BUNDLERS.set(key, { at: Date.now(), bundlers }); return bundlers; }
        // The logs named transactions, but the node gave none of their senders: a passing failure, not "no bundlers".
        refused = true;
      }
      // A genuine empty (every span answered, nothing found) is remembered briefly, so a busy paymaster's next
      // operation isn't a fresh heavy read; a refused one is not remembered at all.
      if (!refused) RECENT_BUNDLERS.set(key, { at: Date.now(), bundlers: [] });
    } catch { /* none */ }
    return [];
  })();
  RECENT_BUNDLERS_INFLIGHT.set(key, lookup);
  try { return await lookup; } finally { RECENT_BUNDLERS_INFLIGHT.delete(key); }
}

/**
 * A stand-in for the owner's ECDSA signature: well-formed (low s, v 28, r a valid curve point), so it recovers to
 * some address and an account's check fails rather than reverting. Bundlers use the same one to estimate gas.
 */
export const STUB_SIGNATURE = '0xfffffffffffffffffffffffffffffff0000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c' as Hex;
/**
 * The k-th stand-in signature (k from 1 to 15), for an account that needs other keys' signatures too (a cosigner's,
 * or further owners'): STUB_SIGNATURE with k as r's last digit, so each is told apart (see ecrecoverAs).
 */
export const stubSignature = (k: number): Hex => k === 0 ? STUB_SIGNATURE : `0x${STUB_SIGNATURE.slice(2, 65)}${k.toString(16)}${STUB_SIGNATURE.slice(66)}` as Hex;
/** A second stand-in signature, for an account that needs another key's signature too (a cosigner's). */
export const STUB_COSIGNATURE = stubSignature(1);

/**
 * A stand-in signature; `p256` when it is a passkey's, which P256VERIFY (0x100) must accept too (see standIn), or
 * `'daimo'` when the account verifies it with Daimo's P256 verifier contract instead; `verifier`, another P-256
 * verifier contract taking the precompile's input that its check calls (stood in for the same way). `cosigners`:
 * other stand-in ECDSA signatures in it and whose they are (ecrecover recovers each as its signer).
 */
interface Stub {
  signature: Hex; p256?: boolean | 'daimo'; verifier?: string; cosigners?: Cosigner[];
  /**
   * A passkey's real assertion by the stand-in passkey (standInPasskey), which the account's own P-256 check verifies
   * against that key, set as the account's for the run (`storage`).
   */
  madeUp?: boolean;
  /** The signature the wallet supplied with the operation, run as it is. */
  wallet?: boolean;
  /** The wallet's supplied signature with the stand-in in place of the ECDSA signature it carries (walletForm). */
  walletForm?: boolean;
  /** With walletForm: the signer's own last signature on the account, not one supplied (see simulateOperation). */
  lastForm?: boolean;
  /** A stand-in in the account's own form (stubFor), tried after the wallet's supplied stub and its wallet form were both refused. */
  fallback?: boolean;
  /** Kernel's enable mode: the operation's own enable data, with stand-ins for its two signatures (kernelEnableStub). */
  enable?: boolean;
  /** Storage slots of the account set for the run (a stand-in key registered as one of its own stands). */
  storage?: Record<string, string>;
  /** Code set at other addresses for the run, and the ones among them to start warm (code moved there: not an account the chain would touch). */
  code?: Record<string, Hex>; warm?: string[];
  /**
   * Why the account may not take this stand-in as the signer's (who signs it instead, as far as the request tells):
   * the preview says so where the account rejects it.
   */
  why?: string;
  /**
   * The stand-in's refusal doesn't show the signer can't sign: not every way it might (its sessions, say) was read,
   * and `why` says which weren't.
   */
  unsure?: boolean;
  /** What the preview says where the account accepts it (how the signature it stands in for differs from others). */
  note?: string;
  /**
   * The account pays nothing toward its gas for a signature it refuses (it returns before paying its prefund): where
   * it could pay, the EntryPoint's rejection for an unpaid prefund (AA21) is that refusal (OperationRun's unpaid).
   */
  unpaid?: boolean;
}
/** An address shortened for a note: its first and last four hex digits. */
const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
/**
 * Another stand-in ECDSA signature in a stand-in, and whose ecrecover is to recover it as; with `digest`, only over
 * that digest (what that key signs: see ecrecoverAs), at first.
 */
type Cosigner = { signature: Hex; signer: string; digest?: Hex };
type StubContext = {
  deps: Dependencies; chainId: number; sender: string; signer: string; nonce: bigint;
  /** Whether the request names the signer (else `signer` is the account itself). */
  named?: boolean;
  /** The code the account runs (its implementation or EIP-7702 delegate), where stubFor read it. */
  runs?: string;
  /**
   * The EIP-7702 delegation the operation is signed for, where it isn't the account's now (stubFor's `delegate`): `runs`
   * is then the delegate the operation's own transaction delegates the account to, whatever its code now.
   */
  delegate?: string;
  /** The signature supplied with the operation (Kernel's enable mode keeps the enable data it carries). */
  signature?: Hex;
  /** The operation's hash with chain ID 0, as Kernel v3.2 and later validate a chain-agnostic signature (replayableUserOpHash). */
  replayableHash?: () => Hex | undefined;
  /** The EntryPoint the operation goes to (where the account's earlier operations are logged). */
  entryPoint?: string;
  /** The operation's paymasterAndData (a multi-signer account's cosigners sign gas limits that name its paymaster). */
  paymasterAndData?: Hex;
  /** The operation's callData (the function it calls on the account names the validation, in Modular Account v1). */
  callData?: Hex;
  /** The operation's hash as the EntryPoint computes it (getUserOpHash): a passkey signs it as its challenge. */
  hash: () => Promise<Hex | undefined>;
  /** What the signer's wallet signs (OperationInput's digest). */
  digest?: Hex;
  /** The supertransaction's hash the signer signs, and the proof of the operation's hash in it (OperationInput's). */
  supertransaction?: SupertransactionProof;
};
const OWNERS = parseAbi(['function nextOwnerIndex() view returns (uint256)', 'function ownerAtIndex(uint256 index) view returns (bytes)']);

/** The stand-in r and s of a passkey's P256 signature (s in the lower half, as WebAuthn verifiers require). */
export const P256_STUB = { r: `0x${'5a'.repeat(32)}` as Hex, s: `0x${'25'.repeat(32)}` as Hex };
export const base64url = (hex: Hex) => {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const bytes = hexToBytes(hex);
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += A[n >> 18] + A[(n >> 12) & 63] + (i + 1 < bytes.length ? A[(n >> 6) & 63] : '') + (i + 2 < bytes.length ? A[n & 63] : '');
  }
  return out;
};
/**
 * A passkey's WebAuthn assertion for this hash, as webauthn-sol checks it (Coinbase Smart Wallet): clientDataJSON
 * of type webauthn.get with the hash as its challenge, authenticator data with the user present and verified, and
 * P256_STUB as the signature, which only the P256VERIFY stand-in accepts.
 */
export function webAuthnStub(hash: Hex): Hex {
  return encodeAbiParameters([WEBAUTHN_AUTH], [webAuthnAuth(hash, 'keys.coinbase.com', ',"crossOrigin":false')]);
}
/** webauthn-sol's WebAuthnAuth struct, and one for this challenge from a passkey of `rpId` (P256_STUB as its signature). */
const WEBAUTHN_AUTH = { type: 'tuple', components: [{ name: 'authenticatorData', type: 'bytes' }, { name: 'clientDataJSON', type: 'string' }, { name: 'challengeIndex', type: 'uint256' }, { name: 'typeIndex', type: 'uint256' }, { name: 'r', type: 'uint256' }, { name: 's', type: 'uint256' }] } as const;
function webAuthnAuth(challenge: Hex, rpId: string, more = '') {
  const clientDataJSON = `{"type":"webauthn.get","challenge":"${base64url(challenge)}","origin":"https://${rpId}"${more}}`;
  const authenticatorData = concatHex([sha256(stringToHex(rpId)), '0x05', '0x00000000']);
  return { authenticatorData, clientDataJSON, challengeIndex: BigInt(clientDataJSON.indexOf('"challenge"')), typeIndex: BigInt(clientDataJSON.indexOf('"type"')), r: BigInt(P256_STUB.r), s: BigInt(P256_STUB.s) };
}
/**
 * A passkey made up for the runs where no verifier can be stood in for (the P-256 check is in the account's own
 * Solidity: Zeal's Safe signers, src/safe-sim.ts, and Barz): its private key, and its public key (worked out when first
 * needed). Its assertions are real ones, which the check verifies against this key where the run sets it as the owner's.
 */
export const STAND_IN_PASSKEY = hexToBytes(sha256(stringToHex('signing-preview: a stand-in passkey')));
let standInPublicKey: { x: Hex; y: Hex } | undefined;
export const standInPasskey = () => {
  if (!standInPublicKey) { const key = p256.getPublicKey(STAND_IN_PASSKEY, false); standInPublicKey = { x: bytesToHex(key.slice(1, 33)), y: bytesToHex(key.slice(33)) }; }
  return standInPublicKey;
};
/** Daimo's P256 verifier contract (the same address on every chain here), which passkey accounts call without RIP-7212. */
export const DAIMO_P256_VERIFIER = '0xc2b78104907f722dabac4c69f826a522b2754de4';
/** ZeroDev's WebAuthn validator for Kernel v3 (source verified on Sourcify, Arbitrum One). */
const ZERODEV_WEBAUTHN_VALIDATORS = new Set(['0x7ab16ff354acb328452f1d445b3ddee9a91e9e69']);
/**
 * Kernel validators that take a passkey's assertion as webauthn-sol's WebAuthnAuth struct (the form webAuthnStub
 * builds, with the operation's hash as the challenge) and verify it through the P256 precompile: the validator of
 * Paribu's wallets (unpublished; seen on BNB Chain as the root validator of Kernel v3.3 accounts, their signatures'
 * challenge the operation's hash; checked live: the stand-in validates).
 */
const KERNEL_WEBAUTHN_SOL_VALIDATORS = new Set(['0xbbbe97d3d0e926231975e0b69acb54d534d35b1e']);
/**
 * Chains here on which ZeroDev's passkey accounts sign with the P256 precompile (usePrecompiled), else with Daimo's
 * verifier contract (P-256 in Solidity, about 335,000 gas more): for an account with no earlier operation to tell
 * (see zeroDevPrecompiled). The wallet's SDK decides: @zerodev/webauthn-key's isRIP7212SupportedNetwork named only
 * Polygon up to 5.4.4, and from 5.5.0 (December 2025) every chain here but HyperEVM, and wallets still ship both. So
 * by what accounts sign on each chain (November 2026): with the precompile on Base 34 of 34 operations, Polygon 8 of
 * 8, Arbitrum One 141 of 147, Sepolia 19 of 24; without it on Ethereum 17 of 17 and BNB Chain 5 of 5 (none seen on OP
 * Mainnet). Taken the other way, Base's came out 190-219% high, Polygon's 25-113%, BNB Chain's 60% low.
 */
const ZERODEV_PRECOMPILED = new Set([137, 8453, 42161, 11155111]);
const HANDLE_OPS = parseAbi(['function handleOps((address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature)[] ops, address beneficiary)']);
const HANDLE_OPS_V06 = parseAbi(['function handleOps((address sender, uint256 nonce, bytes initCode, bytes callData, uint256 callGasLimit, uint256 verificationGasLimit, uint256 preVerificationGas, uint256 maxFeePerGas, uint256 maxPriorityFeePerGas, bytes paymasterAndData, bytes signature)[] ops, address beneficiary)']);
const ZERODEV_WEBAUTHN_SIGNATURE = [{ type: 'bytes' }, { type: 'string' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bool' }] as const;
/** What each account's latest earlier operation showed (see zeroDevPrecompiled), for ten minutes. */
/** Each account's latest earlier operation's signature (see lastSignature), as of the block `head`. */
const LAST_SIGNED = new Map<string, { at: number; head: bigint; signature: Hex | undefined }>();
/** A UserOperationEvent as eth_getLogs returns it: its transaction, and its topics (the operation's hash second). */
type Logged = { transactionHash: string; topics: Hex[] };
/** How far back an account's earlier operation is looked for, and in windows of at most how many blocks. */
const LAST_SIGNED_REACH = 100_000n, LAST_SIGNED_WINDOW = 10_000n;
/**
 * How much further a wide lookup goes, in one read where the node takes it: Arbitrum One's public node answers
 * 10,000,000 blocks (about 29 days) of one sender's logs at once; publicnode's (the other chains' here) refuse the
 * read as an archive request, which ends the lookup there (November 2026).
 */
const LAST_SIGNED_WIDE = 10_000_000n, LAST_SIGNED_CAPPED = 50_000n;
/** A node's answer that the blocks asked for are older than it serves (Ethereum's public node): the reach ends there. */
const BEYOND_REACH = /archive|pruned|missing trie node|not available|header not found/i;
/**
 * The signature of the account's latest earlier operation through this EntryPoint (v0.7's packed form, or v0.6's
 * handleOps): its last UserOperationEvent up to the block before the latest, looked for back from there in windows
 * of 10,000 blocks (or the node's cap, from its refusal: Polygon's public node takes 10,000, BNB Chain's fewer) to
 * 100,000 back, or as far as the node serves. A wallet signs the same way each time, so what it chose then (a flag,
 * a key's id) it chooses now. With `match` (given each operation's signature and hash, its UserOperationEvent's), the
 * latest that matches, of the account's last six operations (`key` names the match, for
 * remembering). Undefined with none, or unreadable. Remembered ten minutes (a minute when none was found), for previews
 * at that block or later; a lookup any of whose reads failed is not remembered, and one at an earlier block (a
 * replay) reads again, so an operation never sees one after it.
 */
export async function lastSignature(c: { deps: Dependencies; chainId: number; sender: string; entryPoint?: string; match?: (signature: Hex, userOpHash: Hex) => boolean | Promise<boolean>; key?: string; wide?: boolean }): Promise<Hex | undefined> {
  const rpc = c.deps.rpc;
  if (!rpc?.has(c.chainId) || !c.entryPoint) return undefined;
  let head: bigint;
  try {
    const latest = await rpc.call(c.chainId, 'eth_getBlockByNumber', ['latest', false]) as { number?: string } | null;
    head = BigInt(latest?.number ?? '0x0') - 1n;
  } catch { return undefined; }
  if (head <= 0n) return undefined;
  const key = `${c.chainId}:${c.entryPoint}:${c.sender}${c.key ? `:${c.key}` : ''}`;
  // The operation's signature for the account in a bundle (v0.7's packed form, else v0.6's).
  const signatureIn = async (hash: string): Promise<Hex | undefined | null> => {
    const tx = await rpc.call(c.chainId, 'eth_getTransactionByHash', [hash]) as { input?: Hex } | null;
    if (!tx?.input) return null;
    let found: Hex | undefined;
    try { found = decodeFunctionData({ abi: HANDLE_OPS, data: tx.input }).args[0].find(o => o.sender.toLowerCase() === c.sender.toLowerCase())?.signature; } catch { /* not v0.7's handleOps */ }
    if (!found) try { found = decodeFunctionData({ abi: HANDLE_OPS_V06, data: tx.input }).args[0].find(o => o.sender.toLowerCase() === c.sender.toLowerCase())?.signature; } catch { /* nor v0.6's */ }
    return found;
  };
  const known = LAST_SIGNED.get(key);
  if (known && head >= known.head && Date.now() - known.at < (known.signature ? FOUND_FOR : EMPTY_FOR)) {
    if (head === known.head) return known.signature;
    // What the account signed since (an operation previewed a moment ago, then sent): the blocks after the lookup are
    // read too, so that a remembered answer is never older than the latest block. Remembered as it was, a deployment's
    // "none" stood for its account's next operation (Arbitrum One, 2026-11-18, 351 blocks later: a ZeroDev passkey
    // account taken to sign with the precompile, which it didn't, 49% low).
    if (head - known.head <= LAST_SIGNED_WINDOW) {
      try {
        const logs = await rpc.call(c.chainId, 'eth_getLogs', [{ address: c.entryPoint, topics: [USER_OPERATION_EVENT, null, `0x${'00'.repeat(12)}${c.sender.slice(2).toLowerCase()}`],
          fromBlock: `0x${(known.head + 1n).toString(16)}`, toBlock: `0x${head.toString(16)}` }]) as Logged[];
        let since: Hex | undefined, read = true;
        for (const log of [...logs].reverse().slice(0, c.match ? 6 : 1)) {
          const found = await signatureIn(log.transactionHash);
          if (found === null) { read = false; break; }
          if (!c.match || (found && await c.match(found, log.topics[1]))) { since = found; break; }
        }
        if (read) {
          LAST_SIGNED.set(key, since ? { at: Date.now(), head, signature: since } : { ...known, head });
          return since ?? known.signature;
        }
      } catch { /* looked for again in full, below */ }
    }
  }
  // `wide`: beyond the usual reach (see LAST_SIGNED_WIDE), as far as the node takes in a few reads.
  let signature: Hex | undefined, failed = false, window = c.wide ? LAST_SIGNED_WIDE : LAST_SIGNED_WINDOW, reached = c.wide ? LAST_SIGNED_REACH : 0n, fetched = 0;
  const reach = c.wide ? LAST_SIGNED_REACH + LAST_SIGNED_WIDE : LAST_SIGNED_REACH;
  // (Wide, on a node that caps a read's range: 40 reads, four at a time ahead of the one awaited. Base's public node
  // takes 50,000 blocks a read, and a ZeroDev passkey account there had last signed 935,000 blocks back (22 days),
  // beyond the 300,000 that four reads reached: its wallet's flag, read as the chain's default, put its gas 57% low.)
  const pending = new Map<bigint, Promise<Logged[]>>();
  const read = (to: bigint) => {
    let got = pending.get(to);
    if (!got) {
      const from = to >= window ? to - window + 1n : 0n;
      got = rpc.call(c.chainId, 'eth_getLogs', [{ address: c.entryPoint, topics: [USER_OPERATION_EVENT, null, `0x${'00'.repeat(12)}${c.sender.slice(2).toLowerCase()}`],
        fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }]) as Promise<Logged[]>;
      got.catch(() => undefined);
      pending.set(to, got);
    }
    return got;
  };
  try {
    for (let reads = 0; reached < reach && head - reached > 0n && reads < (c.wide ? 40 : 16); reads++) {
      const to = head - reached, from = to >= window ? to - window + 1n : 0n;
      if (c.wide && window < LAST_SIGNED_WIDE) for (let k = 1n; k < 4n && reached + k * window < reach && to - k * window > 0n; k++) read(to - k * window);
      let logs: Logged[];
      try {
        logs = await read(to);
      } catch (e) {
        const why = capMessage(e) || String((e as Error)?.message ?? e);
        if (RANGE_CAPPED.test(why)) {
          // The node's cap, where it names one (else half): asked again within it.
          const m = why.match(/(\d[\d,]{2,})/); const named = m ? BigInt(m[1].replace(/,/g, '')) : window / 2n;
          if (named <= 0n || named >= window) { failed = true; break; }
          window = named;
          pending.clear();
          continue;
        }
        // A wide read refused some other way (Base's public node answers one of 10,000,000 blocks with HTTP 403, and
        // one of 100,000 with its cap, 50,000): asked again in windows of 50,000, a cap most public nodes take.
        if (c.wide && window > LAST_SIGNED_CAPPED && !BEYOND_REACH.test(why)) { window = LAST_SIGNED_CAPPED; pending.clear(); continue; }
        if (!BEYOND_REACH.test(why)) failed = true;
        break;
      }
      // Newest first: the latest operation's, or with `match`, the latest that matches.
      let done = false;
      for (const log of [...logs].reverse()) {
        if (fetched++ >= (c.match ? 6 : 1)) { done = true; break; }
        const found = await signatureIn(log.transactionHash);
        if (found === null) { failed = done = true; break; }
        if (!c.match || (found && await c.match(found, log.topics[1]))) { signature = found; done = true; break; }
      }
      if (done) break;
      reached += to - from + 1n;
    }
  } catch { failed = true; }
  if (!failed) LAST_SIGNED.set(key, { at: Date.now(), head, signature });
  return signature;
}
/**
 * Whether a ZeroDev passkey account's wallet signs with the P256 precompile: as its latest earlier operation did (its
 * signature's usePrecompiled, after the 0xff of a permission's; see lastSignature); else as most do on its chain
 * (ZERODEV_PRECOMPILED). Blofin's wallet signs without the precompile on Arbitrum One, where 141 of 147 operations
 * had it: by the chain's default its operations came out 27-47% low.
 */
async function zeroDevPrecompiled(c: StubContext): Promise<boolean> {
  // Beyond the usual reach too: what the flag costs either way (above) is worth a read more. An account of Blofin's
  // on Arbitrum One whose last operation was 2,460,000 blocks back (a week) came out 53% low by the chain's default.
  const signature = await lastSignature(c) ?? await lastSignature({ ...c, wide: true, key: 'wide' });
  const read = (sig: Hex) => { try { return decodeAbiParameters(ZERODEV_WEBAUTHN_SIGNATURE, sig)[5]; } catch { return undefined; } };
  const precompiled = signature && (read(signature) ?? (signature.startsWith('0xff') ? read(`0x${signature.slice(4)}`) : undefined));
  return precompiled ?? ZERODEV_PRECOMPILED.has(c.chainId);
}
/**
 * A Kernel v3 validator that keeps signers by id (0x9334…04ba, unpublished; its layout read from its set-up and
 * operations, Sepolia and Polygon, 2026-11-13): its data is abi.encode((bytes32 id, address signer, bytes data)[]),
 * each signer a module with its data (an ECDSA signer module, 0x9895…c9c3, the owner's address); a signature is the
 * signer's id, then that module's (the owner's ECDSA signature over the operation's hash, EIP-191).
 */
const SIGNER_ID_VALIDATORS = new Set(['0x933401632d92bc7005d7415242171a55e20004ba']);
/**
 * Its ECDSA signer module, and the id its wallets give an owner's key: keccak256(module ++ owner), the id of every
 * SignerAdded event (account, id, module; data the owner's address) with that module up to 2026-11-13: Polygon 112
 * (1,100,000 blocks), Base 162 (1,300,000), Sepolia 909 (250,000).
 */
const SIGNER_ID_ECDSA_MODULE = '0x9895a7b30a9dfcfbb1cd8f41595d2ad15fdcc9c3';
export const ownerSignerId = (owner: string): Hex => keccak256(concatHex([SIGNER_ID_ECDSA_MODULE, owner as Hex]));
const SIGNER_CONFIGS = [{ type: 'tuple[]', components: [{ name: 'id', type: 'bytes32' }, { name: 'signer', type: 'address' }, { name: 'data', type: 'bytes' }] }] as const;
/**
 * The id a signer-id validator's operation names: a deploying account's from its set-up (the signer whose data is
 * the address asked to sign, else the first), an existing one's as its latest earlier operation named it.
 */
export async function signerIdOf(c: StubContext, vId: string, deploying?: KernelSetup): Promise<Hex | undefined> {
  const data = deploying?.installs.get(vId.toLowerCase());
  if (data) {
    try {
      const [configs] = decodeAbiParameters(SIGNER_CONFIGS, data);
      return (configs.find(x => x.data.toLowerCase() === c.signer.toLowerCase()) ?? configs[0])?.id;
    } catch { return undefined; }
  }
  const last = await lastSignature(c);
  return last && last.length === 2 + 97 * 2 ? `0x${last.slice(2, 66)}` as Hex : undefined;
}
/**
 * The ids a signer-id validator's stand-in tries, in turn: a deploying account's from its set-up (signerIdOf); an
 * existing account's, the signer's own (its ECDSA key's, ownerSignerId), then the one its latest earlier operation
 * named. That operation alone missed most existing accounts: of 13 previewed on Polygon, 8 were refused, 7 whose
 * operations were older than lastSignature reaches and one whose latest was a passkey permission's; on Base, 3 of 17
 * owners' operations replayed, whose latest earlier one was an enable-mode one or a permission's.
 */
export async function signerIdsOf(c: StubContext, vId: string, deploying?: KernelSetup): Promise<Hex[]> {
  const ids = new Set<Hex>();
  // (Not when the account itself is asked, as when no signer is named: no owner's key has its id.)
  if (!deploying && /^0x[0-9a-f]{40}$/i.test(c.signer) && c.signer.toLowerCase() !== c.sender.toLowerCase()) ids.add(ownerSignerId(c.signer.toLowerCase()));
  const last = await signerIdOf(c, vId, deploying);
  if (last) ids.add(last.toLowerCase() as Hex);
  return [...ids];
}
/**
 * A passkey's assertion as ZeroDev's WebAuthn validator decodes it: abi.encode(authenticatorData, clientDataJSON,
 * responseTypeLocation, r, s, usePrecompiled), with `"type":"webauthn.get"` at clientDataJSON[1] and the hash as
 * the challenge at clientDataJSON[23], where the validator looks for them; user present and verified.
 */
export function zeroDevWebAuthnStub(hash: Hex, usePrecompiled: boolean): Hex {
  const clientDataJSON = `{"type":"webauthn.get","challenge":"${base64url(hash)}","origin":"https://passkeys.zerodev.app","crossOrigin":false}`;
  const authenticatorData = concatHex([sha256(stringToHex('passkeys.zerodev.app')), '0x05', '0x00000000']);
  return encodeAbiParameters([{ type: 'bytes' }, { type: 'string' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bool' }],
    [authenticatorData, clientDataJSON, 1n, BigInt(P256_STUB.r), BigInt(P256_STUB.s), usePrecompiled]);
}
const KERNEL = parseAbi(['function rootValidator() view returns (bytes21)', 'struct PermissionConfig { bytes1 permissionFlag; address signer; bytes22[] policyData; }', 'function permissionConfig(bytes4 pId) view returns (PermissionConfig)']);
/**
 * Signers of Kernel permissions that take the owner's signature and then a cosigner's (65 bytes each), whose
 * cosigner() names that key and signers(account, permission id) the owner: Bleap's CosigningModuleV2 (source verified
 * on Sourcify, Base; the same address on Arbitrum One) and CosigningModuleV1 (verified on Sourcify, Arbitrum One and
 * Base), the same layout and the same cosigner; V1's install data is the owner's 20 bytes, V2's abi.encode(owner).
 * Bleap's accounts are deployed with V1 as their root permission, and their first operation moves the root to V2:
 * deployments were 20 of 1,595 Arbitrum One v0.7 operations in two hours and 3 of 1,037 on BNB Chain (2026-11-15),
 * every existing Bleap account's operation in those samples on V2. The owner and the cosigner sign the operation's
 * hash as a message, which both modules check first (then the bare hash, for enable mode).
 */
const COSIGNING_SIGNERS = new Set(['0x5b424d5133fae2ce64ce739cec0796343e957131', '0x61576d9ef23514bfe6f080e22ccfff473cf11a1a']);
const COSIGNER = parseAbi(['function cosigner() view returns (address)', 'function signers(address wallet, bytes32 id) view returns (address)']);
/** The owner in a cosigning signer's install data: V2's abi.encode(owner), V1's the owner's 20 bytes. */
export const cosigningOwner = (data: Hex): string | undefined => {
  const hex = data.slice(2).toLowerCase();
  const owner = hex.length === 40 ? `0x${hex}` : hex.length === 64 && /^0{24}/.test(hex) ? `0x${hex.slice(24)}` : undefined;
  return owner && BigInt(owner) !== 0n ? owner : undefined;
};
/** ZeroDev's WebAuthnSigner, a Kernel permission's signer (source verified on Sourcify, Ethereum): its signature is zeroDevWebAuthnStub's form. */
const ZERODEV_WEBAUTHN_SIGNERS = new Set(['0x65deec8fee717dc044d0cfd63ccf55f02ccac2b3']);
const KERNEL_DEPLOY = parseAbi(['function deployWithFactory(address factory, bytes createData, bytes32 salt)', 'function deployWithFactory(address factory, bytes createData, bytes32 salt, bytes signature)', 'function createAccount(bytes data, bytes32 salt)', 'function initialize(bytes21 rootValidator, address hook, bytes validatorData, bytes hookData, bytes[] initConfig)', 'function installValidations(bytes21[] vIds, (uint32 nonce, address hook)[] configs, bytes[] validationData, bytes[] hookData)']);
/** What a Kernel v3 account being deployed is set up with: its root validator, and each validation its initialize() installs, with its install data. */
export type KernelSetup = { root: Hex; installs: Map<string, Hex>; /** The Kernel implementation its factory deploys (implementation()). */ implementation?: string };
/**
 * The signer of permission `pId` (4 bytes, no 0x) a deploying Kernel installs, and the signer's own install data: the
 * permission's install data is abi.encode(bytes[]), the policies, then the signer (each a 2-byte flag, the module's
 * address, its own data).
 */
function setupPermissionSigner(setup: KernelSetup, pId: string): { module: string; data: Hex } | undefined {
  const data = setup.installs.get(`0x02${pId}${'00'.repeat(16)}`.toLowerCase());
  if (!data) return undefined;
  try { const [items] = decodeAbiParameters([{ type: 'bytes[]' }], data); const last = items.at(-1); return last && last.length >= 2 + 44 ? { module: `0x${last.slice(6, 46)}`.toLowerCase(), data: `0x${last.slice(46)}` } : undefined; } catch { return undefined; }
}
/**
 * deployWithFactory's selectors: ZeroDev's FactoryStaker's, and another's (0xf928…7053, unverified; on BNB Chain and
 * Base, 72 of 2,541 and 69 of 14,735 EntryPoint v0.7 deployments in 200,000 blocks to 2026-11-17, none on Ethereum,
 * Polygon or Arbitrum One) that takes a deployer's signature after the salt, deploying Kernel v3.3 accounts whose root
 * validator is a passkey's (0xbbbe…5b1e, webauthn-sol's form): with no stand-in in its form, their deployments'
 * validation refused the plain one, and the passkey's check didn't run.
 */
export const KERNEL_DEPLOY_SELECTORS = new Set(['0xc5265d5d', '0x05160ab7']);
/**
 * A KernelFactory's own createAccount(data, salt), called straight (ZeroDev's v3.1 factory, 0xaac5…e419, on Arbitrum
 * One, 2026-11-18: a passkey account's deployment got the plain stand-in, and its validation reverted, AA23); data is
 * Kernel's initialize, which kernelDeployStub reads as from deployWithFactory's createData.
 */
export const KERNEL_FACTORY_CREATE = '0xea6d13ac';
/**
 * A Kernel v3 account ZeroDev's FactoryStaker (or another deployWithFactory: KERNEL_DEPLOY_SELECTORS) is deploying:
 * kernelV3Stub, with the root validator its initialize()
 * sets and the validations it installs (the root's own install data, and installValidations among its initConfig
 * calls): a permission the operation validates through can be installed there (on Base: a passkey's, ZeroDev's
 * WebAuthn signer, with an execution hook).
 */
async function kernelDeployStub(c: StubContext, factoryData: Hex, kernelFactory?: string): Promise<Stub[]> {
  try {
    // deployWithFactory hands createData to the KernelFactory's createAccount, which calls the new account with it;
    // the KernelFactory's own createAccount (`kernelFactory`, called straight) takes it as its data.
    const call = decodeFunctionData({ abi: KERNEL_DEPLOY, data: factoryData });
    const [factory, createData] = call.functionName === 'createAccount' ? [kernelFactory!, call.args[0]] : call.functionName === 'deployWithFactory' ? [call.args[0], call.args[1]] : [];
    if (!factory || !createData) return [{ signature: STUB_SIGNATURE }];
    const init = decodeFunctionData({ abi: KERNEL_DEPLOY, data: createData as Hex });
    if (init.functionName !== 'initialize') return [{ signature: STUB_SIGNATURE }];
    const [root, , validatorData, , initConfig] = init.args as unknown as [Hex, Hex, Hex, Hex, readonly Hex[]];
    const installs = new Map<string, Hex>([[root.toLowerCase(), validatorData]]);
    for (const call of initConfig) {
      try {
        const d = decodeFunctionData({ abi: KERNEL_DEPLOY, data: call });
        if (d.functionName === 'installValidations') (d.args[0] as readonly Hex[]).forEach((vId, i) => installs.set(vId.toLowerCase(), (d.args[2] as readonly Hex[])[i]));
      } catch { /* another call */ }
    }
    // The Kernel it deploys (its version names an enable-mode operation's Enable domain): the factory's implementation().
    let implementation: string | undefined;
    if (c.nonce >> 248n === 1n && c.deps.rpc?.has(c.chainId)) {
      try {
        const out = String(await c.deps.rpc.call(c.chainId, 'eth_call', [{ to: factory, data: encodeFunctionData({ abi: KERNEL_FACTORY, functionName: 'implementation' }) }, 'latest']));
        if (/^0x0{24}[0-9a-f]{40}$/i.test(out)) implementation = `0x${out.slice(26)}`.toLowerCase();
      } catch { /* not readable */ }
    }
    return kernelV3Stub(c, { root, installs, ...(implementation && { implementation }) });
  } catch { return [{ signature: STUB_SIGNATURE }]; }
}
const KERNEL_FACTORY = parseAbi(['function implementation() view returns (address)']);
/**
 * ZeroDev Kernel v3.1, by how it validates: what its nonce names (byte 1 the validation type: 0x00 its root
 * validation, 0x01 the validator in bytes 2-21, 0x02 the permission in bytes 2-5), the root read from
 * rootValidator(), which has the same type byte. A passkey's validator (ZeroDev's WebAuthn validator) gets a
 * passkey's assertion; a permission whose signer takes a cosignature, 0xff (the signer's part) and the owner's and
 * the cosigner's stand-ins; anything else, the ECDSA stand-in as it is or after a 0xff byte (both
 * seen on-chain for the same implementation, by how each account is set up; checked: 0xff + signature validates as
 * signed by its owner).
 */
async function kernelV3Stub(c: StubContext, deploying?: KernelSetup): Promise<Stub[]> {
  const ecdsa: Stub[] = [{ signature: STUB_SIGNATURE }, { signature: `0xff${STUB_SIGNATURE.slice(2)}` as Hex }];
  // Enable mode (the nonce's first byte 0x01): the enable data the operation's own signature carries, with stand-ins
  // for its two signatures (kernelEnableStub). Without it (or where its shapes aren't known), Kernel can't read any
  // stand-in as enable data: its validation reverts on one (the calls are then simulated alone), and the forms below
  // aren't tried.
  if (c.nonce >> 248n === 1n) {
    const enable = c.signature && readKernelEnable(c.signature);
    const stubs = enable ? await kernelEnableStub(c, enable, deploying).catch(() => []) : [];
    return stubs.length ? stubs : [{ signature: STUB_SIGNATURE }];
  }
  const rpc = c.deps.rpc?.has(c.chainId) ? c.deps.rpc : undefined;
  const view = async (data: Hex) => rpc ? String(await rpc.call(c.chainId, 'eth_call', [{ to: c.sender, data }, 'latest'])) as Hex : undefined;
  // What validates: [type, id] from the nonce, or from rootValidator() for the root (a bytes21, left-aligned).
  const nonce = c.nonce.toString(16).padStart(64, '0');
  let type = nonce.slice(2, 4), id = nonce.slice(4, 44);
  if (type === '00' && deploying) { type = deploying.root.slice(2, 4); id = deploying.root.slice(4, 44); }
  else if (type === '00') {
    try {
      const root = await view(encodeFunctionData({ abi: KERNEL, functionName: 'rootValidator' }));
      if (!root || !/^0x[0-9a-f]{64}$/i.test(root)) return ecdsa;
      type = root.slice(2, 4); id = root.slice(4, 44);
    } catch { return ecdsa; }
  }
  // (ZeroDev's passkey validators 0.0.1 to 0.0.3 and its WebAuthn validator, all in this form: an account on 0.0.2,
  // Arbitrum One, 2026-11-18, got the plain stand-in, and its validation reverted, AA23.)
  if (type === '01' && ZERODEV_PASSKEY_VALIDATORS.has(`0x${id}`.toLowerCase())) {
    const hash = await c.hash();
    if (!hash) return ecdsa;
    const precompiled = await zeroDevPrecompiled(c);
    return [{ signature: zeroDevWebAuthnStub(hash, precompiled), p256: precompiled || 'daimo' }];
  }
  if (type === '01' && `0x${id}`.toLowerCase() === ZERODEV_WEIGHTED_VALIDATOR) {
    try { const weighted = await weightedStub(c, deploying?.installs.get(`0x01${id}`.toLowerCase())); if (weighted) return weighted; } catch { /* unreadable: the ECDSA forms */ }
  }
  if (type === '01' && SIGNER_ID_VALIDATORS.has(`0x${id}`.toLowerCase())) {
    const ids = await signerIdsOf(c, `0x01${id}`, deploying);
    if (ids.length) return ids.map(i => ({ signature: concatHex([i, STUB_SIGNATURE]) }));
  }
  if (type === '01' && KERNEL_WEBAUTHN_SOL_VALIDATORS.has(`0x${id}`.toLowerCase())) {
    const hash = await c.hash();
    if (!hash) return ecdsa;
    return [{ signature: webAuthnStub(hash), p256: true }];
  }
  if (type === '02' && rpc) {
    try {
      // A deploying account's permission: its signer from the install data (nothing to read on-chain yet).
      const installed = deploying && setupPermissionSigner(deploying, id.slice(0, 8));
      const out = installed ? undefined : await view(encodeFunctionData({ abi: KERNEL, functionName: 'permissionConfig', args: [`0x${id.slice(0, 8)}`] }));
      const config = installed ? { signer: installed.module } : out && decodeFunctionResult({ abi: KERNEL, functionName: 'permissionConfig', data: out });
      // Policies before the signer each read their own part of the signature, tagged with their index; one that
      // starts with 0xff (the signer's) gives every policy an empty part, as these wallets' signatures do.
      // ZeroDev's WebAuthn signer: 0xff, then a passkey's assertion over the operation's hash, as its WebAuthn
      // validator takes it (zeroDevWebAuthnStub).
      if (config && ZERODEV_WEBAUTHN_SIGNERS.has(config.signer.toLowerCase())) {
        const hash = await c.hash();
        if (hash) { const precompiled = await zeroDevPrecompiled(c); return [{ signature: `0xff${zeroDevWebAuthnStub(hash, precompiled).slice(2)}` as Hex, p256: precompiled || 'daimo' }]; }
      }
      // Bleap's cosigning signers: 0xff, the owner's signature, then its cosigner's. The owner is the one the module
      // records for the account (a deploying account's in its install data): where the signer asked isn't it, the
      // stand-in recovers as someone the module doesn't take, and the preview names who signs.
      if (config && COSIGNING_SIGNERS.has(config.signer.toLowerCase())) {
        const module = config.signer.toLowerCase();
        const word = (out: string) => /^0x0{24}[0-9a-f]{40}$/i.test(out) && !/^0x0+$/.test(out) ? `0x${out.slice(26)}`.toLowerCase() : undefined;
        const [cosigner, owner] = await Promise.all([
          rpc.call(c.chainId, 'eth_call', [{ to: module, data: encodeFunctionData({ abi: COSIGNER, functionName: 'cosigner' }) }, 'latest']).then(o => word(String(o))),
          installed ? cosigningOwner(installed.data) : rpc.call(c.chainId, 'eth_call', [{ to: module, data: encodeFunctionData({ abi: COSIGNER, functionName: 'signers', args: [c.sender as Hex, `0x${id.slice(0, 8)}${'00'.repeat(28)}`] }) }, 'latest']).then(o => word(String(o)), () => undefined)]);
        if (cosigner) {
          return [{ signature: `0xff${STUB_SIGNATURE.slice(2)}${STUB_COSIGNATURE.slice(2)}` as Hex, cosigners: [{ signature: STUB_COSIGNATURE, signer: cosigner }],
            ...(owner && owner !== c.signer.toLowerCase() && { why: `Bleap's cosigning module (${shortAddr(module)}) takes the signature of the owner it records for the account, ${owner}, with its cosigner's, and the signer asked isn't that owner` }) }];
        }
      }
    } catch { /* not readable: the ECDSA forms */ }
  }
  return ecdsa;
}
/**
 * ZeroDev Kernel v2.3 and v2.4: a 4-byte mode, then the validator's signature; mode 0x00000000 (sudo) validates through
 * the account's default validator (getDefaultValidator(), or for an account its factory deploys, initialize's
 * `_defaultValidator`). Frak's passkey validator gets its own form (frakStub); any other, the ECDSA validator's: the
 * owner's signature after the mode (checked on v2.3: it validates the shape as signed by its owner).
 */
const KERNEL_V2 = parseAbi(['function getDefaultValidator() view returns (address)', 'function createAccount(address _implementation, bytes _data, uint256 _index)', 'function initialize(address _defaultValidator, bytes _data)']);
async function kernelV2Stub(c: StubContext, setup?: { validator: string; data: Hex }): Promise<Stub[]> {
  let validator = setup?.validator.toLowerCase();
  if (!validator && c.deps.rpc?.has(c.chainId)) {
    try {
      const out = String(await c.deps.rpc.call(c.chainId, 'eth_call', [{ to: c.sender, data: encodeFunctionData({ abi: KERNEL_V2, functionName: 'getDefaultValidator' }) }, 'latest']));
      if (/^0x0{24}[0-9a-f]{40}$/i.test(out)) validator = `0x${out.slice(26)}`.toLowerCase();
    } catch { /* not readable: the ECDSA form */ }
  }
  if (validator === FRAK_WEBAUTHN_VALIDATOR) { const frak = await frakStub(c, setup?.data).catch(() => undefined); if (frak) return frak; }
  return [shaped('0x00000000')()];
}
/** Frak's MultiWebAuthNValidatorV2 (verified on Sourcify, Arbitrum One): a Kernel v2 validator for passkeys. */
const FRAK_WEBAUTHN_VALIDATOR = '0x0000000000fb9604350a25e826b050d859fe7b77';
/** The P-256 verifier contract it calls for a signature that doesn't ask for the precompile (its constructor's, in its code). */
const FRAK_P256_VERIFIER = '0x00e4005a00007384000000b0a8a0f300dd9fcafa';
const FRAK = parseAbi(['function getPasskey(address _smartWallet) view returns (bytes32, (uint256 x, uint256 y))']);
/**
 * Frak's passkey validator (its source: MultiWebAuthNSignatureLib, WebAuthnVerifier): after Kernel's mode, a byte (1:
 * the P256 precompile, 0: its verifier contract), the passkey's authenticator id hash (the account's main one,
 * getPasskey(account); for an account being deployed, the first word of its enable data), then the challenge's offset
 * in clientDataJSON (32 bytes), r, s, the lengths of authenticatorData and clientDataJSON (3 bytes each) and the two.
 * It checks the user-present flag and that the challenge is base64url(userOpHash), then P-256 over
 * sha256(authenticatorData ‖ sha256(clientDataJSON)); no origin or type. The stand-in: Frak's own (origin
 * https://frak.id, its rpId's hash, flags 0x1d, as its wallet signs), with the precompile byte as the account's last
 * signature had it (lastSignature), else the precompile. A deploying Frak wallet on Arbitrum One refused the plain
 * stand-in (4.4% low).
 */
async function frakStub(c: StubContext, enableData?: Hex): Promise<Stub[] | undefined> {
  const hash = await c.hash();
  if (!hash) return undefined;
  let id: Hex | undefined = enableData && enableData.length >= 66 ? `0x${enableData.slice(2, 66)}` as Hex : undefined;
  if (!id && c.deps.rpc?.has(c.chainId)) {
    const out = String(await c.deps.rpc.call(c.chainId, 'eth_call', [{ to: FRAK_WEBAUTHN_VALIDATOR, data: encodeFunctionData({ abi: FRAK, functionName: 'getPasskey', args: [c.sender as Hex] }) }, 'latest']));
    if (/^0x[0-9a-f]{64,}$/i.test(out)) id = out.slice(0, 66) as Hex;
  }
  if (!id || /^0x0{64}$/.test(id)) return undefined;
  const last = await lastSignature({ deps: c.deps, chainId: c.chainId, sender: c.sender, entryPoint: c.entryPoint, key: 'frak',
    match: sig => sig.length > 2 + 2 * 140 && sig.startsWith('0x00000000') && /^0[01]$/.test(sig.slice(10, 12)) && sig.slice(12, 76).toLowerCase() === id!.slice(2).toLowerCase() });
  const precompiled = last ? last.slice(10, 12) === '01' : true;
  const clientDataJSON = `{"type":"webauthn.get","challenge":"${base64url(hash)}","origin":"https://frak.id"}`;
  const authenticatorData = concatHex([sha256(stringToHex('frak.id')), '0x1d', '0x00000000']);
  const u24 = (n: number) => `0x${n.toString(16).padStart(6, '0')}` as Hex;
  const signature = concatHex(['0x00000000', precompiled ? '0x01' : '0x00', id, numberToHex(clientDataJSON.indexOf('"challenge":"') + 13, { size: 32 }), P256_STUB.r, P256_STUB.s,
    u24(37), u24(clientDataJSON.length), authenticatorData, stringToHex(clientDataJSON)]);
  return [precompiled ? { signature, p256: true } : { signature, verifier: FRAK_P256_VERIFIER }];
}
/** ZeroDev's WeightedECDSAValidator 0.0.3 (verified on Sourcify, Sepolia): guardians with weights, and a threshold. */
const ZERODEV_WEIGHTED_VALIDATOR = '0xed89244160cfe273800b58b1b534031699dfeeee';
const WEIGHTED = parseAbi(['function weightedStorage(address kernel) view returns (uint24 totalWeight, uint24 threshold, uint48 delay, address firstGuardian)',
  'function guardian(address guardian, address kernel) view returns (uint24 weight, address nextGuardian)']);
/** The end of the validator's list of an account's guardians. */
const WEIGHTED_END = '0xffffffffffffffffffffffffffffffffffffffff';
/**
 * ZeroDev's weighted ECDSA validator: the account's guardians (a list, by ascending address), each with a weight, and
 * a threshold. An operation's signature is other guardians' approvals, 65 bytes each, over the EIP-712
 * Approve(bytes32 callDataAndNonceHash) (domain WeightedECDSAValidator, 0.0.3, the chain, the validator), its hash
 * keccak256(abi.encode(account, callData, nonce)), as many as it takes with the signer's weight to reach the
 * threshold; then the signer's, over the operation hash's EIP-191 form, which must be a guardian's. The stand-in:
 * the guardians' stand-ins in their list's order, each recovered as its guardian over the Approve digest, then the
 * signer's. Read from the validator, or from a deploying account's install data (abi.encode(address[] guardians,
 * uint24[] weights, uint24 threshold, uint48 delay), guardians by descending address). Undefined where the account
 * has a delay (only a proposal approved beforehand runs then, on one signature) or nothing is read. The plain
 * stand-in, one guardian's alone, fell short of the threshold: three accounts on Sepolia whose operations carry two
 * signatures were refused it (2026-11-18, 3.9% low).
 */
async function weightedStub(c: StubContext, installData?: Hex): Promise<Stub[] | undefined> {
  let guardians: { address: string; weight: number }[] = [], threshold: number, delay: number;
  if (installData) {
    const [list, weights, t, d] = decodeAbiParameters(parseAbiParameters('address[], uint24[], uint24, uint48'), installData);
    guardians = list.map((a, i) => ({ address: a.toLowerCase(), weight: Number(weights[i]) })).reverse();
    threshold = Number(t); delay = Number(d);
  } else {
    const rpc = c.deps.rpc;
    if (!rpc?.has(c.chainId)) return undefined;
    const read = async (data: Hex) => String(await rpc.call(c.chainId, 'eth_call', [{ to: ZERODEV_WEIGHTED_VALIDATOR, data }, 'latest'])) as Hex;
    const [, t, d, first] = decodeAbiParameters(parseAbiParameters('uint24, uint24, uint48, address'), await read(encodeFunctionData({ abi: WEIGHTED, functionName: 'weightedStorage', args: [c.sender as Hex] })));
    threshold = Number(t); delay = Number(d);
    for (let g = first.toLowerCase(), n = 0; g !== WEIGHTED_END && !/^0x0{40}$/.test(g) && n < 16; n++) {
      const [weight, next] = decodeAbiParameters(parseAbiParameters('uint24, address'), await read(encodeFunctionData({ abi: WEIGHTED, functionName: 'guardian', args: [g as Hex, c.sender as Hex] })));
      guardians.push({ address: g, weight: Number(weight) });
      g = next.toLowerCase();
    }
  }
  if (!threshold || delay || !guardians.length) return undefined;
  const signer = c.signer.toLowerCase(), own = guardians.find(g => g.address === signer)?.weight ?? 0;
  const others: string[] = [];
  for (let total = own, i = 0; total < threshold && i < guardians.length && others.length < 15; i++) {
    if (guardians[i].address === signer) continue;
    others.push(guardians[i].address);
    total += guardians[i].weight;
  }
  const callDataAndNonceHash = keccak256(encodeAbiParameters(parseAbiParameters('address, bytes, uint256'), [c.sender as Hex, c.callData ?? '0x', c.nonce]));
  const approve = hashTypedData({ domain: { name: 'WeightedECDSAValidator', version: '0.0.3', chainId: c.chainId, verifyingContract: getAddress(ZERODEV_WEIGHTED_VALIDATOR) },
    types: { Approve: [{ name: 'callDataAndNonceHash', type: 'bytes32' }] }, primaryType: 'Approve', message: { callDataAndNonceHash } });
  const cosigners = others.map((signer, k) => ({ signature: stubSignature(k + 1), signer, digest: approve }));
  return [{ signature: concatHex([...cosigners.map(x => x.signature), STUB_SIGNATURE]), ...(cosigners.length && { cosigners }),
    ...(!own && { why: `ZeroDev's weighted ECDSA validator (${shortAddr(ZERODEV_WEIGHTED_VALIDATOR)}) takes the signatures of the account's guardians (${guardians.map(g => shortAddr(g.address)).join(', ')}), and the signer asked isn't one of them` }) }];
}
// --- ZeroDev Kernel v3's enable mode ---
// An operation whose nonce's first byte is 0x01 installs the validation its nonce names (a validator, or a permission:
// policies, then a signer) while it validates, and is then validated by it (ValidationManager's _enableMode and
// _enableDigest, Kernel v3.1 to v3.3, verified source on Sourcify). Its signature carries what to install and two
// signatures:
//   [keccak256("kernel.replayable.signature"): v3.2 on, a chain-agnostic signature] ‖ hook (20 bytes) ‖
//   abi.encode(bytes validatorData, bytes hookData, bytes selectorData, bytes enableSig, bytes userOpSig)
// enableSig is the owner's, the account's root validation's, over the Enable typed data (see
// src/typed-data/kernel-enable.ts: domain "Kernel", the account's version, the chain or 0 when replayable, the account;
// its nonce currentNonce(), in v3.3 one more when that validation is installed at it); Kernel checks it against the
// root (reverting with EnableNotApproved if it fails), installs what it names and validates userOpSig with it, as it
// does any operation of that validation (a permission's: each policy's part, idx (1 byte) ‖ length (8) ‖ data, then
// 0xff and the signer's). A dApp's SDK builds it, so the operation a preview is handed carries the enable data (its
// signatures possibly dummies): kernelEnableStub keeps it and puts stand-ins in place of both signatures.
/** Kernel v3.2's and v3.3's marker of a chain-agnostic signature (MAGIC_VALUE_SIG_REPLAYABLE). */
const KERNEL_REPLAYABLE = keccak256(stringToHex('kernel.replayable.signature'));
const KERNEL_ENABLE_PARTS = [{ type: 'bytes' }, { type: 'bytes' }, { type: 'bytes' }, { type: 'bytes' }, { type: 'bytes' }] as const;
/** What an enable-mode operation's signature carries (see above). */
export interface KernelEnable { replayable: boolean; hook: Hex; validatorData: Hex; hookData: Hex; selectorData: Hex; enableSig: Hex; userOpSig: Hex }
/** An enable-mode signature read, or undefined where it isn't one (too short, or its parts don't decode). */
export function readKernelEnable(signature: Hex): KernelEnable | undefined {
  let s = signature.toLowerCase().slice(2);
  const replayable = s.startsWith(KERNEL_REPLAYABLE.slice(2));
  if (replayable) s = s.slice(64);
  if (s.length < 40 + 64 * 10) return undefined;
  try {
    const [validatorData, hookData, selectorData, enableSig, userOpSig] = decodeAbiParameters(KERNEL_ENABLE_PARTS, `0x${s.slice(40)}`);
    if (selectorData.length < 10) return undefined;
    return { replayable, hook: `0x${s.slice(0, 40)}`, validatorData, hookData, selectorData, enableSig, userOpSig };
  } catch { return undefined; }
}
/** An enable-mode signature, from its parts. */
export function kernelEnableSignature(e: KernelEnable): Hex {
  return concatHex([...(e.replayable ? [KERNEL_REPLAYABLE] : []), e.hook, encodeAbiParameters(KERNEL_ENABLE_PARTS, [e.validatorData, e.hookData, e.selectorData, e.enableSig, e.userOpSig])]);
}
/** The Enable digest Kernel checks enableSig against, for validation `vId` (bytes21) at validation nonce `nonce`. */
export function kernelEnableDigest(e: KernelEnable, at: { account: string; chainId: number; version: string; vId: Hex; nonce: number }): Hex {
  return hashTypedData({ domain: { name: 'Kernel', version: at.version, chainId: e.replayable ? 0 : at.chainId, verifyingContract: getAddress(at.account) },
    types: { Enable: KERNEL_ENABLE_FIELDS.map(([name, type]) => ({ name, type })) }, primaryType: 'Enable',
    message: { validationId: at.vId, nonce: at.nonce, hook: getAddress(e.hook), validatorData: e.validatorData, hookData: e.hookData, selectorData: e.selectorData } });
}
/**
 * A permission signature's parts: its policies' (idx ‖ length ‖ data each, in order) and, after 0xff, the signer's.
 * Undefined where it doesn't read so.
 */
function permissionParts(sig: Hex): { policies: Hex; signer: Hex } | undefined {
  const s = sig.slice(2);
  let at = 0, last = -1;
  while (at < s.length) {
    const idx = parseInt(s.slice(at, at + 2), 16);
    if (idx === 0xff) return { policies: `0x${s.slice(0, at)}`, signer: `0x${s.slice(at + 2)}` };
    if (idx <= last || at + 18 > s.length) return undefined;
    const length = Number.parseInt(s.slice(at + 2, at + 18), 16);
    at += 18 + length * 2;
    last = idx;
  }
  return undefined;
}
/** Solady's MerkleProofLib.verify: each step hashes the sorted pair. */
function merkleVerify(proof: readonly Hex[], root: Hex, leaf: Hex): boolean {
  let node = leaf;
  for (const p of proof) node = BigInt(node) < BigInt(p) ? keccak256(concatHex([node, p])) : keccak256(concatHex([p, node]));
  return node.toLowerCase() === root.toLowerCase();
}
/** ZeroDev's ECDSA validators (an owner's address as install data; ecdsaValidatorStorage(account) holds it): the ECDSA validator, v3.0's, and the multi-chain one. */
const ZERODEV_ECDSA_VALIDATORS = new Set(['0x845adb2c711129d4f3966735ed98a9f09fc4ce57', '0x8104e3ad430ea6d354d013a6789fdfc71e671c43', '0x5c97aa67ba578e3c54ec5942a7563ea9130e4f5f']);
const ZERODEV_MULTICHAIN_VALIDATOR = '0x5c97aa67ba578e3c54ec5942a7563ea9130e4f5f';
/** ZeroDev's passkey validators taking zeroDevWebAuthnStub's form (sources verified on Sourcify): 0.0.1 to 0.0.3. */
const ZERODEV_PASSKEY_VALIDATORS = new Set(['0xd990393c670dcce8b4d8f858fb98c9912dbfaa06', '0xba45a2bfb8de3d24ca9d7f1b551e14dff5d690fd', ...ZERODEV_WEBAUTHN_VALIDATORS]);
/** ZeroDev's ECDSA signer (a permission's: signer(id, account), its install data the key's address). */
const ZERODEV_ECDSA_SIGNER = '0x6a6f069e2a08c2468e7724ab3250cdbfba14d4ff';
/** ZeroDev's WebAuthn signers 0.0.1 to 0.0.4, which take zeroDevWebAuthnStub's form after the permission's 0xff. */
const ZERODEV_PASSKEY_SIGNERS = new Set(['0x8aa55d4bfae101609078681a69b5bc3181516612', '0x58625164e306242c7613223bdeb68fbe11300606', '0x615d8641b6ce9406de7c3c01f57c552ab3a96f83', ...ZERODEV_WEBAUTHN_SIGNERS]);
const KERNEL_STATE = parseAbi(['function currentNonce() view returns (uint32)', 'function validationConfig(bytes21 vId) view returns (uint32 nonce, address hook)', 'function ecdsaValidatorStorage(address account) view returns (address)',
  'function signer(bytes32 id, address wallet) view returns (address)', 'function signers(address wallet, bytes32 id) view returns (address)', 'function cosigner() view returns (address)']);
/**
 * The stand-in ECDSA signatures of an enable-mode operation: the owner's Enable signature, the new key's, and a
 * cosigner's of each. Each r is a point of the curve (as STUB_SIGNATURE's), so that asked over another digest first (a
 * key's check of the bare hash before its personal_sign form), the real precompile recovers someone, as it does for
 * the real signature: for stubSignature(2) it recovers no one, on which Solady's ECDSA.recover reverts, and a first
 * version's validation reverted on it, then ran recovering it over any digest, two ecrecovers short (1.1% low on Base).
 */
const ENABLE_OWNER = stubSignature(6), ENABLE_KEY = stubSignature(3), ENABLE_OWNER_COSIGNER = stubSignature(12), ENABLE_KEY_COSIGNER = stubSignature(14);
/** A ZeroDev passkey signature's usePrecompiled, where `sig` is one (a wallet's dummy included). */
const precompiledIn = (sig: Hex): boolean | undefined => { try { return decodeAbiParameters(ZERODEV_WEBAUTHN_SIGNATURE, sig)[5]; } catch { return undefined; } };
/**
 * A Kernel v3 operation in enable mode, signed: its own enable data (`e`) with stand-ins for both signatures.
 * - enableSig, by the root (read from the account, or from its set-up when the operation deploys it): ZeroDev's ECDSA
 *   validators, the owner's address (ecdsaValidatorStorage) recovering the stand-in over the Enable digest, or, the
 *   multi-chain validator's Merkle form (the owner signs a root of several chains' Enable digests), the operation's own
 *   root and proof where they prove this digest; ZeroDev's passkey validators, a passkey's assertion with the digest
 *   as its challenge (usePrecompiled as in the operation's own, else as the account's wallet signs: zeroDevPrecompiled);
 *   the validator that keeps signers by id, the operation's id and its owner's; an EIP-7702 account (v3.3's root of
 *   type 0x00), the account itself; a root permission, its policies' parts as the
 *   operation's own, then 0xff and its signer's: ZeroDev's ECDSA signer's key (signer(id, account)), or Bleap's
 *   cosigning signer's owner (signers(account, id)) and its cosigner (cosigner()).
 * - userOpSig, by what it installs: a validator, ZeroDev's ECDSA validators (the key in its install data) or passkey
 *   validators (the operation's hash as the challenge); a permission, its policies' parts as the operation's own, then
 *   0xff and its signer's: ZeroDev's ECDSA signer (the key in its install data), its WebAuthn signers, or Bleap's
 *   cosigning signer (the key in its install data and the cosigner). Replayable, the hash is Kernel's chain-agnostic one.
 * Each ECDSA stand-in is a different one (ENABLE_OWNER, ENABLE_KEY and their cosigners'), recovered as its own signer,
 * first only over what that key signs, so that the checks before it fail as they will: the bare digest or hash, or its
 * personal_sign form, as the operation's own signature by that key shows where it is one, else as wallets sign it
 * (read from operations' own signatures, 2026-11-13 and 15): an owner signs the Enable as typed data, the digest itself,
 * on Kernel v3.1 and v3.3 (71 of 72 ECDSA validator owners on Base, Arbitrum One, BNB Chain and Polygon, one on Polygon
 * its personal_sign form; 13 of 13 EIP-7702 accounts, which take nothing else), but on Kernel v3.2 its personal_sign
 * form (48 of 48 ECDSA validator owners on Base: guessed as the digest, the dummies' run was one ecrecover short, 0.5%
 * low); a multi-chain owner its Merkle root as a message (61 of 61 on Base), Bleap's owner the digest and its cosigner
 * the personal_sign form (15 of 15), and a key the operation's hash as a message (ZeroDev's SDK; 90 of 90 on Base).
 * Empty where the root or the installed validation isn't one of these, or what to recover can't be read: the caller
 * falls back.
 */
export async function kernelEnableStub(c: StubContext, e: KernelEnable, deploying?: KernelSetup): Promise<Stub[]> {
  const rpc = c.deps.rpc?.has(c.chainId) ? c.deps.rpc : undefined;
  if (!rpc) return [];
  // The account's own views answer nothing (0x) while it has no code: an EIP-7702 account its bundle delegates (its
  // first operation, on BNB Chain), whose storage is empty, as they then read it.
  const call = async (to: string, data: Hex, words: number) => {
    const out = String(await rpc.call(c.chainId, 'eth_call', [{ to, data }, 'latest'])) as Hex;
    return out === '0x' && to === c.sender ? `0x${'00'.repeat(32 * words)}` as Hex : out;
  };
  const read = async (to: string, functionName: 'currentNonce' | 'validationConfig' | 'ecdsaValidatorStorage' | 'signer' | 'signers' | 'cosigner', args?: readonly unknown[]) => {
    const data = await call(to, encodeFunctionData({ abi: KERNEL_STATE, functionName, ...(args && { args }) } as never), functionName === 'validationConfig' ? 2 : 1);
    return decodeFunctionResult({ abi: KERNEL_STATE, functionName, data } as never) as unknown;
  };
  const address = (a: unknown) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a) && BigInt(a) !== 0n ? a.toLowerCase() : undefined;
  const n = c.nonce.toString(16).padStart(64, '0');
  const type = n.slice(2, 4);
  if (type !== '01' && type !== '02') return [];
  const vId = (type === '01' ? `0x01${n.slice(4, 44)}` : `0x02${n.slice(4, 12)}${'00'.repeat(16)}`) as Hex;
  // The root, and the Kernel (its version names the Enable's domain).
  const root = deploying?.root.toLowerCase() ?? (await call(c.sender, encodeFunctionData({ abi: KERNEL, functionName: 'rootValidator' }), 1)).slice(0, 44);
  const version = KERNEL_V3_IMPLEMENTATIONS[(deploying ? deploying.implementation : c.runs) ?? ''];
  // (Kernel v3.1 has no chain-agnostic signatures: it would read the marker as the hook.)
  if (!/^0x[0-9a-f]{42}$/.test(root) || !version || version === '0.3.0-beta' || (e.replayable && version === '0.3.1')) return [];
  // The validation nonce it is enabled at: the account's currentNonce() (1 after initialize()); v3.3 one more when the
  // validation is installed at that nonce already.
  let nonce: number;
  if (deploying) nonce = 1 + (version === '0.3.3' && deploying.installs.has(vId) ? 1 : 0);
  else {
    nonce = Number(await read(c.sender, 'currentNonce'));
    if (version === '0.3.3' && Number((await read(c.sender, 'validationConfig', [vId]) as readonly [number, string])[0]) === nonce) nonce++;
  }
  const digest = kernelEnableDigest(e, { account: c.sender, chainId: c.chainId, version, vId, nonce });
  const opHash = e.replayable ? c.replayableHash?.() : await c.hash();
  if (!opHash) return [];
  const cosigners: Cosigner[] = [];
  const ecdsa = (signature: Hex, signer: string | undefined, over: Hex) => { if (!signer) throw new Error('no signer'); cosigners.push({ signature, signer, digest: over }); return signature; };
  // What a key signs, `hash` or its personal_sign form: as the operation's own signature by it shows, where it is one
  // (a dummy recovers to someone else), else `usual`.
  const form = async (own: Hex, signer: string | undefined, hash: Hex, usual: 'hash' | 'message') => {
    const message = hashMessage({ raw: hash });
    if (own.length === 132 && signer) {
      for (const h of [hash, message]) { try { if ((await recoverAddress({ hash: h, signature: own })).toLowerCase() === signer) return h; } catch { /* not a signature */ } }
    }
    return usual === 'hash' ? hash : message;
  };
  const passkeys: (boolean | 'daimo')[] = [];
  const passkey = async (hash: Hex, own: Hex) => { const precompiled = precompiledIn(own) ?? await zeroDevPrecompiled(c); passkeys.push(precompiled || 'daimo'); return zeroDevWebAuthnStub(hash, precompiled); };
  // A permission's install data: its signer (the last entry: flag, address, data).
  const signerEntry = (data: Hex | undefined) => {
    if (!data) return undefined;
    try { const [items] = decodeAbiParameters([{ type: 'bytes[]' }], data); const last = items.at(-1); return last && last.length >= 46 ? { module: `0x${last.slice(6, 46)}`.toLowerCase(), data: `0x${last.slice(46)}` as Hex } : undefined; } catch { return undefined; }
  };
  try {
    // enableSig, by the root.
    let enableSig: Hex;
    const rootId = `0x${root.slice(4, 44)}`;
    if (root.startsWith('0x01') && ZERODEV_ECDSA_VALIDATORS.has(rootId)) {
      const owner = deploying ? address(`0x${deploying.installs.get(root)?.slice(2, 42)}`) : address(await read(rootId, 'ecdsaValidatorStorage', [c.sender]));
      // The multi-chain validator's Merkle form: the owner's signature, the root, then abi.encode(bytes32[] proof).
      let merkle: { root: Hex; rest: Hex } | undefined;
      if (rootId === ZERODEV_MULTICHAIN_VALIDATOR && e.enableSig.length > 2 + 97 * 2) {
        try {
          const mroot = `0x${e.enableSig.slice(132, 196)}` as Hex;
          const [proof] = decodeAbiParameters([{ type: 'bytes32[]' }], `0x${e.enableSig.slice(196)}`);
          if (merkleVerify(proof, mroot, digest)) merkle = { root: mroot, rest: `0x${e.enableSig.slice(132)}` };
        } catch { /* not that form */ }
      }
      // (Its wallet signs the typed data, the digest itself; on Kernel v3.2, its personal_sign form. A Merkle root, as
      // a message.)
      enableSig = merkle ? concatHex([ecdsa(ENABLE_OWNER, owner, await form(`0x${e.enableSig.slice(2, 132)}`, owner, merkle.root, 'message')), merkle.rest])
        : ecdsa(ENABLE_OWNER, owner, await form(e.enableSig, owner, digest, version === '0.3.2' ? 'message' : 'hash'));
    } else if (root.startsWith('0x01') && ZERODEV_PASSKEY_VALIDATORS.has(rootId)) enableSig = await passkey(digest, e.enableSig);
    else if (root.startsWith('0x01') && SIGNER_ID_VALIDATORS.has(rootId) && e.enableSig.length === 2 + 97 * 2) {
      // The validator that keeps signers by id (signerIdOf): the signer's id, then its ECDSA module's signature, as
      // the operation's own names them. Its owner: a deploying account's from its set-up; else (the validator's
      // storage is unpublished) the key whose id it is (ownerSignerId) of whoever the operation's own signature
      // recovers to over the digest's personal_sign form, as its owners sign operations (none from a dummy), and the
      // signer the preview is for; failing that, the first of them.
      const id = `0x${e.enableSig.slice(2, 66)}` as Hex, own = `0x${e.enableSig.slice(66)}` as Hex;
      let owner: string | undefined;
      if (deploying) {
        try { owner = address(`0x${decodeAbiParameters(SIGNER_CONFIGS, deploying.installs.get(root) ?? '0x')[0].find(x => x.id.toLowerCase() === id.toLowerCase())?.data.slice(2, 42)}`); } catch { owner = undefined; }
      } else {
        const recovered = own.toLowerCase() !== STUB_SIGNATURE ? (await recoverAddress({ hash: hashMessage({ raw: digest }), signature: own }).catch(() => undefined))?.toLowerCase() : undefined;
        const candidates = [recovered, c.signer.toLowerCase() !== c.sender.toLowerCase() ? address(c.signer) : undefined].filter((a): a is string => !!a);
        owner = candidates.find(a => ownerSignerId(a) === id.toLowerCase()) ?? candidates[0];
      }
      enableSig = concatHex([id, ecdsa(ENABLE_OWNER, owner, await form(own, owner, digest, 'message'))]);
    } else if (root === `0x${'00'.repeat(21)}` && version === '0.3.3') enableSig = ecdsa(ENABLE_OWNER, c.sender, await form(e.enableSig, c.sender, digest, 'hash'));
    else if (root.startsWith('0x02')) {
      const pId = `0x${root.slice(4, 12)}` as Hex, id = `${pId}${'00'.repeat(28)}` as Hex;
      // (A deploying account's: its signer and key from its install data, nothing being on-chain yet.)
      const installed = deploying ? signerEntry(deploying.installs.get(root)) : undefined;
      const signer = deploying ? installed?.module : address((decodeFunctionResult({ abi: KERNEL, functionName: 'permissionConfig', data: String(await rpc.call(c.chainId, 'eth_call', [{ to: c.sender, data: encodeFunctionData({ abi: KERNEL, functionName: 'permissionConfig', args: [pId] }) }, 'latest'])) as Hex }) as { signer: string }).signer);
      const parts = permissionParts(e.enableSig) ?? { policies: '0x' as Hex, signer: '0x' as Hex };
      if (signer === ZERODEV_ECDSA_SIGNER) {
        const key = installed ? address(`0x${installed.data.slice(2, 42)}`) : address(await read(signer, 'signer', [id, c.sender]));
        enableSig = concatHex([parts.policies, '0xff', ecdsa(ENABLE_OWNER, key, await form(parts.signer, key, digest, 'hash'))]);
      } else if (signer && COSIGNING_SIGNERS.has(signer)) {
        // (Bleap's owners sign the typed data, the digest itself, which it checks second; its cosigner the
        // personal_sign form, checked first: 15 of 15 on Base.)
        const [owner, cosigner] = (await Promise.all([installed ? cosigningOwner(installed.data) : read(signer, 'signers', [c.sender, id]), read(signer, 'cosigner')])).map(address);
        enableSig = concatHex([parts.policies, '0xff', ecdsa(ENABLE_OWNER, owner, await form(`0x${parts.signer.slice(2, 132)}`, owner, digest, 'hash')),
          ecdsa(ENABLE_OWNER_COSIGNER, cosigner, await form(`0x${parts.signer.slice(132, 262)}`, cosigner, digest, 'message'))]);
      } else return [];
    } else return [];

    // userOpSig, by what it installs.
    let userOpSig: Hex;
    if (type === '01') {
      const validator = `0x${n.slice(4, 44)}`;
      const key = address(`0x${e.validatorData.slice(2, 42)}`);
      if (ZERODEV_ECDSA_VALIDATORS.has(validator)) userOpSig = ecdsa(ENABLE_KEY, key, await form(e.userOpSig, key, opHash, 'message'));
      else if (ZERODEV_PASSKEY_VALIDATORS.has(validator)) userOpSig = await passkey(opHash, e.userOpSig);
      else return [];
    } else {
      const entry = signerEntry(e.validatorData);
      const parts = permissionParts(e.userOpSig) ?? { policies: '0x' as Hex, signer: '0x' as Hex };
      if (entry?.module === ZERODEV_ECDSA_SIGNER) {
        const key = address(`0x${entry.data.slice(2, 42)}`);
        userOpSig = concatHex([parts.policies, '0xff', ecdsa(ENABLE_KEY, key, await form(parts.signer, key, opHash, 'message'))]);
      } else if (entry && ZERODEV_PASSKEY_SIGNERS.has(entry.module)) userOpSig = concatHex([parts.policies, '0xff', await passkey(opHash, parts.signer)]);
      else if (entry && COSIGNING_SIGNERS.has(entry.module)) {
        const key = address(cosigningOwner(entry.data)), cosigner = address(await read(entry.module, 'cosigner'));
        userOpSig = concatHex([parts.policies, '0xff', ecdsa(ENABLE_KEY, key, await form(`0x${parts.signer.slice(2, 132)}`, key, opHash, 'message')),
          ecdsa(ENABLE_KEY_COSIGNER, cosigner, await form(`0x${parts.signer.slice(132, 262)}`, cosigner, opHash, 'message'))]);
      } else return [];
    }
    // The passkeys' verifier: the precompile, Daimo's contract, or both.
    const p256 = passkeys.includes(true) ? true : passkeys.length ? 'daimo' as const : undefined;
    return [{ signature: kernelEnableSignature({ ...e, enableSig, userOpSig }), enable: true, ...(cosigners.length && { cosigners }), ...(p256 && { p256 }), ...(p256 === true && passkeys.includes('daimo') && { verifier: DAIMO_P256_VERIFIER }) }];
  } catch { return []; }
}
const coinbaseWrapper = (ownerIndex: bigint, signatureData: Hex) => encodeAbiParameters([{ type: 'tuple', components: [{ name: 'ownerIndex', type: 'uint256' }, { name: 'signatureData', type: 'bytes' }] }], [{ ownerIndex, signatureData }]);
/**
 * Coinbase Smart Wallet: abi.encode(SignatureWrapper(ownerIndex, signatureData)). The signer's own index when it is
 * an address owner; when the account itself is asked to sign (a passkey wallet's way) and it has a passkey owner,
 * that passkey's, with a WebAuthn assertion; else the first address owner's (the account then reports the
 * signature as not its own, where a passkey's index would make its validation revert), or index 0.
 */
async function coinbaseFor(owners: (Hex | undefined)[], c: StubContext): Promise<Stub> {
  const mine = encodeAbiParameters([{ type: 'address' }], [c.signer as Hex]);
  const i = owners.findIndex(o => o?.toLowerCase() === mine);
  if (i >= 0) return { signature: coinbaseWrapper(BigInt(i), STUB_SIGNATURE) };
  const k = owners.findIndex(o => o && o.length === 2 + 128);
  const hash = k >= 0 && c.signer === c.sender ? await c.hash() : undefined;
  if (hash) return { signature: coinbaseWrapper(BigInt(k), webAuthnStub(hash)), p256: true };
  const address = owners.findIndex(o => o && o.length === 2 + 64);
  return { signature: coinbaseWrapper(BigInt(Math.max(address, 0)), STUB_SIGNATURE) };
}
/** An existing Coinbase Smart Wallet: its owners read from the account. */
async function coinbaseStub(c: StubContext): Promise<Stub> {
  const owners: (Hex | undefined)[] = [];
  const call = async (data: Hex) => String(await c.deps.rpc!.call(c.chainId, 'eth_call', [{ to: c.sender, data }, 'latest'])) as Hex;
  try {
    const n = BigInt(await call(encodeFunctionData({ abi: OWNERS, functionName: 'nextOwnerIndex' })));
    for (let i = 0n; i < n && i < 16n; i++) owners.push(decodeAbiParameters([{ type: 'bytes' }], await call(encodeFunctionData({ abi: OWNERS, functionName: 'ownerAtIndex', args: [i] })))[0]);
  } catch { /* what was read */ }
  return coinbaseFor(owners, c);
}
const CREATE_ACCOUNT = parseAbi(['function createAccount(bytes[] owners, uint256 nonce)']);
/** A Coinbase Smart Wallet its factory is deploying: the owners createAccount sets. */
async function coinbaseDeployStub(c: StubContext, factoryData: Hex): Promise<Stub> {
  let owners: readonly Hex[] = [];
  try { owners = decodeFunctionData({ abi: CREATE_ACCOUNT, data: factoryData }).args[0]; } catch { /* none read */ }
  return coinbaseFor([...owners], c);
}
// --- Copies of Coinbase Smart Wallet ---
// Wallets run their own builds of Coinbase Smart Wallet v1 (its source is MIT-licensed), with their own factories:
// Base's "giga1" wallet (origin https://giga1.com) a build ported to EntryPoint v0.7 (implementation 0xca7f…6aaf,
// unpublished, 11,715 bytes against Coinbase's 18,002; factory 0x6455…b749, whose createAccount(bytes[] owners,
// uint256 nonce, bytes32) takes a word more), behind Solady's ERC-1967 proxy as Coinbase's are. Its passkey owner's
// operation was simulated as calls only: no stand-in was in its form. Neither is known by address, so one is taken for
// Coinbase's by what its implementation answers (coinbaseLike), and given Coinbase's stand-ins (coinbaseFor: owners
// read as Coinbase's keep them, a passkey's assertion in webauthn-sol's WebAuthnAuth, whose P256VERIFY call the
// stand-in answers); its own validation then decides, as for Coinbase's: a copy that checks signatures another way
// refuses the stand-in, and the preview says so. That the account runs that implementation is checked on its code,
// not taken from what a factory or a storage slot names: an existing account's code must be Solady's ERC-1967 proxy
// (which runs what its slot names), and an account being deployed must be at the address its factory derives for that
// proxy to the implementation, as Coinbase's factory does (CREATE2, with keccak256(abi.encode(owners, nonce)) as the
// salt), which only that proxy's creation code can make. Elsewhere it isn't taken for one (the plain stand-in).
const COINBASE_IMPLEMENTATIONS = new Set(['0x000100abaad02f1cfc8bbe32bd5a564817339e72', '0x00000110dcdedc9581cb5ecb8467282f2926534d']);
const COINBASE_VIEWS = parseAbi(['function REPLAYABLE_NONCE_KEY() view returns (uint256)', 'function entryPoint() view returns (address)', 'function implementation() view returns (address)',
  'function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)']);
/** What coinbaseLike and coinbaseFactoryOf found, by chain and address (only where the node answered). */
const COINBASE_LIKE = new Map<string, Promise<boolean>>(), FACTORY_IMPLEMENTATIONS = new Map<string, Promise<string | undefined>>();
/** The node answered (an execution error, or nothing to decode), rather than failing to. */
const answered = (e: unknown) => !!(e as { rpcError?: unknown })?.rpcError || /^Abi/.test(String((e as Error)?.name ?? ''));
const coinbaseView = async (c: StubContext, to: string, functionName: 'REPLAYABLE_NONCE_KEY' | 'entryPoint' | 'implementation' | 'eip712Domain'): Promise<unknown> =>
  decodeFunctionResult({ abi: COINBASE_VIEWS, functionName, data: String(await c.deps.rpc!.call(c.chainId, 'eth_call', [{ to, data: encodeFunctionData({ abi: COINBASE_VIEWS, functionName }) }, 'latest'])) as Hex } as never);
/**
 * Whether `implementation` answers as Coinbase Smart Wallet v1's own do: eip712Domain()'s name "Coinbase Smart Wallet"
 * and version "1", REPLAYABLE_NONCE_KEY() 8453 (Base's chain ID, a constant of its code whatever the chain), and
 * entryPoint() the operation's EntryPoint (Coinbase's take v0.6's; the giga1 build, v0.7's).
 */
function coinbaseLike(c: StubContext, implementation: string): Promise<boolean> {
  const key = `${c.chainId}:${implementation}:${c.entryPoint}`;
  let known = COINBASE_LIKE.get(key);
  if (!known) {
    known = (async () => {
      if ((await coinbaseView(c, implementation, 'REPLAYABLE_NONCE_KEY')) !== 8453n) return false;
      const [domain, entryPoint] = await Promise.all([coinbaseView(c, implementation, 'eip712Domain') as Promise<readonly unknown[]>, coinbaseView(c, implementation, 'entryPoint') as Promise<string>]);
      return domain[1] === 'Coinbase Smart Wallet' && domain[2] === '1' && entryPoint.toLowerCase() === c.entryPoint?.toLowerCase();
    })().catch(e => { if (!answered(e)) COINBASE_LIKE.delete(key); return false; });
    COINBASE_LIKE.set(key, known);
  }
  return known;
}
/** The implementation a factory deploys (its implementation()), as Coinbase's factories name theirs. */
function coinbaseFactoryOf(c: StubContext, factory: string): Promise<string | undefined> {
  const key = `${c.chainId}:${factory}`;
  let known = FACTORY_IMPLEMENTATIONS.get(key);
  if (!known) {
    known = (coinbaseView(c, factory, 'implementation') as Promise<string>).then(a => a.toLowerCase(), e => { if (!answered(e)) FACTORY_IMPLEMENTATIONS.delete(key); return undefined; });
    FACTORY_IMPLEMENTATIONS.set(key, known);
  }
  return known;
}
/**
 * Solady's ERC-1967 proxy (LibClone), which runs whatever implementation its slot names: Coinbase Smart Wallet's factories
 * deploy its accounts as it (its code, and its creation code for an implementation), and Modular Account v2's factory
 * its accounts (a semi-modular account's with its immutable args after it: runsModularAccount).
 */
const SOLADY_ERC1967 = '0x363d3d373d3d363d7f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc545af43d6000803e6038573d6000fd5b3d6000f3';
const soladyErc1967Creation = (implementation: string): Hex => `0x603d3d8160223d3973${implementation.slice(2).toLowerCase()}60095155f3${SOLADY_ERC1967.slice(2)}`;
/** How the account was seen to run the copy (coinbaseCopyStub), as its note says. */
const COPY_RUN = { proxy: "behind Solady's ERC-1967 proxy, as Coinbase's accounts are (its code is that proxy)", deploying: "behind Solady's ERC-1967 proxy, as Coinbase's accounts are (its address is the one its factory's CREATE2 gives that proxy to it)", delegated: 'as its EIP-7702 delegate' };
const coinbaseCopyNote = (implementation: string, how: keyof typeof COPY_RUN) => `The account runs ${implementation}, not Coinbase's own Coinbase Smart Wallet but a build of it that answers as Coinbase Smart Wallet v1 does (its EIP-712 name and version, replayable nonce key and EntryPoint), ${COPY_RUN[how]}: the stand-in is in Coinbase's form, which its validation took.`;
/**
 * Coinbase's stand-in for an account a copy of Coinbase Smart Wallet runs (coinbaseLike), its code Solady's ERC-1967
 * proxy or an EIP-7702 delegation to the copy (or the operation delegating to it, `delegated`); or that another factory
 * deploys as that proxy to a copy (its
 * implementation() coinbaseLike, its call's first two arguments the owners, as Coinbase's createAccount takes them,
 * each an address's 32 bytes or a passkey's 64, and the nonce, and the account's address the proxy's for that
 * implementation, from the factory, with Coinbase's salt); undefined for any other.
 */
async function coinbaseCopyStub(c: StubContext, runs?: string, factory?: string, factoryData?: Hex, delegated = false): Promise<Stub[] | undefined> {
  if (!c.deps.rpc?.has(c.chainId) || !c.entryPoint) return undefined;
  if (!factory) {
    if (!runs || COINBASE_IMPLEMENTATIONS.has(runs) || !await coinbaseLike(c, runs)) return undefined;
    let how: keyof typeof COPY_RUN = 'delegated';
    if (!delegated) {
      let code: string;
      try { code = String(await c.deps.rpc.call(c.chainId, 'eth_getCode', [c.sender, 'latest'])).toLowerCase(); } catch { return undefined; }
      if (code === SOLADY_ERC1967) how = 'proxy';
      else if (code !== `0xef0100${runs.slice(2)}`) return undefined;
    }
    return [{ ...(await coinbaseStub({ ...c, runs })), note: coinbaseCopyNote(runs, how) }];
  }
  const implementation = await coinbaseFactoryOf(c, factory);
  if (!implementation || COINBASE_IMPLEMENTATIONS.has(implementation) || !factoryData || !await coinbaseLike(c, implementation)) return undefined;
  let owners: readonly Hex[], nonce: bigint;
  try { [owners, nonce] = decodeAbiParameters([{ type: 'bytes[]' }, { type: 'uint256' }], `0x${factoryData.slice(10)}`); } catch { return undefined; }
  if (!owners.length || !owners.every(o => /^0x0{24}[0-9a-f]{40}$/i.test(o) || o.length === 2 + 128)) return undefined;
  const at = getContractAddress({ opcode: 'CREATE2', from: factory as Hex, salt: keccak256(encodeAbiParameters([{ type: 'bytes[]' }, { type: 'uint256' }], [owners, nonce])), bytecodeHash: keccak256(soladyErc1967Creation(implementation)) });
  if (at.toLowerCase() !== c.sender.toLowerCase()) return undefined;
  return [{ ...(await coinbaseFor([...owners], c)), note: coinbaseCopyNote(implementation, 'deploying') }];
}
/** Stand-ins for accounts a factory is deploying in the operation, by factory (their code doesn't exist yet). */
const FACTORY_STUBS: Record<string, (c: StubContext, factoryData: Hex) => Promise<Stub | Stub[]>> = {
  // Coinbase Smart Wallet's factories (v1 and v1.1).
  '0x0ba5ed0c6aa8c49038f819e587e2633c4a9f428a': coinbaseDeployStub, '0xba5ed110efdba3d005bfc882d75358acbbb85842': coinbaseDeployStub,
  // Alchemy's Modular Account v2 factory: createAccount (a ModularAccount with its single-signer validation) and
  // createSemiModularAccount sign in Modular Account v2's 0xff00 form (its verified source); a WebAuthn account isn't
  // given a passkey's here.
  '0x00000000000017c61b5bee81050ec8efc9c6fecd': async (_c, factoryData) => ['0xafa63a10', '0x8b4e464e'].includes(factoryData.slice(0, 10)) ? shaped('0xff00')() : { signature: STUB_SIGNATURE },
  // ZeroDev's KernelFactory for Kernel v2 (createAccount(implementation, initialize(defaultValidator, data), index)): the
  // default validator the account is set up with (kernelV2Stub). Taken as an account with no code, a Frak wallet's
  // deployment on Arbitrum One got the plain stand-in, which its passkey validator refused.
  '0x5de4839a76cf55d0c90e2061ef4386d962e15ae3': async (c, factoryData) => {
    try {
      const create = decodeFunctionData({ abi: KERNEL_V2, data: factoryData });
      if (create.functionName === 'createAccount') {
        const init = decodeFunctionData({ abi: KERNEL_V2, data: create.args[1] });
        if (init.functionName === 'initialize') return kernelV2Stub(c, { validator: init.args[0], data: init.args[1] });
      }
    } catch { /* another call */ }
    return { signature: STUB_SIGNATURE };
  },
  // Alchemy's LightAccountFactory v2.0.0 and MultiOwnerLightAccountFactory v2.0.0: accounts that sign with the 0x00
  // type byte (above), as one deployed in an operation on Ethereum did.
  '0x0000000000400cdfef5e2714e63d8040b700bc24': async () => shaped('0x00')(), '0x000000000019d2ee9f2729a65afe20bb0020aefc': async () => shaped('0x00')(),
  // KresusVaultFactory (createAccount; the KresusVault it deploys in its constructor, above): the same form. A Base
  // account it deployed in the operation reverted on the plain stand-in (InvalidSignatureType).
  '0x594304fa9eb2b90f866fc212dbede58fba887017': async () => shaped('0x00')(),
  // Biconomy's SmartAccountFactory v2 (deployCounterFactualAccount, deployAccount): a Smart Account v2 (its
  // basicImplementation, the same on both chains here) set up with the ECDSA ownership module signs in its form.
  '0x000000a56aaca3e9a4c479ea6b6cd0dbcb6634f5': async (_c, factoryData) => {
    try {
      const [module] = decodeFunctionData({ abi: BICONOMY_FACTORY, data: factoryData }).args;
      if (module.toLowerCase() === BICONOMY_ECDSA_MODULE) return biconomyStub();
    } catch { /* another call */ }
    return { signature: STUB_SIGNATURE };
  },
  // ZeroDev's FactoryStaker (deployWithFactory), deploying Kernel v3 accounts (see kernelDeployStub).
  [KERNEL_FACTORY_STAKER]: kernelDeployStub,
  // Splits' Smart Vault factory (its implementation's FACTORY()): the signers and threshold its createAccount sets
  // (see splitsVaultStub).
  '0x8e6af8ed94e87b4402d0272c5d6b0d47f0483e7c': async (c, factoryData) => {
    try {
      const d = decodeFunctionData({ abi: SPLITS, data: factoryData });
      if (d.functionName === 'createAccount') return splitsVaultStub(c, { signers: d.args[1], threshold: d.args[2] });
    } catch { /* another call */ }
    return { signature: STUB_SIGNATURE };
  },
  // OKX Wallet's account factory (see okxStubs).
  '0x5c328f3b5f117ffc693378a2c5b16c4f80f86295': okxDeployStub,
  // Biconomy's NexusAccountFactory (verified on Sourcify), whose accounts run Nexus 1.2 (its ACCOUNT_IMPLEMENTATION,
  // an immutable of its code, the same on the six chains here): see nexusDeployStub.
  '0x0000006648ed9b2b842552be63af870bc74af837': nexusDeployStub,
};
const BICONOMY_FACTORY = parseAbi(['function deployCounterFactualAccount(address moduleSetupContract, bytes moduleSetupData, uint256 index)', 'function deployAccount(address moduleSetupContract, bytes moduleSetupData)']);
/** Biconomy's ECDSA ownership module for Smart Account v2. */
const BICONOMY_ECDSA_MODULE = '0x0000001c5b32f37f5bea87bdd5374eb2ac54ea8e';
/** Biconomy Smart Account v2's form: abi.encode(the module's signature, the validation module). */
const biconomyStub = (): Stub => ({ signature: encodeAbiParameters([{ type: 'bytes' }, { type: 'address' }], [STUB_SIGNATURE, BICONOMY_ECDSA_MODULE]) });

// --- An EIP-7702 delegate in Biconomy Smart Account v2's form, with a cosigner ---
// Two deployments, neither published (not on Sourcify, nor their registries or modules); read from their code and
// their operations. The first, 0x13e0…9a5a (4,078 bytes, the same at its address on Ethereum, BNB Chain, Base and
// Arbitrum One; not deployed on Polygon), and the second, 0x6640…831c (4,622 bytes, another compiler's, the same at
// its address on all six chains here), work alike. EntryPoint v0.6 is the only one either takes (its ENTRY_POINT()).
// Its account answers Smart Account v2's calls (execute_ncC, executeBatch_y6U, execute, executeBatch) and takes its
// signature, abi.encode(the module's signature, a module), but checks it itself: the module is never called (the
// first's operations name 0xd88b…9ea3, "Multichain PassKeys Ownership Registry Module" 0.2.0, the second's
// 0xba41…967b, the same module's code with another registry in it).
// The module's signature is abi.encode(a cosignature, the owner's signature), and validation passes only with both:
// - the cosignature, over the operation's hash (personal_sign, else as is), checked by the delegate's registry
//   (isValidSignature(hash, signature) answering a bool): the first's, 0x980d…083b, takes one of its verifying
//   signers' (a mapping at slot 1), unless it is switched (slot 2) to take or refuse every signature; the second's,
//   0x82ea…e4dc (the same at its address on all six chains), which the delegate names (its getter 0xa600845b, which
//   the first lacks), takes its one verifying signer's (getVerifyingSigner(), slot 1's low 20 bytes; none where that
//   is zero), unless its owner switches it (0x21175b4a; slot 1's byte above the signer, read by 0x295a5212) to take
//   (1) or refuse (2) every signature. A cosignature its registry refuses, the second pays nothing toward the
//   operation's gas for (it returns 1 before paying its prefund: without a paymaster, the EntryPoint rejects the
//   operation, AA21), where it pays for an owner's signature it refuses;
// - the owner's, in the form of Biconomy's MultichainECDSAValidator (published in @biconomy-devx/account-contracts-v2):
//   abi.encode(validUntil, validAfter, a Merkle root, the proof, the signature), the account's own key signing the
//   root (personal_sign, else as is; OpenZeppelin's ECDSA.recover, which reverts on a malformed signature) of a tree
//   with keccak256(abi.encodePacked(validUntil, validAfter, the operation's hash)) among its leaves: one signature for
//   operations on several chains. A proof that doesn't reach the root fails validation (1; the second pays nothing
//   then either); validUntil 0 is none.
// The stand-in: the cosignature recovered as the registry's verifying signer (the second's read from it, with its
// mode, and where it has none, as another key's, refused as any will be; the first's can't be listed, so the one
// that cosigned every operation seen, 63 of 63 on BNB Chain and Ethereum, November 2026, listed in the registry on
// all four chains), and STUB_SIGNATURE over the root of a tree as the delegate's operations
// are mostly signed, with no time bounds. The first's: two leaves, the operation's and another (39 of 63 so; 21
// alone, 3 with two or three others). The second's: the operation's alone, as every one seen was (6 operations of 4
// accounts in 40,000 blocks on BNB Chain, 2026-11-15, each cosigned by its registry's signer and sponsored by
// 0xdeaa…34df). Each element of the proof costs about 355 gas: one of the first's operations signed alone costs
// about 390 less than the stand-in, one signed with two or three others about 320 more.
/** The first delegate's registry's verifying signer that cosigns its operations (the registry can't list them). */
export const COSIGNED_7702_COSIGNER = '0x9ff3c744db7ea31eb38689482ea7cb38438865c6';
/**
 * The delegates in that form: the module their operations name, how many other leaves the stand-in's tree has, the
 * cosigner where the registry can't be asked (otherwise read: see cosigned7702Registry), and whether it pays nothing
 * toward its gas for a cosignature its registry refuses (Stub's unpaid).
 */
const COSIGNED_7702_DELEGATES: Record<string, { module: Hex; siblings: 0 | 1; cosigner?: string; unpaid?: boolean }> = {
  '0x13e00e089f81ad9f36b655c9e9a07c6bf1489a5a': { module: '0xd88b687ba4237e6b9893020285103f45d8949ea3', siblings: 1, cosigner: COSIGNED_7702_COSIGNER },
  '0x6640c1cccaf07dbe765ec05e294fe427cc92831c': { module: '0xba418fa699622de824b258c61eb150ed7a13967b', siblings: 0, unpaid: true },
};
/**
 * The second delegate's getter for its registry (selector 0xa600845b; no name for it is published), and the
 * registry's for its signer and for its mode (0x295a5212, unnamed too: 0 takes the signer's, 1 any, 2 none).
 */
const COSIGNED_7702_REGISTRY = '0xa600845b' as Hex, COSIGNED_7702_MODE = '0x295a5212' as Hex;
const VERIFYING_SIGNER = parseAbi(['function getVerifyingSigner() view returns (address)']);
/** The other leaf of the stand-in's tree (any word: the account only hashes it with the operation's leaf). */
const COSIGNED_7702_SIBLING = `0x${'00'.repeat(31)}01` as Hex;
/**
 * The registry the delegate names, its verifying signer (the zero address where it has none) and its mode, read from
 * the chain (undefined if they can't be read).
 */
async function cosigned7702Registry(c: StubContext, delegate: string): Promise<{ registry: string; signer: string; mode: number } | undefined> {
  const call = async (to: string, data: Hex) => {
    const out = String(await c.deps.rpc!.call(c.chainId, 'eth_call', [{ to, data }, 'latest']));
    return /^0x[0-9a-f]{64}$/i.test(out) ? BigInt(out) : undefined;
  };
  const address = (v: bigint) => `0x${v.toString(16).padStart(40, '0')}`;
  try {
    const registry = await call(delegate, COSIGNED_7702_REGISTRY);
    if (!registry || registry >> 160n) return undefined;
    const [signer, mode] = await Promise.all([call(address(registry), encodeFunctionData({ abi: VERIFYING_SIGNER, functionName: 'getVerifyingSigner' })), call(address(registry), COSIGNED_7702_MODE)]);
    return signer !== undefined && !(signer >> 160n) && mode !== undefined && mode < 3n ? { registry: address(registry), signer: address(signer), mode: Number(mode) } : undefined;
  } catch { return undefined; }
}
async function cosigned7702Stub(c: StubContext): Promise<Stub> {
  const delegate = c.runs!, { module: named, siblings, cosigner: known, unpaid } = COSIGNED_7702_DELEGATES[delegate];
  const [hash, registry] = await Promise.all([c.hash(), known ? undefined : cosigned7702Registry(c, delegate)]);
  // The cosignature's stand-in: the verifying signer's; where the registry has none, a key that isn't its (a real
  // cosignature is someone's: refused, as any will be); the registry unread, no one's (refused, or its check reverts).
  const cosigner = known ?? (registry && (BigInt(registry.signer) ? registry.signer : ECRECOVER_NOBODY));
  // Why the account may not take it: the signer asked isn't the account (whatever its registry does); its registry
  // takes no cosignature now; or, unsure, the registry couldn't be read.
  const reg = registry && shortAddr(registry.registry);
  const why = c.signer.toLowerCase() !== c.sender.toLowerCase() ? "it takes its own key's signature (it is an EIP-7702 account), with its registry's cosignature, and the signer asked isn't the account"
    : known ? undefined
    : !registry ? "its signature carries a cosignature that its registry checks, and the registry couldn't be read"
    : registry.mode === 2 ? `its registry (${reg}) is switched to refuse every cosignature: the account takes no operation, whoever signs it, until the registry's owner switches it back`
    : registry.mode === 0 && !BigInt(registry.signer) ? `its registry (${reg}) has no verifying signer, so it refuses every cosignature: the account takes no operation, whoever signs it, until the registry's owner sets one`
    : undefined;
  const leaf = hash && keccak256(concatHex(['0x000000000000', '0x000000000000', hash]));
  // OpenZeppelin's MerkleProof hashes each pair in sorted order. Without the hash, a root the proof can't reach: the
  // account refuses the signature (validation returns 1) rather than reverting.
  const proof = siblings ? [COSIGNED_7702_SIBLING] : [];
  const root = !leaf ? `0x${'00'.repeat(32)}` as Hex : !siblings ? leaf : keccak256(BigInt(leaf) < BigInt(COSIGNED_7702_SIBLING) ? concatHex([leaf, COSIGNED_7702_SIBLING]) : concatHex([COSIGNED_7702_SIBLING, leaf]));
  const owner = encodeAbiParameters(parseAbiParameters('uint48, uint48, bytes32, bytes32[], bytes'), [0, 0, root, proof, STUB_SIGNATURE]);
  const module = encodeAbiParameters(parseAbiParameters('bytes, bytes'), [STUB_COSIGNATURE, owner]);
  return { signature: encodeAbiParameters([{ type: 'bytes' }, { type: 'address' }], [module, named]), cosigners: cosigner ? [{ signature: STUB_COSIGNATURE, signer: cosigner }] : [],
    ...(why && { why }), ...(why && !known && !registry && c.signer.toLowerCase() === c.sender.toLowerCase() && { unsure: true }), ...(unpaid && { unpaid }) };
}

// --- OKX Wallet's smart account ---
// Unpublished; read from its behaviour on BNB Chain and Base (its function names from OpenChain, its checks from
// running real operations' validateUserOp in a local EVM and watching what it hashes and calls). It keeps its keys
// as Uniswap's Calibur does: by hash, each with settings (an admin flag, an expiry, a hook), and a non-admin key
// can't make the account call itself. Unlike Calibur it stores only the hash and a type, 1 for an Ethereum key
// (the hash of its address) and 2 for a passkey (the hash of its public key's x and y), and the signature carries
// the rest:
//   key hash (32 bytes) | validUntil (uint48) | r, s, v                                              (type 1)
//   key hash (32 bytes) | validUntil (uint48) | x | y | abi.encode(WebAuthnAuth, bytes32[] proof)    (type 2)
// What the key signs is keccak256(abi.encode(the operation's hash, validUntil, the implementation)), or, with a
// proof, the root of a Merkle tree that hash is a leaf of (one signature for operations on several chains): an
// Ethereum key signs it as it is, a passkey as its assertion's challenge, checked by P256VERIFY. validateUserOp
// returns validUntil; for a signature it doesn't accept, not 1 (SIG_VALIDATION_FAILED) but a value the EntryPoint
// reads as an aggregator, which it rejects as well (AA24).
// The account runs its calls through executeUserOp, which reads the key's hash back out of the signature and
// applies that key's settings: with the bare stand-in, an unknown key, an operation that adds an owner (a call to
// the account itself, as most first operations make) failed with NonAdminSelfCall where the signed one succeeded.
// A key's type can also be a contract that checks its signatures (an external verifier): the account calls it
// (selector 0x9b2c81d3) with the key's hash, the digest and the rest of the signature, and takes its answer. One is
// OKX's passkey verifier (OKX_PASSKEY_VERIFIER, below); another checks an Ethereum key's personal_sign (OKX_EIP191_VERIFIER).
export const OKX_IMPLEMENTATION = '0x36d3cbd83961868398d056efbf50f5ce15528c0d';
/**
 * OKX's passkey verifier (unpublished: an ERC-1967 proxy, EIP-712 domain "SmartWallet" 1.0.0, at this address on every
 * chain here, its implementation OKX_PASSKEY_VERIFIER_CODE in November 2026), read from its behaviour on an operation
 * on OP Mainnet (0xb7e5…fc30), its validateUserOp run in a local EVM: a key of its type signs
 *   key hash | validUntil (uint48) | abi.encode(bytes passkey, bytes cosignature)
 * the passkey's part as a type-2 key's (x | y | abi.encode(WebAuthnAuth, bytes32[] proof)), whose public key it hashes
 * against the key's hash and whose assertion it checks (its type and challenge, the digest base64url-encoded, then
 * P256VERIFY), and an ECDSA signature over the same digest by the key it records for the account (a mapping at its
 * slot 0): both, or the account's validation fails as for any key's refusal.
 */
export const OKX_PASSKEY_VERIFIER = '0xa9215f1afa5e2a5bb924f53186934b5da3459fe8';
const OKX_PASSKEY_VERIFIER_CODE = '0x47f00fd16ccfdcec08617373f524a5e68ac8a29a';
/**
 * Another external verifier a key's type can name (unpublished, 2,118 bytes and not a proxy, at this address on BNB
 * Chain, Ethereum, Base and Arbitrum One): an Ethereum key that signs the account's digest as personal_sign does. Its
 * code recovers the signer from the digest's EIP-191 form (OpenZeppelin's ECDSA: low s), and takes the key whose hash
 * is that address's, as a type-1 key's is: key hash | validUntil | r, s, v. Read from an operation on BNB Chain
 * (0x7b5b…5ec2, block 134,520,450), whose signature recovers so to the key's address. Taken for one of the account's
 * passkeys (the key most likely to sign where the signer asked wasn't recognized as one of its keys), its stand-in ran
 * the passkey's checks: 9,101 gas (6.6%) over the operation's own.
 */
export const OKX_EIP191_VERIFIER = '0xd963ba3b7c1ca15abf60606c9bea4ab545cffe99';
/** Its storage root (CUSTOM_STORAGE_ROOT()): a key's type is at keccak256(key hash, root + 1), its settings at keccak256(key hash, root + 2). */
const OKX_STORAGE_ROOT = 0x653ff6dcbda533c3c7d8ffb646da3e510d0de40f237170c4da3f874472aecb00n;
const okxSlot = (key: Hex, n: bigint) => keccak256(concatHex([key, `0x${(OKX_STORAGE_ROOT + n).toString(16).padStart(64, '0')}`]));
/** Settings: an admin flag (bit 200), the expiry in seconds (uint40, 0 for none) and a hook's address below it. */
const OKX_ADMIN = 1n << 200n;
const OKX = parseAbi(['function getOwnerKeys() view returns (bytes32[])', 'function createAccount((bytes32 keyHash, address keyType)[] owners, uint256 salt)', 'function createAccountWithCall((bytes32 keyHash, address keyType)[] owners, uint256 salt, ((address to, uint256 value, bytes data)[] calls, uint256 nonce) batch, bytes signature)']);
/** The stand-in passkey's public key: any two words, as only the P256VERIFY stand-in checks its signature. */
const OKX_PASSKEY = { x: `0x${'51'.repeat(32)}` as Hex, y: `0x${'52'.repeat(32)}` as Hex };
/** What an OKX account's key signs for this operation's hash (without a Merkle proof). */
export const okxDigest = (userOpHash: Hex, validUntil: bigint): Hex =>
  keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }], [userOpHash, validUntil, OKX_IMPLEMENTATION]));
type OkxKey = { hash: Hex; type: bigint; settings: bigint };
/**
 * The stand-ins for an OKX account with these keys, in the order to try them:
 * - the signer's own key, if its address is one (an Ethereum key, the account's own or OKX_EIP191_VERIFIER's): the
 *   Ethereum key's form, which ecrecover's stand-in signs;
 * - else, for the key most likely to sign (a passkey before an Ethereum key, an admin before others, unexpired
 *   before expired), a stand-in key registered in the account's storage for the run with that key's type and
 *   settings: the real key can't stand, as a passkey's public key is only in its signatures and an Ethereum key's
 *   address is known only by its hash. Validation then runs every check on it that it runs on the real one, and
 *   the calls run with that key's permissions;
 * - for an account the operation deploys, whose storage a node empties when it creates it (BNB Chain's did: the
 *   stand-in key was gone by validation), the stand-in key is registered by the account's own initializer instead:
 *   the implementation's code moves to another address and okxInitializing takes its place, which hands
 *   initialize() the stand-in key's hash where the factory passed that key's, and every call on unchanged. The
 *   factory has derived the account's address from the real keys by then, and the initializer writes what it would;
 * - as the last resort, the real key's hash with a signature the account won't accept. Its signature check isn't
 *   simulated then (2.3% of the gas of first operations on BNB Chain), but the calls run as that key.
 * A passkey signs as the account itself (a passkey wallet's way, as Coinbase's, Send's and Barz's do): asked by anyone
 * else who isn't one of the account's Ethereum keys, where the key most likely to sign is a passkey, the stand-in is
 * that key's real hash with the stand-in passkey's part, which the account's check refuses, and the preview says the
 * account is signed by its passkey (no address but the account's can sign as one).
 * A key of OKX's passkey verifier's type (see OKX_PASSKEY_VERIFIER) is a passkey's too: the stand-in key, of that type,
 * signs the passkey's part (its assertion checked by the verifier, through P256VERIFY's stand-in) and STUB_COSIGNATURE
 * as the verifier's cosignature, recovered as the key the verifier records for the account (the preview saying that
 * key must cosign too). Only while the verifier runs the code its form was read from, and records a key for the
 * account; otherwise the stand-in is the last resort's (the real key's hash, the form the verifier's known code took),
 * and the preview says the verifier's check isn't known, so the refusal needn't mean the passkey can't sign. The
 * account on OP Mainnet whose operation showed it (0x21c9…9359, behind OKX's 797-byte proxy, implementationOf) had been
 * given the plain stand-in, which it refused: on the latest state its operation came out 36,339 gas (23%) short of its
 * own signature's run; now 17 gas over.
 */
async function okxStubs(c: StubContext, keys: OkxKey[], deployed: boolean): Promise<Stub[]> {
  const hash = await c.hash();
  if (!hash || !keys.length) return [{ signature: STUB_SIGNATURE }];
  const now = BigInt(Math.floor(Date.now() / 1000));
  const validUntil = now + 365n * 86400n, until = `0x${validUntil.toString(16).padStart(12, '0')}` as Hex;
  const ecdsa = (key: Hex) => concatHex([key, until, STUB_SIGNATURE]);
  const assertion = concatHex([OKX_PASSKEY.x, OKX_PASSKEY.y, encodeAbiParameters([WEBAUTHN_AUTH, { type: 'bytes32[]' }], [webAuthnAuth(okxDigest(hash, validUntil), 'okx.com'), []])]);
  const passkey = (key: Hex) => concatHex([key, until, assertion]);
  const verified = (key: Hex) => concatHex([key, until, encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes' }], [assertion, STUB_COSIGNATURE])]);
  const own = keccak256(c.signer as Hex);
  // An Ethereum key, whether the account recovers it itself or OKX's EIP-191 verifier does: the same layout, which
  // ecrecover's stand-in answers over either digest.
  const EIP191 = BigInt(OKX_EIP191_VERIFIER), isEthereum = (k: OkxKey) => k.type === 1n || k.type === EIP191;
  if (keys.some(k => k.hash === own && isEthereum(k))) return [{ signature: ecdsa(own) }];
  const VERIFIED = BigInt(OKX_PASSKEY_VERIFIER), isPasskey = (k: OkxKey) => k.type === 2n || k.type === VERIFIED;
  const expired = (k: OkxKey) => { const at = (k.settings >> 160n) & 0xffffffffffn; return at !== 0n && at <= now; };
  const rank = (k: OkxKey) => (isPasskey(k) ? 0 : 4) + (expired(k) ? 2 : 0) + (k.settings & OKX_ADMIN ? 0 : 1);
  const key = keys.filter(k => isEthereum(k) || isPasskey(k)).sort((a, b) => rank(a) - rank(b))[0];
  if (!key) return [{ signature: STUB_SIGNATURE }];
  // A key of the verifier's type: the verifier's key for the account (its cosigner), where it runs its known code.
  const verifier = key.type === VERIFIED ? await okxVerifierCosigner(c) : undefined;
  const cosigner = verifier?.cosigner;
  // A passkey, asked by an address that isn't the account (nor one of its Ethereum keys: above): the real key, which
  // the stand-in passkey's public key doesn't hash to, so the account's check refuses it.
  if (isPasskey(key) && c.signer !== c.sender) {
    const by = key.type === 2n ? 'its passkey' : cosigner ? `its passkey, which OKX's passkey verifier (${shortAddr(OKX_PASSKEY_VERIFIER)}) takes only with a cosignature by ${cosigner}` : `its passkey, checked by OKX's passkey verifier (${shortAddr(OKX_PASSKEY_VERIFIER)})`;
    const asked = cosigner && c.signer === cosigner ? "the signer asked is that cosigner, whose signature is only the second of the two" : "the signer asked is neither the account nor one of its Ethereum keys";
    return [{ signature: key.type === 2n ? passkey(key.hash) : verified(key.hash), p256: true, why: `OKX Wallet's account here is signed by ${by} (a passkey wallet signs as the account itself), and ${asked}` }];
  }
  // The verifier's checks not known (its code isn't the one they were read from, or it records no cosigner for the
  // account): the last resort, which needn't be refused as the passkey's own signature would be.
  if (key.type === VERIFIED && !cosigner) {
    return [{ signature: verified(key.hash), p256: true, unsure: true,
      why: `the account's key is a passkey checked by OKX's passkey verifier (${shortAddr(OKX_PASSKEY_VERIFIER)}), ${verifier?.unknown ?? "whose checks weren't read"}: the stand-in is in the form its known code takes`,
      note: `The account's key is a passkey checked by OKX's passkey verifier (${shortAddr(OKX_PASSKEY_VERIFIER)}), ${verifier?.unknown ?? "whose checks weren't read"}: the stand-in, in the form its known code takes, was accepted all the same.` }];
  }
  const standIn = isPasskey(key) ? keccak256(concatHex([OKX_PASSKEY.x, OKX_PASSKEY.y])) : own;
  const word = (v: bigint) => `0x${v.toString(16).padStart(64, '0')}`;
  const storage = { [okxSlot(standIn, 1n)]: word(key.type), [okxSlot(standIn, 2n)]: word(key.settings) };
  // The key's place in initialize((bytes32 keyHash, address keyType)[])'s calldata: the selector, the array's offset
  // and length, then two words a key.
  let registered: Pick<Stub, 'storage' | 'code' | 'warm'> | undefined = { storage };
  if (!deployed) {
    let implementation: string | undefined;
    try { implementation = String(await c.deps.rpc!.call(c.chainId, 'eth_getCode', [OKX_IMPLEMENTATION, 'latest'])); } catch { /* no code read */ }
    registered = implementation && implementation.length > 2
      ? { code: { [OKX_IMPLEMENTATION]: okxInitializing(key.hash, standIn, 4 + 64 + 64 * keys.indexOf(key)), [OKX_MOVED]: implementation as Hex }, warm: [OKX_MOVED] } : undefined;
  }
  // A key of the verifier's type: the passkey's part and the cosignature, which ecrecover's stand-in recovers as the
  // verifier's key for the account.
  const signed = (k: Hex): Stub => key.type === 2n ? { signature: passkey(k), p256: true } : key.type === VERIFIED
    ? { signature: verified(k), p256: true, cosigners: [{ signature: STUB_COSIGNATURE, signer: cosigner! }],
      note: `The account's key is a passkey whose signatures OKX's passkey verifier (${shortAddr(OKX_PASSKEY_VERIFIER)}, unpublished: its checks read from what it does) takes only with a cosignature by the key it records for the account (${cosigner}), over the same digest: the stand-in stands in for both, so the operation validates only once that key cosigns it too.` }
    : { signature: ecdsa(k) };
  const last: Stub = signed(key.hash);
  if (!registered) return [last];
  return [{ ...signed(standIn), ...registered }, last];
}
/**
 * The key OKX's passkey verifier records for the account (its cosigner: a mapping at its slot 0), while the verifier
 * runs the code its form was read from (OKX_PASSKEY_VERIFIER_CODE); else why its checks aren't known (`unknown`: its
 * code isn't that, it records no key for the account, or neither was read).
 */
async function okxVerifierCosigner(c: StubContext): Promise<{ cosigner?: string; unknown?: string }> {
  const rpc = c.deps.rpc?.has(c.chainId) ? c.deps.rpc : undefined;
  if (!rpc) return { unknown: "whose code and record of the account weren't read" };
  try {
    const [code, recorded] = await Promise.all([
      rpc.call(c.chainId, 'eth_getStorageAt', [OKX_PASSKEY_VERIFIER, ERC1967_IMPLEMENTATION_SLOT, 'latest']),
      rpc.call(c.chainId, 'eth_getStorageAt', [OKX_PASSKEY_VERIFIER, keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [c.sender as Hex, 0n])), 'latest'])]);
    const runs = `0x${String(code).slice(-40)}`.toLowerCase();
    if (runs !== OKX_PASSKEY_VERIFIER_CODE) return { unknown: `whose code (${shortAddr(runs)}) isn't the code its checks were read from` };
    const key = BigInt(String(recorded));
    return key !== 0n && key < 1n << 160n ? { cosigner: `0x${key.toString(16).padStart(40, '0')}` } : { unknown: 'which records no cosigner for the account' };
  } catch { return { unknown: "whose code and record of the account weren't read" }; }
}
/** Where OKX's implementation code moves while okxInitializing takes its address. */
const OKX_MOVED = '0x0000000000000000000000000000000000ec0c0d';
/**
 * Code for OKX's implementation address while an operation deploys an account: every call goes on to the real code
 * (at OKX_MOVED) by delegatecall, as the account's proxy made it, with the same calldata, except that
 * initialize(...) is handed `standIn` where the word at `at` is `key`.
 *   calldatacopy(0, 0, calldatasize)
 *   if (selector == initialize && calldataload(at) == key) mstore(at, standIn)
 *   ok = delegatecall(gas, OKX_MOVED, 0, calldatasize, 0, 0); returndatacopy(0, 0, returndatasize)
 *   if (ok) return(0, returndatasize) else revert(0, returndatasize)
 */
export function okxInitializing(key: Hex, standIn: Hex, at: number): Hex {
  const where = at.toString(16).padStart(4, '0'), jump = (to: number) => `61${to.toString(16).padStart(4, '0')}57`;
  // calldatacopy(0, 0, calldatasize); calldataload(0) >> 224 == initialize's selector && calldataload(at) == key
  const test = `366000600037` + `60003560e01c63466e548314` + `61${where}357f${key.slice(2)}14` + `1615`;
  const swap = `7f${standIn.slice(2)}61${where}52`;                                   // mstore(at, standIn)
  const call = `5b600060003660007${'3'}${OKX_MOVED.slice(2)}5af4` + `3d6000803e`;      // delegatecall(gas, moved, 0, calldatasize, 0, 0); returndatacopy(0, 0, returndatasize)
  const skip = (test.length + 8 + swap.length) / 2, ok = skip + (call.length + 8 + 8) / 2;
  return `0x${test}${jump(skip)}${swap}${call}${jump(ok)}3d6000fd5b3d6000f3` as Hex;
}
/** An existing OKX account: its keys (the first eight), their types and settings read from its storage. */
async function okxStub(c: StubContext): Promise<Stub[]> {
  try {
    const out = String(await c.deps.rpc!.call(c.chainId, 'eth_call', [{ to: c.sender, data: encodeFunctionData({ abi: OKX, functionName: 'getOwnerKeys' }) }, 'latest'])) as Hex;
    const hashes = decodeFunctionResult({ abi: OKX, functionName: 'getOwnerKeys', data: out }).slice(0, 8);
    const slot = async (key: Hex, n: bigint) => BigInt(String(await c.deps.rpc!.call(c.chainId, 'eth_getStorageAt', [c.sender, okxSlot(key, n), 'latest'])));
    return okxStubs(c, await Promise.all(hashes.map(async hash => ({ hash, type: await slot(hash, 1n), settings: await slot(hash, 2n) }))), true);
  } catch { return [{ signature: STUB_SIGNATURE }]; }
}
/** An OKX account its factory is deploying: the keys createAccount sets, each an admin with no expiry or hook (as its initializer leaves them). */
async function okxDeployStub(c: StubContext, factoryData: Hex): Promise<Stub[]> {
  try {
    const owners = decodeFunctionData({ abi: OKX, data: factoryData }).args[0] as readonly { keyHash: Hex; keyType: string }[];
    return okxStubs(c, owners.map(o => ({ hash: o.keyHash, type: BigInt(o.keyType), settings: OKX_ADMIN })), false);
  } catch { return [{ signature: STUB_SIGNATURE }]; }
}

// --- Quip's ShrincsWallet (post-quantum: SHRINCS hash-based signatures; verified source on Sourcify, Base) ---
// validateUserOp takes abi.encode(PublicKey, Signature, bytes ecdsaSig): the owner()'s ECDSA co-signature (over the
// wallet's EIP-712 hash of the operation's hash) and a one-time SHRINCS signature, which the wallet's pinned
// verifier checks against the key bundle's commitment in the wallet's storage: a WOTS-C signature (64 base-16 chains,
// their digits summing to 480, ground with a counter) on leaf q of an unbalanced tree, whose authentication path has
// q nodes (so a signature grows 32 bytes with each one the key makes). On success the leaf and the wallet's action
// nonce are consumed. Neither half exists before signing, and the hash-based one can't be stood in for at a
// precompile: the stand-in is a real SHRINCS signature by a key made up for the run, on the leaf the wallet's own
// key signs next (its lowest unused one), with that key's commitment set in the wallet's storage for the run.
// Validation then runs every check and hash the real signature's does (the verifier's chain walks, the tree path,
// the leaf's bitmap word), for the gas it will use, and the ECDSA half is the usual stand-in for owner().
export const SHRINCS_IMPLEMENTATION = '0xc4e4652898bb12c4f0ba9083829689b1963135e7';
/** Another build of it (verified on Sourcify, Base; the same storage and pinned verifier), seen 2026-11-13. */
const SHRINCS_IMPLEMENTATION_2 = '0x680840c831c6d147404a0e00eda08a5360564fbc';
/** Its storage (ShrincsWalletStorage): the key's commitment at +1, keyVersion +3, the action nonce +4, then statefulLeavesUsed and maxSignatures (uint32s, packed, the first the lowest) at +5. */
const SHRINCS_SLOT = 0x156c3acdcccbf9925f3430f598565ae5b05788e8a68a7bf182e71c432eafdc00n;
const SHRINCS_OP_VERIFY_STATEFUL = keccak256(stringToHex('shrincs-verify-stateful'));
const SHRINCS_PUBLIC_KEY = parseAbiParameters('(bytes statefulPublicKey, bytes publicKeyCommitment, bytes pkSeed, bytes hypertreeRoot), (bytes32 randomizer, uint32 counter, bytes32[] chains, bytes32[] authPath), bytes');
/**
 * A valid SHRINCS signature for `userOpHash` by a key made up here (see above), on leaf `leaf`, as this wallet
 * verifies it: what it signs is keccak(OP_VERIFY_STATEFUL, suite 1, commitment, the action hash), the action hash
 * binding the wallet's domain (keccak of its tag, the chain and the wallet), its action nonce, its key version,
 * the ERC-4337 action type and keccak(userOpHash). Returns the signature (with `ecdsa` as the co-signature) and the
 * key's commitment. Each WOTS-C chain's secret walks 15 steps to its endpoint; the signature reveals it after its
 * digit's steps, and the counter is ground until the digits sum to 480.
 */
export function shrincsStandIn(wallet: string, chainId: number, userOpHash: Hex, state: { keyVersion: bigint; nonce: bigint; maxSignatures: number }, leaf: number, ecdsa: Hex): { signature: Hex; commitment: Hex } {
  const u32 = (n: number) => n.toString(16).padStart(8, '0'), w = (n: bigint) => n.toString(16).padStart(64, '0');
  const seed = keccak256(stringToHex('signing-preview SHRINCS stand-in'));
  const pkSeed = keccak256(concatHex([seed, '0x01'])), statelessSeed = keccak256(concatHex([seed, '0x02'])), hypertreeRoot = keccak256(concatHex([seed, '0x03']));
  const step = (chain: number, at: number, v: Hex) => keccak256(`0x${stringToHex('uxmss-wots-chain').slice(2)}${pkSeed.slice(2)}${w((BigInt(leaf) << 64n) | (BigInt(chain) << 32n) | BigInt(at))}${v.slice(2)}` as Hex);
  // Each chain: its secret, and the values after each step (walk[i][k]: after k steps; walk[i][15], the endpoint).
  const walks = Array.from({ length: 64 }, (_, i) => { const out: Hex[] = [keccak256(concatHex([seed, `0x${u32(i)}`]))]; for (let k = 0; k < 15; k++) out.push(step(i, k, out[k])); return out; });
  const pkHash = keccak256(concatHex([stringToHex('uxmss-wots-pk'), pkSeed, `0x${u32(leaf)}`, ...walks.map(x => x[15])]));
  const parent = (left: number, a: Hex, b: Hex) => keccak256(concatHex([stringToHex('uxmss-node'), pkSeed, `0x${u32(left)}`, a, b]));
  const authPath = Array.from({ length: leaf }, (_, k) => keccak256(concatHex([seed, '0x04', `0x${u32(k)}`])));
  let root = parent(leaf, pkHash, authPath[0]);
  for (let k = 0; k < leaf - 1; k++) root = parent(leaf - k - 1, authPath[k + 1], root);
  const statefulPublicKey = concatHex([pkSeed, root, `0x${u32(state.maxSignatures)}`]);
  const commitment = keccak256(concatHex([stringToHex('shrincs-public-key/shrincs-256s-keccak'), statefulPublicKey, statelessSeed, hypertreeRoot]));
  const domain = keccak256(concatHex([keccak256(stringToHex('quip-shrincs-wallet-v1')), `0x${w(BigInt(chainId))}`, `0x${w(BigInt(wallet))}`]));
  const action = keccak256(concatHex([SHRINCS_OP_VERIFY_STATEFUL, '0x00000001', commitment, domain, `0x${w(state.nonce)}`, `0x${w(state.keyVersion)}`, keccak256(stringToHex('quip.shrincs.action.erc4337Execute')), keccak256(userOpHash)]));
  const message = keccak256(concatHex([SHRINCS_OP_VERIFY_STATEFUL, '0x00000001', commitment, action]));
  const randomizer = keccak256(concatHex([seed, '0x05']));
  for (let counter = 0; counter < 1_000_000; counter++) {
    const digest = keccak256(concatHex([stringToHex('uxmss-wots-digits'), pkSeed, `0x${u32(leaf)}`, randomizer, `0x${u32(counter)}`, message]));
    const digits = [...digest.slice(2)].map(d => parseInt(d, 16));
    if (digits.reduce((a, b) => a + b, 0) !== 480) continue;
    const signature = encodeAbiParameters(SHRINCS_PUBLIC_KEY, [{ statefulPublicKey, publicKeyCommitment: commitment, pkSeed: statelessSeed, hypertreeRoot },
      { randomizer, counter, chains: digits.map((d, i) => walks[i][d]), authPath }, ecdsa]);
    return { signature, commitment };
  }
  throw new Error('no counter found');
}
const SHRINCS = parseAbi(['function statefulLeafBitmapWord(uint256 wordIndex) view returns (uint256)']);
/**
 * An existing ShrincsWallet: its key's state read from its storage. The stand-in signs the leaf the wallet's key
 * signs next: its lowest unused one (statefulLeafBitmapWord), as 45 of 45 operations on Base had (one of them leaf 3
 * of a key whose leaves 1, 2 and 4 to 11 were used; the others statefulLeavesUsed + 1).
 */
async function shrincsStub(c: StubContext): Promise<Stub[]> {
  const hash = await c.hash();
  if (!hash || !c.deps.rpc?.has(c.chainId)) return [{ signature: STUB_SIGNATURE }];
  try {
    const slot = async (n: bigint) => BigInt(String(await c.deps.rpc!.call(c.chainId, 'eth_getStorageAt', [c.sender, `0x${(SHRINCS_SLOT + n).toString(16)}`, 'latest'])));
    const [keyVersion, nonce, budget] = await Promise.all([slot(3n), slot(4n), slot(5n)]);
    const maxSignatures = Number((budget >> 32n) & 0xffffffffn);
    const word = async (i: number) => BigInt(String(await c.deps.rpc!.call(c.chainId, 'eth_call', [{ to: c.sender, data: encodeFunctionData({ abi: SHRINCS, functionName: 'statefulLeafBitmapWord', args: [BigInt(i)] }) }, 'latest'])));
    const words = await Promise.all(Array.from({ length: Math.min(Math.floor(maxSignatures / 256) + 1, 16) }, (_, i) => word(i)));
    let leaf = 1;
    while (leaf <= maxSignatures && leaf < words.length * 256 && (words[leaf >> 8] >> BigInt(leaf & 255)) & 1n) leaf++;
    // A key with no leaf left can't sign (the wallet rotates first): nothing to stand in for.
    if (leaf > maxSignatures || leaf >= words.length * 256) return [{ signature: STUB_SIGNATURE }];
    const { signature, commitment } = shrincsStandIn(c.sender, c.chainId, hash, { keyVersion, nonce, maxSignatures }, leaf, STUB_SIGNATURE);
    return [{ signature, storage: { [`0x${(SHRINCS_SLOT + 1n).toString(16)}`]: commitment } }];
  } catch { return [{ signature: STUB_SIGNATURE }]; }
}

// --- The bullbit.ai wallet's account ---
// Unpublished; its function names from OpenChain, its signature's layout read from its operations on Base and
// checked by running them with stand-ins. A passkey owner's signature is 0x00, the passkey's id (an entry of
// getPasskeyOwners(), whose key passkeyOwners(id) holds), its WebAuthn assertion as authenticatorData and
// clientDataJSON each after its length, and r and s, which it checks with P256VERIFY; the challenge is the
// operation's hash. An EOA owner's (getEOAOwners()) is 0x01 and its signature. Its check walks clientDataJSON byte
// by byte (about 280 gas a byte), and neither the origin nor the authenticator data's RP id hash is checked: the
// stand-in's clientDataJSON is what its dApp's passkeys sign (origin https://staking.bullbit.ai), without the key
// Chrome adds to some at random ("other_keys_can_be_added_here", 109 bytes, 30,296 gas more: in a fifth of them).
export const BULLBIT_IMPLEMENTATION = '0x330e71c9cd056a2e91a459f8112e8f8922ba5c13';
const BULLBIT = parseAbi(['function getPasskeyOwners() view returns (bytes32[])', 'function expectedOrigin() view returns (string)']);
async function bullbitStub(c: StubContext): Promise<Stub[]> {
  const eoa: Stub = { signature: `0x01${STUB_SIGNATURE.slice(2)}` as Hex };
  if (!c.deps.rpc?.has(c.chainId)) return [eoa];
  const read = async (data: Hex) => String(await c.deps.rpc!.call(c.chainId, 'eth_call', [{ to: c.sender, data }, 'latest'])) as Hex;
  try {
    // An EOA owner signs as itself; the account itself is asked to sign for a passkey (as Coinbase's, coinbaseFor).
    if (c.signer !== c.sender) return [eoa];
    const [ids, origin, hash] = await Promise.all([
      read(encodeFunctionData({ abi: BULLBIT, functionName: 'getPasskeyOwners' })).then(data => decodeFunctionResult({ abi: BULLBIT, functionName: 'getPasskeyOwners', data })),
      read(encodeFunctionData({ abi: BULLBIT, functionName: 'expectedOrigin' })).then(data => decodeFunctionResult({ abi: BULLBIT, functionName: 'expectedOrigin', data }), () => ''),
      c.hash()]);
    if (!ids.length || !hash) return [eoa];
    const clientDataJSON = `{"type":"webauthn.get","challenge":"${base64url(hash)}","origin":"${origin || 'https://staking.bullbit.ai'}","crossOrigin":false}`;
    const authenticatorData = concatHex([sha256(stringToHex('bullbit.ai')), '0x1d', '0x00000000']);
    const length = (bytes: number) => `0x${bytes.toString(16).padStart(64, '0')}` as Hex;
    return [{ signature: concatHex(['0x00', ids[0], length(37), authenticatorData, length(clientDataJSON.length), stringToHex(clientDataJSON), P256_STUB.r, P256_STUB.s]), p256: true }, eoa];
  } catch { return [eoa]; }
}

// --- Send's account (SendAccount, verified on Sourcify, Base; based on Daimo's account) ---
// A 1-of-n multisig of passkeys, each in a slot (keys(slot): its public key's x and y). validateUserOp takes
//   version (0x01) | validUntil (uint48) | key slot (uint8) | abi.encode(authenticatorData, clientDataJSON,
//   challengeLocation, responseTypeLocation, r, s)
// any other version failing (so STUB_SIGNATURE's 0xff was refused before any check ran: on Base the operations came
// out 11.6% low): the key's WebAuthn assertion, whose challenge is version | validUntil | the operation's hash,
// base64url-encoded, checked by its verifier (SendVerifier, behind an upgradeable proxy; the WebAuthn library of its
// published source checks the type and challenge where the assertion says they are, and the user's presence). The
// implementation it runs now is unpublished; its code names both P256VERIFY and Daimo's verifier contract, and it
// asks the precompile: its stand-in alone validates there. The stand-in is that assertion as Send's app makes it
// (origin https://send.app, its RP ID's hash, user present, verified and backed up: the flags 0x1d its operations
// carry), valid for a day, by the key in slot 0, else the slot the account's latest earlier operation used.
export const SEND_IMPLEMENTATION = '0x13f091e58b60fd0bd8052b8e7045553d83d80de0';
const SEND = parseAbi(['function keys(uint8 slot, uint256 i) view returns (bytes32)']);
/** Send's stand-in signature for this operation's hash, by the key in `slot`, valid until `validUntil` (seconds). */
export function sendStandIn(userOpHash: Hex, slot: number, validUntil: bigint): Hex {
  const until = `0x${validUntil.toString(16).padStart(12, '0')}` as Hex;
  const clientDataJSON = `{"type":"webauthn.get","challenge":"${base64url(concatHex(['0x01', until, userOpHash]))}","origin":"https://send.app","crossOrigin":false}`;
  const authenticatorData = concatHex([sha256(stringToHex('send.app')), '0x1d', '0x00000000']);
  // (Its Signature struct is webauthn-sol's WebAuthnAuth, the two locations under other names.)
  return concatHex(['0x01', until, `0x${slot.toString(16).padStart(2, '0')}`, encodeAbiParameters([WEBAUTHN_AUTH],
    [{ authenticatorData, clientDataJSON, challengeIndex: BigInt(clientDataJSON.indexOf('"challenge"')), typeIndex: BigInt(clientDataJSON.indexOf('"type"')), r: BigInt(P256_STUB.r), s: BigInt(P256_STUB.s) }])]);
}
async function sendStub(c: StubContext): Promise<Stub[]> {
  // Its keys are passkeys, so a passkey wallet asks the account itself to sign (as Coinbase's, coinbaseFor). An
  // Ethereum key isn't one of them: the plain stand-in, which the account refuses, and the preview says who signs.
  if (c.signer !== c.sender) return [{ signature: STUB_SIGNATURE, why: "Send's account is signed by its passkeys (a passkey wallet signs as the account itself), and the signer asked isn't the account" }];
  const hash = await c.hash();
  if (!hash || !c.deps.rpc?.has(c.chainId)) return [{ signature: STUB_SIGNATURE }];
  const keyAt = async (slot: number) => {
    try { return BigInt(String(await c.deps.rpc!.call(c.chainId, 'eth_call', [{ to: c.sender, data: encodeFunctionData({ abi: SEND, functionName: 'keys', args: [slot, 0n] }) }, 'latest']))) !== 0n; } catch { return false; }
  };
  let slot = 0;
  if (!await keyAt(0)) {
    const last = await lastSignature({ ...c, match: s => s.startsWith('0x01') && s.length > 2 + 8 * 2, key: 'send' });
    if (last) slot = parseInt(last.slice(16, 18), 16);
  }
  const validUntil = BigInt(Math.floor(Date.now() / 1000) + 86_400);
  return [{ signature: sendStandIn(hash, slot, validUntil), p256: true }];
}

// --- Trust Wallet's Barz (a diamond; its facets verified on Sourcify, BNB Chain, at the same addresses on every chain here) ---
// An account is a diamond proxy (the same 573 bytes for each, BARZ_PROXY its hash) whose AccountFacet validates an
// operation (EntryPoint v0.6) by delegatecalling the facet installed for validateOwnerSignature: Secp256k1-
// VerificationFacet for an Ethereum key (the bare signature, which STUB_SIGNATURE is), or Secp256r1VerificationFacet
// for a passkey, which takes
//   abi.encode(uint256 r, uint256 s, bytes authenticatorData, string clientDataJSONPre, string clientDataJSONPost)
// (clientDataJSON: the two around the operation's hash, base64url-encoded) and verifies it in Solidity (LibSecp256r1)
// against the public key it keeps (r1Storage.q). Another signature fails to decode, which the account reports as
// AccountFacet__CallNotSuccessful() (AA23: on BNB Chain about one operation an hour was simulated as calls only so,
// November 2026). With no precompile or verifier contract to stand in at, the stand-in is a real assertion by a passkey
// made up for the run (standInPasskey), whose public key is set as the account's for the run: validation runs every
// check the real one's does, for the gas it uses. Its form is the one the account's latest earlier operation's
// assertion had (Trust Wallet's apps sign with origin https://trustwallet.com, or an Android app's apk-key-hash origin
// with its package's name, 64 bytes more of clientDataJSON), else the first.
const BARZ_PROXY = '0xe152e0d0626438840037db419d2e66fa32002f1ee719b1dbe2892314bc67b6de';
const BARZ_R1_FACET = '0xee1af8e967ec04c84711842796a5e714d2fd33e6';
/** Where Secp256r1VerificationFacet keeps the passkey's public key (x, then y). */
const BARZ_R1_SLOT = BigInt(keccak256(stringToHex('v0.trustwallet.diamond.storage.Secp256r1VerificationStorage')));
const BARZ = parseAbi(['function facetAddress(bytes4 selector) view returns (address)']);
/** validateOwnerSignature(UserOperation, bytes32), the selector a verification facet validates under. */
const BARZ_VALIDATE_OWNER = '0x8dd50121';
const BARZ_SIGNATURE = [{ type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'string' }, { type: 'string' }] as const;
/** A Barz passkey's assertion's form: its authenticator data, and clientDataJSON before and after the challenge. */
export interface BarzForm { authenticatorData: Hex; pre: string; post: string }
/** Trust Wallet's form (its RP ID's hash, user present, verified and backed up, as its operations carry it). */
export const BARZ_FORM: BarzForm = { authenticatorData: concatHex([sha256(stringToHex('trustwallet.com')), '0x1d', '0x00000000']), pre: '{"type":"webauthn.get","challenge":"', post: '","origin":"https://trustwallet.com"}' };
/** The form of a Barz passkey's signature, where it is one (the key Chrome adds to some at random, see bullbitStub, left out). */
export function barzFormOf(signature: Hex): BarzForm | undefined {
  try {
    const [, , authenticatorData, pre, post] = decodeAbiParameters(BARZ_SIGNATURE, signature);
    return pre.endsWith('"challenge":"') && authenticatorData.length >= 2 + 37 * 2 ? { authenticatorData, pre, post: post.replace(/,"other_keys_can_be_added_here":"[^"]*"/, '') } : undefined;
  } catch { return undefined; }
}
/**
 * The stand-in passkey's assertion of `hash` in a Barz account's form, signed as WebAuthn signs (over
 * sha256(authenticatorData || sha256(clientDataJSON))). What LibSecp256r1's check costs turns on the signature: its
 * Shamir loop takes the scalars u1 = e/s and u2 = r/s two bits at a time and adds a point for every pair of bits but
 * 0 and 0 (one in sixteen, at random: 8 of its 128 on average), about 850 gas each, so two real signatures of the same
 * operation can differ by several thousand gas. Of the signatures the stand-in passkey can make (RFC 6979's, with extra
 * entropy), the stand-in is the first whose loop skips 8, as one does on average. Against two operations' own
 * signatures on the latest state (BNB Chain's skipping 8, Ethereum's 4): 90 gas over and 3,388 under (0.02% and
 * 0.64%), where the first signature made came out 3,598 and 5,328 under.
 */
export function barzAssertion(hash: Hex, form: BarzForm = BARZ_FORM): Hex {
  const clientDataJSON = `${form.pre}${base64url(hash)}${form.post}`;
  const digest = sha256(concatHex([form.authenticatorData, sha256(stringToHex(clientDataJSON))]));
  let signature = p256.sign(hexToBytes(digest), STAND_IN_PASSKEY);
  for (let k = 1; k < 64 && p256SkippedPairs(BigInt(digest), signature.r, signature.s) !== 8; k++) signature = p256.sign(hexToBytes(digest), STAND_IN_PASSKEY, { extraEntropy: hexToBytes(numberToHex(k, { size: 32 })) });
  return encodeAbiParameters(BARZ_SIGNATURE, [signature.r, signature.s, form.authenticatorData, form.pre, form.post]);
}
/** How many of the 128 bit pairs of u1 = e/s and u2 = r/s (mod n) are both 0 (see barzAssertion), or -1 when the first is. */
export function p256SkippedPairs(e: bigint, r: bigint, s: bigint): number {
  const n = p256.CURVE.n;
  let w = 1n, base = s % n;
  for (let x = n - 2n; x > 0n; x >>= 1n) { if (x & 1n) w = w * base % n; base = base * base % n; }
  const u1 = e % n * w % n, u2 = r * w % n;
  let skipped = 0;
  for (let i = 0; i < 128; i++) {
    const shift = BigInt(254 - 2 * i);
    if (!((u1 >> shift) & 3n) && !((u2 >> shift) & 3n)) { if (i === 0) return -1; skipped++; }
  }
  return skipped;
}
async function barzStub(c: StubContext): Promise<Stub[]> {
  const plain = [{ signature: STUB_SIGNATURE }];
  const rpc = c.deps.rpc?.has(c.chainId) ? c.deps.rpc : undefined;
  if (!rpc) return plain;
  try {
    // An Ethereum key's account (Secp256k1VerificationFacet) takes the plain stand-in.
    const facet = decodeFunctionResult({ abi: BARZ, functionName: 'facetAddress', data: String(await rpc.call(c.chainId, 'eth_call', [{ to: c.sender, data: encodeFunctionData({ abi: BARZ, functionName: 'facetAddress', args: [BARZ_VALIDATE_OWNER] }) }, 'latest'])) as Hex });
    const hash = await c.hash();
    if (facet.toLowerCase() !== BARZ_R1_FACET || !hash) return plain;
    const last = await lastSignature({ ...c, match: s => !!barzFormOf(s), key: 'barz' });
    const signature = barzAssertion(hash, (last && barzFormOf(last)) ?? BARZ_FORM);
    // A passkey wallet asks the account itself to sign (as Coinbase's, coinbaseFor); asked by anyone else, the account's
    // own key checks the stand-in's assertion, and refuses it.
    if (c.signer !== c.sender) return [{ signature, madeUp: true, why: "Trust Wallet's Barz account here is signed by its passkey (a passkey wallet signs as the account itself), and the signer asked isn't the account" }];
    const { x, y } = standInPasskey();
    return [{ signature, madeUp: true, storage: { [`0x${BARZ_R1_SLOT.toString(16)}`]: x, [`0x${(BARZ_R1_SLOT + 1n).toString(16)}`]: y } }];
  } catch { return plain; }
}

// --- Rhinestone's SmartSession (session keys for ERC-7579 accounts; both deployments verified on Sourcify, Arbitrum One) ---
// An account validates through it when its nonce names it (Safe7579, the adapter that makes a Safe an ERC-7579
// account, reads its validator from the nonce's top 20 bytes; Biconomy Nexus's and Kernel's nonces name it too). Its
// signature is a mode byte (0x00: use a session the account has enabled), the session's permission ID (32 bytes), then
// what the session's validator takes: Rhinestone's OwnableValidator's (a threshold of its owners' ECDSA signatures over
// the operation's hash as a message, in any order), Biconomy's K1MeeValidator's (below) or another's. SmartSession
// first runs the session's policies on the operation (each user-operation and action policy, for real), then the
// validator: STUB_SIGNATURE's 0xff is no mode at all, and validation reverted (Safe7579 reports a validator's revert as
// ExecutionFailed(), AA23), so only the calls were simulated. Such an operation is signed by the session's keys, not
// by the account's owners: a dApp's mostly (on Arbitrum One in a day, 16 Safes' 34 operations through OwnableValidator
// sessions, all 2-of-2, each Safe's own key and one shared cosigner; on Base 10 accounts' 18, 1-of-1 and 2-of-2;
// 2026-11-15).
// The stand-in names the account's enabled session (getPermissionIDs) whose keys include the signer: an
// OwnableValidator session's with the signer's stand-in and other owners' (cosigners) to its threshold; a
// K1MeeValidator session's in the form its key signs (k1meeSessionPart). Where none does, or its validator is another,
// no one the request names can sign it: the stand-in is the first session's form, and the preview says who signs.
const SMART_SESSIONS = new Set(['0x00000000002b0ecfbd0496ee71e01257da0e37de', '0x00000000008bdaba73cd9815d79069c247eb4bda']);
/** Rhinestone's OwnableValidator (verified on Sourcify, Ethereum), as a session's validator: its config abi.encode(threshold, owners). */
export const OWNABLE_VALIDATOR = '0x2483da3a338895199e5e538530213157e931bf06';
// Biconomy's K1MeeValidator 1.0.3 (its MEE 2.1.0 deployment; verified on Sourcify, Arbitrum One, Base and OP
// Mainnet), the validator of most SmartSession operations seen (Arbitrum One: 671 of 705 in a day, 49 accounts; Base:
// 37 of 55; OP Mainnet: all 112 in four hours; 2026-11-15). As a session's validator (validateSignatureWithData) its
// config's first 20 bytes are the session's key, and it takes one of its own modes: a 65-byte signature over the
// operation's hash (as it is or as a message: no prefix, the modes' fallback), or after a 4-byte type, simple mode
// (0x177eee00: the supertransaction's hash, the root of a Merkle tree of the hashes of its operations, on any chain,
// with the proof of this operation's hash in it, and the key's signature over the root), on-chain mode (0x177eee01: a
// transaction carrying the root, signed and sent by the key) or permit mode (0x177eee02: an ERC-2612 permit with the
// root as its deadline). Every operation seen came in simple mode, as Biconomy's MEE node sends a session's (its SDK,
// @biconomy/abstractjs, has the key sign the supertransaction's hash as a message for MEE before 2.2.1; from then on
// it signs the operation's hash, for a later validator): a tree of two leaves (one proof element), the root signed as
// a message (on Arbitrum One 19 of 19 in two hours; Base 28 of 28 in a day; OP Mainnet 164 of 164 in 4.4 hours;
// 2026-11-15). Each session has a key of its own (an account had 105 sessions, 105 keys), never the account's owner
// (K1MeeValidator's own owner for the account): a key held for the account apart from its owner's, a dApp's or an
// agent's.
// The stand-in is in the form of what the key is asked to sign. The operation's hash (personal_sign or eth_sign of
// it, with the operation in context.userOperation): the plain form, whose validation costs less than simple mode's
// with one proof element, the proof and the longer signature copied along the way (47 operations replayed so on Base,
// OP Mainnet and Arbitrum One came out 1,238 to 1,368 gas under their receipts; 2,117 in test/k1mee-session.test.ts's
// mock accounts): what the same operation sent through MEE costs more, as the preview notes. A supertransaction's hash
// (src/supertransaction.ts, with its operations in context.meeOperations): simple mode, with that root and this
// operation's proof in it.
/** Biconomy's K1MeeValidator 1.0.3, as a session's validator: its config, the session's key (its first 20 bytes). */
export const K1MEE_VALIDATOR = '0x0000000031ef4155c978d48a8a7d4edba03b04fe';
/** Other session validators, by name. */
const SESSION_VALIDATOR_NAMES: Record<string, string> = { [K1MEE_VALIDATOR]: "Biconomy's K1MeeValidator" };
/**
 * A supertransaction's hash (the root of a Merkle tree of its operations' hashes) and the proof of an operation's leaf
 * in it; `bounds`, the operation's time bounds, where its leaf is MEE's hash of its hash and them (meeLeaf in
 * src/supertransaction.ts), as an account's own K1MeeValidator checks it (nexusStub).
 */
export interface SupertransactionProof {
  root: Hex; proof: readonly Hex[]; bounds?: { lowerBoundTimestamp: bigint; upperBoundTimestamp: bigint };
  /**
   * A supertransaction signed as EIP-712 typed data, as K1MeeValidator 1.1.0 takes it (MEE 3: src/supertransaction.ts,
   * previewTypedSupertransaction): its outer type's hash, its items' hashes (the operation's, its MeeUserOp's, among
   * them at `itemIndex`). `root` is then the typed data's digest, which the owner signs, and `proof` is empty.
   */
  typed?: { outerTypeHash: Hex; itemHashes: readonly Hex[]; itemIndex: number };
}
/**
 * Why an account refused the stand-in for a supertransaction signer's, where no stand-in says why (simulateOperation):
 * the root's signature is stood in for only in K1MeeValidator's simple mode, a session's or a Nexus account's own.
 */
const SUPERTRANSACTION_WHY = "the signature of a supertransaction's hash is stood in for only as Biconomy's K1MeeValidator takes it, in simple mode: a session's (SmartSession), or the owner's for a Biconomy Nexus account whose default validator it is; an account that checks the operation's hash doesn't take it";
/**
 * A K1MeeValidator session's part of the signature (after SmartSession's mode and permission ID), its key's 65-byte
 * `signature` in the form of what it signed: the operation's hash, the plain form (the signature alone); or a
 * supertransaction's hash (`tree`), simple mode as Biconomy's MEE node sends it: 0x177eee00, then abi.encode(root,
 * proof, signature). The validator checks the signature over what was signed as it is first, then as a message, and
 * in simple mode the proof of the operation's hash (OpenZeppelin's MerkleProof: each pair hashed in order).
 */
export function k1meeSessionPart(signature: Hex, tree?: SupertransactionProof): Hex {
  return tree ? concatHex(['0x177eee00', encodeAbiParameters(parseAbiParameters('bytes32, bytes32[], bytes'), [tree.root, tree.proof, signature])]) : signature;
}
/** Sessions read at a time, newest first, until one of the signer's turns up; and at most. */
const SESSIONS_AT_ONCE = 32, SESSIONS_READ = 1024;
const SMART_SESSION = parseAbi(['function getPermissionIDs(address account) view returns (bytes32[])', 'function getSessionValidatorAndConfig(address account, bytes32 permissionId) view returns (address sessionValidator, bytes sessionValidatorData)']);
/** Multicall3 (the same address on every chain the previewer simulates on: src/simulation.ts), for reads of many sessions at once. */
const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
const AGGREGATE3 = parseAbi(['struct Call3 { address target; bool allowFailure; bytes callData; }', 'struct Result { bool success; bytes returnData; }', 'function aggregate3(Call3[] calls) payable returns (Result[] returnData)']);
/**
 * The SmartSession module an operation's nonce names (its 24-byte key), if any; not a Kernel in enable mode installing
 * it (mode byte 0x01, the module in Kernel's validator slot after its mode and type bytes), whose signature carries
 * the enable data (kernelEnableStub). Only there: Biconomy Nexus's key starts with 3 bytes of its own, which MEE
 * varies, then its mode byte and the validator, and its first byte can be 0x01 too (Base, 0x0fb9…d93f).
 */
export const smartSessionOf = (nonce: bigint): string | undefined => {
  const key = nonce.toString(16).padStart(64, '0');
  const module = [...SMART_SESSIONS].find(m => key.slice(0, 48).includes(m.slice(2)));
  return module && !(key.startsWith('01') && key.slice(4, 44) === module.slice(2)) ? module : undefined;
};
async function smartSessionStub(c: StubContext, module: string): Promise<Stub[]> {
  const bare: Stub = { signature: STUB_SIGNATURE, why: `it validates through Rhinestone's SmartSession (${shortAddr(module)}, which its nonce names), as a session key's operation whose signature names the session and carries its keys' signatures, and the account's sessions couldn't be read` };
  const rpc = c.deps.rpc?.has(c.chainId) ? c.deps.rpc : undefined;
  if (!rpc) return [bare];
  const view = async <F extends 'getPermissionIDs' | 'getSessionValidatorAndConfig'>(functionName: F, args: readonly unknown[]) =>
    decodeFunctionResult({ abi: SMART_SESSION, functionName, data: String(await rpc.call(c.chainId, 'eth_call', [{ to: module, data: encodeFunctionData({ abi: SMART_SESSION, functionName, args } as never) }, 'latest'])) as Hex } as never) as unknown;
  try {
    const ids = await view('getPermissionIDs', [c.sender]) as readonly Hex[];
    if (!ids.length) return [{ ...bare, why: `it validates through Rhinestone's SmartSession (${shortAddr(module)}), as a session key's operation, and the account has no session enabled` }];
    const session = (id: Hex, [validator, config]: readonly [string, Hex]) => {
      let owners: string[] = [], threshold = 0;
      const v = validator.toLowerCase();
      if (v === OWNABLE_VALIDATOR) {
        try { const [t, o] = decodeAbiParameters([{ type: 'uint256' }, { type: 'address[]' }], config); threshold = Number(t); owners = o.map(a => a.toLowerCase()); } catch { /* not its config */ }
      }
      // K1MeeValidator's session key: its config's first 20 bytes (shorter, it reverts).
      const key = v === K1MEE_VALIDATOR && config.length >= 42 && !/^0x0{40}/.test(config) ? `0x${config.slice(2, 42)}`.toLowerCase() : undefined;
      return { id, validator: v, owners, threshold, key };
    };
    // Sessions read together, through Multicall3 (one call for them all; a public node limits how fast it is asked),
    // else one by one.
    const read = async (chunk: Hex[]) => {
      const each = (id: Hex) => encodeFunctionData({ abi: SMART_SESSION, functionName: 'getSessionValidatorAndConfig', args: [c.sender as Hex, id] });
      try {
        const data = encodeFunctionData({ abi: AGGREGATE3, functionName: 'aggregate3', args: [chunk.map(id => ({ target: module as Hex, allowFailure: false, callData: each(id) }))] });
        const out = decodeFunctionResult({ abi: AGGREGATE3, functionName: 'aggregate3', data: String(await rpc.call(c.chainId, 'eth_call', [{ to: MULTICALL3, data }, 'latest'])) as Hex });
        if (out.length !== chunk.length) throw new Error('not all read');
        return out.map((r, i) => session(chunk[i], decodeFunctionResult({ abi: SMART_SESSION, functionName: 'getSessionValidatorAndConfig', data: r.returnData })));
      } catch {
        return Promise.all(chunk.map(async id => session(id, await view('getSessionValidatorAndConfig', [c.sender, id]) as readonly [string, Hex])));
      }
    };
    const signer = c.signer.toLowerCase();
    const signs = (s: ReturnType<typeof session>) => s.key === signer || (s.owners.includes(signer) && s.threshold > 0);
    // Newest first (the last enabled), a chunk at a time, until a session of the signer's turns up: MEE enables a
    // session, with a key of its own, for each grant, and an account on Arbitrum One had 105 (105 keys, any of which
    // can sign for it: with only the newest 32 read, the 73rd's key was told it isn't one). Where none is the
    // signer's, all of them (up to SESSIONS_READ), so that the preview counts them all. Past that, the older ones
    // aren't read, and the signer may hold one of them: the preview says so, not that it holds none.
    const newest = [...ids].reverse().slice(0, SESSIONS_READ);
    const sessions: ReturnType<typeof session>[] = [];
    for (let i = 0; i < newest.length; i += SESSIONS_AT_ONCE) {
      const chunk = await read(newest.slice(i, i + SESSIONS_AT_ONCE));
      sessions.push(...chunk);
      if (chunk.some(signs)) break;
    }
    // A K1MeeValidator session's stand-in for `who` (the session's key, or the signer asked, whom it doesn't take), in
    // the form of what the key signs (k1meeSessionPart): a stand-in ecrecover recovers as `who` over what the wallet
    // signs (the digest), and over the other form of it, which the validator tries first or second, as no one's (as the
    // key's real signature recovers someone else there), each for the precompile's price.
    const k1mee = (s: typeof sessions[number], who: string): Stub => ({
      signature: concatHex(['0x00', s.id, k1meeSessionPart(STUB_COSIGNATURE, c.supertransaction)]), cosigners: [{ signature: STUB_COSIGNATURE, signer: who, ...(c.digest && { digest: c.digest }) }],
      ...(!c.supertransaction && { note: "The session's key signs the operation's hash itself, which Biconomy's K1MeeValidator takes as it is (its plain form). Sent through Biconomy's MEE node (MEE 2.1.0, whose validator this is), the key would sign a supertransaction's hash instead, a Merkle root of its operations' hashes, and the operation would carry it and its proof (simple mode): with one proof element, as every one seen had, its validation costs about 1,300 gas more than simulated here (1,238 to 1,368 more for 47 such operations replayed against their receipts on Base, OP Mainnet and Arbitrum One). To preview that request, sign the supertransaction's hash with its operations in context.meeOperations." }),
    });
    // The signer's own sessions: K1MeeValidator's, newest first (a key has one session, mostly); then the first
    // OwnableValidator session (in the account's order) whose owners include it.
    const keyed = sessions.filter(s => s.key === signer);
    const mine = [...sessions].reverse().find(s => s.owners.includes(signer) && s.threshold > 0);
    // The signer's stand-in, then other owners' to the threshold, each recovered as its owner (ecrecoverAsMany).
    const form = (s: typeof sessions[number], signs: string | undefined) => {
      const others = s.owners.filter(o => o !== signs).slice(0, Math.max(s.threshold - (signs ? 1 : 0), 0));
      const cosigners = others.map((o, k) => ({ signature: stubSignature(k + 1), signer: o }));
      return { signature: concatHex(['0x00', s.id, ...(signs ? [STUB_SIGNATURE] : []), ...cosigners.map(x => x.signature)]), ...(cosigners.length && { cosigners }) };
    };
    if (keyed.length || mine) return [...keyed.map(s => k1mee(s, signer)), ...(mine ? [form(mine, signer)] : [])];
    // None of the signer's (all read): the first OwnableValidator session's, else the newest K1MeeValidator
    // session's, whose policies the operation's calls most likely meet. Counted from all of the account's sessions.
    const first = [...sessions].reverse().find(s => s.owners.length) ?? sessions.find(s => s.key) ?? sessions[0];
    const named = sessions.filter(s => s.key).map(s => shortAddr(s.key!));
    const unread = ids.length - sessions.length;
    const counted = unread > 0 ? ` among the newest ${sessions.length} of its ${ids.length}` : '';
    const notSigner = (them: string) => unread > 0 ? `, and the signer asked holds none of the ${sessions.length} read, but may hold one of the ${unread} older ones, which weren't read` : `, and the signer asked isn't ${them}`;
    const MEE_SIGNS = "which takes the key's signature over the operation's hash, or over a supertransaction's hash with the operation's proof";
    const keys = first.owners.length ? ` (${first.threshold} of ${first.owners.map(shortAddr).join(', ')})`
      : first.key ? (named.length === 1 && !counted ? `'s key (${named[0]}, through Biconomy's K1MeeValidator, ${MEE_SIGNS})`
        : `' keys (${named.length} sessions${counted}, each a key of its own through Biconomy's K1MeeValidator, the newest ${named.slice(0, 3).join(', ')}${named.length > 3 ? ` and ${named.length - 3} more` : ''}, ${MEE_SIGNS})`)
      : ` (through ${SESSION_VALIDATOR_NAMES[first.validator] ?? `session validator ${shortAddr(first.validator)}`}, whose form the stand-in doesn't take)`;
    const one = first.key && named.length === 1 && !counted;
    const why = first.key
      ? `it validates through Rhinestone's SmartSession (${shortAddr(module)}), as a session key's operation signed by ${one ? 'its session' : 'one of its sessions'}${keys}, not by the account's owners${notSigner(one ? 'it' : 'one of them')}`
      : `it validates through Rhinestone's SmartSession (${shortAddr(module)}), as a session key's operation signed by its session's keys${keys}, not by the account's owners${first.owners.length || unread > 0 ? notSigner('one of them') : ''}`;
    // (Not the signer's: its stand-in, then all but one of the owners, so the session's check runs on as many
    // signatures; for a K1MeeValidator session, its form with the signer's stand-in, which it refuses.)
    return [{ ...(first.owners.length ? form(first, signer) : first.key ? k1mee(first, signer) : { signature: concatHex(['0x00', first.id, STUB_SIGNATURE]) }), why, ...(unread > 0 && { unsure: true }) }];
  } catch { return [bare]; }
}

// --- Biconomy's Nexus, its owner signing through its default validator, K1MeeValidator ---
// Nexus 1.2 (its implementation 0x0000…50ac, verified on Sourcify; at that address on the six chains here, the same
// code but for its EIP-712 domain's cached chain) runs behind the ERC-1967 proxy its factory deploys, behind a
// Biconomy Smart Account v2 proxy it has upgraded (its implementation in the slot of the proxy's own address), or as
// an EIP-7702 delegate. Its nonce names what validates an operation: 3 bytes of MEE's, a mode byte (0x00 validates
// as it is; 0x01 installs a module first, 0x02 initializes an EIP-7702 account), the validator (0 for its default
// validator, an immutable of its code: K1MeeValidator 1.0.3, above, on all six chains) and the sequence.
// K1MeeValidator checks its owner for the account (smartAccountOwners, set when the account installs it; getOwner,
// the account itself where none is, as for an EIP-7702 account that set none), in one of its forms (above). As an
// account's own validator (validateUserOp) its simple mode carries the operation's time bounds too: 0x177eee00, then
// abi.encode(the supertransaction's hash, the lower and upper bounds, the proof, the owner's signature over the root,
// as it is or as a message), its leaf MEE's hash of the operation's hash and the bounds (MEEUserOpHashLib), which it
// returns as the operation's validity (validAfter, validUntil). Every such operation seen (2026-11-15) came in simple
// mode, with mode 0x00 and the default validator, the owner having signed the root as a message, as Biconomy's MEE node
// sends them: on OP Mainnet 127 of 248 EntryPoint v0.7 operations in 3,000 blocks (about 100 minutes; 1 to 5 proof
// elements), on Arbitrum One 21 of 1,325 in 30,000 blocks, on Base 4 of 22,764 in 40,000 (and the operation that
// deployed its account through the factory, a day before), on Ethereum 17 of 19,900 in 7,000 (16 of 6 EIP-7702
// accounts), on BNB Chain 17 of 12,952 in 40,000 (14 of 5 EIP-7702 accounts), on Polygon none in 20,000; none in
// on-chain or permit mode (whose root the owner signs in a transaction or an ERC-2612 permit, which aren't previewed
// as a supertransaction's). Accounts on a later Nexus (0x0000…7e9d on Base, 0x54f2…7fb2 on Ethereum: 7 operations of
// 2 accounts in those spans) validate through K1MeeValidator 1.1.0, whose supertransaction is EIP-712 typed data:
// Nexus 1.3.1's is stood in for (k1meeOwnTyped; src/supertransaction.ts, previewTypedSupertransaction).
// The stand-in, for an operation its default validator validates: asked to sign a supertransaction's hash (with its
// operations: src/supertransaction.ts), simple mode with that root, the operation's proof and its time bounds (0 and
// 0 where it was supplied without them: its leaf is then its hash, which the validator doesn't check, and it refuses
// the stand-in as it would the real signature); asked to sign the operation's hash, the plain form. Either way the
// owner's 65 bytes are STUB_COSIGNATURE, recovered as the signer over what the wallet signs and as no one over the
// other form, each for the precompile's price. Asked by anyone but the owner, the same, which the validator refuses,
// and the preview names the owner. An account that keeps no owner (getOwner then answers the account itself) is
// signed for only by an EIP-7702 account's own key: a contract has none (the factory's proxy set up without the
// default validator, through NexusBootstrap's initNexus, initNexusScoped or initNexusWithSingleValidator), so the
// stand-in asked of the account itself is recovered as no one there, as any signature would be, and the preview says
// no signature validates through that validator. Other modes and validators get STUB_SIGNATURE (a session key's
// operation, whose nonce names SmartSession, smartSessionStub).
/** Biconomy's K1MeeValidator 1.1.0 (verified on Sourcify, Base; the same address on every chain here): MEE 3's. */
export const K1MEE_VALIDATOR_110 = '0x0000000002d3cc5642a748b6783f32c032616e03';
/**
 * Nexus implementations, and their default validator (an immutable of their code): Nexus 1.2's K1MeeValidator 1.0.3;
 * Nexus 1.3.1's (verified on Sourcify, Base; the same address on every chain here) 1.1.0, whose simple mode takes a
 * supertransaction signed as EIP-712 typed data (k1meeOwnTyped).
 */
const NEXUS_K1MEE_IMPLEMENTATIONS: Record<string, string> = { '0x00000000383e8cbe298514674ea60ee1d1de50ac': K1MEE_VALIDATOR, '0x0000000020fe2f30453074ad916edeb653ec7e9d': K1MEE_VALIDATOR_110 };
/** NexusBootstrap 1.2.1 (verified on Sourcify; its default validator K1MeeValidator), which the factory's accounts are set up through. */
const NEXUS_BOOTSTRAP = '0x0000003edf18913c01cbc482c978bbd3d6e8ffa3';
const NEXUS = parseAbi(['function createAccount(bytes initData, bytes32 salt)', 'function getOwner(address smartAccount) view returns (address)']);
/**
 * NexusBootstrap's calls that install the default validator, its install data their first argument:
 * initNexusWithDefaultValidator(bytes), and with other modules, without a registry and with one.
 */
const NEXUS_DEFAULT_VALIDATOR_SETUPS = new Set<string>(['initNexusWithDefaultValidator(bytes)',
  'initNexusWithDefaultValidatorAndOtherModulesNoRegistry(bytes,(address,bytes)[],(address,bytes)[],(address,bytes),(address,bytes)[],(uint256,address,bytes)[])',
  'initNexusWithDefaultValidatorAndOtherModules(bytes,(address,bytes)[],(address,bytes)[],(address,bytes),(address,bytes)[],(uint256,address,bytes)[],(address,address[],uint8))'].map(f => toFunctionSelector(f)));
/** NexusBootstrap's other set-ups, which install other validators (and modules) but not the default validator. */
const NEXUS_OTHER_SETUPS = new Set<string>(['initNexusWithSingleValidator(address,bytes,(address,address[],uint8))', 'initNexusWithSingleValidatorNoRegistry(address,bytes)',
  'initNexus((address,bytes)[],(address,bytes)[],(address,bytes),(address,bytes)[],(uint256,address,bytes)[],(address,address[],uint8))', 'initNexusNoRegistry((address,bytes)[],(address,bytes)[],(address,bytes),(address,bytes)[],(uint256,address,bytes)[])',
  'initNexusScoped((address,bytes)[],(address,bytes),(address,address[],uint8))', 'initNexusScopedNoRegistry((address,bytes)[],(address,bytes))'].map(f => toFunctionSelector(f)));
/** K1MeeValidator's simple mode as an account's own validator takes it: the root, the time bounds, the proof, the signature. */
const K1MEE_OWN_SIMPLE = parseAbiParameters('bytes32, uint256, uint256, bytes32[], bytes');
/** K1MeeValidator's simple mode for an account's own operation, its owner's 65-byte `signature` over the root (see above). */
export function k1meeOwnSimple(signature: Hex, tree: SupertransactionProof): Hex {
  return concatHex(['0x177eee00', encodeAbiParameters(K1MEE_OWN_SIMPLE, [tree.root, tree.bounds?.lowerBoundTimestamp ?? 0n, tree.bounds?.upperBoundTimestamp ?? 0n, tree.proof, signature])]);
}
/**
 * K1MeeValidator 1.1.0's simple mode (SimpleValidatorLib, HashLib.parsePackedSigDataHead), the owner's 65-byte
 * `signature` over the supertransaction's EIP-712 digest: 0x177eee00, then the outer type's hash, the operation's item
 * index, the offsets of the item hashes (0xa0) and of the signature, the time bounds packed in one word (the lower in
 * its upper 128 bits), the item hashes and the signature (each with its length, as abi.encode lays out bytes32[] and
 * bytes). Word by word a real operation's layout on Base, with its signature (2026-11-18).
 */
export function k1meeOwnTyped(signature: Hex, tree: SupertransactionProof & { typed: NonNullable<SupertransactionProof['typed']> }): Hex {
  const { outerTypeHash, itemHashes, itemIndex } = tree.typed;
  const w = (v: bigint) => v.toString(16).padStart(64, '0');
  // (Each bound in 128 bits, as the validator reads them: one that doesn't fit is never found among the items, and
  // the layout stays the validator's.)
  const mask = (1n << 128n) - 1n;
  const lower = (tree.bounds?.lowerBoundTimestamp ?? 0n) & mask, upper = (tree.bounds?.upperBoundTimestamp ?? 0n) & mask;
  const sigAt = 0xa0n + 0x20n + 0x20n * BigInt(itemHashes.length);
  const sig = signature.slice(2), padded = sig.padEnd(Math.ceil(sig.length / 64) * 64, '0');
  return `0x177eee00${outerTypeHash.slice(2)}${w(BigInt(itemIndex))}${w(0xa0n)}${w(sigAt)}${w((lower << 128n) | upper)}${w(BigInt(itemHashes.length))}${itemHashes.map(h => h.slice(2)).join('')}${w(BigInt(sig.length / 2))}${padded}` as Hex;
}
/**
 * A Nexus account's stand-in (see above): `owner`, the owner its validator keeps for it (read from K1MeeValidator),
 * or, for an account its factory deploys in the operation, the one its set-up installs (`deploying`; `none` where
 * its set-up is NexusBootstrap's without the default validator, which then keeps no owner for it).
 */
async function nexusStub(c: StubContext, deploying?: { owner?: string; none?: boolean }, validator = K1MEE_VALIDATOR): Promise<Stub[]> {
  const key = c.nonce.toString(16).padStart(64, '0');
  if (key.slice(6, 8) !== '00' || !/^0{40}$/.test(key.slice(8, 48))) return [{ signature: STUB_SIGNATURE }];
  const sender = c.sender.toLowerCase();
  let owner = deploying?.owner?.toLowerCase();
  if (!deploying && c.deps.rpc?.has(c.chainId)) {
    try {
      const out = String(await c.deps.rpc.call(c.chainId, 'eth_call', [{ to: validator, data: encodeFunctionData({ abi: NEXUS, functionName: 'getOwner', args: [c.sender as Hex] }) }, 'latest']));
      if (/^0x0{24}[0-9a-f]{40}$/i.test(out)) owner = `0x${out.slice(26)}`.toLowerCase();
    } catch { /* not read */ }
  }
  const signer = c.signer.toLowerCase(), tree = c.supertransaction;
  // With no owner set, K1MeeValidator takes the account's own address as its owner (getOwner). Only an EIP-7702
  // account has a key for that address (its code a delegation now, or the operation signed for one); a contract (the
  // factory's proxy, a Smart Account v2 proxy upgraded to Nexus) has none, so no signature validates through its
  // default validator. Which it is, is read where it matters: no owner set, or none read and the account itself the
  // signer (the request names it, or no signer). `keyed` is undefined where its code couldn't be read.
  const self = signer === sender, none = owner === sender || !!deploying?.none;
  let keyed: boolean | undefined = deploying ? false : c.delegate ? true : undefined;
  if (keyed === undefined && (none || (!owner && self))) {
    try { keyed = /^0xef0100[0-9a-f]{40}$/i.test(String(await c.deps.rpc!.call(c.chainId, 'eth_getCode', [sender, 'latest']))); } catch { /* not read */ }
  }
  // The account itself as the signer, no key known for it and no other owner: the stand-in is recovered as no one
  // (ECRECOVER_NOBODY), as any signature would be, where the validator would otherwise take it as its owner's.
  const keyless = self && keyed !== true && (none || !owner);
  const itself = keyed === false ? 'for which no key signs, the account being a contract' : "for which only an EIP-7702 account's own key signs (the account's code couldn't be read)";
  const nobody = keyless ? " (here ecrecover recovered the stand-in as no one, as it would any signature)" : '';
  // Why it may refuse the stand-in: who its owner is (none, and for a contract no signature validates); for a
  // supertransaction's operation supplied without its time bounds, that its leaf isn't what the validator checks;
  // that the signer, the one asked or the account itself where none is, isn't that owner.
  const validates = "it validates through its default validator, Biconomy's K1MeeValidator, which takes its owner's signature";
  const why = none && keyed !== true
    ? `${validates}, and keeps no owner for it: it then takes the account's own address as its owner, ${itself}${keyed === false ? ', so no signature validates through it' : !self ? ", and the signer asked isn't the account" : ''}${nobody}`
    : `${validates}${none ? ' (the account itself, as none is set for it)' : owner ? ` (${shortAddr(owner)})` : deploying ? " (which its set-up doesn't name)" : " (which couldn't be read)"}`
      + (tree && !tree.bounds ? " over a supertransaction's hash with the proof of MEE's hash of the operation's hash and its time bounds, and the operation was supplied without them (its leaf its hash, as a session key's is)" : '')
      + (owner && signer !== owner ? (c.named ? ", and the signer asked isn't its owner" : ", and the request names no signer: the stand-in was taken as the account's own, and the account isn't its owner")
        : keyless ? `, and the request ${c.named ? 'names the account itself as the signer' : 'names no signer (the account itself, then)'}, ${itself}${nobody}` : '');
  // (STUB_COSIGNATURE, recovered as the signer over what the wallet signs and as no one over the other form, which the
  // validator tries first or second: each for the precompile's price, as a real signature's recovery costs.)
  const cosigners = [{ signature: STUB_COSIGNATURE, signer: keyless ? ECRECOVER_NOBODY : signer, ...(c.digest && { digest: c.digest }) }];
  const unsure = keyless && keyed === undefined;
  // K1MeeValidator 1.1.0 (Nexus 1.3.1's) takes a supertransaction signed as EIP-712 typed data, 1.0.3 its hash signed
  // as a message: the stand-in is in the form of what the wallet is asked to sign, which the other version refuses.
  const typedValidator = validator === K1MEE_VALIDATOR_110;
  const other = tree && !!tree.typed !== typedValidator
    ? typedValidator ? "; its K1MeeValidator (1.1.0, MEE 3) takes a supertransaction signed as EIP-712 typed data, not its hash signed as a message" : "; its K1MeeValidator (1.0.3) takes a supertransaction's hash signed as a message, not its EIP-712 typed data (K1MeeValidator 1.1.0's)" : '';
  if (tree?.typed) return [{
    signature: k1meeOwnTyped(STUB_COSIGNATURE, tree as Parameters<typeof k1meeOwnTyped>[1]), cosigners, why: `${why}${other}`, ...(unsure && { unsure }),
    note: "The account's owner signs the supertransaction as EIP-712 typed data (its domain only the account's name, Nexus: no chain or account in it), which the account's own validator (Nexus's default, Biconomy's K1MeeValidator 1.1.0) checks with this operation's item, its hash and time bounds, among the supertransaction's items (simple mode), as Biconomy's MEE node submits it: the stand-in carries the items and the bounds, which the validator returns as the operation's validity.",
  }];
  if (tree) return [{
    signature: k1meeOwnSimple(STUB_COSIGNATURE, tree), cosigners, why: `${why}${other}`, ...(unsure && { unsure }),
    note: "The account's owner signs the supertransaction's hash, which the account's own validator (Nexus's default, Biconomy's K1MeeValidator) checks with this operation's proof, its leaf MEE's hash of the operation's hash and its time bounds (simple mode), as Biconomy's MEE node submits it: the stand-in carries the hash, the proof and the bounds, which the validator returns as the operation's validity.",
  }];
  return [{ signature: STUB_COSIGNATURE, cosigners, why, ...(unsure && { unsure }),
    note: typedValidator
      ? "The account's owner signs the operation's hash itself, which its validator (Nexus 1.3.1's default, Biconomy's K1MeeValidator 1.1.0) takes as it is (its plain form). Sent through Biconomy's MEE node, the owner would sign the supertransaction as EIP-712 typed data instead, its items the operations' hashes and time bounds, and the operation would carry them (simple mode), whose validation costs about 4,600 gas more than simulated here with one item and about 190 more for each further one (the real signatures of both, on Nexus 1.3.1's and the validator's own code). To preview that request, sign its typed data with its operations in context.meeOperations."
      : `The account's owner signs the operation's hash itself, which its validator (Nexus's default, Biconomy's K1MeeValidator) takes as it is (its plain form). Sent through Biconomy's MEE node, the owner would sign a supertransaction's hash instead, a Merkle root of its operations' hashes, and the operation would carry it, its time bounds and its proof (simple mode): ${NEXUS_SIMPLE_COSTS}. To preview that request, sign the supertransaction's hash with its operations (and their time bounds) in context.meeOperations.` }];
}
/**
 * What simple mode costs over the plain form, the proof and the longer signature copied and checked: operations
 * replayed in the plain form against their receipts (2026-11-15) came out 1,676 to 1,709 gas under with one proof
 * element (Base's 5, OP Mainnet's 2), 2,366 to 2,397 with three (OP Mainnet's 3) and 2,666 to 2,776 with four (OP
 * Mainnet's 7, each alone or first in its bundle); on Nexus's and the validator's own code (test/nexus-k1mee-owner.test.ts) 1,624 with
 * one, each further element 313 to 315 more.
 */
const NEXUS_SIMPLE_COSTS = 'its validation costs about 1,700 gas more than simulated here with one proof element and about 330 more for each further one (operations replayed so against their receipts on Base and OP Mainnet came out 1,676 to 1,709 gas under with one, 2,366 to 2,397 with three, 2,666 to 2,776 with four)';
/**
 * A Nexus account its factory deploys in the operation (createAccount(initData, salt), initData abi.encode(the
 * bootstrap, its call)): its owner, the first 20 bytes of the default validator's install data where NexusBootstrap
 * installs it; none where NexusBootstrap's set-up installs other validators only (initNexus, initNexusScoped,
 * initNexusWithSingleValidator and their forms without a registry: the validator then takes the account itself, a
 * contract, as its owner); else none named.
 */
async function nexusDeployStub(c: StubContext, factoryData: Hex): Promise<Stub[]> {
  let owner: string | undefined, none = false;
  try {
    const { functionName, args } = decodeFunctionData({ abi: NEXUS, data: factoryData });
    if (functionName === 'createAccount') {
      const [bootstrap, call] = decodeAbiParameters([{ type: 'address' }, { type: 'bytes' }], args[0]);
      const ours = bootstrap.toLowerCase() === NEXUS_BOOTSTRAP, installs = NEXUS_DEFAULT_VALIDATOR_SETUPS.has(call.slice(0, 10));
      const [data] = ours && installs ? decodeAbiParameters([{ type: 'bytes' }], `0x${call.slice(10)}`) : [];
      if (data && data.length >= 42 && BigInt(`0x${data.slice(2, 42)}`)) owner = `0x${data.slice(2, 42)}`;
      none = ours && NEXUS_OTHER_SETUPS.has(call.slice(0, 10));
    }
  } catch { /* another call */ }
  return nexusStub(c, { owner, none });
}

// --- Splits' Smart Vault (verified source on Sourcify, Base) ---
// A multi-signer account (EOAs and passkeys, by index, with a threshold). validateUserOp reads the signature's first
// byte as its SignatureTypes enum: 0 for one operation, 1 for a Merkle tree of them, 2 (ERC-1271's) reverts, and
// anything else is no member of it, so STUB_SIGNATURE's 0xff reverted with Panic(0x21). After it,
// abi.encode(SingleUserOpSignature(gasLimits, SignatureWrapper(signerIndex, signatureData)[])): with a threshold of
// t, the first t - 1 sign the operation's "light" hash (without its gas values, which the gas limits cap and name
// its paymaster), the last the operation's hash; an EOA's signature is over the personal_sign form, a passkey's a
// WebAuthn assertion (webauthn-sol's struct, the hash as its challenge) checked by P256VERIFY, FreshCryptoLib after.
// With one signer (all seen on Base) the gas limits aren't read, and its SDK leaves them zero.
export const SPLITS_VAULT_IMPLEMENTATION = '0x15ec0fa66a0d96a64d67c58368641fbe9325f3fa';
/** The EntryPoint Splits' Smart Vault names (entryPoint(): v0.7's), in its light hash. */
const SPLITS_ENTRY_POINT = '0x0000000071727de22e5e9d8baf0edac6f37da032';
const SPLITS = parseAbi(['function createAccount(address owner, (bytes32 slot1, bytes32 slot2)[] signers, uint8 threshold, uint256 salt)', 'function getSignerCount() view returns (uint8)', 'function getThreshold() view returns (uint8)', 'function getSigner(uint8 index) view returns ((bytes32 slot1, bytes32 slot2))']);
const SPLITS_SIGNATURE = [{ type: 'tuple', components: [
  { name: 'gasLimits', type: 'tuple', components: [{ name: 'maxPriorityFeePerGas', type: 'uint256' }, { name: 'preVerificationGas', type: 'uint256' }, { name: 'callGasLimit', type: 'uint256' }, { name: 'verificationGasLimit', type: 'uint256' }, { name: 'paymaster', type: 'address' }, { name: 'paymasterVerificationGasLimit', type: 'uint256' }, { name: 'paymasterPostOpGasLimit', type: 'uint256' }] },
  { name: 'signatures', type: 'tuple[]', components: [{ name: 'signerIndex', type: 'uint8' }, { name: 'signatureData', type: 'bytes' }] }] }] as const;
/**
 * The vault's signers read from it (indices with holes once one is removed). The last to sign: the signer's own index
 * when it is an EOA signer; a passkey's when the account itself is asked to sign (as coinbaseFor); else the first
 * EOA's (the vault then reports the signature as not its own). Others to reach the threshold: EOAs as cosigners
 * (stubSignature(k)), then passkeys.
 */
async function splitsVaultStub(c: StubContext, deploying?: { signers: readonly { slot1: Hex; slot2: Hex }[]; threshold: number }): Promise<Stub[]> {
  if (!c.deps.rpc?.has(c.chainId) && !deploying) return [{ signature: STUB_SIGNATURE }];
  const read = async (data: Hex) => String(await c.deps.rpc!.call(c.chainId, 'eth_call', [{ to: c.sender, data }, 'latest'])) as Hex;
  try {
    const signers: { index: number; address?: string; passkey: boolean }[] = [];
    const add = (s: { slot1: Hex; slot2: Hex }, index: number) => { if (BigInt(s.slot2)) signers.push({ index, passkey: true }); else if (BigInt(s.slot1)) signers.push({ index, address: `0x${s.slot1.slice(26)}`.toLowerCase(), passkey: false }); };
    let threshold: number;
    if (deploying) { deploying.signers.forEach(add); threshold = deploying.threshold; }
    else {
      let count: number;
      [count, threshold] = await Promise.all([read(encodeFunctionData({ abi: SPLITS, functionName: 'getSignerCount' })), read(encodeFunctionData({ abi: SPLITS, functionName: 'getThreshold' }))]).then(o => o.map(x => Number(BigInt(x))));
      for (let from = 0; from < 256 && signers.length < count; from += 8) {
        const got = await Promise.all(Array.from({ length: 8 }, (_, k) => read(encodeFunctionData({ abi: SPLITS, functionName: 'getSigner', args: [from + k] })).then(data => decodeFunctionResult({ abi: SPLITS, functionName: 'getSigner', data }))));
        got.forEach((s, k) => add(s, from + k));
      }
    }
    const hash = signers.some(s => s.passkey) ? await c.hash() : undefined;
    const last = signers.find(s => s.address === c.signer) ?? (c.signer === c.sender && hash ? signers.find(s => s.passkey) : undefined) ?? signers.find(s => !s.passkey) ?? signers[0];
    if (!last || (last.passkey && !hash)) return [{ signature: STUB_SIGNATURE }];
    const others = signers.filter(s => s !== last && (!s.passkey || hash)).sort((a, b) => Number(a.passkey) - Number(b.passkey)).slice(0, Math.max(threshold - 1, 0));
    // In signing order, EOAs first: all but the last signer sign the light hash (the account, nonce and calls, with the
    // gas limits in the signature, the EntryPoint and the chain: _getLightUserOpHash), the last the operation's. The
    // ecrecover stand-in recovers an EOA's over either; a passkey's assertion names its challenge, so a passkey
    // signing last asserts over the operation's hash and one before it over the light hash. (Asserting over the
    // operation's hash, a vault's first of two passkeys was refused on Base, 2026-11-18.)
    const order = [last, ...others].sort((a, b) => Number(a.passkey) - Number(b.passkey));
    const pm = c.paymasterAndData && c.paymasterAndData.length >= 42 ? `0x${c.paymasterAndData.slice(2, 42)}` as Hex : `0x${'00'.repeat(20)}` as Hex;
    const max = (1n << 256n) - 1n;
    const gasLimits = order.length > 1 ? { maxPriorityFeePerGas: max, preVerificationGas: max, callGasLimit: max, verificationGasLimit: max, paymaster: pm, paymasterVerificationGasLimit: max, paymasterPostOpGasLimit: max }
      : { maxPriorityFeePerGas: 0n, preVerificationGas: 0n, callGasLimit: 0n, verificationGasLimit: 0n, paymaster: `0x${'00'.repeat(20)}` as Hex, paymasterVerificationGasLimit: 0n, paymasterPostOpGasLimit: 0n };
    const light = order.length > 1 && order.slice(0, -1).some(s => s.passkey)
      ? keccak256(encodeAbiParameters(parseAbiParameters('bytes32, (uint256, uint256, uint256, uint256, address, uint256, uint256), address, uint256'),
        [keccak256(encodeAbiParameters(parseAbiParameters('address, uint256, bytes32'), [c.sender as Hex, c.nonce, keccak256(c.callData ?? '0x')])),
          [gasLimits.maxPriorityFeePerGas, gasLimits.preVerificationGas, gasLimits.callGasLimit, gasLimits.verificationGasLimit, gasLimits.paymaster, gasLimits.paymasterVerificationGasLimit, gasLimits.paymasterPostOpGasLimit],
          SPLITS_ENTRY_POINT, BigInt(c.chainId)]))
      : undefined;
    const cosigners: { signature: Hex; signer: string }[] = [];
    const passkey = (challenge: Hex) => encodeAbiParameters([WEBAUTHN_AUTH], [webAuthnAuth(challenge, 'app.splits.org', ',"crossOrigin":false')]);
    const part = (s: typeof last, final: boolean) => { if (s.passkey) return passkey(final ? hash! : light!); if (s === last) return STUB_SIGNATURE; const signature = stubSignature(cosigners.length + 1); cosigners.push({ signature, signer: s.address! }); return signature; };
    const wrappers = order.map((s, i) => ({ signerIndex: s.index, signatureData: part(s, i === order.length - 1) }));
    const signature = concatHex(['0x00', encodeAbiParameters(SPLITS_SIGNATURE, [{ gasLimits, signatures: wrappers }])]);
    return [{ signature, ...(cosigners.length && { cosigners }), ...(signers.some(s => s.passkey && (s === last || others.includes(s))) && { p256: true }) }];
  } catch { return [{ signature: STUB_SIGNATURE }]; }
}

// --- Alchemy's Modular Account v2: the validation its nonce names ---
// Its verified source (ModularAccountBase, ValidationLocatorLib, AccountStorage; Sourcify, Arbitrum One): the nonce
// key's low byte is the validation's options (1 global, 2 a deferred action, 4 a direct-call validation, whose
// address is the 20 bytes above it), and otherwise the 4 bytes above it are the validation's entity ID, whose module
// the account keeps: validationStorage[entityId << 8].module, a mapping in its ERC-7201 storage
// (Alchemy.ModularAccount.Storage_V2, the mapping its third slot), the module's address in the word's low 20 bytes.
// Its signature is each validation hook's segment, then 0xff and the validation's own: for Alchemy's
// SingleSignerValidationModule (most accounts' validation, and the account's own fallback signer), a type byte (0x00
// for an EOA) and the owner's signature, the 0xff00 form every other validation gets as before.
// Aave Labs' MultiSigValidationModule (`aave-labs.multi-sig-validation-module.1.0.0`; source verified on Sourcify,
// Arbitrum One): 2-of-2, its two signers per entity ID and account (getSigners(entityId, account)), each signing the
// operation's hash as a message (toEthSignedMessageHash); its signature is their two 65-byte signatures, 130 bytes or
// it reverts (InvalidMultisigSignatureLength: the 0xff00 stand-in's 66), in either order, each recovering to one of
// them and not both to the same one (InvalidDuplicateSigners); in getSigners' order, as the app's operations are
// signed, it costs about 170 gas less (the other way round, each key is compared with the other's slot first). On
// Arbitrum One, 123 operations of 95 accounts in a day (2026-11-15, through the paymaster 0x8868…35d3), each
// account's signers its own key and one key all 95 share.
// The stand-in: the signer's in its place among the account's signers, and the other's, recovered as that key (where
// the signer asked is neither, its stand-in and the second signer's, which the module refuses); only for an account
// that runs Modular Account v2's code (runsModularAccount), else the 0xff00 form.
const MODULAR_ACCOUNT_STORAGE = 0x596912a710dec01bac203cb0ed2c7e56a2ce6b2a68276967fff6dd57561bdd00n;
const AAVE_MULTISIG_MODULES = new Set(['0xcbecfad4196836b5185dac5c2f3c81b19ed7a3e6']);
const MULTISIG_SIGNERS = parseAbi(['function getSigners(uint32 entityId, address account) view returns (address[2])']);
/** The module of the validation an operation's nonce names (a direct-call validation's or a deferred action's: undefined). */
async function modularAccountModule(c: StubContext): Promise<{ module: string; entityId: number } | undefined> {
  const key = c.nonce >> 64n;
  if (key & 6n) return undefined;
  const entityId = Number((key >> 8n) & 0xffffffffn);
  const slot = keccak256(encodeAbiParameters(parseAbiParameters('uint256, uint256'), [BigInt(entityId) << 8n, MODULAR_ACCOUNT_STORAGE + 2n]));
  try { return { module: `0x${String(await c.deps.rpc!.call(c.chainId, 'eth_getStorageAt', [c.sender, slot, 'latest'])).slice(-40)}`.toLowerCase(), entityId }; } catch { return undefined; }
}
/**
 * Whether the account runs the Modular Account v2 code stubFor found for it: delegating to it (EIP-7702: now, or in
 * the operation's own transaction), or with the code of Solady's ERC-1967 proxy (SOLADY_ERC1967), as Modular Account
 * v2's factory deploys its accounts. implementationOf takes the ERC-1967 slot of any short code, whose code may run
 * anything else: such an account's storage and a module's records for it say nothing of how it validates.
 */
async function runsModularAccount(c: StubContext): Promise<boolean> {
  if (c.delegate) return true;
  try {
    const code = String(await c.deps.rpc!.call(c.chainId, 'eth_getCode', [c.sender, 'latest'])).toLowerCase();
    return code === `0xef0100${c.runs!.slice(2)}` || code.startsWith(SOLADY_ERC1967);
  } catch { return false; }
}
async function modularAccountStub(c: StubContext): Promise<Stub> {
  const validation = await modularAccountModule(c);
  if (!validation || !AAVE_MULTISIG_MODULES.has(validation.module) || !(await runsModularAccount(c))) return shaped('0xff00')();
  const name = `Aave Labs' MultiSigValidationModule (${shortAddr(validation.module)}, named by its nonce)`;
  let signers: string[] = [];
  try {
    const out = await c.deps.rpc!.call(c.chainId, 'eth_call', [{ to: validation.module, data: encodeFunctionData({ abi: MULTISIG_SIGNERS, functionName: 'getSigners', args: [validation.entityId, c.sender as Hex] }) }, 'latest']);
    signers = decodeFunctionResult({ abi: MULTISIG_SIGNERS, functionName: 'getSigners', data: out as Hex }).map(a => a.toLowerCase()).filter(a => BigInt(a) !== 0n);
  } catch { /* unread: below */ }
  const signer = c.signer.toLowerCase(), others = signers.filter(s => s !== signer);
  if (signers.length === 2 && others.length === 1) {
    return { signature: concatHex(['0xff', ...signers.map(s => (s === signer ? STUB_SIGNATURE : STUB_COSIGNATURE))]), cosigners: [{ signature: STUB_COSIGNATURE, signer: others[0] }],
      note: `The account validates this operation through ${name}, which takes the signatures of both of the account's signers: the signer's key is one of the 2, and the other, ${others[0]}, must sign the operation too before any bundler can include it (here its signature was stood in for, recovered as that key's).` };
  }
  return { signature: concatHex(['0xff', STUB_SIGNATURE, STUB_COSIGNATURE]), ...(signers.length && { cosigners: [{ signature: STUB_COSIGNATURE, signer: signers.at(-1)! }] }),
    why: signers.length ? `it validates through ${name}, which takes the signatures of both of the account's signers, ${signers.join(' and ')}, and the signer asked isn't one of them`
      : `it validates through ${name}, which takes the signatures of the account's two signers, and they couldn't be read`, ...(!signers.length && { unsure: true }) };
}

// --- Alchemy's Modular Account v1 (UpgradeableModularAccount, verified on Sourcify; behind Solady's ERC-1967 proxy) ---
// Each function an operation can call on it names the plugin function that validates the operation
// (getExecutionFunctionConfig). Alchemy's MultiOwnerPlugin takes the owner's ECDSA signature as it is: the plain
// stand-in. Exa, Exactly's wallet (origin https://web.exactly.app), validates the account's own functions through
// Exactly's WebauthnOwnerPlugin (its source published, MIT; unverified, deployed at 0x9d65…d7d5 on Arbitrum One and
// 0x8f49…4ca0 on OP Mainnet, so it is known by its answer to ownersPublicKeysOf): a signature is the signing owner's
// index (one byte), then for a passkey owner webauthn-sol's WebAuthnAuth with abi.encode(toEthSignedMessageHash(
// userOpHash)) as its challenge (checked by P256VERIFY, else FreshCryptoLib), for an address owner its signature over
// that hash (ECDSA, or ERC-1271). STUB_SIGNATURE's first byte named no owner and validation reverted (AA23): an Exa
// operation on Arbitrum One was simulated as calls only, without its paymaster's USDC fee.
export const MODULAR_ACCOUNT_V1 = '0x0046000000000151008789797b54fdb500e2a61e';
const MODULAR_ACCOUNT_V1_VIEWS = parseAbi(['function getExecutionFunctionConfig(bytes4 selector) view returns ((address plugin, bytes21 userOpValidationFunction, bytes21 runtimeValidationFunction))',
  'function ownersPublicKeysOf(address account) view returns ((uint256 x, uint256 y)[])']);
/** Exa's passkeys' relying party, whose origin their assertions name (https://web.exactly.app). */
const EXA_RP_ID = 'web.exactly.app';
async function modularAccountV1Stub(c: StubContext): Promise<Stub> {
  const plain: Stub = { signature: STUB_SIGNATURE };
  if (!c.callData || c.callData.length < 10 || !c.deps.rpc?.has(c.chainId)) return plain;
  const call = (to: string, data: Hex) => c.deps.rpc!.call(c.chainId, 'eth_call', [{ to, data }, 'latest']) as Promise<Hex>;
  let plugin: string, owners: readonly { x: bigint; y: bigint }[];
  try {
    const config = decodeFunctionResult({ abi: MODULAR_ACCOUNT_V1_VIEWS, functionName: 'getExecutionFunctionConfig',
      data: await call(c.sender, encodeFunctionData({ abi: MODULAR_ACCOUNT_V1_VIEWS, functionName: 'getExecutionFunctionConfig', args: [c.callData.slice(0, 10) as Hex] })) });
    plugin = `0x${config.userOpValidationFunction.slice(2, 42)}`.toLowerCase();
    owners = decodeFunctionResult({ abi: MODULAR_ACCOUNT_V1_VIEWS, functionName: 'ownersPublicKeysOf',
      data: await call(plugin, encodeFunctionData({ abi: MODULAR_ACCOUNT_V1_VIEWS, functionName: 'ownersPublicKeysOf', args: [c.sender as Hex] })) });
  } catch { return plain; } // another plugin (Alchemy's MultiOwnerPlugin), or not read
  const index = (i: number): Hex => `0x${i.toString(16).padStart(2, '0')}`;
  const signer = BigInt(/^0x[0-9a-f]{40}$/i.test(c.signer) ? c.signer : 0), asked = c.signer.toLowerCase() === c.sender.toLowerCase();
  const mine = owners.findIndex(o => o.y === 0n && o.x === signer);
  if (mine >= 0 && mine < 256) return { signature: concatHex([index(mine), STUB_SIGNATURE]) };
  // The account itself asked (a passkey wallet's way): its first passkey owner's assertion.
  const k = owners.findIndex(o => o.y !== 0n);
  const hash = k >= 0 && k < 256 && asked ? await c.hash() : undefined;
  if (hash) return { signature: concatHex([index(k), encodeAbiParameters([WEBAUTHN_AUTH], [webAuthnAuth(hashMessage({ raw: hash }), EXA_RP_ID)])]), p256: true };
  const address = Math.max(owners.findIndex(o => o.y === 0n), 0);
  return { signature: concatHex([index(Math.min(address, 255)), STUB_SIGNATURE]),
    ...(!asked && { why: `it validates through ${shortAddr(plugin)} (Exactly's WebauthnOwnerPlugin, named by the function the operation calls), whose owners for this account don't include the signer asked` }) };
}

const shaped = (prefix: string) => (): Stub => ({ signature: `${prefix}${STUB_SIGNATURE.slice(2)}` as Hex });
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
/**
 * The ECDSA signatures a supplied signature carries (65 bytes: r and s nonzero, r below the group order, s in its
 * lower half, v 27 or 28): their byte offsets, from the end, two at most and none overlapping.
 */
export function ecdsaOffsets(sig: Hex): number[] {
  const hex = sig.slice(2).toLowerCase(), out: number[] = [];
  for (let i = hex.length / 2 - 65; i >= 0 && out.length < 2; i--) {
    const v = hex.slice((i + 64) * 2, (i + 65) * 2);
    if (v !== '1b' && v !== '1c') continue;
    const r = BigInt(`0x${hex.slice(i * 2, i * 2 + 64)}`), sv = BigInt(`0x${hex.slice(i * 2 + 64, i * 2 + 128)}`);
    if (!r || !sv || r >= SECP256K1_N || sv > SECP256K1_N / 2n) continue;
    out.push(i);
    i -= 64;
  }
  return out;
}
/** The signature with STUB_SIGNATURE in place of each ECDSA signature it carries (ecdsaOffsets), one at a time; none where it is there already. */
export function walletForm(sig: Hex): Hex[] {
  const hex = sig.slice(2).toLowerCase(), stub = STUB_SIGNATURE.slice(2);
  return ecdsaOffsets(sig).filter(i => hex.slice(i * 2, i * 2 + 130) !== stub).map(i => `0x${hex.slice(0, i * 2)}${stub}${hex.slice(i * 2 + 130)}` as Hex);
}
/**
 * Whether `signer` signed an operation with this signature: an ECDSA signature in it (ecdsaOffsets) recovers as the
 * signer over the operation's hash or its EIP-191 form (personal_sign).
 */
export async function signedBy(signature: Hex, userOpHash: Hex, signer: string): Promise<boolean> {
  const hex = signature.slice(2), who = signer.toLowerCase();
  for (const i of ecdsaOffsets(signature)) {
    const part = `0x${hex.slice(i * 2, i * 2 + 130)}` as Hex;
    for (const h of [hashMessage({ raw: userOpHash }), userOpHash]) {
      try { if ((await recoverAddress({ hash: h, signature: part })).toLowerCase() === who) return true; } catch { /* not a signature */ }
    }
  }
  return false;
}
// --- Ambire's account (AmbireAccount, verified source on Sourcify; EIP-1167 clones of it, Ethereum and Base) ---
// validateUserOp recovers the signer with SignatureValidator.recoverAddr, which reads the signature's last byte as its
// mode: {r}{s}{v}{mode}, Standard (1) recovering over the EIP-712 digest of AmbireOperation(address account, bytes32
// hash) for the operation's hash (domain Ambire, version 1, the chain, the account, a zero salt). A bare 65-byte
// signature ends in v, 27 or 28, beyond the modes: read as Unprotected, which recoverAddr refuses (SV_USED_UNBOUND),
// as STUB_SIGNATURE was on Ethereum and Base. The signer is a key the account gives a privilege to.
export const AMBIRE_IMPLEMENTATION = '0x0f2aa7bcda3d9d210df69a394b6965cb2566c828';
/** An unpublished account implementation with session keys, on Sepolia (see STUB_SHAPES). */
export const SESSION_KEY_ACCOUNT = '0x7e92fa838fd4c3c7602094f0a9c70ec81f8991c7';
/**
 * Stand-ins shaped for accounts that wrap their owner's signature, by the code the account runs (its EIP-7702
 * delegate or ERC-1967 implementation). Others get STUB_SIGNATURE as is, unless the wallet supplies its own stub.
 */
const STUB_SHAPES: Record<string, (c: StubContext) => Stub | Stub[] | Promise<Stub | Stub[]>> = {
  // Alchemy's Modular Account v2 for EIP-7702: its fallback validation (0xff), an EOA signature (0x00), the signature;
  // or the validation its nonce names (see modularAccountStub).
  '0x69007702764179f14f51cdce752f4f775d74e139': modularAccountStub,
  // An EIP-7702 delegate whose operations on Ethereum carry the same 0xff00 prefix (checked: it validates the shape).
  '0x77021100bd87b7008e5e1989d0eb38555d0d0000': shaped('0xff00'),
  // Account implementations (ERC-1967) with the same 0xff00 prefix (Modular Account v2's own shape), on Ethereum and
  // on Arbitrum (checked there: it validates the shape as signed by its owner), but for Aave Labs' 2-of-2 validation
  // (see modularAccountStub).
  '0x000000000000c5a9089039570dd36455b5c07383': modularAccountStub, '0x00000000000002377b26b1eda7b0bc371c60dd4f': modularAccountStub,
  // Its SemiModularAccountStorageOnly (verified on Sourcify, Base), behind SEMI_MODULAR_PROXY: the same form.
  '0x0000000000006e2f9d80caec0da6500f005eb25a': modularAccountStub,
  // Alchemy's Modular Account v1: the form of the plugin validating the function the operation calls (see
  // modularAccountV1Stub).
  [MODULAR_ACCOUNT_V1]: modularAccountV1Stub,
  // An unpublished account implementation on Sepolia (behind ERC-1967 proxies; with session-key, social-recovery and
  // freeze modules), its checks read from its operations' validation in a local EVM: its owner's signature is the bare
  // one over the operation hash's EIP-191 form; a session key's comes after a 0x01 type byte, as abi.encode(signature,
  // bytes32[] proof): an OpenZeppelin Merkle proof that the key may make the call, against the root the account keeps
  // for the key (leaves keccak256(keccak256(target ‖ selector))), empty where the key may make that call alone. Bare
  // first, then a session key's with an empty proof; a key whose root has more leaves takes the proof of its own last
  // signature (simulateOperation). Taken as its owner's, its session keys' operations came out 7-16% low.
  [SESSION_KEY_ACCOUNT]: () => [{ signature: STUB_SIGNATURE }, { signature: concatHex(['0x01', encodeAbiParameters(parseAbiParameters('bytes, bytes32[]'), [STUB_SIGNATURE, []])]) }],
  // ZeroDev Kernel v2.4 and v2.3: validation mode 0x00000000 (its default validator, the owner's ECDSA), then the
  // signature (checked on v2.3: it validates the shape as signed by its owner).
  '0xd3082872f8b06073a021b4602e022d5a070d7cfc': c => kernelV2Stub(c), '0xd3f582f6b4814e989ee8e96bc3175320b5a540ab': c => kernelV2Stub(c),
  // Uniswap's Calibur (an EIP-7702 delegate): its wallet's signature as Calibur decodes it, the key's hash (0: the
  // root key, the account's own), the signature and no hook data, which costs a little more to validate than the
  // bare signature it also accepts (its verified source; seen so on Ethereum).
  '0x000000005c84f8fd50b21cac312528a64437030e': () => ({ signature: encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes' }, { type: 'bytes' }], [`0x${'00'.repeat(32)}`, STUB_SIGNATURE, '0x']) }),
  // Alchemy's LightAccount v2.0.0 and MultiOwnerLightAccount v2.0.0 implementations (ERC-1967): a type byte, 0x00
  // for an EOA owner, then its signature over the personal_sign form of the hash (their verified sources; checked
  // on LightAccount: it validates the shape as signed by its owner).
  '0x8e8e658e22b12ada97b402ff0b044d6a325013c7': shaped('0x00'), '0xd2c27f9ee8e4355f71915ffd5568cb3433b6823d': shaped('0x00'),
  // A later LightAccount implementation, seen with EntryPoint v0.8: the same type byte, then the owner's signature
  // over the operation's hash (its verified source).
  '0x2c53d0bd33a60db8881c7b049df6fd762a1f059c': shaped('0x00'),
  // Kresus's KresusVault (a LightAccount build, verified on Sourcify; Ethereum and Base): the same 0x00 type byte for
  // an EOA owner, then its signature over the personal_sign form of the hash; the plain stand-in's first byte reverted
  // (InvalidSignatureType).
  '0xf9c0176ebc83816187729d0b160a700ba4bfc4d0': shaped('0x00'),
  '0x000100abaad02f1cfc8bbe32bd5a564817339e72': coinbaseStub, '0x00000110dcdedc9581cb5ecb8467282f2926534d': coinbaseStub,
  // Biconomy Smart Account v2: abi.encode(the module's signature, the validation module), with its ECDSA ownership
  // module, which recovers the owner over the personal_sign form of the hash (or the hash itself); seen so on
  // Ethereum (EntryPoint v0.6). Accounts it has upgraded to Nexus keep the proxy and run Nexus's code instead.
  '0x0000002512019dafb59528b82cb92d3c5d2423ac': biconomyStub,
  // EIP-7702 delegates in that form, with a cosigner and the owner's signature over a Merkle root (see cosigned7702Stub).
  ...Object.fromEntries(Object.keys(COSIGNED_7702_DELEGATES).map(d => [d, cosigned7702Stub])),
  // ZeroDev Kernel v3.1 and v3.2: by its validator (see kernelV3Stub).
  '0xbac849bb641841b44e965fb01a4bf5f074f84b4d': kernelV3Stub, '0xd830d15d3dc0c269f3dbaa0f3e8626d33cfdabe1': kernelV3Stub,
  // ZeroDev's Kernel for EIP-7702 (an EIP-7702 delegate; its verified source): the nonce names what validates as in
  // v3.1, and its root is the account's own key, the bare signature over the personal_sign form of the hash; a
  // permission's signer takes the 0xff form. kernelV3Stub gives both, in that order.
  '0xd6cedde84be40893d153be9d467cd6ad37875b28': kernelV3Stub,
  // OKX Wallet's smart account (see okxStubs).
  [OKX_IMPLEMENTATION]: okxStub,
  // Quip's ShrincsWallet and the bullbit.ai wallet (see shrincsStub, bullbitStub).
  [SHRINCS_IMPLEMENTATION]: shrincsStub, [SHRINCS_IMPLEMENTATION_2]: shrincsStub, [BULLBIT_IMPLEMENTATION]: bullbitStub,
  // Splits' Smart Vault (see splitsVaultStub).
  [SPLITS_VAULT_IMPLEMENTATION]: splitsVaultStub,
  // Ambire's account: the stand-in in Standard mode (see AMBIRE_IMPLEMENTATION).
  [AMBIRE_IMPLEMENTATION]: () => ({ signature: `${STUB_SIGNATURE}01` as Hex }),
  // Send's account (see sendStub).
  [SEND_IMPLEMENTATION]: sendStub,
  // Biconomy's Nexus 1.2, its default validator K1MeeValidator (see nexusStub).
  ...Object.fromEntries(Object.entries(NEXUS_K1MEE_IMPLEMENTATIONS).map(([i, validator]) => [i, (c: StubContext) => nexusStub(c, undefined, validator)])),
};

const BICONOMY_PROXY = '0x608060405230546000808092368280378136915af43d82803e156020573d90f35b3d90fd';
const ERC1967_IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
/**
 * OKX Wallet's 797-byte account proxy (its code's keccak256, the same on OP Mainnet and Ethereum): its own initializer
 * (initialize(...), 0xd1f57894, then a delegatecall), and otherwise a delegatecall to what its ERC-1967 slot names.
 */
const OKX_LONG_PROXY = '0x3e5ad3de6e8de44f4a56d8784bd4b0257e51f4d05fc0dc06e79f8e92e1a775f9';
/**
 * An 845-byte ERC-1967 proxy (its code's keccak256; solc 0.8.15, unverified: it reads the slot and delegatecalls to
 * what it names) in front of Alchemy's Modular Account v2 (SemiModularAccountStorageOnly) on Base: three accounts
 * behind it were stood in for as no account in particular, and reverted on it (Panic(0x21)), 2026-11-16.
 */
const SEMI_MODULAR_PROXY = '0x0acbd632c56f6f227951f6c832b36177319145deddb8df3a12c3bcc91fbf49b3';
/**
 * The code an account runs: the ERC-1967 implementation its proxy (or Biconomy Smart Account v2's proxy's) (or its EIP-7702 delegate, such as Coinbase's
 * EIP7702Proxy) runs, or the implementation an EIP-1167 minimal proxy's code names, else its EIP-7702 delegate. Undefined if neither, or unreadable. A proxy is short (up to 199
 * bytes), or OKX Wallet's 797-byte proxy or another known one (SEMI_MODULAR_PROXY) (OKX_LONG_PROXY: the accounts on OP Mainnet and Ethereum behind it were stood
 * in for as no account in particular, and refused it). Other longer code isn't followed, whatever its slot holds:
 * naming the slot doesn't make code delegate to what is in it.
 */
export async function implementationOf(deps: Dependencies, chainId: number, account: string): Promise<string | undefined> {
  if (!deps.rpc?.has(chainId)) return undefined;
  try {
    const code = String(await deps.rpc.call(chainId, 'eth_getCode', [account, 'latest']));
    const delegate = /^0xef0100[0-9a-f]{40}$/i.test(code) ? `0x${code.slice(8)}`.toLowerCase() : undefined;
    // An EIP-7702 delegate with a shape of its own runs its own code: an ERC-1967 slot the account still has from an
    // earlier delegation (Coinbase's EIP7702Proxy writes one) isn't what it runs now. Only a delegate that is itself
    // a proxy is followed to the implementation in the slot.
    if (delegate && STUB_SHAPES[delegate]) return delegate;
    if (code === '0x' || (code.length > 400 && ![OKX_LONG_PROXY, SEMI_MODULAR_PROXY].includes(keccak256(code as Hex)))) return undefined;
    // An EIP-1167 minimal proxy names its implementation in its code (Ambire's accounts are such clones).
    const clone = /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/i.exec(code);
    if (clone) return `0x${clone[1]}`.toLowerCase();
    // Biconomy Smart Account v2's proxy keeps its implementation in the slot numbered by its own address.
    const own = code.toLowerCase().startsWith(BICONOMY_PROXY);
    const slot = String(await deps.rpc.call(chainId, 'eth_getStorageAt', [account, own ? `0x${account.slice(2).toLowerCase().padStart(64, '0')}` : ERC1967_IMPLEMENTATION_SLOT, 'latest']));
    return /^0x0*[1-9a-f]/i.test(slot) ? `0x${slot.slice(-40)}`.toLowerCase() : delegate;
  } catch { return undefined; }
}

/**
 * Stand-ins by the account's own code (its keccak256), for accounts that are neither ERC-1967 proxies nor EIP-7702
 * delegates: Trust Wallet's Barz diamond (see barzStub).
 */
const CODE_SHAPES: Record<string, (c: StubContext) => Promise<Stub[]>> = { [BARZ_PROXY]: c => barzStub(c) };
/** The stand-in for this account: shaped for the code it runs (see STUB_SHAPES) or its factory's, or STUB_SIGNATURE. */
async function stubFor(c: StubContext, delegate?: string, initCode?: Hex): Promise<Stub[]> {
  const factory = initCode && initCode.length >= 42 ? `0x${initCode.slice(2, 42)}`.toLowerCase() : undefined;
  if (factory && FACTORY_STUBS[factory]) return [await FACTORY_STUBS[factory](c, `0x${initCode!.slice(42)}`)].flat();
  // Another factory's deployWithFactory, deploying a Kernel v3 account (kernelDeployStub, which reads its createData
  // as Kernel's initialize: anything else gets the plain stand-in).
  if (factory && !delegate && KERNEL_DEPLOY_SELECTORS.has(`0x${initCode!.slice(42, 50).toLowerCase()}`)) return kernelDeployStub(c, `0x${initCode!.slice(42)}`);
  // A KernelFactory's createAccount, called straight: a Kernel v3 account where its data is Kernel's initialize.
  if (factory && !delegate && initCode!.slice(42, 50).toLowerCase() === KERNEL_FACTORY_CREATE.slice(2)) {
    let kernel = false;
    try {
      const create = decodeFunctionData({ abi: KERNEL_DEPLOY, data: `0x${initCode!.slice(42)}` });
      kernel = create.functionName === 'createAccount' && decodeFunctionData({ abi: KERNEL_DEPLOY, data: create.args[0] }).functionName === 'initialize';
    } catch { /* another factory's createAccount */ }
    if (kernel) return kernelDeployStub(c, `0x${initCode!.slice(42)}`, factory);
  }
  // Another factory deploying a copy of Coinbase Smart Wallet (see coinbaseCopyStub). (Not a factory on 0x7702, an
  // EIP-7702 account's initialization.)
  if (factory && !delegate && !/^0x7702(00)*$/i.test(factory)) { const copy = await coinbaseCopyStub(c, undefined, factory, `0x${initCode!.slice(42)}`); if (copy) return copy; }
  // A session key's operation (an existing account validating through SmartSession, which its nonce names), whatever
  // the account: SmartSession takes the signature as it is (not a Kernel in enable mode installing it, whose signature
  // carries more: smartSessionOf leaves it out).
  const session = !factory ? smartSessionOf(c.nonce) : undefined;
  if (session) return smartSessionStub(c, session);
  const runs = delegate?.toLowerCase() ?? await implementationOf(c.deps, c.chainId, c.sender);
  const shape = runs ? STUB_SHAPES[runs] : undefined;
  if (shape) return [await shape({ ...c, runs, ...(delegate && { delegate: delegate.toLowerCase() }) })].flat();
  // A copy of Coinbase Smart Wallet, which no address names; else an account known by its own code.
  const copy = runs && !factory ? await coinbaseCopyStub(c, runs, undefined, undefined, !!delegate) : undefined;
  if (copy) return copy;
  if (!runs && !factory && c.deps.rpc?.has(c.chainId)) {
    try {
      const code = String(await c.deps.rpc.call(c.chainId, 'eth_getCode', [c.sender, 'latest'])) as Hex;
      const own = code.length > 2 ? CODE_SHAPES[keccak256(code)] : undefined;
      if (own) return own(c);
    } catch { /* not read: the plain stand-in */ }
  }
  return [{ signature: STUB_SIGNATURE }];
}

/** Where the real ecrecover and P256VERIFY move while their stand-ins take their addresses. */
const ECRECOVER_MOVED = '0x0000000000000000000000000000000000ec0001', P256_MOVED = '0x0000000000000000000000000000000000ec0100', VERIFIER_MOVED = '0x0000000000000000000000000000000000ec0da1';
/**
 * Code for a signature precompile that answers `answer` (EVM code leaving one word on the stack) for the stand-in
 * signature (r and s at calldata offsets rAt and rAt + 32), and anything else as the real precompile does (moved to
 * `moved`). Every input still goes through the real precompile, so the gas stays close to its own.
 *   calldatacopy(0, 0, calldatasize); staticcall(gas, moved, 0, calldatasize, 0, 32)
 *   if (calldata[rAt] == r && calldata[rAt + 32] == s) return answer; else return the precompile's output
 */
function standIn(moved: string, r: Hex, s: Hex, rAt: number, answer: string): Hex {
  const at = (n: number) => `60${n.toString(16).padStart(2, '0')}`;
  return `0x366000600037` + `6020600036600073${moved.slice(2)}5afa50` + `7f${r.slice(2)}${at(rAt)}3514` + `7f${s.slice(2)}${at(rAt + 32)}351416` + `607757` + `3d6000f3`
    + `5b${answer}60005260206000f3` as Hex;
}
/**
 * ecrecover (0x01) recovering STUB_SIGNATURE as `signer`: the account's validation runs as it will once signed.
 * With `digest`, only over that digest (what the signer's wallet will sign: an account that tries other forms of
 * the hash first, as Kernel's ECDSA validator does, fails on those as it will). The stand-in is checked first and
 * costs exactly the precompile's price (`price`: 3,000, or the chain's own, HyperEVM's 15,000): instead of calling the real precompile it burns a fixed amount (a
 * counted loop of 26 gas a turn, then 1-gas JUMPDESTs), so validation uses the gas it will. Other signatures go to
 * the real precompile, for about 200 gas more than calling it directly.
 *   if (calldata[64:96] == r && calldata[96:128] == s [&& calldata[0:32] == digest]) { burn; return signer }
 *   calldatacopy(0, 0, calldatasize); staticcall(gas, MOVED, 0, calldatasize, 0, 32); return its output
 * With `cosigners`, each of their stand-in signatures is recovered as its signer the same way, also for 3,000 gas
 * (ecrecoverAsMany, where a stand-in over another digest than its own recovers as no one's key, for the price too).
 */
export function ecrecoverAs(signer: string, digest?: Hex, cosigners: Cosigner[] = [], price = 3000): Hex {
  if (cosigners.length) return ecrecoverAsMany([{ signature: STUB_SIGNATURE, signer, digest }, ...cosigners.map(c => ({ ...c, digest: c.digest ?? digest }))], price);
  const r = STUB_SIGNATURE.slice(2, 66), s = STUB_SIGNATURE.slice(66, 130);
  // The stand-in's path: 59 gas of its own (the checks, the jump, and returning a word; 74 with the digest's check), and the burn.
  const burn = price - (digest ? 74 : 59), turns = Math.floor((burn - 5) / 26), sled = burn - 5 - 26 * turns;
  const check = `7f${r}60403514` + `7f${s}6060351416` + (digest ? `7f${digest.slice(2)}60003514${'16'}` : ''); // 37 + 38 (+ 38) bytes
  const forward = `366000600037` + `6020600036600073${ECRECOVER_MOVED.slice(2)}5afa50` + `3d6000f3`; // 41 bytes
  const dest = (check.length + forward.length) / 2 + 3; // after `PUSH1 dest JUMPI`
  const loop = dest + 1 + 3; // JUMPDEST, PUSH2 turns
  const hex2 = (n: number) => n.toString(16).padStart(4, '0');
  return `0x${check}60${dest.toString(16).padStart(2, '0')}57${forward}`
    + `5b61${hex2(turns)}5b600190038061${hex2(loop)}5750${'5b'.repeat(sled)}` // JUMPDEST; PUSH2 turns; loop: JUMPDEST, 1, SWAP1, SUB, DUP1, PUSH2 loop, JUMPI; POP; sled
    + `73${signer.toLowerCase().slice(2)}60005260206000f3` as Hex;
}
/**
 * What a stand-in signature with its own digest recovers as over any other digest (see ecrecoverAsMany): someone, as
 * the real precompile recovers a signature over a digest it wasn't made for, but no account's key.
 */
const ECRECOVER_NOBODY = '0x0000000000000000000000000000000000ec0b0d';
/**
 * ecrecoverAs for several stand-in signatures, each recovered as its own signer: the checks of r and s in turn (each
 * jumping to its signature's section), then the real precompile for anything else. A signature with a digest of its
 * own (what that key signs: Kernel's enable mode, kernelEnableStub) is recovered as its signer over that digest, and
 * over any other as ECRECOVER_NOBODY, as the real one would be (as someone else), without calling the real precompile:
 * a check of another form of the hash first (the bare hash before its personal_sign form) costs what it will, where
 * going on to the real precompile cost about 300 gas more each time (enable-mode operations came out a median 0.1%
 * high, 2026-11-15). Every path through a stand-in signature's section costs exactly `price`: the k-th runs k + 1
 * checks before its jump, and burns the rest.
 *   for each: if (calldata[64:96] == r && calldata[96:128] == s) goto its section
 *   calldatacopy(0, 0, calldatasize); staticcall(gas, MOVED, 0, calldatasize, 0, 32); return its output
 *   section: [if (calldata[0:32] != digest) { burn; return NOBODY }] burn; return signer
 */
export function ecrecoverAsMany(pairs: Cosigner[], price = 3000): Hex {
  const hex2 = (n: number) => n.toString(16).padStart(4, '0');
  // Each check: r and s, then PUSH2 dest JUMPI: 40 gas. A section's digest check (JUMPDEST, the digest against
  // calldata[0:32], PUSH2 JUMPI): 26 gas; each answer (PUSH20, MSTORE, RETURN), 18; a JUMPDEST, 1.
  const checks = pairs.map(p => `7f${p.signature.slice(2, 66)}60403514` + `7f${p.signature.slice(66, 130)}6060351416`);
  const forward = `366000600037` + `6020600036600073${ECRECOVER_MOVED.slice(2)}5afa50` + `3d6000f3`;
  const head = checks.reduce((n, c) => n + c.length / 2 + 4, 0) + forward.length / 2; // each check, then 61 xxxx 57
  // `burn` gas from `at` (the PUSH2's offset): PUSH2 turns; a loop of 26 gas a turn; POP; a sled of JUMPDESTs.
  const burnFrom = (at: number, burn: number) => {
    const turns = Math.floor((burn - 5) / 26), sled = burn - 5 - 26 * turns;
    return `61${hex2(turns)}5b600190038061${hex2(at + 3)}5750${'5b'.repeat(sled)}`;
  };
  const answer = (who: string) => `73${who.toLowerCase().slice(2)}60005260206000f3`;
  const sections: string[] = [];
  const dests: number[] = [];
  let at = head;
  pairs.forEach((p, k) => {
    const before = 40 * (k + 1);
    let section: string;
    if (!p.digest) section = `5b${burnFrom(at + 1, price - before - 19)}${answer(p.signer)}`;
    else {
      const other = burnFrom(at + 42, price - before - 26 - 18) + answer(ECRECOVER_NOBODY); // after `5b 7f digest 6000 35 14 61 xxxx 57` (42 bytes)
      const match = at + 42 + other.length / 2;
      section = `5b7f${p.digest.slice(2)}6000351461${hex2(match)}57${other}5b${burnFrom(match + 1, price - before - 26 - 1 - 18)}${answer(p.signer)}`;
    }
    dests.push(at);
    sections.push(section);
    at += section.length / 2;
  });
  return `0x${checks.map((c, k) => `${c}61${hex2(dests[k])}57`).join('')}${forward}${sections.join('')}` as Hex;
}
/**
 * What a simulation request needs for ecrecover to recover STUB_SIGNATURE as `signer` (over `digest`, if given): the
 * precompile's stand-in (see ecrecoverAs), with both addresses warm as the precompile is. For Safe transactions too.
 */
export function ecdsaStandIn(signer: string, digest?: Hex, chainId?: number): Pick<SimulationRequest, 'stateOverrides' | 'accessList'> {
  return {
    stateOverrides: { '0x0000000000000000000000000000000000000001': { code: ecrecoverAs(signer, digest, [], chainId === undefined ? 3000 : ecrecoverPrice(chainId)), movePrecompileToAddress: ECRECOVER_MOVED } },
    accessList: [{ address: '0x0000000000000000000000000000000000000001', storageKeys: [] }, { address: ECRECOVER_MOVED, storageKeys: [] }],
  };
}
/** Chains here without P256VERIFY (0x100): HyperEVM and its testnet, on Cancun's rules (as measured on their nodes). */
const NO_P256VERIFY = new Set([999, 998]);
/**
 * Stand-ins for a passkey's P-256 check through the verifiers it names (a Safe passkey owner's P256.Verifiers): the
 * precompile accepting P256_STUB where it is named (0x100), and the fallback verifier contract accepting it after
 * running its real code (its code moved, as verifierAccepting has it). Null where neither can be stood in for.
 */
export async function passkeyVerifiersStandIn(deps: Dependencies, chainId: number, verifiers: { precompile: string; fallback: string }): Promise<Pick<SimulationRequest, 'stateOverrides' | 'accessList'> | null> {
  const P256 = '0x0000000000000000000000000000000000000100';
  // (On a chain that has P256VERIFY: HyperEVM's, which runs Cancun's rules (CHAIN_PROFILES in src/fork-simulator.ts,
  // which this module, in the browser bundle too, doesn't import), has none, so the precompile named there answers
  // nothing and the fallback verifier is what checks it.)
  const precompile = BigInt(verifiers.precompile) === 0x100n && !NO_P256VERIFY.has(chainId);
  const fallback = BigInt(verifiers.fallback) ? verifiers.fallback.toLowerCase() : undefined;
  let code: Hex | undefined;
  if (fallback && deps.rpc?.has(chainId)) {
    try { code = String(await deps.rpc.call(chainId, 'eth_getCode', [fallback, 'latest'])) as Hex; } catch { code = undefined; }
    if (code === '0x') code = undefined;
  }
  if (!precompile && !code) return null;
  return {
    stateOverrides: { ...(precompile && { [P256]: { code: p256Accepting(), movePrecompileToAddress: P256_MOVED } }), ...(code && { [fallback!]: { code: verifierAccepting() }, [VERIFIER_MOVED]: { code } }) },
    // The moved precompile is warm, as precompiles are; the verifier itself stays cold, as on-chain.
    accessList: [...(precompile ? [{ address: P256, storageKeys: [] }, { address: P256_MOVED, storageKeys: [] }] : []), ...(code ? [{ address: VERIFIER_MOVED, storageKeys: [] }] : [])],
  };
}
/** P256VERIFY (0x100, RIP-7212 / EIP-7951) accepting P256_STUB: a passkey's assertion (see webAuthnStub) verifies. */
export const p256Accepting = (): Hex => standIn(P256_MOVED, P256_STUB.r, P256_STUB.s, 0x20, '6001');
/**
 * A P-256 verifier contract taking the precompile's input (hash, r, s, x, y), Daimo's or another, accepting
 * P256_STUB: its code moves to VERIFIER_MOVED and this takes its address. Every input still runs through the real
 * code first (the stub's verification costs what a real one does, and fails), then the stub is answered 1; anything
 * else gets the real answer.
 */
export const verifierAccepting = (): Hex => standIn(VERIFIER_MOVED, P256_STUB.r, P256_STUB.s, 0x20, '6001');
/** Daimo's verifier accepting P256_STUB (see verifierAccepting). */
export const daimoAccepting = verifierAccepting;

export interface OperationInput {
  /** The block to simulate on top of and the header to run in, instead of the latest and the simulator's own (src/block.ts). */
  at?: BlockAt;
  chainId: number; entryPoint: string; sender: string; nonce: bigint;
  /** As the EntryPoint receives it: factory + factoryData, or (v0.8) the EIP-7702 marker + initialization data. */
  initCode: Hex; callData: Hex;
  callGasLimit: bigint; verificationGasLimit: bigint; preVerificationGas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint;
  paymasterAndData: Hex;
  /** What to validate with: a stand-in shaped for the account (its wallet's stub signature), else STUB_SIGNATURE. */
  signature?: Hex;
  /** Other stand-in signatures in `signature` (stubSignature(k)), and whose ecrecover is to recover them as. */
  cosigners?: Cosigner[];
  /**
   * A passkey's stand-in in `signature` (with P256_STUB): `p256`, P256VERIFY (0x100) checks it; `verifier`, a P-256
   * verifier contract taking the precompile's input does. Each accepts it, after running the real check on it.
   */
  p256?: boolean; verifier?: string;
  /**
   * Who signs: ecrecover recovers STUB_SIGNATURE as this address (see ecrecoverAs), so an account whose owner it is
   * validates the operation as it will once signed. Defaults to the account itself (an EIP-7702 account signs for itself).
   */
  signer?: string;
  /**
   * The digest the signer's wallet will sign (the personal_sign form of the operation's hash, or the hash itself):
   * the stand-in recovers only over it, unless the account rejects it then (it signs some other form).
   */
  digest?: Hex;
  /**
   * The signer signs a supertransaction's hash, a Merkle root of its operations' hashes, not this operation's
   * (Biconomy's MEE: src/supertransaction.ts): the root, and the proof of this operation's hash in it. `digest` is
   * then the root's form the wallet signs.
   */
  supertransaction?: SupertransactionProof;
  /** EIP-7702: the delegate the account will have when the operation runs, if it doesn't have it yet. */
  delegate?: string;
  watch?: string[];
  /** Calls to simulate right after the operation, in the same block (e.g. reading what it changed). */
  after?: SimulationRequest[];
  /**
   * Calls to simulate before the operation, in the same block, for the state it starts from: earlier operations of
   * the same supertransaction on its chain (their runs' requests), which it may depend on. Their results aren't its.
   */
  before?: SimulationRequest[];
  /**
   * More state for the simulation: what the caller set (PreviewContext.stateOverrides), and a Safe's approvals
   * standing in for its owners' signatures. The run's own stand-ins go over it (see mergeOverrides).
   */
  stateOverrides?: SimulationRequest['stateOverrides'];
  /** Addresses to start warm: code moved there for a stand-in (not an account the chain would touch). */
  warm?: string[];
}

/**
 * What validation returned: a signature failure, an aggregator, and the range it's valid in: seconds (0 = no end),
 * or from EntryPoint v0.9, block numbers when both bounds carry its flag (bit 47). An aggregator counts as a
 * failure too: handleOps takes operations without one, and rejects any other answer ("AA24 signature error", AA34
 * for a paymaster). OKX Wallet's account answers a signature it doesn't accept that way, not with 1.
 */
export interface Validity { signatureFailed: boolean; aggregator: string | null; validAfter: number; validUntil: number; blocks?: boolean }
const BLOCK_RANGE_FLAG = 1n << 47n;

export interface OperationRun {
  /** The bundler would reject the operation: the EntryPoint's reason ("AA21 didn't pay prefund"), with the revert inside it. */
  rejected?: string;
  /** The operation ran: its effects for the account, without its gas (the native coin as its calls move it: withoutGas). */
  result: SimulationResult;
  /** Whether its calls succeeded (UserOperationEvent), and why they didn't. */
  executed: boolean; revertReason?: string;
  /** The paymaster's postOp reverted. */
  postOpReverted?: string;
  /** What the operation pays for gas, in the native token (from the account's deposit or the paymaster's), and its gas. */
  paid: bigint; gasUsed?: bigint;
  account?: Validity; paymaster?: Validity;
  /**
   * What stood in for the signature: the wallet's own stub, an ECDSA stand-in, a passkey's (WebAuthn) stand-in, or
   * (Kernel's enable mode) the operation's own enable data with stand-ins for the owner's and the new key's signatures.
   */
  standIn?: 'wallet' | 'ecdsa' | 'passkey' | 'enable';
  /** The ECDSA stand-in took the form of the wallet's supplied signature (Stub's `walletForm`). */
  walletForm?: boolean;
  /** With walletForm: the form of the signer's own last signature on the account (Stub's `lastForm`). */
  lastForm?: boolean;
  /** The wallet's supplied stub was refused, and a stand-in in the account's own form ran instead (Stub's `fallback`). */
  fallback?: boolean;
  /** The passkey's stand-in is a real assertion by a passkey made up for the run, its key set as the account's (Stub's `madeUp`). */
  madeUp?: boolean;
  /** Why the account may not take the stand-in as the signer's (Stub's `why`): said where it rejects it. */
  why?: string;
  /** The refusal doesn't show the signer can't sign (Stub's `unsure`). */
  unsure?: boolean;
  /**
   * The account pays nothing toward its gas for a signature it refuses (Stub's `unpaid`, or a supplied signature to
   * such an account): `rejected` AA21, where the account can pay, is its refusal of the signature.
   */
  unpaid?: boolean;
  /**
   * Sent by anyone else, the account's deployment (`factory`) or validation (`account`) fails (`rejected`, as the
   * simulation's own bundler): the operation was simulated as `bundler`, which recently sent that factory's
   * deployments or the account's operations; or, without `bundler`, as each of the `tried` that did, and it failed
   * as them too (each run answered). With `of`, `tried` were the busiest of `of` found: the last failed exactly as
   * anyone else does, and the rest weren't run (see simulateOperation).
   */
  origin?: { by: 'factory' | 'account'; rejected: string; bundler?: string; tried: number; of?: number };
  /** What to say where the account accepts the stand-in (Stub's `note`). */
  note?: string;
  /**
   * From Amsterdam on: the gas the run's transaction carried for new state beyond the cap on what its code runs on
   * (its reservoir), where the calls failed without it and succeeded with it, run in the local EVM (withStateReservoir).
   */
  reservoir?: bigint;
  /** The `after` calls' results. */
  after?: SimulationResult[];
  /** What was simulated for `result` (and the `after` calls): for tracing it. */
  requests?: SimulationRequest[];
}

/**
 * The chain's node failed a whole operation's simulation: it threw (an HTTP error or a rate limit the client's own
 * retries didn't get past, a timeout, a dropped connection, a block it won't run) or the run reverted without any of
 * the EntryPoint's reasons. Nothing about the operation or its account: simulateOperation throws it once a passing
 * failure has been asked again, and the preview says so (it used to fall back to the calls alone, saying nothing: 3
 * of the 19 operations a survey of 2,025 on six chains didn't validate, 2 on Polygon whose whole run came back with
 * nothing, twice each, and 1 on Arbitrum One, whose public node was answering HTTP 429 to most requests). `passing`:
 * one a later ask can get past (the node's rate or load, a timeout, the connection).
 */
export class NodeFailure extends Error {
  passing: boolean;
  constructor(message: string, passing: boolean) { super(message.slice(0, 300)); this.name = 'NodeFailure'; this.passing = passing; }
}
const PASSING_FAILURE = /HTTP (429|5\d\d)|rate.?limit|too many requests|capacity|overload|busy|time(d)? ?out|aborted|fetch failed|socket|ECONNRESET|ETIMEDOUT|EAI_AGAIN|network|header not found|unexpected result/i;
/** How long a passing failure waits before it is asked again (once: the client has retried it already). */
const NODE_RETRY_MS = 2000;
/**
 * A run, asked once more after a passing failure of the node; a NodeFailure if it still fails, or if it failed
 * otherwise (a simulator that can't run calls in sequence isn't a failure: rethrown as it is).
 */
async function patiently<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await run(); } catch (e) {
      if (e instanceof NodeFailure && !e.passing) throw e;
      if (e instanceof Error && e.name === 'BatchSimulationUnsupported') throw e;
      const message = e instanceof Error ? e.message : String(e);
      const passing = e instanceof NodeFailure || PASSING_FAILURE.test(message) || (e instanceof Error && /TimeoutError|AbortError/.test(e.name));
      if (!passing || attempt >= 1) throw e instanceof NodeFailure ? e : new NodeFailure(message, passing);
      await new Promise(r => setTimeout(r, NODE_RETRY_MS));
    }
  }
}

/** How the paymaster refused a run: in its validation (2: AA33), in its charge after the calls (1: AA50, or postOp reverting), or not (0). */
const paymasterRefused = (r: OperationRun | null): number => (r?.rejected?.startsWith('AA33') ? 2 : r?.rejected?.startsWith('AA50') || r?.postOpReverted ? 1 : 0);

export function validity(data: bigint): Validity {
  const low = data & ((1n << 160n) - 1n);
  const until = (data >> 160n) & ((1n << 48n) - 1n), after = data >> 208n;
  const blocks = until >= BLOCK_RANGE_FLAG && after >= BLOCK_RANGE_FLAG;
  return { signatureFailed: low !== 0n, aggregator: low > 1n ? `0x${low.toString(16).padStart(40, '0')}` : null,
    validUntil: Number(blocks ? until - BLOCK_RANGE_FLAG : until), validAfter: Number(blocks ? after - BLOCK_RANGE_FLAG : after), ...(blocks && { blocks }) };
}

/** FailedOp(opIndex, reason) and FailedOpWithRevert(opIndex, reason, inner): the EntryPoint rejecting the operation. */
function failedOp(data: string | undefined): string | null {
  if (!data) return null;
  try {
    if (data.startsWith(FAILED_OP)) return decodeAbiParameters([{ type: 'uint256' }, { type: 'string' }], `0x${data.slice(10)}`)[1];
    if (data.startsWith(FAILED_OP_WITH_REVERT)) {
      const [, reason, inner] = decodeAbiParameters([{ type: 'uint256' }, { type: 'string' }, { type: 'bytes' }], `0x${data.slice(10)}`);
      const why = decodeRevert(inner);
      return why ? `${reason}: ${why}` : reason;
    }
  } catch { /* not the EntryPoint's error */ }
  return null;
}

/** The base fee the operation's gas is priced at (the latest block's): eth_simulateV1 would otherwise run at 0. */
async function baseFee(deps: Dependencies, chainId: number): Promise<bigint | undefined> {
  if (!deps.rpc?.has(chainId)) return undefined;
  try {
    const block = await deps.rpc.call(chainId, 'eth_getBlockByNumber', ['latest', false]) as { baseFeePerGas?: string } | null;
    return block?.baseFeePerGas ? BigInt(block.baseFeePerGas) : undefined;
  } catch { return undefined; }
}

/** The node's suggested priority fee (eth_maxPriorityFeePerGas), or none when it can't be read. */
async function suggestedTip(deps: Dependencies, chainId: number): Promise<bigint> {
  try { return deps.rpc?.has(chainId) ? BigInt(String(await deps.rpc.call(chainId, 'eth_maxPriorityFeePerGas', []))) : 0n; } catch { return 0n; }
}

/**
 * The whole operation, simulated as the EntryPoint runs it (see the top of the file). Null when it can't be: no
 * simulator or no simulation code for this EntryPoint, a simulator that doesn't report logs (eth_call only), or a
 * failure that isn't the EntryPoint's own.
 */
export async function simulateOperation(op: OperationInput, deps: Dependencies): Promise<OperationRun | null> {
  const sim = deps.simulator;
  const entryPoint = op.entryPoint.toLowerCase(), sender = op.sender.toLowerCase();
  const ep = SIMULATIONS[entryPoint];
  if (!sim || !ep || ((op.after?.length || op.before?.length) && !sim.simulateBatch)) return null;
  const signer = (op.signer ?? sender).toLowerCase();
  const word = (v: bigint) => v.toString(16).padStart(32, '0');
  const fields = (signature: Hex) => ep.version === '0.6'
    ? { sender: sender as Hex, nonce: op.nonce, initCode: op.initCode, callData: op.callData, callGasLimit: op.callGasLimit, verificationGasLimit: op.verificationGasLimit, preVerificationGas: op.preVerificationGas, maxFeePerGas: op.maxFeePerGas, maxPriorityFeePerGas: op.maxPriorityFeePerGas, paymasterAndData: op.paymasterAndData, signature }
    : { sender: sender as Hex, nonce: op.nonce, initCode: op.initCode, callData: op.callData, accountGasLimits: `0x${word(op.verificationGasLimit)}${word(op.callGasLimit)}` as Hex, preVerificationGas: op.preVerificationGas, gasFees: `0x${word(op.maxPriorityFeePerGas)}${word(op.maxFeePerGas)}` as Hex, paymasterAndData: op.paymasterAndData, signature };
  // The hash the account validates, from the EntryPoint itself (the signature isn't part of it).
  const hash = async () => {
    if (!deps.rpc?.has(op.chainId)) return undefined;
    try {
      const data = ep.version === '0.6' ? encodeFunctionData({ abi: HASH_V06, functionName: 'getUserOpHash', args: [fields('0x') as never] }) : encodeFunctionData({ abi: HASH, functionName: 'getUserOpHash', args: [fields('0x') as never] });
      const out = String(await deps.rpc.call(op.chainId, 'eth_call', [{ to: entryPoint, data }, 'latest']));
      return /^0x[0-9a-f]{64}$/i.test(out) ? out as Hex : undefined;
    } catch { return undefined; }
  };
  // A paymaster's operation runs as a bundler that paymaster's operations came through lately (BUNDLER when none is
  // found): a paymaster can check, or work differently for, the bundler sending it (tx.origin). One on Arbitrum One
  // charged 9,130 gas more as its own bundlers than as an address it didn't know, 4% of the operation's gas.
  const paymaster = op.paymasterAndData.length >= 42 && !/^0x0{40}/.test(op.paymasterAndData) ? `0x${op.paymasterAndData.slice(2, 42)}` : null;
  // Not the account itself: one that sends its own operations (an EIP-7702 account, say) is its own "bundler", and a
  // run as it would hand it the bundler's balance (BUNDLER_BALANCE) to validate and spend (as for originBundlers).
  const notSender = (found: string[]) => found.filter(b => b !== sender);
  const bundlers = paymaster ? recentBundlers(deps, op.chainId, entryPoint, op.paymasterAndData).then(notSender) : Promise.resolve([]);
  // Kernel v3.2's and v3.3's chain-agnostic hash of the operation (replayableUserOpHash: getUserOpHash's with chain ID 0).
  const replayableHash = () => {
    if (ep.version === '0.6') return undefined;
    const f = fields('0x') as { accountGasLimits: Hex; gasFees: Hex };
    const packed = keccak256(encodeAbiParameters(parseAbiParameters('address, uint256, bytes32, bytes32, bytes32, uint256, bytes32, bytes32'),
      [sender as Hex, op.nonce, keccak256(op.initCode), keccak256(op.callData), f.accountGasLimits, op.preVerificationGas, f.gasFees, keccak256(op.paymasterAndData)]));
    return keccak256(encodeAbiParameters(parseAbiParameters('bytes32, address, uint256'), [packed, entryPoint as Hex, 0n]));
  };
  const context: StubContext = { deps, chainId: op.chainId, sender, signer, ...(op.signer !== undefined && { named: true }), nonce: op.nonce, hash, paymasterAndData: op.paymasterAndData, callData: op.callData, entryPoint, replayableHash, ...(op.digest && { digest: op.digest }), ...(op.supertransaction && { supertransaction: op.supertransaction }) };
  const supplied: Stub | undefined = op.signature && op.signature !== '0x' ? { signature: op.signature, wallet: true, ...(op.cosigners?.length && { cosigners: op.cosigners }), ...(op.p256 && { p256: true }), ...(op.verifier && { verifier: op.verifier.toLowerCase() }), ...(op.warm?.length && { warm: op.warm }) } : undefined;
  // A supplied signature runs as it is, except a Kernel operation's in enable mode (its nonce's first byte 0x01): the
  // enable data it carries is kept, with stand-ins for the signatures in it (kernelEnableStub), which a dApp's SDK
  // leaves as dummies until they're signed. It runs as it is only if those can't be made.
  const enable = supplied && op.nonce >> 248n === 1n && readKernelEnable(supplied.signature) ? (await stubFor({ ...context, signature: supplied.signature }, op.delegate, op.initCode)).filter(s => s.enable) : [];
  // Where the account refuses the supplied signature as it is (a gas-estimation stub's dummy, signed by no one), the
  // same signature with the ECDSA stand-in in place of the one it carries: the account then reads the form its
  // owner's signature will take (a type byte, a wrapper) and runs that path, as the plain stand-in may not (an
  // account on Sepolia took a bare 65-byte signature by a path 29,000 gas cheaper than its wallet's own form).
  const stubs: Stub[] = supplied ? [...enable, supplied, ...walletForm(supplied.signature).map(signature => ({ signature, walletForm: true }))] : await stubFor(context, op.delegate, op.initCode);
  const fee = await baseFee(deps, op.chainId);
  // The first run waits for the lookup 1.5 s at most (then runs as BUNDLER); a refusal waits for all of it.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const soon = await Promise.race([bundlers, new Promise<string[]>(r => { timer = setTimeout(() => r([]), 1500); (timer as { unref?: () => void }).unref?.(); })]);
  clearTimeout(timer);
  const first = soon[0] ?? BUNDLER;
  // The price the bundle's transaction pays (tx.gasprice), taken as what the operation pays its bundler: the base fee
  // plus its priority fee, up to its fee cap (on Arbitrum too, which now charges tips: tx-checks). Contracts read it:
  // a Base DEX's pools add a "MEV tax" to a swap's fee by the transaction's priority fee, and an operation simulated
  // at no price showed a swap that on-chain, taxed, missed its minimum and reverted. An operation paying less than
  // the base fee (a gasless one, its fee cap zero: its bundler pays) still rides in a transaction that pays the
  // market's price: the base fee plus the node's suggested tip. Left out when the base fee isn't known.
  const tip = op.maxPriorityFeePerGas;
  const price = fee === undefined ? undefined : op.maxFeePerGas >= fee ? (op.maxFeePerGas < fee + tip ? op.maxFeePerGas : fee + tip)
    : fee + await suggestedTip(deps, op.chainId);
  // An account whose deployment, or validation, checks the bundler sending it (tx.origin), as a paymaster can: OKX
  // Wallet's accounts that one of its factories deploys (0x335e…9fe3 on Ethereum) only initialize when the bundler is
  // on OKX's list (isWhitelistedBundler), else InvalidBundler() (AA13), and the operation was shown as one bundlers
  // would reject. Where deploying the account fails (AA13), the operation runs once more as each bundler that
  // recently sent the factory's deployments; where an existing account's validation reverts (AA23) and its code reads
  // tx.origin, as each that sent its own operations (not the account itself). The first it gets past that with is
  // used for every run after it; with none, the rejection stands, and says it failed as those bundlers too (when
  // the node answered each run). A bundler rejected exactly as anyone else is ends the runs. The lookup is only made
  // on such a failure, and for a factory reads back 10,000 blocks at most (deployments are many, and few factories
  // care: see README); a deploying account's validation isn't retried so (its code can't be read before it exists).
  const factory = op.initCode.length >= 42 && !op.delegate && !/^0x7702(00)*$/i.test(op.initCode.slice(0, 42)) ? `0x${op.initCode.slice(2, 42)}`.toLowerCase() : null;
  let origin: NonNullable<OperationRun['origin']> | undefined;
  let readsOrigin: Promise<boolean> | undefined;
  const originCheck = async (rejected: string): Promise<'factory' | 'account' | null> => {
    if (rejected.startsWith('AA13')) return factory ? 'factory' : null;
    if (!rejected.startsWith('AA23') || factory) return null;
    readsOrigin ??= runningCode(deps, op.chainId, sender).then(code => !!code && executes(code, 0x32));
    return (await readsOrigin) ? 'account' : null;
  };
  // Each candidate shape in turn, until the account accepts one (validation neither reverts nor fails).
  // Failing that, the best of them: a run that went through with the signature refused (the signer isn't the
  // account's: the whole operation's gas, and why) over a later shape's rejection (Kernel's ECDSA validator reverts on
  // the 0xff form, InvalidSignature); and a candidate that couldn't run doesn't replace one that did.
  let result: OperationRun | null = null;
  const rank = (r: OperationRun) => (r.rejected?.startsWith('AA23') ? 0 : 1);
  // An account that pays nothing toward its gas for a signature it refuses (Stub's unpaid): a supplied signature's
  // run too, by the code the account runs, looked up only where its prefund went unpaid.
  let unpaidCode: Promise<boolean> | undefined;
  const refusesUnpaid = () => unpaidCode ??= (op.delegate ? Promise.resolve(op.delegate.toLowerCase()) : implementationOf(deps, op.chainId, sender)).then(runs => !!runs && !!COSIGNED_7702_DELEGATES[runs]?.unpaid);
  for (const stub of stubs) {
    const ran = await withStub(stub);
    if (ran && !ran.account?.signatureFailed && !ran.rejected?.startsWith('AA23')) return ran;
    // (The stand-in in the wallet's form is kept only where the account takes it: refused too, the wallet's own stub's
    // run says so.)
    if (ran && !stub.walletForm && (!result || rank(ran) >= rank(result))) result = ran;
  }
  // A wallet's stub the account refused, in its own form and with the stand-in in it: then the stand-ins of the
  // account's own form, as for an operation with no signature, so that a stub (a dummy, or one its ECDSA part isn't
  // found in) leaves the preview no worse off than none would. On Base, 2026-11-18, operations previewed with their
  // own signatures' ECDSA parts dummied reverted in validation (Panic(0x41), InvalidSignature) or were refused, 35-38%
  // low, where with no signature their stand-ins validated. Such a run replaces the stub's only where it got further.
  if (supplied && !enable.length) {
    for (const stub of (await stubFor(context, op.delegate, op.initCode)).map(s => ({ ...s, fallback: true }))) {
      const ran = await withStub(stub);
      if (ran && !ran.account?.signatureFailed && !ran.rejected?.startsWith('AA23')) return ran;
      if (ran && (!result || rank(ran) > rank(result))) result = ran;
    }
  }
  // Refused every way so far, a named signer's own last signature on this account (the latest of its last six
  // operations with an ECDSA signature in it that recovers as the signer: lastSignature), with the stand-in in place of
  // that signature: the form its wallet signs in, whatever it wraps the signature in and carries with it. An account on
  // Sepolia (an unpublished implementation with session keys, 0x7e92…91c7) takes a session key's signature after a
  // type byte, with a Merkle proof that the key may make the call, which no other stand-in has; its owner's bare
  // signature takes another path. Taken as its owner's, its session keys' operations came out 7-16% low. Kept only
  // where the account accepts it.
  if (!enable.length && context.named && signer !== sender) {
    const last = await lastSignature({ deps, chainId: op.chainId, sender, entryPoint, key: `signer:${signer}`, match: (s, h) => signedBy(s, h, signer) });
    for (const signature of last ? walletForm(last) : []) {
      const ran = await withStub({ signature, walletForm: true, lastForm: true });
      if (ran && !ran.account?.signatureFailed && !ran.rejected?.startsWith('AA23')) return ran;
    }
  }
  return result;

  async function withStub(stub: Stub): Promise<OperationRun | null> {
  // A P-256 verifier contract (Daimo's, or the one a supplied signature names), moved to make room for its
  // stand-in: its code is the chain's own.
  const verifierAt = stub.p256 === 'daimo' ? DAIMO_P256_VERIFIER : stub.verifier;
  let verifier: Hex | undefined;
  if (verifierAt) {
    try { verifier = deps.rpc?.has(op.chainId) ? String(await deps.rpc.call(op.chainId, 'eth_getCode', [verifierAt, 'latest'])) as Hex : undefined; } catch { verifier = undefined; }
    if (!verifier || verifier === '0x') return null;
  }
  const data = ep!.version === '0.6'
    ? encodeFunctionData({ abi: HANDLE_V06, functionName: 'simulateHandleOp', args: [fields(stub.signature) as never, `0x${'00'.repeat(20)}`, '0x'] })
    : encodeFunctionData({ abi: HANDLE, functionName: 'simulateHandleOp', args: [fields(stub.signature) as never, `0x${'00'.repeat(20)}`, '0x'] }); // v0.7 to v0.9: packed
  // (The EntryPoint is watched too: its balanceOf is the account's deposit, which is read around the run with the
  // account's balance, for the coin its calls move: withoutGas.)
  const run = (bundler: string, recover: Hex) => patiently(() => runOperation(op, sim!, { chainId: op.chainId, from: bundler, account: sender, to: entryPoint, data, value: 0n, ...(fee !== undefined && { baseFee: fee }), ...(price !== undefined && price > 0n && { gasPrice: price }), watch: [entryPoint, ...(op.watch ?? []).filter(t => t.toLowerCase() !== entryPoint)],
    gasFloor: entryPointGasFloor(op, ep!.version),
    // The moved precompile is warm, as precompiles are (EIP-2929), so validation costs what it will.
    // An account the bundle delegates (EIP-7702) is warm from its authorization on, as the chain has it.
    accessList: [{ address: '0x0000000000000000000000000000000000000001', storageKeys: [] }, { address: ECRECOVER_MOVED, storageKeys: [] },
      ...(op.delegate ? [{ address: sender, storageKeys: [] }] : []),
      ...(stub.p256 === true ? [{ address: '0x0000000000000000000000000000000000000100', storageKeys: [] }, { address: P256_MOVED, storageKeys: [] }] : []),
      // The verifier itself stays cold, as it is on-chain; only the call on to its moved code is warm.
      ...(verifier ? [{ address: VERIFIER_MOVED, storageKeys: [] }] : []), ...(stub.warm ?? []).map(address => ({ address, storageKeys: [] }))],
    // The run's own state over op.stateOverrides (the caller's, and a Safe's approvals: see mergeOverrides). The
    // bundler can afford the priced call's gas, whoever stands in for it. Where the caller set an address a stand-in
    // needs, the stand-in's code and slots are used there, its balance and other slots the caller's: the EntryPoint
    // runs its simulation code (with the storage it keeps for itself) over the caller's deposits and nonces; ecrecover,
    // P256VERIFY and a P-256 verifier answer the stand-in signature, and any other the chain's own way; the account
    // has the delegation the operation is signed for, and a stand-in key's storage.
    stateOverrides: mergeOverrides(op.stateOverrides, { ...(price !== undefined && price > 0n && { [bundler]: { balance: BUNDLER_BALANCE } }), [entryPoint]: entryPointOverride(entryPoint, op.chainId)!, '0x0000000000000000000000000000000000000001': { code: recover, movePrecompileToAddress: ECRECOVER_MOVED },
      ...(stub.p256 === true && { '0x0000000000000000000000000000000000000100': { code: p256Accepting(), movePrecompileToAddress: P256_MOVED } }),
      ...(verifier && { [verifierAt!]: { code: verifierAccepting() }, [VERIFIER_MOVED]: { code: verifier } }),
      ...Object.fromEntries(Object.entries(stub.code ?? {}).map(([address, code]) => [address, { code }])),
      ...((op.delegate || stub.storage) && { [sender]: { ...(op.delegate && { code: `0xef0100${op.delegate.toLowerCase().slice(2)}` }), ...(stub.storage && { stateDiff: stub.storage }) } }) }) }, ep!.version));
  // A run after the first (as another bundler). One the node failed says nothing of that bundler, so the first run's
  // rejection can't be said to stand: kept (`failed`), and thrown once no other bundler gets the operation further
  // (the preview then says the node failed it, not that bundlers would reject it). A failure that can pass (the
  // node's rate, a timeout: run already asked twice) ends the runs, as the next would meet it too.
  let failed: NodeFailure | undefined;
  const another = async (bundler: string, recover: Hex) => {
    try { return await run(bundler, recover); } catch (e) {
      if (!(e instanceof NodeFailure)) throw e;
      failed = e;
      if (e.passing) throw e;
      return null;
    }
  };
  const nodeFailed = (e: NodeFailure, who: string, first: OperationRun) =>
    new NodeFailure(`${who} refused the simulation's own bundler (${first.rejected?.slice(0, 4) ?? 'postOp reverting'}), and the run as a bundler it took lately failed: ${e.message}`, e.passing);
  const standIn = stub.wallet ? 'wallet' as const : stub.enable ? 'enable' as const : stub.p256 || stub.madeUp ? 'passkey' as const : 'ecdsa' as const;
  const attempt = async (recover: Hex) => {
    let ran = await run(origin?.bundler ?? first, recover);
    // The paymaster refused: once more as each other bundler it accepted lately, in case it only refused this one, in
    // its validation (AA33) or in its charge after the calls (postOp: on EntryPoint v0.6 a failing postOp is run again
    // and, failing again, rejects the operation, AA50; from v0.7 the calls are undone and the paymaster still pays).
    // Coinbase's VerifyingPaymaster (on Base, for v0.6; source verified) refuses in postOp: its data's allowAnyBundler
    // byte 0 and the transaction's origin not on its list (isBundlerAllowed), BundlerNotAllowed(tx.origin), in either
    // postOp. Its 82 operations in 2,000 blocks on Base (2026-11-15) all had that byte 0 and all came from its one
    // listed bundler: one whose lookup took longer than the first run waits for it was simulated as anyone else, and
    // shown as one bundlers would reject (AA50).
    if (paymaster && paymasterRefused(ran)) {
      // An empty list here can be a passing node failure (the lookup is not remembered when so), not "no bundlers":
      // ask once more before falling back to the account's calls alone.
      let found = (await bundlers).filter(b => b !== first);
      if (!found.length) found = notSender(await recentBundlers(deps, op.chainId, entryPoint, op.paymasterAndData)).filter(b => b !== first);
      failed = undefined;
      const refused = ran;
      try {
        for (const bundler of found) {
          const again = await another(bundler, recover);
          if (!again) continue;
          if (!paymasterRefused(again)) return again;
          // Past the paymaster's validation, though its postOp still fails: the furthest the operation got, if none gets further.
          if (paymasterRefused(again) < paymasterRefused(ran)) ran = again;
        }
      } catch (e) { if (e instanceof NodeFailure) throw nodeFailed(e, 'the paymaster', refused!); throw e; }
      // A run the node failed could have been the one the paymaster takes: not its refusal, the node's failure.
      if (failed) throw nodeFailed(failed, 'the paymaster', refused!);
    }
    // Deploying the account, or its validation, failed: once more as the bundlers its factory's deployments, or its
    // own operations, came through lately, in case it only takes them. A deployment is tried so once per operation
    // (it runs before the signature is looked at); validation once for each stand-in, which it may be refusing.
    const by = !origin?.bundler && ran?.rejected ? await originCheck(ran.rejected) : null;
    if (by && ran?.rejected && !(by === 'factory' && origin)) {
      const code = ran.rejected.slice(0, 4);
      // Not the account itself: one that sends its own operations (an EIP-7702 account, say) is its own "bundler",
      // and a run as it would hand it the bundler's balance (BUNDLER_BALANCE) to validate and spend.
      const found = (await originBundlers(deps, op.chainId, entryPoint, by, by === 'factory' ? factory! : sender)).filter(b => b !== first && b !== sender);
      // `answered`: the runs that came back. One that didn't (null: the node failed, as under load) says nothing of
      // that bundler, so the rejection is said to stand as these bundlers too only when every run made answered.
      let answered = 0, unanswered = 0, same = false;
      const whose = by === 'factory' ? "the account's factory" : 'the account';
      failed = undefined;
      for (const bundler of found) {
        let again: OperationRun | null;
        try { again = await another(bundler, recover); } catch (e) { if (e instanceof NodeFailure) throw nodeFailed(e, whose, ran); throw e; }
        if (!again) { unanswered++; continue; }
        if (!again.rejected?.startsWith(code)) { origin = { by, rejected: ran.rejected, bundler, tried: answered + 1 }; return again; }
        answered++;
        // Rejected exactly as the simulation's own bundler was (the same revert data, for the same gas): that bundler
        // was taken as anyone else is, so the failure doesn't turn on who sends it, and the rest aren't run (an AA13
        // that has nothing to do with the sender cost up to five runs more). The OKX factory's deployments all came
        // through the one bundler it accepts.
        if (again.result.returnData === ran.result.returnData && again.result.gasUsed !== undefined && again.result.gasUsed === ran.result.gasUsed) { same = true; break; }
      }
      // As for the paymaster: a run the node failed (not one that came back limited) leaves the rejection unsaid,
      // unless a bundler was rejected exactly as the first was (the failure doesn't turn on who sends it).
      if (failed && !same) throw nodeFailed(failed, whose, ran);
      if (!unanswered) origin = { by, rejected: ran.rejected, tried: answered, ...(answered < found.length && { of: found.length }) };
    }
    return ran;
  };
  // Over the digest the wallet will sign first (or, an enable-mode stand-in's, the digest each key signs); if the
  // account checks another form of the hash, over any. Not for a supertransaction's signer (op.supertransaction):
  // what it signs is the root, not a form of this operation's hash, and an account that takes the stand-in only over
  // another digest doesn't take that signature (an account checking the operation's hash, or a passkey's assertion
  // over it: run over any digest, either showed validating, where only K1MeeValidator's simple mode takes the root's
  // signature, a session's or a Nexus account's own).
  const recoverGas = ecrecoverPrice(op.chainId);
  // (An enable-mode stand-in's signatures are all its own, none STUB_SIGNATURE: ecrecover stands in for those alone.)
  const recover = (cosigners: Cosigner[] | undefined, digest?: Hex) => stub.enable && cosigners?.length ? ecrecoverAsMany(cosigners, recoverGas) : ecrecoverAs(signer, digest, cosigners, recoverGas);
  const own = stub.cosigners?.some(c => c.digest);
  let result = (op.digest && standIn === 'ecdsa') || own ? await attempt(recover(stub.cosigners, standIn === 'ecdsa' ? op.digest : undefined)) : null;
  if (!op.supertransaction && (!result || result.account?.signatureFailed || result.rejected?.startsWith('AA23'))) result = await attempt(recover(stub.cosigners?.map(({ digest: _, ...c }) => c)));
  // Calls that fail for want of gas for new state, from Amsterdam on: run again with the reservoir bundlers give them.
  if (result && !result.rejected && !result.executed && !result.postOpReverted) result = await withStateReservoir(op, sim!, result, ep!.version, deps) ?? result;
  const why = stub.why ?? (op.supertransaction && result?.account?.signatureFailed ? SUPERTRANSACTION_WHY : undefined);
  const unpaid = stub.unpaid || (stub.wallet && result?.rejected?.startsWith('AA21') && await refusesUnpaid());
  return result && { ...result, standIn, ...(stub.walletForm && { walletForm: true }), ...(stub.lastForm && { lastForm: true }), ...(stub.fallback && { fallback: true }), ...(stub.madeUp && { madeUp: true }), ...(why && { why }), ...(stub.unsure && { unsure: true }), ...(stub.note && { note: stub.note }), ...(unpaid && { unpaid: true }), ...(origin && { origin }) };
  }
}

/**
 * A whole operation's transfers with the account's native coin as its calls move it, without the gas: `gas` is what
 * the account's EntryPoint deposit pays for it (the operation's cost, unless a paymaster pays).
 *
 * The account's EntryPoint deposit counts as its own coin: the EntryPoint takes the gas from it, keeps there what is
 * left of the prefund, and only the account can withdraw it. The account's balance alone also goes down by the
 * prefund it pays in while it is validated (what the EntryPoint asks for, or more), which none of its calls do, and
 * no simulator tells that payment apart from what its calls send: a balance read before and after (the local EVM's)
 * nets the two into one change, and eth_simulateV1's transfer per call frame shows the prefund as the account sending
 * the EntryPoint coin, as a deposit its calls make does. So where the simulator read both the account's balance and
 * its deposit (readAssets: the EntryPoint answers balanceOf with deposits), the account's coin is what the two
 * together changed by, plus the gas: what its calls sent and received, the coin of its deposit they gave someone
 * else (depositTo another account, withdrawTo another address) included, and none they kept in it. It is listed as
 * the simulator's own transfers between the account and others, and the rest as one between the account and the
 * EntryPoint. Where it didn't read both (the amounts are the events'), the coin moving between the account and the
 * EntryPoint is left out, as its deposit's, but its deposit withdrawn to any other address (withdrawTo) is listed
 * from the EntryPoint's Withdrawn event, as coin the account sends: no transfer of the account's shows it (the
 * EntryPoint pays it), and it was missing. (Its deposit given to another account, depositTo, no event tells apart
 * from the prefund: it is still left out there.) The deposit itself is no token: never listed as one.
 *
 * The account's stake (addStake) is not its deposit: it stays locked until unlockStake and a delay after it, so
 * staking shows as the coin leaving its balance, and taking the stake back as the coin coming in. A stake withdrawn
 * to any other address (withdrawStake) moves neither the account's balance nor its deposit, and the EntryPoint's own
 * transfer isn't the account's: it is listed from the EntryPoint's StakeWithdrawn event, as coin the account sends,
 * so that a drain of it shows. That needs no read, so it is listed either way.
 */
export function withoutGas(r: SimulationResult, account: string, entryPoint: string, gas: bigint): SimulationResult['transfers'] {
  const withEntryPoint = (t: SimulationResult['transfers'][number]) => t.asset === 'native' && t.from !== t.to
    && ((t.from === account && t.to === entryPoint) || (t.from === entryPoint && t.to === account));
  const out = r.transfers.filter(t => t.asset !== entryPoint && !withEntryPoint(t));
  /** What the EntryPoint's `topic` events (StakeWithdrawn, Withdrawn) say it paid from the account to other addresses. */
  const paidOut = (topic: string) => {
    const paid: SimulationResult['transfers'] = [];
    for (const l of r.logs ?? []) {
      if (l.address.toLowerCase() !== entryPoint || l.topics[0]?.toLowerCase() !== topic || !l.topics[1] || `0x${l.topics[1].slice(26)}`.toLowerCase() !== account) continue;
      try {
        const [to, raw] = decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], l.data as Hex);
        if (to.toLowerCase() !== account && raw > 0n) paid.push({ asset: 'native', from: account, to: to.toLowerCase(), raw });
      } catch { /* not the EntryPoint's event */ }
    }
    return paid;
  };
  const stake = paidOut(STAKE_WITHDRAWN);
  if (!r.readAssets?.includes('native') || !r.readAssets.includes(entryPoint)) return [...out, ...paidOut(WITHDRAWN), ...stake];
  const net = (ts: SimulationResult['transfers'], asset: string) => ts.reduce((sum, t) => t.asset !== asset ? sum : sum + (t.to === account ? t.raw : 0n) - (t.from === account ? t.raw : 0n), 0n);
  const rest = net(r.transfers, 'native') + net(r.transfers, entryPoint) + gas - net(out, 'native');
  if (rest < 0n) out.push({ asset: 'native', from: account, to: entryPoint, raw: -rest });
  else if (rest > 0n) out.push({ asset: 'native', from: entryPoint, to: account, raw: rest });
  return [...out, ...stake];
}

/**
 * The least gas an EntryPoint run of the operation is given where a pass sets it (SimulationRequest.gasFloor): all of
 * its limits (v0.6's verification limit three times over with a paymaster, which its postOp runs on too), a 64th more,
 * and 100,000. The EntryPoint refuses a run whose gas left falls under them (AA95), whatever the operation then uses:
 * BNB Chain's lean pass, which gives a run half as much gas again as it used and 100,000, was refused so for an
 * operation whose call gas limit was 200,000 and used far less, and its deposit went unread.
 */
export function entryPointGasFloor(op: Pick<OperationInput, 'callGasLimit' | 'verificationGasLimit' | 'preVerificationGas' | 'paymasterAndData'>, version: '0.6' | '0.7' | '0.8' | '0.9'): bigint {
  const pm = op.paymasterAndData.length >= 42 && !/^0x0{40}/.test(op.paymasterAndData);
  const pmGas = version !== '0.6' && op.paymasterAndData.length >= 2 + 2 * 52 ? BigInt(`0x${op.paymasterAndData.slice(42, 74)}`) + BigInt(`0x${op.paymasterAndData.slice(74, 106)}`) : 0n;
  return ((pm && version === '0.6' ? 3n : 1n) * op.verificationGasLimit + op.callGasLimit + pmGas + op.preVerificationGas) * 65n / 64n + 100_000n;
}

/** EIP-7825: the most gas a transaction's code runs on; from Amsterdam on, what its gas limit holds beyond pays for new state only (EIP-8037). */
export const ORDINARY_GAS_CAP = 16_777_216n;
/**
 * From Amsterdam on (Ethereum and Sepolia, where a block's header says so), new state is metered apart (EIP-8037):
 * what a transaction's gas limit holds over ORDINARY_GAS_CAP is a reservoir that new state is paid from first, out of
 * sight of gasleft(), so not out of an operation's own call gas limit, and not counted in the gas the EntryPoint
 * charges it. Bundlers on Sepolia send operations so: of 22 operations of one Safe app (2026-11-19), the 15 signed
 * with a call gas limit of 700,000 came in bundles of 17.9-18.0 million gas, writing 1.2 million gas of new state from
 * the reservoir, and were charged 450,574 gas; the 7 signed with 2,000,000 came in bundles of 2.4 million, paid for the
 * same state out of their call gas, and were charged 1,677,857. The chain's node gives a simulation's whole gas as
 * ordinary gas (src/evm/transaction.ts), so the first kind ran out of gas in its calls there, where on the chain it
 * succeeded. Where an operation's calls failed, they are run again in the local EVM (which meters the reservoir) on a
 * transaction carrying ORDINARY_GAS_CAP more for new state: if they succeed so, that run is the operation's, as its
 * bundler sends it. (The reservoir's size changes nothing the account pays, so long as it holds the new state.)
 */
async function withStateReservoir(op: OperationInput, sim: NonNullable<Dependencies['simulator']>, run: OperationRun, version: '0.6' | '0.7' | '0.8' | '0.9', deps: Dependencies): Promise<OperationRun | null> {
  const [req] = run.requests ?? [];
  if ((op.chainId !== 1 && op.chainId !== 11155111) || !sim.trace || !req || (req.gas ?? 0n) > ORDINARY_GAS_CAP) return null;
  const at = op.at ?? await pinLatest(deps.rpc, op.chainId);
  if (!at?.header.amsterdam) return null;
  const local = { simulate: async (q: SimulationRequest) => (await sim.trace!([q]))?.[0] ?? null, simulateBatch: (qs: SimulationRequest[]) => sim.trace!(qs) };
  const again = await runOperation({ ...op, at }, local, { ...req, gas: 2n * ORDINARY_GAS_CAP }, version).catch(() => null);
  return again && !again.rejected && again.executed && !again.postOpReverted ? { ...again, reservoir: ORDINARY_GAS_CAP } : null;
}

async function runOperation(op: OperationInput, sim: NonNullable<Dependencies['simulator']>, req: SimulationRequest, version: '0.6' | '0.7' | '0.8' | '0.9'): Promise<OperationRun | null> {
  const entryPoint = op.entryPoint.toLowerCase(), sender = op.sender.toLowerCase();
  if (op.at) req = { ...req, at: op.at };
  const requests = [req, ...(op.after ?? []).map(a => (op.at ? { ...a, at: op.at } : a))];
  // Earlier operations run first, for their state; the results are the operation's and those after it.
  const before = (op.before ?? []).map(a => (op.at ? { ...a, at: op.at } : a));
  const results = before.length ? (await sim.simulateBatch!([...before, ...requests]))?.slice(before.length) : requests.length > 1 ? await sim.simulateBatch!(requests) : [await sim.simulate(req)];
  const r = results?.[0];
  if (!r) return null;
  if (r.status === 'reverted') {
    const rejected = failedOp(r.returnData);
    if (rejected) return { rejected, result: r, executed: false, paid: 0n, requests };
    // Reverted without any of the EntryPoint's reasons, which it gives for whatever it refuses (the account's
    // validation and deployment, the paymaster's, the gas): not the operation's answer but the run's, such as the
    // node giving it too little gas.
    throw new NodeFailure(`its run reverted without any of the EntryPoint's reasons${r.revertReason ? ` (${r.revertReason})` : ''}`, false);
  }
  if (r.limited || !r.returnData || !r.logs) return null;
  let decoded: readonly [bigint, bigint, bigint, bigint, boolean, Hex];
  try {
    // v0.7 and v0.8 return the ExecutionResult struct (a dynamic tuple, behind its offset); v0.6's patch, its fields.
    decoded = version === '0.6' ? decodeAbiParameters(RESULT, r.returnData as Hex)
      : Object.values(decodeAbiParameters([{ type: 'tuple', components: RESULT.map((c, i) => ({ ...c, name: `f${i}` })) }], r.returnData as Hex)[0]) as unknown as typeof decoded;
  } catch { return null; }
  const [, paid, accountData, paymasterData] = decoded;
  const mine = (l: { address: string; topics: string[] }) => l.address === entryPoint && l.topics[2] && `0x${l.topics[2].slice(26)}` === sender;
  const event = r.logs.find(l => l.topics[0] === USER_OPERATION_EVENT && mine(l));
  if (!event) return null;
  const [, success, , actualGasUsed] = decodeAbiParameters([{ type: 'uint256' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }], event.data as Hex);
  const reason = (topic: string) => {
    const l = r.logs!.find(x => x.topics[0] === topic && mine(x));
    if (!l) return undefined;
    try { return decodeRevert(decodeAbiParameters([{ type: 'uint256' }, { type: 'bytes' }], l.data as Hex)[1]) ?? 'no reason given'; } catch { return 'no reason given'; }
  };
  const revertReason = success ? undefined : reason(USER_OPERATION_REVERT_REASON);
  const postOpReverted = reason(POST_OP_REVERT_REASON);
  const paymaster = op.paymasterAndData.length >= 42 && !/^0x0{40}/.test(op.paymasterAndData); // address 0 is none
  // Without a paymaster, the gas is taken from the account's deposit (what it paid in during validation, the prefund,
  // and what it held there before), and what's left of the prefund stays there. So it is with an account that is its
  // own paymaster: the paymaster's deposit the gas comes from is the account's.
  const ownDeposit = !paymaster || op.paymasterAndData.slice(0, 42).toLowerCase() === sender;
  const transfers = withoutGas(r, sender, entryPoint, ownDeposit ? paid : 0n);
  return { result: { ...r, transfers }, executed: success, ...(revertReason && { revertReason }), ...(postOpReverted && { postOpReverted }),
    paid, gasUsed: actualGasUsed, account: validity(accountData), ...(paymaster && { paymaster: validity(paymasterData) }), ...(results!.length > 1 && { after: results!.slice(1) as SimulationResult[] }), requests };
}
