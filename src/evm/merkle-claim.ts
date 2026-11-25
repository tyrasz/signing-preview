// A claim from a Merkle distributor, the contract most airdrops and reward programmes pay from. Two contracts take
// the same call (the same selector, 0x2e7ba6ef) and mean different things by it:
//
//   Uniswap's merkle-distributor, and the many made after it:
//     claim(uint256 index, address account, uint256 amount, bytes32[] merkleProof)
//   pays `amount` of its one token (token()) to `account`, once: isClaimed(index) says whether it has.
//
//   A distributor of several lists ("trees"), whose amounts are running totals (verified on Sourcify at
//   0x99de5409…5302 on Ethereum, where sixteen of the eighteen claims in a sample of 40 blocks went, 2026-11-23):
//     claim(uint256 treeId, address account, uint256 cumulativeAmount, bytes32[] proof)
//   pays the tree's token (trees(treeId): token, paused, root; its NATIVE_TOKEN() stands for the coin) to `account`:
//   the total named less what the account has claimed of that tree already (claimed(treeId, account)). Read as the
//   first, a second claim of 250 would be titled "Claim 250" where it pays the 110 that are new.
//
// Either pays the account the claim names, whoever submits it. Which of the two a contract is is asked of it; one
// that answers as neither is shown as a claim whose token and amount aren't known. They were calls that couldn't be
// decoded. A claim takes no coin: one that sends some is said.
import { decodeAbiParameters, encodeAbiParameters, toFunctionSelector, type Hex } from 'viem';
import { formatUnits, PreviewBuilder, sameAddress, shortAddress } from '../format.ts';
import { CHAINS } from '../chains.ts';
import { decoded, readsAt, tokenAmount, tokenInfo, tokenSourceWarnings, type Adapter } from './common.ts';
import type { AssetChange } from '../types.ts';

const CLAIM = '0x2e7ba6ef';
const ARGS = [{ type: 'uint256' }, { type: 'address' }, { type: 'uint256' }, { type: 'bytes32[]' }] as const;
const TOKEN = toFunctionSelector('token()'), IS_CLAIMED = toFunctionSelector('isClaimed(uint256)');
const TREES = toFunctionSelector('trees(uint256)'), CLAIMED = toFunctionSelector('claimed(uint256,address)'), NATIVE_TOKEN = toFunctionSelector('NATIVE_TOKEN()');
const word = (v: bigint | string) => (typeof v === 'bigint' ? v.toString(16) : v.slice(2).toLowerCase()).padStart(64, '0');
const ADDRESS_WORD = /^0x0{24}[0-9a-f]{40}$/i;

