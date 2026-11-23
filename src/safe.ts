// Safe (Gnosis Safe) multisig transactions. Owners approve a SafeTx by signing it (EIP-712), and anyone submits it
// with execTransaction once enough owners have. The SafeTx says what the Safe will do: a call (operation 0) or a
// delegatecall (operation 1), which runs another contract's code as the Safe itself, able to change its owners or
// replace its code. That is how the Bybit Safe was drained in 2025: the owners signed a delegatecall they couldn't
// read. Delegatecalls to Safe's own libraries (MultiSend for batches, SignMessageLib, CreateCall) are normal;
// anything else is danger.
import { decodeFunctionData, parseAbi, type Hex } from 'viem';
import { formatUnits, PreviewBuilder, sameAddress, shortAddress } from './format.ts';
import { CHAINS } from './chains.ts';
import { callerOverrides, decodeTransaction, simulationNote, warnOverridden } from './evm/transaction.ts';
import { netChanges } from './evm/effects.ts';
import type { AdapterEnv, Decoded } from './evm/common.ts';
import type { AssetChange, SimulationRequest, SimulationResult, Warning } from './types.ts';
import { configChanges, SAFE_SINGLETONS, simulateSafeExecution, type SafeConfig } from './safe-sim.ts';
import { namedBlock, pinLatest } from './block.ts';
import { tracePreviews, noTrace, type TraceEnv } from './evm/trace.ts';

/** Safe's libraries (safe-global/safe-deployments v1.3.0 canonical and EIP-155, v1.4.1, v1.5.0), deployed on every chain here. */
export const SAFE_LIBRARIES: Record<string, { name: string; kind: 'multisend' | 'multisend_call_only' | 'sign_message' | 'create_call' | 'migration' }> = {
  '0xa238cbeb142c10ef7ad8442c6d1f9e89e07e7761': { name: 'MultiSend 1.3.0', kind: 'multisend' },
  '0x998739bfdaadde7c933b942a68053933098f9eda': { name: 'MultiSend 1.3.0', kind: 'multisend' },
  '0x38869bf66a61cf6bdb996a6ae40d5853fd43b526': { name: 'MultiSend 1.4.1', kind: 'multisend' },
  '0x40a2accbd92bca938b02010e17a5b8929b49130d': { name: 'MultiSendCallOnly 1.3.0', kind: 'multisend_call_only' },
  '0xa1dabef33b3b82c7814b6d82a79e50f4ac44102b': { name: 'MultiSendCallOnly 1.3.0', kind: 'multisend_call_only' },
  '0x9641d764fc13c8b624c04430c7356c1c7c8102e2': { name: 'MultiSendCallOnly 1.4.1', kind: 'multisend_call_only' },
  '0xa65387f16b013cf2af4605ad8aa5ec25a2cba3a2': { name: 'SignMessageLib 1.3.0', kind: 'sign_message' },
  '0x98ffbbf51bb33a056b08ddf711f289936aaff717': { name: 'SignMessageLib 1.3.0', kind: 'sign_message' },
  '0xd53cd0ab83d845ac265be939c57f53ad838012c9': { name: 'SignMessageLib 1.4.1', kind: 'sign_message' },
  '0x7cbb62eaa69f79e6873cd1ecb2392971036cfaa4': { name: 'CreateCall 1.3.0', kind: 'create_call' },
  '0xb19d6ffc2182150f8eb585b79d4abcd7c5640a9d': { name: 'CreateCall 1.3.0', kind: 'create_call' },
  '0x9b35af71d77eaf8d7e40252370304687390a1a52': { name: 'CreateCall 1.4.1', kind: 'create_call' },
  '0x218543288004cd07832472d464648173c77d7eb7': { name: 'MultiSend 1.5.0', kind: 'multisend' },
  '0xa83c336b20401af773b6219ba5027174338d1836': { name: 'MultiSendCallOnly 1.5.0', kind: 'multisend_call_only' },
  '0x4ffef8222648872b3de295ba1e49110e61f5b5aa': { name: 'SignMessageLib 1.5.0', kind: 'sign_message' },
  '0x2ef5ecfbea521449e4de05edb1ce63b75eda90b4': { name: 'CreateCall 1.5.0', kind: 'create_call' },
  // Safe's own upgrade contracts: these change the Safe's code. SafeMigration's functions take no argument and move
  // the Safe to the singleton it was deployed for; SafeToL2Migration's take the new singleton as an argument, and
  // check only the version it says it is, on a Safe that has run no transaction yet (libraryCall).
  '0x526643f69b81b008f46d95cd5ced5ec0edffdac6': { name: 'SafeMigration 1.4.1', kind: 'migration' },
  '0xff83f6335d8930cbad1c0d439a841f01888d9f69': { name: 'SafeToL2Migration 1.4.1', kind: 'migration' },
  '0x6439e7abd8bb915a5263094784c5cf561c4172ac': { name: 'SafeMigration 1.5.0', kind: 'migration' },
};
const ZERO = '0x0000000000000000000000000000000000000000';
/** How many of a batch's calls are decoded: a batch of two hundred transfers (an airdrop's, a payroll's) is read whole. */
const MAX_LISTED = 200;

export interface SafeTx { safe: string; to: string; value: bigint; data: Hex; operation: number; safeTxGas: bigint; baseGas: bigint; gasPrice: bigint; gasToken: string; refundReceiver: string; nonce?: bigint }
interface Call {
  operation: number; to: string; value: bigint; data: Hex;
  /** A delegatecall to MultiSend whose own batch couldn't be read (or is nested too deep). */
  unread?: boolean;
  /** Why the batch this call is in reverts on it: MultiSendCallOnly makes no delegatecall, and neither library runs an operation other than 0 and 1. */
  refused?: string;
}
type MultiSendKind = 'multisend' | 'multisend_call_only';

