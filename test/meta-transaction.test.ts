// Signed meta-transactions (src/typed-data/meta-transaction.ts): OpenZeppelin's forwarders, Polygon's
// NativeMetaTransaction and Gelato's ERC-2771 relays. The inner call is the account's own, simulated as the
// forwarder makes it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashStruct, toFunctionSelector } from 'viem';
import { previewRequest } from '../src/preview.ts';
import { StaticTokenRegistry } from '../src/chains.ts';
import type { Dependencies, SimulationRequest } from '../src/types.ts';
import { ALICE, BOB } from '../mocks/data.ts';
import { codes, detail, NOW } from './helpers.ts';

const EVIL = '0xba5ed0000000000000000000000000000000beef';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const USDC_E = '0x2791bca1f2de4661ed88a30c99a7a9449aa84174';
const FORWARDER = '0xdd870cb1db09d566b1063f6ef68d0036aa187f91';
const GELATO_1BALANCE = '0xd8253782c45a12053594b9deb72d8e8ab2fca54c';
const GELATO_CONCURRENT = '0xc65d82ece367ef06bf2ab791b3f3cf037dc0e816';
const word = (v: string | bigint) => (typeof v === 'bigint' ? v.toString(16) : v.slice(2)).toLowerCase().padStart(64, '0');
const approve = `0x095ea7b3${word(EVIL)}${'f'.repeat(64)}`;
const transfer = (to: string, amount: bigint) => `0xa9059cbb${word(to)}${word(amount)}`;
const D712 = [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }];
const NOW_S = BigInt(NOW / 1000);

const forward = (m: Record<string, unknown> = {}, oz4 = false) => ({
  types: { EIP712Domain: D712, ForwardRequest: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'gas', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, ...(oz4 ? [] : [{ name: 'deadline', type: 'uint48' }]), { name: 'data', type: 'bytes' }] },
  primaryType: 'ForwardRequest', domain: { name: oz4 ? 'MinimalForwarder' : 'Forwarder', version: oz4 ? '0.0.1' : '1', chainId: 1, verifyingContract: FORWARDER },
  message: { from: ALICE, to: USDC, value: '0', gas: '100000', nonce: '3', ...(oz4 ? {} : { deadline: String(NOW_S + 3600n) }), data: approve, ...m },
});
const polygon = (m: Record<string, unknown> = {}) => ({
  types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'verifyingContract', type: 'address' }, { name: 'salt', type: 'bytes32' }], MetaTransaction: [{ name: 'nonce', type: 'uint256' }, { name: 'from', type: 'address' }, { name: 'functionSignature', type: 'bytes' }] },
  primaryType: 'MetaTransaction', domain: { name: 'USD Coin (PoS)', version: '1', verifyingContract: USDC_E, salt: `0x${word(137n)}` },
  message: { nonce: '0', from: ALICE, functionSignature: approve, ...m },
});
const gelato = (primaryType: string, relay: string, m: Record<string, unknown> = {}) => {
  const concurrent = primaryType.includes('Concurrent');
  return {
    types: { EIP712Domain: D712, [primaryType]: [{ name: 'chainId', type: 'uint256' }, { name: 'target', type: 'address' }, { name: 'data', type: 'bytes' }, { name: 'user', type: 'address' }, concurrent ? { name: 'userSalt', type: 'bytes32' } : { name: 'userNonce', type: 'uint256' }, { name: 'userDeadline', type: 'uint256' }] },
    primaryType, domain: { name: 'GelatoRelay', version: '1', chainId: 137, verifyingContract: relay },
    message: { chainId: '137', target: USDC_E, data: transfer(BOB, 5_000_000n), user: ALICE, ...(concurrent ? { userSalt: `0x${'ab'.repeat(32)}` } : { userNonce: '0' }), userDeadline: '0', ...m },
  };
};
const sign = (data: unknown, deps: Dependencies = { tokens: new StaticTokenRegistry() }, signer = ALICE) =>
  previewRequest({ method: 'eth_signTypedData_v4', params: [signer, JSON.stringify(data)] }, { now: NOW, chainId: 1 }, deps);

/** An RPC answering view calls by their 4-byte selector (and an optional exact calldata), every chain readable. */
const rpcOf = (answers: Record<string, string>) => ({
  has: () => true,
  call: async (_c: number, method: string, params: unknown[]) => {
    if (method !== 'eth_call') return method === 'eth_getCode' ? '0x' : '0x0';
    const data = String((params[0] as { data: string }).data);
    return answers[data] ?? answers[data.slice(0, 10)] ?? '0x';
  },
});

