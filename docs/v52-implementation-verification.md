# BOT B V5.2 — Implementation và verification

**Ngày:** 29/10/2026, Asia/Bangkok. **FINAL VERDICT: PASS WITH MINOR ISSUES**, trong phạm vi tính năng V5.2 dưới đây. **Bot giữ dừng; không bật LIVE.**

Đã triển khai Watch tối đa 10 phút, giao diện hàng gọn và hai thao tác bỏ quản lý có persistence. Xóa Position giữ nguyên lượng token và lịch sử; bỏ Watch thu hồi quyền của phân tích chưa ký. Giao dịch đã gửi vẫn phải đối soát. Không thêm SQL Waiting Queue, Stop Loss, Max Hold hoặc Max Open Positions.

Giới hạn còn lại: TTL ngắn giảm tích tụ nhưng không tự giải quyết burst 50 mint thiếu dữ liệu feed. Đây không phải nghiệm thu toàn bộ rủi ro capacity còn ghi trong báo cáo V5.1, hoặc bằng chứng traffic/quota ngoài mạng. Các kiểm chứng dưới đây dùng fixture, RAM/DB tạm và đồng hồ mô phỏng; browser chỉ gọi HTTP localhost. Không gọi provider thật, không ký hoặc gửi giao dịch blockchain thật.

Build đã kiểm tra: `1ae9957f3b01d0741b231f716f88cb6997e1f827d1395525c9de1add384a9b88`, policy `SNIPER_DEFENSE_V5_2`.

## A. 10-MIN STRUCTURE WATCH

| Mục                           | Kết quả                                                                                                                                                                                                                                                                          |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Old TTL                       | 30 phút                                                                                                                                                                                                                                                                          |
| New TTL                       | Tối đa 10 phút, không phải thời gian chờ bắt buộc                                                                                                                                                                                                                                |
| Single source                 | `STRUCTURE_WATCH_MAX_MS` trong `src/config.ts`; schema/default và giới hạn dùng cùng hằng. `config/strategy.json` lưu giá trị cấu hình tương ứng. UI đọc T0/expiry từ backend.                                                                                                   |
| Existing Watch reconciliation | Cấu hình legacy lớn hơn 10 phút được chuẩn hóa; expiry lấy `min(expiry cũ, T0 + TTL mới)`. Không dùng thời điểm deploy làm T0. Watch chưa xác nhận đã quá hạn chuyển EXPIRED.                                                                                                    |
| Early PASS                    | Observer thật xác nhận ở 2:00, 5:00, 9:59 đều đưa candidate sang QUEUED ngay, rời danh sách Watch ACTIVE. Có ưu tiên hữu hạn trong scheduler hiện có; không tạo timer hoặc quyền BUY riêng.                                                                                      |
| PASS ở 9:59                   | Hạn 10 phút giới hạn **thời gian xác nhận**. PASS hợp lệ trước hạn có thể hoàn tất pipeline mới sau phút 10; không dùng lại approval cũ. Structure phải còn fresh và defense hợp lệ ở các boundary. PASS muộn, timestamp sai/tương lai, dữ liệu cũ hoặc mất defense đều bị chặn. |
| Expiry                        | Chưa PASS tại `T0 + 10m` → `STRUCTURE_WATCH_EXPIRED` / `NO_CONFIRMED_BUYER_DEFENSE_WITHIN_10M`. Chỉ kết thúc cơ hội Sniper; không gán SCAM hoặc permanent blacklist.                                                                                                             |
| Transitions                   | Selling → absorption → support → recovery tiếp tục dùng evidence thật. First failed support có thể phục hồi trong cửa sổ gốc. Không thêm drop/recovery/ATH-distance % làm BUY authority.                                                                                         |
| Trending                      | Fresh Trending có đường riêng ngay khi hợp lệ; không chờ Sniper hết hạn. Giữ source history và authority TRENDING khi entry từ Trending.                                                                                                                                         |
| Provider failure              | Missing/stale/cooldown không thành support/recovery failure. Wall-clock expiry vẫn tiến, không reset sau provider recovery. Shared expiry chạy cả khi coordinator đang cooldown.                                                                                                 |

