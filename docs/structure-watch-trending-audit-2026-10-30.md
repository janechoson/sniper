# BOT B — Structure Watch / Trending audit

**Ngày: 30/10/2026 — Asia/Bangkok. AUDIT ONLY.** Primary truth là source hiện tại; report cũ chỉ là bối cảnh. Compatibility: **PARTIALLY COMPATIBLE**. Observer chủ yếu đo **local entry structure sau admission**, không có điều kiện token phải mới launch. Tuy nhiên, nó đòi tái quan sát selling/absorption trong cửa sổ mới và các tín hiệu Support/Recovery yếu hơn ý nghĩa “buyers thực sự hấp thụ selling/giành lại momentum”.

Ba kết quả chính đã có counterexample trên hàm thật:

1. Không có history injection trước T0: token được phát hiện ở cuối support có thể bị giữ ở `INITIAL_EXPANSION` trong recovery, vì chưa thấy selling mới.
2. `SUPPORT_CONFIRMED` có thể xuất hiện khi giá **vẫn giảm đều, buy USD = 0**, liquidity không giảm.
3. `RECOVERY_CONFIRMED` có thể xuất hiện khi **buy rolling USD giảm qua mọi snapshot và net rolling USD vẫn âm**: chỉ cần giá tăng và pressure/net cải thiện tương đối đủ số lần.

Đây là giới hạn/false-positive của **nhãn Structure**, không phải bằng chứng đã BUY sai hoặc mất tiền. Jev/Risk/ownership/capital/execution validators vẫn là các gate khác. F01/F02 được giữ ngoài phạm vi sửa.

## 1. Phạm vi, bằng chứng và trạng thái vận hành

Không sửa source, tests, scripts vận hành, public, config, `.env` hoặc `dist/`; không thay threshold/flag; không migration/reset; không POST, start/stop bot, sign/submit hoặc BUY/SELL thật từ audit. Chỉ tạo report và harness/log/JSON audit trong `docs/`/`data/`.

Bot đã LIVE trước audit và **tiếp tục chạy độc lập**, PID **11500**, entries enabled, policy `TRENDING_FINAL_STRUCTURE_V1`. Audit không cấp phép hoặc kích hoạt LIVE. Build đang chạy: `0aab3d21387e3c98ed09c618266e6269a1714906e23e1f40d6d11d860c07dea6`; Node 22.22.0. [GET checkpoint đầu](../data/structure-trending-audit-runtime-before.json).

Active DB được đọc bằng native `DatabaseSync(...,{readOnly:true})`, `PRAGMA query_only=ON` và read transaction; **không** tạo app Store/Engine trên DB production. Fixture dùng Store RAM hoặc temp DB của existing tests. Chặn network thật trong process kiểm chứng. Một số LIVE-named fixtures tăng fake signature/submit counters và apply synthetic receipts; không gọi wallet signer hoặc blockchain.

Logical mutations do audit lên active DB/wallet = **0**; real signatures/submissions do audit = **0**. Không tuyên bố DB LIVE byte-identical hoặc không có giao dịch độc lập trong thời gian audit. Không in secret hoặc CSRF token.

## 2. Current architecture từ reachable call sites

```text
DiscoveryCoordinator.poll(): chỉ TRENDING
→ parseTrending → Store.discover / mergeDiscovery → CandidateLifecycle
→ Engine.analyzeCandidate: info → cheapGuard
→ Security TTL 0 → LIVE inspectMint / decimals
→ CapitalFlow.observeCandidate → advisory intelligence
→ Memory.retrieve / jevContext → fresh Jev
→ fresh info + Security + authoritative holders → price drift
→ Risk PRE_WATCH + fresh ownership/capital/context recheck
→ SniperStructure.admit → entry_structure_watch ACTIVE, T0 admission
→ shared observation lane → selling / absorption-support / recovery
→ real PASSED, timely confirmedAt (hoặc TEMP path riêng nếu flag ON)
→ CandidateLifecycle.promoteStructure → fresh full analysis/Jev/Risk EXECUTION
→ approve + claim → fresh BUY quote → SELL probes 20/50/100 → exit binding
→ transaction validation / simulation / final validation / pre-sign authority
→ sign / durable signature / submit / receipt → Position
```

