# signing-preview

Turns any wallet signing request into a human-readable preview before the user signs. It covers Ethereum, Arbitrum One, HyperEVM (chain 999) and Hyperliquid's native HyperCore actions, with special handling for Arbitrum → Hyperliquid deposits.

It takes a standard EIP-1193 request (`{ method, params }`), the same object every dApp sends to every wallet. It returns plain JSON that any wallet, extension or backend can render.

```
"Withdraw 50 USDC to Arbitrum"
Withdraws 50 USDC from Hyperliquid to your address on Arbitrum One (a 1 USDC fee is deducted).
  You receive on Arbitrum (approx.)   49 USDC
```

This project started in [tyrasz/transaction-lab](https://github.com/tyrasz/transaction-lab) but shares no code with it.

## Quickstart

Requires Node.js 22.18 or later, which runs TypeScript directly.

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
| `GET /v1/health` | Liveness check. |
| `GET /v1/samples` | The demo's mock requests. |

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

**3. In-process library.** For a wallet or extension that runs the previewer locally, without the API (`dist/signing-preview.js` is a browser bundle of the same code):

```ts
import { previewRequest, StaticTokenRegistry, HttpHyperliquidInfo, RpcSimulator } from 'signing-preview';

const preview = await previewRequest(request, { chainId: 42161, account, origin }, {
  tokens: new StaticTokenRegistry(),
  hyperliquid: { mainnet: new HttpHyperliquidInfo() },
  simulator: new RpcSimulator({ 1: ETH_RPC, 42161: ARB_RPC }),   // optional
});
```

`npm run build` produces `dist/interceptor.js` and `dist/signing-preview.js`.

## What is decoded

| Flow | Request | Shown |
|---|---|---|
| Arbitrum → Hyperliquid, **Bridge2** | USDC `transfer` to `0x2df1…3df7` | Deposit amount and the credited Hyperliquid account. **Danger** below 5 USDC (funds lost), for a non-USDC token, or on the wrong chain. |
| Arbitrum → HyperCore, **Circle CCTP** (Circle's guide) | 1. `ReceiveWithAuthorization` signature on USDC; 2. `CctpExtension.batchDepositForBurnWithAuth` | Amount, batch split, HyperCore recipient, perps/spot, fee cap, guaranteed minimum and expected credit (0.20 USDC forwarding fee). **Danger** for every mistake that leaves funds stuck (see [Circle CCTP accuracy](#circle-cctp-accuracy)). |
| Ethereum/Arbitrum → HyperCore, **CCTP V2** | `TokenMessengerV2.depositForBurnWithHook` / `depositForBurn` | Same checks; plain CCTP transfers to any other domain are decoded too. Mainnets plus Ethereum Sepolia and Arbitrum Sepolia (→ HyperEVM testnet). |
| HyperCore → Arbitrum (and other chains), **Circle CCTP** | `SendToEvmWithData` with USDC (Circle's "Withdraw USDC from HyperCore to EVM chains") | Destination as a **CCTP domain** (3 = Arbitrum, not an EVM chain ID), automatic vs manual delivery, the live per-destination fee (Arbitrum/Base 0.20, Ethereum 1.20, Solana 0.50 USDC; 0 without forwarding), amount received and withdrawable balance. **Danger** when the HyperEVM step would revert: amount not above the fee, invalid domain, or data over 1,024 bytes. |
| HyperCore → Arbitrum, **Hyperliquid Withdraw** | `Withdraw` (withdraw3) | Arbitrum recipient, the 1 USDC fee, amount received and withdrawable perps balance. |
| HyperCore → HyperEVM | `SendAsset` / `SpotSend` to a system address (Circle's "Withdraw USDC from HyperCore to HyperEVM") | "Move X to HyperEVM", credited to the same address. **Danger** on a system address that doesn't match the token. |
| HyperEVM → other chains, **CCTP** | `TokenMessengerV2.depositForBurn(WithHook)` on HyperEVM | Amount, destination, recipient and whether delivery is automatic or manual. |
| Sponsored HyperCore deposits | `ReceiveWithAuthorization` to `CctpExtensionV2` | Recognised, with a caution that the recipient is bound into the nonce and can't be shown. |
| USDC gasless transfers | EIP-3009 `TransferWithAuthorization` / `ReceiveWithAuthorization` / `CancelAuthorization` | Amount, spender/recipient, validity window; warns that a transfer authorization works like sending the payment. |
| HyperCore **user-signed** actions | `eth_signTypedData_v4`, `HyperliquidSignTransaction` domain | All 17 types in `@nktkas/hyperliquid` 0.33.3: `Withdraw` (net of the 1 USDC fee), `UsdSend`, `SpotSend` (including HyperCore → HyperEVM via system address), `UsdClassTransfer`, `SendAsset`, `SendToEvmWithData`, `ApproveAgent`, `ApproveBuilderFee`, `TokenDelegate`, `CDeposit`/`CWithdraw`, `UserSetAbstraction`, `UserDexAbstraction`, `UserPortfolioMargin`, `LinkStakingUser` (danger: the staking account can later lock this account), `StakingLinkDisableTradingUser` (danger: irreversible), `ConvertToMultiSigUser`, `SendMultiSig`; unknown types list every field. Checks: imitation domains, testnet, expired or future timestamps, a token ID that doesn't match its label. |
| HyperCore **L1** actions | `Agent { source, connectionId }`, `Exchange` domain | **When the original action is supplied** (see below): orders (limit, trigger TP/SL, builder fee), cancels, modify, leverage, isolated margin, top-up margin, TWAP, scheduled cancel, borrow/lend, vault create/modify/distribute/transfer, sub-account transfers (USDC and spot), rename, rewards, referrals, display name, spot dusting, HyperEVM block size. Markets are resolved on main perps, spot, **HIP-3 builder DEXes** and **outcome markets**. Perp orders are margin-checked on their own DEX (skipped for unified/portfolio-margin accounts); spot orders are checked against spot balances. Deployer, validator, agent and outcome-share actions are decoded too, with warnings for oracle updates, trading halts, fee-recipient and permission changes, market settlement, HYPE-spending auctions and backstop-liquidator deposits. |
| HyperEVM → HyperCore | CoreWriter `sendRawAction` | All CoreWriter actions (IDs 1–13, 15, 16), with 1e8 price/size scaling. Notes that HyperCore runs the action asynchronously, so a failure there doesn't revert the EVM transaction. |
| HyperEVM → HyperCore | HYPE to `0x2222…`, ERC-20 to `0x20…<index>` | "Move X to HyperCore". **Danger** if the token isn't the contract linked to that index. |
| Ethereum / Arbitrum / HyperEVM | ERC-20 transfer/approve/transferFrom, `setApprovalForAll`, WETH, Permit2 `approve`, native sends, contract creation | Amounts with the token's symbol and decimals. Warns on unlimited approvals, zero-value transfers and transfers to the token contract itself. |
| Off-chain approvals | ERC-2612 / DAI `Permit`, Permit2 `PermitSingle/Batch/TransferFrom` | Spender, amount and expiry; flags unlimited or long-lived permissions and owner mismatches. |
| Messages | `personal_sign`, SIWE, `eth_sign` | Readable text; SIWE domain vs. requesting origin (phishing); `eth_sign` is always danger. |
| Batches | `wallet_sendCalls` (EIP-5792) | Each call previewed, with warnings merged. |
| Anything else | unknown calldata | `opaque`, with the selector shown. Simulated balance changes are added when a simulator is configured. |

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
  assetChanges: [{ direction, account, amount, symbol, raw?, asset?, basis }],
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

Neither is a measured final balance. Fee-on-transfer or rebasing tokens, and state changes before inclusion, can differ.

## Mock and live data

`npm start` uses mock data. To use real data:

```bash
SIGNING_PREVIEW_MODE=live ETHEREUM_RPC_URL=… ARBITRUM_RPC_URL=… HYPEREVM_RPC_URL=… npm start
```

Live mode reads Hyperliquid's public `/info` API and simulates with `eth_simulateV1` on any chain that has an RPC URL configured. Chains without one are previewed from the decoded request only. **Live mode has not been exercised against real endpoints yet.** Its RPC and `/info` clients are covered by tests with stubbed responses only.

## What was verified, and what wasn't

- **L1 action hashing** matches vectors generated by the official `hyperliquid-python-sdk` 0.24.0 (`test/fixtures/l1-action-hashes.json`). That covers plain, vault and `expiresAfter` cases. User-signed type layouts were checked against the same SDK.
- **CoreWriter** action IDs, field types, TIF codes and system-address formats were checked against `hyperliquid-dev/hyper-evm-lib` (`HLConstants.sol`, `CoreWriterLib.sol`).
- **Not independently verified:**
  - The units for CoreWriter USD amounts (1e6) and builder-fee rates are assumptions.
  - `CDeposit`/`CWithdraw` field names, the Bridge2 5 USDC minimum and the 1 USDC withdrawal fee follow Hyperliquid's documentation, but weren't re-checked here because the docs site isn't reachable from the environment this was built in.

  Confirm all of these against current official docs before relying on them.
- The known-token list is short (`src/chains.ts`). Unknown tokens are shown in base units with a warning. Add a token list or on-chain `symbol()`/`decimals()` lookups through the `TokenRegistry` interface.
- There is no threat-intelligence feed. Warnings are rule-based observations, and `attention: 'none'` doesn't mean "safe".

## HyperCore coverage

Checked against `@nktkas/hyperliquid` 0.33.3 (every exchange action) and `hyperliquid-python-sdk` 0.24.0:
- **Wallet-signed actions: 17/17.**
- **L1 actions: 42/42**, including every variant of the union actions: 16 `perpDeploy` (HIP-3 deployer), 9 `spotDeploy` plus 4 outcome-deployer (HIP-4) variants, 3 `CValidatorAction`, 2 `CSignerAction` and 4 `userOutcome`. Agent-wallet actions (`agentSendAsset`, `agentSetAbstraction`, `agentEnableDexAbstraction`) are decoded too, but are normally signed by an API wallet rather than a user's wallet.
- **CoreWriter actions: 15/15.**

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

`npm run verify:live` checks the previewer against the deployed contracts. It is read-only: it uses a fresh throwaway key and never broadcasts. It needs network access to `arb1.arbitrum.io` and `rpc.hyperliquid.xyz`, and exits non-zero on any disagreement.

- **Circle docs.** All seven pages used here were re-fetched and are identical to the 2026-10-29 snapshot.
- **Arbitrum One.** `eth_simulateV1` runs the guide's transactions and 9 variants: perps, spot, standard finality, batch split, header-only hook, empty hook, `maxFee ≥ amount`, indivisible batch, expired authorization, low `maxFee`, and the `TokenMessengerV2` route with and without a hook. **12/12 match the preview.**
  - Success or revert, with the exact revert reason.
  - Burned amount equal to the previewed outflow.
  - "Will get stuck" exactly when the burn succeeds with an invalid hook.
  - The emitted `DepositForBurn` events carry the previewed amount, fee cap, finality, forwarder addresses and hook.
- **Deployed configuration.** `CctpExtension` points at USDC and `TokenMessengerV2`. The forwarder routes USDC to `CoreDepositWallet`. The USDC system address is `0x2000…0000`. Perps forwarding is enabled. The forwarding fee is 0.20 USDC and the new-account fee is 0.
- **HyperEVM.** `CoreDepositWallet.depositFor` was called (with a USDC balance override) for new-account perps and spot deposits, which succeed, and for the system address, the wallet itself and zero, which revert with the reasons the preview cites.

- **HyperCore → other chains.** `CoreDepositWallet.coreReceiveWithData` is the HyperEVM step of Circle's withdrawal. It was called on HyperEVM from the USDC system address, and each outcome checked against the preview. **8/8 matched:**
  - success
  - fee-boundary reverts ("Amount must exceed maxFee": 0.20 reverts, 0.21 succeeds to Arbitrum)
  - an EVM chain ID used as the domain ("No TokenMessenger for domain")
  - fee-free custom data
  - the 1,024-byte data limit

  Withdrawal fees match `calculateCrossChainWithdrawalFee` for Ethereum, Arbitrum, Solana and Base. Live `spotMeta` confirms that USDC's HyperEVM link is the `CoreDepositWallet` and that native HYPE has none.

Still not verified live:
- What happens to the debited HyperCore balance when the HyperEVM withdrawal step reverts; Circle doesn't document it, and the preview says so.
- Hyperliquid's native `Withdraw` fee (1 USDC), which comes from Hyperliquid's docs.
- The CCTP attestation and `CctpForwarder.mintAndForward` itself, because minting needs Circle's attestation signature.
- Fallback to spot for DEX IDs that aren't enabled; HyperEVM's RPC has no trace API to observe it.
- Recipient blacklist state.
- `CctpExtensionV2`. Its source isn't published, so a sponsored deposit's recipient can't be decoded from the signature.
- Circle's fee API (`iris-api.circle.com`), which this environment couldn't reach.

## Layout

```
src/preview.ts            entry point: routes EIP-1193 methods
src/evm/                  transaction decoders (Bridge2, CCTP, CoreWriter, system transfers, ERC-20)
src/typed-data/           EIP-712: Hyperliquid user-signed + L1, Permit/Permit2, generic
src/hyperliquid/          /info client, asset resolution, L1 action hash
src/simulation.ts         eth_simulateV1 simulator + mock
src/interceptor.ts        dependency-free EIP-1193 wrapper
src/server.ts             HTTP API + demo server
mocks/data.ts             mock market/account data and sample requests
demo/                     demo dApp + wallet UI
```

Each decoder is a function `(tx, env) => Decoded | null`. To add one, insert it into `ADAPTERS` in `src/evm/transaction.ts` (or `TYPED_DATA_ADAPTERS` in `src/preview.ts`) before the generic fallbacks.

## License

[MIT](LICENSE). The test file `test/circle-docs.test.ts` quotes short code samples from Circle's documentation, marked as verbatim, so the tests match the documented transactions exactly. Those excerpts remain Circle's.
