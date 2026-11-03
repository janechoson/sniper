# BOT B — CLEAN DATA RESET REPORT

**Ngày:** 30/10/2026 — Asia/Bangkok. **Kết quả: COMPLETE.** Dataset active đã sạch; History có thứ tự rõ ràng tại backend. **Không bật LIVE. Ví vẫn còn 9 mint; reset không thay đổi tài sản trên blockchain.**

Policy giữ nguyên `TRENDING_FINAL_STRUCTURE_V1`. Build kiểm chứng: `36dea798eb8b36153be18015b73e2d136f3b6076bd2aa7f682ce8d7c08ac1a0a`.

## 1. Backup

Đã tạo backup mới trước mutation, hoàn tất **08:31:41 ngày 30/10/2026** Bangkok (`2026-10-30T01:31:41.481Z`).

**Đường dẫn:** `data/backups/clean-trending-reset-20261030T013128Z/`.

| File | Gốc, bytes | Backup, bytes |
| --- | ---: | ---: |
| bot.sqlite | 337.539.072 | 337.539.072 |
| bot.sqlite-wal | 4.181.832 | 4.181.832 |
| bot.sqlite-shm | 32.768 | 32.768 |
| bot.sqlite.lock | 5 | 5 |
| gmgn-provider.sqlite | 8.192 | 8.192 |

Hash từng file khớp khi copy. Native SQLite mở backup read-only thành công, `integrity_check=ok`, foreign-key violations=0; đọc được 224 Position cũ. Giữ DB/WAL/SHM cạnh nhau trong backup. Lock trong backup chỉ là bản lưu, không phải tiến trình đang chạy. Không copy/in giá trị `.env`; file đó được giữ nguyên và fingerprint.

Evidence: [manifest backup](../data/clean-reset-backup.json), [thư mục backup](../data/backups/clean-trending-reset-20261030T013128Z/manifest.json).

## 2. Pre-reset transaction safety

Không có normal bot process hoặc listener cổng 3000 trước reset. Không có Engine đang submit/reconcile. DB có 890 executions: **94 CONFIRMED, 796 FAILED**, không có execution nonterminal; Position không PENDING_ENTRY/PENDING_EXIT; 2 manual requests đều CANCELLED.

Maintenance giữ process lock của installation và recheck dưới `BEGIN IMMEDIATE` trước khi xóa. UNKNOWN, SIGNED_UNKNOWN, SUBMITTED, PENDING_CONFIRMATION, AMBIGUOUS, RECONCILING, CREATED hoặc Position pending đều làm abort. Manual SUBMITTED bị chặn riêng để không bỏ mất trách nhiệm khi execution row bị thiếu. Không gửi lại signature, không recover bằng giao dịch mới.

Evidence: [preflight/schema/FK/settings keys](../data/clean-reset-preflight.json), [procedure](../scripts/reset-strategy-data.ts).

## 3. Pre-reset wallet holdings

Chỉ gọi RPC read-only `getBalance` và `getTokenAccountsByOwner` cho Legacy SPL/Token-2022, commitment finalized. Không gọi signer, Jupiter hoặc GMGN để giao dịch.

Ví public: `DzFFTWXyt82LRexdhZMNEjxLFiyTF7NHrn9fDQQ56fPd`.

Ngay trước mutation lúc **08:39:12**, SOL **154.737.875 lamports = 0,154737875 SOL**; **9 mint có số dư dương**. Tất cả tương ứng các core OPEN Position cũ có overlay MANUALLY_REMOVED. Một mint còn có thêm record FAILED lịch sử; không coi FAILED quantity=0 là số dư ví.

