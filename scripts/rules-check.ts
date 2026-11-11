// npm run rules -- [--chain 1|42161|8453|10|137|56|999|11155111|all] [--strict] [--summary-md file] [--out report.json]
//
// Does the local EVM (ForkSimulator: every call trace, and the simulation itself where an RPC has no eth_simulateV1)
// still run each chain's rules? Chains change them: Base added node-run precompiles in November 2026, BNB Chain
// forks again in December, Ethereum's Glamsterdam is on its testnet. This asks each chain's node, and compares:
//   - its fork (eth_config, EIP-7910) with the one the chain's profile was last checked against, the fork it has
//     scheduled, and the precompiles it lists that the local EVM neither has nor forwards (those are refused in a
//     local run, not misrun);
//   - every opcode: after seventeen pushes (1 on top, then 2, 3, ...), the opcode, then code that returns the top of
//     the stack and the memory size. The node (eth_simulateV1, or eth_call where it has none) and the local EVM run
//     the same code on the same named block: the same outcome, the same bytes returned, the same events, the same gas;
//   - the precompiles, each called with inputs it accepts (a signature to recover, points to add, a pairing that
//     holds, a KZG proof, a P-256 signature) and with none: the same answer at the same price.
// Gas isn't compared on Arbitrum (its node adds a charge for L1 data) or where the node has only eth_call.
// --strict exits with 1 when anything differs or a chain's fork isn't the one checked. Read-only: nothing is sent.
import { appendFileSync, writeFileSync } from 'node:fs';
import { createHash, createSign, generateKeyPairSync } from 'node:crypto';
import { getActivePrecompiles } from '@ethereumjs/evm';
import { createCustomCommon, Mainnet } from '@ethereumjs/common';
import { privateKeyToAccount } from 'viem/accounts';
import { hashMessage, type Hex } from 'viem';
import { CHAIN_PROFILES, ForkSimulator, nodeRulesOf } from '../src/fork-simulator.ts';
import { headerOf, nodeOverrides, pinLatest, type BlockAt, type RpcHeader } from '../src/block.ts';
import { chainsOwnLog } from '../src/evm/trace.ts';
import { chainName, EVM_RPCS, rpcUrlFor } from '../src/chains.ts';
import { JsonRpcClient } from '../src/rpc.ts';
import type { SimulationRequest } from '../src/types.ts';

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const STRICT = process.argv.includes('--strict'), SUMMARY_MD = arg('summary-md', ''), OUT = arg('out', '');
const CHAINS_ASKED = arg('chain', 'all') === 'all' ? Object.keys(EVM_RPCS).map(Number) : arg('chain', '1').split(',').map(Number);

const FROM = '0x000000000000000000000000000000000000dead';
const RICH = { [FROM]: { balance: '0x56bc75e2d63100000' } };
const GAS = 1_048_576n;
const INVALID = /invalid opcode|not defined|notactivated|not supported|undefined opcode|opcodenotfound|unsupported opcode|invalid instruction|invalidfeopcode|invalidimmediate|invalid immediate/i;
const hex2 = (n: number) => n.toString(16).padStart(2, '0');
const word = (v: bigint | number) => BigInt(v).toString(16).padStart(64, '0');
/** The address the i-th program of a batch is placed at. */
const place = (i: number) => `0x${(0xc0de0000 + i).toString(16).padStart(40, '0')}`;

interface Program { label: string; code?: Hex; to?: string; data?: Hex; value?: bigint; balance?: bigint; /** The code is `caller`: it returns whether the precompile's call succeeded, the gas it spent, and what came back. */ precompile?: boolean }
interface Outcome { kind: 'runs' | 'invalid' | 'fails' | 'refused'; returns: string; gas?: bigint; logs: string; why?: string }

/** Seventeen pushes (1 on top), the opcode, then: store the top of the stack at 0, the memory size at 32, return both. */
const opcodeProgram = (op: number): Hex => `0x${Array.from({ length: 17 }, (_, i) => `60${hex2(17 - i)}`).join('')}${hex2(op)}6000525960205260406000f3`;

