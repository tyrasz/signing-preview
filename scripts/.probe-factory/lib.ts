import { encodeFunctionData, decodeAbiParameters, encodeAbiParameters, parseAbi, keccak256, type Hex } from 'viem';
import { readFileSync } from 'node:fs';
import { ForkSimulator } from '../../src/fork-simulator.ts';


export const URL_ = 'https://base-rpc.publicnode.com';
export const FACTORY = '0xb20f000000000000000000000000000000000000';
export const PROBE = '0x00000000000000000000000000000000000c0ffe';
export const SENDER = '0x1111111111111111111111111111111111111111';
export const PROBE_CODE = JSON.parse(readFileSync(new URL('./probe-code.json', import.meta.url), 'utf8')).code as Hex;
const probeAbi = parseAbi(['struct C { address to; bytes data; uint256 gas; uint8 kind; }', 'function run(C[] cs) returns (bytes)', 'function runThenRevert(C[] cs)']);
export const factoryAbi = parseAbi([
  'function createB20(uint8 variant, bytes32 salt, bytes params, bytes[] initCalls) payable returns (address)',
  'function getB20Address(uint8 variant, address sender, bytes32 salt) view returns (address)',
  'function isB20(address) view returns (bool)',
  'function isB20Initialized(address) view returns (bool)',
]);
export type C = { to: string; data: Hex; gas: bigint; kind: number };
export const runData = (cs: C[], revert = false) => encodeFunctionData({ abi: probeAbi, functionName: revert ? 'runThenRevert' : 'run', args: [cs.map(c => ({ ...c, to: c.to as Hex }))] });

export const assetParams = (name = 'Probe Token', symbol = 'PRB', admin = '0x0000000000000000000000000000000000000000', decimals = 18, version = 1) =>
  encodeAbiParameters([{ type: 'tuple', components: [{ type: 'uint8' }, { type: 'string' }, { type: 'string' }, { type: 'address' }, { type: 'uint8' }] }], [[version, name, symbol, admin as Hex, decimals]]);
export const stableParams = (name = 'Probe USD', symbol = 'PUSD', admin = '0x0000000000000000000000000000000000000000', currency = 'USD', version = 1) =>
  encodeAbiParameters([{ type: 'tuple', components: [{ type: 'uint8' }, { type: 'string' }, { type: 'string' }, { type: 'address' }, { type: 'string' }] }], [[version, name, symbol, admin as Hex, currency]]);
export const create = (variant: number, salt: Hex, params: Hex, init: Hex[] = []) => encodeFunctionData({ abi: factoryAbi, functionName: 'createB20', args: [variant, salt, params, init] });
export const tokenAt = (variant: number, sender: string, salt: Hex) => `0xb2${'00'.repeat(9)}${variant.toString(16).padStart(2, '0')}${keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [sender as Hex, salt])).slice(2, 20)}`;

export type Tx = { to: string; data: Hex; gas?: bigint; value?: bigint; from?: string; accessList?: { address: string; storageKeys: string[] }[] };

async function rpc(method: string, params: unknown[]) {
  const r = await fetch(URL_, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json() as { result?: unknown; error?: unknown };
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result;
}
export const blockNumber = async () => BigInt(await rpc('eth_blockNumber', []) as string);

export type Out = { status: string; gasUsed?: bigint; returnData?: string; logs?: { address: string; topics: string[]; data: string }[]; error?: string };

export async function onNode(txs: Tx[], block: bigint, extraState: Record<string, unknown> = {}): Promise<Out[]> {
  const res = await rpc('eth_simulateV1', [{ blockStateCalls: [{ stateOverrides: { [PROBE]: { code: PROBE_CODE }, ...extraState }, calls: txs.map(t => ({ from: t.from ?? SENDER, to: t.to, data: t.data, ...(t.gas && { gas: `0x${t.gas.toString(16)}` }), ...(t.value && { value: `0x${t.value.toString(16)}` }), ...(t.accessList && { accessList: t.accessList }) })) }], validation: false, traceTransfers: false }, `0x${block.toString(16)}`]) as { calls: { status: string; gasUsed: string; returnData: string; logs: { address: string; topics: string[]; data: string }[]; error?: { message: string; data?: string } }[] }[];
  return res[0].calls.map(c => ({ status: c.status === '0x1' ? 'success' : 'reverted', gasUsed: BigInt(c.gasUsed), returnData: c.returnData, logs: c.logs.map(l => ({ address: l.address.toLowerCase(), topics: l.topics, data: l.data })), error: c.error?.message }));
}

export async function locally(txs: Tx[], block: bigint, trace = false, extraState: Record<string, { code?: string; stateDiff?: Record<string, string> }> = {}) {
  const sim = new ForkSimulator({ 8453: URL_ }, { block: () => `0x${block.toString(16)}`, timeoutMs: 120_000});
  const reqs = txs.map(t => ({ chainId: 8453, from: t.from ?? SENDER, to: t.to, data: t.data, value: t.value ?? 0n, ...(t.gas && { gas: t.gas }), ...(t.accessList && { accessList: t.accessList }), stateOverrides: { [PROBE]: { code: PROBE_CODE }, ...extraState }, trace }));
  return (await sim.simulateBatch(reqs))!;
}

/** Decodes Probe.run's output: a sequence of (bool ok, uint256 gas, bytes ret). */
export function decodeRun(hex: string | undefined): { ok: boolean; gas: bigint; ret: string }[] {
  if (!hex || hex === '0x') return [];
  let data: Hex = hex as Hex;
  // run returns (bytes): unwrap
  try { [data] = decodeAbiParameters([{ type: 'bytes' }], data) as [Hex]; } catch { /* revert data is raw */ }
  const out: { ok: boolean; gas: bigint; ret: string }[] = [];
  let rest = data.slice(2);
  while (rest.length >= 192) {
    const [ok, gas, ret] = decodeAbiParameters([{ type: 'bool' }, { type: 'uint256' }, { type: 'bytes' }], `0x${rest}` as Hex);
    out.push({ ok, gas, ret });
    const len = 96 + 32 + Math.ceil((ret.length - 2) / 2 / 32) * 32;
    rest = rest.slice(len * 2);
  }
  return out;
}

export function show(label: string, node: Out[], local: Out[]) {
  console.log(`== ${label}`);
  for (let i = 0; i < Math.max(node.length, local.length); i++) {
    const n = node[i], l = local[i];
    console.log(` tx${i} node: ${n?.status} gas=${n?.gasUsed} ret=${(n?.returnData ?? '').slice(0, 140)} ${n?.error ?? ''} logs=${n?.logs?.length}`);
    console.log(` tx${i} locl: ${l?.status} gas=${l?.gasUsed} ret=${(l?.returnData ?? '').slice(0, 140)} ${(l as { revertReason?: string })?.revertReason ?? ''} logs=${l?.logs?.length}`);
    const dn = decodeRun(n?.returnData), dl = decodeRun(l?.returnData);
    for (let j = 0; j < Math.max(dn.length, dl.length); j++) {
      const a = dn[j], b = dl[j];
      const same = a && b && a.ok === b.ok && a.gas === b.gas && a.ret === b.ret;
      console.log(`   [${j}] ${same ? 'SAME' : 'DIFF'} node ok=${a?.ok} gas=${a?.gas} ret=${a?.ret.slice(0, 74)} | local ok=${b?.ok} gas=${b?.gas} ret=${b?.ret.slice(0, 74)}`);
    }
  }
}
