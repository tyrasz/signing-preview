// What the network checks before including a transaction (nonce, fee cap, funds for gas), the network fee, a gas
// limit too low, and simulation on top of the wallet's pending transactions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeAbiParameters, encodeAbiParameters, toHex, type Hex } from 'viem';
import { previewRequest } from '../src/preview.ts';
import { rejection } from '../src/simulation.ts';
import { StaticTokenRegistry } from '../src/chains.ts';
import type { Dependencies, SimulationRequest, SimulationResult } from '../src/types.ts';
import { ALICE, BOB } from '../mocks/data.ts';
import { codes, detail, NOW } from './helpers.ts';

const GWEI = 10n ** 9n;
const l1Inputs: string[] = [];
/** A node: nonces 5 mined and 7 pending, 1 gwei base fee, a 0.1 gwei tip, and (Arbitrum) 1,000 gas of L1 data. */
const rpc = (balance: bigint) => ({ has: () => true, call: async (_c: number, method: string, params: unknown[]) => {
  if (method === 'eth_getTransactionCount') return params[1] === 'pending' ? '0x7' : '0x5';
  if (method === 'eth_getBalance') return toHex(balance);
  if (method === 'eth_getBlockByNumber') return { baseFeePerGas: toHex(GWEI) };
  if (method === 'eth_maxPriorityFeePerGas') return toHex(GWEI / 10n);
  if (method === 'eth_call' && (params[0] as { to: string }).to === '0x00000000000000000000000000000000000000c8') return encodeAbiParameters([{ type: 'uint64' }, { type: 'uint256' }, { type: 'uint256' }], [1000n, GWEI, 0n]);
  // OP Stack's GasPriceOracle: 0.00001 ETH of L1 data fee for whatever it is given, which it records.
  if (method === 'eth_call' && (params[0] as { to: string }).to === '0x420000000000000000000000000000000000000f') { l1Inputs.push((params[0] as { data: string }).data); return encodeAbiParameters([{ type: 'uint256' }], [10n ** 13n]); }
  return '0x';
} });
/** Simulates a call that needs 50,000 gas: it fails under a lower limit. */
const calls: SimulationRequest[][] = [];
const simulator = {
  simulate: async (r: SimulationRequest): Promise<SimulationResult> => r.gas !== undefined && r.gas < 50_000n ? { status: 'reverted', source: 'mock', gasUsed: r.gas, revertReason: 'execution reverted', transfers: [] } : { status: 'success', source: 'mock', gasUsed: 50_000n, transfers: [] },
  simulateBatch: async (rs: SimulationRequest[]) => { calls.push(rs); return rs.map((_, i) => ({ status: 'success' as const, source: 'mock', gasUsed: 50_000n, transfers: [], ...(i === rs.length - 1 && { note: 'last' }) })); },
};
const deps = (balance = 10n ** 18n): Dependencies => ({ tokens: new StaticTokenRegistry(), rpc: rpc(balance), simulator });
const send = (tx: Record<string, unknown>, d = deps(), context = {}) => previewRequest({ method: 'eth_sendTransaction', params: [{ from: ALICE, to: BOB, value: '0x1', chainId: '0x1', ...tx }] }, { now: NOW, ...context }, d);

test('The network fee: gas used at the base fee plus tip, the most the request allows, and Arbitrum’s L1 data gas', async () => {
  const p = await send({});
  assert.equal(detail(p, 'Network fee'), '≈ 0.000055 ETH (50,000 gas at 1.1 gwei)');
  const capped = await send({ gas: toHex(60_000n), maxFeePerGas: toHex(2n * GWEI), maxPriorityFeePerGas: toHex(GWEI / 10n) });
  assert.equal(detail(capped, 'Network fee'), '≈ 0.000055 ETH (50,000 gas at 1.1 gwei); at most 0.00012 ETH');
  const arb = await send({ chainId: '0xa4b1' });
  assert.equal(detail(arb, 'Network fee'), '≈ 0.000051 ETH (51,000 gas at 1 gwei, 1,000 of it for the data posted to Ethereum)');
});

