# Bảo vệ ví

Không đưa API key, mnemonic, private key, seed hoặc signer material vào chat, trình duyệt, AI, snapshot hay nhật ký. SecretProvider chỉ ở tiến trình bot. Redaction đệ quy che trường auth/secret/RPC URL/DB URL và vòng tham chiếu. API không trả secretRef.

FileSecretProvider giới hạn root/path/file size, chặn symlink/traversal và quyền POSIX quá rộng; trên Windows cần ACL tài khoản máy phù hợp. Dự án hiện phục vụ local loopback, chưa có HSM/KMS/hardware wallet hoặc ký phân tán. Không coi local-env là kho khóa production đã kiểm toán.

Đổi khóa sau khi nghi bị lộ. Không xóa nhật ký pending để chạy lại lệnh. Khi không rõ kết quả broadcast, đối chiếu receipt/signature và số dư; dừng entry trong thời gian đối soát.
