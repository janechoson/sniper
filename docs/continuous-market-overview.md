> Cập nhật 02/11/2026: [controlled LIVE implementation](controlled-live-jupiter.md). Các trạng thái PAPER ONLY/RUNNING bên dưới là checkpoint lịch sử, không phải activation hiện tại.

# Kronos — REAL market data, continuous PAPER history, BOT B Overview

**02/11/2026 — Asia/Bangkok. COMPLETE, RUNNING: MARKET REAL / TRADING PAPER.**

Project: `C:\Users\admin\Desktop\Tool\sniper`. BOT B `gmgn-sniper` chỉ đọc để lấy source/layout và đối chiếu; không chỉnh source/data/config, không restart/kill BOT B. Báo cáo này mô tả phiên bản hiện tại, thay cho trạng thái STOPPED/cap200 trong migration report lịch sử.

## A. 200-cap removal

Đã bỏ `KRONOS.maxRecords`, guard số trial ở `Store.add()`/discovery tick và intake slice theo cap đó. Không đổi sang500/1000/10000, không reset hoặc evict rows. UNIQUE appearance và active-mint duplicate policy giữ nguyên.

Đồng thời bỏ storage ceilings cũ720decisions/trial và50.000events: chúng có thể ngừng inference/ghi evidence sau khi bot chạy lâu. Không thay model/consensus để làm việc này. Decision history, events và trial lifecycle được tích lũy; các giới hạn hiện còn là **giới hạn đọc/concurrency/provider**, không giới hạn tổng dữ liệu.

DB active trước activation có0trial; không reset DB. Test fixture10.001trial giữ record201/250/300/1000/10000, không overwrite hoặc eviction. Legacy payloads không được backfill/rewrite khi tạo indexes.

## B. Continuous real-data architecture

```text
Own KRONOS_GMGN_API_KEY + KRONOS_RPC_URL
→ GMGN rank50 / cycle120s
→ own persistent trial admission/dedupe
→ Cheap Filter → fresh Security → mint compatibility
→ closed M1 history, up to60candles → required current Flow
→ pinned native Kronos → WAIT / PAPER BUY
→ due OPEN monitor → M1 + native Kronos → HOLD / PAPER SELL
→ observable PAPER fills / gross price-return PnL
```

Direct routes: `/v1/market/rank`, `/v1/token/info`, `/v1/token/security`, `/v1/market/token_kline`; RPC chỉ `getAccountInfo`. Không BOT B `/api/tokens`, DB, cache hoặc provider-state dependency.

User đã cấu hình **key/RPC riêng trong `.env` của Kronos** khi triển khai. Chỉ kiểm tra CONFIGURED, không in/copy giá trị và không lấy credentials từ BOT B. Khi activate, server PAPER guard và CSRF đều chạy theo implementation; không launch real execution path.

## C. Overview BOT B source components

Primary visual source là actual `gmgn-sniper/public/index.html`, `public/style.css` và `window.BOTOverview` trong `public/app.js`, đọc ở thời điểm sửa.

Giữ cùng DOM/classes và CSS layout: horizontal header/nav, mode badge, token scanner/carousel, central glow và blue arrows, current-token/evaluation/result/Action Log panels, bottom Positions table; cùng navy/blue palette, borders, font, spacing và breakpoints. Không dùng migration report cũ làm nguồn truth của UI.

## D. Overview components copied/adapted

- `public/index.html`: header/nav và main Overview structure từ BOT B; thêm views Positions/History/Kronos/Settings/Log/Statistics phù hợp PAPER.
- `public/style.css`: CSS hiện tại của BOT B, chỉ thêm selectors cho các view mới; không đổi grid/proportions của Overview.
- `public/overview.js`: adapt `renderCandidate`/avatar/metrics/stage/log components; dùng own `/api/overview` và bounded read endpoints. Không import production app.js hoặc nối các production buttons.
- `src/kronos-lab.ts`: own current-trial projection, bounded carousel/positions/log frame và observational stage telemetry. UI không tạo progress timer/evidence giả.

## E. Intentional visual differences

| BOT B | Kronos |
| --- | --- |
| LIVE badge | **PAPER** |
| Wallet SOL/USD | **MARKET: REAL / MODE: PAPER** cùng vị trí |
| Running | Bot Running khi collection enabled; Server Running · Collection Paused khi pause; disconnected khi GET thất bại |
| JEV/Structure/Risk/Markup/execution stages | 7Kronos stages thực sự dùng |
| JEV confidence/execution/amount | actual decision/observed price/decision time/forecast horizon/PAPER entry |
| Amount/Fee/Net PnL | Bỏ; absolute PnL không được domain mô hình hóa hiển thị `—` |
| Manual real SELL buttons | Không có, current PAPER domain chưa có manual-close policy |
| Production Memory/watch/defer tabs | Bỏ, không tạo backend consumer tương ứng |

