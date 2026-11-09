// npm run accuracy:4337 -- [--chain 1|42161] [--entrypoint 0.6|0.7|0.8|0.9] [--follow 1200 | --blocks 100 | --tx 0x…] [--max 30] [--no-prefix] [--out report.json]
//
// How accurate whole-operation simulation is (src/erc4337-sim.ts), measured against what happened. Recent
// single-operation bundles of an EntryPoint are rebuilt as the request their owner signed:
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
import { writeFileSync } from 'node:fs';
import { decodeAbiParameters, decodeFunctionData, hashMessage, hashTypedData, parseAbi, recoverAddress, type Hex } from 'viem';
import { recoverAuthorizationAddress } from 'viem/utils';
import { previewRequest } from '../src/preview.ts';
import { liveDependencies } from '../src/server.ts';
import { RpcSimulator } from '../src/simulation.ts';
import { JsonRpcClient } from '../src/rpc.ts';
import { readOperation, userOpHash } from '../src/userop-hash.ts';
import { SAFE_4337_MODULES } from '../src/typed-data/safe.ts';
import type { Preview, SimulationRequest } from '../src/types.ts';

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const CHAIN = Number(arg('chain', '1')), VERSION = arg('entrypoint', '0.7'), FOLLOW = Number(arg('follow', '0')), BLOCKS = Number(arg('blocks', '100')), MAX = Number(arg('max', '30'));
const PREFIX = !process.argv.includes('--no-prefix');
const URL_ = CHAIN === 42161 ? process.env.ARBITRUM_RPC_URL ?? 'https://arb1.arbitrum.io/rpc' : process.env.ETHEREUM_RPC_URL ?? 'https://ethereum-rpc.publicnode.com';
const ENTRY_POINTS: Record<string, string> = { '0.6': '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789', '0.7': '0x0000000071727de22e5e9d8baf0edac6f37da032', '0.8': '0x4337084d9e255ff0702461cf8895ce9e3b5ff108', '0.9': '0x433709009b8330fda32311df1c2afa402ed8d009' };
const EP = ENTRY_POINTS[VERSION];
if (!EP) throw new Error(`--entrypoint is one of ${Object.keys(ENTRY_POINTS).join(', ')}`);
const SYSTEM = CHAIN === 42161 ? new Set(['0x64', '0x65', '0x66', '0x68', '0x69', '0x6a']) : new Set<string>();
const rpc = new JsonRpcClient({ [CHAIN]: URL_ }, { timeoutMs: 30_000, retries: 6, retryDelayMs: 800 });
const call = <T>(method: string, params: unknown[]) => rpc.call(CHAIN, method, params) as Promise<T>;

const OP = VERSION === '0.6'
  ? '(address sender, uint256 nonce, bytes initCode, bytes callData, uint256 callGasLimit, uint256 verificationGasLimit, uint256 preVerificationGas, uint256 maxFeePerGas, uint256 maxPriorityFeePerGas, bytes paymasterAndData, bytes signature)'
  : '(address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature)';
const HANDLE_OPS = parseAbi([`function handleOps(${OP}[] ops, address beneficiary)`]);
type Op = { sender: Hex; nonce: bigint; initCode: Hex; callData: Hex; callGasLimit?: bigint; verificationGasLimit?: bigint; accountGasLimits?: Hex; preVerificationGas: bigint; maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint; gasFees?: Hex; paymasterAndData: Hex; signature: Hex };
const UOE = '0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
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
/** The ECDSA signature inside the operation's: a Coinbase Smart Wallet's SignatureWrapper, or its last 65 bytes. */
function innerSignature(sig: Hex): Hex | null {
  try { const [w] = decodeAbiParameters([{ type: 'tuple', components: [{ name: 'ownerIndex', type: 'uint256' }, { name: 'signatureData', type: 'bytes' }] }], sig); if (w.signatureData.length === 132) return w.signatureData; } catch { /* not a wrapper */ }
  return sig.length >= 132 ? `0x${sig.slice(-130)}` : null;
}

