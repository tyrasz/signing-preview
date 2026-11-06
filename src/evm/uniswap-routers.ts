// Uniswap's routers before the Universal Router, still used directly and by many dApps: V2 Router02, V3 SwapRouter
// and SwapRouter02 (V3 and V2 swaps, multicall with unwrap/sweep). Only Uniswap's own deployments get a headline: a
// lookalike contract with the same function names could do anything.
import { decodeFunctionData, parseAbi, toFunctionSelector, type Hex } from 'viem';
import { formatUnits, PreviewBuilder, sameAddress, shortAddress, utcDate } from '../format.ts';
import { CHAINS } from '../chains.ts';
import { decoded, tokenInfo, type Adapter, type AdapterEnv } from './common.ts';
import { v3Path, wrappedNative } from './universal-router.ts';

const ROUTERS: Record<string, { name: string; chains: number[]; kind: 'v2' | 'v3' | 'v3-02' }> = {
  '0x7a250d5630b4cf539739df2c5dacb4c659f2488d': { name: 'Uniswap V2 Router02', chains: [1], kind: 'v2' },
  '0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24': { name: 'Uniswap V2 Router02', chains: [42161], kind: 'v2' },
  '0xe592427a0aece92de3edee1f18e0157c05861564': { name: 'Uniswap V3 SwapRouter', chains: [1, 42161], kind: 'v3' },
  '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45': { name: 'Uniswap SwapRouter02', chains: [1, 42161], kind: 'v3-02' },
};
const V2 = parseAbi([
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)',
  'function swapTokensForExactTokens(uint256 amountOut, uint256 amountInMax, address[] path, address to, uint256 deadline)',
  'function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable',
  'function swapTokensForExactETH(uint256 amountOut, uint256 amountInMax, address[] path, address to, uint256 deadline)',
  'function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)',
  'function swapETHForExactTokens(uint256 amountOut, address[] path, address to, uint256 deadline) payable',
  'function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)',
  'function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable',
  'function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)',
]);
// V3 SwapRouter's params carry a deadline; SwapRouter02's don't (it moved to multicall).
const V3 = parseAbi([
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable',
  'function exactInput((bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum) params) payable',
  'function exactOutputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountOut, uint256 amountInMaximum, uint160 sqrtPriceLimitX96) params) payable',
  'function exactOutput((bytes path, address recipient, uint256 deadline, uint256 amountOut, uint256 amountInMaximum) params) payable',
  'function multicall(bytes[] data) payable',
  'function unwrapWETH9(uint256 amountMinimum, address recipient) payable',
]);
const V3_02 = parseAbi([
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable',
  'function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum) params) payable',
  'function exactOutputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountOut, uint256 amountInMaximum, uint160 sqrtPriceLimitX96) params) payable',
  'function exactOutput((bytes path, address recipient, uint256 amountOut, uint256 amountInMaximum) params) payable',
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to) payable',
  'function swapTokensForExactTokens(uint256 amountOut, uint256 amountInMax, address[] path, address to) payable',
  'function multicall(bytes[] data) payable',
  'function multicall(uint256 deadline, bytes[] data) payable',
  'function multicall(bytes32 previousBlockhash, bytes[] data) payable',
  'function unwrapWETH9(uint256 amountMinimum, address recipient) payable',
  'function unwrapWETH9(uint256 amountMinimum) payable',
]);
// SwapRouter02's recipient placeholders.
const MSG_SENDER = '0x0000000000000000000000000000000000000001', ADDRESS_THIS = '0x0000000000000000000000000000000000000002';

interface Swap { tokenIn: string; tokenOut: string; amountIn: bigint; amountOut: bigint; exactIn: boolean; recipient: string; deadline?: bigint; fees?: number[] }

