// ERC-4337 UserOperations signed as EIP-712 typed data (EntryPoint v0.8 and v0.9: domain "ERC4337", version "1",
// primary type PackedUserOperation). The signature lets any bundler submit the operation, which runs its callData
// from the account: so the preview is mostly what that callData does, decoded as the account's own transaction.
import { type Hex } from 'viem';
import { formatUnits, PreviewBuilder, sameAddress, shortAddress } from '../format.ts';
import { CHAINS, chainName } from '../chains.ts';
import { decodeTransaction, simulationNote } from '../evm/transaction.ts';
import { netChanges } from '../evm/effects.ts';
import type { AssetChange } from '../types.ts';
import { big, domainChainId, str, typedDataDigest, type TypedAdapter, type TypedEnv } from './common.ts';
import { entryPointDeposit, simulateExecution, simulateOperation, type ExecutionInput, type OperationRun } from '../erc4337-sim.ts';
import { tokenInfo } from '../evm/common.ts';

/** EntryPoints that sign UserOperations as EIP-712 typed data, at the same address on every chain (checked on Ethereum, Arbitrum One and HyperEVM). */
export const ENTRY_POINTS: Record<string, string> = {
  '0x4337084d9e255ff0702461cf8895ce9e3b5ff108': 'EntryPoint v0.8',
  '0x433709009b8330fda32311df1c2afa402ed8d009': 'EntryPoint v0.9',
};
const FIELDS = ['sender', 'nonce', 'initCode', 'callData', 'accountGasLimits', 'preVerificationGas', 'gasFees', 'paymasterAndData'];
/** initCode of an EIP-7702 account: the marker 0x7702 padded to 20 bytes, then an optional initialization call. */
const EIP7702_MARKER = `0x7702${'00'.repeat(18)}`;

const hex = (v: unknown): Hex | null => typeof v === 'string' && /^0x([0-9a-fA-F]{2})*$/.test(v) ? v.toLowerCase() as Hex : null;
/** The two 128-bit halves of a packed bytes32 (high, low). */
const halves = (v: unknown): [bigint, bigint] | null => {
  const h = hex(v);
  if (!h || h.length !== 66) return null;
  return [BigInt(`0x${h.slice(2, 34)}`), BigInt(`0x${h.slice(34)}`)];
};

/** The paymaster in paymasterAndData, and (from EntryPoint v0.7 on) the gas it may use: verification and post-op limits after its address. */
export function paymasterOf(paymasterAndData: string, packedGas: boolean): { paymaster: string | null; paymasterGas: bigint } {
  // A paymaster field naming address 0 is no paymaster: the EntryPoint skips it, and the account pays.
  const named = paymasterAndData.length >= 42 ? `0x${paymasterAndData.slice(2, 42)}`.toLowerCase() : null;
  const paymaster = named && !/^0x0{40}$/.test(named) ? named : null;
  const paymasterGas = packedGas && paymasterAndData.length >= 106 ? BigInt(`0x${paymasterAndData.slice(42, 74)}`) + BigInt(`0x${paymasterAndData.slice(74, 106)}`) : 0n;
  return { paymaster, paymasterGas };
}

export interface OpGas { verification: bigint; call: bigint; preVerification: bigint; maxFee: bigint; maxPriority: bigint; paymaster: string | null; paymasterGas: bigint; /** EntryPoint v0.6, which reserves verification gas three times over when a paymaster is set. */ v06?: boolean }

/** Gas limits, fees and the most the operation can cost the account (or its paymaster), at the highest fee it allows. */
export function gasDetails(b: PreviewBuilder, g: OpGas, chainId: number | null): bigint {
  const native = chainId !== null ? CHAINS[chainId] : undefined;
  const gas = g.v06 ? g.call + g.verification * (g.paymaster ? 3n : 1n) + g.preVerification : g.verification + g.call + g.preVerification + g.paymasterGas;
  b.detail('Gas limits', `verification ${g.verification}, call ${g.call}, pre-verification ${g.preVerification}${g.paymaster && !g.v06 ? `, paymaster ${g.paymasterGas}` : ''}`);
  b.detail('Maximum fee', `${formatUnits(g.maxFee, 9)} gwei (priority ${formatUnits(g.maxPriority, 9)} gwei)`);
  const cost = `${formatUnits(gas * g.maxFee, native?.nativeDecimals ?? 18)} ${native?.nativeSymbol ?? 'native'}`;
  b.detail(g.paymaster ? 'Gas paid by' : 'Maximum gas cost', g.paymaster ? `paymaster ${g.paymaster} (at most ${cost})` : `${cost}, from the account`, g.paymaster ?? undefined);
  if (g.paymaster) b.warn('info', 'userop_paymaster', `A paymaster (${shortAddress(g.paymaster)}) pays the gas. It may charge for it in tokens, through the calls below or by its own rules.`);
  return gas * g.maxFee;
}

