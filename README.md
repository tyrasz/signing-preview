# signing-preview

[![CI](https://github.com/tyrasz/signing-preview/actions/workflows/ci.yml/badge.svg)](https://github.com/tyrasz/signing-preview/actions/workflows/ci.yml) [![Live verification](https://github.com/tyrasz/signing-preview/actions/workflows/verify-live.yml/badge.svg)](https://github.com/tyrasz/signing-preview/actions/workflows/verify-live.yml)

Turns any wallet signing request into a human-readable preview before the user signs. It covers Ethereum, Arbitrum One, HyperEVM (chain 999) and Hyperliquid's native HyperCore actions, with special handling for Arbitrum → Hyperliquid deposits; transactions on Base, OP Mainnet, Polygon and BNB Chain are simulated too, with their network fees.

It takes a standard EIP-1193 request (`{ method, params }`), the same object every dApp sends to every wallet. It returns plain JSON that any wallet, extension or backend can render.

```
"Withdraw 50 USDC to Arbitrum"
Withdraws 50 USDC from Hyperliquid to your address on Arbitrum One (a 1 USDC fee is deducted).
  You receive on Arbitrum (approx.)   49 USDC
```

This project started in [tyrasz/transaction-lab](https://github.com/tyrasz/transaction-lab) but shares no code with it.

## Quickstart

**Use it in your project.** The package isn't on npm yet; it installs straight from GitHub, which builds it on install:

```bash
npm install github:tyrasz/signing-preview
```

```bash
npx signing-preview
```

The second command starts the HTTP API and demo, with mock data unless `SIGNING_PREVIEW_MODE=live` is set. Installed packages need Node.js 22 or later.

**Work on it.** Developing needs Node.js 22.18 or later, which runs the TypeScript sources directly.

```bash
npm install
```

```bash
npm start
```

Open http://127.0.0.1:8787. The demo is a mock dApp sending requests to a mock wallet that is wrapped with the interceptor. Every balance, price and account in the demo is **mock data** (see `mocks/data.ts`).

```bash
npm test
```

```bash
npm run typecheck
```

## Using it from any wallet or extension

There are three ways to integrate, all producing the same `Preview` JSON.

**1. HTTP API.** Works from anywhere: wallet backends, extensions, mobile apps.

```bash
curl -s localhost:8787/v1/preview -H 'content-type: application/json' -d '{
  "request": { "method": "eth_sendTransaction", "params": [{ "from": "0xa11ce00000000000000000000000000000000001",
    "to": "0xaf88d065e77c8cc2239327c5edb3a432268e5831", "chainId": "0xa4b1",
    "data": "0xa9059cbb0000000000000000000000002df1c51e09aecf9cacb7bc98cb1742757f163df70000000000000000000000000000000000000000000000000000000005f5e100" }] },
  "context": { "account": "0xa11ce00000000000000000000000000000000001", "origin": "https://some.dapp" }
}'
```

| Endpoint | Purpose |
|---|---|
| `POST /v1/preview` | Body `{ request, context? }` returns a `Preview`. Malformed requests return `400 INVALID_REQUEST`. |
| `GET /v1/openapi.json` | The OpenAPI 3.1 document for this API. |
| `GET /v1/health` | Liveness check. |
| `GET /v1/samples` | The demo's mock requests. |

**OpenAPI.** [`openapi.json`](openapi.json) describes the whole API in OpenAPI 3.1: every request and response schema, error codes, and two live HyperEVM examples (a HyperLend borrow and a Kinetiq stake). Load it into Swagger UI, Postman or Insomnia, or generate types or clients from it. For TypeScript types (`components['schemas']['Preview']`, `paths['/v1/preview']`):

```bash
npx openapi-typescript openapi.json -o signing-preview-api.ts
```

For other languages, [OpenAPI Generator](https://openapi-generator.tech) builds clients for Python, Go, Kotlin, Swift and more; it needs Java.

The document is hand-written and tested against the code:
- `test/openapi.test.ts` validates it against the OpenAPI 3.1 meta-schema.
- Every sample request goes through the real HTTP server, and each response must match the `Preview` schema exactly. Undocumented fields fail the test.
- Every error response is checked too.
- The `Preview` format is versioned by its `schema` field (`signing-preview/1`). New optional fields can appear within a version.

CORS defaults to `*`, so pages, extensions (`chrome-extension://…`) and apps can all call it. Set `CORS_ORIGIN` to restrict it. The API never signs anything. Its outbound calls go only to the RPC and Hyperliquid URLs configured on the server; callers can't supply URLs.

**2. EIP-1193 interceptor (browser, no dependencies).** Wrap whichever provider you have: `window.ethereum`, an EIP-6963 provider, or a WalletConnect provider. Every signing request is previewed, and the request is only forwarded to the wallet if `confirm` resolves `true`. A rejection throws the standard EIP-1193 `4001` error, and other methods pass through untouched.

```js
import { withSigningPreview, remotePreview } from './dist/interceptor.js';

const provider = withSigningPreview(window.ethereum, {
  preview: remotePreview('https://your-host/v1/preview'),
  confirm: async (preview) => showMyDialog(preview),   // resolve true to sign
});
// Hand `provider` to viem/ethers/wagmi as usual.
```

The interceptor fills in `chainId` and `account` with the non-prompting `eth_chainId` and `eth_accounts` calls. If the preview service fails, `confirm` still receives an explicit "Preview unavailable" preview; the request is never forwarded silently.

**3. In-process library.** For a wallet, extension or backend that runs the previewer itself, without the API. The package ships compiled ES modules with TypeScript declarations:

```ts
import { previewRequest, StaticTokenRegistry, HttpHyperliquidInfo, RpcSimulator, JsonRpcClient } from 'signing-preview';

const preview = await previewRequest(request, { chainId: 42161, account, origin }, {
  tokens: new StaticTokenRegistry(),
  hyperliquid: { mainnet: new HttpHyperliquidInfo() },
  simulator: new RpcSimulator({ 1: ETH_RPC, 42161: ARB_RPC }),   // optional
  rpc: new JsonRpcClient({ 999: HYPEREVM_RPC }),                 // optional: live protocol state (HyperLend, Kinetiq)
});
```

Or take the same set-up as the server's live mode:

```ts
import { liveDependencies } from 'signing-preview/server';
const deps = liveDependencies({ ARBITRUM_RPC_URL, HYPEREVM_RPC_URL });
```

| Import | Contents | Runs in |
|---|---|---|
| `signing-preview` | `previewRequest`, registries, simulators, ABI and signature sources, all types | Node and browsers |
| `signing-preview/interceptor` | `withSigningPreview`, `remotePreview` | Browsers (no dependencies) |
| `signing-preview/server` | `createPreviewServer`, `liveDependencies`, `openApiDocument` | Node |
| `signing-preview/openapi.json` | The OpenAPI document | anywhere |
| `npx signing-preview` | The HTTP API and demo | Node |

`dist/signing-preview.js` and `dist/interceptor.js` are browser bundles of the same code, included in the package, for pages that load scripts directly.

`npm run check:package`, which also runs in CI, packs the library and installs the tarball into a fresh project. There it imports it from plain JavaScript, type-checks a TypeScript consumer against the published declarations, and starts the `signing-preview` command.

**Publishing to npm.** This is the maintainer's call. Choose the package name (`signing-preview`, or a scope such as `@tyrasz/signing-preview`), remove `"private": true` from `package.json`, and run `npm publish`. The `prepare` script builds the library and bundles first.

## What is decoded

| Flow | Request | Shown |
|---|---|---|
| Arbitrum → Hyperliquid, **Bridge2** | USDC `transfer` to `0x2df1…3df7` | Deposit amount and the credited Hyperliquid account. **Danger** below 5 USDC (funds lost), for a non-USDC token, or on the wrong chain. |
| Arbitrum → HyperCore, **Circle CCTP** (Circle's guide) | 1. `ReceiveWithAuthorization` signature on USDC; 2. `CctpExtension.batchDepositForBurnWithAuth` | Amount, batch split, HyperCore recipient, perps/spot, fee cap, guaranteed minimum and expected credit (0.20 USDC forwarding fee). **Danger** for every mistake that leaves funds stuck (see [Circle CCTP accuracy](#circle-cctp-accuracy)). |
| Ethereum/Arbitrum → HyperCore, **CCTP V2** | `TokenMessengerV2.depositForBurnWithHook` / `depositForBurn` | Same checks; plain CCTP transfers to any other domain are decoded too. Mainnets plus Ethereum Sepolia and Arbitrum Sepolia (→ HyperEVM testnet). |
| HyperCore → Arbitrum (and other chains), **Circle CCTP** | `SendToEvmWithData` with USDC (Circle's "Withdraw USDC from HyperCore to EVM chains") | Destination as a **CCTP domain** (3 = Arbitrum, not an EVM chain ID), automatic vs manual delivery, the live per-destination fee (Arbitrum/Base 0.20, Ethereum 1.20, Solana 0.50 USDC; 0 without forwarding), amount received and withdrawable balance. **Danger** when the HyperEVM step would revert: amount not above the fee, invalid domain, or data over 1,024 bytes. |
| HyperCore → Arbitrum, **Hyperliquid Withdraw** | `Withdraw` (withdraw3) | Arbitrum recipient, the 1 USDC fee, amount received and withdrawable perps balance. |
| HyperCore → HyperEVM | `SendAsset` / `SpotSend` to a system address (Circle's "Withdraw USDC from HyperCore to HyperEVM") | "Move X to HyperEVM", credited to the same address. **Danger** on a system address that doesn't match the token. |
| HyperEVM → HyperCore, **Circle CoreDepositWallet** | `deposit` / `depositFor` / `depositWithAuth` on HyperEVM | Amount, HyperCore recipient and perps/spot. **Danger** for a plain token transfer to the CoreDepositWallet, which Circle says leaves the funds permanently stuck. |
| HyperEVM → other chains, **CCTP** | `TokenMessengerV2.depositForBurn(WithHook)` on HyperEVM | Amount, destination, recipient and whether delivery is automatic or manual. |
| Sponsored HyperCore deposits | `ReceiveWithAuthorization` to `CctpExtensionV2` | Recognised, with a caution that the recipient is bound into the nonce and can't be shown. |
| USDC gasless transfers | EIP-3009 `TransferWithAuthorization` / `ReceiveWithAuthorization` / `CancelAuthorization` | Amount, spender/recipient, validity window; warns that a transfer authorization works like sending the payment. |
| HyperCore **user-signed** actions | `eth_signTypedData_v4`, `HyperliquidSignTransaction` domain | All 17 types in `@nktkas/hyperliquid` 0.33.3: `Withdraw` (net of the 1 USDC fee), `UsdSend`, `SpotSend` (including HyperCore → HyperEVM via system address), `UsdClassTransfer`, `SendAsset`, `SendToEvmWithData`, `ApproveAgent`, `ApproveBuilderFee`, `TokenDelegate`, `CDeposit`/`CWithdraw`, `UserSetAbstraction`, `UserDexAbstraction`, `UserPortfolioMargin`, `LinkStakingUser` (danger: the staking account can later lock this account), `StakingLinkDisableTradingUser` (danger: irreversible), `ConvertToMultiSigUser`, `SendMultiSig`; unknown types list every field. Checks: imitation domains, testnet, expired or future timestamps, a token ID that doesn't match its label. |
| HyperCore **L1** actions | `Agent { source, connectionId }`, `Exchange` domain | **When the original action is supplied** (see below): orders (limit, trigger TP/SL, builder fee), cancels, modify, leverage, isolated margin, top-up margin, TWAP, scheduled cancel, borrow/lend, vault create/modify/distribute/transfer, sub-account transfers (USDC and spot), rename, rewards, referrals, display name, spot dusting, HyperEVM block size. Markets are resolved on main perps, spot, **HIP-3 builder DEXes** and **outcome markets**. Perp orders are margin-checked on their own DEX (skipped for unified/portfolio-margin accounts); spot orders are checked against spot balances. Deployer, validator, agent and outcome-share actions are decoded too, with warnings for oracle updates, trading halts, fee-recipient and permission changes, market settlement, HYPE-spending auctions and backstop-liquidator deposits. |
| HyperEVM, **Kinetiq** liquid staking | kHYPE, and asxnHYPE (an institutional deployment whose StakingManager and StakingAccountant run the same code as kHYPE's, checked by code hash; read under its own symbol): `stake`, `queueWithdrawal`, `confirmWithdrawal` / `batchConfirmWithdrawals`, `instantUnstake`, `redelegate` on the StakingManager | "Stake 10 HYPE for ≈ 9.7315 kHYPE", "Unstake 100 kHYPE: ≈ 102.759 HYPE claimable in 7 days", "Instant unstake … for ≈ X HYPE (0.1% fee)". With an RPC, live values: rate, fees, delays (7 days, or 36 hours when Kinetiq's buffer covers it), Kinetiq's own instant-unstake quote, and when each queued withdrawal becomes claimable. **"This will fail"** for a stake below the minimum (5 HYPE), an amount that isn't a multiple of 0.00000001 HYPE (HyperCore keeps 8 decimals), paused staking or withdrawals, a claim that isn't ready, an empty instant-unstake buffer or a quote below your minimum. |
| HyperEVM, **HyperLend** | Pool `supply`, `withdraw`, `borrow`, `repay` (and `…WithPermit`, `repayWithATokens`), collateral and e-mode switches, `approvePositionManager`, `liquidationCall`; the native-HYPE gateway | Plain-language actions ("Borrow 3,000 USDC from HyperLend", "Withdraw all your WHYPE"), "all" for max amounts, and the **health factor before → after**, from your live position, oracle prices and each market's liquidation threshold (e-mode aware). **Danger** below 1.1; **caution** below 1.5; **"this will fail"** when HyperLend would refuse (borrowing beyond the limit, leaving HF < 1). **Caution** for a position manager, which can switch your collateral and e-mode. Gateway calls are trusted only when the contract's verified source is a WrappedTokenGateway pointing at HyperLend's Pool. |
| HyperEVM, **HyperLend isolated pools** | The pairs in HyperLend's PairRegistry (Fraxlend-style, ERC-4626 for lenders; four on 2026-11-06: WHLP, xHYPE (two) and kmHYPE collateral; later ones read from the registry): `deposit`, `mint`, `withdraw`, `redeem`, `borrowAsset`, `addCollateral`, `removeCollateral`, `repayAsset`, `leveragedPosition`, `repayAssetWithCollateral`, `liquidate` | "Borrow 2,000 USDC, adding 100 xHYPE as collateral (HyperLend isolated xHYPE → USDC)", "Lend 1.7152 WHYPE (HyperLend isolated kmHYPE → WHYPE)", with the pool's maximum LTV. **Caution** when the proceeds go to another address and for a leveraged position; information when collateral backs someone else's loan. From hyperlendx/hyperlend-isolated and the addresses on docs.hyperlend.finance. All 8 direct calls to the pairs in 40,000 recent blocks (7 withdrawals, 1 deposit) decode, with the amount and token their receipts show, 8 of 8. |
| Credit delegation (HyperLend, any Aave-style market) | `approveDelegation` on a debt token; `DelegationWithSig` signatures | **Danger**: the delegatee can borrow in your name, against your collateral, and the debt is yours. Named as HyperLend when the debt token's Pool is HyperLend's and lists it. |
| HyperEVM → HyperCore | CoreWriter `sendRawAction` | All CoreWriter actions (IDs 1–13 and 15–17), with 1e8 price/size scaling. Notes that HyperCore runs the action asynchronously, so a failure there doesn't revert the EVM transaction, and checks the action against the sender's live HyperCore account: spot sends, lending supply and staking deposits against the free spot balance (less what orders hold), USDC class transfers and vault deposits against what's withdrawable, delegating and unstaking against the undelegated stake, undelegating against what's delegated to that validator and its one-day lock-up, and orders against the available margin. **Caution** when HyperCore will reject it. Actions that contracts send through CoreWriter inside a transaction (a vault, a router, a smart account's batch) are listed from the simulation's `RawAction` events, with the same checks against the account they run on. |
| HyperEVM → HyperCore | HYPE to `0x2222…`, ERC-20 to `0x20…<index>` | "Move X to HyperCore". **Danger** if the token isn't the contract linked to that index. |
| Ethereum / Arbitrum / HyperEVM | ERC-20 transfer/approve/transferFrom, `setApprovalForAll`, WETH, Permit2 `approve`, native sends, contract creation | Amounts with the token's symbol and decimals. Warns on unlimited approvals, zero-value transfers and transfers to the token contract itself. |
| Off-chain approvals | ERC-2612 / DAI `Permit`, Permit2 `PermitSingle/Batch/TransferFrom` | Spender, amount and expiry; flags unlimited or long-lived permissions and owner mismatches. |
| Messages | `personal_sign`, SIWE, `eth_sign` | Readable text; SIWE domain vs. requesting origin (phishing); `eth_sign` is always danger, except for the hash of a UserOperation supplied with it ([below](#useroperations-signed-as-a-hash-entrypoint-v06-and-v07)). |
| Off-chain swap orders | CoW Protocol `Order` (domain "Gnosis Protocol" v2), 1inch limit orders (domain "1inch Aggregation Router" v6), UniswapX orders carried as a Permit2 witness (Dutch, V2/V3 Dutch, priority) | "Sell 1,000 USDC for at least 0.3 WETH (CoW Swap)", "Sell 1 WETH for 3,500 USDC (1inch limit order)", "Swap 1,000 USDC for at least 0.295 WETH (UniswapX)" (the least each output can decay to, with fee outputs listed), with expiry and fee. **Danger** for an order that sells for nothing; **caution** when the proceeds go to another address, when the maker isn't the signer, and for a verifying contract that isn't the protocol's. Type definitions checked against CoW's source and 1inch's `OrderLib`, and the 1inch domain against the router's `eip712Domain()`. |
| Arbitrum-style inboxes | `sendL2Message` on any inbox (Arbitrum One's on Ethereum; Orbit chains' on their parent, such as chain 99901's on HyperEVM, the contract with the most distinct senders there in a 400-block sample) | "Send a transaction to chain 99901 through its inbox (to 0xb0b0…0002)": the signed child-chain transaction it delivers (to, value, calldata, nonce) and its signer, recovered from the signature. Information when it relays someone else's transaction. |
| Ethereum staking deposits | `deposit` on the beacon-chain deposit contract (`0x0000…7705fa`) | "Stake 32 ETH for validator 0xa7fb502d…cc35", with who can withdraw the stake: the execution address of 0x01 and 0x02 credentials ("you", or another address), or a BLS withdrawal key (0x00). **Caution** when withdrawals go to an address other than the sender (the stake is theirs when withdrawn, and the credentials can't be changed: how fake staking sites take deposits) and for BLS credentials; **danger** for a deposit the contract will reject: wrong lengths, under 1 ETH, not a whole number of gwei, or a `deposit_data_root` that doesn't match. The root is recomputed as the verified contract does (DepositData's SSZ root, with SHA-256): on all 163 deposits sent to the contract in 7,000 recent blocks it matched. The validator's BLS signature isn't checked. |
| Relay | Relay's `RelayDepository` (the same contract on Ethereum, Arbitrum One and HyperEVM): `depositNative`, both `depositErc20` forms, and `execute` | "Deposit 2,400 USDT to Relay", with the request ID and who is credited; the three-argument `depositErc20` deposits the whole allowance, read from the token. Relay's solver fills the request on the destination chain from Relay's off-chain quote, so the preview says the destination, recipient and amount aren't in the transaction (Relay's API, `api.relay.link`, which would resolve them, isn't reachable from this environment). `execute` runs calls signed by Relay's allocator from the depository: "Relay payout: Send 2,724.72 USDC to you", money in when it pays the sender. **Caution** when a deposit is credited (and refunded) to another address. From the verified source on Sourcify; 171 of 171 recent Ethereum calls decode (113 deposits, 58 payouts). |
| Binance Web3 Wallet | Its swap and bridge router on Ethereum (`0xb300…028d`, an EIP-2535 diamond whose facet's source isn't published) | "Swap 1,500 USDT for at least 1,486.73 USDC (Binance Web3 Wallet)", with the fee taken from the output and the aggregator call it wraps (LI.FI, 1inch, Rango, SWFT or Binance's own). Bridges read as the wrapped LI.FI bridge ("Bridge 0.001 ETH to Arbitrum One via across (LI.FI, Binance Web3 Wallet)") or as "Send 20 USDT through RangoDiamond". The layout (fee receiver, target, input token, amount, fee and output token, minimum, call) was read from real calls and checked against their receipts: in 56 of 56 the sender paid exactly the amount shown; in 28 of 28 swaps with a token output it received at least the minimum shown; the fee matched to the basis point in 5 of 5. Marked partial, as the code is unpublished. **Caution** for a fee of 1% or more (danger at 10%) and for no slippage limit. Arbitrum's diamond runs different facet code, so it isn't decoded. |
| LI.FI | LI.FI's diamond (Ethereum and Arbitrum): every bridge facet (`startBridgeTokensVia*`, `swapAndStartBridgeTokensVia*`) through the `BridgeData` they all take first, and GenericSwapFacet V3 swaps | "Bridge 250 USDC to Arbitrum One via across (LI.FI)", "Swap and bridge 0.1 WETH to Solana via relay (LI.FI)", "Swap 0.1 WETH for at least 290 USDC (LI.FI)": the bridge, destination, amount, source swaps, integrator and recipient. **Caution** when the funds go to another address; information for non-EVM destinations (the recipient is in the bridge's own data) and destination calls. Structs from lifinance/contracts; real transactions on Ethereum decode (bridges through Relay and Across, swaps). |
| Uniswap's older routers | V2 Router02, V3 SwapRouter and SwapRouter02 (Ethereum and Arbitrum): V2 and V3 swaps, exact input and output, `multicall` with `unwrapWETH9` | "Swap 100 USDC for at least 0.03 ETH on Uniswap", "Buy 0.1 WETH for at most 400 USDC on Uniswap", summing a multicall's swaps, with pool fees and deadline. **Caution** when the output goes to another address or nothing limits slippage. On 100 sampled Ethereum swaps, the output token matched what each receipt paid the receiver. Other contracts called with these functions (forks, which HyperEVM's main DEXes are) get the same headline under their verified name when their verified ABI has the function; without one, "on a Uniswap-style router (0x…)", marked partial and cautioned, since only the contract's code decides what the call does. |
| Swap and bridge routers | 1inch Aggregation Router v6 (`swap`, the `unoswap` family, limit-order cancels; Ethereum and Arbitrum), OKX's DEX router (Ethereum and Arbitrum: `dagSwap*`, `smartSwapByOrderId`, `unxswap*`, `uniswapV3SwapTo*`), KyberSwap's MetaAggregationRouterV2 (Ethereum, Arbitrum, HyperEVM), MetaMask Swaps and Bridge routers, Across SpokePool deposits (`depositV3`, `deposit`; Ethereum, Arbitrum and HyperEVM, addresses from Across's deployment list) | "Swap 100 USDC for at least 99.8 USDT on 1inch" (for pool-only swaps the output token is read from the pools on-chain, and the last pool's unwrap flag makes it ETH: on 56 sampled 1inch and OKX swaps and 38 KyberSwap swaps, the output token matched what each receipt paid the receiver), "Swap 3,500 USDC with MetaMask Swaps (oneInchV6FeeDynamic)", "Bridge 0.5 ETH to Arbitrum One through Across" with the minimum received there and the recipient. **Caution** when the output goes to another address, when nothing limits slippage, and when an Across refund would go to someone else. These contracts' sources are verified on Etherscan but not Sourcify, so without an Etherscan key they were unreadable. |
| **Seaport** (OpenSea) order signatures | `eth_signTypedData_v4` of `OrderComponents` or `BulkOrder` (Seaport 1.1–1.6; 1.6 on Ethereum, Arbitrum and HyperEVM) | "List BAYC #42 for 9.75 ETH", "Offer 5 WETH for any BAYC", "List 3 items on Seaport": what you give, what you receive, and what else the buyer pays to whom (OpenSea's fee, royalties), with validity and conduit. **Danger** when an order gives items and nothing (or less than a millionth of a token) comes back to you, alone or hidden in a bulk listing: the NFT-drainer pattern. **Caution** when most of the payment goes elsewhere, for "any token" offers (the filler picks which of yours), validity over 180 days or forever, an offerer other than the signer, and a contract that isn't an official Seaport. The digest shown matched Seaport 1.6's own on Ethereum. |
| SeaDrop mints | OpenSea's SeaDrop (Ethereum, Arbitrum, HyperEVM): `mintPublic`, `mintAllowList`, `mintSigned`, `mintAllowedTokenHolder` | "Mint 2 BAYC for 0.02 ETH (SeaDrop)": collection, quantity, the price per NFT (the stage's, or the public drop's read on-chain), fee recipient. **Caution** when the value sent is more than the drop's price, and when the NFTs are minted to someone else. The most-used contract by distinct senders on Ethereum after USDT, USDC and the Universal Router in a 25-block sample. |
| Seaport transactions | `fulfillBasicOrder` (and `_efficient_6GL6yc`), `fulfillOrder`, `fulfillAdvancedOrder`, `fulfillAvailable(Advanced)Orders`, `match(Advanced)Orders`, `cancel`, `validate`, `incrementCounter` | From the sender's side: "Buy BAYC #42 for 10 ETH" (fees included), "Sell BAYC #42 for 4.875 WETH" (accepting an offer, fees taken out), sweeps of several orders, matched buys judged as a whole, the token actually chosen for a collection offer, cancellations ("Cancel all your Seaport orders"). Validating an order publishes it, so it gets the same drainer checks as signing one. **Caution** when the items bought go to another address. Checked on 25 recent Seaport 1.6 transactions on Ethereum. |
| **ERC-4337 UserOperations** | `eth_signTypedData_v4` of a `PackedUserOperation` (EntryPoint v0.8 and v0.9, domain `ERC4337`); `personal_sign` of a v0.6 or v0.7 operation's hash, with the operation supplied ([how](#useroperations-signed-as-a-hash-entrypoint-v06-and-v07)); transactions to an EntryPoint (v0.7–v0.9): `handleOps`, `depositTo`, `withdrawTo` | "Sign a UserOperation: Run 2 calls from your account", with the `callData` decoded as the account's own transaction (smart-account batches included), and the whole operation simulated as the EntryPoint runs it, validation, gas and paymaster included ([how](#useroperations-simulated-as-the-entrypoint-runs-them)); the account setup (already deployed, an EIP-7702 delegation, or a factory deploying it), nonce, gas limits, the most it can cost, and the paymaster that pays. **Caution** for an unknown EntryPoint, and when an EIP-7702 account's operation names a delegate the account doesn't have yet (it would only run with an authorization handing the account to that contract); information when the EntryPoint's nonce for the account is already past the operation's. The digest shown is the one the EntryPoint verifies: it matched v0.8's `getUserOpHash` on Ethereum for a plain account and for an EIP-7702 one (whose typed data, as viem builds it, carries the delegate in place of the `0x7702` marker). A bundler's `handleOps` lists each operation with its calls. |
| **Safe** (Gnosis Safe) multisig | `eth_signTypedData_v4` of a `SafeTx` (an owner's approval), and `execTransaction` | "Safe transaction: Send 1,000 USDC", "Run 18 calls from the Safe": the call (or every call of a MultiSend batch) decoded as the Safe's own transaction and simulated from the Safe; the Safe's own settings spelled out ("Add owner 0xb0b0…0002 (threshold 2)"). **Danger** for a delegatecall to anything but Safe's own libraries (MultiSend, MultiSendCallOnly, SignMessageLib, CreateCall; v1.3.0, v1.4.1 and v1.5.0 addresses from safe-global/safe-deployments; their official migration contracts are a caution): the pattern behind the 2025 Bybit theft, where owners signed a delegatecall that replaced the Safe's code. **Danger** for enabling a module; **caution** for owner and threshold changes, guards, fallback handlers, a gas refund to a named receiver, a signer who isn't an owner, and a call the simulation says fails; information when the nonce is already used. The digest shown matched a real Safe's `getTransactionHash` on Ethereum; 15 recent `execTransaction` calls there all decoded. A plain call (not a delegatecall) to MultiSendCallOnly is a **caution**: its batch would run as the MultiSend contract, not as the Safe (one real operation on Ethereum did this). |
| **Safe ERC-4337 operations** | `eth_signTypedData_v4` of a `SafeOp` (Safe4337Module v0.3.0 for EntryPoint v0.7, v0.2.0 for v0.6; the same addresses on Ethereum, Arbitrum One and HyperEVM, each checked with `SUPPORTED_ENTRYPOINT()`) | "Safe operation: Send 36,090 USDC": the module runs the operation's call with `execTransactionFromModule`, as the Safe itself, so the call is read exactly as a Safe transaction (batches, delegatecall dangers), and the whole operation is simulated through the EntryPoint and the module with the owners' approvals standing in for their signatures, the Safe's configuration compared before and after, with the validity window, gas limits, the most it can cost and the paymaster. **Caution** for a module that isn't Safe's, an `entryPoint` the module doesn't use (the signature wouldn't validate), and callData other than `executeUserOp(WithErrorString)` (the module rejects it); information when the Safe hasn't enabled the module, the operation has expired, or the EntryPoint's nonce is past it. Safe4337MultiChainSignatureModule (EntryPoint v0.9, verified on Sourcify) is read the same way; its `MerkleTreeRoot` signature, one signature for Safe operations on several chains that the message doesn't show, is **danger** unless the wallet supplies those operations ([below](#multi-chain-safe-signatures)). Checked on real operations: 12 v0.3.0 ones on Ethereum and 9 v0.2.0 ones on Arbitrum, rebuilt as a wallet shows them. All 21 digests equal the module's `getOperationHash`, and all 20 plain ECDSA signatures recover to an owner of their Safe. Replayed at the block before each ran, the 12 Ethereum ones simulate without a revert, with the token amounts each receipt shows leaving the Safe (apart from token paymasters' gas fees, taken under the approval the preview shows). |
| Smart-account batches | A call to your own account (an EIP-7702 delegated account or smart wallet): ERC-7579 / ERC-7821 `execute(bytes32,bytes)` (single, batch, batch with opData, delegatecall; "try" mode), `executeBatch((address,uint256,bytes)[])`, `execute(address,uint256,bytes)`, and the older parallel-array `executeBatch(address[],bytes[])` and `executeBatch(address[],uint256[],bytes[])` (SimpleAccount for v0.6, LightAccount) | "Run 3 calls from your account", with each call decoded as its own transaction from the account ("Allow Permit2 to spend unlimited DAI", "Swap 1,000 DAI for at least 994.999 USDC") and its warnings numbered. **Danger** for a delegatecall, which runs another contract's code inside the account. |
| **EIP-7702** account delegation | `authorizationList` in `eth_sendTransaction` (type-4), unsigned or signed | Which account is delegated to which contract (named when its source is verified), on which chain (`chainId` 0 = every chain). **Danger** when your own account would run another contract's code; information for authorizations signed by other accounts (a sponsor relaying them) and for revocations. The transaction is simulated with the delegations applied, so calls to a delegated account run its new code; not on HyperEVM, which has no EIP-7702. A call to your own account in the same transaction (a wallet upgrading the account and running a batch through it) is decoded against the new delegate's verified ABI. "Delegate your account to X" when nothing else happens. |
| Batches | `wallet_sendCalls` (EIP-5792) | Each call previewed, with warnings merged. The calls are simulated **in order in one block**, so "approve, then swap" isn't shown as failing, and balance changes are netted across the batch. **Danger** when a call in an all-or-nothing (`atomicRequired`) batch would fail, since then none take effect; **caution** for a non-atomic batch, where the other calls may still go through. A custom simulator without `simulateBatch` simulates only the first call and says why. |
| Uniswap **Universal Router** | `execute(commands, inputs[, deadline])` and `executeSigned` on Uniswap's official routers: 2.1.1, 2.1.2 and 2.2.0 (current), 2.0 (Uniswap v4), 1.2 and the original 1.0, on Ethereum, Arbitrum and HyperEVM | One headline for the trade ("Swap 1 ETH for at least 3,150 USDC"), summing split routes and following chained hops through wrap/unwrap, then every command as a step: v2/v3/v4 swaps with fee tiers and per-hop minimum prices, Permit2 permits and transfers, wrap/unwrap, sweep, pay, fee portions, balance checks, sub-plans, v3/v4 position-manager calls, **Across bridging** ("…, then bridge to Base"), and the NFT-marketplace purchases of 1.2 and 1.0 (1.0's LooksRare, X2Y2 and Foundation purchases name the NFT and who gets it). `executeSigned` shows who signed the route. **Caution** when output goes to another address (on this chain or the bridge's destination), when nothing limits slippage (minimum received 0 and no per-hop prices), when the deadline has passed, or for a Permit2 allowance to an address other than the router; **danger** for a fee portion of 10% or more. Command tables differ between releases (0x10 is a Seaport purchase on 1.2 and a v4 swap now; 2.1 adds fields to every swap), so only known router addresses are decoded, each with its release's table: 1.0's was read from its verified source (it masks commands with `0x1f`, and `0x0e` is a placeholder there). 1.0 is little used now; on its traffic from early 2023 (300 Ethereum and 125 Arbitrum transactions) every transaction decoded with no unknown command, and on Arbitrum, whose RPC still serves those receipts, the headline's input and output tokens matched the receipts in 70 of 70 and 53 of 53. |
| Any other contract | calldata to a contract with a verified ABI (Sourcify, Etherscan or your own), including through proxies | Contract name, function and named arguments. Addresses are labelled ("you", token symbols) and amounts are shown in the right token's units. **Caution** for ownership, upgrade and role changes. See [Contract and token lookups](#contract-and-token-lookups). |
| | no verified ABI, but a known selector | The function from the built-in list or a signature database, marked **unverified** (`partial`). The match must re-encode to exactly the signed calldata, and the most trusted source decides when several fit (see below). |
| Plain-text calldata | data that is entirely printable UTF-8: `data:` URI inscriptions (Ethscriptions and similar), on-chain messages | The text, or for a JSON inscription its protocol operation ("Inscription: edmt emt-batch-transfer enat"), noting that an off-chain indexer decides its effect. Invisible and text-reordering characters are removed and flagged. Full when the recipient has no code; **caution** when it's a contract (it receives the text as input) or can't be checked. |
| Anything else | unknown calldata | `opaque`, with the selector shown. Simulated balance changes are added when a simulator is configured. |
| Simulated effects (any transaction) | `eth_simulateV1` logs and state; on HyperEVM, a local EVM over the chain's state ([how](#contract-and-token-lookups)) | Balance changes for native, ERC-20, **ERC-721 and ERC-1155** (e.g. "+1 BAYC #42"). Amounts are the balance differences read from state before and after each call, for every token the events or calldata mention, so share-based tokens are exact and wrapping ETH shows the WETH received (WETH emits `Deposit`, not `Transfer`). **Permissions left in place**: ERC-20 and Permit2 allowances, single-NFT approvals and `setApprovalForAll`, read back from the tokens after the simulated transaction. One set *along the way* by another call (a router writing a Permit2 allowance, a smart account's `execute`) is flagged: unlimited allowances and single NFTs with **caution**, all-NFT approvals with **danger**. |

### Hyperliquid L1 actions: the one real limit

For orders, cancels and leverage changes, the wallet only signs the hash of the action. **No previewer can recover the action from the signing request alone.** The Hyperliquid web app avoids wallet prompts for these by approving a local agent key once (`ApproveAgent`, fully decoded here). So when one of these hashes reaches the user's main wallet, the default preview says the contents are hidden and advises caution.

A dApp or integrator that holds the action can pass it as `context.hyperliquid = { action, nonce, vaultAddress?, expiresAfter? }`. The previewer re-hashes it and decodes it **only if** the hash equals the signed `connectionId`. Otherwise it reports a **danger** mismatch.

### UserOperations signed as a hash (EntryPoint v0.6 and v0.7)

Smart accounts for EntryPoint v0.6 and v0.7 (SimpleAccount, LightAccount, Kernel, Biconomy and most others) have their owner sign the operation's bare hash: `personal_sign` of `getUserOpHash`, 32 bytes that say nothing. The wallet or SDK building the operation holds it, so it can pass it as `context.userOperation = { entryPoint, chainId?, operation }` (to the HTTP API, or from the interceptor's per-request `context` option), in the form bundlers' RPC carries it (v0.6 fields; v0.7 fields unpacked as `factory`/`paymaster…`, or packed). The previewer hashes it as that EntryPoint does and decodes it **only if** the hash equals the message being signed: "Sign a UserOperation: Send 15 USDC", read the same way as a v0.8 operation (calls, setup, gas, paymaster, simulation as the account). A different hash is a **danger** mismatch. The hashing was checked against the EntryPoints' own `getUserOpHash` on 30 recent v0.7 operations on Ethereum and 26 v0.6 ones on Arbitrum, all equal. For the 15 of those accounts with an `owner()`, the real signature was a `personal_sign` of exactly that hash by the owner.

### UserOperations, simulated as the EntryPoint runs them

An ERC-4337 operation (typed v0.8/v0.9, hash-signed v0.6/v0.7, or a `SafeOp`) is simulated whole, the way its EntryPoint runs it. The EntryPoint's code is replaced, by a state override, with the simulation code bundlers use: eth-infinitism's `EntryPointSimulations` for v0.7, v0.8 and v0.9, and for v0.6 its own `EntryPoint` with `simulateHandleOp` returning its result instead of reverting (a revert discards the operation's logs). `npm run build:entrypoints` (`scripts/build-entrypoint-simulations.ts`) builds them into `src/entrypoint-simulations.ts`, each with the compiler and settings that reproduce its deployed EntryPoint byte for byte (solc 0.8.17, 0.8.23, 0.8.28 and 0.8.28, all via IR at 1,000,000 runs), so an operation uses the gas the chain will charge it. It fetches its sources and compilers itself, pinned: the npm packages by their registry integrity, the Sourcify sources by a hash. CI rebuilds them with `--check` and fails if the committed file differs. v0.9's sources are the deployed contract's own, verified on Sourcify: its last published package, 0.9.0-rc.1, differs from what was deployed. The storage (deposits, nonces) and the SenderCreator stay the EntryPoint's own. A code override runs no constructor, so the override also sets what the EntryPoint's constructor would have: the EIP-712 name and version in the code (v0.8 on), and in storage the two things `EntryPointSimulations` otherwise sets only when a simulation starts, its SenderCreator and (v0.8 on) the EIP-712 domain separator operations are hashed with. An earlier bundle replayed in the same block, a plain `handleOps`, then runs as it did on-chain: before this, every v0.8 or v0.9 bundle ahead of the operation hashed with a zero domain and failed its real signatures. The larger replay samples found it: an operation whose USDC an earlier bundle in its block had already spent showed as succeeding. Checked: through the override, `getUserOpHash`, `senderCreator()` and `eip712Domain()` answer as the deployed EntryPoints do, on Ethereum and Arbitrum One. Two things in the simulation code differ from what bundlers run, and neither changes an operation's gas. Its `depositTo` doesn't waste gas on purpose. Its simulation-only check that the paymaster has code skips a paymaster field naming address 0, which the EntryPoint itself takes as no paymaster (such operations are included on-chain). `simulateHandleOp` then does what `handleOps` does for one operation: deploys the account through its factory if it's new, runs the account's `validateUserOp` (with the nonce and the prefund) and the paymaster's `validatePaymasterUserOp` (with its deposit), runs the calls (`executeUserOp` included) and charges for gas, the paymaster's `postOp` included.
- "Gas cost (simulated)": what the operation pays and who pays it (the account's deposit or the paymaster's), priced at the latest base fee. The base fee is passed as a block override: `eth_simulateV1` without validation otherwise runs at 0, and a token paymaster would charge nothing. The prefund the account sends the EntryPoint during validation is gas, so it isn't a balance change; a token paymaster's charge is, and is also shown as "Paymaster charge".
- **Caution** when bundlers would reject the operation, with the EntryPoint's reason ("the paymaster's EntryPoint deposit can't cover the gas (AA31 paymaster deposit too low)"; a nonce or prefund problem the checks above already name isn't repeated, and a nonce ahead of the account's only waits); when the paymaster's signature doesn't check out or its sponsorship has expired; when the account's own validity window has passed; when the calls fail (the operation is still included and pays for its gas); when the paymaster's `postOp` fails.
- The owner's signature doesn't exist yet. The simulation gives the operation a stand-in signature and replaces the `ecrecover` precompile (moved with `eth_simulateV1`'s `movePrecompileToAddress`; the fork simulator does the same) with code that recovers the stand-in as the signer, over the digest the signer's wallet will sign (the `personal_sign` form of the operation's hash, or the typed data's digest), and passes every other input to the real precompile. An account whose owner is signing validates the operation as it will once signed: accounts that only run calls they validated in the same transaction run as they will, an account that tries other forms of the hash first (Kernel's ECDSA validator) fails on those as it will, and a paymaster's own signature is checked for real. The stand-in costs exactly the precompile's 3,000 gas; any other signature passes through for about 200 gas more, which can't be given back. If the account checks a digest of its own, the stand-in is accepted over any.
- The stand-in takes the shape of accounts that wrap their owner's signature: Coinbase Smart Wallet (the signer's index among its owners, read from the account or, while its factory deploys it, from `createAccount`'s owners), ZeroDev Kernel v2.3, v2.4, v3.1 and its EIP-7702 delegate (v3.1 and the delegate by what validates the operation; the delegate's root is the account's own key, which its nonce names or else its root validator: an ECDSA validator's signature as it is or after `0xff`, as a shape may list several, tried in turn; a passkey's, below; and a permission whose signer is Bleap's cosigning module, `0xff` and then the owner's stand-in and a second one, which the replaced `ecrecover` attributes to Bleap's cosigner, each recovered for the precompile's 3,000 gas), Alchemy's Modular Account v2 (its implementations, two EIP-7702 delegates, and accounts its factory deploys in the operation, all with its `0xff00` prefix), Alchemy's LightAccount (v2, and the later implementation used with EntryPoint v0.8) and MultiOwnerLightAccount v2, whose signatures carry a `0x00` type byte for an EOA owner (accounts their factories deploy in the operation too), and Biconomy Smart Account v2 (its own proxy's implementation slot read, or, while its factory deploys it with the ECDSA ownership module, that module; the module's signature and its ECDSA ownership module, abi-encoded). A wallet that knows its account's signature better can pass its own stub, the one it gives bundlers for gas estimation (`getStubSignature` in permissionless.js and ZeroDev's SDK, `getDummySignature` in Alchemy's aa-sdk): as the `signature` of `context.userOperation`'s operation. For a hash-signed operation (v0.6, v0.7) it is part of the operation supplied anyway; for a typed one (v0.8, v0.9) the typed data decodes on its own, and `context.userOperation = { entryPoint, operation: { sender, nonce, signature } }` only supplies the stub, used when the EntryPoint, sender and nonce (and callData, if given) are the typed operation's. The stub then goes to the account in place of the stand-in. The replaced `ecrecover` passes a stub it doesn't recognise to the real precompile, so a stub signed by a dummy key validates as it does in gas estimation: the account returns a signature failure rather than reverting, and the preview says the account doesn't accept it as signed.
- Passkeys: when a Coinbase Smart Wallet itself is asked to sign and it has a passkey owner, the stand-in is a WebAuthn assertion (webauthn-sol's checks: type `webauthn.get`, the operation's hash as the challenge, read from the EntryPoint's `getUserOpHash`; user present and verified), and the P256 verifier at 0x100 (RIP-7212 on Arbitrum, EIP-7951 on Ethereum) is replaced the same way, accepting that assertion and passing anything else to the real one. Kernel accounts whose validator is Paribu's passkey validator get the same webauthn-sol assertion. ZeroDev Kernel v3.1 accounts whose validator (the one their nonce names, else their root validator) is ZeroDev's WebAuthn validator get that validator's form of the assertion (`abi.encode(authenticatorData, clientDataJSON, responseTypeLocation, r, s, usePrecompiled)`, with the type and challenge where it looks for them), whoever is signing: a passkey is the account's only key. `usePrecompiled` follows ZeroDev's SDK: the precompile on Ethereum and Arbitrum, Daimo's P256 verifier contract elsewhere. Daimo's verifier gets a stand-in too: its code moves to another address, every input still runs through it (so verification costs what a real one does), and the stand-in's answer is 1. Checked on a live Kernel passkey account on Arbitrum at the latest state: validation accepts the stand-in on both paths. Through Daimo's verifier, the operation's gas comes within 3% of what the account's own signature costs there (the verifier's cost depends on the signature). Wallets differ, though: of 7 such accounts on Arbitrum, 5 signed with the precompile and 2 with Daimo's verifier, which costs about 320,000 gas more. A wallet that signs through Daimo's verifier on a chain with the precompile can pass its stub to get its gas right.
- The operation runs at the gas price its bundle's transaction pays (`tx.gasprice`), taken as what the operation pays its bundler: the base fee plus its priority fee, up to its fee cap (the base fee alone on Arbitrum). Contracts read it: a pool that taxes swaps by the transaction's priority fee gave a different amount, or a failed swap, than a simulation at no price showed. A bundler can pay less than the operation offers (on Base, bundles paid a 0.001 gwei tip where operations offered 0.0015), so such a swap can come out a little better than previewed; the replay harness uses the price the bundle really paid.
- A paymaster's operation is simulated as sent by a bundler that paymaster's operations came through lately (found from its latest `UserOperationEvent`s, looked up alongside the stand-in's shape and remembered for ten minutes; the simulation's own address when there's none, or none within 1.5 s): a paymaster can check `tx.origin` or work differently for it. One on Arbitrum One charged 9,130 gas more as its own bundlers than as an address it didn't know, 4% of an operation's gas. One that only accepts certain bundlers and refuses the first (one busy on Ethereum and Arbitrum refuses others with `BundlerNotAllowed(address)`) is retried from the others, up to five.
- EntryPoint v0.6 and v0.7 know nothing of EIP-7702: an operation for them with an `initCode` is always a factory deploying the account, even when the account itself is the signer.
- When the whole operation can't be simulated (validation reverts on the stand-in; a simulator that reports no logs), its calls are simulated on their own, as the EntryPoint makes them: the account deployed through its SenderCreator if it's new, then called from the EntryPoint (with headroom for the cold access a standalone call pays). Accounts that only run validated calls are then simulated directly from the account, when their code reads transient storage and their calls have the common `(target, value, data)` shapes. An account with no code (it gets an EIP-7702 delegation in the bundle itself) would run nothing, and the preview says so. The prefund is checked on its own too: **caution** when the account's EntryPoint deposit plus its balance (or the paymaster's deposit) is less than the most the operation can cost.
- Checked with `npm run accuracy:4337` ([below](#simulation-accuracy)) on recent operations, replayed as each new block arrived on the state each met: the block before, with the block's header, its earlier transactions and the bundle's own EIP-7702 authorizations. Latest runs (2026-11-10), each following new blocks for 20 to 25 minutes (on Ethereum after the 100 blocks already behind the head), every operation compared with its receipt: 728 on Ethereum and Arbitrum One, and 1,771 on Base, Polygon and BNB Chain in a first run of 15 minutes each:

  | Chain | EntryPoint | Operations | Outcome matches | Ran whole | Stand-in validated | Gas within 0.5% | Gas within 0.05% | Token movements matched |
  |---|---|---|---|---|---|---|---|---|
  | Ethereum | v0.7 | 300 (11 in bundles of several, 12 SafeOps) | 297 | 298 | 298 | 181/181 | 44 | 264/266 |
  | Ethereum | v0.8 | 114 (7 in bundles) | 114 | 114 | 114 | 57/57 | 6 | 98/98 |
  | Ethereum | v0.6 | 101 | 101 | 99 | 98 | 93/94 | 73 | 83/84 |
  | Arbitrum One | v0.7 | 175 | 175 | 170 | 166 | 94/99 | 34 | 133/133 |
  | Arbitrum One | v0.8 | 25 | 25 | 25 | 25 | 19/19 | 0 | 23/23 |
  | Arbitrum One | v0.6 | 11 | 11 | 11 | 11 | 5/5 | 4 | 10/10 |
  | Arbitrum One | v0.9 | 2 (both SafeOps) | 2 | 2 | 2 | 2/2 | 0 | – |
  | Base | v0.7 | 300 (14 in bundles, 147 SafeOps) | 300 | 299 | 290 | 49/49 | 12 | 157/157 |
  | Base | v0.6 | 300 | 299 | 300 | 300 | 283/290 | 164 | 147/148 |
  | Polygon | v0.7 | 271 | 270 | 268 | 268 | 207/207 | 147 | 74/75 |
  | Polygon | v0.8 | 300 (42 in bundles) | 300 | 300 | 300 | 244/244 | 201 | 232/232 |
  | BNB Chain | v0.7 | 300 | 296 | 296 | 269 | 23/23 | 6 | 175/177 |
  | BNB Chain | v0.8 | 300 | 300 | 300 | 300 | 97/97 | 37 | 288/291 |

  Gas is judged for operations alone in their bundle, simulated whole on their block's state; token movements count those within a gas-priced fee's rounding (most of the inexact ones: a paymaster charging in a token). The two v0.7 rows are the day's second runs; the others its first, run before some of the fixes below.
  - On the new chains (gas judged where the stand-in validated; on BNB Chain not for operations run a second after their block, most of them):
    - Found and fixed: a wrap of the wrapped native token (WETH9's `Deposit`, which has no `Transfer`) wasn't counted where balance changes come from the simulated events, so a BNB Chain operation wrapping 0.006 BNB and passing it on showed 0.006 WBNB going out as well.
    - Signatures no stand-in takes, so the account rejects it and its own check doesn't run: on Base, ShrincsWallet (post-quantum SPHINCS+ signatures, verified in Solidity: 40% of the gas left out) and an unpublished passkey wallet (19–34%); on OP Mainnet (13 operations in a later run, every outcome right), Biconomy Nexus through its MEE validator. Their gas isn't judged.
    - On BNB Chain, 25 Kernel v3.3 accounts rejected the stand-in in the first run: Paribu's wallets, whose root validator (unpublished) takes a passkey's assertion in webauthn-sol's form with the operation's hash as the challenge. They now get that assertion, checked through the P256 precompile's stand-in: in a later run the stand-in validated for 144 of the 146 operations that ran whole (269 of 296 before).
    - Polygon: 459 operations were in bundles sent to a bundler's own contract (`0x84ba…9a7e`, unpublished), which relays the same `handleOps` call to the EntryPoint; the first run skipped them. They're replayed now: in a later run of 200, 105 were relayed, all 105 outcomes right, and their gas, reported apart as for bundles of several, a median 1.5% high: the relaying contract warms state before the EntryPoint runs (about 8,000 gas of an operation's), which a preview, not knowing the bundler, can't count. OP Mainnet's public node refuses receipts by hash; the harness reads the block's receipts instead.
    - One Base v0.6 swap through a Metarouter failed on-chain (`"IG"`) and succeeded in the replay, with or without its block's earlier transactions and as its real bundler. Its pool adds a "MEV tax" to the swap fee by the transaction's priority fee (`PriorityFeeMevTaxModule`: `tx.gasprice - block.basefee` over a threshold), and the simulation ran at no gas price: untaxed, the swap cleared its minimum; taxed, as on-chain, it didn't. Operations are now simulated at the price their bundle pays (below): replayed again, the preview says the calls fail with `IG`, and its gas is within 0.005% of the receipt's. A following run of 641 operations on five chain-and-version pairs had every outcome right and every compared gas within 0.5%.
    - A tax token on Base took 1% of a sale with no `Transfer` event for it: the preview, reading balances, had the account's real change, and the harness, reading events, called it wrong. Where the two disagree, the account's balance across the block now decides.
  - The three Ethereum v0.7 outcomes that differ are OKX Wallet passkey accounts running their calls through `executeUserOp`, which is handed the operation's signature: their signature carries the key's hash and a WebAuthn assertion, in a form whose source isn't published, so the stand-in validates but the calls then revert (`NonAdminSelfCall()`). The preview says the signed operation can fare differently there, and the harness counts those as warned rather than wrong.
  - What the runs found, now fixed: Pimlico's paymaster refusing the simulation's own address (`BundlerNotAllowed`) when the lookup of its bundlers was refused under load (8 operations); a paymaster on Arbitrum One charging 9,130 gas more as its own bundlers, now simulated as one (2, 4% low); two EIP-7702 accounts whose stale ERC-1967 slot gave them Coinbase's shape; LightAccounts and Biconomy Smart Account v2s their factories deploy in the operation; a Zarb app Safe whose passkey owner (Safe's WebAuthn shared signer, verified by FCL's contract) the ECDSA stand-in skipped (2, 30% and 45% low: the second Arbitrum run's two failures). In the harness: Bleap's Kernel accounts whose root is the cosigning permission (their owner read from the module), Biconomy's signature wrapper, and a bundle 336 transactions into a full block whose earlier transactions left it too little of the node's 50M gas cap (AA95, now replayed without them).
  - Not replayed: session keys' operations (SmartSession; 20 on Arbitrum v0.7) and, since these runs, Kernel operations in enable mode and Modular Account v2 operations carrying a deferred action, none of which a wallet signs as an operation hash; and operations whose block's state the node no longer served by their turn (14 on Arbitrum, 3 on Ethereum). Still simulated as calls alone or with the stand-in rejected: Biconomy Nexus operations through its MEE validator (the owner signs a supertransaction's Merkle root), Modular Account v2 validations reverting on the stand-in, and a Kernel permission whose signer isn't Bleap's. HyperEVM's public RPC serves only the latest state, so its operations can't be replayed at the block before them; the fork simulator's path is covered by the tests.
- A `SafeOp` runs whole through the Safe's 4337 module: the signing owner's signature (or, if the signer isn't an owner, the first owner's) is the ECDSA stand-in over the SafeOp's digest, any other owners the threshold needs approve on-chain (Safe's `approvedHashes`), and the Safe's configuration is compared before and after. A passkey owner through Safe's WebAuthn shared signer (the Safe keeps the passkey in its own storage) signs as a contract instead: a WebAuthn assertion in the form Safe's WebAuthn library decodes, and the P-256 verifiers its passkey names (the precompile, or a verifier contract such as FCL's) replaced so that they run their real check on it and then accept it. On Arbitrum One, a Zarb app Safe whose passkey is checked by FCL's verifier in Solidity had come out 30% and 45% low with the ECDSA stand-in (about 228,000 gas of verification left out); the passkey stand-in adds 234,000 back. Recent Safe4337Module v0.3.0 operations on Ethereum, replayed at the block before them, came within 0.1% of the gas the receipts charged; with every owner approving on-chain instead, they were 0.2–0.5% off, an approval costing less than the signature check the Safe will run. On Arbitrum One, a live EntryPoint v0.9 operation through Safe4337MultiChainSignatureModule, replayed as its block arrived, ran whole through v0.9's simulation code: its outcome as the receipt's, its gas within 0.08% (2.2% low with every owner approving).
- `test/erc4337-sim.test.ts` runs the real simulation code on an in-process chain through the fork simulator: an owner's validation passing as signed, a token paymaster's charge, a signer the account doesn't accept, failing calls, an unfunded paymaster, a paymaster that only pays for its own bundler (run as the bundler its recent operations came through), a nonce ahead of the account's, the patched v0.6 EntryPoint, typed v0.8 and v0.9 operations, and the passkey stand-in.

### Multi-chain Safe signatures

Safe4337MultiChainSignatureModule lets a Safe's owners sign once for operations on several chains: they sign the root of a Merkle tree (EIP-712 `MerkleTreeRoot`, with a domain that names no chain) whose leaves are the operations' SafeOp digests, each on its own chain, and every operation is later submitted with a proof of its leaf. The message is only the root, so by itself the preview is **danger**: "the message doesn't say which operations it covers, on which chains, or how many".

The wallet that built the tree can pass its operations as `context.safeOperations = [{ chainId, operation }, …]` (each `operation` the SafeOp message; at most 64 over the HTTP API). The previewer hashes each as the module does and rebuilds the root, under the layouts tree builders use (OpenZeppelin's merkle-tree, and level by level), with the leaves in the order given or sorted. With the module's pair hash (the smaller node first), a root that matches commits to exactly those operations: no other operation has a proof to it. Then the preview is "Sign Safe operations: 3 operations on 2 chains", each operation previewed as the SafeOp it is on its own chain (calls, warnings, simulation), and balance changes on the request's chain listed as usual. Operations that don't make up the root are a **danger** mismatch: the signature covers others that aren't shown.

### Safe transactions, simulated through execTransaction

A Safe owner's signature (`SafeTx`) and an `execTransaction` transaction are simulated the way the Safe runs them: `execTransaction` itself, so the Safe's own logic decides (guards, the gas refund, delegatecalls of any contract, MultiSend batches) instead of each call being run from the Safe's address. A signature doesn't exist yet when previewing, so the simulation gives the signing owner (or, if the signer isn't an owner, the first owner) the same ECDSA stand-in UserOperations get: a 65-byte signature that the replaced `ecrecover` attributes to them over the Safe transaction's hash, so the Safe's own signature check runs and costs what it will. The other owners the threshold needs (the lowest ones) approve the hash on-chain (Safe's `approvedHashes`, the approval its signature type 1 accepts, set with a storage override). Owners and threshold stay as they are, and the transaction is sent from the signing owner. An `execTransaction` transaction runs as sent, with its own signatures.
- In the same simulated block, the Safe's configuration is read again (owners, threshold, singleton, guard, fallback handler, modules) and compared with now. What a delegatecall does to the Safe then shows even when its calldata looks harmless: a singleton that isn't one of Safe's official ones is **danger** ("After this transaction the Safe runs the code at 0x…, which isn't one of Safe's own", the Bybit outcome); an official one (1.1.1 to 1.5.0, from safe-global/safe-deployments) is an upgrade, a **caution**; added or removed owners, a new threshold, guard or fallback handler are cautions and an enabled module is **danger**, unless the decoded calldata already says so.
- After a takeover like Bybit's, the Safe no longer answers as a Safe (`getOwners` and `getStorageAt` are gone with its code), so its singleton is read with `masterCopy()`, which the proxy answers itself from slot 0; the rest of the configuration is then unreadable, and only the singleton is compared.
- Checked on 30 recent `execTransaction` calls on Ethereum, rebuilt as the SafeTx their owners signed and simulated at the block before they ran (without their signatures): all 30 outcomes match the receipts, all 15 that moved tokens move exactly the receipts' amounts for the Safe, and none reported a configuration change. On a real Safe 1.3.0, a delegatecall to Safe's SafeMigration reports "The Safe's code changes to Safe 1.5.0" (and "1.5.0 (L2)" for `migrateL2Singleton`).
- The Bybit theft, staged live on mainnet: an owner of a real Safe 1.3.0 (`0xf930…3063`) asked to sign a SafeTx that delegatecalls the contract used in the theft (`0x9622…7242`, still deployed) with the theft's own calldata, `transfer(0xbdd0…9516, 0)`, which writes the address into the Safe's slot 0. Besides the static delegatecall **danger**, the simulation reports "After this transaction the Safe runs the code at 0xbdd077f651ebe7f7b3ce16fe5f2b025be2969516, which isn't one of Safe's own (the Safe no longer even answers as a Safe)" as **danger**. `test/safe.test.ts` has the offline version.

### Can the transaction be included, and what does it cost

Simulation runs the call; the network also checks the transaction itself before including it, and `eth_simulateV1` runs with validation off. With an RPC for the chain, each `eth_sendTransaction` / `eth_signTransaction` preview reads the account's nonces, balance and the latest base fee, and adds:
- **Nonce**: **danger** when the request's nonce is already used by a mined transaction; **caution** when it belongs to a pending one (it replaces it, a speed-up or cancel); information when it leaves a gap, or when the account has pending transactions the preview doesn't include.
- **Fee cap**: **caution** when `maxFeePerGas` (or `gasPrice`) is below the current base fee, so the transaction waits.
- **Funds for gas**: **danger** when the balance doesn't cover the value plus gas limit × fee cap, which the network rejects; caution when it may not cover the estimated fee.
- **Network fee**: "≈ 0.000055 ETH (50,000 gas at 1.1 gwei); at most 0.00012 ETH": the simulated gas at the current base fee plus the tip (the request's, or `eth_maxPriorityFeePerGas`), capped at the fee cap. On Arbitrum One it is the base fee (no tip) on the L2 gas plus the gas ArbOS charges for the data posted to Ethereum, from NodeInterface's `gasEstimateL1Component` (zero at the moment: it matched `gasUsedForL1` in 20 of 20 recent receipts). On Base and OP Mainnet (OP Stack) every transaction also pays an L1 data fee on top of its gas, often more than the gas itself on OP Mainnet: the preview adds it ("…, plus 0.0000006 ETH for the data posted to Ethereum"), from the GasPriceOracle predeploy's `getL1Fee` for the transaction serialized as the wallet will send it, unsigned (authorizations not signed yet get stand-in signatures of their size), and counts it in the most the transaction can cost and the funds it needs. Against receipts' `l1Fee` it was exact for transactions at the oracle's minimum size and otherwise a fixed 3 compressed bytes high (up to 2.3% on small transactions): the oracle allows 68 bytes for the signature, a little more than a real one compresses to.
- **Gas limit**: the request's own limit is passed to the simulator, so a limit too low shows as running out of gas, and the call is run again without it to say how much it needs ("out of gas: the gas limit (30,000) is below the 62,044 gas this call needs"). A node's "insufficient funds" or "intrinsic gas too low" is reported as the failure it is rather than as a simulator error.

**What a signature can move now.** A gasless approval or order moves nothing when it is signed, so it can't be simulated as a transaction, but what it would move if used now can be read. For EIP-2612 permits, Permit2 allowances and transfers, UniswapX orders, CoW orders and 1inch limit orders, the preview adds "Can move now": the amount the signature permits, capped by the signer's balance and, where a contract pulls the tokens on the signature's authority (Permit2, CoW's vault relayer, 1inch's router), by the ERC-20 allowance that contract already has. "5,000 USDC (your whole balance, and any you receive while the permission lasts)" for an unlimited permit, "nothing yet: Permit2 has no allowance for your USDT…" when the signature can't move anything until an approval exists. The signature's nonce is checked too: an EIP-2612 nonce behind the token's `nonces(owner)`, a Permit2 allowance nonce behind `allowance(owner, token, spender)`, or a one-time Permit2 nonce already set in `nonceBitmap` means it can't be used. Checked live on Ethereum with accounts that had just used Permit2 and CoW (CoW's relayer address read from GPv2Settlement's `vaultRelayer()`). Seaport orders get the same for each offered item: whether the offerer owns the NFT (or holds the ERC-1155 amount, or the ERC-20 balance) and has approved the operator that moves it (Seaport, or the order's conduit, resolved through Seaport's ConduitController), so a listing reads "AZUKI #7738 (you own it, and the order's conduit is approved)", "no: you don't own …" or "not yet: the order's conduit isn't approved…"; an order signed with a counter other than Seaport's `getCounter(offerer)` can't be filled (`incrementCounter` cancelled it). Checked live with a real Azuki owner.

**Pending transactions.** A preview runs on the latest state, but the wallet's own transactions that aren't mined yet run first. Pass them as `context.pendingTransactions` (oldest first; `{ to, data, value }`) and the transaction is simulated after them, in order, in one block: a WETH transfer that fails on its own (no WETH yet) succeeds after a pending wrap, live on Ethereum. A pending transaction expected to fail is a caution.

## Preview JSON

```ts
{
  schema: 'signing-preview/1',
  method, kind: 'transaction' | 'batch' | 'typed_data' | 'message' | 'unsupported',
  network: { kind: 'evm', chainId, name } | { kind: 'hypercore', name, testnet } | null,
  title, summary,                       // plain-language headline and sentence
  details: [{ label, value, raw? }],    // raw = exact integer/hex when value is formatted
  assetChanges: [{ direction, account, amount, symbol, raw?, asset?, basis, standard?, tokenId? }],
  approvals?: [{ kind, owner, spender, token, symbol?, allowance, raw?, tokenId?, expiration?, revoked, direct, basis }],
  warnings: [{ severity: 'info' | 'caution' | 'danger', code, message }],
  attention: 'none' | 'info' | 'caution' | 'danger',   // display hint, not a security verdict
  decoding: { status: 'full' | 'partial' | 'opaque', decoder, notes },
  simulation?: { status, source, gasUsed?, revertReason? },
  calls?: Preview[],                    // batches
}
```

`assetChanges[].basis` says where each number comes from:
- `requested`: what the signed request asks for.
- `simulated_state`: balances read from the simulated state before and after the call (the default with a simulator).
- `simulated_events`: transfer events from `eth_simulateV1`, when the balances couldn't be read back.

None is a measured final balance. Fee-on-transfer or rebasing tokens, and state changes before inclusion, can differ.

NFT changes carry `standard` (`erc721`/`erc1155`) and the full `tokenId`. `symbol` reads like "BAYC #42", with long IDs shortened. Collection names come from the contracts and are easy to copy, so a received, named NFT gets an info note.

`approvals` lists the permissions the account holds **after** the transaction, one per token and spender, or per NFT:
- `kind` is `erc20`, `permit2`, `erc721` (one NFT) or `operator` (every NFT of a collection).
- `allowance` reads like "unlimited", "250 USDC", "BAYC #42", "all NFTs in the collection", "none" (used up or set to zero) or "revoked".
- `direct` is true when the approval is the call itself, such as `approve()`. Those are already flagged by their decoders, so only `direct: false` approvals add warnings.

Events alone can be stale: USDC, OpenZeppelin 5 tokens and Permit2 lower an allowance without an event when it's spent, and older OpenZeppelin tokens emit one on every spend. So `RpcSimulator` reads the real values back with a second simulation pass (`allowance`, Permit2 `allowance`, `isApprovedForAll`, `getApproved`) after each call, and `basis` is then `simulated_state`. A token without these view functions keeps the event value (`simulated_events`). Permit2 events are only accepted from the canonical Permit2 contract.

## Mock and live data

`npm start` uses mock data. To use real data:

```bash
SIGNING_PREVIEW_MODE=live ETHEREUM_RPC_URL=… ARBITRUM_RPC_URL=… HYPEREVM_RPC_URL=… BASE_RPC_URL=… npm start
```

Live mode reads Hyperliquid's public `/info` API and simulates on any chain that has an RPC URL configured: with `eth_simulateV1`, or, where the RPC lacks it, with `eth_call` and a state override (HyperEVM). Chains without one are previewed from the decoded request only. The RPC URLs also enable on-chain token metadata and proxy detection.

| Variable | Effect |
|---|---|
| `ETHEREUM_RPC_URL`, `ARBITRUM_RPC_URL`, `HYPEREVM_RPC_URL`, `BASE_RPC_URL`, `OPTIMISM_RPC_URL`, `POLYGON_RPC_URL`, `BSC_RPC_URL` | Simulation, `symbol()`/`decimals()` lookups and proxy detection on that chain (Ethereum, Arbitrum One, HyperEVM, Base, OP Mainnet, Polygon, BNB Chain); a chain without one isn't simulated. Any node with `eth_simulateV1` works: the public ones the scripts default to (`EVM_RPCS` in `src/chains.ts`: publicnode's for Ethereum, Base, OP Mainnet, Polygon and BNB Chain, Arbitrum's and Hyperliquid's own) all have it. |
| `TOKEN_LIST_FILE` | A [tokenlists.org](https://tokenlists.org)-format JSON file, consulted after the built-in tokens. |
| `ETHERSCAN_API_KEY` | Adds Etherscan (API v2: Ethereum, Arbitrum and HyperEVM with one key) after Sourcify. |
| `SIGNING_PREVIEW_OFFLINE_LOOKUPS=1` | Don't call Sourcify, Etherscan, OpenChain or 4byte. The built-in signature list still works. |
| `SIGNING_PREVIEW_FORK_CACHE` | A file that keeps the HyperEVM simulator's caches (contract code, last values seen) across restarts. The CLI uses `~/.cache/signing-preview/fork-cache.json` unless set; `off` for none. |

`liveDependencies()` was run against Ethereum, Arbitrum One and HyperEVM, with Sourcify, OpenChain and 4byte, on 2026-11-04. Token metadata, proxy detection, verified-ABI and signature decoding and simulation all worked. A first preview of an uncached contract took 0.4–1.8 s. The `/info` client is checked live by `npm run verify:live`.

Any RPC works if it supports `eth_simulateV1`, or `eth_call` with state overrides. Verification used these public, keyless endpoints:
- Ethereum: `https://ethereum-rpc.publicnode.com` (PublicNode)
- Arbitrum: `https://arb1.arbitrum.io/rpc`
- HyperEVM: `https://rpc.hyperliquid.xyz/evm`

Public endpoints can rate-limit or change without notice; use your own provider in production.

## Contract and token lookups

**HyperEVM simulation.** The public RPC (`rpc.hyperliquid.xyz/evm`) has no `eth_simulateV1`, `debug_traceCall`, `trace_call`, `eth_createAccessList` or `eth_getProof`, and serves only the latest state. It does have the plain state reads and `eth_call` with state overrides. `RpcSimulator` notices the missing method once and, in live mode, simulates with **`ForkSimulator`** (`signing-preview/fork`), falling back to **`SimulationProbe`**.

`ForkSimulator` runs the transaction in a local EVM (`@ethereumjs/evm`, Cancun rules as HyperEVM uses) over HyperEVM's state, fetched on demand with `eth_getBalance`, `eth_getCode`, `eth_getTransactionCount` and `eth_getStorageAt`, as Foundry's fork mode does:
- It produces every log, so every token, NFT and approval the transaction touches is seen, with no token list. Amounts are read from the state before and after each call, so fee-on-transfer and share-based tokens come out exact; tokens the calls name are read too, which catches WETH-style wrappers that emit `Deposit` instead of `Transfer`. Approvals are read back from the tokens.
- HyperCore's read precompiles (`0x…0800` onward) are answered by the chain itself through `eth_call`, and charged what HyperEVM charges: 1,000 gas plus 33 per input and output byte, measured on mainnet with a contract reading `gasleft()` around calls to six of them. `BLOCKHASH` gives the recent blocks' real hashes. Revert data, gas (with refunds and warm/cold access as in a real transaction) and batches in order are exact.
- Fetching one value per round trip would be far too slow, so each run is speculative: unknown values read as the last value seen (shared across simulations) or zero, and everything the run needed is fetched in parallel JSON-RPC batches (20 per request, HyperEVM's limit) before it runs again. Only a run that used fresh values throughout is accepted. A long chain of dependent reads, such as Kinetiq's diamond router, takes about 10 s the first time and about 1 s once its values have been seen.
- It runs in the next block (latest + 1 s), so interest and time-based values are one second further on than a plain `eth_call` shows.
- If it hasn't finished within 3.5 s (`forkBudgetMs`), the probe is asked, reading the tokens the fork run has seen so far as well as its own. The fork run carries on: if it finishes while the probe is still out, its fuller answer is used; otherwise it fills the caches, so the next preview is fast.
- A token first seen in the first call's logs is read on the state before it on a second EVM, rather than by running everything again, and proxy slots are prefetched only for contracts never seen before.
- In live mode (`npx signing-preview` with `SIGNING_PREVIEW_MODE=live`), a background warm-up at start simulates a Kinetiq stake and every HyperLend reserve's data and oracle price in one batch. The first health-factor read of a HyperLend borrower then takes 9 rounds and 4.1 s instead of 25 rounds and 12.2 s. Without a cache file from an earlier run, it also replays one recent transaction to each of the 12 contracts most used by different accounts in the last minute of blocks (`warmFromTraffic`), two requests at a time. `liveDependencies(env, { warmUp: true })` does the same for your own server.
- The caches survive restarts in a file (`cacheFile`; `SIGNING_PREVIEW_FORK_CACHE` in live mode, `~/.cache/signing-preview/fork-cache.json` for the CLI), at most about 25 MB.
- Measured on 25 real HyperEVM transactions to 25 different contracts (2026-11-05), each simulated from the same starting cache: cold, the median first preview took 4.2 s and 11 of 25 finished within the 3.5 s budget; after the built-in warm-up, 4.5 s and 12; after the traffic warm-up, 2.0 s and 17. The slowest tenth (12–20 s) are the public RPC's rate limit at work (the same number of rounds, twice the requests from retries): a server with its own RPC doesn't have it. A later run, after the first call's tokens were read without another run and proxy slots were prefetched only for new contracts (12 other transactions): median 3.1 s cold, 2.0 s after the built-in warm-up and 1.6 s after the traffic warm-up, in 3 rounds instead of 4.
- Public RPCs rate-limit per IP. State reads back off and retry within the simulation's time budget, but a busy server should use its own RPC.

`SimulationProbe` (`contracts/SimulationProbe.sol`) is the fallback: one `eth_call` sets the probe as the code of the sending account and runs the transaction (or a whole batch, in order) through it, from that account.
- Around each call the probe reads the native balance, ERC-20 balances, allowances, Permit2 allowances, `isApprovedForAll`, and NFT ownership and approvals by token ID. The differences become balance changes and approvals with basis `simulated_state`.
- Without logs, only what is read is seen: the tokens the calls name (their targets, the addresses in their calldata, nested calldata and packed Uniswap paths), HyperEVM's built-in tokens, and tokens decoders name (HyperLend's hTokens and debt tokens). The preview says how many tokens were read.
- With code at the account, contracts may treat it differently. The probe answers ERC-1271 `isValidSignature` the way the account's key would (`ecrecover`), and accepts NFTs as an account without code does. A contract that refuses senders with code makes the probe fail; a plain `eth_call` then confirms the call works, and the preview says its balance changes couldn't be measured.
- An RPC that also ignores state overrides falls back to `eth_call` alone: success or failure and the revert reason, for single calls only.
- `src/probe-code.ts` holds the compiled bytecode; `npm run build:probe` rebuilds it with the pinned solc, and a test checks it matches the source.

How it was checked:
- `ForkSimulator` on Ethereum, whose RPC still has the exact state before recent blocks: 71 transactions replayed after the earlier transactions of their block, with the real block header. All 71 outcomes match the receipts, all 22 of the senders' token movements are exact, and gas matches to the unit in all 71.
- `ForkSimulator` on 120 recent HyperEVM transactions (at most two per sender), replayed at the latest state: where the replay still succeeds, it found every token movement in the receipts (4/4; the probe 3/4). Its outcome differed from the probe's once, on an Arbitrum-style inbox whose fee depends on `block.basefee`: a plain `eth_call` runs with a base fee of 0, while the fork simulator uses the real one.
- `ForkSimulator` against HyperEVM itself, at scale: 150 recent real transactions (at most two per contract, one per sender) run on the latest state through the local EVM and through the node (`eth_call` for outcome and return data, the probe for balance changes) in the same block context. In the 144 where the node's answer didn't change during the run, the outcome agreed in 144, the return data in 47 of 47, and the probe's balance changes in 8 of 9. The 9th is an amount that grows every block (by 1.864 × 10¹⁵ wei), read about 5.6 blocks apart; run back to back, the two differ by exactly one block's growth, the local EVM simulating the next block. The first run of this found the two bugs fixed since: HyperCore precompiles charged about twice their gas (2 of 146 transactions with tight gas limits ran out locally) and `BLOCKHASH` reading zero.
- `ForkSimulator` on HyperEVM: view calls through it return the same bytes as HyperEVM's own `eth_call`, including HyperCore precompile reads (token and perp info, spot balances, oracle prices), Kinetiq's exchange rate and HyperLend's account data across all its reserves (with the same timestamp).
- On Ethereum, whose RPC still has the exact state before recent blocks, 240 transactions from one-off senders were simulated at their parent block with the shipped code and compared with their receipts. 237 succeeded as on-chain (the other 3 depended on an earlier transaction in the same block). 231 of the 235 token movements were found, 230 with the exact amount, and no movement was reported that didn't happen. 8 of the 10 approvals were found; the other two were granted and spent in the same transaction. In an earlier run of the same comparison, the probe and `eth_simulateV1` agreed on 232 of 233 outcomes; the other depended on the block time.
- On HyperEVM, live (`npm run verify:live`, step 10, with each simulator): a Kinetiq stake of 10 HYPE matches Kinetiq's own `HYPEToKHYPE` quote to the wei, a USDC transfer moves exactly 1 USDC, and approve + HyperLend supply in one batch gives −1 USDC and +0.999999 hUSDC (Aave-style balances round). Before that, 8 constructed flows matched independently computed values, including a WHYPE unwrap, a CoreDepositWallet deposit, HYPE to HyperCore and a below-minimum stake.
- On real HyperEVM traffic (2,796 transactions from 300 blocks over the last two hours, 2026-11-05), compared with their receipts: in every transaction whose replay still succeeds (273 that moved the sender's tokens, 26 of them from occasional senders), the preview shows all of the sender's token movements, against 90.8% (62.1% for occasional senders) with the `eth_call` check alone. The RPC only has the state after these transactions, so many replays fail (a balance already spent, a nonce already used); a preview before signing doesn't have that problem.
- `test/fork-simulator.test.ts` runs `ForkSimulator` against contracts in an in-process EVM behind a HyperEVM-shaped node (`test/evm-chain.ts`): exact share-token amounts, batches, approvals without events, Permit2 signatures, NFTs, an EOA-only contract, a forwarded precompile, reverts, round convergence and the fallback to the probe.
- `test/simulation-probe.test.ts` runs the real bytecode in an in-process EVM (`@ethereumjs/evm`) behind a fake HyperEVM-like RPC: transfers, unwrapping, direct and along-the-way approvals (including a forged Permit2 signature), batches, NFTs, reverts, insufficient funds and a contract that refuses senders with code.

**HyperEVM decoding.**
- Reverts with **custom errors** are named from the verified sources: Kinetiq's facets, HyperLend's Aave `Errors` library and OpenZeppelin. For example, "MustBeDivisibleBy1e10: the HYPE amount must be a multiple of 0.00000001 HYPE" or "HealthFactorLowerThanLiquidationThreshold".
- Protocol decoders read live state with `eth_call` themselves, so they don't need simulation.
- The read-only client retries briefly when rate-limited, and keeps results for 15 seconds within a preview.

**Diamond routers.** When a contract's ABI lacks the called function, the resolver asks the contract for its facet (EIP-2535 `facetAddress`, or `getFacetAddress` as on Kinetiq's router) and uses that facet's verified ABI.

**Tokens** are looked up in order, first hit wins:
1. The built-in list (`src/chains.ts`).
2. A token list you supply.
3. The token contract's own `symbol()`, `decimals()` and `name()`. Both `string` and legacy `bytes32` return values are accepted.

On-chain metadata is whatever the contract says about itself, so the preview marks it "self-reported", with an info warning. Two checks run against the built-in list:
- **Danger** `token_impersonation`: a self-reported token claims the symbol of a built-in token on the same chain but has a different address, e.g. a fake "USDC" in an airdrop or address-poisoning scam. Symbols are compared after stripping case and punctuation.
- **Caution** `token_symbol_lookalike`: the symbol uses non-ASCII characters, for example a Cyrillic "С" in "USDС".

**Contract ABIs** come from Sourcify (no key needed), then Etherscan if configured, then any you add with `StaticAbiSource`. When the address is a proxy, the implementation's ABI is used as well. Proxy detection covers:
- EIP-7702 delegated accounts
- EIP-1167 minimal proxies
- EIP-1967 implementation and beacon slots
- the older ZeppelinOS and EIP-1822 slots
- Safe
- an `implementation()` getter

A decoded call must re-encode to exactly the calldata being signed, or it's discarded.

**Function signatures** for contracts without a verified ABI come from three sources:
- a built-in list of about 35 common functions, with real parameter names (batching, Uniswap V2/V3, Aave V3, ERC-4626, NFT transfers, admin calls)
- OpenChain
- 4byte

Anyone can register a name in those databases, so these previews are `partial` and carry a caution.

Checking that a guess re-encodes to the calldata is not enough on its own. Different functions can share a selector *and* an argument layout, because `address` and `uint256` are both one 32-byte word. For example, 4byte lists `workMyDirefulOwner(uint256,uint256)` under `transfer(address,uint256)`'s selector, and it fits every transfer exactly. So candidates are ranked by source:
1. The built-in list.
2. OpenChain, with its spam filter on. Its `hasVerifiedContract` flag is not used, because spam collisions carry it too.
3. 4byte, oldest registration first. Entries can't be backdated, so the genuine function usually predates the collisions; `transfer(address,uint256)` is entry #145, from 2016.

The most trusted source with a fit decides. If 4byte alone has several fits, the oldest is shown with an `ambiguous_signature` caution naming the others. If several fit in a source without an age order, none is named.

**Amounts** are shown in token units when a parameter's name says which token it is in:
- the single token or asset parameter (Aave)
- `tokenIn`/`tokenOut` (Uniswap V3)
- the first and last entries of `path` (Uniswap V2)

The raw integer is always kept in `raw`.

Results are cached: tokens and ABIs for 10 minutes, signatures for an hour. A network failure, timeout or rate limit is retried after 30 seconds instead of being cached as "not a token", "not verified" or "not a proxy".

## What was verified, and what wasn't

- **L1 action hashing** matches vectors generated by the official `hyperliquid-python-sdk` 0.24.0 (`test/fixtures/l1-action-hashes.json`). That covers plain, vault and `expiresAfter` cases. User-signed type layouts were checked against the same SDK.
- **CoreWriter** action IDs, field types, TIF codes and system-address formats were checked against `hyperliquid-dev/hyper-evm-lib` (`HLConstants.sol`, `CoreWriterLib.sol`) and Hyperliquid's "Interacting with HyperCore" action table:
  - Action 17 (outcome operation) is only in Hyperliquid's table so far, and is decoded from it.
  - Builder-fee rates are in decibps ("10 = 0.01%").
  - Borrow/lend and merge amounts of 0 mean "the maximum".
  - Perp-side USD amounts (`usd`, `ntl`) use 6 decimals, per the library's `HLConversions.weiToPerp`.
- **Hyperliquid's docs** (2026-11-03) confirm:
  - The Bridge2 5 USDC deposit minimum ("will not be credited and be lost forever"), and that Hyperliquid now calls Bridge2 the deprecated legacy bridge, with CCTP preferred. The preview notes both.
  - The 1 USDC `Withdraw` fee.
  - The `CDeposit`/`CWithdraw` field layouts, which also match the SDK.
- **Assumption:** the CoreWriter outcome-operation amount is shown in 8-decimal HyperCore units (USDC's wei decimals). Hyperliquid's table calls it "wei" without stating its decimals; the raw value is always shown.
- The built-in token list is short (`src/chains.ts`). In live mode other tokens are read on-chain and marked self-reported. Without an RPC or token list, unknown tokens are shown in base units with a warning.
- **Lookups, verified live (2026-11-03):**
  - The built-in tokens' decimals match each token contract on Arbitrum One and HyperEVM.
  - On-chain metadata reads work, including Arbitrum USDT, which calls itself "USD₮0".
  - Proxy detection resolves USDC (ZeppelinOS slot) and TokenMessengerV2 and the Aave V3 Pool (EIP-1967) on Ethereum and Arbitrum, plus `CoreDepositWallet` and `CctpForwarder` on HyperEVM. It correctly reports `CctpExtension` as not a proxy.
  - The built-in Ethereum tokens' decimals match their contracts, and MKR's legacy `bytes32` `symbol()` decodes as "MKR".
- **ABI and signature services, verified live (2026-11-04):**
  - Sourcify, OpenChain and 4byte responses match the parsers, including Sourcify's 404 for unverified addresses.
  - Sourcify has verified sources for Uniswap SwapRouter02, Universal Router, Permit2, Multicall3, the Aave V3 Pool implementation (`L2PoolInstance`) and Circle's TokenMessengerV2 and USDC implementations on Arbitrum, the Aave V3 Pool (`PoolInstance`) on Ethereum, and WHYPE on HyperEVM. It doesn't have Circle's `CoreDepositWallet` implementation on HyperEVM, which has its own decoder here anyway.
  - The live 4byte data exposed the selector-collision case above; it is now a recorded test and a live check.
- **Not verified live yet:** Etherscan, which needs an API key.
- There is no threat-intelligence feed. Warnings are rule-based observations, and `attention: 'none'` doesn't mean "safe".

## Simulation accuracy

`npm run accuracy` measures simulation against what actually happened. It replays recent Ethereum transactions from one-off senders at their exact pre-state: on top of the parent block, after the earlier transactions of the same block, with the real block's header. Each one goes through both simulators, `eth_simulateV1` with balances and approvals read back, and `ForkSimulator`. The result is compared with what happened:
- the outcome, from the receipt;
- every token movement of the sender, from its balances at the block and at its parent (Transfer events where a balance can't be read: share-based tokens such as stETH move a unit less than their event says);
- the native coin change (the balance across the block, net of the fee);
- approvals;
- gas.

Every difference is listed. The public RPC keeps about 128 blocks of state, so only the latest blocks can be replayed.

```bash
npm run accuracy -- --blocks 20 --per-block 3 --max-index 6
```

```bash
npm run accuracy -- --chain 42161 --blocks 15 --per-block 2 --max-index 12 --simulators eth_simulateV1
```

`--follow <seconds>` keeps up with the chain instead of looking back: each new block is replayed as soon as it appears, while its parent's state is still there, and senders seen earlier in the run are left out, so bots don't fill the sample. This makes long runs possible on Arbitrum, whose public RPC keeps only about 30 seconds of state:

```bash
npm run accuracy -- --chain 42161 --follow 420 --per-block 2 --simulators eth_simulateV1
```

```bash
npm run accuracy -- --chain 8453 --follow 1200 --per-block 3 --max 600 --strict --summary-md summary.md
```

`--max` stops after that many transactions, `--strict` exits with 1 when one differs from its receipt (the rule is under [Continuous integration](#continuous-integration)), `--summary-md` appends the results as Markdown, and `--block <n>` replays a single block, to look again at one of its transactions while the node still has its state. The fork simulator runs on Ethereum only.

The simulated block takes the replayed block's header but not its gas limit: public nodes refuse a simulated block above their RPC gas cap (publicnode's is 50M, below Ethereum's 60M), and the parent's limit, the node's default, is all but the same.

`npm run accuracy:4337` does the same for UserOperations ([how they're simulated](#useroperations-simulated-as-the-entrypoint-runs-them)). It takes the recent operations of one EntryPoint (`--entrypoint 0.6|0.7|0.8|0.9`) and rebuilds each as the request its owner signed. An operation in a bundle of several (about 5% on Ethereum and Arbitrum v0.7, none on the others in a recent sample; up to five per bundle) is replayed after the bundle's earlier operations, which run first as a `handleOps` of their own with their real signatures; its outcome and token movements are compared, and its gas is reported apart: state the earlier operations warmed in the same transaction is cold in a replay, so a later operation comes out a few percent high (the first within 0.1%, as alone), and a fee priced by gas with it. A bundle carrying the same account twice is skipped. A Safe whose fallback handler is a known 4337 module gets a `SafeOp`. Other accounts get `personal_sign` of the operation's hash with the operation as `context.userOperation` (v0.6/v0.7), or the `PackedUserOperation` typed data (v0.8/v0.9). Each is previewed on the state the operation met: the parent block with the block's header, after the block's earlier transactions (`--no-prefix` skips them; an earlier transaction can change what a paymaster or a token holds, and on Ethereum one operation went from 10% off to within 0.05% with them), and after the bundle's own EIP-7702 authorizations. It is compared with the receipt: the outcome, whether the operation ran whole, whether the account accepted the stand-in signature, the gas it paid (`actualGasCost`) and the account's token movements. The signer isn't on the chain, so it is guessed: the account itself for an EIP-7702 account, else whoever the real signature recovers to (as `personal_sign`, or over the bare hash, which is then replayed as `eth_sign`; from its last 65 bytes, or its first after a prefix byte when it carries a cosigner's too), or the account's `owner()`, trying the next when the account rejects the stand-in or its validation reverts on it. A wrong guess shows as "the account rejected the stand-in". Token movements count WETH's `Deposit` and `Withdrawal` as well as `Transfer`s, and session-key operations (an ERC-7579 account validating through Rhinestone's SmartSession, signed by a dApp rather than a wallet) are skipped, as are Kernel operations in enable mode and Modular Account v2 operations carrying a deferred action (the key they install signs them; the owner approves that key as typed data, not the operation's hash). `--follow` replays each new block's operations as they arrive, which is what Arbitrum's 30 seconds of state needs; `--tx` replays one bundle.

```bash
npm run accuracy:4337 -- --chain 1 --entrypoint 0.7 --follow 1200 --backfill 100 --concurrency 3 --max 300
```

```bash
npm run accuracy:4337 -- --chain 42161 --entrypoint 0.7 --follow 1200 --concurrency 3 --max 300
```

`--concurrency` replays that many operations at once, newest first, while `--follow` keeps watching for new blocks; `--backfill` starts with the operations of the blocks already behind the head (Ethereum keeps about 128 blocks of state). With both, an Ethereum v0.7 run replayed 60 operations in under a minute, where one at a time it had taken 25 in about 20 minutes, and an Arbitrum run 25 in 4 minutes. `--summary-md` appends the results as Markdown, and `--strict` exits with 1 when an operation's outcome differs from its receipt, or, for an operation simulated whole on the state it met (its block's earlier transactions included), when its gas is 5% or more off or its token movements differ beyond a gas-priced fee's rounding or a share token's base unit or two. Calls simulated alone leave out the gas payment and any paymaster's charge, as their preview says, and without the earlier transactions amounts can move, so those are reported but not failed. An operation the node refused to simulate at all is counted apart and not compared. On Ethereum the queue runs oldest first, as a backfill's oldest blocks are the first whose state the node stops serving; on Arbitrum newest first. An operation whose state the node no longer serves is skipped (reading it would have left the preview without the account's code: a backfill's oldest operations used to fall back to calls alone this way). `ETHEREUM_RPC_URL` and `ARBITRUM_RPC_URL` replace the public RPCs.

Run on 2026-11-05:

| | Transactions | Outcome | Token movements | Native change | Approvals | Gas exact |
|---|---|---|---|---|---|---|
| `eth_simulateV1` | 47 | 100% | 11/11 | 100% | 2/2 | 100% |
| `ForkSimulator` | 47 | 100% | 11/11 | 100% | 2/2 | 46/47 |
| `eth_simulateV1`, EIP-7702 transactions only (`--only-type 0x4`) | 21 | 100% | 3/3 | 100% | 5/5 | 0/21 |
| `eth_simulateV1` on Arbitrum One (`--chain 42161`) | 21 | 100% | 6/6 | 100% | 1/1 | 100% (L2 part) |
| `eth_simulateV1` on Arbitrum One, following the chain for 7 minutes (`--follow 420`) | 69 | 100% | 25/25 | 100% | 6/6 | 68/69 (L2 part, below) |
| Both, a later run with signed authorizations passed natively | 46 (34 for `eth_simulateV1`: the node throttled 12) | 100% | 14/14 and 15/15 | 100% | 1/1 | 100% |
| Both, after the `BLOCKHASH` fix (below) | 74 (71 for `eth_simulateV1`: the node throttled 3) | 100% | 29/29 | 100% | 1/1 | 100% |

- A separate run of 71 transactions gave the same result for `ForkSimulator`: 71/71 outcomes, 22/22 token movements and 71/71 gas. Its one gas difference here is 19,900 (one storage write priced as warm) in a transaction whose outcome and balances are exact; its block's state is gone from the public RPC, so it couldn't be replayed. On any fork gas difference, the harness now re-runs the transaction with `trace: true` and keeps each storage write with its slot's value before the block.
- A later run found one transaction the fork simulator failed and the chain didn't: a contract checkpointing a recent block hash (`checkpointBlockHash`, reverting with `L1BlockHashNotAvailable()`) got zero from `BLOCKHASH`. Block hashes are now fetched, and that call matches its receipt's gas exactly (48,963).
- EIP-7702: signed authorizations are passed to `eth_simulateV1` as they are, so the node applies them: their validity, nonces and gas come out exact. The 0/21 gas row above is from before this, when they were applied only as code overrides; gas was then short by exactly what processing the authorizations costs (25,000 each, less 12,500 for an account that already exists).
- Unsigned authorizations (a request the wallet has yet to sign) can't be applied by a node, so the code override stands in for their effect, and for their gas, an authorization signed by a throwaway account set up the same way (it exists, its nonce matches) goes in the call's list: the node charges and refunds it as the chain will the wallet's own. Replaying the sender's own authorizations as unsigned (`--unsigned-7702`), gas was exact in all 8 transactions the node answered; an earlier estimate (adding 25,000 less 12,500) was 7,500 short in 2 of 5, where the refund cap depended on the call's own refunds.
- `ForkSimulator` applies authorizations as the chain does: the sender's nonce first, then each one for this chain whose authority has no code (or a delegation) and whose nonce matches sets the code, bumps the nonce, and earns the refund. It was exact on the type-4 transactions replayed with it, signed and unsigned (few: its replays include every earlier transaction of the block, so only those early in a block were run).
- A self-sponsored type-4 transaction (DAI −1,000, USDC +1,000 through the account's own batch) showed no balance changes: a call to the account itself gave its changes the account as counterparty, so they cancelled out. All three simulation paths now give such changes an unknown counterparty.
- On Arbitrum, ArbOS's own transactions are skipped; the fork simulator, which doesn't model ArbOS, isn't used there. Arbitrum's public RPC keeps about 30 seconds of state and rate-limits hard, so looking back only reaches a few blocks (two of 23 transactions were rate-limited in that run; the simulator now retries); following the chain replays each block within seconds. Given a base fee, as replays give it (the block's own), the node's `eth_simulateV1` now also charges the L1 data part, estimated for the unsigned transaction at a moving price: gas matches when it is the receipt's L2 part plus an L1 charge between none and twice the receipt's. In the 7-minute run that charge was 86–133% of the receipt's (median 111%); the one difference is a swap whose L2 gas came out 2,525 lower with its token movements exact. A preview doesn't give the simulated block a base fee, so its gas has no L1 part, and the network fee adds `gasEstimateL1Component`'s once.
- What a replay can't show: anything that happens between the preview and inclusion. A price, balance or nonce that moves in between moves the result too.

Run on 2026-11-10, each chain followed for 20 minutes (up to 600 transactions from senders not seen earlier in the run), with `--strict`:

| | Transactions | Outcome | Token movements | Native change | Approvals | Gas exact |
|---|---|---|---|---|---|---|
| Ethereum, `eth_simulateV1` | 168 | 167/167 | 64/64 | 167/167 | 10/10 | 167/167 |
| Ethereum, `ForkSimulator` | 168 | 167/167 | 64/64 | 167/167 | 10/10 | 167/167 |
| Arbitrum One | 133 | 132/132 | 32/33 | 132/132 | 5/5 | 132/132 (L2 part) |
| Base | 600 | 600/600 | 107/107 | 598/600 | 6/6 | 599/600 |
| OP Mainnet | 602 | 602/602 | 20/20 | 602/602 | 1/1 | 602/602 |
| Polygon | 600 | 600/600 | 325/325 | 600/600 | 103/103 | 600/600 |
| BNB Chain | 600 | 597/599 | 173/173 | 599/599 | 40/40 | 568/599 (the rest run a second late, below) |

Each chain had one or two transactions the node failed to answer (a backend lagging behind), counted apart. The two BNB Chain outcomes are transactions run a second after their block (below), and reported, not failed. Base's two native changes were the L1 fee its receipts name but its senders didn't pay (below), counted as right since. Arbitrum's one token movement is unexplained: the token logged a transfer of 7,984,000,100 base units from the sender and the sender's balance fell by 100, and the block's state was gone from the node before it could be looked at. The OP Stack L1 fee estimates, in later runs of 301 transactions each after the access-list fix (below): within 5% of the receipt's for all of them, from 1.5% under to 5% over (exact for most of OP Mainnet's, at the oracle's minimum size).

**Base, OP Mainnet, Polygon and BNB Chain** (`--chain 8453|10|137|56`), and what replaying them took:
- The chains' own transactions are skipped: OP Stack deposits (type `0x7e`, the block's L1 info and bridged funds) and BNB Chain's validator system transactions (the validator, at no gas price). So are transactions from a block's fee recipient, whose balance also takes the block's fees.
- Base, Arbitrum and BNB Chain make blocks faster than one a second, so a block can share its parent's second. The replay uses the block's own time; BNB Chain's node refuses a simulated block that doesn't move time forward, and such a block runs a second later. Contracts that write once a second (a pool's price observation) can then cost more, and a reward accrues a second more: those transactions' gas isn't judged, their token movements are judged within a ten-thousandth, and an outcome that differs is reported, not failed (a deadline of the block's own second). Running every such block a second later, as a first version did, left 14 of 602 Base transactions differing (two failed on-chain and succeeded a second later; others paid 23,578–59,603 gas more for observations); with the block's own time, none.
- BNB Chain's `DIFFICULTY` opcode gives the block's difficulty (2 for an in-turn validator), which MEV bots check: its node takes it from the `prevRandao` override (the block's `mixHash` there holds its milliseconds), Polygon's from a `difficulty` override.
- What the block's other transactions moved for the sender is left out of its actual change: tokens from their receipts' Transfers (six BNB Chain swaps looked like they moved nothing, as the tokens came back later in the block), and, when the native change differs, native coin from simulating the block's earlier and later transactions too (an earlier transaction paid one sender through a contract). A token movement within a millionth is an interest-bearing token's accrual (an Aave debt balance measured at the block's end).
- On Base and OP Mainnet the receipt's L1 data fee is part of what the sender paid, and the preview's estimate of it is compared with the receipt's. A request's access list is part of what's posted, and in the estimate (and in the simulation, where it costs gas and warms what it names): without it, three Base transactions with long access lists came out 24–83% under. A block's L1 info deposit (its first transaction) runs before its other transactions in the replay, as it does on-chain: a bundler's operation whose paymaster prices L1 data came out 0.47% low without the block's L1 values. Swaps through one Base contract (`0xcb98…d19e`) have receipts naming an L1 fee their sender's balance doesn't pay (it moves by the payout less the L2 gas, to the wei, as simulated): a native change off by exactly that fee is counted as right, and the summary says how many (4 of 301 in a later run).
- On BNB Chain, one EIP-7702 transaction of five simulated 18,862 gas (5.3%) above its receipt with or without the block's earlier transactions: the node's own `eth_simulateV1` against its chain.

## Coverage of real traffic

`npm run coverage` previews every transaction in blocks sampled evenly across the last 24 hours, as if each were an `eth_sendTransaction` request, and reports how much is readable, what crashed, and what is left. Pass 1 uses only the built-in decoders and lists; pass 2 adds what `liveDependencies()` would look up (Sourcify for the busiest unreadable contracts, OpenChain for their selectors). It needs the three RPCs, `sourcify.dev` and `api.openchain.xyz`.

```bash
npm run coverage -- --hours 24 --eth 300 --arb 1500 --hyperevm 1500 --out report.json
```

Run on 2026-11-06 at 08:10 UTC (pass 2 figures; "readable" is full + partial), with the run earlier the same day (03:41) in brackets:

| | Ethereum | Arbitrum One | HyperEVM |
|---|---|---|---|
| Sample | 300 of 7,177 blocks: 83,194 txs | 1,500 of 313,219 blocks: 7,954 txs (1,509 ArbOS system txs excluded) | 1,500 of 87,840 blocks: 15,505 txs |
| Full / partial / opaque | 72.1% / 20.1% / 7.8% (70.0 / 22.4 / 7.6) | 34.6% / 17.3% / 48.1% (36.4 / 17.7 / 46.0) | 61.4% / 11.4% / 27.2% (61.8 / 11.0 / 27.2) |
| Readable without lookups (pass 1) | 78.3% (79.2%) | 28.6% (28.8%) | 62.3% (6.9%) |
| Readable, standard ABI-encoded calldata only | 95.9% (95.9%) | 80.1% (81.5%) | 83.2% (83.5%) |
| Readable, occasional senders only | 96.8% (96.7%) | 80.7% (80.0%) | 76.1% (74.5%) |
| Share of the opaque rest sent by automated senders | 78.5% (76.7%) | 88.4% (87.4%) | 92.3% (91.2%) |
| Crashes | 0 | 2, fixed since (0) | 0 |

Between the two runs, decoders were added for Relay's depository, Binance Web3 Wallet's router, HyperLend's isolated pools, Kinetiq's asxnHYPE, Universal Router 1.0 and Arbitrum-style inbox messages (and, outside any transaction sample, Safe's `SafeOp` and hash-signed v0.6/v0.7 UserOperations). Relay deposits and payouts are 0.4% of Ethereum's sample and 0.2% of Arbitrum's and HyperEVM's, and Binance Web3 Wallet's router, the busiest contract occasional senders called on Ethereum that was unreadable, has left that list. On HyperEVM, the inbox of an Arbitrum Orbit chain receives 56% of the sample: those calls were already readable through the verified ABI, and are now read offline with the child-chain transaction each carries, so pass 1 goes from 6.9% to 62.3%. Arbitrum's overall share is lower because this sample holds more bot traffic (`0x96da…ab73` sent 571 transactions against 370); among occasional senders it rose. The two crashes, both a nested multicall to The Graph's SubgraphService reaching the Uniswap-style reader, were fixed after the run (`test/mainnet-regressions.test.ts`).

"Automated" means the sender appears in 3 or more of the sampled blocks, which are minutes apart: bots, relayers and exchanges sending around the clock. What stays opaque is mostly:

- **Packed calldata** (Ethereum 3,106, Arbitrum 2,179, HyperEVM 1,853 txs): any length other than selector + 32-byte words, a custom encoding no ABI describes, used by trading bots.
- **Vanity selectors** (193 / 623 / 97): ABI-shaped, but with selectors mined to start with zero bytes to save gas, also bots.
- **ABI-shaped calls to contracts with no published source** (3,210 / 1,020 / 2,275), and whose selectors aren't in a signature database. Two such contracts (`0x278d…f8d2`, `0x93c3…dd17`) are among the busiest on all three chains. Their senders are mostly bots (median nonces in the thousands). Some are verified only on Etherscan: setting `ETHERSCAN_API_KEY` reads those. Binance Web3 Wallet's router (`0xb300…028d`), whose facet is unpublished, now has a decoder read from its calldata layout and receipts.

The first run found and fixed 26 crashes (a "never expires" Permit2 approval and struct-item multicalls, now in `test/mainnet-regressions.test.ts`). It also showed that the busiest unreadable contract on Ethereum was Uniswap's current Universal Router 2.1.2, and that the busiest unreadable "contract" was an account with no code receiving text inscriptions. Both are decoded now.

Not covered, whatever the sample says:

- **UserOperations for EntryPoint v0.6 and v0.7, on their own.** Their wallets sign the operation's hash as a bare 32-byte message (`personal_sign`), which says nothing about what the operation does. They are decoded when the caller supplies the operation ([how](#useroperations-signed-as-a-hash-entrypoint-v06-and-v07)). v0.8 and v0.9 operations, and Safe's `SafeOp`, are signed as typed data and decoded.
- **Other DEX routers.** Those without a decoder of their own are shown through their verified ABI (function and arguments), or with a cautioned swap headline when they take Uniswap-shaped calls.
- **Simulation on HyperEVM** runs in a local EVM over the chain's state (see [HyperEVM simulation](#contract-and-token-lookups)). When that takes longer than its budget (a first preview of a deep contract), the probe answers, and it reads balances rather than logs, so a token the transaction doesn't name, and no decoder adds, can be missing.
- **Sample size**: about 4% of Ethereum's blocks, 0.5% of Arbitrum's and 1.7% of HyperEVM's in the day.

## HyperCore coverage

Checked against `@nktkas/hyperliquid` 0.33.3 (every exchange action) and `hyperliquid-python-sdk` 0.24.0:
- **Wallet-signed actions: 17/17.**
- **L1 actions: 42/42**, including every variant of the union actions: 16 `perpDeploy` (HIP-3 deployer), 9 `spotDeploy` plus 4 outcome-deployer (HIP-4) variants, 3 `CValidatorAction`, 2 `CSignerAction` and 4 `userOutcome`. Agent-wallet actions (`agentSendAsset`, `agentSetAbstraction`, `agentEnableDexAbstraction`) are decoded too, but are normally signed by an API wallet rather than a user's wallet.
- **CoreWriter actions: 16/16** (IDs 1–13 and 15–17, as listed in Hyperliquid's action table).

The EIP-712 field lists and wire fields match the SDK, and L1 hashes match 44 Python SDK vectors (`test/fixtures`). `test/hypercore-admin.test.ts` checks that every SDK L1 type and variant decodes. `npm run verify:live` resolves every live asset ID to a named market with a live mid price. On 2026-11-03 that was 235 perps, 349 spot pairs, 321 HIP-3 perps on 10 DEXes, and 636 outcome sides.

Outcome markets are labelled from their structured spec, for example "Sports Contest Result (Borussia Dortmund vs Real Betis; …) · Real Betis: Yes". Only the recurring price classes are given a meaning ("SOL above 94.882 at …"), because that is the only one the SDK defines. The raw spec is always shown in the details.

## Circle CCTP accuracy

The CCTP decoder mirrors Circle's own contracts rather than only the docs:
- `circlefin/hyperevm-circle-contracts` @ `ffcc978` (`CctpExtension`, `CctpForwarder`, `CctpForwarderHookData`, `CoreDepositWallet`). This was still the latest commit on 2026-11-03.
- `circlefin/evm-cctp-contracts` @ `a92a2b4` (`TokenMessengerV2`).

Addresses and fees come from Circle's docs (snapshot of 2026-10-29, saved in [transaction-lab](https://github.com/tyrasz/transaction-lab/tree/0a2777196280b9ea3d445101899cf52069b70106/research/arbitrum-deposit-v1/sources/docs)).

`test/circle-docs.test.ts` rebuilds the transactions in Circle's Arbitrum → HyperCore guide. It copies the guide's hook encoder and ABI verbatim and signs with a throwaway key, on Arbitrum Sepolia as written and on mainnet. It also covers the Ethereum guide's fee example.

What the contracts imply, and what the preview reports:
- **Funds stuck (danger).** Any of these makes `CctpForwarder.mintAndForward` or `CoreDepositWallet.depositFor` revert:
  - hook missing, shorter than 52 bytes, or not version 0 (this includes the guide's "no recipient" header-only hook and the Forwarding Service's version-1 format)
  - `mintRecipient` or `destinationCaller` not the forwarder, or the other network's forwarder
  - recipient is zero, HyperEVM USDC, `CoreDepositWallet` or the USDC system address

  Only the forwarder may complete these messages, so the burned USDC is never credited.
- **Source-chain revert (caution).** Gas is lost, but the USDC stays in the wallet:
  - `maxFee ≥ amount`
  - amount 0
  - empty hook on `depositForBurnWithHook`
  - `CctpExtension` total not a multiple of the batch size
  - expired authorization
- **Fees.** Credit is at least `amount − maxFee`. The CCTP contracts enforce this.
  - Arbitrum: the expected credit is `amount − 0.20` USDC. There is no fast-transfer fee, just the forwarding fee. Circle's example: 10 USDC → 9.80.
  - Ethereum: about `amount − (1 bp + 0.20 USDC + gas)`.
  - A `maxFee` below the documented fee gets a caution: automatic delivery isn't guaranteed. `mintAndForward` is callable by anyone with the attestation, so the transfer can still be completed manually.
- **Routing.**
  - A hook of 52–55 bytes routes to perps.
  - DEX IDs other than perps and spot fall back to the recipient's spot balance unless Circle has enabled them.
  - Magic bytes and the length field are ignored on-chain (noted, not flagged).
- **Docs vs contract.** Circle's concept page says "there is no minimum deposit amount". `CoreDepositWallet._sendAsset` (perps route only) can deduct a configurable `newCoreAccountFee` for recipients new to HyperCore, and reverts (funds stuck) if the deposit doesn't exceed it. The live fee was **0** on 2026-11-03, so the docs hold today. The preview shows an informational note on small perps deposits.
- **Smart-contract senders.** If the depositor's address has code (including an EIP-7702 delegation), USDC verifies the `ReceiveWithAuthorization` signature with ERC-1271. `CctpExtension` deposits from such wallets revert with `FiatTokenV2: invalid signature` unless the delegate supports it. The funds are safe; only gas is spent. Found during live simulation; the preview notes it.

### Live verification (2026-11-03)

`npm run verify:live` checks the previewer against the deployed contracts. It is read-only: it uses a fresh throwaway key and never broadcasts. It needs network access to `arb1.arbitrum.io`, `ethereum-rpc.publicnode.com` (or set `ETHEREUM_RPC_URL`), `rpc.hyperliquid.xyz` and `api.hyperliquid.xyz`, plus `sourcify.dev`, `api.openchain.xyz` and `www.4byte.directory`. It exits non-zero on any disagreement.

- **Circle docs.** All seven pages used here were re-fetched and are identical to the 2026-10-29 snapshot.
- **Arbitrum One.** `eth_simulateV1` runs the guide's transactions and 9 variants: perps, spot, standard finality, batch split, header-only hook, empty hook, `maxFee ≥ amount`, indivisible batch, expired authorization, low `maxFee`, and the `TokenMessengerV2` route with and without a hook. **12/12 match the preview.**
  - Success or revert, with the exact revert reason.
  - Burned amount equal to the previewed outflow.
  - "Will get stuck" exactly when the burn succeeds with an invalid hook.
  - The emitted `DepositForBurn` events carry the previewed amount, fee cap, finality, forwarder addresses and hook.
- **Batches.** An EIP-5792 batch of "approve `TokenMessengerV2`, then deposit 10 USDC to HyperCore" was run through `RpcSimulator` on Arbitrum One:
  - simulated on its own, the deposit reverts with "ERC20: transfer amount exceeds allowance", which is what batch previews used to show;
  - simulated in order, the batch succeeds, and its balance change is the simulated "out 10 USDC";
  - the allowance left afterwards reads "none", from USDC itself; the event alone would have said 10 USDC.
- **Kinetiq and HyperLend (HyperEVM).**
  - The docs sites weren't reachable from this environment, so identities were taken from the contracts themselves:
    - Kinetiq's StakingManager reports kHYPE as its token (`tokenAddress()`), and that kHYPE is both the address in Kinetiq's docs and Hyperliquid's own HyperCore link (spot token #121).
    - HyperLend's PoolAddressesProvider returns this Pool and calls itself "HyperLend Market". Its debt tokens point back to the Pool and use Aave's exact `DelegationWithSig` typehash.
  - Every function decoded here comes from verified source on Sourcify: Kinetiq's 7 facets, the instant-unstake pool, StakingAccountant and kHYPE, and HyperLend's `PoolInstance` and hTokens. HyperLend's debt-token implementation isn't on Sourcify; its functions were confirmed in its bytecode.
  - On 2026-11-04, the decoders' predictions matched `eth_call` on the live contracts in every case tried:
    - Kinetiq stakes below the minimum (`BelowMinimum`), not 8-decimal (`MustBeDivisibleBy1e10`), unstaking without kHYPE (`InsufficientTokenBalance`), claiming an unknown withdrawal (`InvalidWithdrawal`).
    - For two real HyperLend borrowers, the health-factor formula reproduced the Pool's own value to within 0.02%. Withdrawing all of a borrower's collateral was predicted to fail (HF → 0) and the chain refused it with `HealthFactorLowerThanLiquidationThreshold`.
  - `npm run verify:live` (step 9) repeats these checks daily.
- **Uniswap Universal Router.**
  - The command table and every input layout come from the routers' verified sources on Sourcify (`Commands.sol`, `Dispatcher.sol`, and v4-periphery's `V4Router`/`Actions`), for both versions.
  - On 2026-11-04, recent real router transactions were decoded: 15 on Ethereum and 12 on Arbitrum. For every successful one, the token paid and the token received in the headline matched the receipt's transfer logs. Native ETH, which Uniswap v4 and unwraps pay out as internal transfers, was checked through balance changes.
  - Every "output goes to another address" caution was confirmed by that address's balance change.
  - That data surfaced four fixes:
    - Permit2 expiries of 2^48−1 ("never") broke date formatting.
    - v4's max-uint128 "no limit" printed as a 39-digit amount.
    - Routes that mix v3 and v4 through an unwrap needed WETH and ETH treated as one asset.
    - An Arbitrum round trip (sell Dory for USDC, add USDC, buy Dory back) produced "Swap Dory for Dory". Headlines are now checked against what the wallet pays and receives; refunds of the input token are allowed. When they disagree, the title lists the flow instead: "Uniswap: pay Dory + USDC, receive Dory (10 steps)".
  - `npm run verify:live` repeats the comparison daily on the latest Ethereum router transactions.
- **NFTs and approvals set along the way.**
  - A Permit2 permit, signed by a throwaway key and run through Uniswap's Universal Router on Arbitrum (command `0x0a`), is listed as an unlimited USDC allowance for the router, with its expiry, and flagged as set along the way.
  - BAYC #1, moved by its current owner on Ethereum, shows as "out 1 BAYC #1", with the name read from the contract. BAYC's approval-clearing event is not listed.
- **Ethereum.** The `TokenMessengerV2` route from Circle's Ethereum guide, with a USDC balance override standing in for funding: perps, spot, standard finality, header-only hook (gets stuck), empty hook and `maxFee ≥ amount` (both revert). **6/6 match the preview**, by the same criteria.
- **Deployed configuration.** `CctpExtension` points at USDC and `TokenMessengerV2`. The forwarder routes USDC to `CoreDepositWallet`. The USDC system address is `0x2000…0000`. Perps forwarding is enabled. The forwarding fee is 0.20 USDC and the new-account fee is 0.
- **HyperEVM.** `CoreDepositWallet.depositFor` was called (with a USDC balance override) for new-account perps and spot deposits, which succeed, and for the system address, the wallet itself and zero, which revert with the reasons the preview cites.

- **Token metadata, proxies, ABIs and signatures.** See [What was verified](#what-was-verified-and-what-wasnt). Sourcify, OpenChain and 4byte are checked by the same script, including that a plain `transfer` still decodes as `transfer` despite 4byte's colliding spam entries.

- **HyperCore → other chains.** `CoreDepositWallet.coreReceiveWithData` is the HyperEVM step of Circle's withdrawal. It was called on HyperEVM from the USDC system address, and each outcome checked against the preview. **8/8 matched:**
  - success
  - fee-boundary reverts ("Amount must exceed maxFee": 0.20 reverts, 0.21 succeeds to Arbitrum)
  - an EVM chain ID used as the domain ("No TokenMessenger for domain")
  - fee-free custom data
  - the 1,024-byte data limit

  Withdrawal fees match `calculateCrossChainWithdrawalFee` for Ethereum, Arbitrum, Solana and Base. Live `spotMeta` confirms that USDC's HyperEVM link is the `CoreDepositWallet` and that native HYPE has none.

- **Hyperliquid's docs** (hyperliquid.gitbook.io, 2026-11-03) confirm:
  - The `Withdraw` (withdraw3) fee: "There is a $1 fee for withdrawing at the time of this writing", about 5 minutes to finalize.
  - That `agentSendAsset`'s "Destination must match the source address", so agents can only move funds between the owner's own balances.
  - That API wallets "sign on behalf of the master account or any of the sub-accounts". The `ApproveAgent` warning says exactly this.
  - Two actions newer than SDK 0.33.3, `cDeposit2` (agent staking) and `trailingStop`, which are now decoded.
- **Failed HyperCore → other-chain withdrawals.** On mainnet the route is unused right now. A scan of 160,000 HyperEVM blocks (about two days) found no `CrossChainWithdraw` events and no CCTP burns by the `CoreDepositWallet`, even though it emitted thousands of deposit events. So there were no real failures to inspect, and the testnet endpoints were not reachable from this environment. Circle documents that a withdrawal below the fee makes the HyperEVM step revert. Hyperliquid's docs make correct use of `sendToEvmWithData` the caller's responsibility. Neither documents a refund, so the preview flags these cases as danger and says the funds are at risk.

Not covered on HyperEVM yet:
- Kinetiq's kmHYPE (Markets by Kinetiq) and the institutional flowHYPE, HiHYPE and hylqHYPE deployments: their StakingManagers run different code from kHYPE's, which isn't published (not on Sourcify), so they're shown through signature guesses. vkHYPE is no longer listed in Kinetiq's docs.
- The native-HYPE gateway's address. Gateway calls are recognised by their Pool argument and verified source instead.

Still not verified live:
- What actually happens to the debited HyperCore balance when the HyperEVM withdrawal step reverts (see above).
- The CCTP attestation and `CctpForwarder.mintAndForward` itself, because minting needs Circle's attestation signature.
- Fallback to spot for DEX IDs that aren't enabled; HyperEVM's RPC has no trace API to observe it.
- USDC blacklisting on the destination. A blacklisted *sender* is caught by simulation: on Ethereum, a transfer from a USDC-blacklisted address previewed as "simulation reverted: Blacklistable: account is blacklisted". Whether a blacklisted HyperCore recipient blocks the mint is not checked.
- `CctpExtensionV2`. Its source isn't published, so a sponsored deposit's recipient can't be decoded from the signature.
- Circle's fee API (`iris-api.circle.com`), which this environment couldn't reach.

## Continuous integration

- **`.github/workflows/ci.yml`** runs on every push to `main` and on pull requests, on Node 22 and 24: `npm ci`, typecheck, tests and the browser build. It needs no network beyond npm.
  - A second job rebuilds the EntryPoint simulation code (`npm run build:entrypoints -- --check`) and fails if `src/entrypoint-simulations.ts` isn't what its pinned sources compile to. Its inputs come from npm and Sourcify, and are cached between runs.
- **`.github/workflows/replay-4337.yml`** replays recent UserOperations daily at 05:23 UTC (and on demand, with how many minutes to follow), with `npm run accuracy:4337 --strict`: Ethereum with EntryPoint v0.6, v0.7 and v0.8, Arbitrum One with v0.6, v0.7, v0.8 and v0.9, Base with v0.6 and v0.7, Polygon and BNB Chain with v0.7 and v0.8, and OP Mainnet with v0.7, each following new blocks for 40 minutes, three replays at a time and up to 600 operations, six chains-and-versions at a time (at most two on each chain's public RPC).
  - Each job's summary has its results, and its report (`report.json`, `replay.log`, and in `differing/` the row and full preview of each operation whose preview differed, `--differing`, to look at once its state is gone) is kept as a run artifact for 30 days. A last job (`scripts/replay-summary.ts`) puts one table across them in the run's summary: per chain and EntryPoint version, the operations, how many outcomes matched, ran whole, validated with the stand-in, came within 0.5% and 0.05% of the gas and matched in token movements, then the previews that differed and the operations simulated as calls alone.
  - A job fails when an operation's preview differs from its receipt (above), and a failed scheduled run opens an issue titled "UserOperation replays differ from receipts", or comments on the open one. Operations whose signature no stand-in takes only show in the summary: a shape to add, not a wrong preview. That covers calls simulated alone (their outcome reported, not failed) and accounts that reject the stand-in (their gas not judged, as their own signature check didn't run).
  - It is read-only, on the public RPCs unless `ETHEREUM_RPC_URL` / `ARBITRUM_RPC_URL` repository secrets are set; an archive RPC there would also let older operations be replayed.
- **`.github/workflows/replay-tx.yml`** replays recent transactions daily at 03:37 UTC (and on demand), with `npm run accuracy --strict`: Ethereum (with the fork simulator too), Arbitrum One, Base, OP Mainnet, Polygon and BNB Chain, each following new blocks for 30 minutes and up to 600 transactions from senders not seen earlier in the run. A transaction differs when its outcome, the sender's token movements (beyond 2 base units and a millionth), its native coin change or its approvals differ from the receipt, or its gas by 10% or more; smaller gas differences, and the OP Stack L1 fee estimate's spread, are listed in the summary. A last job (`scripts/replay-tx-summary.ts`) puts one table across the chains in the run's summary; a failed scheduled run opens an issue titled "Transaction replays differ from receipts", or comments on the open one. Read-only, on the public RPCs unless the chains' `*_RPC_URL` repository secrets are set.
- **`.github/workflows/verify-live.yml`** runs `npm run verify:live` daily at 03:41 UTC, and on demand from the Actions tab ("Run workflow").
  - It is read-only against Ethereum, Arbitrum One, HyperEVM and `api.hyperliquid.xyz`, and fails when the deployed contracts, fees or markets no longer match the previewer.
  - The log is kept as a run artifact for 30 days.
  - A failed scheduled run opens an issue titled "Live verification failed", or comments on the existing open one.
  - Calls retry only on rate limiting, so a throttled public RPC is not reported as a contract change. If a public RPC is down, the run fails and the log says which call.
  - It also checks the Sourcify, OpenChain and 4byte response formats. It runs with `VERIFY_LIVE_STRICT=1`, so an unreachable service fails the run instead of being skipped. Set an `ETHERSCAN_API_KEY` repository secret to include Etherscan.

Actions are pinned to commit SHAs (with the version in a comment), and workflows get read-only permissions except the issue-reporting job.

## Layout

```
src/preview.ts            entry point: routes EIP-1193 methods
src/evm/                  transaction decoders (Bridge2, CCTP, CoreWriter, system transfers, ERC-20, Uniswap Universal Router, any verified ABI, plain text)
src/evm/aggregators.ts    1inch v6, OKX DEX, MetaMask Swaps/Bridge, Across deposits; src/evm/entry-point.ts ERC-4337 EntryPoints; src/evm/relay.ts Relay; src/evm/beacon-deposit.ts staking deposits
src/evm/smart-account.ts  smart-account batches (ERC-7579/7821 execute, executeBatch); src/evm/eip7702.ts delegations
src/seaport.ts            Seaport orders (src/typed-data/seaport.ts signatures, src/evm/seaport.ts transactions)
src/safe.ts               Safe multisig transactions (src/typed-data/safe.ts SafeTx/SafeMessage/SafeOp, src/evm/safe.ts execTransaction)
src/evm/effects.ts        simulated balance changes (fungible and NFT) and approvals left in place
src/evm/kinetiq.ts        Kinetiq staking; src/evm/hyperlend.ts HyperLend, gateway and credit delegation; src/evm/hyperlend-isolated.ts isolated pools
src/evm/onchain.ts        cached read-only contract calls for decoders; src/errors.ts known custom errors
src/tokens.ts             token registries: token lists, on-chain metadata, impersonation check
src/abi.ts                ABI sources (Sourcify, Etherscan, static), proxy detection, signature databases
src/rpc.ts                JSON-RPC client and the lookup cache
src/typed-data/           EIP-712: Hyperliquid user-signed + L1, Permit/Permit2 (and UniswapX witnesses), ERC-4337 UserOperations, CoW and 1inch orders, generic
src/userop-hash.ts        v0.6/v0.7 UserOperations signed as their hash (personal_sign), checked against a supplied operation
src/hyperliquid/          /info client, asset resolution, L1 action hash
src/simulation.ts         eth_simulateV1 simulator + mock; src/fork-simulator.ts local EVM over fetched state; src/simulation-probe.ts the eth_call + state-override simulator
contracts/                SimulationProbe.sol (compiled into src/probe-code.ts by npm run build:probe)
src/interceptor.ts        dependency-free EIP-1193 wrapper
src/server.ts             HTTP API + demo server (src/cli.ts starts it: npm start / npx signing-preview)
openapi.json              OpenAPI 3.1 document for the HTTP API
mocks/data.ts             mock market/account data and sample requests
demo/                     demo dApp + wallet UI
```

Each decoder is a function `(tx, env) => Decoded | null`. To add one, insert it into `ADAPTERS` in `src/evm/transaction.ts` (or `TYPED_DATA_ADAPTERS` in `src/preview.ts`) before the generic fallbacks.

## License

[MIT](LICENSE). The test file `test/circle-docs.test.ts` quotes short code samples from Circle's documentation, marked as verbatim, so the tests match the documented transactions exactly. Those excerpts remain Circle's.
