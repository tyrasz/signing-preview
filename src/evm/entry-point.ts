// Transactions to an ERC-4337 EntryPoint: a bundler's handleOps (each UserOperation's calls decoded as that
// account's own transaction), and deposits to or withdrawals from an account's gas deposit.
import { decodeFunctionData, parseAbi, type Hex } from 'viem';
import { formatUnits, PreviewBuilder, sameAddress, shortAddress } from '../format.ts';
import { CHAINS } from '../chains.ts';
import { decoded, type Adapter, type Decoded } from './common.ts';
import { decodeTransaction } from './transaction.ts';

/** EntryPoints with the packed UserOperation struct (v0.7 on), at the same address on every chain. */
export const PACKED_ENTRY_POINTS: Record<string, string> = {
  '0x0000000071727de22e5e9d8baf0edac6f37da032': 'EntryPoint v0.7',
  '0x4337084d9e255ff0702461cf8895ce9e3b5ff108': 'EntryPoint v0.8',
  '0x433709009b8330fda32311df1c2afa402ed8d009': 'EntryPoint v0.9',
};
/** EntryPoint v0.6, whose UserOperation struct has each gas field on its own. */
const V06 = '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789';
const COMMON = ['function depositTo(address account) payable', 'function withdrawTo(address withdrawAddress, uint256 withdrawAmount)'] as const;
const ABI = parseAbi([
  'function handleOps((address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature)[] ops, address beneficiary)',
  ...COMMON,
]);
const ABI_V06 = parseAbi([
  'function handleOps((address sender, uint256 nonce, bytes initCode, bytes callData, uint256 callGasLimit, uint256 verificationGasLimit, uint256 preVerificationGas, uint256 maxFeePerGas, uint256 maxPriorityFeePerGas, bytes paymasterAndData, bytes signature)[] ops, address beneficiary)',
  ...COMMON,
]);
/** UserOperations whose calls are decoded; the rest of a bundle is listed by account. */
const DECODED_OPS = 5;

export const entryPointAdapter: Adapter = async (tx, env) => {
  const to = tx.to?.toLowerCase();
  const name = to === V06 ? 'EntryPoint v0.6' : to && PACKED_ENTRY_POINTS[to];
  if (!name) return null;
  let call;
  try { call = to === V06 ? decodeFunctionData({ abi: ABI_V06, data: tx.data }) : decodeFunctionData({ abi: ABI, data: tx.data }); } catch { return null; }
  const b = new PreviewBuilder().detail('Contract', `${name} (${tx.to})`, tx.to!);
  const native = CHAINS[tx.chainId];
  const amount = (v: bigint) => `${formatUnits(v, native?.nativeDecimals ?? 18)} ${native?.nativeSymbol ?? 'native'}`;
  if (call.functionName === 'depositTo') {
    const [account] = call.args;
    const yours = sameAddress(account, tx.from);
    b.detail('Account', account).detail('Amount', amount(tx.value), tx.value.toString());
    return decoded({ title: `Deposit ${amount(tx.value)} for ${yours ? 'your account' : shortAddress(account)}'s ERC-4337 gas`, summary: `Adds to ${yours ? 'your' : `${shortAddress(account)}'s`} deposit in the EntryPoint, which pays for its UserOperations' gas.`, decoder: 'erc4337_entry_point', status: 'full', b,
      assetChanges: tx.value > 0n ? [{ direction: 'out', account: tx.from, amount: formatUnits(tx.value, native?.nativeDecimals ?? 18), symbol: native?.nativeSymbol ?? 'native', raw: tx.value.toString(), asset: 'native', standard: 'native', basis: 'requested' }] : [] });
  }
  if (call.functionName === 'withdrawTo') {
    const [to, value] = call.args;
    b.detail('To', to).detail('Amount', amount(value), value.toString());
    if (!sameAddress(to, tx.from)) b.warn('info', 'withdraw_elsewhere', `The deposit is withdrawn to ${shortAddress(to)}, not to the sender.`);
    return decoded({ title: `Withdraw ${amount(value)} of ERC-4337 gas deposit`, summary: `Takes ${amount(value)} out of the sender's deposit in the EntryPoint, to ${shortAddress(to)}.`, decoder: 'erc4337_entry_point', status: 'full', b });
  }
  const [ops, beneficiary] = call.args;
  b.detail('UserOperations', String(ops.length)).detail('Beneficiary', beneficiary, beneficiary);
  const inner: Decoded[] = [];
  for (const [i, op] of ops.entries()) {
    const sender = op.sender.toLowerCase();
    const who = sameAddress(sender, tx.from) ? 'your account' : shortAddress(sender);
    if (i >= DECODED_OPS) { b.detail(`UserOperation ${i + 1}`, `from ${who}`, sender); continue; }
    const d = op.callData === '0x' ? decoded({ title: 'no calls', summary: '', decoder: 'erc4337_entry_point', status: 'full' })
      : await decodeTransaction({ chainId: tx.chainId, from: sender, to: sender, data: op.callData.toLowerCase() as Hex, value: 0n, ...(op.initCode !== '0x' && { codeInPlace: true }) }, env.deps, env.context);
    // Decoded as the account's own transaction, its title speaks to the account; when another account's operation is
    // submitted, it is said of that account.
    if (!sameAddress(sender, tx.from)) d.title = d.title.replace(/ from your account$/, '').replace(/^Call your own account/, 'Call its own account');
    inner.push(d);
    b.detail(`UserOperation ${i + 1}`, `from ${who}: ${d.title}`, sender);
    // (The caution that a run used the caller's state, from a Safe the operation's calls run execTransaction on, is said once.)
    for (const w of d.b.warnings) if (w.code === 'state_overridden') b.warn(w.severity, w.code, w.message); else if (w.severity !== 'info') b.warnings.push({ ...w, message: `UserOperation ${i + 1}: ${w.message}` });
  }
  const own = ops.filter(op => sameAddress(op.sender, tx.from)).length;
  if (own < ops.length) b.warn('info', 'erc4337_bundle', `This submits ${ops.length - own === 1 ? 'a UserOperation' : `${ops.length - own} UserOperations`} of other accounts, as a bundler does: you pay the gas now, and the EntryPoint refunds it to ${sameAddress(beneficiary, tx.from) ? 'you' : shortAddress(beneficiary)} from the accounts' deposits.`);
  const statuses = inner.map(d => d.status);
  return decoded({
    title: ops.length === 1 ? `Submit ${sameAddress(ops[0].sender, tx.from) ? 'a' : `${shortAddress(ops[0].sender)}'s`} UserOperation: ${inner[0]?.title ?? 'no calls'}` : `Submit ${ops.length} UserOperations (an ERC-4337 bundle)`,
    summary: `Runs ${ops.length === 1 ? 'a UserOperation' : `${ops.length} UserOperations`} through the ${name}${ops.length === 1 ? ` from ${sameAddress(ops[0].sender, tx.from) ? 'your account' : shortAddress(ops[0].sender)}` : ''}.`,
    decoder: 'erc4337_entry_point', status: statuses.includes('opaque') || statuses.includes('partial') || ops.length > DECODED_OPS ? 'partial' : 'full', b,
  });
};
