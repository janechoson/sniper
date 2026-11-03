# Tiếp tục Capital Flow + Jev — bàn giao công việc đang dở

> **Cập nhật 29/10/2026:** Chủ dự án đã yêu cầu tiếp tục ngay trong chat. Đã hoàn tất source, 142 tests/typecheck/lint/build/UI và khởi động normal LIVE PID 9104. Không tiếp tục theo checklist cũ như thể chưa triển khai. Xem `docs/capital-flow-adaptive-manager.md` và `docs/live-route-investigation-2026-10-29.md`; đọc runtime mới trước mọi tác vụ tiếp theo. Phần điều tra route được chủ dự án giới hạn chỉ đọc, không sửa code.

## Yêu cầu thời gian của chủ dự án

- Tiếp tục lúc **02:00 ngày 29/10/2026, Asia/Bangkok (UTC+7)**, tương ứng **19:00 UTC ngày 28/10/2026**.
- Hoàn tất triển khai, kiểm chứng rồi đưa lên normal LIVE bằng quyền và ACK hiện có.
- **Chưa tạo được lịch tự chạy trong phiên IDE này.** Tệp này là bàn giao, không phải một automation đã kích hoạt. Không tiếp tục sửa code hoặc triển khai trước giờ yêu cầu.

## Nội dung để tạo scheduled task một lần, tiếp tục trong chat hiện tại

> Lúc 02:00 ngày 29/10/2026, múi giờ Asia/Bangkok, tiếp tục công việc Capital Flow Intelligence + Jev Adaptive Position Manager đang dở tại C:\Users\admin\Desktop\Tool\gmgn-sniper. Đọc docs/capital-flow-resume-handoff.md và yêu cầu gốc ở C:\Users\admin\.codex\attachments\dada477e-6bc6-449e-8fec-63d3537f2682\Pasted text.txt. Hoàn tất implementation, regression tests, đo hiệu năng, kiểm tra UI và báo cáo. Sau khi kiểm chứng đạt, kiểm tra ví/vị thế/pending và safely resume normal LIVE theo ACK hiện có. Không ép BUY/SELL làm bằng chứng, không reset database/quantity/accounting, không sửa bí mật/ACK và không vượt một lệnh bị policy chặn. Báo trạng thái thật nếu triển khai không thực hiện được.

## Trạng thái đã đạt trước khi tạm dừng

Đã tích hợp bước đầu trên source hiện tại:

- `src/capital-flow.ts`: observation chuẩn hóa từ GMGN; rolling history hữu hạn; net directional DEX volume, trend/acceleration, regime, confidence, hysteresis và lookbacks.
- `src/runner-memory.ts`: milestone chỉ khi quan sát, review 1/5/15 phút, partial exposure, runner examples từ actual traded sample/outcome.
- Migration bổ sung 8: `capital_flow_states`, `position_runner_memory`; chưa triển khai vào production.
- Tích hợp flow/runner context với monitor/Jev/scheduler; thêm SELL 20%, thesis/flow assessment/invalidation/re-evaluation signals.
- Sửa bước đầu audit F2–F8: single-flight reconcile + terminal-state guard, valuation sau partial, critical priority, units, stale warning timer, learning attribution, cadence-cache cleanup.
- UI tiếng Việt giữ palette hiện có; thêm flow/exposure/thesis, cảnh báo backend cũ thiếu capability.
- `src/runtime-info.ts` và `scripts/build.mjs`: build identity captured khi module load.
- Bộ regression cũ **125/125 pass** sau tích hợp. Lượt mới nhất `pnpm test` **138/138 pass**, log `data/capital-flow-tests.log`.
- **Typecheck mới nhất còn lỗi trong test, chưa hoàn tất quality suite/build/UI của bản Capital Flow.** Không được coi 138 test xanh là đã deploy hoặc hoàn tất.

## Việc tiếp theo bắt buộc

