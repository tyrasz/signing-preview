// Uniswap Universal Router: execute(commands, inputs[, deadline]). Each command byte selects an action and each
// input is its ABI-encoded arguments. Command IDs and layouts follow the verified sources on Sourcify
// (contracts/libraries/Commands.sol, contracts/base/Dispatcher.sol, v4-periphery V4Router/Actions). Three command
// tables are in use: 2.1.x/2.2.0 (2.0 plus per-hop minimum prices on every swap, PAY_PORTION_FULL_PRECISION, Across
// bridging and executeSigned), 2.0 (adds Uniswap v4) and 1.2, whose commands 0x10-0x1e are NFT marketplaces instead.
// The original 1.0 router (mask 0x1f, older NFT markets) is not decoded.
import { collectionLabel } from './effects.ts';
import { decodeAbiParameters, decodeFunctionData, hexToBytes, parseAbi, parseAbiParameters, recoverTypedDataAddress, type Hex } from 'viem';
import { compactUnits, formatUnits, isUnlimited, PreviewBuilder, sameAddress, shortAddress, utcDate } from '../format.ts';
import { builtinTokens, CHAINS } from '../chains.ts';
import type { AssetChange, TokenInfo } from '../types.ts';
import { decoded, selectorOf, tokenInfo, tokenSourceWarnings, type Adapter, type AdapterEnv, type Decoded, type Tx } from './common.ts';

/** The command table: 'v2.1' covers releases 2.1.1, 2.1.2 and 2.2.0, whose Commands.sol and Dispatcher.sol match. */
type Version = 'v2.1' | 'v2' | 'v1.2' | 'v1.0';
/**
 * Official deployments (github.com/Uniswap/universal-router deploy-addresses), each verified on Sourcify as
 * UniversalRouter. `release` is shown to the user.
 */
export const UNIVERSAL_ROUTERS: Record<string, { chainId: number; version: Version; release: string }> = {
  '0x23617e59a5925b2a4bf75d73ff6711cd0b29de85': { chainId: 1, version: 'v2.1', release: '2.1.2' },
  '0x4c82d1fbfe28c977cbb58d8c7ff8fcf9f70a2cca': { chainId: 1, version: 'v2.1', release: '2.1.1' },
  '0x66a9893cc07d91d95644aedd05d03f95e1dba8af': { chainId: 1, version: 'v2', release: '2.0' },
  '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad': { chainId: 1, version: 'v1.2', release: '1.2' },
  // The original release (Nov 2022), with its NFT-era command table; little used since 1.2.
  '0xef1c6e67703c7bd7107eed8303fbe6ec2554bf6b': { chainId: 1, version: 'v1.0', release: '1.0' },
  '0x2d01411773c8c24805306e89a41f7855c3c4fe65': { chainId: 42161, version: 'v2.1', release: '2.1.2' },
  '0x8b844f885672f333bc0042cb669255f93a4c1e6b': { chainId: 42161, version: 'v2.1', release: '2.1.1' },
  '0xa51afafe0263b40edaef0df8781ea9aa03e381a3': { chainId: 42161, version: 'v2', release: '2.0' },
  '0x5e325eda8064b456f4781070c0738d849c824258': { chainId: 42161, version: 'v1.2', release: '1.2' },
  '0xec8b0f7ffe3ae75d7ffab09429e3675bb63503e4': { chainId: 42161, version: 'v1.2', release: '1.2' }, // the build without Uniswap v2
  '0x4c60051384bd2d3c01bfc845cf5f4b44bcbe9de5': { chainId: 42161, version: 'v1.0', release: '1.0' },
  '0x9afe3c497e19501db228f28cdbdd29bc98f65dba': { chainId: 999, version: 'v2.1', release: '2.2.0' },
  '0xed270a1bcdc63cf1356d695e7f40961d4819d6bf': { chainId: 999, version: 'v2.1', release: '2.1.2' },
};

const EXECUTE = parseAbi([
  'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
  'function execute(bytes commands, bytes[] inputs) payable',
  // 2.1+: the same commands with a route signature (RouteSigner). The payer is still the transaction's sender.
  'function executeSigned(bytes commands, bytes[] inputs, bytes32 intent, bytes32 data, bool verifySender, bytes32 nonce, bytes signature, uint256 deadline) payable',
]);
const CONTRACT_BALANCE = 1n << 255n; // "use the router's whole balance"
const MSG_SENDER = '0x0000000000000000000000000000000000000001';
const ADDRESS_THIS = '0x0000000000000000000000000000000000000002';
const NATIVE = '0x0000000000000000000000000000000000000000'; // ETH in sweep/transfer and v4 currencies
const ALLOW_REVERT = 0x80;
const commandId = (c: Ctx, byte: number) => byte & (c.version === 'v2.1' ? 0x7f : c.version === 'v1.0' ? 0x1f : 0x3f);

const P = {
  swap: parseAbiParameters('address recipient, uint256 amount, uint256 limit, bytes path, bool payerIsUser'),
  swapV2: parseAbiParameters('address recipient, uint256 amount, uint256 limit, address[] path, bool payerIsUser'),
  // 2.1+: v2/v3 swaps end with the per-hop minimum prices (1e36 fixed point; empty disables them).
  hopPrices: parseAbiParameters('uint256, uint256, uint256, uint256, uint256, uint256[] minHopPriceX36'),
  tokenRecipientAmount: parseAbiParameters('address token, address recipient, uint256 amount'),
  recipientAmount: parseAbiParameters('address recipient, uint256 amount'),
  permitSingle: parseAbiParameters('((address token, uint160 amount, uint48 expiration, uint48 nonce) details, address spender, uint256 sigDeadline) permit, bytes signature'),
  permitBatch: parseAbiParameters('((address token, uint160 amount, uint48 expiration, uint48 nonce)[] details, address spender, uint256 sigDeadline) permit, bytes signature'),
  transferBatch: parseAbiParameters('(address from, address to, uint160 amount, address token)[] details'),
  balanceCheck: parseAbiParameters('address owner, address token, uint256 minBalance'),
  subPlan: parseAbiParameters('bytes commands, bytes[] inputs'),
  valueData: parseAbiParameters('uint256 value, bytes data'),
  // v4
  actions: parseAbiParameters('bytes actions, bytes[] params'),
  exactInSingle: parseAbiParameters('((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, bytes hookData) params'),
  exactIn: parseAbiParameters('(address currencyIn, (address intermediateCurrency, uint24 fee, int24 tickSpacing, address hooks, bytes hookData)[] path, uint128 amountIn, uint128 amountOutMinimum) params'),
  // 2.1+ (v4-periphery IV4Router): a minimum price per hop, between the amounts and hookData / after the path.
  exactInSingle21: parseAbiParameters('((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, uint256 minHopPriceX36, bytes hookData) params'),
  exactIn21: parseAbiParameters('(address currencyIn, (address intermediateCurrency, uint24 fee, int24 tickSpacing, address hooks, bytes hookData)[] path, uint256[] minHopPriceX36, uint128 amountIn, uint128 amountOutMinimum) params'),
  across: parseAbiParameters('(address depositor, address recipient, address inputToken, address outputToken, uint256 inputAmount, uint256 outputAmount, uint256 destinationChainId, address exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes message, bool useNative) params'),
  currencyAmount: parseAbiParameters('address currency, uint256 amount'),
  currencyAmountBool: parseAbiParameters('address currency, uint256 amount, bool payerIsUser'),
  currencyRecipientAmount: parseAbiParameters('address currency, address recipient, uint256 amount'),
  poolKeyPrice: parseAbiParameters('(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, uint160 sqrtPriceX96'),
};

