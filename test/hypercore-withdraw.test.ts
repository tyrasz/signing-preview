// HyperCore -> Arbitrum (and other chains). Circle cases follow "Withdraw USDC from HyperCore to EVM chains" and
// "Withdraw USDC from HyperCore to HyperEVM" (developers.circle.com, 2026-11-03) and CoreDepositWallet @ ffcc978.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionData, pad, parseAbi, type Address } from 'viem';
import { previewRequest } from '../src/preview.ts';
import { ALICE, BOB } from '../mocks/data.ts';
import type { Preview } from '../src/types.ts';
import { codes, detail, mockDeps, NOW } from './helpers.ts';

const ZERO = '0x0000000000000000000000000000000000000000';
const dangers = (p: Preview) => p.warnings.filter(w => w.severity === 'danger').map(w => w.code);

// Verbatim from Circle's guide (types), with its example message values.
const SEND_TO_EVM_TYPES = {
  "HyperliquidTransaction:SendToEvmWithData": [
    { name: "hyperliquidChain", type: "string" },
    { name: "token", type: "string" },
    { name: "amount", type: "string" },
    { name: "sourceDex", type: "string" },
    { name: "destinationRecipient", type: "string" },
    { name: "addressEncoding", type: "string" },
    { name: "destinationChainId", type: "uint32" },
    { name: "gasLimit", type: "uint64" },
    { name: "data", type: "bytes" },
    { name: "nonce", type: "uint64" },
  ],
};

function sendToEvm(overrides: Record<string, unknown> = {}) {
  const message = { hyperliquidChain: 'Mainnet', token: 'USDC', amount: '10', sourceDex: 'spot', destinationRecipient: ALICE, addressEncoding: 'hex', destinationChainId: 3, gasLimit: 200000, data: '0x', nonce: NOW, ...overrides };
  const typed = { domain: { name: 'HyperliquidSignTransaction', version: '1', chainId: 42161, verifyingContract: ZERO }, types: SEND_TO_EVM_TYPES, primaryType: 'HyperliquidTransaction:SendToEvmWithData', message };
  return previewRequest({ method: 'eth_signTypedData_v4', params: [ALICE, JSON.stringify(typed)] }, { now: NOW, account: ALICE }, mockDeps());
}

function userSigned(primary: string, fields: [string, string][], message: Record<string, unknown>) {
  const typed = { domain: { name: 'HyperliquidSignTransaction', version: '1', chainId: 42161, verifyingContract: ZERO },
    types: { [`HyperliquidTransaction:${primary}`]: fields.map(([name, type]) => ({ name, type })) }, primaryType: `HyperliquidTransaction:${primary}`, message: { hyperliquidChain: 'Mainnet', ...message } };
  return previewRequest({ method: 'eth_signTypedData_v4', params: [ALICE, JSON.stringify(typed)] }, { now: NOW, account: ALICE }, mockDeps());
}

test("Circle's HyperCore -> Arbitrum withdrawal (sendToEvmWithData, domain 3, data 0x) is fully decoded", async () => {
  const p = await sendToEvm();
  assert.equal(p.title, 'Withdraw 10 USDC from HyperCore to Arbitrum via Circle CCTP');
  assert.equal(p.decoding.status, 'full');
  assert.equal(detail(p, 'Destination'), 'Arbitrum (CCTP domain 3)');
  assert.equal(detail(p, 'Delivery'), "Automatic (Circle's Forwarding Service)");
  assert.equal(detail(p, 'Fee'), '0.2 USDC forwarding fee');
  assert.equal(detail(p, 'You receive on Arbitrum (expected)'), '9.8 USDC');
  assert.equal(detail(p, 'Withdrawable USDC (spot)'), '1,000');
  assert.deepEqual(codes(p), []);
});

