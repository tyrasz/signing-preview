// Every HyperCore L1 action type and variant in @nktkas/hyperliquid 0.33.3 decodes to a recognised preview.
// Hash vectors in fixtures/l1-action-hashes-v3.json come from hyperliquid-python-sdk 0.24.0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { l1ActionHash } from '../src/hyperliquid/action-hash.ts';
import { previewRequest } from '../src/preview.ts';
import { ALICE, BOB } from '../mocks/data.ts';
import type { Preview } from '../src/types.ts';
import { codes, mockDeps, NOW } from './helpers.ts';

const ZERO = '0x0000000000000000000000000000000000000000';
const VAULT = '0xdfc24b077bc1425ad1dea75bcb6f8158e10df303';

async function l1(action: Record<string, unknown>): Promise<Preview> {
  const nonce = NOW - 1000;
  const typed = {
    domain: { name: 'Exchange', version: '1', chainId: 1337, verifyingContract: ZERO },
    types: { Agent: [{ name: 'source', type: 'string' }, { name: 'connectionId', type: 'bytes32' }] },
    primaryType: 'Agent', message: { source: 'a', connectionId: l1ActionHash(action, nonce) },
  };
  return previewRequest({ method: 'eth_signTypedData_v4', params: [ALICE, JSON.stringify(typed)] }, { now: NOW, hyperliquid: { action, nonce } }, mockDeps());
}

/** All 42 L1 action types in @nktkas/hyperliquid 0.33.3 (exchange methods without an EIP-712 user-signed type). */
const SDK_L1_TYPES = ['activateOutcomeDeployer', 'agentEnableDexAbstraction', 'agentSendAsset', 'agentSetAbstraction', 'authorizeAqav2Role', 'batchModify', 'borrowLend',
  'CSignerAction', 'CValidatorAction', 'cancel', 'cancelByCloid', 'claimRewards', 'createSubAccount', 'createVault', 'evmUserModify', 'finalizeEvmContract', 'gossipPriorityBid',
  'hip3LiquidatorTransfer', 'modify', 'noop', 'order', 'perpDeploy', 'registerReferrer', 'reserveRequestWeight', 'scheduleCancel', 'setDisplayName', 'setReferrer', 'spotDeploy',
  'spotUser', 'subAccountModify', 'subAccountSpotTransfer', 'subAccountTransfer', 'topUpIsolatedOnlyMargin', 'twapCancel', 'twapOrder', 'updateIsolatedMargin', 'updateLeverage',
  'userOutcome', 'validatorL1Stream', 'vaultDistribute', 'vaultModify', 'vaultTransfer'];

const order = { a: 0, b: true, p: '97500', s: '0.01', r: false, t: { limit: { tif: 'Gtc' } } };
const kv = [['underlying', 'BTC'], ['targetPrice', '100000']];

