# Chart Learning V3 test plan

## Audit findings

- `one-shot-entry.ts` currently registers every candidate with `ENTRY_CANDIDATE` before any gate or BUY.
- The pre-buy Codex Guard calls `ChartLearning.decide()`, which currently writes candles, windows, snapshots, chart decisions, and a `GUARD` observation queue entry.
- The periodic Learning worker also registers `Store.tokens()` as `DISCOVERY_SAMPLE`, fetches their history, and enqueues event reviews, including tokens never bought.
- Open-position Codex observations also call `decide()`. This is a valid post-BUY path, but it shares the pre-BUY write behavior.
- Closed positions get a replay through the shared `TRADE_CLOSED` outbox, while open positions have no explicit, idempotent Learning Case and entry registration path.
- Shared outboxes currently copy observations and execution records without checking successful BUY eligibility.

## Implementation plan

- Keep the Guard read-only with respect to the Learning database; preserve validated BLOCK rule evaluation and existing operational audit events.
- Add an idempotent per-position Learning Case keyed by the persisted position ID, validated against a confirmed BUY execution and OPEN position.
- Start chart ingestion and observation only after that check; resume/recover OPEN cases after restart and continue case-specific updates through close and SELL follow-up.
- Filter shared outbox records and AI jobs through eligible case/evidence links. Keep replay and execution provenance intact.
- Expose case counts separately from event/candle/analysis counts.

## Test matrix

| Scenario | Expected result |
|---|---|
| Discovery, pre-BUY history, Guard PASS/BLOCK, KRONOS signal | No case, candle, event, snapshot, chart decision, queue item, or AI job |
| BUY pending, failed, or unknown | No case or Learning ingestion |
| DEMO confirmed fill with persisted OPEN position | Exactly one case and entry history ingestion |
| LIVE confirmed receipt with persisted OPEN position | Exactly one case and entry history ingestion |
| Repeated registration / restart recovery | Same case ID, no duplicate case/job; missing entry snapshot is recoverable |
| Separate positions for same mint | Distinct cases while sharing deduplicated market candles |
| OPEN position observations | Continue adding eligible candles and position decisions asynchronously |
| CLOSED profitable, losing, break-even, or rug case | Preserve outcome evidence and enqueue review without restricting by outcome |
| Confirmed SELL | Continue 5/15/30/60m follow-ups; actual and hypothetical outcomes remain distinct |
| Existing validated Guard rule | Still evaluated before BUY without Learning writes |
| Learning provider failure | No effect on BUY/SELL execution |
| Shared outbox with unbought/failed execution | Record excluded from Learning |
| Existing data and migrations | Migration additive; no automatic historical deletion or rule promotion |

## Verification

- Add deterministic unit/integration coverage around eligibility, idempotence, shared outbox filtering, and restart recovery.
- Run Chart Learning, execution, shared-database, and route suites; run typecheck, lint, build, and fixture browser coverage.
- Never enable real LIVE trades in tests. The requested production Learning-data wipe and bot stop happen only after verification.
