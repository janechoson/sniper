# Quy mô lệnh mua có thể chỉnh trong Cấu hình

## Bổ sung mode SOL cố định — 03/11/2026

**IMPLEMENTED / VERIFIED / DEPLOYED.** Backend mới đã được nạp theo yêu cầu user; xem checkpoint deployment bên dưới.

- Cấu hình có select **Chế độ quy mô lệnh mua**: `% tài khoản` (`PERCENT`) hoặc `SOL cố định` (`SOL`).
- Mặc định vẫn `PERCENT`, giữ tỷ lệ đã lưu. Input **Số SOL cố định mỗi lệnh mua** mặc định **0.2 SOL**, chỉ bật khi chọn mode SOL; input phần trăm chỉ bật khi chọn mode phần trăm. Hai giá trị được giữ khi chuyển mode.
- SOL cố định phải dương và biểu diễn chính xác tới lamport, tối đa 9 chữ số thập phân. Đủ vốn sau reserve/pending thì mua đúng số SOL đó; thiếu vốn thì chặn, không tự thu nhỏ lệnh.
- `src/position-sizing.ts` dùng chung cho Risk, status preview, controlled cap, SQL capital claim, Executor wallet re-read và final checks. API/settings schema lưu `positionSizeMode` và `positionSizeSol`; legacy settings thiếu hai key mặc định về PERCENT và 0.2.
- Intent lưu mode, phần trăm và số SOL. SQL claim kiểm tra binding; đổi mode hoặc giá trị đang sử dụng khi chưa ký bị chặn tại final/pre-sign bằng `POSITION_SIZE_SETTING_CHANGED`. Đổi giá trị của mode không hoạt động không thay quy mô lệnh.
- Áp dụng chung STANDARD/KRONOS. Security, compatibility, ownership, fee/pending reserves, FIRST_BUY_WINS, exit probes, simulation, transaction validation và SELL logic được giữ.
- UI chỉ cho phép chọn mode mới khi shell backend có capability `fixedSolPositionSize=true`, tránh gửi setting không được backend cũ hỗ trợ. Save success/failure vẫn dùng toast hiện có.

Kiểm chứng lần bổ sung: **538 tests passed, 0 failed/cancelled/skipped**; riêng sizing suite **27 passed**; typecheck và lint PASS. Build bằng build script với output cô lập `.build-fixed-sol-sizing`, không ghi đè LIVE `dist`. Browser fixture trên HTTP handlers thật xác nhận default0.2, lưu/reload, chuyển mode, precision9dec, API reject invalid SOL, toast và responsive1440/1024/390. Chỉ fake execution/RPC hoặc PAPER temp server; không giao dịch thật. Browser/DB fixtures tự cleanup, không lưu screenshot/raw evidence mới. **Build tạm còn tại `.build-fixed-sol-sizing`: automatic approval review từ chối lệnh xóa với `blocked by policy`; không đổi cách xóa để vượt chặn.**

Lượt implementation không pause/restart BOT hoặc sửa settings/DB production. Deployment sau đó được thực hiện riêng theo yêu cầu user.

### Deployment mode % / SOL và UI mới — 03/11/2026, 20:42 Bangkok

Đã backup build cũ tại `data/backups/build-before-fixed-sol-20261103T133717Z.zip`, tạm tắt new entries bằng API hiện hữu, đợi candidate attempt hoàn tất và recheck không execution/Position/manual pending dưới transaction guard trước khi dừng PID17500. Không xóa pending hoặc sửa receipts/quantities. Một lượt kiểm tra cây process bị lặp đã được dừng riêng và sửa trước khi dừng BOT; một lượt guard khác từ chối dừng khi còn RUNNING attempt, rồi lượt sau đợi được idle window. Không bỏ guard để ép deployment.

Typecheck/lint và production build PASS. Build mới: **`b0b34812264ee96da4b3fa19b80fddc96987fe1edb1808be3c2edc6c3009bd6b`**. Chạy pinned Node22.22.0 `dist/live.js` bằng hidden process **PID15224**, cổng **127.0.0.1:3000**. Normal LIVE startup thực hiện recovery/preflight hiện hữu, gồm kiểm tra receipts và chain balances của core OPEN Positions. Preflight trước deployment có4OPEN, không pending.

Checkpoint sau startup: **LIVE, entries=true, scanner.running=true, haltReason=null, haltScope=null, fixedSolPositionSize=true**. Giữ nguyên tỷ lệ operator đang chọn **20%**, mode **PERCENT**; input SOL có default **0.2**. Không tự chuyển sang SOL hoặc tự thay quy mô lệnh. `.env` hash trước/sau khớp; legacy Lab PID3216/8792 giữ nguyên.

Browser kiểm tra trực tiếp production `/settings`: select hiện và enabled, phần trăm20, fixed SOL0.2, đủ10controls được yêu cầu ẩn đã vắng khỏi UI; chuyển sang SOL trong DOM bật đúng input. **0 POST, 0 page errors, không lưu thay đổi test lên production.** Browser đã đóng, không lưu screenshot/evidence mới.

Service logs: `data/bot-fixed-sol-20261103T134144Z.stdout.log`, `data/bot-fixed-sol-20261103T134144Z.stderr.log`. Đây là operational logs. Không gửi lệnh BUY/SELL/sign/submit để kiểm chứng; Engine LIVE được phép tự giao dịch sau startup theo yêu cầu user. Không tuyên bố DB/wallet bất biến trong khi Engine chạy.

