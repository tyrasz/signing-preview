// The busiest swap and bridge routers left unreadable without an Etherscan key: 1inch's Aggregation Router v6,
// MetaMask's Swaps and Bridge routers, and Across's SpokePool. Each gets a headline from its calldata ("Swap 100 USDC
// for at least 99.8 USDT on 1inch", "Bridge 0.5 ETH to Base through Across"); the simulation shows what moves.
import { decodeFunctionData, parseAbi, type Hex } from 'viem';
import { formatUnits, PreviewBuilder, sameAddress, shortAddress, utcDate } from '../format.ts';
import { builtinTokens, CHAINS } from '../chains.ts';
import { wrappedNative } from './universal-router.ts';
import { decoded, tokenInfo, type Adapter, type AdapterEnv } from './common.ts';
import { chainLabel } from './universal-router.ts';

const NATIVE_ALIASES = ['0x0000000000000000000000000000000000000000', '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'];
const isNative = (a: string) => NATIVE_ALIASES.includes(a.toLowerCase());

/** "100 USDC", "0.5 ETH", or base units of an unknown token. */
async function amountOf(env: AdapterEnv, chainId: number, token: string, raw: bigint): Promise<string> {
  const chain = CHAINS[chainId];
  if (isNative(token)) return `${formatUnits(raw, chain?.nativeDecimals ?? 18)} ${chain?.nativeSymbol ?? 'native'}`;
  const t = await tokenInfo(env, chainId, token);
  return t ? `${formatUnits(raw, t.decimals)} ${t.symbol}` : `${raw} base units of ${shortAddress(token)}`;
}

// --- 1inch Aggregation Router v6 (same address on Ethereum and Arbitrum One) ---
const ONEINCH_V6 = '0x111111125421ca6dc452d289314280a0f8842a65';
const ONEINCH_ABI = parseAbi([
  'function swap(address executor, (address srcToken, address dstToken, address srcReceiver, address dstReceiver, uint256 amount, uint256 minReturnAmount, uint256 flags) desc, bytes data) payable returns (uint256, uint256)',
  'function unoswap(uint256 token, uint256 amount, uint256 minReturn, uint256 dex) returns (uint256)',
  'function unoswap2(uint256 token, uint256 amount, uint256 minReturn, uint256 dex, uint256 dex2) returns (uint256)',
  'function unoswap3(uint256 token, uint256 amount, uint256 minReturn, uint256 dex, uint256 dex2, uint256 dex3) returns (uint256)',
  'function unoswapTo(uint256 to, uint256 token, uint256 amount, uint256 minReturn, uint256 dex) returns (uint256)',
  'function unoswapTo2(uint256 to, uint256 token, uint256 amount, uint256 minReturn, uint256 dex, uint256 dex2) returns (uint256)',
  'function unoswapTo3(uint256 to, uint256 token, uint256 amount, uint256 minReturn, uint256 dex, uint256 dex2, uint256 dex3) returns (uint256)',
  'function ethUnoswap(uint256 minReturn, uint256 dex) payable returns (uint256)',
  'function ethUnoswap2(uint256 minReturn, uint256 dex, uint256 dex2) payable returns (uint256)',
  'function ethUnoswap3(uint256 minReturn, uint256 dex, uint256 dex2, uint256 dex3) payable returns (uint256)',
  'function ethUnoswapTo(uint256 to, uint256 minReturn, uint256 dex) payable returns (uint256)',
  'function ethUnoswapTo2(uint256 to, uint256 minReturn, uint256 dex, uint256 dex2) payable returns (uint256)',
  'function ethUnoswapTo3(uint256 to, uint256 minReturn, uint256 dex, uint256 dex2, uint256 dex3) payable returns (uint256)',
  'function cancelOrder(uint256 makerTraits, bytes32 orderHash)',
  'function cancelOrders(uint256[] makerTraits, bytes32[] orderHashes)',
]);
const ADDRESS_MASK = (1n << 160n) - 1n;
const addressOf = (v: bigint) => `0x${(v & ADDRESS_MASK).toString(16).padStart(40, '0')}`;

