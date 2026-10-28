# Khởi động LIVE theo ủy quyền chủ ví

Người dùng đã yêu cầu bắt đầu tiền thật, giữ bot/scanner chạy và chỉ thực thi intent hợp lệ từ chiến lược. Cấu hình hiện DATA_MODE=real, TRADING_MODE=live, LIVE_TRADING_ACK=true, OBSERVATION_ONLY=false, OBSERVATION_AUTO_START=true, LIVE_DRY_RUN=false, REAL_CONFIG_PATH=config/live.json. Không đổi key/RPC URL, không reset/import SQL.

## Chain được kích hoạt

`execution.liveChains=["solana"]` là allowlist thực thi, khác với danh sách chain có thể khám phá. Mặc định schema là danh sách rỗng; không tự cấp quyền LIVE cho chain mới. Cả authority, executor dispatch, readiness và RPC transport kiểm tra phạm vi này. Chuyển chain ở UI không tự cấp quyền gửi giao dịch cho BNB/Robinhood.

- Solana: execution preflight mới đã qua native sizing10%, quote hai chiều, build, simulation và local signature. Chỉ được gửi khi candidate cụ thể qua mọi gate hiện hành.
- BNB: quote/build/simulation/signature preflight qua nhưng RPC hiện từ chối debug_traceTransaction bằng RPC_CODE_-32601. Native confirmation của implementation cần callTracer để xác minh actual spend/return; khóa thực thi trước khi gửi một BUY chưa đối soát được.
- Robinhood: reverse simulation vẫn lỗi TRANSFER_FROM_FAILED; RPC cũng chưa có callTracer. Khóa thực thi.

Không thêm giao dịch test/canary để minh họa. Giao dịch đầu tiên, nếu có, phải do pipeline bình thường tạo ApprovedTradeIntent, không phải operator tạo tay. Trước startup đã đọc SQLite xác nhận namespace real-live chưa có lịch sử/vị thế giao dịch thật cần phục hồi; không xóa dữ liệu.

## Startup và bảo vệ lệnh

Launcher hiện tôn trọng OBSERVATION_AUTO_START=true cho runtime REAL cả ngoài observation. Đây là cờ có sẵn của project, không tạo thêm nguồn cấu hình startup. Timers reconciliation, position monitor và exits khởi động như trước.

Giữ sizing10% vốn khả dụng sau dự phòng phí và pending execution; không cố định USD, không giảm phần trăm, không đổi cap/score/slippage. Giữ knownBadFunding informational-only. Các bước xác minh quote, risk cuối, simulation, idempotency, hash trước/submission, receipt/native/token delta và confirmed-only position vẫn giữ.

Thêm entry kill tự động khi executor trả UNKNOWN/PENDING/SUBMITTING mơ hồ; nonce/receipt/balance error hoặc ngưỡng failures hiện hành; reconciliation không xác định được trạng thái; đường SELL của vị thế LIVE không khả dụng. Lý do được lưu cùng real.control, hiện trong snapshot killSwitch và activity. Kill này chặn entry; không tắt monitor hoặc quyền tạo intent SELL bảo vệ. Không tự resend giao dịch mơ hồ.

## Discovery hiện hành

Runtime LIVE đầu tiên phát hiện SOLANA_DISCOVERY_GAP_REQUIRES_BACKFILL ở cửa sổ strict100 signatures. Bản sửa cho phép xử lý initialization hint WS đã xác minh transaction ngay cả khi có history gap; cursor strict không bị reset/nhảy qua lịch sử, coverage vẫn incomplete và readiness vẫn fail closed. Không dùng bounded sampling làm bằng chứng có đầy đủ swap volume/momentum.

Do đó mode LIVE + ACK=true + scanner running=true không đồng nghĩa mọi candidate hoặc mọi chain READY. Nếu coverage/rug chưa đạt, liveEnabled có thể false và không có giao dịch. Bot vẫn quét và lưu lý do thật, không thay mock, không hạ policy để có BUY.

## Kiểm chứng và vận hành

Preflight trước activation: pnpm verify:live, preflight Solana và BNB, kiểm tra callTracer chỉ đọc một giao dịch công khai đã có. Không phát giao dịch trong các phép thử này. Tests bổ sung xác minh allowlist và entry kill khi state mơ hồ, SELL intent vẫn được phép; regression discovery giữ gap/coverage fail closed.

Snapshot vận hành được ghi ở data/live-start-runtime.json, kiểm tra trước activation tại data/live-activation-checks.json. Chỉ chứa trạng thái, lý do và số đếm; không có wallet/API secrets hoặc URL chứa credentials. Các số đếm là checkpoint, không phải trạng thái cố định.

Dashboard: http://127.0.0.1:3000. Dừng entry bằng kill switch; monitor/exits còn hoạt động. All-trading halt là thao tác khác, không dùng thay entry kill nếu muốn giữ đường thoát.

## Checkpoint cuối

332 tests pass,4 optional network tests skip; lint/typecheck/build pass. Runtime đã xác nhận LIVE/ACK=true/scanner RUNNING trên Solana. Execution0, vị thế mở0 tại checkpoint; entry readiness vẫn false vì discovery gap và mandatory security coverage. Scanner đã nhận token RPC thật; cursor gap không bị che hoặc reset. Xem data/live-start-runtime.json cho số đếm và quyết định mới nhất. Bot được giữ chạy sau tác vụ.
