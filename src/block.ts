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
    /** The block's blob base fee (BLOBBASEFEE), on chains with blobs: a rollup's batch poster reads it. */
    blobBaseFee?: bigint;
    /**
     * The block is one of Amsterdam's (Glamsterdam): the header it follows carries a block access list hash
     * (EIP-7928), which headers have from that fork on. The local EVM then runs Amsterdam's rules.
     */
    amsterdam?: boolean;
    /**
     * The beacon slot the block is in (SLOTNUM, EIP-7843), from Amsterdam on. A block simulated after another is
     * taken to be in the next slot, as the chain's node takes it whatever time it is given.
     */
    slotNumber?: bigint;
  };
  /**
   * The block was asked for (a past block, a replay), not named only so that two runs match: a node that can't serve
   * it is an error, never a reason to simulate on the latest block instead.
   */
  required?: boolean;
  /**
   * Calls that run first in the simulated block, in order, whose results aren't reported: the transactions before
   * a replayed one in its block. (The calls of a request's own batch are all reported.)
   */
  before?: import('./types.ts').SimulationRequest[];
  /**
   * What the simulated block has already changed when the calls run, as differences from `block`'s state: a replayed
   * transaction's block as its earlier transactions left it, read from the block's access list (stateBefore) in
   * place of running them (`before`). Simulators start from it; a request's own state overrides go on top.
   */
  state?: StateChanges;
}

/**
 * State as differences from a block's, in the form eth_simulateV1's state overrides take: balances and nonces in
 * hex, storage as 32-byte slots and values.
 */
export type StateChanges = Record<string, { balance?: string; nonce?: string; code?: string; stateDiff?: Record<string, string> }>;

/**
 * The state a transaction met in its block, as differences from the parent block's, from the block's access list
 * (EIP-7928, from Amsterdam on): every balance, nonce, code and storage slot the block changed, each with the entry
 * that changed it. Entry 0 is what the block does before its transactions (the beacon root and the parent's hash
 * written to their contracts), entry i + 1 is transaction i. So what transaction `index` met is each item's last
 * change among entries 0 to `index`.
 *
 * Undefined where the node doesn't serve the list (eth_getBlockAccessListByBlockNumber: measured on Sepolia's
 * public RPC, where some of the backends behind it lack it, hence the second and third try), or serves something
 * that doesn't read as one: the caller then runs the earlier transactions instead.
 */
export async function stateBefore(client: RpcClient, chainId: number, block: string, index: number): Promise<StateChanges | undefined> {
  let list: unknown;
  for (let attempt = 0; attempt < 3 && !Array.isArray(list); attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, 200 * attempt));
    list = await client.call(chainId, 'eth_getBlockAccessListByBlockNumber', [block]).catch(() => undefined);
  }
  if (!Array.isArray(list)) return undefined;
  const hex = (v: unknown): string => { if (typeof v !== 'string' || !/^0x[0-9a-fA-F]*$/.test(v)) throw new Error('not hex'); return v; };
  const word = (v: unknown) => `0x${BigInt(hex(v) === '0x' ? '0x0' : hex(v)).toString(16).padStart(64, '0')}`;
  /** An item's last change at or before the transaction: `field` of it. */
  const last = (changes: unknown, field: 'value' | 'code'): string | undefined => {
    if (!Array.isArray(changes)) throw new Error('not a list');
    let found: string | undefined, at = -1;
    for (const c of changes as Record<string, unknown>[]) {
      const i = Number(BigInt(hex(c.index)));
      if (i <= index && i >= at) { found = hex(c[field]); at = i; }
    }
    return found;
  };
  try {
    const out: StateChanges = {};
    for (const a of list as Record<string, unknown>[]) {
      const entry: StateChanges[string] = {};
      const balance = last(a.balanceChanges, 'value'), nonce = last(a.nonceChanges, 'value'), code = last(a.codeChanges, 'code');
      if (balance !== undefined) entry.balance = `0x${BigInt(balance === '0x' ? '0x0' : balance).toString(16)}`;
      if (nonce !== undefined) entry.nonce = `0x${BigInt(nonce === '0x' ? '0x0' : nonce).toString(16)}`;
      if (code !== undefined) entry.code = code.toLowerCase();
      if (!Array.isArray(a.storageChanges)) throw new Error('not a list');
      for (const s of a.storageChanges as Record<string, unknown>[]) {
        const value = last(s.changes, 'value');
        if (value !== undefined) (entry.stateDiff ??= {})[word(s.key)] = word(value);
      }
      if (Object.keys(entry).length) out[hex(a.address).toLowerCase()] = entry;
    }
    return out;
  } catch { return undefined; }
}

/**
 * How each chain's next block follows from its latest: the seconds between blocks, in whole seconds (chains that
 * make several blocks a second get the next second, BNB Chain, or the same one, Arbitrum); what opcode 0x44
 * returns, the block's mixHash unless said (its difficulty on BNB Chain and Polygon, 1 on Arbitrum); and Arbitrum's
 * two block numbers.
 */
