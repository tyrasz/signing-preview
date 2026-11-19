// MetaMask Delegation Framework (ERC-7710) delegations: the delegate, its caveats read by their enforcers, what it
// leaves unrestricted, and an exact execution simulated as the account would make it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, encodeFunctionData, parseAbi, parseAbiParameters } from 'viem';
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
  assert.ok(codes(b).includes('delegation_any_contract'));
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
