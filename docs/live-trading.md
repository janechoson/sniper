# Giao dịch tiền thật — chưa sẵn sàng

Trạng thái hiện tại NOT READY. Mã executor đã có và đã kiểm tra bằng RPC fixture, nhưng không phát giao dịch tiền thật trong tác vụ triển khai. Không tự bật LIVE_TRADING_ACK trong .env của người dùng.

Cập nhật: Helius HTTP/WS và số dư thật đã kiểm tra; production sizing mặc định10% tài sản đầu vào khả dụng. Vẫn thiếu đường chi native/wrap, một số policy phí/account, nguồn giá USD cùng chain và security/round-trip coverage. Xem [báo cáo hiện tại](live-activation-20261028.md) và `data/live-preflight.json`. EVM self-call simulation đã chạy được nhưng chưa chứng minh token bán được.

LIVE cần DATA_MODE=real, TRADING_MODE=live, LIVE_TRADING_ACK=true cùng readiness đạt: Node22/AI, RPC+WS, DEX deployment, fresh USD price, route provider, ví/signer, gas/debit/allowlist, storage và policy. ACK không bỏ qua RiskEngine hoặc UNKNOWN bắt buộc.

Trước dùng vốn cần xác minh discovery/market/security/holder coverage, Jev thật, round-trip, dry-run, migration/recovery và vận hành trên RPC đã chọn. Public RPC quote thành công không chứng minh eth_simulateV1 hỗ trợ. Chưa có kiểm thử tiền thật/canary; không đánh dấu READY từ unit tests.

Nếu receipt không rõ, giữ UNKNOWN, tiếp tục tra cứu; không resend, không thay nonce một cách tự động. Khi restart không khôi phục quyền ký từ intent cũ chưa broadcast. Exit chỉ giảm số lượng vị thế đã confirmed; pause/entry kill không chặn exit.
