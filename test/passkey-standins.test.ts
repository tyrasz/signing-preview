// Passkey accounts whose stand-ins the survey of 2026-11-15 found missing or off: a build of Coinbase Smart Wallet
// another factory deploys (Base), OKX Wallet's account whose key is OKX's passkey verifier's (OP Mainnet) or an
// Ethereum key its EIP-191 verifier checks (BNB Chain, beside two passkeys), Trust
// Wallet's Barz passkey accounts (BNB Chain), and a ZeroDev passkey account whose last operation is beyond the usual
// lookup (Arbitrum One). Each account's code is its real code read from the chain (test/fixtures), at its own address,
// run by the fork simulator on test/evm-chain.ts (in a file of its own: the fork simulator keeps the code it reads at an
// address for the process, and erc4337-sim.test.ts puts a mock at OKX's implementation's).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { concatHex, decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData, getContractAddress, hashMessage, keccak256, numberToHex, parseAbi, recoverAddress, sha256, stringToHex, type Hex } from 'viem';
import { p256 } from '@noble/curves/nist';
import { createAddressFromString as at, hexToBytes, setLengthLeft, unpadBytes } from '@ethereumjs/util';
import { previewRequest } from '../src/preview.ts';
import { StaticTokenRegistry } from '../src/chains.ts';
import { RpcSimulator } from '../src/simulation.ts';
import { JsonRpcClient } from '../src/rpc.ts';
import { CHAIN_PROFILES, ForkSimulator } from '../src/fork-simulator.ts';
import { ENTRY_POINT_SIMULATIONS_V06, ENTRY_POINT_SIMULATIONS_V07 } from '../src/entrypoint-simulations.ts';
import { readOperation, userOpHash } from '../src/userop-hash.ts';
import { AMBIRE_IMPLEMENTATION, ecdsaOffsets, implementationOf, okxDigest, simulateOperation, STUB_SIGNATURE, stubSignature, walletForm, zeroDevAssumed, zeroDevFlag, zeroDevSays, zeroDevWebAuthnStub } from '../src/erc4337-sim.ts';
import type { Dependencies, Preview, SimulationRequest } from '../src/types.ts';
import { NOW } from './helpers.ts';
import { compiled, testChain } from './evm-chain.ts';

const EP = '0x0000000071727de22e5e9d8baf0edac6f37da032', EP6 = '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789';
const BOB = '0xb0b0000000000000000000000000000000000002';
const URL_ = 'http://hyperevm.invalid';
const E = 10n ** 18n;
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

const chain = await testChain();
const usdc = await chain.deploy('Token', 'string,uint8', ['USDC', 6]);
await chain.putCode(EP, ENTRY_POINT_SIMULATIONS_V07 as Hex);
await chain.putCode(EP6, ENTRY_POINT_SIMULATIONS_V06 as Hex);
// v0.7's SenderCreator (the EntryPoint's first creation) calls the factory, as on-chain.
await chain.putCode(getContractAddress({ from: EP as Hex, nonce: 1n }), `0x${compiled('SenderCreatorLike').evm.deployedBytecode.object}`);
const A = parseAbi(['function mint(address,uint256)', 'function transfer(address,uint256)', 'function execute(address,uint256,bytes)', 'function executeBatch(address[],uint256[],bytes[])']);
const call = (fn: string, args: unknown[]) => encodeFunctionData({ abi: A, functionName: fn, args } as never);
const deps: Dependencies = {
  tokens: new StaticTokenRegistry({ 999: [{ address: usdc, symbol: 'USDC', decimals: 6, name: 'USD Coin' }] }),
  rpc: new JsonRpcClient({ 999: URL_ }, { fetchImpl: chain.fetchImpl }),
  simulator: new RpcSimulator({ 999: URL_ }, { fetchImpl: chain.fetchImpl, fork: new ForkSimulator({ 999: URL_ }, { fetchImpl: chain.fetchImpl }) }),
};
const transfer = call('transfer', [BOB, 50_000_000n]);
const operation = (m: Record<string, unknown>) => ({ nonce: '0x0', callGasLimit: '0x30d40', verificationGasLimit: '0x7a120', preVerificationGas: '0xc350', maxFeePerGas: '0x77359400', maxPriorityFeePerGas: '0x3b9aca00', ...m });
const preview = (op: Record<string, unknown>, signer: string, version: '0.6' | '0.7' = '0.7', on = deps): Promise<Preview> => {
  const ep = version === '0.6' ? EP6 : EP;
  return previewRequest({ method: 'personal_sign', params: [userOpHash(readOperation(op, version)!, ep, 999, version), signer] }, { now: NOW, chainId: 999, userOperation: { entryPoint: ep, operation: op } }, on);
};
// BNB Chain's rules for Barz's account, whose P-256 code calls modexp with a gas stipend HyperEVM's prices (this test
// chain's own, ten times Ethereum's) leave short.
const bnb: Dependencies = { ...deps, simulator: new RpcSimulator({ 999: URL_ }, { fetchImpl: chain.fetchImpl, fork: new ForkSimulator({ 999: URL_ }, { fetchImpl: chain.fetchImpl, profiles: { 999: { ...CHAIN_PROFILES[56] } } }) }) };
const usdcChange = (p: Preview) => p.assetChanges.filter(c => c.symbol === 'USDC').map(c => `${c.direction} ${c.amount}`);
const whole = (p: Preview) => p.decoding.notes.find(n => /whole operation was simulated/.test(n));
const notes = (p: Preview) => p.decoding.notes.join(' | ');
const gasUsed = (p: Preview) => BigInt(String(p.details.find(d => d.label === 'Gas used (simulated)')?.raw));
const funded = async (account: string) => { await chain.exec(usdc, call('mint', [account, 100_000_000n])); await chain.setBalance(account, E); };
/** A fixture's accounts: their code and the storage their calls read, put where they were. */
async function install(fx: { codes: Record<string, Hex>; storage?: Record<string, Record<string, Hex>> }) {
  for (const [a, code] of Object.entries(fx.codes)) await chain.putCode(a, code);
  for (const [a, slots] of Object.entries(fx.storage ?? {})) for (const [slot, v] of Object.entries(slots)) await chain.evm.stateManager.putStorage(at(a), setLengthLeft(hexToBytes(slot as Hex), 32), unpadBytes(hexToBytes(v)));
}

test('Ambire’s account, an EIP-1167 clone: the stand-in in its Standard mode, which its own code recovers over its digest of the operation’s hash', async () => {
  // Its real code (Base). A bare 65-byte stand-in ends in v (27 or 28), which it reads as the Unprotected mode and
  // refuses (SV_USED_UNBOUND), as on Ethereum and Base: the operation's calls were simulated alone.
  const fx = fixture('ambire.json');
  await install(fx);
  const ACCOUNT = '0x00000000000000000000000000000000a3b1e0a1', KEY = '0x00000000000000000000000000000000a3b1e0b2';
  await chain.putCode(ACCOUNT, `0x363d3d373d3d3d363d73${AMBIRE_IMPLEMENTATION.slice(2)}5af43d82803e903d91602b57fd5bf3`);
  const privilege = (a: string) => hexToBytes(keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [a as Hex, 0n])));
  await chain.evm.stateManager.putStorage(at(ACCOUNT), privilege(EP), hexToBytes('0x7171'));
  await chain.evm.stateManager.putStorage(at(ACCOUNT), privilege(KEY), hexToBytes('0x01'));
  await funded(ACCOUNT);
  assert.equal(await implementationOf(deps, 999, ACCOUNT), AMBIRE_IMPLEMENTATION);
  const callData = encodeFunctionData({ abi: parseAbi(['function executeBySender((address to, uint256 value, bytes data)[] calls)']), args: [[{ to: usdc as Hex, value: 0n, data: transfer }]] });
  const p = await preview(operation({ sender: ACCOUNT, callData }), KEY);
  assert.ok(whole(p) && /ecrecover attributes it to the signer\)/.test(whole(p)!) && !/doesn't accept/.test(whole(p)!), notes(p));
  assert.deepEqual(usdcChange(p), ['out 50']);
  // A key the account gives no privilege to: its validation fails, as it will once that key signs.
  const q = await preview(operation({ sender: ACCOUNT, callData }), BOB);
  assert.ok(!whole(q) || /doesn't accept/.test(whole(q)!), notes(q));
  // The wallet supplies its own gas-estimation stub, a dummy no key signed in Ambire's Standard mode: the account
  // refuses it as it is, and takes the stand-in put in its place (the wallet's form kept).
  const dummy = `0x${'11'.repeat(32)}${'22'.repeat(32)}1b01` as Hex;
  const w = await preview(operation({ sender: ACCOUNT, callData, signature: dummy }), KEY);
  assert.ok(whole(w) && /in the form of the wallet's own, its ECDSA signature replaced by one ecrecover attributes to the signer\)/.test(whole(w)!), notes(w));
  assert.deepEqual(usdcChange(w), ['out 50']);
});

