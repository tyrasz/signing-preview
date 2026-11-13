// ZeroDev Kernel v3's Enable message (EIP-712, domain "Kernel"): what an account's owner (its root validator) signs to
// install another validator, or a permission (a signer with policies: a session key, mostly a dApp's), on the account,
// with the account function it may use and an execution hook. Kernel checks it in enable mode, an operation whose
// nonce's first byte is 0x01, which carries it in its signature, and then installs what it names (ValidationManager's
// _enableMode, the same in v3.0 to v3.3, verified source on Sourcify):
//   Enable(bytes21 validationId,uint32 nonce,address hook,bytes validatorData,bytes hookData,bytes selectorData)
//   (ENABLE_TYPE_HASH 0xb17ab1224aca0d4255ef8161acaf2ac121b8faa32a4b2258c912cc5f8308c505), domain { name "Kernel",
//   version "0.3.0-beta" | "0.3.1" | "0.3.2" | "0.3.3", chainId (0 for v3.2's and v3.3's chain-agnostic signatures),
//   verifyingContract: the account }.
// - validationId: 0x01 and a validator's address, or 0x02, a permission's 4-byte id and 16 zero bytes.
// - nonce: the account's currentNonce() (v3.3: one more when that validation is installed at it already).
// - hook: address(0) for none, else the execution hook that runs around each of its operations (hookData installs it).
// - validatorData: a validator's onInstall data; a permission's is abi.encode(bytes[]): each policy, then the signer,
//   as a 2-byte flag (0x0001: not for operations, 0x0002: not for signatures), the module's address and its own data.
// - selectorData: the account function the validation may be used for (its first 4 bytes); with 44 bytes or more, the
//   module that handles that function (by call or delegatecall) and its hook are installed too.
// Once installed, the validation sends operations for the account (within its policies and function) and, unless a
// flag or policy stops it, signs for it as ERC-1271 signatures: what this preview spells out.
import { decodeAbiParameters, decodeFunctionResult, encodeFunctionData, parseAbi, parseAbiItem, toFunctionSelector, toFunctionSignature, type AbiFunction, type Hex } from 'viem';
import { formatDuration, formatTimestamp, formatUnits, PreviewBuilder, sameAddress, shortAddress } from '../format.ts';
import { CHAINS, chainName } from '../chains.ts';
import { COMMON_SIGNATURES } from '../abi.ts';
import type { TokenInfo } from '../types.ts';
import { big, domainChainId, str, type TypedAdapter, type TypedDecoded, type TypedEnv } from './common.ts';

/** Kernel's Enable type, field by field, as its ValidationManager hashes it. */
export const KERNEL_ENABLE_FIELDS = [['validationId', 'bytes21'], ['nonce', 'uint32'], ['hook', 'address'], ['validatorData', 'bytes'], ['hookData', 'bytes'], ['selectorData', 'bytes']] as const;
/** Each Kernel v3's EIP-712 version (_domainNameAndVersion, verified source). */
const DOMAIN_VERSIONS: Record<string, string> = { '0.3.0-beta': 'Kernel v3.0', '0.3.1': 'Kernel v3.1', '0.3.2': 'Kernel v3.2', '0.3.3': 'Kernel v3.3' };
const VERSION_ORDER = Object.keys(DOMAIN_VERSIONS);
/** Kernel v3's implementations (ZeroDev's SDK, each checked on Sourcify), by their EIP-712 version. v3.3's is also an EIP-7702 delegate. */
export const KERNEL_V3_IMPLEMENTATIONS: Record<string, string> = {
  '0x94f097e1ebeb4eca3aae54cabb08905b239a7d27': '0.3.0-beta', '0xbac849bb641841b44e965fb01a4bf5f074f84b4d': '0.3.1',
  '0xd830d15d3dc0c269f3dbaa0f3e8626d33cfdabe1': '0.3.2', '0xd6cedde84be40893d153be9d467cd6ad37875b28': '0.3.3',
};

type ValidatorKind = 'ecdsa' | 'webauthn' | 'weighted';
/** ZeroDev's validators (its SDK's constants, sources verified on Sourcify): what their install data holds. */
const VALIDATORS: Record<string, { name: string; kind: ValidatorKind }> = {
  '0x845adb2c711129d4f3966735ed98a9f09fc4ce57': { name: "ZeroDev's ECDSA validator", kind: 'ecdsa' },
  '0x8104e3ad430ea6d354d013a6789fdfc71e671c43': { name: "ZeroDev's ECDSA validator (Kernel v3.0)", kind: 'ecdsa' },
  '0x5c97aa67ba578e3c54ec5942a7563ea9130e4f5f': { name: "ZeroDev's multi-chain ECDSA validator", kind: 'ecdsa' },
  '0xd990393c670dcce8b4d8f858fb98c9912dbfaa06': { name: "ZeroDev's passkey (WebAuthn) validator 0.0.1", kind: 'webauthn' },
  '0xba45a2bfb8de3d24ca9d7f1b551e14dff5d690fd': { name: "ZeroDev's passkey (WebAuthn) validator 0.0.2", kind: 'webauthn' },
  '0x7ab16ff354acb328452f1d445b3ddee9a91e9e69': { name: "ZeroDev's passkey (WebAuthn) validator 0.0.3", kind: 'webauthn' },
  '0x56bf68a3eb0b95a4ec0880e5f39cf45cf58dae70': { name: "ZeroDev's multi-chain passkey validator", kind: 'webauthn' },
  '0xf98365fad8403c340b1d5f017b2ebdae641104ff': { name: "ZeroDev's multi-chain passkey validator 0.0.2", kind: 'webauthn' },
  '0xed89244160cfe273800b58b1b534031699dfeeee': { name: "ZeroDev's weighted ECDSA (guardian) validator", kind: 'weighted' },
};
type PolicyKind = 'sudo' | 'call' | 'timestamp' | 'gas' | 'rate-limit' | 'rate-limit-reset' | 'signature-caller' | 'erc20-transfer';
/** Policies whose sources were read (Sourcify; call policy 0.0.5, unpublished, as ZeroDev's SDK encodes it). */
const POLICIES: Record<string, { name: string; kind: PolicyKind; callVersion?: number }> = {
  '0x67b436cad8a6d025df6c82c5bb43fbf11fc5b9b7': { name: "ZeroDev's sudo policy", kind: 'sudo' },
  '0xe4fec84b7b002273ecc86baa65a831ddb92d30a8': { name: "ZeroDev's call policy 0.0.1", kind: 'call', callVersion: 1 },
  '0x67fa43ca2d689bea4d10b9f2c96828828a2ab275': { name: "ZeroDev's call policy 0.0.2", kind: 'call', callVersion: 2 },
  '0xb3cb5f502250360335614df1421f2aabe98ce503': { name: "ZeroDev's call policy 0.0.3", kind: 'call', callVersion: 3 },
  '0x9a52283276a0ec8740df50bf01b28a80d880eaf2': { name: "ZeroDev's call policy 0.0.4", kind: 'call', callVersion: 4 },
  '0x85770b902d1e503d5f5141d9eac16d0d08eeadd2': { name: "ZeroDev's call policy 0.0.5", kind: 'call', callVersion: 5 },
  '0xb9f8f524be6ecd8c945b1b87f9ae5c192fdce20f': { name: "ZeroDev's timestamp policy", kind: 'timestamp' },
  '0xaefc5abc67ffd258abd0a3e54f65e70326f84b23': { name: "ZeroDev's gas policy", kind: 'gas' },
  '0xf63d4139b25c836334edd76641356c6b74c86873': { name: "ZeroDev's rate-limit policy", kind: 'rate-limit' },
  '0x6a06358e6b283921deceabe7e8a3741d506cca9b': { name: "ZeroDev's rate-limit policy (with reset)", kind: 'rate-limit-reset' },
  '0xf6a936c88d97e6fad13b98d2fd731ff17eed591d': { name: "ZeroDev's signature-caller policy", kind: 'signature-caller' },
  '0x79da199e597868ebd29bf64ec92f8b9d52642bb7': { name: "Bleap's ERC20TransferPolicyV2", kind: 'erc20-transfer' },
};
type SignerKind = 'ecdsa' | 'webauthn' | 'cosigning';
const SIGNERS: Record<string, { name: string; kind: SignerKind }> = {
  '0x6a6f069e2a08c2468e7724ab3250cdbfba14d4ff': { name: "ZeroDev's ECDSA signer", kind: 'ecdsa' },
  '0x8aa55d4bfae101609078681a69b5bc3181516612': { name: "ZeroDev's WebAuthn signer 0.0.1", kind: 'webauthn' },
  '0x58625164e306242c7613223bdeb68fbe11300606': { name: "ZeroDev's WebAuthn signer 0.0.2", kind: 'webauthn' },
  '0x615d8641b6ce9406de7c3c01f57c552ab3a96f83': { name: "ZeroDev's WebAuthn signer 0.0.3", kind: 'webauthn' },
  '0x65deec8fee717dc044d0cfd63ccf55f02ccac2b3': { name: "ZeroDev's WebAuthn signer 0.0.4", kind: 'webauthn' },
  '0x5b424d5133fae2ce64ce739cec0796343e957131': { name: "Bleap's CosigningModuleV2", kind: 'cosigning' },
};
/**
 * ZeroDev's recovery action (named in its SDK, @zerodev/weighted-ecdsa-validator; unverified). Its deployed code, the
 * same on Ethereum, Base, Arbitrum One, BNB Chain and Polygon, has one function, doRecovery(address validator, bytes
 * data) (0xac39fd0f), which calls validator.onUninstall("") and then validator.onInstall(data): run by delegatecall, as
 * the account, it re-installs any of the account's validators with new data, such as its owner's key.
 */