/** One swap hop or route, normalised across Uniswap v2, v3 and v4. */
interface Leg { protocol: 'v2' | 'v3' | 'v4'; exactIn: boolean; tokenIn: string; tokenOut: string; amountIn: bigint; amountOut: bigint; recipient: string }

interface Ctx {
  env: AdapterEnv; tx: Tx; router: string; version: Version; b: PreviewBuilder;
  steps: string[]; legs: Leg[]; wraps: bigint[]; unwraps: { recipient: string; amountMin: bigint }[];
  outputs: { recipient: string; what: string }[]; unknown: number; declaredApprovals: NonNullable<Decoded['declaredApprovals']>;
  permit2Pulls: Map<string, bigint>;
  /** Tokens your wallet pays into the route and tokens delivered to you (addresses; NATIVE for ETH). */
  paid: Set<string>; received: Set<string>;
  /** Interface-fee lines, shown after the steps. */
  fees: string[];
  /** Some swap enforces per-hop minimum prices, which protect against slippage even when the minimum output is 0. */
  priceLimited: boolean;
  /** Across deposits (ACROSS_V4_DEPOSIT_V3): where the route's output is bridged to. */
  bridges: { chain: string; text: string }[];
}

const isAddr = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const pct = (fee: number) => fee === 0x800000 ? 'dynamic fee' : `${+(fee / 10_000).toFixed(4)}% fee`;

async function token(c: Ctx, address: string): Promise<{ symbol: string; decimals?: number; info?: TokenInfo }> {
  if (isAddr(address, NATIVE)) { const chain = CHAINS[c.tx.chainId]; return { symbol: chain?.nativeSymbol ?? 'ETH', decimals: chain?.nativeDecimals ?? 18 }; }
  const info = await tokenInfo(c.env, c.tx.chainId, address);
  if (info) tokenSourceWarnings(c.b, c.tx.chainId, info);
  return info ? { symbol: info.symbol, decimals: info.decimals, info } : { symbol: shortAddress(address) };
}

async function amount(c: Ctx, address: string, raw: bigint, compact = false): Promise<string> {
  const t = await token(c, address);
  if (raw === CONTRACT_BALANCE) return `all of the router's ${t.symbol}`;
  return t.decimals !== undefined ? `${(compact ? compactUnits : formatUnits)(raw, t.decimals)} ${t.symbol}` : `${raw} base units of ${t.symbol}`;
}

function who(c: Ctx, recipient: string): string {
  if (isAddr(recipient, MSG_SENDER) || sameAddress(recipient, c.tx.from)) return 'you';
  if (isAddr(recipient, ADDRESS_THIS) || sameAddress(recipient, c.router)) return 'the router, for a later step';
  return recipient;
}
const toOther = (c: Ctx, recipient: string) => who(c, recipient) === recipient;

/** v3 paths are packed: token (20 bytes), then fee (3 bytes) + token per hop. */
export function v3Path(path: Hex): { tokens: string[]; fees: number[] } | null {
  const hex = path.slice(2);
  if (hex.length < 86 || (hex.length - 40) % 46 !== 0) return null;
  const tokens = ['0x' + hex.slice(0, 40)], fees: number[] = [];
  for (let i = 40; i < hex.length; i += 46) { fees.push(parseInt(hex.slice(i, i + 6), 16)); tokens.push('0x' + hex.slice(i + 6, i + 46)); }
  return { tokens, fees };
}

/** 2.1+: per-hop minimum prices (1e36 fixed point; empty or 0 disables them) bound the price of every hop. */
function hopLimits(c: Ctx, limited: boolean): string {
  if (!limited) return '';
  c.priceLimited = true;
  return 'per-hop minimum prices';
}
const v2v3HopLimits = (c: Ctx, input: Hex) => hopLimits(c, c.version === 'v2.1' && decodeAbiParameters(P.hopPrices, input)[5].some(p => p > 0n));
const routeLabel = (...parts: string[]) => parts.filter(Boolean).join(', ');

async function swapStep(c: Ctx, leg: Leg, route: string, payerIsUser: boolean | undefined) {
  c.legs.push(leg);
  if (payerIsUser) c.paid.add(leg.tokenIn.toLowerCase());
  if (leg.protocol !== 'v4' && who(c, leg.recipient) === 'you') c.received.add(leg.tokenOut.toLowerCase());
  const sym = (await token(c, leg.tokenIn)).symbol;
  const from = !leg.exactIn && isUnlimited(leg.amountIn) && leg.amountIn !== CONTRACT_BALANCE ? `as much ${sym} as needed`
    : leg.protocol === 'v4' && leg.exactIn && leg.amountIn === 0n ? `the open ${sym} balance` // OPEN_DELTA: what earlier actions left owed
    : await amount(c, leg.tokenIn, leg.amountIn);
  const to = await amount(c, leg.tokenOut, leg.amountOut);
  const payer = payerIsUser === undefined ? '' : payerIsUser ? ', paid from your wallet through Permit2' : ', paid from the router';
  const text = leg.exactIn ? `Swap ${from} for at least ${to}` : `Swap ${from.startsWith('as much') ? '' : 'at most '}${from} for exactly ${to}`;
  // A v4 swap leaves the output as an open balance; the TAKE / TAKE_ALL step that follows says where it goes.
  const dest = leg.protocol === 'v4' ? '' : `, to ${who(c, leg.recipient)}`;
  c.steps.push(`${text} on Uniswap ${leg.protocol}${route ? ` (${route})` : ''}${payer}${dest}`);
  if (!isAddr(leg.recipient, ADDRESS_THIS) && !sameAddress(leg.recipient, c.router)) c.outputs.push({ recipient: leg.recipient, what: `swap output (${(await token(c, leg.tokenOut)).symbol})` });
}

