// Simulation for RPCs that have eth_call with state overrides but no eth_simulateV1 or tracing (HyperEVM's public
// RPC). One eth_call sets SimulationProbe (contracts/SimulationProbe.sol) as the code of the sending account and
// runs the calls through it, from that account, in order. Around each call it reads balances, allowances and NFT
// ownership; the differences stand in for the Transfer and Approval logs a log-based simulator reads.
//
// Without logs, only what is read can be seen: the native balance, the tokens the calls name (their targets, the
// addresses in their calldata, Uniswap-style packed paths), the chain's built-in tokens and any the decoders add
// (`watch`). Validated against eth_simulateV1 at the exact pre-state of 233 Ethereum transactions: same outcome for
// 232 (one depended on the block time), and 97.9% of the token movements found, with exact amounts.
import { decodeAbiParameters, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, type Hex } from 'viem';
import { builtinTokens, CHAINS, PERMIT2 } from './chains.ts';
import { formatUnits } from './format.ts';
import { SIMULATION_PROBE_ABI, SIMULATION_PROBE_CODE } from './probe-code.ts';
import type { SimulatedApproval, SimulatedNftTransfer, SimulatedTransfer, SimulationRequest, SimulationResult } from './types.ts';

/** The RPC ignored the state override (or rejected it): this chain can't be simulated this way. */
export class ProbeUnsupported extends Error {
  constructor(message: string) { super(message); this.name = 'ProbeUnsupported'; }
}

/** This simulation failed as a whole (e.g. the node's gas cap): the call itself can still be checked another way. */
export class ProbeFailed extends Error {
  constructor(message: string) { super(message); this.name = 'ProbeFailed'; }
}

export type RpcPost = (method: string, params: unknown[]) => Promise<{ result?: unknown; error?: { code?: number; message?: string; data?: Hex } }>;

type ReadSpec =
  | { kind: 'balance'; token: string }
  | { kind: 'allowance'; token: string; spender: string }
  | { kind: 'permit2'; token: string; spender: string }
  | { kind: 'operator'; collection: string; operator: string }
  | { kind: 'erc721'; collection: string } // supportsInterface(ERC-721): its balanceOf counts NFTs, not units
  | { kind: 'owner'; collection: string; id: bigint }
  | { kind: 'approved'; collection: string; id: bigint }
  | { kind: 'erc1155'; collection: string; id: bigint };

const GAS = '0x1c9c380'; // 30M: the calls plus a few hundred reads
const READ_BUDGET = 4000; // reads across all snapshots (each costs ~3-5k gas)
const ZERO = '0x0000000000000000000000000000000000000000';
const word = (types: { type: string }[], values: unknown[]) => encodeAbiParameters(types, values).slice(2);
const ADDR = [{ type: 'address' }], ADDR2 = [{ type: 'address' }, { type: 'address' }], ADDR3 = [{ type: 'address' }, { type: 'address' }, { type: 'address' }];

function readCall(r: ReadSpec, account: string): { to: string; data: Hex } {
  switch (r.kind) {
    case 'balance': return { to: r.token, data: `0x70a08231${word(ADDR, [account])}` };
    case 'allowance': return { to: r.token, data: `0xdd62ed3e${word(ADDR2, [account, r.spender])}` };
    case 'permit2': return { to: PERMIT2, data: `0x927da105${word(ADDR3, [account, r.token, r.spender])}` };
    case 'operator': return { to: r.collection, data: `0xe985e9c5${word(ADDR2, [account, r.operator])}` };
    case 'erc721': return { to: r.collection, data: `0x01ffc9a7${word([{ type: 'bytes4' }], ['0x80ac58cd'])}` };
    case 'owner': return { to: r.collection, data: `0x6352211e${word([{ type: 'uint256' }], [r.id])}` };
    case 'approved': return { to: r.collection, data: `0x081812fc${word([{ type: 'uint256' }], [r.id])}` };
    case 'erc1155': return { to: r.collection, data: `0x00fdd58e${word([{ type: 'address' }, { type: 'uint256' }], [account, r.id])}` };
  }
}

const uint = (d: Hex | undefined) => { if (!d || d.length < 66) return undefined; try { return decodeAbiParameters([{ type: 'uint256' }], d.slice(0, 66) as Hex)[0]; } catch { return undefined; } };
const address = (d: Hex | undefined) => { const v = uint(d); return v !== undefined && v < 1n << 160n ? `0x${v.toString(16).padStart(40, '0')}` : undefined; };

