// MOCK DATA ONLY. Addresses, token IDs, prices and balances below are invented
// for demos and tests (except well-known public contract addresses).
import { encodeAbiParameters, encodeFunctionData, pad, parseAbi, parseAbiParameters, type Hex } from 'viem';
import { CCTP, CCTP_NETWORKS, HYPERLIQUID, PERMIT2, spotSystemAddress } from '../src/chains.ts';
import { l1ActionHash } from '../src/hyperliquid/action-hash.ts';
import { StaticHyperliquidInfo } from '../src/hyperliquid/info.ts';
import { MockSimulator } from '../src/simulation.ts';
import type { PreviewContext, SigningRequest, SimulationResult } from '../src/types.ts';
import type { RpcClient } from '../src/rpc.ts';
import { toFunctionSelector } from 'viem';

export const ALICE = '0xa11ce00000000000000000000000000000000001';
export const BOB = '0xb0b0000000000000000000000000000000000002';
export const AGENT = '0xa9e1700000000000000000000000000000000003';
export const BUILDER = '0xb17d000000000000000000000000000000000004';
export const SPENDER = '0x5bad000000000000000000000000000000000005';
export const ROUTER = '0x7e57000000000000000000000000000000000006';
export const POOL = '0x9001000000000000000000000000000000000007';
const MOCK_PURR_EVM = '0x9b498c3c8a0b8cd8ba1d9851d40d186f1872b44e';
const KINETIQ_SM = '0x393d0b87ed38fc779fd9611144ae649ba6082109', HYPERLEND_POOL = '0x00a89d7a5a02160f20150ebea7a2b5e4879a1a8b';
const HYPERLEND_DEBT_USDC = '0xd612513cb3b2c52abcd6d4b338374c09ada4657d', HYPEREVM_USDC = '0xb88339cb7199b77e23db6e890353e22632ba630f';
const MOCK_NFT = '0x4e47000000000000000000000000000000000721';

const ARB_USDC = CCTP.usdcByChain[42161];
const ARB_USDT = '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9';
const ETH_USDC = CCTP.usdcByChain[1];
const ETH_WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const ZERO = '0x0000000000000000000000000000000000000000';

export function mockHyperliquidInfo(): StaticHyperliquidInfo {
  return new StaticHyperliquidInfo({
    meta: { universe: [
      { name: 'BTC', szDecimals: 5, maxLeverage: 40 },
      { name: 'ETH', szDecimals: 4, maxLeverage: 25 },
      { name: 'SOL', szDecimals: 2, maxLeverage: 20 },
      { name: 'HYPE', szDecimals: 2, maxLeverage: 10 },
    ] },
    spotMeta: {
      tokens: [
        // USDC and HYPE EVM links as in live spotMeta (2026-11-03): USDC -> Circle's CoreDepositWallet, native HYPE -> none.
        { name: 'USDC', index: 0, tokenId: '0x6d1e7cde53ba9467b783cb7c530ce054', szDecimals: 8, weiDecimals: 8, evmContract: { address: '0x6b9e773128f453f5c2c60935ee2de2cbc5390a24', evm_extra_wei_decimals: -2 } },
        { name: 'PURR', index: 1, tokenId: '0xc1fb593aeffbeb02f85e0308e9956a90', szDecimals: 0, weiDecimals: 5, evmContract: { address: MOCK_PURR_EVM, evm_extra_wei_decimals: 13 } },
        { name: 'HYPE', index: 150, tokenId: '0x0d01dc56dcaaca66ad901c959b4011ec', szDecimals: 2, weiDecimals: 8, evmContract: null },
      ],
      universe: [
        { name: 'PURR/USDC', index: 0, tokens: [1, 0] },
        { name: '@107', index: 107, tokens: [150, 0] },
      ],
    },
    allMids: { BTC: '98000', ETH: '3500', SOL: '180', HYPE: '40', 'PURR/USDC': '0.2', '@107': '40', '#232050': '0.62', '#221530': '0.41' },
    // HIP-3: index 0 is the main DEX; asset IDs are 100000 + dexIndex * 10000 + index.
    perpDexs: [null, { name: 'xyz', fullName: 'XYZ' }],
    dexMeta: { xyz: { universe: [{ name: 'xyz:TSLA', szDecimals: 3, maxLeverage: 20 }, { name: 'xyz:GOLD', szDecimals: 4, maxLeverage: 25 }] } },
    dexMids: { xyz: { 'xyz:TSLA': '300', 'xyz:GOLD': '3100' } },
    // Shapes copied from live outcomeMeta (2026-11-03); asset ID = 100000000 + 10 * outcome + side.
    outcomeMeta: {
      outcomes: [
        { outcome: 23205, name: 'Recurring', description: 'class:priceBinary|underlying:SOL|expiry:20261103-0600|targetPrice:94.882|period:1d', sideSpecs: [{ name: 'Yes' }, { name: 'No' }], quoteToken: 'USDC' },
        { outcome: 22153, name: 'template:sportsContestParticipant2', description: 'participant:Atletico Madrid', sideSpecs: [{ name: 'Yes' }, { name: 'No' }], quoteToken: 'USDC' },
        { outcome: 22152, name: 'template fallback', description: 'other', sideSpecs: [{ name: 'Yes' }, { name: 'No' }], quoteToken: 'USDC' },
      ],
      questions: [
        { question: 563, name: 'template:sportsContestResult', description: 'competition:UEFA Champions League|contestType:Match|participantA:Atletico Madrid|participantB:FC Bayern Munich|scheduledStart:20261103-2000', fallbackOutcome: 22152, namedOutcomes: [22153] },
      ],
    },
    spotBalances: { [ALICE]: [{ coin: 'USDC', token: 0, total: '1200', hold: '200' }, { coin: 'HYPE', token: 150, total: '5', hold: '0' }] },
    abstraction: { [BOB]: 'unifiedAccount' },
    clearinghouse: {
      [`xyz:${ALICE}`]: { marginSummary: { accountValue: '100', totalNtlPos: '0', totalMarginUsed: '0' }, withdrawable: '100', assetPositions: [] },
      [BOB]: { marginSummary: { accountValue: '10', totalNtlPos: '0', totalMarginUsed: '0' }, withdrawable: '10', assetPositions: [] },
      [ALICE]: {
        marginSummary: { accountValue: '5000', totalNtlPos: '1750', totalMarginUsed: '175' },
        withdrawable: '3200',
        assetPositions: [{ position: { coin: 'ETH', szi: '0.5', leverage: { type: 'cross', value: 10 }, entryPx: '3400', liquidationPx: '2900' } }],
      },
    },
  });
}

