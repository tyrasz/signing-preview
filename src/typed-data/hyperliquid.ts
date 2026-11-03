import { formatDecimalString, formatDuration, formatTimestamp, formatUnits, formatUsd, parseUnits, PreviewBuilder, sameAddress, shortAddress } from '../format.ts';
import { CCTP, HYPERCORE_CCTP_WITHDRAWAL, HYPERLIQUID, parseSpotSystemAddress } from '../chains.ts';
import { l1ActionHash } from '../hyperliquid/action-hash.ts';
import { describeOrder, findSpotToken, resolveAsset, TIF_LABELS, type ResolvedAsset } from '../hyperliquid/assets.ts';
import type { HyperliquidInfo, Network, SpotToken } from '../types.ts';
import { describeMoreL1 } from './hyperliquid-admin.ts';
import { big, domainChainId, str, type TypedAdapter, type TypedDecoded, type TypedEnv } from './common.ts';

const PREFIX = 'HyperliquidTransaction:';
// Hyperliquid accepts nonces/timestamps within roughly (now - 2 days, now + 1 day).
const NONCE_PAST_MS = 2 * 86_400_000;
const NONCE_FUTURE_MS = 86_400_000;

function network(chain: string): Network {
  const testnet = chain === 'Testnet';
  return { kind: 'hypercore', name: testnet ? 'Hyperliquid Testnet' : 'Hyperliquid', testnet };
}

function infoFor(env: TypedEnv, testnet: boolean): HyperliquidInfo | undefined {
  return testnet ? env.deps.hyperliquid?.testnet : env.deps.hyperliquid?.mainnet;
}

function checkNonce(b: PreviewBuilder, env: TypedEnv, value: unknown, label: string) {
  const n = big(value);
  if (n === null) { b.warn('caution', 'bad_nonce', `The ${label.toLowerCase()} field is not a valid timestamp.`); return; }
  const ms = Number(n);
  b.detail(label, formatTimestamp(ms), n.toString());
  if (ms < env.now - NONCE_PAST_MS) b.warn('caution', 'nonce_too_old', `This signature is dated ${formatDuration(env.now - ms)} ago; Hyperliquid will reject it as expired. A stale request can mean it was prepared by someone else.`);
  if (ms > env.now + NONCE_FUTURE_MS) b.warn('caution', 'nonce_in_future', `This signature is dated ${formatDuration(ms - env.now)} in the future; Hyperliquid will reject it.`);
}

/** Destination may be a HyperEVM system address, meaning "move to HyperEVM". */
function describeDestination(b: PreviewBuilder, env: TypedEnv, destination: string, label = 'Recipient') {
  b.detail(label, destination);
  if (!/^0x[0-9a-fA-F]{40}$/.test(destination)) b.warn('danger', 'bad_destination', 'The destination is not a valid address.');
  else if (/^0x0{40}$/.test(destination)) b.warn('danger', 'zero_destination', 'The destination is the zero address.');
  else if (env.signer && sameAddress(destination, env.signer)) b.warn('info', 'destination_is_self', 'The destination is your own address.');
}

/**
 * HyperCore -> HyperEVM moves go to a system address: 0x2222… for native HYPE, 0x20…<index> for spot tokens.
 * Native HYPE has no linked EVM contract (live spotMeta); other tokens must have one.
 */
function checkSystemAddressTransfer(b: PreviewBuilder, destination: string, name: string, known: SpotToken | undefined) {
  if (sameAddress(destination, HYPERLIQUID.hypeSystemAddress)) {
    if ((known?.name ?? name) !== 'HYPE') b.warn('danger', 'system_address_mismatch', `${HYPERLIQUID.hypeSystemAddress} is the HYPE system address; sending ${known?.name ?? name} there will not move it to HyperEVM as intended.`);
    return;
  }
  const systemIndex = parseSpotSystemAddress(destination);
  if (known && systemIndex !== null && known.index !== systemIndex) b.warn('danger', 'system_address_mismatch', `This system address belongs to token #${systemIndex}, not ${known.name} (#${known.index}). The transfer to HyperEVM will not work as intended.`);
  else if (known && !known.evmContract) b.warn('danger', 'no_evm_contract', `${known.name} is not linked to a HyperEVM contract, so it cannot be moved to HyperEVM.`);
}

/** Checks the USDC being withdrawn against the account (skipped for shared-collateral accounts). */
async function checkUsdcAvailable(b: PreviewBuilder, info: HyperliquidInfo | undefined, account: string | null, source: 'perps' | 'spot', amount: number) {
  if (!info || !account || !Number.isFinite(amount)) return;
  let mode: string | undefined;
  try { mode = await info.userAbstraction?.(account); } catch { mode = undefined; }
  if (mode === 'unifiedAccount' || mode === 'portfolioMargin') { b.note('The balance was not checked because this account shares collateral across spot and perps.'); return; }
  let have: number;
  try {
    if (source === 'spot') {
      if (!info.spotClearinghouseState) return;
      const bal = (await info.spotClearinghouseState(account)).balances.find(x => x.token === 0);
      have = bal ? Number(bal.total) - Number(bal.hold) : 0;
    } else {
      have = Number((await info.clearinghouseState(account)).withdrawable);
    }
  } catch { return; }
  b.detail(`Withdrawable USDC (${source})`, formatDecimalString(String(have)));
  if (amount > have) b.warn('caution', 'insufficient_balance', `This needs ${formatDecimalString(String(amount))} USDC but only ${formatDecimalString(String(have))} is withdrawable from your ${source} balance, so Hyperliquid will reject it.`);
}

const usdc = (raw: bigint) => `${formatUnits(raw, 6)} USDC`;
const dexLabel = (dex: unknown) => str(dex) === '' ? 'perps (main DEX)' : str(dex) === 'spot' ? 'spot' : str(dex);

