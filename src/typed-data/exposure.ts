// What an off-chain signature can move if it is used right now: the amount it permits, capped by what the signer
// holds and, where a contract pulls the tokens on the signature's authority (Permit2, CoW's vault relayer, 1inch's
// router), by the ERC-20 allowance that contract already has. Read with eth_call; the signature's own terms are the
// decoder's. A permission over tokens you don't hold yet still covers any you receive while it lasts.
import { formatUnits, isUnlimited, type PreviewBuilder, shortAddress } from '../format.ts';
import type { TokenInfo } from '../types.ts';
import type { TypedEnv } from './common.ts';

const word = (a: string) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');

async function read(env: TypedEnv, chainId: number, to: string, data: string): Promise<bigint | undefined> {
  const rpc = env.deps.rpc;
  if (!rpc?.has(chainId)) return undefined;
  try { const r = String(await rpc.call(chainId, 'eth_call', [{ to, data }, 'latest'])); return /^0x[0-9a-f]{1,64}$/i.test(r) ? BigInt(r) : r.length >= 66 ? BigInt(r.slice(0, 66)) : undefined; } catch { return undefined; }
}
export const balanceOf = (env: TypedEnv, chainId: number, token: string, owner: string) => read(env, chainId, token, `0x70a08231${word(owner)}`);
export const allowanceOf = (env: TypedEnv, chainId: number, token: string, owner: string, spender: string) => read(env, chainId, token, `0xdd62ed3e${word(owner)}${word(spender)}`);

export interface Exposure { amount: bigint; balance: bigint; limitedBy: 'permit' | 'balance' | 'allowance' }

/**
 * Adds "Can move now" to the preview for one token: `permitted` (null when unknown), `via` the contract whose ERC-20
 * allowance the signature relies on, if any. Returns what was measured, or undefined without an RPC.
 */
export async function canMoveNow(env: TypedEnv, b: PreviewBuilder, chainId: number | null, owner: string | null, token: string, info: TokenInfo | undefined, permitted: bigint | null, via?: { address: string; name: string }, label = 'Can move now'): Promise<Exposure | undefined> {
  if (chainId === null || !owner || !/^0x[0-9a-fA-F]{40}$/.test(token)) return undefined;
  const [balance, allowance] = await Promise.all([balanceOf(env, chainId, token, owner), via ? allowanceOf(env, chainId, token, owner, via.address) : Promise.resolve(undefined)]);
  if (balance === undefined || (via && allowance === undefined)) return undefined;
  const sym = info?.symbol ?? shortAddress(token);
  const fmt = (v: bigint) => info ? `${formatUnits(v, info.decimals)} ${sym}` : `${v} base units of ${sym}`;
  const later = permitted === null || isUnlimited(permitted) ? ', and any you receive while the permission lasts' : '';
  if (via && allowance === 0n) {
    b.detail(label, `nothing yet: ${via.name} has no allowance for your ${sym}, so the signature can't move it until you approve ${via.name}`);
    return { amount: 0n, balance, limitedBy: 'allowance' };
  }
  if (balance === 0n) {
    b.detail(label, `nothing now: you hold no ${sym}${later ? ` (it covers any you receive while it lasts)` : ''}`);
    return { amount: 0n, balance, limitedBy: 'balance' };
  }
  let amount = balance, limitedBy: Exposure['limitedBy'] = 'balance';
  if (permitted !== null && !isUnlimited(permitted) && permitted < amount) { amount = permitted; limitedBy = 'permit'; }
  if (via && allowance !== undefined && !isUnlimited(allowance) && allowance < amount) { amount = allowance; limitedBy = 'allowance'; }
  const why = limitedBy === 'balance' ? `your whole balance${later}` : limitedBy === 'permit' ? `the permitted amount; you hold ${fmt(balance)}` : `what ${via!.name} is approved for; you hold ${fmt(balance)}`;
  b.detail(label, `${fmt(amount)} (${why})`, amount.toString());
  return { amount, balance, limitedBy };
}
