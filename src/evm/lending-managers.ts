// Transactions that hand a lending position to another address, as their signed forms do (src/typed-data/morpho.ts,
// src/typed-data/comet.ts): Morpho Blue's setAuthorization(authorized, true) lets the authorized address withdraw the
// sender's supply and collateral from every market and borrow against it, to any receiver; a Compound III market's
// allow(manager, true) lets the manager transfer, withdraw and borrow for the sender in that market. Either lasts until
// revoked, and moves nothing when sent, so a simulation shows no change: what it allows is said here. A danger when
// the address has no code (a person or a key, not an adapter or a bulker), a caution otherwise. allow(address,bool) is
// a common name, so a contract is taken for a Compound III market only when it answers baseToken().
import { decodeFunctionData, parseAbi } from 'viem';
import { PreviewBuilder, shortAddress } from '../format.ts';
import { decoded, type Adapter } from './common.ts';
import { isMorpho, keyAccount } from '../typed-data/morpho.ts';

const MORPHO_ABI = parseAbi(['function setAuthorization(address authorized, bool newIsAuthorized)']);
const COMET_ABI = parseAbi(['function allow(address manager, bool isAllowed)', 'function approve(address spender, uint256 amount)']);
const MAX = (1n << 256n) - 1n;

export const lendingManagerAdapter: Adapter = async (tx, env) => {
  if (!tx.to || tx.data.length < 10) return null;
  const to = tx.to.toLowerCase();
  const morpho = tx.data.startsWith('0xeecea000') && await isMorpho(env.deps, tx.chainId, to);
  // A Compound III market's approve takes only 0 or the largest amount, and is allow (CometExt.approve).
  const comet = !morpho && (tx.data.startsWith('0x110496e5') || tx.data.startsWith('0x095ea7b3'));
  if (!morpho && !comet) return null;
  let who: string, grant: boolean;
  try {
    const call = morpho ? decodeFunctionData({ abi: MORPHO_ABI, data: tx.data }) : decodeFunctionData({ abi: COMET_ABI, data: tx.data });
    const flag = call.args[1];
    if (call.functionName === 'approve' && flag !== 0n && flag !== MAX) return null;
    [who, grant] = [String(call.args[0]).toLowerCase(), typeof flag === 'bigint' ? flag === MAX : Boolean(flag)];
  } catch { return null; }
  const rpc = env.deps.rpc?.has(tx.chainId) ? env.deps.rpc : undefined;
  if (comet) {
    // A Compound III market answers baseToken(); without an RPC, nothing says it is one.
    try {
      const base = rpc ? String(await rpc.call(tx.chainId, 'eth_call', [{ to, data: '0xc55dae63' }, 'latest'])) : '0x';
      if (!/^0x0{24}[0-9a-f]{40}$/i.test(base) || /^0x0+$/.test(base)) return null;
    } catch { return null; }
  }
  const eoa = await keyAccount(env.deps, tx.chainId, who);
  const b = new PreviewBuilder().detail('Contract', morpho ? `Morpho (${to})` : `Compound III market (${to})`, to).detail(grant ? (morpho ? 'Authorized' : 'Manager') : 'Removed', who);
  const what = morpho
    ? `${shortAddress(who)} can withdraw your supply and collateral from every Morpho market and borrow against your collateral, sending it all to any address, until you revoke it`
    : `${shortAddress(who)} can transfer your collateral and base asset in this market to anyone, withdraw them to any address, and borrow against your collateral, until you revoke it`;
  if (grant) {
    if (eoa) b.warn('danger', morpho ? 'morpho_authorize' : 'comet_authorize', `${what}. It is an account with no code: a person or a key, not ${morpho ? "Morpho's adapter" : "Compound's Bulker"}. Don't send it unless you mean to hand your position over.`);
    else b.warn('caution', morpho ? 'morpho_authorize' : 'comet_authorize', `${what}. ${morpho ? "Morpho's app asks for this for its bundler's adapter" : "Compound's app asks for this for its Bulker"}; only for a contract you trust${eoa === undefined ? " (whether it is a contract wasn't read)" : ''}.`);
  }
  b.note('It moves nothing when sent: what it allows comes later, through the address it authorizes.');
  return decoded({
    title: grant ? (morpho ? `Authorize ${shortAddress(who)} to manage your Morpho positions` : `Make ${shortAddress(who)} a manager of your Compound position`) : (morpho ? `Revoke ${shortAddress(who)}'s authorization on Morpho` : `Remove ${shortAddress(who)} as a manager of your Compound position`),
    summary: grant ? `${what}.` : `Removes ${shortAddress(who)}'s right to manage your position.`,
    decoder: morpho ? 'morpho_authorization' : 'comet_authorization', status: 'full', b,
  });
};
