// Golden tests built from Circle's documentation, copied verbatim where marked (those excerpts are
// Circle's, quoted so the tests reproduce the documented transactions exactly):
//   "Transfer USDC from Arbitrum to HyperCore" (developers.circle.com, snapshot 2026-10-29)
//   "Transfer USDC from Ethereum to HyperCore" (same snapshot)
//   "Circle Forwarding Service for CCTP" (same snapshot)
// and the failure rules of circlefin/hyperevm-circle-contracts @ ffcc978 (CctpForwarder, CctpForwarderHookData,
// CoreDepositWallet, CctpExtension) and evm-cctp-contracts @ a92a2b4 (TokenMessengerV2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { concat, encodeFunctionData, hashTypedData, parseAbi, parseUnits, stringToHex, toHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { previewRequest } from '../src/preview.ts';
import { analyzeForwardHook } from '../src/evm/cctp.ts';
import { CCTP_NETWORKS, HYPEREVM_MAINNET, HYPEREVM_TESTNET } from '../src/chains.ts';
import type { Preview } from '../src/types.ts';
import { codes, detail, mockDeps } from './helpers.ts';

// Throwaway key for test signatures only.
const account = privateKeyToAccount('0x1111111111111111111111111111111111111111111111111111111111111111');
const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);
const NOW_S = Math.floor(NOW / 1000);
const OTHER = '0xb0b0000000000000000000000000000000000002';

// ---- Verbatim from the Arbitrum → HyperCore guide ----
function encodeForwardHookData(
  hyperCoreMintRecipient?: `0x${string}`,
  hyperCoreDestinationDex: number = 0,
): `0x${string}` {
  if (hyperCoreMintRecipient && !hyperCoreMintRecipient.startsWith("0x")) {
    throw new Error("Address must start with 0x");
  }
  const magic = "cctp-forward";
  const magicHex = Buffer.from(magic, "utf-8").toString("hex").padEnd(48, "0");
  const version = "00000000";
  if (!hyperCoreMintRecipient) {
    const dataLength = "00000000";
    return `0x${magicHex}${version}${dataLength}`;
  }
  const dataLength = "00000018";
  const address = hyperCoreMintRecipient.slice(2).toLowerCase();
  const dex = (hyperCoreDestinationDex >>> 0).toString(16).padStart(8, "0");
  return `0x${magicHex}${version}${dataLength}${address}${dex}`;
}

const CCTP_EXTENSION_ABI = [
  {
    name: "batchDepositForBurnWithAuth",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "_receiveWithAuthorizationData",
        type: "tuple",
        components: [
          { name: "amount", type: "uint256" },
          { name: "authValidAfter", type: "uint256" },
          { name: "authValidBefore", type: "uint256" },
          { name: "authNonce", type: "bytes32" },
          { name: "v", type: "uint8" },
          { name: "r", type: "bytes32" },
          { name: "s", type: "bytes32" },
        ],
      },
      {
        name: "_depositForBurnData",
        type: "tuple",
        components: [
          { name: "amount", type: "uint256" },
          { name: "destinationDomain", type: "uint32" },
          { name: "mintRecipient", type: "bytes32" },
          { name: "destinationCaller", type: "bytes32" },
          { name: "maxFee", type: "uint256" },
          { name: "minFinalityThreshold", type: "uint32" },
          { name: "hookData", type: "bytes" },
        ],
      },
    ],
    outputs: [],
  },
] as const;
// ---- end verbatim ----

interface GuideOptions {
  chainId: number;
  amount?: string;          // total USDC (guide: "2")
  batchSize?: string;       // _depositForBurnData.amount (guide: same as amount)
  maxFee?: string;          // guide: "0.2"
  destinationDex?: number;  // guide: 0
  recipient?: Address;      // guide: FORWARD_RECIPIENT
  hookData?: Hex;           // override (guide: encodeForwardHookData(recipient, dex))
  mintRecipient?: Address;  // guide: cctpForwarder
  destinationCaller?: Address;
  minFinalityThreshold?: number;
  validBefore?: number;
}

