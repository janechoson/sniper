# Kronos — live-data paper collection enabled

Ngày 2026-11-02, Asia/Bangkok. Người vận hành yêu cầu bật Kronos. Đã bật **LIVE DATA / PAPER ONLY**, không chuyển Kronos thành real-trading authority.

- UI riêng: http://127.0.0.1:8792 . Collection enabled, model thật đã load và có forecasts/WAIT từ dữ liệu GMGN mới.
- Lab Node PID17196; BOT trading cổng3000 vẫn PID10692 như trước activation. Không restart/kill BOT production, không build đè root dist, không đổi strategy hoặc `.env`.
- Existing backend chưa có `/api/kronos/settings`/relay/static asset mới. Lab dùng read-only fallback `/api/status` chỉ lấy settings, có UI riêng để không cần restart LIVE.
- Production Trending ở BACKPRESSURE, snapshot cũ khoảng20 phút. Lab ưu tiên fresh discovery đã có; nếu không có thì đọc **một** GMGN Trending snapshot tối đa50 token/cycle120s. Không thêm record sau khi dataset đạt50; không sửa/drain queue production.
- Launcher cục bộ chọn GMGN_API_KEY và public RPC settings từ cấu hình hiện có, không log giá trị, không forward toàn `.env`/process.env. Collector nhận read API key; Python chỉ nhận nến/time và allowlist môi trường riêng, không nhận wallet/private key/mnemonic/Jupiter data.
- Stage filters giữ nguyên; reject/error vẫn tính vào50 records. WAIT không phải BUY. Paper BUY/SELL sau này chỉ ghi giá và paper return, không ký/gửi transaction hoặc giữ vốn SOL.

Thay đổi phục vụ activation: legacy-settings fallback và bounded discovery fallback trong `kronos-market.ts`; localhost standalone UI/routes trong `kronos-server.ts` + `public/kronos-standalone.html`; scoped CSS; `scripts/kronos-launch-live-paper.mjs`. Chỉ restart Lab do phiên làm việc này tạo để nạp adapter mới, không reset dataset. PID cũ của Lab11640 đã được kiểm tra ownership và dừng; stale Lab lock chỉ được gỡ sau khi PID/port đã dừng.

Kiểm tra: typecheck/lint PASS;13 targeted Kronos tests PASS (gồm reuse fresh discovery, stale-feed bounded fallback và legacy public-settings fallback); standalone service smoke PASS trước activation; actual standalone UI HTTP200, trạng thái đang chạy, browser errors0. Model live đã có nhiều forecasts, khoảng354MB RSS ở snapshot đầu, chưa có paper BUY tại thời điểm xác nhận đầu tiên. Chỉ là operation evidence, không phải profitability evidence.

Evidence snapshot: [kronos-live-paper-activation.json](kronos-live-paper-activation.json). [Ảnh UI live paper](previews/kronos-live-paper-running.png). Trạng thái thay đổi theo thời gian; xem UI để có số liệu mới nhất.

Khởi động lại Lab sau khi đóng máy/service: `pnpm exec node scripts/kronos-launch-live-paper.mjs`. Script tự enable collection theo yêu cầu activation này. Tạm dừng bằng nút Tạm dừng trên UI. Reset chỉ qua confirmation riêng, không tự xóa trial để lấy mẫu khác.

```text
Kronos real BUY/SELL: NO
Kronos sign/submit/Jupiter execution: NO
private key/mnemonic passed to Python: NO
production process restarted/killed: NO
production DB reset/migration by activation: NO
```

BOT trading hiện có vẫn hoạt động độc lập; không khẳng định ví production bất biến trong lúc BOT đó tự vận hành.
