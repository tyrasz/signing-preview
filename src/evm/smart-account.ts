// Smart-account batches: an account (an EIP-7702 delegated EOA, or a smart wallet) calling itself, so its own code
// runs a list of calls as the account. The calls are what matters, so each is decoded as if it were its own
// transaction from the account: "Run 2 calls from your account: Send 1 USDC to 0xb0b…; Approve …".
//
// Formats: ERC-7579 and ERC-7821 execute(bytes32 mode, bytes executionData) (MetaMask's DeleGator, Safe's 7579
// adapter, Ithaca/Porto, OpenZeppelin's accounts), and executeBatch((address,uint256,bytes)[]) /
// execute(address,uint256,bytes) (Coinbase Smart Wallet, eth-infinitism's Simple7702Account and most ERC-4337
// accounts), and the older executeBatch(address[],bytes[]) (SimpleAccount for EntryPoint v0.6, Alchemy's
// LightAccount) and executeBatch(address[],uint256[],bytes[]) (LightAccount); WalletCore's executeFromSelf and its
// relayed and session forms; and Calibur's (Uniswap's EIP-7702 account) execute(BatchedCall), its form on a
// signature and a UserOperation's callData for it.
import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, parseAbi, type Hex } from 'viem';
import { formatTimestamp, formatUnits, PreviewBuilder, sameAddress, shortAddress } from '../format.ts';
import { CHAINS } from '../chains.ts';
import { decoded, type Adapter, type Decoded } from './common.ts';
import { decodeTransaction } from './transaction.ts';
import { ownDelegateAfter } from './eip7702.ts';

const ABI = parseAbi([
  'function execute(bytes32 mode, bytes executionData)',
  'function executeBatch((address target, uint256 value, bytes data)[] calls)',
  'function execute(address target, uint256 value, bytes data)',
  'function executeBatch(address[] dest, bytes[] func)',
  'function executeBatch(address[] dest, uint256[] value, bytes[] func)',
  // WalletCore (an EIP-7702 account code, verified on Sourcify): the account's own batch, one a relayer submits with
  // the account's signature for it (to a validator: the account's own key, or a contract it added), and one a
  // session's executor makes (src/typed-data/wallet-core-session.ts).
  'function executeFromSelf((address target, uint256 value, bytes data)[] calls)',
  'function executeWithValidator((address target, uint256 value, bytes data)[] calls, address validator, bytes validationData)',
  'function initializeExecuteWithValidator((address target, uint256 value, bytes data)[] calls, address validator, bytes validationData)',
  'function executeFromExecutor((address target, uint256 value, bytes data)[] calls, (uint256 id, address executor, address validator, uint256 validUntil, uint256 validAfter, bytes preHook, bytes postHook, bytes signature) session)',
]);
const WALLET_CORE = new Set(['executeFromSelf', 'executeWithValidator', 'initializeExecuteWithValidator', 'executeFromExecutor']);
// Calibur (Uniswap's EIP-7702 account code; CaliburEntry, verified on Sourcify at 0x00000000…9b8f00 on Ethereum and
// BNB Chain and 0x00000000…37030e on Ethereum and Base): the account's own batch, 0x99e1d016; the batch a relayer
// submits on the account's signature (src/typed-data/calibur.ts), 0xc3c16ee4; and a UserOperation's callData, the
// selector of executeUserOp followed by abi.encode(BatchedCall). A batch that doesn't revert on failure skips the
// calls that fail ("try" mode).
const CALIBUR = parseAbi([
  'struct Call { address to; uint256 value; bytes data; }', 'struct BatchedCall { Call[] calls; bool revertOnFailure; }',
  'struct SignedBatchedCall { BatchedCall batchedCall; uint256 nonce; bytes32 keyHash; address executor; uint256 deadline; }',
  'function execute(BatchedCall batchedCall) payable',
  'function execute(SignedBatchedCall signedBatchedCall, bytes wrappedSignature) payable',
]);
const BATCHED_CALL = [{ type: 'tuple', components: [{ name: 'calls', type: 'tuple[]', components: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }] }, { name: 'revertOnFailure', type: 'bool' }] }] as const;
const CALIBUR_OWN = '0x99e1d016', CALIBUR_SIGNED = '0xc3c16ee4', EXECUTE_USER_OP = '0x8dd7712f';
/** Calibur's deployments, which an account that runs it is delegated to. */
export const CALIBUR_CODES: Record<string, string> = { '0x000000009b1d0af20d8c6d0a44e162d11f9b8f00': 'Calibur', '0x000000005c84f8fd50b21cac312528a64437030e': 'Calibur' };
type CaliburBatch = { calls: readonly { to: string; value: bigint; data: Hex }[]; revertOnFailure: boolean };
const CALLS = [{ type: 'tuple[]', components: [{ name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }] }] as const;
/**
 * How many of a batch's calls are decoded with reads of the chain, and how many are decoded at all: those after the
 * first twenty from their calldata alone (as a Safe's batch is: src/safe.ts).
 */
