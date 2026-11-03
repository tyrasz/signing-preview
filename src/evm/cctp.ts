import { decodeFunctionData, parseAbi, type Hex } from 'viem';
import { formatTimestamp, formatUnits, PreviewBuilder, sameAddress, shortAddress } from '../format.ts';
import { CCTP, CCTP_NETWORKS, chainName, HYPEREVM_MAINNET, HYPEREVM_TESTNET, type CctpSourceNetwork } from '../chains.ts';
import type { AssetChange } from '../types.ts';
import { decoded, type Adapter, type Decoded } from './common.ts';

// Rules below mirror Circle's contracts:
//  - TokenMessengerV2._depositForBurn (evm-cctp-contracts @ a92a2b4): amount > 0, mintRecipient != 0,
//    maxFee < amount; depositForBurnWithHook requires non-empty hookData; fee executed <= maxFee.
//  - CctpExtension.batchDepositForBurnWithAuth (hyperevm-circle-contracts @ ffcc978): pulls the total via
//    EIP-3009 receiveWithAuthorization, then burns total / batchSize messages of batchSize each.
//  - CctpForwarder.mintAndForward + CctpForwarderHookData: mintRecipient must be the forwarder; hook must be
//    >= 52 bytes with version 0 (magic and length fields are ignored); recipient = bytes 32..52;
//    dex = bytes 52..56, or 0 if the hook is shorter than 56 bytes. Recipient must not be zero, HyperEVM USDC
//    or the CoreDepositWallet. Any revert here leaves the USDC unminted and stuck (only the forwarder may mint).
//  - CoreDepositWallet.depositFor: recipient must not be the USDC system address, the wallet itself, or
//    blacklisted. Perps (0) is forwarded via CoreWriter and may deduct a new-account fee; spot (uint32.max) and
//    any DEX that is not enabled are credited to spot.

const TOKEN_MESSENGER_ABI = parseAbi([
  'function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)',
  'function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData)',
]);

const CCTP_EXTENSION_ABI = [{
  name: 'batchDepositForBurnWithAuth', type: 'function', stateMutability: 'nonpayable', outputs: [],
  inputs: [
    { name: '_receiveWithAuthorizationData', type: 'tuple', components: [
      { name: 'amount', type: 'uint256' }, { name: 'authValidAfter', type: 'uint256' }, { name: 'authValidBefore', type: 'uint256' },
      { name: 'authNonce', type: 'bytes32' }, { name: 'v', type: 'uint8' }, { name: 'r', type: 'bytes32' }, { name: 's', type: 'bytes32' },
    ] },
    { name: '_depositForBurnData', type: 'tuple', components: [
      { name: 'amount', type: 'uint256' }, { name: 'destinationDomain', type: 'uint32' }, { name: 'mintRecipient', type: 'bytes32' },
      { name: 'destinationCaller', type: 'bytes32' }, { name: 'maxFee', type: 'uint256' }, { name: 'minFinalityThreshold', type: 'uint32' },
      { name: 'hookData', type: 'bytes' },
    ] },
  ],
}] as const;

// "cctp-forward" in ASCII, right-padded to 24 bytes.
const HOOK_MAGIC = '636374702d666f7277617264'.padEnd(48, '0');
const MIN_HOOK_BYTES = 52;
const SPOT_DEX = 4294967295;

const bytes32ToAddress = (word: Hex): string | null => /^0x0{24}[0-9a-f]{40}$/i.test(word) ? '0x' + word.slice(26).toLowerCase() : null;

export type HookAnalysis =
  | { ok: true; bytes: number; recipient: string; dex: number; magicMatches: boolean; lengthField: number; trailingBytes: number }
  | { ok: false; bytes: number; reason: string };

/** Parses hook data exactly as CctpForwarderHookData._getForwardRecipientAndDestinationId does. */
export function analyzeForwardHook(hook: Hex | null): HookAnalysis {
  const h = (hook ?? '0x').toLowerCase().slice(2);
  const bytes = h.length / 2;
  if (bytes < MIN_HOOK_BYTES) {
    return { ok: false, bytes, reason: bytes === 0 ? 'there is no hook data' : bytes === 32 ? 'the hook is header-only (32 bytes) and names no HyperCore recipient' : `the hook is ${bytes} bytes; the forwarder needs at least ${MIN_HOOK_BYTES}` };
  }
  const version = Number.parseInt(h.slice(48, 56), 16);
  if (version !== 0) return { ok: false, bytes, reason: `hook version ${version} is not supported by the forwarder (it only accepts version 0)` };
  return {
    ok: true, bytes,
    recipient: '0x' + h.slice(64, 104),
    dex: bytes >= 56 ? Number.parseInt(h.slice(104, 112), 16) : 0,
    magicMatches: h.slice(0, 48) === HOOK_MAGIC,
    lengthField: Number.parseInt(h.slice(56, 64), 16),
    trailingBytes: Math.max(0, bytes - 56),
  };
}

