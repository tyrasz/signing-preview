import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, encodeFunctionData, maxUint256, parseAbi } from 'viem';
import { previewRequest } from '../src/preview.ts';
import { PERMIT2, StaticTokenRegistry } from '../src/chains.ts';
import { ELSEWHERE, parseLogs, RpcSimulator } from '../src/simulation.ts';
import type { Dependencies, SimulationRequest, SimulationResult, Simulator, TokenRegistry } from '../src/types.ts';
import { ALICE, BOB, ROUTER, SPENDER } from '../mocks/data.ts';
import { codes, NOW } from './helpers.ts';

const USDC = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
const APES = '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d', FAKE_APES = '0x5ca3000000000000000000000000000000000abc', ITEMS = '0x1155000000000000000000000000000000001155';
const T = {
  transfer: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', approval: '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925',
  approvalForAll: '0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31', single: '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62',
  batch: '0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb', p2approval: '0xda9fa7c1b00402c17d0161b249b1ab8bbec047c5a52207b9c112deffd817036b',
  p2permit: '0xc6a377bfc4eb120024a8ac08eef205be16b817020812c73223e81d1bdb9708ec', p2lockdown: '0x89b1add15eff56b3dfe299ad94e01f2b52fbcb80ae1a3baea6ae8c04cb2b98a4',
};
const w = (v: string | bigint | boolean) => '0x' + (typeof v === 'string' ? v.slice(2) : BigInt(v).toString(16)).toLowerCase().padStart(64, '0');
const data = (...words: (string | bigint | boolean)[]) => '0x' + words.map(x => w(x).slice(2)).join('');
const MAX160 = (1n << 160n) - 1n;
const EXPIRY = Math.floor(NOW / 1000) + 30 * 86400;

test('Logs: ERC-721 and ERC-1155 transfers, ERC-20/721 approvals, ApprovalForAll and Permit2 events', () => {
  const r = parseLogs([
    { address: USDC, topics: [T.transfer, w(ALICE), w(BOB)], data: data(5n) },
    { address: APES, topics: [T.transfer, w(BOB), w(ALICE), w(42n)], data: '0x' },
    { address: ITEMS, topics: [T.single, w(ROUTER), w(ALICE), w(BOB)], data: data(7n, 3n) },
    { address: ITEMS, topics: [T.batch, w(ROUTER), w(BOB), w(ALICE)], data: encodeAbiParameters([{ type: 'uint256[]' }, { type: 'uint256[]' }], [[1n, 2n], [10n, 20n]]) },
    { address: USDC, topics: [T.approval, w(ALICE), w(SPENDER)], data: data(maxUint256) },
    { address: APES, topics: [T.approval, w(ALICE), w(SPENDER), w(42n)], data: '0x' },
    { address: APES, topics: [T.approvalForAll, w(ALICE), w(SPENDER)], data: data(true) },
    { address: PERMIT2, topics: [T.p2permit, w(ALICE), w(USDC), w(ROUTER)], data: data(MAX160, BigInt(EXPIRY), 0n) },
    { address: PERMIT2, topics: [T.p2approval, w(ALICE), w(USDC), w(SPENDER)], data: data(1000n, 0n) },
    { address: PERMIT2, topics: [T.p2lockdown, w(ALICE), w(USDC), w(SPENDER)], data: '0x' },
    // A Permit2-shaped event from any other contract is ignored: only the real Permit2 can set Permit2 allowances.
    { address: FAKE_APES, topics: [T.p2permit, w(ALICE), w(USDC), w(BOB)], data: data(MAX160, 0n, 0n) },
  ]);
  assert.deepEqual(r.transfers.map(t => [t.asset, t.raw]), [[USDC, 5n]]);
  assert.deepEqual(r.nftTransfers.map(t => [t.standard, t.collection, t.from, t.to, t.tokenId, t.amount]), [
    ['erc721', APES, BOB, ALICE, 42n, 1n], ['erc1155', ITEMS, ALICE, BOB, 7n, 3n], ['erc1155', ITEMS, BOB, ALICE, 1n, 10n], ['erc1155', ITEMS, BOB, ALICE, 2n, 20n],
  ]);
  assert.deepEqual(r.approvals.map(a => [a.kind, a.token, a.spender, a.amount ?? a.tokenId ?? a.approved]), [
    ['erc20', USDC, SPENDER, maxUint256], ['erc721', APES, SPENDER, 42n], ['operator', APES, SPENDER, true],
    ['permit2', USDC, ROUTER, MAX160], ['permit2', USDC, SPENDER, 1000n], ['permit2', USDC, SPENDER, 0n],
  ]);
  assert.equal(r.approvals[3].expiration, EXPIRY);
});

