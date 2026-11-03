# Solana execution provider

Provider selected: **Jupiter Swap API V2**, official HTTPS API at `https://api.jup.ag/swap/v2`, using the existing pinned `@solana/web3.js` 1.98.4. No extra SDK, custodial GMGN trader, or multi-chain adapter is introduced.

Official sources checked on 2026-10-28:

- [Swap API](https://developers.jup.ag/docs/swap)
- [GET /order: request parameters and response contract](https://developers.jup.ag/docs/api-reference/swap/order)
- [POST /execute: signed transaction and managed landing](https://developers.jup.ag/docs/api-reference/swap/execute)
- [Routing and market listing](https://developers.jup.ag/docs/swap/routing/amm/market-listing)
- [Circle USDC mint](https://developers.circle.com/stablecoins/usdc-contract-addresses)

Authentication: optional `JUPITER_API_KEY` in `x-api-key`; keyless requests succeeded during this implementation. Official overview lists keyless 0.5 requests/sec, Free key 1/sec, Developer 10/sec, Launch 50/sec and Pro 150/sec; execute has a separate bucket. The implementation spaces requests 2.2 seconds apart and never retries POST execute. Check current official limits for the selected plan.

The implementation selects **Metis only**, excluding JupiterZ, Dflow and OKX. This limits signing to one configured wallet/fee payer and gives a concrete transaction program boundary. It can miss a route available through other routers. Jupiter's official market-listing documentation explicitly includes Pump.fun and Pump.fun AMM in instant routing. Coverage is conditional on market availability and routing liquidity; an absent route is a skip, never a fallback to GMGN execution. Standard SPL tokens, a validated subset of Token-2022 extensions, and version-0 transactions are supported. Unsupported extensions and transaction layouts reject the candidate; see [Token-2022 policy](token-2022-support.md).

## Quote and BUY

1. Read current wallet SOL and token balances. Normal principal is integer `(balance − fee reserve − pending reserve) / 100`. Claim the unique durable intent; no silent resizing.
2. GET `/order` with wrapped-SOL input mint, selected token output mint, exact atomic amount, taker, ExactIn, fixed slippageBps, version ceiling 0, Metis only. Priority fee is capped at 100,000 lamports with maxCap.
3. Check wallet, fee payer, chain, direction, both mints, exact amount, route endpoints, quote age ≤20 seconds, minimum output and slippage. Minimum-output validation permits the provider's integer floor rounding.
4. Obtain **quote-only** reverse `/order` estimates without taker for exactly 20%, 50% and 100% of expected BUY output, rounded down in atomic units. Distinguish a technical route from an economically meaningful exit. By default at least one 20%/50% level must have minimum SOL output minus conservative costs of at least 10,000 lamports; costs use the greater of quoted costs and a 110,000-lamport budget. These estimates neither sign nor prove future executability. Bind them to the exact BUY quote/output, policy and freshness window; revalidate before signing. See [full policy and acceptance evidence](trending-discovery-exit-feasibility.md).
5. Deserialize the actual transaction and resolve only its address lookup tables. Enforce configured single signer and allowed top-level programs (Jupiter V6, System, SPL Token, ATA, Compute Budget). System transfers must fund the wallet's own wrapped-SOL ATA and sum to exactly the approved BUY principal. Unrelated recipients, authority changes and unsupported token instructions are rejected. SELL may not contain a SOL principal transfer.
6. Simulate unsigned through RPC. Compare wallet SOL and token-ATA balances, minimum output, exact SELL input, and bounded fees. Check on-chain mint and decimals against normalized GMGN/position decimals. Recheck wallet balances, intent expiry and final RiskEngine approval before signing.
7. Load only the local backend key; verify its public address. Sign and durably persist the derived transaction signature **before any network submission**. POST `/execute` once, with signedTransaction, requestId and lastValidBlockHeight. Signed payloads are not persisted or logged.
8. Poll bounded signature status; require an actual confirmed receipt and actual wallet balances matching receipt deltas before OPEN. Save signature, token quantity, SOL spent (including wallet costs), entry reference, remaining amount, and evidence.

## SELL

Jev chooses normal strategic HOLD, partial or full SELL using current position, GMGN Capital Flow and available historical evidence; manual/security/liquidity protection overrides it. Legacy TP/trailing thresholds are references only. There is no price/PnL stop loss, mandatory holding-time exit or profit ceiling. See [current policy and live evidence](capital-flow-adaptive-manager.md). The Executor reads a fresh wallet token balance, requests a fresh token → wrapped-SOL/native settlement order for the exact tracked atomic amount, validates and simulates it, signs locally, persists the signature, and executes once. Confirmation and reconciled SOL/token balances are mandatory. A full tracked exit becomes CLOSED only after that evidence; partial exits remain OPEN with allocated cost basis. The smoke SELL is limited to `balanceAfterBuy − balanceBeforeBuy` and leaves existing holdings untouched.

## Fees and failures

Slippage is fixed by the bot (default 100 bps), never accepted above configured maximum. Jupiter returns minimum output, platform fee context, network/priority and rent estimates. Actual network fees come from transaction metadata. A token account may retain rent after the round trip; this is reported separately and is not mislabelled as a network fee. Smoke stops after SELL and does not spend a third transaction closing that account.

The optional `priceImpactPct` field may be unavailable or carry a negative sentinel such as `-1`; it is normalized to UNKNOWN, never zero. Mandatory wallet, mint, amount, output, fee, route, transaction and simulation checks still apply. Unknown impact does not itself fail the configured net-output policy; it is not evidence of low impact. Post-entry quote refreshes are bounded, lower priority than execution and only inform Jev; they cannot independently force SELL.

A malformed quote, no route, incompatible mint/layout, unsafe transaction, stale quote, simulation failure or unavailable budget blocks before broadcast. Transaction build failures have explicit codes; no amount is increased to satisfy a minimum. HTTP failure after signature persistence remains UNKNOWN until chain reconciliation, regardless of Jupiter's status text. No automatic submission retries. Failure after a confirmed BUY reports remaining tokens, signature and SELL error prominently.

Startup discards CREATED intents without replay, reconciles saved signatures for SUBMITTED/PENDING_CONFIRMATION/UNKNOWN, and restores local monitoring. A legacy GMGN pending/open position pauses entries for review. Legacy source schema/data are preserved rather than rewriting history.

Real evidence: [VERIFICATION.md](VERIFICATION.md). This provider completed one real USDC BUY/SELL round trip on the owner's wallet; that verifies the selected route, not every Pump.fun market.
