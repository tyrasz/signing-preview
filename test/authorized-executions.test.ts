// Gasless executions signed for an EIP-7702 account running UniversalGaslessDelegate (src/typed-data/authorized-executions.ts),
// and the same executions read back from the chain (src/evm/smart-account.ts, batchCalls).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData, hashTypedData, parseAbi, recoverAddress, type Hex, toFunctionSelector } from 'viem';
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
  // The same bytes under a mode selector that isn't known are laid out as that mode's account has them: not guessed
  // at, and said to be unread. As a delegatecall they are still one.
  const other = `0x00000000000012345678${'00'.repeat(22)}` as Hex, otherDelegate = `0xff000000000012345678${'00'.repeat(22)}` as Hex;
  const execute = (mode: Hex, data: Hex) => encodeFunctionData({ abi: EXECUTE, functionName: 'execute', args: [mode, data] });
  assert.deepEqual([batchCalls(execute(other, executionData))!.calls.length, batchCalls(execute(other, executionData))!.unread, batchCalls(execute(other, executionData))!.delegatecall], [0, true, false]);
  assert.deepEqual([batchCalls(execute(otherDelegate, executionData))!.unread, batchCalls(execute(otherDelegate, executionData))!.delegatecall], [true, true]);
  assert.deepEqual([batchCalls(execute(`0xff000000000078210001${'00'.repeat(22)}` as Hex, executionData))!.unread, batchCalls(execute(`0xff000000000078210001${'00'.repeat(22)}` as Hex, executionData))!.delegatecall], [true, true]);
  // A packed call under any selector is the packed call: accounts that read only the mode's call type run it so.
  // (Refused with the rest, a transfer under such a mode became a plain call to the account, and a delegatecall
  // lost its warning.)
  const packedCall = `${USDC}${'00'.repeat(32)}${transfer(1n).slice(2)}` as Hex, packedDelegate = `${USDC}${transfer(1n).slice(2)}` as Hex;
  for (const m of [other, SINGLE]) assert.deepEqual(batchCalls(execute(m, packedCall))!.calls.map(c => [c.target, c.value, c.data]), [[USDC, 0n, transfer(1n)]]);
  assert.deepEqual([batchCalls(execute(otherDelegate, packedDelegate))!.delegatecall, batchCalls(execute(otherDelegate, packedDelegate))!.calls[0].target], [true, USDC]);
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
  assert.match(p.summary, /^A signed gasless execution \(UniversalGaslessDelegate\): the relayer 0xfa17…d27f may make this call as your account 0x034c…b026, all or nothing\. Transfers 5,500 USDC to 0xc51e…cB08\.$/);
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
  // Each call with who it sends to: with its title and target alone, a batch named the token's contract and no
  // recipient anywhere.
  assert.deepEqual([detail(q, 'Call 1: Recipient')?.toLowerCase(), detail(q, 'Call 2: Amount')], [RECIPIENT, '2 USDC']);
  assert.match(q.summary, /all or nothing\. .*\(1\) Transfers 1 USDC to 0x/);
  // The delegate's kill switch: paused, it refuses every execution.
  const paused = env();
  const inner = paused.d.rpc!.call;
  paused.d.rpc!.call = async (c: number, m: string, params: unknown[]) => (m === 'eth_call' && (params[0] as { data: string }).data === '0xb187bd26' ? `0x${'0'.repeat(63)}1` : inner(c, m, params));
  assert.match((await sign(typed(), paused.d)).warnings.find(w => w.code === 'gasless_exec_paused')?.message ?? '', /paused now \(its kill switch\): it refuses every execution/);
  // A call to the account itself: the delegate refuses any but invalidateNonce (ReentrantCall), and run as the
  // account's own call it isn't refused, so the run shown isn't what a relayer's submission does.
  const self = await sign(typed({ calls: [{ target: ACCOUNT, value: '0', data: '0xe9ae5c53' + '00'.repeat(64) }] }), env().d);
  assert.match(self.warnings.find(w => w.code === 'gasless_exec_self_call')?.message ?? '', /^The call is to your account itself, which the account code refuses in an execution/);
  assert.equal(self.decoding.status, 'partial');
  const invalidate = await sign(typed({ calls: [{ target: ACCOUNT, value: '0', data: `0x${'f2a4e5f1'}${'00'.repeat(32)}` }] }), env().d);
  assert.equal(codes(invalidate).includes('gasless_exec_self_call'), toFunctionSelector('invalidateNonce(uint256)') !== '0xf2a4e5f1');
  assert.ok(!codes(await sign(typed({ calls: [{ target: ACCOUNT, value: '0', data: `${toFunctionSelector('invalidateNonce(uint256)')}${'00'.repeat(32)}` }] }), env().d)).includes('gasless_exec_self_call'));
});

