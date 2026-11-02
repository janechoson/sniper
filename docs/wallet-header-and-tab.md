# Kronos — bỏ tab riêng và hiển thị số dư SOL

02/11/2026, Asia/Bangkok.

Đã bỏ nút/tab Kronos khỏi dashboard; giữ model, các API và policy quyết định. Các màn Tổng quan, Positions, Lịch sử, Cấu hình, Log và Thống kê vẫn có.

`DISAGREEMENT_OR_FLAT_UNCERTAIN` là kết quả bình thường: giá cuối kỳ của các đường dự báo chưa đồng thuận tăng/giảm hoặc có đường đi ngang so với giá đóng nến gần nhất. Khi chưa có vị thế: WAIT; khi đã có vị thế: HOLD. UI giải thích bằng tiếng Việt; mã gốc được giữ trong dữ liệu để đối chiếu. Không thay điều kiện BUY/SELL.

Ô MARKET/TRADING được thay bằng SOL của ví Kronos và thời điểm cập nhật. Backend bổ sung projection `wallet` cho GET status/overview, gọi RPC getBalance hiện hữu, single-flight và cache 15 giây. Không dùng signer, không ghi DB, không tạo GMGN consumer. Frontend giữ nguyên lamports bằng BigInt; thiếu/quá hạn 45 giây hiển thị `SOL: —`, không tự giả thành 0. Số dư bằng 0 đã đọc được vẫn hiển thị 0. Badge chế độ LIVE/PAPER còn nguyên.

Kiểm chứng: 2 cache tests PASS; actual temp-server API test PASS; browser regression PASS (bỏ tab, lý do uncertainty, số dư thật/0/thiếu/quá hạn, các màn và 1440/1024/390, không mutation requests); typecheck và lint PASS; compile TypeScript sang thư mục riêng PASS. Logs: `evidence/wallet-header-*.log`. Không rebuild đè dist đang chạy.

Checkpoint 17:22:10 Bangkok: Kronos PID 15012 vẫn LIVE, enabled=true, dryRun=false. Backend của tiến trình này chưa có trường wallet. Static UI đã được cập nhật, có thể tải lại bằng Ctrl+F5; phần số dư sẽ ghi `Chờ API số dư` cho tới khi backend mới được nạp. Chưa pause/restart bot, chưa bật/tắt collection và chưa gửi giao dịch từ tác vụ. BOT B không được sửa hoặc restart. Đã hỏi quyền restart riêng Kronos vì yêu cầu trước đó của user là không pause/restart.

Files: `public/index.html`, `public/overview.js`, `src/server.ts`, `src/wallet-balance.ts`, `tests/wallet-balance.test.ts`, assertions trong `tests/kronos.test.ts`, scripts UI regression và tài liệu/evidence. Không thay execution/strategy, dữ liệu giao dịch hoặc `.env`.

User sau đó đã cho phép restart riêng Kronos. Standard build PASS. Sau pause tạm và kiểm tra active=false/pending=0, lệnh dừng PID 15012 bị automatic approval review chặn bởi policy, nên chưa restart. Đã khôi phục LIVE/collection lúc 17:28:27 Bangkok trên cùng PID; backend balance vẫn chờ restart thủ công. Không dừng/pause BOT B. Xem `paperdao-colors.md` để phân biệt công việc màu CSS với lần restart backend được phê duyệt riêng.