/**
 * The prefund a bundler requires before including the operation: the account's EntryPoint deposit plus its balance
 * (it pays the shortfall during validation), or the paymaster's deposit, must cover the most the gas can cost.
 */
export async function prefundCheck(b: PreviewBuilder, deps: TypedEnv['deps'], chainId: number | null, entryPoint: string, sender: string, paymaster: string | null, maxCost: bigint): Promise<void> {
  if (chainId === null || maxCost === 0n || !deps.rpc?.has(chainId)) return;
  const native = (v: bigint) => `${formatUnits(v, CHAINS[chainId]?.nativeDecimals ?? 18)} ${CHAINS[chainId]?.nativeSymbol ?? 'native'}`;
  const payer = paymaster ?? sender;
  const deposit = await entryPointDeposit(deps, chainId, entryPoint, payer);
  if (deposit === undefined) return;
  let balance = 0n;
  if (!paymaster) { try { balance = BigInt(String(await deps.rpc.call(chainId, 'eth_getBalance', [sender, 'latest']))); } catch { return; } }
  if (deposit + balance < maxCost) b.warn('caution', 'userop_cannot_prefund', paymaster
    ? `The paymaster's EntryPoint deposit (${native(deposit)}) is less than the up to ${native(maxCost)} this operation may cost: bundlers will reject it unless the deposit is topped up.`
    : `The account has ${native(balance)} and ${native(deposit)} deposited in the EntryPoint, less than the up to ${native(maxCost)} this operation may cost in gas: bundlers will reject it.`);
}

/**
 * The EntryPoint's own nonce for this key (getNonce): an operation whose nonce is behind it has already run (or
 * another with the same nonce has), so it can't; one ahead of it waits for the operations before it.
 */
export async function nonceCheck(b: PreviewBuilder, env: { deps: TypedEnv['deps'] }, chainId: number | null, entryPoint: string, sender: string, nonce: bigint | null): Promise<void> {
  if (chainId === null || nonce === null || !env.deps.rpc?.has(chainId)) return;
  const key = nonce >> 64n, seq = nonce & ((1n << 64n) - 1n);
  let current: bigint;
  try { current = BigInt(String(await env.deps.rpc.call(chainId, 'eth_call', [{ to: entryPoint, data: `0x35567e1a${sender.slice(2).padStart(64, '0')}${key.toString(16).padStart(64, '0')}` }, 'latest']))) & ((1n << 64n) - 1n); } catch { return; }
  if (seq < current) b.warn('info', 'userop_nonce_used', `The account's nonce${key ? ` for key ${key}` : ''} is already ${current}: an operation with nonce ${seq} has run, so this one can't.`);
  else if (seq > current) b.note(`${seq - current} other operation${seq - current === 1n ? '' : 's'} of this account must run before this one (its nonce${key ? ` for key ${key}` : ''} is at ${current}).`);
}

