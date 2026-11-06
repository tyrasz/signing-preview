// Relay (relay.link), a bridge and cross-chain swap: the user deposits into the RelayDepository against a request ID
// from Relay's quote, and Relay's solver fills the request on the destination chain. The destination, recipient and
// amount are in that quote, off-chain; the transaction only carries the deposit and the ID. Funds leave the
// depository through execute(), calls signed by Relay's allocator (refunds and payouts), which anyone can submit.
// Source: RelayDepository, verified on Sourcify (src/RelayDepository.sol, src/utils/RelayDepositoryStructs.sol).
import { decodeFunctionData, parseAbi, type Hex } from 'viem';
import { formatTimestamp, formatUnits, PreviewBuilder, sameAddress, shortAddress } from '../format.ts';
import { CHAINS } from '../chains.ts';
import type { AssetChange } from '../types.ts';
import { decoded, nativeAmount, tokenAmount, tokenInfo, type Adapter, type Decoded } from './common.ts';
import { decodeTransaction } from './transaction.ts';

/** The same contract (17,258 bytes of code) on Ethereum, Arbitrum One and HyperEVM. */
export const RELAY_DEPOSITORY = '0x4cd00e387622c35bddb9b4c962c136462338bc31';
const ABI = parseAbi([
  'function depositNative(address depositor, bytes32 id) payable',
  'function depositErc20(address depositor, address token, uint256 amount, bytes32 id)',
  'function depositErc20(address depositor, address token, bytes32 id)',
  'function execute(((address to, bytes data, uint256 value, bool allowFailure)[] calls, uint256 nonce, uint256 expiration) request, bytes signature) returns ((bool success, bytes returnData)[])',
]);
const MAX_CALLS = 10;
const QUOTE_NOTE = "Relay's solver delivers what your quote promised (destination chain, recipient and amount) once this deposit lands. Those terms are in Relay's quote, matched by the request ID, not in this transaction: check them in the app before signing.";

