// npm run accuracy:4337 -- [--chain 1|42161|8453|10|137|56] [--entrypoint 0.6|0.7|0.8|0.9] [--follow 1200 [--backfill 100] | --blocks 100 | --tx 0x…]
//   [--max 30] [--concurrency 1] [--no-prefix] [--out report.json] [--summary-md summary.md] [--strict] [--dump preview.json]
//   [--differing dir/] (the row and preview of each operation whose preview differed, to look at once its state is gone)
//
// --concurrency replays that many operations at once (each on its own state; oldest first where the node keeps state
// longer, newest first on Arbitrum, OP Mainnet and Polygon, whose public nodes keep the least), while --follow keeps
// watching for new blocks: on Arbitrum an operation must be replayed within about 30 seconds of its block, on OP
// Mainnet and Polygon within about two minutes (their public nodes keep 64 blocks). --backfill
// first takes the operations of the blocks already behind the head (Ethereum keeps about 128 blocks of state).
// --summary-md appends the results as Markdown (a CI job summary). --strict exits with 1 when an operation's outcome
// differs from its receipt or, for one simulated whole on its block's state, its gas is 5% or more off or its token
// movements differ beyond rounding.
//
// How accurate whole-operation simulation is (src/erc4337-sim.ts), measured against what happened. Recent operations
// of an EntryPoint are rebuilt as the request their owner signed:
//   (an operation in a bundle of several, up to five of them, after the bundle's earlier operations as a handleOps of
//   their own: gas reported apart, as warm state from the same transaction is cold in a replay);
//   - a SafeOp, for a Safe whose fallback handler is one of the known 4337 modules (src/typed-data/safe.ts);
//   - otherwise, for v0.6 and v0.7, personal_sign of the operation's hash with the operation as context.userOperation;
//   - for v0.8 and v0.9, the PackedUserOperation typed data (an EIP-7702 account's delegate where its marker is).
// Each is previewed on the state the operation met: the parent block, with the block's own header (base fee
// included), after the block's earlier transactions (unless --no-prefix: an earlier transaction can change what a
// paymaster or a token holds, and so the gas and amounts; on Ethereum this turned an operation 10% off into one within
// 0.05%). It is compared with the receipt: the outcome, whether the
// operation ran whole, whether the account accepted the stand-in signature, the gas it paid (UserOperationEvent's
// actualGasCost) and the account's token movements.
//
// The signer isn't on the chain: it is the account itself for an EIP-7702 account, else whoever the operation's
// real signature recovers to (its last 65 bytes, or a Coinbase Smart Wallet's wrapped one), over the personal_sign
// form or the bare hash, or the account's owner(); tried in turn while the account rejects the stand-in as theirs.
// Public RPCs keep only recent state (Ethereum about 128 blocks, Arbitrum about 30 seconds): --follow replays each
// new block's operations as it arrives. HyperEVM's public RPC serves only the latest state, so it can't be replayed.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { decodeAbiParameters, decodeFunctionData, decodeFunctionResult, encodeFunctionData, hashMessage, hashTypedData, keccak256, parseAbi, recoverAddress, type Hex } from 'viem';
import { recoverAuthorizationAddress } from 'viem/utils';
import { previewRequest } from '../src/preview.ts';
import { liveDependencies } from '../src/server.ts';
import type { Dependencies } from '../src/types.ts';
import { NATIVE_LOG_ADDRESS, RpcSimulator } from '../src/simulation.ts';
import { JsonRpcClient } from '../src/rpc.ts';
import { stateBefore } from '../src/block.ts';
import { readOperation, userOpHash } from '../src/userop-hash.ts';
import { BULLBIT_IMPLEMENTATION, implementationOf, okxDigest } from '../src/erc4337-sim.ts';
import { replayTransaction } from '../src/replay.ts';
import { SAFE_4337_MODULES } from '../src/typed-data/safe.ts';
import { safeSetupOf } from '../src/safe-sim.ts';
import type { Preview, SimulationRequest } from '../src/types.ts';
import { chainName, EVM_RPCS, OP_STACK, rpcUrlFor } from '../src/chains.ts';

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const CHAIN = Number(arg('chain', '1')), VERSION = arg('entrypoint', '0.7'), FOLLOW = Number(arg('follow', '0')), BLOCKS = Number(arg('blocks', '100')), MAX = Number(arg('max', '30'));
const PREFIX = !process.argv.includes('--no-prefix'), STRICT = process.argv.includes('--strict');
const CONCURRENCY = Math.max(1, Number(arg('concurrency', '1'))), BACKFILL = Number(arg('backfill', '0'));
// The chain's *_RPC_URL replaces its public RPC (empty counts as unset, as an unset CI secret is; EVM_RPCS).
const URL_: string = rpcUrlFor(CHAIN, process.env) ?? (() => { throw new Error(`no RPC for chain ${CHAIN}`); })();
/**
 * How long the chain's public node keeps a block's state, in seconds, where that is short: an operation whose block is
 * older by its turn is skipped (its state would go partway through the replay), and the queue runs newest first.
 */
const STATE_SECONDS: Record<number, number> = { 42161: 25, 10: 100, 137: 100 };
const NEWEST_FIRST = CHAIN in STATE_SECONDS;
/** An OP Stack block's L1 info deposit comes from this depositor: kept among the block's earlier transactions (see below). */
const L1_INFO_DEPOSITOR = '0xdeaddeaddeaddeaddeaddeaddeaddeaddead0001';
const ENTRY_POINTS: Record<string, string> = { '0.6': '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789', '0.7': '0x0000000071727de22e5e9d8baf0edac6f37da032', '0.8': '0x4337084d9e255ff0702461cf8895ce9e3b5ff108', '0.9': '0x433709009b8330fda32311df1c2afa402ed8d009' };
const EP = ENTRY_POINTS[VERSION];
if (!EP) throw new Error(`--entrypoint is one of ${Object.keys(ENTRY_POINTS).join(', ')}`);
const SYSTEM = CHAIN === 42161 ? new Set(['0x64', '0x65', '0x66', '0x68', '0x69', '0x6a']) : OP_STACK.has(CHAIN) ? new Set(['0x7e']) : new Set<string>();
const rpc = new JsonRpcClient({ [CHAIN]: URL_ }, { timeoutMs: 30_000, retries: 6, retryDelayMs: 800 });
/** For replaying a bundle as the previewer replays a mined transaction (below): its lookups on the chain's node only. */
let replaying: Dependencies | undefined;
const replayDeps = () => (replaying ??= liveDependencies({ [EVM_RPCS[CHAIN].env]: URL_, SIGNING_PREVIEW_FORK_CACHE: 'off', SIGNING_PREVIEW_OFFLINE_LOOKUPS: '1', SIGNING_PREVIEW_PRICES: 'off' }, { warmUp: false }));
/**
 * A read; a block or transaction the answering backend doesn't have yet (null) is asked for again, four times, a
 * second and more apart, and one still refused for the rate after the client's own retries (HTTP 429: the
 * scheduled run lost 18 operations so) once more after ten seconds. Logs asked of a backend that is behind the one
 * that gave the head ("block range extends beyond current head block": Sepolia's public RPC) are asked for again too.
 */
const call = async <T>(method: string, params: unknown[]): Promise<T> => {
  const ask = async () => {
    try { return await rpc.call(CHAIN, method, params) as T; }
    catch (e) { if (!/HTTP 429|rate limited/.test(String(e))) throw e; await new Promise(r => setTimeout(r, 10_000)); return await rpc.call(CHAIN, method, params) as T; }
  };
  const behind = async (left: number): Promise<T> => {
    try { return await ask(); }
    catch (e) { if (left <= 0 || !/beyond current head/i.test(String(e))) throw e; await new Promise(r => setTimeout(r, 2000)); return behind(left - 1); }
  };
  let out = await behind(5);
  for (let i = 0; i < 4 && out === null && /^eth_get(Block|Transaction)/.test(method); i++) { await new Promise(r => setTimeout(r, 1000 * (i + 1))); out = await ask(); }
  return out;
};

const OP = VERSION === '0.6'
  ? '(address sender, uint256 nonce, bytes initCode, bytes callData, uint256 callGasLimit, uint256 verificationGasLimit, uint256 preVerificationGas, uint256 maxFeePerGas, uint256 maxPriorityFeePerGas, bytes paymasterAndData, bytes signature)'
  : '(address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature)';
