# Local Structure V2 — LIVE activation

**30/10/2026, khoảng22:02 Asia/Bangkok.** Thực hiện theo yêu cầu tiếp theo của user: tắt bypass và chạy bản mới trên LIVE.

- `.env`: chỉ đổi `TEMP_BYPASS_RECOVERY_GUARD=true` → `false`; nội dung khác giữ nguyên. Process mới cũng được truyền cùng flag=false để không bị environment cũ ghi đè.
- Tạm pause mua mới, kiểm tra pending; gửi Ctrl+C để backend PID11500 chạy shutdown handlers. Sau dừng: không còn loopback listener/process lock và execution pending=0. Không force-kill hoặc xóa execution/Position.
- Backup DB/provider state và toàn bộ dist cũ tại `data/backups/local-structure-live-20261030T150208Z/`; hash backup files khớp. Không copy secret `.env` vào backup.
- Copy và verify43compiled files từ staged build sang production dist, build `ead423060b70605ea92bf4a96ebf9abe001c8f8d4d30a5e32315a9ec231c05d3`.
- Khởi động pinned Node22.22.0 bằng **dist/live.js**, PID**5648**. Normal-live preflight/recovery/mainnet/signer/OPEN holdings checks chạy theo code hiện hữu; không clear halt hoặc bypass startup validation.
- Status sau startup: **LIVE, newEntriesEnabled=true, scanner running, haltReason=null**. Có2Position được quản lý tại checkpoint sau preflight. Watch ACTIVE trả evidenceVersion=LOCAL_BUYER_DEFENSE_V2, gate=LOCKED; không TEMP bypass. Không giả PASS/evidence.
- LAN bridge giữ nguyên, `http://192.168.1.66:3000/api/status` trả200.

Không tạo lệnh BUY/SELL thủ công để kiểm chứng. Bot sau activation được phép chạy giao dịch tự động theo yêu cầu LIVE và các guard hiện hữu; đây không phải cam kết không có giao dịch tự động sau checkpoint.

Evidence: [before](../data/local-structure-live-activation-before.json), [deployment/backup](../data/local-structure-live-deployment.json), [status](../data/local-structure-live-status.json), [summary](../data/local-structure-live-activation-summary.json). Log backend: `data/local-structure-live.stdout.log`, `.stderr.log`.
