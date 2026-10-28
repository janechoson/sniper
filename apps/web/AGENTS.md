# Hướng dẫn phát triển giao diện

## Tra cứu đúng phiên bản Next.js

Phiên bản Next.js đang cài có thể thay đổi API, quy ước và cấu trúc thư mục so với kiến thức có sẵn. Trước khi viết mã, đọc hướng dẫn tương ứng trong `node_modules/next/dist/docs/`, tính từ thư mục này. Trong monorepo, gói `next` có thể không được tìm thấy từ thư mục gốc. Chú ý các cảnh báo API đã lỗi thời.

## Ngôn ngữ

Nội dung giao diện, thông báo và tài liệu sử dụng tiếng Việt. Giữ nguyên tên API, biến môi trường, trường JSON và mã định danh để bảo đảm tương thích. Các mã kỹ thuật có nhãn tiếng Việt khi hiển thị cho người dùng. Cấu hình hiện REAL/LIVE theo ủy quyền chủ ví, ACK=true, scanner tự chạy; chỉ Solana nằm trong execution.liveChains. Không tự thêm chain hoặc nới risk để có trade; xem docs/live-start-20261028.md. Production sizing mặc định10% vốn tài sản đầu vào khả dụng; ngân sách5USD chỉ thuộc chế độ quan sát cũ. Không nạp mock/fixture vào runtime. Đọc docs/live-handoff.md và docs/live-activation-20261028.md ở gốc repository trước khi chuyển sang LIVE hoặc thay sizing.

`agentRules: false` ngăn Next.js tự chèn lại khối hướng dẫn tiếng Anh; tài liệu đi kèm phiên bản đang cài vẫn là nguồn tham khảo kỹ thuật chính.
