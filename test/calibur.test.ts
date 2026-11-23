// Calibur, Uniswap's EIP-7702 account code: its batches (the account's own, a relayer's on the account's signature, a
// UserOperation's callData), the signature a relayed batch is made on, and the account's own functions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData, hashTypedData, parseAbi, recoverAddress, toFunctionSelector, type Hex } from 'viem';
import { previewRequest } from '../src/preview.ts';
import { StaticTokenRegistry } from '../src/chains.ts';
import { batchCalls } from '../src/evm/smart-account.ts';
import type { Dependencies, SimulationRequest } from '../src/types.ts';
import { codes, detail } from './helpers.ts';

// A mined execution (BNB Chain, 2026-11-23): what a relayer sent to an account running Calibur.
const MINED = JSON.parse(readFileSync(new URL('./fixtures/calibur-signed-batch.json', import.meta.url), 'utf8')) as { chainId: number; account: string; relayer: string; code: string; input: Hex };
const ABI = parseAbi(['struct Call { address to; uint256 value; bytes data; }', 'struct BatchedCall { Call[] calls; bool revertOnFailure; }', 'struct SignedBatchedCall { BatchedCall batchedCall; uint256 nonce; bytes32 keyHash; address executor; uint256 deadline; }',
  'function execute(BatchedCall batchedCall) payable', 'function execute(SignedBatchedCall signedBatchedCall, bytes wrappedSignature) payable',
  'function register((uint8 keyType, bytes publicKey) key)', 'function update(bytes32 keyHash, uint256 settings)', 'function approveNative(address spender, uint256 amount)', 'function updateEntryPoint(address entryPoint)',
  'function transfer(address,uint256)', 'function approve(address,uint256)']);
type Signed = { batchedCall: { calls: { to: Hex; value: bigint; data: Hex }[]; revertOnFailure: boolean }; nonce: bigint; keyHash: Hex; executor: Hex; deadline: bigint };
const [signedMined, wrapped] = decodeFunctionData({ abi: ABI, data: MINED.input }).args as unknown as [Signed, Hex];
const [SIGNATURE] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes' }], wrapped);
const ACCOUNT = MINED.account, CODE = MINED.code, CHAIN = MINED.chainId;
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', FRIEND = '0xc51e9af67c16a7176e244d8803a32aaf1430cb08', ZERO = '0x0000000000000000000000000000000000000000', ROOT = `0x${'00'.repeat(32)}` as Hex;
const TYPES = {
  EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }, { name: 'salt', type: 'bytes32' }],
  SignedBatchedCall: [{ name: 'batchedCall', type: 'BatchedCall' }, { name: 'nonce', type: 'uint256' }, { name: 'keyHash', type: 'bytes32' }, { name: 'executor', type: 'address' }, { name: 'deadline', type: 'uint256' }],
  BatchedCall: [{ name: 'calls', type: 'Call[]' }, { name: 'revertOnFailure', type: 'bool' }],
  Call: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }],
};
const salt = (code = CODE, prefix = 0n) => `0x${prefix.toString(16).padStart(24, '0')}${code.slice(2)}`;
const typed = (s: Signed, domain: Record<string, unknown> = {}, chainId = CHAIN) => ({
  domain: { name: 'Calibur', version: '1.0.0', chainId, verifyingContract: ACCOUNT, salt: salt(), ...domain }, types: structuredClone(TYPES), primaryType: 'SignedBatchedCall',
  message: { batchedCall: { calls: s.batchedCall.calls.map(c => ({ to: c.to, value: c.value.toString(), data: c.data })), revertOnFailure: s.batchedCall.revertOnFailure }, nonce: s.nonce.toString(), keyHash: s.keyHash, executor: s.executor, deadline: s.deadline.toString() },
});
const transfer = (amount: bigint, to = FRIEND) => encodeFunctionData({ abi: ABI, functionName: 'transfer', args: [to as Hex, amount] });
const batch = (calls: { to: string; value?: bigint; data: Hex }[], o: Partial<Signed> & { revertOnFailure?: boolean } = {}): Signed => ({
  batchedCall: { calls: calls.map(c => ({ to: c.to as Hex, value: c.value ?? 0n, data: c.data })), revertOnFailure: o.revertOnFailure ?? true }, nonce: o.nonce ?? 5n, keyHash: o.keyHash ?? ROOT, executor: o.executor ?? ZERO as Hex, deadline: o.deadline ?? signedMined.deadline });
const NOW = (Number(signedMined.deadline) - 600) * 1000;
const offline: Dependencies = { tokens: new StaticTokenRegistry() };
const sign = (t: unknown, d = offline, context: Record<string, unknown> = {}, signer = ACCOUNT) => previewRequest({ method: 'eth_signTypedData_v4', params: [signer, JSON.stringify(t)] }, { now: NOW, ...context }, d);

