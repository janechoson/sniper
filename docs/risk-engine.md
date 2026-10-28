# Rủi ro và quyền thực thi

TradeIntentAuthority tạo intent bất biến gắn decision/risk IDs, wallet, chain, side, raw amount, provider/quote/deadline, slippage/impact, mode và policy thoát. Executor kiểm tra chính payload đã cấp và điều kiện hiện thời. Đổi settings, pause, kill hoặc fill làm thu hồi quyền cũ.

Entry kiểm tra HardFilter, AI/score, dữ liệu mới, size, số vị thế, trần token/chain/portfolio, số lệnh ngày, lỗ ngày UTC, lỗi liên tiếp và pending/UNKNOWN. Không có định giá/fee bắt buộc thì không chấp nhận entry LIVE. Trước commit kiểm tra lại revision danh mục để ngăn hai quyết định song song vượt hạn mức.

Round-trip mua rồi bán trên lượng tối thiểu nhận được. LIVE/dry-run cần bằng chứng simulation balance delta và fee USD cả hai chiều; RPC không hỗ trợ simulation thì fail closed. PAPER chỉ cho quote-only khi cấu hình requireSellSimulation=false, phải ghi hạn chế này.

ENTRY_DISABLED chặn mua mới, vẫn thoát vị thế. ALL_TRADING_DISABLED chặn cả mua/bán và cần xác nhận API/UI riêng; giao dịch đã gửi vẫn được đối soát. UNKNOWN submission giữ reservation, không tạo lệnh thay thế. Thất bại đã có receipt có thể tạo exit intent mới với idempotency riêng.
