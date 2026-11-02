import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { l1ActionHash } from '../src/hyperliquid/action-hash.ts';
import { previewRequest } from '../src/preview.ts';
import { ALICE, BOB } from '../mocks/data.ts';
import { codes, detail, mockDeps, NOW, sample } from './helpers.ts';

test('L1 action hashes match vectors produced by the official hyperliquid-python-sdk 0.24.0', () => {
  const vectors = JSON.parse(readFileSync(new URL('./fixtures/l1-action-hashes.json', import.meta.url), 'utf8'));
  assert.equal(vectors.length, 4);
  for (const v of vectors) assert.equal(l1ActionHash(v.action, v.nonce, v.vaultAddress, v.expiresAfter), v.hash);
});

test('Withdraw shows the Arbitrum recipient and the net amount after the 1 USDC fee', async () => {
  const p = await sample('hl-withdraw');
  assert.equal(p.network?.kind, 'hypercore');
  assert.equal(p.title, 'Withdraw 50 USDC to Arbitrum');
  assert.equal(detail(p, 'You receive on Arbitrum (approx.)'), '49 USDC');
  assert.ok(!codes(p).includes('withdraw_to_other'));
  const other = await sample('hl-withdraw-other');
  assert.ok(codes(other).includes('withdraw_to_other'));
});

test('USD and spot sends, including spot → HyperEVM via system address', async () => {
  const usd = await sample('hl-usd-send');
  assert.equal(usd.title, 'Send 25 USDC on Hyperliquid');
  assert.equal(usd.attention, 'none');
  const spot = await sample('hl-spot-send');
  assert.equal(spot.title, 'Send 10,000 PURR on Hyperliquid');
  const toEvm = await sample('hl-spot-to-evm');
  assert.equal(toEvm.title, 'Move 12.5 HYPE to HyperEVM');
});

test('Spot send whose token label does not match its token ID is dangerous', async () => {
  const s = (await import('../mocks/data.ts')).buildSamples(NOW).find(x => x.id === 'hl-spot-send')!;
  const data = JSON.parse((s.request.params as string[])[1]);
  data.message.token = 'USDC:0xc1fb593aeffbeb02f85e0308e9956a90'; // PURR's ID, labelled USDC
  const p = await previewRequest({ method: 'eth_signTypedData_v4', params: [ALICE, JSON.stringify(data)] }, { now: NOW }, mockDeps());
  assert.ok(codes(p).includes('spot_token_name_mismatch'));
  assert.equal(p.attention, 'danger');
});

test('Stale timestamps are flagged as likely rejected', async () => {
  const p = await sample('hl-stale-send');
  assert.ok(codes(p).includes('nonce_too_old'));
});

test('Agent and builder-fee approvals explain the authority granted', async () => {
  const agent = await sample('hl-approve-agent', { origin: 'https://example.app' });
  assert.equal(agent.attention, 'caution');
  assert.match(agent.warnings.find(w => w.code === 'approve_agent')!.message, /requested by https:\/\/example\.app/);
  const fee = await sample('hl-builder-fee');
  assert.equal(detail(fee, 'Maximum fee rate'), '0.1%');
});

test('Look-alike domains are rejected as imitations', async () => {
  const s = (await import('../mocks/data.ts')).buildSamples(NOW).find(x => x.id === 'hl-usd-send')!;
  const data = JSON.parse((s.request.params as string[])[1]);
  data.domain.verifyingContract = BOB;
  const p = await previewRequest({ method: 'eth_signTypedData_v4', params: [ALICE, JSON.stringify(data)] }, { now: NOW }, mockDeps());
  assert.ok(codes(p).includes('hl_domain_mismatch'));
});

test('L1 order with a verified pre-image is fully decoded with market context', async () => {
  const p = await sample('hl-order');
  assert.equal(p.title, 'Long 0.01 BTC-PERP @ 97,500');
  assert.equal(p.decoding.status, 'full');
  assert.equal(detail(p, 'Current mid price'), '98,000');
  assert.equal(detail(p, 'Notional (approx.)'), '$975.00');
  assert.ok(p.decoding.notes.some(n => n.includes('verified')));
});

test('L1 trigger order shows stop-loss semantics and the builder fee', async () => {
  const p = await sample('hl-stop-loss');
  assert.equal(p.title, 'Stop loss: Short (reduce-only) 0.5 ETH-PERP at market when price reaches 3,150');
  assert.equal(detail(p, 'Builder fee'), '1 bp (0.01%)');
});

test('L1 leverage above the market maximum is dangerous', async () => {
  const p = await sample('hl-leverage');
  assert.ok(codes(p).includes('leverage_above_max'));
});

test('L1 action without a pre-image is opaque; a mismatched pre-image is dangerous', async () => {
  const opaque = await sample('hl-order-opaque');
  assert.equal(opaque.decoding.status, 'opaque');
  assert.ok(codes(opaque).includes('l1_opaque'));
  const mismatch = await sample('hl-order-mismatch');
  assert.equal(mismatch.attention, 'danger');
  assert.ok(codes(mismatch).includes('l1_hash_mismatch'));
});

test('Marketable limit far through the mid is flagged; margin is checked against account state', async () => {
  const action = { type: 'order', orders: [{ a: 1, b: true, p: '3900', s: '20', r: false, t: { limit: { tif: 'Ioc' } } }], grouping: 'na' };
  const nonce = NOW - 1000;
  const typed = {
    domain: { name: 'Exchange', version: '1', chainId: 1337, verifyingContract: '0x0000000000000000000000000000000000000000' },
    types: { Agent: [{ name: 'source', type: 'string' }, { name: 'connectionId', type: 'bytes32' }] },
    primaryType: 'Agent', message: { source: 'a', connectionId: l1ActionHash(action, nonce) },
  };
  const p = await previewRequest({ method: 'eth_signTypedData_v4', params: [ALICE, typed] }, { now: NOW, hyperliquid: { action, nonce } }, mockDeps());
  assert.ok(codes(p).includes('price_far_through_market'));
  // 20 ETH × 3900 at the existing 10× position leverage needs ~$7,800 against $3,200 available.
  assert.ok(codes(p).includes('insufficient_margin'));
  assert.equal(detail(p, 'Margin required (approx.)'), '$7,800.00');
});
