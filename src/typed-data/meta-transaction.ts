// Signed meta-transactions: a signature that has whoever holds it make a call as the signer (ERC-2771). A relayer
// submits it to a forwarder, which checks it and calls the target with the signer's address appended to the call's
// data; a target that trusts the forwarder (isTrustedForwarder) takes that address as the caller (_msgSender). So
// what the signature does is the inner call, made by the signer, and it is previewed as one:
//   - OpenZeppelin's MinimalForwarder (4.x): ForwardRequest(address from,address to,uint256 value,uint256 gas,
//     uint256 nonce,bytes data), the nonce its getNonce(from); it makes the call whether or not the target trusts it,
//     and a call that fails still uses the nonce.
//   - OpenZeppelin's ERC2771Forwarder (5.x): ForwardRequest(... uint256 nonce,uint48 deadline,bytes data), the nonce
//     its nonces(from); it refuses a request past its deadline, or for a target that doesn't trust it, and reverts
//     when the call fails.
//   - The NativeMetaTransaction of Polygon's PoS-bridged tokens (and Biconomy's EIP712MetaTransaction):
//     MetaTransaction(uint256 nonce,address from,bytes functionSignature) under the token's own domain (the chain as
//     its salt); executeMetaTransaction calls the token itself with the signer appended, so the call is to the token.
//   - Gelato's ERC-2771 relays (verified on Sourcify; GelatoRelay1BalanceERC2771, GelatoRelayERC2771 and their
//     Concurrent forms, each under its own name, version "1"): SponsoredCallERC2771, CallWithSyncFeeERC2771 (chainId,
//     target, data, user, userNonce or userSalt, userDeadline), each calling the target with the user appended (a
//     sync-fee call with the fee collector, and the fee token and fee where the relayer says so, before it).
// Either way the value a forwarder sends with the call is the relayer's: it sends it with the request.
import { encodeAbiParameters, keccak256, toFunctionSelector, toHex, type Hex } from 'viem';
import { formatTimestamp, formatUnits, PreviewBuilder, sameAddress, shortAddress } from '../format.ts';
import { chainName, CHAINS } from '../chains.ts';
import { isRpcError } from '../rpc.ts';
import { callerOverrides, decodeTransaction, previewTransaction, simulationRequest, warnOverridden, withOverrides, type PresetSimulation } from '../evm/transaction.ts';
import type { Tx } from '../evm/common.ts';
import { noTrace, tracePreviews } from '../evm/trace.ts';
import type { SimulationRequest, SimulationResult } from '../types.ts';
import { FAILS, TX_DETAILS, TX_ONLY } from './delegation.ts';
import { str, type TypedAdapter, type TypedData, type TypedDecoded, type TypedEnv } from './common.ts';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const fields = (data: TypedData) => data.types[data.primaryType]?.map(f => `${f.type} ${f.name}`).join(',');

