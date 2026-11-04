// What a simulated transaction does to the account: balance changes (fungible and NFT) and the permissions it
// leaves in place. Shared by single transactions and EIP-5792 batches.
import { formatUnits, isUnlimited, PreviewBuilder, sameAddress, shortAddress } from '../format.ts';
import { CHAINS } from '../chains.ts';
import type { ApprovalChange, AssetChange, Dependencies, SimulatedApproval, SimulatedNftTransfer, SimulatedTransfer, TokenInfo } from '../types.ts';
import { tokenInfo, tokenSourceWarnings } from './common.ts';
import { approvalKey } from '../simulation.ts';

interface Account { chainId: number; from: string }

/** Nets simulated fungible transfers into per-asset changes for the account. */
export async function netChanges(transfers: SimulatedTransfer[], account: Account, deps: Dependencies, b: PreviewBuilder): Promise<AssetChange[]> {
  const net = new Map<string, bigint>();
  for (const t of transfers) {
    const asset = t.asset.toLowerCase();
    if (sameAddress(t.from, account.from)) net.set(asset, (net.get(asset) ?? 0n) - t.raw);
    if (sameAddress(t.to, account.from)) net.set(asset, (net.get(asset) ?? 0n) + t.raw);
  }
  const out: AssetChange[] = [];
  const env = { deps, context: {} };
  for (const [asset, delta] of net) {
    if (delta === 0n) continue;
    const chain = CHAINS[account.chainId];
    const info = asset === 'native' ? { symbol: chain?.nativeSymbol ?? 'native', decimals: chain?.nativeDecimals ?? 18 } : await tokenInfo(env, account.chainId, asset);
    if (asset !== 'native') tokenSourceWarnings(b, account.chainId, info as TokenInfo | undefined);
    const abs = delta < 0n ? -delta : delta;
    out.push({ direction: delta < 0n ? 'out' : 'in', account: account.from, amount: info ? formatUnits(abs, info.decimals) : abs.toString(), symbol: info?.symbol ?? asset, raw: abs.toString(), asset,
      standard: asset === 'native' ? 'native' : 'erc20', basis: 'simulated_events' });
  }
  return out;
}

const shortId = (id: bigint) => { const s = id.toString(); return s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s; };

async function collectionLabel(deps: Dependencies, chainId: number, address: string): Promise<{ label: string; named: boolean }> {
  try {
    const c = await deps.tokens?.collection?.(chainId, address);
    const name = c?.symbol || c?.name;
    if (name) return { label: name, named: true };
  } catch { /* unnamed */ }
  return { label: `NFT ${shortAddress(address)}`, named: false };
}

/** Nets NFT transfers per token ID: ERC-721 in/out, ERC-1155 by amount. Shown as e.g. "BAYC #42". */
export async function nftChanges(transfers: SimulatedNftTransfer[], account: Account, deps: Dependencies, b: PreviewBuilder): Promise<AssetChange[]> {
  const net = new Map<string, { t: SimulatedNftTransfer; delta: bigint }>();
  for (const t of transfers) {
    const key = `${t.standard}:${t.collection.toLowerCase()}:${t.tokenId}`;
    const e = net.get(key) ?? { t, delta: 0n };
    if (sameAddress(t.from, account.from)) e.delta -= t.amount;
    if (sameAddress(t.to, account.from)) e.delta += t.amount;
    net.set(key, e);
  }
  const out: AssetChange[] = [];
  let namedIncoming = false;
  for (const { t, delta } of net.values()) {
    if (delta === 0n) continue;
    const c = await collectionLabel(deps, account.chainId, t.collection);
    if (c.named && delta > 0n) namedIncoming = true;
    const abs = delta < 0n ? -delta : delta;
    out.push({ direction: delta < 0n ? 'out' : 'in', account: account.from, amount: abs.toString(), symbol: `${c.label} #${shortId(t.tokenId)}`, raw: abs.toString(),
      asset: t.collection.toLowerCase(), standard: t.standard, tokenId: t.tokenId.toString(), basis: 'simulated_events' });
  }
  // Scam airdrops copy famous collection names, so a received NFT's name proves nothing.
  if (namedIncoming) b.warn('info', 'nft_metadata_unverified', 'NFT collection names come from the contracts themselves and are easy to copy; check the collection address before trusting a received NFT.');
  return out;
}

/**
 * The permissions the account has granted when the transaction ends, for each token and spender (or NFT).
 * `state` (read from the tokens after the simulation) wins; otherwise the last approval event does. Events alone can
 * be stale: USDC, OpenZeppelin 5 tokens and Permit2 spend allowances without an event, while older OpenZeppelin
 * tokens emit one on every spend. `callTo` marks approvals that are the call itself (approve(), Permit2.approve).
 */
