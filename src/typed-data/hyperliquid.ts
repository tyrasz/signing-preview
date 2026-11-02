import { formatDecimalString, formatDuration, formatTimestamp, formatUnits, formatUsd, parseUnits, PreviewBuilder, sameAddress, shortAddress } from '../format.ts';
import { HYPERLIQUID, parseSpotSystemAddress } from '../chains.ts';
import { l1ActionHash } from '../hyperliquid/action-hash.ts';
import { describeOrder, findSpotToken, resolveAsset, TIF_LABELS } from '../hyperliquid/assets.ts';
import type { HyperliquidInfo, Network } from '../types.ts';
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
      describeDestination(b, env, destination, 'Arbitrum recipient');
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
        if (known && systemIndex !== null && known.index !== systemIndex) b.warn('danger', 'system_address_mismatch', `This system address belongs to token #${systemIndex}, not ${known.name} (#${known.index}). The transfer to HyperEVM will not work as intended.`);
        if (known && !known.evmContract) b.warn('danger', 'no_evm_contract', `${known.name} is not linked to a HyperEVM contract.`);
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
      b.warn('caution', 'approve_agent', `${shortAddress(agent)} will be able to place and cancel orders for your account${requester}. Agents cannot withdraw, but a malicious agent can still lose money by trading. The Hyperliquid app uses this for "Enable trading"; only approve it on sites you trust.`);
      if (!name) b.note('An unnamed agent replaces your previous unnamed agent.');
      return out(`Authorise ${shortAddress(agent)} to trade for you`, `Approves an API wallet ("agent") that can sign trading actions on your Hyperliquid account without asking your wallet again.`);
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
      const name = token.split(':')[0];
      b.detail('Token', name, token).detail('Amount', `${formatDecimalString(amount)} ${name}`, amount)
        .detail('Source DEX', str(m.sourceDex) || 'default').detail('Destination DEX', str(m.destinationDex) || 'default');
      if (str(m.fromSubAccount)) b.detail('From sub-account', str(m.fromSubAccount));
      describeDestination(b, env, destination);
      checkNonce(b, env, m.nonce, 'Nonce');
      return out(`Send ${formatDecimalString(amount)} ${name} to ${shortAddress(destination)}`, 'Transfers an asset between Hyperliquid accounts or DEXes.');
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
        await marginCheck(b, info, account, asset.midKey, Number(spec.price) * Number(spec.size), spec.reduceOnly);
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
    case 'noop':
      return { title: 'Hyperliquid no-op', summary: 'Consumes a nonce without doing anything (used to invalidate pending actions).', status: 'full' };
  }
  for (const [key, value] of Object.entries(action)) if (key !== 'type') b.detail(key, str(value));
  b.warn('caution', 'l1_unknown_action', `Action type "${type}" is not recognised. Its fields are listed as signed.`);
  return { title: `Hyperliquid action: ${type}`, summary: 'An unrecognised Hyperliquid L1 action.', status: 'partial' };
}

async function marginCheck(b: PreviewBuilder, info: HyperliquidInfo | undefined, account: string | null, coin: string | null, notional: number, reduceOnly: boolean) {
  if (!info || !account || !coin || reduceOnly || !Number.isFinite(notional)) return;
  let state;
  try { state = await info.clearinghouseState(account); } catch { return; }
  const withdrawable = Number(state.withdrawable);
  b.detail('Account value', formatUsd(Number(state.marginSummary.accountValue))).detail('Available margin', formatUsd(withdrawable));
  const position = state.assetPositions.find(p => p.position.coin === coin)?.position;
  if (position) {
    b.detail(`Current ${coin} position`, `${formatDecimalString(position.szi)} @ ${formatDecimalString(position.entryPx ?? '?')} (${position.leverage.value}× ${position.leverage.type})`);
    if (position.liquidationPx) b.detail(`Current ${coin} liquidation price`, formatDecimalString(position.liquidationPx));
    const required = notional / position.leverage.value;
    b.detail('Margin required (approx.)', formatUsd(required));
    if (required > withdrawable) b.warn('caution', 'insufficient_margin', `This order needs about ${formatUsd(required)} of margin at ${position.leverage.value}×, but only ${formatUsd(withdrawable)} is available. It may be rejected.`);
  } else if (notional > withdrawable * 50) {
    b.warn('caution', 'insufficient_margin', `The order's notional (${formatUsd(notional)}) is very large compared with the available margin (${formatUsd(withdrawable)}). It may be rejected.`);
  }
}
