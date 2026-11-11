# Atomic BUY ownership after KRONOS-only migration

KRONOS is the only active strategy. Dual-branch FIRST_BUY_WINS arbitration and its UI have been removed.

The existing atomic `Store.claimMintForBuy` protections remain: BEGIN IMMEDIATE transaction, one active `(mode,mint)` claim, bound attempt/decision/authority metadata, unique intent/execution keys, and duplicate position/pending-transaction guards. An independent candidate worker or repeated discovery cannot claim a second BUY for the same owned mint.

Historical STANDARD labels remain readable and are never transferred to KRONOS. An unresolved legacy LIVE owner blocks migration before writable startup. See [current architecture](kronos-demo-live-migration-audit.md).

Cross-connection claim races and independent process session ownership/crash recovery are covered by regression tests. DEMO account reset archives the old account, deactivates only DEMO claims and preserves real executions/claims.
