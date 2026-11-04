import { decodeFunctionData, encodeFunctionData, parseAbiItem, toFunctionSelector, toFunctionSignature, type Abi, type AbiFunction, type AbiParameter, type Hex } from 'viem';
import { formatUnits, isUnlimited, PreviewBuilder, sameAddress, shortAddress } from '../format.ts';
import type { SignatureCandidate, TokenInfo } from '../types.ts';
import { decoded, nativeAmount, selectorOf, tokenInfo, tokenSourceWarnings, type Adapter, type AdapterEnv, type Tx } from './common.ts';

interface Call { fn: AbiFunction; args: readonly unknown[] }

const MAX_DETAILS = 40;
const SENSITIVE = new Map<string, string>([
  ['transferOwnership', 'Changes the owner of this contract.'], ['renounceOwnership', 'Gives up ownership of this contract permanently.'],
  ['upgradeTo', 'Replaces the code behind this contract.'], ['upgradeToAndCall', 'Replaces the code behind this contract and runs a call.'],
  ['grantRole', 'Gives an address a permission role on this contract.'], ['setOperator', 'Lets another address act for you on this contract.'],
]);

/** Decodes against an ABI and, to rule out accidental matches, requires re-encoding to reproduce the calldata. */
function decodeStrict(abi: readonly unknown[], data: Hex): Call | null {
  try {
    const r = decodeFunctionData({ abi: abi as Abi, data });
    const fn = (abi as Abi).find((i): i is AbiFunction => i.type === 'function' && i.name === r.functionName && toFunctionSelector(i) === data.slice(0, 10));
    if (!fn) return null;
    const args = r.args ?? [];
    if (encodeFunctionData({ abi: [fn], functionName: fn.name, args: args as never }).toLowerCase() !== data.toLowerCase()) return null;
    return { fn, args };
  } catch {
    return null;
  }
}

function fromSignature(sig: string, data: Hex): Call | null {
  try { return decodeStrict([parseAbiItem(`function ${sig}`)], data); } catch { return null; }
}

const isAddress = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);

async function label(env: AdapterEnv, tx: Tx, address: string): Promise<{ text: string; token?: TokenInfo }> {
  if (sameAddress(address, tx.from)) return { text: `${address} (you)` };
  if (/^0x0{40}$/.test(address)) return { text: `${address} (zero address)` };
  const token = await tokenInfo(env, tx.chainId, address);
  return token ? { text: `${token.symbol}${token.source === 'onchain' ? ' (self-reported)' : ''} (${address})`, token } : { text: address };
}

/** Which token an amount-like parameter (by name) is denominated in, if the call says. */
type AmountTokens = (paramName: string) => TokenInfo | undefined;

/**
 * Infers amount denominations from parameter names, in this order:
 *  - one token-like address parameter (token/asset/currency): every amount is in that token (Aave, ERC-20 helpers);
 *  - tokenIn/tokenOut: amountIn* and amountOut* respectively (Uniswap V3 style);
 *  - an address[] path: amountIn* in path[0], amountOut* in the last token (Uniswap V2 style).
 */
async function amountTokens(b: PreviewBuilder, env: AdapterEnv, tx: Tx, inputs: readonly AbiParameter[], values: readonly unknown[]): Promise<AmountTokens> {
  const warned = new Set<string>();
  const token = async (a: unknown) => {
    const t = isAddress(a) ? await tokenInfo(env, tx.chainId, a) : undefined;
    if (t && !warned.has(t.address.toLowerCase())) { warned.add(t.address.toLowerCase()); tokenSourceWarnings(b, tx.chainId, t); }
    return t;
  };
  const params = inputs.map((p, i) => ({ p, v: values[i] }));
  const tokenParams = params.filter(({ p, v }) => p.type === 'address' && /token|asset|currency/i.test(p.name ?? '') && isAddress(v));
  if (tokenParams.length === 1) { const t = await token(tokenParams[0].v); return () => t; }
  const rules: [RegExp, TokenInfo | undefined][] = [];
  for (const { p, v } of tokenParams) {
    const side = /^token(In|Out)$/i.exec(p.name ?? '')?.[1];
    if (side) rules.push([new RegExp(`^amount${side}`, 'i'), await token(v)]);
  }
  const path = params.find(({ p }) => p.name === 'path' && p.type === 'address[]')?.v;
  if (Array.isArray(path) && path.length >= 2) rules.push([/^amountIn/i, await token(path[0])], [/^amountOut/i, await token(path[path.length - 1])]);
  return name => rules.find(([re]) => re.test(name))?.[1];
}