/** User-signed HyperCore actions (domain HyperliquidSignTransaction). These are fully readable. */
export const hyperliquidUserSignedAdapter: TypedAdapter = async (data, env) => {
  if (data.domain.name !== HYPERLIQUID.userSignedDomainName && !data.primaryType.startsWith(PREFIX)) return null;
  const b = new PreviewBuilder();
  const m = data.message;
  const chain = str(m.hyperliquidChain);
  const net = network(chain);
  const type = data.primaryType.startsWith(PREFIX) ? data.primaryType.slice(PREFIX.length) : data.primaryType;
  if (data.domain.name !== HYPERLIQUID.userSignedDomainName || str(data.domain.version) !== '1' || !/^0x0{40}$/i.test(str(data.domain.verifyingContract))) {
    b.warn('danger', 'hl_domain_mismatch', 'This looks like a Hyperliquid action but its signing domain is not the standard one. Hyperliquid would reject it, or it is imitating Hyperliquid.');
  }
  if (chain !== 'Mainnet' && chain !== 'Testnet') b.warn('danger', 'hl_unknown_chain', `Unknown hyperliquidChain "${chain}".`);
  if (net.kind === 'hypercore' && net.testnet) b.warn('info', 'testnet', 'This is a Hyperliquid testnet action; it has no effect on mainnet funds.');
  const sigChain = domainChainId(data);
  if (sigChain !== null) b.detail('Signature chain ID', String(sigChain));
  const info = infoFor(env, net.kind === 'hypercore' && net.testnet);
  const out = (title: string, summary: string, status: TypedDecoded['status'] = 'full', assetChanges?: TypedDecoded['assetChanges']): TypedDecoded =>
    ({ title, summary, decoder: `hyperliquid_${type.charAt(0).toLowerCase()}${type.slice(1)}`, status, b, network: net, assetChanges });
  if (m.payloadMultiSigUser) {
    b.detail('Multi-sig account', str(m.payloadMultiSigUser)).detail('Outer signer', str(m.outerSigner));
    b.warn('info', 'multisig_payload', `You are co-signing this action for multi-sig account ${shortAddress(str(m.payloadMultiSigUser))}, not for your own account.`);
  }
  const usdcOut = (amount: string) => env.signer ? [{ direction: 'out' as const, account: env.signer, amount: formatDecimalString(amount), symbol: 'USDC', basis: 'requested' as const }] : [];

  switch (type) {
    case 'UsdSend': {
      const destination = str(m.destination), amount = str(m.amount);
      b.detail('Amount', `${formatDecimalString(amount)} USDC`, amount);
      describeDestination(b, env, destination);
      checkNonce(b, env, m.time, 'Time');
      return out(`Send ${formatDecimalString(amount)} USDC on Hyperliquid`, `Transfers ${formatDecimalString(amount)} USDC from your Hyperliquid perps balance to ${shortAddress(destination)} on Hyperliquid. It stays on Hyperliquid; nothing is sent to another chain.`, 'full', usdcOut(amount));
    }
    case 'Withdraw': {
      const destination = str(m.destination), amount = str(m.amount);
      const raw = parseUnits(amount, 6), fee = parseUnits(HYPERLIQUID.withdrawFeeUsd, 6)!;
      b.detail('Amount', `${formatDecimalString(amount)} USDC`, amount).detail('Withdrawal fee', `${HYPERLIQUID.withdrawFeeUsd} USDC`);
      if (raw !== null) b.detail('You receive on Arbitrum (approx.)', raw > fee ? `${formatUnits(raw - fee, 6)} USDC` : '0 USDC');
      b.detail('Route', "Hyperliquid's own bridge (Bridge2 on Arbitrum One), from your perps balance");
      describeDestination(b, env, destination, 'Arbitrum recipient');
      await checkUsdcAvailable(b, info, env.signer, 'perps', Number(amount));
      if (env.signer && !sameAddress(destination, env.signer)) b.warn('caution', 'withdraw_to_other', `The USDC will arrive at ${shortAddress(destination)} on Arbitrum, which is not your address.`);
      if (raw !== null && raw <= fee) b.warn('danger', 'withdraw_below_fee', `The amount does not cover the ${HYPERLIQUID.withdrawFeeUsd} USDC withdrawal fee.`);
      checkNonce(b, env, m.time, 'Time');
      return out(`Withdraw ${formatDecimalString(amount)} USDC to Arbitrum`, `Withdraws ${formatDecimalString(amount)} USDC from Hyperliquid to ${env.signer && sameAddress(destination, env.signer) ? 'your address' : shortAddress(destination)} on Arbitrum One (a ${HYPERLIQUID.withdrawFeeUsd} USDC fee is deducted).`, 'full', usdcOut(amount));
    }
    case 'SpotSend': {
      const destination = str(m.destination), amount = str(m.amount), token = str(m.token);
      const [name, tokenId] = token.split(':');
      const known = tokenId ? await findSpotToken(info, { tokenId }) : undefined;
      b.detail('Token', name || token, token).detail('Amount', `${formatDecimalString(amount)} ${name}`, amount);
      if (tokenId && info && !known) b.warn('caution', 'spot_token_unknown', `Token ID ${tokenId} was not found in Hyperliquid's spot metadata.`);
      if (known && known.name !== name) b.warn('danger', 'spot_token_name_mismatch', `The token is labelled "${name}" but its ID belongs to ${known.name}. You may be sending a different token than shown by the dApp.`);
      const systemIndex = parseSpotSystemAddress(destination);
      const toEvm = systemIndex !== null || sameAddress(destination, HYPERLIQUID.hypeSystemAddress);
      describeDestination(b, env, destination);
      checkNonce(b, env, m.time, 'Time');
      const change = env.signer ? [{ direction: 'out' as const, account: env.signer, amount: formatDecimalString(amount), symbol: name, basis: 'requested' as const }] : [];
      if (toEvm) {
        checkSystemAddressTransfer(b, destination, name, known);
        b.detail('Credited to (HyperEVM)', env.signer ?? 'your address');
        return out(`Move ${formatDecimalString(amount)} ${name} to HyperEVM`, `Moves ${formatDecimalString(amount)} ${name} from your HyperCore spot balance to the same address on HyperEVM.`, 'full', change);
      }
      return out(`Send ${formatDecimalString(amount)} ${name} on Hyperliquid`, `Transfers ${formatDecimalString(amount)} ${name} from your Hyperliquid spot balance to ${shortAddress(destination)}.`, known || !info ? 'full' : 'partial', change);
    }
    case 'UsdClassTransfer': {
      const [amount, sub] = str(m.amount).split(' subaccount:');
      const toPerp = m.toPerp === true || m.toPerp === 'true';
      b.detail('Amount', `${formatDecimalString(amount)} USDC`, str(m.amount)).detail('Direction', toPerp ? 'Spot → Perps' : 'Perps → Spot');
      if (sub) b.detail('Sub-account', sub);
      checkNonce(b, env, m.nonce, 'Nonce');
      return out(`Move ${formatDecimalString(amount)} USDC ${toPerp ? 'from spot to perps' : 'from perps to spot'}`, `Moves USDC between your Hyperliquid spot and perps balances${sub ? ` for sub-account ${shortAddress(sub)}` : ''}. Nothing leaves your account.`);
    }
    case 'ApproveAgent': {
      const agent = str(m.agentAddress), name = str(m.agentName);
      b.detail('Agent (API wallet)', agent).detail('Agent name', name || '(unnamed)');
      checkNonce(b, env, m.nonce, 'Nonce');
      const requester = env.context.origin ? ` requested by ${env.context.origin}` : '';
      b.warn('caution', 'approve_agent', `${shortAddress(agent)} will be able to place and cancel orders for your account${requester}. An agent can sign trading and other account actions for you (Hyperliquid's SDKs include agent-signed asset transfers), so treat this as giving the site access to your account. The Hyperliquid app uses this for "Enable trading"; only approve it on sites you trust.`);
      if (!name) b.note('An unnamed agent replaces your previous unnamed agent.');
      return out(`Authorise ${shortAddress(agent)} to act for your account`, `Approves an API wallet ("agent") that can sign trading and other account actions on your Hyperliquid account without asking your wallet again.`);
    }
    case 'ApproveBuilderFee': {
      const builder = str(m.builder), rate = str(m.maxFeeRate);
      b.detail('Builder', builder).detail('Maximum fee rate', rate);
      checkNonce(b, env, m.nonce, 'Nonce');
      const pct = Number(rate.replace('%', ''));
      b.warn(pct > 0.1 ? 'caution' : 'info', 'approve_builder_fee', `${shortAddress(builder)} will be allowed to add a fee of up to ${rate} to orders it routes for you.`);
      return out(`Approve a ${rate} builder fee for ${shortAddress(builder)}`, 'Lets a third-party frontend (builder) charge a fee on your orders, up to this rate.');
    }
    case 'TokenDelegate': {
      const validator = str(m.validator), wei = big(m.wei), undelegate = m.isUndelegate === true || m.isUndelegate === 'true';
      const amount = wei !== null ? `${formatUnits(wei, 8)} HYPE` : str(m.wei);
      b.detail('Validator', validator).detail('Amount', amount, str(m.wei));
      checkNonce(b, env, m.nonce, 'Nonce');
      return out(`${undelegate ? 'Undelegate' : 'Delegate'} ${amount} ${undelegate ? 'from' : 'to'} ${shortAddress(validator)}`, 'Changes your HYPE staking delegation on Hyperliquid.');
    }
    case 'CDeposit':
    case 'CWithdraw': {
      const wei = big(m.wei);
      const amount = wei !== null ? `${formatUnits(wei, 8)} HYPE` : str(m.wei);
      b.detail('Amount', amount, str(m.wei));
      checkNonce(b, env, m.nonce, 'Nonce');
      return type === 'CDeposit'
        ? out(`Stake ${amount}`, 'Moves HYPE from your spot balance to your staking balance.')
        : out(`Unstake ${amount}`, 'Moves HYPE from staking back to spot. Unstaking is subject to a waiting period.');
    }
    case 'SendAsset': {
      const destination = str(m.destination), amount = str(m.amount), token = str(m.token);
      const [name, tokenId] = token.split(':');
      const known = await findSpotToken(info, tokenId ? { tokenId } : { name });
      const from = str(m.fromSubAccount);
      b.detail('Token', name, token).detail('Amount', `${formatDecimalString(amount)} ${name}`, amount)
        .detail('From DEX', dexLabel(m.sourceDex), str(m.sourceDex)).detail('To DEX', dexLabel(m.destinationDex), str(m.destinationDex));
      if (from) b.detail('From sub-account', from);
      if (tokenId && known && known.name !== name) b.warn('danger', 'spot_token_name_mismatch', `The token is labelled "${name}" but its ID belongs to ${known.name}.`);
      checkNonce(b, env, m.nonce, 'Nonce');
      const change = env.signer ? [{ direction: 'out' as const, account: env.signer, amount: formatDecimalString(amount), symbol: name, basis: 'requested' as const }] : [];
      const toEvm = parseSpotSystemAddress(destination) !== null || sameAddress(destination, HYPERLIQUID.hypeSystemAddress);
      if (toEvm) {
        // Circle's "Withdraw USDC from HyperCore to HyperEVM" uses SendAsset to the USDC system address.
        b.detail('System address', destination).detail('Credited to (HyperEVM)', from || env.signer || 'your address');
        checkSystemAddressTransfer(b, destination, name, known);
        return out(`Move ${formatDecimalString(amount)} ${name} from HyperCore to HyperEVM`, `Moves ${formatDecimalString(amount)} ${name} from your HyperCore ${dexLabel(m.sourceDex)} balance to the same address on HyperEVM.`, known ? 'full' : 'partial', change);
      }
      describeDestination(b, env, destination);
      if (env.signer && sameAddress(destination, env.signer) && !from) {
        return out(`Move ${formatDecimalString(amount)} ${name} from ${dexLabel(m.sourceDex)} to ${dexLabel(m.destinationDex)}`, 'Moves an asset between your own Hyperliquid DEX balances.', 'full');
      }
      return out(`Send ${formatDecimalString(amount)} ${name} to ${shortAddress(destination)}`, `Transfers ${formatDecimalString(amount)} ${name} to another Hyperliquid account.`, 'full', change);
    }
    case 'SendToEvmWithData': {
      // destinationChainId is a CCTP domain ID (Circle: 3 = Arbitrum, 0 = Ethereum, 6 = Base), not an EVM chain ID.
      const amount = str(m.amount), token = str(m.token), name = token.split(':')[0];
      const recipient = str(m.destinationRecipient), encoding = str(m.addressEncoding), data = str(m.data);
      const domainId = Number(m.destinationChainId), dest = CCTP.domains[domainId];
      const where = dest ?? `CCTP domain ${domainId}`;
      const dataHex = /^0x([0-9a-fA-F]{2})*$/.test(data) ? data.toLowerCase() : null;
      const dataBytes = dataHex ? (dataHex.length - 2) / 2 : NaN;
      const source = str(m.sourceDex) === 'spot' ? 'spot' : 'perps';
      b.detail('Token', name, token).detail('Amount', `${formatDecimalString(amount)} ${name}`, amount).detail('From balance', dexLabel(m.sourceDex), str(m.sourceDex))
        .detail('Destination', `${where}${dest ? ` (CCTP domain ${domainId})` : ''}`, String(m.destinationChainId))
        .detail('Recipient', encoding === 'hex' ? recipient : `${recipient} (${encoding})`).detail('Gas limit', str(m.gasLimit));
      checkNonce(b, env, m.nonce, 'Nonce');
      const change = env.signer ? [{ direction: 'out' as const, account: env.signer, amount: formatDecimalString(amount), symbol: name, basis: 'requested' as const }] : [];
      if (name !== 'USDC') {
        if (dataBytes > 0) b.warn('caution', 'send_to_evm_with_data', `The receiving contract gets ${dataBytes} bytes of data it will act on, which cannot be interpreted here.`);
        b.warn('caution', 'unverified_route', `Only USDC withdrawals (handled by Circle's CoreDepositWallet) are verified. Check how ${name}'s HyperEVM contract handles this.`);
        return out(`Send ${formatDecimalString(amount)} ${name} from HyperCore via HyperEVM to ${where}`, `Moves ${formatDecimalString(amount)} ${name} out of HyperCore through its HyperEVM contract.`, 'partial', change);
      }
      // Circle CCTP: HyperCore debits the balance; CoreDepositWallet.coreReceiveWithData burns on HyperEVM; minted on the destination.
      const W = HYPERCORE_CCTP_WITHDRAWAL;
      const forward = dataBytes === 0 || (!!dataHex && dataHex.startsWith('0x' + '636374702d666f7277617264'.padEnd(48, '0')));
      const fee = W.cctpMaxFeeRaw + (forward ? W.forwardFeeByDomain[domainId] ?? W.defaultForwardFeeRaw : 0n);
      const raw = parseUnits(amount, 6);
      const revert = (code: string, why: string) => b.warn('danger', code, `${why} Circle documents that the HyperEVM step then reverts; it does not document what happens to the HyperCore balance that was debited.`);
      b.detail('Route', `Circle CCTP: burned on HyperEVM by CoreDepositWallet, minted on ${where}`)
        .detail('Delivery', forward ? "Automatic (Circle's Forwarding Service)" : `Manual: someone must submit the mint on ${where}`)
        .detail('Fee', forward ? `${usdc(fee)} forwarding fee` : `${usdc(fee)} (no forwarding)`, fee.toString());
      if (dataBytes > 0) b.detail('Hook data for the destination', `${dataBytes} bytes`, data);
      if (raw !== null && raw > fee) {
        b.detail(`You receive on ${where} (expected)`, usdc(raw - fee));
      }
      if (!dest || domainId === CCTP.hyperEvmDomain) revert('unknown_cctp_domain', domainId === CCTP.hyperEvmDomain ? 'HyperEVM is CCTP domain 19, so this would burn and mint on the same chain. Circle withdraws to HyperEVM with a SendAsset to the USDC system address instead.' : `${domainId} is not a CCTP domain in Circle's list (Arbitrum is 3, Ethereum 0, Base 6), so the CCTP burn will fail.`);
      if (raw !== null && raw <= fee) revert('withdrawal_below_fee', `The amount does not exceed the ${usdc(fee)} withdrawal fee.`);
      if (!dataHex) revert('bad_hook_data', 'The data field is not valid hex.');
      else if (dataBytes > W.maxDataBytes) revert('hook_data_too_large', `The data is ${dataBytes} bytes; CoreDepositWallet accepts at most ${W.maxDataBytes}.`);
      if (encoding === 'hex' && !/^0x[0-9a-fA-F]{40}$/.test(recipient)) b.warn('danger', 'bad_destination', 'The recipient is not a valid EVM address.');
      if ((encoding === 'base58') !== (dest === 'Solana') && dest) b.warn('caution', 'address_encoding_mismatch', `${encoding} addresses are for ${encoding === 'base58' ? 'Solana' : 'EVM chains'}, but the destination is ${where}.`);
      if (!forward) b.warn('caution', 'manual_delivery', `With custom data there is no automatic delivery: the mint must be submitted on ${where} with Circle's attestation. Anyone can submit it, and the USDC still goes to the recipient.`);
      if (dataBytes > 0 && forward) b.warn('info', 'custom_hook_data', `${dataBytes} bytes of data are passed to the destination with the transfer and cannot be interpreted here.`);
      if (encoding === 'hex' && env.signer && !sameAddress(recipient, env.signer)) b.warn('caution', 'recipient_not_sender', `The USDC goes to ${shortAddress(recipient)} on ${where}, not to your address.`);
      await checkUsdcAvailable(b, info, env.signer, source, Number(amount));
      return out(`Withdraw ${formatDecimalString(amount)} USDC from HyperCore to ${where} via Circle CCTP`,
        `Debits your HyperCore ${source} balance; the USDC is burned on HyperEVM via Circle CCTP and minted to ${encoding === 'hex' && env.signer && sameAddress(recipient, env.signer) ? 'your address' : shortAddress(recipient)} on ${where}${forward ? ', delivered automatically' : ''}.`,
        dest && forward && dataBytes === 0 ? 'full' : 'partial', change);
    }
    case 'UserSetAbstraction': {
      const mode = str(m.abstraction), user = str(m.user);
      const labels: Record<string, string> = { disabled: 'standard (separate spot and perps balances)', unifiedAccount: 'unified account', portfolioMargin: 'portfolio margin' };
      b.detail('Account', user).detail('New account mode', labels[mode] ?? mode, mode);
      checkNonce(b, env, m.nonce, 'Nonce');
      if (env.signer && !sameAddress(user, env.signer)) b.warn('caution', 'other_account', `This changes the mode of ${shortAddress(user)}, not your own account.`);
      if (!labels[mode]) b.warn('caution', 'unknown_mode', `Account mode "${mode}" is not recognised.`);
      else if (mode !== 'disabled') b.warn('caution', 'shared_collateral', 'Your balances will be shared as collateral across markets. A loss in one position can draw on, and liquidate against, your other balances.');
      return out(`Set account mode to ${labels[mode] ?? mode}`, 'Changes how your Hyperliquid balances back your positions.', labels[mode] ? 'full' : 'partial');
    }
    case 'UserDexAbstraction':
    case 'UserPortfolioMargin': {
      const enabled = m.enabled === true || m.enabled === 'true', user = str(m.user);
      const what = type === 'UserPortfolioMargin' ? 'portfolio margin' : 'HIP-3 DEX abstraction';
      b.detail('Account', user).detail(type === 'UserPortfolioMargin' ? 'Portfolio margin' : 'HIP-3 DEX abstraction', enabled ? 'Enable' : 'Disable');
      checkNonce(b, env, m.nonce, 'Nonce');
      if (env.signer && !sameAddress(user, env.signer)) b.warn('caution', 'other_account', `This changes ${shortAddress(user)}, not your own account.`);
      if (enabled) b.warn('caution', 'shared_collateral', type === 'UserPortfolioMargin'
        ? 'With portfolio margin, positions are margined together: a loss in one can reduce the margin of, and liquidate, the others.'
        : 'Builder-deployed (HIP-3) perp DEXes will be able to use collateral from your main account, so losses there can affect your main balances.');
      return out(`${enabled ? 'Enable' : 'Disable'} ${what}`, `${enabled ? 'Turns on' : 'Turns off'} ${what} for your Hyperliquid account.`);
    }
    case 'LinkStakingUser': {
      const user = str(m.user), finalize = m.isFinalize === true || m.isFinalize === 'true';
      b.detail(finalize ? 'Trading account to link' : 'Staking account', user).detail('Step', finalize ? 'Finalize (permanent)' : 'Request link');
      checkNonce(b, env, m.nonce, 'Nonce');
      if (finalize) b.warn('caution', 'staking_link_finalize', `This permanently links trading account ${shortAddress(user)} to your staking account for fee discounts.`);
      else b.warn('danger', 'staking_link_request', `Once ${shortAddress(user)} finalizes, that staking account can permanently disable this trading account, locking its funds and receiving them after a year. Only link to a staking account you control.`);
      return out(finalize ? `Finalize staking link with ${shortAddress(user)}` : `Request staking link to ${shortAddress(user)}`, 'Links a staking account and a trading account so staked HYPE gives the trading account fee discounts.');
    }
    case 'StakingLinkDisableTradingUser': {
      const user = str(m.tradingUser);
      b.detail('Trading account', user);
      checkNonce(b, env, m.nonce, 'Nonce');
      b.warn('danger', 'staking_link_disable', `Irreversible: permanently disables linked trading account ${shortAddress(user)} and locks its funds. After one year they are transferred to this staking account.`);
      return out(`Permanently disable trading account ${shortAddress(user)}`, 'Locks a linked trading account for good; its funds move to the staking account after a year.');
    }
    case 'SendMultiSig': {
      b.detail('Multi-sig action hash', str(m.multiSigActionHash));
      checkNonce(b, env, m.nonce, 'Nonce');
      b.warn('caution', 'multisig_envelope', 'This submits a multi-sig action identified only by its hash. Check the action with the other signers before approving.');
      return out('Submit a Hyperliquid multi-sig action', 'Sends a multi-sig action whose contents are referenced by hash.', 'opaque');
    }
    case 'ConvertToMultiSigUser': {
      b.detail('Signers', str(m.signers));
      checkNonce(b, env, m.nonce, 'Nonce');
      b.warn('danger', 'convert_to_multisig', 'This hands control of your Hyperliquid account to a multi-sig. Your key alone will no longer be able to act. If you do not control the listed signers, you lose the account.');
      return out('Convert your Hyperliquid account to a multi-sig', 'Changes who controls your Hyperliquid account.');
    }
  }
  for (const [key, value] of Object.entries(m)) b.detail(key, str(value));
  b.warn('caution', 'hl_unknown_action', `"${type}" is not a Hyperliquid action this previewer knows. All signed fields are listed; read them carefully.`);
  return out(`Hyperliquid action: ${type}`, 'An unrecognised Hyperliquid user-signed action.', 'partial');
};

