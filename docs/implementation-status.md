> Cập nhật local 27/10/2026: runtime hiện dùng một Node process + SQLite + ví cố định. Phần PostgreSQL/lease hoặc nhiều ví bên dưới là lịch sử trước refactor; không dùng để khởi động. Hướng dẫn hiện hành: [kiến trúc và migration local](local-migration.md), [Rug Check](rug-check.md).

# Trạng thái triển khai

Ngày 27/10/2026: nền tảng MOCK/PAPER giai đoạn1–7 được giữ lại. Runtime REAL đã nối RPC/discovery/features/HardFilter/Jev/strategy/risk/quotes/simulation/execution/position/UI/storage, nhưng chưa được xác minh toàn luồng với key và dữ liệu đủ policy.

**LIVE: NOT READY.** Không có giao dịch tiền thật nào được phát. Mã ký và receipt được kiểm tra bằng fixture trong bộ nhớ. Báo giá thật mua/bán Pancake V2 BNB và Robinhood đã nhận qua RPC chỉ đọc. Solana public RPC trả slot/genesis nhưng chưa pin hash trong cấu hình người dùng.

Các phần còn cần: Node22+, TypeSafe/Jupiter keys, RPC/WS có khả năng logs/simulation, fresh USD quote/oracle, ví/policy chương trình/phí, dữ liệu security/holder/creator bắt buộc. External provider chưa chọn không làm các metric thiếu biến thành SAFE. Không có fallback REAL→MOCK.

Hạn chế triển khai còn lại: discovery deep reorg dừng để đối soát thủ công, không tự đảo ngược giao dịch đã confirmed; file history quét tuyến tính; route selection chưa trừ gas giữa nhiều provider; không có HSM/HA/auth công khai; PostgreSQL migration chưa apply vì Docker daemon không chạy; outcome dài hạn và full live round-trip chưa kiểm tra trên mạng. Không gọi đây là bản tiền thật đã kiểm toán.

Xem [ma trận chi tiết](completion-plan.md), [kết quả kiểm tra](verification.md), [yêu cầu cấu hình](real-data.md) và [LIVE](live-trading.md).
