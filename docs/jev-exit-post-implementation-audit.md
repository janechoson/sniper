# Audit sau triển khai: Multi-position Jev Exit Engine

**Ngày:** 28/10/2026 — Asia/Bangkok.  
**Phạm vi:** source/build hiện tại, cấu hình lưu trên đĩa và trong runtime, SQLite production mở read-only, API/process/log LIVE, 125 test hiện có và harness bổ sung trong RAM/DOM.  
**Kết luận Q18:** **NO** — chưa đủ điều kiện chạy unattended multi-position LIVE theo chính sách mới.

Mã mới vượt qua nhiều kiểm tra quan trọng, nhưng không thể kết luận an toàn từ 125 test xanh. Audit tái hiện được race ghi lùi trạng thái giao dịch đã CONFIRMED. Ngoài ra, **tiến trình LIVE thực tế vẫn là bản cũ**, còn max-hold 30 phút và khoảng mù khi SELL BACKOFF. Trong thời gian audit có một SELL theo max-hold do chính tiến trình cũ thực hiện; RPC xác nhận finalized.

## Phương pháp và tính chỉ đọc

- Không sửa source, config hoặc `.env`; không mở production Store ở chế độ ghi; không khởi tạo Engine với database production.
- Không restart/kill tiến trình, không bật/tắt entry và không gửi API điều khiển. BUY đã tạm dừng từ trước audit và được giữ nguyên.
- Không yêu cầu, ký, gửi hoặc ép một BUY/SELL thật. Các giao dịch tự phát sinh từ PID LIVE cũ được phân biệt với hành động audit.
- Harness bổ sung chỉ tạo `Store(":memory:")`, dùng fixture provider và chặn fetch mạng; ngoại lệ duy nhất là các script đọc API/RPC production riêng biệt. Kiểm tra UI chỉ GET/HEAD, **0 mutation requests**. Fixture UI chỉ thay DOM của một trang kiểm tra.
- Chạy `pnpm build` theo yêu cầu mục 50 có tạo lại `dist`; không thay mã nguồn và không làm PID đang chạy tự nạp lại module.
- SHA-256 đối chiếu **66 tệp** trong `src/public/config/tests/scripts`: **0 thay đổi**. Artifact: `data/post-audit-source-integrity.json`.
- Chỉ tạo báo cáo này và các tệp harness/evidence trong `data/post-audit-*`. Không sửa các báo cáo lịch sử hoặc bản triển khai.

Các PASS dưới đây nói rõ là PASS **SOURCE/RAM**, không tự suy ra PASS LIVE.

## 1–2. Snapshot runtime đầu và cuối

Kiểm tra process/API đầu tiên lúc **21:58:33 Bangkok**:

- PID **16080**, bắt đầu **17:54:33.111**, uptime khoảng **4 giờ 4 phút**.
- `dist/live.js`, main process giữ `127.0.0.1:3000`, mode **live**.
- Scanner running; BUY mới **false**; haltReason/haltScope **null**; controlled **null**.
- `status.jevExit` không tồn tại: các số liệu scheduler exit là **NOT EXPOSED**.

Snapshot đầy đủ đầu lúc **22:01:18.903** và checkpoint đối chiếu lúc **22:09:31.696**:

| Metric | Đầu | Checkpoint đối chiếu |
| --- | ---: | ---: |
| PID | 16080 | 16080 |
| Mode | LIVE | LIVE |
| Uptime xấp xỉ | 4h06m46s | 4h14m59s |
| BUY mới bật? | NO | NO |
| SYSTEM halt? | NO | NO |
| TRANSACTION halt? | NO | NO |
| OPEN | 5 | 3 |
| PENDING_ENTRY | 0 | 0 |
| PENDING_EXIT | 0 | 0 |
| CLOSED | 28 | 30 |
| FAILED position records | 120 | 120 |
| UNKNOWN/AMBIGUOUS executions | 0 | 0 |
| Pending executions, gồm CREATED | 0 | 0 |
| Pending execution SELL | 0 | 0 |
| Persisted `pendingExits` opportunities | 0 | 0 |
| Legacy manual requests đang lưu | 0 | 0 |
| Jev exit jobs queued | NOT EXPOSED | NOT EXPOSED |
| Jev exit jobs active | NOT EXPOSED | NOT EXPOSED |
| Exit execution queue size thực tế | NOT EXPOSED | NOT EXPOSED |
| Exit đang thực thi / identity | NOT EXPOSED | NOT EXPOSED |
| Positions có attention | 3 | 3 |
| Positions có SELL BACKOFF còn hạn | 3 | 3 |
| Valuation cũ hơn 60 giây hoặc thiếu | 3 | 3 |

Không dùng `pending=0` để tự suy ra mọi giai đoạn preflight nội bộ đều rảnh. Trên PID này không có metric worker/exit identity tương ứng.

Database production mới có migration **1–5**, chưa có `manual_exits`, `execution_fills`, `jev_exit_decisions` của bản mới. API runtime vẫn có **`maxHoldSeconds=1800`**, trong khi source/config mới đã bỏ tham số đó. Đây là bằng chứng phiên bản đang chạy khác source hiện tại.

Log `data/normal-live-20261028-175433.stdout.log` ghi `server_started` lúc 17:54:36, mode live, broadcastEnabled=true. Stderr chỉ có cảnh báo experimental SQLite tại thời điểm đọc; stdout không có trace từng position. Chi tiết lifecycle lấy từ records/executions trong SQLite, không suy ra từ sự im lặng của stdout.

Artifacts: `data/post-audit-runtime-1793199678903.json`, `data/post-audit-runtime-1793200171696.json`, `data/post-audit-live-activity.json`.

## Findings

### F1 — HIGH: LIVE chưa chạy bản Jev Exit Engine mới