/** Simulator returning fixed effects for any call. */
const fixed = (result: Omit<SimulationResult, 'status' | 'source'>): Simulator => ({ simulate: async () => ({ status: 'success', source: 'test', gasUsed: 100_000n, ...result }) });
/** Token registry that also names NFT collections (as OnchainTokenRegistry does from symbol()). */
const named: TokenRegistry = { get: (c, a) => new StaticTokenRegistry().get(c, a), collection: async (_c, a) => (a === APES || a === FAKE_APES ? { symbol: 'BAYC', name: 'BoredApeYachtClub' } : undefined) };
const deps = (simulator: Simulator): Dependencies => ({ tokens: named, simulator });
const send = (to: string, d = '0xdeadbeef') => ({ method: 'eth_sendTransaction', params: [{ from: ALICE, to, data: d, chainId: '0xa4b1' }] });

test('NFTs show in balance changes; received NFT names are flagged as self-reported', async () => {
  const p = await previewRequest(send(ROUTER), { now: NOW }, deps(fixed({
    transfers: [{ asset: USDC, from: ALICE, to: ROUTER, raw: 1_500_000_000n }],
    nftTransfers: [{ standard: 'erc721', collection: APES, from: ROUTER, to: ALICE, tokenId: 42n, amount: 1n }, { standard: 'erc1155', collection: ITEMS, from: ALICE, to: BOB, tokenId: 7n, amount: 3n }],
  })));
  assert.deepEqual(p.assetChanges.map(c => [c.direction, c.amount, c.symbol, c.standard, c.tokenId]), [
    ['out', '1,500', 'USDC', 'erc20', undefined], ['in', '1', 'BAYC #42', 'erc721', '42'], ['out', '3', 'NFT 0x1155…1155 #7', 'erc1155', '7'],
  ]);
  assert.ok(codes(p).includes('nft_metadata_unverified'));
  // Long token IDs (e.g. ENS names) are shortened in the label but kept whole in tokenId.
  const ens = 2n ** 250n + 12345n;
  const e = await previewRequest(send(ROUTER), { now: NOW }, deps(fixed({ transfers: [], nftTransfers: [{ standard: 'erc721', collection: ITEMS, from: BOB, to: ALICE, tokenId: ens, amount: 1n }] })));
  assert.match(e.assetChanges[0].symbol, /^NFT 0x1155…1155 #\d{6}…\d{4}$/);
  assert.equal(e.assetChanges[0].tokenId, ens.toString());
});

test('A Permit2 allowance set inside a router call is listed and flagged; the expiry is shown', async () => {
  const p = await previewRequest(send(ROUTER), { now: NOW }, deps(fixed({
    transfers: [{ asset: USDC, from: ALICE, to: ROUTER, raw: 10_000_000n }],
    approvals: [{ kind: 'permit2', emitter: PERMIT2, token: USDC, owner: ALICE, spender: ROUTER, amount: MAX160, expiration: EXPIRY }],
  })));
  assert.deepEqual(p.approvals?.map(a => [a.kind, a.symbol, a.spender, a.allowance, a.direct, a.expiration]), [['permit2', 'USDC', ROUTER, 'unlimited', false, EXPIRY]]);
  const msg = p.warnings.find(x => x.code === 'hidden_unlimited_approval')!.message;
  assert.match(msg, /0x7e57…0006 can spend an unlimited amount of your USDC through Permit2 until 2026-12-02/);
  assert.equal(p.warnings.find(x => x.code === 'hidden_unlimited_approval')!.severity, 'caution');
});

test('A direct approve() is listed but not warned about twice; allowances left after spending are shown as final values', async () => {
  const approve = encodeFunctionData({ abi: parseAbi(['function approve(address,uint256)']), functionName: 'approve', args: [SPENDER, maxUint256] });
  const direct = await previewRequest(send(USDC, approve), { now: NOW }, deps(fixed({ transfers: [], approvals: [{ kind: 'erc20', emitter: USDC, token: USDC, owner: ALICE, spender: SPENDER, amount: maxUint256 }] })));
  assert.equal(direct.approvals?.[0].direct, true);
  assert.ok(codes(direct).includes('unlimited_approval'), 'from the approve decoder');
  assert.ok(!codes(direct).some(c => c.startsWith('hidden_')));

  // Older OpenZeppelin tokens emit Approval(remaining) on transferFrom: the last value is what is left.
  const spent = await previewRequest(send(ROUTER), { now: NOW }, deps(fixed({ transfers: [{ asset: USDC, from: ALICE, to: ROUTER, raw: 100_000_000n }], approvals: [
    { kind: 'erc20', emitter: USDC, token: USDC, owner: ALICE, spender: ROUTER, amount: 1_000_000_000n },
    { kind: 'erc20', emitter: USDC, token: USDC, owner: ALICE, spender: ROUTER, amount: 900_000_000n },
  ] })));
  assert.deepEqual(spent.approvals?.map(a => a.allowance), ['900 USDC']);
  assert.match(spent.warnings.find(x => x.code === 'hidden_approval')!.message, /can spend up to 900 USDC from your account/);
  assert.equal(spent.warnings.find(x => x.code === 'hidden_approval')!.severity, 'info', 'a limited, remaining allowance is a note, not a caution');
});

test('Hidden ApprovalForAll is danger, several are listed in one warning; ERC-721 transfer clean-ups and other owners are ignored', async () => {
  const p = await previewRequest(send(ROUTER), { now: NOW }, deps(fixed({ transfers: [], approvals: [
    { kind: 'operator', emitter: APES, token: APES, owner: ALICE, spender: SPENDER, approved: true },
    { kind: 'operator', emitter: ITEMS, token: ITEMS, owner: ALICE, spender: BOB, approved: true },
    { kind: 'erc721', emitter: APES, token: APES, owner: ALICE, spender: '0x0000000000000000000000000000000000000000', tokenId: 9n },
    { kind: 'erc20', emitter: USDC, token: USDC, owner: BOB, spender: ROUTER, amount: maxUint256 },
  ] })));
  assert.equal(p.attention, 'danger');
  assert.equal(p.approvals?.length, 2);
  const msg = p.warnings.find(x => x.code === 'hidden_approval_for_all')!.message;
  assert.match(msg, /0x5bad…0005 can transfer every NFT you hold in BAYC; and 0xb0b0…0002 can transfer every NFT you hold in NFT 0x1155…1155/);
  // A revocation is listed, not warned about.
  const revoke = await previewRequest(send(ROUTER), { now: NOW }, deps(fixed({ transfers: [], approvals: [{ kind: 'operator', emitter: APES, token: APES, owner: ALICE, spender: SPENDER, approved: false }] })));
  assert.deepEqual(revoke.approvals?.map(a => [a.allowance, a.revoked]), [['revoked', true]]);
  assert.ok(!codes(revoke).some(c => c.startsWith('hidden_')));
});

test('Batches report the final approval state across calls: an approval used up by the next call ends at none', async () => {
  const approve = encodeFunctionData({ abi: parseAbi(['function approve(address,uint256)']), functionName: 'approve', args: [ROUTER, 100_000_000n] });
  const sim: Simulator = {
    simulate: async () => null,
    simulateBatch: async (reqs: SimulationRequest[]) => reqs.map((r, i): SimulationResult => i === 0
      ? { status: 'success', source: 'test', transfers: [], approvals: [{ kind: 'erc20', emitter: USDC, token: USDC, owner: ALICE, spender: ROUTER, amount: 100_000_000n }] }
      : { status: 'success', source: 'test', transfers: [{ asset: USDC, from: ALICE, to: ROUTER, raw: 100_000_000n }], nftTransfers: [{ standard: 'erc721', collection: APES, from: ROUTER, to: ALICE, tokenId: 1n, amount: 1n }],
          approvals: [{ kind: 'erc20', emitter: USDC, token: USDC, owner: ALICE, spender: ROUTER, amount: 0n }] }),
  };
  const p = await previewRequest({ method: 'wallet_sendCalls', params: [{ version: '2.0.0', chainId: '0xa4b1', from: ALICE, calls: [{ to: USDC, data: approve }, { to: ROUTER, data: '0xdeadbeef' }] }] }, { now: NOW }, deps(sim));
  assert.deepEqual(p.approvals?.map(a => [a.symbol, a.allowance, a.revoked]), [['USDC', 'none', true]]);
  assert.deepEqual(p.assetChanges.map(c => [c.direction, c.amount, c.symbol]), [['out', '100', 'USDC'], ['in', '1', 'BAYC #1']]);
});

test('RpcSimulator returns NFT transfers and approvals from eth_simulateV1 logs', async () => {
  const fetchImpl = (async () => new Response(JSON.stringify({ result: [{ calls: [{ status: '0x1', gasUsed: '0x1', returnData: '0x', logs: [
    { address: APES, topics: [T.transfer, w(BOB), w(ALICE), w(42n)], data: '0x' },
    { address: APES, topics: [T.approvalForAll, w(ALICE), w(SPENDER)], data: data(true) },
  ] }] }] }))) as unknown as typeof fetch;
  const r = await new RpcSimulator({ 42161: 'http://rpc.invalid' }, { fetchImpl }).simulate({ chainId: 42161, from: ALICE, to: ROUTER, data: '0x', value: 0n });
  assert.equal(r?.nftTransfers?.[0].tokenId, 42n);
  assert.equal(r?.approvals?.[0].kind, 'operator');
});

test('RpcSimulator reads the real allowance after each call, so a silently spent approval is not shown as still open', async () => {
  // Like USDC: approve emits Approval(10 USDC); the spend in call 2 lowers the allowance without an event.
  const bodies: { params: [{ blockStateCalls: { calls: { to?: string; data: string }[] }[] }] }[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); bodies.push(body);
    const calls = body.params[0].blockStateCalls[0].calls as { data: string }[];
    if (bodies.length === 1) return new Response(JSON.stringify({ result: [{ calls: [
      { status: '0x1', gasUsed: '0x1', returnData: '0x', logs: [{ address: USDC, topics: [T.approval, w(ALICE), w(ROUTER)], data: data(10_000_000n) }] },
      { status: '0x1', gasUsed: '0x1', returnData: '0x', logs: [{ address: USDC, topics: [T.transfer, w(ALICE), w(ROUTER)], data: data(10_000_000n) }] },
    ] }] }));
    // Second pass: [balance reads, call 1, allowance read, balance reads, call 2, allowance read, balance reads]; the
    // allowance is 10 USDC after call 1 and 0 after call 2.
    return new Response(JSON.stringify({ result: [{ calls: calls.map((c, i) => ({ status: '0x1', gasUsed: '0x1', logs: [],
      returnData: c.data.startsWith('0xdd62ed3e') ? data(calls.slice(0, i).some(x => x.data.startsWith('0xdeadbeef')) ? 0n : 10_000_000n) : '0x' })) }] }));
  }) as typeof fetch;
  const simulator = new RpcSimulator({ 42161: 'http://rpc.invalid' }, { fetchImpl });
  const approve = encodeFunctionData({ abi: parseAbi(['function approve(address,uint256)']), functionName: 'approve', args: [ROUTER, 10_000_000n] });
  const p = await previewRequest({ method: 'wallet_sendCalls', params: [{ version: '2.0.0', chainId: '0xa4b1', from: ALICE, calls: [{ to: USDC, data: approve }, { to: ROUTER, data: '0xdeadbeef' }] }] }, { now: NOW }, { tokens: new StaticTokenRegistry(), simulator });
  assert.equal(bodies.length, 2, 'the simulation, then the state read back');
  const reads = new Set(['0x70a08231', '0x01ffc9a7', '0x4d2301cc']); // balances, NFT checks and native balances, around the calls
  assert.deepEqual(bodies[1].params[0].blockStateCalls[0].calls.map(c => c.data.slice(0, 10)).filter(s => !reads.has(s)), [approve.slice(0, 10), '0xdd62ed3e', '0xdeadbeef', '0xdd62ed3e']);
  assert.deepEqual(p.calls?.[0].approvals?.map(a => [a.allowance, a.basis]), [['10 USDC', 'simulated_state']], 'state after call 1');
  assert.deepEqual(p.approvals?.map(a => [a.allowance, a.revoked, a.basis]), [['none', true, 'simulated_state']], 'state after the batch');
});