interface Burn {
  chainId: number;
  from: string;
  via: 'TokenMessengerV2' | 'CctpExtension';
  net: CctpSourceNetwork | undefined;
  /** Amount of each CCTP message. */
  amount: bigint;
  /** Number of CCTP messages (CctpExtension batches; 1 otherwise). */
  messages: bigint;
  domain: number;
  mintRecipientWord: Hex;
  burnToken: string;
  callerWord: Hex;
  maxFee: bigint;
  finality: number;
  /** null: no hook (plain depositForBurn). */
  hook: Hex | null;
}

const usdc = (raw: bigint) => `${formatUnits(raw, 6)} USDC`;

function finalityLabel(threshold: number): string {
  if (threshold <= 1000) return `Fast Transfer (threshold ${threshold})`;
  if (threshold >= 2000) return `Standard Transfer (threshold ${threshold})`;
  return `threshold ${threshold} (attested at standard finality)`;
}

function describeBurn(p: Burn, b: PreviewBuilder): Omit<Decoded, 'b' | 'decoder'> & { hyperCore: boolean } {
  const net = p.net;
  const isUsdc = !!net && sameAddress(p.burnToken, net.usdc);
  const total = p.amount * p.messages;
  const amountText = isUsdc ? usdc(total) : `${total} base units of ${p.burnToken}`;
  const destination = CCTP.domains[p.domain] ?? `CCTP domain ${p.domain}`;
  const mintRecipient = bytes32ToAddress(p.mintRecipientWord);
  const caller = bytes32ToAddress(p.callerWord);
  const hyperEvm = net?.hyperEvm ?? HYPEREVM_MAINNET;
  const otherHyperEvm = hyperEvm === HYPEREVM_MAINNET ? HYPEREVM_TESTNET : HYPEREVM_MAINNET;
  const assetChanges: AssetChange[] = isUsdc ? [{ direction: 'out', account: p.from, amount: formatUnits(total, 6), symbol: 'USDC', raw: total.toString(), asset: p.burnToken.toLowerCase(), basis: 'requested' }] : [];

  b.detail('Source chain', chainName(p.chainId)).detail('Contract', p.via)
    .detail('Amount leaving your wallet', amountText, total.toString());
  if (p.messages > 1n) b.detail('Split into', `${p.messages} CCTP transfers of ${isUsdc ? usdc(p.amount) : p.amount.toString()} each`, p.messages.toString());
  b.detail('Destination', `${destination} (CCTP domain ${p.domain})`, String(p.domain))
    .detail('Maximum fee', `${isUsdc ? usdc(p.maxFee) : p.maxFee.toString()}${p.messages > 1n ? ' per transfer' : ''} (a cap, not a quote)`, p.maxFee.toString())
    .detail('Finality', finalityLabel(p.finality), String(p.finality));
  if (net?.testnet) b.warn('info', 'testnet', `This is a ${net.name} testnet transfer.`);

  // Source-side checks: these revert on the source chain (gas is spent, USDC stays in your wallet).
  if (!net) b.warn('caution', 'cctp_unknown_network', `Chain ${p.chainId} is not a configured CCTP source; addresses were not checked.`);
  else if (!isUsdc) b.warn('caution', 'cctp_not_usdc', `The burn token is not ${net.name} USDC (${net.usdc}). CCTP only burns tokens Circle has enabled, so this will most likely revert.`);
  if (p.amount === 0n) b.warn('caution', 'cctp_will_revert', 'The amount is zero, so the transaction will revert on the source chain.');
  else if (p.maxFee >= p.amount) b.warn('caution', 'cctp_will_revert', `The maximum fee (${usdc(p.maxFee)}) is not less than the amount, so the transaction will revert on ${chainName(p.chainId)}. Your USDC stays in your wallet; only gas is lost.`);
  if (p.via === 'TokenMessengerV2' && p.hook !== null && p.hook === '0x') b.warn('caution', 'cctp_will_revert', 'depositForBurnWithHook requires non-empty hook data, so this will revert on the source chain.');

  const mintIsForwarder = !!mintRecipient && sameAddress(mintRecipient, hyperEvm.forwarder);
  const callerIsForwarder = !!caller && sameAddress(caller, hyperEvm.forwarder);
  const wrongNetworkForwarder = [mintRecipient, caller].some(a => a && sameAddress(a, otherHyperEvm.forwarder));
  const hyperCoreRoute = p.domain === CCTP.hyperEvmDomain && (mintIsForwarder || callerIsForwarder || wrongNetworkForwarder);

  if (!hyperCoreRoute) {
    b.detail('Recipient on destination', mintRecipient ?? p.mintRecipientWord, p.mintRecipientWord);
    if (caller && !/^0x0{40}$/.test(caller)) b.detail('Only this address may complete the mint', caller);
    if (p.hook) b.detail('Hook data', `${(p.hook.length - 2) / 2} bytes`, p.hook);
    if (!mintRecipient) b.warn('caution', 'cctp_non_evm_recipient', 'The recipient is not an EVM address; check it matches the destination chain format.');
    else if (!sameAddress(mintRecipient, p.from)) b.warn('caution', 'recipient_not_sender', `The USDC will be minted to ${shortAddress(mintRecipient)}, not to your address.`);
    b.note('The amount received is the burned amount minus the CCTP fee actually charged, which can never exceed the maximum fee.');
    return { hyperCore: false, title: `Bridge ${amountText} to ${destination}`, summary: `Burns ${amountText} on ${chainName(p.chainId)} via Circle CCTP and mints it to ${mintRecipient ? shortAddress(mintRecipient) : 'the recipient'} on ${destination}.`, status: isUsdc ? 'full' : 'partial', assetChanges };
  }

  // ---- HyperCore deposit route (via CctpForwarder) ----
  const stuck = (code: string, why: string) => b.warn('danger', code, `${why} The USDC would be burned on ${chainName(p.chainId)} but never credited: funds become permanently stuck.`);
  if (wrongNetworkForwarder) stuck('cctp_wrong_network_forwarder', `This uses the ${otherHyperEvm.name} forwarder address on ${chainName(p.chainId)}; it must be ${hyperEvm.forwarder}.`);
  if (!mintIsForwarder && !wrongNetworkForwarder) stuck('cctp_mint_recipient_not_forwarder', `mintRecipient (${mintRecipient ?? p.mintRecipientWord}) is not the CctpForwarder, but destinationCaller is; the forwarder rejects such messages and nobody else may mint them.`);
  if (!callerIsForwarder && !wrongNetworkForwarder) stuck('cctp_caller_not_forwarder', `destinationCaller (${caller ?? p.callerWord}) is not the CctpForwarder, so the forwarder cannot complete the deposit (Circle: "If destinationCaller is wrong, the forwarder cannot complete the transfer").`);

  const hook = analyzeForwardHook(p.hook);
  if (!hook.ok) {
    stuck('cctp_bad_hook', `The forwarder will reject this transfer: ${hook.reason}.`);
    if (p.hook) b.detail('Hook data', `${hook.bytes} bytes`, p.hook);
    return { hyperCore: true, title: `Bridge ${amountText} toward HyperCore: will get stuck`, summary: `Burns ${amountText} on ${chainName(p.chainId)} for the HyperCore forwarder, but the forwarding instructions are invalid.`, status: 'full', assetChanges };
  }
  const dexLabel = hook.dex === 0 ? 'perps' : hook.dex === SPOT_DEX ? 'spot' : `DEX ${hook.dex}`;
  const recipientIsSender = sameAddress(hook.recipient, p.from);
  b.detail('HyperCore recipient', hook.recipient).detail('HyperCore balance', dexLabel, String(hook.dex));
  if (/^0x0{40}$/.test(hook.recipient)) stuck('cctp_zero_recipient', 'The HyperCore recipient is the zero address, which the forwarder rejects.');
  else if (sameAddress(hook.recipient, hyperEvm.usdc)) stuck('cctp_recipient_is_usdc', 'The HyperCore recipient is the HyperEVM USDC contract, which the forwarder rejects.');
  else if (sameAddress(hook.recipient, hyperEvm.coreDepositWallet)) stuck('cctp_recipient_is_deposit_wallet', 'The HyperCore recipient is the CoreDepositWallet, which the forwarder rejects.');
  else if (sameAddress(hook.recipient, CCTP.usdcSystemAddress)) stuck('cctp_recipient_is_system_address', 'The HyperCore recipient is the USDC system address, which CoreDepositWallet rejects.');
  else if (!recipientIsSender) b.warn('caution', 'recipient_not_sender', `The USDC will be credited to a different HyperCore account (${shortAddress(hook.recipient)}), not yours.`);
  if (hook.dex !== 0 && hook.dex !== SPOT_DEX) b.warn('caution', 'cctp_unknown_dex', `DEX ${hook.dex} is neither perps (0) nor spot (4294967295). Unless Circle has enabled it, the USDC is credited to the recipient's spot balance instead.`);
  if (!hook.magicMatches || hook.lengthField !== 24 || hook.trailingBytes > 0) {
    b.note(`The hook differs from Circle's documented layout (${[!hook.magicMatches && 'magic bytes', hook.lengthField !== 24 && `length field ${hook.lengthField}`, hook.trailingBytes > 0 && `${hook.trailingBytes} extra bytes`].filter(Boolean).join(', ')}). The forwarder contract ignores these fields, so the deposit still routes as shown.`);
  }
  if (p.amount > CCTP.maxTransferFromEvm) stuck('cctp_amount_too_large', 'The amount exceeds CoreDepositWallet\'s maximum transfer from HyperEVM.');

  // Fees: the CCTP fee charged per message never exceeds maxFee (TokenMessengerV2 enforces it on mint).
  if (isUsdc && net && p.maxFee < p.amount) {
    const fastFee = p.finality <= 1000 ? (p.amount * BigInt(net.fees.fastFeeBps)) / 10_000n : 0n;
    const documented = fastFee + net.fees.forwardFeeRaw;
    const n = p.messages;
    b.detail(`Guaranteed minimum credited${n > 1n ? ' (total)' : ''}`, usdc((p.amount - p.maxFee) * n));
    b.detail(`Expected fee per transfer (Circle docs)`, `${net.fees.forwardFeeDynamic ? '≈ ' : ''}${usdc(documented)}${fastFee > 0n ? ` (${usdc(fastFee)} fast-transfer fee + ${usdc(net.fees.forwardFeeRaw)} forwarding${net.fees.forwardFeeDynamic ? ' + destination gas' : ''})` : ' forwarding fee'}`, documented.toString());
    if (p.amount > documented) b.detail(`Expected on HyperCore${n > 1n ? ' (total)' : ''}`, `${net.fees.forwardFeeDynamic ? '≈ ' : ''}${usdc((p.amount - documented) * n)}`);
    if (p.maxFee < documented) b.warn('caution', 'cctp_max_fee_below_quote', `The maximum fee (${usdc(p.maxFee)}) is below the ${usdc(documented)} Circle documents for this route. Circle's relayer may not deliver it automatically; it would then have to be completed manually (CctpForwarder.mintAndForward accepts the attestation from anyone).`);
    if (n > 1n) b.warn('info', 'cctp_batched_fees', `This sends ${n} separate CCTP transfers, and each pays its own fee (≈ ${usdc(documented * n)} in total).`);
    if (hook.dex === 0 && p.amount - (p.maxFee < documented ? p.maxFee : documented) <= 1_000_000n) {
      b.warn('caution', 'cctp_perps_new_account_fee', 'Perps deposits to an account that does not exist on HyperCore yet pay a new-account fee (1 USDC per Circle docs). If the deposit does not exceed it, the forwarding reverts and the funds get stuck. Use spot, or send more.');
    }
  }
  if (hook.dex === 0) b.note('Perps deposits to a brand-new HyperCore account can have a new-account fee deducted on arrival; spot deposits are credited in full.');
  b.note('CoreDepositWallet also rejects blacklisted recipients; that state is not checked here.');

  const who = recipientIsSender ? 'your' : `${shortAddress(hook.recipient)}'s`;
  const split = p.messages > 1n ? ` in ${p.messages} transfers` : '';
  return {
    hyperCore: true,
    title: `Bridge ${amountText} to Hyperliquid ${dexLabel}${split}${net?.testnet ? ' (testnet)' : ''}`,
    summary: `Burns ${amountText} on ${chainName(p.chainId)} via Circle CCTP${p.via === 'CctpExtension' ? ' (CctpExtension)' : ''}; it is minted on ${hyperEvm.name} and forwarded to ${who} HyperCore ${dexLabel} balance.`,
    status: isUsdc ? 'full' : 'partial', assetChanges,
  };
}

