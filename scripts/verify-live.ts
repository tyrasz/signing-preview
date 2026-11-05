// Opt-in live check (network): `npm run verify:live`. Read-only, nothing is signed with a real key or broadcast.
//  1. Reads the deployed CCTP / HyperCore configuration the previewer relies on.
//  2. Simulates Circle's Arbitrum -> HyperCore guide transactions (and known mistakes) with eth_simulateV1 on
//     Arbitrum One, funding a fresh throwaway address from a large USDC holder inside the simulation only, and the
//     Ethereum -> HyperCore TokenMessengerV2 route on Ethereum (funded with a USDC balance override).
//     It also simulates an EIP-5792 batch (approve + deposit) in order with RpcSimulator.
//  3. Checks CoreDepositWallet's recipient rules on HyperEVM with eth_call + a USDC balance/allowance override.
//  4. Resolves every live HyperCore asset ID (perps, spot, HIP-3, outcomes) to a named, priced market.
//  5. Checks HyperCore -> other-chain withdrawal fees and runs CoreDepositWallet's HyperEVM withdrawal step
//     (eth_call from the USDC system address), comparing each outcome with the preview's prediction.
//  6. Checks the curated token list's decimals against each token contract, on-chain metadata reads and proxy
//     detection on deployed contracts, and the Sourcify / OpenChain / 4byte (and, with ETHERSCAN_API_KEY,
//     Etherscan) response shapes. A service that can't be reached is skipped, unless VERIFY_LIVE_STRICT=1 (CI).
//  7. Simulates a Uniswap Universal Router Permit2 permit (read back from Permit2) and an ERC-721 transfer.
//  8. Decodes recent real Universal Router transactions on Ethereum and compares each headline ("Swap X for Y")
//     with what the receipt and balance changes show was paid and received.
//  9. Kinetiq and HyperLend on HyperEVM: identities, facets and typehashes, and the decoders' predictions (rate,
//     minimum, precision, health factor) against eth_call results on the live contracts.
// 10. HyperEVM simulation (SimulationProbe through eth_call state overrides): a Kinetiq stake against Kinetiq's own
//     quote, a USDC transfer and an approve + HyperLend supply batch, from real holders found in recent blocks.
// Exits non-zero if the chain and the previewer disagree. Needs network access to arb1.arbitrum.io,
// ethereum-rpc.publicnode.com (or ETHEREUM_RPC_URL), rpc.hyperliquid.xyz and api.hyperliquid.xyz, plus
// sourcify.dev, api.openchain.xyz and www.4byte.directory for step 6 (behind a proxy, run with
// NODE_USE_ENV_PROXY=1 on Node >= 22.21).
import { createPublicClient, http, formatUnits, toFunctionSelector, encodeFunctionData, decodeEventLog, decodeErrorResult, encodeAbiParameters, keccak256, pad as padHex, parseAbi, parseAbiItem, parseUnits, toHex, type Hex, type Address } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { previewRequest } from '../src/preview.ts';
import { builtinTokens, CHAINS, HYPERCORE_CCTP_WITHDRAWAL, StaticTokenRegistry } from '../src/chains.ts';
import { ChainedTokenRegistry, OnchainTokenRegistry } from '../src/tokens.ts';
import { ChainedSignatures, ContractAbiResolver, detectProxy, EtherscanAbiSource, FourByteSignatures, OpenChainSignatures, SourcifyAbiSource } from '../src/abi.ts';
import type { RpcClient } from '../src/rpc.ts';
import { abiAdapter } from '../src/evm/abi-adapter.ts';
import { parseLogs, RpcSimulator } from '../src/simulation.ts';
import { UNIVERSAL_ROUTERS } from '../src/evm/universal-router.ts';
import { KINETIQ } from '../src/evm/kinetiq.ts';
import { HYPERLEND } from '../src/evm/hyperlend.ts';
import { HttpHyperliquidInfo } from '../src/hyperliquid/info.ts';
import { resolveAsset } from '../src/hyperliquid/assets.ts';

const RPC = 'https://arb1.arbitrum.io/rpc';
const client = createPublicClient({ transport: http(RPC, { retryCount: 6, retryDelay: 2000 }) });
const USDC: Address = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const EXT: Address = '0xA95d9c1F655341597C94393fDdc30cf3c08E4fcE';
const TMV2: Address = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d';
const FWD: Address = '0xb21D281DEdb17AE5B501F6AA8256fe38C4e45757';
const FUNDER: Address = '0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7'; // large USDC holder, used only inside the simulation
const ETH_RPC = process.env.ETHEREUM_RPC_URL ?? 'https://ethereum-rpc.publicnode.com';
const ETH_USDC: Address = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const USDC_BALANCE_SLOT = 9n; // FiatTokenV2_2 balanceAndBlacklistStates mapping (same on Ethereum and HyperEVM)
const account = privateKeyToAccount(generatePrivateKey()); // fresh key: well-known test keys can carry EIP-7702 code on Arbitrum
const ERC20 = parseAbi(['function transfer(address,uint256)', 'function approve(address,uint256)', 'function balanceOf(address) view returns (uint256)']);
const TMV2_ABI = parseAbi(['function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData)']);
const EXT_ABI = [{ name: 'batchDepositForBurnWithAuth', type: 'function', stateMutability: 'nonpayable', outputs: [], inputs: [
  { name: 'a', type: 'tuple', components: [{ name: 'amount', type: 'uint256' }, { name: 'authValidAfter', type: 'uint256' }, { name: 'authValidBefore', type: 'uint256' }, { name: 'authNonce', type: 'bytes32' }, { name: 'v', type: 'uint8' }, { name: 'r', type: 'bytes32' }, { name: 's', type: 'bytes32' }] },
  { name: 'd', type: 'tuple', components: [{ name: 'amount', type: 'uint256' }, { name: 'destinationDomain', type: 'uint32' }, { name: 'mintRecipient', type: 'bytes32' }, { name: 'destinationCaller', type: 'bytes32' }, { name: 'maxFee', type: 'uint256' }, { name: 'minFinalityThreshold', type: 'uint32' }, { name: 'hookData', type: 'bytes' }] },
] }] as const;
const DEPOSIT_FOR_BURN = parseAbiItem('event DepositForBurn(address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller, uint256 maxFee, uint32 indexed minFinalityThreshold, bytes hookData)');
const ERRORS = parseAbi(['error Error(string)']);

// Verbatim from Circle's guide.
function encodeForwardHookData(hyperCoreMintRecipient?: `0x${string}`, hyperCoreDestinationDex: number = 0): `0x${string}` {
  const magicHex = Buffer.from('cctp-forward', 'utf-8').toString('hex').padEnd(48, '0');
  const version = '00000000';
  if (!hyperCoreMintRecipient) return `0x${magicHex}${version}00000000`;
  const address = hyperCoreMintRecipient.slice(2).toLowerCase();
  const dex = (hyperCoreDestinationDex >>> 0).toString(16).padStart(8, '0');
  return `0x${magicHex}${version}00000018${address}${dex}`;
}
const pad = (a: Address) => `0x${a.slice(2).padStart(64, '0')}` as Hex;