Không thêm KPI strip lên Overview. Statistics là tab riêng. Header/navbar vẫn cùng visual system; mobile giữ responsive behavior nguồn. No real wallet context hoặc confidence% bịa ra.

## F. Kronos pipeline shown in UI

Entry rows: Cheap Filter, Security, Token Compatibility, Market History ·60m, Capital Flow, Kronos Analysis, Paper Decision. Các trạng thái CHECKING/PASS/FAIL/PENDING được persist tại boundary thật; không suy PASS từ đồng hồ.

OPEN monitor giữ **đúng baseline**: đọc current price/M1 và chạy Kronos, không tự thêm lần rerun Security/Flow thành gate mới. Những entry stages không chạy lại hiện **SKIPPED** trong evaluation hiện tại; entry evidence cũ vẫn giữ riêng. `evaluation` lưu current-attempt progress, `gatePasses` giữ các PASS đã thực sự xảy ra để funnel không giả reset theo refresh. Không tác động inputs/decisions của model.

Kết quả chỉ hiển thị PAPER BUY/PAPER SELL khi đọc đúng persisted state; SELL đã quyết định nhưng chưa có observable fill price hiện chờ giá. Model/provider lỗi không hiển thị thành HOLD hợp lệ hoặc fabricated SELL.

## G. JEV/Structure/Markup removal

Không có TypeSafe client, Jev/scheduler, Trading Memory retrieval, production RiskEngine, Structure V3, Controlled Markup hoặc Jupiter/executor/signer trong runtime graph. Cheap Filter/Security/mint/history/Flow vẫn giữ. Worker chỉ nhận candles/time qua explicit env/stdin allowlists; config `TRADING_MODE=live` vẫn bị từ chối.

## H. History pagination

`GET /api/history?cursor=<rowid>&limit=50&state=ALL` trả page, `nextCursor`, `hasMore`; query filter và `rowid DESC` thực hiện trước LIMIT. UI có Next/Previous và status filter. Page limit được clamp1..100; không gửi toàn lịch sử ra browser hoặc sort arbitrary all-rows client-side.

`GET /api/trial?id=...` dùng indexed id + latest50decisions cho detail. Không giới hạn số decision được giữ trong DB. `/api/kronos` giữ compatibility projection tối đa50recent records; không còn `summary.limit` hoặc `/200`.

## I. Statistics implementation

`GET /api/statistics`: SQL aggregates, trả scalar counts/means/median và bounded distribution, không trả trial payload arrays.

- **Tokens Checked:** unique trial có evaluation bắt đầu (`checkedAt`); fallback evidence của legacy decision/gate dùng cho rows cũ. Browser refresh/events không tăng count.
- **Kronos PASS:** trial có persisted PAPER entry; proposed BUY thiếu fill price không được tính thành successful PAPER BUY.
- **Selection Rate:** PAPER entries / checked trials; chưa có denominator thì `null` → `—`.
- **Win/Loss/Breakeven:** CLOSED và PnL>0/<0/=0. Breakeven không là WIN; win-rate denominator gồm mọi CLOSED.
- Funnel dùng persisted PASS evidence/ever-pass markers, không đếm mỗi lần render hoặc mỗi stage event thành trial mới.
- Average/median/best/worst PnL, MFE/MAE, hold time tính từ stored CLOSED rows; khi không có dữ liệu thì `null` → `—`.
- PnL distribution chia theo dấu âm/0/dương; không giả phân bố chi tiết hoặc trend. Rolling20/50 chỉ xuất hiện giá trị khi đủ CLOSED samples.

Không bịa net PnL/fees/quantity ledger. Các metric là gross PAPER price returns, không feed ngược vào model hoặc tự tune policy.

## J. Database scalability

Không thay DB path: `sniper/data/kronos.sqlite`. Chỉ tạo indexes, không reset/import dữ liệu. Indexes hiện có:

```text
lab_trials_mint
lab_trials_state_due
lab_trials_pnl
lab_trials_closed
lab_events_trial
lab_decisions_trial
```

