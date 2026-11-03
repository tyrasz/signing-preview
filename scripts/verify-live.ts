// Opt-in live check (network): `npm run verify:live`. Read-only, nothing is signed with a real key or broadcast.
//  1. Reads the deployed CCTP / HyperCore configuration the previewer relies on.
//  2. Simulates Circle's Arbitrum -> HyperCore guide transactions (and known mistakes) with eth_simulateV1 on
//     Arbitrum One, funding a fresh throwaway address from a large USDC holder inside the simulation only.
//  3. Checks CoreDepositWallet's recipient rules on HyperEVM with eth_call + a USDC balance/allowance override.
//  4. Resolves every live HyperCore asset ID (perps, spot, HIP-3, outcomes) to a named, priced market.
//  5. Checks HyperCore -> other-chain withdrawal fees and runs CoreDepositWallet's HyperEVM withdrawal step
//     (eth_call from the USDC system address), comparing each outcome with the preview's prediction.
//  6. Checks the curated token list's decimals against each token contract, on-chain metadata reads and proxy
//     detection on deployed contracts, and the Sourcify / OpenChain / 4byte (and, with ETHERSCAN_API_KEY,
//     Etherscan) response shapes. A service that can't be reached is skipped, unless VERIFY_LIVE_STRICT=1 (CI).
// Exits non-zero if the chain and the previewer disagree. Needs network access to arb1.arbitrum.io,
// rpc.hyperliquid.xyz and api.hyperliquid.xyz, plus sourcify.dev, api.openchain.xyz and www.4byte.directory
// for step 6 (behind a proxy, run with NODE_USE_ENV_PROXY=1 on Node >= 22.21).
import { createPublicClient, http, encodeFunctionData, decodeEventLog, decodeErrorResult, encodeAbiParameters, keccak256, pad as padHex, parseAbi, parseAbiItem, parseUnits, toHex, type Hex, type Address } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { previewRequest } from '../src/preview.ts';
import { builtinTokens, CHAINS, HYPERCORE_CCTP_WITHDRAWAL, StaticTokenRegistry } from '../src/chains.ts';
import { ChainedTokenRegistry, OnchainTokenRegistry } from '../src/tokens.ts';
import { ChainedSignatures, ContractAbiResolver, detectProxy, EtherscanAbiSource, FourByteSignatures, OpenChainSignatures, SourcifyAbiSource } from '../src/abi.ts';
import type { RpcClient } from '../src/rpc.ts';
import { HttpHyperliquidInfo } from '../src/hyperliquid/info.ts';
import { resolveAsset } from '../src/hyperliquid/assets.ts';

const RPC = 'https://arb1.arbitrum.io/rpc';
const client = createPublicClient({ transport: http(RPC, { retryCount: 6, retryDelay: 2000 }) });
const USDC: Address = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const EXT: Address = '0xA95d9c1F655341597C94393fDdc30cf3c08E4fcE';
const TMV2: Address = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d';
const FWD: Address = '0xb21D281DEdb17AE5B501F6AA8256fe38C4e45757';
const FUNDER: Address = '0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7'; // large USDC holder, used only inside the simulation
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

interface Case { id: string; via: 'ext' | 'tmv2'; amount: string; batch?: string; maxFee: string; hook?: Hex; dex?: number; validBefore?: bigint; finality?: number }
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
const rpc = (body: unknown) => jsonRpc(RPC, body);
const block = await client.getBlock();
const T = block.timestamp;
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
];

