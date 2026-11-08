// Safe (Gnosis Safe) multisig transactions. Owners approve a SafeTx by signing it (EIP-712), and anyone submits it
// with execTransaction once enough owners have. The SafeTx says what the Safe will do: a call (operation 0) or a
// delegatecall (operation 1), which runs another contract's code as the Safe itself, able to change its owners or
// replace its code. That is how the Bybit Safe was drained in 2025: the owners signed a delegatecall they couldn't
// read. Delegatecalls to Safe's own libraries (MultiSend for batches, SignMessageLib, CreateCall) are normal;
// anything else is danger.
import { decodeFunctionData, parseAbi, type Hex } from 'viem';
import { formatUnits, PreviewBuilder, sameAddress, shortAddress } from './format.ts';
import { CHAINS } from './chains.ts';
import { decodeTransaction, simulationNote } from './evm/transaction.ts';
import { netChanges } from './evm/effects.ts';
import type { AdapterEnv, Decoded } from './evm/common.ts';
import type { AssetChange, SimulationRequest, SimulationResult } from './types.ts';
import { configChanges, simulateSafeExecution, type SafeConfig } from './safe-sim.ts';

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
  // Official upgrades: these change the Safe's code, to an official Safe singleton.
  '0x526643f69b81b008f46d95cd5ced5ec0edffdac6': { name: 'SafeMigration 1.4.1', kind: 'migration' },
  '0xff83f6335d8930cbad1c0d439a841f01888d9f69': { name: 'SafeToL2Migration 1.4.1', kind: 'migration' },
  '0x6439e7abd8bb915a5263094784c5cf561c4172ac': { name: 'SafeMigration 1.5.0', kind: 'migration' },
};
const ZERO = '0x0000000000000000000000000000000000000000';
const MAX_CALLS = 20;

export interface SafeTx { safe: string; to: string; value: bigint; data: Hex; operation: number; safeTxGas: bigint; baseGas: bigint; gasPrice: bigint; gasToken: string; refundReceiver: string; nonce?: bigint }
interface Call { operation: number; to: string; value: bigint; data: Hex }

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

