# BNB Chain

Cập nhật discovery 2026-10-27: cấu hình quan sát có 10 deployment gồm Four.Meme, OpenFour, Flap, PancakeSwap V2/V3/Infinity CL/Bin và Uniswap V2/V3/V4. Xem [ma trận coverage, địa chỉ, ABI, checkpoint và nguồn chưa xác minh](discovery-coverage-bnb-robinhood.md). Các đoạn dưới mô tả adapter/giới hạn đã có từ trước; không đại diện toàn bộ coverage mới.

Chain ID 56 đã được kiểm tra trên RPC công khai. PancakeSwap V2 factory/router trong config/real.reference.json đã đối chiếu tài liệu chính thức và RPC code/factory/WETH. Đã nhận quote mua và bán thật; báo cáo cục bộ ở data/verify-deployments.json. Đây là quote chỉ đọc, không có fill hay giao dịch tiền thật.

Discovery V2 PairCreated và V3 PoolCreated đọc từng khoảng block có giới hạn, chờ confirmation depth và lưu cursor sau khi callback đã ghi inbox. Public RPC BNB trả RPC_CODE_-32005 khi lấy log trong lần kiểm tra; cần RPC có quyền eth_getLogs và dữ liệu lịch sử. Không suy ra discovery thành công từ việc quote thành công.

Market V2 reserves, V3 slot0 và inventory; Swap logs tạo cửa sổ thật. Metadata ERC20/EIP1967 có bằng chứng; ownership không chứng minh quyền mint/tax/blacklist. Holder/creator tổng quát vẫn UNKNOWN khi không có nguồn tin cậy.

Swap V2 direct hỗ trợ quote/build, exact approval, simulation, gas budget, nonce lock và receipt depth. V3 hiện hỗ trợ giao diện IQuoter V1 đã khai báo; không tự coi Quoter V2 có ABI tương thích. LIVE cần eth_simulateV1 balance proof, nguồn USD, ví và ACK. Chưa xác minh simulation/broadcast trên RPC thật.
