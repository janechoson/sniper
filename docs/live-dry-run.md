# Kiểm tra giao dịch không phát

Báo cáo hiện tại, ma trận từng chain và các lệnh kiểm tra: [LIVE_DRY_RUN](live-dry-run-report-20261028.md). Solana/BNB đã có EXECUTION_PREFLIGHT thật; chưa có candidate được chiến lược duyệt, Robinhood reverse simulation còn bị chặn. Không đồng nhất preflight với LIVE_READY.

DATA_MODE=real, AI_PROVIDER=jev, TRADING_MODE=live_dry_run (hoặc LIVE_DRY_RUN=true với paper). Không kết hợp LIVE_DRY_RUN=true và TRADING_MODE=live. Không có broadcast trong chế độ này và không tạo vị thế OPEN từ simulation.

Dùng quote thật, build, calldata/program guards, kiểm tra số dư/allowance/gas và mô phỏng balance delta. EVM dry-run thiếu allowance báo cần approval, không gửi approval. Solana cần ATA/allowlist/phí phù hợp. Bằng chứng stateful round-trip không dựa balance override giả.

Cần Node22, RPC hỗ trợ simulation, ví đã cấu hình, token quote/nguồn USD, TypeSafe key và Jupiter key nếu Solana. DRY_RUN_SUCCEEDED là kết quả mô phỏng có bằng chứng, không phải transaction confirmation. Chưa chạy dry-run đầy đủ trên RPC thật trong lần triển khai này.
