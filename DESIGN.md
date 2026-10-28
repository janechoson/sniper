# Bảng màu dashboard theo Papertrade

Tham chiếu: https://papertrade.xyz/ — kiểm tra ngày 2026-10-27. Phạm vi yêu cầu là màu chủ đạo; giữ bố cục, kiểu chữ, bo góc và chức năng dashboard hiện có.

## Bằng chứng

- Ảnh desktop 1440 × 1080 đã xem: [ảnh tham chiếu](data/papertrade-reference.png), chụp qua AnyAPI/Treg. Màu pixel xuất hiện nhiều nhất là `#f4ecd8` (428.951 pixel); đây là màu lấy mẫu từ ảnh, chưa xác nhận là biến CSS gốc. Canvas ASCII tạo nhiều biến thể rất gần nhau trên nền giấy.
- HTML đọc qua Firecrawl/Treg: wordmark SVG có `fill="#2A2520"`; cursor có `fill="#8B2020"`. Đây là giá trị xác nhận trực tiếp từ markup.
- Ảnh cho thấy nền kem vàng, chữ nâu đậm, chi tiết viền màu cát và nút giao dịch xanh olive trầm. Không suy ra màu hover/mobile từ ảnh desktop.
- Ảnh giao diện trong trang gốc: https://papertrade.xyz/assets/landing-trade-shot-1280-ofRgMuUN.webp . Chỉ dùng tham khảo màu, không đưa ảnh hoặc logo Papertrade vào sản phẩm.

## Token triển khai

| Vai trò         | Giá trị               | Cơ sở                                            |
| --------------- | --------------------- | ------------------------------------------------ |
| Nền             | `#f4ecd8`             | Lấy mẫu ảnh tham chiếu                           |
| Chữ chính       | `#2a2520`             | SVG gốc                                          |
| Màu rủi ro      | `#8b2020`             | Màu cursor gốc, áp dụng làm màu trạng thái       |
| Card            | `#faf5e8`             | Màu phối đề xuất, sáng hơn nền                   |
| Sidebar/header  | `#f1e8d3`             | Màu phối đề xuất                                 |
| Nền phụ         | `#eee5cf`             | Màu phối đề xuất                                 |
| Viền            | `#dcd1b8`             | Màu phối đề xuất                                 |
| Chữ phụ/UNKNOWN | `#736957`             | Màu phối đề xuất, dễ đọc trên nền kem            |
| Xanh olive      | `#526548`             | Phối theo ảnh, không phải giá trị CSS trích xuất |
| Hover/chọn      | `#eee4cb` / `#e7dcc1` | Màu phối đề xuất                                 |

Các biến nằm ở đầu apps/web/app/globals.css. Card bo 17px và bóng đổ nâu nhẹ giữ độ nổi hiện có. Input sáng, bảng/biểu đồ dùng nền kem phụ và viền cát; badge giữ phân biệt xanh/đỏ/vàng và UNKNOWN. Không đổi kích thước hoặc thứ tự các thành phần.

Theo yêu cầu mới nhất, Nhật ký dùng cùng nền giấy kem `#f4ecd8` với dashboard, chữ nâu đậm, badge pastel và chiều cao có giới hạn. Không thêm họa tiết ASCII vào bảng dữ liệu vì yêu cầu chỉ đổi màu.

## Kiểm tra

Dùng scripts/browser-smoke.mjs để xác nhận màu nền mới, trạng thái UNKNOWN, bo góc/bóng đổ, nhật ký kem đồng bộ và cuộn, bốn menu, bảng nguồn, desktop/mobile và payload công khai. Không thay đổi chế độ REAL/PAPER, sizing hoặc bất kỳ logic giao dịch nào.

Đã kiểm tra: build/typecheck, lint và Chrome smoke đều đạt; các viewport 1920/1440/1366/820/390. Ảnh kết quả nằm ở data/dashboard-{width}.png. Màu đã áp dụng vào instance local hiện có bằng stylesheet đã build; bản build kế tiếp dùng tên asset mới bình thường. Trình duyệt đã cache stylesheet cũ cần Ctrl+F5 một lần.