test('When the node won’t answer the reads after a call, its result says why, and its amounts stay the events’', async () => {
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (body.params[0].blockStateCalls[0].calls.length === 1) return new Response(JSON.stringify({ result: [{ calls: [
      { status: '0x1', gasUsed: '0x1', returnData: '0x', logs: [{ address: USDC, topics: [T.transfer, w(ALICE), w(ROUTER)], data: data(10_000_000n) }] },
    ] }] }));
    return new Response(JSON.stringify({ error: { code: -32000, message: 'execution aborted (timeout = 5s)' } }));
  }) as typeof fetch;
  const r = await new RpcSimulator({ 42161: 'http://rpc.invalid' }, { fetchImpl }).simulate({ chainId: 42161, from: ALICE, to: ROUTER, data: '0xdeadbeef', value: 0n });
  assert.deepEqual([r?.status, r?.balancesRead, r?.stateReadError, r?.transfers.map(t => t.raw)], ['success', undefined, 'execution aborted (timeout = 5s)', [10_000_000n]]);
  // A node that refuses the reads outright (HTTP 403 here; HTTP 429 once its retries are spent): the same.
  const refusing = (async (_url: string, init: RequestInit) => JSON.parse(String(init.body)).params[0].traceTransfers ? fetchImpl(_url, init) : new Response(JSON.stringify({ error: { message: 'blocked' } }), { status: 403 })) as typeof fetch;
  const q = await new RpcSimulator({ 42161: 'http://rpc.invalid' }, { fetchImpl: refusing }).simulate({ chainId: 42161, from: ALICE, to: ROUTER, data: '0xdeadbeef', value: 0n });
  assert.deepEqual([q?.status, q?.balancesRead, q?.stateReadError], ['success', undefined, 'RPC HTTP 403: blocked']);
});

