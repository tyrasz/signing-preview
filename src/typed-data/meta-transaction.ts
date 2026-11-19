// Signed meta-transactions: a signature that has whoever holds it make a call as the signer (ERC-2771). A relayer
// submits it to a forwarder, which checks it and calls the target with the signer's address appended to the call's
// data; a target that trusts the forwarder (isTrustedForwarder) takes that address as the caller (_msgSender). So
// what the signature does is the inner call, made by the signer, and it is previewed as one:
//   - OpenZeppelin's MinimalForwarder (4.x): ForwardRequest(address from,address to,uint256 value,uint256 gas,
//     uint256 nonce,bytes data), the nonce its getNonce(from); it makes the call whether or not the target trusts it.
//   - OpenZeppelin's ERC2771Forwarder (5.x): ForwardRequest(... uint256 nonce,uint48 deadline,bytes data), the nonce
//     its nonces(from); it refuses a request past its deadline, or for a target that doesn't trust it.
//   - The NativeMetaTransaction of Polygon's PoS-bridged tokens (and Biconomy's EIP712MetaTransaction):
//     MetaTransaction(uint256 nonce,address from,bytes functionSignature) under the token's own domain (the chain as
//     its salt); executeMetaTransaction calls the token itself with the signer appended, so the call is to the token.
//   - Gelato's ERC-2771 relays (verified on Sourcify; GelatoRelay1BalanceERC2771, GelatoRelayERC2771 and their
//     Concurrent forms): SponsoredCallERC2771, CallWithSyncFeeERC2771 (chainId, target, data, user, userNonce or
//     userSalt, userDeadline), each calling the target with the user appended (a sync-fee call also with the fee).
// Either way the value a forwarder sends with the call is the relayer's: it sends it with the request.
import { encodeAbiParameters, keccak256, toFunctionSelector, toHex, type Hex } from 'viem';
import { formatTimestamp, formatUnits, PreviewBuilder, sameAddress, shortAddress } from '../format.ts';
import { chainName, CHAINS } from '../chains.ts';
import { callerOverrides, decodeTransaction, normalizeTransaction, previewTransaction, simulationRequest, warnOverridden, withOverrides, type PresetSimulation } from '../evm/transaction.ts';
import type { SimulationRequest } from '../types.ts';
import { FAILS, TX_DETAILS, TX_ONLY } from './delegation.ts';
import { big, domainChainId, str, type TypedAdapter, type TypedData, type TypedEnv } from './common.ts';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX = /^0x([0-9a-fA-F]{2})*$/;
const fields = (data: TypedData) => data.types[data.primaryType]?.map(f => `${f.type} ${f.name}`).join(',');

type Kind = 'oz4' | 'oz5' | 'polygon' | 'gelato_sponsored' | 'gelato_sponsored_concurrent' | 'gelato_sync_fee' | 'gelato_sync_fee_concurrent';
const SHAPES: Record<string, { primary: string; fields: string; kind: Kind }> = {
  oz4: { primary: 'ForwardRequest', fields: 'address from,address to,uint256 value,uint256 gas,uint256 nonce,bytes data', kind: 'oz4' },
  oz5: { primary: 'ForwardRequest', fields: 'address from,address to,uint256 value,uint256 gas,uint256 nonce,uint48 deadline,bytes data', kind: 'oz5' },
  polygon: { primary: 'MetaTransaction', fields: 'uint256 nonce,address from,bytes functionSignature', kind: 'polygon' },
  gelato_sponsored: { primary: 'SponsoredCallERC2771', fields: 'uint256 chainId,address target,bytes data,address user,uint256 userNonce,uint256 userDeadline', kind: 'gelato_sponsored' },
  gelato_sponsored_concurrent: { primary: 'SponsoredCallConcurrentERC2771', fields: 'uint256 chainId,address target,bytes data,address user,bytes32 userSalt,uint256 userDeadline', kind: 'gelato_sponsored_concurrent' },
  gelato_sync_fee: { primary: 'CallWithSyncFeeERC2771', fields: 'uint256 chainId,address target,bytes data,address user,uint256 userNonce,uint256 userDeadline', kind: 'gelato_sync_fee' },
  gelato_sync_fee_concurrent: { primary: 'CallWithSyncFeeConcurrentERC2771', fields: 'uint256 chainId,address target,bytes data,address user,bytes32 userSalt,uint256 userDeadline', kind: 'gelato_sync_fee_concurrent' },
};
/** Gelato's relays, from their source on Sourcify (the same addresses on every chain they are on). */
const GELATO: Record<string, string> = {
  '0xd8253782c45a12053594b9deb72d8e8ab2fca54c': 'GelatoRelay1BalanceERC2771',
  '0xb539068872230f20456cf38ec52ef2f91af4ae49': 'GelatoRelayERC2771',
  '0xc65d82ece367ef06bf2ab791b3f3cf037dc0e816': 'GelatoRelay1BalanceConcurrentERC2771',
  '0x8598806401a63ddf52473f1b3c55bc9e33e2d73b': 'GelatoRelayConcurrentERC2771',
};
const KIND_LABEL: Record<Kind, string> = {
  oz4: "OpenZeppelin's MinimalForwarder (ERC-2771)", oz5: "OpenZeppelin's ERC2771Forwarder", polygon: 'the token\'s own meta-transactions (executeMetaTransaction)',
  gelato_sponsored: "Gelato's sponsored call (ERC-2771)", gelato_sponsored_concurrent: "Gelato's sponsored call (ERC-2771)",
  gelato_sync_fee: "Gelato's call with a fee (ERC-2771)", gelato_sync_fee_concurrent: "Gelato's call with a fee (ERC-2771)",
};

