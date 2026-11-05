import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, encodeErrorResult, encodeFunctionData, maxUint256, parseAbi, parseAbiItem, parseAbiParameters, toFunctionSelector, toHex, type Hex } from 'viem';
import { previewRequest } from '../src/preview.ts';
import { StaticTokenRegistry } from '../src/chains.ts';
import { ChainedTokenRegistry, OnchainTokenRegistry } from '../src/tokens.ts';
import { ContractAbiResolver, StaticAbiSource } from '../src/abi.ts';
import { RpcSimulator } from '../src/simulation.ts';
import { knownError } from '../src/errors.ts';
import type { RpcClient } from '../src/rpc.ts';
import type { Dependencies } from '../src/types.ts';
import { ALICE, BOB } from '../mocks/data.ts';
import { codes, detail, NOW } from './helpers.ts';

const SM = '0x393d0b87ed38fc779fd9611144ae649ba6082109', KHYPE = '0xfd739d4e423301ce9385c1fb8850539d657c296d';
const ACCOUNTANT = '0x9209648ec9d448ef57116b73a2f081835643dc7a', INSTANT = '0x665b67793594fc5c251a3c95cbeb4b6245cd2123';
const POOL = '0x00a89d7a5a02160f20150ebea7a2b5e4879a1a8b', PROVIDER = '0x72c98246a98bfe64022a3190e7710e157497170c', ORACLE = '0xc9fb4fbe842d57eac1df3e641a281827493a630e';
const USDC = '0xb88339cb7199b77e23db6e890353e22632ba630f', WHYPE = '0x5555555555555555555555555555555555555555';
const H_WHYPE = '0x0000000000000000000000000000000000a70001', DEBT_USDC = '0xd612513cb3b2c52abcd6d4b338374c09ada4657d';
const E = 10n ** 18n;
const u = (v: bigint | number) => encodeAbiParameters([{ type: 'uint256' }], [BigInt(v)]);
const addr = (a: string) => encodeAbiParameters([{ type: 'address' }], [a as Hex]);
const bool = (v: boolean) => encodeAbiParameters([{ type: 'bool' }], [v]);
const sel = (s: string) => toFunctionSelector(`function ${s}`);

