// THORChain and Maya Protocol deposits: a cross-chain swap (or a deposit into either chain) starts as a transaction to
// the chain's router, depositWithExpiry(vault, asset, amount, memo, expiration) (or deposit without the expiry). The
// router (THORChain_Router 4.1 and MAYAChain_Router, verified on Sourcify) sends native coin straight to the vault, or
// pulls the token with transferFrom and credits it to the vault, and logs the memo; the network's nodes read the memo
// and act on it. What happens is in the memo, so it is read here:
//   =:ASSET:DEST[/REFUND]:LIMIT[/INTERVAL/QUANTITY]:AFFILIATE[/…]:FEE[/…]   a swap (also s, swap; =< a limit swap)
//   TRADE+:ADDR, SECURE+:ADDR                                               a deposit to a trade account, a secured asset
//   +:POOL:PAIREDADDR:AFFILIATE:FEE                                         liquidity added
// ASSET is CHAIN.SYMBOL[-CONTRACT] or a short code (b for BTC.BTC); LIMIT is the least the swap may give, in the
// network's units of 10^-8. Read from 1,850 real memos to the four routers below (2026-11-19). The vault must be the
// network's current inbound address (its inbound_addresses): the router sends to any vault it is given.
import { decodeFunctionData, isAddress, parseAbi, sha256 } from 'viem';
import { formatTimestamp, formatUnits, PreviewBuilder, shortAddress } from '../format.ts';
import { CHAINS } from '../chains.ts';
import { decoded, nativeAmount, tokenAmount, tokenInfo, tokenSourceWarnings, type Adapter } from './common.ts';

/** The routers, by chain: each verified on Sourcify, each with deposits on 2026-11-19. */
const ROUTERS: Record<number, Record<string, 'THORChain' | 'Maya'>> = {
  1: { '0xd37bbe5744d730a1d98d8dc97c42f0ca46ad7146': 'THORChain', '0xe3985e6b61b814f7cdb188766562ba71b446b46d': 'Maya' },
  56: { '0xb30ec53f98ff5947ede720d32ac2da7e52a5f56b': 'THORChain' },
  42161: { '0x700e97ef07219440487840dc472e7120a7ff11f4': 'Maya' },
};
const ABI = parseAbi([
  'function depositWithExpiry(address vault, address asset, uint256 amount, string memo, uint256 expiration) payable',
  'function deposit(address vault, address asset, uint256 amount, string memo) payable',
]);
/** Short codes whose asset is certain from both networks' use (a code each network gives its own meaning to is left as it is). */
const SHORT: Record<string, Record<string, string>> = {
  THORChain: { b: 'BTC.BTC', e: 'ETH.ETH', l: 'LTC.LTC', d: 'DOGE.DOGE', g: 'GAIA.ATOM', s: 'BSC.BNB', r: 'THOR.RUNE', c: 'BCH.BCH', a: 'AVAX.AVAX' },
  Maya: { b: 'BTC.BTC', e: 'ETH.ETH', c: 'MAYA.CACAO' },
};
const NO_LIMIT_BPS = 100n;
/**
 * Whether a destination is an address on the chain of `asset` (CHAIN.SYMBOL), its checksum checked: base58check
 * (Bitcoin-style, TRON, XRP's alphabet, Zcash), bech32 or bech32m (segwit, Cosmos-style), EIP-55 where an EVM address
 * is in mixed case. A string the network can't read as an address it takes as a name (THORName, MAYAName), so one with
 * an address's shape but not its checksum is a name. Undefined where the chain's format isn't known here.
 */
