// A smart account (an EIP-7702 delegated EOA or a smart wallet) calling itself to run a batch: each call is decoded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { concatHex, encodeAbiParameters, encodeFunctionData, numberToHex, pad, parseAbi, type Hex } from 'viem';
import { previewRequest } from '../src/preview.ts';
import { StaticTokenRegistry } from '../src/chains.ts';
import { ALICE, BOB } from '../mocks/data.ts';
import { codes, detail, NOW } from './helpers.ts';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const ERC20 = parseAbi(['function transfer(address,uint256)', 'function approve(address,uint256)']);
const ACCOUNT = parseAbi(['function execute(bytes32 mode, bytes executionData)', 'function executeBatch((address target, uint256 value, bytes data)[] calls)', 'function execute(address target, uint256 value, bytes data)']);
const CALLS = [{ type: 'tuple[]', components: [{ name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }] }] as const;
const transfer = encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [BOB, 1_000_000n] });
const approve = encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [BOB, (1n << 256n) - 1n] });
const send = (data: Hex) => previewRequest({ method: 'eth_sendTransaction', params: [{ from: ALICE, to: ALICE, data, chainId: '0x1' }] }, { now: NOW }, { tokens: new StaticTokenRegistry() });
const mode = (callType: string, execType = '00') => pad(`0x${callType}${execType}`, { dir: 'right', size: 32 });

test('ERC-7579 / ERC-7821 batches: every call decoded, with its own warnings numbered', async () => {
  const batch = encodeAbiParameters(CALLS, [[{ target: USDC, value: 0n, data: transfer }, { target: WETH, value: 0n, data: approve }]]);
  const p = await send(encodeFunctionData({ abi: ACCOUNT, functionName: 'execute', args: [mode('01'), batch] }));
  assert.equal(p.title, 'Run 2 calls from your account');
  assert.equal(detail(p, 'Call 1'), 'Send 1 USDC (0xa0b8…eb48)');
  assert.equal(detail(p, 'Call 2'), 'Allow 0xb0b0…0002 to spend unlimited WETH (0xc02a…6cc2)');
  assert.match(p.warnings.find(w => w.code === 'unlimited_approval')!.message, /^Call 2: /);
  assert.equal(p.decoding.decoder, 'smart_account');
  assert.equal(p.decoding.status, 'full');
  assert.deepEqual(p.assetChanges.map(c => `${c.direction} ${c.amount} ${c.symbol}`), ['out 1 USDC']);
  // ERC-7821 with opData after the calls; "try" mode noted.
  const withOp = encodeAbiParameters([...CALLS, { type: 'bytes' }], [[{ target: USDC, value: 0n, data: transfer }, { target: WETH, value: 0n, data: approve }], '0x1234']);
  const q = await send(encodeFunctionData({ abi: ACCOUNT, functionName: 'execute', args: [mode('01', '01'), withOp] }));
  assert.equal(q.title, 'Run 2 calls from your account');
  assert.ok(q.decoding.notes.some(n => /"try" mode/.test(n)));
});

