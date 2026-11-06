// Arbitrum-style inboxes (Arbitrum One's on Ethereum, Orbit chains' on their parent chain, such as chain 99901 on
// HyperEVM): sendL2Message carries a message for the child chain, usually (kind 4) a transaction signed for it. The
// preview shows that inner transaction and who signed it.
import { decodeFunctionData, parseAbi, parseTransaction, recoverTransactionAddress, type Hex } from 'viem';
import { formatUnits, PreviewBuilder, sameAddress, shortAddress } from '../format.ts';
import { decoded, type Adapter } from './common.ts';
import { chainLabel } from './universal-router.ts';

const ABI = parseAbi(['function sendL2Message(bytes messageData) returns (uint256)']);

export const orbitInboxAdapter: Adapter = async (tx) => {
  if (!tx.to || !tx.data.startsWith('0xb75436bb')) return null;
  let message: Hex;
  try { message = decodeFunctionData({ abi: ABI, data: tx.data }).args[0]; } catch { return null; }
  const b = new PreviewBuilder().detail('Inbox', tx.to, tx.to);
  if (!message.startsWith('0x04')) {
    b.detail('Message kind', String(parseInt(message.slice(2, 4), 16)));
    return decoded({ title: 'Send a message to a child chain through its inbox', summary: "Sends a message to an Arbitrum-style chain through its inbox; its kind isn't a signed transaction, so it isn't decoded.", decoder: 'orbit_inbox', status: 'partial', b });
  }
  const inner = `0x${message.slice(4)}` as Hex;
  let t, signer: string;
  try { t = parseTransaction(inner); signer = (await recoverTransactionAddress({ serializedTransaction: inner as never })).toLowerCase(); } catch { return null; }
  const chain = t.chainId !== undefined ? chainLabel(BigInt(t.chainId)) : 'the child chain';
  b.detail('Child chain', chain, t.chainId?.toString()).detail('Signed by', sameAddress(signer, tx.from) ? `you (${signer})` : signer, signer)
    .detail('To', t.to ?? '(contract creation)').detail('Value', formatUnits(t.value ?? 0n, 18)).detail('Calldata', !t.data || t.data === '0x' ? 'none' : `${t.data.slice(0, 10)} (${(t.data.length - 2) / 2} bytes)`);
  if (t.nonce !== undefined) b.detail('Nonce on the child chain', String(t.nonce));
  if (!sameAddress(signer, tx.from)) b.warn('info', 'inbox_relayed', `This submits a transaction that ${shortAddress(signer)} signed, not one of yours: you pay the parent-chain gas to deliver it.`);
  b.note(`The inner transaction runs on ${chain} once the inbox message is included there, as if sent directly.`);
  return decoded({ title: `Send a transaction to ${chain} through its inbox${t.to ? ` (to ${shortAddress(t.to)})` : ''}`, summary: `Delivers a transaction signed by ${sameAddress(signer, tx.from) ? 'you' : shortAddress(signer)} to ${chain} through its inbox.`, decoder: 'orbit_inbox', status: 'full', b });
};