/** L1 actions (orders, cancels, leverage, …): the wallet signs Agent { source, connectionId } only. */
export const hyperliquidL1Adapter: TypedAdapter = async (data, env) => {
  if (data.primaryType !== 'Agent' || data.domain.name !== HYPERLIQUID.l1Domain.name) return null;
  const b = new PreviewBuilder();
  const source = str(data.message.source), connectionId = str(data.message.connectionId).toLowerCase();
  const testnet = source === 'b';
  const net = network(testnet ? 'Testnet' : 'Mainnet');
  if (source !== 'a' && source !== 'b') b.warn('danger', 'l1_bad_source', `Unknown source "${source}" (expected "a" for mainnet or "b" for testnet).`);
  if (domainChainId(data) !== HYPERLIQUID.l1Domain.chainId) b.warn('danger', 'l1_domain_mismatch', `Hyperliquid L1 actions are signed with chain ID ${HYPERLIQUID.l1Domain.chainId}; this request uses ${domainChainId(data)}.`);
  if (testnet) b.warn('info', 'testnet', 'This is a Hyperliquid testnet action.');
  b.detail('Action hash (connectionId)', connectionId);
  const pre = env.context.hyperliquid;
  const opaque = (title: string, summary: string): TypedDecoded => ({ title, summary, decoder: 'hyperliquid_l1_action', status: 'opaque', b, network: net });
  if (!pre) {
    b.warn('caution', 'l1_opaque', 'This signs a Hyperliquid trading action as a bare hash, so its contents cannot be shown. The Hyperliquid app normally signs these with a local agent key; if a site asks your main wallet for this, ask it to provide the action so it can be checked, or reject.');
    return opaque('Sign a Hyperliquid trading action (contents hidden)', 'You are asked to sign the hash of a Hyperliquid order, cancel or account action. The action itself was not provided, so it cannot be displayed.');
  }
  const expected = l1ActionHash(pre.action, pre.nonce, pre.vaultAddress, pre.expiresAfter).toLowerCase();
  if (expected !== connectionId) {
    b.detail('Hash of supplied action', expected);
    b.warn('danger', 'l1_hash_mismatch', 'The action supplied with this request does not match the hash being signed. What you would sign is different from what the dApp shows.');
    return opaque('Hyperliquid action does not match the signature request', 'The supplied action could not be verified against the signed hash.');
  }
  b.note('The supplied action was verified: its hash equals the signed connectionId.');
  checkNonce(b, env, pre.nonce, 'Nonce');
  if (pre.vaultAddress) {
    b.detail('Acting for vault / sub-account', pre.vaultAddress);
    b.warn('info', 'l1_vault', `This action is executed on behalf of ${shortAddress(pre.vaultAddress)}, not your main account.`);
  }
  if (pre.expiresAfter) b.detail('Expires after', formatTimestamp(pre.expiresAfter), String(pre.expiresAfter));
  const result = await describeL1Action(pre.action, b, infoFor(env, testnet), env, pre.vaultAddress ?? env.signer);
  return { ...result, decoder: 'hyperliquid_l1_action', b, network: net };
};

