import { decodeAbiParameters, decodeFunctionData, parseAbi, parseAbiParameters, type Hex } from 'viem';
import { decimalString, formatUnits, PreviewBuilder, sameAddress, shortAddress } from '../format.ts';
import { CCTP, HYPEREVM_MAINNET, HYPEREVM_TESTNET, HYPERLIQUID, parseSpotSystemAddress } from '../chains.ts';
import { describeOrder, findSpotToken, resolveAsset } from '../hyperliquid/assets.ts';
import { decoded, nativeAmount, tokenInfo, type Adapter, type AdapterEnv, type Decoded } from './common.ts';

const TOKEN_ABI = parseAbi([
  'function transfer(address to, uint256 amount)',
  'function approve(address spender, uint256 amount)',
]);

function tokenCall(data: Hex) {
  try { return decodeFunctionData({ abi: TOKEN_ABI, data }); } catch { return null; }
}

/** Arbitrum → Hyperliquid deposits through Bridge2 (a plain USDC transfer to the bridge). */
export const bridge2Adapter: Adapter = async (tx, env) => {
  if (!tx.to) return null;
  const toBridge = sameAddress(tx.to, HYPERLIQUID.bridge2);
  const call = toBridge ? null : tokenCall(tx.data);
  const recipient = call ? (call.args[0] as string) : null;
  if (!toBridge && !sameAddress(recipient, HYPERLIQUID.bridge2)) return null;
  const b = new PreviewBuilder();

  if (toBridge) {
    // Direct contract calls (e.g. batched permit deposits run by relayers) are not decoded here.
    b.detail('Contract', `Hyperliquid Bridge2 (${HYPERLIQUID.bridge2})`).detail('Function selector', tx.data.slice(0, 10));
    if (tx.value > 0n) b.warn('danger', 'native_to_bridge', 'Sending ETH to the Hyperliquid bridge does not deposit it. Only native USDC transfers are credited.');
    b.warn('caution', 'bridge_direct_call', 'This calls the Hyperliquid bridge contract directly. Normal deposits are a USDC transfer to the bridge, so check why this dApp needs a direct call.');
    return decoded({ title: 'Call the Hyperliquid bridge contract', summary: 'A direct call to Hyperliquid Bridge2 that was not decoded.', decoder: 'hyperliquid_bridge2_call', status: 'opaque', b });
  }

  const amount = call!.args[1] as bigint;
  const usdc = CCTP.usdcByChain[42161];
  const info = await tokenInfo(env, tx.chainId, tx.to);
  if (call!.functionName === 'approve') {
    b.detail('Token', info?.symbol ?? tx.to, tx.to).detail('Spender', `Hyperliquid Bridge2 (${HYPERLIQUID.bridge2})`);
    if (amount >= 1n << 128n) b.warn('caution', 'unlimited_approval', 'This is an unlimited approval: the bridge contract could move all of this token from your wallet.');
    b.warn('info', 'bridge_approval_unneeded', 'A standard Hyperliquid deposit is a direct USDC transfer and does not need an approval.');
    return decoded({ title: `Allow the Hyperliquid bridge to spend ${info?.symbol ?? 'a token'}`, summary: 'Approves Bridge2 as a spender. This does not deposit anything.', decoder: 'hyperliquid_bridge2_approve', status: 'full', b });
  }

  if (tx.chainId !== 42161) {
    b.detail('Recipient', `Hyperliquid Bridge2 address (${HYPERLIQUID.bridge2})`).detail('Network', `chain ${tx.chainId}`);
    b.warn('danger', 'bridge_wrong_chain', 'Hyperliquid Bridge2 exists only on Arbitrum One. Tokens sent to this address on another chain will not be credited and are likely lost.');
    return decoded({ title: 'Transfer to the Hyperliquid bridge address on the wrong chain', summary: 'This transfer will not reach Hyperliquid.', decoder: 'hyperliquid_bridge2_deposit', status: 'full', b });
  }
  if (!sameAddress(tx.to, usdc)) {
    b.detail('Token', info ? `${info.symbol} (${tx.to})` : tx.to, tx.to).detail('Amount', info ? `${formatUnits(amount, info.decimals)} ${info.symbol}` : amount.toString(), amount.toString());
    b.warn('danger', 'bridge_wrong_token', `Hyperliquid only credits native USDC (${usdc}) sent to the bridge. ${info?.symbol ?? 'This token'} sent here will not be credited and is likely lost.`);
    return decoded({ title: `Send ${info?.symbol ?? 'tokens'} to the Hyperliquid bridge (not credited)`, summary: 'The bridge does not accept this token.', decoder: 'hyperliquid_bridge2_deposit', status: 'full', b });
  }

  const amountText = `${formatUnits(amount, 6)} USDC`;
  b.detail('Amount', amountText, amount.toString())
    .detail('From (Arbitrum)', tx.from)
    .detail('Credited to (Hyperliquid)', tx.from)
    .detail('Bridge', `Hyperliquid Bridge2 (${HYPERLIQUID.bridge2})`);
  if (amount < HYPERLIQUID.minDepositRaw) {
    b.warn('danger', 'deposit_below_minimum', `Deposits under ${formatUnits(HYPERLIQUID.minDepositRaw, 6)} USDC are not credited and the funds are lost. This deposit is ${amountText}.`);
  }
  b.warn('info', 'deposit_credited_to_sender', 'The deposit is credited to the Hyperliquid account with the same address as the sender. If the sender is a smart-contract wallet, make sure it can operate a Hyperliquid account.');
  return decoded({
    title: `Deposit ${amountText} to Hyperliquid`,
    summary: `Sends ${amountText} on Arbitrum to Hyperliquid's bridge; it is credited to your Hyperliquid account (${shortAddress(tx.from)}).`,
    decoder: 'hyperliquid_bridge2_deposit', status: 'full', b,
    assetChanges: [{ direction: 'out', account: tx.from, amount: formatUnits(amount, 6), symbol: 'USDC', raw: amount.toString(), asset: usdc, basis: 'requested' }],
  });
};

