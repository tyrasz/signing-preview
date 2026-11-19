// Transactions that submit an EIP-3009 authorization (x402 facilitators, gasless USDC transfers), EntryPoint v0.6
// bundles, and ERC-8021 attribution suffixes on calldata.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { concatHex, encodeFunctionData, parseAbi, type Hex } from 'viem';
import { previewRequest } from '../src/preview.ts';
import { StaticTokenRegistry } from '../src/chains.ts';
import { readAttribution } from '../src/attribution.ts';
import type { Dependencies } from '../src/types.ts';
import { ALICE, BOB } from '../mocks/data.ts';
import { codes, detail, NOW } from './helpers.ts';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const FACILITATOR = '0xfac1000000000000000000000000000000000009';
const ABI = parseAbi([
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)',
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)',
  'function receiveWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)',
  'function cancelAuthorization(address authorizer, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)',
]);
const NONCE = `0x${'ab'.repeat(32)}` as Hex, R = `0x${'11'.repeat(32)}` as Hex;
const t = NOW / 1000;
const deps = (used = false): Dependencies => ({ tokens: new StaticTokenRegistry(), rpc: { has: () => true, call: async (_c: number, method: string, params: unknown[]) => {
  if (method !== 'eth_call') throw new Error('unused');
  const { data } = params[0] as { data: string };
  return data.startsWith('0xe94a0102') ? `0x${(used ? 1n : 0n).toString(16).padStart(64, '0')}` : '0x';
} } });
const send = (from: string, data: Hex, d = deps()) => previewRequest({ method: 'eth_sendTransaction', params: [{ from, to: USDC, data, chainId: '0x1' }] }, { now: NOW }, d);
const transfer = (o: { from?: Hex; to?: Hex; after?: number; before?: number } = {}) => encodeFunctionData({ abi: ABI, functionName: 'transferWithAuthorization', args: [o.from ?? ALICE as Hex, o.to ?? BOB as Hex, 5_000n, BigInt(o.after ?? t - 60), BigInt(o.before ?? t + 600), NONCE, 27, R, R] });

test("A facilitator submitting someone's signed transfer: who pays whom, and what the token would refuse", async () => {
  const p = await send(FACILITATOR, transfer());
  assert.equal(p.decoding.decoder, 'eip3009_transfer');
  assert.equal(p.title, "Submit 0xa11c…0001's signed transfer of 0.005 USDC to 0xb0b0…0002");
  assert.equal(p.decoding.status, 'full');
  assert.deepEqual(p.warnings.filter(w => w.severity !== 'info').map(w => w.code), []);
  // The payer's own submission is a send, with its outflow.
  const own = await send(ALICE, transfer());
  assert.equal(own.title, 'Send 0.005 USDC to 0xb0b0…0002 with a signed authorization');
  // Outside its window, or with its nonce used: the token refuses it.
  assert.ok(codes(await send(FACILITATOR, transfer({ before: t - 1 }))).includes('eip3009_expired'));
  assert.ok(codes(await send(FACILITATOR, transfer({ after: t + 60 }))).includes('eip3009_not_yet_valid'));
  assert.ok(codes(await send(FACILITATOR, transfer(), deps(true))).includes('eip3009_nonce_used'));
  // The bytes-signature form (FiatToken v2.2) reads the same.
  const bytes = encodeFunctionData({ abi: ABI, functionName: 'transferWithAuthorization', args: [ALICE as Hex, BOB as Hex, 5_000n, BigInt(t - 60), BigInt(t + 600), NONCE, `0x${'22'.repeat(65)}`] });
  assert.equal((await send(FACILITATOR, bytes)).decoding.decoder, 'eip3009_transfer');
});