/**
 * A batch with the batches nested in it laid out: a call that delegatecalls MultiSend (or MultiSendCallOnly) runs a
 * batch of its own as the Safe, so its calls take its place, to four levels. Left as one call "to MultiSend", which
 * is one of Safe's libraries and so no danger, a delegatecall to unknown code one level down showed as a call that
 * couldn't be decoded: a caution, where the same call in the outer batch is the Bybit pattern's danger.
 * `kind` is the library whose code runs the batch: MultiSendCallOnly reverts on a delegatecall (so a batch nested
 * under it isn't laid out: it never runs), and both revert on an operation that is neither a call nor a delegatecall.
 */
function laidOut(calls: Call[], kind: MultiSendKind, depth = 1): { calls: Call[]; nested: number } {
  let nested = 0;
  const out = calls.flatMap(c => {
    if (c.operation > 1) return [{ ...c, refused: `operation ${c.operation} isn't one MultiSend runs (a call, 0, or a delegatecall, 1)` }];
    if (c.operation === 1 && kind === 'multisend_call_only') return [{ ...c, refused: 'it is a delegatecall, which MultiSendCallOnly makes none of' }];
    const inner = c.operation === 1 ? SAFE_LIBRARIES[c.to.toLowerCase()]?.kind : undefined;
    if (inner !== 'multisend' && inner !== 'multisend_call_only') return [c];
    const batch = depth < 4 ? multiSendCalls(c.data) : null;
    if (!batch) return [{ ...c, unread: true }];
    const below = laidOut(batch, inner, depth + 1);
    nested += below.calls.length;
    return below.calls;
  });
  return { calls: out, nested };
}

/** MultiSend's packed batch: per call, operation (1 byte), to (20), value (32), data length (32), data. */
export function multiSendCalls(data: Hex): Call[] | null {
  let bytes: Hex;
  try { bytes = decodeFunctionData({ abi: parseAbi(['function multiSend(bytes transactions)']), data }).args[0]; } catch { return null; }
  const h = bytes.slice(2), out: Call[] = [];
  for (let i = 0; i < h.length;) {
    if (h.length - i < 170) return null;
    const operation = parseInt(h.slice(i, i + 2), 16), to = `0x${h.slice(i + 2, i + 42)}`, value = BigInt(`0x${h.slice(i + 42, i + 106)}`), len = Number(BigInt(`0x${h.slice(i + 106, i + 170)}`));
    const end = i + 170 + len * 2;
    if (end > h.length) return null;
    out.push({ operation, to, value, data: `0x${h.slice(i + 170, end)}` });
    i = end;
  }
  return out;
}

const ADMIN = parseAbi([
  'function changeMasterCopy(address _masterCopy)',
  'function addOwnerWithThreshold(address owner, uint256 threshold)', 'function removeOwner(address prevOwner, address owner, uint256 threshold)',
  'function swapOwner(address prevOwner, address oldOwner, address newOwner)', 'function changeThreshold(uint256 threshold)',
  'function enableModule(address module)', 'function disableModule(address prevModule, address module)',
  'function setGuard(address guard)', 'function setFallbackHandler(address handler)', 'function setModuleGuard(address moduleGuard)',
]);

/** A call from the Safe to itself that changes its settings: owners, threshold, modules, guards, fallback handler. */
function safeAdmin(data: Hex, b: PreviewBuilder, p: string): string | null {
  let c;
  try { c = decodeFunctionData({ abi: ADMIN, data }); } catch { return null; }
  const a = c.args as readonly unknown[];
  switch (c.functionName) {
    // (Safe 1.1.1 and 1.2.0: the Safe replaces its own code. Later versions have no such function.)
    case 'changeMasterCopy': {
      const to = String(a[0]).toLowerCase(), official = SAFE_SINGLETONS[to];
      if (official) b.warn('caution', 'safe_upgrade', `${p}Changes the Safe's code to ${official} (${to}). Only sign it if you meant to upgrade the Safe.`);
      else b.warn('danger', 'safe_code_replaced', `${p}Replaces the Safe's code with the code at ${to}, which isn't one of Safe's own: whoever controls that code controls the Safe and everything in it.`);
      return official ? `Upgrade the Safe to ${official}` : `Replace the Safe's code with ${shortAddress(to)}`;
    }
    case 'addOwnerWithThreshold': b.warn('caution', 'safe_owners_change', `${p}Adds ${a[0]} as an owner of the Safe, with a threshold of ${a[1]}.`); return `Add owner ${shortAddress(a[0] as string)} (threshold ${a[1]})`;
    case 'removeOwner': b.warn('caution', 'safe_owners_change', `${p}Removes ${a[1]} as an owner of the Safe, leaving a threshold of ${a[2]}.`); return `Remove owner ${shortAddress(a[1] as string)} (threshold ${a[2]})`;
    case 'swapOwner': b.warn('caution', 'safe_owners_change', `${p}Replaces owner ${a[1]} with ${a[2]}.`); return `Replace owner ${shortAddress(a[1] as string)} with ${shortAddress(a[2] as string)}`;
    case 'changeThreshold': b.warn('caution', 'safe_threshold_change', `${p}Changes how many owners must sign to ${a[0]}.`); return `Change the signing threshold to ${a[0]}`;
    case 'enableModule': b.warn('danger', 'safe_enable_module', `${p}Enables ${a[0]} as a module: a module can move everything in the Safe without any owner's signature. Only enable modules you know and trust.`); return `Enable module ${shortAddress(a[0] as string)}`;
    case 'disableModule': return `Disable module ${shortAddress(a[1] as string)}`;
    case 'setGuard': case 'setModuleGuard': b.warn('caution', 'safe_set_guard', `${p}Sets ${a[0]} as the Safe's ${c.functionName === 'setGuard' ? 'transaction' : 'module'} guard: it checks every transaction, and a faulty or hostile one can block them all.`); return `Set the Safe's guard to ${shortAddress(a[0] as string)}`;
    case 'setFallbackHandler': b.warn('caution', 'safe_fallback_handler', `${p}Sets ${a[0]} as the Safe's fallback handler: it answers calls the Safe doesn't know, including ERC-1271 signature checks made in the Safe's name.`); return `Set the Safe's fallback handler to ${shortAddress(a[0] as string)}`;
  }
  return null;
}

