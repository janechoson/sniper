# Sửa HISTORY / INSUFFICIENT_MARKET_HISTORY — 2026-11-01

Lỗi không phải yêu cầu token phải đủ 60 phút tuổi. `60m` là khoảng nhìn ngược được request; token trẻ hơn dùng phần lịch sử thực có, không padding.

## Nguyên nhân đã xác nhận

Audit SQLite có token trên 7 giờ tuổi vẫn nhận `availableHistory=0`. Read-only GMGN K-line probe trả 60 nến, với một bar mẫu:

```json
{"time":1793504520000,"open":"0.00029360248","close":"0.00031329725","high":"0.00032054408","low":"0.00028586856","volume":"1487.10524076","amount":"4923681.514648001"}
```

Parser trước đó giả định `time` là seconds và luôn nhân 1000. Giá trị đã là milliseconds bị nhân thêm lần nữa, rồi toàn bộ nến bị loại như dữ liệu tương lai. Fixture cũ chỉ có seconds nên không phát hiện lỗi này.

Response thực tế cũng cho thấy `volume` là USD, `amount` là số token; parser trước đó đã dùng ngược trường theo bảng mô tả CLI không khớp payload thực.

## Thay đổi

- `src/market-history.ts`: nhận milliseconds và legacy seconds; dùng đúng trường USD volume; thêm diagnostics gồm số row đầu vào, đơn vị timestamp và số row loại theo nguyên nhân.
- `src/one-shot-entry.ts`: Action Log thêm số nến hợp lệ/nhận được và số phút history thực; giữ fail-closed nếu thiếu hoặc stale.
- `tests/fixtures.ts`, `tests/one-shot-fixtures.ts`: fixture mặc định khớp timestamp/volume thực tế.
- `tests/one-shot.test.ts`: regression theo bar thực, seconds compatibility, token 15 phút, loại riêng nến chưa đóng, không dùng token amount để giả USD volume.

Không thay ngưỡng security/Risk/structure, không đánh dấu PASS giả và không yêu cầu đủ 60 phút lịch sử mới được tiếp tục.

## Kiểm tra

- 63 regression tests: PASS, 0 fail/skip/cancelled.
- Typecheck và lint: PASS.
- Build project trong thư mục tạm: PASS; chỉ cập nhật các artifact thay đổi trong `dist` để tránh xóa thư mục build khi LIVE đang chạy.
- Read-only probe dùng parser mới: nhận và parse được 7 nến milliseconds từ một token GMGN khác, `status=AVAILABLE`; không còn bị loại toàn bộ do nhân timestamp hai lần. Số nến provider có thể ít hơn 60 do dữ liệu thưa; các kiểm tra stale/structure vẫn giữ nguyên.
- Không restart LIVE, không sửa `.env`, không ký hoặc gửi giao dịch để verification. Tiến trình `pnpm live` đang chạy phải được người vận hành dừng bằng Ctrl+C và khởi động lại để nạp bản sửa.

Log regression nằm ở thư mục TEMP của hệ điều hành (`gmgn-history-parser-tests.log`), không tạo thêm bộ log test cũ trong `data`.