test('The typed data of a mined Calibur execution is what its account signed, and its calldata reads back into the same calls', async () => {
  // The format is the source's (Sourcify); that it was read right is the chain's to say: the signature the relayer
  // submitted recovers to the account over this typed data's digest, and to no one's over another's.
  const t = typed(signedMined);
  assert.equal((await recoverAddress({ hash: hashTypedData(t as never), signature: SIGNATURE })).toLowerCase(), ACCOUNT);
  for (const other of [typed(signedMined, { salt: salt(CODE, 1n) }), typed(signedMined, { name: 'Calibur', version: '1.0.1' }), typed({ ...signedMined, executor: MINED.relayer as Hex })])
    assert.notEqual((await recoverAddress({ hash: hashTypedData(other as never), signature: SIGNATURE })).toLowerCase(), ACCOUNT);
  // The mined calldata: its calls, in order, and that a call failing reverts them all.
  const mined = batchCalls(MINED.input)!;
  assert.deepEqual([mined.standard, mined.tryMode, mined.delegatecall, mined.calls.length], ['Calibur execute(SignedBatchedCall)', false, false, signedMined.batchedCall.calls.length]);
  assert.deepEqual(mined.calls.map(c => [c.target, c.value, c.data]), signedMined.batchedCall.calls.map(c => [c.to, c.value, c.data]));
});

