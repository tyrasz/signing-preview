// Simulating a Safe transaction the way the Safe runs it: execTransaction itself, so the Safe's own logic decides
// (guards, the gas refund, delegatecalls of any contract). An owner's signature doesn't exist yet when previewing,
// so the signing owner signs with the ECDSA stand-in (ecrecover attributes it to them over the transaction's hash),
// and the other owners the threshold needs approve the hash on-chain (Safe's approvedHashes, the approval signature
// type 1 accepts): the threshold and owners stay as they are.
// In the same simulated block, the Safe's configuration is read again (owners, threshold, singleton, guard,
// fallback handler, modules) and compared with now: what a delegatecall did to the Safe shows even when its
// calldata looks harmless, as in the 2025 Bybit theft (a delegatecall that replaced the Safe's singleton).
import { concatHex, decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, sha256, stringToHex, toFunctionSelector, type Hex } from 'viem';
import type { Dependencies, SimulationRequest, SimulationResult } from './types.ts';
import type { SafeTx } from './safe.ts';
import type { BlockAt } from './block.ts';
import { ecdsaStandIn, P256_STUB, STUB_SIGNATURE } from './erc4337-sim.ts';
import { effectOf, roomFor } from './evm/effects.ts';
import { expectedGasPrice } from './evm/tx-checks.ts';

const ABI = parseAbi([
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function nonce() view returns (uint256)',
  'function getStorageAt(uint256 offset, uint256 length) view returns (bytes)',
  'function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)',
  'function masterCopy() view returns (address)',
  'function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)',
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)',
]);
const SLOTS = {
  singleton: 0n,
  guard: BigInt('0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8'),
  fallbackHandler: BigInt('0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5'),
};
const APPROVED_HASHES_SLOT = 8n; // Safe 1.1.1 to 1.5.0: singleton, modules, owners, ownerCount, threshold, nonce, domain separator, signedMessages, approvedHashes
const SENTINEL = '0x0000000000000000000000000000000000000001';

/** Safe's official singletons (safe-global/safe-deployments; 1.3.0 to 1.5.0 the same on Ethereum, Arbitrum One and HyperEVM). */
export const SAFE_SINGLETONS: Record<string, string> = {
  '0x34cfac646f301356faa8b21e94227e3583fe3f5f': 'Safe 1.1.1', '0x6851d6fdfafd08c0295c392436245e5bc78b0185': 'Safe 1.2.0',
  '0xd9db270c1b5e3bd161e8c8503c55ceabee709552': 'Safe 1.3.0', '0x69f4d1788e39c87893c980c06edf4b7f686e2938': 'Safe 1.3.0',
  '0x3e5c63644e683549055b9be8653de26e0b4cd36e': 'Safe 1.3.0 (L2)', '0xfb1bffc9d739b8d520daf37df666da4c687191ea': 'Safe 1.3.0 (L2)',
  '0x41675c099f32341bf84bfc5382af534df5c7461a': 'Safe 1.4.1', '0x29fcb43b46531bca003ddc8fcb67ffe91900c762': 'Safe 1.4.1 (L2)',
  '0xff51a5898e281db6dfc7855790607438df2ca44b': 'Safe 1.5.0', '0xedd160febbd92e350d4d398fb636302fccd67c7e': 'Safe 1.5.0 (L2)',
};

export interface SafeConfig {
  owners: string[]; threshold: bigint; singleton: string; guard: string; fallbackHandler: string; modules: string[];
  /** Only the singleton could be read: the Safe no longer answers as a Safe (its code was replaced). */
  partial?: boolean;
}
export interface SafeRun {
  result: SimulationResult; executed: boolean; before: SafeConfig; after?: SafeConfig;
  /** The price the run shown was simulated at, when the price changes what the transaction does for the Safe. */
  priced?: { gasPrice: bigint; tip: bigint };
  /** What was simulated for `result` (execTransaction, then the configuration reads): for tracing it. */
  requests?: SimulationRequest[];
}