const B32 = '[02-9ac-hj-np-z]', B58 = '[1-9A-HJ-NP-Za-km-z]';
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz', XRP58 = 'rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz';
function base58check(s: string, alphabet = BASE58): boolean {
  let n = 0n;
  for (const c of s) { const i = alphabet.indexOf(c); if (i < 0) return false; n = n * 58n + BigInt(i); }
  let zeros = 0;
  while (s[zeros] === alphabet[0]) zeros++;
  const hex = n.toString(16), bytes = '00'.repeat(zeros) + (hex.length % 2 ? `0${hex}` : hex);
  if (bytes.length < 10) return false;
  return sha256(sha256(`0x${bytes.slice(0, -8)}`)).slice(2, 10) === bytes.slice(-8);
}
function bech32(s: string, hrp: string): boolean {
  const lower = s.toLowerCase();
  if ((s !== lower && s !== s.toUpperCase()) || !lower.startsWith(`${hrp}1`)) return false;
  const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l', GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  const data = [...lower.slice(hrp.length + 1)].map(c => CHARSET.indexOf(c));
  if (data.length < 7 || data.some(d => d < 0)) return false;
  let chk = 1;
  for (const v of [...[...hrp].map(c => c.charCodeAt(0) >> 5), 0, ...[...hrp].map(c => c.charCodeAt(0) & 31), ...data]) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk === 1 || chk === 0x2bc830a3;
}
const evm = (d: string) => /^0x[0-9a-fA-F]{40}$/.test(d) && isAddress(d, { strict: true });
const ADDRESS_CHECKS: Record<string, (d: string) => boolean> = {
  BTC: d => new RegExp(`^(bc1q${B32}{38}|bc1[qp]${B32}{58})$`).test(d) ? bech32(d, 'bc') : new RegExp(`^[13]${B58}{25,34}$`).test(d) && base58check(d),
  LTC: d => new RegExp(`^(ltc1q${B32}{38}|ltc1[qp]${B32}{58})$`).test(d) ? bech32(d, 'ltc') : new RegExp(`^[LM3]${B58}{26,33}$`).test(d) && base58check(d),
  BCH: d => new RegExp(`^(bitcoincash:)?[qp]${B32}{41}$`).test(d) || (new RegExp(`^[13]${B58}{25,34}$`).test(d) && base58check(d)),
  DOGE: d => new RegExp(`^[DA9]${B58}{25,34}$`).test(d) && base58check(d),
  ETH: evm, BSC: evm, AVAX: evm, BASE: evm, ARB: evm,
  GAIA: d => bech32(d, 'cosmos'), THOR: d => bech32(d, 'thor'), MAYA: d => bech32(d, 'maya'),
  TRON: d => new RegExp(`^T${B58}{33}$`).test(d) && base58check(d), XRP: d => /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(d) && base58check(d, XRP58),
  SOL: d => new RegExp(`^${B58}{32,44}$`).test(d), ZEC: d => new RegExp(`^t[13]${B58}{33}$`).test(d) && base58check(d),
};
const addressOn = (asset: string | undefined, destination: string) => { const chain = asset?.split('.')[0]; return chain && Object.hasOwn(ADDRESS_CHECKS, chain) ? ADDRESS_CHECKS[chain](destination) : undefined; };

export interface ThorMemo {
  action: 'swap' | 'limit_swap' | 'trade' | 'secure' | 'add' | 'other';
  asset?: string; code?: string; destination?: string; refund?: string;
  limit?: bigint; interval?: bigint; quantity?: bigint;
  affiliates?: { name: string; bps: bigint | null }[];
}