interface Case { id: string; via: 'ext' | 'tmv2'; amount: string; batch?: string; maxFee: string; hook?: Hex; dex?: number; validBefore?: bigint; finality?: number; chain?: 'eth' }
if (await client.getCode({ address: account.address })) throw new Error('test address unexpectedly has code');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/**
 * JSON-RPC POST that retries only on rate limiting (HTTP 429 or a "rate limit" error message), so a throttled
 * call is never mistaken for a contract revert. Shared public RPCs throttle CI runners more often.
 */
async function jsonRpc(url: string, body: unknown): Promise<any> {
  for (let i = 0; i < 8; i++) {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (res.status !== 429) {
      const json = await res.json();
      if (!/rate limit/i.test(String(json?.error?.message ?? ''))) return json;
    }
    await sleep(3000 * (i + 1));
  }
  throw new Error(`rate limited by ${url} after 8 attempts`);
}
const block = await client.getBlock();
const T = block.timestamp;
const ethBlock = await createPublicClient({ transport: http(ETH_RPC, { retryCount: 6, retryDelay: 2000 }) }).getBlock();
const NETS = {
  arb: { name: 'Arbitrum One', chainId: 42161, hex: '0xa4b1', rpc: RPC, usdc: USDC, block, T },
  eth: { name: 'Ethereum', chainId: 1, hex: '0x1', rpc: ETH_RPC, usdc: ETH_USDC, block: ethBlock, T: ethBlock.timestamp },
} as const;
const cases: Case[] = [
  { id: 'guide-perps-10', via: 'ext', amount: '10', maxFee: '0.2' },
  { id: 'guide-spot-10', via: 'ext', amount: '10', maxFee: '0.2', dex: 4294967295 },
  { id: 'guide-standard-finality', via: 'ext', amount: '10', maxFee: '0.2', finality: 2000 },
  { id: 'batch-10-in-5', via: 'ext', amount: '10', batch: '2', maxFee: '0.2' },
  { id: 'header-only-hook', via: 'ext', amount: '10', maxFee: '0.2', hook: encodeForwardHookData() },
  { id: 'empty-hook', via: 'ext', amount: '10', maxFee: '0.2', hook: '0x' },
  { id: 'maxfee-ge-amount', via: 'ext', amount: '1', maxFee: '1' },
  { id: 'indivisible-batch', via: 'ext', amount: '10', batch: '3', maxFee: '0.2' },
  { id: 'expired-auth', via: 'ext', amount: '10', maxFee: '0.2', validBefore: T - 60n },
  { id: 'low-maxfee', via: 'ext', amount: '10', maxFee: '0.1' },
  { id: 'tmv2-hook', via: 'tmv2', amount: '10', maxFee: '0.2' },
  { id: 'tmv2-empty-hook', via: 'tmv2', amount: '10', maxFee: '0.2', hook: '0x' },
  // Ethereum -> HyperCore (Circle's Ethereum guide): fast fee 1 bp + 0.20 USDC forwarding, so maxFee 0.25 on 10 USDC.
  { id: 'eth-perps-10', chain: 'eth', via: 'tmv2', amount: '10', maxFee: '0.25' },
  { id: 'eth-spot-10', chain: 'eth', via: 'tmv2', amount: '10', maxFee: '0.25', dex: 4294967295 },
  { id: 'eth-standard-finality', chain: 'eth', via: 'tmv2', amount: '10', maxFee: '0.25', finality: 2000 },
  { id: 'eth-header-only-hook', chain: 'eth', via: 'tmv2', amount: '10', maxFee: '0.25', hook: encodeForwardHookData() },
  { id: 'eth-empty-hook', chain: 'eth', via: 'tmv2', amount: '10', maxFee: '0.25', hook: '0x' },
  { id: 'eth-maxfee-ge-amount', chain: 'eth', via: 'tmv2', amount: '1', maxFee: '1' },
];

const deps = { tokens: new StaticTokenRegistry() };
const rows = [];
for (const c of cases) {
  const amount = parseUnits(c.amount, 6), batch = parseUnits(c.batch ?? c.amount, 6), maxFee = parseUnits(c.maxFee, 6);
  const hook = c.hook ?? encodeForwardHookData(account.address, c.dex ?? 0);
  const net = NETS[c.chain ?? 'arb'];
  const calls: { from: Address; to: Address; data: Hex }[] = [];
  // Arbitrum: a large holder sends the USDC inside the simulation. Ethereum: the balance is set by state override.
  const stateOverrides = c.chain === 'eth' ? { [ETH_USDC]: { stateDiff: { [keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [account.address, USDC_BALANCE_SLOT]))]: padHex(toHex(amount)) } } } : undefined;
  if (!stateOverrides) calls.push({ from: FUNDER, to: USDC, data: encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [account.address, amount] }) });
  let request;
  if (c.via === 'ext') {
    const validAfter = T - 3600n, validBefore = c.validBefore ?? T + 3600n, nonce = ('0x' + c.id.split('').map(ch => ch.charCodeAt(0).toString(16)).join('').padEnd(64, '0').slice(0, 64)) as Hex;
    const signature = await account.signTypedData({ domain: { name: 'USD Coin', version: '2', chainId: 42161, verifyingContract: USDC },
      types: { ReceiveWithAuthorization: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] },
      primaryType: 'ReceiveWithAuthorization', message: { from: account.address, to: EXT, value: amount, validAfter, validBefore, nonce } });
    const r = signature.slice(0, 66) as Hex, s = `0x${signature.slice(66, 130)}` as Hex, v = parseInt(signature.slice(130, 132), 16);
    const data = encodeFunctionData({ abi: EXT_ABI, functionName: 'batchDepositForBurnWithAuth', args: [
      { amount, authValidAfter: validAfter, authValidBefore: validBefore, authNonce: nonce, v, r, s },
      { amount: batch, destinationDomain: 19, mintRecipient: pad(FWD), destinationCaller: pad(FWD), maxFee, minFinalityThreshold: c.finality ?? 1000, hookData: hook }] });
    calls.push({ from: account.address, to: EXT, data });
    request = { method: 'eth_sendTransaction', params: [{ from: account.address, to: EXT, data, chainId: '0xa4b1' }] };
  } else {
    calls.push({ from: account.address, to: net.usdc, data: encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [TMV2, amount] }) });
    const data = encodeFunctionData({ abi: TMV2_ABI, functionName: 'depositForBurnWithHook', args: [amount, 19, pad(FWD), net.usdc, pad(FWD), maxFee, c.finality ?? 1000, hook] });
    calls.push({ from: account.address, to: TMV2, data });
    request = { method: 'eth_sendTransaction', params: [{ from: account.address, to: TMV2, data, chainId: net.hex }] };
  }
  calls.push({ from: account.address, to: net.usdc, data: encodeFunctionData({ abi: ERC20, functionName: 'balanceOf', args: [account.address] }) });
  await sleep(1500);
  const res = await jsonRpc(net.rpc, { jsonrpc: '2.0', id: 1, method: 'eth_simulateV1', params: [{ blockStateCalls: [{ ...(stateOverrides && { stateOverrides }), calls }], validation: false }, toHex(net.block.number)] });
  if (res.error) { rows.push({ id: c.id, net: net.name, error: res.error.message }); continue; }
  const results = res.result[0].calls;
  const main = results[results.length - 2];
  let revert = null;
  if (main.status !== '0x1') { try { revert = decodeErrorResult({ abi: ERRORS, data: main.error?.data ?? main.returnData }).args[0]; } catch { revert = main.error?.message ?? main.returnData; } }
  const burns = (main.logs ?? []).flatMap((l: { address: string; topics: Hex[]; data: Hex }) => { try { const e = decodeEventLog({ abi: [DEPOSIT_FOR_BURN], data: l.data, topics: l.topics as [Hex] }); return [e.args]; } catch { return []; } });
  const balanceAfter = BigInt(results[results.length - 1].returnData);
  const p = await previewRequest(request, { chainId: net.chainId, account: account.address, now: Number(net.T) * 1000 }, deps);
  rows.push({
    id: c.id,
    net: net.name,
    chain: main.status === '0x1' ? 'success' : `revert: ${revert}`,
    burnEvents: burns.length,
    burned: (amount - balanceAfter).toString(),
    eventFields: burns[0] ? { amount: burns[0].amount.toString(), maxFee: burns[0].maxFee.toString(), finality: burns[0].minFinalityThreshold, mintRecipientIsFwd: burns[0].mintRecipient.toLowerCase() === pad(FWD).toLowerCase(), callerIsFwd: burns[0].destinationCaller.toLowerCase() === pad(FWD).toLowerCase(), hookBytes: (burns[0].hookData.length - 2) / 2 } : null,
    preview: { title: p.title, attention: p.attention, warnings: p.warnings.map(w => `${w.severity}:${w.code}`), amountOut: p.assetChanges.map(a => a.raw).join(','), expected: p.details.find(d => d.label.startsWith('Expected on HyperCore'))?.value ?? null },
  });
}
let failures = 0;
const check = (ok: boolean, label: string, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? '  ' + detail : ''}`); };

let shownNet = '';
for (const r of rows as any[]) {
  if (r.net !== shownNet) { shownNet = r.net; const n = Object.values(NETS).find(x => x.name === r.net)!; console.log(`\n# ${n.name} simulations at block ${n.block.number}`); }
  if (r.error) { check(false, r.id, r.error); continue; }
  const reverted = r.chain !== 'success';
  const predictedRevert = r.preview.title.includes('will fail');
  const stuck = !reverted && r.eventFields && r.eventFields.hookBytes < 52;
  const predictedStuck = r.preview.warnings.includes('danger:cctp_bad_hook');
  const outflow = reverted ? r.preview.amountOut === '' : r.preview.amountOut === r.burned;
  check(predictedRevert === reverted && predictedStuck === !!stuck && outflow, r.id.padEnd(24), `${r.chain} | preview: ${r.preview.attention} "${r.preview.title}"`);
}