- **Vị trí:** tiến trình PID 16080 / `dist/live.js` đã nạp từ 17:54; đường normal LIVE trong `src/live.ts`, `src/server.ts`, `src/normal-live.ts`; static UI được phục vụ trực tiếp từ `public`.
- **Điều kiện:** đã build source mới nhưng tiến trình cũ chưa thay thế. Audit không thay tiến trình theo yêu cầu read-only.
- **Tái hiện:** API vẫn trả maxHoldSeconds=1800, không có jevExit; DB chỉ migration 1–5. IMAGINE không có market observation mới trong khoảng hai checkpoint dù đang BACKOFF. UI đã ghi “JEV QUẢN LÝ THOÁT LỆNH” và “vẫn theo dõi thị trường”.
- **Hậu quả thực tế:** NOCAP được tiến trình cũ SELL với reason **`Maximum holding time reached`** lúc **22:05:33.226**, quantity đóng về 0. RPC độc lập xác nhận finalized, slot **462520547**, không có lỗi. Đây không phải suy đoán từ cấu hình.
- **Khuyến nghị:** sau một tác vụ sửa lỗi riêng và nghiệm thu, triển khai bằng runbook có kiểm tra version/build ID + migrations + status. UI cần báo lệch phiên bản/capability, không khẳng định Jev quản lý khi backend không có feature đó. Audit này không restart hoặc tự bật entry.

### F2 — HIGH: hai đường reconciliation có thể ghi lùi CONFIRMED thành UNKNOWN

- **File/function:** `src/engine.ts:1116` `processExits()`; `src/engine.ts:443` `tick()` → `Executor.recover()`; `src/executor.ts:411` `reconcile()`, đặc biệt nhánh receipt thiếu tại dòng 424; `src/store.ts:421` `syncManual()`.
- **Điều kiện:** `processExits()` vào `reconcile()` khi Executor chưa busy. Nó không chiếm khóa busy cho bước reconciliation. Trong lúc chờ RPC, `tick()` có thể gọi `recover()` và reconcile cùng execution. Guard CONFIRMED chỉ được đọc trước await và trong nhánh apply thành công; nhánh missing receipt/catch không kiểm tra lại terminal state trước ghi.
- **Tái hiện RAM qua đúng hai entrypoint:**

  1. Một signed UNKNOWN/manual 50% trên 1000 token.
  2. `Engine.processExits()` bắt đầu đọc receipt nhưng chờ.
  3. `Executor.recover()` đọc receipt hợp lệ, confirm và apply fill.
  4. Trạng thái: execution **CONFIRMED**, manual **CONFIRMED**, quantity **500**.
  5. Lượt đầu trả `null` muộn: execution bị ghi **UNKNOWN**, manual bị ghi **SUBMITTED**; quantity vẫn **500**, fill count vẫn **1**.
  6. Recover tiếp nhận lại receipt hợp lệ nhưng vướng `SIGNATURE_FILL_ALREADY_APPLIED`; execution tiếp tục UNKNOWN.

- **Hậu quả:** giao dịch đã hạch toán có thể mắc kẹt pending, khóa sửa số dư ví/entry và làm manual request trông chưa tiêu thụ. **Chưa tái hiện double fill hoặc duplicate on-chain SELL**; unique fill vẫn ngăn áp dụng lần hai. Đây là lỗi monotonic state/liveness, không nên mô tả sai thành một giao dịch đã bị bán hai lần.
- **Khuyến nghị:** single-flight/mutex theo execution cho mọi đường reconcile; cập nhật trạng thái terminal bằng CAS/transaction sau await; mọi nhánh thiếu receipt/error/failed cũng phải bảo vệ CONFIRMED và manual consumption. Existing fill đã áp dụng cần được nhận diện bằng evidence hợp lệ thay vì đẩy thành UNKNOWN vĩnh viễn. Thiết kế khóa phải tránh deadlock với `execute()` gọi reconcile nội bộ.
- **Evidence:** `data/post-audit-probes.log`, probe `concurrent-reconcile` và `subsequentRecovery`.

### F3 — MEDIUM: partial SELL giữ lại định giá toàn bộ lượng token cũ

- **File/function:** `src/executor.ts:325` `applyFill()`; `src/engine.ts:790` freshness guard; `public/app.js` `makeCard()` và portfolio totals.
- **Điều kiện:** partial fill giảm quantity/cost/high-water nhưng không điều chỉnh hoặc vô hiệu hóa `lastValueLamports` / `lastQuoteAt`.
- **Tái hiện RAM:** trước bán, 1.000.000 atomic có giá trị **1.150.000 lamports**. Sau bán 50%, quantity=500.000, remainingCost=500.000 nhưng lastValue vẫn **1.150.000**. Giá trị đúng cùng market là **575.000**. Unrealized hiển thị **650.000**, đúng phải **75.000**. Quote age chỉ **26 ms**, nên chưa bị UI coi là stale.
- **Hậu quả:** PnL/portfolio/value của phần đang giữ bị phóng đại cho đến quan sát mới; bình thường guard 15 giây làm khoảng này còn tồn tại, lỗi dữ liệu có thể kéo dài hơn. Không tái hiện quantity bán sai từ stale Jev: guard quantity đã chặn trường hợp đó.
- **Khuyến nghị:** gắn valuation với quantity/version; sau partial fill đánh dấu định giá cũ hoặc scale một estimate có nhãn rõ, rồi định giá lại. API/UI không nên coi value trước fill là fresh value của phần còn lại.
- **Evidence:** `post-partial-valuation` trong `data/post-audit-probes.log`.

### F4 — MEDIUM: một protective cũ có thể làm sai ưu tiên critical mới