const MAX_CALLS = 20, MAX_LISTED = 200;

type Call = { target: string; value: bigint; data: Hex };

/**
 * The calls an ERC-7579 / ERC-7821 executionData holds, by the mode's call type (byte 0): single (packed target,
 * value, calldata), batch (abi-encoded calls, optionally followed by ERC-7821's opData) or delegatecall (packed
 * target, calldata). Null when it doesn't parse.
 */
function erc7579Calls(mode: Hex, data: Hex): { calls: Call[]; delegatecall: boolean; tryMode: boolean; unread?: boolean } | null {
  const callType = mode.slice(2, 4), tryMode = mode.slice(4, 6) === '01', selector = mode.slice(14, 22);
  // The execution with a signature for it after (ERC-7821's opData, mode selector 0x78210001), as
  // UniversalGaslessDelegate takes one a relayer submits (src/typed-data/authorized-executions.ts):
  // abi.encode(bytes execution, bytes opData), the execution a packed single call or abi.encode(calls). Only a layout
  // that re-encodes to the same bytes fits.
  const SIGNED = [{ type: 'bytes' }, { type: 'bytes' }] as const;
  const signed = (): Hex | null => { try { const [execution, op] = decodeAbiParameters(SIGNED, data); return encodeAbiParameters(SIGNED, [execution, op]).toLowerCase() === data.toLowerCase() ? execution : null; } catch { return null; } };
  // A single call or a delegatecall under another mode selector. Accounts that read only the mode's call type
  // (ERC-7579's own do) take the packed layout whatever the selector says, so it is read as packed, unless the bytes
  // are that other layout exactly (a packed call can't be: its target would be the zero address). Read as packed
  // they made a call with a value of 9e30 of an execution that sends 5,500 USDC. Under ERC-7821's selector they are
  // the execution a signature follows; under any other, or as a delegatecall, the layout isn't known and the call
  // isn't read: said so, and still said to be a delegatecall where it is one (returning nothing here dropped that
  // warning, and the call was shown as a plain call to the account).
  let inner: Hex | null = null;
  if ((callType === '00' || callType === 'ff') && selector !== '00000000') {
    inner = signed();
    if (inner && !(callType === '00' && selector === '78210001')) return { calls: [], delegatecall: callType === 'ff', tryMode, unread: true };
  }
  const body = (inner ?? data).slice(2);
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
  try { const [calls, op] = decodeAbiParameters(WITH_OP, data); if (same(encodeAbiParameters(WITH_OP, [calls, op]))) return { calls: [...calls], delegatecall: false, tryMode }; } catch { /* next */ }
  // (And UniversalGaslessDelegate's batch on a signature: the calls encoded on their own, as bytes, before opData.)
  const batch = selector === '78210001' ? signed() : null;
  if (batch) try { const [calls] = decodeAbiParameters(CALLS, batch); if (encodeAbiParameters(CALLS, [calls]).toLowerCase() === batch.toLowerCase()) return { calls: [...calls], delegatecall: false, tryMode }; } catch { /* none of them */ }
  return null;
}

/**
 * The calls a smart account's batch call holds (the formats above), null when the calldata isn't one of them. What
 * a wallet asked to send those calls (wallet_sendCalls) puts on the chain: scripts/accuracy-batch.ts reads mined
 * batches back with it.
 */
