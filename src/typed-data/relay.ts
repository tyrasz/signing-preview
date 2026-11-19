// Relay's gasless swaps and bridges (RelayApprovalProxy 3.1, verified on Sourcify; the same address and code on every
// chain here). The user signs one of two messages, and a relayer submits it:
//   - a Permit2 PermitBatchWitnessTransferFrom with the spender the proxy and a RelayerWitness(address relayer,
//     uint256 msgValue, address refundTo, address nftRecipient, bytes metadata, Call3Value[] call3Values) witness
//     (permit2TransferAndMulticall);
//   - a MulticallAuthorization under the proxy's own domain ("RelayApprovalProxy", "3.1"), whose digest is the nonce of
//     the USDC authorizations that fund it (permit3009TransferAndMulticall).
// Either moves the tokens into Relay's router, which makes exactly the calls signed
// (Call3Value(address target,bool allowFailure,uint256 value,bytes callData)), then sends what is left to refundTo.
// Only the relayer named can submit it (the proxy hashes msg.sender in). The calls decide where the tokens go, so
// they are read here, each as the account's own transaction: the router makes them for it.
import { formatUnits, PreviewBuilder, sameAddress, shortAddress } from '../format.ts';
import { chainName } from '../chains.ts';
import { relayCalls } from '../evm/relay.ts';
import { big, domainChainId, str, type TypedAdapter } from './common.ts';

export { relayCalls };
const WITNESS_FIELDS = 'address relayer,uint256 msgValue,address refundTo,address nftRecipient,bytes metadata,Call3Value[] call3Values';
const CALL_FIELDS = 'address target,bool allowFailure,uint256 value,bytes callData';
const MULTICALL_FIELDS = 'address from,address relayer,uint256 msgValue,address refundTo,address nftRecipient,bytes metadata,uint256 fundingIndex,Call3Value[] calls,FundingAuthorization[] funding';
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const fields = (types: Record<string, { name: string; type: string }[]>, name: string) => types[name]?.map(f => `${f.type} ${f.name}`).join(',');

/** Whether typed data's witness is Relay's. */
export const isRelayWitness = (types: Record<string, { name: string; type: string }[]>) => fields(types, 'RelayerWitness') === WITNESS_FIELDS && fields(types, 'Call3Value') === CALL_FIELDS;

/** The MulticallAuthorization a USDC-funded Relay request is signed with. */
export const relayMulticallAdapter: TypedAdapter = async (data, env) => {
  if (data.primaryType !== 'MulticallAuthorization' || str(data.domain.name) !== 'RelayApprovalProxy') return null;
  if (fields(data.types, 'MulticallAuthorization') !== MULTICALL_FIELDS || fields(data.types, 'Call3Value') !== CALL_FIELDS) return null;
  const m = data.message, chainId = domainChainId(data);
  const from = str(m.from).toLowerCase(), proxy = str(data.domain.verifyingContract).toLowerCase();
  if (!ADDRESS.test(from)) return null;
  const b = new PreviewBuilder().detail('Account', from).detail('Proxy', proxy);
  if (env.signer && !sameAddress(env.signer, from)) b.warn('caution', 'relay_other_account', `It authorizes calls for ${shortAddress(from)}, but ${shortAddress(env.signer)} is asked to sign it.`);
  // What funds it: the USDC authorizations signed alongside, each with this message's digest as its nonce.
  const funding = Array.isArray(m.funding) ? m.funding as Record<string, unknown>[] : [];
  for (const [i, f] of funding.entries()) {
    const tokenAddress = str(f.token).toLowerCase(), value = big(f.value);
    let info: { symbol: string; decimals: number } | undefined;
    try { info = chainId !== null && ADDRESS.test(tokenAddress) ? (await env.deps.tokens?.get(chainId, tokenAddress)) ?? undefined : undefined; } catch { info = undefined; }
    b.detail(`Funding ${i + 1}`, value === null ? str(f.value) : info ? `${formatUnits(value, info.decimals)} ${info.symbol}` : `${value} base units of ${shortAddress(tokenAddress)}`, tokenAddress);
  }
  const titles = await relayCalls(m, m.calls, env, chainId, from, b, proxy);
  if (!titles) return null;
  b.note('An off-chain signature: it costs nothing now. The relayer named submits it with the USDC authorizations that fund it.');
  return {
    title: `Relay: let its router make ${titles.length === 1 ? 'a call' : `${titles.length} calls`} with your tokens: ${titles.slice(0, 3).join('; ')}${titles.length > 3 ? '; …' : ''}`,
    summary: `A Relay request: the USDC you authorize goes to Relay's router, which makes the ${titles.length} signed call${titles.length === 1 ? '' : 's'} for you and sends what is left to ${shortAddress(str(m.refundTo))}.`,
    decoder: 'relay_multicall', status: 'full', b, network: chainId !== null ? { kind: 'evm', chainId, name: chainName(chainId) } : null,
  };
};
