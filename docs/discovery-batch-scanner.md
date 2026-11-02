# Kronos — fetch once, process batch, refresh on exhaustion or 5m

02/11/2026 — Asia/Bangkok. Implemented and verified in isolated fixtures. **Production process remains running on its previous build; no pause/restart or production control POST in this task.**

## A. Actual previous implementation / root cause

Traced `KronosLab.tick/discover`, `KronosMarket.discover`, `parseTrending`, `Store.add/due`, appearance identity and actual server GET handlers before editing. Source snapshots: `evidence/discovery-batch-before/`.

- Old trigger: enabled `tick`, no discovery flight, `Date.now() >= nextDiscovery`; sets `nextDiscovery = attemptStart + 120000`. One tracked promise prevented overlap. It was **not one list fetch after each token**.
- Market requested `/v1/market/rank`, 5m volume descending, limit 50. Parser capped at 100; adapter retained at most 50 parsed rows. This requested/retained limit is unchanged.
- Successful discovery admitted rows into a persistent global trial queue. There was no batch deadline or membership. More lists could arrive every 120 seconds while older unstarted rows remained queued.
- `Store.due(true)` prioritized OPEN holdings; `due(false)` then selected all due unowned trials, sorted by nextAt/rowid, without any batch filter. Model concurrency was one.
- `Store.add` enforced unique appearance and one active same-mint trial in each mode. The appearance used parser `sequenceStartedAt`, otherwise `discoveredAt`. However, `parseTrending` itself populated sequenceStartedAt with each snapshot timestamp. After a terminal trial, another polling response could therefore manufacture a new appearance.
- GET Overview/status/history/statistics/logs did not own discovery. That remains true.

Historical raw rank sizes were not retained, so a real raw response count cannot be reconstructed from admission count. Read-only inspection observed retained candidate groups of 27, 50, 22, 50 and 26 rows at its checkpoint; these are **retained admissions**, not raw response sizes. No real extra GMGN fetch was issued for this audit. The new adapter measures raw response count directly. Evidence: [audit/preservation](../evidence/discovery-batch-audit-and-preservation.json).

## B. New lifecycle / TTL

```text
backend discovery scheduler
  → single-flight rank fetch
  → successful response fetchedAt; immutable expiresAt = fetchedAt + 300000
  → deduplicate appearances; persist current batch + membership
  → first attempts from this batch
      ├─ all handled, none running → EXHAUSTED → next fetch on scheduler turn
      └─ now >= expiresAt → EXPIRED → expire unscheduled work → next fetch

OPEN due monitor → fresh history/model → HOLD/SELL
  takes the next serial evaluation slot before candidate work
```

Single source: `DISCOVERY_BATCH_TTL_MS = 5 * 60_000` in [discovery-batch.ts](../src/discovery-batch.ts). Starts at successful response completion, never at request start, first token, UI refresh or last evaluation. Processing does not extend TTL. Active inference is not stopped at expiry; discovery can rotate while the serial evaluation lane is occupied.

When a batch exhausts early, it does not wait for minute five. An empty or wholly deduplicated response has a bounded **30s idle retry** to avoid repeatedly fetching an unchanged list with no schedulable work. This does not delay exhaustion after a normal batch with actual candidate jobs.

On fetch failure, retry is at least **120s**, and no earlier than the provider cooldown deadline. Existing 20s timeout, 3s request spacing, limit50 and cooldown policy remain. Normal timers cannot override provider backoff. Five minutes is the successful batch's eligibility window, not a guarantee that a provider outage returns a new list on time.

## C. Persistence, expiry and active work

Uses existing `lab_meta`, `lab_trials` and structured `lab_events`; no new SQL tables or migration. Current batch state and counters persist by PAPER/LIVE mode. Previous summary and transition events retain evidence after rotation. Reopen keeps the original deadline. Interrupted work is reported separately, not fabricated as a completed model decision.

State includes batchId/fetchedAt/expiresAt, rawReceivedCount/uniqueCount/duplicateCount, processed/pending/running/skipped/interrupted/expiredUnprocessed counts and status. `pendingCount` means not started; `runningCount` is separate. Exhaustion requires both to be zero. Previously handled appearances count as skipped, not new evaluations.

Unstarted expired trials are retained as **EXPIRED_UNPROCESSED**, with no fake reject/error/WAIT/decision/fill/outcome. They no longer enter `Store.due`. If the same unevaluated appearance appears in a fresh batch, its existing row can be requeued with fresh candidate context; no duplicate appearance row is created. Old batch events preserve its expiration. OPEN/CLOSED rows and already checked WAIT trials are not expired by this operation.

On the first successful new-policy fetch, legacy unstarted rows with no eligible current snapshot are retained as expired-unprocessed, not silently adopted as fresh candidates. Checked WAIT trials retain the existing fresh recheck policy; those rechecks are not new discovery appearances. OPEN monitoring and execution recovery remain independent of list completion. No history, PnL, execution or active production DB was reset by this task.

## D. Genuine appearances

The shared parser's snapshot timestamp is explicitly labeled `LOCAL_SNAPSHOT` by the Kronos market wrapper. It is never used to generate a fresh attempt merely because a new list was fetched.

If a response explicitly supplies a valid `sequenceStartedAt` or `sequence_started_at`, the wrapper normalizes seconds/milliseconds and labels the identity `PROVIDER`. A different provider sequence may create a new attempt, still subject to the existing same-mint/ownership checks. This is an optional field contract, not a claim that every live GMGN response contains it.

