// MOCK DATA ONLY. Addresses, token IDs, prices and balances below are invented
// for demos and tests (except well-known public contract addresses).
import { encodeAbiParameters, encodeFunctionData, pad, parseAbi, parseAbiParameters, type Hex } from 'viem';
import { CCTP, HYPERLIQUID, PERMIT2, spotSystemAddress } from '../src/chains.ts';
import { l1ActionHash } from '../src/hyperliquid/action-hash.ts';
import { StaticHyperliquidInfo } from '../src/hyperliquid/info.ts';
import { MockSimulator } from '../src/simulation.ts';
import type { PreviewContext, SigningRequest, SimulationResult } from '../src/types.ts';

export const ALICE = '0xa11ce00000000000000000000000000000000001';
export const BOB = '0xb0b0000000000000000000000000000000000002';
export const AGENT = '0xa9e1700000000000000000000000000000000003';
export const BUILDER = '0xb17d000000000000000000000000000000000004';
export const SPENDER = '0x5bad000000000000000000000000000000000005';
export const ROUTER = '0x7e57000000000000000000000000000000000006';
export const POOL = '0x9001000000000000000000000000000000000007';
const MOCK_PURR_EVM = '0x9b498c3c8a0b8cd8ba1d9851d40d186f1872b44e';

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
        { name: 'USDC', index: 0, tokenId: '0x6d1e7cde53ba9467b783cb7c530ce054', szDecimals: 8, weiDecimals: 8, evmContract: null },
        { name: 'PURR', index: 1, tokenId: '0xc1fb593aeffbeb02f85e0308e9956a90', szDecimals: 0, weiDecimals: 5, evmContract: { address: MOCK_PURR_EVM, evm_extra_wei_decimals: 13 } },
        { name: 'HYPE', index: 150, tokenId: '0x0d01dc56dcaaca66ad901c959b4011ec', szDecimals: 2, weiDecimals: 8, evmContract: { address: HYPERLIQUID.hypeSystemAddress, evm_extra_wei_decimals: 10 } },
      ],
      universe: [
        { name: 'PURR/USDC', index: 0, tokens: [1, 0] },
        { name: '@107', index: 107, tokens: [150, 0] },
      ],
    },
    allMids: { BTC: '98000', ETH: '3500', SOL: '180', HYPE: '40', 'PURR/USDC': '0.2', '@107': '40' },
    clearinghouse: {
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
  const stopLoss = { type: 'order', orders: [{ a: 1, b: false, p: '3100', s: '0.5', r: true, t: { trigger: { isMarket: true, triggerPx: '3150', tpsl: 'sl' } } }], grouping: 'na', builder: { b: BUILDER, f: 10 } };
  return [
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
    { id: 'hl-order-opaque', group: 'HyperCore', label: 'L1 action without the action (hash only)', chainId: 42161,
      request: typed(agent(l1ActionHash(order, orderNonce))) },
    { id: 'hl-order-mismatch', group: 'HyperCore', label: 'L1 action that does not match its hash', chainId: 42161,
      request: typed(agent(l1ActionHash({ ...order, orders: [{ ...order.orders[0], s: '5' }] }, orderNonce))), context: { hyperliquid: { action: order, nonce: orderNonce } } },

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
    { id: 'eth-unknown-swap', group: 'Ethereum', label: 'Unknown router call (simulated swap)', chainId: 1,
      request: tx(1, ROUTER, '0x3593564c00000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000000') },
    { id: 'eth-reverting', group: 'Ethereum', label: 'Call that will revert (simulated)', chainId: 1,
      request: tx(1, POOL, '0x4e71d92d') },
    { id: 'siwe-phish', group: 'Ethereum', label: 'Sign-in message for a different site', chainId: 1,
      request: { method: 'personal_sign', params: ['0x' + Buffer.from(`app.hyperliquid.xyz wants you to sign in with your Ethereum account:\n${ALICE}\n\nSign in to Hyperliquid.\n\nURI: https://app.hyperliquid.xyz\nVersion: 1\nChain ID: 1\nNonce: 8f2k1x\nIssued At: ${new Date(now).toISOString()}`).toString('hex'), ALICE] },
      context: { origin: 'https://hyperliquld-airdrop.example' } },
  ];
}

/** Canned simulation results for the samples above. */
export function mockSimulator(): MockSimulator {
  const samples = buildSamples(0);
  const call = (id: string) => {
    const p = (samples.find(s => s.id === id)!.request.params as Record<string, string>[])[0];
    return MockSimulator.key({ chainId: Number(p.chainId), to: p.to, data: p.data });
  };
  const ok = (transfers: SimulationResult['transfers'], gasUsed: bigint): SimulationResult => ({ status: 'success', source: 'mock', gasUsed, transfers });
  return new MockSimulator({
    [call('eth-send')]: ok([{ asset: 'native', from: ALICE, to: BOB, raw: 250_000_000_000_000_000n }], 21_000n),
    [call('eth-unknown-swap')]: ok([
      { asset: ETH_USDC, from: ALICE, to: POOL, raw: 1_000_000_000n },
      { asset: ETH_WETH, from: POOL, to: ALICE, raw: 284_350_000_000_000_000n },
    ], 182_331n),
    [call('eth-reverting')]: { status: 'reverted', source: 'mock', gasUsed: 31_208n, revertReason: 'Airdrop already claimed', transfers: [] },
    [call('bridge2-deposit')]: ok([{ asset: ARB_USDC, from: ALICE, to: HYPERLIQUID.bridge2, raw: 100_000_000n }], 51_204n),
  });
}