type Row = Record<string, unknown>;
const rows: Row[] = [];
const blocks = new Set<number>();
const skipped: Record<string, number> = {};
const skip = (why: string) => { skipped[why] = (skipped[why] ?? 0) + 1; };
const STAND_IN_REJECTED = /doesn't accept it as theirs/;

async function replay(hash: string): Promise<void> {
  const tx = await call<{ from: string; to: string | null; input: Hex; transactionIndex: Hex; blockNumber: Hex; authorizationList?: NonNullable<SimulationRequest['authorizationList']> }>('eth_getTransactionByHash', [hash]);
  if (tx.to?.toLowerCase() !== EP) return skip('not a handleOps transaction to the EntryPoint');
  let ops: readonly Op[];
  try { ops = decodeFunctionData({ abi: HANDLE_OPS, data: tx.input }).args[0] as unknown as Op[]; } catch { return skip('not handleOps'); }
  if (ops.length !== 1) return skip('a bundle of several operations');
  const op = ops[0], sender = op.sender.toLowerCase();
  const r = await call<{ blockNumber: Hex; logs: { address: string; topics: Hex[]; data: Hex }[] }>('eth_getTransactionReceipt', [hash]);
  const n = Number(r.blockNumber), parent = hex(BigInt(n - 1));
  const block = await call<{ number: Hex; timestamp: Hex; miner: string; mixHash: Hex; gasLimit: Hex; baseFeePerGas: Hex; transactions: { hash: string; from: string; to: string | null; input: Hex; value: Hex; gas: Hex; type: string; authorizationList?: unknown[] }[] }>('eth_getBlockByNumber', [r.blockNumber, PREFIX]);
  blocks.add(n);
  // The block's earlier transactions (--prefix), without their gas limits: the node charges each what it uses, and
  // the simulated block's gas limit holds them as it held the real ones.
  const before: SimulationRequest[] = PREFIX ? block.transactions.slice(0, Number(tx.transactionIndex)).filter(t => !SYSTEM.has(t.type)).slice(-400)
    .map(t => ({ chainId: CHAIN, from: t.from.toLowerCase(), to: t.to, data: t.input, value: BigInt(t.value), ...(t.authorizationList?.length && { authorizationList: t.authorizationList as SimulationRequest['authorizationList'] }) })) : [];
  // An account the bundle itself delegates (EIP-7702, in the bundle transaction's own authorizations): the
  // authorizations apply first, as they do on-chain, and the account's code reads as the delegation.
  // The authorities are warm in the bundle transaction from its start (EIP-7702), so they are in the replay too.
  let delegation: string | undefined;
  const warm: string[] = [];
  if (tx.authorizationList?.length) {
    before.push({ chainId: CHAIN, from: tx.from.toLowerCase(), to: tx.from.toLowerCase(), data: '0x', value: 0n, authorizationList: tx.authorizationList });
    for (const a of tx.authorizationList) {
      try {
        const authority = (await recoverAuthorizationAddress({ authorization: { address: a.address as Hex, chainId: Number(a.chainId), nonce: Number(a.nonce) }, signature: { r: a.r as Hex, s: a.s as Hex, yParity: Number(a.yParity) } })).toLowerCase();
        warm.push(authority);
        if (authority === sender) delegation = `0xef0100${a.address.slice(2).toLowerCase()}`;
      } catch { /* unreadable */ }
    }
  }
  // Reads on the parent block, and the block itself for its header (the base fee the operation's gas is priced at).
  const atParent = { has: (c: number) => c === CHAIN, call: (c: number, m: string, ps: unknown[]) => m === 'eth_getBlockByNumber' ? rpc.call(c, m, [r.blockNumber, false])
    : m === 'eth_getCode' && delegation && String(ps[0]).toLowerCase() === sender ? Promise.resolve(delegation) : rpc.call(c, m, ps.map(x => x === 'latest' ? parent : x)) };
  // The block's header, but not its gas limit: public nodes refuse a simulated block above their RPC gas cap (50M on
  // publicnode, below Ethereum's 60M), and the parent's limit, the node's default, is all but the same.
  let prefix = before; // dropped if the node refuses the block with it (see below)
  const simulator = new RpcSimulator({ [CHAIN]: URL_ }, { replay: () => ({ block: parent, blockOverrides: { number: block.number, time: block.timestamp, feeRecipient: block.miner, prevRandao: block.mixHash, baseFeePerGas: block.baseFeePerGas }, before: prefix, warm }) });
  const deps = { ...liveDependencies({ [CHAIN === 42161 ? 'ARBITRUM_RPC_URL' : 'ETHEREUM_RPC_URL']: URL_, SIGNING_PREVIEW_FORK_CACHE: 'off' }, { warmUp: false }), rpc: atParent, simulator };
  const context = { chainId: CHAIN, now: Number(block.timestamp) * 1000 };
  const code = String(await atParent.call(CHAIN, 'eth_getCode', [sender, 'latest']).catch(() => '0x'));

  // The request the owner signed, and who might have signed it.
  const fallback = `0x${String(await atParent.call(CHAIN, 'eth_getStorageAt', [sender, FALLBACK_SLOT, 'latest']).catch(() => '0x')).slice(-40)}`.toLowerCase();
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
    request = signer => ({ method: 'personal_sign', params: [digest, signer] });
  } else {
    kind = 'typed';
    // SDKs put an EIP-7702 account's delegate where the EntryPoint receives the 0x7702 marker.
    const initCode = op.initCode.startsWith('0x7702') && code.startsWith('0xef0100') ? `0x${code.slice(8)}${op.initCode.slice(42)}` : op.initCode;
    const typed = { domain: { name: 'ERC4337', version: '1', chainId: CHAIN, verifyingContract: EP }, types: PACKED_TYPES, primaryType: 'PackedUserOperation',
      message: { sender, nonce: op.nonce.toString(), initCode, callData: op.callData, accountGasLimits: op.accountGasLimits, preVerificationGas: op.preVerificationGas.toString(), gasFees: op.gasFees, paymasterAndData: op.paymasterAndData } };
    digest = hashTypedData(typed as never);
    request = signer => ({ method: 'eth_signTypedData_v4', params: [signer, JSON.stringify(typed)] });
  }
  const signers: string[] = [];
  const add = (a: string | undefined) => { if (a && /^0x[0-9a-f]{40}$/.test(a) && !/^0x0+$/.test(a) && !signers.includes(a)) signers.push(a); };
  if (code.startsWith('0xef0100')) add(sender);
  const inner = module ? null : innerSignature(op.signature);
  if (inner) for (const h of [hashMessage({ raw: digest }), digest]) { try { add((await recoverAddress({ hash: h, signature: inner })).toLowerCase()); } catch { /* not ECDSA */ } }
  const owner = String(await atParent.call(CHAIN, 'eth_call', [{ to: sender, data: '0x8da5cb5b' }, 'latest']).catch(() => '0x'));
  if (/^0x0{24}[0-9a-f]{40}$/i.test(owner)) add(`0x${owner.slice(26)}`.toLowerCase());
  add(sender);
  let p!: Preview, tried = 0;
  // Public nodes refuse heavy simulations: with the block's earlier transactions, a full block can be one. The
  // preview then has no simulation at all, and runs again without them.
  const ran = (q: Preview) => q.decoding.notes.some(x => /simulat/.test(x)) || q.details.some(d => d.label === 'Gas cost (simulated)');
  let prefixDropped = false;
  for (const signer of signers.slice(0, 3)) {
    tried++;
    p = await previewRequest(request(signer), ctx, deps);
    if (!ran(p) && prefix.length) { prefix = tx.authorizationList?.length ? before.slice(-1) : []; prefixDropped = true; p = await previewRequest(request(signer), ctx, deps); }
    if (!p.decoding.notes.some(x => STAND_IN_REJECTED.test(x))) break;
  }

  // What happened, and what the preview says.
  const event = r.logs.find(l => l.address.toLowerCase() === EP && l.topics[0] === UOE && `0x${l.topics[2].slice(26)}` === sender)!;
  const succeeded = BigInt(`0x${event.data.slice(66, 130)}`) === 1n, actualGasCost = BigInt(`0x${event.data.slice(130, 194)}`);
  const whole = p.decoding.notes.some(x => /whole operation was simulated/.test(x));
  const reverts = p.warnings.some(w => ['userop_execution_reverts', 'userop_postop_reverts', 'safe_tx_reverts'].includes(w.code));
  const rejected = p.warnings.find(w => w.code === 'userop_rejected')?.message;
  const fallbackNote = p.decoding.notes.find(x => /validation reverts on a stand-in/.test(x));
  const simCost = p.details.find(d => d.label === 'Gas cost (simulated)')?.raw;
  const moved = new Map<string, bigint>(), fees = new Map<string, bigint>();
  const paymaster = op.paymasterAndData.length >= 42 ? `0x${op.paymasterAndData.slice(2, 42)}`.toLowerCase() : null;
  for (const l of r.logs) if (l.topics[0] === TRANSFER && l.topics.length === 3) {
    const from = `0x${l.topics[1].slice(26)}`, to = `0x${l.topics[2].slice(26)}`, token = l.address.toLowerCase(), v = BigInt(l.data);
    if (from === sender) { moved.set(token, (moved.get(token) ?? 0n) - v); if (to === paymaster || !fees.has(token) || v < fees.get(token)!) fees.set(token, v); }
    if (to === sender) moved.set(token, (moved.get(token) ?? 0n) + v);
  }
  for (const [k, v] of moved) if (v === 0n) moved.delete(k);
  const simulated = new Map((p.assetChanges ?? []).filter(c => c.asset && c.asset !== 'native' && c.raw).map(c => [c.asset!.toLowerCase(), (c.direction === 'out' ? -1n : 1n) * BigInt(c.raw!)]));
  const tokens = [...new Set([...moved.keys(), ...simulated.keys()])].map(t => ({ token: t, actual: (moved.get(t) ?? 0n).toString(), simulated: (simulated.get(t) ?? 0n).toString() }));
  const abs = (x: bigint) => (x < 0n ? -x : x);
  // A gas-priced fee (a paymaster's, or a fee collector's) moves with the gas: within 1% of the smallest transfer out.
  const tokenMatch = tokens.every(t => t.actual === t.simulated) ? 'exact'
    : tokens.every(t => t.actual === t.simulated || (fees.has(t.token) && abs(BigInt(t.simulated) - BigInt(t.actual)) * 100n <= fees.get(t.token)!)) ? 'fee' : 'other';
  rows.push({
    hash, block: n, kind, sender, signersTried: tried, ...(prefixDropped && { prefix: 'dropped: the node refused the block with its earlier transactions' }), outcome: succeeded === !reverts, succeeded, whole, standIn: whole ? (p.decoding.notes.some(x => STAND_IN_REJECTED.test(x)) ? 'rejected' : 'validated') : undefined,
    callsOnlyBecause: whole ? undefined : rejected ?? fallbackNote ?? (p.warnings.some(w => w.code === 'userop_account_no_code') ? 'no code at the account before the bundle (delegated in it)'
      : p.decoding.notes.find(x => /simulat/.test(x)) ?? "the simulation didn't run (the node refused or failed it)"),
    gas: simCost !== undefined && actualGasCost > 0n ? { simulated: simCost, actual: actualGasCost.toString(), percent: Number((BigInt(simCost) - actualGasCost) * 100_000n / actualGasCost) / 1000 } : undefined,
    tokens: tokens.length ? tokenMatch : undefined, tokenDiffs: tokenMatch === 'exact' ? undefined : tokens.filter(t => t.actual !== t.simulated),
  });
  process.stdout.write('.');
}