async function permitStep(c: Ctx, details: readonly { token: string; amount: bigint; expiration: number }[], spender: string) {
  for (const d of details) {
    c.declaredApprovals.push({ kind: 'permit2', token: d.token, spender });
    const t = await token(c, d.token);
    const amt = isUnlimited(d.amount) ? `an unlimited amount of ${t.symbol}` : await amount(c, d.token, d.amount);
    const date = d.expiration ? utcDate(d.expiration) : null;
    const until = d.expiration ? (date ? ` until ${date}` : ' with no expiry') : '';
    const forRouter = sameAddress(spender, c.router);
    c.steps.push(`Record your signed Permit2 allowance: ${forRouter ? 'the router' : spender} may spend ${amt}${until}`);
    if (!forRouter) c.b.warn('caution', 'permit2_spender_not_router', `A Permit2 allowance in this transaction is for ${spender}, not the Universal Router. Only continue if you know why that address needs to spend your ${t.symbol}.`);
    else if (isUnlimited(d.amount)) c.b.warn('info', 'router_permit2_allowance', `This also gives the Universal Router an unlimited Permit2 allowance for ${t.symbol}${until} (how the Uniswap app sets up swaps). Revoke it in Permit2 if you stop using Uniswap.`);
  }
}

async function v4Swap(c: Ctx, input: Hex) {
  const [actions, params] = decodeAbiParameters(P.actions, input);
  const ids = [...hexToBytes(actions)];
  const pending: Leg[] = [];
  for (const [i, id] of ids.entries()) {
    const p = params[i] as Hex;
    if (id === 0x06 || id === 0x08) { // SWAP_EXACT_IN_SINGLE / SWAP_EXACT_OUT_SINGLE
      // Same layout; for exact output the two amounts are (amountOut, amountInMaximum).
      const [s] = c.version === 'v2.1' ? decodeAbiParameters(P.exactInSingle21, p) : decodeAbiParameters(P.exactInSingle, p);
      const exactIn = id === 0x06;
      const [tIn, tOut] = s.zeroForOne ? [s.poolKey.currency0, s.poolKey.currency1] : [s.poolKey.currency1, s.poolKey.currency0];
      const leg: Leg = { protocol: 'v4', exactIn, tokenIn: tIn, tokenOut: tOut, amountIn: exactIn ? s.amountIn : s.amountOutMinimum, amountOut: exactIn ? s.amountOutMinimum : s.amountIn, recipient: ADDRESS_THIS };
      pending.push(leg);
      if (!isAddr(s.poolKey.hooks, NATIVE)) c.b.warn('info', 'v4_hook', `The Uniswap v4 pool uses a hook contract (${s.poolKey.hooks}), which runs its own code during the swap.`);
      await swapStep(c, leg, routeLabel(pct(s.poolKey.fee), hopLimits(c, 'minHopPriceX36' in s && (s.minHopPriceX36 as bigint) > 0n)), undefined);
    } else if (id === 0x07 || id === 0x09) { // SWAP_EXACT_IN / SWAP_EXACT_OUT (multi-hop)
      const [s] = c.version === 'v2.1' ? decodeAbiParameters(P.exactIn21, p) : decodeAbiParameters(P.exactIn, p);
      if (!s.path.length) throw new Error('empty v4 path');
      const exactIn = id === 0x07;
      // Exact in: currencyIn -> path[0] -> ... -> path[n-1]. Exact out: (currencyOut, path, amountOut, amountInMaximum),
      // routed path[0] -> ... -> path[n-1] -> currencyOut.
      const [tIn, tOut] = exactIn ? [s.currencyIn, s.path[s.path.length - 1].intermediateCurrency] : [s.path[0].intermediateCurrency, s.currencyIn];
      const leg: Leg = { protocol: 'v4', exactIn, tokenIn: tIn, tokenOut: tOut, amountIn: exactIn ? s.amountIn : s.amountOutMinimum, amountOut: exactIn ? s.amountOutMinimum : s.amountIn, recipient: ADDRESS_THIS };
      pending.push(leg);
      if (s.path.some(h => !isAddr(h.hooks, NATIVE))) c.b.warn('info', 'v4_hook', 'A Uniswap v4 pool on this route uses a hook contract, which runs its own code during the swap.');
      await swapStep(c, leg, routeLabel(`${s.path.length} hop${s.path.length === 1 ? '' : 's'}`, hopLimits(c, 'minHopPriceX36' in s && (s.minHopPriceX36 as readonly bigint[]).some(x => x > 0n))), undefined);
    } else if (id === 0x0c) { // SETTLE_ALL: pay what the swaps owe, up to a maximum
      const [cur, max] = decodeAbiParameters(P.currencyAmount, p);
      c.paid.add(cur.toLowerCase());
      c.steps.push(isUnlimited(max) ? `Pay what the v4 swap needs in ${(await token(c, cur)).symbol} from your wallet (no maximum set)` : `Pay for the v4 swap from your wallet: at most ${await amount(c, cur, max)}`);
    } else if (id === 0x0f) { // TAKE_ALL: receive the output, at least a minimum, to the sender
      const [cur, min] = decodeAbiParameters(P.currencyAmount, p);
      c.received.add(cur.toLowerCase());
      for (const leg of pending) if (isAddr(leg.tokenOut, cur)) leg.recipient = MSG_SENDER;
      c.steps.push(`Receive the v4 swap output: at least ${await amount(c, cur, min)}, to you`);
    } else if (id === 0x0b) { // SETTLE
      const [cur, amt, payerIsUser] = decodeAbiParameters(P.currencyAmountBool, p);
      if (payerIsUser) c.paid.add(cur.toLowerCase());
      c.steps.push(`Pay ${amt === 0n ? 'the open amount of' : await amount(c, cur, amt)}${amt === 0n ? ` ${(await token(c, cur)).symbol}` : ''} to Uniswap v4 ${payerIsUser ? 'from your wallet' : 'from the router'}`);
    } else if (id === 0x0e || id === 0x10) { // TAKE / TAKE_PORTION
      const [cur, recipient, amt] = decodeAbiParameters(P.currencyRecipientAmount, p);
      if (who(c, recipient) === 'you') c.received.add(cur.toLowerCase());
      for (const leg of pending) if (isAddr(leg.tokenOut, cur)) leg.recipient = recipient;
      const what = id === 0x10 ? `${Number(amt) / 100}% of the ${(await token(c, cur)).symbol} output` : amt === 0n ? `the ${(await token(c, cur)).symbol} output` : await amount(c, cur, amt);
      c.steps.push(`Take ${what} from Uniswap v4 to ${who(c, recipient)}`);
      if (toOther(c, recipient)) c.outputs.push({ recipient, what: `v4 output (${(await token(c, cur)).symbol})` });
    } else {
      c.unknown++;
      c.steps.push(`Uniswap v4 action 0x${id.toString(16).padStart(2, '0')} (not decoded)`);
    }
  }
}

