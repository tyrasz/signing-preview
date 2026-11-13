// Safe multisig owner signatures: EIP-712 SafeTx (domain: the chain and the Safe itself), SafeMessage, and SafeOp
// (ERC-4337 operations through Safe's 4337 module). See src/safe.ts.
import { concatHex, decodeAbiParameters, hexToBytes, keccak256, type Hex } from 'viem';
import { formatTimestamp, PreviewBuilder, sameAddress, shortAddress } from '../format.ts';
import { chainName } from '../chains.ts';
import { describeSafeTx, reportConfigChanges, safeOutcome, viaExecTransaction, type SafeExecution } from '../safe.ts';
import { simulateExecution, simulateOperation, STUB_SIGNATURE, stubSignature } from '../erc4337-sim.ts';
import { approvalsFor, config as safeConfig, readConfig, reads, safeSetupOf, safeSignatures, safeWebAuthnStub, SAFE_WEBAUTHN_SHARED_SIGNER, sharedSignerVerifiers, webAuthnSignerVerifiers } from '../safe-sim.ts';
import { decodeTransaction } from '../evm/transaction.ts';
import { gasDetails, nonceCheck, paymasterOf, reportRun } from './user-operation.ts';
import { big, domainChainId, str, typedDataDigest, type TypedAdapter, type TypedEnv } from './common.ts';
import type { AssetChange } from '../types.ts';

const ZERO = '0x0000000000000000000000000000000000000000';

