// ArbSys's sends to L1 in the local EVM, against what Arbitrum One's node did with the same calls on the same state
// (test/fixtures/arbsys-sends.json: eth_simulateV1 on a block's send-merkle tree, recorded 2026-11-15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAddressFromString, hexToBytes, unpadBytes } from '@ethereumjs/util';
import type { Hex } from 'viem';
import { ARBOS_STATE, ARBSYS, l1Send, sendMerkleSlot } from '../src/evm/arbos.ts';
import { CHAIN_PROFILES, ForkSimulator, ForkUnsupported } from '../src/fork-simulator.ts';
import { testChain } from './evm-chain.ts';

interface Call { label: string; from: string; to: string; data: Hex; value: Hex; gas: Hex; status: string; gasUsed: Hex; returnData: Hex; logs: { address: string; topics: Hex[]; data: Hex }[] }
const fixture = JSON.parse(readFileSync(new URL('./fixtures/arbsys-sends.json', import.meta.url), 'utf8')) as {
  parent: { number: Hex; l1BlockNumber: Hex; timestamp: Hex }; block: { number: Hex; timestamp: Hex }; meter: Hex; staticMeter: Hex; delegateMeter: Hex; arbosStorage: Record<string, Hex>; calls: Call[];
};
const own = (c: Call) => c.logs.filter(l => l.address.toLowerCase() === ARBSYS);
/** The meter's four words: success, the gas the call spent, how many bytes came back, then those bytes. */
const metered = (r: Hex) => ({ ok: BigInt(`0x${r.slice(2, 66)}`), gas: BigInt(`0x${r.slice(66, 130)}`), size: BigInt(`0x${r.slice(130, 194)}`), data: r.slice(194) });
const block = { arbBlockNumber: BigInt(fixture.block.number), l1BlockNumber: BigInt(fixture.parent.l1BlockNumber), timestamp: BigInt(fixture.block.timestamp) };

test("ArbSys's sends: the node's events, leaf and gas, to the unit, from the tree in ArbOS's storage", async () => {
  const slots = new Map(Object.entries(fixture.arbosStorage).map(([k, v]) => [k, BigInt(v)]));
  const state = { get: async (s: Hex) => slots.get(s) ?? 0n, set: async (s: Hex, v: bigint) => { slots.set(s, v); } };
  const merged: number[] = [];
  for (const c of fixture.calls.filter(c => !/static|delegate/.test(c.label))) {
    const direct = c.to === ARBSYS, input = hexToBytes(c.data);
    const withdraw = c.data.startsWith('0x25e16063');
    const destination = `0x${c.data.slice(34, 74)}`, data: Hex = withdraw ? '0x' : `0x${c.data.slice(10 + 192, 10 + 192 + 2 * Number(BigInt(`0x${c.data.slice(10 + 128, 10 + 192)}`)))}`;
    const sent = await l1Send({ caller: direct ? c.from : c.to, destination, value: BigInt(c.value), data, ...block }, input.length, state);
    await sent.apply();
    assert.deepEqual(sent.logs.map(l => ({ ...l, address: l.address.toLowerCase() })), own(c).map(l => ({ ...l, address: l.address.toLowerCase() })), c.label);
    merged.push(sent.logs.length - 1);
    if (direct) { assert.equal(sent.position, BigInt(c.returnData), c.label); continue; }
    // From a contract: the gas its CALL spent, less the meter's own (20) and the call's (100; with value 9,000 less
    // the 2,300 the call is given back).
    const m = metered(c.returnData);
    assert.equal(sent.gas, m.gas - (BigInt(c.value) > 0n ? 6_820n : 120n), c.label);
    assert.equal(sent.position, BigInt(`0x${m.data}`), c.label);
  }
  // The calls merged none, one, two and three levels of the tree on the way.
  assert.deepEqual([...new Set(merged)].sort(), [0, 1, 2, 3]);
  assert.equal(slots.get(sendMerkleSlot(0)), BigInt(fixture.arbosStorage[sendMerkleSlot(0)]) + 8n);
});

