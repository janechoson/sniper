# Three databases: audit, plan and test contract

Audit: Store currently initializes market, chart, learning and both financial
modes in one SQLite file. Engine/Executor and discovery helpers consult mutable
env.TRADING_MODE. ModeManager drains engines and rejects leaving unresolved LIVE
custody, but restarts ChartLearning on every switch. ChartLearning.decide awaits
an LLM with applicable validated rules. Dashboard chart queries filter by mode.
Direct SQL exists in Store, Engine, lifecycle/attempt/discovery helpers, financial
views, server routes, research scripts and migration preflight. Existing changes
from the previous task are preserved.

Implementation: immutable bound trading Stores, SQL ownership triggers, separate
shared Learning connection, registry-owned singleton research/collector, local
outboxes with idempotent delivery, deterministic compiled rule evaluation, and
server/request context capture. Keep legacy Store construction for regression
fixtures; production explicitly uses DatabaseRegistry. No change to KRONOS or
the risk/execution policy. Leaving LIVE remains blocked by unresolved holdings,
transactions or emergency requests. Learning runs across the transition barrier.

Migration: require exclusive offline legacy custody, create SQLite online-backup
snapshot (including WAL), retain original and backup, journal every copied row,
quarantine unknown/conflicting ownership, verify accounting/counts/FKs/integrity,
publish completion only after all destinations verify. Never infer missing mode
from default settings or filenames. Interrupted copies resume idempotently.

Before E2E: unit-test ownership triggers and stale contexts; shared candle/rule
deduplication; no LLM fast-path calls; dual-model routing; outbox crash recovery.
Integration-test both-mode buys/sells with fixture signers only, wrong-mode
writes, virtual/on-chain accounting separation, pending LIVE barriers and restart.
Migration fixtures cover explicit DEMO/LIVE rows, ambiguous rows, interrupted
copies, immutable evidence and retained balances. Concurrent connections test WAL
integrity. API/browser E2E checks trading scope changes while learning counts and
evidence remain identical. Existing suite must pass. Benchmark the same 2,000
chart-window workload before/after with p50/p95/p99; record inference-free rule
evaluation separately from provider/KRONOS/network latency. Real LIVE submission
is prohibited during these checks. Temporary test databases/builds are removed.