/**
 * Addresses and small integers in a call's ABI words, and the tokens of packed Uniswap v3 paths (token, 3-byte fee,
 * token...). Nested calldata (multicall(bytes[]) items) starts on a word boundary but with its own 4-byte selector,
 * so its words are read 4 bytes off the grid, and 8 bytes off for one more level.
 */
export function calldataCandidates(data: string): { addresses: string[]; ids: bigint[] } {
  const addresses = new Set<string>(), ids = new Set<bigint>();
  const all = data.slice(10);
  for (const shift of [0, 8, 16]) scanWords(all.slice(shift), shift === 0, addresses, ids);
  return { addresses: [...addresses], ids: [...ids] };
}

function scanWords(hex: string, aligned: boolean, addresses: Set<string>, ids: Set<bigint>) {
  // An address is a word with 12 zero bytes and more than a small number (amounts and token IDs are mostly below
  // 2^64). Off the grid, where any bytes can line up, only a stricter shape counts.
  const minAddress = aligned ? 1n << 64n : 1n << 120n, maxId = aligned ? 1n << 64n : 1n << 32n;
  for (let i = 0; i + 64 <= hex.length; i += 64) {
    const w = BigInt('0x' + hex.slice(i, i + 64));
    if (w >= minAddress && w < 1n << 160n) addresses.add('0x' + hex.slice(i + 24, i + 64));
    else if (w > 0n && w < maxId) ids.add(w);
    // A packed path follows a word holding its length: 20 + 23n bytes.
    const len = Number(w);
    if (w < 1000n && len >= 43 && (len - 20) % 23 === 0) packedPath(hex, i, len, addresses);
  }
}

function packedPath(hex: string, i: number, len: number, addresses: Set<string>) {
  const path = hex.slice(i + 64, i + 64 + len * 2);
  if (path.length === len * 2) for (let j = 0; j + 40 <= path.length; j += 46) addresses.add('0x' + path.slice(j, j + 40));
}

/** What to read: as many as fit the budget, most useful first (fungible balances, then permissions, then NFTs). */
function plan(reqs: SimulationRequest[], account: string): ReadSpec[] {
  const skip = (a: string) => a === account || a === ZERO || BigInt(a) < 0x10000n || a === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  const named = new Set<string>(), ids = new Set<bigint>();
  for (const r of reqs) {
    for (const w of r.watch ?? []) named.add(w.toLowerCase());
    if (r.to) named.add(r.to.toLowerCase());
    const c = calldataCandidates(r.data);
    for (const a of c.addresses) named.add(a);
    for (const id of c.ids) ids.add(id);
  }
  const names = [...named].filter(a => !skip(a)).slice(0, 32);
  const tokens = [...new Set([...names, ...builtinTokens(reqs[0].chainId).map(t => t.address.toLowerCase())])].filter(a => !skip(a));
  const spenders = [...new Set([...names, PERMIT2])].slice(0, 8);
  const per = Math.max(24, Math.min(320, Math.floor(READ_BUDGET / (reqs.length + 1))));
  const out: ReadSpec[] = [];
  const add = (r: ReadSpec) => { if (out.length < per) out.push(r); };
  for (const token of tokens) add({ kind: 'balance', token });
  for (const token of names.slice(0, 12)) for (const spender of spenders) if (spender !== token) add({ kind: 'allowance', token, spender });
  for (const token of names.slice(0, 8)) for (const spender of spenders) if (spender !== token && spender !== PERMIT2) add({ kind: 'permit2', token, spender });
  const collections = names.slice(0, 6);
  for (const collection of collections) add({ kind: 'erc721', collection });
  for (const collection of collections) for (const operator of spenders) if (operator !== collection && operator !== PERMIT2) add({ kind: 'operator', collection, operator });
  for (const collection of collections.slice(0, 4)) for (const id of [...ids].slice(0, 6)) {
    add({ kind: 'owner', collection, id }); add({ kind: 'approved', collection, id }); add({ kind: 'erc1155', collection, id });
  }
  return out;
}

/** Calldata gas plus the 21,000 base, so gasUsed is comparable with a transaction's (and eth_simulateV1's). */
function intrinsicGas(data: string): bigint {
  let gas = 21_000n;
  for (let i = 2; i < data.length; i += 2) gas += data.slice(i, i + 2) === '00' ? 4n : 16n;
  return gas;
}