export const userOperationAdapter: TypedAdapter = async (data, env) => {
  if (data.primaryType !== 'PackedUserOperation' || str(data.domain.name) !== 'ERC4337') return null;
  const names = data.types.PackedUserOperation.map(f => f.name);
  if (!FIELDS.every(f => names.includes(f))) return null;
  const m = data.message;
  const chainId = domainChainId(data);
  const entryPoint = str(data.domain.verifyingContract).toLowerCase();
  const sender = str(m.sender).toLowerCase();
  const callData = hex(m.callData), initCode = hex(m.initCode) ?? '0x', paymasterAndData = hex(m.paymasterAndData) ?? '0x';
  const nonce = big(m.nonce), preVerificationGas = big(m.preVerificationGas);
  const limits = halves(m.accountGasLimits), fees = halves(m.gasFees);
  const pm = paymasterOf(paymasterAndData, true);
  const gas = limits && fees && preVerificationGas !== null ? { verification: limits[0], call: limits[1], preVerification: preVerificationGas, maxPriority: fees[0], maxFee: fees[1], ...pm } : null;
  const packed = nonce !== null && hex(m.accountGasLimits) && hex(m.gasFees) && preVerificationGas !== null
    ? { nonce, initCode, accountGasLimits: hex(m.accountGasLimits)!, preVerificationGas, gasFees: hex(m.gasFees)!, paymasterAndData } : undefined;
  // The typed data's digest is the operation's hash (v0.8 on) and what the owner signs.
  const digest = typedDataDigest(data) ?? undefined;
  const signature = walletStub(env, entryPoint, sender, nonce, callData);
  return describeOperation({ chainId, entryPoint, entryPointName: ENTRY_POINTS[entryPoint] ?? null, sender, nonce, initCode, callData, gas, paymaster: pm.paymaster, paymasterAndData, packed, userOpHash: digest, ...(digest && { digest }), ...(signature && { signature }) }, env);
};

/**
 * The wallet's stub signature for a typed operation, as it would pass it to a bundler's gas estimation: the
 * `signature` of `context.userOperation` when that is this operation (the same EntryPoint, sender and nonce, and the
 * same callData if it has one). The typed data itself carries everything else.
 */
function walletStub(env: TypedEnv, entryPoint: string, sender: string, nonce: bigint | null, callData: Hex | null): Hex | undefined {
  const supplied = env.context.userOperation;
  const op = supplied?.operation;
  if (!op || !sameAddress(supplied.entryPoint, entryPoint) || typeof op.sender !== 'string' || !sameAddress(op.sender, sender)) return undefined;
  let n: bigint | null = null;
  try { n = typeof op.nonce === 'string' || typeof op.nonce === 'number' || typeof op.nonce === 'bigint' ? BigInt(op.nonce) : null; } catch { n = null; }
  if (n === null || n !== nonce) return undefined;
  if (op.callData !== undefined && hex(op.callData) !== (callData ?? '0x')) return undefined;
  const sig = hex(op.signature);
  return sig && sig !== '0x' ? sig : undefined;
}

/** A UserOperation, whichever EntryPoint version and however it was signed. */
export interface Operation {
  chainId: number | null; entryPoint: string; entryPointName: string | null; sender: string; nonce: bigint | null;
  initCode: Hex; callData: Hex | null; gas: OpGas | null; paymaster: string | null;
  /** For accounts run through executeUserOp (EntryPoint v0.7 on): the packed operation and its hash. */
  packed?: ExecutionInput['packed']; userOpHash?: Hex;
  /** The paymaster's field as signed (needed to simulate the whole operation). */
  paymasterAndData?: Hex;
  /** A signature to validate with in simulation: the wallet's stub for this account, when it supplies one. */
  signature?: Hex;
  /** The digest the signature is over (the message's personal_sign form, or the typed data's digest). */
  digest?: Hex;
}

/** What the EntryPoint's rejection codes mean (eth-infinitism's EntryPoint, all versions). */
const REJECTIONS: Record<string, string> = {
  AA10: 'it deploys the account, which already exists', AA13: 'deploying the account fails', AA14: "the factory doesn't deploy this account", AA15: "the factory doesn't deploy this account",
  AA20: "the account doesn't exist and the operation doesn't deploy it", AA21: "the account can't prefund its gas: its EntryPoint deposit and balance are less than the most the operation can cost",
  AA22: 'it has expired or is not valid yet', AA23: "the account's validation reverts", AA25: "its nonce isn't the account's next", AA26: "the account's validation needs more gas than the operation allows",
  AA30: 'the paymaster has no code', AA31: "the paymaster's EntryPoint deposit can't cover the gas", AA32: "the paymaster's approval has expired or is not valid yet", AA33: 'the paymaster refuses to pay for it',
  AA34: "the paymaster's signature doesn't check out", AA36: "the paymaster's validation needs more gas than the operation allows", AA40: 'validation needs more gas than the operation allows', AA41: 'validation needs more gas than the operation allows',
  AA50: "the paymaster's charge after the calls (postOp) fails", AA51: "the gas cost is more than the account prefunded", AA95: 'the EntryPoint runs out of gas',
};
/** Warnings that already say what a rejection code does. */
const REJECTION_COVERED: Record<string, string> = { AA21: 'userop_cannot_prefund', AA25: 'userop_nonce_used' };

