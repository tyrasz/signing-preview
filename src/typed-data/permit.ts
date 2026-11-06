import { formatDuration, formatTimestamp, formatUnits, isUnlimited, PreviewBuilder, sameAddress, shortAddress } from '../format.ts';
import { chainName, PERMIT2 } from '../chains.ts';
import { tokenSourceWarnings } from '../evm/common.ts';
import type { TokenInfo } from '../types.ts';
import { big, domainChainId, str, type TypedAdapter, type TypedDecoded, type TypedEnv, type TypedData } from './common.ts';
import { canMoveNow } from './exposure.ts';

/** One eth_call's 32-byte words, or undefined without an RPC (or on failure). */
async function words(env: TypedEnv, chainId: number | null, to: string, data: string): Promise<bigint[] | undefined> {
  if (chainId === null || !env.deps.rpc?.has(chainId)) return undefined;
  try {
    const r = String(await env.deps.rpc.call(chainId, 'eth_call', [{ to, data }, 'latest']));
    return /^0x([0-9a-f]{64})+$/i.test(r) ? (r.slice(2).match(/.{64}/g) ?? []).map(w => BigInt(`0x${w}`)) : undefined;
  } catch { return undefined; }
}
const w = (v: string | bigint) => (typeof v === 'bigint' ? v.toString(16) : v.toLowerCase().replace(/^0x/, '')).padStart(64, '0');

/** A signature whose nonce isn't the next one can't be used (or only after the ones before it). */
function nonceCheck(b: PreviewBuilder, signed: bigint | null, current: bigint | undefined, what: string) {
  if (signed === null || current === undefined) return;
  if (signed < current) b.warn('info', 'signature_nonce_used', `This ${what} uses nonce ${signed}, but the next is ${current}: it was already used or superseded, so it can't be used.`);
  else if (signed > current) b.warn('info', 'signature_nonce_ahead', `This ${what} uses nonce ${signed}; it can only be used after the ${signed - current} before it (the next is ${current}).`);
}

async function token(env: TypedEnv, chainId: number | null, address: string): Promise<TokenInfo | undefined> {
  if (chainId === null) return undefined;
  try { return (await env.deps.tokens?.get(chainId, address)) ?? undefined; } catch { return undefined; }
}

function amountText(raw: bigint | null, info: TokenInfo | undefined, address: string): string {
  if (raw === null) return 'unknown amount';
  if (isUnlimited(raw)) return `unlimited ${info?.symbol ?? 'tokens'}`;
  return info ? `${formatUnits(raw, info.decimals)} ${info.symbol}` : `${raw} base units of ${shortAddress(address)}`;
}

function deadline(b: PreviewBuilder, env: TypedEnv, label: string, value: unknown) {
  const secs = big(value);
  if (secs === null) return;
  if (secs >= 1n << 47n) { b.detail(label, 'Never'); b.warn('caution', 'no_expiry', 'This signature never expires; it stays usable until the nonce is consumed.'); return; }
  const ms = Number(secs) * 1000;
  b.detail(label, formatTimestamp(ms), secs.toString());
  if (ms < env.now) b.warn('info', 'expired', 'This signature has already expired.');
  else if (ms - env.now > 30 * 86_400_000) b.warn('caution', 'long_expiry', `This signature stays valid for ${formatDuration(ms - env.now)}.`);
}