test('A forward request is previewed as the call it makes as you, with its warnings', async () => {
  const p = await sign(forward());
  assert.equal(p.decoding.decoder, 'meta_tx_oz5');
  assert.match(p.title, /^Gasless call as you: Allow 0xba5E…beef to spend unlimited USDC/);
  assert.ok(codes(p).includes('unlimited_approval'));
  assert.equal(detail(p, 'Forwarder'), FORWARDER);
  assert.equal(detail(p, 'Calls'), USDC);
  // The transaction-only checks (fee, nonce, funds for gas) aren't the signer's: they don't appear.
  assert.ok(!p.details.some(d => /^Network fee/.test(d.label)));
  // OpenZeppelin 4's MinimalForwarder, without a deadline.
  const oz4 = await sign(forward({}, true));
  assert.equal(oz4.decoding.decoder, 'meta_tx_oz4');
  assert.equal(detail(oz4, 'Valid until'), undefined);
});

test("Polygon's MetaTransaction calls the token itself, on the chain its salt names", async () => {
  const p = await sign(polygon());
  assert.equal(p.decoding.decoder, 'meta_tx_polygon');
  assert.equal(p.network?.kind === 'evm' && p.network.chainId, 137);
  assert.equal(detail(p, 'Contract'), USDC_E);
  assert.match(p.title, /Allow 0xba5E…beef to spend unlimited/);
});

test('Simulated as the forwarder makes it: from the forwarder, your address appended, your balances reported', async () => {
  const seen: SimulationRequest[] = [];
  const deps: Dependencies = { tokens: new StaticTokenRegistry(), simulator: { simulate: async r => { seen.push(r); return { status: 'success', source: 'mock', gasUsed: 50_000n, transfers: [{ asset: USDC, from: ALICE, to: EVIL, raw: 7_000_000n }] }; } } };
  const p = await sign(forward({ data: transfer(EVIL, 7_000_000n), value: '1000' }), deps);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].from, FORWARDER);
  assert.equal(seen[0].account, ALICE);
  assert.equal(seen[0].to, USDC);
  assert.equal(seen[0].data, `${transfer(EVIL, 7_000_000n)}${ALICE.slice(2)}`);
  // The value is the relayer's, sent by the forwarder (given it for the run).
  assert.equal(seen[0].value, 1000n);
  assert.equal(seen[0].stateOverrides?.[FORWARDER]?.balance, '0x3e8');
  assert.deepEqual(p.assetChanges.map(c => [c.direction, c.amount, c.symbol]), [['out', '7', 'USDC']]);
  assert.match(detail(p, 'Value sent with the call') ?? '', /from whoever submits it/);
  // Polygon's token runs it from itself.
  seen.length = 0;
  await sign(polygon(), deps);
  assert.equal(seen[0].from, USDC_E);
  assert.equal(seen[0].to, USDC_E);
  assert.equal(seen[0].data, `${approve}${ALICE.slice(2)}`);
});

test("A call that would fail now is a caution that nothing moves, not the transaction's danger", async () => {
  const deps: Dependencies = { tokens: new StaticTokenRegistry(), simulator: { simulate: async () => ({ status: 'reverted', source: 'mock', gasUsed: 30_000n, revertReason: 'ERC20: transfer amount exceeds balance', transfers: [] }) } };
  const p = await sign(forward({ data: transfer(EVIL, 7_000_000n) }), deps);
  assert.ok(codes(p).includes('meta_tx_fails'));
  assert.ok(!codes(p).includes('simulation_reverted'));
  assert.deepEqual(p.assetChanges, []);
});

test('The chain is read: a used or later nonce, a target that does not trust the forwarder, an expired deadline, another account', async () => {
  const nonce = (n: bigint) => `0x${word(n)}`;
  const used = await sign(forward(), { tokens: new StaticTokenRegistry(), rpc: rpcOf({ '0x7ecebe00': nonce(5n), '0x572b6c05': nonce(1n) }) });
  assert.ok(codes(used).includes('meta_tx_nonce_used'));
  assert.ok(!codes(used).includes('meta_tx_untrusted'));
  const ahead = await sign(forward(), { tokens: new StaticTokenRegistry(), rpc: rpcOf({ '0x7ecebe00': nonce(1n), '0x572b6c05': nonce(1n) }) });
  assert.ok(codes(ahead).includes('meta_tx_nonce_ahead'));
  const untrusted = await sign(forward(), { tokens: new StaticTokenRegistry(), rpc: rpcOf({ '0x7ecebe00': nonce(3n), '0x572b6c05': nonce(0n) }) });
  assert.ok(codes(untrusted).includes('meta_tx_untrusted'));
  assert.match(untrusted.warnings.find(w => w.code === 'meta_tx_untrusted')!.message, /refuses/);
  // MinimalForwarder (getNonce) makes the call anyway: as itself.
  const oz4 = await sign(forward({}, true), { tokens: new StaticTokenRegistry(), rpc: rpcOf({ '0x2d0335ab': nonce(3n), '0x572b6c05': nonce(0n) }) });
  assert.match(oz4.warnings.find(w => w.code === 'meta_tx_untrusted')!.message, /runs as the forwarder/);
  assert.ok(codes(await sign(forward({ deadline: String(NOW_S - 60n) }))).includes('meta_tx_expired'));
  assert.ok(codes(await sign(forward(), { tokens: new StaticTokenRegistry() }, BOB)).includes('meta_tx_other_account'));
});

