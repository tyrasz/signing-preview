// EIP-7702 (type-4 transactions): each entry of the authorization list sets an account's code to "delegate to
// contract X". From then on X's code runs as that account, with full control of everything it holds, until the
// delegation is changed. An unsigned entry asks the wallet to sign it for the sender's account; a signed one may
// belong to another account (a sponsor submitting someone else's upgrade).
import { recoverAuthorizationAddress } from 'viem/utils';
import { type PreviewBuilder, sameAddress, shortAddress } from '../format.ts';
import { chainName } from '../chains.ts';
import type { AbiResolver, ContractAbi, Dependencies } from '../types.ts';
import type { AuthorizationRequest, Tx } from './common.ts';

const ZERO = '0x0000000000000000000000000000000000000000';

async function verifiedName(deps: Dependencies, chainId: number, address: string): Promise<string | undefined> {
  try {
    const c = await deps.abis?.resolve(chainId, address);
    return c?.verified ? c.name : undefined;
  } catch {
    return undefined;
  }
}

/** The account an authorization changes: the sender's own when unsigned, else whoever signed it (null if unreadable). */
async function authorityOf(tx: Tx, a: AuthorizationRequest): Promise<string | null> {
  if (!a.signature) return tx.from;
  try {
    const signer = await recoverAuthorizationAddress({
      authorization: { address: a.address as `0x${string}`, chainId: a.chainId ?? tx.chainId, nonce: Number(a.nonce ?? 0n) },
      signature: a.signature,
    });
    return signer.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * The contract the sender's account will delegate to once this transaction's authorizations apply: an address, null
 * when they clear its delegation, undefined when they don't touch it. The last one for the account wins, as on-chain.
 */
export async function ownDelegateAfter(tx: Tx): Promise<string | null | undefined> {
  let out: string | null | undefined;
  for (const a of tx.authorizations ?? []) {
    if (a.chainId !== undefined && a.chainId !== 0 && a.chainId !== tx.chainId) continue;
    if (!sameAddress((await authorityOf(tx, a)) ?? ZERO, tx.from)) continue;
    out = sameAddress(a.address, ZERO) ? null : a.address.toLowerCase();
  }
  return out;
}

/**
 * ABIs as they will be once the sender's account delegates to `delegate` in this transaction: the account's own
 * address resolves to the delegate's ABI, so a call to it in the same transaction is decoded against its new code.
 */
export function delegatedAbis(base: AbiResolver, account: string, delegate: string): AbiResolver {
  const mine = (a: string) => sameAddress(a, account);
  const label = (c: ContractAbi | null) => c && { ...c, name: `your account (${c.name ?? shortAddress(delegate)})`, source: `${c.source}, the code your account delegates to in this transaction` };
  return {
    resolve: async (chainId, a) => mine(a) ? label(await base.resolve(chainId, delegate)) : base.resolve(chainId, a),
    ...(base.resolveCall && { resolveCall: async (chainId: number, a: string, selector: string) => mine(a) ? label(await base.resolveCall!(chainId, delegate, selector)) : base.resolveCall!(chainId, a, selector) }),
  };
}

export interface DelegationEffects {
  /** The contract the sender's own account will delegate to, if any. */
  ownDelegate?: { address: string; name?: string };
  /** The sender's own delegation is cleared. */
  ownRevoke: boolean;
  /** Clause for the summary, e.g. "delegates your account to 0x63c0…32b (EIP7702StatelessDeleGator)". */
  clause: string;
  /**
   * The code each authority will have once the authorizations apply (the 0xef0100 delegation designator, or none
   * for a revocation), for simulating the transaction as it will run.
   */
  codeOverrides: Record<string, string>;
}

/** Chains whose EVM applies EIP-7702 (Prague and later). HyperEVM runs Cancun rules. */
export const SUPPORTS_7702 = new Set([1, 11155111, 42161, 421614]);

/** Details and warnings for the authorization list; null when there is none. */
export async function delegationEffects(tx: Tx, deps: Dependencies, b: PreviewBuilder): Promise<DelegationEffects | null> {
  if (!tx.authorizations?.length) return null;
  const clauses: string[] = [];
  const codeOverrides: Record<string, string> = {};
  let ownDelegate: DelegationEffects['ownDelegate'], ownRevoke = false;
  for (const [i, a] of tx.authorizations.entries()) {
    const authority = await authorityOf(tx, a);
    if (!authority) {
      b.warn('info', 'eip7702_bad_signature', `Authorization ${i + 1} has a signature that can't be read, so the chain will skip it.`);
      continue;
    }
    const yours = sameAddress(authority, tx.from);
    const account = yours ? 'your account' : `account ${authority}`;
    // chainId 0 is valid on every chain: whoever holds the signed authorization can submit it anywhere.
    const where = a.chainId === 0 ? 'on every EVM chain' : `on ${chainName(a.chainId ?? tx.chainId)}`;
    const applies = a.chainId === undefined || a.chainId === 0 || a.chainId === tx.chainId;
    if (!applies) {
      b.warn('caution', 'eip7702_other_chain', `Authorization ${i + 1} is for ${chainName(a.chainId!)}, not ${chainName(tx.chainId)}. This transaction can't apply it, but anyone holding it can submit it there.`);
    } else {
      // Later authorizations for the same account win, as on-chain.
      codeOverrides[authority] = sameAddress(a.address, ZERO) ? '0x' : `0xef0100${a.address.slice(2).toLowerCase()}`;
    }
    if (sameAddress(a.address, ZERO)) {
      b.detail('EIP-7702 delegation', `clear ${account}'s delegation ${where}`, a.address);
      b.warn('info', 'eip7702_revoke', `This clears ${yours ? 'your account’s' : `${authority}’s`} EIP-7702 delegation ${where}: it becomes a plain account again.`);
      clauses.push(`clears ${account}'s EIP-7702 delegation`);
      if (yours) ownRevoke = true;
      continue;
    }
    const name = await verifiedName(deps, a.chainId || tx.chainId, a.address);
    const target = `${a.address}${name ? ` (${name})` : ''}`;
    b.detail('EIP-7702 delegation', `${yours ? 'your account' : authority} → ${target}, ${where}`, a.address);
    if (yours) {
      ownDelegate = { address: a.address, name };
      b.warn('danger', 'eip7702_delegation', `This sets your account's code (EIP-7702): the contract at ${target} will run as your account ${where}. It gets full control of the account and everything in it until the delegation is changed. Only continue if this is your own wallet's smart-account upgrade.`);
    } else {
      b.warn('info', 'eip7702_sponsored', `This submits an EIP-7702 authorization signed by ${authority}. It delegates that account to ${target}, not yours.`);
    }
    clauses.push(`delegates ${account} to ${shortAddress(a.address)}${name ? ` (${name})` : ''} (EIP-7702)`);
  }
  return clauses.length ? { ownDelegate, ownRevoke, clause: clauses.join('; '), codeOverrides } : null;
}
