// Biconomy MEE supertransactions: one signature over the root of a Merkle tree whose leaves are the hashes of
// UserOperations, on any chains (the supertransaction's hash). Biconomy's MEE node submits each operation with that
// root, the proof of its hash in the tree and the signature (K1MeeValidator's simple mode, 0x177eee00); the validator
// checks the signature over the root and the proof of the operation's hash. A key that signs the root (personal_sign of
// it, or eth_sign) authorizes every operation in the tree, none of which the hash shows. The wallet holding them (its
// quote from the MEE node) supplies them as context.meeOperations; they are hashed as their EntryPoint hashes them, the
// tree is rebuilt from them, and each is previewed only where it is shown to be a leaf: all of them making up the root
// exactly, or (for a wallet holding only some of them) each with a proof that reaches it.
import { encodeAbiParameters, hashMessage, keccak256, type Hex } from 'viem';
import { attentionOf, formatDuration, formatTimestamp, PreviewBuilder, sameAddress, shortAddress } from './format.ts';
import { chainName } from './chains.ts';
import { previewMessage } from './message.ts';
import { HASH_ENTRY_POINTS, readOperation, userOpHash } from './userop-hash.ts';
import { describeOperation, paymasterOf, type DescribedOperation, type Operation } from './typed-data/user-operation.ts';
import { merkleTrees, proofRoot } from './typed-data/safe.ts';
import { combineChanges } from './operation-changes.ts';
import type { AssetChange, Dependencies, Preview, PreviewContext, SimulationRequest } from './types.ts';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const word = (v: bigint) => v.toString(16).padStart(32, '0');
/** K1MeeValidator reads an operation's time bounds as uint48 (seconds), and so they go into its validation data. */
const UINT48 = (1n << 48n) - 1n;
/** An operation valid for longer than this from when it can first run is noted as long-lived. */
const LONG_VALIDITY = 86_400n;
/**
 * At most this many operations of one chain are simulated in order: each runs after all the ones before it, so the
 * work grows with the square of their number (32 of one account on one chain took 12 times as long as each alone, 70 s
 * against 5.7 s, in the tests' local EVM; 64 can be supplied). Past these, each is simulated alone, as where the
 * simulator can't run several in order.
 */
