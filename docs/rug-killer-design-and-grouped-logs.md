# Rug Killer — Tổng quan, Logs và Cấu hình

**03/11/2026 — IMPLEMENTED / VERIFIED.** Theo yêu cầu mới nhất: hoàn thiện Tổng quan và Logs trước; hoãn redesign Thống kê. Sau đó dọn các mục Cấu hình lỗi thời và thêm toast khi lưu. Thay đổi giao diện được phục vụ trực tiếp từ `public/`; tải lại trang để nhận bản mới. Không pause/restart bot, không nạp lại backend LIVE.

## Audit và phạm vi

Nguồn kiểm chứng là source hiện tại: `dashboard-view.ts`, `server.ts`, `candidate-attempt.ts`, `one-shot-entry.ts`, `candidate-lifecycle.ts`, `config.ts`, `engine.ts` và các route modules.

Overview có current attempt, sáu common stages, hai strategy branches/claim, real candles, queue preview8, Position preview10 và total. DTO không cung cấp authoritative scanned/matched/rejected counters hoặc scanner speed. Các số này trong mockup được bỏ qua; không thêm Statistics/status/provider request để lấp dữ liệu. Chart chỉ vẽ từ actual candles; thiếu dữ liệu giữ N/A.

Logs dùng snapshot bounded: events800 + pipeline transitions800, metadata token và current attempt.logs tối đa100. ATTEMPT_STARTED/ATTEMPT_REJECTED có UUID ở đầu reason; không suy mọi UUID là attempt. Có sẵn GET `/api/attempt?id=…` trả flattened CandidateAttempt kèm `ownershipClaim`.

## Design system và Overview

Canonical `--rk-*` tập trung ở đầu `public/style.css`: background/surfaces, text, border/divider, brand, success/danger/warning/pending, STANDARD/KRONOS, info, shadow, focus, radius và spacing. Các biến cũ `--bg/--panel/--accent/--green/--red`, terminal/flow/log tokens trở thành alias. Literal màu ứng dụng không còn rải trong component CSS/JS/HTML.

| Vai trò | Cũ → mới |
| --- | --- |
| Các cream/surface riêng từng component | `--rk-bg #F7F0DE`, `--rk-surface #FFF9EC`, elevated `#FFFCF4` |
| Brand/card/navbar | `--rk-brand #B52A27`, hover `#9F211F` |
| PASS dot | `#247453` → `--rk-success #168447` |
| FAIL dot | `#B73737` → `--rk-danger #D52B28` |
| CHECKING dot | `#89661A` → `--rk-warning #B87808` |
| Pending dot | `#CEC7B6` → `--rk-pending-dot #C7C0AF` |
| STANDARD/KRONOS identity | success family / `--rk-kronos #7045B8` |

Shared navbar, cards, fields/selects, buttons, tables, badges và focus ring dùng cùng palette trên `/`, `/positions`, `/history`, `/memory`, `/settings`, `/logs`, `/thongke`; Watch/Deferred cũng nhận shared tokens. Layout/data của Thống kê được giữ ở view trước redesign.

Overview có:
- Full red Rug Killer brand badge và active navigation underline.
- Scanner full-width, token giữa nổi bật, neighbor nhỏ hơn; bỏ glow mạnh.
- Desktop: bốn card Token / STANDARD / KRONOS / Action Log cùng chiều rộng và chiều cao. Tablet chia hai cột, giữ hai strategy cạnh nhau; mobile xếp dọc.
- Header STANDARD xanh, KRONOS tím; sáu common stages giữ riêng trong mỗi card. BUY màu vàng, giữ actual compact status, không thêm fake progress.
- Token metrics gọn, mini chart dùng candles thật, safe GMGN link; preview Positions còn nhìn thấy trong viewport1080p.
- Không sửa Amount/PnL/Fee, FX freshness, quantity hoặc controls SELL. Net PnL giữ đơn vị SOL như view trước task.

