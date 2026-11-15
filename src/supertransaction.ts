// Biconomy MEE supertransactions: one signature over the root of a Merkle tree whose leaves are the hashes of
// UserOperations, on any chains (the supertransaction's hash). Biconomy's MEE node submits each operation with that
// root, the proof of its hash in the tree and the signature (K1MeeValidator's simple mode, 0x177eee00); the validator
// checks the signature over the root and the proof of the operation's hash. A key that signs the root (personal_sign of
// it, or eth_sign) authorizes every operation in the tree, none of which the hash shows. The wallet holding them (its
// quote from the MEE node) supplies them as context.meeOperations; they are hashed as their EntryPoint hashes them, the
// tree is rebuilt from them, and each is previewed only where it is shown to be a leaf: all of them making up the root
// exactly, or (for a wallet holding only some of them) each with a proof that reaches it.
import { encodeAbiParameters, hashMessage, keccak256, type Hex } from 'viem';
import { attentionOf, PreviewBuilder, shortAddress } from './format.ts';
import { chainName } from './chains.ts';
import { previewMessage } from './message.ts';
import { HASH_ENTRY_POINTS, readOperation, userOpHash } from './userop-hash.ts';
import { describeOperation, paymasterOf } from './typed-data/user-operation.ts';
import { merkleTrees, proofRoot } from './typed-data/safe.ts';
import type { AssetChange, Dependencies, Preview, PreviewContext } from './types.ts';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const word = (v: bigint) => v.toString(16).padStart(32, '0');

/**
 * The leaf an operation is in a supertransaction's tree: its hash (getUserOpHash), as MEE puts a session key's
 * operation (through SmartSession: K1MeeValidator checks the proof of the hash it is given); with the operation's
 * time bounds, MEE's own hash of it (MEEUserOpHashLib: keccak256(keccak256(abi.encode(hash, lowerBound,
 * upperBound)))), as an account's own K1MeeValidator checks it.
 */
