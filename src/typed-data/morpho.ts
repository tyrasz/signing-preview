// Morpho Blue authorizations. Morpho (0xbbbb…ffcb, the same address on Ethereum and Base, verified on Sourcify) lets an
// account authorize another to manage its positions: setAuthorizationWithSig takes an Authorization signed by the
// account's key (ecrecover: EOAs only) under the domain EIP712Domain(uint256 chainId,address verifyingContract):
//   Authorization(address authorizer,address authorized,bool isAuthorized,uint256 nonce,uint256 deadline)
// requiring the nonce to be the account's next (nonce(authorizer)) and the deadline not passed. Once authorized, the
// address can withdraw the account's supply, borrow against its collateral and withdraw its collateral, in every
// market, to any receiver (_isSenderAuthorized in withdraw, borrow and withdrawCollateral), until revoked. Morpho's
// app asks for it for its bundler's adapter, which acts only for whoever starts the bundle.
import { encodeAbiParameters, keccak256, toHex, type Hex } from 'viem';
import { PreviewBuilder, formatTimestamp, shortAddress } from '../format.ts';
import type { Dependencies } from '../types.ts';
import { chainName } from '../chains.ts';
import { big, domainChainId, str, type TypedAdapter } from './common.ts';
import { callWords, pad } from './exposure.ts';

export const MORPHO = '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb';
const FIELDS = 'address authorizer,address authorized,bool isAuthorized,uint256 nonce,uint256 deadline';
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DOMAIN_TYPEHASH = keccak256(toHex('EIP712Domain(uint256 chainId,address verifyingContract)'));

/**
 * Whether a contract is Morpho: the address on Ethereum and Base, or (Morpho has others on other chains) a contract
 * whose DOMAIN_SEPARATOR() is Morpho's domain for it and that answers isAuthorized(address,address).
 */
export async function isMorpho(deps: Dependencies, chainId: number, address: string): Promise<boolean> {
  if (address === MORPHO) return true;
  if (!deps.rpc?.has(chainId) || !ADDRESS.test(address)) return false;
  try {
    const expected = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }], [DOMAIN_TYPEHASH, BigInt(chainId), address as Hex]));
    const separator = String(await deps.rpc.call(chainId, 'eth_call', [{ to: address, data: '0x3644e515' }, 'latest'])).toLowerCase();
    const authorized = String(await deps.rpc.call(chainId, 'eth_call', [{ to: address, data: `0x65e4ad9e${'0'.repeat(128)}` }, 'latest']));
    return separator === expected && /^0x[0-9a-f]{64}$/i.test(authorized);
  } catch { return false; }
}

/** An account with no code: none at all, or an EOA's EIP-7702 delegation (0xef0100 + its delegate), still a key. */
export async function keyAccount(deps: Dependencies, chainId: number, address: string): Promise<boolean | undefined> {
  try {
    if (!deps.rpc?.has(chainId)) return undefined;
    const code = String(await deps.rpc.call(chainId, 'eth_getCode', [address, 'latest'])).toLowerCase();
    return code === '0x' || code.startsWith('0xef0100');
  } catch { return undefined; }
}

/** A signed bool as wallets encode it: only false (and ethers' falsy 0) is false; anything else is signed as true. */
export const signedTrue = (v: unknown) => !(v === false || v === 0);

