import { decodeErrorResult, parseAbi, type Hex } from 'viem';
import type { SimulatedTransfer, SimulationRequest, SimulationResult, Simulator } from './types.ts';

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
/** eth_simulateV1 with traceTransfers reports native transfers as ERC-20 logs from this address. */
const NATIVE_PSEUDO_TOKEN = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

/**
 * Simulates against a JSON-RPC node with eth_simulateV1 (traceTransfers on, validation off).
 * Balance changes are derived from Transfer events, so fee-on-transfer and rebasing tokens can differ.
 */
export class RpcSimulator implements Simulator {
  private urls: Record<number, string>;
  private fetchImpl: typeof fetch;
  constructor(urls: Record<number, string>, options: { fetchImpl?: typeof fetch } = {}) {
    this.urls = urls;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }
  async simulate(req: SimulationRequest): Promise<SimulationResult | null> {
    const url = this.urls[req.chainId];
    if (!url) return null;
    const call = { from: req.from, ...(req.to && { to: req.to }), data: req.data, value: '0x' + req.value.toString(16) };
    const res = await this.fetchImpl(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_simulateV1', params: [{ blockStateCalls: [{ calls: [call] }], traceTransfers: true, validation: false }, 'latest'] }),
    });
    if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
    const body = await res.json() as { result?: { calls: { status: string; gasUsed: string; returnData: Hex; logs?: { address: string; topics: string[]; data: string }[]; error?: { message?: string; data?: Hex } }[] }[]; error?: { message: string } };
    if (body.error || !body.result?.[0]?.calls?.[0]) throw new Error(`eth_simulateV1 failed: ${body.error?.message ?? 'empty result'}`);
    const result = body.result[0].calls[0];
    const source = `eth_simulateV1 @ chain ${req.chainId}`;
    if (result.status !== '0x1') {
      return { status: 'reverted', source, gasUsed: BigInt(result.gasUsed), revertReason: decodeRevert(result.error?.data ?? result.returnData) ?? result.error?.message, transfers: [] };
    }
    return { status: 'success', source, gasUsed: BigInt(result.gasUsed), transfers: parseTransfers(result.logs ?? []) };
  }
}

export function parseTransfers(logs: { address: string; topics: string[]; data: string }[]): SimulatedTransfer[] {
  const out: SimulatedTransfer[] = [];
  for (const log of logs) {
    // ERC-20 Transfer has exactly 3 topics; ERC-721 has 4 and is skipped here.
    if (log.topics.length !== 3 || log.topics[0].toLowerCase() !== TRANSFER_TOPIC || !/^0x[0-9a-fA-F]{64}$/.test(log.data)) continue;
    const address = log.address.toLowerCase();
    out.push({ asset: address === NATIVE_PSEUDO_TOKEN ? 'native' : address, from: '0x' + log.topics[1].slice(26).toLowerCase(), to: '0x' + log.topics[2].slice(26).toLowerCase(), raw: BigInt(log.data) });
  }
  return out;
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
}