/** Flattens decoded arguments into details. Amount-like integers are formatted with their token's decimals. */
async function renderArgs(b: PreviewBuilder, env: AdapterEnv, tx: Tx, inputs: readonly AbiParameter[], values: readonly unknown[], prefix = '') {
  const amountToken = await amountTokens(b, env, tx, inputs, values);
  for (const [i, p] of inputs.entries()) {
    if (b.details.length >= MAX_DETAILS) { b.detail('…', 'more arguments not shown'); return; }
    const name = `${prefix}${p.name || `arg${i + 1}`}`;
    await renderValue(b, env, tx, name, p, values[i], amountToken);
  }
}

async function renderValue(b: PreviewBuilder, env: AdapterEnv, tx: Tx, name: string, p: AbiParameter, v: unknown, amountToken: AmountTokens): Promise<void> {
  if (b.details.length >= MAX_DETAILS) return;
  const type = p.type;
  if (type.endsWith(']') && Array.isArray(v)) {
    const inner = { ...p, type: type.slice(0, type.lastIndexOf('[')) } as AbiParameter;
    if (v.length === 0) { b.detail(name, '(empty list)'); return; }
    for (const [i, item] of v.slice(0, 10).entries()) await renderValue(b, env, tx, `${name}[${i}]`, inner, item, amountToken);
    if (v.length > 10) b.detail(name, `… ${v.length - 10} more`);
    return;
  }
  if (type === 'tuple' && 'components' in p && v && typeof v === 'object') {
    const comps = p.components as readonly AbiParameter[];
    const vals = Array.isArray(v) ? v : comps.map(c => (v as Record<string, unknown>)[c.name ?? '']);
    await renderArgs(b, env, tx, comps, vals, `${name}.`);
    return;
  }
  if (type === 'address' && isAddress(v)) { b.detail(name, (await label(env, tx, v)).text, v); return; }
  if (/^u?int\d*$/.test(type) && typeof v === 'bigint') {
    if (type.startsWith('uint') && isUnlimited(v) && v > 0n) { b.detail(name, 'unlimited (maximum value)', v.toString()); return; }
    const leaf = name.slice(name.lastIndexOf('.') + 1).replace(/\[\d+\]$/, '');
    const t = /amount|value|wad|qty|quantity/i.test(leaf) ? amountToken(leaf) : undefined;
    if (t) { b.detail(name, `${formatUnits(v, t.decimals)} ${t.symbol}`, v.toString()); return; }
    b.detail(name, v.toString());
    return;
  }
  if (type === 'bool') { b.detail(name, v ? 'true' : 'false'); return; }
  if (type === 'string') { const s = String(v); b.detail(name, s.length > 200 ? s.slice(0, 197) + '…' : s); return; }
  if (type.startsWith('bytes') && typeof v === 'string') { b.detail(name, type === 'bytes' ? `${(v.length - 2) / 2} bytes` : v, v); return; }
  b.detail(name, typeof v === 'bigint' ? v.toString() : JSON.stringify(v, (_k, x) => typeof x === 'bigint' ? x.toString() : x));
}

const typesOf = (c: Call) => toFunctionSignature(c.fn); // canonical, e.g. exactInputSingle((address,address,uint24,...))
const describeCall = (c: Call) => `${c.fn.name}(${c.fn.inputs.map(i => i.name || i.type).join(', ')})`;

