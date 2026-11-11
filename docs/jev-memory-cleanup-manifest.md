# Local data reset — completed by explicit owner request

2026-11-11. This supersedes the earlier pending cleanup manifest for the **local quant-bot copy**.

The owner explicitly requested: “không cần backup cho DB, xóa hết data đi để cho nó giống BOT mới tinh” and changed DEMO initial capital to **100 SOL**. No backup was created.

## Scope and result

Only `C:\Users\admin\Desktop\Tool\quant-bot\data` was reset:

- Old `bot.sqlite` and its WAL/SHM sidecars, if present.
- `gmgn-provider.sqlite` cache.
- `account-balance-history.json`.

A maintenance lock prevented local startup during the reset. The old copied DB had zero LIVE positions requiring monitoring and zero pending LIVE executions. Exclusive file access was obtained for every file before deletion; no running bot was paused or restarted.

Fresh `data/bot.sqlite` was initialized without an engine or provider:

- Selected mode: DEMO.
- Initial and available balance: **100 SOL = 100,000,000,000 lamports**.
- Funding events: one; realized PnL and reserves: zero.
- Positions, executions, logs, candidate attempts and pending exits: zero.
- SQLite integrity and foreign-key checks: passed.

The original `gmgn-sniper` process/database/history, `.env`, credentials, model weights and existing real backups were preserved. Historical compatibility schemas/migrations remain; their old data was not carried into the fresh local DB. This reset creates no transactions and does not alter the real wallet.

## SOL accounting

DEMO cash, reserves, costs and PnL now use exact integer lamports. The existing sizing calculator reads native SOL directly. SOL/USD only supplies optional reporting metadata and cannot change cash or settlement. Migration 16 labels currency explicitly; a pre-existing USD demo account fails closed instead of becoming SOL implicitly.

The dashboard Reset Demo button still requires a stopped DEMO session and confirmation, and archives its previous virtual account. That routine operation is separate from this one-time full local wipe.