const networkFor = (chainId: number) => CCTP_NETWORKS[chainId];

/** TokenMessengerV2.depositForBurn / depositForBurnWithHook on any configured CCTP source chain. */
export const cctpAdapter: Adapter = async (tx) => {
  if (!tx.to) return null;
  const net = networkFor(tx.chainId);
  if (!(net ? sameAddress(tx.to, net.tokenMessengerV2) : sameAddress(tx.to, CCTP.tokenMessengerV2))) return null;
  let call;
  try { call = decodeFunctionData({ abi: TOKEN_MESSENGER_ABI, data: tx.data }); } catch { return null; }
  const a = call.args as unknown as [bigint, number, Hex, string, Hex, bigint, number, Hex?];
  const b = new PreviewBuilder();
  const r = describeBurn({ chainId: tx.chainId, from: tx.from, via: 'TokenMessengerV2', net, amount: a[0], messages: 1n, domain: a[1], mintRecipientWord: a[2], burnToken: a[3], callerWord: a[4], maxFee: a[5], finality: a[6], hook: call.functionName === 'depositForBurnWithHook' ? (a[7] ?? '0x') : null }, b);
  const { hyperCore, ...rest } = r;
  return decoded({ ...rest, b, decoder: hyperCore ? 'cctp_hypercore' : 'cctp_v2' });
};