test('The ECDSA signatures in a wallet’s supplied signature, and the stand-in in their place', () => {
  const sig = (r: string, s: string, v: string) => `${r.repeat(32)}${s.repeat(32)}${v}`;
  const ecdsa = sig('11', '22', '1b');
  // Bare, behind a type byte, with a mode byte after, and ABI-wrapped beside an empty part.
  assert.deepEqual(ecdsaOffsets(`0x${ecdsa}`), [0]);
  assert.deepEqual(walletForm(`0x01${ecdsa}`), [`0x01${STUB_SIGNATURE.slice(2)}`]);
  assert.deepEqual(walletForm(`0x${ecdsa}01`), [`${STUB_SIGNATURE}01`]);
  const wrapped = `0x01${'00'.repeat(31)}40${'00'.repeat(31)}c0${'00'.repeat(31)}41${ecdsa}${'00'.repeat(31)}${'00'.repeat(32)}` as Hex;
  assert.deepEqual(ecdsaOffsets(wrapped), [1 + 96]);
  // Two signatures, owner's and cosigner's: both found, last first, one stand-in each.
  assert.deepEqual(ecdsaOffsets(`0x${ecdsa}${sig('33', '44', '1c')}`), [65, 0]);
  // Not a signature: s in the upper half, v not 27 or 28, r zero; and the stand-in itself gives nothing to replace.
  assert.deepEqual(ecdsaOffsets(`0x${sig('11', 'ff', '1b')}`), []);
  assert.deepEqual(ecdsaOffsets(`0x${sig('11', '22', '02')}`), []);
  assert.deepEqual(ecdsaOffsets(`0x${sig('00', '22', '1b')}`), []);
  assert.deepEqual(walletForm(STUB_SIGNATURE), []);
});

test('An account behind OKX Wallet’s 797-byte proxy runs the implementation its ERC-1967 slot names', async () => {
  const fx = fixture('okx-passkey-verifier.json');
  const rpc = { has: () => true, call: async (_c: number, method: string, params: unknown[]) => {
    if (method === 'eth_getCode') return fx.codes[fx.account];
    if (method === 'eth_getStorageAt' && params[1] === '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc') return fx.storage[fx.account][params[1] as string];
    throw new Error(`unexpected ${method}`);
  } };
  assert.equal(await implementationOf({ rpc } as never, 10, fx.account), '0x36d3cbd83961868398d056efbf50f5ce15528c0d');
  // Other longer code isn't read as a proxy, whether or not it names the ERC-1967 slot and keeps an address there.
  for (const code of [`0x${'5b'.repeat(400)}`, `0x${'5b'.repeat(400)}7f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc545af4`]) {
    const other = { has: () => true, call: async (_c: number, method: string) => method === 'eth_getCode' ? code : method === 'eth_getStorageAt' ? `0x${'00'.repeat(12)}ca7f2d0354902f772a83759c347921e681146aaf` : Promise.reject(new Error(`unexpected ${method}`)) };
    assert.equal(await implementationOf({ rpc: other } as never, 10, fx.account), undefined, code.slice(-80));
  }
});

test('An account behind the 845-byte ERC-1967 proxy of Modular Account v2’s accounts on Base runs the implementation its slot names; other code of that length doesn’t', async () => {
  const fx = fixture('semi-modular-proxy.json');
  const rpcWith = (code: string) => ({ has: () => true, call: async (_c: number, method: string, params: unknown[]) => {
    if (method === 'eth_getCode') return code;
    if (method === 'eth_getStorageAt' && params[1] === '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc') return `0x${'00'.repeat(12)}${fx.implementation.slice(2)}`;
    throw new Error(`unexpected ${method}`);
  } });
  assert.equal(await implementationOf({ rpc: rpcWith(fx.code) } as never, 8453, fx.account), fx.implementation);
  // One byte changed (its metadata hash), the same length: not the proxy, so not followed.
  assert.equal(await implementationOf({ rpc: rpcWith(`${fx.code.slice(0, -4)}0034`) } as never, 8453, fx.account), undefined);
});

test('OKX Wallet’s account whose key is OKX’s passkey verifier’s: the stand-in key’s passkey part and the verifier’s cosignature pass its real code', async () => {
  const fx = fixture('okx-passkey-verifier.json');
  await install(fx);
  const account = fx.account as string;
  await funded(account);
  // executeUserOp with the account's calls (as OKX's operations carry them): one transfer.
  const callData = concatHex(['0x8dd7712f', encodeAbiParameters([{ type: 'tuple[]', components: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }] }], [[{ to: usdc as Hex, value: 0n, data: transfer }]])]);
  const op = operation({ sender: account, callData });
  // The account itself is asked to sign: a passkey wallet's way.
  const p = await preview(op, account);
  assert.ok(whole(p) && !/doesn't accept/.test(whole(p)!), notes(p));
  assert.deepEqual(usdcChange(p), ['out 50']);
  assert.ok(p.decoding.notes.some(n => /OKX's passkey verifier \(0xa921…9fe8, unpublished: its checks read from what it does\) takes only with a cosignature by the key it records for the account \(0x5575fc3c07ba321f89076153ee9b67472bca1a26\)/.test(n)), notes(p));
  // The stand-in is laid out as the wallet's own signature: key hash, validUntil, then the passkey's part (as long as
  // the real one's: the same assertion fields) and a 65-byte cosignature.
  const { args } = decodeFunctionData({ abi: parseAbi(['function simulateHandleOp((address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature) op, address target, bytes targetCallData)']), data: (await standInRequest(op, account)).data as Hex });
  const mine = (args[0] as { signature: Hex }).signature, theirs = fx.operation.signature as Hex;
  assert.equal(mine.length, theirs.length);
  const parts = (s: Hex) => decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes' }], `0x${s.slice(2 + 76)}`);
  const [passkey, cosignature] = parts(mine), [real, realCosignature] = parts(theirs);
  assert.equal(passkey.length, real.length);
  assert.equal(cosignature.length, realCosignature.length);
  // The verifier upgraded to code whose checks weren't read (here its own code, at another address): its key, the one
  // most likely to sign, isn't stood in for, nor is the account's other key, an Ethereum key the account asked can't
  // be shown to hold: the last resort's stand-in, which the preview says needn't be refused as the passkey's would be.
  const VERIFIER = '0xa9215f1afa5e2a5bb924f53186934b5da3459fe8', SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
  await chain.putCode(`0x${'47'.repeat(20)}`, fx.codes['0x47f00fd16ccfdcec08617373f524a5e68ac8a29a']);
  await chain.evm.stateManager.putStorage(at(VERIFIER), hexToBytes(SLOT), hexToBytes(`0x${'47'.repeat(20)}`));
  try {
    const q = await preview(op, account);
    assert.match(whole(q) ?? notes(q), /doesn't take it \(the account's key is a passkey checked by OKX's passkey verifier \(0xa921…9fe8\), whose code \(0x4747…4747\) isn't the code its checks were read from: the stand-in is in the form its known code takes\), which needn't mean it won't take theirs/);
  } finally {
    await chain.evm.stateManager.putStorage(at(VERIFIER), hexToBytes(SLOT), hexToBytes('0x47f00fd16ccfdcec08617373f524a5e68ac8a29a'));
  }
});

