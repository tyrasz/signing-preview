// Coverage for HyperCore actions beyond the basics. Field lists and EIP-712 types are taken from
// @nktkas/hyperliquid 0.33.3 (src/api/exchange/_methods/*); hash vectors from hyperliquid-python-sdk 0.24.0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { l1ActionHash } from '../src/hyperliquid/action-hash.ts';
import { previewRequest } from '../src/preview.ts';
import { ALICE, BOB } from '../mocks/data.ts';
import type { Preview } from '../src/types.ts';
import { codes, detail, mockDeps, NOW } from './helpers.ts';

const ZERO = '0x0000000000000000000000000000000000000000';
const VAULT = '0xdfc24b077bc1425ad1dea75bcb6f8158e10df303';

async function l1(action: Record<string, unknown>, signer = ALICE): Promise<Preview> {
  const nonce = NOW - 1000;
  const typed = {
    domain: { name: 'Exchange', version: '1', chainId: 1337, verifyingContract: ZERO },
    types: { Agent: [{ name: 'source', type: 'string' }, { name: 'connectionId', type: 'bytes32' }] },
    primaryType: 'Agent', message: { source: 'a', connectionId: l1ActionHash(action, nonce) },
  };
  return previewRequest({ method: 'eth_signTypedData_v4', params: [signer, JSON.stringify(typed)] }, { now: NOW, hyperliquid: { action, nonce } }, mockDeps());
}

// EIP-712 field lists exactly as defined by the SDK.
const SDK_TYPES: Record<string, [string, string][]> = {
  SendToEvmWithData: [['hyperliquidChain', 'string'], ['token', 'string'], ['amount', 'string'], ['sourceDex', 'string'], ['destinationRecipient', 'string'], ['addressEncoding', 'string'], ['destinationChainId', 'uint32'], ['gasLimit', 'uint64'], ['data', 'bytes'], ['nonce', 'uint64']],
  UserSetAbstraction: [['hyperliquidChain', 'string'], ['user', 'address'], ['abstraction', 'string'], ['nonce', 'uint64']],
  UserDexAbstraction: [['hyperliquidChain', 'string'], ['user', 'address'], ['enabled', 'bool'], ['nonce', 'uint64']],
  UserPortfolioMargin: [['hyperliquidChain', 'string'], ['user', 'address'], ['enabled', 'bool'], ['nonce', 'uint64']],
  LinkStakingUser: [['hyperliquidChain', 'string'], ['user', 'address'], ['isFinalize', 'bool'], ['nonce', 'uint64']],
  StakingLinkDisableTradingUser: [['hyperliquidChain', 'string'], ['tradingUser', 'address'], ['nonce', 'uint64']],
};

function userSigned(primary: keyof typeof SDK_TYPES, message: Record<string, unknown>) {
  const typed = {
    domain: { name: 'HyperliquidSignTransaction', version: '1', chainId: 42161, verifyingContract: ZERO },
    types: { [`HyperliquidTransaction:${primary}`]: SDK_TYPES[primary].map(([name, type]) => ({ name, type })) },
    primaryType: `HyperliquidTransaction:${primary}`,
    message: { hyperliquidChain: 'Mainnet', ...message },
  };
  return previewRequest({ method: 'eth_signTypedData_v4', params: [ALICE, JSON.stringify(typed)] }, { now: NOW }, mockDeps());
}

test('L1 hashes for the new action shapes match hyperliquid-python-sdk (null, nested and HIP-3/outcome IDs)', () => {
  const vectors = JSON.parse(readFileSync(new URL('./fixtures/l1-action-hashes-v2.json', import.meta.url), 'utf8'));
  assert.equal(vectors.length, 15);
  for (const v of vectors) assert.equal(l1ActionHash(v.action, v.nonce, v.vaultAddress, v.expiresAfter), v.hash, v.action.type);
});

