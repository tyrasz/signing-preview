import { formatDuration, formatTimestamp, formatUnits, PreviewBuilder, sameAddress, shortAddress } from '../format.ts';
import { CCTP_NETWORKS, chainName } from '../chains.ts';
import { tokenSourceWarnings } from '../evm/common.ts';
import type { TokenInfo } from '../types.ts';
import { big, domainChainId, str, type TypedAdapter } from './common.ts';

const TYPES = ['TransferWithAuthorization', 'ReceiveWithAuthorization', 'CancelAuthorization'];
const FIELDS = ['from', 'to', 'value', 'validAfter', 'validBefore', 'nonce'];

/**
 * EIP-3009 authorizations on USDC (FiatToken). ReceiveWithAuthorization is the first step of Circle's
 * Arbitrum → HyperCore guide: it lets the CctpExtension pull USDC when you send the deposit transaction.
 */
export const eip3009Adapter: TypedAdapter = async (data, env) => {
  if (!TYPES.includes(data.primaryType)) return null;
  const fields = data.types[data.primaryType].map(f => f.name);
  const isCancel = data.primaryType === 'CancelAuthorization';
  if (!isCancel && !FIELDS.every(f => fields.includes(f))) return null;
  const chainId = domainChainId(data);
  const network = chainId !== null ? { kind: 'evm' as const, chainId, name: chainName(chainId) } : null;
  const tokenAddress = str(data.domain.verifyingContract).toLowerCase();
  let token: TokenInfo | undefined;
  try { token = chainId !== null ? (await env.deps.tokens?.get(chainId, tokenAddress)) ?? undefined : undefined; } catch { token = undefined; }
  const m = data.message;
  const b = new PreviewBuilder();
  if (chainId !== null) tokenSourceWarnings(b, chainId, token);
  b.detail('Token', token ? `${token.symbol} on ${network?.name ?? 'unknown chain'} (${tokenAddress})` : `${str(data.domain.name)} (${tokenAddress})`, tokenAddress);
  if (!token) b.warn('caution', 'unknown_token', 'The token contract is not in the known-token list; its name comes from the signing domain and is unverified.');

  if (isCancel) {
    b.detail('Authorizer', str(m.authorizer)).detail('Nonce', str(m.nonce));
    return { title: `Cancel a ${token?.symbol ?? 'token'} authorization`, summary: 'Invalidates a previously signed transfer authorization (nonce) before it is used.', decoder: 'eip3009_cancel', status: 'full', b, network };
  }

  const from = str(m.from), to = str(m.to), raw = big(m.value);
  const amount = raw === null ? str(m.value) : token ? `${formatUnits(raw, token.decimals)} ${token.symbol}` : `${raw} base units`;
  b.detail('From', from).detail('To', to).detail('Amount', amount, raw?.toString());
  const after = big(m.validAfter), before = big(m.validBefore);
  if (after !== null && before !== null) {
    b.detail('Valid', `${formatTimestamp(Number(after) * 1000)} → ${before >= 1n << 47n ? 'never expires' : formatTimestamp(Number(before) * 1000)}`, `${after}..${before}`);
    const remaining = Number(before) * 1000 - env.now;
    if (remaining <= 0) b.warn('info', 'expired', 'This authorization has already expired and cannot be used.');
    else if (remaining > 7 * 86_400_000) b.warn('caution', 'long_expiry', `This authorization stays usable for ${formatDuration(remaining)}.`);
  }
  if (env.signer && !sameAddress(from, env.signer)) b.warn('danger', 'eip3009_from_mismatch', `The authorization spends from ${shortAddress(from)}, but ${shortAddress(env.signer)} is asked to sign it.`);
  b.note('This is an off-chain signature; it costs no gas now.');

  const net = chainId !== null ? CCTP_NETWORKS[chainId] : undefined;
  if (data.primaryType === 'TransferWithAuthorization') {
    b.warn(sameAddress(to, from) ? 'info' : 'caution', 'transfer_authorization', `Anyone holding this signature can submit it to move ${amount} from your wallet to ${shortAddress(to)}. Treat it like sending the payment.`);
    return { title: `Authorize a transfer of ${amount} to ${shortAddress(to)}`, summary: `Signs a gasless USDC transfer (EIP-3009) of ${amount} to ${shortAddress(to)}.`, decoder: 'eip3009_transfer', status: token ? 'full' : 'partial', b, network,
      assetChanges: raw !== null && token ? [{ direction: 'out', account: from, amount: formatUnits(raw, token.decimals), symbol: token.symbol, raw: raw.toString(), asset: tokenAddress, basis: 'requested' }] : [] };
  }

  // ReceiveWithAuthorization: only `to` (a contract calling receiveWithAuthorization) can use it.
  if (net?.cctpExtension && sameAddress(to, net.cctpExtension) && sameAddress(tokenAddress, net.usdc)) {
    b.detail('Spender', `Circle CctpExtension (${net.cctpExtension})`);
    b.warn('info', 'cctp_extension_auth', 'Step 1 of Circle\'s Arbitrum → HyperCore deposit. The destination and recipient are set in the deposit transaction you send next, which is previewed separately. CctpExtension can only use this when you send that transaction yourself.');
    return { title: `Authorize Circle's CCTP extension to take ${amount}`, summary: `Lets Circle's CctpExtension pull ${amount} from your wallet when you submit a HyperCore deposit transaction.`, decoder: 'eip3009_receive_cctp_extension', status: 'full', b, network };
  }
  if (net?.cctpExtensionV2 && sameAddress(to, net.cctpExtensionV2) && sameAddress(tokenAddress, net.usdc)) {
    b.detail('Spender', `Circle CctpExtensionV2 (${net.cctpExtensionV2})`);
    b.warn('caution', 'cctp_extension_v2_auth', 'Sponsored deposit: a relayer submits the burn for you. The destination, HyperCore recipient, fees and hook are bound into the nonce and cannot be read from this signature. Confirm the recipient in the app you trust.');
    return { title: `Authorize a sponsored HyperCore deposit of ${amount}`, summary: `Lets Circle's CctpExtensionV2 burn ${amount} for a relayer-submitted transfer to HyperCore.`, decoder: 'eip3009_receive_cctp_extension_v2', status: 'partial', b, network,
      assetChanges: raw !== null && token ? [{ direction: 'out', account: from, amount: formatUnits(raw, token.decimals), symbol: token.symbol, raw: raw.toString(), asset: tokenAddress, basis: 'requested' }] : [] };
  }
  b.warn('caution', 'receive_authorization', `${shortAddress(to)} will be able to pull ${amount} from your wallet once, in a transaction it makes. Only sign for contracts you trust.`);
  return { title: `Authorize ${shortAddress(to)} to take ${amount}`, summary: `Signs an EIP-3009 authorization that lets ${shortAddress(to)} receive ${amount} from your wallet.`, decoder: 'eip3009_receive', status: token ? 'full' : 'partial', b, network };
};
