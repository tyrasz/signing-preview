// LI.FI's diamond (a bridge and swap aggregator behind many wallets and apps). Every bridge function on it, whatever
// the bridge (startBridgeTokensVia<Bridge>, swapAndStartBridgeTokensVia<Bridge>), takes the same BridgeData struct
// first, then the source swaps if any, then the bridge's own data; its swap functions (GenericSwapFacet V3) take a
// receiver, a minimum and swap steps. Those shared prefixes are read here, whichever facet the call goes to.
// Structs from lifinance/contracts: ILiFi.BridgeData, LibSwap.SwapData, GenericSwapFacetV3.
import { decodeAbiParameters, type Hex } from 'viem';
import { formatUnits, PreviewBuilder, sameAddress, shortAddress } from '../format.ts';
import { CHAINS } from '../chains.ts';
import { decoded, tokenInfo, type Adapter, type AdapterEnv } from './common.ts';
import { chainLabel } from './universal-router.ts';

// The same diamond on every chain here (verified on Sourcify as LiFiDiamond on Base, OP Mainnet, Polygon and BNB Chain).
const LIFI: Record<string, number[]> = { '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae': [1, 42161, 8453, 10, 137, 56] };
const BRIDGE_DATA = { type: 'tuple', components: [
  { name: 'transactionId', type: 'bytes32' }, { name: 'bridge', type: 'string' }, { name: 'integrator', type: 'string' }, { name: 'referrer', type: 'address' },
  { name: 'sendingAssetId', type: 'address' }, { name: 'receiver', type: 'address' }, { name: 'minAmount', type: 'uint256' }, { name: 'destinationChainId', type: 'uint256' },
  { name: 'hasSourceSwaps', type: 'bool' }, { name: 'hasDestinationCall', type: 'bool' }] } as const;
const SWAP_DATA = { type: 'tuple', components: [
  { name: 'callTo', type: 'address' }, { name: 'approveTo', type: 'address' }, { name: 'sendingAssetId', type: 'address' }, { name: 'receivingAssetId', type: 'address' },
  { name: 'fromAmount', type: 'uint256' }, { name: 'callData', type: 'bytes' }, { name: 'requiresDeposit', type: 'bool' }] } as const;
/** LI.FI's placeholder receiver for non-EVM destinations (the real one is in the bridge's own data). */
const NON_EVM_RECEIVER = '0x11f111f111f111f111f111f111f111f111f111f1';
const NON_EVM_CHAINS: Record<string, string> = { '1151111081099710': 'Solana', '20000000000001': 'Bitcoin', '9270000000000000': 'Sui' };
const isNative = (a: string) => /^0x0{40}$/.test(a);
const printable = (s: string) => s.length > 0 && s.length < 64 && /^[\x20-\x7e]+$/.test(s);

async function amountOf(env: AdapterEnv, chainId: number, token: string, raw: bigint): Promise<string> {
  const chain = CHAINS[chainId];
  if (isNative(token)) return `${formatUnits(raw, chain?.nativeDecimals ?? 18)} ${chain?.nativeSymbol ?? 'ETH'}`;
  const t = await tokenInfo(env, chainId, token);
  return t ? `${formatUnits(raw, t.decimals)} ${t.symbol}` : `${raw} base units of ${shortAddress(token)}`;
}

type SwapStep = { sendingAssetId: string; receivingAssetId: string; fromAmount: bigint };