const ERC20 = parseAbi(['function transfer(address to, uint256 amount)', 'function approve(address spender, uint256 amount)']);
const CCTP_ABI = parseAbi(['function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData)']);
const CCTP_EXTENSION = parseAbi([
  'struct Auth { uint256 amount; uint256 authValidAfter; uint256 authValidBefore; bytes32 authNonce; uint8 v; bytes32 r; bytes32 s; }',
  'struct Burn { uint256 amount; uint32 destinationDomain; bytes32 mintRecipient; bytes32 destinationCaller; uint256 maxFee; uint32 minFinalityThreshold; bytes hookData; }',
  'function batchDepositForBurnWithAuth(Auth _receiveWithAuthorizationData, Burn _depositForBurnData)',
]);
const CORE_WRITER = parseAbi(['function sendRawAction(bytes data)']);
const MAX = (1n << 256n) - 1n;

const domainType = [
  { name: 'name', type: 'string' }, { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' },
];

function userSigned(primary: string, fields: [string, string][], message: Record<string, unknown>) {
  return {
    domain: { name: HYPERLIQUID.userSignedDomainName, version: '1', chainId: 42161, verifyingContract: ZERO },
    types: { EIP712Domain: domainType, [`HyperliquidTransaction:${primary}`]: fields.map(([name, type]) => ({ name, type })) },
    primaryType: `HyperliquidTransaction:${primary}`,
    message: { hyperliquidChain: 'Mainnet', ...message },
  };
}

function agent(connectionId: Hex, source = 'a') {
  return {
    domain: { name: 'Exchange', version: '1', chainId: 1337, verifyingContract: ZERO },
    types: { EIP712Domain: domainType, Agent: [{ name: 'source', type: 'string' }, { name: 'connectionId', type: 'bytes32' }] },
    primaryType: 'Agent',
    message: { source, connectionId },
  };
}

function coreWriterAction(id: number, params: string, values: readonly unknown[]): Hex {
  const body = encodeAbiParameters(parseAbiParameters(params), values as never);
  const action = ('0x01' + id.toString(16).padStart(6, '0') + body.slice(2)) as Hex;
  return encodeFunctionData({ abi: CORE_WRITER, functionName: 'sendRawAction', args: [action] });
}

function cctpHook(recipient: string, dex: number): Hex {
  return ('0x' + '636374702d666f7277617264'.padEnd(48, '0') + '00000000' + '00000018' + recipient.slice(2) + dex.toString(16).padStart(8, '0')) as Hex;
}

export interface Sample {
  id: string;
  group: 'Arbitrum → Hyperliquid' | 'HyperCore' | 'HyperEVM' | 'Ethereum';
  label: string;
  /** The wallet's active chain when this request arrives. */
  chainId: number;
  request: SigningRequest;
  /** Extra context an integrator could supply (e.g. the L1 action pre-image). */
  context?: Omit<PreviewContext, 'now'>;
}

/** Sample signing requests; timestamps are relative to `now` so nonce checks behave realistically. */
export function buildSamples(now = Date.now()): Sample[] {
  const tx = (chainId: number, to: string, data: Hex, value = 0n) => ({ method: 'eth_sendTransaction', params: [{ from: ALICE, to, data, value: '0x' + value.toString(16), chainId: '0x' + chainId.toString(16) }] });
  const typed = (data: unknown) => ({ method: 'eth_signTypedData_v4', params: [ALICE, JSON.stringify(data)] });
  const order = { type: 'order', orders: [{ a: 0, b: true, p: '97500', s: '0.01', r: false, t: { limit: { tif: 'Gtc' } } }], grouping: 'na' };
  const orderNonce = now - 1000;
  const leverage = { type: 'updateLeverage', asset: 1, isCross: true, leverage: 30 };
  const hip3Order = { type: 'order', orders: [{ a: 110000, b: true, p: '300', s: '1', r: false, t: { limit: { tif: 'Gtc' } } }], grouping: 'na' };
  const outcomeOrder = { type: 'order', orders: [{ a: 100232050, b: true, p: '0.55', s: '10', r: false, t: { limit: { tif: 'Gtc' } } }], grouping: 'na' };
  const borrow = { type: 'borrowLend', operation: 'borrow', token: 150, amount: '2' };
  const agentSend = { type: 'agentSendAsset', destination: BOB, sourceDex: '', destinationDex: 'spot', token: 'USDC:0x6d1e7cde53ba9467b783cb7c530ce054', amount: '25', fromSubAccount: '', nonce: orderNonce };
  const setOracle = { type: 'perpDeploy', setOracle: { dex: 'xyz', oraclePxs: [['xyz:GOLD', '3100'], ['xyz:TSLA', '300']], markPxs: [], externalPerpPxs: [] } };
  const stopLoss = { type: 'order', orders: [{ a: 1, b: false, p: '3100', s: '0.5', r: true, t: { trigger: { isMarket: true, triggerPx: '3150', tpsl: 'sl' } } }], grouping: 'na', builder: { b: BUILDER, f: 10 } };
  const arb = CCTP_NETWORKS[42161];
  const fwd = pad(CCTP.hyperCoreForwarder as Hex);
  const nowS = BigInt(Math.floor(now / 1000));
  const validAfter = nowS > 3600n ? nowS - 3600n : 0n;
  // Circle's Arbitrum -> HyperCore guide: step 3 (sign ReceiveWithAuthorization) and step 4 (CctpExtension deposit).
  const receiveAuth = {
    domain: { name: 'USD Coin', version: '2', chainId: 42161, verifyingContract: ARB_USDC },
    types: { EIP712Domain: domainType, ReceiveWithAuthorization: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] },
    primaryType: 'ReceiveWithAuthorization',
    message: { from: ALICE, to: arb.cctpExtension, value: '10000000', validAfter: String(validAfter), validBefore: String(nowS + 3600n), nonce: '0x' + 'ab'.repeat(32) },
  };
  // Mock signature values (the previewer does not verify signatures).
  const extensionDeposit = (hook: Hex) => encodeFunctionData({ abi: CCTP_EXTENSION, functionName: 'batchDepositForBurnWithAuth', args: [
    { amount: 10_000_000n, authValidAfter: validAfter, authValidBefore: nowS + 3600n, authNonce: ('0x' + 'ab'.repeat(32)) as Hex, v: 27, r: ('0x' + '11'.repeat(32)) as Hex, s: ('0x' + '22'.repeat(32)) as Hex },
    { amount: 10_000_000n, destinationDomain: 19, mintRecipient: fwd, destinationCaller: fwd, maxFee: 200_000n, minFinalityThreshold: 1000, hookData: hook },
  ] });
  return [
    { id: 'cctp-guide-sign', group: 'Arbitrum → Hyperliquid', label: 'Circle guide step 3: sign USDC authorization', chainId: 42161,
      request: typed(receiveAuth) },
    { id: 'cctp-guide-deposit', group: 'Arbitrum → Hyperliquid', label: 'Circle guide step 4: CctpExtension deposit 10 USDC', chainId: 42161,
      request: tx(42161, arb.cctpExtension!, extensionDeposit(cctpHook(ALICE, 0))) },
    { id: 'cctp-guide-no-recipient', group: 'Arbitrum → Hyperliquid', label: 'CctpExtension deposit with header-only hook (stuck)', chainId: 42161,
      request: tx(42161, arb.cctpExtension!, extensionDeposit(('0x' + '636374702d666f7277617264'.padEnd(48, '0') + '0000000000000000') as Hex)) },
    { id: 'bridge2-deposit', group: 'Arbitrum → Hyperliquid', label: 'Deposit 100 USDC via Bridge2', chainId: 42161,
      request: tx(42161, ARB_USDC, encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [HYPERLIQUID.bridge2, 100_000_000n] })) },
    { id: 'bridge2-below-min', group: 'Arbitrum → Hyperliquid', label: 'Deposit 3 USDC (below minimum)', chainId: 42161,
      request: tx(42161, ARB_USDC, encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [HYPERLIQUID.bridge2, 3_000_000n] })) },
    { id: 'bridge2-wrong-token', group: 'Arbitrum → Hyperliquid', label: 'Send USDT to the bridge', chainId: 42161,
      request: tx(42161, ARB_USDT, encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [HYPERLIQUID.bridge2, 500_000_000n] })) },
    { id: 'cctp-hypercore', group: 'Arbitrum → Hyperliquid', label: 'CCTP: 250 USDC to HyperCore perps', chainId: 42161,
      request: tx(42161, CCTP.tokenMessengerV2, encodeFunctionData({ abi: CCTP_ABI, functionName: 'depositForBurnWithHook', args: [250_000_000n, 19, pad(CCTP.hyperCoreForwarder as Hex), ARB_USDC as Hex, pad(CCTP.hyperCoreForwarder as Hex), 250_000n, 1000, cctpHook(ALICE, 0)] })) },
    { id: 'cctp-other-recipient', group: 'Arbitrum → Hyperliquid', label: 'CCTP: 1,000 USDC to someone else’s spot', chainId: 42161,
      request: tx(42161, CCTP.tokenMessengerV2, encodeFunctionData({ abi: CCTP_ABI, functionName: 'depositForBurnWithHook', args: [1_000_000_000n, 19, pad(CCTP.hyperCoreForwarder as Hex), ARB_USDC as Hex, pad(CCTP.hyperCoreForwarder as Hex), 1_000_000n, 2000, cctpHook(BOB, 4294967295)] })) },
    { id: 'arb-batch', group: 'Arbitrum → Hyperliquid', label: 'Batch (EIP-5792): approve + deposit', chainId: 42161,
      request: { method: 'wallet_sendCalls', params: [{ version: '2.0.0', chainId: '0xa4b1', from: ALICE, atomicRequired: true, calls: [
        { to: ARB_USDC, data: encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [HYPERLIQUID.bridge2, MAX] }) },
        { to: ARB_USDC, data: encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [HYPERLIQUID.bridge2, 20_000_000n] }) },
      ] }] } },

    { id: 'hl-withdraw', group: 'HyperCore', label: 'Withdraw 50 USDC to Arbitrum', chainId: 42161,
      request: typed(userSigned('Withdraw', [['hyperliquidChain', 'string'], ['destination', 'string'], ['amount', 'string'], ['time', 'uint64']], { destination: ALICE, amount: '50', time: now })) },
    { id: 'hl-withdraw-other', group: 'HyperCore', label: 'Withdraw 2,500 USDC to another address', chainId: 42161,
      request: typed(userSigned('Withdraw', [['hyperliquidChain', 'string'], ['destination', 'string'], ['amount', 'string'], ['time', 'uint64']], { destination: BOB, amount: '2500', time: now })) },
    { id: 'hl-cctp-withdraw', group: 'HyperCore', label: 'Circle CCTP: withdraw 100 USDC to Arbitrum', chainId: 42161,
      request: typed(userSigned('SendToEvmWithData', [['hyperliquidChain', 'string'], ['token', 'string'], ['amount', 'string'], ['sourceDex', 'string'], ['destinationRecipient', 'string'], ['addressEncoding', 'string'], ['destinationChainId', 'uint32'], ['gasLimit', 'uint64'], ['data', 'bytes'], ['nonce', 'uint64']],
        { token: 'USDC', amount: '100', sourceDex: '', destinationRecipient: ALICE, addressEncoding: 'hex', destinationChainId: 3, gasLimit: 200000, data: '0x', nonce: now })) },
    { id: 'hl-to-hyperevm', group: 'HyperCore', label: 'Move 100 USDC to HyperEVM (SendAsset)', chainId: 42161,
      request: typed(userSigned('SendAsset', [['hyperliquidChain', 'string'], ['destination', 'string'], ['sourceDex', 'string'], ['destinationDex', 'string'], ['token', 'string'], ['amount', 'string'], ['fromSubAccount', 'string'], ['nonce', 'uint64']],
        { destination: '0x2000000000000000000000000000000000000000', sourceDex: 'spot', destinationDex: 'spot', token: 'USDC', amount: '100', fromSubAccount: '', nonce: now })) },
    { id: 'hl-usd-send', group: 'HyperCore', label: 'Send 25 USDC on Hyperliquid', chainId: 42161,
      request: typed(userSigned('UsdSend', [['hyperliquidChain', 'string'], ['destination', 'string'], ['amount', 'string'], ['time', 'uint64']], { destination: BOB, amount: '25', time: now })) },
    { id: 'hl-spot-send', group: 'HyperCore', label: 'Send 10,000 PURR', chainId: 42161,
      request: typed(userSigned('SpotSend', [['hyperliquidChain', 'string'], ['destination', 'string'], ['token', 'string'], ['amount', 'string'], ['time', 'uint64']], { destination: BOB, token: 'PURR:0xc1fb593aeffbeb02f85e0308e9956a90', amount: '10000', time: now })) },
    { id: 'hl-spot-to-evm', group: 'HyperCore', label: 'Move 12.5 HYPE to HyperEVM', chainId: 42161,
      request: typed(userSigned('SpotSend', [['hyperliquidChain', 'string'], ['destination', 'string'], ['token', 'string'], ['amount', 'string'], ['time', 'uint64']], { destination: HYPERLIQUID.hypeSystemAddress, token: 'HYPE:0x0d01dc56dcaaca66ad901c959b4011ec', amount: '12.5', time: now })) },
    { id: 'hl-class-transfer', group: 'HyperCore', label: 'Move 100 USDC perps → spot', chainId: 42161,
      request: typed(userSigned('UsdClassTransfer', [['hyperliquidChain', 'string'], ['amount', 'string'], ['toPerp', 'bool'], ['nonce', 'uint64']], { amount: '100', toPerp: false, nonce: now })) },
    { id: 'hl-approve-agent', group: 'HyperCore', label: 'Approve an API wallet (agent)', chainId: 42161,
      request: typed(userSigned('ApproveAgent', [['hyperliquidChain', 'string'], ['agentAddress', 'address'], ['agentName', 'string'], ['nonce', 'uint64']], { agentAddress: AGENT, agentName: 'trading-bot', nonce: now })) },
    { id: 'hl-builder-fee', group: 'HyperCore', label: 'Approve a 0.1% builder fee', chainId: 42161,
      request: typed(userSigned('ApproveBuilderFee', [['hyperliquidChain', 'string'], ['maxFeeRate', 'string'], ['builder', 'address'], ['nonce', 'uint64']], { maxFeeRate: '0.1%', builder: BUILDER, nonce: now })) },
    { id: 'hl-stale-send', group: 'HyperCore', label: 'Send USDC with a 5-day-old timestamp', chainId: 42161,
      request: typed(userSigned('UsdSend', [['hyperliquidChain', 'string'], ['destination', 'string'], ['amount', 'string'], ['time', 'uint64']], { destination: BOB, amount: '900', time: now - 5 * 86_400_000 })) },
    { id: 'hl-order', group: 'HyperCore', label: 'L1 order: long 0.01 BTC (action supplied)', chainId: 42161,
      request: typed(agent(l1ActionHash(order, orderNonce))), context: { hyperliquid: { action: order, nonce: orderNonce } } },
    { id: 'hl-stop-loss', group: 'HyperCore', label: 'L1 order: ETH stop loss with builder fee', chainId: 42161,
      request: typed(agent(l1ActionHash(stopLoss, orderNonce))), context: { hyperliquid: { action: stopLoss, nonce: orderNonce } } },
    { id: 'hl-leverage', group: 'HyperCore', label: 'L1: set ETH leverage to 30×', chainId: 42161,
      request: typed(agent(l1ActionHash(leverage, orderNonce))), context: { hyperliquid: { action: leverage, nonce: orderNonce } } },
    { id: 'hl-hip3-order', group: 'HyperCore', label: 'L1 order on a HIP-3 market (xyz:TSLA)', chainId: 42161,
      request: typed(agent(l1ActionHash(hip3Order, orderNonce))), context: { hyperliquid: { action: hip3Order, nonce: orderNonce } } },
    { id: 'hl-outcome-order', group: 'HyperCore', label: 'L1 order on an outcome market', chainId: 42161,
      request: typed(agent(l1ActionHash(outcomeOrder, orderNonce))), context: { hyperliquid: { action: outcomeOrder, nonce: orderNonce } } },
    { id: 'hl-borrow', group: 'HyperCore', label: 'L1: borrow 2 HYPE', chainId: 42161,
      request: typed(agent(l1ActionHash(borrow, orderNonce))), context: { hyperliquid: { action: borrow, nonce: orderNonce } } },
    { id: 'hl-staking-link', group: 'HyperCore', label: 'Link to a staking account (risky)', chainId: 42161,
      request: typed(userSigned('LinkStakingUser', [['hyperliquidChain', 'string'], ['user', 'address'], ['isFinalize', 'bool'], ['nonce', 'uint64']], { user: BOB, isFinalize: false, nonce: now })) },
    { id: 'hl-portfolio-margin', group: 'HyperCore', label: 'Switch to portfolio margin', chainId: 42161,
      request: typed(userSigned('UserSetAbstraction', [['hyperliquidChain', 'string'], ['user', 'address'], ['abstraction', 'string'], ['nonce', 'uint64']], { user: ALICE, abstraction: 'portfolioMargin', nonce: now })) },
    { id: 'hl-agent-send', group: 'HyperCore', label: 'Agent-signed asset transfer', chainId: 42161,
      request: typed(agent(l1ActionHash(agentSend, orderNonce))), context: { hyperliquid: { action: agentSend, nonce: orderNonce } } },
    { id: 'hl-set-oracle', group: 'HyperCore', label: 'HIP-3 deployer: update oracle prices', chainId: 42161,
      request: typed(agent(l1ActionHash(setOracle, orderNonce))), context: { hyperliquid: { action: setOracle, nonce: orderNonce } } },
    { id: 'hl-order-opaque', group: 'HyperCore', label: 'L1 action without the action (hash only)', chainId: 42161,
      request: typed(agent(l1ActionHash(order, orderNonce))) },
    { id: 'hl-order-mismatch', group: 'HyperCore', label: 'L1 action that does not match its hash', chainId: 42161,
      request: typed(agent(l1ActionHash({ ...order, orders: [{ ...order.orders[0], s: '5' }] }, orderNonce))), context: { hyperliquid: { action: order, nonce: orderNonce } } },

    { id: 'kinetiq-stake', group: 'HyperEVM', label: 'Kinetiq: stake 10 HYPE for kHYPE', chainId: 999,
      request: tx(999, KINETIQ_SM, '0x3a4b66f1', 10n ** 19n) },
    { id: 'kinetiq-unstake', group: 'HyperEVM', label: 'Kinetiq: unstake 100 kHYPE (7-day queue)', chainId: 999,
      request: tx(999, KINETIQ_SM, encodeFunctionData({ abi: parseAbi(['function queueWithdrawal(uint256)']), functionName: 'queueWithdrawal', args: [100n * 10n ** 18n] })) },
    { id: 'hyperlend-borrow', group: 'HyperEVM', label: 'HyperLend: borrow 3,000 USDC (health factor drops)', chainId: 999,
      request: tx(999, HYPERLEND_POOL, encodeFunctionData({ abi: parseAbi(['function borrow(address,uint256,uint256,uint16,address)']), functionName: 'borrow', args: [HYPEREVM_USDC as Hex, 3_000_000_000n, 2n, 0, ALICE as Hex] })) },
    { id: 'hyperlend-delegation', group: 'HyperEVM', label: 'HyperLend: credit delegation to another address', chainId: 999,
      request: tx(999, HYPERLEND_DEBT_USDC, encodeFunctionData({ abi: parseAbi(['function approveDelegation(address,uint256)']), functionName: 'approveDelegation', args: [SPENDER as Hex, (1n << 256n) - 1n] })) },
    { id: 'evm-hype-to-core', group: 'HyperEVM', label: 'Move 3 HYPE to HyperCore', chainId: 999,
      request: tx(999, HYPERLIQUID.hypeSystemAddress, '0x', 3n * 10n ** 18n) },
    { id: 'evm-purr-to-core', group: 'HyperEVM', label: 'Move PURR to HyperCore (system address)', chainId: 999,
      request: tx(999, MOCK_PURR_EVM, encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [spotSystemAddress(1) as Hex, 2500n * 10n ** 18n] })) },
    { id: 'corewriter-order', group: 'HyperEVM', label: 'CoreWriter: limit buy 10 HYPE-PERP', chainId: 999,
      request: tx(999, HYPERLIQUID.coreWriter, coreWriterAction(1, 'uint32, bool, uint64, uint64, bool, uint8, uint128', [3, true, 3_950_000_000n, 1_000_000_000n, false, 2, 0n])) },
    { id: 'corewriter-class', group: 'HyperEVM', label: 'CoreWriter: 500 USDC spot → perps', chainId: 999,
      request: tx(999, HYPERLIQUID.coreWriter, coreWriterAction(7, 'uint64, bool', [500_000_000n, true])) },

    { id: 'eth-approve-unlimited', group: 'Ethereum', label: 'Unlimited USDC approval', chainId: 1,
      request: tx(1, ETH_USDC, encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [SPENDER, MAX] })) },
    { id: 'eth-permit2', group: 'Ethereum', label: 'Permit2 signature (gasless approval)', chainId: 1,
      request: typed({
        domain: { name: 'Permit2', chainId: 1, verifyingContract: PERMIT2 },
        types: {
          EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
          PermitSingle: [{ name: 'details', type: 'PermitDetails' }, { name: 'spender', type: 'address' }, { name: 'sigDeadline', type: 'uint256' }],
          PermitDetails: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }],
        },
        primaryType: 'PermitSingle',
        message: { details: { token: ETH_USDC, amount: ((1n << 160n) - 1n).toString(), expiration: String(Math.floor(now / 1000) + 90 * 86400), nonce: '0' }, spender: ROUTER, sigDeadline: String(Math.floor(now / 1000) + 1800) },
      }) },
    { id: 'eth-send', group: 'Ethereum', label: 'Send 0.25 ETH (simulated)', chainId: 1,
      request: tx(1, BOB, '0x', 250_000_000_000_000_000n) },
    { id: 'eth-7702-delegate', group: 'Ethereum', label: 'EIP-7702: hand your account to an unknown contract', chainId: 1,
      request: { method: 'eth_sendTransaction', params: [{ from: ALICE, to: ALICE, data: '0x', value: '0x0', chainId: '0x1', authorizationList: [{ address: '0xbad0000000000000000000000000000000007702', chainId: '0x1', nonce: '0x0' }] }] } },
    { id: 'eth-unknown-swap', group: 'Ethereum', label: 'Unknown router call (simulated swap)', chainId: 1,
      request: tx(1, ROUTER, '0x3593564c00000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000000') },
    { id: 'eth-uniswap-swap', group: 'Ethereum', label: 'Uniswap: swap 1 ETH for USDC (Universal Router)', chainId: 1,
      // WRAP_ETH then V3_SWAP_EXACT_IN (WETH -0.05%-> USDC), as the Uniswap SDK encodes it.
      request: tx(1, '0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af', encodeFunctionData({ abi: parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable']), functionName: 'execute', args: ['0x0b00', [
        encodeAbiParameters(parseAbiParameters('address, uint256'), ['0x0000000000000000000000000000000000000002', 1n << 255n]),
        encodeAbiParameters(parseAbiParameters('address, uint256, uint256, bytes, bool'), ['0x0000000000000000000000000000000000000001', 1n << 255n, 3_150_000_000n, `${ETH_WETH}0001f4${ETH_USDC.slice(2)}` as Hex, false]),
      ], BigInt(Math.floor(now / 1000) + 1800)] }), 10n ** 18n) },
    { id: 'eth-nft-buy', group: 'Ethereum', label: 'Router call: buy an NFT, Permit2 allowance set along the way (simulated)', chainId: 1,
      request: tx(1, ROUTER, '0x3593564c0000000000000000000000000000000000000000000000000000000000000001') },
    { id: 'eth-reverting', group: 'Ethereum', label: 'Call that will revert (simulated)', chainId: 1,
      request: tx(1, POOL, '0x4e71d92d') },
    { id: 'siwe-phish', group: 'Ethereum', label: 'Sign-in message for a different site', chainId: 1,
      request: { method: 'personal_sign', params: ['0x' + Buffer.from(`app.hyperliquid.xyz wants you to sign in with your Ethereum account:\n${ALICE}\n\nSign in to Hyperliquid.\n\nURI: https://app.hyperliquid.xyz\nVersion: 1\nChain ID: 1\nNonce: 8f2k1x\nIssued At: ${new Date(now).toISOString()}`).toString('hex'), ALICE] },
      context: { origin: 'https://hyperliquld-airdrop.example' } },
  ];
}

