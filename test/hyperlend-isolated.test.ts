// HyperLend's isolated pools (Fraxlend-style pairs on HyperEVM): lending, borrowing, collateral and leverage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionData, parseAbi, toHex, type Hex } from 'viem';
import { previewRequest } from '../src/preview.ts';
import { StaticTokenRegistry } from '../src/chains.ts';
import type { Dependencies } from '../src/types.ts';
import { ALICE, BOB } from '../mocks/data.ts';
import { codes, detail, NOW } from './helpers.ts';

const PAIR = '0x78dd09e369f35d033a1d4ec1df39bc8a51c8b6fd'; // xHYPE -> USDC, from the PairRegistry
const XHYPE = '0xac962fa04bf91b7fd0dc0c5c32414e0ce3c51e03';
const ABI = parseAbi([
  'function deposit(uint256 amount, address receiver)', 'function withdraw(uint256 amount, address receiver, address owner)',
  'function borrowAsset(uint256 borrowAmount, uint256 collateralAmount, address receiver)', 'function addCollateral(uint256 collateralAmount, address borrower)',
  'function removeCollateral(uint256 collateralAmount, address receiver)',
  'function leveragedPosition(address swapperAddress, uint256 borrowAmount, uint256 initialCollateralAmount, uint256 amountCollateralOutMin, address[] path)',
]);
const deps: Dependencies = { tokens: new StaticTokenRegistry({ 999: [{ address: XHYPE, symbol: 'xHYPE', decimals: 18 }] }) };
const send = (data: Hex) => previewRequest({ method: 'eth_sendTransaction', params: [{ from: ALICE, to: PAIR, data, value: '0x0', chainId: toHex(999) }] }, { now: NOW }, deps);
const e18 = 10n ** 18n;

test('HyperLend isolated pools: lend, withdraw, borrow against collateral, and collateral changes', async () => {
  const lend = await send(encodeFunctionData({ abi: ABI, functionName: 'deposit', args: [1_000_000_000n, ALICE] }));
  assert.equal(lend.title, 'Lend 1,000 USDC (HyperLend isolated xHYPE → USDC)');
  assert.equal(lend.decoding.decoder, 'hyperlend_isolated');
  assert.equal(detail(lend, 'Maximum LTV'), '75%');
  assert.deepEqual(lend.assetChanges.map(c => [c.direction, c.amount, c.symbol]), [['out', '1,000', 'USDC']]);
  const out = await send(encodeFunctionData({ abi: ABI, functionName: 'withdraw', args: [500_000_000n, ALICE, ALICE] }));
  assert.equal(out.title, 'Withdraw 500 USDC (HyperLend isolated xHYPE → USDC)');
  const borrow = await send(encodeFunctionData({ abi: ABI, functionName: 'borrowAsset', args: [2_000_000_000n, 100n * e18, ALICE] }));
  assert.equal(borrow.title, 'Borrow 2,000 USDC, adding 100 xHYPE as collateral (HyperLend isolated xHYPE → USDC)');
  assert.deepEqual(borrow.assetChanges.map(c => [c.direction, c.amount, c.symbol]), [['out', '100', 'xHYPE'], ['in', '2,000', 'USDC']]);
  assert.ok(codes(await send(encodeFunctionData({ abi: ABI, functionName: 'borrowAsset', args: [1n, 0n, BOB] }))).includes('recipient_not_sender'));
  assert.ok(codes(await send(encodeFunctionData({ abi: ABI, functionName: 'addCollateral', args: [e18, BOB] }))).includes('collateral_for_other'));
  const remove = await send(encodeFunctionData({ abi: ABI, functionName: 'removeCollateral', args: [5n * e18, ALICE] }));
  assert.equal(remove.title, 'Withdraw 5 xHYPE of collateral (HyperLend isolated xHYPE → USDC)');
});

test('HyperLend isolated pools: a leveraged position is a caution', async () => {
  const p = await send(encodeFunctionData({ abi: ABI, functionName: 'leveragedPosition', args: [BOB, 3_000_000_000n, 100n * e18, 95n * e18, []] }));
  assert.equal(p.title, 'Leverage 100 xHYPE: borrow 3,000 USDC and swap it into at least 95 xHYPE (HyperLend isolated xHYPE → USDC)');
  assert.ok(codes(p).includes('leveraged_position'));
  // Not a registered pair: not read as one.
  const other = await previewRequest({ method: 'eth_sendTransaction', params: [{ from: ALICE, to: BOB, data: encodeFunctionData({ abi: ABI, functionName: 'deposit', args: [1n, ALICE] }), chainId: toHex(999) }] }, { now: NOW }, deps);
  assert.notEqual(other.decoding.decoder, 'hyperlend_isolated');
});
