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
import { decodeAbiParameters, decodeFunctionData, decodeFunctionResult, encodeFunctionData, hashMessage, hashTypedData, parseAbi, recoverAddress, type Hex } from 'viem';
import { recoverAuthorizationAddress } from 'viem/utils';
import { previewRequest } from '../src/preview.ts';
import { liveDependencies } from '../src/server.ts';
import { RpcSimulator } from '../src/simulation.ts';
import { JsonRpcClient } from '../src/rpc.ts';
import { readOperation, userOpHash } from '../src/userop-hash.ts';
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
const call = <T>(method: string, params: unknown[]) => rpc.call(CHAIN, method, params) as Promise<T>;

const OP = VERSION === '0.6'
  ? '(address sender, uint256 nonce, bytes initCode, bytes callData, uint256 callGasLimit, uint256 verificationGasLimit, uint256 preVerificationGas, uint256 maxFeePerGas, uint256 maxPriorityFeePerGas, bytes paymasterAndData, bytes signature)'
  : '(address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature)';
const HANDLE_OPS = parseAbi([`function handleOps(${OP}[] ops, address beneficiary)`]);
type Op = { sender: Hex; nonce: bigint; initCode: Hex; callData: Hex; callGasLimit?: bigint; verificationGasLimit?: bigint; accountGasLimits?: Hex; preVerificationGas: bigint; maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint; gasFees?: Hex; paymasterAndData: Hex; signature: Hex };
const UOE = '0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
/** WETH-style wrappers' Deposit(dst, wad) and Withdrawal(src, wad): their balance changes without a Transfer. */
const DEPOSIT = '0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c', WITHDRAWAL = '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65';
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
  return [...(sig.length === 2 + 131 * 2 ? [`0x${sig.slice(4, 4 + 130)}` as Hex] : []), ...(sig.length >= 132 ? [`0x${sig.slice(-130)}` as Hex] : [])];
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

