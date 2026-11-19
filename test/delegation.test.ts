// MetaMask Delegation Framework (ERC-7710) delegations: the delegate, its caveats read by their enforcers, what it
// leaves unrestricted, and an exact execution simulated as the account would make it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, encodeFunctionData, parseAbi, parseAbiParameters, toFunctionSelector } from 'viem';
import { previewRequest } from '../src/preview.ts';
import { StaticTokenRegistry } from '../src/chains.ts';
import { DELEGATION_MANAGER } from '../src/typed-data/delegation.ts';
import type { Dependencies, SimulationRequest, SimulationResult } from '../src/types.ts';
import { ALICE, BOB } from '../mocks/data.ts';
import { codes, detail, NOW } from './helpers.ts';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', ANY = '0x0000000000000000000000000000000000000a11';
const E = {
  targets: '0x7f20f61b1f09b08d970938f6fa563634d65c4eeb', methods: '0x2c21fd0cb9dc8445cb3fb0dc5e7bb0aca01842b5', timestamp: '0x1046bb45c8d673d4ea75321280db34899413c069',
  erc20Amount: '0xf100b0819427117ecf76ed94b358b1a5b5c6d2fc', exact: '0x146713078d39ecc1f5338309c28405ccf85abfbb', exactBatch: '0x1e141e455d08721dd5bcda1baa6ea5633afd5017',
  valueLte: '0x92bf12322527caa612fd31a0e810472bbb106a8f', limitedCalls: '0x04658b29f6b82ed55274221a06fc97d318e25416',
};
const word = (v: bigint) => v.toString(16).padStart(64, '0');
const delegation = (delegate: string, caveats: { enforcer: string; terms: string }[], extra: { authority?: string; manager?: string } = {}) => ({
  domain: { name: 'DelegationManager', version: '1', chainId: 1, verifyingContract: extra.manager ?? DELEGATION_MANAGER },
  types: {
    EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
    Delegation: [{ name: 'delegate', type: 'address' }, { name: 'delegator', type: 'address' }, { name: 'authority', type: 'bytes32' }, { name: 'caveats', type: 'Caveat[]' }, { name: 'salt', type: 'uint256' }],
    Caveat: [{ name: 'enforcer', type: 'address' }, { name: 'terms', type: 'bytes' }],
  },
  primaryType: 'Delegation',
  message: { delegate, delegator: ALICE, authority: extra.authority ?? `0x${'f'.repeat(64)}`, caveats, salt: '7' },
});
/** 5,000 USDC held; a simulator that has the account send 25 USDC to BOB for its transfer. */
const transfer = encodeFunctionData({ abi: parseAbi(['function transfer(address to, uint256 amount)']), args: [BOB, 25_000_000n] });
const ran: SimulationRequest[] = [];
const simulated = async (r: SimulationRequest): Promise<SimulationResult> => {
  ran.push(r);
  return { status: 'success', source: 'mock', gasUsed: 41_000n, transfers: r.to?.toLowerCase() === USDC && r.data === transfer ? [{ asset: USDC, from: ALICE, to: BOB, raw: 25_000_000n }] : [] };
};
const deps = (): Dependencies => ({
  tokens: new StaticTokenRegistry(),
  rpc: { has: () => true, call: async (_c: number, method: string, params: unknown[]) => {
    if (method !== 'eth_call') throw new Error(`unexpected ${method}`);
    const { data } = params[0] as { data: string };
    return data.startsWith('0x70a08231') ? `0x${word(5_000_000_000n)}` : '0x';
  } },
  simulator: { simulate: simulated, simulateBatch: async (rs: SimulationRequest[]) => Promise.all(rs.map(simulated)) },
});
const sign = (data: unknown, signer = ALICE) => previewRequest({ method: 'eth_signTypedData_v4', params: [signer, JSON.stringify(data)] }, { now: NOW, chainId: 1 }, deps());

test('A delegation with no caveats: full control of the account, without expiry', async () => {
  const p = await sign(delegation(BOB, []));
  assert.equal(p.decoding.decoder, 'metamask_delegation');
  assert.match(p.title, /^Delegate full control of /);
  assert.ok(codes(p).includes('delegation_unrestricted'));
  assert.equal(p.warnings.find(w => w.code === 'delegation_unrestricted')!.severity, 'danger');
  assert.ok(codes(p).includes('delegation_no_expiry'));
  assert.equal(p.attention, 'danger');
  assert.equal(detail(p, 'Delegate'), BOB.toLowerCase());
  assert.equal(detail(p, 'Authority'), "the account's own");
});

test('Caveats that only limit amounts or redemptions still leave every call open', async () => {
  const p = await sign(delegation(BOB, [{ enforcer: E.valueLte, terms: `0x${word(10n ** 17n)}` }, { enforcer: E.limitedCalls, terms: `0x${word(3n)}` }]));
  assert.equal(p.warnings.find(w => w.code === 'delegation_unrestricted')!.severity, 'danger');
  assert.match(p.warnings.find(w => w.code === 'delegation_unrestricted')!.message, /within these limits only: at most 0\.1 ETH sent with each call/);
  assert.equal(detail(p, 'Caveat 2'), 'LimitedCallsEnforcer: redeemable 3 times at most');
});

