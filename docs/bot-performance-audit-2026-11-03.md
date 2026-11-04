# BOT B — Performance Audit và kết quả đồng bộ

**Ngày: 03/11/2026 — Asia/Bangkok. AUDIT ONLY / READ ONLY.**

Báo cáo này tổng hợp kết quả audit đã thực hiện và tác vụ đồng bộ được user yêu cầu riêng. Việc tạo tài liệu không chạy lại benchmark, không sửa implementation và không pause/restart BOT.

## Phạm vi và checkpoint

- Source: `C:\Users\admin\Desktop\Tool\gmgn-sniper`.
- Destination đồng bộ: `C:\Users\admin\Desktop\Tool\sniper`.
- Repository tham chiếu: `https://github.com/janechoson/sniper`, nhánh `develop`, commit `4e486622c402fddf84d4bf154de22f78efe1f2ef`.
- Backend được đối chiếu với commit trên. Ba file UI Statistics tại máy khác commit: `public/dashboard-statistics.js`, `public/index.html`, `public/style.css`; audit dùng source thực tế tại máy.
- Runtime được quan sát: main BOT PID **17500**, cổng **127.0.0.1:3000**; legacy PAPER Lab PID **3216**, cổng **127.0.0.1:8792**.
- Build backend đang chạy tại checkpoint: `e899bad3521d484312af63c19a600d99a4133ff0a7b3abd514e97e0f9c7c21d2`.
- Node kiểm tra read-only: **22.22.0**.
- Đối chiếu trước–sau audit: **242 file nguồn/config/build/UI/tests, 0 thay đổi, 0 mất file**. Tài liệu tổng hợp này được tạo sau checkpoint đó theo yêu cầu mới của user.

Không chạy build, full tests, smoke hoặc benchmark provider thật. Không tạo BUY/SELL, ký hoặc submit transaction. Không mở application Store writable trên production DB.

SQLite inspections dùng native `DatabaseSync` với `readOnly:true`, `query_only=ON` và read transaction. Không gọi các endpoint aggregate để benchmark: overview có thể reconcile/persist, shell có RPC thật. Không fingerprint DB LIVE để tuyên bố byte-immutable khi Engine vẫn chạy.

## Kết quả đồng bộ riêng — gmgn-sniper → sniper

Đã thực hiện đồng bộ một chiều theo yêu cầu user:

| Hạng mục | Kết quả |
|---|---:|
| File được cập nhật | **87** |
| File tĩnh được đối chiếu hash | **10.229** |
| Junction được kiểm tra | **530** |
| File nguồn còn thiếu ở đích | **0** |
| File thừa ngoài `.git` được giữ riêng | **0** |
| `bot.sqlite` ở đích | `integrity_check=ok`, foreign-key violations=0 |
| `gmgn-provider.sqlite` ở đích | `integrity_check=ok`, foreign-key violations=0 |

Giữ nguyên `.git` riêng của destination, không copy Git history từ source. Không tạo backup mới trong tác vụ đồng bộ này. Hai SQLite bundles được copy theo snapshot nhất quán và kiểm tra trước khi đặt vào destination.

BOT nguồn tiếp tục chạy; không pause/restart. **Không khởi động thêm BOT tại `sniper`.** DB đích là snapshot tại thời điểm đồng bộ, không phải replication liên tục: source LIVE có thể tiếp tục ghi dữ liệu sau đó.

Các mutation tại destination thuộc yêu cầu đồng bộ riêng, không phải hành động tối ưu trong audit.

## A. Executive Summary

**Bottleneck chính nằm ở hàng đợi external I/O, SQLite đồng bộ và việc lưu/đọc lại payload lớn. Kronos dùng worker persistent, không load model cho mỗi token.**

Điểm dưới đây là đánh giá kiến trúc từ source và telemetry hiện có, không phải benchmark tải chuẩn hóa. Điểm Event-loop health không thay thế phép đo event-loop delay.

| Hạng mục | Điểm /10 |
|---|---:|
| Overall performance architecture | **6** |
| Async/concurrency | **6** |
| External I/O efficiency | **5** |
| GMGN efficiency | **6** |
| Kronos efficiency | **8** |
| JEV efficiency | **6** |
| DB efficiency | **4** |
| Event-loop health | **5** |
| Execution critical path | **6** |
| Position monitoring | **6** |

### Telemetry đọc an toàn

Checkpoint **19:30:38 ngày 03/11/2026 Bangkok** (`2026-11-03T12:30:38.472Z`):

| Dataset | Rows |
|---|---:|
| tokens | 2.630 |
| positions | 78 |
| executions | 153 |
| candidate_attempts | 2.001 |
| trending_appearances | 2.057 |
| records | 125.490 |
| trade_learning_samples | 16 |
| trade_outcomes | 14 |
| trade_observations | 5.449 |
| jev_exit_decisions | 2.562 |

Mẫu **200 attempt gần nhất**: 197 REJECTED, 2 BOUGHT, 1 RUNNING. Trong **199 attempt hoàn tất**:

- p50: **13,579 giây**.
- p95: **34 giây**.
- Max: **44,924 giây**.

Các số sau là khoảng thời gian stage trong log, **bao gồm queue, DB, CPU và I/O**, không phải wire latency:

| Stage | Mẫu | p50 | p95 |
|---|---:|---:|---:|
| Cheap Filter | 200 | 1,553s | 11,460s |
| Security | 198 | 1,981s | 11,959s |
| Compatibility | 196 | 0,193s | 0,396s |
| History | 192 | 1,866s | 9,971s |
| Capital Flow | 161 | 0,029s | 0,046s |
| Common Risk | 160 | 2,176s | 10,365s |
| Kronos evaluation | 38 | 0,566s | 0,902s |
| STANDARD Structure stage | 38 | 0,049s | 0,063s |

History được đo từ CHECKING đầu tiên đến kết thúc stage; log CHECKING bổ sung sau khi nhận candles không được dùng làm thời điểm bắt đầu mới. Stage Structure trên không đại diện toàn bộ STANDARD preparation, đặc biệt không bao gồm toàn bộ lượt chờ Smart Money trước đó.

Chỉ có 1 JEV stage và 2–4 mẫu ở nhiều stage execution trong cohort này: **không đủ kết luận latency điển hình hoặc p95**. VALIDATE chứa thời gian exit probes, không cộng các stage chồng nhau để suy tổng latency. Cohort bị chi phối bởi reject, không đại diện phân bố latency của những attempt BUY thành công.

Một mẫu OS khoảng 5 giây ghi nhận main Node khoảng **20% một core**, Python khoảng **27% một core**. Đây không phải peak, p95 hoặc bằng chứng memory leak.

**NOT MEASURED:** độ trễ mạng riêng, DNS/TCP/TLS, actual socket reuse, thời gian fsync/lock SQLite, event-loop p99, queue latency riêng từng provider, latency SELL hoàn chỉnh và throughput dưới controlled load.

### Runtime settings liên quan hiệu năng

| Setting | Giá trị tại checkpoint |
|---|---:|
| SCAN_INTERVAL_MS | 15.000ms |
| gmgnRequestIntervalMs | 2.000ms |
| gmgnReadConcurrency | 3 |
| gmgnQueueMaxSize | 200 |
| gmgnBackoffBaseMs / gmgnBackoffMaxMs | 10.000 / 300.000ms |
| candidateQueueSize / candidatesPerCycle | 10 / 5 |
| trendingPollMs / trendingLimit | 60.000ms / 100 |
| positionCollectorConcurrency | 4 |
| positionRecheckMs | 60.000ms |
| positionExitProbeMs / positionExitProbeSpacingMs | 300.000 / 30.000ms |
| jevExitConcurrency / jevExitQueueSize | 2 / 100 |
| jevExitRecheckMs | 60.000ms |
| flowMaxObservations / flowHistoryMs | 120 / 1.800.000ms |

Entries enabled; haltReason/haltScope đều null tại read-only checkpoint. Đây là quan sát trạng thái có sẵn, không phải hành động enable LIVE của audit.

## B. Actual Critical Path

```text
TRENDING discovery / backpressure
→ persist appearance → candidate queue
→ info + Cheap Filter
→ fresh Security
→ LIVE mint compatibility
→ M1 History
→ local Capital Flow
→ authoritative holders + capital/context + Common Risk
    ├─ STANDARD:
    │   local Controlled Markup
    │   → await Smart Money
    │   → Structure V3 → JEV → qualification Risk
    └─ KRONOS:
        queued native inference → qualification Risk
→ first successful SQL ownership claim
→ winner fresh info / Security / compatibility / holders / Risk
→ ownership + capital + sizing + intent
→ shared Executor
→ BUY quote → SELL probes 20/50/100
→ transaction inspection → unsigned simulation
→ final validation / wallet rereads / immediate authority
→ sign → durable signature → submit
→ confirm / receipt / reconcile
→ Position
```

Source hiện tại **không dùng Structure Watch 10 phút làm normal entry loop**: `observeStructureWatches()` là legacy method rỗng. Normal entry dùng one-shot Structure V3. Trading Memory **không được retrieve cho entry JEV của pipeline này**; Position/learning và report vẫn có consumer.

### Dependency / I/O / state map

| Stage / caller → callee | I/O, CPU và mutation | Await dependency / concurrency |
|---|---|---|
| Discovery timer/tick → `DiscoveryCoordinator.poll` | GMGN rank; merge tokens, persist appearances | Single-flight theo source; backpressure trước fetch |
| Tick → CandidateLifecycle | SQLite, JSON parse, queue admission | Candidate được phân tích tuần tự |
| Entry → Cheap Filter | GMGN info, local checks, attempt writes | Short-circuit trước Security |
| Entry → Security | Fresh GMGN security, normalization, persistence | Bắt buộc đạt trước các gate sau |
| Entry → Compatibility | RPC mint read, local inspection | LIVE-only; reject token không hỗ trợ |
| Entry → History | GMGN kline, parse/validate candles | Phải có trước Flow/Structure/model |
| Entry → Capital Flow | Local traversal candles/current fields | Không thêm network tại stage này |
| Entry → Common Risk | Fresh holders, RPC balance, SQLite ownership/capital | Phụ thuộc evidence chung |
| Fork → STANDARD | Local markup/Structure, Smart Money, JEV HTTP | Concurrent với Kronos; có network riêng |
| Fork → KRONOS | Bounded queue, Python stdin/stdout, CPU inference | Một inference tại một thời điểm |
| Branch → SQL ownership | `BEGIN IMMEDIATE`, claim/index/event | Atomic; winner không chờ peer hoàn tất |
| Winner → fresh qualification | GMGN/RPC, new Snapshot/Risk records | Freshness và safety boundary |
| Winner → Executor | Wallet reads, atomic intent/execution claim | Wallet-wide mutex |
| Executor → quote/probes | Jupiter requests, normalization/classification | BUY output/hash phải có trước SELL probes |
| Provider → simulation | RPC mint, lookup tables, accounts, simulate | Inspection và balance predicates bắt buộc |
| Executor → pre-sign | Fresh validation, wallet, authority | MUST_SEQUENTIAL |
| Provider → submit/reconcile | Sign CPU, durable SQLite, HTTP/RPC | Signature persistence phải trước submit |
| Monitor → owner analyst → exits | GMGN/RPC, local valuation, analyst jobs, persistent opportunities | Background collection; SELL qua cùng Executor |