export const merkleClaimAdapter: Adapter = async (tx, env) => {
  if (!tx.to || !tx.data.toLowerCase().startsWith(CLAIM)) return null;
  // (Only calldata that is that call exactly: bytes that re-encode to themselves.)
  let first: bigint, account: string, amount: bigint, proof: readonly Hex[];
  try {
    const rest = `0x${tx.data.slice(10)}` as Hex;
    [first, account, amount, proof] = decodeAbiParameters(ARGS, rest);
    if (encodeAbiParameters(ARGS, [first, account as Hex, amount, proof]).toLowerCase() !== rest.toLowerCase()) return null;
  } catch { return null; }
  const distributor = tx.to.toLowerCase(), to = account.toLowerCase(), mine = sameAddress(to, tx.from);
  const chain = CHAINS[tx.chainId], coin = chain?.nativeSymbol ?? 'native';
  const b = new PreviewBuilder().detail('Distributor', distributor, distributor).detail('Paid to', mine ? `you (${to})` : to, to);
  const rpc = env.deps.rpc, at = readsAt(env);
  // (A call the contract reverts is its answer: it has no such function. One the node couldn't make, for a state it
  // no longer has or at all, is no answer.)
  let unanswered = 0;
  const read = (data: string) => (rpc?.has(tx.chainId) ? rpc.call(tx.chainId, 'eth_call', [{ to: distributor, data }, at]).then(r => String(r), (e: { rpcError?: { message?: string } }) => { if (!/revert|invalid opcode|invalid jump|out of gas/i.test(e?.rpcError?.message ?? '')) unanswered++; return undefined; }) : Promise.resolve(undefined));
  const [single, isClaimed, tree, before, nativeToken] = await Promise.all([read(TOKEN), read(`${IS_CLAIMED}${word(first)}`), read(`${TREES}${word(first)}`), read(`${CLAIMED}${word(first)}${word(to)}`), read(NATIVE_TOKEN)]);
  const asked = !!rpc?.has(tx.chainId) && unanswered === 0;
  const out = (raw: bigint, token: string | null): AssetChange[] => (!mine || raw <= 0n ? [] : token === null
    ? [{ direction: 'in', account: tx.from, amount: formatUnits(raw, chain?.nativeDecimals ?? 18), symbol: coin, raw: raw.toString(), asset: 'native', basis: 'requested', standard: 'native' }]
    : [{ direction: 'in', account: tx.from, amount: raw.toString(), symbol: token, raw: raw.toString(), asset: token, basis: 'requested' }]);
  const forWhom = mine ? '' : ` for ${shortAddress(to)}`;
  const shared = () => {
    if (!mine) b.warn('info', 'recipient_not_sender', `The claim is ${shortAddress(to)}'s, and is paid to that address, not to you: a distributor pays the account a claim names, whoever submits it. You would pay the fee.`);
    if (tx.value > 0n) b.warn('caution', 'claim_sends_coin', `This sends ${formatUnits(tx.value, chain?.nativeDecimals ?? 18)} ${coin} with the claim. A distributor's claim takes none: a contract that asks for coin to claim isn't one paying out.`);
    b.note("The distributor checks the proof against its list: a claim that isn't on it, or for another amount, reverts.");
  };

  // A distributor of several trees, its amounts running totals.
  if (tree && /^0x[0-9a-f]{192}$/i.test(tree) && ADDRESS_WORD.test(tree.slice(0, 66)) && /^0{63}[01]$/.test(tree.slice(66, 130)) && before && /^0x[0-9a-f]{64}$/i.test(before)) {
    const token = `0x${tree.slice(26, 66)}`.toLowerCase(), paused = tree.slice(129, 130) === '1', had = BigInt(before), pays = amount - had;
    // A tree the distributor doesn't have answers with nothing: no token, no root. (Not one whose token is the
    // address the distributor names for the coin, should that be the zero address: it has a root.)
    const unset = /^0x0{40}$/.test(token) && /^0{64}$/.test(tree.slice(130, 194));
    const native = !unset && !!nativeToken && ADDRESS_WORD.test(nativeToken) && `0x${nativeToken.slice(26)}`.toLowerCase() === token;
    const missing = /^0x0{40}$/.test(token) && !native;
    const info = native || missing ? undefined : await tokenInfo(env, tx.chainId, token);
    // (The token is whatever the contract called says it pays: one that names itself as a known token isn't it.)
    tokenSourceWarnings(b, tx.chainId, info);
    const show = (raw: bigint) => (native ? `${formatUnits(raw, chain?.nativeDecimals ?? 18)} ${coin}` : tokenAmount(raw, info, token));
    b.detail('List', `tree ${first}`).detail('Token', native ? coin : info ? `${info.symbol} (${token})` : token, native ? 'native' : token);
    b.detail('Total claimable', show(amount), amount.toString()).detail('Claimed before', show(had), had.toString()).detail('Pays now', pays > 0n ? show(pays) : 'nothing', (pays > 0n ? pays : 0n).toString());
    if (missing) b.warn('caution', 'claim_no_such_list', `The distributor has no tree ${first}: the claim reverts.`);
    else if (pays <= 0n) b.warn('caution', 'claim_already_made', `${mine ? 'You have' : `${shortAddress(to)} has`} already claimed ${show(had)} of tree ${first}, and this claim's total is ${show(amount)}: nothing is left to pay, and it reverts.`);
    if (paused) b.warn('caution', 'claim_paused', `Tree ${first} is paused on the distributor: the claim reverts until it is resumed.`);
    shared();
    const changes = out(pays, native ? null : token).map(c => (native || !info ? c : { ...c, amount: formatUnits(pays, info.decimals), symbol: info.symbol }));
    return decoded({
      title: missing ? `Claim from a distributor${forWhom}: it has no such list` : pays > 0n ? `Claim ${show(pays)}${forWhom} from a distributor` : `Claim from a distributor${forWhom}: nothing left to pay`,
      summary: missing ? `Claims from tree ${first} of the distributor ${shortAddress(distributor)}, which it doesn't have.` : `Claims from tree ${first} of the distributor ${shortAddress(distributor)}: its total for ${mine ? 'you' : to} is ${show(amount)}, of which ${show(had)} is claimed already.`,
      decoder: 'merkle_claim', status: 'full', b, assetChanges: paused || missing ? [] : changes, ...(!native && !missing && { watch: [token] }),
    });
  }

  // Uniswap's: one token, each claim made once.
  if (single && ADDRESS_WORD.test(single) && !/^0x0{64}$/.test(single) && isClaimed && /^0x0{63}[01]$/.test(isClaimed)) {
    const token = `0x${single.slice(26)}`.toLowerCase(), claimed = isClaimed.endsWith('1'), info = await tokenInfo(env, tx.chainId, token), what = tokenAmount(amount, info, token);
    tokenSourceWarnings(b, tx.chainId, info);
    b.detail('Claim index', first.toString()).detail('Token', info ? `${info.symbol} (${token})` : token, token).detail('Amount', what, amount.toString());
    if (claimed) b.warn('caution', 'claim_already_made', `The distributor says claim ${first} is already made: it pays a claim once, and this one reverts.`);
    shared();
    const changes = claimed ? [] : out(amount, token).map(c => (info ? { ...c, amount: formatUnits(amount, info.decimals), symbol: info.symbol } : c));
    return decoded({ title: `Claim ${what}${forWhom} from a Merkle distributor`, summary: `Claims ${what} from the distributor ${shortAddress(distributor)}, paid to ${mine ? 'you' : to}.`, decoder: 'merkle_claim', status: 'full', b, assetChanges: changes, watch: [token] });
  }

  // Neither, or not asked: the call is a distributor's claim, but which token it pays and how much isn't known.
  b.detail('First argument', `${first} (a claim's index, or the list it is on)`).detail('Amount named', `${amount} base units (of a token that isn't read; on some distributors a running total, of which only what is new is paid)`, amount.toString());
  b.warn('caution', 'claim_unread', asked
    ? "The contract answers neither as a single-token Merkle distributor nor as one of several lists: what this claim pays, and in which token, isn't known from here. It may not be a distributor at all."
    : `Which token the distributor pays, and whether the amount is all of it or a running total, wasn't read (${rpc?.has(tx.chainId) ? "the chain's node didn't answer for that state" : 'no RPC for this chain'}).`);
  shared();
  return decoded({ title: `Claim from a distributor${forWhom} (${shortAddress(distributor)})`, summary: `A distributor's claim call on ${shortAddress(distributor)}, paid to ${mine ? 'you' : to}: its token and amount aren't read.`, decoder: 'merkle_claim', status: 'partial', b });
};
