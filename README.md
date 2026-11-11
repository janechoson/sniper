# Rug Killer — KRONOS only — DEMO / LIVE

One trading engine uses the existing common checks, KRONOS entry/exit decisions and shared sizing/risk settings. Execution runs in one backend-selected mode.

- **DEMO:** persistent 100 SOL virtual account, real read-only market/quote evidence, simulated settlement. No signing or broadcast capability is passed to the demo executor.
- **LIVE:** existing Solana wallet and Jupiter transaction validation, simulation, signing, confirmation and receipt reconciliation.

Use Node 22.13+ and pnpm 10.28.2. Install with `pnpm install --frozen-lockfile`. Configure credentials privately using `.env.example`; `.env` and `data/` are ignored by Git. Existing production `.env` values are preserved, but a legacy `TRADING_MODE=live` value does not authorize a new LIVE session.

## Run and select mode

`pnpm build` then `pnpm start` serves the local dashboard. The first backend selection defaults to DEMO. Use the visible DEMO/LIVE buttons; LIVE requires explicit confirmation plus the existing wallet, network and environment checks. Do not run another bot against the same wallet/database.

Selected mode persists in SQLite. A session's executor mode is immutable. Switching drains the current engine before starting another. LIVE positions, pending exits and unresolved transactions block switching or safe stopping; the bot never sells them merely to change modes. Restart with real positions resumes recovery monitoring with entries disabled. A stopped prior LIVE selection requires fresh confirmation before new LIVE trading.

Reset Demo is a separate confirmed action available with the DEMO engine stopped. It archives the previous virtual account and creates a new 100 SOL generation, retaining its ledger and historical positions. It never resets LIVE. Restarts, losses and mode switches do not fund the account again.

## Accounting and fills

DEMO balances, reserves, entry costs and PnL use exact integer SOL lamports (1 SOL = 1,000,000,000 lamports). Initial funding is exactly 100 SOL. The existing SOL sizing calculator reads native cash directly; it no longer needs a USD currency adapter. The calculator, reserve, percentage/fixed SOL amount, slippage and risk configuration are shared and unchanged.

DEMO requires a fresh route-only Jupiter quote, mint compatibility and decimals, market/liquidity evidence and existing exit-feasibility checks. It fills at the quote's minimum output. Estimated cost is the greater of the quote's cost estimate and the existing simulated-fee setting. Missing/stale/rejected evidence produces no successful fill. These are simulation assumptions; they do not predict actual on-chain fills.

Available cash, reserves, holdings, realized/unrealized PnL and equity are mode scoped. Unknown marks remain unavailable. SOL balance history records actual virtual ledger changes; periodic equity marks are estimates. LIVE history remains the existing authoritative observed account history, with gaps preserved.

## Verify without trading

- `pnpm test`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm build`
- `pnpm test:ui` — temporary DB, fixture providers, external HTTP denied; no real signing or trades.
- `pnpm verify:migration <database-path>` — read-only position/recovery preflight; rerun against the authoritative DB before deployment.

Do not run LIVE smoke/controlled execution commands as migration tests. They retain their explicit operational gates and are not part of automated verification.

[Source audit and implementation report](docs/kronos-demo-live-migration-audit.md) covers the baseline, call graph, migration and checks. [Local reset record](docs/jev-memory-cleanup-manifest.md) records the owner-authorized local data wipe without backup. The original gmgn-sniper data and running bot were preserved. Historical USD demo accounts are rejected rather than silently reinterpreted as SOL. Historical reports elsewhere describe earlier versions and are not current operating instructions.
