# Global GMGN Discovery / Token Scanner — audit

Ngày 2026-11-02, Asia/Bangkok. AUDIT ONLY. Đọc source hiện tại, compiled CLI, API localhost và SQLite bằng `DatabaseSync({readOnly:true})` + `PRAGMA query_only=ON`. Không instantiate Engine/Store, không gọi GMGN mới để audit. Một reproduction chỉ gọi hàm parser thuần với dữ liệu synthetic trong RAM.

## 1. Kết luận

**B — PARTIALLY CONFIRMED.** Có repeated selection của cùng mint, nhưng việc đọc list sau mỗi candidate không đồng nghĩa một GMGN network request mới. Production có durable appearance queue; không phải vòng lặp luôn lấy token đầu tiên từ response GMGN. Tuy nhiên không có batch snapshot/cursor/completion barrier bảo đảm duyệt hết một response trước lần fetch tiếp theo.

**Nếu GMGN trả 200 token ở GET đầu tiên: NO, code không bảo đảm attempt hết 200 trước khi lấy/rebuild list.** `parseTrending` trong `src/gmgn.ts:129` cắt `rank.slice(0,100)`. T101–T200 không vào queue từ response đó. Với 100 token còn lại, `DiscoveryCoordinator.poll` chỉ chặn fetch khi unconsumed appearances >= queue size, không chờ hết batch; `Engine.tick` liên tục refill từ DB; `CandidateLifecycle.list` không có ORDER BY. Không có cursor 0..199.

Không đủ evidence kết luận runtime chỉ quanh quẩn vài mint: sample 100 attempt gần nhất có **96 mint khác nhau**, bốn mint xuất hiện hai lần. Mỗi lần có UUID và Security/History timestamp mới. Sample này không chứng minh khả năng xử lý công bằng vô hạn hoặc coverage của toàn bộ ranking.

Evidence: [runtime](global-discovery-audit-runtime.json), [baseline](global-discovery-audit-baseline.json), [verification](global-discovery-audit-verification.json).

## 2. Owner, endpoint và consumer graph

```text
GMGN GET https://openapi.gmgn.ai/v1/market/rank
  ├─ installed gmgn-cli / OpenApiClient.getTrendingSwaps
  │    ↑ Gmgn.trending ← DiscoveryCoordinator.pollSource(TRENDING)
  │                         └─ Store.discover + enqueueTrending
  │                              ├─ tokens DB → GET /api/tokens → main UI
  │                              │                         └→ KronosMarket.discover
  │                              └─ appearances DB → lifecycle → Engine.tick
  │                                                      └→ oneShotEntry
  └─ KronosMarket fallback HTTP read (nếu production không có fresh token)
       └─ KronosStore.add → Lab tick → paper evaluation/monitoring

Kronos UI → GET /api/kronos → Lab state (không trực tiếp gọi listing)
Position monitor → GMGN info/security/participant reads; không phải listing loop
```

Production wrapper: `src/gmgn.ts:804`, `trending`; CLI `market trending --chain sol --interval 5m --order-by volume --direction desc --limit 100`. `node_modules/gmgn-cli/dist/commands/market.js` gọi `getTrendingSwaps`; `dist/client/OpenApiClient.js:116` gọi `/v1/market/rank`. Không có endpoint “GET tokens” GMGN riêng trong path production này: `/api/tokens` là API của BOT.

