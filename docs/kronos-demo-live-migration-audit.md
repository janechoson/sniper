# KRONOS-only DEMO/LIVE — source audit and implementation report

2026-11-11. Target: `develop` at `94a993f`; implementation was prepared on `feat/migrate-v1` at the same commit and is now on local `develop`. No deployment, production bot restart or real trading was performed.

## Current owner override — 100 SOL and fresh local state

The owner subsequently requested deleting all local quant-bot data without backup and changing DEMO initial capital to **100 SOL**. The local data reset was completed under a maintenance lock, after checking that the copied DB had no live holdings or pending executions and obtaining exclusive file access. The new local DB has one 100 SOL funding event and no positions/executions/logs/attempts. The original gmgn-sniper process and its data were preserved. Amount formulas, model behavior and LIVE execution were not changed. See the [reset record](jev-memory-cleanup-manifest.md).

## Baseline decision

Source inspection found material LIVE differences between develop and the user's `../gmgn-sniper`. The user selected **gmgn-sniper as the LIVE behavior baseline**. Its receipt-local fill accounting, tolerance of unrelated wallet transfers, token-blacklist checks and fault reporting were ported. Develop's durable Trending FIFO/batch admission was retained. This baseline choice is distinct from the KRONOS/DEMO refactor.

KRONOS domain/model strategy/worker and `position-sizing.ts` were preserved. No alternate AI, fixed stop loss or new amount policy was introduced.

## Before: audited source call graph

`server.startServer → Store/Engine → DiscoveryCoordinator → CandidateLifecycle/CandidateAttempts → one-shot-entry`.

Common work collects cheap filters, GMGN security, mint compatibility, market history and capital flow, then `RiskEngine.evaluate(COMMON)`. STANDARD added structure/manipulation/smart-money evidence and `Jev.decide`. KRONOS passed the last 60 OHLC rows into `KronosStrategy.evaluateEntry`. Both competed for `Store.claimMintForBuy`, followed by final analysis, sizing, claim and `Executor.execute`.

`Executor` selected market-price PAPER settlement or Jupiter LIVE. `Engine.monitor`, PositionCollector, PositionHistoryMonitor and ExitLiquidityMonitor collected position evidence. KRONOS used `scheduleKronosPosition`; STANDARD used JevExitScheduler. TradingMemory attached learning observations and outcomes across engine/executor/server. Dashboard exposed two strategy cards and Memory endpoints.

Legacy PAPER cash came from wallet/SOL assumptions and lacked the requested exact USD ledger. The standalone Kronos Lab trial is not reused as a second scanner or engine; main dashboard control remains disabled for that isolated development utility.

## Dependency disposition

| Responsibility           | Change                                                                                                                                                                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inference                | Removed `src/jev.ts`, JEV model/API environment configuration and callers. Only KRONOS inference is invoked by main engine.                                                                                                                                                           |
| Entry                    | Removed STANDARD evaluation and dual-branch race. SQL ownership/idempotency remains.                                                                                                                                                                                                  |
| Exit                     | Removed STANDARD scheduling, decision/apply paths, unused profit/trailing lifecycle helper and JEV scheduler. KRONOS decision semantics and common manual/critical-security/liquidity protection remain.                                                                              |
| Learning                 | Removed TradingMemory, learning, runner-memory runtime, configuration, callbacks, jobs, endpoints and Memory UI.                                                                                                                                                                      |
| Historical compatibility | Preserved legacy discriminator/types, learning bootstrap schema/migrations and protected raw records. These do not initialize a model or learning worker.                                                                                                                             |
| Presentation             | Removed STANDARD card/settings, dual comparison, JEV status/panels, Memory and legacy Watch/Deferred pages and their presentation endpoints. Retired TP/trailing reference chips are also removed; persisted configuration values remain intact. Added visible mode/account controls. |
| Tests/docs/tools         | Retired branch-specific JEV/learning/old arbitration tests and tools; ported shared safety/receipt tests to valid KRONOS fixtures. Retained historical audit reports as historical evidence.                                                                                          |

## After: actual architecture

`server → ModeManager → one Engine → DiscoveryCoordinator → cheap/security/compatibility/history/capital-flow/common Risk → KRONOS → Risk/final checks/existing sizing → Executor`.

`Executor` captures the immutable session mode. LIVE constructs the existing JupiterExecutionProvider; DEMO constructs DemoExecutor with only SQLite, QuoteSource and a narrow read-only mint-inspection callback. `jupiter-quotes.ts` and `execution-quote.ts` extract existing read-only quote/validation behavior without duplicating discovery or inference.

Positions use the same monitoring and KRONOS SELL path. DEMO atomically settles ledger, holding, execution and position in one SQLite transaction. LIVE uses the original receipt reconciliation, UNKNOWN handling and accounting. All new positions/intents require KRONOS; historical ownership is not relabeled.

## Financial design

- Exactly one initial funding event of 100 SOL per account generation.
- Cash, reserves, costs, realized PnL and SOL sizing use integer lamports (scale 10^9); token quantities use their native atomic units.
- Native SOL cash feeds the existing amount calculator directly. Quote proceeds and fees settle exactly in lamports, independently of SOL/USD changes. Optional fresh FX is reporting evidence only.
- Atomic reservations, unique idempotency keys, exact cost allocation, partial/full SELL, no oversell/negative available funds and no duplicate settlement.
- Fill estimate uses fresh route-only minimum output, real requested amount, token decimals, compatibility, liquidity, price-impact and existing exit probes. Estimated fees are labeled; no chain receipt is fabricated as evidence of a real transaction.
- Failed preparation releases reservations; unsigned work is discarded safely on recovery, never replayed. Confirmed settlement and position persist together.
- Account view returns unknown equity/PnL for missing/stale marks. Periodic snapshots are outside BUY execution; history reads are bounded to 24 hours/288 observations.

