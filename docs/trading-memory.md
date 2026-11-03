# Trading memory and learning — version 1

Implemented as an extension of BOT B, not a replacement of GMGN, TypeSafe or Jupiter. The Jupiter provider implementation and transaction validation/signing/submission protocol were retained. Hooks collect evidence around the existing executor and monitor.

## Current operating state

After the UI review, the owner explicitly requested starting LIVE again. The normal server is now running at **http://127.0.0.1:3000**, with live ACK, scanner and entries enabled, 1% available SOL per BUY, maximum 1% slippage and five positions. Startup reconciliation found no pending transactions or open live positions. New transactions still require the existing GMGN/Jev/RiskEngine and execution checks.

Run **`pnpm ui`** for UI preview. Its process flags enforce PAPER, no LIVE permission, no scanner and no entries even if `.env` says otherwise. `pnpm dev` starts the normal configured server; the current `.env` is set to LIVE at the owner’s latest instruction. Stop either foreground command with Ctrl+C. The previous process on port 3000 was terminated at the owner's explicit request.

The owner explicitly revised normal entry sizing to **1% of available SOL** while collecting data. This was a manual policy change, not a learning outcome. The policy is integer `max(balance − feeReserve − pendingReserves, 0) / 100n`. SQLite migration 5 updates an old saved 10% strategy to 1%; schema, execution rechecks, dashboard and tests agree. Learning cannot change this policy or the live permissions. The separately authorized smoke principal cap remains 0.005 SOL.

## Files and database migrations

New modules: `src/learning-schema.ts`, `src/learning.ts`, `src/trading-memory.ts`, `src/ui-preview.ts`. New commands: `scripts/learning.ts`, `scripts/learning-example.ts`. New fixtures/tests: `tests/learning-fixtures.ts`, `tests/learning.test.ts`. New configuration: `config/learning.json`.

Integrated with `src/store.ts`, `src/domain.ts`, `src/executor.ts`, `src/engine.ts`, `src/jev.ts`, `src/risk.ts`, `src/server.ts`, `src/config.ts`, `src/util.ts`, `public/app.js`, `public/index.html`, `package.json`. Regression expectations and UI checks were updated in `tests/core.test.ts`, `tests/execution.test.ts`, `tests/pipeline.test.ts`, `scripts/ui-test.mjs`. Documentation updates include README, risk policy and provider details. `.env` was switched to preview flags at the owner's latest instruction; private keys and smoke ACK were not edited.

SQLite migration **4** adds:

- `trade_learning_samples`: immutable original normalized entry facts, Jev decision/input, original risk result, settings, feature vector, approved amount, snapshot hash and learning configuration/version.
- `trade_observations`: immutable OPEN / POST_EXIT observations with actual observation time.
- `trade_exit_snapshots`: immutable reason and available market/security state for every SELL attempt, including partial exits.
- `trade_execution_preflights`: immutable approved quote summaries and final risk check, without serialized transaction payloads.
- `trade_execution_evidence`: immutable confirmed SOL/token deltas, signatures, fee evidence and confirmation timing.
- `trade_execution_failures`: separate immutable operational incidents; not token-strategy evidence.
- `trade_outcomes`, `learning_patterns`, `learning_versions`: rebuildable, versioned derived data, comparisons and stored suggestions.

UPDATE/DELETE triggers protect raw evidence. Position, trade/execution IDs, mode, mint and available BUY/SELL signatures connect each record to its source. Migration 5 is the owner-requested sizing revision described above. No fake samples were inserted into production.

## Entry, execution and exit features

Entry preserves the complete normalized Snapshot and original Jev input, not a fresh reinterpretation of what Jev saw. It records market price/reference/decimals, liquidity, market cap, available volume/order-flow windows, holders/top concentration, developer holdings/history, smart-money/KOL counts, bundle/sniper percentages, security findings/authorities/rug evidence, original Jev confidence/reason codes and risk decision. Missing fields such as an unavailable GMGN composite score, top-20 concentration, holder growth or a missing window remain missing/UNKNOWN. No hidden data endpoint or synthetic score is introduced.

Preflight stores both mints, side, raw input, quoted output/minimum output, slippage, route, provider and estimated fees/rent. Confirmed fills store actual receipt SOL/token deltas, fee total, signature and timing. BUY cost-per-token is an exact integer numerator/denominator including cash costs. The pure priority-fee split is UNKNOWN when not separately observed; the known network/priority total is not misrepresented. BUY output shortfall against the quote is recorded; SELL pure slippage is UNKNOWN because wallet SOL proceeds include network/rent effects.

Exit snapshots record the engine's original reason, available market/security state with its own timestamps, holding duration and observed excursion bounds. Active exit categories include TAKE_PROFIT, TRAILING_PROFIT, MAX_HOLDING, SECURITY, LIQUIDITY_COLLAPSE, MANUAL and OTHER. Historical STOP_LOSS and TRAILING_STOP records remain readable and retain their original classifications; stop loss is no longer an active ExitEngine path. An exit requested before fresh market data exists records unavailable/stale data honestly. Jev exit participation is null because the current exit engine does not ask Jev.