/**
 * The token a chain of 1inch "unoswap" pools ends in. Each `dex` word holds a pool address in its low 160 bits and
 * the protocol in its top 3 (0 Uniswap v2, 1 Uniswap v3, 2 Curve); the pools' token0/token1 say which way each hop
 * goes. Null when a pool can't be read (Curve, no RPC).
 */
async function unoswapOutput(env: AdapterEnv, chainId: number, input: string, dexes: bigint[]): Promise<string | null> {
  const rpc = env.deps.rpc;
  if (!rpc?.has(chainId)) return null;
  let token = input.toLowerCase();
  for (const dex of dexes) {
    if (dex >> 253n === 2n) return null;
    const pool = addressOf(dex);
    try {
      const [t0, t1] = await Promise.all(['0x0dfe1681', '0xd21220a7'].map(async s => `0x${String(await rpc.call(chainId, 'eth_call', [{ to: pool, data: s }, 'latest'])).slice(-40)}`));
      if (sameAddress(t0, token)) token = t1.toLowerCase(); else if (sameAddress(t1, token)) token = t0.toLowerCase(); else return null;
    } catch { return null; }
  }
  return token;
}

const oneInchAdapter: Adapter = async (tx, env) => {
  if (!tx.to || tx.to.toLowerCase() !== ONEINCH_V6) return null;
  let call;
  try { call = decodeFunctionData({ abi: ONEINCH_ABI, data: tx.data }); } catch { return null; }
  const b = new PreviewBuilder().detail('Contract', `1inch Aggregation Router v6 (${ONEINCH_V6})`, ONEINCH_V6);
  if (call.functionName === 'cancelOrder' || call.functionName === 'cancelOrders') {
    const n = call.functionName === 'cancelOrder' ? 1 : (call.args[1] as readonly Hex[]).length;
    return decoded({ title: n === 1 ? 'Cancel a 1inch limit order' : `Cancel ${n} 1inch limit orders`, summary: 'Cancels limit orders you signed on 1inch, so they can no longer be filled.', decoder: 'oneinch_v6', status: 'full', b });
  }
  let src: string, dst: string | null, amount: bigint, minReturn: bigint, receiver: string;
  if (call.functionName === 'swap') {
    const d = call.args[1];
    [src, dst, amount, minReturn, receiver] = [d.srcToken, d.dstToken, d.amount, d.minReturnAmount, d.dstReceiver];
  } else {
    const a = call.args as readonly bigint[];
    const to = call.functionName.includes('To') ? a[0] : undefined;
    const rest = to === undefined ? a : a.slice(1);
    const eth = call.functionName.startsWith('eth');
    src = eth ? NATIVE_ALIASES[0] : addressOf(rest[0]);
    amount = eth ? tx.value : rest[1];
    minReturn = eth ? rest[0] : rest[2];
    const dexes = (eth ? rest.slice(1) : rest.slice(3)).map(BigInt);
    // An ETH swap starts from WETH in the first pool.
    const start = eth ? wrappedNative(tx.chainId) ?? src : src;
    dst = await unoswapOutput(env, tx.chainId, start, dexes);
    // Bit 252 of the last pool word: unwrap the WETH out of it, so the swap pays out ETH (checked against receipts).
    if (dst && sameAddress(dst, wrappedNative(tx.chainId) ?? '') && (dexes[dexes.length - 1] >> 252n) & 1n) dst = NATIVE_ALIASES[0];
    receiver = to === undefined ? tx.from : addressOf(to);
    b.detail('Pools', dexes.map(d => `${['Uniswap v2', 'Uniswap v3', 'Curve'][Number(d >> 253n)] ?? 'unknown'} ${shortAddress(addressOf(d))}`).join(' → '));
  }
  const sent = await amountOf(env, tx.chainId, src, amount);
  const least = dst ? await amountOf(env, tx.chainId, dst, minReturn) : `${minReturn} base units of the output token`;
  b.detail('You send', sent).detail('You receive at least', least);
  // In swap()'s description, a zero receiver means the sender.
  if (BigInt(receiver) !== 0n && !sameAddress(receiver, tx.from)) {
    b.detail('Recipient', receiver);
    b.warn('caution', 'recipient_not_sender', `The tokens you buy go to ${shortAddress(receiver)}, not to you.`);
  }
  if (minReturn <= 1n) b.warn('caution', 'no_slippage_limit', 'Nothing limits the price: the minimum received is zero, so the swap would go through at any rate.');
  return decoded({ title: `Swap ${sent} for at least ${least} on 1inch`, summary: `Swaps ${sent} through 1inch's Aggregation Router v6, for at least ${least}.`, decoder: 'oneinch_v6', status: dst ? 'full' : 'partial', b });
};