## Schema and compatibility

Historical migrations 3–12 remain in place. Additive versions:

| Version | Tables/columns                                                                                                                                            |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 13      | `demo_accounts`, `demo_ledger`, `demo_holdings`, `demo_reservations`, `demo_balance_snapshots`; unique active account and funding/settlement idempotency. |
| 14      | `engine_sessions`: persistent mode/PID/token session ownership.                                                                                           |
| 15      | `records.scope_mode`, `records.scope_account`, index; `mode_tokens`, initialized from existing LIVE token rows without deleting them.                     |

DEMO operational settings/state use account-scoped keys; strategyV2 remains shared. Positions, executions, attempts, records, history, logs, statistics and discovery use mode/account scopes. Old unscoped records remain LIVE-readable and their payload hashes are untouched. Old PAPER rows are historical, never DEMO funding. Mode/account identity cannot be reassigned on existing positions or executions.

Version 16 adds `demo_account_units`, explicitly labeling newly funded SOL accounts with nine atomic decimals. Existing USD accounts retain a USD label and fail closed pending an explicit reset; no balance is reinterpreted.

The dashboard Reset Demo action archives DEMO ledger/holdings/positions/executions/attempts. It clears only that mode's transient discovery and deactivates its old claims. LIVE rows and historical signatures remain unchanged. The old destructive reset tool refuses the new financial schema rather than guessing which tables to delete.

## Lifecycle and safety boundaries

Backend-selected mode persists independently of the frontend and legacy .env selection. The existing filesystem process lock plus SQLite BEGIN IMMEDIATE session claim prevent concurrent startup. A live PID's session cannot be stolen by lease expiry. Unknown process status blocks startup.

Switch requests serialize. New entries stop, active work drains, and session ownership transfers before a fresh engine is started. LIVE requires `START LIVE` confirmation and existing wallet/mainnet/environment activation checks. Failed activation stays stopped; it does not fall back into real trading. A factory failure releases ownership for a corrected retry.

LIVE holdings, pending/UNKNOWN transactions and pending exits block leaving LIVE, including dismissed holdings and terminal rows with nonzero quantity. State is checked again after shutdown; a late accepted BUY restores recovery monitoring. Safe UI stop has the same late-fill protection. Existing real positions are never automatically sold for switching/reset.

On restart, persisted LIVE with no recovery work remains stopped pending fresh confirmation. Existing real KRONOS positions instead resume recovery/monitoring with new entries disabled; this is not a fresh authorization for LIVE entries. STANDARD/unknown legacy owners or invalid recovery evidence block migration before writable Store/engine construction. Deployment must revalidate current authoritative state.

## Verified data import and subsequent owner-authorized local reset

User authorized copying `.env` and data from gmgn-sniper. Native SQLite online backup through read-only source connections copied bot/provider databases. Imported integrity and foreign-key checks passed; credentials were neither printed nor committed. Existing account-balance JSON was copied without synthetic points. Source DB/WAL/SHM/locks and running processes were untouched.

Historical pre-reset snapshot: 256 LIVE KRONOS positions (208 CLOSED, 48 FAILED), 416 CONFIRMED and 116 FAILED executions; no unresolved/nonzero LIVE positions or STANDARD-owned positions. Eleven historical learning/runner/JEV tables were empty; two active claims were KRONOS-compatible. A fresh read-only preflight against gmgn-sniper passed during final verification.

A separate disposable copy of the imported DB was migrated and checked: all rows/payloads in eight protected tables (`positions`, `intents`, `executions`, `execution_fills`, `manual_exits`, `buy_ownership_claims`, `trade_learning_samples`, `trade_execution_evidence`) matched SHA-256 digests before/after; integrity and FK checks passed. That disposable verification copy was removed afterwards; it is not a retained deployment rollback backup.

The owner explicitly approved a complete local data reset and waived backup. The old local DB/WAL/SHM, provider cache DB and account-history JSON were deleted and replaced with fresh 100 SOL DEMO state. No backup was made. This does not delete or modify the original gmgn-sniper database. Historical schema bootstrap/migrations remain for compatibility; their tables in the new DB are empty. See the [reset record](jev-memory-cleanup-manifest.md).

## Verification and limits

New suites cover exact ledger funding/fees/cost/PnL, rollback/idempotency, failed quotes, signer/broadcaster capability denial, unchanged configured sizing, session concurrency/recovery, safe late-fill stop, generation/mode isolation and legacy preflight. Shared LIVE receipt, pre-sign, UNKNOWN, blacklist, duplicate BUY, FIFO and KRONOS deterministic input/decision suites remain.

Browser regression uses a temporary SQLite DB, fixture providers and blocked external HTTP. It also exercises another tab across a failed LIVE activation, DEMO resumption and account reset, invalidating stale route data on mode/account changes. It verifies visible selector/100 SOL/chart, absent STANDARD/Memory UI, confirmation cancellation, blocked LIVE reason, DEMO resume without refunding, safe stop/reset and dashboard routes. No test performs real signing, BUY/SELL or broadcast.

Final command totals are recorded in `VERIFICATION.md` after the last checks. Model behavior is covered by deterministic fixture/reference tests; no real model/live market replay or real trading smoke test was run. DEMO minimum-output fills and estimated fees are simulation assumptions, not proof of live execution parity. Shared generic legacy settings are retained where removing defaults would exceed the approved invariants; they do not enable a STANDARD strategy.