const RECOVERY_ACTION = '0xe884c2868cc82c16177ec73a93f7d9e6f3a5dc6e';
/** Modules named in ZeroDev's SDK whose sources aren't published: named only, never taken to limit anything. */
const NAMED_ONLY: Record<string, string> = {
  '0xb230f0a1c7c95fa11001647383c8c7a8f316b900': "ZeroDev's only-EntryPoint hook (named in its SDK; its source isn't published)",
  [RECOVERY_ACTION]: "ZeroDev's recovery action (named in its SDK; its source isn't published: its code re-installs any validator of the account with new data)",
};
const RECOVERY_DANGER = "ZeroDev's recovery action re-installs any of your account's validators with new data (its code calls the validator's onUninstall, then onInstall with the data it is given), so it can replace your account's owner";
/**
 * Kernel v3's own functions an Enable can grant (its verified ABI); `control`: ones that hand over the account itself,
 * or (`lockout`) delete its owner's key, locking the owner out; `entryPointOnly`: only the EntryPoint may call it (a call
 * from the account itself fails); `since`: the first version that has it; `permissionOwner`: it reaches the owner only
 * when the account's root is a permission (see ownerFunction).
 */
type KernelFunction = { sig: string; text: string; runs?: boolean; control?: boolean; lockout?: boolean; entryPointOnly?: boolean; since?: string; permissionOwner?: boolean };
const KERNEL_FUNCTIONS: Record<string, KernelFunction> = {
  '0xe9ae5c53': { sig: 'execute(bytes32,bytes)', text: 'run calls from your account', runs: true },
  '0xd691c964': { sig: 'executeFromExecutor(bytes32,bytes)', text: 'run calls from your account', runs: true },
  // executeUserOp delegatecalls the account itself with the rest of the operation's callData, with the EntryPoint as
  // the caller: any of the account's functions, its admin functions included.
  '0x8dd7712f': { sig: 'executeUserOp((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes),bytes32)', text: "run any of your account's own functions, its settings included", runs: true, control: true, entryPointOnly: true },
  '0x9517e29f': { sig: 'installModule(uint256,address,bytes)', text: 'install modules on your account', control: true },
  '0x9198bdf5': { sig: 'installValidations(bytes21[],(uint32,address)[],bytes[],bytes[])', text: 'install other keys on your account', control: true },
  '0x52141cd9': { sig: 'changeRootValidator(bytes21,address,bytes,bytes)', text: "replace your account's owner", control: true, since: '0.3.1' },
  '0x3659cfe6': { sig: 'upgradeTo(address)', text: "replace your account's code", control: true },
  '0xb9b82941': { sig: 'grantAccess(bytes21,bytes4,bool)', text: 'let keys use other functions of your account', control: true, since: '0.3.3' },
  // Shown live on v3.1 to v3.3 (a session key granted it, on real accounts): a hook-type uninstall (4) calls any module's
  // onUninstall as the account, the root validator's included, and a validator-type one (1) any module's but the root
  // validator's, a permission root's signer included: the owner's key deleted, its operations refused (AA24) after.
  '0xa71763a8': { sig: 'uninstallModule(uint256,address,bytes)', text: "remove modules from your account, your owner's key included", control: true, lockout: true },
  // Kernel refuses to uninstall the root validation itself (RootValidatorCannotBeRemoved), but calls onUninstall on any
  // other module named as a validator (0x01 and its address), installed or not, as the account: a root permission's
  // signer, named so with the permission's id as its data, deletes the owner's key (shown live on v3.1 to v3.3, Bleap's
  // cosigner and ZeroDev's ECDSA signer). A root validator can't be reached so.
  '0xe6f3d50a': { sig: 'uninstallValidation(bytes21,bytes,bytes)', text: "remove keys from your account, and your owner's key too if it is a permission rather than a validator", control: true, lockout: true, permissionOwner: true },
  // Shown live: it revokes every validation but the root (the key's own next operation refused, InvalidNonce); the owner's operations still run.
  '0x1f1b92e3': { sig: 'invalidateNonce(uint32)', text: "revoke your account's other keys" },
};
/**
 * What a function reaching the owner only through a root permission does on this account, when its root is read: with
 * a root validator, only other keys (Kernel won't uninstall it); with a root permission, the owner's key too.
 */
function ownerFunction(f: KernelFunction | undefined, state: AccountState | undefined): KernelFunction | undefined {
  if (!f?.permissionOwner || !state?.root) return f;
  if (state.root.startsWith('0x01')) return { ...f, control: false, lockout: false, text: "remove keys from your account other than its owner, a validator, which Kernel won't uninstall" };
  // An EIP-7702 account's owner is its own key, which no module holds (root 0): nothing to uninstall (checked live).
  if (/^0x0{42}/.test(state.root) && state.code === 'delegated') return { ...f, control: false, lockout: false, text: "remove keys from your account other than its owner, the account's own key, which no module holds" };
  if (state.root.startsWith('0x02')) return { ...f, text: "remove keys from your account, your owner's included: it is a permission, whose signer's key it can delete" };
  return f;
}
/** What a function that hands over the account, or locks its owner out, does: the end of its danger. */
const controlEnd = (f: KernelFunction) => (f.lockout ? 'that locks you out of the account and all it holds' : 'that hands over the account');
const EXECUTE = '0xe9ae5c53', EXECUTE_FROM_EXECUTOR = '0xd691c964';
/** Kernel's own function with this selector in this version (any version, when the domain names none Kernel has). */
function kernelFunction(selector: string, version: string, state?: AccountState) {
  const f = KERNEL_FUNCTIONS[selector];
  if (f?.since && VERSION_ORDER.includes(version) && VERSION_ORDER.indexOf(version) < VERSION_ORDER.indexOf(f.since)) return undefined;
  return ownerFunction(f, state);
}
const SKIP_USEROP = 0x0001, SKIP_SIGNATURE = 0x0002;
/** doRecovery(address,bytes), the one function of ZeroDev's recovery action. */
const DO_RECOVERY = '0xac39fd0f';
/** A module's onInstall(bytes) and onUninstall(bytes) (ERC-7579): what a module keeps for the account that calls it. */
const ON_INSTALL = '0x6d61fe70', MODULE_SETUP = new Set([ON_INSTALL, '0x8a91b0e3']);
const CONDITIONS = ['must be', 'must be more than', 'must be less than', 'must be at least', 'must be at most', 'must not be', 'must be one of'];
/** How many of a long list a preview spells out (calls, rules, values, callers, guardians, policies, token lookups). */
const LIST_MAX = 24, SHORT_LIST_MAX = 8;

/** Functions a call policy's selector is named from: ERC-20 and NFT approvals, then the previewer's common list. */
const FUNCTIONS = new Map<string, AbiFunction>();
for (const s of ['transfer(address to, uint256 amount)', 'approve(address spender, uint256 amount)', 'transferFrom(address from, address to, uint256 amount)', 'setApprovalForAll(address operator, bool approved)',
  'approve(address token, address spender, uint160 amount, uint48 expiration)', 'deposit()', 'withdraw(uint256 amount)',
  // ZeroDev's recovery action (its SDK's @zerodev/weighted-ecdsa-validator): what guardians call to replace the owner.
  'doRecovery(address _validator, bytes _data)', ...COMMON_SIGNATURES]) {
  try { const f = parseAbiItem(`function ${s}`) as AbiFunction; if (!FUNCTIONS.has(toFunctionSelector(f))) FUNCTIONS.set(toFunctionSelector(f), f); } catch { /* not a signature */ }
}

const isHex = (v: unknown): v is Hex => typeof v === 'string' && /^0x([0-9a-fA-F]{2})*$/.test(v);
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO = /^0x0{40}$/;
/** The first `max` of a list, then how many more. */
const listed = (items: string[], max = SHORT_LIST_MAX, sep = ', ', more = 'and') => `${items.slice(0, max).join(sep)}${items.length > max ? `${sep}${more} ${items.length - max} more` : ''}`;

/** A module entry of a permission's install data: its flag, address and own data. */
interface Entry { flag: number; module: string; data: Hex }
interface CallPermission { version: number; callType: string; target: string; selector: string; valueLimit: bigint; rules: { condition: number; offset: bigint; params: readonly Hex[] }[] }
/** What a grant lets its holder do, as read from the message. */
interface Reading {
  who: string;
  /** For operations: unlimited (any call), limited (to what's listed), unknown (a module decides), none (no operations). */
  scope: 'unlimited' | 'limited' | 'unknown' | 'none';
  /** What it is limited to, for the title ("3 allowed calls"). */
  headline: string | null;
  scopeText: string;
  /** For ERC-1271 signatures made as the account. */
  signing: 'unlimited' | 'limited' | 'unknown' | 'none';
  signingText: string;
  /** Time window for operations, if a policy sets one. */
  until: number | null;
  after: number | null;
  /** [code, text]: each said once per code (the first few in full). */
  danger: [string, string][];
  cautions: [string, string][];
  /** Unknown policies or hooks that are all that might limit an otherwise unlimited grant's operations. */
  unknownLimits?: string[];
  /** Something in it (a module, a handler) this previewer can't read. */
  partial?: boolean;
}

