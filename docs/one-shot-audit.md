# Audit before implementation — 2026-11-01

The existing project is retained. No environment, wallet or operator settings are changed.

1. `DiscoveryCoordinator.pollSource` calls `Gmgn.trending`, merges tokens into SQLite, and records discovery timestamps.
2. `CandidateLifecycle.refill/fail/decision` persists WATCH, STRUCTURE_WATCH and DEFERRED rows with retry deadlines and previous scores.
3. `Engine.analyzeCandidate` consults previous `entry_structure_watch`, admits a ten minute watch after PRE_WATCH Risk, and resumes after structure confirmation. Timer and tick both invoke `observeStructureWatches`.
4. `CapitalFlowEngine.observeCandidate` reuses `candidate_flow_states` across attempts. Structure uses recent locally accumulated observations; there is no one-hour historical candle fetch.
5. BUY JEV receives `TradingMemory.jevContext` and previous trade retrieval. RiskEngine PRE_WATCH skips structure; EXECUTION demands the persisted Watch authority. Temporary recovery bypass remains configurable.
6. Executor already implements Jupiter quote validation, pre-buy exit probes, simulation, final validation, immediate pre-sign authority, durable signature, confirmation and reconciliation. Preserve this path.
7. Position monitoring has an independent five-second timer, but its `for...of` awaits security, market, SOL price and optional smart money for each position. One slow request delays later positions. GMGN coordinator also awaits each request to completion before launching the next.
8. JevExitScheduler is already bounded/configurable and asynchronous. Existing stale protection checks identity, quantity, decision revision, flow signal, age, price movement and signed execution. Preserve and strengthen snapshot isolation.
9. HTTP server pushes full status by SSE every five seconds and flow deltas on a shorter record cursor timer. Frontend is vanilla JS/CSS/HTML; current overview is a sidebar and pipe/tank visualization, unlike the supplied mockup. Other tabs and safe manual exit API already exist.
10. SQLite already has records, tokens, candidate lifecycle, structure watches, flow states, positions, intents, executions, trade learning history and manual exit tables. Add only bounded attempt auditing, preserving all existing history.
11. Watch/recovery settings must remain parseable for old config compatibility, but must not authorize the new one-shot pipeline.

Verification must use in-memory or temporary paper databases with all live credentials removed. Do not restart the operator process or trade for verification.