console.log('\n# EIP-5792 batch on Arbitrum One: approve + CCTP deposit, via RpcSimulator');
{
  const simulator = new RpcSimulator({ 42161: RPC });
  const amount = 10_000_000n;
  const approveData = encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [TMV2, amount] });
  const burnData = encodeFunctionData({ abi: TMV2_ABI, functionName: 'depositForBurnWithHook', args: [amount, 19, pad(FWD), USDC, pad(FWD), 200_000n, 1000, encodeForwardHookData(FUNDER, 0)] });
  // On its own the deposit fails for lack of an allowance; that is what batch previews used to show for call 2.
  const alone = await simulator.simulate({ chainId: 42161, from: FUNDER, to: TMV2, data: burnData, value: 0n });
  check(alone?.status === 'reverted', 'the deposit alone reverts'.padEnd(34), alone?.revertReason ?? alone?.status ?? 'not simulated');
  await sleep(1000);
  const p = await previewRequest({ method: 'wallet_sendCalls', params: [{ version: '2.0.0', chainId: '0xa4b1', from: FUNDER, atomicRequired: true, calls: [{ to: USDC, data: approveData }, { to: TMV2, data: burnData }] }] },
    { now: Number(T) * 1000 }, { tokens: new StaticTokenRegistry(), simulator });
  const bad = p.warnings.filter(w => ['simulation_reverted', 'batch_will_fail', 'simulation_unavailable'].includes(w.code)).map(w => w.code);
  check(p.simulation?.status === 'success' && !bad.length, 'in order, the batch succeeds'.padEnd(34), `${p.simulation?.status}, gas ${p.simulation?.gasUsed}${bad.length ? ', ' + bad.join(', ') : ''} | "${p.title}"`);
  const changes = p.assetChanges.map(c => `${c.direction} ${c.amount} ${c.symbol} (${c.basis})`).join(', ');
  check(changes === 'out 10 USDC (simulated_events)', 'batch balance change'.padEnd(34), changes);
  // USDC lowers the allowance without an Approval event when it is spent: the state read must say none is left.
  const left = (p.approvals ?? []).map(a => `${a.symbol} ${a.allowance} (${a.basis})`).join(', ');
  check(left === 'USDC none (simulated_state)', 'allowance left after the batch'.padEnd(34), left || 'no approvals');
}

console.log('\n# Deployed configuration');
const hl = createPublicClient({ transport: http('https://rpc.hyperliquid.xyz/evm', { retryCount: 6, retryDelay: 2000 }) });
const H = { usdc: '0xb88339CB7199b77E23DB6E890353E22632Ba630f', cdw: '0x6B9E773128f453f5c2C60935Ee2DE2CBc5390A24' } as const;
const readAt = (c: typeof client, address: Address, sig: string, args: unknown[] = []) => c.readContract({ address, abi: parseAbi([sig]), functionName: sig.match(/function (\w+)/)![1], args } as never) as Promise<unknown>;
check(String(await readAt(client, EXT, 'function token() view returns (address)')).toLowerCase() === USDC.toLowerCase(), 'CctpExtension.token() is Arbitrum USDC');
check(String(await readAt(client, EXT, 'function tokenMessenger() view returns (address)')).toLowerCase() === TMV2.toLowerCase(), 'CctpExtension.tokenMessenger() is TokenMessengerV2');
check(String(await readAt(hl, FWD, 'function tokenToForwardingAddress(address) view returns (address)', [H.usdc])).toLowerCase() === H.cdw.toLowerCase(), 'CctpForwarder forwards USDC to CoreDepositWallet');
check(String(await readAt(hl, H.cdw, 'function tokenSystemAddress() view returns (address)')).toLowerCase() === '0x2000000000000000000000000000000000000000', 'CoreDepositWallet USDC system address is 0x2000…0000');
check(await readAt(hl, H.cdw, 'function enabledDestinationDexes(uint32) view returns (bool)', [0]) === true, 'perps (DEX 0) forwarding enabled');
check(await readAt(hl, H.cdw, 'function isDexForwardingDisabled() view returns (bool)') === false, 'DEX forwarding not disabled');
const forwardFee = await readAt(hl, H.cdw, 'function cctpDefaultForwardFee() view returns (uint256)') as bigint;
check(forwardFee === 200_000n, 'forwarding fee is 0.20 USDC (as documented)', `live: ${forwardFee}`);
const newAccountFee = await readAt(hl, H.cdw, 'function newCoreAccountFee() view returns (uint64)') as bigint;
check(newAccountFee === 0n, 'perps new-account fee is 0 (previewer treats it as informational)', `live: ${newAccountFee}`);

