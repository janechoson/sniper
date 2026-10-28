const actions: Record<string, string> = {
  ALL: "Tất cả token",
  BUY: "Đề xuất mua",
  SELL: "Đề xuất bán",
  SKIP: "Bỏ qua",
  REJECT: "Từ chối",
};
export function fundingEvidenceLabel(value?: boolean) {
  return value === undefined
    ? "Chưa rõ"
    : value
      ? "Có bằng chứng nguồn vốn rủi ro"
      : "Không ghi nhận nguồn vốn rủi ro";
}
const statuses: Record<string, string> = {
  healthy: "hoạt động tốt",
  unhealthy: "gặp sự cố",
  unconfigured: "chưa cấu hình",
};
const events: Record<string, string> = {
  observation_stage: "Agent đang phân tích",
  observation_scanner: "Kết nối scanner thật",
  observation_buy: "Đã mua mô phỏng 5 USD",
  observation_sell: "Đã bán mô phỏng",
  observation_quote_unavailable: "Đang chờ báo giá thoát mới",
  real_ready: "Đã khởi tạo dữ liệu thật",
  discovery_accepted: "Đã lưu sự kiện phát hiện",
  candidate_analyzed: "Đã phân tích ứng viên",
  execution_update: "Cập nhật thực thi",
  position_mark: "Cập nhật báo giá thoát",
  exit_retry: "Thoát lệnh cần kiểm tra lại",
  reconciliation_error: "Đối soát giao dịch gặp lỗi",
  token_detected: "Phát hiện token",
  analysis_running: "Đang phân tích",
  rejected: "Đã từ chối",
  candidate: "Đã đánh giá token",
  paper_buy: "Mua mô phỏng",
  position_update: "Cập nhật vị thế",
  take_profit: "Chốt lời",
  stop_loss: "Cắt lỗ",
  position_exit: "Thoát vị thế",
  kill_switch: "Ngắt khẩn cấp",
  settings_updated: "Đã cập nhật cài đặt",
  scanner_started: "Đã bắt đầu quét",
  scanner_paused: "Đã tạm dừng quét",
};
const reasons: Record<string, string> = {
  POSITION_SIZE_UNKNOWN: "Chưa xác minh được khối lượng theo số dư ví",
  POSITION_SIZE_CHANGED_REQUOTE_REQUIRED:
    "Số dư thay đổi; cần báo giá và phê duyệt lại đúng khối lượng",
  POSITION_SIZE_APPROVAL_MISMATCH:
    "Khối lượng phê duyệt không khớp báo giá hoặc đã cũ",
  POSITION_SIZE_TOO_SMALL: "Vốn khả dụng quá nhỏ để tạo lệnh",
  NATIVE_INPUT_ADAPTER_NOT_READY:
    "Nguồn swap này chưa hỗ trợ chi trực tiếp coin gốc",
  LIVE_QUOTE_ORACLE_CHAIN_UNVERIFIED:
    "Nguồn giá USD trên chain này chưa được xác minh cho LIVE",
  UNTRUSTED_QUOTE: "Tài sản quote chưa được tin cậy",
  NO_TRADING_ROUTE: "Curve đã hoàn tất hoặc chưa có dự trữ giao dịch thực",
  INSUFFICIENT_MARKET_DATA: "Chưa đủ dữ liệu thị trường đã xác minh",
  DISCOVERY_DATA_UNAVAILABLE: "Dữ liệu kiểm tra ban đầu chưa phản hồi",
  DISCOVERY_QUOTE_UNTRUSTED:
    "Đã phát hiện token; tài sản định giá chưa được tin cậy",
  DISCOVERY_MARKET_ADAPTER_UNAVAILABLE:
    "Đã phát hiện token; chưa hỗ trợ đọc thị trường của nguồn này",
  DISCOVERY_QUOTE_USD_UNKNOWN:
    "Chưa có nguồn giá USD đã xác minh cho tài sản định giá",
  DISCOVERY_MARKET_IDENTITY_INVALID: "Danh tính thị trường chưa hợp lệ",
  DISCOVERY_ANALYSIS_BACKPRESSURE: "Đã lưu token; hàng chờ phân tích đang đầy",
  DISCOVERY_ANALYSIS_SOURCE_CAP:
    "Đã lưu token; nguồn này đã đủ lượt phân tích chờ",
  PUMP_INVALID_MINT: "Mint Pump không hợp lệ",
  PUMP_POOL_OWNER_MISMATCH: "Owner của curve/pool không khớp chương trình",
  PUMP_POOL_IDENTITY_MISMATCH: "PDA hoặc mint của pool không khớp",
  PUMP_CURVE_IDENTITY_MISMATCH: "PDA bonding curve không khớp mint",
  PUMP_VAULT_IDENTITY_MISMATCH: "Vault không khớp mint hoặc owner",
  OBSERVATION_ONLY: "Chỉ quan sát, chưa cho phép giao dịch thật",
  OBSERVATION_EXECUTION_DISABLED:
    "Mua/bán blockchain đã khóa trong chế độ quan sát",
  OBSERVATION_AI_RATE_LIMIT: "Đang chờ lượt phân tích Jev tiếp theo",
  OBSERVATION_ANALYSIS_UNAVAILABLE:
    "Một nguồn dữ liệu chưa phản hồi; chưa kết luận an toàn",
  RUG_CHECK_DISABLED: "Rug Check đang bị tắt",
  MANDATORY_SECURITY_COVERAGE_REQUIRED: "Chưa đủ bằng chứng bảo mật bắt buộc",
  HONEYPOT_DETECTED: "Có bằng chứng honeypot trong phạm vi kiểm tra",
  SELL_SIMULATION_FAILED: "Mô phỏng bán hiện tại thất bại",
  SELLABILITY_UNKNOWN: "Chưa chứng minh được khả năng bán",
  MINT_AUTHORITY_ACTIVE: "Quyền mint còn hiệu lực, không đạt chính sách",
  FREEZE_AUTHORITY_ACTIVE: "Quyền đóng băng còn hiệu lực, không đạt chính sách",
  BLACKLIST_CAPABILITY: "Có bằng chứng cơ chế chặn ví",
  TRANSFER_RESTRICTED: "Có bằng chứng hạn chế chuyển hoặc bán",
  PAUSE_CAPABILITY: "Có quyền tạm dừng giao dịch",
  TOP1_CONCENTRATION_HIGH: "Tập trung holder top1 vượt ngưỡng",
  TOP10_CONCENTRATION_HIGH: "Tập trung holder top10 vượt ngưỡng",
  CREATOR_CRITICAL_HISTORY: "Lịch sử creator có sự cố được ghi nhận",
  CREATOR_LP_CONTROL: "Người tạo pool nắm LP, không đạt chính sách",
  LIQUIDITY_TOO_LOW: "Thanh khoản dưới ngưỡng đã cấu hình",
  LIQUIDITY_REMOVAL_DETECTED: "Có bằng chứng sụt hoặc rút thanh khoản",
  LIQUIDITY_DROP_OBSERVED_NOT_PROVEN_LP_REMOVAL:
    "Sụt giá trị thanh khoản quan sát, chưa chứng minh rút LP",
  LIQUIDITY_LOCK_UNKNOWN: "Chưa xác minh thời hạn khóa LP",
  LIQUIDITY_UNLOCK_SOON: "LP sắp mở khóa theo ngưỡng đã cấu hình",
  ROUND_TRIP_LOSS_HIGH: "Tổn hao mua rồi bán vượt ngưỡng",
  TOKEN_TAX_HIGH: "Phí hoặc thuế token vượt ngưỡng",
  SECURITY_DATA_INCOMPLETE: "Dữ liệu bảo mật bắt buộc chưa đầy đủ hoặc đã cũ",
  SECURITY_PROVIDER_DISAGREEMENT: "Các nguồn bảo mật không thống nhất",
  EXTERNAL_PROVIDER_RISK: "Nguồn bên ngoài có chỉ báo rủi ro",
  EXTERNAL_SECURITY_UNAVAILABLE: "Nguồn bảo mật bên ngoài không khả dụng",
  PROVIDER_TIMEOUT: "Nguồn dữ liệu hết thời gian chờ",
  SECURITY_PROVIDER_UNAVAILABLE: "Nguồn bằng chứng không khả dụng",
  JEV_RUG_RISK_HIGH: "Jev đánh giá chỉ báo rug vượt ngưỡng",
  JEV_SUSPICIOUS_HIGH: "Jev đánh giá dấu hiệu đáng ngờ vượt ngưỡng",
  JEV_INSUFFICIENT_DATA: "Jev đánh giá chưa đủ dữ liệu",
  JEV_ADVISORY_SKIP: "Jev đề nghị bỏ qua",
  JEV_ADVISORY_WATCH: "Jev đề nghị theo dõi thêm",
  SECURITY_DETERIORATION: "Bằng chứng bảo mật xấu đi, cần thoát vị thế",
  SECURITY_RECHECK_UNAVAILABLE: "Chưa kiểm tra lại được bảo mật",
  REAL_CONFIG_MISSING: "Chưa có tệp cấu hình dữ liệu thật",
  FRESH_QUOTE_USD_PRICE_REQUIRED: "Cần nguồn giá USD đã xác minh và còn mới",
  VERIFIED_SWAP_PROVIDER_MISSING: "Chưa có nhà cung cấp hoán đổi đã xác minh",
  QUOTE_ENGINE_NOT_READY: "Bộ báo giá chưa sẵn sàng",
  SELECT_WALLET_FOR_CHAIN: "Chọn ví cho chuỗi này",
  SIGNER_UNAVAILABLE: "Bộ ký chưa khả dụng",
  WALLET_OR_SIGNER_UNAVAILABLE: "Ví hoặc bộ ký chưa khả dụng",
  WATCH_ONLY: "Ví chỉ xem, không ký giao dịch",
  ENTRY_DISABLED: "Đang chặn mở vị thế mới",
  ALL_TRADING_DISABLED: "Đã dừng cả mua và bán",
  LIVE_ACK_REQUIRED: "Chưa xác nhận cho phép giao dịch tiền thật",
  EXECUTION_FEE_OR_PROGRAM_POLICY_MISSING:
    "Thiếu giới hạn phí hoặc chính sách chương trình",
  JEV_API_KEY_MISSING: "Chưa cấu hình khóa TypeSafe",
  TYPESAFE_API_KEY_MISSING: "Chưa cấu hình khóa TypeSafe",
  JEV_NODE_VERSION_UNSUPPORTED: "Jev yêu cầu Node.js 22 trở lên",
  JEV_REQUIRES_NODE_22: "Jev yêu cầu Node.js 22 trở lên",
  JEV_NOT_VERIFIED: "Jev chưa có phản hồi thành công để xác minh",
  UNKNOWN_CREATOR_FUNDING:
    "Lý do của bản cũ: nguồn vốn người tạo chưa rõ; hiện chỉ để tham khảo",
  WS_NOT_STARTED: "Scanner đang dừng; WebSocket chưa khởi động",
  WS_NOT_CONNECTED: "WebSocket chưa kết nối",
  WS_UNCONFIGURED: "Chưa cấu hình WebSocket",
  NATIVE_CONFIRMATION_CANARY_REQUIRED:
    "Đường native cần hoàn thiện đối soát trước khi phát giao dịch",
  AI_FAILED: "Phân loại AI thất bại; chặn lệnh mua mới",
  CHAIN_MISSING: "Chưa có cấu hình chuỗi",
  CHAIN_EXPOSURE: "Vượt trần danh mục của chuỗi",
  PENDING_EXECUTION_RECONCILIATION_REQUIRED: "Cần đối soát giao dịch đang chờ",
  PENDING_EXIT_RECONCILIATION_REQUIRED: "Cần đối soát lệnh bán đang chờ",
  RPC_UNCONFIGURED: "Chưa cấu hình RPC",
  WEBSOCKET_UNCONFIGURED: "Chưa cấu hình kết nối thời gian thực",
  SOLANA_GENESIS_UNCONFIGURED: "Chưa cấu hình danh tính mạng Solana",
  NO_BROADCAST: "Chỉ mô phỏng, chưa phát giao dịch",
  UNKNOWN_LIQUIDITY: "Chưa xác minh được thanh khoản",
  UNKNOWN_HOLDER_CONCENTRATION: "Chưa rõ mức độ tập trung ví nắm giữ",
  UNKNOWN_TOKEN_VALIDITY: "Chưa xác minh tính hợp lệ của token",
  UNKNOWN_SECURITY_RISK: "Chưa đánh giá được rủi ro bảo mật",
  UNKNOWN_MINT_CAPABILITY: "Chưa xác minh quyền phát hành thêm token",
  UNKNOWN_FREEZE_CAPABILITY: "Chưa xác minh quyền đóng băng token",
  UNKNOWN_BLACKLIST: "Chưa xác minh khả năng chặn ví",
  UNKNOWN_UPGRADEABILITY: "Chưa xác minh quyền nâng cấp hợp đồng",
  UNKNOWN_PAUSABLE: "Chưa xác minh quyền tạm dừng token",
  UNKNOWN_TRANSFER_RESTRICTION: "Chưa xác minh hạn chế chuyển token",
  UNKNOWN_SELL_RESTRICTION: "Chưa xác minh khả năng bán token",
  UNKNOWN_CHAIN_SECURITY_POLICY: "Chưa cấu hình chính sách bảo mật cho chuỗi",
  LOW_LIQUIDITY: "Thanh khoản dưới mức tối thiểu",
  LIQUIDITY: "thanh khoản",
  INVALID_PRICE: "Giá không hợp lệ",
  HOLDER_CONCENTRATION: "Tỷ lệ tập trung ví vượt giới hạn",
  TOKEN_VALIDITY: "tính hợp lệ của token",
  INVALID_TOKEN: "Token không hợp lệ",
  MINT_CAPABILITY: "Token còn khả năng phát hành thêm",
  FREEZE_CAPABILITY: "Token còn quyền đóng băng",
  BLACKLIST: "Có khả năng chặn ví",
  UPGRADEABILITY: "Hợp đồng còn khả năng nâng cấp",
  PAUSABLE: "Có quyền tạm dừng token",
  TRANSFER_RESTRICTION: "Có rủi ro hạn chế chuyển token",
  SELL_RESTRICTION: "Có rủi ro hạn chế bán",
  SECURITY_RISK: "Rủi ro bảo mật vượt giới hạn",
  TAXES: "thuế mua/bán",
  EXTREME_TAX: "Thuế token vượt giới hạn",
  MALICIOUS_CREATOR: "Có dấu hiệu người tạo độc hại",
  CREATOR_FUNDING: "nguồn cấp vốn cho người tạo",
  KILL_SWITCH: "Đã kích hoạt ngắt khẩn cấp",
  MAX_TRADE_USD: "Giá trị lệnh vượt mức tối đa",
  LOW_SCORE: "Điểm chiến lược dưới ngưỡng",
  MAX_POSITIONS: "Đã đạt giới hạn số vị thế mở",
  PORTFOLIO_EXPOSURE: "Vượt giới hạn giá trị danh mục",
  TOKEN_EXPOSURE: "Vượt giới hạn giá trị mỗi token",
  DAILY_TRADES: "Đã đạt giới hạn số lệnh trong ngày",
  DAILY_LOSS: "Đã chạm mức lỗ tối đa trong ngày",
  FAILED_TRANSACTIONS: "Quá nhiều lần thực thi thất bại",
  PRICE_IMPACT: "Tác động giá vượt giới hạn",
  NOT_NEW_LAUNCH: "Token không còn thuộc nhóm mới ra mắt",
  AI_NOT_POSITIVE: "AI chưa đưa ra tín hiệu tích cực",
  NO_MOMENTUM: "Chưa có động lượng phù hợp",
  AI_UNAVAILABLE: "Dịch vụ AI không khả dụng",
  ANALYSIS_ERROR: "Phân tích gặp lỗi",
  STALE_FEATURES: "Dữ liệu phân tích đã cũ",
  DISCOVERY_CHANGED: "Chuỗi quét hoặc cài đặt đã thay đổi",
  PAPER_FILL: "Đã khớp lệnh mô phỏng",
  ROUTE_OR_SIMULATION_FAILURE: "Lấy báo giá hoặc mô phỏng thất bại",
  MANUAL: "Ngắt khẩn cấp được kích hoạt thủ công",
  DATABASE_INTEGRITY: "Lỗi toàn vẹn hoặc ghi nhật ký",
  DATABASE_UNHEALTHY: "Cơ sở dữ liệu không hoạt động ổn định",
  RPC_UNHEALTHY: "RPC không hoạt động ổn định",
  EXIT_EXECUTION_FAILURE: "Thực thi thoát lệnh thất bại",
  WORKER_ERROR: "Tiến trình bot gặp lỗi",
  STOP_LOSS: "Cắt lỗ",
  TRAILING_STOP: "Cắt lỗ bám đỉnh",
  MAX_HOLD_TIME: "Hết thời gian nắm giữ",
  LIQUIDITY_COLLAPSE: "Thanh khoản sụt giảm mạnh",
  WHALE_SELL: "Ví lớn bán bất thường",
  CREATOR_RISK: "Rủi ro từ người tạo",
  MONITORING: "Đang theo dõi",
  STALE_QUOTE: "Báo giá đã hết hạn",
  ROUTE_UNAVAILABLE: "Không có tuyến giao dịch",
  INVALID_SIMULATION_OUTPUT: "Kết quả mô phỏng không hợp lệ",
  DEX_UNCONFIGURED: "Chưa cấu hình DEX",
  LIVE_DISABLED: "Giao dịch tiền thật bị khóa",
  SIMULATION_FAILURE: "Mô phỏng thất bại",
  SELL_RESTRICTED: "Bán token bị hạn chế",
};
export function riskPresentation(
  candidate: import("@sniper/core").CandidateRecord,
) {
  const reasons = [
    ...new Set([...(candidate.risk?.reasons ?? []), ...candidate.reasons]),
  ];
  const missingData = (code: string) =>
    code.startsWith("UNKNOWN_") ||
    /(_UNKNOWN|_UNAVAILABLE|_INCOMPLETE)$/.test(code) ||
    code === "INSUFFICIENT_MARKET_DATA" ||
    code === "JEV_INSUFFICIENT_DATA";
  const title = reasons.map(reasonLabel).join(" · ");
  if (
    candidate.action === "REJECT" ||
    candidate.observation?.stage === "REJECTED"
  )
    return { label: "TỪ CHỐI", tone: "red", title };
  if (candidate.observation) {
    if (reasons.some(missingData))
      return { label: "CHƯA ĐỦ DỮ LIỆU", tone: "amber", title };
    return { label: "CHỈ QUAN SÁT", tone: "cyan", title };
  }
  if (candidate.risk?.passed) return { label: "ĐẠT", tone: "green", title };
  if (candidate.risk && reasons.length && reasons.every(missingData))
    return { label: "CHƯA ĐỦ DỮ LIỆU", tone: "amber", title };
  return {
    label: candidate.risk ? "TỪ CHỐI" : "CHƯA RÕ",
    tone: candidate.risk ? "red" : "muted",
    title,
  };
}
export const actionLabel = (code: string) => actions[code] ?? code;
export const statusLabel = (code?: string) =>
  code ? (statuses[code] ?? code) : "đang kết nối";