| File / function | Source | Fetch hay read | Frequency / điều kiện | Consumer |
|---|---|---|---|---|
| discovery.ts / poll, pollSource | Gmgn.trending | logical provider read | timer5s + đầu tick; due60s; backpressure/cooldown | production discovery |
| gmgn.ts / trending, run | CLI market trending | cache/single-flight hoặc network | cache mặc định30s; key theo args | discovery |
| gmgn-coordinator.ts / read, runJob | process cache + CLI work | phân biệt cacheHit/actualCalls | concurrency3, request spacing2s hiện tại | shared GMGN consumers |
| store.ts / discover, tokens, token | SQLite tokens | persisted metadata read/write của BOT | discover khi poll thành công; tokens tối đa250 | engine/API |
| store.ts / enqueueTrending | token discovery timestamp | durable appearance enqueue | poll/refill; watermark + unique key | lifecycle |
| candidate-lifecycle.ts / refill, list | appearances/lifecycle DB | rebuild queue | trước/sau candidate | selector |
| engine.ts / tick, analyze | queue + latest token DB | choose mint, UUID, evaluate | tối đa5 candidate/cycle hiện tại | production entry |
| server.ts / GET /api/tokens | Store.tokens + stored records | DB read only | mỗi HTTP request | main UI/Kronos |
| public/app.js / refreshTables, stream.onmessage | /api/tokens | HTTP tới BOT | startup + status SSE khoảng5s + explicit refresh | các view dùng token metadata |
| kronos-market.ts / discover | /api/tokens; fallback GMGN rank | DB API trước, network fallback | Lab discovery mỗi120s khi records<50 | Kronos |
| kronos-lab.ts / tick, discover | Kronos records | choose due paper job | timer1s, một job đang active | Lab |
| public/kronos.js / refresh | /api/kronos | Lab state read | tab visible mỗi5s + tab click | Kronos UI |
| engine.ts / monitor | Position collection | independent market reads | timer5s, per-position quote-age guard15s | existing positions |
| verify.ts, live-controlled.ts, scripts/verify-trending-exits.ts | discover/trending wrappers | optional manual provider calls | khi chạy command tương ứng | verification/controlled tools |

Legacy `Gmgn.discover` dùng trenches còn tồn tại. Normal `DiscoveryCoordinator` chỉ chạy TRENDING; SNIPER được đánh dấu DISABLED/TRENDING_ONLY_NORMAL_DISCOVERY. Không tính test fixtures, browser mocks hoặc manual scripts là scheduler listing đang chạy. Statistics không có independent GMGN listing owner trong path đã trace.

## 3. Production control flow và token tiếp theo

`Engine.start` tạo discovery timer5s và schedule tick. `schedule` dùng `setTimeout`: tick kết thúc rồi mới chờ `SCAN_INTERVAL_MS` (schema default15s, min10s; không đọc .env để tuyên bố giá trị runtime). Tick hiện có `candidatesPerCycle=5`, `candidateQueueSize=10`.

```text
Engine.tick (guard scanning)
 → executor recovery, fire-and-forget Position monitor
 → await discovery.poll (có thể backpressure/not due/cache/network)
 → nếu GMGN cooling thì kết thúc tick
 → processed=0, inspected=new Set()
 → while processed<5:
      queue = candidates.refill(store.tokens())
      mint = queue.find(mint chưa có trong inspected)
      không có mint → break
      inspected.add; processed++
      setState(ANALYZING): consume appearance ngay tại đây
      await analyze(mint)
      catch → isolate failure; system-scope có thể break
      finally → finish(mint), clear stage
      refill(store.tokens())
 → finally clear scanning; tick sau được schedule
```

**Sau Candidate A:** quay về `finally`/`refill` rồi iteration kế của while trong `src/engine.ts:666`; không có lệnh bắt buộc gọi GMGN listing ở điểm đó. `src/engine.ts:719 analyze` lấy latest `Store.token(mint)`, begin UUID, chạy one-shot. Candidate payload không bị đóng băng theo appearance cũ: metadata mới nhất có thể được dùng để evaluate appearance đã nằm trong backlog.

