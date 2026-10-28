# DASHBOARD REDESIGN COMPLETE

## STYLE

Theo yêu cầu màu sắc mới nhất theo [Papertrade](https://papertrade.xyz/): nền giấy kem `#f4ecd8`, card `#faf5e8`, chữ nâu `#2a2520`, màu nhấn olive `#526548`. Bằng chứng và các màu phối được ghi trong [DESIGN.md](../DESIGN.md). Card bo 17px, bóng đổ mềm nhiều lớp; nền và viền trạng thái dùng màu pha sáng, chữ dùng tông đậm để dễ đọc. Giữ bố cục terminal gọn, chữ số/địa chỉ/nhật ký monospace. PAPER dùng nhãn xanh lam nhạt; LIVE dùng nhãn cam riêng. UNKNOWN dùng xám trung tính. Thay đổi này chỉ là giao diện, không đổi logic vận hành.

## COMPONENTS REDESIGNED

Shell/header/sidebar; bốn metric; scanner; trang vị thế và chi tiết; lịch sử/phân trang; settings; trạng thái chuỗi/hệ thống; modal Rug/Jev/Risk; analytics; thông báo mua/bán mô phỏng. Menu vẫn tách biệt, Tổng quan chỉ hiển thị bản tóm tắt.

## COMPONENTS ADDED

- `terminal-overview.tsx`: MetricCard, ActivityLog (tối đa 24 event), SystemHealth, bản tóm tắt vị thế.
- `performance-chart.tsx`: SVG theo thời gian, 24h/7 ngày/tất cả, tooltip; tối đa 500 mốc gần nhất; giữ khoảng trống ở P&L chưa biết. Không sinh đường hoặc điểm khi thiếu dữ liệu.
- `decision-panels.tsx`: quyết định RiskEngine nổi bật, Rug Check theo bằng chứng và Jev tư vấn riêng.
- `position-detail.tsx`: dữ liệu vị thế có sẵn; nối thao tác đóng vào dialog xác nhận và API cũ.
- Dialog xác nhận dừng/khôi phục lệnh mới, giữ nguyên action backend; hỗ trợ Escape và giữ focus trong dialog.

## COMPONENTS REMOVED

Khối Overview cũ, các metric trùng, ObservationPanel dài, đồ thị analytics cũ (thay bằng component dùng chung) và CSS trắng đã hết dùng. Giữ chức năng cấu hình, chọn chuỗi, điều khiển scanner, vị thế, ngắt lệnh, lịch sử, Rug Check và dữ liệu JSON.

## REAL DATA CONNECTED

Snapshot, SSE, metrics scanner, pool/token, Jev, bằng chứng Rug, Risk, thời điểm, vị thế mô phỏng, ví công khai và health. Số dư gốc đọc qua API hiện tại khi người dùng chọn Đọc RPC. Hiệu suất thực thi dùng analytics backend; không tính lại P&L từ giá spot. Các provider bảo mật đã dùng có trạng thái lần thu thập và thời điểm, không suy diễn uptime hiện tại.

## DATA CURRENTLY UNAVAILABLE

- Ví hiện chưa cấu hình: số dư hiển thị `—`, không đặt vốn giả.
- Backend chưa cung cấp tổng số dư/available/reserved được định giá USD; không tự định giá ở frontend.
- Sổ mô phỏng quan sát chưa có P&L ròng đã xác minh phí/khớp lệnh: metric, tỷ lệ thắng và chart để trống có giải thích; không trộn với sổ thực thi.
- Chưa có lịch sử vốn USD hoặc dữ liệu để dựng sparkline/marker mua bán có liên hệ đáng tin cậy: không hiển thị đường/marker mẫu.
- Dữ liệu holder, cửa sổ thị trường, khả năng bán hoặc bảo mật còn thiếu/hết hạn tiếp tục là UNKNOWN.
- Jev có lúc báo unhealthy trong snapshot thực tế; giao diện hiển thị lỗi nhận từ backend, không đổi thành READY.

## RESPONSIVE

| Kích thước | Kết quả                                                                                                                                   |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 1920×1080  | Đạt; header, 4 metric, chart, vị thế, nhật ký và scanner/system hiện trong hoặc gần trọn màn hình đầu; scanner kết thúc trước mốc 1100px. |
| 1440×900   | Đạt; giữ bố cục hai cột, bảng dài cuộn bên trong.                                                                                         |
| 1366×768   | Đạt; không tràn ngang trang, có cuộn dọc.                                                                                                 |
| 820×1180   | Đạt; điều hướng gọn, khối chính xếp lại.                                                                                                  |
| 390×844    | Đạt; tất cả menu dùng được, bảng cuộn ngang nội bộ.                                                                                       |

Ảnh chụp `data/dashboard-1920.png`, `data/dashboard-1440.png`, `data/dashboard-1366.png`, `data/dashboard-820.png`, `data/dashboard-390.png` chỉ lấy dữ liệu runtime thật, không chụp trang fixture.

## TRADING LOGIC CHANGED: NO

Giữ quan sát thật/PAPER, 5 USD mỗi tín hiệu. Mục tiêu 10% số dư khả dụng vẫn là yêu cầu cho lần chuyển LIVE sau này, chưa kích hoạt.

## RISK LOGIC CHANGED: NO

Không sửa RiskEngine, RugCheck, Jev, giới hạn, slippage hoặc chính sách UNKNOWN.

## EXECUTION LOGIC CHANGED: NO

Giữ hợp đồng API, payload xác nhận đóng vị thế và các khóa backend. Không sửa scanner, database, migration hoặc `.env`.

## WALLET LOGIC CHANGED: NO

Chỉ đọc địa chỉ công khai và lượng tài sản gốc qua API cũ; không thêm signer hay thao tác bí mật vào frontend.

## LIVE TRANSACTION BROADCAST: NO

Snapshot sau triển khai vẫn PAPER, RPC, liveEnabled=false, observation.budgetUsd=5, executions=0.

## TEST

`pnpm test`: 156 đạt, 4 kiểm thử mạng tùy chọn bỏ qua. `pnpm test:browser`: đạt Chrome, cả năm kích thước. Bao gồm menu, empty state, SSE/toast, UNKNOWN trung tính, thiếu Jev, suy giảm RPC, chart/tỷ lệ thắng/P&L có dữ liệu, khoảng trống chart khi kết quả chưa rõ, scanner dừng/chạy, chế độ PAPER/LIVE, lỗi tải snapshot, số dư gốc, chọn chuỗi, lưu settings, ngắt/khôi phục và xác nhận đóng vị thế.

Những trạng thái chưa có trong runtime được intercept hoàn toàn `/api/*` ở trang kiểm thử riêng. Không ghi fixture vào SQLite, không đổi cài đặt vận hành bằng QA. Bài kiểm tra API đóng lệnh thật chỉ dùng ID không tồn tại để xác nhận OBSERVATION chặn với 503. Payload JSON và event SSE được đối chiếu với secret cục bộ và kiểm tra tên trường nhạy cảm; không phát hiện lộ khóa trong các phản hồi được kiểm tra. Đây là xác minh luồng dashboard, không phải cuộc audit bảo mật toàn bộ ứng dụng.

## LINT / TYPECHECK / BUILD

`pnpm lint`: đạt. `pnpm typecheck` (trong `pnpm build`): đạt. `pnpm build`: đạt Next.js production. Prettier các file chỉnh sửa: đạt. Đã khởi động lại bản build tại `http://127.0.0.1:3000`.

## FILES CHANGED

- `apps/web/app/globals.css`, `apps/web/app/layout.tsx`.
- `apps/web/components/dashboard.tsx`, `observation-panel.tsx`, `real-analytics.tsx`, `rug-check-report.tsx`, `tables.tsx`, `ui.tsx`, `vi.ts`.
- Thêm `apps/web/components/terminal-overview.tsx`, `performance-chart.tsx`, `decision-panels.tsx`, `position-detail.tsx`.
- `scripts/browser-smoke.mjs`.
- `docs/dashboard-redesign-plan.md`, `docs/dashboard-redesign-report.md`, `README.md`, `AGENTS.md` (ghi nhận yêu cầu thiết kế mới thay nền trắng).