// --- MetaMask Swaps and Bridge routers: the aggregator or bridge is named, the payload is its own ---
const METAMASK: Record<string, { chainId: number; kind: 'swap' | 'bridge' }> = {
  '0x881d40237659c251811cec9c364ef91dc08d300c': { chainId: 1, kind: 'swap' },
  '0x9dda6ef3d919c9bc8885d5560999a3640431e8e6': { chainId: 42161, kind: 'swap' },
  '0x0439e60f02a8900a951603950d8d4527f400c3f1': { chainId: 1, kind: 'bridge' },
};
const METAMASK_ABI = parseAbi(['function swap(string aggregatorId, address tokenFrom, uint256 amount, bytes data) payable', 'function bridge(string adapterId, address srcToken, uint256 amount, bytes data) payable']);

const metaMaskAdapter: Adapter = async (tx, env) => {
  const r = tx.to && METAMASK[tx.to.toLowerCase()];
  if (!r || r.chainId !== tx.chainId) return null;
  let call;
  try { call = decodeFunctionData({ abi: METAMASK_ABI, data: tx.data }); } catch { return null; }
  const [via, token, raw] = call.args;
  const sent = await amountOf(env, tx.chainId, token, raw);
  const service = r.kind === 'swap' ? 'MetaMask Swaps' : 'MetaMask Bridge';
  const b = new PreviewBuilder().detail('Contract', `${service} router (${tx.to})`, tx.to!).detail(r.kind === 'swap' ? 'Aggregator' : 'Bridge', via).detail('You send', sent);
  b.note(`${service} passes the ${r.kind === 'swap' ? 'swap' : 'bridge transfer'} to ${via}; what you receive comes from that provider's route, shown by the simulation where available.`);
  return decoded({ title: `${r.kind === 'swap' ? 'Swap' : 'Bridge'} ${sent} with ${service} (${via})`, summary: `${r.kind === 'swap' ? 'Swaps' : 'Bridges'} ${sent} through ${service}, routed by ${via}.`, decoder: 'metamask_router', status: 'partial', b });
};

// --- Across SpokePool deposits (addresses from across-protocol/contracts broadcast/deployed-addresses.json) ---
const SPOKE_POOLS: Record<string, number> = {
  '0x5c7bcd6e7de5423a257d81b442095a1a6ced35c5': 1,
  '0xe35e9842fceaca96570b734083f4a58e8f7c5f2a': 42161,
  '0x35e63ea3eb0fb7a3bc543c71fb66412e1f6b0e04': 999,
};
const SPOKE_ABI = parseAbi([
  'function depositV3(address depositor, address recipient, address inputToken, address outputToken, uint256 inputAmount, uint256 outputAmount, uint256 destinationChainId, address exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes message) payable',
  'function deposit(bytes32 depositor, bytes32 recipient, bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 destinationChainId, bytes32 exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes message) payable',
]);
/** An address passed as bytes32 (Across's newer deposit, which also reaches non-EVM chains): an EVM address when it fits in 20 bytes. */
const fromBytes32 = (v: string) => /^0x0{24}/.test(v) ? `0x${v.slice(26)}` : v;