test('receiveWithAuthorization only from the payee; a cancellation', async () => {
  const receive = encodeFunctionData({ abi: ABI, functionName: 'receiveWithAuthorization', args: [ALICE as Hex, BOB as Hex, 5_000n, BigInt(t - 60), BigInt(t + 600), NONCE, 27, R, R] });
  const payee = await send(BOB, receive);
  assert.equal(payee.title, 'Receive 0.005 USDC from 0xa11c…0001 with their signed authorization');
  assert.ok(!codes(payee).includes('eip3009_not_payee'));
  assert.ok(codes(await send(FACILITATOR, receive)).includes('eip3009_not_payee'));
  const cancel = await send(ALICE, encodeFunctionData({ abi: ABI, functionName: 'cancelAuthorization', args: [ALICE as Hex, NONCE, 27, R, R] }));
  assert.equal(cancel.title, 'Cancel your USDC transfer authorization');
});

test('An ERC-8021 attribution suffix is read and shown; the call under it decodes as without it', async () => {
  // As x402's facilitator on Base appends it (CBOR schema 2: wallet "cdp_facil1"), and Base's builder codes (schema 0).
  const cbor = '0xa161776a6364705f666163696c31000e0280218021802180218021802180218021';
  const codes0 = '0x626173656170702c6d6f7270686f0e0080218021802180218021802180218021';
  assert.deepEqual(readAttribution(`0xdddddddd${cbor.slice(2)}`), { bytes: 33, schema: 2, parts: ['wallet cdp_facil1'] });
  assert.deepEqual(readAttribution(codes0)?.parts, ['codes baseapp, morpho']);
  assert.equal(readAttribution('0xa9059cbb'), undefined);
  const p = await send(FACILITATOR, concatHex([transfer(), cbor as Hex]));
  assert.equal(p.title, "Submit 0xa11c…0001's signed transfer of 0.005 USDC to 0xb0b0…0002");
  assert.equal(detail(p, 'Attribution (ERC-8021)'), 'wallet cdp_facil1');
  const plain = encodeFunctionData({ abi: parseAbi(['function transfer(address,uint256)']), args: [BOB as Hex, 1_000_000n] });
  const tagged = await send(ALICE, concatHex([plain, codes0 as Hex]));
  assert.equal(tagged.title, 'Send 1 USDC');
  assert.equal(detail(tagged, 'Attribution (ERC-8021)'), 'codes baseapp, morpho');
});

test("EntryPoint v0.6 bundles decode, said of the operation's account when a bundler sends them", async () => {
  const V06 = '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789';
  const OP = parseAbi(['function handleOps((address sender, uint256 nonce, bytes initCode, bytes callData, uint256 callGasLimit, uint256 verificationGasLimit, uint256 preVerificationGas, uint256 maxFeePerGas, uint256 maxPriorityFeePerGas, bytes paymasterAndData, bytes signature)[] ops, address beneficiary)']);
  const call = encodeFunctionData({ abi: parseAbi(['function execute(address dest, uint256 value, bytes func)']), args: [USDC, 0n, encodeFunctionData({ abi: parseAbi(['function transfer(address,uint256)']), args: [BOB as Hex, 1_000_000n] })] });
  const data = encodeFunctionData({ abi: OP, functionName: 'handleOps', args: [[{ sender: ALICE as Hex, nonce: 0n, initCode: '0x', callData: call, callGasLimit: 1n, verificationGasLimit: 1n, preVerificationGas: 1n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, paymasterAndData: '0x', signature: '0x' }], FACILITATOR as Hex] });
  const p = await previewRequest({ method: 'eth_sendTransaction', params: [{ from: FACILITATOR, to: V06, data, chainId: '0x1' }] }, { now: NOW }, { tokens: new StaticTokenRegistry() });
  assert.equal(p.decoding.decoder, 'erc4337_entry_point');
  assert.equal(p.title, "Submit 0xa11c…0001's UserOperation: Send 1 USDC");
  assert.equal(detail(p, 'Contract'), `EntryPoint v0.6 (${V06.toLowerCase()})`);
  assert.ok(codes(p).includes('erc4337_bundle'));
});
