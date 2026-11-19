// ERC-8021 transaction attribution: a suffix apps and wallets append to calldata (Base's builder codes, x402
// facilitators) to say who brought the transaction, which the called contract ignores. It ends with the marker
// 0x8021…8021 (16 bytes) after a schema byte: schema 0 is `codes ∥ codesLength (1 byte) ∥ 0x00` (ASCII codes, comma
// separated, in the canonical registry); schema 1 puts `registry address (20) ∥ chainId ∥ chainIdLength (1)` before the
// codes, for a custom registry; schema 2 is `CBOR map ∥ length (2 bytes) ∥ 0x02`, its keys a (app code), w (wallet
// code), s (service codes), r (registries), m (metadata). As ox/erc8021 (viem's dependency) writes and reads them.

const MARKER = '80218021802180218021802180218021';

export interface Attribution {
  /** How many bytes at the end of the calldata are the attribution. */
  bytes: number;
  schema: 0 | 1 | 2;
  /** What it names, for people: "codes baseapp, morpho", "wallet privy". */
  parts: string[];
}

const ascii = (hex: string) => {
  const s = hex.match(/../g)?.map(h => String.fromCharCode(parseInt(h, 16))).join('') ?? '';
  return /^[\x20-\x7e]*$/.test(s) ? s : undefined;
};

/** A minimal CBOR reader for schema 2's map: unsigned integers, byte and text strings, arrays, maps, simple values. */
function cbor(hex: string): unknown {
  let at = 0;
  const byte = () => { if (at + 2 > hex.length) throw new Error('short'); const v = parseInt(hex.slice(at, at + 2), 16); at += 2; return v; };
  const length = (info: number) => {
    if (info < 24) return info;
    const size = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0;
    if (!size) throw new Error('indefinite');
    let v = 0;
    for (let i = 0; i < size; i++) v = v * 256 + byte();
    return v;
  };
  const item = (depth: number): unknown => {
    if (depth > 8) throw new Error('deep');
    const first = byte(), major = first >> 5, n = length(first & 31);
    switch (major) {
      case 0: return n;
      case 2: case 3: {
        if (at + n * 2 > hex.length) throw new Error('short');
        const raw = hex.slice(at, at + n * 2); at += n * 2;
        return major === 3 ? (ascii(raw) ?? `0x${raw}`) : `0x${raw}`;
      }
      case 4: return Array.from({ length: Math.min(n, 64) }, () => item(depth + 1));
      case 5: {
        const m: Record<string, unknown> = {};
        for (let i = 0; i < Math.min(n, 64); i++) { const k = item(depth + 1); m[String(k)] = item(depth + 1); }
        return m;
      }
      case 7: return n === 20 ? false : n === 21 ? true : null;
      default: throw new Error('unsupported');
    }
  };
  const v = item(0);
  if (at !== hex.length) throw new Error('trailing');
  return v;
}

/** The calldata's ERC-8021 attribution, if it ends with one that reads whole. */
export function readAttribution(data: string): Attribution | undefined {
  const hex = data.toLowerCase().replace(/^0x/, '');
  if (hex.length < (16 + 2) * 2 || !hex.endsWith(MARKER)) return undefined;
  const end = hex.length - MARKER.length;
  const schema = parseInt(hex.slice(end - 2, end), 16);
  try {
    if (schema === 0 || schema === 1) {
      const n = parseInt(hex.slice(end - 4, end - 2), 16);
      const start = end - 4 - n * 2;
      if (start < 0) return undefined;
      const codes = ascii(hex.slice(start, end - 4));
      if (codes === undefined) return undefined;
      const parts = [`codes ${codes.split(',').filter(Boolean).join(', ') || '(none)'}`];
      if (schema === 0) return { bytes: (hex.length - start) / 2, schema, parts };
      const idLength = parseInt(hex.slice(start - 2, start), 16);
      const registryStart = start - 2 - idLength * 2 - 40;
      if (!idLength || registryStart < 0) return undefined;
      const chainId = parseInt(hex.slice(start - 2 - idLength * 2, start - 2), 16);
      parts.push(`registry 0x${hex.slice(registryStart, registryStart + 40)} on chain ${chainId}`);
      return { bytes: (hex.length - registryStart) / 2, schema, parts };
    }
    if (schema === 2) {
      const n = parseInt(hex.slice(end - 6, end - 2), 16);
      const start = end - 6 - n * 2;
      if (start < 0 || n === 0) return undefined;
      const map = cbor(hex.slice(start, end - 6));
      if (!map || typeof map !== 'object' || Array.isArray(map)) return undefined;
      const m = map as Record<string, unknown>;
      const parts: string[] = [];
      if (typeof m.a === 'string') parts.push(`app ${m.a}`);
      if (typeof m.w === 'string') parts.push(`wallet ${m.w}`);
      if (Array.isArray(m.s) && m.s.length) parts.push(`services ${m.s.map(String).join(', ')}`);
      if (m.m && typeof m.m === 'object') parts.push(`metadata ${JSON.stringify(m.m).slice(0, 200)}`);
      return { bytes: (hex.length - start) / 2, schema, parts: parts.length ? parts : ['no codes'] };
    }
  } catch { return undefined; }
  return undefined;
}
