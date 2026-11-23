// Batches on a signature for an EIP-7702 account that runs Calibur, Uniswap's account code (CaliburEntry, source
// verified on Sourcify: 0x00000000…9b8f00 on Ethereum and BNB Chain, 0x00000000…37030e on Ethereum and Base). The
// account's owner, or a key registered on the account, signs
//   SignedBatchedCall(BatchedCall batchedCall,uint256 nonce,bytes32 keyHash,address executor,uint256 deadline)
//   BatchedCall(Call[] calls,bool revertOnFailure)
//   Call(address to,uint256 value,bytes data)
// under the domain EIP712Domain(string name,string version,uint256 chainId,address verifyingContract,bytes32 salt):
// "Calibur", "1.0.0", the account itself as the verifying contract, and a salt that is the account's code (its last
// 20 bytes, under a 12-byte prefix the account can raise to void its earlier signatures). Whoever submits it calls
// the account's execute(signedBatchedCall, wrappedSignature), and the account's code makes the calls as the account.
//
// What the code checks (Calibur.execute, _handleVerifySignature): the caller is the executor named, or anyone where
// none is (the zero address); the deadline hasn't passed (zero: never); the nonce is the next of its sequence (its
// high 192 bits name the sequence, its low 64 the place in it); the signature is the key's that keyHash names (zero:
// the account's own key). A call to the zero address is made to the account itself (ERC-7821). With revertOnFailure
// unset, calls that fail are skipped and the rest still run.
//
// Checked on mined executions on Ethereum and BNB Chain (2026-11-23): the signature each relayer submitted recovers
// to the account over the digest of this typed data (test/calibur.test.ts has one). Until then the signature was
// previewed as an unknown format, its calls lines of hex.
import { toFunctionSelector, type Hex } from 'viem';
import { formatTimestamp, PreviewBuilder, sameAddress, shortAddress } from '../format.ts';
import { chainName } from '../chains.ts';
import { normalizeTransaction, previewTransaction } from '../evm/transaction.ts';
import { caliburAdmin, CALIBUR_CODES } from '../evm/smart-account.ts';
import type { ApprovalChange, AssetChange, Preview } from '../types.ts';
import { FAILS, TX_DETAILS, TX_ONLY } from './delegation.ts';
import { big, domainChainId, str, type TypedAdapter } from './common.ts';

const SIGNED = 'BatchedCall batchedCall,uint256 nonce,bytes32 keyHash,address executor,uint256 deadline', BATCHED = 'Call[] calls,bool revertOnFailure', CALL = 'address to,uint256 value,bytes data';
const ADDRESS = /^0x[0-9a-fA-F]{40}$/, BYTES = /^0x([0-9a-fA-F]{2})*$/, WORD = /^0x[0-9a-fA-F]{64}$/, ZERO = /^0x0{40}$/;
/** How many calls are decoded and simulated (what a wallet_sendCalls request may hold); Calibur has no cap. */
const MAX_READ = 32;

