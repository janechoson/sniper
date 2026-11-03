# BOT B V5 — Post-implementation verification audit

**Ngày:** 29/10/2026 — Asia/Bangkok. **Kết luận: NEEDS FIX.**

V5 có một đường GMGN được điều phối, cache và single-flight hoạt động thật; không có một polling timer GMGN riêng cho mỗi Structure Watch. Tuy nhiên, **không thể nghiệm thu chỉ từ 186 test đạt**: audit độc lập phát hiện lỗi freshness/risk, mất header retry, starvation của Watch và mất context trước khi gửi Jev.

**Không sửa mã ứng dụng, test suite, cấu hình, `.env`, LIVE ACK hoặc DB thật.** Chỉ tạo harness/output trong `data/` và báo cáo này; chạy bốn quality commands theo yêu cầu. `dist/` được rebuild, build ID vẫn **`eae06c1456c7b99f297e7b86fe97aca1f4c000f6ecba9a5da8b32849ef297d37`**. Bot vẫn dừng. Không ký/gửi giao dịch thật; harness không mở socket. Một BUY **paper trong RAM** chỉ dùng để kiểm chứng entry authority.

## Phương pháp và giới hạn bằng chứng

Đọc đường thực thi, không lấy comment/báo cáo triển khai làm kết luận. Instrument **class GmgnCoordinator và Engine đang biên dịch từ mã hiện tại**, dùng SQLite RAM, provider fixture, virtual clock, minimum spacing **2.000 ms**, response latency giả lập **50 ms**. Không gọi `Engine.start()`; harness tái tạo lịch monitor/discovery5s và scanner15s sau khi tick kết thúc, đồng thời giữ guards, cache, queue và lifecycle thật.

`Gmgn(runner)` trong các fixture cũ mặc định spacing0; vì vậy audit thay **instance coordinator trong RAM của harness** bằng chính class ấy với cấu hình production2s. Không sửa implementation để đo. Mỗi workload chạy10phút mô phỏng; không gọi đó là latency/RPS đo ngoài mạng. Capital Flow, Jev context và UI không bị gán thêm các HTTP reads mà mã thực tế không tạo.

**`actualCalls` là transport/CLI starts.** CLI1.6.9 hiện ánh xạ mỗi command đọc được dùng thành một endpoint; retry tự động bị tắt bằng cấu hình runtime. Benchmark đếm mock transport chính xác; **HTTP thật trong harness = 0**. Không giả vờ đã đo live traffic hoặc đã chứng minh mức giảm so với V4.

Reproduce, khi bot tiếp tục dừng:

```text
pnpm exec node data/audit-v5-instrumentation.mjs
pnpm exec node data/audit-v5-instrumentation.mjs --integrity
```

Harness: `data/audit-v5-instrumentation.mjs`. Output đầy đủ: `data/audit-v5-benchmarks.json`, `.log`. Fingerprint trước/sau bao phủ mã nguồn/public/config/scripts/tests, package files, `.env` và DB/WAL/SHM gốc; không in nội dung secret.

## 1. Tất cả call sites có thể tạo GMGN network request

Đường chung: `Engine.gmgn` → `Gmgn.run()` (`src/gmgn.ts:466`) → coordinator.read → cache/single-flight → priority/spacing/cooldown → **execFile duy nhất** (`src/gmgn.ts:516`) → CLI → `OpenApiClient.executeRawRequest()` → fetch. Các URL bên dưới được đối chiếu trực tiếp từ pinned CLI, không đoán từ tên method.