test('Native coin a node logs no transfer for (a SELFDESTRUCT) is read from the balance; a priced run’s gas is not a transfer', async () => {
  // OP Mainnet's, Base's and BNB Chain's nodes log no transfer for a SELFDESTRUCT: an account delegated (EIP-7702)
  // to code that selfdestructs loses its whole balance with no log. Alice's own call to herself: 1 ETH gone.
  const node = (logs: { address: string; topics: string[]; data: string }[], after: (gasUsed: bigint) => bigint) => {
    const bodies: { from?: string; to?: string; data: string }[][] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const calls = body.params[0].blockStateCalls[0].calls as { from?: string; to?: string; data: string }[];
      bodies.push(calls);
      if (body.params[0].traceTransfers) return new Response(JSON.stringify({ result: [{ calls: [{ status: '0x1', gasUsed: '0xd163', returnData: '0x', logs }] }] }));
      const at = calls.findIndex(c => c.from?.toLowerCase() === ALICE.toLowerCase());
      return new Response(JSON.stringify({ result: [{ calls: calls.map((c, i) => ({ status: '0x1', gasUsed: i === at ? '0xd163' : '0x5208', logs: [],
        returnData: c.data.startsWith('0x4d2301cc') && c.to === '0xca11bde05977b3631167028862be2a173976ca11' ? data(i < at ? 10n ** 18n : after(0xd163n)) : '0x' })) }] }));
    }) as typeof fetch;
    return { simulator: new RpcSimulator({ 8453: 'http://rpc.invalid' }, { fetchImpl }), bodies };
  };
  const natives = (r: SimulationResult) => r.transfers.filter(t => t.asset === 'native').map(t => [t.from, t.to, t.raw]);
  const alice = ALICE.toLowerCase();
  const drained = node([], () => 0n);
  const r = (await drained.simulator.simulate({ chainId: 8453, from: alice, to: alice, data: '0x', value: 0n }))!;
  assert.deepEqual([natives(r), r.balancesRead], [[[alice, ELSEWHERE, 10n ** 18n]], true]);
  assert.equal(drained.bodies[1].filter(c => c.data.startsWith('0x4d2301cc')).length, 2, 'read before and after the call');
  // A call that sends 5 wei, logged, at a price of 10 wei a gas: the balance falls by the 5 and its gas, nothing more.
  const sent = [{ address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', topics: [T.transfer, w(ALICE), w(ROUTER)], data: data(5n) }];
  const priced = (await node(sent, gas => 10n ** 18n - 5n - gas * 10n).simulator.simulate({ chainId: 8453, from: alice, to: ROUTER, data: '0x', value: 5n, gasPrice: 10n }))!;
  assert.deepEqual(natives(priced), [[alice, ROUTER, 5n]]);
  // A node that logs it too: nothing added.
  const logged = (await node(sent, () => 10n ** 18n - 5n).simulator.simulate({ chainId: 8453, from: alice, to: ROUTER, data: '0x', value: 5n }))!;
  assert.deepEqual(natives(logged), [[alice, ROUTER, 5n]]);
});