| Mint | Atomic units | Association cũ |
| --- | ---: | --- |
| `7wjapUkhKcwx8ZEbSkvePusbh4UwKmhiUszwaR5Lpump` | 22153979604 | OPEN + MANUALLY_REMOVED |
| `8co2Me7XQFsmSWjj5TbM82ivH1ygBjES1FTfVzCbpump` | 16092696471 | OPEN + MANUALLY_REMOVED |
| `8oxrc5tfgYY6yS4hRQfAkTp7QxbyLTezKqzak4qepump` | 2367401294 | OPEN + MANUALLY_REMOVED |
| `BT5AdudjvSWfHLxU3k238HheFzN9yfy1nPYdFn4gFPn9` | 4233816579 | OPEN + MANUALLY_REMOVED |
| `Ge88LedK6Yk337UuPJaG1sgVUrR8q2Ykqcb7u5sVpump` | 2267435022 | OPEN + MANUALLY_REMOVED |
| `GEnDbVEMSDbmTGmjtBddSEEqT4xbw18nuWKHjMw8bonk` | 1966904152 | OPEN + MANUALLY_REMOVED |
| `GQJsb9tiZoiGVwHVFn9FfhE74kSk2RAB4sREMXbvpump` | 11982415380 | OPEN + MANUALLY_REMOVED |
| `HQPVvw9uFpeuifbUxHycwU5Mktezu7wgQBd5ZbuBW23D` | 1971720823 | OPEN + MANUALLY_REMOVED |
| `HXRpzCQgnZdW2bgWrrEpZ3rpCK1m9ktF3P2e2PVfhE77` | 3160729206 | OPEN + MANUALLY_REMOVED |

Các liên kết Position trong wallet evidence là **association với dữ liệu trước reset/backup**, không phải Position được tái tạo trong active DB. [Before](../data/clean-reset-wallet-before.json).

## 4. Tables/data inspected

Đã dùng sqlite_master và `PRAGMA foreign_key_list` để map schema thật, không xóa theo tên khái niệm phỏng đoán.

| Nhóm | Tables thật | Loại / dependency |
| --- | --- | --- |
| Discovery/candidate/Watch | tokens, discovery_events, candidate_lifecycle, sniper_structure_watch, entry_structure_watch | Runtime strategy; không FK |
| Position/Flow/Runner | positions, candidate_flow_states, capital_flow_states, position_runner_memory | Trade/runtime history; không FK |
| Execution/exit | intents, executions, execution_fills, orders, manual_exits, jev_exit_decisions | Trade/reconciliation history; chỉ xóa sau pending guard |
| Immutable learning children | trade_observations, trade_exit_snapshots, trade_execution_evidence, trade_execution_preflights | FK sample_id → trade_learning_samples.id |
| Learning/outcome | trade_learning_samples, trade_execution_failures, trade_outcomes, learning_patterns, learning_versions | Outcome FK → samples; failures không FK; derived/evidence dataset |
| Telemetry | records | Analytical snapshots, runtime/events, execution diagnostics |
| Configuration/schema | settings, migrations | Giữ config/version/safety; settings runtime được phân loại riêng |

`entry_structure_watch` là bảng mà Store của architecture đã triển khai yêu cầu; production DB cũ chưa có, nên constructor hiện tại tạo bảng rỗng đó. Không đổi thuật toán/policy hoặc rollback schema. Migrations 1–10 giữ nguyên version và timestamp.

## 5. Data deleted

Đã clear **25 dataset tables**, gồm toàn bộ records, discovery, Watch, Position/dismissal, executions/intents/fills, Flow, Runner, immutable learning và derived outcomes. `orders` legacy giữ schema, count vẫn 0.

Deletion order được tính child-first từ FK thật; danh sách chính xác nằm trong [reset result](../data/clean-reset-result.json). Riêng immutable learning DELETE triggers được tháo **bên trong cùng transaction bảo trì**, rồi tạo lại bằng SQL gốc trước commit. UPDATE triggers không bị tắt. So sánh sqlite_master trước/sau yêu cầu giống hệt; lỗi giữa chừng rollback cả rows lẫn trigger DDL. Không thay normal application immutability guards.

Xóa settings runtime `faultMetrics`, `paperCash`, `paperBalanceSource`, `manualExitRequests` và các prefix `candidateAuthority:`, `learningPostAttempt:`, `discoveryTrendingStreak:` nếu tồn tại. Xóa paperCash là reset danh mục mô phỏng, không thay SOL/token balance thật.

