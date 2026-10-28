# Ví cố định và thực thi

TradingWallet đọc EVM_PRIVATE_KEY (0x + 64 ký tự hex) và SOLANA_PRIVATE_KEY (JSON keypair 64 byte). EVM_WALLET_ADDRESS/SOLANA_WALLET_ADDRESS cho watch-only hoặc đối chiếu địa chỉ. Không có CRUD, lựa chọn ví, activeWalletByChain hoặc nhập khóa từ web. API /wallet trả địa chỉ và trạng thái signer; /wallet-balance chỉ nhận chainId. Không trả secretRef, raw key hoặc raw signed transaction. Các adapter ví cũ còn phục vụ compatibility/test; runtime không đọc wallets.json.

walletId trong intent/vị thế vẫn là khóa lịch sử, không còn nguồn routing. Mỗi intent vẫn ràng buộc walletAddress; khóa thay đổi không thể ký intent cũ. Một signer EVM dùng cho BNB/Robinhood, một signer Solana riêng vì thuật toán ký khác nhau.

Vốn được kiểm tra trước intent, intent lưu trước side effect; global pending gate ngăn phân bổ vốn trùng. UNKNOWN giữ chỗ đến khi có bằng chứng. Dự phòng phí, số dư token, danh mục/exposure/daily loss đều kiểm tra theo policy. Không tự chuyển ví hoặc wrap SOL.

EVM: nonce lock ví/chain; exact approval, zero-reset khi cần, không unlimited; simulation/calldata/address/balance guards và gas cap. Lưu hash trước broadcast, receipt + Transfer net delta trước fill. Approval có record riêng và phí vào kế toán.

Solana: payer/one signer, program/owner allowlist, ALT, source/destination ATA, delegate/frozen/authority và native debit cap; finalized receipt trước xác nhận. SDK AI không truy cập signer.

Restart chỉ đối soát receipt PENDING/SUBMITTING/UNKNOWN bằng hash đã lưu, không tự resend. Intent chưa broadcast bị hủy an toàn, fill confirmed apply idempotent. SQLite journal/projections cùng transaction. Xem [migration, backup, restore](local-migration.md).