Files chính: [`src/config.ts`](../src/config.ts), [`config/strategy.json`](../config/strategy.json), [`src/sniper-structure.ts`](../src/sniper-structure.ts), [`src/candidate-lifecycle.ts`](../src/candidate-lifecycle.ts), [`src/engine.ts`](../src/engine.ts), [`src/risk.ts`](../src/risk.ts).

Regression kiểm tra curve thực tại 2m/5m/9:59, promotion qua observer, đúng biên 10m, legacy Watch 11 phút tuổi, timer không reset qua transition/outage/restart và fresh qualification sau PASS sát hạn. Mốc PASSED không phải lệnh BUY: Security, market, authoritative holder facts, Capital Flow, Memory, Jev, Risk, quote, exit feasibility và execution validation vẫn phải qua pipeline.

## B. STRUCTURE WATCH UI

Files: [`public/app.js`](../public/app.js), [`public/flow.js`](../public/flow.js), [`public/style.css`](../public/style.css), [`public/index.html`](../public/index.html).

| Mục           | Kết quả                                                                                                                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Old design    | Panel nhiều đoạn văn, viền accent và khoảng cách giữa panel; không có phép đo browser trước sửa nên không đưa ra phần trăm giảm chiều cao.                                                             |
| New design    | Hàng desktop **76px** đo bằng browser, 30 Watch trong vùng cuộn. Giữ theme PaperDAO hiện có.                                                                                                           |
| Identity/menu | Tên hoặc mint rút gọn, full mint trong title, menu ⋮ gồm Chi tiết/Bỏ theo dõi.                                                                                                                         |
| Timer         | `04:12 / 10:00`, lấy T0/expiry thật. Câu giải thích tối đa chỉ hiện một lần ở header.                                                                                                                  |
| Progress      | Bán/Hấp thụ/Hỗ trợ/Phục hồi và rail từ evidence backend; cùng evidence nhưng elapsed khác nhau có rail giống nhau.                                                                                     |
| Entry lock    | ĐANG KHÓA hoặc ĐỦ CẤU TRÚC; tooltip nhắc vẫn cần phê duyệt mới.                                                                                                                                        |
| Freshness     | `● 6s`, `Cũ · 1m42s`, `Chưa có dữ liệu`; không gán missing thành 0. FRESH, STALE_USABLE, STALE, UNKNOWN và DEGRADED đã render kiểm tra.                                                                |
| Colors        | Neutral cho quan sát, accent cho vùng đỡ, positive/success cho recovery/eligible, warning cho dữ liệu cũ, muted cho expiry; danger dành cho invalidation. Không còn viền đỏ lớn cho Watch bình thường. |
| Header        | Số lượng thực, không có mẫu số `/30` gây hiểu nhầm.                                                                                                                                                    |
| Sorting       | Phase recovery/support/selling trước, rồi expiry/mint; chỉ thay presentation.                                                                                                                          |
| Manual remove | Dialog xác nhận; disable khi đang mutation; chỉ bỏ row sau backend thành công. Lỗi 409 hiện notification và giữ row.                                                                                   |

Browser đã kiểm tra INITIAL_EXPANSION, WAITING_FOR_SELLING, SEARCHING_FOR_SUPPORT, SUPPORT_FORMING, RECOVERY_ATTEMPT và RECOVERY_CONFIRMED; regression còn bao phủ support/recovery chưa thành. Viewports **1440/1024/390**, không horizontal overflow, **0 browser errors**. Cancel không mutation, repeat POST idempotent, reload vẫn đúng, request thiếu CSRF bị 403.

Evidence: [`data/v52-ui-verification.json`](../data/v52-ui-verification.json), [`data/v52-ui-regression.log`](../data/v52-ui-regression.log); ảnh [`1440px`](../data/v52-watch-1440.png), [`1024px`](../data/v52-watch-1024.png), [`390px`](../data/v52-watch-390.png).

## C. POSITION MANUAL REMOVE

Files chính: [`src/domain.ts`](../src/domain.ts), [`src/store.ts`](../src/store.ts), [`src/engine.ts`](../src/engine.ts), [`src/position-view.ts`](../src/position-view.ts), [`src/flow-view.ts`](../src/flow-view.ts), [`src/jev-exit-scheduler.ts`](../src/jev-exit-scheduler.ts), [`src/exit-feasibility.ts`](../src/exit-feasibility.ts), [`src/server.ts`](../src/server.ts) và UI ở phần B.