/** Decodes calls to any contract using a verified ABI, or (marked unverified) a public signature database. */
export const abiAdapter: Adapter = async (tx, env) => {
  if (!tx.to || tx.data.length < 10) return null;
  const { abis, signatures } = env.deps;
  if (!abis && !signatures) return null;
  let contract = null;
  try { contract = abis ? await abis.resolve(tx.chainId, tx.to) : null; } catch { contract = null; }
  const b = new PreviewBuilder();
  let call = contract ? decodeStrict(contract.abi, tx.data) : null;
  let basis: 'verified' | 'signature' = 'verified';
  let guess: SignatureCandidate | undefined;
  let rivals: Call[] = [];
  if (!call && signatures) {
    const selector = selectorOf(tx.data)!;
    let cands: SignatureCandidate[] = [];
    try { cands = signatures.candidates ? await signatures.candidates(selector) : (await signatures.lookup(selector)).map(signature => ({ signature, tier: 2 })); } catch { cands = []; }
    // Keep candidates that reproduce the calldata exactly. Several can: address and uint256 are both one 32-byte
    // word, so e.g. 4byte's spam "workMyDirefulOwner(uint256,uint256)" fits every transfer(address,uint256).
    const seen = new Set<string>();
    const fits = cands.flatMap(c => {
      const decodedCall = fromSignature(c.signature, tx.data);
      if (!decodedCall) return [];
      const key = typesOf(decodedCall); // sources can repeat a function under other parameter names
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ cand: c, call: decodedCall }];
    }).sort((a, b) => a.cand.tier - b.cand.tier);
    if (fits.length) {
      // The most trusted source decides; candidates found only in less trusted sources are ignored.
      const top = fits.filter(f => f.cand.tier === fits[0].cand.tier);
      if (top.length > 1 && !top.every(f => f.cand.ordered)) {
        b.detail('Contract', tx.to).detail('Function selector', selector).detail('Possible functions', top.map(f => typesOf(f.call)).join(' | '));
        b.warn('caution', 'ambiguous_signature', 'Several known functions share this selector and all fit the data, so which one is called cannot be told without the verified contract source.');
        return decoded({ title: `Call ${top[0].call.fn.name} or similar on ${shortAddress(tx.to)}`, summary: 'Calls a function identified only by its selector; several candidates fit.', decoder: 'abi_signature', status: 'opaque', b });
      }
      call = top[0].call;
      guess = top[0].cand;
      rivals = top.slice(1).map(f => f.call);
      basis = 'signature';
    }
  }
  if (!call) return null;

  const tokenSelf = await tokenInfo(env, tx.chainId, tx.to);
  const contractLabel = contract?.name ?? (tokenSelf ? tokenSelf.symbol : shortAddress(tx.to));
  b.detail('Contract', contract?.name ? `${contract.name} (${tx.to})` : tx.to, tx.to).detail('Function', describeCall(call));
  if (contract?.implementation) b.detail('Proxy implementation', contract.implementation);
  const builtIn = guess?.tier === 0;
  b.detail('ABI source', basis === 'verified' ? contract!.source : builtIn ? 'built-in list of common functions (unverified for this contract)' : `${guess?.source ? guess.source + ' ' : 'public '}signature database (unverified)`);
  if (tokenSelf) tokenSourceWarnings(b, tx.chainId, tokenSelf);
  if (tx.value > 0n) b.detail('Value sent', nativeAmount(tx.chainId, tx.value), tx.value.toString());
  await renderArgs(b, env, tx, call.fn.inputs, call.args);

  // Batched calls to the same contract (e.g. Uniswap routers' multicall(bytes[])).
  if (call.fn.name === 'multicall') {
    const inner = call.args.find(a => Array.isArray(a)) as Hex[] | undefined;
    for (const [i, data] of (inner ?? []).slice(0, 10).entries()) {
      const c = (contract ? decodeStrict(contract.abi, data) : null);
      b.detail(`Batched call ${i + 1}`, c ? describeCall(c) : `${data.slice(0, 10)} (not decoded)`);
    }
  }
  if (basis === 'signature') b.warn('caution', 'unverified_signature', `The function was identified by its selector${builtIn ? ' from a list of common functions' : ' from a public signature database'}, not from this contract's verified source. The name "${call.fn.name}" is a guess that fits the data.`);
  if (rivals.length) b.warn('caution', 'ambiguous_signature', `${rivals.length + 1} functions registered for this selector fit the data. The earliest registered, ${typesOf(call)}, is shown; also possible: ${rivals.slice(0, 3).map(typesOf).join(', ')}${rivals.length > 3 ? ` and ${rivals.length - 3} more` : ''}.`);
  const sensitive = SENSITIVE.get(call.fn.name);
  if (sensitive) b.warn('caution', 'sensitive_function', sensitive);
  if (contract?.source.startsWith('sourcify') || contract?.source === 'etherscan' || contract?.source.includes(' via ')) b.note(`Decoded with the verified ABI from ${contract.source}.`);
  return decoded({
    title: `Call ${call.fn.name} on ${contractLabel}`,
    summary: `${basis === 'verified' ? 'Calls' : 'Appears to call'} ${call.fn.name} on ${contractLabel}${call.fn.inputs.length ? ` with ${call.fn.inputs.length} argument${call.fn.inputs.length === 1 ? '' : 's'}` : ''}.`,
    decoder: basis === 'verified' ? 'abi_verified' : 'abi_signature', status: basis === 'verified' ? 'full' : 'partial', b,
  });
};