test('OP Stack (Base, OP Mainnet): the L1 data fee is added to the gas, in the estimate, the maximum and the funds needed', async () => {
  const base = await send({ chainId: '0x2105' });
  assert.equal(detail(base, 'Network fee'), '≈ 0.000065 ETH (50,000 gas at 1.1 gwei, plus 0.00001 ETH for the data posted to Ethereum)');
  // What the oracle was given: the transaction RLP-serialized and unsigned (an EIP-1559 one, type 2), at the
  // account's next nonce, for the gas the call uses.
  const input = decodeAbiParameters([{ type: 'bytes' }], `0x${l1Inputs.at(-1)!.slice(10)}`)[0];
  assert.equal(input.slice(0, 4), '0x02');
  const capped = await send({ chainId: '0xa', gas: toHex(60_000n), maxFeePerGas: toHex(2n * GWEI), maxPriorityFeePerGas: toHex(GWEI / 10n) });
  assert.equal(detail(capped, 'Network fee'), '≈ 0.000065 ETH (50,000 gas at 1.1 gwei, plus 0.00001 ETH for the data posted to Ethereum); at most 0.00013 ETH');
  // A balance that covers the gas but not the L1 data fee on top is short: the chain charges both up front.
  const short = await send({ chainId: '0x2105', value: '0x0', gas: toHex(60_000n), maxFeePerGas: toHex(2n * GWEI) }, deps(125_000n * GWEI));
  assert.equal(short.warnings.find(w => w.code === 'insufficient_funds_for_gas')?.severity, 'danger');
  // Not an OP Stack chain: no oracle call.
  const before = l1Inputs.length;
  await send({ chainId: '0x89' });
  assert.equal(l1Inputs.length, before);
});

test('A request’s access list goes to the simulation (it costs gas and warms what it names) and into the OP Stack L1 fee', async () => {
  const accessList = [{ address: BOB, storageKeys: [`0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`] }];
  const seen: SimulationRequest[] = [];
  const d = { ...deps(), simulator: { ...simulator, simulate: async (r: SimulationRequest) => { seen.push(r); return simulator.simulate(r); } } };
  await send({ chainId: '0x2105' }, d);
  const plain = decodeAbiParameters([{ type: 'bytes' }], `0x${l1Inputs.at(-1)!.slice(10)}`)[0];
  await send({ chainId: '0x2105', accessList }, d);
  const listed = decodeAbiParameters([{ type: 'bytes' }], `0x${l1Inputs.at(-1)!.slice(10)}`)[0];
  assert.deepEqual(seen.at(-1)!.accessList, [{ address: BOB.toLowerCase(), storageKeys: accessList[0].storageKeys }]);
  assert.ok(listed.length > plain.length + 2 * 64 && listed.includes('11'.repeat(32)), 'the access list is serialized');
  // A malformed one is left out rather than guessed at.
  await send({ chainId: '0x2105', accessList: [{ address: 'nope', storageKeys: [] }] }, d);
  assert.equal(seen.at(-1)!.accessList, undefined);
});

test('A gas limit above the chain’s cap for one transaction: refused on the chains that have it, until Amsterdam', async () => {
  // Ethereum, BNB Chain, Base and OP Mainnet mine nothing above 16,777,216 (EIP-7825).
  const over = await send({ gas: toHex(30_000_000n) });
  assert.equal(over.warnings.find(w => w.code === 'gas_limit_above_cap')!.message, 'The gas limit (30,000,000) is above the most a transaction may have on Ethereum (16,777,216): the network will reject this transaction as it is. It used 50,000 gas in the simulation, so a lower limit would do.');
  assert.equal(over.attention, 'danger');
  for (const chainId of ['0x38', '0x2105', '0xa']) assert.ok(codes(await send({ gas: toHex(16_777_217n), chainId })).includes('gas_limit_above_cap'), chainId);
  // At the cap it is fine; Arbitrum One and Polygon mine transactions with more.
  assert.equal(codes(await send({ gas: toHex(16_777_216n) })).includes('gas_limit_above_cap'), false);
  for (const chainId of ['0xa4b1', '0x89']) assert.equal(codes(await send({ gas: toHex(30_000_000n), chainId })).includes('gas_limit_above_cap'), false, chainId);
  // From Amsterdam on, what a limit holds above the cap pays for new state: a chain whose blocks carry an access
  // list hash takes it.
  const d = deps(), amsterdam = { ...d, rpc: { has: () => true, call: async (c: number, method: string, params: unknown[]) => {
    const r = await d.rpc!.call(c, method, params);
    return method === 'eth_getBlockByNumber' ? { ...r as object, blockAccessListHash: `0x${'09'.repeat(32)}` } : r;
  } } } as Dependencies;
  assert.equal(codes(await send({ gas: toHex(30_000_000n) }, amsterdam)).includes('gas_limit_above_cap'), false);
});