- **File/function:** `src/engine.ts:1116` `processExits()`, lựa chọn opportunity bằng `.find(kind === "PROTECTIVE")` và rank theo reason của phần tử đầu.
- **Điều kiện:** cùng vị thế có liquidity protective cũ trước critical security protective mới; có manual partial của vị thế khác.
- **Tái hiện:** vị thế A chứa `[liquidity, critical]`; B có manual 50%. Thứ tự thực tế **B → A**, trong khi thứ tự policy công bố security critical trước manual partial phải là **A → B**. Khi xử lý A, fresh critical cũng vẫn chọn `.find(PROTECTIVE)` đầu tiên.
- **Hậu quả:** critical không luôn được rank 2. Với nhiều manual request có thể bị trì hoãn; test đơn giản chỉ một protective mỗi vị thế không phát hiện. Không có bằng chứng old Jev HOLD xóa được protective.
- **Khuyến nghị:** chọn yêu cầu có authority/severity cao nhất từ tất cả opportunity của từng position trước khi so queue toàn cục; dùng structured reason/priority, không chỉ chuỗi reason của phần tử đầu.
- **Evidence:** `mixed-protection-priority`, `data/post-audit-probes.log`.

### F5 — MEDIUM: context Jev gán bps vào trường tên Percent

- **File/function:** `src/engine.ts:948` `scheduleExitAnalysis()`, dòng 1022–1024.
- **Điều kiện:** cấu hình mặc định trailingActivationBps=3000, trailingStopBps=2000.
- **Tái hiện:** bắt chính payload truyền vào `decideExit()` cho thấy `trailingReference={activationPercent:3000,distancePercent:2000}`. Nếu là phần trăm phải là 30/20, hoặc cần giữ tên bps.
- **Hậu quả:** Jev nhận tín hiệu tham khảo sai đơn vị; không có deterministic trailing SELL do lỗi này, nhưng có thể làm sai đánh giá chiến lược.
- **Khuyến nghị:** truyền tên Bps hoặc chuyển số sang phần trăm; kiểm thử semantic payload thay vì chỉ kiểm tra action/schema trả về.
- **Evidence:** `reference-units`, `data/post-audit-probes.log`.

### F6 — MEDIUM: stale warning phụ thuộc payload đổi, không chỉ thời gian trôi

- **File/function:** `public/app.js:322` `makeCard()` và dòng 602 fingerprint cache trong `render()`.
- **Điều kiện:** một card tạo lúc giá còn mới, sau đó position payload không đổi qua mốc 60 giây.
- **Tái hiện DOM:** fresh card: stale warnings=0; nâng `Date.now()` thêm 61 giây, render cùng payload: vẫn **0**; đổi một monitoring field rồi render: **1**. Không sửa server hoặc DB; browser mutation requests=0.
- **Hậu quả:** cảnh báo stale có thể không xuất hiện đúng hạn. Relative age vẫn có timestamp/đồng hồ; vì vậy không khẳng định UI che giấu hoàn toàn thời gian, nhưng trạng thái cảnh báo stale chưa đáng tin cậy độc lập.
- **Khuyến nghị:** cập nhật freshness theo timer hoặc thêm stale bucket/version vào rendering, có valuation quantity/version từ backend.
- **Evidence:** `data/post-audit-ui-results.json`: before=0, afterElapsed=0, afterPayloadChange=1.

### F7 — LOW: Trading Memory chưa giữ typed Jev attribution trong exit snapshot

- **File/function:** `src/trading-memory.ts:188` `exit()` (dòng 209: `jev: null`), `src/learning.ts:178` `exitReason()`, `TradingMemory.refresh()`.
- **Điều kiện/tái hiện:** HOLD → Jev SELL 50% reason ORDER_FLOW → security full. Raw decision history là `[HOLD,PARTIAL_SELL,HOLD]`; `exit_authority` là `[JEV,SECURITY]`; một sample/một outcome. Nhưng hai learning exit snapshots đều `jev=null`; outcome exitReasons là **[OTHER,SECURITY]**.
- **Hậu quả:** raw audit có thể join intent/execution/decision để truy lại đúng attribution; security không bị ghi giả thành quyết định SELL của Jev. Tuy nhiên Memory/patterns tự thân làm mất phân loại Jev exit và reason cụ thể, giảm độ chi tiết cho học/review theo quyết định thoát lệnh.
- **Khuyến nghị:** lưu immutable decision ID, authority, override reason và structured strategic reason trong learning exit evidence/outcome; giữ backward compatibility cho lịch sử.
- **Evidence:** probe `Memory attribution` trong `data/post-audit-probes-results.json`.

### F8 — LOW: cache cadence giữ ID của vị thế đã đóng không có cơ chế dọn

- **File/function:** `src/engine.ts:67`, `scheduleExitAnalysis():1048`, Map `exitScheduled`.
- **Điều kiện:** normal LIVE liên tục tạo/đóng nhiều position ID mới trong cùng một process.
- **Bằng chứng source:** Map được tạo và `.set()` khi schedule; không có delete/prune khi CLOSED hoặc giới hạn kích thước. Queue jobs riêng vẫn có cap.
- **Hậu quả:** metadata cadence tăng theo tổng số position từng schedule của process, không chỉ OPEN hiện tại. Chưa đo được ảnh hưởng bộ nhớ trên LIVE vì bản mới chưa chạy; không gán số MB giả.
- **Khuyến nghị:** prune các ID không còn eligible, hoặc LRU có bound. Không xóa lịch sử audit bền vững để xử lý cache runtime.

Không tái hiện CRITICAL như double on-chain SELL, fill áp dụng hai lần, quyết định Jev bán sai mint/quantity hoặc old HOLD hủy protective. Kết luận này chỉ giới hạn trong các đường đã kiểm tra, không phải chứng minh hình thức cho mọi trạng thái lỗi hạ tầng.

## 3–6. Monitor thật trong source và test 20 vị thế

**Source mới:** `src/engine.ts`, `Engine.monitor():790`. Timer trong `start():214` gọi mỗi **5 giây**, scanner tick cũng gọi monitor sau recovery. Selection là tất cả position **đúng env mode, provider JUPITER, state OPEN hoặc PENDING_EXIT**. Không slice theo first/latest/count. Vòng `for...of` chờ GMGN tuần tự; không await Jev hoặc SELL.

Harness tạo **20 OPEN** khác mint/ID, price/security đủ, mỗi Jev call chờ thật **5000 ms**:

| Đo lường | Kết quả |
| --- | ---: |
| Created | 20 |
| Received market valuation | **20** |
| Skipped | **0** — không có skip cần giải thích trong ca này |
| Monitor duration | **565 ms** |
| Khi monitor trả về | **18 queued, 2 active, 0 completed** |
| Max simultaneous Jev | **2** |
| Calls hoàn tất | 20 |
| Mỗi call đo được | khoảng 5012–5016 ms |
| Toàn bộ drain | khoảng **50,268 giây** |
| Monitor chờ Jev? | **NO** |

Đây là dữ liệu fixture nên không suy ra GMGN LIVE có cùng latency. GMGN thật có queue chung và CLI timeout **20 giây/request**, nên một request chậm vẫn có thể trì hoãn lượt của các vị thế sau; không có SLA định giá mọi vị thế mỗi 5 giây.

`src/jev-exit-scheduler.ts`: concurrency default **2**, config 1–4; queue default **100**, config 20–500; dedup bằng positionId ở Map/active Set. HTTP timeout **15 giây/fetch**, không phải deadline cho toàn bộ thời gian chờ trong queue. Worker dùng các Http client riêng với khoảng cách request 1 giây/client.

Stress 1000 schedule events/40 ID, fixture concurrency=3, queue=20: đo được **20 queued + 3 active**, max concurrent **3**, tổng 23 job hoàn tất sau mở gate. Job đang active không nhận thêm bản trùng; queued job cùng ID được thay payload. Queue đã đầy từ chối mint/position mới chứ không tăng vô hạn.

## 7–16. Quyết định riêng, HOLD/SELL và các override

| Test SOURCE/RAM | Kết quả |
| --- | --- |
| A HOLD, B SELL 50%, C FULL tại +15% | A còn 1.000.000; B còn 500.000; C=0; mỗi intent liên kết đúng decisionId/positionId/mint |
| HOLD tại +10%, +35% | Không opportunity SELL/không execution |
| HOLD tại −10/−30/−50/−80% | Không SELL chỉ vì lỗ |
| Age 31 phút/2h/6h/24h, Jev HOLD | Không SELL theo giờ |
| High-water +80%, hiện +50%, Jev HOLD | Không trailing SELL bắt buộc |
| Security CRITICAL khi Jev HOLD 99% | Protective full; raw Jev HOLD không bị sửa thành SELL |
| Manual 50% khi Jev HOLD | Bán đúng 50% |
| Emergency full khi Jev partial 25% | Bán toàn bộ lượng tracked |

Call path security: `monitor()` → `rememberProtection()` → persistent PROTECTIVE opportunity → `processExits()` kiểm tra security/market mới → `exitPosition()` → Executor. Không cần Jev chấp thuận. Manual đi `emergency()` lưu request → cùng worker/Executor, không chờ Jev.

`risk.ts` vẫn có helper TP/trailing để tham khảo/test. **Đường Engine mới dùng `protectiveExitDecision()`**, loại kết quả reason Take profit/Trailing profit; `detectExits()` không còn được Engine import. Vì vậy không thể chỉ thấy chữ `takeProfit` trong repo rồi kết luận nó còn ép SELL source mới.

Thứ tự code danh nghĩa: manual full rank1 → critical protective rank2 → manual partial rank3 → protective khác rank4 → Jev full rank5 → Jev partial rank6; cùng rank lấy triggeredAt/createdAt cũ trước. Manual partial được nâng thành protective full nếu fresh security critical khi xử lý, request partial bị CANCELLED. **Ngoại lệ F4**: chọn phần tử protective đầu tiên trước khi rank làm chính sách chưa luôn đúng.

## 17–18. BACKOFF và mọi điều kiện bỏ qua

Trong source mới, SELL attention.nextCheckAt **không được dùng để continue monitor**. Nó chỉ lọc execution queue. Dữ liệu lỗi có retry quan sát riêng.

| Điều kiện thực tế | Phạm vi/bỏ qua | Khoảng mù? |
| --- | --- | --- |
| `this.monitoring || this.stopping` | Return toàn lượt để chống overlap/dừng process | Một lượt chậm có thể trì hoãn lượt sau; shutdown chủ ý |
| Mode/provider/state không eligible | Không đưa vào loop | CLOSED/FAILED/PENDING_ENTRY không có định giá OPEN; không phải count cap |
| `this.stopping` trong for | Break các vị thế còn lại | Có khi shutdown |
| `p.monitoring.nextCheckAt > now` | Bỏ qua đọc lại dữ liệu vị thế đang degraded | Có data-retry gap, mặc định 60 giây; không phải SELL BACKOFF 30 phút |
| `lastQuoteAt` mới dưới 15 giây | Bỏ lượt định giá trùng | Có sampling gap chủ ý; F3 làm value trước partial còn bị giữ trong gap này |
| Market price/decimals thiếu hoặc security/market call lỗi | Catch riêng position, issue và data backoff | Có gap cho position đó; sau cùng loop tiếp tục position khác |
| PENDING_EXIT branch | Lấy market thô, không định giá quantity chưa đối soát hoặc schedule Jev mới | Chủ ý để tránh trình bày số dư/PnL giả |
| `saveObservation()` trả undefined do state/quantity/cost đổi | Không ghi snapshot cũ hoặc gọi Memory/Jev từ snapshot đó | Chờ lượt mới cho state compatible; chống race ghi đè |
| Chính isolate/DB write ném lỗi hạ tầng | Có thể thoát lượt | Không có bảo đảm tuyệt đối chống mọi lỗi DB/provider toàn hệ thống |

Executor busy **không** nằm ở guard đầu `monitor()`. SELL BACKOFF được áp dụng trong `processExits()`, không trong vòng quan sát mới.

## 19. IMAGINE thực tế: có tiếp tục market observations trong BACKOFF không?

**NO — đối với tiến trình LIVE đang chạy tại các checkpoint audit.** Không áp dụng kết luận PASS RAM của bản mới cho PID cũ.