/** Builds the two wallet requests the guide's script produces: the EIP-3009 signature and the deposit transaction. */
async function guideFlow(o: GuideOptions) {
  const net = CCTP_NETWORKS[o.chainId];
  const config = {
    cctpExtension: net.cctpExtension as Address,
    usdcToken: net.usdc as Address,
    amount: o.amount ?? '2',
    maxFee: o.maxFee ?? '0.2',
    destinationDomain: 19,
    cctpForwarder: net.hyperEvm.forwarder as Address,
    forwardRecipient: o.recipient ?? account.address,
    destinationDex: o.destinationDex ?? 0,
    validAfter: NOW_S - 3600,
    validBefore: o.validBefore ?? NOW_S + 3600,
  };
  const amount = parseUnits(config.amount, 6);
  const batch = parseUnits(o.batchSize ?? config.amount, 6);
  const maxFee = parseUnits(config.maxFee, 6);
  const hookData = o.hookData ?? encodeForwardHookData(config.forwardRecipient, config.destinationDex);
  const pad = (a: Address) => `0x${a.slice(2).padStart(64, '0')}` as Hex;
  const nonce = ('0x' + 'ab'.repeat(32)) as Hex;
  // Signed exactly as in the guide's script (viem signTypedData with these domain/types/message).
  const domain = { name: 'USD Coin', version: '2', chainId: o.chainId, verifyingContract: config.usdcToken } as const;
  const types = {
    ReceiveWithAuthorization: [
      { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
    ],
  } as const;
  const message = { from: account.address, to: config.cctpExtension, value: amount, validAfter: BigInt(config.validAfter), validBefore: BigInt(config.validBefore), nonce };
  const signature = await account.signTypedData({ domain, types, primaryType: 'ReceiveWithAuthorization', message });
  // The eth_signTypedData_v4 payload viem sends to an injected wallet for that call.
  const typedData = {
    domain, primaryType: 'ReceiveWithAuthorization', message,
    types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }], ...types },
  };
  const r = signature.slice(0, 66) as Hex;
  const s = `0x${signature.slice(66, 130)}` as Hex;
  const v = parseInt(signature.slice(130, 132), 16);
  const data = encodeFunctionData({
    abi: CCTP_EXTENSION_ABI, functionName: 'batchDepositForBurnWithAuth',
    args: [
      { amount, authValidAfter: BigInt(config.validAfter), authValidBefore: BigInt(config.validBefore), authNonce: nonce, v, r, s },
      { amount: batch, destinationDomain: config.destinationDomain, mintRecipient: pad(o.mintRecipient ?? config.cctpForwarder), destinationCaller: pad(o.destinationCaller ?? config.cctpForwarder), maxFee, minFinalityThreshold: o.minFinalityThreshold ?? 1000, hookData },
    ],
  });
  // What a dApp sends to the wallet (JSON-RPC encodes bigints as strings).
  const signRequest = { method: 'eth_signTypedData_v4', params: [account.address, JSON.stringify(typedData, (_k, x) => typeof x === 'bigint' ? x.toString() : x)] };
  const txRequest = { method: 'eth_sendTransaction', params: [{ from: account.address, to: config.cctpExtension, data, chainId: toHex(o.chainId) }] };
  const digest = hashTypedData({ domain, types, primaryType: 'ReceiveWithAuthorization', message });
  return { signRequest, txRequest, digest };
}

const preview = (request: { method: string; params: unknown[] }, chainId: number) =>
  previewRequest(request, { chainId, account: account.address, now: NOW }, mockDeps());
const dangers = (p: Preview) => p.warnings.filter(w => w.severity === 'danger').map(w => w.code);