const acrossAdapter: Adapter = async (tx, env) => {
  const chain = tx.to && SPOKE_POOLS[tx.to.toLowerCase()];
  if (!chain || chain !== tx.chainId) return null;
  let call;
  try { call = decodeFunctionData({ abi: SPOKE_ABI, data: tx.data }); } catch { return null; }
  const a = call.args;
  const [depositor, recipient, inputToken, outputToken] = [a[0], a[1], a[2], a[3]].map(v => fromBytes32(String(v)).toLowerCase());
  const [inputAmount, outputAmount, destination] = [a[4], a[5], a[6]] as bigint[];
  const fillDeadline = a[9] as number;
  const message = a[11] as Hex;
  const dest = chainLabel(destination);
  // Paying with the native coin: the deposit names the wrapped token and sends the amount as value.
  const nativeIn = tx.value > 0n && tx.value === inputAmount;
  const sent = nativeIn ? await amountOf(env, tx.chainId, NATIVE_ALIASES[0], inputAmount) : await amountOf(env, tx.chainId, inputToken, inputAmount);
  const out = CHAINS[Number(destination)] ? builtinTokens(Number(destination)).find(t => sameAddress(t.address, outputToken)) : undefined;
  const received = out ? `${formatUnits(outputAmount, out.decimals)} ${out.symbol}` : `${outputAmount} base units of token ${shortAddress(outputToken)}`;
  const toYou = sameAddress(recipient, tx.from);
  const b = new PreviewBuilder().detail('Contract', `Across SpokePool (${tx.to})`, tx.to!).detail('Destination', dest, destination.toString())
    .detail('You send', sent).detail('Received there (at least)', received).detail('Recipient', toYou ? `you (${recipient})` : recipient, recipient);
  const fill = utcDate(fillDeadline, true);
  if (fill) b.detail('Fill deadline', fill);
  if (!toYou) b.warn('caution', 'recipient_not_sender', `The bridged funds go to ${recipient} on ${dest}, not to your address.`);
  else b.warn('info', 'bridge_same_address', `The bridged funds go to your address on ${dest}. If your account is a smart-contract wallet, check you control the same address there.`);
  if (!sameAddress(depositor, tx.from)) b.warn('caution', 'bridge_refund_other', `If no relayer fills the deposit, the refund goes to the depositor ${depositor}, not to you.`);
  if (message !== '0x') b.warn('info', 'bridge_message', `The deposit carries a message (${(message.length - 2) / 2} bytes) for the recipient, which can run code on ${dest} when the funds arrive.`);
  const info = nativeIn ? { decimals: CHAINS[tx.chainId]?.nativeDecimals ?? 18, symbol: CHAINS[tx.chainId]?.nativeSymbol ?? 'native' } : await tokenInfo(env, tx.chainId, inputToken);
  return decoded({ title: `Bridge ${sent} to ${dest} through Across`, summary: `Deposits ${sent} into Across; a relayer pays ${toYou ? 'you' : shortAddress(recipient)} at least ${received} on ${dest}${fill ? `, if it fills by ${fill}` : ''}.`, decoder: 'across_deposit', status: out ? 'full' : 'partial', b,
    assetChanges: info ? [{ direction: 'out', account: tx.from, amount: formatUnits(inputAmount, info.decimals), symbol: info.symbol, raw: inputAmount.toString(), asset: nativeIn ? 'native' : inputToken, basis: 'requested', standard: nativeIn ? 'native' : 'erc20' }] : [] });
};

