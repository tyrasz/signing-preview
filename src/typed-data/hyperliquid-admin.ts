// Less common HyperCore L1 actions: agent-wallet actions, outcome shares, staking/validator operations and
// HIP-1/HIP-2/HIP-3/HIP-4 deployer actions. Shapes follow @nktkas/hyperliquid 0.33.3 (src/api/exchange/_methods);
// every action is {type, ...fields}, and union actions carry exactly one variant key next to `type`.
import { formatDecimalString, formatUnits, PreviewBuilder, sameAddress, shortAddress } from '../format.ts';
import { findSpotToken, resolveAsset } from '../hyperliquid/assets.ts';
import type { HyperliquidInfo } from '../types.ts';
import { big, str, type TypedDecoded } from './common.ts';

type Wire = Record<string, unknown>;
type Result = Pick<TypedDecoded, 'title' | 'summary' | 'status'>;
interface Env { signer: string | null }

const usd = (value: unknown) => { const n = big(value); return n === null ? str(value) : `${formatUnits(n, 6)} USDC`; };
/** HyperCore HYPE uses 8 wei decimals (1 HYPE = 10^8 wei). */
const hype = (value: unknown) => { const n = big(value); return n === null ? str(value) : `${formatUnits(n, 8)} HYPE`; };
/** Exact percentage of a decimal-fraction string ("0.07" -> "7%"), without floating-point artefacts. */
export function percentOf(fraction: unknown): string {
  const t = str(fraction);
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(t);
  if (!m) return t;
  const frac = (m[3] ?? '').padEnd(2, '0');
  const whole = (m[2] + frac.slice(0, 2)).replace(/^0+(?=\d)/, '');
  const rest = frac.slice(2).replace(/0+$/, '');
  return `${m[1]}${whole}${rest ? '.' + rest : ''}%`;
}
const yesNo = (v: unknown) => v === null || v === undefined ? 'unchanged' : v ? 'Yes' : 'No';

async function tokenName(info: HyperliquidInfo | undefined, index: unknown): Promise<string> {
  const t = await findSpotToken(info, { index: Number(index) });
  return t ? `${t.name} (#${str(index)})` : `token #${str(index)}`;
}

async function outcomeName(info: HyperliquidInfo | undefined, outcome: unknown): Promise<string> {
  const a = await resolveAsset(info, 100_000_000 + 10 * Number(outcome));
  return a.kind === 'outcome' ? a.name.replace(/: [^:]*$/, '') : `outcome #${str(outcome)}`;
}

async function outcomeQuote(info: HyperliquidInfo | undefined, outcome: unknown): Promise<string> {
  try { return (await info?.outcomeMeta?.())?.outcomes.find(o => o.outcome === Number(outcome))?.quoteToken ?? 'quote tokens'; } catch { return 'quote tokens'; }
}

/** Renders [key, value] tuple lists (e.g. per-asset settings) as details, capped for readability. */
function pairs(b: PreviewBuilder, label: string, list: unknown, render: (v: unknown) => string = str) {
  const items = Array.isArray(list) ? list as unknown[] : [];
  for (const item of items.slice(0, 20)) {
    const [k, v] = Array.isArray(item) ? item : [item, ''];
    b.detail(`${label}: ${str(k)}`, render(v));
  }
  if (items.length > 20) b.detail(label, `… and ${items.length - 20} more`);
  return items.length;
}

const variantOf = (action: Wire) => Object.keys(action).find(k => k !== 'type');

const deployerNote = (b: PreviewBuilder, what: string) =>
  b.warn('info', 'deployer_action', `This is a ${what} action. Only the account that deployed it (or an authorised sub-deployer) can perform it.`);