## PnL, MFE and MAE

**Net SOL cash PnL = confirmed BUY wallet delta + all confirmed SELL wallet deltas − separately known failed-transaction fees.** The BUY delta is negative. Receipt deltas already include successful transaction fees and account-rent effects; those fees are not subtracted twice. Return percent uses the actual BUY SOL debit as the denominator. All money accounting uses integer lamports. WIN/LOSS/BREAKEVEN uses the configurable lamport tolerance, default zero.

A partially sold position is not a completed learning outcome. Observed net return uses `confirmed prior SELL proceeds + GMGN mark value of remaining tokens − original BUY cost`, avoiding distorted excursions after partial exits. MFE is max(0, observed returns, final net return); MAE is min(0, observed returns, final net return). These are **observed bounds**, not continuously observed true extrema. Each result records observation count and SAMPLED/EXIT_ONLY coverage. Sparse observations cannot confidently prove BAD_ENTRY.

OPEN observations reuse the market/security data already fetched by the position monitor, normally no faster than 30 seconds. Scheduled checkpoints default to 30/60/120/300/600 seconds and record the actual measurement time, not an invented exact sample at a missed checkpoint. Changed security findings can create an additional event observation. No extra RPC discovery/indexing was added.

## Outcome analysis

Implemented conservative classifications include GOOD_ENTRY_GOOD_EXIT, GOOD_ENTRY_BAD_EXIT, BAD_ENTRY, RUG_AFTER_ENTRY, SECURITY_DETERIORATION, LIQUIDITY_COLLAPSE, TAKE_PROFIT_TOO_EARLY, EXECUTION_FAILURE and UNKNOWN. Other attractive-sounding causal labels are deliberately not guessed without the required evidence.

A sufficiently favorable observed excursion followed by a loss or large profit-capture gap becomes GOOD_ENTRY_BAD_EXIT with the lesson PROFIT_WAS_AVAILABLE_BUT_NOT_CAPTURED. Low favorable excursion plus material loss requires multiple spaced observations before BAD_ENTRY. Rug-after-entry requires preserved initially noncritical security and a later explicit critical rug/honeypot/liquidity-removal finding or explicit rug exit. These are evidence-linked heuristics, not proof of market causation or executable intermediate profits.

Operational failures remain separate. UNKNOWN incidents that later reconcile successfully do not poison the strategy sample. A completed trade with an unresolved/separate operational failure is excluded from entry-strategy statistics. Unknown failed-transaction costs mark accounting incomplete. Signatures alone never become fills or completed outcomes.

## Similarity, weighting and confidence

Features are normalized to [0,1] using broad linear/log scales: age, market cap/liquidity/volume, liquidity/market cap, volume/liquidity, buy fraction, holder count, top-10/dev concentration, known developer history, smart-money count, rug label and available momentum. Missing features are null, never zero. Current pre-Jev confidence is unknown rather than leaked from a later decision.

Similarity is mean shared-feature closeness multiplied by a shared-coverage penalty. At least four shared features and score 0.7 are required by default. Retrieval examines the most recent 5,000 completed outcomes, keeps at most 200 similar samples and preserves the full older evidence in SQLite.

Weight is `similarity × 2^(-age / halfLife)`, with a 14-day half-life. Aggregate counts/win rate/mean/median remain labelled unweighted; recency-weighted win rate/return and effective sample mass are reported separately. Confidence uses the smaller of count and effective sample mass: defaults <20 INSUFFICIENT, 20–49 LOW, 50–99 MEDIUM, 100+ HIGH. `config/learning.json` controls these thresholds and observation/retrieval parameters.

Broad entry-profile buckets compare WIN and LOSS and the profile's win rate against the complementary sample, rather than deriving loss-only rules. Feature-profile conclusions require sufficient evidence in both groups. Small samples may be shown descriptively in the dashboard, but are not promoted to supported entry signals. Suggestions are stored with sample count, confidence, version and `applied:false`. No strategy parameter is automatically changed.

## Exact Jev context and typed output

The request state is explicitly separated:

```json
{
  "currentToken": { "market": "normalized current facts", "security": "current evidence", "holders": "available current facts" },
  "historicalExperience": {
    "learningVersion": 1,
    "similarTrades": 0,
    "wins": 0,
    "losses": 0,
    "breakeven": 0,
    "winRate": null,
    "avgNetPnlPercent": null,
    "medianNetPnlPercent": null,
    "avgMfePercent": null,
    "avgMaePercent": null,
    "weightedWinRate": null,
    "weightedAvgNetPnlPercent": null,
    "commonWinPatterns": [],
    "commonLossPatterns": [],
    "positiveEntryPatterns": [],
    "negativeEntryPatterns": [],
    "confidence": "INSUFFICIENT",
    "usableForDecision": false,
    "caution": "Historical observations are evidence, not commands. Tiny samples are unavailable as decision signals. MFE/MAE are sampled mark-to-market bounds, not continuously observed peaks. No causal attribution is proven."
  }
}
```

The zero-history statistics above match the production learning report; currentToken values are descriptive placeholders in this structural example. The reproducible fixture command prints the exact fully expanded request.