Cache, queues, retry và timeout của các callee được tách tại phần E/H. Phần D phân loại các cơ hội parallel và giới hạn safety.

Nguồn: [one-shot-entry.ts](../src/one-shot-entry.ts#L24), [Engine.tick](../src/engine.ts#L726), [Executor](../src/executor.ts#L87), [execution-provider.ts](../src/execution-provider.ts#L230).

## C. Top Bottlenecks

**P0:** chưa xác lập bottleneck gây outage toàn hệ thống bằng bằng chứng hiện có.

| ID / Priority | Finding và evidence | Vì sao chậm / ý tưởng chưa triển khai | Impact / risk / confidence |
|---|---|---|---|
| F01 / P1 | Attempt persistence amplification: `branchStage()` persist hai lần; mỗi persist serialize toàn attempt và chạy retention DELETE | Candle/evidence/log payload được ghi lại nhiều lần ngay trên event loop. Xem xét gộp persistence, tách retention khỏi cập nhật payload | Cao khi nhiều stage; thay intermediate observability/crash trace, owner timing có thể đổi. Confidence cao |
| F02 / P1 | Shared HTTP head-of-line blocking: `Http.tail` giữ slot suốt response/retry/backoff | RPC reads, confirmation và capital checks xếp sau request đang chạy. Jupiter quote/probes/execute dùng chung client | Cao khi provider chậm; đổi scheduling có thể đổi safety/order/owner. Confidence cao |
| F03 / P1 | GMGN shared pacing và priority contention | Concurrency 3 nhưng start spacing 2s; recovery spacing 6s. P0 queued được chọn trước lane fairness | Cao cho entry/monitoring dưới tải; không tự tăng rate hoặc đổi priority. Confidence cao về cấu trúc, chưa đo queue phân rã |
| F04 / P1 | Repeated synchronous full reads/accounting | `positions()`, `executions()`, `context()` đọc/parse lại; accounting filter executions cho từng Position | Tăng theo dataset, chiếm main thread. Xem xét scoped indexed reads/operation-local grouping. Confidence cao; snapshot timing cần review |
| F05 / P2 | Scanner xử lý candidate tuần tự và backpressure discovery | Candidate dài giữ lượt; tick mới sau tick cũ +15s. Rank bị giữ khi appearances chưa tiêu thụ đủ | Throughput/freshness trade-off có chủ ý. Parallel candidates thay ownership/capital/rate-limit behavior. Confidence cao |
| F06 / P2 | STANDARD có latency bất đối xứng trước claim | Controlled Markup local, rồi await Smart Money trước Structure/JEV; Kronos không có request này | Có thể làm Kronos claim trước; không phải fixed priority. Đổi trình tự là BEHAVIOR-CHANGE RISK. Confidence cao |
| F07 / P2 | GMGN tạo CLI process cho mỗi physical command | Startup/IPC/JSON overhead; không dùng chung HTTP pool của parent qua các child | Impact thực tế NOT MEASURED. Persistent transport cần parity/security review. Confidence cao về process lifetime, vừa về impact |
| F08 / P2 | Dashboard aggregation cùng event loop trading | Statistics/full status parse nhiều records; legacy SSE full status 5s, overview 1s và callback mỗi persist | Có thể tăng latency khi nhiều clients/records. SPA đã route-isolate nhưng không loại mọi heavy endpoint. Confidence cao về cấu trúc |
| F09 / P2 | Deadline coverage chưa bao trùm mọi khoảng chờ | Unsigned 60s bắt đầu sau SQL execution claim; final/capital reads trước claim chưa nằm trong timer. Kronos queue wait ngoài forecast timeout | Không đồng nghĩa signed execution được phép xóa. Đổi deadline có thể đổi reject/BUY behavior. Confidence cao |
| F10 / P3 | Bounded local duplicate transforms | Candles project/validate nhiều lần; Structure tính lại sau fresh data | 32–60 candles, chưa ưu tiên hơn network/SQLite. Final recomputation còn có mục đích freshness. Confidence cao về duplicate work |

Nguồn: [CandidateAttempts](../src/candidate-attempt.ts#L242), [Http](../src/util.ts#L61), [GMGN coordinator](../src/gmgn-coordinator.ts#L200), [tradeAccounting](../src/trade-accounting.ts#L277), [execution deadline](../src/execution-deadline.ts).

## D. Async Opportunities và behavior preservation

Không có đề xuất `Promise.all()` chung chung.

| Location | Hiện tại | Proposed concept | Phân loại / safety |
|---|---|---|---|
| Info → Security → Compatibility | Sequential, reject sớm, stage writes giữa các await | Speculative parallel reads | SAFE_PARALLEL_CANDIDATE về dependency vật lý, chưa safe về behavior: tăng request cho token vốn reject sớm, đổi timestamps/order |
| STANDARD Smart Money → JEV | JEV input cần Structure/Smart Money | Chuẩn bị Smart Money sớm | Có thể đổi input time, queue và winner; BEHAVIOR-CHANGE RISK |
| Branch qualification `context()` | Hai branch có capital/context reads riêng | Share một context Promise | Có thể thay capital/ownership freshness; NOT SAFE FOR ZERO-BEHAVIOR OPTIMIZATION |
| Simulation lookup tables | Đọc từng table tuần tự | Bounded parallel lookup reads | Có khả năng độc lập về dữ liệu; shared RPC client vẫn serialize; slot/order/timestamps chưa chứng minh tương đương |
| `investigate()` RPC calls | `Promise.allSettled`, chung serial Http | Transport concurrency | ALREADY_PARALLEL ở caller, serialize ở client; đổi provider load/recovery timing |
| Position collection | Bounded concurrency 4, per-position dedupe | Tăng concurrency | ALREADY_PARALLEL; không mặc nhiên nhanh hơn shared GMGN budget |
| Python paths | Ba seeded forecasts tuần tự | Batch/parallel model samples | MUST_SEQUENTIAL theo contract hiện tại; có thể đổi RNG/determinism/numerics/CPU/decision. DO NOT TOUCH |
| History/Smart Money/post-exit jobs | Independent scheduled lanes | Thay lane scheduling | BACKGROUND nhưng vẫn dùng shared provider/event loop, không phải miễn phí |
| Attempt writes / analytics | Đồng bộ trên main thread | Grouping/offloading | DUPLICATE_WORK / shared contention; latency benefit và behavior parity cần kiểm chứng |

`SAFE_PARALLEL_CANDIDATE` chỉ có nghĩa có khả năng tối ưu, không phải kết luận được phép đổi code.

### Ma trận bảo toàn hành vi cho các đề xuất

| Nhóm đề xuất | Check count/order | Request/freshness/short-circuit | PASS/FAIL và input JEV/Kronos/Risk | Owner / BUY/SELL | Execution safety |
|---|---|---|---|---|---|
| Parallel/common prefetch/share context | Có thể đổi | Có thể đổi | Có thể đổi | Có thể đổi | Chưa chứng minh |
| Queue/client/concurrency/transport redesign | Chưa chứng minh | Có thể đổi | Timing có thể làm input khác hoặc stale | Có thể đổi | Chưa chứng minh |
| DB query/index/grouping cùng output | Mục tiêu giữ nguyên, cần parity | Snapshot/timing cần parity | Mục tiêu giữ nguyên | Relative timing vẫn có thể đổi owner | Phải giữ atomicity/durability |
| Gộp attempt persistence/retention | Mục tiêu giữ checks | Intermediate writes/visibility/crash trace có thể đổi | Cần parity | Timing có thể đổi | Không gộp bỏ critical persistence |
| Dashboard cache/offloading | Không đổi trading checks trực tiếp | API freshness/visibility có thể đổi | Event-loop timing có thể ảnh hưởng | UNKNOWN | Phải giữ read/command boundaries |
| Model batching / bỏ final rereads | Có thể đổi | Có thể đổi | Có thể đổi trực tiếp | Có thể đổi | Không được chấp nhận |

Mọi ý tưởng có YES hoặc UNKNOWN trên các trục này đều là **NOT SAFE FOR ZERO-BEHAVIOR OPTIMIZATION**. Thay relative completion timing có thể đổi FIRST_BUY_WINS owner, phải ghi nhận **BEHAVIOR-CHANGE RISK**. Không ý tưởng nào được nghiệm thu là zero-behavior optimization trong audit này.

## E. External I/O, caching và duplicate work

### GMGN call map

Single-flight dùng canonical command/params key tại coordinator, áp dụng cho endpoints đi qua `run()`. **TTL 0 vẫn có thể join in-flight cùng key; không có nghĩa được dùng cache cũ.** Cache bị bound 300 entries.

| Command/data | Consumer / stage | Logical calls khi đi tới stage | Cache/freshness | Queue / criticality |
|---|---|---:|---|---|
| Rank | Discovery | Một lần mỗi poll hợp lệ | Runtime poll 60s; cache khoảng nửa poll | Priority 2; backpressure có thể không fetch |
| Token info | Common Cheap | 1 | TTL 0 | Chung coordinator; critical path |
| Security | Common | 1 | TTL 0 | Priority 1; critical path |
| Kline M1 | Common History | 1 | TTL 0; from/to theo thời gian request | Priority 4; critical path |
| Holders | Common Risk | 1 | Authoritative TTL 0 | Priority 1; critical path |
| Smart Money | STANDARD | 1 | TTL 0 | Priority 4; STANDARD pre-claim path |
| Info/Security/holders | Winner final | Thêm 1 mỗi loại | Fresh lần nữa | Safety rereads; critical path |
| Info/Security | Position monitor | Theo due Position | TTL 10s | Priority 0 tại monitor |
| Kline M1 | Position history | Theo due | TTL 60s, minute-aligned window | Priority 1; background lane |
| Smart Money | Position enrichment | Theo due/material evidence | Tối đa khoảng 30s | Background |
| SOL/USD info | Valuation/sizing | Cache miss mới physical call | TTL 30s | Shared producer |
| Post-exit info | Learning observation | Theo due | TTL 30s, stale allowance riêng | Priority 5; background |

Một attempt đi hết có STANDARD và winner final cần khoảng **8 logical GMGN commands**, cộng SOL valuation nếu cache miss. Đây không phải 8 physical HTTP requests được đo. Reject sớm giảm calls; single-flight/cache có thể gộp. CLI/provider có thể có hành vi bên trong nên không đồng nhất `actualCalls` với wire traffic.

History keys chứa from/to: TTL 0 ở các giây khác nhau hoặc Position minute-aligned window **không phải cùng params**, nên không join. Làm tròn chung window sẽ thay model/evidence input semantics.

Coordinator có priority aging và routine lane wheel, nhưng queued P0 được chọn trước lane fairness. Routine Position reads hiện có priority 0 tại call site; dưới tải đủ lớn, lower-priority analysis có nguy cơ chờ dài. Đây là khả năng từ source, không phải queue-starvation event đã đo.

Cooldown authoritative có thể được chia sẻ qua provider-state DB; single-flight/cache/start pacing là per coordinator instance, không phải cross-process quota lease. Không clear cooldown để tăng tốc.

### HTTP client lifecycle

| Provider | Lifetime / pooling | Queue, pacing và timeout |
|---|---|---|
| GMGN | Parent coordinator persistent; CLI child mới cho command | 3 reads, spacing 2s; recovery 6s; child timeout 20s, output cap 4MiB; shared cooldown/backoff |
| JEV entry | Persistent Http; global Node fetch | Serialized, spacing 1s; entry dùng fresh request, không HTTP retry |
| JEV exit | Pool 4 Http objects, runtime scheduler concurrency 2 | Separate khỏi entry Http; per-position coalescing/aging; không HTTP retry ở model call |
| Jupiter | Persistent provider/Http, global fetch | Serialized, spacing 2,2s; total request deadline 60s |
| RPC | Reused Solana Connection + Http | Serialized, spacing 400ms; retry theo wrapper |

Global fetch có khả năng reuse connections trong process; source **không cấu hình explicit agent/pool**. DNS/TCP/TLS và actual socket reuse **NOT MEASURED**. Không kết luận mỗi JEV/RPC request tạo kết nối mới.

`Http` có fetch AbortSignal 15s; signal cũng gắn với response body. Với RPC/JEV, **chờ predecessor trong queue không có total enqueue deadline riêng**. Jupiter có total deadline bao gồm queue/pacing/body/retries. Retry mặc định của wrapper tối đa 3 lần cho HTTP 429/5xx, với backoff/Retry-After bị bound; các model calls truyền retry=false. Không nên gộp queue time, pacing, fetch và body thành một số network latency.

### Duplicate I/O và safety rereads

| Request | Call sites | Kết luận / single-flight candidate |
|---|---|---|
| Fresh info/security/holders | Common và winner final | Khác thời điểm/mục đích revalidation; không coi là redundant cache hit |
| Mint account | Entry compatibility, final compatibility, simulation | Reinspection bảo vệ token/program tại các boundary; không xóa vì cùng mint |
| Wallet balance/token balance | Qualification, sizing, Executor, pre-sign, reconciliation | State có thể đổi giữa awaits; không tự reuse |
| Whole executions/positions | Context, monitoring, analytics, API | Duplicate decoding thực; candidate cho operation-local grouping, phải giữ snapshot semantics |
| Global Smart Money feed | STANDARD và Position enrichment | Same-key in-flight có thể join; TTL/freshness khác nên không gộp vô điều kiện |
| Candles/Structure transformations | Common, STANDARD, winner final, Kronos projection | Bounded local repeat; final input có thể đã đổi |

### Jupiter/RPC safety và critical path

- Wallet-wide Executor mutex serialize execution; không loại bỏ để tăng throughput.
- BUY quote phải trước 20/50/100 SELL probes vì cần expected token output và buyQuoteHash binding.
- Các probes dùng cùng Jupiter Http; không bỏ probes sau khi một level thành công.
- Simulation đọc mint, lookup tables tuần tự, kiểm tra transaction/instructions, accounts và simulation deltas. Wallet+ATA đã có batch account read ở đường liên quan.
- Final validation, wallet rereads và immediate authority thực hiện trước sign.
- Transaction được deserialize/inspect và được deserialize lại tại execution boundary; chi phí riêng NOT MEASURED.
- Signature được lưu durable trước submit. Không fire-and-forget persistence.
- Confirmation poll tối đa 12 lượt status, sleep 2s giữa lượt; round-trip còn phụ thuộc RPC queue. Không có SLA chỉ bằng 12×2s.
- UNKNOWN tiếp tục investigate/reconcile, không resend hoặc xóa trách nhiệm theo timeout.

**DO NOT OPTIMIZE BY REMOVING THIS STEP:** exit probes, quote binding, transaction inspection, simulation, final authority, durable signature, receipt và reconciliation.

Nguồn: [gmgn.ts](../src/gmgn.ts#L834), [GMGN coordinator](../src/gmgn-coordinator.ts#L146), [Http](../src/util.ts#L61), [JEV](../src/jev.ts#L119), [Solana](../src/solana.ts), [execution provider](../src/execution-provider.ts#L355), [exit probes](../src/exit-feasibility.ts#L61).

## F. Loops / Complexity

Ký hiệu: T=tokens, P=Position records, E=executions, A=retained attempts, R=analytical records, Q=queue.

| Function/path | Complexity hiện tại | Khi đáng kể | Candidate |
|---|---|---|---|
| `tick → refill(store.tokens())` | Decode T, enqueue/dedupe và queue lookups; lặp trước/sau mỗi candidate | T=2.630, tối đa 5 candidates/tick | Incremental/scoped admission, không bỏ appearance semantics |
| `tradeAccounting` cho từng Position | O(P×E) cộng sort executions liên quan | API, analytics, monitor | Group executions theo Position trong cùng operation, hướng tới O(E+P+related-fill sorts) |
| `context()/pending()/reserved()/entryBlocked()` | Nhiều O(P+E) reads/parse | Qualification/final/execution hot path | Targeted reads; giữ current-state guards |
| Attempt retention mỗi persist | Scan/sort retained A | A≈2.000, nhiều stage updates | Indexed retention/bounded cleanup |
| GMGN dispatch | Sort Q mỗi launch | Q cap 200 | Queue structure khác; priority/timing phải xét |
| JevExit pump | Filter/sort Q mỗi job | Queue cap 100 | Chưa ưu tiên hơn I/O |
| Flow/Structure candle work | Bounded 60–120 samples, multiple traversals | Local stage thường nhỏ | LOW IMPACT; không đổi formula |
| Logs UI | Bounded buffer/sort/group | Tối đa 2.000 events/client buffer | DOM/render profile trước; không trộn với trading CPU |

`CandidateLifecycle.refill()` có sử dụng candidates truyền vào để enqueue Trending; không phải argument bị bỏ qua. Không micro-optimize các bounded local loops trước khi có profile chứng minh impact.

## G. SQLite, event loop, logging và dashboard

### SQLite hot paths

SQLite dùng **DatabaseSync, WAL, synchronous FULL, busy_timeout 5s**. `async` ở caller không làm query thành nonblocking.

Read-only EXPLAIN xác nhận:

| Query/path | Plan/problem | Critical path? | Candidate |
|---|---|---|---|
| `executions()` | Full table scan + parse tất cả payload | Có: context/monitor/execution; cũng dùng ở UI | Scoped reads/indexed state queries |
| Positions theo mode | Scan positions | Có | Mode/state/ID-specific access |
| History | Scan + temporary B-tree cho JSON opening-time sort | Dashboard, cùng event loop | Expression/index strategy, giữ filter/order/page |
| Attempt retention | Scan + temporary B-tree | Có: mỗi persist stage | Retention index/cadence, giữ retention contract |
| Recent records theo kind, order id | Index lọc kind nhưng còn temporary sort | Analytics/logs | Index/order phù hợp query thật |
| Discovery event mint/source lookup | Scan discovery_events | Discovery | Composite lookup index candidate |
| Security distinct-count | Temporary B-tree cho DISTINCT | Analytics | Aggregation/index candidate |

Đây là bằng chứng query shape, **không phải đo lock/fsync**. Executions hiện 153 rows; chưa được coi scan này đã gây nhiều giây delay.

Không thấy network await được giữ bên trong các callback transaction ownership/execution đã truy. Atomic claim/signature persistence phải tiếp tục synchronous và durable. Không đổi WAL/synchronous để tăng tốc trong zero-behavior task.

### Event-loop và logging

- Synchronous SQLite và JSON parse/stringify nằm trên main thread của scanner/API/execution.
- Common stage thường ghi CHECKING và PASS; summary/event tăng số writes.
- `branchStage()` gọi `strategy()` rồi mutate log: hai persist cho một stage update.
- Mỗi persist stringify toàn attempt, UPSERT và retention DELETE.
- Khi legacy SSE có subscribers, listener còn dựng overview/serialize ngay từ persistence callback.
- `Store.record()` và fault metric updates synchronous.
- `json()` scan/redact strings theo configured secrets; phải giữ redaction, CPU cost riêng NOT MEASURED.
- `stdout.write()` không await drain; không đủ bằng chứng để gọi nó luôn synchronous/blocking.
- Sync FS/crypto tại config, model/signing/runtime boundaries cần phân biệt với per-tick hot loops. Không đổi signer/key-handling để micro-optimize khi chưa đo.

Phải phân biệt UI/debug log với **ownership claim, intent, signature, fill và receipt persistence**. Không chuyển execution-critical persistence sang fire-and-forget.

### Dashboard isolation

| Route | Poll hiện tại | Backend cost chính |
|---|---:|---|
| Global shell/count | 5s | Shell balance RPC; count SQL nhẹ, không hydrate accounting |
| `/` | 1s | Overview/Position projection; `attempts.reconcile()` có thể persist |
| `/positions` | 5s | Position hydration/accounting, execution reads |
| `/history` | 5s | Filter/order/page DB + accounting |
| `/memory` | 15s | Outcomes/pattern aggregation, execution failures |
| `/settings` | On load/save | Settings projection |
| `/logs` | 5s | Events/transitions, tối đa 800 mỗi loại, token metadata lookups |
| `/thongke` | 5s | Analytics, accounting, large records reads |
| `/watchlist`, `/deferred` | 5s | Scoped state projection |

SPA route polling được hủy khi unmount, chờ lần refresh trước kết thúc. Heavy Memory/statistics **không nằm trong global shell**; shell có 1s cache/single-flight.

Các giới hạn còn lại:

- `/api/status` legacy vẫn full aggregation, gồm analytics ALL/STANDARD/KRONOS và Memory report.
- Legacy SSE có subscriber chạy full status mỗi 5s, overview mỗi 1s; listener attempt còn push theo persistence updates.
- Statistics không có shared result cache riêng.
- Nhiều browser clients nhân query/serialization load.
- Badge SQL nhẹ hơn full projection, nhưng fallback EXISTS execution theo JSON Position ID đáng xem index khi dataset lớn.
- `TradingMemory.report()` đọc/aggregate outcomes/failures/patterns; không đồng nhất việc gọi report với thao tác rebuild/persistPatterns.

Nguồn: [Store](../src/store.ts), [CandidateAttempts.persist](../src/candidate-attempt.ts#L316), [server caches/routes](../src/server.ts#L85), [legacy SSE timers](../src/server.ts#L489), [dashboard projections](../src/dashboard-view.ts#L11), [router](../public/dashboard-router.js), [analytics](../src/engine.ts#L2232).

## H. Kronos Findings

| Khía cạnh | Implementation thực tế |
|---|---|
| Process lifetime | Lazy spawn rồi giữ Python child; không tạo process cho mỗi candidate |
| Model/tokenizer lifetime | Load một lần mỗi worker lifetime; reload sau timeout/crash/resource failure |
| Queue | Cap 100, concurrency 1; Position jobs ưu tiên queued entry jobs; không preempt inference đang chạy |
| Timeout | Forecast 90s; không bao gồm chờ strategy queue |
| Serialization | OHLC 32–60 candles project ở integration, strategy và worker; Zod/schema validation lặp nhưng bounded |
| CPU | Native inference ngoài Node event loop; vẫn tranh CPU/RAM máy; 2 intra-op threads, 1 inter-op thread, priority below-normal best effort |
| Model calls | Ba seeded forecasts tuần tự, horizon 5; không đổi seed/sample count/normalization |
| Output handling | stdout bounded 128KiB, stderr giữ cuối 2KiB |
| Telemetry | `latencyMs` forecast không đại diện queue + cold load + toàn round trip |

`kill()` không được await đến process exit trong failure path; transient overlap lúc restart worker là khả năng cần kiểm chứng, chưa thấy sự cố bằng phép đo hiện tại.

Legacy Lab port 8792 là process độc lập; có thể dùng thêm quota/CPU nếu hoạt động. Mẫu OS chỉ cho thấy nó gần idle, chưa chứng minh contention đang xảy ra. Python launcher và actual Python process trên Windows không tự chứng minh có hai model instances.

Possible optimization: giảm bounded duplicate projection/validation hoặc thiết kế queue telemetry. Model batching/parallel paths, preload/cold-start changes đều phải review vì có thể đổi determinism, resource usage hoặc relative claim timing. Không sửa trong audit.

Nguồn: [KronosStrategy](../src/kronos-strategy.ts#L82), [KronosWorker](../src/kronos-worker.ts#L53), [Kronos constants](../src/kronos-domain.ts), [Python worker](../lab/kronos/worker.py#L75).

## I. STANDARD/JEV và Position monitoring

### STANDARD / KRONOS fairness

STANDARD/KRONOS bắt đầu từ cùng common Snapshot clone. STANDARD chạy synchronous prefix trước tới await Smart Money, rồi Kronos bắt đầu; **không có join chờ STANDARD xong mới chạy Kronos**. Winner SQL claim resolve ngay, không chờ nhánh thua.

Nhánh thua đang chạy có thể tiếp tục hoàn tất inference/JEV và persist kết quả; có tracking Promise và checks claim trước execution. Hủy sớm có thể giảm wasted work nhưng đổi comparison/audit output, cần cancellation design riêng.

**STANDARD chờ nhiều nhất ở đâu?** Source cho thấy extra Smart Money + JEV + shared context I/O; telemetry chưa đủ phân bổ chính xác phần nào chiếm nhiều nhất. Một JEV sample không đủ kết luận provider nhanh/chậm điển hình.

- Controlled Markup chủ yếu local CPU.
- Structure dùng cùng bounded candles, tính lại với fresh winner data; không xóa final recomputation vì nhìn giống input cũ.
- Entry JEV Http persistent nhưng serial; Exit scheduler có clients riêng, không bị buộc chờ entry Http.
- Qualification context của mỗi branch vẫn có shared RPC/SQLite contention.
- Thay tốc độ tương đối của hai branch có thể đổi owner: **BEHAVIOR-CHANGE RISK**.

Nguồn: [STANDARD preparation](../src/one-shot-entry.ts#L275), [qualification/claim](../src/one-shot-entry.ts#L550), [fork/winner](../src/one-shot-entry.ts#L639), [JEV](../src/jev.ts#L119), [JevExitScheduler](../src/jev-exit-scheduler.ts#L26).

### OPEN Position path

```text
Due collection
→ Security → market/info → SOL valuation
→ accounting/MFE/MAE/Flow/persist
→ schedule history + owner analyst
    ├─ STANDARD: bounded JEV exit jobs
    └─ KRONOS: Position-priority inference jobs
→ persistent exit opportunity
→ processExits priority selection
→ shared Executor → validation/sign/submit/reconcile
```

Position collection đã tách khỏi việc await analyst jobs, có per-position dedupe và concurrency 4. History có independent queue, spacing toàn cục 15s và due mỗi Position 60s. Exit liquidity probes có spacing toàn cục 30s và due 300s theo runtime settings. Các cadence này không phải latency SLA.

Candidate scanning vẫn có thể ảnh hưởng Position qua:

| Nguồn delay | Cơ chế |
|---|---|
| Queue wait | Chung GMGN budget và RPC/Jupiter serial clients |
| Provider wait | Request đang chạy không bị preempt; cooldown authoritative |
| Scheduler delay | History/probe cadence, analyst queue, inference active job |
| Event-loop delay | Sync DB, JSON, dashboard aggregation |
| DB wait | SQLite synchronous writes/transaction contention; latency riêng NOT MEASURED |
| CPU contention | Native Python và Node cùng tài nguyên máy |

`monitor()` có thể gọi chồng từ timer và scanner; collector gộp per-position work, nhưng phần sau collector như post-exit observations không có cùng một global single-flight. Chưa chứng minh duplicate physical request vì coordinator còn single-flight.

Reconciliation và SELL qua executor serialization có chủ đích. **Không tăng tốc bằng xóa signed/unknown pending hoặc bỏ ownership lock.**

Nguồn: [Engine.monitor](../src/engine.ts#L819), [PositionCollector](../src/position-collector.ts), [PositionHistoryMonitor](../src/position-history-monitor.ts), [Kronos Position evaluation](../src/engine.ts#L1243), [ExitLiquidityMonitor](../src/exit-feasibility.ts#L238).

## J. Estimated Optimization Plan — chưa code

### LOW RISK / HIGH IMPACT — cần chứng minh equivalence

- Profile/gộp redundant attempt writes, không thay execution-critical persistence.
- Giảm lặp parse/read executions trong cùng operation bằng stable grouping.
- EXPLAIN và fixture benchmark indexes cho retention/history/log queries.

Nhóm này ít đụng model/check hơn, **không phải bảo đảm giữ nguyên FIRST_BUY_WINS theo wall clock**.

### MEDIUM RISK / HIGH IMPACT

- Provider queue/transport separation, RPC priorities.
- GMGN persistent transport.
- Scanner/branch cancellation hoặc concurrency redesign.
- Dashboard aggregation offloading/shared snapshots.

### LOW IMPACT

- Candle projection/schema-copy consolidation.
- Bounded small-array loops.
- Queue sort optimization trước khi có queue-load profile.

### DO NOT TOUCH trong zero-behavior task

- Security/check order/freshness hoặc tăng TTL.
- Model/seeds/sample count/JEV input.
- Claim timing/arbitration hoặc handover.
- Exit probes/quote binding.
- Simulation/pre-sign/receipt.
- Durable signature và UNKNOWN reconciliation.
- SQLite durability settings.

### Benchmark nên thực hiện sau — không chạy trong audit

1. Fixture-only timers tách enqueue → start → provider completion → parse/persist cho từng stage.
2. DB copy/temp fixture với quy mô nhiều mức, EXPLAIN + elapsed distributions cho retention, accounting và dashboard queries.
3. Controlled concurrency fixtures cho FIRST_BUY_WINS: hai winner orders, stale inputs, ownership/capital changes và failures.
4. Offline pinned Kronos worker: cold/warm load, queue delay, end-to-end inference và CPU/RAM, giữ nguyên input/seeds/policy.
5. Fake RPC/Jupiter với delayed responses/retries/body để kiểm chứng head-of-line và deadline coverage, không gọi chain.
6. Isolated HTTP/UI fixture server để đo nhiều clients mà không dùng production DB/provider.

Mọi benchmark mới phải chặn external trading/provider calls và cleanup artifacts theo AGENTS.md. Không dùng safe fixture result để tự tuyên bố latency/quota LIVE đã được nghiệm thu.

## AUDIT RESULT

```text
Code changed: NO
Config changed: NO
Database changed: NO
Runtime changed: NO
Trading actions: NONE
```

Block trên áp dụng cho **performance audit đối với BOT nguồn**. Yêu cầu đồng bộ riêng đã thay file/DB tại `sniper`; file Markdown này được tạo theo yêu cầu tổng hợp sau audit. BOT LIVE có thể tự ghi DB/giao dịch độc lập, không tuyên bố DB nguồn byte-immutable. Không có real BUY/SELL/sign/submit do audit hoặc thao tác đồng bộ.

## TOP 10 OPTIMIZATIONS — chưa triển khai

| # | Ý tưởng | Impact | Risk | Effort | Confidence |
|---|---|---|---|---|---|
| 1 | Giảm redundant attempt persistence/retention mỗi stage | Cao | Vừa; audit trace/timing | Vừa | Cao |
| 2 | Scoped execution/Position queries, giảm full JSON hydration | Cao khi data tăng | Vừa; snapshot semantics | Vừa | Cao |
| 3 | Group accounting inputs theo Position trong một operation | Vừa–cao | Vừa; output/order cần parity | Vừa | Cao |
| 4 | Index candidates cho retention/history/log/discovery lookup | Vừa–cao | Thấp về dữ liệu, timing vẫn đổi | Vừa | Cao về query plan |
| 5 | Giảm lặp full analytics/dashboard aggregation | Vừa–cao | Vừa; freshness/API semantics | Vừa | Cao |
| 6 | Review RPC/Jupiter head-of-line scheduling | Cao dưới provider delay | Cao; safety/order | Cao | Cao về cấu trúc |
| 7 | Review GMGN quota/priority fairness | Cao dưới backlog | Cao; rate/owner/monitoring | Cao | Cao về cấu trúc |
| 8 | Persistent GMGN transport giữ nguyên contract | Chưa đo | Cao; transport/security parity | Cao | Vừa |
| 9 | Cancellation cho losing branch sau claim | Vừa | Cao; research trace/cancellation | Vừa–cao | Cao về wasted-work possibility |
| 10 | Giảm bounded candle copies/validation trùng | Thấp | Vừa; input parity | Thấp–vừa | Cao về duplicate work |

Mọi mục có ảnh hưởng hoặc chưa xác minh ảnh hưởng đến timing claim đều là **NOT SAFE FOR ZERO-BEHAVIOR OPTIMIZATION** cho tới khi được review và kiểm chứng riêng.
