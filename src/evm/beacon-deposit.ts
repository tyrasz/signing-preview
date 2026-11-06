// Ethereum's beacon-chain deposit contract: deposit(pubkey, withdrawal_credentials, signature, deposit_data_root)
// stakes the ETH sent for a validator. What matters most is who can withdraw it: the withdrawal credentials. An
// execution address (types 0x01 and 0x02) receives the stake when it is withdrawn, so a deposit naming someone else's
// address hands them the ETH; that is how fake staking sites take deposits. The checks below follow the verified
// contract (deposit_contract.sol on Sourcify): lengths, amount, and the DepositData root it recomputes and requires.
import { concatHex, decodeFunctionData, parseAbi, sha256, type Hex } from 'viem';
import { formatUnits, PreviewBuilder, sameAddress, shortAddress } from '../format.ts';
import { decoded, type Adapter } from './common.ts';

export const BEACON_DEPOSIT_CONTRACT = '0x00000000219ab540356cbb839cbe05303d7705fa';
const ABI = parseAbi(['function deposit(bytes pubkey, bytes withdrawal_credentials, bytes signature, bytes32 deposit_data_root) payable']);
const GWEI = 10n ** 9n, ETH = 10n ** 18n;
const zeros = (n: number) => `0x${'00'.repeat(n)}` as Hex;

/** The 64-bit little-endian gwei amount, as to_little_endian_64. */
function le64(v: bigint): Hex {
  let hex = '';
  for (let i = 0; i < 8; i++) hex += ((v >> BigInt(8 * i)) & 0xffn).toString(16).padStart(2, '0');
  return `0x${hex}`;
}

/** DepositData's hash tree root, exactly as the contract recomputes it before accepting a deposit. */
export function depositDataRoot(pubkey: Hex, credentials: Hex, signature: Hex, gwei: bigint): Hex {
  const pubkeyRoot = sha256(concatHex([pubkey, zeros(16)]));
  const sig = signature.slice(2);
  const signatureRoot = sha256(concatHex([sha256(`0x${sig.slice(0, 128)}`), sha256(concatHex([`0x${sig.slice(128)}`, zeros(32)]))]));
  return sha256(concatHex([sha256(concatHex([pubkeyRoot, credentials])), sha256(concatHex([le64(gwei), zeros(24), signatureRoot]))]));
}

export const beaconDepositAdapter: Adapter = async (tx, env) => {
  if (tx.chainId !== 1 || tx.to?.toLowerCase() !== BEACON_DEPOSIT_CONTRACT) return null;
  let call;
  try { call = decodeFunctionData({ abi: ABI, data: tx.data }); } catch { return null; }
  const [pubkey, credentials, signature, root] = call.args;
  const b = new PreviewBuilder().detail('Contract', `Ethereum staking deposit contract (${BEACON_DEPOSIT_CONTRACT})`, BEACON_DEPOSIT_CONTRACT);
  const amount = `${formatUnits(tx.value, 18)} ETH`;
  const key = pubkey.toLowerCase();
  b.detail('You stake', amount).detail('Validator public key', key);
  const fail = (code: string, message: string) => b.warn('danger', code, `The deposit contract will reject this: ${message}`);

  // Who can withdraw: the credentials' first byte says how.
  const type = credentials.length === 66 ? credentials.slice(2, 4) : null;
  let withdrawTo: string | null = null;
  if (type === '01' || type === '02') {
    withdrawTo = `0x${credentials.slice(26)}`.toLowerCase();
    const mine = sameAddress(withdrawTo, tx.from);
    b.detail('Withdrawals go to', `${mine ? `you (${withdrawTo})` : withdrawTo}, ${type === '02' ? 'compounding credentials (0x02)' : 'execution address (0x01)'}`, withdrawTo);
    if (!mine) {
      let contract = false;
      try { contract = env.deps.rpc?.has(1) ? String(await env.deps.rpc.call(1, 'eth_getCode', [withdrawTo, 'latest'])) !== '0x' : false; } catch { contract = false; }
      b.warn('caution', 'staking_withdrawal_other', `When this stake is withdrawn, the ETH goes to ${shortAddress(withdrawTo)}${contract ? ' (a contract)' : ''}, not to you, and that can't be changed later. Only sign if ${shortAddress(withdrawTo)} is yours or a staking provider's contract you chose.`);
    }
  } else if (type === '00') {
    b.detail('Withdrawals', 'set by a BLS withdrawal key (0x00 credentials)');
    b.warn('caution', 'staking_bls_credentials', "These credentials name no withdrawal address: whoever holds the matching BLS withdrawal key decides later where the stake goes. Make sure that's you.");
  } else if (credentials.length === 66) {
    b.warn('caution', 'staking_unknown_credentials', `The withdrawal credentials have an unknown type (0x${type}): the stake may never be withdrawable.`);
  }

  // The contract's own checks.
  if (pubkey.length !== 2 + 96) fail('deposit_invalid', 'the validator public key must be 48 bytes.');
  else if (credentials.length !== 2 + 64) fail('deposit_invalid', 'the withdrawal credentials must be 32 bytes.');
  else if (signature.length !== 2 + 192) fail('deposit_invalid', 'the signature must be 96 bytes.');
  else if (tx.value < ETH) fail('deposit_invalid', 'a deposit must be at least 1 ETH.');
  else if (tx.value % GWEI !== 0n) fail('deposit_invalid', 'the amount must be a whole number of gwei.');
  else if (depositDataRoot(pubkey, credentials, signature, tx.value / GWEI) !== root.toLowerCase()) fail('deposit_root_mismatch', "the deposit data root doesn't match the key, credentials, amount and signature (the contract recomputes it).");
  else b.detail('Deposit data root', 'matches the deposit (as the contract checks)', root);

  b.note("The validator's signature isn't checked here, nor whether the key is already a validator (a top-up). The beacon chain ignores a new validator's deposit with an invalid signature, and that ETH can't be recovered.");
  if (tx.value === 32n * ETH) b.note('32 ETH is a full validator deposit.');
  return decoded({
    title: `Stake ${amount} for validator ${key.slice(0, 10)}…${key.slice(-4)}`,
    summary: `Deposits ${amount} into Ethereum's staking deposit contract for validator ${key.slice(0, 10)}…${withdrawTo ? `; withdrawals go to ${sameAddress(withdrawTo, tx.from) ? 'you' : shortAddress(withdrawTo)}` : ''}.`,
    decoder: 'beacon_deposit', status: 'full', b,
    assetChanges: tx.value > 0n ? [{ direction: 'out', account: tx.from, amount: formatUnits(tx.value, 18), symbol: 'ETH', raw: tx.value.toString(), asset: 'native', basis: 'requested', standard: 'native' }] : [],
  });
};
