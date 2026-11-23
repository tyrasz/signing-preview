// Requests a validator's withdrawal address makes of the consensus layer: withdrawals and exits (EIP-7002) and
// consolidations (EIP-7251), through Ethereum's two system contracts. Their calldata is packed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHex, type Hex } from 'viem';
import { previewRequest } from '../src/preview.ts';
import type { Dependencies } from '../src/types.ts';
import { codes, detail, NOW } from './helpers.ts';

const WITHDRAWALS = '0x00000961ef480eb55e80d19ad83579a64c007002', CONSOLIDATIONS = '0x0000bbddc7ce488642fb579f8b00f3a590007251';
// Mined on Ethereum, 2026-11-23: a partial withdrawal (block 26476771, from the validator's withdrawal address, with
// the 1 wei fee), and a consolidation request (block 26472045) whose source and target are the same validator.
const MINED_WITHDRAWAL = { from: '0x141f2b019635826ed3cef33054d3dfd448f84473', data: '0x996987c7265030ab988958616f36038594a0ea3f6fb6f371a47437dd12f4916c5f27599044013f25692c286fa10493c600000000005dee09' as Hex };
const KEY = '0xa894a59b8751c4192de79619c63302a709a435182672ba4584ccb7bf95a8dd399488fe800cb54b3d520a5b2e97ce5100', OTHER = `0x${'b5'.repeat(48)}`;
const MINED_SWITCH = { from: '0x3f970e328f8eb9326ba012e7156c068555cab7fe', data: `${KEY}${KEY.slice(2)}` as Hex };
const chain = (fee: bigint): Dependencies => ({ rpc: { has: () => true, call: async (_c: number, m: string, p: unknown[]) => (m === 'eth_call' && (p[0] as { data: string }).data === '0x' ? toHex(fee, { size: 32 }) : '0x') } });
const send = (to: string, from: string, data: Hex, value: bigint, d: Dependencies = {}, chainId = '0x1') => previewRequest({ method: 'eth_sendTransaction', params: [{ from, to, data, value: toHex(value), chainId }] }, { now: NOW }, d);

