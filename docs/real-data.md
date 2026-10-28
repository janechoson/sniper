# Dữ liệu thật và cấu hình

Dùng Node.js 22 trở lên cho TypeSafe SDK. Mặc định DATA_MODE=mock và TRADING_MODE=paper. Chuyển REAL bằng DATA_MODE=real, AI_PROVIDER=jev, TRADING_MODE=paper. Bỏ MODE/DATA_SOURCE cũ nếu xung đột. REAL tuyệt đối không tự chuyển sang mock khi RPC hoặc Jev lỗi.

Điền SOLANA_RPC_HTTP/SOLANA_RPC_WS, BNB_RPC_HTTP/BNB_RPC_WS hoặc ROBINHOOD_RPC_HTTP/ROBINHOOD_RPC_WS theo chuỗi sử dụng. Solana yêu cầu SOLANA_EXPECTED_GENESIS_HASH đã đối chiếu độc lập. Không đặt biến URL rỗng; để dòng đó ở dạng chú thích khi chưa dùng.

REAL_CONFIG_PATH mặc định config/real.json. config/real.example.json là cấu hình trống an toàn. pnpm reference:config tạo config/real.reference.json với deployment công khai đã kiểm tra code/router.factory/chain ID, không tự bật nó. Kiểm tra và sao chép thành cấu hình riêng rồi bổ sung tài sản định giá, nguồn USD, giới hạn phí và chương trình được phép.

quotes[chain] nhận address, symbol, decimals và usdPrice/usdPriceObservedAt/usdPriceSource hoặc usdOracle {chainId,address,expectedDescription,maxAgeSec,verifiedSource}. Giá snapshot chỉ hợp lệ 60 giây; oracle AggregatorV3 phải có code, đúng chain/description, answer dương, round hoàn chỉnh, timestamp còn mới. Không mặc định stablecoin bằng 1 USD. Chưa chọn feed triển khai cho người dùng.

REAL_ONCHAIN là dữ liệu đọc có bằng chứng blockchain; REAL_INTERNAL là thống kê từ tập quan sát nội bộ; ESTIMATED là suy ra giá spot/thanh khoản/điểm rủi ro; UNKNOWN là thiếu hoặc không chứng minh được. REAL_EXTERNAL hiện có adapter opt-in GoPlus/Honeypot/RugCheck cho security; chưa chọn external provider holder/creator toàn diện. Xem rug-check.md. Đọc holder-analysis.md để biết các metric còn thiếu.
