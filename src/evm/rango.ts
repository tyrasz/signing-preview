// Rango's router (a bridge and swap aggregator: Trust Wallet's cross-chain swaps go through it): an EIP-2535 diamond
// at one address on every chain here. The facets behind its swap and bridge functions are verified on Sourcify
// (RangoSwapperFacet, RangoGenericBridgeFacet): Ethereum's and OP Mainnet's are one build of the published sources,
// BNB Chain's, Polygon's, Arbitrum One's and Base's another build of the same sources, file for file. HyperEVM's
// bridge facet is that second build; its older swap facet isn't published, so the older swap isn't read there.
// Read from the sources (2026-11-25):
//
//  - onChainSwaps(request, calls, receiver), in two shapes of request (the swapper facet's, with three fees; the
//    bridge facet's, with a list of them): takes amountIn of fromToken from the sender (coin as msg.value), and the
//    fees on top when feeFromInputToken; pays the fees; makes the calls, each to a contract and function that
//    Rango's owner has allow-listed; requires that it then holds minimumAmountExpected more of toToken (after the
//    fees, when they come out of what was bought); and sends all it gained to `receiver`. A call marked
//    needsTransferFromUser takes its own amount of its own token from the sender besides.
//  - genericBridge(bridgeRequest, request): takes amount + totalAffiliateFee of token, pays the fees, approves the
//    bridge's spender and makes the bridge's calls as given. The destination and recipient it names go into its
//    event; what the bridge does with the tokens is in those calls' own data, which isn't read here.
//  - genericSwapAndBridge(request, calls, bridgeRequest): the swap, then the bridge with what it bought.
//
// Half the "swaps" mined ask nothing back: a minimum of zero, and no call that buys the token the request names (the
// call hands the tokens to a cross-chain service, which is how Trust Wallet's routes to Tron, Bitcoin and Solana
// go). On this chain those are a transfer into that service, and are shown as that.
// Checked against the receipts of mined transactions on Ethereum, BNB Chain, Polygon, Arbitrum One and Base
// (2026-11-25): what the sender paid, and what the receiver got against the minimum (figures in the README).
import { decodeFunctionData, parseAbi } from 'viem';
import { formatUnits, PreviewBuilder, sameAddress, shortAddress } from '../format.ts';
import { CHAINS } from '../chains.ts';
import type { AssetChange } from '../types.ts';
import { decoded, tokenInfo, type Adapter, type AdapterEnv } from './common.ts';
import { chainLabel } from './universal-router.ts';

export const RANGO = '0x69460570c93f9de5e2edbc3052bf10125f0ca22d';
/** The chains whose bridge facet runs the published source, and those whose older swap facet does. */
const BRIDGE_FACET = [1, 10, 56, 137, 42161, 8453, 999], SWAPPER_FACET = [1, 10, 56, 137, 42161, 8453];
const OLD_SWAP = '0x14d08fca';
export const RANGO_ABI = parseAbi([
  'struct Fee { address affiliatorAddress; uint256 amount; uint8 feeType; }',
  'struct Call { address spender; address target; address swapFromToken; address swapToToken; bool needsTransferFromUser; uint256 amount; bytes callData; }',
  'struct OldSwap { address requestId; address fromToken; address toToken; uint256 amountIn; uint256 platformFee; uint256 destinationExecutorFee; uint256 affiliateFee; address affiliatorAddress; uint256 minimumAmountExpected; bool feeFromInputToken; uint16 dAppTag; string dAppName; }',
  'struct Swap { address requestId; address fromToken; address toToken; uint256 amountIn; Fee[] affiliateFees; uint256 totalAffiliateFee; uint256 minimumAmountExpected; bool feeFromInputToken; uint16 dAppTag; string dAppName; }',
  'struct BridgeCall { address target; address spender; bytes data; uint256 startIndexForAmount; uint256 nativeValueToSend; bool valueIsBridgeAmount; }',
  'struct Bridge { uint8 bridgeId; BridgeCall[] calls; address recipient; uint256 dstChainId; bool hasInterchainMessage; bool hasDestinationSwap; uint256 extraFee; uint256 extraERC20Fee; }',
  'struct BridgeRequest { address requestId; address token; uint256 amount; Fee[] affiliateFees; uint256 totalAffiliateFee; uint16 dAppTag; string dAppName; }',
  'function onChainSwaps(OldSwap request, Call[] calls, address receiver) payable returns (bytes[])',
  'function onChainSwaps(Swap request, Call[] calls, address receiver) payable returns (bytes[])',
  'function genericSwapAndBridge(Swap request, Call[] calls, Bridge bridgeRequest) payable',
  'function genericBridge(Bridge bridgeRequest, BridgeRequest request) payable',
]);
type Call = { target: string; swapFromToken: string; swapToToken: string; needsTransferFromUser: boolean; amount: bigint };
type Swap = { fromToken: string; toToken: string; amountIn: bigint; minimumAmountExpected: bigint; feeFromInputToken: boolean; dAppName: string;
  platformFee?: bigint; destinationExecutorFee?: bigint; affiliateFee?: bigint; totalAffiliateFee?: bigint };