export const kernelEnableAdapter: TypedAdapter = async (data, env) => {
  if (data.primaryType !== 'Enable' || str(data.domain.name) !== 'Kernel') return null;
  const chainId = domainChainId(data);
  const network = chainId !== null && chainId !== 0 ? { kind: 'evm' as const, chainId, name: chainName(chainId) } : null;
  const b = new PreviewBuilder();
  const account = str(data.domain.verifyingContract).toLowerCase();
  try {
    return await describe(data.message, data.types, data.domain, account, chainId, env, b, network);
  } catch {
    // Something in it doesn't decode: the grant is still a grant, of something that can't be read.
    const fresh = new PreviewBuilder();
    if (ADDRESS.test(account)) fresh.detail('Account', account);
    if (chainId !== null) fresh.detail('Chain', chainId === 0 ? 'every chain (chain ID 0)' : chainName(chainId), String(chainId));
    // Danger: an Enable always grants something, and whoever made it chooses what can't be read (Kernel installs what
    // it reads, whatever this previewer can't), so an unreadable one may be the widest grant.
    fresh.warn('danger', 'kernel_enable_unreadable', `This is a ZeroDev Kernel Enable message: signing it installs a key or validator on ${ADDRESS.test(account) ? `the Kernel account ${account}` : 'a Kernel account'}, which can then act for the account. Its contents couldn't be read, so what that key could do can't be shown: it may be full control. Don't sign it unless you know what it grants.`);
    return { title: `Sign a Kernel Enable message for ${ADDRESS.test(account) ? shortAddress(account) : 'a Kernel account'} (contents unreadable)`, summary: 'A ZeroDev Kernel Enable message, which installs a key on the account; its contents could not be decoded.', decoder: 'kernel_enable', status: 'opaque', b: fresh, network };
  }
};

async function describe(m: Record<string, unknown>, types: Record<string, { name: string; type: string }[]>, domain: Record<string, unknown>, account: string, chainId: number | null, env: TypedEnv, b: PreviewBuilder, network: TypedDecoded['network']): Promise<TypedDecoded> {
  const vId = str(m.validationId).toLowerCase(), hook = str(m.hook).toLowerCase();
  const validatorData = m.validatorData, hookData = m.hookData, selectorData = m.selectorData;
  if (!/^0x[0-9a-f]{42}$/.test(vId) || !ADDRESS.test(hook) || !isHex(validatorData) || !isHex(hookData) || !isHex(selectorData) || !ADDRESS.test(account)) throw new Error('malformed Enable');
  if (selectorData.length < 10) throw new Error('selectorData shorter than a selector');
  const nonce = big(m.nonce);
  const version = str(domain.version);
  const native = chainId !== null ? CHAINS[chainId]?.nativeSymbol ?? 'ETH' : 'ETH';
  const rpc = chainId !== null && chainId !== 0 && env.deps.rpc?.has(chainId) ? env.deps.rpc : undefined;
  // The account's own handler for the function, when the message installs none and Kernel doesn't have it.
  const selector = selectorData.slice(0, 10).toLowerCase();
  const handlerOf = selectorData.length === 10 && !kernelFunction(selector, version) ? selector : undefined;
  const state = rpc ? await accountState(env, chainId!, account, vId, handlerOf) : undefined;

  // The type and domain Kernel hashes: anything else gives a digest no Kernel account accepts as an Enable.
  const fields = (types.Enable ?? []).map(f => `${f.name}:${f.type}`).join(',');
  if (fields !== KERNEL_ENABLE_FIELDS.map(([n, t]) => `${n}:${t}`).join(',')) b.warn('caution', 'kernel_enable_type_mismatch', "This Enable message's type isn't Kernel's own (Enable(bytes21 validationId,uint32 nonce,address hook,bytes validatorData,bytes hookData,bytes selectorData)): a Kernel account wouldn't accept this signature as an Enable, and what it does depends on the contract that checks it.");
  const domainFields = types.EIP712Domain?.map(f => f.name).join(',');
  if (domainFields !== undefined && domainFields !== 'name,version,chainId,verifyingContract') b.warn('caution', 'kernel_enable_domain_mismatch', `The signing domain names ${domainFields || 'no fields'}, not Kernel's name, version, chainId and verifyingContract: a Kernel account wouldn't accept this signature as it is.`);

  b.detail('Account', account === env.signer ? `${account} (yours)` : account);
  if (chainId !== null) b.detail('Chain', chainId === 0 ? 'every chain (chain ID 0)' : chainName(chainId), String(chainId));
  const known = DOMAIN_VERSIONS[version];
  b.detail('Kernel version', known ? `${version} (${known}, from the signing domain)` : `${version || 'none'} (not a Kernel v3 version this previewer knows)`);
  if (!known) b.note(`Kernel ${version || '(no version)'} isn't one of the versions checked here (0.3.0-beta to 0.3.3); the message was read as their Enable.`);

  // The validation: a validator, or a permission (policies, then a signer).
  const type = vId.slice(2, 4);
  let reading: Reading;
  if (type === '01') {
    const validator = `0x${vId.slice(4)}`;
    reading = readValidator(validator, validatorData, b);
  } else if (type === '02') {
    const pId = `0x${vId.slice(4, 12)}`;
    if (!/^0{32}$/.test(vId.slice(12))) b.warn('caution', 'kernel_enable_bad_id', `The permission's ID (${vId}) has bytes after its first four, which Kernel's own operations never carry: it may not be usable as signed.`);
    b.detail('Installs', `permission ${pId}`, vId);
    reading = await readPermission(validatorData, b, env, chainId, account, native, state);
  } else {
    b.detail('Installs', `validation ${vId} (type 0x${type}, which Kernel doesn't install)`);
    reading = { who: `validation ${vId.slice(0, 12)}…`, scope: 'unknown', headline: null, scopeText: 'act in a way that can\'t be read', signing: 'unknown', signingText: 'unknown', until: null, after: null, danger: [], cautions: [['kernel_enable_unknown_type', `The validation type 0x${type} isn't a validator (0x01) or a permission (0x02): Kernel refuses to install it, and what it would do can't be read.`]] };
  }

  // The account function it may be used for, and the module that handles it, if the message installs one.
  const fn = readSelector(selectorData, reading, b, version, state);
  // The execution hook: it runs around each of its operations, and may refuse them.
  if (/^0x0{39}[01]$/.test(hook)) b.detail('Hook', 'none');
  else {
    b.detail('Hook', `${NAMED_ONLY[hook] ?? `${hook} (unknown)`}${hookData.length > 2 ? `, installed with data ${hookData.length > 66 ? `${hookData.slice(0, 66)}…` : hookData}` : ''}`, hook);
    if (!NAMED_ONLY[hook]) {
      reading.partial = true;
      // An unknown hook can only refuse operations: what known policies allow, it can't widen.
      if (reading.scope === 'unlimited' || reading.unknownLimits) {
        reading.scope = 'unknown';
        (reading.unknownLimits ??= []).push(`the hook ${hook}`);
        if (reading.scopeText === 'send any transaction from your account') reading.scopeText = 'send any transaction from your account, unless a module this previewer can\'t read stops it';
      }
      reading.cautions.push(['kernel_enable_unknown_hook', `Its operations run through the hook ${hook}, which this previewer doesn't know: it may limit them, but no limit can be shown for it.`]);
    }
  }

  // What it may do, and until when.
  const window = reading.until !== null || reading.after !== null ? timeWindow(reading.after, reading.until) : '';
  b.detail('It can', `${reading.scopeText}${window && reading.scope !== 'none' ? `, ${window}` : ''}`);
  b.detail('Signs as your account (ERC-1271)', reading.signingText);
  if (nonce !== null) b.detail('Validation nonce', state?.expectedNonce !== undefined ? `${nonce} (the account's is ${state.expectedNonce})` : String(nonce));

  // Severity: grants that can send any transaction (or take the account over) are danger; others, caution with what they can do.
  const until = reading.until !== null && reading.until > 0 ? ` until ${formatTimestamp(reading.until * 1000)}` : '';
  const unlimited = reading.scope === 'unlimited' && fn.runs;
  // Only unknown modules (an unknown policy or hook) stand between it and any transaction: no limit can be shown.
  const unreadLimits = !unlimited && reading.scope === 'unknown' && !!reading.unknownLimits?.length && fn.runs;
  const inert = reading.scope === 'none' && reading.signing === 'none';
  if (unlimited) b.warn('danger', 'kernel_enable_unrestricted', `Whoever holds ${reading.who} can send any transaction from your account${until}, with no limit: move everything it holds, and change its settings. Only sign this for a key you control, or an app you trust with all of the account.`);
  if (unreadLimits) {
    const u = reading.unknownLimits!;
    b.warn('danger', 'kernel_enable_unrestricted', `Whoever holds ${reading.who} can send any transaction from your account${until}, unless ${u.slice(0, 3).join(' or ')}${u.length > 3 ? ` (or ${u.length - 3} more)` : ''}, which this previewer can't read, stops it: nothing it can read limits what it does. Only sign this for a key you control, or an app you trust with all of the account.`);
  }
  for (const [code, text] of grouped(reading.danger)) b.warn('danger', code, text);
  if (!unlimited && !unreadLimits && reading.scope !== 'none') {
    b.warn('caution', 'kernel_enable_grant', `Whoever holds ${reading.who} can ${reading.scope === 'limited' ? reading.scopeText : reading.scope === 'unlimited' ? fn.text : `act for your account within limits this previewer can't read (${reading.scopeText})`}${until}, without asking you again.`);
  }
  if (inert) b.warn('info', 'kernel_enable_inert', `Its flags and policies leave out both operations and signatures: as signed, ${reading.who} can do nothing with your account${reading.danger.length ? ' itself (what else it installs is flagged above)' : ''}.`);
  for (const [code, text] of grouped(reading.cautions)) b.warn('caution', code, text);
  if (reading.signing === 'unlimited' || reading.signing === 'unknown') {
    const limit = reading.signing === 'unknown' ? ', unless a policy this previewer can\'t read stops it' : type === '01' ? ', with no limit' : `, with no limit from its policies${reading.until !== null ? ' (its time limit covers only its operations)' : ''}`;
    b.warn('caution', 'kernel_enable_signs_for_account', `${capitalize(reading.who)} can also sign messages as your account (ERC-1271)${limit}: apps that accept your account's signature, such as token permits, Permit2 and orders, would accept one made with it, whatever the limits on its calls say.`);
  }
  if (reading.until !== null && reading.until > 0) {
    if (reading.until * 1000 < env.now) b.warn('info', 'kernel_enable_expired', `Its time limit ended at ${formatTimestamp(reading.until * 1000)}: it can no longer send operations${reading.signing === 'none' ? '' : ' (a time limit doesn\'t cover signatures)'}.`);
    else b.warn('info', 'kernel_enable_time_limit', `Its operations are limited in time: ${window}${reading.until * 1000 - env.now > 0 ? ` (${formatDuration(reading.until * 1000 - env.now)} from now)` : ''}.`);
  }

  // The domain: every chain, another chain, and the account itself.
  if (chainId === 0) b.warn('caution', 'kernel_enable_all_chains', 'It is signed with chain ID 0: Kernel v3.2 and later accept that as a grant on every chain where this account exists.');
  else if (chainId !== null && env.context.chainId && chainId !== env.context.chainId) b.warn('caution', 'chain_mismatch', `The signature is for ${chainName(chainId)}, but the wallet is on ${chainName(env.context.chainId)}.`);
  if (state) accountChecks(state, b, env, account, version, nonce);
  b.note('This is an off-chain signature: it costs nothing now. The key it installs sends it with its first operation from your account (Kernel\'s enable mode), which installs the key and runs that operation.');

  const title = inert ? `Install ${reading.who} on your Kernel account, ${reading.danger.length ? 'with a handler for one of its functions (the key itself can do nothing)' : 'able to do nothing (no operations, no signatures)'}`
    : reading.scope === 'none' ? `Let ${reading.who} sign for your Kernel account`
      : unlimited ? `Let ${reading.who} act for your Kernel account, without limits`
        : unreadLimits ? `Let ${reading.who} act for your Kernel account, with no limit this previewer can read`
          : reading.scope === 'limited' && reading.headline ? `Let ${reading.who} act for your Kernel account: ${reading.headline}`
            : `Let ${reading.who} act for your Kernel account`;
  const summary = `A ZeroDev Kernel Enable signature for ${account}${network ? ` on ${network.name}` : chainId === 0 ? ' on every chain' : ''}: it installs ${reading.who} on the account, which can then ${inert ? 'do nothing with it' : unlimited ? 'send any transaction from it' : unreadLimits ? 'send any transaction from it, unless a module this previewer can\'t read stops it' : reading.scope === 'none' ? 'sign for it' : reading.scopeText}${until}.`;
  const unknown = reading.scope === 'unknown' || reading.signing === 'unknown' || !!reading.partial;
  return { title, summary, decoder: 'kernel_enable', status: unknown || !known ? 'partial' : 'full', b, network };
}

/** Findings of one kind said once: the first three in full, then how many more. */
function grouped(items: [string, string][]): [string, string][] {
  const by = new Map<string, Set<string>>();
  for (const [code, text] of items) { if (!by.has(code)) by.set(code, new Set()); by.get(code)!.add(text); }
  return [...by].map(([code, set]) => { const texts = [...set]; return [code, `${texts.slice(0, 3).join(' ')}${texts.length > 3 ? ` And ${texts.length - 3} more like these.` : ''}`]; });
}

function capitalize(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1); }