test('Circle Arbitrum guide, exactly as written (Arbitrum Sepolia, 2 USDC, perps)', async () => {
  const { signRequest, txRequest, digest } = await guideFlow({ chainId: 421614 });
  const sig = await preview(signRequest, 421614);
  assert.equal(detail(sig, 'EIP-712 digest'), digest, 'previewed digest must equal the hash the guide signs');
  assert.equal(sig.decoding.decoder, 'eip3009_receive_cctp_extension');
  assert.equal(sig.title, "Authorize Circle's CCTP extension to take 2 USDC");
  assert.equal(sig.attention, 'info');

  const tx = await preview(txRequest, 421614);
  assert.equal(tx.decoding.decoder, 'cctp_extension');
  assert.equal(tx.title, 'Bridge 2 USDC to Hyperliquid perps (testnet)');
  assert.equal(detail(tx, 'HyperCore recipient'), account.address.toLowerCase());
  assert.equal(detail(tx, 'Finality'), 'Fast Transfer (threshold 1000)');
  assert.equal(detail(tx, 'Guaranteed minimum credited'), '1.8 USDC');
  assert.equal(detail(tx, 'Expected on HyperCore'), '1.8 USDC');
  assert.deepEqual(dangers(tx), []);
  assert.ok(!codes(tx).some(c => c.startsWith('cctp_') && c !== 'cctp_perps_new_account_fee'), codes(tx).join());
});

test('Circle Arbitrum guide on mainnet: 10 USDC to spot receives 9.80 USDC (the guide\'s worked example)', async () => {
  const { signRequest, txRequest } = await guideFlow({ chainId: 42161, amount: '10', destinationDex: 4294967295 });
  const sig = await preview(signRequest, 42161);
  assert.equal(sig.title, "Authorize Circle's CCTP extension to take 10 USDC");
  const tx = await preview(txRequest, 42161);
  assert.equal(tx.title, 'Bridge 10 USDC to Hyperliquid spot');
  assert.equal(detail(tx, 'Expected on HyperCore'), '9.8 USDC');
  assert.equal(detail(tx, 'Expected fee per transfer (Circle docs)'), '0.2 USDC forwarding fee');
  assert.equal(tx.attention, 'none');
  assert.deepEqual(tx.assetChanges.map(c => `${c.direction} ${c.amount} ${c.symbol}`), ['out 10 USDC']);
});

test('Circle Ethereum guide: TokenMessengerV2.depositForBurnWithHook with the documented 10 USDC fee example', async () => {
  const abi = parseAbi(['function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData)']);
  const fwd = `0x${HYPEREVM_MAINNET.forwarder.slice(2).padStart(64, '0')}` as Hex;
  // Guide: protocol fee 0.001 + example forwarding fee 0.216109 = 0.217109 USDC.
  const data = encodeFunctionData({ abi, functionName: 'depositForBurnWithHook', args: [10_000_000n, 19, fwd, CCTP_NETWORKS[1].usdc as Address, fwd, 217_109n, 1000, encodeForwardHookData(account.address, 0)] });
  const tx = await preview({ method: 'eth_sendTransaction', params: [{ from: account.address, to: CCTP_NETWORKS[1].tokenMessengerV2, data, chainId: '0x1' }] }, 1);
  assert.equal(tx.decoding.decoder, 'cctp_hypercore');
  assert.equal(tx.title, 'Bridge 10 USDC to Hyperliquid perps');
  assert.equal(detail(tx, 'Guaranteed minimum credited'), '9.782891 USDC');
  assert.match(detail(tx, 'Expected fee per transfer (Circle docs)')!, /^≈ 0\.201 USDC \(0\.001 USDC fast-transfer fee \+ 0\.2 USDC forwarding \+ destination gas\)$/);
  assert.deepEqual(dangers(tx), []);
  assert.ok(!codes(tx).includes('cctp_max_fee_below_quote'));
});

