// Sessions signed for an EIP-7702 account running WalletCore (src/typed-data/wallet-core-session.ts): an executor
// allowed to make any calls as the account until the session ends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previewRequest } from '../src/preview.ts';
import { StaticTokenRegistry } from '../src/chains.ts';
import type { Dependencies } from '../src/types.ts';
import { codes, detail } from './helpers.ts';

// A live account on Ethereum that runs WalletCore, and its code.
const ACCOUNT = '0x3dec60a91b258ea7a1a4e40384866a4f04c8bd48', WALLET = '0x69e6bd1c4082403fc7917a61f6216552fc1a541d', STORAGE = '0x4834b21a2fe9647c99e46316998128ff1e00b00e';
const EXECUTOR = '0x00000000000000000000000000000000000000e1', SELF = '0x0000000000000000000000000000000000000001', HOOK = '0x00000000000000000000000000000000000000aa';
const UNTIL = 1_800_000_000; // 2027-01-15 08:00:00 UTC
const NOW = (UNTIL - 86400) * 1000;
const typed = (m: Record<string, unknown> = {}, domain: Record<string, unknown> = {}) => ({
  domain: { name: 'wallet-core', version: '1.0.0', chainId: 1, verifyingContract: ACCOUNT, ...domain },
  types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
    Session: [{ name: 'wallet', type: 'address' }, { name: 'id', type: 'uint256' }, { name: 'executor', type: 'address' }, { name: 'validator', type: 'address' }, { name: 'validUntil', type: 'uint256' }, { name: 'validAfter', type: 'uint256' }, { name: 'preHook', type: 'bytes' }, { name: 'postHook', type: 'bytes' }] },
  primaryType: 'Session',
  message: { wallet: WALLET, id: '7', executor: EXECUTOR, validator: SELF, validUntil: String(UNTIL), validAfter: '0', preHook: '0x', postHook: '0x1234', ...m },
});
const offline: Dependencies = { tokens: new StaticTokenRegistry() };
const sign = (t: ReturnType<typeof typed>, d = offline, context: Record<string, unknown> = {}, signer = ACCOUNT) => previewRequest({ method: 'eth_signTypedData_v4', params: [signer, JSON.stringify(t)] }, { now: NOW, ...context }, d);