/** The swaps (and an unwrap to ETH, if any) one call or multicall makes. */
function swapsOf(kind: 'v2' | 'v3' | 'v3-02', data: Hex, depth = 0): { swaps: Swap[]; unwrapTo?: string; deadline?: bigint } | null {
  const abi = kind === 'v2' ? V2 : kind === 'v3' ? V3 : V3_02;
  let c;
  try { c = decodeFunctionData({ abi, data }); } catch { return null; }
  const name = c.functionName as string, a = c.args as readonly unknown[];
  if (name === 'multicall' && depth === 0) {
    const inner = a[a.length - 1] as readonly Hex[];
    const out: { swaps: Swap[]; unwrapTo?: string; deadline?: bigint } = { swaps: [], ...(a.length === 2 && typeof a[0] === 'bigint' && { deadline: a[0] as bigint }) };
    for (const d of inner) {
      const r = swapsOf(kind, d, 1);
      if (!r) continue;
      out.swaps.push(...r.swaps);
      if (r.unwrapTo) out.unwrapTo = r.unwrapTo;
    }
    return out;
  }
  if (name === 'unwrapWETH9') return { swaps: [], unwrapTo: (a[1] as string | undefined) ?? MSG_SENDER };
  if (name.startsWith('swap')) {
    const path = (name.startsWith('swapExactETH') || name === 'swapETHForExactTokens' ? a[1] : a[2]) as readonly string[];
    const exactIn = name.startsWith('swapExact');
    const [x, y] = name.startsWith('swapExactETH') || name === 'swapETHForExactTokens' ? [0n, a[0] as bigint] : [a[0] as bigint, a[1] as bigint];
    const to = (name.startsWith('swapExactETH') || name === 'swapETHForExactTokens' ? a[2] : a[3]) as string;
    const deadline = kind === 'v2' ? (a[a.length - 1] as bigint) : undefined;
    return { swaps: [{ tokenIn: path[0], tokenOut: path[path.length - 1], amountIn: exactIn ? x : y, amountOut: exactIn ? y : x, exactIn, recipient: to, deadline }] };
  }
  const p = a[0] as Record<string, unknown>;
  const exactIn = name.startsWith('exactInput');
  if (name.endsWith('Single')) {
    return { swaps: [{ tokenIn: p.tokenIn as string, tokenOut: p.tokenOut as string, amountIn: (exactIn ? p.amountIn : p.amountInMaximum) as bigint, amountOut: (exactIn ? p.amountOutMinimum : p.amountOut) as bigint, exactIn, recipient: p.recipient as string, deadline: p.deadline as bigint | undefined, fees: [Number(p.fee)] }] };
  }
  const path = v3Path(p.path as Hex);
  if (!path) return null;
  // exactOutput paths run backwards, from the output token to the input.
  const [tokenIn, tokenOut] = exactIn ? [path.tokens[0], path.tokens[path.tokens.length - 1]] : [path.tokens[path.tokens.length - 1], path.tokens[0]];
  return { swaps: [{ tokenIn, tokenOut, amountIn: (exactIn ? p.amountIn : p.amountInMaximum) as bigint, amountOut: (exactIn ? p.amountOutMinimum : p.amountOut) as bigint, exactIn, recipient: p.recipient as string, deadline: p.deadline as bigint | undefined, fees: path.fees }] };
}

async function amountOf(env: AdapterEnv, chainId: number, token: string, raw: bigint, native: boolean): Promise<string> {
  const chain = CHAINS[chainId];
  if (native) return `${formatUnits(raw, chain?.nativeDecimals ?? 18)} ${chain?.nativeSymbol ?? 'ETH'}`;
  const t = await tokenInfo(env, chainId, token);
  return t ? `${formatUnits(raw, t.decimals)} ${t.symbol}` : `${raw} base units of ${shortAddress(token)}`;
}

export const uniswapRoutersAdapter: Adapter = async (tx, env) => {
  const r = tx.to && ROUTERS[tx.to.toLowerCase()];
  if (!r || !r.chains.includes(tx.chainId)) return null;
  const parsed = swapsOf(r.kind, tx.data);
  if (!parsed || !parsed.swaps.length) return null;
  return describe(tx, env, r, parsed);
};

/**
 * Other contracts called with Uniswap's router functions: forks (HyperEVM's main DEXes are), or anything with the same
 * function names. With a verified ABI that has the function, the headline is given under the contract's name;
 * without one, it is marked partial and cautioned, since only the contract's code decides what the call does.
 */
export const uniswapForkAdapter: Adapter = async (tx, env) => {
  if (!tx.to || ROUTERS[tx.to.toLowerCase()] || tx.data.length < 10) return null;
  for (const kind of ['v3-02', 'v3', 'v2'] as const) {
    const parsed = swapsOf(kind, tx.data);
    if (!parsed?.swaps.length) continue;
    let contract = null;
    try { contract = env.deps.abis ? await env.deps.abis.resolve(tx.chainId, tx.to) : null; } catch { contract = null; }
    const selector = tx.data.slice(0, 10);
    const verified = !!contract?.verified && (contract.abi as { type?: string; name?: string; inputs?: unknown[] }[]).some(f => { try { return f.type === 'function' && toFunctionSelector(f as never) === selector; } catch { return false; } });
    const name = verified ? contract!.name ?? shortAddress(tx.to) : `a Uniswap-style router (${shortAddress(tx.to)})`;
    const d = await describe(tx, env, { name, kind }, parsed, !verified);
    return d;
  }
  return null;
};

