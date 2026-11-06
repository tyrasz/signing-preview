// Ethereum's staking deposit contract: the validator, who can withdraw, and the contract's own checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeFunctionData, encodeFunctionData, parseAbi, toHex, type Hex } from 'viem';
import { previewRequest } from '../src/preview.ts';
import { depositDataRoot } from '../src/evm/beacon-deposit.ts';
import { BOB } from '../mocks/data.ts';
import { codes, detail, NOW } from './helpers.ts';

const DEPOSIT = '0x00000000219ab540356cbb839cbe05303d7705fa';
const ABI = parseAbi(['function deposit(bytes pubkey, bytes withdrawal_credentials, bytes signature, bytes32 deposit_data_root) payable']);
const real = JSON.parse(readFileSync(new URL('./fixtures/beacon-deposit.json', import.meta.url), 'utf8'));
const send = (from: string, data: Hex, value: bigint) => previewRequest({ method: 'eth_sendTransaction', params: [{ from, to: DEPOSIT, data, value: toHex(value), chainId: '0x1' }] }, { now: NOW }, {});

test('A real 32 ETH deposit: the validator, withdrawals to the sender, and the deposit data root the contract checks', async () => {
  const p = await send(real.from, real.input, BigInt(real.value));
  assert.match(p.title, /^Stake 32 ETH for validator 0x[0-9a-f]{8}…[0-9a-f]{4}$/);
  assert.equal(p.decoding.decoder, 'beacon_deposit');
  assert.match(detail(p, 'Withdrawals go to')!, /^you \(0x[0-9a-f]{40}\), execution address \(0x01\)$/);
  assert.equal(detail(p, 'Deposit data root'), 'matches the deposit (as the contract checks)');
  assert.equal(p.attention, 'none');
});

test('Deposits the contract rejects are danger; credentials naming someone else, or a BLS key, are a caution', async () => {
  const [pubkey, , signature] = decodeFunctionData({ abi: ABI, data: real.input }).args;
  const make = (credentials: Hex, value: bigint, root?: Hex) => encodeFunctionData({ abi: ABI, functionName: 'deposit', args: [pubkey, credentials, signature, root ?? depositDataRoot(pubkey, credentials, signature, value / 10n ** 9n)] });
  const toBob = `0x01${'00'.repeat(11)}${BOB.slice(2)}` as Hex;
  const other = await send(real.from, make(toBob, 32n * 10n ** 18n), 32n * 10n ** 18n);
  assert.equal(other.attention, 'caution');
  assert.match(other.warnings.find(w => w.code === 'staking_withdrawal_other')!.message, /not to you, and that can't be changed later/);
  assert.ok(codes(await send(real.from, make(`0x00${'ab'.repeat(31)}`, 32n * 10n ** 18n), 32n * 10n ** 18n)).includes('staking_bls_credentials'));
  // The root covers the amount: the same deposit data with a different value is rejected.
  const wrong = await send(real.from, make(toBob, 32n * 10n ** 18n), 31n * 10n ** 18n);
  assert.equal(wrong.attention, 'danger');
  assert.ok(codes(wrong).includes('deposit_root_mismatch'));
  assert.ok(codes(await send(real.from, make(toBob, 10n ** 17n), 10n ** 17n)).includes('deposit_invalid'));
});
