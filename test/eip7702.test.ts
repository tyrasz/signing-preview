// EIP-7702 authorization lists: 1.3% of Ethereum transactions in a day's sample were type-4. Before this, an
// authorization list in eth_sendTransaction was ignored, so handing the account to any contract previewed as
// "Send 0 ETH" with no warning.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionData, parseAbi, toHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { recoverAuthorizationAddress } from 'viem/utils';
import { previewRequest } from '../src/preview.ts';
import { StaticTokenRegistry } from '../src/chains.ts';
import type { AbiResolver, Dependencies, SimulationRequest, Simulator } from '../src/types.ts';
import { ALICE, BOB } from '../mocks/data.ts';
import { codes, detail, NOW } from './helpers.ts';

const DELEGATE = '0x63c0c19a282a1b52b07dd5a65b58948a07dae32b';
const ZERO = '0x0000000000000000000000000000000000000000';
const EXECUTE = parseAbi(['function execute((address target, uint256 value, bytes callData)[] calls)']);
const abis: AbiResolver = { resolve: async (_c, a) => a.toLowerCase() === DELEGATE ? { abi: EXECUTE, name: 'EIP7702StatelessDeleGator', source: 'sourcify', verified: true } : null };
const deps: Dependencies = { tokens: new StaticTokenRegistry() };
const send = (tx: Record<string, unknown>, d: Dependencies = deps) =>
  previewRequest({ method: 'eth_sendTransaction', params: [{ from: ALICE, chainId: '0x1', ...tx }] }, { now: NOW }, d);

