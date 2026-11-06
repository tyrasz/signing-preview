// Smart-account batches: an account (an EIP-7702 delegated EOA, or a smart wallet) calling itself, so its own code
// runs a list of calls as the account. The calls are what matters, so each is decoded as if it were its own
// transaction from the account: "Run 2 calls from your account: Send 1 USDC to 0xb0b…; Approve …".
//
// Formats: ERC-7579 and ERC-7821 execute(bytes32 mode, bytes executionData) (MetaMask's DeleGator, Safe's 7579
// adapter, Ithaca/Porto, OpenZeppelin's accounts), and executeBatch((address,uint256,bytes)[]) /
// execute(address,uint256,bytes) (Coinbase Smart Wallet, eth-infinitism's Simple7702Account and most ERC-4337
// accounts).
import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, parseAbi, type Hex } from 'viem';
import { formatUnits, PreviewBuilder, sameAddress, shortAddress } from '../format.ts';
import { CHAINS } from '../chains.ts';
import { decoded, type Adapter, type Decoded } from './common.ts';
import { decodeTransaction } from './transaction.ts';
import { ownDelegateAfter } from './eip7702.ts';

const ABI = parseAbi([
  'function execute(bytes32 mode, bytes executionData)',
  'function executeBatch((address target, uint256 value, bytes data)[] calls)',
  'function execute(address target, uint256 value, bytes data)',
]);
const CALLS = [{ type: 'tuple[]', components: [{ name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }] }] as const;
const MAX_CALLS = 20;

type Call = { target: string; value: bigint; data: Hex };

/**
 * The calls an ERC-7579 / ERC-7821 executionData holds, by the mode's call type (byte 0): single (packed target,
 * value, calldata), batch (abi-encoded calls, optionally followed by ERC-7821's opData) or delegatecall (packed
 * target, calldata). Null when it doesn't parse.
 */
function erc7579Calls(mode: Hex, data: Hex): { calls: Call[]; delegatecall: boolean; tryMode: boolean } | null {
  const callType = mode.slice(2, 4), tryMode = mode.slice(4, 6) === '01';
  const body = data.slice(2);
  if (callType === '00') {
    if (body.length < 104) return null;
    return { calls: [{ target: `0x${body.slice(0, 40)}`, value: BigInt(`0x${body.slice(40, 104)}`), data: `0x${body.slice(104)}` }], delegatecall: false, tryMode };
  }
  if (callType === 'ff') {
    if (body.length < 40) return null;
    return { calls: [{ target: `0x${body.slice(0, 40)}`, value: 0n, data: `0x${body.slice(40)}` }], delegatecall: true, tryMode };
  }
  if (callType !== '01') return null;
  // abi.encode(calls), or ERC-7821's abi.encode(calls, opData): only a layout that re-encodes to the same bytes fits.
  const WITH_OP = [...CALLS, { type: 'bytes' }] as const;
  const same = (x: Hex) => x.toLowerCase() === data.toLowerCase();
  try { const [calls] = decodeAbiParameters(CALLS, data); if (same(encodeAbiParameters(CALLS, [calls]))) return { calls: [...calls], delegatecall: false, tryMode }; } catch { /* next */ }
  try { const [calls, op] = decodeAbiParameters(WITH_OP, data); if (same(encodeAbiParameters(WITH_OP, [calls, op]))) return { calls: [...calls], delegatecall: false, tryMode }; } catch { /* neither */ }
  return null;
}

