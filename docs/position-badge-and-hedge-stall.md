# Position badge và HEDGE quote stall — 03/11/2026

**Update09:24 Bangkok:** user đã yêu cầu triển khai timeout60s và gỡ pending. [Bản sửa đã được nạp](execution-pending-timeout.md), main PID10176; HEDGE cũ FAILED/claim released, API count riêng đã active. Các mục "chưa nạp/restart" bên dưới mô tả checkpoint điều tra trước deployment.

## Read-only runtime investigation

Main PID18184/build `cf349f518dc32f86314614689af004a10e7ed5d0ad28329933fa2662f9520077` vẫn LIVE/entries=true/halt=null. Không pause/restart, không xóa/mutate pending execution, không sign/submit hoặc gọi lệnh BUY/SELL để kiểm chứng.

Checkpoint08:44–08:47 Bangkok: GET `/api/ui/shell`200/172ms, `/api/overview`200/233ms, `/api/status`200/996ms. UI đọc được API, backend event loop và monitoring vẫn hoạt động. Current attempt HEDGE bắt đầu08:26:49; BUY_QUOTE CHECKING từ08:27:21, không tiến thêm trong hơn17phút. KRONOS đã BUY decision/claim, STANDARD reject Structure; execution vẫn CREATED, signature absent, Position PENDING_ENTRY/quantity0. Đây chưa phải confirmed BUY hoặc token holding mới.

Executor busy=true, exit scheduler executionBusy=true, pendingExits1; trạng thái chờ execution ảnh hưởng lane giao dịch, không chỉ hình vẽ UI. GMGN coordinator HEALTHY,734success/734actual calls,429=0,queueDepth0 tại checkpoint; RPC READY. Execution provider health UNKNOWN/at0. Không dùng nhãn process Running để khẳng định quote lane đang tiến triển.

Discovery báo BACKPRESSURE/CANDIDATE_QUEUE_DRAINING. Có71 Trending appearances chưa consume, Candidate queue10 và nhiều mint khác ngoài HEDGE. `DiscoveryCoordinator.poll()` chủ động không fetch rank mới khi backlog≥queue cap; scanner hiện chờ attempt quote nên không drain tiếp batch. **Không phải GMGN chỉ có một token HEDGE.**

Diagnostic GET tới Jupiter order endpoint **không có quote parameters**, dùng credential nếu đã cấu hình: HTTP400/175ms, body hoàn tất177ms.400 này là kết quả probe thiếu tham số, không phải bằng chứng quote HEDGE bị400. Probe cho thấy DNS/TLS/endpoint có thể đáp ứng từ process kiểm tra; không chứng minh promise bên trong process LIVE đã thoát hoặc route HEDGE có thể trade.

Source: Executor đang await provider.quoteBuy sau progress BUY_QUOTE; Jupiter đi qua `Http.request`. Transport có timeout15s cho fetch, retry tối đa3 cho429/5xx, nhưng await hàng đợi `prior` ở ngoài timeout đó. Runtime chưa có per-request queue/start diagnostics để xác định chắc chắn promise LIVE đang chờ queue, network hay read body. **Đã khoanh vùng execution/quote lane; chưa chứng minh chính xác internal wait root cause**, không tự coi API ngoài bị outage hoặc tự sửa execution/timeout/claim policy trong tác vụ kiểm tra này. Việc timeout fetch đang có không bảo đảm toàn bộ queue wait có deadline.

## Badge fix

Badge cũ từ shell đếm mọi managed OPEN/PENDING_ENTRY/PENDING_EXIT. Current dataset có2 visible holdings và1 unsigned PENDING_ENTRY/quantity0, nên shell count3 trong khi Positions relevant count2.

Thêm **GET `/api/positions/count` → `{"count":2}`**, Cache-Control:no-store. Một truy vấn SQLite COUNT áp dụng đúng visibility của Position view: bỏ dismissed/CLOSED/FAILED; cần quantity>0 hoặc signed unresolved execution hoặc explicit UNKNOWN attention. Không hydrate Position/Execution arrays, không accounting/PnL, Memory/statistics, token metadata, RPC/GMGN/Jupiter. Count không phải MAX OPEN cap và không sửa state/trading authority.

Production read-only probe implementation mới trả11bytes,100lần trung bình2,55ms/query ở checkpoint; không app Store writable hoặc migration.15tests so sánh với `positionViews().relevant`: pending unsigned, các signed UNKNOWN/SUBMITTED states, dismissed, CLOSED/FAILED, pending SELL, huge atomic quantity, mode isolation.

Frontend dùng count API global5s khi backend quảng bá capability positionBadgeCount. Shell mới bỏ positionSummary và không đọc Positions cho header. Poll single-flight, abort khi pagehide, refresh sau operator command. API isolation test cho phép đúng hai global endpoints shell/count; count vẫn cập nhật trên Settings mà không gọi full Positions.

**Tương thích backend đang chạy:** chưa có count capability thì Overview/Positions dùng số lượng từ page payload đã tải, không thêm full Positions request global và không gọi count endpoint chưa tồn tại. Shell count cũ không ghi đè số lượng đã xác nhận từ page. Reload frontend sẽ nhận badge đúng ngay mà không restart. Không giả backend cũ đã có endpoint mới.

## Verification / activation

23 targeted tests PASS (15badge +8route/API tests); route browser isolation PASS,0console errors/real executions trong fixture. Typecheck/lint PASS. Isolated build PASS; không ghi đè LIVE dist. Current pending CREATED được giữ nguyên; count endpoint cần backend mới mới có hiệu lực, chưa nạp/restart trong lúc điều tra execution đang kẹt.

Production browser smoke chỉ đọc: badge **2**, API chỉ shell + Positions hiện tại,0JavaScript errors/0mutations, giữ nguyên PID18184. Compatibility fallback vẫn giữ2 sau shell refresh6s; Ctrl+F5 để nhận frontend mới. Isolated route test còn xác nhận count2→1 trên Settings và backend cũ không bị gọi endpoint count chưa có. Temp browser/API fixtures tự cleanup. Automatic approval review từ chối xóa isolated `.build-badge-count` với `blocked by policy`; thư mục build test này còn lại, không dùng cách khác để vượt chặn.

Checkpoint08:52: intent HEDGE đã hết hạn (expiresAt08:28:04), execution vẫn CREATED/unsigned từ08:27:20. `Executor.validate()` sau quote vẫn kiểm tra intent expiry trước simulation/sign; không lấy thời gian chờ dài làm quyền ký cũ. Latest discovery event08:03:12. Không sửa/clear các state này từ investigation.

Files: `src/dashboard-view.ts`, `server.ts`, `engine.ts` (chỉ shell read projection); `public/dashboard-router.js`, `dashboard-positions.js`, `dashboard-overview.js`; `tests/dashboard-badge.test.ts`, `dashboard-routes.test.ts`; `scripts/dashboard-route-ui.ts`; báo cáo này và cập nhật routing report. Không sửa strategy/Risk/ownership/executor/Jupiter/HTTP transport, không fake-close HEDGE hoặc clear wallet lock.
