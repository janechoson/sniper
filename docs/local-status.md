# Trạng thái sau đơn giản hóa

## REMOVED

Docker Compose chỉ phục vụ PostgreSQL; PostgresRepository/database leases trong runtime; chọn ví/activeWalletByChain/UI registry; proxy API giữa hai cổng; dependency concurrently. Không xóa PG data, migrations hoặc journal. Redis/cloud/auth không từng tồn tại nên không ghi là đã loại bỏ.

## SIMPLIFIED

Trước: Next3000 → bot4100 → journal hoặc PostgreSQL + lease + ví JSON. Sau: một tiến trình ứng dụng Node trên127.0.0.1:3000 → SQLite WAL → một danh tính EVM/Solana. Cấu trúc module trading được giữ.

## PRESERVED

RPC/discovery/market/UNKNOWN, Rug Check, Jev advisory, score/risk, quotes/routes/sellability/round-trip, exact approval, nonce, idempotency, kill switch, vị thế/exits/recovery và analytics.

## DATABASE

SQLite data/trading.db, WAL/FULL, writer mutex/retry bounded, transaction journal+projections; nhập1.064 journal cũ, không sửa nguồn. Schema PG giữ để migration thủ công. Xem local-migration.md.

## WALLET

EVM_PRIVATE_KEY/SOLANA_PRIVATE_KEY backend, optional public addresses watch-only. Không web key input/CRUD/selection. Intent vẫn ràng buộc địa chỉ; ID lịch sử giữ nội bộ. Hàng đợi ký/nonce dùng cùng chain khi ID cũ/mới trỏ cùng ví.

## RUG CHECK

On-chain/external/internal/simulation tách provenance, UNKNOWN không SAFE, freshness/TTL/conflicts/policy. Có report/UI/monitoring/persistence. Coverage chi tiết và giới hạn tại rug-check.md.

## JEV

Official SDK typed questions, Zod normalize, model configurable, sanitize/usage/hash/latency. AI_FAILED/UNAVAILABLE chặn entry theo policy, không fallback mock trong REAL. Chưa gọi tài khoản thật.

## RISK ENGINE

Deterministic final gate; kiểm tra vốn quote token/native reserve trước approved intent; pending/UNKNOWN giữ gate vốn. Hard filters chạy trước AI; AI không bỏ qua kill hoặc tự chọn size.

## EXECUTION

Stateful BUY/SELL simulation, exact approval/zero-reset, gas/program/calldata/owner/ALT guards, durable hash, receipt/fill proofs. LIVE_DRY_RUN không broadcast/fill. Không gửi giao dịch tiền thật trong triển khai.

## POSITION MANAGEMENT

Lưu raw integer, cost basis, fees và áp fill một lần; phục hồi vị thế và UNKNOWN từ SQLite đã kiểm tra. Namespace không lẫn PAPER/MOCK/LIVE.

## EXIT ENGINE

Stop-loss/trailing/partial take-profit/time/liquidity/security monitoring giữ nguyên; exit qua executor bình thường. Entry kill vẫn cho bảo vệ vị thế, ALL_TRADING_DISABLED chặn cả exits đúng xác nhận.

## LOCAL UI

Tiếng Việt, nền trắng/bo tròn, loopback3000, cùng origin API/SSE. Host/Origin guards; ví public/status, evidence/readiness/analytics, không lộ khóa.

## ENVIRONMENT VARIABLES REQUIRED

MOCK/PAPER: không key. REAL: TYPESAFE_API_KEY, RPC HTTP/genesis, JUPITER_API_KEY nếu Jupiter, REAL_CONFIG_PATH với feed/policy/addresses đã xác minh; JEV_MODEL tùy chọn. Ký cần EVM_PRIVATE_KEY/SOLANA_PRIVATE_KEY đúng chain. SQLITE_PATH/PORT tùy chọn. WS tùy chọn trừ policy bắt buộc.

## HOW TO START

Node22 LTS+, pnpm10.28.2; pnpm install, tạo .env nếu chưa có, pnpm dev. Release: pnpm build rồi pnpm start. Không cần Docker. Xem README.

## HOW TO BACK UP

pnpm db:backup tạo snapshot mới gồm WAL bằng VACUUM INTO. Đã sao lưu cả dữ liệu sau import.

## HOW TO RESTORE

pnpm db:restore --from backups/FILE.db --to data/restored.db; từ chối ghi đè. Dừng bot, đổi SQLITE_PATH và khởi động lại; đối soát blockchain kể từ backup trước khi bật LIVE.

## PAPER MODE STATUS

MOCK/PAPER browser đạt. REAL/PAPER server/UI khởi động, các điều kiện thiếu chặn entry; chưa full entry production có Jev.

## LIVE_DRY_RUN STATUS

Startup/UI và fail-closed đạt, không execution/broadcast; fixtures mô phỏng thành công. Chưa chứng minh full production DRY_RUN_SUCCEEDED.

## LIVE READINESS

CHƯA SẴN SÀNG: Node20 hiện tại, thiếu API keys, signer, feed USD/config và coverage bắt buộc.

## KNOWN LIMITATIONS

Chưa kiểm tra Ubuntu thật, Jev thật/full trading dry-run thật. Public RPC có timeout/rate-limit. Không full-chain holder scan/funding indexer/locker/deployer proof tổng quát. Coverage thiếu giữ UNKNOWN; một số policy cần chọn provider/nguồn thêm. Journal startup vẫn đọc toàn bộ lịch sử; cần checkpoint/compaction trước tăng dữ liệu lớn. Sao lưu cũ hơn blockchain cần đối soát thủ công. Đây là ứng dụng local một instance, không HA/SaaS.