test('Scoped to USDC transfers, to anyone holding it, until a time: what it can move now', async () => {
  const before = BigInt(NOW / 1000 + 86_400);
  const p = await sign(delegation(ANY, [
    { enforcer: E.erc20Amount, terms: `0x${USDC.slice(2)}${word(100_000_000n)}` },
    { enforcer: E.timestamp, terms: `0x${'0'.repeat(32)}${before.toString(16).padStart(32, '0')}` },
  ]));
  assert.ok(!codes(p).includes('delegation_unrestricted'));
  assert.ok(!codes(p).includes('delegation_no_expiry'));
  assert.equal(p.warnings.find(w => w.code === 'delegation_any_delegate')!.severity, 'danger');
  assert.equal(detail(p, 'Caveat 1'), 'ERC20TransferAmountEnforcer: only transfer() calls on USDC, 100 USDC in all');
  assert.equal(detail(p, 'Can move now (ERC20TransferAmountEnforcer)'), '100 USDC (the permitted amount; you hold 5,000 USDC)');
  assert.ok(detail(p, 'Usable until'));
  assert.match(p.title, /^Delegate limited control of .* to anyone$/);
});

test('An exact execution is simulated as the account; a single call or a batch', async () => {
  ran.length = 0;
  const p = await sign(delegation(BOB, [{ enforcer: E.exact, terms: `0x${USDC.slice(2)}${word(0n)}${transfer.slice(2)}` }]));
  assert.equal(ran.length > 0, true);
  assert.equal(ran[0].from.toLowerCase(), ALICE.toLowerCase());
  assert.deepEqual(p.assetChanges.map(c => [c.direction, c.amount, c.symbol]), [['out', '25', 'USDC']]);
  assert.match(p.title, /^Let 0x.* make one exact call from /);
  assert.ok(!codes(p).includes('delegation_unrestricted'));
  assert.ok(!p.warnings.some(w => ['nonce_used', 'insufficient_funds_for_gas'].includes(w.code)));
  assert.ok(!p.details.some(d => /Network fee/.test(d.label)));
  assert.ok(codes(p).includes('delegation_repeatable'));
  const once = await sign(delegation(BOB, [{ enforcer: E.exact, terms: `0x${USDC.slice(2)}${word(0n)}${transfer.slice(2)}` }, { enforcer: '0xc8b5d93463c893401094cc70e66a206fb5987997', terms: `0x${word(1n)}` }]));
  assert.ok(!codes(once).includes('delegation_repeatable'));
  const batch = encodeAbiParameters(parseAbiParameters('(address target, uint256 value, bytes callData)[]'), [[{ target: USDC, value: 0n, callData: transfer }, { target: USDC, value: 0n, callData: transfer }]]);
  const q = await sign(delegation(ANY, [{ enforcer: E.exactBatch, terms: batch }]));
  assert.match(detail(q, 'Caveat 1')!, /^ExactExecutionBatchEnforcer: exactly these 2 calls/);
  assert.match(q.title, /make 2 exact calls/);
  assert.equal(q.warnings.find(w => w.code === 'delegation_any_delegate')!.severity, 'caution');
});

test('Unknown enforcers, a passed-on authority, another manager, an owner signing', async () => {
  const p = await sign(delegation(BOB, [{ enforcer: '0x1111111111111111111111111111111111111111', terms: '0x1234' }, { enforcer: E.targets, terms: `0x${USDC.slice(2)}` }], { authority: `0x${'ab'.repeat(32)}`, manager: '0x2222222222222222222222222222222222222222' }), BOB);
  assert.equal(p.decoding.status, 'partial');
  for (const c of ['delegation_caveat_unknown', 'delegation_redelegated', 'delegation_manager_unknown', 'delegation_owner_signature']) assert.ok(codes(p).includes(c), c);
  assert.ok(!codes(p).includes('delegation_unrestricted'));
  assert.match(detail(p, 'Caveat 2')!, /^AllowedTargetsEnforcer: calls only to 0xa0b8/);
});

test('To the account itself; ANY_DELEGATE limited by a RedeemerEnforcer; calls that would fail now', async () => {
  const self = await previewRequest({ method: 'eth_signTypedData_v4', params: [ALICE, JSON.stringify(delegation(ALICE, [{ enforcer: '0xbd7b277507723490cd50b12eaafe87c616be6880', terms: `0x00${ALICE.slice(2)}${word(10n ** 17n)}` }]))] }, { now: NOW, chainId: 1 }, deps());
  assert.ok(codes(self).includes('delegation_to_self'));
  assert.ok(!codes(self).includes('delegation_unrestricted'));
  assert.match(self.title, /to itself, with 1 caveat$/);
  const redeemer = '0xb01c000000000000000000000000000000009c2e';
  const named = await sign(delegation(ANY, [{ enforcer: '0xe144b0b2618071b4e56f746313528a669c7e65c5', terms: `0x${redeemer.slice(2)}` }, { enforcer: E.exact, terms: `0x${USDC.slice(2)}${word(0n)}${transfer.slice(2)}` }]));
  assert.equal(named.warnings.find(w => w.code === 'delegation_any_delegate')!.severity, 'info');
  assert.match(named.title, /^Let 0xb01c…9c2e make one exact call/);
  const failing: Dependencies = { ...deps(), simulator: { simulate: async () => ({ status: 'reverted', source: 'mock', gasUsed: 30_000n, revertReason: 'ERC20: transfer amount exceeds balance', transfers: [] }) } };
  const p = await previewRequest({ method: 'eth_signTypedData_v4', params: [ALICE, JSON.stringify(delegation(BOB, [{ enforcer: E.exact, terms: `0x${USDC.slice(2)}${word(0n)}${transfer.slice(2)}` }]))] }, { now: NOW, chainId: 1 }, failing);
  assert.ok(codes(p).includes('delegation_calls_fail'));
  assert.ok(!codes(p).includes('simulation_reverted'));
  assert.ok(!p.warnings.some(w => /still pay the network fee/.test(w.message)));
});