Refill đọc unconsumed appearances `ORDER BY id`, admission tối đa10 lifecycle rows và bỏ mint đang có lifecycle. Nhưng queue trả về từ `list()` dùng `SELECT payload FROM candidate_lifecycle WHERE mode=?` **không ORDER BY**. Vì vậy admission theo id không đồng nghĩa execution FIFO. Query planner runtime dùng composite primary-key index `(mode,mint)`; thứ tự mint có thể quan sát được với planner này, nhưng SQL không cam kết nó. Không có explicit rank/createdAt/score sort ở selector này. `discoveryBoost`/legacy priority knobs không phải sorting authority của path này.

Timeline minh họa, không phải network trace đo thực:

```text
t0: due poll → GMGN → parse≤100 → persist appearances → admit≤10
t1: candidate A mất X giây; listing UI vẫn đọc DB mỗi status frame
t2: A xong → refill DB → candidate B ngay trong cùng tick
timer5s: thử poll; pending>=10 thì return; chưa due thì return
sau tối đa5 attempt: tick kết thúc → chờ SCAN_INTERVAL_MS
khi pending<10 và đã due: có thể fetch listing mới dù old batch chưa hết
```

Timer không replace một frozen current batch vì model đó không tồn tại. Nó merge latest metadata và append appearances mới; old unconsumed rows vẫn ở DB.

## 4. List/cache/state lifecycle

| State | Scope / lifetime | Công dụng thực tế |
|---|---|---|
| coordinator cache/flights | process, TTL theo method; cache bounded300 keys | raw result cache + request coalescing, không cached verdict |
| remembered feed | process snapshot | feed diagnostics/fetchedAt; không N-token cursor |
| tokens | persisted DB, keyed mint; API lấy latest250 theo at DESC | latest metadata, không danh sách batch cần exhaust |
| trending_appearances | persisted DB; unique(mode,mint,seen_at) | pending/consumed work, consumed prune giữ khoảng2000 |
| oneShotAppearanceWatermark:mode | persisted numeric last seen watermark | tránh enqueue lại cùng/older snapshot |
| candidate_lifecycle | persisted active rows(mode,mint); startup clears lifecycle | queue/admission; ANALYZING consumes appearance; finish deletes row |
| inspected | một Engine.tick | mint chỉ được chọn một lần trong tick đó |
| candidate_attempts | persisted UUID audit records | fresh assessment history/crash audit, không approval cache |
| tokens.processed | legacy schema column | không thấy selector hiện tại đọc/update để làm progress cursor |
| sequenceStartedAt | merged discovery metadata | continuous-observation grouping; không production appearance dedupe key |

`mergeDiscovery` giữ sequence nếu cùng basis và khoảng cách lastSeen <=180s; gap dài bắt đầu sequence mới, kể cả token thực ra vẫn nằm trong GMGN ranking. Parser tạo sequence timestamp mới mỗi response, sau đó Store merge có thể giữ sequence cũ. Đây không phải chứng minh token đã rời rồi quay lại listing.

Production `enqueueTrending` dùng **lastSeenAt**, không `sequenceStartedAt`. Một fresh poll mới cho mint liên tục hiện diện cũng tạo appearance mới nếu timestamp vượt watermark. Same snapshot bị dedupe bởi watermark + unique(mode,mint,seen_at). Multiple pending appearances cùng mint vẫn có thể tồn tại, dù chỉ một lifecycle active cùng mint. Sau finish, appearance khác của mint có thể được admit. Trong cùng tick, inspected ngăn chọn lại; tick sau có thể chọn ngay nếu queue order cho phép. Không có cooldown reject verdict.

## 5. Fresh attempt, outcomes và errors

Attempt mới tạo UUID/stages/summaries local mới. Info/security/history TTL0; JEV `decide(input,true)` bỏ decision cache. Structure/flow/Risk tính mới; không reuse old reject/approval. Concurrent same-key raw reads vẫn có thể coalesce. Persistent ownership/pending-execution guards được giữ. Final Analysis dùng history trong cùng attempt và rechecks freshness, không phải fetch history lần hai.

