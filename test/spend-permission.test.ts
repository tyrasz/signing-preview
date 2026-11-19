// Coinbase Smart Wallet spend permissions (SpendPermissionManager): what the spender can take, per period, until when.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toFunctionSelector } from 'viem';
import { previewRequest } from '../src/preview.ts';
import { StaticTokenRegistry } from '../src/chains.ts';
import { SPEND_PERMISSION_MANAGER } from '../src/typed-data/spend-permission.ts';
import type { Dependencies } from '../src/types.ts';
import { ALICE, BOB } from '../mocks/data.ts';
import { codes, detail, NOW } from './helpers.ts';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const word = (v: bigint) => v.toString(16).padStart(64, '0');
const IS_REVOKED = toFunctionSelector('function isRevoked((address,address,address,uint160,uint48,uint48,uint48,uint256,bytes))');
/** 5,000 USDC and 2 ETH; `revoked` answers isRevoked. */
const deps = (revoked = false): Dependencies => ({ tokens: new StaticTokenRegistry(), rpc: { has: () => true, call: async (_c: number, method: string, params: unknown[]) => {
  if (method === 'eth_getBalance') return `0x${(2n * 10n ** 18n).toString(16)}`;
  const { data } = params[0] as { data: string };
  if (data.startsWith('0x70a08231')) return `0x${word(5_000_000_000n)}`;
  if (data.startsWith(IS_REVOKED)) return `0x${word(revoked ? 1n : 0n)}`;
  return `0x${word(0n)}`;
} } });
const DOMAIN = { name: 'Spend Permission Manager', version: '1', chainId: 1, verifyingContract: SPEND_PERMISSION_MANAGER };
const EIP712 = [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }];
const fields = (spec: string) => spec.split(',').map(s => ({ type: s.split(' ')[0], name: s.split(' ')[1] }));
const now = NOW / 1000;
const single = (p: Record<string, unknown>, domain: Record<string, unknown> = DOMAIN) => ({ domain, primaryType: 'SpendPermission',
  types: { EIP712Domain: EIP712, SpendPermission: fields('address account,address spender,address token,uint160 allowance,uint48 period,uint48 start,uint48 end,uint256 salt,bytes extraData') },
  message: { account: ALICE, spender: BOB, token: USDC, allowance: '100000000', period: 604_800, start: now - 60, end: now + 30 * 86_400, salt: '1', extraData: '0x', ...p } });
const sign = (data: unknown, d = deps(), signer = ALICE) => previewRequest({ method: 'eth_signTypedData_v4', params: [signer, JSON.stringify(data)] }, { now: NOW, chainId: 1 }, d);

test('A weekly USDC allowance until a date: what the spender can take now', async () => {
  const p = await sign(single({}));
  assert.equal(p.decoding.decoder, 'coinbase_spend_permission');
  assert.equal(p.title, 'Let 0xb0b0…0002 take up to 100 USDC a week from your account');
  assert.equal(detail(p, 'Allowance'), '100 USDC a week');
  assert.equal(detail(p, 'Can move now'), '100 USDC (the permitted amount; you hold 5,000 USDC)');
  assert.deepEqual(codes(p).filter(c => c.startsWith('spend_permission')), []);
  assert.equal(p.attention, 'none');
});

test('Unlimited native coin with no end; a revoked one; another manager, another account, refused as signed', async () => {
  const p = await sign(single({ token: NATIVE, allowance: ((1n << 160n) - 1n).toString(), period: 86_400, end: 2 ** 48 - 1 }));
  assert.equal(p.title, 'Let 0xb0b0…0002 take up to unlimited ETH a day from your account');
  assert.equal(p.warnings.find(w => w.code === 'spend_permission_unlimited')!.severity, 'danger');
  assert.ok(codes(p).includes('spend_permission_no_expiry'));
  assert.equal(detail(p, 'Can move now'), '2 ETH (your whole balance, and any you receive while it lasts)');
  assert.equal(detail(p, 'Until'), 'no end');
  assert.ok(codes(await sign(single({}), deps(true))).includes('spend_permission_revoked'));
  const other = await sign(single({}, { ...DOMAIN, verifyingContract: '0x2222222222222222222222222222222222222222' }), deps(), BOB);
  for (const c of ['spend_permission_manager_unknown', 'spend_permission_other_account']) assert.ok(codes(other).includes(c), c);
  assert.ok(codes(await sign(single({ start: now + 10, end: now + 10 }))).includes('spend_permission_invalid'));
  assert.ok(codes(await sign(single({ end: now - 10, start: now - 100 }))).includes('spend_permission_expired'));
});

