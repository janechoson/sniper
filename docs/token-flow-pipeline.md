# Animated token flow dashboard

The current BOT B dashboard now presents the actual candidate lifecycle as a dark navy token pipeline. This is a production interface connected to existing SQLite state and SSE, not a demo. The previous Positions, History, Learning, settings, operator entry control and manual emergency exits remain available. No Jev/Risk decisions, sizing, exit policy, Token-2022 compatibility, transaction construction, signing, submission or reconciliation rules were changed for this redesign.

## Layout and components

The Dashboard has eight real pipeline counters, the existing wallet/PnL/win-rate strip, and a primary three-column flow board:

1. **Scanner source tank**: eight recent real GMGN candidates, compact market-cap/volume facts, deterministic avatars and a subtle scanning radar.
2. **Candidate queue**: ten conceptual slots, live configured occupancy, current rank, actual CHECKING spinner/wiggle and elapsed checking time. Empty and disabled-capacity slots remain visible.
3. **Decision/destination tanks**: Qualified → Jev → Risk → Approved → Buy, Watchlist, recent Rejected and Deferred.

Below the flow board, the secondary **Live Token Scanner / Recent** table and meaningful Event feed sit side by side, followed by System health. Scanner navigation jumps to the detailed table; Watchlist and Deferred have dedicated pages and live count badges. Positions retains its numeric attention badge and problem-first ordering. Historical CLOSED positions stay in History.

`public/flow.js` implements small vanilla-JavaScript components: token avatars/cards, keyed lists/queue slots, KPI cards, decision nodes, semantic event feed, SVG pipes and a bounded traveling-token scheduler. No UI framework, icon package, animation dependency, particle engine or canvas loop was added. Shared dark/semantic design tokens are defined in `public/style.css`: scanner blue, queue amber, Watch gold, Qualified/execution emerald, Rejected red, Deferred purple and neutral slate. PnL retains separate positive/negative semantics.

## Backend observability, without new trading state

`src/flow-view.ts` is a read-only projection of existing lifecycle rows, discovered tokens/normalized facts, actual Jev records, execution records and identified transition events. `Engine.flowStatus()` exposes that projection and current entry/position restrictions. It performs database reads only, with no wallet/RPC calls.

Existing lifecycle persistence now records `pipeline_transitions` when the state actually changes; score refreshes and repeated same-state writes emit nothing. Transitions retain SQLite record IDs, mint, symbol, mode, timestamp, actual from/to, score and supplied reason. Qualification records include the actual last queue origin, so a fresh qualification following WATCH is distinguishable from direct qualification. There is no second candidate/approval state machine for animation.

Existing Jev/Risk boundaries publish JEV_STARTED, JEV_COMPLETED, RISK_REVIEW and RISK_REJECTED. Existing execution persistence emits BUYING, BUY_SUBMITTED, BUY_PENDING_CONFIRMATION, BUY_CONFIRMED or the actual failed/unknown state only when the execution state changes. A risk approval never creates a BUY_CONFIRMED event. Repeated persistence of the same confirmed execution does not increment traded counts again.

The same SSE connection carries a lightweight named `flow` frame, checked at most once per second and sent only after database records change. Wallet/health/full status retains the existing five-second cadence. No extra RPC polling is introduced by the fast animation feed. Frames include current position/entry restrictions, so badges and true system banners update without waiting for a page refresh. Session counts come from stored events; Scanned is the real discovery count and the rate is actual newly discovered tokens in the last minute.

The projection exposes a maximum of 8 source cards, 10 queue candidates, 6 Watch/Deferred/reject detail previews, 6 decision candidates and 120 identified events. Runtime state/retention limits are unchanged. Database indexes support the new read paths. Missing facts are shown as unavailable, never fabricated; missing Jev confidence is not displayed as 0%.

## Animation and actual-state authority

