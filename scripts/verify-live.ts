// Opt-in live check (network): `npm run verify:live`. Read-only, nothing is signed with a real key or broadcast.
//  1. Reads the deployed CCTP / HyperCore configuration the previewer relies on.
//  2. Simulates Circle's Arbitrum -> HyperCore guide transactions (and known mistakes) with eth_simulateV1 on
//     Arbitrum One, funding a fresh throwaway address from a large USDC holder inside the simulation only.
//  3. Checks CoreDepositWallet's recipient rules on HyperEVM with eth_call + a USDC balance/allowance override.
// Exits non-zero if the chain and the previewer disagree. Needs network access to arb1.arbitrum.io and
// rpc.hyperliquid.xyz (behind a proxy, run with NODE_USE_ENV_PROXY=1 on Node >= 22.21).
import { createPublicClient, http, encodeFunctionData, decodeEventLog, decodeErrorResult, encodeAbiParameters, keccak256, pad as padHex, parseAbi, parseAbiItem, parseUnits, toHex, type Hex, type Address } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { previewRequest } from '../src/preview.ts';
import { StaticTokenRegistry } from '../src/chains.ts';

const RPC = 'https://arb1.arbitrum.io/rpc';
const client = createPublicClient({ transport: http(RPC) });
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
async function rpc(body: unknown) {
  for (let i = 0; i < 6; i++) {
    const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (res.status !== 429) return res.json();
    await sleep(3000 * (i + 1));
  }
  throw new Error('rate limited');
}
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
const hl = createPublicClient({ transport: http('https://rpc.hyperliquid.xyz/evm') });
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
  const res = await fetch('https://rpc.hyperliquid.xyz/evm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call',
    params: [{ from: me, to: H.cdw, data: encodeFunctionData({ abi: depositFor, functionName: 'depositFor', args: [recipient as Address, amt, dex] }) }, 'latest', override] }) }).then(x => x.json());
  const got = res.error ? String(res.error.message).replace('execution reverted: ', '') : null;
  check(got === expectRevert, label.padEnd(34), got ? `reverts: ${got}` : 'succeeds');
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
