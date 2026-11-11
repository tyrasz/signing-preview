// npm run accuracy -- [--chain 1|42161|8453|10|137|56] [--blocks 30 | --block 123 | --follow 300] [--max 600] [--strict] [--summary-md file] [--per-block 3] [--max-index 8] [--only-type 0x4] [--unsigned-7702] [--simulators eth_simulateV1,fork] [--out report.json]
//
// How accurate simulation is, measured against what actually happened. Recent Ethereum transactions from one-off
// senders are replayed at their exact pre-state: on top of the parent block, after the earlier transactions of their
// own block, with the real block's header. Each goes through both simulators the previewer uses:
//   - RpcSimulator: eth_simulateV1, with balances and approvals read back from state;
//   - ForkSimulator: a local EVM over the chain's state (what HyperEVM, which has no eth_simulateV1, uses).
// and is compared with the receipt: outcome, every token movement of the sender, the native coin change (balance
// before and after the block, net of the fee), approvals by the sender, and gas. Any difference is listed.
// Public RPCs keep only recent state (Ethereum about 128 blocks, ~25 minutes; Arbitrum about 30 seconds), so only
// the latest blocks can be replayed. --follow <seconds> keeps up with the chain instead: each new block is replayed as
// it arrives, while its parent's state is still there (skipping blocks it can't keep up with), and senders already
// seen are left out, so bots don't fill the sample. That is what makes long Arbitrum runs possible.
// Chains' own transactions are skipped: ArbOS's on Arbitrum, OP Stack deposits (type 0x7e) on Base and OP Mainnet,
// and BNB Chain's validator system transactions (sent by the block's validator at no gas price). On OP Stack chains
// the fee the sender pays includes the receipt's L1 data fee, and the preview's estimate of it (the GasPriceOracle's
// getL1Fee for the unsigned transaction, at the block's L1 prices) is compared with the receipt's.
// On Arbitrum, ArbOS's own transactions are skipped. Given a base fee (the replayed block's), the node's eth_simulateV1
// also charges the L1 data part, which it estimates for the unsigned transaction at a price that moves: gas matches
// when it is the receipt's L2 part (gasUsed less gasUsedForL1) plus an L1 charge between none and twice the
// receipt's (the charge is reported). The fork simulator doesn't model ArbOS, so it runs on Ethereum only.
// --strict exits with 1 when a transaction's preview differs from its receipt: its outcome, a token movement of the
// sender beyond 2 base units (a share token's rounding) and a millionth (an interest-bearing token's accrual), its native coin change or an approval it gave, or its gas by
// 10% or more (smaller gas differences are listed, not failed: a node's eth_simulateV1 can differ from its own chain by
// a few percent on some EIP-7702 transactions; and a BNB Chain block sharing its parent's second runs a second later,
// so its transactions' gas isn't judged, and its token movements within a ten-thousandth). --summary-md appends the results as Markdown; --max stops after that
// many transactions.
// --unsigned-7702 replays the sender's own EIP-7702 authorizations as if the wallet had yet to sign them (code
// overrides and the request's unsignedAuthorizations), which is how a preview before signing sees them.
import { appendFileSync, writeFileSync } from 'node:fs';
import { ForkSimulator } from '../src/fork-simulator.ts';
import { parseLogs, RpcSimulator } from '../src/simulation.ts';
import { JsonRpcClient } from '../src/rpc.ts';
import type { SimulationRequest, SimulationResult, Simulator } from '../src/types.ts';
import { recoverAuthorizationAddress } from 'viem/utils';
import { encodeFunctionData, parseAbi } from 'viem';
import { chainName, OP_STACK, rpcUrlFor } from '../src/chains.ts';
import { l1FeeInput } from '../src/evm/tx-checks.ts';

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const CHAIN = Number(arg('chain', '1'));
const URL_: string = rpcUrlFor(CHAIN, process.env) ?? (() => { throw new Error(`no RPC for chain ${CHAIN}`); })();
const SYSTEM = CHAIN === 42161 ? new Set(['0x64', '0x65', '0x66', '0x68', '0x69', '0x6a']) : OP_STACK.has(CHAIN) ? new Set(['0x7e']) : new Set<string>();
/** BNB Chain's system transactions: the block's validator, at no gas price, to its system contracts. */
const isSystem = (t: T, b: B) => SYSTEM.has(t.type) || (CHAIN === 56 && t.from.toLowerCase() === b.miner.toLowerCase() && BigInt(t.gasPrice) === 0n);
const GAS_PRICE_ORACLE = '0x420000000000000000000000000000000000000f';
const L1_INFO_DEPOSITOR = '0xdeaddeaddeaddeaddeaddeaddeaddeaddead0001';
const GET_L1_FEE = parseAbi(['function getL1Fee(bytes _data) view returns (uint256)']);
const FOLLOW = Number(arg('follow', '0'));
const MAX = Number(arg('max', '0')) || Infinity, STRICT = process.argv.includes('--strict'), SUMMARY_MD = arg('summary-md', '');
const BLOCKS = Number(arg('blocks', '30')), PER_BLOCK = Number(arg('per-block', '3')), MAX_INDEX = Number(arg('max-index', '8'));
const UNSIGNED = process.argv.includes('--unsigned-7702');
// The fork simulator (a local EVM) runs beside the node's on Ethereum by default, and on any chain with --simulators
// eth_simulateV1,fork: it runs each chain's EVM rules, with what the chain adds around them (ArbOS's precompiles,
// answered by the chain; the L1 data fees, charged outside the EVM) left to the comparison below.
const ONLY_TYPE = arg('only-type', ''), SIMULATORS = arg('simulators', CHAIN === 1 ? 'eth_simulateV1,fork' : 'eth_simulateV1').split(',');
const rpc = new JsonRpcClient({ [CHAIN]: URL_ }, { timeoutMs: 20_000, retries: CHAIN === 42161 ? 8 : 4, retryDelayMs: CHAIN === 42161 ? 1000 : 400 });
type Hex = `0x${string}`;
type Auth = { address: Hex; chainId: Hex; nonce: Hex; r: Hex; s: Hex; yParity: Hex };
type T = { hash: string; from: string; to: string | null; input: Hex; value: string; transactionIndex: string; type: string; gas: string; gasPrice: string; nonce: string; maxFeePerGas?: string; maxPriorityFeePerGas?: string; accessList?: { address: string; storageKeys: string[] }[]; authorizationList?: Auth[] };
type B = { number: Hex; timestamp: Hex; miner: string; mixHash: Hex; gasLimit: Hex; baseFeePerGas: Hex; transactions: T[] };
type R = { transactionHash: string; status: string; gasUsed: string; gasUsedForL1?: string; l1Fee?: string; operatorFeeScalar?: string; operatorFeeConstant?: string; effectiveGasPrice: string; logs: { address: string; topics: string[]; data: string }[] };
/** What the sender paid beyond gas × price: an OP Stack chain's L1 data fee and operator fee (Isthmus). */
const extraFee = (r: R) => BigInt(r.l1Fee ?? 0) + (r.operatorFeeScalar || r.operatorFeeConstant ? BigInt(r.gasUsed) * BigInt(r.operatorFeeScalar ?? 0) / 1_000_000n + BigInt(r.operatorFeeConstant ?? 0) : 0n);