test('An unsigned authorization asks the wallet to delegate your account: danger, with the delegate named', async () => {
  const p = await send({ to: ALICE, authorizationList: [{ address: DELEGATE, chainId: '0x1', nonce: '0x5' }] }, { ...deps, abis });
  assert.equal(p.title, 'Delegate your account to EIP7702StatelessDeleGator (EIP-7702)');
  assert.equal(p.attention, 'danger');
  assert.ok(codes(p).includes('eip7702_delegation'));
  assert.equal(detail(p, 'EIP-7702 delegation'), `your account → ${DELEGATE} (EIP7702StatelessDeleGator), on Ethereum`);
  // Unverified delegate, valid on every chain, alongside a real call: the call keeps its title.
  const transfer = encodeFunctionData({ abi: parseAbi(['function transfer(address,uint256)']), args: [BOB, 1_000_000n] });
  const q = await send({ to: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', data: transfer, authorizationList: [{ contractAddress: DELEGATE, chainId: 0, nonce: 0 }] });
  assert.equal(q.title, 'Send 1 USDC');
  assert.match(q.summary, /It also delegates your account to 0x63c0…e32b \(EIP-7702\)\.$/);
  assert.match(q.warnings.find(w => w.code === 'eip7702_delegation')!.message, /on every EVM chain/);
});

test('A call to your own account in the transaction that delegates it is decoded against the new delegate', async () => {
  const data = encodeFunctionData({ abi: EXECUTE, args: [[{ target: BOB, value: 0n, callData: '0x' }]] });
  const p = await send({ to: ALICE, data, authorizationList: [{ address: DELEGATE, chainId: '0x1', nonce: '0x5' }] }, { ...deps, abis });
  assert.equal(p.title, 'Call execute on your account (EIP7702StatelessDeleGator)');
  assert.equal(p.decoding.status, 'full');
  assert.match(detail(p, 'ABI source')!, /the code your account delegates to in this transaction/);
  assert.ok(codes(p).includes('eip7702_delegation'));
  // Without the delegation, the account has no code to decode against.
  const plain = await send({ to: ALICE, data }, { ...deps, abis });
  assert.notEqual(plain.decoding.status, 'full');
});

test('Signed authorizations: yours is danger, another account’s is information; revocations and other chains are noted', async () => {
  const me = privateKeyToAccount('0x3333333333333333333333333333333333333333333333333333333333333333');
  const other = privateKeyToAccount('0x4444444444444444444444444444444444444444444444444444444444444444');
  const sign = async (who: typeof me, address: string, chainId = 1) => {
    const a = await who.signAuthorization({ address: address as Hex, chainId, nonce: 7 });
    return { address: a.address, chainId: toHex(a.chainId), nonce: toHex(a.nonce), r: a.r, s: a.s, yParity: toHex(a.yParity!) };
  };
  const mine = await previewRequest({ method: 'eth_sendTransaction', params: [{ from: me.address, to: me.address, chainId: '0x1', authorizationList: [await sign(me, DELEGATE)] }] }, { now: NOW }, deps);
  assert.ok(codes(mine).includes('eip7702_delegation'));
  assert.equal(mine.attention, 'danger');

  const sponsored = await send({ to: other.address, authorizationList: [await sign(other, DELEGATE)] });
  assert.ok(codes(sponsored).includes('eip7702_sponsored'));
  assert.ok(!codes(sponsored).includes('eip7702_delegation'));
  assert.match(detail(sponsored, 'EIP-7702 delegation')!, new RegExp(`^${other.address.toLowerCase()} → ${DELEGATE}`));

  const revoke = await previewRequest({ method: 'eth_sendTransaction', params: [{ from: me.address, to: me.address, chainId: '0x1', authorizationList: [await sign(me, ZERO)] }] }, { now: NOW }, deps);
  assert.deepEqual(codes(revoke), ['eip7702_revoke']);
  assert.equal(revoke.title, "Remove your account's EIP-7702 delegation");

  const elsewhere = await send({ to: ALICE, authorizationList: [{ address: DELEGATE, chainId: '0x2105', nonce: '0x0' }] });
  assert.ok(codes(elsewhere).includes('eip7702_other_chain'));
  assert.ok(codes(elsewhere).includes('eip7702_delegation'));
});

test('A transaction with an authorization list is simulated with the delegation applied; malformed lists are rejected', async () => {
  const requests: SimulationRequest[] = [];
  const simulator: Simulator = { simulate: async r => { requests.push(r); return { status: 'success', source: 'test', transfers: [] }; } };
  const p = await send({ to: ALICE, authorizationList: [{ address: DELEGATE, chainId: '0x1', nonce: '0x0' }] }, { ...deps, simulator });
  assert.equal(p.simulation?.status, 'success');
  assert.deepEqual(requests[0].stateOverrides, { [ALICE]: { code: `0xef0100${DELEGATE.slice(2)}` } });
  assert.deepEqual(requests[0].unsignedAuthorizations, [{ address: DELEGATE, chainId: 1 }]);
  assert.ok(p.decoding.notes.some(n => /EIP-7702 authorizations applied/.test(n)));
  // A revocation simulates the account without code; HyperEVM (Cancun rules) doesn't apply EIP-7702 at all.
  await send({ to: ALICE, authorizationList: [{ address: '0x0000000000000000000000000000000000000000', chainId: '0x1', nonce: '0x0' }] }, { ...deps, simulator });
  assert.deepEqual(requests[1].stateOverrides, { [ALICE]: { code: '0x' } });
  const hyper = await send({ to: ALICE, chainId: '0x3e7', authorizationList: [{ address: DELEGATE, chainId: '0x3e7', nonce: '0x0' }] }, { ...deps, simulator });
  assert.ok(codes(hyper).includes('simulation_skipped'));
  // An empty list changes nothing.
  assert.equal((await send({ to: BOB, value: '0x1', authorizationList: [] })).title, 'Send 0.000000000000000001 ETH');
  await assert.rejects(send({ to: ALICE, authorizationList: { address: DELEGATE } }), /"authorizationList" must be an array/);
  await assert.rejects(send({ to: ALICE, authorizationList: [{ address: '0x1234' }] }), /authorizationList\[0\]\.address must be an address/);
  await assert.rejects(send({ to: ALICE, authorizationList: [{ address: DELEGATE, chainId: 1, nonce: 0, r: '0x01', s: '0x02' }] }), /is signed but has no yParity/);
});

test('For the gas of an unsigned authorization, eth_simulateV1 gets one signed by a stand-in account set up the same way', async () => {
  let sent: { params: [{ blockStateCalls: { calls: { authorizationList?: { address: string; chainId: string; nonce: string; r: Hex; s: Hex; yParity: string }[] }[]; stateOverrides?: Record<string, Record<string, string>> }[] }] } | undefined;
  const fetchImpl = (async (_u: string, init: RequestInit) => {
    sent ??= JSON.parse(String(init.body));
    return new Response(JSON.stringify({ result: [{ calls: [{ status: '0x1', gasUsed: '0x8fd0', returnData: '0x', logs: [] }] }] }));
  }) as typeof fetch;
  const { RpcSimulator } = await import('../src/simulation.ts');
  const p = await send({ to: ALICE, authorizationList: [{ address: DELEGATE, chainId: '0x1', nonce: '0x1' }, { address: DELEGATE, chainId: '0x2105' }] }, { ...deps, simulator: new RpcSimulator({ 1: 'http://rpc.invalid' }, { fetchImpl }) });
  // The node's gas is the answer: it charged and refunded the stand-ins as the chain will the wallet's own.
  assert.equal(p.simulation?.gasUsed, '36816');
  const block = sent!.params[0].blockStateCalls[0];
  const [mine, elsewhere] = block.calls[0].authorizationList!;
  const standIn = (await recoverAuthorizationAddress({ authorization: { address: mine.address as Hex, chainId: Number(mine.chainId), nonce: Number(mine.nonce) }, signature: { r: mine.r, s: mine.s, yParity: Number(mine.yParity) } })).toLowerCase();
  assert.notEqual(standIn, ALICE.toLowerCase());
  assert.deepEqual([mine.chainId, mine.nonce, elsewhere.chainId], ['0x1', '0x0', '0x2105'], 'one applies here, one is for Base');
  assert.deepEqual(block.stateOverrides?.[standIn], { balance: '0x1', nonce: '0x0', code: '0x' });
  assert.equal(block.stateOverrides?.[ALICE.toLowerCase()]?.code, `0xef0100${DELEGATE.slice(2)}`);
});

test('Signed authorizations go to eth_simulateV1 as they are, and their authorities get no code override', async () => {
  const me = privateKeyToAccount('0x7777777777777777777777777777777777777777777777777777777777777777');
  const a = await me.signAuthorization({ address: DELEGATE as Hex, chainId: 1, nonce: 3 });
  let sent: { params: [{ blockStateCalls: { calls: { authorizationList?: unknown[] }[]; stateOverrides?: Record<string, unknown> }[] }] } | undefined;
  const fetchImpl = (async (_u: string, init: RequestInit) => {
    sent ??= JSON.parse(String(init.body));
    return new Response(JSON.stringify({ result: [{ calls: [{ status: '0x1', gasUsed: '0x5208', returnData: '0x', logs: [] }] }] }));
  }) as typeof fetch;
  const { RpcSimulator } = await import('../src/simulation.ts');
  const p = await previewRequest({ method: 'eth_sendTransaction', params: [{ from: me.address, to: me.address, chainId: '0x1', authorizationList: [{ address: a.address, chainId: toHex(a.chainId), nonce: toHex(a.nonce), r: a.r, s: a.s, yParity: toHex(a.yParity!) }] }] },
    { now: NOW }, { ...deps, simulator: new RpcSimulator({ 1: 'http://rpc.invalid' }, { fetchImpl }) });
  assert.equal(p.simulation?.status, 'success');
  const block = sent!.params[0].blockStateCalls[0];
  assert.equal(block.calls[0].authorizationList?.length, 1);
  assert.equal(block.stateOverrides?.[me.address.toLowerCase()], undefined, 'the node applies it; no override');
  // Its numbers go to the node without leading zeros, however the wallet wrote them: go-ethereum's nodes refuse
  // "0x00ab…", which is how a signature's r and s are usually padded.
  sent = undefined;
  const padded = { address: DELEGATE, chainId: '0x01', nonce: '0x03', r: `0x00${'ab'.repeat(31)}`, s: `0x0${'1'.repeat(63)}`, yParity: '0x00' };
  await new RpcSimulator({ 1: 'http://rpc.invalid' }, { fetchImpl }).simulate({ chainId: 1, from: me.address.toLowerCase(), to: me.address, data: '0x', value: 0n, authorizationList: [padded] });
  assert.deepEqual(sent!.params[0].blockStateCalls[0].calls[0].authorizationList, [{ address: DELEGATE, chainId: '0x1', nonce: '0x3', r: `0x${'ab'.repeat(31)}`, s: `0x${'1'.repeat(63)}`, yParity: '0x0' }]);
  // Only the stand-in code is left out: a balance the caller sets for the authority still reaches the node.
  sent = undefined;
  await previewRequest({ method: 'eth_sendTransaction', params: [{ from: me.address, to: me.address, chainId: '0x1', authorizationList: [{ address: a.address, chainId: toHex(a.chainId), nonce: toHex(a.nonce), r: a.r, s: a.s, yParity: toHex(a.yParity!) }] }] },
    { now: NOW, stateOverrides: { [me.address]: { balance: '0x5' } } }, { ...deps, simulator: new RpcSimulator({ 1: 'http://rpc.invalid' }, { fetchImpl }) });
  assert.deepEqual(sent!.params[0].blockStateCalls[0].stateOverrides?.[me.address.toLowerCase()], { balance: '0x5' });
});

test('A priced EIP-7702 call goes to the node with a fee cap and tip, which reth-based nodes charge (a gasPrice they leave out)', async () => {
  // As Ethereum's, Base's, OP Mainnet's, BNB Chain's and Sepolia's public nodes do (2026-11-15): a call with an
  // authorization list is built as a type-4 transaction, which has no gasPrice, so one priced with gasPrice alone ran
  // at no price. The sender's balance read after it then showed the fee it should have paid as coin received.
  const me = privateKeyToAccount('0x7777777777777777777777777777777777777777777777777777777777777777');
  const a = await me.signAuthorization({ address: DELEGATE as Hex, chainId: 1, nonce: 3 });
  const auth = { address: a.address, chainId: toHex(a.chainId), nonce: toHex(a.nonce), r: a.r, s: a.s, yParity: toHex(a.yParity!) };
  type Call = { from: string; to?: string; data: string; gasPrice?: string; maxFeePerGas?: string; maxPriorityFeePerGas?: string; authorizationList?: unknown[] };
  const priced: Call[] = [];
  const fetchImpl = (async (_u: string, init: RequestInit) => {
    const { params } = JSON.parse(String(init.body)) as { params: [{ blockStateCalls: { calls: Call[] }[] }] };
    let balance = 10n ** 18n;
    const calls = params[0].blockStateCalls[0].calls.map(c => {
      // Multicall3's getEthBalance: the sender's balance as it stands.
      if (c.data.startsWith('0x4d2301cc')) return { status: '0x1', gasUsed: '0x0', returnData: toHex(balance, { size: 32 }), logs: [] };
      if (c.from.toLowerCase() !== me.address.toLowerCase()) return { status: '0x1', gasUsed: '0x0', returnData: toHex(0n, { size: 32 }), logs: [] };
      priced.push(c);
      const price = c.authorizationList?.length && c.maxFeePerGas === undefined ? 0n : BigInt(c.gasPrice ?? c.maxFeePerGas ?? '0x0');
      balance -= 46_000n * price;
      return { status: '0x1', gasUsed: toHex(46_000n), returnData: '0x', logs: [] };
    });
    return new Response(JSON.stringify({ result: [{ calls }] }));
  }) as typeof fetch;
  const { RpcSimulator } = await import('../src/simulation.ts');
  const res = await new RpcSimulator({ 1: 'http://rpc.invalid' }, { fetchImpl }).simulate({ chainId: 1, from: me.address.toLowerCase(), to: me.address, data: '0x', value: 0n, gas: 100_000n, gasPrice: 3n * 10n ** 9n, authorizationList: [auth] });
  assert.equal(res?.balancesRead, true);
  assert.deepEqual(res?.transfers.filter(t => t.asset === 'native'), [], 'the gas paid is no coin moved');
  for (const c of priced) assert.deepEqual([c.gasPrice, c.maxFeePerGas, c.maxPriorityFeePerGas], [undefined, '0xb2d05e00', '0xb2d05e00']);
  assert.equal(priced.length, 2, 'the run, and the run with the reads around it');
});