console.log('\n# HyperEVM CoreDepositWallet recipient rules (eth_call with USDC override)');
const me = privateKeyToAccount(generatePrivateKey()).address;
const amt = 10_000_000n;
const slot = (key: string, s: bigint) => keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [key as Address, s]));
const nested = (k1: string, k2: string, s: bigint) => keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [k2 as Address, slot(k1, s)]));
// FiatToken V2.2 layout: balances (with blacklist bit) at slot 9, allowances at slot 10.
const override = { [H.usdc]: { stateDiff: { [slot(me, 9n)]: padHex(toHex(amt)), [nested(me, H.cdw, 10n)]: padHex(toHex(amt)) } } };
const depositFor = parseAbi(['function depositFor(address recipient, uint256 amount, uint32 destinationDex)']);
for (const [label, recipient, dex, expectRevert] of [
  ['new account, perps', me, 0, null], ['new account, spot', me, 4294967295, null],
  ['recipient = USDC system address', '0x2000000000000000000000000000000000000000', 0, 'Invalid recipient: system address'],
  ['recipient = CoreDepositWallet', H.cdw, 0, 'Invalid recipient: CoreDepositWallet'],
  ['recipient = zero', '0x0000000000000000000000000000000000000000', 0, 'Invalid recipient: zero address'],
] as const) {
  await sleep(1200);
  const res = await jsonRpc('https://rpc.hyperliquid.xyz/evm', { jsonrpc: '2.0', id: 1, method: 'eth_call',
    params: [{ from: me, to: H.cdw, data: encodeFunctionData({ abi: depositFor, functionName: 'depositFor', args: [recipient as Address, amt, dex] }) }, 'latest', override] });
  const got = res.error ? String(res.error.message).replace('execution reverted: ', '') : null;
  check(got === expectRevert, label.padEnd(34), got ? `reverts: ${got}` : 'succeeds');
}

console.log('\n# HyperCore markets: every live asset ID resolves to a named market with a mid price');
{
  const info = new HttpHyperliquidInfo(undefined, { retries: 6 });
  const [meta, spot, dexs, om] = await Promise.all([info.meta(), info.spotMeta(), info.perpDexs(), info.outcomeMeta()]);
  const ids: [string, number][] = [];
  meta.universe.forEach((_, i) => ids.push(['main-DEX perps', i]));
  spot.universe.forEach(p => ids.push(['spot pairs', 10_000 + p.index]));
  const mids = new Map<string, Record<string, string>>([['', await info.allMids()]]);
  for (const [d, dex] of dexs.entries()) {
    if (d === 0 || !dex) continue;
    (await info.meta(dex.name)).universe.forEach((_, i) => ids.push(['HIP-3 perps', 100_000 + d * 10_000 + i]));
    mids.set(dex.name, await info.allMids(dex.name));
  }
  om.outcomes.forEach(o => o.sideSpecs.forEach((_, side) => ids.push(['outcome sides', 100_000_000 + 10 * o.outcome + side])));
  const stats = new Map<string, { n: number; bad: number[] }>();
  for (const [kind, id] of ids) {
    const st = stats.get(kind) ?? { n: 0, bad: [] };
    stats.set(kind, st);
    const a = await resolveAsset(info, id);
    st.n++;
    if (a.kind === 'unknown' || !a.midKey || !(Number(mids.get(a.dex ?? '')?.[a.midKey]) > 0)) st.bad.push(id);
  }
  for (const [kind, st] of stats) check(st.bad.length === 0, `${kind.padEnd(16)} ${st.n - st.bad.length}/${st.n}`, st.bad.length ? `unresolved: ${st.bad.slice(0, 5).join(', ')}` : '');
  const mode = await info.userAbstraction('0x0000000000000000000000000000000000000001');
  check(['unifiedAccount', 'portfolioMargin', 'disabled', 'default'].includes(mode), 'userAbstraction returns a known account mode', `live: ${mode}`);
}

console.log('\n# HyperCore -> other chains via Circle CCTP (CoreDepositWallet.coreReceiveWithData on HyperEVM)');
{
  const hlRpc = 'https://rpc.hyperliquid.xyz/evm', SYS = '0x2000000000000000000000000000000000000000' as const;
  const cdwAbi = parseAbi(['function calculateCrossChainWithdrawalFee(bool,uint32) view returns (uint256)', 'function coreReceiveWithData(address from, bytes32 destinationRecipient, uint32 destinationChainId, uint256 amount, uint64 coreNonce, bytes data)']);
  for (const d of [0, 3, 5, 6]) {
    const live = await hl.readContract({ address: H.cdw, abi: cdwAbi, functionName: 'calculateCrossChainWithdrawalFee', args: [true, d] });
    const expected = HYPERCORE_CCTP_WITHDRAWAL.cctpMaxFeeRaw + (HYPERCORE_CCTP_WITHDRAWAL.forwardFeeByDomain[d] ?? HYPERCORE_CCTP_WITHDRAWAL.defaultForwardFeeRaw);
    check(live === expected, `withdrawal fee to CCTP domain ${d} matches the previewer`, `live ${live}, previewer ${expected}`);
  }
  const spot = await new HttpHyperliquidInfo(undefined, { retries: 6 }).spotMeta();
  check(spot.tokens.find(t => t.index === 0)?.evmContract?.address.toLowerCase() === H.cdw.toLowerCase(), "USDC's HyperEVM link is Circle's CoreDepositWallet");
  check(spot.tokens.find(t => t.name === 'HYPE')?.evmContract === null, 'native HYPE has no EVM contract link (uses 0x2222…)');
  const magic = '0x' + '636374702d666f7277617264'.padEnd(48, '0');
  const fail = new Set(['withdrawal_below_fee', 'unknown_cctp_domain', 'hook_data_too_large']);
  const me = privateKeyToAccount(generatePrivateKey()).address;
  for (const [label, domain, amount, data] of [
    ['10 USDC to Arbitrum', 3, '10', '0x'], ['0.2 USDC to Arbitrum (= fee)', 3, '0.2', '0x'], ['0.21 USDC to Arbitrum', 3, '0.21', '0x'],
    ['1 USDC to Ethereum (< 1.2 fee)', 0, '1', '0x'], ['10 USDC to domain 42161', 42161, '10', '0x'], ['0.1 USDC, custom data (no fee)', 3, '0.1', '0xaabb'],
    ['10 USDC, forwarding magic + data', 3, '10', magic + 'aabb'], ['10 USDC, 1025 bytes of data', 3, '10', '0x' + '00'.repeat(1025)],
  ] as const) {
    const typed = { domain: { name: 'HyperliquidSignTransaction', version: '1', chainId: 42161, verifyingContract: '0x0000000000000000000000000000000000000000' },
      types: { 'HyperliquidTransaction:SendToEvmWithData': [['hyperliquidChain', 'string'], ['token', 'string'], ['amount', 'string'], ['sourceDex', 'string'], ['destinationRecipient', 'string'], ['addressEncoding', 'string'], ['destinationChainId', 'uint32'], ['gasLimit', 'uint64'], ['data', 'bytes'], ['nonce', 'uint64']].map(([name, type]) => ({ name, type })) },
      primaryType: 'HyperliquidTransaction:SendToEvmWithData',
      message: { hyperliquidChain: 'Mainnet', token: 'USDC', amount, sourceDex: 'spot', destinationRecipient: me, addressEncoding: 'hex', destinationChainId: domain, gasLimit: 200000, data, nonce: Date.now() } };
    const p = await previewRequest({ method: 'eth_signTypedData_v4', params: [me, JSON.stringify(typed)] }, {}, {});
    const predictedFail = p.warnings.some(w => fail.has(w.code));
    await sleep(1000);
    const res = await jsonRpc(hlRpc, { jsonrpc: '2.0', id: 1, method: 'eth_call',
      params: [{ from: SYS, to: H.cdw, data: encodeFunctionData({ abi: cdwAbi, functionName: 'coreReceiveWithData', args: [me, padHex(me), domain, parseUnits(amount, 6), 1n, data as Hex] }) }, 'latest'] });
    const reverted = !!res.error;
    check(predictedFail === reverted, label.padEnd(34), reverted ? `reverts: ${String(res.error.message).replace('execution reverted: ', '')}` : 'succeeds');
  }
}