interface Request { kind: Kind; forwarder: string; target: string; from: string; data: Hex; value: bigint; gas?: bigint; nonce?: bigint; salt?: string; deadline?: bigint; chainId: number | null; messageChainId?: bigint }

function readRequest(data: TypedData, env: TypedEnv): Request | null {
  const shape = Object.values(SHAPES).find(s => s.primary === data.primaryType && s.fields === fields(data));
  if (!shape) return null;
  const m = data.message, forwarder = str(data.domain.verifyingContract).toLowerCase();
  if (!ADDRESS.test(forwarder)) return null;
  // Polygon's tokens put the chain in the domain's salt, as a 32-byte word.
  const salt = str(data.domain.salt);
  const domainChain = domainChainId(data) ?? (/^0x[0-9a-fA-F]{64}$/.test(salt) && BigInt(salt) < 1n << 53n ? Number(BigInt(salt)) : null);
  if (shape.kind === 'oz4' || shape.kind === 'oz5') {
    const from = str(m.from).toLowerCase(), to = str(m.to).toLowerCase(), d = str(m.data), value = big(m.value), gas = big(m.gas), nonce = big(m.nonce), deadline = shape.kind === 'oz5' ? big(m.deadline) : null;
    if (!ADDRESS.test(from) || !ADDRESS.test(to) || !HEX.test(d) || value === null || gas === null || nonce === null || (shape.kind === 'oz5' && deadline === null)) return null;
    return { kind: shape.kind, forwarder, target: to, from, data: d.toLowerCase() as Hex, value, gas, nonce, ...(deadline !== null && { deadline }), chainId: domainChain ?? env.context.chainId ?? null };
  }
  if (shape.kind === 'polygon') {
    const from = str(m.from).toLowerCase(), d = str(m.functionSignature), nonce = big(m.nonce);
    if (!ADDRESS.test(from) || !HEX.test(d) || nonce === null) return null;
    return { kind: 'polygon', forwarder, target: forwarder, from, data: d.toLowerCase() as Hex, value: 0n, nonce, chainId: domainChain ?? env.context.chainId ?? null };
  }
  const user = str(m.user).toLowerCase(), target = str(m.target).toLowerCase(), d = str(m.data), chain = big(m.chainId), deadline = big(m.userDeadline);
  const nonce = shape.kind.endsWith('_concurrent') ? null : big(m.userNonce), userSalt = shape.kind.endsWith('_concurrent') ? str(m.userSalt) : '';
  if (!ADDRESS.test(user) || !ADDRESS.test(target) || !HEX.test(d) || chain === null || deadline === null || (shape.kind.endsWith('_concurrent') ? !/^0x[0-9a-fA-F]{64}$/.test(userSalt) : nonce === null)) return null;
  return { kind: shape.kind, forwarder, target, from: user, data: d.toLowerCase() as Hex, value: 0n, ...(nonce !== null && { nonce }), ...(userSalt && { salt: userSalt.toLowerCase() }), deadline, chainId: domainChain ?? (chain < 1n << 53n ? Number(chain) : null), messageChainId: chain };
}

const word = (address: string) => address.slice(2).toLowerCase().padStart(64, '0');

/** A view call's result as a number, or undefined when it doesn't answer one. */
async function readWord(env: TypedEnv, chainId: number, to: string, data: string): Promise<bigint | undefined> {
  try {
    const r = String(await env.deps.rpc!.call(chainId, 'eth_call', [{ to, data }, 'latest']));
    return /^0x[0-9a-fA-F]{64}$/.test(r) ? BigInt(r) : undefined;
  } catch { return undefined; }
}

