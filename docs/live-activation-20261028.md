# Chuẩn bị giao dịch thật — CHƯA SẴN SÀNG

**Bản checkpoint trước khi hoàn thiện native.** Xem [báo cáo LIVE_DRY_RUN mới](live-dry-run-report-20261028.md): native SOL/V2, fee reserve, nguồn USD, Jev và WS health đã bổ sung. Những mô tả “chưa triển khai” bên dưới ghi lại trạng thái checkpoint cũ; không dùng làm báo cáo hiện tại. LIVE vẫn chưa bật.

Cấu hình cục bộ: DATA_MODE=real, TRADING_MODE=live_dry_run, OBSERVATION_ONLY=false, OBSERVATION_AUTO_START=false, LIVE_TRADING_ACK=false, REAL_CONFIG_PATH=config/live.json. LIVE_DRY_RUN=false là cờ phụ; TRADING_MODE=live_dry_run vẫn chọn chế độ không phát giao dịch. Không mua/bán thật, không wrap/chuyển tiền, không reset SQL hoặc nhập lại journal cũ.

## Kết nối đã xác minh

HTTP và WebSocket Helius trong `.env` đúng cấu trúc [endpoint chính thức](https://www.helius.dev/docs/api-reference/endpoints). Giữ nguyên key người dùng đã nhập. HTTP đọc được slot và genesis hash Solana mainnet; WS nhận slot notification. Bằng chứng đã loại URL/key/địa chỉ: `data/helius-preflight.json`. Thời gian trong JSON là UTC của máy chạy, có thể khác ngày địa phương trong tên tài liệu.

`pnpm verify:live` chỉ đọc RPC/derive địa chỉ, không ký/send/approve; ghi `data/live-preflight.json`. Đây là báo cáo chẩn đoán, luôn trả ready=false và exit2 khi chưa chứng nhận đầy đủ, không phải công cụ tự bật LIVE. Lần kiểm tra sau đổi Helius đọc được 0,305050641 SOL, 0,045 BNB, 0,015 ETH trên Robinhood. USDC/WSOL/WBNB/USDT/WETH/USDG được cấu hình đều có số dư0. Các số dư chỉ là ảnh chụp tại thời điểm kiểm tra, không phải vốn cố định.

Signer local đã nhận key Solana base58 hoặc JSON64bytes; sửa lỗi zero buffer làm hỏng secret trong Keypair. Test ký bằng key fixture và xác minh Ed25519, không dùng ví thật để ký. Health signer cả ba chain là READY, không đồng nghĩa trading READY.

Jupiter đã trả quote thật, không ký/build/send trong phép thử tại `data/live-jupiter-preflight.json`. EVM eth_simulateV1 self-call thành công ở BNB/Robinhood; self-call không chứng minh sellability hay round-trip của token.

## Sizing đã thay đổi

Production mặc định positionSizePercent=10, dùng số dư mới của tài sản đầu vào, bigint/base units. Native fee reserve phải được cấu hình và đủ số dư. Với đầu vào token, native reserve không bị trừ vào token; với native, reserve được trừ trước khi tính phần trăm. Các adapter production hiện chưa hỗ trợ trực tiếp chi native hoặc tự wrap.

Entry được tuần tự hóa; pending execution chặn entry mới. Đọc lại balance trước duyệt: amount thay đổi thì từ chối để lấy quote và đánh giá lại. Snapshot sizing nằm cùng durable execution intent. Không tự giảm10% để vừa cap; maxTradeUsd/maxTokenExposure và các cap portfolio/chain/ngày vẫn có quyền từ chối. Chưa phải10% tổng giá trị mọi tài sản trong ví; chưa hỗ trợ chia reservation cho nhiều execution song song.

## Điểm chặn còn lại

- Ví hiện có native coin nhưng tài sản token đầu vào bằng0. EVM chưa có adapter native/wrapped; Solana chưa hoàn thiện đường chi native. Không tự chuyển tiền để giải quyết.
- Thiếu cấu hình gas/native reserve EVM và policy phí/account owner Solana. Không tự đặt giá trị tùy ý để qua readiness.
- Nguồn USD SOL/Robinhood đang tham chiếu feed trên BNB. Production từ chối cross-chain reference làm giá được chứng nhận.
- Chưa xác minh token round-trip mua/bán, balance delta và toàn bộ security coverage trên RPC đang chọn. Creator knownBadFunding vẫn UNKNOWN vì chưa có provider; không gán false/SAFE. Metric thiếu tiếp tục UNKNOWN và có thể chặn entry.
- Chưa chạy dry-run đầy đủ trên một token được duyệt; chưa có canary/receipt giao dịch thật. Không thể đánh dấu LIVE READY từ việc RPC/key hoạt động.

Kiểm tra mã trước cập nhật tài liệu: 281 tests pass,4 optional network tests skip; lint/typecheck và production build pass. Các tests ký dùng fixture. Helius đã qua HTTP/WS/read balance trực tiếp. Cần tiếp tục hoàn thiện các điểm chặn trước thao tác kích hoạt của chủ ví.

Đã khởi động lại dashboard tại http://127.0.0.1:3000. Snapshot xác nhận source=RPC, mode=LIVE_DRY_RUN, running=false, liveEnabled=false, executions=0, không có observation ledger; settings.positionSizePercent=10. Runtime còn báo JEV_NOT_VERIFIED vì instance mới chưa xác minh Jev, và WS_NOT_CONNECTED khi scanner đang dừng; phép kiểm tra WS Helius độc lập đã nhận slot. Kiểm tra Chrome chỉ đọc:5 kích thước390–1920px không tràn ngang, không page error, tên ứng dụng và nhãn không phát giao dịch đúng; snapshot/settings không chứa các key ví/API hay API key Helius trong URL. Không bấm nút quét hoặc thực hiện lệnh.