export function meeLeaf(hash: Hex, bounds?: { lowerBoundTimestamp: bigint; upperBoundTimestamp: bigint }): Hex {
  if (!bounds) return hash;
  return keccak256(keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' }], [hash, bounds.lowerBoundTimestamp, bounds.upperBoundTimestamp])));
}

const int = (v: unknown): bigint | undefined => typeof v === 'bigint' ? v : typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? BigInt(v)
  : typeof v === 'string' && /^(0x[0-9a-fA-F]+|[0-9]+)$/.test(v) ? BigInt(v) : undefined;

/**
 * personal_sign / eth_sign of a 32-byte hash, with a supertransaction's operations in context.meeOperations. Null when
 * the request isn't that, so the caller previews it otherwise.
 */
export async function previewSupertransaction(method: string, params: unknown[], context: PreviewContext, deps: Dependencies): Promise<Preview | null> {
  const supplied = context.meeOperations;
  if (!supplied) return null;
  // personal_sign is [message, address] (some dApps reverse it); eth_sign is [address, hash].
  let [message, address] = (method === 'eth_sign' ? [params[1], params[0]] : params) as [unknown, unknown];
  if (method !== 'eth_sign' && typeof message === 'string' && ADDRESS.test(message) && !(typeof address === 'string' && ADDRESS.test(address))) [message, address] = [address, message];
  if (typeof message !== 'string' || !HASH.test(message)) return null;
  const root = message.toLowerCase() as Hex;
  const signer = typeof address === 'string' && ADDRESS.test(address) ? address.toLowerCase() : null;
  // What the wallet's signature is over: personal_sign prefixes the hash; eth_sign signs it as it is.
  const digest = method === 'eth_sign' ? root : hashMessage({ raw: root });

  // Each operation, hashed as its EntryPoint does, and its leaf.
  const ops = supplied.map((o, i) => {
    const entryPoint = o.entryPoint.toLowerCase(), ep = HASH_ENTRY_POINTS[entryPoint];
    const op = ep ? readOperation(o.operation, ep.version) : null;
    const lower = int(o.lowerBoundTimestamp), upper = int(o.upperBoundTimestamp);
    const timed = o.lowerBoundTimestamp !== undefined || o.upperBoundTimestamp !== undefined;
    const hash = op && ep ? userOpHash(op, entryPoint, o.chainId, ep.version) : null;
    const leaf = hash && (!timed ? hash : lower !== undefined && upper !== undefined ? meeLeaf(hash, { lowerBoundTimestamp: lower, upperBoundTimestamp: upper }) : null);
    const why = !ep ? `operation ${i + 1}'s EntryPoint (${shortAddress(entryPoint)}) is not v0.6 or v0.7, whose operations' hashes are computed here`
      : !op ? `operation ${i + 1} is malformed` : !leaf ? `operation ${i + 1}'s time bounds aren't numbers` : undefined;
    const proof = o.proof?.every(h => HASH.test(h)) ? o.proof.map(h => h.toLowerCase() as Hex) : undefined;
    return { ...o, entryPoint, ep, op, hash, leaf, why, proof };
  });
  // The tree: the operations' leaves alone making up the root (in a layout tree builders use, OpenZeppelin's
  // SimpleMerkleTree with its leaves sorted, as Biconomy's SDK builds it, among them), each with its proof in it; or
  // each operation's own proof reaching the root from its leaf, the tree holding others too.
  const leaves = ops.map(o => o.leaf);
  const tree = leaves.every(Boolean) ? merkleTrees(leaves as Hex[]).find(t => t.root === root) : undefined;
  const proven = !tree && ops.length > 0 && ops.every(o => o.leaf && o.proof && proofRoot(o.proof, o.leaf) === root);
  const b = new PreviewBuilder();
  const network = context.chainId ? { kind: 'evm' as const, chainId: context.chainId, name: chainName(context.chainId) } : ops[0] ? { kind: 'evm' as const, chainId: ops[0].chainId, name: chainName(ops[0].chainId) } : null;
  if (!tree && !proven) {
    const p = previewMessage(method, params, context);
    const why = ops.find(o => o.why)?.why
      ?? (!ops.length ? 'no operations were supplied with it'
      : ops.some(o => o.proof) ? `the ${ops.length === 1 ? "operation supplied with it doesn't make it up, and its proof doesn't" : `${ops.length} operations supplied with it don't make it up, and their proofs don't all`} reach it`
      : `the ${ops.length === 1 ? "operation supplied with it doesn't" : `${ops.length} operations supplied with it don't`} make it up: it covers other operations, which aren't shown`);
    p.warnings.push({ severity: 'danger', code: 'mee_supertransaction_mismatch', message: `This message can't be checked as a supertransaction's hash (a Merkle root of its operations' hashes, which one signature authorizes on every chain they are on): ${why}. What you would sign may not be what the app shows.` });
    return { ...p, network, attention: attentionOf(p.warnings) };
  }

  b.detail('Supertransaction hash', root, root);
  b.note("This is an off-chain signature; it costs no gas now. Biconomy's MEE node submits each operation in the supertransaction on its chain, with this hash, the proof that the operation's hash is one of its leaves, and the signature (K1MeeValidator's simple mode), which the account's validator (or its session's) checks over the hash.");
  const chains = [...new Set(ops.map(o => o.chainId))];
  const where = chains.map(chainName).join(', ');
  const count = `${ops.length} operation${ops.length === 1 ? '' : 's'}`;
  if (tree) b.warn('info', 'mee_supertransaction_verified', `The wallet supplied the ${count} this supertransaction's hash covers, on ${where}, and they make up the hash exactly: the signature authorizes these and nothing else. Each runs once Biconomy's MEE node submits it with its proof.`);
  else b.warn('danger', 'mee_supertransaction_partial', `This supertransaction's hash covers more than the ${count} supplied with it: ${ops.length === 1 ? 'its proof shows it is' : 'their proofs show they are'} among its leaves, but its other leaves are only hashes here, so what those operations do, and on which chains, isn't shown. Every one of them runs with this one signature. Only sign it if your wallet shows every operation in the supertransaction and you have checked each.`);
  if (method === 'eth_sign') b.warn('info', 'eth_sign_supertransaction', "eth_sign signs raw data; here that data is the supertransaction's hash, which K1MeeValidator also takes without the personal_sign prefix.");

  // Each operation previewed whole on its chain, signed as one of the supertransaction's: the stand-in in simple
  // mode, with the root and the operation's proof (src/erc4337-sim.ts, smartSessionStub). A signature in it is left
  // out: the key's over the root doesn't exist yet.
  const titles: string[] = [];
  let assetChanges: AssetChange[] = [];
  const now = context.now ?? Date.now();
  for (const [i, o] of ops.entries()) {
    const op = o.op!, ep = o.ep!, proof = tree ? tree.proofs[i] : o.proof!;
    const label = `Operation ${i + 1} (${chainName(o.chainId)})`;
    const pm = paymasterOf(op.paymasterAndData, ep.version === '0.7');
    const ob = new PreviewBuilder();
    const d = await describeOperation({
      chainId: o.chainId, entryPoint: o.entryPoint, entryPointName: ep.name, sender: op.sender, nonce: op.nonce, initCode: op.initCode, callData: op.callData === '0x' ? null : op.callData, paymaster: pm.paymaster,
      gas: { verification: op.verificationGasLimit, call: op.callGasLimit, preVerification: op.preVerificationGas, maxFee: op.maxFeePerGas, maxPriority: op.maxPriorityFeePerGas, ...pm, v06: ep.version === '0.6' },
      userOpHash: o.hash!, paymasterAndData: op.paymasterAndData, digest, supertransaction: { root, proof },
      ...(ep.version === '0.7' && { packed: { nonce: op.nonce, initCode: op.initCode, accountGasLimits: `0x${word(op.verificationGasLimit)}${word(op.callGasLimit)}` as Hex, preVerificationGas: op.preVerificationGas, gasFees: `0x${word(op.maxPriorityFeePerGas)}${word(op.maxFeePerGas)}` as Hex, paymasterAndData: op.paymasterAndData } }),
    }, { deps, context: { ...context, chainId: o.chainId }, signer, now }, ob);
    ob.detail('UserOperation hash', o.hash!, o.hash!);
    if (o.leaf !== o.hash) ob.detail("Leaf (MEE's hash of it and its time bounds)", o.leaf!, o.leaf!);
    ob.detail('Proof', proof.length ? proof.join(', ') : 'none (the hash is the operation\'s own)');
    const title = d.title.replace(/^Sign a UserOperation: /, '').replace(/^Sign a UserOperation for /, 'a UserOperation for ');
    titles.push(title);
    b.detail(label, `${title}, from the account ${shortAddress(op.sender)}`, op.sender);
    for (const x of ob.details) b.detail(`${label}: ${x.label}`, x.value, x.raw);
    // Each operation's warnings, its own (two operations can warn alike); the caution that the run used state set by
    // the caller is the preview's, once and unprefixed.
    for (const w of ob.warnings) {
      if (w.code === 'state_overridden') b.warn(w.severity, w.code, w.message);
      else b.warnings.push({ ...w, message: `${label}: ${w.message}` });
    }
    // (Each operation's own note that it is an off-chain signature is the preview's, above.)
    for (const n of ob.notes) if (!n.startsWith('This is an off-chain signature')) b.note(`${label}: ${n}`);
    if (ob.trace && !b.trace) b.trace = ob.trace;
    // Balance changes on the request's chain go in the preview's list; another chain's are described with its operation.
    if (!context.chainId || o.chainId === context.chainId) assetChanges = assetChanges.concat(d.assetChanges ?? []);
    else if (d.assetChanges?.length) b.detail(`${label}: balance changes`, d.assetChanges.map(c => `${c.direction === 'out' ? '−' : '+'}${c.amount} ${c.symbol}`).join(', '));
  }
  if (signer && context.account && signer !== context.account.toLowerCase()) b.warn('danger', 'signer_mismatch', `The request asks ${signer} to sign, but the connected account is ${context.account}.`);
  const many = titles.length === 1 ? titles[0] : `${titles.length} operations on ${chains.length} chain${chains.length === 1 ? '' : 's'}`;
  return {
    schema: 'signing-preview/1', method, kind: 'message', network,
    title: `Sign a supertransaction: ${many}${tree ? '' : ', and others not shown'}`,
    summary: `Authorizes ${tree ? '' : 'at least '}${count} of a Biconomy MEE supertransaction with one signature, on ${where}${tree ? '' : ' (and operations not shown, on any chain)'}: ${titles.join('; ')}.`,
    details: b.details, assetChanges, warnings: b.warnings, attention: attentionOf(b.warnings),
    decoding: { status: 'partial', decoder: 'mee_supertransaction', notes: b.notes },
    ...(b.trace && { trace: b.trace }),
  };
}