async function command(c: Ctx, byte: number, input: Hex, depth: number) {
  const id = commandId(c, byte);
  const start = c.steps.length;
  switch (id) {
    case 0x00: case 0x01: { // V3_SWAP_EXACT_IN / V3_SWAP_EXACT_OUT
      const [recipient, amt, limit, path, payerIsUser] = decodeAbiParameters(P.swap, input);
      const route = v3Path(path);
      if (!route) throw new Error('bad v3 path');
      const exactIn = id === 0x00;
      // Exact-output paths are encoded backwards (output token first).
      const [tIn, tOut] = exactIn ? [route.tokens[0], route.tokens[route.tokens.length - 1]] : [route.tokens[route.tokens.length - 1], route.tokens[0]];
      await swapStep(c, { protocol: 'v3', exactIn, tokenIn: tIn, tokenOut: tOut, amountIn: exactIn ? amt : limit, amountOut: exactIn ? limit : amt, recipient },
        routeLabel(route.fees.length === 1 ? pct(route.fees[0]) : `${route.fees.length} hops`, v2v3HopLimits(c, input)), payerIsUser);
      break;
    }
    case 0x08: case 0x09: { // V2_SWAP_EXACT_IN / V2_SWAP_EXACT_OUT
      const [recipient, amt, limit, path, payerIsUser] = decodeAbiParameters(P.swapV2, input);
      if (path.length < 2) throw new Error('bad v2 path');
      const exactIn = id === 0x08;
      await swapStep(c, { protocol: 'v2', exactIn, tokenIn: path[0], tokenOut: path[path.length - 1], amountIn: exactIn ? amt : limit, amountOut: exactIn ? limit : amt, recipient },
        routeLabel(path.length > 2 ? `${path.length - 1} hops` : '', v2v3HopLimits(c, input)), payerIsUser);
      break;
    }
    case 0x02: { // PERMIT2_TRANSFER_FROM
      const [tok, recipient, amt] = decodeAbiParameters(P.tokenRecipientAmount, input);
      c.permit2Pulls.set(tok.toLowerCase(), (c.permit2Pulls.get(tok.toLowerCase()) ?? 0n) + amt);
      c.paid.add(tok.toLowerCase());
      c.steps.push(`Move ${await amount(c, tok, amt)} from your wallet through Permit2 to ${who(c, recipient)}`);
      if (toOther(c, recipient)) c.outputs.push({ recipient, what: `${(await token(c, tok)).symbol} from your wallet` });
      break;
    }
    case 0x0d: { // PERMIT2_TRANSFER_FROM_BATCH
      const [details] = decodeAbiParameters(P.transferBatch, input);
      for (const d of details) {
        if (who(c, d.from) === 'you') c.paid.add(d.token.toLowerCase());
        c.steps.push(`Move ${await amount(c, d.token, d.amount)} from ${who(c, d.from) === 'you' ? 'your wallet' : d.from} through Permit2 to ${who(c, d.to)}`);
        if (toOther(c, d.to)) c.outputs.push({ recipient: d.to, what: `${(await token(c, d.token)).symbol} from your wallet` });
      }
      break;
    }
    case 0x0a: { const [permit] = decodeAbiParameters(P.permitSingle, input); await permitStep(c, [permit.details], permit.spender); break; } // PERMIT2_PERMIT
    case 0x03: { const [permit] = decodeAbiParameters(P.permitBatch, input); await permitStep(c, permit.details, permit.spender); break; } // PERMIT2_PERMIT_BATCH
    case 0x04: { // SWEEP
      const [tok, recipient, min] = decodeAbiParameters(P.tokenRecipientAmount, input);
      if (who(c, recipient) === 'you') c.received.add(tok.toLowerCase());
      c.steps.push(`Send the router's remaining ${(await token(c, tok)).symbol}${min ? ` (at least ${await amount(c, tok, min)})` : ''} to ${who(c, recipient)}`);
      if (toOther(c, recipient)) c.outputs.push({ recipient, what: `remaining ${(await token(c, tok)).symbol}` });
      break;
    }
    case 0x05: { // TRANSFER
      const [tok, recipient, value] = decodeAbiParameters(P.tokenRecipientAmount, input);
      c.steps.push(`Pay ${await amount(c, tok, value)} from the router to ${who(c, recipient)}`);
      if (toOther(c, recipient)) c.b.warn('info', 'router_payment', `The router pays ${await amount(c, tok, value)} to ${recipient}, for example an interface fee.`);
      break;
    }
    case 0x06: { // PAY_PORTION, in basis points
      const [tok, recipient, bips] = decodeAbiParameters(P.tokenRecipientAmount, input);
      await payPortion(c, tok, recipient, bips * 10n ** 14n);
      break;
    }
    case 0x0b: { // WRAP_ETH
      const [recipient, amt] = decodeAbiParameters(P.recipientAmount, input);
      c.wraps.push(amt === CONTRACT_BALANCE ? c.tx.value : amt);
      const native = (await token(c, NATIVE)).symbol;
      c.steps.push(`Wrap ${amt === CONTRACT_BALANCE ? `all the ${native} sent` : await amount(c, NATIVE, amt)} into W${native}, for ${who(c, recipient)}`);
      break;
    }
    case 0x0c: { // UNWRAP_WETH
      const [recipient, min] = decodeAbiParameters(P.recipientAmount, input);
      c.unwraps.push({ recipient, amountMin: min });
      if (who(c, recipient) === 'you') c.received.add(NATIVE);
      c.steps.push(`Unwrap the router's W${(await token(c, NATIVE)).symbol} into ${(await token(c, NATIVE)).symbol}${min ? ` (at least ${await amount(c, NATIVE, min)})` : ''}, to ${who(c, recipient)}`);
      if (toOther(c, recipient)) c.outputs.push({ recipient, what: (await token(c, NATIVE)).symbol });
      break;
    }
    case 0x0e: { // BALANCE_CHECK_ERC20 (a placeholder on 1.0, which reverts)
      if (c.version === 'v1.0') return unknownCommand(c, id);
      const [owner, tok, min] = decodeAbiParameters(P.balanceCheck, input);
      c.steps.push(`Check that ${who(c, owner)} hold${who(c, owner) === 'you' ? '' : 's'} at least ${await amount(c, tok, min)}`);
      break;
    }
    case 0x07: { // PAY_PORTION_FULL_PRECISION (2.1+): 1e18 is 100%
      if (c.version !== 'v2.1') return unknownCommand(c, id);
      const [tok, recipient, portion] = decodeAbiParameters(P.tokenRecipientAmount, input);
      await payPortion(c, tok, recipient, portion);
      break;
    }
    case 0x40: { // ACROSS_V4_DEPOSIT_V3 (2.1+)
      if (c.version !== 'v2.1') return unknownCommand(c, id);
      await acrossDeposit(c, input);
      break;
    }
    case 0x21: { // EXECUTE_SUB_PLAN
      if (depth >= 3) throw new Error('sub-plans nested too deeply');
      const [cmds, inputs] = decodeAbiParameters(P.subPlan, input);
      c.steps.push(`Run a sub-plan of ${(cmds.length - 2) / 2} step${cmds.length === 4 ? '' : 's'}:`);
      await commands(c, cmds, inputs, depth + 1);
      break;
    }
    default:
      if (c.version === 'v1.2') await v1Command(c, id, input);
      else if (c.version === 'v1.0') await v10Command(c, id, input);
      else await v2Command(c, id, input);
  }
  if (byte & ALLOW_REVERT) for (let i = start; i < c.steps.length; i++) c.steps[i] += ' (allowed to fail)';
}