export async function describeMoreL1(type: string, action: Wire, b: PreviewBuilder, info: HyperliquidInfo | undefined, env: Env): Promise<Result | null> {
  switch (type) {
    // ---------------- Agent-wallet actions (signed by an API wallet, not normally by a user's wallet) ----------------
    case 'agentSendAsset': {
      const token = str(action.token), name = token.split(':')[0], amount = `${formatDecimalString(str(action.amount))} ${name}`;
      const dest = str(action.destination);
      b.detail('Token', name, token).detail('Amount', amount, str(action.amount)).detail('Recipient', dest)
        .detail('From DEX', str(action.sourceDex) || 'main perps').detail('To DEX', str(action.destinationDex) || 'main perps');
      if (str(action.fromSubAccount)) b.detail('From sub-account', str(action.fromSubAccount));
      b.warn('info', 'agent_action', 'This action is normally signed by an API wallet (agent) on behalf of its owner.');
      if (env.signer && !sameAddress(dest, env.signer)) b.warn('caution', 'recipient_not_sender', `The tokens go to ${shortAddress(dest)}.`);
      return { title: `Send ${amount} to ${shortAddress(dest)} (agent)`, summary: 'Transfers an asset on behalf of the agent\'s owner account.', status: 'full' };
    }
    case 'agentSetAbstraction': {
      const modes: Record<string, string> = { i: 'standard (separate balances)', u: 'unified account', p: 'portfolio margin' };
      const m = str(action.abstraction);
      b.detail('New account mode', modes[m] ?? m, m);
      b.warn('info', 'agent_action', 'This action is normally signed by an API wallet (agent) on behalf of its owner.');
      if (m === 'u' || m === 'p') b.warn('caution', 'shared_collateral', 'Balances will be shared as collateral across markets. A loss in one position can draw on, and liquidate against, the other balances.');
      return { title: `Set account mode to ${modes[m] ?? m} (agent)`, summary: 'Changes how the owner account\'s balances back its positions.', status: modes[m] ? 'full' : 'partial' };
    }
    case 'agentEnableDexAbstraction':
      b.warn('info', 'agent_action', 'This action is normally signed by an API wallet (agent) on behalf of its owner.');
      b.warn('caution', 'shared_collateral', 'Builder-deployed (HIP-3) perp DEXes will be able to use collateral from the main account, so losses there can affect the main balances.');
      return { title: 'Enable HIP-3 DEX abstraction (agent)', summary: 'Turns on HIP-3 DEX abstraction for the owner account.', status: 'full' };

    // ---------------- Outcome shares (HIP-4) ----------------
    case 'userOutcome': {
      const v = variantOf(action), p = (v ? action[v] : {}) as Wire;
      const amt = (x: unknown) => x === null || x === undefined ? 'the maximum available' : formatDecimalString(str(x));
      switch (v) {
        case 'splitOutcome': {
          const name = await outcomeName(info, p.outcome), quote = await outcomeQuote(info, p.outcome);
          b.detail('Outcome', name, str(p.outcome)).detail('Amount', `${amt(p.amount)} ${quote}`, str(p.amount));
          return { title: `Split ${amt(p.amount)} ${quote} into Yes and No shares of ${name}`, summary: `Turns ${amt(p.amount)} ${quote} into ${amt(p.amount)} Yes and ${amt(p.amount)} No shares.`, status: 'full' };
        }
        case 'mergeOutcome': {
          const name = await outcomeName(info, p.outcome);
          b.detail('Outcome', name, str(p.outcome)).detail('Shares', amt(p.amount));
          return { title: `Merge ${amt(p.amount)} Yes + No shares of ${name}`, summary: 'Turns matching Yes and No shares back into quote tokens.', status: 'full' };
        }
        case 'mergeQuestion':
          b.detail('Question', `#${str(p.question)}`).detail('Shares', amt(p.amount));
          return { title: `Merge ${amt(p.amount)} Yes shares across question #${str(p.question)}`, summary: 'Turns a Yes share of every outcome in a question back into quote tokens.', status: 'full' };
        case 'negateOutcome': {
          const name = await outcomeName(info, p.outcome);
          b.detail('Question', `#${str(p.question)}`).detail('Outcome', name, str(p.outcome)).detail('No shares', amt(p.amount));
          return { title: `Convert ${amt(p.amount)} No shares of ${name} into Yes shares of the other outcomes`, summary: 'Swaps No shares of one outcome for Yes shares of every other outcome in the question.', status: 'full' };
        }
      }
      return null;
    }

    // ---------------- Staking, validators, network ----------------
    case 'CSignerAction': {
      const jail = 'jailSelf' in action;
      b.warn('caution', 'validator_action', jail ? 'Jails this validator signer: the validator stops participating until it is unjailed.' : 'Unjails this validator signer.');
      return { title: jail ? 'Jail validator signer (self)' : 'Unjail validator signer (self)', summary: 'A validator-signer operation.', status: 'full' };
    }
    case 'CValidatorAction': {
      const v = variantOf(action), p = action[v ?? ''] as Wire | null;
      if (v === 'unregister') {
        b.warn('caution', 'validator_action', 'Unregisters this validator.');
        return { title: 'Unregister validator', summary: 'Removes this account as a validator.', status: 'full' };
      }
      if (v === 'register' && p) {
        const profile = (p.profile ?? {}) as Wire;
        b.detail('Name', str(profile.name)).detail('Description', str(profile.description)).detail('Node IP', str((profile.node_ip as Wire | undefined)?.Ip))
          .detail('Signer', str(profile.signer)).detail('Commission (commission_bps)', str(profile.commission_bps))
          .detail('Delegations disabled', yesNo(profile.delegations_disabled)).detail('Initial stake', hype(p.initial_wei), str(p.initial_wei)).detail('Start unjailed', yesNo(p.unjailed));
        b.warn('caution', 'validator_action', `Registers a validator and stakes ${hype(p.initial_wei)} from this account.`);
        return { title: `Register validator "${str(profile.name)}"`, summary: 'Creates a new validator with an initial self-stake.', status: 'full' };
      }
      if (v === 'changeProfile' && p) {
        const ip = (p.node_ip as Wire | null)?.Ip;
        b.detail('Name', p.name === null ? 'unchanged' : str(p.name)).detail('Description', p.description === null ? 'unchanged' : str(p.description))
          .detail('Node IP', ip ? str(ip) : 'unchanged').detail('Signer', p.signer === null ? 'unchanged' : str(p.signer))
          .detail('Commission (commission_bps)', p.commission_bps === null || p.commission_bps === undefined ? 'unchanged' : str(p.commission_bps))
          .detail('Disable delegations', yesNo(p.disable_delegations)).detail('Unjailed', yesNo(p.unjailed));
        if (p.signer !== null && p.signer !== undefined) b.warn('caution', 'validator_signer_change', `Changes the validator's signer key to ${shortAddress(str(p.signer))}.`);
        return { title: 'Change validator profile', summary: 'Updates this validator\'s public profile and settings.', status: 'full' };
      }
      return null;
    }
    case 'validatorL1Stream':
      b.detail('Risk-free rate', percentOf(action.riskFreeRate), str(action.riskFreeRate));
      return { title: `Validator vote: risk-free rate ${percentOf(action.riskFreeRate)}`, summary: 'A validator vote on the risk-free rate used for aligned quote assets.', status: 'full' };
    case 'gossipPriorityBid':
      b.detail('Slot', str(action.slotId)).detail('IP address', str(action.ip)).detail('Maximum cost', hype(action.maxGas), str(action.maxGas));
      b.warn('caution', 'spends_hype', `Bids up to ${hype(action.maxGas)} from your spot balance in a priority auction for mempool data delivered to ${str(action.ip)}.`);
      return { title: `Bid up to ${hype(action.maxGas)} for priority data (slot ${str(action.slotId)})`, summary: 'Bids in the gossip priority auction for faster mempool data to an IP address.', status: 'full' };
    case 'reserveRequestWeight':
      b.detail('Request weight', str(action.weight));
      if (action.destination) b.detail('For account', str(action.destination));
      b.warn('info', 'paid_action', 'Reserving extra request weight is charged a fee.');
      return { title: `Reserve ${str(action.weight)} extra API request weight${action.destination ? ` for ${shortAddress(str(action.destination))}` : ''}`, summary: 'Pays for additional rate-limited actions.', status: 'full' };
    case 'activateOutcomeDeployer':
      return { title: action.isDeactivate ? 'Deactivate as outcome market deployer' : 'Activate as outcome market deployer', summary: 'Enables or disables this account\'s ability to deploy outcome (prediction) markets.', status: 'full' };
    case 'authorizeAqav2Role': {
      const name = await tokenName(info, action.token);
      b.detail('Token', name).detail('Role', str(action.role));
      b.warn('caution', 'role_grant', `Authorises the "${str(action.role)}" AQAv2 role for ${name}.`);
      return { title: `Authorise AQAv2 ${str(action.role)} role for ${name}`, summary: 'An aligned-quote-asset (AQAv2) role authorisation.', status: 'full' };
    }
    case 'hip3LiquidatorTransfer': {
      const amount = `${usd(action.ntl).replace(' USDC', '')} quote tokens`;
      b.detail('Perp DEX', str(action.dex)).detail('Amount', amount, str(action.ntl));
      if (action.isDeposit) b.warn('caution', 'backstop_liquidator', `Funds in ${str(action.dex)}'s backstop liquidator take over liquidated positions on that DEX and can lose value.`);
      return { title: `${action.isDeposit ? 'Deposit' : 'Withdraw'} ${amount} ${action.isDeposit ? 'into' : 'from'} the ${str(action.dex)} backstop liquidator`, summary: 'Moves funds into or out of a HIP-3 DEX\'s backstop liquidator.', status: 'full' };
    }
    case 'finalizeEvmContract': {
      const name = await tokenName(info, action.token);
      const input = action.input;
      const method = typeof input === 'string' ? input : `EOA deploy nonce ${str((input as Wire)?.create && ((input as Wire).create as Wire).nonce)}`;
      b.detail('Token', name).detail('Verification', method);
      deployerNote(b, 'token deployment');
      return { title: `Finalize HyperEVM contract link for ${name}`, summary: 'Completes linking a HyperCore spot token to its HyperEVM ERC-20 contract.', status: 'full' };
    }

    // ---------------- HIP-3 perp deployer ----------------
    case 'perpDeploy': {
      const v = variantOf(action), p = action[v ?? ''];
      deployerNote(b, 'HIP-3 perp DEX deployer');
      const o = (p ?? {}) as Wire;
      switch (v) {
        case 'registerAsset':
        case 'registerAsset2': {
          const req = (o.assetRequest ?? {}) as Wire, schema = o.schema as Wire | null;
          b.detail('DEX', str(o.dex)).detail('Coin', str(req.coin)).detail('Size decimals', str(req.szDecimals)).detail('Initial oracle price', formatDecimalString(str(req.oraclePx)))
            .detail('Margin table', str(req.marginTableId)).detail(v === 'registerAsset' ? 'Isolated only' : 'Margin mode', v === 'registerAsset' ? yesNo(req.onlyIsolated) : str(req.marginMode))
            .detail('Maximum deploy cost', o.maxGas === null ? 'current auction price' : hype(o.maxGas), str(o.maxGas));
          if (schema) b.detail('Creates new DEX', `${str(schema.fullName)} (collateral token #${str(schema.collateralToken)}, oracle updater ${schema.oracleUpdater ? str(schema.oracleUpdater) : 'deployer'})`);
          b.warn('caution', 'spends_hype', `Pays ${o.maxGas === null ? 'the current deploy-auction price' : `up to ${hype(o.maxGas)}`} to list ${str(req.coin)}.`);
          return { title: `Deploy perp ${str(req.coin)} on DEX ${str(o.dex)}${schema ? ' (new DEX)' : ''}`, summary: 'Lists a new perpetual market on a builder-deployed (HIP-3) DEX.', status: 'full' };
        }
        case 'setOracle': {
          b.detail('DEX', str(o.dex));
          const n = pairs(b, 'Oracle price', o.oraclePxs, x => formatDecimalString(str(x)));
          pairs(b, 'External price', o.externalPerpPxs, x => formatDecimalString(str(x)));
          b.warn('caution', 'oracle_update', 'Sets oracle and mark prices on this DEX; these drive funding and liquidations.');
          return { title: `Update oracle prices for ${n} asset${n === 1 ? '' : 's'} on ${str(o.dex)}`, summary: 'Pushes new oracle/mark prices for a HIP-3 DEX.', status: 'full' };
        }
        case 'haltTrading':
          b.detail('Coin', str(o.coin));
          b.warn('caution', 'halt_trading', o.isHalted ? `Halts trading in ${str(o.coin)}.` : `Resumes trading in ${str(o.coin)}.`);
          return { title: `${o.isHalted ? 'Halt' : 'Resume'} trading in ${str(o.coin)}`, summary: 'Stops or restarts trading in a HIP-3 market.', status: 'full' };
        case 'setFeeRecipient':
          b.detail('DEX', str(o.dex)).detail('Fee recipient', str(o.feeRecipient));
          b.warn('caution', 'fee_recipient', `This DEX's deployer fees will go to ${shortAddress(str(o.feeRecipient))}.`);
          return { title: `Send ${str(o.dex)} deployer fees to ${shortAddress(str(o.feeRecipient))}`, summary: 'Changes who receives a HIP-3 DEX\'s fees.', status: 'full' };
        case 'setSubDeployers': {
          b.detail('DEX', str(o.dex));
          const subs = Array.isArray(o.subDeployers) ? o.subDeployers as Wire[] : [];
          for (const s of subs.slice(0, 20)) b.detail(`${s.allowed ? 'Allow' : 'Revoke'} ${str(s.variant)}`, str(s.user));
          if (subs.some(s => s.allowed)) b.warn('caution', 'grant_permission', 'Grants other addresses permission to perform deployer actions on this DEX.');
          return { title: `Change sub-deployer permissions on ${str(o.dex)} (${subs.length})`, summary: 'Adds or removes addresses allowed to run deployer actions.', status: 'full' };
        }
        case 'insertMarginTable': {
          const t = (o.marginTable ?? {}) as Wire;
          b.detail('DEX', str(o.dex)).detail('Description', str(t.description));
          for (const tier of (Array.isArray(t.marginTiers) ? t.marginTiers as Wire[] : [])) b.detail(`Above ${formatDecimalString(str(tier.lowerBound))} notional`, `max ${str(tier.maxLeverage)}×`);
          return { title: `Add margin table "${str(t.description)}" to ${str(o.dex)}`, summary: 'Defines leverage tiers for HIP-3 markets.', status: 'full' };
        }
        case 'setFeeScale':
          b.detail('DEX', str(o.dex)).detail('Fee scale', str(o.scale));
          return { title: `Set ${str(o.dex)} fee scale to ${str(o.scale)}`, summary: 'Changes the fee multiplier for a HIP-3 DEX.', status: 'full' };
        case 'setPerpAnnotation':
          b.detail('Coin', str(o.coin)).detail('Category', str(o.category)).detail('Display name', o.displayName === null ? '(none)' : str(o.displayName))
            .detail('Description', str(o.description)).detail('Keywords', (Array.isArray(o.keywords) ? o.keywords : []).map(str).join(', '));
          return { title: `Annotate ${str(o.coin)}`, summary: 'Sets the display metadata frontends show for a HIP-3 market.', status: 'full' };
        case 'disableDex':
          b.warn('caution', 'disable_dex', `Disables the ${str(p)} perp DEX.`);
          return { title: `Disable perp DEX ${str(p)}`, summary: 'Turns off a builder-deployed (HIP-3) perp DEX.', status: 'full' };
      }
      const lists: Record<string, string> = { setFundingMultipliers: 'Funding multiplier', setFundingInterestRates: 'Funding interest rate (8h)', setMarginTableIds: 'Margin table', setOpenInterestCaps: 'Open-interest cap', setMarginModes: 'Margin mode', setGrowthModes: 'Growth mode' };
      if (v && lists[v]) {
        const n = pairs(b, lists[v], p, x => typeof x === 'boolean' ? (x ? 'on' : 'off') : formatDecimalString(str(x)));
        return { title: `Set ${lists[v].toLowerCase()} for ${n} asset${n === 1 ? '' : 's'}`, summary: 'Changes per-asset settings on a HIP-3 DEX.', status: 'full' };
      }
      return null;
    }

    // ---------------- HIP-1/HIP-2 spot deployer and HIP-4 outcome deployer ----------------
    case 'spotDeploy': {
      const v = variantOf(action), o = (action[v ?? ''] ?? {}) as Wire;
      deployerNote(b, v === 'outcome' ? 'outcome-market deployer' : 'spot token deployer');
      switch (v) {
        case 'registerToken2': {
          const spec = (o.spec ?? {}) as Wire;
          b.detail('Token', str(spec.name)).detail('Full name', str(o.fullName) || '(none)').detail('Size decimals', str(spec.szDecimals)).detail('Wei decimals', str(spec.weiDecimals)).detail('Maximum deploy gas', str(o.maxGas));
          b.warn('caution', 'spends_hype', 'Pays the spot deploy-auction price (up to the maximum gas shown).');
          return { title: `Register spot token ${str(spec.name)}`, summary: 'Starts deploying a new HyperCore spot token (HIP-1).', status: 'full' };
        }
        case 'userGenesis': {
          const name = await tokenName(info, o.token);
          b.detail('Token', name);
          const n = pairs(b, 'Allocate to', o.userAndWei);
          pairs(b, 'Allocate to holders of', o.existingTokenAndWei);
          pairs(b, 'Blacklist', o.blacklistUsers, x => x ? 'add' : 'remove');
          return { title: `Set genesis allocations for ${name} (${n} account${n === 1 ? '' : 's'})`, summary: 'Defines the initial token distribution.', status: 'full' };
        }
        case 'genesis': {
          const name = await tokenName(info, o.token);
          b.detail('Token', name).detail('Maximum supply', formatDecimalString(str(o.maxSupply))).detail('Hyperliquidity', o.noHyperliquidity ? 'none' : 'default');
          return { title: `Run genesis for ${name}`, summary: 'Mints the token\'s initial supply.', status: 'full' };
        }
        case 'registerSpot': {
          const [baseI, quoteI] = Array.isArray(o.tokens) ? o.tokens as unknown[] : [];
          const [base, quote] = [await tokenName(info, baseI), await tokenName(info, quoteI)];
          return { title: `Register spot pair ${base} / ${quote}`, summary: 'Creates a new spot trading pair.', status: 'full' };
        }
        case 'registerHyperliquidity':
          b.detail('Spot pair', `#${str(o.spot)}`).detail('Start price', formatDecimalString(str(o.startPx))).detail('Order size', formatDecimalString(str(o.orderSz))).detail('Orders', str(o.nOrders)).detail('Seeded levels', str(o.nSeededLevels ?? 0));
          return { title: `Set up Hyperliquidity for spot pair #${str(o.spot)}`, summary: 'Configures the protocol market-making strategy (HIP-2) for a pair.', status: 'full' };
        case 'setDeployerTradingFeeShare': {
          const name = await tokenName(info, o.token);
          b.detail('Token', name).detail('Deployer fee share', str(o.share));
          return { title: `Set deployer fee share for ${name} to ${str(o.share)}`, summary: 'Changes how much of the trading fees the token deployer receives.', status: 'full' };
        }
        case 'enableQuoteToken':
        case 'disableQuoteToken': {
          const name = await tokenName(info, o.token);
          return { title: `${v === 'enableQuoteToken' ? 'Enable' : 'Disable'} ${name} as a quote token`, summary: 'Changes whether the token can be used as the quote side of spot pairs.', status: 'full' };
        }
        case 'requestEvmContract': {
          const name = await tokenName(info, o.token);
          b.detail('Token', name).detail('HyperEVM contract', str(o.address)).detail('Extra EVM decimals', str(o.evmExtraWeiDecimals));
          return { title: `Request HyperEVM contract link for ${name}`, summary: `Asks to link ${name} to ERC-20 ${shortAddress(str(o.address))} on HyperEVM; the EVM deployer finalizes it.`, status: 'full' };
        }
        case 'outcome': {
          const ov = Object.keys(o)[0], q = (o[ov] ?? {}) as Wire;
          const kv = (x: unknown) => (Array.isArray(x) ? x as unknown[] : []).map(t => Array.isArray(t) ? `${str(t[0])}=${str(t[1])}` : str(t)).join(', ');
          switch (ov) {
            case 'registerStandaloneOutcomeFromTemplate':
              b.detail('Template', str(q.id)).detail('Parameters', kv(q.keywordToValue));
              return { title: `Deploy outcome market from template ${str(q.id)}`, summary: 'Creates a standalone Yes/No outcome market.', status: 'full' };
            case 'registerQuestionFromTemplate': {
              const qt = (q.questionTemplateInstance ?? {}) as Wire, outs = Array.isArray(q.namedOutcomeTemplateInstances) ? q.namedOutcomeTemplateInstances as Wire[] : [];
              b.detail('Question template', str(qt.id)).detail('Question parameters', kv(qt.keywordToValue));
              outs.slice(0, 20).forEach((x, i) => b.detail(`Outcome ${i + 1}`, `${str(x.id)}: ${kv(x.keywordToValue)}`));
              return { title: `Deploy question with ${outs.length} outcome${outs.length === 1 ? '' : 's'} (${str(qt.id)})`, summary: 'Creates a multi-outcome prediction question.', status: 'full' };
            }
            case 'settleOutcome': {
              const [nm, desc] = Array.isArray(q.nameAndDescription) ? q.nameAndDescription as string[] : [];
              const [yes] = Array.isArray(q.sideNames) ? q.sideNames as string[] : [];
              b.detail('Outcome', `#${str(q.outcome)} ${nm ?? ''}`.trim()).detail('Description', desc ?? '').detail(`${yes ?? 'Yes'} side pays`, percentOf(q.settleFraction), str(q.settleFraction));
              b.warn('caution', 'settle_outcome', `Settles outcome #${str(q.outcome)}: the ${yes ?? 'Yes'} side pays ${percentOf(q.settleFraction)}. Check this matches the real-world result.`);
              return { title: `Settle outcome #${str(q.outcome)} (${yes ?? 'Yes'} pays ${percentOf(q.settleFraction)})`, summary: 'Resolves an outcome market you deployed.', status: 'full' };
            }
            case 'settleQuestion2': {
              const list = Array.isArray(q.outcomeSettlements) ? q.outcomeSettlements as Wire[] : [];
              for (const s of list.slice(0, 20)) b.detail(`Outcome #${str(s.outcome)} Yes pays`, percentOf(s.settleFraction));
              b.warn('caution', 'settle_outcome', `Settles question #${str(q.question)} and its ${list.length} remaining outcome${list.length === 1 ? '' : 's'}. Check this matches the real-world result.`);
              return { title: `Settle question #${str(q.question)} (${list.length} outcome${list.length === 1 ? '' : 's'})`, summary: 'Resolves every remaining outcome of a question you deployed.', status: 'full' };
            }
          }
          return null;
        }
      }
      return null;
    }
  }
  return null;
}
