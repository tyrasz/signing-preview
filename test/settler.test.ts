// 0x's gasless swaps: a Permit2 transfer whose witness binds the recipient, the token bought and the least the swap gives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previewRequest } from '../src/preview.ts';
import { StaticTokenRegistry } from '../src/chains.ts';
import type { Dependencies } from '../src/types.ts';
import { ALICE, BOB } from '../mocks/data.ts';
import { codes, detail, NOW } from './helpers.ts';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const META = '0x9a6350d532ed83a970d452b736be5847b2856768', INTENT = '0xbfa23e39ebcb074696414fdd75ed2c9effbde688';
const word = (a: string) => `0x${a.slice(2).padStart(64, '0')}`;
/** The deployer names META for feature 3 and INTENT for 4. */
const deps = (rpc = true): Dependencies => ({ tokens: new StaticTokenRegistry(), ...(rpc && { rpc: { has: () => true, call: async (_c: number, method: string, params: unknown[]) => {
  if (method !== 'eth_call') throw new Error('unused');
  const { data } = params[0] as { data: string };
  if (data.startsWith('0x6352211e')) return word(data.endsWith('3') ? META : INTENT);
  if (data.startsWith('0xe2603dc2')) return word('0x0000000000000000000000000000000000000001');
  return `0x${'0'.repeat(64)}`;
} } }) });
const TOKEN = [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }];
const swap = (o: { kind?: 'meta' | 'intent'; recipient?: string; min?: string; spender?: string } = {}) => {
  const meta = (o.kind ?? 'meta') === 'meta';
  const field = meta ? { name: 'slippageAndActions', type: 'SlippageAndActions' } : { name: 'slippage', type: 'Slippage' };
  const w = { recipient: o.recipient ?? ALICE, buyToken: WETH, minAmountOut: o.min ?? '2000000000000000', ...(meta && { actions: ['0x0dfeb419', '0x1234'] }) };
  return { domain: { name: 'Permit2', chainId: 1, verifyingContract: '0x000000000022d473030f116ddee9f6b43ac78ba3' }, primaryType: 'PermitWitnessTransferFrom',
    types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }], TokenPermissions: TOKEN,
      PermitWitnessTransferFrom: [{ name: 'permitted', type: 'TokenPermissions' }, { name: 'spender', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, field],
      ...(meta ? { SlippageAndActions: [{ name: 'recipient', type: 'address' }, { name: 'buyToken', type: 'address' }, { name: 'minAmountOut', type: 'uint256' }, { name: 'actions', type: 'bytes[]' }] } : { Slippage: [{ name: 'recipient', type: 'address' }, { name: 'buyToken', type: 'address' }, { name: 'minAmountOut', type: 'uint256' }] }) },
    message: { permitted: { token: USDC, amount: '6000000' }, spender: o.spender ?? (meta ? META : INTENT), nonce: '9', deadline: String(NOW / 1000 + 600), [field.name]: w } };
};
const sign = (data: unknown, d = deps()) => previewRequest({ method: 'eth_signTypedData_v4', params: [ALICE, JSON.stringify(data)] }, { now: NOW, chainId: 1 }, d);

test('A gasless 0x swap: what is sold, the least it gives and to whom', async () => {
  const p = await sign(swap());
  assert.equal(p.decoding.decoder, 'settler_swap');
  assert.equal(p.title, '0x: swap 6 USDC for at least 0.002 WETH');
  assert.equal(detail(p, 'Sent to'), `you (${ALICE})`);
  assert.deepEqual(codes(p).filter(c => c.startsWith('settler')), []);
  assert.equal((await sign(swap({ kind: 'intent' }))).decoding.decoder, 'settler_swap');
});

test("Another recipient, no minimum, a spender that isn't 0x's Settler, no RPC", async () => {
  const other = await sign(swap({ recipient: BOB }));
  assert.equal(other.title, '0x: swap 6 USDC for at least 0.002 WETH, to 0xb0b0…0002');
  assert.ok(codes(other).includes('settler_recipient_other'));
  assert.ok(codes(await sign(swap({ min: '0' }))).includes('settler_no_minimum'));
  assert.equal((await sign(swap({ spender: '0x1234567890123456789012345678901234567890' }))).warnings.find(w => w.code === 'settler_unknown')?.severity, 'danger');
  assert.ok(codes(await sign(swap(), deps(false))).includes('settler_unchecked'));
});