Màu literal còn chủ ý: canonical token definitions, shadow/backdrop RGB trong token definitions, HSL initials theo token identity của Flow và màu bên trong external token logos. Không recolor token assets.

Contrast tính bằng relative sRGB luminance: body15,02:1; secondary6,25:1; success text5,00:1; danger5,78:1; warning4,80:1; KRONOS7,27:1; brand white text6,02:1. Text mới trong timeline dùng secondary thay muted để giữ độ tương phản. Disabled/decorative tokens không được tuyên bố đạt chuẩn normal text. Status còn có chữ và glyph, không chỉ dựa màu; expand/close dùng native buttons, focus rõ.

## Logs — một attempt một dòng

Frontend normalize/group toàn bộ buffer trước filter/pagination40 nhóm:
- Explicit attempt ID/context ưu tiên; cùng mint nhưng khác ID hoặc mode luôn tách.
- Candidate events thiếu ID chỉ gắn vào attempt có boundary thời gian phù hợp đã biết. Không đủ boundary thì giữ activity row, không gán tùy tiện theo mint.
- Position/execution ID có nhóm riêng; no-mint System là standalone row.
- Mỗi parent ~54px: latest activity time, avatar/name/mint copy, known strategy/owner, latest stage/status, count, expand. Authoritative BOUGHT/REJECTED/RECONCILING giữ kết quả attempt dù có late loser log.
- Timeline tăng dần theo timestamp, giữ thứ tự gốc khi trùng millisecond; có stage/result/reason/strategy. Children chỉ tạo khi mở; raw JSON chỉ tạo khi mở phần dữ liệu sự kiện.
- Lần mở historical attempt gọi GET detail có sẵn; hai detail GET khác ID không hủy nhau. Route leave vẫn abort tất cả pending reads.
- Expanded identity, raw disclosure và reading anchor được giữ khi live update/reorder. Dedupe repeated polls, append failure vào cùng nhóm.
- Search gồm child reasons và token metadata; giữ ALL/CANDIDATE/SECURITY/RISK/STRUCTURE/JEV/TRADE/SYSTEM cùng date range. Counters/pagination đếm nhóm.
- Pause chỉ dừng hiển thị; Clear chỉ xóa buffer frontend. Export ghi rõ LOADED_BUFFER_ONLY.
- Buffer2000 raw events, tối đa60 cached attempts; cache/DOM cũ được prune. Footer và timeline ghi rõ loaded scope. Detail chỉ có tối đa100 logs/trial đã được backend giữ; không hứa toàn bộ DB hoặc khôi phục sự kiện đã prune.

## Cấu hình — bỏ20 controls cũ

Chỉ bỏ controls khỏi màn Cấu hình. Schema, file config và các giá trị đã lưu vẫn được giữ để tương thích; khi operator lưu, hidden values được gửi lại nguyên giá trị cùng các field đang dùng.

| Nhóm cũ | Controls đã bỏ | Bằng chứng |
| --- | --- | --- |
| Sniper age/cache | maxAgeSeconds, sniperPollMs | Normal source chỉ TRENDING; age dùng trendingMaxAgeSeconds, cache/cadence SNIPER không có normal poll |
| Timer không dùng | analysisRefreshMs | Không có runtime consumer |
| Sequential Watch | structureWatchTtlMs, structureWatchMaxSize, structureObservationMs, structureConfirmations | observeStructureWatches rỗng; oneShotStructure chỉ đọc structureMaxGapMs/maxSnapshotAgeMs. Các helper/reconcile/history legacy vẫn giữ |
| Ranking/aging cũ | trendingPriorityBoost, multiSourcePriorityBoost, candidateAgingPointsPerMinute, sniperMaxWaitMs, sniperWatchReserve, trendingAnalysisBurst, queueReplacementMargin | CandidateLifecycle.refill hiện lấy unconsumed appearances ORDER BY id; boost chỉ còn legacy discoveryBoost/Watch helper |
| Candidate retry lists | watchMaxSize, watchRecheckMs, deferredMaxSize, deferredTtlMs, deferredRecheckMs, deferredMaxRechecks | CandidateLifecycle không còn retry Watch/Deferred; capacity cũ có thể còn trong projection |

