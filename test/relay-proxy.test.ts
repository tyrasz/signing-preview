// Relay's approval proxy: the Permit2 witness and MulticallAuthorization a user signs, the transactions sent to it,
// and Relay's router's own calls (RouteRacer's race, RelayRouter's cleanups) read as what they move where.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionData, parseAbi, type Hex } from 'viem';
import { previewRequest } from '../src/preview.ts';
import { StaticTokenRegistry } from '../src/chains.ts';
import type { Dependencies } from '../src/types.ts';
import { ALICE, BOB } from '../mocks/data.ts';
import { codes, detail, NOW } from './helpers.ts';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const PROXY = '0x5567954cd026cebfe486062cb75848e0f1c12e58', ROUTER = '0x0729e2a4716d9f7dd17858d5d504426d228697f7', RACER = '0x195627f03fe2668d65c763cd39eec45b1d76c8ee';
const RELAYER = '0x370a7e2d300c14d79d4a7ee07aaca46c4b3012cf', EVIL = '0xe1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1';
const deps: Dependencies = { tokens: new StaticTokenRegistry() };
const approve = encodeFunctionData({ abi: parseAbi(['function approve(address,uint256)']), args: [RACER, 6_000_000n] });
const race = encodeFunctionData({ abi: parseAbi(['function raceWithBackups(address tokenIn, uint256 amountIn, address tokenOut, uint256 minAmountOut, address recipient, address refundTo, (address target, address spender, uint256 value, uint256 gasLimit, uint256 feePpm, bytes callData)[] routes, uint256 mainCount, bool emitEvents, bytes metadata)']),
  args: [USDC, 6_000_000n, WETH, 2n * 10n ** 15n, ROUTER, ROUTER, [{ target: '0x1111111254eeb25477b68fb85ed929f73a960582', spender: '0x1111111254eeb25477b68fb85ed929f73a960582', value: 0n, gasLimit: 500_000n, feePpm: 0n, callData: '0x12345678' }], 1n, false, '0x'] });
const cleanup = (to: string) => encodeFunctionData({ abi: parseAbi(['function cleanupErc20s(address[] tokens, address[] recipients, uint256[] amounts, bytes metadata)']), args: [[WETH], [to as Hex], [0n], '0x'] });
const calls = (to: string) => [{ target: USDC, allowFailure: false, value: '0', callData: approve }, { target: RACER, allowFailure: false, value: '0', callData: race }, { target: ROUTER, allowFailure: false, value: '0', callData: cleanup(to) }];
const TYPES = {
  EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
  PermitBatchWitnessTransferFrom: [{ name: 'permitted', type: 'TokenPermissions[]' }, { name: 'spender', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'witness', type: 'RelayerWitness' }],
  TokenPermissions: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }],
  RelayerWitness: [{ name: 'relayer', type: 'address' }, { name: 'msgValue', type: 'uint256' }, { name: 'refundTo', type: 'address' }, { name: 'nftRecipient', type: 'address' }, { name: 'metadata', type: 'bytes' }, { name: 'call3Values', type: 'Call3Value[]' }],
  Call3Value: [{ name: 'target', type: 'address' }, { name: 'allowFailure', type: 'bool' }, { name: 'value', type: 'uint256' }, { name: 'callData', type: 'bytes' }],
};
const witness = (o: { to?: string; refundTo?: string; spender?: string } = {}) => ({ domain: { name: 'Permit2', chainId: 1, verifyingContract: '0x000000000022d473030f116ddee9f6b43ac78ba3' }, types: TYPES, primaryType: 'PermitBatchWitnessTransferFrom',
  message: { permitted: [{ token: USDC, amount: '6000000' }], spender: o.spender ?? PROXY, nonce: '7', deadline: String(NOW / 1000 + 600),
    witness: { relayer: RELAYER, msgValue: '0', refundTo: o.refundTo ?? ALICE, nftRecipient: ALICE, metadata: '0x', call3Values: calls(o.to ?? ALICE) } } });