| Boundary / outcome thực tế | Next action |
|---|---|
| Cheap: INVALID_MINT, TRENDING_ORIGIN_REQUIRED, OPEN_POSITION_DUPLICATE, DURABLE_BUY_DUPLICATE, hoặc cheap.reason (age/liquidity...) | reject attempt; cleanup; next queue mint |
| Security: critical.reason, SECURITY_EVIDENCE_UNKNOWN | tương tự |
| Compatibility: mint/program/extension validation, TOKEN_DECIMALS_MISMATCH | reject/throw; isolate; cleanup |
| History: HISTORY_SOURCE_UNAVAILABLE, INSUFFICIENT_MARKET_HISTORY | reject; không Watch hoặc chờ60 phút |
| Flow: INSUFFICIENT_DATA | reject |
| Structure: result.reason, ví dụ INSUFFICIENT_STRUCTURE_EVIDENCE | reject |
| JEV: NEW_ENTRIES_DISABLED, JEV_DID_NOT_APPROVE | reject |
| Risk/controlled markup: result.reason; CONTROLLED_MARKUP_STRUCTURE | reject ở deterministic Risk |
| Final: MATERIAL_MARKET_CHANGE_AFTER_JEV, FINAL_FLOW_INSUFFICIENT_DATA, FINAL_STRUCTURE_CHANGED, compatibility/Risk reasons | reject |
| Ownership/execution guards: TOKEN_ALREADY_OWNED, PROTECTIVE_WORK_PRIORITY, CONTROLLED_PRINCIPAL_CAP, PRE_SIGN_EVIDENCE_STALE, EXACT_SIZE_CHANGED; executor quote/simulation/route failures | attempt terminal; cleanup; authority checks không bị bypass |
| BUY confirmed + reconciled OPEN | BOUGHT; next queue mint, Position monitor quản lý vị thế |
| BUY_NOT_CONFIRMED_RECONCILE_REQUIRED, POSITION_NOT_RECONCILED; signed/pending exception | không coi là safe retry; durable execution/reconciliation guards giữ authority |
| GMGN retryable provider failure, chưa signed | isolate CANDIDATE_OUT/PROVIDER_COOLDOWN; end attempt; có thể tiếp tục loop nhưng shared cooldown ảnh hưởng reads |
| system/provider escalation/transaction-scope failure | isolate có thể halt entries và break current tick; không tự restart process |

Reason từ cheap/security/compatibility/Risk/executor là dynamic delegated reasons, không phải chỉ một enum cố định trong oneShotEntry. Bảng nêu từng terminal boundary cùng các literal callsite, không giả đây là toàn bộ error strings của dependency.

Không có candidate retry-at-place hoặc “error A → refresh listing ngay → retry A” trong loop. CLI/coordinator có timeout20s, cache, single-flight, cooldown/queue policy; listing failure đánh DEGRADED và hoãn poll ít nhất max(interval,60s). Không thể suy ra exact server request count từ số attempt hoặc logical read. Một future appearance/backlog appearance có thể đưa A vào fresh attempt khác; đó là đường lặp có thật. JEV failure không tạo vòng retry candidate tại chỗ.

Same-mint non-CLOSED/FAILED position hoặc durable BUY chưa CONFIRMED (FAILED có signature vẫn giữ guard theo biểu thức `entryBlocked`) bị chặn **trong Cheap, trước expensive info/security/history**. Tuy nhiên queue vẫn có thể tạo UUID và consume appearance rồi mới reject; không prefilter ở queue. OPEN/pending/submitted/UNKNOWN vì thế vẫn có thể xuất hiện trong log attempt ngắn, không có nghĩa thực hiện BUY lần nữa.

## 6. Network, API và Position workload

`GET /api/tokens` ở `src/server.ts:141` → `Store.tokens` và stored market/security/etc → JSON. **Không gọi GMGN, không trigger refresh.** Đây là DB state do background discovery cập nhật. Main UI `refreshTables` gọi tokens/positions/history khi startup và mỗi status SSE message; server phát status khoảng5s. Flow SSE1s và UI clock1s không phải listing fetch. Multiple browser tabs tăng DB API reads, không tự tăng listing provider reads.

