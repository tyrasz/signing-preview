// Compound III (Comet) authorizations: who may then manage the account's position in a market.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previewRequest } from '../src/preview.ts';
import type { Dependencies } from '../src/types.ts';
import { ALICE, BOB } from '../mocks/data.ts';
import { codes, NOW } from './helpers.ts';

const CUSDC = '0xc3d688b66703497daa19211eedff47f25384cdc3';
const word = (v: bigint) => v.toString(16).padStart(64, '0');
/** A Comet market (baseToken() answers); next nonce 1; `code` for the manager. */
const deps = (code: string, comet = true): Dependencies => ({ rpc: { has: () => true, call: async (_c: number, method: string, params: unknown[]) => {
  if (method === 'eth_getCode') return code;
  const { data } = params[0] as { data: string };
  if (data.startsWith('0xc55dae63')) return comet ? `0x${word(0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48n)}` : '0x';
  if (data.startsWith('0x2e04b8e7')) return `0x${word(1n)}`;
  return `0x${word(0n)}`;
} } });
const auth = (o: Record<string, unknown> = {}) => ({
  domain: { name: 'Compound USDC', version: '0', chainId: 1, verifyingContract: CUSDC }, primaryType: 'Authorization',
  types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }], Authorization: [{ name: 'owner', type: 'address' }, { name: 'manager', type: 'address' }, { name: 'isAllowed', type: 'bool' }, { name: 'nonce', type: 'uint256' }, { name: 'expiry', type: 'uint256' }] },
  message: { owner: ALICE, manager: BOB, isAllowed: true, nonce: '1', expiry: String(NOW / 1000 + 3600), ...o },
});
const sign = (data: unknown, d = deps('0x6080')) => previewRequest({ method: 'eth_signTypedData_v4', params: [ALICE, JSON.stringify(data)] }, { now: NOW, chainId: 1 }, d);

test('A manager that is a contract is a caution; one with no code, a danger; a revocation', async () => {
  const p = await sign(auth());
  assert.equal(p.decoding.decoder, 'comet_authorization');
  assert.equal(p.title, 'Make 0xb0b0…0002 a manager of your Compound USDC position');
  assert.equal(p.warnings.find(w => w.code === 'comet_authorize')!.severity, 'caution');
  assert.equal((await sign(auth(), deps('0x'))).warnings.find(w => w.code === 'comet_authorize')!.severity, 'danger');
  const r = await sign(auth({ isAllowed: false }));
  assert.match(r.title, /^Remove 0xb0b0…0002 as a manager/);
  assert.ok(!codes(r).includes('comet_authorize'));
});

test('A used nonce, a passed expiry, a contract that is not a market', async () => {
  assert.ok(codes(await sign(auth({ nonce: '0' }))).includes('comet_nonce'));
  assert.ok(codes(await sign(auth({ expiry: String(NOW / 1000) }))).includes('comet_expired'));
  const other = await sign(auth(), deps('0x6080', false));
  assert.ok(codes(other).includes('comet_market_unknown'));
  assert.equal(other.decoding.status, 'partial');
});

test('The same grants sent as transactions: Morpho setAuthorization, Compound allow', async () => {
  const { encodeFunctionData, parseAbi } = await import('viem');
  const { MORPHO } = await import('../src/typed-data/morpho.ts');
  const send = (to: string, data: string, code: string, comet = true) => previewRequest({ method: 'eth_sendTransaction', params: [{ from: ALICE, to, data, value: '0x0', chainId: '0x1' }] }, { now: NOW, chainId: 1, account: ALICE }, deps(code, comet));
  const morpho = await send(MORPHO, encodeFunctionData({ abi: parseAbi(['function setAuthorization(address,bool)']), args: [BOB, true] }), '0x');
  assert.equal(morpho.title, 'Authorize 0xb0b0…0002 to manage your Morpho positions');
  assert.equal(morpho.warnings.find(w => w.code === 'morpho_authorize')!.severity, 'danger');
  const allow = encodeFunctionData({ abi: parseAbi(['function allow(address,bool)']), args: [BOB, true] });
  const comet = await send(CUSDC, allow, '0x6080');
  assert.equal(comet.title, 'Make 0xb0b0…0002 a manager of your Compound position');
  assert.equal(comet.warnings.find(w => w.code === 'comet_authorize')!.severity, 'caution');
  // allow(address,bool) on a contract that isn't a market: not read as one.
  assert.ok(!codes(await send(CUSDC, allow, '0x6080', false)).includes('comet_authorize'));
});

test("Fourth review: a market's approve of the largest amount is allow", async () => {
  const { encodeFunctionData, parseAbi } = await import('viem');
  const approve = (amount: bigint) => encodeFunctionData({ abi: parseAbi(['function approve(address,uint256)']), args: [BOB, amount] });
  const send = (data: string) => previewRequest({ method: 'eth_sendTransaction', params: [{ from: ALICE, to: CUSDC, data, value: '0x0', chainId: '0x1' }] }, { now: NOW, chainId: 1, account: ALICE }, deps('0x'));
  const p = await send(approve((1n << 256n) - 1n));
  assert.equal(p.warnings.find(w => w.code === 'comet_authorize')!.severity, 'danger');
  assert.match((await send(approve(0n))).title, /^Remove 0xb0b0…0002 as a manager/);
});
