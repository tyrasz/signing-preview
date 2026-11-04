import { decodeAbiParameters, decodeErrorResult, encodeAbiParameters, parseAbi, type Hex } from 'viem';
import { PERMIT2 } from './chains.ts';
import type { SimulatedApproval, SimulatedNftTransfer, SimulatedTransfer, SimulationRequest, SimulationResult, Simulator } from './types.ts';

// Event topics (keccak256 of the signature).
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'; // Transfer(address,address,uint256), ERC-20 and ERC-721
const APPROVAL_TOPIC = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925'; // Approval(address,address,uint256), ERC-20 and ERC-721
const APPROVAL_FOR_ALL_TOPIC = '0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31'; // ApprovalForAll(address,address,bool)
const TRANSFER_SINGLE_TOPIC = '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62'; // ERC-1155 TransferSingle
const TRANSFER_BATCH_TOPIC = '0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb'; // ERC-1155 TransferBatch
const PERMIT2_APPROVAL_TOPIC = '0xda9fa7c1b00402c17d0161b249b1ab8bbec047c5a52207b9c112deffd817036b'; // Approval(owner,token,spender,uint160,uint48)
const PERMIT2_PERMIT_TOPIC = '0xc6a377bfc4eb120024a8ac08eef205be16b817020812c73223e81d1bdb9708ec'; // Permit(owner,token,spender,uint160,uint48,uint48)
const PERMIT2_LOCKDOWN_TOPIC = '0x89b1add15eff56b3dfe299ad94e01f2b52fbcb80ae1a3baea6ae8c04cb2b98a4'; // Lockdown(owner,token,spender)
/** eth_simulateV1 with traceTransfers reports native transfers as ERC-20 logs from this address. */
const NATIVE_PSEUDO_TOKEN = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

type RawCallResult = { status: string; gasUsed: string; returnData: Hex; logs?: { address: string; topics: string[]; data: string }[]; error?: { message?: string; data?: Hex } };

/**
 * Simulates against a JSON-RPC node with eth_simulateV1 (traceTransfers on, validation off).
 * Balance changes are derived from Transfer events, so fee-on-transfer and rebasing tokens can differ.
 * Batches run as consecutive calls in one simulated block, so each call sees the previous calls' effects.
 */
export class RpcSimulator implements Simulator {
  private urls: Record<number, string>;
  private fetchImpl: typeof fetch;
  constructor(urls: Record<number, string>, options: { fetchImpl?: typeof fetch } = {}) {
    this.urls = urls;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }
  async simulate(req: SimulationRequest): Promise<SimulationResult | null> {
    return (await this.simulateBatch([req]))?.[0] ?? null;
  }
  async simulateBatch(reqs: SimulationRequest[]): Promise<SimulationResult[] | null> {
    if (!reqs.length) return [];
    const chainId = reqs[0].chainId;
    if (reqs.some(r => r.chainId !== chainId)) throw new Error('A batch must be on one chain');
    const url = this.urls[chainId];
    if (!url) return null;
    const calls = reqs.map(req => ({ from: req.from, ...(req.to && { to: req.to }), data: req.data, value: '0x' + req.value.toString(16) }));
    const res = await this.fetchImpl(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_simulateV1', params: [{ blockStateCalls: [{ calls }], traceTransfers: true, validation: false }, 'latest'] }),
    });
    if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
    const body = await res.json() as { result?: { calls: RawCallResult[] }[]; error?: { message: string } };
    const results = body.result?.[0]?.calls;
    if (body.error || !results || results.length !== reqs.length) throw new Error(`eth_simulateV1 failed: ${body.error?.message ?? 'unexpected result'}`);
    const source = `eth_simulateV1 @ chain ${chainId}`;
    const parsed: SimulationResult[] = results.map(result => result.status !== '0x1'
      ? { status: 'reverted', source, gasUsed: BigInt(result.gasUsed), revertReason: decodeRevert(result.error?.data ?? result.returnData) ?? result.error?.message, transfers: [] }
      : { status: 'success', source, gasUsed: BigInt(result.gasUsed), ...parseLogs(result.logs ?? []) });
    try { await this.readApprovalState(url, reqs, parsed); } catch { /* keep the event-based values */ }
    return parsed;
  }

  /**
   * Re-runs the calls with view calls after each one, reading the actual state of every permission the senders
   * granted so far. Needed because many tokens spend allowances without emitting Approval.
   */
  private async readApprovalState(url: string, reqs: SimulationRequest[], parsed: SimulationResult[]) {
    const owners = new Set(reqs.map(r => r.from.toLowerCase()));
    const touched = new Map<string, SimulatedApproval>();
    const after: SimulatedApproval[][] = [];
    for (const r of parsed) {
      for (const a of r.approvals ?? []) if (owners.has(a.owner)) touched.set(approvalKey(a), a);
      after.push([...touched.values()].slice(0, 24));
    }
    if (!touched.size) return;
    const calls: unknown[] = [];
    const reads: { call: number; approval: SimulatedApproval; index: number }[] = [];
    reqs.forEach((req, i) => {
      calls.push({ from: req.from, ...(req.to && { to: req.to }), data: req.data, value: '0x' + req.value.toString(16) });
      for (const a of after[i]) { reads.push({ call: i, approval: a, index: calls.length }); calls.push({ from: a.owner, to: a.emitter, data: stateCall(a) }); }
    });
    const res = await this.fetchImpl(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_simulateV1', params: [{ blockStateCalls: [{ calls }], validation: false }, 'latest'] }),
    });
    const body = await res.json() as { result?: { calls: RawCallResult[] }[] };
    const out = body.result?.[0]?.calls;
    if (!out || out.length !== calls.length) return;
    for (const { call, approval, index } of reads) {
      const r = out[index];
      if (r.status !== '0x1') continue; // non-standard token: keep the event value
      const state = decodeState(approval, r.returnData);
      if (state) (parsed[call].approvalState ??= []).push(state);
    }
  }
}