const head = Number(await rpc.call(CHAIN, 'eth_blockNumber', []));
const blocks: B[] = [];
const txsBySender = new Map<string, number>();
const count = (b: B) => { for (const t of b.transactions) txsBySender.set(t.from.toLowerCase(), (txsBySender.get(t.from.toLowerCase()) ?? 0) + 1); };
// --block <n>: that block alone (to look again at one of its transactions while the node still has its state).
const ONE_BLOCK = arg('block', '');
if (!FOLLOW) {
  for (let i = 0; i < (ONE_BLOCK ? 1 : BLOCKS); i++) blocks.push(await rpc.call(CHAIN, 'eth_getBlockByNumber', ['0x' + (ONE_BLOCK ? BigInt(ONE_BLOCK) : BigInt(head - 1 - i)).toString(16), true]) as B);
  for (const b of blocks) count(b);
}
/**
 * EIP-7702 authorizations as code overrides, the way the previewer applies them: each one that is valid (this chain
 * or every chain, a readable signature, and the authority's nonce, counting the transaction's own when the authority
 * sends it) sets the authority's code to the delegation designator.
 */
async function delegations(t: T, tag: string): Promise<Record<string, { code: string }> | undefined> {
  if (!t.authorizationList?.length) return undefined;
  const out: Record<string, { code: string }> = {};
  for (const a of t.authorizationList) {
    if (![0, CHAIN].includes(Number(a.chainId))) continue;
    let authority: string;
    try { authority = (await recoverAuthorizationAddress({ authorization: { address: a.address, chainId: Number(a.chainId), nonce: Number(a.nonce) }, signature: { r: a.r, s: a.s, yParity: Number(a.yParity) } })).toLowerCase(); } catch { continue; }
    const nonce = BigInt(String(await rpc.call(CHAIN, 'eth_getTransactionCount', [authority, tag]))) + (authority === t.from.toLowerCase() ? 1n : 0n);
    if (BigInt(a.nonce) !== nonce) continue;
    out[authority] = { code: /^0x0{40}$/.test(a.address) ? '0x' : `0xef0100${a.address.slice(2).toLowerCase()}` };
  }
  return Object.keys(out).length ? out : undefined;
}
const authorityOf = async (a: Auth) => { try { return (await recoverAuthorizationAddress({ authorization: { address: a.address, chainId: Number(a.chainId), nonce: Number(a.nonce) }, signature: { r: a.r, s: a.s, yParity: Number(a.yParity) } })).toLowerCase(); } catch { return null; } };
/** Whether every authorization of the transaction is the sender's own (what a wallet would sign for its account). */
const selfSigned = async (t: T) => !!t.authorizationList?.length && (await Promise.all(t.authorizationList.map(authorityOf))).every(a => a === t.from.toLowerCase());
const reqOf = async (t: T, tag: string, unsigned = false): Promise<SimulationRequest> => {
  const stateOverrides = await delegations(t, tag);
  const auths = unsigned ? { unsignedAuthorizations: t.authorizationList!.map(a => ({ address: a.address.toLowerCase(), chainId: Number(a.chainId) })) }
    : t.authorizationList?.length ? { authorizationList: t.authorizationList } : {};
  return { chainId: CHAIN, from: t.from.toLowerCase(), to: t.to, data: t.input, value: BigInt(t.value), gas: BigInt(t.gas), gasPrice: BigInt(t.gasPrice), accessList: t.accessList, ...(stateOverrides && { stateOverrides }), ...auths };
};
const net = (transfers: { asset: string; from: string; to: string; raw: bigint }[], who: string) => {
  const m = new Map<string, bigint>();
  for (const x of transfers) { if (x.from === who) m.set(x.asset, (m.get(x.asset) ?? 0n) - x.raw); if (x.to === who) m.set(x.asset, (m.get(x.asset) ?? 0n) + x.raw); }
  return new Map([...m].filter(([, v]) => v !== 0n));
};

