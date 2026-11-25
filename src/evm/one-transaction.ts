// A batch an account with code runs is one transaction: the account's code makes the calls one after another, and
// what a call leaves for the length of a transaction (transient storage, EIP-1153: a session opened, a lock held, a
// debt to settle before the end) the next call finds. Simulated one transaction per call, in order in one block, as
// a wallet_sendCalls request's calls are, that is gone between them. Batches on BNB Chain and Ethereum (2026-11-23,
// accounts running Calibur) whose first call opens on a contract what their last call closes were previewed with
// the last call failing, the batch "expected to fail": they ran.
//
// So where a call fails that way and the sender has code, the calls are run again as one transaction, and if they
// all go through so, that is what the batch does. One transaction, whatever the account's own batch format is: for
// the run, the account's code is a delegation (EIP-7702) to a few bytes placed at BATCHER, which
//   - called by the account itself with SELECTOR, make the calls that follow in order, from the account, and revert
//     with the call's index and what it returned if one fails;
//   - hand anything else on to the account's real code with a delegatecall (the code it delegates to; or its own
//     code, placed at MOVED for the run), so a call the batch makes to the account itself, a callback into it or a
//     signature it is asked to check runs what it would.
// The transaction is from the account to itself, as an account with delegated code sends its own batch: the calls
// see the account as msg.sender and as tx.origin.
//
// A plain account (no code) sends its calls a transaction each, unless the batch must be all or nothing
// (wallet_sendCalls with atomicRequired): a wallet can only make that of a plain account's calls by giving the
// account code (EIP-7702) and running them as one transaction. Which code is the wallet's choice, not known here:
// the run then has a stand-in for it at MOVED, which takes coin sent to the account and answers any other call with
// the call's own selector, as an account's code answers a token's or a signature check's question of it
// (onERC721Received, onERC1155Received, isValidSignature). What differs from a transaction each is what a callee
// makes of a caller that has code, and what lasts for one transaction.
import type { Hex } from 'viem';
import type { SimulationRequest } from '../types.ts';

/** Where the batching code and, for a contract account, its own code are placed for the run. */
export const BATCHER = '0x000000000000000000000000000000005b5c7a01', MOVED = '0x000000000000000000000000000000005b5c7a02';
/** What the account calls itself with to have the batching code make the calls. */
export const SELECTOR = '5b5c7a01';

type Op = number | { push: string } | { label: string } | { jump: string } | { jumpi: string };
const O = { STOP: 0x00, ADD: 0x01, GT: 0x11, EQ: 0x14, ISZERO: 0x15, SHL: 0x1b, SHR: 0x1c, ADDRESS: 0x30, CALLER: 0x33, CALLDATALOAD: 0x35, CALLDATASIZE: 0x36, CALLDATACOPY: 0x37, EXTCODESIZE: 0x3b, POP: 0x50,
  RETURNDATASIZE: 0x3d, RETURNDATACOPY: 0x3e, MLOAD: 0x51, MSTORE: 0x52, GAS: 0x5a, JUMPDEST: 0x5b, DUP1: 0x80, DUP3: 0x82, DUP6: 0x85, DUP7: 0x86, CALL: 0xf1, RETURN: 0xf3,
  DELEGATECALL: 0xf4, REVERT: 0xfd } as const;
const p = (hex: string): Op => ({ push: hex });

/** Bytes from opcodes, pushes and labels (a jump is a PUSH2 of its label's place, then JUMP or JUMPI). */
function assemble(ops: Op[]): Hex {
  const out: string[] = [], at = new Map<string, number>(), refs: { index: number; label: string }[] = [];
  let size = 0;
  for (const op of ops) {
    if (typeof op === 'number') { out.push(op.toString(16).padStart(2, '0')); size += 1; }
    else if ('push' in op) { const n = op.push.length / 2; out.push((0x5f + n).toString(16), op.push); size += 1 + n; }
    else if ('label' in op) { at.set(op.label, size); out.push('5b'); size += 1; }
    else { const label = 'jump' in op ? op.jump : op.jumpi; out.push('61'); refs.push({ index: out.length, label }); out.push('0000', 'jump' in op ? '56' : '57'); size += 4; }
  }
  for (const r of refs) out[r.index] = at.get(r.label)!.toString(16).padStart(4, '0');
  return `0x${out.join('')}`;
}

/**
 * The batching code, handing what isn't its own on to `real`. Its calls: the selector, then for each call its target
 * (20 bytes), its value (32), its calldata's length (32) and its calldata. In memory: the call's index at 0, the
 * place in the calldata at 0x20, the call's calldata from 0x40.
 */