export const caliburSignedBatchAdapter: TypedAdapter = async (data, env) => {
  const shape = (name: string) => data.types[name]?.map(f => `${f.type} ${f.name}`).join(',');
  if (data.primaryType !== 'SignedBatchedCall' || shape('SignedBatchedCall') !== SIGNED || shape('BatchedCall') !== BATCHED || shape('Call') !== CALL) return null;
  const m = data.message as Record<string, unknown>, batched = (m.batchedCall ?? {}) as Record<string, unknown>;
  const raw = Array.isArray(batched.calls) ? batched.calls as Record<string, unknown>[] : null;
  const calls = raw?.map(c => ({ to: str(c?.to).toLowerCase(), value: big(c?.value), data: (str(c?.data) || '0x') as Hex }));
  const nonce = big(m.nonce), deadline = big(m.deadline), keyHash = str(m.keyHash).toLowerCase(), executor = str(m.executor).toLowerCase(), account = str(data.domain.verifyingContract).toLowerCase();
  const strict = batched.revertOnFailure === true || batched.revertOnFailure === 'true';
  // (Anything that doesn't read is shown field by field, as any typed data is.)
  if (!calls || !calls.length || calls.some(c => !ADDRESS.test(c.to) || c.value === null || !BYTES.test(c.data))) return null;
  if (nonce === null || deadline === null || !WORD.test(keyHash) || !ADDRESS.test(executor) || !ADDRESS.test(account)) return null;
  if (typeof batched.revertOnFailure !== 'boolean' && batched.revertOnFailure !== 'true' && batched.revertOnFailure !== 'false') return null;
  const chainId = domainChainId(data) ?? env.context.chainId ?? null;
  const signer = env.signer?.toLowerCase() ?? null;
  const b = new PreviewBuilder();
  const salt = str(data.domain.salt).toLowerCase(), code = WORD.test(salt) ? `0x${salt.slice(26)}` : null;
  const known = code ? CALIBUR_CODES[code] : undefined, root = /^0x0{64}$/.test(keyHash), anyone = ZERO.test(executor);
  const mine = !!signer && sameAddress(signer, account);
  b.detail('Kind', `calls ${anyone ? 'anyone holding this signature can have' : 'a named executor can have'} ${mine || !signer ? 'your account' : shortAddress(account)} make (a signed batch)`);
  b.detail('Account', account, account);
  if (code) b.detail('Account code', known ? `${known} (${code})` : code, code);
  b.detail('Submitted by', anyone ? 'anyone who holds the signature' : executor, executor);
  b.detail('Signed as', root ? "the account's own key" : `a key registered on the account (${keyHash.slice(0, 10)}…${keyHash.slice(-4)})`, keyHash);
  const never = deadline === 0n, now = BigInt(Math.floor(env.now / 1000));
  const until = never ? 'with no expiry' : `until ${formatTimestamp(Number(deadline) * 1000)}`;
  b.detail('Valid until', never ? 'no expiry' : deadline < 1n << 47n ? formatTimestamp(Number(deadline) * 1000) : 'a time that will not come', deadline.toString());
  const sequenceOf = nonce >> 64n;
  b.detail('Nonce', `${nonce & ((1n << 64n) - 1n)} in sequence ${sequenceOf > 0xffffffffn ? `0x${sequenceOf.toString(16)}` : sequenceOf}`, nonce.toString());

  // The format: Calibur's domain, and Calibur's code named in its salt. Anything else is another contract's, shaped
  // like it: what takes the signature, and what it does with it, isn't known.
  const named = str(data.domain.name) === 'Calibur' && str(data.domain.version) === '1.0.0';
  const others = (data.types.EIP712Domain?.map(f => f.name) ?? Object.keys(data.domain)).filter(k => !['name', 'version', 'chainId', 'verifyingContract', 'salt'].includes(k));
  // (Its domain type exactly, where one is given: the five fields, of these types, in this order.)
  const domainType = shape('EIP712Domain'), misshapen = domainType !== undefined && domainType !== 'string name,string version,uint256 chainId,address verifyingContract,bytes32 salt';
  if (!named || !code || others.length || misshapen) b.warn('caution', 'calibur_domain', `It is signed under ${!code ? 'a domain with no salt' : others.length ? `a domain that also has ${others.map(o => `"${o}"`).join(', ')}` : misshapen ? `a domain whose fields aren't Calibur's (${domainType})` : `the name "${str(data.domain.name)}" (version "${str(data.domain.version)}")`}: Calibur checks signatures under "Calibur", version "1.0.0", the chain, the account and a salt that names its code, so an account that runs it doesn't take this one. What else would take it isn't known.`);
  else if (!known) b.warn('caution', 'calibur_unknown_code', `Its salt names ${shortAddress(code)} as the account's code, which isn't a Calibur this format was read from: the request is shaped like Calibur's signed batches, but what code takes this signature, and what it does with it, isn't known.`);
  if (never) b.warn('caution', 'calibur_no_deadline', `It has no deadline: ${anyone ? 'whoever holds it' : shortAddress(executor)} can submit it at any time, until its nonce is used or you invalidate it.`);
  else if (deadline < now) b.warn('info', 'calibur_expired', 'Its deadline has passed: Calibur refuses it.');
  if (signer && !mine && root) b.warn('caution', 'calibur_other_account', `It is a batch for ${shortAddress(account)}, signed as that account's own key, but ${shortAddress(signer)} is asked to sign it: the account takes only its own key's signature for it.`);
  else if (signer && !mine) b.warn('caution', 'calibur_other_account', `It is a batch for ${shortAddress(account)}, not for ${shortAddress(signer)}, who is asked to sign it as a key registered on that account: its calls run as ${shortAddress(account)}.`);
  if (chainId !== null && env.context.chainId && chainId !== env.context.chainId) b.warn('caution', 'chain_mismatch', `The signature is for ${chainName(chainId)}, but the wallet is on ${chainName(env.context.chainId)}.`);
  const network = chainId !== null ? { kind: 'evm' as const, chainId, name: chainName(chainId) } : null;
  const n = calls.length, what = n === 1 ? 'call' : 'calls';
  const who = mine || !signer ? 'your account' : shortAddress(account);
  // A call as signed, where it isn't decoded: its selector, target and coin, and (with `whole`) its calldata.
  const asSigned = (i: number, whole: boolean) => {
    const c = calls[i];
    b.detail(`Call ${i + 1}`, `${c.data.length >= 10 ? c.data.slice(0, 10) : 'no calldata'} on ${ZERO.test(c.to) ? `the account itself (the zero address)` : c.to}${c.value ? `, sending ${c.value} wei` : ''}`, c.to);
    if (whole && c.data.length > 10) b.detail(`Call ${i + 1} calldata`, c.data.length > 4098 ? `${c.data.slice(0, 4098)}… (${(c.data.length - 2) / 2} bytes in all)` : c.data);
  };
  const said = `A signed batch (${known ?? "an account code this previewer doesn't know"}): ${anyone ? 'whoever holds the signature' : `the executor ${shortAddress(executor)}`} may have ${who} make ${n === 1 ? 'this call' : `these ${n} calls`}, once${strict ? ', all or nothing' : ', each on its own (one that fails is skipped)'}.`;
  if (chainId === null) {
    b.warn('caution', 'calibur_unread', `Which chain it is for isn't part of what is signed, nor known to the wallet: its ${what} can't be read for a chain.`);
    for (let i = 0; i < Math.min(n, MAX_READ); i++) asSigned(i, true);
    if (n > MAX_READ) { b.detail('More calls', String(n - MAX_READ)); b.warn('danger', 'calibur_too_many', `It lists ${n} calls, and ${n - MAX_READ} of them aren't shown here. Each runs as the account and can move anything it holds.`); }
    return { title: `Let ${anyone ? 'anyone' : shortAddress(executor)} have ${who} make ${n === 1 ? 'a call' : `${n} calls`}`, summary: said, decoder: 'calibur_signed_batch', status: 'partial', b, network };
  }

  // What the chain says: the account runs that code, and the nonce is the next of its sequence.
  const rpc = env.deps.rpc;
  let spent = false;
  if (rpc?.has(chainId)) {
    try {
      const own = String(await rpc.call(chainId, 'eth_getCode', [account, 'latest'])).toLowerCase();
      const runs = own.startsWith('0xef0100') ? `0x${own.slice(8)}` : null;
      if (own === '0x') b.warn('caution', 'calibur_no_code', `${mine || !signer ? 'Your account' : shortAddress(account)} runs no code now, so nothing takes this signature yet. It takes effect once the account is delegated to ${code ? shortAddress(code) : 'Calibur'} (EIP-7702): an authorization signed for that can be submitted with it, or after it${never ? '' : `, until the deadline`}.`);
      else if (code && runs !== code) b.warn('caution', 'calibur_other_code', `${mine || !signer ? 'Your account' : shortAddress(account)} runs ${runs ? `other code (${shortAddress(runs)})` : 'code of its own'} now, not ${known ?? shortAddress(code)}: this signature is for the latter, and does nothing unless the account is delegated to it${never ? '' : ' before the deadline'}.`);
      else if (known) {
        const sequence = (nonce >> 64n).toString(16).padStart(64, '0'), place = nonce & ((1n << 64n) - 1n);
        const next = await rpc.call(chainId, 'eth_call', [{ to: account, data: `${toFunctionSelector('getSeq(uint256)')}${sequence}` }, 'latest']).then(r => (/^0x[0-9a-f]{64}$/i.test(String(r)) ? BigInt(String(r)) : undefined), () => undefined);
        if (next !== undefined && place < next) { spent = true; b.warn('info', 'calibur_nonce_used', `This nonce is already used, or invalidated, on the account (its sequence is at ${next}): the batch can't run.`); }
        else if (next !== undefined && place > next) b.warn('info', 'calibur_nonce_ahead', `This nonce isn't the account's next (its sequence is at ${next}, this is ${place}): the batch can't run until the ${place - next === 1n ? 'one before it is' : `${place - next} before it are`} used.`);
      }
    } catch { b.note("Whether the account runs this code and the nonce is its next wasn't read."); }
  } else b.note("Whether the account runs this code and the nonce is its next wasn't checked (no RPC for this chain).");

  // Calls back into the account (to itself, or to the zero address, which Calibur takes to mean itself): what each
  // changes in the account, its keys above all. A key that isn't an admin can't make them: Calibur refuses.
  const admin = calls.map((c, i) => ((sameAddress(c.to, account) || ZERO.test(c.to)) && c.data.length >= 10 ? { i, title: caliburAdmin(c.data, b, n === 1 ? 'This ' : `Call ${i + 1}: `, chainId) } : null)).filter((x): x is { i: number; title: string | null } => !!x);
  for (const a of admin) if (!a.title) b.warn('caution', 'calibur_self_call', `${n === 1 ? 'The call is' : `Call ${a.i + 1} is`} one back into the account itself (${calls[a.i].data.slice(0, 10)}) that isn't read: the account's own code runs it with the account's own authority.`);

  // The calls, as the account's own: decoded so, and simulated as the account makes them, in order. A past block
  // named for the preview isn't used: a signature is previewed on the latest state.
  let assetChanges: AssetChange[] | undefined, approvals: ApprovalChange[] | undefined;
  let title = `Let ${anyone ? 'anyone' : shortAddress(executor)} have ${who} make ${n === 1 ? 'a call' : `${n} calls`}`, status: 'full' | 'partial' | 'opaque' = 'partial', also = '';
  if (n > MAX_READ) {
    // More calls than are read: none is decoded or simulated, which is said.
    for (let i = 0; i < MAX_READ; i++) asSigned(i, false);
    b.detail('More calls', String(n - MAX_READ));
    b.warn('danger', 'calibur_too_many', `It lists ${n} calls, more than the ${MAX_READ} that are read here: none is decoded or simulated, and ${n - MAX_READ} aren't shown at all. Each runs as the account and can move anything it holds.`);
    status = 'opaque';
  } else try {
    const context = { ...env.context, chainId, account: undefined, block: undefined, pinned: undefined, replay: undefined };
    const target = (to: string) => (ZERO.test(to) ? account : to);
    const p: Preview = n === 1
      ? await previewTransaction(normalizeTransaction({ from: account, to: target(calls[0].to), value: `0x${calls[0].value!.toString(16)}`, data: calls[0].data }, context, account, chainId), env.deps, context, 'eth_sendTransaction')
      : await (await import('../preview.ts')).previewBatch({ chainId: `0x${chainId.toString(16)}`, from: account, atomicRequired: strict, calls: calls.map(c => ({ to: target(c.to), value: `0x${c.value!.toString(16)}`, data: c.data })) }, context, env.deps);
    for (const d of p.details) if (!TX_DETAILS.test(d.label)) b.detail(d.label, d.value, d.raw);
    if (n > 1) for (const [i, c] of (p.calls ?? []).entries()) {
      const own = admin.find(a => a.i === i)?.title;
      b.detail(`Call ${i + 1}`, `${own ?? c.title} (${ZERO.test(calls[i].to) ? 'the account itself' : shortAddress(calls[i].to)})`, target(calls[i].to));
      if (!own) for (const d of c.details) if (!TX_DETAILS.test(d.label)) b.detail(`Call ${i + 1}: ${d.label}`, d.value, d.raw);
    }
    // A call that fails now: with revertOnFailure the batch reverts and the signature stays usable; without, the
    // call is skipped, the nonce is used, and the rest run.
    const failing = [p, ...(p.calls ?? [])].find(c => c.simulation?.status === 'reverted' || c.warnings.some(w => w.code === 'simulation_reverted'));
    const reason = failing?.simulation?.revertReason;
    if (failing && !spent) b.warn('caution', 'calibur_batch_fails', strict
      ? `The ${what} would fail if ${n === 1 ? 'it was' : 'they were'} submitted now${reason ? ` (${reason})` : ''}: nothing would move now. But the signature stays valid ${until}, until it is used: it can be submitted once the ${what} would succeed. What ${n === 1 ? 'it moves' : 'they move'} then is what the ${what} say${n === 1 ? 's' : ''}, not what is simulated here.`
      : `${n === 1 ? 'The call' : 'One of the calls'} would fail if submitted now${reason ? ` (${reason})` : ''}: a call that fails is skipped, and the rest still run. What is shown is of the calls that go through now.`);
    for (const w of p.warnings) if (!TX_ONLY.has(w.code) && !FAILS.has(w.code) && !(admin.length && w.code === 'unknown_function')) b.warn(w.severity, w.code, w.message);
    if (p.simulation?.status === 'success') b.note(`Simulated as the account making the ${what}${n === 1 ? '' : ' in order'}, on the current state: its code makes ${n === 1 ? 'it' : 'each'} as the account, whoever submits the batch.`);
    for (const note of p.decoding.notes) b.note(note);
    if (p.trace && !b.trace) b.trace = p.trace;
    assetChanges = p.assetChanges;
    approvals = failing ? undefined : p.approvals;
    status = known && named && !others.length && !misshapen && !admin.some(a => !a.title) ? (admin.length && p.decoding.status !== 'full' && admin.length === n ? 'full' : p.decoding.status) : 'partial';
    const head = n === 1 && admin[0]?.title ? admin[0].title : p.title.replace(/^(Send|Sign|Submit) (a )?transaction: /i, '').replace(/^\d+ actions: /, '');
    title = `Signed ${what} as ${mine || !signer ? 'you' : shortAddress(account)}: ${head}`;
    also = p.summary;
  } catch {
    b.warn('caution', 'calibur_unread', `The ${what} couldn't be decoded here: ${n === 1 ? 'it is' : 'they are'} shown as signed.`);
    for (let i = 0; i < n; i++) asSigned(i, true);
  }
  if (!strict && n > 1) b.note('The batch doesn\'t revert on failure: a call that fails is skipped, and the others still take effect.');
  b.note(`An off-chain signature: it costs nothing now. ${anyone ? 'Anyone who holds it' : `The executor ${shortAddress(executor)}, and no one else,`} can submit it${never ? '' : ` until ${formatTimestamp(Number(deadline) * 1000)}`}, once: the ${what} then run${n === 1 ? 's' : ''} as the account, as if it had sent ${n === 1 ? 'it' : 'them'}. Until then the account can void it by invalidating its nonce.`);
  return { title, summary: `${said}${also ? ` ${also}` : ''}`, decoder: 'calibur_signed_batch', status, b, network, ...(assetChanges && { assetChanges }), ...(approvals?.length && { approvals }) };
};