/** A few mnemonics, enough for the crafted programs; a bare hex literal is a PUSH of it. */
const OPS: Record<string, string> = {
  STOP: '00', SUB: '03', EXP: '0a', SHL: '1b', KECCAK256: '20', BALANCE: '31', CALLER: '33', CALLDATASIZE: '36', CALLDATACOPY: '37', RETURNDATASIZE: '3d', RETURNDATACOPY: '3e',
  BLOCKHASH: '40', NUMBER: '43', POP: '50', MLOAD: '51', SWAP1: '90',
  MSTORE: '52', SLOAD: '54', SSTORE: '55', GAS: '5a', TLOAD: '5c', TSTORE: '5d', MCOPY: '5e', LOG2: 'a2', CREATE: 'f0', CALL: 'f1', RETURN: 'f3', DELEGATECALL: 'f4', CREATE2: 'f5',
  STATICCALL: 'fa', REVERT: 'fd', SELFDESTRUCT: 'ff',
};
const asm = (source: string): Hex => `0x${source.trim().split(/\s+/).map(t => {
  if (OPS[t]) return OPS[t];
  if (!/^([0-9a-f]{2})+$/.test(t) || t.length > 64) throw new Error(`asm: ${t}`);
  return `${(0x5f + t.length / 2).toString(16)}${t}`;
}).join('')}`;

/** Programs that the seventeen-push form can't reach: opcodes whose arguments have to mean something. */
function crafted(): Program[] {
  const RET = '00 MSTORE 20 00 RETURN'; // the top of the stack, as the 32 bytes returned
  // Initcode that returns ten bytes (of zeros) as the new contract's code, left-aligned at memory 0.
  const INIT = '600a6000f3 d8 SHL 00 MSTORE';
  const NOBODY = '000000000000000000000000000000000beef078', EMPTY = '000000000000000000000000000000000beef079';
  return [
    { label: 'BLOCKHASH of the block before', code: asm(`01 NUMBER SUB BLOCKHASH ${RET}`) },
    { label: 'BALANCE of the sender', code: asm(`CALLER BALANCE ${RET}`) },
    { label: 'SLOAD of a slot twice (cold, then warm)', code: asm(`07 SLOAD POP 07 SLOAD ${RET}`) },
    { label: 'SSTORE to an empty slot, then SLOAD', code: asm(`2a 07 SSTORE 07 SLOAD ${RET}`) },
    { label: 'SSTORE set then cleared (a refund)', code: asm(`2a 07 SSTORE 00 07 SSTORE 07 SLOAD ${RET}`) },
    { label: 'TSTORE then TLOAD', code: asm(`2a 07 TSTORE 07 TLOAD ${RET}`) },
    { label: 'MCOPY of a word', code: asm(`2a 00 MSTORE 20 00 40 MCOPY 40 MLOAD ${RET}`) },
    { label: 'KECCAK256 of 64 bytes', code: asm(`2a 00 MSTORE 40 00 KECCAK256 ${RET}`) },
    { label: 'EXP with a two-byte exponent', code: asm(`012c 03 EXP ${RET}`) },
    { label: 'LOG2 of a word', code: asm('2a 00 MSTORE 02 01 20 00 LOG2 STOP') },
    { label: 'CREATE of ten bytes of code', code: asm(`${INIT} 05 00 00 CREATE ${RET}`) },
    { label: 'CREATE2 of ten bytes of code', code: asm(`${INIT} 2a 05 00 00 CREATE2 ${RET}`) },
    { label: 'CALL to the sender with a wei', code: asm(`00 00 00 00 01 CALLER ffff CALL ${RET}`), balance: 10n },
    { label: 'CALL to an account that does not exist yet, with a wei', code: asm(`00 00 00 00 01 ${NOBODY} GAS CALL ${RET}`), balance: 10n },
    { label: 'STATICCALL to the identity precompile', code: asm(`2a 00 MSTORE 20 00 20 00 04 GAS STATICCALL POP 00 MLOAD ${RET}`) },
    { label: 'DELEGATECALL to an account with no code', code: asm(`00 00 00 00 ${EMPTY} GAS DELEGATECALL ${RET}`) },
    { label: 'SELFDESTRUCT with a balance, to the sender', code: asm('CALLER SELFDESTRUCT'), balance: 10n },
    { label: 'REVERT with a word', code: asm('2a 00 MSTORE 20 00 REVERT') },
    { label: 'RETURNDATASIZE after a call that returns a word', code: asm(`2a 00 MSTORE 20 00 20 00 04 GAS STATICCALL POP RETURNDATASIZE ${RET}`) },
    // Amsterdam's stack opcodes with an immediate (EIP-8024): the 17th item copied to the top, the top swapped with
    // the 18th, and two items below the top exchanged. Before Amsterdam they are no opcodes at all.
    { label: 'DUPN of the 17th item', code: `0x${Array.from({ length: 20 }, (_, i) => `60${hex2(20 - i)}`).join('')}e600${asm(RET).slice(2)}` },
    { label: 'SWAPN with the 18th item', code: `0x${Array.from({ length: 20 }, (_, i) => `60${hex2(20 - i)}`).join('')}e700${asm(RET).slice(2)}` },
    { label: 'EXCHANGE of two items', code: `0x${Array.from({ length: 20 }, (_, i) => `60${hex2(20 - i)}`).join('')}e80150${asm(RET).slice(2)}` },
    { label: 'a plain transfer of a wei to an account', to: '0x000000000000000000000000000000000000beef', value: 1n },
    { label: 'a call with 100 bytes of calldata', to: '0x000000000000000000000000000000000000beef', data: `0x${'11'.repeat(100)}` },
  ];
}