/** [action, expected title] for every type and every union variant. */
const ALL: [Record<string, unknown>, string][] = [
  // Trading
  [{ type: 'order', orders: [order], grouping: 'na' }, 'Long 0.01 BTC-PERP @ 97,500'],
  [{ type: 'modify', oid: 1, order }, 'Modify order: Long 0.01 BTC-PERP @ 97,500'],
  [{ type: 'batchModify', modifies: [{ oid: 1, order }] }, 'Modify order: Long 0.01 BTC-PERP @ 97,500'],
  [{ type: 'cancel', cancels: [{ a: 0, o: 1 }] }, 'Cancel 1 order'],
  [{ type: 'cancelByCloid', cancels: [{ asset: 0, cloid: '0x' + '00'.repeat(15) + '01' }] }, 'Cancel 1 order'],
  [{ type: 'scheduleCancel', time: NOW + 60_000 }, 'Schedule cancel-all'],
  [{ type: 'twapOrder', twap: { a: 0, b: true, s: '1', r: false, m: 30, t: false } }, 'TWAP buy 1 BTC-PERP over 30 minutes'],
  [{ type: 'twapCancel', a: 0, t: 5 }, 'Cancel TWAP on BTC-PERP'],
  [{ type: 'updateLeverage', asset: 0, isCross: true, leverage: 5 }, 'Set BTC-PERP leverage to 5× (cross)'],
  [{ type: 'updateIsolatedMargin', asset: 0, isBuy: true, ntli: 1_000_000 }, 'Add isolated margin on BTC-PERP'],
  [{ type: 'topUpIsolatedOnlyMargin', asset: 0, leverage: '3' }, 'Top up BTC-PERP isolated margin to 3× leverage'],
  // Transfers, accounts and vaults
  [{ type: 'vaultTransfer', vaultAddress: VAULT, isDeposit: true, usd: 10_000_000 }, 'Deposit 10 USDC into vault 0xdfc2…f303'],
  [{ type: 'subAccountTransfer', subAccountUser: BOB, isDeposit: true, usd: 1_000_000 }, 'Move 1 USDC to sub-account 0xb0b0…0002'],
  [{ type: 'subAccountSpotTransfer', subAccountUser: BOB, isDeposit: false, token: 'USDC', amount: '2' }, 'Withdraw 2 USDC from sub-account 0xb0b0…0002'],
  [{ type: 'createSubAccount', name: 'bot' }, 'Create sub-account "bot"'],
  [{ type: 'subAccountModify', subAccountUser: BOB, name: 'bot2' }, 'Rename sub-account 0xb0b0…0002 to "bot2"'],
  [{ type: 'createVault', name: 'Alpha', description: 'A test vault', initialUsd: 100_000_000, nonce: NOW - 1000 }, 'Create vault "Alpha" with 100 USDC'],
  [{ type: 'vaultModify', vaultAddress: VAULT, allowDeposits: false, alwaysCloseOnWithdraw: true }, 'Change settings of vault 0xdfc2…f303'],
  [{ type: 'vaultDistribute', vaultAddress: VAULT, usd: 0 }, 'Close vault 0xdfc2…f303'],
  [{ type: 'borrowLend', operation: 'repay', token: 0, amount: '5' }, 'Repay 5 USDC to HyperCore lending'],
  [{ type: 'claimRewards' }, 'Claim referral rewards'],
  [{ type: 'setReferrer', code: 'FRIEND' }, 'Use referral code FRIEND'],
  [{ type: 'registerReferrer', code: 'ALICE' }, 'Create referral code ALICE'],
  [{ type: 'setDisplayName', displayName: 'alice' }, 'Set leaderboard name to "alice"'],
  [{ type: 'spotUser', toggleSpotDusting: { optOut: false } }, 'Opt in to spot dusting'],
  [{ type: 'evmUserModify', usingBigBlocks: false }, 'Use small HyperEVM blocks'],
  [{ type: 'noop' }, 'Hyperliquid no-op'],
  // Agent-wallet actions
  [{ type: 'agentSendAsset', destination: BOB, sourceDex: '', destinationDex: 'spot', token: 'USDC:0x6d1e7cde53ba9467b783cb7c530ce054', amount: '25', fromSubAccount: '', nonce: NOW - 1000 }, 'Send 25 USDC to 0xb0b0…0002 (agent)'],
  [{ type: 'agentSetAbstraction', abstraction: 'u' }, 'Set account mode to unified account (agent)'],
  [{ type: 'agentEnableDexAbstraction' }, 'Enable HIP-3 DEX abstraction (agent)'],
  // Outcome shares (HIP-4)
  [{ type: 'userOutcome', splitOutcome: { outcome: 23205, amount: '10' } }, 'Split 10 USDC into Yes and No shares of SOL above 94.882 at 2026-11-03 06:00'],
  [{ type: 'userOutcome', mergeOutcome: { outcome: 23205, amount: null } }, 'Merge the maximum available Yes + No shares of SOL above 94.882 at 2026-11-03 06:00'],
  [{ type: 'userOutcome', mergeQuestion: { question: 563, amount: '1' } }, 'Merge 1 Yes shares across question #563'],
  [{ type: 'userOutcome', negateOutcome: { question: 563, outcome: 22153, amount: '3' } }, 'Convert 3 No shares of Sports Contest Result (Atletico Madrid vs FC Bayern Munich; 2026-11-03 20:00) · Atletico Madrid into Yes shares of the other outcomes'],
  // Staking, validators and network
  [{ type: 'CSignerAction', jailSelf: null }, 'Jail validator signer (self)'],
  [{ type: 'CSignerAction', unjailSelf: null }, 'Unjail validator signer (self)'],
  [{ type: 'CValidatorAction', register: { profile: { node_ip: { Ip: '1.2.3.4' }, name: 'val', description: 'a validator', delegations_disabled: false, commission_bps: 500, signer: BOB }, unjailed: true, initial_wei: 10_000_000_000_000 } }, 'Register validator "val"'],
  [{ type: 'CValidatorAction', changeProfile: { node_ip: null, name: null, description: null, unjailed: true, disable_delegations: null, commission_bps: null, signer: BOB } }, 'Change validator profile'],
  [{ type: 'CValidatorAction', unregister: null }, 'Unregister validator'],
  [{ type: 'validatorL1Stream', riskFreeRate: '0.07' }, 'Validator vote: risk-free rate 7%'],
  [{ type: 'gossipPriorityBid', slotId: 1, ip: '::1', maxGas: 10_000_000 }, 'Bid up to 0.1 HYPE for priority data (slot 1)'],
  [{ type: 'reserveRequestWeight', weight: 50, destination: BOB }, 'Reserve 50 extra API request weight for 0xb0b0…0002'],
  [{ type: 'activateOutcomeDeployer', isDeactivate: true }, 'Deactivate as outcome market deployer'],
  [{ type: 'authorizeAqav2Role', token: 0, role: 'technical' }, 'Authorise AQAv2 technical role for USDC (#0)'],
  [{ type: 'hip3LiquidatorTransfer', dex: 'xyz', ntl: 1_000_000_000, isDeposit: false }, 'Withdraw 1,000 quote tokens from the xyz backstop liquidator'],
  [{ type: 'finalizeEvmContract', token: 1, input: 'customStorageSlot' }, 'Finalize HyperEVM contract link for PURR (#1)'],
  // HIP-3 perp deployer: all 16 variants
  [{ type: 'perpDeploy', registerAsset: { maxGas: 100_000_000, assetRequest: { coin: 'xyz:NVDA', szDecimals: 2, oraclePx: '180', marginTableId: 10, onlyIsolated: false }, dex: 'xyz', schema: null } }, 'Deploy perp xyz:NVDA on DEX xyz'],
  [{ type: 'perpDeploy', registerAsset2: { maxGas: null, assetRequest: { coin: 'abc:X', szDecimals: 2, oraclePx: '1', marginTableId: 1, marginMode: 'strictIsolated' }, dex: 'abc', schema: { fullName: 'ABC', collateralToken: 0, oracleUpdater: null } } }, 'Deploy perp abc:X on DEX abc (new DEX)'],
  [{ type: 'perpDeploy', setOracle: { dex: 'xyz', oraclePxs: [['xyz:TSLA', '300']], markPxs: [], externalPerpPxs: [] } }, 'Update oracle prices for 1 asset on xyz'],
  [{ type: 'perpDeploy', setFundingMultipliers: [['xyz:TSLA', '1.5']] }, 'Set funding multiplier for 1 asset'],
  [{ type: 'perpDeploy', setFundingInterestRates: [['xyz:TSLA', '-0.0001'], ['xyz:GOLD', '0']] }, 'Set funding interest rate (8h) for 2 assets'],
  [{ type: 'perpDeploy', haltTrading: { coin: 'xyz:TSLA', isHalted: false } }, 'Resume trading in xyz:TSLA'],
  [{ type: 'perpDeploy', setMarginTableIds: [['xyz:TSLA', 20]] }, 'Set margin table for 1 asset'],
  [{ type: 'perpDeploy', insertMarginTable: { dex: 'xyz', marginTable: { description: 'tiered', marginTiers: [{ lowerBound: 0, maxLeverage: 20 }, { lowerBound: 1_000_000, maxLeverage: 10 }] } } }, 'Add margin table "tiered" to xyz'],
  [{ type: 'perpDeploy', setFeeRecipient: { dex: 'xyz', feeRecipient: BOB } }, 'Send xyz deployer fees to 0xb0b0…0002'],
  [{ type: 'perpDeploy', setOpenInterestCaps: [['xyz:TSLA', 5_000_000]] }, 'Set open-interest cap for 1 asset'],
  [{ type: 'perpDeploy', setSubDeployers: { dex: 'xyz', subDeployers: [{ variant: 'setOracle', user: BOB, allowed: true }] } }, 'Change sub-deployer permissions on xyz (1)'],
  [{ type: 'perpDeploy', setMarginModes: [['xyz:TSLA', 'noCross']] }, 'Set margin mode for 1 asset'],
  [{ type: 'perpDeploy', setFeeScale: { dex: 'xyz', scale: '1.5' } }, 'Set xyz fee scale to 1.5'],
  [{ type: 'perpDeploy', setGrowthModes: [['xyz:TSLA', true]] }, 'Set growth mode for 1 asset'],
  [{ type: 'perpDeploy', setPerpAnnotation: { coin: 'xyz:TSLA', category: 'stocks', description: 'Tesla', displayName: 'TSLA', keywords: ['tesla'] } }, 'Annotate xyz:TSLA'],
  [{ type: 'perpDeploy', disableDex: 'xyz' }, 'Disable perp DEX xyz'],
  // HIP-1/2 spot deployer: all 9 variants, plus the 4 HIP-4 outcome-deployer variants
  [{ type: 'spotDeploy', registerToken2: { spec: { name: 'NEW', szDecimals: 2, weiDecimals: 8 }, maxGas: 1_000_000, fullName: 'New Token' } }, 'Register spot token NEW'],
  [{ type: 'spotDeploy', userGenesis: { token: 1, userAndWei: [[ALICE, '100'], [BOB, '50']], existingTokenAndWei: [], blacklistUsers: [] } }, 'Set genesis allocations for PURR (#1) (2 accounts)'],
  [{ type: 'spotDeploy', genesis: { token: 1, maxSupply: '1000000' } }, 'Run genesis for PURR (#1)'],
  [{ type: 'spotDeploy', registerSpot: { tokens: [1, 0] } }, 'Register spot pair PURR (#1) / USDC (#0)'],
  [{ type: 'spotDeploy', registerHyperliquidity: { spot: 0, startPx: '0.1', orderSz: '100', nOrders: 10 } }, 'Set up Hyperliquidity for spot pair #0'],
  [{ type: 'spotDeploy', setDeployerTradingFeeShare: { token: 1, share: '50%' } }, 'Set deployer fee share for PURR (#1) to 50%'],
  [{ type: 'spotDeploy', enableQuoteToken: { token: 1 } }, 'Enable PURR (#1) as a quote token'],
  [{ type: 'spotDeploy', disableQuoteToken: { token: 1 } }, 'Disable PURR (#1) as a quote token'],
  [{ type: 'spotDeploy', requestEvmContract: { token: 1, address: '0x9b498c3c8a0b8cd8ba1d9851d40d186f1872b44e', evmExtraWeiDecimals: 13 } }, 'Request HyperEVM contract link for PURR (#1)'],
  [{ type: 'spotDeploy', outcome: { registerStandaloneOutcomeFromTemplate: { id: 'priceBinary', keywordToValue: kv } } }, 'Deploy outcome market from template priceBinary'],
  [{ type: 'spotDeploy', outcome: { registerQuestionFromTemplate: { questionTemplateInstance: { id: 'q', keywordToValue: kv }, namedOutcomeTemplateInstances: [{ id: 'a', keywordToValue: kv }, { id: 'b', keywordToValue: kv }] } } }, 'Deploy question with 2 outcomes (q)'],
  [{ type: 'spotDeploy', outcome: { settleOutcome: { outcome: 23205, settleFraction: '0.333', details: '', nameAndDescription: ['SOL', 'SOL above'], sideNames: ['Yes', 'No'] } } }, 'Settle outcome #23205 (Yes pays 33.3%)'],
  [{ type: 'spotDeploy', outcome: { settleQuestion2: { question: 563, outcomeSettlements: [{ outcome: 22153, settleFraction: '1', details: '', nameAndDescription: ['A', 'B'], sideNames: ['Yes', 'No'] }], nameAndDescription: ['Q', 'D'] } } }, 'Settle question #563 (1 outcome)'],
];