test('On a node that splits a block’s gas among the calls that set none, a heavy balanceOf is read again on its own', async () => {
  // reth's eth_simulateV1 (BNB Chain's public node) gives each call without a gas field an equal share of what the
  // block has left. A token like Open Genesis works out a holder's balance for 1.37 million gas and emits events
  // that mislead: the token "sends" Alice 100 and she sends 101, while her balance goes from 1,000 to nothing.
  const OG = '0x0e0000000000000000000000000000000000000e', LIMIT = 15_000_000n;
  const node = (mainNeeds: bigint, mainUses: bigint, fallsBackUnder?: bigint, readNeeds = 1_370_000n) => {
    const bodies: { from?: string; to?: string; data: string; gas?: string }[][] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const calls = JSON.parse(String(init.body)).params[0].blockStateCalls[0].calls as { from?: string; to?: string; data: string; gas?: string }[];
      bodies.push(calls);
      const set = calls.reduce((sum, c) => sum + (c.gas ? BigInt(c.gas) : 0n), 0n), unset = BigInt(calls.filter(c => !c.gas).length);
      const allowance = (c: { gas?: string }) => (c.gas ? BigInt(c.gas) : (LIMIT - set) / (unset || 1n));
      let spent = false;
      const out = calls.map(c => {
        if (c.data === '0xdeadbeef') {
          // An aggregator that catches its route running out of gas and takes another, which moves nothing of OG.
          if (fallsBackUnder !== undefined && allowance(c) < fallsBackUnder) return { status: '0x1', gasUsed: '0x30d40', returnData: '0x', logs: [] };
          if (allowance(c) < mainNeeds) return { status: '0x0', gasUsed: `0x${allowance(c).toString(16)}`, returnData: '0x', logs: [] };
          spent = true;
          return { status: '0x1', gasUsed: `0x${mainUses.toString(16)}`, returnData: '0x', logs: [
            { address: OG, topics: [T.transfer, w(OG), w(ALICE)], data: data(100n) },
            { address: OG, topics: [T.transfer, w(ALICE), w(ROUTER)], data: data(101n) },
          ] };
        }
        if (c.to === OG && c.data.startsWith('0x70a08231') && c.data.endsWith(ALICE.slice(2).toLowerCase())) {
          return allowance(c) < readNeeds ? { status: '0x0', gasUsed: `0x${allowance(c).toString(16)}`, returnData: '0x', logs: [] } : { status: '0x1', gasUsed: '0x14e8c0', returnData: data(spent ? 0n : 1_000n), logs: [] };
        }
        return { status: c.data.startsWith('0x01ffc9a7') ? '0x0' : '0x1', gasUsed: '0x5208', returnData: c.data.startsWith('0x70a08231') ? data(0n) : '0x', logs: [] };
      });
      return new Response(JSON.stringify({ result: [{ calls: out }] }));
    }) as typeof fetch;
    return { simulator: new RpcSimulator({ 56: 'http://rpc.invalid' }, { fetchImpl }), bodies };
  };
  const moved = (r: SimulationResult) => r.transfers.filter(t => t.asset === OG).map(t => [t.from, t.to, t.raw]);
  const request: SimulationRequest = { chainId: 56, from: ALICE.toLowerCase(), to: ROUTER, data: '0xdeadbeef', value: 0n };
  // The swap runs on its share of the reads' block, but the balance reads around it don't get the 1.37 million they
  // need. Asked again on their own, with the swap given what it used and half as much again and 100,000: 1,000 left.
  const a = node(500_000n, 400_000n);
  const ra = (await a.simulator.simulate(request))!;
  assert.deepEqual([moved(ra), ra.balancesRead], [[[ALICE.toLowerCase(), ROUTER, 1_000n]], true]);
  assert.equal(a.bodies.length, 3);
  assert.deepEqual(a.bodies[2].map(c => [c.data.slice(0, 10), c.gas]), [['0x70a08231', undefined], ['0xdeadbeef', `0x${700_000n.toString(16)}`], ['0x70a08231', undefined]]);
  // A swap that needs more than its share among the reads fails there: asked again the same way, for the tokens
  // its logs name.
  const b = node(900_000n, 600_000n);
  const rb = (await b.simulator.simulate(request))!;
  assert.deepEqual([moved(rb), rb.balancesRead, b.bodies.length], [[[ALICE.toLowerCase(), ROUTER, 1_000n]], true, 3]);
  // A call that succeeds on its share among the reads, but by another way (it used other gas), here with a token
  // whose reads are cheap: they describe that other way, in which nothing moved. The lean pass reads the way it went
  // the first time; where even that can't be had, the events stand rather than the other way's reads.
  const d = node(500_000n, 400_000n, 690_000n, 30_000n);
  assert.deepEqual([moved((await d.simulator.simulate(request))!), d.bodies.length], [[[ALICE.toLowerCase(), ROUTER, 1_000n]], 3]);
  const e = node(500_000n, 400_000n, 1_000_000n, 30_000n);
  assert.deepEqual(moved((await e.simulator.simulate(request))!), [[OG, ALICE.toLowerCase(), 100n], [ALICE.toLowerCase(), ROUTER, 101n]]);
  // A node that refuses the reads' block outright, its calls left less than 21,000 each ("intrinsic gas too low",
  // as BNB Chain's did for a batch's 3,897): the lean pass all the same.
  const refusing = node(500_000n, 400_000n), inner = refusing.simulator['post'].bind(refusing.simulator);
  let posts = 0;
  (refusing.simulator as unknown as { post: typeof inner }).post = async (...args: Parameters<typeof inner>) => (++posts === 2 ? { error: { code: -32000, message: 'intrinsic gas too low' } } : inner(...args));
  assert.deepEqual(moved((await refusing.simulator.simulate(request))!), [[ALICE.toLowerCase(), ROUTER, 1_000n]]);
  // Where the lean pass doesn't come out as the first run did (here: the swap can't run on what it is given), the
  // events stand.
  const c = node(1_100_000n, 600_000n);
  assert.deepEqual(moved((await c.simulator.simulate(request))!), [[OG, ALICE.toLowerCase(), 100n], [ALICE.toLowerCase(), ROUTER, 101n]]);
});