const HANDLE_OPS = parseAbi([`function handleOps(${OP}[] ops, address beneficiary)`]);
type Op = { sender: Hex; nonce: bigint; initCode: Hex; callData: Hex; callGasLimit?: bigint; verificationGasLimit?: bigint; accountGasLimits?: Hex; preVerificationGas: bigint; maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint; gasFees?: Hex; paymasterAndData: Hex; signature: Hex };
const UOE = '0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f';
/** EntryPoint's BeforeExecution(): the end of a bundle's validation, from v0.6 on. */
const BEFORE_EXECUTION = '0xbb47ee3e183a558b1a2ff0874b079f3fc5478b7454eacf2bfc5af2ff5878f972';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
/** WETH-style wrappers' Deposit(dst, wad) and Withdrawal(src, wad): their balance changes without a Transfer. */
const DEPOSIT = '0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c', WITHDRAWAL = '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65';
/** Whether a contract answers decimals(), as a token does (remembered for the run). */
const TOKEN_LIKE = new Map<string, Promise<boolean>>();
const tokenLike = (address: string): Promise<boolean> => {
  let known = TOKEN_LIKE.get(address);
  if (!known) {
    known = rpc.call(CHAIN, 'eth_call', [{ to: address, data: '0x313ce567' }, 'latest']).then(r => /^0x[0-9a-f]{64}$/i.test(String(r)))
      // A node's answer (it reverted: no decimals) is no; a read that failed keeps it counted, as before.
      .catch((e: { rpcError?: unknown }) => !e?.rpcError);
    TOKEN_LIKE.set(address, known);
  }
  return known;
};
const FALLBACK_SLOT = '0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5';
const SAFE_EXECUTE = ['0x7bb37428', '0x541d63c8'];
const hi = (w: Hex) => BigInt(`0x${w.slice(2, 34)}`), lo = (w: Hex) => BigInt(`0x${w.slice(34)}`);
/** The operation's gas fields, whichever version packed them. */
const gasOf = (op: Op) => op.accountGasLimits
  ? { verification: hi(op.accountGasLimits), call: lo(op.accountGasLimits), maxPriority: hi(op.gasFees!), maxFee: lo(op.gasFees!) }
  : { verification: op.verificationGasLimit!, call: op.callGasLimit!, maxPriority: op.maxPriorityFeePerGas!, maxFee: op.maxFeePerGas! };
const hex = (v: bigint) => `0x${v.toString(16)}`;
/** The operation as bundlers' RPC carries it (v0.6 fields; v0.7 unpacked), for context.userOperation. */
function rpcForm(op: Op): Record<string, unknown> {
  const g = gasOf(op);
  const base = { sender: op.sender, nonce: hex(op.nonce), callData: op.callData, preVerificationGas: hex(op.preVerificationGas), callGasLimit: hex(g.call), verificationGasLimit: hex(g.verification), maxFeePerGas: hex(g.maxFee), maxPriorityFeePerGas: hex(g.maxPriority) };
  if (VERSION === '0.6') return { ...base, initCode: op.initCode, paymasterAndData: op.paymasterAndData };
  const pm = op.paymasterAndData;
  return { ...base, ...(op.initCode.length > 2 && { factory: `0x${op.initCode.slice(2, 42)}`, factoryData: `0x${op.initCode.slice(42)}` }),
    ...(pm.length > 2 && { paymaster: `0x${pm.slice(2, 42)}`, paymasterVerificationGasLimit: hex(BigInt(`0x${pm.slice(42, 74)}`)), paymasterPostOpGasLimit: hex(BigInt(`0x${pm.slice(74, 106)}`)), paymasterData: `0x${pm.slice(106)}` }) };
}
const PACKED_TYPES = { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
  PackedUserOperation: [{ name: 'sender', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'initCode', type: 'bytes' }, { name: 'callData', type: 'bytes' }, { name: 'accountGasLimits', type: 'bytes32' }, { name: 'preVerificationGas', type: 'uint256' }, { name: 'gasFees', type: 'bytes32' }, { name: 'paymasterAndData', type: 'bytes' }] };
