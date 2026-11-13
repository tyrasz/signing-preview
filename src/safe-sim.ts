// Simulating a Safe transaction the way the Safe runs it: execTransaction itself, so the Safe's own logic decides
// (guards, the gas refund, delegatecalls of any contract). An owner's signature doesn't exist yet when previewing,
// so the signing owner signs with the ECDSA stand-in (ecrecover attributes it to them over the transaction's hash),
// and the other owners the threshold needs approve the hash on-chain (Safe's approvedHashes, the approval signature
// type 1 accepts): the threshold and owners stay as they are.
// In the same simulated block, the Safe's configuration is read again (owners, threshold, singleton, guard,
// fallback handler, modules) and compared with now: what a delegatecall did to the Safe shows even when its
// calldata looks harmless, as in the 2025 Bybit theft (a delegatecall that replaced the Safe's singleton).
import { bytesToHex, concatHex, decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData, hexToBytes, hexToString, keccak256, parseAbi, sha256, stringToHex, toFunctionSelector, type Hex } from 'viem';
import { p256 } from '@noble/curves/nist';
import type { Dependencies, SimulationRequest, SimulationResult } from './types.ts';
import type { SafeTx } from './safe.ts';
import type { BlockAt } from './block.ts';
import { base64url, ecdsaStandIn, lastSignature, P256_STUB, passkeyVerifiersStandIn, STUB_SIGNATURE } from './erc4337-sim.ts';
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
  /**
   * The signing owner is a passkey, which signed with a stand-in for its WebAuthn assertion: `'inline'` when the owner
   * checks it itself (Zeal's signer), the assertion then a real one by a passkey made up for the run.
   */
  passkey?: boolean | 'inline';
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

/**
 * Zeal's passkey signer (Signer, source verified on Sourcify; the same address on every chain here, and the one its
 * factory deploys on each, November 2026): a Safe owner per passkey, a SignerProxy (its implementation in slot 0, the
 * passkey's public key after it) whose isValidSignature checks the passkey's WebAuthn assertion itself: its
 * OriginCheck contract finds one of the wallet's six origins in clientDataJSON, then FreshCryptoLib's P-256 code
 * verifies it, in Solidity. With no verifier or precompile to stand in at, the stand-in is a real assertion, by a
 * passkey made up for the run (see zealSignerStandIn).
 */
export const ZEAL_SIGNERS = new Set(['0xfeca1a69282273548587fe1538d4471644d5807a']);
/** Zeal's DeploymentRouter: a Safe its factory creates delegatecalls setupSafe(recoveryId, x, y) in its setup, deploying the owner's signer. */
const ZEAL_DEPLOYMENT_ROUTER = '0xf2230dc5924b7cb5757c86dbd658515a8894b493', SETUP_SAFE = '0xab61d888';
/** Zeal's factory (an upgradeable proxy) and its IMPLEMENTATION_SIGNER(): the implementation a new signer proxy gets. */
const ZEAL_FACTORY = '0xf2b940e16b93a78f8884f80b89fa691460069bd1', IMPLEMENTATION_SIGNER = '0xa4462d85';
/** Where the signer's code moves while the stand-in takes its address. */
const ZEAL_SIGNER_MOVED = '0x0000000000000000000000000000000000ec2ea1';
/** The stand-in passkey: a private key made up for the run, and its public key (worked out when first needed). */
const STAND_IN_PASSKEY = hexToBytes(sha256(stringToHex('signing-preview: a stand-in passkey')));
let standInPublicKey: { x: Hex; y: Hex } | undefined;
export const standInPasskey = () => {
  if (!standInPublicKey) { const key = p256.getPublicKey(STAND_IN_PASSKEY, false); standInPublicKey = { x: bytesToHex(key.slice(1, 33)), y: bytesToHex(key.slice(33)) }; }
  return standInPublicKey;
};
/** checkSignature(authenticatorData, flagMask, clientData, challenge, challengeOffset, rs, Q): the public key Q is its 8th and 9th words. */
const CHECK_SIGNATURE = toFunctionSelector('checkSignature(bytes,bytes1,bytes,bytes32,uint256,uint256[2],uint256[2])').slice(2);
/**
 * Code for the signer's implementation address for the run: every call runs the real code (moved to
 * ZEAL_SIGNER_MOVED, delegatecalled, so in the owner's own storage), except that checkSignature, which
 * isValidSignature calls on the owner itself with the public key it stores, is given the stand-in passkey's instead.
 * The owner's check runs whole: its key read from storage, the origin check, FreshCryptoLib's verification.
 *   calldatacopy(0, 0, calldatasize)
 *   if (selector == checkSignature) { mstore(0xe4, x); mstore(0x104, y) }
 *   delegatecall(gas, moved, 0, calldatasize, 0, 0); return (or revert) its returndata
 */
