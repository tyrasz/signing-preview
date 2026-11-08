// UserOperations for EntryPoint v0.6 and v0.7, which smart accounts sign as a bare 32-byte hash (personal_sign of
// getUserOpHash): the message says nothing about what the operation does. The wallet (or SDK) holding the operation
// supplies it as context.userOperation; it is hashed exactly as the EntryPoint hashes it, and decoded only when that
// is the hash being signed. Anything else is shown as the opaque message it is, with a danger.
import { encodeAbiParameters, keccak256, type Hex } from 'viem';
import { attentionOf, PreviewBuilder, shortAddress } from './format.ts';
import { previewMessage } from './message.ts';
import { describeOperation, paymasterOf } from './typed-data/user-operation.ts';
import type { Dependencies, Preview, PreviewContext } from './types.ts';

/** EntryPoints whose operations are signed as getUserOpHash, at the same address on every chain (checked on Ethereum, Arbitrum One and HyperEVM). */
export const HASH_ENTRY_POINTS: Record<string, { name: string; version: '0.6' | '0.7' }> = {
  '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789': { name: 'EntryPoint v0.6', version: '0.6' },
  '0x0000000071727de22e5e9d8baf0edac6f37da032': { name: 'EntryPoint v0.7', version: '0.7' },
};

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const bytes = (v: unknown): Hex | null => typeof v === 'string' && /^0x([0-9a-fA-F]{2})*$/.test(v) ? v.toLowerCase() as Hex : v === undefined || v === null ? '0x' : null;
const int = (v: unknown): bigint | null => {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === 'string' && /^(0x[0-9a-fA-F]+|[0-9]+)$/.test(v)) return BigInt(v);
  return v === undefined || v === null ? 0n : null;
};
const word = (v: bigint) => v.toString(16).padStart(32, '0');

/** The operation's fields in the EntryPoint's own form (v0.7 packed, as the contract hashes it). */
export interface HashedOperation {
  sender: string; nonce: bigint; initCode: Hex; callData: Hex; callGasLimit: bigint; verificationGasLimit: bigint;
  preVerificationGas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; paymasterAndData: Hex;
}

/**
 * Reads an operation as bundlers' RPC carries it: v0.6 fields, or v0.7's (factory/factoryData and paymaster fields
 * unpacked, as viem and ERC-7769 give them; the packed initCode/accountGasLimits/gasFees/paymasterAndData also work).
 */
export function readOperation(raw: Record<string, unknown>, version: '0.6' | '0.7'): HashedOperation | null {
  const sender = typeof raw.sender === 'string' && ADDRESS.test(raw.sender) ? raw.sender.toLowerCase() : null;
  const nonce = int(raw.nonce), callData = bytes(raw.callData), preVerificationGas = int(raw.preVerificationGas);
  if (!sender || nonce === null || callData === null || preVerificationGas === null) return null;
  let callGasLimit = int(raw.callGasLimit), verificationGasLimit = int(raw.verificationGasLimit), maxFeePerGas = int(raw.maxFeePerGas), maxPriorityFeePerGas = int(raw.maxPriorityFeePerGas);
  let initCode = bytes(raw.initCode), paymasterAndData = bytes(raw.paymasterAndData);
  if (version === '0.7') {
    const packed = (v: unknown): [bigint, bigint] | null => typeof v === 'string' && HASH.test(v) ? [BigInt(`0x${v.slice(2, 34)}`), BigInt(`0x${v.slice(34)}`)] : null;
    const limits = packed(raw.accountGasLimits), fees = packed(raw.gasFees);
    if (limits) [verificationGasLimit, callGasLimit] = limits;
    if (fees) [maxPriorityFeePerGas, maxFeePerGas] = fees;
    if (typeof raw.factory === 'string' && ADDRESS.test(raw.factory)) {
      const data = bytes(raw.factoryData);
      initCode = data === null ? null : `0x${raw.factory.slice(2).toLowerCase()}${data.slice(2)}` as Hex;
    }
    if (typeof raw.paymaster === 'string' && ADDRESS.test(raw.paymaster)) {
      const v = int(raw.paymasterVerificationGasLimit), p = int(raw.paymasterPostOpGasLimit), data = bytes(raw.paymasterData);
      paymasterAndData = v === null || p === null || data === null ? null : `0x${raw.paymaster.slice(2).toLowerCase()}${word(v)}${word(p)}${data.slice(2)}` as Hex;
    }
  }
  if (callGasLimit === null || verificationGasLimit === null || maxFeePerGas === null || maxPriorityFeePerGas === null || initCode === null || paymasterAndData === null) return null;
  return { sender, nonce, initCode, callData, callGasLimit, verificationGasLimit, preVerificationGas, maxFeePerGas, maxPriorityFeePerGas, paymasterAndData };
}

