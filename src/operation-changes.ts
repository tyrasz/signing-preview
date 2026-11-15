// Balance changes of one signature that authorizes several operations, each run from its own account on its own chain
// (a Biconomy MEE supertransaction's, src/supertransaction.ts; a multi-chain Safe root's, src/typed-data/safe.ts).
// Each operation's changes are its own account's (its sender's), and in a supertransaction other operations' accounts'
// whose tokens it moves, on its chain.
import { PreviewBuilder, sameAddress, shortAddress } from './format.ts';
import type { AssetChange } from './types.ts';

/**
 * One operation's balance changes: who it runs from (its sender), on which chain, and its label in the preview. Its
 * changes are its sender's, and may be other accounts' (each change's `account`): another operation's account whose
 * tokens it moves.
 */
export interface OperationChanges { label: string; chainId: number; sender: string; changes: AssetChange[] }

const listed = (changes: AssetChange[]) => changes.map(c => `${c.direction === 'out' ? '−' : '+'}${c.amount} ${c.symbol}`).join(', ');

/**
 * The preview's balance changes: every operation's, on whichever chain it runs, each with its chain (chainId), so
 * that none is left out for being on a chain other than the request's. Where the operations run from more than one
 * account, what one account receives doesn't make up for what another sends (an app can add an operation of an
 * account of its own, which the signature also authorizes, that receives what yours sends, or takes it with an
 * allowance yours grants): every account's outgoing amounts are listed (an operation's changes can be another
 * account's, src/supertransaction.ts), incoming ones only for `account` (the connected account, when it is one of
 * them), the others described with their operation; and a caution names the accounts.
 */
export function combineChanges(ops: OperationChanges[], b: PreviewBuilder, account?: string): AssetChange[] {
  const senders = [...new Set(ops.map(o => o.sender.toLowerCase()))];
  const tagged = ops.map(o => ({ ...o, changes: o.changes.map(c => ({ ...c, chainId: o.chainId })) }));
  if (senders.length <= 1) return tagged.flatMap(o => o.changes);
  const primary = account ? senders.find(s => sameAddress(s, account)) : undefined;
  const out: AssetChange[] = [];
  for (const o of tagged) {
    const kept = o.changes.filter(c => c.direction === 'out' || (primary !== undefined && sameAddress(c.account, primary)));
    out.push(...kept);
    const received = o.changes.filter(c => !kept.includes(c));
    for (const who of [...new Set(received.map(c => c.account.toLowerCase()))]) {
      b.detail(`${o.label}: received by ${shortAddress(who)} (not in the balance changes)`, listed(received.filter(c => sameAddress(c.account, who))));
    }
  }
  b.warn('caution', 'operations_multiple_accounts', `These operations run from ${senders.length} different accounts (${senders.map(shortAddress).join(', ')}): what one account receives doesn't make up for what another sends, and one account's operation can take another's tokens (with an allowance it was granted). ${primary
    ? `The balance changes list what each of them sends, and what ${shortAddress(primary)}, the connected account, receives; what the others receive is described with the operations.`
    : "The balance changes list only what each of them sends; what each receives is described with the operation."} Only sign if every one of these accounts is yours.`);
  return out;
}
