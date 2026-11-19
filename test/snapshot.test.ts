// Snapshot messages: votes and the like are shown as what they are; an alias, which acts for the account, is a caution.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previewRequest } from '../src/preview.ts';
import { ALICE, BOB } from '../mocks/data.ts';
import { codes, detail, NOW } from './helpers.ts';

const DOMAIN = { name: 'snapshot', version: '0.1.4' };
const EIP712 = [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }];
const fields = (spec: string) => spec.split(',').map(s => ({ type: s.split(' ')[0], name: s.split(' ')[1] }));
const sign = (data: unknown) => previewRequest({ method: 'eth_signTypedData_v4', params: [ALICE, JSON.stringify(data)] }, { now: NOW }, {});

test('A vote: its space, proposal and choice, no warning', async () => {
  const p = await sign({ domain: DOMAIN, primaryType: 'Vote', types: { EIP712Domain: EIP712, Vote: fields('address from,string space,uint64 timestamp,bytes32 proposal,uint32 choice,string reason,string app,string metadata') },
    message: { from: ALICE, space: 'aave.eth', timestamp: NOW / 1000, proposal: `0x${'ab'.repeat(32)}`, choice: 1, reason: 'yes', app: 'snapshot', metadata: '{}' } });
  assert.equal(p.decoding.decoder, 'snapshot');
  assert.equal(p.title, 'Vote on a Snapshot proposal in aave.eth');
  assert.equal(detail(p, 'Choice'), '1');
  assert.equal(p.attention, 'none');
});

test('An alias acts for the account: a caution; a look-alike with a verifyingContract is not Snapshot', async () => {
  const alias = { domain: DOMAIN, primaryType: 'Alias', types: { EIP712Domain: EIP712, Alias: fields('address from,address alias,uint64 timestamp') }, message: { from: ALICE, alias: BOB, timestamp: NOW / 1000 } };
  const p = await sign(alias);
  assert.equal(p.title, 'Let 0xb0b0…0002 act as you on Snapshot');
  assert.equal(p.warnings.find(w => w.code === 'snapshot_alias')!.severity, 'caution');
  const fake = await sign({ ...alias, domain: { ...DOMAIN, verifyingContract: '0x2222222222222222222222222222222222222222' }, types: { ...alias.types, EIP712Domain: [...EIP712, { name: 'verifyingContract', type: 'address' }] } });
  assert.notEqual(fake.decoding.decoder, 'snapshot');
  assert.ok(!codes(fake).includes('snapshot_alias'));
});