/** A fake chain answering eth_call by `${to}:${selector}`; a function gets the full calldata. */
function fakeRpc(answers: Record<string, Hex | ((data: Hex) => Hex)>, extra: Partial<RpcClient> = {}): RpcClient {
  const map = new Map(Object.entries(answers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    has: () => true,
    async call(_chain, method, params) {
      if (method === 'eth_getCode') return '0x6080';
      if (method !== 'eth_call') throw new Error('unsupported ' + method);
      const { to, data } = params[0] as { to: string; data: Hex };
      const a = map.get(`${to.toLowerCase()}:${data.slice(0, 10)}`);
      if (a === undefined) throw Object.assign(new Error('execution reverted'), { rpcError: { code: 3, message: 'execution reverted' } });
      return typeof a === 'function' ? a(data) : a;
    },
    ...extra,
  };
}
const send = (to: string, data: Hex, deps: Dependencies, value = 0n, from = ALICE) =>
  previewRequest({ method: 'eth_sendTransaction', params: [{ from, to, data, value: toHex(value), chainId: '0x3e7' }] }, { now: NOW }, deps);

// --- Kinetiq ---------------------------------------------------------------------------------------------------
const RATE = 1_027_590_248_920_605_756n; // HYPE per kHYPE, as read live on 2026-11-04
const kinetiqRpc = (overrides: Record<string, Hex | ((d: Hex) => Hex)> = {}) => fakeRpc({
  [`${SM}:${sel('stakingAccountant()')}`]: addr(ACCOUNTANT), [`${SM}:${sel('minStakeAmount()')}`]: u(5n * E), [`${SM}:${sel('maxStakeAmount()')}`]: u(0),
  [`${SM}:${sel('stakingPaused()')}`]: bool(false), [`${SM}:${sel('whitelistEnabled()')}`]: bool(false), [`${SM}:${sel('withdrawalPaused()')}`]: bool(false),
  [`${SM}:${sel('unstakeFeeRate()')}`]: u(0), [`${SM}:${sel('withdrawalDelay()')}`]: u(604_800), [`${SM}:${sel('quickWithdrawalDelay()')}`]: u(129_600),
  [`${SM}:${sel('minWithdrawalAmount()')}`]: u(0), [`${SM}:${sel('nextWithdrawalId(address)')}`]: u(3), [`${SM}:${sel('instantUnstakePool()')}`]: addr(INSTANT),
  [`${ACCOUNTANT}:${sel('HYPEToKHYPE(uint256)')}`]: d => u(BigInt('0x' + d.slice(10)) * E / RATE),
  [`${ACCOUNTANT}:${sel('kHYPEToHYPE(uint256)')}`]: d => u(BigInt('0x' + d.slice(10)) * RATE / E),
  ...overrides,
});
const kinetiq = (rpc: RpcClient = kinetiqRpc()): Dependencies => ({ tokens: new StaticTokenRegistry(), rpc });
const KQ = parseAbi(['function queueWithdrawal(uint256)', 'function confirmWithdrawal(uint256)', 'function batchConfirmWithdrawals(uint256[])', 'function instantUnstake(uint256,uint256)']);

test('Kinetiq stake: kHYPE at the live rate, and the StakingFacet rules (minimum, 8-decimal precision, pause)', async () => {
  const p = await send(SM, '0x3a4b66f1', kinetiq(), 10n * E);
  assert.equal(p.title, 'Stake 10 HYPE for ≈ 9.7315 kHYPE');
  assert.equal(p.decoding.decoder, 'kinetiq_stake');
  assert.equal(detail(p, 'Rate'), '1 kHYPE = 1.027590248920605756 HYPE');
  assert.deepEqual(p.assetChanges.map(c => [c.direction, c.symbol]), [['out', 'HYPE'], ['in', 'kHYPE']]);
  assert.equal(p.attention, 'none');
  assert.match((await send(SM, '0x3a4b66f1', kinetiq(), 2n * E)).warnings.find(w => w.code === 'kinetiq_below_minimum')!.message, /minimum stake is 5 HYPE/);
  assert.ok(codes(await send(SM, '0x3a4b66f1', kinetiq(), 10n * E + 1n)).includes('kinetiq_amount_precision'));
  assert.ok(codes(await send(SM, '0x3a4b66f1', kinetiq(kinetiqRpc({ [`${SM}:${sel('stakingPaused()')}`]: bool(true) })), 10n * E)).includes('kinetiq_paused'));
  // Without an RPC the call is still decoded, just without the rate.
  const offline = await send(SM, '0x3a4b66f1', { tokens: new StaticTokenRegistry() }, 10n * E);
  assert.equal(offline.title, 'Stake 10 HYPE for kHYPE');
});

test('Kinetiq unstaking: queue (fee, 7 days / 36 hours), claims that are not ready, instant unstake quotes', async () => {
  const q = await send(SM, encodeFunctionData({ abi: KQ, functionName: 'queueWithdrawal', args: [100n * E] }), kinetiq());
  assert.equal(q.title, 'Unstake 100 kHYPE: ≈ 102.759 HYPE claimable in 7 days');
  assert.equal(detail(q, 'Claimable after'), "7 days (36 hours if Kinetiq's buffer covers the whole amount)");
  assert.equal(detail(q, 'Withdrawal ID'), '3 (claim it with confirmWithdrawal)');

  const queuedAt = BigInt(Math.floor(NOW / 1000)) - 86_400n; // a day ago: not ready for 6 more days
  const request = (hype: bigint, buffer: bigint, ts: bigint) => encodeAbiParameters(parseAbiParameters('(uint256,uint256,uint256,uint256,uint256)'), [[hype, hype, 0n, buffer, ts]]);
  const rpc = kinetiqRpc({ [`${SM}:${sel('withdrawalRequests(address,uint256)')}`]: d => BigInt('0x' + d.slice(74)) === 1n ? request(50n * E, 0n, queuedAt) : request(20n * E, 20n * E, queuedAt) });
  const notReady = await send(SM, encodeFunctionData({ abi: KQ, functionName: 'confirmWithdrawal', args: [1n] }), kinetiq(rpc));
  assert.match(notReady.warnings.find(w => w.code === 'kinetiq_not_claimable')!.message, /^This will fail: withdrawal #1 \(ready .+, in 6 days\)/);
  // Withdrawal 2 was fully covered by the buffer, so its delay is 36 hours: a day after queuing it isn't ready either.
  const batch = await send(SM, encodeFunctionData({ abi: KQ, functionName: 'batchConfirmWithdrawals', args: [[1n, 2n]] }), kinetiq(rpc));
  assert.equal(batch.title, 'Claim Kinetiq withdrawals #1, #2');
  assert.equal(batch.warnings.find(w => w.code === 'kinetiq_not_claimable')!.severity, 'info', 'a batch skips what is not ready instead of failing');
  const old = kinetiqRpc({ [`${SM}:${sel('withdrawalRequests(address,uint256)')}`]: request(20n * E, 20n * E, queuedAt - 86_400n) });
  const ready = await send(SM, encodeFunctionData({ abi: KQ, functionName: 'confirmWithdrawal', args: [2n] }), kinetiq(old));
  assert.equal(ready.title, 'Claim 20 HYPE from a Kinetiq withdrawal');
  assert.deepEqual(ready.assetChanges.map(c => [c.direction, c.amount, c.symbol]), [['in', '20', 'HYPE']]);

  const quote = (hype: bigint, enough: boolean) => kinetiqRpc({ [`${INSTANT}:${sel('previewInstantUnstake(uint256)')}`]: encodeAbiParameters(parseAbiParameters('uint256, uint256, uint256, bool'), [hype, E / 10n, 10n, enough]) });
  const instant = await send(SM, encodeFunctionData({ abi: KQ, functionName: 'instantUnstake', args: [100n * E, 0n] }), kinetiq(quote(102n * E, true)));
  assert.equal(instant.title, 'Instant unstake 100 kHYPE for ≈ 102 HYPE (0.1% fee)');
  assert.ok(codes(instant).includes('no_slippage_protection'));
  assert.ok(codes(instant).includes('kinetiq_queue_cheaper'));
  assert.ok(codes(await send(SM, encodeFunctionData({ abi: KQ, functionName: 'instantUnstake', args: [100n * E, 103n * E] }), kinetiq(quote(102n * E, true)))).includes('kinetiq_below_min_out'));
  assert.ok(codes(await send(SM, encodeFunctionData({ abi: KQ, functionName: 'instantUnstake', args: [100n * E, 1n] }), kinetiq(quote(102n * E, false)))).includes('kinetiq_buffer_too_small'));
});

// --- HyperLend --------------------------------------------------------------------------------------------------
// ALICE: $10,000 of WHYPE collateral (liquidation threshold 80%) and $4,000 of USDC debt -> health factor 2.0.
const reserve = (lt: number, decimals: number, id: number, hToken: string, debtToken: string) => encodeAbiParameters(
  parseAbiParameters('(uint256, uint128, uint128, uint128, uint128, uint128, uint40, uint16, address, address, address, address, uint128, uint128, uint128)'),
  [[(BigInt(decimals) << 48n) | (BigInt(lt) << 16n) | 7500n, 0n, 0n, 0n, 0n, 0n, 0, id, hToken as Hex, '0x0000000000000000000000000000000000000000', debtToken as Hex, '0x0000000000000000000000000000000000000000', 0n, 0n, 0n]]);
const lendRpc = (overrides: Record<string, Hex | ((d: Hex) => Hex)> = {}) => fakeRpc({
  [`${POOL}:${sel('getUserAccountData(address)')}`]: encodeAbiParameters(parseAbiParameters('uint256, uint256, uint256, uint256, uint256, uint256'), [10_000n * 10n ** 8n, 4_000n * 10n ** 8n, 3_500n * 10n ** 8n, 8000n, 7500n, 2n * E]),
  [`${PROVIDER}:${sel('getPriceOracle()')}`]: addr(ORACLE),
  [`${ORACLE}:${sel('getAssetPrice(address)')}`]: d => u(d.slice(34).toLowerCase() === USDC.slice(2) ? 10n ** 8n : 25n * 10n ** 8n), // USDC $1, WHYPE $25
  [`${POOL}:${sel('getReserveData(address)')}`]: d => d.slice(34).toLowerCase() === USDC.slice(2) ? reserve(7800, 6, 1, '0x000000000000000000000000000000000000a5dc', DEBT_USDC) : reserve(8000, 18, 0, H_WHYPE, '0x00000000000000000000000000000000000d0001'),
  [`${POOL}:${sel('getUserEMode(address)')}`]: u(0),
  [`${POOL}:${sel('getUserConfiguration(address)')}`]: u(0b0110n), // reserve 0 (WHYPE) collateral, reserve 1 (USDC) borrowed
  [`${H_WHYPE}:${sel('balanceOf(address)')}`]: u(400n * E), // $10,000 of WHYPE
  [`${DEBT_USDC}:${sel('balanceOf(address)')}`]: u(4_000n * 10n ** 6n),
  [`${POOL}:${sel('getEModeCategoryLabel(uint8)')}`]: encodeAbiParameters([{ type: 'string' }], ['kHYPE / HYPE']),
  [`${POOL}:${sel('getEModeCategoryCollateralConfig(uint8)')}`]: encodeAbiParameters(parseAbiParameters('(uint16, uint16, uint16)'), [[8713, 9000, 10500]]),
  ...overrides,
});
const lend = (rpc: RpcClient = lendRpc()): Dependencies => ({ tokens: new StaticTokenRegistry(), rpc });
const PA = parseAbi(['function borrow(address,uint256,uint256,uint16,address)', 'function withdraw(address,uint256,address)', 'function repay(address,uint256,uint256,address)',
  'function supply(address,uint256,address,uint16)', 'function setUserUseReserveAsCollateral(address,bool)', 'function setUserEMode(uint8)', 'function approvePositionManager(address,bool)',
  'function liquidationCall(address,address,address,uint256,bool)']);

test('HyperLend borrow and withdraw: health factor before and after, with warnings as it nears 1', async () => {
  const borrow = (amount: bigint) => send(POOL, encodeFunctionData({ abi: PA, functionName: 'borrow', args: [USDC, amount, 2n, 0, ALICE] }), lend());
  const fine = await borrow(1_000n * 10n ** 6n);
  assert.equal(fine.title, 'Borrow 1,000 USDC from HyperLend');
  assert.equal(detail(fine, 'Health factor (estimated)'), '2 → 1.6'); // 8,000 / 5,000
  assert.equal(detail(fine, 'Interest rate'), 'variable');
  assert.ok(!codes(fine).some(c => /health|liquidation/.test(c)));
  const tight = await borrow(3_000n * 10n ** 6n); // 8,000 / 7,000 = 1.14
  assert.equal(tight.warnings.find(w => w.code === 'low_health_factor')?.severity, 'caution');
  const over = await borrow(3_600n * 10n ** 6n); // more than the $3,500 available
  assert.match(over.warnings.find(w => w.code === 'lending_will_fail')!.message, /only about \$3,500 more/);

  const withdraw = (amount: bigint) => send(POOL, encodeFunctionData({ abi: PA, functionName: 'withdraw', args: [WHYPE, amount, ALICE] }), lend());
  const part = await withdraw(100n * E); // -$2,500 of collateral: (8,000 - 2,000) / 4,000 = 1.5
  assert.equal(detail(part, 'Health factor (estimated)'), '2 → 1.5');
  const near = await withdraw(185n * E); // (8,000 - 3,700) / 4,000 = 1.075
  assert.equal(near.warnings.find(w => w.code === 'liquidation_risk')?.severity, 'danger');
  const all = await withdraw(maxUint256);
  assert.equal(all.title, 'Withdraw all your WHYPE from HyperLend');
  assert.match(detail(all, 'Withdraw')!, /all your supplied WHYPE \(400 WHYPE now\)/);
  assert.ok(codes(all).includes('lending_will_fail'), 'HyperLend refuses a withdrawal that leaves HF < 1');
});

test('HyperLend repay, collateral switch, e-mode, position managers and liquidations', async () => {
  const repay = await send(POOL, encodeFunctionData({ abi: PA, functionName: 'repay', args: [USDC, maxUint256, 2n, ALICE] }), lend());
  assert.equal(repay.title, 'Repay all your USDC debt on HyperLend');
  assert.equal(detail(repay, 'Debt in this market'), '4,000 USDC');
  assert.equal(detail(repay, 'Health factor (estimated)'), '2 → no debt (∞)');
  assert.ok(codes(await send(POOL, encodeFunctionData({ abi: PA, functionName: 'repay', args: [USDC, maxUint256, 2n, BOB] }), lend())).includes('lending_will_fail'), '"all" can only repay your own debt');

  const off = await send(POOL, encodeFunctionData({ abi: PA, functionName: 'setUserUseReserveAsCollateral', args: [WHYPE, false] }), lend());
  assert.equal(off.title, 'Stop using WHYPE as collateral on HyperLend');
  assert.ok(codes(off).includes('lending_will_fail'));

  const emode = await send(POOL, encodeFunctionData({ abi: PA, functionName: 'setUserEMode', args: [5] }), lend());
  assert.equal(emode.title, 'Switch HyperLend e-mode to kHYPE / HYPE');
  assert.equal(detail(emode, 'Category limits'), 'borrow up to 87.13% of collateral value; liquidation at 90%');

  const pm = await send(POOL, encodeFunctionData({ abi: PA, functionName: 'approvePositionManager', args: [BOB, true] }), lend());
  assert.equal(pm.warnings.find(w => w.code === 'position_manager')?.severity, 'caution');
  assert.equal((await send(POOL, encodeFunctionData({ abi: PA, functionName: 'approvePositionManager', args: [BOB, false] }), lend())).attention, 'none');

  const liq = await send(POOL, encodeFunctionData({ abi: PA, functionName: 'liquidationCall', args: [WHYPE, USDC, BOB, maxUint256, false] }), lend());
  assert.equal(liq.title, `Liquidate 0xb0b0…0002's HyperLend position`);
  assert.ok(codes(liq).includes('lending_will_fail'), 'a health factor of 2 cannot be liquidated');

  const gift = await send(POOL, encodeFunctionData({ abi: PA, functionName: 'supply', args: [USDC, 50n * 10n ** 6n, BOB, 0] }), lend());
  assert.ok(codes(gift).includes('lending_on_behalf'));
});

test('Credit delegation is danger, as a transaction and as a signature; revocations are not', async () => {
  const rpc = lendRpc({
    [`${DEBT_USDC}:${sel('POOL()')}`]: addr(POOL), [`${DEBT_USDC}:${sel('UNDERLYING_ASSET_ADDRESS()')}`]: addr(USDC),
    [`${POOL}:${sel('getReserveVariableDebtToken(address)')}`]: addr(DEBT_USDC),
    [`${DEBT_USDC}:${sel('name()')}`]: encodeAbiParameters([{ type: 'string' }], ['HyperLend HyperEVM Variable Debt USDC']),
  });
  const DA = parseAbi(['function approveDelegation(address,uint256)']);
  const grant = await send(DEBT_USDC, encodeFunctionData({ abi: DA, functionName: 'approveDelegation', args: [BOB, maxUint256] }), lend(rpc));
  assert.equal(grant.title, 'Let 0xb0b0…0002 borrow unlimited USDC in your name on HyperLend');
  assert.equal(grant.attention, 'danger');
  assert.match(grant.warnings.find(w => w.code === 'credit_delegation')!.message, /borrow any amount of USDC from HyperLend in your name/);
  const revoke = await send(DEBT_USDC, encodeFunctionData({ abi: DA, functionName: 'approveDelegation', args: [BOB, 0n] }), lend(rpc));
  assert.equal(revoke.attention, 'none');
  // The same permission as an EIP-712 signature (Aave's DelegationWithSig, used by HyperLend's debt tokens).
  const typed = { domain: { name: 'HyperLend HyperEVM Variable Debt USDC', version: '1', chainId: 999, verifyingContract: DEBT_USDC },
    types: { DelegationWithSig: [{ name: 'delegatee', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
    primaryType: 'DelegationWithSig', message: { delegatee: BOB, value: '5000000000', nonce: '0', deadline: String(Math.floor(NOW / 1000) + 3600) } };
  const sig = await previewRequest({ method: 'eth_signTypedData_v4', params: [ALICE, JSON.stringify(typed)] }, { now: NOW }, lend(rpc));
  assert.equal(sig.title, 'Sign: let 0xb0b0…0002 borrow up to 5,000 USDC in your name on HyperLend');
  assert.equal(sig.attention, 'danger');
  assert.equal(sig.decoding.decoder, 'credit_delegation_signature');
});

test('HyperLend native-HYPE gateway: trusted only when verified and pointing at the Pool', async () => {
  const GW = '0x00000000000000000000000000000000000e7000';
  const GA = parseAbi(['function depositETH(address,address,uint16) payable']);
  const data = encodeFunctionData({ abi: GA, functionName: 'depositETH', args: [POOL, ALICE, 0] });
  const rpc = lendRpc({ [`${GW}:${sel('POOL()')}`]: addr(POOL) });
  const verified = new ContractAbiResolver({ sources: [new StaticAbiSource({ [`999:${GW}`]: { abi: GA, name: 'WrappedTokenGatewayV3' } })] });
  const ok = await send(GW, data, { tokens: new StaticTokenRegistry(), rpc, abis: verified }, 5n * E);
  assert.equal(ok.title, 'Supply 5 HYPE to HyperLend');
  assert.ok(!codes(ok).includes('unverified_gateway'));
  const unknown = await send(GW, data, { tokens: new StaticTokenRegistry(), rpc }, 5n * E);
  assert.ok(codes(unknown).includes('unverified_gateway'));
});

// --- HyperEVM infrastructure ------------------------------------------------------------------------------------
test('Without eth_simulateV1 or state overrides, single calls are checked with eth_call and custom errors are named', async () => {
  const bodies: { method: string; params: unknown[] }[] = [];
  const revert = encodeErrorResult({ abi: [parseAbiItem('error MustBeDivisibleBy1e10()')], errorName: 'MustBeDivisibleBy1e10' });
  const fetchImpl = (async (_u: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); bodies.push(body);
    if (body.method === 'eth_simulateV1') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } }));
    // This RPC ignores state overrides: the probe's call reaches the plain account, which returns nothing.
    if (body.params[2]) return new Response(JSON.stringify({ result: '0x' }));
    const bad = BigInt(body.params[0].value) % 10n ** 10n !== 0n;
    return new Response(JSON.stringify(bad ? { error: { code: 3, message: 'execution reverted', data: revert } } : { result: '0x' }));
  }) as typeof fetch;
  const simulator = new RpcSimulator({ 999: 'http://rpc.invalid' }, { fetchImpl });
  const ok = await send(SM, '0x3a4b66f1', { tokens: new StaticTokenRegistry(), simulator }, 10n * E);
  assert.equal(ok.simulation?.status, 'success');
  assert.match(ok.simulation!.source, /eth_call/);
  assert.ok(ok.decoding.notes.some(n => /Checked with eth_call/.test(n)));
  const bad = await send(SM, '0x3a4b66f1', { tokens: new StaticTokenRegistry(), simulator }, 10n * E + 1n);
  assert.match(bad.simulation!.revertReason!, /^MustBeDivisibleBy1e10: the HYPE amount must be a multiple of 0.00000001 HYPE/);
  assert.equal(bodies.filter(b => b.method === 'eth_simulateV1').length, 1, 'eth_simulateV1 is not retried once the RPC said it lacks it');
  assert.equal(bodies.filter(b => b.params[2]).length, 1, 'nor is the state-override probe once the RPC ignored it');
  // A batch can't be chained with eth_call: the first call is checked, the rest are marked not simulated.
  const batch = await previewRequest({ method: 'wallet_sendCalls', params: [{ version: '2.0.0', chainId: '0x3e7', from: ALICE, calls: [{ to: SM, data: '0x3a4b66f1', value: toHex(10n * E) }, { to: SM, data: '0x3a4b66f1', value: toHex(10n * E) }] }] }, { now: NOW }, { tokens: new StaticTokenRegistry(), simulator });
  assert.deepEqual(batch.calls?.map(c => c.simulation?.status), ['success', 'unavailable']);
  assert.equal(knownError(encodeErrorResult({ abi: [parseAbiItem('error ERC20InsufficientAllowance(address,uint256,uint256)')], errorName: 'ERC20InsufficientAllowance', args: [BOB, 1n, 2n] })), 'ERC20InsufficientAllowance: the contract is not allowed to move that much of your token (approve it first)');
});