const rows: Record<string, unknown>[] = [];
/** Replays one block's eligible transactions. `seen`: in follow mode, senders seen before this block (left out). */
async function replay(b: B, seen?: Set<string>) {
  const n = Number(b.number), parent = '0x' + (n - 1).toString(16);
  // Base and BNB Chain make blocks faster than one a second, so a block can share its parent's timestamp (in
  // seconds). Base's node simulates such a block at that time; BNB Chain's refuses it ("block timestamps must be in
  // order"), and the block then runs a second later (bumped below). A contract can work differently a second later:
  // one on Base wrote 23,578 gas more of storage.
  let time = b.timestamp;
  // The block's DIFFICULTY (opcode 0x44), which MEV bots check: on BNB Chain it is the block's difficulty (2 when its
  // validator was in turn), which BNB Chain's node takes from the prevRandao override (mixHash there holds the
  // block's milliseconds); Polygon's takes a difficulty override. Elsewhere it is PREVRANDAO, the block's mixHash.
  const difficulty = (b as B & { difficulty?: Hex }).difficulty ?? '0x0';
  const randomness: Record<string, string> = CHAIN === 56 ? { prevRandao: `0x${BigInt(difficulty).toString(16).padStart(64, '0')}` } : CHAIN === 137 ? { prevRandao: b.mixHash, difficulty } : { prevRandao: b.mixHash };
  const receipts = await rpc.call(CHAIN, 'eth_getBlockReceipts', [b.number]) as R[];
  // The local EVM's block: opcode 0x44 as the chain answers it (above; 1 on Arbitrum), and on Arbitrum NUMBER as the
  // L1 block the chain had seen, with the chain's own number for ArbSys.
  const word32 = (v: bigint) => `0x${v.toString(16).padStart(64, '0')}` as Hex;
  const l1Number = (b as B & { l1BlockNumber?: Hex }).l1BlockNumber;
  const glam = b as B & { blockAccessListHash?: Hex; slotNumber?: Hex };
  const forkAt = (trace = false) => new ForkSimulator({ [CHAIN]: URL_ }, { block: () => parent, header: () => ({ number: CHAIN === 42161 && l1Number ? BigInt(l1Number) : BigInt(n), arbBlockNumber: BigInt(n), timestamp: BigInt(b.timestamp), coinbase: b.miner,
    prevRandao: CHAIN === 42161 ? word32(1n) : CHAIN === 56 || CHAIN === 137 ? word32(BigInt(difficulty)) : b.mixHash, gasLimit: BigInt(b.gasLimit), baseFeePerGas: BigInt(b.baseFeePerGas),
    // An Amsterdam (Glamsterdam) block says so in its header, and has a slot number: the local EVM runs its rules.
    ...(glam.blockAccessListHash !== undefined && { amsterdam: true }), ...(glam.slotNumber !== undefined && { slotNumber: BigInt(glam.slotNumber) }) }), timeoutMs: 120_000, trace });
  const simulators = ([
    // Not the block's gas limit: public nodes refuse a simulated block above their RPC gas cap (50M on publicnode,
    // below Ethereum's 60M); the parent's, the node's default, is all but the same.
    ['eth_simulateV1', new RpcSimulator({ [CHAIN]: URL_ }, { replay: () => ({ block: parent, blockOverrides: { number: b.number, time, feeRecipient: b.miner, ...randomness, baseFeePerGas: b.baseFeePerGas } }) })],
    ['fork', forkAt()],
  ] as [string, Simulator][]).filter(([name]) => SIMULATORS.includes(name));
  let taken = 0;
  for (const t of b.transactions) {
    const from = t.from.toLowerCase(), index = Number(t.transactionIndex);
    // Not the block's fee recipient: its balance also takes the block's fees, so its own change can't be told apart.
    if (taken >= PER_BLOCK || !t.to || index > MAX_INDEX || txsBySender.get(from)! > 1 || seen?.has(from) || t.type === '0x3' || isSystem(t, b) || from === b.miner.toLowerCase() || (ONLY_TYPE && t.type !== ONLY_TYPE)) continue;
    // Senders without code (EOAs; for type-4 transactions the code can be a delegation, which is what they set).
    const code = String(await rpc.call(CHAIN, 'eth_getCode', [from, parent]));
    if (code !== '0x' && !code.startsWith('0xef0100')) continue;
    taken++;
    const r = receipts.find(x => x.transactionHash === t.hash)!;
    const logs = parseLogs(r.logs);
    const logged = net(logs.transfers, from);
    // A chain that logs its native transfers itself (EIP-7708, from Glamsterdam on) has them among the receipt's
    // transfers: the native coin is compared apart, by the sender's balance.
    logged.delete('native');
    // What actually moved: the sender's balance of each token across the block (it sent nothing else in it), which
    // for share-based tokens can differ from the Transfer events by a unit; the events where balanceOf can't be read.
    const balanceAt = async (token: string, tag: string) => { try { return BigInt(String(await rpc.call(CHAIN, 'eth_call', [{ to: token, data: `0x70a08231${from.slice(2).padStart(64, '0')}` }, tag]))); } catch { return undefined; } };
    const actual = new Map<string, bigint>();
    const actualOf = async (a: string) => {
      if (!actual.has(a)) { const x = await balanceAt(a, parent), y = await balanceAt(a, b.number); actual.set(a, x !== undefined && y !== undefined ? y - x : (logged.get(a) ?? 0n)); }
      return actual.get(a)!;
    };
    // What the block's other transactions moved for the sender (a token it gets back later in the block, say), from
    // their receipts: not this transaction's doing.
    const others = net(receipts.filter(x => x.transactionHash !== t.hash).flatMap(x => parseLogs(x.logs).transfers), from);
    const actualOfThis = async (a: string) => (await actualOf(a)) - (others.get(a) ?? 0n);
    for (const a of logged.keys()) await actualOf(a);
    // Native: the sender's balance across the block, plus the fee it paid (it sent nothing else in this block), less
    // what other transactions of the block paid it directly (a bot funded just before it acts, say).
    const bal = async (tag: string) => BigInt(String(await rpc.call(CHAIN, 'eth_getBalance', [from, tag])));
    const paidIn = b.transactions.filter(x => x.hash !== t.hash && x.to?.toLowerCase() === from && receipts.find(y => y.transactionHash === x.hash)?.status === '0x1').reduce((sum, x) => sum + BigInt(x.value), 0n);
    const nativeActual = (await bal(b.number)) - (await bal(parent)) + BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice) + extraFee(r) - paidIn;
    const approvals = logs.approvals.filter(a => a.owner === from && !(a.kind === 'erc721' && /^0x0{40}$/.test(a.spender))).map(a => `${a.kind}:${a.token}:${a.spender}`);
    const row: Record<string, unknown> = { hash: t.hash, block: n, index, to: t.to, selector: t.input.slice(0, 10), receipt: r.status === '0x1' ? 'success' : 'reverted', receiptGas: (BigInt(r.gasUsed) - BigInt(r.gasUsedForL1 ?? 0)).toString(), receiptTotal: BigInt(r.gasUsed).toString(), receiptL1: BigInt(r.gasUsedForL1 ?? 0).toString() };
    // The block's earlier transactions, the chain's own left out, except an OP Stack block's L1 info deposit (its
    // first transaction, from the L1 attributes depositor to the L1Block predeploy): the L1 values it sets for the
    // block are what a contract pricing L1 data (a paymaster, a bridge) reads, and as a plain call it runs as on-chain.
    const before = await Promise.all(b.transactions.slice(0, index).filter(x => !SYSTEM.has(x.type) || x.from.toLowerCase() === L1_INFO_DEPOSITOR).map(x => reqOf(x, parent)));
    // OP Stack: the preview's L1 data fee for this transaction, at the block's L1 prices (set by its first, deposit
    // transaction, so read after the block), against the receipt's.
    if (OP_STACK.has(CHAIN) && r.l1Fee) {
      try {
        const input = l1FeeInput({ chainId: CHAIN, from, to: t.to, data: t.input, value: BigInt(t.value), ...(t.maxFeePerGas === undefined && { gasPrice: BigInt(t.gasPrice) }), ...(t.accessList?.length && { accessList: t.accessList }),
          ...(t.authorizationList?.length && { authorizations: t.authorizationList.map(a => ({ address: a.address, chainId: Number(a.chainId), nonce: BigInt(a.nonce), signature: { r: a.r, s: a.s, yParity: Number(a.yParity) } })) }) },
          { nonce: BigInt(t.nonce), gas: BigInt(t.gas), maxFeePerGas: BigInt(t.maxFeePerGas ?? t.gasPrice), maxPriorityFeePerGas: BigInt(t.maxPriorityFeePerGas ?? 0) });
        const est = BigInt(String(await rpc.call(CHAIN, 'eth_call', [{ to: GAS_PRICE_ORACLE, data: encodeFunctionData({ abi: GET_L1_FEE, functionName: 'getL1Fee', args: [input] }) }, b.number])));
        row.l1Fee = { receipt: BigInt(r.l1Fee).toString(), estimate: est.toString(), percent: Number((est - BigInt(r.l1Fee)) * 100_000n / BigInt(r.l1Fee)) / 1000 };
      } catch (e) { row.l1Fee = { error: String(e).slice(0, 120) }; }
    }
    const unsigned = UNSIGNED && await selfSigned(t);
    if (UNSIGNED && !unsigned) { taken--; continue; }
    const target = await reqOf(t, parent, unsigned);
    row.type = t.type;
    for (const [name, sim] of simulators) {
      const t0 = Date.now();
      try {
        let out: SimulationResult[];
        try { out = (await sim.simulateBatch!([...before, target]))!; } catch (e) {
          if (!/timestamps must be in order/.test(String(e)) || time !== b.timestamp) throw e;
          time = `0x${(BigInt((await rpc.call(CHAIN, 'eth_getBlockByNumber', [parent, false]) as { timestamp: Hex }).timestamp) + 1n).toString(16)}` as Hex;
          out = (await sim.simulateBatch!([...before, target]))!;
        }
        // Run a second after its block (BNB Chain): what depends on the second (a pool's price observation, written
        // once a second; a reward accruing) can differ, so its gas isn't judged (see below).
        if (time !== b.timestamp) row.timeBumped = true;
        const res: SimulationResult = out[out.length - 1];
        const got = net(res.transfers, from);
        const nativeGot = got.get('native') ?? 0n;
        got.delete('native');
        // Tokens either side saw (a wrap's WETH has no Transfer event, so only the simulation names it).
        const tokenRows = [];
        for (const a of new Set([...logged.keys(), ...got.keys()])) {
          const want = await actualOfThis(a);
          if (want !== 0n || got.has(a)) tokenRows.push({ token: a, actual: want.toString(), simulated: (got.get(a) ?? 0n).toString() });
        }
        row[name] = {
          outcome: res.status === row.receipt, status: res.status, revert: res.revertReason,
          tokens: tokenRows.filter(x => x.actual === x.simulated).length, tokenTotal: tokenRows.length, tokenDiffs: tokenRows.filter(x => x.actual !== x.simulated),
          native: nativeGot === (res.status === 'success' ? nativeActual : 0n) || (res.status !== 'success' && row.receipt !== 'success'), nativeActual: nativeActual.toString(), nativeSimulated: nativeGot.toString(),
          approvals: approvals.filter(a => (res.approvals ?? []).some(x => `${x.kind}:${x.token}:${x.spender}` === a)).length, approvalTotal: approvals.length,
          // Arbitrum: the receipt's L2 part, plus the node's own L1 charge (between none and twice the receipt's).
          gas: String(res.gasUsed) === row.receiptGas || (!!r.gasUsedForL1 && res.gasUsed !== undefined && res.gasUsed >= BigInt(row.receiptGas as string) && res.gasUsed - BigInt(row.receiptGas as string) <= 2n * BigInt(r.gasUsedForL1)),
          l1Charge: r.gasUsedForL1 && BigInt(r.gasUsedForL1) > 0n && res.gasUsed !== undefined ? Number(res.gasUsed - BigInt(row.receiptGas as string)) / Number(BigInt(r.gasUsedForL1)) : undefined,
          gasUsed: String(res.gasUsed), ms: Date.now() - t0,
        };
        // A native change that differs: what the block's other transactions sent the sender through a contract (a
        // builder's rebate, a contract paying it out) moves its balance too, with no log to show it. The block's
        // earlier transactions were simulated with it, and the rest of the block is simulated after it; what those
        // calls moved for the sender (traceTransfers, their own values included, so not paidIn as well) is left out of
        // the actual change.
        const cell = row[name] as Record<string, any>;
        // OP Stack: the receipt names an L1 data fee the sender's balance didn't pay (two swaps through one contract
        // on Base, 2026-11-10: the balance moved by the payout less the L2 gas, to the wei). The simulation is then
        // right, and the harness's adding of the fee back is what's off.
        if (!cell.native && OP_STACK.has(CHAIN) && r.l1Fee && res.status === 'success' && nativeGot === nativeActual - BigInt(r.l1Fee)) { cell.native = true; cell.l1FeeNotCharged = true; }
        if (!cell.native && name === 'eth_simulateV1' && res.status === 'success') {
          const earlier = out.slice(0, -1).reduce((sum, x) => sum + (net(x.transfers, from).get('native') ?? 0n), 0n);
          if (earlier !== 0n) { cell.nativeEarlier = earlier.toString(); cell.native = nativeGot === nativeActual + paidIn - earlier; }
        }
        if (!cell.native && name === 'eth_simulateV1' && res.status === 'success') {
          try {
            // Without their gas limits (together they can exceed the block's) or prices (unlimited gas at a price is
            // more than a sender has): only what they send the sender matters here, not their fees.
            const after = await Promise.all(b.transactions.slice(index + 1).filter(x => !SYSTEM.has(x.type)).map(async x => ({ ...await reqOf(x, parent), gas: undefined, gasPrice: undefined })));
            const whole = (await sim.simulateBatch!([...before, target, ...after]))!.slice(before.length + 1);
            const later = whole.reduce((sum, x) => sum + (net(x.transfers, from).get('native') ?? 0n), 0n);
            const earlier = BigInt(cell.nativeEarlier ?? 0);
            if (later !== 0n) {
              cell.nativeLater = later.toString();
              cell.native = nativeGot === nativeActual + paidIn - earlier - later;
            }
          } catch (e) { cell.nativeLaterError = String(e).slice(0, 120); }
        }
        // A fork gas difference: keep the call's storage writes, each with its slot's value before the block, to
        // find the one priced differently (while the RPC still has the state).
        if (name === 'fork' && String(res.gasUsed) !== row.receiptGas) {
          try {
            const traced = forkAt(true);
            await traced.simulateBatch([...before, target]);
            const writes = traced.last!.trace!.filter(w => w.call === before.length && w.op === 'SSTORE');
            (row[name] as Record<string, unknown>).writes = await Promise.all(writes.map(async w => ({ ...w, atParent: String(await rpc.call(CHAIN, 'eth_getStorageAt', [w.address, '0x' + BigInt(w.slot).toString(16).padStart(64, '0'), parent])) })));
          } catch (e) { (row[name] as Record<string, unknown>).traceError = String(e).slice(0, 120); }
        }
      } catch (e) {
        row[name] = { error: (e as Error).message.slice(0, 160), ms: Date.now() - t0 };
      }
    }
    rows.push(row);
  }
}

