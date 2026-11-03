# Token fault isolation, deferred candidates and position badges

Implemented against the current BOT B on 2026-10-28. Stop loss remains disabled. This revision changes lifecycle/error scope and visibility; transaction inspection, principal/slippage checks, signing, submission, simulation success requirements, receipt reconciliation, Token-2022 policy and duplicate protection remain enforced.

## Original IMAGINE failure

`Engine.monitor()` previously caught every monitoring/SELL exception and called `Store.halt()`, including typed unsigned `CandidateRejected("TOKEN_SAFETY_FAILED")`. IMAGINE's SELL simulation had a negative wallet SOL delta after costs, so the existing execution validator correctly refused to sign. The incorrect part was treating this one-position economic/simulation incompatibility as a global infrastructure failure. This revision does not bypass that validator or claim the token has been sold.

## Explicit scopes

`FailureInfo` records code, CANDIDATE/POSITION/TRANSACTION/SYSTEM scope, mint, symbol, stage, reasonCode, retryable, detectedAt and bounded diagnostics. Typed `CandidateRejected` originates token validation errors; `ProviderFailure` originates transport/API failures. `failureInfo()` adds the actual pipeline/ownership/submission context. No general error-message substring test determines scope. Unknown internal errors and wallet/signer/account authority invariants fail closed as SYSTEM.

| Scope | Behavior |
| --- | --- |
| CANDIDATE, unsigned | Remove from active queue, DEFER or REJECT, refill with next current candidate, continue scanning. |
| POSITION, unsigned | Preserve actual position/quantity, attach NEEDS_ATTENTION for pre-SELL or MONITORING_DEGRADED for data, show issue/badge and retain protective management with bounded backoff. No global entry halt. |
| TRANSACTION, submitted | Existing SUBMITTED → confirmation/UNKNOWN → reconciliation; no blind replay. Global entry halt remains for unresolved submissions/invariants. |
| SYSTEM | Global new-entry halt, persisted SYSTEM reason; protective work remains available where technically safe. |

Stages are DISCOVERY, DEEP_CHECK, WATCH, QUALIFICATION, PRE_BUY, POSITION_MONITOR and PRE_SELL. Loss/PnL is never used to classify a token fault.

Provider evidence is bounded to 50 incidents over five minutes. A first token transport failure is isolated/backed off. Three unrelated mints failing the same provider, or three failures of the service-wide discovery endpoint, escalate to a provider/system halt. Authentication/permission rejection is immediately systemic evidence. Missing credentials and signer mismatches remain immediate SYSTEM faults. No-route/404/400/422 for a particular Jupiter mint is a candidate error. This is a simple evidence window, not a distributed circuit breaker; operators can inspect provider health/incidents.

## Global-pause audit

| Location | Retained purpose |
| --- | --- |
| `Store.halt` | Central SYSTEM/TRANSACTION pause, scope/event and metrics. |
| `Engine.start` legacy-open check | Unmigrated custodial positions require review. |
| `Engine.start` recovery catch | Wallet/open-position recovery failure. |
| `Engine.isolate` | Explicit genuine SYSTEM or submitted TRANSACTION only. Replaces blanket pauses in tick/monitor. |
| `Engine.monitor` pending reconciliation catch | Submitted transaction cannot be reconciled; TRANSACTION. |
| `Executor.execute` submitted catch | Signature persisted but unresolved; TRANSACTION, no replay. |
| `Executor.reconcile` legacy/unsigned pending, missing receipt, reconciliation catch | State/receipt invariants and unresolved receipt; TRANSACTION. |
| `Executor.recover` legacy trade/recovery catch | Unreconciled persisted state; TRANSACTION. Unsigned CREATED intents are discarded through existing recovery. |
| `ControlledSession.submitted/resume/failed/block` | Independent one-BUY/session capital restriction. A consumed BUY allowance stays consumed; this is not a global token fault. |
| Controlled runner completion/stop | Stop after the session or unresolved/blocked outcome; no extra BUY. Isolated position failure now keeps controlled monitoring/scanning alive. |
| `/api/kill` | Explicit operator entry control, with existing CSRF/origin and unresolved-transaction guard. Not a token failure. |

Optional smart-money/post-exit observation feed failures remain warnings; they never authorized a global halt. Existing unresolved transactions are not skipped because their error happens to have a token-like code.

## Top-10 queue, Watch and Deferred

The current repository did **not** contain the Top-10/Watchlist implementation assumed in the task. A small persisted companion `CandidateLifecycle` was added around the existing analyze path; it does not replace GMGN, Jev, RiskEngine or Executor.

