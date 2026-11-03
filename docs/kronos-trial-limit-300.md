# Kronos Lab — tăng cap PAPER trial từ 50 lên 300

Ngày 02/11/2026, Asia/Bangkok. **Hoàn tất source và build: `KRONOS.maxRecords = 300`.** Mục tiêu 200 ban đầu được thay bằng 300 theo yêu cầu mới nhất. Không khởi động BOT B hoặc Kronos, không bật LIVE, không gọi provider giao dịch thật.

## Phạm vi giới hạn

| Giới hạn | Trước | Sau | Consumer / ý nghĩa |
| --- | ---: | ---: | --- |
| Tổng trial records Kronos | 50 | **300** | `src/kronos-domain.ts: KRONOS.maxRecords`; `KronosStore.add()` kiểm tra tổng rows trong transaction; gồm ANALYZING, WAIT_BUY, OPEN, CLOSED, REJECTED, ERROR và pending PAPER sell |
| Lab intake từ một kết quả `LabMarket.discover()` | 50 | 300 | `KronosLab.discover()` dùng cùng `KRONOS.maxRecords` để slice input; adapter thực tế vẫn giới hạn mỗi batch như dòng dưới |
| Batch đọc từ BOT cache / GMGN fallback listing | 50 | **50, giữ nguyên** | `KronosMarket.discover()`: cache slice 50, fallback query `limit: 50`, kết quả slice 50 |
| Concurrent model inference qua scheduler | 1 | **1, giữ nguyên** | `KronosLab.tick()` có active guard, chỉ chọn một trial mỗi tick |
| OPEN PAPER positions riêng | Không có cap độc lập | Giữ nguyên | OPEN tính vào tổng trial; không thêm hoặc đổi Position-count policy |
| Discovery interval / GMGN start spacing | 120s / 3s | Giữ nguyên | Không sửa `kronos-market.ts`, production scanner hoặc global GMGN coordinator |
| Decision storage / detail view | 720/trial / latest 50 | Giữ nguyên | Không nhầm LIMIT 50 của lịch sử decisions với cap trial |

Cap 300 là tổng lifecycle retained, **không phải 300 OPEN đồng thời hoặc 300 listing/request**. Record 51–300 được bổ sung khi các batch trả appearance mới. Nếu listing tiếp tục chỉ trả lại cùng 50 appearance, hệ thống vẫn deduplicate; tăng trial cap không bảo đảm tự xuất hiện 250 token mới. Khi đủ 300, `tick()` ngừng discovery mới và `Store.add()` từ chối record bổ sung; không tự reset, xoay vòng, xóa CLOSED/REJECTED hoặc ghi đè row cũ. Monitoring các trial đang cần xử lý vẫn chạy khi collection được enable.

## Bảo toàn dữ liệu thật

Đọc SQLite hiện hữu tại `%LOCALAPPDATA%/gmgn-kronos-runtime/paper-lab.sqlite` bằng native SQLite `readOnly:true`, `query_only=ON`, read transaction. Không mở writable `KronosStore` trên DB này.

| Dataset | Trước | Sau | Digest toàn bộ rows |
| --- | ---: | ---: | --- |
| lab_trials | 50 | 50 | Khớp |
| lab_decisions | 82 | 82 | Khớp |
| lab_events | 192 | 192 | Khớp |
| lab_meta | 52 | 52 | Khớp |

**50 records cũ được giữ nguyên: 2 CLOSED, 48 REJECTED, 0 OPEN.** Payload, timestamps, giá BUY/SELL, PnL và lịch sử decisions không bị viết lại. Không chèn trial fixture vào DB thật. Kiểm chứng OPEN ở đầy cap dùng fixture riêng vì DB thật hiện không có OPEN.

Evidence: [DB trước](../data/kronos-trial-limit-300-db-before.json), [đối chiếu sau](../data/kronos-trial-limit-300-after.json).

## Thay đổi và phần giữ nguyên

Application:

- `src/kronos-domain.ts`: đổi đúng `maxRecords: 50` thành `300`.
- `src/kronos-lab.ts`: dòng mô tả giới hạn đọc từ `KRONOS.maxRecords`; không thay discovery/step/tick hay inference policy.
- `public/kronos.js`: bộ đếm Records dùng `summary.limit` từ backend, bỏ `/ 50` ghi cứng.
- `public/index.html`, `public/kronos-standalone.html`: mô tả tham chiếu bộ đếm Records, tránh ghi cứng giới hạn cũ.

Verification:

- `tests/kronos-lab.test.ts`: cập nhật cap/concurrency fixtures lên 300; thêm kiểm chứng mở rộng từ 50, chạy pipeline record 51–300, preservation, reopen, deduplication và monitoring ở đầy cap.
- `scripts/kronos-ui-test.mjs`: fixture limit 300 và assertion UI hiển thị `1 / 300`.
- Báo cáo này, JSON/log evidence và ảnh UI do verification tạo; `dist/` được rebuild.

Fingerprint 138 files source/public/config/scripts/tests và `.env`/package/lock: đúng **7 files implementation/test** ở trên thay đổi. [Baseline](../data/kronos-trial-limit-300-before.json), [comparison](../data/kronos-trial-limit-300-after.json). Production Engine, Candidate pipeline, discovery/coordinator, Jev, Risk, Structure, Controlled Markup Guard, Position/SELL, Jupiter/Executor, cấu hình, `.env` và package/lock giữ nguyên.

Không đổi model/inference, BUY/SELL prediction, WAIT/HOLD, Security, Cheap Filter, mint compatibility, historical candles, Capital Flow sufficiency, observable PAPER prices, PnL hoặc lifecycle. Không đưa Jev, Structure Evidence V3 hoặc Controlled Markup Guard vào Kronos. Không tách Kronos thành bot mới; giữ architecture/proxy/service hiện hữu.

## Tests

| Yêu cầu | Kết quả |
| --- | --- |
| Nhận tối đa 300, không dừng ở 50 | PASS: thêm từ 50 đến 300, record 301 bị từ chối |
| Record 51–300 qua pipeline hiện hữu | PASS: từng record qua CHEAP_FILTER, SECURITY, COMPATIBILITY, HISTORY, CAPITAL_FLOW, fake inference và observable PAPER BUY; 250 records OPEN trong fixture |
| Không duplicate appearance / active mint | PASS: lặp discovery không tăng count; cùng appearance bị chặn kể cả sau CLOSED; lifecycle mới chỉ được phép theo policy cũ |
| Giữ 50 records đầu | PASS: raw SQLite rows khớp sau admission và xử lý records mới; fixture file reopen giữ nguyên 50 rows và decisions |
| OPEN tiếp tục monitor khi đủ cap | PASS: tick ở 300 cập nhật current price/PnL của OPEN, giữ entry và không gọi discovery |
| Không nâng inference concurrency | PASS: 300 queued jobs và concurrent tick attempts vẫn chỉ một model call active |
| Không gọi production capabilities | PASS: tripwire mocks trên Engine analyze/processExits, Executor, Jupiter execute, wallet sign và sendTransaction đều có call count 0 |
| Đầy cap không reset/evict | PASS: overflow không thêm row, không sửa 50 row đầu; tổng giữ 300 qua reopen |
| Listing/batch riêng không đổi | Existing regression PASS: reuse cache, fallback query limit 50, output tối đa 50 |

Full suite bao gồm production regressions: **`pnpm test`: 405 passed, 0 failed, 0 skipped**, khoảng 48,95s. [Log](../data/kronos-trial-limit-300-full-tests.log).

- `pnpm typecheck`: PASS, exit 0. [Log](../data/kronos-trial-limit-300-typecheck.log).
- `pnpm lint`: PASS, exit 0. [Log](../data/kronos-trial-limit-300-lint.log).
- `pnpm build`: PASS, exit 0. [Log](../data/kronos-trial-limit-300-build.log).
- Kronos browser regression: PASS, provider/API calls đều intercepted, không dùng DB thật. [Log](../data/kronos-trial-limit-300-ui.log).

Pnpm launcher báo engine Node20; commands sử dụng PATH ưu tiên pinned Node22.22.0. SQLite experimental warning không phải failure. Lần test Kronos đầu có một assertion concurrency fixture còn kỳ vọng cap 50; fixture đã cập nhật 300 và toàn suite cuối PASS. Không sửa production code để bỏ assertion này.

## Trạng thái áp dụng

Build ID: `846215dd68ee9dafef5baeb480aeaf83051a6764152db6c5f95904fcc99fa0cd`.

Checkpoint cuối **11:21:57 ngày 02/11/2026 Bangkok**: GET BOT B cổng 3000 và Kronos cổng 8792 đều không kết nối được; process inspection trước đó không có `node.exe`. Không có running service được hot-reload/restart trong task. Source/build đã sẵn cap 300 cho lần khởi động tiếp theo; **không tuyên bố dịch vụ đang chạy với cap mới**.

**Không có real BUY/SELL, wallet signing hoặc transaction submission do task này.** Tests dùng SQLite RAM/temp, fake providers/model/receipts và network guard. Không launch model/provider thật, không thay tài sản blockchain.
