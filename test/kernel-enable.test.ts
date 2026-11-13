// ZeroDev Kernel v3's Enable typed data: what an account's owner signs to install a session key (a permission) or a
// validator on the account (src/typed-data/kernel-enable.ts). The fixtures are real Enable messages, rebuilt from
// enable-mode operations on Base, Arbitrum One, BNB Chain and Ethereum (each operation's signature carries the enable
// data and the owner's signature of it), each with what proves its digest: the owner's signature, a Merkle proof, a
// cosignature or a passkey's assertion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, createPublicKey, createVerify } from 'node:crypto';
import { concat, concatHex, decodeAbiParameters, encodeAbiParameters, hashMessage, keccak256, recoverAddress, slice, zeroAddress, type Hex } from 'viem';
import { previewRequest } from '../src/preview.ts';
import { StaticTokenRegistry } from '../src/chains.ts';
import type { Dependencies } from '../src/types.ts';
import { ALICE, BOB } from '../mocks/data.ts';
import { codes, detail, NOW } from './helpers.ts';

interface Fixture { name: string; chainId: number; account: string; kernel: string; digest: Hex; enableSignature: Hex; typedData: { message: Record<string, unknown> }; proof: { kind: string; owner?: string; cosigner?: string; root?: Hex; proof?: Hex[]; ownerSignature?: Hex; over?: string; x?: Hex; y?: Hex } }
const FIXTURES: Fixture[] = JSON.parse(readFileSync(new URL('./fixtures/kernel-enable.json', import.meta.url), 'utf8'));
const fixture = (account: string) => FIXTURES.find(f => f.account === account)!;
const deps: Dependencies = { tokens: new StaticTokenRegistry() };
const sign = (data: unknown, signer: string = ALICE, d: Dependencies = deps, context = {}) => previewRequest({ method: 'eth_signTypedData_v4', params: [signer, JSON.stringify(data)] }, { now: NOW, ...context }, d);
const preview = (f: Fixture) => sign(f.typedData, f.proof.owner ?? f.account);

/** Who signed `hash`, as raw ECDSA and in personal_sign's form. */
const signers = async (hash: Hex, signature: Hex) => [(await recoverAddress({ hash, signature })).toLowerCase(), (await recoverAddress({ hash: hashMessage({ raw: hash }), signature })).toLowerCase()];
/** A passkey's assertion (ZeroDev's WebAuthn validator): its challenge, and its P-256 signature by the key (x, y). */
function passkeySigned(signature: Hex, x: Hex, y: Hex): { challenge: string; valid: boolean } {
  const [authenticatorData, clientDataJSON, , r, s] = decodeAbiParameters([{ type: 'bytes' }, { type: 'string' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bool' }], signature);
  const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: Buffer.from(x.slice(2), 'hex').toString('base64url'), y: Buffer.from(y.slice(2), 'hex').toString('base64url') }, format: 'jwk' });
  const verify = createVerify('sha256');
  verify.update(Buffer.concat([Buffer.from(authenticatorData.slice(2), 'hex'), createHash('sha256').update(clientDataJSON).digest()]));
  const raw = Buffer.concat([Buffer.from(r.toString(16).padStart(64, '0'), 'hex'), Buffer.from(s.toString(16).padStart(64, '0'), 'hex')]);
  return { challenge: JSON.parse(clientDataJSON).challenge, valid: verify.verify({ key, dsaEncoding: 'ieee-p1363' }, raw) };
}

test('Real Kernel Enable messages: the preview\'s digest is the one each owner signed, checked from the owner\'s own signature', async () => {
  assert.equal(FIXTURES.length, 9);
  for (const f of FIXTURES) {
    const p = await preview(f);
    assert.equal(p.decoding.decoder, 'kernel_enable', f.name);
    assert.equal(detail(p, 'EIP-712 digest'), f.digest, f.name);
    const sig = f.enableSignature;
    switch (f.proof.kind) {
      case 'ecdsa': // ZeroDev's ECDSA validator (the digest, or its personal_sign form), or the EIP-7702 account's own key
        assert.ok((await signers(f.digest, sig)).includes(f.proof.owner!), f.name);
        break;
      case 'merkle': { // the multi-chain ECDSA validator: the owner signs a Merkle root of Enable digests, one a leaf
        let node = f.digest;
        for (const p of f.proof.proof!) node = BigInt(node) < BigInt(p) ? keccak256(concat([node, p])) : keccak256(concat([p, node]));
        assert.equal(node, f.proof.root, f.name);
        assert.equal((await signers(f.proof.root!, f.proof.ownerSignature!))[1], f.proof.owner, f.name);
        assert.equal(slice(sig, 0, 65), f.proof.ownerSignature);
        break;
      }
      case 'cosigned': // Bleap's CosigningModuleV2: 0xff, then the owner's and the cosigner's signatures of the digest
        assert.equal(sig.slice(0, 4), '0xff');
        assert.ok((await signers(f.digest, slice(sig, 1, 66))).includes(f.proof.owner!), f.name);
        assert.ok((await signers(f.digest, slice(sig, 66, 131))).includes(f.proof.cosigner!), f.name);
        break;
      case 'passkey': { // ZeroDev's WebAuthn validator: the assertion's challenge is the digest
        const { challenge, valid } = passkeySigned(sig, f.proof.x!, f.proof.y!);
        assert.equal(challenge, Buffer.from(f.digest.slice(2), 'hex').toString('base64url'), f.name);
        assert.ok(valid, f.name);
        break;
      }
      default: assert.fail(`unknown proof ${f.proof.kind}`);
    }
  }
});

