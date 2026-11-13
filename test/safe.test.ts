// Safe multisig: owner signatures (SafeTx) and execTransaction, with the delegatecall danger (the Bybit pattern).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { concatHex, encodeFunctionData, encodePacked, parseAbi, size, type Hex } from 'viem';
import { previewRequest } from '../src/preview.ts';
import { StaticTokenRegistry } from '../src/chains.ts';
import type { Dependencies } from '../src/types.ts';
import { ALICE, BOB } from '../mocks/data.ts';
import { codes, detail, NOW } from './helpers.ts';

const SAFE = '0x5afe00000000000000000000000000000000cafe', USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', ZERO = '0x0000000000000000000000000000000000000000';
const MULTISEND_CALL_ONLY = '0x9641d764fc13c8B624c04430C7356C1C7C8102e2';
const ABI = parseAbi(['function transfer(address,uint256)', 'function addOwnerWithThreshold(address owner, uint256 threshold)', 'function enableModule(address module)', 'function multiSend(bytes transactions)',
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)']);
const transfer = encodeFunctionData({ abi: ABI, functionName: 'transfer', args: [BOB, 1_000_000_000n] });
const deps: Dependencies = { tokens: new StaticTokenRegistry() };
const safeTx = (m: Record<string, unknown>) => ({
  domain: { chainId: 1, verifyingContract: SAFE },
  types: { EIP712Domain: [{ name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
    SafeTx: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }, { name: 'operation', type: 'uint8' }, { name: 'safeTxGas', type: 'uint256' }, { name: 'baseGas', type: 'uint256' },
      { name: 'gasPrice', type: 'uint256' }, { name: 'gasToken', type: 'address' }, { name: 'refundReceiver', type: 'address' }, { name: 'nonce', type: 'uint256' }] },
  primaryType: 'SafeTx',
  message: { to: USDC, value: '0', data: transfer, operation: 0, safeTxGas: '0', baseGas: '0', gasPrice: '0', gasToken: ZERO, refundReceiver: ZERO, nonce: '5', ...m },
});
const sign = (m: Record<string, unknown>, d = deps) => previewRequest({ method: 'eth_signTypedData_v4', params: [ALICE, JSON.stringify(safeTx(m))] }, { now: NOW }, d);
const multiSend = (calls: [number, string, bigint, Hex][]) => encodeFunctionData({ abi: ABI, functionName: 'multiSend', args: [concatHex(calls.map(([op, to, value, data]) => encodePacked(['uint8', 'address', 'uint256', 'uint256', 'bytes'], [op, to as Hex, value, BigInt(size(data)), data])))] });

test('A SafeTx signature: the call the Safe makes, decoded as its own transaction', async () => {
  const p = await sign({});
  assert.equal(p.title, 'Safe transaction: Send 1,000 USDC');
  assert.equal(p.decoding.decoder, 'safe_tx');
  assert.equal(detail(p, 'Safe'), SAFE);
  assert.equal(p.attention, 'none');
});

test('A delegatecall to anything but Safe’s libraries is danger (the Bybit pattern); MultiSend batches are unpacked', async () => {
  const bybit = await sign({ to: '0x96221423681a6d52e184d440a8efcebb105c7242', data: '0xa9059cbb', operation: 1 });
  assert.equal(bybit.attention, 'danger');
  assert.match(bybit.warnings.find(w => w.code === 'safe_delegatecall')!.message, /Bybit/);
  assert.equal(bybit.title, 'Safe transaction: Let 0x9622…7242 run its code as the Safe (delegatecall)');
  const batch = await sign({ to: MULTISEND_CALL_ONLY, operation: 1, data: multiSend([[0, USDC, 0n, transfer], [0, SAFE, 0n, encodeFunctionData({ abi: ABI, functionName: 'addOwnerWithThreshold', args: [BOB, 2n] })]]) });
  assert.equal(batch.title, 'Safe transaction: Run 2 calls from the Safe');
  assert.equal(detail(batch, 'Call 1'), 'Send 1,000 USDC (0xa0b8…eb48)');
  assert.equal(detail(batch, 'Call 2'), 'Add owner 0xb0b0…0002 (threshold 2) (0x5afe…cafe)');
  assert.ok(codes(batch).includes('safe_owners_change'));
  assert.ok(!codes(batch).includes('safe_delegatecall'));
  const module = await sign({ to: SAFE, data: encodeFunctionData({ abi: ABI, functionName: 'enableModule', args: [BOB] }) });
  assert.equal(module.title, 'Safe transaction: Enable module 0xb0b0…0002');
  assert.equal(module.attention, 'danger');
});

test('Gas refunds to a named receiver, a used nonce, and a signer who is not an owner', async () => {
  const refund = await sign({ gasPrice: '1000000000', baseGas: '50000', refundReceiver: BOB });
  assert.ok(codes(refund).includes('safe_gas_refund'));
  const rpc = { has: () => true, call: async (_c: number, _m: string, p: unknown[]) => ((p[0] as { data: string }).data === '0xaffed0e0' ? '0x9' : `0x${'0'.repeat(64)}`) };
  const stale = await sign({}, { ...deps, rpc });
  assert.ok(codes(stale).includes('safe_nonce_used'));
  assert.ok(codes(stale).includes('safe_not_owner'));
});

test('execTransaction: the same reading of what the Safe does, whoever submits it', async () => {
  const data = encodeFunctionData({ abi: ABI, functionName: 'execTransaction', args: [USDC, 0n, transfer, 0, 0n, 0n, 0n, ZERO, ZERO, `0x${'11'.repeat(130)}`] });
  const p = await previewRequest({ method: 'eth_sendTransaction', params: [{ from: ALICE, to: SAFE, data, chainId: '0x1' }] }, { now: NOW }, deps);
  assert.equal(p.title, 'Execute a Safe transaction: Send 1,000 USDC');
  assert.equal(detail(p, 'Owner signatures'), '2');
});

test('A SafeMessage: a message signed in the Safe’s name, its text shown when it is text', async () => {
  const msg = (message: string) => previewRequest({ method: 'eth_signTypedData_v4', params: [ALICE, JSON.stringify({ domain: { chainId: 1, verifyingContract: SAFE }, types: { EIP712Domain: [{ name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }], SafeMessage: [{ name: 'message', type: 'bytes' }] }, primaryType: 'SafeMessage', message: { message } })] }, { now: NOW }, deps);
  const text = await msg(`0x${Buffer.from('Sign in to app.example.com').toString('hex')}`);
  assert.equal(text.title, 'Sign a message as the Safe 0x5afe…cafe');
  assert.equal(detail(text, 'Message'), 'Sign in to app.example.com');
  const hash = await msg(`0x${'ab'.repeat(32)}`);
  assert.equal(detail(hash, 'Message hash'), `0x${'ab'.repeat(32)}`);
});

test('Safe 1.5.0 libraries are known, and an official migration is a caution, not a danger', async () => {
  const batch = await sign({ to: '0xA83c336B20401Af773B6219BA5027174338D1836', operation: 1, data: multiSend([[0, USDC, 0n, transfer]]) });
  assert.ok(!codes(batch).includes('safe_delegatecall'));
  const upgrade = await sign({ to: '0x6439e7ABD8Bb915A5263094784C5CF561c4172AC', operation: 1, data: '0xed007fc6' });
  assert.equal(upgrade.title, 'Safe transaction: Upgrade the Safe (SafeMigration 1.5.0)');
  assert.equal(upgrade.attention, 'caution');
});

// Safe's ERC-4337 module: SafeOp signatures. The two real operations below ran on-chain (Ethereum 0x064f9624…,
// Arbitrum 0xe5ed98a4…); their digests equal the module's own getOperationHash, and each signature recovers to an
// owner of its Safe (checked on 12 v0.3.0 operations on Ethereum and 9 v0.2.0 ones on Arbitrum, 2026-11-06).
const SAFE_OP_V03 = { domain: { chainId: 1, verifyingContract: '0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226' }, primaryType: 'SafeOp',
  types: { EIP712Domain: [{ name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
    SafeOp: [{ type: 'address', name: 'safe' }, { type: 'uint256', name: 'nonce' }, { type: 'bytes', name: 'initCode' }, { type: 'bytes', name: 'callData' }, { type: 'uint128', name: 'verificationGasLimit' }, { type: 'uint128', name: 'callGasLimit' }, { type: 'uint256', name: 'preVerificationGas' }, { type: 'uint128', name: 'maxPriorityFeePerGas' }, { type: 'uint128', name: 'maxFeePerGas' }, { type: 'bytes', name: 'paymasterAndData' }, { type: 'uint48', name: 'validAfter' }, { type: 'uint48', name: 'validUntil' }, { type: 'address', name: 'entryPoint' }] },
  message: { safe: '0x33a25CfB3064c9F23Ceb852095E9558B26D048c0', nonce: '33091642621071838969604660527104', initCode: '0x', callData: '0x541d63c8000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb480000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000044a9059cbb0000000000000000000000003282e08ea72e471b63f974e115147c4ab82580c1000000000000000000000000000000000000000000000000000000086721b28000000000000000000000000000000000000000000000000000000000',
    verificationGasLimit: '81360', callGasLimit: '42124', preVerificationGas: '49161', maxPriorityFeePerGas: '191316258', maxFeePerGas: '1044394660', paymasterAndData: '0x', validAfter: '0', validUntil: '0', entryPoint: '0x0000000071727de22e5e9d8baf0edac6f37da032' } };
const SAFE_OP_V02 = { domain: { chainId: 42161, verifyingContract: '0xa581c4A4DB7175302464fF3C06380BC3270b4037' }, primaryType: 'SafeOp',
  types: { EIP712Domain: SAFE_OP_V03.types.EIP712Domain,
    SafeOp: [{ type: 'address', name: 'safe' }, { type: 'uint256', name: 'nonce' }, { type: 'bytes', name: 'initCode' }, { type: 'bytes', name: 'callData' }, { type: 'uint256', name: 'callGasLimit' }, { type: 'uint256', name: 'verificationGasLimit' }, { type: 'uint256', name: 'preVerificationGas' }, { type: 'uint256', name: 'maxFeePerGas' }, { type: 'uint256', name: 'maxPriorityFeePerGas' }, { type: 'bytes', name: 'paymasterAndData' }, { type: 'uint48', name: 'validAfter' }, { type: 'uint48', name: 'validUntil' }, { type: 'address', name: 'entryPoint' }] },
  message: { safe: '0x7e395F30Dc457832dF7990FBaF59ec60F968d1ED', nonce: '206276', initCode: '0x', callData: '0x7bb37428000000000000000000000000af88d065e77c8cc2239327c5edb3a432268e58310000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000044a9059cbb000000000000000000000000aec850549ce6ba2bd7607c9fbcbff6a4b92b219000000000000000000000000000000000000000000000000000000000042c1d80000000000000000000000000000000000000000000000000000000005afe003134623562383766346530326233353866303664343432343537373263',
    callGasLimit: '132458', verificationGasLimit: '131638', preVerificationGas: '64055', maxFeePerGas: '0', maxPriorityFeePerGas: '0', paymasterAndData: '0x', validAfter: '0', validUntil: '0', entryPoint: '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789' } };
/** Safe4337Module.getOperationHash for each operation, read on-chain. */
const V03_DIGEST = '0x53123bfaa9c0f0a00abf31a45b1174695e590cc28c1fc223c9e0b4f2f046fe7b', V02_DIGEST = '0xdf68431664e31c5a3b7f3549b4e3fea2d4114eacc3926635a7802681f6bbce1b';
const signOp = (op: typeof SAFE_OP_V03, m: Record<string, unknown> = {}, domain: Record<string, unknown> = {}, d = deps) =>
  previewRequest({ method: 'eth_signTypedData_v4', params: [ALICE, JSON.stringify({ ...op, domain: { ...op.domain, ...domain }, message: { ...op.message, ...m } })] }, { now: NOW }, d);
const execute = (to: string, data: Hex, operation: number) => encodeFunctionData({ abi: parseAbi(['function executeUserOp(address to, uint256 value, bytes data, uint8 operation)']), functionName: 'executeUserOp', args: [to as Hex, 0n, data, operation] });

test('A SafeOp (Safe’s 4337 module, v0.3.0 and v0.2.0): the call the Safe makes, as for a Safe transaction', async () => {
  const v03 = await signOp(SAFE_OP_V03);
  assert.equal(v03.title, 'Safe operation: Send 36,090 USDC');
  assert.equal(v03.decoding.decoder, 'safe_4337_op');
  assert.equal(detail(v03, 'Module'), 'Safe4337Module v0.3.0 (0x75cf11467937ce3f2f357ce24ffc3dbf8fd5c226)');
  assert.equal(detail(v03, 'EntryPoint'), 'EntryPoint v0.7 (0x0000000071727de22e5e9d8baf0edac6f37da032)');
  assert.equal(detail(v03, 'Valid until'), 'no expiry');
  assert.match(String(detail(v03, 'Maximum gas cost')), /ETH, from the account$/);
  assert.equal(detail(v03, 'EIP-712 digest'), V03_DIGEST);
  assert.equal(v03.attention, 'none');
  const v02 = await signOp(SAFE_OP_V02 as unknown as typeof SAFE_OP_V03);
  assert.equal(v02.title, 'Safe operation: Send 70 USDC');
  assert.equal(detail(v02, 'EntryPoint'), 'EntryPoint v0.6 (0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789)');
  assert.equal(detail(v02, 'EIP-712 digest'), V02_DIGEST);
});

test('SafeOp checks: delegatecalls, an unknown module or EntryPoint, a plain call to MultiSend, and a used nonce', async () => {
  const rogue = await signOp(SAFE_OP_V03, { callData: execute('0x96221423681a6d52e184d440a8efcebb105c7242', '0xa9059cbb', 1) });
  assert.equal(rogue.attention, 'danger');
  assert.equal(rogue.title, 'Safe operation: Let 0x9622…7242 run its code as the Safe (delegatecall)');
  assert.ok(codes(await signOp(SAFE_OP_V03, {}, { verifyingContract: BOB })).includes('unknown_safe_module'));
  assert.ok(codes(await signOp(SAFE_OP_V03, { entryPoint: '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789' })).includes('safe_op_entrypoint_mismatch'));
  const plain = await signOp(SAFE_OP_V03, { callData: execute(MULTISEND_CALL_ONLY, multiSend([[0, USDC, 0n, transfer]]), 0) });
  assert.match(plain.warnings.find(w => w.code === 'safe_multisend_call')!.message, /runs from the MultiSend contract, not from the Safe/);
  const batch = await signOp(SAFE_OP_V03, { callData: execute(MULTISEND_CALL_ONLY, multiSend([[0, USDC, 0n, transfer], [0, USDC, 0n, transfer]]), 1) });
  assert.equal(batch.title, 'Safe operation: Run 2 calls from the Safe');
  assert.ok(codes(await signOp(SAFE_OP_V03, { callData: transfer })).includes('safe_op_unsupported_call'));
  assert.ok(codes(await signOp(SAFE_OP_V03, { validUntil: String(NOW / 1000 - 60) })).includes('safe_op_expired'));
  // EntryPoint.getNonce past the operation's nonce: it has run. isOwner and isModuleEnabled answer 1.
  const rpc = { has: () => true, call: async (_c: number, _m: string, p: unknown[]) => (p[0] as { data: string }).data.startsWith('0x35567e1a') ? `0x${'0'.repeat(63)}9` : `0x${'0'.repeat(63)}1` };
  const used = await signOp(SAFE_OP_V03, {}, {}, { ...deps, rpc });
  assert.ok(codes(used).includes('userop_nonce_used'));
  assert.ok(!codes(used).includes('safe_not_owner') && !codes(used).includes('safe_module_not_enabled'));
});

// execTransaction simulated for a SafeTx: the hash approved for enough owners, then the Safe's configuration read again.
import { configChanges, SAFE_SINGLETONS, type SafeConfig } from '../src/safe-sim.ts';
import { concatHex as concat, decodeFunctionData as decodeCall, encodeAbiParameters as enc, hashTypedData, keccak256 as k256 } from 'viem';
import type { SimulationRequest } from '../src/types.ts';

const OWNERS = ['0x2000000000000000000000000000000000000002', '0x1000000000000000000000000000000000000001', '0x3000000000000000000000000000000000000003'];
const SINGLETON = '0x41675c099f32341bf84bfc5382af534df5c7461a';
const base: SafeConfig = { owners: OWNERS, threshold: 2n, singleton: SINGLETON, guard: ZERO, fallbackHandler: '0xfd0732dc9e303f09fcef3a7388ad10a83459ec99', modules: [] };

test('What a Safe transaction changes in the Safe: code, owners, threshold, guard, fallback handler, modules', () => {
  const codes = (after: Partial<SafeConfig>) => configChanges(base, { ...base, ...after }).map(c => `${c.severity}:${c.code}`);
  assert.deepEqual(codes({}), []);
  assert.deepEqual(codes({ singleton: '0xbdd077f651ebe7f7b3ce16fe5f2b025be2969516' }), ['danger:safe_code_replaced']);
  assert.deepEqual(codes({ singleton: '0xff51a5898e281db6dfc7855790607438df2ca44b' }), ['caution:safe_upgrade']);
  assert.ok(SAFE_SINGLETONS[SINGLETON]);
  assert.deepEqual(codes({ owners: [...OWNERS.slice(1), BOB.toLowerCase()], threshold: 1n }), ['caution:safe_owners_added', 'caution:safe_owners_removed', 'caution:safe_threshold_changed']);
  assert.deepEqual(codes({ guard: BOB.toLowerCase(), fallbackHandler: ZERO, modules: [BOB.toLowerCase()] }), ['caution:safe_guard_changed', 'caution:safe_fallback_changed', 'danger:safe_module_enabled']);
});

test('A SafeTx is simulated through execTransaction itself, approved by enough owners, and a replaced singleton is danger', async () => {
  const SAFE_ABI = parseAbi(['function getStorageAt(uint256 offset, uint256 length) view returns (bytes)', 'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)']);
  const HASH = `0x${'ab'.repeat(32)}` as Hex;
  const word = (v: bigint) => enc([{ type: 'uint256' }], [v]);
  const slotBytes = (a: string) => enc([{ type: 'bytes' }], [`0x${a.slice(2).padStart(64, '0')}` as Hex]);
  // After a takeover (`broken`), the Safe's code is the attacker's: only the proxy's own masterCopy() still answers.
  const view = (afterSingleton?: string, broken = false) => (data: string) => {
    const sel = data.slice(0, 10);
    if (sel === '0xa619486e') return enc([{ type: 'address' }], [(afterSingleton ?? SINGLETON) as Hex]);
    if (broken) return '0x';
    if (sel === '0xa0e67e2b') return enc([{ type: 'address[]' }], [OWNERS as Hex[]]);
    if (sel === '0xe75235b8') return word(2n);
    if (sel === '0xaffed0e0') return word(7n);
    if (sel === '0xd8d11f78') return HASH;
    if (sel === '0xcc2f8452') return enc([{ type: 'address[]' }, { type: 'address' }], [[], '0x0000000000000000000000000000000000000001']);
    if (sel === '0x5624b25b') {
      const [offset] = decodeCall({ abi: SAFE_ABI, data: data as Hex }).args as [bigint, bigint];
      return slotBytes(offset === 0n ? afterSingleton ?? SINGLETON : offset === BigInt('0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5') ? base.fallbackHandler : ZERO);
    }
    if (sel === '0x2f54bf6e') return word(1n);
    return '0x';
  };
  const batches: SimulationRequest[][] = [];
  const d = (afterSingleton?: string, broken = false): Dependencies => ({ ...deps,
    rpc: { has: () => true, call: async (_c: number, m: string, p: unknown[]) => m === 'eth_call' ? view()((p[0] as { data: string }).data) : '0x' },
    simulator: { simulate: async () => null, simulateBatch: async rs => { batches.push(rs); return rs.map((r, i) => ({ status: 'success' as const, source: 'mock', transfers: [], returnData: i === 0 ? word(1n) : view(afterSingleton, broken)(r.data) })); } } });
  // The Bybit pattern: a delegatecall whose calldata looks like a transfer, run as the Safe, replaces its singleton.
  const bybit = await sign({ to: '0x96221423681a6d52e184d440a8efcebb105c7242', data: transfer, operation: 1 }, d('0xbdd077f651ebe7f7b3ce16fe5f2b025be2969516', true));
  assert.match(bybit.warnings.find(w => w.code === 'safe_code_replaced')?.message ?? '', /runs the code at 0xbdd077f651ebe7f7b3ce16fe5f2b025be2969516, which isn't one of Safe's own \(the Safe no longer even answers as a Safe\)/);
  assert.match(bybit.decoding.notes.join(' '), /execTransaction itself/);
  // The request: from an owner (the first, as the signer isn't one), who signs with the ECDSA stand-in that the
  // replaced ecrecover attributes to them over the hash; the lowest other owner approves on-chain (v = 1).
  const exec = batches.at(-1)![0];
  assert.equal(exec.to, SAFE);
  assert.equal(exec.account, SAFE);
  assert.equal(exec.from, OWNERS[0]);
  const slot = (o: string) => k256(enc([{ type: 'bytes32' }, { type: 'bytes32' }], [HASH, k256(enc([{ type: 'address' }, { type: 'uint256' }], [o as Hex, 8n]))]));
  assert.deepEqual(Object.keys(exec.stateOverrides![SAFE].stateDiff!), [slot(OWNERS[1])]);
  assert.ok(exec.stateOverrides!['0x0000000000000000000000000000000000000001']?.code?.includes(OWNERS[0].slice(2)), 'ecrecover stands in for the owner');
  const { STUB_SIGNATURE } = await import('../src/erc4337-sim.ts');
  const signatures = (decodeCall({ abi: SAFE_ABI, data: exec.data as Hex }).args as unknown as unknown[])[9] as string;
  // Ascending by owner: 0x1000… (approval), then 0x2000… (the stand-in signature).
  assert.equal(signatures, `0x${OWNERS[1].slice(2).padStart(64, '0')}${'00'.repeat(32)}01${STUB_SIGNATURE.slice(2)}`);
  // Moving to an official singleton is an upgrade, a caution.
  const upgrade = await sign({ to: '0x96221423681a6d52e184d440a8efcebb105c7242', data: transfer, operation: 1 }, d('0xff51a5898e281db6dfc7855790607438df2ca44b'));
  assert.ok(codes(upgrade).includes('safe_upgrade') && !codes(upgrade).includes('safe_code_replaced'));

  // A refund in the native token is paid at the lower of the SafeTx's gas price and the transaction's: nothing at no
  // price. With a base fee to read, the execution runs again at the price a transaction would pay now (1 gwei and a
  // 0.1 gwei tip), whoever submits it able to pay for its gas, and that run is the one shown.
  const runs: SimulationRequest[][] = [];
  const refunding: Dependencies = { ...deps,
    rpc: { has: () => true, call: async (_c: number, m: string, p: unknown[]) => m === 'eth_call' ? view()((p[0] as { data: string }).data) : m === 'eth_getBlockByNumber' ? { baseFeePerGas: '0x3b9aca00' } : m === 'eth_maxPriorityFeePerGas' ? '0x5f5e100' : '0x' },
    simulator: { simulate: async () => null, simulateBatch: async rs => { runs.push(rs); return rs.map((r, i) => ({ status: 'success' as const, source: 'mock', gasUsed: 80_000n,
      transfers: i === 0 && r.gasPrice ? [{ asset: 'native', from: SAFE, to: BOB.toLowerCase(), raw: 130_000n * r.gasPrice }] : [], returnData: i === 0 ? word(1n) : view()(r.data) })); } } };
  const refund = await sign({ gasPrice: '2000000000', baseGas: '50000', refundReceiver: BOB }, refunding);
  assert.equal(runs.length, 2);
  assert.equal(runs[0][0].gasPrice, undefined);
  assert.deepEqual([runs[1][0].gasPrice, runs[1][0].baseFee, runs[1][0].gas], [1_100_000_000n, 1_000_000_000n, 180_000n]);
  assert.ok(runs[1][0].stateOverrides![OWNERS[0]]?.balance);
  assert.deepEqual(refund.assetChanges.filter(c => c.asset === 'native').map(c => [c.direction, c.raw]), [['out', (130_000n * 1_100_000_000n).toString()]]);
  assert.match(refund.decoding.notes.join(' '), /depends on the gas price of the transaction that runs it \(its gas refund is paid at the lower of its own gas price and the transaction's\): it was simulated at the price a transaction would pay now, 1\.1 gwei/);

  // Asked for a trace (context.trace), the execution is traced as it was simulated: execTransaction, from the owner
  // standing in for whoever submits it, with the stand-ins in place.
  const asked: SimulationRequest[][] = [];
  const tracing: Dependencies = { ...refunding, simulator: { ...refunding.simulator!, trace: async rs => { asked.push(rs); return rs.map(r => ({ status: 'success' as const, source: 'local', transfers: [], trace: { type: 'call' as const, from: r.from, to: r.to, value: 0n, input: r.data, gas: 1_000_000n, gasUsed: 80_000n } })); } } };
  const traced = await previewRequest({ method: 'eth_signTypedData_v4', params: [ALICE, JSON.stringify(safeTx({}))] }, { now: NOW, trace: true }, tracing);
  assert.deepEqual([traced.trace!.calls.length, traced.trace!.calls[0].to, traced.trace!.calls[0].selector, traced.trace!.agrees], [1, SAFE, '0x6a761202', true]);
  assert.equal(asked[0].length, 1);
  assert.ok(asked[0][0].stateOverrides!['0x0000000000000000000000000000000000000001'], 'the trace runs with the same stand-ins');
  assert.equal((await sign({}, tracing)).trace, undefined);
});

test('Safe4337MultiChainSignatureModule (EntryPoint v0.9): its SafeOps, and a Merkle root signature that names no operations', async () => {
  const MC = '0x22939e839e3c0f479b713eaf95e0df128554aead', EP9 = '0x433709009b8330fda32311df1c2afa402ed8d009';
  const op = await signOp(SAFE_OP_V03, { entryPoint: EP9 }, { verifyingContract: MC });
  assert.ok(!codes(op).includes('unknown_safe_module') && !codes(op).includes('safe_op_entrypoint_mismatch'), codes(op).join());
  assert.match(String(detail(op, 'EntryPoint')), /^EntryPoint v0\.9 /);
  const root = await previewRequest({ method: 'eth_signTypedData_v4', params: [OWNERS[0], JSON.stringify({ domain: { verifyingContract: MC },
    types: { EIP712Domain: [{ name: 'verifyingContract', type: 'address' }], MerkleTreeRoot: [{ name: 'merkleTreeRoot', type: 'bytes32' }] }, primaryType: 'MerkleTreeRoot', message: { merkleTreeRoot: `0x${'cd'.repeat(32)}` } })] }, { now: NOW }, deps);
  assert.equal(root.attention, 'danger');
  assert.ok(codes(root).includes('safe_multichain_root'));
  assert.equal(root.decoding.decoder, 'safe_multichain_root');
});

test('A multi-chain Safe root, with the operations the wallet built it from: shown when they make up the root exactly', async () => {
  const MC = '0x22939e839e3c0f479b713eaf95e0df128554aead', EP9 = '0x433709009b8330fda32311df1c2afa402ed8d009';
  const types = { SafeOp: SAFE_OP_V03.types.SafeOp };
  const op = (chainId: number, nonce: string) => ({ chainId, operation: { ...SAFE_OP_V03.message, nonce, entryPoint: EP9 } });
  const ops = [op(1, '7'), op(42161, '8'), op(42161, '9')];
  // The tree as OpenZeppelin's merkle-tree builds it: leaves (each SafeOp's digest on its chain) sorted, then a
  // complete binary tree in an array with the leaves at its end; pairs hashed smaller first, as the module does.
  const leaves = ops.map(o => hashTypedData({ domain: { chainId: o.chainId, verifyingContract: MC }, types, primaryType: 'SafeOp', message: o.operation as never })).sort((a, z) => (BigInt(a) < BigInt(z) ? -1 : 1));
  const pairHash = (a: Hex, z: Hex) => k256(BigInt(a) < BigInt(z) ? concat([a, z]) : concat([z, a]));
  const tree: Hex[] = new Array(2 * leaves.length - 1);
  leaves.forEach((l, i) => { tree[tree.length - 1 - i] = l; });
  for (let i = tree.length - 1 - leaves.length; i >= 0; i--) tree[i] = pairHash(tree[2 * i + 1], tree[2 * i + 2]);
  const sign = (root: Hex, safeOperations?: typeof ops) => previewRequest({ method: 'eth_signTypedData_v4', params: [OWNERS[0], JSON.stringify({ domain: { verifyingContract: MC },
    types: { EIP712Domain: [{ name: 'verifyingContract', type: 'address' }], MerkleTreeRoot: [{ name: 'merkleTreeRoot', type: 'bytes32' }] }, primaryType: 'MerkleTreeRoot', message: { merkleTreeRoot: root } })] }, { now: NOW, ...(safeOperations && { safeOperations }) }, deps);
  const shown = await sign(tree[0], ops);
  assert.ok(codes(shown).includes('safe_multichain_root_verified') && !codes(shown).includes('safe_multichain_root'), codes(shown).join());
  assert.match(shown.title, /^Sign Safe operations: 3 operations on 2 chains$/);
  assert.ok(String(detail(shown, 'Operation 2 (Arbitrum One)')).endsWith(`from the Safe ${SAFE_OP_V03.message.safe.slice(0, 6).toLowerCase()}…${SAFE_OP_V03.message.safe.slice(-4).toLowerCase()}`), String(detail(shown, 'Operation 2 (Arbitrum One)')));
  // One left out: the root covers an operation that isn't shown.
  const partial = await sign(tree[0], ops.slice(0, 2));
  assert.ok(codes(partial).includes('safe_multichain_root_mismatch'));
  assert.equal(partial.attention, 'danger');
  // A single operation's root is its own digest.
  assert.ok(codes(await sign(leaves[0], [ops.find(o => hashTypedData({ domain: { chainId: o.chainId, verifyingContract: MC }, types, primaryType: 'SafeOp', message: o.operation as never }) === leaves[0])!])).includes('safe_multichain_root_verified'));
});

test('A passkey owner’s verifiers stood in for: the precompile where named, the fallback verifier after its real code, or nothing to stand in for', async () => {
  const { passkeyVerifiersStandIn, p256Accepting, verifierAccepting } = await import('../src/erc4337-sim.ts');
  const FALLBACK = '0xa86e0054c51e4894d88762a017ecc5e5235f5dba', P256 = '0x0000000000000000000000000000000000000100', NONE = `0x${'00'.repeat(20)}`;
  const deps = (code: string) => ({ rpc: { has: () => true, call: async () => code } }) as unknown as Dependencies;
  const both = await passkeyVerifiersStandIn(deps('0x6001'), 137, { precompile: P256, fallback: FALLBACK });
  assert.equal(both?.stateOverrides?.[P256]?.code, p256Accepting());
  assert.equal(both?.stateOverrides?.[FALLBACK]?.code, verifierAccepting());
  assert.ok(Object.values(both?.stateOverrides ?? {}).some(o => o.code === '0x6001'), 'the fallback’s own code, moved');
  const onlyFallback = await passkeyVerifiersStandIn(deps('0x6001'), 137, { precompile: NONE, fallback: FALLBACK });
  assert.ok(!onlyFallback?.stateOverrides?.[P256] && onlyFallback?.stateOverrides?.[FALLBACK]);
  // A fallback with no code and no precompile: nothing that would verify, so no stand-in (the ECDSA one is used).
  assert.equal(await passkeyVerifiersStandIn(deps('0x'), 137, { precompile: NONE, fallback: FALLBACK }), null);
  // HyperEVM has no P256VERIFY: the precompile a passkey names there answers nothing, so only its fallback is stood in for.
  assert.equal(await passkeyVerifiersStandIn(deps('0x'), 999, { precompile: P256, fallback: NONE }), null);
  const hyper = await passkeyVerifiersStandIn(deps('0x6001'), 999, { precompile: P256, fallback: FALLBACK });
  assert.ok(!hyper?.stateOverrides?.[P256] && hyper?.stateOverrides?.[FALLBACK]);
});

test('A passkey owner through Safe’s WebAuthn shared signer: a contract signature in Safe’s layout, decoded as its WebAuthn library requires', async () => {
  const { safeSignatures, safeWebAuthnStub, sharedSignerVerifiers, SAFE_WEBAUTHN_SHARED_SIGNER } = await import('../src/safe-sim.ts');
  const { P256_STUB, STUB_SIGNATURE } = await import('../src/erc4337-sim.ts');
  const passkey = safeWebAuthnStub();
  // WebAuthn.castSignature: abi.encode(authenticatorData, clientDataFields, r, s), canonically (offsets 0x80 and
  // 0x80 + 32 + the padded authenticator data, nothing after the client data fields).
  const w = (i: number) => BigInt(`0x${passkey.slice(2 + i * 64, 66 + i * 64)}`);
  const authLength = Number(w(4)), fieldsAt = 0x80 + 32 + Math.ceil(authLength / 32) * 32;
  assert.equal(w(0), 0x80n);
  assert.equal(w(1), BigInt(fieldsAt));
  assert.equal(`0x${w(2).toString(16)}`, P256_STUB.r);
  assert.equal(`0x${w(3).toString(16)}`, P256_STUB.s);
  assert.equal(authLength, 37);
  assert.equal(passkey.slice(2 + 160 * 2 + 64, 2 + 160 * 2 + 66), '05', 'user present and verified');
  const fieldsLength = Number(BigInt(`0x${passkey.slice(2 + fieldsAt * 2, 2 + fieldsAt * 2 + 64)}`));
  assert.equal(size(passkey), fieldsAt + 32 + Math.ceil(fieldsLength / 32) * 32);
  // In a Safe's signatures, owners ascending: the passkey owner's part names it, the offset of its data, type 0; the
  // data (its length, then it) after every 65-byte part.
  const other = '0xffffffffffffffffffffffffffffffffffffffff';
  const sigs = safeSignatures([{ owner: SAFE_WEBAUTHN_SHARED_SIGNER, contract: passkey }, { owner: other, signature: STUB_SIGNATURE }]);
  assert.equal(sigs.slice(2, 66), SAFE_WEBAUTHN_SHARED_SIGNER.slice(2).padStart(64, '0'));
  assert.equal(BigInt(`0x${sigs.slice(66, 130)}`), 130n);
  assert.equal(sigs.slice(130, 132), '00');
  assert.equal(`0x${sigs.slice(132, 262)}`, STUB_SIGNATURE);
  assert.equal(BigInt(`0x${sigs.slice(262, 326)}`), BigInt(size(passkey)));
  assert.equal(`0x${sigs.slice(326)}`, passkey);
  // The verifiers, from the configure call a deploying Safe's setup makes: the precompile's address in bits 160-175,
  // the fallback verifier's below.
  const configure = encodeFunctionData({ abi: parseAbi(['function configure((uint256 x, uint256 y, uint176 verifiers) signer)']), functionName: 'configure', args: [{ x: 1n, y: 2n, verifiers: (0x100n << 160n) | 0xa86e0054c51e4894d88762a017ecc5e5235f5dban }] });
  assert.deepEqual(await sharedSignerVerifiers({} as Dependencies, 42161, ALICE, `0x${'ab'.repeat(40)}${configure.slice(2)}${'cd'.repeat(20)}`),
    { precompile: '0x0000000000000000000000000000000000000100', fallback: '0xa86e0054c51e4894d88762a017ecc5e5235f5dba' });
});