Hot paths dùng `trial(id)`, separate indexed due OPEN/candidate queries, page queries và scalar COUNT. `Store.trials()` all-rows helper chỉ còn dùng bởi offline fixtures/baseline; runtime/API không gọi nó. Tests đặt tripwire lên helper này và xác minh0calls khi monitor/overview/history/statistics chạy.

Bounded outputs: carousel query8/six neighbors+current; overview positions50; history/positions pages50(default,max100); current/all log pages100; detail decisions50. Đây không phải storage replacement caps.

5.000-row HTTP fixture: Overview khoảng49ms ở một checkpoint, response khoảng1,1KB khi không có OPEN; History50rows; stats khoảng716bytes. UI fixture5.013rows render Overview khoảng396ms trong một run. Số đo là local synthetic checks, không throughput SLA cho mọi workload/DB size. Aggregate statistics vẫn cần xử lý lịch sử ở SQLite, không tuyên bố O(1) hoặc disk space vô hạn.

## K. Provider/rate-limit behavior

Giữ GMGN start spacing3s, serialized request tail, single discovery promise,20sHTTP timeout,429 cooldown120s và không thêm unbounded per-request retries. Model90stimeout/2CPUthreads/memory guard và concurrency1 giữ nguyên. Unlimited records không làm tăng số request đồng thời.

Provider health trong config phân biệt UNKNOWN/OK/ERROR/RATE_LIMITED, không giả OK khi chưa gọi. RPC chỉ OK sau successful mint-account read. Failed candidate không PAPER BUY; OPEN lỗi vẫn OPEN, không fake exit, due retry theo policy cũ. Không JEV fallback. Quota có thể chung với các bot khác nếu user chọn cùng provider account; không share mutable cache hoặc bypass cooldown.

## L. Position scheduling

Discovery ở tracked async lane; không await nó trước selection/model lane. Tick chọn **due OPEN trước**, sau đó due candidate, vẫn một model call. History lớn không được decode để chọn OPEN. Tests với300candidate backlog và200concurrent tick attempts xác nhận monitor chạy và model maximum active=1.

Không có guarantee every-position latency khi nhiều OPEN cùng đến hạn hoặc provider chậm; source scheduling/budget vẫn ràng buộc throughput. Pause collection dừng scheduling mới; một attempt đã await có thể hoàn tất theo baseline. Server restart vẫn fail-safe PAUSED, có thể enable lại từ Cấu hình.

## M. Strategy parity

Không đổi model/tokenizer revisions, min/max input candles, horizon5,3paths, seeds1701+sample index, temperature1/topP0,9, price-only normalization, BUY/SELL unanimous-terminal consensus hoặc PAPER price/return functions.

Canonical token comparison của **validateCandles, decideForecast, validPrice, paperFill, markPrice đều khớp old baseline**. Native offline model regression tiếp tục PASS với identical inputs/seed; old/new normalized forecasts và decisions tương đương. Chỉ thêm observation data/UI/query isolation và bỏ storage ceilings đã nêu.

## N. UI screenshots

- [BOT B current reference](previews/bot-b-overview-reference.png) — GET-only, không POST/control.
- [Kronos desktop fixture](previews/kronos-overview-desktop.png).
- [Kronos1024](previews/kronos-overview-1024.png), [mobile390](previews/kronos-overview-390.png).
- [Statistics riêng](previews/kronos-statistics.png).
- [Kronos đang chạy bằng market data thật](previews/kronos-overview-real-market.png).

Mandatory regression đo x/y/width/height scanner/current/evaluation/result/Action Log của hai bot ở1440px; chênh lệch dưới2px. Same source grid/CSS; không tuyên bố pixel-identical khi nội dung/stages/state khác. Browser errors0, mobile không horizontal document overflow; bảng cuộn trong container.

## O. Tests

| Check | Kết quả |
| --- | --- |
| `pnpm test` | **21 passed,0failed,0skipped**, khoảng21,4s ở final run |
| `pnpm typecheck` | PASS |
| `pnpm lint` | PASS |
| `pnpm build` | PASS, chỉ `sniper/dist` |
| Browser visual/large-data test | PASS, actual own handlers + temp SQLite; fake provider/model |
| Real startup/current data | PASS, key riêng; GMGN/RPC OK, actual native model inferences |

New coverage:10.001trials/no-eviction/dedupe,720/50k ceilings removed, persistent statistics/breakeven,5000-row bounded endpoints/index plan, OPEN priority/full-history-read tripwire,429 protection, mandatory Overview geometry,7stages, History Next/Previous, Statistics separation, paused/running distinction and responsive UI.

