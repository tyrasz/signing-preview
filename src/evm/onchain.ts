// Read-only contract calls for decoders that need live protocol state (exchange rates, positions, delays).
import { decodeFunctionResult, encodeFunctionData, parseAbi, type Abi } from 'viem';
import type { AdapterEnv } from './common.ts';
import { TtlCache } from '../rpc.ts';

const cache = new Map<string, Abi>();
const abiOf = (signature: string) => { let a = cache.get(signature); if (!a) { a = parseAbi([signature]) as Abi; cache.set(signature, a); } return a; };

// Results are kept for 15 s: a preview reads the same values several times, and public RPCs rate-limit.
const resultsByRpc = new WeakMap<object, TtlCache<Promise<`0x${string}`>>>();

/**
 * eth_call `signature` (e.g. "function HYPEToKHYPE(uint256) view returns (uint256)") on `address`.
 * Resolves undefined when no RPC is configured for the chain or the call fails, so decoders degrade to a static
 * decode instead of failing.
 */
export async function read<T = unknown>(env: AdapterEnv, chainId: number, address: string, signature: string, args: readonly unknown[] = []): Promise<T | undefined> {
  const rpc = env.deps.rpc;
  if (!rpc?.has(chainId)) return undefined;
  try {
    const abi = abiOf(signature);
    const name = (abi[0] as { name: string }).name;
    const data = encodeFunctionData({ abi, functionName: name, args } as never);
    let cache = resultsByRpc.get(rpc);
    if (!cache) { cache = new TtlCache({ max: 2000 }); resultsByRpc.set(rpc, cache); }
    const key = `${chainId}:${address.toLowerCase()}:${data}`;
    let pending = cache.get(key);
    if (!pending) {
      pending = rpc.call(chainId, 'eth_call', [{ to: address, data }, 'latest']).then(r => String(r) as `0x${string}`);
      const expire = cache.set(key, pending, 15_000);
      pending.catch(() => expire(0)); // failures are not kept
    }
    const result = await pending;
    return decodeFunctionResult({ abi, functionName: name, data: result } as never) as T;
  } catch {
    return undefined;
  }
}