const urls: Record<number, string> = { 1: ETH_RPC, 42161: RPC, 999: 'https://rpc.hyperliquid.xyz/evm' };
// Same RpcClient contract as JsonRpcClient (node errors carry rpcError), with the rate-limit retries above.
const live: RpcClient = { has: c => !!urls[c], async call(c, method, params) {
  const r = await jsonRpc(urls[c], { jsonrpc: '2.0', id: 1, method, params });
  if (r.error) throw Object.assign(new Error(`${method}: ${r.error.message}`), { rpcError: r.error });
  return r.result;
} };

console.log('\n6. Token metadata, proxy detection, ABI and signature services');
{
  const onchain = new OnchainTokenRegistry(live);
  // A wrong curated decimals value would misstate every amount of that token, so compare with the contract.
  for (const chain of [1, 42161, 999]) {
    for (const t of builtinTokens(chain)) {
      const got = await onchain.get(chain, t.address);
      check(got?.decimals === t.decimals, `${t.symbol} on ${CHAINS[chain].name}: ${t.decimals} decimals`.padEnd(34), got ? `contract says ${got.symbol}, ${got.decimals}` : 'no metadata');
    }
  }
  check(await onchain.get(42161, TMV2) === undefined, 'a non-token contract has no token metadata');
  const mkr = await onchain.get(1, '0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2');
  check(mkr?.symbol === 'MKR' && mkr.decimals === 18, 'MKR: legacy bytes32 symbol() decoded', mkr ? `${mkr.symbol}, ${mkr.name}` : 'no metadata');

  const AAVE_POOL: Address = '0x794a61358D6845594F94dc1DB02A252b5b4814aD';
  for (const [chain, address, label, method] of [
    [1, ETH_USDC, 'Ethereum USDC', 'zeppelinos'], [1, TMV2, 'Ethereum TokenMessengerV2', 'eip1967'], [1, '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2', 'Ethereum Aave V3 Pool', 'eip1967'],
    [42161, USDC, 'Arbitrum USDC', 'zeppelinos'], [42161, TMV2, 'TokenMessengerV2', 'eip1967'], [42161, EXT, 'CctpExtension', null],
    [42161, AAVE_POOL, 'Aave V3 Pool', 'eip1967'], [999, H.cdw, 'CoreDepositWallet', 'eip1967'], [999, FWD, 'CctpForwarder', 'eip1967'],
  ] as const) {
    const found = await detectProxy(live, chain, address);
    check((found?.method ?? null) === method, `proxy: ${label}`.padEnd(34), found ? `${found.method} -> ${found.implementation}` : 'not a proxy');
  }

  const strict = process.env.VERIFY_LIVE_STRICT === '1';
  const service = async (name: string, probe: string, run: () => Promise<void>) => {
    let reachable = false;
    try { const r = await fetch(probe, { signal: AbortSignal.timeout(15_000) }); reachable = r.status !== 403 && r.status !== 407; } catch { reachable = false; }
    if (!reachable) {
      if (strict) check(false, `${name} reachable`, probe);
      else console.log(`skip ${name}: ${new URL(probe).host} not reachable from here`);
      return;
    }
    try { await run(); } catch (e) { check(false, name, (e as Error).message); }
  };
  const nobody = privateKeyToAccount(generatePrivateKey()).address;

  await service('Sourcify', 'https://sourcify.dev/server/chains', async () => {
    const sourcify = new SourcifyAbiSource();
    // The Ethereum deposit contract is Sourcify's own documentation example: verified, exact match.
    const deposit = await sourcify.lookup(1, '0x00000000219ab540356cBB839Cbe05303d7705Fa');
    const ok = deposit?.name === 'DepositContract' && (deposit.abi as { name?: string }[]).some(i => i.name === 'deposit');
    let why = deposit ? `${deposit.name}, ${deposit.source}, ${deposit.abi.length} ABI entries` : 'no ABI';
    if (!ok) {
      const raw = await fetch('https://sourcify.dev/server/v2/contract/1/0x00000000219ab540356cBB839Cbe05303d7705Fa?fields=abi,compilation');
      why += ` | HTTP ${raw.status}, keys: ${Object.keys(await raw.json().catch(() => ({}))).join(',')}`;
    }
    check(ok, 'Sourcify: verified ABI parsed', why);
    check(await sourcify.lookup(1, nobody) === null, 'Sourcify: unverified address is a clean miss');
    // End to end: an Aave supply through the Pool proxy. Decodes from Sourcify when the Pool is verified there,
    // otherwise from the built-in signature list; either way the amount must come out in USDC.
    const deps = { tokens: new ChainedTokenRegistry([new StaticTokenRegistry(), onchain]), abis: new ContractAbiResolver({ sources: [sourcify], rpc: live }), signatures: new ChainedSignatures([]) };
    const data = encodeFunctionData({ abi: parseAbi(['function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)']), functionName: 'supply', args: [USDC, 100_000_000n, nobody, 0] });
    const p = await previewRequest({ method: 'eth_sendTransaction', params: [{ from: nobody, to: AAVE_POOL, data, chainId: '0xa4b1' }] }, {}, deps);
    const d = (label: string) => p.details.find(x => x.label === label)?.value;
    check(d('amount') === '100 USDC' && d('onBehalfOf')?.endsWith('(you)') === true, 'Aave supply preview'.padEnd(34), `${p.decoding.decoder}: "${p.title}", ABI from ${d('ABI source')}`);
  });
  await service('OpenChain', 'https://api.openchain.xyz/signature-database/v1/lookup?function=0xa9059cbb', async () => {
    const sigs = await new OpenChainSignatures().lookup('0xa9059cbb');
    check(sigs.includes('transfer(address,uint256)'), 'OpenChain: 0xa9059cbb is transfer', `${sigs.length} result(s)`);
  });
  await service('4byte', 'https://www.4byte.directory/api/v1/signatures/?hex_signature=0xa9059cbb', async () => {
    const sigs = await new FourByteSignatures().lookup('0xa9059cbb');
    check(sigs.includes('transfer(address,uint256)'), '4byte: 0xa9059cbb is transfer', `${sigs.length} result(s)`);
    // 4byte also lists spam for this selector that fits the same calldata (e.g. workMyDirefulOwner(uint256,uint256)).
    // Ranking must still pick transfer, with OpenChain and with 4byte alone (oldest registration).
    const data = encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [nobody, 5n] });
    const tx = { chainId: 42161, from: nobody, to: '0x4000000000000000000000000000000000000004', data, value: 0n };
    for (const [label, sources] of [['OpenChain + 4byte', [new OpenChainSignatures(), new FourByteSignatures()]], ['4byte alone', [new FourByteSignatures()]]] as const) {
      const r = await abiAdapter(tx, { deps: { signatures: new ChainedSignatures([...sources], { builtIn: false }) }, context: {} });
      check(r?.title === 'Call transfer on 0x4000…0004', `selector collisions, ${label}`.padEnd(34), `${r?.title}; ${r?.b.warnings.map(w => w.code).join(', ')}`);
    }
  });
  if (process.env.ETHERSCAN_API_KEY) {
    await service('Etherscan', 'https://api.etherscan.io/v2/chainlist', async () => {
      const es = new EtherscanAbiSource(process.env.ETHERSCAN_API_KEY!);
      const tm = await es.lookup(42161, TMV2);
      check(!!tm && tm.abi.length > 0, 'Etherscan: TokenMessengerV2 ABI', tm ? `${tm.name}, ${tm.abi.length} ABI entries` : 'no ABI');
      await sleep(500);
      check(await es.lookup(42161, nobody) === null, 'Etherscan: unverified address is a clean miss');
    });
  } else console.log('skip Etherscan: ETHERSCAN_API_KEY not set');
}