| Actual event | Visualization |
| --- | --- |
| Discovery admitted to QUEUED | Token avatar travels blue from Scanner to Queue; arrival softly illuminates the slot. No admission event means no token travel, including when full. |
| ANALYZING | Subtle sub-pixel avatar wiggle, spinner, CHECKING and actual elapsed time. No simulated progress percentage. |
| REJECTED | Small red prohibited stamp scales 1.5 → .95 → 1, pauses about 260 ms, then exits along the red branch. |
| WATCH | Gold transfer and eye marker; no rejection stamp or checking wiggle. Watched markers breathe calmly. |
| QUALIFIED after WATCH | Green promotion path from Watch; reason remains the supplied fresh-check reason. No invented volume change. |
| Direct QUALIFIED | Green Queue → Qualified path. |
| Jev/Risk | Actual currently observed node pulses/illuminates; actual Jev action/confidence is displayed when present. |
| APPROVED / BUYING / SUBMITTED | Explicitly remain distinct from BUY CONFIRMED. |
| BUY_CONFIRMED | Green transfer to Positions; actual confirmed ledger status and time are shown. Current/open executions are preferred over older closed history. |
| DEFERRED | Purple temporary-issue branch, with real reason/recheck time and no red stamp. |
| Deferred recovery | Purple return toward Queue according to the recorded queue origin; never directly to BUY. |

Travel lasts approximately **720 ms** with eased cubic paths and transform/opacity animation. SVG paths have low-opacity moving dashes; an actual transfer briefly brightens the matching path. Queue reorder uses short FLIP transforms. Source radar activity is tied to the backend scanner-enabled/running state, independent of queue occupancy.

Backend classification stays authoritative. In particular, this bot sends retryable Risk/Jev/capacity outcomes to WATCH; the UI does not change those decisions into permanent REJECT just to draw a red pipe. Hard rejection follows the red destination, temporary failures the purple destination, and position issues remain visible in Positions. A real SYSTEM/TRANSACTION pause gets a distinct banner; token defer/reject events do not create one. A consumed controlled BUY allowance is explicitly identified as a capital/session restriction.

The UI renders each new snapshot immediately. It does not wait for a visual transfer. Identified backend events schedule at most **2 concurrent traveling avatars**, with at most **16 pending transitions**. Newer events for the same mint cancel an older flight; stale intermediate steps are coalesced rather than showing a historical BUY or leaving a ghost in Queue. Reload hydrates current state without replaying old event IDs. Navigation, scrolling, hidden documents and connection loss cancel visual flights. A disconnected view pauses motion and says DATA STALE; the first fresh frame reconstructs state without replaying the disconnected backlog.

## Data, details and performance

Token cards expose mint/source, age, MC, liquidity, volume, buy/sell counts, holders, actual token program/security, Jev and reason through tooltips and the existing decision-trace dialog. Missing metadata has a deterministic mint/symbol avatar. The existing project had no remote-image handling, so arbitrary GMGN image URLs are not fetched and the current image CSP is preserved.

The detailed scanner remains secondary and retains the owner's UNKNOWN-row display filter and integer metric formatting; tiny token prices retain precision. It is capped at 60 displayed rows. Tables have contained scrolling/sticky headers; grids use zero minimum sizing so a wide table never expands the page or overlaps the feed. Preview rejects are limited to three visible cards; the event feed is limited to 35 meaningful transitions and ignores discovery/checking noise.

Rows are keyed and reconciled only when displayed facts change; unrelated counter/score changes do not rebuild the scanner/queue. Checking elapsed labels use the existing clock timer. Geometry is measured only after updates/resize, not in an animation loop. CSS/WAAPI handles motion. Bounded token/event caches prevent session-long browser memory growth. No network request, approval, order or wallet action is caused by an animation.

Responsive layouts use three columns on desktop, a simpler two-column arrangement around 1024 px, and a vertical flow on mobile. Complex pipe geometry is hidden when it would harm readability. Keyboard-accessible buttons, text status labels and visible focus remain usable without relying on color. `prefers-reduced-motion: reduce` disables travel, wiggle, pulsing, dash movement and layout animation while preserving all state, counts, navigation and details.

## Verification