type Bridge = { bridgeId: number; calls: readonly { target: string }[]; recipient: string; dstChainId: bigint; hasInterchainMessage: boolean; hasDestinationSwap: boolean };

/**
 * A destination that isn't an EVM chain is named by letters of its name, as a number: "TRON", "BTC", the last four of
 * "SOLANA" (24, 10 and 13 of 87 bridges mined on Ethereum and BNB Chain, 2026-11-25).
 */
const TAGS: Record<string, string> = { '4346947': 'Bitcoin', '1414680398': 'Tron', '1279348289': 'Solana' };
const isZero = (a: string) => /^0x0{40}$/.test(a);
const printable = (s: string) => s.length > 0 && s.length < 64 && /^[\x20-\x7e]+$/.test(s);
/** The letters a number spells, where it spells capitals and digits only (a destination's tag). */
function letters(n: bigint): string | undefined {
  let s = '';
  for (let v = n; v > 0n; v >>= 8n) s = String.fromCharCode(Number(v & 0xffn)) + s;
  return /^[A-Z0-9]{3,8}$/.test(s) ? s : undefined;
}
function destinationOf(id: bigint): { name: string; evm: boolean } {
  const known = TAGS[id.toString()];
  if (known) return { name: known, evm: false };
  const label = chainLabel(id), tag = letters(id);
  return /^chain \d+$/.test(label) && tag ? { name: `"${tag}" (as Rango names it; not an EVM chain)`, evm: false } : { name: label, evm: true };
}
/** A recipient off the EVM is given as the first twenty characters of its address there, in an address's place. */
function recipientText(recipient: string): string | undefined {
  const s = (recipient.slice(2).match(/../g) ?? []).map(h => String.fromCharCode(parseInt(h, 16))).join('').replace(/\0+$/, '');
  return /^[\x21-\x7e]{6,20}$/.test(s) ? s : undefined;
}

async function asset(env: AdapterEnv, chainId: number, token: string, raw: bigint): Promise<{ text: string; change?: Omit<AssetChange, 'direction' | 'account'> }> {
  const chain = CHAINS[chainId];
  if (isZero(token)) {
    const decimals = chain?.nativeDecimals ?? 18, symbol = chain?.nativeSymbol ?? 'ETH';
    return { text: `${formatUnits(raw, decimals)} ${symbol}`, change: { amount: formatUnits(raw, decimals), symbol, raw: raw.toString(), asset: 'native', basis: 'requested', standard: 'native' } };
  }
  const t = await tokenInfo(env, chainId, token);
  return t ? { text: `${formatUnits(raw, t.decimals)} ${t.symbol}`, change: { amount: formatUnits(raw, t.decimals), symbol: t.symbol, raw: raw.toString(), asset: token.toLowerCase(), basis: 'requested', standard: 'erc20' } }
    : { text: `${raw} base units of ${shortAddress(token)}` };
}

/** The fee's share of `of`, warned of from 1% (Trust Wallet's is 0.8%, the others seen 0.35% to 0.95%). */
function feeWarning(b: PreviewBuilder, fee: bigint, of: bigint, what: string): void {
  if (fee === 0n || of === 0n) return;
  const bps = fee * 10_000n / of;
  if (bps >= 1000n) b.warn('danger', 'large_fee_portion', `${formatUnits(bps, 2)}% of ${what} goes in fees. Wallet and router fees are normally under 1%.`);
  else if (bps >= 100n) b.warn('caution', 'large_fee_portion', `${formatUnits(bps, 2)}% of ${what} goes in fees.`);
}