/**
 * Reports a whole-operation simulation (see simulateOperation) and returns its balance changes. Null when the
 * operation's calls should be simulated on their own instead: the simulation didn't run, or the account's
 * validation reverted on the stand-in signature.
 */
export async function reportRun(run: OperationRun | null, u: Pick<Operation, 'sender' | 'paymaster' | 'entryPointName' | 'signature'> & { callData?: Hex | null }, chainId: number, env: TypedEnv, b: PreviewBuilder,
  how: { deploys: boolean; delegate?: string; /** How validation was run, in place of the stand-in signature's wording. */ validation?: string }): Promise<AssetChange[] | null> {
  if (!run) return null;
  const sender = u.sender.toLowerCase();
  const native = (v: bigint) => `${formatUnits(v, CHAINS[chainId]?.nativeDecimals ?? 18)} ${CHAINS[chainId]?.nativeSymbol ?? 'native'}`;
  if (run.rejected) {
    const code = run.rejected.slice(0, 4);
    // A reverting validation is most likely the stand-in signature's shape (passkeys, wrapped signatures): the
    // calls are simulated on their own instead. Anything else is the bundler's answer.
    if (code === 'AA23') { b.note(`The account's validation reverts on a stand-in for the signature (${run.rejected}), so only its calls were simulated.`); return null; }
    // No code and nothing deploying it: an EIP-7702 account delegated in the same transaction (see userop_account_no_code).
    if (code === 'AA20' && !how.deploys) return null;
    // A nonce ahead of the account's waits for the operations before it (the nonce check notes that): not a rejection.
    if (code === 'AA25' && b.notes.some(n => /must run before this one/.test(n))) return null;
    if (!REJECTION_COVERED[code] || !b.warnings.some(w => w.code === REJECTION_COVERED[code])) b.warn('caution', 'userop_rejected', `Bundlers would reject this operation: ${REJECTIONS[code] ?? 'the EntryPoint refuses it'} (${run.rejected}). Nothing it does happens unless that changes.`);
    return null;
  }
  const sim = run.result;
  const now = env.now / 1000;
  const pm = u.paymaster;
  // Validity in block numbers (EntryPoint v0.9) isn't compared with the time.
  const timed = (v: OperationRun['account']) => v?.blocks ? { ...v, validAfter: 0, validUntil: 0 } : v;
  const paymasterValidity = timed(run.paymaster), accountValidity = timed(run.account);
  if (paymasterValidity?.signatureFailed) b.warn('caution', 'userop_paymaster_signature', `The paymaster's signature in this operation doesn't check out (it may be for other gas values, or stale): bundlers will reject it until the paymaster signs again.`);
  else if (paymasterValidity && paymasterValidity.validUntil && paymasterValidity.validUntil < now) b.warn('caution', 'userop_paymaster_expired', `The paymaster's sponsorship expired at ${new Date(paymasterValidity.validUntil * 1000).toISOString()}: bundlers will reject this operation.`);
  else if (paymasterValidity && paymasterValidity.validAfter > now) b.warn('info', 'userop_paymaster_not_yet', `The paymaster's sponsorship starts at ${new Date(paymasterValidity.validAfter * 1000).toISOString()}: bundlers will hold the operation until then.`);
  if (accountValidity?.validUntil && accountValidity.validUntil < now) b.warn('caution', 'userop_expired', `The account only accepts this operation until ${new Date(accountValidity.validUntil * 1000).toISOString()}, which has passed.`);
  else if (accountValidity && accountValidity.validAfter > now) b.warn('info', 'userop_not_yet_valid', `The account accepts this operation from ${new Date(accountValidity.validAfter * 1000).toISOString()}: bundlers will hold it until then.`);

  b.detail('Gas cost (simulated)', `${native(run.paid)}, paid by ${pm ? `the paymaster ${shortAddress(pm)} from its EntryPoint deposit` : 'the account (from its EntryPoint deposit, topped up from its balance)'}`, run.paid.toString());
  // A token paymaster's charge: what the account's tokens went to the paymaster, net (some refund in postOp).
  if (pm) {
    const charge = new Map<string, bigint>();
    for (const l of sim.logs ?? []) if (l.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' && l.topics.length === 3 && l.data.length >= 66) {
      const from = `0x${l.topics[1].slice(26)}`, to = `0x${l.topics[2].slice(26)}`, v = BigInt(l.data.slice(0, 66));
      if (from === sender && to === pm) charge.set(l.address, (charge.get(l.address) ?? 0n) + v);
      if (from === pm && to === sender) charge.set(l.address, (charge.get(l.address) ?? 0n) - v);
    }
    const parts: string[] = [];
    for (const [token, v] of charge) if (v > 0n) { const info = await tokenInfo(env, chainId, token); parts.push(info ? `${formatUnits(v, info.decimals)} ${info.symbol}` : `${v} base units of ${shortAddress(token)}`); }
    if (parts.length) b.detail('Paymaster charge', `${parts.join(' and ')}, from the account (included in the balance changes)`);
  }
  if (run.postOpReverted) b.warn('caution', 'userop_postop_reverts', `The paymaster's charge after the calls (postOp) fails: ${run.postOpReverted}. The EntryPoint then undoes the calls, and the operation still pays ${native(run.paid)} for gas.`);
  else if (!run.executed) {
    // An account run through executeUserOp (IAccountExecute) is handed the whole operation, signature included: one
    // that reads data from its signature while running the calls fails on a stand-in where the signed one needn't
    // (seen on Ethereum: accounts with 700-byte signatures whose calls failed only in the simulation).
    const readsSignature = u.callData?.startsWith('0x8dd7712f') && run.standIn !== 'wallet';
    b.warn('caution', 'userop_execution_reverts', `The operation's calls fail when the EntryPoint runs them${run.revertReason ? `: ${run.revertReason}` : ''}. It can still be included, and ${pm ? 'the paymaster' : 'the account'} pays ${native(run.paid)} for the gas.${readsSignature ? " The account runs them through executeUserOp, which is handed the whole operation, its signature included: here a stand-in, so if the account reads data from its signature while running them, the signed operation can fare differently." : ''}`);
  }
  const basis = sim.basis === 'fork' || sim.balancesRead ? 'simulated_state' as const : 'simulated_events' as const;
  const changes = await netChanges(sim.transfers, { chainId, from: sender }, env.deps, b, basis);
  b.note(`The whole operation was simulated as ${u.entryPointName ?? 'the EntryPoint'} runs it: ${how.deploys ? 'deploying the account through its factory, ' : ''}validation${how.validation ? ` (${how.validation})` : u.signature ? ` (with the wallet's stand-in signature${run.account?.signatureFailed ? ", which the account doesn't accept as signed, as gas-estimation stubs often aren't" : ''})` : ` (with a stand-in for the signature, which doesn't exist until it's signed: ${run.standIn === 'passkey' ? "a passkey's assertion over the operation's hash, which the P256 verifier accepts" : `ecrecover attributes it to ${env.signer ? 'the signer' : 'the account'}`}${run.account?.signatureFailed ? ", but the account doesn't accept it as theirs, so its own signature check isn't simulated" : ''})`}, its calls${how.delegate ? ' (with the account delegating as the operation expects)' : ''}, and the gas payment${pm ? ", with the paymaster's own validation and charge" : ''}. ${simulationNote(sim)}`);
  return changes;
}

/** What a UserOperation does: its account, setup, gas, and its callData decoded and simulated as the account's own calls. */
export async function describeOperation(u: Operation, env: TypedEnv, b = new PreviewBuilder()): Promise<NonNullable<Awaited<ReturnType<TypedAdapter>>>> {
  const { chainId, entryPoint, sender, nonce, initCode, callData } = u;
  const network = chainId !== null ? { kind: 'evm' as const, chainId, name: chainName(chainId) } : null;
  const mine = env.signer !== null && sameAddress(sender, env.signer);

  b.detail('Account', mine ? `your account (${sender})` : sender, sender);
  b.detail('EntryPoint', u.entryPointName ? `${u.entryPointName} (${entryPoint})` : entryPoint, entryPoint);
  if (!u.entryPointName) b.warn('caution', 'unknown_entrypoint', `${shortAddress(entryPoint)} is not a known ERC-4337 EntryPoint. Only sign UserOperations for the EntryPoint your wallet uses.`);
  if (!mine && env.signer) b.warn('info', 'userop_owner_signature', `You sign as an owner of the smart account ${shortAddress(sender)}: the operation runs from that account, not from ${shortAddress(env.signer)}.`);
  if (nonce !== null) b.detail('Nonce', `${nonce & ((1n << 64n) - 1n)} (key ${nonce >> 64n})`, nonce.toString());
  if (u.entryPointName) await nonceCheck(b, env, chainId, entryPoint, sender, nonce);

  // How the account comes to have code: already there, its EIP-7702 delegation, or deployed by a factory first.
  // The EntryPoint hashes an EIP-7702 account's initCode with its delegate in place of the 0x7702 marker, so SDKs
  // (viem's getUserOperationTypedData) put the delegate there in the typed data. An account signing for itself is an
  // EOA, which no factory can deploy: for it, that address is the delegate.
  let deploys = false, delegate: string | undefined;
  const lead = initCode.length >= 42 ? `0x${initCode.slice(2, 42)}` : null;
  const init = initCode.length > 42 ? ', with an initialization call' : '';
  if (initCode === '0x') b.detail('Account setup', 'none (the account already exists)');
  else if (initCode.startsWith(EIP7702_MARKER)) b.detail('Account setup', `EIP-7702 account (its current delegation)${init}`);
  // EntryPoint v0.6 and v0.7 know nothing of EIP-7702: their initCode is always a factory and its data.
  else if (lead && mine && !/v0\.[67]$/.test(u.entryPointName ?? '')) {
    b.detail('Account setup', `EIP-7702 account, delegating to ${lead}${init}`, lead);
    let code: unknown;
    try { code = chainId !== null && env.deps.rpc?.has(chainId) ? await env.deps.rpc.call(chainId, 'eth_getCode', [sender, 'latest']) : undefined; } catch { code = undefined; }
    if (typeof code === 'string' && code.toLowerCase() !== `0xef0100${lead.slice(2)}`) {
      delegate = lead; // simulated with the delegation the operation is signed for
      b.warn('caution', 'userop_delegation_differs', `This operation is signed for your account delegating to ${lead}, but ${code === '0x' ? 'your account has no delegation now' : `it delegates to ${code.length === 48 ? `0x${code.slice(8)}` : 'other code'} now`}. It only runs if an EIP-7702 authorization delegating your account to ${shortAddress(lead)} is submitted with it: that contract would then run as your account, with full control of it.`);
    }
  } else if (lead) {
    deploys = true;
    b.detail('Account setup', `deploys the account first, with factory ${shortAddress(lead)}`, lead);
  }

  // Gas: the most the operation can cost the account (or its paymaster), at the highest fee it allows.
  if (u.gas) await prefundCheck(b, env.deps, chainId, entryPoint, sender, u.paymaster, gasDetails(b, u.gas, chainId));

  b.note('This is an off-chain signature; it costs no gas now. Any bundler holding it can submit the operation, which then runs its calls from the account.');
  if (!callData || callData === '0x' || chainId === null) {
    return { title: `Sign a UserOperation for ${mine ? 'your account' : shortAddress(sender)}`, summary: 'Authorizes an ERC-4337 UserOperation that makes no calls.', decoder: 'erc4337_user_operation', status: 'partial', b, network };
  }

  // The calls: the callData is a call from the EntryPoint into the account, which runs it as the account's own.
  const inner = await decodeTransaction({ chainId, from: sender, to: sender, data: callData, value: 0n, ...(deploys && { codeInPlace: true }) }, env.deps, env.context);
  for (const d of inner.b.details) if (!b.details.some(x => x.label === d.label)) b.details.push(d);
  for (const w of inner.b.warnings) b.warnings.push(w);
  for (const n of inner.b.notes) b.note(n);

  // The whole operation simulated as the EntryPoint runs it: validation, the calls, gas and the paymaster's charge.
  let assetChanges: AssetChange[] = inner.assetChanges;
  let whole: AssetChange[] | null = null;
  if (env.deps.simulator && chainId !== null && u.gas && nonce !== null && u.paymasterAndData !== undefined) {
    // The EntryPoint receives an EIP-7702 account's initCode with the 0x7702 marker where the typed data has its delegate.
    const onChainInit = lead && mine && !deploys && !initCode.startsWith(EIP7702_MARKER) && u.entryPointName && !u.entryPointName.endsWith('v0.6') && !u.entryPointName.endsWith('v0.7')
      ? `${EIP7702_MARKER}${initCode.slice(42)}` as Hex : initCode;
    try {
      const run = await simulateOperation({ chainId, entryPoint, sender, nonce, initCode: onChainInit, callData, callGasLimit: u.gas.call, verificationGasLimit: u.gas.verification, preVerificationGas: u.gas.preVerification,
        maxFeePerGas: u.gas.maxFee, maxPriorityFeePerGas: u.gas.maxPriority, paymasterAndData: u.paymasterAndData, ...(u.signature && { signature: u.signature }), ...(u.digest && { digest: u.digest }), ...(env.signer && { signer: env.signer }), ...(delegate && { delegate }), ...(inner.watch?.length && { watch: inner.watch }) }, env.deps);
      whole = await reportRun(run, u, chainId, env, b, { deploys, ...(delegate && { delegate }) });
    } catch { whole = null; }
    if (whole && (whole.length || !assetChanges.length)) assetChanges = whole;
  }
  // Otherwise its calls alone, as the EntryPoint makes them: the account deployed first if it's new, then called.
  if (whole === null && env.deps.simulator && chainId !== null) {
    try {
      const run = await simulateExecution({ chainId, entryPoint, sender, callData, ...(deploys && { initCode }), ...(delegate && { delegate }), ...(u.packed && { packed: u.packed }), ...(u.userOpHash && { userOpHash: u.userOpHash }), ...(u.gas && { callGasLimit: u.gas.call }), ...(inner.watch?.length && { watch: inner.watch }) }, env.deps);
      const sim = run?.result;
      const how = run?.direct ? "directly from the account: this account only runs calls it validated in the same transaction (a flag kept in transient storage), which can't be done before it's signed"
        : `as the EntryPoint runs it${run?.deployed ? ', after deploying the account through its factory' : ''}${delegate ? ', with the account delegating as the operation expects' : ''}`;
      if (run?.noCode) b.warn('info', 'userop_account_no_code', `The account ${shortAddress(sender)} has no code, so the EntryPoint calling it would run nothing. The operation only does something if the account is delegated (EIP-7702) in the same transaction, and the preview can't simulate that.`);
      // The probe measures the sender of the call (here the EntryPoint), so its balance reads aren't the account's.
      else if (sim?.status === 'success' && !sim.limited && sim.basis !== 'state') {
        const basis = sim.basis === 'fork' || sim.balancesRead ? 'simulated_state' as const : 'simulated_events' as const;
        const simulated = await netChanges(sim.transfers, { chainId, from: sender }, env.deps, b, basis);
        if (simulated.length || !assetChanges.length) assetChanges = simulated;
        b.note(`The operation's calls were simulated ${how}. Its signature check, gas payment and any paymaster charge aren't part of the simulation. ${simulationNote(sim)}`);
      } else if (sim?.status === 'success') {
        b.note(`The operation's calls were checked ${how}: they succeed. Balance changes are from the decoded calls.`);
      } else if (sim?.status === 'reverted') {
        b.warn('caution', 'userop_execution_reverts', `The operation's calls are expected to fail when the EntryPoint runs them${sim.revertReason ? `: ${sim.revertReason}` : ''}. The account (or its paymaster) would still pay the gas.`);
      }
    } catch { /* keep the decoded changes */ }
  }
  return {
    title: `Sign a UserOperation: ${inner.title}`,
    summary: `Authorizes an ERC-4337 UserOperation from ${mine ? 'your account' : `account ${shortAddress(sender)}`}. ${inner.summary}`,
    decoder: 'erc4337_user_operation', status: inner.status, b, network, assetChanges,
  };
}