Manual `POST /api/scan` gọi tick nếu không scanning; tick có thể poll nếu due. Đây khác với GET /api/tokens. Kronos UI poll `/api/kronos` mỗi5s khi visible và khi mở tab; không trực tiếp fetch token list.

Production provider poll nominal60s, cacheTTL30s: khi due bình thường sẽ có network mới; backpressure/cooldown/single-flight có thể ngăn hoặc join. Coordinator separates logical reads/cache hits/actual work, bounded queues và priority lanes; actualCalls không phải packet capture hoặc bằng chứng exact upstream HTTP retry count.

Position monitor chạy độc lập với sequential candidate await: timer5s, bounded collection concurrency4 hiện tại, recent-quote guard15s, async JEV exit. Candidate A chậm không trực tiếp giữ monitor chờ cùng vòng await. Tuy nhiên chúng dùng chung Node event loop/DB/production GMGN coordinator, quota và cooldown; không phải isolation tuyệt đối.

## 7. Kronos source, selector và trạng thái hiện tại

`src/kronos-server.ts` timer1s gọi Lab tick khi enabled và không active. Khi total records<50 và due, discovery mỗi120s:

1. `KronosMarket.discover` đọc production `/api/tokens`; giữ TRENDING fresh lastSeen<=180s, lấy tối đa50.
2. Có fresh rows thì dùng chúng, không gọi GMGN listing.
3. Không có fresh rows thì fallback unsigned HTTP `/v1/market/rank` Sol/5m/volume/desc/limit50; riêng read spacing3s/timeout20s/rate-limit cooldown120s. Không đi qua production coordinator; vẫn có thể tranh cùng provider key/quota.

Lab add dedupe `mint + sequenceStartedAt` (fallback discoveredAt), active same mint cũng block. Terminal record cùng appearance không tạo trial mới. Production-sourced merged sequence có thể giữ nguyên qua nhiều polls; fallback parse raw tạo sequence mới mỗi fetch. Hai nguồn vì vậy không bảo đảm cùng appearance semantics. Lab selector lấy due active records, ưu tiên OPEN theo entry time rồi nextAt; một job active tại một thời điểm, normally next evaluation60s, pending-price5s. WAIT/OPEN đánh giá lại cùng trial là paper monitoring, không phải production discovery retry.

**Runtime đọc được:** enabled=true, paperOnly=true; dataset **50/50**, **48 REJECTED + 2 CLOSED**, open0/queueDepth0/activefalse. Khi đủ50, code không gọi discovery thêm dù toàn bộ record đã terminal. Enabled không đồng nghĩa luôn có work. Không reset dataset trong audit.

Thử browser thật: tab Kronos render “PAPER collection đang chạy”, `/api/kronos` và Lab `/state` đều200, không JS error; không tái hiện “Chưa kết nối Lab” ở thời điểm kiểm tra. HTML có initial disconnected placeholder trước khi state render. Browser cache/asset cũ là khả năng, chưa chứng minh root cause của screenshot trước. Người dùng có thể Ctrl+F5. Đã hỏi riêng việc archive/reset dataset để chạy đợt paper mới; chưa thực hiện khi chưa có đồng ý.

## 8. Runtime corroboration và 200-token experiment

Capture `2026-11-02T02:14:51.147Z`:81 unconsumed appearances,2001 consumed rows, lifecycle1 ANALYZING +9 QUEUED; feed BACKPRESSURE/CANDIDATE_QUEUE_DRAINING, process current feed call counters0. Điều này phù hợp scanner drain persisted backlog sau restart trước đó; không phải cứ mỗi token lại network listing. Audit không gây restart đó.

