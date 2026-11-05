import { decodeFunctionData, parseAbi } from 'viem';
import { formatUnits, isUnlimited, PreviewBuilder, sameAddress, shortAddress, formatTimestamp } from '../format.ts';
import { PERMIT2 } from '../chains.ts';
import { decoded, nativeAmount, selectorOf, tokenAmount, tokenInfo, tokenSourceWarnings, type Adapter } from './common.ts';

const TOKEN_ABI = parseAbi([
  'function transfer(address to, uint256 amount)',
  'function approve(address spender, uint256 amount)',
  'function transferFrom(address from, address to, uint256 amount)',
  'function increaseAllowance(address spender, uint256 addedValue)',
  'function setApprovalForAll(address operator, bool approved)',
]);

const PERMIT2_ABI = parseAbi([
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
]);

const WETH_ABI = parseAbi(['function deposit()', 'function withdraw(uint256 amount)']);

function tryDecode<T extends readonly unknown[]>(abi: T, data: `0x${string}`) {
  try {
    return decodeFunctionData({ abi: abi as never, data }) as { functionName: string; args: readonly unknown[] };
  } catch {
    return null;
  }
}

/** Plain native-asset transfers and contract creation. */
export const nativeAdapter: Adapter = async (tx) => {
  if (tx.to === null) {
    const b = new PreviewBuilder().detail('Init code size', `${(tx.data.length - 2) / 2} bytes`);
    b.warn('caution', 'contract_creation', 'This deploys a new contract. Its behaviour cannot be summarised from the init code.');
    if (tx.value > 0n) b.detail('Value sent', nativeAmount(tx.chainId, tx.value), tx.value.toString());
    return decoded({ title: 'Deploy a contract', summary: 'Creates a new smart contract from the supplied code.', decoder: 'contract_creation', status: 'partial', b });
  }
  if (tx.data !== '0x') return null;
  const amount = nativeAmount(tx.chainId, tx.value);
  const b = new PreviewBuilder().detail('Recipient', tx.to).detail('Amount', amount, tx.value.toString());
  if (sameAddress(tx.to, tx.from)) b.warn('info', 'self_transfer', 'The recipient is the sender; only the network fee is spent.');
  return decoded({
    title: `Send ${amount}`,
    summary: `Sends ${amount} to ${shortAddress(tx.to)}.`,
    decoder: 'native_transfer', status: 'full', b,
    assetChanges: tx.value > 0n ? [{ direction: 'out', account: tx.from, amount: amount.split(' ')[0], symbol: amount.split(' ')[1], raw: tx.value.toString(), asset: 'native', basis: 'requested' }] : [],
  });
};