test('A request not pinned to a block has its balances read on the state its run had, not on a later latest', async () => {
  // On Base (five blocks a second) the latest block of the next request is often another. eth_simulateV1 says which
  // block it simulated: the read pass is asked on that block's parent.
  const tags: unknown[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    tags.push(body.params[1]);
    const calls = body.params[0].blockStateCalls[0].calls as { data: string }[];
    return new Response(JSON.stringify({ result: [{ number: '0x65', calls: calls.map(c => ({ status: '0x1', gasUsed: '0x5208', returnData: c.data.startsWith('0x70a08231') ? data(0n) : '0x', logs: [] })) }] }));
  }) as typeof fetch;
  await new RpcSimulator({ 8453: 'http://rpc.invalid' }, { fetchImpl }).simulate({ chainId: 8453, from: ALICE, to: USDC, data: '0xdeadbeef', value: 0n });
  assert.deepEqual(tags, ['latest', '0x64']);
  // A request pinned to a block keeps its block.
  tags.length = 0;
  const header = { number: 100n, timestamp: 5n, coinbase: BOB, gasLimit: 30_000_000n, baseFeePerGas: 2n, prevRandao: `0x${'00'.repeat(32)}` as `0x${string}` };
  await new RpcSimulator({ 8453: 'http://rpc.invalid' }, { fetchImpl }).simulate({ chainId: 8453, from: ALICE, to: USDC, data: '0xdeadbeef', value: 0n, at: { block: '0x63', header } });
  assert.deepEqual(tags, ['0x63', '0x63']);
});