Latest100 attempts có96 distinct mints. Bốn aliases M4/M10/M14/M17 mỗi mint có hai UUID; lần sau Security/History fetchedAt mới và token seen/sequence mới. Đây là evidence repeated fresh evaluation, không chứng minh same continuous sequence repeat trong sample; capability đó được chứng minh riêng bởi enqueue key dùng lastSeenAt. Mints được alias trong artifact; không cần wallet secrets.

Pure parser reproduction đã chạy:200 synthetic valid Solana addresses, `parseTrending({rank:rows})`, không Store/Engine/provider. Kết quả input200/output100/firstT1/lastT100/includesT200=false. Đây là fixture contract, không phải provider coverage benchmark.

Actual sequence suy ra:

```text
response T1..T200 → parser T1..T100 → durable pending rows
refill admit tối đa10 theo id → list() không sort → find chưa inspected
tick1: tối đa5 mint theo lifecycle result order
tick2: refill, tối đa5 mint; không reset consumed appearance
... pending<10 và poll due → có thể append wave mới trước khi wave cũ hết
T101..T200: không có appearance từ response đầu tiên
```

Không thể ghi một chuỗi cụ thể T1→T2→... như deterministic guarantee vì SQL selector thiếu order, timing/provider updates/guards ảnh hưởng interleaving. Nếu đặt tên T theo thứ tự index mint mà planner hiện tại trả, có thể minh họa tick1 T1..T5, tick2 T6..T10; đó là giả định minh họa, không phải thứ tự provider được bảo đảm. Nếu stable ranking luôn trả cùng first100, T101..T200 có thể không bao giờ được admit; **không có số network fetch hữu hạn bảo đảm xử lý đủ200**. Nếu ranking xoay, số lần phụ thuộc dữ liệu/time/backpressure/cache/errors, không thể invent con số. Kể cả giả sử200 đã vào queue bằng đường khác, vẫn không có empty-batch barrier trước poll kế tiếp.

## 9. Root causes, gap và plan only

- **RC1:** UI đọc DB khoảng5s và Engine refill DB trước/sau từng candidate dễ bị nhìn thành provider fetch. Không có direct network listing call sau mỗi candidate.
- **RC2:** production appearance key là fresh snapshot lastSeenAt, không continuous sequence. Cùng mint vẫn được evaluate lại qua snapshot khác; inspected chỉ scope một tick.
- **RC3:** discovery backpressure so pending>=10; không kiểm toàn bộ response batch đã terminal. Refills/new metadata/appearances có thể xen nhau.
- **RC4:** lifecycle list không ORDER BY; admission FIFO không đảm bảo selection FIFO/rank. Có nguy cơ interleaving ưu tiên mint theo planner; chưa chứng minh starvation vô hạn trong runtime.
- **RC5:** parser hard100 loại nửa response200. API250 và GMGN request limit100 là hai giới hạn khác nhau.
- **RC6:** Kronos có fallback listing owner riêng, discovery semantics riêng và lifetime cap50. Đây là lý do Lab đã bật nhưng không chạy thêm trial trong sample hiện tại.

| Concern | Current | Desired | Gap |
|---|---|---|---|
| List fetch | due timer + pending threshold | once per exhausted batch | thiếu completion barrier |
| Snapshot | raw cache + per-mint latest metadata + appearance payload | immutable N-token batch | không có batch identity/completeness |
| Cursor | consumed rows + tick inspected | 0..N-1 | không ordered batch progress |
| Same-batch duplicate | unique mint/seen; new seen admits again | once per batch | cần định nghĩa batch/appearance rõ |
| Refresh mid-batch | có thể khi pending<10 | no | pending threshold không đủ |
| Position monitoring | independent async, shared budget | independent | giữ monitor; reserve budget nếu cần |
| Kronos | production API-first + own fallback | shared discovery where appropriate | hai owner/semantics; cap policy riêng |
| 200 rows | parser≤100 | account allN | cần explicit supported bounds/pagination contract |