| Mục                 | Kết quả                                                                                                                                                                                                                 |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema/state        | Overlay `dismissal.status=MANUALLY_REMOVED`, `dismissedAt`, `dismissedBy=USER`, `reason=USER_MANUAL`; tăng decisionRevision. Giữ core state và quantity thật, không giả CLOSED.                                         |
| API/command         | `POST /api/positions/dismiss {positionId}` → `Engine.dismissPosition()` → atomic `Store.dismissPosition()`. UUID được validate; dùng Origin/CSRF hiện có.                                                               |
| UI/confirmation     | ⋮ → Xóa khỏi Position. Dialog có token/mint, nói rõ BOT ngừng quản lý, **KHÔNG bán token trên blockchain**, token có thể còn trong ví. Số lượng hiển thị là quantity đã ghi nhận, không tự nhận là số dư chain vừa đọc. |
| Persistence/restart | Overlay lưu cùng Position. `managedPositions()` và active projection loại dismissed; mở lại Store không làm Position xuất hiện lại. Stale monitor save không được xóa dismissal/revision.                               |
| Wallet balance      | Không thay quantity, không sửa số dư ví, không SELL/SWAP/transfer/burn/close account. Browser fixture giữ `1234567` atomic và core OPEN sau remove.                                                                     |
| Monitoring stopped  | Ngừng routine position GMGN, Capital Flow observation, Jev exit, exit-liquidity jobs và automatic/manual exit mới. In-flight read được hoàn tất nhưng kết quả không tiếp tục quản lý Position.                          |
| History preserved   | Không DELETE Position, fills, receipts, signatures, learning, MFE/MAE, PnL hoặc snapshots. Raw/historical record vẫn có overlay để đọc; active UI ẩn record đó.                                                         |
| Duplicate BUY       | Ownership đọc toàn bộ raw positions, gồm dismissed. Rediscovery Sniper lẫn Trending không giải phóng guard; LIVE preflight vẫn kiểm tra token balance.                                                                  |
| Pending transaction | **Chọn block removal** khi Position không OPEN hoặc có execution pending, kể cả CREATED chưa ký và signed UNKNOWN. UI disabled; backend 409. Không xóa hay ngừng recovery của execution đã tồn tại.                     |

Test trước/sau remove: đã có routine monitor trước thao tác; sau thao tác, delta GMGN reads = 0, Flow observations = 0, Jev exit calls = 0, queued exit probes = 0, executions mới = 0. Đây là **position-specific** work, không phải tuyên bố mọi RPC cấp ví bằng 0. Test riêng cho in-flight security, stale save, reopen, unsigned/signed pending và lỗi authentication thật: removal không che SYSTEM fault.

## D. WATCH MANUAL REMOVE

Files: Store/domain/Engine/Server/UI ở trên, [`src/sniper-structure.ts`](../src/sniper-structure.ts), [`src/candidate-lifecycle.ts`](../src/candidate-lifecycle.ts), [`src/executor.ts`](../src/executor.ts), [`src/execution-provider.ts`](../src/execution-provider.ts).