**Giữ** positionSizePercent, Security/Risk/freshness, structureMaxGapMs, current discovery/queue/provider controls, exit safety/probes, Capital Flow và Jev/Position settings. TP/trailing vẫn là references gửi Jev nên không bỏ. tokenFailureThreshold/recentRejectTtlMs thực sự dùng trong Engine Position backoff; đã sửa nhãn/hint cũ gây hiểu nhầm thành legacy candidate setting. Không thay giá trị operator, bao gồm quy mô BUY hiện tại.

Toast:
- API `{ok:true}` → success; auto-hide6s, có close.
- API/transport/JSON error → error, giữ edits, mở lại nút lưu.
- POST thành công nhưng GET reload lỗi → warning **đã lưu nhưng chưa tải lại**, không báo sai là lưu thất bại.
- Fieldset khóa trong lúc lưu, chống double submit. Route leave không ghi toast lên page khác.
- ARIA status/alert, safe textContent và responsive. Settings save không đợi global shell refresh để quyết định thành công; các operator commands khác giữ default refresh behavior.
- Task không bấm lưu/kill/scan trên production; tests POST chỉ tới server PAPER/temp DB.

## Route/API isolation

| Route | GET khi đang mở |
| --- | --- |
| Global shell | /api/ui/shell và /api/positions/count, mỗi5s |
| Overview | /api/overview, mỗi1s |
| Logs | /api/logs?limit=800, mỗi5s; /api/attempt?id chỉ khi expand |
| Settings | /api/settings lúc vào/refresh và sau lưu |

Các route khác giữ matrix cũ; không mở hidden-page poll, không dùng full status hoặc thêm GMGN consumer. Existing mutating controls chỉ chạy khi operator bấm như trước.

## Kiểm chứng

| Check | Kết quả |
| --- | --- |
| pnpm test | 511 passed, 0 failed/cancelled/skipped |
| New grouping tests | 7: same attempt, fresh attempts/modes, actual ID parsing, time boundaries/System, same-ms order/dedupe, authoritative owner/outcome, Position/execution separation |
| pnpm typecheck / pnpm lint | PASS |
| pnpm build --out-dir .build-rug-killer-ui-20261103 | PASS; isolated output, không ghi đè LIVE dist |
| scripts/rug-killer-ui.ts | PASS: groups/lazy detail/search/filter/paging/live failure, raw/scroll retention, display pause, concurrent reads/abort, XSS, equal cards, viewport1080p |
| scripts/settings-feedback-ui.ts | PASS: actual temp HTTP save, hidden/config values preserved; error/invalid JSON/refresh warning; responsive toast |
| scripts/first-buy-wins-ui.ts | PASS: separate cards, BUY states, currencies/FX, ownership API |
| scripts/kronos-integration-ui.ts | PASS: percentage save, strategy badges, History/page/filter và Statistics filter |
| scripts/dashboard-route-ui.ts | PASS: all9 routes/request matrix, unmount cancellation, 0 full-status calls |
| Responsive | 1440/1024/390 trên7 main routes, không document horizontal overflow; tables scroll nội bộ |
| Browser/runtime effects | 0 browser errors; fake providers; không real sign/submit hoặc trade kiểm chứng |

Pnpm launcher có Node20 warning; commands/build/tests chạy pinned Node22.22.0. SQLite experimental warning không phải failure. Browser screenshots chỉ dùng để inspect, không thêm screenshot/evidence vào project.

## Files và bảo toàn

