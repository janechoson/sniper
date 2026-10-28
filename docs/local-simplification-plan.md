# Kế hoạch đơn giản hóa local — 27/10/2026

## CURRENT ARCHITECTURE

Monorepo có các module trading trong một bot Node và UI Next.js riêng, API nội bộ4100 → web3000. Mặc định journal JSONL, tùy chọn PostgreSQL/Prisma với lease database. Docker Compose chỉ chạy PostgreSQL; không có Redis, SaaS user/RBAC/tenant, Kubernetes hoặc cloud signer. Treg là công cụ của Codex ngoài runtime dự án, không phải hệ thống team của bot.

## WHAT IS REQUIRED / KEEP

Giữ multi-chain/DEX/swap, Rug Check đa nguồn vừa bổ sung, UNKNOWN, Jev advisory, deterministic Risk/intent, BUY→SELL simulation, exact approval, nonce locks, idempotency, pending receipt reconciliation, positions/exit/kill và UI tiếng Việt nền trắng. Giữ interface tiêm dependency phục vụ kiểm thử; không di chuyển toàn bộ packages.

## WHAT IS OVERENGINEERED / SIMPLIFY

PostgreSQL server và distributed database lease không cần cho một máy/một instance. Wallet JSON registry/selection không cần cho một danh tính EVM+Solana cố định. Hai cổng/process phục vụ cùng một ứng dụng có thể gộp bằng custom local Next server. Không cần giữ dashboard quản lý ví.

## REMOVE

Bỏ yêu cầu PostgreSQL/Docker, runtime PostgresRepository/lease và wallet table, UI chọn ví/activeWalletByChain, các scripts chỉ dành hạ tầng đã thay. Không xóa dữ liệu PostgreSQL hoặc nhật ký thật. Redis/cloud auth/KMS không tồn tại nên không ghi là đã loại bỏ. Prisma vẫn dùng cho SQLite và schema migrations; không xóa dependency còn dùng.

## DATABASE MIGRATION PLAN

SQLite `data/trading.db`, WAL, synchronous FULL, busy timeout/bounded retry, một writer bằng mutex trong process. Giữ journal append-only và projections trong cùng transaction. Copy schema/migrations PostgreSQL vào vùng legacy trước khi đổi provider; giữ đường export/import journal, không kết nối/xóa database cũ tự động. Import JSONL phải xác thực toàn bộ trước, giữ ID/namespace, idempotent và không sửa file nguồn. Backup bằng SQLite-consistent snapshot, không copy file DB đang ghi rồi bỏ WAL. Restore chỉ khi ứng dụng đã dừng, không ghi đè DB đang dùng tự động.

## WALLET SIMPLIFICATION PLAN

`TradingWallet` đọc EVM_PRIVATE_KEY/SOLANA_PRIVATE_KEY hoặc public address chỉ xem từ backend. Hai signer là khác họ mật mã nhưng UI chỉ có một danh tính giao dịch. Không private-key input trên web, không keys trong SQLite/log/AI. Giữ walletId nội bộ trong intent/position như khóa tương thích lịch sử và ràng buộc địa chỉ đã ký; không còn routing/CRUD theo người dùng. Intent cũ thiếu bằng chứng địa chỉ vẫn fail closed.

## RISKS

SQLite cần migration riêng vì sequence/autoincrement/transaction isolation khác PostgreSQL. Không bỏ nonce queue, raw integer, fsync/transaction atomicity hay unknown reservation khi đơn giản hóa. UI trực tiếp cùng port phải giữ Host/Origin checks chống yêu cầu từ trang ngoài. WS tùy chọn: polling có trạng thái suy giảm; chiến lược cần subscription latency vẫn chặn LIVE khi thiếu WS. Không phát giao dịch thật khi kiểm tra.

## IMPLEMENTATION ORDER

1. Lưu schema/migration legacy và thêm SQLite repository/migrations/backup/import.
2. Ví cố định và bỏ selection/routing UI, giữ address binding.
3. Một process phục vụ bot/API/Next local3000; startup health thực tế và graceful shutdown.
4. Bổ sung kiểm tra vốn/reservation, polling policy, khôi phục và kiểm thử SQLite/nonce/secrets.
5. Cập nhật README/config/docs, kiểm tra PAPER/dry-run/UI/build và báo cáo mức sẵn sàng thật.
