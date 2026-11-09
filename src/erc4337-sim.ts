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
import { concatHex, decodeAbiParameters, decodeFunctionData, decodeFunctionResult, encodeAbiParameters, getAddress, getContractAddress, keccak256, encodeFunctionData, hexToBytes, parseAbi, sha256, stringToHex, type Hex } from 'viem';
import type { Dependencies, SimulationRequest, SimulationResult } from './types.ts';
import { decodeRevert } from './simulation.ts';
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
const FAILED_OP = '0x220266b6', FAILED_OP_WITH_REVERT = '0x65c8fd4d';
/** The simulated bundler (simulateHandleOp doesn't check its caller; some paymasters check tx.origin, see recentBundler). */
const BUNDLER = '0x0000000000000000000000000000000000004337';

/**
 * Bundlers that recently submitted operations this paymaster paid for (the latest first, at most three): paymasters
 * that only accept certain bundlers (tx.origin) refuse any other, which says nothing about the operation itself.
 * Looks back 1,000 blocks, then 20,000 (minutes on Arbitrum) if that finds none.
 */
async function recentBundlers(deps: Dependencies, chainId: number, entryPoint: string, paymaster: string): Promise<string[]> {
  const rpc = deps.rpc;
  if (!rpc?.has(chainId)) return [];
  try {
    const head = BigInt(String(await rpc.call(chainId, 'eth_blockNumber', [])));
    for (const span of [1000n, 20_000n]) {
      let logs: { transactionHash: string }[];
      try { logs = await rpc.call(chainId, 'eth_getLogs', [{ address: entryPoint, topics: [USER_OPERATION_EVENT, null, null, `0x${'00'.repeat(12)}${paymaster.slice(2).toLowerCase()}`], fromBlock: `0x${(head > span ? head - span : 0n).toString(16)}`, toBlock: `0x${head.toString(16)}` }]) as { transactionHash: string }[]; } catch { continue; }
      const hashes = [...new Set((logs ?? []).map(l => l.transactionHash).reverse())].slice(0, 6);
      if (!hashes.length) continue;
      const txs = await Promise.all(hashes.map(h => rpc.call(chainId, 'eth_getTransactionByHash', [h]).catch(() => null) as Promise<{ from?: string } | null>));
      return [...new Set(txs.map(t => t?.from?.toLowerCase()).filter((f): f is string => !!f))].slice(0, 3);
    }
  } catch { /* none */ }
  return [];
}

/**
 * A stand-in for the owner's ECDSA signature: well-formed (low s, v 28, r a valid curve point), so it recovers to
 * some address and an account's check fails rather than reverting. Bundlers use the same one to estimate gas.
 */
export const STUB_SIGNATURE = '0xfffffffffffffffffffffffffffffff0000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c' as Hex;
/** A second stand-in signature, for an account that needs another key's signature too (a cosigner's). */
export const STUB_COSIGNATURE = `0x${STUB_SIGNATURE.slice(2, 65)}1${STUB_SIGNATURE.slice(66)}` as Hex;

/**
 * A stand-in signature; `p256` when it is a passkey's, which P256VERIFY (0x100) must accept too (see standIn), or
 * `'daimo'` when the account verifies it with Daimo's P256 verifier contract instead. `cosigners`: other stand-in
 * ECDSA signatures in it and whose they are (ecrecover recovers each as its signer).
 */
interface Stub { signature: Hex; p256?: boolean | 'daimo'; cosigners?: { signature: Hex; signer: string }[] }
type StubContext = {
  deps: Dependencies; chainId: number; sender: string; signer: string; nonce: bigint;
  /** The operation's hash as the EntryPoint computes it (getUserOpHash): a passkey signs it as its challenge. */
  hash: () => Promise<Hex | undefined>;
};
const OWNERS = parseAbi(['function nextOwnerIndex() view returns (uint256)', 'function ownerAtIndex(uint256 index) view returns (bytes)']);

