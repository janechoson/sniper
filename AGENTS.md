# Workspace rules

- Sau mỗi tác vụ, xóa ảnh/screenshot test, raw evidence JSON/log, DB fixture, replay output, cache và build tạm do tác vụ tạo. Không giữ các artifact này trong project khi đã kiểm chứng xong; không tạo thêm evidence dump để báo việc cleanup.
- Giữ source tests, deterministic input fixtures cần để chạy regression, tài liệu hướng dẫn và báo cáo ngắn bằng Markdown. Market replay data cũ không phải dataset cần giữ mặc định.
- Trước khi xóa, xác minh absolute paths nằm trong đúng project hoặc thư mục temp do chính tác vụ tạo. Không xóa production SQLite/WAL/SHM/lock, runtime đang dùng, credentials, model weights hoặc backups thật khi chỉ được yêu cầu dọn test artifacts.
- Không restart hoặc pause BOT để dọn file hay sửa UI. Nếu file đang được tiến trình dùng, giữ file và báo rõ.
