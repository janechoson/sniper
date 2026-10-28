> Cập nhật chế độ quan sát dữ liệu thật: xem [biên bản mới](observation-status.md). Nội dung bên dưới là kết quả ở giai đoạn trước, không mô tả env/runtime hiện tại.

# Biên bản kiểm tra — 27/10/2026

Máy kiểm tra: Windows, Node20.19.3, pnpm10.28.2. Môi trường triển khai được hướng dẫn là Ubuntu với Node22 LTS+. Chưa chạy trên máy Ubuntu thật; không tuyên bố đã xác minh hệ điều hành đó.

## Các kiểm tra đã đạt

- pnpm install --frozen-lockfile, gồm postinstall sinh Prisma SQLite client. Trên Windows phải dừng bot trước khi generate để tránh khóa DLL.
- SQLite migrate deploy, db:validate, WAL/synchronous FULL, transaction rollback khi projection lỗi, duplicate ID, concurrent writes, secret persistence guard.
- Nhập 1.064 bản ghi data/journal.jsonl vào data/trading.db; thêm marker hash trong DB để không nhập lại. Journal nguồn giữ nguyên; namespace REAL/PAPER/LIVE/DRY_RUN tách biệt.
- pnpm db:backup đã tạo backups/trading-2026-10-27T04-40-49.250Z.db sau import; pnpm db:restore khôi phục sang data/local-restore-verification.db. Không kích hoạt file restore và không ghi đè DB hiện hành.
- Phục hồi vị thế đang mở, số lượng/giá vốn nguyên, apply fill idempotent, giữ UNKNOWN/hash sau mở lại SQLite. Giá float chỉ dùng mô phỏng được so sánh sai số nhỏ khi qua JSON SQLite; atomic amounts LIVE lưu string chính xác.
- Kiểm thử fixture EVM/Solana: exact approval/reset, nonce, alias wallet ID cũ/mới cùng hàng đợi, minimum output, gas/balance guards, receipt mismatch, hash trước send, mất phản hồi không resend, signer address binding.
- pnpm lint, pnpm typecheck, pnpm build và SQLite schema validation đạt. Bộ test đầy đủ trước hai kiểm thử bổ sung:147 đạt/4 bỏ qua; các kiểm thử bổ sung kiểm tra WS rỗng và API key placeholder được chạy cùng đợt cuối.
- Chrome MOCK/PAPER: SSE, quét giả lập, chuyển chuỗi/chiến lược, chi tiết token, lưu settings, lịch sử, ngắt khẩn cấp, desktop/mobile. Ảnh data/dashboard-desktop.png và data/dashboard-mobile.png nếu script tạo theo tên hiện hành.
- Chrome REAL/PAPER chưa cấu hình: ví cố định, readiness/UNKNOWN, analytics, xác nhận dừng toàn bộ, mobile; không ký/broadcast.
- REAL/LIVE_DRY_RUN khởi động + UI: source RPC, liveEnabled=false, readiness=false, executions=0. WS tùy chọn DEGRADED. Đây là kiểm tra startup/chặn an toàn, không phải DRY_RUN_SUCCEEDED trên giao dịch thật.
- pnpm start với .env riêng đã mở http://127.0.0.1:3000, source RPC/PAPER, SQLite healthy, không tự quét, không có execution/vị thế REAL. Mock history vẫn giữ riêng trong DB.

## Kiểm tra mạng chỉ đọc

BNB/Robinhood identity/deployment/Pancake V2 quotes đã xác minh trước refactor; báo cáo giữ trong data. Rug Check mới đã đọc BNB CAKE pool và Solana USDC bằng RPC/public security endpoints: data/rug-bnb-pool-current.json và data/rug-solana-public-current.json. BNB có on-chain6 findings, reserves3, GoPlus17, Honeypot6; có disagreement/risk từ nguồn ngoài, quyết định REJECT. Solana có on-chain15 findings và RugCheck2; holder RPC timeout nên UNKNOWN, sellability thiếu nên REJECT. Quyền freeze còn hoạt động không bị gán thành token đã frozen. Robinhood WETH pool có báo cáo data/rug-robinhood-pool.json; GoPlus support được kiểm tra động, Honeypot UNSUPPORTED.

Không có BUY→SELL simulation production/Jev call thật trong các verifier này. Không có private key, tiền hoặc broadcast thật trong kiểm thử. File network tùy chọn vẫn bỏ qua mặc định; các lần verify:rug nói trên là thao tác chỉ đọc riêng.

## Điều kiện còn thiếu

Node hiện tại20 không đáp ứng SDK REAL>=22. TYPESAFE_API_KEY/JUPITER_API_KEY chưa có giá trị hợp lệ; placeholder đã làm trống, không thay khóa thật. Ví signer chưa cấu hình. Cần cấu hình REAL_CONFIG_PATH/deployment/feed USD/gas/program allowlists và bằng chứng bắt buộc theo chain. EVM holder adjusted/deployer/LP locker/funding clusters còn thiếu coverage, giữ UNKNOWN. Public RPC có giới hạn/rate-limit/timeout.

LIVE: CHƯA SẴN SÀNG. Chưa chạy full REAL/PAPER entry có Jev, full production dry-run hoặc real-fund canary. Không có tuyên bố token an toàn hay cam kết lợi nhuận. Audit thư viện trước đó còn bigint-buffer đã giảm thiểu bằng patch và cảnh báo phụ thuộc; xem security.md, không coi audit là sạch.