export function batcherCode(real: string): Hex {
  return assemble([
    // Not the account calling itself with the selector: the account's real code.
    O.CALLDATASIZE, p('04'), O.GT, { jumpi: 'forward' },
    O.CALLER, O.ADDRESS, O.EQ, O.ISZERO, { jumpi: 'forward' },
    p('00'), O.CALLDATALOAD, p('e0'), O.SHR, p(SELECTOR), O.EQ, O.ISZERO, { jumpi: 'forward' },
    // The real code is touched once before the calls, so that it is warm for the rest of the transaction: handing a
    // call on to it then costs what the account's own code would have cost the caller, and a payment made to the
    // account on the 2,300 gas of a transfer (a wrapped coin's withdraw) still fits. Cold, the hand-on alone took
    // 2,600, and a batch of open, withdraw, close stayed "expected to fail".
    p(real.slice(2).toLowerCase().padStart(40, '0')), O.EXTCODESIZE, O.POP,
    p('04'), p('20'), O.MSTORE,
    { label: 'loop' },
    p('20'), O.MLOAD,                                             // [place]
    O.DUP1, O.CALLDATASIZE, O.GT, O.ISZERO, { jumpi: 'done' },    // nothing left: done
    O.DUP1, p('34'), O.ADD, O.CALLDATALOAD,                       // [length, place]
    O.DUP1, O.DUP3, p('54'), O.ADD, p('40'), O.CALLDATACOPY,      // the calldata, to memory at 0x40
    p('00'), p('00'), O.DUP3, p('40'),                            // [0x40, length, 0, 0, length, place]
    O.DUP6, p('14'), O.ADD, O.CALLDATALOAD,                       // value
    O.DUP7, O.CALLDATALOAD, p('60'), O.SHR,                       // target
    O.GAS, O.CALL,                                                // [ok, length, place]
    O.ISZERO, { jumpi: 'fail' },
    O.ADD, p('54'), O.ADD, p('20'), O.MSTORE,                     // place += 84 + length
    p('00'), O.MLOAD, p('01'), O.ADD, p('00'), O.MSTORE,          // index += 1
    { jump: 'loop' },
    { label: 'done' }, O.STOP,
    // A call failed: revert with its index, then what it returned.
    { label: 'fail' },
    O.RETURNDATASIZE, p('00'), p('20'), O.RETURNDATACOPY,
    O.RETURNDATASIZE, p('20'), O.ADD, p('00'), O.REVERT,
    { label: 'forward' },
    O.CALLDATASIZE, p('00'), p('00'), O.CALLDATACOPY,
    p('00'), p('00'), O.CALLDATASIZE, p('00'), p(real.slice(2).toLowerCase().padStart(40, '0')), O.GAS, O.DELEGATECALL,
    O.RETURNDATASIZE, p('00'), p('00'), O.RETURNDATACOPY,
    O.ISZERO, { jumpi: 'refuse' },
    O.RETURNDATASIZE, p('00'), O.RETURN,
    { label: 'refuse' },
    O.RETURNDATASIZE, p('00'), O.REVERT,
  ]);
}

/**
 * A stand-in for the code a wallet gives a plain account to run a batch: coin sent to the account (fewer than four
 * bytes of calldata) is taken, and any other call is answered with its own selector, left-aligned in a word.
 */
export function accountStandInCode(): Hex {
  return assemble([
    O.CALLDATASIZE, p('04'), O.GT, { jumpi: 'coin' },
    p('00'), O.CALLDATALOAD, p('e0'), O.SHR, p('e0'), O.SHL, p('00'), O.MSTORE,
    p('20'), p('00'), O.RETURN,
    { label: 'coin' }, O.STOP,
  ]);
}

/** The calls, as the batching code takes them. */
export function batchData(calls: readonly { to: string; value: bigint; data: string }[]): Hex {
  const word = (v: bigint) => v.toString(16).padStart(64, '0');
  return `0x${SELECTOR}${calls.map(c => `${c.to.slice(2).toLowerCase().padStart(40, '0')}${word(c.value)}${word(BigInt((c.data.length - 2) / 2))}${c.data.slice(2)}`).join('')}`;
}

/**
 * The calls as one transaction of an account with this code: the call the account makes to itself, and the code set
 * for the run. Null for an account with no code (a plain account's calls are a transaction each) and for a creation.
 */
export function asOneTransaction(account: string, code: string, calls: readonly { to: string | null; value: bigint; data: string }[]): { data: Hex; overrides: NonNullable<SimulationRequest['stateOverrides']> } | null {
  const own = code.toLowerCase();
  if (!/^0x([0-9a-f]{2})+$/.test(own) || calls.some(c => !c.to)) return null;
  // (Delegated code: the code delegated to is where it is. An account's own code is moved for the run.)
  const delegate = /^0xef0100[0-9a-f]{40}$/.test(own) ? `0x${own.slice(8)}` : null;
  return {
    data: batchData(calls as { to: string; value: bigint; data: string }[]),
    overrides: { [account.toLowerCase()]: { code: `0xef0100${BATCHER.slice(2)}` }, [BATCHER]: { code: batcherCode(delegate ?? MOVED) }, ...(!delegate && { [MOVED]: { code: own } }) },
  };
}

/**
 * The calls of a plain account (no code) as the one transaction a wallet makes of an all-or-nothing batch, the
 * account given code for it: here the batching code over a stand-in (accountStandInCode). Null for a creation.
 */
export function asOneTransactionOfPlain(account: string, calls: readonly { to: string | null; value: bigint; data: string }[]): { data: Hex; overrides: NonNullable<SimulationRequest['stateOverrides']> } | null {
  if (calls.some(c => !c.to)) return null;
  return {
    data: batchData(calls as { to: string; value: bigint; data: string }[]),
    overrides: { [account.toLowerCase()]: { code: `0xef0100${BATCHER.slice(2)}` }, [BATCHER]: { code: batcherCode(MOVED) }, [MOVED]: { code: accountStandInCode() } },
  };
}

/** Which call failed, and what it returned, from what the batching code reverts with (the call's index, then that). */
export function failedCall(returnData: string | undefined): { index: number; data: Hex } | null {
  if (!returnData || !/^0x([0-9a-f]{2}){32,}$/i.test(returnData)) return null;
  const index = BigInt(returnData.slice(0, 66));
  return index < 1_000n ? { index: Number(index), data: `0x${returnData.slice(66)}` } : null;
}