const word = (v: string | bigint) => (typeof v === 'bigint' ? v.toString(16) : v.toLowerCase().replace(/^0x/, '')).padStart(64, '0');
const addr = (w: Hex | string) => `0x${w.slice(-40)}`.toLowerCase();
export const reads = (safe: string): { to: string; data: Hex }[] => [
  { to: safe, data: encodeFunctionData({ abi: ABI, functionName: 'getOwners' }) },
  { to: safe, data: encodeFunctionData({ abi: ABI, functionName: 'getThreshold' }) },
  // The proxy answers masterCopy() itself (from slot 0), so the singleton reads even when it no longer is a Safe's.
  { to: safe, data: encodeFunctionData({ abi: ABI, functionName: 'masterCopy' }) },
  ...(['guard', 'fallbackHandler'] as const).map(k => ({ to: safe, data: encodeFunctionData({ abi: ABI, functionName: 'getStorageAt', args: [SLOTS[k], 1n] }) })),
  { to: safe, data: encodeFunctionData({ abi: ABI, functionName: 'getModulesPaginated', args: [SENTINEL, 20n] }) },
];
export function config(out: (Hex | undefined)[]): SafeConfig | undefined {
  const singleton = out[2] && /^0x[0-9a-f]{64}$/i.test(out[2]) ? addr(out[2]) : undefined;
  if (!singleton) return undefined;
  const partial = { owners: [], threshold: 0n, singleton, guard: '', fallbackHandler: '', modules: [], partial: true };
  if (out.some(o => !o || o === '0x')) return partial;
  try {
    const [owners] = decodeAbiParameters([{ type: 'address[]' }], out[0]!);
    const [threshold] = decodeAbiParameters([{ type: 'uint256' }], out[1]!);
    const slot = (o: Hex) => addr(decodeAbiParameters([{ type: 'bytes' }], o)[0]);
    const [modules] = decodeAbiParameters([{ type: 'address[]' }, { type: 'address' }], out[5]!);
    return { owners: owners.map(o => o.toLowerCase()), threshold, singleton, guard: slot(out[3]!), fallbackHandler: slot(out[4]!), modules: modules.map(m => m.toLowerCase()) };
  } catch { return partial; }
}

/** The Safe's configuration now (owners, threshold, singleton, guard, fallback handler, modules), undefined if it isn't a readable Safe. */
export async function readConfig(deps: Dependencies, chainId: number, safe: string): Promise<SafeConfig | undefined> {
  const rpc = deps.rpc;
  if (!rpc?.has(chainId)) return undefined;
  const c = config(await Promise.all(reads(safe.toLowerCase()).map(r => rpc.call(chainId, 'eth_call', [{ to: r.to, data: r.data }, 'latest']).then(o => String(o) as Hex).catch(() => undefined))));
  return c?.partial ? undefined : c;
}

/**
 * Signatures by `threshold` owners (ascending, as checkSignatures requires) for a hash the Safe checks. Each stands in
 * as an on-chain approval: the hash marked approved for the owner in approvedHashes (the storage to override), and
 * an approved-hash signature (r = owner, s = 0, v = 1). With `ecdsa`, that owner (one of them) signs with this ECDSA
 * signature instead (a stand-in that a replaced ecrecover attributes to them, so validation costs what it will), and
 * the lowest other owners approve. Null if the Safe has fewer owners than its threshold.
 */
export function approvalsFor(before: SafeConfig, hash: Hex, ecdsa?: { owner: string; signature: Hex; contract?: Hex }): { stateDiff: Record<string, string>; signatures: Hex } | null {
  const ascending = [...before.owners].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  const own = ecdsa && ascending.includes(ecdsa.owner.toLowerCase()) ? ecdsa.owner.toLowerCase() : undefined;
  const signers = (own ? [own, ...ascending.filter(o => o !== own).slice(0, Number(before.threshold) - 1)] : ascending.slice(0, Number(before.threshold)))
    .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  if (signers.length < Number(before.threshold) || !/^0x[0-9a-f]{64}$/i.test(hash)) return null;
  const approving = signers.filter(o => o !== own);
  return {
    stateDiff: Object.fromEntries(approving.map(o => [keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [hash, keccak256(`0x${word(o)}${word(APPROVED_HASHES_SLOT)}` as Hex)])), `0x${word(1n)}`])),
    signatures: safeSignatures(signers.map(o => o === own ? { owner: o, signature: ecdsa!.signature, ...(ecdsa!.contract && { contract: ecdsa!.contract }) } : { owner: o, signature: `0x${word(o)}${word(0n)}01` as Hex })),
  };
}

/**
 * A Safe's signatures, owners in ascending order: 65 bytes each, and for an owner signing as a contract (`contract`:
 * what its isValidSignature takes), the owner, the offset of its data and type 0, with the data after all of them.
 */
export function safeSignatures(parts: { owner: string; signature?: Hex; contract?: Hex }[]): Hex {
  let tail = '';
  const heads = parts.map(p => {
    if (!p.contract) return p.signature!.slice(2);
    const head = `${word(p.owner)}${word(BigInt(parts.length * 65 + tail.length / 2))}00`;
    tail += `${word(BigInt((p.contract.length - 2) / 2))}${p.contract.slice(2)}`;
    return head;
  });
  return `0x${heads.join('')}${tail}` as Hex;
}

