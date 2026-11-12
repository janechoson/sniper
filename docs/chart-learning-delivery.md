# Chart Learning delivery — 2026-11-11

The integrated DEMO engine is operational. Full learning acceptance remains
incomplete: the configured AI provider currently returns HTTP 429 for new
reviews, including the completed trade review. No validated rules or real
evidence-backed Codex BLOCK/SELL have been claimed. The mechanics are tested
with explicitly controlled fixtures.

## Architecture and integration

The existing discovery → cheap/security/compatibility/history/flow/common risk
pipeline now calls `CODEX_GUARD` before KRONOS entry inference. An empty or
inapplicable validated knowledge base returns PASS without pretending to invoke
AI. Invalid/stale data and inference failures are recorded as ERROR. BLOCK
stops entry inference. KRONOS remains the only BUY authority, followed by the
existing risk, ownership, quote, simulation and execution checks.

Codex and KRONOS submit independent strategic exits to the existing Engine exit
queue. `ExitCoordinator` preserves the other source's decisions and prefers a
fresh KRONOS SELL when both sources request SELL. Manual/protective priority,
atomic `Store.claim`, OPEN/PENDING_EXIT ownership, execution validation and
reconciliation remain shared. Codex never receives signer or broadcasting tools.

## Files

| Area | Created / modified files |
| --- | --- |
| Evidence and learning | New `src/chart-learning-schema.ts`, `chart-store.ts`, `chart-features.ts`, `chart-learning.ts`, `chart-replay.ts`, `chart-validation.ts`, `chart-backtest.ts` |
| Reasoning and exits | New `src/codex-runtime.ts`, `exit-coordinator.ts`; modified `engine.ts`, `strategy-authority.ts`, `domain.ts`, `one-shot-entry.ts`, `candidate-attempt.ts`, `store.ts` |
| Dashboard | New `src/chart-api.ts`, `public/dashboard-learning.js`; modified `server.ts`, `dashboard-view.ts`, `dashboard-router.js`, `index.html`, `style.css` |
| Operations | New `src/demo.ts`, `scripts/chart-learning-status.ts`, `chart-learning-probe.ts`, `chart-learning-quote.ts`, `chart-learning-replay.ts`, `chart-learning-ui.ts`; modified `package.json`, `.env.example` |
| Regression/docs | New `tests/chart-learning.test.ts`; modified `dashboard-routes.test.ts`, `trending-final-gate.test.ts`; audit in `chart-learning-implementation.md` |

## SQLite migration

Additive migration 17 runs transactionally in the existing Store. It creates
`chart_candles`, `chart_events`, `chart_snapshots`, `chart_decisions`,
`chart_rule_versions`, `chart_rule_evidence`, `chart_observation_queue`,
`chart_followups`, `chart_event_outcomes`, `chart_replays`, `chart_jobs`,
and `chart_validations`. Existing execution learning tables are preserved.
Foreign keys, mint/time/scope indexes, stable IDs and immutable evidence updates
are enforced. Decision/rule/replay histories reject deletion. Unreferenced
snapshots expire after 7 days, ordinary candles after 30 days and unreferenced
events after 90 days. Event chart windows and referenced evidence remain pinned.

## Setup, start and monitoring

Set `OPENAI_API_KEY` and `CODEX_MODEL` in the backend environment. The verified
runtime uses `gpt-6-luna`; this is a configured Responses API integration, not a
reuse of ChatGPT CLI login tokens. It uses strict JSON schema, Zod validation,
no tools, timeouts, one concurrent request, backoff, provider Retry-After, and
persistent jobs. There is no local hourly request or daily token quota. Request,
input/output/total token usage is retained for observability; estimated cost is
shown when both per-million-token prices are configured. Inputs remain bounded
to 60,000 characters to control request size. Background reviews do not block
the trading loop.

Official protocol reference:
[Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses).

Start using `pnpm demo`, or the exact verified local command:

```powershell
.\node_modules\node\bin\node.exe --import tsx src/demo.ts
```

Do not launch a second copy while the existing server owns the database lock.
This entry point explicitly disables LIVE acknowledgement and uses ModeManager's
DEMO switch; unresolved LIVE custody prevents the switch. The `.env` trading
mode string was preserved; the persisted selected mode and running session are
DEMO. Start/stop confirmation and LIVE readiness checks remain in the existing
dashboard. Positions, fills and balances stay mode/account scoped.

