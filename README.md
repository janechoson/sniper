# BOT B: GMGN intelligence, Jev decisions, local Solana execution

One Node.js 22+ process, one local wallet, TypeScript, pnpm, SQLite WAL and a localhost dashboard.

```text
GMGN discovery / market / security / holders / developer history
  → cheap filter → TypeSafe System One (jev-1.14.0)
  → deterministic RiskEngine → approved exact integer amount
  → Jupiter BUY quote + 20/50/100% quote-only exit feasibility
  → transaction inspection + simulation + fresh quote/probe binding
  → backend wallet signature → Jupiter managed submission
  → Solana confirmation + receipt and actual balance reconciliation
  → persisted position → independent market monitor → bounded Jev exit scheduler
  → user/security override → persistent exit queue → Jupiter SELL → reconciliation
```

GMGN cannot execute trades: its runtime command allowlist contains data commands only. No paid GMGN trading entitlement is required. RPC never indexes discovery, holders, launchpads or developer history.

Trending and Trenches/Sniper feed one deduplicated queue. Trending gets priority; bounded aging and a Sniper analysis slot prevent starvation of retained eligible candidates. BUY requires at least one configured partial exit level to cover conservative execution costs and the minimum net SOL margin. Quote-only exit estimates never sign transactions or guarantee future liquidity. Owned positions refresh these estimates in a bounded background worker for Jev context. See [implementation, verification and actual LIVE limitations](docs/trending-discovery-exit-feasibility.md).

Sniper entries now require observed selling, absorption and persistent buyer recovery. Otherwise eligible tokens enter a bounded Structure Watch for up to 30 minutes; Trending uses its fresh normal path. A shared GMGN coordinator adds cache metadata, single-flight, priority/aging and rate-limit cooldown/recovery. GMGN cooldown degrades intelligence rather than globally halting unrelated execution. See [V5 policy, tests and offline verification](docs/sniper-buyer-defense-v5.md). The real bot remains stopped pending the owner's next LIVE instruction.

Install with `pnpm install`. Configure `.env` from [.env.example](.env.example). Set the public wallet and either `SOLANA_PRIVATE_KEY` (base58 64-byte key or JSON byte array) or `SOLANA_KEYPAIR_PATH` (Solana CLI JSON file). The GMGN PEM authenticates its API and cannot sign Solana transactions. Secrets stay in the backend; never paste keys into chat or the dashboard.

`SOLANA_RPC_HTTP` is the primary RPC endpoint; `SOLANA_RPC_URL` remains a compatibility fallback. `SOLANA_RPC_WS` is optional. Jupiter supports keyless use at a lower rate; production API keys go in `JUPITER_API_KEY`.

Normal trading uses exactly `max(wallet SOL − fee reserve − pending BUY reserves, 0) / 100`, rounded down in integer lamports. It requires `TRADING_MODE=live`, `LIVE_TRADING_ACK=true`, and entries enabled. Protective exits remain available when entries are paused. Local exits require this process to be running; no GMGN native orders are created.

Normal live has **no position-count limit**. Each independently approved mint can enter while spendable capital and execution checks allow it. An existing position's attention/backoff does not pause other mints. Queue/Watch/Deferred bounds limit analysis workload only.

Jev decides HOLD, partial SELL or full SELL separately for each owned position. TP30/70 and trailing are context references; they do not force a strategic exit. No price stop loss or maximum-holding-time SELL remains. SELL backoff and wallet serialization do not pause market observations or asynchronous Jev analysis. Manual/security overrides and all existing execution safety checks remain in force. Capital Flow adds bounded GMGN observations, directional volume trends, observed runner memory and 20/50/75% exposure reductions. See [current implementation and live evidence](docs/capital-flow-adaptive-manager.md) and [read-only route investigation](docs/live-route-investigation-2026-10-29.md).

Commands:

- `pnpm dev`: local dashboard and configured scanner. `pnpm build && pnpm start`: compiled runtime.
- `pnpm build && pnpm live`: explicit continuous normal live. Verifies mainnet/signer, recovers pending executions and checks existing OPEN holdings against on-chain balances before enabling entries. It preserves historical controlled records and refuses genuine system/transaction halts; it has no one-trade auto-stop. Subsequent `pnpm live` uses the existing build.
- `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`: deterministic safety checks.
- `pnpm verify:gmgn`, `pnpm verify:jev`, `pnpm verify:wallet`: read-only real provider checks.
- `pnpm verify:execution`: read-only Jupiter BUY/reverse quotes and BUY simulation; verifies signer configuration without broadcasting.
- `pnpm smoke:live`: isolated real BUY → SELL. Never starts Engine, scanner, Jev, normal 1% sizing, or automatic exits.
- `pnpm live:controlled`: real scanner/Jev/Risk/ExitEngine flow, at most one completed trade, one open position, and 0.005 SOL BUY principal; stops after reconciliation and memory outcome. Requires existing normal live authorization. See [Token-2022 policy](docs/token-2022-support.md) and [actual controlled verification](docs/token-2022-controlled-verification.md).

The smoke principal cap is **0.005 SOL = 5,000,000 lamports**, explicitly revised by the owner on 2026-10-28 from the original 0.0005 request. Set `LIVE_SMOKE_TEST_SOL=0.005`; larger values fail. Fees/rent are separate, bounded by a 5,000,000-lamport reserve. The separate `LIVE_SMOKE_TEST_ACK=true` and normal live flags are required; the program never edits ACKs. Normal trading cannot inherit smoke authorization.

Smoke uses only canonical Solana USDC, independently verified with [Circle](https://developers.circle.com/stablecoins/usdc-contract-addresses), then checked on-chain for the standard SPL mint and six decimals. It requires both directions before BUY, fresh quotes, inspected transaction principal, simulation, and exactly one submission per leg. SELL uses only the increase above the token balance recorded before BUY. No blind submission retries occur.

`data/live-smoke-test.json` and its `.once` marker are durable. A marker blocks future tests; preserve/reconcile the existing record rather than deleting it. `data/live-smoke-preflight.json` records blocked preflights separately. The previous GMGN entitlement rejection was independently reviewed against unchanged wallet balances and archived with its original marker and a review record; the normal smoke command never archives or removes markers itself.

Submission is not success. UNKNOWN keeps the reservation and pauses entries. Restart recovery queries only the saved transaction signature, verifies receipt deltas against current balances, and never replays a BUY. Legacy GMGN positions/orders require review; they are never silently adopted by Jupiter.

The established paper path is retained for existing deterministic tests and UI development. Paper is never execution evidence. Real Jupiter BUY and SELL were both finalized on 2026-10-28; see [verification and signatures](docs/VERIFICATION.md).

Read [provider details](docs/solana-execution-provider.md), [GMGN capabilities](docs/gmgn-capability-map.md), [risk policy](docs/risk-policy.md), and [security](SECURITY.md).

## Trading memory and UI preview

Use `pnpm ui` to inspect the dashboard safely: it forces PAPER, disables LIVE permission, scanner and entries regardless of `.env`. The current preview is at http://127.0.0.1:3000. Normal `pnpm dev` honors the configured mode; keep live flags disabled while reviewing UI.

Trading memory version 1 adds immutable snapshots, confirmed execution evidence, sampled MFE/MAE, fee-inclusive outcomes, historical retrieval, typed Jev context and unapplied suggestions. See [the implementation and verification report](docs/trading-memory.md). `pnpm learning:report` reads current DB statistics; `pnpm learning:rebuild` requires the bot stopped. `pnpm learning:example` demonstrates the closed loop using isolated fixtures only. Normal sizing is now 1% by the owner’s explicit request; learning cannot change it.

Token faults are isolated with a bounded Top-10 queue, Watch/Deferred lifecycle and per-position attention badges; systemic/ambiguous transactions still pause entries. See [fault isolation and actual live verification](docs/fault-isolation.md). `pnpm live:controlled --resume` reconciles/resumes the existing controlled position without granting another BUY allowance.

The [Token Flow Pipeline dashboard](docs/token-flow-pipeline.md) presents actual lifecycle/execution events as a dark, animated Scanner → Queue → Watch/Deferred/Reject/Qualified flow. Database-only fast SSE frames drive the visualization; trading state remains authoritative and wallet RPC polling is unchanged.
