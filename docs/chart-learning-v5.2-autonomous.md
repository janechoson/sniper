# Rug Killer V5.2 autonomous Learning lifecycle

## Lifecycle and promotion policy

After a confirmed BUY, the existing collector records chart, decision, position, SELL and post-SELL evidence without Codex. Eligible cases receive the configured delayed analyzer job. New semantic knowledge remains a DRAFT until a frozen, independent pre-BUY replay completes.

The replay freezes the full evidence and outcome snapshot and hashes it. It excludes training case IDs, same mints, overlapping windows with a one-hour pad, duplicate candle fingerprints and evidence unavailable by the original BUY cutoff. The model receives no outcome label or PnL. A changed holdout hash creates a new validation job; a hash already evaluated for the same knowledge version is not replayed again. Incomplete minimum coverage is recorded as `NEEDS_MORE_DATA` and does not consume Codex calls.

Automatic promotion is deterministic and transactional. Defaults require 30 independent mints, at least 10 examples in each class, precision and recall >= 0.70, 95% Wilson lower bounds >= 0.40, false-positive rate <= 0.20, and abstention <= 0.20. Undefined metrics and failed metric-integrity checks block promotion. Passing results create a new immutable `VALIDATED` knowledge version in the same transaction as the complete validation report. Failed quality gates create an immutable `REJECTED` version. A stale or user-controlled revision cannot be promoted by an older replay.

These are conservative starting thresholds, not proof of predictive quality. The default 30-case minimum is still a modest sample; production performance should be treated as provisional and monitored.

## User controls and suppression

Knowledge versions and user actions are separate append-only records. The dashboard can inspect version history, supporting trades, validation reports/metrics, Guard decisions that matched the knowledge, drift outcomes, and control history. User actions are `DISABLE`, `REJECT`, soft `DELETE`, and `RESTORE`; no action deletes a trade, chart, validation, or audit row. The Guard reads only the newest VALIDATED PRE_BUY version whose latest control is RESTORE or absent.

REJECT and DELETE add durable suppression entries to the control-event history. Automatic draft creation compares normalized title, description, category, stage and behavior tokens. Same fingerprint or Jaccard overlap >= 0.80 in the same category/stage is suppressed until an explicit RESTORE. This lexical policy is inspectable and intentionally does not claim embedding-based equivalence.

Before accepting a Guard response, the service rechecks the active knowledge revision. Any revision change during inference fails closed, so a disable/delete/reject cannot leave an in-flight stale PASS authoritative.

## Drift monitoring

The validator monitors newly closed positions whose pre-BUY Guard PASS matched an active knowledge version. It excludes the version's training and original holdout cases, repeated mints and overlapping windows. Ten independent post-deployment cases with a dangerous-outcome rate above 30% trigger an append-only SYSTEM `SUSPEND` event; suspended knowledge is immediately excluded from future Guard requests. The dashboard exposes drift sample counts and outcomes. User RESTORE is explicit and audited.

This detects deterioration among observable matched PASS trades; it cannot estimate counterfactual outcomes for buys blocked by Guard. Drift monitoring continues when automatic analyzer/validation scheduling is disabled.

## Persistence and tests

Migration v23 only adds control-event and drift-case tables/indexes/triggers. It does not alter or delete trading/learning history. Validation reports, knowledge versions, user overrides and system suspensions remain immutable; DELETE is a soft control event.

Automated checks use in-memory or temporary SQLite and mocked Codex responses. They cover automatic promotion/rejection gates, insufficient data and changed-dataset revalidation, unchanged-dataset deduplication, restart recovery, concurrent validation, user control/suppression/restore, in-flight Guard invalidation, drift suspension, additive migration, and unchanged trade history. No LIVE trade or real Codex request is part of test verification.

Synthetic tests demonstrate contract behavior only. No production holdout quality or trading performance claim is made until independent real cases accumulate and the dashboard reports their measured results.