/**
 * A contract that passes its calldata to a precompile and returns four words: whether the call succeeded, the gas
 * it spent, how many bytes came back, and their hash. Called directly, a cheap precompile's price hides under the
 * calldata floor every transaction pays; measured from inside, it doesn't.
 */
const caller = (target: number): Hex => asm(`CALLDATASIZE 00 00 CALLDATACOPY GAS 00 00 CALLDATASIZE 00 ${target.toString(16).padStart(target > 0xff ? 4 : 2, '0')} GAS STATICCALL GAS
  SWAP1 00 MSTORE SWAP1 SUB 20 MSTORE RETURNDATASIZE 40 MSTORE RETURNDATASIZE 00 80 RETURNDATACOPY RETURNDATASIZE 80 KECCAK256 60 MSTORE 80 00 RETURN`);

/** The precompiles, each with an input it accepts. Where an input is wrong for a chain, the node and the local EVM should refuse it alike. */
async function precompilePrograms(): Promise<Program[]> {
  const zeros = (n: number) => '00'.repeat(n);
  // ecrecover: a real signature by a throwaway key.
  const key = privateKeyToAccount(`0x${'42'.repeat(32)}`), digest = hashMessage('signing-preview rules check');
  const sig = await key.sign({ hash: digest });
  const recover = `0x${digest.slice(2)}${word(BigInt(`0x${sig.slice(130)}`))}${sig.slice(2, 130)}` as Hex;
  // bn254: the generator (1, 2) added to itself, multiplied by 3, and a pairing that holds: e(P, Q) e(-P, Q) = 1.
  const P = word(1) + word(2), negP = word(1) + word(21888242871839275222246405745257275088696311157297823662689037894645226208581n);
  const Q = '198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c2' + '1800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6ed' + '090689d0585ff075ec9e99ad690c3395bc4b313370b38ef355acdadcd122975b' + '12c85ea5db8c6deb4aab71808dcb408fe3d1e7690c43d37b4ce6cc0166fa7daa';
  // KZG: the zero polynomial's commitment and proof are the point at infinity; it evaluates to 0 at 0.
  const infinity = `c0${zeros(47)}`, versioned = `01${createHash('sha256').update(Buffer.from(infinity, 'hex')).digest('hex').slice(2)}`;
  // P-256: a signature made here.
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const message = Buffer.from('signing-preview rules check'), der = createSign('sha256').update(message).sign(privateKey);
  const int = (at: number) => { const len = der[at + 1]; return { value: der.subarray(at + 2, at + 2 + len).toString('hex').replace(/^00/, '').padStart(64, '0'), next: at + 2 + len }; };
  const r = int(der[1] & 0x80 ? 2 + (der[1] & 0x7f) : 2), s = int(r.next);
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const p256 = `0x${createHash('sha256').update(message).digest('hex')}${r.value}${s.value}${Buffer.from(jwk.x, 'base64url').toString('hex').padStart(64, '0')}${Buffer.from(jwk.y, 'base64url').toString('hex').padStart(64, '0')}` as Hex;
  const programs: Program[] = [
    { precompile: true, label: '0x01 ecrecover', code: caller(1), data: recover },
    { precompile: true, label: '0x02 sha256 of 100 bytes', code: caller(2), data: `0x${'ab'.repeat(100)}` },
    { precompile: true, label: '0x03 ripemd160 of 100 bytes', code: caller(3), data: `0x${'ab'.repeat(100)}` },
    { precompile: true, label: '0x04 identity of 100 bytes', code: caller(4), data: `0x${'ab'.repeat(100)}` },
    { precompile: true, label: '0x05 modexp, 32-byte numbers', code: caller(5), data: `0x${word(32)}${word(32)}${word(32)}${word(3)}${word(65537)}${word((1n << 255n) - 19n)}` },
    { precompile: true, label: '0x05 modexp, 256-byte numbers', code: caller(5), data: `0x${word(256)}${word(32)}${word(256)}${'07'.repeat(256)}${word(65537)}${'fd'.repeat(256)}` },
    { precompile: true, label: '0x05 modexp, numbers over 1,024 bytes', code: caller(5), data: `0x${word(1100)}${word(1)}${word(1100)}${'07'.repeat(1100)}03${'fd'.repeat(1100)}` },
    { precompile: true, label: '0x06 bn254 add', code: caller(6), data: `0x${P}${P}` },
    { precompile: true, label: '0x07 bn254 multiply', code: caller(7), data: `0x${P}${word(3)}` },
    { precompile: true, label: '0x08 bn254 pairing, two pairs', code: caller(8), data: `0x${P}${Q}${negP}${Q}` },
    { precompile: true, label: '0x09 blake2f, 12 rounds', code: caller(9), data: `0x0000000c${'5a'.repeat(64)}${'c3'.repeat(128)}${zeros(15)}03${'01'}` },
    { precompile: true, label: '0x0a point evaluation (a proof that holds)', code: caller(10), data: `0x${versioned}${zeros(32)}${zeros(32)}${infinity}${infinity}` },
    { precompile: true, label: '0x0b bls12-381 G1 add', code: caller(11), data: `0x${zeros(256)}` },
    { precompile: true, label: '0x0c bls12-381 G1 multi-scalar', code: caller(12), data: `0x${zeros(160)}` },
    { precompile: true, label: '0x0d bls12-381 G2 add', code: caller(13), data: `0x${zeros(512)}` },
    { precompile: true, label: '0x0e bls12-381 G2 multi-scalar', code: caller(14), data: `0x${zeros(288)}` },
    { precompile: true, label: '0x0f bls12-381 pairing', code: caller(15), data: `0x${zeros(384)}` },
    { precompile: true, label: '0x10 bls12-381 map to G1', code: caller(16), data: `0x${zeros(63)}01` },
    { precompile: true, label: '0x11 bls12-381 map to G2', code: caller(17), data: `0x${zeros(63)}01${zeros(63)}01` },
    { precompile: true, label: '0x100 P-256 verify', code: caller(0x100), data: p256 },
  ];
  // And each low address with no input: a precompile that fails on it, or an account that isn't one.
  for (const n of [...Array.from({ length: 0x20 }, (_, i) => i + 1), 0x100, 0x101]) programs.push({ precompile: true, label: `0x${n.toString(16)} with no input`, code: caller(n), data: '0x' });
  // And a few more points and pairs, where a price follows a discount table.
  for (const [name, n, unit] of [['G1 multi-scalar', 12, 160], ['G2 multi-scalar', 14, 288], ['pairing', 15, 384]] as const) for (const k of [2, 3, 8]) programs.push({ precompile: true, label: `0x${n.toString(16).padStart(2, '0')} bls12-381 ${name}, ${k}`, code: caller(n), data: `0x${zeros(unit * k)}` });
  return programs;
}