const head = Number(await call<string>('eth_blockNumber', []));
const pending = async (from: number, to: number) => [...new Set((await call<{ transactionHash: string }[]>('eth_getLogs', [{ address: EP, topics: [UOE], fromBlock: hex(BigInt(from)), toBlock: hex(BigInt(to)) }])).map(l => l.transactionHash))];
const run = async (hashes: string[]) => { for (const h of hashes) { if (rows.length >= MAX) return; try { await replay(h); } catch (e) { skip(`error: ${(e as Error).message.slice(0, 80)}`); } } };
const ONE = arg('tx', '');
if (ONE) await run([ONE]);
else if (!FOLLOW) await run((await pending(head - BLOCKS, head - 1)).reverse()); // newest first, while their state is there
else {
  const deadline = Date.now() + FOLLOW * 1000;
  let last = head;
  while (Date.now() < deadline && rows.length < MAX) {
    const now = Number(await call<string>('eth_blockNumber', []));
    if (now <= last) { await new Promise(r => setTimeout(r, CHAIN === 1 ? 3000 : 500)); continue; }
    let hashes: string[];
    try { hashes = await pending(last + 1, now); } catch { await new Promise(r => setTimeout(r, 1000)); continue; }
    last = now;
    await run(hashes);
  }
}

const out = arg('out', '');
if (out) writeFileSync(out, JSON.stringify(rows, null, 1));
const count = (f: (r: Row) => boolean) => rows.filter(f).length;
const g = (r: Row) => r.gas as { percent: number } | undefined;
const range = [...blocks].sort((a, b) => a - b);
console.log(`\n${rows.length} single-operation bundles of EntryPoint v${VERSION} on ${CHAIN === 42161 ? 'Arbitrum One' : 'Ethereum'}${range.length ? ` (blocks ${range[0]}-${range.at(-1)})` : ''}, replayed on the state before them${PREFIX ? ' (after their block\'s earlier transactions)' : ''}:`);
if (PREFIX && count(r => !!r.prefix)) console.log(`  (for ${count(r => !!r.prefix)}, without the block's earlier transactions: the node refused the block with them)`);
console.log(`  outcome ${count(r => r.outcome === true)}/${rows.length} | ran whole ${count(r => r.whole === true)} (the stand-in validated for ${count(r => r.standIn === 'validated')}) | SafeOps ${count(r => r.kind === 'SafeOp')}`);
console.log(`  gas paid, of ${count(r => !!g(r))} compared: exact ${count(r => g(r)?.percent === 0)}, within 0.05% ${count(r => !!g(r) && g(r)!.percent !== 0 && Math.abs(g(r)!.percent) < 0.05)}, 0.5% ${count(r => !!g(r) && Math.abs(g(r)!.percent) >= 0.05 && Math.abs(g(r)!.percent) < 0.5)}, 5% ${count(r => !!g(r) && Math.abs(g(r)!.percent) >= 0.5 && Math.abs(g(r)!.percent) < 5)}, more ${count(r => !!g(r) && Math.abs(g(r)!.percent) >= 5)}`);
console.log(`  token movements, of ${count(r => !!r.tokens)}: exact ${count(r => r.tokens === 'exact')}, within a gas-priced fee's rounding ${count(r => r.tokens === 'fee')}, other ${count(r => r.tokens === 'other')}`);
if (Object.keys(skipped).length) console.log('  skipped:', skipped);
for (const r of rows) {
  const issues = [!r.outcome && `outcome: simulated ${r.succeeded ? 'failing' : 'succeeding'}, the receipt ${r.succeeded ? 'succeeded' : 'failed'}`, !r.whole && `calls only: ${String(r.callsOnlyBecause ?? '').slice(0, 140)}`,
    r.standIn === 'rejected' && 'the account rejected the stand-in (signer unknown)', g(r) && Math.abs(g(r)!.percent) >= 0.5 && `gas ${g(r)!.percent}%`, r.tokens === 'other' && `tokens ${JSON.stringify(r.tokenDiffs)}`].filter(Boolean);
  if (issues.length) console.log(`    ${r.hash} (${r.kind}): ${issues.join('; ')}`);
}