export function batchCalls(data: Hex): { calls: Call[]; delegatecall: boolean; tryMode: boolean; standard: string; unread?: boolean } | null {
  const selector = data.slice(0, 10).toLowerCase();
  if (selector === CALIBUR_OWN || selector === CALIBUR_SIGNED || selector === EXECUTE_USER_OP) {
    try {
      let batch: CaliburBatch;
      if (selector === EXECUTE_USER_OP) {
        // (Only bytes that are that encoding exactly: another account's executeUserOp callData is its own.)
        const rest = `0x${data.slice(10)}` as Hex;
        [batch] = decodeAbiParameters(BATCHED_CALL, rest) as unknown as [CaliburBatch];
        if (encodeAbiParameters(BATCHED_CALL, [batch as never]).toLowerCase() !== rest.toLowerCase()) return null;
      } else {
        const call = decodeFunctionData({ abi: CALIBUR, data });
        batch = (selector === CALIBUR_OWN ? call.args[0] : (call.args[0] as { batchedCall: CaliburBatch }).batchedCall) as CaliburBatch;
      }
      return { calls: batch.calls.map(c => ({ target: c.to, value: c.value, data: c.data })), delegatecall: false, tryMode: !batch.revertOnFailure,
        standard: selector === CALIBUR_OWN ? 'Calibur execute(BatchedCall)' : selector === CALIBUR_SIGNED ? 'Calibur execute(SignedBatchedCall)' : 'Calibur executeUserOp' };
    } catch { return null; }
  }
  try {
    const call = decodeFunctionData({ abi: ABI, data });
    if (WALLET_CORE.has(call.functionName)) return { calls: call.args[0] as unknown as Call[], delegatecall: false, tryMode: false, standard: `WalletCore ${call.functionName}` };
    if (call.functionName === 'executeBatch' && call.args.length === 1) return { calls: call.args[0] as unknown as Call[], delegatecall: false, tryMode: false, standard: 'executeBatch' };
    if (call.functionName === 'executeBatch') {
      // Parallel arrays: targets, (values,) calldata. The account requires equal lengths (an empty value list means none).
      const [dest, a, b] = call.args as unknown as [string[], readonly unknown[], readonly Hex[] | undefined];
      const values = b ? a as readonly bigint[] : [], datas = (b ?? a) as readonly Hex[];
      if (dest.length !== datas.length || (values.length && values.length !== dest.length)) return null;
      return { calls: dest.map((target, i) => ({ target, value: values[i] ?? 0n, data: datas[i] })), delegatecall: false, tryMode: false, standard: b ? 'executeBatch(address[],uint256[],bytes[])' : 'executeBatch(address[],bytes[])' };
    }
    if (call.functionName !== 'execute') return null;
    if (call.args.length === 3) return { calls: [{ target: call.args[0], value: call.args[1], data: call.args[2] }], delegatecall: false, tryMode: false, standard: 'execute(address,uint256,bytes)' };
    const p = erc7579Calls(call.args[0] as Hex, call.args[1] as Hex);
    return p && { ...p, standard: 'ERC-7579 / ERC-7821 execute' };
  } catch { return null; }
}

/**
 * Whether a call is one back into the account: to its own address, or to the zero address with calldata, which an
 * ERC-7821 account (Calibur, Porto) takes to mean itself ("to: replaced with address(this) if address(0)").
 */
const toSelf = (c: Call, account: string): boolean => sameAddress(c.target, account) || (/^0x0{40}$/.test(c.target) && c.data.length >= 10);

/** Calibur's functions that only the account itself may call: its keys, its native allowances, its EntryPoint, its nonces. */
const CALIBUR_ADMIN = parseAbi(['function register((uint8 keyType, bytes publicKey) key)', 'function update(bytes32 keyHash, uint256 settings)', 'function revoke(bytes32 keyHash)',
  'function approveNative(address spender, uint256 amount)', 'function updateEntryPoint(address entryPoint)', 'function invalidateNonce(uint256 newNonce)', 'function updateSalt()']);
/** The EntryPoints Calibur works with (v0.7, v0.8), and none. */
const ENTRY_POINTS = new Set(['0x0000000071727de22e5e9d8baf0edac6f37da032', '0x4337084d9e255ff0702461cf8895ce9e3b5ff108', '0x0000000000000000000000000000000000000000']);
/**
 * A call an account that runs Calibur makes to itself: what it changes in the account, warned of into `b`, and a
 * title for it. Null when it isn't one of Calibur's own functions. A key registered on the account can make calls
 * as the account (as the transaction's sender, or on its signature) until it is revoked; its settings (one word:
 * an admin flag at bit 200, an expiry in the 40 bits from 160, a hook's address below) say how far it goes.
 */