test('Demo sample: a router call that buys an NFT and sets a Permit2 allowance along the way', async () => {
  const { sample } = await import('./helpers.ts');
  const p = await sample('eth-nft-buy');
  assert.deepEqual(p.assetChanges.map(c => [c.direction, c.amount, c.symbol]), [['out', '1,500', 'USDC'], ['in', '1', 'NFT 0x4e47…0721 #4242']]);
  assert.deepEqual(p.approvals?.map(a => [a.kind, a.allowance, a.direct]), [['permit2', 'unlimited', false]]);
  assert.match(p.warnings.find(x => x.code === 'hidden_unlimited_approval')!.message, /through Permit2 until 2027-01-01/);
});

test('A wrap and an unwrap of the chain’s wrapped native token are transfers; another contract’s same-shaped Deposit is not', async () => {
  const { parseLogs } = await import('../src/simulation.ts');
  const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', VAULT = '0x1111111111111111111111111111111111111111';
  const account = '0x67c64820762477c4b289ff555e613431ff1e9e32', pool = '0x0729e2a471000000000000000000000000000000';
  const word = (v: bigint | string) => `0x${(typeof v === 'bigint' ? v.toString(16) : v.slice(2)).padStart(64, '0')}`;
  const DEPOSIT = '0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c', WITHDRAWAL = '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65', TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const amount = 6_000_000_000_000_000n;
  // A UserOperation on BNB Chain wrapping 0.006 BNB and passing the WBNB on: the account's WBNB nets to zero.
  const { transfers } = parseLogs([
    { address: WBNB, topics: [DEPOSIT, word(account)], data: word(amount) },
    { address: WBNB, topics: [TRANSFER, word(account), word(pool)], data: word(amount) },
    { address: WETH, topics: [WITHDRAWAL, word(account)], data: word(5n) },
    { address: VAULT, topics: [DEPOSIT, word(account)], data: word(99n) },
  ]);
  const net = (asset: string) => transfers.filter(t => t.asset === asset).reduce((s, t) => s + (t.to === account ? t.raw : 0n) - (t.from === account ? t.raw : 0n), 0n);
  assert.equal(net(WBNB), 0n);
  assert.equal(net(WETH), -5n);
  assert.ok(!transfers.some(t => t.asset === VAULT), 'a vault’s Deposit(address,uint256) is not a mint of its own token');
});