const sign = (data: unknown) => previewRequest({ method: 'eth_signTypedData_v4', params: [ALICE, JSON.stringify(data)] }, { now: NOW, chainId: 1 }, deps);

test("A Relay request signed with Permit2: the router's calls, read as the swap and what is sent where", async () => {
  const p = await sign(witness());
  assert.equal(p.decoding.decoder, 'relay_permit2');
  assert.match(p.title, /^Relay: move 6 USDC into its router for 3 calls: Allow 0x1956…c8ee to spend 6 USDC; Swap 6 USDC for at least 0\.002 WETH/);
  assert.equal(detail(p, 'Relayer (only it can submit this)'), RELAYER);
  assert.match(detail(p, 'Call 3') ?? '', /^Send all the router holds of WETH to you/);
  assert.deepEqual(codes(p).filter(c => c.startsWith('relay_')), []);
  // Leftovers to someone else, a token sent straight to someone else, a spender that isn't Relay's proxy.
  assert.ok(codes(await sign(witness({ refundTo: EVIL }))).includes('relay_refund_other'));
  const direct = witness();
  direct.message.witness.call3Values.push({ target: USDC, allowFailure: false, value: '0', callData: encodeFunctionData({ abi: parseAbi(['function transfer(address,uint256)']), args: [EVIL, 6_000_000n] }) });
  assert.ok(codes(await sign(direct)).includes('relay_call_recipient'));
  assert.ok(codes(await sign(witness({ spender: '0x1234567890123456789012345678901234567890' }))).includes('relay_proxy_unknown'));
  // A request with more calls than are read is a danger.
  const many = witness();
  for (let i = 0; i < 12; i++) many.message.witness.call3Values.push({ target: USDC, allowFailure: false, value: '0', callData: approve });
  assert.equal(p.attention === 'danger', false);
  assert.equal((await sign(many)).warnings.find(w => w.code === 'relay_calls_unread')?.severity, 'danger');
});

test('Transactions to the proxy: a request sent by the account, one submitted for another', async () => {
  const ABI = parseAbi(['function transferAndMulticall(address[] tokens, uint256[] amounts, (address target, bool allowFailure, uint256 value, bytes callData)[] calls, address refundTo, address nftRecipient, bytes metadata) payable']);
  const data = encodeFunctionData({ abi: ABI, args: [[USDC], [6_000_000n], calls(ALICE).map(c => ({ ...c, value: 0n, target: c.target as Hex, callData: c.callData as Hex })), ALICE, ALICE, '0x'] });
  const p = await previewRequest({ method: 'eth_sendTransaction', params: [{ from: ALICE, to: PROXY, data, chainId: '0x1' }] }, { now: NOW, chainId: 1 }, deps);
  assert.equal(p.decoding.decoder, 'relay_proxy');
  assert.match(p.title, /^Relay: move 6 USDC into its router for 3 calls/);
  assert.equal(p.assetChanges[0]?.symbol, 'USDC');
  // The router's own calls, on their own.
  const r = await previewRequest({ method: 'eth_sendTransaction', params: [{ from: ALICE, to: ROUTER, data: cleanup(BOB), chainId: '0x1' }] }, { now: NOW, chainId: 1 }, deps);
  assert.equal(r.title, "Send all the router holds of WETH to 0xb0b0…0002 (Relay's router)");
});

test('A MulticallAuthorization (USDC-funded): the funding and the calls', async () => {
  const data = { domain: { name: 'RelayApprovalProxy', version: '3.1', chainId: 1, verifyingContract: PROXY }, primaryType: 'MulticallAuthorization',
    types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
      MulticallAuthorization: [{ name: 'from', type: 'address' }, { name: 'relayer', type: 'address' }, { name: 'msgValue', type: 'uint256' }, { name: 'refundTo', type: 'address' }, { name: 'nftRecipient', type: 'address' }, { name: 'metadata', type: 'bytes' }, { name: 'fundingIndex', type: 'uint256' }, { name: 'calls', type: 'Call3Value[]' }, { name: 'funding', type: 'FundingAuthorization[]' }],
      Call3Value: TYPES.Call3Value, FundingAuthorization: [{ name: 'token', type: 'address' }, { name: 'from', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }] },
    message: { from: ALICE, relayer: RELAYER, msgValue: '0', refundTo: ALICE, nftRecipient: ALICE, metadata: '0x', fundingIndex: '0', calls: calls(ALICE), funding: [{ token: USDC, from: ALICE, value: '6000000', validAfter: '0', validBefore: String(NOW / 1000 + 600) }] } };
  const p = await sign(data);
  assert.equal(p.decoding.decoder, 'relay_multicall');
  assert.equal(detail(p, 'Funding 1'), '6 USDC');
  assert.match(p.title, /^Relay: let its router make 3 calls with your tokens/);
});

