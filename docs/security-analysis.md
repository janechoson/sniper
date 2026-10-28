# Phân tích bảo mật

Solana: unpack mint bằng SPL Token, owner program, mint/freeze authority, Token-2022 extensions và transfer fee. Extension nguy hiểm hoặc chưa được hỗ trợ khiến hạn chế/UNKNOWN; không gắn nhãn toàn token SAFE vì mint authority đã tắt.

EVM: bytecode, ERC20 decimals/supply/name/symbol, owner nếu đọc được, EIP1967 implementation/admin slots. Không có ABI tổng quát chứng minh thuế, blacklist, pause hoặc quyền mint tùy biến. Các trường đó giữ UNKNOWN; ownership không được dùng làm creator.

HardFilter chạy trước AI và giữ policy UNKNOWN theo chain. Policy hiện khá chặt: dữ liệu nguồn cấp vốn creator, concentration và cờ bảo mật chưa chứng minh có thể chặn hầu hết ứng viên REAL. Đây là giới hạn dữ liệu được hiển thị, không tự hạ ngưỡng để tạo giao dịch.