/**
 * Simulates `reqs` (one sender, in order) with SimulationProbe. Resolves one result per call; throws ProbeUnsupported
 * when the RPC doesn't apply the override, and passes RPC errors on.
 */
export async function probeSimulate(post: RpcPost, reqs: SimulationRequest[], decodeRevert: (data: Hex) => string | undefined, block = 'latest'): Promise<SimulationResult[]> {
  const account = reqs[0].from.toLowerCase(), chainId = reqs[0].chainId;
  if (reqs.some(r => r.from.toLowerCase() !== account || !r.to)) throw new ProbeUnsupported('every call needs the same sender and a target');
  const reads = plan(reqs, account);
  const data = encodeFunctionData({ abi: SIMULATION_PROBE_ABI, functionName: 'run', args: [
    reqs.map(r => ({ to: r.to as Hex, value: r.value, data: r.data as Hex })),
    reads.map(r => { const c = readCall(r, account); return { to: c.to as Hex, data: c.data }; }),
  ] });
  const res = await post('eth_call', [{ from: account, to: account, data, gas: GAS }, block, { [account]: { code: SIMULATION_PROBE_CODE } }]);
  if (res.error) {
    // run() itself failing (it shouldn't) or the node refusing the override: either way this chain can't use it.
    if (/override|invalid params|unknown field|not supported/i.test(res.error.message ?? '') || res.error.code === -32602) throw new ProbeUnsupported(res.error.message ?? 'state override rejected');
    throw new ProbeFailed(`the probe's eth_call failed: ${res.error.message}`);
  }
  let outcomes: readonly { ok: boolean; gasUsed: bigint; ret: Hex }[], native: readonly bigint[], snapshots: readonly (readonly Hex[])[];
  try {
    [outcomes, native, snapshots] = decodeFunctionResult({ abi: SIMULATION_PROBE_ABI, functionName: 'run', data: res.result as Hex }) as unknown as [typeof outcomes, typeof native, typeof snapshots];
  } catch {
    throw new ProbeUnsupported('the RPC did not run the overridden code'); // e.g. '0x': it called the plain account
  }

  // ERC-721 contracts count NFTs in balanceOf(owner); those are shown per token ID from ownerOf instead.
  const nftCollections = new Set(reads.flatMap((r, j) => r.kind === 'erc721' && uint(snapshots[0][j]) === 1n ? [r.collection] : []));
  const source = `eth_call with a state-override probe @ chain ${chainId}${block === 'latest' ? '' : ` block ${block}`} (the RPC has no eth_simulateV1)`;
  const touched = new Map<number, SimulatedApproval>(); // approval reads changed so far, by read index
  return reqs.map((req, i): SimulationResult => {
    const before = snapshots[i], after = snapshots[i + 1], target = req.to!.toLowerCase();
    const o = outcomes[i];
    const gasUsed = o.gasUsed + intrinsicGas(req.data);
    if (!o.ok) {
      const chain = CHAINS[chainId], units = (v: bigint) => `${formatUnits(v, chain?.nativeDecimals ?? 18)} ${chain?.nativeSymbol ?? ''}`.trim();
      const short = req.value > native[i];
      return { status: 'reverted', source, gasUsed, revertReason: short ? `insufficient funds: the account holds ${units(native[i])} and the call sends ${units(req.value)}` : decodeRevert(o.ret), transfers: [], basis: 'state', tokensRead: 0 };
    }
    const transfers: SimulatedTransfer[] = [], nftTransfers: SimulatedNftTransfer[] = [], approvals: SimulatedApproval[] = [];
    const fungible = (asset: string, delta: bigint) => {
      if (delta < 0n) transfers.push({ asset, from: account, to: target, raw: -delta });
      else if (delta > 0n) transfers.push({ asset, from: target, to: account, raw: delta });
    };
    fungible('native', native[i + 1] - native[i]);
    let tokensRead = 0;
    // approve / Permit2.approve / setApprovalForAll naming this permission: listed even when it leaves the value as it
    // was, as their events would be.
    const sel = req.data.slice(0, 10), arg = (n: number) => '0x' + req.data.slice(10 + 64 * n + 24, 10 + 64 * (n + 1));
    const named = (r: ReadSpec) =>
      (r.kind === 'allowance' && target === r.token && (sel === '0x095ea7b3' || sel === '0x39509351') && arg(0) === r.spender)
      || (r.kind === 'permit2' && target === PERMIT2 && sel === '0x87517c45' && arg(0) === r.token && arg(1) === r.spender)
      || (r.kind === 'operator' && target === r.collection && sel === '0xa22cb465' && arg(0) === r.operator);
    reads.forEach((r, j) => {
      const b = before[j], a = after[j];
      if (r.kind === 'balance') {
        const x = uint(b), y = uint(a);
        if (x === undefined || y === undefined) return;
        tokensRead++;
        if (!nftCollections.has(r.token)) fungible(r.token, y - x);
      } else if (r.kind === 'allowance' || r.kind === 'permit2') {
        const x = uint(b), y = uint(a);
        const ex = r.kind === 'permit2' ? uint(b && `0x${b.slice(66, 130)}` as Hex) : undefined, ey = r.kind === 'permit2' ? uint(a && `0x${a.slice(66, 130)}` as Hex) : undefined;
        if (y === undefined || (x === y && ex === ey && !named(r))) return;
        // A call to the token (or Permit2) sets the allowance directly; elsewhere, only a grant matters (spending
        // an allowance lowers it, and log-based simulators don't flag that either).
        const direct = r.kind === 'allowance' ? target === r.token : target === PERMIT2;
        if (!direct && !(y > (x ?? 0n) || (ey ?? 0n) > (ex ?? 0n))) return;
        const ap: SimulatedApproval = r.kind === 'allowance'
          ? { kind: 'erc20', emitter: r.token, token: r.token, owner: account, spender: r.spender, amount: y }
          : { kind: 'permit2', emitter: PERMIT2, token: r.token, owner: account, spender: r.spender, amount: y, ...(ey !== undefined && { expiration: Number(ey) }) };
        approvals.push(ap); touched.set(j, ap);
      } else if (r.kind === 'operator') {
        const x = uint(b), y = uint(a);
        if (y === undefined || y > 1n || (x === y && !named(r))) return;
        const ap: SimulatedApproval = { kind: 'operator', emitter: r.collection, token: r.collection, owner: account, spender: r.operator, approved: y === 1n };
        approvals.push(ap); touched.set(j, ap);
      } else if (r.kind === 'owner') {
        const x = address(b), y = address(a);
        if (!y || x === y) return;
        if (x === account) nftTransfers.push({ standard: 'erc721', collection: r.collection, from: account, to: y, tokenId: r.id, amount: 1n });
        else if (y === account) nftTransfers.push({ standard: 'erc721', collection: r.collection, from: x ?? ZERO, to: account, tokenId: r.id, amount: 1n });
      } else if (r.kind === 'approved') {
        const x = address(b), y = address(a);
        const owner = reads.findIndex(o => o.kind === 'owner' && o.collection === r.collection && o.id === r.id);
        if (!y || x === y || y === ZERO || owner < 0 || address(after[owner]) !== account) return;
        const ap: SimulatedApproval = { kind: 'erc721', emitter: r.collection, token: r.collection, owner: account, spender: y, tokenId: r.id };
        approvals.push(ap); touched.set(j, ap);
      } else if (r.kind === 'erc1155') {
        const x = uint(b), y = uint(a);
        if (x === undefined || y === undefined || x === y || nftCollections.has(r.collection)) return;
        const d = y - x;
        nftTransfers.push({ standard: 'erc1155', collection: r.collection, from: d < 0n ? account : target, to: d < 0n ? target : account, tokenId: r.id, amount: d < 0n ? -d : d });
      }
    });
    // The state after this call of every permission the calls have changed so far.
    const approvalState = [...touched].map(([j, ap]): SimulatedApproval => {
      const v = after[j];
      if (ap.kind === 'operator') return { ...ap, approved: uint(v) === 1n };
      if (ap.kind === 'erc721') return { ...ap, spender: address(v) ?? ZERO };
      if (ap.kind === 'permit2') { const e = uint(v && `0x${v.slice(66, 130)}` as Hex); return { ...ap, amount: uint(v) ?? 0n, ...(e !== undefined && { expiration: Number(e) }) }; }
      return { ...ap, amount: uint(v) ?? 0n };
    });
    return { status: 'success', source, gasUsed, transfers, nftTransfers, approvals, ...(approvalState.length && { approvalState }), basis: 'state', tokensRead };
  });
}