/**
 * Safe's WebAuthn shared signer (safe-modules; source verified on Sourcify, the same address on every chain here): a
 * Safe owner checking a passkey the Safe keeps in its own storage (its configure, delegatecalled at setup), with the
 * P-256 verifiers it names: a precompile, then a fallback verifier contract.
 */
export const SAFE_WEBAUTHN_SHARED_SIGNER = '0x94a4f6affbd8975951142c3999aeab7ecee555c2';
const SHARED_SIGNER = parseAbi(['function getConfiguration(address account) view returns ((uint256 x, uint256 y, uint176 verifiers))']);
const CONFIGURE = toFunctionSelector('configure((uint256,uint256,uint176))').slice(2);
/**
 * The verifiers a Safe's passkey is checked with through the shared signer (each address 0 if unset): from the Safe's
 * storage, or for a Safe its operation deploys, from the configure call in its setup. Null when it has no passkey.
 */
export async function sharedSignerVerifiers(deps: Dependencies, chainId: number, safe: string, initCode?: string): Promise<{ precompile: string; fallback: string } | null> {
  let verifiers = 0n;
  if (initCode && initCode.length > 2) {
    const i = initCode.toLowerCase().indexOf(CONFIGURE);
    if (i >= 0 && initCode.length >= i + 8 + 192) verifiers = BigInt(`0x${initCode.slice(i + 8 + 128, i + 8 + 192)}`);
  } else if (deps.rpc?.has(chainId)) {
    try {
      const out = String(await deps.rpc.call(chainId, 'eth_call', [{ to: SAFE_WEBAUTHN_SHARED_SIGNER, data: encodeFunctionData({ abi: SHARED_SIGNER, functionName: 'getConfiguration', args: [safe as Hex] }) }, 'latest']));
      if (/^0x[0-9a-f]{192}$/i.test(out)) verifiers = BigInt(`0x${out.slice(130)}`);
    } catch { /* unreadable */ }
  }
  return verifiersOf(verifiers);
}
/** P256.Verifiers (a uint176): the precompile's address (16 bits) above the fallback verifier contract's. Null if unset. */
function verifiersOf(verifiers: bigint): { precompile: string; fallback: string } | null {
  if (!verifiers) return null;
  const address = (v: bigint) => `0x${v.toString(16).padStart(40, '0')}`;
  return { precompile: address((verifiers >> 160n) & 0xffffn), fallback: address(verifiers & ((1n << 160n) - 1n)) };
}
const SIGNER_CONFIGURATION = toFunctionSelector('getConfiguration()');
/**
 * A Safe owner that is a passkey's own signer (safe-modules' SafeWebAuthnSignerProxy, one per passkey, made by its
 * SafeWebAuthnSignerFactory): the passkey and the verifiers it is checked with are the proxy's immutables, which its
 * getConfiguration() returns (x, y, verifiers). The verifiers, or null when the owner isn't one (an EOA answers nothing).
 */
export async function webAuthnSignerVerifiers(deps: Dependencies, chainId: number, owner: string): Promise<{ precompile: string; fallback: string } | null> {
  if (!deps.rpc?.has(chainId)) return null;
  try {
    const out = String(await deps.rpc.call(chainId, 'eth_call', [{ to: owner, data: SIGNER_CONFIGURATION }, 'latest']));
    if (!/^0x[0-9a-f]{192}$/i.test(out) || /^0x0{128}/.test(out)) return null;
    return verifiersOf(BigInt(`0x${out.slice(130)}`));
  } catch { return null; }
}
/**
 * A passkey's assertion as Safe's WebAuthn library decodes it: abi.encode(authenticatorData, clientDataFields, r, s)
 * (it adds the type and the challenge to clientDataFields itself), user present and verified, with P256_STUB, which
 * the replaced verifier accepts.
 */
export function safeWebAuthnStub(): Hex {
  const authenticatorData = concatHex([sha256(stringToHex('app.safe.global')), '0x05', '0x00000000']);
  return encodeAbiParameters([{ type: 'bytes' }, { type: 'string' }, { type: 'uint256' }, { type: 'uint256' }],
    [authenticatorData, '"origin":"https://app.safe.global","crossOrigin":false', BigInt(P256_STUB.r), BigInt(P256_STUB.s)]);
}

/** What whoever submits a signed SafeTx is given for a priced run's gas (hex wei: a million of the native token). */
const SUBMITTER_BALANCE = `0x${(10n ** 24n).toString(16)}`;
/**
 * execTransaction simulated for this SafeTx (or `request`: an execTransaction transaction as sent, with its own
 * signatures), followed by the configuration reads. Null without an RPC and a simulator that runs batches.
 */
