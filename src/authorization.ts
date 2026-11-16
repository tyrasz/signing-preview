// What makes an EIP-7702 authorization's signature one the chain applies.
import type { Hex } from 'viem';

/** secp256k1's group order, and half of it: the most `s` may be (EIP-2's low-s rule, which EIP-7702 applies). */
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n, HALF_N = N / 2n;

/**
 * Whether the chain applies an authorization so signed: EIP-7702 has a node skip one whose y_parity isn't 0 or 1, or
 * whose s is over half the group order (or r or s out of range). The local EVM, the previews and the replays had
 * recovered an authority from either and applied it: on Ethereum (2026-11-16) an authorization with s replaced by
 * n - s, or its parity given as 27, delegated the account locally (code size 23, 81,362 gas) where the node skipped
 * it (no code, 49,127 gas). None of 2,434 mined authorizations had either form.
 */
export function appliedSignature(sig: { r: Hex | string; s: Hex | string; yParity?: number | bigint | string }): boolean {
  try {
    const r = BigInt(sig.r), s = BigInt(sig.s);
    if (r <= 0n || r >= N || s <= 0n || s > HALF_N) return false;
    if (sig.yParity !== undefined && sig.yParity !== null) { const y = BigInt(sig.yParity); if (y !== 0n && y !== 1n) return false; }
    return true;
  } catch { return false; }
}