| Mục                    | Kết quả                                                                                                                                                                                                                    |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| State/API              | `POST /api/watch/dismiss {mint}` → `Engine.dismissStructureWatch()`. Persist USER_REMOVED, thời điểm/actor/reason, lịch sử trạng thái trước và candidate authority revision.                                               |
| UI                     | ⋮ → Bỏ theo dõi → confirmation. Thành công thì biến mất khỏi Watch ACTIVE ngay; không chờ hết phút 10.                                                                                                                     |
| Scheduler release      | Không chọn Watch đó cho observation/lifecycle analysis mới; bỏ queued exit-independent entry work, giải phóng active-watch capacity. Persisted tombstone chặn tự tạo lại cùng Sniper sau restart/prune.                    |
| Authority invalidation | Snapshot/Intent mang revision và path. Kiểm tra sau awaited reads/Jev, trước quote/simulation/execute và callback đồng bộ **ngay trước `tx.sign()`**. Revision sai, path đổi hoặc Sniper bị remove → abort unsigned entry. |
| Jev race               | Jev đang chạy rồi trả BUY sau remove → không có intent/execution mới, không sign/submit.                                                                                                                                   |
| Pre-sign race          | Fixture remove ở quote, mint RPC và pre-sign đều abort; **0 chữ ký, 0 submit** từ các nhánh bị thu hồi.                                                                                                                    |
| In-flight requests     | Request đã chạy có thể hoàn tất. Kết quả cũ không được dùng để thêm observation, gọi Jev mới hoặc cấp quyền entry. Không thêm hệ thống cancel request phức tạp.                                                            |
| Already-submitted BUY  | Không coi transaction đã hủy. UNKNOWN tiếp tục reconcile; successful receipt tạo Position với quantity thật, không gắn dismissal của Watch lên holding mới.                                                                |
| Trending               | Tombstone chỉ chặn Sniper. Fresh Trending sau remove được refill và gọi Jev mới bằng revision/path hiện tại; toàn bộ final Risk/quote/exit-feasibility/validator vẫn bắt buộc. Không sử dụng approval Sniper cũ.           |
| Idempotency            | Repeat remove giữ nguyên resolved state/revision, kể cả sau khi row terminal đã được prune.                                                                                                                                |

Các LIVE-named unit fixtures dùng fake provider/RPC và env trong bộ nhớ test, không đọc ví thật hoặc gửi transaction. Chúng chứng minh trách nhiệm tại các boundary, không phải kết quả LIVE ngoài mạng.

## E. REQUEST IMPACT

### Comparable mixed Engine workload, 10 phút virtual

Chạy current compiled Engine + coordinator, SQLite RAM; 20 Trending + 50 Watch + 20 normal Sniper + 20 positions, smart-money WARNING, spacing **2.000ms**, latency fixture 50ms. Feed có đủ directional fields. Không tạo consumer GMGN giả cho Flow/Jev/UI. Baseline là **V5.1 cuối**, không dùng các số của V5 cũ.

| Metric                                                         |                  V5.1 30m |                  V5.2 10m |
| -------------------------------------------------------------- | ------------------------: | ------------------------: |
| Watches seeded / được refresh                                  |                   50 / 50 |                   50 / 50 |
| New Watch observations, không tính 50 seed                     |                       550 |                       550 |
| Confirmed / hard rejected / manually removed / became Trending |             0 / 0 / 0 / 0 |             0 / 0 / 0 / 0 |
| Expired tại cutoff 10m                                         |                         0 |                        50 |
| Median / p95 / max observation gap                             |             58 / 70 / 82s |             58 / 70 / 82s |
| Gaps > 120s                                                    |                         0 |                         0 |
| Positions có update / tổng valuations                          |                   20 / 67 |                   20 / 67 |
| Logical reads                                                  |                       419 |                       419 |
| Transport demand, gồm queued                                   |                       302 |                       302 |
| Transport starts / success tại cutoff                          |                 301 / 300 |                 301 / 300 |
| Cache hits / single-flight joins                               |                   117 / 0 |                   117 / 0 |
| Max concurrency / peak queue                                   |                     1 / 6 |                     1 / 6 |
| Mean / p95 / max queue wait                                    | 4.320 / 15.950 / 28.000ms | 4.320 / 15.950 / 28.000ms |
| Fixture 429 / real provider HTTP                               |                     0 / 0 |                     0 / 0 |

Ở cutoff còn 1 active và 1 queued unique transport; không tính queued là đã tiết kiệm. Tổng 600 accepted observations gồm 50 seed; 550 mới. Watch flat không PASS nên hết hạn đúng phút 10; `coverageRatio=null` khi không còn ACTIVE, không diễn giải là coverage lỗi hoặc hoàn hảo. Đây là workload seeded cố định nên không dùng nó để ước lượng tích tụ từ arrival stream.

Evidence: [`data/audit-v52-benchmarks.json`](../data/audit-v52-benchmarks.json); baseline lịch sử [`data/audit-v51-benchmarks.json`](../data/audit-v51-benchmarks.json).

### Population experiment: cùng 80 inputs trong 40 phút virtual