export const eventLabel = (code: string) => events[code] ?? "Sự kiện hệ thống";
export function reasonLabel(code: string): string {
  if (reasons[code]) return reasons[code];
  if (code.startsWith("UNKNOWN_"))
    return `Chưa có dữ liệu xác minh: ${reasons[code.slice(8)] ?? code.slice(8)}`;
  if (code.startsWith("EXIT_RETRY:"))
    return `Đang thử thoát lại: ${reasonLabel(code.slice(11))}`;
  if (code.startsWith("TAKE_PROFIT_"))
    return `Chốt lời tại mức tăng ${Number(code.slice(12)).toLocaleString("vi-VN")}%`;
  return `Mã trạng thái: ${code}`;
}
export const venueLabel = (code: string) =>
  ({
    "pump-fun": "PUMP",
    "pump-swap": "PUMPSWAP",
    "raydium-cpmm": "RAYDIUM",
    "meteora-dlmm": "METEORA",
    "pancakeswap-v2": "PANCAKE V2",
    "pancakeswap-v3": "PANCAKE V3",
    "pancakeswap-infinity-cl": "INFINITY CL",
    "pancakeswap-infinity-bin": "INFINITY BIN",
    "four-meme": "FOUR.MEME",
    openfour: "OPENFOUR",
    flap: "FLAP",
    "pons-v2": "PONS V2",
    bags: "BAGS",
    doppler: "DOPPLER",
    long: "LONG.XYZ",
    "uniswap-v2": "UNISWAP V2",
    "uniswap-v3": "UNISWAP V3",
    "uniswap-v4": "UNISWAP V4",
    "pools-trade-creator-v33": "POOLS · CREATOR 3.3",
    "pools-trade-standard-v33": "POOLS · STANDARD 3.3",
    "pools-trade-creator-v32": "POOLS · CREATOR 3.2",
    "pools-trade-standard-v32": "POOLS · STANDARD 3.2",
    "mock-discovery": "Nguồn phát hiện giả lập",
    "mock-constant-product": "Bể tích không đổi giả lập",
  })[code] ?? code;
