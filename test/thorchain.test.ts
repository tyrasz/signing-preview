// THORChain and Maya router deposits: the memo read as the swap or deposit it asks for, and the vault checked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionData, parseAbi, type Hex } from 'viem';
import { previewRequest } from '../src/preview.ts';
import { StaticTokenRegistry } from '../src/chains.ts';
import { readMemo } from '../src/evm/thorchain.ts';
import type { Dependencies } from '../src/types.ts';
import { ALICE } from '../mocks/data.ts';
import { codes, detail, NOW } from './helpers.ts';

const ROUTER = '0xd37bbe5744d730a1d98d8dc97c42f0ca46ad7146', VAULT = '0xfc303520cd7ae3fd626ecf7efaf55e560a07246a', USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const ABI = parseAbi(['function depositWithExpiry(address vault, address asset, uint256 amount, string memo, uint256 expiration) payable']);
const ZERO = '0x0000000000000000000000000000000000000000';
const t = BigInt(NOW / 1000);
/** The vault's code and how many transactions it has sent. */
const deps = (code = '0x', sent = 5_000n): Dependencies => ({ tokens: new StaticTokenRegistry(), rpc: { has: () => true, call: async (_c: number, method: string) => {
  if (method === 'eth_getCode') return code;
  if (method === 'eth_getTransactionCount') return `0x${sent.toString(16)}`;
  throw new Error('unused');
} } });
const send = (memo: string, o: { asset?: string; amount?: bigint; value?: bigint; to?: string; vault?: string; expiry?: bigint } = {}, d = deps()) => previewRequest({ method: 'eth_sendTransaction', params: [{ from: ALICE, to: o.to ?? ROUTER, value: `0x${(o.value ?? (o.asset ? 0n : 50n * 10n ** 18n)).toString(16)}`, chainId: '0x1',
  data: encodeFunctionData({ abi: ABI, args: [(o.vault ?? VAULT) as Hex, (o.asset ?? ZERO) as Hex, o.amount ?? 0n, memo, o.expiry ?? t + 900n] }) }] }, { now: NOW }, d);

test('A swap to Bitcoin: what is sent, where the coin goes, the least it gives', async () => {
  const p = await send('=:b:bc1q57e4yn990kqllfchm6aqz3juce9dv0tl6mvl7r/0xddE44eFEd0F7d764a536FC79c28edF0d2d906b5b:138750467/1/0:-_/tan:7/125');
  assert.equal(p.decoding.decoder, 'thorchain_deposit');
  assert.equal(p.decoding.status, 'full');
  assert.equal(p.title, 'Swap 50 ETH for BTC.BTC via THORChain, to bc1q57e4…6mvl7r');
  assert.equal(detail(p, 'Destination'), 'bc1q57e4yn990kqllfchm6aqz3juce9dv0tl6mvl7r');
  assert.equal(detail(p, 'Refund address'), '0xddE44eFEd0F7d764a536FC79c28edF0d2d906b5b');
  assert.equal(detail(p, 'Minimum received'), '1.38750467 BTC');
  assert.equal(detail(p, 'Streaming'), 'every 1 block, as many sub-swaps as the network picks');
  assert.equal(detail(p, 'Affiliate fees'), '-_ 7 bps, tan 125 bps (1.32% in all)');
  assert.equal(detail(p, 'Native value attached'), undefined);
  // Affiliates past 1% are said; no limit is a caution.
  assert.ok(codes(p).includes('thorchain_affiliate_fee'));
  assert.ok(codes(await send('=:ETH.USDC:0x30960eb7ff617db38fDE0875A67b044BF39FC0D2:0')).includes('thorchain_no_limit'));
  assert.equal(p.assetChanges[0]?.raw, (50n * 10n ** 18n).toString());
});

test('Trade accounts, secured assets, liquidity, a token deposit; memos it does not read', async () => {
  const trade = await send('TRADE+:thor1fyt5eyjdra8y2za949hyux0rxk9tlg88ctdpqh', { asset: USDC, amount: 1_249_804_299n });
  assert.equal(trade.title, 'Deposit 1,249.804299 USDC into THORChain as a trade account for thor1fyt5e…ctdpqh');
  assert.equal(trade.assetChanges[0]?.symbol, 'USDC');
  assert.match((await send('SECURE+:thor1v5ykttyd0fy6ga68djecegekm4drzjcgywe3hv')).title, /as a secured asset/);
  assert.match((await send('+:ETH.ETH:thor1r2p5cqm6qu04js9zcprpuap9k0rx7d0d8ypelg:dx:0')).title, /^Add 50 ETH of liquidity to THORChain's ETH.ETH pool/);
  assert.ok(codes(await send('BOND:thor1xyz')).includes('thorchain_memo_unread'));
  // The short codes certain for each network; others are named as they are.
  assert.equal(readMemo('=:c:maya1abc:1', 'Maya').asset, 'MAYA.CACAO');
  assert.equal(readMemo('=:c:qabc:1', 'THORChain').asset, 'BCH.BCH');
  assert.equal(readMemo('=:tr:TAb1:1', 'THORChain').code, 'tr');
  assert.equal(readMemo('=<:BTC.BTC:bc1q:14300000/43200/0:tdex:0', 'THORChain').action, 'limit_swap');
});

test('A vault that is a contract or has never sent a transaction, an unknown router, an expired deposit', async () => {
  const memo = '=:b:bc1q57e4yn990kqllfchm6aqz3juce9dv0tl6mvl7r:138750467/1/0';
  assert.ok(codes(await send(memo, {}, deps('0x6080'))).includes('thorchain_vault_contract'));
  assert.ok(codes(await send(memo, {}, deps('0x', 0n))).includes('thorchain_vault_unused'));
  assert.ok(!codes(await send(memo)).some(c => c.startsWith('thorchain_vault')));
  const other = await send(memo, { to: '0x1234567890123456789012345678901234567890' });
  assert.ok(codes(other).includes('thorchain_router_unknown'));
  assert.equal(other.decoding.status, 'partial');
  assert.ok(codes(await send(memo, { expiry: t - 1n })).includes('thorchain_expired'));
  assert.ok(codes(await send(memo, { value: 0n })).includes('thorchain_nothing_sent'));
});

test('Seventh review: short codes that are Object properties, a destination that is a name, coin to an unknown router', async () => {
  assert.equal(readMemo('=:constructor:bc1q:1', 'THORChain').asset, undefined);
  assert.ok(!(await send('=:__proto__:bc1qdest:100000')).warnings.some(w => w.severity === 'danger'));
  // A destination that isn't a Bitcoin address: THORChain reads it as a name.
  assert.ok(codes(await send('=:b:bc1q57e4yn990kqllfchm6aq6mvl7r:138750467/1/0')).includes('thorchain_destination_name'));
  assert.ok(!codes(await send('=:b:bc1q57e4yn990kqllfchm6aqz3juce9dv0tl6mvl7r:138750467/1/0')).includes('thorchain_destination_name'));
  // Coin with a token deposit to a router not known: shown and cautioned.
  const odd = await send('=:b:bc1q57e4yn990kqllfchm6aqz3juce9dv0tl6mvl7r:1', { asset: USDC, amount: 1_000_000n, value: 10n ** 19n, to: '0x1234567890123456789012345678901234567890' });
  assert.equal(odd.warnings.find(w => w.code === 'thorchain_unexpected_coin')?.severity, 'caution');
  assert.ok(odd.assetChanges.some(a => a.asset === 'native'));
});
