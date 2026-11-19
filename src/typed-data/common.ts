import { hashTypedData, type Hex } from 'viem';
import type { PreviewBuilder } from '../format.ts';
import type { ApprovalChange, AssetChange, Dependencies, Network, PreviewContext } from '../types.ts';

export interface TypedField { name: string; type: string }

export interface TypedData {
  types: Record<string, TypedField[]>;
  primaryType: string;
  domain: Record<string, unknown>;
  message: Record<string, unknown>;
}

export interface TypedEnv {
  deps: Dependencies;
  context: PreviewContext;
  /** Address asked to sign (from the request params). */
  signer: string | null;
  now: number;
}

export interface TypedDecoded {
  title: string;
  summary: string;
  decoder: string;
  status: 'full' | 'partial' | 'opaque';
  b: PreviewBuilder;
  network: Network | null;
  assetChanges?: AssetChange[];
  /** Permissions the signed message's calls would leave (a delegation's exact calls, simulated). */
  approvals?: ApprovalChange[];
}

export type TypedAdapter = (data: TypedData, env: TypedEnv) => Promise<TypedDecoded | null>;

/** Accepts the typed-data object or its JSON string; validates the basic shape. */
export function parseTypedData(value: unknown): TypedData {
  const parsed = typeof value === 'string' ? safeJson(value) : value;
  if (!parsed || typeof parsed !== 'object') throw new TypedDataError('Typed data must be a JSON object');
  const d = parsed as Record<string, unknown>;
  if (!d.types || typeof d.types !== 'object' || Array.isArray(d.types)) throw new TypedDataError('Typed data is missing "types"');
  if (typeof d.primaryType !== 'string') throw new TypedDataError('Typed data is missing "primaryType"');
  if (!d.message || typeof d.message !== 'object') throw new TypedDataError('Typed data is missing "message"');
  const types = d.types as Record<string, unknown>;
  for (const [name, fields] of Object.entries(types)) {
    if (!Array.isArray(fields) || !fields.every(f => f && typeof f.name === 'string' && typeof f.type === 'string')) throw new TypedDataError(`Type ${name} is malformed`);
  }
  if (!types[d.primaryType]) throw new TypedDataError(`primaryType ${d.primaryType} is not defined in types`);
  return { types: types as TypedData['types'], primaryType: d.primaryType, domain: (d.domain ?? {}) as Record<string, unknown>, message: d.message as Record<string, unknown> };
}

export class TypedDataError extends Error {
  code = 'INVALID_REQUEST';
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { throw new TypedDataError('Typed data is not valid JSON'); }
}

/** EIP-712 digest. Integer fields given as decimal/hex strings are coerced first. */
export function typedDataDigest(data: TypedData): Hex | null {
  try {
    const coerce = (type: string, value: unknown): unknown => {
      if (type.endsWith(']')) return Array.isArray(value) ? value.map(v => coerce(type.slice(0, type.lastIndexOf('[')), v)) : value;
      if (/^u?int\d*$/.test(type) && (typeof value === 'string' || typeof value === 'number')) return BigInt(value);
      const struct = data.types[type];
      if (struct && value && typeof value === 'object') return Object.fromEntries(struct.map(f => [f.name, coerce(f.type, (value as Record<string, unknown>)[f.name])]));
      return value;
    };
    const domainFields = data.types.EIP712Domain;
    const domain = domainFields ? coerce('EIP712Domain', data.domain) : { ...data.domain, ...(data.domain.chainId !== undefined && { chainId: BigInt(data.domain.chainId as string) }) };
    const params = { domain, types: data.types, primaryType: data.primaryType, message: coerce(data.primaryType, data.message) };
    return hashTypedData(params as Parameters<typeof hashTypedData>[0]);
  } catch {
    return null;
  }
}

export function domainChainId(data: TypedData): number | null {
  const id = data.domain.chainId;
  if (typeof id === 'number') return id;
  if (typeof id === 'string' && /^(0x[0-9a-fA-F]+|\d+)$/.test(id)) return Number(BigInt(id));
  return null;
}

export function str(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * An unsigned integer, read as the digest is computed (typedDataDigest, viem): BigInt() of a string, which takes
 * surrounding whitespace and 0x, 0o or 0b, and an empty string as 0; a whole JSON number, however large. Read
 * otherwise, the same signed message could show other amounts than it signs.
 */
export function big(value: unknown): bigint | null {
  try {
    if (typeof value === 'bigint') return value >= 0n ? value : null;
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return BigInt(value);
    if (typeof value === 'string' && value.length <= 200) { const v = BigInt(value); return v >= 0n ? v : null; }
  } catch { /* fallthrough */ }
  return null;
}