test('Hook parsing mirrors CctpForwarderHookData', () => {
  const recipient = account.address.toLowerCase();
  const doc = encodeForwardHookData(account.address, 4294967295);
  assert.deepEqual(analyzeForwardHook(doc), { ok: true, bytes: 56, recipient, dex: 4294967295, magicMatches: true, lengthField: 24, trailingBytes: 0 });
  // Guide's no-recipient variant (header only, 32 bytes): the forwarder requires >= 52 bytes.
  assert.equal(analyzeForwardHook(encodeForwardHookData()).ok, false);
  // 52..55 bytes: destination DEX defaults to 0 (perps).
  const short = analyzeForwardHook(doc.slice(0, 2 + 52 * 2) as Hex);
  assert.ok(short.ok && short.dex === 0);
  // Magic and length fields are ignored on-chain; extra bytes are allowed.
  const noMagic = analyzeForwardHook(('0x' + '00'.repeat(24) + '00000000' + '00000000' + doc.slice(66)) as Hex);
  assert.ok(noMagic.ok && !noMagic.magicMatches && noMagic.lengthField === 0);
  const trailing = analyzeForwardHook((doc + 'deadbeef') as Hex);
  assert.ok(trailing.ok && trailing.trailingBytes === 4);
  // Version must be 0.
  assert.equal(analyzeForwardHook((doc.slice(0, 50) + '00000001' + doc.slice(58)) as Hex).ok, false);
});

test('Forwarding Service version-1 hooks (from Circle docs) are rejected by the HyperCore forwarder', async () => {
  const forwardHook = concat([stringToHex('cctp-forward', { size: 24 }), toHex(1, { size: 4 }), toHex(0, { size: 4 })]);
  const customHook = concat([stringToHex('my-custom-hook', { size: 24 }), toHex(1, { size: 4 }), toHex(4, { size: 4 }), '0xdeadbeef']);
  const { txRequest } = await guideFlow({ chainId: 42161, hookData: concat([forwardHook, customHook]) });
  const tx = await preview(txRequest, 42161);
  assert.deepEqual(dangers(tx), ['cctp_bad_hook']);
  assert.match(tx.title, /will get stuck/);
});

test('Every documented "funds stuck" mistake is flagged as danger', async () => {
  const cases: [string, GuideOptions, string][] = [
    ['header-only hook (no recipient)', { chainId: 42161, hookData: encodeForwardHookData() }, 'cctp_bad_hook'],
    ['empty hook (CctpExtension falls back to plain depositForBurn)', { chainId: 42161, hookData: '0x' }, 'cctp_bad_hook'],
    ['destinationCaller not the forwarder', { chainId: 42161, destinationCaller: '0x0000000000000000000000000000000000000000' }, 'cctp_caller_not_forwarder'],
    ['mintRecipient not the forwarder', { chainId: 42161, mintRecipient: account.address }, 'cctp_mint_recipient_not_forwarder'],
    ['testnet forwarder used on mainnet', { chainId: 42161, mintRecipient: HYPEREVM_TESTNET.forwarder as Address, destinationCaller: HYPEREVM_TESTNET.forwarder as Address }, 'cctp_wrong_network_forwarder'],
    ['recipient is the CoreDepositWallet', { chainId: 42161, recipient: HYPEREVM_MAINNET.coreDepositWallet as Address }, 'cctp_recipient_is_deposit_wallet'],
    ['recipient is HyperEVM USDC', { chainId: 42161, recipient: HYPEREVM_MAINNET.usdc as Address }, 'cctp_recipient_is_usdc'],
    ['recipient is the USDC system address', { chainId: 42161, recipient: '0x2000000000000000000000000000000000000000' }, 'cctp_recipient_is_system_address'],
    ['zero recipient', { chainId: 42161, recipient: '0x0000000000000000000000000000000000000000' }, 'cctp_zero_recipient'],
  ];
  for (const [name, options, code] of cases) {
    const tx = await preview((await guideFlow(options)).txRequest, options.chainId);
    assert.ok(dangers(tx).includes(code), `${name}: expected ${code}, got ${codes(tx).join(', ')}`);
    assert.equal(tx.attention, 'danger', name);
  }
});

