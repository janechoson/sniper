# Robinhood Chain

Cập nhật discovery 2026-10-27: cấu hình quan sát có 16 deployment, gồm Pons V2, Long.xyz, Bags, Flap, OpenFour, Doppler, pools.trade và các phiên bản PancakeSwap/Uniswap đã xác minh. Xem [ma trận trước/sau, địa chỉ/ABI và giới hạn](discovery-coverage-bnb-robinhood.md). Curve/pool singleton có thể xuất hiện trước khi bot có market/execution adapter cho nó; không đồng nghĩa LIVE sẵn sàng. Các đoạn dưới là kiểm tra nền tảng/V2 trước lần mở rộng này.

Mainnet EVM chain ID 4663, native ETH; testnet 46630 là mạng khác. RPC công khai đã trả đúng chain ID và block. Sequencer feed không phải JSON-RPC WebSocket. Xem [kết nối chính thức](https://docs.robinhood.com/chain/connecting/).

Tài liệu PancakeSwap hiện liệt kê deployment V2 cho Robinhood. Đã kiểm tra router.factory, code, wrapped ETH và nhận quote mua/bán thật qua RPC. Đã truy vấn log trong khoảng hữu hạn; không có sự kiện mới trong khoảng đó không chứng minh scanner chạy lâu dài. Địa chỉ nằm trong config/real.reference.json, có verifiedSource.

Dùng cùng adapter EVM, Market/Security/Swap V2 và executor như BNB với chain ID/nonce/fee riêng. Không coi khả năng eth_simulateV1 hoặc dữ liệu holder đã được hỗ trợ chỉ vì chain tương thích EVM.

PARTIAL: RPC và quote thực đã kiểm tra; WS riêng, feed USD, lịch sử discovery, bảo mật/holder/creator bắt buộc, ví và mô phỏng LIVE chưa được xác minh đầy đủ. Không còn blocker tài liệu địa chỉ Pancake V2; còn blocker cấu hình và dữ liệu.
