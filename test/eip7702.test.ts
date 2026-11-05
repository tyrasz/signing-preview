// EIP-7702 authorization lists: 1.3% of Ethereum transactions in a day's sample were type-4. Before this, an
// authorization list in eth_sendTransaction was ignored, so handing the account to any contract previewed as
// "Send 0 ETH" with no warning.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionData, parseAbi, toHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { previewRequest } from '../src/preview.ts';
import { StaticTokenRegistry } from '../src/chains.ts';
import type { AbiResolver, Dependencies, SimulationRequest, Simulator } from '../src/types.ts';
import { ALICE, BOB } from '../mocks/data.ts';
import { codes, detail, NOW } from './helpers.ts';

const DELEGATE = '0x63c0c19a282a1b52b07dd5a65b58948a07dae32b';
const ZERO = '0x0000000000000000000000000000000000000000';
const abis: AbiResolver = { resolve: async (_c, a) => a.toLowerCase() === DELEGATE ? { abi: [], name: 'EIP7702StatelessDeleGator', source: 'test', verified: true } : null };
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