function unknownCommand(c: Ctx, id: number) {
  c.unknown++;
  c.steps.push(`Unknown command 0x${id.toString(16).padStart(2, '0')}`);
}

/** PAY_PORTION / PAY_PORTION_FULL_PRECISION: a share (1e18 = 100%) of the router's balance of `tok`. */
async function payPortion(c: Ctx, tok: string, recipient: string, portion: bigint) {
  const sym = (await token(c, tok)).symbol;
  const share = `${formatUnits(portion, 16)}%`;
  c.steps.push(`Pay ${share} of the router's ${sym} to ${who(c, recipient)}`);
  if (!toOther(c, recipient)) return;
  // The Uniswap interface fee is 0.25%. A frontend can set any share, up to 100%.
  const severity = portion >= 10n ** 17n ? 'danger' : portion >= 10n ** 16n ? 'caution' : null;
  if (severity) c.b.warn(severity, 'large_fee_portion', `${share} of your ${sym} goes to ${recipient} as a fee. Interface fees are normally well under 1%.`);
  else c.fees.push(`${share} of the ${sym} to ${recipient}`);
}

/** EVM chain names for bridge destinations (Across chain IDs). */
const CHAIN_NAMES: Record<string, string> = {
  1: 'Ethereum', 10: 'OP Mainnet', 56: 'BNB Chain', 130: 'Unichain', 137: 'Polygon', 232: 'Lens', 324: 'zkSync Era', 480: 'World Chain',
  690: 'Redstone', 999: 'HyperEVM', 1135: 'Lisk', 1868: 'Soneium', 8453: 'Base', 34443: 'Mode', 42161: 'Arbitrum One', 57073: 'Ink',
  59144: 'Linea', 81457: 'Blast', 534352: 'Scroll', 7777777: 'Zora', 34268394551451: 'Solana',
};
export const chainLabel = (id: bigint) => CHAINS[Number(id)]?.name ?? CHAIN_NAMES[id.toString()] ?? `chain ${id}`;

/**
 * ACROSS_V4_DEPOSIT_V3: the router deposits its balance into the Across SpokePool. Unlike other commands, the
 * depositor and recipient are used as given (no MSG_SENDER / ADDRESS_THIS mapping), and the recipient is an
 * address on the destination chain.
 */
async function acrossDeposit(c: Ctx, input: Hex) {
  const [d] = decodeAbiParameters(P.across, input);
  const chain = chainLabel(d.destinationChainId);
  const inToken = d.useNative ? NATIVE : d.inputToken;
  const inSym = (await token(c, inToken)).symbol;
  const sent = d.inputAmount === CONTRACT_BALANCE ? `all of the router's ${inSym}` : await amount(c, inToken, d.inputAmount);
  // The output token lives on the destination chain: only its built-in metadata (if any) is used.
  const out = (CHAINS[Number(d.destinationChainId)] ? builtinTokens(Number(d.destinationChainId)) : []).find(t => isAddr(t.address, d.outputToken));
  const received = out ? `${formatUnits(d.outputAmount, out.decimals)} ${out.symbol}` : `${d.outputAmount} base units of token ${d.outputToken}`;
  const toYou = sameAddress(d.recipient, c.tx.from);
  const fill = utcDate(d.fillDeadline, true);
  c.steps.push(`Bridge ${sent} to ${chain} through Across: ${toYou ? 'you receive' : `${d.recipient} receives`} at least ${received} there${fill ? ` if a relayer fills it by ${fill}` : ''}`);
  c.bridges.push({ chain, text: sent });
  if (!toYou) c.b.warn('caution', 'recipient_not_sender', `The bridged funds go to ${d.recipient} on ${chain}, not to your address.`);
  else c.b.warn('info', 'bridge_same_address', `The bridged funds go to your address on ${chain}. If your account is a smart-contract wallet, check you control the same address there.`);
  if (!sameAddress(d.depositor, c.tx.from)) c.b.warn('caution', 'bridge_refund_other', `If no relayer fills the Across deposit, the refund goes to the depositor ${d.depositor}, not to you.`);
  if (d.message !== '0x') c.b.warn('info', 'bridge_message', `The Across deposit carries a message (${(d.message.length - 2) / 2} bytes) for the recipient, which can run code on ${chain} when the funds arrive.`);
}

/** Commands 0x10-0x14 of routers 2.0 and later (Uniswap v4 and position managers). */
async function v2Command(c: Ctx, id: number, input: Hex) {
  if (id === 0x10) return v4Swap(c, input); // V4_SWAP
  if (id === 0x11 || id === 0x12) { // V3_POSITION_MANAGER_PERMIT / _CALL: raw calldata to the v3 position manager
    const fn = positionCall(input);
    c.steps.push(`Uniswap v3 position manager: ${fn}`);
    return;
  }
  if (id === 0x13) { // V4_INITIALIZE_POOL
    const [key] = decodeAbiParameters(P.poolKeyPrice, input);
    c.steps.push(`Create a Uniswap v4 pool for ${(await token(c, key.currency0)).symbol}/${(await token(c, key.currency1)).symbol} (${pct(key.fee)})`);
    return;
  }
  if (id === 0x14) { c.steps.push('Uniswap v4 position manager: add liquidity (modifyLiquidities)'); return; } // V4_POSITION_MANAGER_CALL
  unknownCommand(c, id);
}

