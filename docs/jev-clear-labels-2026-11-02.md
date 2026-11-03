# Nhãn JEV rõ nguyên nhân

02/11/2026, Asia/Bangkok. Đã sửa **hiển thị**, không thay parser, scheduler, ngưỡng hoặc quyền BUY/SELL. Không restart/dừng bot hoặc rebuild dist đang chạy.

`public/app.js` đọc `lastAnalystAttempt.error` trước generic decisionState. Vì vậy record cũ `NO_DECISION_PROVIDER_FAILURE` + `JEV_EXIT_ACTION_FRACTION_MISMATCH` hiện **“Phản hồi JEV mâu thuẫn — Hành động và tỷ lệ bán không khớp. Chưa cấp quyết định mới.”** Không rewrite DB hoặc biến lỗi thành HOLD.

Nhãn riêng cho timeout, phản hồi sai định dạng/schema, HTTP401/403, HTTP429, HTTP khác, lỗi gọi dịch vụ, insufficient data và low confidence. Mã gốc giữ trong tooltip. Dòng bảo vệ NONE đổi thành **“Chưa có tín hiệu thoát bảo vệ”** để tránh hiểu là đã xác nhận token an toàn. Bỏ footer chung “Jev tạm thời không khả dụng” ở các lỗi không phải outage.

## Điểm 0,35–0,42 và ngưỡng 0,7

`data_sufficiency.noul` là điểm 0–1 do JEV chấm về độ đầy đủ của evidence đầu vào cho quyết định. **Không phải win rate, xác suất tăng giá hoặc xác suất thắng đã được hiệu chuẩn.** Điểm confidence của action là chỉ số riêng.

Parser hiện yêu cầu sufficiency ≥0,7 và các điều kiện phản hồi khác. Thấp hơn trả NO_DECISION dù raw action là HOLD. UI nay hiển thị điểm raw thật, ví dụ **“Điểm đủ dữ liệu do JEV chấm: 0,35/1; ngưỡng yêu cầu: 0,70/1. Không phải xác suất thắng.”** Nếu score không được lưu/không hợp lệ thì không tạo số giả. Nếu score ≥0,7 nhưng phản hồi bị chặn vì lý do/action, UI nói rõ điểm đã đạt ngưỡng nhưng điều kiện khác chưa đáp ứng; không báo điểm thấp sai.

Không thay ngưỡng0,7 trong `src/jev.ts`; threshold in trên UI phản ánh policy hiện tại. Điểm là assessment của model, không độc lập chứng minh dữ liệu thị trường thực sự thiếu hoặc chính xác.

## Kiểm chứng

- `scripts/accounting-ui-test.mjs`: thêm **16 cases** về mismatch lịch sử, scores0,35/0,42/0,9, thiếu/null/sai kiểu score, confidence, timeout, schema/JSON, HTTP401/403/429/500 và network. Tất cả PASS; kiểm tra mobile390px không overflow, giữ regression accounting/history/Position. Toàn bộ browser requests intercepted, không server/DB/provider thật. [Log](../data/jev-clear-labels-ui.log).
- `pnpm typecheck`: PASS; `pnpm lint`: PASS. [Typecheck](../data/jev-clear-labels-typecheck.log), [lint](../data/jev-clear-labels-lint.log).
- Không chạy lại full trading suite/build cho thay đổi chỉ ở presentation; không đổi backend. [Preservation](../data/jev-clear-labels-preservation.json).
- GET server thật xác nhận `/app.js` chứa nhãn mới. **11:46:00 Bangkok: PID7656, LIVE, scanner running, entries enabled, halt=null**. [Runtime](../data/jev-clear-labels-runtime.json).

File application thay đổi: `public/app.js`. File verification thay đổi: `scripts/accounting-ui-test.mjs`; cùng báo cáo/log/evidence/ảnh fixture. Reload trang để browser nạp JavaScript mới; server đang phục vụ file public trực tiếp. Build identity của backend đang chạy giữ nguyên; không tuyên bố đã hot-reload backend.
