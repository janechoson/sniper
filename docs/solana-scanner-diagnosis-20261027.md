# Kiểm tra scanner Solana ngày 2026-10-27

## Kết quả kiểm tra trực tiếp

- Scanner Solana đang được bật trong REAL/PAPER quan sát. Chọn Solana ở thanh điều khiển không tắt scanner BNB hoặc Robinhood trong OBSERVATION_ONLY.
- Lúc kiểm tra, SQLite có **5 `real.discovery` Solana**, đều từ Raydium CPMM, và **276** discovery BNB. Không dùng số lượng dòng candidate để đếm pool vì candidate có thể cập nhật nhiều lần.
- Snapshot chỉ trả 100 candidate gần nhất của tất cả chuỗi; trong lần đọc ban đầu có 99 BNB và 1 Solana. Bảng Tổng quan chỉ hiện 6 dòng, do đó các dòng BNB mới đẩy Solana ra khỏi phần nhìn thấy. Đây không phải bằng chứng scanner Solana đã tắt.
- HTTP `getSignaturesForAddress` của cả Raydium CPMM và Meteora DLMM trả về các signature thật mới. Đường đọc HTTP không bị mất kết nối ở lần thử này.
- WebSocket cấu hình hiện tại mở được kết nối, nhưng phép thử 30 giây không nhận ACK đăng ký hoặc thông báo. Thử lại bằng chính `RecoveringRpcSocket` của dự án nhận `WS_RPC_TIMEOUT` sau khoảng 7,7 giây; health lúc đó vẫn báo `READY`, không có reason. Đây là lỗi báo trạng thái trong mã nguồn.
- Phạm vi discovery Solana hiện là Raydium CPMM và Meteora DLMM, chỉ nhận pool mới với cặp quote được cấu hình WSOL/USDC. Không bao phủ Pump.fun, PumpSwap, Raydium AMM v4 hoặc toàn bộ mint Solana. HTTP fallback chỉ lấy mẫu 5 signature/program mỗi 15 giây, không bảo đảm đầy đủ.

## Đã sửa

- `RecoveringRpcSocket` ghi nhận `WS_RPC_TIMEOUT` và `WS_RPC_ERROR`; kết nối mở nhưng chưa có subscription được ACK không còn báo READY. Không đưa thông báo thô của provider vào health.
- Adapter đăng ký độc lập cho từng DEX: lỗi một subscription không bỏ qua DEX còn lại. Thử lại những subscription thất bại mỗi 30 giây, không đăng ký trùng subscription đã thành công. HTTP polling vẫn hoạt động.
- Snapshot bổ sung health WebSocket theo từng chuỗi, không có URL hoặc credentials. Giao diện phân biệt RPC HTTP với WebSocket, hiển thị dùng HTTP dự phòng và cảnh báo Solana có thể bỏ sót pool khi lấy mẫu.
- Thanh chọn chuỗi ghi rõ chế độ quan sát quét tất cả; bảng scanner có phân bố chuỗi trong 100 candidate gần nhất.
- Thêm regression test với WebSocket server cục bộ cho timeout không ACK, lỗi provider được làm sạch/khôi phục, đăng ký hai DEX và retry có giới hạn.

## Giới hạn còn lại

Sửa retry và health không thể buộc endpoint bên ngoài gửi ACK. Nếu provider tiếp tục không phản hồi đăng ký, Solana vẫn chỉ có discovery lấy mẫu từ HTTP và có thể bỏ sót pool. Muốn luồng sự kiện ổn định cần endpoint Solana WebSocket có hỗ trợ và phản hồi `logsSubscribe`; không tự thay provider hoặc key trong `.env`. Không tăng quét vô hạn, không tạo token để lấp bảng, không đánh dấu market windows đầy đủ khi chưa có coverage.

Giữ PAPER/quan sát 5 USD; không đổi sizing, RiskEngine, Jev, signer hoặc quyền phát giao dịch.

## Xác minh sau sửa

`pnpm test`: 159 đạt, 4 kiểm thử mạng tùy chọn bỏ qua. `pnpm lint`, typecheck trong `pnpm build`, build production và `pnpm test:browser`: đạt. Ba regression test WebSocket chỉ chạy máy cục bộ.

Đã khởi động lại ứng dụng. Snapshot thật: HTTP Solana healthy, WebSocket DEGRADED với `WS_RPC_TIMEOUT` và `WS_SUBSCRIPTION_UNAVAILABLE:meteora-dlmm`. Subscription Raydium đã được ACK ở lần khởi động này; Meteora chưa ACK. Đây là trạng thái kết nối ở thời điểm kiểm tra, không cam kết đủ coverage hoặc chắc chắn thu được pool mới trong mọi khoảng thời gian. PAPER, ngân sách mô phỏng 5 USD, liveEnabled=false, executions=0.
