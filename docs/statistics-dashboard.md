# /thongke — Statistics Dashboard

**03/11/2026, Asia/Bangkok — IMPLEMENTED / VERIFIED.** Tiếp tục yêu cầu Statistics đã hoãn trước đó. Chỉ sửa giao diện, không pause/restart bot hoặc deploy backend.

## Audit và actual API contract

Đã đọc actual `Engine.analytics()`, handler `GET /api/statistics`, shell, route scope, formatter và design tokens trước code; kiểm tra GET thật ở16:15:49 Bangkok.

| Filter | Response thật |
| --- | --- |
| ALL | discovered, analyzed, rugRejected, jevCalls/jevBuy/jevSkip, riskAllow/riskReject, bought/open/closed, strategy, strategyAccounting, realizedLamports, unrealizedLamports, pnlBasis, winRate |
| STANDARD / KRONOS | Bare accounting object: closed, wins, losses, grossPnlLamports, feesPaidLamports, identifiedFeesLamports, feesComplete, netPnlLamports |
| Shell đã có | solPriceUsd và solPriceUpdatedAt; dùng lại global shell subscription |

Checkpoint chỉ để đối chiếu contract, không hardcode: ALL discovered2511/bought50/open1/closed47; accounting wins19/losses21, gross/net/realized=null, identifiedFees784743lamports, feesComplete=true, unrealized414041lamports, winRate=null. Filter KRONOS có closed33/wins16/losses17/gross−29341388/net−29926240lamports; STANDARD closed14/wins3/losses4/gross/net=null. LIVE có thể tiếp tục tự thay đổi.

Các formatter dùng chung hiện có được audit. Formatter SOL chung giới hạn6decimal; Statistics dùng local BigInt formatter để giữ đủ9decimal lamports, không đổi formatter của các màn khác.

## UI và data mapping

Header/navigation Rug Killer giữ nguyên. Layout:
- Header Thống kê giao dịch, subtitle và selector ALL/STANDARD/KRONOS.
- Bốn KPI: Phát hiện / Đã mua / Đang giữ / Đã đóng. Không vẽ fake historical sparkline.
- Sáu card: Hiệu suất / Lợi nhuận & Chi phí / Accounting / JEV Decisions / Risk Engine / So sánh chiến lược.
- Warm cream/ivory, subtle border/shadow, STANDARD green và KRONOS purple theo canonical `--rk-*`.
- Skeleton4KPI+6cards; error/retry cục bộ; không còn raw property names/object JSON trên main UI.

| UI | Source / phạm vi |
| --- | --- |
| Phát hiện | ALL.discovered: số tokens trong store; không suy số appearances |
| Đã mua | ALL.bought: Position không FAILED/PENDING_ENTRY; label mô tả Position ghi nhận BUY, không tự đếm execution mới |
| Đang giữ / Đã đóng | ALL.open / ALL.closed theo semantics hiện hữu |
| Performance Wins/Losses/Closed | accounting.wins/losses/closed; Closed ở đây chỉ cohort originalQuantity>0 |
| Realized PnL | ALL.realizedLamports: gross realized mọi settled Position, gồm phần đã bán của OPEN |
| Unrealized PnL | ALL.unrealizedLamports: gross unrealized OPEN/PENDING_EXIT đang quản lý |
| Trading Fees / Net PnL | accounting.feesPaidLamports / netPnlLamports; chỉ cohort CLOSED |
| Accounting | identifiedFeesLamports, feesComplete, gross/net; PnL basis enum map thành human label |
| JEV / Risk | Các records theo mode và giới hạn100.000 records của backend; không gọi là unique tokens |

Tooltips và scope text giải thích các phạm vi. Không cộng realized+unrealized−fees để tạo Net mới, vì cohort khác nhau. Gross/Net chỉ đọc field accounting tương ứng. Known enum GROSS_EXCLUDES_FEES → Gross excludes fees; unknown string hiển thị an toàn bằng textContent, missing → —.

Filtered response không có discovery/bought/open/JEV/Risk/realized/unrealized; các phần đó hiển thị — cùng giải thích, không reuse số ALL của lần trước. Không đổi response shape/backend để lấp UI.

## Presentation formulas và null/zero

- ALL Win Rate giữ **đúng authoritative API.winRate**, kể cả null. Theo source: wins/toàn bộ CLOSED khi mọi gross PnL đều known, bao gồm hòa vốn. Không tự thay bằng wins/(wins+losses).
- Filtered accounting không có Win Rate: derive wins/(wins+losses), label **Win Rate · đã phân loại**; không coi unknown hoặc flat là loss.
- JEV BUY Rate=jevBuy/jevCalls; Skip=jevSkip/jevCalls. Nếu Calls lớn hơn BUY+Skip thì phần dư có label Khác, không gán thành Skip.
- Risk Allow Rate=riskAllow/(riskAllow+riskReject).
- Denominator0, missing/invalid hoặc counts không hợp lệ → —; không NaN/Infinity. Known0 vẫn0 hoặc0.0%.
- null gross/net/fees → —, không biến thành0. feesComplete=false → Incomplete; không coi identified fees là toàn bộ phí.
- Count dùng en-US integer grouping:2321→2,321.