export async function simulateSafeExecution(t: SafeTx, chainId: number, deps: Dependencies, opts: { executor?: string | null; request?: SimulationRequest; at?: BlockAt } = {}): Promise<SafeRun | null> {
  const rpc = deps.rpc, sim = deps.simulator;
  if (!rpc?.has(chainId) || !sim?.simulateBatch) return null;
  const safe = t.safe.toLowerCase();
  const call = async (data: Hex) => String(await rpc.call(chainId, 'eth_call', [{ to: safe, data }, 'latest'])) as Hex;
  const before = config(await Promise.all(reads(safe).map(r => call(r.data).catch(() => undefined))));
  if (!before || before.partial) return null; // not a readable Safe
  let exec: SimulationRequest;
  if (opts.request) exec = { ...opts.request, account: safe };
  else {
    // The transaction's hash at the Safe's current nonce, as execTransaction computes it.
    const nonce = BigInt(await call(encodeFunctionData({ abi: ABI, functionName: 'nonce' })));
    const hash = await call(encodeFunctionData({ abi: ABI, functionName: 'getTransactionHash', args: [t.to as Hex, t.value, t.data, t.operation, t.safeTxGas, t.baseGas, t.gasPrice, t.gasToken as Hex, t.refundReceiver as Hex, nonce] }));
    // The signing owner (the executor, or else the first owner) signs with the ECDSA stand-in, which the replaced
    // ecrecover attributes to them over this hash, so the Safe's check costs what it will; any other owners the
    // threshold needs approve on-chain.
    const executor = (opts.executor && before.owners.includes(opts.executor.toLowerCase()) ? opts.executor : before.owners[0]).toLowerCase();
    const approvals = approvalsFor(before, hash, { owner: executor, signature: STUB_SIGNATURE });
    if (!approvals) return null;
    const { stateDiff, signatures } = approvals;
    const standIn = ecdsaStandIn(executor, hash, chainId);
    exec = { chainId, from: executor, account: safe, to: safe, value: 0n, accessList: standIn.accessList,
      stateOverrides: { ...standIn.stateOverrides, ...(Object.keys(stateDiff).length && { [safe]: { stateDiff } }) },
      data: encodeFunctionData({ abi: ABI, functionName: 'execTransaction', args: [t.to as Hex, t.value, t.data, t.operation, t.safeTxGas, t.baseGas, t.gasPrice, t.gasToken as Hex, t.refundReceiver as Hex, signatures] }) };
  }
  if (opts.at) exec = { ...exec, at: opts.at };
  const batch = (first: SimulationRequest) => [first, ...reads(safe).map(r => ({ chainId, from: exec.from, to: r.to, data: r.data, value: 0n, ...(opts.at && { at: opts.at }) }))];
  let requests = batch(exec);
  let results = await sim.simulateBatch(requests);
  if (!results) return null;
  // Once more at the price the transaction would pay now, as a single transaction is (src/evm/transaction.ts). A
  // Safe's refund in the native token is gas × min(its gasPrice, tx.gasprice): nothing at no price. If the price
  // changes what the Safe ends up with, the priced run is the one shown. Whoever submits a signed SafeTx can pay
  // for its gas (the owner standing in for them may hold nothing); a transaction as sent runs on its sender's own
  // balance, and a node that refuses it there leaves the first run standing.
  let priced: SafeRun['priced'];
  if (results[0].status === 'success' && !results[0].limited && results[0].gasUsed !== undefined) {
    try {
      const price = await expectedGasPrice({ chainId, from: exec.from, to: exec.to, data: exec.data as Hex, value: exec.value }, deps);
      const pricedRequests = batch({ ...exec, gas: exec.gas ?? roomFor(results[0].gasUsed), gasPrice: price?.gasPrice, baseFee: price?.baseFee,
        ...(!opts.request && { stateOverrides: { ...exec.stateOverrides, [exec.from]: { ...exec.stateOverrides?.[exec.from], balance: SUBMITTER_BALANCE } } }) });
      const again = price && await sim.simulateBatch(pricedRequests);
      // (Not a priced run whose balances couldn't be read, where the first run's were: what differs may be only that.)
      if (price && again && again[0].status === 'success' && !(again[0].stateReadError && !results[0].stateReadError) && effectOf(again[0], safe) !== effectOf(results[0], safe)) { results = again; priced = price; requests = pricedRequests; }
    } catch { /* the node refused the priced run: the first stands */ }
  }
  const result = results[0];
  // execTransaction returns false (and emits ExecutionFailure) when the call fails with safeTxGas or gasPrice set.
  const executed = result.status === 'success' && (!result.returnData || result.returnData === '0x' || BigInt(result.returnData.slice(0, 66)) === 1n);
  return { result, executed, before, after: result.status === 'success' ? config(results.slice(1).map(r => r.status === 'success' ? r.returnData as Hex : undefined)) : undefined, ...(priced && { priced }), requests };
}

