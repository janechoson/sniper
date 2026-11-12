# Rug Killer V5.1 validation and AI scheduling

> Historical V5.1 design note. V5.2 supersedes the manual validation approval described by earlier implementation snapshots: qualifying validation now promotes automatically, while user controls are DISABLE, REJECT, DELETE (soft), and RESTORE. See [V5.2 autonomous lifecycle](chart-learning-v5.2-autonomous.md).

Implementation notes for the V5.1 validation, PASS freshness, and automatic Learning update.

## Holdout replay

- `ChartValidationEngine` freezes an immutable dataset and SHA-256 hash when a DRAFT is queued. The replay input contains only the frozen pre-BUY context and DRAFT; outcome labels and PnL remain outside the model input.
- The holdout excludes training case IDs, same-mint cases, overlapping position windows (with a one-hour pad), repeated candle fingerprints, and candles that were unavailable or incomplete at the BUY decision cutoff.
- Label policy `DANGEROUS_TRADE_V1`: a case is dangerous when realized PnL is at or below `KNOWLEDGE_VALIDATION_DANGEROUS_PNL_PCT`, or when a linked observed `RUG_30` event occurred during the held position. A smaller ordinary loss is not automatically a dangerous label.
- Reports preserve per-case prediction, label, PnL, simulation mode, account/mode metadata, decision time, evidence IDs and availability times. Metrics include TP/FP/TN/FN, precision, recall, specificity, false-positive/negative rates, F1, coverage, abstention and PnL groups. Undefined denominators remain `null`.
- Promotion requires every configured minimum class count / sample count and quality threshold to pass, then a separate explicit approval. The old sample-count-only promotion path is disabled. Replay output never changes the Guard by itself.

Defaults are initial policy thresholds, not evidence of achieved model quality: 10 cases, 3 positive and 3 negative examples, precision and recall >= 0.70, false-positive rate <= 0.20 and abstention <= 0.20. Thresholds are configurable through environment variables.

## PASS freshness and final BUY check

`AI_GUARD_TIMEOUT_MS` is the inference deadline. `AI_GUARD_PASS_TTL_MS` is a separate default 15-second validity period that begins after inference finishes. A PASS expires at the earliest of that TTL and the freshness limits of the market and authority evidence. Immediately before quote/sign work, the BUY path fetches a new market observation and rechecks price movement, evidence freshness, authority, risk and size. Failure to make the check blocks unsigned entry.

## Automatic case Learning and Codex lane

The collector continues to persist observations, event detection, metrics and post-SELL follow-ups without Codex. Eligible cases receive durable automatic analysis jobs after at least 30 seconds (`AUTO_CHART_LEARNING_DELAY_MS`); attempts are bounded and exhausted jobs become dead letters. Automatic analysis can be disabled with `AUTO_CHART_LEARNING_ENABLED=false` without disabling deterministic collection.

One in-process request scheduler serializes all Codex traffic: Guard requests are highest priority, validation replay is next, and retrospective Learning is last. A running request is never claimed to be preempted; Guard runs next when the current bounded request completes. Background requests observe the configured minimum spacing. Queued Guard work is cancellable on timeout/stop.

Similar DRAFTs in the same category and stage are merged into a new immutable DRAFT version using a lexical overlap score and provenance union. This is a review aid, not an embedding-based semantic equivalence claim. VALIDATED versions are not modified by this merge.

## Verification and limits

Automated tests use in-memory/temp databases and mocked Codex responses. They cover holdout exclusions and frozen evidence, metrics and abstentions, promotion gates and explicit approval, automatic job delay/recovery, scheduler priority, PASS TTL, stale evidence, final BUY revalidation and migration idempotence. No real Codex call, LIVE trade, production database reset or database deletion is part of this verification.

Synthetic fixtures prove the implementation contract only. No claim is made that the thresholds are statistically calibrated or that the current production dataset contains enough independent cases; the dashboard must show incomplete/failed gates honestly until real holdout coverage exists.