test('A batch: several spenders and tokens in one signature, sharing the window; one period for the whole window', async () => {
  const batch = { domain: DOMAIN, primaryType: 'SpendPermissionBatch',
    types: { EIP712Domain: EIP712, SpendPermissionBatch: fields('address account,uint48 period,uint48 start,uint48 end,PermissionDetails[] permissions'), PermissionDetails: fields('address spender,address token,uint160 allowance,uint256 salt,bytes extraData') },
    message: { account: ALICE, period: 365 * 86_400, start: now - 60, end: now + 30 * 86_400, permissions: [{ spender: BOB, token: USDC, allowance: '25000000', salt: '0', extraData: '0x' }, { spender: BOB, token: NATIVE, allowance: (10n ** 17n).toString(), salt: '0', extraData: '0x' }] } };
  const p = await sign(batch);
  assert.equal(p.title, 'Let 0xb0b0…0002 take up to 25 USDC and 0.1 ETH in all from your account');
  assert.equal(detail(p, 'Can move now 1'), '25 USDC (the permitted amount; you hold 5,000 USDC)');
  assert.equal(detail(p, 'Can move now 2'), '0.1 ETH (the permitted amount; you hold 2 ETH)');
  assert.equal(detail(p, 'Period'), 'none: the allowance is for the whole window');
});

test('An allowance of 2^128 is unlimited; one that comes back every second is no limit; the total over the window', async () => {
  assert.equal((await sign(single({ allowance: (1n << 128n).toString() }))).warnings.find(w => w.code === 'spend_permission_unlimited')!.severity, 'danger');
  const often = await sign(single({ period: 1 }));
  assert.equal(often.warnings.find(w => w.code === 'spend_permission_unlimited')!.severity, 'danger');
  const weekly = await sign(single({}));
  assert.match(detail(weekly, 'In all')!, /^up to 500 USDC over its window \(100 USDC a week, 5 periods\)$/);
  assert.ok(!codes(weekly).includes('spend_permission_unlimited'));
  // An allowance sent as a JSON number past 2^53 is still read.
  const raw = JSON.stringify(single({})).replace('"allowance":"100000000"', '"allowance":1e40');
  const p = await previewRequest({ method: 'eth_signTypedData_v4', params: [ALICE, raw] }, { now: NOW, chainId: 1 }, deps());
  assert.equal(p.decoding.decoder, 'coinbase_spend_permission');
  assert.ok(codes(p).includes('spend_permission_unlimited'));
});

test('Fourth review: a small frequent allowance under the balance; periods counted from start; a period of 0', async () => {
  const small = await sign(single({ allowance: '10000', period: 1800, end: now + 30 * 86_400 }));
  assert.ok(!codes(small).includes('spend_permission_unlimited'));
  assert.match(detail(small, 'In all')!, /^up to 14\.41 USDC over its window \(0\.01 USDC every 30 minutes, 1,441 periods\)$/);
  // Started 23 hours ago, a day each, ending in 2 hours: this period and the next.
  const aligned = await sign(single({ period: 86_400, start: now - 23 * 3600, end: now + 2 * 3600 }));
  assert.match(detail(aligned, 'In all')!, /\(100 USDC a day, 2 periods\)$/);
  const zero = await sign(single({ period: 0 }));
  assert.ok(codes(zero).includes('spend_permission_invalid'));
});

test('Fifth review: a permission that starts later is weighed against what the account holds now', async () => {
  const p = await sign(single({ allowance: '1000000000', period: 60, start: now + 60, end: 281474976710655 }));
  assert.equal(p.warnings.find(w => w.code === 'spend_permission_unlimited')?.severity, 'danger');
  assert.equal(detail(p, 'Can move once it starts'), '1,000 USDC (the permitted amount; you hold 5,000 USDC)');
});