function timeWindow(after: number | null, until: number | null): string {
  const from = after && after > 0 ? `from ${formatTimestamp(after * 1000)}` : '';
  const to = until && until > 0 ? `until ${formatTimestamp(until * 1000)}` : '';
  return [from, to].filter(Boolean).join(' ') || 'at any time';
}

/** A validator (type 0x01): one key, with no policies, used for operations and for signatures alike. */
function readValidator(validator: string, data: Hex, b: PreviewBuilder): Reading {
  const v = VALIDATORS[validator];
  b.detail('Installs', `validator ${v ? `${v.name} (${validator})` : `${validator} (unknown)`}`, validator);
  const reading: Reading = { who: `validator ${shortAddress(validator)}`, scope: 'unlimited', headline: null, scopeText: 'send any transaction from your account', signing: 'unlimited', signingText: 'yes: a validator signs for the account without limits', until: null, after: null, danger: [], cautions: [] };
  if (v?.kind === 'ecdsa' && data.length >= 42) {
    const key = `0x${data.slice(2, 42)}`;
    b.detail('Key', `${key} (an ordinary key: whoever holds it signs)`);
    reading.who = `key ${shortAddress(key)}`;
  } else if (v?.kind === 'webauthn') {
    const [key] = decodeAbiParameters([{ type: 'tuple', components: [{ name: 'x', type: 'uint256' }, { name: 'y', type: 'uint256' }] }, { type: 'bytes32' }], data);
    b.detail('Passkey', `P-256 public key x 0x${key.x.toString(16).padStart(64, '0')}, y 0x${key.y.toString(16).padStart(64, '0')}`);
    reading.who = 'a passkey';
  } else if (v?.kind === 'weighted') {
    const [guardians, weights, threshold, delay] = decodeAbiParameters([{ type: 'address[]' }, { type: 'uint24[]' }, { type: 'uint24' }, { type: 'uint48' }], data);
    const total = weights.reduce((a, w) => a + w, 0);
    guardians.slice(0, LIST_MAX).forEach((g, i) => b.detail(`Guardian ${i + 1}`, `${g.toLowerCase()} (weight ${weights[i] ?? '?'})`));
    if (guardians.length > LIST_MAX) b.detail('Guardians not listed', String(guardians.length - LIST_MAX));
    b.detail('Guardians needed', `weight ${threshold} of ${total}${delay ? `, ${formatDuration(delay * 1000)} after they agree` : ''}`);
    reading.who = guardians.length === 1 ? `guardian key ${shortAddress(guardians[0].toLowerCase())}` : `${guardians.length} guardian keys (together weight ${threshold} of ${total})`;
  } else {
    if (data.length > 2) b.detail('Validator data', data.length > 130 ? `${data.slice(0, 130)}…` : data);
    reading.who = `validator ${shortAddress(validator)}`;
    reading.partial = true;
    reading.cautions.push(['kernel_enable_unknown_validator', `The validator ${validator} isn't one this previewer knows: who holds the key it checks can't be shown.`]);
  }
  return reading;
}

