# Chart Learning V5 audit

## Control flow

- Discovery and cheap candidate filters run before `oneShotEntry` reaches the pre-BUY AI Guard stage. The Guard is called once at that stage; only a validated `PASS` continues to KRONOS and RiskEngine. Confirmed execution and persisted OPEN position remain prerequisites for Learning Case registration.
- `ChartCollector` remains an automatic deterministic worker. It stores post-BUY evidence and schedules 5/15/30/60 minute post-SELL collection. It has no Codex runtime call.
- Historical review is handled by `ChartAnalyzer` only after a manual request. It compares the selected closed case with a bounded cohort of closed cases from the same mode/account, records semantic hypotheses as DRAFT, and never promotes them automatically.
- The existing deterministic validated-rule path for held positions and protective SELL remains independent from the pre-BUY AI Guard.

## Guard design

- `CodexAIGuard` sends fresh bounded market/history evidence and only latest VALIDATED `PRE_BUY` semantic knowledge to `CodexRuntime.analyzeGuard`.
- Responses use a strict schema; knowledge version and evidence references must match supplied context. Candidate authority, market freshness, and price movement are checked again after inference. A PASS expires after the configured deadline.
- Default timeout is 8 seconds, concurrency and attempts are fixed at one, and failure policy is BLOCK. Cold start defaults to UNCERTAIN but still invokes Codex. Timeout, provider failure, malformed output, stale evidence, or uncertainty rejects the candidate.
- Guard decisions are appended to the shared Learning database with prompt/model, knowledge revision, hashes, runtime outcome, queue wait, and latency. No trade database is migrated by this feature.

## Persistence and limitations

Migration 21 adds versioned semantic knowledge, validation evidence, and immutable AI Guard audit tables. It is additive and uses `IF NOT EXISTS`/`INSERT OR IGNORE` patterns. Validation requires at least three distinct-mint closed holdout cases, known outcomes, and no same-mint or overlapping-time leakage from cited training cases.

Automated tests mock Codex and providers, so they verify routing, validation, audit, and failure behavior, not the quality of real model reasoning. Runtime latency summaries are based on actual recorded calls and remain empty until calls occur. An 8-second Codex deadline may reject candidates if the provider is slower. Protective SELL does not wait for the AI Guard.