1. Đọc lại source hiện tại, không dựng lại kiến trúc. Tác vụ trước bị ngắt khi đang bổ sung kiểm thử.
2. Sửa lỗi typecheck trong `tests/capital-flow.test.ts`, ca overlap reconciliation: Promise resolver đang bị suy luận `never`. Dự kiến khai báo `new Promise<unknown>(resolve => ...)` và cast kiểu receipt ở boundary fixture; không sửa production validator để làm test xanh.
3. Cải thiện test 20 vị thế hỗn hợp: hiện kiểm tra independence/error/backoff/SELL, nhưng cần seed temporal histories cho các regime khác nhau thay vì chỉ warming-up.
4. Bổ sung kiểm thử/performance ít nhất 50 vị thế; đo monitor/GMGN call count/flow computation/Jev queue/concurrency/calls per minute/retained state bytes/memory và DB growth. Không dùng RPC cho flow.
5. Bổ sung/kiểm tra các ca unsigned/signed pending, stale quantity/security revision, noise/rapid reversal, runner learning retrieval và attribution của ba execution failures.
6. Hoàn thiện bounded retention và đối chiếu các yêu cầu 1–96 của attachment. Kiểm tra không thay đổi quantity/accounting vị thế thật khi migration.
7. Làm gọn card: flow metrics/timeline nên ưu tiên expandable details; kiểm tra frontend stale timer, backend capability mismatch và exposure sau partial. Thêm bản dịch tên cấu hình flow mới.
8. `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, browser isolated PAPER và audit bí mật. Chỉ báo PASS đúng những lệnh đã chạy đạt.
9. Kiểm tra schema/parser Jev mở rộng bằng lời gọi thật chỉ đọc nếu cần; không gọi execute/sign để chứng minh.
10. Viết báo cáo đầy đủ 35 mục và trả lời 19 câu hỏi YES/NO theo attachment, phân biệt test/source/runtime.
11. Khi đã sẵn sàng: đọc trạng thái LIVE mới nhất, actual balances/BUY signatures/pending/manual requests/attention, lưu checkpoint; migration/recovery normal-live; resume theo quyền chủ dự án. Không dựa vào PID/trạng thái lịch sử và không tự xóa genuine halt.
12. Kiểm tra runtime mới qua build ID/capabilities/migrations và quan sát IMAGINE trong SELL BACKOFF; không claim LIVE mới từ static frontend hoặc build file trên đĩa.

## Provider facts đã kiểm tra chỉ đọc

`data/capital-flow-provider-fields.json`: GMGN thật cung cấp `price.volume_*`, `price.buy_volume_*`, `price.sell_volume_*`, buys/sells theo 1m/5m/1h/6h/24h. Zero là dữ liệu thực khi provider trả 0. `holder_count` có sẵn. `wallet_tags_stat.smart_wallets` là số ví, không phải buy/sell USD flow. Smart-money USD flow và large-trade imbalance vẫn UNKNOWN khi thiếu nguồn phù hợp.

Net flow trong component là chênh lệch directional DEX trade volume theo cửa sổ trượt, không phải tiền nạp ròng vào token. Không gán biến động rolling 24h thành tiền mới đi vào trong 1 phút.

## Trạng thái LIVE lịch sử, cần đọc lại khi tiếp tục

Checkpoint audit trước đó: PID 16080 chạy backend cũ; BUY mới=false, không halt, ba vị thế OPEN có attention/backoff. Backend cũ còn max-hold. Không restart hoặc đổi LIVE trong lần triển khai Capital Flow vừa tạm dừng.

Một lần thay tiến trình ở tác vụ trước đã bị automatic approval review từ chối với lý do `blocked by policy`. Không chuyển sang một cách gọi khác để vượt chặn. Nếu thao tác triển khai vẫn không được phép, báo rõ hành động, lý do và trạng thái thực tế; không khẳng định đã LIVE.

Giữ nguyên báo cáo audit lịch sử: `docs/jev-exit-post-implementation-audit.md`, `docs/position-monitoring-sell-audit.md`. Không sửa lại các checkpoint cũ thành bằng chứng cho bản mới.