/** A permission (type 0x02): abi.encode(bytes[]), each policy and then the signer (2-byte flag, address, data). */
async function readPermission(data: Hex, b: PreviewBuilder, env: TypedEnv, chainId: number | null, account: string, native: string, state: AccountState | undefined): Promise<Reading> {
  const [items] = decodeAbiParameters([{ type: 'bytes[]' }], data);
  if (!items.length) throw new Error('a permission with no signer');
  const entries: Entry[] = items.map(it => {
    if (it.length < 2 + 44) throw new Error('a permission entry too short');
    return { flag: Number.parseInt(it.slice(2, 6), 16), module: `0x${it.slice(6, 46)}`.toLowerCase(), data: `0x${it.slice(46)}` as Hex };
  });
  const signer = entries[entries.length - 1], policies = entries.slice(0, -1);
  const reading: Reading = { who: '', scope: 'unlimited', headline: null, scopeText: 'send any transaction from your account', signing: 'unlimited', signingText: '', until: null, after: null, danger: [], cautions: [] };
  // _installPermission: at most 254 entries, the signer included.
  if (entries.length > 254) reading.cautions.push(['kernel_enable_too_many', `It lists ${entries.length} policies and signers: Kernel installs at most 254 (PolicyDataTooLarge), so it can't be installed as signed.`]);

  // The signer: who holds the key.
  const s = SIGNERS[signer.module];
  if (s?.kind === 'ecdsa' && signer.data.length >= 42) {
    const key = `0x${signer.data.slice(2, 42)}`;
    b.detail('Session key', `${key} (an ordinary key, checked by ${s.name})`, key);
    reading.who = `session key ${shortAddress(key)}`;
  } else if (s?.kind === 'webauthn') {
    const [key] = decodeAbiParameters([{ type: 'tuple', components: [{ name: 'x', type: 'uint256' }, { name: 'y', type: 'uint256' }] }, { type: 'bytes32' }], signer.data);
    b.detail('Passkey', `P-256 public key x 0x${key.x.toString(16).padStart(64, '0')}, y 0x${key.y.toString(16).padStart(64, '0')} (checked by ${s.name})`);
    reading.who = 'a passkey';
  } else if (s?.kind === 'cosigning') {
    const key = decodeAbiParameters([{ type: 'address' }], signer.data)[0].toLowerCase();
    b.detail('Session key', `${key}, together with Bleap's cosigner (both sign; ${s.name})`, key);
    reading.who = `key ${shortAddress(key)} with Bleap's cosigner`;
  } else {
    b.detail('Signer', `${signer.module} (unknown)${signer.data.length > 2 ? `, with data ${signer.data.length > 130 ? `${signer.data.slice(0, 130)}…` : signer.data}` : ''}`, signer.module);
    reading.who = `the signer ${shortAddress(signer.module)}`;
    reading.partial = true;
    reading.cautions.push(['kernel_enable_unknown_signer', `The signer ${signer.module} isn't one this previewer knows: who holds the key it checks can't be shown.`]);
  }
  const forOps = !(signer.flag & SKIP_USEROP), forSigs = !(signer.flag & SKIP_SIGNATURE);

  // The policies: each must pass, for operations unless its flag skips them, for signatures likewise. An unknown one
  // can only refuse more: what the known ones allow is the most the key can do.
  const limits: string[] = [];
  const signingLimits: string[] = [];
  const unknownOps: string[] = [], unknownSigs: string[] = [];
  let signingBlocked = false;
  let calls: CallPermission[] | null = null;
  for (const [i, p] of policies.entries()) {
    const known = POLICIES[p.module];
    const ops = !(p.flag & SKIP_USEROP), sigs = !(p.flag & SKIP_SIGNATURE);
    const applies = ops && sigs ? '' : ops ? ' (operations only)' : sigs ? ' (signatures only)' : ' (checked for neither operations nor signatures)';
    const label = `Policy ${i + 1}`;
    // Each policy is read; past the first LIST_MAX, it isn't listed as a detail of its own.
    const detail = (value: string, raw?: string) => { if (i < LIST_MAX) b.detail(label, value, raw); };
    if (!known) {
      detail(`${p.module} (unknown)${applies}${p.data.length > 2 ? `, with data ${p.data.length > 130 ? `${p.data.slice(0, 130)}…` : p.data}` : ''}`, p.module);
      reading.partial = true;
      reading.cautions.push(['kernel_enable_unknown_policy', `The policy ${p.module} isn't one this previewer knows: whatever it limits can't be shown, so don't count on a limit from it.`]);
      if (ops) unknownOps.push(`the policy ${p.module}`);
      if (sigs) unknownSigs.push(`the policy ${p.module}`);
      continue;
    }
    switch (known.kind) {
      case 'sudo':
        detail(`${known.name}: no limits${applies}`, p.module);
        break;
      case 'call': {
        const perms = decodeCallPolicy(p.data, known.callVersion!);
        detail(`${known.name}: only the ${perms.length === 1 ? 'call' : `${perms.length} calls`} listed below${applies}`, p.module);
        if (ops) { if (calls) b.note('It has more than one call policy: a call must be allowed by each of them, so it can make only the calls listed under every one.'); calls = [...(calls ?? []), ...perms]; limits.push('call'); }
        break;
      }
      case 'timestamp': {
        const [after, until] = decodeAbiParameters([{ type: 'uint48' }, { type: 'uint48' }], p.data);
        detail(`${known.name}: operations ${timeWindow(after, until)}${applies}`, p.module);
        if (ops) {
          if (until > 0) reading.until = reading.until === null ? until : Math.min(reading.until, until);
          if (after > 0) reading.after = reading.after === null ? after : Math.max(reading.after, after);
        }
        break;
      }
      case 'gas': {
        const [allowed, enforce, paymaster] = decodeAbiParameters([{ type: 'uint128' }, { type: 'bool' }, { type: 'address' }], p.data);
        const cap = allowed === (1n << 128n) - 1n ? 'any amount of gas' : `at most ${formatUnits(allowed, 18)} ${native} in gas, in total`;
        detail(`${known.name}: ${cap}${enforce && !ZERO.test(paymaster) ? `, paid by paymaster ${paymaster.toLowerCase()} only` : ''}${applies}`, p.module);
        break;
      }
      case 'rate-limit': {
        if (p.data.length < 2 + 36) throw new Error('rate limit data too short');
        const interval = Number.parseInt(p.data.slice(2, 14), 16), count = Number.parseInt(p.data.slice(14, 26), 16), start = Number.parseInt(p.data.slice(26, 38), 16);
        // RateLimitPolicy: `count` operations in all, each at least `interval` after the one before, the first from `start`.
        const text = count === 1 ? `one operation only${start ? `, from ${formatTimestamp(start * 1000)}` : ''}` : `at most ${count} operations in all${interval ? `, one per ${formatDuration(interval * 1000)}` : ''}${start ? `, from ${formatTimestamp(start * 1000)}` : ''}`;
        detail(`${known.name}: ${text}${applies}`, p.module);
        break;
      }
      case 'rate-limit-reset': {
        if (p.data.length < 2 + 24) throw new Error('rate limit data too short');
        const interval = Number.parseInt(p.data.slice(2, 14), 16), count = Number.parseInt(p.data.slice(14, 26), 16);
        detail(`${known.name}: at most ${count} operation${count === 1 ? '' : 's'} every ${interval ? formatDuration(interval * 1000) : '0 seconds (no real limit)'}${applies}`, p.module);
        break;
      }
      case 'signature-caller': {
        const [callers] = decodeAbiParameters([{ type: 'address[]' }], p.data);
        const list = callers.map(c => c.toLowerCase());
        detail(`${known.name}: ${list.length ? `its signatures are accepted only by ${listed(list)}` : 'its signatures are accepted by no one'}${applies}`, p.module);
        if (sigs) { if (list.length) signingLimits.push(`only when ${listed(list)} check${list.length === 1 ? 's' : ''} it`); else signingBlocked = true; }
        break;
      }
      case 'erc20-transfer': {
        const to = decodeAbiParameters([{ type: 'address' }], p.data)[0].toLowerCase();
        detail(`${known.name}: only token transfers (ERC-20 transfer) to ${to}, any token and amount; no ${native}, no calls to the account, no signatures${applies}`, p.module);
        if (ops) { limits.push(`send any of its ERC-20 tokens, in any amount, to ${to} only`); reading.headline = `token transfers to ${shortAddress(to)} only`; }
        if (sigs) signingBlocked = true;
        break;
      }
    }
  }
  if (policies.length > LIST_MAX) b.detail('Policies not listed', String(policies.length - LIST_MAX));

  // What its operations can be: the call policies (all must pass: each lists what it allows), other known limits, or
  // only unknown modules.
  if (!forOps) { reading.scope = 'none'; reading.scopeText = 'sign for your account only (no operations)'; }
  else if (calls) {
    const lines = await describeCalls(calls, b, env, chainId, account, native, reading, state);
    reading.headline = `${calls.length} allowed call${calls.length === 1 ? '' : 's'}`;
    reading.scope = 'limited';
    reading.scopeText = `make only these calls from your account: ${lines.slice(0, 3).join('; ')}${lines.length > 3 ? `; and ${lines.length - 3} more (listed)` : ''}`;
  } else if (limits.length) {
    reading.scope = 'limited';
    reading.scopeText = limits.join('; ');
  } else if (unknownOps.length) {
    reading.scope = 'unknown';
    reading.unknownLimits = [...unknownOps];
    reading.scopeText = 'send any transaction from your account, unless a policy this previewer can\'t read stops it';
  }
  reading.signing = !forSigs || signingBlocked ? 'none' : signingLimits.length ? 'limited' : unknownSigs.length ? 'unknown' : 'unlimited';
  reading.signingText = reading.signing === 'none' ? 'no' : reading.signing === 'limited' ? `yes, ${signingLimits.join('; ')}` : reading.signing === 'unknown' ? 'yes, unless an unknown policy stops it' : 'yes, without limit';
  if (reading.scope === 'none' && reading.signing === 'none') reading.scopeText = 'nothing: no operations and no signatures';
  return reading;
}

function decodeCallPolicy(data: Hex, version: number): CallPermission[] {
  // 0.0.1 keeps one bytes32 per rule; 0.0.2 on, a bytes32[] (ONE_OF; 0.0.5's SLICE_EQUAL: start, length, hash).
  const rule = version === 1 ? { name: 'params', type: 'bytes32' } : { name: 'params', type: 'bytes32[]' };
  const [perms] = decodeAbiParameters([{ type: 'tuple[]', components: [{ name: 'callType', type: 'bytes1' }, { name: 'target', type: 'address' }, { name: 'selector', type: 'bytes4' }, { name: 'valueLimit', type: 'uint256' }, { name: 'rules', type: 'tuple[]', components: [{ name: 'condition', type: 'uint8' }, { name: 'offset', type: 'uint64' }, rule] }] }], data) as unknown as [readonly { callType: Hex; target: string; selector: Hex; valueLimit: bigint; rules: readonly { condition: number; offset: bigint; params: Hex | readonly Hex[] }[] }[]];
  return perms.map(p => ({ version, callType: p.callType.toLowerCase(), target: p.target.toLowerCase(), selector: p.selector.toLowerCase(), valueLimit: p.valueLimit, rules: p.rules.map(r => ({ condition: r.condition, offset: r.offset, params: typeof r.params === 'string' ? [r.params] : r.params })) }));
}

