// Arbitrum's Stylus (WASM) programs in the local EVM: a call made straight to one is run by the chain's node and
// spliced in as one frame (ForkSimulator's runOnNode); so is a call that reaches one from inside another contract,
// and each call after either in a batch.
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import Ajv2020Module from 'ajv/dist/2020.js';
import assert from 'node:assert/strict';
import { ForkSimulator, isStylus, clearForkCaches } from '../src/fork-simulator.ts';
import { tracePreviews } from '../src/evm/trace.ts';

const URL_ = 'http://arbitrum.test';
const PROGRAM = '0x382ede30fc954bf36e0d23f7125ebf9d0f486602', USDC = '0xaf88d065e77c8cc2239327c5edb3a432268e5831', USER = '0x48ef3deeaa36c8b1dc161b1b8ae49e193923a628';
const CALLER = '0x00000000000000000000000000000000000ca11e', VIEW_READER = '0x00000000000000000000000000000000ba1a9ce6';
const STYLUS_CODE = '0xeff00000' + '1b'.repeat(40);
// CALLER: CALL(gas, PROGRAM, 0, 0, 0, 0, 0), then STOP: an EVM contract that calls the program.
const CALLER_CODE = `0x6000600060006000600073${PROGRAM.slice(2)}5af100`;
const word = (v: bigint) => `0x${v.toString(16).padStart(64, '0')}`;
const transfer = { address: USDC, topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', `0x${USER.slice(2).padStart(64, '0')}`, `0x${PROGRAM.slice(2).padStart(64, '0')}`], data: word(1_000_000_000n) };
const deposit = `0x47e7ef24${USDC.slice(2).padStart(64, '0')}${(1_000_000_000n).toString(16).padStart(64, '0')}`;

const OWNER = '0x86220a2c3f6423d5aad68b9ce705abc515fd4ab7';
const getOwner = '0x893d20e8', transferOwnership = `0xf2fde38b${USER.slice(2).padStart(64, '0')}`;
const hex = (v: bigint) => `0x${v.toString(16)}`;
/** What calldata costs a transaction: 16 gas a non-zero byte, 4 a zero one (no floor on Arbitrum), on top of 21,000. */
const calldataGas = (data: string) => 21_000n + [...(data.slice(2).match(/../g) ?? [])].reduce((g, b) => g + (b === '00' ? 4n : 16n), 0n);

/**
 * A node with the program, USDC and CALLER; its eth_simulateV1 answers as Arbitrum One's did (2026-11-15): the L2 gas
 * of each call as measured there, plus `l1` for the L1 data (and `valueCharge` more for a call that sends value, which
 * the charge counts); a failed call's return data in `error.data` with `returnData` empty; and the sender's native
 * balance, as the reads see it, less the call's fee (all its gas, at its price) and what it sent.
 */
function arbitrum(l1 = 2_544n, { valueCharge = 0n, funded = true, refuseFunds = false } = {}) {
  const asked: { blocks: any[] }[] = [];
  /** The program's run of a call: the transaction's L2 gas (and before refunds), and what it gives back or fails with. */
  const program = (data: string, value: bigint) => {
    if (data === deposit && value === 0n) return funded
      ? { ok: true, gas: 78_408n, max: 83_208n, usdcOut: 1_000_000_000n, logs: [transfer, { address: PROGRAM, topics: ['0x8752a472e571a816aea92eec8dae9baf628e840f4929fbcc2d155e6233ff68a7'], data: word(1_000_000_000n) }] }
      : { ok: false, gas: 63_569n, error: '0x90b8ec18' }; // TransferFailed()
    if (data === transferOwnership) return { ok: false, gas: 41_746n, error: '0x30cd7471' }; // not the owner
    if (data === getOwner) return value === 0n ? { ok: true, gas: 41_351n, returnData: word(BigInt(OWNER)) } : { ok: false, gas: 39_187n, error: '0x' };
    // (This mock's program takes value sent with no calldata.)
    if (data === '0x') return { ok: true, gas: 21_420n };
    return { ok: false, gas: 39_175n, error: '0x' };
  };
  const fetchImpl = (async (_u: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { id: number; method: string; params: any[] }[];
    const answer = (r: { id: number; method: string; params: any[] }) => {
      switch (r.method) {
        case 'eth_getBlockByNumber': return { number: '0x1f41f7a0', timestamp: '0x6918a000', miner: '0xa4b000000000000000000073657175656e636572', mixHash: '0x' + '00'.repeat(32), gasLimit: '0x4000000000000', baseFeePerGas: '0x1322700', l1BlockNumber: '0x19320c0' };
        // USER holds 10,000 ETH (enough for what the tests send); every other account none.
        case 'eth_getBalance': return r.params[0].toLowerCase() === USER ? hex(10_000n * 10n ** 18n) : '0x0';
        case 'eth_getTransactionCount': return r.params[0].toLowerCase() === USER ? '0x7' : '0x0';
        case 'eth_getCode': { const a = r.params[0].toLowerCase(); return a === PROGRAM ? STYLUS_CODE : a === CALLER ? CALLER_CODE : a === USDC ? '0x6000' : '0x'; }
        case 'eth_getStorageAt': return word(0n);
        case 'eth_simulateV1': {
          // A sender that can't pay: the node refuses the whole simulation, as Arbitrum's does.
          if (refuseFunds) throw new Error('err: insufficient funds for gas * price + value: address 0x12 have 9100000000000000 want 1000000000000000000');
          const blocks = r.params[0].blockStateCalls;
          asked.push({ blocks });
          return blocks.map((b: any, k: number) => {
            // The sender's balances as the block goes: 1 ETH and 5,000 USDC.
            let native = 10n ** 18n, usdc = 5_000_000_000n;
            return { calls: b.calls.map((c: any) => {
              const to = c.to?.toLowerCase(), value = BigInt(c.value ?? '0x0'), charge = l1 + (value > 0n ? valueCharge : 0n);
              // The views the simulator makes through its reader, 192 bytes of calldata each (the address, then the
              // calldata), answered 160 bytes each: whether the view succeeded, the length of its answer, and that.
              // USDC answers balanceOf; the program and CALLER answer no view here.
              if (k === 0 && to === VIEW_READER) {
                const views = c.data.slice(2).match(/.{384}/g) ?? [];
                return { status: '0x1', gasUsed: '0x5208', logs: [], returnData: `0x${views.map((v: string) => {
                  const of = `0x${v.slice(24, 64)}`;
                  return of === PROGRAM || of === CALLER ? '00'.repeat(160) : `${word(1n).slice(2)}${word(32n).slice(2)}${word(of === USDC ? usdc : native).slice(2)}${'00'.repeat(64)}`;
                }).join('')}` };
              }
              // The probe block: the target's code taken away, the same call: what its calldata and L1 data cost.
              if (k === 1) return { status: '0x1', returnData: '0x', gasUsed: hex(to === PROGRAM || to === CALLER ? calldataGas(c.data) + charge : 21_000n), logs: [] };
              // The reads around it: the native balance reader, and USDC's balanceOf.
              if (to !== PROGRAM && to !== CALLER) return { status: '0x1', returnData: word(to === USDC ? usdc : native), gasUsed: '0x5208', logs: [] };
              // (CALLER calls the program with no calldata, which it takes: 24,170 in all, the caller's own included.)
              const ran = to === CALLER ? { ok: true, gas: 24_170n } as ReturnType<typeof program> : program(c.data, value), gasUsed = ran.gas + charge;
              native -= gasUsed * BigInt(c.gasPrice ?? c.maxFeePerGas ?? '0x0') + (ran.ok ? value : 0n);
              if (ran.ok) usdc -= ran.usdcOut ?? 0n;
              const max = hex((ran.max ?? ran.gas) + charge);
              return ran.ok ? { status: '0x1', returnData: ran.returnData ?? '0x', gasUsed: hex(gasUsed), maxUsedGas: max, logs: ran.logs ?? [] }
                : { status: '0x0', returnData: '0x', gasUsed: hex(gasUsed), maxUsedGas: max, logs: [], error: { code: 3, message: 'execution reverted', data: ran.error } };
            }) };
          });
        }
        default: throw Object.assign(new Error('method not found'), { code: -32601 });
      }
    };
    const out = body.map(r => { try { return { jsonrpc: '2.0', id: r.id, result: answer(r) }; } catch (e) { return { jsonrpc: '2.0', id: r.id, error: { code: -32601, message: (e as Error).message } }; } });
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetchImpl, asked };
}

test('isStylus: the 0xEFF000 prefix and something behind it', () => {
  assert.equal(isStylus(new Uint8Array([0xef, 0xf0, 0x00, 0x00, 0x1b])), true);
  assert.equal(isStylus(new Uint8Array([0xef, 0xf0, 0x00])), false);
  assert.equal(isStylus(new Uint8Array([0xef, 0x01, 0x00, 0x00])), false);
});

test('a call made straight to a Stylus program: the node runs it, its result and one frame spliced in, gas the L2 part', async () => {
  clearForkCaches();
  const node = arbitrum();
  const sim = new ForkSimulator({ 42161: URL_ }, { fetchImpl: node.fetchImpl, prefetch: false });
  const [r] = (await sim.trace([{ chainId: 42161, from: USER, to: PROGRAM, data: deposit, value: 0n, baseFee: 20_000_000n }]))!;
  assert.equal(r.status, 'success');
  // The node's gas less its L1 charge (what the probe used over the calldata's 21,596): 78,408, the L2 part.
  assert.equal(r.gasUsed, 78_408n);
  assert.equal(r.logs?.length, 2);
  // The amounts are the node's own balance reads, before and after.
  assert.deepEqual(r.transfers.map(t => [t.asset, t.from, t.to, t.raw]), [[USDC, USER, PROGRAM, 1_000_000_000n]]);
  assert.ok(r.readAssets?.includes('native') && r.readAssets.includes(USDC), String(r.readAssets));
  assert.equal(r.trace?.to, PROGRAM);
  assert.ok(r.trace?.node && /Stylus/.test(r.trace.node));
  // The frame's gas is the node's before refunds (83,208), less the call's intrinsic 21,596.
  assert.equal(r.trace?.gasUsed, 61_612n);
  assert.equal(r.trace?.logs?.length, 2);
  assert.equal(r.trace?.calls, undefined);
  assert.equal(r.stateChanges, undefined);
  // What the node was given: the block's base fee; the probe a block later, the program's code taken away (its
  // sender given a balance to send the call's value), the call's nonce, calldata and value.
  const [first, probe] = node.asked.at(-1)!.blocks;
  assert.equal(first.blockOverrides.baseFeePerGas, '0x1312d00');
  assert.deepEqual(probe.stateOverrides, { [PROGRAM]: { code: '0x' }, [USER]: { balance: hex(1n << 200n) } });
  assert.equal(probe.calls[1].to, PROGRAM);
  assert.equal(probe.calls[1].nonce, '0x7');
  assert.equal(probe.calls[1].data, deposit);
  assert.equal(probe.calls[1].value, '0x0');
});

test('a Stylus program\'s call that fails: its revert data is the node\'s error.data (Arbitrum\'s returnData is empty)', async () => {
  // Measured on Arbitrum One (2026-11-15): transferOwnership by an account that isn't the owner, and a deposit the
  // account can't fund. Each had come out as "execution reverted" with no return data.
  for (const [data, funded, ret, reason, gas] of [[transferOwnership, true, '0x30cd7471', 'custom error 0x30cd7471', 41_746n], [deposit, false, '0x90b8ec18', 'TransferFailed', 63_569n]] as const) {
    clearForkCaches();
    const node = arbitrum(2_544n, { funded });
    const sim = new ForkSimulator({ 42161: URL_ }, { fetchImpl: node.fetchImpl, prefetch: false });
    const [r] = (await sim.trace([{ chainId: 42161, from: USER, to: PROGRAM, data, value: 0n, baseFee: 20_000_000n, trace: true }]))!;
    assert.equal(r.status, 'reverted');
    assert.equal(r.returnData, ret);
    assert.equal(r.revertReason, reason);
    assert.equal(r.gasUsed, gas);
    assert.equal(r.trace?.output, ret);
    assert.equal(r.trace?.error, reason);
  }
});

test('a priced call to a Stylus program: the fee the node takes is not shown as native sent to the program', async () => {
  // The node's balance reads around the call see the fee gone too, at the call's price for all its gas (its L1
  // charge included), at the base fee or above it. Measured: getOwner() with gas 100,000 at 1, 2 and 10 times a base
  // fee of 0.02 gwei showed 0x1234…->program native of 837,480,000,000, 1,666,920,000,000 and 8,283,000,000,000 wei.
  for (const times of [1n, 2n, 10n]) {
    clearForkCaches();
    const node = arbitrum();
    const sim = new ForkSimulator({ 42161: URL_ }, { fetchImpl: node.fetchImpl, prefetch: false, watchTokens: false });
    const [r] = (await sim.trace([{ chainId: 42161, from: USER, to: PROGRAM, data: getOwner, value: 0n, gas: 100_000n, gasPrice: times * 20_000_000n, baseFee: 20_000_000n }]))!;
    assert.equal(r.status, 'success');
    assert.equal(r.returnData, word(BigInt(OWNER)));
    assert.equal(r.gasUsed, 41_351n);
    assert.deepEqual(r.transfers, [], `at ${times} times the base fee`);
  }
  // What a priced call sends stays: the value, and nothing of its fee.
  clearForkCaches();
  const node = arbitrum(2_544n, { valueCharge: 35n });
  const sim = new ForkSimulator({ 42161: URL_ }, { fetchImpl: node.fetchImpl, prefetch: false, watchTokens: false });
  const [r] = (await sim.trace([{ chainId: 42161, from: USER, to: PROGRAM, data: '0x', value: 10n ** 17n, gas: 100_000n, gasPrice: 40_000_000n, baseFee: 20_000_000n }]))!;
  assert.equal(r.status, 'success');
  assert.deepEqual(r.transfers.map(t => [t.asset, t.from, t.to, t.raw]), [['native', USER, PROGRAM, 10n ** 17n]]);
});

test('a Stylus program\'s call that sends value: the probe sends it too, as the node\'s L1 charge counts it', async () => {
  // Measured (2026-11-15, base fee 0.02 gwei): getOwner() with 1 ETH and with 5,373 ETH (reverting: it takes no
  // value) used 39,187 L2 gas on the node; with a probe that sent none they came out 39,222 and 39,231.
  for (const [value, charge] of [[10n ** 18n, 35n], [5_373n * 10n ** 18n, 44n]] as const) {
    clearForkCaches();
    const node = arbitrum(2_544n, { valueCharge: charge });
    const sim = new ForkSimulator({ 42161: URL_ }, { fetchImpl: node.fetchImpl, prefetch: false, watchTokens: false });
    const [r] = (await sim.trace([{ chainId: 42161, from: USER, to: PROGRAM, data: getOwner, value, baseFee: 20_000_000n }]))!;
    assert.equal(r.status, 'reverted');
    assert.equal(r.gasUsed, 39_187n);
    const [, probe] = node.asked.at(-1)!.blocks;
    assert.equal(probe.calls[1].value, hex(value));
    assert.equal(probe.stateOverrides[USER].balance, hex(1n << 200n));
    assert.equal(probe.stateOverrides[PROGRAM].code, '0x');
  }
});

test('the preview trace says the frame is the node\'s', async () => {
  clearForkCaches();
  const node = arbitrum(0n);
  const sim = new ForkSimulator({ 42161: URL_ }, { fetchImpl: node.fetchImpl, prefetch: false });
  const req = { chainId: 42161, from: USER, to: PROGRAM, data: deposit, value: 0n };
  const env = { chainId: 42161, deps: { simulator: sim, tokens: { get: async () => undefined } } } as any;
  const [t] = (await tracePreviews([req], [undefined], env))!;
  assert.ok(t);
  assert.match(t.note ?? '', /is a Stylus \(WASM\) program, which the local EVM can't run: the chain's node ran the call/);
  assert.ok(t.calls[0].node);
  // And it is what the API documents (openapi.json rejects fields it doesn't name).
  const Ajv2020 = (Ajv2020Module as unknown as { default?: typeof Ajv2020Module }).default ?? Ajv2020Module;
  const ajv = new (Ajv2020 as unknown as new (o: object) => { addSchema(s: object): void; getSchema(k: string): ((d: unknown) => boolean) & { errors?: unknown[] } })({ strict: false, allErrors: true });
  ajv.addSchema({ ...JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8')), $id: 'spec' });
  const valid = ajv.getSchema('spec#/components/schemas/PreviewTrace');
  assert.ok(valid(JSON.parse(JSON.stringify(t, (_k, v) => typeof v === 'bigint' ? v.toString() : v))), JSON.stringify(valid.errors?.slice(0, 3)));
});

test('a Stylus program reached from inside another contract: the chain\'s node runs the call, the frame saying why and which program', async () => {
  // Refused before: "...is a Stylus (WASM) contract, which the local EVM can't run: the transaction reaches it from
  // inside another contract".
  clearForkCaches();
  const node = arbitrum();
  const sim = new ForkSimulator({ 42161: URL_ }, { fetchImpl: node.fetchImpl, prefetch: false, watchTokens: false });
  const [r] = (await sim.trace([{ chainId: 42161, from: USER, to: CALLER, data: '0x', value: 0n, baseFee: 20_000_000n }]))!;
  assert.equal(r.status, 'success');
  // The node's gas less its L1 charge (what the probe, the caller's code taken away, used over its 21,000).
  assert.equal(r.gasUsed, 24_170n);
  assert.equal(r.source, `chain 42161's node, for the Stylus (WASM) program ${PROGRAM}, which the local EVM can't run, reached from inside another contract`);
  assert.equal(r.trace?.to, CALLER);
  assert.match(r.trace?.node ?? '', new RegExp(`^run by the chain's node, for the Stylus \\(WASM\\) program ${PROGRAM}, which the local EVM can't run, reached from inside another contract: `));
  const [, probe] = node.asked.at(-1)!.blocks;
  assert.deepEqual(probe.stateOverrides[CALLER], { code: '0x' });
  // The preview trace says so.
  const env = { chainId: 42161, deps: { simulator: sim, tokens: { get: async () => undefined } } } as any;
  const [t] = (await tracePreviews([{ chainId: 42161, from: USER, to: CALLER, data: '0x', value: 0n }], [undefined], env))!;
  assert.match(t!.note ?? '', new RegExp(`^The chain's node ran this call, for the Stylus \\(WASM\\) program ${PROGRAM}, which the local EVM can't run, reached from inside another contract: the trace shows it as one frame`));
});

test('a call after a Stylus one in a batch runs on the chain\'s node after it, on the state it left', async () => {
  // Refused before: "...the calls after it in this batch would then run on state the local EVM doesn't have".
  clearForkCaches();
  const node = arbitrum();
  const sim = new ForkSimulator({ 42161: URL_ }, { fetchImpl: node.fetchImpl, prefetch: false, watchTokens: false });
  const out = (await sim.trace([{ chainId: 42161, from: USER, to: PROGRAM, data: deposit, value: 0n }, { chainId: 42161, from: USER, to: USDC, data: '0x', value: 0n }]))!;
  assert.equal(out[0].gasUsed, 78_408n);
  assert.equal(out[1].status, 'success');
  assert.equal(out[1].gasUsed, 21_000n);
  assert.match(out[1].source, new RegExp(`^chain 42161's node, after call 1 of the batch, which is made straight to the Stylus \\(WASM\\) program ${PROGRAM}`));
  // The node was given the deposit first, then the reads around the second call (USDC's balance among them, seen in
  // the deposit's events), and the call.
  const [block] = node.asked.at(-1)!.blocks;
  assert.equal(block.calls[0].data, deposit);
  assert.equal(block.calls[1].to, '0x00000000000000000000000000000000ba1a9ce5');
  assert.equal(block.calls.findIndex((c: { to: string; data: string }) => c.to.toLowerCase() === USDC && c.data === '0x'), 3);
  // The second call's sender nonce, for the L1 charge: one up from the first's.
  const [, probe] = node.asked.at(-1)!.blocks;
  assert.equal(probe.calls[1].nonce, '0x8');
});

test('a call to a Stylus program its sender can\'t pay for fails as any call does, not the whole simulation', async () => {
  // Arbitrum's node refuses the whole eth_simulateV1 for it ("insufficient funds for gas * price + value"); an EVM
  // target here gives a failed call saying so. The same now for a Stylus program: what it sends, read here...
  clearForkCaches();
  const node = arbitrum();
  const sim = new ForkSimulator({ 42161: URL_ }, { fetchImpl: node.fetchImpl, prefetch: false, watchTokens: false });
  const [poor] = (await sim.trace([{ chainId: 42161, from: CALLER, to: PROGRAM, data: getOwner, value: 1n }]))!;
  assert.equal(poor.status, 'reverted');
  assert.match(poor.revertReason ?? '', /^insufficient funds: the account holds 0 ETH and the call sends/);
  assert.equal(node.asked.length, 0, 'the node is not asked');
  // ...and its gas at its price too, when the node says so.
  clearForkCaches();
  const refusing = arbitrum(2_544n, { refuseFunds: true });
  const sim2 = new ForkSimulator({ 42161: URL_ }, { fetchImpl: refusing.fetchImpl, prefetch: false, watchTokens: false });
  const [priced] = (await sim2.trace([{ chainId: 42161, from: USER, to: PROGRAM, data: getOwner, value: 0n, gas: 100_000n, gasPrice: 10n ** 15n, baseFee: 20_000_000n }]))!;
  assert.equal(priced.status, 'reverted');
  assert.match(priced.revertReason ?? '', /^insufficient funds: the account can't pay for the call's gas at its price/);
});
