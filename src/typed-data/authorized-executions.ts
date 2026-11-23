// Gasless executions for an EIP-7702 account that runs UniversalGaslessDelegate (source verified on Sourcify; the
// same address, 0x0000fb77…b16b, on the chains it is on). The account's owner signs
//   AuthorizedExecutions(Execution[] calls,uint256 deadline,bytes32 mode,uint256 nonce,address relayer)
//   Execution(address target,uint256 value,bytes data)
// under the domain EIP712Domain(uint256 chainId,address verifyingContract), the verifying contract being the delegate
// itself (not the account: what binds the signature to an account is that it must recover to it). The relayer named
// then calls the account's execute(mode, abi.encode(calls, opData)), opData being the nonce, the deadline and the
// signature, and the account's code makes the calls as the account. On Ethereum about one transaction in 350 was one
// of these (2026-11-23), most of them a transfer of USDC: until then the signature was previewed as an unknown
// format, its call a line of hex.
//
// What the delegate checks (UniversalGaslessDelegate.execute): the mode is one of its two with authorization, a
// single call (0x00…78210001, exactly one call) or a batch (0x01…78210001); the nonce is unused (any number, each
// once: a bitmap); the deadline hasn't passed; the caller is the relayer signed for; the signature recovers to the
// account. A call that fails reverts the execution, and the nonce stays unused.
import { toFunctionSelector, type Hex } from 'viem';
import { formatTimestamp, PreviewBuilder, sameAddress, shortAddress } from '../format.ts';
import { chainName } from '../chains.ts';
import { normalizeTransaction, previewTransaction } from '../evm/transaction.ts';
import type { ApprovalChange, AssetChange, Preview } from '../types.ts';
import { FAILS, TX_DETAILS, TX_ONLY } from './delegation.ts';
import { big, domainChainId, str, type TypedAdapter } from './common.ts';

/** The delegates whose source this format was read from. */
const DELEGATES: Record<string, string> = { '0x0000fb7702036ff9f76044a501ac1aa74cbab16b': 'UniversalGaslessDelegate' };
const FIELDS = 'Execution[] calls,uint256 deadline,bytes32 mode,uint256 nonce,address relayer', EXECUTION = 'address target,uint256 value,bytes data';
/** The first ten bytes of the delegate's two modes with authorization: call type, exec type, four unused, the selector 0x78210001. */
const SINGLE = '0x00000000000078210001', BATCH = '0x01000000000078210001';
const ADDRESS = /^0x[0-9a-fA-F]{40}$/, BYTES = /^0x([0-9a-fA-F]{2})*$/;
/** The one call to the account itself the delegate lets an execution make (_call: any other reverts, ReentrantCall). */
const INVALIDATE_NONCE = toFunctionSelector('invalidateNonce(uint256)');
/** How many calls are decoded and simulated (what a wallet_sendCalls request may hold); the delegate has no cap. */
const MAX_READ = 32;
type Signed = { target: string; value: bigint | null; data: Hex };
/** A call as signed, where it isn't decoded: its selector, target and coin, and (with `whole`) its calldata. */
const asSigned = (b: PreviewBuilder, i: number, c: Signed, whole: boolean) => {
  b.detail(`Call ${i + 1}`, `${c.data.length >= 10 ? c.data.slice(0, 10) : 'no calldata'} on ${c.target}${c.value ? `, sending ${c.value} wei` : ''}`, c.target);
  if (whole && c.data.length > 10) b.detail(`Call ${i + 1} calldata`, c.data.length > 4098 ? `${c.data.slice(0, 4098)}… (${(c.data.length - 2) / 2} bytes in all)` : c.data);
};