export const metaTransactionAdapter: TypedAdapter = async (data, env) => {
  const r = readRequest(data, env);
  if (!r) return null;
  const chainId = r.chainId;
  const b = new PreviewBuilder();
  const gelato = r.kind.startsWith('gelato');
  const relay = gelato ? GELATO[r.forwarder] : undefined;
  b.detail('Kind', KIND_LABEL[r.kind]);
  if (r.kind !== 'polygon') b.detail(gelato ? 'Relay' : 'Forwarder', relay ? `${relay} (${r.forwarder})` : r.forwarder, r.forwarder);
  b.detail(r.kind === 'polygon' ? 'Contract' : 'Calls', r.target, r.target).detail('As', r.from, r.from);
  if (gelato && !relay) b.warn('caution', 'meta_tx_unknown_relay', `${shortAddress(r.forwarder)} isn't one of Gelato's relays, though the request is shaped like theirs: whoever runs that contract decides what it does with your signature.`);
  // The forwarder checks the signature is from the account it names: one signed by another account does nothing.
  if (env.signer && !sameAddress(env.signer, r.from)) b.warn('caution', 'meta_tx_other_account', `It is a call as ${shortAddress(r.from)}, but ${shortAddress(env.signer)} is asked to sign it: the forwarder takes only ${shortAddress(r.from)}'s own signature.`);
  if (r.messageChainId !== undefined && domainChainId(data) !== null && BigInt(domainChainId(data)!) !== r.messageChainId) b.warn('caution', 'meta_tx_chain_mismatch', `It names chain ${r.messageChainId} but is signed for chain ${domainChainId(data)}: the relay refuses it.`);
  if (r.value > 0n) b.detail('Value sent with the call', `${formatUnits(r.value, CHAINS[chainId ?? 0]?.nativeDecimals ?? 18)} ${CHAINS[chainId ?? 0]?.nativeSymbol ?? 'ETH'}, from whoever submits it (the forwarder sends it, not your account)`, r.value.toString());
  if (r.gas !== undefined) b.detail('Gas for the call', r.gas.toLocaleString('en-US'), r.gas.toString());
  const now = BigInt(Math.floor(env.now / 1000));
  if (r.deadline !== undefined && (r.kind === 'oz5' || r.deadline > 0n)) {
    b.detail('Valid until', r.deadline >= 1n << 47n ? 'no expiry' : formatTimestamp(Number(r.deadline) * 1000), r.deadline.toString());
    if (r.deadline < now) b.warn('info', 'meta_tx_expired', 'Its deadline has passed: the forwarder refuses it.');
  } else if (gelato) b.detail('Valid until', 'no expiry');
  if (r.nonce !== undefined) b.detail('Nonce', r.nonce.toString());
  if (r.salt) b.detail('Salt', r.salt);

  // What the chain says: the nonce (or the call's hash) unused, and the target trusting the forwarder.
  const readable = chainId !== null && env.deps.rpc?.has(chainId);
  if (readable) {
    const nonceCall = r.kind === 'oz5' ? '0x7ecebe00' : r.kind === 'oz4' || r.kind === 'polygon' ? '0x2d0335ab' : r.nonce !== undefined ? toFunctionSelector('userNonce(address)') : undefined;
    if (nonceCall && r.nonce !== undefined) {
      const current = await readWord(env, chainId, r.forwarder, `${nonceCall}${word(r.from)}`);
      if (current !== undefined && r.nonce < current) b.warn('info', 'meta_tx_nonce_used', `The account's nonce there is already ${current}: a request with nonce ${r.nonce} was used, so this one can't be.`);
      else if (current !== undefined && r.nonce > current) b.warn('info', 'meta_tx_nonce_ahead', `The account's nonce there is ${current}: ${r.nonce - current} other request${r.nonce - current === 1n ? '' : 's'} must run before this one can.`);
    }
    if (r.salt) {
      // Gelato's concurrent relays mark each call's hash (the struct's) as used.
      const typehash = keccak256(toHex(`${data.primaryType}(${SHAPES[r.kind].fields})`));
      const hash = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'bytes32' }, { type: 'address' }, { type: 'bytes32' }, { type: 'uint256' }],
        [typehash, r.messageChainId!, r.target as Hex, keccak256(r.data), r.from as Hex, r.salt as Hex, r.deadline!]));
      if (await readWord(env, chainId, r.forwarder, `${toFunctionSelector('hashUsed(bytes32)')}${hash.slice(2)}`) === 1n) b.warn('info', 'meta_tx_nonce_used', 'This call was already relayed (its hash is marked used), so it can\'t be again.');
    }
    if (r.kind !== 'polygon') {
      const trusted = await readWord(env, chainId, r.target, `0x572b6c05${word(r.forwarder)}`);
      if (trusted === 0n) b.warn('info', 'meta_tx_untrusted', r.kind === 'oz5'
        ? `${shortAddress(r.target)} doesn't trust this forwarder (isTrustedForwarder), so the forwarder refuses the request: it can't act as you.`
        : `${shortAddress(r.target)} doesn't trust this ${gelato ? 'relay' : 'forwarder'} (isTrustedForwarder), so the call runs as the ${gelato ? 'relay' : 'forwarder'} itself, not as you.`);
    }
  } else b.note('Whether the nonce is unused and the contract called trusts the forwarder wasn\'t checked (no RPC for this chain).');

  // The inner call, as the account's own transaction: decoded so, and simulated as the forwarder makes it.
  const inner = chainId !== null ? { from: r.from, to: r.target, value: '0x0', data: r.data } : null;
  if (!inner || chainId === null) return null;
  const context = { ...env.context, chainId, account: undefined };
  const tx = normalizeTransaction(inner, context, r.from, chainId);
  const d = await decodeTransaction(tx, env.deps, context);
  let preset: PresetSimulation | undefined;
  if (env.deps.simulator) {
    if (r.kind === 'gelato_sync_fee' || r.kind === 'gelato_sync_fee_concurrent') preset = { skipped: "Not simulated: Gelato's relay appends the fee it charges, which its relayer sets when it submits the call." };
    else {
      const overrides = callerOverrides(env.context);
      const request: SimulationRequest = { ...simulationRequest(tx, d), from: r.forwarder, account: r.from, data: `${r.data}${r.from.slice(2)}`, value: r.value };
      const own = r.value > 0n ? { [r.forwarder]: { balance: `0x${r.value.toString(16)}` } } : undefined;
      const stateOverrides = withOverrides(overrides, own);
      if (stateOverrides) request.stateOverrides = stateOverrides;
      warnOverridden(b, overrides);
      try { preset = { result: await env.deps.simulator.simulate(request) }; } catch (e) { preset = { error: (e as Error).message }; }
    }
  }
  const p = await previewTransaction(tx, env.deps, context, 'eth_sendTransaction', preset, d);
  for (const detail of p.details) if (!TX_DETAILS.test(detail.label)) b.detail(detail.label, detail.value, detail.raw);
  const failing = p.simulation?.status === 'reverted';
  if (failing) b.warn('caution', 'meta_tx_fails', `The call would fail if submitted now${p.simulation?.revertReason ? ` (${p.simulation.revertReason})` : ''}: nothing would move, and whoever submits it pays the fee.`);
  for (const w of p.warnings) if (!TX_ONLY.has(w.code) && !FAILS.has(w.code)) b.warn(w.severity, w.code, w.message);
  if (p.simulation?.status === 'success') b.note(`Simulated as the ${r.kind === 'polygon' ? 'token runs it: from itself' : gelato ? 'relay makes it' : 'forwarder makes it'}, with your address appended (ERC-2771), on the current state. The ${r.kind === 'polygon' ? 'token' : gelato ? 'relay' : 'forwarder'}'s own checks of the signature, nonce and deadline are shown above, not simulated.`);
  for (const n of p.decoding.notes) b.note(n);
  if (p.trace) b.trace = p.trace;
  b.note(`An off-chain signature: it costs nothing now. Whoever holds it can submit it${gelato ? " through Gelato's relayers" : ' to the forwarder'}, and the call then runs as your account, as if you had sent it.`);
  const call = p.title.replace(/^(Send|Sign|Submit) (a )?transaction: /i, '');
  return {
    title: `Gasless call as ${env.signer && sameAddress(env.signer, r.from) ? 'you' : shortAddress(r.from)}: ${call}`,
    summary: `A signed meta-transaction (${KIND_LABEL[r.kind]}): whoever submits it makes this call to ${shortAddress(r.target)} as ${shortAddress(r.from)}. ${p.summary}`,
    decoder: `meta_tx_${r.kind}`, status: p.decoding.status, b,
    network: { kind: 'evm', chainId, name: chainName(chainId) },
    assetChanges: failing ? [] : p.assetChanges, ...(!failing && p.approvals?.length && { approvals: p.approvals }),
  };
};
