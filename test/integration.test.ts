import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createPreviewServer } from '../src/server.ts';
import { remotePreview, withSigningPreview, UserRejectedError, type Eip1193Provider } from '../src/interceptor.ts';
import { ALICE, buildSamples } from '../mocks/data.ts';
import { mockDeps } from './helpers.ts';

async function withServer(fn: (url: string) => Promise<void>) {
  const server = createPreviewServer({ deps: mockDeps(), samples: () => buildSamples() });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); } finally { server.close(); }
}

test('HTTP API previews requests, allows any origin and rejects bad input', async () => {
  await withServer(async url => {
    const s = buildSamples().find(x => x.id === 'hl-withdraw')!;
    const res = await fetch(`${url}/v1/preview`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'chrome-extension://abc' }, body: JSON.stringify({ request: s.request, context: { account: ALICE } }) });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.equal((await res.json()).title, 'Withdraw 50 USDC to Arbitrum');

    const bad = await fetch(`${url}/v1/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request: { method: 'eth_sendTransaction', params: [{}] } }) });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error.code, 'INVALID_REQUEST');

    const big = await fetch(`${url}/v1/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(300 * 1024) }).catch(() => null);
    assert.ok(big === null || big.status === 413);

    const preflight = await fetch(`${url}/v1/preview`, { method: 'OPTIONS' });
    assert.equal(preflight.status, 204);
  });
});

test('The demo page is told whether its previews use mock or live data', async () => {
  for (const demoData of [undefined, 'live'] as const) {
    const server = createPreviewServer({ deps: mockDeps(), serveDemo: true, demoData });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/demo/config.json`);
      assert.deepEqual(await res.json(), { data: demoData ?? 'mock' });
    } finally { server.close(); }
  }
  // Without the demo, there is no config either.
  await withServer(async url => assert.equal((await fetch(`${url}/demo/config.json`)).status, 404));
});

test('Interceptor previews signing requests, forwards approvals, rejects with 4001, passes others through', async () => {
  await withServer(async url => {
    const calls: string[] = [];
    const wallet: Eip1193Provider = {
      isMockWallet: true,
      async request({ method }) {
        calls.push(method);
        if (method === 'eth_chainId') return '0xa4b1';
        if (method === 'eth_accounts') return [ALICE];
        if (method === 'eth_blockNumber') return '0x10';
        return '0xsigned';
      },
    };
    const seen: string[] = [];
    let answer = true;
    const provider = withSigningPreview(wallet, { preview: remotePreview(`${url}/v1/preview`), confirm: async p => { seen.push(p.title); return answer; }, origin: 'https://dapp.example' });
    const deposit = buildSamples().find(x => x.id === 'bridge2-deposit')!.request;

    assert.equal(await provider.request(deposit as never), '0xsigned');
    assert.deepEqual(seen, ['Deposit 100 USDC to Hyperliquid']);
    assert.ok(calls.includes('eth_sendTransaction'));

    answer = false;
    calls.length = 0;
    await assert.rejects(provider.request(deposit as never), (e: unknown) => e instanceof UserRejectedError && e.code === 4001);
    assert.ok(!calls.includes('eth_sendTransaction'));

    assert.equal(await provider.request({ method: 'eth_blockNumber' }), '0x10');
    assert.equal(seen.length, 2);
    assert.equal(provider.isMockWallet, true);
  });
});

test('Interceptor shows an explicit fallback when the preview service fails', async () => {
  const wallet: Eip1193Provider = { async request() { return '0x1'; } };
  let shown;
  const provider = withSigningPreview(wallet, { preview: async () => { throw new Error('offline'); }, confirm: async p => { shown = p; return false; } });
  await assert.rejects(provider.request({ method: 'personal_sign', params: ['0x68656c6c6f', ALICE] }));
  assert.equal((shown as unknown as { warnings: { code: string }[] }).warnings[0].code, 'preview_unavailable');
});

test('HTTP API: a UserOperation supplied in the context decodes the hash being signed', async () => {
  const { userOpHash, readOperation } = await import('../src/userop-hash.ts');
  const ep = '0x0000000071727de22e5e9d8baf0edac6f37da032';
  const transfer = `0xb61d27f6${'0'.repeat(24)}a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48${'0'.repeat(64)}${'0'.repeat(62)}60${'0'.repeat(62)}44a9059cbb${'0'.repeat(24)}b0b0000000000000000000000000000000000002${(1_000_000).toString(16).padStart(64, '0')}${'0'.repeat(56)}`;
  const operation = { sender: '0x5ca1ab1e00000000000000000000000000000007', nonce: '0x1', callData: transfer, callGasLimit: '0x10000', verificationGasLimit: '0x10000', preVerificationGas: '0x5000', maxFeePerGas: '0x3b9aca00', maxPriorityFeePerGas: '0x1' };
  const hash = userOpHash(readOperation(operation, '0.7')!, ep, 1, '0.7');
  await withServer(async url => {
    const post = (context: unknown) => fetch(`${url}/v1/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request: { method: 'personal_sign', params: [hash, ALICE] }, context }) }).then(r => r.json());
    const p = await post({ chainId: 1, userOperation: { entryPoint: ep, operation } });
    assert.equal(p.title, 'Sign a UserOperation: Send 1 USDC');
    assert.equal(p.decoding.decoder, 'erc4337_user_operation_hash');
    assert.equal((await post({ chainId: 1, userOperation: { entryPoint: ep, operation: { ...operation, nonce: '0x2' } } })).attention, 'danger');
  });
});

