// Calldata that is plain UTF-8 text rather than a function call: inscriptions (data: URIs, which off-chain indexers
// such as Ethscriptions read) and on-chain messages. Sent to an account with no code, the text does nothing on-chain.
// Sent to a contract, the contract receives the text as its call input, and what it does with it is not decoded.
// This runs after the ABI decoders: ABI-encoded calls are padded with zero bytes, so they are never printable text.
import { hexToBytes } from 'viem';
import { PreviewBuilder, shortAddress } from '../format.ts';
import { decoded, nativeAmount, type Adapter } from './common.ts';

const utf8 = new TextDecoder('utf-8', { fatal: true });
// C0/C1 control characters other than tab, newline and carriage return (ABI padding is \0).
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
// Characters that reorder or hide text, so what is shown may not be what is there.
const HIDDEN = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
const SHOWN = 1000;

/** The calldata as text, or null unless all of it is printable UTF-8 (at least 4 bytes). */
export function calldataText(data: string): string | null {
  if (data.length < 10) return null;
  let text: string;
  try { text = utf8.decode(hexToBytes(data as `0x${string}`)); } catch { return null; }
  return CONTROL.test(text) ? null : text;
}

/** data:[<media type>][;base64],<data> (RFC 2397), as used by Ethscriptions and similar inscription protocols. */
function dataUri(text: string): { mediaType: string; base64: boolean; content: string } | null {
  const m = /^data:([^,]*),/s.exec(text);
  if (!m) return null;
  const params = m[1].split(';');
  const base64 = params.at(-1)?.toLowerCase() === 'base64';
  return { mediaType: (params[0] || 'text/plain').toLowerCase(), base64, content: text.slice(m[0].length) };
}

/** A JSON inscription's protocol and operation ("p", "op", "tick"), e.g. a token mint or transfer an indexer tracks. */
function protocolOp(content: string): string | null {
  try {
    const j = JSON.parse(content) as Record<string, unknown>;
    const parts = [j.p, j.op, j.tick].filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 40);
    return typeof j.p === 'string' && typeof j.op === 'string' ? parts.join(' ') : null;
  } catch {
    return null;
  }
}

const clip = (s: string, n: number) => s.length > n ? `${s.slice(0, n)}… (${s.length - n} more characters)` : s;

export const textCalldataAdapter: Adapter = async (tx, env) => {
  if (!tx.to) return null;
  const text = calldataText(tx.data);
  if (text === null) return null;
  const b = new PreviewBuilder().detail('Recipient', tx.to);
  if (tx.value > 0n) b.detail('Value sent', nativeAmount(tx.chainId, tx.value), tx.value.toString());

  // Without code at the recipient nothing runs; with code (or when it can't be checked) the contract decides.
  let hasCode: boolean | undefined;
  const rpc = env.deps.rpc;
  if (rpc?.has(tx.chainId)) {
    try { hasCode = String(await rpc.call(tx.chainId, 'eth_getCode', [tx.to, 'latest'])).length > 2; } catch { hasCode = undefined; }
  }

  const uri = dataUri(text);
  const op = uri && !uri.base64 && /json|text\/plain/.test(uri.mediaType) ? protocolOp(uri.content) : null;
  const shown = text.replace(HIDDEN, '');
  let title: string, summary: string;
  if (uri) {
    title = op ? `Inscription: ${op}` : `Post ${/^[aeiou]/.test(uri.mediaType) ? 'an' : 'a'} ${uri.mediaType} inscription`;
    summary = `Posts a data: URI (${uri.mediaType}${uri.base64 ? ', base64' : ''}) as the transaction data. Inscription indexers such as Ethscriptions read it; the chain itself only records it.`;
    b.detail('Inscription', clip(uri.base64 ? `${uri.mediaType}, ${uri.content.length} base64 characters` : shown, SHOWN));
    if (op) b.warn('info', 'inscription_protocol', `This is a "${op}" operation of an inscription protocol. Its effect (for example a token transfer) is decided by that protocol's off-chain indexer, not by the chain; check the content.`);
  } else {
    title = `Send a message to ${shortAddress(tx.to)}`;
    summary = `Sends this text as the transaction data: “${clip(shown, 120)}”.`;
    b.detail('Message', clip(shown, SHOWN));
    b.note('Anyone can read a message sent in transaction data, and it stays on-chain permanently.');
  }
  if (tx.value > 0n) title += ` with ${nativeAmount(tx.chainId, tx.value)}`;
  if (shown !== text) b.warn('caution', 'hidden_characters', 'The text contains invisible or text-reordering Unicode characters (removed above), so it may read differently elsewhere.');
  if (hasCode !== false) {
    b.warn('caution', 'text_to_contract', hasCode
      ? `${tx.to} is a contract: it receives this text as its call input, and what it does with it is not decoded.`
      : `Whether ${tx.to} is a contract could not be checked. If it is, it receives this text as its call input, and what it does with it is not decoded.`);
  }
  return decoded({
    title, summary, decoder: 'calldata_text', status: hasCode === false ? 'full' : 'partial', b,
    assetChanges: tx.value > 0n ? [{ direction: 'out', account: tx.from, amount: nativeAmount(tx.chainId, tx.value).split(' ')[0], symbol: nativeAmount(tx.chainId, tx.value).split(' ')[1], raw: tx.value.toString(), asset: 'native', basis: 'requested' }] : [],
  });
};