export const safeTxAdapter: TypedAdapter = async (data, env) => {
  if (data.primaryType === 'SafeMessage') return safeMessage(data, env);
  if (data.primaryType === 'SafeOp') return safeOp(data, env);
  if (data.primaryType === 'MerkleTreeRoot') return merkleTreeRoot(data, env);
  if (data.primaryType !== 'SafeTx') return null;
  const m = data.message;
  const safe = str(data.domain.verifyingContract).toLowerCase();
  const chainId = domainChainId(data) ?? env.context.chainId ?? null;
  const value = big(m.value), safeTxGas = big(m.safeTxGas) ?? 0n, baseGas = big(m.baseGas ?? m.dataGas) ?? 0n, gasPrice = big(m.gasPrice) ?? 0n, operation = Number(big(m.operation) ?? 0n), nonce = big(m.nonce) ?? undefined;
  if (!/^0x[0-9a-f]{40}$/.test(safe) || chainId === null || value === null) return null;
  const b = new PreviewBuilder();
  const t = { safe, to: str(m.to), value, data: (str(m.data) || '0x') as `0x${string}`, operation, safeTxGas, baseGas, gasPrice, gasToken: str(m.gasToken) || '0x0000000000000000000000000000000000000000', refundReceiver: str(m.refundReceiver) || '0x0000000000000000000000000000000000000000', nonce };
  const r = await describeSafeTx(t, chainId, { deps: env.deps, context: env.context }, b, viaExecTransaction(t, chainId, { deps: env.deps, context: env.context }, b, { executor: env.signer }));
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
 * ERC-4337 modules for Safe accounts. The domain is the module; the SafeOp's own fields name the Safe and the
 * EntryPoint. Safe's own (safe-global/safe-modules v0.3.0, and v0.2.0 verified on Sourcify) are at the same address
 * on Ethereum, Arbitrum One and HyperEVM (checked with SUPPORTED_ENTRYPOINT()). Safe4337MultiChainSignatureModule,
 * verified on Sourcify and used by Safes on EntryPoint v0.9, is at the same address on Ethereum and Arbitrum One; its
 * signatures start with the depth of a Merkle tree (0 for a single operation; see merkleTreeRoot).
 */
export const SAFE_4337_MODULES: Record<string, { version: string; entryPoint: string; entryPointName: string; /** Before the validity window in the operation's signature. */ signaturePrefix?: string; multiChain?: boolean }> = {
  '0x75cf11467937ce3f2f357ce24ffc3dbf8fd5c226': { version: 'Safe4337Module v0.3.0', entryPoint: '0x0000000071727de22e5e9d8baf0edac6f37da032', entryPointName: 'EntryPoint v0.7' },
  '0xa581c4a4db7175302464ff3c06380bc3270b4037': { version: 'Safe4337Module v0.2.0', entryPoint: '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789', entryPointName: 'EntryPoint v0.6' },
  '0x22939e839e3c0f479b713eaf95e0df128554aead': { version: 'Safe4337MultiChainSignatureModule', entryPoint: '0x433709009b8330fda32311df1c2afa402ed8d009', entryPointName: 'EntryPoint v0.9', signaturePrefix: '00', multiChain: true },
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
  if (!known) b.warn('caution', 'unknown_safe_module', `${shortAddress(module)} is not a known ERC-4337 module for Safe accounts, though the request is shaped like one. Only sign operations for the module your Safe has enabled.`);
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
      // The whole operation as the EntryPoint runs it: the module's validation (with the owners' signatures stood in
      // for), the call, gas and any paymaster, then the Safe's configuration read again.
      if (known && sameAddress(entryPoint, known.entryPoint) && nonce !== null && verification !== null && call !== null && preVerification !== null && maxFee !== null && maxPriority !== null) {
        const before = deploys ? undefined : await readConfig(env.deps, chainId, safe);
        const digest = typedDataDigest(data);
        // The signing owner (or, if the signer isn't one, the first) signs with the ECDSA stand-in, which the replaced
        // ecrecover attributes to them, so the Safe's check costs what it will; any others the threshold needs approve.
        const owner = before && (env.signer && before.owners.includes(env.signer.toLowerCase()) ? env.signer.toLowerCase() : [...before.owners].sort((a, z) => (BigInt(a) < BigInt(z) ? -1 : 1))[0]);
        // A Safe the operation deploys has no approvals to set (no storage can be put where it will be created): its
        // owners and threshold come from its setup, and each owner the threshold needs signs with a stand-in of its
        // own (the signing owner's first), which the replaced ecrecover attributes to them.
        const setup = deploys ? safeSetupOf(initCode) : null;
        const asc = (a: string, z: string) => (BigInt(a) < BigInt(z) ? -1 : 1);
        const primary = setup && (env.signer && setup.owners.includes(env.signer.toLowerCase()) ? env.signer.toLowerCase() : [...setup.owners].sort(asc)[0]);
        // A passkey owner signs as a contract: a WebAuthn assertion, which the P-256 verifier its passkey names accepts
        // after running its real check (so the check costs what it will). Through Safe's WebAuthn shared signer (the
        // passkey in the Safe's storage), or through the passkey's own signer contract (SafeWebAuthnSignerProxy): an
        // ECDSA stand-in for that owner left out the check, a P-256 verification in Solidity, and SafeOps came out
        // 44-51% low (Ethereum, Base, Polygon; about 225,000 gas).
        const signingOwner = owner ?? primary;
        const verifiers = signingOwner === SAFE_WEBAUTHN_SHARED_SIGNER ? await sharedSignerVerifiers(env.deps, chainId, safe, deploys ? initCode : undefined)
          : signingOwner ? await webAuthnSignerVerifiers(env.deps, chainId, signingOwner) : null;
        const passkey = verifiers ? safeWebAuthnStub() : undefined;
        const approvals = before && digest ? approvalsFor(before, digest as Hex, owner ? { owner, signature: STUB_SIGNATURE, ...(passkey && { contract: passkey }) } : undefined) : null;
        const signing = setup && primary && setup.threshold <= 16n ? [primary, ...[...setup.owners].sort(asc).filter(o => o !== primary)].slice(0, Number(setup.threshold)).sort(asc) : null;
        const cosigners = signing ? signing.filter(o => o !== primary).map((o, i) => ({ signature: stubSignature(i + 1), signer: o })) : [];
        const deploySignatures = signing ? safeSignatures(signing.map(o => o === primary ? { owner: o, signature: STUB_SIGNATURE, ...(passkey && { contract: passkey }) } : { owner: o, signature: cosigners.find(c => c.signer === o)!.signature })) : null;
        const zero = (a?: string) => !a || /^0x0{40}$/.test(a);
        // The module's signature: validAfter and validUntil (6 bytes each), then the owners' signatures.
        const window = `${validAfter.toString(16).padStart(12, '0')}${validUntil.toString(16).padStart(12, '0')}`;
        const signature = `0x${known.signaturePrefix ?? ''}${window}${(approvals?.signatures ?? deploySignatures ?? STUB_SIGNATURE).slice(2)}` as Hex;
        const signer = owner ?? primary ?? env.signer;
        const run = await simulateOperation({ chainId, entryPoint, sender: safe, nonce, initCode: initCode as Hex, callData, callGasLimit: call, verificationGasLimit: verification, preVerificationGas: preVerification,
          maxFeePerGas: maxFee, maxPriorityFeePerGas: maxPriority, paymasterAndData: (str(m.paymasterAndData) || '0x').toLowerCase() as Hex, signature, ...(signer && { signer }), ...(cosigners.length && { cosigners }), watch,
          ...(verifiers && BigInt(verifiers.precompile) === 0x100n && { p256: true }), ...(verifiers && !zero(verifiers.fallback) && { verifier: verifiers.fallback }),
          ...(approvals && Object.keys(approvals.stateDiff).length && { stateOverrides: { [safe]: { stateDiff: approvals.stateDiff } } }), ...(before && { after: reads(safe).map(r => ({ chainId, from: ZERO, to: r.to, data: r.data, value: 0n })) }) }, env.deps).catch(() => null);
        const changes = await reportRun(run, { sender: safe, paymaster: pm.paymaster, entryPointName: known.entryPointName, signature }, chainId, env, b,
          { deploys, validation: passkey ? `with a stand-in for the owner's passkey signature (a WebAuthn assertion, which the P-256 verifier its passkey is checked with accepts, after running its real check)${approvals && before!.threshold > 1n ? `, and ${before!.threshold - 1n} other owner${before!.threshold === 2n ? '' : 's'} approving it on-chain in place of theirs` : cosigners.length ? ` and ${cosigners.length} other owner${cosigners.length === 1 ? '\'s' : 's\''}, which ecrecover attributes to each` : ''}`
            : approvals ? `with a stand-in for ${owner === env.signer?.toLowerCase() ? 'your' : 'an owner\'s'} signature, which ecrecover attributes to ${owner === env.signer?.toLowerCase() ? 'you' : 'that owner'}${before!.threshold > 1n ? `, and ${before!.threshold - 1n} other owner${before!.threshold === 2n ? '' : 's'} approving it on-chain in place of theirs` : ''}`
            : signing ? `with a stand-in for ${primary === env.signer?.toLowerCase() ? 'your' : 'an owner\'s'} signature${cosigners.length ? ` and ${cosigners.length} other owner${cosigners.length === 1 ? '\'s' : 's\''}, as the threshold of the Safe being created needs` : ''}, which ecrecover attributes to each`
            : "with a stand-in for the owner's signature, which ecrecover attributes to the signer" });
        if (changes) {
          const after = run?.after?.every(r => r.status === 'success') ? run.after : undefined;
          const config = after && safeConfig(after.map(r => r.returnData as Hex));
          if (before && config) reportConfigChanges(before, config, b);
          return { assetChanges: changes, note: '' };
        }
      }
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

/** The SafeOp type the multi-chain module signs (domain: chainId, verifyingContract), as its SAFE_OP_TYPEHASH states. */
const SAFE_OP_TYPES = {
  EIP712Domain: [{ name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
  SafeOp: [{ type: 'address', name: 'safe' }, { type: 'uint256', name: 'nonce' }, { type: 'bytes', name: 'initCode' }, { type: 'bytes', name: 'callData' }, { type: 'uint128', name: 'verificationGasLimit' }, { type: 'uint128', name: 'callGasLimit' }, { type: 'uint256', name: 'preVerificationGas' }, { type: 'uint128', name: 'maxPriorityFeePerGas' }, { type: 'uint128', name: 'maxFeePerGas' }, { type: 'bytes', name: 'paymasterAndData' }, { type: 'uint48', name: 'validAfter' }, { type: 'uint48', name: 'validUntil' }, { type: 'address', name: 'entryPoint' }],
};

/** The module's pair hash: keccak256 of the two nodes, the smaller first. */
const hashPair = (a: Hex, b: Hex) => keccak256(BigInt(a) < BigInt(b) ? concatHex([a, b]) : concatHex([b, a]));
/**
 * The roots a tree of these leaves can have, as tree builders lay them out: OpenZeppelin's merkle-tree (a complete
 * binary tree in an array, leaves at its end) and level by level (an odd node carried up, or paired with itself),
 * with the leaves in the order given or sorted. With the module's commutative pair hash, a root that matches commits
 * to exactly these leaves: no other operation has a proof to it.
 */
export function merkleRoots(leaves: Hex[]): Set<string> {
  const roots = new Set<string>();
  if (!leaves.length) return roots;
  for (const order of [leaves, [...leaves].sort((a, z) => (BigInt(a) < BigInt(z) ? -1 : BigInt(a) > BigInt(z) ? 1 : 0))]) {
    const tree: Hex[] = new Array(2 * order.length - 1);
    order.forEach((leaf, i) => { tree[tree.length - 1 - i] = leaf; });
    for (let i = tree.length - 1 - order.length; i >= 0; i--) tree[i] = hashPair(tree[2 * i + 1], tree[2 * i + 2]);
    roots.add(tree[0].toLowerCase());
    for (const odd of ['carry', 'self'] as const) {
      let level = order;
      while (level.length > 1) {
        const next: Hex[] = [];
        for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? hashPair(level[i], level[i + 1]) : odd === 'self' ? hashPair(level[i], level[i]) : level[i]);
        level = next;
      }
      roots.add(level[0].toLowerCase());
    }
  }
  return roots;
}

/**
 * Safe4337MultiChainSignatureModule's multi-chain signature: one signature over the root of a Merkle tree whose
 * leaves are SafeOps, on any chains (the domain has no chain). Each operation is later submitted with a proof of its
 * leaf (its SafeOp digest on its chain). The message holds only the root, so the operations are shown only when the
 * wallet supplies them (context.safeOperations) and they make up the root exactly; each is then previewed as a
 * SafeOp on its own chain.
 */
const merkleTreeRoot: TypedAdapter = async (data, env) => {
  const module = str(data.domain.verifyingContract).toLowerCase();
  const known = SAFE_4337_MODULES[module];
  if (!known?.multiChain) return null;
  const root = str(data.message.merkleTreeRoot).toLowerCase();
  const b = new PreviewBuilder();
  b.detail('Module', `${known.version} (${module})`, module);
  b.detail('EntryPoint', `${known.entryPointName} (${known.entryPoint})`, known.entryPoint);
  b.detail('Merkle tree root', root, root);
  b.note('An off-chain signature; it costs no gas now. A bundler submits each operation in the tree with a proof that it is one of the leaves.');
  const network = env.context.chainId ? { kind: 'evm' as const, chainId: env.context.chainId, name: chainName(env.context.chainId) } : null;
  const supplied = env.context.safeOperations ?? [];
  const typedOf = (o: { chainId: number; operation: Record<string, unknown> }) => ({ domain: { chainId: o.chainId, verifyingContract: module }, types: SAFE_OP_TYPES, primaryType: 'SafeOp', message: o.operation });
  const leaves = supplied.map(o => typedDataDigest(typedOf(o)));
  const opaque = { title: 'Sign Safe operations on several chains (contents not shown)', summary: `Authorizes every Safe operation in a Merkle tree, on any chain where ${known.version} runs. The operations themselves aren't in the message.`, decoder: 'safe_multichain_root', status: 'opaque' as const, b, network };
  if (!supplied.length) {
    b.warn('danger', 'safe_multichain_root', `This signs the root of a Merkle tree of Safe operations, valid on every chain where the module runs (the signature names no chain). The message doesn't say which operations it covers, on which chains, or how many: any operation in the tree runs with this one signature. Only sign it if your wallet shows every operation in the tree and you have checked each.`);
    return opaque;
  }
  if (leaves.some(l => !l) || !merkleRoots(leaves as Hex[]).has(root)) {
    b.warn('danger', 'safe_multichain_root_mismatch', `The ${supplied.length} operation${supplied.length === 1 ? '' : 's'} supplied with this signature don't make up the root it signs: it covers other operations, which aren't shown. What you would sign may not be what the app shows.`);
    return opaque;
  }
  // The tree is exactly these operations: each previewed as the SafeOp it is, on its chain.
  const chains = [...new Set(supplied.map(o => o.chainId))];
  b.warn('info', 'safe_multichain_root_verified', `The wallet supplied the ${supplied.length} operation${supplied.length === 1 ? '' : 's'} this root covers, on ${chains.map(chainName).join(', ')}, and they make up the root exactly: the signature authorizes these and nothing else. Each runs once its bundler submits it with its proof.`);
  const titles: string[] = [];
  let assetChanges: AssetChange[] = [];
  for (const [i, o] of supplied.entries()) {
    const r = await safeOp(typedOf(o), { ...env, context: { ...env.context, chainId: o.chainId } });
    const label = `Operation ${i + 1} (${chainName(o.chainId)})`;
    if (!r) { b.detail(label, 'not a SafeOp the module would run'); continue; }
    titles.push(r.title.replace(/^Safe operation: /, ''));
    b.detail(label, `${r.title.replace(/^Safe operation: /, '')}, from the Safe ${shortAddress(str(o.operation.safe))}`);
    for (const d of r.b.details) b.detail(`${label}: ${d.label}`, d.value, d.raw);
    for (const w of r.b.warnings) b.warn(w.severity, w.code, `${label}: ${w.message}`);
    for (const n of r.b.notes) b.note(`${label}: ${n}`);
    // Balance changes of the context's chain go in the preview's list; another chain's are described with its operation.
    if (!network || o.chainId === network.chainId) assetChanges = assetChanges.concat(r.assetChanges ?? []);
    else if (r.assetChanges?.length) b.detail(`${label}: balance changes`, r.assetChanges.map(c => `${c.direction === 'out' ? '−' : '+'}${c.amount} ${c.symbol}`).join(', '));
  }
  const many = titles.length === 1 ? titles[0] : `${titles.length} operations on ${chains.length} chain${chains.length === 1 ? '' : 's'}`;
  return { title: `Sign Safe operations: ${many}`, summary: `Authorizes ${supplied.length} Safe operation${supplied.length === 1 ? '' : 's'} with one signature, on ${chains.map(chainName).join(', ')}: ${titles.join('; ')}.`, decoder: 'safe_multichain_root', status: 'partial', b, network, assetChanges };
};
