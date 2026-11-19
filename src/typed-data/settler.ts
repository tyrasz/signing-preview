// 0x's gasless swaps (Settler, verified on Sourcify): the user signs a Permit2 PermitWitnessTransferFrom whose
// spender is 0x's Settler for meta-transactions or for intents, with a witness that binds what the swap must give:
//   SlippageAndActions(address recipient,address buyToken,uint256 minAmountOut,bytes[] actions)   (meta-transactions)
//   Slippage(address recipient,address buyToken,uint256 minAmountOut)                              (intents: a solver picks the route)
// under the field names slippageAndActions and slippage. A relayer submits it (executeMetaTxn); Settler takes the tokens
// and checks at the end that at least minAmountOut of buyToken went to recipient (_checkSlippageAndTransfer). So the
// recipient, the token bought and the minimum are what the signature commits to. Settler's addresses rotate: the
// deployer (0x0000…ceae, the same on every chain) names the current one for each feature (ownerOf: 3 meta-transactions,
// 4 intents) and the one before it (prev). Checked: the signatures of 10 real executeMetaTxn transactions (Ethereum
// intents, Base meta-transactions) recover to their senders over the digest computed here.
import { formatUnits, PreviewBuilder, sameAddress, shortAddress } from '../format.ts';
import { CHAINS } from '../chains.ts';
import type { TokenInfo } from '../types.ts';
import { big, str, type TypedEnv } from './common.ts';

const DEPLOYER = '0x00000000000004533fe15556b1e086bb1a72ceae';
const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const FIELDS = { slippageAndActions: 'address recipient,address buyToken,uint256 minAmountOut,bytes[] actions', slippage: 'address recipient,address buyToken,uint256 minAmountOut' } as const;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** The witness, if it is 0x Settler's: which field, and its parts. */
export function settlerWitness(types: Record<string, { name: string; type: string }[]>, primaryType: string, message: Record<string, unknown>) {
  if (primaryType !== 'PermitWitnessTransferFrom') return null;
  const field = types.PermitWitnessTransferFrom?.find(f => f.name === 'slippageAndActions' || f.name === 'slippage');
  if (!field) return null;
  const kind = field.name as keyof typeof FIELDS;
  if (types[field.type]?.map(f => `${f.type} ${f.name}`).join(',') !== FIELDS[kind]) return null;
  const w = message[kind] as Record<string, unknown> | undefined;
  if (!w || typeof w !== 'object') return null;
  const recipient = str(w.recipient).toLowerCase(), buyToken = str(w.buyToken).toLowerCase(), minAmountOut = big(w.minAmountOut);
  if (!ADDRESS.test(recipient) || !ADDRESS.test(buyToken) || minAmountOut === null) return null;
  return { kind, recipient, buyToken, minAmountOut, actions: Array.isArray(w.actions) ? w.actions.length : 0 };
}

/** Whether `spender` is 0x's current or previous Settler for this feature, from the deployer; undefined without an RPC. */
async function isSettler(env: TypedEnv, chainId: number, spender: string, feature: 3 | 4): Promise<boolean | undefined> {
  if (!env.deps.rpc?.has(chainId)) return undefined;
  try {
    const word = (sel: string) => env.deps.rpc!.call(chainId, 'eth_call', [{ to: DEPLOYER, data: `${sel}${feature.toString(16).padStart(64, '0')}` }, 'latest']);
    const [current, previous] = await Promise.all([word('0x6352211e'), word('0xe2603dc2').catch(() => '0x')]);
    return [current, previous].some(r => typeof r === 'string' && r.length === 66 && sameAddress(`0x${r.slice(26)}`, spender));
  } catch { return undefined; }
}

/** The swap a Settler witness signs, read into `b`: its title and summary. */
export async function settlerSwap(w: NonNullable<ReturnType<typeof settlerWitness>>, env: TypedEnv, chainId: number | null, spender: string, input: string, b: PreviewBuilder): Promise<{ title: string; summary: string }> {
  const native = w.buyToken === NATIVE;
  let info: TokenInfo | undefined;
  try { info = !native && chainId !== null ? (await env.deps.tokens?.get(chainId, w.buyToken)) ?? undefined : undefined; } catch { info = undefined; }
  const symbol = native ? CHAINS[chainId ?? 0]?.nativeSymbol ?? 'ETH' : info?.symbol ?? shortAddress(w.buyToken);
  const least = native ? `${formatUnits(w.minAmountOut, CHAINS[chainId ?? 0]?.nativeDecimals ?? 18)} ${symbol}` : info ? `${formatUnits(w.minAmountOut, info.decimals)} ${symbol}` : `${w.minAmountOut} base units of ${symbol}`;
  const yours = env.signer !== null && sameAddress(w.recipient, env.signer);
  b.detail('Settler', `0x's Settler for ${w.kind === 'slippage' ? 'intents (a solver picks the route)' : `meta-transactions (${w.actions} action${w.actions === 1 ? '' : 's'})`} (${spender})`, spender)
    .detail('You get at least', least, w.minAmountOut.toString()).detail('Buying', native ? `${symbol} (native coin)` : info ? `${info.symbol} (${w.buyToken})` : w.buyToken, w.buyToken)
    .detail('Sent to', yours ? `you (${w.recipient})` : w.recipient, w.recipient);
  const settler = chainId !== null ? await isSettler(env, chainId, spender, w.kind === 'slippage' ? 4 : 3) : undefined;
  if (settler === false) b.warn('danger', 'settler_unknown', `It is signed for ${shortAddress(spender)}, which isn't 0x's Settler (its deployer, ${shortAddress(DEPLOYER)}, names others): whatever that contract does with your tokens isn't bound by the minimum shown.`);
  else if (settler === undefined) b.warn('caution', 'settler_unchecked', `Whether ${shortAddress(spender)} is 0x's Settler wasn't checked (no RPC): only Settler holds the swap to the minimum and recipient shown.`);
  if (!yours) b.warn('caution', 'settler_recipient_other', `What the swap buys goes to ${shortAddress(w.recipient)}, not to you.`);
  if (w.minAmountOut === 0n) b.warn('caution', 'settler_no_minimum', `It sets no minimum for what the swap gives: it can be filled at any price, down to nothing.`);
  b.note(`A gasless 0x swap: a relayer submits it, Settler takes ${input} and must send at least ${least} to ${yours ? 'you' : shortAddress(w.recipient)}, or the whole swap fails.`);
  return {
    title: `0x: swap ${input} for at least ${least}${yours ? '' : `, to ${shortAddress(w.recipient)}`}`,
    summary: `A gasless 0x swap (Permit2): ${input} for at least ${least}, sent to ${yours ? 'you' : shortAddress(w.recipient)}.`,
  };
}