type Wire = Record<string, unknown>;

function orderSpec(o: Wire) {
  const t = (o.t ?? {}) as Wire;
  const limit = t.limit as Wire | undefined, trigger = t.trigger as Wire | undefined;
  const tif = limit ? str(limit.tif) : '';
  const orderType = limit ? TIF_LABELS[tif] ?? `Limit (${tif})` : trigger ? `${str(trigger.tpsl) === 'tp' ? 'Take profit' : 'Stop loss'} ${trigger.isMarket ? 'market' : 'limit'} (trigger)` : 'Unknown';
  return { isBuy: o.b === true, price: str(o.p), size: str(o.s), reduceOnly: o.r === true, orderType, triggerPrice: trigger ? str(trigger.triggerPx) : undefined, isMarket: trigger ? trigger.isMarket === true : tif === 'FrontendMarket' };
}

async function describeL1Action(action: Wire, b: PreviewBuilder, info: HyperliquidInfo | undefined, env: TypedEnv, account: string | null): Promise<Pick<TypedDecoded, 'title' | 'summary' | 'status'>> {
  const type = str(action.type);
  b.detail('Action type', type);
  const usd = (value: unknown) => { const n = big(value); return n === null ? str(value) : `${formatUnits(n, 6)} USDC`; };
  switch (type) {
    case 'order': {
      const orders = (Array.isArray(action.orders) ? action.orders : []) as Wire[];
      const lines: string[] = [];
      let unknown = false;
      for (const [i, o] of orders.entries()) {
        const asset = await resolveAsset(info, Number(o.a));
        unknown ||= asset.kind === 'unknown';
        const spec = orderSpec(o);
        lines.push(await describeOrder(b, info, asset, spec, orders.length > 1 ? `#${i + 1} ` : ''));
        if (orderSpec(o).orderType === 'Unknown') b.warn('caution', 'unknown_order_type', 'An order has an unrecognised type.');
        await fundsCheck(b, info, account, asset, spec);
      }
      const grouping = str(action.grouping);
      if (grouping && grouping !== 'na') b.detail('Grouping', grouping === 'normalTpsl' ? 'Order with TP/SL' : grouping === 'positionTpsl' ? 'Position TP/SL' : grouping);
      const builder = action.builder as Wire | undefined;
      if (builder) {
        const f = Number(builder.f);
        b.detail('Builder', str(builder.b)).detail('Builder fee', `${(f / 10).toString()} bp (${(f / 1000).toString()}%)`, String(builder.f));
        b.warn('info', 'builder_fee', `This order pays a builder fee of ${(f / 1000).toString()}% to ${shortAddress(str(builder.b))}.`);
      }
      if (!orders.length) b.warn('caution', 'empty_order', 'The order action contains no orders.');
      return { title: orders.length === 1 ? lines[0] : `Place ${orders.length} orders`, summary: orders.length === 1 ? `Places an order on Hyperliquid: ${lines[0]}.` : `Places ${orders.length} orders: ${lines.join('; ')}.`, status: unknown ? 'partial' : 'full' };
    }
    case 'cancel':
    case 'cancelByCloid': {
      const cancels = (Array.isArray(action.cancels) ? action.cancels : []) as Wire[];
      const names: string[] = [];
      for (const c of cancels) {
        const asset = await resolveAsset(info, Number(c.a ?? c.asset));
        names.push(asset.name);
        b.detail(`Cancel (${asset.name})`, type === 'cancel' ? `order ${str(c.o)}` : `client order ${str(c.cloid)}`);
      }
      return { title: `Cancel ${cancels.length} order${cancels.length === 1 ? '' : 's'}`, summary: `Cancels open orders on ${[...new Set(names)].join(', ')}.`, status: 'full' };
    }
    case 'modify':
    case 'batchModify': {
      const mods = (type === 'modify' ? [action] : (action.modifies as Wire[] ?? [])) as Wire[];
      const lines: string[] = [];
      for (const [i, mod] of mods.entries()) {
        const o = mod.order as Wire;
        const asset = await resolveAsset(info, Number(o.a));
        b.detail(mods.length > 1 ? `#${i + 1} Order ID` : 'Order ID', str(mod.oid));
        lines.push(await describeOrder(b, info, asset, orderSpec(o), mods.length > 1 ? `#${i + 1} ` : ''));
      }
      return { title: `Modify order${mods.length === 1 ? '' : 's'}: ${lines.join('; ')}`, summary: 'Replaces existing open orders with the values shown.', status: 'full' };
    }
    case 'updateLeverage': {
      const asset = await resolveAsset(info, Number(action.asset));
      const leverage = Number(action.leverage);
      b.detail('Market', asset.name, str(action.asset)).detail('Leverage', `${leverage}×`).detail('Margin mode', action.isCross ? 'Cross' : 'Isolated');
      if (asset.maxLeverage && leverage > asset.maxLeverage) b.warn('danger', 'leverage_above_max', `${leverage}× exceeds the ${asset.maxLeverage}× maximum for ${asset.name}; it will be rejected.`);
      else if (leverage >= 20) b.warn('caution', 'high_leverage', `${leverage}× leverage: a ${(100 / leverage).toFixed(1)}% price move against you can liquidate the position.`);
      return { title: `Set ${asset.name} leverage to ${leverage}× (${action.isCross ? 'cross' : 'isolated'})`, summary: 'Changes the leverage used for this market.', status: asset.kind === 'unknown' ? 'partial' : 'full' };
    }
    case 'updateIsolatedMargin': {
      const asset = await resolveAsset(info, Number(action.asset));
      // ntli is a signed integer in 1e6 USDC units.
      const signed = Number(action.ntli);
      b.detail('Market', asset.name).detail('Margin change', Number.isSafeInteger(signed) ? `${signed >= 0 ? '+' : '-'}${formatUnits(BigInt(Math.abs(signed)), 6)} USDC` : str(action.ntli), str(action.ntli));
      return { title: `${signed >= 0 ? 'Add' : 'Remove'} isolated margin on ${asset.name}`, summary: 'Changes the margin on an isolated position.', status: 'full' };
    }
    case 'twapOrder': {
      const t = (action.twap ?? {}) as Wire;
      const asset = await resolveAsset(info, Number(t.a));
      const side = t.b ? 'Buy' : 'Sell';
      b.detail('Market', asset.name).detail('Side', side).detail('Total size', formatDecimalString(str(t.s))).detail('Duration', `${str(t.m)} minutes`).detail('Reduce-only', t.r ? 'Yes' : 'No').detail('Randomised', t.t ? 'Yes' : 'No');
      return { title: `TWAP ${side.toLowerCase()} ${formatDecimalString(str(t.s))} ${asset.name} over ${str(t.m)} minutes`, summary: 'Splits an order into market orders over time.', status: 'full' };
    }
    case 'twapCancel': {
      const asset = await resolveAsset(info, Number(action.a));
      b.detail('Market', asset.name).detail('TWAP ID', str(action.t));
      return { title: `Cancel TWAP on ${asset.name}`, summary: 'Stops a running TWAP order.', status: 'full' };
    }
    case 'scheduleCancel': {
      if (action.time !== undefined) b.detail('Cancel all orders at', formatTimestamp(Number(action.time)));
      return { title: action.time === undefined ? 'Clear scheduled cancel' : 'Schedule cancel-all', summary: action.time === undefined ? 'Removes the scheduled "dead man\'s switch".' : 'All open orders will be cancelled at the scheduled time.', status: 'full' };
    }
    case 'vaultTransfer': {
      b.detail('Vault', str(action.vaultAddress)).detail('Amount', usd(action.usd), str(action.usd));
      return { title: `${action.isDeposit ? 'Deposit' : 'Withdraw'} ${usd(action.usd)} ${action.isDeposit ? 'into' : 'from'} vault ${shortAddress(str(action.vaultAddress))}`, summary: 'Moves perps USDC between your account and a vault.', status: 'full' };
    }
    case 'subAccountTransfer': {
      b.detail('Sub-account', str(action.subAccountUser)).detail('Amount', usd(action.usd), str(action.usd));
      return { title: `${action.isDeposit ? 'Move' : 'Withdraw'} ${usd(action.usd)} ${action.isDeposit ? 'to' : 'from'} sub-account ${shortAddress(str(action.subAccountUser))}`, summary: 'Moves USDC between your main account and a sub-account.', status: 'full' };
    }
    case 'createSubAccount':
      b.detail('Name', str(action.name));
      return { title: `Create sub-account "${str(action.name)}"`, summary: 'Creates a new Hyperliquid sub-account.', status: 'full' };
    case 'setReferrer':
      b.detail('Referral code', str(action.code));
      return { title: `Use referral code ${str(action.code)}`, summary: 'Sets the referrer for your account (one-time).', status: 'full' };
    case 'borrowLend': {
      const op = str(action.operation), token = await findSpotToken(info, { index: Number(action.token) });
      const name = token?.name ?? `token #${str(action.token)}`;
      const amount = action.amount === null || action.amount === undefined ? `all ${name}` : `${formatDecimalString(str(action.amount))} ${name}`;
      const verbs: Record<string, string> = { supply: 'Supply', withdraw: 'Withdraw', repay: 'Repay', borrow: 'Borrow' };
      b.detail('Operation', verbs[op] ?? op).detail('Token', name, str(action.token)).detail('Amount', amount, str(action.amount));
      if (!token) b.warn('caution', 'core_token_unknown', `HyperCore token #${str(action.token)} could not be looked up.`);
      if (op === 'borrow') b.warn('caution', 'borrow', `Borrowing ${amount} creates debt against your collateral; it accrues interest and can be liquidated if your collateral falls.`);
      if (!verbs[op]) b.warn('caution', 'unknown_operation', `Lending operation "${op}" is not recognised.`);
      const prep: Record<string, string> = { supply: 'to', repay: 'to', withdraw: 'from', borrow: 'from' };
      return { title: `${verbs[op] ?? op} ${amount} ${prep[op] ?? 'via'} HyperCore lending`, summary: 'Changes your HyperCore borrow/lend position.', status: token && verbs[op] ? 'full' : 'partial' };
    }
    case 'topUpIsolatedOnlyMargin': {
      const asset = await resolveAsset(info, Number(action.asset));
      b.detail('Market', asset.name, str(action.asset)).detail('Target leverage', `${formatDecimalString(str(action.leverage))}×`);
      return { title: `Top up ${asset.name} isolated margin to ${formatDecimalString(str(action.leverage))}× leverage`, summary: 'Adds USDC margin to an isolated position until it reaches the target leverage.', status: asset.kind === 'unknown' ? 'partial' : 'full' };
    }
    case 'subAccountSpotTransfer': {
      const token = str(action.token), name = token.split(':')[0], amount = `${formatDecimalString(str(action.amount))} ${name}`;
      b.detail('Sub-account', str(action.subAccountUser)).detail('Token', name, token).detail('Amount', amount, str(action.amount));
      return { title: `${action.isDeposit ? 'Move' : 'Withdraw'} ${amount} ${action.isDeposit ? 'to' : 'from'} sub-account ${shortAddress(str(action.subAccountUser))}`, summary: 'Moves a spot token between your main account and a sub-account.', status: 'full' };
    }
    case 'claimRewards':
      return { title: 'Claim referral rewards', summary: 'Claims your accumulated referral rewards into your account.', status: 'full' };
    case 'createVault': {
      b.detail('Vault name', str(action.name)).detail('Description', str(action.description)).detail('Initial deposit', usd(action.initialUsd), str(action.initialUsd));
      b.warn('info', 'create_vault', `Creates a vault that you lead, funded with ${usd(action.initialUsd)} from your account. Followers' funds will trade with your strategy.`);
      return { title: `Create vault "${str(action.name)}" with ${usd(action.initialUsd)}`, summary: 'Creates a new Hyperliquid vault led by your account.', status: 'full' };
    }
    case 'vaultModify': {
      const flag = (v: unknown) => v === null || v === undefined ? 'unchanged' : v ? 'Yes' : 'No';
      b.detail('Vault', str(action.vaultAddress)).detail('Allow deposits', flag(action.allowDeposits)).detail('Always close positions on withdrawal', flag(action.alwaysCloseOnWithdraw));
      return { title: `Change settings of vault ${shortAddress(str(action.vaultAddress))}`, summary: 'Updates deposit and withdrawal settings for a vault you lead.', status: 'full' };
    }
    case 'vaultDistribute': {
      const n = big(action.usd);
      b.detail('Vault', str(action.vaultAddress)).detail('Amount', n === 0n ? '0 (close the vault)' : usd(action.usd), str(action.usd));
      if (n === 0n) b.warn('caution', 'close_vault', 'An amount of 0 closes the vault and returns funds to followers.');
      return { title: n === 0n ? `Close vault ${shortAddress(str(action.vaultAddress))}` : `Distribute ${usd(action.usd)} from vault ${shortAddress(str(action.vaultAddress))}`, summary: 'Distributes vault funds to its followers.', status: 'full' };
    }
    case 'registerReferrer':
      b.detail('Referral code', str(action.code));
      return { title: `Create referral code ${str(action.code)}`, summary: 'Registers a referral code for your account.', status: 'full' };
    case 'setDisplayName':
      b.detail('Display name', str(action.displayName) || '(removed)');
      return { title: str(action.displayName) ? `Set leaderboard name to "${str(action.displayName)}"` : 'Remove leaderboard name', summary: 'Changes the public name shown for your account on the leaderboard.', status: 'full' };
    case 'spotUser': {
      const optOut = (action.toggleSpotDusting as Wire | undefined)?.optOut;
      b.detail('Spot dusting', optOut ? 'Opt out' : 'Opt in');
      return { title: `${optOut ? 'Opt out of' : 'Opt in to'} spot dusting`, summary: 'Controls whether tiny spot balances ("dust") are automatically converted.', status: typeof optOut === 'boolean' ? 'full' : 'partial' };
    }
    case 'subAccountModify':
      b.detail('Sub-account', str(action.subAccountUser)).detail('New name', str(action.name));
      return { title: `Rename sub-account ${shortAddress(str(action.subAccountUser))} to "${str(action.name)}"`, summary: 'Renames one of your sub-accounts.', status: 'full' };
    case 'evmUserModify':
      b.detail('HyperEVM blocks', action.usingBigBlocks ? 'Large (slower, higher gas limit)' : 'Small (fast)');
      return { title: `Use ${action.usingBigBlocks ? 'large' : 'small'} HyperEVM blocks`, summary: 'Chooses which HyperEVM block type your EVM transactions go into (affects deploying large contracts).', status: 'full' };
    case 'noop':
      return { title: 'Hyperliquid no-op', summary: 'Consumes a nonce without doing anything (used to invalidate pending actions).', status: 'full' };
  }
  const more = await describeMoreL1(type, action, b, info, env);
  if (more) return more;
  for (const [key, value] of Object.entries(action)) if (key !== 'type') b.detail(key, str(value));
  b.warn('caution', 'l1_unknown_action', `Action type "${type}" is not recognised. Its fields are listed as signed.`);
  return { title: `Hyperliquid action: ${type}`, summary: 'An unrecognised Hyperliquid L1 action.', status: 'partial' };
}