test('L1 hashes for agent, outcome, validator and deployer shapes match hyperliquid-python-sdk', () => {
  const vectors = JSON.parse(readFileSync(new URL('./fixtures/l1-action-hashes-v3.json', import.meta.url), 'utf8'));
  assert.equal(vectors.length, 25);
  for (const v of vectors) assert.equal(l1ActionHash(v.action, v.nonce, v.vaultAddress, v.expiresAfter), v.hash, JSON.stringify(v.action).slice(0, 60));
});

test('The table covers all 42 SDK L1 action types', () => {
  const covered = new Set(ALL.map(([a]) => a.type));
  assert.deepEqual(SDK_L1_TYPES.filter(t => !covered.has(t)), []);
  assert.equal(SDK_L1_TYPES.length, 42);
});

test('Every L1 action type and variant decodes to a recognised, fully decoded preview', async () => {
  for (const [action, title] of ALL) {
    const p = await l1(action);
    assert.equal(p.title, title);
    assert.ok(!codes(p).includes('l1_unknown_action') && !codes(p).includes('l1_hash_mismatch'), title);
    assert.equal(p.decoding.status, 'full', title);
  }
});

test('Impactful admin actions carry warnings', async () => {
  const expect: [Record<string, unknown>, string][] = [
    [{ type: 'perpDeploy', setOracle: { dex: 'xyz', oraclePxs: [['xyz:TSLA', '300']], markPxs: [], externalPerpPxs: [] } }, 'oracle_update'],
    [{ type: 'perpDeploy', haltTrading: { coin: 'xyz:TSLA', isHalted: true } }, 'halt_trading'],
    [{ type: 'perpDeploy', setFeeRecipient: { dex: 'xyz', feeRecipient: BOB } }, 'fee_recipient'],
    [{ type: 'perpDeploy', setSubDeployers: { dex: 'xyz', subDeployers: [{ variant: 'setOracle', user: BOB, allowed: true }] } }, 'grant_permission'],
    [{ type: 'perpDeploy', registerAsset: { maxGas: 100_000_000, assetRequest: { coin: 'xyz:NVDA', szDecimals: 2, oraclePx: '180', marginTableId: 10, onlyIsolated: false }, dex: 'xyz', schema: null } }, 'spends_hype'],
    [{ type: 'spotDeploy', outcome: { settleOutcome: { outcome: 23205, settleFraction: '1', details: '', nameAndDescription: ['SOL', 'x'], sideNames: ['Yes', 'No'] } } }, 'settle_outcome'],
    [{ type: 'CValidatorAction', changeProfile: { node_ip: null, name: null, description: null, unjailed: true, disable_delegations: null, commission_bps: null, signer: BOB } }, 'validator_signer_change'],
    [{ type: 'hip3LiquidatorTransfer', dex: 'xyz', ntl: 1_000_000_000, isDeposit: true }, 'backstop_liquidator'],
    [{ type: 'gossipPriorityBid', slotId: 0, ip: '1.2.3.4', maxGas: 50_000_000 }, 'spends_hype'],
    [{ type: 'agentSendAsset', destination: BOB, sourceDex: '', destinationDex: '', token: 'USDC', amount: '1', fromSubAccount: '', nonce: NOW - 1000 }, 'recipient_not_sender'],
  ];
  for (const [action, code] of expect) assert.ok(codes(await l1(action)).includes(code), `${String(action.type)}: ${code}`);
});

test('Approving an agent no longer claims agents cannot move funds', async () => {
  const typed = {
    domain: { name: 'HyperliquidSignTransaction', version: '1', chainId: 42161, verifyingContract: ZERO },
    types: { 'HyperliquidTransaction:ApproveAgent': [{ name: 'hyperliquidChain', type: 'string' }, { name: 'agentAddress', type: 'address' }, { name: 'agentName', type: 'string' }, { name: 'nonce', type: 'uint64' }] },
    primaryType: 'HyperliquidTransaction:ApproveAgent', message: { hyperliquidChain: 'Mainnet', agentAddress: BOB, agentName: 'bot', nonce: NOW },
  };
  const p = await previewRequest({ method: 'eth_signTypedData_v4', params: [ALICE, JSON.stringify(typed)] }, { now: NOW }, mockDeps());
  const msg = p.warnings.find(w => w.code === 'approve_agent')!.message;
  assert.doesNotMatch(msg, /cannot withdraw/);
  assert.match(msg, /access to your account/);
});