test('HyperEVM: a transaction a small block can’t hold, from an account on small blocks; big blocks’ own base fee', async () => {
  // Small blocks every second of 3,000,000 gas, big ones every minute of 30,000,000; an account's transactions go
  // into the kind it chose on HyperCore (eth_usingBigBlocks), and big blocks have their own base fee.
  const hyper = (big: boolean, latestLimit = 3_000_000n) => { const d = deps(); return { ...d, rpc: { has: () => true, call: async (c: number, method: string, params: unknown[]) => {
    if (method === 'eth_usingBigBlocks') return big;
    if (method === 'eth_bigBlockGasPrice') return toHex(3n * GWEI);
    const r = await d.rpc!.call(c, method, params);
    return method === 'eth_getBlockByNumber' ? { ...r as object, gasLimit: toHex(latestLimit) } : r;
  } } } as Dependencies; };
  const onSmall = await send({ gas: toHex(5_000_000n), chainId: '0x3e7' }, hyper(false));
  assert.equal(onSmall.warnings.find(w => w.code === 'hyperevm_small_blocks')!.message, "This transaction has a gas limit of 5,000,000, more than HyperEVM's small blocks hold (3,000,000), and this account's transactions go into small blocks: it won't be included until the account switches to big blocks (a HyperCore setting, evmUserModify), which come about once a minute.");
  assert.equal(onSmall.attention, 'danger');
  // Under the small blocks' limit, or with a big block the latest (its limit isn't the small blocks'), as it says.
  assert.equal(codes(await send({ gas: toHex(2_000_000n), chainId: '0x3e7' }, hyper(false))).includes('hyperevm_small_blocks'), false);
  assert.ok(codes(await send({ gas: toHex(5_000_000n), chainId: '0x3e7' }, hyper(false, 30_000_000n))).includes('hyperevm_small_blocks'));
  // On big blocks: it waits for the next, and the fee is at big blocks' base fee (3 gwei here, against 1).
  const onBig = await send({ gas: toHex(5_000_000n), chainId: '0x3e7' }, hyper(true));
  assert.deepEqual([codes(onBig).includes('hyperevm_small_blocks'), codes(onBig).includes('hyperevm_big_blocks')], [false, true]);
  assert.match(detail(onBig, 'Network fee')!, /50,000 gas at 3\.1 gwei/);
  // Elsewhere nothing is asked.
  assert.equal(codes(await send({ gas: toHex(5_000_000n) }, hyper(false))).some(c => c.startsWith('hyperevm_')), false);
});

test('Nonces: already used, replacing a pending transaction, waiting behind a gap, or queued behind pending ones', async () => {
  assert.ok(codes(await send({ nonce: '0x3' })).includes('nonce_used'));
  assert.equal((await send({ nonce: '0x3' })).attention, 'danger');
  assert.ok(codes(await send({ nonce: '0x5' })).includes('nonce_replaces'));
  assert.match((await send({ nonce: '0x9' })).warnings.find(w => w.code === 'nonce_gap')!.message, /nonces 7–8/);
  assert.match((await send({})).warnings.find(w => w.code === 'pending_transactions')!.message, /2 transactions still pending/);
});

test('A fee cap under the base fee, and a balance short of the value plus the most the gas can cost', async () => {
  assert.ok(codes(await send({ maxFeePerGas: toHex(GWEI / 2n) })).includes('fee_below_base_fee'));
  const short = await send({ gas: toHex(100_000n), maxFeePerGas: toHex(20n * GWEI) }, deps(10n ** 15n));
  assert.equal(short.warnings.find(w => w.code === 'insufficient_funds_for_gas')?.severity, 'danger');
  assert.ok(!codes(await send({ gas: toHex(100_000n), maxFeePerGas: toHex(20n * GWEI) })).includes('insufficient_funds_for_gas'));
});

test('A gas limit too low says how much the call needs; nodes’ refusals are answers', async () => {
  const p = await send({ gas: toHex(30_000n), data: '0x12345678' });
  assert.equal(p.simulation?.revertReason, 'out of gas: the gas limit (30,000) is below the 50,000 gas this call needs');
  assert.equal(rejection('insufficient funds for gas * price + value: have 1 want 2'), "insufficient funds: the account can't cover the value it sends");
  assert.match(rejection('intrinsic gas too low')!, /^out of gas/);
  assert.equal(rejection('execution reverted'), null);
});