// --- OKX DEX router (Ethereum; Arbitrum One, identified by its selectors and checked against receipts) ---
const OKX: Record<string, number> = { '0x8feab81d36e7576107d5de0758c1b839be31b4f6': 1, '0x09f94b5fc68e227c323a6fbae3bd98c97fd8c849': 42161 };
const BASE_REQUEST = '(uint256 fromToken, address toToken, uint256 fromTokenAmount, uint256 minReturnAmount, uint256 deadLine) baseRequest';
const ROUTER_PATH = '(address[] mixAdapters, address[] assetTo, uint256[] rawData, bytes[] extraData, uint256 fromToken)[] paths';
const OKX_ABI = parseAbi([
  `function dagSwapByOrderId(uint256 orderId, ${BASE_REQUEST}, ${ROUTER_PATH}) payable returns (uint256)`,
  `function dagSwapTo(uint256 orderId, address receiver, ${BASE_REQUEST}, ${ROUTER_PATH}) payable returns (uint256)`,
  `function smartSwapByOrderId(uint256 orderId, ${BASE_REQUEST}, uint256[] batchesAmount, (address[] mixAdapters, address[] assetTo, uint256[] rawData, bytes[] extraData, uint256 fromToken)[][] batches, (uint256 pathIndex, address payer, address fromToken, address toToken, uint256 fromTokenAmountMax, uint256 toTokenAmountMax, uint256 salt, uint256 deadLine, bool isPushOrder, bytes extension)[] extraData) payable returns (uint256)`,
  `function uniswapV3SwapToWithBaseRequest(uint256 orderId, address receiver, ${BASE_REQUEST}, uint256[] pools) payable returns (uint256)`,
  'function unxswapByOrderId(uint256 srcToken, uint256 amount, uint256 minReturn, bytes32[] pools) payable returns (uint256)',
  'function unxswapTo(uint256 srcToken, uint256 amount, uint256 minReturn, address receiver, bytes32[] pools) payable returns (uint256)',
  'function uniswapV3SwapTo(uint256 receiver, uint256 amount, uint256 minReturn, uint256[] pools) payable returns (uint256)',
]);

/** The output token of a chain of v2/v3 pools from `input`, each pool in a word's low 160 bits (token0/token1 read on-chain). */
async function poolChainOutput(env: AdapterEnv, chainId: number, input: string, pools: bigint[]): Promise<string | null> {
  return unoswapOutput(env, chainId, input, pools.map(p => p & ADDRESS_MASK));
}

const okxAdapter: Adapter = async (tx, env) => {
  const chain = tx.to && OKX[tx.to.toLowerCase()];
  if (!chain || chain !== tx.chainId) return null;
  let call;
  try { call = decodeFunctionData({ abi: OKX_ABI, data: tx.data }); } catch { return null; }
  const b = new PreviewBuilder().detail('Contract', `OKX DEX router (${tx.to})`, tx.to!);
  let src: string, dst: string | null, amount: bigint, minReturn: bigint, receiver = tx.from;
  const weth = wrappedNative(tx.chainId) ?? NATIVE_ALIASES[0];
  const req = (call.args as readonly unknown[]).find(a => !!a && typeof a === 'object' && !Array.isArray(a) && 'toToken' in a) as { fromToken: bigint; toToken: string; fromTokenAmount: bigint; minReturnAmount: bigint } | undefined;
  if (req) {
    const args = call.args as readonly unknown[];
    src = addressOf(req.fromToken); dst = req.toToken; amount = req.fromTokenAmount; minReturn = req.minReturnAmount;
    if (call.functionName === 'dagSwapTo' || call.functionName === 'uniswapV3SwapToWithBaseRequest') receiver = args[1] as string;
  } else if (call.functionName === 'uniswapV3SwapTo') {
    const [to, amt, min, pools] = call.args as readonly [bigint, bigint, bigint, readonly bigint[]];
    receiver = addressOf(to); amount = amt; minReturn = min;
    // The first pool's top bit says which way it is swapped (set: token1 in, token0 out), which names the input.
    let first: string | null = null;
    try { first = env.deps.rpc?.has(tx.chainId) ? `0x${String(await env.deps.rpc.call(tx.chainId, 'eth_call', [{ to: addressOf(pools[0]), data: pools[0] >> 255n ? '0xd21220a7' : '0x0dfe1681' }, 'latest'])).slice(-40)}` : null; } catch { first = null; }
    src = tx.value > 0n && first && sameAddress(first, weth) ? NATIVE_ALIASES[0] : first ?? NATIVE_ALIASES[0];
    dst = first ? await poolChainOutput(env, tx.chainId, first, [...pools]) : null;
    // Bit 253 of the last pool: the WETH out is unwrapped and paid as ETH (checked against receipts).
    if (dst && sameAddress(dst, weth) && (pools[pools.length - 1] >> 253n) & 1n) dst = NATIVE_ALIASES[0];
  } else {
    const args = call.args as readonly unknown[];
    const pools = (args[args.length - 1] as readonly Hex[]).map(p => BigInt(p));
    src = addressOf(args[0] as bigint); amount = args[1] as bigint; minReturn = args[2] as bigint;
    if (call.functionName === 'unxswapTo') receiver = args[3] as string;
    dst = await poolChainOutput(env, tx.chainId, isNative(src) ? weth : src, pools);
    // Bit 254 of the last pool (bit 255 is its direction): the WETH out is paid as ETH (checked against receipts).
    if (dst && sameAddress(dst, weth) && (pools[pools.length - 1] >> 254n) & 1n) dst = NATIVE_ALIASES[0];
  }
  const sent = await amountOf(env, tx.chainId, src, amount);
  const least = dst ? await amountOf(env, tx.chainId, dst, minReturn) : `${minReturn} base units of the output token`;
  b.detail('You send', sent).detail('You receive at least', least);
  if (!sameAddress(receiver, tx.from)) {
    b.detail('Recipient', receiver);
    b.warn('caution', 'recipient_not_sender', `The tokens you buy go to ${shortAddress(receiver)}, not to you.`);
  }
  if (minReturn <= 1n) b.warn('caution', 'no_slippage_limit', 'Nothing limits the price: the minimum received is zero, so the swap would go through at any rate.');
  return decoded({ title: `Swap ${sent} for at least ${least} on OKX DEX`, summary: `Swaps ${sent} through OKX's DEX router, for at least ${least}.`, decoder: 'okx_dex', status: dst ? 'full' : 'partial', b });
};

