# ADR 007: Xử lý cảnh báo phụ thuộc

Đã chấp nhận. Dùng Zod 4.6.7 thay cho 3.x và ghi đè Effect/DeepmergeTS của Prisma CLI bằng bản đã vá thông qua pnpm. File khóa phiên bản là nguồn tham chiếu chính. Sau khi đổi các ghi đè này, chạy lại tạo mã Prisma, kiểm tra lược đồ, TypeScript, kiểm thử và dựng ứng dụng.

Không ép stream-json 3.x dạng ESM không tương thích vào API CommonJS của Jayson chỉ để ẩn cảnh báo. Theo dõi các cảnh báo Solana mức trung bình trong security.md và đánh giá lại trước khi bật dữ liệu RPC hoặc giao dịch thật.

Cập nhật 27/10/2026: Anchor dùng TOML 5.0.1 qua override. bigint-buffer chưa có bản upstream sửa native overflow; patch pnpm loại bỏ nạp native addon, dùng nhánh BigInt JavaScript. Kiểm thử xác nhận bản SPL thực sự dùng patch và chuyển đổi buffer dài/u128 đúng. Audit còn 1 high đã giảm thiểu cùng 4 moderate; không được bỏ patch hoặc tuyên bố audit sạch.
