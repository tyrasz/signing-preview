// Gasless executions signed for an EIP-7702 account running UniversalGaslessDelegate (src/typed-data/authorized-executions.ts),
// and the same executions read back from the chain (src/evm/smart-account.ts, batchCalls).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData, hashTypedData, parseAbi, recoverAddress, type Hex } from 'viem';
import { previewRequest } from '../src/preview.ts';
import { StaticTokenRegistry } from '../src/chains.ts';
import { batchCalls } from '../src/evm/smart-account.ts';
import type { Dependencies, SimulationRequest } from '../src/types.ts';
import { codes, detail } from './helpers.ts';

// A mined execution (Ethereum, block 26,475,863, 0x020546fb…093d): the relayer 0xfa17…d27f has the account
// 0x034c…b026 send 5,500 USDC. Its calldata as mined.
const MINED = '0xe9ae5c530000000000007821000100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000001a0000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000e00000000000000000000000000000000000000000000000000000000000000078a0b86991c6218b36c1d19d4a2e9eb0ce3606eb480000000000000000000000000000000000000000000000000000000000000000a9059cbb000000000000000000000000c51e9af67c16a7176e244d8803a32aaf1430cb080000000000000000000000000000000000000000000000000000000147d3570000000000000000000000000000000000000000000000000000000000000000000000000000000081b20101f63c6a9532da32f231646106d7972341aa1b52907f1bd78c9b66fff867000000000000000000000000000000000000000000000000000000006b03f0cbadb11fb161b88d764ad0367320493643d8fc4e964979eb3d5df59ccf6336a2c46efd18becf82c40dbc730b7e087767cf7cb28c33a3246bdd9c7363ce24b47f591b00000000000000000000000000000000000000000000000000000000000000' as Hex;
const ACCOUNT = '0x034c8ef153d711829a1fe814a9bd03faf28fb026', RELAYER = '0xfa176be60ee2227268030d245c4214599431d27f', DELEGATE = '0x0000fb7702036ff9f76044a501ac1aa74cbab16b';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', RECIPIENT = '0xc51e9af67c16a7176e244d8803a32aaf1430cb08';
const EXECUTE = parseAbi(['function execute(bytes32 mode, bytes executionData)']);
const CALLS = [{ type: 'tuple[]', components: [{ name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }] }] as const;
const SINGLE = `0x00000000000078210001${'00'.repeat(22)}` as Hex, BATCH = `0x01000000000078210001${'00'.repeat(22)}` as Hex;
const transfer = (amount: bigint) => encodeFunctionData({ abi: parseAbi(['function transfer(address,uint256)']), functionName: 'transfer', args: [RECIPIENT, amount] });

