# Kronos — đồng bộ bốn màn với BOT B

02/11/2026 — chỉ thay UI. Kronos tiếp tục LIVE, không pause/restart.

Đã đối chiếu source và chụp trực tiếp bốn màn BOT B trước khi sửa. Overview đã có layout chung; Positions, History, Log và Settings trước đây vẫn là table/text đơn giản. Thay đổi dùng cùng các classes/CSS hiện hữu của BOT B và dữ liệu riêng Kronos.

| Màn | Kết quả |
| --- | --- |
| Positions | Heading/count, portfolio strip năm chỉ số, grid card, identity/mode/status, PnL thị trường, invested/quantity/fees/net, entry/hold, MFE/MAE, model decision, explorer và chi tiết mở rộng |
| History | Mặc định CLOSED; accordion với ENTRY → HOLD → EXIT, gross/fees/net/result; chi tiết receipt/decision theo GET, mode/state filters và server pagination. Giữ trạng thái mở khi refresh |
| Log | Header/stream badge, category pills, tìm token/mint/reason, time range, table sáu cột, badge kết quả, raw JSON, local pagination, tải log cũ và xuất JSON |
| Cấu hình | Operator controls, panel tham số, grid ba/hai/một cột theo viewport, nhãn rõ ràng, giá trị thực từ backend; BUY1% cố định/read-only |

Kronos dùng model/policy riêng: các thẻ hiển thị Kronos, không đưa JEV/Structure/Markup vào decision path. Giá trị không có evidence giữ `—`. OPEN mark/MFE/MAE là estimate; closed economics lấy từ own receipt/accounting. Không dựng SOL liquidation value từ USD mark thiếu FX hiện tại. Portfolio là phạm vi trang nếu có hơn50records.

Kronos hiện không có API manual SELL hoặc sửa strategy runtime trong Settings. UI dùng các controls thật đã có, không thêm nút SELL/Lưu không có backend. Các tham số Settings hiển thị read-only; source và policy không thay đổi.

**Nút Tạm dừng ở Log chỉ dừng hiển thị log trong browser.** Xóa chỉ bỏ các log đã tải khỏi màn hình phiên này; export chỉ xuất dữ liệu đang lọc. Không gọi pause/reset/delete backend. Buffer800,100events mỗi GET,40rows mỗi trang local; search/range/filter áp dụng trên dữ liệu đã tải, có nhãn scope rõ ràng. Metadata token lấy bằng bounded GET API của Kronos, không thêm GMGN/RPC consumer.

Files sản phẩm: `public/index.html`, `public/overview.js`, `public/style.css`. Scripts kiểm chứng/capture riêng trong `scripts/`. Không build hoặc ghi `dist/` khi bot LIVE. Server đang chạy đọc static assets mới trực tiếp; browser cần reload/Ctrl+F5, bot không cần restart.

Kiểm chứng:

- [Browser fixture](../evidence/ui-screen-parity-browser.json): Positions/cards/detail, History CLOSED/mode/page/XSS/preserved expansion, Log filters/time/local pause/clear/export, fixed1% Settings;1440/1024/390 không page overflow;0browser errors,0mutation requests.
- [Overview regression](../evidence/ui-screen-parity-overview-regression.log): giữ BOT B geometry,5.000-row pagination,7stages, desktop/mobile. Chỉ fixture server được pause/stop trong test; production không có control request.
- [Lint](../evidence/ui-screen-parity-lint.log): PASS.
- [Production preservation](../evidence/ui-screen-parity-preservation.json):62protected files source/dist/config/model/env/package,0changed; same Kronos PID15012, modeLIVE,enabled=true trước/sau. DB LIVE tiếp tục thay đổi do bot hoạt động độc lập.
- [Before](../evidence/ui-screen-parity-before.json), [after actual screens](../evidence/ui-screen-parity-after.json): GET-only browser capture. [Ảnh](previews/screen-parity/).

Không gọi POST production, không enable/pause/restart bot, không đổi source/data/config BOT B và không thực hiện manual BUY/SELL từ task UI.
