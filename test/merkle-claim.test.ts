// Claims from Merkle distributors: Uniswap's single-token one, and one of several lists whose amounts are running
// totals, which take the same call and mean different things by it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeAbiParameters, encodeAbiParameters, toFunctionSelector, type Hex } from 'viem';
import { previewRequest } from '../src/preview.ts';
import { StaticTokenRegistry } from '../src/chains.ts';
import { readsAt } from '../src/evm/common.ts';
import type { Dependencies } from '../src/types.ts';
import { codes, detail, NOW } from './helpers.ts';

// A mined claim (Ethereum, 2026-11-23) on the distributor of several trees at 0x99de…5302.
const MINED = (JSON.parse(readFileSync(new URL('./fixtures/merkle-claim.json', import.meta.url), 'utf8')) as { cumulative: { from: string; to: string; input: Hex } }).cumulative;
const ARGS = [{ type: 'uint256' }, { type: 'address' }, { type: 'uint256' }, { type: 'bytes32[]' }] as const;
const DISTRIBUTOR = '0x090d4613473dee047c3f2706764f49e0821d256e', USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', ALICE = '0x00000000000000000000000000000000000a11ce', BOB = '0xb0b0000000000000000000000000000000000002';
const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const claim = (first: bigint, account: string, amount: bigint) => `0x2e7ba6ef${encodeAbiParameters(ARGS, [first, account as Hex, amount, [`0x${'ab'.repeat(32)}`, `0x${'cd'.repeat(32)}`]]).slice(2)}` as Hex;
const w = (v: bigint | string) => (typeof v === 'bigint' ? v.toString(16) : v.slice(2)).padStart(64, '0');
const S = { token: toFunctionSelector('token()'), isClaimed: toFunctionSelector('isClaimed(uint256)'), trees: toFunctionSelector('trees(uint256)'), claimed: toFunctionSelector('claimed(uint256,address)'), native: toFunctionSelector('NATIVE_TOKEN()') };
const revert = () => { throw Object.assign(new Error('eth_call: execution reverted'), { rpcError: { message: 'execution reverted' } }); };
/** A chain whose distributor answers these calls (by selector), and reverts the rest; the blocks it was asked at. */
const chain = (answers: Record<string, string>) => {
  const blocks: unknown[] = [];
  const d: Dependencies = { tokens: new StaticTokenRegistry(), rpc: { has: () => true, call: async (_c: number, m: string, p: unknown[]) => {
    if (m !== 'eth_call') return '0x';
    blocks.push(p[1]);
    const answer = answers[(p[0] as { data: string }).data.slice(0, 10)];
    return answer ?? revert();
  } } };
  return { d, blocks };
};
const send = (data: Hex, d: Dependencies, o: { from?: string; to?: string; value?: string } = {}) => previewRequest({ method: 'eth_sendTransaction', params: [{ from: o.from ?? ALICE, to: o.to ?? DISTRIBUTOR, data, value: o.value ?? '0x0', chainId: '0x1' }] }, { now: NOW }, d);

test('A claim from a single-token Merkle distributor: the token it pays, to whom, and whether it is made already', async () => {
  // It was a call that couldn't be decoded. The token is the distributor's to say, and whether the index is claimed.
  const uniswap = (claimedAlready = false) => chain({ [S.token]: `0x${w(USDC)}`, [S.isClaimed]: `0x${w(claimedAlready ? 1n : 0n)}` });
  const { d, blocks } = uniswap();
  const p = await send(claim(42n, ALICE, 150_000_000n), d);
  assert.deepEqual([p.title, p.decoding.decoder, p.decoding.status, p.attention], ['Claim 150 USDC from a Merkle distributor', 'merkle_claim', 'full', 'none']);
  assert.deepEqual([detail(p, 'Claim index'), detail(p, 'Paid to'), detail(p, 'Token')], ['42', `you (${ALICE})`, `USDC (${USDC})`]);
  assert.deepEqual(p.assetChanges.map(c => [c.direction, c.amount, c.symbol, c.basis]), [['in', '150', 'USDC', 'requested']]);
  assert.ok(blocks.length > 0 && blocks.every(b => b === 'latest'));
  // Made already: it pays once, and reverts.
  const again = await send(claim(42n, ALICE, 150_000_000n), uniswap(true).d);
  assert.deepEqual([again.attention, codes(again), again.assetChanges.length], ['caution', ['claim_already_made'], 0]);
  // Another account's claim is paid to that account, whoever sends it.
  const theirs = await send(claim(42n, BOB, 150_000_000n), d);
  assert.deepEqual([theirs.title, codes(theirs), theirs.assetChanges.length], ['Claim 150 USDC for 0xb0b0…0002 from a Merkle distributor', ['recipient_not_sender'], 0]);
  assert.equal(theirs.warnings[0].severity, 'info');
  // A claim takes no coin: one that sends some isn't a distributor paying out.
  assert.deepEqual(codes(await send(claim(42n, ALICE, 150_000_000n), d, { value: '0x2386f26fc10000' })), ['claim_sends_coin']);
  // Bytes after the call, or a call that isn't one, are not read as a claim.
  assert.notEqual((await send(`${claim(42n, ALICE, 1n)}00` as Hex, d)).decoding.decoder, 'merkle_claim');
});

