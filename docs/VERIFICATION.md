# Verification — KRONOS-only DEMO/LIVE

Verified 2026-11-11 on Windows with the repository's Node 22.22.0 executable and pnpm scripts. Changes are on local `develop`; no deployment or remote push was performed.

| Check actually executed                                           | Result                                                                                                                                                       |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm test`                                                       | **480 passed, 0 failed, 0 skipped**, including child-process session crash/recovery and atomic ownership races.                                              |
| `pnpm typecheck`                                                  | PASS                                                                                                                                                         |
| `pnpm lint`                                                       | PASS                                                                                                                                                         |
| `pnpm run build --out-dir .build-kronos-demo-sol-verify`          | PASS; same build script with isolated output, removed after verification.                                                                                    |
| `pnpm test:ui`                                                    | PASS; Chrome headless, two tabs, temporary DB, fixture providers and external HTTP denied.                                                                   |
| Read-only migration preflight on `../gmgn-sniper/data/bot.sqlite` | PASS at time of inspection. Revalidate authoritative state before deployment.                                                                                |
| Additive migration rehearsal on disposable imported-data copy     | PASS: 256 positions, SHA-256 content equality across 8 protected tables, integrity_check=ok, no FK violations.                                               |
| Protected model/input/sizing/safety source diff                   | No changes to `kronos-domain.ts`, `kronos-strategy.ts`, `kronos-worker.ts`, `position-sizing.ts`, `market-history.ts`, `token-program.ts`, `exit-safety.ts`. |
| `git diff --check`                                                | PASS                                                                                                                                                         |

The automated suite denies production credential reads and external HTTP. LIVE receipt/submission cases use mocks; no real transaction is signed or broadcast. No real trading smoke test, real model/market replay or deployment was run.

Meaningful coverage includes 100 SOL funding once/restart, FX-independent native lamport balances/fees/PnL, partial/full SELL, insufficient cash/oversell, duplicate settlement, transactional rollback, failed quotes, unchanged fixed-SOL/percentage sizing, DEMO capability restrictions, mode/generation isolation, LIVE pending/UNKNOWN blockers, safe shutdown late-fill protection, crash ownership recovery and historical STANDARD migration blocks. Existing common safety, receipt accounting, pre-sign, blacklist, duplicate BUY, FIFO and deterministic KRONOS suites remain.

JEV/learning-specific and dual-strategy tests/UI harnesses were retired with their removed features. Shared receipt, accounting, provider, risk, sizing and recovery tests were ported to valid KRONOS authority and DEMO ledger fixtures; failures were not hidden or suppressed. New browser regression replaces the retired two-card/JEV/PAPER UI harness.

## Limits and operational status

- `.env` and databases were copied from gmgn-sniper as authorized, without displaying credentials or committing private state. The real bot was not stopped, restarted, paused or used for verification.
- Existing LIVE behavior uses the user-selected gmgn-sniper baseline. Simulated minimum-output fills, estimated costs and exact lamport settlement are explicitly labeled estimates and do not prove equality with actual live fills.
- The main dashboard requires explicit LIVE confirmation. Legacy controlled auto-start is blocked at startup so it cannot bypass the mode manager; the confirmed normal LIVE dashboard path is the supported main-engine entry point. Receipt/controlled-session accounting remains covered by regression tests.
- Historical schema/types and raw accounting labels remain for compatibility. JEV-specific source/provider/learning workers are removed; no active runtime path initializes or invokes JEV. A mixed-model snapshot is still rejected by Risk. Watch/Deferred presentation endpoints and retired profit-reference chips were removed; their historical state/configuration is preserved.
- The owner subsequently authorized deleting all local data without backup. Local quant-bot DB/history/cache files were reset under a maintenance lock and exclusive file access after verifying zero LIVE positions/pending transactions. Fresh state has one 100 SOL funding event and no positions, executions, logs or attempts. No backup was made. Original gmgn-sniper data remains unchanged.
- Task-created browser/DB fixtures and isolated build/helper scripts were removed. The requested local data wipe is recorded separately; credentials, source tests, model weights, original gmgn-sniper data, real backups and the pre-existing statistics build were preserved.

[Architecture and implementation](kronos-demo-live-migration-audit.md) · [File inventory](kronos-demo-live-files.md) · [Cleanup manifest](jev-memory-cleanup-manifest.md)