/** How many operations of one bundle are replayed (each after the bundle's earlier ones). */
const BUNDLE_MAX = 5;
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
  type Receipt = { transactionHash: string; blockNumber: Hex; logs: { address: string; topics: Hex[]; data: Hex }[] };
  const r = await call<Receipt>('eth_getTransactionReceipt', [hash]).catch(async () => (await call<Receipt[]>('eth_getBlockReceipts', [tx.blockNumber])).find(x => x.transactionHash.toLowerCase() === hash.toLowerCase())!);
  if (!r) return skip('its receipt could not be read');
  const n = Number(r.blockNumber), parent = hex(BigInt(n - 1));
  const block = await call<{ number: Hex; timestamp: Hex; miner: string; mixHash: Hex; difficulty?: Hex; gasLimit: Hex; baseFeePerGas: Hex; transactions: { hash: string; from: string; to: string | null; input: Hex; value: Hex; gas: Hex; type: string; authorizationList?: unknown[] }[] }>('eth_getBlockByNumber', [r.blockNumber, PREFIX]);
  // Arbitrum's public RPC keeps about 30 seconds of state, OP Mainnet's and Polygon's about two minutes: an operation
  // whose block is older by the time its turn comes would lose its state partway through the replay (the stand-in's
  // shape, the operation's hash, the simulation itself), and is skipped rather than replayed on part of it.
  if (STATE_SECONDS[CHAIN] && !ONE && Date.now() / 1000 - Number(block.timestamp) > STATE_SECONDS[CHAIN]) return skip(`its block was too old for the node by its turn (${chainName(CHAIN)}'s public node keeps about ${CHAIN === 42161 ? '30 seconds' : 'two minutes'})`);
  blocks.add(n);
  // The block's earlier transactions (--prefix), without their gas limits: the node charges each what it uses, and
  // the simulated block's gas limit holds them as it held the real ones.
  // An OP Stack block's L1 info deposit (its first transaction) stays: the L1 values it sets are what a paymaster
  // pricing L1 data reads (a bundle on OP Mainnet came out 0.47% low on the parent block's).
  const before: SimulationRequest[] = PREFIX ? block.transactions.slice(0, Number(tx.transactionIndex)).filter(t => !SYSTEM.has(t.type) || t.from.toLowerCase() === L1_INFO_DEPOSITOR).slice(-400)
    .map(t => ({ chainId: CHAIN, from: t.from.toLowerCase(), to: t.to, data: t.input, value: BigInt(t.value), ...(t.authorizationList?.length && { authorizationList: t.authorizationList as SimulationRequest['authorizationList'] }) })) : [];
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
  before.push(...essential);
  // Reads on the parent block, and the block itself for its header (the base fee the operation's gas is priced at).
  const atParent = { has: (c: number) => c === CHAIN, call: (c: number, m: string, ps: unknown[]) => m === 'eth_getBlockByNumber' ? rpc.call(c, m, [r.blockNumber, false])
    : m === 'eth_getCode' && delegation && String(ps[0]).toLowerCase() === sender ? Promise.resolve(delegation) : rpc.call(c, m, ps.map(x => x === 'latest' ? parent : x)) };
  // The block's header, but not its gas limit: public nodes refuse a simulated block above their RPC gas cap (50M on
  // publicnode, below Ethereum's 60M), and the parent's limit, the node's default, is all but the same.
  let prefix = before; // dropped if the node refuses the block with it (see below)
  // The block's own time; BNB Chain's node refuses a simulated block in its parent's second (its blocks come faster
  // than one a second), which then runs a second later, and its gas isn't judged (what writes once a second costs
  // more). The block's DIFFICULTY as each node takes it: BNB Chain's from prevRandao (the block's difficulty there, 2
  // when its validator was in turn; mixHash holds milliseconds), Polygon's from a difficulty override (see
  // scripts/accuracy.ts).
  let time: string = block.timestamp, timeBumped = false;
  if (CHAIN === 56) {
    const parentTime = BigInt((await call<{ timestamp: Hex }>('eth_getBlockByNumber', [parent, false])).timestamp);
    if (BigInt(block.timestamp) <= parentTime) { time = hex(parentTime + 1n); timeBumped = true; }
  }
  const difficulty = block.difficulty ?? '0x0';
  const randomness: Record<string, string> = CHAIN === 56 ? { prevRandao: `0x${BigInt(difficulty).toString(16).padStart(64, '0')}` } : CHAIN === 137 ? { prevRandao: block.mixHash, difficulty } : { prevRandao: block.mixHash };
  const simulator = new RpcSimulator({ [CHAIN]: URL_ }, { replay: () => ({ block: parent, blockOverrides: { number: block.number, time, feeRecipient: block.miner, ...randomness, baseFeePerGas: block.baseFeePerGas }, before: prefix, warm }) });
  const deps = { ...liveDependencies({ [EVM_RPCS[CHAIN].env]: URL_, SIGNING_PREVIEW_FORK_CACHE: 'off' }, { warmUp: false }), rpc: atParent, simulator };
  const context = { chainId: CHAIN, now: Number(block.timestamp) * 1000 };
  // A node that no longer serves the parent block's state (Ethereum's public RPC keeps about 128 blocks) would leave
  // the preview reading nothing: the operation is skipped rather than replayed on missing state.
  let code: string;
  try { code = String(await atParent.call(CHAIN, 'eth_getCode', [sender, 'latest'])); } catch { return skip('its state is no longer served by the node'); }
  // A Kernel v3 account's operation in enable mode (its nonce's first byte 0x01): the owner signs, as typed data, the
  // validator or permission it installs, which signs the operation (a dApp's session key, mostly). No wallet signs
  // the operation's hash.
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
  for (const inner of module ? [] : innerSignatures(op.signature)) for (const h of [hashMessage({ raw: digest }), digest]) {
    try {
      const a = (await recoverAddress({ hash: h, signature: inner })).toLowerCase();
      if (h === digest && !signers.includes(a)) bare.add(a);
      add(a);
    } catch { /* not ECDSA */ }
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
    if (!ran(p) && prefix.length > essential.length) { prefix = essential; prefixDropped = 'the node refused the block with them'; p = await previewRequest(request(signer), ctx, deps); }
    // A full block's earlier transactions can use nearly all of the node's gas cap for a simulated block (publicnode's
    // 50M, under Ethereum's 60M blocks), leaving the operation too little: the EntryPoint runs out of gas (AA95),
    // which on-chain it didn't. Then without them.
    const outOfGas = (q: Preview) => q.warnings.some(w => w.code === 'userop_rejected' && /\bAA95\b/.test(w.message));
    if (outOfGas(p) && prefix.length > essential.length) { prefix = essential; prefixDropped = "they left too little of the node's gas cap for the operation"; p = await previewRequest(request(signer), ctx, deps); }
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
  const succeeded = BigInt(`0x${event.data.slice(66, 130)}`) === 1n, actualGasCost = BigInt(`0x${event.data.slice(130, 194)}`);
  const whole = p.decoding.notes.some(x => /whole operation was simulated/.test(x));
  const reverts = p.warnings.some(w => ['userop_execution_reverts', 'userop_postop_reverts', 'safe_tx_reverts'].includes(w.code));
  const rejected = p.warnings.find(w => w.code === 'userop_rejected')?.message;
  const fallbackNote = p.decoding.notes.find(x => /validation reverts on a stand-in/.test(x));
  const simCost = p.details.find(d => d.label === 'Gas cost (simulated)')?.raw;
  const moved = new Map<string, bigint>(), fees = new Map<string, bigint>();
  const paymaster = op.paymasterAndData.length >= 42 ? `0x${op.paymasterAndData.slice(2, 42)}`.toLowerCase() : null;
  for (const l of r.logs) if ((l.topics[0] === DEPOSIT || l.topics[0] === WITHDRAWAL) && l.topics.length === 2 && `0x${l.topics[1].slice(26)}` === sender) {
    const token = l.address.toLowerCase(), v = BigInt(l.data.slice(0, 66));
    moved.set(token, (moved.get(token) ?? 0n) + (l.topics[0] === DEPOSIT ? v : -v));
  }
  for (const l of r.logs) if (l.topics[0] === TRANSFER && l.topics.length === 3) {
    const from = `0x${l.topics[1].slice(26)}`, to = `0x${l.topics[2].slice(26)}`, token = l.address.toLowerCase(), v = BigInt(l.data);
    if (from === sender) { moved.set(token, (moved.get(token) ?? 0n) - v); if (to === paymaster || !fees.has(token) || v < fees.get(token)!) fees.set(token, v); }
    if (to === sender) moved.set(token, (moved.get(token) ?? 0n) + v);
  }
  for (const [k, v] of moved) if (v === 0n) moved.delete(k);
  // Simulated movements only: a preview whose calls revert shows what they ask for (basis 'requested'), with a warning.
  const simulated = new Map((p.assetChanges ?? []).filter(c => c.asset && c.asset !== 'native' && c.raw && c.basis !== 'requested').map(c => [c.asset!.toLowerCase(), (c.direction === 'out' ? -1n : 1n) * BigInt(c.raw!)]));
  const tokens = [...new Set([...moved.keys(), ...simulated.keys()])].map(t => ({ token: t, actual: (moved.get(t) ?? 0n).toString(), simulated: (simulated.get(t) ?? 0n).toString() }));
  const abs = (x: bigint) => (x < 0n ? -x : x);
  // A gas-priced fee (a paymaster's, or a fee collector's) moves with the gas: within 1% of the smallest transfer out.
  // A share-based token's balance can move a base unit or two from the amount its Transfer event logs: the preview reads
  // balances, the receipt side here reads events. A gas-priced fee moves with the gas: within 1% for its rounding, and
  // for an operation in a bundle of several (whose gas comes out higher, above) by its gas difference too.
  const gasPercent = simCost !== undefined && actualGasCost > 0n ? Number((BigInt(simCost) - actualGasCost) * 100_000n / actualGasCost) / 1000 : undefined;
  // (and for one run a second after its block, BNB Chain, whose gas isn't judged either, see below)
  const feeSlack = BigInt(Math.ceil(1 + ((ops.length > 1 || timeBumped || relayed) && gasPercent !== undefined ? Math.abs(gasPercent) : 0)));
  const feeLike = (t: { token: string; actual: string; simulated: string }) => fees.has(t.token) && abs(BigInt(t.simulated) - BigInt(t.actual)) * 100n <= fees.get(t.token)! * feeSlack;
  const tokenMatch = tokens.every(t => t.actual === t.simulated) ? 'exact'
    : tokens.every(t => t.actual === t.simulated || feeLike(t)) ? 'fee'
    : tokens.every(t => abs(BigInt(t.simulated) - BigInt(t.actual)) <= 2n || feeLike(t)) ? 'units' : 'other';
  rows.push({
    hash, block: n, kind, sender, ...(relayed && { relayedBy: relayed }), ...(ops.length > 1 && { bundle: { size: ops.length, index } }), signersTried: tried, ...(prefixDropped && { prefix: `dropped: ${prefixDropped}` }), outcome: succeeded === !reverts, succeeded, whole, standIn: whole ? (p.decoding.notes.some(x => STAND_IN_REJECTED.test(x)) ? 'rejected' : 'validated') : undefined,
    callsOnlyBecause: whole ? undefined : rejected ?? fallbackNote ?? (p.warnings.some(w => w.code === 'userop_account_no_code') ? 'no code at the account before the bundle (delegated in it)'
      : p.decoding.notes.find(x => /simulat/.test(x)) ?? "the simulation didn't run (the node refused or failed it)"),
    gas: simCost !== undefined && actualGasCost > 0n ? { simulated: simCost, actual: actualGasCost.toString(), percent: Number((BigInt(simCost) - actualGasCost) * 100_000n / actualGasCost) / 1000 } : undefined,
    // Without any simulation (the node refused it) there are no simulated movements to compare.
    ...(!ran(p) && { notSimulated: true }),
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
  const warned = !row.outcome && (timeBumped || callsAlone || p.warnings.some(w => w.code === 'userop_execution_reverts' && /handed the whole operation, its signature included/.test(w.message)));
  if (warned) row.warned = timeBumped ? 'outcome (run a second after its block)' : callsAlone ? 'outcome (its calls simulated alone)' : 'outcome';
  const judged = row.whole === true && !row.prefix && !warned;
  const differs = row.notSimulated ? [] : [
    !row.outcome && !warned && 'outcome',
    // Not for an account that rejected the stand-in: its own signature check didn't run, which can be most of the gas
    // (a post-quantum SPHINCS+ wallet on Base, 40%); a shape to add, not a wrong preview, as for calls simulated alone.
    judged && !timeBumped && !relayed && row.standIn !== 'rejected' && ops.length === 1 && gasPercent !== undefined && Math.abs(gasPercent) >= 5 && 'gas',
    judged && row.tokens === 'other' && 'tokens',
  ].filter((x): x is string => !!x);
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
say(`  gas paid, of ${count(r => !!g(r))} compared: exact ${count(r => g(r)?.percent === 0)}, within 0.05% ${count(r => !!g(r) && g(r)!.percent !== 0 && Math.abs(g(r)!.percent) < 0.05)}, 0.5% ${count(r => !!g(r) && Math.abs(g(r)!.percent) >= 0.05 && Math.abs(g(r)!.percent) < 0.5)}, 5% ${count(r => !!g(r) && Math.abs(g(r)!.percent) >= 0.5 && Math.abs(g(r)!.percent) < 5)}, more ${count(r => !!g(r) && Math.abs(g(r)!.percent) >= 5)}`);
say(`  token movements, of ${count(r => !!r.tokens)}: exact ${count(r => r.tokens === 'exact')}, within a gas-priced fee's rounding ${count(r => r.tokens === 'fee')}, within 2 base units (a share token's rounding) ${count(r => r.tokens === 'units')}, other ${count(r => r.tokens === 'other')}`);
if (count(r => !!bg(r))) say(`  in bundles of several or relayed by a bundler's contract (${count(r => !!r.relayedBy)}), gas reported but not judged: of ${count(r => !!bg(r))}, within 0.5% ${count(r => !!bg(r) && Math.abs(bg(r)!.percent) < 0.5)}, 5% ${count(r => !!bg(r) && Math.abs(bg(r)!.percent) >= 0.5 && Math.abs(bg(r)!.percent) < 5)}, more ${count(r => !!bg(r) && Math.abs(bg(r)!.percent) >= 5)}`);
if (Object.keys(skipped).length) say(`  skipped: ${Object.entries(skipped).map(([k, v]) => `${k}: ${v}`).join('; ')}`);
for (const r of rows) {
  const issues = [!r.outcome && `outcome: simulated ${r.succeeded ? 'failing' : 'succeeding'}, the receipt ${r.succeeded ? 'succeeded' : 'failed'}`, !r.whole && `calls only: ${String(r.callsOnlyBecause ?? '').slice(0, 140)}`,
    r.standIn === 'rejected' && 'the account rejected the stand-in (signer unknown)', g(r) && Math.abs(g(r)!.percent) >= 0.5 && `gas ${g(r)!.percent}%`, r.tokens === 'other' && `tokens ${JSON.stringify(r.tokenDiffs)}`].filter(Boolean);
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