export const authorizedExecutionsAdapter: TypedAdapter = async (data, env) => {
  const shape = (name: string) => data.types[name]?.map(f => `${f.type} ${f.name}`).join(',');
  if (data.primaryType !== 'AuthorizedExecutions' || shape('AuthorizedExecutions') !== FIELDS || shape('Execution') !== EXECUTION) return null;
  const m = data.message as Record<string, unknown>;
  const raw = Array.isArray(m.calls) ? m.calls as Record<string, unknown>[] : null;
  const calls = raw?.map(c => ({ target: str(c?.target), value: big(c?.value), data: (str(c?.data) || '0x') as Hex }));
  const deadline = big(m.deadline), nonce = big(m.nonce), mode = str(m.mode).toLowerCase(), relayer = str(m.relayer), code = str(data.domain.verifyingContract).toLowerCase();
  // (Anything that doesn't read is shown field by field, as any typed data is.)
  if (!calls || !calls.length || calls.some(c => !ADDRESS.test(c.target) || c.value === null || !BYTES.test(c.data))) return null;
  if (deadline === null || nonce === null || !/^0x[0-9a-f]{64}$/.test(mode) || !ADDRESS.test(relayer) || !ADDRESS.test(code)) return null;
  const chainId = domainChainId(data) ?? env.context.chainId ?? null;
  const account = env.signer?.toLowerCase() ?? null;
  const b = new PreviewBuilder();
  const known = DELEGATES[code];
  b.detail('Kind', 'calls a relayer makes as your account, on your signature (a gasless execution)');
  b.detail('Account code', known ? `${known} (${code})` : code, code);
  b.detail('Relayer', relayer, relayer);
  if (!known) b.warn('caution', 'gasless_exec_unknown_code', `${shortAddress(code)} isn't the account code this format was read from (UniversalGaslessDelegate): the request is shaped like its executions, but what code takes this signature, and what it does with it, isn't known.`);
  // (What is said to be refused is what UniversalGaslessDelegate refuses: of other code, nothing is known.)
  const taker = known ? 'the account code' : 'UniversalGaslessDelegate, whose format this is,';
  // Its digest is under the chain and the account code alone (EIP712Domain(uint256 chainId,address verifyingContract)):
  // a domain with a name or a version has another, which it takes no signature over.
  // (Exactly: those two fields, of those types, in that order. A domain type with one of them, or with them the other
  // way round, has another digest as surely as one with a name in it.)
  const domainType = shape('EIP712Domain');
  const fields = data.types.EIP712Domain?.map(f => f.name) ?? Object.keys(data.domain);
  const others = fields.filter(k => k !== 'chainId' && k !== 'verifyingContract');
  const misshapen = !others.length && (domainType !== undefined ? domainType !== 'uint256 chainId,address verifyingContract' : fields.length !== 2);
  if (others.length) b.warn('caution', 'gasless_exec_domain', `It is signed under a domain that also has ${others.map(o => `"${o}"`).join(', ')}: UniversalGaslessDelegate checks signatures under the chain and the account code alone, so it doesn't take this one. What else would take it isn't known.`);
  else if (misshapen) b.warn('caution', 'gasless_exec_domain', `It is signed under a domain that isn't the delegate's (${domainType ?? (fields.join(', ') || 'no fields')}): UniversalGaslessDelegate checks signatures under the chain and the account code, in that order, so it doesn't take this one. What else would take it isn't known.`);
  // The mode decides how the calls are read back: one call, or a batch. Any other the delegate refuses.
  const kind = mode.startsWith(SINGLE) ? 'single' : mode.startsWith(BATCH) ? 'batch' : null;
  if (!kind) b.warn('info', 'gasless_exec_mode', `Its mode (${mode.slice(0, 22)}…) isn't one ${taker} runs on a signature (a single call, 0x00…78210001, or a batch, 0x01…78210001): it refuses the execution.`);
  else if (kind === 'single' && calls.length !== 1) b.warn('info', 'gasless_exec_mode', `Its mode is for a single call, and it lists ${calls.length}: ${taker} reads one call from an execution in that mode, so this signature matches none.`);
  const now = BigInt(Math.floor(env.now / 1000));
  const expires = deadline < 1n << 47n;
  b.detail('Valid until', expires ? formatTimestamp(Number(deadline) * 1000) : 'no expiry', deadline.toString());
  if (expires && deadline < now) b.warn('info', 'gasless_exec_expired', `Its deadline has passed: ${taker} refuses it.`);
  b.detail('Nonce', nonce.toString());
  if (chainId !== null && env.context.chainId && chainId !== env.context.chainId) b.warn('caution', 'chain_mismatch', `The signature is for ${chainName(chainId)}, but the wallet is on ${chainName(env.context.chainId)}.`);
  const network = chainId !== null ? { kind: 'evm' as const, chainId, name: chainName(chainId) } : null;
  const n = calls.length, what = n === 1 ? 'call' : 'calls';
  if (chainId === null || !account) {
    b.warn('caution', 'gasless_exec_unread', `${chainId === null ? "Which chain it is for isn't part of what is signed, nor known to the wallet" : "Which account signs isn't known"}: its ${what} can't be read for ${chainId === null ? 'a chain' : 'an account'}.`);
    // (As signed, calldata and all: shown field by field, as any typed data is, they had it.)
    for (const [i, c] of calls.slice(0, MAX_READ).entries()) asSigned(b, i, c, true);
    if (n > MAX_READ) { b.detail('More calls', String(n - MAX_READ)); b.warn('danger', 'gasless_exec_too_many', `It lists ${n} calls, and ${n - MAX_READ} of them aren't shown here. Each runs as the account that signs and can move anything it holds.`); }
    return { title: `Let ${shortAddress(relayer)} make ${n === 1 ? 'a call' : `${n} calls`} as your account`, summary: `A signed gasless execution: the relayer ${shortAddress(relayer)} may make ${n === 1 ? 'the call' : `the ${n} calls`} it lists as the account that signs.`, decoder: 'authorized_executions', status: 'partial', b, network };
  }

  // What the chain says: the account runs that code, and the nonce is unused.
  const rpc = env.deps.rpc;
  let spent = false;
  if (rpc?.has(chainId)) {
    try {
      const own = String(await rpc.call(chainId, 'eth_getCode', [account, 'latest'])).toLowerCase();
      const runs = own.startsWith('0xef0100') ? `0x${own.slice(8)}` : null;
      if (own === '0x') b.warn('caution', 'gasless_exec_no_code', `Your account runs no code now, so nothing takes this signature yet. It takes effect once the account is delegated to ${shortAddress(code)} (EIP-7702): an authorization you sign for that can be submitted with it, or after it, until the deadline.`);
      else if (runs !== code) b.warn('caution', 'gasless_exec_other_code', `Your account runs ${runs ? `other code (${shortAddress(runs)})` : 'code of its own'} now, not ${known ?? shortAddress(code)}: this signature is for the latter, and does nothing unless the account is delegated to it before the deadline.`);
      else {
        const used = await rpc.call(chainId, 'eth_call', [{ to: account, data: `${toFunctionSelector('isNonceUsed(uint256)')}${nonce.toString(16).padStart(64, '0')}` }, 'latest']).then(r => (/^0x[0-9a-f]{64}$/i.test(String(r)) ? BigInt(String(r)) === 1n : undefined), () => undefined);
        if (used) { spent = true; b.warn('info', 'gasless_exec_nonce_used', "This nonce is already used on your account: the execution can't run again."); }
        // Its kill switch: paused, the delegate refuses every execution (execute is whenNotPaused).
        const paused = known ? await rpc.call(chainId, 'eth_call', [{ to: account, data: toFunctionSelector('isPaused()') }, 'latest']).then(r => /^0x0{63}1$/.test(String(r)), () => false) : false;
        if (paused) b.warn('info', 'gasless_exec_paused', `The account code is paused now (its kill switch): it refuses every execution until it is unpaused. The signature stays usable ${expires ? `until ${formatTimestamp(Number(deadline) * 1000)}` : 'with no expiry'}.`);
      }
    } catch { b.note("Whether your account runs this code and the nonce is unused wasn't read."); }
  } else b.note("Whether your account runs this code and the nonce is unused wasn't checked (no RPC for this chain).");
  if (env.context.account && !sameAddress(env.context.account, account)) b.warn('caution', 'gasless_exec_other_account', `It is asked of ${shortAddress(account)}, not the wallet's account ${shortAddress(env.context.account)}: the calls run as whichever account's key signs it.`);

  // A call to the account itself: the delegate refuses any but invalidateNonce in an execution (ReentrantCall), and
  // run as the account's own call, as the calls are below, it isn't refused.
  const toSelf = calls.flatMap((c, i) => (sameAddress(c.target, account) && c.data.length >= 10 && c.data.slice(0, 10).toLowerCase() !== INVALIDATE_NONCE ? [i + 1] : []));
  if (toSelf.length && known) b.warn('caution', 'gasless_exec_self_call', `${n === 1 ? 'The call is' : `Call${toSelf.length === 1 ? '' : 's'} ${toSelf.join(', ')} ${toSelf.length === 1 ? 'is' : 'are'}`} to your account itself, which the account code refuses in an execution (any call to itself but invalidateNonce: ReentrantCall): the execution reverts whenever the relayer submits it. Run as your account's own ${what}, as ${n === 1 ? 'it is' : 'they are'} here, ${n === 1 ? 'it isn\'t' : 'they aren\'t'} refused: what is shown isn't what a relayer's submission does.`);

  // The calls, as the account's own: decoded so, and simulated as the account makes them, in order (the account's
  // code makes each as the account). A past block named for the preview isn't used: a signature is previewed on the
  // latest state.
  let assetChanges: AssetChange[] | undefined, approvals: ApprovalChange[] | undefined;
  let title = `Let ${shortAddress(relayer)} make ${n === 1 ? 'a call' : `${n} calls`} as your account`, status: 'full' | 'partial' | 'opaque' = 'partial', said = '';
  // More calls than are read: none is decoded or simulated, which is said. (Shown field by field, as typed data in
  // no known format is, they were cut at the sixtieth field: the twentieth call, with nothing of the relayer or the
  // deadline.)
  if (n > MAX_READ) {
    for (const [i, c] of calls.slice(0, MAX_READ).entries()) asSigned(b, i, c, false);
    b.detail('More calls', String(n - MAX_READ));
    b.warn('danger', 'gasless_exec_too_many', `It lists ${n} calls, more than the ${MAX_READ} that are read here: none is decoded or simulated, and ${n - MAX_READ} aren't shown at all. Each runs as your account and can move anything it holds.`);
    status = 'opaque';
  } else try {
    const context = { ...env.context, chainId, account: undefined, block: undefined, pinned: undefined, replay: undefined };
    const p: Preview = n === 1
      ? await previewTransaction(normalizeTransaction({ from: account, to: calls[0].target, value: `0x${calls[0].value!.toString(16)}`, data: calls[0].data }, context, account, chainId), env.deps, context, 'eth_sendTransaction')
      : await (await import('../preview.ts')).previewBatch({ chainId: `0x${chainId.toString(16)}`, from: account, atomicRequired: true, calls: calls.map(c => ({ to: c.target, value: `0x${c.value!.toString(16)}`, data: c.data })) }, context, env.deps);
    for (const d of p.details) if (!TX_DETAILS.test(d.label)) b.detail(d.label, d.value, d.raw);
    // Each call with its own details (who it sends to, who it approves): with its title and target alone, a batch
    // that sent tokens named the token's contract and no recipient anywhere.
    if (n > 1) for (const [i, c] of (p.calls ?? []).entries()) {
      b.detail(`Call ${i + 1}`, `${c.title} (${shortAddress(calls[i].target.toLowerCase())})`, calls[i].target.toLowerCase());
      for (const d of c.details) if (!TX_DETAILS.test(d.label)) b.detail(`Call ${i + 1}: ${d.label}`, d.value, d.raw);
    }
    said = p.summary;
    // A call that fails now: the execution reverts, the relayer pays for it, and the signature stays usable.
    const failing = [p, ...(p.calls ?? [])].find(c => c.simulation?.status === 'reverted' || c.warnings.some(w => w.code === 'simulation_reverted'));
    const reason = failing?.simulation?.revertReason;
    // (Not for a nonce already used: it can't run again, whatever its calls would do.)
    if (failing && !spent) b.warn('caution', 'gasless_exec_fails', `The ${what} would fail if the relayer submitted ${n === 1 ? 'it' : 'them'} now${reason ? ` (${reason})` : ''}: nothing would move now. But the signature stays valid ${expires ? `until ${formatTimestamp(Number(deadline) * 1000)}` : 'with no expiry'}, until it is used: the relayer can submit it once the ${what} would succeed. What ${n === 1 ? 'it moves' : 'they move'} then is what the ${what} above ${n === 1 ? 'asks' : 'ask'} for.`);
    for (const w of p.warnings) if (!TX_ONLY.has(w.code) && !FAILS.has(w.code)) b.warn(w.severity, w.code, w.message);
    if (p.simulation?.status === 'success') b.note(`Simulated as your account making the ${what}${n === 1 ? '' : ' in order'}, on the current state: the account's code makes ${n === 1 ? 'it' : 'each'} as the account, whoever submits the execution.`);
    for (const note of p.decoding.notes) b.note(note);
    if (p.trace && !b.trace) b.trace = p.trace;
    assetChanges = p.assetChanges;
    approvals = failing ? undefined : p.approvals;
    status = kind && known && !others.length && !misshapen && !toSelf.length ? p.decoding.status : 'partial';
    title = `Gasless ${what} as you: ${p.title.replace(/^(Send|Sign|Submit) (a )?transaction: /i, '').replace(/^\d+ actions: /, '')}`;
  } catch {
    // (Said, and the calls shown as signed, calldata and all: no less than typed data in no known format gets.)
    b.warn('caution', 'gasless_exec_unread', `The ${what} couldn't be decoded here: ${n === 1 ? 'it is' : 'they are'} shown as signed.`);
    for (const [i, c] of calls.entries()) asSigned(b, i, c, true);
  }
  b.note(`An off-chain signature: it costs nothing now. The relayer ${shortAddress(relayer)}, and no one else, can submit it${expires ? ` until ${formatTimestamp(Number(deadline) * 1000)}` : ''}, once: the ${what} then run${n === 1 ? 's' : ''} as your account, as if you had sent ${n === 1 ? 'it' : 'them'}.`);
  return {
    title, summary: `A signed gasless execution (${known ?? 'an account code this previewer doesn\'t know'}): the relayer ${shortAddress(relayer)} may make ${n === 1 ? 'this call' : `these ${n} calls`} as your account ${shortAddress(account)}, all or nothing.${said ? ` ${said}` : ''}`,
    decoder: 'authorized_executions', status, b, network, ...(assetChanges && { assetChanges }), ...(approvals?.length && { approvals }),
  };
};