| Trường | Checkpoint 22:09:31 |
| --- | --- |
| Core | OPEN |
| Atomic quantity | **3160729206** = 3160.729206 token |
| Remaining cost | **4325575 lamports** |
| Last observed value | **3368027 lamports** — không phải giá vừa đọc mới |
| Unrealized | **−957548 lamports**, khoảng **−22,1369%** |
| MFE / MAE | **0 / −23,6489%** |
| Attention | NEEDS_ATTENTION, TOKEN_SAFETY_FAILED / PRE_SELL / SIMULATED_BALANCE_MISMATCH |
| Failure count / exit | 3 / BACKOFF |
| Monitoring health field mới | NOT EXPOSED / không có trong persisted position cũ |
| Last valuation | **21:52:46.445** |
| Valuation age | **1005,251 giây**, khoảng 16m45s |
| Last Jev exit / decision | NOT EXPOSED / không có persisted Jev exit |
| Pending exit opportunity mới | Không có trong record cũ |
| Next SELL retry | **22:22:49.013** |
| Memory OPEN observations | **47**, không tăng giữa hai checkpoint |

Từ snapshot 22:01:18 đến kiểm tra records 22:11:58: **0** `position_market`, `position_security`, `position_failures` hoặc `jev_exit_context` mới cho IMAGINE. Timestamp valuation giữ nguyên. Lịch nextRetry vẫn ở tương lai. Đây là bằng chứng khoảng mù BACKOFF của runtime cũ, không phải chỉ thiếu metric UI.

## 20–29. Hồi phục, dedup, isolation và safety

- **Excursions/BACKOFF RAM:** −40% → +20% → +60%; MAE=−40, MFE=60, high-water tăng đến 1.600.000.000 lamports; ACTIVE monitoring và BACKOFF exit cùng tồn tại. Có 3 Memory observations khi fixture giảm observation cadence về 0, không có execution SELL. Mặc định LIVE Memory vẫn có cadence riêng; không cam kết ghi một observation mỗi tick.
- **Jev trong BACKOFF:** partial được thay thành full sau biến động; chỉ một strategic opportunity hiệu lực. HOLD mới hủy strategic unsigned. Không sửa token quantity hoặc đánh dấu TP đã khớp. Data/protective opportunity được giữ riêng.
- **Dedup:** scheduler Map/active Set theo positionId; khi áp dụng quyết định mới, Engine loại unsigned STRATEGIC cũ trước thêm một cái mới. Signed/pending state bị guard; không được thay bằng quyết định mới.
- **Nhiều exit:** fixture D emergency → C security → B Jev full → A Jev partial drain đúng D,C,B,A qua hai lượt, không mất queue còn lại. Nhưng phải đọc cùng F4, không coi ca đơn giản là chứng minh mọi tổ hợp priority.
- **Executor kéo dài:** trong khi fake execution chờ gate, ba position vẫn được cập nhật giá/PnL và scheduler tiếp tục. Existing tests còn đặt trực tiếp isBusy=true để chứng minh monitor không trả về vì busy.
- **Failure isolation:** A market error, C Jev error, E unsigned SELL validation error; B/D/F đều ACTIVE, không global halt. Catch theo position; Jev failure chuyển HOLD/FAILED; genuine auth/system/submitted ambiguity vẫn có scope riêng.
- **Jev fallback:** dùng chính `Jev.decideExit()` + `Http` với fetch giả cho timeout, HTTP500, JSON sai và schema sai: cả bốn HOLD/FAILED, không SELL. Khi provider Jev lỗi nhưng security critical, protective vẫn bán trong fixture.
- **Malformed:** −1, 0 cho PARTIAL, 10001, NaN, missing/unknown action đều không cấp quyền SELL. Parser remote không nhận position/mint làm authority: các khóa ngoài schema bị loại; identity lấy từ local job, sau đó kiểm tra state/mint/quantity/age/value. Không mô tả nhầm đây là schema reject mọi extra field.
- **Safety path:** `Executor.execute()` → validate/claim → fresh wallet/token balances → quote/amount/mint/wallet/slippage/fee checks → reverse quote cho BUY → provider.simulate + transaction/token program inspection → final validation + wallet stability/mint decimals → local signing → lưu signature trước broadcast → Jupiter execute **retry=false** → confirm → receipt reconcile. Jev chỉ chọn chiến lược/fraction, không có reference đến signer hoặc đường broadcast riêng.
- **Unsigned failure:** execution FAILED, release OPEN/owned quantity giữ nguyên, attention/backoff position-specific. Không tạo UNKNOWN có signature giả; simulation fail không gọi submit. Existing regression kiểm tra ba lần SELL fail trước ký vẫn cùng position/sample.

## 30–34. UNKNOWN, transaction-local receipt, fill và manual

Các đường retry đã tìm: `Engine.processExits()` reconcile pending; `tick()` gọi `Executor.recover()`; recover CREATED chưa submit thì discard; signed UNKNOWN gọi receipt theo signature. Đường Jupiter execute có consumed quote guard và không HTTP retry. Smoke runner là luồng riêng, không được Engine gọi.

Store.claim chặn **mọi wallet mutation mới trong cùng mode khi có signed pending**. Không tìm thấy đường tự ký lại/rebroadcast/blind replacement trước khi UNKNOWN được giải quyết.

Đối soát transaction-local sử dụng signature, receipt metadata, wallet signer/fee payer, pre/post SOL, pre/post token owner+mint, delta và before baseline đã lưu. Current balance còn cộng delta của các later executions CONFIRMED đã biết. Existing test A UNKNOWN/B confirmed sau đó/A reconcile xác nhận lượng A=500, B=500, fill rows=2 qua nhiều lượt recovery.

Giới hạn vẫn có: B chưa được đối soát thì A có thể cần lượt sau; cùng slot dùng local submittedAt làm thứ tự; external wallet changes hoặc failed network fee phía sau không được ledger giải thích vẫn fail closed/manual review. Không bỏ validation số dư để làm test xanh.

**Idempotent quantity/PnL:** transaction DB + unique signature/execution ở execution_fills và recheck trước apply. Existing success/success concurrent test và audit success/null race đều giữ fill quantity thay đổi một lần. **Nhưng terminal execution/manual state chưa idempotent/monotonic — F2 là FAIL.**

