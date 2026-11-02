import { encode } from '@msgpack/msgpack';
import { keccak256, hexToBytes, type Hex } from 'viem';

/**
 * Hash of a Hyperliquid L1 action, matching the official SDK:
 * keccak256(msgpack(action) || nonce (8 bytes BE) || vault flag [|| vault] [|| 0x00 || expiresAfter (8 bytes BE)]).
 * The wallet signs EIP-712 Agent { source, connectionId: this hash }.
 */
export function l1ActionHash(action: unknown, nonce: number, vaultAddress?: string | null, expiresAfter?: number | null): Hex {
  const packed = encode(action, { ignoreUndefined: true });
  const parts: Uint8Array[] = [packed, u64(nonce)];
  if (vaultAddress) {
    parts.push(Uint8Array.of(1), hexToBytes(vaultAddress as Hex));
  } else {
    parts.push(Uint8Array.of(0));
  }
  if (expiresAfter !== undefined && expiresAfter !== null) parts.push(Uint8Array.of(0), u64(expiresAfter));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.length; }
  return keccak256(out);
}

function u64(value: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value));
  return out;
}