class Chain {
  readonly chainId: number; readonly url: string; readonly client: JsonRpcClient; readonly fork: ForkSimulator;
  simulateV1 = true;
  constructor(chainId: number) {
    this.chainId = chainId;
    this.url = rpcUrlFor(chainId, process.env) ?? (() => { throw new Error(`no RPC for chain ${chainId}`); })();
    this.client = new JsonRpcClient({ [chainId]: this.url }, { timeoutMs: 20_000, retries: 5, retryDelayMs: 800 });
    this.fork = new ForkSimulator({ [chainId]: this.url }, { timeoutMs: 60_000, watchTokens: false });
  }
  private async post(body: unknown): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(this.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
        if ((res.status === 429 || res.status >= 500) && attempt < 6) { await new Promise(r => setTimeout(r, 1500 * (attempt + 1))); continue; }
        const out = await res.json();
        const limited = JSON.stringify(out).slice(0, 400);
        if (/rate limit|too many requests/i.test(limited) && attempt < 6) { await new Promise(r => setTimeout(r, 5000 * (attempt + 1))); continue; }
        return out;
      } catch (e) { if (attempt >= 4) return { error: { message: String((e as Error).cause ?? e) } }; await new Promise(r => setTimeout(r, 1000)); }
    }
  }

  /** The programs on the node and in the local EVM, on one named block. */
  async both(programs: Program[]): Promise<{ node: Outcome; local: Outcome }[]> {
    for (let attempt = 0; ; attempt++) {
      const hadSimulate = this.simulateV1;
      const at = this.simulateV1 ? await pinLatest(this.client, this.chainId) : await this.inBlock();
      const placed = programs.map((p, i) => ({ ...p, to: p.to ?? place(i) }));
      const overrides: Record<string, { code?: string; balance?: string }> = { ...RICH };
      for (const p of placed) if (p.code) overrides[p.to] = { code: p.code, ...(p.balance !== undefined && { balance: `0x${p.balance.toString(16)}` }) };
      const node = await this.onNode(placed, overrides, at);
      // A public node drops a block's state within seconds or minutes: on such an answer, another block. And a node
      // found to have no eth_simulateV1 is asked again the other way, with the block to match.
      if ((!node && attempt < 3) || hadSimulate !== this.simulateV1) continue;
      const local = await this.locally(placed, overrides, at);
      return placed.map((_, i) => ({ node: node?.[i] ?? { kind: 'refused', returns: '', logs: '', why: 'the node did not answer' }, local: local[i] }));
    }
  }

  /**
   * For a node with only eth_call, which runs a call in the block it names, not after it, and at no base fee: the
   * local EVM is given that block's own header, and no base fee, so that the two run the same thing.
   */
  private async inBlock(): Promise<BlockAt | undefined> {
    const h = await this.client.call(this.chainId, 'eth_getBlockByNumber', ['latest', false]).then(r => r as RpcHeader | null, () => null);
    return h?.number ? { block: h.number, header: { ...headerOf(this.chainId, h), baseFeePerGas: 0n } } : undefined;
  }

  private async onNode(programs: (Program & { to: string })[], overrides: Record<string, unknown>, at: BlockAt | undefined): Promise<Outcome[] | null> {
    const calls = programs.map(p => ({ from: FROM, to: p.to, data: p.data ?? '0x', value: `0x${(p.value ?? 0n).toString(16)}`, gas: `0x${GAS.toString(16)}` }));
    const kind = (ok: boolean, message?: string): Outcome['kind'] => (ok ? 'runs' : INVALID.test(message ?? '') ? 'invalid' : 'fails');
    // Without the pseudo-logs traceTransfers would add, and the logs a chain writes outside the EVM (Polygon's own transfer logs).
    const logsOf = (logs: { address: string; topics: string[]; data: string }[] | undefined) => (logs ?? []).filter(l => l.address.toLowerCase() !== '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' && !chainsOwnLog(l)).map(l => `${l.address.toLowerCase()}:${l.topics.join(',')}:${l.data}`).join('|');
    if (this.simulateV1) {
      const out = await this.post({ jsonrpc: '2.0', id: 1, method: 'eth_simulateV1', params: [{ blockStateCalls: [{ stateOverrides: overrides, calls, ...(at && { blockOverrides: nodeOverrides(at.header) }) }], validation: false }, at?.block ?? 'latest'] });
      if (out.error && (out.error.code === -32601 || /method not found|does not exist|not supported|unsupported method/i.test(out.error.message ?? ''))) this.simulateV1 = false;
      else if (out.error || !out.result?.[0]?.calls) return null;
      else return (out.result[0].calls as { status: string; returnData: string; gasUsed: string; logs?: any[]; error?: { message?: string; data?: string } }[]).map(c => ({ kind: kind(c.status === '0x1', c.error?.message), returns: ((c.status === '0x1' ? c.returnData : c.error?.data ?? c.returnData) ?? '0x').toLowerCase(), gas: BigInt(c.gasUsed), logs: logsOf(c.logs), why: c.error?.message }));
    }
    // No eth_simulateV1: each program in an eth_call of its own (no gas figure, no events).
    const out = await this.post(calls.map((c, i) => ({ jsonrpc: '2.0', id: i, method: 'eth_call', params: [c, at?.block ?? 'latest', overrides] })));
    if (!Array.isArray(out)) return null;
    const byId = new Map(out.map((r: any) => [r.id, r]));
    return calls.map((_, i) => { const r = byId.get(i); return r?.error ? { kind: kind(false, r.error.message), returns: (r.error.data ?? '0x').toLowerCase(), logs: '', why: r.error.message } : { kind: 'runs', returns: String(r?.result ?? '0x').toLowerCase(), logs: '' }; });
  }

  private async locally(programs: (Program & { to: string })[], overrides: Record<string, { code?: string; balance?: string }>, at: BlockAt | undefined): Promise<Outcome[]> {
    const request = (p: Program & { to: string }): SimulationRequest => ({ chainId: this.chainId, from: FROM, to: p.to, data: p.data ?? '0x', value: p.value ?? 0n, gas: GAS, stateOverrides: overrides, ...(at && { at }) });
    const one = async (reqs: SimulationRequest[]): Promise<Outcome[]> => (await this.fork.simulateBatch(reqs))!.map(r => ({
      kind: r.status === 'success' ? 'runs' : INVALID.test(r.revertReason ?? '') ? 'invalid' : 'fails', returns: (r.returnData ?? '0x').toLowerCase(), gas: r.gasUsed,
      logs: (r.logs ?? []).map(l => `${l.address.toLowerCase()}:${l.topics.join(',')}:${l.data}`).join('|'), why: r.revertReason,
    }));
    try { return await one(programs.map(request)); } catch {
      // Something in the batch the local EVM refuses, or a read that failed: each program alone, so one says which.
      const out: Outcome[] = [];
      for (const p of programs) { try { out.push(...await one([request(p)])); } catch (e) { out.push({ kind: 'refused', returns: '', logs: '', why: (e as Error).message }); } }
      return out;
    }
  }
}

