// The block a simulation runs in. By default a node simulates on its latest block with a header of its own making
// (geth: twelve seconds on, no base fee, no fee recipient). A simulation that has to be the same in two places (the
// node's eth_simulateV1 and a local EVM that traces it), or that looks back at a past block, names the block instead:
// the block whose state it starts from, and the header of the block it runs in.
import type { Hex } from 'viem';
import type { RpcClient } from './rpc.ts';

/** The block to simulate on top of (a number in hex, or a tag) and the simulated block's header. */
export interface BlockAt {
  block: string;
  header: {
    number: bigint; timestamp: bigint; coinbase: string; gasLimit: bigint; baseFeePerGas: bigint;
    /** What opcode 0x44 returns (PREVRANDAO; on chains whose blocks still carry a difficulty, that). */
    prevRandao: Hex;
    /** The block's difficulty, where the chain's nodes take it apart from prevRandao (Polygon). */
    difficulty?: bigint;
    /** Arbitrum: the chain's own block number (`number` is then the L1 block the chain last saw, which NUMBER returns). */
    arbBlockNumber?: bigint;
  };
}

/**
 * How each chain's next block follows from its latest: the seconds between blocks, in whole seconds (chains that
 * make several blocks a second get the next second, BNB Chain, or the same one, Arbitrum); what opcode 0x44
 * returns, the block's mixHash unless said (its difficulty on BNB Chain and Polygon, 1 on Arbitrum); and Arbitrum's
 * two block numbers.
 */
export const NEXT_BLOCK: Record<number, { blockTime: number; randomness?: 'difficulty' | 'one'; arbitrum?: boolean; /** The chain's nodes take the difficulty as an override of its own (Polygon); BNB Chain's read it from prevRandao. */ difficultyOverride?: boolean }> = {
  1: { blockTime: 12 }, 11155111: { blockTime: 12 },
  42161: { blockTime: 0, randomness: 'one', arbitrum: true }, 421614: { blockTime: 0, randomness: 'one', arbitrum: true },
  8453: { blockTime: 2 }, 10: { blockTime: 2 },
  137: { blockTime: 2, randomness: 'difficulty', difficultyOverride: true },
  56: { blockTime: 1, randomness: 'difficulty' },
  999: { blockTime: 1 }, 998: { blockTime: 1 },
};

/** A block header as eth_getBlockByNumber returns it (the fields used here). */
export interface RpcHeader { number: string; timestamp: string; miner: string; mixHash?: string; gasLimit: string; baseFeePerGas?: string; difficulty?: string; l1BlockNumber?: string }

const word = (v: bigint) => `0x${v.toString(16).padStart(64, '0')}` as Hex;

/** The header of the block after `h`: the next number and time, the same fee recipient, base fee and gas limit, and the chain's own answer to opcode 0x44. */
export function headerAfter(chainId: number, h: RpcHeader): BlockAt['header'] {
  const rules = NEXT_BLOCK[chainId] ?? { blockTime: 12 };
  const difficulty = BigInt(h.difficulty ?? '0x0');
  return {
    // On Arbitrum NUMBER is the L1 block the chain last saw, which the next block all but always shares.
    number: rules.arbitrum && h.l1BlockNumber ? BigInt(h.l1BlockNumber) : BigInt(h.number) + 1n,
    ...(rules.arbitrum && { arbBlockNumber: BigInt(h.number) + 1n }),
    timestamp: BigInt(h.timestamp) + BigInt(rules.blockTime),
    coinbase: h.miner.toLowerCase(), gasLimit: BigInt(h.gasLimit), baseFeePerGas: h.baseFeePerGas ? BigInt(h.baseFeePerGas) : 0n,
    prevRandao: rules.randomness === 'one' ? word(1n) : rules.randomness === 'difficulty' ? word(difficulty) : (h.mixHash ?? word(0n)) as Hex,
    ...(rules.difficultyOverride && { difficulty }),
  };
}

/**
 * The header of a block as it was, for running a call in that very block (a replay): `h` is the block, simulated on
 * top of its parent.
 */
export function headerOf(chainId: number, h: RpcHeader): BlockAt['header'] {
  const rules = NEXT_BLOCK[chainId] ?? { blockTime: 12 };
  const difficulty = BigInt(h.difficulty ?? '0x0');
  return {
    number: rules.arbitrum && h.l1BlockNumber ? BigInt(h.l1BlockNumber) : BigInt(h.number),
    ...(rules.arbitrum && { arbBlockNumber: BigInt(h.number) }),
    timestamp: BigInt(h.timestamp), coinbase: h.miner.toLowerCase(), gasLimit: BigInt(h.gasLimit), baseFeePerGas: h.baseFeePerGas ? BigInt(h.baseFeePerGas) : 0n,
    prevRandao: rules.randomness === 'one' ? word(1n) : rules.randomness === 'difficulty' ? word(difficulty) : (h.mixHash ?? word(0n)) as Hex,
    ...(rules.difficultyOverride && { difficulty }),
  };
}

/** The chain's latest block by number, and the block after it to simulate in. Undefined when it can't be read. */
export async function pinLatest(rpc: RpcClient | undefined, chainId: number): Promise<BlockAt | undefined> {
  if (!rpc?.has(chainId)) return undefined;
  try {
    const h = await rpc.call(chainId, 'eth_getBlockByNumber', ['latest', false]) as RpcHeader | null;
    return h?.number ? { block: h.number, header: headerAfter(chainId, h) } : undefined;
  } catch { return undefined; }
}

/**
 * eth_simulateV1's blockOverrides for this header. The number is left to the node (the block after the one it starts
 * from; on Arbitrum the node maps it to the L1 block itself), and the gas limit too: public nodes refuse a simulated
 * block above their own cap. BNB Chain's node takes opcode 0x44 from prevRandao; Polygon's takes a difficulty.
 */
export function nodeOverrides(h: BlockAt['header']): Record<string, string> {
  return {
    time: `0x${h.timestamp.toString(16)}`, feeRecipient: h.coinbase, prevRandao: h.prevRandao, baseFeePerGas: `0x${h.baseFeePerGas.toString(16)}`,
    ...(h.difficulty !== undefined && { difficulty: `0x${h.difficulty.toString(16)}` }),
  };
}