Existing manual 50% regression: 1000 → intended 500 → UNKNOWN → recover confirms → còn 500; request CONFIRMED; restart không tạo thêm 250. Full case đóng về 0 và consume request. Amount được chốt ở claim, không tính lại tỷ lệ phần còn lại. **F2 cho thấy một RPC response muộn có thể làm request đã consume quay về SUBMITTED**; trong ca đó wallet freeze ngăn gửi lần hai, nhưng bot mắc kẹt.

## 35–36. Memory: attribution và execution failures

Probe một position có HOLD → partial Jev → security full tạo **một sample/một outcome**. Raw decision/action/execution ledger phân biệt được Jev và security; latest Jev HOLD còn nguyên khi security bán. Không ghi security override thành Jev FULL_SELL.

Giới hạn typed learning evidence nêu ở F7: exit snapshot `jev=null`, strategic ORDER_FLOW thành OTHER. Muốn phân tích chi tiết cần join raw records/intent IDs; không thể khẳng định Memory aggregate hiện đã học riêng hiệu quả từng Jev exit reason.

Probe một decision ID với ba unsigned failure: **sampleCount=1, failureCount=3, decisionCount=1, closedOutcomeCount=0**, quantity giữ 1.000.000. Các failure là execution evidence, không tạo ba giao dịch/lần thua độc lập.

## 37–39. UI so với backend

PnL/quantity/MFE/MAE/Jev action/confidence lấy từ position API; monitor health từ monitoring; exitState được `positionViews()` tính từ core/attention/pending executions. Reason/time/retry từ persisted fields, không random/static fabrication.

DOM fixture xác minh monitoring ACTIVE và exit BACKOFF xuất hiện đồng thời; confidence fixture 88% lấy đúng từ payload. Actual LIVE page có **3 cards**, khớp số position còn OPEN ở checkpoint sau, không browser error và **0 mutation requests**.

Tuy nhiên:

- F1: frontend mới mô tả Jev + monitoring tiếp tục trong khi backend cũ chưa thực hiện. Screenshot `data/post-audit-live-positions.png` lưu trạng thái thật này.
- F3: API lưu value trước partial nên UI tính PnL theo value sai quantity.
- F6: cảnh báo stale chỉ được tính lúc card được dựng lại. Backend mới cung cấp timestamp nhưng chưa có field stale/valuation-quantity ràng buộc riêng; timer relative age không đủ thay thế stale-state update.

## 40–42. Search cap/time/loss toàn repo

Lưu **94 dòng match** trong `data/post-audit-policy-search.txt`; loại vendor/node_modules, generated data/dist và skill files khỏi phần đánh giá runtime. Những nhóm có thể ảnh hưởng runtime đã được trace:

| Match | Vai trò thực tế |
| --- | --- |
| `controlled-session.ts`, `live-controlled.ts` | One-BUY, cap 0,005 SOL, maxOpen=1/maxCompleted=1 chỉ khi gắn ControlledSession |
| `server.ts:55`, `live.ts`, `normal-live.ts` | Normal start không gắn ControlledSession; status hiện tại controlled=null |
| Optional controlled hooks trong Executor/Engine | Chỉ có tác dụng khi instance controlled tồn tại; không phải normal position cap |
| `config.ts` maxPositions/maxHold/stopLoss keys | Preprocess loại legacy setting, không khôi phục default bí mật |
| `risk.ts` TP/trailing | Helper cũ; normal Engine chỉ lấy protective result |
| `learning.ts` STOP_LOSS/MAX_HOLDING/drawdown | Parse/classify lịch sử và analytics; không tạo SELL |
| `trading-memory.ts` holdingDuration/drawdown | Observation/learning, không tự ép thoát |
| UI translations/test fixtures/docs cũ | Hiển thị hoặc bằng chứng lịch sử, không execution authority |
| Candidate maxAge/expiry, intent TTL | Giới hạn dữ liệu/entry/approval, không exit tuổi của owned position |
| Smoke one-shot/controlled allowance | Command riêng, không do normal scanner tự chạy |

Source mới không có position-count strategy gate, age-only SELL hoặc negative-PnL-only SELL. `maxHoldSeconds=1800` **vẫn hiện diện và có hiệu lực trong PID cũ**; NOCAP là bằng chứng runtime riêng. Không đánh đồng kết quả search source mới với chính sách đã nạp trong memory process cũ.

## 43–49. Queue growth, races, fairness và restart

- **Bound/dedup:** stress 1000 events nêu trên PASS. Queue không tích một job cho mỗi tick của cùng position đang active. Cadence mặc định 60 giây, min 15 giây cho thay đổi đáng kể.
- **Stale jobs:** input timestamp/quantity/value và current state được kiểm tra trước apply/execution; TTL mặc định 120 giây. Queue replacement giữ queuedAt ban đầu để xếp thứ tự, đồng thời dùng làm inputAt; refresh payload không làm mới timestamp này. Khi tải cao có thể loại cả payload vừa được refresh vì tuổi lần vào queue đầu; đây là giới hạn cần xem lại, không phải bằng chứng stale SELL được cho phép.
- **Stale quantity race:** thực hiện manual 50% thật trong RAM trong lúc Jev SELL50 đang chờ; old response bị SUPERSEDED, còn 500.000, không bán thêm 250.000.
- **Security race:** old Jev HOLD trả về sau khi protective đã claim làm position PENDING_EXIT; response SUPERSEDED, protective opportunity và execution vẫn nguyên. Khi còn OPEN, apply chỉ loại STRATEGIC, không loại PROTECTIVE.
- **Critical starvation:** ưu tiên nominal vượt Jev normal; test bốn vị thế PASS. Không preempt giao dịch đã ký/đang thực thi. F4 chứng minh trường hợp mixed protective không đúng rank.
- **Fairness:** finite ordinary queue drain được qua nhiều lượt; rank thấp không bị xóa chỉ vì chưa được xử lý. Execution queue dùng strict priority/FIFO cùng rank, **không aging**; không có bảo đảm latency hoặc chống starvation khi yêu cầu ưu tiên cao đến liên tục. Scheduler Jev có aging, nhưng khác với execution queue.
- **Restart compound RAM:** OPEN/unsigned strategic/backoff/manual REQUESTED/signed UNKNOWN cùng có mặt. Constructor hủy unsigned strategic approval; recover discard execution CREATED chưa ký; giữ quantity/attention; manual REQUESTED còn nguyên; UNKNOWN chỉ hỏi signature. Khi receipt xuất hiện, apply một lần, còn 500.000, fillCount=1, không pending. **PASS cho recovery không overlap; F2 vẫn làm recovery tổng thể chưa an toàn khi chạy đồng thời.**