const LIBRARY = parseAbi([
  'function signMessage(bytes _data)', 'function performCreate(uint256 value, bytes deploymentData)', 'function performCreate2(uint256 value, bytes deploymentData, bytes32 salt)',
  'function migrateSingleton()', 'function migrateWithFallbackHandler()', 'function migrateL2Singleton()', 'function migrateL2WithFallbackHandler()',
  'function migrateToL2(address l2Singleton)', 'function migrateFromV111(address l2Singleton, address fallbackHandler)',
]);
/**
 * A delegatecall to one of Safe's own libraries other than MultiSend: what it does to the Safe, read from its
 * calldata, warned of into `b`. The library being Safe's own says who wrote the code, not what the call does with
 * it: SignMessageLib signs whatever message it is given as the Safe, CreateCall deploys whatever code it is given
 * with the Safe's coin, and SafeToL2Migration sets the Safe's code to whatever address it is given that answers the
 * right version string, on a Safe that has run no transaction yet.
 */
function libraryCall(lib: { name: string; kind: string }, c: Call, b: PreviewBuilder, p: string, coin: (v: bigint) => string): { title: string; summary: string; status: Decoded['status'] } {
  let call;
  try { call = decodeFunctionData({ abi: LIBRARY, data: c.data }); } catch { call = undefined; }
  const fits = (kind: string, names: string[]) => lib.kind === kind && !!call && names.includes(call.functionName);
  if (fits('sign_message', ['signMessage'])) {
    const data = call!.args![0] as Hex, bytes = (data.length - 2) / 2;
    const chars = (data.slice(2).match(/../g) ?? []).map(h => String.fromCharCode(parseInt(h, 16))).join('');
    const text = bytes > 0 && bytes !== 32 && /^[\x20-\x7e\n\r\t]+$/.test(chars) ? chars : null;
    b.detail(`${p}Message signed as the Safe`.replace(/^Call (\d+): M/, 'Call $1: m'), text ? (text.length > 300 ? `${text.slice(0, 300)}…` : text) : bytes === 32 ? `a hash, ${data}` : data.length > 202 ? `${data.slice(0, 202)}… (${bytes} bytes)` : data, data);
    b.warn('caution', 'safe_sign_message', `${p}signs a message in the Safe's name (${lib.name}): contracts that check the Safe's signature (ERC-1271) will accept it as the Safe's. ${text ? 'The message is shown as text' : bytes === 32 ? "Only the message's hash is given" : 'The message is shown as its bytes'}: what it commits the Safe to isn't read here, and it can be an order or a permit that moves the Safe's tokens.`);
    return { title: 'Sign a message as the Safe', summary: 'Marks a message as signed by the Safe.', status: 'partial' };
  }
  if (fits('create_call', ['performCreate', 'performCreate2'])) {
    const [value, code] = call!.args as unknown as [bigint, Hex];
    b.warn(value > 0n ? 'caution' : 'info', 'safe_create_call', `${p}deploys a contract from the Safe (${lib.name}), of ${((code.length - 2) / 2).toLocaleString('en-US')} bytes of code that isn't read here${value > 0n ? `, and sends it ${coin(value)} of the Safe's: what its code does with the coin isn't known` : ''}.`);
    return { title: `Deploy a contract from the Safe${value > 0n ? `, with ${coin(value)}` : ''}`, summary: 'Deploys a contract with the Safe as its creator.', status: 'partial' };
  }
  if (fits('migration', ['migrateSingleton', 'migrateWithFallbackHandler', 'migrateL2Singleton', 'migrateL2WithFallbackHandler']) && /^SafeMigration/.test(lib.name)) {
    b.warn('caution', 'safe_migration', `${p}upgrades the Safe's code through Safe's official ${lib.name} contract (${call!.functionName}: to the singleton that contract was deployed for${/FallbackHandler/.test(call!.functionName) ? ', with its fallback handler' : ''}). Only sign it if you meant to upgrade the Safe.`);
    return { title: `Upgrade the Safe (${lib.name})`, summary: 'Moves the Safe to another official Safe version.', status: 'full' };
  }
  if (fits('migration', ['migrateToL2', 'migrateFromV111']) && /^SafeToL2Migration/.test(lib.name)) {
    const to = String(call!.args![0]).toLowerCase(), official = SAFE_SINGLETONS[to], handler = call!.functionName === 'migrateFromV111' ? String(call!.args![1]).toLowerCase() : null;
    if (official) b.warn('caution', 'safe_migration', `${p}changes the Safe's code to ${official} (${to}) through Safe's ${lib.name} contract${handler ? `, and sets ${handler} as its fallback handler` : ''}. Only sign it if you meant to upgrade the Safe.`);
    else b.warn('danger', 'safe_code_replaced', `${p}sets the Safe's code to the code at ${to}, which isn't one of Safe's own, through Safe's ${lib.name} contract: that contract takes whatever address it is given that says it is version 1.3.0 or 1.4.1, on a Safe that has run no transaction yet. Whoever controls that code controls the Safe and everything in it.`);
    return { title: official ? `Upgrade the Safe to ${official}` : `Replace the Safe's code with ${shortAddress(to)} (${lib.name})`, summary: official ? 'Moves the Safe to another official Safe version.' : "Replaces the Safe's code with code that isn't Safe's own.", status: official ? 'full' : 'partial' };
  }
  // Calldata that is none of the library's functions: its code runs as the Safe all the same, on bytes that aren't read.
  b.warn('caution', 'safe_library_unread', `${p}delegatecalls Safe's ${lib.name} with calldata (${c.data.length >= 10 ? c.data.slice(0, 10) : 'none'}) that isn't one of the functions this reads from it: what it does to the Safe isn't shown.`);
  return { title: `Call ${lib.name} as the Safe (${c.data.length >= 10 ? c.data.slice(0, 10) : 'no calldata'})`, summary: 'A delegatecall to one of Safe\'s libraries, with calldata that isn\'t read.', status: 'opaque' };
}