export function caliburAdmin(data: Hex, b: PreviewBuilder, p: string, chainId: number): string | null {
  let call;
  try { call = decodeFunctionData({ abi: CALIBUR_ADMIN, data }); } catch { return null; }
  const native = CHAINS[chainId]?.nativeSymbol ?? 'native', short = (h: string) => `${h.slice(0, 10)}…${h.slice(-4)}`;
  switch (call.functionName) {
    case 'register': {
      const [key] = call.args;
      const kind = ['a P-256 key', 'a passkey (WebAuthn, P-256)', 'an Ethereum key'][key.keyType] ?? `a key of a type that isn't known (${key.keyType})`;
      const who = key.keyType === 2 && /^0x0{24}[0-9a-f]{40}$/i.test(key.publicKey) ? `0x${key.publicKey.slice(26)}`.toLowerCase() : null;
      b.warn('danger', 'calibur_register_key', `${p}registers ${kind}${who ? `, ${who},` : ''} on your account: whoever holds it can make calls as the account, moving anything it holds, until you revoke it. Do this only for a key that is yours.`);
      return `Register ${kind}${who ? ` (${shortAddress(who)})` : ''} on your account`;
    }
    case 'update': {
      const [keyHash, settings] = call.args;
      const admin = (settings >> 200n & 1n) === 1n, expiry = Number(settings >> 160n & 0xffffffffffn), hook = `0x${(settings & ((1n << 160n) - 1n)).toString(16).padStart(40, '0')}`;
      const terms = `${admin ? 'an admin' : 'not an admin'}, ${expiry ? `until ${formatTimestamp(expiry * 1000)}` : 'with no expiry'}, ${/^0x0{40}$/.test(hook) ? 'with no hook checking its calls' : `its calls checked by the hook ${hook}`}`;
      if (admin) b.warn('danger', 'calibur_admin_key', `${p}makes the key ${short(keyHash)} an admin of your account (${terms}): it can register other keys, change any key's settings and call the account itself, as you can.`);
      else b.warn('caution', 'calibur_key_settings', `${p}sets what the key ${short(keyHash)} may do on your account: ${terms}.`);
      return `Set a key's rights on your account (${admin ? 'admin' : 'not admin'})`;
    }
    case 'revoke':
      b.warn('info', 'calibur_revoke_key', `${p}revokes the key ${short(call.args[0])}: it can no longer act for your account.`);
      return 'Revoke a key of your account';
    case 'approveNative': {
      const [spender, amount] = call.args, all = amount >= (1n << 255n);
      const text = all ? `any amount of ${native}` : `up to ${formatUnits(amount, CHAINS[chainId]?.nativeDecimals ?? 18)} ${native}`;
      if (amount > 0n) b.warn('caution', 'calibur_native_approval', `${p}lets ${spender.toLowerCase()} take ${text} from your account (its native allowance, ERC-7914), now and later, until you set it to zero.`);
      return amount > 0n ? `Allow ${shortAddress(spender.toLowerCase())} to take ${text} from your account` : `Remove ${shortAddress(spender.toLowerCase())}'s allowance of ${native}`;
    }
    case 'updateEntryPoint': {
      const entryPoint = call.args[0].toLowerCase();
      if (!ENTRY_POINTS.has(entryPoint)) b.warn('danger', 'calibur_entry_point', `${p}makes ${entryPoint} your account's EntryPoint, which isn't one of ERC-4337's (v0.7, v0.8): the account runs whatever calls its EntryPoint hands it, so whoever controls that contract controls the account.`);
      else b.warn('info', 'calibur_entry_point', `${p}${/^0x0{40}$/.test(entryPoint) ? "removes your account's EntryPoint: it takes no UserOperations after this" : `sets your account's EntryPoint to ${entryPoint} (ERC-4337's)`}.`);
      return /^0x0{40}$/.test(entryPoint) ? "Remove your account's EntryPoint" : `Set your account's EntryPoint to ${shortAddress(entryPoint)}`;
    }
    case 'invalidateNonce':
      b.warn('info', 'calibur_invalidate_nonce', `${p}invalidates your account's nonces below ${call.args[0] & ((1n << 64n) - 1n)} in the sequence ${call.args[0] >> 64n}: signatures you gave on them can't be used.`);
      return "Invalidate your account's unused nonces";
    default:
      b.warn('info', 'calibur_update_salt', `${p}changes the domain your account's signatures are under: signatures you gave before stop working.`);
      return "Change your account's signing domain";
  }
}

