# Trading Memory V2 — dependency map before implementation

Audit date: 2026-11-04. Target: this `sniper` checkout only. Existing FIFO/batch changes are retained. No change or restart of `gmgn-sniper` is authorized.

| Existing source | Persisted evidence / dependency | V2 boundary |
| --- | --- | --- |
| `learning-schema.ts`, Store constructor | V1 samples, observations, exit snapshots, execution evidence/preflights/failures; immutable update/delete triggers. Mutable outcomes, patterns, versions. | Do not migrate or delete these tables during implementation. |
| `TradingMemory.entry/confirmed/failure` | STANDARD sample copies approved Snapshot/hash; explicitly returns for KRONOS. `observe` requires existing sample. | Cannot obtain cross-strategy coverage by relying on V1. |
| `Executor.execute/recover`, Store executions/positions | Authoritative intent, claim, snapshotHash, signatures, reconciled evidence and accounting; mutable execution state. | Read directly with native read-only SQLite; never instantiate writable Store/Engine in observer. |
| `one-shot-entry.ts` | Persisted `snapshots` and `approved_intents`; attempt-bound common risk, JEV inputs/decisions, KRONOS decisions and branch evaluation records. Snapshot contains decision-time M1 history, Flow, Security, holders, Markup/V3 when evaluated. | Match exact snapshot hash and attempt/owner; never substitute latest mint snapshot. |
| `market-history.ts` | Completed timestamped M1 OHLCV, fetchedAt, coverage, missing diagnostics; actual available history. | Preserve source snapshot and filter completed pre-decision candles; no later history fetch or reconstruction. |
| `Engine.monitor`, strategy-authority | Current position market/security, position history, JEV exit contexts; KRONOS forecast/decisions persisted separately; first-buy ownership remains execution authority. | Consume stored records; never call monitor or strategy handlers. No new GMGN traffic. |
| `trade-accounting.ts` | Shared authoritative pure accounting projection; deduplicates fills, fees/rent/FX completeness, partial exits, finalExit and duration. | Reuse projection, never overwrite Position/accounting. Unresolved executions or incomplete net accounting cannot become final WIN/LOSS. |
| `TradingMemory.retrieve`, `learning.ts`, `Jev` | V1 statistical retrieval and explanatory context; runner memory also participates in STANDARD exit context. One-shot JEV input intentionally disables trade-memory questions. | V2 retrieval is a separate API; do not inject it into current trading prompts or alter runner state. |
| `TradingMemory.rebuild`, learning scripts | Rebuild deletes/recomputes mutable V1 outcomes/patterns from immutable evidence; not a fresh cohort reset. | Never call rebuild/reset automatically. |

Implementation boundary chosen after audit: a separate, explicitly started, low-priority observer process with its own SQLite database, bounded incremental polling, durable cursors and analysis jobs. Trading DB connection is read-only/query-only. Existing trading source, API, UI fetches, model prompts and lifecycle hooks remain untouched. This avoids adding synchronous learning writes to execution and avoids giving JEV authority over KRONOS.

V2 is inactive until an explicit new-cohort cutoff is approved. It never imports V1 samples/conclusions. Backups and an exact V1 reset plan are separate from implementation; destructive reset requires separate approval. Historical positions/executions/accounting, immutable learning evidence and runner state remain preserved.

Known evidence limits before implementation: source execution/position rows are mutable, so an observer can preserve only persisted changes it sees, plus durable records retained by the trading system; it cannot recover intermediate states that were never logged. Record-time evidence must not be represented as decision-time evidence. Missing approved snapshot, model forecast, fees, candle volume or historical coverage remains explicitly missing. Polling does not prove continuous MFE/MAE or independent trade events.