const V1_MARKETS: Record<number, string> = { 0x10: 'Seaport 1.5', 0x11: 'LooksRare v2', 0x12: 'NFTX', 0x19: 'Sudoswap', 0x1a: 'NFT20', 0x1e: 'Element', 0x20: 'Seaport 1.4', 0x18: 'X2Y2', 0x1b: 'X2Y2', 0x1c: 'Foundation' };

/** v1.2 commands 0x10-0x22: NFT marketplaces, ownership checks and NFT sweeps. */
async function v1Command(c: Ctx, id: number, input: Hex) {
  const eth = (await token(c, NATIVE)).symbol;
  if (id === 0x13) { // CRYPTOPUNKS
    const [punkId, recipient, value] = decodeAbiParameters(parseAbiParameters('uint256 punkId, address recipient, uint256 value'), input);
    c.steps.push(`Buy CryptoPunk #${punkId} for ${formatUnits(value, 18)} ${eth}, to ${who(c, recipient)}`);
    if (toOther(c, recipient)) c.outputs.push({ recipient, what: `CryptoPunk #${punkId}` });
    return;
  }
  if (V1_MARKETS[id]) { // (uint256 value, bytes data, ...): the order itself is the marketplace's own format
    const [value] = decodeAbiParameters(P.valueData, input);
    c.steps.push(`Buy NFTs on ${V1_MARKETS[id]}, paying ${formatUnits(value, 18)} ${eth} (the order details are not decoded)`);
    return;
  }
  if (id === 0x15 || id === 0x16) { // OWNER_CHECK_721 / _1155
    const [owner, tok, tokenId] = decodeAbiParameters(parseAbiParameters('address owner, address token, uint256 id'), input.slice(0, 2 + 64 * 3) as Hex);
    c.steps.push(`Check that ${who(c, owner)} own${who(c, owner) === 'you' ? '' : 's'} NFT #${tokenId} of ${shortAddress(tok)}`);
    return;
  }
  if (id === 0x17 || id === 0x1d) { // SWEEP_ERC721 / SWEEP_ERC1155
    const [tok, recipient, tokenId] = decodeAbiParameters(parseAbiParameters('address token, address recipient, uint256 id'), input.slice(0, 2 + 64 * 3) as Hex);
    c.steps.push(`Send NFT #${tokenId} of ${shortAddress(tok)} from the router to ${who(c, recipient)}`);
    if (toOther(c, recipient)) c.outputs.push({ recipient, what: `NFT #${tokenId}` });
    return;
  }
  if (id === 0x22) { // APPROVE_ERC20: the router approves a fixed marketplace (0 = OpenSea conduit, 1 = Sudoswap)
    const [tok, spender] = decodeAbiParameters(parseAbiParameters('address token, uint256 spender'), input);
    c.steps.push(`Let ${spender === 0n ? 'the OpenSea conduit' : spender === 1n ? 'Sudoswap' : `spender ${spender}`} spend the router's ${(await token(c, tok)).symbol}`);
    return;
  }
  unknownCommand(c, id);
}

/** 1.0's marketplaces (Seaport was 1.1 then; LooksRare v1). */
const V10_MARKETS: Record<number, string> = { 0x10: 'Seaport', 0x11: 'LooksRare', 0x12: 'NFTX', 0x14: 'LooksRare', 0x18: 'X2Y2', 0x19: 'Sudoswap', 0x1a: 'NFT20', 0x1b: 'X2Y2', 0x1c: 'Foundation' };

/**
 * Universal Router 1.0 commands 0x10-0x1f (contracts/base/Dispatcher.sol of the verified 1.0 router). LooksRare,
 * X2Y2 and Foundation purchases name the NFT and who gets it: (value, data, recipient, token, id[, amount]).
 */
async function v10Command(c: Ctx, id: number, input: Hex) {
  const eth = (await token(c, NATIVE)).symbol;
  const nft = async (tok: string, tokenId: bigint) => `#${tokenId} of ${(await collectionLabel(c.env.deps, c.tx.chainId, tok)).label}`;
  if (id === 0x13) return v1Command(c, id, input); // CRYPTOPUNKS: the same input as 1.2
  if (id === 0x11 || id === 0x18 || id === 0x1c) { // LOOKS_RARE_721, X2Y2_721, FOUNDATION
    const [value, , recipient, tok, tokenId] = decodeAbiParameters(parseAbiParameters('uint256 value, bytes data, address recipient, address token, uint256 id'), input);
    c.steps.push(`Buy NFT ${await nft(tok, tokenId)} on ${V10_MARKETS[id]}, paying ${formatUnits(value, 18)} ${eth}, for ${who(c, recipient)}`);
    if (toOther(c, recipient)) c.outputs.push({ recipient, what: `NFT #${tokenId}` });
    return;
  }
  if (id === 0x14 || id === 0x1b) { // LOOKS_RARE_1155, X2Y2_1155
    const [value, , recipient, tok, tokenId, n] = decodeAbiParameters(parseAbiParameters('uint256 value, bytes data, address recipient, address token, uint256 id, uint256 amount'), input);
    c.steps.push(`Buy ${n} × NFT ${await nft(tok, tokenId)} on ${V10_MARKETS[id]}, paying ${formatUnits(value, 18)} ${eth}, for ${who(c, recipient)}`);
    if (toOther(c, recipient)) c.outputs.push({ recipient, what: `NFT #${tokenId}` });
    return;
  }
  if (id === 0x10 || id === 0x12 || id === 0x19 || id === 0x1a) { // SEAPORT, NFTX, SUDOSWAP, NFT20: (value, data)
    const [value] = decodeAbiParameters(P.valueData, input);
    c.steps.push(`Buy NFTs on ${V10_MARKETS[id]}, paying ${formatUnits(value, 18)} ${eth} (the order details are not decoded)`);
    return;
  }
  if (id === 0x15) { // OWNER_CHECK_721
    const [owner, tok, tokenId] = decodeAbiParameters(parseAbiParameters('address owner, address token, uint256 id'), input);
    c.steps.push(`Check that ${who(c, owner)} own${who(c, owner) === 'you' ? '' : 's'} NFT ${await nft(tok, tokenId)}`);
    return;
  }
  if (id === 0x16) { // OWNER_CHECK_1155
    const [owner, tok, tokenId, min] = decodeAbiParameters(parseAbiParameters('address owner, address token, uint256 id, uint256 minBalance'), input);
    c.steps.push(`Check that ${who(c, owner)} hold${who(c, owner) === 'you' ? '' : 's'} at least ${min} of NFT ${await nft(tok, tokenId)}`);
    return;
  }
  if (id === 0x17 || id === 0x1d) { // SWEEP_ERC721, SWEEP_ERC1155
    const [tok, recipient, tokenId] = decodeAbiParameters(parseAbiParameters('address token, address recipient, uint256 id'), input.slice(0, 2 + 64 * 3) as Hex);
    c.steps.push(`Send NFT ${await nft(tok, tokenId)} from the router to ${who(c, recipient)}`);
    if (toOther(c, recipient)) c.outputs.push({ recipient, what: `NFT #${tokenId}` });
    return;
  }
  unknownCommand(c, id); // 0x1e, 0x1f: placeholders, which revert
}