Without that evidence, a durable conservative fallback is `mode + mint + stable rank basis`, reused across refresh/reopen. A missing field after a known provider identity reuses the previous identity. Neither fetchedAt nor discoveredAt manufactures another attempt. Consequently, absence/reappearance with no new identity evidence is conservatively deduplicated; no new sequence is guessed from elapsed wall time.

## E. Position priority, cooldown and execution isolation

`KronosLab.tick` keeps execution recovery, checks OPEN due work before candidates, and retains the single model lane. A running inference is not preempted. Shared provider serialization/cooldown can still delay a read; this is not a new latency SLA or a cross-bot quota lease.

Candidate scheduling now respects the current shared cooldown **before starting** unowned work, preventing a pending batch being drained into synthetic SECURITY_REJECTs during known provider wait. OPEN monitoring remains scheduled independently. The existing error classification for a request that actually first encounters a provider failure is not comprehensively rewritten in this scheduling task; no historical REJECTED rows are repaired or reset. The fixed120s provider policy itself is not changed to Retry-After handling here.

No modifications to wallet/signer/Jupiter/1% sizing/slippage/simulation/transaction inspection/confirmation/reconciliation/UNKNOWN/PnL. Six strategy declarations/functions (`KRONOS`, validPrice, validateCandles, decideForecast, markPrice, paperFill) have identical TypeScript tokens before/after. Baseline/live fixture outputs, including native model parity, remain covered by the suite.

## F. API, logs and UI

Overview design/palette retained. Added one compact indicator: batch ID, processed/unique, pending, age, time remaining, status/expired count/fetch state; tooltip separates list fetches and candidate evaluations. GET Overview/status expose a pure projection. No UI action or GET polling calls `/rank`.

Structured events: FETCH_START, FETCHED, TOKEN_STARTED, TOKEN_PROCESSED, EXHAUSTED, EXPIRED, FETCH_FAILED under the `DISCOVERY_BATCH_` prefix. Events include batch ID and counts; expiry includes age and expired-unprocessed count. No credentials are logged.

## G. Measured fixtures and verification

| Fixture | Observed result |
| --- | --- |
| 50 evaluations within 176.4s | 1 list fetch through candidate49; next fetch after candidate50; no extra wait to 5m |
| 31/50 at TTL | 31 processed; 19 expired-unprocessed; next fetch; no decisions on those19 |
| Active evaluation at04:59 | TTL rotates at05:00; active work finishes once; remaining49 never start |
| OPEN with100 pending candidates | OPEN monitor runs first; no discovery refresh caused by HOLD |
| Duplicate rows | 50 returned;45 unique appearances;5duplicates |
| Same/missing identity, fresh sequence, reopen | Stable appearance dedup; expired unprocessed row requeues; explicit new sequence admitted; deadline retained |
| Slow fetch | TTL starts at successful completion +5m; one flight |
| Failure/cooldown | Bounded retries; no resurrection of expired jobs; OPEN monitor continues; pending jobs not burned during known cooldown |
| HTTP polling | 300 Overview +40 other API calls;1 list fetch in window; second only after scheduler TTL |

The paired old/new scheduler fixture uses the preserved old Lab implementation, the same50 mocked candidates and31 evaluation ticks over270s. **Old:3 list calls /31 evaluations; new:1 list call /31 evaluations.** No real provider call. [Measured evidence](../evidence/discovery-batch-efficiency-fixture.json), [API evidence](../evidence/discovery-batch-api-fixture.json).

Quality: **76 tests passed, 0 failed/cancelled/skipped**, including15 new batch tests; final suite21.0045s. Typecheck, lint and isolated TypeScript build PASS; logs `evidence/discovery-batch-full-tests.log`, `*-typecheck.log`, `*-lint.log`, `*-build.log`. UI regression PASS against isolated backend/temp DB and GET-only fixture server, including 1440/1024/390 and batch status/age/counters. [Overview screenshot](previews/kronos-overview-desktop.png). Commands used pinned Node22.22.0; launcher Node20 warning/SQLite experimental warning are not test failures. Build output was isolated from production `dist`; no running backend hot reload.

Tests use mocks/fixtures, own temporary DBs and blocked external network. **Task-originated real BUY=0, SELL=0, sign=0, submit=0, wallet mutation=0.** Existing LIVE bot activity is autonomous; no claim that wallet/DB remained globally immutable while it ran.

## H. Changed files / operational status

New `src/discovery-batch.ts`, `tests/discovery-batch.test.ts`. Scheduler integration in kronos-lab/store/market, optional discovery provenance type, trial metadata/expired status type, read-only server projection. UI index/overview/style gain only the compact batch indicator. Regression fixture seeders now admit via batches instead of inserting an unbounded unstarted queue; baseline-domain changed only a status type for fixture compatibility, not its policy/functions.

69 existing protected files fingerprinted: only9 expected source/UI files changed; no unexpected changes. Execution/config/`.env`/package/lock/Python and all production dist files remain unchanged. BOT B was not edited or controlled. [Preservation](../evidence/discovery-batch-audit-and-preservation.json).

**Not deployed into the running process.** Checkpoint: PID15012, LIVE, enabled=true, new batch scheduler not loaded; BOT B listener remains PID7656. No pause/restart/control POST in this task. Static indicator can load immediately but shows “Chờ dữ liệu backend” on the old backend. Source is ready for a separately authorized operational deployment; this report does not claim that current LIVE already follows the new batching policy. [Runtime](../evidence/discovery-batch-runtime-final.json).

The optional cleanup command for the isolated `.discovery-build-check` output was rejected by automatic approval review (`blocked by policy`). The directory was left intact; no alternative deletion was attempted. Production dist and processes are unaffected. [Quality metadata](../evidence/discovery-batch-quality.json).