export const NEXT_BLOCK: Record<number, { blockTime: number; /** What COINBASE returns where it isn't the header's miner: Polygon's blocks name none, and every one pays its fees to one address (measured on its node; an override of the fee recipient is ignored). */ coinbase?: string; /** The chain carries blobs (EIP-4844), so its blocks have a blob base fee. */ blobs?: boolean; randomness?: 'difficulty' | 'one'; arbitrum?: boolean; /** The chain's nodes take the difficulty as an override of its own (Polygon); BNB Chain's read it from prevRandao. */ difficultyOverride?: boolean }> = {
  1: { blockTime: 12, blobs: true }, 11155111: { blockTime: 12, blobs: true },
  42161: { blockTime: 0, randomness: 'one', arbitrum: true }, 421614: { blockTime: 0, randomness: 'one', arbitrum: true },
  8453: { blockTime: 2 }, 10: { blockTime: 2 },
  137: { blockTime: 2, randomness: 'difficulty', difficultyOverride: true, coinbase: '0x7ee41d8a25641000661b1ef5e6ae8a00400466b0' },
  56: { blockTime: 1, randomness: 'difficulty' },
  999: { blockTime: 1 }, 998: { blockTime: 1 },
};

/** A block header as eth_getBlockByNumber returns it (the fields used here). */
export interface RpcHeader { number: string; timestamp: string; miner: string; mixHash?: string; gasLimit: string; baseFeePerGas?: string; difficulty?: string; l1BlockNumber?: string; /** EIP-7928: present from Amsterdam (Glamsterdam) on. */ blockAccessListHash?: string; /** EIP-7843: the beacon slot, from Amsterdam on. */ slotNumber?: string }

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
    coinbase: rules.coinbase ?? h.miner.toLowerCase(), gasLimit: BigInt(h.gasLimit), baseFeePerGas: h.baseFeePerGas ? BigInt(h.baseFeePerGas) : 0n,
    prevRandao: rules.randomness === 'one' ? word(1n) : rules.randomness === 'difficulty' ? word(difficulty) : (h.mixHash ?? word(0n)) as Hex,
    ...(rules.difficultyOverride && { difficulty }),
    ...(h.blockAccessListHash !== undefined && { amsterdam: true }),
    ...(h.slotNumber !== undefined && { slotNumber: BigInt(h.slotNumber) + 1n }),
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
    timestamp: BigInt(h.timestamp), coinbase: rules.coinbase ?? h.miner.toLowerCase(), gasLimit: BigInt(h.gasLimit), baseFeePerGas: h.baseFeePerGas ? BigInt(h.baseFeePerGas) : 0n,
    prevRandao: rules.randomness === 'one' ? word(1n) : rules.randomness === 'difficulty' ? word(difficulty) : (h.mixHash ?? word(0n)) as Hex,
    ...(rules.difficultyOverride && { difficulty }),
    ...(h.blockAccessListHash !== undefined && { amsterdam: true }),
    ...(h.slotNumber !== undefined && { slotNumber: BigInt(h.slotNumber) }),
  };
}

/**
 * The blob base fee of the block after `block` (a number in hex), on chains with blobs: eth_feeHistory gives it,
 * whatever the fork's formula. Undefined elsewhere, or when the node doesn't say.
 */
export async function blobBaseFeeAfter(rpc: RpcClient, chainId: number, block: string): Promise<bigint | undefined> {
  if (!NEXT_BLOCK[chainId]?.blobs) return undefined;
  try {
    const fees = await rpc.call(chainId, 'eth_feeHistory', ['0x1', block, []]) as { baseFeePerBlobGas?: string[] } | null;
    const next = fees?.baseFeePerBlobGas?.[1];
    return typeof next === 'string' && /^0x[0-9a-f]+$/i.test(next) ? BigInt(next) : undefined;
  } catch { return undefined; }
}

/** The chain's latest block by number, and the block after it to simulate in. Undefined when it can't be read. */
export async function pinLatest(rpc: RpcClient | undefined, chainId: number): Promise<BlockAt | undefined> {
  if (!rpc?.has(chainId)) return undefined;
  try {
    const h = await rpc.call(chainId, 'eth_getBlockByNumber', ['latest', false]) as RpcHeader | null;
    if (!h?.number) return undefined;
    const blobBaseFee = await blobBaseFeeAfter(rpc, chainId, h.number);
    return { block: h.number, header: { ...headerAfter(chainId, h), ...(blobBaseFee !== undefined && { blobBaseFee }) } };
  } catch { return undefined; }
}

/**
 * A past block to simulate on: the state after block `number`, in the block that followed it (its real header), or
 * for the chain's latest block the one that would. Throws when the chain can't be read or has no such block yet.
 * `time` is when the state's block was made, in seconds.
 */