const POSITION_MANAGER = parseAbi([
  'function permit(address spender, uint256 tokenId, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
  'function decreaseLiquidity((uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params)',
  'function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params)',
  'function burn(uint256 tokenId)',
]);
function positionCall(data: Hex): string {
  try {
    const r = decodeFunctionData({ abi: POSITION_MANAGER, data });
    const id = r.functionName === 'burn' ? r.args[0] : r.functionName === 'permit' ? r.args[1] : (r.args[0] as { tokenId: bigint }).tokenId;
    const label = { permit: 'let the router manage', decreaseLiquidity: 'remove liquidity from', collect: 'collect fees and tokens from', burn: 'burn' }[r.functionName];
    return `${label} position #${id}`;
  } catch {
    return `call ${selectorOf(data) ?? 'unknown'}`;
  }
}

async function commands(c: Ctx, cmds: Hex, inputs: readonly Hex[], depth: number) {
  const bytes = [...hexToBytes(cmds)];
  if (bytes.length !== inputs.length) throw new Error('commands and inputs differ in length');
  for (const [i, byte] of bytes.entries()) {
    try { await command(c, byte, inputs[i], depth); } catch {
      c.unknown++;
      c.steps.push(`Command 0x${commandId(c, byte).toString(16).padStart(2, '0')} (its input could not be decoded)`);
    }
  }
}

/** The chain's wrapped native token (WETH, or WHYPE on HyperEVM), which WRAP_ETH / UNWRAP_WETH use. */
export const wrappedNative = (chainId: number) => builtinTokens(chainId).find(t => t.symbol === `W${CHAINS[chainId]?.nativeSymbol ?? 'ETH'}`)?.address;

/** Collapses the legs into one headline trade when they form a split route or a chain of hops. */
async function headline(c: Ctx): Promise<{ title: string; summary: string; changes: AssetChange[]; minOut?: bigint } | null> {
  if (!c.legs.length) return null;
  const first = c.legs[0], last = c.legs[c.legs.length - 1];
  const weth = wrappedNative(c.tx.chainId);
  // WETH and ETH are one asset for routing when the router wraps or unwraps between legs.
  const same = (a: string, b: string) => isAddr(a, b) || (!!weth && (c.wraps.length > 0 || c.unwraps.length > 0) && [a, b].every(x => isAddr(x, weth) || isAddr(x, NATIVE)));
  const split = c.legs.every(l => isAddr(l.tokenIn, first.tokenIn) && isAddr(l.tokenOut, first.tokenOut) && l.exactIn === first.exactIn);
  const chain = c.legs.every((l, i) => i === 0 || same(c.legs[i - 1].tokenOut, l.tokenIn));
  if (!split && !chain) return null;
  // The headline must agree with what your wallet actually pays and receives (a round trip, or a route that also
  // pulls extra tokens from you, has no single "X for Y").
  const canon = (a: string) => (weth && isAddr(a, weth)) || isAddr(a, NATIVE) ? 'eth' : a.toLowerCase();
  const paid = new Set([...c.paid].map(canon)), received = new Set([...c.received].map(canon));
  if (canon(first.tokenIn) === canon(last.tokenOut)) return null;
  if (paid.size && ![...paid].every(t => t === canon(first.tokenIn))) return null;
  // Receiving the input token back is a refund of what an exact-output trade didn't need.
  if (received.size && ![...received].every(t => t === canon(last.tokenOut) || t === canon(first.tokenIn))) return null;
  // A chained route can fix its input (exact in) and its output (exact out) independently.
  const exactIn = first.exactIn, exactOut = !last.exactIn;
  let tokenIn = first.tokenIn, tokenOut = last.tokenOut;
  let amountIn = split ? c.legs.reduce((s, l) => s + (l.amountIn === CONTRACT_BALANCE ? 0n : l.amountIn), 0n) : first.amountIn;
  let amountOut = split ? c.legs.reduce((s, l) => s + l.amountOut, 0n) : last.amountOut;
  // ETH in: WRAP_ETH funds the router. ETH out: UNWRAP_WETH pays the user.
  if (weth && isAddr(tokenIn, weth) && c.wraps.length) { tokenIn = NATIVE; if (first.amountIn === CONTRACT_BALANCE || amountIn === 0n) amountIn = c.wraps.reduce((s, w) => s + w, 0n); }
  if (weth && isAddr(tokenOut, weth) && c.unwraps.length) {
    tokenOut = NATIVE;
    const min = c.unwraps[c.unwraps.length - 1].amountMin;
    if (exactIn && min > amountOut) amountOut = min; // the unwrap minimum is the binding one
  }
  if (amountIn === CONTRACT_BALANCE || amountIn === 0n) amountIn = c.permit2Pulls.get(tokenIn.toLowerCase()) ?? amountIn;
  const openIn = amountIn === CONTRACT_BALANCE || amountIn === 0n || (!exactIn && isUnlimited(amountIn));
  const inText = openIn ? (await token(c, tokenIn)).symbol : await amount(c, tokenIn, amountIn, true);
  const outText = await amount(c, tokenOut, amountOut, true);
  const title = `Swap ${exactIn || openIn ? '' : 'up to '}${inText} for ${exactOut ? '' : 'at least '}${outText}`;
  const protocols = [...new Set(c.legs.map(l => l.protocol))].join(' + ');
  const summary = `${title.replace(/^Swap/, 'Swaps')} on Uniswap (${protocols}${split && c.legs.length > 1 ? `, split across ${c.legs.length} routes` : ''}) through the Universal Router.`;
  const changes: AssetChange[] = [];
  const known = async (addr: string, raw: bigint, direction: 'in' | 'out') => {
    const t = await token(c, addr);
    if (t.decimals !== undefined && raw !== CONTRACT_BALANCE && raw !== 0n) changes.push({ direction, account: c.tx.from, amount: formatUnits(raw, t.decimals), symbol: t.symbol, raw: raw.toString(), asset: isAddr(addr, NATIVE) ? 'native' : addr.toLowerCase(), basis: 'requested' });
  };
  // Only the side the transaction fixes: what you pay for an exact-input trade, what you get for exact-output.
  if (exactIn) await known(tokenIn, amountIn, 'out');
  if (exactOut) await known(tokenOut, amountOut, 'in');
  return { title, summary, changes, minOut: exactOut ? undefined : amountOut };
}