// --- KyberSwap MetaAggregationRouterV2 (same address on Ethereum, Arbitrum One and HyperEVM; ABI verified on Sourcify) ---
const KYBER = '0x6131b5fae19ea4f9d964eac0408e4408b66337b5';
const KYBER_DESC = '(address srcToken, address dstToken, address[] srcReceivers, uint256[] srcAmounts, address[] feeReceivers, uint256[] feeAmounts, address dstReceiver, uint256 amount, uint256 minReturnAmount, uint256 flags, bytes permit) desc';
const KYBER_ABI = parseAbi([
  `function swap((address callTarget, address approveTarget, bytes targetData, ${KYBER_DESC}, bytes clientData) execution) payable returns (uint256, uint256)`,
  `function swapSimpleMode(address caller, ${KYBER_DESC}, bytes executorData, bytes clientData) returns (uint256, uint256)`,
]);

const kyberAdapter: Adapter = async (tx, env) => {
  if (!tx.to || tx.to.toLowerCase() !== KYBER) return null;
  let call;
  try { call = decodeFunctionData({ abi: KYBER_ABI, data: tx.data }); } catch { return null; }
  const d = call.functionName === 'swap' ? call.args[0].desc : call.args[1];
  const sent = await amountOf(env, tx.chainId, d.srcToken, d.amount);
  const least = await amountOf(env, tx.chainId, d.dstToken, d.minReturnAmount);
  const b = new PreviewBuilder().detail('Contract', `KyberSwap MetaAggregationRouterV2 (${KYBER})`, KYBER).detail('You send', sent).detail('You receive at least', least);
  // Integrator fees, taken from the input or the output (in basis points or as amounts, by the flags).
  if (d.feeReceivers.length) b.detail('Fees paid to', d.feeReceivers.map(r => shortAddress(r)).join(', '));
  if (!/^0x0{40}$/.test(d.dstReceiver) && !sameAddress(d.dstReceiver, tx.from)) {
    b.detail('Recipient', d.dstReceiver);
    b.warn('caution', 'recipient_not_sender', `The tokens you buy go to ${shortAddress(d.dstReceiver)}, not to you.`);
  }
  if (d.minReturnAmount <= 1n) b.warn('caution', 'no_slippage_limit', 'Nothing limits the price: the minimum received is zero, so the swap would go through at any rate.');
  return decoded({ title: `Swap ${sent} for at least ${least} on KyberSwap`, summary: `Swaps ${sent} through KyberSwap's aggregator, for at least ${least}.`, decoder: 'kyberswap', status: 'full', b });
};

export const aggregatorAdapters: Adapter[] = [oneInchAdapter, metaMaskAdapter, acrossAdapter, okxAdapter, kyberAdapter];