Existing lifecycle/restart/fill-freshness/model-failure/isolation/zero sign-submit/native parity tests giữ lại. Logs: [tests](../evidence/continuous-tests.log), [typecheck](../evidence/continuous-typecheck.log), [lint](../evidence/continuous-lint.log), [build](../evidence/continuous-build.log), [UI](../evidence/continuous-ui.log). [Measured large data](../evidence/continuous-large-data.json), [UI geometry](../evidence/continuous-ui.json).

## P. Safety

BOT B **203protectedfiles checked,0changed** ở checkpoint cuối; PID7656 giữ nguyên, LIVE/scanner running/halt=null. Không gửi POST vào BOT B, không restart/kill/reset nó, không dùng key/DB/API của nó cho bot mới. Browser visual reference chỉ đọc UI; runtime API dependency vẫn0.

Bot mới không có execution route/Jupiter/wallet signer; lifecycle tests tripwire sign/send và zero foreign-network calls. Real activation chỉ bật **PAPER collection** và các GMGN reads/RPC getAccountInfo. Không real BUY/SELL/sign/submit do task. BOT B hoạt động và có thể giao dịch/ghi DB độc lập, nên không khẳng định DB/wallet BOT B byte-immutable trong thời gian này.

Không seed synthetic data vào active DB. Temp tests ở own `data/test-*` đã cleanup sau checks; active DB retained và tiếp tục nhận data thật. Secret values không có trong báo cáo/log/UI. [Source/strategy/runtime evidence](../evidence/continuous-completion.json).

## Q. Current runtime status

Checkpoint **13:03:50 ngày02/11/2026 Bangkok**:

| Mục | Trạng thái |
| --- | --- |
| New Kronos PID | **7116** |
| URL | **http://127.0.0.1:8793** |
| Market data / trading | **REAL / PAPER** |
| Collection | **RUNNING / enabled=true** |
| Real execution | **false** |
| Own trial records | **68** |
| Decisions / events | 34 /344 |
| GMGN / RPC | OK /OK |
| Native model | Loaded;11inferences,0timeouts |
| BOT B | PID7656, unchanged, LIVE |

Các count là checkpoint, không phải cap mới; bot đang chạy nên sẽ đổi. [Activation](../evidence/continuous-activation.json), [first real reads](../evidence/continuous-runtime.json), [completion](../evidence/continuous-completion.json), [actual browser](../evidence/continuous-live-browser.json).

Start lần sau: `cd C:\Users\admin\Desktop\Tool\sniper` rồi `pnpm start`; server PAUSED sau start, bật collection từ Cấu hình. Lượt này đã enable theo yêu cầu current-data loop; không bật real trading.

## Required direct answers

| # | Câu hỏi | Trả lời |
| --- | --- | --- |
| 1 | Fixed200cap removed? | **YES** |
| 2 | Replacement fixed storage cap? | **NO** |
| 3 | Record201 accepted? | **YES**, synthetic test |
| 4 | Record300 accepted? | **YES**, synthetic test;10.001 cũng lưu được |
| 5 | Real GMGN data? | **YES**, own configured key và successful reads thật |
| 6 | Real trading? | **NO** |
| 7 | Mode? | **PAPER** |
| 8 | Overview based on current BOT B? | **YES**, source/CSS/components và measured comparison |
| 9 | Redesigned into KPI dashboard? | **NO** |
| 10 | Scanner/carousel retained? | **YES** |
| 11 | Current token card retained? | **YES** |
| 12 | Evaluation card retained? | **YES**,7actual stages |
| 13 | Result card retained? | **YES** |
| 14 | Action Log retained? | **YES** |
| 15 | Bottom Positions retained? | **YES**, PAPER projection |
| 16 | JEV? | **NO runtime consumer/calls** |
| 17 | Structure V3? | **NO** |
| 18 | Controlled Markup? | **NO** |
| 19 | Trading Memory? | **NO** |
| 20 | Kronos algorithm changed? | **NO**, policy/native parity PASS |
| 21 | History paginated? | **YES** |
| 22 | `/200` in current UI? | **NO** |
| 23 | Browser loads all DB records? | **NO**, bounded endpoints/pages |
| 24 | Statistics separate? | **YES** |
| 25 | Clear REAL DATA+PAPER, same Overview layout? | **YES** |
| 26 | JEV/TypeSafe calls? | **0** |
| 27 | Real BUY from task/Kronos? | **NO** |
| 28 | Real SELL from task/Kronos? | **NO** |
| 29 | Signed/submitted transaction? | **NO** |
| 30 | BOT B modified? | **NO task-originated changes** |