console.log('\n7. Simulated NFT transfers and approvals set along the way');
{
  const tokens = new ChainedTokenRegistry([new StaticTokenRegistry(), new OnchainTokenRegistry(live)]);
  const simulator = new RpcSimulator({ 1: ETH_RPC, 42161: RPC });
  // Uniswap Universal Router command 0x0a (PERMIT2_PERMIT): the router sets a Permit2 allowance mid-transaction,
  // signed here by a fresh throwaway key.
  const PERMIT2_ADDR: Address = '0x000000000022D473030F116dDEE9F6B43aC78BA3', UR: Address = '0xA51afAFe0263b40EdaEf0Df8781eA9aa03E381a3';
  const signer = privateKeyToAccount(generatePrivateKey());
  const now = Number(T), expiration = now + 30 * 86400, max160 = (1n << 160n) - 1n;
  const details = { token: USDC, amount: max160, expiration, nonce: 0 };
  const permit = { details, spender: UR, sigDeadline: BigInt(now + 3600) };
  const signature = await signer.signTypedData({ domain: { name: 'Permit2', chainId: 42161, verifyingContract: PERMIT2_ADDR },
    types: { PermitDetails: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }],
      PermitSingle: [{ name: 'details', type: 'PermitDetails' }, { name: 'spender', type: 'address' }, { name: 'sigDeadline', type: 'uint256' }] },
    primaryType: 'PermitSingle', message: permit });
  const input = encodeAbiParameters([{ type: 'tuple', components: [{ name: 'details', type: 'tuple', components: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }] }, { name: 'spender', type: 'address' }, { name: 'sigDeadline', type: 'uint256' }] }, { type: 'bytes' }], [permit, signature]);
  const execute = encodeFunctionData({ abi: parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline)']), functionName: 'execute', args: ['0x0a', [input], BigInt(now + 3600)] });
  const ur = await previewRequest({ method: 'eth_sendTransaction', params: [{ from: signer.address, to: UR, data: execute, chainId: '0xa4b1' }] }, { now: now * 1000 }, { tokens, simulator });
  const a = ur.approvals?.[0];
  // The router decoder shows the permit as a step, so the allowance read back from Permit2 counts as shown (direct),
  // not as set along the way; the decoder's own note covers it.
  const codesUr = ur.warnings.map(w => w.code);
  check(a?.kind === 'permit2' && a.allowance === 'unlimited' && a.direct && a.expiration === expiration && a.basis === 'simulated_state' && codesUr.includes('router_permit2_allowance') && !codesUr.includes('hidden_unlimited_approval'),
    'Permit2 allowance via the router'.padEnd(34), a ? `${a.symbol} -> ${a.spender}: ${a.allowance}, direct ${a.direct}, ${a.basis} | "${ur.title}"` : `no approval; simulation ${ur.simulation?.status} ${ur.simulation?.revertReason ?? ''}`);
  await sleep(1000);
  // ERC-721: BAYC #1 moved by its current owner. The collection name comes from the contract; BAYC also emits an
  // approval-clearing event on transfer, which must not be listed.
  const BAYC: Address = '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D';
  const ownerWord = String(await live.call(1, 'eth_call', [{ to: BAYC, data: '0x6352211e' + '1'.padStart(64, '0') }, 'latest']));
  const owner = ('0x' + ownerWord.slice(26)) as Address;
  const transfer = encodeFunctionData({ abi: parseAbi(['function safeTransferFrom(address from, address to, uint256 tokenId)']), functionName: 'safeTransferFrom', args: [owner, '0x1000000000000000000000000000000000000001', 1n] });
  const nft = await previewRequest({ method: 'eth_sendTransaction', params: [{ from: owner, to: BAYC, data: transfer, chainId: '0x1' }] }, {}, { tokens, simulator });
  const moved = nft.assetChanges.map(c => `${c.direction} ${c.amount} ${c.symbol} (${c.standard})`).join(', ');
  check(moved === 'out 1 BAYC #1 (erc721)' && !nft.approvals?.length, 'ERC-721 transfer (BAYC #1)'.padEnd(34), `${moved || 'no changes'}${nft.approvals?.length ? `; approvals: ${nft.approvals.length}` : ''}`);
}

