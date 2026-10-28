# Bàn giao: từ quan sát sang giao dịch thật

Quyết định trực tiếp của người dùng ngày27/10/2026:

> Cứ tạm hard code là5USD, nhưng cần lưu lại để sau khi người dùng yêu cầu mọi thứ chạy thật thì đổi thành10% tài khoản hiện tại.

Hiện tại: người dùng đã ủy quyền LIVE; xem live-start-20261028.md. DATA_MODE=real, TRADING_MODE=live, LIVE_TRADING_ACK=true, OBSERVATION_ONLY=false, OBSERVATION_AUTO_START=true. Chỉ Solana được cấu hình LIVE; scanner/timers giữ chạy, không tạo giao dịch demo.

Ngân sách5USD là ngoại lệ của chế độ quan sát cũ. Sizing production đã triển khai mặc định10% số dư khả dụng của tài sản đầu vào, dùng bigint, đọc lại balance trước duyệt intent; cap gây REJECT thay vì giảm phần trăm. Mọi entry được tuần tự hóa; bất kỳ execution đang pending đều chặn entry mới. Có pending guard nhưng chưa có phân bổ reservation để cho phép nhiều entry đồng thời. Đường native SOL/Jupiter và EVM V2 payable đã bổ sung; chưa định giá toàn bộ danh mục ví. Xem live-dry-run-report-20261028.md để phân biệt execution preflight với strategy/LIVE readiness. Nhập khóa ví không tự kích hoạt giao dịch.

Checklist khi hoàn thiện giao dịch thật (một phần đã triển khai, không phải chứng nhận READY):

1. Đọc lại tệp này và yêu cầu mới; chuyển sizing production từ tradeSizeUsd cố định sang positionSizePercent default10, validate0<percent<=100, lưu bằng settings hiện có. Loại UI/default50USD và không mang5USD vào LIVE.
2. Tính từ số dư ví THỰC ở thời điểm phê duyệt, không phải vốn ban đầu. available = raw balance − gas/native/account reserves − pending/reserved entry capital. Dùng bigint/base units.
3. Trong commits SerialQueue/capital mutex: đọc balance mới, trừ reservations; quote/simulation/price impact/risk tương ứng đúng amount; kiểm tra lại nếu amount thay đổi, persist reserve+intent atomically. Giữ revision/generation/idempotency/nonce/pending guards.
4. Gas reserve dựa chain/ước lượng thật cho approvals/BUY/SELL/emergency exit; Solana SOL/account costs. Không lấy một reserve USD universal.
5. Không silently clamp10% theo maxTradeUsd100/maxTokenExposure100/maxPortfolioExposure500/maxChainExposure250. Nếu xung đột phải REJECT và chỉ rõ cap. maxPositions8, maxTradesPerDay30, maxDailyLoss200 vẫn giữ nếu chưa được thay đổi. Không thêm daily USD spending cap.
6. Giữ slippage100bps, price impact2%, round-trip loss5%; không giảm10% xuống8/5/2% để ép trade. UNKNOWN/NOT_SELLABLE phải reject. Executor dùng đúng ApprovedTradeIntent.amountIn.
7. Quan sát hiện đọc EVM latest-state non-atomic để dùng RPC công khai; giao dịch thật phải dùng strict block-consistent analysis như đường production mặc định. Không coi quote-only virtual execution hoặc reference cross-chain USD là bằng chứng sellability. Xác minh đầy đủ config, feed, provider coverage, wallet, simulation và Rug/legacy hard filters trước khi bật LIVE.
8. Thử PAPER dynamic1000→100→90→81;100→10;10000→1000; reserve100 trên1000→90; concurrent capital, stale quote reapproval, impact/loss/sellability/UNKNOWN và executor immutable amount. Chạy test/lint/typecheck/build.

Chính sách hiện tại: creator.knownBadFunding chỉ để nghiên cứu, mọi giá trị true/false/UNKNOWN đều không phải chốt giao dịch hoặc tự thoát. Không cần chọn provider funding để duyệt lệnh. Các cờ bảo mật EVM, overallRisk, taxes, khả năng bán và bằng chứng thanh khoản vẫn phải xác minh; Solana giữ kiểm tra mint/freeze đúng chain. Xem [audit funding](funding-informational-20261028.md). Không gán UNKNOWN thành false/0/SAFE.

Lịch sử trước quan sát đã backup và reset SQLite; IMPORT_LEGACY_JOURNAL=false. Chi tiết backup tại data/last-observation-reset.json. Không tự nhập lại journal cũ khi khởi động.

Solana observation reader đã opt-in maxSupportedTransactionVersion=1 theo tài liệu chính thức, đọc compiled RPC JSON và lưu version. Việc đọc v1 không có nghĩa signer/executor web3.js hiện tại ký được v1; phải xác minh riêng khi triển khai giao dịch thật. Nguồn: https://solana.com/docs/core/transactions/versioned-transactions .
