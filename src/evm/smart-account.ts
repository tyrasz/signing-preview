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
import { decoded, readsAt, type Adapter, type Decoded } from './common.ts';
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
/** How many of a batch's calls are decoded (as a Safe's batch: src/safe.ts). */
const MAX_LISTED = 200;

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
  // (As the account's abi.decode reads them, whether or not they are that layout's one canonical encoding: with a
  // gap before its tails, such an execution was read as packed again, a call to the zero address with 1.4e32 ETH.)
  const wrapped = (): Hex | null => { try { return decodeAbiParameters(SIGNED, data)[0]; } catch { return null; } };
  let inner: Hex | null = null;
  if ((callType === '00' || callType === 'ff') && selector !== '00000000') {
    inner = wrapped();
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
 * Whether a call is one back into the account: to its own address, or, where the account's code is known to take it
 * so (`zeroIsSelf`), to the zero address with calldata. ERC-7821 has "to: replaced with address(this) if address(0)",
 * and Calibur and Porto follow it; other account code (Coinbase Smart Wallet, Simple7702Account, DeleGator) calls
 * the zero address as given, where nothing runs. Taken as the account for every format, a revoke nested under the
 * zero address was shown undoing an approval that, on such an account, stands.
 */
const toSelf = (c: Call, account: string, zeroIsSelf: boolean): boolean => sameAddress(c.target, account) || (zeroIsSelf && toZero(c));
/** A call to the zero address with calldata: one back into the account for some account code, to nothing for other. */
const toZero = (c: Call): boolean => /^0x0{40}$/.test(c.target) && c.data.length >= 10;

/**
 * Calibur's functions that only the account itself may call: its keys, its native allowances, its EntryPoint, its
 * nonces. The older deployment (0x…9b8f00) also has updateSalt(uint96), a native allowance for one transaction
 * (approveNativeTransient) and multicall(bytes[]), which runs each of its calls on the account as the caller: from
 * the account itself, as its own.
 */
const CALIBUR_ADMIN = parseAbi(['function register((uint8 keyType, bytes publicKey) key)', 'function update(bytes32 keyHash, uint256 settings)', 'function revoke(bytes32 keyHash)',
  'function approveNative(address spender, uint256 amount)', 'function approveNativeTransient(address spender, uint256 amount)', 'function updateEntryPoint(address entryPoint)',
  'function invalidateNonce(uint256 newNonce)', 'function updateSalt()', 'function updateSalt(uint96 prefix)', 'function multicall(bytes[] data)']);
/** The EntryPoints whose operations Calibur reads (the packed form: v0.7, v0.8, v0.9), and v0.6, whose it doesn't. */
const ENTRY_POINTS: Record<string, string> = { '0x0000000071727de22e5e9d8baf0edac6f37da032': 'v0.7', '0x4337084d9e255ff0702461cf8895ce9e3b5ff108': 'v0.8', '0x433709009b8330fda32311df1c2afa402ed8d009': 'v0.9' };
const ENTRY_POINT_V06 = '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789';
/** What a hook's address says it is called for (HooksLib: its lowest five bits). */
const HOOK_FLAGS = ['a signature it verifies', 'a UserOperation it validates', 'a signature checked for the account (ERC-1271)', 'each call, before it', 'each call, after it'];
/**
 * A call an account that runs Calibur makes to itself: what it changes in the account, warned of into `b`, and a
 * title for it. Null when it isn't one of Calibur's own functions (or is a multicall with a call that isn't). A key
 * registered on the account can make calls as the account (as the transaction's sender, or on its signature) until
 * it is revoked; its settings (one word: an admin flag at bit 200, an expiry in the 40 bits from 160, a hook's
 * address below) say how far it goes. Each warning is told with the others of its code (`also`): a batch can
 * register two keys.
 */
export function caliburAdmin(data: Hex, b: PreviewBuilder, p: string, chainId: number, whose = 'your account', depth = 0): string | null {
  let call;
  try { call = decodeFunctionData({ abi: CALIBUR_ADMIN, data }); } catch { return null; }
  const native = CHAINS[chainId]?.nativeSymbol ?? 'native', short = (h: string) => `${h.slice(0, 10)}…${h.slice(-4)}`;
  const its = whose === 'your account' ? "your account's" : `${whose}'s`;
  switch (call.functionName) {
    case 'register': {
      const [key] = call.args;
      const kind = ['a P-256 key', 'a passkey (WebAuthn, P-256)', 'an Ethereum key'][key.keyType] ?? `a key of a type that isn't known (${key.keyType})`;
      const who = key.keyType === 2 && /^0x0{24}[0-9a-f]{40}$/i.test(key.publicKey) ? `0x${key.publicKey.slice(26)}`.toLowerCase() : null;
      b.also('danger', 'calibur_register_key', `${p}registers ${kind}${who ? `, ${who},` : ''} on ${whose}: whoever holds it can make calls as the account, moving anything it holds, until ${whose === 'your account' ? 'you revoke it' : 'it is revoked'}. Do this only for a key that is yours.`);
      return `Register ${kind}${who ? ` (${shortAddress(who)})` : ''} on ${whose}`;
    }
    case 'update': {
      const [keyHash, settings] = call.args;
      // The admin flag is bit 200. The older Calibur (0x…9b8f00) takes any bit of that byte as the flag; the newer
      // refuses settings with a bit above 200 set. Read as bit 200 alone, a key made an admin by bit 201 was "not an
      // admin".
      const flag = settings >> 200n & 0xffn, reserved = settings >> 201n !== 0n, admin = flag !== 0n;
      const expiry = Number(settings >> 160n & 0xffffffffffn), hook = `0x${(settings & ((1n << 160n) - 1n)).toString(16).padStart(40, '0')}`;
      // A hook is called only for what its address's lowest bits enable: one with neither execution bit is never
      // asked about a call the key makes ("its calls checked by the hook" was said of any).
      const none = /^0x0{40}$/.test(hook), flags = Number(BigInt(hook) & 0x1fn), asked = HOOK_FLAGS.filter((_, i) => flags >> i & 1);
      const hooked = none ? 'with no hook checking its calls'
        : flags & 0x18 ? `its calls checked by the hook ${hook} (called for ${asked.join(', ')})`
        : flags ? `with a hook (${hook}) that isn't called on the calls it makes, only for ${asked.join(', ')}: nothing checks its calls`
        : `with a hook (${hook}) whose address enables none of its checks: it is never called, and nothing checks the key's calls (the newer Calibur refuses such a hook)`;
      const terms = `${admin ? 'an admin' : 'not an admin'}, ${expiry ? `until ${formatTimestamp(expiry * 1000)}` : 'with no expiry'}, ${hooked}`;
      const odd = !reserved ? '' : flag > 1n ? ' It is made one by a bit above the admin flag\'s own: the older Calibur (0x…9b8f00) reads any bit of that byte as the flag, and the newer refuses such settings.' : ' Its settings set bits the newer Calibur reserves: it refuses them.';
      if (admin) b.also('danger', 'calibur_admin_key', `${p}makes the key ${short(keyHash)} an admin of ${whose} (${terms}): it can register other keys, change any key's settings and call the account itself, as ${whose === 'your account' ? 'you' : 'its owner'} can.${odd}`);
      else b.also('caution', 'calibur_key_settings', `${p}sets what the key ${short(keyHash)} may do on ${whose}: ${terms}.${odd}`);
      return `Set a key's rights on ${whose} (${admin ? 'admin' : 'not admin'})`;
    }
    case 'revoke':
      b.also('info', 'calibur_revoke_key', `${p}revokes the key ${short(call.args[0])}: it can no longer act for ${whose}.`);
      return `Revoke a key of ${whose}`;
    case 'approveNative': case 'approveNativeTransient': {
      const [spender, amount] = call.args, all = amount >= (1n << 255n), once = call.functionName === 'approveNativeTransient';
      const text = all ? `any amount of ${native}` : `up to ${formatUnits(amount, CHAINS[chainId]?.nativeDecimals ?? 18)} ${native}`;
      if (amount > 0n) b.also('caution', 'calibur_native_approval', `${p}lets ${spender.toLowerCase()} take ${text} from ${whose} (its native allowance, ERC-7914), ${once ? 'for the rest of this transaction' : `now and later, until ${whose === 'your account' ? 'you set it' : 'it is set'} to zero`}.`);
      return amount > 0n ? `Allow ${shortAddress(spender.toLowerCase())} to take ${text} from ${whose}${once ? ' in this transaction' : ''}` : `Remove ${shortAddress(spender.toLowerCase())}'s allowance of ${native}`;
    }
    case 'updateEntryPoint': {
      const entryPoint = call.args[0].toLowerCase(), version = ENTRY_POINTS[entryPoint], zero = /^0x0{40}$/.test(entryPoint);
      if (zero) b.also('info', 'calibur_entry_point', `${p}removes ${its} EntryPoint: it takes no UserOperations after this.`);
      else if (version) b.also('info', 'calibur_entry_point', `${p}sets ${its} EntryPoint to ${entryPoint} (ERC-4337's ${version}).`);
      else if (entryPoint === ENTRY_POINT_V06) b.also('caution', 'calibur_entry_point', `${p}sets ${its} EntryPoint to ${entryPoint}, ERC-4337's v0.6, whose operations are in an older form than Calibur reads: UserOperations for the account through it fail.`);
      else b.also('danger', 'calibur_entry_point', `${p}makes ${entryPoint} ${its} EntryPoint, which isn't one of ERC-4337's (v0.7, v0.8, v0.9): the account runs whatever calls its EntryPoint hands it, so whoever controls that contract controls the account.`);
      return zero ? `Remove ${its} EntryPoint` : `Set ${its} EntryPoint to ${shortAddress(entryPoint)}`;
    }
    case 'invalidateNonce':
      b.also('info', 'calibur_invalidate_nonce', `${p}invalidates ${its} nonces below ${call.args[0] & ((1n << 64n) - 1n)} in the sequence ${call.args[0] >> 64n}: signatures given on them can't be used.`);
      return `Invalidate ${its} unused nonces`;
    case 'multicall': {
      // Each of its calls runs on the account as this one does: the account's own functions, one after another.
      const [inner] = call.args;
      if (!inner.length || depth >= 2) return null;
      const titles = inner.map((d, i) => caliburAdmin(d, b, `${p}(${i + 1} of ${inner.length} in a multicall) `, chainId, whose, depth + 1));
      if (titles.some(t => t === null)) return null;
      return inner.length === 1 ? titles[0] : `${inner.length} changes to ${whose}: ${titles.slice(0, 2).join('; ')}${inner.length > 2 ? '; …' : ''}`;
    }
    default:
      b.also('info', 'calibur_update_salt', `${p}changes the domain ${its} signatures are under: signatures given before stop working.`);
      return `Change ${its} signing domain`;
  }
}

/**
 * A batch with the batches nested in it laid out: a call back into the account that is itself a batch runs its calls
 * as the account too, so they take its place, to four levels. Left as "Call your own account", an unlimited approval
 * one level down went with nothing said of it. (A nested delegatecall, or one that can't be read, stays a call back
 * into the account, and is warned of as one.)
 */
function laidOut(calls: Call[], account: string, modes: Set<boolean>, zeroIsSelf: boolean, depth = 1): Call[] {
  return calls.flatMap(c => {
    if (!toSelf(c, account, zeroIsSelf) || depth >= 4) return [c];
    const inner = batchCalls(c.data);
    if (!inner || inner.delegatecall || inner.unread || !inner.calls.length) return [c];
    // (Whether the nested batch's calls fail together or one by one: laid out, that is the nested batch's own.)
    modes.add(inner.tryMode);
    return laidOut(inner.calls, account, modes, zeroIsSelf, depth + 1);
  });
}

/**
 * A call an account that runs Calibur sends straight to itself, to one of Calibur's own functions (a key registered,
 * a key's rights, a native allowance, its EntryPoint): what it changes in the account. Null for anything else, and
 * where the account isn't known to run Calibur (a delegation set in this transaction, or its code now).
 */
async function caliburOwn(tx: Parameters<Adapter>[0], env: Parameters<Adapter>[1]): Promise<Decoded | null> {
  let runs = await ownDelegateAfter(tx);
  if (runs === null) return null;
  if (runs === undefined && env.deps.rpc?.has(tx.chainId)) {
    const code = await env.deps.rpc.call(tx.chainId, 'eth_getCode', [tx.from, readsAt(env)]).catch(() => undefined);
    if (typeof code === 'string' && code.toLowerCase().startsWith('0xef0100')) runs = `0x${code.slice(8, 48)}`.toLowerCase();
  }
  if (!runs || !CALIBUR_CODES[runs]) return null;
  const b = new PreviewBuilder().detail('Account', `your account (${tx.from})`).detail('Account code', `${CALIBUR_CODES[runs]} (${runs})`, runs);
  const title = caliburAdmin(tx.data, b, 'This ', tx.chainId);
  return title ? decoded({ title, summary: `Your account calls one of its own functions (${CALIBUR_CODES[runs]}'s), which changes the account itself.`, decoder: 'smart_account', status: 'full', b }) : null;
}

export const smartAccountAdapter: Adapter = async (tx, env) => {
  if (!tx.to || !sameAddress(tx.to, tx.from) || tx.data.length < 10) return null;
  const read = batchCalls(tx.data);
  if (!read) return caliburOwn(tx, env);
  if (!read.calls.length && !read.unread) return null;
  const b = new PreviewBuilder().detail('Account', `your account (${tx.from})`).detail('Format', read.standard);
  // Only code at the account runs the calls: a delegation set in this transaction, or one (or a contract) already there.
  const delegate = await ownDelegateAfter(tx);
  if (delegate === null) return null; // cleared in this transaction: a plain account again
  // The code the account runs, where it is known: for what its calls to itself mean.
  let runs: string | undefined = delegate ?? undefined;
  if (delegate === undefined && !tx.codeInPlace && env.deps.rpc?.has(tx.chainId)) {
    let code: unknown;
    try { code = await env.deps.rpc.call(tx.chainId, 'eth_getCode', [tx.from, readsAt(env)]); } catch { code = undefined; }
    if (typeof code === 'string' && code.toLowerCase().startsWith('0xef0100')) runs = `0x${code.slice(8, 48)}`.toLowerCase();
    if (code === '0x') {
      b.warn('caution', 'smart_account_no_code', 'Your account has no code (no EIP-7702 delegation), so this call to it runs nothing: the calls it lists would not happen.');
      return decoded({ title: `Call your own account (${tx.data.slice(0, 10)})`, summary: 'A call to your own account, which has no code to run it.', decoder: 'smart_account', status: 'partial', b });
    }
  }
  // Whether the account's code takes the zero address to mean itself: known of Calibur (the account runs it, or the
  // batch is in a form only Calibur has). Of other code it isn't known, and a call there is told as either.
  const zeroIsSelf = !!CALIBUR_CODES[runs ?? ''] || read.standard.startsWith('Calibur');
  const nestedModes = new Set<boolean>();
  const parsed = read.delegatecall ? read : { ...read, calls: laidOut(read.calls, tx.from, nestedModes, zeroIsSelf) };
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
  const coin = (v: bigint) => `${formatUnits(v, CHAINS[tx.chainId]?.nativeDecimals ?? 18)} ${CHAINS[tx.chainId]?.nativeSymbol ?? 'native'}`;
  const listed = parsed.calls.slice(0, MAX_LISTED), many = parsed.calls.length > 1;
  // Every call is decoded, to the two hundredth, each with the reads of the chain its decoding makes (calls past the
  // twentieth weren't decoded at all: a batch read "fully decoded" on its first twenty, with nothing of what the
  // rest approve or send). Eight at a time, each into a builder of its own, told in the batch's order.
  const describe = async (c: Call, i: number): Promise<{ d: Decoded; sub: PreviewBuilder }> => {
    const sub = new PreviewBuilder();
    // A call back into the account itself that isn't a batch laid out above: the account's own code runs it, with
    // the account's own authority (an upgrade, a new owner or module, a batch in a layout that isn't read). What it
    // is isn't read, which is said; a delegatecall is said to be one, and a batch nested too deep to lay out.
    const self = toSelf(c, tx.from, zeroIsSelf), back = self ? batchCalls(c.data) : null;
    if (!self && toZero(c)) {
      // The zero address with calldata, on an account whose code isn't known to take it as itself: either a call
      // back into the account (ERC-7821) or one to nothing, and it is said to be either, with what it would run.
      const nested = batchCalls(c.data), sent = c.value > 0n ? `, and the ${coin(c.value)} sent with it is lost` : '';
      const either = `an account whose code follows ERC-7821 (Calibur, Porto) takes the zero address to mean itself, and runs this as a call back into the account with the account's own authority; other account code calls the zero address, where nothing runs${sent}. Which your account's code does isn't known here.`;
      if (nested && (nested.delegatecall || nested.unread || nested.calls.length)) sub.warn('danger', 'smart_account_calls_unread', `Call ${i + 1}: a call to the zero address carrying ${nested.delegatecall ? 'a delegatecall' : nested.calls.length ? `a batch of ${nested.calls.length} call${nested.calls.length === 1 ? '' : 's'}` : "an execution that isn't read"}, which isn't laid out here: ${either} If it runs them, any of them can move what your account holds or approve a spender; if it doesn't, nothing they say happens.`);
      else sub.warn('caution', 'smart_account_zero_target', `Call ${i + 1}: a call to the zero address with calldata (${c.data.slice(0, 10)}): ${either}`);
      return { d: decoded({ title: `Call the zero address (${c.data.slice(0, 10)})`, summary: '', decoder: 'smart_account', status: nested ? 'opaque' : 'partial' }), sub };
    }
    // (Calibur's own functions, where the account is known to run it, or the batch is in a form only Calibur has.)
    const calibur = self && !back && (CALIBUR_CODES[runs ?? ''] || parsed.standard.startsWith('Calibur')) ? caliburAdmin(c.data, sub, `Call ${i + 1}: `, tx.chainId) : null;
    if (self && !calibur) {
      const where = sameAddress(c.target, tx.from) ? 'a call back into your account' : "a call to the zero address with calldata, which your account's code (Calibur) takes to mean the account itself: a call back into your account";
      if (back?.delegatecall) sub.warn('danger', 'smart_account_delegatecall', `Call ${i + 1}: has your account run ${back.calls[0] ? `${shortAddress(back.calls[0].target)}'s` : "another contract's"} code inside itself (a delegatecall, through a call back into the account): it can do anything with the account and everything in it.`);
      else if (back?.calls.length) sub.warn('danger', 'smart_account_calls_unread', `Call ${i + 1}: a batch of ${back.calls.length} call${back.calls.length === 1 ? '' : 's'} nested more than four deep in calls back into your account, which isn't read here: any of them can move what your account holds or approve a spender.`);
      else if (c.data.length >= 10) sub.warn('caution', 'smart_account_self_call', `Call ${i + 1}: ${where} (${c.data.slice(0, 10)}) that isn't read: the account's own code runs it with the account's own authority, which is how an account's code, owners or modules are changed.`);
    }
    if (calibur) return { d: decoded({ title: calibur, summary: '', decoder: 'smart_account', status: 'full' }), sub };
    if (self) return { d: decoded({ title: `Call your own account (${c.data.slice(0, 10)})`, summary: '', decoder: 'smart_account', status: back?.calls.length ? 'opaque' : 'partial' }), sub };
    // (With the transaction's authorizations: a call into another account this same transaction delegates runs that
    // account's new code. Without them, six accounts a sponsor delegated and then called were each "no code".)
    return { d: await decodeTransaction({ chainId: tx.chainId, from: tx.from, to: c.target.toLowerCase(), data: c.data.toLowerCase() as Hex, value: c.value, ...(tx.authorizations && { authorizations: tx.authorizations }), ...(tx.origin && { origin: tx.origin, ...(tx.originAuthorizations && { originAuthorizations: tx.originAuthorizations }) }) }, env.deps, env.context), sub };
  };
  const described: { d: Decoded; sub: PreviewBuilder }[] = [];
  for (let i = 0; i < listed.length; i += 8) described.push(...await Promise.all(listed.slice(i, i + 8).map((c, j) => describe(c, i + j))));
  const inner: Decoded[] = [];
  // Calls that hand calls on to another account in turn (accountCallAdapter): said once, with which.
  const handedOn: { call: number; account: string }[] = [];
  for (const [i, c] of listed.entries()) {
    const { d, sub } = described[i];
    inner.push(d);
    if (d.account) handedOn.push({ call: i + 1, account: d.account });
    // The coin a call sends, wherever its title doesn't already say it (a token transfer with 100 ETH attached was
    // titled as the transfer, the coin nowhere).
    const value = c.value > 0n && !d.title.includes(coin(c.value)) ? `, with ${coin(c.value)}` : '';
    b.detail(`Call ${i + 1}`, `${d.title}${value} (${shortAddress(c.target.toLowerCase())})`, c.target.toLowerCase());
    // What the call's own decoding tells of it (who a transfer goes to, who an approval is for).
    for (const x of d.b.details) b.detail(many ? `Call ${i + 1}: ${x.label}` : x.label, x.value, x.raw);
    for (const w of sub.warnings) b.warnings.push(w);
    // Every call's own warnings, numbered (two calls can raise the same kind), except the caution that a run used the
    // caller's state (from a Safe a call runs execTransaction on), which is said once.
    for (const w of d.b.warnings) if (w.code === 'state_overridden') b.warn(w.severity, w.code, w.message); else if (w.code !== 'account_call' || !d.account) b.warnings.push({ ...w, message: `Call ${i + 1}: ${w.message}` });
  }
  if (handedOn.length) {
    const others = [...new Set(handedOn.map(h => h.account))];
    b.warn('info', 'account_call', `${handedOn.length === 1 ? `Call ${handedOn[0].call} hands` : `Calls ${handedOn.slice(0, 12).map(h => h.call).join(', ')}${handedOn.length > 12 ? ` and ${handedOn.length - 12} more` : ''} hand`} calls on to ${others.length === 1 ? `another account (${others[0]})` : `${others.length} other accounts (${others.slice(0, 3).map(a => shortAddress(a)).join(', ')}${others.length > 3 ? ', …' : ''})`}, whose code makes them as its own: what those move or approve is that account's, not your account's.`);
  }
  // Past the two hundredth they aren't decoded, and that is said.
  if (parsed.calls.length > MAX_LISTED) {
    b.detail('More calls', String(parsed.calls.length - MAX_LISTED));
    b.warn('danger', 'smart_account_calls_unread', `The batch has ${parsed.calls.length} calls, and the ${parsed.calls.length - MAX_LISTED} after the first ${MAX_LISTED} aren't decoded here: any of them can move what your account holds or approve a spender. What they do is told only by the simulated changes, if any are shown.`);
  }
  if (parsed.delegatecall) b.warn('danger', 'smart_account_delegatecall', `This runs ${shortAddress(parsed.calls[0].target)}'s code inside your account (delegatecall): it can do anything with the account and everything in it.`);
  if (parsed.tryMode && parsed.calls.length > 1) b.note('The batch is in "try" mode: a call that fails is skipped and the others still take effect.');
  // Batches nested in it are laid out above as its own calls, but each fails as its own mode has it.
  if (nestedModes.has(!parsed.tryMode)) b.note(parsed.tryMode
    ? 'A batch nested in it is not in "try" mode: its calls fail together, and are skipped together.'
    : 'A batch nested in it is in "try" mode: a call of that batch that fails is skipped, and the rest of the calls still take effect.');

  const n = parsed.calls.length;
  const statuses = inner.map(d => d.status);
  const some = statuses.includes('opaque') ? (statuses.every(s => s === 'opaque') ? 'opaque' : 'partial') : statuses.includes('partial') ? 'partial' : 'full';
  const status = parsed.calls.length > MAX_LISTED && some === 'full' ? 'partial' : some;
  const only = !many && parsed.calls[0]?.value > 0n && !inner[0].title.includes(coin(parsed.calls[0].value));
  if (only) b.detail('Value sent with the call', coin(parsed.calls[0].value), parsed.calls[0].value.toString());
  return decoded({
    title: n === 1 ? inner[0].title : `Run ${n} calls from your account`,
    summary: n === 1 ? `${inner[0].summary.replace(/\.$/, '')}${inner[0].summary ? '. ' : ''}Your account runs it through its own code.`
      : `Your account runs ${n} calls through its own code: ${inner.slice(0, 3).map(d => d.title).join('; ')}${n > 3 ? '; …' : ''}.`,
    decoder: 'smart_account', status, b,
    assetChanges: inner.flatMap(d => d.assetChanges),
    declaredApprovals: inner.flatMap(d => d.declaredApprovals ?? []),
    watch: inner.flatMap(d => d.watch ?? []),
    // (The accounts its calls hand calls on to, and those they hand on to in turn: a simulation is read for them.)
    ...(inner.some(d => d.account || d.actors?.length) && { actors: [...new Set(inner.flatMap(d => [...(d.account ? [d.account] : []), ...(d.actors ?? [])]))] }),
  });
};

/**
 * The same calls, handed to an account that isn't the sender: an owner calling the contract wallet it controls, a
 * relayer or a session's key calling an account with delegated code, any contract that makes the calls it is given
 * for whoever its code lets. Its code makes them as that account: what they move and approve is the account's.
 *
 * They were "Call contract 0x…", a function that isn't known, and the simulation told of the sender's own account,
 * which such a transaction mostly leaves as it was: a wallet's whole balance sent out by its owner previewed with
 * nothing moving. 121 of 10,276 transactions in a sample of 40 Ethereum blocks (2026-11-23) were such calls
 * (execute(address,uint256,bytes), ERC-7579's execute and executeBatch), to accounts that weren't their senders.
 *
 * The calls are read as the account's own, as when it calls itself (smartAccountAdapter), and said to be that
 * account's. `Decoded.account` names it: the simulation's changes are then read for it too. Whether the account
 * takes the calls from this sender is its code's to say, which the simulation runs.
 */
export const accountCallAdapter: Adapter = async (tx, env) => {
  if (!tx.to || sameAddress(tx.to, tx.from) || tx.data.length < 10) return null;
  const read = batchCalls(tx.data);
  if (!read || (!read.calls.length && !read.unread)) return null;
  const account = tx.to.toLowerCase(), short = shortAddress(account), origin = (tx.origin ?? tx.from).toLowerCase();
  // A call that comes back into the transaction's own sender's account, from an account it had act: the sender's
  // account's code makes the calls, and what they move or approve is the sender's. Read as the sender's own (with
  // the authorizations it sends for itself, signed or not), and marked: the lines about it say "you" and mean it,
  // where the lines around them mean the account that acts (KEPT). A sender delegating its account in the same
  // transaction and reaching it through another account's execute was read as "has no code, so this call to it
  // runs nothing", the unlimited approval it made of the sender's tokens not shown.
  if (tx.origin && account === origin) {
    const own = await smartAccountAdapter({ ...tx, from: origin, origin: undefined, originAuthorizations: undefined, ...((tx.authorizations || tx.originAuthorizations) && { authorizations: [...(tx.authorizations ?? []), ...(tx.originAuthorizations ?? [])] }) }, env);
    if (!own) return null;
    const mark = (text: string) => `${text}${KEPT}`, where = `back in your own account (${short})`;
    const b = new PreviewBuilder();
    for (const x of own.b.details) b.detail(`In your own account: ${x.label}`, mark(x.value), x.raw);
    b.warnings.push({ severity: 'caution', code: 'account_call_back_to_yours', message: mark(`This comes ${where}, called by the account the transaction has act: your account's code makes the call${read.calls.length === 1 ? '' : 's'} as its own, and what ${read.calls.length === 1 ? 'it moves or approves' : 'they move or approve'} is yours.`) });
    for (const w of own.b.warnings) b.warnings.push({ ...w, message: mark(`${where[0].toUpperCase()}${where.slice(1)}: ${w.message}`) });
    for (const note of own.b.notes) b.note(mark(note));
    return { ...own, b, title: mark(`${where[0].toUpperCase()}${where.slice(1)}: ${own.title}`), summary: mark(own.summary) };
  }
  // (An authorization the sender hasn't signed yet is the sender's own, not this account's.)
  const unsigned = tx.origin ? tx.originAuthorizations : tx.authorizations?.filter(a => !a.signature);
  const d = await smartAccountAdapter({ ...tx, from: account, origin, ...(unsigned?.length && { originAuthorizations: unsigned }), ...(tx.authorizations && { authorizations: tx.authorizations.filter(a => a.signature) }) }, env);
  if (!d) return null;
  // (What is marked as the sender's own is left as it says; the marks come off where the transaction's sender reads it.)
  const said = (text: string) => (tx.origin ? text : text.replaceAll(KEPT, ''));
  const theirs = (text: string) => (text.includes(KEPT) ? said(text) : text.replace(/\b([Yy])our (?:own )?account\b/g, (_m, y: string) => `${y === 'Y' ? 'The' : 'the'} account ${short}`));
  const back = [d.title, ...d.b.warnings.map(w => w.message), ...d.b.details.map(x => x.value)].some(t => t.includes(KEPT));
  const b = new PreviewBuilder();
  for (const x of d.b.details) b.detail(x.label, theirs(x.value), x.raw);
  const n = read.calls.length;
  b.warn('info', 'account_call', `This has the account ${account} make ${n === 1 ? 'the call' : `the ${n} calls`} below, not the account sending it: its code runs ${n === 1 ? 'it' : 'them'} as that account, and what ${n === 1 ? 'it moves or approves' : 'they move or approve'} is that account's. Whether it takes ${n === 1 ? 'the call' : 'them'} from you (as its owner, a key or a module it accepts) is for its code to say.`);
  for (const w of d.b.warnings) b.warnings.push({ ...w, message: theirs(w.message) });
  for (const note of d.b.notes) b.note(theirs(note));
  b.note(`Each call is read as ${short}'s own: where a line says "you" or "your", that account is meant, not the one sending this${back ? ' (but for what is marked as back in your own account, which is yours)' : ''}.`);
  const title = theirs(d.title);
  return { ...d, b, title: title.includes(short) ? title : `As the account ${short}: ${title}`, summary: theirs(d.summary), decoder: 'account_call', account };
};

/** Ends a text that speaks of the transaction's own sender inside a call read as another account's: left as it says. */
const KEPT = '\u2063';
