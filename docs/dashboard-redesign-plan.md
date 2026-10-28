# Thiết kế lại terminal giao dịch

Điều chỉnh màu theo yêu cầu mới nhất: dùng nền trắng sữa, màu nhấn pastel, thẻ bo góc có shadow mềm. Bố cục và phạm vi chức năng dưới đây giữ nguyên; mô tả nền tối là tham chiếu của yêu cầu ban đầu.

## CURRENT UI

Ứng dụng Next.js tại `apps/web`, một trang client `Dashboard`, bốn mục Tổng quan/Vị thế/Lịch sử quyết định/Cài đặt. Giao diện trắng, nhiều khoảng trống; nội dung đã tách theo menu nhưng Tổng quan thiếu cấu trúc terminal. State React giữ snapshot, settings, lịch sử phân trang, modal và thông báo. SSE `/api/events` kích hoạt làm mới snapshot (debounce 250 ms), dự phòng 5 giây; giữ nguyên cơ chế này.

## AVAILABLE REAL DATA

- `GET /api/snapshot`: mode, liveEnabled, chuỗi hiện tại, scanner, health, kill switch, metrics, candidates, positions, managedPositions, executions, analytics, Rug Check, observation trades, địa chỉ ví công khai.
- `GET /api/history?offset=&limit=`: quyết định đã lưu, phân trang hiện có.
- `GET /api/settings`, `PATCH /api/settings`: cấu hình được backend kiểm tra.
- `GET /api/wallet-balance?chainId=`: lượng tài sản nguyên, decimals, timestamp; chưa có định giá danh mục USD hoặc available/reserved USD.
- `POST /api/control`, `POST /api/position-close`: giữ nguyên payload, kiểm tra và xác nhận hiện tại.
- `GET /api/events`: sự kiện thực tế; hiển thị tối đa 24 dòng nhật ký.
- Candidate chứa thị trường, holder, Jev, bộ lọc, Risk, Rug Check; trường thiếu phải giữ UNKNOWN.
- Analytics có realizedEquity, winRate, closedTrades và unknownNetResults. ObservationTrade có vốn 5 USD, thời điểm, lượng quote và trạng thái, nhưng chưa có P&L ròng đã xác minh.

## REFERENCE DESIGN MAPPING

Áp dụng nền gần đen, thẻ viền mảnh bo vừa, xanh neon có tiết chế, chữ số monospace. Header hiển thị chế độ/ví/chuỗi/scanner/ngắt lệnh. Tổng quan: bốn metric, đồ thị P&L lớn, danh sách vị thế gọn, nhật ký, scanner và tình trạng chuỗi/hệ thống. Các trang chuyên biệt vẫn giữ chi tiết, tránh lặp toàn bộ dashboard. Không có ảnh terminal mới trong tệp đính kèm; bố cục và bảng màu mô tả trong yêu cầu là tham chiếu chính.

## COMPONENTS TO KEEP

Giữ SettingsForm, bảng vị thế/đóng lệnh với xác nhận, phân trang lịch sử, RugCheckReport và bằng chứng, API helper, state/SSE, toast mô phỏng và điều khiển backend.

## COMPONENTS TO REDESIGN

Dashboard shell/header/navigation, bảng scanner, modal chi tiết, biểu đồ hiệu suất, thống kê, vị thế mô phỏng, settings, Rug/Jev/Risk, trạng thái sức khỏe và empty states. Chỉnh metadata cũ đang mô tả dữ liệu giả lập.

## COMPONENTS TO REMOVE

Khối Tổng quan trắng cũ, metric trùng, ObservationPanel dài và CSS đã hết dùng do thay layout. Không xóa dữ liệu, endpoint hoặc chức năng nghiệp vụ.

## NEW COMPONENTS

TerminalOverview, MetricCard, ActivityLog, SystemHealth, PerformanceChart và PositionDetail/DecisionPanels. Chỉ tạo component khi giúp tái sử dụng hoặc chia nhỏ trách nhiệm; không thêm thư viện đồ thị.

## MISSING DATA

Chưa có authoritative balance USD/available/reserved, dữ liệu vốn theo thời gian hoặc tỷ lệ sizing 10% đang hoạt động. Hiện quan sát 5 USD, không đổi sizing. Observation chưa có net P&L đã tính đủ phí nên đồ thị và tỷ lệ thắng dùng empty state; không trộn với analytics thực thi. Không tạo W/L hoặc sparkline giả, không vẽ đường ngang giả khi không có lịch sử. Không nội suy qua P&L chưa biết. Provider chưa có health riêng chỉ hiển thị bằng chứng/trạng thái nhận được với thời điểm, không suy diễn READY toàn cục.

## IMPLEMENTATION PLAN

1. Viết bản kiểm kê này trước khi sửa UI; dùng CSS và client component theo tài liệu Next đã cài.
2. Thay shell, token màu, typography, bố cục mật độ cao và header an toàn.
3. Kết nối metrics, chart bounded có khoảng thời gian/tooltip, vị thế và nhật ký thật.
4. Cải thiện scanner và trình bày riêng Risk quyết định cuối/Rug/Jev tư vấn; giữ UNKNOWN trung tính.
5. Hiển thị health chuỗi/hệ thống, ví công khai và số dư gốc khi đã đọc; không tự định giá USD.
6. Giữ menu chi tiết, điều khiển và API hiện tại; không sửa backend, env hoặc SQLite.
7. Chạy test/lint/typecheck/build, QA Chrome 1920×1080, 1440×900, 1366×768, tablet/mobile. Trường hợp chưa có thật dùng dữ liệu chỉ trong trang kiểm thử bị intercept; không ghi DB, không phát giao dịch.
8. Kiểm tra dữ liệu browser không lộ secrets, trình bày kết quả và giới hạn thật.