/**
 * A batch with the batches nested in it laid out: a call back into the account that is itself a batch runs its calls
 * as the account too, so they take its place, to four levels. Left as "Call your own account", an unlimited approval
 * one level down went with nothing said of it. (A nested delegatecall, or one that can't be read, stays a call back
 * into the account, and is warned of as one.)
 */
function laidOut(calls: Call[], account: string, depth = 1): Call[] {
  return calls.flatMap(c => {
    if (!toSelf(c, account) || depth >= 4) return [c];
    const inner = batchCalls(c.data);
    return !inner || inner.delegatecall || inner.unread || !inner.calls.length ? [c] : laidOut(inner.calls, account, depth + 1);
  });
}

export const smartAccountAdapter: Adapter = async (tx, env) => {
  if (!tx.to || !sameAddress(tx.to, tx.from) || tx.data.length < 10) return null;
  const read = batchCalls(tx.data);
  if (!read || (!read.calls.length && !read.unread)) return null;
  const parsed = read.delegatecall ? read : { ...read, calls: laidOut(read.calls, tx.from) };

  const b = new PreviewBuilder().detail('Account', `your account (${tx.from})`).detail('Format', parsed.standard);
  // Only code at the account runs the calls: a delegation set in this transaction, or one (or a contract) already there.
  const delegate = await ownDelegateAfter(tx);
  if (delegate === null) return null; // cleared in this transaction: a plain account again
  // The code the account runs, where it is known: for what its calls to itself mean.
  let runs: string | undefined = delegate ?? undefined;
  if (delegate === undefined && !tx.codeInPlace && env.deps.rpc?.has(tx.chainId)) {
    let code: unknown;
    try { code = await env.deps.rpc.call(tx.chainId, 'eth_getCode', [tx.from, 'latest']); } catch { code = undefined; }
    if (typeof code === 'string' && code.toLowerCase().startsWith('0xef0100')) runs = `0x${code.slice(8, 48)}`.toLowerCase();
    if (code === '0x') {
      b.warn('caution', 'smart_account_no_code', 'Your account has no code (no EIP-7702 delegation), so this call to it runs nothing: the calls it lists would not happen.');
      return decoded({ title: `Call your own account (${tx.data.slice(0, 10)})`, summary: 'A call to your own account, which has no code to run it.', decoder: 'smart_account', status: 'partial', b });
    }
  }
  // An execution laid out for a mode this doesn't know: what it runs isn't shown, and that is said, with what the
  // mode's call type alone tells (a delegatecall is one whatever its layout).
  if (parsed.unread) {
    const mode = `0x${tx.data.slice(10, 74)}`;
    b.detail('Mode', mode);
    b.warn('caution', 'smart_account_unread', `What your account is asked to run isn't read: its execution is laid out for a mode (selector 0x${mode.slice(14, 22)}) this doesn't know, so the call, its target and what it moves aren't shown.`);
    if (parsed.delegatecall) b.warn('danger', 'smart_account_delegatecall', "This runs another contract's code inside your account (delegatecall): it can do anything with the account and everything in it. Which contract isn't read.");
    return decoded({ title: parsed.delegatecall ? "Run code inside your account (a delegatecall that isn't read)" : "Run a call from your account that isn't read",
      summary: `Your account runs ${parsed.delegatecall ? "another contract's code as its own" : 'a call'} through its own code, in a layout that isn't read.`, decoder: 'smart_account', status: 'opaque', b });
  }
  const native = CHAINS[tx.chainId]?.nativeSymbol ?? 'native';
  const inner: Decoded[] = [];
  // (Past the twentieth call, with no RPC and no simulator: from the calldata alone.)
  const fromCalldata = { ...env.deps, rpc: undefined, simulator: undefined };
  for (const [i, c] of parsed.calls.slice(0, MAX_LISTED).entries()) {
    // A call back into the account itself that isn't a batch laid out above: the account's own code runs it, with
    // the account's own authority (an upgrade, a new owner or module, a batch in a layout that isn't read). What it
    // is isn't read, which is said; a delegatecall is said to be one.
    const self = toSelf(c, tx.from), back = self ? batchCalls(c.data) : null;
    // (Calibur's own functions, where the account is known to run it, or the batch is in a form only Calibur has.)
    const calibur = self && !back && (CALIBUR_CODES[runs ?? ''] || parsed.standard.startsWith('Calibur')) ? caliburAdmin(c.data, b, `Call ${i + 1}: `, tx.chainId) : null;
    if (self && !calibur) {
      const where = sameAddress(c.target, tx.from) ? 'a call back into your account' : 'a call to the zero address with calldata, which an ERC-7821 account (Calibur, Porto) takes to mean itself: a call back into your account';
      if (back?.delegatecall) b.warn('danger', 'smart_account_delegatecall', `Call ${i + 1}: has your account run ${back.calls[0] ? `${shortAddress(back.calls[0].target)}'s` : "another contract's"} code inside itself (a delegatecall, through a call back into the account): it can do anything with the account and everything in it.`);
      else if (c.data.length >= 10) b.warn('caution', 'smart_account_self_call', `Call ${i + 1}: ${where} (${c.data.slice(0, 10)}) that isn't read: the account's own code runs it with the account's own authority, which is how an account's code, owners or modules are changed.`);
    }
    const d = calibur ? decoded({ title: calibur, summary: '', decoder: 'smart_account', status: 'full' })
      : self ? decoded({ title: `Call your own account (${c.data.slice(0, 10)})`, summary: '', decoder: 'smart_account', status: 'partial' })
      : await decodeTransaction({ chainId: tx.chainId, from: tx.from, to: c.target.toLowerCase(), data: c.data.toLowerCase() as Hex, value: c.value }, i < MAX_CALLS ? env.deps : fromCalldata, env.context);
    inner.push(d);
    const value = c.value > 0n && !/\b(send|deposit|stake)\b/i.test(d.title) ? `, with ${formatUnits(c.value, CHAINS[tx.chainId]?.nativeDecimals ?? 18)} ${native}` : '';
    b.detail(`Call ${i + 1}`, `${d.title}${value} (${shortAddress(c.target.toLowerCase())})`, c.target.toLowerCase());
    // Every call's own warnings, numbered (two calls can raise the same kind), except the caution that a run used the
    // caller's state (from a Safe a call runs execTransaction on), which is said once.
    for (const w of d.b.warnings) if (w.code === 'state_overridden') b.warn(w.severity, w.code, w.message); else b.warnings.push({ ...w, message: `Call ${i + 1}: ${w.message}` });
  }
  // Every call is decoded, to the two hundredth (calls past the twentieth weren't: a batch read "fully decoded" on
  // its first twenty, with nothing of what the rest approve or send). Past that they aren't, and that is said.
  if (parsed.calls.length > MAX_CALLS) b.note(`The calls after the first ${MAX_CALLS} are decoded from their calldata alone, without the reads of the chain the first ${MAX_CALLS} get (a token this doesn't know is shown by its address).`);
  if (parsed.calls.length > MAX_LISTED) {
    b.detail('More calls', String(parsed.calls.length - MAX_LISTED));
    b.warn('danger', 'smart_account_calls_unread', `The batch has ${parsed.calls.length} calls, and the ${parsed.calls.length - MAX_LISTED} after the first ${MAX_LISTED} aren't decoded here: any of them can move what your account holds or approve a spender. What they do is told only by the simulated changes, if any are shown.`);
  }
  if (parsed.delegatecall) b.warn('danger', 'smart_account_delegatecall', `This runs ${shortAddress(parsed.calls[0].target)}'s code inside your account (delegatecall): it can do anything with the account and everything in it.`);
  if (parsed.tryMode && parsed.calls.length > 1) b.note('The batch is in "try" mode: a call that fails is skipped and the others still take effect.');

  const n = parsed.calls.length;
  const statuses = inner.map(d => d.status);
  const some = statuses.includes('opaque') ? (statuses.every(s => s === 'opaque') ? 'opaque' : 'partial') : statuses.includes('partial') ? 'partial' : 'full';
  const status = parsed.calls.length > MAX_LISTED && some === 'full' ? 'partial' : some;
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
