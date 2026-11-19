// Governance signatures. delegateBySig (Compound's Comp and GovernorBravo-era tokens, OpenZeppelin's ERC20Votes: UNI,
// ENS, ARB and many more) signs Delegation(address delegatee,uint256 nonce,uint256 expiry): the delegatee then votes
// with the signer's balance, which stays the signer's, until it delegates again. castVoteBySig signs a Ballot:
// Ballot(uint256 proposalId,uint8 support) (GovernorBravo), with voter and nonce (OpenZeppelin Governor 5), or an
// ExtendedBallot with a reason and params. Support: 0 against, 1 for, 2 abstain. None moves funds.
import { PreviewBuilder, formatTimestamp, shortAddress } from '../format.ts';
import { chainName } from '../chains.ts';
import { big, domainChainId, str, type TypedAdapter } from './common.ts';
import { callWords, pad } from './exposure.ts';

const DELEGATION = 'address delegatee,uint256 nonce,uint256 expiry';
const BALLOTS = ['uint256 proposalId,uint8 support', 'uint256 proposalId,uint8 support,address voter,uint256 nonce'];
const EXTENDED = 'uint256 proposalId,uint8 support,address voter,uint256 nonce,string reason,bytes params';
const SUPPORT = ['against', 'for', 'abstain'];
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export const governanceAdapter: TypedAdapter = async (data, env) => {
  const fields = (t: string) => data.types[t]?.map(f => `${f.type} ${f.name}`).join(',');
  const kind = data.primaryType === 'Delegation' && fields('Delegation') === DELEGATION ? 'delegation'
    : data.primaryType === 'Ballot' && BALLOTS.includes(fields('Ballot') ?? '') ? 'ballot'
    : data.primaryType === 'ExtendedBallot' && fields('ExtendedBallot') === EXTENDED ? 'ballot' : null;
  if (!kind) return null;
  const chainId = domainChainId(data);
  const network = chainId !== null ? { kind: 'evm' as const, chainId, name: chainName(chainId) } : null;
  const contract = str(data.domain.verifyingContract).toLowerCase(), name = str(data.domain.name);
  const m = data.message;
  const b = new PreviewBuilder();
  let info: { symbol: string } | undefined;
  try { info = chainId !== null && ADDRESS.test(contract) ? (await env.deps.tokens?.get(chainId, contract)) ?? undefined : undefined; } catch { info = undefined; }
  const what = info?.symbol || name || shortAddress(contract);
  b.detail('Contract', `${name || 'unnamed'} (${contract})`, contract);
  if (kind === 'delegation') {
    const delegatee = str(m.delegatee).toLowerCase(), expiry = big(m.expiry);
    const none = /^0x0{40}$/.test(delegatee);
    b.detail('Delegate', none ? 'none (the zero address)' : delegatee, delegatee).detail('Nonce', String(big(m.nonce) ?? str(m.nonce)));
    if (expiry !== null) b.detail('Valid until', expiry >= 1n << 40n ? 'no deadline' : formatTimestamp(Number(expiry) * 1000), expiry.toString());
    if (expiry !== null && expiry * 1000n < BigInt(env.now)) b.warn('info', 'governance_expired', 'Its expiry has passed: the token refuses it.');
    // With an RPC, who has the votes now (delegates(signer)).
    if (env.signer && chainId !== null && ADDRESS.test(contract)) {
      const [current] = await callWords(env, chainId, contract, `0x587cde1e${pad(env.signer)}`) ?? [];
      if (current !== undefined) b.detail('Current delegate', current === 0n ? 'none' : `0x${current.toString(16).padStart(40, '0')}`);
    }
    b.warn('info', 'governance_delegate', none ? `It removes your ${what} votes' delegate: nobody votes with them until you delegate again. It moves no tokens.` : `${shortAddress(delegatee)} will vote with your ${what} balance in ${name || 'its'} governance until you delegate again. It moves no tokens.`);
    b.note('An off-chain signature: anyone can submit it (delegateBySig). It costs nothing now.');
    return { title: none ? `Remove the delegate of your ${what} votes` : `Delegate your ${what} votes to ${shortAddress(delegatee)}`, summary: `A governance delegation: ${none ? 'no one' : shortAddress(delegatee)} votes with your ${what} balance; your tokens stay yours.`, decoder: 'governance_delegation', status: 'full', b, network };
  }
  const proposal = String(big(m.proposalId) ?? str(m.proposalId)), support = big(m.support);
  const choice = support !== null && support < 3n ? SUPPORT[Number(support)] : `option ${support}`;
  b.detail('Proposal', proposal).detail('Vote', choice);
  if (m.voter !== undefined) b.detail('Voter', str(m.voter));
  if (str(m.reason)) b.detail('Reason', str(m.reason).slice(0, 300));
  if (m.voter !== undefined && env.signer && ADDRESS.test(str(m.voter)) && env.signer !== str(m.voter).toLowerCase()) b.warn('caution', 'governance_other_voter', `It votes as ${shortAddress(str(m.voter))}, but ${shortAddress(env.signer)} is asked to sign it.`);
  b.note('An off-chain vote: anyone can submit it (castVoteBySig). It costs nothing and moves no funds.');
  return { title: `Vote ${choice} on proposal ${proposal.length > 20 ? `${proposal.slice(0, 8)}…${proposal.slice(-6)}` : proposal} in ${name || shortAddress(contract)}`, summary: `A governance vote by signature: ${choice} on proposal ${proposal}.`, decoder: 'governance_vote', status: 'full', b, network };
};