GMGN discovery persists candidates. Cheap available age/zero-liquidity facts reject dead candidates before queue admission; missing market facts require a fresh targeted check. Current candidates compete on a deterministic ranking of known GMGN listing liquidity/volume and freshness. Missing ranking inputs contribute no positive score and never imply safety. This score selects work order, not a BUY decision. Queue size is at most **10**. A failure leaves the queue before refill; the next best eligible mint is admitted in the same tick. Per-cycle deep-check work is still bounded by candidatesPerCycle.

Known critical risks, invalid mint/account layout, unsupported token programs/extensions, expired candidates and unacceptable liquidity are hard-rejected. Data gaps, no routes, route-specific simulation and temporary risk/transport problems defer. Jev SKIP/risk-capacity decisions go to WATCH. Watch entries get fresh qualification when due and competitive; there is no stale approval restoration.

Defaults, all configurable through current strategy settings:

| Parameter | Default |
| --- | ---: |
| candidateQueueSize | 10 (maximum 10) |
| watchMaxSize / watchRecheckMs | 30 / 60 seconds |
| deferredMaxSize | **20** |
| deferredTtlMs | **15 minutes** |
| deferredRecheckMs | **60 seconds** |
| deferredMaxRechecks | **3** |
| tokenFailureThreshold | **3** |
| recentRejectTtlMs | **30 minutes** |
| positionRecheckMs | **60 seconds** |

Deferred admission preserves first-deferred expiry, failure count, recheck count and current score. A due recheck competes with the queue; it is not guaranteed a slot. Recovered low-score tokens can remain out until expiry. Retry/TTL/permanent failure becomes REJECTED with cooldown. Runtime recent reject/bought lifecycle bookkeeping is capped at 500 rows; permanent audit records remain in the normal append-only event history. Overflow deferred/watch records are rejected rather than accumulating without limit.

Recovery always returns through current GMGN data/security, deep checks, fresh Trading Memory, uncached Jev and current RiskEngine before any new authorization. In-flight/qualified/approved lifecycle states restore to WATCH on restart. Unsigned failed BUY attempts may use a fresh attempt key only after full new approval; actual signed or unresolved BUYs remain blocked. The claim boundary independently checks ownership and unresolved execution. No deferred record is an executable order.

Before live signature persistence, ordinary failed simulations/quotes no longer create full immutable entry-learning samples. Actual submitted trades still persist entry context and quote evidence atomically before broadcast. Diagnostic execution failures can remain as failures, with no WIN/LOSS outcome for an untraded deferred/rejected token. Existing historical learning evidence is untouched.

## Owned positions and UI

Core execution states stay unchanged to preserve accounting. An additive persisted attention object records status, scoped issue, failure count, last checked, next check and protective exit state. One unsigned token-specific SELL failure backs off for 60 seconds. Repeated failures reach a 30-minute cooldown, protecting resources; real owned positions are never rejected/deleted. The UI explicitly says BACKOFF, not falsely ACTIVE during cooldown. A manual emergency request bypasses the cooldown and still uses all execution checks. Submitted UNKNOWN is shown as RECONCILING. Successful SELL reconciliation clears attention; restored monitoring data clears a monitoring-only issue.

`positionViews()` maps OPEN, EXIT_PENDING, MONITORING_DEGRADED, NEEDS_ATTENTION and submitted UNKNOWN into relevant operator positions. CLOSED history is excluded. An unsigned pending BUY with no acquired tokens is not counted as a holding; an actually submitted unknown BUY is visible even before its token amount is reconciled. Problem positions sort before healthy OPEN positions and remain visible on the Positions page.

The sidebar Positions badge updates through existing SSE/status + position refresh, survives tab navigation/restart and hides zero. Attention/unknown/pending exits use warning styling. Positions show the token's issue/stage, protective exit/backoff state, last and next checks. The dashboard's Deferred table shows token/mint, reason, stage, failure count, last/next check, TTL and disposition. It never renders giant raw errors. SYSTEM/TRANSACTION banners are distinct from TOKEN_DEFERRED or controlled/operator entry restrictions.

Persisted failure counters also expose per-Engine-session deltas: candidateFailures, candidateDeferred, candidateRecovered, candidateRejectedAfterRetries, positionFailures, systemFailures and globalEntryPauses. Global entry pauses count transitions from enabled to fault-paused; controlled allowance locks/operator actions are independent.

## Verification and changed files

- **88 deterministic tests passed**, including exact IMAGINE candidate/position regression, immediate queue refill with candidate K, no LOSS/sample for unsigned failures, deferred capacity/TTL/retry circuit, competitive recovery, restart states, provider escalation, real signer halt, signed ambiguity and position counts.
- Typecheck, lint and build passed. Isolated browser verification passed with zero browser errors: live badge changes, warning styling, CLOSED exclusion, navigation, deferred display, non-system deferred banner, existing SSE/CSRF and prior dashboard behavior.
- **Regression: TOKEN_SAFETY_FAILED / IMAGINE → global entries paused? NO**, unless there is separate submitted ambiguity/system evidence. A controlled session can still have entries disabled because its one-BUY allowance is already consumed.

