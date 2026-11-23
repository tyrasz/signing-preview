// Uniswap v4's PositionManager, called directly: liquidity added to a position or taken out of one, a position
// opened or closed (its source is verified on Sourcify at each address below). The call is
//   modifyLiquidities(bytes unlockData, uint256 deadline),  unlockData = abi.encode(bytes actions, bytes[] params)
// one byte per action, each with its own parameters (Actions.sol, CalldataDecoder.sol): what changes in the position
// (increase 0x00, decrease 0x01, mint 0x02, burn 0x03), then how what it owes is paid in (settle 0x0b, settle pair
// 0x0d, close 0x12) and where what it is owed goes (take 0x0e, take pair 0x11, clear or take 0x13, sweep 0x14).
// Uniswap's app sends remove-liquidity as [decrease, take pair], add as [increase, close, close] and a new position
// as a multicall of [initializePool,] [permitBatch,] modifyLiquidities([mint, settle pair(, sweep)]).
//
// What matters to whoever signs: the most a position may take in (amount0Max, amount1Max) or the least it must give
// back (amount0Min, amount1Min); and the recipient of what is taken out, which the calldata names freely (1 stands
// for the sender, 2 for the manager itself, where the next caller can sweep it): liquidity removed to someone
// else's address is that someone's. They were calls that couldn't be decoded (about one in four Ethereum blocks has
// one, 2026-11-23).
import { decodeAbiParameters, decodeFunctionData, parseAbi, type Hex } from 'viem';
import { formatTimestamp, formatUnits, PreviewBuilder, sameAddress, shortAddress } from '../format.ts';
import { CHAINS } from '../chains.ts';
import { decoded, tokenInfo, type Adapter, type AdapterEnv } from './common.ts';

/** PositionManager, by chain (each verified on Sourcify as PositionManager). */
export const V4_POSITION_MANAGERS: Record<number, string> = {
  1: '0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e', 8453: '0x7c5f5a4bbd8fd63184577525326123b519429bdc', 42161: '0xd88f38f930b7952f2db2432cb002e7abbf3dd869', 10: '0x3c3ea4b57a46241e54610e5f022e5c45859a1017',
  137: '0x1ec2ebf4f37e7363fdfe3551602425af0b3ceef9', 56: '0x7a4a5c919ae2541aed11041a1aeee68f1287f95b', 11155111: '0x429ba70129df741b2ca2a85bc3a2a3328e5c09b4',
};
const KEY = '(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)';
const DETAILS = '(address token, uint160 amount, uint48 expiration, uint48 nonce)';
const ABI = parseAbi([
  'function modifyLiquidities(bytes unlockData, uint256 deadline) payable',
  'function multicall(bytes[] data) payable returns (bytes[])',
  `function initializePool(${KEY} key, uint160 sqrtPriceX96) payable returns (int24)`,
  `function permit(address owner, (${DETAILS} details, address spender, uint256 sigDeadline) permitSingle, bytes signature) payable returns (bytes)`,
  `function permitBatch(address owner, (${DETAILS}[] details, address spender, uint256 sigDeadline) permitBatch, bytes signature) payable returns (bytes)`,
  `function getPoolAndPositionInfo(uint256 tokenId) view returns (${KEY} poolKey, uint256 info)`,
]);
const POOL_KEY = [{ type: 'tuple', components: [{ name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }] }] as const;
const u256 = { type: 'uint256' } as const, u128 = { type: 'uint128' } as const, addr = { type: 'address' } as const, i24 = { type: 'int24' } as const, bytes = { type: 'bytes' } as const;
const ZERO = /^0x0{40}$/, SENDER = '0x0000000000000000000000000000000000000001', MANAGER = '0x0000000000000000000000000000000000000002';
/** A warning of one call: those of a code are told together, since a preview carries each code once. */
type Warn = (severity: 'info' | 'caution' | 'danger', code: string, text: string) => void;
type PoolKey = { currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string };
type Read = { titles: string[]; whole: boolean; /** currencies a sweep sends out of the manager */ swept: Set<string> };
/** Amounts that stand for something else (ActionConstants): all that is owed, and the manager's whole balance. */
const OPEN_DELTA = 0n, CONTRACT_BALANCE = 1n << 255n;