interface Report { chainId: number; name: string; block?: string; fork: string[]; nodeOnly: string[]; compared: number; differences: string[]; expected: string[]; drift: boolean }

/** Differences that are the node's way of answering, not a rule the local EVM has wrong: listed, not counted. */
const EXPECTED: Record<number, Record<string, string>> = {
  42161: { 'opcode 0x5a': "GAS: Arbitrum's node takes its charge for L1 data out of the gas the call is given" },
  999: {
    'opcode 0x45': "GASLIMIT: HyperEVM's eth_call reports its large blocks' limit (30,000,000), whatever block it names; the local EVM the block's own",
    // Its node answers on its latest block whatever block is named, as the block after it but at its time: what
    // depends on the block can't be matched from outside.
    'opcode 0x42': "TIMESTAMP: HyperEVM's node answers on its latest block, not the one named",
    'opcode 0x43': "NUMBER: HyperEVM's node answers on its latest block, not the one named",
    'BLOCKHASH of the block before': "HyperEVM's node answers on its latest block, not the one named",
  },
};

async function check(chainId: number): Promise<Report> {
  const chain = new Chain(chainId), profile = CHAIN_PROFILES[chainId];
  const report: Report = { chainId, name: chainName(chainId), fork: [], nodeOnly: [], compared: 0, differences: [], expected: [], drift: false };
  const head = await chain.client.call(chainId, 'eth_getBlockByNumber', ['latest', false]) as { number: string; blockAccessListHash?: string };
  report.block = BigInt(head.number).toString();
  const amsterdam = head.blockAccessListHash !== undefined && (chainId === 1 || chainId === 11155111);

  // The node's own account of its rules.
  const config = await chain.client.call(chainId, 'eth_config', []).then(c => c as { next?: { activationTime?: number; forkId?: string; precompiles?: Record<string, string> } }, () => undefined);
  const rules = nodeRulesOf(config), day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
  if (!rules) report.fork.push('the node gives no account of its current fork (no eth_config, or none listed)');
  else {
    const same = profile?.checked && rules.forkId === profile.checked.forkId;
    report.fork.push(`fork id ${rules.forkId}${rules.activation ? `, active since ${day(rules.activation)}` : ''}: ${same ? `the one checked on ${profile!.checked!.on}` : profile?.checked ? `NOT the one checked on ${profile.checked.on} (${profile.checked.forkId})` : 'no fork recorded as checked for this chain'}`);
    if (profile?.checked && !same) report.drift = true;
    const common = createCustomCommon({ chainId }, Mainnet, { hardfork: (amsterdam ? 'amsterdam' : profile.hardfork) as never });
    const own = new Set([...getActivePrecompiles(common).keys()].map(k => `0x${k}`)), forwards = new Set((profile.forwardedPrecompiles ?? []).map(a => a.toLowerCase()));
    for (const [address, name] of rules.precompiles) if (!own.has(address) && !forwards.has(address)) report.nodeOnly.push(`${name} ${address}`);
    const next = config?.next;
    if (next?.forkId) {
      const now = new Set(rules.precompiles.keys()), added = Object.entries(next.precompiles ?? {}).filter(([, a]) => !now.has(`0x${a.slice(2).toLowerCase().padStart(40, '0')}`)).map(([n, a]) => `${n} ${a}`);
      report.fork.push(`a fork is scheduled${Number(next.activationTime) ? ` for ${day(Number(next.activationTime))}` : ''} (fork id ${next.forkId})${added.length ? `, adding ${added.join(', ')}` : ''}: the local EVM will need checking against it`);
    }
  }

  // Every opcode but the designated invalid one (0xfe, which each node names its own way), then the crafted programs
  // and the precompiles, sixteen to a block.
  const programs: Program[] = [
    ...Array.from({ length: 256 }, (_, op) => op).filter(op => op !== 0xfe).map(op => ({ label: `opcode 0x${hex2(op)}`, code: opcodeProgram(op) })),
    ...crafted(), ...await precompilePrograms(),
  ];
  const compareGas = !CHAIN_PROFILES[chainId]?.arbitrum;
  for (let i = 0; i < programs.length; i += 16) {
    // Arbitrum's node adds a charge for L1 data to every call's gas: the same for calls with the same calldata in
    // one block, but for the block's first call, which pays a few gas more. So there a call that isn't compared
    // goes first, and programs sent no calldata are compared less that charge: what most of the batch differs by.
    const batch = programs.slice(i, i + 16), results = compareGas ? await chain.both(batch) : (await chain.both([{ label: 'first', code: '0x00' }, ...batch])).slice(1);
    let l1Charge: bigint | undefined;
    if (!compareGas) {
      const deltas = results.flatMap(({ node, local }, j) => (!batch[j].data && node.kind === 'runs' && local.kind === 'runs' && node.gas !== undefined && local.gas !== undefined ? [node.gas - local.gas] : []));
      const counts = new Map<bigint, number>();
      for (const d of deltas) counts.set(d, (counts.get(d) ?? 0) + 1);
      const most = [...counts].sort((a, b) => b[1] - a[1])[0];
      if (most && most[1] * 2 > deltas.length) l1Charge = most[0];
      if (process.env.RULES_DEBUG) console.log(`  batch ${i / 16}: L1 charge ${l1Charge}, deltas ${[...counts].map(([d, n]) => `${d}×${n}`).join(' ')}`);
    }
    results.forEach(({ node, local }, j) => {
      if (node.kind === 'refused') { report.differences.push(`${batch[j].label}: not compared (${node.why})`); return; }
      report.compared++;
      const gas = node.gas !== undefined && local.gas !== undefined && (compareGas ? node.gas !== local.gas
        : l1Charge !== undefined && !batch[j].data && node.kind === 'runs' && local.kind === 'runs' && node.gas - local.gas !== l1Charge && !EXPECTED[chainId]?.[batch[j].label]);
      // Events are compared where the node reports them (not through eth_call).
      const logs = chain.simulateV1 && node.kind === 'runs' && local.kind === 'runs' && node.logs !== local.logs;
      // A precompile's caller returns four words. Where the precompile's call failed it burnt all the gas it was
      // given, which on Arbitrum follows from what the node charged before it: that word is left out there.
      const words = (o: Outcome) => (batch[j].precompile && o.kind === 'runs' && o.returns.length === 2 + 4 * 64 ? [0, 1, 2, 3].map(k => BigInt(`0x${o.returns.slice(2 + 64 * k, 66 + 64 * k)}`)) : undefined);
      const nodeWords = words(node), localWords = words(local);
      if (!compareGas && nodeWords && localWords && nodeWords[0] === 0n && localWords[0] === 0n) { node.returns = local.returns = `0x${[nodeWords[0], 0n, nodeWords[2], nodeWords[3]].map(w => w.toString(16).padStart(64, '0')).join('')}`; if (nodeWords[2] !== localWords[2] || nodeWords[3] !== localWords[3]) local.returns += '00'; }
      const said = (o: Outcome, w: bigint[] | undefined) => (w ? `, the precompile ${w[0] ? 'succeeds' : 'fails'} spending ${w[1]} gas and returning ${w[2]} bytes (hash ${w[3].toString(16).slice(0, 10)}…)` : `, returns ${o.returns.slice(0, 74)}`);
      const returns = node.kind === local.kind && node.kind !== 'invalid' && node.returns !== local.returns;
      if (node.kind !== local.kind || returns || gas || logs) {
        const known = EXPECTED[chainId]?.[batch[j].label];
        (known ? report.expected : report.differences).push(known ? `${batch[j].label}: ${known}` : `${batch[j].label}: the node ${node.kind}${node.kind === 'fails' && node.why ? ` (${node.why.slice(0, 60)})` : ''}${node.gas !== undefined ? `, ${node.gas} gas` : ''}${returns ? said(node, nodeWords) : ''}; the local EVM ${local.kind}${local.kind !== 'runs' && local.why ? ` (${local.why.slice(0, 80)})` : ''}${local.gas !== undefined ? `, ${local.gas} gas` : ''}${returns ? said(local, localWords) : ''}${logs ? '; their events differ' : ''}`);
      }
    });
  }
  return report;
}

