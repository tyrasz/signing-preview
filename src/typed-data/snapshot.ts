// Snapshot (snapshot.org): off-chain governance, each action an EIP-712 message under the domain { name: "snapshot",
// version: "0.1.4" } (snapshot.js, src/sign: no chainId by default, no verifyingContract), sent to Snapshot's hub, not
// to any chain: Vote, Proposal, UpdateProposal, FlagProposal, CancelProposal, Follow, Unfollow, Subscribe, Unsubscribe,
// Profile, Statement, Space, DeleteSpace and Alias. None moves funds. Alias(from, alias, timestamp) lets the alias
// address act as the account on Snapshot (vote, propose, follow, change its profile) without asking again, until
// removed: a caution. So are changing a space's settings and deleting it. A message under this domain with a
// verifyingContract isn't Snapshot's, so it is left to the generic preview.
import { PreviewBuilder, formatTimestamp, shortAddress } from '../format.ts';
import { str, type TypedAdapter } from './common.ts';

const ACTIONS: Record<string, string> = {
  Vote: 'Vote on a Snapshot proposal', Proposal: 'Create a Snapshot proposal', UpdateProposal: 'Edit a Snapshot proposal', FlagProposal: 'Flag a Snapshot proposal',
  CancelProposal: 'Cancel a Snapshot proposal', Follow: 'Follow a Snapshot space', Unfollow: 'Unfollow a Snapshot space', Subscribe: 'Subscribe to a Snapshot space',
  Unsubscribe: 'Unsubscribe from a Snapshot space', Profile: 'Update your Snapshot profile', Statement: 'Publish a delegate statement on Snapshot',
  Space: "Change a Snapshot space's settings", DeleteSpace: 'Delete a Snapshot space', Alias: 'Let another address act as you on Snapshot',
};
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export const snapshotAdapter: TypedAdapter = async (data, env) => {
  if (str(data.domain.name) !== 'snapshot' || data.domain.verifyingContract !== undefined || !ACTIONS[data.primaryType]) return null;
  const m = data.message;
  const b = new PreviewBuilder();
  const from = str(m.from);
  const space = str(m.space), proposal = str(m.proposal ?? m.id), timestamp = Number(str(m.timestamp));
  if (from) b.detail('Account', from);
  if (space) b.detail('Space', space);
  if (proposal) b.detail('Proposal', proposal.length > 70 ? `${proposal.slice(0, 66)}…` : proposal, proposal);
  if (data.primaryType === 'Vote') {
    const choice = m.choice;
    b.detail('Choice', Array.isArray(choice) ? choice.map(String).join(', ') : typeof choice === 'object' && choice !== null ? JSON.stringify(choice) : String(choice));
    if (str(m.reason)) b.detail('Reason', str(m.reason).slice(0, 300));
  }
  if (data.primaryType === 'Proposal' || data.primaryType === 'UpdateProposal') {
    if (str(m.title)) b.detail('Title', str(m.title).slice(0, 200));
    if (Array.isArray(m.choices)) b.detail('Choices', (m.choices as unknown[]).map(String).join(', ').slice(0, 300));
  }
  if (Number.isFinite(timestamp) && timestamp > 0) b.detail('Signed at', formatTimestamp(timestamp * 1000), String(timestamp));
  if (env.signer && ADDRESS.test(from) && env.signer !== from.toLowerCase()) b.warn('caution', 'snapshot_other_account', `It is for ${shortAddress(from)}, but ${shortAddress(env.signer)} is asked to sign it.`);
  if (data.primaryType === 'Alias') {
    const alias = str(m.alias);
    b.detail('Alias', alias);
    b.warn('caution', 'snapshot_alias', `${ADDRESS.test(alias) ? shortAddress(alias) : 'The alias'} can then act as you on Snapshot without asking you again: vote, create proposals, follow spaces and change your profile, until you remove it. It moves no funds.`);
  }
  if (data.primaryType === 'Space') b.warn('caution', 'snapshot_space_settings', `It replaces ${space || 'the space'}'s settings (its admins, voting strategies and rules), if you are allowed to change them.`);
  if (data.primaryType === 'DeleteSpace') b.warn('caution', 'snapshot_delete_space', `It deletes the space ${space || ''} on Snapshot, if you are allowed to.`.replace('  ', ' '));
  b.note("A Snapshot message: it goes to Snapshot's hub, not to a chain, costs nothing and moves no funds.");
  const title = data.primaryType === 'Vote' && space ? `Vote on a Snapshot proposal in ${space}` : data.primaryType === 'Alias' && ADDRESS.test(str(m.alias)) ? `Let ${shortAddress(str(m.alias))} act as you on Snapshot` : ACTIONS[data.primaryType];
  return { title, summary: `${ACTIONS[data.primaryType]}${space ? ` (${space})` : ''}: an off-chain Snapshot message, which moves no funds.`, decoder: 'snapshot', status: 'full', b, network: null };
};
