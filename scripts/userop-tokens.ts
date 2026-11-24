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
 * (scripts/accuracy-4337.ts): every one whose receipt logs an event the bundle's own receipt logs, from the same
 * contract (a pool's Sync and Swap, a singleton's Swap: Uniswap v4's PoolManager's for any pool, wider than needed,
 * never narrower; another bundle's EntryPoint events), and as many of the latest others as the rest of `max` holds.
 * Not a token's Transfer or Approval, nor a wrapper's Deposit or Withdrawal, which any transaction moving the token
 * logs. Indexes into `earlier`, in order. On Ethereum (2026-11-19) an operation 689th in its block swapped through a
 * pool the block's 91st transaction had traded in: with only the last 400 run before it, it met the pool without that
 * trade and came out 0.4% short in USDC and 6% over in gas, and was judged as if it had met the block.
 */
export function keptEarlier(earlier: readonly { hash: string }[], receipts: ReadonlyMap<string, { logs: readonly Log[] }>, own: readonly Log[], max: number): number[] {
  if (earlier.length <= max) return earlier.map((_, i) => i);
  const plain = new Set([TRANSFER, APPROVAL, APPROVAL_FOR_ALL, DEPOSIT, WITHDRAWAL]);
  const key = (l: Log) => `${l.address.toLowerCase()} ${l.topics[0]}`;
  const mine = new Set(own.filter(l => l.topics[0] && !plain.has(l.topics[0])).map(key));
  const related = earlier.map((t, i) => (receipts.get(t.hash.toLowerCase())?.logs.some(l => mine.has(key(l))) ? i : -1)).filter(i => i >= 0);
  // The latest `last` of them, and the related ones before those, together no more than `max`.
  let last = max;
  while (last > 0 && related.filter(i => i < earlier.length - last).length + last > max) last--;
  const from = earlier.length - last;
  return [...related.filter(i => i < from).slice(-max), ...Array.from({ length: last }, (_, j) => from + j)];
}

/** Whether a compared token's amounts differ by more than a share token's rounding (a base unit or two). */
export const offBy = (t: Compared): boolean => { const d = BigInt(t.actual) - BigInt(t.simulated); return (d < 0n ? -d : d) > 2n; };

/**
 * Compared tokens whose logs say another amount than the preview, held to the account's balance instead (`balance`
 * is then set: its change across the block). A token whose balance grows by itself (Aave's aTokens and debt tokens)
 * logs the interest since its holder's last movement with the next one: a deposit of 9 logged 9.00057, a withdrawal
 * of 0.02 logged 0.0141. A preview shows what the balance does. Within the interest a block adds to the whole
 * balance (a millionth of it: a position of a million at 4% a year grows 0.015 in twelve seconds, whatever moved).
 * Where the balance can't say (another transaction of the block moved the token for the account, `others` being
 * their receipts; or the node no longer has it), the token is `unjudged`, with why: not a difference.
 */
export async function heldToBalance(tokens: (Compared & { balance?: string; unjudged?: string })[], account: string, others: readonly { logs: readonly Log[] }[], balanceOf: (token: string, when: 'before' | 'after') => Promise<bigint>): Promise<void> {
  const abs = (x: bigint) => (x < 0n ? -x : x);
  for (const t of tokens.filter(t => offBy(t) && !t.account)) {
    if (others.some(r => r.logs.some(l => l.address.toLowerCase() === t.token && l.topics[0] === TRANSFER && l.topics.slice(1).some(x => `0x${x.slice(26)}`.toLowerCase() === account)))) { t.unjudged = 'another transaction of the block moved the token for the account'; continue; }
    try {
      const [b0, b1] = await Promise.all([balanceOf(t.token, 'before'), balanceOf(t.token, 'after')]);
      // Where the balance moved as the logs say, the logs stand, and a preview that says another amount differs:
      // only a balance that says something else than its token's logs is the one to hold the preview to. (Within
      // the tolerance alone, a preview half a token off both the logs and the balance of a large holder passed.)
      if (abs(b1 - b0 - BigInt(t.actual)) <= 2n) continue;
      // And only where it is nearer the preview than its logs are: a preview half a token off both, for a holder of
      // a million whose balance drifted three base units from its logs, passed within the interest on a million.
      const held = b0 > b1 ? b0 : b1, interest = held / 1_000_000n > 2n ? held / 1_000_000n : 2n;
      const off = abs(b1 - b0 - BigInt(t.simulated));
      if (off <= interest && off < abs(b1 - b0 - BigInt(t.actual))) t.balance = (b1 - b0).toString();
    } catch (e) {
      // (Only state the node says it no longer has: a token that doesn't answer balanceOf, or answers nothing, is
      // no reason to let the difference go.)
      if (stateGone(e)) t.unjudged = "its balance across the block isn't served by the node any more";
    }
  }
}

/**
 * An account's balance of a token on a block's state, as a block at another time would find it: the parent block's
 * state at the time of the block a transaction ran in, which is the balance the transaction met. For heldToBalance's
 * `before`, of a balance that moves with time alone. Read at the parent's own time, twelve seconds earlier, the
 * difference across the block held those seconds' worth too: a batch on Ethereum (2026-11-24) repaid a loan on
 * Inverse's FiRM, whose borrowing-rights token (DBR, 0xad03…d710) a debt wears away by the second and logs as burned
 * at the borrower's next movement (11,495.6 here, for more than a year of it). The preview showed no DBR moving,
 * as the balance says; across the block it fell 0.019, twelve seconds of a debt of 50,000, seven millionths of the
 * 2,617 held, and the batch was a difference.
 *
 * Asked of the node's simulation (eth_simulateV1, a block with that time on that state). Where the node won't say
 * so, the balance at the block's own time, as before.
 */
export async function balanceAtTime(call: (method: string, params: unknown[]) => Promise<unknown>, token: string, account: string, block: string, time: number): Promise<bigint> {
  const data = `0x70a08231${account.slice(2).toLowerCase().padStart(64, '0')}`;
  try {
    const r = await call('eth_simulateV1', [{ blockStateCalls: [{ blockOverrides: { time: `0x${time.toString(16)}` }, calls: [{ to: token, data }] }] }, block]) as { calls?: { status?: string; returnData?: string }[] }[] | undefined;
    const c = r?.[0]?.calls?.[0];
    if (c?.status === '0x1' && /^0x[0-9a-f]{64}$/i.test(c.returnData ?? '')) return BigInt(c.returnData!);
  } catch (e) { if (stateGone(e)) throw e; }
  return BigInt(String(await call('eth_call', [{ to: token, data }, block])));
}

/** Whether a read failed because the node no longer has the block's state (not because the call reverted, or answered nothing). */
export const stateGone = (e: unknown): boolean => /missing trie node|header not found|block not found|pruned|historical state|state (is |at .* is )?(not available|unavailable|not found)|no state available|unknown block/i.test(e instanceof Error ? e.message : String(e));

/** Whether a compared token is a difference: its amounts apart, and neither its balance nor a reason not to judge it says otherwise. */
export const differsIn = (t: Compared & { balance?: string; unjudged?: string }): boolean => offBy(t) && t.balance === undefined && !t.unjudged;

/**
 * Why a run could not look, which is not a pass: the node answered for fewer of the blocks asked of it than it
 * failed (ten or more of them), or what failed (a read or a preview that erred, a block's receipts, state the node
 * no longer serves, a replay the node couldn't serve, a preview that wasn't simulated) is three or more of the
 * transactions found and more than those compared. Reasons that are a transaction's own (not a batch, not a Safe,
 * used earlier in its block) are not failures. Null where it looked.
 */
export function couldNotLook(skipped: Readonly<Record<string, number>>, compared: number, blocks?: { read: number; unread: number }): string | null {
  if (blocks?.unread && !blocks.read) return `none of the ${blocks.unread} block${blocks.unread === 1 ? '' : 's'} asked for could be read`;
  if (blocks && blocks.unread >= 10 && blocks.unread > blocks.read) return `${blocks.unread} of the ${blocks.unread + blocks.read} blocks asked for could not be read`;
  const failed = Object.entries(skipped).filter(([why]) => /^error: |could not be read|no longer served|^a read of |^not simulated|^not replayable \(UNAVAILABLE\)/.test(why)).reduce((n, [, count]) => n + count, 0);
  return failed >= 3 && failed > compared ? `${failed} transactions could not be looked at (a read, a replay, a preview or a simulation that failed), against ${compared} compared` : null;
}
