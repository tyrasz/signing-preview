// Sessions for an EIP-7702 account that runs WalletCore (source verified on Sourcify: 0x69e6bd1c…541d on Ethereum,
// 0x64fc2320…936b on BNB Chain). A session names an executor, and until it ends the executor can have the account
// make any calls: executeFromExecutor(calls, session) runs whatever calls it is given, checking only that the caller
// is the session's executor, that the time is within validAfter and validUntil, that the session's id isn't revoked,
// and its signature. What bounds the calls, if anything, is a hook: a contract named in the first 20 bytes of
// preHook or postHook, called with the calls before them and after.
// The account's owner signs
//   Session(address wallet,uint256 id,address executor,address validator,uint256 validUntil,uint256 validAfter,
//           bytes preHook,bytes postHook)
// under the domain { name "wallet-core", version "1.0.0", chainId, verifyingContract: the account }, `wallet` being
// the account's code (the WalletCore implementation), and `validator` who checks the signature: 0x…01 for the
// account's own key, else a validator contract the account has added. (Checked on live accounts on both chains:
// the digest computed from this typed data is what each account's getSessionTypedHash returns.)
// A session with no hook is the account's key, lent until it expires: it was previewed as an unknown format.
import { toFunctionSelector, type Hex } from 'viem';
import { formatTimestamp, PreviewBuilder, sameAddress, shortAddress } from '../format.ts';
import { chainName } from '../chains.ts';
import { big, domainChainId, str, type TypedAdapter } from './common.ts';

/** WalletCore's implementations, by chain: what an account that runs it is delegated to. */
const WALLET_CORE: Record<number, string> = { 1: '0x69e6bd1c4082403fc7917a61f6216552fc1a541d', 56: '0x64fc23203fcc4bcf09fc4b30669131333ba7936b' };
const FIELDS = 'address wallet,uint256 id,address executor,address validator,uint256 validUntil,uint256 validAfter,bytes preHook,bytes postHook';
/** The validator that stands for the account's own key (WalletCoreLib.SELF_VALIDATION_ADDRESS). */
const SELF = '0x0000000000000000000000000000000000000001';
const ADDRESS = /^0x[0-9a-fA-F]{40}$/, BYTES = /^0x([0-9a-fA-F]{2})*$/;