test('Real grants: who gets the key, what its policies allow, and how much attention it needs', async () => {
  // Base, a deploying account: a session key with ZeroDev's sudo policy, the owner's multi-chain validator signing.
  const sudo = await preview(fixture('0x945e305c832ed97e3be4ed885f0b451fad07f529'));
  assert.equal(sudo.title, 'Let session key 0xa538…7b56 act for your Kernel account, without limits');
  assert.equal(sudo.attention, 'danger');
  assert.deepEqual(codes(sudo), ['kernel_enable_unrestricted', 'kernel_enable_signs_for_account']);
  assert.equal(detail(sudo, 'Session key'), "0xa53835d3eb7a8a6666c4771c29bc4db546137b56 (an ordinary key, checked by ZeroDev's ECDSA signer)");
  assert.equal(detail(sudo, 'Policy 1'), "ZeroDev's sudo policy: no limits");
  assert.equal(detail(sudo, 'Kernel version'), '0.3.1 (Kernel v3.1, from the signing domain)');
  assert.equal(detail(sudo, 'Account function it may use'), 'execute(bytes32,bytes): run calls from your account');
  assert.deepEqual(sudo.network, { kind: 'evm', chainId: 8453, name: 'Base' });
  // Kernel v3.3 as an EIP-7702 account, signed by the account's own key: the same, on Arbitrum One.
  const delegated = await preview(fixture('0x2c59589c54f0375e4e5b4ccc7d59196d4e0e115a'));
  assert.equal(delegated.attention, 'danger');
  assert.equal(detail(delegated, 'Kernel version'), '0.3.3 (Kernel v3.3, from the signing domain)');

  // Ethereum: a call policy (approve and deposit, with argument rules), gas, signature-caller, rate limit and time.
  const calls = await preview(fixture('0x1cae21c1e85505d902372181262e9c23cdf69e3b'));
  assert.equal(calls.title, 'Let session key 0x7fee…7c02 act for your Kernel account: 2 allowed calls');
  assert.equal(calls.attention, 'caution');
  assert.deepEqual(codes(calls), ['kernel_enable_grant', 'kernel_enable_time_limit']);
  assert.equal(detail(calls, 'Allowed call 1'), 'approve(address,uint256) on USDC (0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48): spender must be one of 0x777777777777aec03fd955926dbf81597e66834c or 0xbeef088055857739c12cd3765f20b7679def0f51, amount must be at most 500 USDC; no ETH');
  assert.equal(detail(calls, 'Allowed call 2'), 'deposit(uint256,address) on 0xbeef088055857739c12cd3765f20b7679def0f51: assets must be at most 500000000, receiver must be 0x1cae21c1e85505d902372181262e9c23cdf69e3b (your account); no ETH');
  assert.equal(detail(calls, 'Policy 2'), "ZeroDev's gas policy: any amount of gas, paid by paymaster 0x777777777777aec03fd955926dbf81597e66834c only");
  assert.equal(detail(calls, 'Policy 3'), "ZeroDev's signature-caller policy: its signatures are accepted by no one");
  assert.equal(detail(calls, 'Policy 4'), "ZeroDev's rate-limit policy (with reset): at most 3 operations every 1 day");
  assert.equal(detail(calls, 'Policy 5'), "ZeroDev's timestamp policy: operations until 2027-11-12T07:00:38Z");
  assert.equal(detail(calls, 'Signs as your account (ERC-1271)'), 'no');

  // Base: one USDC transfer of 25 to one address, once, for ten minutes; it can still sign as the account.
  const once = await preview(fixture('0xb1ac8759f09dfab9ad2b856430fcf83a12a565ac'));
  assert.equal(once.title, 'Let session key 0x2c5f…e581 act for your Kernel account: 1 allowed call');
  assert.equal(detail(once, 'Allowed call 1'), 'transfer(address,uint256) on USDC (0x833589fcd6edb6e08f4c7c32d4f71b54bda02913): to must be 0xeac0b0010e78e46a7415ec88c63e9f0b8359c3c2, amount must be 25 USDC; no ETH');
  assert.equal(detail(once, 'Policy 3'), "ZeroDev's rate-limit policy: one operation only, from 2026-11-12T21:24:46Z");
  assert.deepEqual(codes(once), ['kernel_enable_grant', 'kernel_enable_signs_for_account', 'kernel_enable_time_limit']);
  assert.match(once.warnings[1].message, /its time limit covers only its operations/);
  assert.match(once.warnings[0].message, /until 2026-11-12T21:26:45Z/);

  // BNB Chain: call policy 0.0.5 (operations only), a static tuple's fields named, a window from and until.
  const swap = await preview(fixture('0x07eacacc02c42bffcf5b518d09fc05ed0237dc0a'));
  assert.equal(detail(swap, 'Policy 1'), "ZeroDev's call policy 0.0.5: only the 2 calls listed below (operations only)");
  assert.match(detail(swap, 'Allowed call 1')!, /^exactInputSingle\(\(address,address,uint24,address,uint256,uint256,uint256,uint160\)\) on 0x1b81d678ffb9c0263b24a97847620c99d213eb14: params\.tokenIn must be one of 0x55d398326f99059ff775485246999027b3197955 or /);
  assert.equal(detail(swap, 'Allowed call 2'), 'transfer(address,uint256) on USDT (0x55d398326f99059ff775485246999027b3197955): to must be 0x1c573cccf179ca067d48e9af6a528a818f6e0a52, amount must be at most 10 USDT; no BNB');
  assert.match(detail(swap, 'It can')!, /, from 2026-11-12T09:30:26Z until 2027-02-10T09:30:26Z$/);

  // Bleap: token transfers to one address only, by a key its cosigner must countersign; no signatures.
  const bleap = await preview(fixture('0x6b85697b26670e3a9c10bfcf23d4b39eda471d4b'));
  assert.equal(bleap.title, "Let key 0xe409…104c with Bleap's cosigner act for your Kernel account: token transfers to 0x4767…675f only");
  assert.deepEqual(codes(bleap), ['kernel_enable_grant']);
  assert.equal(detail(bleap, 'Signs as your account (ERC-1271)'), 'no');

  // A validator: ZeroDev's weighted ECDSA (guardian) validator, for doRecovery handled by its recovery action, which
  // runs as the account and re-installs any of its validators with new data: it can replace the owner.
  const recovery = await preview(fixture('0x17f579f3390de3b59bac621ca4f6292b4c61e558'));
  assert.equal(recovery.title, 'Let guardian key 0x22ca…b4bf act for your Kernel account');
  assert.equal(recovery.attention, 'danger');
  assert.deepEqual(codes(recovery), ['kernel_enable_recovery', 'kernel_enable_grant', 'kernel_enable_signs_for_account']);
  assert.match(recovery.warnings[0].message, /lets guardian key 0x22ca…b4bf call it: ZeroDev's recovery action re-installs any of your account's validators with new data .* so it can replace your account's owner\.$/);
  assert.equal(detail(recovery, 'Installs'), "validator ZeroDev's weighted ECDSA (guardian) validator (0xed89244160cfe273800b58b1b534031699dfeeee)");
  assert.equal(detail(recovery, 'Account function it may use'), "doRecovery(address,bytes) (not one of Kernel's own)");
  assert.match(detail(recovery, 'Installs a handler')!, /^ZeroDev's recovery action .* run by delegatecall: as your account itself/);
  assert.equal(recovery.decoding.status, 'partial');

  // An unknown policy, with a handler for a function of its own run by delegatecall (its code runs as the account):
  // named by address, no limit claimed, and danger.
  const unknown = await preview(fixture('0xacec324bf68561acbbafc9daea24bf857de3d5ba'));
  assert.equal(unknown.attention, 'danger');
  assert.deepEqual(codes(unknown), ['kernel_enable_delegatecall_handler', 'kernel_enable_grant', 'kernel_enable_unknown_policy', 'kernel_enable_signs_for_account']);
  assert.match(unknown.warnings[0].message, /^It installs 0x43c212dd007a8194e3b8092e5f46ec49b5ad554e to handle your account's function 0xe45c51d2 by delegatecall, as your account itself/);
  assert.match(detail(unknown, 'Policy 1')!, /^0xa4e649a289a826b1d9a71a3127494855679e0b3f \(unknown\)/);
  assert.equal(detail(unknown, 'Signs as your account (ERC-1271)'), 'yes, unless an unknown policy stops it');
  assert.equal(unknown.decoding.status, 'partial');

  // A passkey's account: a call to the account's own uninstallValidation, signatures for two contracts only.
  const passkey = await preview(fixture('0x386ba95e958c180313d05f3750dbc94676ab32bf'));
  assert.equal(passkey.title, 'Let session key 0x8c03…e20a act for your Kernel account: 3 allowed calls');
  assert.equal(detail(passkey, 'Allowed call 3'), "your account's own uninstallValidation(bytes21,bytes,bytes) (remove keys from your account), any arguments; no ETH");
  assert.equal(detail(passkey, 'Signs as your account (ERC-1271)'), 'yes, only when 0x954768e41236cf2ea910f494a9e13dfc372c57b9, 0xd59245a0cbdbc84b21a4586e57352167a9e6c778 check it');
  assert.equal(passkey.attention, 'caution');
});

// Synthetic messages, built as ZeroDev's SDK builds them.
const ACCOUNT = '0xacc0000000000000000000000000000000000001';
const KEY = '0x5e55100000000000000000000000000000000001';
const ECDSA_SIGNER = '0x6a6f069e2a08c2468e7724ab3250cdbfba14d4ff', ECDSA_VALIDATOR = '0x845adb2c711129d4f3966735ed98a9f09fc4ce57';
const SUDO = '0x67b436cad8a6d025df6c82c5bb43fbf11fc5b9b7', CALL_POLICY = '0x9a52283276a0ec8740df50bf01b28a80d880eaf2', TIMESTAMP = '0xb9f8f524be6ecd8c945b1b87f9ae5c192fdce20f';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const entry = (flag: Hex, module: string, data: Hex = '0x') => concatHex([flag, module as Hex, data]);
const permission = (...entries: Hex[]) => encodeAbiParameters([{ type: 'bytes[]' }], [entries]);
const ecdsaKey = (flag: Hex = '0x0000') => entry(flag, ECDSA_SIGNER, KEY);
const PERMISSION_ID = `0x02c0ffee01${'00'.repeat(16)}`;
/** selectorData as ZeroDev's SDK sends it: execute, with address 0 as its handler and no hook. */
const selectorData = (selector: Hex = '0xe9ae5c53') => concatHex([selector, zeroAddress, zeroAddress, encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes' }], ['0xff', '0x0000'])]);
const callPolicy = (perms: { callType?: Hex; target: string; selector: Hex; valueLimit?: bigint; rules?: { condition: number; offset: bigint; params: Hex[] }[] }[]) => encodeAbiParameters([{ type: 'tuple[]', components: [{ name: 'callType', type: 'bytes1' }, { name: 'target', type: 'address' }, { name: 'selector', type: 'bytes4' }, { name: 'valueLimit', type: 'uint256' }, { name: 'rules', type: 'tuple[]', components: [{ name: 'condition', type: 'uint8' }, { name: 'offset', type: 'uint64' }, { name: 'params', type: 'bytes32[]' }] }] }],
  [perms.map(p => ({ callType: p.callType ?? '0x00', target: p.target as Hex, selector: p.selector, valueLimit: p.valueLimit ?? 0n, rules: p.rules ?? [] }))]);
const word = (v: string | bigint) => `0x${(typeof v === 'bigint' ? v.toString(16) : v.slice(2)).padStart(64, '0')}` as Hex;
function enable(message: Record<string, unknown> = {}, domain: Record<string, unknown> = {}) {
  return {
    domain: { name: 'Kernel', version: '0.3.1', chainId: 8453, verifyingContract: ACCOUNT, ...domain },
    types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
      Enable: [{ name: 'validationId', type: 'bytes21' }, { name: 'nonce', type: 'uint32' }, { name: 'hook', type: 'address' }, { name: 'validatorData', type: 'bytes' }, { name: 'hookData', type: 'bytes' }, { name: 'selectorData', type: 'bytes' }] },
    primaryType: 'Enable',
    message: { validationId: PERMISSION_ID, nonce: 1, hook: zeroAddress, validatorData: permission(entry('0x0000', SUDO), ecdsaKey()), hookData: '0x', selectorData: selectorData(), ...message },
  };
}

test('A sudo grant is danger, a time limit with it still lets it do anything until then', async () => {
  const p = await sign(enable());
  assert.equal(p.title, 'Let session key 0x5e55…0001 act for your Kernel account, without limits');
  assert.equal(p.attention, 'danger');
  assert.match(p.warnings[0].message, /^Whoever holds session key 0x5e55…0001 can send any transaction from your account, with no limit: move everything it holds/);
  assert.equal(p.decoding.status, 'full');
  const until = 1_800_000_000;
  const timed = await sign(enable({ validatorData: permission(entry('0x0000', SUDO), entry('0x0000', TIMESTAMP, encodeAbiParameters([{ type: 'uint48' }, { type: 'uint48' }], [0, until])), ecdsaKey()) }));
  assert.equal(timed.attention, 'danger');
  assert.match(timed.warnings[0].message, /from your account until 2027-01-15T08:00:00Z, with no limit/);
  assert.ok(codes(timed).includes('kernel_enable_time_limit'));
  assert.equal(detail(timed, 'Policy 2'), "ZeroDev's timestamp policy: operations until 2027-01-15T08:00:00Z");
});

test('A call-policy grant lists its targets and functions; any contract, delegatecall and the account\'s own admin functions are flagged', async () => {
  const policy = callPolicy([
    { target: USDC, selector: '0xa9059cbb', rules: [{ condition: 0, offset: 0n, params: [word(BOB)] }, { condition: 4, offset: 32n, params: [word(5_000_000n)] }] },
    { target: '0x9ee35bf1bd69a03c6f0393582030fce8bb93d418', selector: '0x12345678', valueLimit: 10n ** 17n },
  ]);
  const p = await sign(enable({ validatorData: permission(entry('0x0000', CALL_POLICY, policy), ecdsaKey('0x0002')) }));
  assert.equal(p.title, 'Let session key 0x5e55…0001 act for your Kernel account: 2 allowed calls');
  assert.equal(p.attention, 'caution');
  assert.deepEqual(codes(p), ['kernel_enable_grant']);
  assert.equal(detail(p, 'Allowed call 1'), `transfer(address,uint256) on USDC (${USDC}): to must be ${BOB}, amount must be at most 5 USDC; no ETH`);
  assert.equal(detail(p, 'Allowed call 2'), 'function 0x12345678 (unknown) on 0x9ee35bf1bd69a03c6f0393582030fce8bb93d418, any arguments; up to 0.1 ETH per call');
  assert.equal(detail(p, 'Signs as your account (ERC-1271)'), 'no');
  assert.match(p.warnings[0].message, /^Whoever holds session key 0x5e55…0001 can make only these calls from your account: transfer on USDC \(0x8335/);

  // Any contract's approve: every token the account holds.
  const any = await sign(enable({ validatorData: permission(entry('0x0000', CALL_POLICY, callPolicy([{ target: zeroAddress, selector: '0x095ea7b3' }])), ecdsaKey()) }));
  assert.equal(detail(any, 'Allowed call 1'), 'approve(address,uint256) on any contract, any arguments; no ETH');
  assert.ok(codes(any).includes('kernel_enable_any_contract'));
  // A delegatecall runs the target's code as the account; the account's own installModule hands it over.
  const delegate = await sign(enable({ validatorData: permission(entry('0x0000', CALL_POLICY, callPolicy([{ callType: '0xff', target: BOB, selector: '0x12345678' }])), ecdsaKey()) }));
  assert.equal(delegate.attention, 'danger');
  assert.match(delegate.warnings.find(w => w.code === 'kernel_enable_takeover')!.message, /delegatecall 0xb0b0000000000000000000000000000000000002: that code runs as your account itself/);
  const admin = await sign(enable({ validatorData: permission(entry('0x0000', CALL_POLICY, callPolicy([{ target: ACCOUNT, selector: '0x9517e29f' }])), ecdsaKey()) }));
  assert.equal(admin.attention, 'danger');
  assert.equal(detail(admin, 'Allowed call 1'), "your account's own installModule(uint256,address,bytes) (install modules on your account), any arguments; no ETH");
  // A call policy that skips operations limits nothing they do.
  const skipped = await sign(enable({ validatorData: permission(entry('0x0001', CALL_POLICY, policy), ecdsaKey()) }));
  assert.equal(skipped.attention, 'danger');
  assert.equal(detail(skipped, 'Policy 1'), "ZeroDev's call policy 0.0.4: only the 2 calls listed below (signatures only)");
});

test('Validators: an ECDSA key that may call execute with no hook is danger; with an unknown hook, still danger; the account\'s admin functions, danger', async () => {
  const validator = { validationId: `0x01${ECDSA_VALIDATOR.slice(2)}`, validatorData: KEY };
  const p = await sign(enable(validator));
  assert.equal(p.title, 'Let key 0x5e55…0001 act for your Kernel account, without limits');
  assert.equal(p.attention, 'danger');
  assert.equal(detail(p, 'Installs'), `validator ZeroDev's ECDSA validator (${ECDSA_VALIDATOR})`);
  assert.equal(detail(p, 'Key'), `${KEY} (an ordinary key: whoever holds it signs)`);
  assert.equal(detail(p, 'Signs as your account (ERC-1271)'), 'yes: a validator signs for the account without limits');
  // An unknown hook may refuse operations, but nothing this previewer can read limits them.
  const hooked = await sign(enable({ ...validator, hook: BOB, hookData: '0x00' }));
  assert.equal(hooked.attention, 'danger');
  assert.equal(hooked.title, 'Let key 0x5e55…0001 act for your Kernel account, with no limit this previewer can read');
  assert.match(hooked.warnings[0].message, new RegExp(`^Whoever holds key 0x5e55…0001 can send any transaction from your account, unless the hook ${BOB}, which this previewer can't read, stops it`));
  assert.ok(codes(hooked).includes('kernel_enable_unknown_hook'));
  assert.equal(detail(hooked, 'Hook'), `${BOB} (unknown), installed with data 0x00`);
  const owner = await sign(enable({ ...validator, selectorData: '0x52141cd9' }));
  assert.equal(owner.attention, 'danger');
  assert.match(owner.warnings.find(w => w.code === 'kernel_enable_takeover')!.message, /changeRootValidator\(bytes21,address,bytes,bytes\), which lets it replace your account's owner/);
});

test('Unknown policies, signers and validators are named by address, and no limit is claimed for them', async () => {
  const policy = '0x9999999999999999999999999999999999999999';
  const p = await sign(enable({ validatorData: permission(entry('0x0000', policy, '0xabcd'), ecdsaKey()) }));
  assert.equal(p.attention, 'danger');
  assert.equal(p.title, 'Let session key 0x5e55…0001 act for your Kernel account, with no limit this previewer can read');
  assert.equal(detail(p, 'Policy 1'), `${policy} (unknown), with data 0xabcd`);
  assert.equal(detail(p, 'It can'), "send any transaction from your account, unless a policy this previewer can't read stops it");
  assert.match(p.warnings.find(w => w.code === 'kernel_enable_unknown_policy')!.message, /don't count on a limit from it/);
  assert.equal(p.decoding.status, 'partial');
  const signer = await sign(enable({ validatorData: permission(entry('0x0000', SUDO), entry('0x0000', policy, KEY)) }));
  assert.equal(signer.attention, 'danger');
  assert.ok(codes(signer).includes('kernel_enable_unknown_signer'));
  assert.equal(detail(signer, 'Signer'), `${policy} (unknown), with data ${KEY}`);
  const validator = await sign(enable({ validationId: `0x01${policy.slice(2)}`, validatorData: KEY }));
  assert.ok(codes(validator).includes('kernel_enable_unknown_validator'));
  assert.equal(validator.title, 'Let validator 0x9999…9999 act for your Kernel account, without limits');
});

test('Kernel Enable: flags, every chain, another type, and a domain that isn\'t Kernel\'s', async () => {
  // The signer's flag: 0x0002, no signatures; 0x0001, no operations (signatures only).
  const noSigs = await sign(enable({ validatorData: permission(entry('0x0000', SUDO), ecdsaKey('0x0002')) }));
  assert.equal(detail(noSigs, 'Signs as your account (ERC-1271)'), 'no');
  assert.ok(!codes(noSigs).includes('kernel_enable_signs_for_account'));
  const sigsOnly = await sign(enable({ validatorData: permission(entry('0x0000', SUDO), ecdsaKey('0x0001')) }));
  assert.equal(sigsOnly.title, 'Let session key 0x5e55…0001 sign for your Kernel account');
  assert.equal(sigsOnly.attention, 'caution');
  assert.deepEqual(codes(sigsOnly), ['kernel_enable_signs_for_account']);
  // Chain ID 0: Kernel v3.2 on accepts it on every chain.
  const everywhere = await sign(enable({}, { version: '0.3.2', chainId: 0 }));
  assert.ok(codes(everywhere).includes('kernel_enable_all_chains'));
  assert.equal(detail(everywhere, 'Chain'), 'every chain (chain ID 0)');
  assert.equal(everywhere.network, null);
  // Another wallet's chain.
  assert.ok(codes(await sign(enable(), ALICE, deps, { chainId: 1 })).includes('chain_mismatch'));
  // A type Kernel doesn't hash.
  const typed = enable();
  typed.types.Enable = typed.types.Enable.map(f => (f.name === 'nonce' ? { name: 'nonce', type: 'uint256' } : f));
  assert.ok(codes(await sign(typed)).includes('kernel_enable_type_mismatch'));
  // An Enable that isn't Kernel's is left to the generic decoder.
  assert.equal((await sign(enable({}, { name: 'Other' }))).decoding.decoder, 'eip712_generic');
});

test('A malformed Kernel Enable message doesn\'t throw: it is a danger (whoever made it chose what can\'t be read)', async () => {
  for (const message of [{ validatorData: '0x1234' }, { validationId: 'nope' }, { selectorData: '0x12' }, { validatorData: permission() }, { validatorData: permission('0x0000') }, { validatorData: undefined }, { hook: 'not an address' }]) {
    const p = await sign(enable(message as Record<string, unknown>));
    assert.equal(p.decoding.decoder, 'kernel_enable', JSON.stringify(message));
    assert.equal(p.decoding.status, 'opaque');
    assert.equal(p.title, 'Sign a Kernel Enable message for 0xacc0…0001 (contents unreadable)');
    assert.equal(p.attention, 'danger');
    assert.deepEqual(codes(p).filter(c => c !== 'kernel_enable_type_mismatch'), ['kernel_enable_unreadable']);
  }
  const bad = await sign(enable({}, { verifyingContract: 'nope' }));
  assert.equal(bad.title, 'Sign a Kernel Enable message for a Kernel account (contents unreadable)');
});

test('Re-review: a grant made unreadable on purpose, a module\'s onInstall/onUninstall, uninstallModule, and rule values no word of its type has', async () => {
  // A sudo key for execute whose handler data points past its end: Kernel still installs it; here, danger.
  const w64 = (v: bigint) => v.toString(16).padStart(64, '0');
  const garbled = `0xe9ae5c53${'00'.repeat(40)}${w64(0x40n)}${w64(0xffffn)}${w64(1n)}ff${'00'.repeat(31)}` as Hex;
  const p = await sign(enable({ selectorData: garbled }));
  assert.equal(p.attention, 'danger');
  // Calls to a validator's onUninstall and onInstall: the account replaces its own owner's key.
  const ECDSA = '0x845adb2c711129d4f3966735ed98a9f09fc4ce57';
  const reinstall = await sign(callsOnly([{ target: ECDSA, selector: '0x8a91b0e3' }, { target: ECDSA, selector: '0x6d61fe70' }]));
  assert.equal(reinstall.attention, 'danger');
  assert.ok(reinstall.warnings.some(w => w.code === 'kernel_enable_takeover' && /onUninstall and onInstall replaces its key/.test(w.message)));
  // uninstallModule granted: a hook-type uninstall reaches the root validator's onUninstall.
  const uninstall = await sign(enable({ selectorData: '0xa71763a8' }));
  assert.equal(uninstall.attention, 'danger');
  // A rule value no bool or address is (the policy compares the whole word): shown as such, not as true or an address.
  const BAYC = '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d';
  const odd = await sign(callsOnly([{ target: BAYC, selector: '0xa22cb465', rules: [{ condition: 5, offset: 32n, params: [word(2n)] }] }]));
  assert.match(detail(odd, 'Allowed call 1') ?? '', /approved must not be 0x0{63}2 \(not a bool: neither true nor false matches it\)/);
});

/** A Kernel v3.1 account (an ERC-1967 proxy) whose root is ZeroDev's ECDSA validator. */
function kernelRpc(o: { code?: string; implementation?: string; owner?: string; currentNonce?: number; vIdNonce?: number; hook?: string; handler?: { hook: string; target: string; callType: Hex }; executorHook?: string } = {}): Dependencies['rpc'] {
  return {
    has: () => true,
    call: async (_chainId: number, method: string, params: unknown[]) => {
      if (method === 'eth_getCode') return o.code ?? '0x3d3d';
      if (method === 'eth_getStorageAt') return word(o.implementation ?? '0xbac849bb641841b44e965fb01a4bf5f074f84b4d');
      const { to, data } = params[0] as { to: string; data: string };
      const selector = data.slice(0, 10);
      if (selector === '0xf1f7f0f9') return `0x01${ECDSA_VALIDATOR.slice(2)}${'00'.repeat(11)}`; // rootValidator()
      if (selector === '0x20709efc' && to === ECDSA_VALIDATOR) return word(o.owner ?? ALICE); // ecdsaValidatorStorage(address)
      if (selector === '0xadb610a3') return word(BigInt(o.currentNonce ?? 1)); // currentNonce()
      if (selector === '0xb8afe17d') return `${word(BigInt(o.vIdNonce ?? 0))}${word(o.hook ?? zeroAddress).slice(2)}`; // validationConfig(bytes21)
      if (selector === '0x57b3a5f4' && o.handler) return encodeAbiParameters([{ type: 'tuple', components: [{ type: 'address' }, { type: 'address' }, { type: 'bytes1' }] }], [[o.handler.hook as Hex, o.handler.target as Hex, o.handler.callType]]); // selectorConfig(bytes4)
      if (selector === '0x721e67f4' && o.executorHook) return word(o.executorHook); // executorConfig(address)
      throw new Error(`unexpected ${method} ${selector}`);
    },
  };
}

test('With an RPC: the account\'s owner, whether it runs Kernel, and its validation nonce', async () => {
  const live = (o: Parameters<typeof kernelRpc>[0] = {}) => ({ ...deps, rpc: kernelRpc(o) });
  const ok = await sign(enable(), ALICE, live());
  assert.equal(detail(ok, 'Account runs'), 'Kernel v3.1');
  assert.equal(detail(ok, 'Account owner'), `${ALICE} (ZeroDev's ECDSA validator)`);
  assert.equal(detail(ok, 'Validation nonce'), "1 (the account's is 1)");
  assert.ok(!codes(ok).some(c => ['kernel_enable_not_owner', 'kernel_enable_not_kernel', 'kernel_enable_nonce'].includes(c)));
  // Someone else asked to sign; the account's nonce moved on; a contract that isn't Kernel; one not deployed yet.
  assert.ok(codes(await sign(enable(), BOB, live())).includes('kernel_enable_not_owner'));
  const moved = await sign(enable(), ALICE, live({ currentNonce: 3 }));
  assert.match(moved.warnings.find(w => w.code === 'kernel_enable_nonce')!.message, /the account's is already 3: Kernel won't accept it/);
  const other = await sign(enable(), ALICE, live({ implementation: BOB }));
  assert.match(other.warnings.find(w => w.code === 'kernel_enable_not_kernel')!.message, /doesn't run a Kernel v3 this previewer knows \(it runs 0xb0b0/);
  const fresh = await sign(enable(), ALICE, live({ code: '0x' }));
  assert.ok(fresh.decoding.notes.some(n => /has no code yet/.test(n)));
  // A domain version the account doesn't run.
  assert.ok(codes(await sign(enable({}, { version: '0.3.3' }), ALICE, live())).includes('kernel_enable_version_mismatch'));
  // Already installed at the account's nonce: Kernel v3.1 refuses it again; v3.3 takes it at the next nonce.
  const again = await sign(enable(), ALICE, live({ vIdNonce: 1, hook: '0x0000000000000000000000000000000000000001' }));
  assert.match(again.warnings.find(w => w.code === 'kernel_enable_nonce')!.message, /already installed at the account's validation nonce \(1\): Kernel v3\.1 won't install it again/);
  const v33 = await sign(enable({}, { version: '0.3.3' }), ALICE, live({ implementation: '0xd6cedde84be40893d153be9d467cd6ad37875b28', vIdNonce: 1, hook: '0x0000000000000000000000000000000000000001' }));
  assert.equal(detail(v33, 'Validation nonce'), "1 (the account's is 2)");
  assert.ok(v33.decoding.notes.some(n => /already installed on the account\. Kernel v3\.3 takes an Enable for it again, .* ZeroDev's validators, signers and policies \(all but its sudo policy\) refuse to be installed a second time/.test(n)));
});

// The review's inputs: grants that can take the account over must be danger, and no limit may be claimed that can't be read.
const RECOVERY = '0xe884c2868cc82c16177ec73a93f7d9e6f3a5dc6e', CALL_POLICY_1 = '0xe4fec84b7b002273ecc86baa65a831ddb92d30a8';
const callsOnly = (perms: Parameters<typeof callPolicy>[0], flag: Hex = '0x0002') => enable({ validatorData: permission(entry('0x0000', CALL_POLICY, callPolicy(perms)), ecdsaKey(flag)) });
/** selectorData installing `module` for `selector`: its hook, and its call type (0x00 call, 0xff delegatecall). */
const handler = (selector: Hex, module: string, hook: string = zeroAddress, callType: Hex = '0xff') => concatHex([selector, module as Hex, hook as Hex, encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes' }], [callType, '0x'])]);

test("A call permission for the account's own execute, or execute on any contract, is danger: the call policy checks only the outer call", async () => {
  const own = await sign(callsOnly([{ target: ACCOUNT, selector: '0xe9ae5c53' }]));
  assert.equal(own.title, 'Let session key 0x5e55…0001 act for your Kernel account: 1 allowed call');
  assert.equal(own.attention, 'danger');
  assert.match(own.warnings.find(w => w.code === 'kernel_enable_takeover')!.message, /^It may have your account call its own execute\(bytes32,bytes\), which runs any calls packed inside it: the call policy checks only that outer call, so it can send any transaction from your account\.$/);
  const any = await sign(callsOnly([{ target: zeroAddress, selector: '0xe9ae5c53' }]));
  assert.equal(any.attention, 'danger');
  assert.match(any.warnings.find(w => w.code === 'kernel_enable_takeover')!.message, /execute\(bytes32,bytes\) \(allowed on any contract, so on your account too\)/);
  assert.equal(detail(any, 'Allowed call 1'), "execute(bytes32,bytes) (Kernel's: run calls from your account) on any contract, any arguments; no ETH");
  assert.ok(!codes(any).includes('kernel_enable_any_contract'));
  const executor = await sign(callsOnly([{ target: ACCOUNT, selector: '0xd691c964' }]));
  assert.equal(executor.attention, 'danger');
  assert.match(executor.warnings.find(w => w.code === 'kernel_enable_takeover')!.message, /executeFromExecutor\(bytes32,bytes\) on itself, which runs the calls packed inside it for an executor/);
  assert.equal((await sign(callsOnly([{ target: zeroAddress, selector: '0xd691c964' }]))).attention, 'danger');
  // executeUserOp is the EntryPoint's alone: the account calling it fails, so as a call it hands nothing over.
  const userOp = await sign(callsOnly([{ target: ACCOUNT, selector: '0x8dd7712f' }]));
  assert.equal(userOp.attention, 'caution');
  assert.match(detail(userOp, 'Allowed call 1')!, /only the EntryPoint may call it, so a call from your account fails/);
});

test("The account's admin functions allowed on any contract (target 0) reach the account itself: danger", async () => {
  for (const [selector, sig] of [['0x9517e29f', 'installModule'], ['0x52141cd9', 'changeRootValidator'], ['0x3659cfe6', 'upgradeTo'], ['0xb9b82941', 'grantAccess'], ['0x9198bdf5', 'installValidations']] as const) {
    const p = await sign(callsOnly([{ target: zeroAddress, selector }]));
    assert.equal(p.attention, 'danger', sig);
    assert.match(p.warnings.find(w => w.code === 'kernel_enable_takeover')!.message, new RegExp(`^It may call your account's own ${sig}\\(.*\\) \\(allowed on any contract, so on your account too\\), which lets it .*: that hands over the account\\.$`), sig);
  }
});

test("selectorData executeUserOp grants every function of the account (it delegatecalls the account as the EntryPoint): danger", async () => {
  const p = await sign(enable({ selectorData: '0x8dd7712f' }));
  assert.equal(p.attention, 'danger');
  assert.equal(detail(p, 'Account function it may use'), "executeUserOp((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes),bytes32): run any of your account's own functions, its settings included");
  assert.match(p.warnings.find(w => w.code === 'kernel_enable_takeover')!.message, /^It may call your account's own executeUserOp\(.*\), which lets it run any of your account's own functions, its settings included: that hands over the account\.$/);
  assert.ok(!p.warnings.some(w => /nothing handles/.test(w.message)));
  // Even when its calls are otherwise limited.
  const limited = await sign(enable({ selectorData: '0x8dd7712f', validatorData: permission(entry('0x0000', CALL_POLICY, callPolicy([{ target: USDC, selector: '0xa9059cbb' }])), ecdsaKey('0x0002')) }));
  assert.equal(limited.attention, 'danger');
});

test('A handler anyone can call: a selector hook other than 0 (address 1 is none), or any handler on Kernel v3.0; the recovery action, danger', async () => {
  const fn = '0x12345678', module = '0x4a00000000000000000000000000000000000004';
  const open = await sign(enable({ selectorData: handler(fn, module, '0x0000000000000000000000000000000000000001') }));
  assert.equal(open.attention, 'danger');
  assert.match(open.warnings.find(w => w.code === 'kernel_enable_open_handler')!.message, /^The handler's hook is address 1, which is no hook: anyone, not only session key 0x5e55…0001, can call your account's 0x12345678 and run that code as your account\.$/);
  const hooked = await sign(enable({ selectorData: handler(fn, module, BOB) }));
  assert.match(hooked.warnings.find(w => w.code === 'kernel_enable_open_handler')!.message, /hook is 0xb0b0000000000000000000000000000000000002, which decides who may call: anyone that hook lets through/);
  // Hook 0 is "only the EntryPoint" from v3.1 on; v3.0 installs it with no hook.
  assert.ok(!codes(await sign(enable({ selectorData: handler(fn, module) }))).includes('kernel_enable_open_handler'));
  const v30 = await sign(enable({ selectorData: handler(fn, module) }, { version: '0.3.0-beta' }));
  assert.match(v30.warnings.find(w => w.code === 'kernel_enable_open_handler')!.message, /^Kernel v3\.0 installs a handler given no hook with none at all: anyone/);
  // ZeroDev's recovery action, by its code: it re-installs a validator with new data, so it replaces the owner.
  const recovery = await sign(enable({ validationId: `0x01${'ed89244160cfe273800b58b1b534031699dfeeee'}`, validatorData: encodeAbiParameters([{ type: 'address[]' }, { type: 'uint24[]' }, { type: 'uint24' }, { type: 'uint48' }], [[BOB], [1], 1, 0]), selectorData: handler('0xac39fd0f', RECOVERY, '0x0000000000000000000000000000000000000001') }));
  assert.equal(recovery.attention, 'danger');
  assert.deepEqual(codes(recovery).filter(c => c.endsWith('handler') || c === 'kernel_enable_recovery'), ['kernel_enable_recovery', 'kernel_enable_open_handler']);
  assert.match(detail(recovery, 'Installs a handler')!, /^ZeroDev's recovery action \(named in its SDK; its source isn't published: its code re-installs any validator of the account with new data\)/);
});

test('An unknown handler run by delegatecall, or by call (it may make itself an executor), is danger', async () => {
  const fn = '0x12345678', module = '0x4a00000000000000000000000000000000000004';
  const delegate = await sign(enable({ selectorData: handler(fn, module) }));
  assert.equal(delegate.attention, 'danger');
  assert.match(delegate.warnings.find(w => w.code === 'kernel_enable_delegatecall_handler')!.message, /^It installs 0x4a00000000000000000000000000000000000004 to handle your account's function 0x12345678 by delegatecall, as your account itself/);
  const call = await sign(enable({ selectorData: handler(fn, module, zeroAddress, '0x00') }));
  assert.equal(call.attention, 'danger');
  assert.match(call.warnings.find(w => w.code === 'kernel_enable_executor')!.message, /also makes it an executor of your account if it says it is one \(its own code answers\): an executor can run any call from the account, with no key/);
  assert.ok(codes(call).includes('kernel_enable_handler'));
  // Kernel's own function with a handler: the handler is never reached, but one installed by call may still be made an executor.
  const own = await sign(enable({ selectorData: handler('0xe9ae5c53', module, zeroAddress, '0x00') }));
  assert.match(detail(own, 'Installs a handler')!, /never reached: Kernel's own function answers that call/);
  assert.ok(codes(own).includes('kernel_enable_executor'));
});

test('An unknown policy or hook limits nothing this previewer can read: danger when it is all that stands before any transaction', async () => {
  const unknown = '0x9999999999999999999999999999999999999999';
  // A sudo policy and an unknown (perhaps no-op) one.
  const sudo = await sign(enable({ validatorData: permission(entry('0x0000', SUDO), entry('0x0000', unknown), ecdsaKey()) }));
  assert.equal(sudo.attention, 'danger');
  assert.match(sudo.warnings[0].message, new RegExp(`^Whoever holds session key 0x5e55…0001 can send any transaction from your account, unless the policy ${unknown}, which this previewer can't read, stops it`));
  assert.ok(!codes(sudo).includes('kernel_enable_grant'));
  // Two unknown policies and an unknown hook, with a time limit: still no limit on what it calls.
  const timed = await sign(enable({ hook: BOB, validatorData: permission(entry('0x0000', unknown), entry('0x0000', TIMESTAMP, encodeAbiParameters([{ type: 'uint48' }, { type: 'uint48' }], [0, 1_800_000_000])), entry('0x0000', '0x8888888888888888888888888888888888888888'), ecdsaKey()) }));
  assert.equal(timed.attention, 'danger');
  assert.match(timed.warnings[0].message, /until 2027-01-15T08:00:00Z, unless the policy 0x9999.* or the policy 0x8888.* or the hook 0xb0b0000000000000000000000000000000000002, which this previewer can't read, stops it/);
  // With a call policy, the calls it lists are the most it can make: caution, its calls shown.
  const limited = await sign(enable({ validatorData: permission(entry('0x0000', unknown), entry('0x0000', CALL_POLICY, callPolicy([{ target: USDC, selector: '0xa9059cbb' }])), ecdsaKey('0x0002')) }));
  assert.equal(limited.attention, 'caution');
  assert.equal(limited.title, 'Let session key 0x5e55…0001 act for your Kernel account: 1 allowed call');
  assert.ok(codes(limited).includes('kernel_enable_unknown_policy'));
  assert.equal(limited.decoding.status, 'partial');
  // A policy for signatures only doesn't touch its operations.
  assert.equal((await sign(enable({ validatorData: permission(entry('0x0000', SUDO), entry('0x0001', unknown), ecdsaKey()) }))).title, 'Let session key 0x5e55…0001 act for your Kernel account, without limits');
});

test("A function that isn't Kernel's own, with no handler in the message: whatever handler the account has runs (read with an RPC)", async () => {
  const doRecovery = { validationId: `0x01${ECDSA_VALIDATOR.slice(2)}`, validatorData: KEY, selectorData: '0xac39fd0f' };
  const offline = await sign(enable(doRecovery));
  // Unread, the account may have ZeroDev's recovery action as its handler for it (guardian recovery installs it).
  assert.equal(offline.attention, 'danger');
  assert.ok(offline.warnings.some(w => w.code === 'kernel_enable_recovery'));
  assert.equal(detail(offline, 'It can'), "call only your account's function doRecovery(address,bytes) (0xac39fd0f), which runs whatever handler your account has for it");
  assert.match(offline.warnings.find(w => w.code === 'kernel_enable_existing_handler')!.message, /whatever handler the account has installed for it, which this previewer couldn't read/);
  assert.ok(!JSON.stringify(offline).includes('nothing handles yet'));
  // The account already hands doRecovery to ZeroDev's recovery action (as on Base, 0x17f579f3390de3b59bac621ca4f6292b4c61e558).
  const live = (o: Parameters<typeof kernelRpc>[0]) => ({ ...deps, rpc: kernelRpc(o) });
  const recovery = await sign(enable(doRecovery), ALICE, live({ handler: { hook: '0xffffffffffffffffffffffffffffffffffffffff', target: RECOVERY, callType: '0xff' } }));
  assert.equal(recovery.attention, 'danger');
  assert.match(recovery.warnings.find(w => w.code === 'kernel_enable_recovery')!.message, /^It may call your account's doRecovery\(address,bytes\) \(0xac39fd0f\), which the account already hands to ZeroDev's recovery action by delegatecall, as your account itself: .* so it can replace your account's owner\.$/);
  assert.match(detail(recovery, 'Handler on the account')!, /^ZeroDev's recovery action .* for 0xac39fd0f, run by delegatecall, as your account itself$/);
  const other = await sign(enable(doRecovery), ALICE, live({ handler: { hook: '0x0000000000000000000000000000000000000001', target: BOB, callType: '0xff' } }));
  assert.ok(codes(other).includes('kernel_enable_delegatecall_handler'));
  const executor = await sign(enable(doRecovery), ALICE, live({ handler: { hook: '0x0000000000000000000000000000000000000001', target: BOB, callType: '0x00' }, executorHook: '0x0000000000000000000000000000000000000001' }));
  assert.ok(codes(executor).includes('kernel_enable_executor'));
  const none = await sign(enable(doRecovery), ALICE, live({ handler: { hook: zeroAddress, target: zeroAddress, callType: '0x00' } }));
  assert.equal(none.attention, 'caution');
  assert.equal(detail(none, 'It can'), "call only your account's function doRecovery(address,bytes) (0xac39fd0f), which nothing handles on the account now");
});

test('Long lists: token lookups and listed items are capped', async () => {
  let lookups = 0;
  const counting: Dependencies = { tokens: { get: () => { lookups++; return undefined; } } };
  const targets = Array.from({ length: 3000 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '7')}`);
  const many = await sign(callsOnly(targets.map(target => ({ target, selector: '0xa9059cbb' as Hex }))), ALICE, counting);
  assert.ok(lookups <= 24, String(lookups));
  assert.equal(detail(many, 'Allowed calls not listed'), '2976');
  const callers = Array.from({ length: 20_000 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '5')}` as Hex);
  const sigs = await sign(enable({ validatorData: permission(entry('0x0000', SUDO), entry('0x0000', '0xf6a936c88d97e6fad13b98d2fd731ff17eed591d', encodeAbiParameters([{ type: 'address[]' }], [callers])), ecdsaKey()) }));
  assert.match(detail(sigs, 'Signs as your account (ERC-1271)')!, /, and 19992 more check it$/);
  assert.ok(JSON.stringify(sigs).length < 20_000, String(JSON.stringify(sigs).length));
  const oneOf = await sign(callsOnly([{ target: USDC, selector: '0xa9059cbb', rules: [{ condition: 6, offset: 0n, params: callers.slice(0, 50).map(c => word(c)) }] }]));
  assert.match(detail(oneOf, 'Allowed call 1')!, /or one of 42 more; no ETH$/);
});

test('Call policy 0.0.1: target 0 is the zero address and selector 0 four zero bytes, not wildcards', async () => {
  const v1 = (perms: { target: string; selector: Hex; valueLimit?: bigint }[]) => enable({ validatorData: permission(entry('0x0000', CALL_POLICY_1, encodeAbiParameters([{ type: 'tuple[]', components: [{ name: 'callType', type: 'bytes1' }, { name: 'target', type: 'address' }, { name: 'selector', type: 'bytes4' }, { name: 'valueLimit', type: 'uint256' }, { name: 'rules', type: 'tuple[]', components: [{ name: 'condition', type: 'uint8' }, { name: 'offset', type: 'uint64' }, { name: 'param', type: 'bytes32' }] }] }], [perms.map(p => ({ callType: '0x00' as Hex, target: p.target as Hex, selector: p.selector, valueLimit: p.valueLimit ?? 0n, rules: [] }))])), ecdsaKey('0x0002')) });
  const p = await sign(v1([{ target: zeroAddress, selector: '0x9517e29f' }, { target: BOB, selector: '0x00000000', valueLimit: 10n ** 18n }]));
  assert.equal(p.attention, 'caution');
  assert.equal(detail(p, 'Allowed call 1'), 'function 0x9517e29f (unknown) on the zero address (call policy 0.0.1 has no "any contract"), any arguments; no ETH');
  assert.equal(detail(p, 'Allowed call 2'), `calls whose data starts 0x00000000 (call policy 0.0.1 refuses plain ETH transfers) on ${BOB}, any arguments; up to 1 ETH per call`);
  assert.ok(!codes(p).includes('kernel_enable_any_contract'));
});

test('Plain transfers to any address with a value limit: per call, any number of calls', async () => {
  const p = await sign(callsOnly([{ target: zeroAddress, selector: '0x00000000', valueLimit: 10n ** 17n }]));
  assert.equal(detail(p, 'Allowed call 1'), 'plain ETH transfers (no function) on any address, any arguments; up to 0.1 ETH per call');
  assert.match(p.warnings.find(w => w.code === 'kernel_enable_any_address_value')!.message, /^It may send up to 0\.1 ETH to any address in each call, with no limit on how many calls .*: all the ETH your account holds\.$/);
});

test('A signer flagged for neither operations nor signatures can do nothing', async () => {
  const p = await sign(enable({ validatorData: permission(entry('0x0000', SUDO), ecdsaKey('0x0003')) }));
  assert.equal(p.title, 'Install session key 0x5e55…0001 on your Kernel account, able to do nothing (no operations, no signatures)');
  assert.deepEqual(codes(p), ['kernel_enable_inert']);
  assert.equal(p.attention, 'info');
});

test("A rule past a function's arguments limits nothing: the function ignores trailing data", async () => {
  const p = await sign(callsOnly([{ target: USDC, selector: '0xa9059cbb', rules: [{ condition: 0, offset: 64n, params: [word(BOB)] }] }]));
  assert.match(detail(p, 'Allowed call 1')!, /: the word at byte 64, past its arguments \(it limits nothing\) must be 0xb0b0/);
  assert.match(p.warnings.find(w => w.code === 'kernel_enable_rule_ignored')!.message, /^A rule on transfer\(address,uint256\) checks the word at byte 64 of its arguments, past the 2 words it reads: .* it limits nothing\.$/);
  assert.ok(!codes(await sign(callsOnly([{ target: USDC, selector: '0xa9059cbb', rules: [{ condition: 0, offset: 0n, params: [word(BOB)] }] }]))).includes('kernel_enable_rule_ignored'));
});
