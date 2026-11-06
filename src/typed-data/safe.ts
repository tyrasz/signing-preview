// Safe multisig owner signatures: EIP-712 SafeTx (domain: the chain and the Safe itself). See src/safe.ts.
import { hexToBytes } from 'viem';
import { PreviewBuilder, shortAddress } from '../format.ts';
import { chainName } from '../chains.ts';
import { describeSafeTx } from '../safe.ts';
import { big, domainChainId, str, type TypedAdapter } from './common.ts';

export const safeTxAdapter: TypedAdapter = async (data, env) => {
  if (data.primaryType === 'SafeMessage') return safeMessage(data, env);
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
      if (env.signer) {
        const owner = BigInt(String(await rpc.call(chainId, 'eth_call', [{ to: safe, data: `0x2f54bf6e${env.signer.slice(2).padStart(64, '0')}` }, 'latest'])));
        if (owner === 0n) b.warn('caution', 'safe_not_owner', `${shortAddress(env.signer)} is not an owner of this Safe, so its signature doesn't count towards the threshold.`);
      }
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
