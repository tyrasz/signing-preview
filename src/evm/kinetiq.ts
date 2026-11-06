// Kinetiq liquid staking on HyperEVM: stake HYPE for kHYPE, unstake through a queue (7 days, or 36 hours when
// Kinetiq's buffer covers it) or instantly for a fee. The StakingManager is a router whose functions live in
// facets (StakingFacet, QueuedWithdrawalFacet, InstantUnstakeFacet); all are verified on Sourcify, and the rules
// below follow their source. Live values (rate, fees, delays, limits) are read with eth_call when an RPC is set.
import { decodeFunctionData, parseAbi } from 'viem';
import { compactUnits, formatDuration, formatTimestamp, formatUnits, PreviewBuilder, shortAddress } from '../format.ts';
import type { AssetChange } from '../types.ts';
import { decoded, type Adapter, type AdapterEnv, type Tx } from './common.ts';
import { read } from './onchain.ts';

/**
 * kHYPE is the address in Kinetiq's docs and Hyperliquid's own HyperCore link (spot token #121). The
 * StakingManager router reports that kHYPE as its token (tokenAddress()), checked by verify-live.
 */
export const KINETIQ: Record<number, { stakingManager: string; kHYPE: string }> = {
  999: { stakingManager: '0x393d0b87ed38fc779fd9611144ae649ba6082109', kHYPE: '0xfd739d4e423301ce9385c1fb8850539d657c296d' },
};

/**
 * Liquid-staking tokens run on Kinetiq's staking code, by StakingManager: kHYPE, and the institutional deployments
 * whose StakingManager and StakingAccountant run the same implementation as kHYPE's (same code hashes, and
 * tokenAddress() returns the listed token; kinetiq.xyz/docs/contracts-and-audits, 2026-11-06). Others listed there
 * (kmHYPE, flowHYPE, HiHYPE, hylqHYPE) run different, unpublished code and aren't decoded.
 */
export const KINETIQ_LSTS: Record<string, { chainId: number; token: string; symbol: string; name: string }> = {
  '0x393d0b87ed38fc779fd9611144ae649ba6082109': { chainId: 999, token: '0xfd739d4e423301ce9385c1fb8850539d657c296d', symbol: 'kHYPE', name: 'Kinetiq liquid staking' },
  '0x0c5d890cf52973ae4a7b10fa7ee18e146d13d87b': { chainId: 999, token: '0x8599f2efa5064c666b920e71381b5aabc7bb27f6', symbol: 'asxnHYPE', name: 'ASXN liquid staking (asxnHYPE, on Kinetiq)' },
};

const ABI = parseAbi([
  'function stake() payable',
  'function stake(address validator) payable',
  'function queueWithdrawal(uint256 tokenAmount)',
  'function confirmWithdrawal(uint256 withdrawalId)',
  'function batchConfirmWithdrawals(uint256[] withdrawalIds)',
  'function instantUnstake(uint256 tokenAmount, uint256 minHYPEOut)',
  'function redelegate(address fromValidator, address toValidator, uint256 kHYPEAmount)',
]);
const BPS = 10_000n;
const HYPE_STEP = 10n ** 10n; // HyperCore keeps HYPE with 8 decimals: staked amounts must be whole multiples of 1e10 wei
const fmt = (raw: bigint) => formatUnits(raw, 18);
const short = (raw: bigint) => compactUnits(raw, 18); // titles; details keep exact amounts
/** Delays as Kinetiq sets them: whole days or hours (36 hours, not "2 days"). */
const delayText = (seconds: bigint) => seconds % 86_400n === 0n ? `${seconds / 86_400n} day${seconds === 86_400n ? '' : 's'}` : seconds % 3600n === 0n ? `${seconds / 3600n} hours` : formatDuration(Number(seconds) * 1000);
const pct = (bps: bigint) => `${Number(bps) / 100}%`;

interface Request { hypeAmount: bigint; kHYPEAmount: bigint; kHYPEFee: bigint; bufferUsed: bigint; timestamp: bigint }