export const lifiAdapter: Adapter = async (tx, env) => {
  const chains = tx.to && LIFI[tx.to.toLowerCase()];
  if (!chains || !chains.includes(tx.chainId) || tx.data.length < 10 + 64 * 4) return null;
  const args = `0x${tx.data.slice(10)}` as Hex;
  const b = new PreviewBuilder().detail('Contract', `LI.FI (${tx.to})`, tx.to!);
  // A bridge: BridgeData first (and the source swaps second when it has them).
  let bridge: { bridge: string; integrator: string; sendingAssetId: string; receiver: string; minAmount: bigint; destinationChainId: bigint; hasSourceSwaps: boolean; hasDestinationCall: boolean } | undefined;
  try { bridge = (decodeAbiParameters([BRIDGE_DATA], args) as unknown as [NonNullable<typeof bridge>])[0]; } catch { bridge = undefined; }
  if (bridge && printable(bridge.bridge) && bridge.destinationChainId > 0n) {
    let swaps: readonly SwapStep[] = [];
    if (bridge.hasSourceSwaps) { try { swaps = (decodeAbiParameters([BRIDGE_DATA, { type: 'tuple[]', components: SWAP_DATA.components }], args) as unknown as [unknown, readonly SwapStep[]])[1]; } catch { swaps = []; } }
    const dest = NON_EVM_CHAINS[bridge.destinationChainId.toString()] ?? chainLabel(bridge.destinationChainId);
    const bridged = await amountOf(env, tx.chainId, bridge.sendingAssetId, bridge.minAmount);
    const sent = swaps.length ? await amountOf(env, tx.chainId, swaps[0].sendingAssetId, swaps.filter(s => sameAddress(s.sendingAssetId, swaps[0].sendingAssetId)).reduce((t, s) => t + s.fromAmount, 0n)) : bridged;
    b.detail('Bridge', bridge.bridge).detail('Destination', dest, bridge.destinationChainId.toString()).detail('You send', sent);
    if (swaps.length) b.detail('Swapped first into (at least)', bridged);
    if (printable(bridge.integrator)) b.detail('Integrator', bridge.integrator);
    const receiver = bridge.receiver.toLowerCase();
    if (sameAddress(receiver, NON_EVM_RECEIVER)) b.warn('info', 'bridge_non_evm', `The destination is ${dest}: the recipient there is in the bridge's own data, which isn't decoded here.`);
    else if (!sameAddress(receiver, tx.from)) { b.detail('Recipient', receiver); b.warn('caution', 'recipient_not_sender', `The bridged funds go to ${receiver} on ${dest}, not to your address.`); }
    else { b.detail('Recipient', `you (${receiver})`, receiver); b.warn('info', 'bridge_same_address', `The bridged funds go to your address on ${dest}. If your account is a smart-contract wallet, check you control the same address there.`); }
    if (bridge.hasDestinationCall) b.warn('info', 'bridge_message', `The bridge also runs a call on ${dest} when the funds arrive.`);
    return decoded({ title: `${swaps.length ? 'Swap and bridge' : 'Bridge'} ${sent} to ${dest} via ${bridge.bridge} (LI.FI)`, summary: `Sends ${sent} through LI.FI's ${bridge.bridge} route to ${dest}${swaps.length ? `, swapped first into at least ${bridged}` : ''}.`, decoder: 'lifi', status: 'full', b });
  }
  // A swap on this chain (GenericSwapFacet V3): transaction id, integrator, referrer, receiver, minimum out, steps.
  for (const steps of [{ type: 'tuple[]', components: SWAP_DATA.components } as const, SWAP_DATA]) {
    let r: readonly unknown[];
    try { r = decodeAbiParameters([{ type: 'bytes32' }, { type: 'string' }, { type: 'string' }, { type: 'address' }, { type: 'uint256' }, steps], args); } catch { continue; }
    const [, integrator, , receiver, minOut, s] = r as [Hex, string, string, string, bigint, SwapStep | readonly SwapStep[]];
    const list = Array.isArray(s) ? s as readonly SwapStep[] : [s as SwapStep];
    if (!list.length || !printable(integrator)) continue;
    const sent = await amountOf(env, tx.chainId, list[0].sendingAssetId, list[0].fromAmount);
    const got = await amountOf(env, tx.chainId, list[list.length - 1].receivingAssetId, minOut);
    b.detail('You send', sent).detail('You receive at least', got).detail('Integrator', integrator);
    if (!sameAddress(receiver, tx.from)) { b.detail('Recipient', receiver); b.warn('caution', 'recipient_not_sender', `The tokens you buy go to ${shortAddress(receiver)}, not to you.`); }
    if (minOut <= 1n) b.warn('caution', 'no_slippage_limit', 'Nothing limits the price: the minimum received is zero, so the swap would go through at any rate.');
    return decoded({ title: `Swap ${sent} for at least ${got} (LI.FI)`, summary: `Swaps ${sent} through LI.FI, for at least ${got}.`, decoder: 'lifi', status: 'full', b });
  }
  return null;
};