console.log('\n8. Recent real Uniswap Universal Router transactions on Ethereum');
{
  const tokens = new ChainedTokenRegistry([new StaticTokenRegistry(), new OnchainTokenRegistry(live)]);
  const routers = Object.entries(UNIVERSAL_ROUTERS).filter(([, v]) => v.chainId === 1).map(([a]) => a);
  const sym = async (a: string) => a === 'native' ? 'ETH' : (await tokens.get(1, a))?.symbol ?? a;
  let n = BigInt(String(await live.call(1, 'eth_blockNumber', []))) - 2n;
  const txs: { hash: string; from: string; to: string; input: Hex; value: string; ts: number }[] = [];
  for (let i = 0; i < 40 && txs.length < 10; i++, n--) {
    const blk = await live.call(1, 'eth_getBlockByNumber', ['0x' + n.toString(16), true]) as { timestamp: string; transactions: { hash: string; from: string; to: string | null; input: Hex; value: string }[] };
    for (const t of blk.transactions) if (t.to && routers.includes(t.to.toLowerCase()) && txs.length < 10) txs.push({ ...t, to: t.to, ts: Number(blk.timestamp) });
  }
  const bad: string[] = [];
  let matched = 0, unheadlined = 0;
  for (const t of txs) {
    const r = await live.call(1, 'eth_getTransactionReceipt', [t.hash]) as { status: string; blockNumber: string; gasUsed: string; effectiveGasPrice: string; logs: { address: string; topics: string[]; data: string }[] };
    if (r.status !== '0x1') continue; // reverted: nothing moved to compare with
    const p = await previewRequest({ method: 'eth_sendTransaction', params: [{ from: t.from, to: t.to, data: t.input, value: t.value, chainId: '0x1' }] }, { now: t.ts * 1000 }, { tokens });
    if (p.decoding.status !== 'full') { bad.push(`${t.hash}: not fully decoded (${p.details.filter(d => /not decoded|could not|Unknown/.test(d.value)).map(d => d.value).join('; ')})`); continue; }
    const m = /^Swap (?:up to )?(?:[\d,.]+ )?(\S+) for (?:at least )?[\d,.]+ (\S+)$/.exec(p.title);
    if (!m) { unheadlined++; continue; }
    // What the sender paid and received: token transfer logs, plus native ETH from balance changes (Uniswap v4 and
    // unwraps pay ETH out as internal transfers). Outputs flagged as going elsewhere are checked at that address.
    const from = t.from.toLowerCase(), bn = BigInt(r.blockNumber);
    const bal = async (a: string, b: bigint) => BigInt(String(await live.call(1, 'eth_getBalance', [a, '0x' + b.toString(16)])));
    const net = new Map<string, bigint>();
    const logs = parseLogs(r.logs);
    for (const x of logs.transfers) { if (x.from === from) net.set(x.asset, (net.get(x.asset) ?? 0n) - x.raw); if (x.to === from) net.set(x.asset, (net.get(x.asset) ?? 0n) + x.raw); }
    const ethIn = (await bal(from, bn)) - (await bal(from, bn - 1n)) + BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice);
    net.set('native', (net.get('native') ?? 0n) + ethIn); // value paid shows as a negative balance change
    const paid = await Promise.all([...net].filter(([, v]) => v < 0n).map(([k]) => sym(k)));
    const got = await Promise.all([...net].filter(([, v]) => v > 0n).map(([k]) => sym(k)));
    for (const a of new Set([...(p.warnings.find(w => w.code === 'output_to_other')?.message ?? '').matchAll(/0x[0-9a-fA-F]{40}/g)].map(x => x[0].toLowerCase()))) {
      if ((await bal(a, bn)) > (await bal(a, bn - 1n))) got.push('ETH');
      for (const x of logs.transfers) if (x.to === a) got.push(await sym(x.asset));
    }
    if (paid.includes(m[1]) && got.includes(m[2])) matched++;
    else bad.push(`${t.hash}: "${p.title}" but the chain shows paid ${paid.join('+') || 'nothing'}, received ${got.join('+') || 'nothing'}`);
  }
  check(txs.length > 0, 'recent router transactions found'.padEnd(34), `${txs.length} in the last 40 blocks`);
  check(bad.length === 0, 'real swaps decode and match'.padEnd(34), `${matched} matched${unheadlined ? `, ${unheadlined} multi-step without a single headline` : ''}${bad.length ? ' | ' + bad.join(' | ') : ''}`);
}

console.log('\n9. Kinetiq and HyperLend on HyperEVM');
{
  const tokens = new ChainedTokenRegistry([new StaticTokenRegistry(), new OnchainTokenRegistry(live)]);
  const simulator = new RpcSimulator({ 999: urls[999] });
  const deps = { tokens, rpc: live, simulator };
  const hlCall = async (to: string, sig: string, args: unknown[] = []) => readAt(hl, to as Address, sig, args);
  const k = KINETIQ[999];
  check(String(await hlCall(k.stakingManager, 'function tokenAddress() view returns (address)')).toLowerCase() === k.kHYPE, 'Kinetiq StakingManager mints kHYPE'.padEnd(34));
  const facetOf = async (fn: string) => String(await hlCall(k.stakingManager, 'function getFacetAddress(bytes4) view returns (address)', [toFunctionSelector(`function ${fn}`)]));
  const missing = [];
  for (const fn of ['stake()', 'stake(address)', 'queueWithdrawal(uint256)', 'confirmWithdrawal(uint256)', 'batchConfirmWithdrawals(uint256[])', 'instantUnstake(uint256,uint256)', 'redelegate(address,address,uint256)']) if (/^0x0{40}$/.test(await facetOf(fn))) missing.push(fn);
  check(!missing.length, 'Kinetiq decoded functions exist'.padEnd(34), missing.length ? `no facet for ${missing.join(', ')}` : '7 selectors resolve to facets');
  const RICH = '0x5555555555555555555555555555555555555555'; // WHYPE holds HYPE: a sender for eth_call
  const stake = (value: bigint) => previewRequest({ method: 'eth_sendTransaction', params: [{ from: RICH, to: k.stakingManager, data: '0x3a4b66f1', value: toHex(value), chainId: '0x3e7' }] }, {}, deps);
  const ok = await stake(10n ** 19n);
  check(/^Stake 10 HYPE for ≈ [\d.]+ kHYPE$/.test(ok.title) && ok.simulation?.status === 'success', 'Kinetiq stake 10 HYPE'.padEnd(34), `"${ok.title}", eth_call ${ok.simulation?.status}`);
  for (const [label, value, code, chain] of [['below the minimum', 2n * 10n ** 18n, 'kinetiq_below_minimum', 'BelowMinimum'], ['not 8-decimal', 10n ** 19n + 1n, 'kinetiq_amount_precision', 'MustBeDivisibleBy1e10']] as const) {
    await sleep(500);
    const p = await stake(value);
    check(p.warnings.some(w => w.code === code) && (p.simulation?.revertReason ?? '').startsWith(chain), `Kinetiq stake ${label}`.padEnd(34), `decoder: ${p.warnings.some(w => w.code === code) ? 'will fail' : 'no warning'}; chain: ${p.simulation?.revertReason ?? p.simulation?.status}`);
  }

  const m = HYPERLEND[999];
  check(String(await hlCall(m.addressesProvider, 'function getMarketId() view returns (string)')) === 'HyperLend Market' && String(await hlCall(m.addressesProvider, 'function getPool() view returns (address)')).toLowerCase() === m.pool,
    'HyperLend provider -> Pool'.padEnd(34));
  const debt = String(await hlCall(m.pool, 'function getReserveVariableDebtToken(address) view returns (address)', [H.usdc]));
  check(String(await hlCall(debt, 'function DELEGATION_WITH_SIG_TYPEHASH() view returns (bytes32)')) === keccak256(toHex('DelegationWithSig(address delegatee,uint256 value,uint256 nonce,uint256 deadline)')),
    'HyperLend debt token delegation'.padEnd(34), `USDC debt token ${debt}: Aave DelegationWithSig typehash`);
  // A live borrower from recent Borrow events.
  const BORROW = keccak256(toHex('Borrow(address,address,address,uint256,uint8,uint256,uint16)'));
  const head = BigInt(String(await live.call(999, 'eth_blockNumber', [])));
  let borrower: string | undefined;
  for (let to = head; !borrower && to > head - 30_000n; to -= 1000n) {
    const logs = await live.call(999, 'eth_getLogs', [{ address: m.pool, topics: [BORROW], fromBlock: '0x' + (to - 999n).toString(16), toBlock: '0x' + to.toString(16) }]) as { topics: string[] }[];
    for (const l of logs.reverse()) {
      const user = '0x' + l.topics[2].slice(26);
      const [collateral, debtBase, , lt, , hf] = await hlCall(m.pool, 'function getUserAccountData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256)', [user]) as bigint[];
      if (debtBase > 0n && hf < 10n ** 20n) {
        borrower = user;
        const formula = collateral * lt * 10n ** 18n / (debtBase * 10_000n);
        const diff = Number(formula > hf ? formula - hf : hf - formula) / Number(hf);
        check(diff < 0.001, 'HyperLend health-factor formula'.padEnd(34), `borrower ${user}: Pool ${formatUnits(hf, 18)}, formula ${formatUnits(formula, 18)}`);
        break;
      }
    }
  }
  // Withdrawing all of a collateral asset the borrower holds: the decoder's health-factor estimate decides whether
  // it predicts a failure, and eth_call says whether HyperLend actually refuses it.
  let collateralAsset: string | undefined;
  if (borrower) {
    for (const asset of await hlCall(m.pool, 'function getReservesList() view returns (address[])') as string[]) {
      const hToken = String(await hlCall(m.pool, 'function getReserveAToken(address) view returns (address)', [asset]));
      if ((await hlCall(hToken, 'function balanceOf(address) view returns (uint256)', [borrower]) as bigint) > 0n) { collateralAsset = asset; break; }
    }
  }
  if (borrower && collateralAsset) {
    const p = await previewRequest({ method: 'eth_sendTransaction', params: [{ from: borrower, to: m.pool, data: encodeFunctionData({ abi: parseAbi(['function withdraw(address,uint256,address)']), functionName: 'withdraw', args: [collateralAsset as Address, 2n ** 256n - 1n, borrower as Address] }), chainId: '0x3e7' }] }, {}, deps);
    const predicted = p.warnings.some(w => w.code === 'lending_will_fail'), reverted = p.simulation?.status === 'reverted';
    // Only meaningful when the borrower's debt depends on WHYPE collateral: then both must say it fails.
    check(predicted === reverted || (!predicted && !p.details.some(d => d.label === 'Health factor (estimated)')), 'HyperLend withdraw-all prediction'.padEnd(34), `decoder: ${predicted ? 'will fail' : 'ok'} (${p.details.find(d => d.label === 'Health factor (estimated)')?.value ?? 'no HF'}); chain: ${p.simulation?.revertReason ?? p.simulation?.status}`);
  } else console.log('skip HyperLend withdraw check: no recent borrower with supplied collateral found');
}

