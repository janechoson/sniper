# Khắc phục sự cố

REAL_MODE_REQUIRES_JEV hoặc xung đột MODE/DATA_SOURCE: bỏ biến cũ, dùng DATA_MODE=real/AI_PROVIDER=jev/TRADING_MODE=paper. Không tự đổi mock để che lỗi.

JEV_NODE_VERSION_UNSUPPORTED: dùng Node22+. AI_FAILED: kiểm tra key tại console TypeSafe, quota/401/429 và timeout; không dán key vào log. Quote lỗi trên Solana: kiểm tra JUPITER_API_KEY, mint, raw amount/decimals và allowlist.

RPC_CODE_-32005 trên BNB: provider giới hạn log; dùng endpoint/quyền phù hợp, fromBlock hợp lý. Không quét toàn chain. UNCONFIGURED genesis: đối chiếu hash của mạng Solana dự định dùng rồi cấu hình; không tự tin RPC chỉ vì URL đúng.

UNKNOWN holder/creator/tax: metric không lấy được đáng tin cậy. Bổ sung nguồn đã chọn, không ép 0/false/SAFE. QUOTE_USD_PRICE fail: snapshot quá 60 giây hoặc oracle stale/description sai/không có code; cấu hình feed được xác minh.

UNKNOWN execution: giữ journal và pending reservation, tra receipt/signature. Không tự resend hoặc xóa record. LIVE_COST_OR_SELL_SIMULATION_UNKNOWN: RPC không hỗ trợ stateful simulation/fee USD; chọn RPC thích hợp. DB down: mở dịch vụ và kiểm tra migration, không chuyển driver để bỏ qua dữ liệu.

Cảnh báo bigint native bindings dùng JS fallback ảnh hưởng hiệu năng; fixture và build vẫn chạy. Dùng pnpm audit --prod để xem advisory hiện tại, không ép dependency ESM vào CommonJS nếu chưa kiểm tra tương thích.