Current state machine/coordinator với arrival 1 mint/30s, cùng manual/hard/Trending fixtures, cùng curve xác nhận thật ở phút 3. So sánh TTL 30m counterfactual với TTL 10m. Nhánh 30m chỉ override trong harness, không sửa production config. Trending được đưa vào Store với source metadata fresh để release capacity theo path thật. Đây là **full-feed best case**, không phải replay LIVE V5.1; một batch chung/30s phục vụ mọi Watch.

| Metric                                                |    Before 30m |     After 10m |
| ----------------------------------------------------- | ------------: | ------------: |
| Inputs / Watches created                              |       80 / 79 |       80 / 80 |
| Capacity deferred                                     |             1 |             0 |
| Peak simultaneous Watches                             |            50 |            19 |
| Average simultaneous Watches                          |       30,0875 |       15,0375 |
| Confirmed trước deadline; đều ở phút 3                |             5 |             5 |
| Expired                                               |            16 |            50 |
| Hard rejected / manually removed / became Trending    |     4 / 4 / 4 |     4 / 4 / 4 |
| Median / p95 / max observation gap                    | 30 / 30 / 30s | 30 / 30 / 30s |
| GMGN logical reads                                    |         2.407 |         1.203 |
| Transport demand                                      |            80 |            80 |
| Cache hits                                            |             0 |             0 |
| Single-flight joins                                   |         2.327 |         1.123 |
| Max concurrency                                       |             1 |             1 |
| Mean queue wait / fixture 429                         |       0ms / 0 |       0ms / 0 |
| Execution rows / signatures / submissions / real HTTP | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |

Evidence: [`data/v52-population-benchmark.json`](../data/v52-population-benchmark.json), [`data/v52-population-benchmark.mjs`](../data/v52-population-benchmark.mjs).

**Diễn giải:** TTL 10m giảm average active population và logical reads khoảng **50,02%** trong stream fixture. Physical transport không giảm trong mô hình batch này vì request đã chia sẻ hoàn toàn. Mixed burst ban đầu cũng không giảm 302 unique transport demand. Vì vậy có bằng chứng giảm tích tụ, chưa có cơ sở tuyên bố đã giải quyết mọi request-pressure case hoặc giảm 50% traffic LIVE.

V5.1 đã ghi sparse/incomplete-feed mixed workload max gap 170s > 120s; V5.2 không thay transport capacity hoặc hạ freshness để che rủi ro đó. Không triển khai SQL Waiting Queue. Nếu tải thực còn nhiều burst thiếu directional feed, cần đo lại coverage/deadline để quyết định batch/capacity/fairness tiếp theo; không tự tăng request rate.

Position dismissal loại toàn bộ routine position-specific demand; Watch removal loại future Watch-specific demand ngay. Việc render timer/freshness mỗi giây chỉ dùng dữ liệu trong browser, không thêm polling GMGN.

## V5.1 regression và execution safety

| Check               | Bằng chứng hiện tại                                                                                                                                                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1                  | Endpoint critical không bị old safe listing che; bounded UNKNOWN/critical/freshness cases đạt.                                                                                                                                |
| H2                  | Stale safe holders không approve; full final BUY refresh thấy concentration 90% → reject trước execution.                                                                                                                     |
| H3                  | Actual CLI response → preload → adapter → coordinator giữ Retry-After/reset; header 120s không bị fallback retry sớm.                                                                                                         |
| H5                  | Final Jev provider body giữ bounded discovery/Capital Flow/structure/GMGN quality và timestamps.                                                                                                                              |
| M1                  | Owned PASSED Sniper fault vẫn thuộc POSITION; quantity/BOUGHT không bị biến thành entry Watch.                                                                                                                                |
| M2                  | Independent/reopened local stores giữ authoritative cooldown dài nhất. Giới hạn cũ: không phải quota lease toàn cục cho mọi máy/process.                                                                                      |
| 4 equivalent reads  | **1 transport, 3 joins**.                                                                                                                                                                                                     |
| Cached second read  | **0 transport thêm**.                                                                                                                                                                                                         |
| 10 stale readers    | **1 refresh**, 10 stale hits, 9 joins mới; cumulative joins 12 gồm 3 joins trước đó.                                                                                                                                          |
| 50 cooldown readers | **0 transport thêm** sau request 429 đầu; recovery tuần tự, max concurrency 1.                                                                                                                                                |
| Retention           | 3.000 unique keys → cache 300, flight 0, queue 0 sau hoàn tất.                                                                                                                                                                |
| Jupiter/execution   | Token-2022/SPL, SOL debit/rent/token delta, slippage, quote/simulation, exit-feasibility binding, signature persistence, UNKNOWN và reconciliation regressions đạt. Không nới validator; chỉ thêm authority check trước sign. |

