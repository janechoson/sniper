# Trending FIFO và xử lý trọn batch — BOT sniper

**04/11/2026 — Asia/Bangkok. IMPLEMENTED / VERIFIED; không khởi động BOT sniper.**

Build đích: `af10ebedede86df32ee57e0dca0cc505e9b31f1dc1383fc3675b82c655109158`.

Chỉ áp dụng trong `C:\Users\admin\Desktop\Tool\sniper`. `gmgn-sniper` là nguồn tham khảo read-only, không đồng bộ ngược code hoặc sửa bot đang chạy. Đây là thay đổi scheduler/progress, không phải thay chiến lược entry/exit.

## Behavior

1. Queue trả theo appearanceId dạng số ASC rồi mint; Engine lấy đầu queue, không lấy mint theo alphabet hoặc nhảy qua đầu queue sang batch sau. Batch cũ được drain trước batch mới. Queue size10 và candidates/cycle5 hiện hữu không bị tăng.
2. Chỉ request list Trending mới khi không còn appearances pending, lifecycle đang làm việc, attempt RUNNING/RECONCILING hoặc nhánh evaluation đang hoàn tất. Hai poll callers giữ single-flight. Khoảng poll, provider cooldown và giới hạn GMGN giữ nguyên.
3. Unique `(mode,mint,seen_at)` giữ một mint/một snapshot. Cached response không re-arm batch đã hoàn tất; snapshot mới cho phép cùng mint vào lại sau khi batch trước xong. Không thêm blacklist theo REJECT.
4. Overview dùng batch payload thật: total/completed/processing/waiting. Ví dụ100=71+1+28; waiting bao gồm cả phần chưa vào 10 slots. Carousel vẫn chỉ là preview. Backend cũ/metadata thiếu không bị gán total100 giả.

Guard drain chỉ ở `DiscoveryCoordinator.poll()`, không nằm trong GMGN read/fetch chung hoặc UI polling. Token info/security/holders, `/api/overview`, Position collection, valuation, exit probes, SELL và reconciliation hiện hữu vẫn có thể chạy. Late comparison work chỉ giữ discovery; BUY của winner FIRST_BUY_WINS không chờ peer.

## Identity, completion và recovery

- `settings.trendingBatchV1:<mode>` là metadata nhỏ của batch hiện tại/gần nhất; batch identity `(mode,seen_at)`, entries gắn appearanceId/attemptId. Không thêm bảng/migration hoặc scanner thứ hai. Metadata chỉ lưu một batch mỗi mode; completed totals không lệ thuộc rows đã bị prune2000.
- `consumed=1` nghĩa đã bắt đầu. Claim appearance và ghi attempt khởi đầu dùng transaction; outcome và progress được persist cùng transaction. Nested callers dùng transaction hiện hữu của Store, không đổi semantics của `Store.atomic()`.
- Chỉ terminal BOUGHT/REJECTED hoàn tất entry; RECONCILING tiếp tục processing. Completion idempotent; callback nhánh thua đến muộn không cập nhật nhầm batch hoặc đếm hai lần.
- Constructor giữ QUEUED rows có batch binding và unconsumed appearance hợp lệ, gồm ID và thời gian chờ. Legacy transient rows được reconstruct từ durable appearances theo policy hiện hữu. Không replay consumed work.
- Candidate-attempt recovery hiện hữu phân loại PROCESS_INTERRUPTED/BOUGHT/RECONCILING trước khi khôi phục counters. Tick cập nhật audit outcome sau executor recovery sẵn có; không tạo transaction recovery mới.
- Thiếu processing attempt hoặc unresolved outcome → RECOVERY, không fake-complete/resend. RECONCILING rows không bị retention audit prune.
- Backlog cũ nhiều snapshot được drain theo batch/appearance cũ. Không xóa/coalesce pending appearances. Original total đã thiếu vì retention giữ UNKNOWN; UI hiển thị backlog và counts xác định được.
- Reset maintenance được bổ sung prefix metadata mới vào danh sách runtime được clear, không thay pending/backup/immutability guards. Không chạy reset trong tác vụ này.

## Kiểm chứng

