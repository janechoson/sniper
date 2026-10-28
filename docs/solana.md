# Solana

RPC: getGenesisHash/getSlot/account/token APIs, HTTP có timeout/retry giới hạn, WebSocket logs với reconnect và polling phục hồi. Kiểm tra công khai đã đọc được slot và genesis; không coi danh tính mạng đã sẵn sàng khi chưa cấu hình expected hash.

Discovery Raydium CPMM và Meteora DLMM dùng IDL chính thức ghim commit cùng SHA256 ở packages/chains/idl. Giải mã initialize, log swap CPMM và CPI Swap2Evt DLMM. Quét signature có giới hạn; khi đầy khoảng lịch sử mà không tìm được cursor thì báo thiếu coverage. Không tự đánh dấu cửa sổ đủ dữ liệu.

Market đọc pool/vault/active bin và giao dịch thực, không tạo khối lượng hoặc số ví bằng 0 khi thiếu coverage. Liquidity là ước tính inventory, không chứng minh độ sâu thực thi. Mint/Token-2022 phân tích quyền mint/freeze, extension và fee. Holder chỉ tính khi largest accounts khớp toàn bộ supply tại cùng context; pool creator không phải token deployer.

Jupiter Swap V2 /order và /build dùng API key riêng và allowlist program/account-owner. Không dùng transaction opaque chưa kiểm tra. Giữ raw amounts, kiểm tra ALT, payer, signer và pre/post token authority/balance. Chỉ hỗ trợ tài sản quote đã có SPL ATA; không tự wrap SOL hoặc tiêu tài sản khác.

Dry-run và round-trip dựng transaction chỉ mô phỏng; LIVE cần genesis, ví, phí, program/owner allowlist và ACK. Xác nhận finalized rồi mới mở vị thế. Hiện PARTIAL: thiếu key/Jupiter, ví và cấu hình USD/allowlist; chưa xác minh full pipeline hoặc broadcast trên mạng thật.