New files: `src/failures.ts`, `src/candidate-lifecycle.ts`, `src/position-view.ts`, `tests/fault-isolation.test.ts`, this report.

Modified runtime: `src/domain.ts`, `src/config.ts`, `src/store.ts`, `src/engine.ts`, `src/executor.ts`, `src/risk.ts`, `src/controlled-session.ts`, `src/live-controlled.ts`, `src/gmgn.ts`, `src/jev.ts`, `src/util.ts`, `src/solana.ts`, `src/execution-provider.ts`, `src/token-program.ts`, `src/server.ts`. Configuration/UI/tests: `config/strategy.json`, `public/index.html`, `public/app.js`, `public/style.css`, `tests/core.test.ts`, `tests/execution.test.ts`, `scripts/ui-test.mjs`. Current-risk/entry-control/expiry/fee-reserve rejections remain blocking decisions, but unsigned policy changes no longer masquerade as systemic failures. Existing wallet token holdings reject only that mint, preserving holdings isolation. No wallet secrets or ACK values were edited.

## Live deployment checkpoint

The existing IMAGINE position and its original controlled session are resumed using `pnpm live:controlled --resume` semantics. Resume verifies configured signer/mainnet, original confirmed BUY, actual token balance and no signed unresolved transaction; existing unsigned restart recovery never replays an intent. The original BUY allowance remains consumed, principal cap **0.005 SOL**, max open **1**, max completed **1**. Saved normal strategy remains 5 positions / 1%.

Only the exact legacy token-generated pause is reviewed/lifted using its structured unsigned SELL-failure evidence plus the matching old banner format. This one-time compatibility review does not clear unknown or genuine system halts. New scoped token failures recover as runtime data/state events without source edits, builds or restarts.

Live observations are appended below after deployment. No new BUY or successful SELL is claimed without actual evidence.

### Actual acceptance evidence, 16:54:44 Asia/Bangkok

Final compiled process PID **13848** runs LIVE at **http://127.0.0.1:3000**, resuming original controlled run **`f2d3d364-1d45-4570-99a8-b24388185614`**. On the first deployment, IMAGINE's unsigned safety failure was observed as POSITION/PRE_SELL, attention NEEDS_ATTENTION, while nine other real GMGN candidates were analyzed and queue refill maintained 10/10. A final deployment also incorporated routine unsigned risk/fee/expiry classifications; it preserved the same position, session and backoff state.

The final independent read-only checkpoint recorded:

- **haltReason=null, haltScope=null, globalEntryPauses=0, systemFailures=0** for the Engine session; scanner running.
- **10 distinct real GMGN candidates analyzed** since the final CONTROLLED_RESUMED event (record 10169); queue **10/10**, Watch **29**, Deferred **0** at that instant. Candidate deferred/refill scenarios are additionally covered by deterministic tests; no fake deferred candidate was inserted into production to manufacture evidence.
- IMAGINE still **OPEN**, **NEEDS_ATTENTION**, scoped `TOKEN_SAFETY_FAILED / POSITION / PRE_SELL / SIMULATED_BALANCE_MISMATCH`. Actual on-chain owned amount independently re-read: **3,160,729,206 atomic = 3160.729206 tokens**, matching persisted quantity. After three unsigned failures the position has a 30-minute resource cooldown and remains visible; manual emergency exit can bypass cooldown, subject to the unchanged validator.
- Positions badge **1**, attention **1**. A read-only browser check against the actual LIVE dashboard verified the badge, warning style, visible IMAGINE issue and absence of SYSTEM PAUSE, with **zero browser errors and zero mutation requests**. Screenshot: `data/fault-isolation-live.png`.
- **0 signed pending transactions**. No new BUY was submitted, no token amount was discarded, and no SELL/CLOSED outcome is claimed. The original controlled BUY allowance remains consumed; entries=false is this independent session restriction, not a global token-error halt.

Evidence: `data/fault-isolation-verification.json`; final process logs `data/fault-isolation-20261028-165316.stdout.log` and `.stderr.log`. Resume output/event reports use timestamped suffixes, preserving the original failed-run report. Secret audit: **776 files scanned, zero configured secret values detected**, no secret values printed.

**Final regression result: TOKEN_SAFETY_FAILED / IMAGINE → globally fault-paused? NO.** Owned-position attention and independent controlled limits remain in force.