Sau commit chạy checkpoint/VACUUM/checkpoint; DB còn **286.720 bytes**. Không chỉ ẩn rows ở frontend hoặc đổi quantity thành 0. Position rows cũ được xóa khỏi active dataset và giữ trong backup.

## 6. Data intentionally preserved

- `.env`, config/strategy.json, config/learning.json, wallet/key references, package/lock và provider credentials giữ nguyên; không tạo lại wallet keys.
- `strategy` / `strategyV2`, các migration/policy markers, halt metadata và entry control giữ nguyên. `newEntriesEnabled=false` tiếp tục được đảm bảo.
- `controlledLiveRunV1` giữ nguyên vì là chốt tài chính của controlled one-shot run; status lịch sử `POSITION_OPEN_FAILURE` không được xóa để vô tình re-arm chương trình đó. Nó không phải sample của Trading/Runner Memory và không được normal Jev retrieval đọc. Không có execution pending tương ứng trong active preflight.
- `gmgn-provider.sqlite` giữ nguyên byte/hash và cooldown authoritative; bảng cooldown hiện 0 rows. Không clear deadline để né rate limit.
- Schema, indexes, immutable triggers, migrations và backup cũ giữ nguyên. Tài liệu/log/evidence offline không phải nguồn dataset mà normal Engine dùng, không bị xóa hàng loạt.

Thêm marker nhẹ `settings.strategyDataReset={at,reason:TRENDING_ONLY_CLEAN_START,backupPath}`. Không tạo subsystem reset mới trong Engine hoặc HTTP mutation endpoint.

## 7. Post-reset table counts

| Table | Before | After |
| --- | ---: | ---: |
| candidate_flow_states | 49 | 0 |
| candidate_lifecycle | 546 | 0 |
| capital_flow_states | 9 | 0 |
| discovery_events | 23469 | 0 |
| entry_structure_watch | 0 | 0 |
| execution_fills | 30 | 0 |
| executions | 890 | 0 |
| intents | 890 | 0 |
| jev_exit_decisions | 942 | 0 |
| learning_patterns | 14 | 0 |
| learning_versions | 2 | 0 |
| manual_exits | 2 | 0 |
| orders | 0 | 0 |
| position_runner_memory | 21 | 0 |
| positions | 224 | 0 |
| records | 123400 | 0 |
| sniper_structure_watch | 58 | 0 |
| tokens | 23112 | 0 |
| trade_execution_evidence | 94 | 0 |
| trade_execution_failures | 796 | 0 |
| trade_execution_preflights | 104 | 0 |
| trade_exit_snapshots | 666 | 0 |
| trade_learning_samples | 77 | 0 |
| trade_observations | 2292 | 0 |
| trade_outcomes | 42 | 0 |

Ngoài các bảng dataset ở trên: **settings=11**, **migrations=10**. Settings gồm 10 config/policy/safety keys có từ trước và 1 reset marker; không có candidate tombstone. Cả 10 payload settings còn lại được đối chiếu giống backup, gồm entries=false. 10 migration rows giữ nguyên. [Counts/integrity](../data/clean-reset-result.json).

`PRAGMA integrity_check=ok`, foreign-key violations=0. Không có active/closed/dismissed Position hoặc confirmed/pending execution trong dataset mới.

## 8. Trading Memory status

Đã mở **active DB read-only**, gọi implementation thật của `TradingMemory.retrieve()`, `TradingMemory.report()` và `RunnerMemory.similar()` ở cả mode LIVE và PAPER: **similarTrades=0, completedTrades=0, runnerSimilarTrades=0**. Không chỉ dựa vào UI count. Outcomes, learning samples, observations và patterns đều 0; dữ liệu Sniper cũ không thể đóng góp vào retrieval mới.

Probe dùng facts tổng hợp trong RAM, không lưu trade hoặc fake LOSS. [Verification thực tế](../data/clean-reset-verification.json).

## 9. Structure Watch status