/** Checks the order against the account: margin for perps (per DEX), balances for spot. */
async function fundsCheck(b: PreviewBuilder, info: HyperliquidInfo | undefined, account: string | null, asset: ResolvedAsset, spec: { isBuy: boolean; price: string; size: string; reduceOnly: boolean }) {
  const price = Number(spec.price), size = Number(spec.size), notional = price * size;
  if (!info || !account || spec.reduceOnly || !Number.isFinite(notional)) return;
  if (asset.kind === 'spot' && asset.base && asset.quote && info.spotClearinghouseState) {
    let balances;
    try { balances = (await info.spotClearinghouseState(account)).balances; } catch { return; }
    const free = (token: number) => { const x = balances.find(bal => bal.token === token); return x ? Number(x.total) - Number(x.hold) : 0; };
    const [token, need] = spec.isBuy ? [asset.quote, notional] : [asset.base, size];
    const have = free(token.index);
    b.detail(`Available ${token.name}`, formatDecimalString(String(have)));
    if (have < need) b.warn('caution', 'insufficient_balance', `This order needs ${formatDecimalString(String(need))} ${token.name} but only ${formatDecimalString(String(have))} is available in spot. It may be rejected.`);
    return;
  }
  if (asset.kind !== 'perp' || !asset.midKey) return;
  let mode: string | undefined;
  try { mode = await info.userAbstraction?.(account); } catch { mode = undefined; }
  if (mode === 'unifiedAccount' || mode === 'portfolioMargin') {
    b.detail('Account mode', mode === 'unifiedAccount' ? 'Unified account (collateral shared)' : 'Portfolio margin (collateral shared)');
    b.note('Margin was not checked per market because this account shares collateral across spot, perps and DEXes.');
    return;
  }
  let state;
  try { state = await info.clearinghouseState(account, asset.dex); } catch { return; }
  const withdrawable = Number(state.withdrawable);
  const where = asset.dex ? ` on ${asset.dexFullName ?? asset.dex}` : '';
  b.detail(`Account value${where}`, formatUsd(Number(state.marginSummary.accountValue))).detail(`Available margin${where}`, formatUsd(withdrawable));
  const coin = asset.midKey;
  const position = state.assetPositions.find(p => p.position.coin === coin)?.position;
  const leverage = position?.leverage.value ?? asset.maxLeverage;
  if (position) {
    b.detail(`Current ${coin} position`, `${formatDecimalString(position.szi)} @ ${formatDecimalString(position.entryPx ?? '?')} (${position.leverage.value}× ${position.leverage.type})`);
    if (position.liquidationPx) b.detail(`Current ${coin} liquidation price`, formatDecimalString(position.liquidationPx));
  }
  if (!leverage) return;
  const required = notional / leverage;
  b.detail(position ? 'Margin required (approx.)' : 'Margin required at max leverage (approx.)', `${formatUsd(required)} at ${leverage}×`);
  if (required > withdrawable) {
    const msg = `This order needs about ${formatUsd(required)} of margin at ${leverage}×${position ? '' : ' (the maximum)'}, but only ${formatUsd(withdrawable)} is available${where}. It may be rejected.`;
    // HIP-3 DEX accounts can be funded via DEX abstraction, which this check does not see.
    b.warn(asset.dex ? 'info' : 'caution', 'insufficient_margin', asset.dex ? `${msg} (If DEX abstraction is on, collateral may come from your main account.)` : msg);
  }
}