/** Circle's Arbitrum CctpExtension: batchDepositForBurnWithAuth (the flow in Circle's Arbitrum → HyperCore guide). */
export const cctpExtensionAdapter: Adapter = async (tx, env) => {
  if (!tx.to) return null;
  const net = networkFor(tx.chainId);
  if (net?.cctpExtensionV2 && sameAddress(tx.to, net.cctpExtensionV2)) {
    const b = new PreviewBuilder().detail('Contract', `CctpExtensionV2 (${net.cctpExtensionV2})`).detail('Function selector', tx.data.slice(0, 10));
    b.warn('caution', 'cctp_extension_v2_direct', 'CctpExtensionV2 is for sponsored deposits that a relayer submits for you. Users normally only sign a ReceiveWithAuthorization message for it, not a transaction.');
    return decoded({ title: 'Call Circle CctpExtensionV2 (sponsored deposits)', summary: 'A relayer-style call to the sponsored HyperCore deposit contract; not decoded.', decoder: 'cctp_extension_v2', status: 'opaque', b });
  }
  if (!net?.cctpExtension || !sameAddress(tx.to, net.cctpExtension)) return null;
  let call;
  try { call = decodeFunctionData({ abi: CCTP_EXTENSION_ABI, data: tx.data }); } catch { return null; }
  const [auth, dep] = call.args;
  const b = new PreviewBuilder();
  const now = env.context.now ?? Date.now();
  const total = auth.amount, batch = dep.amount;
  let messages = 1n, amount = total;
  if (total === 0n || batch === 0n || total % batch !== 0n) {
    b.warn('caution', 'cctp_will_revert', `The authorized total (${usdc(total)}) must be a positive multiple of the batch size (${usdc(batch)}); this transaction will revert.`);
  } else {
    messages = total / batch;
    amount = batch;
  }
  const r = describeBurn({ chainId: tx.chainId, from: tx.from, via: 'CctpExtension', net, amount, messages, domain: dep.destinationDomain, mintRecipientWord: dep.mintRecipient, burnToken: net.usdc, callerWord: dep.destinationCaller, maxFee: dep.maxFee, finality: dep.minFinalityThreshold, hook: dep.hookData === '0x' ? null : dep.hookData }, b);
  const after = Number(auth.authValidAfter) * 1000, before = Number(auth.authValidBefore) * 1000;
  b.detail('Authorization valid', `${formatTimestamp(after)} → ${formatTimestamp(before)}`, `${auth.authValidAfter}..${auth.authValidBefore}`);
  if (before <= now) b.warn('caution', 'cctp_auth_expired', 'The USDC authorization has expired, so this transaction will revert.');
  if (after > now) b.warn('caution', 'cctp_auth_not_yet_valid', 'The USDC authorization is not valid yet, so this transaction will revert if sent now.');
  b.note('This transaction uses a ReceiveWithAuthorization signature you gave earlier; it can only pull USDC from the account that sends this transaction.');
  const { hyperCore: _route, ...rest } = r;
  return decoded({ ...rest, b, decoder: 'cctp_extension' });
};
