import type { Detail, Preview, Severity, Warning } from './types.ts';

/** Exact decimal formatting of an integer amount. Never goes through floats. */
export function formatUnits(raw: bigint, decimals: number): string {
  const plain = decimalString(raw, decimals);
  return plain.startsWith('-') ? '-' + groupThousands(plain.slice(1)) : groupThousands(plain);
}

/**
 * Short form for headlines: about `significant` significant digits, rounded down, with thousands separators
 * (1,401,117.588472729 -> "1,401,117"; 0.0503251234 -> "0.050325"). Exact values belong in details.
 */
export function compactUnits(raw: bigint, decimals: number, significant = 6): string {
  const plain = decimalString(raw < 0n ? -raw : raw, decimals);
  const [whole, fraction = ''] = plain.split('.');
  let keep: string;
  if (whole !== '0') keep = fraction.slice(0, Math.max(0, significant - whole.length));
  else { const lead = fraction.match(/^0*/)![0].length; keep = fraction.slice(0, lead + significant); }
  keep = keep.replace(/0+$/, '');
  return (raw < 0n ? '-' : '') + groupThousands(keep ? `${whole}.${keep}` : whole);
}

/** Unix seconds as a UTC date ("2026-12-04", or with time), or null for values past year 9999 such as 2^48-1 ("never"). */
export function utcDate(seconds: bigint | number, withTime = false): string | null {
  const ms = Number(seconds) * 1000;
  if (!Number.isFinite(ms) || ms < 0 || ms > 253_402_300_799_000) return null;
  const iso = new Date(ms).toISOString();
  return withTime ? iso.replace('.000Z', 'Z') : iso.slice(0, 10);
}

/** Like formatUnits but without thousands separators (machine-readable decimal). */
export function decimalString(raw: bigint, decimals: number): string {
  const negative = raw < 0n;
  let digits = (negative ? -raw : raw).toString();
  if (decimals > 0) {
    digits = digits.padStart(decimals + 1, '0');
    const whole = digits.slice(0, -decimals);
    const fraction = digits.slice(-decimals).replace(/0+$/, '');
    digits = fraction ? `${whole}.${fraction}` : whole;
  }
  return (negative ? '-' : '') + digits;
}

/** Adds thousands separators to the integer part of a decimal string. */
export function groupThousands(decimal: string): string {
  const [whole, fraction] = decimal.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

/** Parses an exact decimal string into an integer with `decimals` places, or null. */
export function parseUnits(value: string, decimals: number): bigint | null {
  if (!/^\d+(\.\d+)?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals) return null;
  return BigInt(whole + fraction.padEnd(decimals, '0'));
}

export const MAX_UINT256 = (1n << 256n) - 1n;
export const MAX_UINT160 = (1n << 160n) - 1n;

export function isUnlimited(raw: bigint): boolean {
  // Common "infinite approval" / "no limit" encodings: max uint256, max uint160 (Permit2), max uint128 (Uniswap v4),
  // or absurdly large.
  return raw === MAX_UINT256 || raw === MAX_UINT160 || raw >= (1n << 128n) - 1n;
}

export function shortAddress(address: string): string {
  return /^0x[0-9a-fA-F]{40}$/.test(address) ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

export function sameAddress(a: string | undefined | null, b: string | undefined | null): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

/**
 * ISO time. Values past year 9999 (e.g. Permit2's 2^48-1 or max-uint "never expires") would make Date throw, so they
 * read as "never"; negative or non-numeric values are shown as they are.
 */
export function formatTimestamp(ms: number): string {
  if (!Number.isFinite(ms) || ms > 253_402_300_799_000) return 'never (no real expiry date)';
  if (ms < 0) return `invalid time (${ms / 1000})`;
  return new Date(ms).toISOString().replace('.000Z', 'Z');
}

export function formatDuration(ms: number): string {
  const abs = Math.abs(ms);
  const units: [number, string][] = [[86_400_000, 'day'], [3_600_000, 'hour'], [60_000, 'minute'], [1000, 'second']];
  for (const [size, name] of units) {
    if (abs >= size) {
      const n = Math.round(abs / size);
      return `${n} ${name}${n === 1 ? '' : 's'}`;
    }
  }
  return 'less than a second';
}

/** Formats a decimal string price/size for display without changing its value. */
export function formatDecimalString(value: string): string {
  return /^-?\d+(\.\d+)?$/.test(value) ? (value.startsWith('-') ? '-' + groupThousands(value.slice(1)) : groupThousands(value)) : value;
}

/** Formats a USD amount for estimates (rounded to cents). */
export function formatUsd(value: number): string {
  return '$' + value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const ORDER: Record<Severity, number> = { info: 1, caution: 2, danger: 3 };

export function attentionOf(warnings: Warning[]): Preview['attention'] {
  let best: Preview['attention'] = 'none';
  for (const w of warnings) if (best === 'none' || ORDER[w.severity] > ORDER[best]) best = w.severity;
  return best;
}

/** Small builder that keeps decoders terse. */
export class PreviewBuilder {
  details: Detail[] = [];
  warnings: Warning[] = [];
  notes: string[] = [];
  detail(label: string, value: string, raw?: string): this {
    this.details.push(raw === undefined || raw === value ? { label, value } : { label, value, raw });
    return this;
  }
  warn(severity: Severity, code: string, message: string): this {
    if (!this.warnings.some(w => w.code === code)) this.warnings.push({ severity, code, message });
    return this;
  }
  note(text: string): this {
    this.notes.push(text);
    return this;
  }
}
