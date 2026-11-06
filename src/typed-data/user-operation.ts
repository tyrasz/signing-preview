// ERC-4337 UserOperations signed as EIP-712 typed data (EntryPoint v0.8 and v0.9: domain "ERC4337", version "1",
// primary type PackedUserOperation). The signature lets any bundler submit the operation, which runs its callData
// from the account: so the preview is mostly what that callData does, decoded as the account's own transaction.
import { type Hex } from 'viem';
import { formatUnits, PreviewBuilder, sameAddress, shortAddress } from '../format.ts';
import { CHAINS, chainName } from '../chains.ts';
import { decodeTransaction, simulationNote } from '../evm/transaction.ts';
import { netChanges } from '../evm/effects.ts';
import type { AssetChange } from '../types.ts';
import { big, domainChainId, str, type TypedAdapter } from './common.ts';

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

export const userOperationAdapter: TypedAdapter = async (data, env) => {
  if (data.primaryType !== 'PackedUserOperation' || str(data.domain.name) !== 'ERC4337') return null;
  const names = data.types.PackedUserOperation.map(f => f.name);
  if (!FIELDS.every(f => names.includes(f))) return null;
  const m = data.message;
  const chainId = domainChainId(data);
  const network = chainId !== null ? { kind: 'evm' as const, chainId, name: chainName(chainId) } : null;
  const entryPoint = str(data.domain.verifyingContract).toLowerCase();
  const sender = str(m.sender).toLowerCase();
  const callData = hex(m.callData), initCode = hex(m.initCode) ?? '0x', paymasterAndData = hex(m.paymasterAndData) ?? '0x';
  const nonce = big(m.nonce), preVerificationGas = big(m.preVerificationGas);
  const limits = halves(m.accountGasLimits), fees = halves(m.gasFees);
  const b = new PreviewBuilder();
  const mine = env.signer !== null && sameAddress(sender, env.signer);

  b.detail('Account', mine ? `your account (${sender})` : sender, sender);
  b.detail('EntryPoint', ENTRY_POINTS[entryPoint] ? `${ENTRY_POINTS[entryPoint]} (${entryPoint})` : entryPoint, entryPoint);
  if (!ENTRY_POINTS[entryPoint]) b.warn('caution', 'unknown_entrypoint', `${shortAddress(entryPoint)} is not a known ERC-4337 EntryPoint (v0.8 or v0.9). Only sign UserOperations for the EntryPoint your wallet uses.`);
  if (!mine && env.signer) b.warn('info', 'userop_owner_signature', `You sign as an owner of the smart account ${shortAddress(sender)}: the operation runs from that account, not from ${shortAddress(env.signer)}.`);
  if (nonce !== null) b.detail('Nonce', `${nonce & ((1n << 64n) - 1n)} (key ${nonce >> 64n})`, nonce.toString());

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
  const native = chainId !== null ? CHAINS[chainId] : undefined;
  const paymaster = paymasterAndData.length >= 42 ? `0x${paymasterAndData.slice(2, 42)}` : null;
  const paymasterGas = paymasterAndData.length >= 106 ? BigInt(`0x${paymasterAndData.slice(42, 74)}`) + BigInt(`0x${paymasterAndData.slice(74, 106)}`) : 0n;
  if (limits && fees && preVerificationGas !== null) {
    const gas = limits[0] + limits[1] + preVerificationGas + paymasterGas;
    b.detail('Gas limits', `verification ${limits[0]}, call ${limits[1]}, pre-verification ${preVerificationGas}${paymaster ? `, paymaster ${paymasterGas}` : ''}`);
    b.detail('Maximum fee', `${formatUnits(fees[1], 9)} gwei (priority ${formatUnits(fees[0], 9)} gwei)`);
    const cost = `${formatUnits(gas * fees[1], native?.nativeDecimals ?? 18)} ${native?.nativeSymbol ?? 'native'}`;
    b.detail(paymaster ? 'Gas paid by' : 'Maximum gas cost', paymaster ? `paymaster ${paymaster} (at most ${cost})` : `${cost}, from the account`, paymaster ?? undefined);
  }
  if (paymaster) b.warn('info', 'userop_paymaster', `A paymaster (${shortAddress(paymaster)}) pays the gas. It may charge for it in tokens, through the calls below or by its own rules.`);

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
};
