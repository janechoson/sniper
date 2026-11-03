# FIRST VALID BUY WINS — ownership

> UI được sửa tiếp ngày 03/11/2026: [hai card đánh giá độc lập và đèn từng stage](dual-evaluation-ui-fix.md). Xem báo cáo UI để biết kiểm chứng mới và quan sát runtime cuối, thay vì suy trạng thái hiện tại từ checkpoint deployment bên dưới.

**02/11/2026 · IMPLEMENTED / VERIFIED / DEPLOYED.** Backend mới được nạp theo yêu cầu user lúc 23:41 Bangkok, PID14168; xem checkpoint deployment cuối báo cáo. STANDARD và KRONOS cùng đánh giá một candidate. Nhánh có BUY hợp lệ và claim SQL thành công trước sở hữu execution/Position. Không có ưu tiên cố định hoặc chờ đủ hai quyết định.

Source trước task thực tế chọn một strategy trong Cấu hình; không có nhánh ưu tiên `KRONOS BUY > STANDARD BUY`. Policy chọn một strategy nay được thay bằng `FIRST_BUY_WINS`. Các giá trị settings cũ STANDARD/KRONOS được normalize khi backend mới load; giao diện backend mới hiển thị policy chỉ đọc.

## Luồng và atomicity

```text
Discovery chung → Cheap / Security / Compatibility / History / Flow / Common Risk
                         ├─ STANDARD: Structure V3 / JEV / qualification Risk
                         └─ KRONOS: inference / qualification Risk
                                      ↓
                         BUY → atomic claim SQL
                                      ↓
                     first successful claim = owner
                                      ↓
             winner fresh final checks → sizing/intent → shared Executor
             → quote / exit probes / validation / simulation / pre-sign
             → sign / persist / submit / reconcile → Position
```

Common evidence được lấy một lần trước fork. Winner vẫn phải refetch final market/Security/holders/Compatibility và chạy final Risk; không bỏ freshness để giảm requests. Tests đếm một history request và hai lần info/Security: initial + winner final, không nhân đôi theo hai card. STANDARD có smart-money/JEV work riêng; inference/evaluation đã chạy có thể hoàn tất, nhưng loser không chạy final execution pipeline. Capital sufficiency ở qualification vẫn giữ nguyên; sizing tạo executable intent/reservation chỉ diễn ra sau claim.

`Store.claimMintForBuy()` chạy trong `BEGIN IMMEDIATE`, ghi `buy_ownership_claims` trước sizing/quote. UNIQUE `(mode,mint,attempt_id)` khóa cùng attempt; partial UNIQUE `(mode,mint) WHERE active=1` khóa mint đang có owner. BUY execution có unique claim-id index và Store guard, ngăn cả winner tạo execution thứ hai dưới cùng claim. Migration marker mới: 12; chỉ áp dụng trên fixture trong task này.

Intent, fill và Position mang `strategy`, `attemptId`, `ownershipClaimId`, decision ID/time. Store/Executor kiểm tra binding với claim; Position owner không lấy từ nhánh hoàn tất cuối và không được đổi sau đó.

## Failure, restart và SELL

- Final Security/Exit Feasibility/simulation failure không nhường quyền cho nhánh còn lại trong cùng attempt. Tombstone claim của attempt vẫn giữ kể cả unsigned failure đã an toàn kết thúc.
- Unsigned failure được resolve có thể cho một **fresh attempt mới** thử lại theo policy hiện hữu. CLOSED quantity=0 giải phóng active claim; owner lịch sử không đổi.
- CLAIMED/SUBMITTED/UNKNOWN/OPEN giữ owner qua restart. Signed hoặc unresolved execution tiếp tục tuân recovery/reconciliation hiện hữu; không fallback BUY hoặc resend.
- Crash sau early claim nhưng trước tạo intent giữ claim active. Không tự hết hạn hoặc chuyển owner; cần review/reconcile trước khi xử lý claim mồ côi. Claim này chặn mint đó, không tự freeze mọi mint khác.
- Strategic SELL vẫn theo Position owner: STANDARD/JEV hoặc KRONOS. Manual và deterministic critical Security/liquidity exceptions giữ nguyên; guard ở `strategy-authority.ts` không đổi.

Không thay model, forecast/decision policy, giá/PnL, Jupiter provider, signer/RPC, mint compatibility hoặc các validator. Bỏ predicate chọn một entry strategy trong Risk để cả hai nhánh được đánh giá; các checks Risk/Security/capital/ownership/freshness còn nguyên.

## UI, log và comparison

Hai card STANDARD/KRONOS hiển thị common evidence chung, stages riêng, Decision, Execution và owner. BUY của loser vẫn là BUY; execution là `BLOCKED_OWNER_ALREADY_CLAIMED`, reason `OWNED_BY_STANDARD` hoặc `OWNED_BY_KRONOS`. Decision reason và execution reason được lưu/hiển thị riêng.

Action logs có decision, claim SUCCESS/DENIED, POSITION_OWNER và EXECUTION_BLOCKED. Candidate attempt lưu `strategies.STANDARD`, `strategies.KRONOS` và ownership claim riêng; execution/Position có liên kết claim. Late updates gắn attempt ID, không ghi đè candidate mới. History backend/detail bổ sung comparison; GET `/api/attempt?id=…` trả attempt/claim. Retention candidate-attempt hiện hữu 2.000 rows vẫn áp dụng; không tuyên bố giữ mọi research trace vĩnh viễn.

Public UI tương thích backend cũ đang chạy; khi chưa nạp backend mới, capability chưa có thì vẫn render giao diện single-strategy cũ. Không trình diễn policy mới như thể đã hoạt động trong PID LIVE hiện tại.

