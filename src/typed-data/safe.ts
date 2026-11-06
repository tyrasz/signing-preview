// Safe multisig owner signatures: EIP-712 SafeTx (domain: the chain and the Safe itself), SafeMessage, and SafeOp
// (ERC-4337 operations through Safe's 4337 module). See src/safe.ts.
import { decodeAbiParameters, hexToBytes, type Hex } from 'viem';
import { formatTimestamp, PreviewBuilder, sameAddress, shortAddress } from '../format.ts';
import { chainName } from '../chains.ts';
import { describeSafeTx, type SafeExecution } from '../safe.ts';
import { simulateExecution } from '../erc4337-sim.ts';
import { netChanges } from '../evm/effects.ts';
import { simulationNote } from '../evm/transaction.ts';
import type { AssetChange, SimulationResult } from '../types.ts';
import { decodeTransaction } from '../evm/transaction.ts';
import { gasDetails, nonceCheck, paymasterOf } from './user-operation.ts';
import { big, domainChainId, str, type TypedAdapter, type TypedEnv } from './common.ts';

const ZERO = '0x0000000000000000000000000000000000000000';

export const safeTxAdapter: TypedAdapter = async (data, env) => {
  if (data.primaryType === 'SafeMessage') return safeMessage(data, env);
  if (data.primaryType === 'SafeOp') return safeOp(data, env);
  if (data.primaryType !== 'SafeTx') return null;
  const m = data.message;
  const safe = str(data.domain.verifyingContract).toLowerCase();
  const chainId = domainChainId(data) ?? env.context.chainId ?? null;
  const value = big(m.value), safeTxGas = big(m.safeTxGas) ?? 0n, baseGas = big(m.baseGas ?? m.dataGas) ?? 0n, gasPrice = big(m.gasPrice) ?? 0n, operation = Number(big(m.operation) ?? 0n), nonce = big(m.nonce) ?? undefined;
  if (!/^0x[0-9a-f]{40}$/.test(safe) || chainId === null || value === null) return null;
  const b = new PreviewBuilder();
  const r = await describeSafeTx({ safe, to: str(m.to), value, data: (str(m.data) || '0x') as `0x${string}`, operation, safeTxGas, baseGas, gasPrice, gasToken: str(m.gasToken) || '0x0000000000000000000000000000000000000000', refundReceiver: str(m.refundReceiver) || '0x0000000000000000000000000000000000000000', nonce },
    chainId, { deps: env.deps, context: env.context }, b);
  // Is the signer an owner, and is this the Safe's next transaction?
  const rpc = env.deps.rpc;
  if (rpc?.has(chainId)) {
    try {
      const current = BigInt(String(await rpc.call(chainId, 'eth_call', [{ to: safe, data: '0xaffed0e0' }, 'latest'])));
      if (nonce !== undefined && nonce < current) b.warn('info', 'safe_nonce_used', `The Safe's nonce is already ${current}: a transaction with nonce ${nonce} has been executed, so this one can't be.`);
      else if (nonce !== undefined && nonce > current) b.note(`${nonce - current} other Safe transaction${nonce - current === 1n ? '' : 's'} must run before this one (the Safe is at nonce ${current}).`);
      await ownerCheck(safe, chainId, env, b);
    } catch { /* not a readable Safe */ }
  }
  b.note('This is an off-chain owner signature; it costs no gas. Once enough owners have signed, anyone can execute the transaction.');
  return { title: `Safe transaction: ${r.title}`, summary: r.summary, decoder: 'safe_tx', status: r.status, b, network: { kind: 'evm', chainId, name: chainName(chainId) }, assetChanges: r.assetChanges };
};

/**
 * A SafeMessage: an owner's approval of a message in the Safe's name (once enough owners sign, the Safe's ERC-1271
 * isValidSignature accepts it). The message is usually the hash of what the Safe is signing, which can't be read back.
 */
const safeMessage: TypedAdapter = async (data, env) => {
  const safe = str(data.domain.verifyingContract).toLowerCase();
  const chainId = domainChainId(data) ?? env.context.chainId ?? null;
  const raw = str((data.message as Record<string, unknown>).message);
  if (!/^0x[0-9a-f]{40}$/.test(safe)) return null;
  const b = new PreviewBuilder().detail('Safe', safe, safe);
  const hex = /^0x([0-9a-fA-F]{2})*$/.test(raw) ? raw : null;
  let text: string | null = null;
  // Text, when the bytes are UTF-8 with no control characters (as message.ts reads personal_sign messages).
  if (hex && hex.length !== 66 && hex.length > 2) { try { const t = new TextDecoder('utf-8', { fatal: true }).decode(hexToBytes(hex as `0x${string}`)); if (!/[\u0000-\u0008\u000e-\u001f\u007f]/.test(t)) text = t; } catch { /* not text */ } }
  b.detail(text ? 'Message' : hex?.length === 66 ? 'Message hash' : 'Message', text ?? raw);
  b.warn('info', 'safe_sign_message', `Once enough owners sign this, contracts that check the Safe's signature (ERC-1271) accept the message as signed by the Safe ${shortAddress(safe)}.`);
  if (hex?.length === 66) b.note("The message is a 32-byte hash, so what the Safe is signing can't be read from it: check it in the app that asked.");
  return { title: `Sign a message as the Safe ${shortAddress(safe)}`, summary: 'Approves a message in the Safe\'s name (ERC-1271), as one of its owners.', decoder: 'safe_message', status: text ? 'full' : 'partial', b, network: chainId !== null ? { kind: 'evm', chainId, name: chainName(chainId) } : null };
};