## USD/SOL

USD primary dùng cùng SOL/USD snapshot từ global shell, yêu cầu price finite/positive, timestamp≤now và age<60.000ms. Không thêm price/provider request. USD là ước tính theo tỷ giá hiện tại, không phải FX lịch sử lúc giao dịch.

SOL secondary dùng BigInt, giữ dấu và đủ9decimal; trailing zeros được rút gọn. USD làm tròn2decimal, positive +$, negative −$, exact0 $0.00. Missing/stale/future FX → USD —, SOL vẫn được giữ. Partial fee coverage và unknown Net không bị che bằng phép cộng frontend.

## Strategy comparison và API lifecycle

Current statistics response không chứa cả hai strategy cohorts. Card có STANDARD/KRONOS header và empty state, không fabricate bảng hoặc gọi thêm strategy APIs để điền. Mỗi lần chọn filter chỉ gọi **một** statistics GET, cập nhật URL bằng history.replaceState, không reload document.

Route giữ:
- Page GET /api/statistics?strategy=… mỗi5s sau lần trước hoàn tất.
- Existing global GET /api/ui/shell + /api/positions/count mỗi5s.
- Không fetch full Positions, History, Learning, Settings, Logs, status hoặc provider khi đang ở Statistics.
- Filter mới hủy request cũ và generation guard bỏ late response.
- Rời route abort GET, dừng timers/poll/listeners; Statistics không chạy hidden.
- Retry chỉ gọi Statistics dependency. Shell change chỉ đổi presentation/FX, không thêm page request.

## Verification

| Check | Kết quả |
| --- | --- |
| pnpm test | **519 passed,0failed/cancelled/skipped**,55.353,8837ms |
| New unit tests | **8**: authoritative vs classified Win Rate, missing filtered scopes, zero/unknown, exact SOL/signs/fees, unknown Net, FX freshness/future, malformed amounts, JEV residual/Risk ratio |
| pnpm typecheck | PASS |
| pnpm lint | PASS |
| pnpm build --out-dir .build-statistics-ui-20261103 | PASS; isolated output, không ghi LIVE dist |
| scripts/statistics-dashboard-ui.ts | PASS: actual empty endpoint shapes + intercepted financial fixtures, layout/data/null/zero/coverage/FX, selector and late responses, skeleton/error/retry, abort/hidden polling,0JS errors/0POST |
| scripts/dashboard-route-ui.ts | PASS all9routes/request matrix;0legacy status calls |
| Responsive | 1440:4KPI/3analytics columns;1024:2/2;390:1/1. Equal card height per desktop row,0document horizontal overflow |
| Visual inspection | Desktop/mobile screenshots được xem trong own temp fixture; runner tự đóng/xóa ảnh và DB bằng finally |

Tests dùng PAPER/temp DB, fake GMGN và preload chặn credentials/external fetch. Không wallet/sign/send/BUY/SELL thật. Pnpm launcher Node20 warning; actual commands/tests/build dùng pinned Node22.22.0. SQLite experimental warning không phải failure.

## Files và vận hành

Changed:
- public/dashboard-statistics.js: pure presentation model/formatting + route-owned renderer.
- public/index.html: Statistics template/header/error/feedback.
- public/style.css: Statistics-scoped layout/components, dùng shared tokens.
- tests/statistics-presentation.test.ts.
- scripts/statistics-dashboard-ui.ts.
- Báo cáo này.

**150 protected files,0changed**: source/backend/config/dist/env/package/lock, build/test preload và các module UI khác. Không đổi strategy/ownership/Risk/Security/Position/BUY/SELL/Jupiter/signer/RPC/reconciliation/scanner/Memory/accounting/schema, không thay quy mô BUY hoặc clear halt. Không dùng fingerprint để tuyên bố DB LIVE bất biến khi bot đang tự ghi.

Checkpoint cuối16:31:30 Bangkok: **PID17500 giữ nguyên, LIVE, entries=true, scanner.running=true, halt=null**; loaded backend build vẫn e899bad3521d484312af63c19a600d99a4133ff0a7b3abd514e97e0f9c7c21d2. GET /thongke và /dashboard-statistics.js đang phục vụ markup/module mới trực tiếp. Tải lại /thongke để nhận giao diện; không restart/pause bot.

**Cleanup:** các runner đã đóng server/browser và tự dọn own temp DB/screenshots; thư mục preview statistics-dashboard-ui-TtAzK8 được xác nhận không còn. Automatic approval review từ chối lệnh xóa isolated build với `blocked by policy`, nên còn `.build-statistics-ui-20261103`. Không thử phương thức khác để vượt chặn, không đụng artifacts/backup đã bị chặn của các task trước.
