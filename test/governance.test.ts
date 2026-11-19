// Governance signatures: vote delegation and votes by signature, which move no funds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previewRequest } from '../src/preview.ts';
import type { Dependencies } from '../src/types.ts';
import { ALICE, BOB } from '../mocks/data.ts';
import { codes, detail, NOW } from './helpers.ts';

const UNI = '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984';
const ED = [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }];
const deps: Dependencies = { rpc: { has: () => true, call: async () => `0x${'0'.repeat(64)}` } };
const sign = (data: unknown) => previewRequest({ method: 'eth_signTypedData_v4', params: [ALICE, JSON.stringify(data)] }, { now: NOW, chainId: 1 }, deps);

test('delegateBySig: whose votes go where, no funds moved', async () => {
  const p = await sign({ domain: { name: 'Uniswap', chainId: 1, verifyingContract: UNI }, primaryType: 'Delegation', types: { EIP712Domain: ED, Delegation: [{ name: 'delegatee', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'expiry', type: 'uint256' }] }, message: { delegatee: BOB, nonce: 0, expiry: NOW / 1000 + 3600 } });
  assert.equal(p.decoding.decoder, 'governance_delegation');
  assert.equal(p.title, 'Delegate your Uniswap votes to 0xb0b0…0002');
  assert.equal(detail(p, 'Current delegate'), 'none');
  assert.equal(p.attention, 'info');
  assert.ok(!codes(p).includes('unknown_typed_data'));
});

test('castVoteBySig: the proposal and the vote; a voter other than the signer', async () => {
  const p = await sign({ domain: { name: 'Uniswap Governor', chainId: 1, verifyingContract: '0x408ed6354d4973f66138c91495f2f2fcbd8724c3' }, primaryType: 'Ballot', types: { EIP712Domain: ED, Ballot: [{ name: 'proposalId', type: 'uint256' }, { name: 'support', type: 'uint8' }] }, message: { proposalId: 42, support: 1 } });
  assert.equal(p.title, 'Vote for on proposal 42 in Uniswap Governor');
  assert.equal(p.attention, 'none');
  const oz = await sign({ domain: { name: 'ENS Governor', chainId: 1, verifyingContract: '0x323a76393544d5ecca80cd6ef2a560c6a395b7e3' }, primaryType: 'Ballot', types: { EIP712Domain: ED, Ballot: [{ name: 'proposalId', type: 'uint256' }, { name: 'support', type: 'uint8' }, { name: 'voter', type: 'address' }, { name: 'nonce', type: 'uint256' }] }, message: { proposalId: 7, support: 0, voter: BOB, nonce: 0 } });
  assert.match(oz.title, /^Vote against on proposal 7/);
  assert.ok(codes(oz).includes('governance_other_voter'));
});

test('Fifth review: a token whose domain has no name is named by its address', async () => {
  const OTHER = '0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a';
  const p = await sign({ domain: { chainId: 1, verifyingContract: OTHER }, primaryType: 'Delegation', types: { EIP712Domain: [{ name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }], Delegation: [{ name: 'delegatee', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'expiry', type: 'uint256' }] }, message: { delegatee: BOB, nonce: '0', expiry: String(NOW / 1000 + 3600) } });
  assert.equal(p.title, 'Delegate your 0x5a5a…5a5a votes to 0xb0b0…0002');
});
