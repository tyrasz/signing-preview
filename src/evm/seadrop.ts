// OpenSea's SeaDrop (one contract on every chain here): NFT mints, public, allow-listed, signed or token-gated. The
// payment is the value sent; the drop's own price is read on-chain when the RPC can, so overpaying shows.
import { decodeFunctionData, parseAbi } from 'viem';
import { formatUnits, PreviewBuilder, sameAddress, shortAddress } from '../format.ts';
import { CHAINS } from '../chains.ts';
import { collectionLabel } from './effects.ts';
import { decoded, type Adapter } from './common.ts';

const SEADROP = '0x00005ea00ac477b1030ce78506496e8c2de24bf5';
const MINT_PARAMS = '(uint256 mintPrice, uint256 maxTotalMintableByWallet, uint256 startTime, uint256 endTime, uint256 dropStageIndex, uint256 maxTokenSupplyForStage, uint256 feeBps, bool restrictFeeRecipients) mintParams';
const ABI = parseAbi([
  'function mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity) payable',
  `function mintAllowList(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity, ${MINT_PARAMS}, bytes32[] proof) payable`,
  `function mintSigned(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity, ${MINT_PARAMS}, uint256 salt, bytes signature) payable`,
  'function mintAllowedTokenHolder(address nftContract, address feeRecipient, address minterIfNotPayer, (address allowedNftToken, uint256[] allowedNftTokenIds) mintParams) payable',
]);
const ZERO = '0x0000000000000000000000000000000000000000';

export const seaDropAdapter: Adapter = async (tx, env) => {
  if (!tx.to || tx.to.toLowerCase() !== SEADROP) return null;
  let call;
  try { call = decodeFunctionData({ abi: ABI, data: tx.data }); } catch { return null; }
  const [nft, feeRecipient, minterIfNotPayer] = call.args as unknown as readonly [string, string, string];
  const params = call.functionName === 'mintAllowList' || call.functionName === 'mintSigned' ? call.args[4] as { mintPrice: bigint } : undefined;
  const quantity = call.functionName === 'mintAllowedTokenHolder' ? BigInt((call.args[3] as { allowedNftTokenIds: readonly bigint[] }).allowedNftTokenIds.length) : call.args[3] as bigint;
  const chain = CHAINS[tx.chainId];
  const eth = (v: bigint) => `${formatUnits(v, chain?.nativeDecimals ?? 18)} ${chain?.nativeSymbol ?? 'ETH'}`;
  const { label } = await collectionLabel(env.deps, tx.chainId, nft);
  const b = new PreviewBuilder().detail('Contract', `SeaDrop (${tx.to})`, tx.to).detail('Collection', `${label} (${nft.toLowerCase()})`, nft.toLowerCase())
    .detail('Quantity', quantity.toString()).detail('You pay', eth(tx.value), tx.value.toString()).detail('Mint stage', { mintPublic: 'public', mintAllowList: 'allow list', mintSigned: 'signed', mintAllowedTokenHolder: 'token holders' }[call.functionName]);
  const minter = /^0x0{40}$/.test(minterIfNotPayer) ? tx.from : minterIfNotPayer.toLowerCase();
  if (!sameAddress(minter, tx.from)) {
    b.detail('NFTs go to', minter);
    b.warn('caution', 'recipient_not_sender', `The minted NFTs go to ${shortAddress(minter)}, not to you: you pay for someone else's mint.`);
  }
  // The price per NFT: the signed or allow-list stage's, or the public drop's read from SeaDrop.
  let price = params?.mintPrice;
  if (price === undefined && call.functionName === 'mintPublic' && env.deps.rpc?.has(tx.chainId)) {
    try { price = BigInt(`0x${String(await env.deps.rpc.call(tx.chainId, 'eth_call', [{ to: SEADROP, data: `0xbc6a629c${nft.slice(2).toLowerCase().padStart(64, '0')}` }, 'latest'])).slice(2, 66)}`); } catch { price = undefined; }
  }
  if (price !== undefined) {
    b.detail('Price per NFT', eth(price));
    if (tx.value > price * quantity) b.warn('caution', 'mint_overpay', `This sends ${eth(tx.value)}, more than the drop's price for ${quantity} (${eth(price * quantity)}).`);
  }
  if (!/^0x0{40}$/.test(feeRecipient)) b.detail('Fee recipient', feeRecipient);
  return decoded({ title: `Mint ${quantity} ${label}${tx.value > 0n ? ` for ${eth(tx.value)}` : ''} (SeaDrop)`, summary: `Mints ${quantity} NFT${quantity === 1n ? '' : 's'} from ${label} through OpenSea's SeaDrop${tx.value > 0n ? `, paying ${eth(tx.value)}` : ''}.`, decoder: 'seadrop_mint', status: 'full', b });
};