/** Gasless approvals: ERC-2612 / DAI permit and Uniswap Permit2. A signature here can move tokens later. */
export const permitAdapter: TypedAdapter = async (data, env) => {
  const chainId = domainChainId(data);
  const network = chainId !== null ? { kind: 'evm' as const, chainId, name: chainName(chainId) } : null;
  const m = data.message;
  const b = new PreviewBuilder();
  const result = (title: string, summary: string, decoder: string, status: TypedDecoded['status']): TypedDecoded => ({ title, summary, decoder, status, b, network });
  const offChainNote = () => b.note('This is an off-chain signature: it costs no gas now, but anyone holding it can submit it later to use the permission.');

  if (data.primaryType === 'Permit' && (m.spender !== undefined)) {
    const tokenAddress = str(data.domain.verifyingContract);
    const info = await token(env, chainId, tokenAddress);
    if (chainId !== null) tokenSourceWarnings(b, chainId, info);
    const spender = str(m.spender);
    const daiStyle = m.allowed !== undefined;
    const value = daiStyle ? (m.allowed === true || m.allowed === 'true' ? (1n << 256n) - 1n : 0n) : big(m.value);
    b.detail('Token', info ? `${info.symbol} (${tokenAddress})` : `${str(data.domain.name)} (${tokenAddress})`, tokenAddress)
      .detail('Owner', str(m.owner ?? m.holder)).detail('Spender', spender).detail('Allowance', amountText(value, info, tokenAddress), value?.toString());
    deadline(b, env, 'Signature valid until', m.deadline ?? m.expiry);
    if (value !== null && isUnlimited(value)) b.warn('caution', 'unlimited_permit', `${shortAddress(spender)} will be able to move all of this token from your wallet.`);
    if (env.signer && !sameAddress(str(m.owner ?? m.holder), env.signer)) b.warn('danger', 'permit_owner_mismatch', 'The permit owner is not the signing account.');
    if (!info) b.warn('caution', 'unknown_token', 'The token is not in the known-token list; its name comes from the signing domain and is unverified.');
    const owner = str(m.owner ?? m.holder);
    if (value !== 0n) await canMoveNow(env, b, chainId, owner, tokenAddress, info, value);
    nonceCheck(b, big(m.nonce), (await words(env, chainId, tokenAddress, `0x7ecebe00${w(owner)}`))?.[0], 'permit');
    offChainNote();
    return result(value === 0n ? `Revoke ${info?.symbol ?? 'token'} permission for ${shortAddress(spender)}` : `Allow ${shortAddress(spender)} to spend ${amountText(value, info, tokenAddress)}`,
      `Signs a gasless approval (permit) letting ${shortAddress(spender)} transfer your tokens.`, 'erc2612_permit', info ? 'full' : 'partial');
  }

  if (str(data.domain.name) !== 'Permit2' && !sameAddress(str(data.domain.verifyingContract), PERMIT2)) return null;
  if (!sameAddress(str(data.domain.verifyingContract), PERMIT2)) b.warn('danger', 'fake_permit2', 'This is labelled Permit2 but is not signed for the real Permit2 contract.');
  const spender = str(m.spender);
  b.detail('Spender', spender).detail('Permit2 contract', str(data.domain.verifyingContract));
  const lines: string[] = [];
  const addToken = async (address: string, raw: bigint | null, label: string) => {
    const info = await token(env, chainId, address);
    if (chainId !== null) tokenSourceWarnings(b, chainId, info);
    const text = amountText(raw, info, address);
    lines.push(text);
    b.detail(label, text, raw?.toString());
    if (raw !== null && isUnlimited(raw)) b.warn('caution', 'unlimited_permit', `${shortAddress(spender)} will be able to move all of your ${info?.symbol ?? 'tokens'} through Permit2.`);
    // Permit2 pulls with its own ERC-20 allowance: that and the balance cap what the signature moves.
    if (sameAddress(str(data.domain.verifyingContract), PERMIT2)) await canMoveNow(env, b, chainId, env.signer, address, info, raw, { address: PERMIT2, name: 'Permit2' }, label === 'Allowance' || label === 'Amount' ? 'Can move now' : `${label}: can move now`);
  };
  switch (data.primaryType) {
    case 'PermitSingle':
    case 'PermitBatch': {
      const details = (data.primaryType === 'PermitSingle' ? [m.details] : (m.details as unknown[])) as Record<string, unknown>[];
      for (const [i, d] of details.entries()) {
        await addToken(str(d.token), big(d.amount), details.length > 1 ? `Token #${i + 1}` : 'Allowance');
        deadline(b, env, details.length > 1 ? `Token #${i + 1} allowance expires` : 'Allowance expires', d.expiration);
        // Permit2's nonce for this owner, token and spender: allowance(owner, token, spender) = (amount, expiration, nonce).
        if (env.signer && /^0x[0-9a-fA-F]{40}$/.test(str(d.token))) nonceCheck(b, big(d.nonce), (await words(env, chainId, PERMIT2, `0x927da105${w(env.signer)}${w(str(d.token))}${w(spender)}`))?.[2], 'Permit2 allowance');
      }
      deadline(b, env, 'Signature valid until', m.sigDeadline);
      offChainNote();
      return result(`Permit2: allow ${shortAddress(spender)} to spend ${lines.join(', ')}`, 'Signs a Permit2 allowance; the spender can transfer these tokens until the allowance expires.', 'permit2_allowance', 'full');
    }
    case 'PermitTransferFrom':
    case 'PermitWitnessTransferFrom':
    case 'PermitBatchTransferFrom':
    case 'PermitBatchWitnessTransferFrom': {
      const permitted = (Array.isArray(m.permitted) ? m.permitted : [m.permitted]) as Record<string, unknown>[];
      for (const [i, p] of permitted.entries()) await addToken(str(p.token), big(p.amount), permitted.length > 1 ? `Token #${i + 1}` : 'Amount');
      deadline(b, env, 'Signature valid until', m.deadline);
      // A one-time transfer's nonce is a bit in Permit2's nonceBitmap(owner, nonce >> 8): set means it was used.
      const nonce = big(m.nonce);
      if (env.signer && nonce !== null) {
        const bitmap = (await words(env, chainId, PERMIT2, `0x4fe02b44${w(env.signer)}${w(nonce >> 8n)}`))?.[0];
        if (bitmap !== undefined && (bitmap >> (nonce & 0xffn)) & 1n) b.warn('info', 'signature_nonce_used', `This Permit2 transfer's nonce (${nonce}) has already been used, so the signature can't be used.`);
      }
      const order = data.primaryType.includes('Witness') ? await uniswapXOrder(m.witness, env, chainId, spender, lines.join(', '), b) : null;
      if (order) { offChainNote(); return result(order.title, order.summary, 'uniswapx_order', 'full'); }
      if (data.primaryType.includes('Witness')) b.warn('info', 'permit2_witness', 'The signature also commits to extra order data (a "witness"), typically a swap or intent order.');
      offChainNote();
      return result(`Permit2: let ${shortAddress(spender)} take ${lines.join(', ')}`, 'Signs a one-time Permit2 transfer; the spender can pull these tokens once.', 'permit2_transfer', data.primaryType.includes('Witness') ? 'partial' : 'full');
    }
  }
  return null;
};

