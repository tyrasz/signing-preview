// Relay (relay.link), a bridge and cross-chain swap: the user deposits into the RelayDepository against a request ID
// from Relay's quote, and Relay's solver fills the request on the destination chain. The destination, recipient and
// amount are in that quote, off-chain; the transaction only carries the deposit and the ID. Funds leave the
// depository through execute(), calls signed by Relay's allocator (refunds and payouts), which anyone can submit.
// Source: RelayDepository, verified on Sourcify (src/RelayDepository.sol, src/utils/RelayDepositoryStructs.sol).
import { decodeFunctionData, parseAbi, type Hex } from 'viem';
import { formatTimestamp, formatUnits, PreviewBuilder, sameAddress, shortAddress } from '../format.ts';
import { CHAINS } from '../chains.ts';
import type { AssetChange } from '../types.ts';
import { decoded, nativeAmount, tokenAmount, tokenInfo, type Adapter, type AdapterEnv, type Decoded } from './common.ts';
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
  // (Calls inside calls are read two levels deep, as in relayCalls: their slots can all point at the same bytes.)
  const depth = (env.context as { relayDepth?: number }).relayDepth ?? 0;
  for (const [i, c] of calls.slice(0, MAX_CALLS).entries()) {
    if (depth >= 2) { b.detail(calls.length > 1 ? `Call ${i + 1}` : 'Call', `a call to ${shortAddress(c.to)}, not read (nested too deep)`, c.to.toLowerCase()); continue; }
    const d = await decodeTransaction({ chainId: tx.chainId, from: RELAY_DEPOSITORY, to: c.to.toLowerCase(), data: c.data, value: c.value }, env.deps, { ...env.context, relayDepth: depth + 1 } as AdapterEnv['context']);
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

// Relay's approval proxy (RelayApprovalProxy 3.1, verified on Sourcify; the same address and code on every chain
// here): transferAndMulticall pulls the sender's tokens into Relay's router, which makes the calls given and sends
// what is left to refundTo; permit2TransferAndMulticall does it on the user's Permit2 signature (with a witness of
// the same calls), submitted by the relayer named in it. The router's own calls: RouteRacer's race (a swap over
// several candidate routes, the best taken, its output at least a minimum, to a recipient) and RelayRouter's
// cleanups (each token, or the native coin, sent on to a recipient: an amount of 0 is all the router holds).
export const RELAY_APPROVAL_PROXY = '0x5567954cd026cebfe486062cb75848e0f1c12e58';
const CALL3 = '(address target, bool allowFailure, uint256 value, bytes callData)[] calls';
const PROXY_ABI = parseAbi([
  `function transferAndMulticall(address[] tokens, uint256[] amounts, ${CALL3}, address refundTo, address nftRecipient, bytes metadata) payable`,
  `function permit2TransferAndMulticall(address user, ((address token, uint256 amount)[] permitted, uint256 nonce, uint256 deadline) permit, ${CALL3}, address refundTo, address nftRecipient, bytes metadata, bytes permitSignature) payable`,
]);
const ROUTER_ABI = parseAbi([
  'function cleanupErc20s(address[] tokens, address[] recipients, uint256[] amounts, bytes metadata)',
  'function cleanupNative(uint256 amount, address recipient, bytes metadata)',
  'function race(address tokenIn, uint256 amountIn, address tokenOut, uint256 minAmountOut, address recipient, address refundTo, (address target, address spender, uint256 value, uint256 gasLimit, uint256 feePpm, bytes callData)[] routes, bool emitEvents, bytes metadata) payable',
  'function raceWithBackups(address tokenIn, uint256 amountIn, address tokenOut, uint256 minAmountOut, address recipient, address refundTo, (address target, address spender, uint256 value, uint256 gasLimit, uint256 feePpm, bytes callData)[] routes, uint256 mainCount, bool emitEvents, bytes metadata) payable',
]);
const CLEANUP_SELECTORS = ['0x9bb43718', '0xa6bd8c96'], RACE_SELECTORS = ['0xdbd33919', '0xbda3361c'];
/** Relay's router (RelayRouter, RelayRouterV3) and RouteRacer: the same addresses and code on every chain here. */
const RELAY_ROUTERS = new Set(['0x0729e2a4716d9f7dd17858d5d504426d228697f7', '0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f']);
const ROUTE_RACER = '0x195627f03fe2668d65c763cd39eec45b1d76c8ee';
/** Relay's own contracts: value sent to them stays within the request. */
const RELAY_CONTRACTS = new Set([...RELAY_ROUTERS, ROUTE_RACER, RELAY_APPROVAL_PROXY, RELAY_DEPOSITORY]);
/** An amount as typed data or calldata gives it: a bigint, a safe integer, or a decimal or hex string; null otherwise. */
const quantity = (v: unknown): bigint | null => typeof v === 'bigint' ? v : typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? BigInt(v)
  : typeof v === 'string' && /^(\d+|0x[0-9a-fA-F]+)$/.test(v) ? BigInt(v) : v === undefined ? 0n : null;
const RELAY_CALLS = 12;

/**
 * The calls Relay's router makes for an account (a proxy request, signed or sent), read into `b`: who submits it,
 * where leftovers go, each call decoded as the account's own, with what its decoding warns of. Returns the calls'
 * titles, or null when the request doesn't read.
 */
export async function relayCalls(w: { relayer?: unknown; refundTo?: unknown; nftRecipient?: unknown; msgValue?: unknown }, calls: unknown, env: AdapterEnv, chainId: number | null, account: string, b: PreviewBuilder, spender: string): Promise<string[] | null> {
  if (!Array.isArray(calls)) return null;
  const text = (v: unknown) => typeof v === 'string' ? v.toLowerCase() : '';
  const refundTo = text(w.refundTo), relayer = text(w.relayer), nftRecipient = text(w.nftRecipient);
  if (!/^0x[0-9a-f]{40}$/.test(refundTo)) return null;
  // A Relay request inside another's calls is read two levels deep, no more (each level reads up to RELAY_CALLS calls).
  const depth = (env.context as { relayDepth?: number }).relayDepth ?? 0;
  if (relayer) b.detail('Relayer (only it can submit this)', relayer);
  b.detail('Leftovers go to', sameAddress(refundTo, account) ? `you (${refundTo})` : refundTo, refundTo);
  const ours = (a: string) => sameAddress(a, account) || sameAddress(a, refundTo) || RELAY_CONTRACTS.has(a.toLowerCase());
  if (/^0x[0-9a-f]{40}$/.test(nftRecipient) && !/^0x0{40}$/.test(nftRecipient)) {
    b.detail('NFTs minted go to', nftRecipient);
    if (!ours(nftRecipient)) b.warn('caution', 'relay_nft_recipient', `NFTs the calls mint go to ${shortAddress(nftRecipient)}, not to you.`);
  }
  const msgValue = quantity(w.msgValue) ?? 0n;
  if (msgValue > 0n && chainId !== null) b.detail('Coin the relayer attaches', nativeAmount(chainId, msgValue), msgValue.toString());
  if (!sameAddress(spender, RELAY_APPROVAL_PROXY)) b.warn('caution', 'relay_proxy_unknown', `The tokens go to ${shortAddress(spender)}, which isn't Relay's approval proxy (${shortAddress(RELAY_APPROVAL_PROXY)}): whether it makes the calls below, and only those, isn't known.`);
  if (!sameAddress(refundTo, account)) b.warn('caution', 'relay_refund_other', `What the calls leave in Relay's router (your tokens and coin, or what a swap gives) goes to ${shortAddress(refundTo)}, not to you.`);
  const titles: string[] = [];
  for (const [i, raw] of calls.entries()) {
    if (i >= RELAY_CALLS) break;
    const c = (raw ?? {}) as Record<string, unknown>;
    const target = text(c.target), data = text(c.callData);
    const value = quantity(c.value);
    if (value === null) b.warn('caution', 'relay_value_unread', `Call ${i + 1}'s value (${JSON.stringify(c.value)}) doesn't read as an amount: what it sends isn't known.`);
    if (!/^0x[0-9a-f]{40}$/.test(target) || !/^0x([0-9a-f]{2})*$/.test(data)) { titles.push('a call that doesn\'t read'); b.warn('caution', 'relay_call_unread', `Call ${i + 1} doesn't read (its target or data isn't hex): what it does isn't known.`); continue; }
    if (depth >= 2) { titles.push(`a call to ${shortAddress(target)}`); b.warn('caution', 'relay_call_unread', `Call ${i + 1} is in a Relay request nested inside two others, which isn't read: what it does isn't known.`); continue; }
    try {
      const d = await decodeTransaction({ chainId: chainId ?? 1, from: account, to: target, data: data as Hex, value: value ?? 0n }, env.deps, { ...env.context, ...(chainId !== null && { chainId }), relayDepth: depth + 1 } as AdapterEnv['context']);
      titles.push(d.title);
      b.detail(`Call ${i + 1}`, `${d.title} (${shortAddress(target)})${c.allowFailure === true ? ', may fail' : ''}`, target);
      for (const x of d.b.warnings) if (x.severity !== 'info') b.warn(x.severity, x.code, `Call ${i + 1}: ${x.message}`);
      // A router paying someone along the way (the Universal Router's TRANSFER, SWEEP, PAY_PORTION): said as a caution here.
      for (const x of d.b.warnings) if (x.code === 'router_payment') b.warn('caution', 'relay_call_recipient', `Call ${i + 1}: ${x.message}`);
      // Where the call sends value: a transfer's recipient, a cleanup's, a swap's output and leftovers. One that isn't
      // you, your refund address or Relay's own contracts is said: a request that pays someone else.
      const to = new Set<string>();
      for (const x of d.b.details) {
        const a = (x.raw ?? x.value).toLowerCase();
        if (!/^0x[0-9a-f]{40}$/.test(a)) continue;
        if ((x.label === 'Recipient' && ['erc20_transfer', 'erc20_transfer_from', 'native_transfer', 'calldata_text'].includes(d.decoder)) || (d.decoder === 'relay_router_cleanup' && /^Sends/.test(x.label)) || (d.decoder === 'relay_route_racer' && /^(Output to|Leftovers to)$/.test(x.label))) to.add(a);
      }
      // Coin sent with a call the target keeps (a plain transfer, a message, a call that doesn't read) is paid to it.
      if ((value ?? 0n) > 0n && ['native_transfer', 'calldata_text', 'unknown'].includes(d.decoder)) to.add(target);
      for (const a of to) if (!ours(a)) b.warn('caution', 'relay_call_recipient', `Call ${i + 1} (${d.title.replace(/ \(Relay's (router|RouteRacer)\)$/, '')}) pays ${shortAddress(a)}, not you or your refund address: check it is who you mean to pay.`);
    } catch { titles.push(`a call to ${shortAddress(target)}`); b.warn('caution', 'relay_call_unread', `Call ${i + 1} couldn't be read: what it does isn't known.`); }
  }
  if (calls.length > RELAY_CALLS) b.warn('danger', 'relay_calls_unread', `It has ${calls.length} calls; the ${calls.length - RELAY_CALLS} after the first ${RELAY_CALLS} aren't read here, and any of them could send your tokens elsewhere.`);
  if (!calls.length) b.warn('caution', 'relay_no_calls', `It has no calls: the tokens go to Relay's router and on to ${sameAddress(refundTo, account) ? 'you' : shortAddress(refundTo)}.`);
  return titles;
}

/** Transactions to Relay's approval proxy: a request sent by the account itself, or a signed one submitted. */
export const relayProxyAdapter: Adapter = async (tx, env) => {
  if (!tx.to || !sameAddress(tx.to, RELAY_APPROVAL_PROXY)) return null;
  let call;
  try { call = decodeFunctionData({ abi: PROXY_ABI, data: tx.data }); } catch { return null; }
  const b = new PreviewBuilder().detail('Contract', `Relay's approval proxy (${RELAY_APPROVAL_PROXY})`, RELAY_APPROVAL_PROXY);
  const moved: string[] = [], assetChanges: AssetChange[] = [];
  const pulled = async (token: string, amount: bigint, account: string) => {
    const info = await tokenInfo(env, tx.chainId, token);
    moved.push(tokenAmount(amount, info, token));
    if (info) assetChanges.push({ direction: 'out', account, amount: formatUnits(amount, info.decimals), symbol: info.symbol, raw: amount.toString(), asset: token.toLowerCase(), basis: 'requested' });
  };
  let account = tx.from.toLowerCase(), calls: unknown, refundTo: string, nftRecipient: string;
  if (call.functionName === 'transferAndMulticall') {
    const [tokens, amounts, c, r, n] = call.args;
    if (tokens.length !== amounts.length) return null;
    for (const [i, t] of tokens.entries()) await pulled(t, amounts[i], account);
    [calls, refundTo, nftRecipient] = [c, r, n];
  } else {
    const [user, permit, c, r, n] = call.args;
    account = user.toLowerCase();
    for (const p of permit.permitted) await pulled(p.token, p.amount, account);
    [calls, refundTo, nftRecipient] = [c, r, n];
    if (!sameAddress(account, tx.from)) b.note(`It submits ${shortAddress(account)}'s signed Relay request: the tokens are theirs, pulled by Permit2; you pay only the network fee.`);
  }
  if (moved.length) b.detail('Into Relay\'s router', moved.join(', '));
  if (tx.value > 0n) b.detail('Coin sent with it', nativeAmount(tx.chainId, tx.value), tx.value.toString());
  const titles = await relayCalls({ refundTo, nftRecipient }, calls, env, tx.chainId, account, b, RELAY_APPROVAL_PROXY);
  if (!titles) return null;
  const own = sameAddress(account, tx.from);
  const what = [...moved, ...(tx.value > 0n ? [nativeAmount(tx.chainId, tx.value)] : [])].join(', ') || 'nothing';
  return decoded({
    title: `${own ? '' : `Submit ${shortAddress(account)}'s request: `}Relay: move ${what} into its router for ${titles.length === 1 ? 'a call' : `${titles.length} calls`}: ${titles.slice(0, 3).join('; ')}${titles.length > 3 ? '; …' : ''}`,
    summary: `A Relay request: ${what} goes to Relay's router, which makes the ${titles.length} call${titles.length === 1 ? '' : 's'} for ${own ? 'you' : shortAddress(account)} and sends what is left to ${shortAddress(refundTo)}.`,
    decoder: 'relay_proxy', status: 'full', b, assetChanges: own ? assetChanges : [],
  });
};

/** Relay's router's own calls, as a request's calls name them: a RouteRacer swap, a cleanup sending tokens on. */
export const relayRouterAdapter: Adapter = async (tx, env) => {
  // Only Relay's own router and RouteRacer: another contract with these selectors could do anything.
  const selector = tx.data.slice(0, 10), to = tx.to?.toLowerCase() ?? '';
  if (!(CLEANUP_SELECTORS.includes(selector) && RELAY_ROUTERS.has(to)) && !(RACE_SELECTORS.includes(selector) && to === ROUTE_RACER)) return null;
  let call;
  try { call = decodeFunctionData({ abi: ROUTER_ABI, data: tx.data }); } catch { return null; }
  const b = new PreviewBuilder().detail('Contract', to === ROUTE_RACER ? `Relay's RouteRacer (${to})` : `Relay's router (${to})`, to);
  const amountOf = async (token: string, raw: bigint, all: string) => {
    if (/^0x0{40}$/.test(token)) return raw === 0n ? all : nativeAmount(tx.chainId, raw);
    const info = await tokenInfo(env, tx.chainId, token);
    return raw === 0n ? `${all} of ${info?.symbol ?? shortAddress(token)}` : tokenAmount(raw, info, token);
  };
  if (call.functionName === 'cleanupErc20s') {
    const [tokens, recipients, amounts] = call.args;
    if (tokens.length !== recipients.length || tokens.length !== amounts.length) return null;
    const parts: string[] = [];
    for (const [i, t] of tokens.entries()) {
      const what = await amountOf(t, amounts[i], 'all the router holds');
      parts.push(`${what} to ${sameAddress(recipients[i], tx.from) ? 'you' : shortAddress(recipients[i])}`);
      b.detail(`Sends ${i + 1}`, `${what} to ${recipients[i].toLowerCase()}`, recipients[i].toLowerCase());
    }
    return decoded({ title: `Send ${parts.join(', ') || 'nothing'} (Relay's router)`, summary: `Relay's router sends ${parts.join(', ')} on.`, decoder: 'relay_router_cleanup', status: 'full', b });
  }
  if (call.functionName === 'cleanupNative') {
    const [amount, recipient] = call.args;
    const to = /^0x0{40}$/.test(recipient) ? 'its caller' : sameAddress(recipient, tx.from) ? 'you' : shortAddress(recipient);
    const what = amount === 0n ? `all the ${CHAINS[tx.chainId]?.nativeSymbol ?? 'coin'} the router holds` : nativeAmount(tx.chainId, amount);
    b.detail('Sends', `${what} to ${recipient.toLowerCase()}`, recipient.toLowerCase());
    return decoded({ title: `Send ${what} to ${to} (Relay's router)`, summary: `Relay's router sends ${what} on.`, decoder: 'relay_router_cleanup', status: 'full', b });
  }
  const [tokenIn, amountIn, tokenOut, minOut, recipient, refundTo, routes] = call.args;
  if (minOut === 0n) b.warn('info', 'relay_race_no_minimum', 'It sets no minimum output: RouteRacer refuses that (its guard against a route keeping the tokens), so this call fails.');
  const give = await amountOf(tokenIn, amountIn, 'all it is given'), least = await amountOf(tokenOut, minOut, 'any amount');
  const outSymbol = /^0x0{40}$/.test(tokenOut) ? CHAINS[tx.chainId]?.nativeSymbol ?? 'coin' : (await tokenInfo(env, tx.chainId, tokenOut))?.symbol ?? shortAddress(tokenOut);
  b.detail('Swaps', give).detail('For at least', least).detail('Output to', recipient.toLowerCase()).detail('Leftovers to', refundTo.toLowerCase())
    .detail('Routes raced', `${routes.length}: ${[...new Set(routes.map(r => shortAddress(r.target)))].join(', ')}`);
  return decoded({ title: `Swap ${give} for at least ${least} to ${sameAddress(recipient, tx.from) ? 'you' : shortAddress(recipient)} (Relay's RouteRacer)`,
    summary: `Races ${routes.length} swap route${routes.length === 1 ? '' : 's'} for ${outSymbol} and takes the best, at least ${least}.`, decoder: 'relay_route_racer', status: 'full', b });
};