test('A token the transaction itself creates: no name to read, and a note that it can land at another address', async () => {
  const NEW = '0xc9fa96c17f208acd4be3e5c28d939be85e4e8da8', OLD = '0x10be2b470410f83c4ff6b0c1b7c699dc8b963464';
  // The chain has code at OLD (a token that answers nothing about itself) and none at NEW.
  const rpc = { has: () => true, call: async (_c: number, method: string, params: unknown[]) => method === 'eth_getCode' ? ((params[0] as string).toLowerCase() === OLD ? '0x6000' : '0x') : (() => { throw new Error('no such read'); })() };
  const withRpc = (simulator: Simulator): Dependencies => ({ ...deps(simulator), rpc: rpc as unknown as Dependencies['rpc'] });
  const p = await previewRequest(send(ROUTER), { now: NOW }, withRpc(fixed({ transfers: [{ asset: NEW, from: ROUTER, to: ALICE, raw: 10n ** 25n }], nftTransfers: [] })));
  assert.deepEqual(p.assetChanges.map(c => [c.direction, c.raw, c.symbol]), [['in', (10n ** 25n).toString(), NEW]]);
  assert.match(p.warnings.find(w => w.code === 'token_created_here')?.message ?? '', /doesn't exist yet.*another address/);
  // A token that exists but can't be named, and one going out, get no such note.
  const q = await previewRequest(send(ROUTER), { now: NOW }, withRpc(fixed({ transfers: [{ asset: OLD, from: ROUTER, to: ALICE, raw: 5n }, { asset: NEW, from: ALICE, to: ROUTER, raw: 5n }], nftTransfers: [] })));
  assert.ok(!codes(q).includes('token_created_here'), codes(q).join(','));
});