type Kind = 'oz4' | 'oz5' | 'polygon' | 'gelato_sponsored' | 'gelato_sponsored_concurrent' | 'gelato_sync_fee' | 'gelato_sync_fee_concurrent';
const SHAPES: { primary: string; fields: string; kind: Kind }[] = [
  { primary: 'ForwardRequest', fields: 'address from,address to,uint256 value,uint256 gas,uint256 nonce,bytes data', kind: 'oz4' },
  { primary: 'ForwardRequest', fields: 'address from,address to,uint256 value,uint256 gas,uint256 nonce,uint48 deadline,bytes data', kind: 'oz5' },
  { primary: 'MetaTransaction', fields: 'uint256 nonce,address from,bytes functionSignature', kind: 'polygon' },
  { primary: 'SponsoredCallERC2771', fields: 'uint256 chainId,address target,bytes data,address user,uint256 userNonce,uint256 userDeadline', kind: 'gelato_sponsored' },
  { primary: 'SponsoredCallConcurrentERC2771', fields: 'uint256 chainId,address target,bytes data,address user,bytes32 userSalt,uint256 userDeadline', kind: 'gelato_sponsored_concurrent' },
  { primary: 'CallWithSyncFeeERC2771', fields: 'uint256 chainId,address target,bytes data,address user,uint256 userNonce,uint256 userDeadline', kind: 'gelato_sync_fee' },
  { primary: 'CallWithSyncFeeConcurrentERC2771', fields: 'uint256 chainId,address target,bytes data,address user,bytes32 userSalt,uint256 userDeadline', kind: 'gelato_sync_fee_concurrent' },
];
/** Gelato's relays, from their source on Sourcify (the same addresses on every chain they are on): each takes one kind of request, under its own name. */
const GELATO: Record<string, { name: string; kind: Kind }> = {
  '0xd8253782c45a12053594b9deb72d8e8ab2fca54c': { name: 'GelatoRelay1BalanceERC2771', kind: 'gelato_sponsored' },
  '0xb539068872230f20456cf38ec52ef2f91af4ae49': { name: 'GelatoRelayERC2771', kind: 'gelato_sync_fee' },
  '0xc65d82ece367ef06bf2ab791b3f3cf037dc0e816': { name: 'GelatoRelay1BalanceConcurrentERC2771', kind: 'gelato_sponsored_concurrent' },
  '0x8598806401a63ddf52473f1b3c55bc9e33e2d73b': { name: 'GelatoRelayConcurrentERC2771', kind: 'gelato_sync_fee_concurrent' },
};
const KIND_LABEL: Record<Kind, string> = {
  oz4: "OpenZeppelin's MinimalForwarder (ERC-2771)", oz5: "OpenZeppelin's ERC2771Forwarder", polygon: "the token's own meta-transactions (executeMetaTransaction)",
  gelato_sponsored: "Gelato's sponsored call (ERC-2771)", gelato_sponsored_concurrent: "Gelato's sponsored call (ERC-2771)",
  gelato_sync_fee: "Gelato's call with a fee (ERC-2771)", gelato_sync_fee_concurrent: "Gelato's call with a fee (ERC-2771)",
};

/** An unsigned integer as signers read one: a decimal or hex string, or a whole JSON number; null otherwise, or at 2^bits. */
function uint(v: unknown, bits = 256): bigint | null {
  let n: bigint;
  if (typeof v === 'number') { if (!Number.isInteger(v)) return null; n = BigInt(v); }
  else if (typeof v === 'bigint') n = v;
  else if (typeof v === 'string' && /^(0x[0-9a-fA-F]{1,64}|[0-9]{1,78})$/.test(v)) n = BigInt(v);
  else return null;
  return n >= 0n && n < 1n << BigInt(bits) ? n : null;
}
/** Bytes as signers read hex (viem, eth-sig-util): an odd number of digits gets a leading 0. */
function bytes(v: unknown): Hex | null {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]*$/.test(v)) return null;
  const h = v.slice(2).toLowerCase();
  return `0x${h.length % 2 ? '0' : ''}${h}` as Hex;
}
const address = (v: unknown) => (typeof v === 'string' && ADDRESS.test(v) ? v.toLowerCase() : null);
const chainOf = (n: bigint | null) => (n !== null && n > 0n && n < 1n << 53n ? Number(n) : null);

/**
 * The chain the signature is bound to, from the domain's typed fields only (a field the domain types leave out isn't
 * signed): its chainId, or for Polygon's tokens its salt. Without EIP712Domain types, every field given is signed.
 */
function typedChain(data: TypedData): number | null {
  const typed = new Set(data.types.EIP712Domain ? data.types.EIP712Domain.map(f => f.name) : Object.keys(data.domain));
  if (typed.has('chainId')) return chainOf(uint(data.domain.chainId));
  const salt = str(data.domain.salt);
  if (typed.has('salt') && /^0x[0-9a-fA-F]{64}$/.test(salt)) return chainOf(BigInt(salt));
  return null;
}

interface Request { kind: Kind; forwarder: string; target: string; from: string; data: Hex; value: bigint; gas?: bigint; nonce?: bigint; salt?: string; deadline?: bigint; chainId: number | null; messageChainId?: bigint }

