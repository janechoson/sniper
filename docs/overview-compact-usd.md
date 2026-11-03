# Overview compact và định dạng USD

**03/11/2026 · VERIFIED / static UI applied.** Hai card riêng có common + strategy stages + đúng một dòng BUY; không còn footer Decision/Execution/Owner/FIRST_BUY_WINS, forecast block hoặc các execution rows chi tiết. Đèn từng stage giữ nguyên; BUY tóm tắt PENDING/OWNER/EXECUTING/SUCCESS/BLOCKED/FAIL/CHECKING từ state thật. Granular stages và owner/decisions còn nguyên trong Action Log, History/API/backend.

Overview Amount/PnL/Fee dùng lamports /1e9 × `status.solPriceUsd` hiện tại; timestamp phải không future và còn trong budget60s đang dùng cho wallet USD. Thiếu/invalid/stale FX → N/A. Fees partial giữ dấu ≥. Storage/formula accounting không đổi; Net PnL và các cột khác giữ basis hiện hữu.

Một helper compact USD dùng chung cho **Market Cap, Liquidity và Volume24h**:49.132,16→$49.1K;1.120,07→$1.1K;1.120.874→$1.1M;494.977→$495K. Price không dùng K/M/B. USD nhỏ giữ precision hữu ích, ví dụ$0.00175667→$0.0018; xử lý null/undefined/NaN/Infinity/0/negative.

`scripts/first-buy-wins-ui.ts` PASS: compact11/9 stage cards, không footer/internal rows; BUY phases/lights, branch independence, History/claim data còn riêng;31 formatter examples, đổi/missing/stale/future FX, USD cells, token Price,1440/1024/390,0console errors/provider calls/executions. `scripts/kronos-integration-ui.ts`, typecheck/lint và isolated emit PASS. Production GET-only browser check PASS; không POST, sign/submit, pause/restart.

Fingerprint129 files src/dist/config/env/package/lock:0changed. PID11556 giữ LIVE/entries=true/halt=null/scanner running; size5% là giá trị operator tại checkpoint, không do task đổi. Fixtures/build temp được cleanup; không lưu ảnh/raw evidence mới. Files UI: public/app.js/index.html/style.css và hai browser scripts nêu trên.

Routing refactor tiếp theo được theo dõi trong [dashboard-routing.md](dashboard-routing.md); dữ liệu format và compact layout phải được giữ.