export async function approvalChanges(events: { approval: SimulatedApproval; callTo: string | null }[], account: Account, deps: Dependencies, state: SimulatedApproval[] = []): Promise<ApprovalChange[]> {
  const last = new Map<string, { approval: SimulatedApproval; direct: boolean; read: boolean } | null>();
  const isZero = (a: string) => /^0x0{40}$/.test(a);
  for (const { approval: a, callTo } of events) {
    if (!sameAddress(a.owner, account.from)) continue;
    // ERC-721 contracts clear a token's approval (to the zero address) on every transfer: not a user-facing change.
    if (a.kind === 'erc721' && isZero(a.spender)) { last.set(approvalKey(a), null); continue; }
    last.set(approvalKey(a), { approval: a, direct: sameAddress(a.emitter, callTo), read: false });
  }
  for (const s of state) {
    const key = approvalKey(s), entry = last.get(key);
    if (!entry || !sameAddress(s.owner, account.from)) continue;
    if (s.kind === 'erc721' && isZero(s.spender)) { last.set(key, null); continue; }
    last.set(key, { ...entry, approval: { ...entry.approval, spender: s.spender, amount: s.amount, approved: s.approved, expiration: s.expiration ?? entry.approval.expiration }, read: true });
  }
  const env = { deps, context: {} };
  const out: ApprovalChange[] = [];
  for (const entry of last.values()) {
    if (!entry) continue;
    const { approval: a, direct, read } = entry;
    const base = { kind: a.kind, owner: account.from, spender: a.spender, token: a.token, direct, basis: read ? 'simulated_state' as const : 'simulated_events' as const };
    if (a.kind === 'operator') {
      const c = await collectionLabel(deps, account.chainId, a.token);
      out.push({ ...base, symbol: c.label, allowance: a.approved ? 'all NFTs in the collection' : 'revoked', revoked: !a.approved });
    } else if (a.kind === 'erc721') {
      const c = await collectionLabel(deps, account.chainId, a.token);
      out.push({ ...base, symbol: c.label, allowance: `${c.label} #${shortId(a.tokenId ?? 0n)}`, tokenId: (a.tokenId ?? 0n).toString(), revoked: false });
    } else {
      const amount = a.amount ?? 0n;
      const info = await tokenInfo(env, account.chainId, a.token);
      const symbol = info?.symbol ?? shortAddress(a.token);
      const allowance = amount === 0n ? 'none' : isUnlimited(amount) ? 'unlimited' : info ? `${formatUnits(amount, info.decimals)} ${symbol}` : `${amount} (base units)`;
      out.push({ ...base, symbol, allowance, raw: amount.toString(), revoked: amount === 0n, ...(a.expiration && { expiration: a.expiration }) });
    }
  }
  return out;
}

/**
 * Warns about permissions granted along the way by another call (e.g. a router setting a Permit2 allowance, or a
 * smart account's execute()). Direct approve calls are already flagged by their decoders.
 */
export function approvalWarnings(b: PreviewBuilder, approvals: ApprovalChange[], nowMs = Date.now()) {
  // One warning per kind (the builder keeps one per code), listing every approval of that kind.
  const groups = new Map<string, { severity: 'info' | 'caution' | 'danger'; parts: string[] }>();
  const add = (severity: 'info' | 'caution' | 'danger', code: string, text: string) => {
    const g = groups.get(code) ?? { severity, parts: [] };
    g.parts.push(text);
    groups.set(code, g);
  };
  for (const a of approvals) {
    if (a.direct || a.revoked) continue;
    const who = shortAddress(a.spender);
    const until = a.expiration && a.expiration * 1000 > nowMs ? ` until ${new Date(a.expiration * 1000).toISOString().slice(0, 10)}` : '';
    const via = a.kind === 'permit2' ? ' through Permit2' : '';
    if (a.kind === 'operator') add('danger', 'hidden_approval_for_all', `${who} can transfer every NFT you hold in ${a.symbol}`);
    else if (a.kind === 'erc721') add('caution', 'hidden_nft_approval', `${who} can transfer your ${a.allowance}`);
    else if (a.allowance === 'unlimited') add('caution', 'hidden_unlimited_approval', `${who} can spend an unlimited amount of your ${a.symbol}${via}${until}`);
    else add('info', 'hidden_approval', `${who} can spend up to ${a.allowance} from your account${via}${until}`);
  }
  const list = (parts: string[]) => parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join('; ')}; and ${parts[parts.length - 1]}`;
  for (const [code, g] of groups) {
    const tail = code === 'hidden_approval_for_all' ? ' This is the most common NFT drain pattern; only allow it for marketplaces you trust.' : '';
    b.warn(g.severity, code, `Set by this transaction along the way: after it, ${list(g.parts)}.${tail}`);
  }
}
