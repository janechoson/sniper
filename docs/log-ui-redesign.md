# Log UI — hoàn tất 2026-11-01

Chỉ làm màn Log; Thống kê tạm bỏ qua theo yêu cầu. Các thay đổi giao diện nằm trong `public/index.html`, `public/app.js`, `public/style.css`. Không thay đổi backend, API, logic giao dịch hay `.env`.

## Giao diện và hành vi

Bảng Thời gian / Loại / Token / Thông tin & Chi tiết / Kết quả; badge theo loại và kết quả thực tế; tìm kiếm tên, symbol, mint, reason, event; bộ lọc loại và khoảng thời gian. Mỗi dòng mở được metadata và JSON gốc, copy mint/JSON. Tạm dừng chỉ đóng băng hiển thị, tiếp tục nhận dữ liệu; tiếp tục sẽ cập nhật các log mới. Xóa chỉ xóa buffer trình duyệt, không gọi API xóa. Xuất JSON chứa toàn bộ log đang lọc trong buffer, không chỉ trang hiện tại.

## Dữ liệu và giới hạn

Nguồn giữ nguyên: status events, SSE overview attempt logs, SSE flow events; metadata token lấy từ các dữ liệu tokens/positions/history/overview ứng dụng đã tải. Không thêm request hoặc provider. Không có metadata thì hiển thị Unknown Token và mint. Logo chỉ dùng URL cùng origin phù hợp CSP; thiếu logo dùng chữ viết tắt. UNKNOWN không được chuyển thành PASS; JEV BUY không được xem là giao dịch BOUGHT.

Buffer tối đa 800 log, mỗi trang 40 dòng, row cache tối đa 100. Số lượng và khoảng thời gian chỉ áp dụng cho log đã tải trong phiên trình duyệt; không tuyên bố đây là toàn bộ lịch sử DB. Các nguồn khác nhau được giữ riêng; cùng batch được dedup theo khóa sự kiện/attempt. Refresh trang sẽ tạo lại buffer từ dữ liệu backend còn cung cấp.

## Kiểm tra

- `pnpm lint`: PASS.
- `pnpm typecheck`: PASS.
- `pnpm build`: PASS trong thư mục staging ở TEMP, không xóa/ghi dist của tiến trình đang chạy.
- `pnpm exec node scripts/log-ui-test.mjs`: PASS. Browser fixture kiểm tra metadata, UNKNOWN/REJECT, dedup, search, type/range, raw JSON/export, pause/resume, pagination, giới hạn buffer, clear, desktop/mobile. Đây là kiểm thử component với payload mô phỏng; không phải chứng nhận dữ liệu production.
- Không start/restart/kill LIVE, không gửi BUY/SELL/transaction. Không có server hay DB trong browser fixture.

Ảnh dùng dữ liệu fixture: [Desktop](previews/log-desktop.png), [Mobile](previews/log-mobile.png).

Có thể mở tab Log và Ctrl+F5 để tải assets mới; không cần restart bot.
