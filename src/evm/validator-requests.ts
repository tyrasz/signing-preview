// Requests a validator's withdrawal address makes of the consensus layer, through Ethereum's two system contracts
// (Pectra): withdrawals and exits (EIP-7002, 0x00000961…7002) and consolidations (EIP-7251, 0x0000BBdD…7251). Their
// calldata is packed, not ABI-encoded, so they were previewed as calls that couldn't be decoded:
//   withdrawal:    validator public key (48 bytes) ‖ amount in gwei (8 bytes, big-endian); an amount of 0 is a full exit
//   consolidation: source public key (48 bytes) ‖ target public key (48 bytes); the same key twice switches that
//                  validator to compounding credentials (0x02)
// Each takes a fee in wei with the call (read by calling it with no calldata), keeps whatever is sent, reverts on
// less than the fee and on calldata of any other length, queues the request with the caller's address, and logs it
// (the withdrawal contract's verified source on Sourcify says so of it; the same shape was read from mined requests
// of both: 155 withdrawal requests and 4 consolidations in 6,000 Ethereum blocks, 2026-11-23, three of the latter
// from a Safe).
//
// The consensus layer acts on a request only if the caller is the validator's withdrawal address (the address its
// 0x01 or 0x02 withdrawal credentials name); otherwise the fee is spent and nothing happens. What it does when it
// acts is what matters: an exit stops the validator for good; a consolidation moves the source validator's whole
// balance into the target validator, to be paid out from then on to the *target's* withdrawal address, which the
// consensus layer does not require to be the caller's. Validators aren't readable from here (they live on the
// consensus layer), so who the target pays can't be checked: the preview says what to check.
import { formatUnits, PreviewBuilder, shortAddress } from '../format.ts';
import { decoded, readsAt, type Adapter } from './common.ts';

export const WITHDRAWAL_REQUESTS = '0x00000961ef480eb55e80d19ad83579a64c007002', CONSOLIDATION_REQUESTS = '0x0000bbddc7ce488642fb579f8b00f3a590007251';
/** Where the contracts are what they are on Ethereum: Ethereum and Sepolia. */
const CHAINS_WITH = new Set([1, 11155111]);
const GWEI = 10n ** 9n;
/** Past this much over the fee (0.001 ETH), what is sent is said to be kept: the fee is a few wei when the queue is short. */
const OVERPAID = 10n ** 15n;
const shortKey = (k: string) => `${k.slice(0, 10)}…${k.slice(-6)}`;

