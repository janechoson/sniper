# Chart Learning integration

## Audit (2026-11-11)

The repository is a local TypeScript ES-module Node 22 service. `server.ts` owns
the HTTP dashboard and ModeManager. `one-shot-entry.ts` performs trending cheap,
security, token compatibility, history, flow and common-risk checks before
`KronosStrategy.evaluateEntry`; the risk engine and executor validate again.
`Engine` monitors positions and coordinates manual, protective and KRONOS exits.
`Store.claim` uses BEGIN IMMEDIATE, unique intents, pending-mint exclusion and
OPEN → PENDING_EXIT ownership. Executor owns reconciliation and retries.
`assertStrategySell` is checked at claim and execution. DemoExecutor receives
quote and database capabilities, not a signer; DemoLedger owns virtual funds.
ModeManager drains work and separates mode/account records. GMGN coordinator
already supplies priorities, caching and rate limits. PositionHistoryMonitor
collects completed M1 candles. Existing learning tables concern execution
observations, not chart knowledge, and will be preserved.

## Implementation order

1. Add transactional chart schema, completed-candle ingestion and causal features.
2. Persist observations, crash events, snapshots, outcomes and trade replays.
3. Add a bounded structured reasoning runtime and recoverable research jobs.
4. Gate KRONOS entry with evidence-backed Codex PASS/BLOCK.
5. Extend the existing exit coordinator with independent CODEX authority.
6. Expose real evidence, rules, decisions and replay charts in Chart Learning.
7. Run regression tests and inspect actual runtime readiness without stopping BOT.

No hypothesis is authoritative until deterministic chronological validation
passes. Missing runtime access is visible. No synthetic market observations or
forced trades are used to claim operational acceptance.
