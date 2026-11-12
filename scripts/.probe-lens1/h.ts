import { readFileSync } from 'node:fs';
import { decodeAbiParameters, encodeAbiParameters, type Hex } from 'viem';
import { ForkSimulator } from '../../src/fork-simulator.ts';
export const RPC = 'https://base-rpc.publicnode.com';
export const TIMER = '0x00000000000000000000000000000000071me700'.replace('71me', '7100');
export const TIMER_CODE = readFileSync(new URL('./timer.hex', import.meta.url), 'utf8').trim();
export const USER = '0x00000000000000000000000000000000000a11ce';
export async function rpc(method: string, params: unknown[]) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return (await r.json()) as { result?: any; error?: any };
}
const latest = BigInt((await rpc('eth_blockNumber', [])).result) - 3n;
export const TAG = `0x${latest.toString(16)}`;
export const fork = new ForkSimulator({ 8453: RPC }, { block: () => TAG, timeoutMs: 120_000, trace: false });
export type Call = { from?: string; to: string; data: string; value?: bigint; gas?: bigint };
export type Over = Record<string, { code?: string; balance?: string; stateDiff?: Record<string, string>; movePrecompileToAddress?: string }>;
export async function node(calls: Call[], overrides: Over = {}) {
  const r = await rpc('eth_simulateV1', [{ blockStateCalls: [{ calls: calls.map(c => ({ from: c.from ?? USER, to: c.to, input: c.data, ...(c.value && { value: `0x${c.value.toString(16)}` }), ...(c.gas && { gas: `0x${c.gas.toString(16)}` }) })), stateOverrides: { [USER]: { balance: '0x56bc75e2d63100000' }, ...overrides } }], validation: false }, TAG]);
  if (r.error) return { error: r.error };
  return r.result[0].calls.map((c: any) => ({ status: c.status === '0x1' ? 'success' : 'reverted', returnData: c.returnData, gasUsed: BigInt(c.gasUsed), logs: c.logs?.length, error: c.error?.message }));
}
export async function local(calls: Call[], overrides: Over = {}, trace = false) {
  const reqs = calls.map(c => ({ chainId: 8453, from: c.from ?? USER, to: c.to, data: c.data, value: c.value ?? 0n, ...(c.gas && { gas: c.gas }), stateOverrides: { [USER]: { balance: '0x56bc75e2d63100000' }, ...overrides }, ...(trace && { trace: true }) }));
  try {
    const r = trace ? await fork.trace(reqs as any) : await fork.simulateBatch(reqs as any);
    return r!.map(x => ({ status: x.status, returnData: x.returnData, gasUsed: x.gasUsed, logs: x.logs?.length, revertReason: x.revertReason, ...(trace && { trace: x.trace }) }));
  } catch (e) { return { error: String(e) }; }
}
export const timed = (to: string, data: string, kind = 0, value = 0n, gas = 1_000_000n) => encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint8' }, { type: 'bytes' }], [to as Hex, value, gas, kind, data as Hex]);
export const untime = (d: string | undefined) => { try { const [ok, used, ret] = decodeAbiParameters([{ type: 'bool' }, { type: 'uint256' }, { type: 'bytes' }], d as Hex); return { ok, used, ret }; } catch { return { raw: d }; } };
export const timerOver = (extra: Over = {}): Over => ({ [TIMER]: { code: TIMER_CODE, balance: '0xde0b6b3a7640000' }, ...extra });
export async function both(label: string, calls: Call[], overrides: Over = {}, opts: { untime?: boolean } = {}) {
  const [n, l] = await Promise.all([node(calls, overrides), local(calls, overrides)]);
  const show = (x: any) => Array.isArray(x) ? x.map(c => ({ ...c, ...(opts.untime && { timed: untime(c.returnData) }) })) : x;
  console.log('==', label);
  console.log(' node ', JSON.stringify(show(n), (_, v) => typeof v === 'bigint' ? v.toString() : v));
  console.log(' local', JSON.stringify(show(l), (_, v) => typeof v === 'bigint' ? v.toString() : v));
}