test('HIP-3 (builder-deployed) perp orders are named, priced and margin-checked on their own DEX', async () => {
  const p = await l1({ type: 'order', orders: [{ a: 110000, b: true, p: '300', s: '1', r: false, t: { limit: { tif: 'Gtc' } } }], grouping: 'na' });
  assert.equal(p.title, 'Long 1 xyz:TSLA-PERP @ 300');
  assert.equal(p.decoding.status, 'full');
  assert.equal(detail(p, 'Perp DEX'), 'XYZ (builder-deployed, HIP-3)');
  assert.equal(detail(p, 'Current mid price'), '300');
  assert.equal(detail(p, 'Available margin on XYZ'), '$100.00');
  assert.equal(detail(p, 'Margin required at max leverage (approx.)'), '$15.00 at 20×');
  assert.ok(codes(p).includes('hip3_market'));
  const big = await l1({ type: 'order', orders: [{ a: 110000, b: true, p: '300', s: '10', r: false, t: { limit: { tif: 'Gtc' } } }], grouping: 'na' });
  const w = big.warnings.find(x => x.code === 'insufficient_margin');
  assert.equal(w?.severity, 'info', 'HIP-3 DEX abstraction may fund it, so this is informational');
  const lev = await l1({ type: 'updateLeverage', asset: 110001, isCross: false, leverage: 30 });
  assert.ok(codes(lev).includes('leverage_above_max'), 'xyz:GOLD max leverage is 25×');
});

test('Outcome market orders are named from their spec and priced as probabilities', async () => {
  const recurring = await l1({ type: 'order', orders: [{ a: 100232050, b: true, p: '0.55', s: '10', r: false, t: { limit: { tif: 'Gtc' } } }], grouping: 'na' });
  assert.equal(recurring.title, 'Buy 10 SOL above 94.882 at 2026-11-03 06:00: Yes @ 0.55');
  assert.equal(detail(recurring, 'Current mid price'), '0.62');
  assert.match(detail(recurring, 'Market type')!, /implied probability/);
  const sports = await l1({ type: 'order', orders: [{ a: 100221531, b: false, p: '0.6', s: '5', r: false, t: { limit: { tif: 'Gtc' } } }], grouping: 'na' });
  assert.equal(sports.title, 'Sell 5 Sports Contest Result (Atletico Madrid vs FC Bayern Munich; 2026-11-03 20:00) · Atletico Madrid: No @ 0.6');
  assert.match(detail(sports, 'Market spec')!, /participantA:Atletico Madrid\|participantB:FC Bayern Munich/);
  const missing = await l1({ type: 'order', orders: [{ a: 100999990, b: true, p: '0.5', s: '1', r: false, t: { limit: { tif: 'Gtc' } } }], grouping: 'na' });
  assert.ok(codes(missing).includes('unknown_asset'));
});

test('Spot orders check spot balances, not margin', async () => {
  // HYPE/USDC is spot pair 107 (asset 10107); Alice has 5 HYPE and 1,000 free USDC.
  const sellTooMuch = await l1({ type: 'order', orders: [{ a: 10107, b: false, p: '40', s: '6', r: false, t: { limit: { tif: 'Gtc' } } }], grouping: 'na' });
  assert.ok(codes(sellTooMuch).includes('insufficient_balance'));
  assert.ok(!codes(sellTooMuch).includes('insufficient_margin'));
  assert.equal(detail(sellTooMuch, 'Available HYPE'), '5');
  const buyOk = await l1({ type: 'order', orders: [{ a: 10107, b: true, p: '40', s: '20', r: false, t: { limit: { tif: 'Gtc' } } }], grouping: 'na' });
  assert.ok(!codes(buyOk).includes('insufficient_balance'), '20 × 40 = 800 ≤ 1,000 free USDC');
  assert.equal(detail(buyOk, 'Available USDC'), '1,000');
});

test('Unified-account users are not given per-market margin warnings', async () => {
  const p = await l1({ type: 'order', orders: [{ a: 0, b: true, p: '98000', s: '1', r: false, t: { limit: { tif: 'Gtc' } } }], grouping: 'na' }, BOB);
  assert.ok(!codes(p).includes('insufficient_margin'));
  assert.equal(detail(p, 'Account mode'), 'Unified account (collateral shared)');
});