export const kinetiqAdapter: Adapter = async (tx, env) => {
  const k = tx.to ? KINETIQ_LSTS[tx.to.toLowerCase()] : undefined;
  if (!k || k.chainId !== tx.chainId) return null;
  const S = k.symbol, manager = tx.to!.toLowerCase();
  let call;
  try { call = decodeFunctionData({ abi: ABI, data: tx.data }); } catch { return null; }
  const b = new PreviewBuilder();
  const sm = (sig: string, args: readonly unknown[] = []) => read(env, tx.chainId, manager, sig, args);
  const toHype = async (kHype: bigint) => {
    const accountant = await sm('function stakingAccountant() view returns (address)') as string | undefined;
    return accountant ? await read<bigint>(env, tx.chainId, accountant, 'function kHYPEToHYPE(uint256) view returns (uint256)', [kHype]) : undefined;
  };
  const willFail = (code: string, message: string) => b.warn('caution', code, `This will fail: ${message}`);
  b.detail('Protocol', `${k.name} (StakingManager ${tx.to})`, tx.to!);
  const changes: AssetChange[] = [];
  const change = (direction: 'in' | 'out', raw: bigint, what: 'HYPE' | 'lst') =>
    changes.push({ direction, account: tx.from, amount: fmt(raw), symbol: what === 'HYPE' ? 'HYPE' : S, raw: raw.toString(), asset: what === 'HYPE' ? 'native' : k.token, basis: 'requested' });

  switch (call.functionName) {
    case 'stake': {
      const validator = call.args?.[0] as string | undefined;
      const value = tx.value;
      const accountant = await sm('function stakingAccountant() view returns (address)') as string | undefined;
      const kOut = accountant ? await read<bigint>(env, tx.chainId, accountant, 'function HYPEToKHYPE(uint256) view returns (uint256)', [value]) : undefined;
      b.detail('You stake', `${fmt(value)} HYPE`, value.toString());
      if (kOut !== undefined) b.detail('You receive (at the current rate)', `${fmt(kOut)} ${S}`, kOut.toString());
      const oneK = await toHype(10n ** 18n);
      if (oneK) b.detail('Rate', `1 ${S} = ${fmt(oneK)} HYPE`);
      if (validator) b.detail('Validator', validator);
      // Checks from StakingFacet._stakeInternal / _distributeStake, with live parameters.
      const min = await sm('function minStakeAmount() view returns (uint256)') as bigint | undefined;
      const max = await sm('function maxStakeAmount() view returns (uint256)') as bigint | undefined;
      if (value === 0n) willFail('kinetiq_no_value', 'no HYPE is attached to the transaction.');
      else if (min !== undefined && value < min) willFail('kinetiq_below_minimum', `the minimum stake is ${fmt(min)} HYPE.`);
      if (max && value > max) willFail('kinetiq_above_maximum', `the maximum stake is ${fmt(max)} HYPE.`);
      if (value % HYPE_STEP !== 0n) willFail('kinetiq_amount_precision', 'the HYPE amount must be a multiple of 0.00000001 HYPE (HyperCore keeps 8 decimals).');
      if (await sm('function stakingPaused() view returns (bool)') === true) willFail('kinetiq_paused', 'staking is paused.');
      if (await sm('function whitelistEnabled() view returns (bool)') === true) b.warn('info', 'kinetiq_whitelist', 'Kinetiq staking is limited to whitelisted addresses right now.');
      b.note(`${S} grows in HYPE value as staking rewards accrue. To get HYPE back, queue a withdrawal (about 7 days) or unstake instantly for a fee.`);
      change('out', value, 'HYPE');
      if (kOut !== undefined) change('in', kOut, 'lst');
      return decoded({ title: `Stake ${short(value)} HYPE${kOut !== undefined ? ` for ≈ ${short(kOut)} ${S}` : ` for ${S}`}`,
        summary: `Stakes ${fmt(value)} HYPE with Kinetiq${validator ? ` through validator ${shortAddress(validator)}` : ''} and mints ${S} to you.`, decoder: 'kinetiq_stake', status: 'full', b, assetChanges: changes });
    }
    case 'queueWithdrawal': {
      const amount = call.args[0];
      const feeRate = await sm('function unstakeFeeRate() view returns (uint256)') as bigint | undefined;
      const fee = feeRate !== undefined ? amount * feeRate / BPS : undefined;
      const hype = await toHype(amount - (fee ?? 0n));
      const delay = await sm('function withdrawalDelay() view returns (uint256)') as bigint | undefined;
      const quick = await sm('function quickWithdrawalDelay() view returns (uint256)') as bigint | undefined;
      b.detail('You unstake', `${fmt(amount)} ${S}`, amount.toString());
      if (fee !== undefined) b.detail('Unstake fee', `${pct(feeRate!)} (${fmt(fee)} ${S})`);
      if (hype !== undefined) b.detail('HYPE to claim (at the current rate)', `${fmt(hype)} HYPE`, hype.toString());
      if (delay !== undefined) b.detail('Claimable after', `${delayText(delay)}${quick ? ` (${delayText(quick)} if Kinetiq's buffer covers the whole amount)` : ''}`);
      const id = await sm('function nextWithdrawalId(address) view returns (uint256)', [tx.from]) as bigint | undefined;
      if (id !== undefined) b.detail('Withdrawal ID', `${id} (claim it with confirmWithdrawal)`);
      if (await sm('function withdrawalPaused() view returns (bool)') === true) willFail('kinetiq_paused', 'withdrawals are paused.');
      const min = await sm('function minWithdrawalAmount() view returns (uint256)') as bigint | undefined;
      if (amount === 0n || (min && amount < min)) willFail('kinetiq_below_minimum', `the minimum is ${fmt(min ?? 1n)} ${S}.`);
      b.note(`Your ${S} leaves your wallet now; the HYPE is sent when you claim after the delay. Kinetiq needs a ${S} allowance for the amount.`);
      change('out', amount, 'lst');
      return decoded({ title: `Unstake ${short(amount)} ${S}${hype !== undefined ? `: ≈ ${short(hype)} HYPE` : ''}${delay !== undefined ? ` claimable in ${delayText(delay)}` : ''}`,
        summary: `Queues a Kinetiq withdrawal of ${fmt(amount)} ${S}. The HYPE can be claimed after the unstaking delay.`, decoder: 'kinetiq_queue_withdrawal', status: 'full', b, assetChanges: changes });
    }
    case 'confirmWithdrawal':
    case 'batchConfirmWithdrawals': {
      const ids = call.functionName === 'confirmWithdrawal' ? [call.args[0]] : [...call.args[0]];
      const now = env.context.now ?? Date.now();
      const delay = await sm('function withdrawalDelay() view returns (uint256)') as bigint | undefined;
      const quick = await sm('function quickWithdrawalDelay() view returns (uint256)') as bigint | undefined;
      let ready = 0n, readyCount = 0, known = env.deps.rpc?.has(tx.chainId) ?? false;
      const notReady: string[] = [];
      for (const id of ids.slice(0, 20)) {
        const r = await sm('function withdrawalRequests(address,uint256) view returns ((uint256 hypeAmount, uint256 kHYPEAmount, uint256 kHYPEFee, uint256 bufferUsed, uint256 timestamp))', [tx.from, id]) as Request | undefined;
        if (!r) { known = false; b.detail(`Withdrawal ${id}`, 'not checked'); continue; }
        if (r.hypeAmount === 0n) { notReady.push(`#${id} (nothing to claim: already claimed, or not yours)`); b.detail(`Withdrawal ${id}`, 'nothing to claim'); continue; }
        // QueuedWithdrawalFacet._processConfirmation: the quick delay applies when the buffer covered all of it.
        const wait = r.bufferUsed === r.hypeAmount ? quick : delay;
        const at = wait !== undefined ? Number(r.timestamp + wait) * 1000 : undefined;
        if (at !== undefined && at > now) { notReady.push(`#${id} (ready ${formatTimestamp(at)}, in ${formatDuration(at - now)})`); b.detail(`Withdrawal ${id}`, `${fmt(r.hypeAmount)} HYPE, ready ${formatTimestamp(at)}`); continue; }
        ready += r.hypeAmount; readyCount++;
        b.detail(`Withdrawal ${id}`, `${fmt(r.hypeAmount)} HYPE, ready to claim`);
      }
      const single = ids.length === 1;
      // A single confirm reverts (InvalidWithdrawal) when nothing is claimable; a batch skips what isn't ready.
      if (notReady.length && single) willFail('kinetiq_not_claimable', `withdrawal ${notReady[0]}.`);
      else if (notReady.length) b.warn('info', 'kinetiq_not_claimable', `Not claimable yet, so skipped: ${notReady.join('; ')}.`);
      if (known && ready > 0n) change('in', ready, 'HYPE');
      const title = known && ready > 0n ? `Claim ${short(ready)} HYPE from ${readyCount === 1 ? 'a Kinetiq withdrawal' : `${readyCount} Kinetiq withdrawals`}` : `Claim Kinetiq withdrawal${single ? ` #${ids[0]}` : `s ${ids.map(i => `#${i}`).join(', ')}`}`;
      return decoded({ title, summary: `Claims HYPE from ${single ? 'a queued Kinetiq withdrawal' : `${ids.length} queued Kinetiq withdrawals`} to your wallet.`, decoder: 'kinetiq_confirm_withdrawal', status: 'full', b, assetChanges: changes });
    }
    case 'instantUnstake': {
      const [amount, minOut] = call.args;
      const pool = await sm('function instantUnstakePool() view returns (address)') as string | undefined;
      const quote = pool && !/^0x0{40}$/.test(pool) ? await read<readonly [bigint, bigint, bigint, boolean]>(env, tx.chainId, pool, 'function previewInstantUnstake(uint256) view returns (uint256 hypeAmount, uint256 kHYPEFee, uint256 feeRateBps, bool bufferSufficient)', [amount]) : undefined;
      b.detail('You unstake', `${fmt(amount)} ${S}`, amount.toString());
      b.detail('Minimum HYPE out', minOut === 0n ? 'none' : `${fmt(minOut)} HYPE`, minOut.toString());
      if (quote) {
        const [hype, fee, rate, enough] = quote;
        b.detail('You receive (Kinetiq quote)', `${fmt(hype)} HYPE`, hype.toString()).detail('Instant-unstake fee', `${pct(rate)} (${fmt(fee)} ${S})`);
        if (!enough) willFail('kinetiq_buffer_too_small', "Kinetiq's instant-unstake buffer doesn't hold enough HYPE for this amount right now.");
        if (hype < minOut) willFail('kinetiq_below_min_out', `the quote (${fmt(hype)} HYPE) is below your minimum (${fmt(minOut)} HYPE).`);
        const queueFee = await sm('function unstakeFeeRate() view returns (uint256)') as bigint | undefined;
        if (queueFee !== undefined && queueFee < rate) b.warn('info', 'kinetiq_queue_cheaper', `Queuing a withdrawal instead costs ${pct(queueFee)} and takes about 7 days.`);
        change('out', amount, 'lst');
        change('in', hype, 'HYPE');
      } else change('out', amount, 'lst');
      if (minOut === 0n) b.warn('caution', 'no_slippage_protection', 'No minimum amount of HYPE is set, so you accept whatever the rate and fee are when the transaction runs.');
      return decoded({ title: `Instant unstake ${short(amount)} ${S}${quote ? ` for ≈ ${short(quote[0])} HYPE (${pct(quote[2])} fee)` : ''}`,
        summary: `Swaps ${fmt(amount)} ${S} back to HYPE immediately through Kinetiq's instant-unstake buffer, for a fee.`, decoder: 'kinetiq_instant_unstake', status: 'full', b, assetChanges: changes });
    }
    case 'redelegate': {
      const [fromValidator, toValidator, amount] = call.args;
      const zero = (a: string) => /^0x0{40}$/.test(a);
      b.detail('Stake', `${fmt(amount)} ${S} worth`).detail('From validator', zero(fromValidator) ? 'Kinetiq default' : fromValidator).detail('To validator', zero(toValidator) ? 'Kinetiq default' : toValidator);
      return decoded({ title: `Move the stake behind ${short(amount)} ${S} to ${zero(toValidator) ? "Kinetiq's default validator" : `validator ${shortAddress(toValidator)}`}`,
        summary: `Redelegates the HYPE backing your ${S} to another validator. Your ${S} stays in your wallet.`, decoder: 'kinetiq_redelegate', status: 'full', b });
    }
  }
  return null;
};

/** Exported for tests: the rounding rule a stake must meet. */
export const isValidStakeAmount = (raw: bigint) => raw > 0n && raw % HYPE_STEP === 0n;
export type { Tx, AdapterEnv };