if (!FOLLOW) for (const b of blocks) { if (rows.length >= MAX) break; await replay(b); }
else {
  // Each new head block, as soon as it's there: its parent's state is then seconds old. A block that took too long
  // to get to is skipped (Arbitrum keeps about 30 seconds of state).
  const seen = new Set<string>();
  const deadline = Date.now() + FOLLOW * 1000;
  let last = head;
  // A read that fails (a connection reset, the node unreachable for a moment) is tried again a second later: over a
  // long run one did, and it ended the run.
  const read = async <X>(method: string, params: unknown[]): Promise<X | undefined> => {
    try { return await rpc.call(CHAIN, method, params) as X; } catch (e) { console.log(`  ${method} failed: ${(e as Error).message.slice(0, 100)}`); await new Promise(r => setTimeout(r, 1000)); return undefined; }
  };
  while (Date.now() < deadline && rows.length < MAX) {
    const latest = await read<string>('eth_blockNumber', []);
    if (latest === undefined) continue;
    const now = Number(latest);
    if (now <= last) { await new Promise(r => setTimeout(r, 250)); continue; }
    // A node behind the one that answered eth_blockNumber may not have the block yet: try again.
    const b = await read<B | null>('eth_getBlockByNumber', ['0x' + now.toString(16), true]);
    if (!b) { await new Promise(r => setTimeout(r, 250)); continue; }
    last = now;
    txsBySender.clear();
    count(b);
    blocks.push(b);
    const before = rows.length;
    try { await replay(b, seen); } catch (e) { console.log(`  block ${now} skipped: ${(e as Error).message.slice(0, 100)}`); }
    for (const t of b.transactions) seen.add(t.from.toLowerCase());
    if (rows.length > before) console.log(`  block ${now}: ${rows.length - before} replayed (${rows.length} in all)`);
  }
}

