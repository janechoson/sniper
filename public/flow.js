/* Presentation only: machine values, API payloads and persisted records stay unchanged. */
window.BOTText = (() => {
  const phrases = {
    POSITION_PENDING_RECONCILIATION_OR_EXECUTION:
      "Vị thế đang có giao dịch chờ thực thi hoặc đối soát; chưa thể xóa.",
    POSITION_NOT_FOUND: "Không tìm thấy vị thế.",
    STRUCTURE_WATCH_NOT_FOUND: "Không tìm thấy lượt theo dõi.",
    USER_REMOVED: "Đã bỏ theo dõi",
    MANUALLY_REMOVED: "Đã ngừng quản lý",
    USER_MANUAL: "Thao tác thủ công",
    TP_DETECTED: "ĐÃ CHẠM MỐC CHỐT LỜI",
    "TP DETECTED": "ĐÃ CHẠM MỐC CHỐT LỜI",
    EXIT_DETECTED: "ĐÃ PHÁT HIỆN ĐIỀU KIỆN THOÁT",
    "EXIT DETECTED": "ĐÃ PHÁT HIỆN ĐIỀU KIỆN THOÁT",
    "EXIT RETRY": "THỬ LẠI THOÁT LỆNH",
    "SELL CONFIRMED": "BÁN ĐÃ XÁC NHẬN",
    "POSITION ATTENTION": "VỊ THẾ CẦN CHÚ Ý",
    "Fresh validation started; monitoring continues":
      "Bắt đầu kiểm tra mới; vẫn tiếp tục theo dõi",
    "detected; exit queued; monitoring continues":
      "đã chạm; lệnh thoát được lưu; vẫn tiếp tục theo dõi",
    "exit queued": "lệnh thoát được lưu",
    reconciled: "đã đối soát",
    "Deep check": "Kiểm tra chuyên sâu",
    "Pre buy": "Trước khi mua",
    "Pre sell": "Trước khi bán",
    Qualification: "Đánh giá điều kiện",
    "Stop loss": "Cắt lỗ",
    "Awaiting valuation": "Đang chờ định giá",
    Priority: "Ưu tiên",
    "Priority not supplied": "Chưa có mức ưu tiên",
    "admitted from": "được tiếp nhận từ",
    SCANNER: "BỘ QUÉT",
    discovery: "phát hiện",
    security: "bảo mật",
    "Open token details": "Xem chi tiết token",
    MC: "Vốn hóa",
    Vol: "Khối lượng",
    Completed: "Đã hoàn tất",
    "Cannot BUY": "Không thể mua",
    "BUY confirmed": "Đã xác nhận mua",
    "Jev analyzed; awaiting risk decision":
      "Jev đã phân tích; chờ kiểm tra rủi ro",
    "Analyzing candidate": "Đang phân tích ứng viên",
    "Candidate rejected": "Ứng viên bị loại",
    "CANDIDATE QUEUED": "ỨNG VIÊN VÀO HÀNG ĐỢI",
    "CANDIDATE REJECTED": "ỨNG VIÊN BỊ LOẠI",
    "CANDIDATE QUALIFIED": "ỨNG VIÊN ĐỦ ĐIỀU KIỆN",
    "CANDIDATE DEFERRED": "ỨNG VIÊN TẠM HOÃN",
    "CANDIDATE WATCH": "ỨNG VIÊN THEO DÕI",
    "CANDIDATE RECOVERED": "ỨNG VIÊN ĐÃ PHỤC HỒI",
    "JEV STARTED": "JEV BẮT ĐẦU PHÂN TÍCH",
    "JEV COMPLETED": "JEV PHÂN TÍCH XONG",
    "JEV BUY": "JEV ĐỀ XUẤT MUA",
    "JEV SKIP": "JEV BỎ QUA",
    "RISK REJECT": "RỦI RO KHÔNG ĐẠT",
    "TOKEN DEFERRED": "TOKEN TẠM HOÃN",
    "TOKEN REJECTED": "TOKEN BỊ LOẠI",
    "POSITION ISSUE": "VỊ THẾ CÓ VẤN ĐỀ",
    "POSITION RECOVERED": "VỊ THẾ ĐÃ PHỤC HỒI",
    "EXIT SIGNAL": "TÍN HIỆU THOÁT LỆNH",
    TRADE: "GIAO DỊCH",
    ERROR: "LỖI",
    ANALYZE: "PHÂN TÍCH",
    JEV_ANALYZING: "JEV ĐANG PHÂN TÍCH",
    EXECUTION: "THỰC HIỆN GIAO DỊCH",
    "Fresh deep checks passed; Jev and Risk still required":
      "Đã qua kiểm tra chuyên sâu mới; vẫn cần Jev và kiểm tra rủi ro",
    "GMGN reports no usable liquidity":
      "GMGN không ghi nhận thanh khoản có thể sử dụng",
    "Watch capacity exceeded; recent-reject cooldown":
      "Danh sách theo dõi đầy; cách ly tạm thời token bị loại",
    "Deferred capacity exceeded; recent-reject cooldown":
      "Danh sách tạm hoãn đầy; cách ly tạm thời token bị loại",
    "Watch TTL expired": "Đã hết thời hạn theo dõi",
    "Deferred TTL expired": "Đã hết thời hạn tạm hoãn",
    "Deferred recheck budget exhausted": "Đã hết số lần kiểm tra lại",
    "Waiting for fresh qualification": "Chờ đánh giá lại bằng dữ liệu mới",
    "Awaiting recheck": "Chờ kiểm tra lại",
    Recheck: "Kiểm tra lại",
    CURRENT_SECURITY: "BẢO MẬT HIỆN TẠI",
    CURRENT_MOMENTUM: "ĐỘNG LỰC GIÁ HIỆN TẠI",
    CURRENT_LIQUIDITY: "THANH KHOẢN HIỆN TẠI",
    CURRENT_HOLDERS: "CƠ CẤU NẮM GIỮ HIỆN TẠI",
    SKIP_RISK: "BỎ QUA DO RỦI RO",
    SKIP_MARKET: "BỎ QUA DO THỊ TRƯỜNG",
    SKIP_JEV: "JEV BỎ QUA",
    SKIP_RUG: "BỎ QUA DO RỦI RO RUG",
    SKIP_MISSING_CRITICAL_DATA: "THIẾU DỮ LIỆU QUAN TRỌNG",
    TOKEN_SIMULATION_FAILED: "MÔ PHỎNG GIAO DỊCH THẤT BẠI",
    TOKEN_SAFETY_FAILED: "KIỂM TRA AN TOÀN TOKEN KHÔNG ĐẠT",
    SIMULATED_BALANCE_MISMATCH: "SỐ DƯ MÔ PHỎNG KHÔNG KHỚP",
    TOKEN_DATA_INCOMPLETE: "DỮ LIỆU TOKEN CHƯA ĐẦY ĐỦ",
    TOKEN_NO_ROUTE: "CHƯA CÓ TUYẾN GIAO DỊCH",
    TOKEN_QUOTE_UNAVAILABLE: "CHƯA CÓ BÁO GIÁ",
    TEMPORARY_RISK_CHANGE: "ĐIỀU KIỆN RỦI RO TẠM THỜI THAY ĐỔI",
    SAMPLED: "CÓ DỮ LIỆU QUAN SÁT",
    EXIT_ONLY: "CHỈ CÓ DỮ LIỆU THOÁT LỆNH",
    POOR: "KÉM",
    GOOD: "TỐT",
    LIQUIDITY_COLLAPSE: "THANH KHOẢN SỤT GIẢM",
    STOP_LOSS: "CẮT LỖ",
    MAX_HOLDING: "HẾT THỜI GIAN GIỮ",
    TAKE_PROFIT: "CHỐT LỜI",
    TRAILING_PROFIT: "CHỐT LỜI BÁM ĐUÔI",
    MANUAL_EXIT: "THOÁT LỆNH THỦ CÔNG",
    age: "tuổi",
    MID: "TRUNG BÌNH",
    top10: "10 ví lớn nhất",
    buyRatio: "tỷ lệ mua",
    discovered: "được phát hiện",
    received: "đã nhận",
    true: "BẬT",
    false: "TẮT",
    "GMGN × JEV · Local Terminal": "K1ll of BOT · Bảng điều khiển",
    "PRIVATE SOLANA TERMINAL": "BẢNG GIAO DỊCH SOLANA RIÊNG",
    "LOCAL CONNECTION": "KẾT NỐI NỘI BỘ",
    "Single wallet": "Một ví giao dịch",
    "Private keys stay backend-only.": "Khóa riêng chỉ được lưu ở máy chủ.",
    "WORKSPACE / SOLANA MAINNET": "KHÔNG GIAN LÀM VIỆC / MẠNG CHÍNH SOLANA",
    "Token Flow Pipeline": "Luồng xử lý token",
    "Real-time discovery, qualification and execution monitoring":
      "Theo dõi quá trình quét, đánh giá và giao dịch theo thời gian thực",
    Dashboard: "Tổng quan",
    Scanner: "Bộ quét",
    Positions: "Vị thế",
    Watchlist: "Theo dõi",
    Deferred: "Tạm hoãn",
    History: "Lịch sử",
    Learning: "Học hỏi",
    Settings: "Cài đặt",
    "Scan now": "Quét ngay",
    "Connecting to the local trading engine…":
      "Đang kết nối với bộ máy giao dịch…",
    PORTFOLIO: "DANH MỤC",
    "ALL VALUES IN SOL": "TẤT CẢ GIÁ TRỊ TÍNH BẰNG SOL",
    "Wallet balance": "Số dư ví",
    "Available capital": "Vốn khả dụng",
    "Next entry": "Lệnh mua tiếp theo",
    "Recalculated before every approval": "Tính lại trước mỗi lần phê duyệt",
    "Realized PnL": "Lãi/lỗ đã chốt",
    "Win rate": "Tỷ lệ thắng",
    "Completed trades only": "Chỉ tính giao dịch đã hoàn tất",
    "CANDIDATE INTELLIGENCE": "PHÂN TÍCH TOKEN ỨNG VIÊN",
    "Follow the flow": "Theo dõi luồng xử lý",
    "01 / DISCOVERY": "01 / PHÁT HIỆN",
    "02 / DEEP CHECK": "02 / KIỂM TRA CHUYÊN SÂU",
    "03 / EXECUTION GATES": "03 / KIỂM DUYỆT GIAO DỊCH",
    "Token scanner": "Bộ quét token",
    "Waiting for discovery": "Đang chờ phát hiện token",
    "Cheap filter · rank · admit": "Lọc sơ bộ · xếp hạng · tiếp nhận",
    "Discovery keeps running when the queue is full. Only admitted candidates enter the scanner pipe.":
      "Bộ quét tiếp tục hoạt động khi hàng đợi đầy. Chỉ token được tiếp nhận mới vào luồng xử lý.",
    "Candidate queue": "Hàng đợi ứng viên",
    "Top candidates · live priority order":
      "Ứng viên tốt nhất · sắp xếp theo ưu tiên hiện tại",
    "Ten candidate slots": "Mười ô ứng viên",
    "Security · token program · holders · liquidity":
      "Bảo mật · chương trình token · người giữ · thanh khoản",
    "Slots remain occupied through qualification/approval.":
      "Token giữ ô trong suốt quá trình đánh giá và phê duyệt.",
    "Qualified → Execution": "Đủ điều kiện → Giao dịch",
    "Execution stages": "Các bước giao dịch",
    Qualified: "Đủ điều kiện",
    Risk: "Rủi ro",
    Approved: "Đã duyệt",
    Buy: "Mua",
    "WAIT FOR CONDITIONS": "CHỜ ĐỦ ĐIỀU KIỆN",
    "ISOLATED / RECENT ONLY": "CÁCH LY / GẦN ĐÂY",
    Rejected: "Đã loại",
    "TEMPORARY / RECHECK": "TẠM THỜI / KIỂM TRA LẠI",
    "Pipeline color legend": "Chú giải màu luồng xử lý",
    Discovery: "Phát hiện",
    Queue: "Hàng đợi",
    Watch: "Theo dõi",
    "Qualified / execution": "Đủ điều kiện / giao dịch",
    "Live Token Scanner": "Bộ quét token trực tiếp",
    "/ Recent": "/ Gần đây",
    "REAL GMGN DATA · MINT DEDUPLICATED":
      "DỮ LIỆU GMGN THẬT · KHÔNG TRÙNG MINT",
    "Token / source": "Token / nguồn",
    Age: "Tuổi",
    Price: "Giá",
    "Market cap": "Vốn hóa",
    Liquidity: "Thanh khoản",
    "Volume 24h": "Khối lượng 24 giờ",
    "Buy / sell": "Mua / bán",
    Holders: "Người nắm giữ",
    "Top 1 / 10": "Top 1 / 10",
    Security: "Bảo mật",
    Dev: "Nhà phát triển",
    "Risk / decision": "Rủi ro / quyết định",
    "Historical experience": "Kinh nghiệm lịch sử",
    "No tokens with complete displayed data yet.":
      "Chưa có token đủ dữ liệu để hiển thị.",
    "Tokens with UNKNOWN fields are hidden from this list.":
      "Token có trường dữ liệu chưa rõ được ẩn khỏi danh sách này.",
    "Event feed": "Nhật ký sự kiện",
    "LOCAL DECISION & TRADE EVENTS": "SỰ KIỆN QUYẾT ĐỊNH VÀ GIAO DỊCH",
    "System health": "Tình trạng hệ thống",
    "Trading control": "Điều khiển giao dịch",
    "New entries enabled": "Cho phép mua mới",
    "Entries disabled · exits active": "Tắt mua mới · vẫn quản lý bán",
    "FRESH QUALIFICATION REQUIRED": "PHẢI ĐÁNH GIÁ LẠI BẰNG DỮ LIỆU MỚI",
    "Candidates waiting for current conditions or queue capacity. No BUY is authorized by this list.":
      "Ứng viên đang chờ điều kiện phù hợp hoặc ô trống trong hàng đợi. Danh sách này không cấp quyền mua.",
    "No tokens being watched": "Chưa có token đang theo dõi",
    "Deferred / Pending Review": "Tạm hoãn / Chờ đánh giá",
    "Token / mint": "Token / địa chỉ mint",
    Reason: "Lý do",
    Stage: "Giai đoạn",
    Failures: "Số lần lỗi",
    "Last checked": "Kiểm tra gần nhất",
    "Next recheck": "Kiểm tra lại lúc",
    TTL: "Thời gian còn lại",
    Status: "Trạng thái",
    "No deferred candidates.": "Không có ứng viên tạm hoãn.",
    "No deferred candidates": "Không có ứng viên tạm hoãn",
    "Review candidates only. Every recheck requires fresh qualification; this is not a pending BUY order.":
      "Chỉ là ứng viên chờ đánh giá. Mỗi lần kiểm tra phải đánh giá lại; đây không phải lệnh mua đang chờ.",
    "Live positions · your portfolio at a glance":
      "Vị thế thực tế · tổng quan danh mục của bạn",
    "Holdings and realized results follow confirmed transactions and wallet reconciliation.":
      "Số dư và kết quả đã chốt dựa trên giao dịch đã xác nhận và đối soát ví.",
    "Confirmation-based accounting": "Hạch toán theo giao dịch đã xác nhận",
    "Active portfolio summary": "Tổng quan các vị thế đang giữ",
    "No tokens currently held.": "Hiện không giữ token nào.",
    "Fully sold positions appear in History.":
      "Vị thế đã bán hết nằm trong Lịch sử.",
    "Trade history": "Lịch sử giao dịch",
    "FULLY SOLD · REALIZED PNL": "ĐÃ BÁN HẾT · LÃI/LỖ ĐÃ CHỐT",
    "No completed positions in this mode.":
      "Chưa có vị thế hoàn tất trong chế độ này.",
    "Trading memory": "Bộ nhớ giao dịch",
    "OBSERVE · ANALYZE · SUGGEST": "QUAN SÁT · PHÂN TÍCH · ĐỀ XUẤT",
    "Historical comparisons are advisory. Small samples do not change safety, sizing or strategy parameters. MFE/MAE reflect sampled observations.":
      "So sánh lịch sử chỉ mang tính tham khảo. Mẫu nhỏ không thay đổi kiểm tra an toàn, quy mô lệnh hay tham số chiến lược. MFE/MAE dựa trên các lần quan sát được ghi nhận.",
    "Completed trades": "Giao dịch hoàn tất",
    "Strategy & risk parameters": "Tham số chiến lược và rủi ro",
    "Defaults are configurable strategy parameters and make no profitability claim. Entry sizing remains 1% of available SOL. Mode and credentials are configured in the backend environment.":
      "Các tham số mặc định có thể điều chỉnh và không bảo đảm lợi nhuận. Mỗi lệnh mua dùng 1% SOL khả dụng. Chế độ và thông tin xác thực được cấu hình ở máy chủ.",
    "Stop loss: disabled. Trailing profit activates only after its configured positive-profit threshold.":
      "Cắt lỗ: đã tắt. Chốt lời bám đuôi chỉ kích hoạt khi đạt ngưỡng lãi dương đã cấu hình.",
    "Take-profit ladder (JSON)": "Các mốc chốt lời (JSON)",
    "Save parameters": "Lưu tham số",
    "Scanner awaiting status": "Bộ quét đang chờ trạng thái",
    "Decision trace": "Chi tiết quá trình quyết định",
    Close: "Đóng",
    "Position management": "Quản lý vị thế",
    "Strategy settings": "Cài đặt chiến lược",
    "Learning & trade outcomes": "Học hỏi và kết quả giao dịch",
    Active: "Đang giữ",
    Invested: "Vốn đã đầu tư",
    "Current value": "Giá trị hiện tại",
    "Unrealized PnL": "Lãi/lỗ chưa chốt",
    "⚠ Attention": "⚠ Cần chú ý",
    "TOTAL PNL": "TỔNG LÃI/LỖ",
    Holding: "Đang giữ",
    "Entry price": "Giá vào lệnh",
    "Current price": "Giá hiện tại",
    "Position age": "Thời gian giữ",
    MFE: "Lãi cao nhất (MFE)",
    MAE: "Lỗ sâu nhất (MAE)",
    Unrealized: "Chưa chốt",
    Realized: "Đã chốt",
    "NEEDS ATTENTION": "CẦN CHÚ Ý",
    "MONITORING DEGRADED": "THEO DÕI GIÁN ĐOẠN",
    "EXIT PENDING": "ĐANG CHỜ BÁN",
    "SELL SAFETY": "AN TOÀN KHI BÁN",
    "Protective exit": "Thoát lệnh bảo vệ",
    "Simulated balance mismatch": "Số dư mô phỏng không khớp",
    "Retry due · awaiting next check":
      "Đã đến hạn · chờ lần kiểm tra tiếp theo",
    "Transaction reconciliation in progress. Additional SELL requests are unavailable.":
      "Đang đối soát giao dịch. Không thể gửi thêm yêu cầu bán.",
    "SELL in progress · awaiting confirmation and reconciliation.":
      "Đang bán · chờ xác nhận và đối soát.",
    "Emergency full exit": "Bán khẩn cấp toàn bộ",
    "Sell 50%": "Bán 50%",
    "Sell 100%": "Bán 100%",
    Queued: "Đã xếp hàng",
    Selling: "Đang bán",
    "Wait for queued execution or transaction reconciliation":
      "Chờ thực hiện lệnh trong hàng đợi hoặc đối soát giao dịch",
    "Uses the existing checked and confirmed SELL flow":
      "Dùng quy trình bán hiện có, có kiểm tra và xác nhận",
    "NO STOP LOSS": "KHÔNG CẮT LỖ",
    "Valuation: GMGN": "Định giá: GMGN",
    "View details": "Xem chi tiết",
    Copied: "Đã sao chép",
    "Click to copy": "Nhấn để sao chép",
    "Copy unavailable": "Không thể sao chép",
    "Copy mint for": "Sao chép mint của",
    "BUY TX": "GD MUA",
    "SELL TX": "GD BÁN",
    Opened: "Mở lúc",
    "Remaining cost basis": "Giá vốn còn lại",
    State: "Trạng thái",
    "Exit status": "Trạng thái thoát lệnh",
    Valuation: "Định giá",
    "Last check": "Kiểm tra gần nhất",
    "Next retry": "Thử lại lúc",
    "Reason code": "Mã lý do",
    "BUY signature": "Mã giao dịch mua",
    "SELL signature": "Mã giao dịch bán",
    "Not supplied": "Chưa được cung cấp",
    Unavailable: "Không có dữ liệu",
    "Not available": "Không có dữ liệu",
    "not supplied": "chưa được cung cấp",
    unavailable: "không có dữ liệu",
    "Not checked": "Chưa kiểm tra",
    "Not evaluated": "Chưa đánh giá",
    "No reported findings": "Chưa ghi nhận vấn đề",
    "Estimated value excludes future SELL costs.":
      "Giá trị ước tính chưa trừ chi phí bán trong tương lai.",
    "Latest available GMGN token snapshot; may differ in time from position valuation.":
      "Ảnh chụp giá token GMGN mới nhất hiện có; thời điểm có thể khác với định giá vị thế.",
    "Trailing profit activates at the configured profit threshold; the chip does not assert it is currently active.":
      "Chốt lời bám đuôi kích hoạt theo ngưỡng lãi đã cấu hình; nhãn này không khẳng định đã kích hoạt.",
    "Remaining cost basis of active holdings; card Invested shows original entry cost.":
      "Giá vốn còn lại của các vị thế đang giữ; Vốn đã đầu tư trên thẻ là chi phí vào lệnh ban đầu.",
    "Scroll to the first position requiring attention":
      "Cuộn đến vị thế cần chú ý đầu tiên",
    "SYSTEM / TRANSACTION ATTENTION": "CẦN KIỂM TRA HỆ THỐNG / GIAO DỊCH",
    "SCANNER RUNNING": "BỘ QUÉT ĐANG CHẠY",
    "SCANNER IDLE": "BỘ QUÉT ĐANG NGHỈ",
    "DATA STALE": "DỮ LIỆU ĐÃ CŨ",
    "CONNECTION LOST · RECONNECTING": "MẤT KẾT NỐI · ĐANG KẾT NỐI LẠI",
    "Queue full · discovery continues": "Hàng đợi đầy · vẫn tiếp tục quét",
    "Scanning GMGN candidates…": "Đang quét ứng viên GMGN…",
    "No incoming candidates yet": "Chưa có ứng viên mới",
    "No recent rejects": "Chưa có token bị loại gần đây",
    "Waiting for candidate…": "Đang chờ ứng viên…",
    "Outside configured capacity": "Ngoài số ô đã cấu hình",
    "No qualified candidate awaiting execution":
      "Chưa có ứng viên đủ điều kiện chờ giao dịch",
    "Awaiting current qualification": "Đang chờ đánh giá bằng dữ liệu hiện tại",
    "waiting for execution gates": "chờ kiểm duyệt giao dịch",
    "not yet a confirmed BUY": "chưa có giao dịch mua được xác nhận",
    "JEV ANALYZING": "JEV ĐANG PHÂN TÍCH",
    "RISK REVIEW": "ĐÁNH GIÁ RỦI RO",
    "RISK REJECTED": "BỊ LOẠI DO RỦI RO",
    "LIVE · Jupiter executes swaps signed by the local backend wallet.":
      "GIAO DỊCH THẬT · Jupiter thực hiện hoán đổi được ký bằng ví tại máy chủ.",
    "LIVE · New BUYs disabled by operator; position management continues.":
      "GIAO DỊCH THẬT · Người vận hành đã tắt mua mới; vẫn quản lý các vị thế.",
    "LIVE · Controlled BUY allowance consumed; scanner and position management continue.":
      "GIAO DỊCH THẬT · Đã dùng lượt mua thử có giới hạn; vẫn quét và quản lý vị thế.",
    "PAPER · Real GMGN + Jev decisions. Only trade fills and portfolio cash are simulated.":
      "MÔ PHỎNG · Dữ liệu GMGN và quyết định Jev là thật. Chỉ mô phỏng khớp lệnh và tiền trong danh mục.",
    "LIVE BLOCKED · Set LIVE_TRADING_ACK=true in the backend environment.":
      "CHƯA CHO PHÉP GIAO DỊCH THẬT · Cần cấu hình LIVE_TRADING_ACK=true ở máy chủ.",
    "Local connection interrupted. Reconnecting…":
      "Kết nối nội bộ bị gián đoạn. Đang kết nối lại…",
    "Local request failed": "Yêu cầu nội bộ thất bại",
    "Request failed": "Yêu cầu thất bại",
    "Not yet verified": "Chưa xác minh",
    Saved: "Đã lưu",
    "Completed samples": "Mẫu đã hoàn tất",
    "Strategy samples": "Mẫu chiến lược",
    "Wins / losses / breakeven": "Thắng / thua / hòa vốn",
    "Net PnL SOL": "Lãi/lỗ ròng (SOL)",
    "Average / median PnL %": "Lãi/lỗ trung bình / trung vị (%)",
    "Average MFE / MAE %": "MFE / MAE trung bình (%)",
    "Historical confidence": "Độ tin cậy lịch sử",
    "Execution failures (separate)": "Lỗi giao dịch (tính riêng)",
    "Entry quality": "Chất lượng vào lệnh",
    "Exit quality": "Chất lượng thoát lệnh",
    "Exit reasons": "Lý do thoát lệnh",
    "Winning profiles": "Nhóm đặc điểm có lãi",
    "Losing profiles": "Nhóm đặc điểm thua lỗ",
    "No completed samples": "Chưa có mẫu hoàn tất",
    "Suggestions · never automatically applied":
      "Đề xuất · không tự động áp dụng",
    "No historical comparison": "Chưa có so sánh lịch sử",
    "GMGN evidence, Jev and deterministic policy allow entry":
      "Dữ liệu GMGN, Jev và chính sách rủi ro cho phép mua",
    "historical context": "bối cảnh lịch sử",
    "supplied samples (advisory only)": "mẫu được cung cấp (chỉ tham khảo)",
    "Jev chose SKIP": "Jev quyết định bỏ qua",
    "Liquidity is below the configured entry policy":
      "Thanh khoản thấp hơn ngưỡng mua đã cấu hình",
    "GMGN price changed materially after Jev; a new decision is required":
      "Giá GMGN thay đổi đáng kể sau phân tích Jev; cần đánh giá mới",
    "GMGN rug-risk label exceeds the configured critical threshold":
      "Rủi ro rug theo GMGN vượt ngưỡng nghiêm trọng đã cấu hình",
    "Qualification complete; new entries are disabled":
      "Đã đánh giá xong; mua mới đang bị tắt",
    "Protective position work takes priority": "Ưu tiên xử lý bảo vệ vị thế",
    "New entries are disabled": "Mua mới đang bị tắt",
    "This mint already has a position or durable BUY intent":
      "Mint này đã có vị thế hoặc ý định mua được lưu bền vững",
    "Decision evidence is stale": "Dữ liệu ra quyết định đã cũ",
    "Jev did not approve this entry": "Jev không phê duyệt lệnh mua này",
    "Maximum holding time reached": "Đã hết thời gian nắm giữ tối đa",
    "Manual emergency exit": "Thoát lệnh khẩn cấp thủ công",
    "Monitoring recovered": "Đã khôi phục theo dõi",
    positionSizePercent: "Quy mô lệnh mua (%)",
    positionSizeMode: "Chế độ quy mô lệnh mua",
    positionSizeSol: "Số SOL cố định mỗi lệnh mua",
    feeReserveLamports: "SOL dự phòng phí (lamport)",
    maxAgeSeconds: "Tuổi token tối đa (giây)",
    minLiquidityUsd: "Thanh khoản tối thiểu (USD)",
    maxTop1Percent: "Tỷ lệ giữ tối đa của ví lớn nhất (%)",
    maxTop10Percent: "Top 10 holder %",
    maxCreatorPercent: "Tỷ lệ giữ tối đa của người tạo (%)",
    criticalRugRatio: "Ngưỡng rug nghiêm trọng (0–1)",
    warningRugRatio: "Ngưỡng cảnh báo rug (0–1)",
    maxTaxPercent: "Thuế giao dịch tối đa (%)",
    maxSnapshotAgeMs: "Tuổi dữ liệu tối đa (ms)",
    maxDecisionPriceMovePercent: "Biến động giá tối đa sau quyết định (%)",
    slippagePercent: "Trượt giá (%)",
    paperFeeLamports: "Phí mô phỏng (lamport)",
    trailingActivationBps: "Ngưỡng bám đuôi tham khảo cho Jev (bps)",
    trailingStopBps: "Mức hồi tham khảo cho Jev (bps)",
    maxHoldSeconds: "Thời gian giữ tối đa (giây)",
    liquidityCollapseBps: "Ngưỡng sụt thanh khoản (bps)",
    smartMoneyExitMode: "Thoát lệnh theo dòng tiền thông minh",
    analysisRefreshMs: "Chu kỳ làm mới phân tích (ms)",
    intelligenceCacheMs: "Thời gian lưu đệm phân tích (ms)",
    candidatesPerCycle: "Số ứng viên mỗi chu kỳ",
    structureWatchTtlMs: "Thời hạn theo dõi cấu trúc tối đa (ms)",
    structureWatchMaxSize: "Số token theo dõi cấu trúc tối đa",
    structureObservationMs: "Khoảng cách tối thiểu giữa quan sát cấu trúc (ms)",
    structureMaxGapMs: "Khoảng trống dữ liệu cấu trúc tối đa (ms)",
    structureConfirmations: "Số quan sát liên tiếp xác nhận lực đỡ",
    gmgnRequestIntervalMs: "Khoảng cách yêu cầu GMGN tối thiểu (ms)",
    gmgnBackoffBaseMs: "Thời gian nghỉ GMGN ban đầu (ms)",
    gmgnBackoffMaxMs: "Giới hạn thời gian nghỉ GMGN tính toán (ms)",
    gmgnQueueMaxSize: "Sức chứa hàng đợi yêu cầu GMGN",
    candidateQueueSize: "Số ô hàng đợi ứng viên",
    watchMaxSize: "Số token theo dõi tối đa",
    watchRecheckMs: "Chu kỳ kiểm tra danh sách theo dõi (ms)",
    deferredMaxSize: "Số token tạm hoãn tối đa",
    deferredTtlMs: "Thời hạn tạm hoãn (ms)",
    deferredRecheckMs: "Chu kỳ kiểm tra tạm hoãn (ms)",
    deferredMaxRechecks: "Số lần kiểm tra lại tối đa",
    tokenFailureThreshold: "Ngưỡng số lần lỗi token",
    recentRejectTtlMs: "Thời gian cách ly token bị loại (ms)",
    positionRecheckMs: "Chu kỳ kiểm tra lại vị thế (ms)",
    jevExitConcurrency: "Số phân tích Jev thoát lệnh đồng thời",
    jevExitQueueSize: "Sức chứa hàng đợi Jev thoát lệnh",
    jevExitRecheckMs: "Chu kỳ Jev đánh giá lại vị thế (ms)",
    jevExitMinIntervalMs: "Khoảng cách tối thiểu giữa hai lần Jev (ms)",
    jevExitDecisionMaxAgeMs: "Thời hạn quyết định Jev thoát lệnh (ms)",
    jevExitMaterialPnlPoints: "Biến động PnL kích hoạt Jev (điểm phần trăm)",
    jevExitMinConfidence: "Độ tin cậy tối thiểu cho Jev SELL (0–1)",
    exitExecutionsPerCycle: "Số lệnh thoát tối đa mỗi lượt xử lý",
    trendingInterval: "Cửa sổ bảng xếp hạng xu hướng",
    trendingLimit: "Số token xu hướng mỗi lần lấy",
    trendingPollMs: "Chu kỳ lấy nguồn xu hướng (ms)",
    sniperPollMs: "Chu kỳ lấy nguồn săn sớm (ms)",
    trendingFreshMs: "Thời hạn ưu tiên xu hướng (ms)",
    trendingMaxAgeSeconds: "Tuổi token tối đa từ nguồn xu hướng (giây)",
    trendingPriorityBoost: "Ưu tiên nguồn xu hướng",
    multiSourcePriorityBoost: "Ưu tiên cộng thêm khi có hai nguồn",
    candidateAgingPointsPerMinute: "Điểm ưu tiên tăng mỗi phút chờ",
    sniperMaxWaitMs: "Thời gian chờ để ưu tiên săn sớm (ms)",
    sniperWatchReserve: "Số ô theo dõi dành cho nguồn săn sớm",
    trendingAnalysisBurst:
      "Số lượt xu hướng trước lượt dành cho săn sớm chờ lâu",
    queueReplacementMargin: "Chênh lệch tối thiểu để thay ô hàng đợi",
    exitProbeEntryBps: "Các tỷ lệ thoát có thể đáp ứng gate trước mua (bps)",
    exitProbeFeeBudgetLamports:
      "Ngân sách phí bảo thủ cho ước tính thoát (lamports)",
    exitProbeMinNetLamports: "SOL thu tối thiểu sau phí ước tính (lamports)",
    exitProbeMaxImpactPercent: "Price impact tối đa cho tuyến thoát tốt (%)",
    exitProbeMaxAgeMs: "Thời hạn probe trước BUY (ms)",
    positionExitProbeMs: "Khoảng kiểm tra lại thanh khoản thoát vị thế (ms)",
    positionExitProbeSpacingMs: "Khoảng cách giữa hai tác vụ probe vị thế (ms)",
    NO_PREBUY_EXIT_ROUTE: "CHƯA CÓ TUYẾN THOÁT TRƯỚC MUA",
    EXIT_LIQUIDITY_TOO_THIN: "THANH KHOẢN THOÁT QUÁ MỎNG",
    EXIT_FEASIBILITY_UNAVAILABLE: "CHƯA ĐÁNH GIÁ ĐƯỢC KHẢ NĂNG THOÁT",
    EXIT_FEASIBILITY_STALE: "ƯỚC TÍNH THOÁT ĐÃ CŨ",
    jevExitTradeCooldownMs:
      "Khoảng cách tối thiểu giữa hai lần bán chiến lược (ms)",
    flowMaxObservations: "Số quan sát dòng tiền tối đa mỗi vị thế",
    flowHistoryMs: "Thời gian giữ quan sát dòng tiền (ms)",
    flowMinObservations: "Số quan sát tối thiểu để đánh giá dòng tiền",
    flowMinSpanMs: "Khoảng thời gian quan sát tối thiểu (ms)",
    flowObservationIntervalMs: "Khoảng cách giữa các quan sát dòng tiền (ms)",
    flowMaxTransitions: "Số chuyển trạng thái dòng tiền được lưu",
    flowRegimeConfirmations: "Số lần xác nhận chuyển trạng thái dòng tiền",
    flowMeaningfulChangePercent: "Biến động dòng tiền đáng kể (%)",
    flowStaleMs: "Thời hạn dữ liệu dòng tiền (ms)",
    candidateFailures: "Lỗi ứng viên",
    candidateDeferred: "Ứng viên tạm hoãn",
    candidateRecovered: "Ứng viên phục hồi",
    candidateRejectedAfterRetries: "Ứng viên bị loại sau thử lại",
    positionFailures: "Lỗi vị thế",
    systemFailures: "Lỗi hệ thống",
    globalEntryPauses: "Số lần tạm dừng mua toàn hệ thống",
    entrySnapshot: "Dữ liệu lúc vào lệnh",
    preflights: "Kiểm tra trước giao dịch",
    executions: "Bằng chứng giao dịch",
    observations: "Các lần quan sát",
    exits: "Dữ liệu thoát lệnh",
    executionFailures: "Lỗi giao dịch",
    outcome: "Kết quả",
    similarHistoricalGroupAtEntry: "Nhóm lịch sử tương tự lúc mua",
    lessons: "Bài học",
  };
  const states = {
    CONNECTING: "ĐANG KẾT NỐI",
    LIVE: "GIAO DỊCH THẬT",
    PAPER: "MÔ PHỎNG",
    OPEN: "ĐANG GIỮ",
    CLOSED: "ĐÃ ĐÓNG",
    ACTIVE: "ĐANG GIỮ",
    UNKNOWN: "CHƯA RÕ",
    AMBIGUOUS: "CHƯA XÁC ĐỊNH",
    BACKOFF: "CHỜ THỬ LẠI",
    RECONCILING: "ĐANG ĐỐI SOÁT",
    EXIT_PENDING: "ĐANG CHỜ BÁN",
    NEEDS_ATTENTION: "CẦN CHÚ Ý",
    MONITORING_DEGRADED: "THEO DÕI GIÁN ĐOẠN",
    PENDING_ENTRY: "CHỜ MUA",
    PENDING_EXIT: "CHỜ BÁN",
    CREATED: "ĐÃ TẠO",
    SUBMITTED: "ĐÃ GỬI",
    PENDING_CONFIRMATION: "CHỜ XÁC NHẬN",
    CONFIRMED: "ĐÃ XÁC NHẬN",
    FAILED: "THẤT BẠI",
    SCANNING: "ĐANG QUÉT",
    IDLE: "ĐANG NGHỈ",
    CHECKING: "ĐANG KIỂM TRA",
    ANALYZING: "ĐANG PHÂN TÍCH",
    QUEUED: "TRONG HÀNG ĐỢI",
    WATCHING: "ĐANG THEO DÕI",
    WATCH: "THEO DÕI",
    STRUCTURE_WATCH: "THEO DÕI CẤU TRÚC",
    DEFERRED: "TẠM HOÃN",
    REJECTED: "ĐÃ LOẠI",
    QUALIFIED: "ĐỦ ĐIỀU KIỆN",
    APPROVED: "ĐÃ DUYỆT",
    BOUGHT: "ĐÃ MUA",
    BUYING: "ĐANG MUA",
    READY: "SẴN SÀNG",
    BLOCKED: "BỊ CHẶN",
    WARNING: "CẢNH BÁO",
    OFF: "TẮT",
    EXIT: "THOÁT LỆNH",
    HIGH: "CAO",
    MEDIUM: "TRUNG BÌNH",
    LOW: "THẤP",
    CRITICAL: "NGHIÊM TRỌNG",
    VERIFIED: "ĐÃ XÁC MINH",
    NONE: "CHƯA CÓ",
    INSUFFICIENT: "CHƯA ĐỦ DỮ LIỆU",
    LIMITED: "HẠN CHẾ",
    STRONG: "CAO",
    WIN: "THẮNG",
    LOSS: "THUA",
    BREAKEVEN: "HÒA VỐN",
    SKIP: "BỎ QUA",
    BUY: "MUA",
    SELL: "BÁN",
    TRUE: "BẬT",
    FALSE: "TẮT",
  };
  const ordered = Object.entries(phrases).sort(
    (a, b) => b[0].length - a[0].length,
  );
  function vi(value) {
    if (typeof value !== "string") return value;
    if (!/[A-Za-z]/.test(value)) return value;
    const confirm = /^Queue (50|100)% SELL in (paper|live) mode\?$/.exec(value);
    if (confirm)
      return `Xếp lệnh bán ${confirm[1]}% ở chế độ ${confirm[2] === "live" ? "giao dịch thật" : "mô phỏng"}?`;
    if (phrases[value]) return phrases[value];
    if (states[value]) return states[value];
    // Protect opaque identifiers and raw JSON; translation never touches their values.
    if (
      /^[1-9A-HJ-NP-Za-km-z]{30,}$/.test(value) ||
      value.trim().startsWith("[") ||
      value.trim().startsWith("{")
    )
      return value;
    const normalized = value.replace(/\s+/g, " ").trim();
    if (phrases[normalized]) return phrases[normalized];
    let text = value;
    for (const [from, to] of ordered)
      if (text.includes(from))
        text = text.replace(
          new RegExp(
            "(?<![A-Za-z0-9_])" +
              from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
              "(?![A-Za-z0-9_])",
            "g",
          ),
          () => to,
        );
    text = text.replace(
      /\b(?:CONNECTING|LIVE|PAPER|OPEN|CLOSED|ACTIVE|UNKNOWN|AMBIGUOUS|BACKOFF|RECONCILING|EXIT_PENDING|NEEDS_ATTENTION|MONITORING_DEGRADED|PENDING_ENTRY|PENDING_EXIT|CREATED|SUBMITTED|PENDING_CONFIRMATION|CONFIRMED|FAILED|SCANNING|IDLE|CHECKING|ANALYZING|QUEUED|WATCHING|WATCH|DEFERRED|REJECTED|QUALIFIED|APPROVED|BOUGHT|BUYING|READY|BLOCKED|WARNING|OFF|EXIT|HIGH|MEDIUM|LOW|CRITICAL|VERIFIED|NONE|INSUFFICIENT|LIMITED|STRONG|WIN|LOSS|BREAKEVEN|SKIP|BUY|SELL)\b/g,
      (m) => states[m],
    );
    const parts = {
      confidence: "độ tin cậy",
      "historical context": "bối cảnh lịch sử",
      session: "trong phiên",
      candidates: "ứng viên",
      candidate: "ứng viên",
      position: "vị thế",
      pending: "đang chờ",
      Pending: "Đang chờ",
      Scanning: "Đang quét",
      Monitoring: "Đang theo dõi",
      Stopped: "Đã dừng",
      "Last cycle": "Chu kỳ gần nhất",
      Connecting: "Đang kết nối",
      Waiting: "Đang chờ",
      retry: "thử lại",
      unavailable: "không có dữ liệu",
      Updated: "Cập nhật",
      updated: "cập nhật",
      "excludes future SELL costs": "chưa trừ chi phí bán trong tương lai",
      "excludes future BÁN costs": "chưa trừ chi phí bán trong tương lai",
      similar: "tương tự",
      positive: "tích cực",
      negative: "tiêu cực",
      win: "tỷ lệ thắng",
      avg: "trung bình",
      open: "đang giữ",
      "completed trades": "giao dịch hoàn tất",
      reserved: "dự phòng",
      "SOL pending reserve": "SOL dự phòng cho lệnh chờ",
      "pending reserve": "dự phòng cho lệnh chờ",
      "SOL unrealized · GMGN prices": "SOL chưa chốt · giá GMGN",
      "GMGN prices": "giá GMGN",
      "SYSTEM PAUSE": "TẠM DỪNG HỆ THỐNG",
      "TRANSACTION RECONCILIATION": "ĐỐI SOÁT GIAO DỊCH",
      SYSTEM: "HỆ THỐNG",
      TRANSACTION: "GIAO DỊCH",
      "PENDING CONFIRMATION": "CHỜ XÁC NHẬN",
      "BUY CONFIRMED": "MUA ĐÃ XÁC NHẬN",
      "MUA ĐÃ XÁC NHẬN": "MUA ĐÃ XÁC NHẬN",
      fresh: "mới",
      Source: "Nguồn",
      Program: "Chương trình",
      Volume: "Khối lượng",
      "Buys / sells": "Mua / bán",
      Reason: "Lý do",
      "not supplied": "chưa được cung cấp",
      Ready: "Sẵn sàng",
      Sold: "Đã bán",
      "Total PnL": "Tổng lãi/lỗ",
      "Total entry cost": "Tổng chi phí mua",
      "Net proceeds": "Tiền thực nhận",
      "Estimated value": "Giá trị ước tính",
      "Remaining cost": "Giá vốn còn lại",
      "GMGN valuation": "Định giá GMGN",
      "Stop loss: disabled": "Cắt lỗ: đã tắt",
      "Trailing profit activates": "Chốt lời bám đuôi kích hoạt",
      retracement: "mức hồi",
    };
    for (const [from, to] of Object.entries(parts).sort(
      (a, b) => b[0].length - a[0].length,
    ))
      text = text.replace(
        new RegExp(
          "\\b" + from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b",
          "g",
        ),
        () => to,
      );
    return text
      .replace(
        /Priority (\d+) · admitted from SCANNER/g,
        "Ưu tiên $1 · được tiếp nhận từ bộ quét",
      )
      .replace(/\b(\d+)W\/(\d+)L\b/g, "$1 thắng / $2 thua")
      .replace(/Retry in /g, "Thử lại sau ")
      .replace(
        /Queue (\d+)% BÁN in (\w+) mode\?/g,
        "Xếp lệnh BÁN $1% ở chế độ $2?",
      )
      .replace(
        /(\d+) shown · (\d+) hidden with CHƯA RÕ fields · recent 60 maximum/g,
        "$1 hiển thị · $2 bị ẩn do thiếu dữ liệu · tối đa 60 token gần đây",
      )
      .replace(
        /(\d+) token\(s\) deferred; scanner continuing\./g,
        "$1 token tạm hoãn; bộ quét vẫn chạy.",
      )
      .replace(/(\d+) need attention/g, "$1 cần chú ý")
      .replace(/active vị thếs/g, "vị thế đang giữ")
      .replace(/\bTP (?=\+)/g, "CHỐT LỜI ")
      .replace(/TRAIL \+/g, "BÁM ĐUÔI +")
      .replace(/\b(\d+)h\b/g, "$1 giờ")
      .replace(/\b(\d+)m\b/g, "$1 phút")
      .replace(/\b(\d+)s\b/g, "$1 giây");
  }
  return { vi, phrases, states };
})();

