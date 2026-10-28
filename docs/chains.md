# Các chuỗi blockchain

Mặc định MOCK/PAPER cho Solana, BNB và Robinhood. Runtime REAL có ProductionChainAdapter và bộ kết nối riêng; ENABLED_CHAINS quyết định chuỗi có thể chọn. Chuyển chuỗi không dừng quản lý/thoát vị thế cũ.

BNB chain ID56 và Robinhood mainnet4663/nativeETH đã kiểm tra trên RPC công khai; Solana đã đọc slot/genesis nhưng cần pin expected hash. HTTP/WS có timeout, giới hạn tốc độ và phục hồi; không dùng sequencer feed làm JSON-RPC WS.

Xem [Solana](solana.md), [BNB](bnb.md), [Robinhood](robinhood.md) và [cấu hình thật](real-data.md). Bảo mật/holder/creator thiếu bằng chứng giữ UNKNOWN, không suy ra SAFE từ việc RPC hoặc quote hoạt động.
