> Cập nhật local 27/10/2026: runtime hiện dùng một Node process + SQLite + ví cố định. Phần PostgreSQL/lease hoặc nhiều ví bên dưới là lịch sử trước refactor; không dùng để khởi động. Hướng dẫn hiện hành: [kiến trúc và migration local](local-migration.md), [Rug Check](rug-check.md).

# Kiến trúc hiện tại

Giữ nguyên monorepo và quy trình MOCK/PAPER. apps/bot chọn PaperEngine cho DATA_MODE=mock, RealTradingEngine cho DATA_MODE=real. Giao diện Next.js chỉ nhận dữ liệu công khai qua API cục bộ và SSE. StrategyEngine/RiskEngine không import TypeSafe SDK.

Luồng thật: ProductionChainAdapter → discovery inbox bền vững → ProductionFeatureEngine → HardFilter → JevAIProvider → Score/Strategy → kiểm tra danh mục → quote/round-trip → TradeIntentAuthority → durable execution → confirmed fill → AtomicPositionManager. Giới hạn hàng đợi, RPC, số pool và quan sát giúp tránh quét vô hạn.

APPROVED intent được ghi trước tác động bên ngoài; hash/signature ghi trước broadcast. Lỗi phản hồi chuyển UNKNOWN và chỉ tra cứu receipt, không gửi lại. Khi khởi động lại, intent chưa đến bước broadcast được hủy, fill đã xác nhận được áp dụng một lần. Các giao dịch REAL/PAPER, REAL/DRY_RUN và REAL/LIVE có namespace và nhật ký riêng.

Repository dùng JSONL fsync hoặc PostgreSQL journal cùng projection trong transaction. PostgreSQL có lease một worker. Các projection ví, intent, approval, execution, creator, cursor và observation đã có migration. Chưa xác minh migration trên PostgreSQL đang chạy; lịch sử REAL phân trang từ PostgreSQL hoặc quét JSONL với bộ nhớ theo kích thước trang. Analytics nhóm vẫn giới hạn cache maxPools × 20 quyết định.
