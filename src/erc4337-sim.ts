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
import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData, parseAbi, type Hex } from 'viem';
import type { Dependencies, SimulationRequest, SimulationResult } from './types.ts';
import { decodeRevert } from './simulation.ts';
import { ENTRY_POINT_SIMULATIONS_V06, ENTRY_POINT_SIMULATIONS_V07, ENTRY_POINT_SIMULATIONS_V08 } from './entrypoint-simulations.ts';

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

/** The simulation code for each EntryPoint (see entrypoint-simulations.ts); v0.9 has no published release to build it from. */
const SIMULATIONS: Record<string, { version: '0.6' | '0.7' | '0.8'; code: string }> = {
  '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789': { version: '0.6', code: ENTRY_POINT_SIMULATIONS_V06 },
  '0x0000000071727de22e5e9d8baf0edac6f37da032': { version: '0.7', code: ENTRY_POINT_SIMULATIONS_V07 },
  '0x4337084d9e255ff0702461cf8895ce9e3b5ff108': { version: '0.8', code: ENTRY_POINT_SIMULATIONS_V08 },
};
const HANDLE = parseAbi(['function simulateHandleOp((address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature) op, address target, bytes targetCallData)']);
const HANDLE_V06 = parseAbi(['function simulateHandleOp((address sender, uint256 nonce, bytes initCode, bytes callData, uint256 callGasLimit, uint256 verificationGasLimit, uint256 preVerificationGas, uint256 maxFeePerGas, uint256 maxPriorityFeePerGas, bytes paymasterAndData, bytes signature) op, address target, bytes targetCallData)']);
const RESULT = [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bool' }, { type: 'bytes' }] as const;
const USER_OPERATION_EVENT = '0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f';
const USER_OPERATION_REVERT_REASON = '0x1c4fada7374c0a9ee8841fc38afe82932dc0f8e69012e927f061a8bae611a201';
const POST_OP_REVERT_REASON = '0xf62676f440ff169a3a9afdbf812e89e7f95975ee8e5c31214ffdef631c5f4792';
const FAILED_OP = '0x220266b6', FAILED_OP_WITH_REVERT = '0x65c8fd4d';
/** The simulated bundler (simulateHandleOp doesn't check its caller; some paymasters check tx.origin, see recentBundler). */
const BUNDLER = '0x0000000000000000000000000000000000004337';

/**
 * A bundler that recently submitted an operation this paymaster paid for: paymasters that only accept certain
 * bundlers (tx.origin; Coinbase's, for one) refuse any other, which says nothing about the operation itself.
 */
async function recentBundler(deps: Dependencies, chainId: number, entryPoint: string, paymaster: string): Promise<string | undefined> {
  const rpc = deps.rpc;
  if (!rpc?.has(chainId)) return undefined;
  try {
    const head = BigInt(String(await rpc.call(chainId, 'eth_blockNumber', [])));
    const logs = await rpc.call(chainId, 'eth_getLogs', [{ address: entryPoint, topics: [USER_OPERATION_EVENT, null, null, `0x${'00'.repeat(12)}${paymaster.slice(2).toLowerCase()}`], fromBlock: `0x${(head > 1000n ? head - 1000n : 0n).toString(16)}`, toBlock: `0x${head.toString(16)}` }]) as { transactionHash: string }[];
    const last = logs?.[logs.length - 1];
    if (!last) return undefined;
    const tx = await rpc.call(chainId, 'eth_getTransactionByHash', [last.transactionHash]) as { from?: string } | null;
    return tx?.from?.toLowerCase();
  } catch { return undefined; }
}

/**
 * A stand-in for the owner's ECDSA signature: well-formed (low s, v 28, r a valid curve point), so it recovers to
 * some address and an account's check fails rather than reverting. Bundlers use the same one to estimate gas.
 */
export const STUB_SIGNATURE = '0xfffffffffffffffffffffffffffffff0000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c' as Hex;

type StubContext = { deps: Dependencies; chainId: number; sender: string; signer: string };
const OWNERS = parseAbi(['function nextOwnerIndex() view returns (uint256)', 'function ownerAtIndex(uint256 index) view returns (bytes)']);
/**
 * Coinbase Smart Wallet: abi.encode(SignatureWrapper(ownerIndex, signatureData)), with the index of the signer
 * among the owners (0 if it isn't one; passkey owners can't be stood in for).
 */
async function coinbaseStub({ deps, chainId, sender, signer }: StubContext): Promise<Hex> {
  let index = 0n;
  const call = async (data: Hex) => String(await deps.rpc!.call(chainId, 'eth_call', [{ to: sender, data }, 'latest'])) as Hex;
  try {
    const mine = encodeAbiParameters([{ type: 'address' }], [signer as Hex]);
    const n = BigInt(await call(encodeFunctionData({ abi: OWNERS, functionName: 'nextOwnerIndex' })));
    for (let i = 0n; i < n && i < 16n; i++) {
      const [owner] = decodeAbiParameters([{ type: 'bytes' }], await call(encodeFunctionData({ abi: OWNERS, functionName: 'ownerAtIndex', args: [i] })));
      if (owner.toLowerCase() === mine) { index = i; break; }
    }
  } catch { /* index 0 */ }
  return coinbaseWrapper(index);
}
const coinbaseWrapper = (ownerIndex: bigint) => encodeAbiParameters([{ type: 'tuple', components: [{ name: 'ownerIndex', type: 'uint256' }, { name: 'signatureData', type: 'bytes' }] }], [{ ownerIndex, signatureData: STUB_SIGNATURE }]);
const CREATE_ACCOUNT = parseAbi(['function createAccount(bytes[] owners, uint256 nonce)']);
/** A Coinbase Smart Wallet its factory is deploying: the signer's index among the owners createAccount sets. */
function coinbaseDeployStub({ signer }: StubContext, factoryData: Hex): Hex {
  let index = 0n;
  try {
    const [owners] = decodeFunctionData({ abi: CREATE_ACCOUNT, data: factoryData }).args;
    const mine = encodeAbiParameters([{ type: 'address' }], [signer as Hex]);
    const i = owners.findIndex(o => o.toLowerCase() === mine);
    if (i >= 0) index = BigInt(i);
  } catch { /* index 0 */ }
  return coinbaseWrapper(index);
}
/** Stand-ins for accounts a factory is deploying in the operation, by factory (their code doesn't exist yet). */
const FACTORY_STUBS: Record<string, (c: StubContext, factoryData: Hex) => Hex> = {
  // Coinbase Smart Wallet's factories (v1 and v1.1).
  '0x0ba5ed0c6aa8c49038f819e587e2633c4a9f428a': coinbaseDeployStub, '0xba5ed110efdba3d005bfc882d75358acbbb85842': coinbaseDeployStub,
};

/**
 * Stand-ins shaped for accounts that wrap their owner's ECDSA signature, by the code the account runs (its EIP-7702
 * delegate or ERC-1967 implementation). Others get STUB_SIGNATURE as is, unless the wallet supplies its own stub.
 */
const STUB_SHAPES: Record<string, (c: StubContext) => Hex | Promise<Hex>> = {
  // Alchemy's Modular Account v2 for EIP-7702: its fallback validation (0xff), an EOA signature (0x00), the signature.
  '0x69007702764179f14f51cdce752f4f775d74e139': () => `0xff00${STUB_SIGNATURE.slice(2)}`,
  // An EIP-7702 delegate whose operations on Ethereum carry the same 0xff00 prefix (checked: it validates the shape).
  '0x77021100bd87b7008e5e1989d0eb38555d0d0000': () => `0xff00${STUB_SIGNATURE.slice(2)}`,
  // ZeroDev Kernel v2.4: validation mode 0x00000000 (its default validator, the owner's ECDSA), then the signature.
  '0xd3082872f8b06073a021b4602e022d5a070d7cfc': () => `0x00000000${STUB_SIGNATURE.slice(2)}`,
  '0x000100abaad02f1cfc8bbe32bd5a564817339e72': coinbaseStub, '0x00000110dcdedc9581cb5ecb8467282f2926534d': coinbaseStub,
};

/**
 * The code an account runs: the ERC-1967 implementation its proxy (or its EIP-7702 delegate, such as Coinbase's
 * EIP7702Proxy) runs, else its EIP-7702 delegate. Undefined if neither, or unreadable.
 */
async function implementationOf(deps: Dependencies, chainId: number, account: string): Promise<string | undefined> {
  if (!deps.rpc?.has(chainId)) return undefined;
  try {
    const code = String(await deps.rpc.call(chainId, 'eth_getCode', [account, 'latest']));
    const delegate = /^0xef0100[0-9a-f]{40}$/i.test(code) ? `0x${code.slice(8)}`.toLowerCase() : undefined;
    if (code === '0x' || code.length > 400) return undefined;
    const slot = String(await deps.rpc.call(chainId, 'eth_getStorageAt', [account, '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc', 'latest']));
    return /^0x0*[1-9a-f]/i.test(slot) ? `0x${slot.slice(-40)}`.toLowerCase() : delegate;
  } catch { return undefined; }
}

/** The stand-in for this account: shaped for the code it runs (see STUB_SHAPES) or its factory's, or STUB_SIGNATURE. */
async function stubFor(deps: Dependencies, chainId: number, sender: string, signer: string, delegate?: string, initCode?: Hex): Promise<Hex> {
  const factory = initCode && initCode.length >= 42 ? `0x${initCode.slice(2, 42)}`.toLowerCase() : undefined;
  if (factory && FACTORY_STUBS[factory]) return FACTORY_STUBS[factory]({ deps, chainId, sender, signer }, `0x${initCode!.slice(42)}`);
  const runs = delegate?.toLowerCase() ?? await implementationOf(deps, chainId, sender);
  const shape = runs ? STUB_SHAPES[runs] : undefined;
  return shape ? await shape({ deps, chainId, sender, signer }) : STUB_SIGNATURE;
}

/** Where the real ecrecover moves while ECRECOVER_AS stands in at 0x01. */
const ECRECOVER_MOVED = '0x0000000000000000000000000000000000ec0001';
/**
 * Code for the ecrecover precompile (0x01) that recovers STUB_SIGNATURE (its r and s) as `signer`, and anything else
 * as the real precompile does (moved to ECRECOVER_MOVED): the account's validation then runs as it will once the
 * signer has signed. Every input still goes through the real precompile, so the gas stays close to its 3,000.
 *   calldatacopy(0, 0, calldatasize); staticcall(gas, MOVED, 0, calldatasize, 0, 32)
 *   if (calldata[64:96] == stub r && calldata[96:128] == stub s) return signer; else return the precompile's output
 */
export function ecrecoverAs(signer: string): Hex {
  const r = STUB_SIGNATURE.slice(2, 66), s = STUB_SIGNATURE.slice(66, 130);
  return `0x366000600037` + `6020600036600073${ECRECOVER_MOVED.slice(2)}5afa50` + `7f${r}60403514` + `7f${s}6060351416` + `607757` + `3d6000f3`
    + `5b73${signer.toLowerCase().slice(2)}60005260206000f3` as Hex;
}

export interface OperationInput {
  chainId: number; entryPoint: string; sender: string; nonce: bigint;
  /** As the EntryPoint receives it: factory + factoryData, or (v0.8) the EIP-7702 marker + initialization data. */
  initCode: Hex; callData: Hex;
  callGasLimit: bigint; verificationGasLimit: bigint; preVerificationGas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint;
  paymasterAndData: Hex;
  /** What to validate with: a stand-in shaped for the account (its wallet's stub signature), else STUB_SIGNATURE. */
  signature?: Hex;
  /**
   * Who signs: ecrecover recovers STUB_SIGNATURE as this address (see ecrecoverAs), so an account whose owner it is
   * validates the operation as it will once signed. Defaults to the account itself (an EIP-7702 account signs for itself).
   */
  signer?: string;
  /** EIP-7702: the delegate the account will have when the operation runs, if it doesn't have it yet. */
  delegate?: string;
  watch?: string[];
  /** Calls to simulate right after the operation, in the same block (e.g. reading what it changed). */
  after?: SimulationRequest[];
  /** More state for the simulation (e.g. a Safe's approvals standing in for its owners' signatures). */
  stateOverrides?: SimulationRequest['stateOverrides'];
}

/** What validation returned: a signature failure, an aggregator, and the time range it's valid in (seconds; 0 = no end). */
export interface Validity { signatureFailed: boolean; aggregator: string | null; validAfter: number; validUntil: number }

export interface OperationRun {
  /** The bundler would reject the operation: the EntryPoint's reason ("AA21 didn't pay prefund"), with the revert inside it. */
  rejected?: string;
  /** The operation ran: its effects for the account, without the gas prefund the account pays the EntryPoint. */
  result: SimulationResult;
  /** Whether its calls succeeded (UserOperationEvent), and why they didn't. */
  executed: boolean; revertReason?: string;
  /** The paymaster's postOp reverted. */
  postOpReverted?: string;
  /** What the operation pays for gas, in the native token (from the account's deposit or the paymaster's), and its gas. */
  paid: bigint; gasUsed?: bigint;
  account?: Validity; paymaster?: Validity;
  /** The `after` calls' results. */
  after?: SimulationResult[];
}

export function validity(data: bigint): Validity {
  const low = data & ((1n << 160n) - 1n);
  return { signatureFailed: low === 1n, aggregator: low > 1n ? `0x${low.toString(16).padStart(40, '0')}` : null, validUntil: Number((data >> 160n) & ((1n << 48n) - 1n)), validAfter: Number(data >> 208n) };
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

/**
 * The whole operation, simulated as the EntryPoint runs it (see the top of the file). Null when it can't be: no
 * simulator or no simulation code for this EntryPoint, a simulator that doesn't report logs (eth_call only), or a
 * failure that isn't the EntryPoint's own.
 */
export async function simulateOperation(op: OperationInput, deps: Dependencies): Promise<OperationRun | null> {
  const sim = deps.simulator;
  const entryPoint = op.entryPoint.toLowerCase(), sender = op.sender.toLowerCase();
  const ep = SIMULATIONS[entryPoint];
  if (!sim || !ep || (op.after?.length && !sim.simulateBatch)) return null;
  const signer = (op.signer ?? sender).toLowerCase();
  const signature = op.signature && op.signature !== '0x' ? op.signature : await stubFor(deps, op.chainId, sender, signer, op.delegate, op.initCode);
  const word = (v: bigint) => v.toString(16).padStart(32, '0');
  const data = ep.version === '0.6'
    ? encodeFunctionData({ abi: HANDLE_V06, functionName: 'simulateHandleOp', args: [{ sender: sender as Hex, nonce: op.nonce, initCode: op.initCode, callData: op.callData, callGasLimit: op.callGasLimit, verificationGasLimit: op.verificationGasLimit, preVerificationGas: op.preVerificationGas, maxFeePerGas: op.maxFeePerGas, maxPriorityFeePerGas: op.maxPriorityFeePerGas, paymasterAndData: op.paymasterAndData, signature }, `0x${'00'.repeat(20)}`, '0x'] })
    : encodeFunctionData({ abi: HANDLE, functionName: 'simulateHandleOp', args: [{ sender: sender as Hex, nonce: op.nonce, initCode: op.initCode, callData: op.callData, accountGasLimits: `0x${word(op.verificationGasLimit)}${word(op.callGasLimit)}`, preVerificationGas: op.preVerificationGas, gasFees: `0x${word(op.maxPriorityFeePerGas)}${word(op.maxFeePerGas)}`, paymasterAndData: op.paymasterAndData, signature }, `0x${'00'.repeat(20)}`, '0x'] });
  const fee = await baseFee(deps, op.chainId);
  const run = (bundler: string) => runOperation(op, sim, { chainId: op.chainId, from: bundler, account: sender, to: entryPoint, data, value: 0n, ...(fee !== undefined && { baseFee: fee }), ...(op.watch?.length && { watch: op.watch }),
    // The moved precompile is warm, as precompiles are (EIP-2929), so validation costs what it will.
    accessList: [{ address: '0x0000000000000000000000000000000000000001', storageKeys: [] }, { address: ECRECOVER_MOVED, storageKeys: [] }],
    stateOverrides: { ...op.stateOverrides, [entryPoint]: { code: ep.code }, '0x0000000000000000000000000000000000000001': { code: ecrecoverAs(signer), movePrecompileToAddress: ECRECOVER_MOVED },
      ...(op.delegate && { [sender]: { code: `0xef0100${op.delegate.toLowerCase().slice(2)}` } }) } }, ep.version);
  const first = await run(BUNDLER);
  // The paymaster refused: once more as a bundler it accepted lately, in case it only refused this one.
  const paymaster = op.paymasterAndData.length >= 42 ? `0x${op.paymasterAndData.slice(2, 42)}` : null;
  if (paymaster && first?.rejected?.startsWith('AA33')) {
    const bundler = await recentBundler(deps, op.chainId, entryPoint, paymaster);
    const again = bundler && bundler !== BUNDLER ? await run(bundler) : null;
    if (again && !again.rejected?.startsWith('AA33')) return again;
  }
  return first;
}

async function runOperation(op: OperationInput, sim: NonNullable<Dependencies['simulator']>, req: SimulationRequest, version: '0.6' | '0.7' | '0.8'): Promise<OperationRun | null> {
  const entryPoint = op.entryPoint.toLowerCase(), sender = op.sender.toLowerCase();
  const results = op.after?.length ? await sim.simulateBatch!([req, ...op.after]) : [await sim.simulate(req)];
  const r = results?.[0];
  if (!r) return null;
  if (r.status === 'reverted') {
    const rejected = failedOp(r.returnData);
    return rejected ? { rejected, result: r, executed: false, paid: 0n } : null;
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
  // The prefund the account pays the EntryPoint during validation is gas, shown as `paid` (the rest stays deposited).
  // The EntryPoint answers balanceOf with deposits, so a balance read can list the deposit too: also gas.
  const transfers = r.transfers.filter(t => !(t.asset === 'native' && t.from === sender && t.to === entryPoint) && t.asset !== entryPoint);
  const paymaster = op.paymasterAndData.length >= 42;
  return { result: { ...r, transfers }, executed: success, ...(revertReason && { revertReason }), ...(postOpReverted && { postOpReverted }),
    paid, gasUsed: actualGasUsed, account: validity(accountData), ...(paymaster && { paymaster: validity(paymasterData) }), ...(results!.length > 1 && { after: results!.slice(1) as SimulationResult[] }) };
}