sniper_structure_watch=0, entry_structure_watch=0, ACTIVE=0, EXPIRED=0, manual tombstones=0, candidate_lifecycle=0. Đường list/reopen thật trả rỗng. Policy Trending-only và fixed 10-minute Watch không sửa.

## 10. Position status

Active DB: **Position tổng=0; active=0; CLOSED=0; dismissed=0**. History mặc định rỗng. Không tự restore 9 token đang ở ví thành các trade Trending mới. Guard ownership RPC hiện hữu vẫn bắt buộc cho entry sau này; không tạo mới blocklist hay fake-close Position.

## 11. Wallet comparison

Before **08:39:12** / after **08:40:14**:

| Mục | Before | After |
| --- | ---: | ---: |
| SOL lamports | 154.737.875 | 154.737.875 |
| Nonzero mints | 9 | 9 |
| Từng mint / atomic balance | Khớp | Khớp toàn bộ |

**0 signatures, 0 submissions, 0 swaps, 0 transfers, 0 burns, 0 closed token accounts.** Reset không sửa blockchain state hoặc giả wallet balance=0. [After](../data/clean-reset-wallet-after.json), [comparison](../data/clean-reset-wallet-comparison.json).

## 12. History sorting implementation

Đường mới: **DB → Store.history() → GET /api/history → refreshTables() → renderHistory()**.

SQL có thứ tự rõ ràng:

```sql
WHERE mode = ? AND state = ?
  AND CAST(json_extract(payload, '$.originalQuantity') AS INTEGER) > 0
ORDER BY CAST(json_extract(payload, '$.entryAt') AS INTEGER) DESC, id DESC
LIMIT ? OFFSET ?
```

Frontend dùng thứ tự API trả về; đã bỏ `.filter(...).reverse()` dựa vào order của /api/positions. Không đổi thứ tự `Store.positions()` hoặc monitoring/SELL loops. Hai view dùng mục đích riêng: Position giữ attention priority; History dùng opening time.

## 13. Authoritative History timestamp

**Position.entryAt**, thời điểm mở Position theo model hiện tại; secondary key **id DESC**. Không dùng lastQuoteAt, mark/Flow/Jev time, sellSignature, close time hoặc last render. Partial/full SELL không biến Position cũ thành Position mới.

## 14. Pagination/filter behavior và cache

Giữ semantics UI hiện hữu: **History mặc định chỉ CLOSED với originalQuantity>0**. OPEN vẫn ở tab Vị thế; lần đầu một Position mới CLOSED mới có một dòng History. Đóng một Position mở trước không đẩy nó lên trên Position mở sau. Không tự mở rộng History thành danh sách mọi OPEN/FAILED.

API hỗ trợ state và optional limit/offset; WHERE/filter và ORDER BY chạy trước LIMIT/OFFSET. UI hiện chưa có controls phân trang, mặc định lấy toàn bộ History hợp lệ; không lấy arbitrary page rồi sort client.

Response `Cache-Control: no-store`; refresh lấy History độc lập từ DB. Browser đã kiểm tra empty state, first/second/third CLOSED fixtures, tie-break, filter OPEN, page offset, update giá, partial/full close và reload. Không fake-delete client để che DB cũ. Các fixtures sau reset chỉ được chèn vào **bản sao temp**, không active DB.

## 15. Tests và restart/browser

- **pnpm test: 240 passed, 0 failed, 0 cancelled, 0 skipped**, 99.727,7705ms; [log](../data/clean-reset-tests.log).
- 11 tests mới: seven nonterminal execution states → abort, pending Position/orphan manual, backup-required, schema/config/Memory/Watch preservation, rollback, history ordering/filter/page/update/exit.
- [Browser riêng](../data/clean-reset-history-ui.json): actual HTTP handlers trên bản sao DB sạch; schema/DB/History/Memory/Watch load thành công, không restore Position/candidate cũ, empty state đúng. A → B,A → C,B,A; tie C,B-tie,B,A; 0 browser errors; 0 blockchain action. [Ảnh](../data/clean-reset-history-ui.png).
- Full UI regression: [log](../data/clean-reset-ui-regression.log). Đã cập nhật fixture intercept cho endpoint History riêng, không thêm sort vào app frontend.