/** HyperEVM → HyperCore spot transfers via system addresses. */
export const hyperCoreSystemTransferAdapter: Adapter = async (tx, env) => {
  if (tx.chainId !== 999 || !tx.to) return null;
  const info = env.deps.hyperliquid?.mainnet;
  if (sameAddress(tx.to, HYPERLIQUID.hypeSystemAddress) && tx.data === '0x') {
    const amount = nativeAmount(999, tx.value);
    const b = new PreviewBuilder().detail('Amount', amount, tx.value.toString()).detail('Credited to (HyperCore spot)', tx.from);
    b.note('HYPE on HyperCore has 8 decimals; any dust below that precision is not credited.');
    return decoded({ title: `Move ${amount} to HyperCore`, summary: `Moves ${amount} from HyperEVM to your HyperCore spot balance.`, decoder: 'hypercore_system_transfer', status: 'full', b,
      assetChanges: [{ direction: 'out', account: tx.from, amount: formatUnits(tx.value, 18), symbol: 'HYPE', raw: tx.value.toString(), asset: 'native', basis: 'requested' }] });
  }
  const call = tokenCall(tx.data);
  if (!call || call.functionName !== 'transfer') return null;
  const recipient = call.args[0] as string;
  const tokenIndex = parseSpotSystemAddress(recipient);
  if (tokenIndex === null) return null;
  const amount = call.args[1] as bigint;
  const evmToken = await tokenInfo(env, 999, tx.to);
  const coreToken = await findSpotToken(info, { index: tokenIndex });
  const b = new PreviewBuilder().detail('Token contract', evmToken ? `${evmToken.symbol} (${tx.to})` : tx.to, tx.to).detail('System address', recipient).detail('HyperCore token index', String(tokenIndex));
  let symbol = evmToken?.symbol ?? coreToken?.name ?? `token #${tokenIndex}`;
  const decimals = evmToken?.decimals ?? (coreToken?.evmContract ? coreToken.weiDecimals + coreToken.evmContract.evm_extra_wei_decimals : undefined);
  const amountText = decimals !== undefined ? `${formatUnits(amount, decimals)} ${symbol}` : `${amount} base units of ${symbol}`;
  b.detail('Amount', amountText, amount.toString()).detail('Credited to (HyperCore spot)', tx.from);
  if (!coreToken) {
    b.warn('caution', 'core_token_unknown', `HyperCore token #${tokenIndex} could not be looked up, so the link between this contract and HyperCore was not checked.`);
  } else if (!coreToken.evmContract || !sameAddress(coreToken.evmContract.address, tx.to)) {
    b.warn('danger', 'core_token_mismatch', `This contract is not the HyperEVM contract linked to HyperCore token ${coreToken.name} (#${tokenIndex}). Tokens sent to this system address are likely lost.`);
  } else {
    symbol = coreToken.name;
  }
  return decoded({ title: `Move ${amountText} to HyperCore`, summary: `Transfers ${amountText} from HyperEVM to your HyperCore spot balance.`, decoder: 'hypercore_system_transfer', status: coreToken ? 'full' : 'partial', b,
    assetChanges: decimals !== undefined ? [{ direction: 'out', account: tx.from, amount: formatUnits(amount, decimals), symbol, raw: amount.toString(), asset: tx.to.toLowerCase(), basis: 'requested' }] : [] });
};

