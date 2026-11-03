# Build và LIVE activation — Kronos cap 300

02/11/2026, Asia/Bangkok. Thực hiện theo yêu cầu tiếp theo của user: “build và live đi”.

- `pnpm build`: PASS, exit 0. Build `846215dd68ee9dafef5baeb480aeaf83051a6764152db6c5f95904fcc99fa0cd`. [Log](../data/kronos-300-live-build.log).
- Trước startup: cấu hình LIVE/ACK/entries/scanner đã bật, Recovery bypass OFF; không halt, không execution pending; DB có 4 core OPEN. Không sửa `.env`, policy hoặc clear halt. [Preflight](../data/kronos-300-live-preflight.json).
- Startup đầu bị `BOT_ALREADY_RUNNING` do lock cũ PID1452 đã được Windows tái sử dụng cho `svchost.exe`. Probe `process.kill(pid,0)` trả EPERM; trường `alive:false` của probe ban đầu không chứng minh PID không tồn tại. Đã đối chiếu Win32_Process, xác minh không có Node process/listener 3000, lưu bản lock rồi chỉ gỡ stale lock BOT. Lock Lab3052 cũng được xác minh không còn process/listener 8792 trước khi lưu/gỡ. Không dừng Windows service hoặc bỏ startup guard.
- BOT B khởi động bằng pinned Node22.22.0 `dist/live.js`, PID7656. Normal-live preflight/mainnet/signer/recovery/OPEN receipt và balance checks chạy theo code hiện hữu.
- **Checkpoint 11:28:52 Bangkok: LIVE, scanner running/scanning, newEntriesEnabled=true, haltReason=null, haltScope=null; 3 managed Positions.** Không tạo manual BUY/SELL để kiểm chứng. Bot được phép giao dịch tự động theo yêu cầu LIVE và policy hiện hữu.
- Kronos được bật bằng launcher hiện hữu, PID3216, `paperOnly=true`, collection enabled, cap thực tế **300**, records **50** tại checkpoint. Model chưa load ở snapshot đầu; không coi collection enabled là đã hoàn tất inference. Kronos tiếp tục PAPER ONLY, không nhận signer/Jupiter authority. Không reset DB/trial/history.

Evidence: [activation](../data/kronos-300-live-activation.json). BOT UI: http://127.0.0.1:3000 ; Kronos UI: http://127.0.0.1:8792 . Trạng thái sau checkpoint có thể thay đổi khi hai service chạy độc lập.