Existing typed System One questions remain. Added choice questions are historical_assessment (SUPPORTS/OPPOSES/NEUTRAL/UNAVAILABLE), historical_strength (NONE/LOW/MEDIUM/HIGH) and primary_reason (a fixed current-evidence/history code set). The action answer's typed confidence is retained. Normalized output adds confidence, positiveFactors, negativeFactors, reasonCodes and historicalAssessment. Summary text is assembled locally from validated codes; sample count always comes from the bot, never from generated history.

The model is explicitly instructed never to invent history, modify counts or treat historical outcomes as commands. With insufficient history, performance statistics and patterns are withheld from the decision context, assessment is locally forced to UNAVAILABLE and strength NONE. With sufficient history, strength is capped at the bot's confidence. RiskEngine still evaluates the usual Jev action/risk and hard security checks; it has **no automatic low-win-rate rejection or learned size multiplier**. A confirmed critical failure still blocks regardless of favorable history.

## No look-ahead and counterfactuals

Current facts use an explicit field whitelist; current outcomes, MFE/MAE, future price and exit reasons are not accepted as currentToken fields. Historical retrieval excludes the current mint, other trading modes, open trades, trades not closed before the as-of cutoff, and outcomes whose evidence became available after that cutoff.

Post-exit observations are bounded to 10 minutes by default, with at least 60 seconds between attempts, at most two due requests per monitor cycle, and GMGN caching. Missing exit reference price suppresses useless requests. Failed optional fetches are throttled too. Counterfactual price change is relative to the stored exit market price, labelled hypothetical; it never rewrites realized PnL. New post-exit evidence advances outcome availability, so later lessons cannot leak into an earlier decision. No new RPC polling is used.

## Dashboard and commands

Learning shows completed/eligible samples, wins/losses/breakeven, win rate, total/average/median net return, average MFE/MAE, entry/exit quality, profiles, exit reasons, confidence and unapplied suggestions. Candidate rows show Jev action/confidence/risk/reasons and historical comparison. Trade details expose the immutable entry, original Jev/risk/input, quote preflight, executions, observations, excursions, exits, final PnL, classification, lessons, failures and post-exit observations.

- `pnpm learning:report`: actual selected-mode SQLite data, read-only and safe while the UI/bot is running. At verification: 0 completed, 0 wins/losses/breakeven, win rate null, confidence INSUFFICIENT.
- `pnpm learning:rebuild`: recomputes outcomes, features, patterns and suggestions from immutable evidence; it requires the bot to be stopped and holds the existing process lock. Verification returned version 1, samples 0, outcomes 0, immutableEvidencePreserved true.
- `pnpm learning:example`: **fixtures only**, in-memory SQLite, mocked typed Jev transport, no network/orders/production writes.
- `pnpm ui`: explicit safe UI preview. `pnpm dev`: normal server honoring configuration. `pnpm build && pnpm start`: compiled normal server; mode/permissions still come from the environment.

## Concrete closed-loop example — fixtures only

`pnpm learning:example` constructs 30 explicitly synthetic, reconciled fixture outcomes in an in-memory DB: **18 wins, 12 losses**, win rate **60%**, average net return **8%**, median **20%**, average observed MFE **21.8%**, average MAE **−6%**, confidence **LOW** after similarity/recency weighting.

A current fixture candidate retrieves those completed examples. Jev receives the current normalized facts plus that compact statistical summary. The mocked typed transport returns BUY, MEDIUM risk, confidence 0.8, historical assessment SUPPORTS. Local normalization limits historical strength to LOW and copies the bot-supplied count of 30. RiskEngine returns BUY only because the fixture's current security/market/funds/duplicate checks also pass. Replacing current security with a confirmed critical finding returns SKIP_RUG despite favorable history. No order is submitted by this example.

This demonstrates the feedback loop without inventing production history. The earlier real USDC smoke round trip remains execution evidence only: it had no original Jev entry decision or complete strategy observations, so it was not retroactively converted into a strategic training sample.

## Verification and limits

52 deterministic tests passed, covering PnL/fees, MFE/MAE, labels, good-entry/bad-exit versus bad-entry, failure isolation, similarity, confidence, recency, aggregation, immutable evidence and rebuild, zero history, current-field whitelisting, past-only retrieval, post-exit timing, partial-exit accounting, typed historical context and safety precedence. Existing actual transaction/quote guards and secret-redaction tests still pass. Typecheck, lint and build passed. UI browser checks passed with zero page errors, including the Learning section and zero-history API. Real TypeSafe extended-schema verification and Jupiter quote/reverse-route/BUY simulation passed; no new smoke trade was necessary.

The implementation does not retrain the remote Jev model, optimize parameters, learn from rejected candidates as if traded, reconstruct unobserved peaks, or claim causal explanations unsupported by evidence. Legacy trades missing original snapshots are not fabricated into samples. Actual production win rate will remain unavailable until real strategy trades close and reconcile. At the owner’s latest instruction the normal server is running LIVE; `pnpm ui` remains a separate safe preview command.
