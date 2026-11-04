import { formatTimestamp, isUnlimited, PreviewBuilder, shortAddress } from '../format.ts';
import { chainName } from '../chains.ts';
import { delegationTarget } from '../evm/hyperlend.ts';
import { big, domainChainId, str, type TypedAdapter } from './common.ts';

/**
 * Aave-style DelegationWithSig (HyperLend debt tokens use the exact Aave typehash): a signature that grants credit
 * delegation, i.e. lets the delegatee borrow in your name. Anyone holding the signature can submit it.
 */
export const creditDelegationTypedAdapter: TypedAdapter = async (data, env) => {
  if (data.primaryType !== 'DelegationWithSig') return null;
  const fields = (data.types.DelegationWithSig ?? []).map(f => f.name);
  if (!['delegatee', 'value', 'nonce', 'deadline'].every(f => fields.includes(f))) return null;
  const chainId = domainChainId(data);
  const debtToken = str(data.domain.verifyingContract).toLowerCase();
  const b = new PreviewBuilder();
  const d = chainId !== null
    ? await delegationTarget({ deps: env.deps, context: env.context }, chainId, debtToken, b)
    : { protocol: 'a lending market', debtName: str(data.domain.name), symbol: 'the underlying token', format: (raw: bigint) => `${raw} base units` };
  const m = data.message;
  const delegatee = str(m.delegatee), value = big(m.value), deadline = big(m.deadline);
  b.detail('Debt token', `${str(data.domain.name) || d.debtName} (${debtToken})`, debtToken).detail('Delegatee', delegatee)
    .detail('Borrowing allowance', value === null ? str(m.value) : value === 0n ? 'none (revoke)' : isUnlimited(value) ? 'unlimited' : d.format(value), value?.toString())
    .detail('Signature valid until', deadline === null ? str(m.deadline) : deadline >= 1n << 47n ? 'never expires' : formatTimestamp(Number(deadline) * 1000))
    .detail('Nonce', str(m.nonce));
  const network = chainId !== null ? { kind: 'evm' as const, chainId, name: chainName(chainId) } : null;
  if (value === 0n) return { title: `Sign: revoke ${shortAddress(delegatee)}'s credit delegation on ${d.protocol}`, summary: `Stops ${delegatee} from borrowing ${d.symbol} in your name.`, decoder: 'credit_delegation_signature', status: 'full', b, network };
  if (deadline !== null && deadline < 1n << 47n && Number(deadline) * 1000 < env.now) b.warn('info', 'signature_expired', 'The signature has already expired and cannot be used.');
  const amount = value === null || isUnlimited(value) ? `any amount of ${d.symbol}` : `up to ${d.format(value)}`;
  b.warn('danger', 'credit_delegation', `This signature lets ${delegatee} borrow ${amount} from ${d.protocol} in your name. The debt is yours, it is backed by your collateral, and they keep what they borrow. Anyone holding the signature can submit it; only sign for someone you trust completely.`);
  return { title: `Sign: let ${shortAddress(delegatee)} borrow ${value === null || isUnlimited(value) ? `unlimited ${d.symbol}` : `up to ${d.format(value)}`} in your name on ${d.protocol}`,
    summary: `A credit-delegation signature for ${d.protocol}: ${delegatee} could borrow ${d.symbol} against your collateral.`, decoder: 'credit_delegation_signature', status: 'full', b, network };
};