test('OKX Wallet’s account whose key is a passkey, asked by anyone but the account: the stand-in is refused, and the preview says who signs', async () => {
  const fx = fixture('okx-passkey-verifier.json');
  await install(fx);
  const account = fx.account as string, COSIGNER = '0x5575fc3c07ba321f89076153ee9b67472bca1a26';
  await funded(account);
  const callData = concatHex(['0x8dd7712f', encodeAbiParameters([{ type: 'tuple[]', components: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }] }], [[{ to: usdc as Hex, value: 0n, data: transfer }]])]);
  const op = operation({ sender: account, callData });
  // An address that is none of the account's keys: it can't sign as its passkey, nor the verifier's cosigner alone.
  const bob = await preview(op, BOB);
  assert.match(whole(bob) ?? notes(bob), /doesn't accept it as theirs \(OKX Wallet's account here is signed by its passkey, which OKX's passkey verifier \(0xa921…9fe8\) takes only with a cosignature by 0x5575fc3c07ba321f89076153ee9b67472bca1a26 \(a passkey wallet signs as the account itself\), and the signer asked is neither the account nor one of its Ethereum keys\)/);
  const cosigner = await preview(op, COSIGNER);
  assert.match(whole(cosigner) ?? notes(cosigner), /doesn't accept it as theirs \(OKX Wallet's account here is signed by its passkey, .*, and the signer asked is that cosigner, whose signature is only the second of the two\)/);
  // The verifier recording no cosigner for the account: the account asked, its key's check isn't known.
  const VERIFIER = '0xa9215f1afa5e2a5bb924f53186934b5da3459fe8', RECORD = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [account as Hex, 0n]));
  const recorded = await chain.evm.stateManager.getStorage(at(VERIFIER), hexToBytes(RECORD));
  await chain.evm.stateManager.putStorage(at(VERIFIER), hexToBytes(RECORD), new Uint8Array());
  try {
    const none = await preview(op, account);
    assert.match(whole(none) ?? notes(none), /doesn't take it \(the account's key is a passkey checked by OKX's passkey verifier \(0xa921…9fe8\), which records no cosigner for the account: the stand-in is in the form its known code takes\), which needn't mean it won't take theirs/);
  } finally { await chain.evm.stateManager.putStorage(at(VERIFIER), hexToBytes(RECORD), recorded); }
  // The same key as a passkey the account checks itself (type 2), asked by an address that isn't one of its keys.
  const TYPE = '0xdc374a365d5797f359d6171698154249d0f382fe319d9187306b7112a63ae9de';
  const type = await chain.evm.stateManager.getStorage(at(account), hexToBytes(TYPE));
  await chain.evm.stateManager.putStorage(at(account), hexToBytes(TYPE), hexToBytes('0x02'));
  try {
    const two = await preview(op, BOB);
    assert.match(whole(two) ?? notes(two), /doesn't accept it as theirs \(OKX Wallet's account here is signed by its passkey \(a passkey wallet signs as the account itself\), and the signer asked is neither the account nor one of its Ethereum keys\)/);
  } finally { await chain.evm.stateManager.putStorage(at(account), hexToBytes(TYPE), type); }
});

test('OKX Wallet’s account whose key is an Ethereum key checked by OKX’s EIP-191 verifier: asked by that key, its own form, which the verifier’s real code takes', async () => {
  // BNB Chain, 2026-11-19: of the account's three admin keys, two passkeys and this one, the operation was signed
  // by this one (its hash, validUntil, then r, s, v over the EIP-191 form of the account's digest). Taken for one of
  // the passkeys, the stand-in ran a passkey's checks: 9,101 gas (6.6%) over the operation's own.
  const fx = fixture('okx-eip191-verifier.json');
  const IMPLEMENTATION = '0x36d3cbd83961868398d056efbf50f5ce15528c0d', original = fixture('okx-passkey-verifier.json').codes[IMPLEMENTATION];
  await install(fx);
  try {
    const account = fx.account as string, key = fx.key as string;
    // What the real signature is: the key's own signature over the EIP-191 form of the account's digest.
    const sig = fx.operation.signature as Hex, digest = okxDigest(fx.operation.hash, BigInt(`0x${sig.slice(66, 78)}`));
    assert.equal((await recoverAddress({ hash: hashMessage({ raw: digest }), signature: `0x${sig.slice(78)}` })).toLowerCase(), key);
    assert.equal(sig.slice(0, 66), keccak256(key as Hex));
    await funded(account);
    const callData = concatHex(['0x8dd7712f', encodeAbiParameters([{ type: 'tuple[]', components: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }] }], [[{ to: usdc as Hex, value: 0n, data: transfer }]])]);
    const op = operation({ sender: account, callData });
    const p = await preview(op, key, '0.7', bnb);
    assert.ok(whole(p) && /ecrecover attributes it to the signer\)/.test(whole(p)!) && !/doesn't accept/.test(whole(p)!), notes(p));
    assert.deepEqual(usdcChange(p), ['out 50']);
    // Laid out as the real one: the key's hash, validUntil, then 65 bytes.
    const { args } = decodeFunctionData({ abi: parseAbi(['function simulateHandleOp((address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature) op, address target, bytes targetCallData)']), data: (await standInRequest(op, key)).data as Hex });
    const mine = (args[0] as { signature: Hex }).signature;
    assert.equal(mine.length, sig.length);
    assert.equal(mine.slice(0, 66), sig.slice(0, 66));
    // The account itself asked (a passkey wallet's way): one of its passkeys' stand-in, as before (not this key's).
    const passkey = (decodeFunctionData({ abi: parseAbi(['function simulateHandleOp((address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature) op, address target, bytes targetCallData)']), data: (await standInRequest(op, account)).data as Hex }).args[0] as { signature: Hex }).signature;
    assert.notEqual(passkey.slice(0, 66), sig.slice(0, 66));
    assert.ok(passkey.length > sig.length);
  } finally { await chain.putCode(IMPLEMENTATION, original); }
});

/** The request simulateOperation makes first for `op` (what it stands in with), on the test chain, signed by `signer`. */
async function standInRequest(op: Record<string, unknown>, signer: string, version: '0.6' | '0.7' = '0.7'): Promise<SimulationRequest> {
  const tried: SimulationRequest[] = [];
  const simulator = { simulate: async (q: SimulationRequest) => { tried.push(q); return null; } };
  const read = readOperation(op, version)!;
  await simulateOperation({ chainId: 999, entryPoint: version === '0.6' ? EP6 : EP, sender: String(op.sender), nonce: BigInt(String(op.nonce)), initCode: (op.initCode as Hex) ?? (op.factory ? concatHex([op.factory as Hex, op.factoryData as Hex]) : '0x'), callData: op.callData as Hex,
    callGasLimit: read.callGasLimit, verificationGasLimit: read.verificationGasLimit, preVerificationGas: read.preVerificationGas, maxFeePerGas: read.maxFeePerGas, maxPriorityFeePerGas: read.maxPriorityFeePerGas, paymasterAndData: '0x', signer }, { ...deps, simulator } as never);
  return tried[0];
}

