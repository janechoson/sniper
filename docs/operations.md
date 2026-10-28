> Cập nhật local 27/10/2026: runtime hiện dùng một Node process + SQLite + ví cố định. Phần PostgreSQL/lease hoặc nhiều ví bên dưới là lịch sử trước refactor; không dùng để khởi động. Hướng dẫn hiện hành: [kiến trúc và migration local](local-migration.md), [Rug Check](rug-check.md).

# Vận hành cục bộ

Node22+ được khuyến nghị cho toàn dự án và bắt buộc REAL/Jev. pnpm install; pnpm db:generate; pnpm dev. Default MOCK/PAPER không cần key. Không ghi đè .env đang dùng. Bot bind 127.0.0.1:4100, web localhost:3000; proxy API/SSE từ phía server.

PostgreSQL tùy chọn: mở Docker Desktop, docker compose up -d, đặt STORAGE_DRIVER=postgres và DATABASE_URL, pnpm db:migrate. Migration production có tại packages/storage/prisma/migrations/202610270001_production_runtime. Chưa xác minh apply trên database trong lần này. DB lỗi chặn entry, không fallback memory.

Một bot trên data directory; worker.lock chứa PID, startup từ chối worker khác, stale PID đã chết mới giải phóng. Khi dừng chờ queue/exit jobs, fsync và close. Không xóa lock của tiến trình đang sống. Khởi động lỗi cấu hình sẽ giải phóng lock của chính tiến trình.

Chạy pnpm verify:solana|verify:bnb|verify:robinhood --public-rpc --save data/ten-bao-cao.json để kiểm tra chỉ đọc. pnpm verify:wallets không chuyển tiền; pnpm verify:quotes cần chain/input/output/amount/decimals theo hướng dẫn CLI. pnpm reference:config chỉ ghi file tham khảo, không bật LIVE.

History REAL phân trang toàn bộ journal: PostgreSQL lọc kind/namespace, thứ tự sequence và count trong snapshot nhất quán; JSONL quét file cố định hai lượt, bộ nhớ theo kích thước trang. Cần retention/rotation cho chạy dài hạn, vì file paging vẫn tuyến tính. Dự án local chưa có xác thực công khai/HA/multiworker chiến lược.