test('Withdrawal fees follow the live CoreDepositWallet fee table per destination', async () => {
  const eth = await sendToEvm({ destinationChainId: 0, amount: '100', sourceDex: '' });
  assert.equal(detail(eth, 'Fee'), '1.2 USDC forwarding fee');
  assert.equal(detail(eth, 'You receive on Ethereum (expected)'), '98.8 USDC');
  const base = await sendToEvm({ destinationChainId: 6, amount: '100', sourceDex: '' });
  assert.equal(detail(base, 'Fee'), '0.2 USDC forwarding fee');
  const sol = await sendToEvm({ destinationChainId: 5, amount: '100', addressEncoding: 'base58', destinationRecipient: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU' });
  assert.equal(detail(sol, 'Fee'), '0.5 USDC forwarding fee');
  assert.ok(!codes(sol).includes('address_encoding_mismatch'));
});

test('Withdrawals that fail on HyperEVM are dangerous', async () => {
  assert.ok(dangers(await sendToEvm({ amount: '0.2' })).includes('withdrawal_below_fee'));
  assert.ok(dangers(await sendToEvm({ destinationChainId: 42161 })).includes('unknown_cctp_domain'), 'an EVM chain ID is not a CCTP domain');
  assert.ok(dangers(await sendToEvm({ destinationChainId: 19 })).includes('unknown_cctp_domain'));
  assert.ok(dangers(await sendToEvm({ data: '0x' + '00'.repeat(1025) })).includes('hook_data_too_large'));
  assert.ok(dangers(await sendToEvm({ destinationRecipient: 'not-an-address' })).includes('bad_destination'));
});

test('Custom data: forwarding magic keeps automatic delivery, anything else is manual and fee-free', async () => {
  const magic = '0x' + '636374702d666f7277617264'.padEnd(48, '0') + 'aabb';
  const withMagic = await sendToEvm({ data: magic });
  assert.equal(detail(withMagic, 'Delivery'), "Automatic (Circle's Forwarding Service)");
  assert.ok(codes(withMagic).includes('custom_hook_data'));
  const manual = await sendToEvm({ data: '0xaabb' });
  assert.match(detail(manual, 'Delivery')!, /^Manual/);
  assert.equal(detail(manual, 'Fee'), '0 USDC (no forwarding)');
  assert.ok(codes(manual).includes('manual_delivery'));
  assert.equal(manual.decoding.status, 'partial');
});

test('Withdrawals are checked against the withdrawable balance', async () => {
  assert.ok(codes(await sendToEvm({ amount: '1100', sourceDex: 'spot' })).includes('insufficient_balance'), '1,000 USDC free in spot');
  assert.ok(!codes(await sendToEvm({ amount: '3000', sourceDex: '' })).includes('insufficient_balance'), '3,200 withdrawable in perps');
  const fields: [string, string][] = [['hyperliquidChain', 'string'], ['destination', 'string'], ['amount', 'string'], ['time', 'uint64']];
  const native = await userSigned('Withdraw', fields, { destination: ALICE, amount: '100', time: NOW });
  assert.equal(native.title, 'Withdraw 100 USDC to Arbitrum');
  assert.equal(detail(native, 'You receive on Arbitrum (approx.)'), '99 USDC');
  assert.match(detail(native, 'Route')!, /Bridge2/);
  assert.ok(codes(await userSigned('Withdraw', fields, { destination: ALICE, amount: '5000', time: NOW })).includes('insufficient_balance'));
});

test("Circle's HyperCore -> HyperEVM withdrawal (SendAsset to the USDC system address)", async () => {
  const fields: [string, string][] = [['hyperliquidChain', 'string'], ['destination', 'string'], ['sourceDex', 'string'], ['destinationDex', 'string'], ['token', 'string'], ['amount', 'string'], ['fromSubAccount', 'string'], ['nonce', 'uint64']];
  const p = await userSigned('SendAsset', fields, { destination: '0x2000000000000000000000000000000000000000', sourceDex: 'spot', destinationDex: 'spot', token: 'USDC', amount: '100', fromSubAccount: '', nonce: NOW });
  assert.equal(p.title, 'Move 100 USDC from HyperCore to HyperEVM');
  assert.equal(detail(p, 'Credited to (HyperEVM)'), ALICE.toLowerCase());
  assert.deepEqual(dangers(p), []);
  const wrong = await userSigned('SendAsset', fields, { destination: '0x2000000000000000000000000000000000000001', sourceDex: 'spot', destinationDex: 'spot', token: 'USDC', amount: '100', fromSubAccount: '', nonce: NOW });
  assert.ok(dangers(wrong).includes('system_address_mismatch'));
  const own = await userSigned('SendAsset', fields, { destination: ALICE, sourceDex: '', destinationDex: 'spot', token: 'USDC', amount: '5', fromSubAccount: '', nonce: NOW });
  assert.equal(own.title, 'Move 5 USDC from perps (main DEX) to spot');
});

test('Native HYPE has no EVM contract link, and only HYPE may use its system address', async () => {
  const fields: [string, string][] = [['hyperliquidChain', 'string'], ['destination', 'string'], ['token', 'string'], ['amount', 'string'], ['time', 'uint64']];
  const hype = await userSigned('SpotSend', fields, { destination: '0x2222222222222222222222222222222222222222', token: 'HYPE:0x0d01dc56dcaaca66ad901c959b4011ec', amount: '1', time: NOW });
  assert.deepEqual(dangers(hype), [], 'live spotMeta has evmContract: null for HYPE');
  const purr = await userSigned('SpotSend', fields, { destination: '0x2222222222222222222222222222222222222222', token: 'PURR:0xc1fb593aeffbeb02f85e0308e9956a90', amount: '1', time: NOW });
  assert.ok(dangers(purr).includes('system_address_mismatch'));
});

test('HyperEVM -> Arbitrum: a CCTP burn on HyperEVM is recognised', async () => {
  const abi = parseAbi(['function depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)']);
  const data = encodeFunctionData({ abi, functionName: 'depositForBurn', args: [100_000_000n, 3, pad(ALICE as Address), '0xb88339CB7199b77E23DB6E890353E22632Ba630f', pad(ZERO), 10_000n, 2000] });
  const p = await previewRequest({ method: 'eth_sendTransaction', params: [{ from: ALICE, to: '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d', chainId: '0x3e7', data }] }, { now: NOW, account: ALICE }, mockDeps());
  assert.equal(p.title, 'Bridge 100 USDC to Arbitrum');
  assert.ok(!codes(p).includes('cctp_unknown_network'));
  assert.match(detail(p, 'Delivery')!, /^Manual: someone must submit the mint on Arbitrum/);
  const toOther = await previewRequest({ method: 'eth_sendTransaction', params: [{ from: ALICE, to: '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d', chainId: '0x3e7',
    data: encodeFunctionData({ abi, functionName: 'depositForBurn', args: [100_000_000n, 3, pad(BOB as Address), '0xb88339CB7199b77E23DB6E890353E22632Ba630f', pad(ZERO), 10_000n, 2000] }) }] }, { now: NOW, account: ALICE }, mockDeps());
  assert.ok(codes(toOther).includes('recipient_not_sender'));
});