/** One key per permission: an allowance per token and spender, one NFT, or an operator per collection. */
export const approvalKey = (a: SimulatedApproval) => a.kind === 'erc721' ? `erc721:${a.token}:${a.tokenId}` : `${a.kind}:${a.token}:${a.spender}`;

function stateCall(a: SimulatedApproval): Hex {
  if (a.kind === 'erc20') return ('0xdd62ed3e' + encodeAbiParameters([{ type: 'address' }, { type: 'address' }], [a.owner as Hex, a.spender as Hex]).slice(2)) as Hex; // allowance(owner,spender)
  if (a.kind === 'permit2') return ('0x927da105' + encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'address' }], [a.owner as Hex, a.token as Hex, a.spender as Hex]).slice(2)) as Hex; // Permit2 allowance(owner,token,spender)
  if (a.kind === 'operator') return ('0xe985e9c5' + encodeAbiParameters([{ type: 'address' }, { type: 'address' }], [a.owner as Hex, a.spender as Hex]).slice(2)) as Hex; // isApprovedForAll(owner,operator)
  return ('0x081812fc' + encodeAbiParameters([{ type: 'uint256' }], [a.tokenId ?? 0n]).slice(2)) as Hex; // getApproved(tokenId)
}

function decodeState(a: SimulatedApproval, data: Hex): SimulatedApproval | null {
  try {
    if (a.kind === 'erc20') return { ...a, amount: decodeAbiParameters([{ type: 'uint256' }], data)[0] };
    if (a.kind === 'permit2') { const [amount, expiration] = decodeAbiParameters([{ type: 'uint160' }, { type: 'uint48' }, { type: 'uint48' }], data); return { ...a, amount, expiration }; }
    if (a.kind === 'operator') return { ...a, approved: decodeAbiParameters([{ type: 'bool' }], data)[0] };
    return { ...a, spender: decodeAbiParameters([{ type: 'address' }], data)[0].toLowerCase() };
  } catch { return null; }
}

type Log = { address: string; topics: string[]; data: string };
const topicAddress = (t: string) => '0x' + t.slice(26).toLowerCase();
const isWords = (data: string, n: number) => new RegExp(`^0x[0-9a-fA-F]{${64 * n}}$`).test(data);
const isEmpty = (data: string) => data === '0x' || data === '';

/** Fungible transfers only (ERC-20 and, with traceTransfers, native). */
export function parseTransfers(logs: Log[]): SimulatedTransfer[] {
  return parseLogs(logs).transfers;
}

/**
 * Reads transfers and approvals from simulated logs. The emitting contract is taken from the log itself, so a
 * contract can't fake events for another token; Permit2 events are only read from the canonical Permit2.
 */