const [, executionData] = decodeFunctionData({ abi: EXECUTE, data: MINED }).args;
const [, opData] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes' }], executionData);
const NONCE = BigInt(`0x${opData.slice(2, 66)}`), DEADLINE = BigInt(`0x${opData.slice(66, 130)}`), SIGNATURE = `0x${opData.slice(130)}` as Hex;
const typed = (m: Record<string, unknown> = {}, domain: Record<string, unknown> = {}) => ({
  domain: { chainId: 1, verifyingContract: DELEGATE, ...domain },
  types: { EIP712Domain: [{ name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
    AuthorizedExecutions: [{ name: 'calls', type: 'Execution[]' }, { name: 'deadline', type: 'uint256' }, { name: 'mode', type: 'bytes32' }, { name: 'nonce', type: 'uint256' }, { name: 'relayer', type: 'address' }],
    Execution: [{ name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }] },
  primaryType: 'AuthorizedExecutions',
  message: { calls: [{ target: USDC, value: '0', data: transfer(5_500_000_000n) }], deadline: DEADLINE.toString(), mode: SINGLE, nonce: NONCE.toString(), relayer: RELAYER, ...m },
});
// Before its deadline (2026-11-23 07:52:43 UTC).
const NOW = (Number(DEADLINE) - 3600) * 1000;
const offline: Dependencies = { tokens: new StaticTokenRegistry() };
const sign = (t: ReturnType<typeof typed>, d = offline, context: Record<string, unknown> = {}) => previewRequest({ method: 'eth_signTypedData_v4', params: [ACCOUNT, JSON.stringify(t)] }, { now: NOW, ...context }, d);

test('The typed data of a mined execution is what its account signed, and its calldata reads back into the same call', async () => {
  // The format is the delegate's source's (Sourcify); that it was read right is the chain's to say: the signature
  // the relayer submitted recovers to the account over this typed data's digest, and to no one's over another's.
  assert.equal((await recoverAddress({ hash: hashTypedData(typed() as never), signature: SIGNATURE })).toLowerCase(), ACCOUNT);
  assert.notEqual((await recoverAddress({ hash: hashTypedData(typed({ relayer: ACCOUNT }) as never), signature: SIGNATURE })).toLowerCase(), ACCOUNT);
  // The mined calldata: one call, the transfer (read as a packed single call from the top it had a value of 9e30).
  const mined = batchCalls(MINED)!;
  assert.deepEqual(mined.calls.map(c => [c.target, c.value, c.data]), [[USDC, 0n, transfer(5_500_000_000n)]]);
  assert.deepEqual([mined.delegatecall, mined.tryMode], [false, false]);
  // Its batch on a signature: the calls encoded on their own, as bytes, before the nonce, deadline and signature.
  const calls = [{ target: USDC as Hex, value: 0n, data: transfer(1n) }, { target: RECIPIENT as Hex, value: 7n, data: '0x' as Hex }];
  const batch = encodeFunctionData({ abi: EXECUTE, functionName: 'execute', args: [BATCH, encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes' }], [encodeAbiParameters(CALLS, [calls]), opData])] });
  assert.deepEqual(batchCalls(batch)!.calls.map(c => [c.target.toLowerCase(), c.value, c.data]), calls.map(c => [c.target, c.value, c.data]));
  // A single call under a mode selector that isn't known is laid out as its own account has it: not guessed at.
  const other = `0x00000000000012345678${'00'.repeat(22)}` as Hex;
  assert.equal(batchCalls(encodeFunctionData({ abi: EXECUTE, functionName: 'execute', args: [other, executionData] })), null);
  // (The plain single call, and ERC-7821's batch with opData, as before.)
  const plain = `0x${'00'.repeat(32)}` as Hex, packed = `${USDC}${'00'.repeat(32)}${transfer(1n).slice(2)}` as Hex;
  assert.deepEqual(batchCalls(encodeFunctionData({ abi: EXECUTE, functionName: 'execute', args: [plain, packed] }))!.calls.map(c => [c.target, c.data]), [[USDC, transfer(1n)]]);
  const standard = encodeFunctionData({ abi: EXECUTE, functionName: 'execute', args: [BATCH, encodeAbiParameters([...CALLS, { type: 'bytes' }], [calls, '0x1234'])] });
  assert.equal(batchCalls(standard)!.calls.length, 2);
});

test('A signed gasless execution is previewed as its call, made by the relayer as the signer’s account', async () => {
  // It was "Sign AuthorizedExecutions", a format not interpreted, the call a line of hex.
  const p = await sign(typed());
  assert.equal(p.decoding.decoder, 'authorized_executions');
  assert.equal(p.title, 'Gasless call as you: Send 5,500 USDC');
  assert.match(p.summary, /^A signed gasless execution \(UniversalGaslessDelegate\): the relayer 0xfa17…d27f may make this call as your account 0x034c…b026, all or nothing\.$/);
  assert.equal(detail(p, 'Account code'), `UniversalGaslessDelegate (${DELEGATE})`);
  assert.equal(detail(p, 'Relayer'), RELAYER);
  assert.equal(detail(p, 'Valid until'), '2026-11-23T07:52:43Z');
  assert.equal(detail(p, 'Amount'), '5,500 USDC');
  assert.deepEqual(p.assetChanges.map(c => [c.direction, c.amount, c.symbol]), [['out', '5,500', 'USDC']]);
  assert.ok(!codes(p).some(c => c.startsWith('gasless_exec_') || c === 'unknown_typed_data'), codes(p).join());
  assert.match(p.decoding.notes.join(' '), /The relayer 0xfa17…d27f, and no one else, can submit it until 2026-11-23T07:52:43Z, once/);
  // What the account code would refuse: a mode it doesn't run on a signature, several calls in the single-call
  // mode, a deadline that has passed. And another verifying contract is code this wasn't read from.
  assert.match((await sign(typed({ mode: `0x${'00'.repeat(32)}` }))).warnings.find(w => w.code === 'gasless_exec_mode')?.message ?? '', /isn't one the account code runs on a signature/);
  const two = [{ target: USDC, value: '0', data: transfer(1n) }, { target: USDC, value: '0', data: transfer(2n) }];
  assert.match((await sign(typed({ calls: two }))).warnings.find(w => w.code === 'gasless_exec_mode')?.message ?? '', /Its mode is for a single call, and it lists 2/);
  assert.ok(!codes(await sign(typed({ calls: two, mode: BATCH }))).includes('gasless_exec_mode'));
  assert.ok(codes(await sign(typed(), offline, { now: (Number(DEADLINE) + 1) * 1000 })).includes('gasless_exec_expired'));
  const elsewhere = await sign(typed({}, { verifyingContract: '0x00000000000000000000000000000000000000aa' }));
  assert.equal(elsewhere.warnings.find(w => w.code === 'gasless_exec_unknown_code')?.severity, 'caution');
  assert.equal(elsewhere.decoding.status, 'partial');
  // Another shape under the same name is any typed data.
  const odd = typed();
  odd.types.AuthorizedExecutions = odd.types.AuthorizedExecutions.slice(0, 4);
  assert.equal((await sign(odd)).decoding.decoder, 'eip712_generic');
});

test('A gasless execution against the chain: the account’s code, the nonce, and the calls simulated as the account makes them', async () => {
  const env = (o: { code?: string; used?: boolean; fails?: string } = {}) => {
    const sims: SimulationRequest[][] = [];
    const result = (r: SimulationRequest) => (o.fails ? { status: 'reverted' as const, source: 'mock', revertReason: o.fails, transfers: [] }
      : { status: 'success' as const, source: 'mock', gasUsed: 50_000n, transfers: r.to === USDC ? [{ asset: USDC, from: ACCOUNT, to: RECIPIENT, raw: BigInt(`0x${r.data.slice(-64)}`) }] : [] });
    const d: Dependencies = { ...offline,
      rpc: { has: () => true, call: async (_c: number, m: string, p: unknown[]) => m === 'eth_getCode' ? (String(p[0]).toLowerCase() === ACCOUNT ? o.code ?? `0xef0100${DELEGATE.slice(2)}` : '0x6080')
        : m === 'eth_call' && (p[0] as { data: string }).data.startsWith('0x5d00bb12') ? `0x${(o.used ? 1n : 0n).toString(16).padStart(64, '0')}` : '0x' },
      simulator: { simulate: async r => { sims.push([r]); return result(r); }, simulateBatch: async rs => { sims.push(rs); return rs.map(result); } } };
    return { d, sims };
  };
  // The account runs the delegate, the nonce is unused: the call is simulated from the account, and nothing is warned of.
  const ok = env();
  const p = await sign(typed(), ok.d);
  assert.ok(!codes(p).some(c => c.startsWith('gasless_exec_')), codes(p).join());
  assert.deepEqual([ok.sims[0][0].from, ok.sims[0][0].to, ok.sims[0][0].data], [ACCOUNT, USDC, transfer(5_500_000_000n)]);
  assert.deepEqual(p.assetChanges.map(c => [c.direction, c.raw, c.basis]), [['out', '5500000000', 'simulated_events']]);
  assert.match(p.decoding.notes.join(' '), /Simulated as your account making the call, on the current state/);
  // No code at the account, or other code: nothing takes the signature as things are.
  assert.match((await sign(typed(), env({ code: '0x' }).d)).warnings.find(w => w.code === 'gasless_exec_no_code')?.message ?? '', /takes effect once the account is delegated to 0x0000…b16b/);
  assert.match((await sign(typed(), env({ code: `0xef0100${'11'.repeat(20)}` }).d)).warnings.find(w => w.code === 'gasless_exec_other_code')?.message ?? '', /Your account runs other code \(0x1111…1111\) now, not UniversalGaslessDelegate/);
  // A nonce already used can't run again (and whether its call would fail now is beside the point).
  const spent = await sign(typed(), env({ used: true, fails: 'ERC20: transfer amount exceeds balance' }).d);
  assert.ok(codes(spent).includes('gasless_exec_nonce_used') && !codes(spent).includes('gasless_exec_fails'), codes(spent).join());
  // A call that fails now: nothing moves now, and the signature stays good until its deadline.
  const failing = await sign(typed(), env({ fails: 'ERC20: transfer amount exceeds balance' }).d);
  assert.match(failing.warnings.find(w => w.code === 'gasless_exec_fails')?.message ?? '', /^The call would fail if the relayer submitted it now \(ERC20: transfer amount exceeds balance\): nothing would move now\. But the signature stays valid until 2026-11-23T07:52:43Z/);
  assert.ok(!codes(failing).includes('simulation_reverted'));
  // A batch: its calls in order from the account, netted.
  const batch = env();
  const q = await sign(typed({ mode: BATCH, calls: [{ target: USDC, value: '0', data: transfer(1_000_000n) }, { target: USDC, value: '0', data: transfer(2_000_000n) }] }), batch.d);
  assert.equal(q.title, 'Gasless calls as you: Send 1 USDC → Send 2 USDC');
  assert.deepEqual(batch.sims.find(s => s.length === 2)!.map(r => [r.from, r.to]), [[ACCOUNT, USDC], [ACCOUNT, USDC]]);
  assert.deepEqual(q.assetChanges.map(c => [c.direction, c.raw]), [['out', '3000000']]);
  assert.deepEqual([detail(q, 'Call 1'), detail(q, 'Call 2')], ['Send 1 USDC (0xa0b8…eb48)', 'Send 2 USDC (0xa0b8…eb48)']);
});