/** A memo's parts, as the network reads them (fields split on ':'). */
export function readMemo(memo: string, network: 'THORChain' | 'Maya'): ThorMemo {
  const parts = memo.split(':');
  const head = parts[0].toLowerCase();
  // (Object.hasOwn: a code such as "constructor" must not find Object's own properties.)
  const asset = (code: string | undefined) => code === undefined ? {} : Object.hasOwn(SHORT[network], code.toLowerCase()) ? { asset: SHORT[network][code.toLowerCase()], code } : /^[A-Za-z0-9]+\.[^:]+$/.test(code) ? { asset: code.toUpperCase() } : { code };
  if (head === '=' || head === 's' || head === 'swap' || head === '=<') {
    const [destination, refund] = (parts[2] ?? '').split('/');
    const [limit, interval, quantity] = (parts[3] ?? '').split('/');
    const num = (v: string | undefined) => v !== undefined && /^\d+$/.test(v) ? BigInt(v) : undefined;
    const names = parts[4] ? parts[4].split('/') : [], fees = parts[5] ? parts[5].split('/') : [];
    return { action: head === '=<' ? 'limit_swap' : 'swap', ...asset(parts[1]), ...(destination && { destination }), ...(refund && { refund }),
      ...(num(limit) !== undefined && { limit: num(limit) }), ...(num(interval) !== undefined && { interval: num(interval) }), ...(num(quantity) !== undefined && { quantity: num(quantity) }),
      ...(names.length && { affiliates: names.map((name, i) => ({ name, bps: num(fees[i] ?? fees[fees.length - 1]) ?? null })) }) };
  }
  if (head === 'trade+') return { action: 'trade', ...(parts[1] && { destination: parts[1] }) };
  if (head === 'secure+') return { action: 'secure', ...(parts[1] && { destination: parts[1] }) };
  if (head === '+' || head === 'a' || head === 'add') return { action: 'add', ...asset(parts[1]), ...(parts[2] && { destination: parts[2] }) };
  return { action: 'other' };
}