// What the harness finds the preview got wrong, per simulator (see --strict above).
const GAS_FAIL_PERCENT = 10;
for (const row of rows) for (const name of SIMULATORS) {
  const r = row[name] as Record<string, any> | undefined;
  if (!r || r.error) continue;
  const receiptGas = BigInt(CHAIN === 42161 ? row.receiptTotal as string : row.receiptGas as string);
  r.gasPercent = receiptGas > 0n && r.gasUsed !== 'undefined' ? Number((BigInt(r.gasUsed) - receiptGas) * 100_000n / receiptGas) / 1000 : undefined;
  // A token movement within 2 base units (a share token's rounding), or within a millionth (an interest-bearing
  // token, whose balance at the block's end includes what later transactions accrued), is the receipt's; for a
  // transaction run a second after its block (timeBumped), within a ten-thousandth (a second's accrual).
  const share = row.timeBumped ? 10_000n : 1_000_000n;
  const close = (d: { actual: string; simulated: string }) => { const a = BigInt(d.actual), x = a - BigInt(d.simulated), abs = (v: bigint) => (v < 0n ? -v : v); return abs(x) <= 2n || abs(x) * share <= abs(a); };
  // An outcome that differs for a transaction run a second after its block is reported, not failed: what it checks
  // can be that second (a deadline of the block's own timestamp).
  if (!r.outcome && row.timeBumped) r.warned = 'outcome (run a second after its block)';
  const differs = [!r.outcome && !row.timeBumped && 'outcome', r.tokenDiffs.some((d: { actual: string; simulated: string }) => !close(d)) && 'tokens',
    !r.native && 'native', r.approvals < r.approvalTotal && 'approvals', !r.gas && !row.timeBumped && r.gasPercent !== undefined && Math.abs(r.gasPercent) >= GAS_FAIL_PERCENT && 'gas'].filter(Boolean);
  if (differs.length) r.differs = differs;
}
const out = arg('out', '');
if (out) writeFileSync(out, JSON.stringify(rows, null, 1));
const pct = (a: number, b: number) => b ? `${(100 * a / b).toFixed(1)}%` : '-';
const numbers = blocks.map(b => Number(b.number));
const md: string[] = [];
const say = (line: string) => { console.log(line); md.push(line); };
console.log(`${rows.length} ${chainName(CHAIN)} transactions from ${FOLLOW ? 'senders not seen earlier in the run' : 'one-off senders'} (blocks ${Math.min(...numbers)}-${Math.max(...numbers)}${FOLLOW ? `, ${blocks.length} followed over ${FOLLOW} s` : ''}), replayed at their exact pre-state:`);
for (const name of SIMULATORS) {
  const rs = rows.map(r => r[name] as Record<string, any>), ok = rs.filter(r => !r.error);
  const sum = (k: string) => ok.reduce((s, r) => s + r[k], 0);
  const l1 = ok.filter(r => r.gas && r.l1Charge !== undefined).map(r => r.l1Charge as number).sort((a, b) => a - b);
  if (CHAIN === 42161 && l1.length) console.log(`  ${name}: its L1 charge was ${Math.round(100 * l1[0])}–${Math.round(100 * l1[l1.length - 1])}% of the receipt's (median ${Math.round(100 * l1[l1.length >> 1])}%) where gas matches`);
  const within1 = ok.filter(r => r.gas || (r.gasPercent !== undefined && Math.abs(r.gasPercent) < 1)).length;
  say(`  ${name.padEnd(15)} outcome ${ok.filter(r => r.outcome).length}/${ok.length} | token movements ${sum('tokens')}/${sum('tokenTotal')} | native ${ok.filter(r => r.native).length}/${ok.length} | approvals ${sum('approvals')}/${sum('approvalTotal')} | gas exact ${ok.filter(r => r.gas).length}/${ok.length}, within 1% ${within1} | differing ${ok.filter(r => r.differs).length} | errors ${rs.length - ok.length}`);
  console.log(`  ${name.padEnd(15)} outcome ${pct(ok.filter(r => r.outcome).length, ok.length)} | token movements ${sum('tokens')}/${sum('tokenTotal')} (${pct(sum('tokens'), sum('tokenTotal'))}) | native ${pct(ok.filter(r => r.native).length, ok.length)} | approvals ${sum('approvals')}/${sum('approvalTotal')} | gas exact ${pct(ok.filter(r => r.gas).length, ok.length)} | errors ${rs.length - ok.length} | median ${ok.map(r => r.ms).sort((a, b) => a - b)[ok.length >> 1]} ms`);
  for (const [i, r] of rs.entries()) {
    if (r.error) { console.log(`    error ${rows[i].hash}: ${r.error}`); continue; }
    const issues = [!r.outcome && `outcome ${r.status} (${r.revert}) vs ${rows[i].receipt}`, r.tokenDiffs.length && `tokens ${JSON.stringify(r.tokenDiffs)}`, !r.native && `native ${r.nativeSimulated} vs ${r.nativeActual}`,
      r.approvals < r.approvalTotal && `approvals ${r.approvals}/${r.approvalTotal}`, !r.gas && `gas ${r.gasUsed} vs ${rows[i].receiptGas}`].filter(Boolean);
    if (issues.length) (r.differs ? say : console.log)(`    ${rows[i].hash} ${rows[i].selector}: ${issues.join('; ')}${r.differs ? '' : ' (reported, not failed)'}`);
  }
}
const differing = rows.filter(r => SIMULATORS.some(n => (r[n] as Record<string, any> | undefined)?.differs)).length;
const notCharged = rows.filter(r => SIMULATORS.some(n => (r[n] as Record<string, any> | undefined)?.l1FeeNotCharged)).length;
if (notCharged) say(`  ${notCharged} whose receipt names an L1 data fee their sender's balance didn't pay`);
const bumped = rows.filter(r => r.timeBumped).length;
if (bumped) say(`  ${bumped} run a second after their block, which shared its parent's second (the node refuses that): gas not judged for them`);
const l1Rows = rows.map(r => r.l1Fee as { percent?: number } | undefined).filter(x => x?.percent !== undefined).map(x => x!.percent!);
if (l1Rows.length) say(`  L1 data fee estimate, of ${l1Rows.length}: exact ${l1Rows.filter(x => x === 0).length}, within 1% ${l1Rows.filter(x => Math.abs(x) < 1).length}, within 5% ${l1Rows.filter(x => Math.abs(x) < 5).length}; never under the receipt's: ${l1Rows.every(x => x >= 0)}`);
if (SUMMARY_MD) appendFileSync(SUMMARY_MD, `### ${chainName(CHAIN)}${differing ? ` — ${differing} differing from the receipts` : ''}\n\n${rows.length} transactions (blocks ${Math.min(...numbers)}-${Math.max(...numbers)}${FOLLOW ? `, ${blocks.length} followed` : ''}), replayed at their exact pre-state:\n\n\`\`\`\n${md.join('\n')}\n\`\`\`\n\n`);
if (STRICT && differing) process.exitCode = 1;
