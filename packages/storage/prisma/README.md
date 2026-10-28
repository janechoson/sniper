# Lưu trữ PostgreSQL cũ

Schema và SQL migrations ở thư mục này được giữ để xuất hoặc đối chiếu dữ liệu cũ. Runtime hiện dùng SQLite tại `../sqlite`, không khởi động PostgreSQL/Docker và không áp các migration này tự động. Không có database cũ nào bị xóa. Xem `docs/local-migration.md` để chuyển journal sang SQLite.