// CoreWriter action encoding: 0x01 (version) | uint24 action id | abi-encoded fields.
// IDs and field layouts were checked against hyperliquid-dev/hyper-evm-lib (HLConstants.sol,
// CoreWriterLib.sol) on 2026-11-02. Prices/sizes are 1e8-scaled,
// perp USD amounts are 1e6-scaled, HYPE amounts are 1e8-scaled wei.
const CORE_ACTIONS: Record<number, { name: string; params: string }> = {
  1: { name: 'limitOrder', params: 'uint32 asset, bool isBuy, uint64 limitPx, uint64 sz, bool reduceOnly, uint8 encodedTif, uint128 cloid' },
  2: { name: 'vaultTransfer', params: 'address vault, bool isDeposit, uint64 usd' },
  3: { name: 'tokenDelegate', params: 'address validator, uint64 amount, bool isUndelegate' },
  4: { name: 'stakingDeposit', params: 'uint64 amount' },
  5: { name: 'stakingWithdraw', params: 'uint64 amount' },
  6: { name: 'spotSend', params: 'address destination, uint64 token, uint64 amount' },
  7: { name: 'usdClassTransfer', params: 'uint64 ntl, bool toPerp' },
  8: { name: 'finalizeEvmContract', params: 'uint64 token, uint8 variant, uint64 createNonce' },
  9: { name: 'addApiWallet', params: 'address apiWallet, string apiWalletName' },
  10: { name: 'cancelOrderByOid', params: 'uint32 asset, uint64 oid' },
  11: { name: 'cancelOrderByCloid', params: 'uint32 asset, uint128 cloid' },
  12: { name: 'approveBuilderFee', params: 'uint64 maxFeeRate, address builder' },
  13: { name: 'sendAsset', params: 'address destination, address subAccount, uint32 sourceDex, uint32 destinationDex, uint64 token, uint64 amount' },
  15: { name: 'borrowLend', params: 'uint8 operation, uint64 token, uint64 amount' },
  16: { name: 'setAbstraction', params: 'address user, uint8 abstraction' },
};
const ABSTRACTIONS: Record<number, string> = { 1: 'disabled', 2: 'unified account', 3: 'portfolio margin' };
const TIF: Record<number, string> = { 1: 'Limit, add liquidity only (post-only)', 2: 'Limit, good til cancelled', 3: 'Limit, immediate or cancel' };