test('A validator withdrawal request: the validator, the amount, and that only its withdrawal address counts', async () => {
  // They were calls that couldn't be decoded (the calldata is packed: a 48-byte key and an 8-byte amount in gwei).
  const p = await send(WITHDRAWALS, MINED_WITHDRAWAL.from, MINED_WITHDRAWAL.data, 1n, chain(1n));
  assert.equal(p.title, 'Request a withdrawal of 0.006155785 ETH from validator 0x996987c7…0493c6');
  assert.deepEqual([p.decoding.decoder, p.decoding.status, p.attention], ['validator_request', 'full', 'none']);
  assert.equal(detail(p, 'Validator public key'), MINED_WITHDRAWAL.data.slice(0, 98));
  assert.equal(detail(p, 'Fee sent'), '1 wei (the fee is 1 wei now)');
  assert.match(p.decoding.notes.join(' '), /acts on it only if 0x141f…4473 is the validator's withdrawal address/);
  // An amount of zero is a full exit.
  const exit = await send(WITHDRAWALS, MINED_WITHDRAWAL.from, `${MINED_WITHDRAWAL.data.slice(0, 98)}${'00'.repeat(8)}` as Hex, 1n, chain(1n));
  assert.deepEqual([exit.title, exit.attention, codes(exit).includes('validator_exit')], ['Request the exit of validator 0x996987c7…0493c6', 'caution', true]);
  // The fee: less than it reverts (none at all always does); far more than it is kept, not returned.
  assert.equal((await send(WITHDRAWALS, MINED_WITHDRAWAL.from, MINED_WITHDRAWAL.data, 5n, chain(9n))).warnings.find(w => w.code === 'validator_request_fee')?.severity, 'danger');
  assert.match((await send(WITHDRAWALS, MINED_WITHDRAWAL.from, MINED_WITHDRAWAL.data, 0n)).warnings.find(w => w.code === 'validator_request_fee')?.message ?? '', /the fee is never less than 1 wei: the contract reverts/);
  assert.match((await send(WITHDRAWALS, MINED_WITHDRAWAL.from, MINED_WITHDRAWAL.data, 10n ** 17n, chain(1n))).warnings.find(w => w.code === 'validator_request_overpays')?.message ?? '', /sends 0\.1 ETH with the request, where the fee is 1 wei now: the contract keeps all of it/);
  // Calldata of another length reverts; none, with no coin, reads the fee.
  assert.equal((await send(WITHDRAWALS, MINED_WITHDRAWAL.from, `${MINED_WITHDRAWAL.data}00` as Hex, 1n)).warnings.find(w => w.code === 'validator_request_malformed')?.severity, 'danger');
  assert.equal((await send(WITHDRAWALS, MINED_WITHDRAWAL.from, '0x', 0n)).title, 'Read the validator withdrawal request fee');
  // On another chain the address is whatever it is there.
  assert.notEqual((await send(WITHDRAWALS, MINED_WITHDRAWAL.from, MINED_WITHDRAWAL.data, 1n, {}, '0x2105')).decoding.decoder, 'validator_request');
});

test('A consolidation request: one validator’s whole stake moved into another, whose withdrawal address then holds it', async () => {
  // The consensus layer checks the sender against the source validator's withdrawal address, not the target's:
  // consolidating into a validator that isn't yours hands it the stake.
  const p = await send(CONSOLIDATIONS, MINED_SWITCH.from, `${KEY}${OTHER.slice(2)}` as Hex, 1n, chain(1n));
  assert.deepEqual([p.title, p.attention, p.decoding.status], ['Consolidate validator 0xa894a59b…ce5100 into 0xb5b5b5b5…b5b5b5', 'danger', 'full']);
  assert.match(p.warnings.find(w => w.code === 'validator_consolidation')?.message ?? '', /the stake is paid out to the target validator's withdrawal address: the consensus layer checks that 0x3f97…b7fe is the source's withdrawal address, and not that the target's is the same/);
  assert.deepEqual([detail(p, 'Source validator'), detail(p, 'Target validator')], [KEY, OTHER]);
  // The same validator twice (as mined) switches it to compounding credentials: nothing moves.
  const same = await send(CONSOLIDATIONS, MINED_SWITCH.from, MINED_SWITCH.data, 1n, chain(1n));
  assert.deepEqual([same.title, same.attention, codes(same).includes('validator_compounding'), codes(same).includes('validator_consolidation')], ['Switch validator 0xa894a59b…ce5100 to compounding', 'info', true, false]);
  // From a Safe (three of the four consolidations mined in 6,000 blocks were a Safe's): the same reading, as the Safe's call.
  const SAFE = '0x79b7d06027dd88788f8de94eae7179ebda82581d';
  const typed = { domain: { chainId: 1, verifyingContract: SAFE }, types: { EIP712Domain: [{ name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
    SafeTx: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }, { name: 'operation', type: 'uint8' }, { name: 'safeTxGas', type: 'uint256' }, { name: 'baseGas', type: 'uint256' }, { name: 'gasPrice', type: 'uint256' }, { name: 'gasToken', type: 'address' }, { name: 'refundReceiver', type: 'address' }, { name: 'nonce', type: 'uint256' }] },
    primaryType: 'SafeTx', message: { to: CONSOLIDATIONS, value: '1', data: `${KEY}${OTHER.slice(2)}`, operation: 0, safeTxGas: '0', baseGas: '0', gasPrice: '0', gasToken: `0x${'00'.repeat(20)}`, refundReceiver: `0x${'00'.repeat(20)}`, nonce: '5' } };
  const viaSafe = await previewRequest({ method: 'eth_signTypedData_v4', params: [MINED_SWITCH.from, JSON.stringify(typed)] }, { now: NOW }, {});
  assert.deepEqual([viaSafe.title, viaSafe.attention, codes(viaSafe).includes('validator_consolidation')], ['Safe transaction: Consolidate validator 0xa894a59b…ce5100 into 0xb5b5b5b5…b5b5b5', 'danger', true]);
});