const reports: Report[] = [];
for (const chainId of CHAINS_ASKED) {
  try { reports.push(await check(chainId)); } catch (e) { reports.push({ chainId, name: chainName(chainId), fork: [], nodeOnly: [], compared: 0, differences: [`the check did not run: ${(e as Error).message.slice(0, 200)}`], expected: [], drift: false }); }
  const r = reports.at(-1)!;
  console.log(`\n== ${r.name} (chain ${r.chainId})${r.block ? `, block ${r.block}` : ''}`);
  for (const line of r.fork) console.log(`  ${line}`);
  if (r.nodeOnly.length) console.log(`  precompiles the node has and the local EVM doesn't (refused in a local run): ${r.nodeOnly.join(', ')}`);
  console.log(`  ${r.compared} programs compared on the node and locally: ${r.differences.length ? `${r.differences.length} differ` : 'all the same'}`);
  for (const d of r.differences) console.log(`    ${d}`);
  for (const d of r.expected) console.log(`    (expected) ${d}`);
}
if (OUT) writeFileSync(OUT, JSON.stringify(reports, null, 2));
if (SUMMARY_MD) {
  const lines = ['### Rules check', '', '| Chain | Fork | Compared | Differ |', '|---|---|---|---|', ...reports.map(r => `| ${r.name} | ${r.drift ? '**changed**' : r.fork[0]?.includes('the one checked') ? 'as checked' : 'not known'} | ${r.compared} | ${r.differences.length} |`), ''];
  for (const r of reports) if (r.differences.length || r.drift || r.nodeOnly.length || r.fork.length > 1) lines.push(`**${r.name}**`, '', ...r.fork.map(f => `- ${f}`), ...(r.nodeOnly.length ? [`- Precompiles only the node has: ${r.nodeOnly.join(', ')}`] : []), ...r.differences.map(d => `- ${d}`), '');
  appendFileSync(SUMMARY_MD, `${lines.join('\n')}\n`);
}
const failing = reports.filter(r => r.drift || r.differences.length);
console.log(`\n${reports.length} chain${reports.length === 1 ? '' : 's'} checked; ${failing.length ? `${failing.map(r => r.name).join(', ')} need${failing.length === 1 ? 's' : ''} a look` : 'the local EVM runs each as its node does'}.`);
if (STRICT && failing.length) process.exit(1);
