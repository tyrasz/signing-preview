// A small chain for simulator tests: an in-process EVM (@ethereumjs/evm) holding the contracts of
// test/fixtures/SimulationMocks.sol, behind a fake JSON-RPC node shaped like HyperEVM's: state reads, eth_call with
// state overrides, batches of at most 20, no eth_simulateV1. It also has a chain-specific precompile at 0x…0800.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createEVM, type EVM } from '@ethereumjs/evm';
import { createCustomCommon, Mainnet } from '@ethereumjs/common';
import { Account, bytesToHex, createAddressFromString, hexToBytes, setLengthLeft, unpadBytes } from '@ethereumjs/util';
import { encodeAbiParameters, keccak256, type Hex } from 'viem';

const solc = createRequire(import.meta.url)('solc');
const fixture = (path: string) => ({ content: readFileSync(new URL(`./fixtures/${path}`, import.meta.url), 'utf8') });
// ZeroDev's WebAuthn verification, which KernelPasskey uses (see fixtures/zerodev-webauthn/README.md).
const zerodev = { 'zerodev/WebAuthn.sol': fixture('zerodev-webauthn/WebAuthn.sol'), 'zerodev/P256.sol': fixture('zerodev-webauthn/P256.sol'), 'zerodev/Base64URL.sol': fixture('zerodev-webauthn/Base64URL.sol'),
  'openzeppelin-contracts/contracts/utils/Base64.sol': fixture('zerodev-webauthn/openzeppelin-contracts/contracts/utils/Base64.sol') };
const out = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { 'M.sol': fixture('SimulationMocks.sol') },
  settings: { evmVersion: 'paris', optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['evm.bytecode.object', 'evm.deployedBytecode.object'] } } } })));
for (const e of out.errors ?? []) if (e.severity === 'error') throw new Error(e.formattedMessage);
const passkey = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { 'K.sol': fixture('KernelPasskey.sol'), ...zerodev },
  settings: { evmVersion: 'paris', viaIR: true, optimizer: { enabled: true, runs: 200 }, outputSelection: { 'K.sol': { '*': ['evm.bytecode.object', 'evm.deployedBytecode.object'] } } } })));
for (const e of passkey.errors ?? []) if (e.severity === 'error') throw new Error(e.formattedMessage);
export const compiled = (name: string) => (out.contracts['M.sol'][name] ?? passkey.contracts['K.sol'][name]) as { evm: { bytecode: { object: string }; deployedBytecode: { object: string } } };

export const PRECOMPILE = '0x0000000000000000000000000000000000000800';
const DEPLOYER = '0xde9100000000000000000000000000000000d001';
const at = (a: string) => createAddressFromString(a);
const json = (body: unknown) => new Response(JSON.stringify(body));

export interface TestChain {
  evm: EVM;
  deploy(name: string, types?: string, args?: unknown[]): Promise<string>;
  exec(to: string, data: Hex, from?: string, value?: bigint): Promise<void>;
  setBalance(a: string, balance: bigint): Promise<void>;
  putCode(a: string, code: Hex): Promise<void>;
  /** The fake node. `delayMs` slows every HTTP request (for time-budget tests). */
  fetchImpl: typeof fetch;
  delayMs: number;
  /** HTTP requests and JSON-RPC calls served, by method. */
  stats: { http: number; calls: Record<string, number> };
  /**
   * Answer eth_simulateV1 too (off by default: the chain stands for one without it): blocks of calls run in order
   * on the chain's state, each block's code overrides applied before its calls, nothing kept afterwards.
   * Asked with traceTransfers, each call's logs end with a node's pseudo-logs of the native coin it moved: one
   * Transfer from 0xeeee…eeee per call frame that sent value and didn't fail.
   */
  simulateV1?: boolean;
  /** The chain's answer to eth_config (EIP-7910), when it has one. */
  config?: unknown;
}

