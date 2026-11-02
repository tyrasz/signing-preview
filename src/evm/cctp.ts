import { decodeFunctionData, parseAbi, type Hex } from 'viem';
import { formatUnits, PreviewBuilder, sameAddress, shortAddress } from '../format.ts';
import { CCTP, chainName } from '../chains.ts';
import { decoded, type Adapter } from './common.ts';

const ABI = parseAbi([
  'function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)',
  'function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData)',
]);

// "cctp-forward" in ASCII, right-padded to 24 bytes.
const HOOK_MAGIC = '0x' + '636374702d666f7277617264'.padEnd(48, '0');

const bytes32ToAddress = (word: Hex): string | null => /^0x0{24}[0-9a-f]{40}$/i.test(word) ? '0x' + word.slice(26).toLowerCase() : null;

/** Parses the 56-byte HyperCore forwarding hook: magic(24) | version(4) | length(4)=24 | recipient(20) | dex(4). */
export function parseForwardHook(hook: Hex): { recipient: string; dex: number } | { error: string } {
  const h = hook.toLowerCase();
  if (h.length !== 2 + 56 * 2) return { error: `hook is ${(h.length - 2) / 2} bytes, expected 56` };
  if (h.slice(0, 50) !== HOOK_MAGIC) return { error: 'hook does not start with "cctp-forward"' };
  if (h.slice(50, 58) !== '00000000') return { error: 'unknown hook version' };
  if (h.slice(58, 66) !== '00000018') return { error: 'unexpected hook payload length' };
  return { recipient: '0x' + h.slice(66, 106), dex: Number.parseInt(h.slice(106, 114), 16) };
}

/** Circle CCTP V2 burns on Ethereum/Arbitrum, including the HyperCore forwarding route. */
export const cctpAdapter: Adapter = async (tx) => {
  if (!tx.to || !sameAddress(tx.to, CCTP.tokenMessengerV2)) return null;
  let call;
  try { call = decodeFunctionData({ abi: ABI, data: tx.data }); } catch { return null; }
  const [amount, domain, mintRecipientWord, burnToken, callerWord, maxFee, finality] = call.args as unknown as [bigint, number, Hex, string, Hex, bigint, number];
  const hook = call.functionName === 'depositForBurnWithHook' ? (call.args as unknown as unknown[])[7] as Hex : null;
  const b = new PreviewBuilder();
  const usdc = CCTP.usdcByChain[tx.chainId];
  const isUsdc = sameAddress(burnToken, usdc);
  const amountText = isUsdc ? `${formatUnits(amount, 6)} USDC` : `${amount} base units of ${burnToken}`;
  const destination = CCTP.domains[domain] ?? `CCTP domain ${domain}`;
  const mintRecipient = bytes32ToAddress(mintRecipientWord);
  const caller = bytes32ToAddress(callerWord);
  b.detail('Source chain', chainName(tx.chainId))
    .detail('Burn amount', amountText, amount.toString())
    .detail('Destination', destination, String(domain))
    .detail('Maximum fee', isUsdc ? `${formatUnits(maxFee, 6)} USDC (cap, not a quote)` : maxFee.toString(), maxFee.toString())
    .detail('Finality', CCTP.finality[finality] ?? `threshold ${finality}`, String(finality));
  if (!isUsdc) b.warn('danger', 'cctp_not_usdc', 'The burn token is not native USDC on this chain. CCTP only burns native USDC; this call will fail or is not what it appears to be.');
  if (maxFee >= amount && amount > 0n) b.warn('danger', 'cctp_fee_exceeds_amount', 'The maximum fee is at least the transfer amount, so you could receive nothing.');
  b.note('The burn amount is what leaves your wallet. The credited amount is the burn amount minus the CCTP fee actually charged (up to the maximum).');

  const forwardToCore = domain === CCTP.hyperEvmDomain && mintRecipient && sameAddress(mintRecipient, CCTP.hyperCoreForwarder) && hook !== null;
  if (forwardToCore) {
    const parsed = parseForwardHook(hook);
    if ('error' in parsed) {
      b.warn('danger', 'cctp_bad_hook', `The HyperCore forwarding data is malformed (${parsed.error}). Funds could end up stuck at the forwarder.`);
      return decoded({ title: `Bridge ${amountText} toward HyperCore (malformed)`, summary: 'A CCTP transfer to the HyperCore forwarder whose forwarding instructions could not be read.', decoder: 'cctp_hypercore', status: 'partial', b });
    }
    const dex = CCTP.dexes[parsed.dex];
    b.detail('HyperCore recipient', parsed.recipient).detail('HyperCore balance', dex ?? `dex ${parsed.dex}`, String(parsed.dex));
    if (!caller || !sameAddress(caller, CCTP.hyperCoreForwarder)) b.warn('caution', 'cctp_caller', 'The destination caller is not the forwarder, so the forwarding step might not run.');
    if (!dex) b.warn('caution', 'cctp_unknown_dex', `Destination DEX ${parsed.dex} is not perps (0) or spot (4294967295).`);
    if (!sameAddress(parsed.recipient, tx.from)) b.warn('caution', 'recipient_not_sender', `The USDC will be credited to a different HyperCore account (${shortAddress(parsed.recipient)}), not yours.`);
    if (/^0x0{40}$/.test(parsed.recipient)) b.warn('danger', 'zero_recipient', 'The HyperCore recipient is the zero address.');
    return decoded({
      title: `Bridge ${amountText} to Hyperliquid ${dex ?? ''}`.trim(),
      summary: `Burns ${amountText} on ${chainName(tx.chainId)} via Circle CCTP; it is minted on HyperEVM and forwarded to ${sameAddress(parsed.recipient, tx.from) ? 'your' : shortAddress(parsed.recipient) + "'s"} HyperCore ${dex ?? ''} balance.`,
      decoder: 'cctp_hypercore', status: isUsdc ? 'full' : 'partial', b,
      assetChanges: isUsdc ? [{ direction: 'out', account: tx.from, amount: formatUnits(amount, 6), symbol: 'USDC', raw: amount.toString(), asset: burnToken.toLowerCase(), basis: 'requested' }] : [],
    });
  }
  b.detail('Recipient on destination', mintRecipient ?? mintRecipientWord, mintRecipientWord);
  if (hook) b.detail('Hook data', `${(hook.length - 2) / 2} bytes`, hook);
  if (!mintRecipient) b.warn('caution', 'cctp_non_evm_recipient', 'The recipient is not an EVM address; check it matches the destination chain format.');
  else if (!sameAddress(mintRecipient, tx.from)) b.warn('caution', 'recipient_not_sender', `The USDC will be minted to ${shortAddress(mintRecipient)}, not to your address.`);
  return decoded({
    title: `Bridge ${amountText} to ${destination}`,
    summary: `Burns ${amountText} on ${chainName(tx.chainId)} via Circle CCTP and mints it to ${mintRecipient ? shortAddress(mintRecipient) : 'the recipient'} on ${destination}.`,
    decoder: 'cctp_v2', status: isUsdc ? 'full' : 'partial', b,
    assetChanges: isUsdc ? [{ direction: 'out', account: tx.from, amount: formatUnits(amount, 6), symbol: 'USDC', raw: amount.toString(), asset: burnToken.toLowerCase(), basis: 'requested' }] : [],
  });
};