test('New user-signed actions are decoded with the right warnings', async () => {
  const evm = await userSigned('SendToEvmWithData', { token: 'USDC', amount: '100', sourceDex: 'spot', destinationRecipient: BOB, addressEncoding: 'hex', destinationChainId: 999, gasLimit: 200000, data: '0xdeadbeef', nonce: NOW });
  assert.equal(evm.title, 'Send 100 USDC from HyperCore to HyperEVM');
  assert.deepEqual(codes(evm).sort(), ['recipient_not_sender', 'send_to_evm_with_data']);
  assert.equal(detail(evm, 'Data passed to recipient'), '4 bytes');

  const mode = await userSigned('UserSetAbstraction', { user: ALICE, abstraction: 'portfolioMargin', nonce: NOW });
  assert.equal(mode.title, 'Set account mode to portfolio margin');
  assert.ok(codes(mode).includes('shared_collateral'));
  const off = await userSigned('UserSetAbstraction', { user: ALICE, abstraction: 'disabled', nonce: NOW });
  assert.ok(!codes(off).includes('shared_collateral'));

  const dex = await userSigned('UserDexAbstraction', { user: ALICE, enabled: true, nonce: NOW });
  assert.equal(dex.title, 'Enable HIP-3 DEX abstraction');
  const pm = await userSigned('UserPortfolioMargin', { user: BOB, enabled: true, nonce: NOW });
  assert.equal(pm.title, 'Enable portfolio margin');
  assert.ok(codes(pm).includes('other_account'));

  const link = await userSigned('LinkStakingUser', { user: BOB, isFinalize: false, nonce: NOW });
  assert.equal(link.attention, 'danger');
  assert.ok(codes(link).includes('staking_link_request'));
  const finalize = await userSigned('LinkStakingUser', { user: BOB, isFinalize: true, nonce: NOW });
  assert.equal(finalize.title, 'Finalize staking link with 0xb0b0…0002');

  const disable = await userSigned('StakingLinkDisableTradingUser', { tradingUser: BOB, nonce: NOW });
  assert.equal(disable.attention, 'danger');
  assert.equal(disable.title, 'Permanently disable trading account 0xb0b0…0002');
  for (const p of [evm, mode, dex, pm, link, finalize, disable]) assert.ok(!codes(p).includes('hl_unknown_action'), p.title);
});

test('New L1 actions are decoded', async () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ type: 'borrowLend', operation: 'supply', token: 0, amount: '100.5' }, 'Supply 100.5 USDC to HyperCore lending'],
    [{ type: 'borrowLend', operation: 'withdraw', token: 0, amount: null }, 'Withdraw all USDC from HyperCore lending'],
    [{ type: 'borrowLend', operation: 'borrow', token: 150, amount: '2' }, 'Borrow 2 HYPE from HyperCore lending'],
    [{ type: 'topUpIsolatedOnlyMargin', asset: 1, leverage: '5' }, 'Top up ETH-PERP isolated margin to 5× leverage'],
    [{ type: 'subAccountSpotTransfer', subAccountUser: BOB, isDeposit: true, token: 'PURR:0xc1fb593aeffbeb02f85e0308e9956a90', amount: '10' }, 'Move 10 PURR to sub-account 0xb0b0…0002'],
    [{ type: 'claimRewards' }, 'Claim referral rewards'],
    [{ type: 'createVault', name: 'Alpha Vault', description: 'A test vault description', initialUsd: 100_000_000, nonce: NOW - 1000 }, 'Create vault "Alpha Vault" with 100 USDC'],
    [{ type: 'vaultModify', vaultAddress: VAULT, allowDeposits: true, alwaysCloseOnWithdraw: null }, 'Change settings of vault 0xdfc2…f303'],
    [{ type: 'vaultDistribute', vaultAddress: VAULT, usd: 0 }, 'Close vault 0xdfc2…f303'],
    [{ type: 'vaultDistribute', vaultAddress: VAULT, usd: 5_000_000 }, 'Distribute 5 USDC from vault 0xdfc2…f303'],
    [{ type: 'registerReferrer', code: 'ALICE' }, 'Create referral code ALICE'],
    [{ type: 'setDisplayName', displayName: 'alice' }, 'Set leaderboard name to "alice"'],
    [{ type: 'setDisplayName', displayName: '' }, 'Remove leaderboard name'],
    [{ type: 'spotUser', toggleSpotDusting: { optOut: true } }, 'Opt out of spot dusting'],
    [{ type: 'subAccountModify', subAccountUser: BOB, name: 'bot' }, 'Rename sub-account 0xb0b0…0002 to "bot"'],
    [{ type: 'evmUserModify', usingBigBlocks: true }, 'Use large HyperEVM blocks'],
  ];
  for (const [action, title] of cases) {
    const p = await l1(action);
    assert.equal(p.title, title);
    assert.ok(!codes(p).includes('l1_unknown_action') && !codes(p).includes('l1_hash_mismatch'), title);
  }
  const borrow = await l1({ type: 'borrowLend', operation: 'borrow', token: 150, amount: '2' });
  assert.ok(codes(borrow).includes('borrow'));
  const close = await l1({ type: 'vaultDistribute', vaultAddress: VAULT, usd: 0 });
  assert.ok(codes(close).includes('close_vault'));
});