test('Seventh review: what the router pays others, only Relay\'s own contracts read as Relay\'s, values in hex, nesting bounded', async () => {
  const call = (target: string, callData: string, value = '0') => ({ target, allowFailure: false, value, callData });
  const withCalls = (cs: ReturnType<typeof call>[]) => { const w = witness(); (w.message.witness as { call3Values: unknown[] }).call3Values = cs; return w; };
  // A cleanup to someone else, a swap's output to someone else: cautions.
  assert.ok(codes(await sign(withCalls([call(ROUTER, cleanup(EVIL))]))).includes('relay_call_recipient'));
  const raceTo = (to: string) => encodeFunctionData({ abi: parseAbi(['function race(address tokenIn, uint256 amountIn, address tokenOut, uint256 minAmountOut, address recipient, address refundTo, (address target, address spender, uint256 value, uint256 gasLimit, uint256 feePpm, bytes callData)[] routes, bool emitEvents, bytes metadata)']), args: [USDC, 6_000_000n, WETH, 1n, to as Hex, ALICE, [], false, '0x'] });
  assert.ok(codes(await sign(withCalls([call(RACER, raceTo(EVIL))]))).includes('relay_call_recipient'));
  // The same selectors on a contract that isn't Relay's: not read as Relay's.
  const fake = await sign(withCalls([call('0xbad0000000000000000000000000000000000bad', raceTo(ALICE))]));
  assert.ok(codes(fake).includes('unknown_function'));
  // A value given in hex is the same value.
  const unwrap = encodeFunctionData({ abi: parseAbi(['function withdraw(uint256)']), args: [5n * 10n ** 18n] });
  const hex = await sign(withCalls([call(WETH, unwrap), call(EVIL, '0x', '0x4563918244f40000')]));
  assert.match(detail(hex, 'Call 2') ?? '', /^Send 5 ETH/);
  assert.ok(codes(hex).includes('relay_call_recipient'));
  // Requests nested in requests: read two levels deep, then said not to be.
  const ABI = parseAbi(['function transferAndMulticall(address[] tokens, uint256[] amounts, (address target, bool allowFailure, uint256 value, bytes callData)[] calls, address refundTo, address nftRecipient, bytes metadata) payable']);
  let data: Hex = cleanup(ALICE), target = ROUTER;
  for (let i = 0; i < 3; i++) { data = encodeFunctionData({ abi: ABI, args: [[], [], [{ target: target as Hex, allowFailure: false, value: 0n, callData: data }], ALICE, ALICE, '0x'] }); target = PROXY; }
  const nested = await sign(withCalls([call(PROXY, data)]));
  assert.ok(nested.warnings.some(w => w.code === 'relay_call_unread' && /nested inside two others/.test(w.message)));
});

test('Eighth review: coin paid with a message, or by the Universal Router, is said', async () => {
  const call = (target: string, callData: string, value = '0') => ({ target, allowFailure: false, value, callData });
  const withCalls = (cs: ReturnType<typeof call>[]) => { const w = witness(); (w.message.witness as { call3Values: unknown[] }).call3Values = cs; return w; };
  const text = `0x${Buffer.from('gm, thanks').toString('hex')}`;
  assert.ok(codes(await sign(withCalls([call(EVIL, text, '5000000000000000000')]))).includes('relay_call_recipient'));
});