/** The stand-in r and s of a passkey's P256 signature (s in the lower half, as WebAuthn verifiers require). */
export const P256_STUB = { r: `0x${'5a'.repeat(32)}` as Hex, s: `0x${'25'.repeat(32)}` as Hex };
const base64url = (hex: Hex) => {
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
  const clientDataJSON = `{"type":"webauthn.get","challenge":"${base64url(hash)}","origin":"https://keys.coinbase.com","crossOrigin":false}`;
  const authenticatorData = concatHex([sha256(stringToHex('keys.coinbase.com')), '0x05', '0x00000000']);
  return encodeAbiParameters([{ type: 'tuple', components: [{ name: 'authenticatorData', type: 'bytes' }, { name: 'clientDataJSON', type: 'string' }, { name: 'challengeIndex', type: 'uint256' }, { name: 'typeIndex', type: 'uint256' }, { name: 'r', type: 'uint256' }, { name: 's', type: 'uint256' }] }],
    [{ authenticatorData, clientDataJSON, challengeIndex: BigInt(clientDataJSON.indexOf('"challenge"')), typeIndex: BigInt(clientDataJSON.indexOf('"type"')), r: BigInt(P256_STUB.r), s: BigInt(P256_STUB.s) }]);
}
/** Daimo's P256 verifier contract (the same address on every chain here), which passkey accounts call without RIP-7212. */
export const DAIMO_P256_VERIFIER = '0xc2b78104907f722dabac4c69f826a522b2754de4';
/** ZeroDev's WebAuthn validator for Kernel v3 (source verified on Sourcify, Arbitrum One). */
const ZERODEV_WEBAUTHN_VALIDATORS = new Set(['0x7ab16ff354acb328452f1d445b3ddee9a91e9e69']);
/** Chains here on which ZeroDev's SDK signs with the P256 precompile (its isRIP7212SupportedNetwork). */
const ZERODEV_PRECOMPILED = new Set([1, 42161]);
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
 * cosigner() names that key: Bleap's CosigningModuleV2 (source verified on Sourcify, Base; the same address on
 * Arbitrum One).
 */
const COSIGNING_SIGNERS = new Set(['0x5b424d5133fae2ce64ce739cec0796343e957131']);
const COSIGNER = parseAbi(['function cosigner() view returns (address)']);
/**
 * ZeroDev Kernel v3.1, by how it validates: what its nonce names (byte 1 the validation type: 0x00 its root
 * validation, 0x01 the validator in bytes 2-21, 0x02 the permission in bytes 2-5), the root read from
 * rootValidator(), which has the same type byte. A passkey's validator (ZeroDev's WebAuthn validator) gets a
 * passkey's assertion; a permission whose signer takes a cosignature, 0xff (the signer's part) and the owner's and
 * the cosigner's stand-ins; anything else, the ECDSA stand-in as it is or after a 0xff byte (both
 * seen on-chain for the same implementation, by how each account is set up; checked: 0xff + signature validates as
 * signed by its owner).
 */