/* Domain snapshots render immediately. Only identified backend events animate. */
(() => {
  // The new Overview owns its scanner. Preserve translation/API compatibility
  // without mounting hidden pipe animations, observers or candidate buffers.
  if (document.getElementById("terminalOverview")) {
    const idle = () => {};
    window.BOTFlow = {
      update: idle,
      setTokens: idle,
      view: idle,
      tick: idle,
      configure: idle,
      connection: idle,
      diagnostics: () => ({ pending: 0, active: 0, lastId: 0 }),
    };
    return;
  }
  const $ = (id) => document.getElementById(id);
  const node = (tag, text, cls) => {
    const value = document.createElement(tag);
    if (text !== undefined)
      value.textContent = /flow-token-name|token-avatar/.test(cls || "")
        ? String(text)
        : window.BOTText.vi(String(text));
    if (cls) value.className = cls;
    return value;
  };
  const colors = {
    SCANNER: "scanner",
    QUEUED: "queue",
    ANALYZING: "queue",
    WATCH: "watch",
    STRUCTURE_WATCH: "watch",
    REJECTED: "rejected",
    DEFERRED: "deferred",
    QUALIFIED: "qualified",
    APPROVED: "qualified",
    BOUGHT: "qualified",
    CONFIRMED: "qualified",
  };
  const labels = {
    ANALYZING: "CHECKING",
    WATCH: "WATCHING",
    STRUCTURE_WATCH: "WATCHING",
    CREATED: "BUYING",
    PENDING_CONFIRMATION: "PENDING CONFIRMATION",
    CONFIRMED: "BUY CONFIRMED",
  };
  const money = (e) =>
    e?.state === "KNOWN" && Number.isFinite(e.value)
      ? "$" +
        e.value.toLocaleString(undefined, {
          notation: "compact",
          maximumFractionDigits: 1,
        })
      : "—";
  const metric = (e) =>
    e?.state === "KNOWN"
      ? Number(e.value).toLocaleString(undefined, { maximumFractionDigits: 0 })
      : "—";
  const confidence = (value) =>
    Number.isFinite(value) ? Math.round(value * 100) + "%" : "not supplied";
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  const panelIds = {
    SCANNER: "sourceTank",
    QUEUE: "queueTank",
    QUALIFIED: "qualifiedTank",
    JEV: "qualifiedTank",
    RISK: "qualifiedTank",
    APPROVED: "qualifiedTank",
    BUY: "qualifiedTank",
    POSITIONS: "flowPositionsTarget",
    WATCH: "watchTank",
    REJECTED: "rejectedTank",
    DEFERRED: "deferredTank",
  };
  let connected = true;
  let model,
    state,
    initialized = false,
    lastId = 0,
    activeView = "overview",
    callbacks = {},
    geometryFrame = 0;
  const catalog = new Map(),
    latest = new Map(),
    active = new Map(),
    pending = [];
  const svgNS = "http://www.w3.org/2000/svg";

  function avatar(token) {
    const symbol = token.symbol || token.mint?.slice(0, 2) || "?";
    const icon =
      window.BOTTokenAvatar?.create(token, "token-avatar") ||
      node("span", symbol.slice(0, 2).toUpperCase(), "token-avatar");
    const hash = [...(token.mint || symbol)].reduce(
      (n, c) => (n * 31 + c.charCodeAt(0)) >>> 0,
      0,
    );
    icon.style.setProperty("--avatar-hue", String(hash % 360));
    icon.setAttribute("aria-hidden", "true");
    return icon;
  }
  function tokenDetails(token) {
    const m = token.market || {};
    const security = token.security
      ? token.security.findings
          ?.map((f) => f.level + ": " + f.code)
          .join(", ") || "No reported findings"
      : "Not available";
    return [
      token.name || token.symbol || "Token",
      "Mint: " + token.mint,
      "Source: " + (token.source || "GMGN"),
      "Age: " +
        (token.createdAt
          ? Math.max(0, Math.floor((Date.now() - token.createdAt) / 1000)) + "s"
          : "Not available"),
      "MC: " + money(m.marketCap),
      "Liquidity: " + money(m.liquidity),
      "Volume: " + money(m.volume),
      "Buys / sells: " + metric(m.buys) + " / " + metric(m.sells),
      "Holders: " + metric(token.holders?.count),
      "Program: " + (token.tokenExecution?.tokenProgram || "Not checked"),
      "Security: " + security,
      "Jev: " +
        (token.jev
          ? token.jev.action + " · " + confidence(token.jev.confidence)
          : "Not evaluated"),
      "State: " + (token.state || "SCANNING"),
      "Reason: " + (token.reason || "Awaiting current qualification"),
    ]
      .map((line, index) => (index ? window.BOTText.vi(line) : line))
      .join("\n");
  }
  function textStatus(token) {
    if (token.buyState) return labels[token.buyState] || token.buyState;
    return labels[token.state] || token.state || "SCANNING";
  }
  function tokenCard(token, context, rank) {
    const item = node(
      context === "queue" ? "li" : "div",
      undefined,
      "flow-token flow-token-" + context,
    );
    item.dataset.mint = token.mint;
    item.dataset.state = token.state || context.toUpperCase();
    if (rank !== undefined)
      item.append(node("span", String(rank + 1).padStart(2, "0"), "slot-rank"));
    const button = node("button", undefined, "token-card-button");
    button.title = tokenDetails(token);
    button.onmouseenter = () => {
      button.title = tokenDetails(token);
    };
    button.setAttribute(
      "aria-label",
      window.BOTText.vi(
        `${token.symbol || token.mint}: ${textStatus(token)}. Open token details`,
      ),
    );
    button.onclick = () => callbacks.showToken?.(token.mint);
    button.append(avatar(token));
    const body = node("span", undefined, "token-card-body");
    body.append(
      node(
        "b",
        token.symbol || token.mint?.slice(0, 8) || "Token",
        "flow-token-name",
      ),
    );
    const description = ["source", "queue"].includes(context)
      ? `MC ${money(token.market?.marketCap)} · Vol ${money(token.market?.volume)}`
      : token.reason ||
        (context === "watch"
          ? "Waiting for fresh qualification"
          : textStatus(token));
    body.append(node("small", description, "token-card-meta"));
    if (token.discovery?.sources) {
      const d = token.discovery,
        t = d.trending;
      body.append(
        node(
          "small",
          d.sources
            .map((s) => (s === "TRENDING" ? "XU HƯỚNG" : "SĂN SỚM"))
            .join(" + ") + (t?.rank ? ` · #${t.rank}` : ""),
          "discovery-source-badge",
        ),
      );
      if (t?.history?.length > 1)
        body.append(
          node(
            "small",
            t.history
              .slice(-4)
              .map((h) => "#" + h.rank)
              .join(" → "),
            "token-card-meta",
          ),
        );
    }
    if (context === "deferred")
      body.append(
        node(
          "small",
          token.nextCheckAt
            ? "Recheck " +
                new Date(token.nextCheckAt).toLocaleTimeString("vi-VN")
            : "Awaiting recheck",
          "token-card-time",
        ),
      );
    if (context === "queue") {
      const status = node(
        "small",
        textStatus({ ...token, buyState: undefined }),
        "token-card-status",
      );
      if (token.state === "ANALYZING") {
        item.classList.add("is-checking");
        status.textContent = window.BOTText.vi("CHECKING · Deep check");
        const since = node("span", "", "checking-time");
        since.dataset.since = String(token.lastChecked);
        status.append(" · ", since);
      }
      body.append(status);
    }
    button.append(body);
    item.append(button);
    if (token.state === "ANALYZING")
      item.append(node("span", "", "flow-spinner"));
    else if (context === "rejected")
      item.append(node("span", "⊘", "reject-symbol"));
    else if (context === "watch")
      item.append(node("span", "◉", "watch-symbol"));
    return item;
  }
  // Keyed reconciliation retains rows/animations and only updates changed cards.
  function list(id, items, context, limit, empty) {
    const root = $(id);
    if (!root) return;
    const old = new Map([...root.children].map((c) => [c.dataset.key, c]));
    const before =
      context === "queue" && !reduce.matches
        ? new Map(
            [...root.children].map((c) => [
              c.dataset.key,
              c.getBoundingClientRect(),
            ]),
          )
        : null;
    const desired = items.slice(0, limit).map((token, index) => {
      const key = token.mint || "empty-" + index;
      const m = token.market || {};
      const signature = JSON.stringify([
        token.mint,
        token.symbol,
        token.name,
        window.BOTTokenAvatar?.logo(token),
        token.source,
        token.createdAt,
        token.state,
        token.empty,
        m.price,
        m.marketCap,
        m.liquidity,
        m.volume,
        m.buys,
        m.sells,
        token.holders?.count,
        token.tokenExecution?.tokenProgram,
        token.security?.findings,
        token.jev?.action,
        token.jev?.confidence,
        token.reason,
        context === "deferred" ? token.nextCheckAt : null,
        token.state === "ANALYZING" ? token.lastChecked : null,
        context,
        index,
      ]);
      let item = old.get(key);
      if (!item || item.dataset.signature !== signature) {
        if (token.empty) {
          item = node("li", undefined, "queue-empty");
          item.append(
            node("span", String(index + 1).padStart(2, "0"), "slot-rank"),
            node(
              "span",
              index < (model?.limits.queue ?? 10)
                ? "Waiting for candidate…"
                : "Outside configured capacity",
            ),
          );
        } else
          item = tokenCard(
            token,
            context,
            context === "queue" ? index : undefined,
          );
        item.dataset.key = key;
        item.dataset.signature = signature;
      }
      return item;
    });
    if (!desired.length) {
      const message = node("p", empty, "flow-empty");
      message.dataset.key = "empty";
      desired.push(message);
    }
    for (const child of [...root.children])
      if (!desired.includes(child)) child.remove();
    desired.forEach((child, index) => {
      if (root.children[index] !== child)
        root.insertBefore(child, root.children[index] || null);
    });
    if (before)
      for (const child of desired) {
        const prev = before.get(child.dataset.key);
        if (!prev) continue;
        const next = child.getBoundingClientRect(),
          dy = prev.top - next.top;
        if (Math.abs(dy) > 1 && Math.abs(dy) < 600)
          child.animate(
            [
              { transform: `translateY(${dy}px)` },
              { transform: "translateY(0)" },
            ],
            { duration: 250, easing: "ease-out" },
          );
      }
  }
  function fallback(s) {
    const p = s.candidatePipeline || {};
    return {
      version: 0,
      scannerRunning: s.scanner?.running,
      limits: {
        queue: p.capacity || 10,
        watch: s.settings?.watchMaxSize || 30,
        deferred: s.settings?.deferredMaxSize || 20,
      },
      counts: {
        scanned: s.analytics?.discovered || 0,
        perMinute: null,
        queue: p.queue?.length || 0,
        checking: p.queue?.filter((t) => t.state === "ANALYZING").length || 0,
        watch: p.watch?.length || 0,
        deferred: p.deferred?.length || 0,
        rejected: null,
        approved: null,
        traded: null,
      },
      scanner: [...catalog.values()].slice(0, 8),
      queue: p.queue || [],
      watch: p.watch || [],
      deferred: p.deferred || [],
      rejected: [],
      decisions: [],
      events: [],
    };
  }
  function enrich(item) {
    return { ...catalog.get(item.mint), ...item };
  }
  function badge(id, count) {
    const b = $(id);
    b.textContent = window.BOTText.vi(String(count));
    b.classList.toggle("hidden", !count);
    b.setAttribute("aria-label", window.BOTText.vi(`${count} candidates`));
  }
  function renderDecision() {
    const items = model.decisions.map(enrich);
    const focus =
      items.find(
        (t) => ["QUALIFIED", "APPROVED"].includes(t.state) && !t.buyState,
      ) ||
      items.find((t) =>
        [
          "CREATED",
          "SUBMITTED",
          "PENDING_CONFIRMATION",
          "UNKNOWN",
          "AMBIGUOUS",
        ].includes(t.buyState),
      ) ||
      items.find((t) => ["OPEN", "PENDING_EXIT"].includes(t.positionState)) ||
      items.find((t) => t.buyState && t.buyState !== "FAILED") ||
      items[0];
    const target = $("decisionFocus");
    for (const n of $("decisionNodes").querySelectorAll("[data-node]"))
      n.classList.remove("active", "complete", "failed");
    if (!focus) {
      target.replaceChildren(
        node("p", "No qualified candidate awaiting execution", "flow-empty"),
      );
      delete target.dataset.signature;
      $("decisionRecent").replaceChildren();
      return;
    }
    const event = focus.event;
    let stage = "QUALIFIED",
      label = "QUALIFIED · waiting for execution gates";
    if (focus.buyState) {
      stage = "BUY";
      label = labels[focus.buyState] || "BUY " + focus.buyState;
      if (focus.buyState === "CONFIRMED" && focus.buyAt)
        label += " · " + new Date(focus.buyAt).toLocaleTimeString("vi-VN");
    } else if (event?.type === "JEV_STARTED") {
      stage = "JEV";
      label = "JEV ANALYZING";
    } else if (event?.type === "RISK_REVIEW") {
      stage = "RISK";
      label = "RISK REVIEW";
    } else if (event?.type === "RISK_REJECTED") {
      stage = "RISK";
      label = "RISK REJECTED";
    } else if (focus.state === "APPROVED") {
      stage = "APPROVED";
      label = "APPROVED · not yet a confirmed BUY";
    } else if (event?.type === "JEV_COMPLETED") {
      stage = "JEV";
      label = `JEV ${focus.jev?.action || event.action} · confidence ${confidence(focus.jev?.confidence ?? event.confidence)}`;
    }
    const order = ["QUALIFIED", "JEV", "RISK", "APPROVED", "BUY"],
      index = order.indexOf(stage);
    for (const n of $("decisionNodes").querySelectorAll("[data-node]")) {
      const at = order.indexOf(n.dataset.node);
      n.classList.toggle(
        "complete",
        at < index && !focus.buyState?.match(/FAILED|UNKNOWN|AMBIGUOUS/),
      );
      n.classList.toggle("active", n.dataset.node === stage);
      n.classList.toggle(
        "failed",
        n.dataset.node === stage &&
          (focus.buyState === "FAILED" || event?.type === "RISK_REJECTED"),
      );
    }
    const signature = JSON.stringify([
      focus.mint,
      label,
      focus.buySignature,
      focus.reason,
    ]);
    if (target.dataset.signature !== signature) {
      const card = tokenCard(focus, "decision");
      card.append(node("small", label, "decision-state"));
      target.replaceChildren(card);
      target.dataset.signature = signature;
    }
    $("decisionRecent").replaceChildren(
      ...items
        .filter((t) => t.mint !== focus.mint)
        .slice(0, 2)
        .map((t) =>
          node("small", `${t.symbol || t.mint.slice(0, 8)} · ${textStatus(t)}`),
        ),
    );
  }
  function draw() {
    if (!model) return;
    const feeds = state.discovery?.feeds;
    for (const [source, id] of [
      ["TRENDING", "trendingSource"],
      ["SNIPER", "sniperSource"],
    ]) {
      const box = $(id);
      if (!box) continue;
      const f = feeds?.[source];
      box.textContent =
        (source === "TRENDING"
          ? "XU HƯỚNG · ƯU TIÊN CAO"
          : "SĂN SỚM · ĐÃ TẮT NGUỒN MỚI") +
        "\n" +
        (f
          ? `${f.count} token · ${f.state === "DISABLED" ? "CHỈ GIỮ LỊCH SỬ" : f.state === "READY" ? "SẴN SÀNG" : f.state === "DEGRADED" ? "NGUỒN GIÁN ĐOẠN" : "ĐANG CHỜ"}`
          : "Đang chờ nguồn");
      box.classList.toggle("source-degraded", f?.state === "DEGRADED");
    }
    badge("watchBadge", model.counts.watch);
    badge("deferredBadge", model.counts.deferred);
    $("flowRuntime").textContent = window.BOTText.vi(
      state.haltReason
        ? "SYSTEM / TRANSACTION ATTENTION"
        : model.scannerRunning
          ? `${state.mode.toUpperCase()} · SCANNER RUNNING`
          : "SCANNER IDLE",
    );
    $("flowRuntime").classList.toggle("runtime-paused", !!state.haltReason);
    $("sourceTank").classList.toggle("is-scanning", !!model.scannerRunning);
    $("sourceState").textContent = window.BOTText.vi(
      model.scannerRunning ? "SCANNING" : "IDLE",
    );
    if (!connected) {
      $("sourceState").textContent = window.BOTText.vi("DATA STALE");
      $("flowRuntime").textContent = window.BOTText.vi(
        "CONNECTION LOST · RECONNECTING",
      );
    }
    $("sourceCaption").textContent = window.BOTText.vi(
      model.scannerRunning
        ? model.counts.queue >= model.limits.queue
          ? "Queue full · discovery continues"
          : "Scanning GMGN candidates…"
        : "Waiting for discovery",
    );
    $("flowBoard").classList.toggle("flow-running", !!model.scannerRunning);
    $("queueTank").classList.toggle(
      "queue-full",
      model.counts.queue >= model.limits.queue,
    );
    $("flowQueueCount").textContent = window.BOTText.vi(
      `${model.counts.queue} / ${model.limits.queue}`,
    );
    $("flowWatchCount").textContent = window.BOTText.vi(
      `${new Set([...(model.watch || []).map((r) => r.mint), ...(state.structureWatch || []).filter((r) => r.status === "ACTIVE" && r.eligibleForEntryWatch).map((r) => r.mint)]).size} ↗`,
    );
    $("flowDeferredCount").textContent = window.BOTText.vi(
      `${model.counts.deferred} ↗`,
    );
    $("flowRejectedCount").textContent = window.BOTText.vi(
      (model.counts.rejected ?? "—") + " session",
    );
    list(
      "sourceStream",
      model.scanner.map(enrich),
      "source",
      8,
      "No incoming candidates yet",
    );
    const slots = Array.from({ length: 10 }, (_, index) =>
      model.queue[index]
        ? enrich(model.queue[index])
        : { mint: "empty-" + index, empty: true },
    );
    list("flowQueueSlots", slots, "queue", 10, "");
    list(
      "watchPreview",
      model.watch.map(enrich),
      "watch",
      3,
      "No tokens being watched",
    );
    list(
      "rejectedPreview",
      model.rejected.map(enrich),
      "rejected",
      3,
      "No recent rejects",
    );
    list(
      "deferredPreview",
      model.deferred.map(enrich),
      "deferred",
      3,
      "No deferred candidates",
    );
    list(
      "watchRows",
      (state.candidatePipeline?.watch || model.watch).map(enrich),
      "watch",
      100,
      "No tokens being watched",
    );
    $("watchEmpty").classList.toggle(
      "hidden",
      model.counts.watch > 0 ||
        (state.structureWatch || []).some(
          (r) => r.status === "ACTIVE" && r.eligibleForEntryWatch,
        ),
    );
    const hasStructure = (state.structureWatch || []).some(
      (r) => r.status === "ACTIVE" && r.eligibleForEntryWatch,
    );
    $("watchRows").classList.toggle(
      "hidden",
      (state.candidatePipeline?.watch || model.watch).length === 0,
    );
    $("watchPreview").classList.toggle(
      "hidden",
      model.watch.length === 0 && hasStructure,
    );
    renderDecision();
    renderFeed();
    tick();
    scheduleGeometry();
  }
  function renderFeed() {
    const root = $("eventFeed"),
      scroll = root.scrollTop;
    const meaningful = (model.events || []).filter(
      (e) =>
        !["CANDIDATE_CHECKING", "RISK_REVIEW", "CANDIDATE_TRADED"].includes(
          e.type,
        ),
    );
    const legacy = (state.events || [])
      .filter((r) =>
        [
          "POSITION_ATTENTION",
          "POSITION_RECOVERED",
          "ERROR",
          "ENTRY_CONTROL",
          "CONTROLLED_RESUMED",
        ].includes(r.payload.type),
      )
      .map((r) => ({ ...r.payload, at: r.at, mint: r.mint }));
    const rows = [...meaningful, ...legacy]
      .sort((a, b) => b.at - a.at)
      .slice(0, 35);
    const signature = JSON.stringify(rows);
    if (root.dataset.signature === signature) return;
    root.dataset.signature = signature;
    root.replaceChildren(
      ...rows.map((event) => {
        const tone =
          colors[event.to] ||
          (event.type.includes("REJECT")
            ? "rejected"
            : event.type.includes("DEFER")
              ? "deferred"
              : event.type.includes("BUY")
                ? "qualified"
                : "scanner");
        const line = node("div", undefined, "flow-event tone-" + tone);
        const heading = node("div", undefined, "flow-event-heading");
        heading.append(
          node(
            "span",
            new Date(event.at).toLocaleTimeString("vi-VN"),
            "event-time",
          ),
          node(
            "b",
            (event.symbol || event.mint?.slice(0, 8) || "K1ll of BOT") +
              " · " +
              event.type.replaceAll("_", " "),
          ),
        );
        line.append(
          heading,
          node(
            "small",
            event.reason ||
              (event.type === "CANDIDATE_QUEUED"
                ? `${Number.isFinite(event.score) ? "Priority " + event.score.toFixed(0) : "Priority not supplied"} · admitted from ${event.origin || "discovery"}`
                : event.signature
                  ? "TX: " + event.signature
                  : event.from && event.to
                    ? `${event.from} → ${event.to}`
                    : "Runtime state updated"),
          ),
        );
        return line;
      }),
    );
    if (!rows.length)
      root.append(
        node("p", "Waiting for meaningful pipeline transitions", "flow-empty"),
      );
    root.scrollTop = scroll;
  }
  function anchor(name) {
    const target = $(panelIds[name] || "queueTank");
    const rect = target?.getBoundingClientRect();
    return rect
      ? {
          x: rect.x + rect.width / 2,
          y: rect.y + Math.min(rect.height / 2, 120),
        }
      : null;
  }
  function route(event) {
    if (event.type === "CANDIDATE_QUEUED")
      return [
        event.origin === "DEFERRED"
          ? "DEFERRED"
          : event.origin === "WATCH"
            ? "WATCH"
            : "SCANNER",
        "QUEUE",
        event.origin === "DEFERRED"
          ? "deferred"
          : event.origin === "WATCH"
            ? "watch"
            : "scanner",
      ];
    if (event.to === "REJECTED")
      return [
        event.from === "WATCH" ? "WATCH" : "QUEUE",
        "REJECTED",
        "rejected",
      ];
    if (event.to === "WATCH") return ["QUEUE", "WATCH", "watch"];
    if (event.to === "DEFERRED")
      return [
        event.from === "WATCH" ? "WATCH" : "QUEUE",
        "DEFERRED",
        "deferred",
      ];
    if (event.to === "QUALIFIED")
      return [
        event.origin === "WATCH" ? "WATCH" : "QUEUE",
        "QUALIFIED",
        "qualified",
      ];
    if (event.type === "BUY_CONFIRMED")
      return ["BUY", "POSITIONS", "qualified"];
    return null;
  }
  function cancel(mint) {
    const current = active.get(mint);
    if (current) {
      current.cancelled = true;
      current.animation?.cancel();
      current.ghost.remove();
      active.delete(mint);
    }
  }
  function clear() {
    pending.splice(0);
    for (const mint of active.keys()) cancel(mint);
  }
  async function travel(event) {
    const path = route(event);
    if (!path) return;
    const from = anchor(path[0]),
      to = anchor(path[1]);
    if (!from || !to) return;
    const ghost = node("div", undefined, "travel-token tone-" + path[2]);
    ghost.append(avatar({ mint: event.mint, symbol: event.symbol }));
    ghost.setAttribute("aria-hidden", "true");
    ghost.dataset.mint = event.mint;
    ghost.style.left = "0px";
    ghost.style.top = "0px";
    document.body.append(ghost);
    const flight = { ghost, cancelled: false, animation: null, color: path[2] };
    $("flowBoard").classList.add("has-flow-" + path[2]);
    active.set(event.mint, flight);
    try {
      if (path[2] === "rejected") {
        ghost.style.transform = `translate(${from.x - 18}px,${from.y - 18}px)`;
        ghost.append(node("span", "⊘", "travel-stamp"));
        await new Promise((resolve) => window.setTimeout(resolve, 260));
      }
      if (flight.cancelled || latest.get(event.mint) !== event.id) return;
      const bend = (to.x - from.x) * 0.45;
      const steps = Array.from({ length: 21 }, (_, index) => {
        const t = index / 20,
          u = 1 - t;
        const x =
          u * u * u * from.x +
          3 * u * u * t * (from.x + bend) +
          3 * u * t * t * (to.x - bend) +
          t * t * t * to.x;
        const y =
          u * u * u * from.y +
          3 * u * u * t * from.y +
          3 * u * t * t * to.y +
          t * t * t * to.y;
        return {
          transform: `translate(${x - 18}px,${y - 18}px) scale(${0.9 + 0.1 * Math.sin(t * Math.PI)})`,
          opacity: t < 0.08 ? t / 0.08 : t > 0.92 ? (1 - t) / 0.08 : 1,
          offset: t,
        };
      });
      flight.animation = ghost.animate(steps, {
        duration: 720,
        easing: "cubic-bezier(.25,.65,.25,1)",
        fill: "both",
      });
      await flight.animation.finished;
      if (!flight.cancelled && latest.get(event.mint) === event.id) {
        const destination =
          path[1] === "QUEUE"
            ? [...$("flowQueueSlots").children].find(
                (item) => item.dataset.mint === event.mint,
              ) || $("queueTank")
            : $(panelIds[path[1]]);
        destination?.animate([{ opacity: 0.65 }, { opacity: 1 }], {
          duration: 300,
        });
      }
    } catch {
      /* Cancelled by newer authoritative state/navigation. */
    } finally {
      ghost.remove();
      if (active.get(event.mint) === flight) active.delete(event.mint);
      if (![...active.values()].some((item) => item.color === path[2]))
        $("flowBoard").classList.remove("has-flow-" + path[2]);
      pump();
    }
  }
  function pump() {
    if (reduce.matches || document.hidden || activeView !== "overview") return;
    while (active.size < 2 && pending.length) {
      const event = pending.shift();
      if (latest.get(event.mint) !== event.id) continue;
      void travel(event);
    }
  }
  function consume(events) {
    const sorted = [...events].sort((a, b) => a.id - b.id);
    if (!initialized) {
      lastId = sorted.at(-1)?.id || 0;
      initialized = true;
      return;
    }
    const fresh = sorted.filter((e) => e.id > lastId);
    if (!fresh.length) return;
    for (const event of fresh) {
      latest.set(event.mint, event.id);
      cancel(event.mint);
    }
    lastId = Math.max(lastId, ...fresh.map((e) => e.id));
    if (document.hidden || activeView !== "overview" || reduce.matches) {
      clear();
      return;
    }
    for (const event of fresh)
      if (latest.get(event.mint) === event.id && route(event))
        pending.push(event);
    if (pending.length > 16) pending.splice(0, pending.length - 16);
    while (latest.size > 500) latest.delete(latest.keys().next().value);
    pump();
  }
  function scheduleGeometry() {
    if (geometryFrame) return;
    geometryFrame = window.requestAnimationFrame(() => {
      geometryFrame = 0;
      drawPipes();
    });
  }
  function drawPipes() {
    const board = $("flowBoard"),
      svg = $("flowPipes");
    if (!board?.offsetWidth) return;
    const bounds = board.getBoundingClientRect();
    svg.setAttribute("viewBox", `0 0 ${bounds.width} ${bounds.height}`);
    const connections = [
      ["SCANNER", "QUEUE", "scanner"],
      ["QUEUE", "QUALIFIED", "qualified"],
      ["QUEUE", "WATCH", "watch"],
      ["QUEUE", "REJECTED", "rejected"],
      ["QUEUE", "DEFERRED", "deferred"],
      ["WATCH", "QUALIFIED", "qualified"],
    ];
    svg.replaceChildren(
      ...connections.map(([fromName, toName, color]) => {
        const a = $(panelIds[fromName]).getBoundingClientRect(),
          b = $(panelIds[toName]).getBoundingClientRect();
        const vertical = Math.abs(a.left - b.left) < 20;
        const from = {
          x: (vertical ? a.left + 12 : a.right) - bounds.left,
          y: (vertical ? a.top : a.top + a.height * 0.25) - bounds.top,
        };
        const to = {
          x: (vertical ? b.left + 12 : b.left) - bounds.left,
          y: (vertical ? b.bottom : b.top + b.height * 0.5) - bounds.top,
        };
        const bend = vertical ? 20 : Math.max(18, (to.x - from.x) / 2);
        const p = document.createElementNS(svgNS, "path");
        p.setAttribute(
          "d",
          `M ${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${to.x - bend} ${to.y}, ${to.x} ${to.y}`,
        );
        p.setAttribute("class", "flow-pipe pipe-" + color);
        return p;
      }),
    );
  }
  function tick() {
    for (const item of document.querySelectorAll("[data-since]"))
      item.textContent = window.BOTText.vi(
        Math.max(
          0,
          Math.floor((Date.now() - Number(item.dataset.since)) / 1000),
        ) + "s",
      );
  }
  function update(s) {
    state = s;
    model = s.flow || fallback(s);
    for (const list of [
      "scanner",
      "queue",
      "watch",
      "rejected",
      "deferred",
      "decisions",
    ])
      for (const token of model[list] || []) catalog.set(token.mint, token);
    while (catalog.size > 350) catalog.delete(catalog.keys().next().value);
    draw();
    if (s.flow) consume(model.events || []);
  }
  function setTokens(tokens) {
    window.BOTTokenAvatar?.remember(tokens);
    for (const token of tokens)
      catalog.set(token.mint, { ...catalog.get(token.mint), ...token });
    if (model) draw();
  }
  function view(name) {
    activeView = name;
    if (name !== "overview") clear();
    else {
      draw();
      scheduleGeometry();
    }
  }
  window.BOTFlow = {
    update,
    setTokens,
    view,
    tick,
    configure(value) {
      callbacks = value;
    },
    connection(value) {
      connected = value;
      document.body.classList.toggle("flow-disconnected", !value);
      if (!value) {
        clear();
        initialized = false;
        if (model) draw();
      }
    },
    diagnostics() {
      return { pending: pending.length, active: active.size, lastId };
    },
  };
  new window.ResizeObserver(scheduleGeometry).observe($("flowBoard"));
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) clear();
    else scheduleGeometry();
  });
  reduce.addEventListener("change", clear);
  window.addEventListener("scroll", clear, { passive: true });
})();