test('Source-side reverts and fee/route cautions', async () => {
  const run = async (o: GuideOptions) => preview((await guideFlow(o)).txRequest, o.chainId);
  const revert = await run({ chainId: 42161, amount: '1', maxFee: '1' });
  assert.ok(codes(revert).includes('cctp_will_revert'));
  assert.deepEqual(dangers(revert), [], 'a source-chain revert loses only gas');

  const lowFee = await run({ chainId: 42161, amount: '10', maxFee: '0.1' });
  assert.ok(codes(lowFee).includes('cctp_max_fee_below_quote'));
  assert.equal(detail(lowFee, 'Guaranteed minimum credited'), '9.9 USDC');

  const batched = await run({ chainId: 42161, amount: '10', batchSize: '2' });
  assert.equal(batched.title, 'Bridge 10 USDC to Hyperliquid perps in 5 transfers');
  assert.ok(codes(batched).includes('cctp_batched_fees'));
  assert.equal(detail(batched, 'Expected on HyperCore (total)'), '9 USDC');

  const indivisible = await run({ chainId: 42161, amount: '10', batchSize: '3' });
  assert.ok(codes(indivisible).includes('cctp_will_revert'));

  const otherDex = await run({ chainId: 42161, destinationDex: 5 });
  assert.ok(codes(otherDex).includes('cctp_unknown_dex'));

  const tinyPerps = await run({ chainId: 42161, amount: '1.1', maxFee: '0.2' });
  assert.ok(codes(tinyPerps).includes('cctp_perps_new_account_fee'));
  const tinySpot = await run({ chainId: 42161, amount: '1.1', maxFee: '0.2', destinationDex: 4294967295 });
  assert.ok(!codes(tinySpot).includes('cctp_perps_new_account_fee'));

  const expired = await run({ chainId: 42161, validBefore: NOW_S - 10 });
  assert.ok(codes(expired).includes('cctp_auth_expired'));

  const otherRecipient = await run({ chainId: 42161, recipient: OTHER });
  assert.ok(codes(otherRecipient).includes('recipient_not_sender'));
});

test('EIP-3009 signatures for other spenders, sponsored deposits and direct transfers', async () => {
  const net = CCTP_NETWORKS[42161];
  const base = JSON.parse((await guideFlow({ chainId: 42161 })).signRequest.params[1] as string);
  const sign = (mutate: (d: typeof base) => void) => { const d = structuredClone(base); mutate(d); return preview({ method: 'eth_signTypedData_v4', params: [account.address, JSON.stringify(d)] }, 42161); };

  const sponsored = await sign(d => { d.message.to = net.cctpExtensionV2; });
  assert.equal(sponsored.decoding.decoder, 'eip3009_receive_cctp_extension_v2');
  assert.ok(codes(sponsored).includes('cctp_extension_v2_auth'));

  const other = await sign(d => { d.message.to = OTHER; });
  assert.equal(other.title, 'Authorize 0xb0b0…0002 to take 2 USDC');
  assert.ok(codes(other).includes('receive_authorization'));

  const transfer = await sign(d => { d.primaryType = 'TransferWithAuthorization'; d.types.TransferWithAuthorization = d.types.ReceiveWithAuthorization; delete d.types.ReceiveWithAuthorization; d.message.to = OTHER; });
  assert.equal(transfer.title, 'Authorize a transfer of 2 USDC to 0xb0b0…0002');
  assert.ok(codes(transfer).includes('transfer_authorization'));

  const stolen = await sign(d => { d.message.from = OTHER; });
  assert.ok(dangers(stolen).includes('eip3009_from_mismatch'));
});