- Trước sửa, hai test tái hiện FIFO z/y→1 và fetch khi còn1 pending đều **FAIL** trên implementation cũ; sau sửa PASS.
- **12 tests mới** trong `tests/trending-batch-fifo.test.ts`:100 FIFO qua queue10, consumed khác completed,100=71+1+28, dedupe/cached/later snapshot, hai poll callers, empty/error cadence, legacy backlog, actual SQLite reopen, interrupted/reconciling/orphan recovery, late callbacks/comparison và shared GMGN reads.
- Test Engine thật chạy20cycles×5 token với100 public mints hợp lệ theo thứ tự ngược alphabet: đủ100 lượt FIFO, chỉ1 fetch list,100 info +100 Security mới dù listing đã cũ1giờ. Fake Security reject cả100; executions0, không signer/network thật.
- Các fixture scanner cũ được cập nhật để có một snapshot timestamp/response và ghi start/outcome như contract Engine mới. Checks safety, failure isolation và Position collection vẫn giữ.
- `pnpm test`: **550 passed,0failed/cancelled/skipped** trên bản cuối; typecheck/lint/build PASS, pinned Node22.22.0. Pnpm launcher Node20 warning/SQLite experimental warning không phải failures.
- Browser `scripts/first-buy-wins-ui.ts`: PASS, batch counter hợp lệ/không hợp lệ/legacy/backend cũ,1440/1024/390,0 console errors. `scripts/kronos-integration-ui.ts`: PASS, settings/cards/Position/History/statistics regression. PAPER servers dùng OS-temp DB; fake provider/RPC/executor và test preload chặn external fetch.

Không benchmark/fetch GMGN thật hoặc LIVE smoke. Không tạo real BUY/SELL/sign/submit. Không tạo screenshots/raw evidence mới; runners cleanup temp fixture DB/build của chính chúng. `sniper/dist` là build cuối được giữ để sử dụng, không phải build test tạm.

## Files

Runtime: `src/trending-batch.ts`, `store.ts`, `candidate-lifecycle.ts`, `candidate-attempt.ts`, `discovery.ts`, các điểm scheduler/admission/projection trong `engine.ts`.

UI: `public/index.html`, `dashboard-overview.js`, CSS scoped `.trending-batch-progress` trong `style.css`.

Verification/maintenance: `tests/trending-batch-fifo.test.ts`, fixtures trong `fault-isolation.test.ts`, `flow.test.ts`, `pipeline.test.ts`; `scripts/first-buy-wins-ui.ts`, `reset-strategy-data.ts`; build tương ứng trong `dist/`; tài liệu này.

## Bảo toàn và trạng thái

Fingerprint **318 file của gmgn-sniper:0changed/added/removed**, gồm src/public/config/scripts/tests/docs/dist, `.env`, package/lock. PID main vẫn17744, loadedAt `2026-11-03T15:14:45.854Z`, build `7a1feadccc7a4524e87f07f7994db7023c5e39d344b0305cdb1840d41a264545`; checkpoint LIVE, entries=true, scanner=true, halt=null. Không POST entry controls, pause/restart, clear halt hoặc đổi config.

Đối chiếu baseline306files của sniper: `.env`, package/lock, configs, Risk, GMGN/coordinator, security/compatibility, execution provider/Executor, accounting, Flow/Memory, Jev/Kronos/model/Structure không đổi. Phần Engine từ `async monitor()` đến trước `overviewStatus()` — Position/SELL/context — khớp source đối chiếu sau chuẩn hóa newline. Không mở Store writable lên DB thật của hai bot; chỉ dùng RAM/temp fixtures.

Không start server/runtime bot ở sniper, không auto-enable LIVE, không đặt thêm listener3000 hoặc can thiệp LAN bridge18240/legacy Lab3216. Vì chưa chạy build mới trên dataset vận hành nên chưa tuyên bố backlog thật đã drain hoặc đủ100/100 LIVE. Khi user nạp bot sniper sau này, fresh reads và mọi guard giao dịch vẫn bắt buộc.

Bot gmgn-sniper LIVE có thể tiếp tục tự ghi DB/giao dịch độc lập; fingerprint source không có nghĩa DB/wallet bất biến trong thời gian kiểm chứng.