/** One call the Safe makes, decoded as its own transaction from the Safe (its settings when it calls itself). */
async function describeCall(c: Call, safe: string, chainId: number, env: AdapterEnv, b: PreviewBuilder, p: string): Promise<Decoded | { title: string; status: 'full'; watch?: undefined }> {
  if (sameAddress(c.to, safe)) {
    const t = safeAdmin(c.data, b, p);
    if (t) return { title: t, status: 'full' };
  }
  const d = await decodeTransaction({ chainId, from: safe, to: c.to.toLowerCase(), data: c.data.toLowerCase() as Hex, value: c.value }, env.deps, env.context);
  for (const w of d.b.warnings) b.warnings.push({ ...w, message: `${p}${w.message}` });
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
export type SafeExecution = (watch: string[]) => Promise<{ assetChanges: AssetChange[]; note: string } | { reverted: string } | null>;

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
  if (t.operation === 1 && (lib?.kind === 'multisend' || lib?.kind === 'multisend_call_only')) {
    const parsed = multiSendCalls(t.data);
    if (!parsed) { b.warn('danger', 'safe_delegatecall', `This delegatecalls ${lib.name} with a batch that can't be read.`); return { title: 'Run an unreadable Safe batch', summary: 'A MultiSend batch that could not be decoded.', status: 'opaque', assetChanges: [] }; }
    calls = parsed;
    label = lib.name;
    b.detail('Batch', `${calls.length} call${calls.length === 1 ? '' : 's'} through ${lib.name}`);
  } else if (t.operation === 1 && lib?.kind === 'sign_message') {
    b.warn('info', 'safe_sign_message', `This signs a message in the Safe's name (${lib.name}): contracts that check the Safe's signature (ERC-1271) will accept it as the Safe's.`);
    return early({ title: 'Sign a message as the Safe', summary: `Marks a message as signed by the Safe, through ${lib.name}.`, status: 'full' as const, assetChanges: [] });
  } else if (t.operation === 1 && lib?.kind === 'migration') {
    b.warn('caution', 'safe_migration', `This upgrades the Safe's code through Safe's official ${lib.name} contract. Only sign it if you meant to upgrade the Safe.`);
    return early({ title: `Upgrade the Safe (${lib.name})`, summary: `Moves the Safe to another official Safe version, through ${lib.name}.`, status: 'full' as const, assetChanges: [] });
  } else if (t.operation === 1 && lib?.kind === 'create_call') {
    b.warn('info', 'safe_create_call', `This deploys a contract from the Safe (${lib.name}).`);
    return early({ title: 'Deploy a contract from the Safe', summary: `Deploys a contract with the Safe as its creator, through ${lib.name}.`, status: 'full' as const, assetChanges: [] });
  } else if (t.operation === 1) {
    b.warn('danger', 'safe_delegatecall', `This is a delegatecall: ${t.to}'s code would run as the Safe itself, able to change its owners, move everything in it or replace its code. It is not one of Safe's own libraries. A delegatecall like this is how the Bybit Safe was drained in 2025: don't sign it unless you know exactly what that contract does.`);
    calls = [{ operation: 1, to: t.to, value: t.value, data: t.data }];
  } else {
    // MultiSend must be delegatecalled to run its batch as the Safe. MultiSendCallOnly, called plainly, still runs
    // it, but as itself: the calls can't move the Safe's funds or act in its name. (MultiSend itself reverts.)
    if (lib?.kind === 'multisend' || lib?.kind === 'multisend_call_only') b.warn('caution', 'safe_multisend_call', `This calls ${lib.name} directly instead of delegatecalling it, so its batch ${lib.kind === 'multisend' ? 'is rejected' : 'runs from the MultiSend contract, not from the Safe: the calls can\'t move the Safe\'s funds or act in its name'}. Wallets send batches as a delegatecall; this one is probably built wrongly.`);
    calls = [{ operation: 0, to: t.to, value: t.value, data: t.data }];
  }

  const titles: string[] = [];
  const decoded: { status: Decoded['status']; watch?: string[] }[] = [];
  for (const [i, c] of calls.slice(0, MAX_CALLS).entries()) {
    const p = calls.length > 1 ? `Call ${i + 1}: ` : '';
    if (calls.length > 1 && c.operation === 1 && !SAFE_LIBRARIES[c.to.toLowerCase()]) b.warn('danger', 'safe_delegatecall', `${p}a delegatecall to ${c.to} inside the batch: its code would run as the Safe itself, able to change its owners, move everything in it or replace its code.`);
    const d = await describeCall(c, safe, chainId, env, b, p);
    decoded.push(d);
    const value = c.value > 0n && !/\b(send|deposit|stake)\b/i.test(d.title) ? `, with ${formatUnits(c.value, CHAINS[chainId]?.nativeDecimals ?? 18)} ${CHAINS[chainId]?.nativeSymbol ?? 'native'}` : '';
    titles.push(d.title);
    if (calls.length > 1) b.detail(`Call ${i + 1}`, `${c.operation === 1 ? '(delegatecall) ' : ''}${d.title}${value} (${shortAddress(c.to.toLowerCase())})`, c.to.toLowerCase());
  }
  if (calls.length > MAX_CALLS) b.detail('More calls', String(calls.length - MAX_CALLS));

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
  if (sim && execution) {
    try {
      const r = await execution(decoded.flatMap(d => (d as Decoded).watch ?? []));
      if (r && 'reverted' in r) { ran = true; b.warn('caution', 'safe_tx_reverts', `The transaction is expected to fail when the Safe runs it${r.reverted ? `: ${r.reverted}` : ''}.`); }
      else if (r) { ran = true; assetChanges = r.assetChanges; if (r.note) b.note(r.note); }
    } catch { ran = false; }
  }
  // Otherwise simulated from the Safe, in order, when every call is a plain call (a delegatecall can't be run that way).
  if (!ran && sim && calls.every(c => c.operation === 0)) {
    const reqs = calls.map((c, i) => ({ chainId, from: safe, to: c.to.toLowerCase(), data: c.data, value: c.value, ...((decoded[i] as Decoded).watch?.length && { watch: (decoded[i] as Decoded).watch }) }));
    try {
      const results = reqs.length === 1 ? [await sim.simulate(reqs[0])] : sim.simulateBatch ? await sim.simulateBatch(reqs) : null;
      if (results && results.every(r => r?.status === 'success')) {
        const basis = results.every(r => r!.basis === 'state' || r!.basis === 'fork' || r!.balancesRead) ? 'simulated_state' as const : 'simulated_events' as const;
        assetChanges = await netChanges(results.flatMap(r => r!.transfers), { chainId, from: safe }, env.deps, b, basis);
        b.note(`Simulated as the Safe making the call${calls.length > 1 ? 's in order' : ''}. ${simulationNote(results[0]!)}`);
      } else if (results?.some(r => r?.status === 'reverted')) {
        const k = results.findIndex(r => r?.status === 'reverted');
        b.warn('caution', 'safe_tx_reverts', `${calls.length > 1 ? `Call ${k + 1} of the transaction` : 'The transaction'} is expected to fail when the Safe runs it${results[k]?.revertReason ? `: ${results[k]!.revertReason}` : ''}.`);
      }
    } catch { /* not simulated */ }
  }
  const statuses = decoded.map(d => d.status);
  const status = statuses.includes('opaque') ? 'partial' : statuses.includes('partial') ? 'partial' : 'full';
  // A delegatecall to an unknown contract is titled for what it is: whatever its calldata looks like (in the Bybit
  // theft it looked like a plain transfer), the contract's own code runs as the Safe.
  const rogue = t.operation === 1 && !lib;
  if (rogue) b.detail('Its calldata reads as', titles[0]);
  const title = rogue ? `Let ${shortAddress(t.to.toLowerCase())} run its code as the Safe (delegatecall)` : calls.length === 1 ? titles[0] : `Run ${calls.length} calls from the Safe`;
  return { title, summary: `The Safe ${shortAddress(safe)} ${calls.length === 1 ? (t.operation === 1 ? 'delegatecalls' : 'makes this call') : `runs ${calls.length} calls${label ? ` through ${label}` : ''}`}: ${titles.slice(0, 3).join('; ')}${calls.length > 3 ? '; …' : ''}.`, status, assetChanges };
}