const SAFE_FACTORY = parseAbi([
  'function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce)',
  'function createChainSpecificProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce)',
  'function createProxyWithCallback(address singleton, bytes initializer, uint256 saltNonce, address callback)',
]);
const SAFE_SETUP = parseAbi(['function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)']);
/**
 * A Safe its factory is deploying (an operation's initCode: the factory and its call): the owners, threshold and
 * fallback handler its setup gives it. Null if the initCode isn't a Safe proxy factory's call with a setup.
 */
export function safeSetupOf(initCode: string): { owners: string[]; threshold: bigint; fallbackHandler: string } | null {
  if (initCode.length < 42 + 8) return null;
  try {
    const call = decodeFunctionData({ abi: SAFE_FACTORY, data: `0x${initCode.slice(42)}` as Hex });
    const setup = decodeFunctionData({ abi: SAFE_SETUP, data: call.args[1] });
    const [owners, threshold, , , fallbackHandler] = setup.args;
    return { owners: owners.map(o => o.toLowerCase()), threshold, fallbackHandler: fallbackHandler.toLowerCase() };
  } catch { return null; }
}

export interface ConfigChange { severity: 'danger' | 'caution' | 'info'; code: string; message: string }

/** What the transaction changes in the Safe itself, from the configuration before and after it. */
export function configChanges(before: SafeConfig, after: SafeConfig): ConfigChange[] {
  const out: ConfigChange[] = [];
  const zero = (a: string) => /^0x0{40}$/.test(a);
  if (after.singleton !== before.singleton) out.push(SAFE_SINGLETONS[after.singleton]
    ? { severity: 'caution', code: 'safe_upgrade', message: `The Safe's code changes to ${SAFE_SINGLETONS[after.singleton]} (${after.singleton}), from ${SAFE_SINGLETONS[before.singleton] ?? before.singleton}.` }
    : { severity: 'danger', code: 'safe_code_replaced', message: `After this transaction the Safe runs the code at ${after.singleton}, which isn't one of Safe's own${after.partial ? ' (the Safe no longer even answers as a Safe)' : ''}: whoever controls that code controls the Safe and everything in it. This is what the Bybit theft did.` });
  if (after.partial) return out; // nothing else can be read
  const added = after.owners.filter(o => !before.owners.includes(o)), removed = before.owners.filter(o => !after.owners.includes(o));
  if (added.length) out.push({ severity: 'caution', code: 'safe_owners_added', message: `Adds ${added.length === 1 ? 'an owner' : `${added.length} owners`}: ${added.join(', ')}.` });
  if (removed.length) out.push({ severity: 'caution', code: 'safe_owners_removed', message: `Removes ${removed.length === 1 ? 'an owner' : `${removed.length} owners`}: ${removed.join(', ')}.` });
  if (after.threshold !== before.threshold) out.push({ severity: 'caution', code: 'safe_threshold_changed', message: `Changes the threshold from ${before.threshold} to ${after.threshold} of ${after.owners.length} owners.` });
  if (after.guard !== before.guard) out.push({ severity: 'caution', code: 'safe_guard_changed', message: zero(after.guard) ? `Removes the Safe's guard (${before.guard}), which checks every transaction.` : `Sets the Safe's guard to ${after.guard}: it can block any transaction the Safe makes.` });
  if (after.fallbackHandler !== before.fallbackHandler) out.push({ severity: 'caution', code: 'safe_fallback_changed', message: `Changes the Safe's fallback handler to ${zero(after.fallbackHandler) ? 'none' : after.fallbackHandler}: it answers calls the Safe doesn't handle itself, including signature checks for some setups.` });
  const enabled = after.modules.filter(m => !before.modules.includes(m)), disabled = before.modules.filter(m => !after.modules.includes(m));
  if (enabled.length) out.push({ severity: 'danger', code: 'safe_module_enabled', message: `Enables ${enabled.length === 1 ? 'a module' : `${enabled.length} modules`} (${enabled.join(', ')}): a module can move everything in the Safe without the owners' signatures.` });
  if (disabled.length) out.push({ severity: 'info', code: 'safe_module_disabled', message: `Disables ${disabled.join(', ')}.` });
  return out;
}
