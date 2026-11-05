// Calldata that is plain text: inscriptions and messages. Shapes taken from Ethereum mainnet traffic (2026-11-05):
// "data:," JSON inscriptions sent to accounts with no code, and plain-text messages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionData, parseAbi, stringToHex, toHex, type Hex } from 'viem';
import { previewRequest } from '../src/preview.ts';
import { StaticTokenRegistry } from '../src/chains.ts';
import { calldataText } from '../src/evm/text.ts';
import type { Dependencies } from '../src/types.ts';
import type { RpcClient } from '../src/rpc.ts';
import { ALICE, BOB } from '../mocks/data.ts';
import { codes, detail, NOW } from './helpers.ts';

const CONTRACT = '0xc0de000000000000000000000000000000000003';
const rpc: RpcClient = { has: id => id === 1, call: async (_id, method, params) => method === 'eth_getCode' ? ((params[0] as string).toLowerCase() === CONTRACT ? '0x6080604052' : '0x') : null };
const send = (to: string, data: Hex, value = 0n, deps: Dependencies = { tokens: new StaticTokenRegistry(), rpc }) =>
  previewRequest({ method: 'eth_sendTransaction', params: [{ from: ALICE, to, data, value: toHex(value), chainId: '0x1' }] }, { now: NOW }, deps);

test('A JSON inscription to an account without code is read in full', async () => {
  const body = 'data:,{"p":"edmt","op":"emt-batch-transfer","tick":"enat","items":[{"amt":"19","to":"0x342bf88482af5e58c8e2868cd8366d4e571c0a21","src":"balance"}]}';
  const p = await send(BOB, stringToHex(body));
  assert.equal(p.title, 'Inscription: edmt emt-batch-transfer enat');
  assert.equal(p.decoding.decoder, 'calldata_text');
  assert.equal(p.decoding.status, 'full');
  assert.equal(detail(p, 'Inscription'), body);
  assert.deepEqual(codes(p), ['inscription_protocol']);
  // Binary content is described, not dumped; long text is clipped.
  const image = await send(BOB, stringToHex(`data:image/png;base64,${'A'.repeat(400)}`));
  assert.equal(image.title, 'Post an image/png inscription');
  assert.equal(detail(image, 'Inscription'), 'image/png, 400 base64 characters');
  const long = await send(BOB, stringToHex(`data:,${'x'.repeat(1500)}`));
  assert.equal(long.title, 'Post a text/plain inscription');
  assert.match(detail(long, 'Inscription')!, /… \(506 more characters\)$/);
});

test('A text message: shown in full, with any value sent; hidden characters are flagged', async () => {
  const p = await send(BOB, stringToHex('gm, thanks for the help with the bridge'), 10n ** 17n);
  assert.equal(p.title, 'Send a message to 0xb0b0…0002 with 0.1 ETH');
  assert.equal(detail(p, 'Message'), 'gm, thanks for the help with the bridge');
  assert.equal(p.decoding.status, 'full');
  assert.deepEqual(p.assetChanges.map(c => [c.direction, c.amount, c.symbol]), [['out', '0.1', 'ETH']]);
  assert.ok(!codes(p).includes('unknown_function'));
  const sneaky = await send(BOB, stringToHex('pay to 0x‮1234‬ now'));
  assert.equal(detail(sneaky, 'Message'), 'pay to 0x1234 now');
  assert.ok(codes(sneaky).includes('hidden_characters'));
});

test('Text sent to a contract, or where code can’t be checked, is partial and says so', async () => {
  const toContract = await send(CONTRACT, stringToHex('data:,hello'));
  assert.equal(toContract.decoding.status, 'partial');
  assert.match(toContract.warnings.find(w => w.code === 'text_to_contract')!.message, /is a contract: it receives this text as its call input/);
  const offline = await send(BOB, stringToHex('hello there'), 0n, { tokens: new StaticTokenRegistry() });
  assert.equal(offline.decoding.status, 'partial');
  assert.match(offline.warnings.find(w => w.code === 'text_to_contract')!.message, /could not be checked/);
});

test('ABI-encoded calls and binary data are never read as text', async () => {
  assert.equal(calldataText(encodeFunctionData({ abi: parseAbi(['function hello(uint256)']), args: [1n] })), null);
  assert.equal(calldataText('0xdeadbeef00'), null);
  assert.equal(calldataText('0xc3'), null); // too short, and not valid UTF-8
  assert.equal(calldataText(stringToHex('héllo ✓')), 'héllo ✓');
  const blob = await send(BOB, '0x6aeaaa83ffee00112233');
  assert.equal(blob.decoding.decoder, 'unknown');
});
