// Morpho Blue authorizations: who may then manage the account's positions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previewRequest } from '../src/preview.ts';
import { MORPHO } from '../src/typed-data/morpho.ts';
import type { Dependencies } from '../src/types.ts';
import { ALICE, BOB } from '../mocks/data.ts';
import { codes, NOW } from './helpers.ts';

const word = (v: bigint) => v.toString(16).padStart(64, '0');
/** Next nonce 3; `code` for the authorized address; not authorized yet. */
const deps = (code: string): Dependencies => ({ rpc: { has: () => true, call: async (_c: number, method: string, params: unknown[]) => {
  if (method === 'eth_getCode') return code;
  const { data } = params[0] as { data: string };
  return data.startsWith('0x70ae92d2') ? `0x${word(3n)}` : `0x${word(0n)}`;
} } });
const auth = (o: Record<string, unknown> = {}, contract = MORPHO) => ({
  domain: { chainId: 1, verifyingContract: contract }, primaryType: 'Authorization',
  types: { EIP712Domain: [{ name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }], Authorization: [{ name: 'authorizer', type: 'address' }, { name: 'authorized', type: 'address' }, { name: 'isAuthorized', type: 'bool' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
  message: { authorizer: ALICE, authorized: BOB, isAuthorized: true, nonce: '3', deadline: String(NOW / 1000 + 3600), ...o },
});
const sign = (data: unknown, code = '0x6080') => previewRequest({ method: 'eth_signTypedData_v4', params: [ALICE, JSON.stringify(data)] }, { now: NOW, chainId: 1 }, deps(code));

test('Authorizing an adapter contract is a caution; an account with no code, a danger', async () => {
  const p = await sign(auth());
  assert.equal(p.decoding.decoder, 'morpho_authorization');
  assert.equal(p.title, 'Authorize 0xb0b0…0002 to manage your Morpho positions');
  assert.equal(p.warnings.find(w => w.code === 'morpho_authorize')!.severity, 'caution');
  assert.equal((await sign(auth(), '0x')).warnings.find(w => w.code === 'morpho_authorize')!.severity, 'danger');
});

test('A revocation; a used nonce; a passed deadline; another contract', async () => {
  const r = await sign(auth({ isAuthorized: false }));
  assert.equal(r.title, "Revoke 0xb0b0…0002's authorization on Morpho");
  assert.ok(codes(r).includes('morpho_unchanged'));
  assert.ok(!codes(r).includes('morpho_authorize'));
  assert.ok(codes(await sign(auth({ nonce: '2' }))).includes('morpho_nonce'));
  assert.ok(codes(await sign(auth({ deadline: String(NOW / 1000 - 1) }))).includes('morpho_expired'));
  assert.ok(codes(await sign(auth({}, '0x2222222222222222222222222222222222222222'))).includes('morpho_contract_unknown'));
});

test('Fourth review: Morpho on another chain, by its domain; non-boolean flags; an EIP-7702 account', async () => {
  const { encodeAbiParameters, keccak256, toHex } = await import('viem');
  const ARB_MORPHO = '0x6c247b1f6182318877311737bac0844baa518f5e';
  const separator = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }], [keccak256(toHex('EIP712Domain(uint256 chainId,address verifyingContract)')), 42161n, ARB_MORPHO]));
  const d: Dependencies = { rpc: { has: () => true, call: async (_c: number, method: string, params: unknown[]) => {
    if (method === 'eth_getCode') return `0xef0100${'1'.repeat(40)}`;
    const { data } = params[0] as { data: string };
    if (data === '0x3644e515') return separator;
    return data.startsWith('0x70ae92d2') ? `0x${word(3n)}` : `0x${word(0n)}`;
  } } };
  const arb = { ...auth(), domain: { chainId: 42161, verifyingContract: ARB_MORPHO } };
  const p = await previewRequest({ method: 'eth_signTypedData_v4', params: [ALICE, JSON.stringify(arb)] }, { now: NOW, chainId: 42161 }, d);
  assert.ok(!codes(p).includes('morpho_contract_unknown'));
  // An EIP-7702 account is a key, not a contract: a danger.
  assert.equal(p.warnings.find(w => w.code === 'morpho_authorize')!.severity, 'danger');
  // "false" as a string is signed as true by ethers: read as a grant, with a caution.
  const odd = await sign({ ...auth(), message: { ...auth().message, isAuthorized: 'false' } });
  assert.match(odd.title, /^Authorize/);
  assert.ok(codes(odd).includes('morpho_bool'));
});