Runtime UI: `public/style.css`, `index.html`, `dashboard-overview.js`, `dashboard-logs.js`, `dashboard-core.js`, `dashboard-positions.js`, `dashboard-settings.js`, `dashboard-router.js`. Statistics module/template được giữ ở view trước redesign; notice deferred trong tài liệu Statistics.

Tests/scripts: `tests/dashboard-grouped-logs.test.ts`, `scripts/rug-killer-ui.ts`, `settings-feedback-ui.ts`; cập nhật theme assertions của `first-buy-wins-ui.ts` và chờ route readiness trong `kronos-integration-ui.ts`. Tài liệu này; route doc liên kết follow-up.

Fingerprint134 backend/source/config/dist/env/package/lock/build-script/model-worker files: **0 changed** ở checkpoint11:34 Bangkok; kiểm tra lại trước kết thúc. Không sửa strategy, Risk/ownership/capital, quote/simulation/sign/receipt, Position/SELL/accounting hoặc production schema/data.

Main bot giữ **PID10176**, LIVE, entries=true, scanner running, halt=null tại checkpoint cuối **11:43:39 Bangkok**. GET HTML production đã phục vụ new Overview headings/settingsToast; fingerprint134files vẫn0changed. Không pause/restart/deploy backend. Build kiểm chứng mới e899bad3521d484312af63c19a600d99a4133ff0a7b3abd514e97e0f9c7c21d2 chỉ là isolated verification, không phải runtime build đã deploy. LIVE Engine có thể tự giao dịch độc lập; không tuyên bố DB/wallet bất biến qua task.

**Cleanup exception:** automatic approval review từ chối lệnh đóng/dọn preview fixture và lệnh xóa isolated build với `blocked by policy`. Không thử đường khác. Còn own PAPER preview PID16124 (port43628), thư mục OS temp `C:\Users\admin\AppData\Local\Temp\rug-killer-ui-CSAn1q` với screenshots/fixture DB và `.build-rug-killer-ui-20261103` trong project. Preview không phải bot LIVE; credentials rỗng, scanner/entries=false. Các verification runners bình thường tự đóng và cleanup temp qua finally. Không đụng thư mục cleanup đã bị chặn từ task cũ.

## User-requested deployment — 03/11/2026, 11:47 Bangkok

User sau đó yêu cầu nạp và chạy bản mới nhất, thay thế giới hạn không restart của phần implementation. Preflight native SQLite read-only: executions nonterminal=0, pending Positions=0, manual CLAIMED/SUBMITTED=0; halt=null. Signer/mainnet và cả3 core OPEN quantities/BUY receipts được kiểm tra read-only thành công. Quy mô operator giữ10%.

Backup build cũ: `data/backups/build-before-rug-killer-ui-20261103T044635Z.zip` (190.357bytes). API entry control đã acknowledgment entries=false, scanner idle/attempt REJECTED; recheck executions/Position/manual/unsubmitted ownership claims đều0 trước khi dừng đúng main PID10176. Không dừng legacy Lab hoặc preview fixture.

`pnpm build` production PASS, Node22.22.0, `dist/build-info.json` build **e899bad3521d484312af63c19a600d99a4133ff0a7b3abd514e97e0f9c7c21d2**, builtAt **2026-11-03T04:47:32.258Z**. Không reset DB hoặc đổi settings/config/env.

**START BLOCKED:** automatic approval review từ chối lệnh `Start-Process` khởi động hidden `node_modules/node/bin/node.exe dist/live.js` với **`blocked by policy`**. Lệnh không chạy; không thử wrapper/cách khác để vượt chặn. Main bot hiện STOPPED, listener3000=0; entries=false từ entry pause. Deployment chưa hoàn tất và không được coi là LIVE. Không tạo giao dịch kiểm chứng.

Để user tự khởi động normal LIVE trong PowerShell, từ project chạy `pnpm live` (hoặc command package tương ứng). Startup preflight/recovery hiện hữu sẽ kiểm tra state và khôi phục normal entries khi hợp lệ; không xóa lock hoặc clear halt thủ công.
