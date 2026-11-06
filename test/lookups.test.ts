import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, encodeFunctionData, parseAbi, stringToHex, toHex, type Abi } from 'viem';
import { previewRequest } from '../src/preview.ts';
import { StaticTokenRegistry } from '../src/chains.ts';
import { ChainedTokenRegistry, decodeStringOrBytes32, impersonatedToken, OnchainTokenRegistry, TokenListRegistry } from '../src/tokens.ts';
import { ChainedSignatures, ContractAbiResolver, detectProxy, PROXY_SLOTS, SourcifyAbiSource, StaticAbiSource, EtherscanAbiSource, OpenChainSignatures, FourByteSignatures } from '../src/abi.ts';
import { abiAdapter } from '../src/evm/abi-adapter.ts';
import { isRpcError, type RpcClient } from '../src/rpc.ts';
import type { Dependencies } from '../src/types.ts';
import { ALICE, BOB } from '../mocks/data.ts';
import { codes, detail, NOW } from './helpers.ts';

/** In-memory chain: code, storage and eth_call results per address. */
function fakeRpc(state: Record<string, { code?: string; storage?: Record<string, string>; calls?: Record<string, string> }>): RpcClient & { count: number } {
  const rpc = {
    count: 0,
    has: () => true,
    async call(_chainId: number, method: string, params: unknown[]) {
      rpc.count++;
      const a = String((method === 'eth_call' ? (params[0] as { to: string }).to : params[0])).toLowerCase();
      const s = state[a] ?? {};
      if (method === 'eth_getCode') return s.code ?? '0x';
      if (method === 'eth_getStorageAt') return s.storage?.[String(params[1]).toLowerCase()] ?? '0x' + '0'.repeat(64);
      if (method === 'eth_call') { const r = s.calls?.[(params[0] as { data: string }).data]; if (r === undefined) throw Object.assign(new Error('execution reverted'), { rpcError: { code: 3, message: 'execution reverted' } }); return r; }
      throw new Error('unsupported ' + method);
    },
  };
  return rpc;
}
const word = (a: string) => '0x' + a.slice(2).toLowerCase().padStart(64, '0');
const str = (s: string) => encodeAbiParameters([{ type: 'string' }], [s]);

test('EIP-1967/1822/ZeppelinOS slots match their derivations and the slot embedded in real proxy bytecode', () => {
  // Pushed by Circle's CctpExtensionV2 proxy bytecode on Arbitrum One (read live 2026-11-03).
  assert.equal(PROXY_SLOTS.eip1967Implementation, '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc');
  assert.equal(PROXY_SLOTS.eip1967Beacon, '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50');
  assert.equal(PROXY_SLOTS.zeppelinos, '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3');
  assert.equal(PROXY_SLOTS.eip1822, '0xc5f16f0fcc639fa48a6947836d9850f504798523bf8c9a3a87d5876cf622bcf7');
});

test('Token symbols: string and legacy bytes32 returns, garbage rejected', () => {
  assert.equal(decodeStringOrBytes32(str('USDC')), 'USDC');
  assert.equal(decodeStringOrBytes32(stringToHex('MKR', { size: 32 })), 'MKR');
  assert.equal(decodeStringOrBytes32('0x'), null);
  assert.equal(decodeStringOrBytes32(str('bad\u0007name')), null);
});

test('On-chain token metadata is read, cached and marked self-reported; non-tokens are rejected', async () => {
  const TOKEN = '0x1111111111111111111111111111111111111111';
  const rpc = fakeRpc({ [TOKEN]: { code: '0x60', calls: { '0x95d89b41': str('FOO'), '0x313ce567': word(toHex(8)), '0x06fdde03': str('Foo Token') } } });
  const reg = new OnchainTokenRegistry(rpc);
  assert.deepEqual(await reg.get(1, TOKEN), { address: TOKEN, symbol: 'FOO', decimals: 8, name: 'Foo Token', source: 'onchain' });
  const before = rpc.count;
  await reg.get(1, TOKEN);
  assert.equal(rpc.count, before, 'second lookup is cached');
  assert.equal(await reg.get(1, '0x2222222222222222222222222222222222222222'), undefined);
});

