import { formatDuration, formatTimestamp, formatUnits, isUnlimited, PreviewBuilder, sameAddress, shortAddress } from '../format.ts';
import { chainName, PERMIT2 } from '../chains.ts';
import { tokenSourceWarnings } from '../evm/common.ts';
import type { TokenInfo } from '../types.ts';
import { big, domainChainId, str, type TypedAdapter, type TypedDecoded, type TypedEnv, type TypedData } from './common.ts';

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
  };
  switch (data.primaryType) {
    case 'PermitSingle':
    case 'PermitBatch': {
      const details = (data.primaryType === 'PermitSingle' ? [m.details] : (m.details as unknown[])) as Record<string, unknown>[];
      for (const [i, d] of details.entries()) {
        await addToken(str(d.token), big(d.amount), details.length > 1 ? `Token #${i + 1}` : 'Allowance');
        deadline(b, env, details.length > 1 ? `Token #${i + 1} allowance expires` : 'Allowance expires', d.expiration);
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
      if (data.primaryType.includes('Witness')) b.warn('info', 'permit2_witness', 'The signature also commits to extra order data (a "witness"), typically a swap or intent order.');
      offChainNote();
      return result(`Permit2: let ${shortAddress(spender)} take ${lines.join(', ')}`, 'Signs a one-time Permit2 transfer; the spender can pull these tokens once.', 'permit2_transfer', data.primaryType.includes('Witness') ? 'partial' : 'full');
    }
  }
  return null;
};

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