test("Gelato's relays: sponsored calls simulated, sync-fee calls not, the concurrent ones' used hashes read, an unknown relay cautioned", async () => {
  const seen: SimulationRequest[] = [];
  const deps: Dependencies = { tokens: new StaticTokenRegistry(), simulator: { simulate: async r => { seen.push(r); return { status: 'success', source: 'mock', gasUsed: 50_000n, transfers: [] }; } } };
  const sponsored = await sign(gelato('SponsoredCallERC2771', GELATO_1BALANCE), deps);
  assert.equal(sponsored.decoding.decoder, 'meta_tx_gelato_sponsored');
  assert.match(detail(sponsored, 'Relay') ?? '', /GelatoRelay1BalanceERC2771/);
  assert.equal(seen[0].from, GELATO_1BALANCE);
  assert.equal(seen[0].data, `${transfer(BOB, 5_000_000n)}${ALICE.slice(2)}`);
  assert.equal(detail(sponsored, 'Valid until'), 'no expiry');
  seen.length = 0;
  const fee = await sign(gelato('CallWithSyncFeeERC2771', '0xb539068872230f20456cf38ec52ef2f91af4ae49'), deps);
  assert.equal(seen.length, 0);
  assert.equal(fee.decoding.decoder, 'meta_tx_gelato_sync_fee');
  // A relay that isn't Gelato's.
  assert.ok(codes(await sign(gelato('SponsoredCallERC2771', EVIL))).includes('meta_tx_unknown_relay'));
  // The concurrent relay marks the call's struct hash used.
  const data = gelato('SponsoredCallConcurrentERC2771', GELATO_CONCURRENT);
  const hash = hashStruct({ data: { ...data.message, chainId: 137n, userDeadline: 0n } as never, primaryType: data.primaryType as never, types: data.types as never });
  const usedHash = { '0x572b6c05': `0x${word(1n)}`, [`${toFunctionSelector('hashUsed(bytes32)')}${hash.slice(2)}`]: `0x${word(1n)}` };
  const replayed = await sign(data, { tokens: new StaticTokenRegistry(), rpc: rpcOf(usedHash) });
  assert.ok(codes(replayed).includes('meta_tx_nonce_used'));
  const fresh = await sign(gelato('SponsoredCallConcurrentERC2771', GELATO_CONCURRENT, { userSalt: `0x${'cd'.repeat(32)}` }), { tokens: new StaticTokenRegistry(), rpc: rpcOf(usedHash) });
  assert.ok(!codes(fresh).includes('meta_tx_nonce_used'));
  // A message naming another chain than its domain's.
  assert.ok(codes(await sign(gelato('SponsoredCallERC2771', GELATO_1BALANCE, { chainId: '1' }))).includes('meta_tx_chain_mismatch'));
});

test('Shapes that are not exactly these are left to the other decoders', async () => {
  const odd = forward();
  (odd.types.ForwardRequest as { name: string; type: string }[]).push({ name: 'extra', type: 'uint256' });
  assert.notEqual((await sign(odd)).decoding.decoder, 'meta_tx_oz5');
  const bad = polygon({ from: 'not an address' });
  assert.notEqual((await sign(bad)).decoding.decoder, 'meta_tx_polygon');
});

test('Real meta-transactions recover to their users over the digest computed here, and are read as their calls', async () => {
  const { recoverAddress } = await import('viem');
  const { typedDataDigest } = await import('../src/typed-data/common.ts');
  const { readFileSync } = await import('node:fs');
  for (const [file, decoder, title] of [['meta-tx-polygon-usdt0.json', 'meta_tx_polygon', /^Gasless call as you: Send 111 USDT0/], ['meta-tx-oz5-bsc.json', 'meta_tx_oz5', /^Gasless call as you: Send 1341105786420000000000 base units of token 0xdc5a/]] as const) {
    const f = JSON.parse(readFileSync(new URL(`./fixtures/${file}`, import.meta.url), 'utf8'));
    assert.equal((await recoverAddress({ hash: typedDataDigest(f.typedData)!, signature: f.signature })).toLowerCase(), f.signer, file);
    const p = await sign(f.typedData, { tokens: new StaticTokenRegistry() }, f.signer);
    assert.equal(p.decoding.decoder, decoder);
    assert.match(p.title, title);
  }
});
