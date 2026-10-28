> Cập nhật local 27/10/2026: runtime hiện dùng một Node process + SQLite + ví cố định. Phần PostgreSQL/lease hoặc nhiều ví bên dưới là lịch sử trước refactor; không dùng để khởi động. Hướng dẫn hiện hành: [kiến trúc và migration local](../local-migration.md), [Rug Check](../rug-check.md).

# ADR 006: Nhật ký nguyên tử và bảng có chỉ mục

Đã chấp nhận. Bot lưu token được phân tích và vị thế mới trong một bản ghi bền vững. Mỗi đợt theo dõi lưu giá, thoát lệnh và sự kiện báo giá cùng nhau. Chỉ công bố trạng thái sau khi lưu thành công. Khôi phục kiểm tra lược đồ và từ chối bản ghi hỏng.

PostgreSQL lưu nhật ký chính cùng các bảng có chỉ mục trong giao dịch Prisma: quan sát, đặc trưng, bảo mật, AI, quyết định chiến lược/rủi ro, báo giá, lệnh mô phỏng, vị thế/sự kiện, giá thị trường, lần chạy chiến lược và kết quả. Dữ liệu chi tiết dùng JSON có thể quản lý phiên bản với các cột truy vấn có kiểu. Order và Transaction dành cho thực thi tiền thật đã kiểm toán trong tương lai. Chế độ file lưu cùng dạng nhật ký và dựng lại dữ liệu bằng cách đọc lại, không có bảng SQL.

Khóa tiến trình bảo vệ chế độ file. Quyền vận hành PostgreSQL có gia hạn ngăn nhiều bot xử lý cùng danh mục; mất quyền hoặc hết hạn thì chặn an toàn. Sau khi tắt đột ngột có thể phải đợi tối đa hai phút để quyền cũ hết hạn. Cơ chế này điều phối một bot, chưa phải thực thi phân tán hay bảo đảm thanh toán blockchain đúng một lần.