Không chạy LIVE/smoke. Server kiểm chứng là PAPER, entries=false, scanner=false, wallet public rỗng; dùng temp DB và dừng workers. Active DB chỉ được load read-only trong verification sau reset để giữ counts thật rỗng.

## 16. Typecheck

`pnpm typecheck`: **PASS, exit 0**. [Log](../data/clean-reset-typecheck.log).

## 17. Lint

`pnpm lint`: **PASS, exit 0**. [Log](../data/clean-reset-lint.log).

## 18. Build

`pnpm build`: **PASS, exit 0**. [Log](../data/clean-reset-build.log). Pnpm launcher Node20 warning và SQLite experimental warning không phải failures; test/build dùng pinned Node22.22.0. [Quality metadata](../data/clean-reset-quality.json).

Secret audit: **1.243 files, 0 findings**, không in configured secrets. [Log](../data/clean-reset-secrets.log).

## 19. Files changed

- Application: src/store.ts (history query), src/server.ts (read-only endpoint), public/app.js (preserve History API order).
- Maintenance/test: scripts/reset-strategy-data.ts, tests/clean-reset-history.test.ts, scripts/clean-reset-history-ui.mjs; fixture updates scripts/ui-test.mjs và scripts/position-ui-cases.mjs.
- Operator runners/evidence: data/clean-reset-apply.ts, clean-reset-wallet.mjs, clean-reset-verify.ts và các JSON/log/backup liên kết ở báo cáo này. Không import các runner vào Engine.
- Báo cáo này.

**43 protected files không đổi**, gồm Engine, discovery, Structure algorithm, Risk, Jev prompts, Security/GMGN, Capital Flow, Memory/Runner, Jupiter/executor/simulation/reconciliation, `.env`, configs và package/lock. Payload config/safety/migrations đối chiếu backup giữ nguyên. Chỉ data reset và History ordering được thay đổi; F01/F02 không thuộc maintenance này. [Preservation/retrieval evidence](../data/clean-reset-verification.json).

## 20. Final status

**Active strategy database sạch. Dữ liệu cũ còn trong backup offline. Ví vẫn giữ nguyên SOL và 9 token holdings.** Không bật LIVE; entries=false. Các server kiểm chứng được đóng sau khi chạy; checkpoint cuối: [runtime](../data/clean-reset-runtime-final.json).

## Required direct answers

| Question | Answer |
| --- | --- |
| Was a backup created before deletion? | **YES** |
| Were there unresolved signed/submitted transactions before reset? | **NO** |
| If YES, was destructive reset aborted? | **N/A**; abort guard có tests riêng |
| Was any blockchain transaction created by the reset? | **NO** |
| Was any token sold? | **NO** |
| Was any token transferred? | **NO** |
| Was any token account closed? | **NO** |
| Were wallet balances artificially changed in DB? | **NO**; deleted strategy rows, không tạo wallet-zero record |
| Are old Candidates removed? | **YES** |
| Are old Structure Watches removed? | **YES** |
| Are old Positions removed from active DB? | **YES** |
| Are old executions/fills removed? | **YES** |
| Is old Trading Memory removed? | **YES** |
| Is old Runner Memory removed? | **YES** |
| Is old Sniper strategy data absent from active strategy dataset? | **YES**; one-shot safety metadata được giữ riêng, không là learning/history dataset |
| Is historical data preserved in the backup? | **YES** |
| Is DB schema/migration state preserved? | **YES**; materialize bảng empty của current Store, giữ nguyên migrations |
| Does History show newest Position first? | **YES**, trong filter CLOSED hiện hữu, theo opening time |
| Is ordering explicit and deterministic? | **YES** |
| Does Position monitoring update reorder an old Position? | **NO** |
| Does partial SELL reorder an old Position? | **NO** |
| Is sorting applied before pagination? | **YES** |
| Was trading logic changed? | **NO** |
| Was LIVE automatically enabled? | **NO** |
