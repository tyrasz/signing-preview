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
          const res = await evm.runCall({ caller: at(from), origin: at(from), to: at(tx.to), data: hexToBytes(tx.data as Hex), value, gasLimit: BigInt(tx.gas ?? 30_000_000) });
          const ret = bytesToHex(res.execResult.returnValue);
          return res.execResult.exceptionError ? { error: { code: 3, message: 'execution reverted', data: ret } } : { result: ret };
        } finally {
          await sm.revert();
        }
      }
      case 'eth_config': return chain.config === undefined ? { error: { code: -32601, message: 'Method not found' } } : { result: chain.config };
      case 'eth_simulateV1': {
        if (!chain.simulateV1) return { error: { code: -32601, message: 'Method not found' } };
        const [{ blockStateCalls }] = params as [{ blockStateCalls: { calls?: { from?: string; to?: string; data?: Hex; value?: string; gas?: string }[]; stateOverrides?: Record<string, { code?: Hex }> }[] }];
        await sm.checkpoint();
        try {
          const blocks = [];
          for (const b of blockStateCalls) {
            for (const [a, o] of Object.entries(b.stateOverrides ?? {})) if (o.code) await sm.putCode(at(a), hexToBytes(o.code));
            const calls = [];
            for (const c of b.calls ?? []) {
              const from = c.from ?? '0x0000000000000000000000000000000000000000';
              const res = await evm.runCall({ caller: at(from), origin: at(from), ...(c.to && { to: at(c.to) }), data: hexToBytes(c.data ?? '0x'), value: BigInt(c.value ?? 0), gasLimit: BigInt(c.gas ?? 30_000_000) });
              calls.push({ status: res.execResult.exceptionError ? '0x0' : '0x1', returnData: bytesToHex(res.execResult.returnValue), gasUsed: `0x${res.execResult.executionGasUsed.toString(16)}`, logs: [] });
            }
            blocks.push({ calls });
          }
          return { result: blocks };
        } finally {
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