/** getUserOpHash: keccak256(abi.encode(keccak256(pack(op)), entryPoint, chainId)), with each version's packing. */
export function userOpHash(op: HashedOperation, entryPoint: string, chainId: number, version: '0.6' | '0.7'): Hex {
  const h = keccak256;
  const inner = version === '0.6'
    ? encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' }],
      [op.sender as Hex, op.nonce, h(op.initCode), h(op.callData), op.callGasLimit, op.verificationGasLimit, op.preVerificationGas, op.maxFeePerGas, op.maxPriorityFeePerGas, h(op.paymasterAndData)])
    : encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'bytes32' }],
      [op.sender as Hex, op.nonce, h(op.initCode), h(op.callData), `0x${word(op.verificationGasLimit)}${word(op.callGasLimit)}`, op.preVerificationGas, `0x${word(op.maxPriorityFeePerGas)}${word(op.maxFeePerGas)}`, h(op.paymasterAndData)]);
  return h(encodeAbiParameters([{ type: 'bytes32' }, { type: 'address' }, { type: 'uint256' }], [h(inner), entryPoint as Hex, BigInt(chainId)]));
}

/**
 * personal_sign / eth_sign of a 32-byte hash, with the operation supplied in context.userOperation. Returns null when
 * the request isn't that, so the caller previews it as a plain message.
 */
export async function previewSignedOperation(method: string, params: unknown[], context: PreviewContext, deps: Dependencies): Promise<Preview | null> {
  const supplied = context.userOperation;
  if (!supplied) return null;
  // personal_sign is [message, address] (some dApps reverse it); eth_sign is [address, hash].
  let [message, address] = (method === 'eth_sign' ? [params[1], params[0]] : params) as [unknown, unknown];
  if (method !== 'eth_sign' && typeof message === 'string' && ADDRESS.test(message) && !(typeof address === 'string' && ADDRESS.test(address))) [message, address] = [address, message];
  if (typeof message !== 'string' || !HASH.test(message)) return null;
  const signer = typeof address === 'string' && ADDRESS.test(address) ? address.toLowerCase() : null;
  const entryPoint = supplied.entryPoint.toLowerCase();
  const ep = HASH_ENTRY_POINTS[entryPoint];
  const chainId = supplied.chainId ?? context.chainId ?? null;
  const op = ep ? readOperation(supplied.operation, ep.version) : null;
  const expected = op && ep && chainId !== null ? userOpHash(op, entryPoint, chainId, ep.version) : null;
  if (!expected || expected !== message.toLowerCase()) {
    const p = previewMessage(method, params, context);
    const why = !ep ? `${shortAddress(entryPoint)} is not EntryPoint v0.6 or v0.7, whose operations are signed as a hash`
      : !op ? 'the operation supplied with it is malformed' : chainId === null ? 'no chain ID was given to hash the operation with'
      : `it is not the hash of the operation supplied with it (that is ${expected})`;
    const severity = expected ? 'danger' as const : 'caution' as const;
    p.warnings.push({ severity, code: 'userop_hash_mismatch', message: `This message can't be checked as a UserOperation: ${why}. What you would sign may not be what the app shows.` });
    return { ...p, attention: attentionOf(p.warnings) };
  }
  const env = { deps, context, signer, now: context.now ?? Date.now() };
  const pm = paymasterOf(op!.paymasterAndData, ep!.version === '0.7');
  const b = new PreviewBuilder();
  const d = await describeOperation({
    chainId, entryPoint, entryPointName: ep!.name, sender: op!.sender, nonce: op!.nonce, initCode: op!.initCode, callData: op!.callData === '0x' ? null : op!.callData, paymaster: pm.paymaster,
    gas: { verification: op!.verificationGasLimit, call: op!.callGasLimit, preVerification: op!.preVerificationGas, maxFee: op!.maxFeePerGas, maxPriority: op!.maxPriorityFeePerGas, ...pm, v06: ep!.version === '0.6' },
    userOpHash: expected, paymasterAndData: op!.paymasterAndData,
    // A signature the wallet supplies with the operation (its stub for this account) is what simulation validates with.
    ...(typeof supplied.operation.signature === 'string' && /^0x([0-9a-fA-F]{2})+$/.test(supplied.operation.signature) && { signature: supplied.operation.signature.toLowerCase() as Hex }),
    ...(ep!.version === '0.7' && { packed: { nonce: op!.nonce, initCode: op!.initCode, accountGasLimits: `0x${word(op!.verificationGasLimit)}${word(op!.callGasLimit)}` as Hex, preVerificationGas: op!.preVerificationGas, gasFees: `0x${word(op!.maxPriorityFeePerGas)}${word(op!.maxFeePerGas)}` as Hex, paymasterAndData: op!.paymasterAndData } }),
  }, env, b);
  b.detail('UserOperation hash', expected, expected);
  b.note(`The message is this operation's hash, as ${ep!.name} computes it (getUserOpHash), so the signature authorizes exactly this operation.`);
  if (method === 'eth_sign') b.warn('info', 'eth_sign_userop', 'eth_sign signs raw data; here that data is the hash of the UserOperation shown, which some accounts verify without the personal_sign prefix.');
  if (signer && context.account && signer !== context.account.toLowerCase()) b.warn('danger', 'signer_mismatch', `The request asks ${signer} to sign, but the connected account is ${context.account}.`);
  return {
    schema: 'signing-preview/1', method, kind: 'message', network: d.network,
    title: d.title, summary: d.summary, details: b.details, assetChanges: d.assetChanges ?? [], warnings: b.warnings, attention: attentionOf(b.warnings),
    decoding: { status: d.status, decoder: 'erc4337_user_operation_hash', notes: b.notes },
  };
}
