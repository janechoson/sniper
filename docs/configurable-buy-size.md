# Quy mô lệnh mua có thể chỉnh trong Cấu hình

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