export const thorchainAdapter: Adapter = async (tx, env) => {
  if (!tx.to || !(tx.data.startsWith('0x44bc937b') || tx.data.startsWith('0x1fece7b4'))) return null;
  let call;
  try { call = decodeFunctionData({ abi: ABI, data: tx.data }); } catch { return null; }
  const router = tx.to.toLowerCase();
  const known = ROUTERS[tx.chainId]?.[router];
  const network = known ?? 'THORChain';
  const [vault, assetAddress, amount, memo] = call.args;
  const expiration = call.functionName === 'depositWithExpiry' ? call.args[4] as bigint : undefined;
  const native = /^0x0{40}$/.test(assetAddress);
  const info = native ? undefined : await tokenInfo(env, tx.chainId, assetAddress);
  // Native coin: what the transaction sends (the amount argument is ignored); a token: the amount pulled.
  const sent = native ? nativeAmount(tx.chainId, tx.value) : tokenAmount(amount, info, assetAddress);
  const m = readMemo(memo, network);
  const b = new PreviewBuilder().detail('Router', `${known ? `${network}'s router` : 'a THORChain-style router'} (${router})`, router)
    .detail('Vault', vault.toLowerCase()).detail('You deposit', sent, (native ? tx.value : amount).toString())
    .detail('Memo', memo.length > 300 ? `${memo.slice(0, 300)}…` : memo);
  if (!native) tokenSourceWarnings(b, tx.chainId, info);
  if (!native && !info) b.warn('caution', 'unknown_token', 'This token is not in the known-token list, so its name and decimals are unverified. Amounts are shown in base units.');
  if (!known) b.warn('caution', 'thorchain_router_unknown', `${shortAddress(router)} takes a THORChain-style deposit but isn't THORChain's or Maya's router as known here: what it does with the deposit isn't known.`);
  if (native && tx.value === 0n) b.warn('info', 'thorchain_nothing_sent', 'It sends no coin: the router deposits what the transaction sends, whatever its amount says.');
  if (!native && tx.value > 0n) {
    // THORChain's and Maya's routers refuse it; a router this preview doesn't know may keep it.
    b.detail('Coin sent with it', nativeAmount(tx.chainId, tx.value), tx.value.toString());
    if (known) b.warn('info', 'thorchain_unexpected_coin', 'It sends coin with a token deposit: the router refuses it ("unexpected eth").');
    else b.warn('caution', 'thorchain_unexpected_coin', `It sends ${nativeAmount(tx.chainId, tx.value)} with a token deposit, to a router this preview doesn't know, which may keep it.`);
  }
  const now = Math.floor(env.context.replay ? Number(env.context.replay.at.header.timestamp) * 1000 : env.context.now ?? Date.now());
  if (expiration !== undefined) {
    b.detail('Expires', expiration >= 1n << 40n ? 'never' : formatTimestamp(Number(expiration) * 1000), expiration.toString());
    if (expiration * 1000n <= BigInt(now)) b.warn('info', 'thorchain_expired', 'Its expiry has passed: the router refuses it.');
  }
  // The vault: the router sends to whatever it is given. With an RPC, one that is a contract, or has never sent a
  // transaction (the network's vaults send outbound transfers all the time), isn't likely to be the network's.
  if (env.deps.rpc?.has(tx.chainId)) {
    try {
      const [code, sentCount] = await Promise.all([env.deps.rpc.call(tx.chainId, 'eth_getCode', [vault, 'latest']), env.deps.rpc.call(tx.chainId, 'eth_getTransactionCount', [vault, 'latest'])]);
      if (String(code) !== '0x') b.warn('caution', 'thorchain_vault_contract', `The vault ${shortAddress(vault)} is a contract: ${network}'s vaults are keys its nodes share, so this one is likely not ${network}'s, and what it does with the deposit isn't known.`);
      else if (BigInt(String(sentCount)) === 0n) b.warn('caution', 'thorchain_vault_unused', `The vault ${shortAddress(vault)} has never sent a transaction, where ${network}'s vaults send outbound transfers all the time: check it is ${network}'s current inbound address before sending.`);
    } catch { /* not read */ }
  }
  b.note(`${network} credits a deposit only to its current inbound vault (its inbound_addresses): the router sends to the vault named, so one that isn't ${network}'s loses the deposit.`);
  const coin = !native && tx.value > 0n && !known ? [{ direction: 'out' as const, account: tx.from, amount: formatUnits(tx.value, CHAINS[tx.chainId]?.nativeDecimals ?? 18), symbol: CHAINS[tx.chainId]?.nativeSymbol ?? 'native', raw: tx.value.toString(), asset: 'native', basis: 'requested' as const }] : [];
  const outflow = native ? (tx.value > 0n ? [{ direction: 'out' as const, account: tx.from, amount: sent.split(' ')[0], symbol: sent.split(' ')[1], raw: tx.value.toString(), asset: 'native', basis: 'requested' as const }] : [])
    : [{ direction: 'out' as const, account: tx.from, amount: info ? formatUnits(amount, info.decimals) : amount.toString(), symbol: info?.symbol ?? assetAddress, raw: amount.toString(), asset: assetAddress.toLowerCase(), basis: 'requested' as const }, ...coin];
  const what = m.asset ?? (m.code ? `the asset with short code "${m.code}"` : undefined);
  switch (m.action) {
    case 'swap': case 'limit_swap': {
      const symbol = m.asset?.split('.')[1]?.split('-')[0];
      const least = m.limit !== undefined && m.limit > 0n ? `${formatUnits(m.limit, 8)}${symbol ? ` ${symbol}` : ` units (10^-8) of ${what ?? 'the asset'}`}` : undefined;
      b.detail('Swap to', what ?? 'an asset the memo doesn\'t name').detail('Destination', m.destination ?? 'none');
      if (m.refund) b.detail('Refund address', m.refund);
      b.detail(m.action === 'limit_swap' ? 'Limit (the least it takes)' : 'Minimum received', least ?? 'none');
      // A streaming swap is split into sub-swaps an interval of blocks apart (an interval of 0: not streamed).
      if (m.interval !== undefined && m.interval > 0n) b.detail('Streaming', `every ${m.interval} block${m.interval === 1n ? '' : 's'}, ${m.quantity ? `${m.quantity} sub-swaps` : 'as many sub-swaps as the network picks'}`);
      const total = (m.affiliates ?? []).reduce((s, a) => s + (a.bps ?? 0n), 0n);
      if (m.affiliates?.length) b.detail('Affiliate fees', `${m.affiliates.map(a => `${a.name} ${a.bps ?? '?'} bps`).join(', ')} (${formatUnits(total, 2)}% in all)`);
      if (!m.destination) b.warn('caution', 'thorchain_no_destination', 'Its memo names no destination address: what the network does with the swap isn\'t read here.');
      // A destination that isn't an address on the asset's chain is read by the network as a name (a THORName or
      // MAYAName), an alias whose owner sets where it pays.
      else if (addressOn(m.asset, m.destination) === false) b.warn('caution', 'thorchain_destination_name', `Its destination (${m.destination}) isn't an address on ${m.asset!.split('.')[0]}: ${network} takes it as a name, an alias whose owner chooses where it pays. Check it is yours.`);
      if (!least) b.warn('caution', 'thorchain_no_limit', `It sets no minimum for what the swap gives: ${network} swaps it at whatever the price is when it runs.`);
      if (total > NO_LIMIT_BPS) b.warn('caution', 'thorchain_affiliate_fee', `Affiliates take ${formatUnits(total, 2)}% of the swap (${m.affiliates!.map(a => `${a.name} ${a.bps ?? '?'} bps`).join(', ')}).`);
      if (m.action === 'limit_swap') b.note('A limit swap (=<) waits until the price gives at least its limit.');
      b.note(`Check the destination address: ${network} sends what the swap gives there, on its own chain, and can't undo it.`);
      return decoded({
        title: `Swap ${sent} for ${what ?? 'another asset'} via ${network}${m.destination ? `, to ${m.destination.length > 16 ? `${m.destination.slice(0, 8)}…${m.destination.slice(-6)}` : m.destination}` : ''}`,
        summary: `A ${network} ${m.action === 'limit_swap' ? 'limit swap' : 'swap'}: ${sent} goes to its vault, and ${least ? `at least ${least}` : 'whatever the swap gives'} goes to ${m.destination ?? 'the memo\'s destination'}.`,
        decoder: 'thorchain_deposit', status: known && what && m.destination ? 'full' : 'partial', b, assetChanges: outflow,
      });
    }
    case 'trade': case 'secure': {
      const kind = m.action === 'trade' ? 'trade account' : 'secured asset';
      b.detail('Credited to', m.destination ?? 'none');
      if (!m.destination) b.warn('caution', 'thorchain_no_destination', 'Its memo names no address to credit.');
      else if (addressOn(network === 'Maya' ? 'MAYA.CACAO' : 'THOR.RUNE', m.destination) === false) b.warn('caution', 'thorchain_destination_name', `The address credited (${m.destination}) isn't a ${network} address: ${network} takes it as a name, an alias whose owner chooses where it pays. Check it is yours.`);
      return decoded({ title: `Deposit ${sent} into ${network} as a ${kind}${m.destination ? ` for ${m.destination.slice(0, 10)}…${m.destination.slice(-6)}` : ''}`, summary: `${sent} goes to ${network}'s vault, credited ${m.action === 'trade' ? 'to the trade account' : 'as a secured asset'} of ${m.destination ?? 'the memo\'s address'} on ${network}.`, decoder: 'thorchain_deposit', status: known && m.destination ? 'full' : 'partial', b, assetChanges: outflow });
    }
    case 'add':
      b.detail('Pool', what ?? 'none').detail('Paired address', m.destination ?? 'none');
      return decoded({ title: `Add ${sent} of liquidity to ${network}'s ${what ?? ''} pool`.replace(/  +/g, ' '), summary: `${sent} goes to ${network}'s vault, added to the ${what ?? 'memo\'s'} pool.`, decoder: 'thorchain_deposit', status: known && what ? 'full' : 'partial', b, assetChanges: outflow });
    default:
      b.warn('caution', 'thorchain_memo_unread', `Its memo isn't one this preview reads: what ${network} does with the deposit isn't shown.`);
      return decoded({ title: `Deposit ${sent} into ${network}`, summary: `${sent} goes to ${network}'s vault with the memo "${memo.slice(0, 80)}".`, decoder: 'thorchain_deposit', status: 'partial', b, assetChanges: outflow });
  }
};