- **92 deterministic tests passed**; typecheck, lint and build passed. New backend tests cover real transition IDs/no repeat-save spam, 0/1/9/10 occupancy, defer/reject scope fidelity, and submitted versus confirmed BUY counters/events. Existing execution/risk/learning safety tests remain green.
- Browser tests passed for queue 0/1/9/10, scanner activity at full capacity, blue admission, CHECKING, reject stamp/red exit, Watch, direct and Watch-origin qualification, Deferred and recovery, Jev/Risk, submitted versus confirmed BUY, active-position badges, system pause, missing avatars, very long symbols/reasons, rapid bursts, reload and reduced motion.
- Verified **1600, 1440, 1280, 1024 and 390 px** without page-breaking horizontal overflow. Keyed-row identity survives unrelated counter updates. Fast named flow-SSE handling is exercised separately from full status updates. Rapid events leave no ghost tokens; navigation cancels outstanding flights.
- `data/token-flow-desktop-fixture.png` is a clearly PAPER-labeled isolated visual fixture, not production trading evidence. `data/token-flow-live.png` and `data/token-flow-live-verification.json` are read-only checks of the actual LIVE dashboard, described below.

## Files changed

New: `public/flow.js`, `src/flow-view.ts`, `tests/flow.test.ts`, `scripts/flow-ui-cases.mjs`, this report.

Modified: `public/index.html`, `public/style.css`, `public/app.js`, `src/store.ts` (transition observation/indexes), `src/candidate-lifecycle.ts` (transition observation/reasons), `src/engine.ts` (read model and actual stage observation), `src/server.ts` (static asset + DB-only SSE frames), `scripts/ui-test.mjs`, `package.json` (lint includes all public JavaScript). The transaction provider, signer, RiskEngine decisions, exit rules, sizing, Token-2022 validation and position execution state machine were not modified by this task. Secrets/ACKs were not edited.

## Live deployment

The existing controlled session `f2d3d364-1d45-4570-99a8-b24388185614` was resumed after checking for signed pending transactions. IMAGINE's actual position remains tracked. No new BUY allowance was created and no transaction was replayed. The original controlled limits remain principal ≤0.005 SOL, one open position, one completed trade; saved normal settings remain 5 positions/1%.

An actual LIVE browser checkpoint at **17:37:47 Asia/Bangkok, 2026-10-28** observed: Scanned **3605**, newly discovered **34/min**, queue **10/10**, checking **1**, Watch **30/30**, Deferred **0**, Rejected **97 in the Engine session**, Approved **0**, Traded **0 in that Engine session**. Position badge **1**, attention **1**, haltReason/haltScope both null. An actual named flow-SSE frame arrived. Browser errors **0**, mutation requests **0**, and no page overflow. These are timestamped observed values, not fixed UI numbers.

Entries remain disabled because this controlled session already consumed its one BUY and holds IMAGINE. Scanner/qualification/position management continue. The UI does not claim another BUY or a successful IMAGINE SELL. Final deployment/current read-only evidence is appended after verification.

### Final LIVE checkpoint

The final build runs as PID **15816**, with logs `data/token-flow-20261028-174234.stdout.log` / `.stderr.log`. At **17:43:42 Asia/Bangkok** an additional real browser check confirmed queue **10/10**, Watch **30/30**, Positions **1 with attention**, original IMAGINE confirmed entry selected in the execution panel, no SYSTEM pause, a named flow-SSE frame received, **zero JavaScript errors**, **zero mutation requests**, and no page overflow. The original BUY confirmation time is shown explicitly; it is not represented as a new trade.

Final read-only evidence: `data/token-flow-live-final-verification.json`; actual LIVE screenshot: `data/token-flow-live-final.png`. The independent UI tests also cover full-capacity scanning, node identity on unrelated counter updates, all state routes, fast event bursts, interrupted travel, reload and reduced motion. `pnpm test` **92 passed**, typecheck/lint/build passed, and the final extended browser suite passed. Secret audit inspected **790 files**, with **zero configured secret values detected** and no secret values printed.
