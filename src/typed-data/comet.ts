// Compound III (Comet) authorizations. Each Comet market (cUSDCv3 and the others, each a proxy whose extension,
// CometExt, verified on Sourcify, holds allowBySig) lets an account make another its manager by signing, under the
// domain EIP712Domain(string name,string version,uint256 chainId,address verifyingContract) with the market's name()
// ("Compound USDC") and version "0":
//   Authorization(address owner,address manager,bool isAllowed,uint256 nonce,uint256 expiry)
// The nonce must be the owner's next (userNonce), the expiry not passed, the signature the owner's key (ecrecover). A
// manager can then transfer the owner's collateral and base to anyone and withdraw them to any address, which for the
// base asset past the owner's balance is borrowing (hasPermission in supplyInternal, transferInternal and
// withdrawInternal), until revoked. Compound's app asks for it for its Bulker.
import { PreviewBuilder, formatTimestamp, shortAddress } from '../format.ts';
import { chainName } from '../chains.ts';
import { big, domainChainId, str, type TypedAdapter } from './common.ts';
import { callWords, pad } from './exposure.ts';
import { keyAccount, signedTrue } from './morpho.ts';

const FIELDS = 'address owner,address manager,bool isAllowed,uint256 nonce,uint256 expiry';
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export const cometAuthorizationAdapter: TypedAdapter = async (data, env) => {
  if (data.primaryType !== 'Authorization' || data.types.Authorization?.map(f => `${f.type} ${f.name}`).join(',') !== FIELDS) return null;
  const m = data.message;
  const owner = str(m.owner).toLowerCase(), manager = str(m.manager).toLowerCase();
  const grant = signedTrue(m.isAllowed);
  const nonce = big(m.nonce), expiry = big(m.expiry);
  if (!ADDRESS.test(owner) || !ADDRESS.test(manager) || nonce === null || expiry === null) return null;
  const chainId = domainChainId(data);
  const network = chainId !== null ? { kind: 'evm' as const, chainId, name: chainName(chainId) } : null;
  const market = str(data.domain.verifyingContract).toLowerCase(), name = str(data.domain.name);
  const b = new PreviewBuilder();
  b.detail('Market', `${name || 'unnamed'} (${market})`, market).detail('Account', owner).detail(grant ? 'Manager' : 'Manager removed', manager)
    .detail('Nonce', nonce.toString()).detail('Valid until', expiry >= 1n << 40n ? 'no deadline' : formatTimestamp(Number(expiry) * 1000), expiry.toString());
  if (typeof m.isAllowed !== 'boolean') b.warn('caution', 'comet_bool', `Its isAllowed is ${JSON.stringify(m.isAllowed)}, not true or false: wallets sign anything but false (or 0) as true, so it is read as a grant.`);
  if (env.signer && env.signer !== owner) b.warn('info', 'comet_other_owner', `It authorizes for ${shortAddress(owner)}, but ${shortAddress(env.signer)} is asked to sign it: the market takes only the owner's own signature.`);
  if (expiry * 1000n <= BigInt(env.now)) b.warn('info', 'comet_expired', 'Its expiry has passed: the market refuses it.');
  // With an RPC: whether it is a Comet market (its name() and baseToken()), the nonce, and what the manager is.
  let eoa: boolean | undefined, comet: boolean | undefined;
  if (chainId !== null && ADDRESS.test(market) && env.deps.rpc?.has(chainId)) {
    const base = await callWords(env, chainId, market, '0xc55dae63');
    comet = !!base && base.length === 1 && base[0] > 0n;
    if (comet) {
      const [next] = await callWords(env, chainId, market, `0x2e04b8e7${pad(owner)}`) ?? [];
      if (next !== undefined && next !== nonce) b.warn('info', 'comet_nonce', next > nonce ? `Its nonce (${nonce}) was used already (the account's next is ${next}): the market refuses it.` : `Its nonce (${nonce}) is ahead of the account's next (${next}): the market refuses it until those before it are used.`);
      const [already] = await callWords(env, chainId, market, `0xa1654379${pad(owner)}${pad(manager)}`) ?? [];
      if (already !== undefined && (already === 1n) === grant) b.warn('info', 'comet_unchanged', grant ? `${shortAddress(manager)} is already a manager: it changes nothing but the nonce.` : `${shortAddress(manager)} isn't a manager: it changes nothing but the nonce.`);
    } else b.warn('caution', 'comet_market_unknown', `${shortAddress(market)} doesn't answer as a Compound III market (baseToken()): what it does with this isn't known here.`);
    eoa = await keyAccount(env.deps, chainId, manager);
  }
  if (grant) {
    const what = `${shortAddress(manager)} can transfer your collateral and ${name ? `${name}'s base asset` : 'base asset'} to anyone, withdraw them to any address, and borrow against your collateral, until you revoke it (allow)`;
    if (eoa) b.warn('danger', 'comet_authorize', `${what}. It is an account with no contract code of its own (no code, or an EIP-7702 delegation): a person or a key, not Compound's Bulker. Don't sign it unless you mean to hand this position over.`);
    else b.warn('caution', 'comet_authorize', `${what}. Compound's app asks for this for its Bulker; sign it only for a contract you trust${eoa === undefined ? " (whether it is a contract wasn't read)" : ''}.`);
  }
  b.note('An off-chain signature: it costs nothing now. Anyone can submit it to the market (allowBySig).');
  return {
    title: grant ? `Make ${shortAddress(manager)} a manager of your ${name || 'Compound'} position` : `Remove ${shortAddress(manager)} as a manager of your ${name || 'Compound'} position`,
    summary: grant ? `A Compound III authorization: ${shortAddress(manager)} may transfer, withdraw and borrow for ${shortAddress(owner)} in ${name || shortAddress(market)}.` : `A Compound III authorization that removes ${shortAddress(manager)} as a manager of ${shortAddress(owner)}'s position in ${name || shortAddress(market)}.`,
    decoder: 'comet_authorization', status: comet === false ? 'partial' : 'full', b, network,
  };
};