export function parseLogs(logs: Log[]): { transfers: SimulatedTransfer[]; nftTransfers: SimulatedNftTransfer[]; approvals: SimulatedApproval[] } {
  const transfers: SimulatedTransfer[] = [], nftTransfers: SimulatedNftTransfer[] = [], approvals: SimulatedApproval[] = [];
  for (const log of logs) {
    const address = log.address.toLowerCase();
    const [topic0, t1, t2, t3] = log.topics.map(t => t.toLowerCase());
    const n = log.topics.length;
    if (topic0 === TRANSFER_TOPIC) {
      // ERC-20: 3 topics + amount; ERC-721: 4 topics (tokenId indexed), no data.
      if (n === 3 && isWords(log.data, 1)) transfers.push({ asset: address === NATIVE_PSEUDO_TOKEN ? 'native' : address, from: topicAddress(t1), to: topicAddress(t2), raw: BigInt(log.data) });
      else if (n === 4 && isEmpty(log.data)) nftTransfers.push({ standard: 'erc721', collection: address, from: topicAddress(t1), to: topicAddress(t2), tokenId: BigInt(t3), amount: 1n });
    } else if (topic0 === TRANSFER_SINGLE_TOPIC && n === 4 && isWords(log.data, 2)) {
      nftTransfers.push({ standard: 'erc1155', collection: address, from: topicAddress(t2), to: topicAddress(t3), tokenId: BigInt('0x' + log.data.slice(2, 66)), amount: BigInt('0x' + log.data.slice(66)) });
    } else if (topic0 === TRANSFER_BATCH_TOPIC && n === 4) {
      try {
        const [ids, values] = decodeAbiParameters([{ type: 'uint256[]' }, { type: 'uint256[]' }], log.data as Hex);
        if (ids.length === values.length) ids.forEach((id, i) => nftTransfers.push({ standard: 'erc1155', collection: address, from: topicAddress(t2), to: topicAddress(t3), tokenId: id, amount: values[i] }));
      } catch { /* malformed */ }
    } else if (topic0 === APPROVAL_TOPIC) {
      if (n === 3 && isWords(log.data, 1)) approvals.push({ kind: 'erc20', emitter: address, token: address, owner: topicAddress(t1), spender: topicAddress(t2), amount: BigInt(log.data) });
      else if (n === 4 && isEmpty(log.data)) approvals.push({ kind: 'erc721', emitter: address, token: address, owner: topicAddress(t1), spender: topicAddress(t2), tokenId: BigInt(t3) });
    } else if (topic0 === APPROVAL_FOR_ALL_TOPIC && n === 3 && isWords(log.data, 1)) {
      approvals.push({ kind: 'operator', emitter: address, token: address, owner: topicAddress(t1), spender: topicAddress(t2), approved: BigInt(log.data) !== 0n });
    } else if (address === PERMIT2 && n === 4 && (topic0 === PERMIT2_APPROVAL_TOPIC || topic0 === PERMIT2_PERMIT_TOPIC || topic0 === PERMIT2_LOCKDOWN_TOPIC)) {
      const base = { kind: 'permit2' as const, emitter: address, owner: topicAddress(t1), token: topicAddress(t2), spender: topicAddress(t3) };
      if (topic0 === PERMIT2_LOCKDOWN_TOPIC) approvals.push({ ...base, amount: 0n });
      else if (isWords(log.data, topic0 === PERMIT2_PERMIT_TOPIC ? 3 : 2)) approvals.push({ ...base, amount: BigInt('0x' + log.data.slice(2, 66)), expiration: Number(BigInt('0x' + log.data.slice(66, 130))) });
    }
  }
  return { transfers, nftTransfers, approvals };
}

const ERRORS = parseAbi(['error Error(string message)', 'error Panic(uint256 code)']);

function decodeRevert(data: Hex | undefined): string | undefined {
  if (!data || data === '0x') return undefined;
  try {
    const decoded = decodeErrorResult({ abi: ERRORS, data });
    return decoded.errorName === 'Error' ? String(decoded.args[0]) : `Panic(0x${(decoded.args[0] as bigint).toString(16)})`;
  } catch {
    return `custom error ${data.slice(0, 10)}`;
  }
}

/** Returns canned results keyed by `${chainId}:${to}:${data}`; for tests and demos. */
export class MockSimulator implements Simulator {
  private fixtures: Map<string, SimulationResult>;
  constructor(fixtures: Record<string, SimulationResult>) {
    this.fixtures = new Map(Object.entries(fixtures).map(([k, v]) => [k.toLowerCase(), v]));
  }
  static key(req: { chainId: number; to: string | null; data: string }): string {
    return `${req.chainId}:${req.to ?? 'create'}:${req.data}`.toLowerCase();
  }
  async simulate(req: SimulationRequest): Promise<SimulationResult | null> {
    return this.fixtures.get(MockSimulator.key(req)) ?? null;
  }
  /** Per-call fixtures, in order; null unless every call has one. */
  async simulateBatch(reqs: SimulationRequest[]): Promise<SimulationResult[] | null> {
    const results = reqs.map(r => this.fixtures.get(MockSimulator.key(r)));
    return results.every(r => r) ? results as SimulationResult[] : null;
  }
}
