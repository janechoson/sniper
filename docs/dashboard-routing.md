# Dashboard routes và API isolation

**UI follow-up03/11:** [Rug Killer theme, Overview/Logs và Settings feedback](rug-killer-design-and-grouped-logs.md). Logs group theo attempt, lazy detail GET chỉ khi expand; Settings bỏ controls legacy và có toast. Giữ route isolation, không restart/pause bot; Statistics redesign deferred.

**Follow-up03/11:** [Badge count và HEDGE quote investigation](position-badge-and-hedge-stall.md) tách count thành GET `/api/positions/count` (`{"count":n}`), thêm một global request nhẹ5s và bỏ count khỏi shell. Đã nạp cùng [execution timeout60s](execution-pending-timeout.md) lúc09:24 Bangkok theo yêu cầu user. Ma trận/digest/deployment bên dưới là checkpoint refactor trước follow-up. Frontend tương thích backend cũ dùng count của page visible, không thêm global full Positions fetch.

**03/11/2026 — IMPLEMENTED / VERIFIED / DEPLOYED.** Yêu cầu user ngoài attachment cho phép nạp code/chạy lại sau khi kiểm chứng; không restart LIVE trong lúc implementation/verification. Không thay strategy, ownership, execution hoặc accounting. Dữ liệu trading không reset/import.

## Audit actual code trước sửa

| Page/route dự kiến | Component hiện hữu | API/data dependency trước refactor | Lifecycle hiện tại |
| --- | --- | --- | --- |
| `/` | BOTOverview + Action Log + Position preview | status.overview, balance/SOL price/runtime; bootstrap còn gọi tokens/positions/history | full SSE data5s, overview/flow1s, global tick1s |
| `/positions` | BOTPositions | positions + token identity; runtime/mode/jevExit | cùng global refreshTables, dù tab bị ẩn |
| `/history` | renderHistory | history, token metadata | cùng global refreshTables; filter tự refresh cả tokens/positions/history |
| `/memory` | renderLearning / showLearningTrade | status.learning; GET /api/learning/trade?id khi mở detail | report được nhét trong mọi status5s |
| `/settings` | renderSettings / settingsForm | status.settings; POST /api/settings, /api/kill, /api/scan | form render từ mọi status, giữ editing flag |
| `/logs` | BOTLogUI | status.events/overview, flow.events, token/Position/History metadata | init DOM ngay bootstrap; SSE và các bảng nuôi log cả khi tab ẩn |
| `/thongke` | terminalStatistics | status.analytics / strategyAnalytics | backend status gọi analytics ALL/STANDARD/KRONOS mỗi5s |

Endpoints thật: GET `/api/status`, `/api/events`, `/api/tokens`, `/api/positions`, `/api/history`, `/api/learning`, `/api/learning/trade`, `/api/trace`, `/api/candidate`; POST settings/control/exit/remove như source server. Global GET status + EventSource + refreshTables là coupling cần gỡ, không phải dependency bắt buộc của tất cả page.

Phân loại: wallet/mode/runtime/CSRF/header badge = **GLOBAL_REQUIRED**, nhưng chỉ payload nhỏ; History/Memory/Settings/full Logs/Statistics = **ROUTE_REQUIRED**; token detail và learning trade detail = **SHARED_BUT_LAZY** theo thao tác visible; load mọi dataset và init hidden page từ bootstrap = **UNNECESSARY**. Legacy Watch/Deferred navigation cần giữ chức năng nhưng cũng có lifecycle riêng.

## Route map và API ownership sau refactor

| Route | Page/module lazy | GET tự động của page | Polling sau khi request trước hoàn tất |
| --- | --- | --- | --- |
| `/` | dashboard-overview | `/api/overview` | 1s |
| `/positions` | dashboard-positions | `/api/positions?view=page` | 5s |
| `/history` | dashboard-history | `/api/history` + strategy/filter/page query hiện hữu | 5s |
| `/memory` | dashboard-memory | `/api/learning` | 15s |
| `/settings` | dashboard-settings | `/api/settings` | Một lần khi mount; refresh sau Save |
| `/logs` | dashboard-logs | `/api/logs?limit=800` | 5s |
| `/thongke` | dashboard-statistics | `/api/statistics?strategy=ALL\|STANDARD\|KRONOS` | 5s |
| `/watchlist` | dashboard-watch | `/api/watchlist` | 5s; giữ navigation legacy |
| `/deferred` | dashboard-watch | `/api/deferred` | 5s; giữ navigation legacy |

Mỗi route chỉ có **một page được mount**. `index.html` chứa shell và các HTML template inert; template của page hiện tại mới được clone vào route outlet. `app.js` chỉ import router; mỗi page dùng dynamic import. Không init hidden page, không load `flow.js` hoặc full bootstrap cũ. Hai card STANDARD/KRONOS, stage lights, compact BUY, token/format Liquidity, Action Log và USD preview được giữ.