/** A simulated Safe execution as describeSafeTx takes it: the Safe's balance changes (and a note, unless it added its own), or why it fails. */
export async function safeOutcome(sim: SimulationResult, safe: string, chainId: number, env: Pick<AdapterEnv, 'deps'>, b: PreviewBuilder, how: string): Promise<{ assetChanges: AssetChange[]; note: string } | { reverted: string } | null> {
  if (sim.status === 'reverted') return { reverted: sim.revertReason ?? '' };
  // The probe measures the call's sender, which isn't the Safe here: its balance reads don't apply.
  if (sim.limited || sim.basis === 'state') return null;
  const basis = sim.basis === 'fork' || sim.balancesRead ? 'simulated_state' as const : 'simulated_events' as const;
  return { assetChanges: await netChanges(sim.transfers, { chainId, from: safe }, env.deps, b, basis), note: `${how} ${simulationNote(sim)}` };
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
export function viaExecTransaction(t: SafeTx, chainId: number, env: AdapterEnv, b: PreviewBuilder, opts: { executor?: string | null; request?: SimulationRequest }): SafeExecution {
  return async () => {
    const run = await simulateSafeExecution(t, chainId, env.deps, opts);
    if (!run) return null;
    if (run.after) reportConfigChanges(run.before, run.after, b);
    if (!run.executed) return { reverted: run.result.status === 'reverted' ? run.result.revertReason ?? '' : 'the Safe reports that the call failed (ExecutionFailure)' };
    return safeOutcome(run.result, t.safe.toLowerCase(), chainId, env, b, opts.request
      ? 'Simulated as sent: execTransaction with its signatures, so guards, the gas refund and delegatecalls run as they will.'
      : "Simulated as the Safe runs it: execTransaction itself, with the transaction approved by enough owners (the Safe's approvedHashes standing in for their signatures), so guards, the gas refund and delegatecalls run as they will.");
  };
}
