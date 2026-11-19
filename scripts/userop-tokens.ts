// The token side of scripts/accuracy-4337.ts: what an operation's part of its receipt moved, account by account,
// set against what its preview shows moving.
import { NATIVE_LOG_ADDRESS } from '../src/simulation.ts';

export const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
/** WETH-style wrappers' Deposit(dst, wad) and Withdrawal(src, wad): their balance changes without a Transfer. */
export const DEPOSIT = '0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c', WITHDRAWAL = '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65';

export type Log = { address: string; topics: readonly string[]; data: string };
/** An asset change as a preview reports it (src/types.ts AssetChange), the fields compared here. */
export type Shown = { account?: string; asset?: string; raw?: string; direction: string; basis?: string };
/** A compared token: the account's (`account` only for another than the operation's), what moved, what the preview has. */
export type Compared = { token: string; actual: string; simulated: string; account?: string };

const topicAddress = (topic: string) => `0x${topic.slice(26)}`.toLowerCase();

/**
 * An account's token movements in an operation's part of its receipt: its Transfers, and the Deposit and Withdrawal
 * of a WETH-style wrapper (only a token's, which `isToken` says: a staking contract's or vault's
 * Deposit(address,uint256) has WETH9's signature too, and moves no token of the account's). Not the chain's own log
 * of a native transfer, from Glamsterdam on: tokens are what is compared.
 */
export async function movedBy(own: readonly Log[], account: string, isToken: (address: string) => Promise<boolean>): Promise<Map<string, bigint>> {
  const moved = new Map<string, bigint>();
  for (const l of own) {
    const token = l.address.toLowerCase();
    if (l.topics[0] === TRANSFER && l.topics.length === 3 && token !== NATIVE_LOG_ADDRESS) {
      const v = BigInt(l.data);
      if (topicAddress(l.topics[1]) === account) moved.set(token, (moved.get(token) ?? 0n) - v);
      if (topicAddress(l.topics[2]) === account) moved.set(token, (moved.get(token) ?? 0n) + v);
    } else if ((l.topics[0] === DEPOSIT || l.topics[0] === WITHDRAWAL) && l.topics.length === 2 && topicAddress(l.topics[1]) === account && await isToken(token)) {
      const v = BigInt(l.data.slice(0, 66));
      moved.set(token, (moved.get(token) ?? 0n) + (l.topics[0] === DEPOSIT ? v : -v));
    }
  }
  for (const [k, v] of moved) if (v === 0n) moved.delete(k);
  return moved;
}

/**
 * What the preview shows moving, account by account, against what the receipt moved for each: the operation's
 * account's (`sender`), and any other account's the preview shows (a Safe the account sends a transaction to: the
 * Safe's changes, as a Safe execution's preview has them). Only simulated movements: a preview whose calls revert
 * shows what they ask for (basis 'requested'), with a warning.
 */
export async function compareTokens(own: readonly Log[], sender: string, changes: readonly Shown[], isToken: (address: string) => Promise<boolean>): Promise<Compared[]> {
  const shown = changes.filter(c => c.asset && c.asset !== 'native' && c.raw && c.basis !== 'requested');
  const accountOf = (c: Shown) => (c.account ?? sender).toLowerCase();
  const accounts = [sender, ...new Set(shown.map(accountOf).filter(a => a !== sender))];
  const tokens: Compared[] = [];
  for (const account of accounts) {
    const moved = await movedBy(own, account, isToken), simulated = new Map<string, bigint>();
    for (const c of shown.filter(x => accountOf(x) === account)) {
      const token = c.asset!.toLowerCase();
      simulated.set(token, (simulated.get(token) ?? 0n) + (c.direction === 'out' ? -1n : 1n) * BigInt(c.raw!));
    }
    for (const t of new Set([...moved.keys(), ...simulated.keys()])) tokens.push({ token: t, actual: (moved.get(t) ?? 0n).toString(), simulated: (simulated.get(t) ?? 0n).toString(), ...(account !== sender && { account }) });
  }
  return tokens;
}

/**
 * A token's logs moving an account's balance, in order, as movedBy counts them: its Transfers to and from the account
 * (`from>to:value`), and a WETH-style wrapper's Deposit and Withdrawal of the account's (`deposit>account:value`,
 * `account>withdrawal:value`). Whether two runs moved it alike.
 */
export const transfersOf = (logs: readonly Log[], token: string, account: string): string => logs
  .filter(l => l.address.toLowerCase() === token)
  .flatMap(l => l.topics[0] === TRANSFER && l.topics.length === 3 && (topicAddress(l.topics[1]) === account || topicAddress(l.topics[2]) === account) ? [`${topicAddress(l.topics[1])}>${topicAddress(l.topics[2])}:${BigInt(l.data)}`]
    : (l.topics[0] === DEPOSIT || l.topics[0] === WITHDRAWAL) && l.topics.length === 2 && topicAddress(l.topics[1]) === account ? [l.topics[0] === DEPOSIT ? `deposit>${account}:${BigInt(l.data.slice(0, 66))}` : `${account}>withdrawal:${BigInt(l.data.slice(0, 66))}`]
    : []).join(',');

/**
 * Whether a run of the operation (the replay, as mined) moved a token for an account as its receipt did: the same
 * logs for both (transfersOf), and some. A receipt logging nothing for them gives nothing to tell the runs apart by:
 * any run would pass.
 */
export const movedAlike = (run: readonly Log[], receipt: readonly Log[], token: string, account: string): boolean => {
  const mined = transfersOf(receipt, token, account);
  return mined !== '' && transfersOf(run, token, account) === mined;
};

const APPROVAL = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';
const APPROVAL_FOR_ALL = '0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31';
/**
 * Which of a block's earlier transactions a replay runs before a bundle, where it runs no more than `max` of them
 * (scripts/accuracy-4337.ts): the last `max`, and before them every one whose receipt logs an event the bundle's own
 * receipt logs, from the same contract: a pool's Sync and Swap, a singleton's Swap (Uniswap v4's PoolManager, for
 * any pool: wider than needed, never narrower), another bundle's EntryPoint events. Not a token's Transfer or
 * Approval, nor a wrapper's Deposit or Withdrawal, which any transaction moving the token logs. Indexes into
 * `earlier`, in order. On Ethereum (2026-11-19) an operation 689th in its block swapped through a pool the block's
 * 91st transaction had traded in: with only the last 400 run before it, it met the pool without that trade and came
 * out 0.4% short in USDC and 6% over in gas, and was judged as if it had met the block.
 */
export function keptEarlier(earlier: readonly { hash: string }[], receipts: ReadonlyMap<string, { logs: readonly Log[] }>, own: readonly Log[], max: number): number[] {
  if (earlier.length <= max) return earlier.map((_, i) => i);
  const plain = new Set([TRANSFER, APPROVAL, APPROVAL_FOR_ALL, DEPOSIT, WITHDRAWAL]);
  const key = (l: Log) => `${l.address.toLowerCase()} ${l.topics[0]}`;
  const mine = new Set(own.filter(l => l.topics[0] && !plain.has(l.topics[0])).map(key));
  const from = earlier.length - max, kept: number[] = [];
  for (let i = 0; i < from; i++) if (receipts.get(earlier[i].hash.toLowerCase())?.logs.some(l => mine.has(key(l)))) kept.push(i);
  return [...kept, ...Array.from({ length: max }, (_, j) => from + j)];
}