/** One modifyLiquidities call's actions, told into `b` (details and warnings prefixed with `p`): what it does, in a title. */
async function describe(unlockData: Hex, tx: { chainId: number; from: string; to: string }, env: AdapterEnv, b: PreviewBuilder, p: string, warn: Warn): Promise<Read> {
  let actions: Hex, params: readonly Hex[];
  try { [actions, params] = decodeAbiParameters([bytes, { type: 'bytes[]' }], unlockData); } catch { warn('caution', 'v4_unread', `its actions can't be read.`); return { titles: ['Uniswap v4 position actions that can\'t be read'], whole: false, swept: new Set() }; }
  const ids = (actions.slice(2).match(/../g) ?? []).map(h => parseInt(h, 16));
  if (ids.length !== params.length) { warn('danger', 'v4_unread', `it lists ${ids.length} actions and ${params.length} sets of parameters: the manager reverts.`); return { titles: ['Uniswap v4 position actions the manager rejects'], whole: false, swept: new Set() }; }
  const chain = CHAINS[tx.chainId];
  const amount = async (currency: string, raw: bigint): Promise<string> => {
    if (ZERO.test(currency)) return `${formatUnits(raw, chain?.nativeDecimals ?? 18)} ${chain?.nativeSymbol ?? 'native'}`;
    const t = await tokenInfo(env, tx.chainId, currency);
    return t ? `${formatUnits(raw, t.decimals)} ${t.symbol}` : `${raw} base units of ${shortAddress(currency.toLowerCase())}`;
  };
  const symbol = async (currency: string) => (ZERO.test(currency) ? chain?.nativeSymbol ?? 'native' : (await tokenInfo(env, tx.chainId, currency))?.symbol ?? shortAddress(currency.toLowerCase()));
  // The two currencies the call pays in or takes out, where it names exactly two: a pool's are in address order
  // (currency0 < currency1), so with one position worked on they are that position's, whatever its fee and hook.
  const named = new Set<string>();
  for (const [i, id] of ids.entries()) {
    try {
      if (id === 0x0d || id === 0x11) for (const c of decodeAbiParameters([addr, addr], `0x${params[i].slice(2, 130)}`)) named.add(c.toLowerCase());
      else if (id === 0x0b || id === 0x0e || id === 0x12 || id === 0x13 || id === 0x14) named.add(decodeAbiParameters([addr], `0x${params[i].slice(2, 66)}`)[0].toLowerCase());
    } catch { /* told below, where the action is read */ }
  }
  const worked = ids.filter(id => id <= 0x05).length;
  const [low, high] = [...named].sort((x, y) => (BigInt(x) < BigInt(y) ? -1 : 1));
  const inferred: PoolKey | null = worked === 1 && named.size === 2 ? { currency0: low, currency1: high, fee: -1, tickSpacing: 0, hooks: '0x0000000000000000000000000000000000000000' } : null;
  // The pool of a position named by its token id: asked of the chain where it can be, else the pair inferred above.
  const pools = new Map<bigint, PoolKey | null>();
  const poolOf = async (id: bigint): Promise<PoolKey | null> => {
    if (pools.has(id)) return pools.get(id)!;
    let key: PoolKey | null = inferred;
    const rpc = env.deps.rpc;
    if (rpc?.has(tx.chainId)) {
      try {
        const out = String(await rpc.call(tx.chainId, 'eth_call', [{ to: tx.to, data: `0x7ba03aad${id.toString(16).padStart(64, '0')}` }, 'latest'])) as Hex;
        const [k] = decodeAbiParameters(POOL_KEY, out);
        if (!(ZERO.test(k.currency0) && ZERO.test(k.currency1))) key = k as PoolKey;
      } catch { key = inferred; }
    }
    pools.set(id, key);
    return key;
  };
  // A pool's fee is in hundredths of a basis point; with the top flag set it is dynamic, set by the pool's hook.
  const feeOf = (fee: number) => (fee === 0x800000 ? 'a dynamic fee, set by its hook' : `fee ${fee / 10_000}%`);
  const pair = async (k: PoolKey | null, a0: bigint, a1: bigint) => (k ? `${await amount(k.currency0, a0)} and ${await amount(k.currency1, a1)}` : `${a0} and ${a1} base units of its two tokens`);
  const hooked = (k: PoolKey) => { if (!ZERO.test(k.hooks)) warn('info', 'v4_hook', `the pool runs a hook contract (${k.hooks.toLowerCase()}) on what is done in it: its code can charge for, change or refuse it.`); };
  const who = (a: string) => (sameAddress(a, SENDER) || sameAddress(a, tx.from) ? 'you' : sameAddress(a, MANAGER) || sameAddress(a, tx.to) ? 'the position manager itself' : a.toLowerCase());
  // What is taken out, and to whom: someone else's address is theirs to keep; the manager's own balance is the next caller's to sweep.
  const taken: { currency: string; to: string; at: number }[] = [], swept = new Set<string>(), sweptAt = new Map<string, number>();
  const titles: string[] = [];
  let whole = true, n = 0;
  for (const [i, id] of ids.entries()) {
    const data = params[i], label = `${p}Action ${i + 1}`;
    try {
      if (id === 0x00 || id === 0x01) {
        const [tokenId, liquidity, a0, a1] = decodeAbiParameters([u256, u256, u128, u128, bytes], data);
        const k = await poolOf(tokenId);
        if (k) hooked(k);
        const both = await pair(k, a0, a1), name = `position #${tokenId}${k ? ` (${await symbol(k.currency0)}/${await symbol(k.currency1)})` : ''}`;
        if (id === 0x00) {
          b.detail(label, liquidity > 0n ? `add liquidity to ${name}, paying in at most ${both}` : `collect the fees of ${name} (liquidity unchanged)`);
          titles.push(liquidity > 0n ? `Add liquidity to Uniswap v4 ${name}: up to ${both}` : `Collect the fees of Uniswap v4 ${name}`);
        } else {
          b.detail(label, liquidity > 0n ? `remove liquidity from ${name}, getting at least ${both}` : `collect the fees of ${name} (liquidity unchanged)`);
          titles.push(liquidity > 0n ? `Remove liquidity from Uniswap v4 ${name}: at least ${both}` : `Collect the fees of Uniswap v4 ${name}`);
          if (liquidity > 0n && a0 === 0n && a1 === 0n) warn('caution', 'no_slippage_limit', `no minimum is set on what the liquidity removed must pay out: it goes through at any price.`);
        }
        n++;
      } else if (id === 0x02 || id === 0x05) {
        const d = id === 0x02 ? decodeAbiParameters([...POOL_KEY, i24, i24, u256, u128, u128, addr, bytes], data) : null;
        const f = id === 0x05 ? decodeAbiParameters([...POOL_KEY, i24, i24, u128, u128, addr, bytes], data) : null;
        const k = (d ?? f)![0] as PoolKey, a0 = d ? d[4] : f![3], a1 = d ? d[5] : f![4], owner = d ? d[6] : f![5];
        hooked(k);
        const both = await pair(k, a0, a1), name = `${await symbol(k.currency0)}/${await symbol(k.currency1)} (${feeOf(k.fee)})`;
        b.detail(label, `open a position in ${name}, paying in at most ${both}; the position goes to ${who(owner)}`, owner.toLowerCase());
        if (who(owner) !== 'you') warn('caution', 'recipient_not_sender', `the position opened goes to ${who(owner)}, not to you: what is paid into it is theirs to take out.`);
        if (id === 0x05) warn('caution', 'v4_from_deltas', `it sizes the position from whatever the call is owed (MINT_POSITION_FROM_DELTAS), which the manager's own source calls open to sandwiching.`);
        titles.push(`Open a Uniswap v4 position in ${name}: up to ${both}`);
        n++;
      } else if (id === 0x03) {
        const [tokenId, a0, a1] = decodeAbiParameters([u256, u128, u128, bytes], data);
        const k = await poolOf(tokenId);
        if (k) hooked(k);
        const both = await pair(k, a0, a1), name = `position #${tokenId}${k ? ` (${await symbol(k.currency0)}/${await symbol(k.currency1)})` : ''}`;
        b.detail(label, `close ${name}, getting at least ${both}`);
        if (a0 === 0n && a1 === 0n) warn('caution', 'no_slippage_limit', `no minimum is set on what the position closed must pay out: it goes through at any price.`);
        titles.push(`Close Uniswap v4 ${name}: at least ${both}`);
        n++;
      } else if (id === 0x04) {
        const [tokenId, a0, a1] = decodeAbiParameters([u256, u128, u128, bytes], data);
        const k = await poolOf(tokenId);
        b.detail(label, `add to position #${tokenId} whatever the call is owed, at most ${await pair(k, a0, a1)}`);
        warn('caution', 'v4_from_deltas', `it sizes the liquidity added from whatever the call is owed (INCREASE_LIQUIDITY_FROM_DELTAS), which the manager's own source calls open to sandwiching.`);
        titles.push(`Add liquidity to Uniswap v4 position #${tokenId}`);
        n++;
      } else if (id === 0x0b) {
        const [currency, raw, payer] = decodeAbiParameters([addr, u256, { type: 'bool' }], data);
        b.detail(label, `pay in ${raw === OPEN_DELTA ? `what is owed of ${await symbol(currency)}` : raw === CONTRACT_BALANCE ? `the manager's whole balance of ${await symbol(currency)}` : await amount(currency, raw)}, from ${payer ? 'you' : "the manager's own balance"}`);
      } else if (id === 0x0d) {
        const [c0, c1] = decodeAbiParameters([addr, addr], data);
        b.detail(label, `pay in what is owed of ${await symbol(c0)} and ${await symbol(c1)}, from you`);
      } else if (id === 0x0e || id === 0x11 || id === 0x14) {
        const d = id === 0x11 ? decodeAbiParameters([addr, addr, addr], data) : decodeAbiParameters(id === 0x0e ? [addr, addr, u256] : [addr, addr], data);
        const currencies = id === 0x11 ? [d[0] as string, d[1] as string] : [d[0] as string], to = (id === 0x11 ? d[2] : d[1]) as string;
        const names = (await Promise.all(currencies.map(symbol))).join(' and ');
        const some = id === 0x0e && (d[2] as bigint) !== OPEN_DELTA ? await amount(currencies[0], d[2] as bigint) : null;
        b.detail(label, `${id === 0x14 ? `send the manager's balance of ${names}` : some ? `take out ${some}` : `take out what is owed of ${names}`} to ${who(to)}`, to.toLowerCase());
        // (A sweep to the manager itself moves nothing.)
        if (id === 0x14 && who(to) !== 'the position manager itself') for (const c of currencies) { swept.add(c.toLowerCase()); sweptAt.set(c.toLowerCase(), i); }
        if (id !== 0x14 || who(to) !== 'the position manager itself') for (const c of currencies) taken.push({ currency: c.toLowerCase(), to: who(to), at: i });
      } else if (id === 0x12 || id === 0x13) {
        const [currency] = decodeAbiParameters(id === 0x12 ? [addr] : [addr, u256], data);
        b.detail(label, `settle ${await symbol(currency)} either way: pay in what is owed, or take out what is due, to you`);
      } else if (id === 0x15 || id === 0x16) {
        const [raw] = decodeAbiParameters([u256], data);
        const coin = chain?.nativeSymbol ?? 'native';
        b.detail(label, `${id === 0x15 ? 'wrap' : 'unwrap'} ${raw === CONTRACT_BALANCE ? `the manager's whole balance of ${id === 0x15 ? coin : `wrapped ${coin}`}` : raw === OPEN_DELTA ? `as much ${id === 0x15 ? coin : `wrapped ${coin}`} as the call owes of the other` : `${formatUnits(raw, chain?.nativeDecimals ?? 18)} ${id === 0x15 ? coin : `wrapped ${coin}`}`} in the manager`);
      } else {
        b.detail(label, `action 0x${id.toString(16).padStart(2, '0')}, which the position manager doesn't take`);
        warn('caution', 'v4_unread', `action 0x${id.toString(16).padStart(2, '0')} isn't one the position manager runs: it reverts.`);
        whole = false;
      }
    } catch {
      b.detail(label, `action 0x${id.toString(16).padStart(2, '0')}, whose parameters can't be read`);
      warn('caution', 'v4_unread', `the parameters of action ${i + 1} (0x${id.toString(16).padStart(2, '0')}) can't be read: what it does isn't shown.`);
      whole = false;
    }
  }
  const and = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
  const left = taken.filter(t => t.to === 'the position manager itself' && (sweptAt.get(t.currency) ?? -1) < t.at);
  if (left.length) warn('danger', 'v4_left_in_manager', `what is taken out of ${and(await Promise.all([...new Set(left.map(t => t.currency))].map(symbol)))} is left in the position manager itself, and nothing in this call sends it on: whoever calls the manager next can sweep it.`);
  const away = new Map<string, Set<string>>();
  for (const t of taken) if (t.to !== 'you' && t.to !== 'the position manager itself') away.set(t.to, (away.get(t.to) ?? new Set()).add(t.currency));
  for (const [to, currencies] of away) warn('danger', 'recipient_not_sender', `what is taken out of ${and(await Promise.all([...currencies].map(symbol)))} goes to ${to}, not to you.`);
  if (!n) titles.push('Settle balances in Uniswap v4\'s position manager');
  return { titles, whole, swept };
}

export const uniswapV4PositionAdapter: Adapter = async (tx, env) => {
  const manager = V4_POSITION_MANAGERS[tx.chainId];
  if (!tx.to || !manager || tx.to.toLowerCase() !== manager) return null;
  let outer;
  try { outer = decodeFunctionData({ abi: ABI, data: tx.data }); } catch { return null; }
  if (outer.functionName !== 'modifyLiquidities' && outer.functionName !== 'multicall') return null;
  const b = new PreviewBuilder().detail('Contract', `Uniswap v4 position manager (${manager})`, manager);
  const calls: Hex[] = outer.functionName === 'multicall' ? [...(outer.args[0] as readonly Hex[])] : [tx.data];
  const titles: string[] = [];
  let whole = true, sweepsCoin = false;
  // The Permit2 allowances the call submits are told here: the simulation doesn't call them hidden.
  const declaredApprovals: { kind: 'permit2'; token: string; spender: string }[] = [];
  const now = BigInt(Math.floor((env.context.now ?? Date.now()) / 1000));
  // A preview carries each warning code once: what several actions or calls say under one code is told together, at
  // the gravest severity any of them has.
  const RANK = { info: 0, caution: 1, danger: 2 } as const;
  const said = new Map<string, { severity: 'info' | 'caution' | 'danger'; texts: string[] }>();
  for (const [i, data] of calls.entries()) {
    const p = calls.length > 1 ? `Call ${i + 1}: ` : '';
    const warn: Warn = (severity, code, text) => {
      const w = said.get(code) ?? { severity, texts: [] }, line = p ? `${p}${text}` : `${text[0].toUpperCase()}${text.slice(1)}`;
      if (RANK[severity] > RANK[w.severity]) w.severity = severity;
      if (!w.texts.includes(line)) w.texts.push(line);
      said.set(code, w);
    };
    let call;
    try { call = decodeFunctionData({ abi: ABI, data }); } catch { call = null; }
    if (call?.functionName === 'modifyLiquidities') {
      const [unlockData, deadline] = call.args;
      b.detail(`${p}Valid until`, deadline < 1n << 47n ? formatTimestamp(Number(deadline) * 1000) : 'no deadline that will come', deadline.toString());
      if (deadline < now) warn('info', 'deadline_passed', `its deadline has passed: the manager reverts.`);
      const r = await describe(unlockData, { chainId: tx.chainId, from: tx.from, to: manager }, env, b, p, warn);
      titles.push(...r.titles);
      whole &&= r.whole;
      sweepsCoin ||= [...r.swept].some(c => ZERO.test(c));
    } else if (call?.functionName === 'initializePool') {
      const [k] = call.args;
      b.detail(`${p}Creates the pool`, `${shortAddress(k.currency0.toLowerCase())} / ${shortAddress(k.currency1.toLowerCase())}, ${k.fee === 0x800000 ? 'a dynamic fee' : `fee ${k.fee / 10_000}%`}${ZERO.test(k.hooks) ? '' : `, with the hook ${k.hooks.toLowerCase()}`}, if it doesn't exist yet`);
    } else if (call?.functionName === 'permit' || call?.functionName === 'permitBatch') {
      // A Permit2 allowance the sender signed, handed to Permit2 through the manager: for the manager, so that it can
      // pull what the position takes in. For anyone else it is an allowance slipped in beside the liquidity.
      const [owner, permit] = call.args as unknown as readonly [string, { details: unknown; spender: string }];
      const list = (Array.isArray(permit.details) ? permit.details : [permit.details]) as { token: string; amount: bigint; expiration: number }[];
      const spender = permit.spender.toLowerCase();
      for (const d of list) {
        const t = await tokenInfo(env, tx.chainId, d.token);
        const all = d.amount >= (1n << 160n) - 1n;
        declaredApprovals.push({ kind: 'permit2', token: d.token.toLowerCase(), spender });
        b.detail(`${p}Permit2 allowance`, `${sameAddress(spender, manager) ? 'the position manager' : spender} may take ${all ? 'any amount' : t ? `${formatUnits(d.amount, t.decimals)} ${t.symbol}` : `${d.amount} base units`} of ${t?.symbol ?? shortAddress(d.token.toLowerCase())} from ${sameAddress(owner, tx.from) ? 'you' : owner.toLowerCase()} until ${formatTimestamp(d.expiration * 1000)}`, spender);
      }
      if (!sameAddress(spender, manager)) warn('danger', 'v4_permit_other_spender', `it hands Permit2 an allowance you signed for ${spender}, which isn't the position manager: that address may then take the tokens it names from you.`);
      if (!sameAddress(owner, tx.from)) warn('caution', 'v4_permit_other_owner', `the Permit2 allowance it submits is ${shortAddress(owner.toLowerCase())}'s, not yours.`);
    } else {
      b.detail(`${p}Call`, `${data.length >= 10 ? data.slice(0, 10) : 'no calldata'} on the position manager, which isn't read`);
      warn('caution', 'v4_unread', `a call on the position manager (${data.length >= 10 ? data.slice(0, 10) : 'no calldata'}) that isn't read here.`);
      whole = false;
    }
  }
  if (!titles.length) return null;
  for (const [code, w] of said) b.warn(w.severity, code, w.texts.join(' '));
  if (tx.value > 0n) {
    // The manager pays a pool in coin out of what the call sent; what the position doesn't take stays in the manager,
    // where the next caller's sweep takes it, unless this call sweeps it back.
    const sent = `${formatUnits(tx.value, CHAINS[tx.chainId]?.nativeDecimals ?? 18)} ${CHAINS[tx.chainId]?.nativeSymbol ?? 'native'}`;
    b.detail('Coin sent with it', `${sent}${sweepsCoin ? ' (what the position doesn\'t take is swept back)' : ''}`, tx.value.toString());
    if (!sweepsCoin) b.warn('caution', 'v4_coin_not_swept', `It sends ${sent}, and nothing in the call sends back what the position doesn't take: whatever is over stays in the position manager, where whoever calls it next can sweep it.`);
  }
  return decoded({ title: titles.length === 1 ? titles[0] : `${titles.length} Uniswap v4 position actions: ${titles[0]}; …`, summary: `Calls Uniswap v4's position manager: ${titles.slice(0, 3).join('; ')}${titles.length > 3 ? '; …' : ''}.`, decoder: 'uniswap_v4_position', status: whole ? 'full' : 'partial', b, ...(declaredApprovals.length && { declaredApprovals }) });
};