/** Each allowed call, as a detail ("Allowed call 1"), and short lines for the warning. */
async function describeCalls(calls: CallPermission[], b: PreviewBuilder, env: TypedEnv, chainId: number | null, account: string, native: string, reading: Reading, state: AccountState | undefined): Promise<string[]> {
  const lines: string[] = [];
  const tokens = new Map<string, TokenInfo | undefined>();
  const abis = new Map<string, AbiFunction[] | undefined>();
  for (const [i, c] of calls.entries()) {
    // Target 0 is any contract (and selector 0 a plain transfer) from call policy 0.0.2 on; 0.0.1 matches them as they are.
    const zeroTarget = ZERO.test(c.target), wildcard = zeroTarget && c.version >= 2;
    const plain = c.selector === '0x00000000';
    if (!tokens.has(c.target) && chainId !== null && !zeroTarget && tokens.size < LIST_MAX) { try { tokens.set(c.target, (await env.deps.tokens?.get(chainId, c.target)) ?? undefined); } catch { tokens.set(c.target, undefined); } }
    const token = tokens.get(c.target);
    // The function: the target's verified ABI where there is one, else the built-in list.
    if (!abis.has(c.target) && chainId !== null && env.deps.abis && !zeroTarget && abis.size < SHORT_LIST_MAX) {
      try { const r = await env.deps.abis.resolve(chainId, c.target); abis.set(c.target, r?.verified ? (r.abi as AbiFunction[]).filter(x => x.type === 'function') : undefined); } catch { abis.set(c.target, undefined); }
    }
    const self = sameAddress(c.target, account);
    // A call the account makes to itself (its own address, or any contract) reaches Kernel's own functions.
    const kernelFn = (self || wildcard) && !plain ? ownerFunction(KERNEL_FUNCTIONS[c.selector], state) : undefined;
    const fn = kernelFn ? undefined : abis.get(c.target)?.find(f => { try { return toFunctionSelector(f) === c.selector; } catch { return false; } }) ?? FUNCTIONS.get(c.selector);
    const name = plain ? (c.version >= 2 ? `plain ${native} transfers (no function)` : `calls whose data starts 0x00000000 (call policy 0.0.1 refuses plain ${native} transfers)`)
      : kernelFn ? `${self ? 'your account\'s own ' : ''}${kernelFn.sig} (${self ? '' : 'Kernel\'s: '}${kernelFn.entryPointOnly ? 'only the EntryPoint may call it, so a call from your account fails' : kernelFn.text})`
        : fn ? toFunctionSignature(fn) : `function ${c.selector} (unknown)`;
    const where = wildcard ? (plain ? 'any address' : 'any contract') : zeroTarget ? 'the zero address (call policy 0.0.1 has no "any contract")' : self ? 'your account' : token ? `${token.symbol} (${c.target})` : c.target;
    const ruleTexts = c.rules.map(r => ruleText(r, fn, token, account));
    const rules = ruleTexts.map(r => r.text);
    const shownRules = rules.length > SHORT_LIST_MAX ? [...rules.slice(0, SHORT_LIST_MAX), `and ${rules.length - SHORT_LIST_MAX} more rules`] : rules;
    const value = c.valueLimit === 0n ? `no ${native}` : c.valueLimit >= (1n << 255n) ? `any amount of ${native}` : `up to ${formatUnits(c.valueLimit, CHAINS[chainId ?? 1]?.nativeDecimals ?? 18)} ${native} per call`;
    const how = c.callType === '0xff' ? 'delegatecall' : c.callType === '0x00' ? '' : `call type ${c.callType}`;
    const text = `${name}${self ? '' : ` on ${where}`}${how ? `, by ${how}` : ''}${rules.length ? `: ${shownRules.join(', ')}` : ', any arguments'}; ${value}`;
    if (i < LIST_MAX) b.detail(`Allowed call ${i + 1}`, text);
    lines.push(self ? name.split(' (')[0] : `${fn ? fn.name : name.split(' (')[0]} on ${where}`);
    const fnName = kernelFn ? kernelFn.sig : fn ? toFunctionSignature(fn) : `function ${c.selector}`;
    if (c.callType === '0xff') reading.danger.push(['kernel_enable_takeover', `It may delegatecall ${wildcard ? 'any contract' : c.target}: that code runs as your account itself, so it can do anything with the account and all it holds.`]);
    // The account's own functions, reached by a call to itself: the call policy checks only that outer call.
    const viaAny = wildcard ? ' (allowed on any contract, so on your account too)' : '';
    if (kernelFn?.control && !kernelFn.entryPointOnly) reading.danger.push(['kernel_enable_takeover', `It may call your account's own ${kernelFn.sig}${viaAny}, which lets it ${kernelFn.text}: ${controlEnd(kernelFn)}.`]);
    else if (kernelFn && c.selector === EXECUTE) reading.danger.push(['kernel_enable_takeover', `It may have your account call its own ${kernelFn.sig}${viaAny}, which runs any calls packed inside it: the call policy checks only that outer call, so it can send any transaction from your account.`]);
    else if (kernelFn && c.selector === EXECUTE_FROM_EXECUTOR) reading.danger.push(['kernel_enable_takeover', `It may have your account call ${kernelFn.sig}${wildcard ? ' on any contract, its own included' : ' on itself'}, which runs the calls packed inside it for an executor of that account: the call policy checks only that outer call, not the calls inside.`]);
    // A module's onInstall or onUninstall, called by your account: modules keep each account's settings under the
    // account's address, so the account calling them on its validator or signer replaces (or deletes) its key.
    else if (MODULE_SETUP.has(c.selector)) reading.danger.push(['kernel_enable_takeover', `It may have your account call ${c.selector === ON_INSTALL ? 'onInstall' : 'onUninstall'} on ${wildcard ? 'any contract' : c.target}: modules keep each account's settings under the account's address, so your account calling a validator's or signer's onUninstall and onInstall replaces its key, your owner's included.`]);
    else if (wildcard && !plain) reading.cautions.push(['kernel_enable_any_contract', `It may call ${fnName} on any contract${rules.length ? '' : ', with any arguments'}: for a token function, that is every token your account holds.`]);
    // A plain transfer to any address, its limit per call: as many calls as its other policies allow.
    if (wildcard && plain && c.valueLimit > 0n) reading.cautions.push(['kernel_enable_any_address_value', `It may send ${c.valueLimit >= (1n << 255n) ? `any amount of ${native}` : `up to ${formatUnits(c.valueLimit, CHAINS[chainId ?? 1]?.nativeDecimals ?? 18)} ${native}`} to any address in each call, with no limit on how many calls (beyond its other policies): all the ${native} your account holds.`]);
    for (const r of ruleTexts) if (r.ignored) reading.cautions.push(['kernel_enable_rule_ignored', `A rule on ${fnName} checks the word at byte ${r.offset} of its arguments, past the ${r.words} ${r.words === 1 ? 'word' : 'words'} it reads: the function ignores data after its arguments, so whoever holds the key adds whatever passes the rule, and it limits nothing.`]);
  }
  if (calls.length > LIST_MAX) b.detail('Allowed calls not listed', String(calls.length - LIST_MAX));
  return lines;
}

/** One argument rule: the 32-byte word at `offset` after the selector, compared as CallPolicy does. */
function ruleText(r: CallPermission['rules'][number], fn: AbiFunction | undefined, token: TokenInfo | undefined, account: string): { text: string; ignored: boolean; offset: bigint; words: number } {
  const index = r.offset % 32n === 0n ? Number(r.offset / 32n) : null;
  const words = fn ? headWords(fn.inputs) : undefined;
  // A function whose arguments are all one word each reads only those: a rule past them checks data it ignores.
  const ignored = !!words && words.every(w => w.type) && r.offset >= BigInt(words.length * 32);
  const input = index !== null ? words?.[index] : undefined;
  const arg = ignored ? `the word at byte ${r.offset}, past its arguments (it limits nothing)` : input ? input.name : index !== null ? (words ? `word ${index + 1} of its arguments` : `argument ${index + 1}`) : `the word at byte ${r.offset} of its arguments`;
  const out = { ignored, offset: r.offset, words: words?.length ?? 0 };
  if (r.condition === 7) {
    // SLICE_EQUAL (call policy 0.0.5, as ZeroDev's SDK encodes it): bytes [start, start + length) of a bytes or string argument hash to the value.
    const start = r.params[0] ? BigInt(r.params[0]) : 0n, length = r.params[1] ? BigInt(r.params[1]) : 0n;
    return { ...out, text: `bytes ${start} to ${start + length} of ${arg.replace(' (where its data starts)', '')} must equal a fixed value (keccak256 ${r.params[2] ?? '?'})` };
  }
  const values = r.params.slice(0, SHORT_LIST_MAX).map(p => wordText(p, input?.type, token, input?.name, account));
  if (r.params.length > SHORT_LIST_MAX) values.push(`one of ${r.params.length - SHORT_LIST_MAX} more`);
  const cond = CONDITIONS[r.condition] ?? `(condition ${r.condition})`;
  return { ...out, text: `${arg} ${cond} ${r.condition === 6 ? values.join(' or ') : values[0] ?? '?'}` };
}

type Param = { name?: string; type: string; components?: readonly Param[] };
/**
 * The words of a call's head, named: one per one-word argument, a static tuple's fields inline; a dynamic argument's
 * word is where its data starts, and the words after the head (its data) aren't named.
 */
function headWords(inputs: readonly Param[], prefix = ''): { name: string; type?: string }[] | undefined {
  const out: { name: string; type?: string }[] = [];
  for (const [i, p] of inputs.entries()) {
    const name = `${prefix}${p.name || `argument ${i + 1}`}`;
    if (/^(address|bool|u?int\d*|bytes([1-9]|[12]\d|3[0-2]))$/.test(p.type)) out.push({ name, type: p.type });
    else if (p.type === 'tuple' && p.components) {
      const inner = staticTuple(p.components) ? headWords(p.components, `${name}.`) : undefined;
      if (inner) out.push(...inner); else out.push({ name: `${name} (where its data starts)` });
    } else out.push({ name: `${name} (where its data starts)` });
  }
  return out;
}
const staticTuple = (c: readonly Param[]): boolean => c.every(p => /^(address|bool|u?int\d*|bytes([1-9]|[12]\d|3[0-2]))$/.test(p.type) || (p.type === 'tuple' && !!p.components && staticTuple(p.components)));

function wordText(w: Hex, type: string | undefined, token: TokenInfo | undefined, name: string | undefined, account: string): string {
  const v = BigInt(w);
  const asAddress = `0x${w.slice(26)}`.toLowerCase();
  // (The call policy compares the whole word: one no address or bool has matches nothing of that type.)
  if (type === 'address' && v >= 1n << 160n) return `${w} (not an address: no address matches it)`;
  if (type === 'bool' && v > 1n) return `${w} (not a bool: neither true nor false matches it)`;
  if (type === 'address' || (type === undefined && v >= 1n << 64n && v < 1n << 160n)) return sameAddress(asAddress, account) ? `${asAddress} (your account)` : asAddress;
  if (type === 'bool') return v === 0n ? 'false' : 'true';
  if (token && type?.startsWith('uint') && /amount|value|wad/i.test(name ?? '')) return `${formatUnits(v, token.decimals)} ${token.symbol}`;
  return v < 1n << 128n ? v.toString() : w;
}