**Global duy nhất:** GET `/api/ui/shell`, khi mở app và mỗi5s, coalesce request đang chạy. Payload chỉ gồm wallet/SOL-price/runtime/mode/entry-control/halt/scanner/badge/capability và CSRF cho header/control visible; không chứa settings, learning, statistics, history, flow hoặc overview dataset. Đồng hồ header là timer local1s. SOL-price dùng cache Engine hiện hữu, không thêm GMGN consumer. Settings cần cho Engine vẫn load độc lập như trước; việc lazy page không tắt runtime config.

Overview nhận tối đa10 active Position previews và total count, queue preview8, current attempt/token và Action Log của attempt. Không gọi full Positions/History/Logs. Active Positions endpoint chỉ trả các Position relevant và ba settings references cần cho view, không load toàn bộ Settings screen. History mang identity/accounting ngay trong response, không gọi tokens/positions để enrich. Logs nhận bounded events/transitions và identity metadata chỉ cho các mint trong log; system alerts không có mode vẫn được giữ. Statistics/Memory không được tính trong shell hay Overview.

**Theo thao tác visible:** token detail mới GET `/api/trace?mint=…` + `/api/candidate?mint=…`; Memory trade detail mới GET `/api/learning/trade?id=…`. POST settings/scan/kill/manual-exit/dismiss giữ endpoint, validation và CSRF hiện hữu. Không tự gọi mutation từ navigation. Lệnh operator đã gửi không bị giả hủy khi rời page; response UI vẫn bị ràng buộc với route.

## Lifecycle và direct URLs

URL là source of truth: pushState/popstate, active anchor và aria-current theo pathname; Back/Forward/refresh/direct URL hoạt động. `/` là Overview duy nhất; `/overview` và unknown frontend paths trả404. Server whitelist chính xác các page paths/assets, không SPA fallback cho `/api/*` hoặc đường dẫn tùy ý. `localhost:PORT` và `127.0.0.1:PORT` được chấp nhận chính xác; server vẫn bind127.0.0.1. POST yêu cầu Origin khớp Host thực và CSRF; không mở wildcard Host/Origin.

Rời route sẽ abort pending GET, hủy timeout/interval, shell listener và object URLs; đóng detail/removal dialog, bỏ DOM/page globals. Epoch guard chặn late response, kể cả request hoàn tất sau khi abort. Request filter mới thay request cũ cùng endpoint. Poll không chồng request; click lại cùng URL không init/fetch page lần nữa. Re-enter page lấy fresh data, không dựng cache dài làm stale trading data. Position và Watch tick1s chỉ tồn tại khi page đó đang mount. pagehide dọn app timers; BFCache pageshow remount page và header.

Frontend mới **không dùng SSE/WebSocket**. Legacy `/api/status` và `/api/events` được giữ tương thích caller cũ; full status chỉ chạy khi được gọi hoặc có legacy SSE subscriber. Server không tính full status định kỳ khi không có subscriber. Browser cũ chưa reload hoặc legacy Lab vẫn có thể gọi các endpoint cũ; không tuyên bố mọi process trên máy ngừng toàn bộ API cũ.

## Bằng chứng request isolation

`scripts/dashboard-route-ui.ts` chạy actual source server, Chromium và temp SQLite, fake provider, PAPER/entries=false/scanner=false. Preload chặn đọc credentials và external fetch. Script ghi nhận **mọi `/api/*` request**, assert đúng một request page ban đầu, assert tập endpoint chỉ có page hiện tại + shell, rồi advance16s virtual time để bắt polling còn sót.

| Route | Page requests trong lượt16s cuối | Shell requests | Requests đến mỗi API page không liên quan |
| --- | ---: | ---: | ---: |
| `/` | overview8 | 4 | **0** |
| `/positions` | positions4 | 4 | **0** |
| `/history` | history3 | 4 | **0** |
| `/memory` | learning2 | 4 | **0** |
| `/settings` | settings1 | 4 | **0** |
| `/logs` | logs4 | 4 | **0** |
| `/thongke` | statistics3 | 4 | **0** |
| `/watchlist` | watchlist4 | 4 | **0** |
| `/deferred` | deferred3 | 4 | **0** |

Counts là lần chạy fixture thực tế; async completion trong virtual-clock test có thể làm số lần poll thay đổi. Invariant được assert là endpoint ownership/không polling route cũ, không phải SLA cadence. Full legacy status calls=0; Memory/statistics spies=0 khi kiểm tra Overview. Global response được kiểm tra không chứa heavy datasets.

Sequence `/ → /history → /positions → /thongke → /` xác nhận API cũ ngừng; Back/Forward đúng nav. Direct và reload History/Positions/Settings đều đạt; localhost direct History đạt. Một History request được cố ý giữ pending rồi chuyển Positions: request bị abort, late payload không chạm Positions, subsequent History polling=0. Responsive1440/1024/390 không overflow, vẫn hai card và hai compact BUY rows. Unknown API giữ JSON404. Console errors=0; external-provider calls=0, executions=0 trong fixture.

## Kiểm chứng và preservation