async function describe(tx: Parameters<Adapter>[0], env: AdapterEnv, r: { name: string; kind: 'v2' | 'v3' | 'v3-02' }, parsed: NonNullable<ReturnType<typeof swapsOf>>, unverified = false) {
  const weth = wrappedNative(tx.chainId) ?? '';
  const first = parsed.swaps[0], last = parsed.swaps[parsed.swaps.length - 1];
  // ETH in: value sent with a WETH input; ETH out: the ETH-out V2 functions, or an unwrap after the swap.
  const ethIn = tx.value > 0n && sameAddress(first.tokenIn, weth);
  const v2EthOut = r.kind === 'v2' && /ForETH|ForExactETH/.test(decodeFunctionData({ abi: V2, data: tx.data }).functionName);
  const ethOut = sameAddress(last.tokenOut, weth) && (v2EthOut || !!parsed.unwrapTo);
  const sumIn = parsed.swaps.filter(s => sameAddress(s.tokenIn, first.tokenIn)).reduce((t, s) => t + s.amountIn, 0n);
  const sumOut = parsed.swaps.filter(s => sameAddress(s.tokenOut, last.tokenOut)).reduce((t, s) => t + s.amountOut, 0n);
  const sent = await amountOf(env, tx.chainId, first.tokenIn, ethIn && first.exactIn ? (sumIn || tx.value) : sumIn, ethIn);
  const got = await amountOf(env, tx.chainId, last.tokenOut, sumOut, ethOut);
  const b = new PreviewBuilder().detail('Contract', r.name.includes(tx.to!.slice(0, 6)) ? tx.to! : `${r.name} (${tx.to})`, tx.to!);
  const exactIn = first.exactIn;
  b.detail(exactIn ? 'You send' : 'You send at most', sent).detail(exactIn ? 'You receive at least' : 'You receive', got);
  if (parsed.swaps.some(s => s.fees)) b.detail('Pool fees', parsed.swaps.flatMap(s => s.fees ?? []).map(f => `${f / 10_000}%`).join(', '));
  // Where the output goes: SwapRouter02's placeholders mean the sender (1) or the router itself, for an unwrap after (2).
  const recipient = (parsed.unwrapTo && ethOut ? parsed.unwrapTo : last.recipient).toLowerCase();
  const toYou = sameAddress(recipient, tx.from) || sameAddress(recipient, MSG_SENDER) || (sameAddress(recipient, ADDRESS_THIS) && !parsed.unwrapTo);
  if (!toYou && !sameAddress(recipient, tx.to!)) {
    b.detail('Recipient', recipient);
    b.warn('caution', 'recipient_not_sender', `What you buy goes to ${shortAddress(recipient)}, not to you.`);
  }
  if (exactIn && sumOut <= 1n) b.warn('caution', 'no_slippage_limit', 'Nothing limits the price: the minimum received is zero, so the swap would go through at any rate.');
  const deadline = parsed.deadline ?? first.deadline;
  if (deadline !== undefined) {
    const when = utcDate(deadline, true);
    if (when) b.detail('Deadline', when);
    if (env.context.now !== undefined && Number(deadline) * 1000 < env.context.now) b.warn('info', 'deadline_passed', 'The deadline has passed, so the swap would revert.');
  }
  const where = ROUTERS[tx.to!.toLowerCase()] ? 'Uniswap' : r.name;
  if (unverified) b.warn('caution', 'unverified_signature', `${shortAddress(tx.to!)} isn't one of Uniswap's own routers and has no verified source here: the call was recognised by its shape (a Uniswap-style swap), but only the contract's code decides what it does. Rely on the simulated balance changes.`);
  const title = exactIn ? `Swap ${sent} for at least ${got} on ${where}` : `Buy ${got} for at most ${sent} on ${where}`;
  return decoded({ title, summary: `${exactIn ? 'Swaps' : 'Buys'} through ${r.name}${parsed.swaps.length > 1 ? ` in ${parsed.swaps.length} swaps` : ''}: ${exactIn ? `${sent} for at least ${got}` : `${got} for at most ${sent}`}.`, decoder: unverified ? 'uniswap_style_router' : 'uniswap_router', status: unverified ? 'partial' : 'full', b });
}