async function ownerCheck(safe: string, chainId: number, env: TypedEnv, b: PreviewBuilder): Promise<void> {
  if (!env.signer || !env.deps.rpc?.has(chainId)) return;
  const owner = BigInt(String(await env.deps.rpc.call(chainId, 'eth_call', [{ to: safe, data: `0x2f54bf6e${env.signer.slice(2).padStart(64, '0')}` }, 'latest'])));
  if (owner === 0n) b.warn('caution', 'safe_not_owner', `${shortAddress(env.signer)} is not an owner of this Safe, so its signature doesn't count towards the threshold.`);
}

/**
 * Safe's ERC-4337 modules, at the same address on Ethereum, Arbitrum One and HyperEVM (checked on all three, with
 * SUPPORTED_ENTRYPOINT()). The domain is the module; the SafeOp's own fields name the Safe and the EntryPoint.
 * Sources: safe-global/safe-modules (v0.3.0) and the v0.2.0 source verified on Sourcify.
 */
export const SAFE_4337_MODULES: Record<string, { version: string; entryPoint: string; entryPointName: string }> = {
  '0x75cf11467937ce3f2f357ce24ffc3dbf8fd5c226': { version: 'Safe4337Module v0.3.0', entryPoint: '0x0000000071727de22e5e9d8baf0edac6f37da032', entryPointName: 'EntryPoint v0.7' },
  '0xa581c4a4db7175302464ff3c06380bc3270b4037': { version: 'Safe4337Module v0.2.0', entryPoint: '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789', entryPointName: 'EntryPoint v0.6' },
};
/** The only calls the module lets an operation make: executeUserOp and executeUserOpWithErrorString(to, value, data, operation). */
const EXECUTE = ['0x7bb37428', '0x541d63c8'];

/**
 * A SafeOp: an owner's signature for an ERC-4337 operation of the Safe (Safe4337Module). Once enough owners sign,
 * a bundler submits it and the module runs its call with execTransactionFromModule, as the Safe itself: so the
 * call is previewed exactly as a Safe transaction would be (batches, delegatecalls, simulation from the Safe).
 */