export const relayAdapter: Adapter = async (tx, env) => {
  if (!tx.to || tx.to.toLowerCase() !== RELAY_DEPOSITORY) return null;
  let call;
  try { call = decodeFunctionData({ abi: ABI, data: tx.data }); } catch { return null; }
  const b = new PreviewBuilder().detail('Contract', `Relay depository (${RELAY_DEPOSITORY})`, RELAY_DEPOSITORY);
  // A zero depositor credits the sender; another address is credited (and refunded) instead.
  const credit = (depositor: string) => {
    const who = /^0x0{40}$/.test(depositor) || sameAddress(depositor, tx.from) ? null : depositor.toLowerCase();
    b.detail('Credited to', who ?? `you (${tx.from})`, who ?? tx.from);
    if (who) b.warn('caution', 'relay_credit_other', `The deposit is credited to ${shortAddress(who)}, not to you: if Relay refunds it, the refund goes to that address.`);
  };

  if (call.functionName === 'depositNative') {
    const [depositor, id] = call.args;
    const what = nativeAmount(tx.chainId, tx.value);
    b.detail('You deposit', what).detail('Relay request', id, id);
    credit(depositor);
    b.note(QUOTE_NOTE);
    const chain = CHAINS[tx.chainId];
    return decoded({ title: `Deposit ${what} to Relay`, summary: `Deposits ${what} into Relay's depository for request ${shortAddress(id)}, to be filled by Relay's solver.`, decoder: 'relay_deposit', status: 'full', b,
      assetChanges: tx.value > 0n ? [{ direction: 'out', account: tx.from, amount: formatUnits(tx.value, chain?.nativeDecimals ?? 18), symbol: chain?.nativeSymbol ?? 'ETH', raw: tx.value.toString(), asset: 'native', basis: 'requested', standard: 'native' }] : [] });
  }

  if (call.functionName === 'depositErc20') {
    const [depositor, token] = call.args;
    const id = (call.args.length === 4 ? call.args[3] : call.args[2]) as Hex;
    const info = await tokenInfo(env, tx.chainId, token);
    let amount: bigint | null = call.args.length === 4 ? call.args[2] as bigint : null;
    // The three-argument form deposits the whole allowance the sender gave the depository.
    if (amount === null && env.deps.rpc?.has(tx.chainId)) {
      try { amount = BigInt(String(await env.deps.rpc.call(tx.chainId, 'eth_call', [{ to: token, data: `0xdd62ed3e${tx.from.slice(2).padStart(64, '0')}${RELAY_DEPOSITORY.slice(2).padStart(64, '0')}` }, 'latest']))); } catch { amount = null; }
    }
    const what = amount !== null ? tokenAmount(amount, info, token) : `your whole ${info?.symbol ?? shortAddress(token)} allowance to the depository`;
    b.detail('You deposit', what, token).detail('Relay request', id, id);
    if (call.args.length === 3) b.note(`This form deposits the whole allowance you have given Relay's depository${amount !== null ? ` (${what} now)` : ''}.`);
    credit(depositor);
    b.note(QUOTE_NOTE);
    return decoded({
      title: `Deposit ${what} to Relay`, summary: `Deposits ${what} into Relay's depository for request ${shortAddress(id)}, to be filled by Relay's solver.`, decoder: 'relay_deposit', status: info ? 'full' : 'partial', b,
      assetChanges: info && amount !== null ? [{ direction: 'out', account: tx.from, amount: formatUnits(amount, info.decimals), symbol: info.symbol, raw: amount.toString(), asset: token.toLowerCase(), basis: 'requested', standard: 'erc20' }] : [],
    });
  }

  // execute: the allocator's signed calls, run from the depository (its funds, not the sender's).
  const [request] = call.args;
  const calls = request.calls;
  const inner: Decoded[] = [], titles: string[] = [];
  const assetChanges: AssetChange[] = [];
  for (const [i, c] of calls.slice(0, MAX_CALLS).entries()) {
    const d = await decodeTransaction({ chainId: tx.chainId, from: RELAY_DEPOSITORY, to: c.to.toLowerCase(), data: c.data, value: c.value }, env.deps, env.context);
    inner.push(d);
    // A transfer's recipient: "to you" when the payout comes to the sender, whose balance then goes up.
    const recipient = d.b.details.find(x => x.label === 'Recipient')?.value;
    const mine = !!recipient && sameAddress(recipient, tx.from);
    const title = `${d.title}${recipient ? ` to ${mine ? 'you' : shortAddress(recipient)}` : ''}`;
    titles.push(title);
    if (mine) for (const a of d.assetChanges) assetChanges.push({ ...a, direction: 'in', account: tx.from });
    b.detail(calls.length > 1 ? `Call ${i + 1}` : 'Call', `${title}${c.value > 0n && !/^Send /.test(d.title) ? `, with ${nativeAmount(tx.chainId, c.value)}` : ''}${c.allowFailure ? ' (allowed to fail)' : ''}`, recipient ?? c.to.toLowerCase());
  }
  if (calls.length > MAX_CALLS) b.detail('More calls', String(calls.length - MAX_CALLS));
  b.detail('Signed by', "Relay's allocator").detail('Valid until', formatTimestamp(Number(request.expiration) * 1000));
  if (Number(request.expiration) * 1000 < (env.context.now ?? Date.now())) b.warn('info', 'relay_request_expired', 'This signed request has expired, so the depository will reject it.');
  b.note("These calls were signed by Relay's allocator and run from Relay's depository, with its funds: a refund or payout, which anyone may submit. Nothing leaves your wallet but gas.");
  return decoded({
    title: calls.length === 1 ? `Relay payout: ${titles[0]}` : `Relay payout: ${calls.length} calls from the depository`,
    summary: `Submits a request signed by Relay's allocator: the depository ${titles.slice(0, 3).join('; ')}${calls.length > 3 ? '; …' : ''}.`,
    decoder: 'relay_execute', status: inner.some(d => d.status !== 'full') ? 'partial' : 'full', b, assetChanges,
  });
};