**Sniper không tham gia normal discovery.** `DiscoveryCoordinator.poll()` chỉ schedule `TRENDING` ([discovery.ts:173](../src/discovery.ts#L173)); `pollSource()` vẫn chứa helper branch `discover()` nhưng normal poll không truyền SNIPER. Candidate refill và analysis còn yêu cầu source history có TRENDING ([candidate-lifecycle.ts:371](../src/candidate-lifecycle.ts#L371), [engine.ts:843](../src/engine.ts#L843)). Parser/class/table/helper tên Sniper vẫn tồn tại; sự tồn tại tên không tạo launch-age requirement.

**Thứ tự quote/probes:** BUY quote **trước** exit-feasibility probes vì cần expected token output và binding quote. Không mô tả Exit Feasibility chạy trước mọi Jupiter request. [executor.ts:196](../src/executor.ts#L196), [executor.ts:228](../src/executor.ts#L228).

## 3. Trace / read-write map

| File / function | Input → output | State đọc / ghi | Caller |
| --- | --- | --- | --- |
| discovery.ts `poll`, `pollSource`; gmgn.ts `trending`, `parseTrending` | rank snapshot → Candidate | feed health/cadence; tokens/discovery source metadata | Shared discovery timer / scanner |
| store.ts `discover`; discovery.ts `mergeDiscovery` | old + incoming Candidate → merged identity | tokens, discovery_events; không ghi Structure | Discovery / rediscovery |
| candidate-lifecycle.ts `refill`, `structureWait` | Candidates / Watch expiry → queue state | candidate_lifecycle, ownership, tombstone; không tính Support | Engine tick / analysis |
| engine.ts `analyzeCandidate` trước admission | Candidate + fresh provider facts → PRE_WATCH result | market/security/intelligence/Memory/Jev/risk records; read ownership/capital | Sequential candidate analysis |
| sniper-structure.ts `admit` (302) | Candidate, revision, snapshotHash, now → ACTIVE Watch | read existing row/tombstone/cap; insert entry_structure_watch + pre_watch_approvals | PRE_WATCH allowed + rechecked context |
| gmgn.ts `normalizeMarket` (192); capital-flow.ts `normalizeFlowObservation` (117) | raw info/feed → timestamped FlowObservation | Pure normalization; không history fetch | Analysis / Watch / Flow |
| engine.ts `observeStructureWatches` (686) | due admitted ACTIVE Watches → observations / promotion | watchAttempts, feed/current info, ownership, Watch, candidate Flow | Shared 5s timer + tick; max 4 logical workers |
| sniper-structure.ts `evolveStructure` (95) | old Watch + one observation + Settings + now → cloned Watch | Pure state transition; xem công thức dưới | `SniperStructure.observe` |
| sniper-structure.ts `observe` (445) | Candidate + observation → persisted Watch | reject pre-T0 snapshot, upsert đúng bảng, transition records, terminal retention | Watch lane / fresh post-PASS analysis / error mapping |
| sniper-structure.ts `expire`, `reconcileTtl`, `invalidate`, `dismiss` | time / reason / user action → terminal or reconciled row | fixed T0/T1, status, tombstone/revision; không wallet mutation | Shared timer / settings-startup / Engine |
| candidate-lifecycle.ts `promoteStructure` (167) | mint → QUEUED + fresh qualification window | candidate_lifecycle; không đổi Watch thành PASS | Real PASS hoặc explicit TEMP promotion |
| risk.ts `evaluate` (68) | Snapshot + Settings + context + phase → allow/deny | Pure risk result; TEMP logging khi dùng; không tự tính lại chuỗi | PRE_WATCH / fresh EXECUTION / final checks |
| recovery-guard.ts | Watch + flag + revision-bound metadata → bool | Không mutate Watch | Promotion / Risk / final/pre-sign |
| engine.ts final callbacks (1267,1314); Store `assertEntryAuthority` | current Watch/revision + intent → continue/abort | Read current authority/tombstone, structure freshness; record final Risk | Executor / immediate pre-sign |
| trading-memory.ts `entry` / sample build (127) | Snapshot → immutable learning sample | Clone cả Snapshot, gồm actual Structure và bypass tag | Execution lifecycle; không làm Structure PASS |
| engine.ts status (2420), public/app.js row renderer | actual row → evidence UI | Projection; không thêm observations/HTTP GMGN | GET/SSE/browser |

Schema: [store.ts:54](../src/store.ts#L54). `get/list` ưu tiên `entry_structure_watch` nếu cùng mint có row policy mới; legacy `sniper_structure_watch` không được hydrate thành eligibility mới ([sniper-structure.ts:423](../src/sniper-structure.ts#L423)).

## 4. Token age và những assumption thật sự tồn tại

**Structure Watch currently does not know token age.** `evolveStructure` nhận mint, observation, settings, now; `FlowObservation` không có createdAt/launchAt/pairCreatedAt/poolCreatedAt/firstTradeAt. Wrapper nhận Candidate nhưng không dùng `createdAt` để quyết định phase/PASS.

Hệ thống **bên ngoài Structure** biết tuổi khi GMGN có `creation_timestamp`: `parseTrending` đổi seconds → ms ([gmgn.ts:143](../src/gmgn.ts#L143)); analysis có fallback info.creation_timestamp nếu Candidate chưa có createdAt ([engine.ts:899](../src/engine.ts#L899)). Đây là provider-reported time, không có on-chain launch-time verification trong đường Structure. Missing giữ undefined/UNKNOWN; không suy discovery time là birth time.

`cheapGuard` dùng known createdAt, Trending max age mặc định/runtime **2.592.000s = 30 ngày**, future tolerance 5s; Sniper legacy maxAgeSeconds riêng ([risk.ts:41](../src/risk.ts#L41)). Candidate ranking có age term `createdAt ?? discoveredAt`, chỉ ảnh hưởng queue score ([candidate-lifecycle.ts:400](../src/candidate-lifecycle.ts#L400)); Jev nhận tokenAgeSeconds. Không phải age bucket hoặc Structure formula.

| Assumption | Sniper-specific? | Used today? | Trending risk | Severity |
| --- | --- | --- | --- | --- |
| Token newly launched / discovery≈birth | Có thể là giả định chiến lược Sniper, nhưng **không có predicate này** trong observer | NO | Không loại token 6h/2d chỉ vì tuổi trong Structure | Không finding |
| INITIAL_EXPANSION trước Selling | Tên gợi lifecycle | **NO mandatory dependency**; chỉ label khi chưa sellingSeen và v>0 | Không cần initial pump mới | INFO naming |
| PEAK_FORMING / first peak phải có | Tên gợi lifecycle | NO prerequisite; v=0 chỉ tạo label | Token đang giảm có thể vào selling trực tiếp | Không finding |
| Peak after discovery | Thường gợi Sniper | NO; peak từ accepted observations của Watch | Không biết historical/global ATH | INFO |
| First selling | Cần full sequence trong cửa sổ mới | **YES local selling sau T0**, không đòi first sell của cả token | Late discovery bỏ lỡ selling/support trước T0 | MEDIUM — SW01 |
| ATH / fixed ATH distance | Có thể là launch/pump heuristic | NO authority input | ATH1.00 không cấm local recovery0.18→0.24 | Không finding |
| T0 price là launch/discovery reference | Gợi lifecycle | NO fixed-price anchor; first accepted price chỉ là baseline ban đầu | Baseline chưa có trước khi nhận observation đầu tiên | INFO |
| Post-T0-only ordered evidence | Không chỉ dành cho Sniper, nhưng giữ sequence từ đầu cửa sổ | **YES** | Có thể đòi một vòng selling mới dù thị trường đang recovery | MEDIUM — SW01 |
| Fixed drawdown % | Có thể là launch heuristic | NO entry predicate | drawdown chỉ descriptive | Không finding |
| Fixed recovery % | Có thể là launch heuristic | NO entry predicate | recoveryRatio chỉ descriptive | Không finding |
| Fixed peak-distance % | Có thể là launch heuristic | NO | Không ATH proximity gate | Không finding |

Không có bằng chứng source để kết luận các assumption này được tác giả viết ra *vì* mục tiêu Sniper nào. “Nguồn gốc Sniper” được nhận diện qua tên class/table và sequence kế thừa; nguyên nhân thiết kế lịch sử ngoài source là UNKNOWN.

## 5. T0, baseline, pre/post history và cửa sổ

**T0 = `now` tại `SniperStructure.admit` sau eligibility và fresh context recheck.** Không phải createdAt, first/latest discovery hoặc deploy time. `admit` gọi `evolveStructure(undefined,...,undefined,...,now)`, tạo observations rỗng; eligibility.approvedAt=T0. T1=min(expiry đã có, T0+configuredTTL), tối đa600.000ms. Existing eligible row được trả nguyên, không admit lại/reset.

T0 còn dùng cho expiry/clamp, reject snapshot `o.at<T0`, timely confirmedAt, due scheduling trước first observation, bound bypass metadata và UI timer. **Không có biến “price at T0” được lấy tại admission.** First *accepted* observation sau admission mới đặt peak và previous-price baseline; có thể muộn hơn T0.

| Câu hỏi | Kết quả |
| --- | --- |
| Pre-T0 market observations có tồn tại ở hệ thống? | YES: candidate Flow / market records có thể đã có trước admission |
| Có nạp ordered pre-T0 observations vào Watch mới? | **NO**; admit khởi tạo rỗng, wrapper chặn timestamp trước T0 |
| Rolling values có thể chứa trade trước T0? | **YES**, 1m–24h totals vẫn bao trùm thời gian trước T0. Khác với nạp history có thứ tự |
| History tính Selling/Support | Chỉ accepted Watch observations trong cùng sequence/window, từ sau admission |
| Minimum observation interval | Runtime15s; schema10–60s; không phải SLA |
| Maximum Watch window | 10m từ admission; confirmation trước T1, không minimum wait |
| Maximum retained observations | 120; cumulative observationsAccepted không reset khi gap |
| Missing/incomplete/future/older than maxGap | Không append; UNKNOWN nếu chưa có lastObservedAt, ngược lại STALE; giữ phase/counters |
| Same/older fetchedAt hoặc interval quá ngắn | Không append, không tăng count; không làm cached data thành observation mới |
| Gap>120s hoặc đổi selected window | Xóa sequence array, reset selling/absorption/recovery counters + sellingSeen/supportConfirmed; ACTIVE/WAITING_FOR_SELLING; không reset T0/T1 |

**Peak/localLow không bị clear trong nhánh gap/window change** ([sniper-structure.ts:152](../src/sniper-structure.ts#L152)). Peak là max các accepted prices của Watch qua cả các sequence bị reset, không phải max toàn lifecycle token hoặc chỉ max array120 hiện tại. LocalLow có vòng đời riêng dưới đây. Fixture xác nhận giữ peak100/localLow93 sau gap và first new sample40; không biến gap thành permanent rejection.

Normal lane due từ shared5s timer, max4 logical workers, GMGN transport vẫn1/client. Complete feed age≤10s được reuse; complete feed age>10s và≤`sniperPollMs*2` (runtime60s) được chờ, dù normal feed nay là Trending. Thiếu directional hoặc older thì token-info TTL10s. Vì Trending poll60s, accepted cadence không mặc định15s nếu chờ batch. Coupling tên setting Sniper ở đây là cadence, không phải giả định token mới. [engine.ts:693](../src/engine.ts#L693).

### Late discovery và candidate eligible muộn

Case selling→absorption→support xảy ra trước admission, chỉ recovery xảy ra sau: **B — phải thấy selling mới trong chuỗi Watch**. Không có đường lookup pre-T0 Flow để đặt sellingSeen/supportConfirmed. Nếu sau T0 chỉ có price/pressure/net tăng, sellingEvidence không đạt; phase có thể tiếp tục `INITIAL_EXPANSION`. Fixture `discoveryAfterPriorSupport` cho 8 tăng giá liên tiếp: ACTIVE, sellingSeen=false.

Token đã Trending từ trước nhưng failed eligibility rồi mới được admit lấy **baseline từ first accepted observation của Watch admission mới**, không dùng first/latest rank price hoặc candidate Flow history để seed peak/low/stages.

## 6. CURRENT STRUCTURE FORMULAS

Nguồn chính: [sniper-structure.ts:84](../src/sniper-structure.ts#L84), [sniper-structure.ts:178](../src/sniper-structure.ts#L178). Bên dưới là behavior **bypass OFF**.

Ký hiệu cho accepted current observation `o`, previous `b`, previous-previous `a`:

```text
P = o.priceUsd; B = o.buyVolumeUsd; S = o.sellVolumeUsd; L = o.liquidityUsd
p = B / (B + S)                 // chỉ defined khi B,S known và B+S>0
n = B - S
bp = b.B / (b.B + b.S); bn = b.B - b.S
dt = (o.at - b.at) / 1000
v = (P - b.P) / dt              // USD price / second, không percent
previousV = (b.P - a.P) / ((b.at - a.at)/1000)  // null nếu thiếu a
priceAcceleration = (v - previousV)/dt        // null nếu thiếu previousV
liquidityAlive = L > 0 && L >= b.L
C = settings.structureConfirmations          // runtime/default 2
```

Các predicate được xét sau timestamp/completeness/cadence/gap checks. Không dùng Flow regime/confidence để thay các biến này.

### SELLING

**Inputs:** current/previous price, buy/sell USD, timestamps; không dùng buy/sell counts, volume tổng, peak, drawdown hoặc ATH.

**Baseline:** previous accepted same-window observation. **Window:** selected rolling1m/5m/1h/6h/24h, không mặc định luôn1m.

```text
sell = S > 0 && (S >= b.S || p < bp || n < bn)
sellingEvidence = sell && (v < 0 || p < bp || n < bn)
sellingCount = sellingEvidence ? old.sellingCount + 1 : 0
if sellingCount >= C: sellingSeen = true
```

**Thresholds:** strict zero / relative comparisons, C configured. S không cần lớn hơn B; giá cũng **không bắt buộc giảm** nếu p hoặc n xấu đi. Không minimum sell USD/count.

**Required observations:** C consecutive qualifying intervals; với C=2 cần ít nhất3 accepted samples. Khi sellingSeen đã true, nó sticky qua các tick không selling; reset vì gap/window change, không vì một green tick. `INITIAL_EXPANSION` không phải prerequisite: `[100,96,93]` đã sellingSeen=true trong fixture, không từng đi qua expansion/peak.

### ABSORPTION

**Inputs:** S, current/previous liquidity, v, previousV; gate sellingSeen phải true.

**Baseline:** hai price intervals liên tiếp. **Window:** cùng selected rolling window của sequence.

```text
absorption = S > 0
          && liquidityAlive
          && previousV !== null
          && v >= previousV
          && v <= 0
```

**Thresholds:** zero, non-decreasing liquidity, non-accelerating downside (`>=`, không phải `>`). **Không** có price impact per sell USD, sell-size-adjusted response, minimum continuing sell amount, buy growth, p improvement, positive n hoặc independent trade count.

**Required observations:** phải có a,b,o để tính velocity comparison, và sellingSeen. Khi chưa supportConfirmed, absorptionCount tăng chỉ trên absorption liên tiếp, false→0. Không có standalone phase tên ABSORPTION; nó thể hiện qua SUPPORT_FORMING/counter.

Đây có một proxy “sell USD còn >0 + downside không xấu hơn + liquidity không giảm”, **không chỉ price đứng yên**, nhưng cũng **không chứng minh selling pressure hiện tại đã được buyers hấp thụ**. Dấu `>=` chấp nhận giảm thẳng đều.

### SUPPORT / BUYER DEFENSE

**Independent Support signal: NOT IMPLEMENTED AS DISTINCT SIGNAL.** Support là latch từ persistent absorption, không phải phép đo riêng về defended price floor/higher low.

```text
newLow = old.localLow !== undefined && P < old.localLow
localLow = min(old.localLow ?? b.P, P)  // bắt đầu khi sellingSeen=true

if !supportConfirmed:
  absorptionCount = absorption ? absorptionCount + 1 : 0
  phase = absorptionCount > 0 ? SUPPORT_FORMING
        : newLow ? SUPPORT_FAILED : SEARCHING_FOR_SUPPORT
  if absorptionCount >= C:
    supportConfirmed = true
    phase = SUPPORT_CONFIRMED
    localLow = P
```

**Inputs/thresholds:** đúng absorption predicate + C; không thêm p/n/higher-low/retained-liquidity-ratio threshold. **Required observations:** C absorption evaluations sau/kể từ selling confirmation, có thể overlap tick xác nhận selling.

Counterexample đã chạy, spacing20s/liquidity10.000/S=100/B=0:

| P | v | sellingCount | absorptionCount | Kết quả |
| ---: | ---: | ---: | ---: | --- |
| 100 | null | 0 | 0 | NEW |
| 99 | −0,05 | 1 | 0 | WAITING_FOR_SELLING |
| 98 | −0,05 | 2 | 1 | SUPPORT_FORMING |
| 97 | −0,05 | 3 | 2 | **SUPPORT_CONFIRMED**, supportConfirmed=true |

Không fixed “giá không giảm quá X%”. Vấn đề thực tế là **non-accelerating decline được dùng làm absorption và được đồng nhất với support**, ngay cả không có buy USD.

### RECOVERY / RECOVERY_ATTEMPT

**Inputs:** v, p, bp, n, bn, current/previous liquidity; yêu cầu sellingSeen/supportConfirmed trước đó và không mất localLow.

**Baseline:** previous observation cho price/flow changes; **không** ATH/peak/T0-price recovery percentage. LocalLow là invalidation baseline, không là denominator của recovery gate.

```text
recovery = v > 0 && p > bp && n > bn && liquidityAlive
recoveryCount = recovery ? old.recoveryCount + 1 : 0
```

Không yêu cầu B tăng, B>S, p>0,5, n>0, volume tối thiểu hoặc acceleration>0. PriceAcceleration được lưu nhưng không là predicate riêng của Recovery. Price/pressure/net improvement được so strict; không epsilon/tolerance hay magnitude minimum.

Với ACTIVE/supportConfirmed: nếu recovery=false và v<0 → RECOVERY_FAILED; nếu v>=0 thì code vẫn gán `RECOVERY_ATTEMPT`, dù recoveryCount=0. Vì vậy **phase RECOVERY_ATTEMPT một mình không chứng minh predicate recovery đã true**.

### RECOVERY_CONFIRMED / PASS

```text
if recoveryCount >= C + 1:
  phase = ENTRY_ELIGIBLE
  status = PASSED
  confirmedAt ??= now
  reason = RECOVERY_CONFIRMED
```

**Persistence:** runtime3 consecutive successful recovery evaluations, không phải3 distinct buyer transactions. Timely gate yêu cầu confirmedAt≥T0, <T1, ≤now. `RECOVERY_CONFIRMED` nằm trong phase type nhưng normal success **gán phase ENTRY_ELIGIBLE**; literal RECOVERY_CONFIRMED là `reason`, không phải phase thực được gán ở nhánh success.

**Quality:** all required raw fields known; current sample không future, age≤maxGap; spacing đủ; không gap/window reset trong chain. Không có Structure confidence score hay propagation của Capital Flow confidence. Tổng tối thiểu theo predicates mặc định: **7 accepted observations**, overlap selling/first absorption có thể xảy ra; **6 intervals≥90s** ở setting15s nếu seed đầu tại T0. Normal shared lane chỉ due sau15s nên đường sớm lý tưởng từ admission khoảng105s; không phải một hard-coded wait105s hoặc throughput guarantee.

**Đã PASS rồi:** nếu recovery không strict nhưng `v>=0 && p>=bp && n>=bn && liquidityAlive`, vẫn giữ PASSED/ENTRY_ELIGIBLE. Nếu yếu hơn thì ACTIVE/RECOVERY_FAILED, recoveryCount=0; chưa tự xóa supportConfirmed trừ newLow. Observer có thể confirm lại trong original deadline. confirmedAt dùng `??=` nên lưu first confirmation, không phải mọi lần reconfirm.

### Counterexample Recovery relative, không buyer-return proof

Fixture hiện tại cho price tăng, pressure/net cải thiện trong ba interval cuối dù B giảm liên tục:

| P | Rolling B | Rolling S | p | n | State / recoveryCount |
| ---: | ---: | ---: | ---: | ---: | --- |
| 100 | 100 | 200 | 0,3333 | −100 | NEW / 0 |
| 96 | 90 | 220 | 0,2903 | −130 | WAITING_FOR_SELLING / 0 |
| 93 | 80 | 240 | 0,2500 | −160 | SUPPORT_FORMING / 0 |
| 93 | 70 | 240 | 0,2258 | −170 | SUPPORT_CONFIRMED / 0 |
| 94 | 60 | 180 | 0,2500 | −120 | RECOVERY_ATTEMPT / 1 |
| 95 | 50 | 120 | 0,2941 | −70 | RECOVERY_ATTEMPT / 2 |
| 96 | 40 | 80 | 0,3333 | −40 | **PASSED / 3**, reason RECOVERY_CONFIRMED |

Nó đo **price bounce + improving relative rolling flow**, mạnh hơn price-only bounce, nhưng không chứng minh absolute buy activity quay lại. S rolling giảm nhanh hơn B có thể làm p/n tăng; history này chưa xác định được đó là new buys hay trades cũ rời cửa sổ. [Fixture traces](../data/structure-trending-audit-fixtures.json).

## 7. Threshold inventory — đúng phạm vi Structure

| Threshold / comparison | Value runtime | Config/code | Stage / purpose |
| --- | --- | --- | --- |
| Watch TTL | 600.000ms max | config constant/schema, runtime settings | Bound confirmation window; không min wait |
| Accepted interval | ≥15.000ms | structureObservationMs | Separate accepted snapshots |
| Sample age / sequence gap | ≤120.000ms; `>` reset/reject | structureMaxGapMs | Completeness/freshness/continuity |
| Future / duplicate timestamp | o.at≤now; strictly newer lastObservedAt | Code | No future/repeated evidence |
| Post-admission timestamp | o.at≥T0 | Wrapper code | Reject pre-T0 sample |
| Persisted observation cap | 120 | Code | Bound array |
| Selling / absorption confirmation | C=2 | structureConfirmations, schema2–5 | Consecutive qualifying evaluations |
| Recovery confirmation | C+1=3 | Code + config | Consecutive recovery evaluations |
| Sell activity / directional validity | S>0; B+S>0 | Code | Existence, không size/significance |
| Selling change | S≥prevS OR p<prevp OR n<prevn; thêm v<0 OR p<prevp OR n<prevn | Code | Relative deterioration |
| Liquidity | L>0 AND L≥prevL | Code | Required for absorption/recovery; zero allowed decline tolerance |
| Absorption price response | v≤0 AND v≥previousV | Code | Flat/non-accelerating downside |
| New low loss | P<old.localLow | Code | Strict lower-low; không drop% |
| Recovery price/flow | v>0, p>prevp, n>prevn | Code | Strict improvement, không minimum magnitude |
| Defended PASSED continuation | v≥0, p≥prevp, n≥prevn, L alive | Code | Retain previously confirmed result |
| Fresh feed reuse / UI label | 10.000ms | Engine code | Không phải Structure maxGap |
| Feed deferral age | >10.000 và≤sniperPollMs×2=60.000ms | Engine + config | Shared feed waiting, không phase authority |
| Peak / drawdown / recoveryRatio | descriptive formulas | Code | **Không entry percentage gate** |
| Risk min liquidity | 10.000 USD | Outside observer, same PRE_WATCH/EXECUTION policy | Entry floor; không Structure impact normalization |

Không tìm thấy `drop>=X%`, `recovered>=Y%`, `distanceFromATH<=Z%` hoặc absolute buy/sell ratio threshold cho Structure. Capital Flow regime dùng thresholds riêng; chúng **không** được đọc vào Structure gate. Không suy “không có fixed%” thành “không có thresholds”: zero-sign, monotonicity, count, cadence, gap, TTL đều là rule bắt buộc.

## 8. Peak / ATH / localLow và token đã cũ

`peak=max(previousPeak,P)` từ accepted observations của Watch; không đọc historical ATH hoặc GMGN price_start window. `drawdownPercent=(1−P/peak)×100`, `recoveryRatio=(P−localLow)/(peak−localLow)` (null nếu denominator0) chỉ được tính/lưu. Không có branch authorize theo hai tỷ lệ này.

LocalLow chỉ bắt đầu tính khi sellingSeen, từ previous/current prices lúc đó; không nhất thiết là min từ T0. Khi Support confirmed, reset localLow=current P. Sau đó strict P<localLow làm mất defense. Peak/localLow cũ còn qua gap, dù booleans/counters reset; support confirm mới sẽ đặt lại localLow. Không có higher-low comparator riêng hoặc support-zone width.

Ví dụ historical ATH1.00/current0.20/support0.18/recovery0.24: ATH1.00 **không được truyền vào observer**. Fixture `0.20,0.187,0.18,0.18,0.20,0.22,0.24` cùng qualifying flow PASS; peak cuối0.24. Chỉ biết current/window-local structure, không biết đang−76% so ATH. Ngược lại, chỉ snapshot0.20→0.24 sau T0 mà chưa thấy selling/support sẽ không PASS.

## 9. State machine thực tế, failure và tính sticky

```text
ACTIVE / NEW (admit không observation)
  → first valid sample: NEW, NEED_SEQUENTIAL_EVIDENCE
  → chưa sellingSeen:
       v>0 INITIAL_EXPANSION
       v=0 PEAK_FORMING
       v<0 WAITING_FOR_SELLING
  → C selling evaluations: sellingSeen=true
       SELLING_APPEARED được assign nội bộ rồi bị nhánh sau ghi đè
  → SEARCHING_FOR_SUPPORT / SUPPORT_FORMING / SUPPORT_FAILED
       C absorption evaluations → SUPPORT_CONFIRMED, supportConfirmed=true
  → RECOVERY_ATTEMPT (counter có thể vẫn0)
       C+1 recovery evaluations → PASSED / ENTRY_ELIGIBLE
                                  reason RECOVERY_CONFIRMED
```

| Transition / variable | Mandatory / optional / reversible |
| --- | --- |
| Initial Expansion / Peak Forming | Optional, có thể qua lại; không prerequisite Selling |
| sellingSeen | Mandatory cho downstream real PASS; sticky trong sequence, reset gap/window |
| Absorption→Support | Mandatory real path; hai nhãn UI dùng chung counter/latch, không hai bằng chứng độc lập |
| supportConfirmed | Reversible nếu newLow; giữ qua recovery yếu chưa phá low |
| Recovery persistence | Mandatory real path; false reset recoveryCount |
| PASSED | Reversible về ACTIVE nếu current defense yếu; timely pass không là executable approval |
| Gap / window change | Reset sequence, không restart T0/T1; không SCAM verdict |
| EXPIRED / INVALIDATED / USER_REMOVED | Terminal ở evolveStructure; không tự hồi sinh chính row đó |

**Support failure trước confirmation:** nếu không absorption, newLow=true → SUPPORT_FAILED; tiếp tục quan sát. Absorption=true vẫn có thể SUPPORT_FORMING dù tạo new low. **Support đã confirmed rồi mất low:** RECOVERY_FAILED, clear supportConfirmed/absorptionCount/recoveryCount, ACTIVE; reason DEFENDED_AREA_LOST_CONTINUE_WATCH. sellingSeen vẫn giữ. Không hard-coded drop%.

**Recovery attempt yếu:** recovery=false và v<0 → RECOVERY_FAILED, recoveryCount=0. Không phá localLow thì supportConfirmed vẫn true, tick tốt tiếp theo có thể thử recovery lại. v>=0 nhưng p/net chưa tốt thì RECOVERY_ATTEMPT/0; không PASS. First failed support/recovery không permanent reject nếu còn TTL/safety.

**Expiry:** now≥T1 mà chưa timely PASSED → EXPIRED trước khi xử lý observation mới. Timely PASS trước T1 có thể fresh-qualify sau T1, nhưng vẫn cần current defense và age guards. Hard invalidation/removal có thể kết thúc ngay. Constructor reconciliation không cấp lại10m.

## 10. GMGN fields, rolling semantics và Capital Flow integration

| Raw source → normalized field | Structure dùng? |
| --- | --- |
| `_gmgnSnapshot.fetchedAt` → market.at → observation.at | YES timestamp/cadence/quality |
| `price.price` → priceUsd | YES; không dùng window startPrice |
| `liquidity ?? pool.liquidity` → liquidityUsd | YES |
| `price.buy_volume_<w>` → windows[w].buyVolume → buyVolumeUsd | YES |
| `price.sell_volume_<w>` → windows[w].sellVolume → sellVolumeUsd | YES |
| `price.volume_<w>` → volumeUsd | Stored in observation; **không phase predicate** |
| `price.buys_<w>`, `price.sells_<w>` → buys/sells | Stored; **không phase predicate** |
| `price.price_<w>` → startPrice | Normalized Market có; **observer không dùng** |
| market cap / holder_count / smart_wallets | Có thể nằm FlowObservation; **observer không dùng** |
| smartMoneyBuy/SellUSD, largeBuy/SellUSD | Normalizer hiện null; không có independent buyer identity/large-trade evidence |

`normalizeFlowObservation` chọn window ngắn nhất có **cả buy/sell USD** theo `1m,5m,1h,6h,24h`. Nếu không có thì chọn counts hoặc volume fallback cho Flow; Structure vẫn từ chối vì buy/sell USD null. Không coi counts fallback là equivalent Structure authority. [capital-flow.ts:115](../src/capital-flow.ts#L115), [gmgn.ts:222](../src/gmgn.ts#L222).

**Observation là snapshot của rolling totals**, không cumulative lifetime total hoặc trade ledger. Structure không cộng từng S thành dòng tiền mới, không hiểu t1:S=12k là `+12k new sell`. Nó so `S>=previousS` và so p/n giữa các overlapping snapshots; price velocity là delta price / elapsed seconds. Không trừ S_t−S_prev để suy exact new sell USD, vì ngay cả delta rolling total cũng gồm trades cũ rời window.

Giới hạn vẫn còn: snapshot fetched sau T0 có thể chứa rolling trades trước T0, và p/net cải thiện chỉ do sell trades cũ roll off. Không có trade-event attribution hoặc volume-adjusted downside-impact metric. Window dài1h/24h vẫn đủ completeness cho Structure FRESH như1m nếu timestamp/cadence hợp lệ. Flow có confidence cap cho long windows ([capital-flow.ts:299](../src/capital-flow.ts#L299)); Structure **không consume** cap đó.

**Trước Watch:** `CapitalFlow.observeCandidate` ghi candidate_flow_states; Memory/Jev nhận Flow summary và retrieval, trước PRE_WATCH. **Trong Watch:** lane normalize raw trực tiếp, gọi structure.observe rồi capitalFlow.observeCandidate; không truyền CapitalFlowState/regime/features/confidence vào observer. **Sau PASS:** fresh analysis lại observe Flow và gọi Memory/Jev. Đây là reuse cùng raw producer/normalizer, nhưng Structure tính lại p=B/(B+S), n=B−S và price velocity riêng, thay vì đọc Flow buyPressure/netFlow/priceMomentum. Trùng basic signals; thresholds/hysteresis/units khác nhau.

UI absorption và support đều từ `supportConfirmed/absorptionCount` ([engine.ts:2437](../src/engine.ts#L2437)); hai dấu hoàn thành không chứng minh hai phép đo độc lập. Jev compact projection có phase/status/reason nhưng whitelist `supportCount` không phải actual `absorptionCount` của Watch; không gửi toàn bộ ordered history ([trading-memory.ts:605](../src/trading-memory.ts#L605)). Đây là context limitation, không bổ sung một Support algorithm khác.

## 11. One-spike, low-liquidity, high-volume

**One spike:** Với đã có Support, spike93→106.95 (+15%), p/net cùng tốt tạo recoveryCount=1; selling quay lại ngay sample kế → count0/RECOVERY_FAILED, không PASS. Fixture đã chạy. Một accepted price jump đơn lẻ không đủ mặc định3 confirmations. Nếu cùng underlying event được phản ánh thành nhiều tăng giá/flow snapshots liên tiếp, counts không chứng minh có nhiều buyer/trades độc lập; không có event-level dedup. Không tuyên bố mọi kiểu manipulation một trade đều bất khả thi.

Trả lời tổng hợp “một BUY lớn hoặc spike ở liquidity thấp có đủ không?”: **DEPENDS vào chuỗi snapshot được quan sát**. Một jump rồi reverse/flat ngay không đủ3 recovery intervals; low liquidity tự nó cũng không bị observer dùng như một confidence veto. Ba qualifying intervals không tự chứng minh ba BUY độc lập.

**Low liquidity:** Structure chỉ yêu cầu L>0 và L≥previousL cho absorption/recovery, không normalize price response theo liquidity, B/S-size, trade count hoặc price impact. Pure observer fixture liquidity1 USD vẫn PASS curve đủ điều kiện. **Đường normal entry không admit nếu known liquidity<10.000 USD** do Risk PRE_WATCH, và final Risk kiểm tra lại. Vì thế fixture1 USD không chứng minh actual normal BUY dưới floor. Với pool còn trên floor, Structure tự nó chưa đánh giá độ bền/impact của thin-price spike; exit probes/simulation là lớp khác.

**High volume:** volume tổng không tham gia predicate; không tự tạo bullish evidence. Fixture B=1.000.000/S=9.000.000, price tăng ba tick nhưng p/net không improve → không PASS. Nhưng sell-dominated **relative improvement** vẫn có thể PASS như bảng Recovery; không có gate yêu cầu buyers chiếm đa số.

## 12. Pre-T0 context đang có ở đâu?

| Source | Available / storage | Quality / amount | Currently consumed by Structure? |
| --- | --- | --- | --- |
| Candidate Capital Flow | YES, candidate_flow_states | Up to120 observations/30m mặc định, cadence15s; max250candidate retained; missing/window/age phải xét | **NO history hydration** |
| GMGN feed | YES nếu provider trả đủ, RAM feedObservations | Latest snapshot/mint, max300; replace whole snapshot, không merge directional cũ | Current snapshot only nếu đủ/fresh và at≥T0 |
| Info/cache | YES trong coordinator RAM | TTL10s current info; cache không là ordered per-mint market history | Current snapshot only, repeated fetchedAt không append |
| market_snapshots / analytical records | Có thể YES trước admission, SQLite records | Analysis timestamps, sampling không đều; không bảo đảm directional series đầy đủ | NO history query trong observer/admit |
| Discovery/token metadata | YES tokens/discovery; Trending rank history | Source/rank history bounded20, không OHLC/trade history | Không dùng để seed selling/support/peak |
| Legacy Sniper Watch | Có thể tồn tại bảng riêng | Historical policy; không fresh PRE_WATCH approval | Không hydrate vào new-policy Watch |

DB read-only checkpoint **20:33:11 Bangkok**: 73candidate Flow rows; trong24 Watch retained có5mint còn candidate Flow sample trước T0. Watch giữ454observations, tổng accepted474; **0 accepted observation timestamp<T0**. 24row đều EXPIRED, legacy rows0. Counts là checkpoint của LIVE DB, không controlled cohort, không thể suy mọi expired đều starvation hoặc missed opportunity. Ba mint đã entry bằng bypass vẫn có Watch ACTIVE lúc entry rồi có thể expiry sau khi owned ngừng Watch reads. [DB evidence](../data/structure-trending-audit-db.json).

Context có thể technically cung cấp pre-T0 baseline nếu đủ provenance/window/freshness, nhưng current code **không làm**. Đó là khả năng dữ liệu, không là đề xuất tự động nhập hoặc xác nhận chất lượng mọi row.

## 13. Rediscovery / reopen / pruning

`Store.discover/mergeDiscovery` cập nhật token/source/listing/rank; không ghi Watch. `admit` trả existing new-policy row; `get/list` khóa theo mode+mint, PK chống hai active row cùng mint trong cùng bảng. Rediscovery thường **không reset T0, peak, low, phase hoặc counters**, không append observation. Audit RAM xác nhận cả payload Watch giữ nguyên sau discover + repeated admit.

Shared feed `rememberFeed` replace toàn snapshot, giữ fetchedAt producer; o.at≤lastObservedAt không tăng evidence. Timestamp discovery mới không được dùng thay timestamp của Watch observations cũ. Candidate listing field freshness F01 là dependency Security riêng, không được coi là đã sửa; không chứng minh Structure reuses old directional fields bằng shallow listing merge.

Reopen đọc persisted Watch; constructor clamp original expiry, không seed history hoặc grant new10m. Manual tombstone/revision còn ngoài row retention, không tự revive. Terminal rows có retention250, Candidate terminal500; nếu terminal Watch bị prune rồi có **fresh eligibility attempt mới**, có thể có record mới — khác với rediscovery reset một ACTIVE Watch đang có. Không suy fixed-window là permanent whole-mint blacklist.

## 14. Risk PRE_WATCH / EXECUTION và live confirmation

| Requirement | PRE_WATCH | EXECUTION, bypass OFF |
| --- | --- | --- |
| Structure required | NO timing requirement; chưa có Watch | YES timely PASSED |
| Policy | Engine chạy Trending path và admit policy mới sau allow | For Trending: eligibility.policy và entryAuthority.policy đúng `TRENDING_FINAL_STRUCTURE_V1` |
| Revision | Current Store authority checked ở Engine trước admission | Watch eligibility.authorityRevision == Snapshot entryAuthority.revision; Store current revision/tombstone checked ở execution/pre-sign |
| Confirmation time | Chưa có | confirmedAt≥T0, <T1, ≤now |
| Observation time | Critical market/security/Jev/holder freshness vẫn áp dụng | Watch quality FRESH, lastObservedAt≤now và age≤structureMaxGapMs120s |
| State counters / reason string | Không dùng | Risk **tin PASSED + timely timestamps**, không tính lại selling/support counters hoặc compare literal reason RECOVERY_CONFIRMED |
| Ownership / capital / Security / compatibility / concentration / Jev | Cùng các checks hiện có | Cùng các checks; không bỏ vì Structure PASS |

`Risk.approve` gọi lại evaluate mặc định EXECUTION, tạo intent bound Snapshot hash. Engine final callbacks đọc current Watch, revision/tombstone và freshness; immediate pre-sign authority vẫn bắt buộc. Không mô tả chúng là một lần refetch đầy đủ Security/Risk ở last instruction; F07 không được tự coi là đã sửa trong audit này.

**Stale PASS:** raw quality STALE/UNKNOWN hoặc age>120s không satisfy EXECUTION. `hasEligibleStructurePass()` một mình chỉ là policy+timely status, **không** kiểm tra quality/observation age; consumers thêm guards. UI lại label STALE khi age>10s ([engine.ts:2467](../src/engine.ts#L2467)), nên UI STALE11–120s có thể vẫn nằm trong Structure age budget của Risk nếu persisted quality FRESH. Không đồng nhất hai freshness thresholds.

**New admission gần như instant PASS bằng old history? NO, bypass OFF.** Admission rỗng; minimum sequence phải gồm observations at≥T0. Một sample at=T0 được phép, không strictly greater; ordered pre-T0 history bị chặn. Existing already-PASSED row có thể được reopen/re-evaluate nếu còn fresh/timely; đó không phải Watch mới được admit và PASS bằng lịch sử token. TEMP có thể mở fresh pipeline sau observation đầu tiên mà vẫn không tạo real PASS.

## 15. TEMP RECOVERY BYPASS — tách khỏi thuật toán thật

- **Present: YES.** Một flag `process.env.TEMP_BYPASS_RECOVERY_GUARD === "true"` ở [recovery-guard.ts:11](../src/recovery-guard.ts#L11); unset/false/invalid mặc định OFF. `.env` tại audit là **true**, giữ nguyên.
- **Promotion: YES**, ACTIVE admitted/fresh có thể promote bằng canBypassRecovery; **Risk EXECUTION: YES**, validRecoveryBypass là alternative của Recovery predicate; không thay PRE_WATCH. Final/pre-sign check lại bound metadata/flag/current Watch.
- Required Watch policy/admission/revision, original live TTL, FRESH/lastObservedAt, source path và các safety khác vẫn có. Không có quyền giả admission hoặc kéo dài TTL.
- **Không fake RECOVERY_CONFIRMED/PASSED/counters/evidence.** Candidate promotion ghi reason TEMP_RECOVERY_BYPASS_FRESH_PIPELINE_REQUIRED. Logs: `[TEMP] RECOVERY_CONFIRMED guard bypassed` và `[TEMP] Risk EXECUTION Recovery guard bypassed`.
- **Memory có bị ảnh hưởng: YES về provenance và dataset.** Snapshot/Intent lưu `entryAuthority.recoveryBypass`, immutable sample giữ actual Watch ACTIVE. Không ghi nó như real Structure PASS. Nhưng normal completed/accounting-eligible bypass trades **không có blanket exclusion riêng** khỏi future statistical Memory retrieval; filter hiện không đọc bypass tag ([trading-memory.ts:501](../src/trading-memory.ts#L501)). Tag tồn tại không đồng nghĩa toàn pipeline learning đã stratify cohorts.

DB checkpoint có **3 learning samples LIVE mang TEMP_RECOVERY_BYPASS**; Watch tại entry lần lượt NEW, SEARCHING_FOR_SUPPORT, SEARCHING_FOR_SUPPORT, tất cả status ACTIVE; có112 TEMP engine log records. Điều này xác nhận bypass đã được dùng trong runtime hiện tại, **không** chứng minh thuật toán thật từng Recovery PASS. Audit không tạo các trades này, không đổi flag, không dừng LIVE.

## 16. Sáu Trending scenarios — source reasoning, không trade

| Scenario | Can understand / likely path | Missing context | False-positive risk | False-negative risk |
| --- | --- | --- | --- | --- |
| A. Token3m, initial pump→sell→recovery sau T0 | YES nếu samples đủ: optional expansion→selling→support→eligible | Phần trước admission và event identity | Support proxy có thể sớm; rolling relative recovery | Gap/TTL/thiếu directional có thể mất sequence |
| B. Token30m, phát hiện trước pullback | YES local sequence, không cần tuổi mới | Earlier market cycles, historical supply/flow ngoài Snapshot | Same proxy limitations | Pullback không đủ C observations hoặc10m hết |
| C. Token6h, phát hiện giữa selling | PARTIAL: nhận selling trực tiếp nếu còn≥C qualifying intervals, rồi support/recovery | Selling phần đầu và broader cycle | Relative improvement vẫn sell-dominated | Nếu chỉ còn cuối selling, counter chưa đủ trước recovery |
| D. Token2d, absorption đã bắt đầu trước T0 | PARTIAL: nếu còn decreasing price/selling đủ thì có thể tái tích lũy; recovery-only sau T0 thường không sellingSeen | Prior selling/absorption/support | Flat/nonaccelerating price có thể thành Support proxy | Bỏ lỡ cấu trúc hợp lệ vì phải thấy selling mới |
| E. Token cũ breakout rồi pullback | YES nếu whole relevant local sequence được observe | Historical resistance/ATH và prior breakout volume | Small monotonic changes/no minimum flow size | Breakout/retest không có required local sell pattern sẽ chờ |
| F. Token cũ distribution sau nhiều pump cycles | Chỉ hiểu one local sequence, không nhận diện cycle distribution bằng Structure | Multi-cycle context/order flow; Flow/Jev có context riêng nhưng không hydrate observer | Weak bounce + rolling sell roll-off có thể PASS | Có thể reject/expire despite genuine new local defense bị thiếu đầu chuỗi |

Tuổi6h/2d nằm trong Trending default30d khi createdAt known; không guarantee candidate qua Security/Jev/Risk. Không đề xuất age buckets từ các scenarios này.

## 17. Test coverage map và kiểm chứng audit

Phân biệt **existing suite coverage** với **audit fixture bổ sung**; không lấy test count làm đúng chiến lược.

| Behavior | Existing coverage | Evidence / thiếu gì | Audit addition |
| --- | --- | --- | --- |
| Selling | covered | sniper-coordinator: real selling/weak crash; no initial pump fixture có implicit coverage | Explicit direct-selling/no-expansion trace |
| Absorption | partial | Happy curve; chưa counterexample zero buys/constant decline | Đã chứng minh degenerate Support |
| Support | partial | Happy + failed-bounce/recovery; không chứng minh actual volume-adjusted buyer defense | Zero-buy / constant-decline trace |
| Recovery | covered cho current predicate | Happy curves/persistence; không chứng minh new buyer events | Decreasing B/negative n vẫn PASS |
| Early PASS | covered | 2m,5m,9:59 observer; Trending fresh pipeline120/220/599s | Không cần test-count thay source |
| 10m expiry / no minimum wait | covered | v52-controls, trending-final-gate | Không sửa TTL |
| Failed support / recovery | covered | failed bounce can recover, gap/deadline invariants | One spike resumes selling → no PASS |
| Provider UNKNOWN / repeated snapshot | covered | sniper-coordinator + Trending outage | Pre-T0 snapshot rejected |
| Gap/window change | covered reset | Không assertions đủ về retained peak/localLow | Gap retains peak/low demonstrated |
| Rediscovery / reopen | covered phần deadline/lifecycle | Existing tests chưa assert mọi low/peak/evidence field | Full Watch payload unchanged after rediscovery/admit |
| Manual removal / pre-sign revocation | covered | v52-controls / trending-final-gate / temp bypass | Existing fixtures reused |
| Trending old token6h/2d | missing explicit age+behavior matrix | Candidate defaults mostly60s; no comparative old-token series in mapped tests | Source reasoning + far-below-ATH local curve; chưa empirical6-scenario replay |
| Pre-T0 history hydration | missing generalization behavior | Không có implementation để hydrate | RAM shows Flow prehistory exists, new Watch still empty |
| One spike after confirmed Support | partial | One green tick before full structure tested; không equivalent toàn scenario | +15% single spike then sellers returns → count1→0 |
| Low liquidity normalization | missing | Existing entry floor/execution safety khác observer confidence | Pure observer L=1 PASS; không claim full Risk allows |
| High-volume / sell dominated | partial | Happy directional fixtures | Huge S-dominated flat p/n không tự PASS |
| TEMP ON/OFF / other safety deny / tagged sample | covered | temp-recovery-bypass.test.ts37 tests | Reused; production flag không đổi |

Đã chạy với pinned Node22.22.0, `scripts/test-env.mjs` (bypass OFF ở process test) + [network deny preload](../data/structure-trending-audit-no-network.mjs). Temp-bypass existing tests tự toggle flag trong **process fixture**, không sửa `.env` hoặc process LIVE.

| Kiểm chứng | Kết quả |
| --- | --- |
| Existing trending-final-gate + v52-controls + temp-recovery-bypass | **71 passed,0failed,0skipped**, 8.002,2884ms; [log](../data/structure-trending-audit-existing-tests.log) |
| Existing sniper-coordinator observer subset (name-pattern, không chạy benchmark ghi đè evidence cũ) | **8 passed,0failed**, 5.479,846ms; [log](../data/structure-trending-audit-observer-tests.log) |
| Additional isolated audit fixture groups | **11 groups, all assertions PASS**; [harness](../data/structure-trending-audit-fixtures.ts), [traces](../data/structure-trending-audit-fixtures.json), [log](../data/structure-trending-audit-fixtures.log) |
| Typecheck | PASS, exit0; [log](../data/structure-trending-audit-typecheck.log) |
| Lint | PASS, exit0; [log](../data/structure-trending-audit-lint.log) |
| Full suite / build / real provider verification | Không chạy; không rebuild dist khi bot LIVE, không claim277/280 tests vừa chạy |

Reproduce fixtures (không cần dừng hoặc đổi flag của bot; đây là isolated process):

```text
pnpm exec tsx --import ./scripts/test-env.mjs --import ./data/structure-trending-audit-no-network.mjs data/structure-trending-audit-fixtures.ts
```

## 18. FACTUAL FINDINGS

### SW01 — MEDIUM — Full sequence sau admission bỏ lỡ local structure đã diễn ra trước T0

- **Files/functions:** SniperStructure.admit/observe (302/445), evolveStructure (104/212), Engine.observeStructureWatches.
- **Actual behavior:** new Watch bắt đầu observations=[], sellingSeen=false/supportConfirmed=false; reject o.at<T0; không load candidate Flow history. Không cần initial pump nhưng phải confirm selling mới trong Watch trước Support/Recovery.
- **Why Trending:** entry từ rank thường nằm giữa existing structure, không nhất thiết trước selling. Tuổi không gây lỗi; thiếu đầu chuỗi quan sát mới là vấn đề.
- **Concrete scenario:** market đã selling/absorption/support trước admission; 8 tăng giá+improving flow sau T0 vẫn ACTIVE/INITIAL_EXPANSION.
- **False negative/positive:** FN local recovery có thể bị bỏ lỡ/expire; finding không chứng minh FP tự động.
- **Evidence:** pure source + `discoveryAfterPriorSupport`, RAM prehistory fixture; read-only DB có pre-T0 Flow ở5 Watch retained nhưng0 pre-T0 accepted.

### SW02 — MEDIUM — Support đồng nhất persistent non-accelerating decline với buyer defense

- **Files/functions:** evolveStructure237–258; UI projection2437–2446.
- **Actual behavior:** S>0, L không giảm, v≤0/v≥previousV, đủ2 lần → supportConfirmed. Không buy growth/pressure/net condition hoặc impact-per-sell normalization; không distinct Support test.
- **Why Trending:** mature token trong distribution/steady sell có thể được label có lực đỡ dù chưa có bằng chứng buyers quay lại.
- **Concrete scenario:** price100→99→98→97, B0/S100/L10k → SUPPORT_CONFIRMED ởsample4.
- **False positive/negative:** FP **Support label**; chưa đủ làm BUY vì vẫn cần Recovery/Risk. Strict liquidity non-decline cũng có thể tạo FN trong absorption có LP fluctuations.
- **Evidence:** exact predicate và `supportDuringConstantDeclineWithZeroBuyUsd` trace.

### SW03 — MEDIUM — Recovery là relative rolling improvement, không chứng minh new buyer return

- **Files/functions:** evolveStructure260–285; normalizeFlowObservation117; normalizeMarket222.
- **Actual behavior:** positive price velocity + p/n tăng + L alive,3 lần là PASS; không require B tăng/n positive/buyer majority/independent trades. Rolling sell roll-off có thể cải thiện ratios/net khi B vẫn giảm.
- **Why Trending:** old token/distribution/rebound trong overlapping windows có thể được gán buyer-return confirmation quá mạnh so evidence thực sự.
- **Concrete scenario:** bảng price100→96→93→93→94→95→96, B100→40 giảm mọi tick, n luôn âm, vẫn real PASSED khi bypass OFF.
- **False positive/negative:** FP Structure interpretation có thể mở fresh pipeline; không chứng minh full execution sẽ allow hoặc trade bị loss. Recovery yêu cầu mọi p/n tick đều strict-improve cũng có thể FN bền giá nhưng flow plateau.
- **Evidence:** `recoveryWithFallingBuyTotalsAndNegativeNet`; counts3 thể hiện3 evaluations, không3 buyer events.

### SW04 — LOW — Quality/impact evidence chưa phân biệt long windows hoặc thin-price response

- **Files/functions:** normalizeFlowObservation115–155; evolveStructure135–170/204/260; capital-flow.ts299.
- **Actual behavior:** directional1h/24h vẫn vào Structure nếu fields/timestamp hợp lệ; Flow long-window confidence cap không được consume. Không price-impact-per-USD/liquidity normalization hoặc minimum flow significance trong observer. UI fresh10s khác Risk Structure budget120s.
- **Why Trending:** long established token có rolling context dài trước T0; fresh transport timestamp không đồng nghĩa fresh behavioral event hoặc independent trade evidence.
- **Concrete scenario:** cùng qualifying curve và liquidity1 USD vẫn observer PASS; full Risk min10k chặn entry dưới floor nên không claim executable unsafe BUY từ fixture này.
- **False positive/negative:** có nguy cơ overinterpret timestamp-FRESH/price response; chưa có calibrated LIVE false-positive rate.
- **Evidence:** code, `oneDollarLiquidityObserverOnly` và `twentyFourHourWindowCanPass` (24h vẫn PASSED/FRESH); chưa separate live experiment.

### SW05 — INFO — Temporary bypass ON và đã có LIVE samples; chúng không là real PASS evidence

- **Files/functions:** recovery-guard.ts, Engine promotion/final callbacks, Risk EXECUTION, immutable sample build.
- **Actual behavior:** .env=true; metadata/logs xác nhận dùng; sample Structure vẫn ACTIVE. Không fake evidence. Retrieval không blanket-exclude tagged cohort.
- **Why Trending:** không dùng số BUY hiện tại làm bằng chứng real algorithm đã xác nhận recovery; cần phân biệt provenance khi phân tích outcomes.
- **Concrete scenario:**3 LIVE sample snapshots mang TEMP_RECOVERY_BYPASS, phase NEW/searching support.
- **False positive/negative:** không phải algorithmic counterexample; là limitation của operational/learning interpretation khi bypass đã được user bật.
- **Evidence:** read-only DB JSON và existing bypass tests. Audit giữ nguyên flag.

### SW06 — INFO — Phase/UI labels không tương đương independent behavioral predicates

- **Files/functions:** StructurePhase type15; evolveStructure208–258/273–285; Engine progress2431–2452; Memory projection605.
- **Actual behavior:** SELLING_APPEARED là intermediate assignment bị nhánh sau ghi đè; success phase ENTRY_ELIGIBLE/reason RECOVERY_CONFIRMED. RECOVERY_ATTEMPT có thể recoveryCount0; absorption/support UI dùng cùng latch; Memory whitelist supportCount không chứa actual absorptionCount.
- **Why Trending:** trace/menu có thể trông như đã đo nhiều independent stages hoặc positive recovery dù predicate chưa đạt.
- **Concrete scenario:** high-volume rising price nhưng p/net không improve → RECOVERY_ATTEMPT/0, không PASSED.
- **False positive/negative:** presentation/context interpretation, không Risk PASS bypass mới.
- **Evidence:** exact assignments/projection và `largeSellDominatedVolume` fixture.

**Severity totals:** Critical0, High0, Medium3, Low1, Info2. Không nâng scope thành Security audit; F01/F02 còn là dependency của eligibility hiện hữu, không patch hoặc tái nghiệm thu chúng.

## 19. TRENDING COMPATIBILITY / local structure verdict

**PARTIALLY COMPATIBLE.** Phân loại implementation: **B — LOCAL ENTRY STRUCTURE**, với constraint “phải thấy đủ full sequence trong original post-admission window”. Không phải lifecycle model đọc launch/first ATH/first pump của token. Các tên INITIAL_EXPANSION/Sniper và full-sequence order khiến nó giống lifecycle trace, nhưng code không đòi mới launch hoặc initial expansion.

Vì thế token6h được phát hiện giữa pullback **có thể** đánh giá đúng phần local còn lại nếu đủ selling/absorption/recovery samples trước expiry; không tự sai chỉ vì cũ. Nếu selling/absorption trước T0, không biết lại phần đó và có thể chờ vòng selling mới. Đây là thiếu context và strength-of-evidence problem, không có cơ sở sửa bằng hard-coded token-age buckets.

## 20. Required direct answers — real algorithm với bypass OFF trừ câu25

| # | Question | YES / NO / PARTIAL / UNKNOWN và phạm vi |
| --- | --- | --- |
| 1 | Still based on assumptions from Sniper? | **PARTIAL** — inherited full ordered sequence sau T0/names; không inherited launch-age/initial-pump gate |
| 2 | Assume newly launched? | **NO** |
| 3 | Require Initial Expansion before Selling? | **NO** |
| 4 | Treat T0 as token lifecycle start? | **NO** literal token lifecycle; T0 là đầu local observation/sequence |
| 5 | Evaluate discovered mid-pullback? | **PARTIAL** — cần đủ local selling còn lại; không hydrate đoạn trước T0 |
| 6 | Use ordered selling evidence before T0? | **NO**; rolling post-T0 snapshots có thể chứa pre-T0 trades, không reconstruct sequence |
| 7 | Use absorption evidence before T0? | **NO** ordered history |
| 8 | Support based on actual buyer-defense evidence? | **PARTIAL** — proxy sellUSD + nonaccelerating downside + L, không buyer absorption proof |
| 9 | Measure selling pressure versus price response? | **PARTIAL** — S>0 và velocity comparison; không impact-per-sell normalization/intensity proof |
| 10 | Support merely fixed drop threshold? | **NO** |
| 11 | Recovery measured from ATH/peak? | **NO** — previous observation; localLow là failure boundary |
| 12 | Recovery only price bounce? | **NO** — còn p/n improvement và liquidity |
| 13 | Require improving buyer pressure? | **YES** relative p>prevp, không absolute dominance |
| 14 | Require persistence across observations? | **YES** C+1=3 recovery evaluations |
| 15 | One price spike produces Recovery Confirmed? | **NO** cho one accepted jump rồi sellers quay lại; multiple snapshots không bảo đảm multiple buyer events |
| 16 | Liquidity affects Recovery confidence/decision? | **YES** decision L>0/non-decrease; không confidence/impact normalization |
| 17 | Fixed drawdown/recovery percentages? | **NO** authority gate |
| 18 | Provider UNKNOWN becomes failed support? | **NO** trực tiếp; wall-clock expiry/gap reset vẫn xảy ra độc lập |
| 19 | Rediscovery resets T0? | **NO** khi existing Watch còn được giữ |
| 20 | Rediscovery resets Structure evidence? | **NO**; observation gap/window change có reset sequence riêng |
| 21 | Six-hour Trending evaluated correctly? | **PARTIAL** — age không cản, context availability/counterexamples vẫn có |
| 22 | Two-day Trending evaluated correctly? | **PARTIAL** — cùng giới hạn, default age policy cho phép tuổi này |
| 23 | Primarily lifecycle-based? | **NO** whole-token lifecycle |
| 24 | Primarily local-entry-based? | **YES**, post-admission local full sequence |
| 25 | Temporary bypass active/present? | **YES** present; .env ON và đã được dùng trong runtime/sample; giữ nguyên |
| 26 | Bypass OFF requires Recovery at Risk EXECUTION? | **YES** semantic timely PASSED + new-policy/fresh/revision; không compare literal reason string |
| 27 | Require live evidence after admission? | **YES**, at≥T0 cho new Watch; at=T0 được phép, không strictly greater |
| 28 | Pre-T0 context available somewhere? | **YES**, candidate Flow / analytical records, không guaranteed quality đầy đủ |
| 29 | Pre-T0 ordered context consumed by Structure? | **NO**; rolling totals chứa quá khứ là distinction riêng |
| 30 | Suitable for Trending without modification? | **PARTIAL** về cases hỗ trợ; **NO** cho nghiệm thu as-is đáp ứng đủ local buyer-defense semantics |

## 21. Preservation / giới hạn kiểm chứng

Fingerprint bao phủ144files source/public/config/scripts/tests/dist/package/lock/`.env` và cấu hình build, không bao gồm DB LIVE để giả vờ Engine không ghi. **Checkpoint cuối20:49:10 Bangkok:144 checked,0 changed,0 added protected files; source digest khớp build runtime; PID11500 vẫn LIVE/entries enabled, halt=null.** [Before](../data/structure-trending-audit-integrity-before.json); comparison và runtime được lưu trong [after](../data/structure-trending-audit-integrity-after.json), [final runtime](../data/structure-trending-audit-runtime-final.json), [summary](../data/structure-trending-audit-summary.json). Không sửa F01/F02, không bật/tắt bypass/LIVE, không restart bot.

Chưa đo hiệu quả trading, latency/quota HTTP ngoài mạng, independent real buyer transactions hoặc accuracy trên six-scenario historical replay. Pure fixtures kiểm chứng current predicates; không biến synthetic rolling values thành market history đã xảy ra. Existing tests đạt chỉ chứng minh current tested behavior, không phủ nhận counterexamples audit.

## 22. RECOMMENDATIONS — chưa triển khai

Đã có: post-admission live observation, shared normalization/producer, selling persistence, nonaccelerating-downside proxy, liquidity non-decline, support latch, recovery p/n/price persistence, fixed TTL/gap/UNKNOWN handling, fresh execution pipeline.

**Proposed**, chưa phải implementation hiện tại: recent market context có provenance/window/quality rõ + live post-admission confirmation; độc lập hóa “absorption response” với “defended support”; phân biệt new buyer evidence với rolling sell roll-off; đánh giá impact/sample independence. Không tự nhập prehistory, hạ freshness, đổi thresholds, bật/tắt bypass hoặc tạo age buckets trong audit.

## 23. Final verdict

**STRUCTURE WATCH NEEDS MATERIAL GENERALIZATION FOR TRENDING**

Tối đa5 ưu tiên đề xuất, **KHÔNG implement**:

1. Thiết kế explicit recent-context contract để xử lý late discovery, vẫn bắt buộc live confirmation sau admission và giữ T0/T1 gốc; không giả pre-T0 evidence thành newly observed facts.
2. Tách absorption proxy khỏi defended Support, kiểm chứng actual selling intensity versus downside response; chặn counterexample constant decline/B=0 trước khi tuyên bố buyer defense.
3. Làm rõ Recovery relative versus buyer-driven return; kiểm chứng rolling-window roll-off, sample/event independence và declining-buy/negative-net counterexample trước khi chọn policy mới.
4. Bổ sung coverage có kiểm soát cho6h/2d/late support/one-spike/thin liquidity/long-window cases; thống nhất diễn giải quality/UI/counters, không nới các execution guards để làm test PASS.
5. Tách riêng bypass cohort trong phân tích/learning attribution và kết quả audit thuật toán; provenance tag đã có, statistical cohort handling là phần còn cần quyết định riêng. Không đổi flag trong lượt audit này.