/** The bridge's part: where the request says the tokens go. Its own calls decide, and aren't read. */
function bridgeTerms(b: PreviewBuilder, bridge: Bridge, from: string): { dest: string } {
  const { name: dest, evm } = destinationOf(bridge.dstChainId), recipient = bridge.recipient.toLowerCase();
  b.detail('Destination', dest, bridge.dstChainId.toString());
  const targets = [...new Set(bridge.calls.map(c => c.target.toLowerCase()))];
  if (targets.length) b.detail('Bridge contract', targets.join(', '), targets[0]);
  if (!evm) {
    const text = recipientText(recipient);
    if (text) b.detail('Recipient', `an address on ${dest.replace(/ \(.*$/, '')} starting "${text}"`);
    b.warn('info', 'bridge_non_evm', `The destination is ${dest}: the recipient there is in the bridge's own data, which isn't decoded here${text ? `. The request names one starting "${text}"` : ''}.`);
  } else if (!sameAddress(recipient, from)) {
    b.detail('Recipient', recipient);
    b.warn('caution', 'recipient_not_sender', `The request names ${recipient} as the recipient on ${dest}, not your address.`);
  } else {
    b.detail('Recipient', `you (${recipient})`, recipient);
    b.warn('info', 'bridge_same_address', `The request names your address as the recipient on ${dest}. If your account is a smart-contract wallet, check you control the same address there.`);
  }
  if (bridge.hasInterchainMessage || bridge.hasDestinationSwap) b.warn('info', 'bridge_message', `The bridge also runs ${bridge.hasDestinationSwap ? 'a swap' : 'a call'} on ${dest} when the funds arrive.`);
  b.note("The destination and recipient are what the request names, which Rango's router records in its event. What the bridge does with the tokens is in its own call, to a contract Rango's owner has allow-listed, and isn't decoded here.");
  return { dest };
}