/** Canned simulation results for the samples above. */
/**
 * Mock HyperEVM reads for the Kinetiq and HyperLend demo samples (values shaped like the live contracts on
 * 2026-11-04): kHYPE at 1.0276 HYPE, a 5 HYPE minimum, a 7-day queue; ALICE with $10,000 of WHYPE collateral and
 * $4,000 of USDC debt on HyperLend (health factor 2.0).
 */
export function mockHyperEvmRpc(): RpcClient {
  const sel = (s: string) => toFunctionSelector(`function ${s}`);
  const u = (v: bigint) => encodeAbiParameters([{ type: 'uint256' }], [v]);
  const a = (x: string) => encodeAbiParameters([{ type: 'address' }], [x as Hex]);
  const E = 10n ** 18n, RATE = 1_027_590_248_920_605_756n;
  const ACCOUNTANT = '0x9209648ec9d448ef57116b73a2f081835643dc7a', PROVIDER = '0x72c98246a98bfe64022a3190e7710e157497170c', ORACLE = '0xc9fb4fbe842d57eac1df3e641a281827493a630e';
  const reserve = encodeAbiParameters(parseAbiParameters('(uint256, uint128, uint128, uint128, uint128, uint128, uint40, uint16, address, address, address, address, uint128, uint128, uint128)'),
    [[(6n << 48n) | (7800n << 16n) | 7500n, 0n, 0n, 0n, 0n, 0n, 0, 1, '0x000000000000000000000000000000000000a5dc', '0x0000000000000000000000000000000000000000', HYPERLEND_DEBT_USDC as Hex, '0x0000000000000000000000000000000000000000', 0n, 0n, 0n]]);
  const answers: Record<string, Hex | ((d: Hex) => Hex)> = {
    [`${KINETIQ_SM}:${sel('stakingAccountant()')}`]: a(ACCOUNTANT), [`${KINETIQ_SM}:${sel('minStakeAmount()')}`]: u(5n * E), [`${KINETIQ_SM}:${sel('maxStakeAmount()')}`]: u(0n),
    [`${KINETIQ_SM}:${sel('stakingPaused()')}`]: u(0n), [`${KINETIQ_SM}:${sel('whitelistEnabled()')}`]: u(0n), [`${KINETIQ_SM}:${sel('withdrawalPaused()')}`]: u(0n),
    [`${KINETIQ_SM}:${sel('unstakeFeeRate()')}`]: u(0n), [`${KINETIQ_SM}:${sel('withdrawalDelay()')}`]: u(604_800n), [`${KINETIQ_SM}:${sel('quickWithdrawalDelay()')}`]: u(129_600n),
    [`${KINETIQ_SM}:${sel('minWithdrawalAmount()')}`]: u(0n), [`${KINETIQ_SM}:${sel('nextWithdrawalId(address)')}`]: u(0n),
    [`${ACCOUNTANT}:${sel('HYPEToKHYPE(uint256)')}`]: d => u(BigInt('0x' + d.slice(10)) * E / RATE),
    [`${ACCOUNTANT}:${sel('kHYPEToHYPE(uint256)')}`]: d => u(BigInt('0x' + d.slice(10)) * RATE / E),
    [`${HYPERLEND_POOL}:${sel('getUserAccountData(address)')}`]: encodeAbiParameters(parseAbiParameters('uint256, uint256, uint256, uint256, uint256, uint256'), [10_000n * 10n ** 8n, 4_000n * 10n ** 8n, 3_500n * 10n ** 8n, 8000n, 7500n, 2n * E]),
    [`${PROVIDER}:${sel('getPriceOracle()')}`]: a(ORACLE), [`${ORACLE}:${sel('getAssetPrice(address)')}`]: u(10n ** 8n),
    [`${HYPERLEND_POOL}:${sel('getReserveData(address)')}`]: reserve, [`${HYPERLEND_POOL}:${sel('getUserEMode(address)')}`]: u(0n),
    [`${HYPERLEND_POOL}:${sel('getReserveVariableDebtToken(address)')}`]: a(HYPERLEND_DEBT_USDC),
    [`${HYPERLEND_DEBT_USDC}:${sel('POOL()')}`]: a(HYPERLEND_POOL), [`${HYPERLEND_DEBT_USDC}:${sel('UNDERLYING_ASSET_ADDRESS()')}`]: a(HYPEREVM_USDC),
    [`${HYPERLEND_DEBT_USDC}:${sel('name()')}`]: encodeAbiParameters([{ type: 'string' }], ['HyperLend HyperEVM Variable Debt USDC']),
  };
  return {
    has: chainId => chainId === 999,
    async call(_chainId, method, params) {
      if (method !== 'eth_call') throw new Error(`mock RPC: ${method} not supported`);
      const { to, data } = params[0] as { to: string; data: Hex };
      const r = answers[`${to.toLowerCase()}:${data.slice(0, 10)}`];
      if (r === undefined) throw Object.assign(new Error('execution reverted'), { rpcError: { code: 3, message: 'execution reverted' } });
      return typeof r === 'function' ? r(data) : r;
    },
  };
}

