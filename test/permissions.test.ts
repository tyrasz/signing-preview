// ERC-7715 wallet_requestExecutionPermissions: each permission previewed as the delegation MetaMask signs for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previewRequest } from '../src/preview.ts';
import { StaticTokenRegistry } from '../src/chains.ts';
import type { Dependencies } from '../src/types.ts';
import { ALICE } from '../mocks/data.ts';
import { codes, detail, NOW } from './helpers.ts';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', SESSION = '0x016562aa41a8697720ce0943f003141f5deae006', SHOP = '0x5110000000000000000000000000000000000005';
const word = (v: bigint) => v.toString(16).padStart(64, '0');
const hex = (v: bigint) => `0x${v.toString(16)}`;
/** 5,000 USDC and 2 ETH. */
const deps = (): Dependencies => ({ tokens: new StaticTokenRegistry(), rpc: { has: () => true, call: async (_c: number, method: string, params: unknown[]) => {
  if (method === 'eth_getBalance') return hex(2n * 10n ** 18n);
  const { data } = params[0] as { data: string };
  return data.startsWith('0x70a08231') ? `0x${word(5_000_000_000n)}` : '0x';
} } });
const ask = (requests: unknown[], d = deps()) => previewRequest({ method: 'wallet_requestExecutionPermissions', params: requests }, { now: NOW, chainId: 1, account: ALICE }, d);
const expiry = { type: 'expiry', data: { timestamp: NOW / 1000 + 7 * 86_400 } };
const request = (type: string, data: Record<string, unknown>, rules: unknown[] = [expiry]) => ({ chainId: '0x1', from: ALICE, to: SESSION, permission: { type, isAdjustmentAllowed: true, data: { justification: 'Pay your subscription', ...data } }, rules });

test('native-token-periodic: plain transfers of up to an amount a day, until it expires; what it can move now', async () => {
  const p = await ask([request('native-token-periodic', { periodAmount: hex(10n ** 17n), periodDuration: 86_400, startTime: NOW / 1000 })]);
  assert.equal(p.kind, 'typed_data');
  assert.equal(p.decoding.decoder, 'erc7715_permission');
  assert.equal(p.title, 'Let 0x0165…e006 spend up to 0.1 ETH a day from your account');
  assert.match(detail(p, 'Caveat 1')!, /^NativeTokenPeriodTransferEnforcer: ETH sent with the calls: 0\.1 ETH each day, from /);
  assert.ok(!codes(p).includes('delegation_native_unlimited'));
  assert.equal(detail(p, 'Caveat 2'), 'ExactCalldataEnforcer: no call data: only plain ETH transfers, to any address');
  assert.match(detail(p, 'Caveat 3')!, /^TimestampEnforcer: usable before /);
  assert.equal(detail(p, 'Can move now (NativeTokenPeriodTransferEnforcer)'), '0.1 ETH (the permitted amount; you hold 2 ETH)');
  assert.equal(detail(p, 'Reason given by the site'), 'Pay your subscription');
  for (const c of ['delegation_unrestricted', 'delegation_any_contract', 'delegation_no_expiry']) assert.ok(!codes(p).includes(c), c);
  assert.ok(codes(p).includes('permission_adjustable'));
  assert.equal(detail(p, 'Authority'), undefined);
});

test('erc20-token-stream without a maxAmount has no total cap; with no expiry it never ends', async () => {
  const p = await ask([request('erc20-token-stream', { tokenAddress: USDC, amountPerSecond: hex(1000n), startTime: NOW / 1000 }, [])]);
  assert.equal(p.title, 'Let 0x0165…e006 take 0.001 USDC a second from your account, with no total cap');
  assert.match(p.warnings.find(w => w.code === 'permission_no_cap')!.message, /86\.4 USDC more becomes available each day.*no maxAmount was given/);
  assert.ok(codes(p).includes('delegation_no_expiry'));
  assert.equal(detail(p, 'Can move now (ERC20StreamingEnforcer)'), '5,000 USDC (your whole balance, and any you receive while the permission lasts)');
  assert.equal(detail(p, 'Caveat 2'), 'ValueLteEnforcer: at most 0 ETH sent with each call');
});

test('erc20-token-allowance paid only to one address; token-approval-revocation', async () => {
  const p = await ask([request('erc20-token-allowance', { tokenAddress: USDC, allowanceAmount: hex(100_000_000n), startTime: NOW / 1000 }, [expiry, { type: 'payee', data: { addresses: [SHOP] } }])]);
  assert.equal(p.title, 'Let 0x0165…e006 spend up to 100 USDC from your account, paid only to 0x5110…0005');
  assert.match(detail(p, 'Caveat 1')!, /^ERC20PeriodTransferEnforcer: only transfer\(\) calls on USDC: 100 USDC in all, from /);
  assert.equal(detail(p, 'Caveat 4'), "AllowedCalldataEnforcer: the call's first argument must be 0x5110…0005");
  assert.ok(!codes(p).includes('delegation_any_contract'));
  assert.equal(detail(p, 'Can move now (ERC20PeriodTransferEnforcer)'), '100 USDC (the permitted amount; you hold 5,000 USDC)');
  const r = await ask([request('token-approval-revocation', { erc20Approve: true, permit2Approve: true })]);
  assert.equal(r.title, 'Let 0x0165…e006 revoke approvals your account has given (it can only take permissions away)');
  assert.equal(detail(r, 'Caveat 1'), "ApprovalRevocationEnforcer: only revoking approvals your account has given: ERC-20 approve(spender, 0), Permit2's approve(token, spender, 0, 0)");
  assert.notEqual(r.attention, 'danger');
});

test('Unknown types and rules, malformed requests, several permissions at once', async () => {
  const u = await ask([request('custom-thing', { foo: 1 })]);
  assert.equal(u.decoding.status, 'opaque');
  assert.ok(codes(u).includes('permission_type_unknown'));
  const m = await ask([request('native-token-stream', { maxAmount: hex(10n ** 18n) })]);
  assert.ok(codes(m).includes('permission_malformed'));
  assert.match(m.warnings.find(w => w.code === 'permission_malformed')!.message, /amountPerSecond is missing/);
  const r = await ask([request('native-token-allowance', { allowanceAmount: hex(10n ** 18n) }, [{ type: 'spending-cap', data: {} }])]);
  assert.ok(codes(r).includes('permission_rule_unknown'));
  const both = await ask([request('native-token-allowance', { allowanceAmount: hex(10n ** 18n) }), request('erc20-token-periodic', { tokenAddress: USDC, periodAmount: hex(10_000_000n), periodDuration: 604_800 })]);
  assert.equal(both.calls?.length, 2);
  assert.equal(both.title, '2 permissions: Let 0x0165…e006 spend up to 1 ETH from your account; Let 0x0165…e006 spend up to 10 USDC a week from your account');
  assert.ok(both.warnings.every(w => /^Permission [12]: /.test(w.message)));
  // A request for another account than the connected one.
  const other = await previewRequest({ method: 'wallet_requestExecutionPermissions', params: [{ ...request('native-token-allowance', { allowanceAmount: hex(1n) }), from: SHOP }] }, { now: NOW, chainId: 1, account: ALICE }, deps());
  assert.ok(codes(other).includes('signer_mismatch'));
});