/**
 * executeSigned: recovers who signed the route (EIP-712 "UniversalRouter" version 2, RouteSigner). The signature
 * gives the route's hooks a signer, intent and data to check; the tokens still come from the transaction's sender.
 */
async function routeSignature(c: Ctx, args: readonly unknown[]): Promise<string> {
  const [commands, inputs, intent, data, verifySender, nonce, signature, deadline] = args as [Hex, Hex[], Hex, Hex, boolean, Hex, Hex, bigint];
  const bound = verifySender ? 'only you can submit it' : 'anyone can submit it';
  try {
    const signer = await recoverTypedDataAddress({
      domain: { name: 'UniversalRouter', version: '2', chainId: c.tx.chainId, verifyingContract: c.router as Hex },
      types: { ExecuteSigned: [
        { name: 'commands', type: 'bytes' }, { name: 'inputs', type: 'bytes[]' }, { name: 'intent', type: 'bytes32' }, { name: 'data', type: 'bytes32' },
        { name: 'sender', type: 'address' }, { name: 'nonce', type: 'bytes32' }, { name: 'deadline', type: 'uint256' },
      ] },
      primaryType: 'ExecuteSigned',
      message: { commands, inputs, intent, data, sender: verifySender ? c.tx.from as Hex : NATIVE, nonce, deadline },
      signature,
    });
    return `signed by ${sameAddress(signer, c.tx.from) ? 'you' : signer}; ${bound}`;
  } catch {
    return `the signature could not be read; ${bound}`;
  }
}

export const universalRouterAdapter: Adapter = async (tx, env) => {
  const deployment = tx.to ? UNIVERSAL_ROUTERS[tx.to] : undefined;
  if (!deployment || deployment.chainId !== tx.chainId) return null;
  let decodedCall;
  try { decodedCall = decodeFunctionData({ abi: EXECUTE, data: tx.data }); } catch { return null; }
  const signed = decodedCall.functionName === 'executeSigned';
  if (signed && deployment.version !== 'v2.1') return null;
  const args = decodedCall.args as readonly unknown[];
  const [cmds, inputs] = args as readonly [Hex, readonly Hex[]];
  const deadline = (signed ? args[7] : args[2]) as bigint | undefined;
  const b = new PreviewBuilder();
  const c: Ctx = { env, tx, router: tx.to!, version: deployment.version, b, steps: [], legs: [], wraps: [], unwraps: [], outputs: [], unknown: 0, declaredApprovals: [], permit2Pulls: new Map(), paid: new Set(), received: new Set(), fees: [], priceLimited: false, bridges: [] };
  if (tx.value > 0n) c.paid.add(NATIVE);
  try { await commands(c, cmds, inputs, 0); } catch (e) {
    b.warn('caution', 'router_undecodable', `The router commands could not be decoded (${(e as Error).message}).`);
  }

  const head = await headline(c);
  b.detail('Contract', `Uniswap Universal Router v${deployment.release} (${tx.to})`, tx.to!);
  if (signed) b.detail('Route signature', await routeSignature(c, args), (args[5] as Hex));
  for (const [i, s] of c.steps.entries()) b.detail(`Step ${i + 1}`, s);
  for (const f of c.fees) b.detail('Interface fee', f);
  if (deadline !== undefined) {
    const nowMs = env.context.now ?? Date.now();
    b.detail('Deadline', utcDate(deadline, true) ?? 'none (no deadline set)', deadline.toString());
    if (Number(deadline) * 1000 < nowMs) b.warn('caution', 'deadline_passed', 'The deadline has already passed, so this transaction will fail. You would still pay the network fee.');
  }
  // Where the output goes. Fees (PAY_PORTION/TRANSFER) are reported separately.
  const others = [...new Map(c.outputs.filter(o => toOther(c, o.recipient)).map(o => [o.recipient.toLowerCase(), o])).values()];
  if (others.length) b.warn('caution', 'output_to_other', `Part of the result goes to another address, not to you: ${others.map(o => `${o.what} to ${o.recipient}`).join('; ')}.`);
  if (head?.minOut === 0n && !c.priceLimited && !c.unwraps.some(u => u.amountMin > 0n)) b.warn('caution', 'no_slippage_protection', 'The minimum amount you receive is 0, so there is no slippage protection: the trade can be front-run and you could receive almost nothing.');
  if (c.unknown) b.warn('caution', 'router_command_unknown', `${c.unknown} router step${c.unknown === 1 ? '' : 's'} could not be fully decoded.`);
  b.note('Router steps were decoded from the Universal Router commands; the swap amounts are limits set by the transaction, not quotes.');
  const status = c.unknown ? 'partial' : 'full';
  const names = async (set: Set<string>) => [...new Set(await Promise.all([...set].map(async a => (await token(c, a)).symbol)))].join(' + ');
  const flow = c.paid.size && c.received.size ? `Uniswap: pay ${await names(c.paid)}, receive ${await names(c.received)} (${c.steps.length} steps)` : null;
  // A route that ends in an Across deposit delivers its output on another chain: the title says so.
  const bridge = c.bridges.length ? [...new Set(c.bridges.map(x => x.chain))].join(' and ') : null;
  const bridgeTitle = bridge && (head ? `${head.title}, then bridge to ${bridge}` : c.bridges.length === 1 ? `Bridge ${c.bridges[0].text} to ${bridge} through Across` : null);
  const title = bridgeTitle ?? head?.title ?? flow ?? (c.steps.length === 1 ? c.steps[0] : `Uniswap: ${c.steps.length} router steps`);
  const summary = bridge && head ? `${head.summary.replace(/\.$/, '')}, then bridges the output to ${bridge} through Across.`
    : head?.summary ?? `Runs ${c.steps.length} Universal Router step${c.steps.length === 1 ? '' : 's'}: ${c.steps.join('; ')}.`;
  return { ...decoded({ title, summary, decoder: 'uniswap_universal_router', status, b, assetChanges: head?.changes ?? [] }), declaredApprovals: c.declaredApprovals };
};
