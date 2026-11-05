# signing-preview

[![CI](https://github.com/tyrasz/signing-preview/actions/workflows/ci.yml/badge.svg)](https://github.com/tyrasz/signing-preview/actions/workflows/ci.yml) [![Live verification](https://github.com/tyrasz/signing-preview/actions/workflows/verify-live.yml/badge.svg)](https://github.com/tyrasz/signing-preview/actions/workflows/verify-live.yml)

Turns any wallet signing request into a human-readable preview before the user signs. It covers Ethereum, Arbitrum One, HyperEVM (chain 999) and Hyperliquid's native HyperCore actions, with special handling for Arbitrum → Hyperliquid deposits.

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
| HyperEVM, **Kinetiq** liquid staking | `stake`, `queueWithdrawal`, `confirmWithdrawal` / `batchConfirmWithdrawals`, `instantUnstake`, `redelegate` on the StakingManager | "Stake 10 HYPE for ≈ 9.7315 kHYPE", "Unstake 100 kHYPE: ≈ 102.759 HYPE claimable in 7 days", "Instant unstake … for ≈ X HYPE (0.1% fee)". With an RPC, live values: rate, fees, delays (7 days, or 36 hours when Kinetiq's buffer covers it), Kinetiq's own instant-unstake quote, and when each queued withdrawal becomes claimable. **"This will fail"** for a stake below the minimum (5 HYPE), an amount that isn't a multiple of 0.00000001 HYPE (HyperCore keeps 8 decimals), paused staking or withdrawals, a claim that isn't ready, an empty instant-unstake buffer or a quote below your minimum. |
| HyperEVM, **HyperLend** | Pool `supply`, `withdraw`, `borrow`, `repay` (and `…WithPermit`, `repayWithATokens`), collateral and e-mode switches, `approvePositionManager`, `liquidationCall`; the native-HYPE gateway | Plain-language actions ("Borrow 3,000 USDC from HyperLend", "Withdraw all your WHYPE"), "all" for max amounts, and the **health factor before → after**, from your live position, oracle prices and each market's liquidation threshold (e-mode aware). **Danger** below 1.1; **caution** below 1.5; **"this will fail"** when HyperLend would refuse (borrowing beyond the limit, leaving HF < 1). **Caution** for a position manager, which can switch your collateral and e-mode. Gateway calls are trusted only when the contract's verified source is a WrappedTokenGateway pointing at HyperLend's Pool. |
| Credit delegation (HyperLend, any Aave-style market) | `approveDelegation` on a debt token; `DelegationWithSig` signatures | **Danger**: the delegatee can borrow in your name, against your collateral, and the debt is yours. Named as HyperLend when the debt token's Pool is HyperLend's and lists it. |
| HyperEVM → HyperCore | CoreWriter `sendRawAction` | All CoreWriter actions (IDs 1–13 and 15–17), with 1e8 price/size scaling. Notes that HyperCore runs the action asynchronously, so a failure there doesn't revert the EVM transaction. |
| HyperEVM → HyperCore | HYPE to `0x2222…`, ERC-20 to `0x20…<index>` | "Move X to HyperCore". **Danger** if the token isn't the contract linked to that index. |
| Ethereum / Arbitrum / HyperEVM | ERC-20 transfer/approve/transferFrom, `setApprovalForAll`, WETH, Permit2 `approve`, native sends, contract creation | Amounts with the token's symbol and decimals. Warns on unlimited approvals, zero-value transfers and transfers to the token contract itself. |
| Off-chain approvals | ERC-2612 / DAI `Permit`, Permit2 `PermitSingle/Batch/TransferFrom` | Spender, amount and expiry; flags unlimited or long-lived permissions and owner mismatches. |
| Messages | `personal_sign`, SIWE, `eth_sign` | Readable text; SIWE domain vs. requesting origin (phishing); `eth_sign` is always danger. |
| **EIP-7702** account delegation | `authorizationList` in `eth_sendTransaction` (type-4), unsigned or signed | Which account is delegated to which contract (named when its source is verified), on which chain (`chainId` 0 = every chain). **Danger** when your own account would run another contract's code; information for authorizations signed by other accounts (a sponsor relaying them) and for revocations. The simulator doesn't apply authorizations, so such transactions aren't simulated. "Delegate your account to X" when nothing else happens. |
| Batches | `wallet_sendCalls` (EIP-5792) | Each call previewed, with warnings merged. The calls are simulated **in order in one block**, so "approve, then swap" isn't shown as failing, and balance changes are netted across the batch. **Danger** when a call in an all-or-nothing (`atomicRequired`) batch would fail, since then none take effect; **caution** for a non-atomic batch, where the other calls may still go through. A custom simulator without `simulateBatch` simulates only the first call and says why. |
| Uniswap **Universal Router** | `execute(commands, inputs[, deadline])` and `executeSigned` on Uniswap's official routers: 2.1.1, 2.1.2 and 2.2.0 (current), 2.0 (Uniswap v4) and 1.2, on Ethereum, Arbitrum and HyperEVM | One headline for the trade ("Swap 1 ETH for at least 3,150 USDC"), summing split routes and following chained hops through wrap/unwrap, then every command as a step: v2/v3/v4 swaps with fee tiers and per-hop minimum prices, Permit2 permits and transfers, wrap/unwrap, sweep, pay, fee portions, balance checks, sub-plans, v3/v4 position-manager calls, **Across bridging** ("…, then bridge to Base"), and v1.2's NFT-marketplace purchases. `executeSigned` shows who signed the route. **Caution** when output goes to another address (on this chain or the bridge's destination), when nothing limits slippage (minimum received 0 and no per-hop prices), when the deadline has passed, or for a Permit2 allowance to an address other than the router; **danger** for a fee portion of 10% or more. Command tables differ between releases (0x10 is a Seaport purchase on 1.2 and a v4 swap now; 2.1 adds fields to every swap), so only known router addresses are decoded, each with its release's table. The original 1.0 router isn't decoded. |
| Any other contract | calldata to a contract with a verified ABI (Sourcify, Etherscan or your own), including through proxies | Contract name, function and named arguments. Addresses are labelled ("you", token symbols) and amounts are shown in the right token's units. **Caution** for ownership, upgrade and role changes. See [Contract and token lookups](#contract-and-token-lookups). |
| | no verified ABI, but a known selector | The function from the built-in list or a signature database, marked **unverified** (`partial`). The match must re-encode to exactly the signed calldata, and the most trusted source decides when several fit (see below). |
| Plain-text calldata | data that is entirely printable UTF-8: `data:` URI inscriptions (Ethscriptions and similar), on-chain messages | The text, or for a JSON inscription its protocol operation ("Inscription: edmt emt-batch-transfer enat"), noting that an off-chain indexer decides its effect. Invisible and text-reordering characters are removed and flagged. Full when the recipient has no code; **caution** when it's a contract (it receives the text as input) or can't be checked. |
| Anything else | unknown calldata | `opaque`, with the selector shown. Simulated balance changes are added when a simulator is configured. |
| Simulated effects (any transaction) | `eth_simulateV1` logs and state; on HyperEVM, balances and permissions read before and after through `eth_call` ([how](#contract-and-token-lookups)) | Balance changes for native, ERC-20, **ERC-721 and ERC-1155** (e.g. "+1 BAYC #42"). **Permissions left in place**: ERC-20 and Permit2 allowances, single-NFT approvals and `setApprovalForAll`, read back from the tokens after the simulated transaction. One set *along the way* by another call (a router writing a Permit2 allowance, a smart account's `execute`) is flagged: unlimited allowances and single NFTs with **caution**, all-NFT approvals with **danger**. |

### Hyperliquid L1 actions: the one real limit

For orders, cancels and leverage changes, the wallet only signs the hash of the action. **No previewer can recover the action from the signing request alone.** The Hyperliquid web app avoids wallet prompts for these by approving a local agent key once (`ApproveAgent`, fully decoded here). So when one of these hashes reaches the user's main wallet, the default preview says the contents are hidden and advises caution.

A dApp or integrator that holds the action can pass it as `context.hyperliquid = { action, nonce, vaultAddress?, expiresAfter? }`. The previewer re-hashes it and decodes it **only if** the hash equals the signed `connectionId`. Otherwise it reports a **danger** mismatch.

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
- `simulated_events`: transfer events from `eth_simulateV1`.
- `simulated_state`: balances read before and after the simulated call, on chains whose RPC has no `eth_simulateV1` (HyperEVM; see below).

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
SIGNING_PREVIEW_MODE=live ETHEREUM_RPC_URL=… ARBITRUM_RPC_URL=… HYPEREVM_RPC_URL=… npm start
```

Live mode reads Hyperliquid's public `/info` API and simulates on any chain that has an RPC URL configured: with `eth_simulateV1`, or, where the RPC lacks it, with `eth_call` and a state override (HyperEVM). Chains without one are previewed from the decoded request only. The RPC URLs also enable on-chain token metadata and proxy detection.

| Variable | Effect |
|---|---|
| `ETHEREUM_RPC_URL`, `ARBITRUM_RPC_URL`, `HYPEREVM_RPC_URL` | Simulation, `symbol()`/`decimals()` lookups and proxy detection on that chain. |
| `TOKEN_LIST_FILE` | A [tokenlists.org](https://tokenlists.org)-format JSON file, consulted after the built-in tokens. |
| `ETHERSCAN_API_KEY` | Adds Etherscan (API v2: Ethereum, Arbitrum and HyperEVM with one key) after Sourcify. |
| `SIGNING_PREVIEW_OFFLINE_LOOKUPS=1` | Don't call Sourcify, Etherscan, OpenChain or 4byte. The built-in signature list still works. |

`liveDependencies()` was run against Ethereum, Arbitrum One and HyperEVM, with Sourcify, OpenChain and 4byte, on 2026-11-04. Token metadata, proxy detection, verified-ABI and signature decoding and simulation all worked. A first preview of an uncached contract took 0.4–1.8 s. The `/info` client is checked live by `npm run verify:live`.

Any RPC works if it supports `eth_simulateV1`, or `eth_call` with state overrides. Verification used these public, keyless endpoints:
- Ethereum: `https://ethereum-rpc.publicnode.com` (PublicNode)
- Arbitrum: `https://arb1.arbitrum.io/rpc`
- HyperEVM: `https://rpc.hyperliquid.xyz/evm`

Public endpoints can rate-limit or change without notice; use your own provider in production.

## Contract and token lookups

**HyperEVM simulation.** The public RPC (`rpc.hyperliquid.xyz/evm`) has no `eth_simulateV1`, `debug_traceCall` or `trace_call`, and serves only the latest state. It does have `eth_call` with state overrides. `RpcSimulator` notices the missing method once and simulates with **`SimulationProbe`** (`contracts/SimulationProbe.sol`) instead:
- One `eth_call` sets the probe as the code of the sending account and runs the transaction (or a whole batch, in order) through it, from that account. The target sees the real sender as `msg.sender` and `tx.origin`.
- Around each call the probe reads the native balance, ERC-20 balances, allowances, Permit2 allowances, `isApprovedForAll`, and NFT ownership and approvals by token ID. The differences become the same balance changes and approvals that `eth_simulateV1`'s logs give, with basis `simulated_state`. Native HYPE received through an internal call (unwrapping WHYPE) shows too, which logs alone don't.
- Without logs, only what is read is seen: the tokens the calls name (their targets, the addresses in their calldata, nested calldata and packed Uniswap paths), HyperEVM's built-in tokens, and tokens decoders name (HyperLend's hTokens and debt tokens). The preview says how many tokens were read.
- With code at the account, contracts may treat it differently. The probe answers ERC-1271 `isValidSignature` the way the account's key would (`ecrecover`), and accepts NFTs as an account without code does. A contract that refuses senders with code makes the probe fail; a plain `eth_call` then confirms the call works, and the preview says its balance changes couldn't be measured.
- Calls run at the latest block's timestamp, so a result that depends on the exact time can differ slightly.
- An RPC that also ignores state overrides falls back to `eth_call` alone: success or failure and the revert reason, for single calls only.
- `src/probe-code.ts` holds the compiled bytecode; `npm run build:probe` rebuilds it with the pinned solc, and a test checks it matches the source.

How it was checked:
- On Ethereum, whose RPC still has the exact state before recent blocks, 240 transactions from one-off senders were simulated at their parent block with the shipped code and compared with their receipts. 237 succeeded as on-chain (the other 3 depended on an earlier transaction in the same block). 231 of the 235 token movements were found, 230 with the exact amount, and no movement was reported that didn't happen. 8 of the 10 approvals were found; the other two were granted and spent in the same transaction. In an earlier run of the same comparison, the probe and `eth_simulateV1` agreed on 232 of 233 outcomes; the other depended on the block time.
- On HyperEVM, live (`npm run verify:live`, step 10): a Kinetiq stake of 10 HYPE matches Kinetiq's own `HYPEToKHYPE` quote to the wei, a USDC transfer moves exactly 1 USDC, and approve + HyperLend supply in one batch gives −1 USDC and +0.999999 hUSDC (Aave-style balances round). Before that, 8 constructed flows matched independently computed values, including a WHYPE unwrap, a CoreDepositWallet deposit, HYPE to HyperCore and a below-minimum stake.
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

## Coverage of real traffic

`npm run coverage` previews every transaction in blocks sampled evenly across the last 24 hours, as if each were an `eth_sendTransaction` request, and reports how much is readable, what crashed, and what is left. Pass 1 uses only the built-in decoders and lists; pass 2 adds what `liveDependencies()` would look up (Sourcify for the busiest unreadable contracts, OpenChain for their selectors). It needs the three RPCs, `sourcify.dev` and `api.openchain.xyz`.

```bash
npm run coverage -- --hours 24 --eth 300 --arb 1500 --hyperevm 1500 --out report.json
```

Run on 2026-11-05 (pass 2 figures; "readable" is full + partial):

| | Ethereum | Arbitrum One | HyperEVM |
|---|---|---|---|
| Sample | 300 of 7,179 blocks: 81,367 txs | 1,500 of 304,223 blocks: 6,231 txs (1,506 ArbOS system txs excluded) | 1,500 of 87,840 blocks: 13,293 txs |
| Full / partial / opaque | 71.8% / 18.8% / 9.4% | 39.7% / 14.1% / 46.2% | 52.0% / 12.2% / 35.8% |
| Readable without lookups (pass 1) | 73.6% | 27.6% | 12.7% |
| Readable, standard ABI-encoded calldata only | 95.4% | 78.2% | 80.1% |
| Readable, occasional senders only | 94.9% | 76.6% | 78.4% |
| Share of the opaque rest sent by automated senders | 70.3% | 82.5% | 92.4% |
| Crashes | 0 | 0 | 0 |

"Automated" means the sender appears in 3 or more of the sampled blocks, which are minutes apart: bots, relayers and exchanges sending around the clock. What stays opaque is mostly:

- **Packed calldata** (Ethereum 3,889, Arbitrum 1,668, HyperEVM 2,461 txs): any length other than selector + 32-byte words, a custom encoding no ABI describes, used by trading bots.
- **Vanity selectors** (230 / 283 / 183): ABI-shaped, but with selectors mined to start with zero bytes to save gas, also bots.
- **ABI-shaped calls to contracts with no published source** (3,500 / 928 / 2,119), and whose selectors aren't in a signature database. Two such contracts (`0x278d…f8d2`, `0x93c3…dd17`) are among the busiest on all three chains.

The first run found and fixed 26 crashes (a "never expires" Permit2 approval and struct-item multicalls, now in `test/mainnet-regressions.test.ts`). It also showed that the busiest unreadable contract on Ethereum was Uniswap's current Universal Router 2.1.2, and that the busiest unreadable "contract" was an account with no code receiving text inscriptions. Both are decoded now.

Not covered, whatever the sample says:

- **ERC-4337 UserOperations.** The UserOperations inside a bundler's `handleOps` call aren't previewed one by one, and a smart account's signature over a UserOperation hash isn't an EIP-1193 transaction.
- **The call part of a self-delegating EIP-7702 transaction.** The delegation is decoded and flagged, but a call to your own address is decoded against the account's current code, not the new delegate's.
- **Universal Router 1.0** (an older, NFT-era command table). Other DEX routers are shown through their verified ABI (function and arguments), without a swap headline.
- **Simulation on HyperEVM** reads balances instead of logs (see [HyperEVM simulation](#contract-and-token-lookups)), so a token the transaction doesn't name, and no decoder adds, can be missing; and its RPC serves only the latest state.
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
- HyperLend's isolated (Fraxlend-style) pools, and Kinetiq products other than kHYPE staking (such as the vkHYPE vault): their addresses weren't available without the docs sites.
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
src/evm/effects.ts        simulated balance changes (fungible and NFT) and approvals left in place
src/evm/kinetiq.ts        Kinetiq staking; src/evm/hyperlend.ts HyperLend, gateway and credit delegation
src/evm/onchain.ts        cached read-only contract calls for decoders; src/errors.ts known custom errors
src/tokens.ts             token registries: token lists, on-chain metadata, impersonation check
src/abi.ts                ABI sources (Sourcify, Etherscan, static), proxy detection, signature databases
src/rpc.ts                JSON-RPC client and the lookup cache
src/typed-data/           EIP-712: Hyperliquid user-signed + L1, Permit/Permit2, generic
src/hyperliquid/          /info client, asset resolution, L1 action hash
src/simulation.ts         eth_simulateV1 simulator + mock; src/simulation-probe.ts the eth_call + state-override simulator
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
