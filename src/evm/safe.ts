// execTransaction on a Safe: the SafeTx it carries, decoded (see src/safe.ts), whoever sends it.
import { decodeFunctionData, parseAbi } from 'viem';
import { PreviewBuilder } from '../format.ts';
import { describeSafeTx, viaExecTransaction } from '../safe.ts';
import { decoded, type Adapter } from './common.ts';

const ABI = parseAbi(['function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)']);

export const safeExecAdapter: Adapter = async (tx, env) => {
  if (!tx.to || !tx.data.startsWith('0x6a761202')) return null;
  let call;
  try { call = decodeFunctionData({ abi: ABI, data: tx.data }); } catch { return null; }
  const [to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, signatures] = call.args;
  const b = new PreviewBuilder();
  const t = { safe: tx.to, to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver };
  // The transaction as sent, signatures and all, with the Safe's configuration read again after it.
  const r = await describeSafeTx(t, tx.chainId, env, b, viaExecTransaction(t, tx.chainId, env, b, { request: { chainId: tx.chainId, from: tx.from, to: tx.to, data: tx.data, value: tx.value } }));
  b.detail('Owner signatures', String(Math.floor((signatures.length - 2) / 130)));
  return decoded({ title: `Execute a Safe transaction: ${r.title}`, summary: r.summary, decoder: 'safe_exec', status: r.status, b, ...(r.assetChanges.length && { assetChanges: r.assetChanges }) });
};