export function zealSignerStandIn(): Hex {
  const { x, y } = standInPasskey();
  const hex2 = (n: number) => n.toString(16).padStart(4, '0');
  const head = `366000600037` + `60003560e01c63${CHECK_SIGNATURE}1415`; // 19 bytes, then PUSH2 skip JUMPI
  const swap = `7f${x.slice(2)}60e452` + `7f${y.slice(2)}61010452`; // 73 bytes
  const call = `5b6000600036600073${ZEAL_SIGNER_MOVED.slice(2)}5af4` + `3d600060003e`; // 37 bytes, then PUSH2 ok JUMPI
  const skip = 19 + 4 + 73, ok = skip + 37 + 4 + 4;
  return `0x${head}61${hex2(skip)}57${swap}${call}61${hex2(ok)}57` + `3d6000fd` + `5b3d6000f3` as Hex;
}
/** The form of a Zeal passkey's assertion: its authenticator data, and clientDataJSON with the challenge (43 characters, base64url) at challengeOffset. */
export interface ZealForm { authenticatorData: Hex; clientDataJSON: string; challengeOffset: number }
/**
 * Zeal's browser extension's form, for an owner with no earlier assertion to go by. Its origin is the third of the
 * six the signer's origin check looks through: each one listed before the one found costs a scan of clientDataJSON
 * (twice, about 80,000 gas each), so the operation's gas can be 250,000 high (the first origin's, Zeal's Android app)
 * to 290,000 low (the fifth's) where the wallet signs elsewhere; the middle keeps the gap least.
 */
export const ZEAL_EXTENSION_FORM: ZealForm = {
  authenticatorData: concatHex([sha256(stringToHex('passkey.zealwallet.com')), '0x1d', '0x00000000']),
  clientDataJSON: `{"type":"webauthn.get","challenge":"${'A'.repeat(43)}","origin":"chrome-extension://heamnjbnflcikcggoiplibfommfbkjpj","crossOrigin":false}`, challengeOffset: 36,
};
const ZEAL_SIGNATURE = [{ type: 'bytes' }, { type: 'bytes' }, { type: 'uint256' }, { type: 'uint256[2]' }] as const;
/**
 * A Zeal passkey's assertion of `challenge`, as its signer decodes it (abi.encode(authenticatorData, clientDataJSON,
 * challengeOffset, [r, s])), by the stand-in passkey: signed over sha256(authenticatorData || sha256(clientDataJSON)),
 * as WebAuthn signs, in `form` with the challenge put in.
 */
export function zealAssertion(challenge: Hex, form: ZealForm = ZEAL_EXTENSION_FORM): Hex {
  const clientDataJSON = `${form.clientDataJSON.slice(0, form.challengeOffset)}${base64url(challenge)}${form.clientDataJSON.slice(form.challengeOffset + 43)}`;
  const signed = sha256(concatHex([form.authenticatorData, sha256(stringToHex(clientDataJSON))]));
  const { r, s } = p256.sign(hexToBytes(signed), STAND_IN_PASSKEY);
  return encodeAbiParameters(ZEAL_SIGNATURE, [form.authenticatorData, stringToHex(clientDataJSON), BigInt(form.challengeOffset), [r, s]]);
}
/**
 * The form of the assertion `owner` signed as a contract in these Safe signatures (the data its static part points
 * to): undefined when it didn't, or it isn't a Zeal assertion with a 32-byte challenge in plain-ASCII clientDataJSON.
 */