test('A build of Coinbase Smart Wallet another factory deploys (Base’s giga1 wallet): its passkey owner’s stand-in, as Coinbase’s, deploying and deployed', async () => {
  const fx = fixture('coinbase-copy.json');
  await install(fx);
  const account = fx.operation.sender as string;
  await funded(account);
  const op = operation({ sender: account, factory: fx.factory, factoryData: `0x${(fx.operation.initCode as string).slice(42)}`, callData: call('execute', [usdc, 0n, transfer]) });
  const p = await preview(op, account);
  assert.ok(whole(p) && /deploying the account through its factory/.test(whole(p)!) && /a passkey's assertion over the operation's hash/.test(whole(p)!) && !/doesn't accept/.test(whole(p)!), notes(p));
  assert.deepEqual(usdcChange(p), ['out 50']);
  assert.ok(p.decoding.notes.some(n => n.startsWith(`The account runs ${fx.implementation}, not Coinbase's own Coinbase Smart Wallet`)), notes(p));
  // Deployed (by its factory, outside any operation): the account itself answers as a copy, its owners read from it.
  await chain.exec(fx.factory, fx.operation.initCode.slice(0, 2) + fx.operation.initCode.slice(42) as Hex);
  const q = await preview(operation({ sender: account, callData: call('execute', [usdc, 0n, transfer]) }), account);
  assert.ok(whole(q) && !/deploying/.test(whole(q)!) && /a passkey's assertion/.test(whole(q)!) && !/doesn't accept/.test(whole(q)!), notes(q));
  assert.deepEqual(usdcChange(q), ['out 50']);
});

test('Another factory’s account is taken for a build of Coinbase Smart Wallet only when its implementation answers as Coinbase’s', async () => {
  let n = 0;
  const passkey = `0x${'ab'.repeat(64)}` as Hex;
  const factoryData = encodeFunctionData({ abi: parseAbi(['function createAccount(bytes[] owners, uint256 nonce, bytes32 extra)']), args: [[passkey], 0n, `0x${'00'.repeat(32)}`] });
  const shapes = async (name: string, key: bigint, entryPoint: string, address?: string) => {
    // (A factory and implementation of its own each time: what an implementation answers is remembered.)
    n++;
    const FACTORY = `0xfac${String(n).padStart(37, '0')}` as Hex, IMPL = `0x1111${String(n).padStart(36, '0')}` as Hex;
    // The account's address: Solady's ERC-1967 proxy to IMPL from FACTORY, with Coinbase's salt (unless `address`).
    const SENDER = address ?? getContractAddress({ opcode: 'CREATE2', from: FACTORY, salt: keccak256(encodeAbiParameters([{ type: 'bytes[]' }, { type: 'uint256' }], [[passkey], 0n])),
      bytecode: `0x603d3d8160223d3973${IMPL.slice(2)}60095155f3363d3d373d3d363d7f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc545af43d6000803e6038573d6000fd5b3d6000f3` });
    const ABI = parseAbi(['function eip712Domain() view returns (bytes1, string, string, uint256, address, bytes32, uint256[])']);
    const rpc = { has: () => true, call: async (_c: number, method: string, params: unknown[]) => {
      if (method === 'eth_getBlockByNumber') return { number: '0x10', baseFeePerGas: '0x1' };
      if (method === 'eth_maxPriorityFeePerGas') return '0x0';
      if (method !== 'eth_call') throw new Error(method);
      const { to, data } = params[0] as { to: string; data: string };
      if (to === EP) return `0x${'4a'.repeat(32)}`; // getUserOpHash
      if (to === FACTORY && data === '0x5c60da1b') return `0x${IMPL.slice(2).padStart(64, '0')}`; // implementation()
      if (to === IMPL && data === '0x88ce4c7c') return numberToHex(key, { size: 32 }); // REPLAYABLE_NONCE_KEY()
      if (to === IMPL && data === '0xb0d691fe') return `0x${entryPoint.slice(2).padStart(64, '0')}`; // entryPoint()
      if (to === IMPL && data === '0x84b0196e') return encodeAbiParameters(ABI[0].outputs, ['0x0f', name, '1', 8453n, IMPL, `0x${'00'.repeat(32)}`, []]);
      throw new Error(`unexpected ${to} ${data.slice(0, 10)}`);
    } };
    const tried: SimulationRequest[] = [];
    const simulator = { simulate: async (q: SimulationRequest) => { tried.push(q); return null; } };
    await simulateOperation({ chainId: 8453, entryPoint: EP, sender: SENDER, nonce: 0n, initCode: concatHex([FACTORY, factoryData]), callData: '0x', callGasLimit: 1n, verificationGasLimit: 1n, preVerificationGas: 1n, maxFeePerGas: 1n, maxPriorityFeePerGas: 0n, paymasterAndData: '0x' }, { rpc, simulator } as never);
    const { args } = decodeFunctionData({ abi: parseAbi(['function simulateHandleOp((address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature) op, address target, bytes targetCallData)']), data: tried[0].data as Hex });
    return (args[0] as { signature: Hex }).signature;
  };
  // Coinbase's SignatureWrapper with the passkey owner's index (0) and a WebAuthn assertion: as Coinbase's own.
  const copy = await shapes('Coinbase Smart Wallet', 8453n, EP);
  assert.notEqual(copy, STUB_SIGNATURE);
  const [wrapper] = decodeAbiParameters([{ type: 'tuple', components: [{ name: 'ownerIndex', type: 'uint256' }, { name: 'signatureData', type: 'bytes' }] }], copy);
  assert.equal(wrapper.ownerIndex, 0n);
  assert.ok(wrapper.signatureData.length > 2 + 64 * 6, 'a WebAuthnAuth');
  // Another name, another replayable nonce key, or another EntryPoint: not taken for one (the plain stand-in).
  for (const [name, key, ep] of [['Other Wallet', 8453n, EP], ['Coinbase Smart Wallet', 1n, EP], ['Coinbase Smart Wallet', 8453n, EP6]] as const) {
    assert.equal(await shapes(name, key, ep), STUB_SIGNATURE, `${name} ${key} ${ep}`);
  }
  // Answering as Coinbase's, but deploying an account at another address than that proxy's: not taken for one.
  assert.equal(await shapes('Coinbase Smart Wallet', 8453n, EP, '0x5e4d000000000000000000000000000000005e4d'), STUB_SIGNATURE);
});

test('An account is taken for a build of Coinbase Smart Wallet only where its code shows it runs one: not by what a factory or a storage slot names', async () => {
  const fx = fixture('coinbase-copy.json');
  await install(fx);
  const execute = call('execute', [usdc, 0n, transfer]);
  const signatureOf = async (op: Record<string, unknown>, signer: string) => (decodeFunctionData({ abi: parseAbi(['function simulateHandleOp((address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature) op, address target, bytes targetCallData)']), data: (await standInRequest(op, signer)).data as Hex }).args[0] as { signature: Hex }).signature;
  const copyNote = (p: Preview) => p.decoding.notes.some(n => /a build of it that answers as Coinbase Smart Wallet v1 does/.test(n));
  // The giga1 factory's deployment: the account's address is Solady's ERC-1967 proxy's to the build, so Coinbase's form.
  const real = fx.operation.sender as string;
  assert.notEqual(await signatureOf(operation({ sender: real, factory: fx.factory, factoryData: `0x${(fx.operation.initCode as string).slice(42)}`, callData: execute }), real), STUB_SIGNATURE);
  // A factory that names the same build (implementation()) but deploys an account taking any signature.
  const factory = await chain.deploy('NamingFactory', 'address', [fx.implementation]);
  const named = getContractAddress({ from: factory as Hex, nonce: 1n }).toLowerCase();
  await funded(named);
  const deploying = operation({ sender: named, factory, factoryData: encodeFunctionData({ abi: parseAbi(['function createAccount(bytes[] owners, uint256 nonce, bytes32 extra)']), args: [[`0x${'ab'.repeat(64)}`], 0n, `0x${'00'.repeat(32)}`] }), callData: execute });
  assert.equal(await signatureOf(deploying, named), STUB_SIGNATURE);
  const p = await preview(deploying, named);
  assert.ok(whole(p) && /deploying the account through its factory/.test(whole(p)!) && /ecrecover attributes it to the signer\)/.test(whole(p)!), notes(p));
  assert.ok(!copyNote(p), notes(p));
  // Longer code that keeps the build's address in the ERC-1967 slot, but runs its own validation.
  const keeper = await chain.deploy('SlotKeeper', 'address', [fx.implementation]);
  await funded(keeper);
  assert.equal(await implementationOf(deps, 999, keeper), undefined);
  for (const signer of [keeper, BOB]) {
    const q = await preview(operation({ sender: keeper, callData: execute }), signer);
    assert.ok(whole(q) && !copyNote(q), notes(q));
  }
  // A short proxy's length, its slot holding the build's address, but not Solady's ERC-1967 proxy.
  const SHORT = '0x5407000000000000000000000000000000005407';
  await chain.putCode(SHORT, '0x00');
  await chain.evm.stateManager.putStorage(at(SHORT), hexToBytes('0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'), hexToBytes(fx.implementation));
  assert.equal(await implementationOf(deps, 999, SHORT), fx.implementation);
  assert.equal(await signatureOf(operation({ sender: SHORT, callData: execute }), SHORT), STUB_SIGNATURE);
});