const CORE_WRITER_ABI = parseAbi(['function sendRawAction(bytes data)']);

/** HyperEVM → HyperCore actions submitted through the CoreWriter precompile. */
export const coreWriterAdapter: Adapter = async (tx, env) => {
  if (tx.chainId !== 999 || !sameAddress(tx.to, HYPERLIQUID.coreWriter)) return null;
  const b = new PreviewBuilder().detail('Contract', `CoreWriter (${HYPERLIQUID.coreWriter})`);
  b.warn('info', 'corewriter_async', 'CoreWriter actions run on HyperCore after the HyperEVM block. If the HyperCore action fails (e.g. insufficient balance), the EVM transaction still succeeds and gas is spent.');
  let raw: Hex;
  try { raw = decodeFunctionData({ abi: CORE_WRITER_ABI, data: tx.data }).args[0]; } catch {
    b.warn('caution', 'corewriter_unknown_function', 'Unrecognised CoreWriter function.');
    return decoded({ title: 'Send an unknown action to HyperCore', summary: 'The CoreWriter call could not be decoded.', decoder: 'corewriter', status: 'opaque', b });
  }
  const version = Number.parseInt(raw.slice(2, 4), 16);
  const id = Number.parseInt(raw.slice(4, 10), 16);
  const spec = CORE_ACTIONS[id];
  b.detail('Action', spec ? spec.name : `unknown (id ${id})`, String(id));
  if (version !== 1 || !spec) {
    b.warn('caution', 'corewriter_unknown_action', `CoreWriter action version ${version}, id ${id} is not recognised.`);
    return decoded({ title: 'Send an unknown action to HyperCore', summary: `Submits CoreWriter action ${id}, which is not decoded.`, decoder: 'corewriter', status: 'opaque', b });
  }
  let fields: readonly unknown[];
  try { fields = decodeAbiParameters(parseAbiParameters(spec.params), ('0x' + raw.slice(10)) as Hex); } catch {
    b.warn('danger', 'corewriter_malformed', `The ${spec.name} payload does not match its expected layout; HyperCore will probably reject it.`);
    return decoded({ title: `Send a malformed ${spec.name} to HyperCore`, summary: 'The action payload could not be decoded.', decoder: 'corewriter', status: 'partial', b });
  }
  const result = await describeCoreWriterAction(id, fields, tx.from, b, env);
  return decoded({ ...result, decoder: 'corewriter', status: result.status ?? 'full', b });
};