**P0 plan:** chốt semantics “once per batch” và crash behavior; reuse durable appearance queue, thêm batch identity/completion accounting và explicit order cho selection, gate listing refresh theo batch completion. Không cần viết lại toàn Engine; phải xử lý guard skips/errors/remaining jobs rõ ràng, giữ fresh UUID và ownership authority. Đây là proposed implementation, chưa sửa.

**P1 plan:** thống nhất supported N với provider/schema/parser; nếu provider chỉ hỗ trợ100 phải hiển thị giới hạn hoặc có pagination contract chính thức, không chỉ bỏ slice100 rồi gọi đó là200 support. Tách snapshot metadata khỏi latest metadata nếu cần batch reproducibility; tests batch-exhaustion/order/restart/dedup.

**P2 plan:** cân nhắc shared immutable discovery feed cho Kronos với bounded age/fallback policy và consumer progress riêng; diagnostics phân biệt UI reads/cache hits/provider calls/batch progress. Dataset reset/rollover Kronos cần explicit lifecycle policy; không tự xóa kết quả. Không thay trading gates để giải quyết scanner UX.

## 10. File/function map

| Layer | File | Function/Class | Responsibility |
|---|---|---|---|
| GMGN provider | src/gmgn.ts; installed CLI client | trending/run/parseTrending; getTrendingSwaps | transport/cache wrapper/normalize≤100 |
| Token cache | src/gmgn-coordinator.ts; src/store.ts | read; discover/token/tokens | raw process cache; latest persisted metadata |
| Discovery scheduler | src/discovery.ts; src/engine.ts | DiscoveryCoordinator.poll/pollSource; start/schedule | due/backpressure/poll timers |
| Candidate selector | src/candidate-lifecycle.ts; src/engine.ts | refill/list; tick | admission; first uninspected queued mint |
| Candidate pipeline | src/one-shot-entry.ts; src/candidate-attempt.ts | oneShotEntry; begin/finish | fresh stages/UUID/terminal audit |
| Seen/appearance | src/store.ts; src/discovery.ts | enqueueTrending; mergeDiscovery | seen watermark; sequence metadata |
| Position monitor | src/engine.ts; src/position-collector.ts | monitor; collectors | ongoing position state independently |
| Kronos source | src/kronos-market.ts | KronosMarket.discover | production tokens API + fallback rank |
| Kronos selection | src/kronos-lab.ts; src/kronos-store.ts | tick/discover; add | paper cap/dedup/due jobs |
| API | src/server.ts | GET /api/tokens | stored DB state only |
| Frontend | public/app.js; public/kronos.js | refreshTables/SSE; refresh | API reads, no GMGN listing owner |

## 11. Required direct answers