test('Trust Wallet’s Barz passkey account: a real assertion by the stand-in passkey, which its own P-256 check (in Solidity) verifies against that key, set for the run', async () => {
  const fx = fixture('barz.json');
  await install(fx);
  const account = fx.account as string;
  await funded(account);
  const op = operation({ sender: account, callData: call('executeBatch', [[usdc], [0n], [transfer]]), paymasterAndData: '0x', verificationGasLimit: '0xc3500' });
  // At 8d79deb: the plain stand-in doesn't decode as Barz's passkey signature, the account reports
  // AccountFacet__CallNotSuccessful(), and only the calls were simulated.
  const p = await preview(op, account, '0.6', bnb);
  assert.ok(whole(p) && /a passkey's assertion over the operation's hash, by a passkey made up for the run, which the account's own P-256 check is given in place of its key/.test(whole(p)!) && !/doesn't accept/.test(whole(p)!), notes(p));
  assert.deepEqual(usdcChange(p), ['out 50']);
  // Asked by an Ethereum key: the account's own key checks the assertion and refuses it, and the note says who signs.
  const q = await preview(op, BOB, '0.6', bnb);
  assert.match(whole(q) ?? notes(q), /doesn't accept it as theirs \(Trust Wallet's Barz account here is signed by its passkey/);

  // The real operation's own signature, its validateUserOp run here as the EntryPoint calls it, with the hash it was
  // signed over: the fixture's account takes it (its public key is the real passkey's), in the form the stand-in has.
  const VALIDATE = parseAbi(['struct UserOperation { address sender; uint256 nonce; bytes initCode; bytes callData; uint256 callGasLimit; uint256 verificationGasLimit; uint256 preVerificationGas; uint256 maxFeePerGas; uint256 maxPriorityFeePerGas; bytes paymasterAndData; bytes signature; }',
    'function validateUserOp(UserOperation op, bytes32 hash, uint256 missing) returns (uint256)']);
  const real = fx.operation.signature as Hex;
  const validate = async (signature: Hex, hash: Hex) => {
    const r = await chain.evm.runCall({ caller: at(EP6), to: at(account), data: hexToBytes(encodeFunctionData({ abi: VALIDATE, functionName: 'validateUserOp', args: [{ sender: account as Hex, nonce: 0n, initCode: '0x', callData: '0x', callGasLimit: 0n, verificationGasLimit: 0n, preVerificationGas: 0n, maxFeePerGas: 0n, maxPriorityFeePerGas: 0n, paymasterAndData: '0x', signature }, hash, 0n] })), gasLimit: 2_000_000n });
    assert.equal(r.execResult.exceptionError, undefined);
    return { valid: BigInt(`0x${Buffer.from(r.execResult.returnValue).toString('hex')}`) === 0n, gas: r.execResult.executionGasUsed };
  };
  assert.ok((await validate(real, fx.operation.userOpHash)).valid);
  assert.ok(!(await validate(real, keccak256(fx.operation.userOpHash))).valid);
  const SIG = [{ type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'string' }, { type: 'string' }] as const;
  const stand = decodeAbiParameters(SIG, signatureIn((await standInRequest(op, account, '0.6')).data as Hex));
  const theirs = decodeAbiParameters(SIG, real);
  assert.deepEqual(stand.slice(2), theirs.slice(2), "the account's own form: its authenticator data and clientDataJSON around the challenge");
  // Its scalars skip as many of the P-256 loop's additions as a signature does on average (8 of 128).
  const { p256SkippedPairs } = await import('../src/erc4337-sim.ts');
  const opHash = userOpHash(readOperation(op, '0.6')!, EP6, 999, '0.6');
  const e = BigInt(sha256(concatHex([stand[2], sha256(stringToHex(`${stand[3]}${Buffer.from(hexToBytes(opHash)).toString('base64url')}${stand[4]}`))])));
  assert.equal(p256SkippedPairs(e, stand[0], stand[1]), 8);

  // What the stand-in's check costs against a real passkey's signature of the same operation: a key of the test's set as
  // the account's, its assertion in the same form. The P-256 check's cost moves with the signature's scalars (about 1%).
  const hash = userOpHash(readOperation(op, '0.6')!, EP6, 999, '0.6');
  const key = hexToBytes(sha256(stringToHex('a test passkey')));
  const pub = p256.getPublicKey(key, false);
  const clientDataJSON = `${theirs[3]}${Buffer.from(hexToBytes(hash)).toString('base64url')}${theirs[4]}`;
  const { r, s } = p256.sign(hexToBytes(sha256(concatHex([theirs[2], sha256(stringToHex(clientDataJSON))]))), key);
  const R1 = BigInt(keccak256(stringToHex('v0.trustwallet.diamond.storage.Secp256r1VerificationStorage')));
  const before = await Promise.all([0n, 1n].map(i => chain.evm.stateManager.getStorage(at(account), setLengthLeft(hexToBytes(numberToHex(R1 + i)), 32))));
  await chain.evm.stateManager.putStorage(at(account), setLengthLeft(hexToBytes(numberToHex(R1)), 32), pub.slice(1, 33));
  await chain.evm.stateManager.putStorage(at(account), setLengthLeft(hexToBytes(numberToHex(R1 + 1n)), 32), pub.slice(33));
  try {
    const signed = await previewRequest({ method: 'personal_sign', params: [hash, account] }, { now: NOW, chainId: 999, userOperation: { entryPoint: EP6, operation: { ...op, signature: encodeAbiParameters(SIG, [r, s, theirs[2], theirs[3], theirs[4]]) } } }, bnb);
    assert.ok(whole(signed) && !/doesn't accept/.test(whole(signed)!), notes(signed));
    const gap = Number(gasUsed(p) - gasUsed(signed)) / Number(gasUsed(signed));
    assert.ok(Math.abs(gap) < 0.02, `${gasUsed(p)} ${gasUsed(signed)}`);
  } finally {
    for (const [i, v] of before.entries()) await chain.evm.stateManager.putStorage(at(account), setLengthLeft(hexToBytes(numberToHex(R1 + BigInt(i))), 32), v);
  }
});

/** The operation's signature in a simulateHandleOp request (EntryPoint v0.6's). */
function signatureIn(data: Hex): Hex {
  const { args } = decodeFunctionData({ abi: parseAbi(['function simulateHandleOp((address sender, uint256 nonce, bytes initCode, bytes callData, uint256 callGasLimit, uint256 verificationGasLimit, uint256 preVerificationGas, uint256 maxFeePerGas, uint256 maxPriorityFeePerGas, bytes paymasterAndData, bytes signature) op, address target, bytes targetCallData)']), data });
  return (args[0] as { signature: Hex }).signature;
}

test('A ZeroDev passkey account whose last operation is beyond the usual lookup: its flag read from it all the same, where the node answers a wide range', async () => {
  const KERNEL = '0xbac849bb641841b44e965fb01a4bf5f074f84b4d', VALIDATOR = '0x7ab16ff354acb328452f1d445b3ddee9a91e9e69', SENDER = '0x4a1dddee6d5ead88920c4127ec366c9d3f0f2638';
  const HEAD = 30_000_000n, LAST = 27_500_000n; // 2,500,000 blocks back: beyond the 100,000 of the usual lookup
  const OP = '(address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature)';
  const earlier = encodeFunctionData({ abi: parseAbi([`function handleOps(${OP}[] ops, address beneficiary)`]), functionName: 'handleOps', args: [[{ sender: SENDER, nonce: 0n, initCode: '0x', callData: '0x', accountGasLimits: `0x${'00'.repeat(32)}`, preVerificationGas: 0n, gasFees: `0x${'00'.repeat(32)}`, paymasterAndData: '0x', signature: zeroDevWebAuthnStub(`0x${'11'.repeat(32)}`, false) }], BOB] });
  const windows: [bigint, bigint][] = [];
  const rpc = { has: () => true, call: async (_c: number, method: string, params: unknown[]) => {
    if (method === 'eth_getBlockByNumber') return { number: numberToHex(HEAD), baseFeePerGas: '0x1' };
    if (method === 'eth_maxPriorityFeePerGas') return '0x0';
    if (method === 'eth_getCode') return '0x363d3d373d3d363d7f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc545af43d6000803e6038573d6000fd5b3d6000f3';
    if (method === 'eth_getStorageAt') return `0x${KERNEL.slice(2).padStart(64, '0')}`;
    if (method === 'eth_getLogs') {
      const { fromBlock, toBlock } = params[0] as { fromBlock: Hex; toBlock: Hex };
      const from = BigInt(fromBlock), to = BigInt(toBlock);
      windows.push([from, to]);
      // As Arbitrum One's public node: up to 10,000,000 blocks of one sender's logs.
      if (to - from + 1n > 10_000_000n) throw Object.assign(new Error('range'), { rpcError: { code: -32602, message: `query spans ${to - from + 1n} blocks, but only 10000000 are allowed for this request; narrow the block range` } });
      return from <= LAST && LAST <= to ? [{ transactionHash: `0x${'e1'.repeat(32)}` }] : [];
    }
    if (method === 'eth_getTransactionByHash') return { input: earlier };
    if (method === 'eth_call') {
      const { to, data } = params[0] as { to: string; data: string };
      if (to === EP) return `0x${'4a'.repeat(32)}`; // getUserOpHash
      if (data.startsWith('0xf1f7f0f9')) return `0x01${VALIDATOR.slice(2)}${'00'.repeat(11)}`; // rootValidator()
    }
    throw new Error(`unexpected ${method}`);
  } };
  const tried: SimulationRequest[] = [];
  const simulator = { simulate: async (q: SimulationRequest) => { tried.push(q); return null; } };
  await simulateOperation({ chainId: 42161, entryPoint: EP, sender: SENDER, nonce: BigInt(`0x0000${VALIDATOR.slice(2)}0000`) << 64n, initCode: '0x', callData: '0x', callGasLimit: 1n, verificationGasLimit: 1n, preVerificationGas: 1n, maxFeePerGas: 1n, maxPriorityFeePerGas: 0n, paymasterAndData: '0x' }, { rpc, simulator } as never);
  const { args } = decodeFunctionData({ abi: parseAbi([`function simulateHandleOp(${OP} op, address target, bytes targetCallData)`]), data: tried[0].data as Hex });
  const usePrecompiled = decodeAbiParameters([{ type: 'bytes' }, { type: 'string' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bool' }], (args[0] as { signature: Hex }).signature)[5];
  // As its earlier operation signed, not as most do on Arbitrum One (with the precompile): Daimo's verifier stands in.
  assert.equal(usePrecompiled, false);
  assert.ok(tried[0].stateOverrides?.['0xc2b78104907f722dabac4c69f826a522b2754de4'], 'Daimo’s verifier stood in for');
  // The SDK's stub can't overrule it by saying nothing (false), and a signature naming the precompile settles it first.
  for (const [supplied, expected] of [[false, false], [true, true]] as const) {
    tried.length = 0;
    const signature = encodeAbiParameters([{ type: 'bytes' }, { type: 'string' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bool' }], ['0x00', '{}', 1n, 44941127272049826721201904734628716258498742255959991581049806490182030242267n, 2n, supplied]);
    await simulateOperation({ chainId: 42161, entryPoint: EP, sender: SENDER, nonce: BigInt(`0x0000${VALIDATOR.slice(2)}0000`) << 64n, initCode: '0x', callData: '0x', callGasLimit: 1n, verificationGasLimit: 1n, preVerificationGas: 1n, maxFeePerGas: 1n, maxPriorityFeePerGas: 0n, paymasterAndData: '0x', signature }, { rpc, simulator } as never);
    const last = decodeFunctionData({ abi: parseAbi([`function simulateHandleOp(${OP} op, address target, bytes targetCallData)`]), data: tried.at(-1)!.data as Hex });
    assert.equal(zeroDevFlag((last.args[0] as { signature: Hex }).signature), expected, `a stub saying ${supplied}`);
  }
  // The usual lookup's windows first (10,000 blocks each, back to 100,000), then one wide read beyond them.
  assert.ok(windows.some(([from, to]) => to === HEAD - 1n - 100_000n && to - from + 1n === 10_000_000n), JSON.stringify(windows.map(w => w.map(String))));
});

test('A ZeroDev passkey account with no earlier operation to tell: a real assertion says how its wallet verifies; the SDK’s own stub only where it names the precompile', async () => {
  // @zerodev/passkey-validator's getStubSignature wrote usePrecompiled false whatever its signing did until 5.6.1
  // (November 2026), which sets it as the signing does: true only from a wallet that signs so. Its stub is told by
  // its r, the same in every version read.
  const KERNEL = '0xbac849bb641841b44e965fb01a4bf5f074f84b4d', VALIDATOR = '0x7ab16ff354acb328452f1d445b3ddee9a91e9e69', P256 = '0x0000000000000000000000000000000000000100', DAIMO = '0xc2b78104907f722dabac4c69f826a522b2754de4';
  const OP = '(address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature)';
  const rpc = { has: () => true, call: async (_c: number, method: string, params: unknown[]) => {
    if (method === 'eth_getBlockByNumber') return { number: '0x1c9c380', baseFeePerGas: '0x1' };
    if (method === 'eth_maxPriorityFeePerGas') return '0x0';
    if (method === 'eth_getCode') return '0x363d3d373d3d363d7f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc545af43d6000803e6038573d6000fd5b3d6000f3';
    if (method === 'eth_getStorageAt') return `0x${KERNEL.slice(2).padStart(64, '0')}`;
    if (method === 'eth_getLogs') return []; // no earlier operation
    if (method === 'eth_call') {
      const { to, data } = params[0] as { to: string; data: string };
      if (to === EP) return `0x${'4a'.repeat(32)}`; // getUserOpHash
      if (data.startsWith('0xf1f7f0f9')) return `0x01${VALIDATOR.slice(2)}${'00'.repeat(11)}`; // rootValidator()
    }
    throw new Error(`unexpected ${method}`);
  } };
  // The stand-ins tried for the account on a chain, with a wallet's stub or none: each one's flag, and the verifier stood in for.
  const standIns = async (chainId: number, sender: string, signature?: Hex) => {
    const tried: SimulationRequest[] = [];
    const simulator = { simulate: async (q: SimulationRequest) => { tried.push(q); return null; } };
    await simulateOperation({ chainId, entryPoint: EP, sender, nonce: BigInt(`0x0000${VALIDATOR.slice(2)}0000`) << 64n, initCode: '0x', callData: '0x', callGasLimit: 1n, verificationGasLimit: 1n, preVerificationGas: 1n, maxFeePerGas: 1n, maxPriorityFeePerGas: 0n, paymasterAndData: '0x', ...(signature && { signature }) }, { rpc, simulator } as never);
    return tried.map(q => {
      const { args } = decodeFunctionData({ abi: parseAbi([`function simulateHandleOp(${OP} op, address target, bytes targetCallData)`]), data: q.data as Hex });
      const sent = (args[0] as { signature: Hex }).signature;
      return { own: sent === signature, precompiled: zeroDevFlag(sent), verifier: q.stateOverrides?.[P256] ? 'precompile' : q.stateOverrides?.[DAIMO] ? 'daimo' : 'none' };
    });
  };
  // The SDK's stub, as getStubSignature builds it; and a real assertion (any other r).
  const stub = (precompiled: boolean) => encodeAbiParameters([{ type: 'bytes' }, { type: 'string' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bool' }],
    ['0x49960de5880e8c687434170f6476605b8fe4aeb9a28632c7995cf3ba831d97631d00000000', '{"type":"webauthn.get","challenge":"tbxXNFS9X_4Byr1cMwqKrIGB-_30a0QhZ6y7ucM0BOE","origin":"http://localhost:3000","crossOrigin":false}', 1n,
      44941127272049826721201904734628716258498742255959991581049806490182030242267n, 9910254599581058084911561569808925251374718953855182016200087235935345969636n, precompiled]);
  const signed = (precompiled: boolean) => zeroDevWebAuthnStub(`0x${'22'.repeat(32)}`, precompiled);
  assert.deepEqual([zeroDevSays(stub(false)), zeroDevSays(stub(true)), zeroDevSays(signed(false)), zeroDevSays(`0xff${signed(true).slice(2)}`), zeroDevSays(STUB_SIGNATURE)],
    [{ precompiled: false, settles: false }, { precompiled: true, settles: true }, { precompiled: false, settles: true }, { precompiled: true, settles: true }, undefined]);
  // Ethereum, where most sign without the precompile: no stub, so; a stub naming it (run first as it is, with no
  // verifier stood in for), with it.
  assert.deepEqual(await standIns(1, '0x4a1dddee6d5ead88920c4127ec366c9d3f0f2601'), [{ own: false, precompiled: false, verifier: 'daimo' }]);
  // (Nothing between the two: the stub's r and s aren't taken for an ECDSA signature's, to stand in for in its form.)
  assert.deepEqual((await standIns(1, '0x4a1dddee6d5ead88920c4127ec366c9d3f0f2602', stub(true))), [{ own: true, precompiled: true, verifier: 'none' }, { own: false, precompiled: true, verifier: 'precompile' }]);
  // Base, where most sign with it: a stub that doesn't name it is what every wallet's was, and changes nothing.
  assert.deepEqual((await standIns(8453, '0x4a1dddee6d5ead88920c4127ec366c9d3f0f2603', stub(false))), [{ own: true, precompiled: false, verifier: 'none' }, { own: false, precompiled: true, verifier: 'precompile' }]);
  // And on Ethereum such a stub leaves the chain's usual way, the verifier contract.
  assert.deepEqual((await standIns(1, '0x4a1dddee6d5ead88920c4127ec366c9d3f0f2604', stub(false))), [{ own: true, precompiled: false, verifier: 'none' }, { own: false, precompiled: false, verifier: 'daimo' }]);
  // A real assertion that the account refuses all the same (it isn't over this operation) still says how its wallet
  // verifies: on Base, through the verifier contract.
  assert.deepEqual((await standIns(8453, '0x4a1dddee6d5ead88920c4127ec366c9d3f0f2605', signed(false))), [{ own: true, precompiled: false, verifier: 'none' }, { own: false, precompiled: false, verifier: 'daimo' }]);
  // What the preview says where it only took the chain's usual way.
  assert.match(zeroDevAssumed(8453, true), /isn't known: no earlier operation of the account's was found to show it, and nothing supplied with this one says\. It is taken to use the chain's P-256 precompile, as most ZeroDev passkey wallets on Base do\. If it uses a verifier contract \(P-256 in Solidity\) instead, the operation takes about 335,000 gas more than shown\./);
  assert.match(zeroDevAssumed(1, false), /taken to use a verifier contract \(P-256 in Solidity\), as most ZeroDev passkey wallets on Ethereum do\. If it uses the chain's P-256 precompile instead, the operation takes about 335,000 gas less than shown\./);
  // With the SDK's stub: said, and why it doesn't count. Two such signatures (an enable-mode operation's): twice the gas.
  assert.match(zeroDevAssumed(8453, true, { stub: true, signatures: 2 }), /and the signature supplied with this one is the stub of ZeroDev's SDK, which named a verifier contract whatever the wallet signed with until its version 5\.6\.1\. It is taken .* takes about 670,000 gas more than shown\./);
  // A chain where such wallets weren't counted: nothing said of what most do, nor that it has the precompile.
  const op = zeroDevAssumed(10, false);
  assert.doesNotMatch(op, /as most/);
  assert.match(op, /taken to use a verifier contract \(P-256 in Solidity\), which needs nothing of the chain\. If the chain has a P-256 precompile and the wallet uses it, the operation takes about 335,000 gas less than shown\./);
});

test('Circle’s modular wallet: its weighted multisig plugin’s 65-byte parts by owner id, a passkey’s assertion where its part points, one part over the operation’s own digest', async () => {
  // Base, 2026-11-23 (account 0xfdee…5d02, a passkey its only owner): the plain stand-in was refused, the gas 2% low;
  // with this one the operation validates, within 0.07%. Its own signature began with the first part below.
  const PLUGIN = '0x0000000c984aff541d6ce86bb697e68ec57873c8', MSCA = '0xa70f1296869da9d7cb69578123f21888e6db2b62', SENDER = '0xfdee47475a7044201c043a460a88cb25eaba5d02';
  const OP = '(address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature)';
  const OWNERSHIP = [{ type: 'bytes30[]' }, { type: 'tuple[]', components: [{ name: 'weight', type: 'uint256' }, { name: 'credType', type: 'uint8' }, { name: 'addr', type: 'address' }, { name: 'publicKeyX', type: 'uint256' }, { name: 'publicKeyY', type: 'uint256' }] },
    { type: 'tuple', components: [{ name: 'numOwners', type: 'uint256' }, { name: 'thresholdWeight', type: 'uint256' }, { name: 'totalWeight', type: 'uint256' }] }] as const;
  const PASSKEY_ID = '0x9fe7160dd2d7dca3d06407da025d82e687c9b6704c0344b00ec03da74034', KEY = '0x00000000000000000000000000000000000000e1', OTHER = '0x00000000000000000000000000000000000000e2';
  const id30 = (address: string) => `0x${address.slice(2).padStart(60, '0')}` as Hex;
  const passkey = (weight: bigint) => ({ id: PASSKEY_ID as Hex, data: { weight, credType: 0, addr: `0x${'00'.repeat(20)}` as Hex, publicKeyX: 7n, publicKeyY: 8n } });
  const key = (address: string, weight: bigint) => ({ id: id30(address), data: { weight, credType: 1, addr: address as Hex, publicKeyX: 0n, publicKeyY: 0n } });
  let owners = [passkey(1n)], threshold = 1n;
  const HASH = `0x${'4a'.repeat(32)}` as Hex, callData = '0x34fcd5be' as Hex, nonce = 5n;
  const rpc = { has: () => true, call: async (_c: number, method: string, params: unknown[]) => {
    if (method === 'eth_getBlockByNumber') return { number: '0x10', baseFeePerGas: '0x1' };
    if (method === 'eth_maxPriorityFeePerGas') return '0x0';
    if (method === 'eth_getLogs') return [];
    if (method === 'eth_getCode') return '0x363d3d373d3d363d7f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc545af43d6000803e6038573d6000fd5b3d6000f3';
    if (method === 'eth_getStorageAt') return `0x${MSCA.slice(2).padStart(64, '0')}`;
    if (method === 'eth_call') {
      const { to } = params[0] as { to: string };
      if (to === EP) return HASH; // getUserOpHash
      if (to.toLowerCase() === PLUGIN) return encodeAbiParameters(OWNERSHIP, [owners.map(o => o.id), owners.map(o => o.data), { numOwners: BigInt(owners.length), thresholdWeight: threshold, totalWeight: owners.reduce((sum, o) => sum + o.data.weight, 0n) }]);
    }
    throw new Error(`unexpected ${method}`);
  } };
  const first = async (signer?: string) => {
    const tried: SimulationRequest[] = [];
    const simulator = { simulate: async (q: SimulationRequest) => { tried.push(q); return { status: 'reverted' as const, returnData: concatHex(['0x220266b6', encodeAbiParameters([{ type: 'uint256' }, { type: 'string' }], [0n, 'AA24 signature error'])]), transfers: [] }; } };
    const run = await simulateOperation({ chainId: 8453, entryPoint: EP, sender: SENDER, nonce, initCode: '0x', callData, callGasLimit: 1n, verificationGasLimit: 1n, preVerificationGas: 1n, maxFeePerGas: 1n, maxPriorityFeePerGas: 0n, paymasterAndData: '0x', ...(signer && { signer }) }, { rpc, simulator } as never);
    const { args } = decodeFunctionData({ abi: parseAbi([`function simulateHandleOp(${OP} op, address target, bytes targetCallData)`]), data: tried[0].data as Hex });
    return { signature: (args[0] as { signature: Hex }).signature.slice(2), overrides: tried[0].stateOverrides ?? {}, note: run?.note, why: run?.why };
  };
  const assertion = (hex: string) => decodeAbiParameters([{ type: 'tuple', components: [{ name: 'webAuthnData', type: 'tuple', components: [{ name: 'authenticatorData', type: 'bytes' }, { name: 'clientDataJSON', type: 'string' }, { name: 'challengeIndex', type: 'uint256' },
    { name: 'typeIndex', type: 'uint256' }, { name: 'requireUserVerification', type: 'bool' }] }, { name: 'r', type: 'uint256' }, { name: 's', type: 'uint256' }] }], `0x${hex}`)[0];
  const b64 = (hex: Hex) => Buffer.from(hex.slice(2), 'hex').toString('base64url');
  const actual = hashMessage({ raw: HASH });
  // The digest owners can sign before the gas is settled: the operation with its gas fields zeroed and no paymaster.
  const minimal = hashMessage({ raw: keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'address' }, { type: 'uint256' }], [keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'bytes32' }],
    [SENDER, nonce, keccak256('0x'), keccak256(callData), `0x${'00'.repeat(32)}`, 0n, `0x${'00'.repeat(32)}`, keccak256('0x')])), EP as Hex, 8453n])) });

  // A passkey its only owner, the account itself asked: its id, the offset just past the one part, type 2 and 32 (over
  // the operation's own digest), as the mined operation's; then the assertion's length and the assertion.
  const one = await first();
  assert.equal(one.signature.slice(0, 130), `0000${PASSKEY_ID.slice(2)}${'41'.padStart(64, '0')}22`);
  const length = Number(BigInt(`0x${one.signature.slice(130, 194)}`));
  assert.equal(one.signature.length / 2, 65 + 32 + length);
  const a = assertion(one.signature.slice(194));
  assert.deepEqual([a.webAuthnData.clientDataJSON.slice(0, 80), a.webAuthnData.challengeIndex, a.webAuthnData.typeIndex, a.webAuthnData.requireUserVerification],
    [`{"type":"webauthn.get","challenge":"${b64(actual)}","origin":"https://`.slice(0, 80), 23n, 1n, true]);
  assert.equal(a.webAuthnData.authenticatorData.slice(66, 68), '05', 'user present and verified');
  assert.deepEqual([a.r, a.s], [BigInt(`0x${'5a'.repeat(32)}`), BigInt(`0x${'25'.repeat(32)}`)]);
  assert.ok(one.overrides['0x0000000000000000000000000000000000000100'], 'the P-256 precompile stood in for');
  assert.equal(one.note, undefined);
  // An address its owner, named as the signer: r, s, and v with 32 added.
  owners = [key(KEY, 1n)];
  assert.equal((await first(KEY)).signature, `${STUB_SIGNATURE.slice(2, 130)}3c`);
  // Two owners of weight 1 and a threshold of 2: the key signs the operation, the passkey the minimal digest (type 2
  // alone), in the order of their ids (the key's, an address, is the lower), and the preview is told.
  owners = [passkey(1n), key(KEY, 1n)]; threshold = 2n;
  const two = await first(KEY);
  assert.equal(two.signature.slice(0, 260), `${STUB_SIGNATURE.slice(2, 130)}3c0000${PASSKEY_ID.slice(2)}${'82'.padStart(64, '0')}02`);
  assert.match(assertion(two.signature.slice(260 + 64)).webAuthnData.clientDataJSON, new RegExp(`"challenge":"${b64(minimal)}"`));
  assert.match(two.note ?? '', /through Circle's weighted multisig plugin \(0x0000…73c8\), which takes its owners' signatures until their weights reach 2\. The signer's is 1, so another owner \(a passkey\), or others of as much weight, must sign it too/);
  // The passkey sends it instead (the account itself asked), the key signing the minimal digest: the key's part first, as it was signed over that.
  const other = await first();
  assert.equal(other.signature.slice(0, 130), `${stubSignature(1).slice(2, 130)}1c`);
  assert.equal(other.signature.slice(130, 260), `0000${PASSKEY_ID.slice(2)}${'82'.padStart(64, '0')}22`);
  assert.match(assertion(other.signature.slice(260 + 64)).webAuthnData.clientDataJSON, new RegExp(`"challenge":"${b64(actual)}"`));
  // A signer who is none of the owners: said, where the plugin refuses it.
  assert.match((await first(OTHER)).why ?? '', /Circle's weighted multisig plugin \(0x0000…73c8\) takes the signatures of the account's owners \(a passkey, 0x0000…00e1\), and the signer asked isn't one of them \(a passkey wallet signs as the account itself\)/);
  // Weights that can't reach the threshold: the plain stand-in.
  threshold = 5n;
  assert.equal(`0x${(await first(KEY)).signature}`, STUB_SIGNATURE);
});

test('Exa’s account (Modular Account v1, Exactly’s WebauthnOwnerPlugin): the owner’s index, then a passkey’s WebAuthn assertion or an address owner’s signature, which its real code checks', async () => {
  // Its real code (Arbitrum One), set up as Exa's factory sets an account up: initialize([plugin], abi.encode(
  // [manifest hash], [abi.encode(owners)])), owners sorted by address (a passkey's: its key's hash, high bytes).
  // STUB_SIGNATURE's first byte names no owner: validation reverted (AA23), and the calls were simulated alone.
  const fx = fixture('exa-mav1.json');
  await install(fx);
  const { MODULAR_ACCOUNT_V1, standInPasskey } = await import('../src/erc4337-sim.ts');
  assert.equal(fx.implementation, MODULAR_ACCOUNT_V1);
  const ACCOUNT = '0x00000000000000000000000000000000e0a0e0a1', KEY = '0x00000000000000000000000000000000e0a0e0b2';
  await chain.putCode(ACCOUNT, fx.proxy);
  await chain.evm.stateManager.putStorage(at(ACCOUNT), hexToBytes('0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'), hexToBytes(fx.implementation));
  const run = async (to: string, data: Hex, from = BOB) => {
    const res = await chain.evm.runCall({ caller: at(from), origin: at(from), to: at(to), data: hexToBytes(data), gasLimit: 10_000_000n });
    assert.ok(!res.execResult.exceptionError, `${data.slice(0, 10)} reverted`);
    return `0x${Buffer.from(res.execResult.returnValue).toString('hex')}` as Hex;
  };
  const manifestHash = keccak256(await run(fx.plugin, '0xc7763130')); // pluginManifest()
  const { x, y } = standInPasskey();
  const passkey = { x: BigInt(x), y: BigInt(y) }, address = { x: BigInt(KEY), y: 0n };
  const ownerAddress = (o: { x: bigint; y: bigint }) => o.y === 0n ? o.x : BigInt(keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [o.x, o.y])).slice(0, 42));
  const owners = [passkey, address].sort((a, z) => (ownerAddress(a) < ownerAddress(z) ? -1 : 1));
  const PUBLIC_KEYS = [{ type: 'tuple[]', components: [{ name: 'x', type: 'uint256' }, { name: 'y', type: 'uint256' }] }] as const;
  const initialize = encodeFunctionData({ abi: parseAbi(['function initialize(address[] plugins, bytes pluginInitData)']), args: [[fx.plugin as Hex],
    encodeAbiParameters([{ type: 'bytes32[]' }, { type: 'bytes[]' }], [[manifestHash], [encodeAbiParameters(PUBLIC_KEYS, [owners])]])] });
  await run(ACCOUNT, initialize);
  await funded(ACCOUNT);
  assert.equal(await implementationOf(deps, 999, ACCOUNT), MODULAR_ACCOUNT_V1);
  const callData = encodeFunctionData({ abi: parseAbi(['function executeBatch((address target, uint256 value, bytes data)[] calls)']), args: [[{ target: usdc as Hex, value: 0n, data: transfer }]] });
  const op = operation({ sender: ACCOUNT, initCode: '0x', callData, paymasterAndData: '0x' });
  // The account itself asked, as Exa's wallet asks: its passkey's assertion, under its index.
  const request = await standInRequest(op, ACCOUNT, '0.6');
  const signature = decodeFunctionData({ abi: parseAbi(['function simulateHandleOp((address sender, uint256 nonce, bytes initCode, bytes callData, uint256 callGasLimit, uint256 verificationGasLimit, uint256 preVerificationGas, uint256 maxFeePerGas, uint256 maxPriorityFeePerGas, bytes paymasterAndData, bytes signature) op, address target, bytes targetCallData)']), data: request.data as Hex }).args[0].signature;
  assert.equal(signature.slice(0, 4), `0x0${owners.indexOf(passkey)}`);
  const [auth] = decodeAbiParameters([{ type: 'tuple', components: [{ name: 'authenticatorData', type: 'bytes' }, { name: 'clientDataJSON', type: 'string' }, { name: 'challengeIndex', type: 'uint256' }, { name: 'typeIndex', type: 'uint256' }, { name: 'r', type: 'uint256' }, { name: 's', type: 'uint256' }] }], `0x${signature.slice(4)}`);
  const hash = userOpHash(readOperation(op, '0.6')!, EP6, 999, '0.6');
  assert.equal(JSON.parse(auth.clientDataJSON).origin, 'https://web.exactly.app');
  assert.equal(`0x${Buffer.from(JSON.parse(auth.clientDataJSON).challenge, 'base64url').toString('hex')}`, hashMessage({ raw: hash })); // abi.encode(toEthSignedMessageHash(userOpHash))
  const p = await preview(op, ACCOUNT, '0.6');
  assert.ok(whole(p) && !/doesn't accept/.test(whole(p)!), notes(p));
  assert.deepEqual(usdcChange(p), ['out 50']);
  // An address owner asked: its index, then its signature (the ECDSA stand-in, recovered as it).
  const k = await preview(op, KEY, '0.6');
  assert.ok(whole(k) && /ecrecover attributes it to the signer\)/.test(whole(k)!) && !/doesn't accept/.test(whole(k)!), notes(k));
  assert.deepEqual(usdcChange(k), ['out 50']);
  // Someone who isn't an owner: refused, as it will be, and the preview says why.
  const b = await preview(op, BOB, '0.6');
  assert.ok(!whole(b) || /doesn't accept/.test(whole(b)!), notes(b));
  assert.match(notes(b) + p.warnings.map(w => w.message).join(' ') + b.warnings.map(w => w.message).join(' '), /WebauthnOwnerPlugin/);
});