## 50–52. Quality suite và phạm vi kết luận

| Lệnh | Kết quả |
| --- | --- |
| `pnpm test` | **125 passed / 0 failed**, duration **12041,0924 ms** |
| `pnpm typecheck` | **PASS** |
| `pnpm lint` | **PASS** |
| `pnpm build` | **PASS** |

Có engine warning do launcher pnpm toàn cục Node20, trong khi project-local Node22 chạy code có SQLite. Không tự nâng/cài dependency trong audit.

Harness chính: **14 nhóm, 12 PASS/2 FAIL**. Probe bổ sung chạy chọn lọc: **8 nhóm, 4 PASS/4 FAIL**; trong đó hai FAIL là tái hiện lại hai lỗi chính nên không cộng thành lỗi mới. Tổng có **20 nhóm code/RAM khác nhau**, kèm các tổ hợp bên trong, và probe UI riêng. Bốn lỗi mong đợi đúng nhưng code chưa đạt là F2/F3/F4/F5; UI thêm F6. Không sửa assertion hoặc production code để che các FAIL.

Harness tạm có một số setting cadence/observation interval được đặt 0 **trong RAM** để chủ động xét các mức giá liên tiếp; test slow Jev dùng thời gian chờ thật 5 giây. Không dùng kết quả cadence fixture làm cam kết cadence LIVE.

## 53. Ma trận PASS/FAIL cuối

Ma trận phân biệt source/RAM và LIVE; dấu (*) có điều kiện/giới hạn nêu rõ.

| Invariant | PASS/FAIL | Evidence |
| --- | --- | --- |
| 20 positions independently monitored | **PASS SOURCE/RAM** | 20/20, 0 skip, monitor 565 ms |
| Jev decision per position | **PASS SOURCE/RAM** | A/B/C action, mint/ID/intent liên kết riêng |
| Jev concurrency bounded | **PASS SOURCE/RAM** | Đo peak2; stress config3 peak3, queue20 |
| Slow Jev does not block monitoring | **PASS SOURCE/RAM** | 5 giây/call, monitor trả trước call đầu hoàn tất |
| Jev HOLD works | **PASS SOURCE/RAM** | +10/−50 và các mức khác không SELL |
| Jev early SELL works | **PASS SOURCE/RAM** | +15%, partial50% |
| Jev HOLD above legacy TP works | **PASS SOURCE/RAM** | +35%, trailing peak80/current50 HOLD |
| Security override works | **PASS SOURCE/RAM** | HOLD99% không veto protective full |
| Manual override works | **PASS SOURCE/RAM** | Manual50/emergencyfull không chờ Jev |
| Negative PnL alone does not SELL | **PASS SOURCE/RAM** | −10/−30/−50/−80; parse lịch sử không execution |
| Position age alone does not SELL | **PASS SOURCE, FAIL LIVE** | Source age cases HOLD; NOCAP runtime max-hold finalized |
| SELL backoff does not stop monitoring | **PASS SOURCE, FAIL LIVE** | RAM valuations tiếp tục; IMAGINE actual 0 observations trong cửa sổ |
| MFE/MAE continue during backoff | **PASS SOURCE/RAM; FAIL LIVE intent** | RAM −40/60 đúng; runtime IMA không có quan sát mới |
| One position failure isolated | **PASS (*)** | B/D/F tiếp tục; lỗi hạ tầng/thao tác DB không có bảo đảm tuyệt đối |
| Exit execution serialized safely | **FAIL tổng thể** | Execute busy và signed freeze đúng; reconciliation overlap F2 |
| Security exit priority works | **FAIL tổ hợp mixed** | D,C,B,A pass đơn giản; older-liquidity/critical vs manual sai F4 |
| UNKNOWN never blindly resent | **PASS đường kiểm tra** | Signature recovery, wallet mutation guard, retry=false |
| Transaction-local reconciliation works | **PASS chức năng (*)** | A+B known later deltas pass; F2 lỗi state cạnh tranh riêng |
| Fill idempotency works | **PASS quantity/PnL (*)** | Unique fill, một lần apply; terminal state FAIL F2 |
| Manual partial recovery cannot double-sell | **PASS chống resend (*)** | 1000→500, không 250; consumed state có thể bị ghi lùi F2 |
| Stale Jev decision cannot sell wrong quantity | **PASS đường kiểm tra** | Actual manual partial RAM trước response → SUPERSEDED |
| Security race safe | **PASS ca old-HOLD** | Protective đã claim không bị xóa |
| Restart recovery safe | **FAIL vô điều kiện** | Sequential compound pass; concurrency F2 chưa xử lý |
| Trading Memory attribution correct | **PASS raw audit, FAIL độ đầy đủ typed Memory** | Authority ledger đúng; exit.jev=null, Jev reason OTHER |

Không có PASS LIVE cho scheduler/strategy mới vì nó chưa chạy trong process production đang quan sát.

## 54. Trả lời trực tiếp Q1–Q18