Evidence: [`tests/v51-remediation.test.ts`](../tests/v51-remediation.test.ts), [`tests/v52-controls.test.ts`](../tests/v52-controls.test.ts), [`data/v52-coordinator-primitives.json`](../data/v52-coordinator-primitives.json).

## Quality và preservation

| Lệnh                                                        | Kết quả                                                                                     |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `pnpm test`                                                 | **210 passed, 0 failed, 0 skipped**, 32.725,1666ms; [`log`](../data/v52-tests.log).         |
| `pnpm typecheck`                                            | **PASS**, exit 0; [`log`](../data/v52-typecheck.log).                                       |
| `pnpm lint`                                                 | **PASS**, exit 0; [`log`](../data/v52-lint.log).                                            |
| `pnpm build`                                                | **PASS**, exit 0; [`log`](../data/v52-build.log), build ID ở đầu báo cáo.                   |
| `pnpm exec node scripts/ui-test.mjs`                        | **PASS** mọi UI suite; 0 browser errors.                                                    |
| `pnpm exec node scripts/v52-ui-verification.mjs`            | **PASS**, actual localhost handlers + browser, temp DB, workers dừng.                       |
| `pnpm exec node data/audit-v52-instrumentation.mjs`         | **PASS**, mixed Engine benchmark, 0 forbidden network.                                      |
| `pnpm exec node data/audit-v52-instrumentation.mjs --micro` | **PASS**, coordinator primitives ở bảng trên.                                               |
| `pnpm exec node data/v52-population-benchmark.mjs`          | **PASS**, matched arrival/event experiment.                                                 |
| `pnpm exec tsx scripts/audit-secrets.ts`                    | **1.072 files, 0 findings**, không in configured secrets; [`log`](../data/v52-secrets.log). |

Pnpm launcher báo Node20 engine warning; process test/build dùng pinned Node **22.22.0**. SQLite experimental warning không phải test failure. Các fixture mang nhãn LIVE vẫn là fake RPC/provider; không phải transaction thật.

Preservation verification chỉ mở **bản sao** production DB trong `data/backups/v52-copy-*`, không mở original DB để ghi. Chuẩn hóa strategy legacy 1.800.000 → 600.000ms trên copy; original DB/WAL/SHM không đổi trong verification. `.env`, token-program/Solana source, package/lock được fingerprint, không in giá trị secret.

Ledger/learning trên copy trước/sau migration giữ nguyên counts **và payload digest**: 222 positions, 881 executions/intents, 29 fills, 106.762 records, 76 learning samples, 2.268 observations, 659 exit snapshots, 93 execution evidence, 102 preflights, 788 failures, 41 outcomes. Copy hiện có **0 Structure Watch rows**, nên legacy Watch migration có bằng chứng fixture riêng, không giả vờ có actual production rows để migrate.

**Giới hạn baseline lịch sử:** hashes DB của audit V5 cũ đã khác trước verification này; original DB mtime **15:21:36 Asia/Bangkok**, trước attachment V5.2 lúc **15:22:21**; WAL/SHM cũ không còn. Không nhận thay đổi lịch sử đó là do V5.2, cũng không tuyên bố byte-identical với checkpoint V5 cũ. Bằng chứng current-original-before/after và copy ledger nằm tại [`data/v52-preservation-verification.json`](../data/v52-preservation-verification.json). Không reset DB, không sửa LIVE ACK, không chạy provider verification thật.

Checkpoint cuối **19:42:10 Asia/Bangkok**: **0 normal bot processes, 0 listeners cổng 3000**, original DB mtime vẫn giữ nguyên; WAL/SHM không xuất hiện. Evidence: [`data/v52-final-runtime.json`](../data/v52-final-runtime.json).

