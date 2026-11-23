// npm run rules -- [--chain 1|42161|8453|10|137|56|999|11155111|all] [--strict] [--summary-md file] [--out report.json]
//   [--family lifecycle|lifecycle-findings] [--only-context] [--only-gas] [--only-delegations] [--only-edges [--edges-match part]] [--only-combinations]
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
//     holds, a KZG proof, a P-256 signature) and with none: the same answer at the same price; and each chain's own
//     (ArbOS's, BNB Chain's light-client and signature checks, Base's B20 contracts), BNB Chain's and Base's with
//     inputs they accept and inputs they refuse;
//   - crafted programs for what an opcode alone doesn't reach (storage, creations and their size limits, calls with
//     value, SELFDESTRUCT), and EIP-7702 authorizations by accounts of each kind;
//   - creation and an account's life (lifecyclePrograms): collisions, 0xEF code, size limits either side, a nonce at
//     2^64 - 1, SELFDESTRUCT of new and old contracts and what the next transaction finds, empty accounts, value to
//     precompiles, creations in static calls, by delegated accounts and in creation transactions, and each chain's
//     system addresses. --family lifecycle runs those alone; lifecycle-findings, those the local EVM gets wrong yet.
//   - the block's context and the system contracts ordinary contracts read (contextPrograms; --only-context runs
//     those alone): BLOCKHASH at the edges of its window, EIP-2935's history, EIP-4788's beacon roots, EIP-7002's and
//     EIP-7251's requests, OP Stack's L1Block and GasPriceOracle, Polygon's, BNB Chain's and HyperEVM's own.
//   - gas at its edges (gasPrograms: 63/64, the stipend and its sentry, new accounts, warmth after a revert, a slot's
//     price through a transaction, memory, large LOGs, hashes and exponents, CREATE2, failing calls, access lists,
//     the calldata floor, refunds), most measured from inside a call given a set gas, so they compare on every chain;
//     and programs run again on exactly the gas the node's run of them needed and one less (boundaries).
//   - accounts delegated already (EIP-7702) read and called each way, authorization lists whose effect the call reads
//     back (which applied, the code left, the nonce, what is warm, what it cost), access lists on each transaction
//     type and an EIP-1559 transaction's price (--only-delegations: these alone).
//   - opcodes in combination (combinationPrograms): arithmetic at its edges, the stack's limit, jumps into push data,
//     memory at offsets no memory reaches, reads past the end of calldata, code and return data, what each kind of
//     call leaves, transient storage across frames, writes in a static context, what calls and account reads cost,
//     failed creations, SELFDESTRUCT, which accounts are warm, and what one transaction of a block leaves the next.
// --only-combinations runs those alone. RULES_FULL=1 prints, for each program that differs, both sides in full.
// On Arbitrum, whose node adds a charge for L1 data, gas is compared less that charge; not where the node has only
// eth_call.
// --strict exits with 1 when anything differs or a chain's fork isn't the one checked. Read-only: nothing is sent.
// --next runs it all at the fork a chain has scheduled (eth_config's next): in a block at the fork's time, which a
// node's eth_simulateV1 runs under the fork's rules (BNB Chain's does), so the local EVM can be checked before the
// fork takes effect. A chain with none scheduled is passed over.
import { appendFileSync, writeFileSync } from 'node:fs';
import { createHash, createSign, generateKeyPairSync } from 'node:crypto';
import { getActivePrecompiles } from '@ethereumjs/evm';
import { createCustomCommon, Mainnet } from '@ethereumjs/common';
import { secp256k1 } from '@noble/curves/secp256k1';
import { bls12_381 } from '@noble/curves/bls12-381';
import { bn254 } from '@noble/curves/bn254';
import { p256 } from '@noble/curves/p256';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { getContractAddress, hashMessage, keccak256, toFunctionSelector, type Hex } from 'viem';
import { hashAuthorization } from 'viem/utils';
import { CHAIN_PROFILES, chainPrecompilesAt, ForkSimulator, hasReference, nodeRulesOf, timedPrecompilesAt } from '../src/fork-simulator.ts';
import { headerOf, NEXT_BLOCK, nodeOverrides, pinLatest, type BlockAt, type RpcHeader, type StateChanges } from '../src/block.ts';
import { chainsOwnLog } from '../src/evm/trace.ts';
import { authorizationsForNode } from '../src/simulation.ts';
import { replayTransaction } from '../src/replay.ts';
import { liveDependencies } from '../src/server.ts';
import { chainName, EVM_RPCS, rpcUrlFor } from '../src/chains.ts';
import { JsonRpcClient } from '../src/rpc.ts';
import type { SimulationRequest } from '../src/types.ts';

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const STRICT = process.argv.includes('--strict'), SUMMARY_MD = arg('summary-md', ''), OUT = arg('out', ''), NEXT = process.argv.includes('--next');
const FAMILY = arg('family', ''), FUZZ = Number(arg('fuzz', '0')), SEED = Number(arg('seed', String(Date.now() % 1_000_000))), ONLY_FUZZ = process.argv.includes('--only-fuzz');
/** --only-context: the block-context and system-contract programs alone (contextPrograms). */
const ONLY_CONTEXT = process.argv.includes('--only-context');
/** --only-gas: the gas programs alone (gasPrograms, and the boundaries after them). */
const ONLY_GAS = process.argv.includes('--only-gas');
/** --only-delegations: only delegatedPrograms, accessListPrograms and delegationAuthorizations (EIP-7702 and what a transaction carries). */
const ONLY_DELEGATIONS = process.argv.includes('--only-delegations');
/** --only-edges: only the precompiles' edge inputs (precompileEdgePrograms); --edges-match <part of a label>: only those of them. */
const ONLY_EDGES = process.argv.includes('--only-edges'), EDGES_MATCH = arg('edges-match', '');
/** --only-combinations: only combinationPrograms' (opcodes in combination), without the rest. */
const ONLY_COMBINATIONS = process.argv.includes('--only-combinations');
const CHAINS_ASKED = arg('chain', 'all') === 'all' ? Object.keys(EVM_RPCS).map(Number) : arg('chain', '1').split(',').map(Number);

const FROM = '0x000000000000000000000000000000000000dead';
const RICH = { [FROM]: { balance: '0x56bc75e2d63100000' } };
const GAS = 1_048_576n;
const INVALID = /invalid opcode|not defined|notactivated|not supported|undefined opcode|opcodenotfound|unsupported opcode|invalid instruction|invalidfeopcode|invalidimmediate|invalid immediate/i;
const hex2 = (n: number) => n.toString(16).padStart(2, '0');
const word = (v: bigint | number) => BigInt(v).toString(16).padStart(64, '0');
/** The address the i-th program of a batch is placed at. */
const place = (i: number) => `0x${(0xc0de0000 + i).toString(16).padStart(40, '0')}`;

interface Program { label: string; code?: Hex; to?: string; data?: Hex; value?: bigint; balance?: bigint; /** The gas the call is given, where GAS isn't enough. */ gas?: bigint; /** Slots the program's own account holds beforehand. */ storage?: Record<string, string>; /** One of fuzzPrograms'. */ random?: boolean; /** Sent at a price (a gwei over the block's base fee), as a transaction is: its gas is bought before it runs. */ priced?: boolean; /** First in its simulated block: what the calls before it there did can't move what it reads. */ first?: boolean; /** Said with a difference: what it takes to run the program again. */ detail?: string; /** EIP-7702 authorizations the call carries, and the accounts their authorities are given (see authorizationPrograms). */ authorizationList?: NonNullable<SimulationRequest['authorizationList']>; state?: StateChanges; /** The code is `caller`: it returns whether the precompile's call succeeded, the gas it spent, and what came back. */ precompile?: boolean;
  /** The sender, where not FROM (an EIP-7702 authority sending its own transaction). */ from?: string;
  /** An access list (EIP-2930), with the transaction's type: 1 with `priced`, 2 with `fees`, 4 with an authorization list. */ accessList?: { address: string; storageKeys: string[] }[];
  /** Sent as an EIP-1559 transaction: a fee cap `cap` over the block's base fee and a tip `tip` (the whole cap where none); the local EVM is given the price that comes to. */ fees?: { cap: bigint; tip?: bigint };
  /** A creation: sent to no address, `data` its initcode. */ create?: boolean;
  /** Its gas is given back in part at the end (a refund): what it needs is more than what it uses. */ refunds?: boolean;
  /** Reads what a program before it in the same block did: only where the node runs a block (not through eth_call). */ sequel?: boolean;
  /** A call or creation inside burns all the gas it is given (63/64 of what is left): on Arbitrum, whose node takes its L1 charge out of the gas a call is given, a little less of it. */ burns?: boolean }
interface Outcome { kind: 'runs' | 'invalid' | 'fails' | 'refused'; returns: string; gas?: bigint; /** The node's maxUsedGas: what the call used at most, before its refund. */ peak?: bigint; logs: string; why?: string }

/** Seventeen pushes (1 on top), the opcode, then: store the top of the stack at 0, the memory size at 32, return both. */
const opcodeProgram = (op: number): Hex => `0x${Array.from({ length: 17 }, (_, i) => `60${hex2(17 - i)}`).join('')}${hex2(op)}6000525960205260406000f3`;

/** A few mnemonics, enough for the crafted programs; a bare hex literal is a PUSH of it. */
const OPS: Record<string, string> = {
  STOP: '00', SUB: '03', EXP: '0a', SHL: '1b', KECCAK256: '20', BALANCE: '31', CALLER: '33', CALLDATASIZE: '36', CALLDATACOPY: '37', RETURNDATASIZE: '3d', RETURNDATACOPY: '3e',
  EXTCODESIZE: '3b', EXTCODEHASH: '3f', BLOCKHASH: '40', NUMBER: '43', POP: '50', MLOAD: '51', SWAP1: '90',
  MSTORE: '52', SLOAD: '54', SSTORE: '55', GAS: '5a', TLOAD: '5c', TSTORE: '5d', MCOPY: '5e', LOG2: 'a2', CREATE: 'f0', CALL: 'f1', RETURN: 'f3', DELEGATECALL: 'f4', CREATE2: 'f5',
  STATICCALL: 'fa', CALLCODE: 'f2', MSTORE8: '53', REVERT: 'fd', INVALID: 'fe', SELFDESTRUCT: 'ff', LOG1: 'a1', ADDRESS: '30', SELFBALANCE: '47', GASPRICE: '3a', COINBASE: '41', BASEFEE: '48', CALLVALUE: '34',
  ADD: '01', DUP1: '80', CALLDATALOAD: '35', CODECOPY: '39', EXTCODECOPY: '3c', TIMESTAMP: '42', LOG0: 'a0', ISZERO: '15', EQ: '14',
  PREVRANDAO: '44', GASLIMIT: '45', CHAINID: '46', BLOBBASEFEE: '4a', MSIZE: '59', JUMP: '56', LOG4: 'a4', ORIGIN: '32',
};
const asm = (source: string): Hex => `0x${source.trim().split(/\s+/).map(t => {
  if (OPS[t]) return OPS[t];
  if (!/^([0-9a-f]{2})+$/.test(t) || t.length > 64) throw new Error(`asm: ${t}`);
  return `${(0x5f + t.length / 2).toString(16)}${t}`;
}).join('')}`;

/** Programs that the seventeen-push form can't reach: opcodes whose arguments have to mean something. */
function crafted(amsterdam: boolean): Program[] {
  const RET = '00 MSTORE 20 00 RETURN'; // the top of the stack, as the 32 bytes returned
  // Initcode that returns ten bytes (of zeros) as the new contract's code, left-aligned at memory 0.
  const INIT = '600a6000f3 d8 SHL 00 MSTORE';
  const NOBODY = '000000000000000000000000000000000beef078', EMPTY = '000000000000000000000000000000000beef079';
  const DELEGATED = '00000000000000000000000000000000de1e9a7e', TO_PRECOMPILE = '00000000000000000000000000000000de1e9a7f', DELEGATE = '00000000000000000000000000000000c0de7704';
  // A contract that stores its first calldata word at slot 7, and grows its memory by 92,160 gas' worth when the second is set.
  const KEEPER = '00000000000000000000000000000000c0de7705';
  // Another that sets slot 8 when the second word is set: a new slot, right after the first is cleared.
  const KEEPER2 = '00000000000000000000000000000000c0de7706';
  // And one that reverts when the second word is set, after storing the first.
  const KEEPER3 = '00000000000000000000000000000000c0de7708';
  const keeper: StateChanges = { [`0x${KEEPER}`]: { code: '0x60003560075560203515601457600162030000525b00' }, [`0x${KEEPER2}`]: { code: '0x6000356007556020351560125760016008555b00' }, [`0x${KEEPER3}`]: { code: '0x6000356007556020351560125760006000fd5b00' } };
  const delegations: StateChanges = { [`0x${DELEGATE}`]: { code: '0x602a60005260206000f3' }, [`0x${DELEGATED}`]: { code: `0xef0100${DELEGATE}` }, [`0x${TO_PRECOMPILE}`]: { code: `0xef0100${'00'.repeat(19)}04` } };
  return [
    { label: 'BLOCKHASH of the block before', code: asm(`01 NUMBER SUB BLOCKHASH ${RET}`) },
    { label: 'BALANCE of the sender', code: asm(`CALLER BALANCE ${RET}`) },
    { label: 'SLOAD of a slot twice (cold, then warm)', code: asm(`07 SLOAD POP 07 SLOAD ${RET}`) },
    { label: 'SSTORE to an empty slot, then SLOAD', code: asm(`2a 07 SSTORE 07 SLOAD ${RET}`) },
    { label: 'SSTORE set then cleared (a refund)', code: asm(`2a 07 SSTORE 00 07 SSTORE 07 SLOAD ${RET}`) },
    // The same with little gas to spare: what a slot costs while it is set matters, not only what is left of it
    // once it is cleared (under Amsterdam a new slot's state is paid for, and given back when the slot is cleared).
    { label: 'SSTORE set then cleared, on 60,000 gas', code: asm(`2a 07 SSTORE 00 07 SSTORE 07 SLOAD ${RET}`), gas: 60_000n },
    { label: 'SSTORE set then cleared, on 130,000 gas', code: asm(`2a 07 SSTORE 00 07 SSTORE 07 SLOAD ${RET}`), gas: 130_000n },
    { label: 'two slots set then cleared, on 130,000 gas', code: asm(`2a 07 SSTORE 2a 08 SSTORE 00 07 SSTORE 00 08 SSTORE 07 SLOAD ${RET}`), gas: 130_000n },
    { label: 'two slots set then cleared, on 250,000 gas', code: asm(`2a 07 SSTORE 2a 08 SSTORE 00 07 SSTORE 00 08 SSTORE 07 SLOAD ${RET}`), gas: 250_000n },
    // And whether the gas a cleared slot gives back can be spent on something else: 92,160 gas of memory, on a
    // limit that only holds it if what the slot's state cost is usable again.
    { label: 'a slot set then cleared, then memory grown on the gas it gave back', code: asm(`2a 07 SSTORE 00 07 SSTORE 01 030000 MSTORE 07 SLOAD ${RET}`), gas: 160_000n },
    // The same across calls, as a token's allowance is set by one call and spent by another: a slot set in one
    // call to a contract and cleared in the next, with the memory grown afterwards by the caller, or inside the
    // call that clears. (Under Amsterdam the gas a cleared slot gives back has to reach whoever needs it.)
    { label: 'a slot set in one call and cleared in the next, then memory grown by the caller', code: asm(`2a 00 MSTORE 00 00 20 00 00 ${KEEPER} GAS CALL POP 00 00 MSTORE 00 00 20 00 00 ${KEEPER} GAS CALL POP 01 030000 MSTORE 00 ${RET}`), gas: 170_000n, state: keeper },
    { label: 'a slot set in one call, then cleared and memory grown in the next', code: asm(`2a 00 MSTORE 00 00 40 00 00 ${KEEPER} GAS CALL POP 00 00 MSTORE 01 20 MSTORE 00 00 40 00 00 ${KEEPER} GAS CALL ${RET}`), gas: 170_000n, state: keeper },
    { label: 'a slot set in one call, then cleared and another set in the next', code: asm(`2a 00 MSTORE 00 00 40 00 00 ${KEEPER2} GAS CALL POP 00 00 MSTORE 01 20 MSTORE 00 00 40 00 00 ${KEEPER2} GAS CALL ${RET}`), gas: 150_000n, state: keeper },
    // A call that clears the slot and then reverts gives nothing back: the slot is as it was.
    { label: 'a slot set in one call, cleared in a call that then reverts, then memory grown by the caller', code: asm(`2a 00 MSTORE 00 00 40 00 00 ${KEEPER3} GAS CALL POP 00 00 MSTORE 01 20 MSTORE 00 00 40 00 00 ${KEEPER3} GAS CALL POP 01 030000 MSTORE 00 ${RET}`), gas: 170_000n, state: keeper },
    // With a gas limit over the cap on ordinary gas (16,777,216): how much the code has to run on, and what a
    // call that fails outright (a write inside a static call) takes with it.
    { label: 'GAS, on a limit of 20,000,000', code: asm(`GAS ${RET}`), gas: 20_000_000n },
    { label: 'a static call that writes, given all the gas, on a limit of 20,000,000', code: asm(`00 00 00 00 ${KEEPER} GAS STATICCALL ${RET}`), gas: 20_000_000n, state: keeper },
    // Sent at a price, as a transaction is: its gas is bought before it runs, so its sender's balance is lower by
    // the gas limit at that price while it runs; what the code reads of the price, and the fee recipient's balance.
    { label: 'BALANCE of the sender, in a call that pays for its gas', code: asm(`CALLER BALANCE ${RET}`), priced: true },
    { label: 'GASPRICE and BASEFEE, in a call that pays for its gas', code: asm('GASPRICE 00 MSTORE BASEFEE 20 MSTORE 40 00 RETURN'), priced: true },
    // (First in its block: Polygon's node pays the fee recipient the base fee of a call sent at no price, which no
    // transaction is, before the next call in the block reads it; a program burning 19,687,885 gas so moved it.)
    { label: "BALANCE of the fee recipient, in a call that pays for its gas", code: asm(`COINBASE BALANCE ${RET}`), priced: true, first: true },
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
    // A contract that destroys itself as it is created, to itself: its 5 wei are burnt (from Amsterdam on, with a log).
    { label: 'SELFDESTRUCT to itself by a contract being created (a burn)', code: asm(`30ff 00 MSTORE 02 1e 05 CREATE ${RET}`), balance: 10n },
    // Sizes on either side of the limits a fork moves (EIP-7954 in Amsterdam): 25,000 bytes of code is over the
    // 24,576 a contract could be before, 50,000 bytes of initcode over the 49,152. The code's deposit takes gas a
    // transaction can only bring under Amsterdam above the cap on ordinary gas (its reservoir for state).
    { label: 'CREATE of 25,000 bytes of code', code: asm(`6161a86000f3 d0 SHL 00 MSTORE 06 00 00 CREATE ${RET}`), gas: amsterdam ? 48_000_000n : 16_000_000n },
    { label: 'CREATE from 50,000 bytes of initcode', code: asm(`c350 00 00 CREATE ${RET}`) },
    { label: 'RETURNDATASIZE after a call that returns a word', code: asm(`2a 00 MSTORE 20 00 20 00 04 GAS STATICCALL POP RETURNDATASIZE ${RET}`) },
    // Amsterdam's stack opcodes with an immediate (EIP-8024): the 17th item copied to the top, the top swapped with
    // the 18th, and two items below the top exchanged. Before Amsterdam they are no opcodes at all.
    { label: 'DUPN of the 17th item', code: `0x${Array.from({ length: 20 }, (_, i) => `60${hex2(20 - i)}`).join('')}e600${asm(RET).slice(2)}` },
    { label: 'SWAPN with the 18th item', code: `0x${Array.from({ length: 20 }, (_, i) => `60${hex2(20 - i)}`).join('')}e700${asm(RET).slice(2)}` },
    { label: 'EXCHANGE of two items', code: `0x${Array.from({ length: 20 }, (_, i) => `60${hex2(20 - i)}`).join('')}e80150${asm(RET).slice(2)}` },
    // Accounts that are delegated already (EIP-7702; their code is 0xef0100 and the delegate's address): what
    // their code reads as, and a call into one, which runs the delegate's code and pays to reach it. One delegates
    // to a contract that returns 42, the other to the identity precompile, whose code is none.
    { label: 'EXTCODESIZE and EXTCODEHASH of a delegated account', code: asm(`${DELEGATED} EXTCODESIZE 00 MSTORE ${DELEGATED} EXTCODEHASH 20 MSTORE 40 00 RETURN`), state: delegations },
    { label: 'CALL to an account delegated to a contract', code: asm(`20 00 00 00 00 ${DELEGATED} GAS CALL POP 00 MLOAD ${RET}`), state: delegations },
    { label: 'CALL to the same delegated account twice (cold, then warm)', code: asm(`20 00 00 00 00 ${DELEGATED} GAS CALL POP 20 00 00 00 00 ${DELEGATED} GAS CALL POP 00 MLOAD ${RET}`), state: delegations },
    { label: 'CALL to an account delegated to a precompile', code: asm(`2a 00 MSTORE 20 20 20 00 00 ${TO_PRECOMPILE} GAS CALL ${RET}`), state: delegations },
    { label: 'a plain transfer of a wei to an account', to: '0x000000000000000000000000000000000000beef', value: 1n },
    { label: 'a call with 100 bytes of calldata', to: '0x000000000000000000000000000000000000beef', data: `0x${'11'.repeat(100)}` },
  ];
}

/**
 * A contract that passes its calldata to a precompile and returns four words: whether the call succeeded, the gas
 * it spent, how many bytes came back, and their hash. Called directly, a cheap precompile's price hides under the
 * calldata floor every transaction pays; measured from inside, it doesn't. `gas`: what the call is given (a hex
 * number), where not all it can be.
 */
const caller = (target: number, op: 'STATICCALL' | 'CALL' | 'DELEGATECALL' | 'CALLCODE' = 'STATICCALL', gas = 'GAS'): Hex => asm(`CALLDATASIZE 00 00 CALLDATACOPY GAS 00 00 CALLDATASIZE 00 ${op === 'CALL' || op === 'CALLCODE' ? 'CALLVALUE ' : ''}${target.toString(16).padStart(target > 0xffff ? 6 : target > 0xff ? 4 : 2, '0')} ${gas} ${op} GAS
  SWAP1 00 MSTORE SWAP1 SUB 20 MSTORE RETURNDATASIZE 40 MSTORE RETURNDATASIZE 00 80 RETURNDATACOPY RETURNDATASIZE 80 KECCAK256 60 MSTORE 80 00 RETURN`);

/** The precompiles, each with an input it accepts. Where an input is wrong for a chain, the node and the local EVM should refuse it alike. */
/**
 * EIP-7702 authorizations, signed on the spot by keys made for the run (so no authority has an account on the
 * chain). What applying one costs depends on what the authority's account was, and forks price it their own way:
 * before Amsterdam 25,000 each, with 12,500 back for an account that exists; under Amsterdam a charge for the write
 * and for the state added. `state` gives an authority the account its case needs: on the node as state overrides, in
 * the local EVM as the block's own state (BlockAt.state), since a request's code override for a signed authority
 * is taken there for a stand-in and left out.
 */
async function authorizationPrograms(chainId: number): Promise<Program[]> {
  const TO = '0x000000000000000000000000000000000000beef', FIRST = '0x00000000000000000000000000000000c0de7702', SECOND = '0x00000000000000000000000000000000c0de7703';
  const address = (key: Hex) => privateKeyToAccount(key).address.toLowerCase();
  const authorization = async (key: Hex, nonce: number, delegate = FIRST) => {
    const a = await privateKeyToAccount(key).signAuthorization({ contractAddress: delegate as Hex, chainId, nonce });
    return { address: delegate, chainId: `0x${chainId.toString(16)}`, nonce: `0x${nonce.toString(16)}`, r: a.r, s: a.s, yParity: `0x${(a.yParity ?? 0).toString(16)}` };
  };
  const fresh = generatePrivateKey(), existing = generatePrivateKey(), delegated = generatePrivateKey(), twice = generatePrivateKey(), wrong = generatePrivateKey();
  return [
    { label: 'an EIP-7702 authorization by an account that does not exist yet', to: TO, authorizationList: [await authorization(fresh, 0)] },
    { label: 'an EIP-7702 authorization by an account that exists', to: TO, authorizationList: [await authorization(existing, 0)], state: { [address(existing)]: { balance: '0x1' } } },
    { label: 'an EIP-7702 authorization by an account already delegated', to: TO, authorizationList: [await authorization(delegated, 5)], state: { [address(delegated)]: { nonce: '0x5', code: `0xef0100${SECOND.slice(2)}` } } },
    { label: 'two EIP-7702 authorizations by one account', to: TO, authorizationList: [await authorization(twice, 0), await authorization(twice, 1, SECOND)] },
    { label: 'an EIP-7702 authorization with the wrong nonce', to: TO, authorizationList: [await authorization(wrong, 3)] },
  ];
}

/**
 * EIP-7702 beyond authorizationPrograms, and what a transaction carries besides its call. Accounts delegated already
 * (code given as state, so on every chain, HyperEVM's too, whose node follows a delegation): what EXTCODECOPY reads
 * of one; delegations that the EVM doesn't follow further (to an account that is delegated itself, to itself), to an
 * account with no code and to a precompile; each kind of call into one (a delegate call runs the delegate's code as
 * the caller, a static call and callcode as each does), with the delegate warm or the account warm first, with value;
 * a delegate that destroys itself (EIP-6780: only the balance goes) or counts in its own storage (the account's);
 * transactions straight to one, and from one (to itself, as an EIP-7702 wallet runs a batch, and to another); a
 * creation onto an address that holds a delegation. Each call is timed from inside. Those that need a signed list
 * (not HyperEVM's) are delegationAuthorizations'.
 */
function delegatedPrograms(): Program[] {
  const a = (n: number) => n.toString(16).padStart(40, '0');
  const RET42 = a(0xc0de7712), STORER = a(0xc0de7714), DESTROYER = a(0xc0de7713), WARMTH = a(0xc0de7715), NOBODY = '000000000000000000000000000000000beef791';
  const CHAINED = a(0xde1e9a80), HOP = a(0xde1e9a81), TO_EMPTY = a(0xde1e9a82), TO_SELF = a(0xde1e9a83), D_RET = a(0xde1e9a84), D_SD = a(0xde1e9a85), D_STORE = a(0xde1e9a86), D_PRE = a(0xde1e9a87), D_WARM = a(0xde1e9a88), D_SELF = a(0xde1e9a8b), D_SELF2 = a(0xde1e9a8c);
  const to = (d: string) => `0xef0100${d}`;
  const state: StateChanges = {
    [`0x${RET42}`]: { code: '0x602a60005260206000f3' }, [`0x${DESTROYER}`]: { code: asm('CALLER SELFDESTRUCT') },
    [`0x${STORER}`]: { code: asm('07 SLOAD 01 ADD 07 SSTORE 07 SLOAD 00 MSTORE 20 00 RETURN') },
    // Its own EXTCODESIZE, timed: warm where the delegate was warmed before its code ran.
    [`0x${WARMTH}`]: { code: asm(`GAS ${WARMTH} EXTCODESIZE POP GAS SWAP1 SUB 00 MSTORE 20 00 RETURN`) },
    [`0x${CHAINED}`]: { code: to(HOP) }, [`0x${HOP}`]: { code: to(RET42) }, [`0x${TO_EMPTY}`]: { code: to(NOBODY) }, [`0x${TO_SELF}`]: { code: to(TO_SELF) },
    [`0x${D_RET}`]: { code: to(RET42) }, [`0x${D_SD}`]: { code: to(DESTROYER), balance: '0x7' }, [`0x${D_SELF}`]: { code: to(STORER), balance: '0x64', stateDiff: { [`0x${word(7)}`]: `0x${word(5)}` } }, [`0x${D_SELF2}`]: { code: to(STORER), balance: '0x64', stateDiff: { [`0x${word(7)}`]: `0x${word(5)}` } }, [`0x${D_STORE}`]: { code: to(STORER) }, [`0x${D_PRE}`]: { code: to(`${'00'.repeat(19)}04`) }, [`0x${D_WARM}`]: { code: to(WARMTH) },
  };
  // A call into `target`, reporting whether it succeeded, the gas it spent, how many bytes came back and their hash
  // (as `caller` does), after `before`.
  const measure = (target: string, op: 'CALL' | 'STATICCALL' | 'DELEGATECALL' | 'CALLCODE' = 'CALL', { value = '00', before = '' } = {}) => asm(`${before} CALLDATASIZE 00 00 CALLDATACOPY GAS 00 00 CALLDATASIZE 00 ${op === 'CALL' || op === 'CALLCODE' ? `${value} ` : ''}${target} GAS ${op} GAS
    SWAP1 00 MSTORE SWAP1 SUB 20 MSTORE RETURNDATASIZE 40 MSTORE RETURNDATASIZE 00 80 RETURNDATACOPY RETURNDATASIZE 80 KECCAK256 60 MSTORE 80 00 RETURN`);
  const into = (label: string, target: string, op?: Parameters<typeof measure>[1], more: Partial<Program> & { send?: string; before?: string } = {}): Program => {
    const { send, before, ...rest } = more;
    return { precompile: true, label, code: measure(target, op, { value: send, before }), state, ...rest };
  };
  const RET = '00 MSTORE 20 00 RETURN';
  // CREATE2 of no code with salt 42 by CREATOR, onto the address given a delegation.
  const CREATOR = '0x00000000000000000000000000000000c0de7716', collides = getContractAddress({ opcode: 'CREATE2', from: CREATOR, salt: `0x${word(0x2a)}`, bytecode: '0x' }).toLowerCase();
  return [
    { label: 'EXTCODECOPY of a delegated account (its 23 bytes, then zeros)', code: asm(`40 00 00 ${D_RET} EXTCODECOPY 40 00 RETURN`), state },
    { label: 'EXTCODECOPY of a delegated account from its 21st byte', code: asm(`20 14 00 ${D_RET} EXTCODECOPY 20 00 RETURN`), state },
    { label: 'EXTCODESIZE and EXTCODEHASH of accounts delegated to a delegated account, to one with no code, to itself',
      code: asm(`${CHAINED} EXTCODESIZE 00 MSTORE ${CHAINED} EXTCODEHASH 20 MSTORE ${TO_EMPTY} EXTCODESIZE 40 MSTORE ${TO_EMPTY} EXTCODEHASH 60 MSTORE ${TO_SELF} EXTCODESIZE 80 MSTORE ${TO_SELF} EXTCODEHASH a0 MSTORE c0 00 RETURN`), state },
    // (Calls that fail burning all they are given are on a gas limit of their own: on Arbitrum, whose node takes its L1
    // charge out of the gas a call is given, what such a call burns is less by 63/64 of it, and the total isn't compared.)
    into('CALL to an account delegated to a delegated account (not followed: its code is a designator)', CHAINED, 'CALL', { gas: GAS }),
    into('DELEGATECALL to an account delegated to a delegated account', CHAINED, 'DELEGATECALL', { gas: GAS }),
    into('CALL to an account delegated to an account with no code', TO_EMPTY),
    into('CALL to an account delegated to itself', TO_SELF, 'CALL', { gas: GAS }),
    into('DELEGATECALL to a delegated account', D_RET, 'DELEGATECALL'),
    into('STATICCALL to a delegated account', D_RET, 'STATICCALL'),
    into('CALLCODE to a delegated account', D_RET, 'CALLCODE'),
    into('DELEGATECALL to an account delegated to a precompile, with 100 bytes', D_PRE, 'DELEGATECALL', { data: `0x${'ab'.repeat(100)}` }),
    into('STATICCALL to an account delegated to a precompile, with 100 bytes', D_PRE, 'STATICCALL', { data: `0x${'ab'.repeat(100)}` }),
    into('CALL to a delegated account whose delegate is warm', D_RET, 'CALL', { before: `${RET42} EXTCODESIZE POP` }),
    into('CALL to a delegated account that is warm, its delegate cold', D_RET, 'CALL', { before: `${D_RET} BALANCE POP` }),
    into('CALL to a delegated account with a wei', D_RET, 'CALL', { send: '01', balance: 10n }),
    { label: 'CALL to an account delegated to a contract that destroys itself, then its code size and balance', code: asm(`00 00 00 00 00 ${D_SD} GAS CALL POP ${D_SD} EXTCODESIZE 00 MSTORE ${D_SD} BALANCE 20 MSTORE SELFBALANCE 40 MSTORE 60 00 RETURN`), state },
    { label: 'CALL twice to an account delegated to a contract that counts in its storage', code: asm(`00 00 00 00 00 ${D_STORE} GAS CALL POP 20 00 00 00 00 ${D_STORE} GAS CALL POP 00 MLOAD ${RET}`), state },
    { label: 'a transaction to a delegated account', to: `0x${D_RET}`, state },
    { label: "a transaction to a delegated account, its delegate's EXTCODESIZE timed (warm)", to: `0x${D_WARM}`, state },
    { label: 'a transaction to an account delegated to a delegated account', to: `0x${CHAINED}`, state },
    { label: 'a transaction to an account delegated to a precompile, with 100 bytes', to: `0x${D_PRE}`, data: `0x${'ab'.repeat(100)}`, state },
    { label: 'a transaction with a wei to a delegated account', to: `0x${D_RET}`, value: 1n, state },
    // A delegated account sending its own transaction to itself, as an EIP-7702 wallet runs a batch: the delegate runs
    // as the sender, on its storage; and from a delegated account to another account.
    { label: 'a delegated account calling itself', from: `0x${D_SELF}`, to: `0x${D_SELF}`, state },
    { label: 'a delegated account calling itself with a wei', from: `0x${D_SELF2}`, to: `0x${D_SELF2}`, value: 1n, state },
    { label: 'a transaction from a delegated account to another', from: `0x${D_SELF}`, to: `0x${D_RET}`, state },
    { label: 'CREATE2 onto an address that holds a delegation', to: CREATOR, code: asm(`2a 00 00 00 CREATE2 ${RET}`), gas: GAS, state: { ...state, [collides]: { code: to(RET42) } } },
  ];
}

/**
 * Access lists (EIP-2930) on each kind of transaction: what a slot and an account they name cost to read, and one
 * they don't; one naming the same account and slot twice; one naming the sender, the target and a precompile; one
 * naming a delegated account's delegate; and an EIP-1559 transaction's price (GASPRICE, the sender's balance while it
 * runs), at a tip the cap leaves room for and one it doesn't.
 */
function accessListPrograms(): Program[] {
  const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
  const LISTED = '000000000000000000000000000000000beef792', D_RET = a(0xde1e9a89), RET42 = a(0xc0de7712);
  // Times an SLOAD of slot 7 (listed), the BALANCE of LISTED (listed) and an SLOAD of slot 8 (not).
  const timed = asm(`GAS 07 SLOAD POP GAS SWAP1 SUB 00 MSTORE GAS ${LISTED} BALANCE POP GAS SWAP1 SUB 20 MSTORE GAS 08 SLOAD POP GAS SWAP1 SUB 40 MSTORE 60 00 RETURN`);
  const list = (self: string) => [{ address: self, storageKeys: [`0x${word(7)}`] }, { address: `0x${LISTED}`, storageKeys: [] }];
  const price = asm('GASPRICE 00 MSTORE CALLER BALANCE 20 MSTORE BASEFEE 40 MSTORE 60 00 RETURN');
  const T = (k: number) => a(0xc0de7720 + k);
  return [
    { label: 'type 1: an access list, a slot and an account it names read, and a slot it does not', to: T(0), code: timed, accessList: list(T(0)), priced: true },
    { label: 'type 2: an access list, a slot and an account it names read, and a slot it does not', to: T(1), code: timed, accessList: list(T(1)), fees: { cap: 2_000_000_000n, tip: 1_000_000_000n } },
    { label: 'an access list with no transaction price', to: T(2), code: timed, accessList: list(T(2)) },
    { label: 'an access list naming an account and a slot twice', to: T(3), code: timed, accessList: [...list(T(3)), ...list(T(3))] },
    { label: 'an access list naming the sender, the target and a precompile', to: T(4), code: timed, accessList: [{ address: FROM, storageKeys: [] }, { address: T(4), storageKeys: [] }, { address: a(1), storageKeys: [`0x${word(1)}`] }] },
    { label: "an access list naming a delegated account's delegate, then a call into it", precompile: true, to: T(5), code: asm(`GAS 00 00 00 00 00 ${D_RET.slice(2)} GAS CALL POP GAS SWAP1 SUB 00 MSTORE 20 00 RETURN`), accessList: [{ address: RET42, storageKeys: [] }],
      state: { [D_RET]: { code: `0xef0100${RET42.slice(2)}` }, [RET42]: { code: '0x602a60005260206000f3' } } },
    // (First in a block: on HyperEVM, whose node answers each in an eth_call of its own, a wei the sender sent earlier in
    // the batch is gone from its balance in the local EVM's run.)
    { label: 'type 2: GASPRICE and the sender\'s balance, at a cap of 2 gwei over the base fee and a tip of 1', code: price, fees: { cap: 2_000_000_000n, tip: 1_000_000_000n }, first: true },
    // (Not a tip above the cap itself: nodes refuse such a transaction outright, even unvalidated.)
    // (And on Arbitrum, whose node charges the call before it for its L1 data too, which the local EVM leaves to the node.)
    { label: 'type 2: GASPRICE and the sender\'s balance, at a tip as large as the cap (1 gwei over the base fee)', code: price, fees: { cap: 1_000_000_000n }, first: true },
  ];
}

/**
 * EIP-7702 authorization lists, signed on the spot by keys made for the run, whose effect the call reads back: a
 * reader called with the authority's address returns its code size and hash and calls into it, where the delegates
 * (PROBE, PROBE2) create a contract (whose address follows from the authority's nonce) and return its address and
 * their account's code hash. So each case shows which authorization applied, the code it left and the nonce: chain
 * id 0 and another chain's; one account twice at one nonce, twice at two, three times; clearing a delegation, and
 * "clearing" none; an authority with code; a signature with a parity of 2 and a nonce
 * of 2^64 - 1, which the chain skips; re-delegating; delegating to a precompile, to a delegated account, to the
 * authority itself; the sender as its own authority (its nonce one up already when the list applies), once, at its
 * old nonce, twice, and calling itself, a delegated one re-delegating itself; a transaction straight to the authority;
 * which authorities a skipped authorization leaves warm, and that nothing a transaction warmed stays warm in the next;
 * what an authorization's refund comes to where the refund cap doesn't bind, with a slot's refund besides, with five,
 * and on a call that reverts; authorizations kept by a transaction whose call fails; storage kept through clearing a
 * delegation and setting one again; a new authority whose delegate destroys itself (it keeps its code, EIP-6780).
 * (Not s above n/2 nor a parity of 27: the chain skips them and the local EVM, recovering with viem, applies them.)
 */
async function delegationAuthorizations(chainId: number): Promise<Program[]> {
  const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
  const PROBE = a(0xc0de7710), PROBE2 = a(0xc0de7711), HOP = a(0xde1e9a8a), RET42 = a(0xc0de7712), ZERO = '0x0000000000000000000000000000000000000000';
  const probe = asm('00 00 00 CREATE 00 MSTORE ADDRESS EXTCODEHASH 20 MSTORE 40 00 RETURN');
  const shared: StateChanges = { [PROBE]: { code: probe }, [PROBE2]: { code: probe }, [HOP]: { code: `0xef0100${RET42.slice(2)}` }, [RET42]: { code: '0x602a60005260206000f3' } };
  const reader = asm('00 CALLDATALOAD EXTCODESIZE 00 MSTORE 00 CALLDATALOAD EXTCODEHASH 20 MSTORE 20 60 00 00 00 00 CALLDATALOAD GAS CALL 40 MSTORE 80 00 RETURN');
  // Sends the authority a wei (its delegate, DESTROYER, destroys itself back to the caller), then reads its code size and balance.
  const DESTROYER = a(0xc0de7713), STORER = a(0xc0de7714);
  const sendAndRead = asm('00 00 00 00 01 00 CALLDATALOAD GAS CALL 00 MSTORE 00 CALLDATALOAD EXTCODESIZE 20 MSTORE 00 CALLDATALOAD BALANCE 40 MSTORE 60 00 RETURN');
  Object.assign(shared, { [DESTROYER]: { code: asm('CALLER SELFDESTRUCT') }, [STORER]: { code: asm('07 SLOAD 01 ADD 07 SSTORE 07 SLOAD 00 MSTORE 20 00 RETURN') } });
  // The gas BALANCE and EXTCODESIZE of the account in the calldata cost: warm or cold.
  const warmth = asm('GAS 00 CALLDATALOAD BALANCE POP GAS SWAP1 SUB 00 MSTORE 20 00 RETURN');
  type Signed = NonNullable<Program['authorizationList']>[number];
  // (Signed here, not by viem's signAuthorization, which takes the nonce as a number: 2^64 - 1 isn't one.)
  const sign = async (key: Hex, nonce: bigint, delegate = PROBE, chain = chainId): Promise<Signed> => {
    const s = secp256k1.sign(hashAuthorization({ address: delegate as Hex, chainId: chain, nonce: nonce as unknown as number }).slice(2), key.slice(2), { lowS: true });
    return { address: delegate, chainId: `0x${chain.toString(16)}`, nonce: `0x${nonce.toString(16)}`, r: `0x${word(s.r)}`, s: `0x${word(s.s)}`, yParity: `0x${s.recovery.toString(16)}` };
  };
  const keys = () => { const key = generatePrivateKey(); return { key, who: privateKeyToAccount(key).address.toLowerCase() }; };
  const read = (label: string, who: string, authorizationList: Signed[], more: Partial<Program> = {}): Program =>
    ({ label: `EIP-7702: ${label}`, code: reader, data: `0x${word(BigInt(who))}`, authorizationList, ...more, state: { ...shared, ...more.state } });
  const out: Program[] = [];
  { const { key, who } = keys(); out.push(read('an authorization for chain id 0', who, [await sign(key, 0n, PROBE, 0)])); }
  { const { key, who } = keys(); out.push(read("an authorization for another chain's id", who, [await sign(key, 0n, PROBE, chainId + 1)])); }
  { const { key, who } = keys(); out.push(read('two authorizations by one account at nonce 0', who, [await sign(key, 0n), await sign(key, 0n, PROBE2)])); }
  { const { key, who } = keys(); out.push(read('two authorizations by one account at nonces 0 and 1 (the second delegate)', who, [await sign(key, 0n), await sign(key, 1n, PROBE2)])); }
  { const { key, who } = keys(); out.push(read('three authorizations by one account at nonces 0, 0 and 1', who, [await sign(key, 0n), await sign(key, 0n, PROBE2), await sign(key, 1n, PROBE2)])); }
  { const { key, who } = keys(); out.push(read('clearing a delegation (to address 0)', who, [await sign(key, 2n, ZERO)], { state: { [who]: { nonce: '0x2', code: `0xef0100${PROBE.slice(2)}` } } })); }
  { const { key, who } = keys(); out.push(read('clearing, by an account with no delegation', who, [await sign(key, 0n, ZERO)])); }
  { const { key, who } = keys(); out.push(read('an authorization by an account with code', who, [await sign(key, 1n)], { state: { [who]: { nonce: '0x1', code: '0x6001600155' } } })); }
  { const { key, who } = keys(); out.push(read('an authorization at nonce 2^64 - 1', who, [await sign(key, (1n << 64n) - 1n)], { state: { [who]: { nonce: `0x${((1n << 64n) - 1n).toString(16)}` } } })); }
  { const { key, who } = keys(); out.push(read('re-delegating an account delegated already', who, [await sign(key, 5n, PROBE2)], { state: { [who]: { nonce: '0x5', code: `0xef0100${PROBE.slice(2)}` } } })); }
  { const { key, who } = keys(); out.push(read('an authorization to a precompile', who, [await sign(key, 0n, a(4))])); }
  { const { key, who } = keys(); out.push(read('an authorization to a delegated account', who, [await sign(key, 0n, HOP)])); }
  { const { key, who } = keys(); out.push(read('an authorization to the authority itself', who, [await sign(key, 0n, who)])); }
  { const { key, who } = keys(); out.push(read('an authorization by the sender at its nonce + 1', who, [await sign(key, 1n)], { from: who })); }
  { const { key, who } = keys(); out.push(read('an authorization by the sender at its nonce before the transaction', who, [await sign(key, 0n)], { from: who })); }
  { const { key, who } = keys(); out.push(read('two authorizations by the sender at its nonce + 1 and + 2', who, [await sign(key, 1n), await sign(key, 2n, PROBE2)], { from: who })); }
  { const { key, who } = keys(); out.push({ label: 'EIP-7702: a transaction straight to the authority it delegates', to: who, authorizationList: [await sign(key, 0n)], state: shared }); }
  { const { key, who } = keys(); out.push({ label: 'EIP-7702: a transaction by the authority to itself, delegated in it', from: who, to: who, authorizationList: [await sign(key, 1n)], state: shared }); }
  // A delegated account upgrading itself to another delegate and calling itself, as a wallet does.
  { const { key, who } = keys(); out.push({ label: 'EIP-7702: a delegated account re-delegating itself and calling itself', from: who, to: who, authorizationList: [await sign(key, 4n, PROBE2)], state: { ...shared, [who]: { nonce: '0x3', code: `0xef0100${PROBE.slice(2)}` } } }); }
  { const { key, who } = keys(); out.push({ label: 'EIP-7702: an authorization at the wrong nonce still warms its authority', code: warmth, data: `0x${word(BigInt(who))}`, authorizationList: [await sign(key, 3n)], state: shared }); }
  { const { key, who } = keys(); out.push({ label: "EIP-7702: one for another chain's id doesn't warm its authority", code: warmth, data: `0x${word(BigInt(who))}`, authorizationList: [await sign(key, 0n, PROBE, chainId + 1)], state: shared }); }
  { const { key } = keys(); out.push({ label: "EIP-7702: an authorization doesn't warm its delegate", code: warmth, data: `0x${word(BigInt(PROBE2))}`, authorizationList: [await sign(key, 0n, PROBE2)], state: shared }); }
  { const { key, who } = keys(); out.push({ label: 'EIP-7702: an existing account\'s refund, on a call that grows memory by 92,160 gas', code: asm('01 030000 MSTORE STOP'), authorizationList: [await sign(key, 0n)], state: { ...shared, [who]: { balance: '0x1' } } }); }
  { const { key, who } = keys(); out.push({ label: "EIP-7702: an existing account's refund and a cleared slot's together", code: asm('2a 07 SSTORE 00 07 SSTORE 01 8000 MSTORE STOP'), authorizationList: [await sign(key, 0n)], state: { ...shared, [who]: { balance: '0x1' } } }); }
  { const five = [keys(), keys(), keys(), keys(), keys()]; out.push({ label: 'EIP-7702: five authorizations, by three new accounts and two that exist', code: asm('01 030000 MSTORE STOP'), authorizationList: await Promise.all(five.map(k => sign(k.key, 0n))), state: { ...shared, [five[0].who]: { balance: '0x1' }, [five[1].who]: { nonce: '0x0', balance: '0x5' } } }); }
  { const { key, who } = keys(); out.push(read('an authorization in a transaction whose access list names its authority and delegate', who, [await sign(key, 0n)], { accessList: [{ address: who, storageKeys: [] }, { address: PROBE, storageKeys: [] }] })); }
  // A delegation cleared in one transaction and set again in the next: the account's storage (slot 7, 5) stays through both.
  // (Not in one list: under Amsterdam the local EVM pays for the second delegation's bytes, which the chain doesn't.)
  { const { key, who } = keys(); out.push({ label: 'EIP-7702: clearing a delegation', first: true, to: who, authorizationList: [await sign(key, 1n, ZERO)], state: { ...shared, [who]: { nonce: '0x1', code: `0xef0100${STORER.slice(2)}`, stateDiff: { [`0x${word(7)}`]: `0x${word(5)}` } } } },
    { label: 'EIP-7702: delegating again in the next transaction keeps the storage', code: asm(`20 00 00 00 00 ${who.slice(2)} GAS CALL POP 00 MLOAD 00 MSTORE 20 00 RETURN`), authorizationList: [await sign(key, 2n, STORER)], state: shared }); }
  // An authority new in this transaction whose delegate destroys itself: not a contract created in it (EIP-6780), so it keeps its code.
  { const { key, who } = keys(); out.push({ label: 'EIP-7702: a new authority whose delegate destroys itself in the same transaction', code: sendAndRead, data: `0x${word(BigInt(who))}`, balance: 10n, authorizationList: [await sign(key, 0n, DESTROYER)], state: shared }); }
  // Under Amsterdam a delegation's 23 bytes are paid for as new state, once, against the account as the transaction found it.
  { const { key, who } = keys(); out.push(read('delegating, then clearing in the same list', who, [await sign(key, 0n), await sign(key, 1n, ZERO)])); }
  { const { key, who } = keys(); out.push(read('an account delegated already, re-delegated and then cleared', who, [await sign(key, 1n, PROBE2), await sign(key, 2n, ZERO)], { state: { [who]: { nonce: '0x1', code: `0xef0100${PROBE.slice(2)}` } } })); }
  { const { key, who } = keys(); out.push({ label: "EIP-7702: an existing account's refund, on a call that reverts", code: asm('01 030000 MSTORE 00 00 REVERT'), authorizationList: [await sign(key, 0n)], state: { ...shared, [who]: { balance: '0x1' } } }); }
  // A transaction whose call fails keeps its authorizations; the next transaction in the block reads what they left.
  { const { key, who } = keys(); out.push({ label: 'EIP-7702: an authorization in a transaction whose call fails', first: true, code: asm('00 00 REVERT'), authorizationList: [await sign(key, 0n)], state: shared },
    { label: 'EIP-7702: the authority of a failed transaction, read in the next', code: reader, data: `0x${word(BigInt(who))}`, state: shared }); }
  // What one transaction warms (an authority, and what its access list names) is cold again in the next.
  { const { key, who } = keys(); out.push({ label: 'EIP-7702: an authority warmed by an authorization at the wrong nonce', first: true, code: warmth, data: `0x${word(BigInt(who))}`, authorizationList: [await sign(key, 3n)], state: shared },
    { label: 'EIP-7702: that authority, cold again in the next transaction', code: warmth, data: `0x${word(BigInt(who))}`, state: shared }); }
  { const LISTED = a(0xbeef793); out.push({ label: 'an access list naming an account', first: true, code: warmth, data: `0x${word(BigInt(LISTED))}`, accessList: [{ address: LISTED, storageKeys: [] }] },
    { label: 'the account an access list named, cold again in the next transaction', code: warmth, data: `0x${word(BigInt(LISTED))}` }); }
  // A parity of 2 last, in a block of its own: a node behind a public RPC may refuse the whole request for it
  // ("'yParity' field must be 0 or 1": one of Sepolia's did, once in three runs); the others skip it, as the local EVM does.
  { const { key, who } = keys(); const s = await sign(key, 0n); out.push(read('an authorization with a parity of 2, which the chain skips', who, [{ ...s, yParity: '0x2' }], { first: true })); }
  return out;
}

/**
 * Random programs, the same for a seed: what storage, calls and gas do together, in shapes nobody thought to write.
 * Each is a contract and three helpers, every one a short run of steps: a slot set (to 0, 1 or 2) or read,
 * transient storage, memory grown, an event, a call, delegate call or static call to a helper further down (with
 * all the gas or a set amount), a wei sent to an account that doesn't exist or to a precompile, a creation (plain,
 * with a constructor that writes, or colliding), a call into a delegated account, a read past the end of what was
 * returned, a hash. Helpers end by stopping, reverting, failing, destroying themselves or returning; the contract
 * returns its three slots. Some accounts hold a slot
 * beforehand, and the gas limit is one of several, tight ones among them. (None over the cap on ordinary gas: a
 * node's simulation is no guide to the chain there, see OVER_THE_CAP.)
 * The rules that differ between forks live here: what a slot costs set, changed, cleared and cleared again, across
 * calls that succeed or fail (Amsterdam's state gas above all, where the first rule written from four programs
 * needed a second look).
 */
function fuzzPrograms(count: number, seed: number): Program[] {
  // mulberry32: small, and the same everywhere.
  let state = seed >>> 0;
  const rand = () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
  const out: Program[] = [];
  for (let k = 0; k < count; k++) {
    const address = (i: number) => (0xf0220000 + k * 8 + i).toString(16).padStart(40, '0');
    const helpers = [1, 2, 3].map(address), delegated = address(4);
    const fresh = () => (0xf0990000 + Math.floor(rand() * 0xffff)).toString(16).padStart(40, '0');
    // Steps of a contract at `level` (0: the program itself), which may call helpers from that level down.
    const steps = (level: number): string => {
      const parts: string[] = [];
      for (let j = 2 + Math.floor(rand() * 6); j > 0; j--) {
        const r = rand();
        if (r < 0.28) parts.push(`${pick(['00', '00', '01', '02'])} ${pick(['01', '02', '03'])} SSTORE`);
        else if (r < 0.36) parts.push(`${pick(['01', '02', '03'])} SLOAD POP`);
        else if (r < 0.42) parts.push(`${pick(['00', '01'])} ${pick(['01', '02'])} TSTORE`);
        else if (r < 0.50) parts.push(`01 ${pick(['1000', '8000', '030000'])} MSTORE`);
        else if (r < 0.55) parts.push('2a 00 MSTORE 01 20 00 LOG1');
        else if (r < 0.80 && level < 3) {
          const target = helpers[level + Math.floor(rand() * (3 - level))], gas = pick(['GAS', 'GAS', '7530', '0186a0', '01d4c0']);
          const kind = pick(['CALL', 'CALL', 'CALL', 'DELEGATECALL', 'STATICCALL']);
          parts.push(kind === 'CALL' ? `00 00 00 00 ${pick(['00', '00', '01'])} ${target} ${gas} CALL POP` : `00 00 00 00 ${target} ${gas} ${kind} POP`);
        } else if (r < 0.86) parts.push(`00 00 00 00 01 ${fresh()} GAS CALL POP`);
        else if (r < 0.88) parts.push(`${fresh()} ${pick(['BALANCE', 'EXTCODESIZE', 'EXTCODEHASH'])} POP`);
        // Creations: ten bytes of code; a constructor that sets a slot first (the new account's own storage), with a
        // wei; CREATE2 with one salt, which collides the second time it runs.
        else if (r < 0.91) parts.push('600a6000f3 d8 SHL 00 MSTORE 05 00 00 CREATE POP');
        else if (r < 0.93) parts.push(`6001600155600a6000f3 b0 SHL 00 MSTORE 0a 00 ${pick(['00', '01'])} CREATE POP`);
        else if (r < 0.945) parts.push('600a6000f3 d8 SHL 00 MSTORE 07 05 00 00 CREATE2 POP');
        // A wei to a precompile; a call into an account that is delegated (EIP-7702) to the first helper.
        else if (r < 0.96) parts.push(`00 00 00 00 ${pick(['00', '01'])} ${pick(['01', '04', '09'])} GAS CALL POP`);
        else if (r < 0.975) parts.push(`00 00 00 00 00 ${delegated} ${pick(['GAS', '0186a0'])} CALL POP`);
        // Reading past the end of what the last call returned: the call fails outright.
        else if (r < 0.985) parts.push('20 RETURNDATASIZE 00 RETURNDATACOPY');
        else parts.push('2a 00 MSTORE 20 00 KECCAK256 POP');
      }
      return parts.join(' ');
    };
    const ending = () => { const r = rand(); return r < 0.66 ? 'STOP' : r < 0.86 ? '00 00 REVERT' : r < 0.91 ? 'INVALID' : r < 0.95 ? `${pick(['CALLER', fresh()])} SELFDESTRUCT` : '2a 00 MSTORE 20 00 RETURN'; };
    const held = (): Record<string, string> | undefined => (rand() < 0.4 ? { [`0x${word(pick([1, 2, 3]))}`]: `0x${word(5)}` } : undefined);
    const code = asm(`${steps(0)} 01 SLOAD 00 MSTORE 02 SLOAD 20 MSTORE 03 SLOAD 40 MSTORE 60 00 RETURN`);
    const helperCode = [1, 2, 3].map(level => asm(`${steps(level)} ${ending()}`));
    const state: StateChanges = Object.fromEntries(helpers.map((h, i) => { const slots = held(); return [`0x${h}`, { code: helperCode[i], balance: '0x64', ...(slots && { stateDiff: slots }) }]; }));
    state[`0x${delegated}`] = { code: `0xef0100${helpers[0]}`, balance: '0x64' };
    const storage = held(), gas = pick([undefined, undefined, 60_000n, 100_000n, 150_000n, 250_000n, 400_000n, 2_000_000n, 16_000_000n]);
    out.push({ random: true, label: `random program ${seed}/${k}`, to: `0x${address(0)}`, code, balance: 100n, state, ...(storage && { storage }), ...(gas !== undefined && { gas }),
      detail: `--seed ${seed}: gas ${gas ?? GAS}; code ${code}; helpers ${helperCode.join(' ')}; held ${JSON.stringify(storage ?? {})} ${JSON.stringify(Object.fromEntries(Object.entries(state).map(([a, v]) => [a.slice(-2), v.stateDiff ?? {}])))}` });
  }
  return out;
}

/** Every opcode by name, for the programs below (a bare hex literal is still a PUSH of it). */
const OPCODE: Record<string, number> = {
  STOP: 0x00, ADD: 0x01, MUL: 0x02, SUB: 0x03, DIV: 0x04, SDIV: 0x05, MOD: 0x06, SMOD: 0x07, ADDMOD: 0x08, MULMOD: 0x09, EXP: 0x0a, SIGNEXTEND: 0x0b,
  LT: 0x10, GT: 0x11, SLT: 0x12, SGT: 0x13, EQ: 0x14, ISZERO: 0x15, AND: 0x16, OR: 0x17, XOR: 0x18, NOT: 0x19, BYTE: 0x1a, SHL: 0x1b, SHR: 0x1c, SAR: 0x1d, CLZ: 0x1e,
  KECCAK256: 0x20, ADDRESS: 0x30, BALANCE: 0x31, ORIGIN: 0x32, CALLER: 0x33, CALLVALUE: 0x34, CALLDATALOAD: 0x35, CALLDATASIZE: 0x36, CALLDATACOPY: 0x37,
  CODESIZE: 0x38, CODECOPY: 0x39, GASPRICE: 0x3a, EXTCODESIZE: 0x3b, EXTCODECOPY: 0x3c, RETURNDATASIZE: 0x3d, RETURNDATACOPY: 0x3e, EXTCODEHASH: 0x3f,
  BLOCKHASH: 0x40, COINBASE: 0x41, TIMESTAMP: 0x42, NUMBER: 0x43, PREVRANDAO: 0x44, GASLIMIT: 0x45, CHAINID: 0x46, SELFBALANCE: 0x47, BASEFEE: 0x48,
  POP: 0x50, MLOAD: 0x51, MSTORE: 0x52, MSTORE8: 0x53, SLOAD: 0x54, SSTORE: 0x55, JUMP: 0x56, JUMPI: 0x57, PC: 0x58, MSIZE: 0x59, GAS: 0x5a, JUMPDEST: 0x5b,
  TLOAD: 0x5c, TSTORE: 0x5d, MCOPY: 0x5e, PUSH0: 0x5f,
  ...Object.fromEntries(Array.from({ length: 16 }, (_, i) => [[`DUP${i + 1}`, 0x80 + i], [`SWAP${i + 1}`, 0x90 + i]]).flat()),
  LOG0: 0xa0, LOG1: 0xa1, LOG2: 0xa2, LOG3: 0xa3, LOG4: 0xa4,
  CREATE: 0xf0, CALL: 0xf1, CALLCODE: 0xf2, RETURN: 0xf3, DELEGATECALL: 0xf4, CREATE2: 0xf5, STATICCALL: 0xfa, REVERT: 0xfd, INVALID: 0xfe, SELFDESTRUCT: 0xff,
};
/**
 * An assembler with labels: `@name` is a JUMPDEST named so, `:name` a PUSH2 of where it is, `#hex` bytes as they are
 * (push data cut short, a byte that reads as an opcode only to a wrong analysis), a name an opcode, any other hex a
 * PUSH of it.
 */
const assemble = (source: string): Hex => {
  const tokens = source.trim().split(/\s+/);
  const size = (t: string) => (t.startsWith('@') ? 1 : t.startsWith(':') ? 3 : t.startsWith('#') ? (t.length - 1) / 2 : t in OPCODE ? 1 : 1 + t.length / 2);
  const labels: Record<string, number> = {};
  let at = 0;
  for (const t of tokens) { if (t.startsWith('@')) labels[t.slice(1)] = at; at += size(t); }
  return `0x${tokens.map(t => {
    if (t.startsWith('@')) return '5b';
    if (t.startsWith(':')) { if (labels[t.slice(1)] === undefined) throw new Error(`assemble: no label ${t}`); return `61${labels[t.slice(1)].toString(16).padStart(4, '0')}`; }
    if (t.startsWith('#')) { if (!/^#([0-9a-f]{2})+$/.test(t)) throw new Error(`assemble: ${t}`); return t.slice(1); }
    if (t in OPCODE) return hex2(OPCODE[t]);
    if (!/^([0-9a-f]{2})+$/.test(t) || t.length > 64) throw new Error(`assemble: ${t}`);
    return `${(0x5f + t.length / 2).toString(16)}${t}`;
  }).join('')}`;
};

/**
 * Opcodes in combination, which one opcode after seventeen pushes can't reach: arithmetic at its edges (shifts of
 * 256 and more, SIGNEXTEND and BYTE past the word, a modulus of 0, -2^255 / -1, EXP's price by the exponent's
 * length, CLZ of 0, PUSH0); the stack's 1,024 items and recursion as deep as the gas goes; jumps into push data
 * (cut short at the code's end too) and to destinations over 2^32; memory touched at 2^256-1 with nothing to copy
 * (no expansion), memory too large to pay for, MCOPY over itself both ways, the size memory grows to; reads past
 * the end of calldata, code and return data (RETURNDATACOPY past it halts); what each kind of call leaves as return
 * data and in its return area; transient storage across frames of one contract, in calls that revert or run out,
 * by DELEGATECALL and CALLCODE (the caller's), in a static call and in a constructor; each write in a static
 * context; what a call costs, read with GAS around it, and what is charged before its 63/64; SSTORE's price for each
 * original, current and new value, and its 2,300-gas floor; the price of copies, hashes and events by length;
 * creations that fail (code starting 0xEF, too little gas for the deposit, more value than the balance, an address
 * taken, the nonce limit), the limits on code and initcode, and what a constructor sees; SELFDESTRUCT of an account
 * made before the transaction and of one made in it, by DELEGATECALL and CALLCODE and in a constructor; whether an
 * account exists after a call touched it or a transfer to it was undone; which accounts are warm from the start;
 * the precompiles by DELEGATECALL, CALLCODE and CALL with value; EIP-7702 delegations as code reads them; events
 * across frames; and, between the calls of one block, transient storage, warm accounts, a slot's original value and
 * a creator's nonce, each the next transaction's own. Each program returns what it read, so a difference names it.
 */
function combinationPrograms(chainId: number, amsterdam: boolean): Program[] {
  const profile = CHAIN_PROFILES[chainId];
  const cancun = profile?.hardfork === 'cancun';
  // HyperEVM's node has eth_call only: each program runs alone there, so what one transaction leaves for the next in
  // a block can't be compared.
  const blockwise = chainId !== 999;
  const MAX = 'ff'.repeat(32), MIN = `80${'00'.repeat(31)}`, P64 = `01${'00'.repeat(8)}`, P32 = '0100000000';
  const neg = (n: bigint) => ((1n << 256n) - n).toString(16).padStart(64, '0');
  const h = (n: number | bigint) => { const s = BigInt(n).toString(16); return s.length % 2 ? `0${s}` : s; };
  const PATTERN1 = Array.from({ length: 32 }, (_, i) => hex2(i + 1)).join(''), PATTERN2 = Array.from({ length: 32 }, (_, i) => hex2(i + 0x21)).join('');
  /** Each expression's value (one stack item) stored a word apart from 0, then all returned. */
  const ret = (items: string[]) => `${items.map((e, i) => `${e} ${h(i * 32)} MSTORE`).join(' ')} ${h(items.length * 32)} 00 RETURN`;
  /** The same, stored from 0x1000: for expressions that write low memory themselves. */
  const retHigh = (items: string[]) => `${items.map((e, i) => `${e} ${h(0x1000 + i * 32)} MSTORE`).join(' ')} ${h(items.length * 32)} 1000 RETURN`;
  /** The gas `code` (which leaves the stack as it found it) costs, with the GAS after it. */
  const gasOf = (code: string) => `GAS ${code} GAS SWAP1 SUB`;
  /** A call's success (high half) and the return data size after it (low half), as one word. */
  const callAndSize = (call: string) => `${call} 80 SHL RETURNDATASIZE OR`;
  /** Initcode in memory from 0 (word by word, left-aligned), then its length pushed. */
  const initcode = (code: Hex) => { const b = code.slice(2); const words = Array.from({ length: Math.ceil(b.length / 64) }, (_, i) => `${b.slice(i * 64, i * 64 + 64).padEnd(64, '0')} ${h(i * 32)} MSTORE`); return `${words.join(' ')} ${h(b.length / 2)}`; };
  let next = 0;
  /** A helper account of its own for each use. */
  const helper = () => (0xc0de9000 + next++).toString(16).padStart(40, '0');
  const NOBODY = '000000000000000000000000000000000beef0a1', NOBODY2 = '000000000000000000000000000000000beef0a2';
  const programs: Program[] = [];
  const add = (label: string, code: string, more: Partial<Program> = {}) => programs.push({ label: `combination: ${label}`, code: assemble(code), ...more });
  /** The identity precompile called with 32 bytes, which it returns: return data to read. */
  const ID32 = `${PATTERN1} 00 MSTORE 20 00 20 00 04 GAS STATICCALL POP`;

  // Arithmetic at its edges.
  add('SHL, SHR and SAR by 255, 256, 257, 2^64, 2^248 and 2^256-1', ret([
    '01 ff SHL', '01 0100 SHL', `${MAX} 0101 SHL`, `${MAX} ${MAX} SHR`, `${MIN} ff SHR`, `${MIN} 0100 SHR`, `${MIN} 0100 SAR`, `${MIN} ${MAX} SAR`,
    `7f${'ff'.repeat(31)} 0100 SAR`, `${MIN} ff SAR`, `${MIN} fe SAR`, `01 ${P64} SHL`, `${MIN} 01${'00'.repeat(31)} SAR`, `${MAX} ${P64} SHR`]));
  add('SIGNEXTEND by bytes 0, 15, 30, 31, 32, 2^64 and 2^256-1', ret([
    `80${'00'.repeat(30)}05 1f SIGNEXTEND`, 'ff 20 SIGNEXTEND', `80 ${MAX} SIGNEXTEND`, '80 00 SIGNEXTEND', '7f 00 SIGNEXTEND', `0080${'00'.repeat(30)} 1e SIGNEXTEND`,
    `ff ${P64} SIGNEXTEND`, `${'12'.repeat(32)} 0f SIGNEXTEND`, `${'92'.repeat(32)} 0f SIGNEXTEND`, `ff${'00'.repeat(30)}80 00 SIGNEXTEND`, `${MAX} 1f SIGNEXTEND`]));
  add('BYTE at indexes 0, 31, 32, 2^64, 2^248 and 2^256-1', ret([`${PATTERN1} 00 BYTE`, `${PATTERN1} 1f BYTE`, `${PATTERN1} 20 BYTE`, `${PATTERN1} ${MAX} BYTE`, `${PATTERN1} ${P64} BYTE`, `${PATTERN1} 01${'00'.repeat(31)} BYTE`, `${PATTERN1} 0f BYTE`]));
  add('ADDMOD and MULMOD with a modulus of 0, and past 2^256', ret([
    `00 ${MAX} ${MAX} ADDMOD`, '00 05 07 MULMOD', `03 02 ${MAX} ADDMOD`, `3039 ${MAX} ${MAX} MULMOD`, `${MAX} ${MAX} ${MAX} ADDMOD`, `${'ff'.repeat(31)}fe ${MAX} ${MAX} MULMOD`,
    `01 ${MAX} ${MAX} ADDMOD`, `${MIN} ${MIN} ${MIN} MULMOD`, `07 ${MAX} 00 ADDMOD`, `${neg(5n)} ${MAX} ${MAX} MULMOD`, `00 00 00 MULMOD`]));
  add('DIV, SDIV, MOD and SMOD by 0, -1 and negatives (-2^255 / -1)', ret([
    '00 2a DIV', '00 2a MOD', '00 2a SDIV', '00 2a SMOD', `${MAX} ${MIN} SDIV`, `${MAX} ${MIN} SMOD`, `03 ${neg(7n)} SMOD`, `${neg(3n)} 07 SMOD`,
    `02 ${neg(7n)} SDIV`, `${neg(2n)} ${neg(7n)} SDIV`, `${MIN} ${MIN} SDIV`, `01 ${MIN} SDIV`, `${MAX} 00 SDIV`, `${MAX} ${MAX} MOD`, `00 ${MIN} SDIV`]));
  {
    // EXP's result and price, by exponent: 0, one byte, two, 32 (2^255 and 2^256-1).
    const cases: [string, string][] = [['00', '02'], ['00', '00'], ['ff', '02'], ['0100', '02'], [MAX, '03'], ['02', MAX], [MIN, '02'], [MAX, '00'], [MAX, '01'], [MAX, MAX], ['02', `01${'00'.repeat(16)}`], [`01${'00'.repeat(15)}`, '07']];
    add('EXP by exponents of 0 to 32 bytes: its result and its price', `${cases.map(([e, b], i) => `GAS ${e} ${b} EXP SWAP1 GAS SWAP1 SUB ${h(i * 64)} MSTORE ${h(i * 64 + 32)} MSTORE`).join(' ')} ${h(cases.length * 64)} 00 RETURN`);
  }
  // (CLZ is Osaka's: on HyperEVM, Cancun's rules, an invalid opcode on both sides.)
  add('CLZ of 0, 1, 2^255, 2^256-1, 0xff and 2^248, and its price', ret(['00 CLZ', '01 CLZ', `${MIN} CLZ`, `${MAX} CLZ`, 'ff CLZ', `01${'00'.repeat(31)} CLZ`, gasOf('00 CLZ POP')]));
  add('PUSH0: its value and its price', ret(['PUSH0', gasOf('PUSH0 POP'), 'PUSH0 PUSH0 EQ', 'PUSH0 NOT']));

  // The stack's limit: 1,024 items.
  const zeros = (n: number) => Array(n).fill('PUSH0').join(' ');
  add('1,024 items on the stack, then RETURN', `${zeros(1022)} 00 00 RETURN`);
  add('1,025 items on the stack (an overflow)', `${zeros(1025)} STOP`);
  add('DUP1 on 1,024 items (an overflow)', `${zeros(1024)} DUP1 STOP`);
  add('DUP16 on 1,023 items', `${zeros(1023)} DUP16 STOP`);
  add('SWAP16 on 1,024 items', `${zeros(1024)} SWAP16 STOP`);
  add('GAS on 1,024 items (an overflow)', `${zeros(1024)} GAS STOP`);
  add('POP of an empty stack', 'POP STOP');
  add('SWAP16 of 16 items (an underflow)', `${zeros(16)} SWAP16 STOP`);
  add('DUP16 of 15 items (an underflow)', `${zeros(15)} DUP16 STOP`);
  {
    const pusher = helper(), overflow = helper();
    add("a frame's stack is its own: 1,000 items, then a call whose callee pushes 1,000", `${zeros(1000)} 20 00 00 00 00 ${pusher} GAS CALL 00 MLOAD SWAP1 ${'20 MSTORE'} 00 MSTORE 40 00 RETURN`,
      { state: { [`0x${pusher}`]: { code: assemble(`${zeros(1000)} 2a 00 MSTORE 20 00 RETURN`) } } });
    add('a stack overflow in a callee: the caller goes on, the call having burnt its gas', ret([gasOf(`00 00 00 00 00 ${overflow} 7530 CALL POP`), `00 00 00 00 00 ${overflow} 7530 CALL`]),
      { state: { [`0x${overflow}`]: { code: assemble(`${zeros(1025)} STOP`) } } });
  }
  {
    // Recursion as deep as 1,000,000 gas goes (a call keeps a 64th of its gas back, so 1,024 is out of reach): the
    // depth reached is what every frame's gas comes to.
    const recursive = (kind: 'CALL' | 'STATICCALL' | 'DELEGATECALL') => assemble(`00 CALLDATALOAD 01 ADD 00 MSTORE 20 00 20 00 ${kind === 'CALL' ? '00 ' : ''}ADDRESS GAS ${kind} :deeper JUMPI 00 CALLDATALOAD 00 MSTORE @deeper 20 00 RETURN`);
    for (const kind of ['CALL', 'STATICCALL', 'DELEGATECALL'] as const) {
      const r = helper();
      add(`${kind}s nested as deep as 1,000,000 gas reaches: the depth`, `20 00 20 00 00 ${r} 0f4240 CALL 20 MSTORE 40 00 RETURN`, { state: { [`0x${r}`]: { code: recursive(kind) } } });
    }
  }

  // Jumps.
  add('JUMP into PUSH1 data that reads 0x5b', '#6006 #56 #00 #00 #605b #00');
  add('JUMP to the JUMPDEST right after PUSH1 data that reads 0x5b', `#6007 #56 #00 #00 #605b #5b ${ret(['01'])}`);
  add('JUMP into a PUSH32 cut short by the end of the code', '#6006 #56 #00 #00 #7f5b5b5b');
  add('JUMP to the last byte of a PUSH2 cut short by the end of the code', '#6006 #56 #00 #00 #615b');
  add('JUMP into PUSH2 data whose first byte reads as PUSH1', '#6008 #56 #00 #00 #00 #61605b #5b #00');
  add('JUMP to the JUMPDEST after PUSH2 data whose first byte reads as PUSH1', `#6009 #56 #00 #00 #00 #61605b #5b ${ret(['01'])}`);
  add('JUMP past the end of the code', '#6064 #56');
  add("JUMP to 2^32 plus a JUMPDEST's offset", `${P32} :ok ADD JUMP INVALID @ok ${ret(['01'])}`);
  add("JUMP to 2^64 plus a JUMPDEST's offset", `${P64} :ok ADD JUMP INVALID @ok ${ret(['01'])}`);
  add("JUMP to 2^255 plus a JUMPDEST's offset", `${MIN} :ok ADD JUMP INVALID @ok ${ret(['01'])}`);
  add('JUMPI not taken, to a destination that is no JUMPDEST', `00 64 JUMPI ${ret(['01'])}`);
  add('JUMPI taken, to a destination that is no JUMPDEST', `01 64 JUMPI ${ret(['01'])}`);
  add('JUMPI taken on a condition with only its top bit set', `${MIN} :ok JUMPI INVALID @ok ${ret(['01'])}`);
  add('JUMPI taken on a condition of 2^64', `${P64} :ok JUMPI INVALID @ok ${ret(['01'])}`);
  add('JUMPI to 2^64 plus a JUMPDEST, not taken', `00 ${P64} :ok ADD JUMPI ${ret(['02'])} @ok ${ret(['01'])}`);
  add('a loop of 500 rounds: the count and its price', ret([gasOf('00 @loop 01 ADD DUP1 01f4 GT :loop JUMPI POP'), '00 @l2 01 ADD DUP1 01f4 GT :l2 JUMPI']));
  add('a loop back to a JUMPDEST at offset 0', `@top 00 MLOAD 01 ADD DUP1 00 MSTORE 03 GT :top JUMPI ${ret(['00 MLOAD'])}`);
  add('PC after a PUSH32 and after a cut-short analysis', ret([`${MAX} POP PC`, 'PC']));
  // Amsterdam's DUPN, SWAPN and EXCHANGE take an immediate that is never 0x5b or a PUSH, so that a JUMPDEST stays
  // where it was: a jump to the 0x5b after DUPN finds it (before Amsterdam 0xe6 is no opcode, and the 0x5b a JUMPDEST
  // either way); DUPN run with it as its immediate halts.
  add('JUMP to a 0x5b right after DUPN (0xe6)', `#6005 #56 #00 #e6 #5b ${ret(['01'])}`);
  add('DUPN with 0x5b as its immediate, run', `${zeros(20)} #e65b ${ret(['01'])}`);
  add('JUMP to a 0x5b after DUPN and 0x60 (PUSH1 data to the analysis)', '#6006 #56 #00 #e6 #60 #5b #00');

  // Memory with nothing to copy, at offsets no memory could reach: nothing grows, nothing is charged for it.
  add('size-0 KECCAK256, copies, MCOPY, EXTCODECOPY and LOG0 at offset 2^256-1: no memory, and their price',
    `GAS 00 ${MAX} KECCAK256 POP 00 00 ${MAX} CALLDATACOPY 00 00 ${MAX} CODECOPY 00 00 ${MAX} RETURNDATACOPY 00 ${MAX} ${MAX} MCOPY 00 00 ${MAX} ADDRESS EXTCODECOPY 00 ${MAX} LOG0 GAS SWAP1 SUB MSIZE 00 ${MAX} KECCAK256 ${'40 MSTORE 20 MSTORE 00 MSTORE'} 60 00 RETURN`);
  add('size-0 copies from offset 2^256-1 (calldata, code, memory, another account)', `GAS 00 ${MAX} 00 CALLDATACOPY 00 ${MAX} 00 CODECOPY 00 ${MAX} 00 MCOPY 00 ${MAX} 00 ADDRESS EXTCODECOPY GAS SWAP1 SUB MSIZE ${'20 MSTORE 00 MSTORE'} 40 00 RETURN`);
  add('RETURN of nothing at offset 2^256-1', `00 ${MAX} RETURN`);
  add('REVERT of nothing at offset 2^256-1', `00 ${MAX} REVERT`);
  add('a call with arguments and return area of size 0 at 2^256-1', ret([`00 ${MAX} 00 ${MAX} 00 04 GAS CALL`, 'MSIZE', `00 ${MAX} 00 ${MAX} ${NOBODY} GAS STATICCALL`, 'MSIZE']));
  add('CREATE of nothing at offset 2^256-1', `00 ${MAX} 00 CREATE MSIZE SWAP1 DUP1 EXTCODESIZE DUP2 EXTCODEHASH 60 MSTORE 40 MSTORE 20 MSTORE 00 MSTORE 80 00 RETURN`);
  add('CREATE2 of nothing at offset 2^256-1', `07 00 ${MAX} 00 CREATE2 MSIZE SWAP1 DUP1 EXTCODESIZE 40 MSTORE 20 MSTORE 00 MSTORE 60 00 RETURN`);
  for (const [label, code] of [
    ['MLOAD at 2^32', `${P32} MLOAD`], ['MLOAD at 2^256-1', `${MAX} MLOAD`], ['MSTORE at 2^256-32 (the end past 2^256)', `01 ${'ff'.repeat(31)}e0 MSTORE`], ['MSTORE8 at 2^256-1', `01 ${MAX} MSTORE8`],
    ['KECCAK256 of 2^64 bytes', `${P64} 00 KECCAK256`], ['KECCAK256 of a byte at 2^256-1', `01 ${MAX} KECCAK256`], ['MCOPY of 2^40 bytes', '010000000000 00 00 MCOPY'],
    ['CALLDATACOPY of 2^256-1 bytes', `${MAX} 00 00 CALLDATACOPY`], ['RETURN of 2^32 bytes', `${P32} 00 RETURN`], ['a call with a return area at 2^64', `20 ${P64} 00 00 00 04 GAS CALL`],
    ['LOG0 of 2^256-1 bytes at 1 (the end past 2^256)', `${MAX} 01 LOG0`], ['CODECOPY to 2^32', `20 00 ${P32} CODECOPY`], ['a CREATE of 2^32 bytes of initcode', `${P32} 00 00 CREATE`],
  ] as const) add(`memory no gas can pay for: ${label}`, `${code} STOP`);
  add('memory grown to 128 KiB by one MSTORE: its price', ret([gasOf('01 01ffe0 MSTORE'), 'MSIZE', gasOf('01 01ffe0 MSTORE'), gasOf('01 020000 MSTORE8')]));
  add('the memory size after accesses that end inside a word', `01 20 MSTORE8 MSIZE 21 MLOAD POP MSIZE 01 65 KECCAK256 POP MSIZE 01 00 81 CALLDATACOPY MSIZE 01 00 c1 MCOPY MSIZE 01 00 e1 CODECOPY MSIZE 00 0300 MSTORE8 MSIZE 01 0400 00 00 04 GAS STATICCALL POP MSIZE 00 00 0480 RETURNDATACOPY MSIZE ${Array.from({ length: 9 }, (_, i) => `${h(0x600 + (8 - i) * 32)} MSTORE`).join(' ')} 0120 0600 RETURN`);
  add('MCOPY forward over itself (to 1 from 0, 63 bytes)', `${PATTERN1} 00 MSTORE ${PATTERN2} 20 MSTORE 3f 00 01 MCOPY 40 00 RETURN`);
  add('MCOPY backward over itself (to 0 from 1, 63 bytes)', `${PATTERN1} 00 MSTORE ${PATTERN2} 20 MSTORE 3f 01 00 MCOPY 40 00 RETURN`);
  add('MCOPY forward over itself by 31 bytes, 64 long', `${PATTERN1} 00 MSTORE ${PATTERN2} 20 MSTORE 40 00 1f MCOPY 60 00 RETURN`);
  add('MCOPY from beyond the memory size', `${PATTERN1} 00 MSTORE 20 0100 00 MCOPY MSIZE 20 MSTORE 40 00 RETURN`);
  add('MCOPY to beyond the memory size', `${PATTERN1} 00 MSTORE 20 00 0200 MCOPY MSIZE 20 MSTORE 0200 MLOAD 40 MSTORE 60 00 RETURN`);
  add('MCOPY onto itself, and its price by length', retHigh([gasOf('20 00 00 MCOPY'), gasOf('21 00 00 MCOPY'), gasOf('00 00 00 MCOPY'), gasOf('0100 00 20 MCOPY'), '00 MLOAD']));

  // What a call writes into its return area, and leaves as return data.
  {
    const reverts = helper(), fails = helper();
    const state: StateChanges = { [`0x${reverts}`]: { code: assemble(`${'2a'.repeat(32)} 00 MSTORE 20 00 REVERT`) }, [`0x${fails}`]: { code: assemble(`${'2a'.repeat(32)} 00 MSTORE INVALID`) } };
    add("a return area longer than what is returned: the rest of it is left as it was", `${MAX} 00 MSTORE 2a 40 MSTORE8 20 00 01 40 00 04 GAS CALL POP RETURNDATASIZE 20 MSTORE 40 00 RETURN`);
    add('a call that reverts writes its data into the return area', `${MAX} 00 MSTORE 20 00 00 00 00 ${reverts} GAS CALL RETURNDATASIZE 40 MSTORE 20 MSTORE 60 00 RETURN`, { state });
    add('a call that fails outright leaves the return area as it was', `${MAX} 00 MSTORE 20 00 00 00 00 ${fails} 7530 CALL RETURNDATASIZE 40 MSTORE 20 MSTORE 60 00 RETURN`, { state });
    add('a return area shorter than what is returned', `${MAX} 00 MSTORE ${PATTERN1} 40 MSTORE ${PATTERN2} 60 MSTORE 0a 00 40 40 00 04 GAS CALL POP RETURNDATASIZE 20 MSTORE 40 00 RETURN`);
    add('a precompile call that fails leaves the return area as it was (bn254 add of a point off the curve)', `${MAX} 00 MSTORE 01 40 MSTORE 01 60 MSTORE 40 00 80 40 06 7530 STATICCALL RETURNDATASIZE 40 MSTORE 20 MSTORE 60 00 RETURN`);
  }
  {
    const stops = helper(), reverts7 = helper(), fails = helper(), writes = helper(), readsSize = helper();
    const state: StateChanges = {
      [`0x${stops}`]: { code: assemble('STOP') }, [`0x${reverts7}`]: { code: assemble('07 00 REVERT') }, [`0x${fails}`]: { code: assemble('INVALID') },
      [`0x${writes}`]: { code: assemble('01 01 SSTORE STOP') }, [`0x${readsSize}`]: { code: assemble('RETURNDATASIZE 00 MSTORE 20 00 RETURN') },
    };
    add('RETURNDATASIZE after calls to accounts with no code, that stop, revert and fail', retHigh([
      ID32 + ' RETURNDATASIZE', callAndSize(`${ID32} 00 00 00 00 00 ${NOBODY} GAS CALL`), callAndSize(`${ID32} 00 00 00 00 00 ${stops} GAS CALL`), callAndSize(`${ID32} 00 00 00 00 00 ${reverts7} GAS CALL`),
      callAndSize(`${ID32} 00 00 00 00 00 ${fails} 7530 CALL`), callAndSize(`${ID32} 00 00 00 00 ${NOBODY} GAS DELEGATECALL`), callAndSize(`${ID32} 00 00 00 00 ${writes} 7530 STATICCALL`),
      `${ID32} 01 02 ADD POP RETURNDATASIZE`, `${ID32} 20 00 00 00 00 ${readsSize} GAS CALL POP 00 MLOAD`]), { state, balance: 10n });
    add('RETURNDATASIZE after a call with more value than the balance', retHigh([callAndSize(`${ID32} 00 00 00 00 ${'ffff'} ${NOBODY} GAS CALL`), callAndSize(`${ID32} 00 00 00 00 ${'ffff'} ${stops} GAS CALLCODE`)]), { state, balance: 10n });
    add('RETURNDATASIZE after precompile calls (ecrecover of nothing, sha256, ripemd160, identity of nothing, modexp of a 5-byte modulus)', retHigh([
      callAndSize(`${ID32} 00 00 00 00 01 GAS STATICCALL`), callAndSize('00 00 00 00 02 GAS STATICCALL'), callAndSize('00 00 00 00 03 GAS STATICCALL'), callAndSize(`${ID32} 00 00 00 00 04 GAS STATICCALL`),
      callAndSize(`00 00 MSTORE 00 20 MSTORE 05 40 MSTORE 00 00 60 00 05 GAS STATICCALL`), callAndSize(`${ID32} 00 00 MSTORE 00 20 MSTORE 00 40 MSTORE 00 00 60 00 05 GAS STATICCALL`),
      callAndSize(`${ID32} 00 00 20 00 01 GAS STATICCALL`), callAndSize(`${ID32} 00 00 00 00 02 0a STATICCALL`)]));
    add('RETURNDATASIZE after precompile calls that fail (bn254 add off the curve, blake2f of nothing, point evaluation of nothing, P-256 of garbage)', retHigh([
      callAndSize(`${ID32} 01 00 MSTORE 01 20 MSTORE 00 00 80 00 06 7530 STATICCALL`), callAndSize(`${ID32} 00 00 00 00 09 7530 STATICCALL`), callAndSize(`${ID32} 00 00 00 00 0a 7530 STATICCALL`),
      callAndSize(`${ID32} 00 00 a0 00 0100 7530 STATICCALL`), callAndSize(`${ID32} 00 00 00 00 08 0186a0 STATICCALL`), callAndSize(`${ID32} 00 00 21 00 08 7530 STATICCALL`)]));
    add('RETURNDATASIZE after CREATEs that succeed and revert', retHigh([
      `${ID32} 00 00 00 CREATE POP RETURNDATASIZE`, `${ID32} ${initcode(assemble('deadbeef 00 MSTORE 04 1c REVERT'))} 00 00 CREATE POP RETURNDATASIZE`, '00 MLOAD',
      `${ID32} 00 00 ${'ffff'} CREATE RETURNDATASIZE SWAP1 80 SHL OR`, `${ID32} ${initcode(assemble('INVALID'))} 00 00 CREATE POP RETURNDATASIZE`]), { balance: 10n, burns: true });
    add('RETURNDATASIZE at the start of a call, after the caller had some', `${ID32} 20 00 00 00 00 ${readsSize} GAS CALL POP 00 MLOAD 00 MSTORE RETURNDATASIZE 20 MSTORE 40 00 RETURN`, { state });
  }
  // RETURNDATACOPY past the end of the return data halts the frame.
  add('RETURNDATACOPY of nothing with no call before', `00 00 00 RETURNDATACOPY ${ret(['01'])}`);
  add('RETURNDATACOPY of nothing from offset 1 with no call before', `00 01 00 RETURNDATACOPY ${ret(['01'])}`);
  add('RETURNDATACOPY of 33 bytes after 32 returned', `${ID32} 21 00 00 RETURNDATACOPY ${ret(['01'])}`);
  add('RETURNDATACOPY of nothing from offset 32 after 32 returned', `${ID32} 00 20 00 RETURNDATACOPY ${ret(['01'])}`);
  add('RETURNDATACOPY of nothing from offset 33 after 32 returned', `${ID32} 00 21 00 RETURNDATACOPY ${ret(['01'])}`);
  add('RETURNDATACOPY of 2 bytes from offset 2^256-1 after 32 returned', `${ID32} 02 ${MAX} 00 RETURNDATACOPY ${ret(['01'])}`);
  add('RETURNDATACOPY of nothing from offset 2^64 after 32 returned', `${ID32} 00 ${P64} 00 RETURNDATACOPY ${ret(['01'])}`);
  add('RETURNDATACOPY of nothing to memory at 2^256-1 after 32 returned', `${ID32} 00 00 ${MAX} RETURNDATACOPY ${ret(['MSIZE'])}`);
  add('RETURNDATACOPY of the last byte of 32 returned', `${ID32} 01 1f 00 RETURNDATACOPY ${ret(['00 MLOAD'])}`);
  {
    const oob = helper(), reverts4 = helper();
    const state: StateChanges = { [`0x${oob}`]: { code: assemble('00 01 00 RETURNDATACOPY STOP') }, [`0x${reverts4}`]: { code: assemble('deadbeef 00 MSTORE 04 1c REVERT') } };
    add('RETURNDATACOPY past the end in a callee: the caller goes on, the call having burnt its gas', ret([gasOf(`00 00 00 00 00 ${oob} 7530 CALL POP`), `00 00 00 00 00 ${oob} 7530 CALL`]), { state });
    add("RETURNDATACOPY of exactly a reverted call's data, then one byte more", `00 00 00 00 00 ${reverts4} GAS CALL POP 04 00 00 RETURNDATACOPY 00 MLOAD 20 MSTORE 05 00 00 RETURNDATACOPY ${ret(['01'])}`, { state });
    add("RETURNDATACOPY of exactly a reverted call's data", `00 00 00 00 00 ${reverts4} GAS CALL POP 04 00 00 RETURNDATACOPY ${ret(['00 MLOAD', 'RETURNDATASIZE'])}`, { state });
  }

  // Reads past the end of calldata and code.
  add('CALLDATALOAD past the end of 5 bytes of calldata, and at 2^64 and 2^256-4', ret(['00 CALLDATALOAD', '03 CALLDATALOAD', '04 CALLDATALOAD', '05 CALLDATALOAD', `${MAX} CALLDATALOAD`, `${P64} CALLDATALOAD`, `${'ff'.repeat(31)}fc CALLDATALOAD`, 'CALLDATASIZE']), { data: '0x1122334455' });
  add('CALLDATACOPY past the end of 5 bytes of calldata, and from 2^256-1 and 2^64', `${MAX} 00 MSTORE ${MAX} 20 MSTORE ${MAX} 40 MSTORE ${MAX} 60 MSTORE 40 03 00 CALLDATACOPY 20 ${MAX} 40 CALLDATACOPY 01 ${P64} 60 CALLDATACOPY 80 00 RETURN`, { data: '0x1122334455' });
  add('CALLDATALOAD and CALLDATACOPY with no calldata', `${MAX} 20 MSTORE 20 00 20 CALLDATACOPY ${'00 CALLDATALOAD 00 MSTORE'} 40 00 RETURN`);
  add('CODECOPY past the end of the code, and from 2^256-1', `${MAX} 00 MSTORE ${MAX} 20 MSTORE 20 02 CODESIZE SUB 00 CODECOPY 20 ${MAX} 20 CODECOPY 40 00 RETURN`);
  {
    const five = helper();
    add('EXTCODECOPY of an account that does not exist, and past the end of one that does, and their price', `${MAX} 00 MSTORE ${MAX} 20 MSTORE GAS 20 00 00 ${NOBODY} EXTCODECOPY 20 03 20 ${five} EXTCODECOPY 20 03 20 ${five} EXTCODECOPY GAS SWAP1 SUB 40 MSTORE 60 00 RETURN`,
      { state: { [`0x${five}`]: { code: '0x6001600201' } } });
  }

  // Transient storage (EIP-1153).
  add('TLOAD in a call back into the same contract sees its TSTORE', `CALLDATASIZE :read JUMPI 2a 01 TSTORE 20 00 01 00 00 ADDRESS GAS CALL 20 MSTORE 40 00 RETURN @read 01 TLOAD 00 MSTORE 20 00 RETURN`);
  {
    // A contract that does what its first byte of calldata says: none, its program; 01, sets slot 1 to 9 and reverts;
    // 02, returns slot 1; 03, sets slot 1 to 9 and stops.
    const modes = (main: string) => `CALLDATASIZE ISZERO :main JUMPI 00 CALLDATALOAD f8 SHR DUP1 01 EQ :undo JUMPI DUP1 03 EQ :set JUMPI 01 TLOAD 00 MSTORE 20 00 RETURN @undo 09 01 TSTORE 00 00 REVERT @set 09 01 TSTORE STOP @main ${main}`;
    add('a TSTORE in a call back into the contract that reverts is undone, back to the value before', modes(`05 01 TSTORE 01 00 MSTORE8 00 00 01 00 00 ADDRESS GAS CALL 01 TLOAD 02 00 MSTORE8 20 20 01 00 00 ADDRESS GAS CALL 20 MLOAD 60 MSTORE 40 MSTORE 20 MSTORE 00 MSTORE 80 00 RETURN`));
    add('a TSTORE in a call back into the contract that stops is kept', modes(`05 01 TSTORE 03 00 MSTORE8 00 00 01 00 00 ADDRESS GAS CALL 01 TLOAD 20 MSTORE 00 MSTORE 40 00 RETURN`));
    add('in a static call back into the contract: TSTORE fails (burning the gas given), TLOAD reads', modes(`05 01 TSTORE 01 00 MSTORE8 GAS 00 00 01 00 ADDRESS 7530 STATICCALL SWAP1 GAS SWAP1 SUB 02 00 MSTORE8 20 20 01 00 ADDRESS GAS STATICCALL 20 MLOAD 01 TLOAD 80 MSTORE 60 MSTORE 40 MSTORE 20 MSTORE 00 MSTORE a0 00 RETURN`));
  }
  {
    const y = helper(), t = helper();
    const state: StateChanges = {
      [`0x${t}`]: { code: assemble('CALLDATASIZE :read JUMPI 07 01 TSTORE STOP @read 01 TLOAD 00 MSTORE 20 00 RETURN') },
      [`0x${y}`]: { code: assemble(`00 00 00 00 00 ${t} GAS CALL POP 00 00 REVERT`) },
    };
    add('a TSTORE by a call whose caller then reverts is undone', `00 00 00 00 00 ${y} GAS CALL 20 00 01 00 00 ${t} GAS CALL 00 MLOAD 40 MSTORE 20 MSTORE 00 MSTORE 60 00 RETURN`, { state });
  }
  {
    const loops = helper();
    add('a TSTORE in a call that then runs out of gas is undone', `00 00 00 00 00 ${loops} 7530 CALL 20 00 01 00 00 ${loops} GAS CALL 00 MLOAD 40 MSTORE 20 MSTORE 00 MSTORE 60 00 RETURN`,
      { state: { [`0x${loops}`]: { code: assemble('CALLDATASIZE :read JUMPI 07 01 TSTORE @loop :loop JUMP @read 01 TLOAD 00 MSTORE 20 00 RETURN') } } });
  }
  {
    // A helper that, run as another's code, reads slot 1 and writes slots 1 and 2; called with calldata, reads its own.
    const code = assemble('CALLDATASIZE :own JUMPI 01 TLOAD 00 MSTORE 2a 01 TSTORE 2b 02 TSTORE 20 00 RETURN @own 01 TLOAD 00 MSTORE 20 00 RETURN');
    for (const kind of ['DELEGATECALL', 'CALLCODE'] as const) {
      const d = helper();
      add(`${kind}: the callee reads and writes the caller's transient storage, not its own`, `03 01 TSTORE 20 00 00 00 ${kind === 'CALLCODE' ? '00 ' : ''}${d} GAS ${kind} 00 MLOAD 01 TLOAD 02 TLOAD 20 00 01 00 00 ${d} GAS CALL 00 MLOAD ${Array.from({ length: 6 }, (_, i) => `${h((5 - i) * 32)} MSTORE`).join(' ')} c0 00 RETURN`, { state: { [`0x${d}`]: { code } } });
    }
    const back = helper();
    add("a DELEGATECALL's callee sets transient storage and calls back: the caller's frame reads it", `CALLDATASIZE :read JUMPI 20 00 00 00 ${back} GAS DELEGATECALL 00 MLOAD 01 TLOAD ${'40 MSTORE 20 MSTORE 00 MSTORE'} 60 00 RETURN @read 01 TLOAD 00 MSTORE 20 00 RETURN`,
      { state: { [`0x${back}`]: { code: assemble('77 01 TSTORE 20 00 01 00 00 ADDRESS GAS CALL POP 20 00 RETURN') } } });
  }
  add('TSTORE and TLOAD: their price, a slot never set, and storage untouched', ret([gasOf('2a 01 TSTORE'), gasOf('01 TLOAD POP'), gasOf('2b 01 TSTORE'), gasOf('00 01 TSTORE'), '09 TLOAD', '2a 01 TSTORE 01 SLOAD', '01 TLOAD', `${MAX} ${MAX} TSTORE ${MAX} TLOAD`]));
  {
    // Across transactions: a slot set in one is 0 in the next (one contract, the same in both).
    const shared = `0x${helper()}`, code = assemble(`CALLDATASIZE :read JUMPI 2a 01 TSTORE ${ret(['01 TLOAD'])} @read ${ret(['01 TLOAD'])}`);
    programs.push({ label: 'combination: TSTORE in a transaction (one of two to one contract)', to: shared, code });
    programs.push({ label: 'combination: TLOAD in the next transaction to it, which finds nothing', to: shared, code, data: '0x01' });
  }

  // Each write in a static context fails, burning the gas the static call was given; those that don't write run.
  {
    const sstore = helper();
    const cases: [string, string, Partial<StateChanges[string]>?][] = [
      ['SSTORE of a new value', '01 01 SSTORE STOP'], ['SSTORE of the value already there', '00 01 SSTORE STOP'], ['LOG0 of nothing', '00 00 LOG0 STOP'], ['LOG4', '04 03 02 01 00 00 LOG4 STOP'],
      ['CREATE of nothing', '00 00 00 CREATE STOP'], ['CREATE2 of nothing', '00 00 00 00 CREATE2 STOP'], ['CALL with a wei', `00 00 00 00 01 ${NOBODY} GAS CALL STOP`, { balance: '0xa' }],
      ['CALL with a wei to itself', '00 00 00 00 01 ADDRESS GAS CALL STOP', { balance: '0xa' }], ['CALL with no value (runs)', `00 00 00 00 00 ${NOBODY} GAS CALL STOP`],
      ['CALLCODE with a wei (runs: no value leaves)', `00 00 00 00 01 ${NOBODY} GAS CALLCODE STOP`, { balance: '0xa' }],
      ['SELFDESTRUCT', 'CALLER SELFDESTRUCT', { balance: '0xa' }], ['SELFDESTRUCT to itself with no balance', 'ADDRESS SELFDESTRUCT'], ['TSTORE', '01 01 TSTORE STOP'], ['TSTORE of 0 to a slot never set', '00 01 TSTORE STOP'],
      ['DELEGATECALL to code that writes', `00 00 00 00 ${sstore} GAS DELEGATECALL ${ret(['RETURNDATASIZE'])}`], ['a call (no value) to code that writes', `00 00 00 00 00 ${sstore} GAS CALL 00 MSTORE 20 00 RETURN`],
      ['TLOAD and SLOAD (run)', '01 TLOAD 01 SLOAD STOP'],
    ];
    const state: StateChanges = { [`0x${sstore}`]: { code: assemble('01 01 SSTORE STOP') } };
    for (const [label, code, account] of cases) {
      const w = helper();
      state[`0x${w}`] = { code: assemble(code), ...account };
      add(`a static call to code that does ${label}`, `GAS 20 00 00 00 ${w} 7530 STATICCALL SWAP1 GAS SWAP1 SUB 00 MLOAD 40 MSTORE 20 MSTORE 00 MSTORE 60 00 RETURN`, { state: { ...state } });
    }
  }

  // What calls and account reads cost, read with GAS around them.
  {
    const stops = helper(), burns = helper(), logs = helper(), measuring = helper();
    const state: StateChanges = { [`0x${stops}`]: { code: assemble('STOP') }, [`0x${burns}`]: { code: assemble('INVALID') }, [`0x${logs}`]: { code: assemble('00 00 LOG0 STOP') } };
    add('CALL to an account cold, then warm; with a wei to one that exists, to one that does not; to a precompile', ret([
      gasOf(`00 00 00 00 00 ${NOBODY} 00 CALL POP`), gasOf(`00 00 00 00 00 ${NOBODY} 00 CALL POP`), gasOf('00 00 00 00 01 CALLER 00 CALL POP'), gasOf(`00 00 00 00 01 ${NOBODY2} 00 CALL POP`),
      gasOf('00 00 00 00 00 04 00 CALL POP'), gasOf(`00 00 00 00 00 ${stops} GAS CALL POP`), gasOf(`00 00 00 00 01 ${logs} 00 CALL POP`), `${NOBODY2} BALANCE`]), { state, balance: 10n });
    add('DELEGATECALL, STATICCALL and CALLCODE to accounts cold, then warm', ret([
      gasOf(`00 00 00 00 ${stops} 00 DELEGATECALL POP`), gasOf(`00 00 00 00 ${stops} 00 STATICCALL POP`), gasOf(`00 00 00 00 00 ${NOBODY} 00 CALLCODE POP`), gasOf(`00 00 00 00 00 ${NOBODY} 00 CALLCODE POP`),
      gasOf(`00 00 00 00 01 ${NOBODY2} 00 CALLCODE POP`), gasOf(`00 00 00 00 ${NOBODY2} 00 STATICCALL POP`)]), { state, balance: 10n });
    add('a call with more value than the balance: the price, and the gas it was to be given kept', ret([gasOf(`00 00 00 00 ffff ${NOBODY} 7530 CALL POP`), gasOf(`00 00 00 00 ffff ${stops} 7530 CALL POP`), `00 00 00 00 ffff ${stops} 7530 CALL`]), { state, balance: 10n });
    add('BALANCE, EXTCODESIZE, EXTCODEHASH and EXTCODECOPY cold, then warm', ret([
      gasOf(`${NOBODY} BALANCE POP`), gasOf(`${NOBODY} EXTCODESIZE POP`), gasOf(`${NOBODY2} EXTCODEHASH POP`), gasOf(`${NOBODY2} BALANCE POP`), gasOf(`00 00 00 ${stops} EXTCODECOPY`), gasOf(`00 00 00 ${stops} EXTCODECOPY`),
      gasOf('ADDRESS BALANCE POP'), gasOf('CALLER EXTCODESIZE POP'), gasOf('ORIGIN EXTCODEHASH POP'), gasOf('SELFBALANCE POP')]), { state });
    // Absolute gas, inside a call given exactly 200,000 (so Arbitrum's L1 charge doesn't move it): a call asking for
    // more than there is gets all but a 64th.
    state[`0x${measuring}`] = { code: assemble(`GAS 00 00 00 00 00 ${burns} ${MAX} CALL GAS 00 00 00 00 00 ${stops} ${MAX} CALL GAS 00 00 00 00 00 ${burns} 01f4 CALL GAS ${Array.from({ length: 7 }, (_, i) => `${h((6 - i) * 32)} MSTORE`).join(' ')} e0 00 RETURN`) };
    add('GAS around calls that ask for 2^256-1 gas (to code that burns it all, and that stops) and for 500, inside 200,000', `e0 00 00 00 00 ${measuring} 030d40 CALL POP e0 00 RETURN`, { state });
    add('COINBASE warm from the start (EIP-3651)', ret([gasOf('COINBASE BALANCE POP'), gasOf('COINBASE EXTCODESIZE POP')]));
  }
  {
    // Which accounts are warm from the start: each precompile (and the chain's own), read with BALANCE.
    const ranges: [string, number[]][] = [
      ['0x01 to 0x11', Array.from({ length: 17 }, (_, i) => i + 1)], ['0x12 to 0x20, 0x100 and 0x101', [...Array.from({ length: 15 }, (_, i) => i + 0x12), 0x100, 0x101]],
      ['0x64 to 0x74', Array.from({ length: 17 }, (_, i) => i + 0x64)], ['0x800 to 0x810, 0xff and 0xa4b05', [...Array.from({ length: 17 }, (_, i) => i + 0x800), 0xff, 0xa4b05]],
    ];
    for (const [label, addresses] of ranges) add(`BALANCE of ${label}: warm or cold`, ret(addresses.map(a => gasOf(`${h(a)} BALANCE POP`))));
    if (chainId === 8453) add("BALANCE of Base's own (NonceManager, TxContext, the B20 factory, the registries): warm or cold", ret(['813000000000000000000000000000000000aa01', '813000000000000000000000000000000000aa02', 'b20f000000000000000000000000000000000000', '8453000000000000000000000000000000000001', '8453000000000000000000000000000000000002', '4200000000000000000000000000000000000015'].map(a => gasOf(`${a} BALANCE POP`))));
    add('EXTCODEHASH of precompiles, an account that does not exist, the sender and itself', ret(['01 EXTCODEHASH', '04 EXTCODEHASH', '0100 EXTCODEHASH', `${NOBODY} EXTCODEHASH`, 'CALLER EXTCODEHASH', 'ADDRESS EXTCODEHASH', '00 EXTCODEHASH', '64 EXTCODEHASH']));
  }

  // SSTORE's floor: with 2,300 gas or less left it fails, whatever it would cost.
  {
    const store = helper(), logs = helper();
    const state: StateChanges = { [`0x${store}`]: { code: assemble('PUSH0 PUSH0 SSTORE STOP') }, [`0x${logs}`]: { code: assemble('PUSH0 PUSH0 LOG0 STOP') } };
    add('SSTORE with 2,300 gas left fails, with 2,301 runs', ret([`00 00 00 00 00 ${store} 0900 CALL`, `00 00 00 00 00 ${store} 0901 CALL`, `00 00 00 00 00 ${store} 0904 CALL`]), { state });
    add("SSTORE on a call's stipend fails, LOG0 on it runs", ret([`00 00 00 00 01 ${store} 00 CALL`, `00 00 00 00 01 ${logs} 00 CALL`]), { state, balance: 10n });
  }

  // Creations that fail, and what a constructor sees.
  {
    const returning = (code: string) => assemble(`${code} 00 MSTORE ${h(code.length / 2)} ${h(32 - code.length / 2)} RETURN`);
    // (Each alone: a creation that fails burns all the gas it was given, and leaves too little for another.)
    for (const code of ['ef', 'ef00', 'ef0100', 'fe', '60ef']) add(`CREATE of code 0x${code.toUpperCase()}${code.startsWith('ef') ? ', which starts with 0xEF (EIP-3541)' : ''}`, ret([`${initcode(returning(code))} 00 00 CREATE DUP1 EXTCODESIZE SWAP1`, 'RETURNDATASIZE']), { burns: code.startsWith('ef') });
    add('CREATE2 of code 0xEF (EIP-3541)', ret([`07 ${initcode(returning('ef'))} 00 00 CREATE2`, 'RETURNDATASIZE']), { burns: true });
    add('a CREATE with more value than the balance fails, and the next CREATE gets the nonce', `00 00 ffff CREATE 00 00 00 CREATE DUP1 EXTCODEHASH ${'40 MSTORE 20 MSTORE 00 MSTORE'} 60 00 RETURN`, { balance: 10n });
    add("a CREATE whose initcode reverts: its data is the return data", `${initcode(assemble('deadbeef 00 MSTORE 04 1c REVERT'))} 00 00 CREATE RETURNDATASIZE 04 00 40 RETURNDATACOPY 40 MLOAD ${'40 MSTORE 20 MSTORE 00 MSTORE'} 60 00 RETURN`);
    // A constructor's view of itself: CODESIZE is its initcode, its own account has no code yet but exists (its
    // nonce is 1), its balance is what it was sent.
    add('what a constructor sees: CODESIZE, its own EXTCODESIZE and EXTCODEHASH, SELFBALANCE, CALLVALUE, CALLDATASIZE, CALLER, ORIGIN',
      `${initcode(assemble('CODESIZE 00 MSTORE ADDRESS EXTCODESIZE 20 MSTORE SELFBALANCE 40 MSTORE CALLVALUE 60 MSTORE CALLDATASIZE 80 MSTORE CALLER a0 MSTORE ORIGIN c0 MSTORE ADDRESS EXTCODEHASH e0 MSTORE RETURNDATASIZE 0100 MSTORE 0120 00 REVERT'))} 00 03 CREATE POP 0120 00 00 RETURNDATACOPY 0120 00 RETURN`, { balance: 10n });
    // Inside a call given exactly 120,000 gas: code of 200 bytes is paid for (40,000), of 500 (100,000) not.
    {
      const code = (bytes: number) => assemble(`GAS ${initcode(assemble(`${h(bytes)} 00 RETURN`))} 00 00 CREATE SWAP1 GAS SWAP1 SUB SWAP1 DUP1 EXTCODESIZE ${'40 MSTORE 20 MSTORE 00 MSTORE'} 60 00 RETURN`);
      const small = helper(), large = helper();
      add("a CREATE of 200 bytes of code, inside 120,000 gas: its deposit paid", `60 00 00 00 00 ${small} 01d4c0 CALL POP 60 00 RETURN`, { state: { [`0x${small}`]: { code: code(200) } } });
      add("a CREATE of 500 bytes of code, inside 120,000 gas: its deposit can't be paid, the gas given burnt", `60 00 00 00 00 ${large} 01d4c0 CALL POP 60 00 RETURN`, { state: { [`0x${large}`]: { code: code(500) } } });
    }
    // CREATE2 onto an address that already has something (EIP-684): a balance alone is no collision; a nonce or code
    // is, and the creation fails burning the gas it was given. (Storage alone, given by an override: no collision on
    // either side, EIP-7610's check of an account's storage notwithstanding.)
    const init = assemble('2a 00 MSTORE 20 00 RETURN');
    for (const [label, account] of [['a balance only', { balance: '0x5' }], ['a nonce', { nonce: '0x1' }], ['code', { code: '0x00' }], ['storage only (given by an override)', { stateDiff: { [`0x${word(1)}`]: `0x${word(1)}` } }]] as const) {
      const creator = `0x${helper()}`;
      const target = getContractAddress({ opcode: 'CREATE2', from: creator as Hex, salt: `0x${word(7)}`, bytecode: init }).toLowerCase();
      add(`CREATE2 onto an address that has ${label}`, `80 00 00 00 00 ${creator.slice(2)} 01d4c0 CALL POP 80 00 RETURN`, {
        state: { [creator]: { code: assemble(`GAS 07 ${initcode(init)} 00 00 CREATE2 SWAP1 GAS SWAP1 SUB SWAP1 ${target.slice(2)} BALANCE ${target.slice(2)} EXTCODESIZE 60 MSTORE 40 MSTORE 20 MSTORE 00 MSTORE 80 00 RETURN`) }, [target]: account as StateChanges[string] },
      });
    }
  }

  // SELFDESTRUCT of an account that existed before the transaction (only its balance moves, EIP-6780) and of one
  // made in it (gone at the end).
  {
    const self = helper(), twice = helper(), poor = helper(), rich = helper();
    const state: StateChanges = {
      [`0x${self}`]: { code: assemble('ADDRESS SELFDESTRUCT'), balance: '0xa' }, [`0x${twice}`]: { code: assemble('CALLER SELFDESTRUCT'), balance: '0xa' },
      [`0x${poor}`]: { code: assemble(`${NOBODY} SELFDESTRUCT`) }, [`0x${rich}`]: { code: assemble(`${NOBODY2} SELFDESTRUCT`), balance: '0x5' },
    };
    add('a contract that existed before destroys itself to itself: its balance and code stay', ret([`00 00 00 00 00 ${self} GAS CALL`, `${self} BALANCE`, `${self} EXTCODESIZE`]), { state });
    add('a contract that existed before, called twice, destroys itself to its caller each time', ret([`00 00 00 00 00 ${twice} GAS CALL`, `00 00 00 00 00 ${twice} GAS CALL`, `${twice} BALANCE`, `${twice} EXTCODESIZE`, 'SELFBALANCE']), { state });
    add('SELFDESTRUCT to an account that does not exist, with no balance and with one: the price', ret([gasOf(`00 00 00 00 00 ${poor} GAS CALL POP`), gasOf(`00 00 00 00 00 ${rich} GAS CALL POP`), `${NOBODY2} BALANCE`, `${NOBODY} BALANCE`]), { state });
    const runtime = '33ff'; // CALLER SELFDESTRUCT
    add('a contract made and destroyed in one transaction runs again when called, its code still there', `${initcode(assemble(`${runtime} 00 MSTORE 02 1e RETURN`))} 00 00 CREATE DUP1 00 00 00 00 00 SWAP5 GAS CALL SWAP1 DUP1 EXTCODESIZE SWAP1 DUP1 00 00 00 00 00 SWAP5 GAS CALL SWAP1 BALANCE ${Array.from({ length: 4 }, (_, i) => `${h((3 - i) * 32)} MSTORE`).join(' ')} 80 00 RETURN`);
  }

  // EIP-7702 delegations as code reads them: EXTCODECOPY of the designation, CODESIZE and CODECOPY in the delegate's
  // code (its own), a delegation to a delegated account (not followed: its 0xef runs, and fails), DELEGATECALL into one.
  if (!cancun || profile?.eips?.includes(7702)) {
    const delegate = helper(), delegated = helper(), second = helper(), toEmpty = helper(), writer = helper(), toWriter = helper();
    const state: StateChanges = {
      [`0x${delegate}`]: { code: assemble('CODESIZE 00 MSTORE 20 00 20 CODECOPY ADDRESS 40 MSTORE 60 00 RETURN') }, [`0x${delegated}`]: { code: `0xef0100${delegate}` },
      [`0x${second}`]: { code: `0xef0100${delegated}` }, [`0x${toEmpty}`]: { code: `0xef0100${NOBODY}` }, [`0x${writer}`]: { code: assemble('01 01 SSTORE STOP') }, [`0x${toWriter}`]: { code: `0xef0100${writer}` },
    };
    add("EXTCODECOPY of a delegated account: the designation's 23 bytes", `${MAX} 00 MSTORE 20 00 00 ${delegated} EXTCODECOPY ${delegated} EXTCODESIZE 20 MSTORE 40 00 RETURN`, { state });
    add("a call into a delegated account: CODESIZE, CODECOPY and ADDRESS in the delegate's code", `60 00 00 00 00 ${delegated} GAS CALL 60 MSTORE 80 00 RETURN`, { state });
    add("DELEGATECALL into a delegated account runs the delegate's code as the caller's", `60 00 00 00 ${delegated} GAS DELEGATECALL 60 MSTORE 80 00 RETURN`, { state });
    add('a call into an account delegated to a delegated account: not followed, the designation runs (and fails)', ret([`00 00 00 00 00 ${second} 7530 CALL`, 'RETURNDATASIZE', gasOf(`00 00 00 00 00 ${second} 7530 CALL POP`)]), { state });
    add('a call into an account delegated to an account with no code', ret([`00 00 00 00 00 ${toEmpty} GAS CALL`, 'RETURNDATASIZE', gasOf(`00 00 00 00 00 ${toEmpty} GAS CALL POP`)]), { state });
    add('a static call into an account delegated to code that writes', ret([`00 00 00 00 ${toWriter} 7530 STATICCALL`, `00 00 00 00 00 ${toWriter} GAS CALL`]), { state });
  }

  // BLOCKHASH outside the 256 blocks it answers for (HyperEVM's node answers on its latest block: constants only).
  add('BLOCKHASH of block 0, 2^64 and 2^256-1', ret(['00 BLOCKHASH', `${P64} BLOCKHASH`, `${MAX} BLOCKHASH`]));
  if (blockwise) add('BLOCKHASH of this block, the next, and 256 and 257 back', ret(['NUMBER BLOCKHASH', '01 NUMBER ADD BLOCKHASH', '0100 NUMBER SUB BLOCKHASH', '0101 NUMBER SUB BLOCKHASH', '0100 NUMBER SUB BLOCKHASH ISZERO']));

  // Between the transactions of one block.
  {
    const touched = '000000000000000000000000000000000beef0b1';
    programs.push({ label: 'combination: a transaction reads an account (one of two)', code: assemble(`${touched} BALANCE POP STOP`) });
    programs.push({ label: 'combination: the next reads it cold again', code: assemble(ret([gasOf(`${touched} BALANCE POP`)])) });
    if (blockwise) {
      const store = `0x${helper()}`, code = assemble(`CALLDATASIZE :next JUMPI 01 07 SSTORE STOP @next ${ret([gasOf('02 07 SSTORE'), gasOf('01 07 SSTORE'), '07 SLOAD'])}`);
      programs.push({ label: 'combination: a slot set in a transaction (one of two to one contract)', to: store, code });
      programs.push({ label: "combination: the next transaction's price to change it, from its original value", to: store, code, data: '0x01' });
      const creator = `0x${helper()}`, creates = assemble(ret(['00 00 00 CREATE']));
      programs.push({ label: 'combination: a CREATE in a transaction (one of two from one contract)', to: creator, code: creates });
      programs.push({ label: "combination: a CREATE in the next, at the creator's next nonce", to: creator, code: creates });
    }
  }

  // The context a call runs in, and its events and storage across frames.
  {
    const context = helper(), reverter = helper(), logger = helper(), writer = helper();
    const state: StateChanges = {
      [`0x${context}`]: { code: assemble(`ADDRESS 00 MSTORE CALLER 20 MSTORE CALLVALUE 40 MSTORE SELFBALANCE 60 MSTORE CALLDATASIZE 80 MSTORE ORIGIN a0 MSTORE GASPRICE c0 MSTORE CODESIZE e0 MSTORE 0100 00 RETURN`) },
      [`0x${reverter}`]: { code: assemble('01 01 01 LOG1 00 00 REVERT') }, [`0x${logger}`]: { code: assemble('02 01 01 LOG1 STOP') },
      [`0x${writer}`]: { code: assemble('2a 07 SSTORE 07 SLOAD 00 MSTORE 20 00 RETURN') },
    };
    add('ADDRESS, CALLER, CALLVALUE, SELFBALANCE, CALLDATASIZE, ORIGIN, GASPRICE and CODESIZE in a DELEGATECALL, a CALLCODE and a CALL',
      `0100 00 03 00 ${context} GAS DELEGATECALL POP 0100 0100 03 00 02 ${context} GAS CALLCODE POP 0100 0200 03 00 01 ${context} GAS CALL POP 0300 00 RETURN`, { state, balance: 10n, value: 7n });
    add('events in order across frames, and none from a call that reverts', `01 00 00 LOG1 00 00 00 00 00 ${reverter} GAS CALL POP 00 00 00 00 00 ${logger} GAS CALL POP 03 00 00 LOG1 ${ret(['01'])}`, { state });
    add("a DELEGATECALL's callee writes the caller's storage", ret([`20 00 00 00 ${writer} GAS DELEGATECALL POP 00 MLOAD`, '07 SLOAD']), { state });
    add('an SSTORE in a call back into the contract that reverts is undone, and its refund with it', `CALLDATASIZE :undo JUMPI 2a 07 SSTORE 00 00 01 00 00 ADDRESS GAS CALL POP ${ret(['07 SLOAD'])} @undo 00 07 SSTORE 00 00 REVERT`, { storage: { [`0x${word(7)}`]: `0x${word(5)}` } });
    add('LOG4 of memory beyond its size', `04 03 02 01 40 0100 LOG4 ${ret(['MSIZE'])}`);
    add('KECCAK256 of memory partly beyond its size, and MSTORE8 of a low byte', ret([`${PATTERN1} 00 MSTORE 40 10 KECCAK256`, 'MSIZE', '1234 0100 MSTORE8 0100 MLOAD']));
    add('a CALL with a wei to a precompile', ret(['04 BALANCE 00 00 00 00 01 04 GAS CALL SWAP1 04 BALANCE SUB', 'SELFBALANCE']), { balance: 10n });
  }

  // SSTORE's price and refund for each original, current and new value (0, 1 or 2; EIP-2200, EIP-2929, EIP-3529):
  // the slot warm (read first, or set to the current value first), and cold where nothing has touched it. The gas
  // the transaction uses carries the refund.
  for (const original of [0, 1, 2]) for (const current of [0, 1, 2]) for (const value of [0, 1, 2]) {
    const before = current === original ? '07 SLOAD POP' : `${h(current)} 07 SSTORE`;
    add(`SSTORE ${original} to ${current} to ${value}: its price, the slot warm`, `${before} ${ret([gasOf(`${h(value)} 07 SSTORE`), '07 SLOAD'])}`, original ? { storage: { [`0x${word(7)}`]: `0x${word(original)}` } } : {});
  }
  for (const original of [0, 1]) for (const value of [0, 1, 2]) add(`SSTORE ${original} to ${value}: its price, the slot cold`, ret([gasOf(`${h(value)} 07 SSTORE`)]), original ? { storage: { [`0x${word(7)}`]: `0x${word(original)}` } } : {});

  // What copies, hashes and events cost by length (33 bytes: two words), in memory already grown.
  {
    const five = helper();
    add('the price of 33 bytes copied, hashed and logged (CALLDATACOPY, CODECOPY, EXTCODECOPY, RETURNDATACOPY, MCOPY, KECCAK256, LOG0 to LOG4)', `01 0400 MSTORE ${ID32} ${five} EXTCODESIZE POP ${retHigh([
      gasOf('21 00 00 CALLDATACOPY'), gasOf('21 00 00 CODECOPY'), gasOf(`21 00 00 ${five} EXTCODECOPY`), gasOf('20 00 00 RETURNDATACOPY'), gasOf('21 00 40 MCOPY'), gasOf('21 00 KECCAK256 POP'),
      gasOf('21 00 LOG0'), gasOf('01 21 00 LOG1'), gasOf('02 01 21 00 LOG2'), gasOf('03 02 01 21 00 LOG3'), gasOf('04 03 02 01 21 00 LOG4'), gasOf('0400 00 KECCAK256 POP')])}`, { data: `0x${'ab'.repeat(40)}`, state: { [`0x${five}`]: { code: `0x${'5b'.repeat(40)}` } } });
  }

  // Signed and unsigned comparisons, and the bitwise opcodes, at the edges.
  add('LT, GT, SLT, SGT, EQ and ISZERO at 0, 1, 2^255 and 2^256-1', ret([`${MAX} 00 LT`, `00 ${MAX} GT`, `${MIN} ${MAX} SLT`, `${MAX} ${MIN} SGT`, `00 ${MIN} SLT`, `${MIN} 00 SGT`, `${MAX} ${MAX} EQ`, `${MIN} ISZERO`, '00 ISZERO', `${MAX} ${'7f'}${'ff'.repeat(31)} SGT`, `00 ${MAX} SLT`]));
  add('AND, OR, XOR and NOT of 0, 2^255 and 2^256-1', ret([`${MAX} ${MIN} AND`, `${MIN} 01 OR`, `${MAX} ${MIN} XOR`, `${MIN} NOT`, '00 NOT', `${MAX} ${MAX} XOR`]));

  // Transient storage set by a constructor is the new contract's, there for a call to it later in the transaction;
  // TSTORE in a DELEGATECALL made inside a static call fails.
  {
    const runtime = assemble(`${ret(['01 TLOAD'])}`).slice(2), init = assemble(`2a 01 TSTORE ${initcode(`0x${runtime}`)} 00 RETURN`);
    add("a constructor's TSTORE, read by a call to the new contract in the same transaction", `${initcode(init)} 00 00 CREATE 20 00 00 00 00 DUP6 GAS CALL 00 MLOAD 20 MSTORE 00 MSTORE 40 00 RETURN`);
    const tstore = helper(), delegating = helper();
    add('a TSTORE in a DELEGATECALL made inside a static call', ret([`00 00 00 00 ${delegating} 7530 STATICCALL`, `00 00 00 00 00 ${delegating} GAS CALL`]),
      { state: { [`0x${tstore}`]: { code: assemble('01 01 TSTORE STOP') }, [`0x${delegating}`]: { code: assemble(`00 00 00 00 ${tstore} GAS DELEGATECALL ISZERO :failed JUMPI STOP @failed 00 00 REVERT`) } } });
  }

  // SELFDESTRUCT by DELEGATECALL and CALLCODE (the caller's account), in a constructor, and by a contract made in the
  // transaction through a library it delegates to.
  {
    const library = helper(), byCallcode = helper();
    const state: StateChanges = { [`0x${library}`]: { code: assemble('CALLER SELFDESTRUCT') }, [`0x${byCallcode}`]: { code: assemble(`00 00 00 00 00 ${library} GAS CALLCODE STOP`), balance: '0x4' } };
    add("SELFDESTRUCT in a DELEGATECALL: the caller's balance goes, its code stays", `00 00 00 00 ${library} GAS DELEGATECALL ${ret(['SELFBALANCE', 'ADDRESS EXTCODESIZE', 'CALLER BALANCE ISZERO'])}`, { state, balance: 10n });
    add("SELFDESTRUCT in a CALLCODE: the caller's balance goes to its caller", ret([`00 00 00 00 00 ${byCallcode} GAS CALL`, `${byCallcode} BALANCE`, `${byCallcode} EXTCODESIZE`]), { state });
    add('SELFDESTRUCT in a constructor: the creation succeeds with no code', `${initcode(assemble('CALLER SELFDESTRUCT'))} 00 03 CREATE DUP1 EXTCODESIZE DUP2 BALANCE DUP3 EXTCODEHASH ${Array.from({ length: 4 }, (_, i) => `${h((3 - i) * 32)} MSTORE`).join(' ')} 80 00 RETURN`, { balance: 10n });
    const runtime = assemble(`00 00 00 00 ${library} GAS DELEGATECALL STOP`);
    add('a contract made in the transaction destroys itself through a library it delegates to: called again, it runs', `${initcode(assemble(`${initcode(runtime)} 00 RETURN`))} 00 05 CREATE DUP1 00 00 00 00 00 SWAP5 GAS CALL POP DUP1 EXTCODESIZE SWAP1 BALANCE ${'20 MSTORE 00 MSTORE'} 40 00 RETURN`, { state, balance: 10n });
    add('CREATE2 onto the address of a contract destroyed earlier in the same transaction (still there: a collision)', `${initcode(assemble(`${initcode(assemble('CALLER SELFDESTRUCT'))} 00 RETURN`))} DUP1 07 SWAP1 00 00 CREATE2 DUP1 00 00 00 00 00 SWAP5 GAS CALL POP SWAP1 07 SWAP1 00 00 CREATE2 20 MSTORE 00 MSTORE 40 00 RETURN`, { burns: true });
    // (Code that destroys itself when called with no calldata, and keeps what it is sent with some.)
    const keeps = assemble(`${initcode(assemble('CALLDATASIZE :keep JUMPI CALLER SELFDESTRUCT @keep STOP'))} 00 RETURN`);
    add('a contract made and destroyed in the transaction, then sent a wei', `${initcode(keeps)} 00 00 CREATE 00 00 00 00 00 DUP6 GAS CALL POP 00 00 01 00 01 DUP6 GAS CALL POP DUP1 BALANCE SWAP1 EXTCODESIZE 20 MSTORE 00 MSTORE 40 00 RETURN`, { balance: 10n });
  }

  // The limits on code and initcode (Polygon's code may be 32,768 bytes; Amsterdam's limits are larger and priced
  // apart: crafted() has them), and a callee's 64 KiB of return data.
  if (!amsterdam) {
    for (const bytes of [24_576, 24_577, 32_768, 32_769]) add(`CREATE of ${bytes.toLocaleString('en')} bytes of code`, ret([`${initcode(assemble(`${h(bytes)} 00 RETURN`))} 00 00 CREATE EXTCODESIZE`]), { gas: 8_000_000n });
    for (const bytes of [49_152, 49_153, 65_536, 65_537]) add(`CREATE from ${bytes.toLocaleString('en')} bytes of initcode`, ret([`${h(bytes)} 00 00 CREATE`, 'RETURNDATASIZE']), { gas: 2_000_000n });
  }
  {
    const big = helper();
    add('a call that returns 64 KiB: RETURNDATASIZE, its last word, and the price', retHigh([gasOf(`00 00 00 00 00 ${big} GAS CALL POP`), 'RETURNDATASIZE', `20 ffe0 00 RETURNDATACOPY 00 MLOAD`]), { state: { [`0x${big}`]: { code: assemble(`2a fff0 MSTORE 010000 00 RETURN`) } } });
  }

  // Gas charged before a call's 63/64 is worked out (memory for its return area, value to a new account), inside a
  // call of exactly 50,000 (Arbitrum's L1 charge out of it).
  {
    const memory = helper(), value = helper(), stops = helper();
    const state: StateChanges = {
      [`0x${stops}`]: { code: assemble('GAS 00 MSTORE 20 00 RETURN') },
      [`0x${memory}`]: { code: assemble(`GAS 20 8000 00 00 00 ${stops} ${MAX} CALL POP 8000 MLOAD GAS ${'40 MSTORE 20 MSTORE 00 MSTORE'} 60 00 RETURN`) },
      [`0x${value}`]: { code: assemble(`GAS 20 00 00 00 01 ${NOBODY} ${MAX} CALL GAS ${'40 MSTORE 20 MSTORE 00 MSTORE'} 60 00 RETURN`), balance: '0x5' },
    };
    add("a call's return area grown first, then 63/64 of what is left given: the gas the callee saw", `60 00 00 00 00 ${memory} c350 CALL POP 60 00 RETURN`, { state });
    add('a call with a wei to an account that does not exist, inside 30,000 gas: out of gas before it starts', ret([`00 00 00 00 00 ${value} 7530 CALL`, gasOf(`00 00 00 00 00 ${value} 7530 CALL POP`)]), { state });
    add('a call with a wei to a precompile that fails (sha256 given 10 gas): the wei stays', ret(['02 BALANCE 00 00 00 00 01 02 0a CALL SWAP1 02 BALANCE SUB', 'SELFBALANCE']), { balance: 10n });
  }

  // Whether an account exists, as EXTCODEHASH reads it (0 for one that doesn't or is empty, EIP-1052 and EIP-161):
  // after a call with no value touched it, a SELFDESTRUCT with nothing to give named it, a CREATE that reverted
  // would have made it, a wei was sent to it in a call that reverted; and CREATE at the nonce limit (EIP-2681).
  {
    const touched = '000000000000000000000000000000000beef0d1', named = '000000000000000000000000000000000beef0d2', sentBack = '000000000000000000000000000000000beef0d3';
    const giver = helper(), reverter = helper();
    const state: StateChanges = { [`0x${giver}`]: { code: assemble(`${named} SELFDESTRUCT`) }, [`0x${reverter}`]: { code: assemble(`00 00 00 00 01 ${sentBack} GAS CALL POP 00 00 REVERT`), balance: '0x5' } };
    add('EXTCODEHASH, EXTCODESIZE and BALANCE of an account a call with no value touched', `00 00 00 00 00 ${touched} GAS CALL POP ${ret([`${touched} EXTCODEHASH`, `${touched} EXTCODESIZE`, `${touched} BALANCE`])}`);
    add('EXTCODEHASH of an account named by a SELFDESTRUCT with nothing to give', `00 00 00 00 00 ${giver} GAS CALL POP ${ret([`${named} EXTCODEHASH`, `${named} BALANCE`, gasOf(`${named} BALANCE POP`)])}`, { state });
    add('EXTCODEHASH and BALANCE of an account sent a wei in a call that then reverted', `00 00 00 00 00 ${reverter} GAS CALL POP ${ret([`${sentBack} EXTCODEHASH`, `${sentBack} BALANCE`, `${reverter} BALANCE`])}`, { state });
    // (Not at the limit under Amsterdam, where the local EVM charges the new account's state gas before EIP-2681's
    // check and the node doesn't: in a call given less than that charge, the node's CREATE pushes 0 and the local
    // one runs out of gas.)
    for (const [label, nonce] of [...(amsterdam ? [] : [['the nonce limit, 2^64-1 (EIP-2681: no creation, the gas kept)', 0xffffffffffffffffn] as const]), ['a nonce of 2^64-2', 0xfffffffffffffffen] as const]) {
      const creator = `0x${helper()}`;
      add(`CREATE by an account at ${label}`, `60 00 00 00 00 ${creator.slice(2)} 0186a0 CALL POP 60 00 RETURN`, { state: { [creator]: { code: assemble(`GAS 00 00 00 CREATE SWAP1 GAS SWAP1 SUB SWAP1 DUP1 EXTCODEHASH ${'40 MSTORE 20 MSTORE 00 MSTORE'} 60 00 RETURN`), nonce: `0x${nonce.toString(16)}` } } });
    }
    const creator = `0x${helper()}`, failed = getContractAddress({ from: creator as Hex, nonce: 0n }).toLowerCase(), next = getContractAddress({ from: creator as Hex, nonce: 1n }).toLowerCase();
    programs.push({ label: 'combination: EXTCODEHASH of the address a CREATE that reverted would have made, and of the next one made', to: creator,
      code: assemble(`${initcode(assemble('00 00 REVERT'))} 00 00 CREATE POP 00 00 00 CREATE POP ${ret([`${failed.slice(2)} EXTCODEHASH`, `${next.slice(2)} EXTCODEHASH`, `${failed.slice(2)} BALANCE`])}`) });
  }

  // Events from a constructor (the new contract's), from one that then reverts (none), and from a DELEGATECALL (the
  // caller's); and an EIP-7702 account whose delegate destroys it (made before the transaction: only its balance moves).
  {
    const logs = helper(), delegate = helper(), delegated = helper();
    const state: StateChanges = { [`0x${logs}`]: { code: assemble('2a 00 MSTORE 07 20 00 LOG1 STOP') }, [`0x${delegate}`]: { code: assemble('CALLER SELFDESTRUCT') }, [`0x${delegated}`]: { code: `0xef0100${delegate}`, balance: '0x9' } };
    add('events of a constructor, of one that then reverts, and of a DELEGATECALL', `${initcode(assemble(`2a 00 MSTORE 05 20 00 LOG1 00 00 RETURN`))} 00 00 CREATE POP ${initcode(assemble(`2b 00 MSTORE 06 20 00 LOG1 00 00 REVERT`))} 00 00 CREATE POP 00 00 00 00 ${logs} GAS DELEGATECALL POP ${ret(['01'])}`, { state });
    if (!cancun || profile?.eips?.includes(7702)) add('an EIP-7702 account whose delegate destroys it: its balance moves, its delegation stays', ret([`00 00 00 00 00 ${delegated} GAS CALL`, `${delegated} BALANCE`, `${delegated} EXTCODESIZE`, `${delegated} EXTCODEHASH`]), { state });
  }

  // The precompiles reached by DELEGATECALL, by CALLCODE with a wei and by CALL with a wei, each with an input it
  // takes (from a contract that reports the gas the call spent and what came back).
  {
    const blake = `0000000c${'5a'.repeat(64)}${'c3'.repeat(128)}${'00'.repeat(15)}0301`;
    const inputs: [number, string][] = [[1, '00'.repeat(128)], [2, 'ab'.repeat(100)], [3, 'ab'.repeat(100)], [4, 'ab'.repeat(100)], [5, `${word(1)}${word(1)}${word(1)}030507`], [6, '00'.repeat(128)], [7, '00'.repeat(96)], [8, ''], [9, blake], [0x100, '00'.repeat(160)]];
    for (const [n, input] of inputs) for (const op of ['DELEGATECALL', 'CALLCODE', 'CALL'] as const)
      programs.push({ precompile: true, label: `combination: 0x${n.toString(16).padStart(2, '0')} by ${op}${op === 'DELEGATECALL' ? '' : ' with a wei'}`, code: caller(n, op), data: `0x${input}`, ...(op !== 'DELEGATECALL' && { value: 1n }) });
  }
  return programs;
}

/**
 * Arbitrum's own precompiles, which the chain answers for the local EVM: the calls contracts make most (the L2
 * block number, the chain's id, gas prices), each from a contract that reports the gas the call spent. What they
 * return is the chain's either way; what they cost is the local EVM's own figure.
 */
function arbosPrograms(): Program[] {
  const of = (name: string, address: number, methods: string[]): Program[] => methods.map(m => ({ precompile: true, label: `${name}.${m}`, code: caller(address), data: toFunctionSelector(`function ${m}`) }));
  // ArbSys's sends to L1, which the local EVM runs itself: each from a contract that passes on the value it is sent
  // (or calls in a static or delegate call), reporting the gas the call spent and what it returned; their events
  // (L2ToL1Tx, and a SendMerkleUpdate for each level of the tree merged) are compared too. The programs of a block
  // run in turn on one tree, so they merge different numbers of levels from one run to the next.
  const word = (n: bigint | number) => BigInt(n).toString(16).padStart(64, '0'), DESTINATION = '00000000000000000000000000000000000000d5';
  const withdraw = `${toFunctionSelector('function withdrawEth(address)')}${word(BigInt(`0x${DESTINATION}`))}` as Hex;
  const send = (bytes: number) => `${toFunctionSelector('function sendTxToL1(address,bytes)')}${word(BigInt(`0x${DESTINATION}`))}${word(64)}${word(bytes)}${'5e'.repeat(bytes).padEnd(Math.ceil(bytes / 32) * 64, '0')}` as Hex;
  const sending = (label: string, data: Hex, value: bigint, op: 'CALL' | 'STATICCALL' | 'DELEGATECALL' | 'CALLCODE' = 'CALL'): Program => ({ precompile: true, label: `ArbSys.${label}`, code: caller(0x64, op), data, value });
  const ticket = word(0xdeadn);
  // What ArbOS checks before a method runs, which the chain's answer to a plain eth_call can't show: a method that
  // writes in a static call (or in a call made inside one), one that isn't pure in a delegate call or callcode,
  // value to one that isn't payable. The node's call fails with nothing and burns all it was given (a revert at
  // 1,600 for ArbFilteredTransactionsManager); a pure method runs in a delegate call.
  const called = (label: string, address: number, method: string, args: string, op: 'CALL' | 'STATICCALL' | 'DELEGATECALL' | 'CALLCODE', value?: bigint): Program =>
    ({ precompile: true, label, code: caller(address, op), data: `${toFunctionSelector(`function ${method}`)}${args}` as Hex, ...(value && { value }) });
  // A contract that STATICCALLs the one placed at INNER with its calldata and returns what it returned.
  const INNER = '00000000000000000000000000000000c0de7a11';
  const throughStatic = asm(`CALLDATASIZE 00 00 CALLDATACOPY 00 00 CALLDATASIZE 00 ${INNER} GAS STATICCALL POP RETURNDATASIZE 00 00 RETURNDATACOPY RETURNDATASIZE 00 RETURN`);
  return [
    ...of('ArbSys', 0x64, ['arbBlockNumber()', 'arbChainID()', 'arbOSVersion()', 'isTopLevelCall()', 'getStorageGasAvailable()']),
    // (Not getCurrentTxL1GasFees(): what it returns is the call's own, which differs between the two runs.)
    ...of('ArbGasInfo', 0x6c, ['getPricesInWei()', 'getL1BaseFeeEstimate()', 'getMinimumGasPrice()', 'getPricesInArbGas()', 'getGasAccountingParams()', 'getL1GasPriceEstimate()']),
    sending('withdrawEth, 1 wei', withdraw, 1n), sending('withdrawEth, nothing sent', withdraw, 0n), sending('sendTxToL1, no data', send(0), 0n),
    sending('sendTxToL1, 33 bytes and 7 wei', send(33), 7n), sending('sendTxToL1, 300 bytes', send(300), 0n),
    sending('withdrawEth in a static call', withdraw, 0n, 'STATICCALL'), sending('withdrawEth in a delegate call', withdraw, 0n, 'DELEGATECALL'), sending('withdrawEth with no argument', withdraw.slice(0, 10) as Hex, 0n),
    // ArbRetryableTx's writes of a ticket that doesn't exist (the node's NoTicketWithID(), at its price; one that
    // exists is refused locally); ArbFilteredTransactionsManager (0x74), ArbNativeTokenManager (0x73) and ArbosActs.
    ...['redeem(bytes32)', 'keepalive(bytes32)', 'cancel(bytes32)', 'getTimeout(bytes32)'].map(m => ({ precompile: true, label: `ArbRetryableTx.${m} of no ticket`, code: caller(0x6e, 'CALL'), data: `${toFunctionSelector(`function ${m}`)}${ticket}` as Hex })),
    { precompile: true, label: 'ArbFilteredTransactionsManager.isTransactionFiltered', code: caller(0x74), data: `${toFunctionSelector('function isTransactionFiltered(bytes32)')}${ticket}` as Hex },
    { precompile: true, label: 'ArbFilteredTransactionsManager.addFilteredTransaction (not a filterer)', code: caller(0x74, 'CALL'), data: `${toFunctionSelector('function addFilteredTransaction(bytes32)')}${ticket}` as Hex },
    { precompile: true, label: 'ArbNativeTokenManager.mintNativeToken', code: caller(0x73, 'CALL'), data: `${toFunctionSelector('function mintNativeToken(uint256)')}${word(1)}` as Hex },
    { precompile: true, label: 'ArbosActs.startBlock (not ArbOS)', code: caller(0xa4b05, 'CALL'), data: `${toFunctionSelector('function startBlock(uint256,uint64,uint64,uint64)')}${word(1)}${word(2)}${word(3)}${word(4)}` as Hex },
    called('ArbRetryableTx.redeem of no ticket in a static call', 0x6e, 'redeem(bytes32)', ticket, 'STATICCALL'),
    called('ArbRetryableTx.cancel of no ticket in a static call', 0x6e, 'cancel(bytes32)', ticket, 'STATICCALL'),
    { precompile: true, label: 'ArbRetryableTx.redeem of no ticket, by a call made inside a static call', code: throughStatic, data: `${toFunctionSelector('function redeem(bytes32)')}${ticket}` as Hex, state: { [`0x${INNER}`]: { code: caller(0x6e, 'CALL') } } },
    called('ArbRetryableTx.keepalive of no ticket in a delegate call', 0x6e, 'keepalive(bytes32)', ticket, 'DELEGATECALL'),
    called('ArbRetryableTx.getTimeout of no ticket in a delegate call', 0x6e, 'getTimeout(bytes32)', ticket, 'DELEGATECALL'),
    called('ArbRetryableTx.redeem of no ticket, 1 wei', 0x6e, 'redeem(bytes32)', ticket, 'CALL', 1n),
    called('ArbRetryableTx.getBeneficiary of no ticket, 1 wei', 0x6e, 'getBeneficiary(bytes32)', ticket, 'CALL', 1n),
    called('ArbSys.arbBlockHash of a future block, 1 wei', 0x64, 'arbBlockHash(uint256)', word(1n << 40n), 'CALL', 1n),
    called('ArbSys.arbBlockHash of a future block in a delegate call', 0x64, 'arbBlockHash(uint256)', word(1n << 40n), 'DELEGATECALL'),
    called('ArbSys.arbBlockNumber in a delegate call', 0x64, 'arbBlockNumber()', '', 'DELEGATECALL'),
    called('ArbSys.mapL1SenderContractAddressToL2Alias (pure) in a delegate call', 0x64, 'mapL1SenderContractAddressToL2Alias(address,address)', `${word(0xd5n)}${word(0xd5n)}`, 'DELEGATECALL'),
    called('ArbAddressTable.register in a static call', 0x66, 'register(address)', word(0xd5n), 'STATICCALL'),
    called('ArbFilteredTransactionsManager.isTransactionFiltered, 1 wei', 0x74, 'isTransactionFiltered(bytes32)', ticket, 'CALL', 1n),
    called('ArbFilteredTransactionsManager.isTransactionFiltered in a delegate call', 0x74, 'isTransactionFiltered(bytes32)', ticket, 'DELEGATECALL'),
    sending('withdrawEth by callcode', withdraw, 0n, 'CALLCODE'),
    // Errors a method raises keep what it wasn't charged, with no data as with data to decode (the node is asked
    // what each was charged): an address ArbAddressTable hasn't (1,603), an index too large for it (803), an
    // account that isn't a batch poster (1,603), a contract that isn't a Stylus program (ProgramNotActivated(), 4,306).
    called('ArbAddressTable.lookup of an address it hasn\'t', 0x66, 'lookup(address)', word(0xd5n), 'CALL'),
    called('ArbAddressTable.lookupIndex of 2^200', 0x66, 'lookupIndex(uint256)', word(1n << 200n), 'CALL'),
    called('ArbAggregator.getFeeCollector of an account that isn\'t a batch poster', 0x6d, 'getFeeCollector(address)', word(0xd5n), 'STATICCALL'),
    called('ArbWasm.programVersion of an account that isn\'t a program', 0x71, 'programVersion(address)', word(0xd5n), 'STATICCALL'),
    // Calldata to ArbRetryableTx's writes short of a ticket id, which ArbOS can't decode: the node's call burns all it
    // was given (refused locally as a ticket that exists, until 2026-11-15). 0x6a, where Arbitrum One lists no
    // precompile: an empty account, called with value, in a delegate call and by callcode (forwarded as ArbOS's, and
    // turned away, before). ArbosTest.burnArbGas of more than the call is given (10,000): all of it, and it succeeds.
    called('ArbRetryableTx.redeem with no argument', 0x6e, 'redeem(bytes32)', '', 'CALL'),
    called('ArbRetryableTx.cancel with 31 bytes of argument', 0x6e, 'cancel(bytes32)', ticket.slice(0, 62), 'CALL'),
    called('0x6a (no precompile) with 1 wei', 0x6a, 'foo()', '', 'CALL', 1n),
    called('0x6a (no precompile) in a delegate call', 0x6a, 'foo()', '', 'DELEGATECALL'),
    called('0x6a (no precompile) by callcode', 0x6a, 'foo()', '', 'CALLCODE'),
    { precompile: true, label: 'ArbosTest.burnArbGas of 20,000 on 10,000', code: caller(0x69, 'CALL', '2710'), data: `${toFunctionSelector('function burnArbGas(uint256)')}${word(20_000)}` as Hex },
    { precompile: true, label: 'ArbosTest.burnArbGas of 2^64 - 1 on 10,000, in a static call', code: caller(0x69, 'STATICCALL', '2710'), data: `${toFunctionSelector('function burnArbGas(uint256)')}${word((1n << 64n) - 1n)}` as Hex },
  ];
}

/**
 * BNB Chain's own precompiles (0x64 to 0x69: ChainProfile.ownPrecompiles), each from a contract that reports the gas
 * the call spent, with inputs either way: a BLS signature (one key, two aggregated, the wrong key, inputs it can't
 * read, which revert and give back the rest of the gas) and a secp256k1 one (a Tendermint key's address, or a
 * failure that takes all the gas), each made on the spot by keys made for the run; the light-client and evidence
 * checks with inputs they can't read; the two that are deprecated, which fail whatever they are given.
 */
function bnbPrograms(): Program[] {
  const hex = (b: Uint8Array) => Buffer.from(b).toString('hex'), of = (address: number, label: string, data: string): Program => ({ precompile: true, label: `0x${address.toString(16)} ${label}`, code: caller(address), data: `0x${data}` });
  const message = createHash('sha256').update('signing-preview rules check').digest();
  // BLS, as the chain's validators sign their votes: the proof-of-possession domain, keys in G1, signatures in G2.
  const DST = 'BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_POP_';
  const [k1, k2] = [bls12_381.utils.randomPrivateKey(), bls12_381.utils.randomPrivateKey()], [p1, p2] = [bls12_381.getPublicKey(k1), bls12_381.getPublicKey(k2)];
  const [s1, s2] = [bls12_381.sign(message, k1, { DST }), bls12_381.sign(message, k2, { DST })], both = bls12_381.aggregateSignatures([s1, s2]);
  // secp256k1, as a Tendermint key signs: a compressed key, r and s (s low), the 32-byte digest.
  const key = secp256k1.utils.randomPrivateKey(), signed = secp256k1.sign(message, key, { lowS: true }), pub = hex(secp256k1.getPublicKey(key, true));
  const rs = (s: bigint) => `${word(signed.r)}${word(s)}`;
  return [
    ...[0x64, 0x65].flatMap(a => [of(a, 'with no input', ''), of(a, '100 bytes', 'ab'.repeat(100))]),
    of(0x66, 'BLS, one key', `${hex(message)}${hex(s1)}${hex(p1)}`),
    of(0x66, 'BLS, two keys aggregated', `${hex(message)}${hex(both)}${hex(p1)}${hex(p2)}`),
    of(0x66, 'BLS, the wrong key', `${hex(message)}${hex(s1)}${hex(p2)}`),
    of(0x66, 'BLS, with no input', ''), of(0x66, 'BLS, 129 bytes', 'ab'.repeat(129)), of(0x66, 'BLS, three keys it can\'t read', 'ab'.repeat(128 + 3 * 48)),
    of(0x67, 'light block, with no input', ''), of(0x67, 'light block, 100 bytes', 'ab'.repeat(100)),
    of(0x68, 'double-sign evidence, with no input', ''), of(0x68, 'double-sign evidence, 1,000 bytes', 'ab'.repeat(1000)),
    of(0x69, 'secp256k1, a signature that holds', `${pub}${rs(signed.s)}${hex(message)}`),
    of(0x69, 'secp256k1, s high', `${pub}${rs(secp256k1.CURVE.n - signed.s)}${hex(message)}`),
    of(0x69, 'secp256k1, a byte more', `${pub}${rs(signed.s)}${hex(message)}00`),
  ];
}

/**
 * Base's own contracts, which its node runs in Rust and the local EVM from their Solidity references (B20 tokens,
 * their registries and factory: src/fork-simulator.ts, nativeStandIn), each called from a contract that reports the
 * gas the call spent, whether it succeeded and what it returned (called directly, a cheap call's price hides under
 * the calldata floor): a live token's reads and its EIP-712 functions, calls that fail each way, value sent, the
 * token's code as other contracts read it, an account delegated to one, the registries, and creations through the
 * factory. So a change Base makes to them shows here, as a price change on HyperEVM did.
 */
function b20Programs(): Program[] {
  const TOKEN = 'b200000000000000000000397293cb8cda9a10c5', POLICY = '8453000000000000000000000000000000000002', ACTIVATION = '8453000000000000000000000000000000000001', FACTORY = 'b20f000000000000000000000000000000000000';
  const callOf = (to: string, value = '00') => asm(`CALLDATASIZE 00 00 CALLDATACOPY GAS 00 00 CALLDATASIZE 00 ${value} ${to} GAS CALL GAS
    SWAP1 00 MSTORE SWAP1 SUB 20 MSTORE RETURNDATASIZE 40 MSTORE RETURNDATASIZE 00 80 RETURNDATACOPY RETURNDATASIZE 80 KECCAK256 60 MSTORE 80 00 RETURN`);
  const sel = (signature: string) => toFunctionSelector(`function ${signature}`);
  const addressWord = (a: string) => word(BigInt(`0x${a}`));
  const someone = FROM.slice(2), token = (label: string, data: Hex, value?: string): Program => ({ label: `B20 token ${label}`, code: callOf(TOKEN, value), data, ...(value && { balance: 1n }) });
  // createB20(variant, salt, params, initCalls), params an asset's or a stablecoin's (version 1).
  const text = (t: string) => `${word(t.length)}${Buffer.from(t).toString('hex').padEnd(Math.ceil(t.length / 32) * 64, '0')}`;
  const asset = (name: string, symbol: string, decimals: number) => `${word(32)}${word(1)}${word(160)}${word(160 + 32 + Math.ceil(name.length / 32) * 32)}${word(0)}${word(decimals)}${text(name)}${text(symbol)}`;
  const stablecoin = (name: string, symbol: string, currency: string) => { const n = 160 + 32 + Math.ceil(name.length / 32) * 32, c = n + 32 + Math.ceil(symbol.length / 32) * 32; return `${word(32)}${word(1)}${word(160)}${word(n)}${word(0)}${word(c)}${text(name)}${text(symbol)}${text(currency)}`; };
  const bytes = (hex: string) => `${word(hex.length / 2)}${hex.padEnd(Math.ceil(hex.length / 64) * 64, '0')}`;
  const create = (variant: number, params: string, initCalls: string[]) => {
    const p = bytes(params), offsets = initCalls.reduce<{ at: number[]; next: number }>((o, c) => ({ at: [...o.at, o.next], next: o.next + 32 + Math.ceil(c.length / 2 / 32) * 32 }), { at: [], next: 32 * initCalls.length });
    return `${sel('createB20(uint8,bytes32,bytes,bytes[])')}${word(variant)}${word(0x5a17n)}${word(128)}${word(128 + p.length / 2)}${p}${word(initCalls.length)}${offsets.at.map(word).join('')}${initCalls.map(bytes).join('')}` as Hex;
  };
  const mint = `${sel('mint(address,uint256)').slice(2)}${addressWord(someone)}${word(1000)}`;
  return [
    ...(['decimals()', 'name()', 'symbol()', 'totalSupply()', 'DOMAIN_SEPARATOR()', 'eip712Domain()', 'supplyCap()', 'pausedFeatures()'] as const).map(f => token(f, sel(f))),
    token('balanceOf (an address with none)', `${sel('balanceOf(address)')}${addressWord(someone)}` as Hex),
    token('allowance', `${sel('allowance(address,address)')}${addressWord(someone)}${addressWord(someone)}` as Hex),
    token('nonces', `${sel('nonces(address)')}${addressWord(someone)}` as Hex),
    token('hasRole', `${sel('hasRole(bytes32,address)')}${word(0)}${addressWord(someone)}` as Hex),
    token('transfer with no balance', `${sel('transfer(address,uint256)')}${addressWord(someone)}${word(1)}` as Hex),
    token('transfer to itself', `${sel('transfer(address,uint256)')}${addressWord(TOKEN)}${word(0)}` as Hex),
    token('permit, a signature that recovers to no one', `${sel('permit(address,address,uint256,uint256,uint8,bytes32,bytes32)')}${addressWord(someone)}${addressWord(someone)}${word(1)}${word(2n ** 40n)}${word(27)}${word(1)}${word(1)}` as Hex),
    token('permit, expired', `${sel('permit(address,address,uint256,uint256,uint8,bytes32,bytes32)')}${addressWord(someone)}${addressWord(someone)}${word(1)}${word(1)}${word(27)}${word(1)}${word(1)}` as Hex),
    token('a function it lacks', '0xdeadbeef'), token('calldata too short for a selector', '0x12'), token('transfer short of its arguments', sel('transfer(address,uint256)')),
    token('sent value', sel('decimals()'), '01'),
    { label: 'B20 token code as others read it (EXTCODESIZE, EXTCODEHASH)', code: asm(`${TOKEN} EXTCODESIZE 00 MSTORE ${TOKEN} EXTCODEHASH 20 MSTORE 40 00 RETURN`) },
    { label: 'B20 an account delegated to a token (EIP-7702) called', code: `0xef0100${TOKEN}` as Hex, data: sel('decimals()') },
    { label: 'B20 policy registry isAuthorized(0, someone)', code: callOf(POLICY), data: `${sel('isAuthorized(uint64,address)')}${word(0)}${addressWord(someone)}` as Hex },
    { label: 'B20 activation registry isActivated(B20 asset)', code: callOf(ACTIVATION), data: `${sel('isActivated(bytes32)')}cdcc772fe4cbdb1029f822861176d09e646db96723d4c1e82ddfdeb8163ef54c` as Hex },
    // (A write reads the activation registry's flag for the policy registry first: 2,100 more than base-std's reference.)
    { label: 'B20 policy registry createPolicy(someone, ALLOWLIST)', code: callOf(POLICY), data: `${sel('createPolicy(address,uint8)')}${addressWord(someone)}${word(1)}` as Hex },
    { label: 'B20 policy registry renounceAdmin of no policy (PolicyNotFound)', code: callOf(POLICY), data: `${sel('renounceAdmin(uint64)')}${word((1n << 56n) | 0xffffffn)}` as Hex },
    { label: 'B20 factory creating an asset, minted', code: callOf(FACTORY), data: create(0, asset('Rules Check', 'RULES', 18), [mint]) },
    { label: 'B20 factory creating a stablecoin', code: callOf(FACTORY), data: create(1, stablecoin('Rules Dollar', 'RUSD', 'USD'), []) },
    { label: 'B20 factory, decimals out of range', code: callOf(FACTORY), data: create(0, asset('Rules Check', 'RULES', 5), []) },
    { label: 'B20 factory, an init call the token lacks', code: callOf(FACTORY), data: create(0, asset('Rules Check', 'RULES', 18), ['deadbeef']) },
  ];
}

/**
 * Base's NonceManager and TxContext (EIP-8130's, from its upgrade of 2026-11-05), which its node runs in Rust and
 * the local EVM as measured (src/fork-simulator.ts, BASE_AA_PRECOMPILES), each from a contract that reports the gas
 * the call spent: a nonce read cold, warm and on another key, one stored and one too large for a uint64 (the slots
 * given on both sides), one read after another transaction called it, key 0, calldata it can't decode each way, a
 * gas short, value sent, run as another's code, and each TxContext function, with a transaction straight to each.
 * So a change Base makes to them shows the next day.
 */
function baseAaPrograms(): Program[] {
  const NONCE_MANAGER = '813000000000000000000000000000000000aa01', TX_CONTEXT = '813000000000000000000000000000000000aa02';
  const callOf = (to: string, { kind = 'STATICCALL', value = '00', gas = 'GAS', twice = false }: { kind?: 'STATICCALL' | 'CALL' | 'DELEGATECALL' | 'CALLCODE'; value?: string; gas?: string; twice?: boolean } = {}) => {
    const call = kind === 'STATICCALL' || kind === 'DELEGATECALL' ? `00 00 CALLDATASIZE 00 ${to} ${gas} ${kind}` : `00 00 CALLDATASIZE 00 ${value} ${to} ${gas} ${kind}`;
    return asm(`CALLDATASIZE 00 00 CALLDATACOPY ${twice ? `${call} POP ` : ''}GAS ${call} GAS
      SWAP1 00 MSTORE SWAP1 SUB 20 MSTORE RETURNDATASIZE 40 MSTORE RETURNDATASIZE 00 80 RETURNDATACOPY RETURNDATASIZE 80 KECCAK256 60 MSTORE 80 00 RETURN`);
  };
  const sel = (signature: string) => toFunctionSelector(`function ${signature}`);
  const someone = word(BigInt(FROM));
  const getNonce = (key: bigint, account = someone) => `${sel('getNonce(address,uint256)')}${account}${word(key)}` as Hex;
  // nonces[account][key] in NonceManager's storage (ERC-7201's base.nonce_manager): a nonce of 7 on key 7, and a
  // value over 64 bits on key 8. One state for the programs that read them (a batch's states are merged account by
  // account), each first in its block: the account has no code, nonce or balance, so once a transaction has called
  // it the node removes it as empty, storage and all, and a later one reads 0 (the third program shows it).
  const LOCATION = '9d3ea32ad25774a46482ebbae019e8da4242109d164d324a59aa787515b9fe00';
  const slot = (key: bigint) => keccak256(`0x${word(key)}${keccak256(`0x${someone}${LOCATION}`).slice(2)}`);
  const stored: StateChanges = { [`0x${NONCE_MANAGER}`]: { stateDiff: { [slot(7n)]: `0x${word(7)}`, [slot(8n)]: `0x${word(1n << 64n)}` } } };
  const nonces = (label: string, data: Hex, how?: Parameters<typeof callOf>[1], more?: Partial<Program>): Program => ({ precompile: true, label: `Base NonceManager ${label}`, code: callOf(NONCE_MANAGER, how), data, ...more });
  const context = (label: string, data: Hex, how?: Parameters<typeof callOf>[1], more?: Partial<Program>): Program => ({ precompile: true, label: `Base TxContext ${label}`, code: callOf(TX_CONTEXT, how), data, ...more });
  return [
    nonces('getNonce(someone, 1), a key never used (read cold)', getNonce(1n)),
    nonces('getNonce twice, the second read warm', getNonce(2n), { twice: true }),
    nonces('getNonce of another key after one (cold again)', getNonce(3n), undefined, { code: asm(`CALLDATASIZE 00 00 CALLDATACOPY 01 43 MSTORE8 00 00 44 00 ${NONCE_MANAGER} GAS STATICCALL POP 03 43 MSTORE8 GAS 00 00 44 00 ${NONCE_MANAGER} GAS STATICCALL GAS
      SWAP1 00 MSTORE SWAP1 SUB 20 MSTORE RETURNDATASIZE 40 MSTORE RETURNDATASIZE 00 80 RETURNDATACOPY RETURNDATASIZE 80 KECCAK256 60 MSTORE 80 00 RETURN`) }),
    nonces('getNonce(someone, 0): the protocol nonce', getNonce(0n)),
    nonces('getNonce of a nonce stored (7)', getNonce(7n), undefined, { state: stored, first: true }),
    nonces('getNonce of the nonce stored, after a transaction that called it (the empty account removed)', getNonce(7n), undefined, { state: stored }),
    nonces('getNonce of a value over 64 bits stored', getNonce(8n), undefined, { state: stored, first: true }),
    nonces('getNonce, a key of all ones', getNonce((1n << 256n) - 1n)),
    nonces('getNonce with 64 bytes more', `${getNonce(1n)}${word(0)}${word(5)}` as Hex),
    nonces('getNonce short of its arguments', `${sel('getNonce(address,uint256)')}${someone}` as Hex),
    nonces("getNonce with an address's upper bytes set", getNonce(1n, `${'ff'.repeat(12)}${someone.slice(24)}`)),
    nonces('a function it lacks, 100 bytes', `0xdeadbeef${'00'.repeat(96)}`),
    nonces('calldata too short for a selector', '0x895358'),
    nonces('no calldata', '0x'),
    nonces('getNonce given 2,117 gas (runs out)', getNonce(1n), { gas: '0845' }),
    nonces('getNonce given 2,118 gas', getNonce(1n), { gas: '0846' }),
    nonces('getNonce(someone, 0) given 17 gas (runs out)', getNonce(0n), { gas: '11' }),
    nonces('getNonce sent value', getNonce(1n), { kind: 'CALL', value: '01' }, { balance: 1n }),
    nonces("getNonce run as the caller's code (DELEGATECALL)", getNonce(1n), { kind: 'DELEGATECALL' }),
    nonces("getNonce run as the caller's code with value (CALLCODE)", getNonce(1n), { kind: 'CALLCODE', value: '01' }, { balance: 1n }),
    nonces('getNonce through CALL', getNonce(1n), { kind: 'CALL' }),
    { label: 'Base NonceManager getNonce, a transaction straight to it', to: `0x${NONCE_MANAGER}`, data: getNonce(1n) },
    ...(['getTransactionSender()', 'getTransactionPayer()', 'getTransactionSenderActorId()'] as const).map(f => context(f, sel(f))),
    context('getTransactionSender() with 64 bytes more', `${sel('getTransactionSender()')}${word(1)}${word(2)}` as Hex),
    // (EIP-8130's other two functions, which Base's node hasn't.)
    context('getTransactionCalls()', sel('getTransactionCalls()')), context('getTransactionGasLimit()', sel('getTransactionGasLimit()')),
    context('calldata too short for a selector', '0xbead3f'), context('no calldata', '0x'),
    context('getTransactionSender() given 2 gas (runs out)', sel('getTransactionSender()'), { gas: '02' }),
    context('getTransactionSender() given 3 gas', sel('getTransactionSender()'), { gas: '03' }),
    context('getTransactionSender() sent value', sel('getTransactionSender()'), { kind: 'CALL', value: '01' }, { balance: 1n }),
    context("getTransactionSender() run as the caller's code (DELEGATECALL)", sel('getTransactionSender()'), { kind: 'DELEGATECALL' }),
    { label: 'Base TxContext getTransactionSender(), a transaction straight to it', to: `0x${TX_CONTEXT}`, data: sel('getTransactionSender()') },
  ];
}

/**
 * Creation and an account's life, which the programs above reach only in passing: a CREATE2 onto an account that
 * has only a nonce, a balance, storage (EIP-7610) or code; code that starts with 0xEF (EIP-3541); code and initcode
 * either side of the chain's limits, from a contract and in a creation; a creator's nonce at 2^64 - 1 (EIP-2681);
 * SELFDESTRUCT of a contract created in the same transaction and of one created before (EIP-6780), to another
 * account and to itself, with what is left of it in the next transaction; accounts touched and left empty
 * (EIP-161), and EXTCODEHASH of accounts of each kind; value sent to the precompiles; CREATE in a static call;
 * RETURNDATASIZE after a creation that fails each way; the nonce a created contract starts with; creations by an
 * account delegated under EIP-7702; and what each chain's own system addresses read as. Each returns what it found
 * (addresses, sizes, hashes, balances), so a difference in state shows as one in what is returned. `sequel` programs
 * read what one before them in the same block did, and run where the node runs a block (not HyperEVM's eth_call).
 */
async function lifecyclePrograms(chainId: number, amsterdam: boolean, which: 'agree' | 'findings' = 'agree'): Promise<Program[]> {
  const profile = CHAIN_PROFILES[chainId];
  const at = (k: number) => (0xc1fe0000 + k).toString(16).padStart(40, '0'), fresh = (k: number) => (0xc1fe8000 + k).toString(16).padStart(40, '0');
  const lit = (n: number | bigint) => { const t = BigInt(n).toString(16); return t.length % 2 ? `0${t}` : t; };
  /** Each expression leaves a word: stored in turn from memory 0, and returned. */
  const out = (...exprs: string[]) => asm(`${exprs.map((e, i) => `${e} ${lit(32 * i)} MSTORE`).join(' ')} ${lit(32 * exprs.length)} 00 RETURN`);
  /** asm putting `hex` in memory from `offset`, a word at a time. */
  const inMemory = (hex: string, offset = 0) => Array.from({ length: Math.ceil(hex.length / 64) }, (_, i) => `${hex.slice(64 * i, 64 * i + 64).padEnd(64, '0')} ${lit(offset + 32 * i)} MSTORE`).join(' ');
  const create = (init: string, value = '00') => `${inMemory(init)} ${lit(init.length / 2)} 00 ${value} CREATE`;
  const create2 = (init: string, salt: string, value = '00') => `${inMemory(init)} ${salt} ${lit(init.length / 2)} 00 ${value} CREATE2`;
  /** Initcode that runs `prefix` (raw code), then returns `runtime` as the new contract's code. */
  const deploying = (runtime: string, prefix = '') => `${prefix}61${(runtime.length / 2).toString(16).padStart(4, '0')}8061${(prefix.length / 2 + 13).toString(16).padStart(4, '0')}6000396000f3${runtime}`;
  const created = (from: string, nonce: bigint) => getContractAddress({ from: `0x${from}`, nonce }).slice(2).toLowerCase();
  const created2 = (from: string, salt: number, init: string) => getContractAddress({ opcode: 'CREATE2', from: `0x${from}`, salt: `0x${word(salt)}`, bytecode: `0x${init}` }).slice(2).toLowerCase();
  const raw = (source: string) => asm(source).slice(2);
  const TEN = '600a6000f3'; // initcode: ten zero bytes of code
  const MAX_CODE = profile.maxCodeSize ?? 24_576, MAX_INIT = amsterdam ? 131_072 : 49_152;
  const sized = (n: number) => `62${n.toString(16).padStart(6, '0')}6000f3`; // initcode: n zero bytes of code
  // A contract that, called with an address, destroys itself to it; called with nothing, returns its slot 1 and its balance.
  const K = '366013576001546000524760205260406000f35b600035ff', INIT_K = deploying(K, '6005600155');
  const kill = (k: string, to: string) => `${to} 0200 MSTORE 00 00 20 0200 00 ${k} GAS CALL`;
  const slotOf = (k: string) => `40 0300 00 00 00 ${k} GAS CALL POP 0300 MLOAD`;
  const IDENTITY = '2a 00 MSTORE 20 00 20 00 04 GAS STATICCALL POP';
  const copied = 'RETURNDATASIZE 00 0400 RETURNDATACOPY 0400 MLOAD';
  const DELEGATION = (to: string) => `0xef0100${to}`;
  const MAX_NONCE = '0xffffffffffffffff';
  const programs: Program[] = [], findings: Program[] = [];
  const add = (p: Program) => programs.push(p);
  // Programs on which the local EVM differed from every node (or differs from some, for the node's own reasons): run
  // alone with --family lifecycle-findings. Those the local EVM now runs as every node does (a contract created and
  // destroyed in one transaction, the calls a block starts with, since 2026-11-16) are in the check too, after the
  // rest, in their own order (their sequels read what the ones before them left); a node's own quirk isn't (`quirk`).
  const differs = (p: Program & { quirk?: true }) => findings.push(p);

  // CREATE2 onto an account that already holds something (only the address's own fields given, on both sides).
  const onto = (k: number, label: string, target: StateChanges[string], init = TEN) => {
    const F = at(k), T = created2(F, 0x2a, init);
    add({ label: `CREATE2 onto an account with ${label}`, to: `0x${F}`, code: out(create2(init, '2a', '03'), 'RETURNDATASIZE', `${T} EXTCODESIZE`, `${T} BALANCE`, `${T} EXTCODEHASH`), balance: 10n, state: { [`0x${T}`]: target } });
  };
  onto(1, 'a nonce only', { nonce: '0x1' });
  onto(2, 'a balance only', { balance: '0x7' });
  onto(3, 'code only', { code: '0x00' });
  onto(4, 'an EIP-7702 delegation', { code: DELEGATION('00000000000000000000000000000000c0de7704') });
  onto(5, 'a nonce and a balance', { nonce: '0x2', balance: '0x7' });
  // (Its constructor logs its balance, and its slot 1: what a creation onto a balance, or onto storage, starts from.)
  const LOGGING = raw('01 SLOAD 00 MSTORE SELFBALANCE 20 MSTORE 40 00 LOG0 00 00 RETURN');
  onto(6, 'a balance only, its constructor logging what it holds', { balance: '0x7' }, LOGGING);
  // (Storage only, EIP-7610: no node refuses it, an override's storage not moving the account's storage root; geth's
  // (Polygon's, some of Sepolia's) let the constructor read the slot the override set, as the local EVM and revm's don't.)
  { const F = at(7), T = created2(F, 0x2a, LOGGING); differs({ quirk: true, label: 'CREATE2 onto an account with storage only (EIP-7610), its constructor logging slot 1', to: `0x${F}`, code: out(create2(LOGGING, '2a', '03'), 'RETURNDATASIZE', `${T} EXTCODESIZE`, `${T} BALANCE`, `${T} EXTCODEHASH`), balance: 10n, state: { [`0x${T}`]: { stateDiff: { [`0x${word(1)}`]: `0x${word(5)}` } } } }); }
  // Twice with one salt in one transaction: the second collides with the first.
  add({ label: 'CREATE2 twice with one salt', to: `0x${at(8)}`, code: out(create2(TEN, '2a'), create2(TEN, '2a'), 'RETURNDATASIZE') });

  // Code that starts with 0xEF (EIP-3541), from a contract and in a creation; 0xFE and no code at all are fine.
  const made = (k: number, label: string, init: string, how: 'CREATE' | 'CREATE2' = 'CREATE') => {
    const F = at(k), A = how === 'CREATE' ? created(F, 0n) : created2(F, 0x2a, init);
    add({ label, to: `0x${F}`, code: out(how === 'CREATE' ? create(init) : create2(init, '2a'), 'RETURNDATASIZE', `${A} EXTCODESIZE`, `${A} EXTCODEHASH`) });
  };
  made(10, 'CREATE of the code 0xef', '60ef60005360016000f3');
  made(11, 'CREATE of the code 0xef00', '61ef006000526002601ef3');
  made(12, 'CREATE2 of the code 0xef', '60ef60005360016000f3', 'CREATE2');
  made(13, 'CREATE of the code 0xfe', '60fe60005360016000f3');
  made(14, 'CREATE of no code (the account has a nonce: EXTCODEHASH is the empty code\'s)', '00');
  made(15, 'CREATE from initcode that starts with 0xef', `ef${TEN}`);
  add({ label: 'a creation of the code 0xef', create: true, data: '0x60ef60005360016000f3' });
  add({ label: 'a creation of the code 0xfe', create: true, data: '0x60fe60005360016000f3' });
  add({ label: 'a creation of no code', create: true, data: '0x00' });
  add({ label: 'a creation of ten bytes of code', create: true, data: `0x${TEN}` });

  // Code and initcode either side of the chain's limits (Polygon's code limit is its own; under Amsterdam the code
  // limit's deposit is more than a node's simulation allows, so only the initcode's).
  if (!amsterdam) {
    made(20, `CREATE of ${MAX_CODE} bytes of code (the limit)`, sized(MAX_CODE));
    made(21, `CREATE of ${MAX_CODE + 1} bytes of code`, sized(MAX_CODE + 1));
    for (const p of programs.slice(-2)) p.gas = 8_000_000n;
    add({ label: `a creation of ${MAX_CODE} bytes of code (the limit)`, create: true, data: `0x${sized(MAX_CODE)}`, gas: 8_000_000n });
    add({ label: `a creation of ${MAX_CODE + 1} bytes of code`, create: true, data: `0x${sized(MAX_CODE + 1)}`, gas: 8_000_000n });
  }
  add({ label: `CREATE from ${MAX_INIT} bytes of initcode (the limit)`, to: `0x${at(22)}`, code: out(`${lit(MAX_INIT)} 00 00 CREATE`, 'RETURNDATASIZE') });
  add({ label: `CREATE from ${MAX_INIT + 1} bytes of initcode`, to: `0x${at(23)}`, code: out(`${lit(MAX_INIT + 1)} 00 00 CREATE`, 'RETURNDATASIZE') });
  add({ label: `CREATE2 from ${MAX_INIT + 1} bytes of initcode`, to: `0x${at(24)}`, code: out(`2a ${lit(MAX_INIT + 1)} 00 00 CREATE2`, 'RETURNDATASIZE') });
  add({ label: `a creation from ${MAX_INIT} bytes of initcode (the limit)`, create: true, data: `0x${'00'.repeat(MAX_INIT)}`, gas: amsterdam ? 16_000_000n : 2_000_000n });

  // A creator's nonce at 2^64 - 1 (EIP-2681): its CREATE and CREATE2 fail, keeping the gas; one below, one succeeds.
  const P30 = at(30), P31 = at(31), P32 = at(32), P33 = at(33);
  add({ label: 'CREATE by an account whose nonce is 2^64 - 1', to: `0x${P30}`, state: { [`0x${P30}`]: { code: out(create(TEN), 'RETURNDATASIZE'), nonce: MAX_NONCE } } });
  add({ label: 'CREATE2 by an account whose nonce is 2^64 - 1', to: `0x${P31}`, state: { [`0x${P31}`]: { code: out(create2(TEN, '2a'), 'RETURNDATASIZE'), nonce: MAX_NONCE } } });
  add({ label: 'two CREATEs by an account whose nonce is 2^64 - 2', to: `0x${P32}`, state: { [`0x${P32}`]: { code: out(create(TEN), create(TEN), `${created(P32, (1n << 64n) - 2n)} EXTCODESIZE`), nonce: '0xfffffffffffffffe' } } });
  add({ label: 'RETURNDATASIZE after a CREATE refused for its nonce (2^64 - 1), after a call that returned a word', to: `0x${P33}`, state: { [`0x${P33}`]: { code: out(`${IDENTITY} ${create(TEN)}`, 'RETURNDATASIZE'), nonce: MAX_NONCE } } });

  // SELFDESTRUCT (EIP-6780): of a contract created before, which keeps its code and storage and gives its balance
  // away (to itself: keeps it); of one created in the same transaction, which goes at the transaction's end. What
  // the transaction itself sees, then (sequels) what the next one does. Old ones are given K's code, 100 wei and slot 1 = 5.
  const old = (k: number, balance = '0x64') => ({ [`0x${at(k)}`]: { code: `0x${K}`, balance, stateDiff: { [`0x${word(1)}`]: `0x${word(5)}` } } });
  const O1 = at(40), B1 = fresh(40), O2 = at(43), F3 = at(46), N3 = created2(F3, 0x11, INIT_K), B3 = fresh(46), F4 = at(48), N4 = created2(F4, 0x12, INIT_K);
  add({ first: true, label: 'SELFDESTRUCT of a contract created before, to an account that does not exist', to: `0x${at(41)}`, code: out(kill(O1, B1), slotOf(O1), '0320 MLOAD', `${O1} EXTCODESIZE`, `${B1} BALANCE`), state: old(40) });
  add({ sequel: true, label: 'the next transaction: the contract destroyed before keeps its code and storage', to: `0x${at(42)}`, code: out(`${O1} EXTCODESIZE`, `${O1} BALANCE`, `${B1} BALANCE`, slotOf(O1), `${O1} EXTCODEHASH`) });
  add({ label: 'SELFDESTRUCT of a contract created before, to itself', to: `0x${at(44)}`, code: out(kill(O2, O2), slotOf(O2), '0320 MLOAD', `${O2} EXTCODESIZE`), state: old(43) });
  add({ sequel: true, label: 'the next transaction: the contract destroyed before, to itself, keeps all', to: `0x${at(45)}`, code: out(`${O2} EXTCODESIZE`, `${O2} BALANCE`, slotOf(O2)) });
  const SAME3 = out(create2(INIT_K, '11', '32'), kill(N3, B3), slotOf(N3), '0320 MLOAD', `${N3} EXTCODESIZE`, `${B3} BALANCE`);
  add({ label: 'SELFDESTRUCT of a contract created in the same transaction, to an account that does not exist', to: `0x${F3}`, code: SAME3, balance: 100n });
  // (The local EVM kept a contract created and destroyed in one transaction past its end, before 2026-11-16: the sequels that read it differed.)
  differs({ first: true, label: 'SELFDESTRUCT of a contract created in the same transaction, to an account that does not exist', to: `0x${F3}`, code: SAME3, balance: 100n });
  differs({ sequel: true, label: 'the next transaction: the contract created and destroyed is gone', to: `0x${at(47)}`, code: out(`${N3} EXTCODESIZE`, `${N3} EXTCODEHASH`, `${N3} BALANCE`, slotOf(N3), 'RETURNDATASIZE') });
  differs({ sequel: true, label: 'the next transaction: the contract created and destroyed is created again at its address', to: `0x${F3}`, code: SAME3, balance: 100n });
  add({ label: 'SELFDESTRUCT of a contract created in the same transaction, to itself', to: `0x${F4}`, code: out(create2(INIT_K, '12', '32'), kill(N4, N4), slotOf(N4), '0320 MLOAD', `${N4} BALANCE`, `${N4} EXTCODESIZE`), balance: 100n });
  differs({ label: 'SELFDESTRUCT of a contract created in the same transaction, to itself', to: `0x${F4}`, code: out(create2(INIT_K, '12', '32'), kill(N4, N4), slotOf(N4), '0320 MLOAD', `${N4} BALANCE`, `${N4} EXTCODESIZE`), balance: 100n });
  differs({ sequel: true, label: 'the next transaction: the contract created and destroyed to itself is gone', to: `0x${at(49)}`, code: out(`${N4} EXTCODESIZE`, `${N4} BALANCE`, `${N4} EXTCODEHASH`) });
  // Destroyed by its own constructor, giving 30 wei to an account that does not exist: an account with a nonce of 1 and nothing else, until the transaction ends.
  const F5 = at(50), B5 = fresh(50), INIT_5 = `73${B5}ff`, N5 = created2(F5, 0x13, INIT_5);
  const SAME5 = out(create2(INIT_5, '13', '1e'), `${N5} EXTCODESIZE`, `${N5} EXTCODEHASH`, `${N5} BALANCE`, `${B5} BALANCE`);
  add({ first: true, label: 'SELFDESTRUCT in its constructor, to an account that does not exist', to: `0x${F5}`, code: SAME5, balance: 100n });
  differs({ label: 'SELFDESTRUCT in its constructor, to an account that does not exist', to: `0x${F5}`, code: SAME5, balance: 100n });
  differs({ sequel: true, label: 'the next transaction: the contract destroyed in its constructor is gone', to: `0x${at(51)}`, code: out(`${N5} EXTCODEHASH`, `${N5} EXTCODESIZE`, `${B5} BALANCE`) });
  // (And what is sent to such a contract after it destroyed itself goes with it: burnt.)
  const F7 = at(147), N7 = created2(F7, 0x16, INIT_K);
  differs({ label: 'a wei sent to a contract created and destroyed in the same transaction, after it was destroyed', to: `0x${F7}`, code: out(create2(INIT_K, '16', '32'), kill(N7, fresh(147)), `00 00 00 00 07 ${N7} GAS CALL`, `${N7} BALANCE`), balance: 100n });
  differs({ sequel: true, label: 'the next transaction: what was sent to the destroyed contract is gone with it', to: `0x${at(148)}`, code: out(`${N7} BALANCE`, `${N7} EXTCODESIZE`) });
  differs({ sequel: true, label: 'the next transaction: the contract destroyed in its constructor is created again at its address', to: `0x${F5}`, code: SAME5, balance: 100n });
  // A contract created by one transaction and destroyed by the next keeps its code and storage (it wasn't created in
  // the transaction that destroys it); one created and destroyed in a transaction can't be created again in it.
  const F6 = at(140), N6 = created2(F6, 0x14, INIT_K), F8 = at(141), N8 = created2(F8, 0x15, INIT_K);
  add({ first: true, label: 'a contract created, to be destroyed by the next transaction', to: `0x${F6}`, code: out(create2(INIT_K, '14', '32'), `${N6} EXTCODESIZE`), balance: 100n });
  add({ sequel: true, label: 'the next transaction: SELFDESTRUCT of the contract the one before created', to: `0x${at(142)}`, code: out(kill(N6, fresh(140)), slotOf(N6), '0320 MLOAD', `${N6} EXTCODESIZE`, `${fresh(140)} BALANCE`) });
  add({ sequel: true, label: 'the transaction after: the contract destroyed a transaction after its creation keeps its code and storage', to: `0x${at(143)}`, code: out(`${N6} EXTCODESIZE`, `${N6} BALANCE`, slotOf(N6), `${N6} EXTCODEHASH`) });
  add({ label: 'CREATE2 again, in the same transaction, of a contract created and destroyed in it', to: `0x${F8}`, code: out(create2(INIT_K, '15', '32'), kill(N8, fresh(141)), create2(INIT_K, '15'), `${N8} EXTCODESIZE`, 'RETURNDATASIZE'), balance: 100n });
  // An account delegated under EIP-7702 to code that destroys itself: its balance goes, its delegation and nonce stay.
  const D9 = fresh(142);
  add({ label: 'SELFDESTRUCT by an account delegated to code that destroys itself', to: `0x${at(144)}`, code: out(kill(D9, fresh(143)), `${D9} BALANCE`, `${D9} EXTCODESIZE`, `${fresh(143)} BALANCE`), state: { [`0x${D9}`]: { code: DELEGATION(at(145)), balance: '0x64', nonce: '0x3' }, [`0x${at(145)}`]: { code: `0x${K}` } } });
  add({ sequel: true, label: 'the next transaction: the delegated account that destroyed itself keeps its delegation', to: `0x${at(146)}`, code: out(`${D9} EXTCODESIZE`, `${D9} EXTCODEHASH`, `${D9} BALANCE`) });
  add({ label: 'SELFDESTRUCT in a static call', to: `0x${at(53)}`, code: out(`${B1} 0200 MSTORE 00 00 20 0200 ${at(52)} GAS STATICCALL`, `${at(52)} BALANCE`, 'RETURNDATASIZE'), state: old(52) });
  add({ label: 'SELFDESTRUCT with no balance, to an account that does not exist', to: `0x${at(55)}`, code: out(kill(at(54), fresh(54)), `${fresh(54)} EXTCODEHASH`, `${fresh(54)} BALANCE`, `${at(54)} EXTCODESIZE`), state: old(54, '0x0') });
  add({ label: 'SELFDESTRUCT with a balance, to the identity precompile', to: `0x${at(57)}`, code: out('04 BALANCE', kill(at(56), '04'), '04 BALANCE'), state: old(56) });

  // Accounts touched and left empty (EIP-161), and EXTCODEHASH of accounts of each kind.
  add({ first: true, label: 'a call with no value to an account that does not exist, then its BALANCE, EXTCODEHASH, EXTCODESIZE', to: `0x${at(60)}`, code: out(`00 00 00 00 00 ${fresh(60)} GAS CALL`, `${fresh(60)} BALANCE`, `${fresh(60)} EXTCODEHASH`, `${fresh(60)} EXTCODESIZE`) });
  add({ sequel: true, label: 'the next transaction: the account touched and left empty', to: `0x${at(61)}`, code: out(`${fresh(60)} EXTCODEHASH`, `${fresh(60)} BALANCE`) });
  add({ label: 'a call with a wei to an account that does not exist, then its BALANCE and EXTCODEHASH', to: `0x${at(62)}`, code: out(`00 00 00 00 01 ${fresh(62)} GAS CALL`, `${fresh(62)} BALANCE`, `${fresh(62)} EXTCODEHASH`), balance: 10n });
  add({ sequel: true, label: 'the next transaction: the account a wei was sent to', to: `0x${at(63)}`, code: out(`${fresh(62)} EXTCODEHASH`, `${fresh(62)} BALANCE`) });
  add({ label: 'an account given a balance of 0, then a wei sent to it', to: `0x${at(64)}`, code: out(`${fresh(64)} EXTCODEHASH`, `${fresh(64)} BALANCE`, `00 00 00 00 01 ${fresh(64)} GAS CALL`, `${fresh(64)} EXTCODEHASH`), balance: 10n, state: { [`0x${fresh(64)}`]: { balance: '0x0' } } });
  add({ label: 'an account with a nonce only, then a wei sent to it', to: `0x${at(65)}`, code: out(`${fresh(65)} EXTCODEHASH`, `00 00 00 00 01 ${fresh(65)} GAS CALL`, `${fresh(65)} BALANCE`), balance: 10n, state: { [`0x${fresh(65)}`]: { nonce: '0x1' } } });
  add({ label: 'an account with storage only, then a wei sent to it', to: `0x${at(66)}`, code: out(`${fresh(66)} EXTCODEHASH`, `00 00 00 00 01 ${fresh(66)} GAS CALL`, `${fresh(66)} EXTCODEHASH`), balance: 10n, state: { [`0x${fresh(66)}`]: { stateDiff: { [`0x${word(1)}`]: `0x${word(5)}` } } } });
  const LOW = [...Array.from({ length: 0x11 }, (_, i) => i + 1), 0x100];
  add({ label: 'EXTCODEHASH of each precompile', to: `0x${at(67)}`, code: out(...LOW.map(a => `${lit(a)} EXTCODEHASH`)) });
  add({ label: 'EXTCODESIZE of each precompile', to: `0x${at(68)}`, code: out(...LOW.map(a => `${lit(a)} EXTCODESIZE`)) });
  add({ label: 'BALANCE of each precompile', to: `0x${at(69)}`, code: out(...LOW.map(a => `${lit(a)} BALANCE`)) });
  add({ label: 'EXTCODEHASH of the zero address, the sender, the account itself and one that does not exist', to: `0x${at(70)}`, code: out('00 EXTCODEHASH', 'CALLER EXTCODEHASH', 'ADDRESS EXTCODEHASH', `${fresh(70)} EXTCODEHASH`) });
  add({ label: 'precompiles touched by a call with no value, then their EXTCODEHASH', to: `0x${at(71)}`, code: out('00 00 00 00 00 0b GAS CALL', '0b EXTCODEHASH', '00 00 00 00 00 0100 GAS CALL', '0100 EXTCODEHASH', '00 00 00 00 00 01 GAS CALL', '01 EXTCODEHASH') });

  // Value sent to the precompiles: a wei each, with no input (the call's gas, a new account's included where the
  // precompile holds nothing), and the balance before and after.
  for (const n of LOW) add({ precompile: true, label: `0x${n.toString(16)} with a wei and no input`, code: caller(n, 'CALL'), data: '0x', value: 1n });
  for (const [k, n] of [[72, 1], [73, 4], [74, 9], [75, 0x0a], [76, 0x100]] as const) add({ label: `BALANCE of 0x${n.toString(16)} before and after a wei sent to it`, to: `0x${at(k)}`, code: out(`${lit(n)} BALANCE`, `00 00 00 00 01 ${lit(n)} GAS CALL`, `${lit(n)} BALANCE`), balance: 10n });

  // CREATE in a static call, directly and from a call or delegate call made inside one.
  const S1 = at(80), S2 = at(82), S3 = at(84), S4 = at(86);
  const statics: StateChanges = { [`0x${S1}`]: { code: out('00 00 00 CREATE') }, [`0x${S2}`]: { code: out('00 00 00 00 CREATE2') }, [`0x${S3}`]: { code: out(`00 00 00 00 00 ${S1} GAS CALL`, 'RETURNDATASIZE') }, [`0x${S4}`]: { code: out(`00 00 00 00 ${S1} GAS DELEGATECALL`) } };
  add({ label: 'CREATE in a static call', to: `0x${at(81)}`, code: out(`00 00 00 00 ${S1} GAS STATICCALL`, 'RETURNDATASIZE'), state: statics });
  add({ label: 'CREATE2 in a static call', to: `0x${at(83)}`, code: out(`00 00 00 00 ${S2} GAS STATICCALL`, 'RETURNDATASIZE'), state: statics });
  add({ label: 'CREATE in a call made inside a static call', to: `0x${at(85)}`, code: out(`40 0300 00 00 ${S3} GAS STATICCALL`, '0300 MLOAD', '0320 MLOAD', 'RETURNDATASIZE'), state: statics });
  add({ label: 'CREATE in a delegate call made inside a static call', to: `0x${at(87)}`, code: out(`20 0300 00 00 ${S4} GAS STATICCALL`, '0300 MLOAD'), state: statics });
  add({ label: 'the same CREATE in a plain call', to: `0x${at(88)}`, code: out(`20 0300 00 00 00 ${S1} GAS CALL`, '0300 MLOAD'), state: statics });

  // RETURNDATASIZE (and what RETURNDATACOPY gives) after a CREATE that fails each way, some after a call that returned a word.
  const after = (k: number, label: string, expr: string, more: Partial<Program> = {}) => add({ label: `RETURNDATASIZE after ${label}`, to: `0x${at(k)}`, code: out(expr, 'RETURNDATASIZE', copied), balance: 10n, ...more });
  after(90, 'a CREATE whose initcode reverts with a word', create('602a60005260206000fd'));
  after(91, 'a CREATE2 whose initcode reverts with two words', create2('602a60005260406000fd', '2a'));
  after(92, 'a CREATE whose initcode reverts with nothing, after a call that returned a word', `${IDENTITY} ${create('60006000fd')}`);
  after(93, 'a CREATE whose initcode hits INVALID', create('fe'));
  after(94, 'a CREATE of more than the account holds, after a call that returned a word', `${IDENTITY} ${create(TEN, '03e8')}`);
  after(95, 'a CREATE that succeeds, after a call that returned a word', `${IDENTITY} ${create(TEN)}`);
  after(96, 'a CREATE2 that collides, after a call that returned a word', `${create2(TEN, '2a')} POP ${IDENTITY} ${create2(TEN, '2a')}`);
  after(97, 'a CREATE of the code 0xef, after a call that returned a word', `${IDENTITY} ${create('60ef60005360016000f3')}`);
  after(98, 'a CREATE whose initcode runs out of gas, after a call that returned a word', `${IDENTITY} ${create('5b600056')}`);
  after(99, 'a CREATE whose initcode makes a call that returns a word, after a call that returned a word', `${IDENTITY} ${create(raw(`${IDENTITY} 00 00 RETURN`))}`);
  if (!amsterdam) after(100, `a CREATE of ${MAX_CODE + 1} bytes of code, after a call that returned a word`, `${IDENTITY} ${create(sized(MAX_CODE + 1))}`, { gas: 8_000_000n });

  // The nonce a created contract starts with (1, EIP-161), its creator's after a CREATE that fails each way.
  const CHILD = raw(`${create(TEN)} 00 MSTORE 20 00 LOG0 00 00 RETURN`);
  add({ label: 'a constructor that creates a contract and logs its address (its creator\'s nonce: 1)', to: `0x${at(101)}`, code: out(create(CHILD), 'RETURNDATASIZE') });
  const C102 = created(at(102), 0n), MAKER = out(create(TEN));
  add({ label: 'a created contract that creates twice when called', to: `0x${at(102)}`, code: out(create(deploying(MAKER.slice(2))), `20 0300 00 00 00 ${C102} GAS CALL POP 0300 MLOAD`, `20 0300 00 00 00 ${C102} GAS CALL POP 0300 MLOAD`, `${created(C102, 1n)} EXTCODESIZE`) });
  add({ label: 'a creation whose constructor creates a contract and logs its address', create: true, data: `0x${CHILD}` });
  add({ label: 'a constructor whose first CREATE reverts, then creates and logs the address', to: `0x${at(103)}`, code: out(create(raw(`${create('60006000fd')} POP ${create(TEN)} 00 MSTORE 20 00 LOG0 00 00 RETURN`))) });
  add({ label: 'a CREATE of more than the account holds, then one that succeeds (the nonce unmoved)', to: `0x${at(104)}`, code: out(create(TEN, '03e8'), create(TEN), `${created(at(104), 0n)} EXTCODESIZE`), balance: 10n });
  add({ label: 'a CREATE whose initcode reverts, then one that succeeds (the nonce moved)', to: `0x${at(105)}`, code: out(create('60006000fd'), create(TEN), `${created(at(105), 1n)} EXTCODESIZE`) });
  // A creation sent by an account with a nonce of its own, onto an address that already has code, and onto one with a balance.
  const S110 = fresh(110), S111 = fresh(111);
  add({ label: 'a creation onto an address that has code', create: true, from: `0x${S110}`, data: `0x${TEN}`, state: { [`0x${S110}`]: { nonce: '0x7' }, [`0x${created(S110, 7n)}`]: { code: '0x00' } } });
  add({ label: 'a creation onto an address that has a balance, its constructor logging what it holds', create: true, from: `0x${S111}`, data: `0x${LOGGING}`, value: 5n, state: { [`0x${S111}`]: { nonce: '0x3', balance: '0x10' }, [`0x${created(S111, 3n)}`]: { balance: '0x7' } } });

  // Creations by an account delegated under EIP-7702 (HyperEVM follows a delegation too): from its own nonce, by a
  // call into it and by a transaction it sends itself (its nonce goes up first), CREATE2's address its own; at a nonce
  // of 2^64 - 1. And by an authority whose authorization comes in the same transaction (its nonce one up by then).
  const FACT = at(120), FACT2 = at(121), D1 = fresh(120), D2 = fresh(121), D3 = fresh(122), D4 = fresh(123);
  const factories: StateChanges = { [`0x${FACT}`]: { code: out(create(TEN)) }, [`0x${FACT2}`]: { code: out(create2(TEN, '2a')) } };
  add({ label: 'CREATE by a delegated account, called twice', to: `0x${at(122)}`, code: out(`20 0300 00 00 00 ${D1} GAS CALL POP 0300 MLOAD`, `20 0300 00 00 00 ${D1} GAS CALL POP 0300 MLOAD`, `${created(D1, 6n)} EXTCODESIZE`), state: { ...factories, [`0x${D1}`]: { nonce: '0x5', code: DELEGATION(FACT) } } });
  add({ label: 'CREATE by a delegated account, in a transaction it sends itself', from: `0x${D2}`, to: `0x${D2}`, state: { ...factories, [`0x${D2}`]: { nonce: '0x5', code: DELEGATION(FACT) } } });
  add({ label: 'CREATE2 by a delegated account', to: `0x${at(123)}`, code: out(`20 0300 00 00 00 ${D3} GAS CALL POP 0300 MLOAD`), state: { ...factories, [`0x${D3}`]: { code: DELEGATION(FACT2) } } });
  add({ label: 'CREATE by a delegated account whose nonce is 2^64 - 1', to: `0x${at(124)}`, code: out(`20 0300 00 00 00 ${D4} GAS CALL`, '0300 MLOAD'), state: { ...factories, [`0x${D4}`]: { nonce: MAX_NONCE, code: DELEGATION(FACT) } } });
  if (profile.hardfork !== 'cancun') {
    const authorization = async (key: Hex, nonce: number, delegate: string) => {
      const a = await privateKeyToAccount(key).signAuthorization({ contractAddress: `0x${delegate}`, chainId, nonce });
      return { address: `0x${delegate}`, chainId: `0x${chainId.toString(16)}`, nonce: `0x${nonce.toString(16)}`, r: a.r, s: a.s, yParity: `0x${(a.yParity ?? 0).toString(16)}` };
    };
    const one = generatePrivateKey(), self = generatePrivateKey(), oneAt = privateKeyToAccount(one).address.toLowerCase(), selfAt = privateKeyToAccount(self).address.toLowerCase();
    add({ label: 'CREATE by an account its authorization delegates in the same transaction', to: oneAt, authorizationList: [await authorization(one, 0, FACT)], state: factories });
    // An authority delegated in the transaction to code that destroys itself isn't a contract created in it: it stays.
    const gone = generatePrivateKey(), goneAt = privateKeyToAccount(gone).address.toLowerCase();
    add({ first: true, label: 'SELFDESTRUCT by an account its authorization delegates in the same transaction', to: goneAt, data: `0x${word(BigInt(`0x${fresh(149)}`))}`, authorizationList: [await authorization(gone, 0, at(149))], state: { [`0x${at(149)}`]: { code: `0x${K}` } } });
    add({ sequel: true, label: 'the next transaction: the account delegated and destroyed in one transaction keeps its delegation and nonce', to: `0x${at(150)}`, code: out(`${goneAt.slice(2)} EXTCODESIZE`, `${goneAt.slice(2)} EXTCODEHASH`), state: { [`0x${at(149)}`]: { code: `0x${K}` } } });
    add({ label: 'CREATE by an account that delegates itself in a transaction it sends itself', from: selfAt, to: selfAt, authorizationList: [await authorization(self, 1, FACT)], state: factories });
  }

  // What each chain's own system addresses read as: BALANCE, EXTCODESIZE and EXTCODEHASH (cold or warm, by the gas).
  // (`moving`: accounts whose balance changes in nearly every block, read without it where the node answers on its
  // latest block whatever block is named: HyperEVM's HYPE system address and WHYPE.)
  const read = (label: string, addresses: string[], moving: string[] = []) => { for (let i = 0; i < addresses.length; i += 8) add({ first: true, label: `${label}${addresses.length > 8 ? ` (${i / 8 + 1})` : ''}: BALANCE, EXTCODESIZE, EXTCODEHASH`, to: `0x${at(130 + programs.length)}`, code: out(...addresses.slice(i, i + 8).flatMap(a => [...(moving.includes(a) ? [] : [`${a} BALANCE`]), `${a} EXTCODESIZE`, `${a} EXTCODEHASH`])) }); };
  const pad = (a: string) => a.replace(/^0x/, '').toLowerCase().padStart(40, '0');
  read('the system contracts of EIP-4788, 2935, 7002 and 7251, and the system address', ['0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02', '0x0000F90827F1C53a10cb7A02335B175320002935', '0x00000961Ef480Eb55e80D19ad83579A64c007002', '0x0000BBdDc7CE488642fb579F8B00f3a590007251', '0xfffffffffffffffffffffffffffffffffffffffe'].map(pad));
  if (profile.arbitrum) read("ArbOS's precompiles and accounts", [...[0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6b, 0x6c, 0x6d, 0x6e, 0x6f, 0x70, 0x71, 0x72, 0x73, 0x74, 0xff, 0xc8, 0xa4b05].map(n => n.toString(16)), 'a4b05fffffffffffffffffffffffffffffffffff', 'a4b000000000000000000073657175656e636572'].map(pad));
  if (chainId === 10 || chainId === 8453) read('the OP Stack predeploys and depositor', ['0x4200000000000000000000000000000000000015', '0x4200000000000000000000000000000000000011', '0x4200000000000000000000000000000000000019', '0x420000000000000000000000000000000000001a', '0x420000000000000000000000000000000000001b', '0x420000000000000000000000000000000000000f', '0x4200000000000000000000000000000000000016', '0xdeaddeaddeaddeaddeaddeaddeaddeaddead0001'].map(pad));
  if (chainId === 8453) read("Base's own precompiles and contracts", ['0x813000000000000000000000000000000000aa01', '0x813000000000000000000000000000000000aa02', '0xb20f000000000000000000000000000000000000', '0x8453000000000000000000000000000000000001', '0x8453000000000000000000000000000000000002', '0xb200000000000000000000397293cb8cda9a10c5'].map(pad));
  if (chainId === 56) read("BNB Chain's system contracts and precompiles", [...[0x1000, 0x1001, 0x1002, 0x1003, 0x1004, 0x1005, 0x1006, 0x1007, 0x1008, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005].map(n => n.toString(16)), ...[0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x70].map(n => n.toString(16))].map(pad));
  if (chainId === 137) read("Polygon's system contracts", ['1000', '1001', '1010'].map(pad));
  if (chainId === 999) read("HyperEVM's system addresses and precompiles", ['2222222222222222222222222222222222222222', '3333333333333333333333333333333333333333', '5555555555555555555555555555555555555555', '2000000000000000000000000000000000000000', '2000000000000000000000000000000000000001', ...Array.from({ length: 0x11 }, (_, i) => (0x800 + i).toString(16))].map(pad), ['2222222222222222222222222222222222222222', '5555555555555555555555555555555555555555']);
  // Value to each chain's own precompiles and system addresses, with no input.
  const callerAt = (target: string) => asm(`CALLDATASIZE 00 00 CALLDATACOPY GAS 00 00 CALLDATASIZE 00 CALLVALUE ${target} GAS CALL GAS
    SWAP1 00 MSTORE SWAP1 SUB 20 MSTORE RETURNDATASIZE 40 MSTORE RETURNDATASIZE 00 80 RETURNDATACOPY RETURNDATASIZE 80 KECCAK256 60 MSTORE 80 00 RETURN`);
  const own = chainId === 56 ? [0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x70].map(n => pad(n.toString(16))) : chainId === 999 ? ['0800', '0801', '0807', '2222222222222222222222222222222222222222', '3333333333333333333333333333333333333333'].map(pad) : chainId === 137 ? [pad('1010')] : chainId === 8453 || chainId === 10 ? [pad('0x4200000000000000000000000000000000000015'), pad('0x4200000000000000000000000000000000000019')] : [];
  for (const a of own) add({ precompile: true, label: `${a.replace(/^0+/, '0x')} with a wei and no input`, code: callerAt(a), data: '0x', value: 1n });

  // EIP-2935's history contract asked for the block before (stored as the simulated block starts) and the one before
  // that; EIP-4788's beacon roots for the block's own time. Where a chain has neither, an empty account.
  const HISTORY = pad('0x0000F90827F1C53a10cb7A02335B175320002935'), BEACON = pad('0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02');
  if (chainId !== 999) {
    // (The local EVM didn't make the calls a block starts with, before 2026-11-16: the parent's hash and beacon root weren't written.)
    differs({ label: "EIP-2935's history contract, asked for the block before", to: `0x${at(126)}`, code: out(`01 NUMBER SUB 0200 MSTORE 20 0300 20 0200 ${HISTORY} GAS STATICCALL`, '0300 MLOAD', '01 NUMBER SUB BLOCKHASH', 'RETURNDATASIZE') });
    add({ label: "EIP-2935's history contract, asked for the block two before", to: `0x${at(127)}`, code: out(`02 NUMBER SUB 0200 MSTORE 20 0300 20 0200 ${HISTORY} GAS STATICCALL`, '0300 MLOAD', '02 NUMBER SUB BLOCKHASH', 'RETURNDATASIZE') });
    differs({ label: "EIP-4788's beacon roots contract, asked for the block's own time", to: `0x${at(128)}`, code: out(`TIMESTAMP 0200 MSTORE 20 0300 20 0200 ${BEACON} GAS STATICCALL`, '0300 MLOAD', 'RETURNDATASIZE') });
  }
  // The OP Stack's L1Block predeploy, which its node writes at each block's start (a deposit), and what the gas price
  // oracle makes of it: read as the chain's state has them.
  if (chainId === 10 || chainId === 8453) {
    const L1_BLOCK = '4200000000000000000000000000000000000015', ORACLE = '420000000000000000000000000000000000000f';
    const view = (to: string, selector: string) => `${selector} e0 SHL 0200 MSTORE 20 0300 04 0200 ${to} GAS STATICCALL POP 0300 MLOAD`;
    add({ first: true, label: "L1Block's number, timestamp, basefee, hash, sequence number and blob base fee", to: `0x${at(129)}`, code: out(...['8381f58a', 'b80777ea', '5cf24969', '09bd5a60', '64ca23ef', 'f8206140'].map(f => view(L1_BLOCK, f))) });
    add({ label: "the gas price oracle's gasPrice, baseFeeScalar, isEcotone, isFjord, isIsthmus", to: `0x${at(131)}`, code: out(...['fe173b97', 'c5985918', '4ef6e224', '960e3a23', 'b54501bc'].map(f => view(ORACLE, f))) });
  }
  // Programs that burn all (or nearly all) the gas they are given are given it by name: on Arbitrum, whose node takes
  // its L1 charge out of a call's gas, such a program's gas differs from the local EVM's by a few units, not by the
  // charge, and is left uncompared there (a batch of mostly such programs had put the charge at 8, and the rest off by 482).
  const BURNS = /static call|collides|onto an account with (a nonce|code|an EIP-7702)|twice with one salt|code 0xef|starts with 0xef|hits INVALID|runs out of gas|touched by a call|BALANCE of 0x(9|a) |bytes of code|bytes of initcode|onto an address that has code|again, in the same transaction/;
  for (const p of [...programs, ...findings]) if (BURNS.test(p.label)) p.gas ??= GAS;
  return which === 'agree' ? [...programs, ...findings.filter(p => !(p as { quirk?: true }).quirk)] : findings;
}

/**
 * The block's context and the system contracts that ordinary contracts read, per chain: BLOCKHASH near the edges of
 * its window; EIP-2935's history contract (Arbitrum's own, which takes ArbSys's L2 block numbers) at depths from 1
 * to past its window and with input it refuses; EIP-4788's beacon roots at the block's own time, its parent's, one it
 * never kept, and with input it refuses; the block's values read in a creation; EIP-7002's and EIP-7251's request
 * contracts; OP Stack's L1Block and GasPriceOracle predeploys; Polygon's and BNB Chain's system contracts; HyperEVM's
 * HYPE system address and CoreWriter. Each call from a contract that returns whether it succeeded, the gas it spent
 * and what came back. Not what the block writes as it starts (EIP-2935's parent hash, EIP-4788's root at the block's
 * own time): the local EVM doesn't make those system calls (2026-11-16), so it answers otherwise.
 */
function contextPrograms(chainId: number): Program[] {
  const RET = '00 MSTORE 20 00 RETURN', profile = CHAIN_PROFILES[chainId], blockTime = NEXT_BLOCK[chainId]?.blockTime ?? 12;
  const even = (n: bigint | number) => { const h = n.toString(16); return h.length % 2 ? `0${h}` : h; };
  const HISTORY = '0000f90827f1c53a10cb7a02335b175320002935', BEACON_ROOTS = '000f3df6d732807ef1319fb7b8bb8522d0beac02';
  const hasHistory = profile.hardfork !== 'cancun', hasBeaconRoots = [1, 11155111, 10, 8453].includes(chainId);
  // `setup` leaves the call's input at memory 0; the call takes `length` bytes of it. Returns three words (success,
  // gas spent, bytes returned) and the bytes.
  const report = (setup: string, length: string, to: string, op: 'STATICCALL' | 'CALL' | 'DELEGATECALL' = 'STATICCALL', value = '00') => asm(`${setup} GAS 00 00 ${length} 00 ${op === 'CALL' ? `${value} ` : ''}${to} GAS ${op} GAS
    SWAP1 00 MSTORE SWAP1 SUB 20 MSTORE RETURNDATASIZE 40 MSTORE RETURNDATASIZE 00 60 RETURNDATACOPY RETURNDATASIZE 60 ADD 00 RETURN`);
  const passing = (to: string, op: 'STATICCALL' | 'CALL' = 'STATICCALL', value = '00') => report('CALLDATASIZE 00 00 CALLDATACOPY', 'CALLDATASIZE', to, op, value);
  const sel = (signature: string) => toFunctionSelector(`function ${signature}`);
  /** A selector and a word as a call's input at memory 0 (36 bytes). */
  const withWord = (signature: string, value: string) => `${sel(signature).slice(2)} e0 SHL 00 MSTORE ${value} 04 MSTORE`;
  const bytesArg = (hex: string) => `${word(32)}${word(hex.length / 2)}${hex.padEnd(Math.ceil(hex.length / 64) * 64, '0')}`;
  const programs: Program[] = [];
  // BLOCKHASH: the hash itself, and whether there is one (HyperEVM's node runs a later block than the one named, so
  // there the hashes can't match, but the window does).
  const blockhash = (label: string, n: string) => programs.push({ label: `BLOCKHASH ${label}`, code: asm(`${n} BLOCKHASH ${RET}`) }, { label: `BLOCKHASH ${label}, whether there is one`, code: asm(`${n} BLOCKHASH ISZERO ${RET}`) });
  blockhash('of the current block', 'NUMBER');
  blockhash('2 blocks back', '02 NUMBER SUB');
  blockhash('255 blocks back', 'ff NUMBER SUB');
  blockhash('256 blocks back', '0100 NUMBER SUB');
  blockhash('257 blocks back', '0101 NUMBER SUB');
  blockhash('of the next block', '01 NUMBER ADD');
  blockhash('of block 0', '00');
  blockhash('of 2^256 - 1', 'ff'.repeat(32));
  blockhash('of the block before plus 2^64', '01 NUMBER SUB 010000000000000000 ADD');
  programs.push({ label: 'BLOCKHASH of the block before, whether there is one', code: asm(`01 NUMBER SUB BLOCKHASH ISZERO ${RET}`) });
  // The block's values as a constructor reads them, in a creation inside the call (which reverts with them):
  // coinbase, time, number, randomness, gas limit, chain id, base fee, and the blob base fee where the chain has it.
  const values = ['COINBASE', 'TIMESTAMP', 'NUMBER', 'PREVRANDAO', 'GASLIMIT', 'CHAINID', 'BASEFEE', ...((profile.missingOpcodes ?? []).includes(0x4a) ? [] : ['BLOBBASEFEE'])];
  const init = asm(`${values.map((v, i) => `${v} ${even(i * 32)} MSTORE`).join(' ')} ${even(values.length * 32)} 00 REVERT`).slice(2);
  const initWords = init.match(/.{1,64}/g)!.map(w => w.padEnd(64, '0'));
  programs.push({ label: "the block's values read by a constructor (in a CREATE)", code: asm(`${initWords.map((w, i) => `${w} ${even(i * 32)} MSTORE`).join(' ')} ${even(init.length / 2)} 00 00 CREATE POP RETURNDATASIZE 00 00 RETURNDATACOPY RETURNDATASIZE 00 RETURN`) });
  // EIP-2935's history: a block's hash by number, from the contract. Arbitrum's takes its own (L2) block numbers,
  // which ArbSys.arbBlockNumber() gives, and keeps 393,168 of them; the others NUMBER, and 8,191.
  if (hasHistory) {
    const number = profile.arbitrum ? 'a3b1b31d 00 MSTORE 20 00 04 1c 64 GAS STATICCALL POP 00 MLOAD' : 'NUMBER';
    const window = profile.arbitrum ? 393_168n : 8_191n;
    const back = (d: bigint) => `${even(d)} ${number} SUB 00 MSTORE`;
    const history = (label: string, setup: string, length = '20', op?: 'CALL' | 'DELEGATECALL', more?: Partial<Program>) => programs.push({ label: `EIP-2935 history ${label}`, code: report(setup, length, HISTORY, op, '01'), ...more });
    // (Not the block before's, nor with value: the chain writes it as the block starts, EIP-2935's system call, which
    // the local EVM doesn't make, so it answers what the slot held 8,191 blocks earlier. See the audit's repro.)
    history('2 blocks back', back(2n));
    history('256 blocks back', back(256n));
    history('257 blocks back', back(257n));
    history('of the oldest block it keeps', back(window));
    history('one block older than it keeps', back(window + 1n));
    history('of the current block', `${number} 00 MSTORE`);
    history('of the next block', `01 ${number} ADD 00 MSTORE`);
    history('of block 0', '00 00 MSTORE');
    history('of the block before plus 2^64', `01 ${number} SUB 010000000000000000 ADD 00 MSTORE`);
    history('of the block before, 31 bytes of input', back(1n), '1f');
    history('of the block before, 33 bytes of input', back(1n), '21');
    history('with no input', '', '00');
    history('2 blocks back, 1 wei sent', back(2n), '20', 'CALL', { balance: 10n });
    history('of the block before, by DELEGATECALL', back(1n), '20', 'DELEGATECALL');
    // And whether its answer and BLOCKHASH's agree, two blocks back (written before the block the call runs in).
    if (!profile.arbitrum) programs.push({ label: 'EIP-2935 history and BLOCKHASH agree, 2 blocks back', code: asm(`${back(2n)} 20 00 20 00 ${HISTORY} GAS STATICCALL POP 00 MLOAD 02 NUMBER SUB BLOCKHASH EQ ${RET}`) });
  } else programs.push({ label: 'EIP-2935 history of the block before (no such contract)', code: report('01 NUMBER SUB 00 MSTORE', '20', HISTORY) });
  // EIP-4788's beacon roots, by time: the block's own (written as the block starts), the block before's (in the
  // state the block starts from: its time less the time between blocks as simulated), one never kept, and input it
  // refuses. Where the chain has no such contract, an empty account.
  const beacon = (label: string, setup: string, length = '20') => programs.push({ label: `EIP-4788 beacon root ${label}`, code: report(setup, length, BEACON_ROOTS) });
  // (Not at the block's own time where the chain has the contract: the chain writes that root as the block starts,
  // EIP-4788's system call, which the local EVM doesn't make, so its call reverts. See the audit's repro.)
  if (!hasBeaconRoots) beacon("at the block's own time", 'TIMESTAMP 00 MSTORE');
  else {
    beacon('at the time of the block before', `${hex2(blockTime)} TIMESTAMP SUB 00 MSTORE`);
    beacon('at time 1 (never kept)', '01 00 MSTORE');
    beacon('at time 0', '00 00 MSTORE');
    beacon('a second after the block', '01 TIMESTAMP ADD 00 MSTORE');
    beacon("at the block's own time, 31 bytes of input", 'TIMESTAMP 00 MSTORE', '1f');
    beacon("at the block's own time, 33 bytes of input", 'TIMESTAMP 00 MSTORE', '21');
    beacon('with no input', '', '00');
  }
  // EIP-7002's withdrawal requests and EIP-7251's consolidation requests (Ethereum and its testnet): the fee, a
  // request that pays it (read first, then sent), one that pays nothing, and input of the wrong length.
  if (chainId === 1 || chainId === 11155111) {
    const WITHDRAWALS = '00000961ef480eb55e80d19ad83579a64c007002', CONSOLIDATIONS = '0000bbddc7ce488642fb579f8b00f3a590007251';
    const feeFirst = (to: string) => `20 0200 00 00 ${to} GAS STATICCALL POP`;
    const pubkeyAndAmount = `${'ab'.repeat(32)} 00 MSTORE ${'ab'.repeat(16)}0000000000000001${'00'.repeat(8)} 20 MSTORE`, twoPubkeys = `${'cd'.repeat(32)} 00 MSTORE ${'cd'.repeat(32)} 20 MSTORE ${'ef'.repeat(32)} 40 MSTORE`;
    const rich = { balance: 10n ** 18n };
    programs.push({ label: 'EIP-7002 withdrawal request fee', code: report('', '00', WITHDRAWALS) });
    programs.push({ label: 'EIP-7002 withdrawal request, the fee paid', code: report(`${feeFirst(WITHDRAWALS)} ${pubkeyAndAmount}`, '38', WITHDRAWALS, 'CALL', '0200 MLOAD'), ...rich });
    programs.push({ label: 'EIP-7002 withdrawal request, no fee', code: report(pubkeyAndAmount, '38', WITHDRAWALS, 'CALL', '00'), ...rich });
    programs.push({ label: 'EIP-7002 withdrawal request, 55 bytes', code: report(`${feeFirst(WITHDRAWALS)} ${pubkeyAndAmount}`, '37', WITHDRAWALS, 'CALL', '0200 MLOAD'), ...rich });
    programs.push({ label: 'EIP-7251 consolidation request fee', code: report('', '00', CONSOLIDATIONS) });
    programs.push({ label: 'EIP-7251 consolidation request, the fee paid', code: report(`${feeFirst(CONSOLIDATIONS)} ${twoPubkeys}`, '60', CONSOLIDATIONS, 'CALL', '0200 MLOAD'), ...rich });
    programs.push({ label: 'EIP-7251 consolidation request, 95 bytes', code: report(`${feeFirst(CONSOLIDATIONS)} ${twoPubkeys}`, '5f', CONSOLIDATIONS, 'CALL', '0200 MLOAD'), ...rich });
  }
  // OP Stack's L1Block and GasPriceOracle predeploys: every view, the L1 fee of a few payloads, the operator fee, and
  // the writes only the chain may make.
  if (chainId === 10 || chainId === 8453) {
    const L1_BLOCK = '4200000000000000000000000000000000000015', ORACLE = '420000000000000000000000000000000000000f';
    for (const f of ['number()', 'timestamp()', 'basefee()', 'hash()', 'sequenceNumber()', 'batcherHash()', 'l1FeeOverhead()', 'l1FeeScalar()', 'blobBaseFee()', 'baseFeeScalar()', 'blobBaseFeeScalar()', 'operatorFeeScalar()', 'operatorFeeConstant()', 'daFootprintGasScalar()', 'version()', 'DEPOSITOR_ACCOUNT()', 'gasPayingToken()', 'gasPayingTokenName()', 'gasPayingTokenSymbol()', 'isCustomGasToken()', 'setL1BlockValuesJovian()'])
      programs.push({ label: `OP Stack L1Block.${f}`, code: passing(L1_BLOCK, f.startsWith('set') ? 'CALL' : 'STATICCALL'), data: sel(f) });
    for (const f of ['DECIMALS()', 'decimals()', 'gasPrice()', 'baseFee()', 'overhead()', 'scalar()', 'l1BaseFee()', 'blobBaseFee()', 'baseFeeScalar()', 'blobBaseFeeScalar()', 'isEcotone()', 'isFjord()', 'isIsthmus()', 'isJovian()', 'version()', 'setJovian()'])
      programs.push({ label: `OP Stack GasPriceOracle.${f}`, code: passing(ORACLE, f.startsWith('set') ? 'CALL' : 'STATICCALL'), data: sel(f) });
    programs.push({ label: 'OP Stack GasPriceOracle.gasPrice(), in a call that pays for its gas', code: passing(ORACLE), data: sel('gasPrice()'), priced: true });
    // Payloads: none, 100 bytes that compress well, 600 that don't (a hash chain), a transaction's 110 bytes.
    let link: Hex = keccak256('0x01'), noise = '';
    for (let i = 0; i < 19; i++) { noise += link.slice(2); link = keccak256(link); }
    const payloads: [string, string][] = [['no bytes', ''], ['100 bytes alike', '11'.repeat(100)], ['600 bytes of noise', noise.slice(0, 1200)], ["a transaction's 110 bytes", `02f86b0a8203e8843b9aca00850df847580082520894${'ab'.repeat(20)}880de0b6b3a764000080c001a0${'cd'.repeat(32)}`.slice(0, 220)]];
    for (const [name, bytes] of payloads) {
      programs.push({ label: `OP Stack GasPriceOracle.getL1Fee of ${name}`, code: passing(ORACLE), data: `${sel('getL1Fee(bytes)')}${bytesArg(bytes)}` as Hex });
      programs.push({ label: `OP Stack GasPriceOracle.getL1GasUsed of ${name}`, code: passing(ORACLE), data: `${sel('getL1GasUsed(bytes)')}${bytesArg(bytes)}` as Hex });
    }
    for (const n of [0, 100, 150_000]) programs.push({ label: `OP Stack GasPriceOracle.getL1FeeUpperBound(${n})`, code: passing(ORACLE), data: `${sel('getL1FeeUpperBound(uint256)')}${word(n)}` as Hex });
    for (const n of [21_000, 1_000_000]) programs.push({ label: `OP Stack GasPriceOracle.getOperatorFee(${n})`, code: passing(ORACLE), data: `${sel('getOperatorFee(uint256)')}${word(n)}` as Hex });
  }
  // Polygon's system contracts: its native token's contract (0x1010), the validator set (by block) and the state receiver.
  if (chainId === 137) {
    const MRC20 = '0000000000000000000000000000000000001010', VALIDATORS = '0000000000000000000000000000000000001000', RECEIVER = '0000000000000000000000000000000000001001';
    for (const f of ['name()', 'symbol()', 'decimals()', 'totalSupply()', 'token()', 'owner()', 'currentSupply()', 'CHAINID()', 'networkId()', 'EIP712_DOMAIN_HASH()'])
      programs.push({ label: `Polygon MRC20 (0x1010).${f}`, code: passing(MRC20), data: sel(f) });
    programs.push({ label: 'Polygon MRC20 (0x1010).balanceOf(the sender)', code: passing(MRC20), data: `${sel('balanceOf(address)')}${word(BigInt(FROM))}` as Hex });
    programs.push({ label: 'Polygon MRC20 (0x1010).balanceOf(an empty account)', code: passing(MRC20), data: `${sel('balanceOf(address)')}${word(0xbeef078n)}` as Hex });
    programs.push({ label: 'Polygon MRC20 (0x1010).transfer of 1 wei, sent the wei', code: passing(MRC20, 'CALL', '01'), data: `${sel('transfer(address,uint256)')}${word(0xbeefn)}${word(1)}` as Hex, balance: 10n });
    programs.push({ label: 'Polygon MRC20 (0x1010).transfer of 2 wei, sent 1', code: passing(MRC20, 'CALL', '01'), data: `${sel('transfer(address,uint256)')}${word(0xbeefn)}${word(2)}` as Hex, balance: 10n });
    for (const f of ['currentSpanNumber()', 'getCurrentSpan()', 'getNextSpan()', 'currentSprint()', 'getValidators()', 'FIRST_END_BLOCK()'])
      programs.push({ label: `Polygon validator set (0x1000).${f}`, code: passing(VALIDATORS), data: sel(f) });
    programs.push({ label: 'Polygon validator set (0x1000).getBorValidators(the block)', code: report(withWord('getBorValidators(uint256)', 'NUMBER'), '24', VALIDATORS) });
    programs.push({ label: 'Polygon validator set (0x1000).getSpanByBlock(the block)', code: report(withWord('getSpanByBlock(uint256)', 'NUMBER'), '24', VALIDATORS) });
    for (const f of ['lastStateId()', 'SYSTEM_ADDRESS()', 'leafCount()'])
      programs.push({ label: `Polygon state receiver (0x1001).${f}`, code: passing(RECEIVER), data: sel(f) });
  }
  // BNB Chain's: the validator set (0x1000), the slash indicator (0x1001) and the stake hub (0x2002).
  if (chainId === 56) {
    const VALIDATORS = '0000000000000000000000000000000000001000', SLASH = '0000000000000000000000000000000000001001', STAKE_HUB = '0000000000000000000000000000000000002002';
    for (const f of ['getValidators()', 'getMiningValidators()', 'getLivingValidators()', 'getTurnLength()', 'numOfCabinets()', 'maxNumOfWorkingCandidates()', 'totalInComing()', 'getWorkingValidatorCount()'])
      programs.push({ label: `BNB Chain validator set (0x1000).${f}`, code: passing(VALIDATORS), data: sel(f) });
    programs.push({ label: 'BNB Chain validator set (0x1000).isCurrentValidator(the fee recipient)', code: report(withWord('isCurrentValidator(address)', 'COINBASE'), '24', VALIDATORS) });
    programs.push({ label: 'BNB Chain slash indicator (0x1001).getSlashThresholds()', code: passing(SLASH), data: sel('getSlashThresholds()') });
    for (const [f, args] of [['getValidators(uint256,uint256)', `${word(0)}${word(5)}`], ['minSelfDelegationBNB()', ''], ['maxElectedValidators()', ''], ['unbondPeriod()', ''], ['isPaused()', ''], ['transferGasLimit()', '']] as const)
      programs.push({ label: `BNB Chain stake hub (0x2002).${f}`, code: passing(STAKE_HUB), data: `${sel(f)}${args}` as Hex });
  }
  // HyperEVM's HYPE system address (a transfer to it reaches HyperCore: an event) and CoreWriter (an action for
  // HyperCore, after a loop that burns gas), and HyperCore's L1 block number.
  if (chainId === 999) {
    const HYPE = '2222222222222222222222222222222222222222', CORE_WRITER = '3333333333333333333333333333333333333333';
    programs.push({ label: 'HyperEVM HYPE system address, 1 wei sent', code: report('', '00', HYPE, 'CALL', '01'), balance: 10n });
    programs.push({ label: 'HyperEVM HYPE system address, 1 wei sent with calldata', code: report('2a 00 MSTORE', '20', HYPE, 'CALL', '01'), balance: 10n });
    programs.push({ label: 'HyperEVM CoreWriter.sendRawAction of 20 bytes', code: passing(CORE_WRITER, 'CALL'), data: `${sel('sendRawAction(bytes)')}${bytesArg(`01000002${'00'.repeat(16)}`)}` as Hex });
    programs.push({ label: 'HyperEVM CoreWriter with no calldata', code: passing(CORE_WRITER, 'CALL'), data: '0x' });
    programs.push({ label: 'HyperEVM L1 block number (0x809)', code: report('', '00', '0000000000000000000000000000000000000809') });
  }
  return programs;
}

/**
 * Gas at its edges, where a price turns on what came before it: the 63/64 a call may be given, at depth and asked
 * for more than there is; the 2,300 a call with value adds (enough to log, not to write: the sentry), and whether
 * it comes back; 25,000 for an account a call or SELFDESTRUCT brings into being; what is warm after a call that
 * reverted (EIP-2929: a revert undoes what it warmed, but not the account it was made to, nor a creation's
 * address); a slot's price through set, reset and set again from a value held and from none (EIP-2200, EIP-3529),
 * and its original value after a call that reverted; memory up to the gas there is and steps of no bytes at the
 * furthest offset; LOG, KECCAK256 and EXP at large sizes; CREATE2's hashing and the initcode limit, a collision, a
 * deposit that can't be paid; what a call that fails gives back, with data and without. Each is measured from
 * inside: the program's contract is called with a set gas (1,000,000 unless said) by one that returns whether the
 * call succeeded, what it spent and what it returned (GAS read around each step), so they compare to the unit on
 * every chain, Arbitrum (whose node takes its L1 charge from a transaction's gas) and HyperEVM (eth_call: no gas
 * figure) among them. Then a transaction's own: access lists and their keys, EIP-7623's calldata floor with an
 * access list and for a creation, and refunds against their cap of a fifth (a call that reverts keeps none).
 */
function gasPrograms(): Program[] {
  let n = 0;
  const account = () => (0x9a500000 + n++).toString(16).padStart(40, '0');
  const off = (k: number) => { const h = (k * 32).toString(16); return h.length % 2 ? `0${h}` : h; };
  // GAS read around steps that leave the stack as they found it: what they cost (and 2, the second GAS's), at word k;
  // around a call (or anything that leaves one word): that word at k, the cost at k + 1.
  const cost = (ops: string, k: number) => `GAS ${ops} GAS SWAP1 SUB ${off(k)} MSTORE`;
  const timed = (call: string, k = 0) => `GAS ${call} GAS SWAP1 ${off(k)} MSTORE SWAP1 SUB ${off(k + 1)} MSTORE`;
  const ret = (words: number) => `${off(words)} 00 RETURN`;
  const slot = (k: number) => `0x${word(k)}`, held = (slots: Record<number, number>) => Object.fromEntries(Object.entries(slots).map(([k, v]) => [slot(Number(k)), `0x${word(v)}`]));
  const clears = (k: number) => Array.from({ length: k }, (_, i) => `00 ${hex2(i + 1)} SSTORE`).join(' ');
  const heldFrom1 = (k: number, v = 5) => held(Object.fromEntries(Array.from({ length: k }, (_, i) => [i + 1, v])));
  // Helpers no program changes: the same in each.
  const [RETGAS, STOPS, LOGS, WRITES, WRITES_SAME, READS_COLD, REVERTS_64, FAILS, MEMORY_2_32, MEMORY_MAX, UNDERFLOWS, REVERTS, BAD_JUMP, MEMORY_20000] = Array.from({ length: 14 }, account);
  const helpers: StateChanges = Object.fromEntries(([
    [RETGAS, 'GAS 00 MSTORE 20 00 RETURN'], [STOPS, 'STOP'], [LOGS, '2a 00 MSTORE 01 20 00 LOG1 STOP'], [WRITES, '01 07 SSTORE STOP'], [WRITES_SAME, '00 07 SSTORE STOP'],
    [READS_COLD, '07 SLOAD POP STOP'], [REVERTS_64, '2a 00 MSTORE 2b 20 MSTORE 40 00 REVERT'], [FAILS, 'INVALID'], [MEMORY_2_32, '01 0100000000 MSTORE STOP'],
    [MEMORY_MAX, `01 ${'ff'.repeat(32)} MSTORE STOP`], [UNDERFLOWS, 'POP'], [REVERTS, '00 00 REVERT'], [BAD_JUMP, '00 JUMP'],
    // 20,000 words of memory: 3 a word and the square over 512, 841,250, and 9 for the rest.
    [MEMORY_20000, '01 09c3e0 MSTORE STOP'],
  ] as const).map(([a, code]) => [`0x${a}`, { code: asm(code) }]));
  // A program: its contract at an address of its own, called with `gas` by one that returns [succeeded, spent, ...returned].
  interface More { gas?: string; at?: string; balance?: bigint; storage?: Record<string, string>; state?: StateChanges; programGas?: bigint; accessList?: Program['accessList'] }
  const inner = (label: string, code: string, more: More = {}): Program => {
    const at = more.at ?? account();
    return { label: `gas: ${label}`, code: asm(`GAS 00 00 00 00 00 ${at} ${more.gas ?? '0f4240'} CALL GAS SWAP1 00 MSTORE SWAP1 SUB 20 MSTORE RETURNDATASIZE 00 40 RETURNDATACOPY RETURNDATASIZE 40 ADD 00 RETURN`),
      state: { ...helpers, ...more.state, [`0x${at}`]: { code: asm(code), ...(more.balance !== undefined && { balance: `0x${more.balance.toString(16)}` }), ...(more.storage && { stateDiff: more.storage }) } },
      ...(more.programGas && { gas: more.programGas }), ...(more.accessList && { accessList: more.accessList }) };
  };
  // A helper of a program's own (one whose state the program changes).
  const own = (code: string, more: { balance?: bigint; storage?: Record<string, string> } = {}) => {
    const at = account();
    return { at, state: { [`0x${at}`]: { code: asm(code), ...(more.balance !== undefined && { balance: `0x${more.balance.toString(16)}` }), ...(more.storage && { stateDiff: more.storage }) } } as StateChanges };
  };
  // Accounts that don't exist: one each, as a program's first touch makes it exist for those after it in the block.
  const nobody = () => (0x9a5f0000 + n++).toString(16).padStart(40, '0');
  const deep = (gas: string) => {
    const at = Array.from({ length: 8 }, account);
    return { first: at[0], state: Object.fromEntries(at.map((a, i) => [`0x${a}`, { code: asm(i === 7 ? 'GAS 00 MSTORE 20 00 RETURN' : `20 00 00 00 00 ${at[i + 1]} ${gas} CALL POP 20 00 RETURN`) }])) as StateChanges };
  };
  const salt = `0x${word(0x2a)}` as Hex, create2 = (from: string, bytecode: Hex) => getContractAddress({ opcode: 'CREATE2', from: `0x${from}`, salt, bytecode }).toLowerCase().slice(2);
  const programs: Program[] = [];
  const add = (...ps: Program[]) => programs.push(...ps);

  // 63/64 (EIP-150).
  add(inner('a call asking more gas than there is (the callee reads GAS: 63/64 of what is left)', `20 20 00 00 00 ${RETGAS} ffffffff CALL 00 MSTORE ${ret(2)}`),
    inner('a call with a wei asking more than there is (63/64, and the 2,300 stipend)', `20 20 00 00 01 ${RETGAS} ffffffff CALL 00 MSTORE ${ret(2)}`, { balance: 100n }),
    inner('a delegate call asking more than there is', `20 20 00 00 ${RETGAS} ffffffff DELEGATECALL 00 MSTORE ${ret(2)}`),
    inner('a static call asking more than there is', `20 20 00 00 ${RETGAS} ffffffff STATICCALL 00 MSTORE ${ret(2)}`),
    inner('a call asking 2^256 - 1', `20 20 00 00 00 ${RETGAS} ${'ff'.repeat(32)} CALL 00 MSTORE ${ret(2)}`));
  { const d = deep('GAS'); add(inner('eight calls deep, each passing on all its gas (the deepest reads GAS)', `20 00 00 00 00 ${d.first} GAS CALL POP ${ret(1)}`, { state: d.state })); }
  { const d = deep('ffffffff'); add(inner('eight calls deep, each asking 2^32', `20 00 00 00 00 ${d.first} ffffffff CALL POP ${ret(1)}`, { state: d.state })); }
  // A creation's code reads GAS and returns it as the new contract's code, read back with EXTCODECOPY.
  add(inner("a creation's code reads GAS (63/64 of what is left after CREATE's 32,000)", `5a60005260206000f3 b8 SHL 00 MSTORE 09 00 00 CREATE 00 MSTORE 20 00 40 00 MLOAD EXTCODECOPY ${ret(3)}`));

  // The 2,300 stipend of a call with value: enough to log, not to write a slot (EIP-2200's sentry: SSTORE needs more than 2,300 left).
  add(inner('a call with a wei and no gas to a contract that logs (the stipend)', `${timed(`00 00 00 00 01 ${LOGS} 00 CALL`)} ${ret(2)}`, { balance: 100n }),
    inner('a call with a wei and no gas to a contract that writes a slot (the sentry: fails)', `${timed(`00 00 00 00 01 ${WRITES} 00 CALL`)} ${ret(2)}`, { balance: 100n }),
    inner('a call with a wei and no gas to a contract that reads a cold slot', `${timed(`00 00 00 00 01 ${READS_COLD} 00 CALL`)} ${ret(2)}`, { balance: 100n }),
    inner('a call given 2,306 gas to a contract that writes a slot as it is (2,300 left at the SSTORE: fails)', `${timed(`00 00 00 00 00 ${WRITES_SAME} 0902 CALL`)} ${ret(2)}`),
    inner('a call given 2,307 gas to a contract that writes a slot as it is (2,301 left)', `${timed(`00 00 00 00 00 ${WRITES_SAME} 0903 CALL`)} ${ret(2)}`),
    inner('a call with a wei given 6 gas to a contract that writes a slot as it is (2,306 with the stipend: fails)', `${timed(`00 00 00 00 01 ${WRITES_SAME} 06 CALL`)} ${ret(2)}`, { balance: 100n }),
    inner('a call with a wei given 7 gas to a contract that writes a slot as it is (2,307 with the stipend)', `${timed(`00 00 00 00 01 ${WRITES_SAME} 07 CALL`)} ${ret(2)}`, { balance: 100n }),
    inner('a call with a wei to a contract that stops (the stipend comes back)', `${timed(`00 00 00 00 01 ${STOPS} 00 CALL`)} ${ret(2)}`, { balance: 100n }),
    inner("a call with more wei than the caller holds (fails, and the stipend is the caller's)", `${timed(`00 00 00 00 ffff ${STOPS} 00 CALL`)} ${ret(2)}`, { balance: 100n }),
    inner('a callcode with a wei and no gas to a contract that logs (the stipend)', `${timed(`00 00 00 00 01 ${LOGS} 00 CALLCODE`)} ${ret(2)}`, { balance: 100n }));

  // 25,000 for an account a call with value, or a SELFDESTRUCT with a balance, brings into being.
  add(inner("a call with a wei to an account that doesn't exist (25,000 more)", `${timed(`00 00 00 00 01 ${nobody()} 00 CALL`)} ${ret(2)}`, { balance: 100n }),
    inner("a call with nothing to an account that doesn't exist", `${timed(`00 00 00 00 00 ${nobody()} 00 CALL`)} ${ret(2)}`),
    inner("a callcode with a wei to an account that doesn't exist (no new account)", `${timed(`00 00 00 00 01 ${nobody()} 00 CALLCODE`)} ${ret(2)}`, { balance: 100n }),
    inner('a call with a wei to precompile 0x100', `${timed('00 00 00 00 01 0100 00 CALL')} ${ret(2)}`, { balance: 100n }),
    inner('a call with a wei to precompile 0x11', `${timed('00 00 00 00 01 11 00 CALL')} ${ret(2)}`, { balance: 100n }));
  for (const [label, code, balance] of [["SELFDESTRUCT of a balance to an account that doesn't exist (25,000 more)", `${nobody()} SELFDESTRUCT`, 5n], ["SELFDESTRUCT of no balance to an account that doesn't exist", `${nobody()} SELFDESTRUCT`, undefined],
    ['SELFDESTRUCT of a balance to its caller', 'CALLER SELFDESTRUCT', 5n], ['SELFDESTRUCT of a balance to itself', 'ADDRESS SELFDESTRUCT', 5n]] as const) {
    const d = own(code, { ...(balance !== undefined && { balance }) });
    add(inner(label, `${timed(`00 00 00 00 00 ${d.at} 0186a0 CALL`)} ${d.at} BALANCE 40 MSTORE ${ret(3)}`, { state: d.state }));
  }

  // What is warm after a call that reverted (EIP-2929).
  for (const [how, end] of [['reverts (cold again)', '00 00 REVERT'], ['succeeds (warm)', 'STOP'], ['fails on INVALID (cold again)', 'INVALID']] as const) {
    const x = nobody(), h = own(`${x} BALANCE POP ${end}`);
    add(inner(`an account read in a call that ${how}, read again by the caller`, `00 00 00 00 00 ${h.at} ffff CALL POP ${cost(`${x} BALANCE POP`, 0)} ${ret(1)}`, { state: h.state }));
  }
  { const h = own('09 SLOAD POP 00 00 REVERT'); add(inner('a slot read in a delegate call that reverts, read again (cold again)', `00 00 00 00 ${h.at} ffff DELEGATECALL POP ${cost('09 SLOAD POP', 0)} ${ret(1)}`, { state: h.state })); }
  { const h = own('07 09 SSTORE 00 00 REVERT'); add(inner('a slot held at 5, written in a delegate call that reverts, then cleared (cold, and its original 5)', `00 00 00 00 ${h.at} ffff DELEGATECALL POP ${cost('00 09 SSTORE', 0)} 09 SLOAD 20 MSTORE ${ret(2)}`, { state: h.state, storage: held({ 9: 5 }) })); }
  { const h = own('07 09 SSTORE STOP'); add(inner('a slot held at 5, written to 7 in a delegate call that succeeds, then written back to 5 (warm, dirty)', `00 00 00 00 ${h.at} ffff DELEGATECALL POP ${cost('05 09 SSTORE', 0)} ${ret(1)}`, { state: h.state, storage: held({ 9: 5 }) })); }
  add(inner('the account a call that reverts was made to stays warm', `00 00 00 00 00 ${REVERTS} ffff CALL POP ${cost(`${REVERTS} BALANCE POP`, 0)} ${ret(1)}`));
  { const y = nobody(), h = own(`00 00 00 00 00 ${y} ffff CALL POP 00 00 REVERT`); add(inner('an account called from a call that reverts is cold again', `00 00 00 00 00 ${h.at} ffff CALL POP ${cost(`${y} BALANCE POP`, 0)} ${ret(1)}`, { state: h.state })); }
  { const at = account(), x = create2(at, '0x60006000fd'); add(inner("the address of a CREATE2 whose code reverts stays warm", `60006000fd d8 SHL 00 MSTORE 2a 05 00 00 CREATE2 POP ${cost(`${x} BALANCE POP`, 0)} ${ret(1)}`, { at })); }
  { const h = own('600a6000f3 d8 SHL 00 MSTORE 2a 05 00 00 CREATE2 POP 00 00 REVERT'), x = create2(h.at, '0x600a6000f3');
    add(inner('the address of a CREATE2 made in a call that reverts is cold again', `00 00 00 00 00 ${h.at} 0186a0 CALL POP ${cost(`${x} BALANCE POP`, 0)} ${ret(1)}`, { state: h.state })); }
  { const z = nobody(), d = own(`${z} SELFDESTRUCT`, { balance: 1n }), h = own(`00 00 00 00 00 ${d.at} ffff CALL POP 00 00 REVERT`);
    add(inner('the beneficiary of a SELFDESTRUCT in a call that reverts is cold again', `00 00 00 00 00 ${h.at} 0186a0 CALL POP ${cost(`${z} BALANCE POP`, 0)} ${ret(1)}`, { state: { ...d.state, ...h.state } })); }

  // A slot's price through a transaction (EIP-2200, EIP-2929, EIP-3529), each write timed.
  const writes = (values: number[]) => `${values.map((v, k) => cost(`${hex2(v)} 07 SSTORE`, k)).join(' ')} ${ret(values.length)}`;
  add(inner('a slot from 0 set, cleared and set again (0, 1, 0, 1)', writes([1, 0, 1])),
    inner('a slot from 0 set, changed, cleared and changed again (0, 1, 2, 0, 3)', writes([1, 2, 0, 3])),
    inner('a slot held at 5 cleared, set back and cleared again (5, 0, 5, 0)', writes([0, 5, 0]), { storage: held({ 7: 5 }) }),
    inner('a slot held at 5 changed and changed back (5, 7, 5)', writes([7, 5]), { storage: held({ 7: 5 }) }),
    inner('a slot held at 5 cleared, then set to 7 (5, 0, 7)', writes([0, 7]), { storage: held({ 7: 5 }) }),
    inner('a slot held at 5 changed, then cleared (5, 7, 0)', writes([7, 0]), { storage: held({ 7: 5 }) }),
    inner('a slot held at 5 written as it is, cold then warm', writes([5, 5]), { storage: held({ 7: 5 }) }),
    inner('a slot from 0 written as it is, cold then warm', writes([0, 0])),
    inner('a slot held at 5 read cold, then cleared (warm)', `07 SLOAD POP ${writes([0])}`, { storage: held({ 7: 5 }) }));
  { const h = own('00 07 SSTORE STOP'); add(inner('a slot held at 5 cleared in a delegate call that succeeds, then set back by the caller', `00 00 00 00 ${h.at} ffff DELEGATECALL POP ${cost('05 07 SSTORE', 0)} ${ret(1)}`, { state: h.state, storage: held({ 7: 5 }) })); }
  { const h = own('01 07 SSTORE STOP'); add(inner('a slot from 0 set in a delegate call that succeeds, then cleared by the caller', `00 00 00 00 ${h.at} ffff DELEGATECALL POP ${cost('00 07 SSTORE', 0)} ${ret(1)}`, { state: h.state })); }

  // Refunds, a transaction's own: at most a fifth of what it used (EIP-3529), none from a call that reverted.
  add({ label: 'gas: refund, five slots held cleared (over its cap)', code: asm(`${clears(5)} STOP`), storage: heldFrom1(5) },
    { label: 'gas: refund, one slot held cleared (under its cap)', code: asm(`${clears(1)} STOP`), storage: heldFrom1(1) },
    { label: 'gas: refund, three new slots set and cleared', code: asm(`01 01 SSTORE 01 02 SSTORE 01 03 SSTORE ${clears(3)} STOP`) });
  for (const [how, end, after] of [['reverts (none)', '00 00 REVERT', 'STOP'], ['fails on INVALID (none)', 'INVALID', 'STOP'], ['succeeds', 'STOP', 'STOP'], ['succeeds, in a transaction that then reverts', 'STOP', '00 00 REVERT']] as const) {
    const c = own(`${clears(3)} ${end}`, { storage: heldFrom1(3) });
    add({ label: `gas: refund, three slots held cleared in a call that ${how}`, code: asm(`00 00 00 00 00 ${c.at} 0186a0 CALL POP ${after}`), state: c.state });
  }

  // Memory, to the gas there is, and steps of no bytes at the furthest offset (which grow none).
  const HUGE = 'ff'.repeat(32);
  add(inner('memory grown to 20,000 words on exactly the gas it takes (841,259)', `${timed(`00 00 00 00 00 ${MEMORY_20000} 0cd62b CALL`)} ${ret(2)}`),
    inner('memory grown to 20,000 words on a gas less', `${timed(`00 00 00 00 00 ${MEMORY_20000} 0cd62a CALL`)} ${ret(2)}`),
    inner('an MSTORE at 2^32 (out of gas)', `${timed(`00 00 00 00 00 ${MEMORY_2_32} 0186a0 CALL`)} ${ret(2)}`),
    inner('an MSTORE at 2^256 - 1 (out of gas)', `${timed(`00 00 00 00 00 ${MEMORY_MAX} 0186a0 CALL`)} ${ret(2)}`),
    inner('steps of no bytes at offset 2^256 - 1 (no memory grown)', `00 ${HUGE} KECCAK256 POP 00 ${HUGE} LOG0 00 00 ${HUGE} CALLDATACOPY 00 00 ${HUGE} CODECOPY 00 00 ${HUGE} RETURNDATACOPY 00 ${HUGE} ${HUGE} MCOPY 00 00 ${HUGE} ${STOPS} EXTCODECOPY 00 ${HUGE} 00 ${HUGE} 00 ${STOPS} GAS CALL POP 00 ${HUGE} 00 CREATE POP MSIZE 00 MSTORE ${ret(1)}`),
    inner('RETURN of no bytes at offset 2^256 - 1', `00 ${HUGE} RETURN`),
    inner('REVERT of no bytes at offset 2^256 - 1', `00 ${HUGE} REVERT`),
    inner('RETURNDATACOPY of no bytes from offset 2^64 (out of bounds: fails)', `00 010000000000000000 00 RETURNDATACOPY STOP`),
    inner('a call whose return area is larger than what comes back (memory grown for all of it)', `${timed(`0400 00 00 00 00 ${RETGAS} ffff CALL`)} MSIZE 40 MSTORE ${ret(3)}`));

  // LOG, KECCAK256 and EXP at large sizes.
  add(inner('LOG4 of 10,000 bytes', `${cost('04 03 02 01 2710 00 LOG4', 0)} ${ret(1)}`),
    inner('LOG0 of no bytes', `${cost('00 00 LOG0', 0)} ${ret(1)}`),
    inner('KECCAK256 of 100,000 bytes', `${timed('0186a0 00 KECCAK256')} ${ret(2)}`),
    inner('KECCAK256 of 1,000,000 bytes', `${timed('0f4240 00 KECCAK256')} ${ret(2)}`, { gas: '2dc6c0', programGas: 3_200_000n }),
    inner('EXP of 3 to a 32-byte exponent', `${timed(`${'ff'.repeat(32)} 03 EXP`)} ${ret(2)}`),
    inner('EXP of 3 to the exponent 0', `${timed('00 03 EXP')} ${ret(2)}`),
    inner('EXP of 0 to a 32-byte exponent', `${timed(`${'ff'.repeat(32)} 00 EXP`)} ${ret(2)}`),
    inner('EXP of 2 to 2^248 (a 32-byte exponent)', `${timed(`01${'00'.repeat(31)} 02 EXP`)} ${ret(2)}`));

  // Creations: CREATE2's hashing (6 a word of initcode), the initcode limit, a collision, a deposit that can't be paid.
  add(inner('CREATE2 of 1,000 bytes of initcode', `${timed('2a 03e8 00 00 CREATE2')} ${ret(2)}`),
    inner('CREATE of 1,000 bytes of initcode', `${timed('03e8 00 00 CREATE')} ${ret(2)}`),
    inner('CREATE2 of 49,152 bytes of initcode (the most before Amsterdam)', `${timed('2a c000 00 00 CREATE2')} ${ret(2)}`),
    inner('CREATE2 of 49,153 bytes of initcode', `${timed('2a c001 00 00 CREATE2')} ${ret(2)}`),
    inner('CREATE2 twice with one salt (the second collides, taking all it was given)', `600a6000f3 d8 SHL 00 MSTORE 2a 05 00 00 CREATE2 POP ${timed('2a 05 00 00 CREATE2')} ${ret(2)}`),
    inner("CREATE of code that starts with 0xef (EIP-3541: fails, taking all it was given)", `60ef60005360016000f3 b0 SHL 00 MSTORE ${timed('0a 00 00 CREATE')} ${ret(2)}`),
    inner('CREATE with more value than the creator holds (fails, its gas kept), then one that succeeds', `${timed('00 00 ffff CREATE', 0)} ${timed('00 00 00 CREATE', 2)} ${ret(4)}`, { balance: 100n }));
  { const at = account(), x = create2(at, '0x600a6000f3');
    add(inner('CREATE2 to an address that holds a balance and nothing else (no collision)', `600a6000f3 d8 SHL 00 MSTORE ${timed('2a 05 00 00 CREATE2')} ${x} BALANCE 40 MSTORE ${ret(3)}`, { at, state: { [`0x${x}`]: { balance: '0x7' } } })); }
  // The code a creation returns costs 200 a byte to store: 100 bytes on what is left of 36,864 can't be paid.
  { const c = own('60646000f3 d8 SHL 00 MSTORE 05 00 00 CREATE 00 MSTORE 20 00 RETURN');
    add(inner("CREATE of 100 bytes of code it can't pay to store (fails, taking all it was given)", `${timed(`20 40 00 00 00 ${c.at} 9000 CALL`)} ${ret(3)}`, { state: c.state })); }

  // What a call that fails gives back: all but what it used when it reverts (with its data), nothing when it fails otherwise.
  add(inner('a call that reverts with 64 bytes (the rest of its gas comes back)', `${timed(`40 40 00 00 00 ${REVERTS_64} c350 CALL`)} RETURNDATASIZE 80 MSTORE ${ret(5)}`),
    inner('a call that reverts with more than its return area holds', `${timed(`10 40 00 00 00 ${REVERTS_64} c350 CALL`)} RETURNDATASIZE 80 MSTORE ${ret(5)}`),
    inner('a delegate call that reverts with 64 bytes', `${timed(`40 40 00 00 ${REVERTS_64} c350 DELEGATECALL`)} RETURNDATASIZE 80 MSTORE ${ret(5)}`),
    inner('a call that reaches INVALID (all its gas gone)', `${timed(`00 00 00 00 00 ${FAILS} c350 CALL`)} RETURNDATASIZE 40 MSTORE ${ret(3)}`),
    inner('a call that underflows the stack', `${timed(`00 00 00 00 00 ${UNDERFLOWS} c350 CALL`)} ${ret(2)}`),
    inner('a call that jumps where it may not', `${timed(`00 00 00 00 00 ${BAD_JUMP} c350 CALL`)} ${ret(2)}`),
    inner('a static call to a contract that writes (all its gas gone)', `${timed(`00 00 00 00 ${WRITES} c350 STATICCALL`)} ${ret(2)}`));

  // Access lists (EIP-2930): 2,400 an address and 1,900 a key, whatever they name and however often; what they name is warm.
  const BEEF = '0x000000000000000000000000000000000000beef', listed = (address: string, keys: number[]) => ({ address: address.startsWith('0x') ? address : `0x${address}`, storageKeys: keys.map(slot) });
  add({ label: 'gas: an access list of one address, on a transfer', to: BEEF, accessList: [listed(nobody(), [])] },
    { label: 'gas: an access list of two addresses and three keys', to: BEEF, accessList: [listed(nobody(), [1, 2]), listed(nobody(), [3])] },
    { label: 'gas: an access list naming the sender, the recipient and a precompile', to: BEEF, accessList: [listed(FROM, [1]), listed(BEEF, []), listed('0x0000000000000000000000000000000000000001', [])] },
    { label: 'gas: an access list naming an address twice and a key twice', to: BEEF, accessList: [listed(nobody(), [1, 1]), listed('0x000000000000000000000000000000000000c0fe', [1])] });
  { const at = account(), y = nobody();
    add(inner('a slot and an account the access list names, read warm, and a slot it does not', `${cost('07 SLOAD POP', 0)} ${cost('08 SLOAD POP', 1)} ${cost(`${y} BALANCE POP`, 2)} ${ret(3)}`, { at, accessList: [listed(at, [7]), listed(y, [])] })); }

  // EIP-7623's calldata floor (10 a token, a nonzero byte 4 tokens), which leaves out an access list and a creation's charges.
  const nonzero = (k: number) => `0x${'ff'.repeat(k)}` as Hex;
  add({ label: 'gas: calldata floor, 1,000 bytes to an account with no code and an access list of 10 keys (the floor)', to: BEEF, data: nonzero(1000), accessList: [listed(nobody(), Array.from({ length: 10 }, (_, i) => i))] },
    { label: 'gas: calldata floor, 1,000 bytes to an account with no code and an access list of 20 keys (over the floor)', to: BEEF, data: nonzero(1000), accessList: [listed(nobody(), Array.from({ length: 20 }, (_, i) => i))] },
    { label: 'gas: calldata floor, 1,000 zero bytes to an account with no code', to: BEEF, data: `0x${'00'.repeat(1000)}` },
    { label: 'gas: calldata floor, a creation from 2,000 bytes of initcode (the floor)', create: true, data: `0x00${'ff'.repeat(1999)}` },
    { label: 'gas: calldata floor, a creation from 500 bytes of initcode (over the floor)', create: true, data: `0x00${'ff'.repeat(499)}` },
    { label: 'gas: calldata floor, a creation from 2,000 bytes with an access list of 5 keys', create: true, data: `0x00${'ff'.repeat(1999)}`, accessList: [listed(nobody(), [1, 2, 3, 4, 5])] },
    { label: 'gas: calldata floor, 1,000 bytes to a contract that clears three slots (the floor, over what the refund leaves)', code: asm(`${clears(3)} STOP`), storage: heldFrom1(3), data: nonzero(1000) });

  // What a transaction pays before its code runs, as its code sees it: GAS, read first, is the gas limit less that.
  add({ label: 'gas: GAS read first, in a call with an access list of two addresses and three keys', code: asm('GAS 00 MSTORE 20 00 RETURN'), accessList: [listed(nobody(), [1, 2]), listed(nobody(), [3])] },
    { label: 'gas: GAS read first, in a call with 1,000 nonzero bytes of calldata', code: asm('GAS 00 MSTORE 20 00 RETURN'), data: nonzero(1000) },
    // (Its code is the word GAS read: 9 bytes that return it, then 91 that never run.)
    { label: 'gas: GAS read first, by the initcode of a creation from 100 bytes', create: true, data: `0x5a60005260206000f3${'ff'.repeat(91)}` },
    { label: "gas: a transfer of a wei to an account that doesn't exist", to: `0x${nobody()}`, value: 1n },
    { label: 'gas: a transfer of a wei to the sender itself', to: FROM, value: 1n },
    { label: 'gas: a transaction straight to the identity precompile with 100 bytes', to: '0x0000000000000000000000000000000000000004', data: `0x${'ab'.repeat(100)}` },
    { label: 'gas: a transaction straight to ecrecover with a wei and no input', to: '0x0000000000000000000000000000000000000001', value: 1n },
    { label: 'gas: a creation whose initcode reverts with a word', create: true, data: '0x602a60005260206000fd' },
    { label: 'gas: a creation with a wei', create: true, data: '0x600a6000f3', value: 1n });
  // A contract that destroys itself as it is created, sending its 5 wei to an account that doesn't exist (25,000
  // more, and the account removed with it, EIP-6780); copies of 10,000 bytes from a cold account's code and from
  // past the end of the calldata (3 a word, and the memory).
  { const x = nobody(); add(inner("a creation's code destroys it, sending 5 wei to an account that doesn't exist", `73${x}ff 50 SHL 00 MSTORE ${timed('16 00 05 CREATE')} ${x} BALANCE 40 MSTORE ${ret(3)}`, { balance: 100n })); }
  add(inner('EXTCODECOPY of 10,000 bytes of a cold account', `${cost(`2710 00 00 ${nobody()} EXTCODECOPY`, 0)} ${ret(1)}`),
    inner('CALLDATACOPY of 10,000 bytes past the end of the calldata', `${cost('2710 00 00 CALLDATACOPY', 0)} ${ret(1)}`));
  // The fee recipient is warm from the start (EIP-3651), wherever the chain says it is.
  add(inner('BALANCE of the fee recipient (warm)', `${cost('COINBASE BALANCE POP', 0)} ${ret(1)}`));
  // A refund a call takes back, undone with it; the refund for a slot cleared, then taken back by the caller.
  { const h = own('05 07 SSTORE 00 00 REVERT'); add({ label: 'gas: refund, a slot held cleared, then set back in a delegate call that reverts (the refund kept)', code: asm(`00 07 SSTORE 00 00 00 00 ${h.at} ffff DELEGATECALL POP STOP`), storage: held({ 7: 5 }), state: h.state }); }
  { const h = own('05 07 SSTORE STOP'); add({ label: 'gas: refund, a slot held cleared, then set back in a delegate call that succeeds', code: asm(`00 07 SSTORE 00 00 00 00 ${h.at} ffff DELEGATECALL POP STOP`), storage: held({ 7: 5 }), state: h.state }); }
  { const h = own(`00 00 00 00 01 ${STOPS} 00 CALL POP STOP`, { balance: 5n }); add(inner('a static call to a contract that calls with value (all its gas gone)', `${timed(`00 00 00 00 ${h.at} c350 STATICCALL`)} ${ret(2)}`, { state: h.state })); }
  // EIP-7702 delegations, as code reads and calls them: one to an account delegated in turn (not followed), one to an
  // account with no code, one called in a call that reverts and then again (its delegate cold again), and the
  // delegate of the account a transaction is sent to (warm from the start).
  { const target = account(), mid = account(), twice = account(), none = account(), empty = nobody();
    const state: StateChanges = { [`0x${target}`]: { code: asm('2a 00 MSTORE 20 00 RETURN') }, [`0x${mid}`]: { code: `0xef0100${target}` }, [`0x${twice}`]: { code: `0xef0100${mid}` }, [`0x${none}`]: { code: `0xef0100${empty}` } };
    add(inner('a call to an account delegated to one delegated in turn (not followed)', `${timed(`20 40 00 00 00 ${twice} ffff CALL`)} ${ret(3)}`, { state }),
      inner('a call to an account delegated to an account with no code', `${timed(`20 40 00 00 00 ${none} ffff CALL`)} ${ret(3)}`, { state }));
    const h = own(`20 00 00 00 00 ${mid} ffff CALL POP 00 00 REVERT`);
    add(inner('a delegated account called in a call that reverts, then again (its delegate cold again)', `00 00 00 00 00 ${h.at} 0186a0 CALL POP ${timed(`20 40 00 00 00 ${mid} ffff CALL`)} ${ret(3)}`, { state: { ...state, ...h.state } }));
    const delegate = account(), delegated = account();
    add({ label: 'gas: BALANCE of the delegate of the account a transaction is sent to (warm from the start)', to: `0x${delegated}`, state: { [`0x${delegate}`]: { code: asm(`${cost(`${delegate} BALANCE POP`, 0)} ${ret(1)}`) }, [`0x${delegated}`]: { code: `0xef0100${delegate}` } } }); }
  return programs;
}

/**
 * Programs whose gas limit is set to what the node's run of them needed: its maxUsedGas (what the call used at
 * most, before its refund; where the node gives none, the gas it used, for those with no refund), and one less;
 * for one with a refund, also what it used after it (which can't hold it). A gas estimate is the first: the local
 * EVM should run out of gas where the node does, exactly. Not on Arbitrum (its node takes its L1 charge from the gas
 * limit), and not for a transaction whose gas limit would be under its calldata floor (the node refuses those whole).
 */
function boundaryBases(): Program[] {
  const NEEDY = '000000000000000000000000000000009a5ff001';
  return [
    { label: 'gas boundary: a call that sets a new slot', code: asm('01 07 SSTORE STOP') },
    { label: 'gas boundary: five slots held cleared (a refund over its cap)', code: asm(`${Array.from({ length: 5 }, (_, i) => `00 ${hex2(i + 1)} SSTORE`).join(' ')} STOP`), storage: Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`0x${word(i + 1)}`, `0x${word(5)}`])), refunds: true },
    { label: 'gas boundary: a slot set then cleared (a refund)', code: asm('2a 07 SSTORE 00 07 SSTORE STOP'), refunds: true },
    // A refund a call that reverts took back is the caller's again: what it needs is still what it ran on.
    { label: 'gas boundary: a slot held cleared, then set back in a delegate call that reverts (the refund kept)', code: asm(`00 07 SSTORE 00 00 00 00 ${NEEDY.replace(/1$/, '3')} ffff DELEGATECALL POP STOP`), storage: { [`0x${word(7)}`]: `0x${word(5)}` }, state: { [`0x${NEEDY.replace(/1$/, '3')}`]: { code: asm('05 07 SSTORE 00 00 REVERT') } }, refunds: true },
    // What it asks for (841,259, for 20,000 words of memory) it can only be given with more than 64/63 of that left.
    { label: 'gas boundary: a call asking a set gas that 63/64 of what is left must cover', code: asm(`00 00 00 00 00 ${NEEDY} 0cd62b CALL 00 MSTORE 20 00 RETURN`), state: { [`0x${NEEDY}`]: { code: asm('01 09c3e0 MSTORE STOP') } } },
    { label: 'gas boundary: a creation of ten bytes of code', create: true, data: '0x600a6000f3' },
    // (On a gas less, what is left can't pay to store its code: the creation fails.)
    { label: 'gas boundary: a creation of 100 bytes of code', create: true, data: '0x60646000f3' },
    { label: 'gas boundary: 100 calls to a contract that stops', code: asm(Array.from({ length: 100 }, () => `00 00 00 00 00 ${NEEDY.replace(/1$/, '2')} GAS CALL POP`).join(' ')), state: { [`0x${NEEDY.replace(/1$/, '2')}`]: { code: '0x00' } } },
  ];
}

async function boundaries(chain: Chain, chainId: number, report: Report): Promise<void> {
  if (CHAIN_PROFILES[chainId]?.arbitrum) return;
  const bases = boundaryBases(), first = await chain.both(bases), programs: Program[] = [];
  first.forEach(({ node, local }, i) => {
    const b = bases[i], needs = node.peak ?? (b.refunds ? undefined : node.gas ?? local.gas);
    if (needs === undefined || node.kind !== 'runs') return;
    const at = (gas: bigint, what: string): Program => ({ ...b, label: `${b.label}, ${what}`, gas, detail: `gas limit ${gas}` });
    programs.push(at(needs, 'on the gas it needs'), at(needs - 1n, 'on a gas less'));
    if (b.refunds && node.gas !== undefined && node.gas < needs) programs.push(at(node.gas, 'on what it uses after its refund'));
  });
  await compare(chain, chainId, programs, report);
}

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
  // And the chains' own precompiles that a fork adds (ChainProfile.timedPrecompiles: BNB Chain's MILLI_TIMESTAMP),
  // with no input and with some: before the fork, an empty account on both sides.
  const timed = new Map(Object.values(CHAIN_PROFILES).flatMap(p => p.timedPrecompiles ?? []).map(p => [p.address, p.name]));
  for (const [address, name] of timed) for (const n of [0, 40]) programs.push({ precompile: true, label: `${address.replace(/^0x0+/, '0x')} ${name}, ${n} bytes in`, code: caller(Number(address)), data: `0x${'ab'.repeat(n)}` });
  // And a few more points and pairs, where a price follows a discount table.
  for (const [name, n, unit] of [['G1 multi-scalar', 12, 160], ['G2 multi-scalar', 14, 288], ['pairing', 15, 384]] as const) for (const k of [2, 3, 8]) programs.push({ precompile: true, label: `0x${n.toString(16).padStart(2, '0')} bls12-381 ${name}, ${k}`, code: caller(n), data: `0x${zeros(unit * k)}` });
  return programs;
}

/**
 * The precompiles with inputs at their edges, beyond the accepted and empty inputs of precompilePrograms: each from a
 * contract that reports whether the call succeeded, the gas it spent and what came back. ecrecover with v other than
 * 27 and 28, s high, r or s zero or out of range, a hash of zero, inputs short and long; sha256, ripemd160 and
 * identity on large inputs and a gas short of their price; modexp with zero lengths, lengths declared past what is
 * there, exponent 0, modulus 0 and 1, EIP-7823's limit of 1,024 bytes either side and EIP-7883's price where it
 * turns (32 bytes either side, an exponent over 32 bytes); bn254 points off the curve, coordinates of p or more, the
 * point at infinity, inputs short and long, a pairing of the wrong length, G2 points off the twist and outside the
 * subgroup; blake2f of the wrong length, a final flag of 2, 0 rounds and 2^32 - 1; point evaluation with a wrong
 * versioned hash, a proof that doesn't hold, z or y not in the field; the BLS12-381 seven with real points (G2's
 * encoding of c0 and c1 included), infinity, points outside the subgroup (which an addition accepts and a
 * multiplication refuses), coordinates of p or more, the multi-scalar discounts at 1, 2, 128 and 129; P-256 with s
 * high, r or s zero or of n or more, a key off the curve or at infinity, the wrong length (nothing back, no
 * failure); each a gas short of its price; and each precompile's accepted input sent value by a CALL, run by a
 * DELEGATECALL and by CALLCODE. Prices are the chain's (Polygon's and HyperEVM's own: ChainProfile).
 */
async function precompileEdgePrograms(chainId: number): Promise<Program[]> {
  const polygon = chainId === 137, hyper = chainId === 999;
  const price = {
    ecrecover: hyper ? 15_000 : 3_000, bnAdd: polygon ? 540 : hyper ? 1_500 : 150, bnMul: polygon ? 12_600 : hyper ? 60_000 : 6_000,
    bnPair: polygon ? [67_500, 51_000] : hyper ? [450_000, 340_000] : [45_000, 34_000], blakeRound: polygon ? 22 : hyper ? 10 : 1, kzg: hyper ? 2_000_000 : 50_000,
    g1Add: polygon ? 1_050 : 375, g1Mul: polygon ? 73_200 : 12_000, g2Add: polygon ? 1_620 : 600, g2Mul: polygon ? 144_000 : 22_500,
    pair: polygon ? [109_330, 94_540] : [37_700, 32_600], mapG1: polygon ? 15_400 : 5_500, mapG2: polygon ? 66_640 : 23_800, p256: 6_900, modexpMin: hyper ? 5_000 : 500,
  };
  const zeros = (n: number) => '00'.repeat(n);
  const hexGas = (n: number) => { const h = n.toString(16); return h.length % 2 ? `0${h}` : h; };
  const out: Program[] = [];
  type How = { op?: 'STATICCALL' | 'CALL' | 'DELEGATECALL' | 'CALLCODE'; gas?: number; value?: bigint; programGas?: bigint };
  const add = (target: number, label: string, data: string, how: How = {}) => out.push({
    precompile: true, label: `edge 0x${target.toString(16).padStart(2, '0')} ${label}`, code: caller(target, how.op ?? (how.value ? 'CALL' : 'STATICCALL'), how.gas !== undefined ? hexGas(how.gas) : 'GAS'),
    data: `0x${data}`, ...(how.value && { value: how.value }), ...(how.programGas && { gas: how.programGas }),
  });

  // What a precompile's account reads as (warm from the start: 100 each), whether it exists or not: its code hash,
  // balance and code size; the chain's own precompiles too (ArbOS's carry the code 0xfe). First, before any program
  // here sends one a wei (a node with only eth_call runs each program on the block's own state, the local EVM a
  // block's in turn).
  const own = chainId === 56 ? [0x64, 0x65, 0x66, 0x67, 0x68, 0x69] : CHAIN_PROFILES[chainId]?.arbitrum ? [0x64, 0x65, 0x66, 0x6b, 0x6c, 0x6e, 0x71, 0x74] : hyper ? [0x800, 0x80c] : [];
  for (const t of [...Array.from({ length: 0x11 }, (_, i) => i + 1), 0x100, ...own]) {
    const a = t.toString(16).padStart(t > 0xff ? 4 : 2, '0');
    out.push({ label: `edge 0x${a} as an account: EXTCODEHASH, BALANCE, EXTCODESIZE`, code: asm(`${a} EXTCODEHASH 00 MSTORE ${a} BALANCE 20 MSTORE ${a} EXTCODESIZE 40 MSTORE 60 00 RETURN`) });
  }

  // 0x01 ecrecover, a signature by a fixed key.
  const N = secp256k1.CURVE.n, hash = createHash('sha256').update('signing-preview edge').digest('hex');
  const sig = secp256k1.sign(hash, '42'.repeat(32)), v = 27n + BigInt(sig.recovery);
  const rec = (vw: string, r: bigint, s: bigint, h = hash) => `${h}${vw}${word(r)}${word(s)}`;
  // An x that is no point's: x^3 + 7 has no square root.
  const Fk = secp256k1.CURVE.Fp;
  let offCurve = 1n;
  for (;; offCurve++) { try { Fk.sqrt(Fk.add(Fk.pow(offCurve, 3n), 7n)); } catch { break; } }
  const good = rec(word(v), sig.r, sig.s);
  for (const vv of [0n, 1n, 26n, 29n]) add(1, `ecrecover, v = ${vv}`, rec(word(vv), sig.r, sig.s));
  add(1, "ecrecover, v's word with its top byte set", rec(`01${word(v).slice(2)}`, sig.r, sig.s));
  add(1, 'ecrecover, s high (n - s), v flipped', rec(word(v === 27n ? 28n : 27n), sig.r, N - sig.s));
  add(1, 'ecrecover, s high (n - s), v as signed', rec(word(v), sig.r, N - sig.s));
  add(1, 'ecrecover, r = 0', rec(word(v), 0n, sig.s));
  add(1, 'ecrecover, s = 0', rec(word(v), sig.r, 0n));
  add(1, 'ecrecover, r = n', rec(word(v), N, sig.s));
  add(1, 'ecrecover, s = n', rec(word(v), sig.r, N));
  add(1, 'ecrecover, r = n + 1', rec(word(v), N + 1n, sig.s));
  add(1, 'ecrecover, r = 2^256 - 1', rec(word(v), (1n << 256n) - 1n, sig.s));
  add(1, 'ecrecover, r no point has', rec(word(v), offCurve, sig.s));
  add(1, 'ecrecover, a hash of 0', rec(word(v), sig.r, sig.s, zeros(32)));
  add(1, 'ecrecover, 97 bytes', good.slice(0, 194));
  add(1, 'ecrecover, 64 bytes', good.slice(0, 128));
  add(1, 'ecrecover, 32 bytes more', `${good}${'ab'.repeat(32)}`);
  add(1, `ecrecover on ${price.ecrecover - 1} gas`, good, { gas: price.ecrecover - 1 });
  add(1, `ecrecover on ${price.ecrecover} gas`, good, { gas: price.ecrecover });

  // 0x02-0x04: sha256, ripemd160, identity.
  for (const [t, name, base, per] of [[2, 'sha256', 60, 12], [3, 'ripemd160', 600, 120], [4, 'identity', 15, 3]] as const) {
    add(t, `${name} of 1 byte`, 'ab'); add(t, `${name} of 33 bytes`, 'ab'.repeat(33));
    add(t, `${name} of 20,000 bytes`, 'ab'.repeat(20_000), { programGas: 2_000_000n });
    add(t, `${name} of 1 byte on ${base + per - 1} gas`, 'ab', { gas: base + per - 1 });
    add(t, `${name} of 1 byte on ${base + per} gas`, 'ab', { gas: base + per });
  }

  // 0x05 modexp: the lengths (base, exponent, modulus), then what follows them.
  const mx = (b: bigint | number, e: bigint | number, m: bigint | number, rest = '') => `${word(b)}${word(e)}${word(m)}${rest}`;
  add(5, 'modexp, all three lengths 0', mx(0, 0, 0));
  add(5, 'modexp, 32 bytes (a base length of 1, the rest missing)', word(1));
  add(5, 'modexp, 10 bytes (a length read from them and zeros)', `${zeros(9)}01`);
  add(5, 'modexp, exponent 0', mx(1, 1, 1, '050007'));
  add(5, 'modexp, an exponent of no length', mx(1, 0, 1, '0507'));
  add(5, 'modexp, modulus 1', mx(1, 1, 1, '050301'));
  add(5, 'modexp, modulus 0 (32 bytes)', mx(1, 1, 32, `0503${zeros(32)}`));
  add(5, 'modexp, 0^0 mod 5 (no base, no exponent)', mx(0, 0, 1, '05'));
  add(5, 'modexp, no modulus', mx(32, 32, 0, `${word(3)}${word(5)}`));
  add(5, 'modexp, a base length of 2^256 - 1', mx((1n << 256n) - 1n, 1, 1, '030505'));
  add(5, 'modexp, an exponent length of 2^64', mx(1, 1n << 64n, 1, '030505'));
  add(5, 'modexp, a modulus of 1,024 bytes', mx(1, 1, 1024, `0305${'ff'.repeat(1024)}`));
  add(5, 'modexp, a modulus of 1,025 bytes', mx(1, 1, 1025, `0305${'ff'.repeat(1025)}`));
  add(5, 'modexp, a base of 1,025 bytes', mx(1025, 1, 1, `${'07'.repeat(1025)}0305`));
  add(5, 'modexp, a base of 1,025 bytes and no modulus', mx(1025, 1, 0, `${'07'.repeat(1025)}03`));
  add(5, 'modexp, an exponent of 1,025 bytes', mx(1, 1025, 1, `03${'ff'.repeat(1025)}05`), { programGas: 8_000_000n });
  add(5, 'modexp, an exponent of 1,024 bytes, numbers of 32', mx(32, 1024, 32, `${word(3)}${'ff'.repeat(1024)}${word((1n << 255n) - 19n)}`), { programGas: hyper ? 6_000_000n : 2_000_000n });
  add(5, 'modexp, numbers of 32 bytes and an exponent of 32 bytes of ff', mx(32, 32, 32, `${word(3)}${'ff'.repeat(32)}${word((1n << 255n) - 19n)}`));
  add(5, 'modexp, numbers of 33 bytes and an exponent of 32 bytes of ff', mx(33, 32, 33, `${'03'.padStart(66, '0')}${'ff'.repeat(32)}${'ed'.padStart(66, '7f')}`));
  add(5, 'modexp, an exponent of 33 bytes, its first 32 zero', mx(32, 33, 32, `${word(3)}${zeros(32)}ff${word((1n << 255n) - 19n)}`));
  add(5, 'modexp, an exponent of 33 bytes of ff', mx(32, 33, 32, `${word(3)}${'ff'.repeat(33)}${word((1n << 255n) - 19n)}`));
  add(5, 'modexp, an exponent of 40 bytes, its head 0x..ff', mx(32, 40, 32, `${word(3)}${zeros(31)}ff${'11'.repeat(8)}${word((1n << 255n) - 19n)}`));
  add(5, 'modexp, an exponent cut short by the end of the input', mx(1, 32, 1, `02${'ff'.repeat(10)}`));
  add(5, 'modexp, a base larger than the modulus', mx(32, 1, 1, `${'ff'.repeat(32)}0307`));
  add(5, 'modexp, a base of no length', mx(0, 1, 32, `05${word(97)}`));
  add(5, `modexp, 32-byte numbers on ${price.modexpMin - 1} gas`, mx(32, 32, 32, `${word(3)}${word(65537)}${word((1n << 255n) - 19n)}`), { gas: price.modexpMin - 1 });
  add(5, `modexp, 32-byte numbers on ${price.modexpMin} gas`, mx(32, 32, 32, `${word(3)}${word(65537)}${word((1n << 255n) - 19n)}`), { gas: price.modexpMin });

  // 0x06-0x08 bn254: the generator G = (1, 2), Q G2's (imaginary parts first, as the EVM has them).
  const bnP = bn254.fields.Fp.ORDER, bnR = bn254.fields.Fr.ORDER;
  const G = word(1) + word(2), inf = zeros(64), negG = word(1) + word(bnP - 2n);
  const Q = '198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c2' + '1800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6ed' + '090689d0585ff075ec9e99ad690c3395bc4b313370b38ef355acdadcd122975b' + '12c85ea5db8c6deb4aab71808dcb408fe3d1e7690c43d37b4ce6cc0166fa7daa';
  const bnFp2 = bn254.fields.Fp2;
  const twistX = bnFp2.fromBigTuple([2n, 1n]), twistY = bnFp2.sqrt(bnFp2.add(bnFp2.mul(bnFp2.mul(twistX, twistX), twistX), bn254.G2.CURVE.b));
  const qOutside = `${word(twistX.c1)}${word(twistX.c0)}${word(twistY.c1)}${word(twistY.c0)}`;
  const qOff = `${Q.slice(0, 192)}${word(BigInt(`0x${Q.slice(192)}`) + 1n)}`;
  add(6, 'bn254 add, a point off the curve', `${word(1)}${word(3)}${G}`);
  add(6, 'bn254 add, x = p + 1', `${word(bnP + 1n)}${word(2)}${inf}`);
  add(6, 'bn254 add, y = p + 2', `${word(1)}${word(bnP + 2n)}${inf}`);
  add(6, 'bn254 add, infinity and infinity', `${inf}${inf}`);
  add(6, 'bn254 add, G and infinity', `${G}${inf}`);
  add(6, 'bn254 add, G and -G', `${G}${negG}`);
  add(6, 'bn254 add, 64 bytes', G);
  add(6, 'bn254 add, 192 bytes', `${G}${G}${'ab'.repeat(64)}`);
  add(6, `bn254 add on ${price.bnAdd - 1} gas`, `${G}${G}`, { gas: price.bnAdd - 1 });
  add(7, 'bn254 mul, scalar 0', `${G}${word(0)}`);
  add(7, 'bn254 mul, scalar r', `${G}${word(bnR)}`);
  add(7, 'bn254 mul, scalar 2^256 - 1', `${G}${word((1n << 256n) - 1n)}`);
  add(7, 'bn254 mul, a point off the curve, scalar 0', `${word(1)}${word(3)}${word(0)}`);
  add(7, 'bn254 mul, infinity times 5', `${inf}${word(5)}`);
  add(7, 'bn254 mul, 64 bytes', G);
  add(7, 'bn254 mul, x = p + 1', `${word(bnP + 1n)}${word(2)}${word(2)}`);
  add(7, 'bn254 mul, 128 bytes', `${G}${word(3)}${'ab'.repeat(32)}`);
  add(7, `bn254 mul on ${price.bnMul - 1} gas`, `${G}${word(3)}`, { gas: price.bnMul - 1 });
  add(8, 'bn254 pairing, 191 bytes', `${G}${Q}`.slice(0, 382));
  add(8, 'bn254 pairing, 193 bytes', `${G}${Q}00`);
  add(8, 'bn254 pairing, one pair (G, Q)', `${G}${Q}`);
  add(8, 'bn254 pairing, (infinity, Q)', `${inf}${Q}`);
  add(8, 'bn254 pairing, (G, infinity)', `${G}${zeros(128)}`);
  add(8, 'bn254 pairing, a G2 point off the twist', `${G}${qOff}`);
  add(8, 'bn254 pairing, a G2 point outside the subgroup', `${G}${qOutside}`);
  add(8, 'bn254 pairing, a G2 coordinate of p', `${G}${word(bnP)}${Q.slice(64)}`);
  add(8, 'bn254 pairing, a G1 point off the curve with G2 infinity', `${word(1)}${word(3)}${zeros(128)}`);
  add(8, 'bn254 pairing, Q with real and imaginary parts swapped', `${G}${Q.slice(64, 128)}${Q.slice(0, 64)}${Q.slice(192, 256)}${Q.slice(128, 192)}`);
  add(8, 'bn254 pairing, three pairs that hold', `${G}${Q}${negG}${Q}${inf}${Q}`);
  add(8, `bn254 pairing, two pairs on ${price.bnPair[0] + 2 * price.bnPair[1] - 1} gas`, `${G}${Q}${negG}${Q}`, { gas: price.bnPair[0] + 2 * price.bnPair[1] - 1 });

  // 0x09 blake2f: rounds, h, m, t, the final flag.
  const blake = (rounds: number, f = '01') => `${rounds.toString(16).padStart(8, '0')}${'5a'.repeat(64)}${'c3'.repeat(128)}${zeros(15)}03${f}`;
  add(9, 'blake2f, 212 bytes', blake(12).slice(0, -2));
  add(9, 'blake2f, 214 bytes', `${blake(12)}00`);
  add(9, 'blake2f, final flag 2', blake(12, '02'));
  add(9, 'blake2f, final flag 0', blake(12, '00'));
  add(9, 'blake2f, 0 rounds', blake(0));
  add(9, 'blake2f, 2^32 - 1 rounds', blake(0xffffffff));
  add(9, 'blake2f, 20,000 rounds', blake(20_000));
  add(9, `blake2f, 12 rounds on ${12 * price.blakeRound - 1} gas`, blake(12), { gas: 12 * price.blakeRound - 1 });
  add(9, 'blake2f, 0 rounds on 0 gas (its price)', blake(0), { gas: 0 });

  // 0x0a point evaluation: versioned hash, z, y, commitment, proof (the zero polynomial's: infinity, as precompilePrograms').
  const infinity48 = `c0${zeros(47)}`, versioned = (c: string) => `01${createHash('sha256').update(Buffer.from(c, 'hex')).digest('hex').slice(2)}`;
  const g1Compressed = Buffer.from(bls12_381.G1.ProjectivePoint.BASE.toRawBytes(true)).toString('hex'), FR = bls12_381.fields.Fr.ORDER;
  const kzg = (vh: string, z: bigint, y: bigint, c: string, proof: string) => `${vh}${word(z)}${word(y)}${c}${proof}`;
  const kzgOk = kzg(versioned(infinity48), 0n, 0n, infinity48, infinity48);
  add(10, 'point evaluation, a versioned hash of version 2', kzg(`02${versioned(infinity48).slice(2)}`, 0n, 0n, infinity48, infinity48));
  add(10, "point evaluation, another commitment's versioned hash", kzg(versioned(g1Compressed), 0n, 0n, infinity48, infinity48));
  add(10, 'point evaluation, a proof that does not hold', kzg(versioned(infinity48), 0n, 0n, infinity48, g1Compressed));
  add(10, 'point evaluation, y = 1 (does not hold)', kzg(versioned(infinity48), 0n, 1n, infinity48, infinity48));
  add(10, 'point evaluation, z = the modulus', kzg(versioned(infinity48), FR, 0n, infinity48, infinity48));
  add(10, 'point evaluation, y = the modulus', kzg(versioned(infinity48), 0n, FR, infinity48, infinity48));
  add(10, 'point evaluation, z = the modulus - 1 (holds)', kzg(versioned(infinity48), FR - 1n, 0n, infinity48, infinity48));
  add(10, 'point evaluation, a commitment that is no point', kzg(versioned(`80${zeros(47)}`), 0n, 0n, `80${zeros(47)}`, infinity48));
  add(10, 'point evaluation, 191 bytes', kzgOk.slice(0, 382));
  add(10, 'point evaluation, 193 bytes', `${kzgOk}00`);
  add(10, `point evaluation on ${price.kzg - 1} gas`, kzgOk, { gas: price.kzg - 1, programGas: BigInt(price.kzg) * 2n });

  // 0x0b-0x11 BLS12-381: field elements in 64 bytes (16 of them zero), Fp2 as c0 then c1.
  const { Fp: BFp, Fp2: BFp2 } = bls12_381.fields, BP = BFp.ORDER, Q381 = FR;
  const fp = (x: bigint) => x.toString(16).padStart(128, '0');
  const P1 = bls12_381.G1.ProjectivePoint, P2 = bls12_381.G2.ProjectivePoint;
  const g1 = (p: InstanceType<typeof P1>) => { if (p.equals(P1.ZERO)) return zeros(128); const a = p.toAffine(); return fp(a.x) + fp(a.y); };
  const g2 = (p: InstanceType<typeof P2>) => { if (p.equals(P2.ZERO)) return zeros(256); const a = p.toAffine(); return fp(a.x.c0) + fp(a.x.c1) + fp(a.y.c0) + fp(a.y.c1); };
  const B1 = P1.BASE, B2 = P2.BASE, gx = B1.toAffine().x, gy = B1.toAffine().y, g2a = B2.toAffine();
  const outside1 = `${fp(4n)}${fp(BFp.sqrt(BFp.add(BFp.pow(4n, 3n), 4n)))}`;
  const x2 = BFp2.fromBigTuple([1n, 1n]), y2 = BFp2.sqrt(BFp2.add(BFp2.mul(BFp2.mul(x2, x2), x2), BFp2.fromBigTuple([4n, 4n])));
  const outside2 = `${fp(x2.c0)}${fp(x2.c1)}${fp(y2.c0)}${fp(y2.c1)}`;
  add(0x0b, 'bls G1 add, G and G', `${g1(B1)}${g1(B1)}`);
  add(0x0b, 'bls G1 add, G and 2G', `${g1(B1)}${g1(B1.double())}`);
  add(0x0b, 'bls G1 add, G and infinity', `${g1(B1)}${zeros(128)}`);
  add(0x0b, 'bls G1 add, G and -G', `${g1(B1)}${g1(B1.negate())}`);
  add(0x0b, 'bls G1 add, a point off the curve', `${fp(gx)}${fp(gy + 1n)}${g1(B1)}`);
  add(0x0b, 'bls G1 add, a point outside the subgroup (accepted)', `${outside1}${g1(B1)}`);
  add(0x0b, 'bls G1 add, x = p', `${fp(BP)}${fp(gy)}${zeros(128)}`);
  add(0x0b, "bls G1 add, x's top 16 bytes not zero", `01${fp(gx).slice(2)}${fp(gy)}${zeros(128)}`);
  add(0x0b, 'bls G1 add, 255 bytes', `${g1(B1)}${g1(B1)}`.slice(0, 510));
  add(0x0b, `bls G1 add on ${price.g1Add - 1} gas`, `${g1(B1)}${g1(B1)}`, { gas: price.g1Add - 1 });
  add(0x0d, 'bls G2 add, G2 and G2', `${g2(B2)}${g2(B2)}`);
  add(0x0d, 'bls G2 add, G2 and 3·G2', `${g2(B2)}${g2(B2.multiply(3n))}`);
  add(0x0d, 'bls G2 add, G2 and infinity', `${g2(B2)}${zeros(256)}`);
  add(0x0d, 'bls G2 add, G2 and -G2', `${g2(B2)}${g2(B2.negate())}`);
  add(0x0d, 'bls G2 add, a point off the curve', `${fp(g2a.x.c0)}${fp(g2a.x.c1)}${fp(g2a.y.c0 + 1n)}${fp(g2a.y.c1)}${g2(B2)}`);
  add(0x0d, 'bls G2 add, a point outside the subgroup (accepted)', `${outside2}${g2(B2)}`);
  add(0x0d, 'bls G2 add, c0 = p', `${fp(BP)}${fp(g2a.x.c1)}${fp(g2a.y.c0)}${fp(g2a.y.c1)}${zeros(256)}`);
  add(0x0d, 'bls G2 add, G2 with c0 and c1 swapped', `${fp(g2a.x.c1)}${fp(g2a.x.c0)}${fp(g2a.y.c1)}${fp(g2a.y.c0)}${zeros(256)}`);
  add(0x0d, 'bls G2 add, 511 bytes', `${g2(B2)}${g2(B2)}`.slice(0, 1022));
  add(0x0d, `bls G2 add on ${price.g2Add - 1} gas`, `${g2(B2)}${g2(B2)}`, { gas: price.g2Add - 1 });
  const msm1 = (k: number) => Array.from({ length: k }, (_, i) => `${g1(B1.multiply(BigInt(i + 1)))}${word(BigInt(i) * 7919n + 3n)}`).join('');
  const msm2 = (k: number) => Array.from({ length: k }, (_, i) => `${g2(B2.multiply(BigInt(i + 1)))}${word(BigInt(i) * 7919n + 3n)}`).join('');
  add(0x0c, 'bls G1 msm, (G, 5)', `${g1(B1)}${word(5)}`);
  add(0x0c, 'bls G1 msm, (G, 0)', `${g1(B1)}${word(0)}`);
  add(0x0c, 'bls G1 msm, (G, q)', `${g1(B1)}${word(Q381)}`);
  add(0x0c, 'bls G1 msm, (G, 2^256 - 1)', `${g1(B1)}${word((1n << 256n) - 1n)}`);
  add(0x0c, 'bls G1 msm, (infinity, 7)', `${zeros(128)}${word(7)}`);
  add(0x0c, 'bls G1 msm, a point outside the subgroup', `${outside1}${word(1)}`);
  add(0x0c, 'bls G1 msm, a point off the curve', `${fp(gx)}${fp(gy + 1n)}${word(1)}`);
  add(0x0c, 'bls G1 msm, 159 bytes', `${g1(B1)}${word(5)}`.slice(0, 318));
  add(0x0c, 'bls G1 msm, 161 bytes', `${g1(B1)}${word(5)}00`);
  for (const k of [2, 4, 128, 129]) add(0x0c, `bls G1 msm, ${k} pairs`, msm1(k), { programGas: polygon ? 12_000_000n : 2_000_000n });
  add(0x0c, `bls G1 msm, one pair on ${price.g1Mul - 1} gas`, `${g1(B1)}${word(5)}`, { gas: price.g1Mul - 1 });
  add(0x0e, 'bls G2 msm, (G2, 5)', `${g2(B2)}${word(5)}`);
  add(0x0e, 'bls G2 msm, (G2, 0)', `${g2(B2)}${word(0)}`);
  add(0x0e, 'bls G2 msm, (G2, q)', `${g2(B2)}${word(Q381)}`);
  add(0x0e, 'bls G2 msm, (infinity, 7)', `${zeros(256)}${word(7)}`);
  add(0x0e, 'bls G2 msm, a point outside the subgroup', `${outside2}${word(1)}`);
  add(0x0e, 'bls G2 msm, 287 bytes', `${g2(B2)}${word(5)}`.slice(0, 574));
  for (const k of [2, 4, 128, 129]) add(0x0e, `bls G2 msm, ${k} pairs`, msm2(k), { programGas: polygon ? 16_000_000n : 3_000_000n });
  add(0x0e, `bls G2 msm, one pair on ${price.g2Mul - 1} gas`, `${g2(B2)}${word(5)}`, { gas: price.g2Mul - 1 });
  add(0x0f, 'bls pairing, e(G1, G2) e(-G1, G2)', `${g1(B1)}${g2(B2)}${g1(B1.negate())}${g2(B2)}`);
  add(0x0f, 'bls pairing, e(G1, G2)', `${g1(B1)}${g2(B2)}`);
  add(0x0f, 'bls pairing, e(2G1, 3G2) e(-6G1, G2)', `${g1(B1.double())}${g2(B2.multiply(3n))}${g1(B1.multiply(6n).negate())}${g2(B2)}`);
  add(0x0f, 'bls pairing, (infinity, G2)', `${zeros(128)}${g2(B2)}`);
  add(0x0f, 'bls pairing, (G1, infinity)', `${g1(B1)}${zeros(256)}`);
  add(0x0f, 'bls pairing, a G1 point outside the subgroup', `${outside1}${g2(B2)}`);
  add(0x0f, 'bls pairing, a G2 point outside the subgroup', `${g1(B1)}${outside2}`);
  add(0x0f, 'bls pairing, a G1 point off the curve', `${fp(gx)}${fp(gy + 1n)}${g2(B2)}`);
  add(0x0f, 'bls pairing, 383 bytes', `${g1(B1)}${g2(B2)}`.slice(0, 766));
  add(0x0f, `bls pairing, two pairs on ${price.pair[0] + 2 * price.pair[1] - 1} gas`, `${g1(B1)}${g2(B2)}${g1(B1.negate())}${g2(B2)}`, { gas: price.pair[0] + 2 * price.pair[1] - 1 });
  add(0x10, 'bls map to G1, 0', fp(0n));
  add(0x10, 'bls map to G1, p - 1', fp(BP - 1n));
  add(0x10, 'bls map to G1, a 48-byte value', fp(BigInt(`0x${'5a'.repeat(47)}`)));
  add(0x10, 'bls map to G1, p', fp(BP));
  add(0x10, 'bls map to G1, its top 16 bytes not zero', `01${fp(1n).slice(2)}`);
  add(0x10, 'bls map to G1, 63 bytes', fp(1n).slice(2));
  add(0x10, 'bls map to G1, 65 bytes', `${fp(1n)}00`);
  add(0x10, `bls map to G1 on ${price.mapG1 - 1} gas`, fp(1n), { gas: price.mapG1 - 1 });
  add(0x11, 'bls map to G2, (1, 2)', `${fp(1n)}${fp(2n)}`);
  add(0x11, 'bls map to G2, (0, 0)', `${fp(0n)}${fp(0n)}`);
  add(0x11, 'bls map to G2, (p - 1, 5)', `${fp(BP - 1n)}${fp(5n)}`);
  add(0x11, 'bls map to G2, c0 = p', `${fp(BP)}${fp(0n)}`);
  add(0x11, 'bls map to G2, c1 = p', `${fp(0n)}${fp(BP)}`);
  add(0x11, 'bls map to G2, 127 bytes', `${fp(1n)}${fp(2n)}`.slice(0, 254));
  add(0x11, `bls map to G2 on ${price.mapG2 - 1} gas`, `${fp(1n)}${fp(2n)}`, { gas: price.mapG2 - 1 });

  // 0x100 P-256 verify: a signature by a fixed key.
  const PN = p256.CURVE.n, PP = p256.CURVE.Fp.ORDER;
  const ph = createHash('sha256').update('signing-preview edge p256').digest('hex'), pk = '11'.repeat(32);
  const ps = p256.sign(ph, pk, { lowS: false }), pub = Buffer.from(p256.getPublicKey(pk, false)).toString('hex');
  const [qx, qy] = [BigInt(`0x${pub.slice(2, 66)}`), BigInt(`0x${pub.slice(66)}`)];
  const pv = (h: string, r: bigint, s: bigint, x = qx, y = qy) => `${h}${word(r)}${word(s)}${word(x)}${word(y)}`;
  const pOk = pv(ph, ps.r, ps.s);
  // A hash of n or more, as the field's integer (the signature over it reduced, as the precompile reduces it).
  const bigHash = word(PN + 5n), bs = p256.sign(bigHash, pk, { lowS: false });
  add(0x100, 'P-256, a signature that holds', pOk);
  add(0x100, 'P-256, the other s (n - s)', pv(ph, ps.r, PN - ps.s));
  add(0x100, 'P-256, r = 0', pv(ph, 0n, ps.s));
  add(0x100, 'P-256, s = 0', pv(ph, ps.r, 0n));
  add(0x100, 'P-256, r = n', pv(ph, PN, ps.s));
  add(0x100, 'P-256, s = n', pv(ph, ps.r, PN));
  add(0x100, 'P-256, r = r + n', pv(ph, ps.r + PN < 1n << 256n ? ps.r + PN : PN + 1n, ps.s));
  add(0x100, 'P-256, a key off the curve', pv(ph, ps.r, ps.s, qx, qy + 1n));
  add(0x100, 'P-256, the key at infinity (0, 0)', pv(ph, ps.r, ps.s, 0n, 0n));
  add(0x100, 'P-256, x = p', pv(ph, ps.r, ps.s, PP, qy));
  add(0x100, 'P-256, x + p (2^256 > x + p)', pv(ph, ps.r, ps.s, qx + PP < 1n << 256n ? qx + PP : PP + 1n, qy));
  add(0x100, 'P-256, 159 bytes', pOk.slice(0, 318));
  add(0x100, 'P-256, 161 bytes', `${pOk}00`);
  add(0x100, 'P-256, the wrong hash', pv(`${ph.slice(0, 62)}00`, ps.r, ps.s));
  add(0x100, 'P-256, a hash of n + 5', pv(bigHash, bs.r, bs.s));
  add(0x100, 'P-256, r and s swapped', pv(ph, ps.s, ps.r));
  add(0x100, `P-256 on ${price.p256 - 1} gas`, pOk, { gas: price.p256 - 1 });
  add(0x100, `P-256 on ${price.p256} gas`, pOk, { gas: price.p256 });

  // Transactions straight to a precompile: the transaction's own gas (calldata, its floor) around the precompile's,
  // and one that fails, which burns the transaction's whole limit.
  const straight = (target: number, label: string, data: string, value?: bigint) => out.push({ label: `edge a transaction straight to 0x${target.toString(16).padStart(2, '0')}, ${label}`, to: `0x${target.toString(16).padStart(40, '0')}`, data: `0x${data}`, ...(value && { value }) });
  straight(1, 'ecrecover', good); straight(1, 'ecrecover with 1 wei', good, 1n); straight(1, 'ecrecover, v = 0', rec(word(0n), sig.r, sig.s));
  straight(2, 'sha256 of 100 bytes', 'ab'.repeat(100)); straight(4, 'identity of 10,000 bytes', '00'.repeat(5_000) + 'ab'.repeat(5_000));
  straight(5, 'modexp, 32-byte numbers', mx(32, 32, 32, `${word(3)}${word(65537)}${word((1n << 255n) - 19n)}`));
  straight(6, 'bn254 add of a point off the curve (fails)', `${word(1)}${word(3)}${G}`); straight(8, 'bn254 pairing, three pairs', `${G}${Q}${negG}${Q}${inf}${Q}`);
  straight(9, 'blake2f, final flag 2 (fails)', blake(12, '02')); straight(10, 'point evaluation', kzgOk);
  straight(0x0b, 'bls G1 add', `${g1(B1)}${g1(B1)}`); straight(0x0c, 'bls G1 msm of nothing (fails)', '');
  straight(0x0f, 'bls pairing that holds', `${g1(B1)}${g2(B2)}${g1(B1.negate())}${g2(B2)}`);
  straight(0x100, 'P-256', pOk); straight(0x100, 'P-256, 159 bytes', pOk.slice(0, 318));

  // BNB Chain's own (0x64-0x69, ChainProfile.ownPrecompiles), beyond bnbPrograms': a gas short of each price, value,
  // DELEGATECALL and CALLCODE, more inputs each can't read.
  if (chainId === 56) {
    const message = createHash('sha256').update('signing-preview edge bnb').digest(), DST = 'BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_POP_';
    const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
    const keys = Array.from({ length: 10 }, (_, i) => `${(i + 1).toString(16).padStart(2, '0')}${'3c'.repeat(31)}`);
    const sigs = keys.map(k => bls12_381.sign(message, k, { DST })), pubs = keys.map(k => hex(bls12_381.getPublicKey(k)));
    const one = `${hex(message)}${hex(sigs[0])}${pubs[0]}`, ten = `${hex(message)}${hex(bls12_381.aggregateSignatures(sigs))}${pubs.join('')}`;
    add(0x66, 'BLS, one key, on 4,499 gas', one, { gas: 4_499 }); add(0x66, 'BLS, one key, on 4,500 gas', one, { gas: 4_500 });
    add(0x66, 'BLS, one key, sent a wei', one, { value: 1n }); add(0x66, 'BLS, one key, by DELEGATECALL', one, { op: 'DELEGATECALL' }); add(0x66, 'BLS, one key, by CALLCODE with a wei', one, { op: 'CALLCODE', value: 1n });
    add(0x66, 'BLS, ten keys aggregated', ten); add(0x66, 'BLS, ten keys, the signature of one', `${hex(message)}${hex(sigs[0])}${pubs.join('')}`);
    add(0x66, 'BLS, no key (128 bytes)', `${hex(message)}${hex(sigs[0])}`); add(0x66, 'BLS, a signature that is no point', `${hex(message)}${'ff'.repeat(96)}${pubs[0]}`);
    add(0x66, 'BLS, a key that is no point', `${hex(message)}${hex(sigs[0])}${'ff'.repeat(48)}`); add(0x66, 'BLS, a key of infinity', `${hex(message)}${hex(sigs[0])}c0${'00'.repeat(47)}`);
    const sk = '5b'.repeat(32), signed = secp256k1.sign(message, sk, { lowS: true }), pub = hex(secp256k1.getPublicKey(sk, true));
    const tm = `${pub}${word(signed.r)}${word(signed.s)}${hex(message)}`;
    add(0x69, 'secp256k1, on 2,999 gas', tm, { gas: 2_999 }); add(0x69, 'secp256k1, on 3,000 gas', tm, { gas: 3_000 });
    add(0x69, 'secp256k1, sent a wei', tm, { value: 1n }); add(0x69, 'secp256k1, by DELEGATECALL', tm, { op: 'DELEGATECALL' }); add(0x69, 'secp256k1, by CALLCODE with a wei', tm, { op: 'CALLCODE', value: 1n });
    add(0x69, 'secp256k1, 128 bytes', tm.slice(0, 256)); add(0x69, 'secp256k1, a key starting 04', `04${tm.slice(2)}`);
    add(0x69, 'secp256k1, a key no point has', `02${word(offCurve)}${tm.slice(66)}`); add(0x69, 'secp256k1, s = 0', `${pub}${word(signed.r)}${word(0)}${hex(message)}`);
    add(0x69, 'secp256k1, r = n', `${pub}${word(N)}${word(signed.s)}${hex(message)}`); add(0x69, 'secp256k1, the wrong digest', `${pub}${word(signed.r)}${word(signed.s)}${zeros(32)}`);
    add(0x67, 'light block, 1 byte', 'ab'); add(0x67, 'light block, 1 byte on 3,015 gas', 'ab', { gas: 3_015 }); add(0x67, 'light block, 100 bytes, sent a wei', 'ab'.repeat(100), { value: 1n });
    add(0x68, 'double-sign evidence, 32 bytes', 'ab'.repeat(32)); add(0x68, 'double-sign evidence, on 9,999 gas', 'ab'.repeat(32), { gas: 9_999 }); add(0x68, 'double-sign evidence, sent a wei', 'ab'.repeat(32), { value: 1n });
    for (const t of [0x64, 0x65]) { add(t, 'deprecated, sent a wei', 'ab'.repeat(32), { value: 1n }); add(t, 'deprecated, by DELEGATECALL', 'ab'.repeat(32), { op: 'DELEGATECALL' }); }
  }

  // Arbitrum's (ArbOS's, forwarded to the chain and priced as measured: 800 to open its state, 800 a slot, 3 a word),
  // methods rules-check doesn't call: what each costs, and calls ArbOS turns away.
  if (CHAIN_PROFILES[chainId]?.arbitrum) {
    const someone = word(BigInt(FROM));
    const arb = (address: number, method: string, args = '', how: How = {}) => out.push({ precompile: true, label: `edge Arb 0x${address.toString(16)} ${method}${how.gas !== undefined ? ` on ${how.gas} gas` : ''}${how.value ? ', 1 wei' : ''}${how.op && how.op !== 'CALL' && how.op !== 'STATICCALL' ? ` by ${how.op}` : ''}`,
      code: caller(address, how.op ?? (how.value ? 'CALL' : 'STATICCALL'), how.gas !== undefined ? hexGas(how.gas) : 'GAS'), data: `${toFunctionSelector(`function ${method}`)}${args}` as Hex, ...(how.value && { value: how.value }) });
    // (Not ArbInfo's getBalance and getCode, ArbOwnerPublic.getAllChainOwners, ArbGasInfo.getL1PricingSurplus,
    // ArbAggregator's getPreferredAggregator and getBatchPosters, ArbRetryableTx's getLifetime and
    // getCurrentRedeemer, ArbStatistics.getStats, ArbWasm's stylusVersion and inkPrice: they differ, the local EVM
    // pricing each as reading one slot; nor arbBlockNumber() on 802 gas, which the local EVM answers however little
    // gas it is given. 2026-11-16.)
    arb(0x66, 'size()'); arb(0x66, 'addressExists(address)', someone);
    arb(0x6b, 'getNetworkFeeAccount()'); arb(0x6b, 'getInfraFeeAccount()'); arb(0x6b, 'isChainOwner(address)', someone);
    arb(0x6c, 'getGasBacklog()'); arb(0x6c, 'getPricingInertia()'); arb(0x6c, 'getL1RewardRate()');
    arb(0x64, 'arbBlockNumber()', '', { gas: 803 });
    arb(0x6c, 'getPricesInWei()', '', { value: 1n }); arb(0x64, 'arbChainID()', '', { op: 'CALLCODE' });
    out.push({ precompile: true, label: 'edge Arb 0x64 a method ArbSys lacks', code: caller(0x64), data: '0xdeadbeef' });
  }

  // HyperEVM's HyperCore reads (0x0800 onward, forwarded to the chain and priced 1,000 + 33 a byte in and out), which
  // take their arguments ABI-encoded with no selector: reads whose answer doesn't move from block to block, an asset
  // that doesn't exist (all the gas), no input, a gas short of the price, a wei, a delegate call.
  if (hyper) {
    const user = word(BigInt(FROM));
    const core = (address: number, label: string, data: string, how: How = {}) => out.push({ precompile: true, label: `edge HyperCore 0x${address.toString(16)} ${label}`,
      code: caller(address, how.op ?? (how.value ? 'CALL' : 'STATICCALL'), how.gas !== undefined ? hexGas(how.gas) : 'GAS'), data: `0x${data}`, ...(how.value && { value: how.value }) });
    core(0x800, 'position(someone, 0)', `${user}${word(0)}`); core(0x801, 'spotBalance(someone, 0)', `${user}${word(0)}`); core(0x803, 'withdrawable(someone)', user);
    core(0x805, 'delegatorSummary(someone)', user); core(0x80a, 'perpAssetInfo(0)', word(0)); core(0x80b, 'spotInfo(0)', word(0)); core(0x80c, 'tokenInfo(0)', word(0));
    core(0x810, 'coreUserExists(someone)', user); core(0x80c, 'tokenInfo of a token that does not exist', word(0xffffffffn)); core(0x80a, 'perpAssetInfo of a perp that does not exist', word(0xffffffn));
    core(0x80c, 'tokenInfo with no input', ''); core(0x80c, 'tokenInfo(0) with 32 bytes more', `${word(0)}${word(7)}`);
    core(0x810, 'coreUserExists(someone) on 2,089 gas', user, { gas: 1000 + 33 * 64 - 1 }); core(0x810, 'coreUserExists(someone) on 3,112 gas', user, { gas: 1000 + 33 * 64 });
    core(0x810, 'coreUserExists(someone), 1 wei', user, { value: 1n }); core(0x810, 'coreUserExists(someone) by DELEGATECALL', user, { op: 'DELEGATECALL' }); core(0x810, 'coreUserExists(someone) by CALLCODE', user, { op: 'CALLCODE' });
    // 0x0815 to 0x083f, which the node runs as empty accounts (cold: 2,622 gas) and the local EVM forwarded as reads
    // (warm: 1,122) until 2026-11-16: the first past the reads, one in the middle and the last, with no input and with a wei.
    for (const a of [0x815, 0x820, 0x83f]) { core(a, 'with no input (no precompile there)', ''); core(a, 'with a wei (no precompile there)', '', { value: 1n }); }
  }

  // The identity precompile's answer written over its own input in memory, and into less room than it returns and
  // more (memory past what it returns is left as it was: 0xff here).
  out.push({ label: 'edge 0x04 identity, the answer over its own input, shifted 16 bytes', code: asm(`${'ab'.repeat(32)} 00 MSTORE ${'cd'.repeat(32)} 20 MSTORE 40 10 40 00 04 GAS STATICCALL POP 60 00 RETURN`) });
  out.push({ label: 'edge 0x04 identity, 10 bytes into 32 bytes of room over 0xff', code: asm(`${'ff'.repeat(32)} 40 MSTORE ${'ab'.repeat(32)} 00 MSTORE 20 40 0a 00 04 GAS STATICCALL POP RETURNDATASIZE 60 MSTORE 80 00 RETURN`) });
  out.push({ label: 'edge 0x04 identity, 64 bytes into 8 bytes of room', code: asm(`${'ab'.repeat(32)} 00 MSTORE ${'cd'.repeat(32)} 20 MSTORE 08 80 40 00 04 GAS STATICCALL POP RETURNDATASIZE a0 MSTORE c0 00 RETURN`) });
  // Each precompile's accepted input (precompilePrograms'), sent a wei by a CALL, run by a DELEGATECALL, and by a
  // CALLCODE with a wei: a precompile's account may not exist, and the wei creates it.
  // (One input each: a wei sent creates the account, and the next program in the block would find it there, where
  // a node with only eth_call runs each program on the block's own state.)
  const seen = new Set<number>();
  for (const p of (await precompilePrograms()).slice(0, 20)) {
    const target = Number(p.label.split(' ')[0]), name = p.label.split(' ').slice(1).join(' ');
    if (seen.has(target)) continue;
    seen.add(target);
    for (const [how, op, value] of [['sent a wei', 'CALL', 1n], ['by DELEGATECALL', 'DELEGATECALL', undefined], ['by CALLCODE with a wei', 'CALLCODE', 1n]] as const) {
      out.push({ precompile: true, label: `edge 0x${target.toString(16).padStart(2, '0')} ${name}, ${how}`, code: caller(target, op), data: p.data, ...(value && { value }), ...(target === 15 && polygon && { gas: 2_000_000n }) });
    }
  }
  // SELFDESTRUCT of a contract with a balance, to a precompile (EIP-6780: the balance moves, the code stays): a
  // precompile's account that doesn't exist yet is created, at 25,000. Each in a block of its own (first), as a
  // node with only eth_call runs each program on the block's own state.
  for (const t of [0x0b, 0x100]) out.push({ label: `edge SELFDESTRUCT to 0x${t.toString(16).padStart(2, '0')} with a balance`, code: asm(`${t.toString(16).padStart(t > 0xff ? 4 : 2, '0')} SELFDESTRUCT`), balance: 10n, first: true });
  return out;
}

class Chain {
  readonly chainId: number; readonly url: string; readonly client: JsonRpcClient; readonly fork: ForkSimulator;
  simulateV1 = true;
  /** The time the programs' block is given (--next: the scheduled fork's), in place of the next block's own. */
  time?: bigint;
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
      // --next needs the node to run a block at the fork's time: eth_call runs in the named block, at its own.
      if (this.time !== undefined && !this.simulateV1) throw new Error("--next: the node has no eth_simulateV1, so it can't run a block at the fork's time: not checked ahead");
      const pinned = this.simulateV1 ? await pinLatest(this.client, this.chainId) : await this.inBlock();
      const at = pinned && this.time !== undefined ? { ...pinned, header: { ...pinned.header, timestamp: this.time } } : pinned;
      // (A creation goes to no address: its `to` is only a key here.)
      const placed = programs.map((p, i) => ({ ...p, to: p.to ?? place(i) }));
      const overrides: Record<string, { code?: string; balance?: string }> = { ...RICH };
      for (const p of placed) if (p.code && !p.create) overrides[p.to] = { code: p.code, ...(p.balance !== undefined && { balance: `0x${p.balance.toString(16)}` }), ...(p.storage && { stateDiff: p.storage }) };
      // The accounts the programs give their authorities: overrides on the node, the block's own state locally.
      const state: StateChanges = Object.assign({}, ...placed.map(p => p.state ?? {}));
      const given = Object.keys(state).length > 0;
      // What a priced program pays for its gas: a gwei over the block's base fee (where the node simulates blocks).
      const price = at && this.simulateV1 ? at.header.baseFeePerGas + 1_000_000_000n : undefined;
      const node = await this.onNode(placed, given ? { ...overrides, ...state } : overrides, at, price);
      // A public node drops a block's state within seconds or minutes: on such an answer, another block. And a node
      // found to have no eth_simulateV1 is asked again the other way, with the block to match.
      // (Behind a public RPC some backends are a block behind the one that named the latest: asked again a little
      // later each time. Four tries in a row had once reached only those.)
      if (hadSimulate !== this.simulateV1) continue;
      if (!node && attempt < 6) { await new Promise(r => setTimeout(r, 1000 * (attempt + 1))); continue; }
      // The accounts the programs give reach the local EVM as the pinned block's own state. No block pinned (the node
      // didn't answer for its latest: Arbitrum's public RPC rate-limiting GitHub's runners), they would reach it not at
      // all, where the node has them as overrides: in a scheduled run 15 of Arbitrum One's delegation programs ran on
      // accounts with no code and nothing in them, and differed (2026-11-17). Asked again; past that, those programs
      // aren't compared (as overrides the local EVM takes them otherwise: an authority's code and nonce aren't the
      // state an authorization is checked against, and 9 of 73 then differed).
      // (So too a priced program, whose price is the pinned block's base fee and a tip.)
      // The same where the node runs calls, not blocks (HyperEVM's): its latest block's header is what the local EVM
      // runs them in, and with none read (its public RPC rate-limits: one read of some eighty in a full run) the
      // accounts the programs give reached the local EVM not at all. In the scheduled runs of 2026-11-21 and 22 the
      // sixteen programs of one batch each time (delegations one day, gas probes the next) ran locally on accounts
      // with no code, 23,674 gas each, and the strict check failed on them.
      const needsPin = (p: Program) => !!p.state || !!p.fees;
      const unpinned = !pinned && placed.some(needsPin);
      if (unpinned && attempt < 6) { await new Promise(r => setTimeout(r, 2000 * (attempt + 1))); continue; }
      const local = (await this.locally(placed, overrides, given && at ? { ...at, state } : at, price))
        .map((o, i) => (unpinned && needsPin(placed[i]) ? { kind: 'refused' as const, returns: '', logs: '', why: "no block pinned (the node didn't answer for its latest: a rate limit), so the accounts the program gives couldn't be its state, nor its price the block's" } : o));
      // The same for the local EVM's reads: a backend that hasn't the named block yet, or no longer its state.
      if (attempt < 6 && local.some(l => l.kind === 'refused' && /block not found|header not found|unknown block|not available|missing trie node/i.test(l.why ?? ''))) { await new Promise(r => setTimeout(r, 1000 * (attempt + 1))); continue; }
      // And a public RPC turning the local EVM's reads away (HTTP 429: Arbitrum's, from GitHub's runners, for four
      // programs in a scheduled run): asked again after a longer wait each time.
      if (attempt < 6 && local.some(l => l.kind === 'refused' && RATE_LIMITED.test(l.why ?? ''))) { await new Promise(r => setTimeout(r, 10_000 * (attempt + 1))); continue; }
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

  private async onNode(programs: (Program & { to: string })[], overrides: Record<string, unknown>, at: BlockAt | undefined, price?: bigint): Promise<Outcome[] | null> {
    const base = at?.header.baseFeePerGas ?? 0n, hex = (v: bigint) => `0x${v.toString(16)}`;
    const calls = programs.map(p => ({ from: p.from ?? FROM, ...(!p.create && { to: p.to }), data: p.data ?? '0x', value: hex(p.value ?? 0n), gas: hex(p.gas ?? GAS), ...(p.authorizationList && { authorizationList: authorizationsForNode(p.authorizationList) }), ...(p.priced && price !== undefined && { gasPrice: hex(price) }),
      ...(p.accessList && { accessList: p.accessList }), ...(p.fees && price !== undefined && { maxFeePerGas: hex(base + p.fees.cap), maxPriorityFeePerGas: hex(p.fees.tip ?? base + p.fees.cap) }) }));
    const kind = (ok: boolean, message?: string): Outcome['kind'] => (ok ? 'runs' : INVALID.test(message ?? '') ? 'invalid' : 'fails');
    // Without the pseudo-logs traceTransfers would add, and the logs a chain writes outside the EVM (Polygon's own transfer logs).
    const logsOf = (logs: { address: string; topics: string[]; data: string }[] | undefined) => (logs ?? []).filter(l => l.address.toLowerCase() !== '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' && !chainsOwnLog(l)).map(l => `${l.address.toLowerCase()}:${l.topics.join(',')}:${l.data}`).join('|');
    if (this.simulateV1) {
      const out = await this.post({ jsonrpc: '2.0', id: 1, method: 'eth_simulateV1', params: [{ blockStateCalls: [{ stateOverrides: overrides, calls, ...(at && { blockOverrides: nodeOverrides(at.header) }) }], validation: false }, at?.block ?? 'latest'] });
      if (out.error && (out.error.code === -32601 || /method not found|does not exist|not supported|unsupported method/i.test(out.error.message ?? ''))) this.simulateV1 = false;
      else if (out.error || !out.result?.[0]?.calls) { if (process.env.RULES_DEBUG) console.log(`  the node: ${JSON.stringify(out.error ?? out).slice(0, 300)}`); return null; }
      else return (out.result[0].calls as { status: string; returnData: string; gasUsed: string; maxUsedGas?: string; logs?: any[]; error?: { message?: string; data?: string } }[]).map(c => ({ kind: kind(c.status === '0x1', c.error?.message), returns: ((c.status === '0x1' ? c.returnData : c.error?.data ?? c.returnData) ?? '0x').toLowerCase(), gas: BigInt(c.gasUsed), ...(c.maxUsedGas && { peak: BigInt(c.maxUsedGas) }), logs: logsOf(c.logs), why: c.error?.message }));
    }
    // No eth_simulateV1: each program in an eth_call of its own (no gas figure, no events).
    const out = await this.post(calls.map((c, i) => ({ jsonrpc: '2.0', id: i, method: 'eth_call', params: [c, at?.block ?? 'latest', overrides] })));
    if (!Array.isArray(out)) return null;
    const byId = new Map(out.map((r: any) => [r.id, r]));
    return calls.map((_, i) => { const r = byId.get(i); return r?.error ? { kind: kind(false, r.error.message), returns: (r.error.data ?? '0x').toLowerCase(), logs: '', why: r.error.message } : { kind: 'runs', returns: String(r?.result ?? '0x').toLowerCase(), logs: '' }; });
  }

  private async locally(programs: (Program & { to: string })[], overrides: Record<string, { code?: string; balance?: string }>, at: BlockAt | undefined, price?: bigint): Promise<Outcome[]> {
    // An EIP-1559 transaction's price, as the chain works it out: the base fee and the tip, up to the cap (on Arbitrum
    // too, whose receipts and senders' balances show the tip paid, 2026-11-16).
    const base = at?.header.baseFeePerGas ?? 0n, tipped = (f: { cap: bigint; tip?: bigint }) => base + (f.tip !== undefined && f.tip < f.cap ? f.tip : f.cap);
    const request = (p: Program & { to: string }): SimulationRequest => ({ chainId: this.chainId, from: p.from ?? FROM, to: p.create ? null : p.to, data: p.data ?? '0x', value: p.value ?? 0n, gas: p.gas ?? GAS, ...(p.authorizationList && { authorizationList: p.authorizationList }), ...(p.priced && price !== undefined && { gasPrice: price }),
      ...(p.accessList && { accessList: p.accessList }), ...(p.fees && price !== undefined && { gasPrice: tipped(p.fees) }), stateOverrides: overrides, ...(at && { at }) });
    const one = async (reqs: SimulationRequest[]): Promise<Outcome[]> => (await this.fork.simulateBatch(reqs))!.map(r => ({
      kind: r.status === 'success' ? 'runs' : INVALID.test(r.revertReason ?? '') ? 'invalid' : 'fails', returns: (r.returnData ?? '0x').toLowerCase(), gas: r.gasUsed,
      // (Filtered as the node's are: Polygon's 0x…1010 also emits a LogTransfer from its own code, which the local EVM runs.)
      logs: (r.logs ?? []).filter(l => !chainsOwnLog(l)).map(l => `${l.address.toLowerCase()}:${l.topics.join(',')}:${l.data}`).join('|'), why: r.revertReason,
    }));
    try { return await one(programs.map(request)); } catch {
      // Something in the batch the local EVM refuses, or a read that failed: each program alone, so one says which.
      const out: Outcome[] = [];
      for (const p of programs) { try { out.push(...await one([request(p)])); } catch (e) { out.push({ kind: 'refused', returns: '', logs: '', why: (e as Error).message }); } }
      return out;
    }
  }
}

/** A public RPC's answer when it is turning requests away. */
const RATE_LIMITED = /HTTP 429|rate limit|too many requests/i;

interface Report { chainId: number; name: string; block?: string; fork: string[]; nodeOnly: string[]; /** Precompiles the node lists that the local EVM runs from their Solidity references. */ referenced: string[]; compared: number; differences: string[]; expected: string[]; drift: boolean; /** Programs a public RPC's rate limit kept from running, after waits: not compared. */ uncompared: string[]; /** How many of `differences` are programs'. */ programsDiffer?: number; /** Its blocks are Amsterdam's. */ amsterdam?: boolean; /** What the replays came to, where the chain's blocks carry their access lists. */ replays?: string }

/** Differences that are the node's way of answering, not a rule the local EVM has wrong: listed, not counted. */
const EXPECTED: Record<number, Record<string, string>> = {
  42161: {
    'opcode 0x5a': "GAS: Arbitrum's node takes its charge for L1 data out of the gas the call is given",
    'GAS, on a limit of 20,000,000': "GAS: Arbitrum's node takes its charge for L1 data out of the gas the call is given",
    // (What GAS reads first is the gas limit less what the transaction paid before it ran: there, its L1 charge too.)
    'gas: GAS read first, in a call with an access list of two addresses and three keys': "GAS: Arbitrum's node takes its charge for L1 data out of the gas the call is given",
    'gas: GAS read first, in a call with 1,000 nonzero bytes of calldata': "GAS: Arbitrum's node takes its charge for L1 data out of the gas the call is given",
    'gas: GAS read first, by the initcode of a creation from 100 bytes': "GAS: Arbitrum's node takes its charge for L1 data out of the gas the call is given",
  },
  999: {
    'opcode 0x45': "GASLIMIT: HyperEVM's eth_call reports its large blocks' limit (30,000,000), whatever block it names; the local EVM the block's own",
    // Its node answers on its latest block whatever block is named, as the block after it but at its time: what
    // depends on the block can't be matched from outside.
    'opcode 0x42': "TIMESTAMP: HyperEVM's node answers on its latest block, not the one named",
    'opcode 0x43': "NUMBER: HyperEVM's node answers on its latest block, not the one named",
    'BLOCKHASH of the block before': "HyperEVM's node answers on its latest block, not the one named",
    // Its fee recipient is the zero address, whose balance goes up in nearly every block (fees are burned to it):
    // read a block apart, as the node's run and the local EVM's state are, it isn't the same. A strict run of all
    // eight chains failed on this alone.
    'BALANCE of the fee recipient, in a call that pays for its gas': "HyperEVM's node answers on its latest block, not the one named: the fee recipient has been paid since",
    ...Object.fromEntries(['2 blocks back', '255 blocks back', '256 blocks back'].map(d => [`BLOCKHASH ${d}`, "HyperEVM's node answers on its latest block, not the one named"])),
    "the block's values read by a constructor (in a CREATE)": "NUMBER, TIMESTAMP and GASLIMIT: HyperEVM's node answers on its latest block, not the one named, and reports its large blocks' limit",
    'HyperEVM L1 block number (0x809)': "HyperCore's block number, which moves several times a second: the chain answers the local EVM's forwarded call a moment after the node's",
  },
};

/**
 * Whether a gas difference is more than `slack` either way. A random program on Arbitrum is allowed the L1 charge
 * itself: its node takes the charge out of the gas a call is given, so a call inside that fails with all it was
 * handed burns a little less there (2 and 5 gas, in two programs of 192).
 */
const beyond = (difference: bigint, slack: bigint) => (difference < 0n ? -difference : difference) > (slack < 0n ? -slack : slack);

/** Runs the programs on the chain's node and in the local EVM, up to sixteen to a simulated block, and notes what differs. */
async function compare(chain: Chain, chainId: number, programs: Program[], report: Report): Promise<void> {
  const compareGas = !CHAIN_PROFILES[chainId]?.arbitrum;
  // Sixteen to a block, and no more than 30,000,000 gas of limits in one. A node refuses a simulated block its calls
  // don't fit in ("Block gas limit exceeded by the block's transactions"): BNB Chain's adds up their limits (four
  // random programs on 16,000,000 each passed its 70,000,000), OP Mainnet's and Base's count the gas used before a
  // call and its limit (40,000,000 a block there; random programs on tight limits burn all of theirs).
  const batches: Program[][] = [];
  for (const p of programs) {
    const last = batches.at(-1), limit = (q: Program) => q.gas ?? GAS;
    if (last && !p.first && last.length < 16 && last.reduce((sum, q) => sum + limit(q), 0n) + limit(p) <= 30_000_000n) last.push(p);
    else batches.push([p]);
  }
  for (const batch of batches) {
    // Arbitrum's node adds a charge for L1 data to every call's gas: the same for calls with the same calldata and
    // gas limit in one block, but for the block's first call, which pays a few gas more. So there a call that isn't
    // compared goes first, and programs sent no calldata (at the usual gas limit) are compared less that charge:
    // what most of the batch differs by.
    const results = compareGas ? await chain.both(batch) : (await chain.both([{ label: 'first', code: '0x00' }, ...batch])).slice(1);
    let l1Charge: bigint | undefined;
    if (!compareGas) {
      const deltas = results.flatMap(({ node, local }, j) => (!batch[j].data && batch[j].gas === undefined && !batch[j].authorizationList && !batch[j].priced && !batch[j].accessList && !batch[j].fees && !batch[j].from && !batch[j].burns && node.kind === 'runs' && local.kind === 'runs' && node.gas !== undefined && local.gas !== undefined ? [node.gas - local.gas] : []));
      const counts = new Map<bigint, number>();
      for (const d of deltas) counts.set(d, (counts.get(d) ?? 0) + 1);
      const most = [...counts].sort((a, b) => b[1] - a[1])[0];
      if (most && most[1] * 2 > deltas.length) l1Charge = most[0];
      if (process.env.RULES_DEBUG) console.log(`  batch ${batches.indexOf(batch)}: L1 charge ${l1Charge}, deltas ${[...counts].map(([d, n]) => `${d}×${n}`).join(' ')}`);
    }
    results.forEach(({ node, local }, j) => {
      // RULES_SHOW=<part of a label>: what the node and the local EVM gave for the programs it names.
      // (RULES_WIDE=1: all the bytes returned.)
      // (RULES_FULL=1: both sides in full.)
      if (process.env.RULES_SHOW && batch[j].label.includes(process.env.RULES_SHOW) && process.env.RULES_FULL) console.log(`  [show] ${batch[j].label}:\n    node  ${node.kind} ${node.gas} ${node.returns}\n    local ${local.kind} ${local.gas} ${local.returns}`);
      else if (process.env.RULES_SHOW && batch[j].label.includes(process.env.RULES_SHOW)) console.log(`  ${batch[j].label}: the node ${node.kind}, ${node.gas} gas, returns ${node.returns.slice(0, process.env.RULES_WIDE ? 1000 : 74)}, ${node.logs ? node.logs.split('|').length : 0} events; the local EVM ${local.kind}, ${local.gas} gas, returns ${local.returns.slice(0, process.env.RULES_WIDE ? 1000 : 74)}, ${local.logs ? local.logs.split('|').length : 0} events`);
      // A program a rate limit kept from running, after the waits above, says nothing about the EVM: not compared,
      // and counted apart (a chain where many weren't fails the strict check all the same).
      const limited = [node, local].find(o => o.kind === 'refused' && RATE_LIMITED.test(o.why ?? ''));
      if (limited) { report.uncompared.push(`${batch[j].label}: ${limited.why?.slice(0, 80)}`); return; }
      if (node.kind === 'refused') { report.differences.push(`${batch[j].label}: not compared (${node.why})`); return; }
      report.compared++;
      const gas = node.gas !== undefined && local.gas !== undefined && (compareGas ? node.gas !== local.gas
        : l1Charge !== undefined && !batch[j].data && batch[j].gas === undefined && !batch[j].authorizationList && !batch[j].priced && !batch[j].accessList && !batch[j].fees && !batch[j].from && node.kind === 'runs' && local.kind === 'runs' && beyond(node.gas - local.gas - l1Charge, batch[j].random || batch[j].burns ? l1Charge : 0n) && !EXPECTED[chainId]?.[batch[j].label]);
      // Events are compared where the node reports them (not through eth_call).
      const logs = chain.simulateV1 && node.kind === 'runs' && local.kind === 'runs' && node.logs !== local.logs;
      // A precompile's caller returns four words. Where the precompile's call failed burning all the gas it was
      // given, which on Arbitrum follows from what the node charged before it, that word is left out there: where
      // both burnt all (more than half the program's gas). One that failed keeping the rest (ArbOS's errors) is
      // compared to the unit.
      const words = (o: Outcome) => (batch[j].precompile && o.kind === 'runs' && o.returns.length === 2 + 4 * 64 ? [0, 1, 2, 3].map(k => BigInt(`0x${o.returns.slice(2 + 64 * k, 66 + 64 * k)}`)) : undefined);
      const nodeWords = words(node), localWords = words(local), burntAll = (w: bigint[]) => w[0] === 0n && w[1] * 2n > (batch[j].gas ?? GAS);
      if (!compareGas && nodeWords && localWords && burntAll(nodeWords) && burntAll(localWords)) { node.returns = local.returns = `0x${[nodeWords[0], 0n, nodeWords[2], nodeWords[3]].map(w => w.toString(16).padStart(64, '0')).join('')}`; if (nodeWords[2] !== localWords[2] || nodeWords[3] !== localWords[3]) local.returns += '00'; }
      const said = (o: Outcome, w: bigint[] | undefined) => (w ? `, the precompile ${w[0] ? 'succeeds' : 'fails'} spending ${w[1]} gas and returning ${w[2]} bytes (hash ${w[3].toString(16).slice(0, 10)}…)` : `, returns ${o.returns.slice(0, 74)}`);
      const returns = node.kind === local.kind && node.kind !== 'invalid' && node.returns !== local.returns;
      if (node.kind !== local.kind || returns || gas || logs) {
        // Arbitrum's node takes its charge for L1 data out of the gas a call is given (see l1Charge): a program on a
        // limit of its own that the local EVM runs on all but less than that charge runs out of gas there (one of 300
        // random programs: 94,219 of 100,000 used locally).
        const squeezed = !compareGas && batch[j].gas !== undefined && node.kind === 'fails' && /out of gas/i.test(node.why ?? '') && local.kind === 'runs' && local.gas !== undefined
          && local.gas + (l1Charge !== undefined && l1Charge > 0n ? l1Charge * 2n : 20_000n) >= batch[j].gas!;
        const known = EXPECTED[chainId]?.[batch[j].label] ?? (report.amsterdam ? OVER_THE_CAP[batch[j].label] : undefined)
          ?? (squeezed ? `Arbitrum's node takes its charge for L1 data out of the gas the call is given: on ${batch[j].gas} it ran out where the local EVM used ${local.gas}` : undefined);
        if (process.env.RULES_FULL) console.log(`  [full] ${batch[j].label}:\n    node  ${node.kind} gas ${node.gas} ${node.why ?? ''}\n      ${node.returns}\n      logs ${node.logs}\n    local ${local.kind} gas ${local.gas} ${local.why ?? ''}\n      ${local.returns}\n      logs ${local.logs}`);
        (known ? report.expected : report.differences).push(known ? `${batch[j].label}: ${known}` : `${batch[j].label}: the node ${node.kind}${node.kind === 'fails' && node.why ? ` (${node.why.slice(0, 60)})` : ''}${node.gas !== undefined ? `, ${node.gas} gas` : ''}${returns ? said(node, nodeWords) : ''}; the local EVM ${local.kind}${local.kind !== 'runs' && local.why ? ` (${local.why.slice(0, 80)})` : ''}${local.gas !== undefined ? `, ${local.gas} gas` : ''}${returns ? said(local, localWords) : ''}${logs ? '; their events differ' : ''}${batch[j].detail ? ` [${batch[j].detail}]` : ''}`);
      }
    });
  }
}

/**
 * From Amsterdam on, what a gas limit holds over 16,777,216 is kept back for new state: code has the cap to run on,
 * and a transaction that burns all its gas burns that much. Sepolia's node doesn't do so when it simulates (it
 * gives the whole limit as ordinary gas), so the two programs that show it differ there, and the chain decides: a
 * mined transaction that failed on a 70,000,000 limit used exactly 16,777,216, as the local EVM has it.
 */
const OVER_THE_CAP: Record<string, string> = Object.fromEntries(['GAS, on a limit of 20,000,000', 'a static call that writes, given all the gas, on a limit of 20,000,000']
  .map(label => [label, "the node's simulation gives the whole gas limit as ordinary gas; the chain keeps what is over 16,777,216 back for new state (a mined transaction that failed on a 70,000,000 limit used 16,777,216), as the local EVM does"]));

async function check(chainId: number): Promise<Report> {
  const chain = new Chain(chainId), profile = CHAIN_PROFILES[chainId];
  const report: Report = { chainId, name: chainName(chainId), fork: [], nodeOnly: [], referenced: [], compared: 0, differences: [], expected: [], drift: false, uncompared: [] };
  const head = await chain.client.call(chainId, 'eth_getBlockByNumber', ['latest', false]) as { number: string; timestamp: string; blockAccessListHash?: string };
  report.block = BigInt(head.number).toString();
  const amsterdam = head.blockAccessListHash !== undefined && (chainId === 1 || chainId === 11155111);
  report.amsterdam = amsterdam;

  // The node's own account of its rules.
  const config = await chain.client.call(chainId, 'eth_config', []).then(c => c as { next?: { activationTime?: number; forkId?: string; precompiles?: Record<string, string> } }, () => undefined);
  const rules = nodeRulesOf(config), day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
  if (!rules) { report.fork.push('the node gives no account of its current fork (no eth_config, or none listed)'); if (NEXT) return report; }
  else {
    // (A fork checked ahead, --next, counts once it takes effect.)
    const same = profile?.checked && (rules.forkId === profile.checked.forkId || rules.forkId === profile.checked.next?.forkId);
    report.fork.push(`fork id ${rules.forkId}${rules.activation ? `, active since ${day(rules.activation)}` : ''}: ${same ? `the one checked on ${rules.forkId === profile!.checked!.forkId ? profile!.checked!.on : `${profile!.checked!.next!.on}, ahead`}` : profile?.checked ? `NOT the one checked on ${profile.checked.on} (${profile.checked.forkId})` : 'no fork recorded as checked for this chain'}`);
    if (profile?.checked && !same) report.drift = true;
    const common = createCustomCommon({ chainId }, Mainnet, { hardfork: (amsterdam ? 'amsterdam' : profile.hardfork) as never });
    const own = new Set([...getActivePrecompiles(common).keys()].map(k => `0x${k}`)), forwards = new Set([...(profile.forwardedPrecompiles ?? []), ...Object.keys(profile.ownPrecompiles ?? {})].map(a => a.toLowerCase()));
    for (const p of timedPrecompilesAt(profile, BigInt(head.timestamp))) own.add(p.address);
    for (const a of chainPrecompilesAt(chainId, BigInt(head.timestamp))) own.add(a);
    // (Base's registries run from their Solidity references: said apart.)
    for (const [address, name] of rules.precompiles) if (!own.has(address) && !forwards.has(address)) (hasReference(chainId, address) ? report.referenced : report.nodeOnly).push(`${name} ${address}`);
    const next = config?.next;
    if (NEXT) {
      if (!next?.forkId || !Number(next.activationTime)) { report.fork.push('--next: no fork scheduled: nothing to run'); return report; }
      const time = BigInt(next.activationTime!), checked = profile?.checked?.next;
      // Ethereum's next fork may be Amsterdam's (Glamsterdam, live on Sepolia): the local EVM takes those rules from a
      // block's header, which a block at the fork's time named here doesn't carry, so the programs would differ for
      // that alone. Said, not compared: the fork isn't checked ahead. (Whether the node runs Amsterdam then: SLOTNUM.)
      if ((chainId === 1 || chainId === 11155111) && !amsterdam) {
        const slot = await chain.client.call(chainId, 'eth_simulateV1', [{ blockStateCalls: [{ blockOverrides: { time: `0x${time.toString(16)}` }, stateOverrides: { [place(0)]: { code: '0x4b60005260206000f3' } }, calls: [{ from: FROM, to: place(0), data: '0x' }] }], validation: false }, 'latest']).then(r => (r as { calls: { status: string }[] }[])[0]?.calls[0]?.status, () => undefined);
        if (slot === '0x1') { report.fork.push(`--next: the fork scheduled for ${day(Number(time))} (fork id ${next.forkId}) runs Amsterdam's rules, which the local EVM takes from a block's header: not checked ahead by --next (check it on its testnet, or once its blocks carry their access lists)`); report.drift = true; return report; }
      }
      chain.time = time;
      report.fork.push(`--next: every program in a block at ${day(Number(time))}, when the fork with id ${next.forkId} takes effect: ${checked?.forkId === next.forkId ? `the fork checked ahead on ${checked.on}` : 'NOT yet checked ahead'}`);
      if (checked?.forkId !== next.forkId) report.drift = true;
      // What the node will list then, against the local EVM's (its own precompiles in effect at that time included).
      const then = new Set([...own, ...timedPrecompilesAt(profile, time).map(p => p.address)]);
      report.nodeOnly = []; report.referenced = [];
      for (const [name, a] of Object.entries(next.precompiles ?? {})) {
        const address = `0x${a.slice(2).toLowerCase().padStart(40, '0')}`;
        if (!then.has(address) && !forwards.has(address)) (hasReference(chainId, address) ? report.referenced : report.nodeOnly).push(`${name} ${address}`);
      }
    } else if (next?.forkId) {
      const now = new Set(rules.precompiles.keys()), added = Object.entries(next.precompiles ?? {}).filter(([, a]) => !now.has(`0x${a.slice(2).toLowerCase().padStart(40, '0')}`)).map(([n, a]) => `${n} ${a}`);
      report.fork.push(`a fork is scheduled${Number(next.activationTime) ? ` for ${day(Number(next.activationTime))}` : ''} (fork id ${next.forkId})${added.length ? `, adding ${added.join(', ')}` : ''}: ${profile?.checked?.next?.forkId === next.forkId ? `checked ahead on ${profile.checked.next.on} (--next)` : 'the local EVM will need checking against it (--next)'}`);
    }
  }

  // Every opcode but the designated invalid one (0xfe, which each node names its own way), then the crafted programs
  // and the precompiles, sixteen to a block.
  const base: Program[] = [
    ...Array.from({ length: 256 }, (_, op) => op).filter(op => op !== 0xfe).map(op => ({ label: `opcode 0x${hex2(op)}`, code: opcodeProgram(op) })),
    ...crafted(amsterdam), ...await precompilePrograms(),
    // (HyperEVM runs Cancun's rules, which have no such transactions, and its node only eth_call.)
    ...(profile.hardfork === 'cancun' ? [] : await authorizationPrograms(chainId)),
    ...(profile.arbitrum ? arbosPrograms() : []),
    ...(chainId === 8453 ? b20Programs() : []),
    ...(chainId === 8453 ? baseAaPrograms() : []),
    ...(chainId === 56 ? bnbPrograms() : []),
  ];
  // The families beyond those, each of which a flag runs alone:
  //   --family lifecycle: creation and an account's life (lifecycle-findings: those the local EVM doesn't run as the
  //   node does yet, kept out of the default run); --only-context: the block's context and system contracts;
  //   --only-gas: gas at its edges, and the boundaries after them; --only-delegations: EIP-7702 delegations and
  //   authorization lists beyond authorizationPrograms', access lists and EIP-1559 prices; --only-edges: the
  //   precompiles' edge inputs (--edges-match: those whose label has it); --only-combinations: opcodes in combination.
  // (HyperEVM's node runs each program in an eth_call of its own: none there reads what one before it did.)
  const lifecycle = (await lifecyclePrograms(chainId, amsterdam, FAMILY === 'lifecycle-findings' ? 'findings' : 'agree')).filter(p => !(p.sequel && chainId === 999));
  const delegations: Program[] = [...delegatedPrograms(), ...accessListPrograms(), ...(profile.hardfork === 'cancun' ? [] : await delegationAuthorizations(chainId))];
  const edges = (await precompileEdgePrograms(chainId)).filter(p => p.label.includes(EDGES_MATCH));
  const focused = FAMILY.startsWith('lifecycle') ? lifecycle : ONLY_CONTEXT ? contextPrograms(chainId) : ONLY_GAS ? gasPrograms() : ONLY_DELEGATIONS ? delegations
    : ONLY_EDGES ? edges : ONLY_COMBINATIONS ? combinationPrograms(chainId, amsterdam) : undefined;
  const programs: Program[] = focused ?? [...base, ...lifecycle, ...contextPrograms(chainId), ...gasPrograms(), ...delegations, ...edges, ...combinationPrograms(chainId, amsterdam)];
  // RULES_ONLY=<part of a label>: only the programs it names.
  const only = (ps: Program[]) => process.env.RULES_ONLY ? ps.filter(p => p.label.includes(process.env.RULES_ONLY!)) : ps;
  if (!ONLY_FUZZ) await compare(chain, chainId, only(programs), report);
  // Programs run again on exactly the gas the node's run of them needed, and one less (with the gas programs).
  if (!ONLY_FUZZ && (!focused || ONLY_GAS)) await boundaries(chain, chainId, report);
  // --fuzz N: as many random programs again (see fuzzPrograms), from --seed.
  if (FUZZ) await compare(chain, chainId, fuzzPrograms(FUZZ, SEED), report);
  report.programsDiffer = report.differences.length;
  // Where blocks carry their access lists (Amsterdam), what happened is on record down to each storage slot: recent
  // transactions are replayed with a trace, and each must match its receipt and change exactly the state its
  // block's list says it changed.
  // (Not when one family is run alone.)
  if (head.blockAccessListHash !== undefined && !NEXT && !focused && !ONLY_FUZZ) {
    const { replayed, differ } = await replays(chainId, chain.url);
    report.replays = `${replayed} recent transactions replayed with a trace: ${differ.length ? `${differ.length} differ` : "all match their receipts and change the state their block's access list records"}`;
    report.differences.push(...differ);
  }
  return report;
}

/**
 * Recent transactions of a chain whose blocks carry their access lists (EIP-7928), spread through a block a few
 * back, each replayed with a trace (src/replay.ts): the run against its receipt, the trace's state changes against
 * the block's access list. What differs, one line each.
 */
async function replays(chainId: number, url: string, count = 24): Promise<{ replayed: number; differ: string[] }> {
  const deps = liveDependencies({ [EVM_RPCS[chainId].env]: url, SIGNING_PREVIEW_FORK_CACHE: 'off', SIGNING_PREVIEW_OFFLINE_LOOKUPS: '1', SIGNING_PREVIEW_PRICES: 'off' }, { warmUp: false });
  const head = Number(await deps.rpc!.call(chainId, 'eth_blockNumber', []));
  const block = await deps.rpc!.call(chainId, 'eth_getBlockByNumber', [`0x${(head - 3).toString(16)}`, false]) as { transactions: string[] } | null;
  const hashes = block?.transactions ?? [], step = Math.max(1, Math.floor(hashes.length / count));
  const differ: string[] = [];
  let replayed = 0;
  for (const hash of hashes.filter((_, i) => i % step === 0).slice(0, count)) {
    try {
      const p = await replayTransaction({ chainId, hash }, { trace: true }, deps);
      // A node that couldn't hold the replay (its allowance for one simulation, where the block's access list
      // wasn't served; state it no longer keeps) leaves nothing to compare: not counted, unless most are so.
      if (p.simulation?.status === 'unavailable') continue;
      replayed++;
      if (!p.replay?.matches) differ.push(`the replay of ${hash} doesn't match its receipt: ${(p.replay?.differences ?? [p.simulation?.error ?? 'no simulation']).join('; ').slice(0, 200)}`);
      else if (p.trace?.stateAgrees === false) differ.push(`the trace of ${hash}: ${p.trace.note?.slice(0, 300)}`);
      else if (p.trace?.gasAgrees === false) differ.push(`the trace of ${hash} used other gas than the node's run: ${p.trace.note?.slice(0, 200)}`);
    } catch (e) { differ.push(`${hash} could not be replayed: ${(e as Error).message.slice(0, 200)}`); }
  }
  if (replayed * 2 < Math.min(count, hashes.length)) differ.push(`only ${replayed} of ${Math.min(count, hashes.length)} transactions could be replayed (the node didn't serve the rest)`);
  return { replayed, differ };
}

const reports: Report[] = [];
for (const chainId of CHAINS_ASKED) {
  try { reports.push(await check(chainId)); } catch (e) { reports.push({ chainId, name: chainName(chainId), fork: [], nodeOnly: [], referenced: [], compared: 0, uncompared: [], differences: [`the check did not run: ${(e as Error).message.slice(0, 200)}`], expected: [], drift: false }); }
  const r = reports.at(-1)!;
  console.log(`\n== ${r.name} (chain ${r.chainId})${r.block ? `, block ${r.block}` : ''}`);
  for (const line of r.fork) console.log(`  ${line}`);
  if (r.nodeOnly.length) console.log(`  precompiles the node has and the local EVM doesn't (refused in a local run): ${r.nodeOnly.join(', ')}`);
  if (r.referenced.length) console.log(`  precompiles the node has that the local EVM runs from their Solidity references: ${r.referenced.join(', ')}`);
  const programs = r.programsDiffer ?? r.differences.length;
  console.log(`  ${r.compared} programs compared on the node and locally: ${programs ? `${programs} differ` : 'all the same'}`);
  if (r.replays) console.log(`  ${r.replays}`);
  for (const d of r.differences) console.log(`    ${d}`);
  for (const d of r.expected) console.log(`    (expected) ${d}`);
  if (r.uncompared.length) console.log(`    not compared, rate limited: ${r.uncompared.length} (${r.uncompared.slice(0, 3).join('; ')})`);
}
if (OUT) writeFileSync(OUT, JSON.stringify(reports, null, 2));
if (SUMMARY_MD) {
  const lines = [NEXT ? '### Rules check at each scheduled fork' : '### Rules check', '', '| Chain | Fork | Compared | Differ |', '|---|---|---|---|', ...reports.map(r => `| ${r.name} | ${r.drift ? '**changed**' : r.fork[0]?.includes('the one checked') ? 'as checked' : 'not known'} | ${r.compared} | ${r.differences.length} |`), ''];
  for (const r of reports) if (r.differences.length || r.drift || r.nodeOnly.length || r.fork.length > 1 || r.replays || r.uncompared.length) lines.push(`**${r.name}**`, '', ...r.fork.map(f => `- ${f}`), ...(r.replays ? [`- ${r.replays}`] : []), ...(r.nodeOnly.length ? [`- Precompiles only the node has: ${r.nodeOnly.join(', ')}`] : []), ...(r.referenced.length ? [`- Precompiles run from their Solidity references: ${r.referenced.join(', ')}`] : []), ...r.differences.map(d => `- ${d}`), ...(r.uncompared.length ? [`- Not compared, the RPC's rate limit: ${r.uncompared.length}`] : []), '');
  appendFileSync(SUMMARY_MD, `${lines.join('\n')}\n`);
}
// More than a tenth of a chain's programs kept from running by rate limits is a check that didn't run.
const failing = reports.filter(r => r.drift || r.differences.length || r.uncompared.length * 10 > r.compared + r.uncompared.length);
console.log(`\n${reports.length} chain${reports.length === 1 ? '' : 's'} checked; ${failing.length ? `${failing.map(r => r.name).join(', ')} need${failing.length === 1 ? 's' : ''} a look` : 'the local EVM runs each as its node does'}.`);
if (STRICT && failing.length) process.exit(1);