test('A batch of more than twenty calls: every call decoded to the two hundredth, and what is past that said to be unread', async () => {
  const many = (n: number, last: { target: Hex; value: bigint; data: Hex }) => encodeFunctionData({ abi: ACCOUNT, functionName: 'executeBatch', args: [[...Array.from({ length: n }, () => ({ target: USDC as Hex, value: 0n, data: transfer })), last]] });
  // Behind twenty transfers an unlimited approval went with nothing warned of: calls past the twentieth weren't read.
  const hidden = await send(many(20, { target: WETH, value: 0n, data: approve }));
  assert.match(hidden.warnings.find(w => w.code === 'unlimited_approval')?.message ?? '', /^Call 21: /);
  assert.match(detail(hidden, 'Call 21') ?? '', /^Allow .* to spend unlimited WETH/);
  assert.equal(detail(hidden, 'More calls'), undefined);
  // Past the two hundredth they aren't decoded, which is said.
  const beyond = await send(many(200, { target: WETH, value: 0n, data: approve }));
  assert.deepEqual([beyond.attention, beyond.decoding.status, detail(beyond, 'More calls')], ['danger', 'partial', '1']);
  assert.match(beyond.warnings.find(w => w.code === 'smart_account_calls_unread')?.message ?? '', /^The batch has 201 calls, and the 1 after the first 200 aren't decoded here/);
});

test('A batch nested in a batch is laid out, and a call back into the account that isn’t one is said to be unread', async () => {
  const batch = (calls: { target: Hex; value: bigint; data: Hex }[]) => encodeFunctionData({ abi: ACCOUNT, functionName: 'executeBatch', args: [calls] });
  // A call back into the account that is a batch of its own runs its calls as the account too. Left as "Call your
  // own account", an unlimited approval a level down went with nothing said of it.
  const nested = await send(batch([{ target: USDC, value: 0n, data: transfer }, { target: ALICE as Hex, value: 0n, data: batch([{ target: WETH, value: 0n, data: approve }]) }]));
  assert.match(nested.warnings.find(w => w.code === 'unlimited_approval')?.message ?? '', /^Call 2: /);
  assert.match(detail(nested, 'Call 2') ?? '', /^Allow .* to spend unlimited WETH/);
  assert.ok(!codes(nested).includes('smart_account_self_call'));
  // One that isn't a batch (an upgrade, a new owner: whatever the account's code does with it) isn't read: said.
  const upgrade = await send(batch([{ target: USDC, value: 0n, data: transfer }, { target: ALICE as Hex, value: 0n, data: '0x3659cfe6000000000000000000000000000000000000000000000000000000000000dead' }]));
  assert.match(upgrade.warnings.find(w => w.code === 'smart_account_self_call')?.message ?? '', /^Call 2: a call back into your account \(0x3659cfe6\) that isn't read/);
  assert.equal(upgrade.attention, 'caution');
  // And one that has the account delegatecall another contract is the danger a delegatecall is.
  const dc = await send(batch([{ target: ALICE as Hex, value: 0n, data: encodeFunctionData({ abi: ACCOUNT, functionName: 'execute', args: [mode('ff'), concatHex([BOB, '0xdeadbeef'])] }) }]));
  assert.deepEqual([dc.attention, codes(dc).includes('smart_account_delegatecall')], ['danger', true]);
  // (A plain send to the account itself, with no calldata, has nothing to read.)
  assert.ok(!codes(await send(batch([{ target: USDC, value: 0n, data: transfer }, { target: ALICE as Hex, value: 1n, data: '0x' }]))).includes('smart_account_self_call'));
});

test('Coin sent with a call, who a call pays, batches nested too deep, and nested batches’ own failure modes', async () => {
  const batch = (calls: { target: Hex; value: bigint; data: Hex }[]) => encodeFunctionData({ abi: ACCOUNT, functionName: 'executeBatch', args: [calls] });
  // A token transfer with coin attached was titled as the transfer, the coin nowhere; and no call said who it pays.
  const coin = await send(batch([{ target: USDC, value: 10n ** 18n, data: transfer }, { target: BOB as Hex, value: 2n * 10n ** 18n, data: '0x' }]));
  assert.match(detail(coin, 'Call 1') ?? '', /^Send 1 USDC, with 1 ETH \(/);
  assert.match(detail(coin, 'Call 2') ?? '', /^Send 2 ETH \(/);
  assert.equal(detail(coin, 'Call 1: Recipient')?.toLowerCase(), BOB.toLowerCase());
  const single = await send(encodeFunctionData({ abi: ACCOUNT, functionName: 'execute', args: [USDC, 5n * 10n ** 18n, transfer] }));
  assert.deepEqual([detail(single, 'Value sent with the call'), detail(single, 'Recipient')?.toLowerCase()], ['5 ETH', BOB.toLowerCase()]);
  // A batch nested deeper than is laid out isn't read: a danger, as calls past the two hundredth are (it was a
  // caution that "a call back into your account" isn't read).
  let deep = batch([{ target: WETH, value: 0n, data: approve }]);
  for (let i = 0; i < 4; i++) deep = batch([{ target: ALICE as Hex, value: 0n, data: deep }]);
  const tooDeep = await send(deep);
  assert.equal(tooDeep.attention, 'danger');
  assert.match(tooDeep.warnings.find(w => w.code === 'smart_account_calls_unread')?.message ?? '', /a batch of 1 call nested more than four deep in calls back into your account, which isn't read here/);
  // A nested batch fails as its own mode has it: laid out among the outer batch's calls, that was lost.
  const tryInside = encodeFunctionData({ abi: ACCOUNT, functionName: 'execute', args: [mode('01', '01'), encodeAbiParameters(CALLS, [[{ target: USDC, value: 0n, data: transfer }, { target: WETH, value: 0n, data: transfer }]])] });
  const mixed = await send(batch([{ target: USDC, value: 0n, data: transfer }, { target: ALICE as Hex, value: 0n, data: tryInside }]));
  assert.match(mixed.decoding.notes.join(' '), /A batch nested in it is in "try" mode: a call of that batch that fails is skipped/);
  // An execution with a signature after it, in an encoding that isn't its canonical one (a gap before its tails):
  // read as the packed call it isn't, it was a call to the zero address with 1.4e32 ETH. Unread, and said to be.
  const [head, ...rest] = [encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes' }], [concatHex([USDC, numberToHex(0n, { size: 32 }), approve]), '0x1234'])];
  const gapped = `0x${(0x60).toString(16).padStart(64, '0')}${(BigInt(`0x${head.slice(66, 130)}`) + 0x20n).toString(16).padStart(64, '0')}${'00'.repeat(32)}${head.slice(130)}` as Hex;
  assert.equal(rest.length, 0);
  const odd = await send(encodeFunctionData({ abi: ACCOUNT, functionName: 'execute', args: [`0x000000000000aabbccdd${'00'.repeat(22)}`, gapped] }));
  assert.deepEqual([codes(odd).includes('smart_account_unread'), /0x0000…0000/.test(odd.title)], [true, false]);
});

test('Single calls (packed ERC-7579, execute(address,uint256,bytes)), executeBatch, and delegatecall', async () => {
  const single = concatHex([USDC, numberToHex(0n, { size: 32 }), transfer]);
  assert.equal((await send(encodeFunctionData({ abi: ACCOUNT, functionName: 'execute', args: [mode('00'), single] }))).title, 'Send 1 USDC');
  assert.equal((await send(encodeFunctionData({ abi: ACCOUNT, functionName: 'execute', args: [USDC, 0n, transfer] }))).title, 'Send 1 USDC');
  const coinbase = await send(encodeFunctionData({ abi: ACCOUNT, functionName: 'executeBatch', args: [[{ target: USDC, value: 0n, data: transfer }, { target: BOB, value: 10n ** 17n, data: '0x' }]] }));
  assert.equal(coinbase.title, 'Run 2 calls from your account');
  assert.match(detail(coinbase, 'Call 2')!, /^Send 0\.1 ETH/);
  const dc = await send(encodeFunctionData({ abi: ACCOUNT, functionName: 'execute', args: [mode('ff'), concatHex([BOB, '0xdeadbeef'])] }));
  assert.ok(codes(dc).includes('smart_account_delegatecall'));
  assert.equal(dc.attention, 'danger');
  // Under a mode selector that isn't known, too: its packed layout as accounts that read only the call type run it,
  // and, where the bytes are another layout (an execution with a signature after), unread but still a delegatecall.
  const selected = (callType: string) => `0x${callType}00000000001234abcd${'00'.repeat(22)}` as Hex;
  const dcOther = await send(encodeFunctionData({ abi: ACCOUNT, functionName: 'execute', args: [selected('ff'), concatHex([BOB, '0xdeadbeef'])] }));
  assert.deepEqual([codes(dcOther).includes('smart_account_delegatecall'), dcOther.attention], [true, 'danger']);
  assert.equal((await send(encodeFunctionData({ abi: ACCOUNT, functionName: 'execute', args: [selected('00'), single] }))).title, 'Send 1 USDC');
  const wrapped = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes' }], [single, '0x1234']);
  const dcUnread = await send(encodeFunctionData({ abi: ACCOUNT, functionName: 'execute', args: [selected('ff'), wrapped] }));
  assert.deepEqual([codes(dcUnread).includes('smart_account_delegatecall'), codes(dcUnread).includes('smart_account_unread'), dcUnread.attention, dcUnread.decoding.decoder], [true, true, 'danger', 'smart_account']);
  const unread = await send(encodeFunctionData({ abi: ACCOUNT, functionName: 'execute', args: [selected('00'), wrapped] }));
  assert.deepEqual([codes(unread).includes('smart_account_unread'), codes(unread).includes('smart_account_delegatecall'), unread.attention, unread.assetChanges.length], [true, false, 'caution', 0]);
  // Not a self-call: an ordinary contract's execute is left to the other decoders.
  const other = await previewRequest({ method: 'eth_sendTransaction', params: [{ from: ALICE, to: BOB, data: encodeFunctionData({ abi: ACCOUNT, functionName: 'execute', args: [USDC, 0n, transfer] }), chainId: '0x1' }] }, { now: NOW }, { tokens: new StaticTokenRegistry() });
  assert.notEqual(other.decoding.decoder, 'smart_account');
});

test('A batch sent to your own account does nothing when the account has no code; a delegation in the same transaction counts', async () => {
  const batch = encodeFunctionData({ abi: ACCOUNT, functionName: 'execute', args: [USDC, 0n, transfer] });
  const rpc = { has: () => true, call: async (_c: number, method: string) => method === 'eth_getCode' ? '0x' : null };
  const plain = await previewRequest({ method: 'eth_sendTransaction', params: [{ from: ALICE, to: ALICE, data: batch, chainId: '0x1' }] }, { now: NOW }, { tokens: new StaticTokenRegistry(), rpc });
  assert.ok(codes(plain).includes('smart_account_no_code'));
  assert.notEqual(plain.title, 'Send 1 USDC');
  const upgrading = await previewRequest({ method: 'eth_sendTransaction', params: [{ from: ALICE, to: ALICE, data: batch, chainId: '0x1', authorizationList: [{ address: '0x63c0c19a282a1b52b07dd5a65b58948a07dae32b', chainId: '0x1' }] }] }, { now: NOW }, { tokens: new StaticTokenRegistry(), rpc });
  assert.equal(upgrading.title, 'Send 1 USDC');
  const delegated = await previewRequest({ method: 'eth_sendTransaction', params: [{ from: ALICE, to: ALICE, data: batch, chainId: '0x1' }] }, { now: NOW }, { tokens: new StaticTokenRegistry(), rpc: { ...rpc, call: async () => '0xef010063c0c19a282a1b52b07dd5a65b58948a07dae32b' } });
  assert.equal(delegated.title, 'Send 1 USDC');
});

test('An Arbitrum-style inbox message: the transaction it delivers to the child chain, and who signed it', async () => {
  const { privateKeyToAccount } = await import('viem/accounts');
  const signer = privateKeyToAccount('0x8888888888888888888888888888888888888888888888888888888888888888');
  const signed = await signer.signTransaction({ chainId: 99901, to: BOB, value: 0n, data: '0xdeadbeef', nonce: 3, gas: 100000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, type: 'eip1559' });
  const data = encodeFunctionData({ abi: parseAbi(['function sendL2Message(bytes messageData) returns (uint256)']), args: [`0x04${signed.slice(2)}`] });
  const send = (from: string) => previewRequest({ method: 'eth_sendTransaction', params: [{ from, to: '0xce59f8b65ad41c9dae4c07a0571a39824bd92cff', data, chainId: '0x3e7' }] }, { now: NOW }, { tokens: new StaticTokenRegistry() });
  const mine = await send(signer.address);
  assert.equal(mine.title, 'Send a transaction to chain 99901 through its inbox (to 0xb0b0…0002)');
  assert.equal(detail(mine, 'Calldata'), '0xdeadbeef (4 bytes)');
  assert.ok(!codes(mine).includes('inbox_relayed'));
  assert.ok(codes(await send(ALICE)).includes('inbox_relayed'));
});

test('The older parallel-array batches: executeBatch(address[],bytes[]) and executeBatch(address[],uint256[],bytes[])', async () => {
  const abi = parseAbi(['function executeBatch(address[] dest, bytes[] func)', 'function executeBatch(address[] dest, uint256[] value, bytes[] func)']);
  const usdcTransfer = encodeFunctionData({ abi: parseAbi(['function transfer(address,uint256)']), args: [BOB, 1_000_000n] });
  const usdc = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
  const run = (data: Hex) => previewRequest({ method: 'eth_sendTransaction', params: [{ from: ALICE, to: ALICE, data, chainId: '0x1' }] }, { now: NOW }, { tokens: new StaticTokenRegistry() });
  const two = await run(encodeFunctionData({ abi, functionName: 'executeBatch', args: [[usdc, usdc], [usdcTransfer, usdcTransfer]] }));
  assert.equal(two.title, 'Run 2 calls from your account');
  assert.equal(detail(two, 'Format'), 'executeBatch(address[],bytes[])');
  const valued = await run(encodeFunctionData({ abi, functionName: 'executeBatch', args: [[usdc, BOB], [], [usdcTransfer, '0x']] }));
  assert.equal(valued.title, 'Run 2 calls from your account');
  assert.equal(detail(valued, 'Format'), 'executeBatch(address[],uint256[],bytes[])');
  // Arrays of different lengths are rejected by the account: not read as a batch.
  const bad = await run(encodeFunctionData({ abi, functionName: 'executeBatch', args: [[usdc, usdc], [usdcTransfer]] }));
  assert.notEqual(bad.decoding.decoder, 'smart_account');
});

test("WalletCore's batches: the account's own, and the calls of one a relayer or a session's executor submits", async () => {
  const { batchCalls } = await import('../src/evm/smart-account.ts');
  const WALLET_CORE = parseAbi([
    'function executeFromSelf((address target, uint256 value, bytes data)[] calls)',
    'function executeWithValidator((address target, uint256 value, bytes data)[] calls, address validator, bytes validationData)',
    'function executeFromExecutor((address target, uint256 value, bytes data)[] calls, (uint256 id, address executor, address validator, uint256 validUntil, uint256 validAfter, bytes preHook, bytes postHook, bytes signature) session)',
  ]);
  const calls = [{ target: USDC as Hex, value: 0n, data: transfer }, { target: WETH as Hex, value: 0n, data: approve }];
  // Sent by the account itself: decoded as its calls, like any smart account's batch.
  const p = await send(encodeFunctionData({ abi: WALLET_CORE, functionName: 'executeFromSelf', args: [calls] }));
  assert.deepEqual([p.title, detail(p, 'Format'), detail(p, 'Call 1')], ['Run 2 calls from your account', 'WalletCore executeFromSelf', 'Send 1 USDC (0xa0b8…eb48)']);
  // Submitted for the account by a relayer, or by a session's executor: the same calls read back.
  const relayed = batchCalls(encodeFunctionData({ abi: WALLET_CORE, functionName: 'executeWithValidator', args: [calls, '0x0000000000000000000000000000000000000001', `0x${'11'.repeat(65)}`] }))!;
  assert.deepEqual([relayed.standard, relayed.calls.map(c => c.target.toLowerCase())], ['WalletCore executeWithValidator', [USDC, WETH]]);
  const session = { id: 7n, executor: BOB as Hex, validator: '0x0000000000000000000000000000000000000001' as Hex, validUntil: 1_800_000_000n, validAfter: 0n, preHook: '0x' as Hex, postHook: '0x' as Hex, signature: `0x${'22'.repeat(65)}` as Hex };
  assert.equal(batchCalls(encodeFunctionData({ abi: WALLET_CORE, functionName: 'executeFromExecutor', args: [calls, session] }))!.calls.length, 2);
});

test('A call to the zero address is one back into the account only where the account’s code is known to take it so', async () => {
  // ERC-7821 has the zero address stand for the account, and Calibur follows it; other account code (Coinbase Smart
  // Wallet, Simple7702Account) calls the zero address as given, where nothing runs. Taken as the account for every
  // format, a revoke nested under the zero address was shown undoing an approval that, on such an account, stands.
  const revoke = encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [BOB, 0n] });
  const nested = encodeFunctionData({ abi: ACCOUNT, functionName: 'executeBatch', args: [[{ target: USDC, value: 0n, data: revoke }]] });
  const ZERO = '0x0000000000000000000000000000000000000000';
  const data = encodeFunctionData({ abi: ACCOUNT, functionName: 'executeBatch', args: [[{ target: USDC, value: 0n, data: approve }, { target: ZERO, value: 0n, data: nested }]] });
  const chain = (code: string) => ({ tokens: new StaticTokenRegistry(), rpc: { has: () => true, call: async (_c: number, m: string) => (m === 'eth_getCode' ? code : '0x') } });
  const at = (d: object, input = data) => previewRequest({ method: 'eth_sendTransaction', params: [{ from: ALICE, to: ALICE, data: input, chainId: '0x1' }] }, { now: NOW }, d as never);
  for (const d of [{ tokens: new StaticTokenRegistry() }, chain(`0xef0100${'22'.repeat(20)}`)]) {
    const p = await at(d);
    assert.equal(detail(p, 'Call 2'), 'Call the zero address (0x34fcd5be) (0x0000…0000)');
    assert.notEqual(p.decoding.status, 'full');
    assert.ok(!p.details.some(x => /Revoke/.test(x.value)));
    const w = p.warnings.find(x => x.code === 'smart_account_calls_unread')!;
    assert.equal(w.severity, 'danger');
    assert.match(w.message, /^Call 2: a call to the zero address carrying a batch of 1 call, which isn't laid out here: an account whose code follows ERC-7821 \(Calibur, Porto\) takes the zero address to mean itself, .* other account code calls the zero address, where nothing runs\. Which your account's code does isn't known here\. If it runs them, any of them can move what your account holds or approve a spender; if it doesn't, nothing they say happens\.$/);
  }
  // Coin sent there with calldata is lost on such an account: it read "Call your own account, with 10 ETH".
  const lost = await at({ tokens: new StaticTokenRegistry() }, encodeFunctionData({ abi: ACCOUNT, functionName: 'executeBatch', args: [[{ target: ZERO, value: 10n ** 19n, data: '0x12345678' }]] }));
  assert.match(lost.warnings.find(x => x.code === 'smart_account_zero_target')?.message ?? '', /other account code calls the zero address, where nothing runs, and the 10 ETH sent with it is lost\./);
  assert.equal(lost.title, 'Call the zero address (0x12345678)');
  // Where the account runs Calibur, it is the account: the nested batch is laid out as its own calls.
  const CALIBUR = '0x000000009b1d0af20d8c6d0a44e162d11f9b8f00';
  const laid = await at(chain(`0xef0100${CALIBUR.slice(2)}`));
  assert.equal(detail(laid, 'Call 2'), 'Revoke USDC approval for 0xb0b0…0002 (0xa0b8…eb48)');
  assert.ok(!codes(laid).includes('smart_account_calls_unread'));
});