export const validatorRequestAdapter: Adapter = async (tx, env) => {
  const to = tx.to?.toLowerCase();
  if (!CHAINS_WITH.has(tx.chainId) || (to !== WITHDRAWAL_REQUESTS && to !== CONSOLIDATION_REQUESTS)) return null;
  const withdrawal = to === WITHDRAWAL_REQUESTS, what = withdrawal ? 'withdrawal' : 'consolidation';
  const h = tx.data.slice(2).toLowerCase(), bytes = h.length / 2, expected = withdrawal ? 56 : 96;
  const b = new PreviewBuilder().detail('Contract', `Ethereum's validator ${what} requests (${withdrawal ? 'EIP-7002' : 'EIP-7251'}, ${to})`, to);
  const eth = (wei: bigint) => (wei < GWEI ? `${wei} wei` : `${formatUnits(wei, 18)} ETH`);
  const out = tx.value > 0n ? [{ direction: 'out' as const, account: tx.from, amount: formatUnits(tx.value, 18), symbol: 'ETH', raw: tx.value.toString(), asset: 'native', basis: 'requested' as const, standard: 'native' as const }] : [];
  // No calldata and no coin reads the fee and changes nothing; any other length reverts.
  if (bytes === 0 && tx.value === 0n) return decoded({ title: `Read the validator ${what} request fee`, summary: `Calls the ${what} request contract with nothing: it answers its current fee and changes nothing.`, decoder: 'validator_request', status: 'full', b });
  if (bytes !== expected) {
    b.warn('danger', 'validator_request_malformed', `The contract takes exactly ${expected} bytes (${withdrawal ? "a validator's 48-byte public key and an 8-byte amount" : "two validators' 48-byte public keys"}); this sends ${bytes}, and reverts.`);
    return decoded({ title: `A validator ${what} request the contract rejects`, summary: `Calls the ${what} request contract with calldata it doesn't take.`, decoder: 'validator_request', status: 'partial', b, assetChanges: out });
  }

  // The fee: read from the contract, which takes at least that and keeps all that is sent.
  let fee: bigint | undefined;
  const rpc = env.deps.rpc;
  if (rpc?.has(tx.chainId)) {
    try { const answer = String(await rpc.call(tx.chainId, 'eth_call', [{ to, data: '0x' }, readsAt(env)])); if (/^0x[0-9a-f]{64}$/i.test(answer)) fee = BigInt(answer); } catch { fee = undefined; }
  }
  b.detail('Fee sent', `${eth(tx.value)}${fee !== undefined ? ` (the fee is ${eth(fee)} now)` : ''}`, tx.value.toString());
  if (tx.value === 0n || (fee !== undefined && tx.value < fee)) b.warn('danger', 'validator_request_fee', `This sends ${eth(tx.value)} with the request, ${fee !== undefined ? `less than the fee now (${eth(fee)})` : 'and the fee is never less than 1 wei'}: the contract reverts.`);
  else if (tx.value - (fee ?? 0n) > OVERPAID) b.warn('caution', 'validator_request_overpays', `This sends ${eth(tx.value)} with the request${fee !== undefined ? `, where the fee is ${eth(fee)} now` : ' (the fee is a few wei when few requests are queued)'}: the contract keeps all of it. What is over the fee isn't returned.`);
  else if (fee !== undefined && fee > 0n && tx.value < fee * 2n && fee > 1000n) b.note(`The fee rises with the requests queued: if it passes ${eth(tx.value)} before this is included, the contract reverts.`);

  const from = shortAddress(tx.from.toLowerCase());
  const authorized = `The consensus layer acts on it only if ${from} is the validator's withdrawal address (the address its withdrawal credentials name): from any other account the request is taken here, its fee kept, and nothing happens. Whether it is isn't read here: validators live on the consensus layer.`;
  if (withdrawal) {
    const key = `0x${h.slice(0, 96)}`, gwei = BigInt(`0x${h.slice(96, 112)}`);
    b.detail('Validator public key', key, key);
    if (gwei === 0n) {
      b.detail('Request', 'a full exit (amount 0)');
      b.warn('caution', 'validator_exit', `This asks for validator ${shortKey(key)} to exit: it stops validating for good, and its whole balance is paid out to its withdrawal address. An exit can't be undone.`);
      b.note(authorized);
      return decoded({ title: `Request the exit of validator ${shortKey(key)}`, summary: `Asks the consensus layer to exit validator ${shortKey(key)} and pay its balance out to its withdrawal address.`, decoder: 'validator_request', status: 'full', b, assetChanges: out });
    }
    const amount = `${formatUnits(gwei, 9)} ETH`;
    b.detail('Request', `withdraw ${amount}`, (gwei * GWEI).toString());
    b.note(`A partial withdrawal: paid to the validator's withdrawal address from what it holds above 32 ETH, and less than asked if less is there. Only a validator with compounding credentials (0x02) takes one. ${authorized}`);
    return decoded({ title: `Request a withdrawal of ${amount} from validator ${shortKey(key)}`, summary: `Asks the consensus layer to pay ${amount} of validator ${shortKey(key)}'s balance out to its withdrawal address.`, decoder: 'validator_request', status: 'full', b, assetChanges: out });
  }
  const source = `0x${h.slice(0, 96)}`, target = `0x${h.slice(96, 192)}`;
  if (source === target) {
    b.detail('Validator public key', source, source).detail('Request', 'switch to compounding credentials (the same validator as source and target)');
    b.warn('info', 'validator_compounding', `This switches validator ${shortKey(source)} to compounding credentials (0x02): its rewards stay staked, up to 2,048 ETH, instead of being paid out as they come. Its withdrawal address stays what it is. It can't be switched back.`);
    b.note(authorized);
    return decoded({ title: `Switch validator ${shortKey(source)} to compounding`, summary: `Asks the consensus layer to give validator ${shortKey(source)} compounding withdrawal credentials.`, decoder: 'validator_request', status: 'full', b, assetChanges: out });
  }
  b.detail('Source validator', source, source).detail('Target validator', target, target);
  b.warn('danger', 'validator_consolidation', `This moves validator ${shortKey(source)}'s whole balance into validator ${shortKey(target)}, and the source exits. From then on the stake is paid out to the target validator's withdrawal address: the consensus layer checks that ${from} is the source's withdrawal address, and not that the target's is the same. Do this only if the target validator is yours. It can't be undone.`);
  b.note(`${authorized} The target must have compounding credentials (0x02), or nothing happens.`);
  return decoded({ title: `Consolidate validator ${shortKey(source)} into ${shortKey(target)}`, summary: `Asks the consensus layer to move validator ${shortKey(source)}'s balance into validator ${shortKey(target)}.`, decoder: 'validator_request', status: 'full', b, assetChanges: out });
};
