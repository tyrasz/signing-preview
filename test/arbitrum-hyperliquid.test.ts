import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionData, pad, parseAbi, type Hex } from 'viem';
import { previewRequest } from '../src/preview.ts';
import { CCTP, HYPERLIQUID } from '../src/chains.ts';
import { ALICE } from '../mocks/data.ts';
import { codes, detail, mockDeps, NOW, sample } from './helpers.ts';

const ERC20 = parseAbi(['function transfer(address to, uint256 amount)']);
const deposit = (chainId: number, token: string, amount: bigint) => ({
  method: 'eth_sendTransaction',
  params: [{ from: ALICE, to: token, chainId: '0x' + chainId.toString(16), data: encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [HYPERLIQUID.bridge2, amount] }) }],
});

test('Bridge2 deposit of native USDC is described as a Hyperliquid deposit', async () => {
  const p = await sample('bridge2-deposit');
  assert.equal(p.title, 'Deposit 100 USDC to Hyperliquid');
  assert.equal(p.decoding.decoder, 'hyperliquid_bridge2_deposit');
  assert.equal(p.decoding.status, 'full');
  assert.equal(detail(p, 'Credited to (Hyperliquid)'), ALICE);
  assert.equal(p.attention, 'info');
  // Mock simulation supplies the measured-from-events change.
  assert.deepEqual(p.assetChanges.map(c => [c.direction, c.amount, c.symbol, c.basis]), [['out', '100', 'USDC', 'simulated_events']]);
});

test('Bridge2 deposit below 5 USDC is flagged as lost funds; exactly 5 is not', async () => {
  const below = await sample('bridge2-below-min');
  assert.equal(below.attention, 'danger');
  assert.ok(codes(below).includes('deposit_below_minimum'));
  const exact = await previewRequest(deposit(42161, CCTP.usdcByChain[42161], 5_000_000n), { now: NOW }, mockDeps());
  assert.ok(!codes(exact).includes('deposit_below_minimum'));
});

test('Sending a non-USDC token or using the wrong chain is dangerous', async () => {
  const usdt = await sample('bridge2-wrong-token');
  assert.ok(codes(usdt).includes('bridge_wrong_token'));
  assert.equal(usdt.attention, 'danger');
  const mainnet = await previewRequest(deposit(1, CCTP.usdcByChain[1], 100_000_000n), { now: NOW }, mockDeps());
  assert.ok(codes(mainnet).includes('bridge_wrong_chain'));
});

test('CCTP forwarding to HyperCore decodes amount, recipient and destination balance', async () => {
  const p = await sample('cctp-hypercore');
  assert.equal(p.title, 'Bridge 250 USDC to Hyperliquid perps');
  assert.equal(detail(p, 'HyperCore recipient'), ALICE);
  assert.equal(detail(p, 'Maximum fee'), '0.25 USDC (a cap, not a quote)');
  assert.equal(detail(p, 'Expected on HyperCore'), '249.8 USDC');
  assert.equal(p.attention, 'none');
  const other = await sample('cctp-other-recipient');
  assert.equal(detail(other, 'HyperCore balance'), 'spot');
  assert.ok(codes(other).includes('recipient_not_sender'));
});

test('CCTP with a fee cap at or above the amount reverts on the source chain', async () => {
  const abi = parseAbi(['function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)']);
  const data = encodeFunctionData({ abi, functionName: 'depositForBurn', args: [1_000_000n, 6, pad(ALICE as Hex), CCTP.usdcByChain[42161] as Hex, pad('0x00'), 1_000_000n, 2000] });
  const p = await previewRequest({ method: 'eth_sendTransaction', params: [{ from: ALICE, to: CCTP.tokenMessengerV2, data, chainId: '0xa4b1' }] }, { now: NOW }, mockDeps());
  assert.equal(p.title, 'Bridge 1 USDC to Base');
  assert.ok(codes(p).includes('cctp_will_revert'));
  assert.equal(p.attention, 'caution');
});

test('EIP-5792 batches preview each call and flag the unlimited approval', async () => {
  const p = await sample('arb-batch');
  assert.equal(p.kind, 'batch');
  assert.equal(p.calls?.length, 2);
  assert.equal(p.calls?.[1].title, 'Deposit 20 USDC to Hyperliquid');
  assert.ok(p.warnings.some(w => w.code === 'unlimited_approval' && w.message.startsWith('Call 1:')));
});