1. **Q1 — 20 OPEN đều tiếp tục monitor?** **YES trong source mới/RAM**, đo 20/20. Không suy ra PID cũ đã có sửa BACKOFF.
2. **Q2 — Jev chậm có đóng băng monitor?** **NO trong source mới**; monitor 565 ms so với call 5 giây. GMGN tuần tự vẫn có thể gây trễ.
3. **Q3 — Decision độc lập theo position?** **YES**, local job ID/mint/quantity và intent liên kết riêng.
4. **Q4 — SELL trước +30%?** **YES**, +15%/50% đã chạy RAM.
5. **Q5 — HOLD trên +30%?** **YES trong source mới**, +35% và trailing case không ép bán.
6. **Q6 — Security override Jev?** **YES** về hành động; priority có ngoại lệ F4.
7. **Q7 — User override Jev?** **YES**, không cần Jev approve; signed UNKNOWN vẫn khóa sửa số dư.
8. **Q8 — PnL âm đơn lẻ trigger SELL?** **NO trong source mới**. SELL lỗ vì security/manual hoặc Jev xét bằng chứng khác vẫn có thể xảy ra.
9. **Q9 — Age đơn lẻ trigger SELL?** **NO trong source mới; YES trong PID LIVE hiện tại**, đã có NOCAP max-hold finalized.
10. **Q10 — SELL BACKOFF dừng monitoring?** **NO source mới; YES trong runtime cũ cho IMAGINE tại checkpoint**.
11. **Q11 — Một position lỗi chặn position khác?** **NO với scoped token failures đã test**; có trễ do provider tuần tự, global wallet freeze hoặc lỗi hạ tầng thật.
12. **Q12 — Nhiều exit đồng thời xử lý an toàn?** Có queue/serialization đúng cho các ca bình thường, **chưa thể YES vô điều kiện** vì race reconciliation F2 và priority F4.
13. **Q13 — UNKNOWN có bị duplicate transaction?** **Không thấy đường tự duplicate/blind resend** trong code và test; F2 gây stuck state, chưa gây một SELL thứ hai.
14. **Q14 — Fill có áp dụng hai lần?** **NO trong các đường đã kiểm chứng**, unique signature/execution + atomic apply chặn. State CONFIRMED vẫn có thể ghi lùi, là lỗi riêng.
15. **Q15 — Manual50 có thực hiện thêm250 sau recovery?** **NO ở các ca đã test**. F2 có thể làm consumed request quay lại SUBMITTED và bị treo, nên không đồng nghĩa recovery hoàn toàn đúng.
16. **Q16 — Stale Jev act trên quantity đã đổi?** **NO trong ca manual partial thực tế RAM**, response SUPERSEDED.
17. **Q17 — Old HOLD hủy security mới?** **NO trong các ca đã test**, gồm protective đã claim/PENDING_EXIT.
18. **Q18 — CURRENT implementation đủ an toàn unattended multi-position LIVE?**

   **NO**

   PID đang chạy chưa phải bản mới, còn có SELL theo giờ và blind BACKOFF; source mới còn race terminal reconciliation, sai định giá sau partial, một lỗi priority và context sai đơn vị. Test xanh không loại được các blocker này.

## 55. Blockers và evidence để review tác vụ sửa riêng

**Blocker trước nghiệm thu unattended LIVE:**

1. Sửa F2 và thêm regression có overlap `Engine.processExits()`/`Executor.recover()`, bao gồm late null/error/failed branches; terminal state/manual consumption phải monotonic.
2. Sửa F3/F6 để value/PnL/freshness có quantity/version tương thích, không có phantom PnL sau fill.
3. Sửa F4 và F5; kiểm thử nhiều protective trong cùng position và semantic units của payload Jev.
4. Chỉ sau khi source được nghiệm thu mới thay runtime theo một tác vụ triển khai riêng; xác minh version, migration6/7, actual Jev status và IMAGINE market/Memory timestamps trong BACKOFF. Không coi việc restart đơn thuần là sửa F2.

F7/F8 cần kế hoạch hoàn thiện attribution và cache bound; execution fairness dưới tải ưu tiên cao liên tục chưa có SLA.

**Artifacts chính:**

- `data/post-audit-harness.mts`, `data/post-audit-harness.log`, `data/post-audit-harness-results.json`.
- `data/post-audit-probes.log`, `data/post-audit-probes-results.json` — có assertion FAIL đúng như phát hiện, không che lỗi.
- `data/post-audit-ui.mjs`, `data/post-audit-ui-results.json`, `data/post-audit-live-positions.png`.
- `data/post-audit-runtime-1793199678903.json`, `data/post-audit-runtime-1793200171696.json`.
- `data/post-audit-live-activity.json` — activity của PID cũ và RPC finalized statuses.
- `data/post-audit-quality-tests.log`, `data/post-audit-policy-search.txt`, `data/post-audit-source-integrity.json`.

Tác vụ audit không triển khai bất kỳ bản sửa nào.

### Checkpoint chốt lúc 22:26:56.562 Bangkok

PID vẫn **16080**, uptime khoảng **4h32m23s**, BUY=false, halt=null, OPEN=3, CLOSED=30, PENDING_ENTRY/PENDING_EXIT=0, pending executions=0, attention=3, SELL BACKOFF=3; Jev exit metrics vẫn **NOT EXPOSED**. Source/config đối chiếu lại vẫn **66 tệp / 0 thay đổi**.

IMAGINE nhận thêm một quan sát **khi cooldown cũ hết hạn**: lastQuoteAt **22:22:53.096**, Memory observation count **48** (tăng từ 47), rồi lại BACKOFF đến **22:52:58.179**. Lượng token vẫn **3160729206 atomic**. Điều này phù hợp cơ chế cũ “đến hạn mới kiểm tra”, không phải monitoring liên tục trong BACKOFF; không phủ định khoảng 0 quan sát đã đo từ 22:01 đến 22:11. Ở checkpoint chốt, định giá IMAGINE lại đã cũ khoảng 4 phút.

Evidence chốt: `data/post-audit-runtime-1793201216562.json`, `data/post-audit-final-summary.json`. Các checkpoint trước trong báo cáo được giữ với timestamp riêng, không ghi đè để trình bày thành trạng thái mới.

**OVERALL VERDICT:**  
**FAIL**
