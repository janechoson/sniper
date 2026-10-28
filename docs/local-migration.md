# Chạy trên một máy local

## Trước và sau

Trước: web Next3000 → proxy → bot/API4100; journal hoặc PostgreSQL server với lease; registry ví JSON và lựa chọn theo chain. Docker Compose chỉ phục vụ PostgreSQL.

Sau: một Node process phục vụ dashboard/API/bot ở 127.0.0.1:3000 → SQLite WAL. Một TradingWallet với signer EVM cho BNB/Robinhood và signer Solana. Các module discovery, market, Rug Check, Jev, RiskEngine, routing, executor, positions và exits được giữ.

Đã bỏ Docker Compose, PostgresRepository/lease đang chạy, tables wallet trong schema SQLite, UI chọn ví, activeWalletByChain và dependency concurrently (18 packages trong cây dependency không còn cần). Prisma vẫn dùng cho SQLite. Redis, cloud SDK, auth/RBAC/tenant không có trong dự án trước đó; không có hạng mục loại bỏ giả định. Treg nằm ngoài runtime bot.

## Lưu trữ và migration

Schema đang dùng: packages/storage/sqlite/schema.prisma; migration SQLite riêng. SQLite mặc định data/trading.db, có WAL, synchronous FULL, busy_timeout=5000ms, retry tối đa 3 lần và một writer mutex trong process. PID lock ngăn hai bot cùng DATA_DIRECTORY. Không có database/distributed lease. Đây không phải thiết kế HA hoặc network filesystem.

Nhật ký và projection cùng transaction; duplicate ID không tạo fill mới. Intent/execution dùng idempotency key; UNKNOWN/PENDING giữ gate vốn và đối soát read-only. Lỗi DB chặn giao dịch; không fallback memory. Đọc lại journal để phục hồi hiện vẫn theo số bản ghi; bảng chỉ mục phục vụ history/projections, chưa có compaction/checkpoint journal.

Khởi động nhập idempotent các journal trong DATA_DIRECTORY và real-paper/real-live-dry-run/real-live. Giữ ID/namespace/file nguồn; giới hạn 64MB mỗi file. Xác thực shape/secret trước khi ghi, projection được xác thực trong từng transaction. Nếu một projection lỗi ở giữa, các entry trước đó có thể đã nhập; sửa nguyên nhân rồi nhập lại theo ID. Không xóa nguồn hoặc dùng database mới để bỏ qua intent cũ.

Schema/migrations PostgreSQL cũ giữ tại packages/storage/prisma như lịch sử. Không tự kết nối, xóa hay chuyển database PostgreSQL của người dùng. Nếu trước đây dùng PostgreSQL, dừng bot cũ, tạo pg_dump và export bảng JournalEntry theo sequence thành JSONL có id,kind,chainId,tokenAddress,payload,createdAt (timestamp milliseconds). Bỏ các trường optional null. Dùng pnpm db:migrate rồi pnpm db:import --file BAN_XUAT.jsonl. Đối chiếu số dòng, ID, vị thế và transaction hash trước khi bật LIVE. Lease và wallet registry cũ không nhập làm cấu hình chạy.

## Sao lưu và khôi phục

pnpm db:backup tạo file mới trong backups bằng SQLite VACUUM INTO, snapshot nhất quán gồm WAL đã commit; không sao chép riêng DB đang ghi. Không ghi đè backup có sẵn. File backup chứa lịch sử giao dịch/địa chỉ công khai, không chứa private key. Sao lưu .env riêng theo cách bảo mật của máy, không đưa vào Git.

pnpm db:restore --from backups/FILE.db --to data/restored.db tạo snapshot mới từ bản sao lưu, từ chối file đích tồn tại hoặc đường dẫn active DB. Dừng bot, đổi SQLITE_PATH, khởi động. Giữ nguyên DB cũ. Bản backup có thể cũ hơn blockchain: kiểm tra receipt/hash/vị thế phát sinh sau thời điểm backup trước khi cho phép entry LIVE; không tự gửi lại giao dịch UNKNOWN. Restore không đảo ngược blockchain.

## Vốn, khóa và mạng

Một danh tính giao dịch; EVM_PRIVATE_KEY và SOLANA_PRIVATE_KEY chỉ backend. Public address tùy chọn cho watch-only. Không dùng wallet JSON hoặc settings để đổi người ký. walletId trong intent/vị thế cũ được giữ làm khóa nội bộ; địa chỉ intent vẫn phải khớp người ký, nên đổi khóa không cấp quyền cho intent cũ.

Intent APPROVED được lưu trước side effect; global pending gate giữ vốn khi transaction chưa rõ hoặc fill chưa apply. Kiểm tra số dư quote token và dự phòng native trước khi approve entry; EVM dự phòng hai lần maxGasWei cho swap + approvals, Solana dùng native debit cap + fee cap. Không tự wrap SOL: WSOL phải có số dư token. Nonce lock, exact approval/zero-reset, simulation và kiểm tra số dư thực thi vẫn bắt buộc.

Không cần WS để chạy HTTP polling; trạng thái suy giảm được hiển thị. execution.requireWebsocketForLive=true chặn LIVE/dry-run khi thiếu WS. Polling không bảo đảm độ trễ như subscription. Host/Origin cùng cổng được xác thực; chỉ bind loopback, không có đăng nhập từ xa.

## Cấu hình

DATA_MODE=mock và AI_PROVIDER=mock chạy không key. REAL: TYPESAFE_API_KEY, JEV_MODEL, RPC HTTP, Solana genesis hash; JUPITER_API_KEY khi dùng Jupiter; REAL_CONFIG_PATH có deployment/feed USD/policy đã xác minh. Muốn ký cần khóa riêng đúng họ chuỗi; PAPER không cần. SQLITE_PATH, DATA_DIRECTORY và PORT tùy chọn. DATABASE_URL chỉ là biến nội bộ Prisma do script ghi đè, không phải một nguồn cấu hình SQLite thứ hai.

Ubuntu: Node22 LTS+, pnpm10.28.2; pnpm install, tạo .env từ mẫu nếu chưa có, chmod600 .env, pnpm dev. Bản release: pnpm build rồi pnpm start. Dùng Ctrl+C để đóng HTTP/SSE, ngừng monitor, đợi công việc đang chạy và đóng DB/khóa tiến trình.