const safeOp: TypedAdapter = async (data, env) => {
  const m = data.message;
  const module = str(data.domain.verifyingContract).toLowerCase();
  const chainId = domainChainId(data) ?? env.context.chainId ?? null;
  const safe = str(m.safe).toLowerCase();
  const callData = (str(m.callData) || '0x').toLowerCase() as Hex;
  if (!/^0x[0-9a-f]{40}$/.test(safe) || chainId === null) return null;
  const known = SAFE_4337_MODULES[module];
  const entryPoint = str(m.entryPoint).toLowerCase();
  const b = new PreviewBuilder();
  b.detail('Module', known ? `${known.version} (${module})` : module, module);
  if (!known) b.warn('caution', 'unknown_safe_module', `${shortAddress(module)} is not one of Safe's ERC-4337 modules (v0.2.0 or v0.3.0), though the request is shaped like one. Only sign operations for the module your Safe has enabled.`);
  b.detail('EntryPoint', known && sameAddress(entryPoint, known.entryPoint) ? `${known.entryPointName} (${entryPoint})` : entryPoint, entryPoint);
  if (known && !sameAddress(entryPoint, known.entryPoint)) b.warn('caution', 'safe_op_entrypoint_mismatch', `${known.version} only works with ${known.entryPointName} (${shortAddress(known.entryPoint)}), not ${shortAddress(entryPoint)}: the module won't accept this signature.`);

  const nonce = big(m.nonce);
  if (nonce !== null) b.detail('Operation nonce', `${nonce & ((1n << 64n) - 1n)} (key ${nonce >> 64n})`, nonce.toString());
  if (known && sameAddress(entryPoint, known.entryPoint)) await nonceCheck(b, env, chainId, entryPoint, safe, nonce);
  const initCode = (str(m.initCode) || '0x').toLowerCase();
  const deploys = initCode.length >= 42;
  if (deploys) b.detail('Account setup', `deploys the Safe first, with factory ${shortAddress(`0x${initCode.slice(2, 42)}`)}`, `0x${initCode.slice(2, 42)}`);
  const validAfter = big(m.validAfter) ?? 0n, validUntil = big(m.validUntil) ?? 0n;
  if (validAfter > 0n) b.detail('Valid from', formatTimestamp(Number(validAfter) * 1000));
  b.detail('Valid until', validUntil === 0n ? 'no expiry' : formatTimestamp(Number(validUntil) * 1000));
  if (validUntil > 0n && Number(validUntil) * 1000 < env.now) b.warn('info', 'safe_op_expired', 'This operation has expired, so it can no longer be submitted.');

  // Gas: v0.3.0 (EntryPoint v0.7) packs the paymaster's own gas limits after its address; v0.2.0 (v0.6) doesn't.
  const v06 = known?.entryPointName === 'EntryPoint v0.6';
  const pm = paymasterOf((str(m.paymasterAndData) || '0x').toLowerCase(), !v06);
  const verification = big(m.verificationGasLimit), call = big(m.callGasLimit), preVerification = big(m.preVerificationGas), maxFee = big(m.maxFeePerGas), maxPriority = big(m.maxPriorityFeePerGas);
  if (verification !== null && call !== null && preVerification !== null && maxFee !== null && maxPriority !== null) {
    gasDetails(b, { verification, call, preVerification, maxFee, maxPriority, ...pm, v06 }, chainId);
  }

  // The call: always executeUserOp(WithErrorString)(to, value, data, operation); the module rejects anything else.
  let r: Awaited<ReturnType<typeof describeSafeTx>>;
  let decoded: readonly unknown[] | null = null;
  if (EXECUTE.includes(callData.slice(0, 10))) { try { decoded = decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'uint8' }], `0x${callData.slice(10)}`); } catch { decoded = null; } }
  if (decoded) {
    const [to, value, inner, operation] = decoded as [string, bigint, Hex, number];
    // Run as the EntryPoint runs it: the EntryPoint calls the Safe, whose fallback handler (the module) has it
    // execute the call with execTransactionFromModule. Deploys the Safe first when the operation does.
    const execution: SafeExecution = async watch => {
      const run = await simulateExecution({ chainId, entryPoint, sender: safe, callData, ...(deploys && { initCode: initCode as Hex }), watch }, env.deps);
      return run ? safeOutcome(run.result, safe, chainId, env, b, `The operation was simulated as the EntryPoint runs it${run.deployed ? ', after deploying the Safe' : ''}: through the Safe's 4337 module, delegatecalls included. Its signature check and gas payment aren't part of the simulation.`) : null;
    };
    r = await describeSafeTx({ safe, to, value, data: inner, operation: Number(operation), safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: ZERO, refundReceiver: ZERO }, chainId, { deps: env.deps, context: env.context }, b, execution);
  } else {
    b.warn('caution', 'safe_op_unsupported_call', `The operation's callData (${callData.slice(0, 10)}) isn't executeUserOp or executeUserOpWithErrorString, the only calls Safe's 4337 module runs: it would be rejected.`);
    const inner = await decodeTransaction({ chainId, from: safe, to: safe, data: callData, value: 0n }, env.deps, env.context);
    for (const d of inner.b.details) if (!b.details.some(x => x.label === d.label)) b.details.push(d);
    r = { title: inner.title, summary: inner.summary, status: 'partial', assetChanges: [] };
  }
  if (!deploys) {
    try {
      await ownerCheck(safe, chainId, env, b);
      if (known && env.deps.rpc?.has(chainId)) {
        const enabled = BigInt(String(await env.deps.rpc.call(chainId, 'eth_call', [{ to: safe, data: `0x2d9ad53d${module.slice(2).padStart(64, '0')}` }, 'latest'])));
        if (enabled === 0n) b.warn('info', 'safe_module_not_enabled', `${known.version} isn't enabled on this Safe, so the operation can't run until it is.`);
      }
    } catch { /* not a readable Safe */ }
  }
  b.note(`This is an off-chain owner signature; it costs no gas now. Once enough owners have signed, any bundler can submit the operation, which runs as the Safe${known ? ' through its 4337 module' : ''}, with the gas paid ${pm.paymaster ? 'by the paymaster' : 'from the Safe'}.`);
  return { title: `Safe operation: ${r.title}`, summary: `Signs an ERC-4337 operation for the Safe ${shortAddress(safe)}. ${r.summary}`, decoder: 'safe_4337_op', status: r.status, b, network: { kind: 'evm', chainId, name: chainName(chainId) }, assetChanges: r.assetChanges };
};

/** A simulated Safe execution as describeSafeTx takes it: the Safe's balance changes, or why it fails. */
export async function safeOutcome(sim: SimulationResult, safe: string, chainId: number, env: TypedEnv, b: PreviewBuilder, how: string): Promise<{ assetChanges: AssetChange[]; note: string } | { reverted: string } | null> {
  if (sim.status === 'reverted') return { reverted: sim.revertReason ?? '' };
  // The probe measures the call's sender, which isn't the Safe here: its balance reads don't apply.
  if (sim.limited || sim.basis === 'state') return null;
  const basis = sim.basis === 'fork' || sim.balancesRead ? 'simulated_state' as const : 'simulated_events' as const;
  return { assetChanges: await netChanges(sim.transfers, { chainId, from: safe }, env.deps, b, basis), note: `${how} ${simulationNote(sim)}` };
}