async function describeCoreWriterAction(id: number, f: readonly unknown[], from: string, b: PreviewBuilder, env: AdapterEnv): Promise<Pick<Decoded, 'title' | 'summary'> & { status?: Decoded['status'] }> {
  const info = env.deps.hyperliquid?.mainnet;
  const usd = (raw: bigint) => `${formatUnits(raw, 6)} USDC`;
  const hype = (raw: bigint) => `${formatUnits(raw, 8)} HYPE`;
  switch (id) {
    case 1: {
      const [asset, isBuy, limitPx, sz, reduceOnly, tif, cloid] = f as [number, boolean, bigint, bigint, boolean, number, bigint];
      const resolved = await resolveAsset(info, asset);
      const title = await describeOrder(b, info, resolved, { isBuy, price: decimalString(limitPx, 8), size: decimalString(sz, 8), reduceOnly, orderType: TIF[tif] ?? `unknown time-in-force ${tif}` });
      if (!TIF[tif]) b.warn('caution', 'unknown_tif', `Time-in-force code ${tif} is not recognised.`);
      if (cloid !== 0n) b.detail('Client order ID', '0x' + cloid.toString(16).padStart(32, '0'));
      return { title: `HyperCore order: ${title}`, summary: `Places a ${resolved.name} order on HyperCore from your HyperEVM contract/account ${shortAddress(from)}.`, status: resolved.kind === 'unknown' ? 'partial' : 'full' };
    }
    case 2: {
      const [vault, isDeposit, amount] = f as [string, boolean, bigint];
      b.detail('Vault', vault).detail('Amount', usd(amount), amount.toString());
      return { title: `${isDeposit ? 'Deposit' : 'Withdraw'} ${usd(amount)} ${isDeposit ? 'into' : 'from'} vault ${shortAddress(vault)}`, summary: `Moves perp USDC ${isDeposit ? 'into' : 'out of'} a Hyperliquid vault.` };
    }
    case 3: {
      const [validator, amount, undelegate] = f as [string, bigint, boolean];
      b.detail('Validator', validator).detail('Amount', hype(amount), amount.toString());
      return { title: `${undelegate ? 'Undelegate' : 'Delegate'} ${hype(amount)} ${undelegate ? 'from' : 'to'} ${shortAddress(validator)}`, summary: 'Changes HYPE staking delegation on HyperCore.' };
    }
    case 4:
    case 5: {
      const [amount] = f as [bigint];
      b.detail('Amount', hype(amount), amount.toString());
      return id === 4
        ? { title: `Move ${hype(amount)} from spot to staking`, summary: 'Transfers HYPE from your HyperCore spot balance into your staking balance.' }
        : { title: `Move ${hype(amount)} from staking to spot`, summary: 'Starts moving HYPE out of staking (subject to the unstaking queue).' };
    }
    case 6: {
      const [destination, tokenIndex, amount] = f as [string, bigint, bigint];
      const token = await findSpotToken(info, { index: Number(tokenIndex) });
      const amountText = token ? `${formatUnits(amount, token.weiDecimals)} ${token.name}` : `${amount} base units of token #${tokenIndex}`;
      b.detail('Recipient (HyperCore)', destination).detail('Token', token?.name ?? `#${tokenIndex}`, tokenIndex.toString()).detail('Amount', amountText, amount.toString());
      if (!token) b.warn('caution', 'core_token_unknown', `HyperCore token #${tokenIndex} could not be looked up.`);
      return { title: `Send ${amountText} on HyperCore to ${shortAddress(destination)}`, summary: 'Transfers a HyperCore spot token to another HyperCore account.', status: token ? 'full' : 'partial' };
    }
    case 7: {
      const [ntl, toPerp] = f as [bigint, boolean];
      b.detail('Amount', usd(ntl), ntl.toString()).detail('Direction', toPerp ? 'Spot → Perps' : 'Perps → Spot');
      return { title: `Move ${usd(ntl)} ${toPerp ? 'from spot to perps' : 'from perps to spot'}`, summary: 'Moves USDC between your HyperCore spot and perps balances.' };
    }
    case 8: {
      const [token, variant, nonce] = f as [bigint, number, bigint];
      b.detail('Token index', token.toString()).detail('Variant', String(variant)).detail('Create nonce', nonce.toString());
      b.warn('caution', 'finalize_evm_contract', 'Links a HyperCore token to a HyperEVM contract. This is a token-deployer operation.');
      return { title: `Finalize EVM contract link for token #${token}`, summary: 'Token deployer action.' };
    }
    case 9: {
      const [wallet, name] = f as [string, string];
      b.detail('API wallet', wallet).detail('Name', name || '(unnamed)');
      b.warn('danger', 'add_api_wallet', `${shortAddress(wallet)} will be able to sign trading and account actions for this account (Hyperliquid limits agent transfers to the account itself). Only add wallets you control.`);
      return { title: `Authorise API wallet ${shortAddress(wallet)}`, summary: 'Grants trading authority on HyperCore to another key.' };
    }
    case 10:
    case 11: {
      const [asset, oid] = f as [number, bigint];
      const resolved = await resolveAsset(info, asset);
      b.detail('Market', resolved.name, String(asset)).detail(id === 10 ? 'Order ID' : 'Client order ID', id === 10 ? oid.toString() : '0x' + oid.toString(16).padStart(32, '0'));
      return { title: `Cancel a ${resolved.name} order`, summary: 'Cancels an open HyperCore order.' };
    }
    case 12: {
      const [rate, builder] = f as [bigint, string];
      b.detail('Builder', builder).detail('Maximum fee rate', `${Number(rate) / 1000}% (assuming tenths of a basis point)`, rate.toString());
      b.warn('caution', 'approve_builder_fee', `${shortAddress(builder)} will be allowed to charge a fee on orders it submits for you, up to this rate.`);
      return { title: `Approve builder fee for ${shortAddress(builder)}`, summary: 'Allows a frontend/builder to add a fee to your orders.' };
    }
    case 13: {
      const [destination, subAccount, sourceDex, destinationDex, tokenIndex, amount] = f as [string, string, number, number, bigint, bigint];
      const token = await findSpotToken(info, { index: Number(tokenIndex) });
      const amountText = token ? `${formatUnits(amount, token.weiDecimals)} ${token.name}` : `${amount} base units of token #${tokenIndex}`;
      b.detail('Recipient', destination).detail('Sub-account', /^0x0{40}$/.test(subAccount) ? 'none' : subAccount).detail('Source DEX', String(sourceDex)).detail('Destination DEX', String(destinationDex)).detail('Amount', amountText, amount.toString());
      return { title: `Send ${amountText} to ${shortAddress(destination)}`, summary: 'Transfers an asset between HyperCore accounts or DEXes.', status: token ? 'full' : 'partial' };
    }
    case 15: {
      const [op, tokenIndex, amount] = f as [number, bigint, bigint];
      const token = await findSpotToken(info, { index: Number(tokenIndex) });
      const amountText = token ? `${formatUnits(amount, token.weiDecimals)} ${token.name}` : `${amount} base units of token #${tokenIndex}`;
      const verb = op === 0 ? 'Supply' : op === 1 ? 'Withdraw' : `Borrow/lend operation ${op}`;
      b.detail('Operation', verb, String(op)).detail('Amount', amountText, amount.toString());
      if (op !== 0 && op !== 1) b.warn('caution', 'unknown_borrow_lend_op', `Borrow/lend operation ${op} is not recognised.`);
      return { title: `${verb} ${amountText} ${op === 0 ? 'to' : 'from'} HyperCore lending`, summary: 'Changes your HyperCore lending position.', status: token && (op === 0 || op === 1) ? 'full' : 'partial' };
    }
    case 16: {
      const [user, mode] = f as [string, number];
      const label = ABSTRACTIONS[mode] ?? `mode ${mode}`;
      b.detail('Account', user).detail('Account mode', label, String(mode));
      b.warn('caution', 'set_abstraction', `Changes how balances and margin are shared across this account's markets (to: ${label}). This affects liquidation risk.`);
      return { title: `Set HyperCore account mode to ${label}`, summary: 'Changes the account abstraction (margin sharing) mode.', status: ABSTRACTIONS[mode] ? 'full' : 'partial' };
    }
  }
  return { title: 'HyperCore action', summary: '', status: 'opaque' };
}

