# Thêm chuỗi

Thêm ChainConfig/env mapping và identity check (EVM chain ID hoặc Solana genesis), HTTP/WS URL từ tài liệu chính thức. Cấu hình quote/token decimals/native unit/fee và deployment có verifiedSource; không tự lấy địa chỉ chain khác.

Cài ProductionChainAdapter/market/security/holder phù hợp hoặc adapter mới theo interface; UNKNOWN cho metric chưa có. Thêm Risk policy chain, SwapProvider và executor nếu có broadcast. Fixture identity sai, reconnect/gap, raw quantities và fail-closed; sau đó chạy verifier chỉ đọc. Không bật live mặc định.