test('The rest of 1.3.0: OR groups, multi-token periods, a specific action then a transfer, block windows, exact calldata', async () => {
  const group = (caveats: { enforcer: string; terms: string }[]) => ({ caveats: caveats.map(c => ({ ...c, args: '0x' })) });
  const or = (groups: ReturnType<typeof group>[]) => encodeAbiParameters([{ type: 'tuple[]', components: [{ name: 'caveats', type: 'tuple[]', components: [{ name: 'enforcer', type: 'address' }, { name: 'terms', type: 'bytes' }, { name: 'args', type: 'bytes' }] }] }], [groups as never]);
  const targets = { enforcer: E.targets, terms: `0x${USDC.slice(2)}` }, limited = { enforcer: E.limitedCalls, terms: `0x${word(1n)}` };
  // One group the redeemer may pick restricts nothing: the whole delegation doesn't.
  const loose = await sign(delegation(BOB, [{ enforcer: '0xe1302607a3251af54c3a6e69318d6aa07f5eb46c', terms: or([group([targets]), group([limited])]) }]));
  assert.ok(codes(loose).includes('delegation_unrestricted'));
  assert.match(detail(loose, 'Caveat 1')!, /^LogicalOrWrapperEnforcer: the redeemer picks one of 2 groups of caveats: \(1\) AllowedTargetsEnforcer: calls only to 0xa0b8…eb48 \(2\) LimitedCallsEnforcer: redeemable 1 time at most$/);
  const tight = await sign(delegation(BOB, [{ enforcer: '0xe1302607a3251af54c3a6e69318d6aa07f5eb46c', terms: or([group([targets]), group([targets, limited])]) }]));
  assert.ok(!codes(tight).includes('delegation_unrestricted'));
  // 100 USDC a day, and 0.5 ETH a week.
  const start = BigInt(NOW / 1000);
  const periods = `0x${USDC.slice(2)}${word(100_000_000n)}${word(86_400n)}${word(start)}${'0'.repeat(40)}${word(5n * 10n ** 17n)}${word(604_800n)}${word(start)}`;
  const p = await sign(delegation(BOB, [{ enforcer: '0xfb2f1a9bd76d3701b730e5d69c3219d42d80ebb7', terms: periods }]));
  assert.match(detail(p, 'Caveat 1')!, /up to: 100 USDC each day from .*; 0\.5 ETH each 7 days from /);
  assert.equal(detail(p, 'Can move now (MultiTokenPeriodEnforcer)'), '100 USDC (the permitted amount; you hold 5,000 USDC)');
  // A call, then a fixed transfer: simulated as a batch, usable once.
  ran.length = 0;
  const specific = `0x${USDC.slice(2)}${BOB.slice(2).toLowerCase()}${word(25_000_000n)}${USDC.slice(2)}${word(0n)}${encodeFunctionData({ abi: parseAbi(['function approve(address, uint256)']), args: [BOB, 1n] }).slice(2)}`;
  const s = await sign(delegation(BOB, [{ enforcer: '0x6649b61c873f6f9686a1e1ae9ee98ac380c7ba13', terms: specific }]));
  assert.match(detail(s, 'Caveat 1')!, /^SpecificActionERC20TransferBatchEnforcer: once, exactly these 2 calls: .*then a transfer of 25 USDC to 0xb0b0…0002$/);
  assert.match(s.title, /make 2 exact calls/);
  assert.equal(ran.length, 2);
  assert.equal(ran[1].data, transfer);
  assert.ok(!codes(s).includes('delegation_repeatable'));
  // A block window is an expiry; exact calldata leaves the target open.
  const b = await sign(delegation(BOB, [{ enforcer: '0x5d9818df0ae3f66e9c3d0c5029daf99d1823ca6c', terms: `0x${'0'.repeat(32)}${(25_000_000n).toString(16).padStart(32, '0')}` }, { enforcer: '0x99f2e9bf15ce5ec84685604836f71ab835dbbded', terms: transfer }]));
  assert.ok(!codes(b).includes('delegation_no_expiry'));
  assert.equal(detail(b, 'Caveat 1'), 'BlockNumberEnforcer: usable before block 25000000');
  assert.match(detail(b, 'Caveat 2')!, /to any contract, with any value, unless other caveats limit those$/);
  // Exact calldata on any contract: any value to any address with that data (an EOA takes it), and its transfer on every token.
  assert.equal(b.warnings.find(w => w.code === 'delegation_native_unlimited')!.severity, 'danger');
  assert.equal(b.warnings.find(w => w.code === 'delegation_any_contract')!.severity, 'caution');
  const pinned = await sign(delegation(BOB, [{ enforcer: E.targets, terms: `0x${USDC.slice(2)}` }, { enforcer: E.methods, terms: '0xa9059cbb' }]));
  assert.ok(!codes(pinned).includes('delegation_any_contract'));
  assert.equal(detail(pinned, 'Caveat 2'), 'AllowedMethodsEnforcer: only the functions transfer (0xa9059cbb)');
  const spender = await sign(delegation(BOB, [{ enforcer: E.methods, terms: '0x095ea7b3' }, { enforcer: '0xc2b0d624c1c4319760c96503ba27c347f3260f55', terms: `0x${word(4n)}${BOB.slice(2).toLowerCase().padStart(64, '0')}` }]));
  assert.equal(detail(spender, 'Caveat 2'), "AllowedCalldataEnforcer: the call's first argument must be 0xb0b0…0002");
  assert.ok(codes(spender).includes('delegation_any_contract'));
});