## Required direct answers

| #   | Câu hỏi                                                                       | YES / NO                                                       |
| --- | ----------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 1   | Is Structure Watch maximum 10 minutes?                                        | **YES**                                                        |
| 2   | Is 10 minutes mandatory waiting?                                              | **NO**                                                         |
| 3   | Can PASS occur before minute 10?                                              | **YES**                                                        |
| 4   | Does unconfirmed Watch expire at minute 10?                                   | **YES**                                                        |
| 5   | Does expiry mean scam/malicious?                                              | **NO**                                                         |
| 6   | Does first failed support immediately reject?                                 | **NO**                                                         |
| 7   | Does timer reset after structure transition?                                  | **NO**                                                         |
| 8   | Does provider recovery reset timer?                                           | **NO**                                                         |
| 9   | Can Trending bypass unfinished Sniper Watch?                                  | **YES**                                                        |
| 10  | Is fresh entry analysis required after structure PASS?                        | **YES**                                                        |
| 11  | Can user manually remove a Position?                                          | **YES**, khi không có pending execution/reconciliation         |
| 12  | After removal, does it disappear from active Position?                        | **YES**                                                        |
| 13  | After removal, does BOT stop routine monitoring it?                           | **YES**                                                        |
| 14  | Does removing Position SELL the token?                                        | **NO**                                                         |
| 15  | Does removing Position sign a blockchain transaction?                         | **NO**                                                         |
| 16  | Can token remain in wallet?                                                   | **YES**                                                        |
| 17  | Does BOT fake wallet balance to zero?                                         | **NO**                                                         |
| 18  | Is trade history preserved?                                                   | **YES**                                                        |
| 19  | Is Trading Memory preserved?                                                  | **YES**                                                        |
| 20  | Can restart automatically restore the dismissed Position?                     | **NO**                                                         |
| 21  | Can BOT accidentally BUY same mint again while wallet still owns it?          | **NO**, các ownership guards hiện có vẫn bắt buộc              |
| 22  | Can user manually remove a Structure Watch?                                   | **YES**                                                        |
| 23  | Does it immediately disappear from active Watch?                              | **YES**, sau backend acknowledgment                            |
| 24  | Does Watch-specific monitoring stop?                                          | **YES**, in-flight kết quả cũ không có authority               |
| 25  | Does it release scheduler capacity?                                           | **YES**                                                        |
| 26  | Does manual Watch remove mean Security failure?                               | **NO**                                                         |
| 27  | Can an old in-flight Jev BUY execute after removal?                           | **NO**                                                         |
| 28  | Is candidate authority rechecked before signing?                              | **YES**                                                        |
| 29  | If transaction was already submitted, does reconciliation continue?           | **YES**                                                        |
| 30  | Can manually removed Sniper later independently appear through Trending?      | **YES**                                                        |
| 31  | Does that Trending path require fresh analysis?                               | **YES**                                                        |
| 32  | Is Watch UI materially more compact?                                          | **YES**, 76px desktop rows                                     |
| 33  | Are giant red normal Watch cards removed?                                     | **YES**                                                        |
| 34  | Is repeated timer explanation removed from every row?                         | **YES**                                                        |
| 35  | Does UI use actual structure evidence rather than elapsed-time fake progress? | **YES**                                                        |
| 36  | Did H1/H2/H3/H5/M1/M2 remain fixed?                                           | **YES**, trong phạm vi các regression và local cooldown đã nêu |
| 37  | Does GMGN single-flight still work?                                           | **YES**                                                        |
| 38  | Does Retry-After still work?                                                  | **YES**                                                        |
| 39  | Were Jupiter validators loosened?                                             | **NO**                                                         |
| 40  | Were existing positions/trade history destructively deleted?                  | **NO**                                                         |
| 41  | Was LIVE enabled?                                                             | **NO**                                                         |

**FINAL VERDICT: PASS WITH MINOR ISSUES — V5.2 implemented và kiểm chứng; bot vẫn dừng.** Rủi ro sparse-feed/burst capacity đã nêu vẫn cần giữ trong đánh giá vận hành; kết quả này không tự cấp phép LIVE hoặc chứng minh mức giảm traffic production.