const CDW_ABI = parseAbi([
  'function deposit(uint256 amount, uint32 destinationDex)',
  'function depositFor(address recipient, uint256 amount, uint32 destinationDex)',
  'function depositWithAuth(uint256 amount, uint256 authValidAfter, uint256 authValidBefore, bytes32 authNonce, uint8 v, bytes32 r, bytes32 s, uint32 destinationDex)',
]);

/**
 * HyperEVM -> HyperCore USDC deposits through Circle's CoreDepositWallet (Circle: "Transfer USDC from HyperEVM to HyperCore").
 * Circle's interface page: sending USDC or any token directly to the CoreDepositWallet does not deposit; funds are stuck.
 */
export const coreDepositWalletAdapter: Adapter = async (tx) => {
  const hyperEvm = tx.chainId === 999 ? HYPEREVM_MAINNET : tx.chainId === 998 ? HYPEREVM_TESTNET : null;
  if (!hyperEvm || !tx.to) return null;
  const b = new PreviewBuilder();
  const transfer = tokenCall(tx.data);
  if (transfer?.functionName === 'transfer' && sameAddress(transfer.args[0] as string, hyperEvm.coreDepositWallet)) {
    b.detail('Token contract', tx.to).detail('Recipient', `Circle CoreDepositWallet (${hyperEvm.coreDepositWallet})`);
    b.warn('danger', 'transfer_to_deposit_wallet', 'Sending tokens directly to the CoreDepositWallet does not deposit them on HyperCore; Circle says the funds are permanently stuck. Use its deposit function instead.');
    return decoded({ title: 'Send tokens directly to the CoreDepositWallet (funds get stuck)', summary: 'A plain token transfer to Circle\'s deposit contract, which is not credited anywhere.', decoder: 'core_deposit_wallet', status: 'full', b });
  }
  if (!sameAddress(tx.to, hyperEvm.coreDepositWallet)) return null;
  let call;
  try { call = decodeFunctionData({ abi: CDW_ABI, data: tx.data }); } catch {
    b.warn('caution', 'unknown_function', 'Unrecognised CoreDepositWallet function.');
    return decoded({ title: 'Call Circle CoreDepositWallet', summary: 'A call to the HyperCore deposit contract that was not decoded.', decoder: 'core_deposit_wallet', status: 'opaque', b });
  }
  const args = call.args as readonly unknown[];
  const amount = (call.functionName === 'depositFor' ? args[1] : args[0]) as bigint;
  const dex = args[args.length - 1] as number;
  const recipient = call.functionName === 'depositFor' ? (args[0] as string).toLowerCase() : tx.from;
  const dexLabel = dex === 0 ? 'perps' : dex === 4294967295 ? 'spot' : `DEX ${dex}`;
  const amountText = `${formatUnits(amount, 6)} USDC`;
  b.detail('Amount', amountText, amount.toString()).detail('HyperCore recipient', recipient).detail('HyperCore balance', dexLabel, String(dex));
  if (amount === 0n) b.warn('caution', 'will_revert', 'The amount is zero ("Amount must be greater than zero"), so this reverts.');
  if (call.functionName === 'depositFor') {
    const bad = /^0x0{40}$/.test(recipient) ? 'the zero address' : sameAddress(recipient, CCTP.usdcSystemAddress) ? 'the USDC system address' : sameAddress(recipient, hyperEvm.coreDepositWallet) ? 'the CoreDepositWallet' : null;
    if (bad) b.warn('caution', 'will_revert', `The recipient is ${bad}, which CoreDepositWallet rejects, so this reverts.`);
    else if (!sameAddress(recipient, tx.from)) b.warn('caution', 'recipient_not_sender', `The USDC will be credited to ${shortAddress(recipient)} on HyperCore, not to you.`);
  }
  if (call.functionName === 'depositWithAuth') b.note('This uses a ReceiveWithAuthorization signature you gave earlier for the CoreDepositWallet.');
  else b.note('The CoreDepositWallet must already be approved to spend this USDC.');
  if (dex !== 0 && dex !== 4294967295) b.warn('caution', 'cctp_unknown_dex', `DEX ${dex} is neither perps (0) nor spot (4294967295). Unless Circle has enabled it, the USDC is credited to spot instead.`);
  return decoded({
    title: `Deposit ${amountText} to HyperCore ${dexLabel}`,
    summary: `Moves ${amountText} from HyperEVM into ${sameAddress(recipient, tx.from) ? 'your' : shortAddress(recipient) + "'s"} HyperCore ${dexLabel} balance via Circle's CoreDepositWallet.`,
    decoder: 'core_deposit_wallet', status: 'full', b,
    assetChanges: [{ direction: 'out', account: tx.from, amount: formatUnits(amount, 6), symbol: 'USDC', raw: amount.toString(), asset: hyperEvm.usdc, basis: 'requested' }],
  });
};