test('The local EVM runs them: value burned, events, leaf and gas as the node; a static or delegate call fails, burning all', async () => {
  const chain = await testChain();
  for (const [slot, v] of Object.entries(fixture.arbosStorage)) await chain.evm.stateManager.putStorage(createAddressFromString(ARBOS_STATE), hexToBytes(slot as Hex), unpadBytes(hexToBytes(v)));
  // ArbSys's account on the chain: code 0xfe, so a call with value to it pays no new account.
  await chain.putCode(ARBSYS, '0xfe');
  const fork = new ForkSimulator({ 999: 'http://arbitrum.invalid' }, { fetchImpl: chain.fetchImpl, profiles: { 999: { ...CHAIN_PROFILES[42161] } } });
  const [M, MS, MD] = ['0x2222222222222222222222222222222222222222', '0x3333333333333333333333333333333333333333', '0x5555555555555555555555555555555555555555'];
  const header = { number: block.l1BlockNumber, arbBlockNumber: block.arbBlockNumber, timestamp: block.timestamp, coinbase: '0xa4b000000000000000000073657175656e636572', prevRandao: `0x${'00'.repeat(31)}01` as Hex, gasLimit: 32_000_000n, baseFeePerGas: 10_000_000n };
  const overrides = { [fixture.calls[0].from]: { balance: '0x56bc75e2d63100000' }, [M]: { code: fixture.meter }, [MS]: { code: fixture.staticMeter }, [MD]: { code: fixture.delegateMeter } };
  const results = (await fork.simulateBatch(fixture.calls.map(c => ({ chainId: 999, from: c.from, to: c.to, data: c.data, value: BigInt(c.value), gas: BigInt(c.gas), stateOverrides: overrides, at: { block: 'latest', header }, trace: c === fixture.calls[0] }))))!;
  fixture.calls.forEach((c, i) => {
    const r = results[i];
    assert.equal(r.status, 'success', c.label);
    assert.deepEqual(r.logs, own(c).map(l => ({ ...l, address: l.address.toLowerCase() })), c.label);
    if (c.to === ARBSYS) { assert.equal(r.returnData, c.returnData, c.label); return; }
    const local = metered(r.returnData as Hex), node = metered(c.returnData);
    if (node.ok) assert.deepEqual(local, node, c.label);
    else assert.deepEqual([local.ok, local.size], [0n, 0n], c.label);
  });
  // The account withdrawing 0.001 ETH loses it: it goes to ArbSys and is burned there.
  assert.deepEqual(results[0].transfers, [{ asset: 'native', from: fixture.calls[0].from, to: ARBSYS, raw: 10n ** 15n }]);
  const arbSys = results[0].stateChanges?.find(s => s.address === ARBSYS);
  assert.equal(arbSys?.balance, undefined);
  assert.ok(results[0].stateChanges?.some(s => s.address === ARBOS_STATE && s.storage?.some(w => w.slot === sendMerkleSlot(0))));
  // The trace shows the call to ArbSys with its events.
  assert.equal(results[0].trace?.to, ARBSYS);
});