export async function testChain(): Promise<TestChain> {
  // The chain's own precompile: returns x * 2 + 7 for an ABI-encoded uint32 x.
  // Chain 999, as the previews are told: eth_call and the fork simulator then agree on chainid (an operation's hash).
  const evm = await createEVM({ common: createCustomCommon({ chainId: 999 }, Mainnet), customPrecompiles: [{ address: PRECOMPILE, function: input => ({ executionGasUsed: 100n, returnValue: hexToBytes(encodeAbiParameters([{ type: 'uint256' }], [BigInt(bytesToHex(input.data)) * 2n + 7n])) }) }] });
  const sm = evm.stateManager;
  const setBalance = async (a: string, balance: bigint) => {
    const acct = (await sm.getAccount(at(a))) ?? new Account();
    acct.balance = balance;
    await sm.putAccount(at(a), acct);
  };
  const chain: TestChain = {
    evm, delayMs: 0, stats: { http: 0, calls: {} },
    setBalance,
    putCode: async (a, code) => { await sm.putCode(at(a), hexToBytes(code)); },
    async deploy(name, types = '', args = []) {
      const ctor = types ? encodeAbiParameters(types.split(',').map(type => ({ type })), args).slice(2) : '';
      const res = await evm.runCall({ caller: at(DEPLOYER), origin: at(DEPLOYER), data: hexToBytes(`0x${compiled(name).evm.bytecode.object}${ctor}`), gasLimit: 10_000_000n });
      if (res.execResult.exceptionError || !res.createdAddress) throw new Error(`deploy ${name}: ${res.execResult.exceptionError?.error}`);
      return res.createdAddress.toString().toLowerCase();
    },
    async exec(to, data, from = DEPLOYER, value = 0n) {
      const res = await evm.runCall({ caller: at(from), origin: at(from), to: at(to), data: hexToBytes(data), value, gasLimit: 10_000_000n });
      if (res.execResult.exceptionError) throw new Error(`setup call failed: ${res.execResult.exceptionError.error}`);
    },
    fetchImpl: undefined as unknown as typeof fetch,
  };
  // The block calls run in: ethereumjs's default one, at the chain's base fee (0, as eth_getBlockByNumber has it). With
  // none, a call reading BASEFEE (an EntryPoint pricing an operation's gas) throws out of the EVM midway, which leaves
  // what it had written in the chain's state.
  const block = () => ({ header: { number: 0n, coinbase: at('0x0000000000000000000000000000000000000000'), timestamp: 0n, difficulty: 0n, prevRandao: new Uint8Array(32), gasLimit: 0n, baseFeePerGas: 0n, slotNumber: 0n, getBlobGasPrice: () => undefined } }) as never;
  const answer = async (method: string, params: unknown[]): Promise<{ result?: unknown; error?: { code: number; message: string; data?: string } }> => {
    chain.stats.calls[method] = (chain.stats.calls[method] ?? 0) + 1;
    const p = params as string[];
    switch (method) {
      case 'eth_getBalance': return { result: `0x${((await sm.getAccount(at(p[0])))?.balance ?? 0n).toString(16)}` };
      case 'eth_getTransactionCount': return { result: `0x${((await sm.getAccount(at(p[0])))?.nonce ?? 0n).toString(16)}` };
      case 'eth_getCode': return { result: bytesToHex(await sm.getCode(at(p[0]))) };
      case 'eth_getStorageAt': return { result: bytesToHex(setLengthLeft(await sm.getStorage(at(p[0]), setLengthLeft(hexToBytes(p[1] as Hex), 32)), 32)) };
      case 'eth_getBlockByNumber': {
        // The chain is at block 16; each block's hash is keccak256 of its number (a 32-byte word).
        const n = p[0] === 'latest' ? 16n : BigInt(p[0]);
        if (n > 16n) return { result: null };
        return { result: { number: `0x${n.toString(16)}`, hash: keccak256(encodeAbiParameters([{ type: 'uint256' }], [n])), timestamp: '0x65000000', miner: '0x0000000000000000000000000000000000000000', mixHash: `0x${'00'.repeat(32)}`, gasLimit: '0x1c9c380', baseFeePerGas: '0x0' } };
      }
      case 'eth_call': {
        const [tx, , overrides] = params as [{ from?: string; to: string; data: string; value?: string; gas?: string }, string, Record<string, { code?: Hex; balance?: Hex; stateDiff?: Record<string, Hex> }> | undefined];
        await sm.checkpoint();
        try {
          for (const [a, o] of Object.entries(overrides ?? {})) {
            if (o.balance) await setBalance(a, BigInt(o.balance));
            if (o.code) await sm.putCode(at(a), hexToBytes(o.code));
            for (const [slot, v] of Object.entries(o.stateDiff ?? {})) await sm.putStorage(at(a), setLengthLeft(hexToBytes(slot as Hex), 32), unpadBytes(hexToBytes(v)));
          }
          const from = tx.from ?? '0x0000000000000000000000000000000000000000', value = BigInt(tx.value ?? 0);
          const balance = (await sm.getAccount(at(from)))?.balance ?? 0n;
          if (value > balance) return { error: { code: -32000, message: `insufficient funds for gas * price + value: have ${balance} want ${value}` } };
          const res = await evm.runCall({ caller: at(from), origin: at(from), to: at(tx.to), data: hexToBytes(tx.data as Hex), value, gasLimit: BigInt(tx.gas ?? 30_000_000), block: block() });
          const ret = bytesToHex(res.execResult.returnValue);
          return res.execResult.exceptionError ? { error: { code: 3, message: 'execution reverted', data: ret } } : { result: ret };
        } finally {
          await sm.revert();
        }
      }
      case 'eth_config': return chain.config === undefined ? { error: { code: -32601, message: 'Method not found' } } : { result: chain.config };
      case 'eth_simulateV1': {
        if (!chain.simulateV1) return { error: { code: -32601, message: 'Method not found' } };
        const [{ blockStateCalls, traceTransfers }] = params as [{ blockStateCalls: { calls?: { from?: string; to?: string; data?: Hex; value?: string; gas?: string }[]; stateOverrides?: Record<string, { code?: Hex }> }[]; traceTransfers?: boolean }];
        // traceTransfers: the native coin each frame sent, kept with its parent's once the frame returns (a frame that
        // fails takes its own and its callees' with it), as a node drops a failed frame's logs.
        type Moved = { from: string; to: string; value: bigint };
        const frames: Moved[][] = [], sent: Moved[] = [];
        const entered = (m: { caller: { toString(): string }; to?: { toString(): string }; value: bigint; delegatecall: boolean }, next?: () => void) => {
          frames.push(m.value > 0n && !m.delegatecall ? [{ from: m.caller.toString(), to: m.to?.toString() ?? '', value: m.value }] : []);
          next?.();
        };
        const left = (r: { createdAddress?: { toString(): string }; execResult: { exceptionError?: unknown } }, next?: () => void) => {
          const own = frames.pop() ?? [];
          if (!r.execResult.exceptionError) { if (own[0] && !own[0].to && r.createdAddress) own[0].to = r.createdAddress.toString(); (frames.at(-1) ?? sent).push(...own); }
          next?.();
        };
        const word = (v: bigint | string) => `0x${(typeof v === 'string' ? v.slice(2) : v.toString(16)).padStart(64, '0')}` as Hex;
        if (traceTransfers) { evm.events!.on('beforeMessage', entered); evm.events!.on('afterMessage', left); }
        await sm.checkpoint();
        try {
          const blocks = [];
          for (const b of blockStateCalls) {
            // A contract behind a marker (code 0xef: one the node runs itself, as Base's B20 tokens) keeps running as
            // itself whatever code an override puts there, as on Base.
            for (const [a, o] of Object.entries(b.stateOverrides ?? {})) if (o.code) { const now = await sm.getCode(at(a)); if (!(now.length === 1 && now[0] === 0xef)) await sm.putCode(at(a), hexToBytes(o.code)); }
            const calls = [];
            for (const c of b.calls ?? []) {
              const from = c.from ?? '0x0000000000000000000000000000000000000000';
              sent.length = 0;
              // Each call is a transaction of its own: nothing warm from the calls before it (EIP-2929), and storage's
              // "original" values taken afresh (EIP-2200), so a call costs the same gas wherever it runs in a block.
              await evm.journal.cleanup();
              (sm as { originalStorageCache?: { clear(): void } }).originalStorageCache?.clear();
              const res = await evm.runCall({ caller: at(from), origin: at(from), ...(c.to && { to: at(c.to) }), data: hexToBytes(c.data ?? '0x'), value: BigInt(c.value ?? 0), gasLimit: BigInt(c.gas ?? 30_000_000), block: block() });
              const logs = (res.execResult.logs ?? []).map(([address, topics, data]) => ({ address: bytesToHex(address), topics: topics.map(t => bytesToHex(t)), data: bytesToHex(data) }));
              if (traceTransfers && !res.execResult.exceptionError) for (const t of sent) logs.push({ address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', word(t.from), word(t.to)], data: word(t.value) });
              calls.push({ status: res.execResult.exceptionError ? '0x0' : '0x1', returnData: bytesToHex(res.execResult.returnValue), gasUsed: `0x${res.execResult.executionGasUsed.toString(16)}`, logs });
            }
            blocks.push({ calls });
          }
          return { result: blocks };
        } finally {
          if (traceTransfers) { evm.events!.removeListener('beforeMessage', entered); evm.events!.removeListener('afterMessage', left); }
          await sm.revert();
        }
      }
      default: return { error: { code: -32601, message: 'Method not found' } };
    }
  };
  chain.fetchImpl = (async (_url: string, init: RequestInit) => {
    chain.stats.http++;
    if (chain.delayMs) await new Promise(r => setTimeout(r, chain.delayMs));
    const body = JSON.parse(String(init.body));
    if (!Array.isArray(body)) return json({ jsonrpc: '2.0', id: body.id, ...(await answer(body.method, body.params)) });
    if (body.length > 20) return json({ jsonrpc: '2.0', id: null, error: { code: -32010, message: 'The batch request was too large' } });
    const out = [];
    for (const r of body) out.push({ jsonrpc: '2.0', id: r.id, ...(await answer(r.method, r.params)) });
    return json(out);
  }) as typeof fetch;
  return chain;
}
