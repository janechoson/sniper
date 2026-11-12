# Chart Learning V4 audit and test plan

## Audit findings

- Discovery lives in `src/discovery.ts`; the BUY path is `src/one-shot-entry.ts`. Candidate discovery does not currently call the Post-BUY registration API; the registration hook is after CONFIRMED execution and persisted OPEN position.
- `src/chart-learning.ts` combines Guard evaluation, automatic collection, background Codex execution, rule generation, validation promotion, restart recovery, and post-event follow-ups. `pump()` calls `runJob()`, which invokes `runtime.analyze()` automatically. Constructor recovery changes all RUNNING legacy jobs back to PENDING.
- The collector watches and fetches OPEN case mints, but closed positions only enqueue automatic TRADE_REVIEW. It has no case-scoped 5/15/30/60 minute follow-up schedule after SELL.
- `src/chart-store.ts` owns shared Learning SQLite projections and generic `chart_jobs`; `src/chart-learning-schema.ts` is the additive schema migration. `src/chart-api.ts` contains read-only GET projections, while `src/server.ts` enforces local Host, Origin, JSON and CSRF checks for POSTs but currently routes Chart Learning only for GET.
- `public/dashboard-learning.js` renders a polled read-only dashboard and has no manual analysis controls. `public/dashboard-router.js` exposes the existing CSRF-protected `ctx.post()`.
- `src/engine.ts` starts the shared Learning worker and monitors OPEN positions. `src/executor.ts`, `src/store.ts`, and `src/one-shot-entry.ts` own execution confirmation, position persistence, and registration. Existing `observePosition()` calls Guard evaluation on held positions; it must not become an AI path.
- `src/codex-runtime.ts` exposes one bounded JSON analysis call. Existing automated reviews can promote rules through validation; V4 will remove that automatic path and manual outputs will create DRAFT rules only.
- Current `data/learning.sqlite` was deleted at the user's explicit V3 request. No attempt will be made to recreate historical data or alter the remaining DEMO/LIVE trading databases.

## Implementation plan

1. Extract manual Codex execution behind a `ChartAnalyzer` service; make Collector's periodic `pump()` strictly deterministic and never call Codex.
2. Add additive case collection/follow-up and manual analysis job/result tables. Preserve old evidence and legacy jobs for inspection; never auto-resume old or interrupted analysis jobs.
3. Queue 5/15/30/60 minute post-SELL observations by position, with bounded retries, explicit coverage, and READY/INCOMPLETE status.
4. Add local CSRF-protected manual analyze, batch, retry, job-list, and job-detail routes. Batch size and concurrency remain bounded; only selected eligible cases run.
5. Add small dashboard controls and status indicators. GET/poll/render/selection must not enqueue or execute analysis.
6. Add tests for BUY eligibility, collector without runtime, post-SELL scheduling/recovery, manual API/job behavior, restart, rule DRAFT-only behavior, and Guard independence. Run relevant suites, full checks, build, and migration tests.

## Test matrix

| Area | Expected result |
|---|---|
| Discovery, pre-BUY gates, Guard PASS/BLOCK, KRONOS BUY signal | No Learning case or chart collection |
| Pending/failed BUY | No Learning case |
| Confirmed BUY plus persisted OPEN, DEMO/LIVE | One idempotent case per position; same mint can have separate cases |
| Collector pump, OPEN lifecycle, restart | Persists eligible observations without calling runtime; interrupted analysis does not resume |
| Confirmed SELL | Outcome persisted and 5/15/30/60 minute follow-ups remain scheduled after close |
| Missing follow-up data | Retry/expire with explicit incomplete coverage; no fabricated values |
| GET dashboard, refresh, polling, selection | Zero Codex calls and no analysis job creation |
| Explicit analyze / batch / retry | Only selected eligible cases invoke Codex; duplicate concurrent request rejected/deduplicated |
| Analyzer unavailable/quota failure | Job records a clear failure; collector and Guard continue |
| AI hypothesis | DRAFT only; no automated promotion or Guard effect |
| Existing validated rules | Deterministic Guard remains active without Codex |
| Migration and shared DB | Additive/idempotent; preserve remaining trade DBs and existing Learning records |

## Verification

- Targeted Chart Learning, route, execution and shared database tests; full test suite if targeted tests pass.
- Typecheck, lint, build, and migration verification.
- No real LIVE trades. Do not delete or reset databases.