1. **Ai fetch?** Production DiscoveryCoordinator → Gmgn.trending → CLI; Kronos fallback có owner HTTP riêng.
2. **Endpoint?** GET `https://openapi.gmgn.ai/v1/market/rank` cho normal Trending.
3. **/api/tokens tự fetch?** NO. Đọc SQLite/stored state.
4. **UI poll?** Startup + status SSE khoảng5s + explicit refresh; không phải mỗi frame1s.
5. **Scanner source?** Durable appearances tạo từ Trending, refill cùng Store.tokens latest metadata.
6. **Snapshot?** Có raw cache và persisted appearance payload; không immutable batch snapshot có completion barrier.
7. **Cursor?** Không N-token cursor. Có consumed row state/watermark.
8. **Queue?** Có appearances DB và lifecycle admission queue10 hiện tại.
9. **Next ở đâu?** Engine.tick while → refill → queue.find(mint chưa inspected), sau finally candidate trước.
10. **Fetch/read sau mỗi token?** Có DB list/refill; không unconditional listing fetch.
11. **Network hay cache?** Điểm next-token là DB read; background due poll có thể provider cache/join/network.
12. **Luôn đầu list?** Không reset consumed list; find đầu queue hiện tại, không frozen provider cursor.
13. **Order?** Appearance admission ORDER BY id; execution lifecycle SELECT không ORDER BY. Không explicit rank/score sort.
14. **Vì sao repeat?** New lastSeen snapshots tạo appearances; no once-per-continuous-sequence dedupe; tick-scoped inspected.
15. **Same mint/appearance dedupe?** Có(mode,mint,seen_at)+watermark; active lifecycle một mint. Different seen vẫn admit dù sequence giống.
16. **sequenceStartedAt?** Merge giữ nếu cùng basis/gap<=180s; gap dài đổi. Production không dùng nó làm dedupe key; Kronos có dùng.
17. **Fresh appearance?** Production nghĩa fresh seenAt vượt watermark, không nhất thiết token rời rồi quay lại Trending.
18. **Rejected chọn ngay lại?** Appearance khác có thể admit sau finish; inspected chặn trong cùng tick, tick sau có thể chọn lại. Không retry verdict cũ.
19. **Error tạo loop?** Không immediate retry-at-place; backlog/new appearances có thể dẫn fresh attempt mới; cooldown/system failures có thể trì hoãn/break.
20. **Already OPEN?** Có thể vào Cheap/UUID rồi reject OPEN_POSITION_DUPLICATE trước expensive reads.
21. **Pending/UNKNOWN?** Durable BUY guard chặn trước expensive checks; execution reconciliation authority giữ nguyên.
22. **Monitor independent?** Có async loop riêng, nhưng shared event loop/DB/provider budgets.
23. **Kronos riêng loop?** Có timer1s; discovery120s khi total<50; due trial evaluation riêng.
24. **Kronos tự GMGN?** Có conditional fallback khi không có fresh production tokens; không mỗi UI refresh.
25. **Bao nhiêu components?** Normal listing network owners:2 (production + Lab fallback). Main token-list consuming paths:production selector, main UI, Kronos source. Kronos UI chỉ đọc Lab state; optional verification/controlled command là callers bổ sung khi được chạy, không background owner thứ ba.
26. **Đảm bảo cả200?** NO.
27. **Chặn bởi gì?** Parser slice100, không batch/cursor/barrier, selection thiếu explicit order; refresh có thể xen old work.
28. **Timer trước hết list?** Có thể append new appearances/update metadata trước hết old pending, khi due và pending<queueSize. Không wipe old queue.
29. **Verdict?** **B — PARTIALLY CONFIRMED.** Repeat có thật; không network fetch mỗi token; sample96/100 unique chưa chứng minh chỉ vài token.
30. **Minimal fix?** Reuse queue với explicit batch/completion/order; align N/provider bounds; sau đó shared discovery cho Lab nếu phù hợp. PLAN ONLY.

## 12. Safety và phạm vi xác minh

Chỉ thêm docs/evidence. Hash protected files và .env metadata được đối chiếu cuối audit; không dump/read secrets. Không chạy full tests/build hoặc thêm instrumentation trong phase audit. Browser đọc UI/GET state; SQLite query-only. Source parser reproduction synthetic không gọi network hoặc execution.

```text
Source modified: NO
Tests modified: NO
Config/.env modified: NO
Database modified by audit: NO
Packages installed: NO
Bot restarted/killed by audit: NO
Real BUY by audit: NO
Real SELL by audit: NO
Transaction signed by audit: NO
Transaction submitted by audit: NO
```

LIVE tự chạy có thể tiếp tục ghi DB/giao dịch theo cấu hình của nó; audit không tuyên bố DB bất biến hoặc không có autonomous trade ngoài audit. Trạng thái API là observation tại thời điểm capture, không SLA. Restart trước task audit là phase riêng đã được người dùng yêu cầu trước đó. Request active Kronos được kiểm tra riêng; Lab vốn enabled và chưa archive/reset khi chưa có đồng ý.
