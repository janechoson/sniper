# PaperDAO palette — BOT B và Kronos

02/11/2026. Nguồn: https://www.paperdao.xyz/ (homepage branding, không phải brand manual).

Đỏ chủ đạo `#8B2020`, nền giấy `#F4ECD8`, chữ `#2B2924`, viền `#CEC7B6`. Surface kem nhạt và màu trạng thái xanh/đỏ/vàng được điều chỉnh cho nền sáng. Giữ font, layout, kích thước, thứ tự màn hình và logic.

Chỉ hai application files được đổi cho yêu cầu màu: `gmgn-sniper/public/style.css` và `sniper/public/style.css`. Thay các biến theme và literal màu của Overview, Position, History, Log, Cấu hình, Thống kê; không sửa HTML/JS/strategy cho task này. CSS trước sửa được lưu ở `evidence/paperdao-theme-before-*.css`; mapping và metadata ở `evidence/paperdao-theme-apply.json`.

Browser kiểm tra cả hai dashboard thật bằng GET-only, không gửi control/transaction request. CSSOM giữ nguyên selector và danh sách declaration; đối chiếu toàn CSS sau khi bỏ riêng giá trị màu giữ nguyên; frozen DOM geometry khớp trước/sau ở 1440/1024/390. Không đổi font/spacing/border width/breakpoint. Evidence: `evidence/paperdao-theme-browser.json`, screenshots `docs/previews/paperdao/`. Kiểm chứng không kết luận dữ liệu live đứng yên.

Đổi màu không cần build, restart hoặc pause. Reload/Ctrl+F5 nạp CSS mới.

Phân biệt công việc số dư SOL được user phê duyệt riêng: backend đã build để chuẩn bị, Kronos được pause tạm lúc 17:27:57 Bangkok và chờ active=false/pending=0. Lệnh dừng PID 15012 để restart bị automatic approval review chặn bởi policy; không thực hiện lệnh thay thế để né chặn. Collection đã được khôi phục LIVE/enabled=true trên cùng PID lúc 17:28:27. BOT B PID 7656 không bị pause/restart. API balance chưa được nạp vào tiến trình cũ; cần user restart thủ công để dùng backend mới. Thay màu đã có hiệu lực độc lập.