async function kernelV3Stub(c: StubContext): Promise<Stub[]> {
  const ecdsa: Stub[] = [{ signature: STUB_SIGNATURE }, { signature: `0xff${STUB_SIGNATURE.slice(2)}` as Hex }];
  const rpc = c.deps.rpc?.has(c.chainId) ? c.deps.rpc : undefined;
  const view = async (data: Hex) => rpc ? String(await rpc.call(c.chainId, 'eth_call', [{ to: c.sender, data }, 'latest'])) as Hex : undefined;
  // What validates: [type, id] from the nonce, or from rootValidator() for the root (a bytes21, left-aligned).
  const nonce = c.nonce.toString(16).padStart(64, '0');
  let type = nonce.slice(2, 4), id = nonce.slice(4, 44);
  if (type === '00') {
    try {
      const root = await view(encodeFunctionData({ abi: KERNEL, functionName: 'rootValidator' }));
      if (!root || !/^0x[0-9a-f]{64}$/i.test(root)) return ecdsa;
      type = root.slice(2, 4); id = root.slice(4, 44);
    } catch { return ecdsa; }
  }
  if (type === '01' && ZERODEV_WEBAUTHN_VALIDATORS.has(`0x${id}`.toLowerCase())) {
    const hash = await c.hash();
    if (!hash) return ecdsa;
    const precompiled = ZERODEV_PRECOMPILED.has(c.chainId);
    return [{ signature: zeroDevWebAuthnStub(hash, precompiled), p256: precompiled || 'daimo' }];
  }
  if (type === '02' && rpc) {
    try {
      const out = await view(encodeFunctionData({ abi: KERNEL, functionName: 'permissionConfig', args: [`0x${id.slice(0, 8)}`] }));
      const config = out && decodeFunctionResult({ abi: KERNEL, functionName: 'permissionConfig', data: out });
      // Policies before the signer each read their own part of the signature, tagged with their index; one that
      // starts with 0xff (the signer's) gives every policy an empty part, as these wallets' signatures do.
      if (config && COSIGNING_SIGNERS.has(config.signer.toLowerCase())) {
        const cosigner = String(await rpc.call(c.chainId, 'eth_call', [{ to: config.signer, data: encodeFunctionData({ abi: COSIGNER, functionName: 'cosigner' }) }, 'latest']));
        if (/^0x0{24}[0-9a-f]{40}$/i.test(cosigner) && !/^0x0+$/.test(cosigner)) {
          return [{ signature: `0xff${STUB_SIGNATURE.slice(2)}${STUB_COSIGNATURE.slice(2)}` as Hex, cosigners: [{ signature: STUB_COSIGNATURE, signer: `0x${cosigner.slice(26)}`.toLowerCase() }] }];
        }
      }
    } catch { /* not readable: the ECDSA forms */ }
  }
  return ecdsa;
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
/** Stand-ins for accounts a factory is deploying in the operation, by factory (their code doesn't exist yet). */
const FACTORY_STUBS: Record<string, (c: StubContext, factoryData: Hex) => Promise<Stub>> = {
  // Coinbase Smart Wallet's factories (v1 and v1.1).
  '0x0ba5ed0c6aa8c49038f819e587e2633c4a9f428a': coinbaseDeployStub, '0xba5ed110efdba3d005bfc882d75358acbbb85842': coinbaseDeployStub,
  // Alchemy's Modular Account v2 factory: createAccount (a ModularAccount with its single-signer validation) and
  // createSemiModularAccount sign in Modular Account v2's 0xff00 form (its verified source); a WebAuthn account isn't
  // given a passkey's here.
  '0x00000000000017c61b5bee81050ec8efc9c6fecd': async (_c, factoryData) => ['0xafa63a10', '0x8b4e464e'].includes(factoryData.slice(0, 10)) ? shaped('0xff00')() : { signature: STUB_SIGNATURE },
};

const shaped = (prefix: string) => (): Stub => ({ signature: `${prefix}${STUB_SIGNATURE.slice(2)}` as Hex });
/**
 * Stand-ins shaped for accounts that wrap their owner's signature, by the code the account runs (its EIP-7702
 * delegate or ERC-1967 implementation). Others get STUB_SIGNATURE as is, unless the wallet supplies its own stub.
 */
const STUB_SHAPES: Record<string, (c: StubContext) => Stub | Stub[] | Promise<Stub | Stub[]>> = {
  // Alchemy's Modular Account v2 for EIP-7702: its fallback validation (0xff), an EOA signature (0x00), the signature.
  '0x69007702764179f14f51cdce752f4f775d74e139': shaped('0xff00'),
  // An EIP-7702 delegate whose operations on Ethereum carry the same 0xff00 prefix (checked: it validates the shape).
  '0x77021100bd87b7008e5e1989d0eb38555d0d0000': shaped('0xff00'),
  // Account implementations (ERC-1967) with the same 0xff00 prefix (Modular Account v2's own shape), on Ethereum and
  // on Arbitrum (checked there: it validates the shape as signed by its owner).
  '0x000000000000c5a9089039570dd36455b5c07383': shaped('0xff00'), '0x00000000000002377b26b1eda7b0bc371c60dd4f': shaped('0xff00'),
  // ZeroDev Kernel v2.4 and v2.3: validation mode 0x00000000 (its default validator, the owner's ECDSA), then the
  // signature (checked on v2.3: it validates the shape as signed by its owner).
  '0xd3082872f8b06073a021b4602e022d5a070d7cfc': shaped('0x00000000'), '0xd3f582f6b4814e989ee8e96bc3175320b5a540ab': shaped('0x00000000'),
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
  '0x000100abaad02f1cfc8bbe32bd5a564817339e72': coinbaseStub, '0x00000110dcdedc9581cb5ecb8467282f2926534d': coinbaseStub,
  // ZeroDev Kernel v3.1: by its validator (see kernelV3Stub).
  '0xbac849bb641841b44e965fb01a4bf5f074f84b4d': kernelV3Stub,
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
async function stubFor(c: StubContext, delegate?: string, initCode?: Hex): Promise<Stub[]> {
  const factory = initCode && initCode.length >= 42 ? `0x${initCode.slice(2, 42)}`.toLowerCase() : undefined;
  if (factory && FACTORY_STUBS[factory]) return [await FACTORY_STUBS[factory](c, `0x${initCode!.slice(42)}`)];
  const runs = delegate?.toLowerCase() ?? await implementationOf(c.deps, c.chainId, c.sender);
  const shape = runs ? STUB_SHAPES[runs] : undefined;
  return shape ? [await shape(c)].flat() : [{ signature: STUB_SIGNATURE }];
}

/** Where the real ecrecover and P256VERIFY move while their stand-ins take their addresses. */
const ECRECOVER_MOVED = '0x0000000000000000000000000000000000ec0001', P256_MOVED = '0x0000000000000000000000000000000000ec0100', DAIMO_MOVED = '0x0000000000000000000000000000000000ec0da1';
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
 * costs exactly the precompile's 3,000 gas: instead of calling the real precompile it burns a fixed amount (a
 * counted loop of 26 gas a turn, then 1-gas JUMPDESTs), so validation uses the gas it will. Other signatures go to
 * the real precompile, for about 200 gas more than calling it directly.
 *   if (calldata[64:96] == r && calldata[96:128] == s [&& calldata[0:32] == digest]) { burn; return signer }
 *   calldatacopy(0, 0, calldatasize); staticcall(gas, MOVED, 0, calldatasize, 0, 32); return its output
 * With `cosigners`, each of their stand-in signatures is recovered as its signer the same way, also for 3,000 gas.
 */
export function ecrecoverAs(signer: string, digest?: Hex, cosigners: { signature: Hex; signer: string }[] = []): Hex {
  if (cosigners.length) return ecrecoverAsMany([{ signature: STUB_SIGNATURE, signer }, ...cosigners], digest);
  const r = STUB_SIGNATURE.slice(2, 66), s = STUB_SIGNATURE.slice(66, 130);
  // The stand-in's path: 59 gas of its own (the checks, the jump, and returning a word; 74 with the digest's check), and the burn.
  const burn = 3000 - (digest ? 74 : 59), turns = Math.floor((burn - 5) / 26), sled = burn - 5 - 26 * turns;
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
 * ecrecoverAs for several stand-in signatures, each recovered as its own signer: the checks in turn (each jumping to
 * its signature's burn and answer), then the real precompile for anything else. The k-th signature's path runs k + 1
 * checks before its jump, and burns what makes it exactly 3,000 gas too.
 */
function ecrecoverAsMany(pairs: { signature: Hex; signer: string }[], digest?: Hex): Hex {
  const hex2 = (n: number) => n.toString(16).padStart(4, '0');
  // Each check: r, s (and the digest), then PUSH2 dest JUMPI: 40 gas (55 with the digest); the answer, 19.
  const checkGas = digest ? 55 : 40;
  const checks = pairs.map(p => `7f${p.signature.slice(2, 66)}60403514` + `7f${p.signature.slice(66, 130)}6060351416` + (digest ? `7f${digest.slice(2)}60003514${'16'}` : ''));
  const forward = `366000600037` + `6020600036600073${ECRECOVER_MOVED.slice(2)}5afa50` + `3d6000f3`;
  const head = checks.reduce((n, c) => n + c.length / 2 + 4, 0) + forward.length / 2; // each check, then 61 xxxx 57
  const sections: string[] = [];
  const dests: number[] = [];
  let at = head;
  pairs.forEach((p, k) => {
    const burn = 3000 - ((k + 1) * checkGas + 19), turns = Math.floor((burn - 5) / 26), sled = burn - 5 - 26 * turns;
    const loop = at + 1 + 3;
    const section = `5b61${hex2(turns)}5b600190038061${hex2(loop)}5750${'5b'.repeat(sled)}` + `73${p.signer.toLowerCase().slice(2)}60005260206000f3`;
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
export function ecdsaStandIn(signer: string, digest?: Hex): Pick<SimulationRequest, 'stateOverrides' | 'accessList'> {
  return {
    stateOverrides: { '0x0000000000000000000000000000000000000001': { code: ecrecoverAs(signer, digest), movePrecompileToAddress: ECRECOVER_MOVED } },
    accessList: [{ address: '0x0000000000000000000000000000000000000001', storageKeys: [] }, { address: ECRECOVER_MOVED, storageKeys: [] }],
  };
}
/** P256VERIFY (0x100, RIP-7212 / EIP-7951) accepting P256_STUB: a passkey's assertion (see webAuthnStub) verifies. */
export const p256Accepting = (): Hex => standIn(P256_MOVED, P256_STUB.r, P256_STUB.s, 0x20, '6001');
/**
 * Daimo's verifier accepting P256_STUB: its code moves to DAIMO_MOVED and this takes its address. Every input still
 * runs through the real code first (the stub's verification costs what a real one does, and fails), then the stub
 * is answered 1; anything else gets the real answer.
 */
export const daimoAccepting = (): Hex => standIn(DAIMO_MOVED, P256_STUB.r, P256_STUB.s, 0x20, '6001');

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
  /**
   * The digest the signer's wallet will sign (the personal_sign form of the operation's hash, or the hash itself):
   * the stand-in recovers only over it, unless the account rejects it then (it signs some other form).
   */
  digest?: Hex;
  /** EIP-7702: the delegate the account will have when the operation runs, if it doesn't have it yet. */
  delegate?: string;
  watch?: string[];
  /** Calls to simulate right after the operation, in the same block (e.g. reading what it changed). */
  after?: SimulationRequest[];
  /** More state for the simulation (e.g. a Safe's approvals standing in for its owners' signatures). */
  stateOverrides?: SimulationRequest['stateOverrides'];
}

/**
 * What validation returned: a signature failure, an aggregator, and the range it's valid in: seconds (0 = no end),
 * or from EntryPoint v0.9, block numbers when both bounds carry its flag (bit 47).
 */
export interface Validity { signatureFailed: boolean; aggregator: string | null; validAfter: number; validUntil: number; blocks?: boolean }
const BLOCK_RANGE_FLAG = 1n << 47n;

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
  /** What stood in for the signature: the wallet's own stub, an ECDSA stand-in, or a passkey's (WebAuthn) stand-in. */
  standIn?: 'wallet' | 'ecdsa' | 'passkey';
  /** The `after` calls' results. */
  after?: SimulationResult[];
}

export function validity(data: bigint): Validity {
  const low = data & ((1n << 160n) - 1n);
  const until = (data >> 160n) & ((1n << 48n) - 1n), after = data >> 208n;
  const blocks = until >= BLOCK_RANGE_FLAG && after >= BLOCK_RANGE_FLAG;
  return { signatureFailed: low === 1n, aggregator: low > 1n ? `0x${low.toString(16).padStart(40, '0')}` : null,
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
  const stubs: Stub[] = op.signature && op.signature !== '0x' ? [{ signature: op.signature }] : await stubFor({ deps, chainId: op.chainId, sender, signer, nonce: op.nonce, hash }, op.delegate, op.initCode);
  const fee = await baseFee(deps, op.chainId);
  // Each candidate shape in turn, until the account accepts one (validation neither reverts nor fails).
  let result: OperationRun | null = null;
  for (const stub of stubs) {
    result = await withStub(stub);
    if (result && !result.account?.signatureFailed && !result.rejected?.startsWith('AA23')) break;
  }
  return result;

  async function withStub(stub: Stub): Promise<OperationRun | null> {
  // Daimo's verifier, moved to make room for its stand-in: its code is the chain's own.
  let daimo: Hex | undefined;
  if (stub.p256 === 'daimo') {
    try { daimo = deps.rpc?.has(op.chainId) ? String(await deps.rpc.call(op.chainId, 'eth_getCode', [DAIMO_P256_VERIFIER, 'latest'])) as Hex : undefined; } catch { daimo = undefined; }
    if (!daimo || daimo === '0x') return null;
  }
  const data = ep!.version === '0.6'
    ? encodeFunctionData({ abi: HANDLE_V06, functionName: 'simulateHandleOp', args: [fields(stub.signature) as never, `0x${'00'.repeat(20)}`, '0x'] })
    : encodeFunctionData({ abi: HANDLE, functionName: 'simulateHandleOp', args: [fields(stub.signature) as never, `0x${'00'.repeat(20)}`, '0x'] }); // v0.7 to v0.9: packed
  const run = (bundler: string, recover: Hex) => runOperation(op, sim!, { chainId: op.chainId, from: bundler, account: sender, to: entryPoint, data, value: 0n, ...(fee !== undefined && { baseFee: fee }), ...(op.watch?.length && { watch: op.watch }),
    // The moved precompile is warm, as precompiles are (EIP-2929), so validation costs what it will.
    // An account the bundle delegates (EIP-7702) is warm from its authorization on, as the chain has it.
    accessList: [{ address: '0x0000000000000000000000000000000000000001', storageKeys: [] }, { address: ECRECOVER_MOVED, storageKeys: [] },
      ...(op.delegate ? [{ address: sender, storageKeys: [] }] : []),
      ...(stub.p256 === true ? [{ address: '0x0000000000000000000000000000000000000100', storageKeys: [] }, { address: P256_MOVED, storageKeys: [] }] : []),
      // The verifier itself stays cold, as it is on-chain; only the call on to its moved code is warm.
      ...(daimo ? [{ address: DAIMO_MOVED, storageKeys: [] }] : [])],
    stateOverrides: { ...op.stateOverrides, [entryPoint]: { ...entryPointOverride(entryPoint, op.chainId)!, ...(op.stateOverrides?.[entryPoint]?.stateDiff && { stateDiff: { ...entryPointOverride(entryPoint, op.chainId)!.stateDiff, ...op.stateOverrides[entryPoint].stateDiff } }) }, '0x0000000000000000000000000000000000000001': { code: recover, movePrecompileToAddress: ECRECOVER_MOVED },
      ...(stub.p256 === true && { '0x0000000000000000000000000000000000000100': { code: p256Accepting(), movePrecompileToAddress: P256_MOVED } }),
      ...(daimo && { [DAIMO_P256_VERIFIER]: { code: daimoAccepting() }, [DAIMO_MOVED]: { code: daimo } }),
      ...(op.delegate && { [sender]: { code: `0xef0100${op.delegate.toLowerCase().slice(2)}` } }) } }, ep!.version);
  const standIn = op.signature && op.signature !== '0x' ? 'wallet' as const : stub.p256 ? 'passkey' as const : 'ecdsa' as const;
  const attempt = async (recover: Hex) => {
    const first = await run(BUNDLER, recover);
    // The paymaster refused: once more as a bundler it accepted lately, in case it only refused this one.
    const paymaster = op.paymasterAndData.length >= 42 ? `0x${op.paymasterAndData.slice(2, 42)}` : null;
    if (paymaster && first?.rejected?.startsWith('AA33')) {
      for (const bundler of await recentBundlers(deps, op.chainId, entryPoint, paymaster)) {
        const again = await run(bundler, recover);
        if (again && !again.rejected?.startsWith('AA33')) return again;
      }
    }
    return first;
  };
  // Over the digest the wallet will sign first; if the account checks another form of the hash, over any.
  let result = op.digest && standIn === 'ecdsa' ? await attempt(ecrecoverAs(signer, op.digest, stub.cosigners)) : null;
  if (!result || result.account?.signatureFailed || result.rejected?.startsWith('AA23')) result = await attempt(ecrecoverAs(signer, undefined, stub.cosigners));
  return result && { ...result, standIn };
  }
}

async function runOperation(op: OperationInput, sim: NonNullable<Dependencies['simulator']>, req: SimulationRequest, version: '0.6' | '0.7' | '0.8' | '0.9'): Promise<OperationRun | null> {
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
  const paymaster = op.paymasterAndData.length >= 42 && !/^0x0{40}/.test(op.paymasterAndData); // address 0 is none
  return { result: { ...r, transfers }, executed: success, ...(revertReason && { revertReason }), ...(postOpReverted && { postOpReverted }),
    paid, gasUsed: actualGasUsed, account: validity(accountData), ...(paymaster && { paymaster: validity(paymasterData) }), ...(results!.length > 1 && { after: results!.slice(1) as SimulationResult[] }) };
}