## Kiểm chứng

| Check | Kết quả |
| --- | --- |
| `pnpm test` | **462 passed, 0 failed/cancelled/skipped**, 58.007,7811 ms |
| New ownership tests | **28**: hai winner orders, không chờ peer, simultaneous BUY, invalid-first BUY, failures/no handover, forged binding, restart và late result isolation |
| SQL race thực | Hai worker threads, hai Store connections, cùng SQLite fixture: đúng một claim thắng; không giả định strategy thắng |
| `pnpm typecheck` | PASS |
| `pnpm lint` | PASS |
| Isolated TypeScript build emit | PASS với `tsconfig.build.json`, output OS temp; không ghi đè LIVE `dist` |
| `scripts/first-buy-wins-ui.ts` | PASS: hai card, hai owner orders, late BUY blocked, readonly policy, History/attempt endpoints, 1440/1024/390, 0 browser errors |
| `scripts/kronos-integration-ui.ts` | PASS: updated policy, card, Position badges, History pagination/filter và statistics filter |

Tests dùng fake provider/executor hoặc SQLite fixture; counter sign/submit giả không phải transaction thật. Test preload chặn đọc credentials và external fetch. Node chạy verification 22.22.0; pnpm launcher Node20 engine warning không làm checks fail. Existing STANDARD/SELL/reconciliation tests giữ lại; kỳ vọng single-selection đã được cập nhật theo contract mới.

## Files

- Runtime: `src/config.ts`, `domain.ts`, `candidate-attempt.ts`, `one-shot-entry.ts`, `engine.ts`, `risk.ts`, `store.ts`, `executor.ts`, `server.ts`.
- UI: `public/index.html`, `app.js`, `style.css`.
- Verification/maintenance: `tests/first-buy-wins.test.ts`, `buy-claim-worker.ts`, `kronos-integration.test.ts`, `trending-final-gate.test.ts`; `scripts/first-buy-wins-ui.ts`, `kronos-integration-ui.ts`, `reset-strategy-data.ts`.
- Four existing benchmark tests chỉ ghi raw JSON khi `KEEP_TEST_ARTIFACTS=true`: capital-flow, manipulation-accounting, sniper-coordinator, trending-exit-feasibility. Default tests không tạo lại evidence rác.
- Báo cáo này và notice superseded trong `docs/kronos-main-integration.md`.

Hash đối chiếu `.env`, package/lock, execution-provider, Solana, token-program, strategy-authority, Kronos strategy/worker đều không đổi. Không reset/import data, không mở Store writable trên production DB.

## Trạng thái trước deployment và cleanup implementation

GET checkpoint **23:35 Bangkok**: main bot **PID4904**, build `979e86da37f77f50914d1f5b7e9e199655692fcfc55ad7980a3411b24c17fcc1`, LIVE, entries=true, backend cũ vẫn chọn STANDARD và chưa có FIRST_BUY_WINS capability. **Không restart/pause bot, không deploy backend hoặc chạy migration lên production.** Thay đổi này chỉ được áp dụng khi nạp bản backend mới ở tác vụ triển khai riêng.

**0 real BUY/SELL/sign/submit do task.** Bot LIVE có thể giao dịch độc lập theo quyền đã bật; không tuyên bố DB/wallet production bất biến qua thời gian verification.

Browser/build fixtures thành công được cleanup, không lưu screenshots/raw evidence mới trong project. Một directory của lần test race lỗi ban đầu còn tại `C:\Users\admin\AppData\Local\Temp\first-buy-wins-iwwLnt` (checkpoint cuối không có file con). Automatic approval review từ chối lệnh xóa directory đó với `blocked by policy`; không dùng phương thức khác để vượt chặn. Production logs/SQLite/credentials/runtime giữ nguyên.

## Deployment theo yêu cầu user — 02/11/2026, 23:41 Bangkok

Đã kiểm tra read-only: không có execution/Position pending hoặc manual CLAIMED/SUBMITTED; signer hợp lệ, RPC mainnet, cả 3 core OPEN holdings khớp chain và BUY receipt confirmed/finalized. Tạm khóa new entries bằng API hiện hữu, chờ candidate analysis kết thúc, recheck pending rồi dừng đúng PID4904. Không tác động legacy PAPER Lab PID3216/8792.

Typecheck/lint/build PASS. Build trước được giữ tại `data/backups/build-before-first-buy-wins-20261102T164107Z.zip`. Nạp build mới **`928993d3bb72e0247b0b33d804f3118e08b8f8dea9a05621dc195731ea2ba6a6`**, chạy Node22.22.0 `dist/live.js` bằng hidden process **PID14168**. Normal LIVE preflight/recovery thực thi; migration/schema ownership được load trên production khi startup. Không sửa `.env`, key, LIVE ACK hoặc clear halt bằng operator.

GET sau startup xác nhận **LIVE, entries=true, halt=null, scanner.running=true, settings.entryStrategy=FIRST_BUY_WINS, capabilities.firstBuyWins=true**. Port127.0.0.1:3000 thuộc PID14168; provider GMGN/RPC/execution READY tại checkpoint. JEV chưa có health sample mới lúc checkpoint, không giả nghiệm thu quyết định model/trade thật. Existing Position giữ owner STANDARD.

Service logs thật: `data/bot-first-buy-wins.stdout.log` và `data/bot-first-buy-wins.stderr.log`. Không gửi lệnh BUY/SELL hoặc trade kiểm chứng; từ lúc khôi phục LIVE/entries, Engine được phép tự giao dịch theo yêu cầu user. UI: **http://127.0.0.1:3000**; reload trang để nhận policy/hai card mới.
