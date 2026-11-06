// ERC-4337 UserOperations signed as EIP-712 typed data (EntryPoint v0.8 and v0.9: domain "ERC4337", version "1",
// primary type PackedUserOperation). The signature lets any bundler submit the operation, which runs its callData
// from the account: so the preview is mostly what that callData does, decoded as the account's own transaction.
import { type Hex } from 'viem';
import { formatUnits, PreviewBuilder, sameAddress, shortAddress } from '../format.ts';
import { CHAINS, chainName } from '../chains.ts';
import { decodeTransaction, simulationNote } from '../evm/transaction.ts';
import { netChanges } from '../evm/effects.ts';
import type { AssetChange } from '../types.ts';
import { big, domainChainId, str, type TypedAdapter, type TypedEnv } from './common.ts';

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
  const paymaster = paymasterAndData.length >= 42 ? `0x${paymasterAndData.slice(2, 42)}`.toLowerCase() : null;
  const paymasterGas = packedGas && paymasterAndData.length >= 106 ? BigInt(`0x${paymasterAndData.slice(42, 74)}`) + BigInt(`0x${paymasterAndData.slice(74, 106)}`) : 0n;
  return { paymaster, paymasterGas };
}

export interface OpGas { verification: bigint; call: bigint; preVerification: bigint; maxFee: bigint; maxPriority: bigint; paymaster: string | null; paymasterGas: bigint; /** EntryPoint v0.6, which reserves verification gas three times over when a paymaster is set. */ v06?: boolean }

/** Gas limits, fees and the most the operation can cost the account (or its paymaster), at the highest fee it allows. */
export function gasDetails(b: PreviewBuilder, g: OpGas, chainId: number | null): void {
  const native = chainId !== null ? CHAINS[chainId] : undefined;
  const gas = g.v06 ? g.call + g.verification * (g.paymaster ? 3n : 1n) + g.preVerification : g.verification + g.call + g.preVerification + g.paymasterGas;
  b.detail('Gas limits', `verification ${g.verification}, call ${g.call}, pre-verification ${g.preVerification}${g.paymaster && !g.v06 ? `, paymaster ${g.paymasterGas}` : ''}`);
  b.detail('Maximum fee', `${formatUnits(g.maxFee, 9)} gwei (priority ${formatUnits(g.maxPriority, 9)} gwei)`);
  const cost = `${formatUnits(gas * g.maxFee, native?.nativeDecimals ?? 18)} ${native?.nativeSymbol ?? 'native'}`;
  b.detail(g.paymaster ? 'Gas paid by' : 'Maximum gas cost', g.paymaster ? `paymaster ${g.paymaster} (at most ${cost})` : `${cost}, from the account`, g.paymaster ?? undefined);
  if (g.paymaster) b.warn('info', 'userop_paymaster', `A paymaster (${shortAddress(g.paymaster)}) pays the gas. It may charge for it in tokens, through the calls below or by its own rules.`);
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
  return describeOperation({ chainId, entryPoint, entryPointName: ENTRY_POINTS[entryPoint] ?? null, sender, nonce, initCode, callData, gas, paymaster: pm.paymaster }, env);
};

/** A UserOperation, whichever EntryPoint version and however it was signed. */
export interface Operation {
  chainId: number | null; entryPoint: string; entryPointName: string | null; sender: string; nonce: bigint | null;
  initCode: Hex; callData: Hex | null; gas: OpGas | null; paymaster: string | null;
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
  let deploys = false;
  const lead = initCode.length >= 42 ? `0x${initCode.slice(2, 42)}` : null;
  const init = initCode.length > 42 ? ', with an initialization call' : '';
  if (initCode === '0x') b.detail('Account setup', 'none (the account already exists)');
  else if (initCode.startsWith(EIP7702_MARKER)) b.detail('Account setup', `EIP-7702 account (its current delegation)${init}`);
  else if (lead && mine) {
    b.detail('Account setup', `EIP-7702 account, delegating to ${lead}${init}`, lead);
    let code: unknown;
    try { code = chainId !== null && env.deps.rpc?.has(chainId) ? await env.deps.rpc.call(chainId, 'eth_getCode', [sender, 'latest']) : undefined; } catch { code = undefined; }
    if (typeof code === 'string' && code.toLowerCase() !== `0xef0100${lead.slice(2)}`) {
      b.warn('caution', 'userop_delegation_differs', `This operation is signed for your account delegating to ${lead}, but ${code === '0x' ? 'your account has no delegation now' : `it delegates to ${code.length === 48 ? `0x${code.slice(8)}` : 'other code'} now`}. It only runs if an EIP-7702 authorization delegating your account to ${shortAddress(lead)} is submitted with it: that contract would then run as your account, with full control of it.`);
    }
  } else if (lead) {
    deploys = true;
    b.detail('Account setup', `deploys the account first, with factory ${shortAddress(lead)}`, lead);
  }

  // Gas: the most the operation can cost the account (or its paymaster), at the highest fee it allows.
  if (u.gas) gasDetails(b, u.gas, chainId);

  b.note('This is an off-chain signature; it costs no gas now. Any bundler holding it can submit the operation, which then runs its calls from the account.');
  if (!callData || callData === '0x' || chainId === null) {
    return { title: `Sign a UserOperation for ${mine ? 'your account' : shortAddress(sender)}`, summary: 'Authorizes an ERC-4337 UserOperation that makes no calls.', decoder: 'erc4337_user_operation', status: 'partial', b, network };
  }

  // The calls: the callData is a call from the EntryPoint into the account, which runs it as the account's own.
  const inner = await decodeTransaction({ chainId, from: sender, to: sender, data: callData, value: 0n, ...(deploys && { codeInPlace: true }) }, env.deps, env.context);
  for (const d of inner.b.details) if (!b.details.some(x => x.label === d.label)) b.details.push(d);
  for (const w of inner.b.warnings) b.warnings.push(w);
  for (const n of inner.b.notes) b.note(n);

  // Simulated as the account calling itself, which smart accounts allow alongside the EntryPoint. One that only
  // takes calls from the EntryPoint reverts here, so a revert is reported as "not simulated", not as a failure.
  let assetChanges: AssetChange[] = inner.assetChanges;
  if (env.deps.simulator && !deploys) {
    try {
      const sim = await env.deps.simulator.simulate({ chainId, from: sender, to: sender, data: callData, value: 0n, ...(inner.watch?.length && { watch: inner.watch }) });
      if (sim?.status === 'success' && !sim.limited) {
        const basis = sim.basis === 'state' || sim.basis === 'fork' || sim.balancesRead ? 'simulated_state' as const : 'simulated_events' as const;
        const simulated = await netChanges(sim.transfers, { chainId, from: sender }, env.deps, b, basis);
        if (simulated.length || !assetChanges.length) assetChanges = simulated;
        b.note(`The calls were simulated as the account running them itself. ${simulationNote(sim)}`);
      } else if (sim?.status === 'reverted') {
        b.note(`Simulating the calls as the account running them itself reverted${sim.revertReason ? ` (${sim.revertReason})` : ''}. Some accounts only take calls from the EntryPoint, so this doesn't mean the operation fails; balance changes are from the decoded calls.`);
      }
    } catch { /* keep the decoded changes */ }
  }
  return {
    title: `Sign a UserOperation: ${inner.title}`,
    summary: `Authorizes an ERC-4337 UserOperation from ${mine ? 'your account' : `account ${shortAddress(sender)}`}. ${inner.summary}`,
    decoder: 'erc4337_user_operation', status: inner.status, b, network, assetChanges,
  };
}