console.log('\n10. HyperEVM simulation with the state-override probe (the RPC has no eth_simulateV1)');
{
  const tokens = new ChainedTokenRegistry([new StaticTokenRegistry(), new OnchainTokenRegistry(live)]);
  const deps = { tokens, rpc: live, simulator: new RpcSimulator({ 999: urls[999] }) };
  const E = 10n ** 18n, k = KINETIQ[999], m = HYPERLEND[999];
  const send = (from: string, to: string, data: Hex, value = 0n) => previewRequest({ method: 'eth_sendTransaction', params: [{ from, to, data, value: toHex(value), chainId: '0x3e7' }] }, {}, deps);
  const moved = (p: Awaited<ReturnType<typeof send>>) => p.assetChanges.map(c => `${c.direction} ${c.amount} ${c.symbol} (${c.basis})`).join(', ');
  // Real holders without code: a HYPE holder among recent senders, and a recent USDC recipient.
  const head = BigInt(String(await live.call(999, 'eth_blockNumber', [])));
  const eoa = async (a: string) => String(await live.call(999, 'eth_getCode', [a, 'latest'])) === '0x';
  let hypeHolder: string | undefined, usdcHolder: string | undefined;
  for (let n = head - 2n; n > head - 600n && !(hypeHolder && usdcHolder); n -= 3n) {
    const blk = await live.call(999, 'eth_getBlockByNumber', [toHex(n), true]) as { transactions: { from: string }[] };
    for (const t of blk.transactions) if (!hypeHolder && BigInt(String(await live.call(999, 'eth_getBalance', [t.from, 'latest']))) >= 12n * E && await eoa(t.from)) hypeHolder = t.from.toLowerCase();
    if (usdcHolder) continue;
    const receipts = await live.call(999, 'eth_getBlockReceipts', [toHex(n)]) as { logs: { address: string; topics: string[] }[] }[];
    for (const l of receipts.flatMap(r => r.logs)) {
      if (usdcHolder || l.address.toLowerCase() !== H.usdc.toLowerCase() || l.topics.length !== 3 || l.topics[0] !== keccak256(toHex('Transfer(address,address,uint256)'))) continue;
      const to = '0x' + l.topics[2].slice(26);
      if ((await readAt(hl, H.usdc, 'function balanceOf(address) view returns (uint256)', [to]) as bigint) >= 2_000_000n && await eoa(to)) usdcHolder = to;
    }
  }
  if (hypeHolder) {
    const accountant = String(await readAt(hl, k.stakingManager as Address, 'function stakingAccountant() view returns (address)'));
    const quote = await readAt(hl, accountant as Address, 'function HYPEToKHYPE(uint256) view returns (uint256)', [10n * E]) as bigint;
    const p = await send(hypeHolder, k.stakingManager, '0x3a4b66f1', 10n * E);
    const kIn = p.assetChanges.find(c => c.asset === k.kHYPE && c.direction === 'in');
    check(p.simulation?.status === 'success' && p.assetChanges.some(c => c.asset === 'native' && c.direction === 'out' && c.raw === (10n * E).toString() && c.basis === 'simulated_state') && kIn?.raw === quote.toString(),
      'probe: Kinetiq stake 10 HYPE'.padEnd(34), `${moved(p)}; Kinetiq quotes ${formatUnits(quote, 18)} kHYPE`);
  } else console.log('skip probe stake: no recent EOA sender holding 12 HYPE');
  if (usdcHolder) {
    const t = await send(usdcHolder, H.usdc, encodeFunctionData({ abi: parseAbi(['function transfer(address,uint256)']), functionName: 'transfer', args: ['0x000000000000000000000000000000000000dEaD', 1_000_000n] }));
    check(t.simulation?.status === 'success' && moved(t) === 'out 1 USDC (simulated_state)', 'probe: USDC transfer of 1'.padEnd(34), moved(t));
    const batch = await previewRequest({ method: 'wallet_sendCalls', params: [{ version: '2.0.0', chainId: '0x3e7', from: usdcHolder, atomicRequired: true, calls: [
      { to: H.usdc, data: encodeFunctionData({ abi: parseAbi(['function approve(address,uint256)']), functionName: 'approve', args: [m.pool as Address, 1_000_000n] }) },
      { to: m.pool, data: encodeFunctionData({ abi: parseAbi(['function supply(address,uint256,address,uint16)']), functionName: 'supply', args: [H.usdc, 1_000_000n, usdcHolder as Address, 0] }) },
    ] }] }, {}, deps);
    const hIn = batch.assetChanges.find(c => c.direction === 'in');
    // The hUSDC isn't in the calldata: HyperLend's decoder watches it. Aave-style scaled balances round by a unit or two.
    check(batch.simulation?.status === 'success' && batch.assetChanges.some(c => c.direction === 'out' && c.raw === '1000000') && !!hIn && Math.abs(Number(hIn.raw) - 1_000_000) <= 2,
      'probe: approve + HyperLend supply'.padEnd(34), `${batch.simulation?.status}: ${moved(batch)}`);
  } else console.log('skip probe USDC checks: no recent EOA holding 2 USDC');
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