test('Review: what the caveats really leave open', async () => {
  const until = { enforcer: E.timestamp, terms: `0x${'0'.repeat(32)}${BigInt(NOW / 1000 + 86_400).toString(16).padStart(32, '0')}` };
  const severity = (p: Awaited<ReturnType<typeof sign>>, code: string) => p.warnings.find(w => w.code === code)?.severity;
  // A native period checks only the value: any call with no value passes.
  const period = await sign(delegation(BOB, [{ enforcer: '0x9bc0faf4aca5ae429f4c06aeeac517520cb16bd9', terms: `0x${word(10n ** 16n)}${word(86_400n)}${word(BigInt(NOW / 1000))}` }, until]));
  assert.equal(severity(period, 'delegation_unrestricted'), 'danger');
  // Calls to the DelegationManager or to the account itself are any call; to a token, any function on it.
  for (const target of [DELEGATION_MANAGER, ALICE.toLowerCase()]) {
    const p = await sign(delegation(BOB, [{ enforcer: E.targets, terms: `0x${target.slice(2)}` }, until]));
    assert.equal(severity(p, 'delegation_unrestricted'), 'danger', target);
    assert.match(p.title, /^Delegate full control/);
  }
  const token = await sign(delegation(BOB, [{ enforcer: E.targets, terms: `0x${USDC.slice(2)}` }, until]));
  assert.equal(severity(token, 'delegation_any_function'), 'caution');
  assert.ok(!codes(token).includes('delegation_unrestricted'));
  // execute() allowed on any contract (the account itself among them).
  const exec = await sign(delegation(BOB, [{ enforcer: E.methods, terms: '0xe9ae5c53' }, until]));
  assert.equal(severity(exec, 'delegation_unrestricted'), 'danger');
  // Functions on any contract: transfer() on every token. Inside an OR group too.
  const transfers = await sign(delegation(BOB, [{ enforcer: E.methods, terms: '0xa9059cbb' }, until]));
  assert.equal(severity(transfers, 'delegation_any_contract'), 'danger');
  const or = encodeAbiParameters([{ type: 'tuple[]', components: [{ name: 'caveats', type: 'tuple[]', components: [{ name: 'enforcer', type: 'address' }, { name: 'terms', type: 'bytes' }, { name: 'args', type: 'bytes' }] }] }], [[{ caveats: [{ enforcer: E.methods, terms: '0xa9059cbb', args: '0x' }] }] as never]);
  assert.equal(severity(await sign(delegation(BOB, [{ enforcer: '0xe1302607a3251af54c3a6e69318d6aa07f5eb46c', terms: or }, until])), 'delegation_any_contract'), 'danger');
  // Plain transfers with nothing bounding them: all the coin.
  const plain = await sign(delegation(BOB, [{ enforcer: '0x99f2e9bf15ce5ec84685604836f71ab835dbbded', terms: '0x' }, until]));
  assert.equal(severity(plain, 'delegation_native_unlimited'), 'danger');
  // An end set far off is none.
  const far = await sign(delegation(BOB, [{ enforcer: E.targets, terms: `0x${USDC.slice(2)}` }, { enforcer: E.timestamp, terms: `0x${'0'.repeat(32)}${(1n << 100n).toString(16).padStart(32, '0')}` }]));
  assert.ok(codes(far).includes('delegation_no_expiry'));
  // Two configurations of one token add up; no native coin unless configured.
  const start = BigInt(NOW / 1000), cfg = `${USDC.slice(2)}${word(100_000_000n)}${word(86_400n)}${word(start)}`;
  const twice = await sign(delegation(BOB, [{ enforcer: '0xfb2f1a9bd76d3701b730e5d69c3219d42d80ebb7', terms: `0x${cfg}${cfg}` }]));
  assert.equal(detail(twice, 'Can move now (MultiTokenPeriodEnforcer)'), '200 USDC (the permitted amount; you hold 5,000 USDC)');
  assert.doesNotMatch(detail(twice, 'Caveat 1')!, /plain ETH/);
  // A balance's change is checked each time it is redeemed.
  const change = await sign(delegation(BOB, [{ enforcer: '0xcdf6ab796408598cea671d79506d7d48e97a5437', terms: `0x01${USDC.slice(2)}${ALICE.slice(2).toLowerCase()}${word(10n ** 6n)}` }]));
  assert.match(detail(change, 'Caveat 1')!, /^ERC20BalanceChangeEnforcer: each time it is redeemed, 0xa11c…0001's balance may fall by at most 1 USDC$/);
});

test('Review: a delegation passed on is about the root account, not the signer', async () => {
  ran.length = 0;
  const p = await sign(delegation(BOB, [{ enforcer: E.exact, terms: `0x${USDC.slice(2)}${word(0n)}${transfer.slice(2)}` }, { enforcer: E.erc20Amount, terms: `0x${USDC.slice(2)}${word(100_000_000n)}` }], { authority: `0x${'ab'.repeat(32)}` }));
  assert.equal(ran.length, 0);
  assert.deepEqual(p.assetChanges, []);
  assert.ok(!p.details.some(d => d.label.startsWith('Can move now')));
  assert.equal(p.warnings.find(w => w.code === 'delegation_redelegated')!.severity, 'info');
  const none = await sign(delegation(BOB, [], { authority: `0x${'ab'.repeat(32)}` }));
  assert.ok(!codes(none).includes('delegation_unrestricted'));
  assert.equal(none.warnings.find(w => w.code === 'delegation_redelegated')!.severity, 'caution');
  assert.doesNotMatch(none.summary, /your account/);
});

test('Review: a batch that fails when the simulator runs only its first call', async () => {
  const failing: Dependencies = { ...deps(), simulator: { simulate: async () => ({ status: 'reverted', source: 'mock', gasUsed: 30_000n, revertReason: 'nope', transfers: [] }) } };
  const batch = encodeAbiParameters(parseAbiParameters('(address target, uint256 value, bytes callData)[]'), [[{ target: USDC, value: 0n, callData: transfer }, { target: USDC, value: 0n, callData: transfer }]]);
  const p = await previewRequest({ method: 'eth_signTypedData_v4', params: [ALICE, JSON.stringify(delegation(BOB, [{ enforcer: E.exactBatch, terms: batch }, { enforcer: E.limitedCalls, terms: `0x${word(1n)}` }]))] }, { now: NOW, chainId: 1 }, failing);
  assert.ok(codes(p).includes('delegation_calls_fail'));
  assert.deepEqual(p.assetChanges, []);
});

test('Second review: routes to full control, coin and tokens the probes find', async () => {
  const until = { enforcer: E.timestamp, terms: `0x${'0'.repeat(32)}${BigInt(NOW / 1000 + 86_400).toString(16).padStart(32, '0')}` };
  const sev = async (caveats: { enforcer: string; terms: string }[], code: string) => (await sign(delegation(BOB, [...caveats, until]))).warnings.find(w => w.code === code)?.severity;
  const att = (fn: string) => toFunctionSelector(`function ${fn}`);
  const calldata = (start: number, value: string) => ({ enforcer: '0xc2b0d624c1c4319760c96503ba27c347f3260f55', terms: `0x${word(BigInt(start))}${value.replace(/^0x/, '')}` });
  const targets = (...a: string[]) => ({ enforcer: E.targets, terms: `0x${a.map(x => x.slice(2).toLowerCase()).join('')}` });
  const methods = (...s: string[]) => ({ enforcer: E.methods, terms: `0x${s.map(x => x.slice(2)).join('')}` });
  const or = (...groups: { enforcer: string; terms: string }[][]) => ({ enforcer: '0xe1302607a3251af54c3a6e69318d6aa07f5eb46c', terms: encodeAbiParameters([{ type: 'tuple[]', components: [{ name: 'caveats', type: 'tuple[]', components: [{ name: 'enforcer', type: 'address' }, { name: 'terms', type: 'bytes' }, { name: 'args', type: 'bytes' }] }] }], [groups.map(g => ({ caveats: g.map(c => ({ ...c, args: '0x' })) })) as never]) });
  const exactData = (d: string) => ({ enforcer: '0x99f2e9bf15ce5ec84685604836f71ab835dbbded', terms: d });
  const valueLte = (v: bigint) => ({ enforcer: E.valueLte, terms: `0x${word(v)}` });
  // Full control through the account itself or the DelegationManager, however the function is pinned.
  assert.equal(await sev([targets(ALICE), calldata(0, att('execute(bytes32,bytes)'))], 'delegation_unrestricted'), 'danger');
  assert.equal(await sev([targets(DELEGATION_MANAGER), calldata(0, att('redeemDelegations(bytes[],bytes32[],bytes[])'))], 'delegation_unrestricted'), 'danger');
  assert.equal(await sev([or([targets(DELEGATION_MANAGER), methods(att('redeemDelegations(bytes[],bytes32[],bytes[])'))])], 'delegation_unrestricted'), 'danger');
  assert.equal(await sev([targets(ALICE), methods(att('transferOwnership(address)'))], 'delegation_unrestricted'), 'danger');
  assert.equal(await sev([{ enforcer: '0x7eef9734e7092032b5c56310eb9bbd1f4a524681', terms: ALICE.toLowerCase() }], 'delegation_unrestricted'), 'danger');
  // Native coin: a cap per call is no cap unless the redemptions are bounded.
  assert.equal(await sev([exactData('0x'), valueLte(10n ** 18n)], 'delegation_native_unlimited'), 'danger');
  assert.equal(await sev([exactData('0x'), valueLte(10n ** 18n), { enforcer: E.limitedCalls, terms: `0x${word(1n)}` }], 'delegation_native_unlimited'), undefined);
  assert.equal(await sev([exactData('0x'), { enforcer: '0xbd7b277507723490cd50b12eaafe87c616be6880', terms: `0x01${ALICE.slice(2).toLowerCase()}${word(10n ** 18n)}` }], 'delegation_native_unlimited'), 'danger');
  assert.equal(await sev([or([targets(USDC)], [exactData('0x')])], 'delegation_native_unlimited'), 'danger');
  assert.equal(await sev([or([{ enforcer: E.erc20Amount, terms: `0x${USDC.slice(2)}${word(10n ** 6n)}` }], [targets(BOB), exactData('0x')])], 'delegation_native_unlimited'), 'caution');
  const batchOfEmpty = encodeAbiParameters(parseAbiParameters('(address target, uint256 value, bytes callData)[]'), [[{ target: USDC, value: 0n, callData: '0x' }, { target: USDC, value: 0n, callData: '0x' }]]);
  assert.equal(await sev([{ enforcer: '0x982fd5c86bbf425d7d1451f974192d4525113dfd', terms: batchOfEmpty }], 'delegation_native_unlimited'), 'danger');
  // A token's functions with open arguments: its whole balance.
  assert.equal(await sev([targets(USDC), methods(att('transfer(address,uint256)'))], 'delegation_any_function'), 'caution');
  // No false danger on MetaMask's own patterns, or a payee that is the account itself.
  for (const caveats of [
    [{ enforcer: '0x474e3ae7e169e940607cc624da8a15eb120139ab', terms: `0x${USDC.slice(2)}${word(10n ** 6n)}${word(86_400n)}${word(BigInt(NOW / 1000))}` }, valueLte(0n)],
    [{ enforcer: '0xd10b97905a320b13a0608f7e9cc506b56747df19', terms: `0x${word(0n)}${word(10n ** 18n)}${word(10n ** 12n)}${word(BigInt(NOW / 1000))}` }, exactData('0x')],
    [{ enforcer: '0x9bc0faf4aca5ae429f4c06aeeac517520cb16bd9', terms: `0x${word(10n ** 17n)}${word(86_400n)}${word(BigInt(NOW / 1000))}` }, exactData('0x'), targets(ALICE)],
  ]) assert.notEqual((await sign(delegation(BOB, [...caveats, until]))).attention, 'danger', JSON.stringify(caveats.map(c => c.enforcer)));
});

test('Third review: other token functions, Permit2, fixed control calls, OR pins, unlimited caps, a huge pin', async () => {
  const until = { enforcer: E.timestamp, terms: `0x${'0'.repeat(32)}${BigInt(NOW / 1000 + 86_400).toString(16).padStart(32, '0')}` };
  const zero = { enforcer: E.valueLte, terms: `0x${word(0n)}` };
  const attention = async (caveats: { enforcer: string; terms: string }[]) => (await sign(delegation(BOB, [...caveats, until]))).attention;
  const att = (fn: string) => toFunctionSelector(`function ${fn}`);
  const methods = (...s: string[]) => ({ enforcer: E.methods, terms: `0x${s.map(x => x.slice(2)).join('')}` });
  const exactData = (d: string) => ({ enforcer: '0x99f2e9bf15ce5ec84685604836f71ab835dbbded', terms: d });
  const calldata = (start: number, value: string) => ({ enforcer: '0xc2b0d624c1c4319760c96503ba27c347f3260f55', terms: `0x${word(BigInt(start))}${value.replace(/^0x/, '')}` });
  // Token functions beyond ERC-20's, and Permit2.
  for (const fn of ['safeTransferFrom(address,address,uint256,uint256,bytes)', 'safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)', 'safeTransferFrom(address,address,uint256)', 'transferAndCall(address,uint256,bytes)', 'authorizeOperator(address)'])
    assert.equal(await attention([methods(att(fn)), zero]), 'danger', fn);
  assert.equal(await attention([methods(att('approve(address,address,uint160,uint48)')), zero]), 'danger');
  assert.equal(await attention([{ enforcer: E.targets, terms: '0x000000000022d473030f116ddee9f6b43ac78ba3' }, zero]), 'danger');
  // Fixed calls that hand the account over; the account's own redeemDelegations.
  const owner = encodeFunctionData({ abi: parseAbi(['function transferOwnership(address)']), args: [BOB] });
  assert.equal(await attention([exactData(owner), zero]), 'danger');
  assert.equal(await attention([{ enforcer: E.exact, terms: `0x${ALICE.slice(2).toLowerCase()}${word(0n)}${owner.slice(2)}` }]), 'danger');
  assert.equal(await attention([{ enforcer: E.targets, terms: `0x${ALICE.slice(2).toLowerCase()}` }, methods(att('redeemDelegations(bytes[],bytes32[],bytes[])'))]), 'danger');
  // An unlimited approval pinned to one spender, on every token; an unlimited cap is none.
  assert.equal(await attention([exactData(encodeFunctionData({ abi: parseAbi(['function approve(address,uint256)']), args: [BOB, (1n << 256n) - 1n] })), zero]), 'danger');
  assert.equal(await attention([{ enforcer: E.erc20Amount, terms: `0x${USDC.slice(2)}${word((1n << 256n) - 1n)}` }]), 'caution');
  assert.equal(await attention([exactData('0x'), { enforcer: '0xf71af580b9c3078fbc2bbf16fbb8eed82b330320', terms: `0x${word((1n << 256n) - 1n)}` }]), 'danger');
  assert.equal(await attention([exactData('0x'), { enforcer: E.valueLte, terms: `0x${word(10n ** 18n)}` }, { enforcer: E.limitedCalls, terms: `0x${word((1n << 256n) - 1n)}` }]), 'danger');
  // OR groups' pins laid group by group, in either order.
  const SAFE = '0x5afe000000000000000000000000000000005afe';
  const or = (...groups: { enforcer: string; terms: string }[][]) => ({ enforcer: '0xe1302607a3251af54c3a6e69318d6aa07f5eb46c', terms: encodeAbiParameters([{ type: 'tuple[]', components: [{ name: 'caveats', type: 'tuple[]', components: [{ name: 'enforcer', type: 'address' }, { name: 'terms', type: 'bytes' }, { name: 'args', type: 'bytes' }] }] }], [groups.map(g => ({ caveats: g.map(c => ({ ...c, args: '0x' })) })) as never]) });
  const g1 = [calldata(4, BOB.slice(2).toLowerCase().padStart(64, '0')), calldata(36, word(10n ** 30n))], g2 = [calldata(4, SAFE.slice(2).padStart(64, '0')), { enforcer: E.targets, terms: `0x${SAFE.slice(2)}` }];
  assert.equal(await attention([or(g1, g2), zero]), await attention([or(g2, g1), zero]));
  // A pin far beyond any call doesn't crash the preview.
  assert.ok(await attention([or([calldata(2 ** 40, '0x01')], [])]));
});

test('Fourth review: far pins, many OR groups, exact calldata on the account, unbounded streams and caps, sub-hourly periods', async () => {
  const until = { enforcer: E.timestamp, terms: `0x${'0'.repeat(32)}${BigInt(NOW / 1000 + 86_400).toString(16).padStart(32, '0')}` };
  const zero = { enforcer: E.valueLte, terms: `0x${word(0n)}` };
  const attention = async (caveats: { enforcer: string; terms: string }[]) => (await sign(delegation(BOB, [...caveats, until]))).attention;
  const calldata = (start: number, value: string) => ({ enforcer: '0xc2b0d624c1c4319760c96503ba27c347f3260f55', terms: `0x${word(BigInt(start))}${value.replace(/^0x/, '')}` });
  const exactData = (d: string) => ({ enforcer: '0x99f2e9bf15ce5ec84685604836f71ab835dbbded', terms: d });
  const targets = (...a: string[]) => ({ enforcer: E.targets, terms: `0x${a.map(x => x.slice(2).toLowerCase()).join('')}` });
  // A pin past 4 KB is met by padding the call.
  assert.equal(await attention([calldata(4096, 'de'.repeat(32))]), 'danger');
  // 65 OR groups: the last one, open, is still found.
  const or = (groups: { enforcer: string; terms: string }[][]) => ({ enforcer: '0xe1302607a3251af54c3a6e69318d6aa07f5eb46c', terms: encodeAbiParameters([{ type: 'tuple[]', components: [{ name: 'caveats', type: 'tuple[]', components: [{ name: 'enforcer', type: 'address' }, { name: 'terms', type: 'bytes' }, { name: 'args', type: 'bytes' }] }] }], [groups.map(g => ({ caveats: g.map(c => ({ ...c, args: '0x' })) })) as never]) });
  const EVIL = '0x0000000000000000000000000000000000e0e0e0';
  const many = Array.from({ length: 64 }, (_, i) => [targets('0x4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a'), calldata(4, word(BigInt(i)))]);
  assert.equal(await attention([or([...many, [calldata(4, EVIL.slice(2).padStart(64, '0'))]]), zero]), 'danger');
  // A fixed execute(…) on the account, by ExactCalldata: not simulated, so its calls are named, with their warnings
  // (fifth review: as the same call simulated as an exact execution would be, not as full control).
  const approve = encodeFunctionData({ abi: parseAbi(['function approve(address,uint256)']), args: [EVIL as `0x${string}`, (1n << 256n) - 1n] });
  const exec = encodeFunctionData({ abi: parseAbi(['function execute(bytes32,bytes)']), args: [`0x${'0'.repeat(64)}`, `0x${USDC.slice(2)}${word(0n)}${approve.slice(2)}`] });
  const fixedExec = await sign(delegation(BOB, [exactData(exec), targets(ALICE), until]));
  assert.ok(!codes(fixedExec).includes('delegation_unrestricted'));
  assert.match(fixedExec.warnings.find(w => w.code === 'delegation_unsimulated_calls')!.message, /Allow 0x0000…e0e0 to spend unlimited USDC, as many times as wanted/i);
  assert.ok(codes(fixedExec).includes('unlimited_approval'));
  // Streams and caps that cap nothing.
  assert.equal(await attention([exactData('0x'), { enforcer: '0xd10b97905a320b13a0608f7e9cc506b56747df19', terms: `0x${word((1n << 256n) - 1n)}${word((1n << 256n) - 1n)}${word(0n)}${word(1n)}` }]), 'danger');
  assert.equal(await attention([exactData('0x'), { enforcer: E.valueLte, terms: `0x${word((1n << 255n) - 1n)}` }, { enforcer: '0xc8b5d93463c893401094cc70e66a206fb5987997', terms: `0x${word(1n)}` }]), 'danger');
  assert.equal(await attention([exactData('0x'), { enforcer: E.valueLte, terms: `0x${word(10n ** 30n)}` }, { enforcer: E.limitedCalls, terms: `0x${word(10_000n)}` }]), 'danger');
  // An allowance that comes back every second is no cap.
  assert.equal(await attention([exactData('0x'), { enforcer: '0x9bc0faf4aca5ae429f4c06aeeac517520cb16bd9', terms: `0x${word(10n ** 18n)}${word(1n)}${word(BigInt(NOW / 1000))}` }]), 'danger');
  assert.notEqual(await attention([{ enforcer: '0x474e3ae7e169e940607cc624da8a15eb120139ab', terms: `0x${USDC.slice(2)}${word(10n ** 9n)}${word(1n)}${word(BigInt(NOW / 1000))}` }, zero]), 'none');
});

test('Fifth review: exact calls inside an OR, a search past 256 OR combinations, native caps per redemption and per call, multi-token periods, a long pin', async () => {
  const until = { enforcer: E.timestamp, terms: `0x${'0'.repeat(32)}${BigInt(NOW / 1000 + 86_400).toString(16).padStart(32, '0')}` };
  const zero = { enforcer: E.valueLte, terms: `0x${word(0n)}` };
  const EVIL = '0xe1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1';
  /** With an RPC that has the account hold `balance` wei, or none. */
  const run = async (caveats: { enforcer: string; terms: string }[], balance?: bigint) => previewRequest({ method: 'eth_signTypedData_v4', params: [ALICE, JSON.stringify(delegation(BOB, [...caveats, until]))] }, { now: NOW, chainId: 1 }, {
    tokens: new StaticTokenRegistry(),
    ...(balance !== undefined && { rpc: { has: () => true, call: async (_c: number, method: string, params: unknown[]) => {
      if (method === 'eth_getBalance') return `0x${balance.toString(16)}`;
      if (method === 'eth_getCode') return '0x';
      return (params[0] as { data: string }).data.startsWith('0x70a08231') ? `0x${word(5_000_000_000n)}` : '0x';
    } } }),
  });
  const calldata = (start: number, value: string) => ({ enforcer: '0xc2b0d624c1c4319760c96503ba27c347f3260f55', terms: `0x${word(BigInt(start))}${value.replace(/^0x/, '')}` });
  const or = (groups: { enforcer: string; terms: string }[][]) => ({ enforcer: '0xe1302607a3251af54c3a6e69318d6aa07f5eb46c', terms: encodeAbiParameters([{ type: 'tuple[]', components: [{ name: 'caveats', type: 'tuple[]', components: [{ name: 'enforcer', type: 'address' }, { name: 'terms', type: 'bytes' }, { name: 'args', type: 'bytes' }] }] }], [groups.map(g => ({ caveats: g.map(c => ({ ...c, args: '0x' })) })) as never]) });
  const exec = (target: string, data: string) => encodeFunctionData({ abi: parseAbi(['function execute(bytes32,bytes)']), args: [`0x${'0'.repeat(64)}`, `0x${target.slice(2).toLowerCase()}${word(0n)}${data.slice(2)}`] });
  const exactOn = (data: string) => ({ enforcer: E.exact, terms: `0x${ALICE.slice(2).toLowerCase()}${word(0n)}${data.slice(2)}` });
  const benign = [{ enforcer: E.targets, terms: '0x4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a' }, calldata(0, '0xdeadbeef'), zero];
  // An exact execute(…) inside an OR isn't simulated: its fixed calls are named, not exempted silently.
  const drain = encodeFunctionData({ abi: parseAbi(['function transfer(address,uint256)']), args: [EVIL, 5_000_000_000n] });
  const inOr = await run([or([[exactOn(exec(USDC, drain))], benign])]);
  assert.match(inOr.warnings.find(w => w.code === 'delegation_unsimulated_calls')!.message, /Send 5,000 USDC, as many times as wanted/);
  // One that upgrades the account hands it over, inside an OR or at the top.
  const upgrade = encodeFunctionData({ abi: parseAbi(['function upgradeToAndCall(address,bytes)']), args: [EVIL, '0x'] });
  assert.ok(codes(await run([or([[exactOn(exec(ALICE, upgrade))], benign])])).includes('delegation_unrestricted'));
  assert.ok(codes(await run([exactOn(exec(ALICE, upgrade))])).includes('delegation_unrestricted'));
  // Two ORs whose groups multiply past 256: approve(EVIL, unlimited) on every token is still found.
  const approveOnly = { enforcer: E.methods, terms: toFunctionSelector('function approve(address,uint256)') };
  const spender = or([[calldata(4, word(BigInt(EVIL)))], [calldata(4, word(0x1111n))]]);
  const amount = or([[calldata(36, word((1n << 256n) - 1n))], ...Array.from({ length: 128 }, (_, i) => [calldata(36, word(BigInt(i + 0x10000)))])]);
  assert.equal((await run([approveOnly, spender, amount, zero])).warnings.find(w => w.code === 'delegation_any_contract')?.severity, 'danger');
  // Native coin: a balance cap on another address is no cap; a per-redemption cap times the count, against the balance.
  const plain = { enforcer: '0x99f2e9bf15ce5ec84685604836f71ab835dbbded', terms: '0x' };
  const fall = (who: string, amount: bigint) => ({ enforcer: '0xbd7b277507723490cd50b12eaafe87c616be6880', terms: `0x01${who.slice(2).toLowerCase()}${word(amount)}` });
  const once = { enforcer: '0xc8b5d93463c893401094cc70e66a206fb5987997', terms: `0x${word(1n)}` };
  const limited = (n: bigint) => ({ enforcer: E.limitedCalls, terms: `0x${word(n)}` });
  const nativeWarning = (p: Awaited<ReturnType<typeof run>>) => p.warnings.find(w => w.code.startsWith('delegation_native'));
  assert.equal(nativeWarning(await run([plain, fall('0x000000000000000000000000000000000000dead', 0n), once]))?.severity, 'danger');
  assert.equal(nativeWarning(await run([plain, fall(ALICE, 10n ** 21n), limited(10_000n)], 10n ** 20n))?.severity, 'danger');
  assert.equal(nativeWarning(await run([plain, fall(ALICE, 10n ** 18n), limited(5n)], 10n ** 20n))?.code, 'delegation_native_limited');
  // A stream with no most and a rate adds up without end.
  assert.equal(nativeWarning(await run([plain, { enforcer: '0xd10b97905a320b13a0608f7e9cc506b56747df19', terms: `0x${word(0n)}${word((1n << 256n) - 1n)}${word(10n ** 18n)}${word(BigInt(NOW / 1000))}` }]))?.severity, 'danger');
  // A per-call cap times a bounded count: a caution stating the total (with or without the balance), a danger past it.
  const capped = [plain, { enforcer: E.valueLte, terms: `0x${word(10n ** 21n)}` }, limited(10n)];
  const unread = nativeWarning(await run(capped))!;
  assert.equal(unread.code, 'delegation_native_limited');
  assert.match(unread.message, /up to 1,000 ETH each time, 10 times: up to 10,000 ETH in all \(what you hold wasn't read\)/);
  assert.equal(nativeWarning(await run(capped, 10n ** 20n))?.severity, 'danger');
  assert.match(nativeWarning(await run([plain, { enforcer: E.valueLte, terms: `0x${word(10n ** 19n)}` }, limited(5n)], 10n ** 20n))!.message, /50 ETH in all of the 100 ETH you hold/);
  // MultiTokenPeriod's tokens are probed: no cap per day, or back every minute.
  const multi = (amount: bigint, period: bigint) => ({ enforcer: '0xfb2f1a9bd76d3701b730e5d69c3219d42d80ebb7', terms: `0x${USDC.slice(2)}${word(amount)}${word(period)}${word(BigInt(NOW / 1000))}` });
  assert.ok(codes(await run([multi((1n << 256n) - 1n, 86_400n), zero])).includes('delegation_any_function'));
  assert.ok(codes(await run([multi(10n ** 9n, 60n), zero])).includes('delegation_any_function'));
  assert.ok(!codes(await run([multi(10n ** 9n, 86_400n), zero])).includes('delegation_any_function'));
  // A pin that starts inside the call and runs past 4 KB is laid, not taken as met by padding.
  const fixedTransfer = encodeFunctionData({ abi: parseAbi(['function transfer(address,uint256)']), args: [BOB, 1n] }).slice(2).padEnd(4100 * 2, '0');
  assert.notEqual((await run([calldata(0, fixedTransfer), zero])).attention, 'danger');
});