test('HTTP API: the Safe operations behind a multi-chain root, supplied in the context, are checked against it', async () => {
  const { hashTypedData } = await import('viem');
  const MC = '0x22939e839e3c0f479b713eaf95e0df128554aead';
  const operation = { safe: '0x5ca1ab1e00000000000000000000000000000007', nonce: '1', initCode: '0x', callData: '0x', verificationGasLimit: '100000', callGasLimit: '100000', preVerificationGas: '50000', maxPriorityFeePerGas: '1', maxFeePerGas: '2', paymasterAndData: '0x', validAfter: '0', validUntil: '0', entryPoint: '0x433709009b8330fda32311df1c2afa402ed8d009' };
  const types = { SafeOp: [{ type: 'address', name: 'safe' }, { type: 'uint256', name: 'nonce' }, { type: 'bytes', name: 'initCode' }, { type: 'bytes', name: 'callData' }, { type: 'uint128', name: 'verificationGasLimit' }, { type: 'uint128', name: 'callGasLimit' }, { type: 'uint256', name: 'preVerificationGas' }, { type: 'uint128', name: 'maxPriorityFeePerGas' }, { type: 'uint128', name: 'maxFeePerGas' }, { type: 'bytes', name: 'paymasterAndData' }, { type: 'uint48', name: 'validAfter' }, { type: 'uint48', name: 'validUntil' }, { type: 'address', name: 'entryPoint' }] };
  // A tree of one operation: its root is the operation's digest on its chain.
  const root = hashTypedData({ domain: { chainId: 42161, verifyingContract: MC }, types, primaryType: 'SafeOp', message: operation as never });
  const request = { method: 'eth_signTypedData_v4', params: [ALICE, JSON.stringify({ domain: { verifyingContract: MC }, types: { EIP712Domain: [{ name: 'verifyingContract', type: 'address' }], MerkleTreeRoot: [{ name: 'merkleTreeRoot', type: 'bytes32' }] }, primaryType: 'MerkleTreeRoot', message: { merkleTreeRoot: root } })] };
  await withServer(async url => {
    const post = (context: unknown) => fetch(`${url}/v1/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request, context }) }).then(r => r.json());
    const codes = (p: { warnings: { code: string }[] }) => p.warnings.map(w => w.code);
    assert.ok(codes(await post({ safeOperations: [{ chainId: 42161, operation }] })).includes('safe_multichain_root_verified'));
    assert.ok(codes(await post({ safeOperations: [{ chainId: 1, operation }] })).includes('safe_multichain_root_mismatch'));
    assert.ok(codes(await post({})).includes('safe_multichain_root'));
  });
});