test('A signed Calibur batch is previewed as its calls, made as the signer’s account by whoever submits it', async () => {
  // It was "Sign SignedBatchedCall", a format not interpreted, its calls lines of hex.
  const p = await sign(typed(signedMined));
  assert.equal(p.decoding.decoder, 'calibur_signed_batch');
  assert.match(p.title, /^Signed calls as you: Allow 0x8308…16D8 to spend 100 USDC → /);
  assert.match(p.summary, /^A signed batch \(Calibur\): whoever holds the signature may have your account make these 2 calls, once, all or nothing\. /);
  assert.deepEqual([detail(p, 'Account'), detail(p, 'Account code'), detail(p, 'Submitted by'), detail(p, 'Signed as')], [ACCOUNT, `Calibur (${CODE})`, 'anyone who holds the signature', "the account's own key"]);
  assert.equal(detail(p, 'Call 1: Spender')?.toLowerCase(), '0x8308d79c66111b8a90a60750d098de833a1516d8');
  assert.ok(!codes(p).some(c => c.startsWith('calibur_') || c === 'unknown_typed_data'), codes(p).join());
  assert.match(p.decoding.notes.join(' '), /Anyone who holds it can submit it until .*, once/);
  // One transfer, to a named executor: fully read.
  const one = await sign(typed(batch([{ to: USDC, data: transfer(5_500_000_000n) }], { executor: MINED.relayer as Hex }), {}, 1));
  assert.deepEqual([one.title, one.decoding.status, one.attention, detail(one, 'Submitted by'), detail(one, 'Amount')], ['Signed call as you: Send 5,500 USDC', 'full', 'none', MINED.relayer, '5,500 USDC']);
  assert.deepEqual(one.assetChanges.map(c => [c.direction, c.amount, c.symbol]), [['out', '5,500', 'USDC']]);
  // What is signed that Calibur wouldn't take, or that says more than its calls: another name or version, no salt,
  // a salt naming other code, no deadline, a deadline that has passed, another account's batch.
  const t = (o: Partial<Signed> = {}, domain: Record<string, unknown> = {}) => typed(batch([{ to: USDC, data: transfer(1n) }], o), domain, 1);
  assert.match((await sign(t({}, { version: '2.0.0' }))).warnings.find(w => w.code === 'calibur_domain')?.message ?? '', /the name "Calibur" \(version "2\.0\.0"\): Calibur checks signatures under "Calibur", version "1\.0\.0"/);
  assert.match((await sign(t({}, { salt: salt('0x00000000000000000000000000000000000000aa') }))).warnings.find(w => w.code === 'calibur_unknown_code')?.message ?? '', /isn't a Calibur this format was read from/);
  assert.equal((await sign(t({}, { salt: salt('0x00000000000000000000000000000000000000aa') }))).decoding.status, 'partial');
  const reordered = t();
  reordered.types.EIP712Domain = [...reordered.types.EIP712Domain].reverse();
  assert.match((await sign(reordered)).warnings.find(w => w.code === 'calibur_domain')?.message ?? '', /a domain whose fields aren't Calibur's/);
  assert.match((await sign(t({ deadline: 0n }))).warnings.find(w => w.code === 'calibur_no_deadline')?.message ?? '', /^It has no deadline: whoever holds it can submit it at any time/);
  assert.ok(codes(await sign(t(), offline, { now: (Number(signedMined.deadline) + 1) * 1000 })).includes('calibur_expired'));
  const other = await sign(t(), offline, {}, FRIEND);
  assert.match(other.warnings.find(w => w.code === 'calibur_other_account')?.message ?? '', /signed as that account's own key, but 0xc51e…cb08 is asked to sign it/);
  assert.match(other.title, /^Signed call as 0xd640…b2f1: /);
  // A batch that doesn't revert on failure runs each call on its own.
  const loose = await sign(typed(batch([{ to: USDC, data: transfer(1n) }, { to: USDC, data: transfer(2n) }], { revertOnFailure: false }), {}, 1));
  assert.match(loose.summary, /each on its own \(one that fails is skipped\)/);
  assert.match(loose.decoding.notes.join(' '), /doesn't revert on failure: a call that fails is skipped/);
  // More calls than are read: said, none decoded.
  const many = await sign(typed(batch(Array.from({ length: 33 }, (_, i) => ({ to: USDC, data: transfer(BigInt(i + 1)) }))), {}, 1));
  assert.deepEqual([many.attention, many.decoding.status, detail(many, 'More calls')], ['danger', 'opaque', '1']);
  // Another shape under the same name is any typed data.
  const odd = typed(signedMined);
  odd.types.SignedBatchedCall = odd.types.SignedBatchedCall.slice(0, 4);
  assert.equal((await sign(odd)).decoding.decoder, 'eip712_generic');
});

test('A signed Calibur batch against the chain: the account’s code, its nonce, calls that fail, and calls back into the account', async () => {
  const env = (o: { code?: string; next?: bigint; fails?: string } = {}) => {
    const sims: SimulationRequest[][] = [];
    const result = (r: SimulationRequest) => (o.fails ? { status: 'reverted' as const, source: 'mock', revertReason: o.fails, transfers: [] }
      : { status: 'success' as const, source: 'mock', gasUsed: 50_000n, transfers: r.to === USDC ? [{ asset: USDC, from: ACCOUNT, to: FRIEND, raw: BigInt(`0x${r.data.slice(-64)}`) }] : [] });
    const d: Dependencies = { ...offline,
      rpc: { has: () => true, call: async (_c: number, m: string, p: unknown[]) => m === 'eth_getCode' ? (String(p[0]).toLowerCase() === ACCOUNT ? o.code ?? `0xef0100${CODE.slice(2)}` : '0x6080')
        : m === 'eth_call' && (p[0] as { data: string }).data.startsWith(toFunctionSelector('getSeq(uint256)')) ? `0x${(o.next ?? 5n).toString(16).padStart(64, '0')}` : '0x' },
      simulator: { simulate: async r => { sims.push([r]); return result(r); }, simulateBatch: async rs => { sims.push(rs); return rs.map(result); } } };
    return { d, sims };
  };
  const t = (calls: { to: string; value?: bigint; data: Hex }[], o: Partial<Signed> & { revertOnFailure?: boolean } = {}) => typed(batch(calls, o), {}, 1);
  // The account runs Calibur and the nonce is its next: the call is simulated from the account, nothing warned of.
  const ok = env();
  const p = await sign(t([{ to: USDC, data: transfer(5_500_000_000n) }]), ok.d);
  assert.ok(!codes(p).some(c => c.startsWith('calibur_')), codes(p).join());
  assert.deepEqual([ok.sims[0][0].from, ok.sims[0][0].to, ok.sims[0][0].data], [ACCOUNT, USDC, transfer(5_500_000_000n)]);
  assert.deepEqual(p.assetChanges.map(c => [c.direction, c.raw, c.basis]), [['out', '5500000000', 'simulated_events']]);
  assert.match(p.decoding.notes.join(' '), /Simulated as the account making the call, on the current state/);
  // No code at the account, or other code; a nonce behind the account's sequence, or ahead of it.
  assert.match((await sign(t([{ to: USDC, data: transfer(1n) }]), env({ code: '0x' }).d)).warnings.find(w => w.code === 'calibur_no_code')?.message ?? '', /takes effect once the account is delegated to 0x0000…8f00/);
  assert.match((await sign(t([{ to: USDC, data: transfer(1n) }]), env({ code: `0xef0100${'11'.repeat(20)}` }).d)).warnings.find(w => w.code === 'calibur_other_code')?.message ?? '', /runs other code \(0x1111…1111\) now, not Calibur/);
  const used = await sign(t([{ to: USDC, data: transfer(1n) }]), env({ next: 6n, fails: 'ERC20: transfer amount exceeds balance' }).d);
  assert.ok(codes(used).includes('calibur_nonce_used') && !codes(used).includes('calibur_batch_fails'), codes(used).join());
  assert.match((await sign(t([{ to: USDC, data: transfer(1n) }]), env({ next: 3n }).d)).warnings.find(w => w.code === 'calibur_nonce_ahead')?.message ?? '', /its sequence is at 3, this is 5\): the batch can't run until the 2 before it are used/);
  // A call that fails now: with revertOnFailure nothing moves and the signature stays good; without, it is skipped.
  const failing = await sign(t([{ to: USDC, data: transfer(1n) }]), env({ fails: 'ERC20: transfer amount exceeds balance' }).d);
  assert.match(failing.warnings.find(w => w.code === 'calibur_batch_fails')?.message ?? '', /^The call would fail if it was submitted now \(ERC20: transfer amount exceeds balance\): nothing would move now\. But the signature stays valid until /);
  assert.ok(!codes(failing).includes('simulation_reverted'));
  // Calls back into the account: a key registered on it can make calls as the account until it is revoked, an
  // admin key can do all the account can. To the account's address or to the zero address, which Calibur takes to
  // mean itself.
  const key = encodeAbiParameters([{ type: 'address' }], [FRIEND as Hex]);
  const register = encodeFunctionData({ abi: ABI, functionName: 'register', args: [{ keyType: 2, publicKey: key }] });
  for (const to of [ACCOUNT, ZERO]) {
    const r = await sign(t([{ to, data: register }]), env().d);
    assert.equal(r.attention, 'danger', to);
    assert.match(r.warnings.find(w => w.code === 'calibur_register_key')?.message ?? '', /^This registers an Ethereum key, 0xc51e9af67c16a7176e244d8803a32aaf1430cb08, on your account: whoever holds it can make calls as the account/);
    assert.equal(r.title, 'Signed call as you: Register an Ethereum key (0xc51e…cb08) on your account');
    assert.ok(!codes(r).includes('unknown_function'));
  }
  const adminKey = await sign(t([{ to: USDC, data: transfer(1n) }, { to: ACCOUNT, data: encodeFunctionData({ abi: ABI, functionName: 'update', args: [`0x${'ab'.repeat(32)}`, 1n << 200n] }) }]), env().d);
  assert.match(adminKey.warnings.find(w => w.code === 'calibur_admin_key')?.message ?? '', /^Call 2: makes the key 0xabababab…abab an admin of your account \(an admin, with no expiry, with no hook checking its calls\)/);
  assert.match(detail(adminKey, 'Call 2') ?? '', /^Set a key's rights on your account \(admin\) \(0xd640…b2f1\)$/);
  // The coin of the account lent out, and an EntryPoint that isn't ERC-4337's.
  const lent = await sign(t([{ to: ACCOUNT, data: encodeFunctionData({ abi: ABI, functionName: 'approveNative', args: [FRIEND as Hex, (1n << 256n) - 1n] }) }]), env().d);
  assert.match(lent.warnings.find(w => w.code === 'calibur_native_approval')?.message ?? '', /lets 0xc51e9af67c16a7176e244d8803a32aaf1430cb08 take any amount of ETH from your account/);
  const entry = await sign(t([{ to: ACCOUNT, data: encodeFunctionData({ abi: ABI, functionName: 'updateEntryPoint', args: [FRIEND as Hex] }) }]), env().d);
  assert.deepEqual([entry.attention, codes(entry).includes('calibur_entry_point')], ['danger', true]);
  assert.equal((await sign(t([{ to: ACCOUNT, data: encodeFunctionData({ abi: ABI, functionName: 'updateEntryPoint', args: ['0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108'] }) }]), env().d)).warnings.find(w => w.code === 'calibur_entry_point')?.severity, 'info');
  // One that isn't one of Calibur's own functions isn't read: said.
  assert.match((await sign(t([{ to: ACCOUNT, data: '0x12345678' }]), env().d)).warnings.find(w => w.code === 'calibur_self_call')?.message ?? '', /^The call is one back into the account itself \(0x12345678\) that isn't read/);
});

test('Calibur’s own batch, sent by the account to itself, and a UserOperation’s callData for it', async () => {
  const send = (data: Hex, d: Dependencies = offline) => previewRequest({ method: 'eth_sendTransaction', params: [{ from: ACCOUNT, to: ACCOUNT, data, chainId: '0x1' }] }, { now: NOW }, d);
  const own = (calls: { to: string; value?: bigint; data: Hex }[], revertOnFailure = true) => encodeFunctionData({ abi: ABI, functionName: 'execute', args: [{ calls: calls.map(c => ({ to: c.to as Hex, value: c.value ?? 0n, data: c.data })), revertOnFailure }] });
  // It was a call to the account that couldn't be decoded (seven of 166 calls to accounts running delegated code
  // in 25 Ethereum blocks, 2026-11-23).
  const p = await send(own([{ to: USDC, data: transfer(1_000_000n) }, { to: USDC, data: transfer(2_000_000n) }]));
  assert.deepEqual([p.title, p.decoding.decoder, detail(p, 'Format'), detail(p, 'Call 2')], ['Run 2 calls from your account', 'smart_account', 'Calibur execute(BatchedCall)', 'Send 2 USDC (0xa0b8…eb48)']);
  assert.equal(own([]).slice(0, 10), '0x99e1d016');
  // Without revertOnFailure a call that fails is skipped ("try" mode).
  assert.match((await send(own([{ to: USDC, data: transfer(1n) }, { to: USDC, data: transfer(2n) }], false))).decoding.notes.join(' '), /"try" mode: a call that fails is skipped/);
  // A call back into the account: Calibur's own functions, in a batch only Calibur has.
  const key = encodeAbiParameters([{ type: 'address' }], [FRIEND as Hex]);
  const registering = await send(own([{ to: USDC, data: transfer(1n) }, { to: ZERO, data: encodeFunctionData({ abi: ABI, functionName: 'register', args: [{ keyType: 2, publicKey: key }] }) }]));
  assert.deepEqual([registering.attention, codes(registering).includes('calibur_register_key'), codes(registering).includes('smart_account_self_call')], ['danger', true, false]);
  assert.match(detail(registering, 'Call 2') ?? '', /^Register an Ethereum key \(0xc51e…cb08\) on your account/);
  // One of Calibur's own functions sent straight to the account, where the account is known to run Calibur: by the
  // delegation its code is now, or not at all (an account running other code has other functions under a selector).
  const chain = (code: string): Dependencies => ({ ...offline, rpc: { has: () => true, call: async (_c: number, m: string) => (m === 'eth_getCode' ? code : '0x') } });
  const direct = await send(encodeFunctionData({ abi: ABI, functionName: 'register', args: [{ keyType: 1, publicKey: `0x${'11'.repeat(64)}` }] }), chain(`0xef0100${CODE.slice(2)}`));
  assert.deepEqual([direct.title, direct.attention, direct.decoding.decoder, codes(direct).includes('calibur_register_key')], ['Register a passkey (WebAuthn, P-256) on your account', 'danger', 'smart_account', true]);
  const elsewhere = await send(encodeFunctionData({ abi: ABI, functionName: 'register', args: [{ keyType: 1, publicKey: `0x${'11'.repeat(64)}` }] }), chain(`0xef0100${'22'.repeat(20)}`));
  assert.ok(!codes(elsewhere).includes('calibur_register_key'));
  // A UserOperation's callData for Calibur: executeUserOp's selector, then the batch. Other bytes after that
  // selector are another account's layout, and aren't read as this one.
  const [encoded] = [encodeAbiParameters([{ type: 'tuple', components: [{ name: 'calls', type: 'tuple[]', components: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }] }, { name: 'revertOnFailure', type: 'bool' }] }],
    [{ calls: [{ to: USDC as Hex, value: 0n, data: transfer(7n) }], revertOnFailure: true }])];
  const viaEntryPoint = batchCalls(`0x8dd7712f${encoded.slice(2)}`)!;
  assert.deepEqual([viaEntryPoint.standard, viaEntryPoint.calls.map(c => [c.target.toLowerCase(), c.data])], ['Calibur executeUserOp', [[USDC, transfer(7n)]]]);
  assert.equal(batchCalls(`0x8dd7712f${encoded.slice(2)}00`), null);
  assert.equal(batchCalls('0x8dd7712f1234'), null);
});

test('Every call of a signed Calibur batch is told: a second key, EntryPoint or allowance isn’t hidden behind the first', async () => {
  const EVIL = '0x96221423681a6d52e184d440a8efcebb105c7242', V08 = '0x4337084d9e255ff0702461cf8895ce9e3b5ff108';
  const t = (calls: { to: string; value?: bigint; data: Hex }[], o: Partial<Signed> & { revertOnFailure?: boolean } = {}) => typed(batch(calls, o), {}, 1);
  const entry = (to: string) => encodeFunctionData({ abi: ABI, functionName: 'updateEntryPoint', args: [to as Hex] });
  const lend = (to: string, amount: bigint) => encodeFunctionData({ abi: ABI, functionName: 'approveNative', args: [to as Hex, amount] });
  const reg = (who: string) => encodeFunctionData({ abi: ABI, functionName: 'register', args: [{ keyType: 2, publicKey: encodeAbiParameters([{ type: 'address' }], [who as Hex]) }] });
  // A warning code was kept once, its first: ERC-4337's EntryPoint set, then another's, was "info", the second unsaid.
  const two = await sign(t([{ to: ACCOUNT, data: entry(V08) }, { to: ACCOUNT, data: entry(EVIL) }]));
  assert.equal(two.attention, 'danger');
  assert.match(two.warnings.find(w => w.code === 'calibur_entry_point')!.message, new RegExp(`^Call 1: sets your account's EntryPoint to ${V08} \\(ERC-4337's v0\\.8\\)\\. Call 2: makes ${EVIL} your account's EntryPoint, which isn't one of ERC-4337's`));
  const lent = await sign(t([{ to: ACCOUNT, data: lend(FRIEND, 1n) }, { to: ZERO, data: lend(EVIL, (1n << 256n) - 1n) }]));
  assert.match(lent.warnings.find(w => w.code === 'calibur_native_approval')!.message, new RegExp(`Call 1: lets ${FRIEND} take up to 0\\.000000000000000001 ETH .* Call 2: lets ${EVIL} take any amount of ETH`));
  const keys = await sign(t([{ to: ACCOUNT, data: reg(FRIEND) }, { to: ACCOUNT, data: reg(EVIL) }]));
  assert.match(keys.warnings.find(w => w.code === 'calibur_register_key')!.message, new RegExp(`Call 1: registers an Ethereum key, ${FRIEND}, .* Call 2: registers an Ethereum key, ${EVIL},`));
  // And what the calls' own previews warn of: two unlimited approvals are two.
  const approve = (spender: string) => encodeFunctionData({ abi: ABI, functionName: 'approve', args: [spender as Hex, (1n << 256n) - 1n] });
  const both = await sign(t([{ to: USDC, data: approve(FRIEND) }, { to: USDC, data: approve(EVIL) }]));
  const unlimited = both.warnings.filter(w => /unlimited/.test(w.code));
  assert.equal(unlimited.length, 1);
  assert.match(unlimited[0].message, /^Call 1: .* Call 2: /);
  // A call back into the account silences "a function that isn't known" for itself alone: a call to unknown code
  // beside it, with 5 ETH, was left with nothing said.
  const beside = await sign(t([{ to: ACCOUNT, data: lend(FRIEND, 0n) }, { to: EVIL, value: 5n * 10n ** 18n, data: '0xdeadbeef' }]));
  assert.match(beside.warnings.find(w => w.code === 'unknown_function')?.message ?? '', /^Call 2: /);
  assert.notEqual(beside.attention, 'none');
  assert.ok(!(await sign(t([{ to: ACCOUNT, data: lend(FRIEND, 0n) }]))).warnings.some(w => w.code === 'unknown_function'));
  // EntryPoint v0.9 is ERC-4337's (it was a danger); v0.6's operations Calibur doesn't read.
  assert.equal((await sign(t([{ to: ACCOUNT, data: entry('0x433709009B8330FDa32311DF1C2AFA402eD8D009') }]))).warnings.find(w => w.code === 'calibur_entry_point')?.severity, 'info');
  const v06 = (await sign(t([{ to: ACCOUNT, data: entry('0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789') }]))).warnings.find(w => w.code === 'calibur_entry_point')!;
  assert.deepEqual([v06.severity, /v0\.6, whose operations are in an older form than Calibur reads/.test(v06.message)], ['caution', true]);
  // Signing as a key registered on another account: the account isn't "yours".
  const KEY = `0x${'cd'.repeat(32)}` as Hex;
  const forOther = await sign(t([{ to: ACCOUNT, data: reg(EVIL) }], { keyHash: KEY }), offline, {}, FRIEND);
  assert.match(forOther.warnings.find(w => w.code === 'calibur_register_key')!.message, /^This registers an Ethereum key, 0x9622[0-9a-f]+, on 0xd640…b2f1: whoever holds it can make calls as the account, moving anything it holds, until it is revoked/);
  assert.equal(forOther.title, 'Signed call as 0xd640…b2f1: Register an Ethereum key (0x9622…7242) on 0xd640…b2f1');
  // The account's own key asked to sign as a registered key: Calibur checks it against that key.
  assert.equal((await sign(t([{ to: USDC, data: transfer(1n) }], { keyHash: KEY }))).warnings.find(w => w.code === 'calibur_key_mismatch')?.severity, 'info');
});

test('A Calibur key’s settings are read as each deployment reads them: the admin byte, and what a hook is called for', async () => {
  const t = (calls: { to: string; value?: bigint; data: Hex }[]) => typed(batch(calls), {}, 1);
  const KEY = `0x${'ab'.repeat(32)}` as Hex, exp = BigInt(Math.floor(NOW / 1000) + 86400) << 160n;
  const update = (settings: bigint) => encodeFunctionData({ abi: ABI, functionName: 'update', args: [KEY, settings] });
  const said = async (settings: bigint) => { const p = await sign(t([{ to: ACCOUNT, data: update(settings) }])); return p.warnings.find(w => w.code === 'calibur_admin_key' || w.code === 'calibur_key_settings')!; };
  // The older Calibur takes any bit of the byte at 200 as the admin flag (bit 201 was "not an admin"); the newer
  // refuses bits above 200.
  for (const bit of [201n, 207n]) {
    const w = await said(1n << bit | exp);
    assert.deepEqual([w.code, w.severity], ['calibur_admin_key', 'danger'], String(bit));
    assert.match(w.message, /It is made one by a bit above the admin flag's own: the older Calibur \(0x…9b8f00\) reads any bit of that byte as the flag, and the newer refuses such settings\.$/);
  }
  assert.match((await said(1n << 210n)).message, /not an admin, .* Its settings set bits the newer Calibur reserves: it refuses them\.$/);
  assert.ok(!/reserves|above the admin/.test((await said(1n << 200n)).message));
  // A hook is called for what the low bits of its address enable: with neither execution bit it checks no call.
  const hook = (low: number) => BigInt(`0x${'c0de'.repeat(9)}00${low.toString(16).padStart(2, '0')}`);
  assert.match((await said(hook(0x18))).message, /its calls checked by the hook 0xc0de[0-9a-f]+18 \(called for each call, before it, each call, after it\)/);
  assert.match((await said(hook(0x04))).message, /with a hook \(0xc0de[0-9a-f]+04\) that isn't called on the calls it makes, only for a signature checked for the account \(ERC-1271\): nothing checks its calls/);
  assert.match((await said(hook(0x20))).message, /with a hook \(0xc0de[0-9a-f]+20\) whose address enables none of its checks: it is never called/);
  assert.match((await said(0n)).message, /with no hook checking its calls/);
  // The older Calibur's multicall runs each of its calls on the account: read as they are, each told.
  const MULTI = parseAbi(['function multicall(bytes[] data)', 'function updateSalt(uint96 prefix)', 'function approveNativeTransient(address spender, uint256 amount)']);
  const reg = encodeFunctionData({ abi: ABI, functionName: 'register', args: [{ keyType: 2, publicKey: encodeAbiParameters([{ type: 'address' }], [FRIEND as Hex]) }] });
  const multi = await sign(t([{ to: ACCOUNT, data: encodeFunctionData({ abi: MULTI, functionName: 'multicall', args: [[reg, update(1n << 200n)]] }) }]));
  assert.deepEqual([multi.attention, multi.decoding.status], ['danger', 'full']);
  assert.match(multi.warnings.find(w => w.code === 'calibur_register_key')!.message, /^This \(1 of 2 in a multicall\) registers an Ethereum key/);
  assert.match(multi.warnings.find(w => w.code === 'calibur_admin_key')!.message, /^This \(2 of 2 in a multicall\) makes the key/);
  assert.match(multi.title, /^Signed call as you: 2 changes to your account: Register an Ethereum key \(0xc51e…cb08\) on your account; Set a key's rights on your account \(admin\)$/);
  // One with a call that isn't the account's own function isn't read as a whole, but what was read is still said.
  const part = await sign(t([{ to: ACCOUNT, data: encodeFunctionData({ abi: MULTI, functionName: 'multicall', args: [[reg, '0x12345678']] }) }]));
  assert.deepEqual([codes(part).includes('calibur_register_key'), codes(part).includes('calibur_self_call'), part.decoding.status], [true, true, 'partial']);
  // Its other own functions: the salt with a prefix, and an allowance for one transaction.
  assert.ok(codes(await sign(t([{ to: ACCOUNT, data: encodeFunctionData({ abi: MULTI, functionName: 'updateSalt', args: [7n] }) }]))).includes('calibur_update_salt'));
  assert.match((await sign(t([{ to: ACCOUNT, data: encodeFunctionData({ abi: MULTI, functionName: 'approveNativeTransient', args: [FRIEND as Hex, 10n ** 18n] }) }]))).warnings.find(w => w.code === 'calibur_native_approval')!.message, /take up to 1 ETH from your account \(its native allowance, ERC-7914\), for the rest of this transaction\.$/);
});

test('A signed Calibur batch is for the chain its digest is for, and a deadline that never comes is none', async () => {
  const reg = encodeFunctionData({ abi: ABI, functionName: 'register', args: [{ keyType: 2, publicKey: encodeAbiParameters([{ type: 'address' }], [FRIEND as Hex]) }] });
  // Forms of a chain id the digest takes as 1 (BigInt's): read as no chain, the preview was for the wallet's chain.
  for (const chainId of [' 1', '1 ', '0b1', true, [1]] as unknown[]) {
    const t = typed(batch([{ to: USDC, data: transfer(1n) }]), { chainId });
    assert.equal(hashTypedData({ ...t, domain: { ...t.domain, chainId: 1 } } as never), hashTypedData(typed(batch([{ to: USDC, data: transfer(1n) }]), {}, 1) as never));
    const p = await sign(t, offline, { chainId: 8453 });
    assert.deepEqual([(p.network as { chainId?: number } | null)?.chainId, codes(p).includes('chain_mismatch')], [1, true], JSON.stringify(chainId));
  }
  // With no chain to read the calls for, what a call back into the account does is still said.
  const t = typed(batch([{ to: ACCOUNT, data: reg }]));
  delete (t.domain as Record<string, unknown>).chainId;
  t.types.EIP712Domain = t.types.EIP712Domain.filter(f => f.name !== 'chainId');
  const chainless = await sign(t);
  assert.deepEqual([chainless.attention, codes(chainless).includes('calibur_register_key'), codes(chainless).includes('calibur_unread')], ['danger', true, true]);
  // A domain with no type given and no chain isn't one Calibur computes a digest over.
  const untyped = typed(batch([{ to: USDC, data: transfer(1n) }]));
  delete (untyped.domain as Record<string, unknown>).chainId;
  delete (untyped.types as Record<string, unknown>).EIP712Domain;
  assert.match((await sign(untyped, offline, { chainId: 1 })).warnings.find(w => w.code === 'calibur_domain')?.message ?? '', /^It is signed under a domain that names no chain/);
  // A deadline of the largest number, or years off, is no deadline: it was "a time that will not come", nothing said.
  const forever = await sign(typed(batch([{ to: USDC, data: transfer(1n) }], { deadline: (1n << 256n) - 1n }), {}, 1));
  assert.deepEqual([forever.attention, detail(forever, 'Valid until')], ['caution', 'a time that will not come']);
  assert.match(forever.warnings.find(w => w.code === 'calibur_no_deadline')!.message, /^Its deadline is a time that will not come: whoever holds it can submit it at any time, until its nonce is used/);
  const years = await sign(typed(batch([{ to: USDC, data: transfer(1n) }], { deadline: BigInt(Math.floor(NOW / 1000)) + 3n * 365n * 86400n + 86400n }), {}, 1));
  assert.match(years.warnings.find(w => w.code === 'calibur_no_deadline')!.message, /^Its deadline is 3 years away \(20\d\d-/);
  assert.ok(!codes(await sign(typed(batch([{ to: USDC, data: transfer(1n) }]), {}, 1))).includes('calibur_no_deadline'));
});

test('wallet_sendCalls to the zero address: the account itself where it runs Calibur, said to be either where that isn’t known', async () => {
  const reg = encodeFunctionData({ abi: ABI, functionName: 'register', args: [{ keyType: 2, publicKey: encodeAbiParameters([{ type: 'address' }], [FRIEND as Hex]) }] });
  const chain = (code: string): Dependencies => ({ ...offline, rpc: { has: () => true, call: async (_c: number, m: string) => (m === 'eth_getCode' ? code : '0x') } });
  const calls = (d: Dependencies) => previewRequest({ method: 'wallet_sendCalls', params: [{ version: '2.0.0', chainId: '0x1', from: ACCOUNT, calls: [{ to: USDC, data: transfer(1_000_000n) }, { to: ZERO, data: reg }] }] }, { now: NOW }, d);
  // It read "Call contract 0x0000…", a function that isn't known: a key registered on the account.
  const calibur = await calls(chain(`0xef0100${CODE.slice(2)}`));
  assert.equal(calibur.attention, 'danger');
  assert.match(calibur.warnings.find(w => w.code === 'calibur_register_key')?.message ?? '', /^Call 2: This registers an Ethereum key/);
  assert.match(calibur.decoding.notes.join(' '), /Call 2 is to the zero address, which your account's code \(Calibur\) takes to mean the account itself: it is read, and simulated, as a call to your own account\./);
  assert.equal(calibur.calls?.[1].title, 'Register an Ethereum key (0xc51e…cb08) on your account');
  // Other code, or none read: it may be a call into the account, and that is said.
  for (const d of [chain(`0xef0100${'22'.repeat(20)}`), offline]) {
    const other = await calls(d);
    assert.ok(!codes(other).includes('calibur_register_key'));
    assert.match(other.warnings.find(w => w.code === 'zero_address_call')?.message ?? '', /^Call 2 is to the zero address with calldata: a wallet whose account code follows ERC-7821 \(Calibur, Porto\) runs that as a call into your own account/);
  }
  // A plain transfer of coin to the zero address is only that.
  const burn = await previewRequest({ method: 'wallet_sendCalls', params: [{ version: '2.0.0', chainId: '0x1', from: ACCOUNT, calls: [{ to: ZERO, value: '0x1' }] }] }, { now: NOW }, offline);
  assert.ok(!codes(burn).includes('zero_address_call'));
});