/** The request, 'unreadable' where its type is one of these but a value doesn't read as signers read it, else null. */
function readRequest(data: TypedData, env: TypedEnv): Request | 'unreadable' | null {
  const shape = SHAPES.find(s => s.primary === data.primaryType && s.fields === fields(data));
  if (!shape) return null;
  const m = data.message, forwarder = address(data.domain.verifyingContract);
  if (!forwarder) return 'unreadable';
  const domainChain = typedChain(data);
  if (shape.kind === 'oz4' || shape.kind === 'oz5') {
    const from = address(m.from), to = address(m.to), d = bytes(m.data), value = uint(m.value), gas = uint(m.gas), nonce = uint(m.nonce), deadline = shape.kind === 'oz5' ? uint(m.deadline, 48) : null;
    if (!from || !to || !d || value === null || gas === null || nonce === null || (shape.kind === 'oz5' && deadline === null)) return 'unreadable';
    return { kind: shape.kind, forwarder, target: to, from, data: d, value, gas, nonce, ...(deadline !== null && { deadline }), chainId: domainChain ?? env.context.chainId ?? null };
  }
  if (shape.kind === 'polygon') {
    const from = address(m.from), d = bytes(m.functionSignature), nonce = uint(m.nonce);
    if (!from || !d || nonce === null) return 'unreadable';
    return { kind: 'polygon', forwarder, target: forwarder, from, data: d, value: 0n, nonce, chainId: domainChain ?? env.context.chainId ?? null };
  }
  const concurrent = shape.kind.endsWith('_concurrent');
  const user = address(m.user), target = address(m.target), d = bytes(m.data), chain = uint(m.chainId), deadline = uint(m.userDeadline);
  const nonce = concurrent ? null : uint(m.userNonce), userSalt = concurrent ? str(m.userSalt) : '';
  if (!user || !target || !d || chain === null || deadline === null || (concurrent ? !/^0x[0-9a-fA-F]{64}$/.test(userSalt) : nonce === null)) return 'unreadable';
  return { kind: shape.kind, forwarder, target, from: user, data: d, value: 0n, ...(nonce !== null && { nonce }), ...(userSalt && { salt: userSalt.toLowerCase() }), deadline, chainId: domainChain ?? chainOf(chain) ?? env.context.chainId ?? null, messageChainId: chain };
}

const word = (a: string) => a.slice(2).toLowerCase().padStart(64, '0');

/** A view call's result as a number, or undefined when it doesn't answer one. */
async function readWord(env: TypedEnv, chainId: number, to: string, data: string): Promise<bigint | undefined> {
  try {
    const r = String(await env.deps.rpc!.call(chainId, 'eth_call', [{ to, data }, 'latest']));
    return /^0x[0-9a-fA-F]{64}$/.test(r) ? BigInt(r) : undefined;
  } catch { return undefined; }
}

/**
 * Whether `target` trusts `forwarder`, as OpenZeppelin 5's forwarder asks it (a staticcall of isTrustedForwarder that
 * succeeds with a word that isn't zero): 'yes', 'no', 'silent' (it reverts or answers too little), or undefined when
 * the RPC itself failed.
 */
async function trusts(env: TypedEnv, chainId: number, target: string, forwarder: string): Promise<'yes' | 'no' | 'silent' | undefined> {
  try {
    const r = String(await env.deps.rpc!.call(chainId, 'eth_call', [{ to: target, data: `0x572b6c05${word(forwarder)}` }, 'latest']));
    if (!/^0x[0-9a-fA-F]{64}/.test(r)) return 'silent';
    return BigInt(r.slice(0, 66)) === 0n ? 'no' : 'yes';
  } catch (e) { return isRpcError(e) ? 'silent' : undefined; }
}

/** The gas a transaction needs before its call runs: 21,000 and its calldata (EIP-2028), at least the EIP-7623 floor. */
function intrinsic(data: string): { standard: bigint; floor: bigint } {
  let zero = 0n, other = 0n;
  for (let i = 2; i < data.length; i += 2) { if (data.slice(i, i + 2) === '00') zero++; else other++; }
  return { standard: 21_000n + 4n * zero + 16n * other, floor: 21_000n + 10n * (zero + 4n * other) };
}

/** A request whose type is one of these but whose values don't read: what it calls can't be shown. */
function unreadable(data: TypedData, env: TypedEnv): TypedDecoded {
  const b = new PreviewBuilder().detail('Kind', data.primaryType).detail('Forwarder', str(data.domain.verifyingContract));
  b.warn('danger', 'meta_tx_unreadable', "This is a signature that has a relayer make a call as you (a meta-transaction), but its call or account doesn't read as an address and hex data: what it would do can't be shown. Don't sign it.");
  const chainId = typedChain(data) ?? env.context.chainId ?? null;
  return { title: `Sign a meta-transaction whose call can't be read (${data.primaryType})`, summary: "A signed call to be made as you, whose contents can't be read.", decoder: 'meta_tx_unreadable', status: 'opaque', b, network: chainId !== null ? { kind: 'evm', chainId, name: chainName(chainId) } : null };
}