const IN_ORDER = 8;

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
  // (Whatever the wallet supplies, an operation that can't be hashed is a malformed one, not a failed preview.)
  const ops = supplied.map((o, i) => {
    const entryPoint = o.entryPoint.toLowerCase(), ep = HASH_ENTRY_POINTS[entryPoint];
    const chainOk = Number.isSafeInteger(o.chainId) && o.chainId > 0;
    const op = ep ? readOperation(o.operation, ep.version) : null;
    const lower = int(o.lowerBoundTimestamp), upper = int(o.upperBoundTimestamp);
    const timed = o.lowerBoundTimestamp !== undefined || o.upperBoundTimestamp !== undefined;
    const bounds = timed && lower !== undefined && upper !== undefined && lower <= UINT48 && upper <= UINT48 ? { lowerBoundTimestamp: lower, upperBoundTimestamp: upper } : undefined;
    let hash: Hex | null = null, leaf: Hex | null = null;
    try {
      hash = op && ep && chainOk ? userOpHash(op, entryPoint, o.chainId, ep.version) : null;
      leaf = hash && (!timed ? hash : bounds ? meeLeaf(hash, bounds) : null);
    } catch { hash = leaf = null; }
    const why = !ep ? `operation ${i + 1}'s EntryPoint (${shortAddress(entryPoint)}) is not v0.6 or v0.7, whose operations' hashes are computed here`
      : !chainOk ? `operation ${i + 1}'s chain ID (${o.chainId}) isn't a chain's` : !op || !hash ? `operation ${i + 1} is malformed`
      : !leaf ? `operation ${i + 1}'s time bounds aren't K1MeeValidator's (whole seconds, at most 2^48 - 1)` : undefined;
    const proof = o.proof?.every(h => HASH.test(h)) ? o.proof.map(h => h.toLowerCase() as Hex) : undefined;
    return { ...o, entryPoint, ep, op, hash, leaf, why, proof, bounds };
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
  const nowS = BigInt(Math.floor((context.now ?? Date.now()) / 1000));
  // Operations whose time bounds don't let them run now, or let them run for long (shown with each, below).
  const timing = ops.some(o => o.bounds && (o.bounds.lowerBoundTimestamp > nowS || o.bounds.upperBoundTimestamp === 0n || o.bounds.upperBoundTimestamp < nowS));
  if (tree) b.warn('info', 'mee_supertransaction_verified', `The wallet supplied the ${count} this supertransaction's hash covers, on ${where}, and they make up the hash exactly: the signature authorizes these and nothing else. Each can run once it is submitted with its proof (by Biconomy's MEE node, or anyone else holding this signature and the operation)${timing ? ', within its time bounds' : ''}.`);
  else b.warn('danger', 'mee_supertransaction_partial', `This supertransaction's hash covers more than the ${count} supplied with it: ${ops.length === 1 ? 'its proof shows it is' : 'their proofs show they are'} among its leaves, but its other leaves are only hashes here, so what those operations do, and on which chains, isn't shown. Every one of them runs with this one signature. Only sign it if your wallet shows every operation in the supertransaction and you have checked each.`);
  if (method === 'eth_sign') b.warn('info', 'eth_sign_supertransaction', "eth_sign signs raw data; here that data is the supertransaction's hash, which K1MeeValidator also takes without the personal_sign prefix.");

  // Each operation previewed whole on its chain, signed as one of the supertransaction's: the stand-in in simple
  // mode, with the root and the operation's proof (src/erc4337-sim.ts, smartSessionStub). A signature in it is left
  // out: the key's over the root doesn't exist yet. Operations on one chain are simulated in the order they run, each
  // on the state the ones before it leave (a wrap, then a send of what it wrapped: alone, the send fails): as
  // supplied, but an account's operations under one nonce key in their nonce's order, the only one the EntryPoint
  // runs them in. Where the simulator can't run several calls in order, or past a chain's first IN_ORDER, each is
  // simulated alone.
  const order = runOrder(ops.map(o => ({ chainId: o.chainId, sender: o.op!.sender, nonce: o.op!.nonce })));
  const inOrder = !!deps.simulator?.simulateBatch;
  const now = context.now ?? Date.now();
  const ran = new Map<number, SimulationRequest[]>(), ranOf = new Map<number, SimulationRequest[]>();
  const results: { d: DescribedOperation; ob: PreviewBuilder; after: number[]; needed: number[]; ordered: boolean; alone?: AssetChange[] }[] = [];
  for (const [k, i] of order.entries()) {
    const o = ops[i], op = o.op!, ep = o.ep!, proof = tree ? tree.proofs[i] : o.proof!;
    const pm = paymasterOf(op.paymasterAndData, ep.version === '0.7');
    const input: Operation = {
      chainId: o.chainId, entryPoint: o.entryPoint, entryPointName: ep.name, sender: op.sender, nonce: op.nonce, initCode: op.initCode, callData: op.callData === '0x' ? null : op.callData, paymaster: pm.paymaster,
      gas: { verification: op.verificationGasLimit, call: op.callGasLimit, preVerification: op.preVerificationGas, maxFee: op.maxFeePerGas, maxPriority: op.maxPriorityFeePerGas, ...pm, v06: ep.version === '0.6' },
      userOpHash: o.hash!, paymasterAndData: op.paymasterAndData, digest, supertransaction: { root, proof },
      // The other operations' accounts on its chain: what it moves of theirs is theirs to lose (an app's operation
      // can take your account's tokens with an allowance one of yours grants it).
      alsoFor: ops.filter(x => x.chainId === o.chainId && !sameAddress(x.op!.sender, op.sender)).map(x => x.op!.sender),
      ...(ep.version === '0.7' && { packed: { nonce: op.nonce, initCode: op.initCode, accountGasLimits: `0x${word(op.verificationGasLimit)}${word(op.callGasLimit)}` as Hex, preVerificationGas: op.preVerificationGas, gasFees: `0x${word(op.maxPriorityFeePerGas)}${word(op.maxFeePerGas)}` as Hex, paymasterAndData: op.paymasterAndData } }),
    };
    const env = { deps, context: { ...context, chainId: o.chainId }, signer, now };
    const after = order.slice(0, k).filter(j => ops[j].chainId === o.chainId);
    const ordered = inOrder && after.length < IN_ORDER;
    const before = ordered ? ran.get(o.chainId) ?? [] : [];
    const ob = new PreviewBuilder();
    const d = await describeOperation({ ...input, ...(before.length && { before }) }, env, ob);
    if (d.ran?.length) { ran.set(o.chainId, [...before, ...d.ran]); ranOf.set(i, d.ran); }
    // Run after others, of which it needs only its account's under the same nonce key (the EntryPoint runs those in
    // their nonce's order; nothing else makes it wait): anyone holding the signature and the operations can submit it
    // after only those (alone, where there are none), and it is simulated so too, for what it does then. Not only where
    // it needs none: an operation that does nothing, under its nonce key and before it, would otherwise spare it that.
    const needed = after.filter(j => sameAddress(ops[j].op!.sender, op.sender) && ops[j].op!.nonce >> 64n === op.nonce >> 64n);
    let alone: AssetChange[] | undefined;
    if (before.length && needed.length < after.length) {
      const prefix = needed.flatMap(j => ranOf.get(j) ?? []);
      try { alone = (await describeOperation({ ...input, ...(prefix.length && { before: prefix }) }, { ...env, context: { ...env.context, trace: false } }, new PreviewBuilder())).assetChanges ?? []; } catch { alone = undefined; }
    }
    results[i] = { d, ob, after, needed, ordered, ...(alone && { alone }) };
  }

  const titles: string[] = [];
  const changes: { label: string; chainId: number; sender: string; changes: AssetChange[] }[] = [];
  for (const [i, o] of ops.entries()) {
    const op = o.op!, proof = tree ? tree.proofs[i] : o.proof!;
    const { d, ob, after, needed, ordered, alone } = results[i];
    const label = `Operation ${i + 1} (${chainName(o.chainId)})`;
    ob.detail('UserOperation hash', o.hash!, o.hash!);
    if (o.leaf !== o.hash) ob.detail("Leaf (MEE's hash of it and its time bounds)", o.leaf!, o.leaf!);
    ob.detail('Proof', proof.length ? proof.join(', ') : 'none (the hash is the operation\'s own)');
    // The time bounds of a timed leaf (K1MeeValidator's validAfter and validUntil, 0 for no end).
    if (o.bounds) {
      const { lowerBoundTimestamp: from, upperBoundTimestamp: until } = o.bounds;
      if (from > 0n) ob.detail('Valid from', formatTimestamp(Number(from) * 1000), from.toString());
      ob.detail('Valid until', until === 0n ? 'no expiry' : formatTimestamp(Number(until) * 1000), until.toString());
      const start = from > nowS ? from : nowS;
      if (until !== 0n && until < nowS) ob.warn('info', 'mee_operation_expired', `Its time bounds ended at ${formatTimestamp(Number(until) * 1000)}: K1MeeValidator refuses it, so it can no longer run.`);
      else if (from > nowS) ob.warn('caution', 'mee_operation_not_yet_valid', `It can't run before ${formatTimestamp(Number(from) * 1000)} (${formatDuration(Number(from - nowS) * 1000)} from now), and was simulated on the chain's state now: what it does then depends on the state then.`);
      if (until === 0n) ob.warn('caution', 'mee_operation_no_expiry', `It has no expiry (its upper time bound is 0): this signature lets it run at any time${from > nowS ? ` from ${formatTimestamp(Number(from) * 1000)}` : ''}, until its nonce is used.`);
      else if (until >= nowS && until - start > LONG_VALIDITY) ob.warn('info', 'mee_operation_long_validity', `It stays valid until ${formatTimestamp(Number(until) * 1000)}, ${formatDuration(Number(until - start) * 1000)} from ${from > nowS ? 'when it becomes valid' : 'now'}: this signature lets it run at any time until then.`);
    }
    const title = d.title.replace(/^Sign a UserOperation: /, '').replace(/^Sign a UserOperation for /, 'a UserOperation for ');
    titles.push(title);
    b.detail(label, `${title}, from the account ${shortAddress(op.sender)}`, op.sender);
    for (const x of ob.details) b.detail(`${label}: ${x.label}`, x.value, x.raw);
    // Each operation's warnings, its own (two operations can warn alike); the caution that the run used state set by
    // the caller is the preview's, once and unprefixed. "You sign as an owner" only where the account took the
    // stand-in as the signer's: an account that didn't (another's, say) isn't one the signer is shown to sign for.
    for (const w of ob.warnings) {
      if (w.code === 'state_overridden') b.warn(w.severity, w.code, w.message);
      else if (w.code === 'userop_owner_signature' && !d.accepted) continue;
      else b.warnings.push({ ...w, message: `${label}: ${w.message}` });
    }
    // Calls that fail now, which another operation of the supertransaction may change: on another chain (a bridge,
    // which can't be run with it), or on this one where they weren't run before it (see IN_ORDER).
    const fails = ob.warnings.some(w => w.code === 'userop_execution_reverts');
    const elsewhere = chains.length > 1, alongside = !ordered && ops.some((x, j) => j !== i && x.chainId === o.chainId);
    if (fails && (elsewhere || alongside)) b.warn('caution', 'mee_operation_may_depend', `${label}: its calls fail on the chain's state now, but ${alongside ? "the supertransaction's other operations on this chain couldn't be simulated before it, and they" : "operations of the supertransaction on other chains (a bridge, say), which can't be simulated with it,"} may run first and change that state: once they have, it can succeed and do what its calls ask.`);
    // What it does submitted without the operations before it that it doesn't need, where that moves more out of its
    // account than after all of them.
    const more = alone ? outflowsBeyond(alone, d.assetChanges ?? []) : [];
    const list = (js: number[]) => js.length === 1 ? `operation ${js[0] + 1}` : `operations ${js.map(j => j + 1).join(', ')}`;
    const skipped = after.filter(j => !needed.includes(j));
    if (more.length) b.warn('danger', 'mee_operation_alone_differs', `${label}: it was simulated after ${list(after)}, as it would run in order, but its nonce doesn't wait for ${needed.length ? `${list(skipped)}'s (only for ${list(needed)}'s, under its own nonce key)` : 'theirs'}, so anyone holding this signature and the operations can submit it ${needed.length ? `without ${list(skipped)}` : 'alone'}: then it sends ${more.map(c => `${c.amount} ${c.symbol}`).join(', ')}, more than after them, as shown.`);
    // (Each operation's own note that it is an off-chain signature is the preview's, above.)
    for (const n of ob.notes) if (!n.startsWith('This is an off-chain signature')) b.note(`${label}: ${n}`);
    if (ob.trace && !b.trace) b.trace = ob.trace;
    changes.push({ label, chainId: o.chainId, sender: op.sender, changes: d.assetChanges ?? [] });
  }
  if (inOrder && results.some(r => r.after.length)) b.note(`Operations on the same chain were simulated in the order they run (as supplied, but an account's operations under one nonce key in their nonce's order), each on the state the ones before it leave${results.some(r => !r.ordered) ? `: the first ${IN_ORDER} of each chain. Past those, each was simulated alone on its chain's state now (in order, the work grows with the square of their number), so one that depends on another of the same chain is shown failing` : ''}.`);
  else if (!inOrder && chains.some(c => ops.filter(o => o.chainId === c).length > 1)) b.note("Each operation was simulated alone on its chain's state now: this simulator can't run several in order, so one that depends on another of the same chain is shown failing.");
  // Every operation's balance changes, each on its chain; an account's incoming amounts only where it is the only
  // one (or the connected one): see combineChanges.
  const assetChanges = combineChanges(changes, b, context.account);
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

/**
 * The order operations run in, by index: on each chain as supplied, but an account's operations under one nonce key
 * in their nonce's order (the EntryPoint runs them no other way); each chain's apart.
 */
export function runOrder(ops: { chainId: number; sender: string; nonce: bigint }[]): number[] {
  const order = ops.map((_, i) => i);
  const key = (i: number) => `${ops[i].chainId}:${ops[i].sender.toLowerCase()}:${ops[i].nonce >> 64n}`;
  for (const k of new Set(order.map(key))) {
    const at = order.filter(i => key(i) === k);
    const sorted = [...at].sort((a, z) => (ops[a].nonce < ops[z].nonce ? -1 : ops[a].nonce > ops[z].nonce ? 1 : a - z));
    at.forEach((slot, n) => { order[slot] = sorted[n]; });
  }
  return order;
}

/**
 * What `alone` (an operation simulated by itself, or after only the operations it needs) sends beyond `shown` (its
 * changes as shown), per asset and account: its simulated outgoing amounts that exceed what is shown (a call that
 * fails alone, listed only as asked for, sends nothing).
 */
function outflowsBeyond(alone: AssetChange[], shown: AssetChange[]): AssetChange[] {
  const id = (c: AssetChange) => `${(c.asset ?? c.symbol).toLowerCase()}:${c.tokenId ?? ''}:${c.account.toLowerCase()}`;
  const size = (c: AssetChange) => (c.raw !== undefined ? Number(c.raw) : Number(c.amount.replace(/,/g, '')));
  const out = (cs: AssetChange[]) => {
    const m = new Map<string, { c: AssetChange; v: number }>();
    for (const c of cs) if (c.direction === 'out') { const k = id(c), e = m.get(k); m.set(k, { c, v: (e?.v ?? 0) + size(c) }); }
    return m;
  };
  const was = out(shown);
  return [...out(alone.filter(c => c.basis !== 'requested'))].filter(([k, { v }]) => v > (was.get(k)?.v ?? 0)).map(([, { c }]) => c);
}
