// Transactions that submit an EIP-3009 authorization to a token (USDC's FiatToken, and others with the same
// functions): transferWithAuthorization moves `value` from `from` to `to` on `from`'s signature, whoever sends it (x402
// payment facilitators and gasless-transfer relayers do); receiveWithAuthorization does the same but only when sent by
// `to` (FiatToken: "caller must be the payee"); cancelAuthorization voids an unused one. Each takes the signature as
// (v, r, s) or, from FiatToken v2.2, as bytes (which also takes a smart account's ERC-1271 signature). The token refuses
// one outside its window (validAfter < now < validBefore) or whose nonce was used or cancelled (authorizationState).
import { decodeFunctionData, parseAbi } from 'viem';
import { formatTimestamp, formatUnits, PreviewBuilder, sameAddress, shortAddress } from '../format.ts';
import { decoded, readsAt, tokenAmount, tokenInfo, tokenSourceWarnings, type Adapter } from './common.ts';

const ABI = parseAbi([
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)',
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)',
  'function receiveWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)',
  'function receiveWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)',
  'function cancelAuthorization(address authorizer, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)',
  'function cancelAuthorization(address authorizer, bytes32 nonce, bytes signature)',
]);
const SELECTORS = ['0xe3ee160e', '0xcf092995', '0xef55bec6', '0x88b7ab63', '0x5a049a70', '0xb7b72899'];

export const eip3009TxAdapter: Adapter = async (tx, env) => {
  if (!tx.to || !SELECTORS.includes(tx.data.slice(0, 10))) return null;
  let call;
  try { call = decodeFunctionData({ abi: ABI, data: tx.data }); } catch { return null; }
  const token = tx.to.toLowerCase();
  const info = await tokenInfo(env, tx.chainId, token);
  const b = new PreviewBuilder().detail('Token contract', info ? `${info.symbol} (${token})` : token, token);
  tokenSourceWarnings(b, tx.chainId, info);
  if (!info) b.warn('caution', 'unknown_token', 'This token is not in the known-token list, so its name and decimals are unverified. Amounts are shown in base units.');
  const status = info ? 'full' : 'partial';
  // State and time as of the block it runs after: a replay's own block, else now (a past block's state would also
  // show its nonce unused, but only a replay names its time, so a past block alone skips the reads).
  const replay = env.context.replay;
  const now = Math.floor(replay ? Number(replay.at.header.timestamp) * 1000 : env.context.now ?? Date.now());
  const readable = env.deps.rpc?.has(tx.chainId) && !replay && env.context.block === undefined;
  /** Whether the nonce is used or cancelled already (authorizationState); undefined when not read. */
  const used = async (authorizer: string, nonce: string) => {
    if (!readable) return undefined;
    try {
      const r = String(await env.deps.rpc!.call(tx.chainId, 'eth_call', [{ to: token, data: `0xe94a0102${authorizer.slice(2).toLowerCase().padStart(64, '0')}${nonce.slice(2)}` }, readsAt(env)]));
      return /^0x0{63}[01]$/.test(r) ? r.endsWith('1') : undefined;
    } catch { return undefined; }
  };

  if (call.functionName === 'cancelAuthorization') {
    const [authorizer, nonce] = call.args;
    b.detail('Authorizer', authorizer).detail('Nonce', nonce);
    if (await used(authorizer, nonce)) b.warn('info', 'eip3009_nonce_used', 'This authorization was already used or cancelled: the token refuses the cancellation.');
    const own = sameAddress(authorizer, tx.from);
    return decoded({ title: `Cancel ${own ? 'your' : `${shortAddress(authorizer)}'s`} ${info?.symbol ?? 'token'} transfer authorization`, summary: `Voids a signed transfer authorization of ${own ? 'yours' : shortAddress(authorizer)} (nonce ${nonce.slice(0, 10)}…) before it is used.`, decoder: 'eip3009_cancel', status, b });
  }

  const [from, to, value, validAfter, validBefore, nonce] = call.args;
  const amount = tokenAmount(value, info, token);
  const receive = call.functionName === 'receiveWithAuthorization';
  b.detail('From', from).detail('To', to).detail('Amount', amount, value.toString())
    .detail('Valid', `${formatTimestamp(Number(validAfter) * 1000)} → ${validBefore >= 1n << 47n ? 'never expires' : formatTimestamp(Number(validBefore) * 1000)}`, `${validAfter}..${validBefore}`)
    .detail('Nonce', nonce);
  if (BigInt(now) / 1000n <= validAfter) b.warn('info', 'eip3009_not_yet_valid', `The authorization isn't valid until ${formatTimestamp(Number(validAfter) * 1000)}: the token refuses it before then.`);
  if (BigInt(now) / 1000n >= validBefore) b.warn('info', 'eip3009_expired', 'The authorization has expired: the token refuses it.');
  if (receive && !sameAddress(to, tx.from)) b.warn('info', 'eip3009_not_payee', `Only the payee (${shortAddress(to)}) can submit a receiveWithAuthorization: sent from ${shortAddress(tx.from)}, the token refuses it.`);
  if (await used(from, nonce)) b.warn('info', 'eip3009_nonce_used', 'This authorization was already used or cancelled: the token refuses it.');
  if (sameAddress(to, token)) b.warn('danger', 'transfer_to_token_contract', 'The recipient is the token contract itself. Tokens sent there are usually lost.');
  const yours = sameAddress(from, tx.from), toYou = sameAddress(to, tx.from);
  if (!yours) b.note(`It moves ${shortAddress(from)}'s tokens on ${shortAddress(from)}'s signature; you pay only the network fee${toYou ? ' and receive the tokens' : ''}.`);
  const change = (direction: 'out' | 'in', account: string) => ({ direction, account, amount: info ? formatUnits(value, info.decimals) : value.toString(), symbol: info?.symbol ?? token, raw: value.toString(), asset: token, basis: 'requested' as const });
  return decoded({
    title: yours ? `Send ${amount} to ${shortAddress(to)} with a signed authorization` : toYou ? `Receive ${amount} from ${shortAddress(from)} with their signed authorization` : `Submit ${shortAddress(from)}'s signed transfer of ${amount} to ${shortAddress(to)}`,
    summary: `Submits an EIP-3009 ${receive ? 'receiveWithAuthorization' : 'transferWithAuthorization'}: ${amount} moves from ${yours ? 'you' : shortAddress(from)} to ${toYou ? 'you' : shortAddress(to)}, as ${yours ? 'you' : shortAddress(from)} signed.`,
    decoder: receive ? 'eip3009_receive' : 'eip3009_transfer', status, b,
    assetChanges: yours ? [change('out', from)] : toYou ? [change('in', to)] : [],
  });
};