/** A handler's name: a module this previewer names, or its address. */
const handlerName = (module: string) => (NAMED_ONLY[module] ? `${NAMED_ONLY[module].split(' (')[0]} (${module})` : module);

/** The function the validation may be used for (selectorData[0:4]), and the module this installs for it (44 bytes on). */
function readSelector(selectorData: Hex, reading: Reading, b: PreviewBuilder, version: string, state: AccountState | undefined): { runs: boolean; text: string } {
  const selector = selectorData.slice(0, 10).toLowerCase();
  const own = kernelFunction(selector, version, state);
  const fn = FUNCTIONS.get(selector);
  const named = own ? `${own.sig}: ${own.text}` : fn ? `${toFunctionSignature(fn)} (not one of Kernel's own)` : `${selector} (not one of Kernel's own)`;
  const label = fn && !own ? `${toFunctionSignature(fn)} (${selector})` : selector;
  b.detail('Account function it may use', named, selector);
  // What the grant reads as when its function isn't one that runs calls: that function, and nothing else.
  const only = own ? `use only your account's own ${own.sig}, to ${own.text}` : `call only your account's function ${label}`;
  // A key that sends no operations (its flag) calls nothing: the function matters only for what is installed with it.
  if (own?.control && reading.scope !== 'none') reading.danger.push(['kernel_enable_takeover', `It may call your account's own ${own.sig}, which lets it ${own.text}: ${controlEnd(own)}.`]);
  const ownScope = () => { if (own && !own.runs && (reading.scope === 'unlimited' || reading.unknownLimits)) reading.scopeText = only; };
  if (selectorData.length === 10) {
    if (own) ownScope();
    else existingHandler(selector, label, only, reading, b, state);
    return { runs: !!own?.runs, text: only };
  }
  if (selectorData.length < 2 + 88) throw new Error('selectorData between 4 and 44 bytes');
  const module = `0x${selectorData.slice(10, 50)}`.toLowerCase(), selectorHook = `0x${selectorData.slice(50, 90)}`.toLowerCase();
  // (Only the selector's init data, its first part, which is what Kernel reads the call type from: the hook's init
  // data after it can't make the grant unreadable.)
  const [init] = decodeAbiParameters([{ type: 'bytes' }], `0x${selectorData.slice(90)}`);
  const callType = init.slice(0, 4).toLowerCase();
  if (own && ZERO.test(module)) {
    // ZeroDev's SDK sends its own function with address 0 as the handler: Kernel's own function runs, and the fallback is never reached.
    ownScope();
    return { runs: !!own.runs, text: only };
  }
  // Kernel's fallback: a selector hook of 0 becomes "only the EntryPoint" in v3.1 and later, but "no hook" (anyone) in
  // v3.0; address(1) is no hook; any other hook is called with the caller and decides.
  const v30 = version === '0.3.0-beta' || !DOMAIN_VERSIONS[version];
  // 0xff..ff is what hook 0 becomes from v3.1 (only the EntryPoint may call it); given as such, Kernel also asks it
  // whether it is set up as it installs the hook, and an address with no code can't answer, so the install fails.
  const onlyEntryPoint = /^0xf{40}$/i.test(selectorHook) && !v30;
  const open = (!ZERO.test(selectorHook) && !onlyEntryPoint) || v30;
  const kernel30 = version === '0.3.0-beta' ? 'Kernel v3.0' : 'Kernel v3.0 (and maybe this version, which this previewer doesn\'t know)';
  const hookText = ZERO.test(selectorHook) ? (v30 ? `, with no hook (${kernel30} installs none for hook 0)` : '') : /^0x0{39}1$/.test(selectorHook) ? ', with no hook (address 1)'
    : onlyEntryPoint ? ', with hook 0xff…ff (only the EntryPoint may call it; but Kernel asks that address, which has no code, whether it is set up as it installs it, so the Enable fails)' : `, with hook ${selectorHook}`;
  const how = callType === '0xff' ? 'by delegatecall: as your account itself, so its code decides what it can do with the account' : callType === '0x00' ? 'by call' : `call type ${callType}`;
  b.detail('Installs a handler', `${NAMED_ONLY[module] ?? module} for ${own ? own.sig : selector}, run ${how}${hookText}${own ? ' (never reached: Kernel\'s own function answers that call)' : ''}`, module);
  if (!own) {
    reading.partial = true;
    // Who may call it: this key (when it can send operations), the owner, and with an open hook anyone.
    const lets = reading.scope === 'none' ? '' : `, and lets ${reading.who} call it`;
    if (reading.scope !== 'none') { reading.scope = 'unknown'; reading.unknownLimits = undefined; reading.scopeText = `${only}, which this installs, handled by ${handlerName(module)}`; }
    if (callType === '0xff') {
      // Its code runs as the account: an unknown one can do anything with it; the recovery action replaces its owner.
      if (module === RECOVERY_ACTION) reading.danger.push(['kernel_enable_recovery', `It installs ZeroDev's recovery action to handle your account's ${label}, run by delegatecall as your account itself${lets}: ${RECOVERY_DANGER}.`]);
      else reading.danger.push(['kernel_enable_delegatecall_handler', `It installs ${module} to handle your account's function ${label} by delegatecall, as your account itself${lets}: that code, which this previewer doesn't read, can do anything with the account and all it holds.`]);
    } else reading.cautions.push(['kernel_enable_handler', `It installs ${module} to handle your account's function ${label}${lets}: what it can then do is up to that contract's code, which this previewer doesn't read.`]);
    if (open) reading.danger.push(['kernel_enable_open_handler', `${ZERO.test(selectorHook) ? `${kernel30} installs a handler given no hook with none at all` : `The handler's hook is ${/^0x0{39}1$/.test(selectorHook) ? 'address 1, which is no hook' : `${selectorHook}${NAMED_ONLY[selectorHook] ? ` (${NAMED_ONLY[selectorHook].split(' (')[0]})` : ''}, which decides who may call`}`}: anyone${/^0x0{39}1$/.test(selectorHook) || ZERO.test(selectorHook) ? '' : ' that hook lets through'}${reading.scope === 'none' ? '' : `, not only ${reading.who},`} can call your account's ${label}${callType === '0xff' ? ' and run that code as your account' : ''}.`]);
  }
  // A handler installed by call is also made an executor when its isModuleType(2) says so: its own code decides.
  if (callType === '0x00') reading.danger.push(['kernel_enable_executor', `The handler ${module} is installed by call, which also makes it an executor of your account if it says it is one (its own code answers): an executor can run any call from the account, with no key.`]);
  return { runs: !!own?.runs, text: only };
}

/** A function this message installs no handler for: whatever handler the account has for it runs (Kernel's fallback). */
function existingHandler(selector: string, label: string, only: string, reading: Reading, b: PreviewBuilder, state: AccountState | undefined) {
  const scoped = (text: string) => { if (reading.scope !== 'none') { reading.scope = 'unknown'; reading.unknownLimits = undefined; reading.scopeText = `${only}, ${text}`; } };
  const h = state?.handler;
  if (state?.code === 'none') {
    reading.partial = true;
    scoped('which runs whatever handler the account is deployed with for it');
    reading.cautions.push(['kernel_enable_existing_handler', `It may call your account's function ${label}, which isn't one of Kernel's own: the account isn't deployed yet, so whatever handler its deployment installs for it runs, by call or by delegatecall (as your account itself).`]);
  } else if (!h) {
    reading.partial = true;
    scoped('which runs whatever handler your account has for it');
    // ZeroDev's recovery action's own function: accounts with guardian recovery have it as their handler for it.
    if (selector === DO_RECOVERY) reading.danger.push(['kernel_enable_recovery', `It may call your account's ${label}, the function of ZeroDev's recovery action, which guardian recovery installs by delegatecall: if your account has it, ${RECOVERY_DANGER}.`]);
    reading.cautions.push(['kernel_enable_existing_handler', `It may call your account's function ${label}, which isn't one of Kernel's own: Kernel hands that call to whatever handler the account has installed for it, which this previewer couldn't read. A handler run by delegatecall runs as your account itself, with all it holds.`]);
  } else if (ZERO.test(h.hook)) {
    scoped('which nothing handles on the account now');
    b.detail('Handler on the account', `none for ${selector} now`);
    reading.cautions.push(['kernel_enable_existing_handler', `It may call your account's function ${label}, which nothing handles on the account now: if a handler is installed for it later, ${reading.who} can call that handler.`]);
  } else {
    const delegate = h.callType === '0xff';
    b.detail('Handler on the account', `${NAMED_ONLY[h.target] ?? h.target} for ${selector}, run ${delegate ? 'by delegatecall, as your account itself' : h.callType === '0x00' ? 'by call' : `call type ${h.callType}`}${h.executor ? ', and an executor of the account' : ''}`, h.target);
    reading.partial = true;
    scoped(`which the account hands to ${handlerName(h.target)}${delegate ? ' by delegatecall' : ''}`);
    if (delegate && h.target === RECOVERY_ACTION) reading.danger.push(['kernel_enable_recovery', `It may call your account's ${label}, which the account already hands to ZeroDev's recovery action by delegatecall, as your account itself: ${RECOVERY_DANGER}.`]);
    else if (delegate) reading.danger.push(['kernel_enable_delegatecall_handler', `It may call your account's ${label}, which the account already hands to ${h.target} by delegatecall, as your account itself: that code, which this previewer doesn't read, can do anything with the account and all it holds.`]);
    else {
      if (h.executor) reading.danger.push(['kernel_enable_executor', `It may call your account's ${label}, whose handler ${h.target} is also an executor of the account: an executor can run any call from the account, and ${reading.who} can call it with any arguments.`]);
      reading.cautions.push(['kernel_enable_handler', `It may call your account's ${label}, handled by ${h.target} by call: what it can then do is up to that contract's code, which this previewer doesn't read.`]);
    }
  }
}

/** What the account and its modules answer about its setup (Kernel v3's ValidationManager, SelectorManager and ExecutorManager, ZeroDev's ECDSA validator and signer, Bleap's cosigner). */
const READS = parseAbi(['function rootValidator() view returns (bytes21)', 'function currentNonce() view returns (uint32)', 'function validationConfig(bytes21 vId) view returns ((uint32 nonce, address hook))',
  'function permissionConfig(bytes4 pId) view returns ((bytes2 permissionFlag, address signer, bytes22[] policyData))', 'function ecdsaValidatorStorage(address account) view returns (address)',
  'function signer(bytes32 id, address wallet) view returns (address)', 'function signers(address wallet, bytes32 id) view returns (address)',
  'function selectorConfig(bytes4 selector) view returns ((address hook, address target, bytes1 callType))', 'function executorConfig(address executor) view returns ((address hook))']);

interface AccountState { code: 'none' | 'contract' | 'delegated'; implementation?: string; root?: string; owner?: string; ownerKind?: string; expectedNonce?: bigint; installed?: boolean; blocked?: bigint; handler?: { hook: string; target: string; callType: string; executor?: boolean } }

/** The account now, where it can be read: what it runs, its owner (root validator), its validation nonce, and the handler it has for `selector`. */
async function accountState(env: TypedEnv, chainId: number, account: string, vId: string, selector?: string): Promise<AccountState | undefined> {
  const rpc = env.deps.rpc!;
  const call = async (to: string, data: string) => String(await rpc.call(chainId, 'eth_call', [{ to, data }, 'latest']));
  try {
    const code = String(await rpc.call(chainId, 'eth_getCode', [account, 'latest']));
    if (code === '0x') return { code: 'none' };
    const state: AccountState = { code: /^0xef0100[0-9a-f]{40}$/i.test(code) ? 'delegated' : 'contract' };
    if (state.code === 'delegated') state.implementation = `0x${code.slice(8)}`.toLowerCase();
    else {
      const slot = String(await rpc.call(chainId, 'eth_getStorageAt', [account, '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc', 'latest']));
      if (/^0x[0-9a-f]{64}$/i.test(slot) && BigInt(slot) !== 0n) state.implementation = `0x${slot.slice(-40)}`.toLowerCase();
    }
    if (!state.implementation || !KERNEL_V3_IMPLEMENTATIONS[state.implementation]) return state;
    const read = async <F extends typeof READS[number]['name']>(to: string, functionName: F, args: unknown[] = []) => {
      try {
        const out = await call(to, encodeFunctionData({ abi: READS, functionName, args } as never));
        return decodeFunctionResult({ abi: READS, functionName, data: out as Hex } as never) as unknown;
      } catch { return undefined; }
    };
    const root = await read(account, 'rootValidator');
    if (typeof root === 'string') state.root = root.toLowerCase();
    // The owner: the account itself (Kernel v3.3 as an EIP-7702 delegate, root 0), an ECDSA validator's owner, or a root permission's ECDSA key.
    if (state.root && /^0x0{42}$/.test(state.root) && state.code === 'delegated') { state.owner = account; state.ownerKind = "the account's own key (EIP-7702)"; }
    else if (state.root?.startsWith('0x01')) {
      const validator = `0x${state.root.slice(4)}`;
      if (VALIDATORS[validator]?.kind === 'ecdsa') {
        const owner = await read(validator, 'ecdsaValidatorStorage', [account]);
        if (typeof owner === 'string') { state.owner = owner.toLowerCase(); state.ownerKind = VALIDATORS[validator].name; }
      } else if (VALIDATORS[validator]?.kind === 'webauthn') state.ownerKind = 'a passkey';
    } else if (state.root?.startsWith('0x02')) {
      const pId = `0x${state.root.slice(4, 12)}`, id = `${pId}${'00'.repeat(28)}`;
      const config = await read(account, 'permissionConfig', [pId]) as { signer: string } | undefined;
      const signer = config?.signer?.toLowerCase();
      if (signer && SIGNERS[signer]?.kind === 'ecdsa') {
        const key = await read(signer, 'signer', [id, account]);
        if (typeof key === 'string') { state.owner = key.toLowerCase(); state.ownerKind = SIGNERS[signer].name; }
      } else if (signer && SIGNERS[signer]?.kind === 'cosigning') {
        const key = await read(signer, 'signers', [account, id]);
        if (typeof key === 'string') { state.owner = key.toLowerCase(); state.ownerKind = `${SIGNERS[signer].name}, with its cosigner`; }
      }
    }
    // The nonce Kernel will hash: currentNonce(). A validation already at it: v3.3 hashes one more and installs it
    // again; v3.0 to v3.2 refuse it (_installValidation's InvalidNonce) until the account's nonce moves on.
    const current = await read(account, 'currentNonce');
    const config = await read(account, 'validationConfig', [vId]) as { nonce: number; hook: string } | undefined;
    if (typeof current === 'number') {
      const cur = BigInt(current), at = config ? BigInt(config.nonce) === cur : false;
      state.installed = config ? !ZERO.test(config.hook) : undefined;
      if (KERNEL_V3_IMPLEMENTATIONS[state.implementation] === '0.3.3') state.expectedNonce = at ? cur + 1n : cur;
      else { state.expectedNonce = cur; if (at) state.blocked = cur; }
    }
    // The handler Kernel's fallback hands the function to (SelectorManager's selectorConfig; hook 0: none installed),
    // and, for one run by call, whether it is also an executor of the account.
    if (selector) {
      const sc = await read(account, 'selectorConfig', [selector]) as { hook: string; target: string; callType: string } | undefined;
      if (sc) {
        state.handler = { hook: sc.hook.toLowerCase(), target: sc.target.toLowerCase(), callType: sc.callType.toLowerCase() };
        if (!ZERO.test(state.handler.hook) && state.handler.callType === '0x00') {
          const ex = await read(account, 'executorConfig', [state.handler.target]) as { hook: string } | undefined;
          if (ex) state.handler.executor = !ZERO.test(ex.hook);
        }
      }
    }
    return state;
  } catch { return undefined; }
}

function accountChecks(state: AccountState, b: PreviewBuilder, env: TypedEnv, account: string, version: string, nonce: bigint | null) {
  if (state.code === 'none') { b.note('The account has no code yet: it is deployed by its first operation, which installs this with it, so its owner and settings can\'t be read now.'); return; }
  const runs = state.implementation ? KERNEL_V3_IMPLEMENTATIONS[state.implementation] : undefined;
  if (!runs) {
    b.warn('caution', 'kernel_enable_not_kernel', `${account} doesn't run a Kernel v3 this previewer knows${state.implementation ? ` (it runs ${state.implementation})` : ''}: what this signature does there depends on that contract.`);
    return;
  }
  b.detail('Account runs', `${DOMAIN_VERSIONS[runs]}${state.code === 'delegated' ? ' (an EIP-7702 account)' : ''}`, state.implementation);
  if (version !== runs) b.warn('info', 'kernel_enable_version_mismatch', `It is signed for Kernel ${version || '(no version)'}, but the account runs ${runs}: the account won't accept it as it is.`);
  if (state.owner) {
    b.detail('Account owner', `${state.owner} (${state.ownerKind})`, state.owner);
    // A request naming the smart account itself rather than its key is the account's own; any other key isn't its owner.
    if (env.signer && !sameAddress(env.signer, state.owner) && !(sameAddress(env.signer, account) && state.code !== 'delegated')) b.warn('caution', 'kernel_enable_not_owner', `${env.signer} is asked to sign, but the account's owner is ${state.owner} (${state.ownerKind}): Kernel accepts this only from its owner, so it isn't what it seems, or isn't for this account.`);
  } else if (state.ownerKind) b.detail('Account owner', state.ownerKind);
  if (state.blocked !== undefined) b.warn('info', 'kernel_enable_nonce', `This validation was already installed at the account's validation nonce (${state.blocked}): ${DOMAIN_VERSIONS[runs]} won't install it again with this signature until that nonce moves on.`);
  // v3.3 takes it at the next nonce and calls each module's onInstall again: ZeroDev's validators, signers and policies
  // (all but its sudo policy) refuse a second install for the same account (AlreadyInitialized, or a status check).
  else if (state.installed) b.note("This validation is already installed on the account. Kernel v3.3 takes an Enable for it again, at the next validation nonce, and installs its modules again with what is shown here; but ZeroDev's validators, signers and policies (all but its sudo policy) refuse to be installed a second time for the same account, so with them the operation that carries this signature fails and what is installed stays as it is.");
  if (state.blocked === undefined && nonce !== null && state.expectedNonce !== undefined && nonce !== state.expectedNonce) {
    b.warn('info', 'kernel_enable_nonce', nonce < state.expectedNonce
      ? `It is signed with validation nonce ${nonce}, but the account's is already ${state.expectedNonce}: Kernel won't accept it.`
      : `It is signed with validation nonce ${nonce}, but the account's is ${state.expectedNonce}: Kernel accepts it only once the account's nonce reaches ${nonce}.`);
  }
}