test("ArbRetryableTx's writes: a ticket that doesn't exist reverts as on the node, at its price; one that exists is refused", async () => {
  const chain = await testChain();
  // The chain's answers to an eth_call of each (this test chain has no ArbOS: the answers are given; a method it
  // hasn't, as the balance reads around the call ask the meter for, reverts with nothing).
  const noTicket = '0x80698456';
  const answers = new Map<string, { result?: Hex; error?: { code: number; message: string; data: Hex } }>();
  const base = chain.fetchImpl;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { id: number; method: string; params: [{ to?: string; data?: string }] }[];
    if (!Array.isArray(body) || !body.some(b => b.method === 'eth_call' && b.params[0]?.to === '0x000000000000000000000000000000000000006e')) return base(url, init);
    const out = await Promise.all(body.map(async b => {
      if (b.method === 'eth_call' && b.params[0]?.to === '0x000000000000000000000000000000000000006e') return { jsonrpc: '2.0', id: b.id, ...(answers.get(b.params[0].data!.slice(0, 10)) ?? { error: { code: 3, message: 'execution reverted', data: '0x' } }) };
      const r = await base(url, { ...init, body: JSON.stringify(b) });
      return r.json();
    }));
    return new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const fork = new ForkSimulator({ 999: 'http://arbitrum.invalid' }, { fetchImpl, profiles: { 999: { ...CHAIN_PROFILES[42161] } } });
  const M = '0x2222222222222222222222222222222222222222', FROM = '0x1111111111111111111111111111111111111111';
  // A contract that CALLs ArbRetryableTx with its calldata and reports the gas the call spent (the fixture's meter, aimed at 0x6e).
  const meter = fixture.meter.replace('6064', '606e') as Hex;
  const run = (selector: string) => fork.simulate({ chainId: 999, from: FROM, to: M, data: `${selector}${'00'.repeat(31)}01` as Hex, value: 0n, stateOverrides: { [M]: { code: meter } } });
  for (const s of ['0xeda1122c', '0xf0b21a41', '0xc4d252f5']) answers.set(s, { error: { code: 3, message: 'execution reverted', data: noTicket } });
  // Measured on Arbitrum One: redeem 2,406, keepalive and cancel 1,606 (the meter adds 120).
  const gasOf = async (s: string) => { const r = metered((await run(s))!.returnData as Hex); return [r.ok, r.gas, `0x${r.data}`]; };
  assert.deepEqual(await gasOf('0xeda1122c'), [0n, 2_526n, noTicket]);
  assert.deepEqual(await gasOf('0xf0b21a41'), [0n, 1_726n, noTicket]);
  answers.set('0xeda1122c', { result: `0x${'ab'.repeat(32)}` });
  await assert.rejects(run('0xeda1122c'), (e: Error) => e instanceof ForkUnsupported && /ArbRetryableTx\.redeem .* ticket that exists/.test(e.message));
});

test('ArbOS precompiles priced apart: ArbFilteredTransactionsManager 1,600 whatever its input; ArbosActs no reads', () => {
  const price = CHAIN_PROFILES[42161].precompileGas!;
  assert.equal(price(36, 32, '0x12345678', '0x0000000000000000000000000000000000000074'), 1_600n);
  assert.equal(price(1036, 0, '0xabababab', '0x0000000000000000000000000000000000000074'), 1_600n);
  assert.equal(price(132, 4, '0x6bf6a42d', '0x00000000000000000000000000000000000a4b05'), 815n);
  assert.ok(['0x0000000000000000000000000000000000000073', '0x0000000000000000000000000000000000000074', '0x00000000000000000000000000000000000a4b05'].every(a => CHAIN_PROFILES[42161].forwardedPrecompiles!.includes(a)));
});

/** An address in ArbOS's range. */
const low = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
type Answer = { result?: Hex; error?: { code: number; message: string; data?: Hex } };
/**
 * The test chain, with what Arbitrum One's node answers given: `plain`, its answer to a plain eth_call of one of
 * ArbOS's precompiles (a revert with nothing where none is given), and `spent`, what the contract the local EVM asks
 * after a revert reports (the gas the precompile's call spent; undefined: that call succeeded there). Each question
 * is noted in `asked` ("call <to>_<data>" or "meter <precompile>_<data>").
 */