/** A call running a Safe transaction: execTransaction(to, value, data, operation, safeTxGas, …, signatures). */
const isExecTransaction = (c: Call) => c.operation === 0 && c.data.toLowerCase().startsWith('0x6a761202');
/**
 * What a Safe logs when execTransaction has run its transaction: ExecutionSuccess(bytes32 txHash, uint256 payment),
 * or ExecutionFailure when the call failed and execTransaction didn't revert (Safe 1.1.1 and 1.2.0 whenever it fails;
 * from 1.3.0, with a safeTxGas or a gas price). Safe 1.0.0 logs neither.
 */
const EXECUTION_SUCCESS = '0x442e715f626346e8c54381002da614f62bee8d27386535b2521ec8540898556e', EXECUTION_FAILURE = '0x23428b18acfb3ea64b08dc0c1d296ea9c09702c09083ca5272e64d115b687d23', EXECUTION_FAILED = '0xabfd711ecdd15ae3a6b3ad16ff2e9d81aec026a39d16725ee164be4fbf857a7c';
type Log = NonNullable<SimulationResult['logs']>[number];

/** One call the Safe makes, decoded as its own transaction from the Safe (its settings when it calls itself). */
async function describeCall(c: Call, safe: string, chainId: number, env: AdapterEnv, b: PreviewBuilder, p: string): Promise<Decoded | { title: string; status: 'full'; watch?: undefined; b?: undefined }> {
  if (sameAddress(c.to, safe)) {
    const t = safeAdmin(c.data, b, p);
    if (t) return { title: t, status: 'full' };
  }
  const d = await decodeTransaction({ chainId, from: safe, to: c.to.toLowerCase(), data: c.data.toLowerCase() as Hex, value: c.value }, env.deps, env.context);
  // (The caution that a run used the caller's state, from a Safe this one calls execTransaction on, is said once.)
  for (const w of d.b.warnings) if (w.code === 'state_overridden') b.warn(w.severity, w.code, w.message); else b.warnings.push({ ...w, message: `${p}${w.message}` });
  return d;
}

/**
 * What a SafeTx does, into `b`: the call or batch decoded as the Safe's own transactions, the delegatecall check,
 * the gas refund, and (when every call is a plain call) a simulation of the calls from the Safe.
 */
/**
 * `execution`, when given, runs instead of the calls one by one: the way the Safe really runs this transaction
 * (through the EntryPoint and the 4337 module, or execTransaction itself). It resolves the Safe's balance changes, or
 * null when it couldn't be simulated (the calls are then simulated one by one, as before).
 */
export type SafeExecution = (watch: string[]) => Promise<SafeRan | { reverted: string } | null>;
/**
 * A run of the Safe's transaction: its balance changes, a note, whether its calls succeeded (an operation can run with
 * its calls failing: its own warning says so), and what the run logged, when the simulator reports it.
 */
export type SafeRan = { assetChanges: AssetChange[]; note: string; succeeded: boolean; logs?: readonly Log[] };

