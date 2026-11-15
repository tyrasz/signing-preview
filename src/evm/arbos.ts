// ArbSys's sends to L1 (sendTxToL1, withdrawEth), as Arbitrum's node runs them, for the local EVM: the value is
// burned, the send is appended to ArbOS's send-merkle accumulator (kept in the storage of ArbOS's state account),
// and the events are ArbSys's own. Measured on Arbitrum One's node (2026-11-15; its arbOSVersion() answered 116) with
// eth_simulateV1: the send's hash, its position, every SendMerkleUpdate the append emits and the gas, to the unit,
// for empty, short and long data, with and without value, and with 0, 1, 2 and 3 levels of the tree merged.
import { concat, encodeAbiParameters, keccak256, pad, toHex, type Hex } from 'viem';

/** ArbOS's state account: its storage holds the chain's own state (the send-merkle accumulator among it). */
export const ARBOS_STATE = '0xa4b05fffffffffffffffffffffffffffffffffff';
export const ARBSYS = '0x0000000000000000000000000000000000000064';
export const SEND_TX_TO_L1 = '0x928c169a'; // sendTxToL1(address,bytes)
export const WITHDRAW_ETH = '0x25e16063'; // withdrawEth(address)
/** event L2ToL1Tx(address caller, address indexed destination, uint256 indexed hash, uint256 indexed position, uint256 arbBlockNum, uint256 ethBlockNum, uint256 timestamp, uint256 callvalue, bytes data) */
export const L2_TO_L1_TX = '0x3e7aafa77dbf186b7fd488006beff893744caa3c4f6f299e8a709fa2087374fc';
/** event SendMerkleUpdate(uint256 indexed reserved, bytes32 indexed hash, uint256 indexed position) */
export const SEND_MERKLE_UPDATE = '0xe9e13da364699fb5b0496ff5a0fc70760ad5836e93ba96568a4e42b9914a8b95';

/**
 * A slot of ArbOS's send-merkle accumulator. ArbOS keeps each part of its state in a subspace of its account's
 * storage, the slot of a key the first 31 bytes of keccak256(the subspace's key, the key's first 31 bytes) and then
 * the key's last byte; the accumulator's subspace key is keccak256(0x05). Its size is at offset 0 and the partial
 * hash of each level at 2 + level (checked against ArbSys.sendMerkleTreeState() on the node: all 18 levels).
 */
const SEND_MERKLE_PREFIX = keccak256(concat([keccak256('0x05'), `0x${'00'.repeat(31)}`])).slice(0, 64);
export const sendMerkleSlot = (offset: number): Hex => `${SEND_MERKLE_PREFIX}${offset.toString(16).padStart(2, '0')}` as Hex;

/** What ArbOS's storage burner charges: a slot read 800, a write 20,000 (5,000 for a zero). */
const READ = 800n, WRITE = 20_000n, WRITE_ZERO = 5_000n;
/** An event a precompile emits: 375, 375 a topic (its signature one), 8 a byte of data, as an EVM's LOG. */
const eventGas = (topics: number, bytes: number) => 375n + 375n * BigInt(topics) + 8n * BigInt(bytes);
const words = (bytes: number) => BigInt(Math.ceil(bytes / 32));
/** The number of partials a tree of `size` leaves keeps: the bit length of the size. */
const partialsOf = (size: bigint) => (size === 0n ? 0 : size.toString(2).length);

export interface L1Send { caller: string; destination: string; value: bigint; data: Hex; arbBlockNumber: bigint; l1BlockNumber: bigint; timestamp: bigint }
export interface SendMerkleState { get(slot: Hex): Promise<bigint>; set(slot: Hex, value: bigint): Promise<void> }
export type Log = { address: Hex; topics: Hex[]; data: Hex };

/**
 * The send's hash: keccak256 of the caller, the destination, the L2 and L1 block numbers, the block's time and the
 * value (each a 32-byte word), then the data.
 */
export const sendHash = (s: L1Send): Hex => keccak256(concat([s.caller as Hex, s.destination as Hex, pad(toHex(s.arbBlockNumber)), pad(toHex(s.l1BlockNumber)), pad(toHex(s.timestamp)), pad(toHex(s.value)), s.data]));

/**
 * What the send costs and does on the accumulator as it is (`state`): its gas, the events, the leaf it becomes
 * (what the call returns), and the writes, applied only by `apply` (so a call that can't pay for it changes nothing).
 * Gas: 800 to open ArbOS's state, 3 a word of the arguments, the hash (30 and 6 a word of its 168 bytes and the
 * data), the size read and written (800 + 20,000), each level merged on the way up (its partial read, 800; the two
 * hashed, 42; cleared, 5,000; a SendMerkleUpdate event, 1,875), the level the new partial lands on (read, 800,
 * unless it is a new top level; written, 20,000), the size read again (800), the L2ToL1Tx event (1,875 and 8 a byte
 * of its data), 3 for the word returned, and 800 more when value is sent.
 */
export async function l1Send(send: L1Send, inputBytes: number, state: SendMerkleState): Promise<{ gas: bigint; position: bigint; logs: Log[]; apply: () => Promise<void> }> {
  const hash = sendHash(send), dataBytes = (send.data.length - 2) / 2;
  let gas = READ + 3n * words(inputBytes - 4) + 30n + 6n * words(168 + dataBytes);
  const position = await state.get(sendMerkleSlot(0)), size = position + 1n;
  gas += READ + WRITE;
  const writes: [Hex, bigint][] = [[sendMerkleSlot(0), size]];
  const logs: Log[] = [];
  let level = 0, soFar = keccak256(hash);
  for (;;) {
    if (level === partialsOf(position)) { writes.push([sendMerkleSlot(2 + level), BigInt(soFar)]); gas += WRITE; break; }
    const partial = await state.get(sendMerkleSlot(2 + level));
    gas += READ;
    if (partial === 0n) { writes.push([sendMerkleSlot(2 + level), BigInt(soFar)]); gas += WRITE; break; }
    soFar = keccak256(concat([pad(toHex(partial)), soFar]));
    writes.push([sendMerkleSlot(2 + level), 0n]);
    gas += 42n + WRITE_ZERO;
    level++;
    logs.push({ address: ARBSYS, topics: [SEND_MERKLE_UPDATE, pad('0x0'), soFar, pad(toHex((BigInt(level) << 192n) | position))], data: '0x' });
    gas += eventGas(4, 0);
  }
  const data = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }],
    [send.caller as Hex, send.arbBlockNumber, send.l1BlockNumber, send.timestamp, send.value, send.data]);
  logs.push({ address: ARBSYS, topics: [L2_TO_L1_TX, pad(send.destination as Hex), hash, pad(toHex(position))], data });
  gas += READ + eventGas(4, (data.length - 2) / 2) + 3n + (send.value > 0n ? READ : 0n);
  return { gas, position, logs, apply: async () => { for (const [slot, v] of writes) await state.set(slot, v); } };
}