test('Diamond routers: a function missing from the router ABI is resolved through its facet', async () => {
  const ROUTER = '0x00000000000000000000000000000000000d1a00', FACET = '0x00000000000000000000000000000000000fac00';
  const rpc = fakeRpc({ [`${ROUTER}:${sel('getFacetAddress(bytes4)')}`]: addr(FACET) });
  const abis = new ContractAbiResolver({ rpc, sources: [new StaticAbiSource({
    [`999:${ROUTER}`]: { abi: parseAbi(['function diamondCut(bytes)', 'function getFacetAddress(bytes4) view returns (address)']), name: 'SomeRouter' },
    [`999:${FACET}`]: { abi: parseAbi(['function deposit(uint256 assets, address receiver)']), name: 'VaultFacet' },
  })] });
  const p = await send(ROUTER, encodeFunctionData({ abi: parseAbi(['function deposit(uint256 assets, address receiver)']), functionName: 'deposit', args: [5n, ALICE] }), { tokens: new StaticTokenRegistry(), abis, rpc });
  assert.equal(p.title, 'Call deposit on SomeRouter');
  assert.equal(p.decoding.status, 'full');
  assert.match(detail(p, 'ABI source')!, /via facet VaultFacet/);
  assert.equal(detail(p, 'receiver'), `${ALICE} (you)`);
});

