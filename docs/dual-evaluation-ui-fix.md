# Hai card đánh giá STANDARD / KRONOS

**03/11/2026 · UI FIX VERIFIED.** Đã bỏ card “Kết quả”; đúng vị trí bên phải nay là **Đánh giá hiện tại Kronos**. Card **Đánh giá hiện tại / STANDARD** giữ vị trí riêng. Hai card là hai section ngang hàng, không lồng vào một card chung.

Mỗi card có đèn xanh/đỏ/vàng/trung tính, nhãn từng bước và state riêng. Common Cheap/Security/Compatibility/History/Flow/Common Risk dùng cùng state từ attempt, không gọi thêm provider. Common Risk hiển thị trước fork đúng thứ tự backend hiện tại.

STANDARD có Controlled Markup, Structure Evidence V3, JEV và Risk riêng; KRONOS có inference và Risk riêng. Controlled Markup hiển thị nguyên classification `LOW/MODERATE/STRONG/INSUFFICIENT_DATA` từ summary, không tự tạo một gate PASS. Classification và enforcement Risk là hai thông tin khác nhau.

WAIT có kết quả model hợp lệ được hiển thị inference PASS + Decision WAIT, dù entry pipeline lưu KRONOS stage FAIL vì không đạt điều kiện BUY. Model ERROR vẫn FAIL/ERROR; không biến ERROR thành WAIT. Đây chỉ là projection UI, không sửa backend state hoặc quyền execution.

Kronos hiển thị candle count, horizon và terminal paths từ evidence thật. % mỗi path tính từ terminal price / last observed close; consensus là số sampled paths tăng/giảm, không phải confidence hoặc xác suất thắng. Thiếu baseline thì chỉ hiện terminal prices, không suy %.

Decision, Execution và owner nằm cuối từng card. Loser giữ BUY và Execution BLOCKED với owner reason. Execution stage lights chỉ phản chiếu state execution cho winner; không tô PASS của winner lên loser. Đèn vẫn giữ sau khi claim ownership. Stages không bị giấu trong accordion hoặc scroll box riêng; mobile stack hai card, giữ chữ và đèn đầy đủ.

## Kiểm chứng

- `scripts/first-buy-wins-ui.ts`: PASS bằng PAPER server/DB temp, fake providers. Bao phủ bỏ card cũ; hai section độc lập; common/branch stages; màu đèn PASS/FAIL/CHECKING/PENDING; hai winner orders và late BUY blocked; common failure/branch isolation; valid WAIT/model ERROR; forecast data/classification; History/attempt endpoints; long status/reason; desktop ngang hàng và mobile stack tại **1440/1024/390**. **0 browser console errors, 0 provider calls, 0 executions** trong fixture.
- `scripts/kronos-integration-ui.ts`: PASS, giữ kiểm tra Settings, Position badges, History pagination/filter, statistics và responsive.
- `pnpm typecheck`: PASS. `pnpm lint`: PASS. TypeScript emit cô lập trong browser verifier: PASS, output temp được cleanup.
- Không chạy lại full trading suite hoặc build đè `dist`; task không thay trading code. Không dùng test-count 462 của lượt trước như kết quả mới của UI task.
- Fingerprint **129 files** gồm `src`, `dist`, config, `.env`/example, package/lock: **0 changed**. FIRST_BUY_WINS, ownership SQL, Risk, execution và SELL giữ nguyên. Không thêm API/view-model hoặc sửa DB production.

Files sửa: `public/index.html`, `public/app.js`, `public/style.css`, `scripts/first-buy-wins-ui.ts`, `scripts/kronos-integration-ui.ts`, báo cáo này và notice trong báo cáo ownership. Không giữ screenshots/raw evidence/fixture DB/build temp mới sau checks.

## Runtime

Task không POST lên production, không pause/stop/restart, không BUY/SELL/sign/submit thật. Static UI được server đọc trực tiếp, không cần restart backend để nhận UI mới.

Lần kiểm tra đầu task thấy PID14168 LIVE, entries=true, scanner chạy, FIRST_BUY_WINS=true. Lần kiểm tra cuối **không còn PID14168/listener3000**; legacy Lab PID3216/8792 vẫn chạy. Stderr service có timestamp cuối **05:45:50 ngày 03/11 Bangkok**, không có dòng Error/Exception/FATAL giải thích nguyên nhân. Chưa xác lập nguyên nhân process kết thúc; không quy cho token hoặc thay đổi UI. Không tự bật lại LIVE trong task UI này. Cần service chạy lại trước khi mở giao diện; sau đó reload để nhận hai card mới.

## Khởi động lại theo yêu cầu user — 03/11/2026, 06:33 Bangkok

`pnpm build` PASS. Build **`bee9dbf8622f3d72a6026fbf98a37d5069bb827b44f00ebd24de4fc16605cb52`** được chạy bằng Node22.22.0 `dist/server.js`, hidden process **PID10680**, port127.0.0.1:3000. Legacy Lab PID3216/8792 không đổi.

Preflight read-only: không executions/manual pending, active claims=0; signer/mainnet hợp lệ; 3 core OPEN holdings và BUY receipts khớp chain. DB trước startup có SYSTEM halt `FRESH_FULL_KRONOS_SELL_REQUIRED` và entries=false. Vì vậy task dùng server entrypoint để mở UI/monitoring, không bypass normal-live halt check, không gửi POST clear halt/enable entries hoặc sửa settings trực tiếp.

Sau startup, DB ghi event **ENTRY_CONTROL / New entries enabled** lúc06:33:20 Bangkok. Đây là thay đổi control phát sinh ngoài các lệnh deployment của task; chưa xác định client gửi yêu cầu. GET cuối xác nhận **LIVE, entries=true, halt=null, scanner.running=true, FIRST_BUY_WINS=true**. Không suy event này là lỗi Kronos SELL đã được sửa.

HTTP200 và HTML có hai card STANDARD/KRONOS mới, không còn `terminalResult`. Logs service thật: `data/bot-runtime-20261102T233308Z.stdout.log` / `.stderr.log`. Task không gửi BUY/SELL kiểm chứng; Engine có thể tự giao dịch khi entry control bật. Không đổi `.env`/keys hoặc reset trade/Position data.