| Check | Kết quả |
| --- | --- |
| `pnpm test` | **477 passed, 0 failed/cancelled/skipped**, 134.700,1884ms |
| New route API tests | **7 passed**; chạy lại trên canonical index.html sau nạp source |
| `pnpm typecheck` | PASS |
| `pnpm lint` | PASS |
| `pnpm build` | PASS, pinned Node22.22.0 |
| `scripts/dashboard-route-ui.ts` | PASS cả staged và canonical shell; matrix ở trên |
| `scripts/first-buy-wins-ui.ts` | PASS, compact cards/owner/UI/format regression |
| `scripts/kronos-integration-ui.ts` | PASS, settings size/filter/Position/History/statistics regression |

Trước deployment:129 protected source/dist/config/env/package/lock files so với baseline; chỉ `src/engine.ts` và `src/server.ts` đổi. Engine chỉ thêm read model `dashboardStatus` và thu nhỏ `overviewStatus`; token-level comparison của39 existing methods khác (bỏ Overview projection) cho changed=[] so với deployed dist trước sửa. FIRST_BUY_WINS/claim SQL, STANDARD/KRONOS/Jev/Risk/Security, BUY/SELL/ownership, signer/Jupiter/reconciliation, Memory algorithms, config và `.env` không đổi. Không thêm migration/schema/reset hoặc sửa trading rows để phục vụ routing.

Sau deployment:65 protected core/config/env/package/lock files (bỏ hai file projection/server và dist được build lại) tiếp tục changed=0. Source/public/config digest khớp build đang chạy. Hai regression UI dùng clock thực sự pause trước khi chèn synthetic frames; chỉ `clock.install()` vẫn cho timer chạy theo thời gian thật và từng làm polling ghi đè fixture trong một lượt chạy song song.

Files: `public/index.html`, `app.js`, `style.css`; `public/dashboard-{router,core,text,overview,positions,position-tools,history,memory,settings,logs,statistics,watch}.js`; `src/server.ts`, `engine.ts`, `dashboard-view.ts`; `eslint.config.js`; `tests/dashboard-routes.test.ts`; ba UI scripts ở bảng trên; báo cáo này. Staged shell đã xóa, app.js monolithic đã được thay bằng loader. Screenshots/raw evidence/test DB/build scratch không được giữ; tests tự cleanup fixture/temp artifacts. Backup deployment và service logs thật được giữ.

## Deployment theo yêu cầu user

Sau verification mới dùng entry-control API tạm khóa mua mới, chờ scanner batch kết thúc và recheck: execution nonterminal0, Position pending0, manual CLAIMED/SUBMITTED0. Signer hợp lệ, RPC mainnet, cả4 core OPEN holdings và BUY receipts được kiểm chứng read-only. Chỉ dừng main PID11556; legacy PAPER Lab PID3216/8792 không tác động. Không clear halt, đổi percentage hoặc sửa `.env`.

Backup build/public cũ: `data/backups/build-before-dashboard-routes-20261103T010235Z.zip`. Canonical shell được nạp sau khi dừng bản cũ; build PASS rồi chạy hidden Node22.22.0 `dist/live.js`, **PID18184**, build **`cf349f518dc32f86314614689af004a10e7ed5d0ad28329933fa2662f9520077`**. Startup normal-live/recovery/holdings checks hiện hữu được giữ, không có schema migration mới từ refactor.

Checkpoint **08:06 Bangkok**: LIVE, entries=true, halt=null, scanner running, dashboardRoutes=true, **positionSizePercent=5 giữ nguyên**. UI: http://127.0.0.1:3000 — reload để rời frontend monolithic cũ. Service logs: `data/bot-dashboard-routes-20261103T010545Z.stdout.log` / `.stderr.log`.

Production read-only browser smoke: `/`, `/history`, `/positions`, `/settings` có đúng page API + shell, unrelated page endpoints0; input size=5. Cả7 required HTML routes trả200, JavaScript errors0, API failures0, mutations0. **31 external-image console errors** thuộc `gmgn.ai` với `ERR_BLOCKED_BY_RESPONSE.NotSameOrigin`; đây là lỗi tải logo từ nguồn ngoài, không phải route/API failure. Renderer avatar hiện hữu chuyển sang initials khi ảnh lỗi; không sửa CSP hay proxy logo trong refactor này. Vì vậy console0 trong bảng verification là isolated fixture, không phải tuyên bố console production hoàn toàn sạch.

Không gửi lệnh BUY/SELL hoặc trade kiểm chứng. Từ khi khôi phục LIVE, Engine được phép tự giao dịch theo quyền user có từ trước; không tuyên bố wallet/DB bất biến qua thời gian task. Production read-only smoke sau startup kiểm tra route/API và cấu hình, không gửi mutation test.

Checkpoint cuối **08:12:37 Bangkok** vẫn PID18184/LIVE/entries=true/halt=null/scanner running. Cả hai regression UI chạy lại trên canonical shell đều PASS, exit0; typecheck/lint cuối exit0. Các thư mục temp của route/API/ownership/integration browser tests đã được cleanup, không còn staged shell hoặc scratch build trong project. Không lưu ảnh/raw evidence mới.