export async function pinBlock(rpc: RpcClient | undefined, chainId: number, number: bigint): Promise<{ at: BlockAt; time: number; shifted?: boolean }> {
  if (!rpc?.has(chainId)) throw new Error('No RPC is configured for this chain, so a past block can\'t be read.');
  const tag = (n: bigint) => `0x${n.toString(16)}`;
  const [h, next, blobBaseFee] = await Promise.all([...[number, number + 1n].map(n => rpc.call(chainId, 'eth_getBlockByNumber', [tag(n), false]).then(r => r as RpcHeader | null, () => null)), blobBaseFeeAfter(rpc, chainId, tag(number))]) as [RpcHeader | null, RpcHeader | null, bigint | undefined];
  if (!h?.number) throw new Error(`Block ${number.toLocaleString('en-US')} isn't on this chain (yet), or its node doesn't serve it.`);
  const { header, shifted } = afterParent(chainId, next?.number ? headerOf(chainId, next) : headerAfter(chainId, h), BigInt(h.timestamp));
  return { at: { block: tag(number), header: { ...header, ...(blobBaseFee !== undefined && { blobBaseFee }) }, required: true }, time: Number(BigInt(h.timestamp)), ...(shifted && { shifted }) };
}

/**
 * A block's header given a time its chain's node will simulate: nodes refuse a simulated block that isn't later
 * than the one it follows, and BNB Chain's blocks, several a second, often share their second with their parent.
 * Such a block runs one second later than it did (`shifted`), in both simulators alike. Arbitrum's node takes the
 * same second.
 */
export function afterParent(chainId: number, header: BlockAt['header'], parentTime: bigint): { header: BlockAt['header']; shifted: boolean } {
  const earliest = parentTime + ((NEXT_BLOCK[chainId] ?? { blockTime: 12 }).blockTime > 0 ? 1n : 0n);
  return header.timestamp >= earliest ? { header, shifted: false } : { header: { ...header, timestamp: earliest }, shifted: true };
}

/** A block number as PreviewContext.block gives it: a number, or one in decimal or hex. Throws when it is neither. */
export function parseBlock(v: unknown): bigint {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === 'string' && /^(0x[0-9a-fA-F]+|[0-9]+)$/.test(v)) return BigInt(v);
  throw new Error('"block" must be a block number');
}

/** A past block named for a preview, as read from the chain. */
export interface Pinned { at: BlockAt; number: bigint; time: number; /** The block that followed shares its second with this one, and runs a second later (afterParent). */ shifted?: boolean }

/**
 * The block a preview's context names (PreviewContext.block), read once per preview and chain: `context.pinned`
 * keeps the read for the preview's other simulations and for prices as of that block. Undefined when none is named.
 */
export function namedBlock(context: { block?: number | string; pinned?: Map<number, Promise<Pinned>> }, rpc: RpcClient | undefined, chainId: number): Promise<Pinned> | undefined {
  if (context.block === undefined) return undefined;
  let pinned = context.pinned?.get(chainId);
  if (!pinned) {
    const number = parseBlock(context.block);
    pinned = pinBlock(rpc, chainId, number).then(r => ({ ...r, number }));
    pinned.catch(() => { /* whoever awaits it reports it */ });
    context.pinned?.set(chainId, pinned);
  }
  return pinned;
}

/** "block 23,456,789 (2026-11-10 08:12:35 UTC)". */
export function blockText(number: bigint, time: number): string {
  return `block ${number.toLocaleString('en-US')} (${new Date(time * 1000).toISOString().slice(0, 19).replace('T', ' ')} UTC)`;
}

/**
 * A request's price as eth_simulateV1 call fields: its gas price, or for a blob transaction (whose blob hashes nodes
 * take only with EIP-1559 fees and a blob fee cap) that price as both fee cap and tip, which comes to the same.
 */
export function priceFields(req: { gasPrice?: bigint; blobVersionedHashes?: string[]; maxFeePerBlobGas?: bigint }): Record<string, unknown> {
  const hex = (v: bigint) => `0x${v.toString(16)}`;
  if (!req.blobVersionedHashes?.length) return req.gasPrice !== undefined ? { gasPrice: hex(req.gasPrice) } : {};
  return { blobVersionedHashes: req.blobVersionedHashes, maxFeePerBlobGas: hex(req.maxFeePerBlobGas ?? 1n), ...(req.gasPrice !== undefined && { maxFeePerGas: hex(req.gasPrice), maxPriorityFeePerGas: hex(req.gasPrice) }) };
}

/**
 * eth_simulateV1's blockOverrides for this header. The number is left to the node (the block after the one it starts
 * from; on Arbitrum the node maps it to the L1 block itself), and the gas limit too: public nodes refuse a simulated
 * block above their own cap. BNB Chain's node takes opcode 0x44 from prevRandao; Polygon's takes a difficulty.
 * Arbitrum's is left alone: its headers keep the ArbOS version in that field (overridden, the node runs the block by
 * the first version's rules, without PUSH0), and opcode 0x44 is 1 there whatever it holds.
 */
export function nodeOverrides(h: BlockAt['header']): Record<string, string> {
  return {
    time: `0x${h.timestamp.toString(16)}`, feeRecipient: h.coinbase, ...(h.arbBlockNumber === undefined && { prevRandao: h.prevRandao }), baseFeePerGas: `0x${h.baseFeePerGas.toString(16)}`,
    ...(h.difficulty !== undefined && { difficulty: `0x${h.difficulty.toString(16)}` }),
  };
}