export const rangoAdapter: Adapter = async (tx, env) => {
  if (!tx.to || tx.to.toLowerCase() !== RANGO || tx.data.length < 10) return null;
  const selector = tx.data.slice(0, 10).toLowerCase();
  if (!(selector === OLD_SWAP ? SWAPPER_FACET : BRIDGE_FACET).includes(tx.chainId)) return null;
  let call: { functionName: string; args: readonly unknown[] };
  try { call = decodeFunctionData({ abi: RANGO_ABI, data: tx.data }) as never; } catch { return null; }
  const b = new PreviewBuilder().detail('Contract', `Rango (${RANGO})`, RANGO);
  const changes: AssetChange[] = [];
  const integrator = (name: string) => { if (printable(name)) b.detail('Integrator', name); };

  if (call.functionName === 'genericBridge') {
    const [bridge, request] = call.args as [Bridge, { token: string; amount: bigint; totalAffiliateFee: bigint; dAppName: string }];
    const sent = await asset(env, tx.chainId, request.token, request.amount + request.totalAffiliateFee);
    b.detail('You send', sent.text, isZero(request.token) ? undefined : request.token.toLowerCase());
    if (request.totalAffiliateFee > 0n) b.detail('Fee', `${(await asset(env, tx.chainId, request.token, request.totalAffiliateFee)).text}, out of what you send`);
    // Coin sent with the call beyond what is bridged: what the bridge charges, which the router passes on.
    const over = tx.value - (isZero(request.token) ? request.amount + request.totalAffiliateFee : 0n);
    if (over > 0n) b.detail("Bridge's own fee", `${(await asset(env, tx.chainId, '0x0000000000000000000000000000000000000000', over)).text}, sent with the call`);
    integrator(request.dAppName);
    const { dest } = bridgeTerms(b, bridge, tx.from);
    feeWarning(b, request.totalAffiliateFee, request.amount + request.totalAffiliateFee, 'what you send');
    if (sent.change) changes.push({ ...sent.change, direction: 'out', account: tx.from });
    return decoded({ title: `Bridge ${sent.text} to ${dest} (Rango)`, summary: `Sends ${sent.text} through Rango's router to a bridge, for ${dest}.`, decoder: 'rango', status: 'partial', b, assetChanges: changes });
  }

  const [request, calls, last] = call.args as [Swap, readonly Call[], string | Bridge];
  const fees = request.totalAffiliateFee ?? (request.platformFee ?? 0n) + (request.destinationExecutorFee ?? 0n) + (request.affiliateFee ?? 0n);
  const taken = request.amountIn + (request.feeFromInputToken ? fees : 0n);
  const sent = await asset(env, tx.chainId, request.fromToken, taken);
  b.detail('You send', sent.text, isZero(request.fromToken) ? undefined : request.fromToken.toLowerCase());
  if (sent.change) changes.push({ ...sent.change, direction: 'out', account: tx.from });
  // A call that takes tokens of its own from the sender, besides the request's.
  for (const c of calls) {
    if (!c.needsTransferFromUser || isZero(c.swapFromToken) || c.amount === 0n) continue;
    const more = await asset(env, tx.chainId, c.swapFromToken, c.amount);
    b.detail('Also taken from you', `${more.text}, for the call to ${shortAddress(c.target.toLowerCase())}`, c.swapFromToken.toLowerCase());
    b.warn('caution', 'rango_call_takes_tokens', `Besides what the swap names, a call of the route takes ${more.text} from you (the router moves it with the allowance you gave it).`);
    if (more.change) changes.push({ ...more.change, direction: 'out', account: tx.from });
  }
  if (fees > 0n) b.detail('Fee', `${(await asset(env, tx.chainId, request.feeFromInputToken ? request.fromToken : request.toToken, fees)).text}, ${request.feeFromInputToken ? 'out of what you send' : 'out of what is bought'}`);
  integrator(request.dAppName);
  const targets = [...new Set(calls.map(c => c.target.toLowerCase()))];
  if (targets.length) b.detail('Route', targets.map(shortAddress).join(', '), targets[0]);
  feeWarning(b, fees, request.feeFromInputToken ? taken : request.minimumAmountExpected + fees, request.feeFromInputToken ? 'what you send' : 'what is bought');
  const bought = await asset(env, tx.chainId, request.toToken, request.minimumAmountExpected);
  /** Whether a call buys the token the request names: where none does and no minimum is asked, nothing comes back here. */
  const buys = calls.some(c => sameAddress(c.swapToToken, request.toToken));

  if (typeof last !== 'string') {
    b.detail('Swapped first into (at least)', bought.text, isZero(request.toToken) ? undefined : request.toToken.toLowerCase());
    const { dest } = bridgeTerms(b, last, tx.from);
    return decoded({ title: `Swap and bridge ${sent.text} to ${dest} (Rango)`, summary: `Swaps ${sent.text} into at least ${bought.text} through Rango's router and sends that to a bridge, for ${dest}.`, decoder: 'rango', status: 'partial', b, assetChanges: changes });
  }
  const receiver = last.toLowerCase();
  if (request.minimumAmountExpected === 0n && !buys) {
    const into = targets.length ? shortAddress(targets[targets.length - 1]) : 'a contract of the route';
    b.warn('info', 'bridge_terms_not_decoded', `This asks for nothing back on this chain: the tokens go into ${into}, a contract Rango's owner has allow-listed (a cross-chain service, as such routes are), and where they go from there is in its own call, which isn't decoded here. The simulation shows what comes back, if anything.`);
    return decoded({ title: `Send ${sent.text} into ${into} through Rango`, summary: `Sends ${sent.text} through Rango's router into ${into}, with nothing required back on this chain.`, decoder: 'rango', status: 'partial', b, assetChanges: changes });
  }
  b.detail('You receive at least', `${bought.text}${!request.feeFromInputToken && fees > 0n ? ', after the fee' : ''}`, isZero(request.toToken) ? undefined : request.toToken.toLowerCase());
  if (!sameAddress(receiver, tx.from)) { b.detail('Recipient', receiver); b.warn('caution', 'recipient_not_sender', `The tokens you buy go to ${shortAddress(receiver)}, not to you.`); }
  else if (bought.change && request.minimumAmountExpected > 0n) changes.push({ ...bought.change, direction: 'in', account: tx.from });
  if (request.minimumAmountExpected <= 1n) b.warn('caution', 'no_slippage_limit', "Rango's router asks for no minimum: the swap goes through at any rate, unless the exchange call inside carries a limit of its own, which isn't decoded here.");
  return decoded({ title: `Swap ${sent.text} for at least ${bought.text} (Rango)`, summary: `Swaps ${sent.text} through Rango's router, for at least ${bought.text}${sameAddress(receiver, tx.from) ? '' : `, sent to ${shortAddress(receiver)}`}.`, decoder: 'rango', status: 'full', b, assetChanges: changes });
};