| Call site | Endpoint / data type | Consumer | Trigger | Frequency thực tế | Coordinator | Shared cache / single-flight | Bypass? |
| --- | --- | --- | --- | --- | --- | --- | --- |
| DiscoveryCoordinator.pollSource → Gmgn.trending | GET `/v1/market/rank` | Trending | Feed due | Poll60s; timer5s chỉ kiểm tra due/active | YES |30s / YES | NO |
| DiscoveryCoordinator.pollSource → discover | POST `/v1/trenches` | Sniper discovery | Feed due | Poll30s, không poll từng mint | YES |15s / YES | NO |
| Engine.analyzeCandidate → info | GET `/v1/token/info` | Trending/Sniper/deep analysis/**Structure Watch** | Candidate được scheduler chọn | Tối đa5candidate/tick mặc định; không phải mỗi watch15s | YES |10s / YES | NO |
| analyzeCandidate → security | GET `/v1/token/security` | Candidate safety | Cùng analysis | Mỗi lượt đủ điều kiện tới bước này | YES |10s / YES | NO |
| intelligence → holders | GET `/v1/market/token_top_holders`, limit20 | Optional enrichment | Sau guard Sniper, hoặc Trending | Theo analysis/cache | YES |60s; SWR đến120s / YES | NO |
| intelligence → created-tokens | GET `/v1/user/created_tokens` | Creator history | Có creator address | Theo creator/cache | YES |60s; SWR đến120s / YES | NO |
| analyzeCandidate sau Jev BUY → info/security | Hai endpoints token tương ứng | Fresh pre-buy | Fresh Jev BUY | Theo attempt, không timer | YES |**TTL0** / YES | NO |
| Engine.solUsd | GET token info, mint SOL | Position valuation; paper entry | Cần SOL/USD | Call theo valuation nhưng cache30s | YES |30s / YES | NO |
| Engine.monitor → security/info | Hai endpoints token | Open/PENDING_EXIT positions | Vòng monitor chung | Timer5s; guard15s/monitor backoff; vòng await tuần tự | YES |10s / YES | NO |
| monitor → smartMoneyExits | GET `/v1/user/smartmoney`, limit50 | Optional smart-money | Nếu mode khác OFF | Call theo position; network key **không có mint**, cache dùng chung30s | YES |30s / YES | NO |
| monitor counterfactualDue → info | GET token info | Trading Memory post-exit | Bounded due observations | Theo learning settings/due, không timer mỗi mint | YES |30s; SWR45s / YES | NO |
| processExits → security/info | Hai endpoints token | Exit safety/strategic review | Có manual/protective/strategic request | Theo work queue; data không cần/không có có nhánh xử lý riêng | YES |10s mặc định / YES | NO |
| CapitalFlow.observe/observeCandidate | **Không HTTP** | Capital Flow | Nhận market/info vừa lấy | Theo observation interval | Qua producer phía trên | Reuse raw snapshot + normalizer | Không có outbound riêng |
| TradingMemory.retrieve/jevContext | **Không HTTP** | Memory / Jev entry context | DB/context projection | Theo analysis | Qua producer | Reuse facts | Không có outbound riêng |
| scheduleExitAnalysis | **Không GMGN HTTP** | Jev exit context | Fresh monitor/material/recheck trigger | Scheduler Jev riêng | Qua monitor | Reuse market/security/flow | Không có outbound riêng |
| Backend GET/SSE, flow frames | **Không GMGN HTTP** | UI | GET/status/DB projection | Status5s; fast flow frames đọc DB | Không cần outbound | DB/in-memory status | Không có bypass |
| POST `/api/scan` | Gián tiếp qua Engine.tick | Manual UI scan | Operator | Khi không đang scanning | YES | Cùng pipeline/cache | NO |
| POST `/api/exit` | Queue rồi processExits | Manual UI SELL | Operator | Không fetch trực tiếp ở handler | YES nếu cần GMGN | Cùng client | NO |
| Executor.recover / reconcile | **Không GMGN HTTP** | Recovery/UNKNOWN | tick/start/pending | Signature/RPC/Jupiter recovery | Không cần GMGN | Không áp dụng | Không có GMGN bypass |
| Watch/Deferred retry | Không client riêng | Candidate lifecycle | Refill/due chọn lại | Cùng tick | YES | Cùng analysis | NO |
| `src/verify.ts`, `src/live-controlled.ts`, `scripts/verify-jev-exit.ts`, `scripts/verify-trending-exits.ts` | Endpoints tương ứng | Operator tools | Khi chạy command | Không auto chạy trong normal Engine | YES, **instance riêng** | Chỉ chia trong process đó | Không bypass class; **không chia quota với process khác** |
| search/activity/holdings allowlist | Market search / wallet activity / holdings | Helpers có sẵn | Không thấy normal Engine poll các method này | Operator gọi rõ ràng | YES | TTL theo caller; holdings mặc định0 / YES | NO |

Đã tìm `fetch`, axios/undici/got, SDK, GMGN URLs và process spawning trong mã ứng dụng/scripts. `RateLimitedHttp.fetch` phục vụ Jupiter/Jev; Solana client phục vụ RPC. Frontend fetch là localhost API. Không thấy đường outbound GMGN bình thường bỏ qua `Gmgn.run/coordinator`. `POST /api/scan` **có** thể tạo công việc GMGN, nhưng vẫn đi qua cùng guards; không được nhầm với GET/SSE chỉ hiển thị dữ liệu.

## 2. Đo cache, single-flight, cooldown và cleanup

| Kịch bản | Logical reads / inputs | Kết quả đo |
| --- | ---: | --- |
| Cùng mint từ4consumer |4 | **1 transport,3 joins,0cache hits** |
| Consumer kế tiếp trong TTL |1 | **0 thêm transport**,1cache hit; age1.000ms, TTL10.000ms |
|10consumer thấy slightly stale |10 | **1 refresh**;10stale hits;9joins mới. Counter joins12 là cumulative, gồm3joins của test trước. |
| Cache keys | Equivalent flags / timeframe khác | Đảo thứ tự flags tương đương cho cùng key; khác window cho key khác |
|429 rồi50consumer trong cooldown |50 sau request429 đầu | **0 thêm transport**,50provider-wait rejections; không queue herd |
| Hết cooldown,50distinct requests |50 |50transport **tuần tự**, max concurrency1, peak queue50; mất122.050ms virtual gồm warm-up6success spacing3× |
|3.000unique keys |3.000 | Cache300, flights0, queue0 sau hoàn tất |

Cache không tự sweep mọi entry hết TTL; chúng có thể ở lại đến khi bị thay/evict, nhưng TTL vẫn ngăn dùng như fresh và cache bị chặn ở300. Flights được xóa trong finally; queue mặc định tối đa200pending (+1active). Consumer metrics không có cap generic, nhưng normal call sites dùng tập tên hằng hữu hạn, không lấy tên từ input người dùng.

Backoff/jitter và explicit x-ratelimit-reset text hoạt động trong class/parser tests. **Retry-After end-to-end không đạt:** dùng chính `OpenApiClient` hiện cài, fetch stub trả429 + `Retry-After:120` và JSON error hợp lệ, nhưng CLI message không có header này; adapter lấy delay=null. Xem H3. Không cần gọi GMGN thật để tái hiện.

## 3.50 Structure Watches và mixed-load qua Engine thật

Điều kiện: market/volume ổn định, security hợp lệ, Jev entry fixture trả SKIP và exit trả HOLD. Seeded observations ban đầu được tách khỏi observations mới. Không tạo bốn fake HTTP consumers cho Flow/Jev/UI trong workload Engine vì ba thành phần này thực tế không fetch riêng.

| Metric /10phút virtual |50watch,0position | Mixed, smart-money OFF | Mixed **config hiện tại WARNING** |
| --- | ---: | ---: | ---: |
| Workload Trending / watches / normal Sniper / positions |0/50/0/0 |20/50/20/20 |20/50/20/20 |
| Logical reads |200 |428 |**504** |
| Transport starts đã quan sát |200 |301 |**301** |
| Success tại cutoff |200 |300 |300 |
| Còn queued / active tại cutoff |0/0 |2/1 |1/1 |
| Transport demand gồm queued, không gọi backlog là savings |200 |303 |**302** |
| Cache hits / stale hits |0/0 |125/0 |**202/2** |
| Single-flight joins trong workload này |0 |0 |**0** |
| Reduction so với baseline mỗi logical read độc lập |**0%** |29,21% |**40,08%** |
| Max concurrency / peak queue |1/3 |1/4 |**1/5** |
| Mean queue wait |1.879,75ms |5.630,23ms |**4.964,29ms** |
| p95 / max queue wait |3.950/5.450ms |3.950/151.950ms |**27.000/47.950ms** |
| Rate-limit fixture events |0 |0 |0 |
| Jev entry / exit calls |0/0 |1/134 |**7/110** |
| Watches nhận thêm observation |50/50 |**0/50** |**0/50** |
| New observations trên50watch |85 |**0** |**0** |
| Jev calls avoided counter |85 |0 |1, từ normal Sniper khác, không phải50watch |
| Position market updates |0 |134 |**110** |
| Lớn nhất observation gap thực trên watch |**470.200ms** |Không có update mới |Không có update mới |
| Gap trên cấu hình120s |**46** |Không suy diễn0gap là khỏe |Không suy diễn0gap là khỏe |
| Oldest watch data ở cutoff |463.750ms |600.000ms |**600.000ms** |
| Global halt / errors |null/0 |null/0 |null/0 |

Snapshot interval bao gồm request bắt đầu đúng mốc cuối nên có301starts,300success và1active. p95/mean đo từ enqueue đến transport start cho jobs đã chạy; không phải provider latency hay thời gian của backlog chưa chạy. Với config hiện tại, baseline tính trên **cùng504logical reads đã phát sinh**: naive504requests, V5 cần302unique transports gồm1queued → `(504−302)/504 = 40,0794%`. Nếu lấy301starts rồi gọi cả queued request là đã tiết kiệm sẽ báo40,28% sai về bản chất.

Đây là replay/calculation baseline được định nghĩa rõ, **không chứng minh V5 giảm40,08% so với V4 LIVE**. SOL cache30s đã tồn tại trước V5. Microbench mới chứng minh khả năng collapse; trong mixed Engine case không có joins vì hầu hết callers đã tuần tự. Lợi ích cache thực trong mixed case tập trung ở SOL/USD, shared smart-money và feed/enrichment.

Endpoint starts trong mixed WARNING: token info134, security120, Trending9, Trenches12, smart-money15, holders7, creator history4. Totals301. Request gate chặn burst, nhưng không giải quyết việc công việc khác bị chờ hoặc observations quá thưa.

**Điểm không đạt:**50watch vẫn là50state không có timer riêng, nhưng phần lớn vòng data mới cần token-info và security theo mint. Giữ TTL10s trong khi revisit cách nhiều phút không tiết kiệm reads đó. Monitor P0, analysis tuần tự và await optional enrichment chiếm đường tiến triển; mặc định chỉ có5candidate/tick. Cả cấu hình WARNING hiện tại lẫn biến thể OFF đều không refresh được50watch trong10phút mixed. Ngay workload watch-only đã có46gap vượt120s làm chuỗi cấu trúc reset. Throttling bảo vệ provider, **không đồng nghĩa** Structure Watch thực hiện được nhiệm vụ.

## 4. Cooldown, missing data và các invariants khác

Combined fixture **50watch +20positions +429**:1request429 ban đầu, không thêm outbound trong cooldown,50watch vẫn ACTIVE,0SUPPORT_FAILED/RECOVERY_FAILED,50API watch quality STALE;20position monitors DEGRADED; global halt=null; Jev entry/exit0 khi không có fresh data. `recover()` vẫn được gọi3lần; manual SELL tới execution boundary1lần. Đây là stub boundary và fixture regression, **không phải** SELL/receipt thật. Sau hồi phục, observation tiếp tục, expiry gốc giữ nguyên, phase WAITING_FOR_SELLING, coordinator HEALTHY.

`numberEvidence` giữ missing là UNKNOWN; Flow normalizer/derive giữ buy/sell/net/liquidity null nếu thiếu. Ranking dùng0điểm cho dữ kiện thiếu không phải chuyển market evidence thành0. Cùng cached fetchedAt không tạo observation giả mới; không thấy timer per-mint/per-position trong Structure Watch. Timer chung, due checks và worker scheduling không bỏ qua coordinator.

Exact small-pullback curve `100,98,96,95,95,96,98,101` với directional flow/liquidity hợp lệ pass ở **2,8,29phút**; cùng original expiry30phút. Curve crash `100,80,60,40,50,42,30` không pass. Existing tests chứng minh first failed support vẫn có thể phục hồi, timer không reset và đủ30phút mà chưa có cấu trúc thì EXPIRED, không SCAM. Không thấy drawdown/recoveryRatio/ATH-distance percentage nào làm quyền vào lệnh; hai tỷ lệ chỉ được tính để mô tả. Persistence/gap/cadence vẫn là rules bắt buộc khác.

Sniper NEW với old Jev BUY99%: fresh Jev calls0, paper positions0. Cùng mint thành Trending: **forceFresh=true**,1fresh Jev call,1paper fill trong RAM; Position.entryDiscoverySource=TRENDING, allSources=SNIPER+TRENDING, sniperPhaseAtEntry=NEW. Không ký/submit thật. Điều này chứng minh authority/bypass/persistence hoạt động, nhưng không sửa được việc context gửi tới Jev bị mất field (H5).

## 5. Findings — chưa sửa

### H1 — HIGH: safe listing có thể che critical rug evidence mới

- **File/function:** `src/gmgn.ts:255`, `normalizeSecurity()`.
- **Problem:** `listing.rug_ratio ?? r.rug_ratio` ưu tiên listing cũ mà không so freshness hoặc giữ critical evidence. Fixture listing0 + security mới0,99 → normalized0, không CRITICAL. Bỏ listing cũ → normalized0,99, CRITICAL=true.
- **Runtime impact:** một tín hiệu rug critical được hàm hỗ trợ có thể bị bỏ qua. Đây là counterexample của mã hiện tại, không khẳng định ví thật từng gặp; audit không có baseline V4 đầy đủ để quy lỗi xuất hiện ở commit nào.
- **GMGN impact:** thêm fresh security request cũng không giúp nếu bước normalize tiếp tục chọn safe value cũ.
- **Recommended fix:** authority/freshness từng nguồn; known critical mới không bị safe/UNKNOWN cũ ghi đè. Regression cần test contradictory evidence, không chỉ freeze authority.

### H2 — HIGH: stale holder facts vẫn được RiskEngine dùng như facts đủ điều kiện

- **Files/functions:** `Gmgn.intelligence()`/`normalizeIntelligence()` tại `src/gmgn.ts:694`/343; Snapshot build `src/engine.ts:882`; `RiskEngine.evaluate()` tại `src/risk.ts:112`.
- **Problem:** SWR đến120s; metadata holder bị loại khi normalize. Final path refresh info/security nhưng không refresh intelligence. Risk chỉ kiểm tra tuổi market/security/Jev, không tuổi top-holder evidence.
- **Proof:** sau61s, cached top1=1%, provider fixture mới=90%; stale facts cho **Risk allowed=true**, facts mới cho **false: Top holder concentration exceeds configured policy**. Không ký/gửi BUY trong test này.
- **Runtime impact:** stale analytical snapshot có thể đóng góp vào critical BUY authorization mà không được nhận diện. Điều này không có nghĩa Jupiter SOL-debit validator bị bỏ qua; đó là hai lớp khác nhau.
- **GMGN impact:** SWR giảm chờ/reads nhưng đang vượt qua ranh giới giữa advisory và authoritative facts.
- **Recommended fix:** giữ per-field freshness, phân loại dữ liệu nào chỉ advisory; refresh/defer các facts có quyền quyết định Risk ngay trước entry. Không chữa bằng tăng TTL hoặc biến known bad thành UNKNOWN.

### H3 — HIGH: Retry-After không được honor end-to-end

- **Files/functions:** pinned `OpenApiClient.executeRawRequest()` tại `node_modules/gmgn-cli/dist/client/OpenApiClient.js:295`; `Gmgn.run()` error adapter `src/gmgn.ts:553`; `retryDelay()` `src/gmgn-coordinator.ts:292`.
- **Problem:** CLI chỉ chuyển x-ratelimit-reset tới lỗi formatted; HTTP Retry-After không được chuyển. Test helper nhận literal text không chứng minh transport relay.
- **Proof:** response429 + Retry-After120s → CLI message không chứa Retry-After, adapter delay=null. Nếu không có authoritative reset khác, fallback mặc định khoảng10–12,5s có thể thử lại sớm hơn120s.
- **Runtime/GMGN impact:** có thể tiếp tục làm ban dài thêm dù không có thundering herd.
- **Recommended fix:** relay structured status/reset/Retry-After qua transport được hỗ trợ, sanitize secrets; test từ response headers qua CLI/adapter đến coordinator deadline. Không dựa riêng vào test parser text.

### H4 — HIGH: request pressure và serial scheduling làm Watch mất observations

- **Files/functions:** `Engine.start/monitor/tick/analyzeCandidate` tại `src/engine.ts:260`,553,740; priority loop `src/gmgn-coordinator.ts:192`; config cadence/gap.
- **Proof:** mixed config hiện tại: **0/50 watches refreshed trong10phút**, không halt/fixture error. Watch-only:46gaps>120s, max470,2s.20positions mixed vẫn có110valuations nhưng watchers không tiến triển.
- **Runtime impact:** có thể hết30phút mà chưa đủ dữ liệu để xác nhận defense dù ngoài thị trường đã có hành vi phù hợp; chiến lược không được chứng minh hoạt động ở tải mục tiêu.
- **GMGN impact:** unique per-mint requests vẫn chiếm toàn budget; cache10s không giúp lượt revisit nhiều phút. Await enrichment có thể chặn progression của cả scanner.
- **Recommended fix:** budget/deadline/fairness giữa subsystems, bounded market observation scheduling, tránh await optional P5 trên đường critical; dùng batch/discovery facts chỉ khi field thật đủ chất lượng. Đo coverage và oldest-watch-age, không chỉ queue depth/concurrency. Không hạ freshness/simulation safety để ép BUY.

### H5 — HIGH: entry Jev mất context V5/Flow/nguồn/freshness

- **Files/functions:** `Engine.analyzeCandidate()` dựng state `src/engine.ts:754`, gọi `TradingMemory.jevContext()`797; whitelist `src/trading-memory.ts:577`.
- **Proof:** truyền5fields `discovery`, `capitalFlow`, `entryDiscoverySource`, `sniperStructureAtEntry`, `gmgnQuality`; **cả5 bị loại khỏi currentToken**. Serialization sau đó còn loại keys `at`. Directions trong Jev không thể tự bổ sung dữ kiện không có trong payload.
- **Runtime impact:** deterministic guard vẫn khóa Sniper, nhưng Jev entry không thật sự nhận những context báo cáo triển khai đã nói là có. Exit context dùng đường khác, không suy diễn cũng bị mất5fields này.
- **GMGN impact:** đã trả chi phí lấy/derive facts nhưng không dùng được ở entry Jev; không nên sửa bằng thêm fetch trong Jev.
- **Recommended fix:** mở whitelist bằng schema bounded/typed, bảo toàn quality/timestamps cần thiết, test **payload cuối gửi provider** và immutable learning snapshot.

### M1 — MEDIUM: position data failure bị nhầm thành entry Structure Watch

- **File/function:** `Engine.isolate()` `src/engine.ts:414`, trước nhánh xử lý position/provider.
- **Problem:** nhánh CandidateRejected + existing ACTIVE/PASSED structure không kiểm tra `!position`/ownership. Một holding Sniper có PASSED structure vẫn có thể đi vào nhánh này.
- **Proof:** OPEN quantity1.000.000, lifecycle BOUGHT, error TOKEN_DATA_INCOMPLETE tại POSITION_MONITOR → **lifecycle STRUCTURE_WATCH**, không position issue/nextCheckAt; quantity giữ nguyên.
- **Runtime impact:** sai badge/lifecycle, thiếu monitoring backoff/issue; không fake-close holding nhưng có thể lặp đọc một mint lỗi.
- **GMGN impact:** bỏ qua position retry scheduling dự kiến.
- **Recommended fix:** ownership/stage/scope trước; chỉ entry candidates chưa sở hữu được xử lý bởi Structure Watch; test owned-PASSED + unsigned data failure.

### M2 — MEDIUM: budget/cooldown chỉ trong một process

- **Files/classes:** `GmgnCoordinator` RAM fields `src/gmgn-coordinator.ts:55`; mỗi `new Gmgn` tạo coordinator riêng.
- **Problem:** scripts độc lập không chia budget; restart xóa cooldown RAM. Không có provider-wide persisted lease/deadline giữa các process.
- **Runtime/GMGN impact:** chạy verify song song hoặc restart trong ban có thể gửi lại trước reset; normal single Engine không bypass coordinator nhưng toàn API key chưa có một budget toàn cục.
- **Recommended fix:** persisted cooldown + local shared lease/khóa operator phù hợp một key; giữ endpoint/scoping theo bằng chứng. Không xoay key để né quota. Đây là static scope finding, không giả vờ đã stress nhiều process vào API thật.

## 6. Recommended fix plan — KHÔNG triển khai trong audit này

1. Sửa các authority/freshness defects H1/H2, thêm counterexample tests end-to-end tới zero-signature BUY rejection.
2. Relay Retry-After/status/reset đầy đủ và test actual transport adapter; xem xét cooldown persistence/operator coordination H3/M2.
3. Sửa M1 trước khi thay workload scheduling để các position errors được isolate đúng ownership.
4. Thiết kế budget/cadence cho H4 bằng workload đã đo; giữ protective work, đảm bảo cấu trúc có coverage thật, tránh optional enrichment chặn toàn scanner.
5. Sửa whitelist H5 với compact data contracts; đo Jev payload/quality, không tạo các GMGN consumers mới.
6. Chạy lại workload50watch và mixed với cadence/coverage, fresh Risk, header relay, UNKNOWN/manual/security regressions. Chỉ đánh giá lại verdict sau bằng chứng này; không dùng test-count làm điều kiện PASS duy nhất.

Không sửa Jupiter validators, không bật LIVE, không tăng slippage hoặc vốn trong kế hoạch audit.

## 7. Quality, secret safety và phạm vi bảo toàn

| Lệnh / kiểm tra | Kết quả |
| --- | --- |
| `pnpm test` | **186 passed,0 failed**,35.912,36ms; `data/audit-v5-tests.log` |
| `pnpm typecheck` | **PASS**, `data/audit-v5-typecheck.log` |
| `pnpm lint` | **PASS**, `data/audit-v5-lint.log` |
| `pnpm build` | **PASS**, `data/audit-v5-build.log`; ID không đổi so với artifact được audit |
| Existing execution regressions | SPL/Token-2022, SOL debit/rent/token delta, quote/slippage/simulation, exit-feasibility binding, signatures/UNKNOWN/reconciliation và multi-position cases trong suite đều qua |
| Secrets | **1019files,0findings**, không in configured secret values; `data/audit-v5-secret-audit.log`. CLI debug bị tắt; raw stderr không được ghi ra telemetry. |
| Read-only integrity | **88files checked,0changed**, checkpoint **13:36:26 Asia/Bangkok**: source/public/config/scripts/tests/packages/`.env` và `data/bot.sqlite`, WAL,SHM; `data/audit-v5-integrity-after.json` |
| Trạng thái bot thật | **0bot processes,0listeners cổng3000**. Chưa bật LIVE và chưa áp dụng fix plan. |

Build/script dùng Node22.22.0; pnpm launcher Node20 engine warning và SQLite experimental warning không phải test failures. Không chạy provider verification thật, không thay LIVE authorization. Quality commands có thể ghi fixture outputs trong `data/` và rebuild `dist/`, không sửa nguồn hoặc accounting production.

Không thấy các Jupiter transaction validators bị bỏ qua trong đường hiện tại;6001 vẫn tách khỏi GMGN và NO_SELL_ROUTE vẫn là execution/route evidence. **Điều này không phủ nhận H1/H2 ở lớp Security/Risk trước transaction.** Không có baseline mã V4 đầy đủ để tuyên bố bit-for-bit mọi validation chưa đổi; audit xác minh guards hiện tại và regression results, không suy diễn lịch sử từ tên file.

## 8. Required direct answers

| # | Câu hỏi | YES / NO và phạm vi |
| --- | --- | --- |
|1 | One controlled GMGN request path? | **YES**, trong mỗi normal Engine/client. |
|2 | Normal consumers bypass coordinator? | **NO** outbound bypass được tìm thấy. Operator process khác có coordinator riêng, xem M2. |
|3 | Dedicated GMGN polling loop/token cho Watch? | **NO** |
|4 |50watched token gây50 **equivalent** calls/refresh? | **NO** nếu cùng key trong cache/flight.50distinct mints có thể cần50distinct info và50security reads qua nhiều lượt, không thể gộp chúng như cùng dữ liệu. |
|5 | Equivalent same-mint single-flight? | **YES**,4logical→1transport,3joins. |
|6 | Shared cache thật sự dùng? | **YES**,202hits trong mixed config. |
|7 | TTLs appropriate/data-type aware đầy đủ? | **NO** về nghiệm thu tổng thể: có TTL theo loại, nhưng H2 làm freshness của Risk facts không được enforce; H4 chứng minh cadence không đáp ứng cấu trúc. |
|8 | SWR implemented safely? | **NO** tổng thể; collapse refresh đúng, nhưng holder facts stale vẫn cấp quyền Risk (H2). |
|9 | Nhiều stale consumers tạo duplicate refresh? | **NO**,10stale readers→1refresh. |
|10 | GMGN429 xử lý tập trung? | **YES**, trong một client. |
|11 | Retry-After honored? | **NO** end-to-end với current CLI khi chỉ có header này; explicit reset text được hỗ trợ. |
|12 | Bounded backoff? | **YES** |
|13 | Jitter? | **YES**, fallback có jitter, bị clip ở cap; không ngẫu nhiên hóa để retry sớm trước authoritative delay. |
|14 | Thundering-herd recovery prevented? | **YES** một client, max concurrency1 cho50requests hồi phục. |
|15 | Cooldown có reject token? | **NO** chỉ vì unsigned GMGN cooldown. Wall-clock watch/deferred expiry vẫn có thể kết thúc lượt chờ theo chính sách riêng. |
|16 | Cooldown tạo SUPPORT_FAILED? | **NO** trong error mapping/combined fixture. |
|17 | Cooldown tạo RECOVERY_FAILED? | **NO**; observation mới sau gap có thể bắt đầu lại WAITING_FOR_SELLING, không phải fault verdict từ outage. |
|18 | Missing GMGN data biến thành0? | **NO** đối với market/flow evidence đã kiểm tra. |
|19 | Watch survive temporary cooldown? | **YES**,50ACTIVE giữ nguyên và resume observation; TTL không được kéo dài. |
|20 | Identical stale data repeatedly triggers Jev? | **NO** trong cooldown paths kiểm tra: combined20positions cho0Jev calls khi không có fresh evidence. H5 vẫn làm metadata mất ở entry context. |
|21 | Trending bypass Sniper Watch? | **YES** |
|22 | Sniper→Trending dùng lối Trending? | **YES**, paper integration xác nhận authority TRENDING và giữ2sources. |
|23 |30minutes là maxTTL, không minwait? | **YES** |
|24 | Pass trước30phút? | **YES**, exact curve ở2/8/29phút. |
|25 | First failed support permanently rejects? | **NO** nếu TTL/safety còn phù hợp; regression có later recovery. |
|26 | Required hard-coded drop%? | **NO** |
|27 | Required hard-coded recovery%? | **NO** |
|28 | Jev bypass unfinished Sniper? | **NO**, deterministic Engine/Risk/final structure guards vẫn tồn tại. |
|29 | Stale Jev BUY invalidated? | **YES** trong đường kiểm tra: old BUY99% không chạy, transition gọi Jev mới với forceFresh=true. |
|30 | V5 materially reduces duplicate requests? | **YES** primitive:4equivalent concurrent reads→1, cached second read→0extra. Mixed case có0joins; không được gán lợi ích của testcase4consumers thành traffic LIVE đã tiết kiệm. |
|31 | Materially reduces spam risk? | **YES** so với naive independent-read baseline:504→302transport demand,40,08%; một active request;50cooldown readers→0additional requests. Đây không phải so sánh production V4/V5. |
|32 | Còn significant architectural rate-limit risk? | **YES**: current mixed saturates301starts/10phút nhưng0/50watch refresh; H3 retry sớm khi header bị mất; M2 process/restart scope. Không biết quota thực tế nên không khẳng định30/min chắc chắn phù hợp gói. |

## GMGN REQUEST AUDIT

Metric chính là mixed **20Trending+50Watch+20normal Sniper+20positions**, config WARNING,10phút virtual. HTTP thật0; các counts là instrumented mock transport theo đường code thực.

| Metric | Result |
| --- | --- |
| Logical reads | **504** |
| Actual HTTP calls | **0 real**; **301mock transport starts**,300success+1active,1queued; total demand302 |
| Request reduction | **40,08% vs naive504**, tính cả queued demand; không phải measured LIVE/V4 reduction |
| Cache hit rate | **40,08%** =202/504; stale hits2 tính riêng |
| Single-flight joins | **0 mixed**;3joins/4read ở same-mint test |
| Max GMGN concurrency | **1** |
| Peak queue depth | **5 mixed**,50 ở recovery stress |
| Mean / p95 / max queue wait | **4.964 /27.000 /47.950ms** virtual, jobs đã start |
|429 handling | **PASS** central typed cooldown |
| Retry-After | **FAIL** end-to-end header relay |
| Backoff | **PASS** bounded fallback |
| Jitter | **PASS**, capped fallback |
| Thundering-herd protection | **PASS** một client |
|50-watch spam protection | **PASS** không50timers/equivalent burst; **coverage FAIL** ở tải mục tiêu |
| Structure Watch isolation | **PASS** với429; TTL wall-clock giữ nguyên |
| Trending isolation | **PASS** không bị Sniper gate khóa |
| Open-position isolation | **FAIL** tổng thể do M1; riêng429/manual/recovery fixture hoạt động |

**FINAL VERDICT: NEEDS FIX.**

**TOP REMAINING RISKS — cao xuống thấp**

1. **HIGH — H1:** safe listing che critical rug evidence mới.
2. **HIGH — H2:** stale holder facts vẫn cho phép Risk approval.
3. **HIGH — H3:** Retry-After bị mất trước coordinator, có thể retry sớm và kéo dài ban.
4. **HIGH — H4:**50Watch không được refresh trong mixed load; pure-watch cũng thường vượt max observation gap.
5. **HIGH — H5:** entry Jev không nhận Flow/discovery/structure/quality được dựng trước đó.
6. **MEDIUM — M1:** owned-position data fault bị xử lý thành entry Watch, mất issue/backoff đúng scope.
7. **MEDIUM — M2:** cooldown/budget không được chia/preserve qua process/restart.
