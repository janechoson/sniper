# Exit policy revision: no price/PnL stop loss

Owner requested this change on 2026-10-28. Negative return, price decline and MAE alone no longer trigger SELL. Execution construction/signing, simulation, submission, confirmation, reconciliation, Token-2022 compatibility, acquired-token isolation and controlled principal cap were not changed for this policy revision.

## Audit and changes

Repository search found the active loss threshold in `src/risk.ts`, the `stopLossBps` default in `src/config.ts`, the configured 1500 bps in `config/strategy.json`, and the active SL label/auto-generated settings input in `public/app.js`. These behaviors/settings were removed. Schema normalization discards legacy stop-loss keys from current strategy settings, retaining backward compatibility with the saved DB strategy; Engine persists the normalized current settings on startup. No immutable entry snapshots, old position records or historical outcomes are rewritten.

The old trailing condition activated after any positive peak. It now requires `trailingActivationBps`, default/configured **3000 (+30%)**, retaining the configured **2000 bps (20%)** peak retracement. Trailing also requires current value above remaining cost; a subsequent negative value cannot trigger trailing. Activation is based on the persisted high-water value/cost ratio, including proportional remaining cost after partial sells. Positive activation is explicit and configurable; there is no negative-PnL fallback.

Other stop-loss references are deliberately historical: `src/learning.ts` maps old exit reasons and analyzes old STOP_LOSS outcomes, deterministic historical fixtures preserve these cases, and the earlier controlled verification document records actual previous stop-loss trades. No new ExitEngine result emits Stop loss or STOP_LOSS. MFE/MAE sampling and after-exit observations remain unchanged, including deep-loss recovery and unrecovered losses. No historical production data was deleted or modified.

## Remaining exits

| Mechanism | Current behavior |
| --- | --- |
| Take profit | +30% sells 50%; +70% sells remaining balance. |
| Trailing profit | Peak at least +30%, 20% retracement, current remaining-position PnL positive. |
| Maximum holding | 1800 seconds (30 minutes); may exit at a loss because the cause is elapsed time. |
| Manual emergency sell | Existing 50%/full sell and operator position close remain. Pausing entries alone does not close positions. |
| Critical security | Explicit CRITICAL findings from current GMGN security; critical deterioration may exit independently of price. |
| Liquidity collapse | Existing GMGN liquidity drop greater than 50% versus initial liquidity; independent normalized liquidity input, never inferred from negative PnL/MAE. This existing scalar check is a liquidity-risk signal, not proof of malicious removal. |
| Smart-money SELL | Only if smartMoneyExitMode=EXIT; currently WARNING, so signals only warn. |
| Jev exit | Not implemented in this bot; Jev still decides entries. No new Jev SELL mechanism was invented. |

## Files and checks

Policy files: `src/config.ts`, `src/risk.ts`, `src/learning.ts` (historical compatibility retained). Config/UI: `config/strategy.json`, `public/app.js`, `public/index.html`. Tests: `tests/core.test.ts`, `tests/learning.test.ts`, `tests/execution.test.ts`, `scripts/ui-test.mjs`. Current provider/risk/memory documentation updated. The preceding Positions/History UI changes are also included in this build.

Deterministic checks cover −5%, −20%, −50%, extreme loss and trailing below activation (no SELL), valid trailing profit, take profit, maximum hold, manual and critical security/liquidity exits, legacy settings, MFE/MAE recovery versus unrecovered loss, and readable historical STOP_LOSS outcomes. Browser checks cover disabled stop-loss controls and explicit trailing activation, Positions/History filtering and PnL, navigation and CSRF.

## Deployment and live evidence

Before replacing the normal live process, entries were disabled and persisted state independently checked: **0 open positions and 0 pending transactions**. The old server was stopped. No signed/submitted transaction was changed or retried.

Per the latest task attachment, deployment uses `pnpm live:controlled` semantics: Solana only, exact existing 1% sizing, BUY principal at most **0.005 SOL**, **1 open position**, **1 completed trade**, then stop. Normal saved maximum remains 5. Existing owner ACK/wallet secrets are unchanged. The new policy applies to any new/open position managed by this build.

Required verification: **77 tests passed**, **typecheck passed**, **lint passed**, **build passed**, and isolated browser checks passed with zero browser errors. Historical STOP_LOSS fixtures remain readable without rewriting the immutable original records. The new excursion tests retain MAE −40% / MFE +120% on a recovered example and MAE −70% / MFE 0% on an unrecovered example; these are isolated test fixtures, not production evidence.

At approximately **13:45 Asia/Bangkok**, the compiled controlled runner started as PID **18008**, run ID **`f2d3d364-1d45-4570-99a8-b24388185614`**, following successful real wallet/mainnet, GMGN, typed Jev, Jupiter BUY/reverse quote and unsigned simulation preflight. Dashboard **http://127.0.0.1:3000** reports LIVE, entries enabled, scanner running, controlled state WAITING, maxPositions=1, positionSizePercent=1, trailingActivationBps=3000, trailingStopBps=2000, and no stopLossBps field. Saved normal strategy maxPositions remains 5.

At this startup checkpoint there was no new confirmed position or round trip to report. The runner remains active to select one candidate, manage it with the new policy, and stop after the fully reconciled close and memory outcome. A negative PnL alone cannot cause SELL. No extra BUY was forced to obtain a verification signature.

Logs: `data/no-stop-loss-20261028-134535.stdout.log` and `.stderr.log`; run events: `data/controlled-live-f2d3d364-1d45-4570-99a8-b24388185614.events.jsonl`. The runner writes its final `data/controlled-live-<run-id>.json` only after completion or an explicit blocked/incomplete result. No success or future BUY/SELL signatures are fabricated here. The run may take up to the configured holding-time exit after entry; local exits require the process to remain running.

### Confirmed entry checkpoint

The same run subsequently reached **OPEN** on **IMAGINE**, mint `HXRpzCQgnZdW2bgWrrEpZ3rpCK1m9ktF3P2e2PVfhE77`. BUY principal **2,735,447 lamports = 0.002735447 SOL**, below the hard cap; receipt slot **462380024**. Actual acquired **3,160,729,206 atomic = 3160.729206 tokens** (6 decimals). Actual wallet debit **4,325,575 lamports**, including fees/account costs; network fee **5,168 lamports**. BUY signature: [Lg5arS16HsBkyi1VRAfkA15Fi14KA48unUjC5xEJzZFPCVv6HuMy9sJ14hQnAqrbPBbiGhw34RYwijsLcihqH57](https://solscan.io/tx/Lg5arS16HsBkyi1VRAfkA15Fi14KA48unUjC5xEJzZFPCVv6HuMy9sJ14hQnAqrbPBbiGhw34RYwijsLcihqH57). State is confirmed/reconciled OPEN; new entries disabled automatically by the one-position session limit, with protective monitoring active and no halt reason.

At this checkpoint the sampled GMGN position value was 2,738,235 lamports versus full entry cash cost 4,325,575; the position remained OPEN despite negative net marked value, as required. This is an estimated valuation, not realized PnL or SELL proof. No SELL/closed outcome exists yet at this checkpoint. The autonomous process remains running; do not launch a second server or a second controlled command against this database.

Final configured-secret audit at deployment: **757 files inspected, zero findings**, no secret values printed.
