// Safe multisig: owner signatures (SafeTx) and execTransaction, with the delegatecall danger (the Bybit pattern).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { concatHex, encodeAbiParameters, encodeFunctionData, encodePacked, parseAbi, size, stringToHex, type Hex } from 'viem';
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

test('A SafeTx is simulated through execTransaction itself, signed by enough owners, and a replaced singleton is danger', async () => {
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
  // replaced ecrecover attributes to them over the hash; the lowest other owner signs with a stand-in of its own,
  // attributed to it the same way (nothing in the Safe's storage stands in for a signature: a guard that reads the
  // signatures itself finds signatures).
  const exec = batches.at(-1)![0];
  assert.equal(exec.to, SAFE);
  assert.equal(exec.account, SAFE);
  assert.equal(exec.from, OWNERS[0]);
  assert.equal(exec.stateOverrides![SAFE], undefined);
  const recover = exec.stateOverrides!['0x0000000000000000000000000000000000000001']?.code ?? '';
  assert.ok(recover.includes(OWNERS[0].slice(2)) && recover.includes(OWNERS[1].slice(2)), 'ecrecover stands in for both owners');
  const { STUB_SIGNATURE, stubSignature } = await import('../src/erc4337-sim.ts');
  const signatures = (decodeCall({ abi: SAFE_ABI, data: exec.data as Hex }).args as unknown as unknown[])[9] as string;
  // Ascending by owner: 0x1000… (its own stand-in signature), then 0x2000… (the signer's).
  assert.equal(signatures, `0x${stubSignature(1).slice(2)}${STUB_SIGNATURE.slice(2)}`);
  // A Safe that needs more than sixteen owners keeps to approvals for the others (Safe's approvedHashes, its
  // signature type 1), set with a storage override.
  const { approvalsFor } = await import('../src/safe-sim.ts');
  const many = Array.from({ length: 18 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}`);
  const wide = approvalsFor({ ...base, owners: many, threshold: 17n }, HASH, { owner: many[0], signature: STUB_SIGNATURE }, true)!;
  assert.deepEqual([wide.cosigners, Object.keys(wide.stateDiff).length], [undefined, 16]);
  const slot = (o: string) => k256(enc([{ type: 'bytes32' }, { type: 'bytes32' }], [HASH, k256(enc([{ type: 'address' }, { type: 'uint256' }], [o as Hex, 8n]))]));
  assert.equal(Object.keys(wide.stateDiff)[0], slot(many[1]));
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
  const sign = (root: Hex, safeOperations?: typeof ops, chainId?: number) => previewRequest({ method: 'eth_signTypedData_v4', params: [OWNERS[0], JSON.stringify({ domain: { verifyingContract: MC },
    types: { EIP712Domain: [{ name: 'verifyingContract', type: 'address' }], MerkleTreeRoot: [{ name: 'merkleTreeRoot', type: 'bytes32' }] }, primaryType: 'MerkleTreeRoot', message: { merkleTreeRoot: root } })] }, { now: NOW, ...(chainId && { chainId }), ...(safeOperations && { safeOperations }) }, deps);
  const shown = await sign(tree[0], ops);
  // Operations of two Safes: what one receives isn't netted against what the other sends, and a caution names both.
  const other = { chainId: 42161, operation: { ...ops[1].operation, safe: '0x5ca1ab1e00000000000000000000000000000007' } };
  const two = [ops[0], other];
  const [l0, l1] = two.map(o => hashTypedData({ domain: { chainId: o.chainId, verifyingContract: MC }, types, primaryType: 'SafeOp', message: o.operation as never }));
  const both = await sign(pairHash(l0, l1), two, 1);
  assert.ok(codes(both).includes('safe_multichain_root_verified'), codes(both).join());
  assert.match(both.warnings.find(w => w.code === 'operations_multiple_accounts')?.message ?? '', /^These operations run from 2 different accounts \(0x33a2…48c0, 0x5ca1…0007\)/);
  assert.equal(both.attention, 'caution');
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

test('Several operations’ balance changes (a multi-chain root’s, a supertransaction’s): each on its chain, and one account’s incoming amounts not netted against another’s outgoing ones', async () => {
  const { combineChanges } = await import('../src/operation-changes.ts');
  const { PreviewBuilder } = await import('../src/format.ts');
  const A = '0x00000000000000000000000000000000000000a1', B = '0x00000000000000000000000000000000000000b2';
  const change = (account: string, direction: 'in' | 'out', amount: string) => ({ direction, account, amount, symbol: 'TKN', basis: 'simulated_state' as const });
  // One account: everything, each change with its operation's chain (none left out for being off the request's).
  const one = new PreviewBuilder();
  assert.deepEqual(combineChanges([{ label: 'Operation 1 (Ethereum)', chainId: 1, sender: A, changes: [change(A, 'out', '5')] }, { label: 'Operation 2 (Base)', chainId: 8453, sender: A.toUpperCase().replace('0X', '0x'), changes: [change(A, 'in', '5')] }], one)
    .map(c => [c.direction, c.chainId]), [['out', 1], ['in', 8453]]);
  assert.deepEqual(one.warnings, []);
  // Two: B's incoming 100 isn't listed against A's outgoing 100; it's described with its operation, and a caution says why.
  const two = new PreviewBuilder();
  const ops = [{ label: 'Operation 1 (Base)', chainId: 8453, sender: A, changes: [change(A, 'out', '100')] }, { label: 'Operation 2 (Base)', chainId: 8453, sender: B, changes: [change(B, 'in', '100'), change(B, 'out', '1')] }];
  assert.deepEqual(combineChanges(ops, two).map(c => [c.account, c.direction, c.amount]), [[A, 'out', '100'], [B, 'out', '1']]);
  assert.deepEqual(two.details, [{ label: `Operation 2 (Base): received by 0x0000…00b2 (not in the balance changes)`, value: '+100 TKN' }]);
  assert.deepEqual(two.warnings.map(w => [w.code, w.severity]), [['operations_multiple_accounts', 'caution']]);
  // The connected account's incoming amounts are listed.
  assert.deepEqual(combineChanges(ops, new PreviewBuilder(), B).map(c => [c.account, c.direction, c.amount]), [[A, 'out', '100'], [B, 'in', '100'], [B, 'out', '1']]);
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

test('A Zeal passkey owner’s stand-in: a real P-256 assertion by a passkey made up for the run, in the form the wallet signs in', async () => {
  const { createPublicKey, verify } = await import('node:crypto');
  const { decodeAbiParameters, hexToString, sha256 } = await import('viem');
  const { base64url, STUB_SIGNATURE } = await import('../src/erc4337-sim.ts');
  const { safeSignatures, standInPasskey, zealAssertion, zealFormIn, ZEAL_DEFAULT_FORM } = await import('../src/safe-sim.ts');
  const { x, y } = standInPasskey();
  const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: Buffer.from(x.slice(2), 'hex').toString('base64url'), y: Buffer.from(y.slice(2), 'hex').toString('base64url') }, format: 'jwk' });
  // What Zeal's signer checks (FreshCryptoLib's WebAuthn_format): the challenge in clientDataJSON at challengeOffset,
  // and a P-256 signature over sha256(authenticatorData || sha256(clientDataJSON)), which node's ECDSA (SHA-256 of
  // authenticatorData || sha256(clientDataJSON)) verifies.
  const check = (assertion: Hex, challenge: Hex) => {
    const [authenticatorData, clientData, offset, [r, s]] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes' }, { type: 'uint256' }, { type: 'uint256[2]' }], assertion);
    const json = hexToString(clientData);
    assert.equal(json.slice(Number(offset), Number(offset) + 43), base64url(challenge));
    const rs = Buffer.from(`${r.toString(16).padStart(64, '0')}${s.toString(16).padStart(64, '0')}`, 'hex');
    assert.ok(verify('sha256', Buffer.from(concatHex([authenticatorData, sha256(clientData)]).slice(2), 'hex'), { key, dsaEncoding: 'ieee-p1363' }, rs), 'the stand-in passkey’s signature verifies');
    return { authenticatorData, json, offset: Number(offset) };
  };
  const challenge = sha256('0x01');
  // No earlier assertion to go by: the form of origin https://passkey.zealwallet.com, as Zeal's wallets sign there
  // (its challenge at 0x24, where the origin check wants it; the rpId hash of passkey.zealwallet.com, flags 0x1d).
  const site = check(zealAssertion(challenge), challenge);
  assert.equal(site.offset, 0x24);
  assert.equal(site.json, `{"type":"webauthn.get","challenge":"${base64url(challenge)}","origin":"https://passkey.zealwallet.com"}`);
  assert.equal(site.authenticatorData, ZEAL_DEFAULT_FORM.authenticatorData);
  assert.equal(site.authenticatorData, '0xacb1764ad8b97c3d25829c27cda7f041206c01e7aafbb89a7da02856f414854b1d00000000');
  // The form of an earlier assertion, from among a Safe's signatures (Zeal's Android app's, as on Ethereum, Nov 2026):
  // its authenticator data and clientDataJSON kept, only the challenge replaced, so the origin check scans as it will.
  const OWNER = '0x9cea6f7fb7cb7e4e8a9eff0c3a29813ce69f39f6', OTHER = '0x97c09d1d3f757bbdacdeea4e8c31e5b6ce10b319';
  const android = `{"type":"webauthn.get","challenge":"APvRJ3b_o37trvMyO8Py1aksI5DmiOfDx-RwCymZg7o","origin":"android:apk-key-hash:agY2kcQcEUA_2HxGSV_nwMzgCrpgZ8tky1JaJwbOQSE","androidPackageName":"app.zeal.wallet"}`;
  const earlier = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes' }, { type: 'uint256' }, { type: 'uint256[2]' }], [`0x${'ac'.repeat(32)}1d00000000`, stringToHex(android), 36n, [5n, 7n]]);
  const signatures = safeSignatures([{ owner: OTHER, signature: STUB_SIGNATURE }, { owner: OWNER, contract: earlier }]);
  const form = zealFormIn(signatures, OWNER)!;
  assert.deepEqual(form, { authenticatorData: `0x${'ac'.repeat(32)}1d00000000`, clientDataJSON: android, challengeOffset: 36 });
  const again = check(zealAssertion(challenge, form), challenge);
  assert.equal(again.json, android.replace('APvRJ3b_o37trvMyO8Py1aksI5DmiOfDx-RwCymZg7o', base64url(challenge)));
  // Not the owner's, an ECDSA owner's part, or data that isn't a Zeal assertion: no form.
  assert.equal(zealFormIn(signatures, OTHER), undefined);
  assert.equal(zealFormIn(safeSignatures([{ owner: OWNER, contract: '0x1234' }]), OWNER), undefined);
  assert.equal(zealFormIn(STUB_SIGNATURE, OWNER), undefined);
});

test('Zeal’s signer stood in for: checkSignature is given the stand-in passkey’s key, and every call runs the real code, moved', async () => {
  const { createEVM } = await import('@ethereumjs/evm');
  const { createAddressFromString, hexToBytes, bytesToHex } = await import('@ethereumjs/util');
  const { standInPasskey, zealSignerStandIn } = await import('../src/safe-sim.ts');
  const evm = await createEVM();
  const at = createAddressFromString;
  const SIGNER = '0xfeca1a69282273548587fe1538d4471644d5807a', MOVED = '0x0000000000000000000000000000000000ec2ea1';
  await evm.stateManager.putCode(at(SIGNER), hexToBytes(zealSignerStandIn()));
  // The moved code here returns its calldata, or reverts with it when the first word is 0xbad.
  await evm.stateManager.putCode(at(MOVED), hexToBytes('0x366000600037600035610bad14601457366000f35b366000fd'));
  const call = async (data: Hex) => {
    const res = await evm.runCall({ caller: at(ALICE), to: at(SIGNER), data: hexToBytes(data), gasLimit: 1_000_000n });
    return { out: bytesToHex(res.execResult.returnValue), reverted: !!res.execResult.exceptionError };
  };
  const { x, y } = standInPasskey();
  const words = (n: number) => Array.from({ length: n }, (_, i) => (i + 1).toString(16).padStart(64, '0')).join('');
  const checkSignature = `0x0d5efec9${words(9)}${'ee'.repeat(40)}` as Hex;
  assert.equal((await call(checkSignature)).out, `0x0d5efec9${words(7)}${x.slice(2)}${y.slice(2)}${'ee'.repeat(40)}`, 'the stored key (Q, words 7 and 8) replaced');
  const other = `0x1626ba7e${words(9)}` as Hex;
  assert.deepEqual(await call(other), { out: other, reverted: false });
  assert.deepEqual(await call(`0x${'0'.repeat(61)}bad${'00'.repeat(4)}`), { out: `0x${'0'.repeat(61)}bad${'00'.repeat(4)}`, reverted: true });
});

test('A Zeal passkey owner is recognized deployed (its proxy’s implementation) or deploying (the Safe’s setup has Zeal’s router create it)', async () => {
  const { keccak256, decodeAbiParameters, hexToString } = await import('viem');
  const { zealSignerStandIn, zealStandIn } = await import('../src/safe-sim.ts');
  const SIGNER = '0xfeca1a69282273548587fe1538d4471644d5807a', MOVED = '0x0000000000000000000000000000000000ec2ea1', OWNER = '0x6276c539c54c36f31883d5f1e60083ecd422d837';
  const SAFE_141 = '0x29fcb43b46531bca003ddc8fcb67ffe91900c762', SAFE_150 = '0xedd160febbd92e350d4d398fb636302fccd67c7e';
  const hash = keccak256('0x01');
  const seen: string[] = [];
  const deps = (implementation: string) => ({ rpc: { has: () => true, call: async (_: number, method: string, params: string[]) => {
    seen.push(method);
    if (method === 'eth_getStorageAt') return params[0] === OWNER ? `0x${implementation.slice(2).padStart(64, '0')}` : `0x${'00'.repeat(32)}`;
    if (method === 'eth_getCode') return params[0] === SIGNER ? '0x6001' : '0x';
    // Zeal's factory's IMPLEMENTATION_SIGNER(), which a deploy reads.
    if (method === 'eth_call') return `0x${SIGNER.slice(2).padStart(64, '0')}`;
    if (method === 'eth_getBlockByNumber') return { number: '0x100' };
    if (method === 'eth_getLogs') return [];
    throw new Error(method);
  } } }) as unknown as Dependencies;
  const challengeOf = (contract: Hex) => {
    const [, clientData] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes' }, { type: 'uint256' }, { type: 'uint256[2]' }], contract);
    return `0x${Buffer.from(hexToString(clientData).slice(36, 79), 'base64url').toString('hex')}`;
  };
  const deployed = await zealStandIn(deps(SIGNER), 1, OWNER, { safe: SAFE, hash, singleton: SAFE_141, entryPoints: ['0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789'] });
  assert.deepEqual(deployed?.stateOverrides, { [SIGNER]: { code: zealSignerStandIn() }, [MOVED]: { code: '0x6001' } });
  assert.deepEqual(deployed?.warm, [MOVED]);
  // Safe 1.4.1 asks isValidSignature(bytes data): the challenge is the hash of that data, the SafeOp's or SafeTx's
  // hash. Safe 1.5.0 asks isValidSignature(bytes32 hash): its keccak256.
  assert.equal(challengeOf(deployed!.contract), hash);
  assert.equal(challengeOf((await zealStandIn(deps(SIGNER), 1, OWNER, { safe: SAFE, hash, singleton: SAFE_150 }))!.contract), keccak256(hash));
  // Another implementation (or none: an EOA owner) is not Zeal's.
  assert.equal(await zealStandIn(deps(`0x${'11'.repeat(20)}`), 1, OWNER, { safe: SAFE, hash }), null);
  assert.equal(await zealStandIn(deps(SIGNER), 1, ALICE, { safe: SAFE, hash }), null);
  // A Safe being deployed whose setup delegatecalls Zeal's DeploymentRouter (setupSafe(recoveryId, x, y)) to create
  // its owner's signer: nothing to read from the owner, which doesn't exist yet.
  const FACTORY = parseAbi(['function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce)', 'function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)', 'function setupSafe(bytes32, uint256, uint256)']);
  const initCode = (to: string) => concatHex(['0x4e1dcf7ad4e460cfd30791ccc4f9c8a4f820ec67', encodeFunctionData({ abi: FACTORY, functionName: 'createProxyWithNonce', args: [SAFE_141, encodeFunctionData({ abi: FACTORY, functionName: 'setup',
    args: [[OWNER], 1n, to as Hex, encodeFunctionData({ abi: FACTORY, functionName: 'setupSafe', args: [`0x${'42'.repeat(32)}`, 1n, 2n] }), ZERO, ZERO, 0n, ZERO] }), BigInt(OWNER)] })]);
  seen.length = 0;
  const deploying = await zealStandIn(deps(ZERO), 1, OWNER, { safe: SAFE, hash, initCode: initCode('0xf2230dc5924b7cb5757c86dbd658515a8894b493'), entryPoints: ['0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789'] });
  assert.deepEqual(deploying?.stateOverrides, deployed?.stateOverrides);
  assert.ok(!seen.includes('eth_getStorageAt') && !seen.includes('eth_getLogs'), 'nothing read of the owner or the Safe’s past');
  assert.equal(await zealStandIn(deps(ZERO), 1, OWNER, { safe: SAFE, hash, initCode: initCode(BOB) }), null);
  // The fallback handler the deployed Safe ends up with: Zeal's router enables the module Zeal's factory names (its
  // setup names none); another setup's own.
  const { deployedFallbackHandler } = await import('../src/safe-sim.ts');
  const MODULE = '0xa581c4a4db7175302464ff3c06380bc3270b4037', asked: [string, string][] = [];
  const read = async (to: string, data: Hex) => { asked.push([to, data]); return `0x${MODULE.slice(2).padStart(64, '0')}`; };
  assert.equal(await deployedFallbackHandler(initCode('0xf2230dc5924b7cb5757c86dbd658515a8894b493'), read), MODULE);
  assert.deepEqual(asked, [['0xf2b940e16b93a78f8884f80b89fa691460069bd1', '0x12e6c710']]);
  assert.equal(await deployedFallbackHandler(initCode(BOB), read), ZERO);
  assert.equal(await deployedFallbackHandler(initCode('0xf2230dc5924b7cb5757c86dbd658515a8894b493'), async () => { throw new Error('down'); }), null);
  assert.equal(await deployedFallbackHandler('0x1234', read), null);
  assert.equal(asked.length, 1);
});

test('A SafeTx signed by a Zeal passkey owner: its assertion as the owner’s contract signature, and its signer stood in for', async () => {
  const { decodeAbiParameters, decodeFunctionData, encodeAbiParameters: enc, hexToString } = await import('viem');
  const { simulateSafeExecution, zealSignerStandIn } = await import('../src/safe-sim.ts');
  const { base64url } = await import('../src/erc4337-sim.ts');
  const SIGNER = '0xfeca1a69282273548587fe1538d4471644d5807a', MOVED = '0x0000000000000000000000000000000000ec2ea1', OWNER = '0x6276c539c54c36f31883d5f1e60083ecd422d837';
  const HASH = `0x${'ab'.repeat(32)}` as Hex;
  const view = (data: string) => {
    const sel = data.slice(0, 10);
    if (sel === '0xa619486e') return enc([{ type: 'address' }], ['0x29fcb43b46531bca003ddc8fcb67ffe91900c762']); // Safe 1.4.1 (L2)
    if (sel === '0xa0e67e2b') return enc([{ type: 'address[]' }], [[OWNER]]);
    if (sel === '0xe75235b8' || sel === '0xaffed0e0') return enc([{ type: 'uint256' }], [1n]);
    if (sel === '0xd8d11f78') return HASH;
    if (sel === '0xcc2f8452') return enc([{ type: 'address[]' }, { type: 'address' }], [[], '0x0000000000000000000000000000000000000001']);
    if (sel === '0x5624b25b') return enc([{ type: 'bytes' }], [`0x${'00'.repeat(32)}`]);
    return '0x';
  };
  const batches: SimulationRequest[][] = [];
  const d: Dependencies = { ...deps,
    rpc: { has: () => true, call: async (_c: number, m: string, p: unknown[]) => m === 'eth_call' ? view((p[0] as { data: string }).data)
      : m === 'eth_getStorageAt' && p[0] === OWNER ? `0x${SIGNER.slice(2).padStart(64, '0')}` : m === 'eth_getCode' && p[0] === SIGNER ? '0x6001' : '0x' },
    simulator: { simulate: async () => null, simulateBatch: async rs => { batches.push(rs); return rs.map((r, i) => ({ status: 'success' as const, source: 'mock', transfers: [], returnData: i === 0 ? enc([{ type: 'uint256' }], [1n]) : view(r.data) })); } } };
  const run = await simulateSafeExecution({ safe: SAFE, to: USDC, value: 0n, data: transfer, operation: 0, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: ZERO, refundReceiver: ZERO }, 1, d, { executor: OWNER });
  assert.equal(run?.passkey, 'inline');
  const exec = batches[0][0];
  assert.equal(exec.stateOverrides?.[SIGNER]?.code, zealSignerStandIn());
  assert.equal(exec.stateOverrides?.[MOVED]?.code, '0x6001');
  assert.ok(exec.accessList?.some(a => a.address === MOVED) && !exec.accessList?.some(a => a.address === SIGNER), 'the moved code warm, the signer itself cold');
  // The owner's part: a contract signature (v 0), its data a Zeal assertion whose challenge is the transaction's hash
  // (Safe 1.4.1 passes isValidSignature the data it hashed).
  const signatures = decodeFunctionData({ abi: parseAbi(['function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)']), data: exec.data as Hex }).args[9];
  assert.equal(signatures.slice(0, 66), `0x${OWNER.slice(2).padStart(64, '0')}`);
  assert.equal(signatures.slice(130, 132), '00');
  const length = Number(BigInt(`0x${signatures.slice(132, 196)}`)), contract = `0x${signatures.slice(196, 196 + length * 2)}` as Hex;
  assert.equal(signatures.length, 196 + length * 2);
  const [, clientData, offset] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes' }, { type: 'uint256' }, { type: 'uint256[2]' }], contract);
  assert.equal(hexToString(clientData).slice(Number(offset), Number(offset) + 43), base64url(HASH));
});

test("A later call's Safe transaction that fails on its own but runs after the calls before it is a note, not a failure", async () => {
  // Base, 2026-11-15: a SafeOp sent a token to a Safe it then deployed, and ran a transaction on that Safe sending
  // the token on. Simulated on its own, without the transfer before it, that transaction fails; the batch ran.
  const d = (outer: InOrder, alone: 'reverts' | 'false' = 'reverts') => laterSafeDeps(outer, alone);
  const ran = await sign(laterSafeBatch(0n), d({ logs: [executionLog(EXECUTION_SUCCESS)] }));
  assert.ok(!codes(ran).includes('safe_tx_reverts'), JSON.stringify(ran.warnings));
  assert.match(ran.decoding.notes.join(' '), /Call 2's Safe transaction fails when simulated on its own, without the calls before it \(ERC20InsufficientBalance\); run after them, as the batch runs it, it succeeds \(its Safe logs ExecutionSuccess\)\./);
  const fails = async (p: Promise<Awaited<ReturnType<typeof sign>>>, reason: RegExp) => {
    const q = await p;
    assert.match(q.warnings.find(w => w.code === 'safe_tx_reverts')?.message ?? '', reason, JSON.stringify(q.warnings));
    assert.ok(!q.decoding.notes.some(n => /Call 2's Safe transaction/.test(n)));
  };
  // A batch that succeeds doesn't say the transaction ran: execTransaction can fail without reverting, logging
  // ExecutionFailure (with a safeTxGas or a gas price; on Safe 1.1.1 and 1.2.0, whatever they are, as there it
  // returns false when run on its own too). Its failure stands.
  await fails(sign(laterSafeBatch(50_000n), d({ logs: [executionLog(EXECUTION_FAILURE)] })), /^Call 2: .*ERC20InsufficientBalance/);
  await fails(sign(laterSafeBatch(0n), d({ logs: [executionLog(EXECUTION_FAILURE)] }, 'false')), /^Call 2: .*\(ExecutionFailure\)/);
  // Nothing logged by that Safe (a simulator that doesn't report logs, or Safe 1.0.0, which logs neither), or only
  // the outer Safe's own ExecutionSuccess: not shown to have run.
  await fails(sign(laterSafeBatch(0n), d({ logs: [] }, 'false')), /^Call 2: /);
  await fails(sign(laterSafeBatch(0n), d({ logs: [executionLog(EXECUTION_SUCCESS, SAFE)] })), /^Call 2: .*ERC20InsufficientBalance/);
  // A Safe further down whose transaction fails without reverting (SAFE2's transaction runs one on a third Safe):
  // SAFE2 logs ExecutionSuccess, as its call didn't revert, but the third Safe's ExecutionFailure (or 1.0.0's
  // ExecutionFailed) is in the run. Its failure stands.
  const SAFE3 = '0x5afe00000000000000000000000000000000f00d', EXECUTION_FAILED = '0xabfd711ecdd15ae3a6b3ad16ff2e9d81aec026a39d16725ee164be4fbf857a7c';
  for (const failure of [EXECUTION_FAILURE, EXECUTION_FAILED]) await fails(sign(laterSafeBatch(0n), d({ logs: [executionLog(failure, SAFE3), executionLog(EXECUTION_SUCCESS)] })), /^Call 2: .*ERC20InsufficientBalance/);
  // And when the batch fails too.
  await fails(sign(laterSafeBatch(0n), d({ reverted: true })), /ERC20InsufficientBalance/);
});

// A batch's later call running execTransaction on a second Safe (SAFE2), which fails when simulated on its own: it
// reverts (Safe 1.3.0 on, no safeTxGas or gas price: GS013) or returns false (ExecutionFailure). The outer Safe's run
// of the whole batch reverts, or succeeds and logs what the second Safe logged in it.
const SAFE2 = '0x5afe00000000000000000000000000000000beef';
const EXECUTION_SUCCESS = '0x442e715f626346e8c54381002da614f62bee8d27386535b2521ec8540898556e', EXECUTION_FAILURE = '0x23428b18acfb3ea64b08dc0c1d296ea9c09702c09083ca5272e64d115b687d23';
type Log = { address: string; topics: string[]; data: string };
type InOrder = { reverted: true } | { logs: Log[] };
const executionLog = (topic: string, by = SAFE2): Log => ({ address: by, topics: [topic], data: concat([`0x${'cd'.repeat(32)}`, `0x${'0'.repeat(64)}`]) });
const laterSafeViews = (data: string) => {
  const word = (v: bigint) => enc([{ type: 'uint256' }], [v]);
  const sel = data.slice(0, 10);
  if (sel === '0xa619486e') return enc([{ type: 'address' }], [SINGLETON as Hex]);
  if (sel === '0xa0e67e2b') return enc([{ type: 'address[]' }], [OWNERS as Hex[]]);
  if (sel === '0xe75235b8') return word(2n);
  if (sel === '0xaffed0e0') return word(7n);
  if (sel === '0xd8d11f78') return `0x${'ab'.repeat(32)}`;
  if (sel === '0xcc2f8452') return enc([{ type: 'address[]' }, { type: 'address' }], [[], '0x0000000000000000000000000000000000000001']);
  if (sel === '0x5624b25b') return enc([{ type: 'bytes' }], [`0x${SINGLETON.slice(2).padStart(64, '0')}` as Hex]);
  if (sel === '0x2f54bf6e' || sel === '0x2d9ad53d') return word(1n);
  return '0x';
};
/** `outer` answers the batch's own run: the outer Safe's execTransaction, or (`whole`) the EntryPoint's run of a SafeOp. */
const laterSafeDeps = (outer: InOrder, alone: 'reverts' | 'false', whole?: (r: SimulationRequest) => object | null): Dependencies => ({ ...deps,
  rpc: { has: () => true, call: async (_c: number, m: string, p: unknown[]) => m === 'eth_call' ? laterSafeViews((p[0] as { data: string }).data) : '0x' },
  simulator: { simulate: async () => null, simulateBatch: async rs => rs.map((r, i) => {
    if (i > 0) return { status: 'success' as const, source: 'mock', transfers: [], returnData: laterSafeViews(r.data) };
    const reverted = { status: 'reverted' as const, source: 'mock', transfers: [], revertReason: 'ERC20InsufficientBalance' };
    if (rs[0].to?.toLowerCase() === SAFE2) return alone === 'reverts' ? reverted : { status: 'success' as const, source: 'mock', transfers: [], returnData: enc([{ type: 'uint256' }], [0n]), logs: [executionLog(EXECUTION_FAILURE)] };
    return (whole?.(r) as never) ?? ('reverted' in outer ? reverted : { status: 'success' as const, source: 'mock', transfers: [], returnData: enc([{ type: 'uint256' }], [1n]), logs: outer.logs });
  }) } });
const laterSafeInner = (safeTxGas: bigint) => encodeFunctionData({ abi: ABI, functionName: 'execTransaction', args: [USDC, 0n, transfer, 0, safeTxGas, 0n, 0n, ZERO, ZERO, `0x${'00'.repeat(65)}`] });
const laterSafeCalls = (safeTxGas: bigint) => multiSend([[0, USDC, 0n, encodeFunctionData({ abi: ABI, functionName: 'transfer', args: [SAFE2, 1_000_000_000n] })], [0, SAFE2, 0n, laterSafeInner(safeTxGas)]]);
const laterSafeBatch = (safeTxGas: bigint) => ({ to: MULTISEND_CALL_ONLY, operation: 1, data: laterSafeCalls(safeTxGas) });

test("A SafeOp whose calls fail when the EntryPoint runs them doesn't make a later call's failing Safe transaction a note", async () => {
  // The SafeOp runs whole (EntryPoint v0.7, through the module): the batch's run is the operation's. Its calls can
  // fail without the run reverting (UserOperationEvent's success false): Base's operation with its first call
  // sending 1 unit instead of 569.55 BRS showed the calls failing and the second Safe's transaction as succeeding.
  const EP = '0x0000000071727de22e5e9d8baf0edac6f37da032', sender = SAFE_OP_V03.message.safe.toLowerCase();
  const whole = (success: boolean, logs: Log[]) => (r: SimulationRequest) => r.to?.toLowerCase() !== EP ? null : {
    status: 'success' as const, source: 'mock', transfers: [],
    returnData: enc([{ type: 'tuple', components: [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bool' }, { type: 'bytes' }] }], [[100_000n, 10n ** 14n, 0n, 0n, success, '0x']]),
    logs: [...logs, { address: EP, topics: ['0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f', `0x${'11'.repeat(32)}`, `0x${sender.slice(2).padStart(64, '0')}`, `0x${'0'.repeat(64)}`],
      data: enc([{ type: 'uint256' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }], [BigInt(SAFE_OP_V03.message.nonce), success, 10n ** 14n, 100_000n]) }] };
  const op = (success: boolean, logs: Log[]) => signOp(SAFE_OP_V03, { callData: execute(MULTISEND_CALL_ONLY, laterSafeCalls(0n), 1) }, {}, laterSafeDeps({ reverted: true }, 'reverts', whole(success, logs)));
  const ran = await op(true, [executionLog(EXECUTION_SUCCESS)]);
  assert.match(ran.decoding.notes.join(' '), /The whole operation was simulated as EntryPoint v0\.7 runs it/);
  assert.ok(!codes(ran).includes('safe_tx_reverts') && !codes(ran).includes('userop_execution_reverts'), JSON.stringify(ran.warnings));
  assert.match(ran.decoding.notes.join(' '), /Call 2's Safe transaction fails when simulated on its own, without the calls before it \(ERC20InsufficientBalance\); run after them, as the batch runs it, it succeeds/);
  const failed = await op(false, []);
  assert.ok(codes(failed).includes('userop_execution_reverts'), JSON.stringify(failed.warnings));
  assert.match(failed.warnings.find(w => w.code === 'safe_tx_reverts')?.message ?? '', /^Call 2: .*ERC20InsufficientBalance/, JSON.stringify(failed.warnings));
  assert.ok(!failed.decoding.notes.some(n => /Call 2's Safe transaction/.test(n)), JSON.stringify(failed.decoding.notes));
});

// State the caller sets for the simulation (context.stateOverrides): a Safe holding 1 ETH asked to send 2. The mock
// node runs the Safe's transfer from the balance the request gives the Safe, as a node applying the override would.
test('A SafeTx, its plain-call fallback and an execTransaction are simulated on the state the caller set, beneath the stand-ins', async () => {
  const { encodeAbiParameters: enc } = await import('viem');
  const E = 10n ** 18n, HASH = `0x${'ab'.repeat(32)}` as Hex, ECRECOVER = '0x0000000000000000000000000000000000000001';
  const word = (v: bigint) => enc([{ type: 'uint256' }], [v]);
  const view = (readable: boolean) => (data: string) => {
    const sel = data.slice(0, 10);
    if (!readable) return '0x';
    if (sel === '0xa619486e') return enc([{ type: 'address' }], [SINGLETON]);
    if (sel === '0xa0e67e2b') return enc([{ type: 'address[]' }], [OWNERS as Hex[]]);
    if (sel === '0xe75235b8') return word(2n);
    if (sel === '0xaffed0e0') return word(7n);
    if (sel === '0xd8d11f78') return HASH;
    if (sel === '0xcc2f8452') return enc([{ type: 'address[]' }, { type: 'address' }], [[], '0x0000000000000000000000000000000000000001']);
    if (sel === '0x5624b25b') return enc([{ type: 'bytes' }], [`0x${'00'.repeat(32)}`]);
    if (sel === '0x2f54bf6e') return word(1n);
    return '0x';
  };
  const safeBalance = (r: SimulationRequest) => BigInt(r.stateOverrides?.[SAFE]?.balance ?? E);
  // The Safe sends 2 ETH (through execTransaction, or as the Safe's own call): only on a balance that covers it.
  const sends = (r: SimulationRequest) => safeBalance(r) >= 2n * E
    ? { status: 'success' as const, source: 'mock', transfers: [{ asset: 'native', from: SAFE, to: BOB.toLowerCase(), raw: 2n * E }], returnData: word(1n) }
    : { status: 'reverted' as const, source: 'mock', transfers: [], revertReason: 'GS013' };
  const env = (readable = true) => {
    const reads: unknown[][] = [], batches: SimulationRequest[][] = [], singles: SimulationRequest[] = [];
    const answer = (r: SimulationRequest) => (r.to === SAFE && (r.data.startsWith('0x6a761202') || r.from === SAFE) ? sends(r) : r.to === BOB.toLowerCase() && r.from === SAFE ? sends(r)
      : { status: 'success' as const, source: 'mock', transfers: [], returnData: view(readable)(r.data) });
    const d: Dependencies = { ...deps,
      rpc: { has: () => true, call: async (_c: number, m: string, p: unknown[]) => { if (m === 'eth_call') { reads.push(p); return view(readable)((p[0] as { data: string }).data); } return m === 'eth_getCode' ? '0x6080' : null; } },
      simulator: { simulate: async r => { singles.push(r); return answer(r); }, simulateBatch: async rs => { batches.push(rs); return rs.map(answer); } } };
    return { d, reads, batches, singles };
  };
  const sendTwo = { to: BOB, value: (2n * E).toString(), data: '0x' };
  const given = { [SAFE]: { balance: (5n * E).toString(), stateDiff: { '0x4': '0x1' } }, [ECRECOVER]: { code: '0x00' } };
  const signWith = (context: Record<string, unknown>, d: Dependencies) => previewRequest({ method: 'eth_signTypedData_v4', params: [ALICE, JSON.stringify(safeTx(sendTwo))] }, { now: NOW, ...context }, d);
  const native = (p: Awaited<ReturnType<typeof sign>>) => p.assetChanges.filter(c => c.asset === 'native').map(c => `${c.direction} ${c.amount}`);

  // execTransaction itself: on the chain's state it fails; on the state set, it sends the 2 ETH, and says so once.
  const chainOwn = env();
  const own = await signWith({}, chainOwn.d);
  assert.ok(codes(own).includes('safe_tx_reverts') && !codes(own).includes('state_overridden'), codes(own).join());
  assert.ok(chainOwn.reads.every(p => p.length === 2), 'no overrides: eth_call as before');
  const set = env();
  const p = await signWith({ stateOverrides: given }, set.d);
  assert.ok(!codes(p).includes('safe_tx_reverts'), codes(p).join());
  assert.deepEqual(native(p), ['out 2']);
  assert.equal(p.warnings.filter(w => w.code === 'state_overridden').length, 1);
  assert.ok(!p.decoding.notes.some(n => /context\.stateOverrides/.test(n)), p.decoding.notes.join(' | '));
  // The run: the caller's balance and slot at the Safe, as given (the owners' signatures are stood in for at
  // ecrecover, not in the Safe's storage); the stand-in ecrecover, for both owners, over the caller's code there. The
  // Safe's nonce, hash and configuration were read in that state.
  const exec = set.batches[0][0];
  assert.equal(exec.stateOverrides![SAFE].balance, `0x${(5n * E).toString(16)}`);
  assert.deepEqual(exec.stateOverrides![SAFE].stateDiff, { [`0x${'0'.repeat(63)}4`]: `0x${'0'.repeat(63)}1` });
  assert.ok([OWNERS[0], OWNERS[1]].every(o => exec.stateOverrides![ECRECOVER].code!.includes(o.slice(2))) && exec.stateOverrides![ECRECOVER].movePrecompileToAddress, 'ecrecover is the stand-in');
  // (The checks of whether the signer is an owner and the nonce is the Safe's next describe the chain as it is.)
  const readsOf = (sel: string) => set.reads.filter(p => (p[0] as { data: string }).data.startsWith(sel));
  assert.ok(['0xa0e67e2b', '0xe75235b8', '0xd8d11f78'].every(sel => readsOf(sel).length && readsOf(sel).every(p => (p[2] as Record<string, unknown>)?.[SAFE])), 'owners, threshold and hash read with the overrides');
  assert.ok(readsOf('0x2f54bf6e').every(p => p.length === 2));

  // The calls from the Safe, when execTransaction can't be run (the Safe doesn't answer as one): the same state.
  const plainOwn = env(false), plainSet = env(false);
  assert.ok(codes(await signWith({}, plainOwn.d)).includes('safe_tx_reverts'));
  const plain = await signWith({ stateOverrides: given }, plainSet.d);
  assert.deepEqual([native(plain), codes(plain).includes('safe_tx_reverts'), plain.warnings.filter(w => w.code === 'state_overridden').length], [['out 2'], false, 1]);
  assert.equal(plainSet.singles[0].stateOverrides?.[SAFE]?.balance, `0x${(5n * E).toString(16)}`);
  assert.match(plain.decoding.notes.join(' '), /Simulated as the Safe making the call/);
  // Nothing simulated (no simulator here): no caution, and a note that the overrides weren't applied.
  const unsimulated = await signWith({ stateOverrides: given }, deps);
  assert.ok(!codes(unsimulated).includes('state_overridden'));
  assert.match(unsimulated.decoding.notes.join(' '), /nothing in this request was simulated with them/);

  // An execTransaction transaction, alone and in a batch: the transaction's own warning, said once.
  const execData = encodeFunctionData({ abi: ABI, functionName: 'execTransaction', args: [BOB, 2n * E, '0x', 0, 0n, 0n, 0n, ZERO, ZERO, `0x${'11'.repeat(130)}`] });
  const tx = await previewRequest({ method: 'eth_sendTransaction', params: [{ from: ALICE, to: SAFE, data: execData, chainId: '0x1' }] }, { now: NOW, stateOverrides: given }, env().d);
  assert.equal(tx.warnings.filter(w => w.code === 'state_overridden').length, 1);
  const batch = await previewRequest({ method: 'wallet_sendCalls', params: [{ version: '2.0.0', from: ALICE, chainId: '0x1', calls: [{ to: SAFE, data: execData }, { to: SAFE, data: execData }] }] }, { now: NOW, stateOverrides: given }, env().d);
  assert.equal(batch.warnings.filter(w => w.code === 'state_overridden').length, 1, batch.warnings.map(w => w.message).join(' | '));
  assert.ok(!batch.warnings.some(w => /^Call \d: Simulated with state set/.test(w.message)));
  // A SafeTx whose calls are execTransactions of a Safe (here itself), each run by its decoder too: said once.
  const nested = await previewRequest({ method: 'eth_signTypedData_v4', params: [ALICE, JSON.stringify(safeTx({ to: MULTISEND_CALL_ONLY, operation: 1, data: multiSend([[0, SAFE, 0n, execData], [0, SAFE, 0n, execData]]) }))] }, { now: NOW, stateOverrides: given }, env().d);
  assert.deepEqual(nested.warnings.filter(w => w.code === 'state_overridden').map(w => w.message.slice(0, 10)), ['Simulated ']);
  // A smart account's batch of execTransactions, as a transaction to the account, as a UserOperation's calls and in a
  // bundle of two such operations: said once, unnumbered, too.
  const SA = parseAbi(['function executeBatch((address target, uint256 value, bytes data)[] calls)',
    'function handleOps((address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature)[] ops, address beneficiary)']);
  const overridden = (p: Awaited<ReturnType<typeof sign>>) => p.warnings.filter(w => w.code === 'state_overridden').map(w => w.message.slice(0, 10));
  const accountBatch = encodeFunctionData({ abi: SA, functionName: 'executeBatch', args: [[{ target: SAFE, value: 0n, data: execData }, { target: SAFE, value: 0n, data: execData }]] });
  const viaAccount = await previewRequest({ method: 'eth_sendTransaction', params: [{ from: ALICE, to: ALICE, data: accountBatch, chainId: '0x1' }] }, { now: NOW, stateOverrides: given }, env().d);
  assert.deepEqual(overridden(viaAccount), ['Simulated '], viaAccount.warnings.map(w => w.message).join(' | '));
  const EP7 = '0x0000000071727de22e5e9d8baf0edac6f37da032', z = `0x${'00'.repeat(32)}` as Hex;
  const packed = (sender: string) => ({ sender: sender as Hex, nonce: 0n, initCode: '0x' as Hex, callData: accountBatch, accountGasLimits: z, preVerificationGas: 0n, gasFees: z, paymasterAndData: '0x' as Hex, signature: '0x' as Hex });
  const bundle = await previewRequest({ method: 'eth_sendTransaction', params: [{ from: ALICE, to: EP7, data: encodeFunctionData({ abi: SA, functionName: 'handleOps', args: [[packed(ALICE), packed(BOB)], ALICE as Hex] }), chainId: '0x1' }] }, { now: NOW, stateOverrides: given }, env().d);
  assert.deepEqual(overridden(bundle), ['Simulated '], bundle.warnings.map(w => w.message).join(' | '));
  const { readOperation, userOpHash } = await import('../src/userop-hash.ts');
  const operation = { sender: ALICE, nonce: '0x0', callData: accountBatch, callGasLimit: '0x30d40', verificationGasLimit: '0x493e0', preVerificationGas: '0xc350', maxFeePerGas: '0x2faf080', maxPriorityFeePerGas: '0xf4240' };
  const userOp = await previewRequest({ method: 'personal_sign', params: [userOpHash(readOperation(operation, '0.7')!, EP7, 1, '0.7'), ALICE] }, { now: NOW, chainId: 1, userOperation: { entryPoint: EP7, operation }, stateOverrides: given }, env().d);
  assert.deepEqual(overridden(userOp), ['Simulated '], userOp.warnings.map(w => w.message).join(' | '));
});

test('A SafeOp is simulated on the state the caller set: the whole operation beneath its stand-ins, then the calls the module runs', async () => {
  const { encodeAbiParameters: enc } = await import('viem');
  const { ENTRY_POINT_SIMULATIONS_V07 } = await import('../src/entrypoint-simulations.ts');
  const E = 10n ** 18n, OP_SAFE = SAFE_OP_V03.message.safe.toLowerCase(), EP7 = SAFE_OP_V03.message.entryPoint, ECRECOVER = '0x0000000000000000000000000000000000000001';
  const word = (v: bigint) => enc([{ type: 'uint256' }], [v]);
  const view = (data: string) => {
    const sel = data.slice(0, 10);
    if (sel === '0xa619486e') return enc([{ type: 'address' }], [SINGLETON]);
    if (sel === '0xa0e67e2b') return enc([{ type: 'address[]' }], [OWNERS as Hex[]]);
    if (sel === '0xe75235b8') return word(2n);
    if (sel === '0xcc2f8452') return enc([{ type: 'address[]' }, { type: 'address' }], [[SAFE_OP_V03.domain.verifyingContract.toLowerCase() as Hex], '0x0000000000000000000000000000000000000001']);
    if (sel === '0x5624b25b') return enc([{ type: 'bytes' }], [`0x${'00'.repeat(32)}`]);
    if (sel === '0x35567e1a') return word(BigInt(SAFE_OP_V03.message.nonce));
    return word(1n);
  };
  const env = () => {
    const reads: unknown[][] = [], asked: SimulationRequest[][] = [];
    // The whole operation can't be run by this node (no logs): the module's call is then run alone, from the EntryPoint.
    const answer = (r: SimulationRequest) => r.to === OP_SAFE && r.from === EP7
      ? BigInt(r.stateOverrides?.[OP_SAFE]?.balance ?? E) >= 2n * E ? { status: 'success' as const, source: 'mock', transfers: [{ asset: 'native', from: OP_SAFE, to: BOB.toLowerCase(), raw: 2n * E }] } : { status: 'reverted' as const, source: 'mock', transfers: [], revertReason: 'GS013' }
      : null;
    const d: Dependencies = { ...deps,
      rpc: { has: () => true, call: async (_c: number, m: string, p: unknown[]) => { if (m === 'eth_call') { reads.push(p); return view((p[0] as { data: string }).data); } return m === 'eth_getCode' ? '0x6080' : m === 'eth_getStorageAt' ? word(0n) : null; } },
      simulator: { simulate: async r => { asked.push([r]); return answer(r); }, simulateBatch: async rs => { asked.push(rs); return rs.map(answer).some(x => !x) ? null : rs.map(answer) as never; } } };
    return { d, reads, asked };
  };
  const sendTwo = { callData: encodeFunctionData({ abi: parseAbi(['function executeUserOp(address to, uint256 value, bytes data, uint8 operation)']), functionName: 'executeUserOp', args: [BOB, 2n * E, '0x', 0] }) };
  const run = (context: Record<string, unknown>, d: Dependencies) => previewRequest({ method: 'eth_signTypedData_v4', params: [OWNERS[0], JSON.stringify({ ...SAFE_OP_V03, message: { ...SAFE_OP_V03.message, ...sendTwo } })] }, { now: NOW, ...context }, d);
  const native = (p: Awaited<ReturnType<typeof sign>>) => p.assetChanges.filter(c => c.asset === 'native').map(c => `${c.direction} ${c.amount}`);
  const own = await run({}, env().d);
  assert.ok(codes(own).includes('safe_tx_reverts') && !codes(own).includes('state_overridden'), codes(own).join());
  const set = env();
  const p = await run({ stateOverrides: { [OP_SAFE]: { balance: (5n * E).toString() }, [ECRECOVER]: { code: '0x00' }, [EP7]: { code: '0x00', stateDiff: { '0x77': '0x1' } } } }, set.d);
  assert.deepEqual([native(p), codes(p).includes('safe_tx_reverts'), p.warnings.filter(w => w.code === 'state_overridden').length], [['out 2'], false, 1]);
  assert.match(p.decoding.notes.join(' '), /The operation was simulated as the EntryPoint runs it: through the Safe's 4337 module/);
  // The whole operation was asked for with the caller's state beneath its stand-ins: the EntryPoint's simulation
  // code, ecrecover standing in for the signing owner, the other owner's approval at the Safe.
  const whole = set.asked.find(rs => rs[0].to === EP7)![0].stateOverrides!;
  assert.equal(whole[EP7].code, ENTRY_POINT_SIMULATIONS_V07);
  assert.equal(whole[EP7].stateDiff![`0x${'0'.repeat(62)}77`], `0x${'0'.repeat(62)}01`);
  assert.ok(whole[ECRECOVER].code!.includes(OWNERS[0].slice(2)));
  assert.equal(whole[OP_SAFE].balance, `0x${(5n * E).toString(16)}`);
  assert.equal(Object.keys(whole[OP_SAFE].stateDiff ?? {}).length, 1, 'the approval of the other owner the threshold needs');
  // The calls alone carry it too; and the Safe's configuration before the run was read in that state.
  assert.equal(set.asked.find(rs => rs[0].to === OP_SAFE && rs[0].from === EP7)![0].stateOverrides?.[OP_SAFE]?.balance, `0x${(5n * E).toString(16)}`);
  assert.ok(set.reads.some(p => (p[0] as { data: string }).data === '0xa0e67e2b' && (p[2] as Record<string, unknown>)?.[OP_SAFE]));
});

test('A SafeOp run whole lists the native coin its calls send, without the gas prefund the Safe pays the EntryPoint', async () => {
  const { encodeAbiParameters: enc } = await import('viem');
  const E = 10n ** 18n, OP_SAFE = SAFE_OP_V03.message.safe.toLowerCase(), EP7 = SAFE_OP_V03.message.entryPoint;
  const word = (v: bigint) => enc([{ type: 'uint256' }], [v]);
  const view = (data: string) => {
    const sel = data.slice(0, 10);
    if (sel === '0xa619486e') return enc([{ type: 'address' }], [SINGLETON]);
    if (sel === '0xa0e67e2b') return enc([{ type: 'address[]' }], [OWNERS as Hex[]]);
    if (sel === '0xe75235b8') return word(2n);
    if (sel === '0xcc2f8452') return enc([{ type: 'address[]' }, { type: 'address' }], [[SAFE_OP_V03.domain.verifyingContract.toLowerCase() as Hex], '0x0000000000000000000000000000000000000001']);
    if (sel === '0x5624b25b') return enc([{ type: 'bytes' }], [`0x${'00'.repeat(32)}`]);
    if (sel === '0x35567e1a') return word(BigInt(SAFE_OP_V03.message.nonce));
    return word(1n);
  };
  // The EntryPoint's run as a local EVM reports it: the Safe's balance read before and after (the prefund it paid in
  // validation and the 0.5 ETH its call sent, together), and its EntryPoint deposit (what's left of the prefund).
  const PREFUND = 3n * 10n ** 14n, PAID = 10n ** 14n;
  const ran = (success: boolean) => ({ status: 'success' as const, source: 'mock', basis: 'fork' as const, readAssets: ['native', EP7],
    transfers: [{ asset: 'native', from: OP_SAFE, to: EP7, raw: PREFUND + (success ? E / 2n : 0n) }, { asset: EP7, from: EP7, to: OP_SAFE, raw: PREFUND - PAID }],
    returnData: enc([{ type: 'tuple', components: [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bool' }, { type: 'bytes' }] }], [[100_000n, PAID, 0n, 0n, false, '0x']]),
    logs: [{ address: EP7, topics: ['0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f', `0x${'11'.repeat(32)}`, `0x${OP_SAFE.slice(2).padStart(64, '0')}`, `0x${'0'.repeat(64)}`],
      data: enc([{ type: 'uint256' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }], [BigInt(SAFE_OP_V03.message.nonce), success, PAID, 100_000n]) }] });
  const env = (success: boolean): Dependencies => {
    // (The reads of the Safe's setup after the run answer as before it.)
    const answer = (r: SimulationRequest) => r.to === EP7 ? ran(success) : { status: 'success' as const, source: 'mock', transfers: [], returnData: view(r.data) };
    return { ...deps, rpc: { has: () => true, call: async (_c: number, m: string, p: unknown[]) => m === 'eth_call' ? view((p[0] as { data: string }).data) : m === 'eth_getCode' ? '0x6080' : m === 'eth_getStorageAt' ? word(0n) : null },
      simulator: { simulate: async r => answer(r), simulateBatch: async rs => rs.map(answer) } };
  };
  const sendHalf = { callData: encodeFunctionData({ abi: parseAbi(['function executeUserOp(address to, uint256 value, bytes data, uint8 operation)']), functionName: 'executeUserOp', args: [BOB, E / 2n, '0x', 0] }) };
  const run = (d: Dependencies) => previewRequest({ method: 'eth_signTypedData_v4', params: [OWNERS[0], JSON.stringify({ ...SAFE_OP_V03, message: { ...SAFE_OP_V03.message, ...sendHalf } })] }, { now: NOW }, d);
  const native = (p: Awaited<ReturnType<typeof sign>>) => p.assetChanges.filter(c => c.asset === 'native').map(c => [c.direction, c.amount, c.basis]);
  const p = await run(env(true));
  assert.match(p.decoding.notes.join(' '), /The whole operation was simulated as EntryPoint v0\.7 runs it/);
  assert.deepEqual(native(p), [['out', '0.5', 'simulated_state']]);
  // Its call failing: only the gas is paid, and nothing is listed as simulated.
  const failed = await run(env(false));
  assert.ok(codes(failed).includes('userop_execution_reverts'), codes(failed).join());
  assert.deepEqual(native(failed).filter(c => c[2] !== 'requested'), []);
});

// A Safe whose views answer for these owners (threshold 1), for the two tests below.
const viewsOf = (owners: string[]) => (data: string) => {
  const sel = data.slice(0, 10), word = (v: bigint) => enc([{ type: 'uint256' }], [v]);
  if (sel === '0xa619486e') return enc([{ type: 'address' }], [SINGLETON as Hex]);
  if (sel === '0xa0e67e2b') return enc([{ type: 'address[]' }], [owners as Hex[]]);
  if (sel === '0xe75235b8') return word(1n);
  if (sel === '0xaffed0e0') return word(5n);
  if (sel === '0xd8d11f78') return `0x${'ab'.repeat(32)}`;
  if (sel === '0xcc2f8452') return enc([{ type: 'address[]' }, { type: 'address' }], [[], '0x0000000000000000000000000000000000000001']);
  if (sel === '0x5624b25b') return enc([{ type: 'bytes' }], [`0x${'00'.repeat(32)}`]);
  if (sel === '0x2f54bf6e') return word(1n);
  return '0x';
};

test("A Safe transaction that takes tokens out of the signer's own account says so, beside what it does for the Safe", async () => {
  // On Arbitrum One (2026-11-23) a Safe transaction had the Safe pull 1,140 USDC from its owner (an allowance the
  // owner had given it) and repay the Safe's loan with them. The Safe's USDC balance doesn't change; the preview
  // showed it receiving 1,140 USDC (the owner's own change, named as going to the Safe: see test/simulation.test.ts)
  // and nothing of the owner's account.
  const alice = ALICE.toLowerCase(), DEBT = '0x00000000000000000000000000000000000000de';
  const d = (owners: string[]): Dependencies => ({ ...deps,
    rpc: { has: () => true, call: async (_c: number, m: string, p: unknown[]) => m === 'eth_call' ? viewsOf(owners)((p[0] as { data: string }).data) : '0x' },
    simulator: { simulate: async () => null, simulateBatch: async rs => rs.map((r, i) => (i === 0
      ? { status: 'success' as const, source: 'mock', balancesRead: true, returnData: enc([{ type: 'uint256' }], [1n]), transfers: [{ asset: DEBT, from: SAFE, to: ZERO, raw: 5_000_000n }, { asset: USDC, from: rs[0].from, to: ZERO, raw: 5_000_000n }] }
      : { status: 'success' as const, source: 'mock', transfers: [], returnData: viewsOf(owners)(r.data) })) } });
  const p = await sign({ to: '0xd88d5356e08dad84e1576f89f4bf43c79a8bf0b2', operation: 1, data: '0x2895f3aa' }, d([alice, OWNERS[1]]));
  assert.match(p.warnings.find(w => w.code === 'safe_signer_pays')?.message ?? '', /^Simulated as sent from your account, the transaction also takes 5 USDC out of your own account \(0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4}\), which isn't the Safe's/);
  assert.equal(p.warnings.find(w => w.code === 'safe_signer_pays')?.severity, 'caution');
  assert.deepEqual(p.assetChanges.map(c => [c.account, c.direction, c.asset, c.raw]), [[SAFE, 'out', DEBT, '5000000'], [alice, 'out', USDC, '5000000']]);
  // Signed by someone who isn't an owner, the run is sent from the Safe's first owner: what leaves that account
  // isn't the signer's, and isn't said to be.
  const other = await sign({ to: '0xd88d5356e08dad84e1576f89f4bf43c79a8bf0b2', operation: 1, data: '0x2895f3aa' }, d(OWNERS));
  assert.ok(!codes(other).includes('safe_signer_pays'));
  assert.deepEqual(other.assetChanges.map(c => [c.account, c.asset]), [[SAFE, DEBT]]);
});

test("A mined execTransaction replayed: the Safe's own run is where the transaction ran, and the local EVM's where the node's isn't what the receipt says", async () => {
  // Run on the latest state, a replayed Safe transaction was said to be expected to fail (GS026: the Safe's nonce
  // has moved on, so its signatures are of another hash) beside a replay that matched its receipt (Ethereum,
  // 2026-11-23: every one of three).
  const alice = ALICE.toLowerCase(), word = (v: bigint) => enc([{ type: 'uint256' }], [v]);
  const data = encodeFunctionData({ abi: ABI, functionName: 'execTransaction', args: [USDC, 0n, transfer, 0, 0n, 0n, 0n, ZERO, ZERO, `0x${'11'.repeat(65)}`] });
  const LOG = { address: SAFE, topics: [EXECUTION_SUCCESS], data: `0x${'cd'.repeat(32)}${'0'.repeat(64)}` };
  const header = { number: 17n, timestamp: 0x65000001n, coinbase: ZERO, gasLimit: 60_000_000n, baseFeePerGas: 7n, prevRandao: `0x${'00'.repeat(32)}` as Hex };
  const earlier: SimulationRequest = { chainId: 1, from: BOB.toLowerCase(), to: ALICE, data: '0x', value: 0n };
  const replay = { at: { block: '0x10', header, required: true }, before: [earlier], earlier: 1, gasPrice: 9n, receipt: { status: 'success' as const, gasUsed: 90_000n, logs: [LOG] },
    info: { hash: `0x${'77'.repeat(32)}`, block: '17', index: 1, time: '2026-11-23T00:00:00.000Z', receipt: { status: 'success' as const, gasUsed: '90000' } }, when: { block: '0x11', time: 0x65000001 } };
  const tags: unknown[] = [], batches: SimulationRequest[][] = [], traced: SimulationRequest[][] = [];
  const ok = (r: SimulationRequest, i: number) => (i === 0 ? { status: 'success' as const, source: 'mock', gasUsed: 90_000n, transfers: [], logs: [LOG], returnData: word(1n) } : { status: 'success' as const, source: 'mock', transfers: [], returnData: viewsOf([alice])(r.data) });
  const d = (node: 'as the receipt' | 'short of gas'): Dependencies => ({ ...deps,
    rpc: { has: () => true, call: async (_c: number, m: string, p: unknown[]) => { if (m !== 'eth_call') return '0x'; tags.push(p[1]); return viewsOf([alice])((p[0] as { data: string }).data); } },
    simulator: {
      simulate: async r => (node === 'as the receipt' ? ok(r, 0) : { status: 'reverted' as const, source: 'mock', gasUsed: 80_000n, revertReason: 'GS013', transfers: [] }),
      simulateBatch: async rs => { batches.push(rs); return rs.map((r, i) => (node === 'short of gas' && i === 0 ? { status: 'reverted' as const, source: 'mock', gasUsed: 80_000n, revertReason: 'GS013', transfers: [] } : ok(r, i))); },
      trace: async rs => { traced.push(rs); return rs.map(ok); },
    } });
  const ACCESS = [{ address: USDC, storageKeys: [`0x${'00'.repeat(32)}`] }];
  const send = (with_: Dependencies, where: Record<string, unknown> = replay) => previewRequest({ method: 'eth_sendTransaction', params: [{ from: ALICE, to: SAFE, data, gas: '0x30d40', accessList: ACCESS, chainId: '0x1' }] }, { now: NOW, replay: where } as never, with_);
  const p = await send(d('as the receipt'));
  assert.ok(!codes(p).includes('safe_tx_reverts'));
  // The Safe's run: on the parent block after the block's earlier transactions, at the price paid, on the gas limit
  // the transaction had; its reads of the Safe on the parent block too; and no second run at today's price.
  const [exec] = batches[0];
  assert.deepEqual([exec.at?.block, exec.at?.before?.length, exec.gasPrice, exec.gas, exec.from], ['0x10', 1, 9n, 200_000n, alice]);
  assert.deepEqual(exec.accessList, ACCESS, 'with the access list it was sent with: its gas is the receipt\'s only with it');
  assert.equal(batches.length, 1);
  assert.ok(tags.length > 0 && tags.every(t => t === '0x10'), 'the Safe is read on the parent block');
  assert.match(p.decoding.notes.join(' '), /What it did for the Safe: execTransaction run again as it was sent, where it ran/);
  assert.doesNotMatch(p.decoding.notes.join(' '), /Simulated at the latest block/);
  // A node whose run isn't the receipt's (the gas it allows one simulation left the call short: GS013): the local
  // EVM's run, which is, is the one the Safe's part is told from.
  batches.length = 0;
  const q = await send(d('short of gas'));
  assert.ok(!codes(q).includes('safe_tx_reverts'));
  assert.equal(traced.some(rs => rs[0].data === data && rs.length === batches[0].length), true);
  // An execTransaction nested in the replayed transaction (a Safe transaction that runs another Safe's, a batch with
  // one in it) isn't the replayed transaction: it runs in the block, but the receipt, the price and the gas limit
  // are the other's. Held to the outer receipt it could never match, and the local EVM ran each one for nothing.
  batches.length = 0; traced.length = 0;
  const outer = { ...replay, call: { from: alice, to: '0x00000000000000000000000000000000000000ee', data: '0x12345678' } };
  const nested = await send(d('short of gas'), outer);
  const [inner] = batches[0];
  assert.deepEqual([inner.at?.block, inner.gasPrice, inner.gas, inner.accessList], ['0x10', undefined, undefined, undefined]);
  assert.equal(traced.some(rs => rs.length === batches[0].length), false);
  assert.ok(codes(nested).includes('safe_tx_reverts'));
  // (The replayed transaction itself, named: as above.)
  batches.length = 0;
  await send(d('as the receipt'), { ...replay, call: { from: alice, to: SAFE, data } });
  assert.deepEqual([batches[0][0].gasPrice, batches[0][0].gas], [9n, 200_000n]);
  // A nested one whose result depends on the price (a gas refund in the native coin: gas × the lower of its own
  // price and the transaction's) is run again at the price the replayed transaction paid, which is the nested
  // call's too: run again at today's, the replay said its Safe's part was "simulated at the price a transaction
  // would pay now" beside "at the price it paid".
  const refunding: SimulationRequest[][] = [];
  const refunds: Dependencies = { ...d('as the receipt'), simulator: { simulate: async r => ok(r, 0), simulateBatch: async rs => { refunding.push(rs);
    return rs.map((r, i) => (i === 0 ? { ...ok(r, 0), transfers: r.gasPrice ? [{ asset: 'native', from: SAFE, to: r.from, raw: 140_000n * r.gasPrice }] : [] } : ok(r, i))); } } };
  const paidFor = await send(refunds, outer);
  assert.deepEqual(refunding.map(rs => [rs[0].gasPrice, rs[0].baseFee, rs[0].at?.block]), [[undefined, undefined, '0x10'], [9n, 7n, '0x10']]);
  assert.match(paidFor.decoding.notes.join(' '), /it was simulated at the price the replayed transaction paid, 0\.000000009 gwei\./);
  assert.doesNotMatch(paidFor.decoding.notes.join(' '), /the price a transaction would pay now/);
  // What the transaction changed in the Safe is told against the Safe as the block's earlier transactions left it.
  // One of them, sent to the Safe, added an owner (the block before has alice alone; where the transaction ran, and
  // after it, alice and bob): the replayed one was said to add that owner too. And one that removes the owner the
  // earlier one added, leaving the Safe as the block before had it, was said to change nothing.
  const bob = BOB.toLowerCase(), toSafe: SimulationRequest = { chainId: 1, from: bob, to: SAFE, data: '0x', value: 0n };
  const sameBlock = (afterIt: string[], reads: SimulationRequest[][]): Dependencies => ({ ...deps,
    rpc: { has: () => true, call: async (_c: number, m: string, p: unknown[]) => (m === 'eth_call' ? viewsOf([alice])((p[0] as { data: string }).data) : '0x') },
    simulator: { simulate: async r => ok(r, 0), simulateBatch: async rs => {
      // (The reads alone, placed after the earlier transactions: the Safe as they left it.)
      if (rs[0].data !== data) { reads.push(rs); return rs.map(r => ({ status: 'success' as const, source: 'mock', transfers: [], returnData: viewsOf([alice, bob])(r.data) })); }
      return rs.map((r, i) => (i === 0 ? ok(r, 0) : { status: 'success' as const, source: 'mock', transfers: [], returnData: viewsOf(afterIt)(r.data) }));
    } } });
  const placedReads: SimulationRequest[][] = [];
  const later = await send(sameBlock([alice, bob], placedReads), { ...replay, before: [toSafe] });
  assert.deepEqual(codes(later).filter(c => /^safe_owners/.test(c)), [], "an earlier transaction's owner isn't this one's");
  assert.deepEqual([placedReads.length, placedReads[0].every(r => r.at?.block === '0x10' && r.at.before?.length === 1)], [1, true]);
  const undone = await send(sameBlock([alice], []), { ...replay, before: [toSafe] });
  assert.ok(codes(undone).includes('safe_owners_removed'), 'and one that undoes it removes an owner');
  // Where no earlier transaction is sent to the Safe and the run leaves it as the block before had it, there is
  // nothing to read again.
  const quiet: SimulationRequest[][] = [];
  await send({ ...sameBlock([alice], quiet), rpc: d('as the receipt').rpc });
  assert.equal(quiet.length, 0);
  // (One that changes the Safe is read again even so: an earlier transaction can reach a Safe through another contract.)
  const through: SimulationRequest[][] = [];
  const indirect = await send(sameBlock([alice, bob], through));
  assert.deepEqual([through.length, codes(indirect).filter(c => /^safe_owners/.test(c))], [1, []]);
  // Where the Safe can't be read on the replayed block (a node that no longer has it), its calls aren't run on
  // today's state instead: they were shown, "simulated at the latest block", beside a replay.
  const singles: SimulationRequest[] = [];
  const gone: Dependencies = { ...deps,
    rpc: { has: () => true, call: async (_c: number, m: string) => { if (m === 'eth_call') throw new Error('missing trie node'); return '0x'; } },
    simulator: { simulate: async r => { singles.push(r); return { status: 'success' as const, source: 'mock', gasUsed: 90_000n, logs: [LOG], transfers: [{ asset: USDC, from: SAFE, to: BOB.toLowerCase(), raw: 1_000_000_000n }] }; }, simulateBatch: async () => null } };
  const unread = await send(gone);
  assert.equal(singles.some(r => r.from === SAFE), false);
  assert.doesNotMatch(unread.decoding.notes.join(' '), /Simulated as the Safe making the call/);
});

test('A SafeTx previewed with a trace: where the block named for it doesn’t answer, the Safe is read on the latest state, as its run is', async () => {
  // The block is named only so that the trace is of the same run. A node that didn't answer for it left the Safe
  // unread, and with it everything execTransaction's run says: a replaced singleton among it.
  const alice = ALICE.toLowerCase(), word = (v: bigint) => enc([{ type: 'uint256' }], [v]);
  const asked: unknown[] = [];
  const d: Dependencies = { ...deps,
    rpc: { has: () => true, call: async (_c: number, m: string, p: unknown[]) => {
      if (m === 'eth_getBlockByNumber') return { number: '0x10', timestamp: '0x65000000', miner: ZERO, gasLimit: '0x3938700', baseFeePerGas: '0x7', mixHash: `0x${'00'.repeat(32)}` };
      if (m !== 'eth_call') return '0x';
      asked.push(p[1]);
      if (p[1] !== 'latest') throw new Error('header not found');
      return viewsOf([alice])((p[0] as { data: string }).data);
    } },
    simulator: { simulate: async () => null, simulateBatch: async rs => rs.map((r, i) => ({ status: 'success' as const, source: 'mock', transfers: [], returnData: i === 0 ? word(1n) : viewsOf([alice])(r.data) })) } };
  const p = await previewRequest({ method: 'eth_signTypedData_v4', params: [ALICE, JSON.stringify(safeTx({}))] }, { now: NOW, trace: true }, d);
  assert.ok(asked.some(t => t !== 'latest') && asked.includes('latest'), 'asked on the block named, then on the latest');
  assert.match(p.decoding.notes.join(' '), /Simulated as the Safe runs it: execTransaction itself/);
});

test('A Safe transaction that spends more coin than the Safe holds runs again with the coin sent along, and says so', async () => {
  // execTransaction takes coin with the call, and apps that fund a Safe's call in the same transaction send it: one
  // on Ethereum (2026-11-23) sent 0.537 ETH with a call that wraps and lends them, the amount its SafeTx names. On
  // the Safe's own balance the call fails (GS013), which was all the preview said.
  const alice = ALICE.toLowerCase(), E = 10n ** 18n, word = (v: bigint) => enc([{ type: 'uint256' }], [v]);
  const env = (held: bigint, withCoin: 'runs' | 'fails') => {
    const batches: SimulationRequest[][] = [];
    const d: Dependencies = { ...deps,
      rpc: { has: () => true, call: async (_c: number, m: string, p: unknown[]) => m === 'eth_call' ? viewsOf([alice])((p[0] as { data: string }).data) : m === 'eth_getBalance' ? `0x${held.toString(16)}` : '0x' },
      simulator: { simulate: async () => null, simulateBatch: async rs => { batches.push(rs); return rs.map((r, i) => (i > 0 ? { status: 'success' as const, source: 'mock', transfers: [], returnData: viewsOf([alice])(r.data) }
        : r.value > 0n && withCoin === 'runs' ? { status: 'success' as const, source: 'mock', transfers: [], returnData: word(1n) } : { status: 'reverted' as const, source: 'mock', revertReason: 'GS013', transfers: [] })); } } };
    return { d, batches };
  };
  const spend = { to: '0x6e7dede13e011eee74e0c731a06c158377fc1cae', operation: 1, data: '0x0c2c8750', value: (E / 2n).toString() };
  const short = env(E / 100n, 'runs');
  const p = await sign(spend, short.d);
  assert.ok(!codes(p).includes('safe_tx_reverts'), codes(p).join());
  assert.match(p.warnings.find(w => w.code === 'safe_needs_coin')?.message ?? '', /^The Safe holds 0\.01 ETH and this spends 0\.5 ETH: on the Safe's own balance it fails\. It was simulated with 0\.5 ETH sent along by whoever submits it/);
  // The second run: the same call with the SafeTx's value, from a submitter who can afford it.
  assert.deepEqual(short.batches.map(b => b[0].value), [0n, E / 2n]);
  assert.ok(BigInt(short.batches[1][0].stateOverrides![alice].balance!) > E / 2n);
  // The Safe sends a delegatecall no coin, whatever it holds: the code run reads what the transaction carries. So
  // a delegatecall that fails is tried with the value it names though the Safe holds as much, and says why.
  const rich = env(E, 'runs');
  const viaCode = await sign(spend, rich.d);
  assert.match(viaCode.warnings.find(w => w.code === 'safe_needs_coin')?.message ?? '', /^With no coin sent along it fails, and with the .* it names sent along by whoever submits it .*, it runs: that run is the one shown\. It runs another contract's code as the Safe \(a delegatecall\).*reads the coin the transaction carries, or spends more than the Safe holds without it\.$/);
  assert.deepEqual(rich.batches.map(b => b[0].value), [0n, E / 2n]);
  // A plain call from a Safe that holds what it spends fails by itself: nothing more is tried. And so does one
  // whose call fails with the coin too.
  const paid = env(E, 'runs');
  const q = await sign({ ...spend, operation: 0 }, paid.d);
  assert.ok(codes(q).includes('safe_tx_reverts') && !codes(q).includes('safe_needs_coin'), codes(q).join());
  assert.equal(paid.batches.length, 1);
  const never = await sign(spend, env(0n, 'fails').d);
  assert.ok(codes(never).includes('safe_tx_reverts') && !codes(never).includes('safe_needs_coin'), codes(never).join());
});