function arbOsNode(base: typeof fetch, plain: (to: string, data: string) => Answer | undefined, spent: (to: string, data: string) => bigint | undefined, asked: string[] = []): typeof fetch {
  const arbOs = new Set(CHAIN_PROFILES[42161].forwardedPrecompiles);
  // The meter's code names the precompile it calls in a PUSH20, after 17 bytes of its own.
  const meterTarget = (b: { params: [unknown, unknown, Record<string, { code?: string }>?] }) => Object.values(b.params[2] ?? {})[0]?.code?.match(/^0x3660006000375a60006000366000600073([0-9a-f]{40})62/)?.[1];
  const ours = (b: { method: string; params: [{ to?: string }, unknown, Record<string, { code?: string }>?] }) => b.method === 'eth_call' && (arbOs.has(b.params[0]?.to?.toLowerCase() ?? '') || !!meterTarget(b));
  return (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (!Array.isArray(body) || !body.some(ours)) return base(url, init);
    const out = await Promise.all(body.map(async b => {
      if (!ours(b)) return (await base(url, { ...init, body: JSON.stringify(b) })).json();
      const target = meterTarget(b), data = b.params[0].data as string;
      asked.push(`${target ? 'meter' : 'call'} ${target ? `0x${target}` : b.params[0].to.toLowerCase()}_${data}`);
      if (target) {
        const s = spent(`0x${target}`, data);
        return { jsonrpc: '2.0', id: b.id, result: `0x${(s === undefined ? 0n : s + 122n).toString(16).padStart(64, '0')}${(s === undefined ? 1n : 0n).toString(16).padStart(64, '0')}` };
      }
      return { jsonrpc: '2.0', id: b.id, ...(plain(b.params[0].to.toLowerCase(), data) ?? { error: { code: 3, message: 'execution reverted', data: '0x' } }) };
    }));
    return new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}
/** A contract that calls `target` with its calldata (`op`: f1 CALL, f2 CALLCODE, f4 DELEGATECALL, fa STATICCALL, passing on its value where it can) and reports success, the gas spent, the size and the data returned. */
const meterOf = (target: number, op: 'f1' | 'f2' | 'f4' | 'fa'): Hex => {
  const t = target.toString(16).padStart(target > 0xffff ? 6 : target > 0xff ? 4 : 2, '0');
  return `0x3660006000375a60006000366000${op === 'f1' || op === 'f2' ? '34' : ''}${(0x5f + t.length / 2).toString(16)}${t}5a${op}5a9060005290036020523d6040523d600060603e3d6060016000f3`;
};

test("ArbOS turns a call away before its method runs, by how it is called: all burnt (ArbFilteredTransactionsManager's: a revert at 1,600); a pure method runs in a delegate call", async () => {
  const chain = await testChain();
  // ArbOS's accounts on the chain have code 0xfe: a call with value to one pays no new account.
  for (const a of [0x64, 0x6e, 0x74]) await chain.putCode(low(a), '0xfe');
  const noTicket = '0x80698456', word = (n: bigint) => n.toString(16).padStart(64, '0');
  const asked: string[] = [];
  const fetchImpl = arbOsNode(chain.fetchImpl, (to, data) => {
    if (to === low(0x6e)) return { error: { code: 3, message: 'execution reverted', data: noTicket } };
    if (to === low(0x74)) return { result: `0x${word(0n)}` };
    if (to === low(0x64) && data.startsWith('0x4dbbd506')) return { result: `0x${word(0x1111000000000000000000000000000000001111n + 0xd5n)}` };
    return undefined;
  }, (to, data) => (to === low(0x6e) && data.startsWith('0xeda1122c') ? 2_406n : to === low(0x6e) ? 1_606n : to === low(0x64) ? 812n : 1_000_000n), asked);
  const fork = new ForkSimulator({ 999: 'http://arbitrum.invalid' }, { fetchImpl, profiles: { 999: { ...CHAIN_PROFILES[42161] } } });
  const FROM = '0x1111111111111111111111111111111111111111', M = '0x2222222222222222222222222222222222222222', X = '0x4444444444444444444444444444444444444444';
  const ticket = word(0xdeadn);
  const run = async (code: Hex, data: string, value = 0n, extra: Record<string, { code: Hex }> = {}) => {
    const r = await fork.simulate({ chainId: 999, from: FROM, to: M, data: data as Hex, value, gas: 1_000_000n, stateOverrides: { [FROM]: { balance: '0x56bc75e2d63100000' }, [M]: { code }, ...extra } });
    assert.equal(r?.status, 'success');
    return metered(r!.returnData as Hex);
  };
  const burnt = (m: ReturnType<typeof metered>, label: string) => { assert.deepEqual([m.ok, m.size], [0n, 0n], label); assert.ok(m.gas > 900_000n, `${label}: ${m.gas}`); };
  // Measured on Arbitrum One: each of these fails there with nothing, burning all it was given.
  burnt(await run(meterOf(0x6e, 'fa'), `0xeda1122c${ticket}`), 'redeem in a static call');
  burnt(await run(meterOf(0x6e, 'fa'), `0xc4d252f5${ticket}`), 'cancel in a static call');
  burnt(await run(meterOf(0x6e, 'f4'), `0xf0b21a41${ticket}`), 'keepalive in a delegate call');
  burnt(await run(meterOf(0x6e, 'f4'), `0x9f1025c6${ticket}`), 'getTimeout in a delegate call');
  burnt(await run(meterOf(0x6e, 'f2'), `0x9f1025c6${ticket}`), 'getTimeout by callcode');
  burnt(await run(meterOf(0x6e, 'f1'), `0xeda1122c${ticket}`, 1n), 'redeem with 1 wei');
  burnt(await run(meterOf(0x6e, 'f1'), `0xba20dda4${ticket}`, 1n), 'getBeneficiary with 1 wei');
  burnt(await run(meterOf(0x64, 'f1'), `0x2b407a82${word(1n << 40n)}`, 1n), 'arbBlockHash with 1 wei');
  burnt(await run(meterOf(0x64, 'f4'), `0x2b407a82${word(1n << 40n)}`), 'arbBlockHash in a delegate call');
  burnt(await run(meterOf(0x64, 'f4'), '0xa3b1b31d'), 'arbBlockNumber in a delegate call');
  burnt(await run(meterOf(0x66, 'fa'), `0x4420e486${word(0xd5n)}`), 'ArbAddressTable.register in a static call');
  burnt(await run(meterOf(0x64, 'f2'), `0x25e16063${word(0xd5n)}`), 'withdrawEth by callcode');
  // A CALL made inside a static call is static too.
  const throughStatic = `0x366000600037600060003660007${'3'}${X.slice(2)}5afa503d600060003e3d6000f3` as Hex;
  burnt(await run(throughStatic, `0xeda1122c${ticket}`, 0n, { [X]: { code: meterOf(0x6e, 'f1') } }), 'redeem by a CALL made inside a static call');
  // Called as it should be, the method runs: NoTicketWithID(), at its price (the meter adds 120).
  assert.deepEqual(await run(meterOf(0x6e, 'f1'), `0xeda1122c${ticket}`), { ok: 0n, gas: 2_526n, size: 4n, data: noTicket.slice(2) });
  // ArbFilteredTransactionsManager charges its 1,600 first: turned away, it reverts there and keeps the rest (the meter adds 118 or 120).
  assert.deepEqual(await run(meterOf(0x74, 'f4'), `0x85c733a4${ticket}`), { ok: 0n, gas: 1_718n, size: 0n, data: '' });
  assert.deepEqual(await run(meterOf(0x74, 'f1'), `0x85c733a4${ticket}`, 1n), { ok: 0n, gas: 1_600n + 6_820n, size: 0n, data: '' });
  assert.deepEqual(await run(meterOf(0x74, 'f1'), `0x85c733a4${ticket}`), { ok: 1n, gas: 1_720n, size: 32n, data: word(0n) });
  // A pure method runs in a delegate call, and opens no state: 3 a word (mapL1SenderContractAddressToL2Alias 9).
  const alias = await run(meterOf(0x64, 'f4'), `0x4dbbd506${word(0xd5n)}${word(0xd5n)}`);
  assert.deepEqual([alias.ok, alias.gas, alias.size], [1n, 9n + 118n, 32n]);
  // Turned away here, the node isn't asked.
  assert.ok(!asked.some(k => k.includes('0x4420e486') || k.includes('0x2b407a82')));
});

test("A revert of ArbOS's is charged what the node's call was charged (asked of a contract that reports it): the rest kept, with or without data, or all burnt", async () => {
  const chain = await testChain();
  const word = (n: bigint) => n.toString(16).padStart(64, '0'), asked: string[] = [];
  let meterUp = true;
  const fetchImpl = arbOsNode(chain.fetchImpl, (to, data) => {
    if (to === low(0x71)) return { error: { code: 3, message: 'execution reverted', data: '0x6f809c4e' } }; // ProgramNotActivated()
    if (to === low(0x66) && data.startsWith('0xa5025222')) return { result: `0x${word(0n)}` }; // addressExists
    return undefined; // a revert with nothing
  }, (to, data) => {
    if (!meterUp) return undefined;
    // Measured on Arbitrum One: lookup of an address it hasn't 1,603; lookupIndex of 2^200 803; programVersion of an
    // account that isn't a program 4,306; a method ArbAddressTable hasn't burns all the meter gave it.
    if (to === low(0x66)) return data.startsWith('0xd4b6b5da') ? 1_603n : data.startsWith('0x8a186788') ? 803n : 1_000_000n;
    return to === low(0x71) ? 4_306n : 1_000_000n;
  }, asked);
  const profiles = { 999: { ...CHAIN_PROFILES[42161] } };
  const FROM = '0x1111111111111111111111111111111111111111', M = '0x2222222222222222222222222222222222222222';
  const run = async (target: number, data: string, gas = 1_000_000n) => {
    const fork = new ForkSimulator({ 999: 'http://arbitrum.invalid' }, { fetchImpl, profiles });
    const r = await fork.simulate({ chainId: 999, from: FROM, to: M, data: data as Hex, value: 0n, gas, stateOverrides: { [M]: { code: meterOf(target, 'fa') } } });
    return metered(r!.returnData as Hex);
  };
  assert.deepEqual(await run(0x66, `0xd4b6b5da${word(0xd5n)}`), { ok: 0n, gas: 1_603n + 118n, size: 0n, data: '' });
  assert.deepEqual(await run(0x66, `0x8a186788${word(1n << 200n)}`), { ok: 0n, gas: 803n + 118n, size: 0n, data: '' });
  assert.deepEqual(await run(0x71, `0xcc8f4e88${word(0xd5n)}`), { ok: 0n, gas: 4_306n + 118n, size: 4n, data: '6f809c4e' });
  // The node's own call burnt all: so does the local one.
  const unknown = await run(0x66, '0x12345678');
  assert.deepEqual([unknown.ok, unknown.size], [0n, 0n]);
  assert.ok(unknown.gas > 900_000n);
  // What a revert was charged is asked once; of a call that succeeded, never.
  assert.equal(asked.filter(k => k === `meter ${low(0x66)}_0xd4b6b5da${word(0xd5n)}`).length, 1);
  assert.equal((await run(0x66, `0xa5025222${word(0xd5n)}`)).ok, 1n);
  assert.ok(asked.includes(`call ${low(0x66)}_0xa5025222${word(0xd5n)}`) && !asked.some(k => k.startsWith('meter') && k.includes('0xa5025222')));
  // Given less than the charge, it runs out: all burnt (a meter that gives the call 1,000 gas).
  const short = await (async () => {
    const fork = new ForkSimulator({ 999: 'http://arbitrum.invalid' }, { fetchImpl, profiles });
    const code = meterOf(0x66, 'fa').replace('5afa', '6103e8fa') as Hex;
    const r = await fork.simulate({ chainId: 999, from: FROM, to: M, data: `0xd4b6b5da${word(0xd6n)}` as Hex, value: 0n, stateOverrides: { [M]: { code } } });
    return metered(r!.returnData as Hex);
  })();
  assert.deepEqual([short.ok, short.size], [0n, 0n]);
  assert.equal(short.gas, 1_000n + 119n);
  // Where the node can't say (its meter's call succeeded, as for a method that asks who calls), as before: a revert
  // with nothing burns all, an error to decode keeps the rest at the modeled price (800, a read, 3 a word).
  meterUp = false;
  const unsaid = await run(0x66, `0xd4b6b5da${word(0xd7n)}`);
  assert.deepEqual([unsaid.ok, unsaid.size], [0n, 0n]);
  assert.ok(unsaid.gas > 900_000n);
  assert.deepEqual(await run(0x71, `0xcc8f4e88${word(0xd7n)}`), { ok: 0n, gas: 1_606n + 118n, size: 4n, data: '6f809c4e' });
});

test("Calldata short of a ticket id to ArbRetryableTx's writes burns all, as on the node; 0x6a is an empty account; burnArbGas past its gas spends it all and succeeds", async () => {
  const chain = await testChain();
  await chain.putCode(low(0x6e), '0xfe');
  const word = (n: bigint) => n.toString(16).padStart(64, '0'), asked: string[] = [];
  // The node can't decode the short calldata (a revert with nothing, burning all the meter gives it); burnArbGas
  // answers nothing.
  const fetchImpl = arbOsNode(chain.fetchImpl, (to, data) => (to === low(0x69) && data.startsWith('0xbb3480f9') ? { result: '0x' } : undefined), () => 1_000_000n, asked);
  const fork = new ForkSimulator({ 999: 'http://arbitrum.invalid' }, { fetchImpl, profiles: { 999: { ...CHAIN_PROFILES[42161] } } });
  const FROM = '0x1111111111111111111111111111111111111111', M = '0x2222222222222222222222222222222222222222';
  const run = async (code: Hex, data: string, value = 0n) => {
    const r = await fork.simulate({ chainId: 999, from: FROM, to: M, data: data as Hex, value, gas: 1_000_000n, stateOverrides: { [FROM]: { balance: '0x56bc75e2d63100000' }, [M]: { code } } });
    assert.equal(r?.status, 'success');
    return metered(r!.returnData as Hex);
  };
  // Measured on Arbitrum One (2026-11-15): each fails with nothing, burning all it was given; the transaction goes on.
  for (const [label, data] of [['redeem, the selector alone', '0xeda1122c'], ['redeem, 35 bytes', `0xeda1122c${word(0xdeadn).slice(0, 62)}`], ['keepalive, the selector alone', '0xf0b21a41'], ['cancel, 20 bytes of argument', `0xc4d252f5${word(0xdeadn).slice(0, 40)}`]]) {
    const m = await run(meterOf(0x6e, 'f1'), data);
    assert.deepEqual([m.ok, m.size], [0n, 0n], label);
    assert.ok(m.gas > 900_000n, `${label}: ${m.gas}`);
  }
  // 0x6a: no precompile on Arbitrum One (its eth_config lists none there). A call to it, any way it is made, is one to
  // an empty account, as to any other: cold, and with value a new account (measured: 2,600, and 34,300 with 1 wei).
  assert.ok(!CHAIN_PROFILES[42161].forwardedPrecompiles!.includes(low(0x6a)));
  const other = '0x0000000000000000000000000000000000c0ffee';
  for (const [op, value] of [['f1', 0n], ['f1', 1n], ['fa', 0n], ['f4', 0n], ['f2', 0n], ['f2', 1n]] as const) {
    const at6a = await run(meterOf(0x6a, op), '0x12345678', value);
    const atOther = await run(meterOf(0xc0ffee, op), '0x12345678', value);
    assert.deepEqual(at6a, atOther, `${op} ${value}`);
    assert.equal(at6a.ok, 1n, `${op} ${value}`);
  }
  assert.ok(!asked.some(k => k.includes(low(0x6a))));
  // ArbosTest.burnArbGas on 10,000 gas (the meter's GAS swapped for PUSH2 10,000): 3 for its argument, then what it is
  // asked to burn; asked for more, all it was given, succeeding (measured: 9,997, 9,998, 20,000 and 2^64 - 1 each
  // spend 10,000, by a call, a static call or a delegate call; the meter adds 121, or 119 with no value to pass on).
  const on10k = (op: 'f1' | 'f4' | 'fa') => meterOf(0x69, op).replace(`5a${op}`, `612710${op}`) as Hex;
  for (const n of [9_997n, 9_998n, 20_000n, (1n << 64n) - 1n]) assert.deepEqual(await run(on10k('f1'), `0xbb3480f9${word(n)}`), { ok: 1n, gas: 10_121n, size: 0n, data: '' }, `${n}`);
  assert.deepEqual(await run(on10k('fa'), `0xbb3480f9${word(20_000n)}`), { ok: 1n, gas: 10_119n, size: 0n, data: '' });
  assert.deepEqual(await run(on10k('f4'), `0xbb3480f9${word(20_000n)}`), { ok: 1n, gas: 10_119n, size: 0n, data: '' });
  // Within what it is given, what it is asked: 1,000 and its argument's 3.
  assert.deepEqual(await run(on10k('f1'), `0xbb3480f9${word(1_000n)}`), { ok: 1n, gas: 1_003n + 121n, size: 0n, data: '' });
  // Given less than its argument costs (2 gas), it fails, burning that.
  const two = await run(meterOf(0x69, 'f1').replace('5af1', '6002f1') as Hex, `0xbb3480f9${word(5n)}`);
  assert.deepEqual([two.ok, two.size], [0n, 0n]);
});