test('A WalletCore session with no hook is the account’s key lent to its executor, and says so', async () => {
  // It was "Sign Session", a format not interpreted.
  const p = await sign(typed());
  assert.equal(p.decoding.decoder, 'wallet_core_session');
  assert.equal(p.title, 'Let 0x0000…00e1 act as your account until 2027-01-15T08:00:00Z');
  const danger = p.warnings.find(w => w.code === 'session_unrestricted')!;
  assert.equal(danger.severity, 'danger');
  assert.match(danger.message, /^This lets 0x0000…00e1 make any calls as your account, from now until 2027-01-15T08:00:00Z, with nothing checking what they are: it can move every token and coin in the account and approve anything\./);
  assert.equal(p.attention, 'danger');
  assert.equal(detail(p, 'Executor'), EXECUTOR);
  assert.equal(detail(p, 'Account code'), `WalletCore (${WALLET})`);
  assert.equal(detail(p, 'Signature checked by'), "the account's own key");
  // The digest is the account's own: on Ethereum, the live account's getSessionTypedHash for this session returned
  // it (2026-11-23), and BNB Chain's WalletCore agreed for an account there. (Two bytes of postHook are no hook:
  // the account reads one from twenty.)
  assert.equal(detail(p, 'EIP-712 digest'), '0xb9ed8ab4ba63f4b0457d5bf4c8e118139f1dca47a765adbb55786ad44ee65e5a');
  assert.ok(!codes(p).includes('unknown_typed_data'));
  assert.match(p.decoding.notes.join(' '), /The account can end it sooner by revoking the session's id \(7\)/);
});

test('A WalletCore session’s hooks, validator, times, code and account are each said for what they are', async () => {
  // A hook bounds the calls, by a contract this doesn't read: a caution, and not a full reading.
  const hooked = await sign(typed({ preHook: `${HOOK}beef` }));
  assert.match(hooked.warnings.find(w => w.code === 'session_hooked')?.message ?? '', /any calls that 0x0000…00aa lets through \(a contract called before them\)\. What it allows isn't read here\./);
  assert.ok(!codes(hooked).includes('session_unrestricted'));
  assert.deepEqual([hooked.decoding.status, detail(hooked, 'Checked before its calls by')], ['partial', HOOK]);
  // A validator contract checks the signature in place of the account's key.
  assert.equal((await sign(typed({ validator: HOOK }))).warnings.find(w => w.code === 'session_validator')?.severity, 'caution');
  // Times: past its end; no end that will come; longer than a month.
  assert.ok(codes(await sign(typed(), offline, { now: (UNTIL + 1) * 1000 })).includes('session_expired'));
  const forever = await sign(typed({ validUntil: (2n ** 255n).toString() }));
  assert.ok(codes(forever).includes('session_no_end'));
  assert.equal(forever.title, 'Let 0x0000…00e1 act as your account with no end');
  assert.match((await sign(typed(), offline, { now: (UNTIL - 90 * 86400) * 1000 })).warnings.find(w => w.code === 'session_long')?.message ?? '', /^It runs for 90 days\.$/);
  // Another name or version, which WalletCore refuses; another code than the WalletCore of the chain; another signer.
  assert.match((await sign(typed({}, { version: '2' }))).warnings.find(w => w.code === 'session_domain')?.message ?? '', /WalletCore checks sessions under "wallet-core", version "1\.0\.0"/);
  const elsewhere = await sign(typed({ wallet: HOOK }));
  assert.match(elsewhere.warnings.find(w => w.code === 'session_unknown_code')?.message ?? '', /isn't a WalletCore this format was read from \(on Ethereum that is 0x69e6…541d\)/);
  assert.equal(elsewhere.decoding.status, 'partial');
  assert.ok(!codes(await sign(typed({ wallet: '0x64fc23203fcc4bcf09fc4b30669131333ba7936b' }, { chainId: 56 }))).includes('session_unknown_code'));
  const other = await sign(typed(), offline, {}, EXECUTOR);
  assert.match(other.warnings.find(w => w.code === 'session_other_account')?.message ?? '', /It is a session for 0x3dec…bd48, but 0x0000…00e1 is asked to sign it/);
  assert.equal(other.title, 'Let 0x0000…00e1 act as 0x3dec…bd48 until 2027-01-15T08:00:00Z');
  // Another shape under the same name is any typed data.
  const odd = typed();
  odd.types.Session = odd.types.Session.slice(1);
  assert.equal((await sign(odd)).decoding.decoder, 'eip712_generic');
});

test('A WalletCore session against the chain: the account’s code, and an id the account refuses', async () => {
  const env = (o: { code?: string; refused?: boolean } = {}): Dependencies => ({ ...offline, rpc: { has: () => true, call: async (_c: number, m: string, p: unknown[]) => {
    if (m === 'eth_getCode') return o.code ?? `0xef0100${WALLET.slice(2)}`;
    const { to, data } = p[0] as { to: string; data: string };
    if (to === ACCOUNT && data === '0x076cd7b0') return `0x${STORAGE.slice(2).padStart(64, '0')}`; // getMainStorage()
    if (to === STORAGE) { if (o.refused) throw Object.assign(new Error('execution reverted'), { rpcError: { code: 3, message: 'execution reverted' } }); return '0x'; }
    return '0x';
  } } });
  const standing = await sign(typed(), env());
  assert.ok(!codes(standing).some(c => ['session_no_code', 'session_other_code', 'session_refused'].includes(c)), codes(standing).join());
  assert.match((await sign(typed(), env({ refused: true }))).warnings.find(w => w.code === 'session_refused')?.message ?? '', /its id \(7\) is revoked, or the validator isn't one the account has added/);
  assert.match((await sign(typed(), env({ code: '0x' }))).warnings.find(w => w.code === 'session_no_code')?.message ?? '', /runs no code now, so nothing takes this session yet/);
  assert.match((await sign(typed(), env({ code: `0xef0100${'22'.repeat(20)}` }))).warnings.find(w => w.code === 'session_other_code')?.message ?? '', /runs other code \(0x2222…2222\) now, not 0x69e6…541d/);
});
