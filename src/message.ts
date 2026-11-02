import { attentionOf, PreviewBuilder, sameAddress, shortAddress } from './format.ts';
import type { Preview, PreviewContext } from './types.ts';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function hexToUtf8(hex: string): string | null {
  if (!/^0x([0-9a-fA-F]{2})*$/.test(hex)) return null;
  const bytes = new Uint8Array((hex.length - 2) / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(2 + i * 2, 4 + i * 2), 16);
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // Treat as text only if it is mostly printable.
    return /^[\P{C}\n\r\t]*$/u.test(text) ? text : null;
  } catch {
    return null;
  }
}

/** personal_sign and eth_sign. */
export function previewMessage(method: string, params: unknown[], context: PreviewContext): Preview {
  const b = new PreviewBuilder();
  const base = { schema: 'signing-preview/1' as const, method, kind: 'message' as const, network: null, assetChanges: [] };
  if (method === 'eth_sign') {
    const [address, hash] = params as [string, string];
    b.detail('Account', String(address)).detail('Data', String(hash));
    b.warn('danger', 'eth_sign', 'eth_sign signs raw data that can be a transaction or permission. Legitimate dApps no longer need it. Reject unless you know exactly what this is.');
    return { ...base, title: 'Sign raw data (blind)', summary: 'Signs an arbitrary hash that could authorise anything.', details: b.details, warnings: b.warnings, attention: attentionOf(b.warnings), decoding: { status: 'opaque', decoder: 'eth_sign', notes: [] } };
  }
  // personal_sign is [message, address], but some dApps send [address, message].
  let [message, address] = params as [string, string];
  if (ADDRESS.test(String(message)) && !ADDRESS.test(String(address))) [message, address] = [address, message];
  const text = typeof message === 'string' && message.startsWith('0x') ? hexToUtf8(message) : typeof message === 'string' ? message : null;
  if (address) b.detail('Account', String(address));
  if (text === null) {
    b.detail('Message (hex)', String(message));
    b.warn('caution', 'binary_message', 'The message is not readable text. It may be a hash; signing it can be equivalent to blind signing.');
    return { ...base, title: 'Sign a binary message', summary: 'The message cannot be displayed as text.', details: b.details, warnings: b.warnings, attention: attentionOf(b.warnings), decoding: { status: 'opaque', decoder: 'personal_sign', notes: [] } };
  }
  const siwe = parseSiwe(text);
  if (siwe) {
    b.detail('Website', siwe.domain).detail('Account', siwe.address);
    for (const [k, v] of Object.entries(siwe.fields)) b.detail(k, v);
    if (siwe.statement) b.detail('Statement', siwe.statement);
    if (context.origin) {
      let host: string | null = null;
      try { host = new URL(context.origin).host; } catch { /* invalid origin */ }
      if (host && host !== siwe.domain) b.warn('danger', 'siwe_domain_mismatch', `This sign-in message is for ${siwe.domain}, but the request comes from ${host}. This is a common phishing pattern.`);
    }
    if (address && !sameAddress(String(address), siwe.address)) b.warn('caution', 'siwe_account_mismatch', 'The account in the message is not the signing account.');
    return { ...base, title: `Sign in to ${siwe.domain}`, summary: `Proves to ${siwe.domain} that you control ${shortAddress(siwe.address)}. No funds move.`, details: b.details, warnings: b.warnings, attention: attentionOf(b.warnings), decoding: { status: 'full', decoder: 'siwe', notes: [] } };
  }
  b.detail('Message', text);
  b.note('Plain-text signatures do not move funds by themselves, but they can be used as login or consent proofs.');
  return { ...base, title: 'Sign a message', summary: text.length > 140 ? text.slice(0, 137) + '…' : text, details: b.details, warnings: b.warnings, attention: attentionOf(b.warnings), decoding: { status: 'full', decoder: 'personal_sign', notes: b.notes } };
}

/** Minimal EIP-4361 (Sign-In with Ethereum) parser. */
function parseSiwe(text: string): { domain: string; address: string; statement?: string; fields: Record<string, string> } | null {
  const lines = text.split('\n');
  const head = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(\S+) wants you to sign in with your Ethereum account:$/.exec(lines[0] ?? '');
  if (!head || !ADDRESS.test(lines[1] ?? '')) return null;
  const fields: Record<string, string> = {};
  let statement: string | undefined;
  for (const line of lines.slice(2)) {
    const kv = /^(URI|Version|Chain ID|Nonce|Issued At|Expiration Time|Not Before|Request ID): (.*)$/.exec(line);
    if (kv) fields[kv[1]] = kv[2];
    else if (line.trim() && !line.startsWith('- ') && line !== 'Resources:' && !statement) statement = line.trim();
  }
  return { domain: head[1], address: lines[1], statement, fields };
}