## Báo cáo triển khai phần trăm trước đây

**03/11/2026 · IMPLEMENTED / VERIFIED / DEPLOYED.** Tab Cấu hình cho phép sửa **Quy mô lệnh mua (%)** và bấm **Lưu tham số**. Phạm vi **0,01–100%**, bước **0,01%**; mặc định và giá trị production được giữ **1%**. Áp dụng chung cho BUY mới của STANDARD và KRONOS; không resize Position đã mở.

```text
spendable = max(wallet SOL − fee reserve − pending reservations, 0)
BUY lamports = floor(spendable × integer basis points / 10.000)
```

Ví dụ spendable 0,88 SOL, chọn 2,5% → BUY 0,022 SOL. Không tính tỷ lệ trên phần fee reserve hoặc vốn đã reserved; không làm tròn lên hoặc tự thu nhỏ lệnh để vượt gate. Lamports dùng BigInt, tỷ lệ có tối đa hai chữ số thập phân.

## Đồng bộ sizing và các guard

- Schema/API kiểm tra khoảng và độ chính xác; UI có min/max/step tương ứng. Status/BUY preview, Risk approval, SQL atomic capital claim, Executor wallet re-read và final validation dùng cùng công thức/tỷ lệ.
- Intent ghi `positionSizePercent`; immediate pre-sign callback từ chối `POSITION_SIZE_SETTING_CHANGED` khi operator đổi tỷ lệ trong lúc BUY chưa ký. Không sửa/resend một signed transaction vì thay settings; recovery/reconciliation hiện hữu tiếp tục áp dụng.
- Default vẫn 1%. Migration 5 cũ chỉ đổi legacy 10→1 **một lần** khi chưa có marker; không reset tỷ lệ operator chọn sau mỗi Store reopen. Không sửa `config/strategy.json` hoặc `.env` production.
- FIRST_BUY_WINS, owner binding, Security, compatibility, freshness, capital reserve, quote/exit probes, simulation, transaction validation và SELL authority giữ nguyên. Controlled session dùng tỷ lệ cấu hình nhưng vẫn giữ principal/session cap, không tự resize để lọt cap.
- UI chỉ mở input nếu backend báo `configurablePositionSize=true`; backend cũ vẫn hiển thị chỉ đọc kèm yêu cầu nạp bản mới, tránh giả vờ đã hỗ trợ thay tỷ lệ.

## Kiểm chứng

| Check | Kết quả |
| --- | --- |
| `pnpm test` | **470 passed, 0 failed/cancelled/skipped**, khoảng51,7s |
| 8 tests mới | Schema/default/invalid decimals; BigInt/reserve/pending/floor; STANDARD và KRONOS 2,5%; đổi tỷ lệ ở quote và immediate pre-sign; Security veto; 10% giữ qua reopen |
| `pnpm typecheck` / `pnpm lint` | PASS |
| `pnpm build` | PASS |
| `scripts/kronos-integration-ui.ts` | PASS: nhập/lưu2,5%, preview đúng, API từ chối100,01%, reload giữ2,5%; fixture PAPER/temp DB |
| `scripts/first-buy-wins-ui.ts` | PASS: hai card, branch/owner isolation, responsive1440/1024/390; isolated emit |
| Production browser GET-only | Input editable, min0,01/max100/current1;0page errors; không nhập/lưu hoặc POST lên production |

Fixtures dùng fake RPC/providers/execution; fake sign counters không là blockchain signature thật. Không giữ screenshots/raw evidence/test DB/build temp sau kiểm chứng.

## Nạp runtime

Trước reload đã kiểm tra signer/mainnet và 4 core OPEN holdings/BUY receipts khớp chain. Tạm tắt entry; candidate còn chờ GMGN ở HISTORY, nhưng không có pending executions/Position/manual requests hoặc active claim thuộc attempt RUNNING. Dừng đúng PID10680, không tác động Lab PID3216/8792.

Backup build cũ: `data/backups/build-before-configurable-size-20261102T234517Z.zip`. Build mới **`d8acf4b60bfc36fd646fcd48955742eddd5cfb7d8e3ca96df445421cf3afb545`**, Node22.22.0 `dist/live.js`, **PID11556**, chạy lúc06:45 Bangkok. Normal LIVE preflight/recovery thực thi; checkpoint cuối: **LIVE, entries=true, halt=null, scanner.running=true, FIRST_BUY_WINS, configurablePositionSize=true, positionSizePercent=1**. Preview lamports khớp tỷ lệ hiện tại. `.env`, key và tỷ lệ operator không bị đổi để kiểm chứng.

Logs service thật: `data/bot-sizing-20261102T234532Z.stdout.log` / `.stderr.log`. Task không gửi BUY/SELL kiểm chứng; Engine có thể tự giao dịch theo LIVE/entry authority hiện hữu.

Files: `src/config.ts`, `risk.ts`, `domain.ts`, `store.ts`, `executor.ts`, `engine.ts`, `one-shot-entry.ts`, `normal-live.ts`, `live-controlled.ts`; `public/app.js`, `index.html`; `tests/core.test.ts`, `configurable-buy-size.test.ts`; `scripts/kronos-integration-ui.ts`; báo cáo này.
