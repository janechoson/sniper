# Unsigned execution deadline — 03/11/2026

**IMPLEMENTED / VERIFIED / DEPLOYED.** User yêu cầu gỡ pending HEDGE, tự kết thúc pending quá1phút và triển khai. Không xóa receipts/history; execution unsigned hết hạn trở thành terminal FAILED và ra khỏi pending set. Signed/submitted/UNKNOWN vẫn được giữ để reconciliation, không giả hủy chain transaction hoặc cho phép duplicate BUY.

## Policy và implementation

Một constant **`UNSIGNED_EXECUTION_TIMEOUT_MS = 60_000`** tại `src/execution-deadline.ts`. T0 lấy execution.at lúc atomic claim tạo CREATED; không reset deadline qua quote/probe/simulation/final validation. Không thêm setting/env flag hoặc timeout ngắn theo từng stage.

`Executor` dùng `UnsignedExecutionDeadline.wait()` cho các async boundary trước ký. Khi quá60s: caller thoát await đang treo, execution FAILED/EXECUTION_UNSIGNED_TIMEOUT, BUY Position FAILED quantity0 hoặc SELL Position OPEN giữ nguyên quantity/cost/PnL. Reservation và mutex được nhả; active BUY ownership được resolve FAILED_UNSIGNED. Claim tombstone của attempt vẫn giữ nên loser không giành lại cùng attempt. Caller có thể xử lý candidate/fresh attempt khác. Failure được phân loại CandidateRejected, không tự halt toàn bot hoặc tạo trade LOSS từ giao dịch chưa diễn ra.

Đây không chỉ là Promise.race trả sớm: lease giữ trạng thái cancelled/finished; pre-sign và durable-signature callbacks kiểm tra lease, late quote/probe/simulation không thể tiếp tục sign/submit hoặc ghi đè execution FAILED. Exit probes ngừng gửi các level còn lại nếu lease đã hết hạn. Timer được clear khi hoàn tất hoặc vào critical signing boundary; built-in provider ký và persist signature đồng bộ sau hook này. Không để timeout chạy xen giữa ký và lưu signature.

Sau khi có chữ ký: giữ SUBMITTED/PENDING_CONFIRMATION/UNKNOWN và wallet/reconciliation guards hiện hữu. Timeout transport sau ký vẫn theo UNKNOWN/halt transaction policy, không giải phóng quyền giao dịch mù. Đây là ngoại lệ cần thiết với yêu cầu xóa pending: chain transaction có thể đã được gửi hoặc landed. Startup recovery cũng được thêm explicit signature guard: **CREATED có signature không bị discard**.

Jupiter Http có total deadline60s tính từ lúc enqueue, bao gồm queue wait, pacing/retry, fetch và read body; fetch timeout15s hiện hữu vẫn giữ. Timeout abort signal và kết thúc logical request, không để late response đổi health/state của request mới. Request hết hạn trong queue không chạy về sau hoặc cho follower vượt active predecessor. Chỉ instance Jupiter bật total deadline; RPC/JEV giữ timeout/latency semantics cũ. Các validator, slippage, sizing, Security/Risk, FIRST_BUY_WINS và SELL authority không được nới.

## Tests

`pnpm test`: **504 passed, 0 failed/cancelled/skipped**,145.114,1912ms. `pnpm typecheck`, `pnpm lint`, `pnpm build`: PASS. Pnpm launcher có Node20 engine warning; actual build/test dùng pinned Node22.22.0.

11 tests mới: quote/probe/simulation/delayed pre-sign bị treo; exact59.999/60s boundary; late work không sign/submit hoặc resurrect state; fresh attempt sau timeout vẫn CONFIRMED trong fixture; SELL timeout giữ nguyên quantity/cost/realized; signed pending qua60s không bị xóa và theo UNKNOWN policy; CREATED có signature phải reconcile; actual first-buy ownership được release; HTTP fetch/body/queue treo có deadline và request sau vẫn chạy, không late state overwrite. Sau điều chỉnh giữ semantics latency RPC/JEV, HTTP subset3tests chạy lại PASS. Fixtures virtual clock/fake signer/provider/RPC,0 real network/sign/submit; không lưu screenshot/raw logs mới.

Files: `src/execution-deadline.ts`, `executor.ts`, `domain.ts`, `util.ts`, `execution-provider.ts`; `tests/execution.test.ts`, `http-deadline.test.ts`, `first-buy-wins.test.ts`. Badge/read-model changes từ follow-up trước cũng được nạp trong build này; xem [badge và HEDGE incident](position-badge-and-hedge-stall.md).

## Recovery và deployment

Preflight read-only xác nhận duy nhất execution `7890203c-6978-4010-9956-5bc252e857f7` CREATED/unsigned/expired, BUY HEDGE; không có submitted manual request. Signer hợp lệ, RPC mainnet, cả4 core OPEN holdings (gồm dismissed) khớp balances và confirmed BUY receipts. Tạm tắt new entries bằng API hiện hữu, recheck signature/state rồi dừng đúng blocked main PID18184. Không tác động legacy Lab PID3216/8792. User hiện đặt **10%**; không restore giá trị5% cũ.

Fresh DB/WAL/SHM backup sau dừng: `data/backups/before-execution-timeout-20261103T022318Z/`, copy hash-matched, integrity_check=ok;239.955.968 +4.927.552 +32.768bytes. Build cũ: `data/backups/build-before-execution-timeout-20261103T022140Z.zip`. Không copy `.env`/keys hoặc reset data.

Build mới **`97ee84885ad89ed7d3b4422f8b74c4ede4b6f00623dfae134c5d1801d80c08e8`**, hidden Node22.22.0 `dist/live.js`, **PID10176**, loaded09:24:26 Bangkok. Normal startup/recovery loại execution cũ khỏi pending bằng FAILED, error `Unsubmitted intent discarded on restart; never replayed`; Position tương ứng FAILED/quantity0, claim inactive/FAILED_UNSIGNED. Không DELETE execution hoặc giả wallet token balance0.64 confirmed executions lịch sử vẫn có ở checkpoint sau recovery.

GET sau startup: LIVE, entries=true, halt=null, scanner running, size10%, count API trả đúng `{"count":2}`. Pending set rỗng ở checkpoint; scanner đã sang Confidence/HISTORY/REJECTED thay vì kẹt HEDGE. Không tạo lệnh BUY/SELL kiểm chứng; Engine tiếp tục được phép tự giao dịch theo LIVE đã bật nên các checkpoint sau có thể thay đổi độc lập.

Checkpoint09:27:33: token hiện tại Bullshit/COMMON_RISK, Jupiter health READY, exit-liquidity checks3/probes9, không halt. Checkpoint09:29:06: bot tự có thêm GATO OPEN sau khi khôi phục LIVE; visible Positions Dacity/GATO/FLOAT=3 và badge count=3 khớp nhau. Đây là giao dịch tự động của Engine, không phải trade fixture hoặc lệnh BUY operator từ task. Production browser trên Settings xác nhận chỉ GET shell + count + settings,0JavaScript errors/0mutations; source digest khớp build, không còn route fixture dirs.

Service logs: `data/bot-execution-timeout-20261103T022424Z.stdout.log` / `.stderr.log`. Backup và logs này là vận hành thật, giữ lại. Không tạo build/test artifacts mới ngoài fixture tự cleanup; `.build-badge-count` còn từ follow-up trước do automatic approval review đã chặn xóa, không retry hoặc dùng cách khác để vượt chặn.