export const metaTransactionAdapter: TypedAdapter = async (data, env) => {
  const r = readRequest(data, env);
  if (r === null) return null;
  if (r === 'unreadable') return unreadable(data, env);
  const chainId = r.chainId;
  const b = new PreviewBuilder();
  const gelato = r.kind.startsWith('gelato');
  const relay = gelato ? GELATO[r.forwarder] : undefined;
  b.detail('Kind', KIND_LABEL[r.kind]);
  if (r.kind !== 'polygon') b.detail(gelato ? 'Relay' : 'Forwarder', relay ? `${relay.name} (${r.forwarder})` : r.forwarder, r.forwarder);
  b.detail(r.kind === 'polygon' ? 'Contract' : 'Calls', r.target, r.target).detail('As', r.from, r.from);
  if (gelato && !relay) b.warn('caution', 'meta_tx_unknown_relay', `${shortAddress(r.forwarder)} isn't one of Gelato's relays, though the request is shaped like theirs: whoever runs that contract decides what it does with your signature.`);
  // Each of Gelato's relays takes one kind of request, signed under its own name: another can't be used there.
  if (relay && relay.kind !== r.kind) b.warn('info', 'meta_tx_wrong_relay', `${relay.name} doesn't take ${data.primaryType} requests, so the signature can't be used there.`);
  else if (relay && (str(data.domain.name) !== relay.name || str(data.domain.version) !== '1')) b.warn('info', 'meta_tx_wrong_relay', `It is signed under the name "${str(data.domain.name)}" (version "${str(data.domain.version)}"), but ${relay.name} checks signatures under its own name, version "1": it can't be used there.`);
  // The forwarder checks the signature is from the account it names: one signed by another account does nothing.
  if (env.signer && !sameAddress(env.signer, r.from)) b.warn('caution', 'meta_tx_other_account', `It is a call as ${shortAddress(r.from)}, but ${shortAddress(env.signer)} is asked to sign it: the forwarder takes only ${shortAddress(r.from)}'s own signature.`);
  const signedChain = typedChain(data);
  if (r.messageChainId !== undefined && signedChain !== null && BigInt(signedChain) !== r.messageChainId) b.warn('caution', 'meta_tx_chain_mismatch', `It names chain ${r.messageChainId} but is signed for chain ${signedChain}: the relay refuses it.`);
  if (chainId !== null && env.context.chainId && chainId !== env.context.chainId) b.warn('caution', 'chain_mismatch', `The signature is for ${chainName(chainId)}, but the wallet is on ${chainName(env.context.chainId)}.`);
  if (r.value > 0n) b.detail('Value sent with the call', `${formatUnits(r.value, CHAINS[chainId ?? 0]?.nativeDecimals ?? 18)} ${CHAINS[chainId ?? 0]?.nativeSymbol ?? 'ETH'}, from whoever submits it (the forwarder sends it, not your account)`, r.value.toString());
  if (r.gas !== undefined) b.detail('Gas for the call', r.gas.toLocaleString('en-US'), r.gas.toString());
  const now = BigInt(Math.floor(env.now / 1000));
  const expires = r.deadline !== undefined && (r.kind === 'oz5' || r.deadline > 0n) && r.deadline < 1n << 47n;
  if (expires) b.detail('Valid until', formatTimestamp(Number(r.deadline) * 1000), r.deadline!.toString());
  else b.detail('Valid until', 'no expiry');
  if (expires && r.deadline! < now) b.warn('info', 'meta_tx_expired', 'Its deadline has passed: the forwarder refuses it.');
  if (r.nonce !== undefined) b.detail('Nonce', r.nonce.toString());
  if (r.salt) b.detail('Salt', r.salt);
  if (chainId === null) {
    b.warn('caution', 'meta_tx_chain_unknown', "Which chain it is for isn't part of what is signed, nor known to the wallet: it is valid wherever the forwarder is, and its call can't be read for a chain.");
    return { title: `Gasless call as ${env.signer && sameAddress(env.signer, r.from) ? 'you' : shortAddress(r.from)} to ${shortAddress(r.target)} (chain unknown)`, summary: `A signed meta-transaction (${KIND_LABEL[r.kind]}): whoever submits it makes a call to ${shortAddress(r.target)} as ${shortAddress(r.from)}.`, decoder: `meta_tx_${r.kind}`, status: 'partial', b, network: null };
  }

  // What the chain says: the nonce (or the call's hash) unused, and the target trusting the forwarder.
  if (env.deps.rpc?.has(chainId)) {
    const nonceCall = r.kind === 'oz5' ? '0x7ecebe00' : r.kind === 'oz4' || r.kind === 'polygon' ? '0x2d0335ab' : r.nonce !== undefined ? toFunctionSelector('userNonce(address)') : undefined;
    if (nonceCall && r.nonce !== undefined) {
      const current = await readWord(env, chainId, r.forwarder, `${nonceCall}${word(r.from)}`);
      if (current !== undefined && r.nonce < current) b.warn('info', 'meta_tx_nonce_used', `The account's nonce there is already ${current}: a request with nonce ${r.nonce} was used, so this one can't be.`);
      else if (current !== undefined && r.nonce > current) b.warn('info', 'meta_tx_nonce_ahead', `The account's nonce there is ${current}: ${r.nonce - current} other request${r.nonce - current === 1n ? '' : 's'} must run before this one can.`);
    }
    if (r.salt) {
      // Gelato's concurrent relays mark each call's hash (the struct's) as used.
      try {
        const typehash = keccak256(toHex(`${data.primaryType}(${fields(data)})`));
        const hash = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'bytes32' }, { type: 'address' }, { type: 'bytes32' }, { type: 'uint256' }],
          [typehash, r.messageChainId!, r.target as Hex, keccak256(r.data), r.from as Hex, r.salt as Hex, r.deadline!]));
        if (await readWord(env, chainId, r.forwarder, `${toFunctionSelector('hashUsed(bytes32)')}${hash.slice(2)}`) === 1n) b.warn('info', 'meta_tx_nonce_used', "This call was already relayed (its hash is marked used), so it can't be again.");
      } catch { /* not read */ }
    }
    if (r.kind !== 'polygon') {
      const trust = await trusts(env, chainId, r.target, r.forwarder);
      const as = gelato ? 'relay' : 'forwarder';
      if (trust === 'no' || trust === 'silent') b.warn('info', 'meta_tx_untrusted', `${shortAddress(r.target)} ${trust === 'no' ? `doesn't trust this ${as}` : "doesn't answer isTrustedForwarder (it may not take ERC-2771 calls at all)"}${r.kind === 'oz5' ? ', so the forwarder refuses the request: it can\'t act as you' : `, so the call runs as the ${as} itself, not as you`} (as things stand: a contract whose owner can change whom it trusts could trust it later).`);
    }
  } else b.note("Whether the nonce is unused and the contract called trusts the forwarder wasn't checked (no RPC for this chain).");

  // The inner call, as the account's own transaction: decoded so, and simulated as the forwarder makes it. A past
  // block named for the preview (context.block) isn't used: a signature is previewed on the latest state.
  const context = { ...env.context, chainId, account: undefined, block: undefined, pinned: undefined, replay: undefined };
  const tx: Tx = { chainId, from: r.from, to: r.target, data: r.data, value: 0n };
  const d = await decodeTransaction(tx, env.deps, context);
  let preset: PresetSimulation | undefined;
  let ran: SimulationRequest | undefined;
  const syncFee = r.kind === 'gelato_sync_fee' || r.kind === 'gelato_sync_fee_concurrent';
  if (env.deps.simulator) {
    const overrides = callerOverrides(env.context);
    const user = r.from.slice(2);
    // Gelato's sync-fee calls carry the fee collector (and, in its relay context, the fee token and fee) before the
    // user: run with no fee, in the relay context's form first, then the other.
    const suffixes = syncFee ? [`${r.forwarder.slice(2)}${NATIVE.slice(2)}${'0'.repeat(64)}${user}`, `${r.forwarder.slice(2)}${user}`] : [user];
    const own = r.value > 0n ? { [r.forwarder]: { balance: `0x${r.value.toString(16)}` } } : undefined;
    const stateOverrides = withOverrides(overrides, own);
    try {
      let result: SimulationResult | null = null;
      for (const suffix of suffixes) {
        const request: SimulationRequest = { ...simulationRequest(tx, d), from: r.forwarder, account: r.from, data: `${r.data}${suffix}`, value: r.value, ...(stateOverrides && { stateOverrides }) };
        // OpenZeppelin's forwarders give the call exactly the gas signed (Arbitrum's node takes its L1 gas out of the
        // limit, so there it isn't set).
        if ((r.kind === 'oz4' || r.kind === 'oz5') && r.gas !== undefined && r.gas <= 30_000_000n && chainId !== 42161) {
          const need = intrinsic(request.data);
          request.gas = r.gas + need.standard > need.floor ? r.gas + need.standard : need.floor;
        }
        result = await env.deps.simulator.simulate(request);
        ran = request;
        if (result?.status !== 'reverted') break;
      }
      preset = { result };
      warnOverridden(b, overrides);
    } catch (e) { preset = { error: (e as Error).message }; }
  }
  const p = await previewTransaction(tx, env.deps, context, 'eth_sendTransaction', preset, d);
  for (const detail of p.details) if (!TX_DETAILS.test(detail.label)) b.detail(detail.label, detail.value, detail.raw);
  const failing = p.simulation?.status === 'reverted';
  // A call that fails now moves nothing now, but the signature stays usable until its nonce is used or it expires.
  const until = expires ? `until ${formatTimestamp(Number(r.deadline) * 1000)}` : 'with no expiry';
  if (failing) b.warn('caution', 'meta_tx_fails', `The call would fail if submitted now${p.simulation?.revertReason ? ` (${p.simulation.revertReason})` : ''}: nothing would move now. But the signature stays valid ${until}, until it is used: whoever holds it can submit it once the call would succeed. What it moves then is shown as signed.`);
  for (const w of p.warnings) if (!TX_ONLY.has(w.code) && !FAILS.has(w.code)) b.warn(w.severity, w.code, w.message);
  if (p.simulation?.status === 'success') b.note(`Simulated as the ${r.kind === 'polygon' ? 'token runs it: from itself' : gelato ? 'relay makes it' : 'forwarder makes it'}, with your address appended (ERC-2771), on the current state${syncFee ? ", with no fee: Gelato's relayer sets the fee it appends, which the contract called pays (and may charge you for)" : ''}. The ${r.kind === 'polygon' ? 'token' : gelato ? 'relay' : 'forwarder'}'s own checks of the signature, nonce and deadline are shown above, not simulated; so is whom it is sent by (tx.origin).`);
  for (const n of p.decoding.notes) b.note(n);
  // The trace of the call as simulated (PreviewContext.trace).
  if (env.context.trace && ran && preset && 'result' in preset && preset.result && !preset.result.limited) {
    const traceEnv = { chainId, account: r.from, accountLabel: 'you', deps: env.deps };
    const traces = await tracePreviews([ran], [preset.result], traceEnv).catch(() => null);
    if (traces?.[0]) b.trace = traces[0];
    else b.note(noTrace(traceEnv));
  } else if (p.trace) b.trace = p.trace;
  b.note(`An off-chain signature: it costs nothing now. Whoever holds it can submit it${gelato ? " through Gelato's relayers" : ' to the forwarder'}, and the call then runs as your account, as if you had sent it.`);
  const call = p.title.replace(/^(Send|Sign|Submit) (a )?transaction: /i, '');
  return {
    title: `Gasless call as ${env.signer && sameAddress(env.signer, r.from) ? 'you' : shortAddress(r.from)}: ${call}`,
    summary: `A signed meta-transaction (${KIND_LABEL[r.kind]}): whoever submits it makes this call to ${shortAddress(r.target)} as ${shortAddress(r.from)}. ${p.summary}`,
    decoder: `meta_tx_${r.kind}`, status: p.decoding.status, b,
    network: { kind: 'evm', chainId, name: chainName(chainId) },
    assetChanges: p.assetChanges, ...(!failing && p.approvals?.length && { approvals: p.approvals }),
  };
};