export const erc20Adapter: Adapter = async (tx, env) => {
  if (!tx.to || tx.data === '0x') return null;
  if (sameAddress(tx.to, PERMIT2)) {
    const call = tryDecode(PERMIT2_ABI, tx.data);
    if (!call) return null;
    const [token, spender, amount, expiration] = call.args as [string, string, bigint, number];
    const info = await tokenInfo(env, tx.chainId, token);
    const b = new PreviewBuilder()
      .detail('Token', info ? info.symbol : token, token)
      .detail('Spender', spender)
      .detail('Amount', isUnlimited(amount) ? 'Unlimited' : tokenAmount(amount, info, token), amount.toString())
      .detail('Expires', formatTimestamp(Number(expiration) * 1000), expiration.toString());
    tokenSourceWarnings(b, tx.chainId, info);
    if (isUnlimited(amount)) b.warn('caution', 'unlimited_approval', `${shortAddress(spender)} can move any amount of this token through Permit2 until the approval expires or is revoked.`);
    return decoded({ title: `Permit2: allow ${shortAddress(spender)} to spend ${info?.symbol ?? 'a token'}`, summary: 'Sets a Permit2 allowance for another address.', decoder: 'permit2_approve', status: info ? 'full' : 'partial', b });
  }
  const call = tryDecode(TOKEN_ABI, tx.data) ?? tryDecode(WETH_ABI, tx.data);
  if (!call) return null;
  const info = await tokenInfo(env, tx.chainId, tx.to);
  const token = tx.to;
  const symbol = info?.symbol ?? `token ${shortAddress(token)}`;
  const b = new PreviewBuilder().detail('Token contract', info ? `${info.symbol} (${token})` : token, token);
  tokenSourceWarnings(b, tx.chainId, info);
  if (!info) {
    b.warn('caution', 'unknown_token', 'This token is not in the known-token list, so its name and decimals are unverified. Amounts are shown in base units.');
    b.note('The ERC-20 function shape was decoded, but the contract was not verified to be a standard token.');
  }
  const status = info ? 'full' : 'partial';
  const change = (direction: 'out' | 'in', account: string, raw: bigint) => ({
    direction, account, amount: info ? formatUnits(raw, info.decimals) : raw.toString(), symbol: info?.symbol ?? token, raw: raw.toString(), asset: token, basis: 'requested' as const,
  });
  switch (call.functionName) {
    case 'transfer': {
      const [to, amount] = call.args as [string, bigint];
      b.detail('Recipient', to).detail('Amount', tokenAmount(amount, info, token), amount.toString());
      if (sameAddress(to, token)) b.warn('danger', 'transfer_to_token_contract', 'The recipient is the token contract itself. Tokens sent there are usually lost.');
      if (amount === 0n) b.warn('caution', 'zero_transfer', 'This transfers zero tokens. Zero-value transfers are a common address-poisoning trick.');
      return decoded({ title: `Send ${tokenAmount(amount, info, token)}`, summary: `Transfers ${tokenAmount(amount, info, token)} to ${shortAddress(to)}.`, decoder: 'erc20_transfer', status, b, assetChanges: [change('out', tx.from, amount)] });
    }
    case 'transferFrom': {
      const [from, to, amount] = call.args as [string, string, bigint];
      b.detail('From', from).detail('Recipient', to).detail('Amount', tokenAmount(amount, info, token), amount.toString());
      if (!sameAddress(from, tx.from)) b.warn('info', 'transfer_from_other', `Moves tokens out of ${shortAddress(from)} using an allowance it granted to you.`);
      return decoded({ title: `Transfer ${tokenAmount(amount, info, token)} from ${shortAddress(from)}`, summary: `Moves ${tokenAmount(amount, info, token)} from ${shortAddress(from)} to ${shortAddress(to)}.`, decoder: 'erc20_transfer_from', status, b });
    }
    case 'approve':
    case 'increaseAllowance': {
      const [spender, amount] = call.args as [string, bigint];
      const unlimited = isUnlimited(amount);
      const amountText = unlimited ? `unlimited ${symbol}` : tokenAmount(amount, info, token);
      b.detail('Spender', spender).detail(call.functionName === 'approve' ? 'Allowance' : 'Allowance increase', unlimited ? 'Unlimited' : tokenAmount(amount, info, token), amount.toString());
      if (unlimited) b.warn('caution', 'unlimited_approval', `${shortAddress(spender)} will be able to move all of your ${symbol}, now and in the future, until you revoke the approval.`);
      if (amount === 0n && call.functionName === 'approve') {
        return decoded({ title: `Revoke ${symbol} approval for ${shortAddress(spender)}`, summary: `Sets the allowance of ${shortAddress(spender)} to zero.`, decoder: 'erc20_approve', status, b });
      }
      return decoded({ title: `Allow ${shortAddress(spender)} to spend ${amountText}`, summary: `Grants ${shortAddress(spender)} permission to transfer ${amountText} from your account. No tokens move yet.`, decoder: 'erc20_approve', status, b });
    }
    case 'setApprovalForAll': {
      const [operator, approved] = call.args as [string, boolean];
      b.detail('Operator', operator).detail('Approved', approved ? 'Yes' : 'No (revoke)');
      if (approved) b.warn('danger', 'approval_for_all', `${shortAddress(operator)} will be able to transfer every token you hold in this collection. This is the most common NFT drain pattern; only approve marketplaces you trust.`);
      return decoded({ title: approved ? `Give ${shortAddress(operator)} control of all tokens in this collection` : `Revoke collection access for ${shortAddress(operator)}`, summary: approved ? 'Grants an operator permission over the whole collection.' : 'Removes an operator approval.', decoder: 'set_approval_for_all', status: 'full', b });
    }
    case 'deposit': {
      const amount = nativeAmount(tx.chainId, tx.value);
      b.detail('Amount', amount, tx.value.toString());
      return decoded({ title: `Wrap ${amount}`, summary: `Deposits ${amount} into ${symbol}. Only meaningful if this contract is the real wrapped-native token.`, decoder: 'weth_deposit', status, b });
    }
    case 'withdraw': {
      const [amount] = call.args as [bigint];
      b.detail('Amount', tokenAmount(amount, info, token), amount.toString());
      return decoded({ title: `Unwrap ${tokenAmount(amount, info, token)}`, summary: `Withdraws native currency from ${symbol}.`, decoder: 'weth_withdraw', status, b });
    }
  }
  return null;
};

/** Last resort: the call cannot be interpreted. */
export const unknownCallAdapter: Adapter = async (tx) => {
  const selector = selectorOf(tx.data) ?? tx.data;
  const b = new PreviewBuilder()
    .detail('Contract', tx.to ?? '')
    .detail('Function selector', selector)
    .detail('Calldata size', `${(tx.data.length - 2) / 2} bytes`);
  if (tx.value > 0n) b.detail('Value sent', nativeAmount(tx.chainId, tx.value), tx.value.toString());
  b.warn('caution', 'unknown_function', 'This contract call could not be decoded. You would be signing it blind; rely on the simulated balance changes, if shown, or the dApp you trust.');
  return decoded({ title: `Call contract ${shortAddress(tx.to ?? '')}`, summary: `Calls an unrecognised function (${selector}).`, decoder: 'unknown', status: 'opaque', b });
};