test('Token lists and chained registries; curated tokens win', async () => {
  const list = new TokenListRegistry({ tokens: [
    { chainId: 42161, address: '0x912CE59144191C1204E64559FE8253a0e49E6548', symbol: 'ARB', decimals: 18, name: 'Arbitrum' },
    { chainId: 42161, address: 'not-an-address', symbol: 'BAD', decimals: 18 },
  ] });
  assert.equal(list.size, 1);
  const chained = new ChainedTokenRegistry([new StaticTokenRegistry(), list]);
  assert.equal((await chained.get(42161, '0x912ce59144191c1204e64559fe8253a0e49e6548'))?.source, 'tokenlist');
  assert.equal((await chained.get(42161, '0xaf88d065e77c8cc2239327c5edb3a432268e5831'))?.source, 'builtin');
});

test('A self-reported token copying a curated symbol is flagged as a fake; look-alike characters are flagged', async () => {
  const FAKE = '0x5ca3000000000000000000000000000000000001', LOOKALIKE = '0x5ca3000000000000000000000000000000000002';
  const rpc = fakeRpc({
    [FAKE]: { code: '0x60', calls: { '0x95d89b41': str('USDC'), '0x313ce567': word(toHex(6)), '0x06fdde03': str('USD Coin') } },
    [LOOKALIKE]: { code: '0x60', calls: { '0x95d89b41': str('USDС'), '0x313ce567': word(toHex(6)), '0x06fdde03': str('USD Coin') } },
  });
  const deps: Dependencies = { tokens: new ChainedTokenRegistry([new StaticTokenRegistry(), new OnchainTokenRegistry(rpc)]) };
  const transfer = (token: string) => previewRequest({ method: 'eth_sendTransaction', params: [{ from: ALICE, to: token, chainId: '0xa4b1',
    data: encodeFunctionData({ abi: parseAbi(['function transfer(address,uint256)']), functionName: 'transfer', args: [BOB, 1_000_000n] }) }] }, { now: NOW }, deps);
  const fake = await transfer(FAKE);
  assert.equal(fake.attention, 'danger');
  assert.ok(codes(fake).includes('token_impersonation'));
  assert.match(fake.warnings.find(w => w.code === 'token_impersonation')!.message, /not the real USDC on Arbitrum One \(0xaf88/);
  assert.ok(codes(await transfer(LOOKALIKE)).includes('token_symbol_lookalike'));
  const real = await transfer('0xaf88d065e77c8cC2239327C5EDb3A432268e5831');
  assert.ok(!codes(real).some(c => c.startsWith('token_')));
  assert.equal(impersonatedToken(42161, { address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', symbol: 'USDC', decimals: 6, source: 'onchain' }), null, 'the real address is not a fake');
});

test('Proxy detection: EIP-7702, EIP-1167, EIP-1967, beacon and implementation() getter', async () => {
  const P = '0x9000000000000000000000000000000000000001', IMPL = '0x9000000000000000000000000000000000000002', BEACON = '0x9000000000000000000000000000000000000003';
  const impl = { code: '0x6080' };
  const cases: [string, Record<string, unknown>, string | null][] = [
    ['eip7702', { [P]: { code: '0xef0100' + IMPL.slice(2) }, [IMPL]: impl }, IMPL],
    ['eip1167', { [P]: { code: '0x363d3d373d3d3d363d73' + IMPL.slice(2) + '5af43d82803e903d91602b57fd5bf3' }, [IMPL]: impl }, IMPL],
    ['eip1967', { [P]: { code: '0x60', storage: { [PROXY_SLOTS.eip1967Implementation]: word(IMPL) } }, [IMPL]: impl }, IMPL],
    ['eip1967-beacon', { [P]: { code: '0x60', storage: { [PROXY_SLOTS.eip1967Beacon]: word(BEACON) } }, [BEACON]: { code: '0x60', calls: { '0x5c60da1b': word(IMPL) } }, [IMPL]: impl }, IMPL],
    ['implementation()', { [P]: { code: '0x60' + '5c60da1b', calls: { '0x5c60da1b': word(IMPL) } }, [IMPL]: impl }, IMPL],
    ['implementation without code is ignored', { [P]: { code: '0x60', storage: { [PROXY_SLOTS.eip1967Implementation]: word(IMPL) } } }, null],
    ['plain contract', { [P]: { code: '0x6080' } }, null],
  ];
  for (const [name, state, expected] of cases) {
    const r = await detectProxy(fakeRpc(state as never), 1, P);
    assert.equal(r?.implementation ?? null, expected, name);
  }
});

const POOL_ABI = parseAbi([
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',
  'function multicall(bytes[] data)',
  'function transferOwnership(address newOwner)',
]);

test('Sourcify ABI via a proxy: functions decode with parameter names, token-aware amounts and a "(you)" label', async () => {
  const PROXY = '0x794a61358d6845594f94dc1db02a252b5b4814ad', IMPL = '0xf05fd3cc911b4c5e36e53c00354f645e22922c9a';
  const rpc = fakeRpc({ [PROXY]: { code: '0x60', storage: { [PROXY_SLOTS.eip1967Implementation]: word(IMPL) } }, [IMPL]: { code: '0x6080' } });
  const requested: string[] = [];
  const sourcify = new SourcifyAbiSource({ fetchImpl: (async (url: string) => {
    requested.push(url);
    if (url.includes(IMPL)) return new Response(JSON.stringify({ abi: POOL_ABI, compilation: { name: 'L2Pool' }, match: 'exact_match' }));
    return new Response(JSON.stringify({ customCode: 'not_found' }), { status: 404 });
  }) as typeof fetch });
  const deps: Dependencies = { tokens: new StaticTokenRegistry(), abis: new ContractAbiResolver({ sources: [sourcify], rpc }) };
  const data = encodeFunctionData({ abi: POOL_ABI, functionName: 'supply', args: ['0xaf88d065e77c8cC2239327C5EDb3A432268e5831', 100_000_000n, ALICE, 0] });
  const p = await previewRequest({ method: 'eth_sendTransaction', params: [{ from: ALICE, to: PROXY, data, chainId: '0xa4b1' }] }, { now: NOW }, deps);
  assert.equal(p.title, 'Call supply on L2Pool');
  assert.equal(p.decoding.status, 'full');
  assert.equal(detail(p, 'amount'), '100 USDC');
  assert.equal(detail(p, 'onBehalfOf'), `${ALICE} (you)`);
  assert.match(detail(p, 'asset')!, /^USDC \(0xaf88/);
  assert.equal(detail(p, 'Proxy implementation'), IMPL);
  assert.match(detail(p, 'ABI source')!, /sourcify \(exact_match\) via eip1967 proxy/);
  assert.ok(requested[0].endsWith(`/v2/contract/42161/${PROXY}?fields=abi,compilation`));

  const batch = encodeFunctionData({ abi: POOL_ABI, functionName: 'multicall', args: [[data, encodeFunctionData({ abi: POOL_ABI, functionName: 'transferOwnership', args: [BOB] })]] });
  const mc = await previewRequest({ method: 'eth_sendTransaction', params: [{ from: ALICE, to: PROXY, data: batch, chainId: '0xa4b1' }] }, { now: NOW }, deps);
  assert.equal(detail(mc, 'Batched call 1'), 'supply(asset, amount, onBehalfOf, referralCode)');
  assert.equal(detail(mc, 'Batched call 2'), 'transferOwnership(newOwner)');
  const owner = await previewRequest({ method: 'eth_sendTransaction', params: [{ from: ALICE, to: PROXY, data: encodeFunctionData({ abi: POOL_ABI, functionName: 'transferOwnership', args: [BOB] }), chainId: '0xa4b1' }] }, { now: NOW }, deps);
  assert.ok(codes(owner).includes('sensitive_function'));
});

test('Signature-database decoding is marked unverified, and must reproduce the calldata exactly', async () => {
  const swap = parseAbi(['function swapExactTokensForTokens(uint256,uint256,address[],address,uint256)']);
  const data = encodeFunctionData({ abi: swap, functionName: 'swapExactTokensForTokens', args: [1_000_000n, 990_000n, ['0xaf88d065e77c8cC2239327C5EDb3A432268e5831', '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1'], ALICE, 1_800_000_000n] });
  const deps: Dependencies = { tokens: new StaticTokenRegistry(), signatures: new ChainedSignatures([]) }; // built-in list, no network
  // A router that isn't Uniswap's own (SushiSwap's, same ABI): Uniswap's routers have their own decoder.
  const p = await previewRequest({ method: 'eth_sendTransaction', params: [{ from: ALICE, to: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506', data, chainId: '0xa4b1' }] }, { now: NOW }, deps);
  assert.equal(p.title.toLowerCase(), 'call swapexacttokensfortokens on 0x1b02…7506');
  assert.equal(p.decoding.status, 'partial');
  assert.ok(codes(p).includes('unverified_signature'));
  assert.match(detail(p, 'path[0]')!, /^USDC/);
  assert.equal(detail(p, 'amountIn'), '1 USDC', 'amountIn is in path[0]');
  assert.equal(detail(p, 'amountOutMin'), '0.00000000000099 WETH', 'amountOutMin is in the last path token');
  assert.equal(detail(p, 'to'), `${ALICE} (you)`);

  // Uniswap V3 SwapRouter02: amountIn pairs with tokenIn, amountOutMinimum with tokenOut.
  const v3 = parseAbi(['struct P { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }', 'function exactInputSingle(P params)']);
  const v3data = encodeFunctionData({ abi: v3, functionName: 'exactInputSingle', args: [{ tokenIn: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', tokenOut: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', fee: 500, recipient: ALICE, amountIn: 10n ** 18n, amountOutMinimum: 3_500_000_000n, sqrtPriceLimitX96: 0n }] });
  const q = await previewRequest({ method: 'eth_sendTransaction', params: [{ from: ALICE, to: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506', data: v3data, chainId: '0xa4b1' }] }, { now: NOW }, deps);
  assert.equal(detail(q, 'params.amountIn'), '1 WETH');
  assert.equal(detail(q, 'params.amountOutMinimum'), '3,500 USDC');
  assert.equal(detail(q, 'params.fee'), '500');

  // A database returning the built-in function again, without parameter names, is the same function, not a collision.
  const dup = new ChainedSignatures([{ lookup: async () => ['swapExactTokensForTokens(uint256,uint256,address[],address,uint256)'] }]);
  const r2 = await abiAdapter({ chainId: 42161, from: ALICE, to: '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24', data, value: 0n }, { deps: { tokens: new StaticTokenRegistry(), signatures: dup }, context: {} });
  assert.ok(!r2!.b.warnings.some(w => w.code === 'ambiguous_signature'));
  assert.match(r2!.title, /^Call swapExactTokensForTokens/);
  // 0xa9059cbb is also the selector of "many_msg_babbage(bytes1)"; only the reading that re-encodes exactly is kept.
  const collision = { lookup: async () => ['many_msg_babbage(bytes1)', 'transfer(address,uint256)'] };
  const transferData = encodeFunctionData({ abi: parseAbi(['function transfer(address,uint256)']), functionName: 'transfer', args: [BOB, 5n] });
  const r = await abiAdapter({ chainId: 1, from: ALICE, to: '0x0000000000000000000000000000000000000abc', data: transferData, value: 0n }, { deps: { signatures: collision }, context: {} });
  assert.equal(r?.title, 'Call transfer on 0x0000…0abc');
});

test('Etherscan, OpenChain and 4byte response parsing', async () => {
  const json = (body: unknown) => (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;
  const es = await new EtherscanAbiSource('KEY', { fetchImpl: json({ status: '1', result: [{ ABI: JSON.stringify(POOL_ABI), ContractName: 'L2Pool' }] }) }).lookup(42161, '0x1');
  assert.equal(es?.name, 'L2Pool');
  assert.equal((es?.abi as Abi).length, 3);
  assert.equal(await new EtherscanAbiSource('KEY', { fetchImpl: json({ status: '1', result: [{ ABI: 'Contract source code not verified', ContractName: '' }] }) }).lookup(1, '0x1'), null);
  await assert.rejects(new EtherscanAbiSource('KEY', { fetchImpl: json({ status: '0', message: 'NOTOK', result: 'Max calls per sec rate limit reached (5/sec)' }) }).lookup(1, '0x1'), /rate limit/);
  assert.deepEqual(await new OpenChainSignatures({ fetchImpl: json({ ok: true, result: { function: { '0xa9059cbb': [{ name: 'transfer(address,uint256)', filtered: false }] } } }) }).lookup('0xa9059cbb'), ['transfer(address,uint256)']);
  assert.deepEqual(await new FourByteSignatures({ fetchImpl: json({ results: [{ text_signature: 'transfer(address,uint256)' }] }) }).lookup('0xa9059cbb'), ['transfer(address,uint256)']);
  const user = new StaticAbiSource({ '1:0xAbc0000000000000000000000000000000000000': { abi: POOL_ABI, name: 'Mine' } });
  assert.equal((await user.lookup(1, '0xabc0000000000000000000000000000000000000'))?.name, 'Mine');
});

test('Network failures are retried, not cached as "not a token" / "no ABI" / "not a proxy"', async () => {
  const TOKEN = '0x1111111111111111111111111111111111111111';
  const good = fakeRpc({ [TOKEN]: { code: '0x60', calls: { '0x95d89b41': str('FOO'), '0x313ce567': word(toHex(8)), '0x06fdde03': str('Foo') } } });
  let down = true;
  const flaky: RpcClient = { has: () => true, call: (c, m, p) => down ? Promise.reject(new Error('eth_call: HTTP 429')) : good.call(c, m, p) };
  assert.equal(isRpcError(new Error('HTTP 429')), false);
  const tokens = new OnchainTokenRegistry(flaky, { retryMs: 0 });
  assert.equal(await tokens.get(1, TOKEN), undefined, 'unavailable while the RPC is down');
  down = false;
  assert.equal((await tokens.get(1, TOKEN))?.symbol, 'FOO', 'looked up again once it recovers');
  // A revert, by contrast, is a real answer and stays cached.
  const reverts = new OnchainTokenRegistry(good);
  assert.equal(await reverts.get(1, '0x3333333333333333333333333333333333333333'), undefined);
  const n = good.count;
  await reverts.get(1, '0x3333333333333333333333333333333333333333');
  assert.equal(good.count, n);

  down = true;
  await assert.rejects(detectProxy(flaky, 1, TOKEN), /429/, 'detectProxy surfaces network failures');
  let sourcifyDown = true;
  const source = { lookup: async () => { if (sourcifyDown) throw new Error('Sourcify HTTP 503'); return { abi: POOL_ABI as unknown as unknown[], name: 'L2Pool', source: 'sourcify (match)', verified: true }; } };
  const resolver = new ContractAbiResolver({ sources: [source], retryMs: 0 });
  assert.equal(await resolver.resolve(1, TOKEN), null);
  sourcifyDown = false;
  assert.equal((await resolver.resolve(1, TOKEN))?.name, 'L2Pool');
});

// Recorded 2026-11-04: 4byte's entries for 0xa9059cbb (newest first, as the API returns them) and OpenChain's
// filtered answer. address and uint256 are both one 32-byte word, so "workMyDirefulOwner(uint256,uint256)" fits any
// transfer(address,uint256) calldata exactly; only the source ranking can tell them apart.
const FOURBYTE_A9059CBB = { count: 6, next: null, previous: null, results: [
  { id: 1111734, text_signature: 'workMyDirefulOwner(uint256,uint256)' }, { id: 844280, text_signature: 'join_tg_invmru_haha_fd06787(address,bool)' },
  { id: 313067, text_signature: 'func_2093253501(bytes)' }, { id: 161159, text_signature: 'transfer(bytes4[9],bytes5[6],int48[11])' },
  { id: 31780, text_signature: 'many_msg_babbage(bytes1)' }, { id: 145, text_signature: 'transfer(address,uint256)' },
] };
const OPENCHAIN_A9059CBB = { ok: true, result: { function: { '0xa9059cbb': [{ name: 'transfer(address,uint256)', filtered: false, hasVerifiedContract: true }] }, event: {} } };

test('Selector collisions that fit the same calldata are resolved by source trust, as seen in live data', async () => {
  const json = (body: unknown) => (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;
  const down = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
  const fourByte = new FourByteSignatures({ fetchImpl: json(FOURBYTE_A9059CBB) });
  assert.equal((await fourByte.lookup('0xa9059cbb'))[0], 'transfer(address,uint256)', '4byte results are oldest first');
  const data = encodeFunctionData({ abi: parseAbi(['function transfer(address,uint256)']), functionName: 'transfer', args: [BOB, 5n] });
  const tx = { chainId: 42161, from: ALICE, to: '0x4000000000000000000000000000000000000004', data, value: 0n };
  const run = (signatures: Dependencies['signatures']) => abiAdapter(tx, { deps: { signatures }, context: {} });

  // OpenChain (spam-filtered) outranks 4byte: transfer, with no ambiguity.
  const both = await run(new ChainedSignatures([new OpenChainSignatures({ fetchImpl: json(OPENCHAIN_A9059CBB) }), fourByte], { builtIn: false }));
  assert.equal(both?.title, 'Call transfer on 0x4000…0004');
  assert.ok(!both!.b.warnings.some(w => w.code === 'ambiguous_signature'));
  assert.equal(both!.b.details.find(d => d.label === 'ABI source')?.value, 'OpenChain signature database (unverified)');

  // OpenChain unreachable: 4byte alone, the oldest registration is shown and the collision is called out.
  const only4byte = await run(new ChainedSignatures([new OpenChainSignatures({ fetchImpl: down }), new FourByteSignatures({ fetchImpl: json(FOURBYTE_A9059CBB) })], { builtIn: false }));
  assert.equal(only4byte?.title, 'Call transfer on 0x4000…0004');
  assert.equal(only4byte?.status, 'partial');
  assert.match(only4byte!.b.warnings.find(w => w.code === 'ambiguous_signature')!.message, /transfer\(address,uint256\), is shown; also possible: workMyDirefulOwner\(uint256,uint256\)/);

  // Two fitting names from a source with no age order: neither is named.
  const tie = await run(new ChainedSignatures([new OpenChainSignatures({ fetchImpl: json({ ok: true, result: { function: { '0xa9059cbb': [{ name: 'transfer(address,uint256)' }, { name: 'workMyDirefulOwner(uint256,uint256)' }] } } }) })], { builtIn: false }));
  assert.equal(tie?.status, 'opaque');
  assert.match(tie!.title, /or similar/);
});

test('The built-in signature list has no selector collisions', async () => {
  const { toFunctionSelector } = await import('viem');
  const bySelector = new Map<string, string>();
  for (const sig of (await import('../src/abi.ts')).COMMON_SIGNATURES) {
    const sel = toFunctionSelector(`function ${sig}`);
    assert.ok(!bySelector.has(sel), `${sig} collides with ${bySelector.get(sel)}`);
    bySelector.set(sel, sig);
  }
});