test('A gasless execution that isn’t all read says so: more calls than are read, another domain, calls that can’t be decoded', async () => {
  // Thirty-three calls (the delegate has no cap): shown field by field, as typed data in no known format is, they
  // were cut at the twentieth call under "All fields are shown as signed", with no relayer and no deadline.
  const many = Array.from({ length: 33 }, (_, i) => ({ target: USDC, value: '0', data: transfer(BigInt(i + 1)) }));
  const p = await sign(typed({ mode: BATCH, calls: many }));
  assert.deepEqual([p.decoding.decoder, p.decoding.status, p.attention], ['authorized_executions', 'opaque', 'danger']);
  assert.match(p.warnings.find(w => w.code === 'gasless_exec_too_many')?.message ?? '', /^It lists 33 calls, more than the 32 that are read here: none is decoded or simulated, and 1 aren't shown at all/);
  assert.deepEqual([detail(p, 'Relayer'), detail(p, 'Valid until'), detail(p, 'More calls'), detail(p, 'Call 32')], [RELAYER, '2026-11-23T07:52:43Z', '1', `0xa9059cbb on ${USDC}`]);
  assert.deepEqual(p.assetChanges, []);
  // A domain with a name and a version too: the delegate's digest is under the chain and the account code alone.
  const named = typed({}, { name: 'Anything', version: '9' });
  named.types.EIP712Domain = [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, ...named.types.EIP712Domain];
  const q = await sign(named);
  assert.match(q.warnings.find(w => w.code === 'gasless_exec_domain')?.message ?? '', /also has "name", "version": UniversalGaslessDelegate checks signatures under the chain and the account code alone/);
  assert.equal(q.decoding.status, 'partial');
  // Of code this wasn't read from, nothing is said to be refused by it.
  const elsewhere = await sign(typed({ mode: `0x${'00'.repeat(32)}` }, { verifyingContract: '0x00000000000000000000000000000000000000aa' }));
  assert.match(elsewhere.warnings.find(w => w.code === 'gasless_exec_mode')?.message ?? '', /isn't one UniversalGaslessDelegate, whose format this is, runs on a signature/);
  // With no signer named the calls can't be read for an account: they are shown as signed, calldata and all.
  const unsigned = await previewRequest({ method: 'eth_signTypedData_v4', params: [null, JSON.stringify(typed())] } as never, { now: NOW, chainId: 1 }, offline);
  assert.deepEqual([detail(unsigned, 'Call 1'), detail(unsigned, 'Call 1 calldata')], [`0xa9059cbb on ${USDC}`, transfer(5_500_000_000n)]);
});

test('Typed data in no known format with more fields than are shown says how many are signed unseen', async () => {
  const fields = Array.from({ length: 70 }, (_, i) => ({ name: `f${i}`, type: 'uint256' }));
  const data = { domain: { name: 'Some app', chainId: 1 }, types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }], Thing: fields }, primaryType: 'Thing', message: Object.fromEntries(fields.map((f, i) => [f.name, String(i)])) };
  const p = await previewRequest({ method: 'eth_signTypedData_v4', params: [ACCOUNT, JSON.stringify(data)] }, { now: NOW }, offline);
  const said = p.warnings.find(w => w.code === 'unknown_typed_data')?.message ?? '';
  assert.match(said, /Its first \d+ fields are shown as signed, and \d+ more are signed with them that aren't shown here/);
  assert.doesNotMatch(said, /All fields are shown/);
  const shown = Number(/first (\d+) fields/.exec(said)![1]), more = Number(detail(p, 'More fields'));
  assert.equal(shown + more, 70);
  // (All of a short one's are shown, and said to be.)
  const short = { ...data, types: { ...data.types, Thing: fields.slice(0, 3) }, message: { f0: '0', f1: '1', f2: '2' } };
  assert.match((await previewRequest({ method: 'eth_signTypedData_v4', params: [ACCOUNT, JSON.stringify(short)] }, { now: NOW }, offline)).warnings.find(w => w.code === 'unknown_typed_data')?.message ?? '', /All fields are shown as signed/);
});