test('Pending transactions supplied by the wallet are simulated first, in order, and this one after them', async () => {
  calls.length = 0;
  const p = await send({}, deps(), { pendingTransactions: [{ to: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', data: '0xd0e30db0', value: '0x10' }] });
  // Twice: at no price, then at the price it would pay now (the base fee plus the node's tip), with room over its gas.
  assert.equal(calls.length, 2);
  assert.equal(calls[0].length, 2);
  assert.equal(calls[0][0].data, '0xd0e30db0');
  assert.equal(calls[0][1].to, BOB.toLowerCase());
  assert.equal(calls[0][1].gasPrice, undefined);
  assert.deepEqual([calls[1][1].gasPrice, calls[1][1].baseFee, calls[1][1].gas], [GWEI + GWEI / 10n, GWEI, 150_000n]);
  assert.match(p.decoding.notes.join(' '), /Simulated after your 1 pending transaction/);
  // The two pending nonces are now partly accounted for, so the warning about unsimulated pending ones stays (1 of 2).
  assert.ok(codes(p).includes('pending_transactions'));
});

test('A transaction whose result depends on the fee it pays is shown as it runs at the price it would pay now', async () => {
  // A pool taxing a swap by the priority fee: at no price 100 USDC comes back, at a price 90.
  const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
  const seen: SimulationRequest[] = [];
  const taxed = { simulate: async (r: SimulationRequest): Promise<SimulationResult> => { seen.push(r); return { status: 'success', source: 'mock', gasUsed: 50_000n, transfers: [{ asset: USDC, from: BOB.toLowerCase(), to: ALICE.toLowerCase(), raw: r.gasPrice ? 90_000_000n : 100_000_000n }] }; } };
  const p = await send({ data: '0x12345678' }, { ...deps(), simulator: taxed });
  assert.deepEqual(p.assetChanges.filter(c => c.symbol === 'USDC').map(c => `${c.direction} ${c.amount}`), ['in 90']);
  assert.match(p.decoding.notes.join(' '), /depends on the fee it pays[^.]*: it was simulated at the price it would pay now, 1\.1 gwei \(the base fee plus a 0\.1 gwei tip\)/);
  assert.deepEqual([seen.length, seen[1].gasPrice, seen[1].baseFee], [2, GWEI + GWEI / 10n, GWEI]);
  // The same result at both prices: nothing is said, and the request's own tip and cap are what it is priced at.
  const flat = await send({ data: '0x12345678', maxPriorityFeePerGas: toHex(2n * GWEI), maxFeePerGas: toHex(5n * GWEI / 2n) });
  assert.ok(!/depends on the fee/.test(flat.decoding.notes.join(' ')));
  // A balance that can't cover the priced run's gas: the node refuses it, and the first run stands.
  const refusing = { simulate: async (r: SimulationRequest): Promise<SimulationResult> => { if (r.gasPrice) throw new Error('insufficient funds for gas * price + value'); return { status: 'success', source: 'mock', gasUsed: 50_000n, transfers: [{ asset: USDC, from: BOB.toLowerCase(), to: ALICE.toLowerCase(), raw: 100_000_000n }] }; } };
  const kept = await send({ data: '0x12345678' }, { ...deps(), simulator: refusing });
  assert.deepEqual(kept.assetChanges.filter(c => c.symbol === 'USDC').map(c => `${c.direction} ${c.amount}`), ['in 100']);
  assert.equal(kept.simulation?.status, 'success');
});

test('A batch runs again at the price it would pay, and that run is shown when it changes what a call does', async () => {
  const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
  const runs: SimulationRequest[][] = [];
  // The second call's pool taxes its swap by the priority fee: 100 USDC back at no price, 90 at a price.
  const taxed = {
    simulate: async (): Promise<SimulationResult> => ({ status: 'success', source: 'mock', gasUsed: 50_000n, transfers: [] }),
    simulateBatch: async (rs: SimulationRequest[]): Promise<SimulationResult[]> => { runs.push(rs); return rs.map((r, i) => ({ status: 'success' as const, source: 'mock', gasUsed: 60_000n, transfers: i === 1 ? [{ asset: USDC, from: BOB.toLowerCase(), to: ALICE.toLowerCase(), raw: r.gasPrice ? 90_000_000n : 100_000_000n }] : [] })); },
  };
  const batch = (d: Dependencies) => previewRequest({ method: 'wallet_sendCalls', params: [{ version: '2.0.0', chainId: '0x1', from: ALICE, atomicRequired: true, calls: [{ to: BOB, data: '0x12345678' }, { to: BOB, data: '0x87654321' }] }] }, { now: NOW }, d);
  const p = await batch({ ...deps(), simulator: taxed });
  assert.deepEqual(p.assetChanges.filter(c => c.symbol === 'USDC').map(c => `${c.direction} ${c.amount}`), ['in 90']);
  assert.match(p.decoding.notes.join(' '), /What these calls do depends on the fee they pay[^.]*: they were simulated at the price they would pay now, 1\.1 gwei/);
  // Each call at the price, with room over the gas it used.
  assert.equal(runs.length, 2);
  assert.deepEqual(runs[1].map(r => [r.gasPrice, r.baseFee, r.gas]), [[GWEI + GWEI / 10n, GWEI, 160_000n], [GWEI + GWEI / 10n, GWEI, 160_000n]]);
  // The same at both prices: the first run stands and nothing is said.
  runs.length = 0;
  const flat = { ...taxed, simulateBatch: async (rs: SimulationRequest[]): Promise<SimulationResult[]> => { runs.push(rs); return rs.map(() => ({ status: 'success' as const, source: 'mock', gasUsed: 60_000n, transfers: [] })); } };
  const q = await batch({ ...deps(), simulator: flat });
  assert.equal(runs.length, 2);
  assert.ok(!/depends on the fee/.test(q.decoding.notes.join(' ')));
});