export function mockSimulator(): MockSimulator {
  const samples = buildSamples(0);
  const call = (id: string) => {
    const p = (samples.find(s => s.id === id)!.request.params as Record<string, string>[])[0];
    return MockSimulator.key({ chainId: Number(p.chainId), to: p.to, data: p.data });
  };
  const batchCall = (id: string, i: number) => {
    const b = (samples.find(s => s.id === id)!.request.params as { chainId: string; calls: Record<string, string>[] }[])[0];
    return MockSimulator.key({ chainId: Number(b.chainId), to: b.calls[i].to, data: b.calls[i].data });
  };
  const ok = (transfers: SimulationResult['transfers'], gasUsed: bigint): SimulationResult => ({ status: 'success', source: 'mock', gasUsed, transfers });
  return new MockSimulator({
    [call('eth-send')]: ok([{ asset: 'native', from: ALICE, to: BOB, raw: 250_000_000_000_000_000n }], 21_000n),
    [call('eth-unknown-swap')]: ok([
      { asset: ETH_USDC, from: ALICE, to: POOL, raw: 1_000_000_000n },
      { asset: ETH_WETH, from: POOL, to: ALICE, raw: 284_350_000_000_000_000n },
    ], 182_331n),
    // A router buys an NFT with USDC and, along the way, records an unlimited Permit2 allowance for itself.
    [call('eth-nft-buy')]: { ...ok([{ asset: ETH_USDC, from: ALICE, to: POOL, raw: 1_500_000_000n }], 214_870n),
      nftTransfers: [{ standard: 'erc721', collection: MOCK_NFT, from: POOL, to: ALICE, tokenId: 4242n, amount: 1n }],
      approvals: [{ kind: 'permit2', emitter: PERMIT2, token: ETH_USDC, owner: ALICE, spender: ROUTER, amount: (1n << 160n) - 1n, expiration: 1_798_761_600 }] },
    [call('eth-reverting')]: { status: 'reverted', source: 'mock', gasUsed: 31_208n, revertReason: 'Airdrop already claimed', transfers: [] },
    [call('bridge2-deposit')]: ok([{ asset: ARB_USDC, from: ALICE, to: HYPERLIQUID.bridge2, raw: 100_000_000n }], 51_204n),
    // EIP-5792 batch, simulated in order: the approval, then the deposit.
    [batchCall('arb-batch', 0)]: ok([], 46_123n),
    [batchCall('arb-batch', 1)]: ok([{ asset: ARB_USDC, from: ALICE, to: HYPERLIQUID.bridge2, raw: 20_000_000n }], 34_412n),
  });
}