export async function describeSafeTx(t: SafeTx, chainId: number, env: AdapterEnv, b: PreviewBuilder, execution?: SafeExecution): Promise<{ title: string; summary: string; status: Decoded['status']; assetChanges: AssetChange[] }> {
  const safe = t.safe.toLowerCase();
  const lib = SAFE_LIBRARIES[t.to.toLowerCase()];
  b.detail('Safe', safe, safe);
  if (t.nonce !== undefined) b.detail('Safe nonce', t.nonce.toString());
  let calls: Call[];
  let label = '';
  // For the branches that return early (Safe's own libraries): the real execution still runs, for what it changes.
  const early = async <T extends { assetChanges: AssetChange[] }>(r: T): Promise<T> => {
    if (!env.deps.simulator || !execution) return r;
    try {
      const out = await execution([]);
      if (out && 'reverted' in out) b.warn('caution', 'safe_tx_reverts', `The transaction is expected to fail when the Safe runs it${out.reverted ? `: ${out.reverted}` : ''}.`);
      else if (out) { if (out.note) b.note(out.note); return { ...r, assetChanges: out.assetChanges }; }
    } catch { /* not simulated */ }
    return r;
  };
  const coin = (v: bigint) => `${formatUnits(v, CHAINS[chainId]?.nativeDecimals ?? 18)} ${CHAINS[chainId]?.nativeSymbol ?? 'native'}`;
  // The transaction is a batch: MultiSend's, delegatecalled. Its calls then run as the Safe, a delegatecall among
  // them too, whether it has twenty calls or one.
  let batched = false;
  if (t.operation === 1 && (lib?.kind === 'multisend' || lib?.kind === 'multisend_call_only')) {
    const parsed = multiSendCalls(t.data);
    if (!parsed) { b.warn('danger', 'safe_delegatecall', `This delegatecalls ${lib.name} with a batch that can't be read.`); return { title: 'Run an unreadable Safe batch', summary: 'A MultiSend batch that could not be decoded.', status: 'opaque', assetChanges: [] }; }
    const flat = laidOut(parsed, lib.kind);
    calls = flat.calls;
    label = lib.name;
    batched = true;
    b.detail('Batch', `${calls.length} call${calls.length === 1 ? '' : 's'} through ${lib.name}${flat.nested ? ` (${flat.nested} of them from ${flat.nested === 1 ? 'a batch' : 'batches'} nested in it, which run as the Safe too)` : ''}`);
  } else if (t.operation === 1 && lib) {
    // Another of Safe's libraries: what it does to the Safe, read from its calldata.
    const r = libraryCall(lib, { operation: 1, to: t.to, value: t.value, data: t.data }, b, '', coin);
    return early({ title: r.title, summary: `${r.summary} Through ${lib.name}.`, status: r.status, assetChanges: [] });
  } else if (t.operation === 1) {
    b.warn('danger', 'safe_delegatecall', `This is a delegatecall: ${t.to}'s code would run as the Safe itself, able to change its owners, move everything in it or replace its code. It is not one of Safe's own libraries. A delegatecall like this is how the Bybit Safe was drained in 2025: don't sign it unless you know exactly what that contract does.`);
    calls = [{ operation: 1, to: t.to, value: t.value, data: t.data }];
  } else {
    // MultiSend must be delegatecalled to run its batch as the Safe. MultiSendCallOnly, called plainly, still runs
    // it, but as itself: the calls can't move the Safe's funds or act in its name. (MultiSend itself reverts.)
    if (lib?.kind === 'multisend' || lib?.kind === 'multisend_call_only') b.warn('caution', 'safe_multisend_call', `This calls ${lib.name} directly instead of delegatecalling it, so its batch ${lib.kind === 'multisend' ? 'is rejected' : 'runs from the MultiSend contract, not from the Safe: the calls can\'t move the Safe\'s funds or act in its name'}. Wallets send batches as a delegatecall; this one is probably built wrong.`);
    calls = [{ operation: 0, to: t.to, value: t.value, data: t.data }];
  }

  const titles: string[] = [];
  const decoded: { status: Decoded['status']; watch?: string[] }[] = [];
  // A Safe transaction among the batch's later calls (one Safe running another's execTransaction), simulated by its
  // own decoding, runs without the calls before it: it can spend what they send it, on a Safe they deploy. Its
  // failure there stands unless the batch, run in order, succeeds and that Safe logs it ran (below): a batch that
  // succeeds doesn't say so by itself, since execTransaction can fail without reverting (ExecutionFailure: before Safe
  // 1.3.0 always, from it with a safeTxGas or a gas price). On Base, a SafeOp sent a token to a Safe it then deployed
  // and ran a transaction on: shown failing (ERC20InsufficientBalance), it ran.
  const alone: { call: number; warning: Warning }[] = [];
  const many = calls.length > 1, listed = calls.slice(0, MAX_LISTED);
  // Every call is decoded, to the two hundredth, each with the reads of the chain its decoding makes (a call past
  // the twentieth wasn't decoded at all: behind twenty transfers, a delegatecall to unknown code or an unlimited
  // approval went with nothing warned of, the batch "fully decoded"). Eight at a time, each into a builder of its
  // own, so that what they warn of is told in the batch's order.
  type Described = { d: { title: string; status: Decoded['status']; watch?: string[]; b?: PreviewBuilder }; sub: PreviewBuilder };
  const describe = async (c: Call, i: number): Promise<Described> => {
    const sub = new PreviewBuilder(), p = many ? `Call ${i + 1}: ` : '';
    // Safe's own libraries, delegatecalled from inside the batch: what each does to the Safe, as when one is the
    // whole transaction. (A nested batch that could be read is already laid out above.)
    const inLib = c.operation === 1 ? SAFE_LIBRARIES[c.to.toLowerCase()] : undefined;
    if (c.unread) {
      sub.warn('danger', 'safe_delegatecall', `${p}delegatecalls ${inLib?.name ?? 'MultiSend'} with a batch of its own that can't be read here (malformed, or nested more than four deep): its calls run as the Safe, and any of them can move what it holds or change it.`);
      return { d: { title: 'Run an unreadable nested batch', status: 'opaque' }, sub };
    }
    if (inLib && inLib.kind !== 'multisend' && inLib.kind !== 'multisend_call_only' && !c.refused) return { d: libraryCall(inLib, c, sub, p, coin), sub };
    return { d: await describeCall(c, safe, chainId, env, sub, p), sub };
  };
  const described: Described[] = [];
  for (let i = 0; i < listed.length; i += 8) described.push(...await Promise.all(listed.slice(i, i + 8).map((c, j) => describe(c, i + j))));
  for (const [i, c] of listed.entries()) {
    const { d, sub } = described[i], p = many ? `Call ${i + 1}: ` : '';
    // A delegatecall inside a batch runs as the Safe, wherever in the batch it is and however many calls the batch
    // has (in a batch of one it went unsaid: the call was shown as what its calldata reads as, a transfer).
    const rogue = batched && c.operation === 1 && !SAFE_LIBRARIES[c.to.toLowerCase()];
    if (rogue) b.warn('danger', 'safe_delegatecall', `${p}a delegatecall to ${c.to} inside the batch: its code would run as the Safe itself, able to change its owners, move everything in it or replace its code.`);
    // The batch reverts on this call, whatever the others do: said, as the simulation would say it.
    if (c.refused) b.warn('caution', 'safe_tx_reverts', `${p}the batch reverts on this call as it is built: ${c.refused}.`);
    for (const w of sub.warnings) if (w.code === 'state_overridden') b.warn(w.severity, w.code, w.message); else b.warnings.push(w);
    if (i > 0 && isExecTransaction(c)) for (const w of sub.warnings) if (w.code === 'safe_tx_reverts') alone.push({ call: i, warning: w });
    decoded.push(d);
    // The coin a call sends, wherever its title doesn't already say it (a token transfer with 100 ETH attached was
    // titled as the transfer, the coin nowhere).
    const value = c.value > 0n && !d.title.includes(coin(c.value)) ? `, with ${coin(c.value)}` : '';
    titles.push(d.title);
    const how = c.operation === 1 ? '(delegatecall) ' : '';
    if (many) b.detail(`Call ${i + 1}`, `${how}${d.title}${value} (${shortAddress(c.to.toLowerCase())})`, c.to.toLowerCase());
    else if (batched && how) b.detail('Call', `${how}${d.title}${value} (${shortAddress(c.to.toLowerCase())})`, c.to.toLowerCase());
    if (!many && value) b.detail('Value sent with the call', coin(c.value), c.value.toString());
    // What the call's own decoding tells of it (who a transfer goes to, who an approval is for): a Safe transaction
    // titled "Send 1,000 USDC" named no recipient anywhere.
    for (const x of d.b?.details ?? []) b.detail(many ? `Call ${i + 1}: ${x.label}` : x.label, x.value, x.raw);
    // (And what a library call's reading adds: the message it signs as the Safe.)
    for (const x of sub.details) b.detail(x.label, x.value, x.raw);
  }
  // Past the two hundredth they aren't decoded, and that is said, with what is cheap to tell of them and matters
  // most: a delegatecall inside the batch runs as the Safe wherever in it it is.
  if (calls.length > MAX_LISTED) {
    const rest = calls.slice(MAX_LISTED);
    const rogue = rest.flatMap((c, j) => (c.operation === 1 && !SAFE_LIBRARIES[c.to.toLowerCase()] ? [{ n: MAX_LISTED + j + 1, to: c.to }] : []));
    for (const r of rogue.slice(0, 3)) b.warn('danger', 'safe_delegatecall', `Call ${r.n}: a delegatecall to ${r.to} inside the batch: its code would run as the Safe itself, able to change its owners, move everything in it or replace its code.`);
    if (rogue.length > 3) b.warn('danger', 'safe_delegatecall', `${rogue.length - 3} more of the batch's calls are delegatecalls to contracts that aren't Safe's libraries (calls ${rogue.slice(3, 9).map(r => r.n).join(', ')}${rogue.length > 9 ? ', …' : ''}).`);
    b.detail('More calls', String(rest.length));
    b.warn('danger', 'safe_calls_unread', `The batch has ${calls.length} calls, and the ${rest.length} after the first ${MAX_LISTED} aren't decoded here: any of them can move what the Safe holds, approve a spender or change the Safe. Don't sign it on the calls listed alone${env.deps.simulator ? ': what a simulation of the whole batch shows, if one is shown below, is all that is told of them' : ''}.`);
  }

  // Gas refund: the Safe pays whoever executes (or refundReceiver) up to (safeTxGas + baseGas) × gasPrice of gasToken.
  if (t.gasPrice > 0n) {
    const native = /^0x0{40}$/.test(t.gasToken);
    const who = /^0x0{40}$/.test(t.refundReceiver) ? 'whoever submits it' : t.refundReceiver;
    b.detail('Gas refund', `up to ${(t.safeTxGas + t.baseGas).toString()} gas × ${t.gasPrice} in ${native ? CHAINS[chainId]?.nativeSymbol ?? 'native' : shortAddress(t.gasToken)}, paid by the Safe to ${who}`);
    if (!/^0x0{40}$/.test(t.refundReceiver)) b.warn('caution', 'safe_gas_refund', `The Safe pays a gas refund to ${shortAddress(t.refundReceiver)}: check that the price and the receiver are what you expect.`);
  }

  let assetChanges: AssetChange[] = [];
  const sim = env.deps.simulator;
  // The real execution path, when the caller has one: delegatecalls included.
  let ran = false;
  // What the calls logged run in order, when they all succeeded.
  let inOrder: readonly Log[] | undefined;
  if (sim && execution) {
    try {
      const r = await execution(decoded.flatMap(d => (d as Decoded).watch ?? []));
      if (r && 'reverted' in r) { ran = true; b.warn('caution', 'safe_tx_reverts', `The transaction is expected to fail when the Safe runs it${r.reverted ? `: ${r.reverted}` : ''}.`); }
      else if (r) { ran = true; assetChanges = r.assetChanges; if (r.note) b.note(r.note); if (r.succeeded) inOrder = r.logs ?? []; }
    } catch { ran = false; }
  }
  // Otherwise simulated from the Safe, in order, when every call is a plain call (a delegatecall can't be run that way),
  // with the state the caller set for the simulation (context.stateOverrides).
  // (Not in a replay: where the Safe couldn't be read on the replayed block, or its run there failed to come back,
  // the calls on today's state are another transaction's, and the replay itself says what this one did.)
  if (!ran && sim && calls.every(c => c.operation === 0) && !env.context.replay) {
    const overrides = callerOverrides(env.context);
    const reqs = calls.map((c, i) => ({ chainId, from: safe, to: c.to.toLowerCase(), data: c.data, value: c.value, ...((decoded[i] as Decoded | undefined)?.watch?.length && { watch: (decoded[i] as Decoded).watch }), ...(overrides && { stateOverrides: overrides }) }));
    try {
      const results = reqs.length === 1 ? [await sim.simulate(reqs[0])] : sim.simulateBatch ? await sim.simulateBatch(reqs) : null;
      if (results?.every(r => r)) warnOverridden(b, overrides);
      if (results && results.every(r => r?.status === 'success')) {
        inOrder = results.flatMap(r => r!.logs ?? []);
        const basis = results.every(r => r!.basis === 'state' || r!.basis === 'fork' || r!.balancesRead) ? 'simulated_state' as const : 'simulated_events' as const;
        assetChanges = await netChanges(results.flatMap(r => r!.transfers), { chainId, from: safe }, env.deps, b, basis);
        b.note(`Simulated as the Safe making the call${calls.length > 1 ? 's in order' : ''}. ${simulationNote(results[0]!)}`);
      } else if (results?.some(r => r?.status === 'reverted')) {
        const k = results.findIndex(r => r?.status === 'reverted');
        b.warn('caution', 'safe_tx_reverts', `${calls.length > 1 ? `Call ${k + 1} of the transaction` : 'The transaction'} is expected to fail when the Safe runs it${results[k]?.revertReason ? `: ${results[k]!.revertReason}` : ''}.`);
      }
    } catch { /* not simulated */ }
  }
  // The batch ran in order and succeeded, and a later call's Safe logged that its transaction ran (above): as many
  // ExecutionSuccess as the batch has run transactions on it up to that call, and no Safe in the run logged a failure
  // (ExecutionFailure, or 1.0.0's ExecutionFailed): a Safe further down whose transaction fails without reverting
  // (before 1.3.0 always, from it with a safeTxGas or a gas price) leaves the Safes above it succeeding.
  if (inOrder) for (const { call, warning } of alone) {
    const target = calls[call].to.toLowerCase(), logged = (topic: string) => inOrder!.filter(l => l.address.toLowerCase() === target && l.topics[0] === topic).length;
    const earlier = calls.slice(0, call).filter(c => isExecTransaction(c) && c.to.toLowerCase() === target).length;
    if (inOrder.some(l => l.topics[0] === EXECUTION_FAILURE || l.topics[0] === EXECUTION_FAILED) || logged(EXECUTION_SUCCESS) <= earlier) continue;
    b.warnings.splice(b.warnings.indexOf(warning), 1);
    const why = /runs it: (.*?)\.?$/.exec(warning.message)?.[1];
    b.note(`Call ${call + 1}'s Safe transaction fails when simulated on its own, without the calls before it${why ? ` (${why})` : ''}; run after them, as the batch runs it, it succeeds (its Safe logs ExecutionSuccess).`);
  }
  const statuses = decoded.map(d => d.status);
  const status = calls.length > MAX_LISTED || statuses.includes('opaque') ? 'partial' : statuses.includes('partial') ? 'partial' : 'full';
  // A delegatecall to an unknown contract is titled for what it is: whatever its calldata looks like (in the Bybit
  // theft it looked like a plain transfer), the contract's own code runs as the Safe.
  // (The same for a batch of one call that is such a delegatecall.)
  const only = calls.length === 1 && calls[0].operation === 1 && !SAFE_LIBRARIES[calls[0].to.toLowerCase()] ? calls[0].to.toLowerCase() : null;
  const rogue = (t.operation === 1 && !lib) || !!only;
  if (rogue) b.detail('Its calldata reads as', titles[0]);
  const title = rogue ? `Let ${shortAddress(only ?? t.to.toLowerCase())} run its code as the Safe (delegatecall)` : calls.length === 1 ? titles[0] : `Run ${calls.length} calls from the Safe`;
  return { title, summary: `The Safe ${shortAddress(safe)} ${calls.length === 1 ? (t.operation === 1 ? 'delegatecalls' : 'makes this call') : `runs ${calls.length} calls${label ? ` through ${label}` : ''}`}: ${titles.slice(0, 3).join('; ')}${calls.length > 3 ? '; …' : ''}.`, status, assetChanges };
}