test('HyperEVM tokens linked by Hyperliquid are curated: a fake "kHYPE" or "USD₮0" is flagged as impersonation', async () => {
  const FAKE = '0x00000000000000000000000000000000000fa4e0';
  const str = (s: string) => encodeAbiParameters([{ type: 'string' }], [s]);
  const tokens = (symbol: string) => new ChainedTokenRegistry([new StaticTokenRegistry(), new OnchainTokenRegistry(fakeRpc({ [`${FAKE}:0x95d89b41`]: str(symbol), [`${FAKE}:0x313ce567`]: u(18), [`${FAKE}:0x06fdde03`]: str(symbol) }))]);
  const transfer = encodeFunctionData({ abi: parseAbi(['function transfer(address,uint256)']), functionName: 'transfer', args: [BOB, E] });
  for (const symbol of ['kHYPE', 'USD₮0', 'UBTC']) {
    const p = await send(FAKE, transfer, { tokens: tokens(symbol) });
    assert.ok(codes(p).includes('token_impersonation'), symbol);
  }
  const real = await send(KHYPE, transfer, { tokens: new StaticTokenRegistry() });
  assert.equal(real.title, 'Send 1 kHYPE');
});

test('Demo samples: Kinetiq stake and unstake, HyperLend borrow and credit delegation', async () => {
  const { sample } = await import('./helpers.ts');
  assert.equal((await sample('kinetiq-stake')).title, 'Stake 10 HYPE for ≈ 9.7315 kHYPE');
  assert.equal((await sample('kinetiq-unstake')).title, 'Unstake 100 kHYPE: ≈ 102.759 HYPE claimable in 7 days');
  const borrow = await sample('hyperlend-borrow');
  assert.equal(detail(borrow, 'Health factor (estimated)'), '2 → 1.14');
  assert.ok(codes(borrow).includes('low_health_factor'));
  const delegation = await sample('hyperlend-delegation');
  assert.equal(delegation.title.toLowerCase(), 'let 0x5bad…0005 borrow unlimited usdc in your name on hyperlend');
  assert.equal(delegation.attention, 'danger');
});