export function zealFormIn(signatures: Hex, owner: string): ZealForm | undefined {
  const hex = signatures.slice(2).toLowerCase(), size = hex.length / 2;
  let end = size; // the static parts end where the first contract signature's data starts
  for (let at = 0; at + 65 <= end; at += 65) {
    const part = hex.slice(at * 2, at * 2 + 130);
    if (part.slice(128) !== '00') continue;
    const offset = Number(BigInt(`0x${part.slice(64, 128)}`));
    if (offset < at + 65 || offset + 32 > size) return undefined;
    end = Math.min(end, offset);
    if (`0x${part.slice(24, 64)}` !== owner.toLowerCase()) continue;
    const length = Number(BigInt(`0x${hex.slice(offset * 2, offset * 2 + 64)}`));
    if (offset + 32 + length > size) return undefined;
    try {
      const [authenticatorData, clientData, challengeOffset] = decodeAbiParameters(ZEAL_SIGNATURE, `0x${hex.slice(offset * 2 + 64, (offset + 32 + length) * 2)}`);
      const clientDataJSON = hexToString(clientData), at36 = Number(challengeOffset);
      if (!/^[\x20-\x7e]*$/.test(clientDataJSON) || authenticatorData.length < 2 + 37 * 2 || !/^[A-Za-z0-9_-]{43}"/.test(clientDataJSON.slice(at36, at36 + 44))) return undefined;
      return { authenticatorData, clientDataJSON, challengeOffset: at36 };
    } catch { return undefined; }
  }
  return undefined;
}
/**
 * The stand-in for a Zeal passkey owner (see ZEAL_SIGNERS) signing `hash` for the Safe: the owner's data among the
 * Safe's signatures, an assertion by the stand-in passkey in the form its wallet last signed in (from the Safe's latest
 * earlier operation through one of `entryPoints`, its signatures `signaturesAt` bytes in; else ZEAL_EXTENSION_FORM),
 * and what the run needs: zealSignerStandIn at the signer's implementation, its real code moved, warm as a
 * moved precompile is (the implementation itself stays cold, as on-chain). The challenge is what the owner is asked
 * about: Safe 1.5.0 passes the hash itself (isValidSignature(bytes32), whose challenge is its keccak256), earlier
 * Safes the data whose hash it is (the challenge is the hash). Null when the owner is neither a deployed signer of
 * Zeal's implementation nor the signer a deploying Safe's setup creates (`initCode`), or the code can't be read.
 */
export async function zealStandIn(deps: Dependencies, chainId: number, owner: string, opts: { safe: string; hash: Hex; singleton?: string; initCode?: string; entryPoints?: string[]; signaturesAt?: number }): Promise<{ contract: Hex; stateOverrides: NonNullable<SimulationRequest['stateOverrides']>; warm: string[] } | null> {
  const rpc = deps.rpc;
  if (!rpc?.has(chainId)) return null;
  owner = owner.toLowerCase();
  const setup = opts.initCode && opts.initCode.length > 2 ? setupOf(opts.initCode) : null;
  let implementation: string | undefined, singleton = opts.singleton;
  if (setup) {
    // The Safe's setup has Zeal's router deploy this owner's signer: the implementation its factory gives every signer.
    // (Zeal's factory deploys a Safe whose one owner is its signer; the factory, an upgradeable proxy, names the
    // implementation it gives signers now: one that isn't stood in for falls back to the ECDSA stand-in.)
    if (setup.to !== ZEAL_DEPLOYMENT_ROUTER || !setup.data.toLowerCase().startsWith(SETUP_SAFE) || setup.owners.length !== 1 || !setup.owners.includes(owner)) return null;
    try { implementation = `0x${String(await rpc.call(chainId, 'eth_call', [{ to: ZEAL_FACTORY, data: IMPLEMENTATION_SIGNER }, 'latest'])).slice(-40)}`.toLowerCase(); } catch { return null; }
    if (!ZEAL_SIGNERS.has(implementation)) return null;
    singleton = setup.singleton;
  } else {
    try { implementation = `0x${String(await rpc.call(chainId, 'eth_getStorageAt', [owner, '0x0', 'latest'])).slice(-40)}`.toLowerCase(); } catch { return null; }
    if (!ZEAL_SIGNERS.has(implementation)) return null;
  }
  let code: Hex;
  try { code = String(await rpc.call(chainId, 'eth_getCode', [implementation, 'latest'])) as Hex; } catch { return null; }
  if (!/^0x[0-9a-f]{2,}$/i.test(code)) return null;
  let form: ZealForm | undefined;
  const formOf = (signature: Hex) => zealFormIn(`0x${signature.slice(2 + (opts.signaturesAt ?? 12) * 2)}`, owner);
  for (const entryPoint of setup ? [] : opts.entryPoints ?? []) {
    // (The Safe's other owner can have signed its latest operations: its latest the passkey signed.)
    const last = await lastSignature({ deps, chainId, sender: opts.safe.toLowerCase(), entryPoint, match: signature => !!formOf(signature), key: `zeal:${owner}` });
    form = last ? formOf(last) : undefined;
    if (form) break;
  }
  const challenge = singleton && SAFE_SINGLETONS[singleton.toLowerCase()]?.startsWith('Safe 1.5') ? keccak256(opts.hash) : opts.hash;
  return { contract: zealAssertion(challenge, form), stateOverrides: { [implementation]: { code: zealSignerStandIn() }, [ZEAL_SIGNER_MOVED]: { code } }, warm: [ZEAL_SIGNER_MOVED] };
}
/** The EntryPoints whose operations a Safe's 4337 modules run (v0.6 for Safe4337Module v0.2.0, Zeal's; v0.7 for v0.3.0), where its owner's last assertion is looked for. */
const SAFE_OP_ENTRY_POINTS = ['0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789', '0x0000000071727de22e5e9d8baf0edac6f37da032'];

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
  let exec: SimulationRequest, signedByPasskey: SafeRun['passkey'] = false;
  if (opts.request) exec = { ...opts.request, account: safe };
  else {
    // The transaction's hash at the Safe's current nonce, as execTransaction computes it.
    const nonce = BigInt(await call(encodeFunctionData({ abi: ABI, functionName: 'nonce' })));
    const hash = await call(encodeFunctionData({ abi: ABI, functionName: 'getTransactionHash', args: [t.to as Hex, t.value, t.data, t.operation, t.safeTxGas, t.baseGas, t.gasPrice, t.gasToken as Hex, t.refundReceiver as Hex, nonce] }));
    // The signing owner (the executor, or else the first owner) signs with the ECDSA stand-in, which the replaced
    // ecrecover attributes to them over this hash, so the Safe's check costs what it will; any other owners the
    // threshold needs approve on-chain. A passkey owner (through Safe's WebAuthn shared signer, or its own
    // SafeWebAuthnSignerProxy) signs as a contract, with a WebAuthn assertion its P-256 verifier accepts after
    // running its real check, as for a SafeOp (src/typed-data/safe.ts): the ECDSA stand-in recovered to its address,
    // so Safe took it as an EOA's and the check (about 225,000 gas, in Solidity) never ran.
    const executor = (opts.executor && before.owners.includes(opts.executor.toLowerCase()) ? opts.executor : before.owners[0]).toLowerCase();
    const verifiers = executor === SAFE_WEBAUTHN_SHARED_SIGNER ? await sharedSignerVerifiers(deps, chainId, safe) : await webAuthnSignerVerifiers(deps, chainId, executor);
    const passkey = verifiers ? await passkeyVerifiersStandIn(deps, chainId, verifiers) : null;
    // A Zeal passkey owner checks the passkey's P-256 signature itself, in Solidity, with no verifier to stand in at:
    // it signs a real assertion, by a passkey made up for the run (see zealStandIn).
    const zeal = verifiers ? null : await zealStandIn(deps, chainId, executor, { safe, hash, singleton: before.singleton, entryPoints: SAFE_OP_ENTRY_POINTS });
    const approvals = approvalsFor(before, hash, { owner: executor, signature: STUB_SIGNATURE, ...(passkey ? { contract: safeWebAuthnStub() } : zeal && { contract: zeal.contract }) });
    if (!approvals) return null;
    const { stateDiff, signatures } = approvals;
    const standIn = ecdsaStandIn(executor, hash, chainId);
    if (passkey) signedByPasskey = true;
    else if (zeal) signedByPasskey = 'inline';
    exec = { chainId, from: executor, account: safe, to: safe, value: 0n, accessList: [...standIn.accessList!, ...(passkey?.accessList ?? []), ...(zeal?.warm ?? []).map(address => ({ address, storageKeys: [] }))],
      stateOverrides: { ...standIn.stateOverrides, ...passkey?.stateOverrides, ...zeal?.stateOverrides, ...(Object.keys(stateDiff).length && { [safe]: { stateDiff } }) },
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
  return { result, executed, before, after: result.status === 'success' ? config(results.slice(1).map(r => r.status === 'success' ? r.returnData as Hex : undefined)) : undefined, ...(priced && { priced }), requests, ...(signedByPasskey && { passkey: signedByPasskey }) };
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
  const setup = setupOf(initCode);
  return setup && { owners: setup.owners, threshold: setup.threshold, fallbackHandler: setup.fallbackHandler };
}
/** safeSetupOf, with the singleton the factory is given and the call the setup delegatecalls (`to`, `data`). */
function setupOf(initCode: string): { owners: string[]; threshold: bigint; fallbackHandler: string; singleton: string; to: string; data: Hex } | null {
  if (initCode.length < 42 + 8) return null;
  try {
    const call = decodeFunctionData({ abi: SAFE_FACTORY, data: `0x${initCode.slice(42)}` as Hex });
    const setup = decodeFunctionData({ abi: SAFE_SETUP, data: call.args[1] });
    const [owners, threshold, to, data, fallbackHandler] = setup.args;
    return { owners: owners.map(o => o.toLowerCase()), threshold, fallbackHandler: fallbackHandler.toLowerCase(), singleton: call.args[0].toLowerCase(), to: to.toLowerCase(), data };
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