/**
 * A simulated Safe execution as describeSafeTx takes it: the Safe's balance changes (and a note, unless it added its own),
 * or why it fails. `whole`: `how` is the whole note (a run that wasn't on the latest state: where it ran is said there).
 */
export async function safeOutcome(sim: SimulationResult, safe: string, chainId: number, env: Pick<AdapterEnv, 'deps'>, b: PreviewBuilder, how: string, whole = false): Promise<SafeRan | { reverted: string } | null> {
  if (sim.status === 'reverted') return { reverted: sim.revertReason ?? '' };
  // The probe measures the call's sender, which isn't the Safe here: its balance reads don't apply.
  if (sim.limited || sim.basis === 'state') return null;
  const basis = sim.basis === 'fork' || sim.balancesRead ? 'simulated_state' as const : 'simulated_events' as const;
  return { assetChanges: await netChanges(sim.transfers, { chainId, from: safe }, env.deps, b, basis), note: whole ? how : `${how} ${simulationNote(sim)}`, succeeded: true, ...(sim.logs && { logs: sim.logs }) };
}

/** Warns of what a simulated transaction changes in the Safe's configuration, unless a static warning already says it. */
export function reportConfigChanges(before: SafeConfig, after: SafeConfig, b: PreviewBuilder): void {
  for (const c of configChanges(before, after)) if (!b.warnings.some(w => w.code === COVERED[c.code])) b.warn(c.severity, c.code, c.message);
}