export const walletCoreSessionAdapter: TypedAdapter = async (data, env) => {
  if (data.primaryType !== 'Session' || data.types.Session?.map(f => `${f.type} ${f.name}`).join(',') !== FIELDS) return null;
  const m = data.message as Record<string, unknown>;
  const wallet = str(m.wallet).toLowerCase(), executor = str(m.executor).toLowerCase(), validator = str(m.validator).toLowerCase();
  const id = big(m.id), validUntil = big(m.validUntil), validAfter = big(m.validAfter), preHook = str(m.preHook) || '0x', postHook = str(m.postHook) || '0x';
  // (Anything that doesn't read is shown field by field, as any typed data is.)
  if (![wallet, executor, validator].every(a => ADDRESS.test(a)) || id === null || validUntil === null || validAfter === null || !BYTES.test(preHook) || !BYTES.test(postHook)) return null;
  const chainId = domainChainId(data) ?? env.context.chainId ?? null;
  const account = str(data.domain.verifyingContract).toLowerCase();
  const signer = env.signer?.toLowerCase() ?? null;
  const b = new PreviewBuilder();
  const known = chainId !== null && WALLET_CORE[chainId] === wallet;
  b.detail('Kind', 'a session: an executor allowed to make calls as your account (WalletCore)');
  if (ADDRESS.test(account)) b.detail('Account', account, account);
  b.detail('Executor', executor, executor);
  b.detail('Account code', known ? `WalletCore (${wallet})` : wallet, wallet);
  b.detail('Signature checked by', validator === SELF ? "the account's own key" : `the validator ${validator}`, validator);
  b.detail('Session id', id.toString());
  const now = BigInt(Math.floor(env.now / 1000));
  const ends = validUntil < 1n << 47n, from = validAfter > now ? formatTimestamp(Number(validAfter) * 1000) : 'now';
  const until = ends ? formatTimestamp(Number(validUntil) * 1000) : 'no end that will come';
  b.detail('Valid from', validAfter > 0n && validAfter < 1n << 47n ? formatTimestamp(Number(validAfter) * 1000) : validAfter === 0n ? 'now' : 'a time that will not come', validAfter.toString());
  b.detail('Valid until', until, validUntil.toString());
  // A hook is the first 20 bytes of preHook or postHook, a contract called with the calls; shorter bytes are none.
  const hookOf = (h: string) => (h.length >= 42 ? `0x${h.slice(2, 42)}`.toLowerCase() : null);
  const pre = hookOf(preHook), post = hookOf(postHook);
  if (pre) b.detail('Checked before its calls by', pre, pre);
  if (post) b.detail('Checked after its calls by', post, post);
  const who = shortAddress(executor), span = `${from === 'now' ? 'from now' : `from ${from}`} ${ends ? `until ${until}` : 'with no end'}`;
  if (!pre && !post) b.warn('danger', 'session_unrestricted', `This lets ${who} make any calls as your account, ${span}, with nothing checking what they are: it can move every token and coin in the account and approve anything. It is the account's key, lent for that time. Sign it only for an executor you would hand the key to.`);
  else b.warn('caution', 'session_hooked', `This lets ${who} make calls as your account, ${span}: any calls that ${[pre, post].filter(Boolean).map(h => shortAddress(h!)).join(' and ')} let${pre && post && pre !== post ? '' : 's'} through (a contract called ${pre && post ? 'before and after' : pre ? 'before' : 'after'} them). What it allows isn't read here.`);
  if (ends && validUntil < now) b.warn('info', 'session_expired', 'Its end has passed: the account refuses it.');
  else if (validAfter > validUntil) b.warn('info', 'session_expired', 'It ends before it starts: the account refuses it at any time.');
  else if (!ends) b.warn('caution', 'session_no_end', 'It has no end that will come: it stands until the account revokes it.');
  else if (validUntil - (validAfter > now ? validAfter : now) > 30n * 86400n) b.warn('caution', 'session_long', `It runs for ${((validUntil - (validAfter > now ? validAfter : now)) / 86400n).toString()} days.`);
  if (validator !== SELF) b.warn('caution', 'session_validator', `Its signature is checked by ${shortAddress(validator)}, a validator contract, not against the account's own key: what that contract takes as a signature isn't read here.`);
  if (str(data.domain.name) !== 'wallet-core' || str(data.domain.version) !== '1.0.0') b.warn('info', 'session_domain', `It is signed under the name "${str(data.domain.name)}" (version "${str(data.domain.version)}"); WalletCore checks sessions under "wallet-core", version "1.0.0", so an account that runs it refuses this one.`);
  if (!known) b.warn('caution', 'session_unknown_code', `${shortAddress(wallet)} isn't a WalletCore this format was read from${chainId !== null && WALLET_CORE[chainId] ? ` (on ${chainName(chainId)} that is ${shortAddress(WALLET_CORE[chainId])})` : ''}: the request is shaped like its sessions, but what code takes this signature isn't known.`);
  if (signer && ADDRESS.test(account) && validator === SELF && !sameAddress(signer, account)) b.warn('caution', 'session_other_account', `It is a session for ${shortAddress(account)}, but ${shortAddress(signer)} is asked to sign it: that account takes only its own key's signature.`);
  if (chainId !== null && env.context.chainId && chainId !== env.context.chainId) b.warn('caution', 'chain_mismatch', `The signature is for ${chainName(chainId)}, but the wallet is on ${chainName(env.context.chainId)}.`);
  if (chainId === null) b.warn('caution', 'session_chain_unknown', "Which chain it is for isn't part of what is signed, nor known to the wallet.");

  // What the chain says: the account runs that code, and the session's id isn't revoked.
  const rpc = env.deps.rpc;
  if (chainId !== null && ADDRESS.test(account) && rpc?.has(chainId)) {
    try {
      const own = String(await rpc.call(chainId, 'eth_getCode', [account, 'latest'])).toLowerCase();
      const runs = own.startsWith('0xef0100') ? `0x${own.slice(8)}` : null;
      if (own === '0x') b.warn('info', 'session_no_code', `${shortAddress(account)} runs no code now, so nothing takes this session yet. It takes effect once the account is delegated to ${shortAddress(wallet)} (EIP-7702), while the session lasts.`);
      else if (runs !== wallet) b.warn('info', 'session_other_code', `${shortAddress(account)} runs ${runs ? `other code (${shortAddress(runs)})` : 'code of its own'} now, not ${shortAddress(wallet)}: this session is for the latter, and does nothing unless the account is delegated to it while the session lasts.`);
      else {
        // The account's storage refuses a revoked id, or a validator the account hasn't added.
        const storage = String(await rpc.call(chainId, 'eth_call', [{ to: account, data: toFunctionSelector('getMainStorage()') }, 'latest']));
        const at = /^0x[0-9a-f]{64}$/i.test(storage) ? `0x${storage.slice(26)}` : null;
        const word = (v: bigint | string) => (typeof v === 'bigint' ? v.toString(16) : v.slice(2)).padStart(64, '0');
        if (at && BigInt(at) !== 0n) {
          const refused = await rpc.call(chainId, 'eth_call', [{ to: at, data: `${toFunctionSelector('validateSession(uint256,address)')}${word(id)}${word(validator)}` as Hex }, 'latest']).then(() => false, (e: { rpcError?: unknown }) => !!e?.rpcError);
          if (refused) b.warn('info', 'session_refused', `The account refuses this session as things are: its id (${id}) is revoked, or the validator isn't one the account has added.`);
        }
      }
    } catch { b.note("Whether the account runs this code and the session's id stands wasn't read."); }
  } else if (chainId !== null) b.note("Whether the account runs this code and the session's id stands wasn't checked (no RPC for this chain).");
  b.note(`An off-chain signature: it costs nothing now, and moves nothing by itself. Whoever holds it can hand it to ${who}, which can then act as the account ${ends ? `until ${until}` : 'with no end'}, as often as it likes. The account can end it sooner by revoking the session's id (${id}) in its storage, a transaction of its own.`);
  return {
    title: `Let ${who} act as ${signer && ADDRESS.test(account) && !sameAddress(signer, account) ? shortAddress(account) : 'your account'} ${ends ? `until ${until}` : 'with no end'}`,
    summary: `A WalletCore session: ${who} may make ${pre || post ? 'calls a hook contract lets through' : 'any calls'} as the account ${ADDRESS.test(account) ? shortAddress(account) : ''}, ${span}.`.replace(' ,', ','),
    decoder: 'wallet_core_session', status: known && !pre && !post && validator === SELF ? 'full' : 'partial', b,
    network: chainId !== null ? { kind: 'evm', chainId, name: chainName(chainId) } : null,
  };
};