export const morphoAuthorizationAdapter: TypedAdapter = async (data, env) => {
  if (data.primaryType !== 'Authorization' || data.types.Authorization?.map(f => `${f.type} ${f.name}`).join(',') !== FIELDS) return null;
  const domainFields = (data.types.EIP712Domain ?? []).map(f => f.name).join(',');
  const contract = str(data.domain.verifyingContract).toLowerCase();
  // Morpho's domain has no name or version; another contract with this type is read the same way, with a caution.
  if (domainFields && domainFields !== 'chainId,verifyingContract' && contract !== MORPHO) return null;
  const m = data.message;
  const authorizer = str(m.authorizer).toLowerCase(), authorized = str(m.authorized).toLowerCase();
  const grant = signedTrue(m.isAuthorized);
  const nonce = big(m.nonce), deadline = big(m.deadline);
  if (!ADDRESS.test(authorizer) || !ADDRESS.test(authorized) || nonce === null || deadline === null) return null;
  const chainId = domainChainId(data);
  const network = chainId !== null ? { kind: 'evm' as const, chainId, name: chainName(chainId) } : null;
  const b = new PreviewBuilder();
  const known = chainId !== null && await isMorpho(env.deps, chainId, contract);
  b.detail('Account', authorizer).detail(grant ? 'Authorized' : 'Revoked', authorized).detail('Nonce', nonce.toString())
    .detail('Valid until', deadline >= 1n << 40n ? 'no deadline' : formatTimestamp(Number(deadline) * 1000), deadline.toString());
  if (!known) b.warn('caution', 'morpho_contract_unknown', `It is signed for ${shortAddress(contract)}, which isn't read as Morpho (${shortAddress(MORPHO)} on Ethereum and Base; elsewhere, a contract with Morpho's domain, read with an RPC): what that contract does with it isn't known here.`);
  if (typeof m.isAuthorized !== 'boolean') b.warn('caution', 'morpho_bool', `Its isAuthorized is ${JSON.stringify(m.isAuthorized)}, not true or false: wallets sign anything but false (or 0) as true, so it is read as a grant.`);
  if (env.signer && env.signer !== authorizer) b.warn('info', 'morpho_other_authorizer', `It authorizes for ${shortAddress(authorizer)}, but ${shortAddress(env.signer)} is asked to sign it: Morpho takes only the authorizer's own signature.`);
  if (deadline * 1000n < BigInt(env.now)) b.warn('info', 'morpho_expired', 'Its deadline has passed: Morpho refuses it.');
  // With an RPC: whether the nonce is the next one, whether it changes anything, and what the authorized address is.
  let eoa: boolean | undefined;
  if (known && chainId !== null) {
    const [next] = await callWords(env, chainId, contract, `0x70ae92d2${pad(authorizer)}`) ?? [];
    if (next !== undefined && next !== nonce) b.warn('info', 'morpho_nonce', next > nonce ? `Its nonce (${nonce}) was used already (the account's next is ${next}): Morpho refuses it.` : `Its nonce (${nonce}) is ahead of the account's next (${next}): Morpho refuses it until the nonces before it are used.`);
    const [already] = await callWords(env, chainId, contract, `0x65e4ad9e${pad(authorizer)}${pad(authorized)}`) ?? [];
    if (already !== undefined && (already === 1n) === grant) b.warn('info', 'morpho_unchanged', grant ? `${shortAddress(authorized)} is already authorized: it changes nothing but the nonce.` : `${shortAddress(authorized)} isn't authorized: it changes nothing but the nonce.`);
    eoa = await keyAccount(env.deps, chainId, authorized);
  }
  if (grant) {
    const what = `${shortAddress(authorized)} can withdraw your supply and collateral from every Morpho market and borrow against your collateral, sending it all to any address, until you revoke it (setAuthorization)`;
    if (eoa) b.warn('danger', 'morpho_authorize', `${what}. It is an account with no contract code of its own (no code, or an EIP-7702 delegation): a person or a key, not Morpho's adapter. Don't sign it unless you mean to hand your Morpho positions over.`);
    else b.warn('caution', 'morpho_authorize', `${what}. Morpho's app asks for this for its bundler's adapter, which acts only for whoever starts the bundle; sign it only for an adapter you trust${eoa === undefined ? ' (whether it is a contract wasn\'t read)' : ''}.`);
  }
  b.note('An off-chain signature: it costs nothing now. Anyone can submit it to Morpho (setAuthorizationWithSig).');
  return {
    title: grant ? `Authorize ${shortAddress(authorized)} to manage your Morpho positions` : `Revoke ${shortAddress(authorized)}'s authorization on Morpho`,
    summary: grant ? `A Morpho authorization: ${shortAddress(authorized)} may withdraw, borrow and withdraw collateral for ${shortAddress(authorizer)} in every market.` : `A Morpho authorization that removes ${shortAddress(authorized)}'s right to manage ${shortAddress(authorizer)}'s positions.`,
    decoder: 'morpho_authorization', status: 'full', b, network,
  };
};