/**
 * A UniswapX order carried as a Permit2 witness (Dutch, V2/V3 Dutch, priority and limit orders all have an `info`
 * with the reactor and swapper, and outputs of token, amount and recipient). The swapper gets the outputs addressed to
 * it; others (an interface fee) are listed. Amounts are the least each output can decay to.
 */
async function uniswapXOrder(witness: unknown, env: TypedEnv, chainId: number | null, spender: string, input: string, b: PreviewBuilder): Promise<{ title: string; summary: string } | null> {
  if (!witness || typeof witness !== 'object' || chainId === null) return null;
  const w = witness as Record<string, unknown>;
  const info = w.info as Record<string, unknown> | undefined;
  const outputs = (Object.values(w).find(v => Array.isArray(v) && v.every(o => o && typeof o === 'object' && 'token' in o && 'recipient' in o)) ?? null) as Record<string, unknown>[] | null;
  if (!info || !info.swapper || !outputs?.length) return null;
  const swapper = str(info.swapper).toLowerCase(), reactor = str(info.reactor).toLowerCase();
  const least = (o: Record<string, unknown>) => {
    const vals = ['minAmount', 'endAmount', 'startAmount', 'amount'].map(k => big(o[k])).filter((v): v is bigint => v !== null);
    return big(o.minAmount) ?? (vals.length ? vals.reduce((a, c) => (c < a ? c : a)) : null);
  };
  const mine: string[] = [];
  b.detail('Swapper', swapper).detail('Reactor', reactor);
  for (const o of outputs) {
    const t = str(o.token), raw = least(o);
    const text = amountText(raw, await token(env, chainId, t), t);
    if (sameAddress(str(o.recipient), swapper)) mine.push(text);
    else b.detail('Also paid out', `${text} to ${shortAddress(str(o.recipient))}`, str(o.recipient));
  }
  b.detail('You receive at least', mine.join(', ') || 'nothing');
  if (!mine.length) b.warn('danger', 'order_for_nothing', `This order pays nothing to the swapper (${shortAddress(swapper)}): signing it gives away ${input}.`);
  if (env.signer && !sameAddress(swapper, env.signer)) b.warn('caution', 'order_maker_mismatch', `The order's swapper is ${shortAddress(swapper)}, not ${shortAddress(env.signer)}, who is asked to sign it.`);
  if (!sameAddress(reactor, spender)) b.warn('caution', 'reactor_mismatch', `The order names reactor ${shortAddress(reactor)}, but the permit lets ${shortAddress(spender)} take the tokens.`);
  return { title: `Swap ${input} for at least ${mine.join(' and ') || 'nothing'} (UniswapX)`, summary: `Signs a UniswapX order: fillers can take up to ${input} and must pay you at least ${mine.join(' and ') || 'nothing'} before it expires.` };
}

/** Fallback for any EIP-712 message: list every field. */
export const genericTypedDataAdapter: TypedAdapter = async (data: TypedData, env) => {
  const chainId = domainChainId(data);
  const b = new PreviewBuilder();
  if (data.domain.name) b.detail('Application', str(data.domain.name));
  if (data.domain.verifyingContract) b.detail('Contract', str(data.domain.verifyingContract));
  if (chainId !== null) b.detail('Chain', chainName(chainId), String(chainId));
  const walk = (prefix: string, type: string, value: unknown, depth: number) => {
    const struct = data.types[type.replace(/\[\d*\]$/, '')];
    if (Array.isArray(value)) value.forEach((v, i) => walk(`${prefix}[${i}]`, type.replace(/\[\d*\]$/, ''), v, depth + 1));
    else if (struct && value && typeof value === 'object' && depth < 4) for (const f of struct) walk(prefix ? `${prefix}.${f.name}` : f.name, f.type, (value as Record<string, unknown>)[f.name], depth + 1);
    else if (b.details.length < 60) b.detail(prefix, str(value));
  };
  walk('', data.primaryType, data.message, 0);
  if (env.context.chainId && chainId !== null && chainId !== env.context.chainId) b.warn('caution', 'chain_mismatch', `The signature is for ${chainName(chainId)}, but the wallet is on ${chainName(env.context.chainId)}.`);
  b.warn('caution', 'unknown_typed_data', `"${data.primaryType}" from ${str(data.domain.name) || 'an unnamed application'} is not a recognised format. All fields are shown as signed; make sure you understand what they authorise.`);
  return { title: `Sign ${data.primaryType}${data.domain.name ? ` for ${str(data.domain.name)}` : ''}`, summary: 'A structured (EIP-712) signature request in a format this previewer does not interpret.', decoder: 'eip712_generic', status: 'partial', b,
    network: chainId !== null ? { kind: 'evm', chainId, name: chainName(chainId) } : null };
};