test('A distributor of several lists pays a running total less what was claimed: the claim is titled for what it pays', async () => {
  // The same call, another meaning: read as the first, a second claim of a total of 250 was "Claim 250".
  const trees = (o: { had?: bigint; token?: string; paused?: boolean } = {}) => chain({ [S.trees]: `0x${w(o.token ?? USDC)}${w(o.paused ? 1n : 0n)}${'11'.repeat(32)}`, [S.claimed]: `0x${w(o.had ?? 0n)}`, [S.native]: `0x${w(NATIVE)}` });
  const p = await send(claim(3n, ALICE, 250_000_000n), trees({ had: 140_000_000n }).d);
  assert.deepEqual([p.title, p.decoding.status, p.attention], ['Claim 110 USDC from a distributor', 'full', 'none']);
  assert.deepEqual([detail(p, 'List'), detail(p, 'Total claimable'), detail(p, 'Claimed before'), detail(p, 'Pays now')], ['tree 3', '250 USDC', '140 USDC', '110 USDC']);
  assert.deepEqual(p.assetChanges.map(c => [c.direction, c.amount, c.symbol]), [['in', '110', 'USDC']]);
  // Nothing new since the last claim; a tree that is paused; one the distributor doesn't have.
  const none = await send(claim(3n, ALICE, 250_000_000n), trees({ had: 250_000_000n }).d);
  assert.deepEqual([none.title, codes(none), none.assetChanges.length], ['Claim from a distributor: nothing left to pay', ['claim_already_made'], 0]);
  assert.match(none.warnings[0].message, /^You have already claimed 250 USDC of tree 3, and this claim's total is 250 USDC: nothing is left to pay, and it reverts\.$/);
  assert.deepEqual(codes(await send(claim(3n, ALICE, 250_000_000n), trees({ paused: true }).d)), ['claim_paused']);
  assert.deepEqual(codes(await send(claim(9n, ALICE, 250_000_000n), trees({ token: `0x${'00'.repeat(20)}` }).d)), ['claim_no_such_list']);
  // A tree that pays the chain's coin.
  const coin = await send(claim(1n, ALICE, 5n * 10n ** 17n), trees({ token: NATIVE }).d);
  assert.deepEqual([coin.title, coin.assetChanges.map(c => [c.asset, c.amount, c.symbol])], ['Claim 0.5 ETH from a distributor', [['native', '0.5', 'ETH']]]);
  // A mined claim on that distributor: its calldata is this call, and the account's first claim is all of its total.
  const [treeId, account, total] = decodeAbiParameters(ARGS, `0x${MINED.input.slice(10)}`);
  const mined = await send(MINED.input, trees().d, { from: MINED.from, to: MINED.to });
  assert.deepEqual([treeId, account.toLowerCase(), mined.decoding.decoder, mined.decoding.status], [3n, MINED.from, 'merkle_claim', 'full']);
  assert.equal(detail(mined, 'Pays now'), '144,469,717,998,634.291036 USDC');
  assert.equal(total, 144469717998634291036n);
});

test('A contract that answers as neither distributor, or a chain that doesn’t answer, leaves the claim unread and says so', async () => {
  const neither = await send(claim(3n, ALICE, 250n), chain({}).d);
  assert.deepEqual([neither.title, neither.decoding.status, neither.attention, codes(neither)], ['Claim from a distributor (0x090d…256e)', 'partial', 'caution', ['claim_unread']]);
  assert.match(neither.warnings[0].message, /^The contract answers neither as a single-token Merkle distributor nor as one of several lists/);
  assert.match((await send(claim(3n, ALICE, 250n), { tokens: new StaticTokenRegistry() })).warnings[0].message, /wasn't read \(no RPC for this chain\)\.$/);
  const down: Dependencies = { tokens: new StaticTokenRegistry(), rpc: { has: () => true, call: async () => { throw Object.assign(new Error('eth_call: missing trie node'), { rpcError: { message: 'missing trie node' } }); } } };
  assert.match((await send(claim(3n, ALICE, 250n), down)).warnings[0].message, /wasn't read \(the chain's node didn't answer for that state\)\.$/);
  // A replayed claim is read on the block before its own: on the latest state, what it had claimed already was itself.
  assert.equal(readsAt({ deps: {}, context: {} } as never), 'latest');
  assert.equal(readsAt({ deps: {}, context: { replay: { at: { block: '0x1940a2f' } } } } as never), '0x1940a2f');
});