const deps = { tokens: new StaticTokenRegistry() };
const rows = [];
for (const c of cases) {
  const amount = parseUnits(c.amount, 6), batch = parseUnits(c.batch ?? c.amount, 6), maxFee = parseUnits(c.maxFee, 6);
  const hook = c.hook ?? encodeForwardHookData(account.address, c.dex ?? 0);
  const funding = { from: FUNDER, to: USDC, data: encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [account.address, amount] }) };
  const calls: { from: Address; to: Address; data: Hex }[] = [funding];
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
    calls.push({ from: account.address, to: USDC, data: encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [TMV2, amount] }) });
    const data = encodeFunctionData({ abi: TMV2_ABI, functionName: 'depositForBurnWithHook', args: [amount, 19, pad(FWD), USDC, pad(FWD), maxFee, c.finality ?? 1000, hook] });
    calls.push({ from: account.address, to: TMV2, data });
    request = { method: 'eth_sendTransaction', params: [{ from: account.address, to: TMV2, data, chainId: '0xa4b1' }] };
  }
  calls.push({ from: account.address, to: USDC, data: encodeFunctionData({ abi: ERC20, functionName: 'balanceOf', args: [account.address] }) });
  await sleep(1500);
  const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'eth_simulateV1', params: [{ blockStateCalls: [{ calls }], validation: false }, toHex(block.number)] });
  if (res.error) { rows.push({ id: c.id, error: res.error.message }); continue; }
  const results = res.result[0].calls;
  const main = results[results.length - 2];
  let revert = null;
  if (main.status !== '0x1') { try { revert = decodeErrorResult({ abi: ERRORS, data: main.error?.data ?? main.returnData }).args[0]; } catch { revert = main.error?.message ?? main.returnData; } }
  const burns = (main.logs ?? []).flatMap((l: { address: string; topics: Hex[]; data: Hex }) => { try { const e = decodeEventLog({ abi: [DEPOSIT_FOR_BURN], data: l.data, topics: l.topics as [Hex] }); return [e.args]; } catch { return []; } });
  const balanceAfter = BigInt(results[results.length - 1].returnData);
  const p = await previewRequest(request, { chainId: 42161, account: account.address, now: Number(T) * 1000 }, deps);
  rows.push({
    id: c.id,
    chain: main.status === '0x1' ? 'success' : `revert: ${revert}`,
    burnEvents: burns.length,
    burned: (amount - balanceAfter).toString(),
    eventFields: burns[0] ? { amount: burns[0].amount.toString(), maxFee: burns[0].maxFee.toString(), finality: burns[0].minFinalityThreshold, mintRecipientIsFwd: burns[0].mintRecipient.toLowerCase() === pad(FWD).toLowerCase(), callerIsFwd: burns[0].destinationCaller.toLowerCase() === pad(FWD).toLowerCase(), hookBytes: (burns[0].hookData.length - 2) / 2 } : null,
    preview: { title: p.title, attention: p.attention, warnings: p.warnings.map(w => `${w.severity}:${w.code}`), amountOut: p.assetChanges.map(a => a.raw).join(','), expected: p.details.find(d => d.label.startsWith('Expected on HyperCore'))?.value ?? null },
  });
}
let failures = 0;
const check = (ok: boolean, label: string, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? '  ' + detail : ''}`); };

console.log(`\n# Arbitrum One simulations at block ${block.number}`);
for (const r of rows as any[]) {
  if (r.error) { check(false, r.id, r.error); continue; }
  const reverted = r.chain !== 'success';
  const predictedRevert = r.preview.title.includes('will fail');
  const stuck = !reverted && r.eventFields && r.eventFields.hookBytes < 52;
  const predictedStuck = r.preview.warnings.includes('danger:cctp_bad_hook');
  const outflow = reverted ? r.preview.amountOut === '' : r.preview.amountOut === r.burned;
  check(predictedRevert === reverted && predictedStuck === !!stuck && outflow, r.id.padEnd(24), `${r.chain} | preview: ${r.preview.attention} "${r.preview.title}"`);
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

console.log('\n6. Token metadata, proxy detection, ABI and signature services');
{
  const urls: Record<number, string> = { 42161: RPC, 999: 'https://rpc.hyperliquid.xyz/evm' };
  // Same RpcClient contract as JsonRpcClient (node errors carry rpcError), with the rate-limit retries above.
  const live: RpcClient = { has: c => !!urls[c], async call(c, method, params) {
    const r = await jsonRpc(urls[c], { jsonrpc: '2.0', id: 1, method, params });
    if (r.error) throw Object.assign(new Error(`${method}: ${r.error.message}`), { rpcError: r.error });
    return r.result;
  } };
  const onchain = new OnchainTokenRegistry(live);
  // A wrong curated decimals value would misstate every amount of that token, so compare with the contract.
  for (const chain of [42161, 999]) {
    for (const t of builtinTokens(chain)) {
      const got = await onchain.get(chain, t.address);
      check(got?.decimals === t.decimals, `${t.symbol} on ${CHAINS[chain].name}: ${t.decimals} decimals`.padEnd(34), got ? `contract says ${got.symbol}, ${got.decimals}` : 'no metadata');
    }
  }
  check(await onchain.get(42161, TMV2) === undefined, 'a non-token contract has no token metadata');

  const AAVE_POOL: Address = '0x794a61358D6845594F94dc1DB02A252b5b4814aD';
  for (const [chain, address, label, method] of [
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

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