export const smartAccountAdapter: Adapter = async (tx, env) => {
  if (!tx.to || !sameAddress(tx.to, tx.from) || tx.data.length < 10) return null;
  let parsed: { calls: Call[]; delegatecall: boolean; tryMode: boolean; standard: string } | null = null;
  try {
    const call = decodeFunctionData({ abi: ABI, data: tx.data });
    if (call.functionName === 'executeBatch') parsed = { calls: call.args[0] as unknown as Call[], delegatecall: false, tryMode: false, standard: 'executeBatch' };
    else if (call.args.length === 3) parsed = { calls: [{ target: call.args[0], value: call.args[1], data: call.args[2] }], delegatecall: false, tryMode: false, standard: 'execute(address,uint256,bytes)' };
    else {
      const p = erc7579Calls(call.args[0] as Hex, call.args[1] as Hex);
      parsed = p && { ...p, standard: 'ERC-7579 / ERC-7821 execute' };
    }
  } catch { return null; }
  if (!parsed || !parsed.calls.length) return null;

  const b = new PreviewBuilder().detail('Account', `your account (${tx.from})`).detail('Format', parsed.standard);
  // Only code at the account runs the calls: a delegation set in this transaction, or one (or a contract) already there.
  const delegate = await ownDelegateAfter(tx);
  if (delegate === null) return null; // cleared in this transaction: a plain account again
  if (delegate === undefined && !tx.codeInPlace && env.deps.rpc?.has(tx.chainId)) {
    let code: unknown;
    try { code = await env.deps.rpc.call(tx.chainId, 'eth_getCode', [tx.from, 'latest']); } catch { code = undefined; }
    if (code === '0x') {
      b.warn('caution', 'smart_account_no_code', 'Your account has no code (no EIP-7702 delegation), so this call to it runs nothing: the calls it lists would not happen.');
      return decoded({ title: `Call your own account (${tx.data.slice(0, 10)})`, summary: 'A call to your own account, which has no code to run it.', decoder: 'smart_account', status: 'partial', b });
    }
  }
  const native = CHAINS[tx.chainId]?.nativeSymbol ?? 'native';
  const inner: Decoded[] = [];
  for (const [i, c] of parsed.calls.slice(0, MAX_CALLS).entries()) {
    // A call back into the account itself isn't unpacked again.
    const d = sameAddress(c.target, tx.from)
      ? decoded({ title: `Call your own account (${c.data.slice(0, 10)})`, summary: '', decoder: 'smart_account', status: 'partial' })
      : await decodeTransaction({ chainId: tx.chainId, from: tx.from, to: c.target.toLowerCase(), data: c.data.toLowerCase() as Hex, value: c.value }, env.deps, env.context);
    inner.push(d);
    const value = c.value > 0n && !/\b(send|deposit|stake)\b/i.test(d.title) ? `, with ${formatUnits(c.value, CHAINS[tx.chainId]?.nativeDecimals ?? 18)} ${native}` : '';
    b.detail(`Call ${i + 1}`, `${d.title}${value} (${shortAddress(c.target.toLowerCase())})`, c.target.toLowerCase());
    // Every call's own warnings, numbered (two calls can raise the same kind).
    for (const w of d.b.warnings) b.warnings.push({ ...w, message: `Call ${i + 1}: ${w.message}` });
  }
  if (parsed.calls.length > MAX_CALLS) b.detail('More calls', String(parsed.calls.length - MAX_CALLS));
  if (parsed.delegatecall) b.warn('danger', 'smart_account_delegatecall', `This runs ${shortAddress(parsed.calls[0].target)}'s code inside your account (delegatecall): it can do anything with the account and everything in it.`);
  if (parsed.tryMode && parsed.calls.length > 1) b.note('The batch is in "try" mode: a call that fails is skipped and the others still take effect.');

  const n = parsed.calls.length;
  const statuses = inner.map(d => d.status);
  const status = statuses.includes('opaque') ? (statuses.every(s => s === 'opaque') ? 'opaque' : 'partial') : statuses.includes('partial') ? 'partial' : 'full';
  return decoded({
    title: n === 1 ? inner[0].title : `Run ${n} calls from your account`,
    summary: n === 1 ? `${inner[0].summary.replace(/\.$/, '')}${inner[0].summary ? '. ' : ''}Your account runs it through its own code.`
      : `Your account runs ${n} calls through its own code: ${inner.slice(0, 3).map(d => d.title).join('; ')}${n > 3 ? '; …' : ''}.`,
    decoder: 'smart_account', status, b,
    assetChanges: inner.flatMap(d => d.assetChanges),
    declaredApprovals: inner.flatMap(d => d.declaredApprovals ?? []),
    watch: inner.flatMap(d => d.watch ?? []),
  });
};
