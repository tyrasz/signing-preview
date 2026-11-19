// ERC-721 permits (Uniswap V3 positions): approval of one NFT, read as such, not as a token permit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previewRequest } from '../src/preview.ts';
import type { Dependencies } from '../src/types.ts';
import { ALICE, BOB } from '../mocks/data.ts';
import { codes, detail, NOW } from './helpers.ts';

const POSITIONS = '0xc36442b4a4522e871399cd717abdd847ab11fe88';
const deps = (owner: string): Dependencies => ({ rpc: { has: () => true, call: async (_c: number, _m: string, params: unknown[]) => {
  const { data } = params[0] as { data: string };
  return data.startsWith('0x6352211e') ? `0x${owner.slice(2).padStart(64, '0')}` : `0x${'0'.repeat(64)}`;
} } });
const permit = { domain: { name: 'Uniswap V3 Positions NFT-V1', version: '1', chainId: 1, verifyingContract: POSITIONS }, primaryType: 'Permit',
  types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }], Permit: [{ name: 'spender', type: 'address' }, { name: 'tokenId', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
  message: { spender: BOB, tokenId: '12345', nonce: '0', deadline: String(NOW / 1000 + 3600) } };
const sign = (owner: string) => previewRequest({ method: 'eth_signTypedData_v4', params: [ALICE, JSON.stringify(permit)] }, { now: NOW, chainId: 1 }, deps(owner));

test("An ERC-721 permit: one NFT, a caution; its owner read; no token permit's owner mismatch", async () => {
  const p = await sign(ALICE);
  assert.equal(p.decoding.decoder, 'erc721_permit');
  assert.equal(p.title, 'Allow 0xb0b0…0002 to transfer Uniswap V3 Positions NFT-V1 #12345');
  assert.equal(p.warnings.find(w => w.code === 'nft_permit')!.severity, 'caution');
  assert.match(p.warnings.find(w => w.code === 'nft_permit')!.message, /all the liquidity and fees in it/);
  assert.ok(!codes(p).includes('permit_owner_mismatch'));
  assert.equal(detail(p, 'Owner'), ALICE.toLowerCase());
  assert.ok(codes(await sign(BOB)).includes('nft_permit_not_owner'));
});
