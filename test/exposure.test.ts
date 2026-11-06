// What a gasless signature can move if used now: the permitted amount, capped by the balance and by the ERC-20
// allowance the pulling contract relies on (Permit2, CoW's vault relayer); and whether its nonce is still usable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previewRequest } from '../src/preview.ts';
import { PERMIT2, StaticTokenRegistry } from '../src/chains.ts';
import type { Dependencies } from '../src/types.ts';
import { ALICE, BOB } from '../mocks/data.ts';
import { codes, detail, NOW } from './helpers.ts';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', RELAYER = '0xc92e8bdf79f0507f65a392b0ab4667716bfe0110';
const MAX = (1n << 256n) - 1n, word = (v: bigint) => v.toString(16).padStart(64, '0');
/** 5,000 USDC; Permit2 approved for `permit2Allowance`, CoW's relayer for everything; EIP-2612 nonce 5; Permit2 nonce 2; one-time nonce 7 used. */
const deps = (permit2Allowance: bigint): Dependencies => ({ tokens: new StaticTokenRegistry(), rpc: { has: () => true, call: async (_c: number, _m: string, params: unknown[]) => {
  const { data } = params[0] as { to: string; data: string };
  const sel = data.slice(0, 10);
  if (sel === '0x70a08231') return `0x${word(5_000_000_000n)}`;
  if (sel === '0xdd62ed3e') return `0x${word(data.slice(-40) === PERMIT2.slice(2).toLowerCase() ? permit2Allowance : data.slice(-40) === RELAYER.slice(2) ? MAX : 0n)}`;
  if (sel === '0x7ecebe00') return `0x${word(5n)}`;
  if (sel === '0x927da105') return `0x${word(0n)}${word(0n)}${word(2n)}`;
  if (sel === '0x4fe02b44') return `0x${word(1n << 7n)}`;
  return '0x';
} } });
const sign = (data: unknown, d: Dependencies) => previewRequest({ method: 'eth_signTypedData_v4', params: [ALICE, JSON.stringify(data)] }, { now: NOW }, d);
const permit = (value: bigint, nonce: number) => ({
  domain: { name: 'USD Coin', version: '2', chainId: 1, verifyingContract: USDC },
  types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }], Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
  primaryType: 'Permit', message: { owner: ALICE, spender: BOB, value: value.toString(), nonce, deadline: String(NOW / 1000 + 3600) },
});
const permit2 = (primaryType: 'PermitSingle' | 'PermitTransferFrom', nonce: number) => ({
  domain: { name: 'Permit2', chainId: 1, verifyingContract: PERMIT2 },
  types: primaryType === 'PermitSingle'
    ? { PermitSingle: [{ name: 'details', type: 'PermitDetails' }, { name: 'spender', type: 'address' }, { name: 'sigDeadline', type: 'uint256' }], PermitDetails: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }] }
    : { PermitTransferFrom: [{ name: 'permitted', type: 'TokenPermissions' }, { name: 'spender', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }], TokenPermissions: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }] },
  primaryType,
  message: primaryType === 'PermitSingle'
    ? { details: { token: USDC, amount: ((1n << 160n) - 1n).toString(), expiration: String(NOW / 1000 + 3600), nonce }, spender: BOB, sigDeadline: String(NOW / 1000 + 3600) }
    : { permitted: { token: USDC, amount: '1000000000' }, spender: BOB, nonce, deadline: String(NOW / 1000 + 3600) },
});

test('EIP-2612 permits: the whole balance for an unlimited one, the permitted amount otherwise; a stale nonce', async () => {
  assert.equal(detail(await sign(permit(MAX, 5), deps(0n)), 'Can move now'), '5,000 USDC (your whole balance, and any you receive while the permission lasts)');
  assert.equal(detail(await sign(permit(100_000_000n, 5), deps(0n)), 'Can move now'), '100 USDC (the permitted amount; you hold 5,000 USDC)');
  assert.ok(codes(await sign(permit(1n, 3), deps(0n))).includes('signature_nonce_used'));
  assert.ok(!codes(await sign(permit(1n, 5), deps(0n))).some(c => c.startsWith('signature_nonce')));
});

test('Permit2: capped by the ERC-20 allowance Permit2 has; nothing yet without one; used nonces', async () => {
  assert.equal(detail(await sign(permit2('PermitSingle', 2), deps(300_000_000n)), 'Can move now'), '300 USDC (what Permit2 is approved for; you hold 5,000 USDC)');
  assert.match(detail(await sign(permit2('PermitSingle', 2), deps(0n)), 'Can move now')!, /^nothing yet: Permit2 has no allowance for your USDC/);
  assert.ok(codes(await sign(permit2('PermitSingle', 1), deps(MAX))).includes('signature_nonce_used'));
  assert.ok(codes(await sign(permit2('PermitTransferFrom', 7), deps(MAX))).includes('signature_nonce_used'));
  assert.equal(detail(await sign(permit2('PermitTransferFrom', 8), deps(MAX)), 'Can move now'), '1,000 USDC (the permitted amount; you hold 5,000 USDC)');
});

test('A CoW order: what the vault relayer can pull for it now', async () => {
  const order = { domain: { name: 'Gnosis Protocol', version: 'v2', chainId: 1, verifyingContract: '0x9008d19f58aabd9ed0d60971565aa8510560ab41' },
    types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }], Order: ['sellToken:address', 'buyToken:address', 'receiver:address', 'sellAmount:uint256', 'buyAmount:uint256', 'validTo:uint32', 'appData:bytes32', 'feeAmount:uint256', 'kind:string', 'partiallyFillable:bool', 'sellTokenBalance:string', 'buyTokenBalance:string'].map(s => ({ name: s.split(':')[0], type: s.split(':')[1] })) },
    primaryType: 'Order', message: { sellToken: USDC, buyToken: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', receiver: '0x0000000000000000000000000000000000000000', sellAmount: '1000000000', buyAmount: '300000000000000000', validTo: NOW / 1000 + 3600, appData: `0x${'00'.repeat(32)}`, feeAmount: '0', kind: 'sell', partiallyFillable: false, sellTokenBalance: 'erc20', buyTokenBalance: 'erc20' } };
  assert.equal(detail(await sign(order, deps(0n)), 'Can move now'), '1,000 USDC (the permitted amount; you hold 5,000 USDC)');
});