/** Static warnings that already cover a configuration change found by simulation. */
const COVERED: Record<string, string> = { safe_owners_added: 'safe_owners_change', safe_owners_removed: 'safe_owners_change', safe_threshold_changed: 'safe_threshold_change', safe_guard_changed: 'safe_set_guard', safe_fallback_changed: 'safe_fallback_handler', safe_module_enabled: 'safe_enable_module' };

/**
 * The SafeExecution that runs execTransaction itself (for a SafeTx signature, with the hash approved by enough
 * owners; for an execTransaction transaction, as sent) and reports what it changes in the Safe.
 */
export function viaExecTransaction(t: SafeTx, chainId: number, env: AdapterEnv, b: PreviewBuilder, opts: { executor?: string | null; request?: SimulationRequest; asSent?: Pick<SimulationRequest, 'gas' | 'accessList'> }): SafeExecution {
  return async () => {
    // A transaction as sent runs where the transaction does: a mined one replayed, where it ran (its block's
    // earlier transactions first, at the price it paid), and one on a block that was named, there. On the latest
    // state, a replayed Safe transaction was said to be expected to fail (GS026: the Safe's nonce has moved on since,
    // so its signatures are of another hash), beside a replay that matched its receipt. (A signature is previewed
    // on the latest state, whatever block is named.)
    const replay = opts.request ? env.context.replay : undefined;
    const named = opts.request && !replay ? await namedBlock(env.context, env.deps.rpc, chainId) : undefined;
    // For a trace, the block is named, so that the tracing run is of the same one (src/block.ts).
    const at = replay ? { ...replay.at, before: replay.before } : named?.at ?? (env.context.trace ? await pinLatest(env.deps.rpc, chainId) : undefined);
    // The replayed transaction itself, or a call nested in it (a Safe transaction that runs another Safe's, a batch
    // with one in it: their decoders come here with the same context). Only the first has the receipt to be held
    // to, the price it paid, its gas limit and its access list: a nested one runs in the block, alone, as a later
    // call's Safe transaction is run anywhere.
    const own = !!replay && (!replay.call || (sameAddress(opts.request!.from, replay.call.from) && sameAddress(opts.request!.to, replay.call.to) && opts.request!.data.toLowerCase() === replay.call.data));
    const request = own ? { ...opts.request!, ...opts.asSent, gasPrice: replay!.gasPrice, ...(replay!.receipt.gasForL1 && { gasForL1: replay!.receipt.gasForL1 }) } : opts.request;
    // With the state the caller set for the simulation (context.stateOverrides), beneath the stand-ins'.
    const overrides = replay ? undefined : callerOverrides(env.context);
    const run = await simulateSafeExecution(t, chainId, env.deps, { executor: opts.executor, ...(request && { request }), ...(at && { at }), ...(overrides && { stateOverrides: overrides }),
      ...(own && { replayed: { receipt: replay!.receipt, ...(replay!.ownTimestamp !== undefined && { ownTimestamp: replay!.ownTimestamp }) } }),
      // (A call nested in the replayed transaction has that transaction's price, tx.gasprice, for its own.)
      ...(replay && !own && { paid: { gasPrice: replay.gasPrice, baseFee: replay.at.header.baseFeePerGas } }) });
    if (!run) return null;
    warnOverridden(b, overrides);
    // (Not in a replay: the replayed transaction's own trace is the one shown, and has the time a replay's takes.)
    if (env.context.trace && run.requests && !replay) {
      const traceEnv: TraceEnv = { chainId, account: t.safe.toLowerCase(), accountLabel: 'the Safe', deps: env.deps };
      const traces = await tracePreviews(run.requests.slice(0, 1), [run.result], traceEnv);
      if (traces?.[0]) b.trace = traces[0];
      else b.note(noTrace(traceEnv));
    }
    if (run.after) reportConfigChanges(run.before, run.after, b);
    if (!run.executed) return { reverted: run.result.status === 'reverted' ? run.result.revertReason ?? '' : 'the Safe reports that the call failed (ExecutionFailure)' };
    // The price changes what the Safe ends up with: a refund in the native token is paid at the lower of its
    // gasPrice and the transaction's, and a contract the calls reach can read the price too.
    if (run.priced) {
      const gwei = (v: bigint) => `${formatUnits(v, 9)} gwei`;
      b.note(`What this does for the Safe depends on the gas price of the transaction that runs it${t.gasPrice > 0n && /^0x0{40}$/.test(t.gasToken) ? " (its gas refund is paid at the lower of its own gas price and the transaction's)" : ''}: it was simulated at ${run.priced.paid ? 'the price the replayed transaction paid' : 'the price a transaction would pay now'}, ${gwei(run.priced.gasPrice)}${run.priced.tip && !run.priced.paid ? ` (the base fee plus a ${gwei(run.priced.tip)} tip)` : ''}.${run.priced.paid ? '' : ' At another price the result can differ.'}`);
    }
    const outcome = await safeOutcome(run.result, t.safe.toLowerCase(), chainId, env, b, replay
      ? 'What it did for the Safe: execTransaction run again as it was sent, where it ran, so guards, the gas refund and delegatecalls run as they did.'
      : named ? `Simulated as sent, on the state after block ${named.number.toLocaleString('en-US')}: execTransaction with its signatures, so guards, the gas refund and delegatecalls run as they would have.`
      : opts.request
      ? 'Simulated as sent: execTransaction with its signatures, so guards, the gas refund and delegatecalls run as they will.'
      : `Simulated as the Safe runs it: execTransaction itself, signed by enough owners (${run.approved ? `a stand-in for the signing owner's signature, and for the other ${run.approved} an approval of the transaction the Safe is given to hold: more than the sixteen signatures that can be stood in for` : "stand-ins for their signatures, each taken as its owner's"}${run.passkey === 'inline' ? ", and for the signing owner's passkey a WebAuthn assertion by a passkey made up for the run, which the owner's own P-256 check is given in place of its key" : run.passkey ? ", and for the signing owner's passkey a stand-in WebAuthn assertion, which the P-256 verifier it is checked with accepts after running its real check" : ''}), so guards, the gas refund and delegatecalls run as they will.`, !!(replay || named));
    // The run shown had the coin the Safe transaction spends sent along with it (SafeRun.funded).
    if (outcome && 'assetChanges' in outcome && run.funded) {
      const native = CHAINS[chainId]?.nativeSymbol ?? 'native', unit = (v: bigint) => `${formatUnits(v, CHAINS[chainId]?.nativeDecimals ?? 18)} ${native}`;
      b.warn('caution', 'safe_needs_coin', run.funded.held < run.funded.value
        ? `The Safe holds ${unit(run.funded.held)} and this spends ${unit(run.funded.value)}: on the Safe's own balance it fails. It was simulated with ${unit(run.funded.value)} sent along by whoever submits it (execTransaction takes coin with the call, as apps that fund a Safe's call in the same transaction send it): without that, it fails.`
        : `With no coin sent along it fails, and with the ${unit(run.funded.value)} it names sent along by whoever submits it (execTransaction takes coin with the call), it runs: that run is the one shown. It runs another contract's code as the Safe (a delegatecall), which is sent no coin by the Safe itself: that code reads the coin the transaction carries, or spends more than the Safe holds without it.`);
    }
    // A signature's run is sent from the signer. What it takes out of the signer's own account (not the Safe's) is
    // told too: a contract the Safe calls that can spend the signer's tokens (an allowance to the Safe, or to what
    // it runs), or that charges whoever submits the transaction. A Safe transaction on Arbitrum One had the Safe
    // pull 1,140 USDC from its owner and repay the Safe's loan with them (2026-11-23): nothing in the Safe's own
    // balances says so.
    const signer = !opts.request && opts.executor && run.requests?.[0]?.from.toLowerCase() === opts.executor.toLowerCase() ? opts.executor.toLowerCase() : undefined;
    if (outcome && 'assetChanges' in outcome && signer && signer !== t.safe.toLowerCase() && run.result.balancesRead) {
      const own = (await netChanges(run.result.transfers.filter(x => x.asset !== 'native'), { chainId, from: signer }, env.deps, b, 'simulated_state')).filter(c => c.direction === 'out');
      if (own.length) {
        b.warn('caution', 'safe_signer_pays', `Simulated as sent from your account, the transaction also takes ${own.map(c => `${c.amount} ${c.symbol}`).join(', ')} out of your own account (${shortAddress(signer)}), which isn't the Safe's: something it calls can spend your tokens (an allowance you gave), or charges whoever submits it.`);
        outcome.assetChanges.push(...own);
      }
    }
    return outcome;
  };
}