const SAFE_OP_V2_FIELDS = [['callGasLimit', 'uint256'], ['verificationGasLimit', 'uint256'], ['preVerificationGas', 'uint256'], ['maxFeePerGas', 'uint256'], ['maxPriorityFeePerGas', 'uint256']];
const SAFE_OP_V3_FIELDS = [['verificationGasLimit', 'uint128'], ['callGasLimit', 'uint128'], ['preVerificationGas', 'uint256'], ['maxPriorityFeePerGas', 'uint128'], ['maxFeePerGas', 'uint128']];
/** The SafeOp typed data an owner signed for this operation, on this module (the validity window is in the signature). */
function safeOpTyped(op: Op, module: string, prefixBytes: number) {
  const fields = VERSION === '0.6' ? SAFE_OP_V2_FIELDS : SAFE_OP_V3_FIELDS;
  const g = gasOf(op);
  const gas: Record<string, string> = { callGasLimit: String(g.call), verificationGasLimit: String(g.verification), preVerificationGas: String(op.preVerificationGas), maxFeePerGas: String(g.maxFee), maxPriorityFeePerGas: String(g.maxPriority) };
  const at = 2 + prefixBytes * 2;
  return { domain: { chainId: CHAIN, verifyingContract: module }, primaryType: 'SafeOp',
    types: { EIP712Domain: [{ name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
      SafeOp: [{ type: 'address', name: 'safe' }, { type: 'uint256', name: 'nonce' }, { type: 'bytes', name: 'initCode' }, { type: 'bytes', name: 'callData' }, ...fields.map(([name, type]) => ({ name, type })), { type: 'bytes', name: 'paymasterAndData' }, { type: 'uint48', name: 'validAfter' }, { type: 'uint48', name: 'validUntil' }, { type: 'address', name: 'entryPoint' }] },
    message: { safe: op.sender, nonce: op.nonce.toString(), initCode: op.initCode, callData: op.callData, ...Object.fromEntries(fields.map(([name]) => [name, gas[name]])), paymasterAndData: op.paymasterAndData,
      validAfter: BigInt(`0x${op.signature.slice(at, at + 12)}`).toString(), validUntil: BigInt(`0x${op.signature.slice(at + 12, at + 24)}`).toString(), entryPoint: EP } };
}
/**
 * The ECDSA signatures an account's signature may carry its owner's in: a wrapper's (Coinbase's SignatureWrapper,
 * Biconomy Smart Account v2's abi.encode(signature, module)), its last 65 bytes, or (a prefix byte and two
 * signatures, the owner's then a cosigner's) its first after the prefix.
 */
function innerSignatures(sig: Hex): Hex[] {
  try { const [w] = decodeAbiParameters([{ type: 'tuple', components: [{ name: 'ownerIndex', type: 'uint256' }, { name: 'signatureData', type: 'bytes' }] }], sig); if (w.signatureData.length === 132) return [w.signatureData]; } catch { /* not a wrapper */ }
  try { const [inner] = decodeAbiParameters([{ type: 'bytes' }, { type: 'address' }], sig); if (inner.length === 132 && sig.length === 2 + 192 * 2) return [inner]; } catch { /* not Biconomy's */ }
  // Splits' Smart Vault: a type byte, then its signatures (signerIndex, signatureData) after the gas limits (type 0),
  // or after the gas limits and two Merkle roots and proofs (type 1: one signature for several operations).
  if (/^0x0[01]/.test(sig)) {
    const wrappers = { name: 'signatures', type: 'tuple[]', components: [{ name: 'signerIndex', type: 'uint8' }, { name: 'signatureData', type: 'bytes' }] } as const;
    const merkle = [{ name: 'lightRoot', type: 'bytes32' }, { name: 'lightProof', type: 'bytes32[]' }, { name: 'root', type: 'bytes32' }, { name: 'proof', type: 'bytes32[]' }] as const;
    try {
      const [s] = decodeAbiParameters([{ type: 'tuple', components: [{ name: 'gasLimits', type: 'uint256[7]' }, ...(sig.startsWith('0x01') ? merkle : []), wrappers] }], `0x${sig.slice(4)}`) as unknown as [{ signatures: readonly { signatureData: Hex }[] }];
      const ecdsa = s.signatures.map(w => w.signatureData).filter(d => d.length === 132);
      if (ecdsa.length) return ecdsa.reverse();
    } catch { /* not a vault's */ }
  }
  return [...(sig.length === 2 + 131 * 2 ? [`0x${sig.slice(4, 4 + 130)}` as Hex] : []), ...(sig.length >= 132 ? [`0x${sig.slice(-130)}` as Hex] : [])];
}
/**
 * The Merkle roots a Splits Smart Vault's type-1 signature is signed over, in place of the operation's hash: its last
 * signer signs the root of the operations' hashes, the others the root of their light forms (an EOA's over its EIP-191
 * form, as for one operation). Empty for any other signature.
 */
function vaultRoots(sig: Hex): Hex[] {
  if (!sig.startsWith('0x01')) return [];
  try {
    const [s] = decodeAbiParameters([{ type: 'tuple', components: [{ name: 'gasLimits', type: 'uint256[7]' }, { name: 'lightRoot', type: 'bytes32' }, { name: 'lightProof', type: 'bytes32[]' },
      { name: 'root', type: 'bytes32' }, { name: 'proof', type: 'bytes32[]' }, { name: 'signatures', type: 'tuple[]', components: [{ name: 'signerIndex', type: 'uint8' }, { name: 'signatureData', type: 'bytes' }] }] }], `0x${sig.slice(4)}`) as unknown as [{ root: Hex; lightRoot: Hex }];
    return [s.root, s.lightRoot];
  } catch { return []; }
}

const KERNEL = parseAbi(['function rootValidator() view returns (bytes21)', 'struct PermissionConfig { bytes1 permissionFlag; address signer; bytes22[] policyData; }', 'function permissionConfig(bytes4 pId) view returns (PermissionConfig)', 'function signers(address account, bytes32 id) view returns (address)']);
/**
 * The owner a Kernel v3 account's permission signer records for it, when its operation validates through a
 * permission (its nonce's, or its root's) whose signer keeps one per account (Bleap's CosigningModuleV2:
 * signers(account, permission id)). Such owners sign over another hash than the operation's, so recovering their
 * signature names someone else.
 */
async function permissionOwner(call: (to: string, data: Hex) => Promise<string>, sender: string, nonce: bigint): Promise<string | undefined> {
  try {
    let id = nonce.toString(16).padStart(64, '0').slice(2, 44);
    if (id.startsWith('00')) id = String(await call(sender, encodeFunctionData({ abi: KERNEL, functionName: 'rootValidator' }))).slice(2, 44);
    if (!id.startsWith('02')) return undefined;
    const pId = `0x${id.slice(2, 10)}` as Hex;
    const out = await call(sender, encodeFunctionData({ abi: KERNEL, functionName: 'permissionConfig', args: [pId] }));
    const { signer } = decodeFunctionResult({ abi: KERNEL, functionName: 'permissionConfig', data: out as Hex });
    const owner = String(await call(signer, encodeFunctionData({ abi: KERNEL, functionName: 'signers', args: [sender as Hex, `${pId}${'00'.repeat(28)}`] })));
    return /^0x0{24}[0-9a-f]{40}$/i.test(owner) && !/^0x0+$/.test(owner) ? `0x${owner.slice(26)}`.toLowerCase() : undefined;
  } catch { return undefined; }
}

const ERC1967_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
/** Alchemy's Modular Account v2: its implementations and its EIP-7702 delegate (as src/erc4337-sim.ts shapes them). */
const MODULAR_ACCOUNTS_V2 = new Set(['0x000000000000c5a9089039570dd36455b5c07383', '0x00000000000002377b26b1eda7b0bc371c60dd4f', '0x69007702764179f14f51cdce752f4f775d74e139']);

/** Rhinestone's SmartSession module (source verified on Sourcify, Arbitrum One). */
const SESSION_VALIDATORS = ['0x00000000008bdaba73cd9815d79069c247eb4bda'];

type Row = Record<string, unknown>;
const rows: Row[] = [];
const blocks = new Set<number>();
const skipped: Record<string, number> = {};
const skip = (why: string) => { skipped[why] = (skipped[why] ?? 0) + 1; };
const STAND_IN_REJECTED = /doesn't accept it as theirs/;
/** The key Chrome adds to some passkeys' clientDataJSON, as it appears in a signature (hex, no 0x). */
const CHROME_EXTRA_KEY = Buffer.from('"other_keys_can_be_added_here"').toString('hex');

/** How many operations of one bundle are replayed (each after the bundle's earlier ones). */
const BUNDLE_MAX = 5;
/** A block's receipts, read once for the operations replayed from it. */
const BLOCK_RECEIPTS = new Map<string, Promise<{ transactionHash: string; gasUsed?: Hex; effectiveGasPrice?: Hex }[]>>();
const blockReceipts = (number: Hex) => {
  if (!BLOCK_RECEIPTS.has(number)) { BLOCK_RECEIPTS.set(number, call('eth_getBlockReceipts', [number])); if (BLOCK_RECEIPTS.size > 64) BLOCK_RECEIPTS.delete(BLOCK_RECEIPTS.keys().next().value!); }
  return BLOCK_RECEIPTS.get(number)!;
};
async function replay(item: string): Promise<void> {
  // An item is a bundle transaction's hash, or `hash#i` for its i-th operation.
  const [hash, at] = item.split('#');
  const tx = await call<{ from: string; to: string | null; input: Hex; transactionIndex: Hex; blockNumber: Hex; authorizationList?: NonNullable<SimulationRequest['authorizationList']> }>('eth_getTransactionByHash', [hash]);
  if (!tx) return skip("the node didn't return the transaction");
  // handleOps to the EntryPoint, or the same call to a bundler's own contract that relays it there (on Polygon, most
  // v0.7 bundles in a sample went through one): its operations are the EntryPoint's, and its receipt has their events.
  let ops: readonly Op[];
  let beneficiary: Hex;
  try { const args = decodeFunctionData({ abi: HANDLE_OPS, data: tx.input }).args; ops = args[0] as unknown as Op[]; beneficiary = args[1] as Hex; } catch { return skip('not a handleOps transaction to the EntryPoint (or a contract relaying it there)'); }
  const relayed = tx.to?.toLowerCase() !== EP ? tx.to?.toLowerCase() : undefined;
  // A bundle of several operations: each (up to BUNDLE_MAX) is replayed after the bundle's earlier ones, which run
  // first as a handleOps of their own (with their real signatures). The same account twice is left out: its
  // operations' token movements can't be told apart in the receipt.
  const index = at === undefined ? 0 : Number(at);
  if (ops.length > 1 && at === undefined) {
    if (new Set(ops.map(o => o.sender.toLowerCase())).size < ops.length) return skip('a bundle with the same account twice');
    enqueueNext(Array.from({ length: Math.min(ops.length, BUNDLE_MAX) - 1 }, (_, i) => `${hash}#${i + 1}`));
  }
  const op = ops[index], sender = op.sender.toLowerCase();
  // A session key's operation (an ERC-7579 account validating through Rhinestone's SmartSession module, which its
  // nonce names): the dApp holding the key signs it, not the user's wallet, so nothing previews it.
  if (SESSION_VALIDATORS.some(v => BigInt(op.nonce).toString(16).padStart(64, '0').includes(v.slice(2)))) return skip("a session key's operation (signed by a dApp, not a wallet)");
  // A transaction's receipt; OP Mainnet's public node refuses receipts by hash ("archive requests") but serves its
  // block's receipts.
  type Receipt = { transactionHash: string; blockNumber: Hex; effectiveGasPrice?: Hex; gasUsed?: Hex; logs: { address: string; topics: Hex[]; data: Hex }[] };
  const r = await call<Receipt>('eth_getTransactionReceipt', [hash]).catch(async () => (await call<Receipt[]>('eth_getBlockReceipts', [tx.blockNumber])).find(x => x.transactionHash.toLowerCase() === hash.toLowerCase())!);
  if (!r) return skip('its receipt could not be read');
  const n = Number(r.blockNumber), parent = hex(BigInt(n - 1));
  const block = await call<{ number: Hex; timestamp: Hex; miner: string; mixHash: Hex; difficulty?: Hex; gasLimit: Hex; baseFeePerGas: Hex; blockAccessListHash?: Hex; transactions: { hash: string; from: string; to: string | null; input: Hex; value: Hex; gas: Hex; type: string; authorizationList?: unknown[] }[] }>('eth_getBlockByNumber', [r.blockNumber, PREFIX]);
  // Arbitrum's public RPC keeps about 30 seconds of state, OP Mainnet's and Polygon's about two minutes: an operation
  // whose block is older by the time its turn comes would lose its state partway through the replay (the stand-in's
  // shape, the operation's hash, the simulation itself), and is skipped rather than replayed on part of it.
  if (STATE_SECONDS[CHAIN] && !ONE && Date.now() / 1000 - Number(block.timestamp) > STATE_SECONDS[CHAIN]) return skip(`its block was too old for the node by its turn (${chainName(CHAIN)}'s public node keeps about ${CHAIN === 42161 ? '30 seconds' : 'two minutes'})`);
  blocks.add(n);
  // The block's earlier transactions (--prefix), without their gas limits: the node charges each what it uses, and
  // the simulated block's gas limit holds them as it held the real ones.
  // An OP Stack block's L1 info deposit (its first transaction) stays: the L1 values it sets are what a paymaster
  // pricing L1 data reads (a bundle on OP Mainnet came out 0.47% low on the parent block's).
  const earlier = PREFIX ? block.transactions.slice(0, Number(tx.transactionIndex)).filter(t => !SYSTEM.has(t.type) || t.from.toLowerCase() === L1_INFO_DEPOSITOR).slice(-400) : [];
  const before: SimulationRequest[] = earlier
    .map(t => ({ chainId: CHAIN, from: t.from.toLowerCase(), to: t.to, data: t.input, value: BigInt(t.value), ...(t.authorizationList?.length && { authorizationList: t.authorizationList as SimulationRequest['authorizationList'] }) }));
  // The same, each at the price it paid (its receipt's), with a gas limit a little over what it used (its own limits
  // would add up to more than a node's cap for a simulated block): what an earlier transaction does can depend on its
  // price (a bot sizing its trade by it), and three Ethereum swaps came out 0.01-0.02% off after ones run at no price.
  // A bundle keeps its own gas limit: the EntryPoint refuses one whose gas left is under an operation's limits (AA95),
  // whatever the operation goes on to use. Given a little over what they used, earlier bundles reverted in the
  // replay, and what they did was missing: on Arbitrum One a keeper's operation then showed fulfilling a request
  // that another keeper's bundle, four transactions earlier in its block, had fulfilled (six of 150 operations).
  let pricedBefore: SimulationRequest[] | undefined;
  if (earlier.length) {
    try {
      const receipts = new Map((await blockReceipts(r.blockNumber)).map(x => [x.transactionHash.toLowerCase(), x]));
      const bundle = (t: { to: string | null; input: string }) => Object.values(ENTRY_POINTS).includes(t.to?.toLowerCase() ?? '') || /^0x(1fad948c|765e827f)/.test(t.input);
      pricedBefore = earlier.map((t, i) => {
        const rc = receipts.get(t.hash.toLowerCase());
        if (!rc?.gasUsed || !rc.effectiveGasPrice || SYSTEM.has(t.type)) return before[i];
        const roomy = BigInt(rc.gasUsed) * 13n / 10n + 30_000n;
        return { ...before[i], gas: roomy < BigInt(t.gas) && !bundle(t) ? roomy : BigInt(t.gas), gasPrice: BigInt(rc.effectiveGasPrice) };
      });
    } catch { pricedBefore = undefined; }
  }
  // An account the bundle itself delegates (EIP-7702, in the bundle transaction's own authorizations): the
  // authorizations apply first, as they do on-chain, and the account's code reads as the delegation.
  // The authorities are warm in the bundle transaction from its start (EIP-7702), so they are in the replay too.
  let delegation: string | undefined;
  const warm: string[] = [];
  // What must run first whatever else is dropped: the bundle's authorizations and its earlier operations.
  const essential: SimulationRequest[] = [];
  if (tx.authorizationList?.length) {
    essential.push({ chainId: CHAIN, from: tx.from.toLowerCase(), to: tx.from.toLowerCase(), data: '0x', value: 0n, authorizationList: tx.authorizationList });
    for (const a of tx.authorizationList) {
      try {
        const authority = (await recoverAuthorizationAddress({ authorization: { address: a.address as Hex, chainId: Number(a.chainId), nonce: Number(a.nonce) }, signature: { r: a.r as Hex, s: a.s as Hex, yParity: Number(a.yParity) } })).toLowerCase();
        warm.push(authority);
        if (authority === sender) delegation = `0xef0100${a.address.slice(2).toLowerCase()}`;
      } catch { /* unreadable */ }
    }
  }
  if (index > 0) essential.push({ chainId: CHAIN, from: tx.from.toLowerCase(), to: EP, value: 0n, data: encodeFunctionData({ abi: HANDLE_OPS, functionName: 'handleOps', args: [ops.slice(0, index) as never, beneficiary] }) });
  // What to keep of the earlier transactions when the node won't run them all (a full block's are too much for a
  // public node's simulated block): the account's own and the other bundles, which most often change what the
  // operation meets. On Arbitrum One three keepers' operations failed (Ostium's NotInitiated) where another
  // keeper's bundle, four transactions earlier in the block, had fulfilled the same request; on Ethereum a deposit
  // failed for tokens gone by its turn. Replayed without any of the block, each had shown succeeding.
  const bundles = tx.input.slice(0, 10);
  const related: SimulationRequest[] = [...(pricedBefore ?? before).filter((_, i) => {
    const t = earlier[i], to = t.to?.toLowerCase();
    return to === EP || to === sender || t.from.toLowerCase() === sender || t.input.startsWith(bundles);
  }), ...essential];
  before.push(...essential);
  pricedBefore?.push(...essential);
  // Reads on the parent block, and the block itself for its header (the base fee the operation's gas is priced at).
  const atParent = { has: (c: number) => c === CHAIN, call: (c: number, m: string, ps: unknown[]) => m === 'eth_getBlockByNumber' ? rpc.call(c, m, [r.blockNumber, false])
    : m === 'eth_getCode' && delegation && String(ps[0]).toLowerCase() === sender ? Promise.resolve(delegation) : rpc.call(c, m, ps.map(x => x === 'latest' ? parent : x)) };
  // The block's header, but not its gas limit: public nodes refuse a simulated block above their RPC gas cap (50M on
  // publicnode, below Ethereum's 60M), and the parent's limit, the node's default, is all but the same.
  // From Amsterdam on a block carries what each of its transactions changed (its access list: src/block.ts,
  // stateBefore). Where the node serves it, the state the bundle met is read, exactly, and only what the bundle
  // itself does first is run: on Sepolia, 12 of 30 operations had been replayed without their block's earlier
  // transactions, which the node's gas allowance for one simulation couldn't hold.
  const state = PREFIX && block.blockAccessListHash !== undefined ? await stateBefore(rpc, CHAIN, r.blockNumber, Number(tx.transactionIndex)) : undefined;
  let prefix = state ? essential : pricedBefore ?? before; // at no price, then dropped, if the node refuses the block with it (see below)
  // The block's own time; BNB Chain's node refuses a simulated block in its parent's second (its blocks come faster
  // than one a second), which then runs a second later, and its gas isn't judged (what writes once a second costs
  // more). The block's DIFFICULTY as each node takes it: BNB Chain's and Polygon's from a difficulty override (BNB
  // Chain's 2 when its validator was in turn; its node isn't given prevRandao, which it would take as the block's
  // milliseconds: see scripts/accuracy.ts).
  let time: string = block.timestamp, timeBumped = false;
  if (CHAIN === 56) {
    const parentTime = BigInt((await call<{ timestamp: Hex }>('eth_getBlockByNumber', [parent, false])).timestamp);
    if (BigInt(block.timestamp) <= parentTime) { time = hex(parentTime + 1n); timeBumped = true; }
  }
  const difficulty = block.difficulty ?? '0x0';
  const randomness: Record<string, string> = CHAIN === 56 ? { difficulty } : CHAIN === 137 ? { prevRandao: block.mixHash, difficulty } : { prevRandao: block.mixHash };
  const node = new RpcSimulator({ [CHAIN]: URL_ }, { replay: () => ({ block: parent, blockOverrides: { number: block.number, time, feeRecipient: block.miner, ...randomness, baseFeePerGas: block.baseFeePerGas }, before: prefix, warm, ...(state && { state }) }) });
  // The whole operation runs at the price its bundle's transaction paid (tx.gasprice), part of what it met. A preview
  // can't know it, and takes what the operation pays its bundler (src/erc4337-sim.ts); bundlers pay less (on Base, a
  // 0.001 gwei tip where operations offered 0.0015), and a swap taxed by the priority fee came out 1% apart.
  const bundlePrice = r.effectiveGasPrice ? BigInt(r.effectiveGasPrice) : undefined;
  const atBundlePrice = (q: SimulationRequest) => bundlePrice !== undefined && q.gasPrice !== undefined && q.to?.toLowerCase() === EP ? { ...q, gasPrice: bundlePrice } : q;
  const simulator = { simulate: (q: SimulationRequest) => node.simulate(atBundlePrice(q)), simulateBatch: (qs: SimulationRequest[]) => node.simulateBatch(qs.map(atBundlePrice)) };
  const deps = { ...liveDependencies({ [EVM_RPCS[CHAIN].env]: URL_, SIGNING_PREVIEW_FORK_CACHE: 'off' }, { warmUp: false }), rpc: atParent, simulator };
  const context = { chainId: CHAIN, now: Number(block.timestamp) * 1000 };
  // A node that no longer serves the parent block's state (Ethereum's public RPC keeps about 128 blocks) would leave
  // the preview reading nothing: the operation is skipped rather than replayed on missing state.
  let code: string;
  try { code = String(await atParent.call(CHAIN, 'eth_getCode', [sender, 'latest'])); } catch { return skip('its state is no longer served by the node'); }
  // A Kernel v3 account's operation in enable mode (its nonce's first byte 0x01): the owner signs, as typed data, the
  // validator or permission it installs, which signs the operation (a dApp's session key, mostly). No wallet signs
  // the operation's hash.
  // An account the operation deploys through ZeroDev's FactoryStaker is a Kernel v3 too.
  if (BigInt(op.nonce) >> 248n === 1n && code === '0x' && op.initCode.slice(0, 42).toLowerCase() === '0xd703aae79538628d27099b8c4f621be4ccd142d5') return skip("a Kernel operation in enable mode (signed by the key it installs, which its owner approves as typed data)");
  if (BigInt(op.nonce) >> 248n === 1n && code.length > 2) {
    const root = await atParent.call(CHAIN, 'eth_call', [{ to: sender, data: encodeFunctionData({ abi: KERNEL, functionName: 'rootValidator' }) }, 'latest']).catch(() => '0x');
    if (/^0x[0-9a-f]{64}$/i.test(String(root))) return skip("a Kernel operation in enable mode (signed by the key it installs, which its owner approves as typed data)");
  }
  // Modular Account v2's deferred actions (the nonce key's flag 0x02) are the same: the owner signs the action
  // installing a validation, as typed data, and that validation signs the operation.
  if ((BigInt(op.nonce) >> 64n) & 2n) {
    const impl = code.startsWith('0xef0100') ? `0x${code.slice(8, 48)}` : `0x${String(await atParent.call(CHAIN, 'eth_getStorageAt', [sender, ERC1967_SLOT, 'latest']).catch(() => '0x')).slice(-40)}`;
    if (MODULAR_ACCOUNTS_V2.has(impl.toLowerCase())) return skip('a Modular Account v2 operation with a deferred action (signed by the validation it installs, which its owner approves as typed data)');
  }

  // The request the owner signed, and who might have signed it.
  // A Safe the operation deploys has no fallback handler yet: its setup (in the initCode) names it. A read that fails
  // is tried once more, then the operation skipped: taken as no handler, a Safe's SafeOp was replayed as a hash-signed
  // operation, which the Safe rejects.
  const readFallback = () => atParent.call(CHAIN, 'eth_getStorageAt', [sender, FALLBACK_SLOT, 'latest']);
  let slot: unknown;
  try { slot = await readFallback().catch(async () => { await new Promise(r => setTimeout(r, 1000)); return readFallback(); }); } catch { return skip('a read of its state failed'); }
  const fallback = code === '0x' && safeSetupOf(op.initCode) ? safeSetupOf(op.initCode)!.fallbackHandler : `0x${String(slot).slice(-40)}`.toLowerCase();
  const module = SAFE_EXECUTE.includes(op.callData.slice(0, 10)) && SAFE_4337_MODULES[fallback]?.entryPoint === EP ? SAFE_4337_MODULES[fallback] : undefined;
  let request: (signer: string) => { method: string; params: unknown[] }, digest: Hex, kind: string;
  let ctx: Record<string, unknown> = context;
  if (module) {
    kind = 'SafeOp';
    const typed = safeOpTyped(op, fallback, (module.signaturePrefix?.length ?? 0) / 2);
    digest = hashTypedData(typed as never);
    request = signer => ({ method: 'eth_signTypedData_v4', params: [signer, JSON.stringify(typed)] });
  } else if (VERSION === '0.6' || VERSION === '0.7') {
    kind = 'hash';
    const form = rpcForm(op);
    digest = userOpHash(readOperation(form, VERSION)!, EP, CHAIN, VERSION);
    ctx = { ...context, userOperation: { entryPoint: EP, operation: form } };
    // The hash as it is (eth_sign) for a signer whose real signature is over the bare hash, else personal_sign:
    // an account that tries one form first (Kernel v2: the personal_sign form) runs as that wallet's signature makes it.
    request = signer => bare.has(signer) ? { method: 'eth_sign', params: [signer, digest] } : { method: 'personal_sign', params: [digest, signer] };
  } else {
    kind = 'typed';
    // SDKs put an EIP-7702 account's delegate where the EntryPoint receives the 0x7702 marker.
    const initCode = op.initCode.startsWith('0x7702') && code.startsWith('0xef0100') ? `0x${code.slice(8)}${op.initCode.slice(42)}` : op.initCode;
    const typed = { domain: { name: 'ERC4337', version: '1', chainId: CHAIN, verifyingContract: EP }, types: PACKED_TYPES, primaryType: 'PackedUserOperation',
      message: { sender, nonce: op.nonce.toString(), initCode, callData: op.callData, accountGasLimits: op.accountGasLimits, preVerificationGas: op.preVerificationGas.toString(), gasFees: op.gasFees, paymasterAndData: op.paymasterAndData } };
    digest = hashTypedData(typed as never);
    request = signer => ({ method: 'eth_signTypedData_v4', params: [signer, JSON.stringify(typed)] });
  }
  const signers: string[] = [], bare = new Set<string>();
  const add = (a: string | undefined) => { if (a && /^0x[0-9a-f]{40}$/.test(a) && !/^0x0+$/.test(a) && !signers.includes(a)) signers.push(a); };
  if (code.startsWith('0xef0100')) add(sender);
  for (const inner of module ? [] : innerSignatures(op.signature)) for (const h of [hashMessage({ raw: digest }), digest, ...vaultRoots(op.signature).flatMap(root => [hashMessage({ raw: root }), root])]) {
    try {
      const a = (await recoverAddress({ hash: h, signature: inner })).toLowerCase();
      if (h === digest && !signers.includes(a)) bare.add(a);
      add(a);
    } catch { /* not ECDSA */ }
  }
  // A SafeOp's first owner part, as Safe's checkNSignatures reads it after the validity window (r, s, v): a contract
  // owner's (v 0, the owner in r: a passkey through Safe's WebAuthn shared signer signs so), an owner's on-chain
  // approval (v 1, the owner in r), or a signature, over the SafeOp or (v above 30) its eth_sign form. That owner
  // is who signs: a Safe with a passkey and an Ethereum key came out 43% low on Arbitrum One, replayed as the
  // Ethereum key's signature where the passkey had signed (a P-256 check in Solidity, 230,000 gas).
  if (module) {
    const at = 2 + (module.signaturePrefix?.length ?? 0) + 24, part = op.signature.slice(at, at + 130);
    if (part.length === 130) {
      const v = parseInt(part.slice(128), 16);
      try {
        add(v <= 1 ? `0x${part.slice(24, 64)}`.toLowerCase()
          : (await recoverAddress({ hash: v > 30 ? hashMessage({ raw: digest }) : digest, signature: `0x${part.slice(0, 128)}${(v > 30 ? v - 4 : v).toString(16).padStart(2, '0')}` })).toLowerCase());
      } catch { /* not a signature */ }
    }
  }
  // OKX Wallet's account, signed by an Ethereum key: its hash, validUntil, then the signature over the account's
  // own digest of the operation's hash (src/erc4337-sim.ts, okxStubs); the key's hash is its address's.
  if (!module && op.signature.length === 2 + 206) {
    try {
      const a = (await recoverAddress({ hash: okxDigest(digest, BigInt(`0x${op.signature.slice(66, 78)}`)), signature: `0x${op.signature.slice(78)}` })).toLowerCase();
      if (keccak256(a as Hex) === op.signature.slice(0, 66).toLowerCase()) { const i = signers.indexOf(a); if (i >= 0) signers.splice(i, 1); signers.unshift(a); }
    } catch { /* not that form */ }
  }
  const owner = String(await atParent.call(CHAIN, 'eth_call', [{ to: sender, data: '0x8da5cb5b' }, 'latest']).catch(() => '0x'));
  if (/^0x0{24}[0-9a-f]{40}$/i.test(owner)) add(`0x${owner.slice(26)}`.toLowerCase());
  // First, a Kernel permission's recorded owner (whose signature recovers to someone else).
  const recorded = code.length > 2 && !module ? await permissionOwner((to, data) => atParent.call(CHAIN, 'eth_call', [{ to, data }, 'latest']) as Promise<string>, sender, BigInt(op.nonce)) : undefined;
  if (recorded) { const i = signers.indexOf(recorded); if (i >= 0) signers.splice(i, 1); signers.unshift(recorded); }
  add(sender);
  let p!: Preview, tried = 0;
  // Public nodes refuse heavy simulations: with the block's earlier transactions, a full block can be one. The
  // preview then has no simulation at all, and runs again without them.
  const ran = (q: Preview) => q.decoding.notes.some(x => /simulat/.test(x)) || q.details.some(d => d.label === 'Gas cost (simulated)');
  let prefixDropped: string | undefined;
  for (const signer of signers.slice(0, 3)) {
    tried++;
    p = await previewRequest(request(signer), ctx, deps);
    if (!ran(p) && prefix === pricedBefore) { prefix = before; p = await previewRequest(request(signer), ctx, deps); }
    // Then with only the account's own and the other bundles among them, then with none.
    const narrow = async (why: string) => {
      if (related.length > essential.length && related.length < prefix.length) { prefix = related; prefixDropped = `${why}: only the account's own and the other bundles ran first`; p = await previewRequest(request(signer), ctx, deps); return; }
      prefix = essential; prefixDropped = why; p = await previewRequest(request(signer), ctx, deps);
    };
    if (!ran(p) && prefix.length > essential.length) await narrow('the node refused the block with them');
    if (!ran(p) && prefix.length > essential.length) await narrow('the node refused the block with them');
    // A full block's earlier transactions can use nearly all of the node's gas cap for a simulated block (publicnode's
    // 50M, under Ethereum's 60M blocks), leaving the operation too little: the EntryPoint runs out of gas (AA95),
    // which on-chain it didn't. Then without them.
    const outOfGas = (q: Preview) => q.warnings.some(w => w.code === 'userop_rejected' && /\bAA95\b/.test(w.message));
    if (outOfGas(p) && prefix.length > essential.length) await narrow("they left too little of the node's gas cap for the operation");
    if (outOfGas(p) && prefix.length > essential.length) await narrow("they left too little of the node's gas cap for the operation");
    // The whole operation didn't run and nothing says why (no rejection, no validation revert): the node failed the
    // simulation, which a heavy block refused under load does (alone, the same operations ran whole). Once more.
    const unexplained = (q: Preview) => ran(q) && !q.decoding.notes.some(x => /whole operation was simulated|validation reverts on a stand-in/.test(x)) && !q.warnings.some(w => w.code === 'userop_rejected');
    if (unexplained(p)) { await new Promise(r => setTimeout(r, 1500)); p = await previewRequest(request(signer), ctx, deps); }
    // A wrong guess shows as the account rejecting the stand-in, or as its validation reverting on a shape for
    // another key (a passkey account given an ECDSA stand-in for a non-owner): either way, the next candidate.
    if (!p.decoding.notes.some(x => STAND_IN_REJECTED.test(x) || /validation reverts on a stand-in/.test(x))) break;
  }

  // --dump: the preview itself, to look at one operation closely.
  if (arg('dump', '')) writeFileSync(arg('dump', ''), JSON.stringify(p, null, 1));

  // What happened, and what the preview says.
  const event = r.logs.find(l => l.address.toLowerCase() === EP && l.topics[0] === UOE && `0x${l.topics[2].slice(26)}` === sender && BigInt(l.data.slice(0, 66)) === BigInt(op.nonce));
  // A relaying contract may have left it out of what it passed on (or the transaction's input wasn't the bundle).
  if (!event) return skip('no UserOperationEvent for it in its receipt');
  const succeeded = BigInt(`0x${event.data.slice(66, 130)}`) === 1n, actualGasCost = BigInt(`0x${event.data.slice(130, 194)}`), actualGasUsed = BigInt(`0x${event.data.slice(194, 258)}`);
  const whole = p.decoding.notes.some(x => /whole operation was simulated/.test(x));
  const unread = p.decoding.notes.map(x => /the balances couldn't be read after it: (.*)\); the final result/.exec(x)?.[1]).find(Boolean);
  const reverts = p.warnings.some(w => ['userop_execution_reverts', 'userop_postop_reverts', 'safe_tx_reverts'].includes(w.code));
  const rejected = p.warnings.find(w => w.code === 'userop_rejected')?.message;
  const fallbackNote = p.decoding.notes.find(x => /validation reverts on a stand-in/.test(x));
  const simCost = p.details.find(d => d.label === 'Gas cost (simulated)')?.raw;
  const moved = new Map<string, bigint>(), fees = new Map<string, bigint>();
  const paymaster = op.paymasterAndData.length >= 42 ? `0x${op.paymasterAndData.slice(2, 42)}`.toLowerCase() : null;
  // The operation's own part of the receipt: the bundle's validation (up to BeforeExecution), and what ran from the
  // previous operation's UserOperationEvent to its own. Another operation of the bundle can move this account's
  // tokens too: in a bundle of six on BNB Chain each account's operation sent on what the one before had sent it,
  // and across the whole receipt each account had moved nothing.
  const ownEvent = r.logs.indexOf(event), isEp = (l: { address: string }) => l.address.toLowerCase() === EP;
  const validated = r.logs.findIndex(l => isEp(l) && l.topics[0] === BEFORE_EXECUTION);
  const previous = r.logs.slice(0, ownEvent).map((l, i) => (isEp(l) && l.topics[0] === UOE ? i : -1)).filter(i => i >= 0).at(-1) ?? validated;
  const own = r.logs.filter((_, i) => i <= validated || (i > previous && i <= ownEvent));
  // (Only a token's: a staking contract's or vault's Deposit(address,uint256) has WETH9's signature too, and moves no
  // token of the account's. One that answers decimals() is taken as a token.)
  for (const l of own) if ((l.topics[0] === DEPOSIT || l.topics[0] === WITHDRAWAL) && l.topics.length === 2 && `0x${l.topics[1].slice(26)}` === sender && await tokenLike(l.address.toLowerCase())) {
    const token = l.address.toLowerCase(), v = BigInt(l.data.slice(0, 66));
    moved.set(token, (moved.get(token) ?? 0n) + (l.topics[0] === DEPOSIT ? v : -v));
  }
  // (Not the chain's own log of a native transfer, from Glamsterdam on: tokens are what is compared here.)
  // The fee in a token: what the paymaster took, sent to it or (followed by the paymaster's own event, its postOp's)
  // to where it keeps its fees, a treasury (Pimlico's singleton paymaster: its charge to the treasury in its data,
  // then UserOperationSponsored); else the smallest transfer out. An operation on Ethereum sent 0.1 USDC into a swap
  // and paid 0.39 USDC to the treasury: the swap, taken as the fee, left a quarter of the rounding allowed.
  const charged = new Set<string>();
  own.forEach((l, i) => {
    if (l.topics[0] !== TRANSFER || l.topics.length !== 3 || l.address.toLowerCase() === NATIVE_LOG_ADDRESS) return;
    const from = `0x${l.topics[1].slice(26)}`, to = `0x${l.topics[2].slice(26)}`, token = l.address.toLowerCase(), v = BigInt(l.data);
    if (from === sender) {
      moved.set(token, (moved.get(token) ?? 0n) - v);
      if (paymaster && (to === paymaster || own[i + 1]?.address.toLowerCase() === paymaster)) { fees.set(token, charged.has(token) ? fees.get(token)! + v : v); charged.add(token); }
      else if (!charged.has(token) && (!fees.has(token) || v < fees.get(token)!)) fees.set(token, v);
    }
    if (to === sender) moved.set(token, (moved.get(token) ?? 0n) + v);
  });
  for (const [k, v] of moved) if (v === 0n) moved.delete(k);
  // Simulated movements only: a preview whose calls revert shows what they ask for (basis 'requested'), with a warning.
  const simulated = new Map((p.assetChanges ?? []).filter(c => c.asset && c.asset !== 'native' && c.raw && c.basis !== 'requested').map(c => [c.asset!.toLowerCase(), (c.direction === 'out' ? -1n : 1n) * BigInt(c.raw!)]));
  const tokens = [...new Set([...moved.keys(), ...simulated.keys()])].map(t => ({ token: t, actual: (moved.get(t) ?? 0n).toString(), simulated: (simulated.get(t) ?? 0n).toString() }));
  const abs = (x: bigint) => (x < 0n ? -x : x);
  // A gas-priced fee (a paymaster's, or a fee collector's) moves with the gas: within 1% of the smallest transfer out.
  // A share-based token's balance can move a base unit or two from the amount its Transfer event logs: the preview reads
  // balances, the receipt side here reads events. A gas-priced fee moves with the gas: within 1% for its rounding, and
  // for an operation in a bundle of several (whose gas comes out higher, above) by its gas difference too.
  // What the operation paid for gas; for a gasless one (it paid nothing: its bundler bears the cost), the gas it used.
  const simUsed = p.details.find(d => d.label === 'Gas used (simulated)')?.raw;
  const gasCompared = actualGasCost > 0n ? (simCost !== undefined ? { simulated: simCost, actual: actualGasCost } : undefined) : simUsed !== undefined && actualGasUsed > 0n ? { simulated: simUsed, actual: actualGasUsed, gasless: true } : undefined;
  const gasPercent = gasCompared ? Number((BigInt(gasCompared.simulated) - gasCompared.actual) * 100_000n / gasCompared.actual) / 1000 : undefined;
  // (and for one run a second after its block, BNB Chain, whose gas isn't judged either, see below)
  // A paymaster's fee is priced on its own count of the gas, which can move further than the EntryPoint's: Pimlico's
  // singleton paymaster charges for the gas before its postOp, a fixed postOp gas and its own estimate of the
  // EntryPoint's penalty on unused execution gas: up to 14% more or less than the EntryPoint counts (over 6,040
  // of its operations on Ethereum); and the EntryPoint's penalty takes back a tenth of an execution gas difference
  // that the fee keeps. So the fee moves by up to 1.3 times the gas's percentage (the second of two operations in a
  // bundle, its paymaster's and token's state cold in the replay: USDC fee 17.1% high, its gas about 15%). Only for
  // the paymaster's fee (charged): the smallest transfer out, taken as the fee where no paymaster's is seen, moves by
  // the gas's percentage at most, else an amount that is wrong passes as a fee.
  const feeSlack = (token: string) => BigInt(Math.ceil(1 + ((ops.length > 1 || timeBumped || relayed) && gasPercent !== undefined ? (charged.has(token) ? 1.3 : 1) * Math.abs(gasPercent) : 0)));
  const feeLike = (t: { token: string; actual: string; simulated: string }) => fees.has(t.token) && abs(BigInt(t.simulated) - BigInt(t.actual)) * 100n <= fees.get(t.token)! * feeSlack(t.token);
  // Run a second after its block (BNB Chain): a swap's output or a reward can differ by that second, within a
  // ten-thousandth (as scripts/accuracy.ts allows).
  const secondLate = (t: { actual: string; simulated: string }) => timeBumped && abs(BigInt(t.simulated) - BigInt(t.actual)) * 10_000n <= abs(BigInt(t.actual));
  // A gas-priced fee taken inside an amount (a relayer keeping its fee from a swap's output before it reaches the
  // account, so no transfer of the account's shows it): the amount is off by less, in proportion, than the gas is,
  // and against the account when the simulated gas is higher. Three Ethereum swaps were 0.006-0.022% off so, their
  // gas 0.02-0.16% high.
  const feeInside = (t: { actual: string; simulated: string }) => {
    if (gasPercent === undefined || gasPercent === 0 || Math.abs(gasPercent) >= 5) return false;
    const d = BigInt(t.simulated) - BigInt(t.actual);
    return (d < 0n) === (gasPercent > 0) && abs(d) * 100_000n <= abs(BigInt(t.actual)) * BigInt(Math.ceil(Math.abs(gasPercent) * 1000));
  };
  const matchOf = () => tokens.every(t => t.actual === t.simulated) ? 'exact'
    : tokens.every(t => t.actual === t.simulated || feeLike(t) || feeInside(t)) ? 'fee'
    : tokens.every(t => abs(BigInt(t.simulated) - BigInt(t.actual)) <= 2n || feeLike(t) || secondLate(t)) ? 'units' : 'other';
  let tokenMatch = matchOf();
  // A token whose events don't account for its balances (a tax token on Base took 1% of a sale with no Transfer for
  // it): where the events and the preview disagree, the account's balance across the block decides, if it is what
  // the preview has (the account's other operations in the block would move it too, so only an exact match counts).
  let byBalance = 0, createdElsewhere = false;
  if (tokenMatch === 'other') {
    const balanceAt = async (token: string, tag: string) => { try { return BigInt(String(await rpc.call(CHAIN, 'eth_call', [{ to: token, data: `0x70a08231${sender.slice(2).padStart(64, '0')}` }, tag]))); } catch { return undefined; } };
    for (const t of tokens.filter(x => x.actual !== x.simulated)) {
      const before = await balanceAt(t.token, parent), after = await balanceAt(t.token, r.blockNumber);
      if (before !== undefined && after !== undefined && (after - before).toString() === t.simulated) { t.actual = t.simulated; byBalance++; }
    }
    if (byBalance) tokenMatch = matchOf();
  }
  // A token the operation creates can land at another address in the simulation than it did on-chain (where a
  // contract is created can follow from who sends the bundle: an operation on Base minted itself a new token at a
  // different address in each replay). The preview says so; here the two count as one when neither token existed
  // before the block and the amounts are the same.
  if (tokenMatch === 'other') {
    const absent = async (token: string) => { try { return String(await rpc.call(CHAIN, 'eth_getCode', [token, parent])) === '0x'; } catch { return false; } };
    for (const a of tokens.filter(x => x.simulated === '0' && x.actual !== '0')) {
      const b = tokens.find(x => x.actual === '0' && x.simulated === a.actual);
      if (b && p.warnings.some(w => w.code === 'token_created_here') && await absent(a.token) && await absent(b.token)) { a.simulated = a.actual; tokens.splice(tokens.indexOf(b), 1); createdElsewhere = true; }
    }
    if (createdElsewhere) tokenMatch = matchOf();
  }
  rows.push({
    hash, block: n, kind, sender, ...(relayed && { relayedBy: relayed }), ...(ops.length > 1 && { bundle: { size: ops.length, index } }), signersTried: tried, ...(prefixDropped && { prefix: `dropped: ${prefixDropped}` }), outcome: succeeded === !reverts, succeeded, whole, standIn: whole ? (p.decoding.notes.some(x => STAND_IN_REJECTED.test(x)) ? 'rejected' : 'validated') : undefined,
    callsOnlyBecause: whole ? undefined : rejected ?? fallbackNote ?? (p.warnings.some(w => w.code === 'userop_account_no_code') ? 'no code at the account before the bundle (delegated in it)'
      : p.decoding.notes.find(x => /simulat/.test(x)) ?? "the simulation didn't run (the node refused or failed it)"),
    gas: gasCompared ? { simulated: gasCompared.simulated, actual: gasCompared.actual.toString(), percent: gasPercent, ...(gasCompared.gasless && { gasless: true }) } : undefined,
    // Without any simulation (the node refused it) there are no simulated movements to compare.
    ...(!ran(p) && { notSimulated: true }),
    ...(byBalance && { tokensByBalance: byBalance }), ...(createdElsewhere && { tokenCreated: true }),
    // The node didn't answer the reads of balances after the run (a public node rate limiting): the amounts are the
    // events', which the preview's note says, with the node's answer (src/evm/transaction.ts simulationNote).
    ...(unread && { unread }),
    tokens: tokens.length && ran(p) ? tokenMatch : undefined, tokenDiffs: tokenMatch === 'exact' || !ran(p) ? undefined : tokens.filter(t => t.actual !== t.simulated),
  });
  const row = rows.at(-1)!;
  // Run a second after its block (BNB Chain, above): its gas isn't judged, and an outcome that differs is reported.
  if (timeBumped) row.timeBumped = true;
  // Where the preview was wrong (not a shape the stand-in doesn't take, or a node refusing): an outcome it got
  // wrong; and, where it simulated the whole operation on the state the operation met, gas 5% or more off (for an
  // operation alone in its bundle, above) or token movements beyond rounding. Calls simulated alone leave out the gas
  // payment and any paymaster's charge, as their preview says; without the block's earlier transactions, amounts can
  // move. The summary (scripts/replay-summary.ts) reads this.
  // An outcome the preview got wrong while saying why it might (an account handed the stand-in signature while it
  // runs its calls, see userop_execution_reverts) is counted apart, as warned; with calls that didn't run as they
  // did, its gas and token movements aren't compared either.
  // So is one whose calls were simulated alone (validation reverted on the stand-in): what they meet without it isn't
  // what the operation met; a shape to add, not a wrong preview.
  const callsAlone = !row.whole && !row.notSimulated;
  const handedSignature = p.warnings.some(w => w.code === 'userop_execution_reverts' && /handed the whole operation, its signature included/.test(w.message));
  // And one replayed without its block's earlier transactions (the node refused them): it didn't meet what the
  // operation met, and an earlier transaction can be what made the operation fail (another keeper's bundle, above).
  const warned = !row.outcome && (timeBumped || callsAlone || handedSignature || !!row.prefix);
  // The preview's own warning first: on BNB Chain most such operations are also run a second late.
  if (warned) row.warned = handedSignature ? 'outcome' : callsAlone ? 'outcome (its calls simulated alone)' : row.prefix ? "outcome (replayed without its block's earlier transactions)" : 'outcome (run a second after its block)';
  const judged = row.whole === true && !row.prefix && !warned;
  // A passkey's assertion whose clientDataJSON carries the key Chrome adds to some at random
  // ("other_keys_can_be_added_here", 109 bytes; 35 of 163 of the bullbit.ai wallet's operations on Base): which
  // will get it isn't known before signing, and the stand-in has none. An account that reads clientDataJSON byte by
  // byte pays for it (the bullbit.ai wallet 30,296 gas, 4-7% of its operations' gas). Its gas is reported, not judged:
  // for that wallet only. For the others measured (ZeroDev's and Safe's passkeys) the key costs nothing measurable, and
  // not judging it hid real errors (190% and -23%, of stand-ins on another verification path).
  if (op.signature.toLowerCase().includes(CHROME_EXTRA_KEY) && await implementationOf(deps, CHAIN, sender) === BULLBIT_IMPLEMENTATION) row.passkeyExtraKey = true;
  const differs = row.notSimulated ? [] : [
    !row.outcome && !warned && 'outcome',
    // Not for an account that rejected the stand-in: its own signature check didn't run, which can be most of the gas
    // (a post-quantum SPHINCS+ wallet on Base, 40%); a shape to add, not a wrong preview, as for calls simulated alone.
    judged && !timeBumped && !relayed && row.standIn !== 'rejected' && !row.passkeyExtraKey && ops.length === 1 && gasPercent !== undefined && Math.abs(gasPercent) >= 5 && 'gas',
    // (Whether or not the node answered the balance reads after the run: both sides here are events, the receipt's
    // and, without the reads, the run's.)
    judged && row.tokens === 'other' && 'tokens',
  ].filter((x): x is string => !!x);
  // Run a second after its block (BNB Chain's node won't simulate a block in its parent's second), an amount can
  // move by more than a second's accrual: a price or fee that changes with the time (0.06% on a vault deposit after a
  // swap). The bundle is replayed then as the previewer replays a mined transaction (src/replay.ts): where its run a
  // second late, as the preview's was, missed its receipt and its run at its own time (on the node with the second's
  // earlier blocks, or in the local EVM) matched it, the second is what moved it, and the difference is reported, not
  // failed. A bundle that matches a second late too says the second didn't: that fails, as does one that misses at
  // its own time.
  if (timeBumped && differs.includes('tokens')) {
    const again = await replayTransaction({ chainId: CHAIN, hash }, { trace: false }, replayDeps()).catch(() => null);
    if (again?.replay?.matches && again.decoding.notes.some(x => /run a second later there, the transaction didn't come out as its receipt says/.test(x))) {
      differs.splice(differs.indexOf('tokens'), 1);
      row.tokensAtOwnTime = true;
      row.warned = [row.warned, "tokens (run a second after its block; the bundle a second late missed its receipt, at its own time it matches)"].filter(Boolean).join('; ');
    }
  }
  if (differs.length) row.differs = differs;
  // --differing <dir>: each differing operation's row and preview, kept to look at once its state is gone.
  if (differs.length && arg('differing', '')) {
    mkdirSync(arg('differing', ''), { recursive: true });
    writeFileSync(`${arg('differing', '')}/${hash}${ops.length > 1 ? `-${index}` : ''}.json`, JSON.stringify({ row, preview: p }, null, 1));
  }
  process.stdout.write('.');
}

const head = Number(await call<string>('eth_blockNumber', []));
const pending = async (from: number, to: number) => [...new Set((await call<{ transactionHash: string }[]>('eth_getLogs', [{ address: EP, topics: [UOE], fromBlock: hex(BigInt(from)), toBlock: hex(BigInt(to)) }])).map(l => l.transactionHash))];
// Replays, CONCURRENCY at a time. On Ethereum, oldest first: a backfill's oldest blocks are the first whose state
// the node stops serving (about 128 blocks, 25 minutes), and the newest still have time. On Arbitrum, newest first:
// its 30 seconds of state are gone for anything queued behind.
const queue: string[] = [];
let active = 0;
const idle: (() => void)[] = [];
const pump = () => {
  while (active < CONCURRENCY && queue.length && rows.length + active < MAX) {
    const h = (NEWEST_FIRST ? queue.pop() : queue.shift())!;
    active++;
    replay(h).catch(e => skip(`error: ${(e as Error).message.slice(0, 80)}`)).finally(() => { active--; pump(); if (!active && (!queue.length || rows.length >= MAX)) idle.splice(0).forEach(f => f()); });
  }
};
const enqueue = (hashes: string[]) => { queue.push(...hashes); pump(); };
/** Next in line whichever way the queue runs: a bundle's later operations, while its block's state is there. */
const enqueueNext = (items: string[]) => { if (NEWEST_FIRST) queue.push(...items); else queue.unshift(...items); pump(); };
const drained = () => new Promise<void>(r => (active || (queue.length && rows.length < MAX) ? idle.push(r) : r()));
const ONE = arg('tx', '');
if (ONE) { enqueue([ONE]); await drained(); }
else if (!FOLLOW) { enqueue(await pending(head - BLOCKS, head - 1)); await drained(); }
else {
  const deadline = Date.now() + FOLLOW * 1000;
  let last = head;
  if (BACKFILL > 0) enqueue(await pending(head - BACKFILL, head));
  while (Date.now() < deadline && rows.length < MAX) {
    const now = Number(await call<string>('eth_blockNumber', []).catch(() => last));
    if (now <= last) { await new Promise(r => setTimeout(r, CHAIN === 1 ? 3000 : 500)); continue; }
    let hashes: string[];
    try { hashes = await pending(last + 1, now); } catch { await new Promise(r => setTimeout(r, 1000)); continue; }
    last = now;
    enqueue(hashes);
  }
  // What's under way finishes; what's queued past the deadline doesn't start.
  queue.length = 0;
  await drained();
}

const out = arg('out', '');
if (out) writeFileSync(out, JSON.stringify(rows, null, 1));
// Beside the report, why operations were skipped (scripts/replay-summary.ts counts them).
if (out) writeFileSync(out.replace(/(\.json)?$/, '.skipped.json'), JSON.stringify(skipped, null, 1));
const lines: string[] = [];
const say = (line: string) => { lines.push(line); console.log(line); };
const count = (f: (r: Row) => boolean) => rows.filter(f).length;
// Gas is compared for operations alone in their bundle, sent to the EntryPoint itself: in a bundle of several, state
// the earlier operations warmed in the same transaction is cold in a replay, so a later one's gas comes out a little
// higher; a bundler's contract relaying the bundle warms state before the EntryPoint runs (on Polygon, about 8,000 gas
// of an operation's, 1-3%), which a preview, not knowing the bundler, can't count.
const bundled = (r: Row) => !!r.bundle || !!r.relayedBy;
const g = (r: Row) => (bundled(r) ? undefined : r.gas as { percent: number } | undefined);
const bg = (r: Row) => (bundled(r) ? r.gas as { percent: number } | undefined : undefined);
const range = [...blocks].sort((a, b) => a - b);
console.log('');
say(`${rows.length} operations (${count(r => !bundled(r))} alone in their bundle, ${count(bundled)} in bundles of several) of EntryPoint v${VERSION} on ${chainName(CHAIN)}${range.length ? ` (blocks ${range[0]}-${range.at(-1)})` : ''}, replayed on the state before them${PREFIX ? ' (after their block\'s earlier transactions)' : ''}:`);
if (PREFIX && count(r => !!r.prefix)) say(`  (for ${count(r => !!r.prefix)}, without the block's earlier transactions: ${[...new Set(rows.filter(r => r.prefix).map(r => String(r.prefix).replace(/^dropped: /, '')))].join('; or ')})`);
say(`  outcome ${count(r => r.outcome === true)}/${rows.length} | ran whole ${count(r => r.whole === true)} (the stand-in validated for ${count(r => r.standIn === 'validated')}) | not simulated at all (the node refused) ${count(r => !!r.notSimulated)} | SafeOps ${count(r => r.kind === 'SafeOp')}`);
say(`  gas paid (for ${count(r => !!(g(r) as { gasless?: boolean } | undefined)?.gasless)} gasless operations, the gas used), of ${count(r => !!g(r))} compared: exact ${count(r => g(r)?.percent === 0)}, within 0.05% ${count(r => !!g(r) && g(r)!.percent !== 0 && Math.abs(g(r)!.percent) < 0.05)}, 0.5% ${count(r => !!g(r) && Math.abs(g(r)!.percent) >= 0.05 && Math.abs(g(r)!.percent) < 0.5)}, 5% ${count(r => !!g(r) && Math.abs(g(r)!.percent) >= 0.5 && Math.abs(g(r)!.percent) < 5)}, more ${count(r => !!g(r) && Math.abs(g(r)!.percent) >= 5)}`);
say(`  token movements, of ${count(r => !!r.tokens)}: exact ${count(r => r.tokens === 'exact')}, within a gas-priced fee's rounding ${count(r => r.tokens === 'fee')}, within 2 base units (a share token's rounding) ${count(r => r.tokens === 'units')}, other ${count(r => r.tokens === 'other')}`);
if (count(r => !!bg(r))) say(`  in bundles of several or relayed by a bundler's contract (${count(r => !!r.relayedBy)}), gas reported but not judged: of ${count(r => !!bg(r))}, within 0.5% ${count(r => !!bg(r) && Math.abs(bg(r)!.percent) < 0.5)}, 5% ${count(r => !!bg(r) && Math.abs(bg(r)!.percent) >= 0.5 && Math.abs(bg(r)!.percent) < 5)}, more ${count(r => !!bg(r) && Math.abs(bg(r)!.percent) >= 5)}`);
if (Object.keys(skipped).length) say(`  skipped: ${Object.entries(skipped).map(([k, v]) => `${k}: ${v}`).join('; ')}`);
for (const r of rows) {
  const issues = [!r.outcome && `outcome: simulated ${r.succeeded ? 'failing' : 'succeeding'}, the receipt ${r.succeeded ? 'succeeded' : 'failed'}`, !r.whole && `calls only: ${String(r.callsOnlyBecause ?? '').slice(0, 140)}`,
    r.standIn === 'rejected' && 'the account rejected the stand-in (signer unknown)', g(r) && Math.abs(g(r)!.percent) >= 0.5 && `gas ${g(r)!.percent}%${r.passkeyExtraKey ? " (its passkey's clientDataJSON has the key Chrome adds to some; not judged)" : ''}`, r.tokens === 'other' && `tokens ${JSON.stringify(r.tokenDiffs)}${r.tokensAtOwnTime ? ' (run a second after its block; the bundle a second late missed its receipt, at its own time it matches: not judged)' : ''}`].filter(Boolean);
  if (issues.length) say(`    ${r.hash} (${r.kind}): ${issues.join('; ')}`);
}

// The operations whose preview was wrong (each row's `differs`, set where it was replayed).
const wrong = rows.filter(r => (r.differs as string[] | undefined)?.length);
const md = arg('summary-md', '');
if (md) {
  const chain = chainName(CHAIN);
  const [title, ...rest] = lines;
  appendFileSync(md, `### ${chain}, EntryPoint v${VERSION}${wrong.length ? ` — ${wrong.length} differing from the receipts` : ''}\n\n${title}\n\n\`\`\`\n${rest.join('\n')}\n\`\`\`\n\n`);
}
if (STRICT && wrong.length) { console.error(`${wrong.length} operation(s) differ from their receipts`); process.exitCode = 1; }