Open [Chart Learning](http://127.0.0.1:3000/chart-learning). The overview, Rules,
Events, Decisions, BLOCK History, SELL History, Trade Replay, Timeline, Jobs and
Replay Validation tabs read SQLite. Click an item for its decision-time snapshot,
supporting/contradictory event charts, versions, fills and follow-up outcomes.
The read-only `pnpm learning:status` command reports persisted readiness/counts.

## Learning and replay

Completed M1 candles are validated and deduplicated with provider timestamps.
RUG_30 uses open-to-low decline of at least 30%; it does not assert fraud.
Additional event labels cover pumps, sharp declines, recoveries, failed
breakouts, sustained drawdown, volatility expansion and continued uptrends.
Pre-event features use 5/15/30/60-minute closed prefixes, excluding the event
candle. Missing volume/liquidity/depth/holder history is never synthesized.
Discovery samples and rejected/WAIT/BLOCK candidates remain in bounded follow-up
queues; position monitoring retains the higher-priority provider lane.

AI reviews may propose evidence-linked DRAFT hypotheses. Promotion requires
deterministic chronological validation and testing after hypothesis creation,
at least 20 matching samples and 10 independent tokens in each holdout,
precision at least 0.75 and at least 0.20 above its observed baseline.
These are screening requirements, not a calibrated crash probability.
No risk threshold or source code is changed by learning.

Actual fill markers and accounting come from reconciled executions. Better
entry/exit candidates use observable completed-prefix signals, not extrema.
They remain INSUFFICIENT_DATA and do not influence rules when contemporaneous
execution evidence is missing. Full charts and candidates are available in
Trade Replay. The confirmed trade is directly accessible at
[its replay](http://127.0.0.1:3000/chart-learning?replay=351ff8eb-40f0-4178-b1f9-e928c51b011c).

`pnpm learning:replay <mint> <from-ms> <to-ms>` runs up to 120 minutes of
chronological KRONOS inference and compares three policies. `--recent-trade`
runs a short smoke replay. Availability timestamps and historical rule versions
are enforced. Reports are immutable, non-authoritative research estimates with
explicit $100 capital, $1 entries, $0.01/fill and 100 bps slippage assumptions.
They do not reconstruct all historical security/risk gates or executable depth.
A real-data smoke replay produced three usable timestamps and one unavailable
inference; that is not a strategy performance validation. Fees for open as well
as completed positions are covered by the final accounting regression.

## Verified real-market observations

Snapshot at **2026-11-11 13:32:48 UTC**: DEMO active; 11,409 candles, 647 events
(61 RUG_30 labels in collected historical/live candles), 446 PASS decisions,
zero authoritative BLOCK/SELL decisions and zero validated rules. Six research
jobs completed; failed/pending jobs and HTTP 429 remain visible.

SQLite contains three confirmed **simulated** executions: BUY
`79df0f32-94e6-46bb-8b55-8459483a6089`, SELL
`a38dac34-9c49-453a-83a4-37771023e44f`, and BUY
`8f53f1bd-f146-4941-8359-3fa72ac1c9e3`. All have
`evidence.simulated=true` and KRONOS authority. There is one closed round trip
and one open position. The closed replay has 75 candles, two actual fill markers
and net PnL **41,129,079 lamports**. The 100-SOL initial virtual account, cash
99.040817789 SOL, zero reserve and the open position survived the controlled
DEMO recovery test. Cash alone is not total account equity.

A read-only Jupiter quote succeeded for an actually discovered token without
an API key in this environment; no key is currently assumed mandatory. A real
AI event review was persisted as job
`c6fd0107fd77f7cacbb0c427870165c22aeb4f66d50f20297383cdd8b7dc1091`.
The completed-trade AI review was attempted after backoff and still received
HTTP 429. It is FAILED, not reported as analyzed successfully.

## Validation commands and limits

Commands actually executed:

```powershell
.\node_modules\node\bin\node.exe --import ./scripts/test-env.mjs --import tsx --test --test-concurrency=1 tests/*.test.ts
.\node_modules\node\bin\node.exe --import ./scripts/test-env.mjs --import tsx scripts/chart-learning-ui.ts
.\node_modules\node\bin\node.exe node_modules/typescript/bin/tsc --noEmit
.\node_modules\node\bin\node.exe node_modules/eslint/bin/eslint.js src tests scripts/*.ts public/*.js
.\node_modules\node\bin\node.exe scripts/build.mjs --out-dir .build-chart-learning-v2
.\node_modules\node\bin\node.exe --import tsx scripts/chart-learning-status.ts
.\node_modules\node\bin\node.exe --import tsx scripts/chart-learning-quote.ts
.\node_modules\node\bin\node.exe --import tsx scripts/chart-learning-probe.ts
.\node_modules\node\bin\node.exe --import tsx scripts/chart-learning-probe.ts --trade
.\node_modules\node\bin\node.exe --import tsx scripts/chart-learning-replay.ts --recent-trade
```

Browser fixtures passed with no screenshots. Fixture tests block external HTTP
and real credentials. Typecheck, lint and isolated build passed. The temporary
build is removed after verification; runtime SQLite and open-position data stay.
Final full suite: **503 tests passed, zero failures** (108.49 seconds). The
additional research/restart fixtures also verified DRAFT generation with real
fixture references, retained contradictory evidence and interrupted-job recovery.

Remaining acceptance limits: HTTP 429 blocks new post-trade reasoning and
validated knowledge growth; historical execution actionability is incomplete;
holder/dev/depth history is not reconstructed; independent Codex SELL/BLOCK is
fixture-verified but has not occurred authoritatively on real-market evidence.
Pinned audit evidence needs an archival policy for indefinite operation. These
limitations are visible rather than filled with invented successful outcomes.
