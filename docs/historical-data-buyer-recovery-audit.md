# Post-refactor audit — Historical Data & Buyer Recovery Evidence

Ngày: 2026-11-01. Phạm vi: implementation hiện tại của Candidate One-Shot. Audit này bắt đầu sau khi hoàn tất UI Log. Chỉ đọc source/dependency, đọc SQLite bằng `DatabaseSync({readOnly:true})` và `PRAGMA query_only=ON`, gọi các hàm thuần với dữ liệu trong bộ nhớ; không chạy Engine/Store/provider/executor. Không sửa lỗi tìm thấy.

## A. Executive Verdict

**PARTIALLY READY.** Có đường production lấy **OHLCV lịch sử 1 phút thật** từ GMGN; không phải tự biến volume 1m/5m/1h thành timeline. Persisted LIVE audit cũng có nến theo timestamp, không chỉ fixture. Tuy nhiên, implementation **không có buy/sell volume/count hoặc liquidity lịch sử trước discovery**. Selling → Absorption → Defense → Recovery là chuỗi **proxy giá**, không phải bằng chứng đầy đủ về hành vi cung/cầu theo thời gian.

Tên `ONE_SHOT_BUYER_DEFENSE_CONFIRMED` mạnh hơn dữ liệu thực tế. Tái hiện được việc 4 nến, coverage 6.67%, vẫn trả structure passed; chuỗi gần đầu lookback vẫn giữ passed sau 56 nến đi ngang. Những kết quả này không chứng minh bot đã BUY: Security/JEV/Risk/ownership/execution vẫn là các gate riêng.

Giới hạn kết luận: audit source trên đĩa và persisted runtime records. Không xác minh tiến trình đang chạy đã nạp đúng toàn bộ source hiện tại, không gọi HTTP provider mới và không chứng nhận SLA/độ đầy đủ dữ liệu của mọi token.

## B. What Changed In Refactor

Không có `.git`: `git status` báo “not a git repository”; không thể xác minh NEW/MODIFIED bằng commit/diff. Cột dưới là phân loại theo `docs/one-shot-implementation.md` và nội dung code, **không phải lịch sử Git được chứng minh**.

| File | Vai trò hiện tại | Phân loại refactor được tài liệu mô tả |
|---|---|---|
| `src/candidate-attempt.ts` | UUID, stages, logs, summaries riêng mỗi attempt; persistence là audit sink | NEW |
| `src/one-shot-entry.ts` | Pipeline quyết định một lượt | NEW |
| `src/market-history.ts` | Parse OHLCV, attempt flow, one-shot structure | NEW; parser được sửa tiếp theo tài liệu history-parser-fix |
| `src/position-collector.ts` | Giới hạn collection theo Position | NEW |
| `src/engine.ts` | Entry gọi oneShotEntry; monitor Position độc lập | MODIFIED |
| `src/candidate-lifecycle.ts` | Appearance queue, cleanup; bỏ watch/retry entry | MODIFIED |
| `src/discovery.ts`, `src/store.ts` | Trending appearance, watermark, persistence | MODIFIED |
| `src/gmgn.ts`, `src/gmgn-coordinator.ts` | K-line read, CLI transport, provenance/cache/scheduler | MODIFIED |
| `src/capital-flow.ts` | Chuẩn hóa rolling snapshots; giữ collector Position/legacy candidate methods | MODIFIED |
| `src/jev.ts`, `src/risk.ts`, `src/domain.ts` | JEV fresh input, tắt Memory entry, gate one-shot | MODIFIED |
| `src/executor.ts`, `src/jev-exit-scheduler.ts`, `src/config.ts` | Execution boundary, scheduling, configuration | MODIFIED |
| `src/sniper-structure.ts`, `src/structure-evidence.ts`, `src/flow-view.ts` | Legacy structure/local observations và presentation | EXISTING, không phải thuật toán one-shot hiện tại |
| `src/solana.ts`, `src/execution-provider.ts` | RPC/ownership/receipt và Jupiter execution | EXISTING, không phải historical index |
| `tests/one-shot*.ts`, `tests/fixtures.ts` | Fixture/history/pipeline contracts | NEW/MODIFIED theo tài liệu; không phải bằng chứng provider coverage |

## C. Production Data Flow

```text
DiscoveryCoordinator.pollSource(TRENDING)
  -> Gmgn.trending -> CLI market trending -> GET /v1/market/rank
  -> parseTrending -> Store.discover + enqueueTrending
  -> CandidateLifecycle.refill -> Engine.analyze -> CandidateAttempts.begin [UUID mới]
  -> oneShotEntry
       CHEAP_FILTER: token info [cacheMs=0]
       SECURITY: token security [pre-buy cacheMs=0]
       COMPATIBILITY: Solana mint account [LIVE]
       HISTORY: Gmgn.marketHistory
          -> CLI market kline --resolution 1m --from seconds --to seconds
          -> CLI đổi from/to thành milliseconds
          -> GET https://openapi.gmgn.ai/v1/market/token_kline
          -> json.data -> CLI raw stdout -> JSON.parse
          -> Coordinator thêm local _gmgnSnapshot
          -> parseMarketHistory -> sorted Candle[] + coverage
       CAPITAL_FLOW: current info rolling snapshot + OHLCV price context
       JEV: raw normalized candles + current market/flow/security/compatibility
       RISK [QUALIFICATION]
       STRUCTURE: oneShotStructure(history, flow, market)
       FINAL_ANALYSIS: info/security/compatibility/holders mới;
                       flow/structure tính lại với CÙNG history
       ownership/capital -> Executor -> quote/routes/simulation/pre-sign -> BUY/REJECT
```

Thứ tự thực tế là **JEV trước STRUCTURE**. Không được mô tả như JEV luôn nhận kết quả Structure đã tính xong.

## D. Actual Historical Source

Call chain kiểm tra đến tận dependency đã cài (`gmgn-cli` 1.6.9):

| Bước | File/function | Input → output |
|---|---|---|
| Entry | `src/engine.ts:648`, `analyze` | mint → begin fresh attempt, gọi oneShotEntry |
| History stage | `src/one-shot-entry.ts:124` | Candidate → raw GMGN → MarketHistory |
| Wrapper | `src/gmgn.ts:843`, `marketHistory` | mint, NOW−3600000..NOW → CLI args 1m, cache TTL 0 |
| Transport | `src/gmgn.ts:584`, `run` | args → execFile CLI, timeout 20s, max stdout 4 MiB, parse JSON |
| CLI command | `node_modules/gmgn-cli/dist/commands/market.js:29` | Unix seconds args → `getTokenKline(..., from*1000, to*1000)` |
| HTTP | `node_modules/gmgn-cli/dist/client/OpenApiClient.js:71` | GET `/v1/market/token_kline`, chain=sol/address/resolution=1m/from/to milliseconds |
| Envelope | OpenApiClient `parseResponse` | require `code===0`; return `json.data` |
| Output | `node_modules/gmgn-cli/dist/output.js:2` | sanitize untrusted metadata, JSON stringify; raw không đồng nghĩa bỏ sanitizer |
| Provenance | `src/gmgn-coordinator.ts:106` | structured clone + `_gmgnSnapshot` local fetch/cache completion timestamp |
| Normalization | `src/market-history.ts:43` | `list[].time/open/high/low/close/volume` → `Candle[]` |

Raw shape được ghi lại trong tài liệu parser trước audit này:

```json
{"time":1793504520000,"open":"0.00029360248","close":"0.00031329725","high":"0.00032054408","low":"0.00028586856","volume":"1487.10524076","amount":"4923681.514648001"}
```

Đây là **sample trước đó** trong `docs/history-parser-fix.md`/regression test, không phải HTTP capture mới của audit này. Mapper hiện đọc `volume` thành `volumeUsd`, bỏ `amount`; unit USD dựa trên xác minh runtime đã ghi trong tài liệu đó. Audit hiện tại chưa độc lập đối chiếu unit với giao dịch on-chain. Provider không gửi buy/sell breakdown trong những field mapper sử dụng.

Runtime sample mới: [historical-audit-runtime-sample.json](historical-audit-runtime-sample.json). Đọc 8 attempt mới nhất từ DB đang có, gồm 1 RUNNING chưa có history và 7 rejected. Các normalized history có 11, 15, 18, 20, 47, 51 nến; timestamps milliseconds. Một attempt đi tới JEV có 47 nến/48 rows đầu vào, coverage 0.7833, `directionalHistory=UNKNOWN`; flow có đúng 1 observation. Đây là persisted production evidence, **không phải raw HTTP đầy đủ** và không chứng minh provider trả đủ 60 nến cho mọi token.

## E. Data Classification

| Nguồn/endpoint GMGN | Mức dữ liệu và mục đích | Field code thực đọc / phạm vi sử dụng |
|---|---|---|
| GET `/v1/market/rank` | LEVEL 1 + LEVEL 2; Trending discovery | `data.rank`/`rank`, address/symbol/name/creation_timestamp, price/volume/buys/sells/rank; metadata listing; interval đã chọn. Không phải chronological market series |
| GET `/v1/token/info` | LEVEL 1 + LEVEL 2; market/flow/risk | `price.price`, circulating_supply, decimals, liquidity hoặc pool.liquidity, usd_market_cap/market_cap, holder_count, creation_timestamp; `price.{price,volume,buy_volume,sell_volume,buys,sells}_{1m,5m,1h,6h,24h}` khi có; stat/dev/wallet_tags_stat |
| GET `/v1/token/security` | LEVEL 1; fresh controls/rug/tax | renounced_mint, renounced_freeze_account, is_honeypot, rug_ratio, buy_tax/sell_tax, top_10_holder_rate/creator_balance_rate và security metadata |
| GET `/v1/market/token_kline` | **LEVEL 3 OHLCV** | list[].time/open/high/low/close/volume; không đọc historical buy/sell/count/liquidity |
| GET `/v1/market/token_top_holders` | LEVEL 1; authoritative concentration | list[].address/addr_type/amount_percentage/maker_token_tags; top1/top10; không phải historical holders |
| GET `/v1/user/created_tokens` | Creator launch records, không phải market buckets của token | Optional creator history được giữ dạng evidence; gọi khi intelligence không authoritative. One-shot risk gọi authoritative nên không fetch creator history tại đây |
| GET `/v1/user/smartmoney` | Selected-wallet activity; Position monitoring | list[].base_address/side/timestamp/transaction_hash/amount_usd; chỉ lọc smart-money SELL kể từ entry; không reconstruct toàn thị trường trước discovery |
| POST `/v1/trenches` | LEVEL 1 + rolling feed; legacy discovery wrapper | new_creation/near_completion/pump/completed, address/created_timestamp hoặc creation_timestamp, symbol/name và listing risk/activity. Normal discovery hiện chỉ TRENDING |
| GET `/v1/user/wallet_holdings` | Wallet snapshot, không phải history | Wrapper holdings tồn tại; không có caller trong `src` hiện tại |
| GET `/v1/market/search`, GET `/v1/user/wallet_activity` | Chỉ có command trong allowlist | Không thấy call path trong source hiện tại; **không được tính là historical source đang dùng** |

Các route khác mà CLI dependency hỗ trợ không đồng nghĩa bot có dùng. Bot không dùng GMGN swap để reconstruct market history.

## F. Recent Market History Implementation

`parseMarketHistory`:

- `from=max(now−60m, candidate.createdAt ?? 0)`. Request wrapper luôn xin NOW−60m; clipping theo creation thực hiện sau response.
- Nhận `list` ở root hoặc `data.list`. `time>=10^12` coi là milliseconds, nhỏ hơn coi là seconds rồi nhân 1000. Giữ timestamps provider, sort tăng dần, dedup theo timestamp chính xác, tối đa 61 nến.
- Loại timestamp thiếu, trước requested range/creation, nến chưa đóng hoặc tương lai, OHLC thiếu/không hợp lệ/giá không dương. `volume` thiếu là null, không lấy token `amount` thay thế.
- Không interpolation, không rolling-window-to-timeline, không backfill, không zero padding. Trước creation là `NOT_AVAILABLE`. Nến provider thiếu vẫn thiếu.
- `tokenAge=now−createdAt` hoặc null; `requestedLookback=3600000`. `availableHistory` là tổng thời lượng các nến hợp lệ cắt theo target; không phải span từ nến đầu đến nến cuối. `historyCoverage=min(1,availableHistory/(now−from))`.
- `historyStartsAtCreation` chỉ kiểm tra nến đầu bắt đầu trong 60 giây sau creation; không chứng minh history không có lỗ hổng ở giữa.
- `status=AVAILABLE` khi có **ít nhất 2 nến**, không yêu cầu 60 phút, không ngưỡng coverage. Entry còn kiểm tra freshness và tail age.

Creation source: Trending `creation_timestamp` seconds (`src/gmgn.ts:144–164`); legacy trenches `created_timestamp ?? creation_timestamp`; nếu Candidate chưa có creation, Cheap Filter fallback `token/info.creation_timestamp*1000` (`src/one-shot-entry.ts:66`). Không dùng discovery time giả creation; thiếu tất cả thì tuổi unknown và target vẫn 60m. Đây là provider metadata, không phải timestamp mint được xác minh on-chain. Có `createdAt` rồi thì không đối chiếu lại với info mới. Không có unit auto-detection riêng cho creation timestamp như candle timestamps.

Freshness: `_gmgnSnapshot.fetchedAt` là **local request/cache completion**, không phải thời điểm provider publish từng giá trị. History TTL 0 buộc request mới (có thể join request đang bay cùng key), không dùng stale-cache fallback. Parser chỉ cần fetchedAt có số để gắn FRESH; không đọc metadata.freshness hoặc age. History gate kiểm tra `now−historyTo <= maxSnapshotAgeMs+60000` (default 45s+60s; chưa đọc strategy override để tuyên bố ngưỡng LIVE). Partial current minute bị bỏ nên coverage thấp hơn 100% vẫn bình thường. Provider delay vượt tail threshold bị reject; không đo được publish latency bên trong response.

FINAL_ANALYSIS không fetch lại history. Risk/pre-sign kiểm tra market/security/JEV/flow/structure timestamps nhưng không kiểm tra trực tiếp historyTo/coverage lần nữa. Tổng thời gian chờ JEV/holders/quote/probes có thể kéo dài khoảng cách từ candle evidence tới execution; không có một freshness bound riêng cho event absorption/defense/recovery.

## G. Capital Flow Evidence

**Combination D**: một current rolling directional snapshot (A) + provider OHLCV historical context (C); không lấy B từ attempts cũ.

`src/market-history.ts:139` gọi `normalizeFlowObservation(market,info)` rồi `deriveFlow([o])`, đúng **một** observation. Chọn window đầu tiên có đủ buy/sell volume trong 1m→5m→1h→6h→24h; nếu thiếu volume thì thử count/total-volume cho normalization, nhưng attempt READY vẫn yêu cầu cả buyVolume và sellVolume, price, liquidity, history AVAILABLE.

Net flow=buyVolume−sellVolume; pressure=buy/(buy+sell); momentum được thay bằng current price / historical first.open −1. Không biết sell pressure của từng nến. Acceleration/slope/change/liquidity growth giữ null vì không có observation thứ 2/3. `quality.observations=1`, `missing` ghi historicalDirectionalVolume/flowAcceleration, confidence cố định 0.55 khi ready. `spanMs=h.availableHistory` là OHLCV duration, **không phải span directional observations**.

`deriveFlow` chung (`src/capital-flow.ts:191`) tính slope/acceleration từ nhiều snapshot cùng window theo timestamp thật khi Position collector tích lũy. Nó không xếp 1m/5m/1h tại cùng NOW thành t1/t2/t3. Dù có nhiều observations, đó vẫn là biến thiên của rolling totals, không phải volume mới trong từng bucket. Candidate one-shot không sử dụng chuỗi collector này.

`CAPITAL_FLOW: PASS` chỉ nghĩa đủ input để tính regime, không có nghĩa bullish: runtime sample regime OUTFLOW vẫn có quality READY và đi tới JEV. Structure yêu cầu net>0 và buyPressure>0.5 sau đó.

## H. Structure Evidence

Thuật toán thật ở `src/market-history.ts:180–264`:

| Kết luận | Predicate thực tế | Đánh giá bằng chứng |
|---|---|---|
| Selling | Nến đỏ close<open và total volume>0. Ghi sell/low mới; reset các flag tiếp theo | **INFERRED**. Proven downward price bar; không biết seller-initiated volume/count/net flow |
| Absorption | Nến sau sell, volume>0, close>open và close>tracked low.close | **INFERRED — ABSORPTION NOT FULLY EVIDENCED**. Không so “sell pressure vẫn mạnh nhưng downside yếu đi”; không historical sell pressure |
| Buyer Defense | Sau absorption, low>=previous.low và close>=previous.close; volume>0 trong outer branch | **INFERRED**. Có higher/non-decreasing low/close; không đo buyer activity tăng, repeated defense strength hay historical liquidity |
| Recovery | Sau defense, close>sell.open | **INFERRED** cho recovery thị trường; **PROVEN chỉ cho việc giá vượt open nến đỏ tham chiếu**. Không yêu cầu buyer flow tiếp diễn ở từng bước |
| Current momentum | last.close>=before.close và current price>=last.close | Proxy giá không giảm, cho phép cả bằng nhau; không chứng minh acceleration |

Nến mới lệch nến trước khác 60000ms reset chuỗi; nến đỏ volume>0 reset selling/absorption/defense/recovery. FlowSupports chỉ dựa rolling snapshot hiện tại. Passed yêu cầu cả năm boolean và FlowSupports. Không có predicate “liquidity remained healthy during recovery”; không tìm thấy claim đó trong one-shot basis. Liquidity hiện tại được Cheap/Risk kiểm tra riêng.

## I. Temporal Ordering

**Có ordering của proxy giá:** sell.at < absorptionAt < defenseAt < recovery candle.at, trên chuỗi nến liền phút. Không phải mọi flag được gắn cùng NOW không có timestamp đầu vào.

**TEMPORAL ORDER NOT PROVEN cho chuỗi cung/cầu thực.** OHLC không cho thứ tự buy/sell bên trong từng phút; không có timestamps của historical sell/buy pressure. Các timestamp pha còn không được trả ra trong structure result, chỉ giữ booleans và `at=market.at`; độ mới của snapshot dễ bị nhầm với độ mới của sequence.

## J. 60-Minute Lookback

Có request một giờ trước khi discovery, độc lập việc bot đã quan sát token chưa. Có thể lấy ~60 nến nếu provider có và trả đủ; code không có pagination hay kiểm tra expected candle count để đảm bảo full hour. Runtime sample coverage 18.33%–85%, có gaps/tail cũ. HISTORY có thể PASS với coverage thấp nếu ít nhất 2 nến và tail đủ mới. Structure còn cần ít nhất chuỗi proxy liên tục đủ các bước (thông thường tối thiểu 4 nến).

Do đó log “24m available / 60m lookback” nghĩa 24 phút nến hợp lệ trong khoảng request, **không phải bot phải chạy chờ thêm 36 phút**. `INSUFFICIENT_MARKET_HISTORY` có thể do rows không đủ, timestamp/OHLC invalid, freshness unknown hoặc tail quá cũ. `INSUFFICIENT_STRUCTURE_EVIDENCE` nghĩa các predicate/flowSupports chưa đủ, kể cả HISTORY đã PASS.

## K. Young Token

Token 15m: request vẫn 60m; chỉ giữ nến sau creation và đã đóng. Không tạo 45 phút zero. Nến creation minute bắt đầu trước creation sẽ bị loại; current minute cũng bị loại, provider có thể thưa dữ liệu. Vì vậy **không bảo đảm toàn bộ 15 phút**. Nếu đúng 15 nến đóng, creation căn phút và provider đủ, fixture đạt 15m/15m, coverage1; trong thực tế đây là khả năng có điều kiện.

## L. Fresh Attempt #2

`CandidateAttempts.begin` (`src/candidate-attempt.ts:139`) tạo UUID/stages/summaries/logs mới; `oneShotEntry` dùng biến local. `Engine.analyze` (`src/engine.ts:648`) luôn bắt đầu mới và `finally` gọi finish. `CandidateLifecycle.finish` (`src/candidate-lifecycle.ts:119`) xóa lifecycle và candidate_flow_states của mint. Appearance mới dựa provider seen_at mới và watermark, không phải timer retry của verdict cũ.

Attempt #2 fetch info/security/history mới (TTL0), tính flow/structure/Risk mới; `Jev.decide(input,true)` bỏ decision cache. Không đọc old JEV/Risk/Structure/reject verdict để phê duyệt/veto. Persistent ownership, durable signed/pending execution và authority revision vẫn là gate cần giữ; đó không phải reuse đánh giá cũ.

`candidate_flow_states` **vẫn tồn tại** trong schema, `observeCandidate` vẫn có khả năng đọc/ghi, legacy SniperStructure.admit và FlowView vẫn đọc. Search production `src` không thấy caller `observeCandidate` từ entry hiện tại; `observeStructureWatches()` là no-op; oneShotEntry không đọc legacy state. FlowView có thể trình bày record legacy, nhưng không cấp authority one-shot. CandidateAttempts constructor có đọc attempt cũ cho crash audit/reconciliation, không lấy nó làm approval của begin mới.

## M. Scenario A–E Results

| Scenario | Kết quả | Evidence/giới hạn |
|---|---|---|
| A: token4h, lần đầu discovery, 60m trước đó | **PARTIAL** | YES đường fetch chronology OHLCV pre-discovery; không đảm bảo đủ 60m, không directional/liquidity timeline |
| B: token15m, creation→NOW | **PARTIAL** | Có actual completed candles trong lifetime; không padding, không bảo đảm creation/current partial minute và provider gaps |
| C: reject10:00, Trending mới10:05 | **YES** cho fresh fetch độc lập verdict cũ | Request09:05→10:05, parse theo creation; UUID/locals mới, TTL0, JEV fresh. Full response completeness vẫn có điều kiện |
| D: full sequence09:48→09:57, discovery10:00 | **PARTIAL** | Reconstruct chronological price bars/proxies nếu provider đủ; không chứng minh historical selling→absorption theo directional flow/liquidity |
| E: snapshot đẹp sau distribution/dump/short bounce | **PARTIAL** | Thấy OHLCV pump/dump trong lookback; predicate đòi bounce vượt sell.open. Tuy nhiên không có robust distribution classification hoặc directional confirmation; short bounce vẫn có thể thỏa proxy. Không bảo đảm phân biệt genuine recovery |

## N. Data Sufficiency Matrix

YES ở đây là source/code có capability khi field có; không phải SLA cho mọi token. PARTIAL là coverage/semantic limitation.

| Capability | YES | PARTIAL | NO | Source | Evidence |
|---|:---:|:---:|:---:|---|---|
| Current price | ✓ | | | token/info | price.price |
| Current liquidity | ✓ | | | token/info | liquidity hoặc pool.liquidity |
| 1m aggregate | ✓ | | | token/info | price.*_1m nếu provider có |
| 5m aggregate | ✓ | | | token/info | price.*_5m nếu provider có |
| 1h aggregate | ✓ | | | token/info | price.*_1h nếu provider có |
| Historical price60m | | ✓ | | token_kline | real timestamps/OHLC; coverage không bảo đảm |
| Historical OHLCV60m | | ✓ | | token_kline | real bars, total USD volume; có missing/gaps |
| Historical buy volume | | | ✓ | Không được fetch/map | directionalHistory UNKNOWN |
| Historical sell volume | | | ✓ | Không được fetch/map | total candle volume không chia side |
| Historical buy count | | | ✓ | Không được fetch/map | current rolling buys không là series |
| Historical sell count | | | ✓ | Không được fetch/map | current rolling sells không là series |
| Historical liquidity | | | ✓ | Không được fetch/map | chỉ liquidity_now cho entry |
| Raw trade timeline | | | ✓ | Không có full-market raw swaps trong entry | smartmoney subset/own receipts không thay thế |
| Temporal ordering | | ✓ | | candles.at | ordered price proxies; actual flow phases chưa chứng minh |
| Selling detection | | ✓ | | red bar + volume | INFERRED |
| Absorption detection | | ✓ | | green response after red | INFERRED, không có sustained sells/downside response |
| Buyer Defense detection | | ✓ | | non-decreasing low/close | INFERRED |
| Recovery detection | | ✓ | | close>sell.open + current flow | INFERRED |
| Full pre-discovery reconstruction | | ✓ | | OHLCV | price chronology có, full orderflow sequence không |

## O. Findings

**Không xác nhận CRITICAL zero-padding, synthetic rolling history hoặc reuse old verdict trong production one-shot path.** Các HIGH bên dưới có thể làm structure gate chấp nhận proxy yếu; chưa chứng minh transaction thực đã xảy ra vì các gate khác vẫn tồn tại.

| ID | Severity | File/line | Finding và tác động |
|---|---|---|---|
| H1 | HIGH | `src/market-history.ts:208–264` | `selling/absorption/buyerDefense/recovery` và `ONE_SHOT_BUYER_DEFENSE_CONFIRMED` dựa total-volume OHLCV + current flow, không có historical directional evidence. “Absorption” thực chất bullish price response, không kiểm sustained selling với downside giảm |
| H2 | HIGH | `src/market-history.ts:195–258` | Phase flags không có max-age. Sau recovery, nhiều nến đi ngang vẫn giữ flags; momentum cho phép bằng nhau. Return `at=market.at` làm sequence cũ được trình bày như fresh structure. Risk chỉ kiểm timestamp result nên không phát hiện tuổi pha |
| M1 | MEDIUM | `src/market-history.ts:135`, `src/one-shot-entry.ts:148` | HISTORY AVAILABLE/PASS không có ngưỡng coverage; 2 nến đủ HISTORY, 4 nến có thể đủ structure cho token4h. Đây là thiếu policy về data sufficiency, không phải parser tạo dữ liệu giả; 60m request không bảo đảm full60m evidence |
| M2 | MEDIUM | `src/market-history.ts:109–123` | FRESH chỉ cần fetchedAt số, bỏ qua freshness/age/future của metadata. Production TTL0 coordinator hiện giảm rủi ro này; counterexample là parser contract weakness, không khẳng định stale-cache exploit đang xảy ra |
| M3 | MEDIUM | `src/one-shot-entry.ts:249–301,333–339`, `src/risk.ts:93–105` | Final/pre-sign không refetch hoặc trực tiếp recheck age/tail history; structure timestamp mới kế thừa market trong khi dùng history cũ. Evidence event time và fetch time chưa tách rõ |
| L1 | LOW | `src/market-history.ts:164–175` | quality READY/confidence0.55/spanMs lịch sử nhưng chỉ1 directional observation. Basis/missing đã nói rõ limitation; consumer chỉ xem READY/span có thể hiểu nhầm |
| L2 | LOW | `src/one-shot-entry.ts:169–190,242` | JEV input không có precomputed Structure vì stage chạy sau; đây là mismatch nếu tài liệu/UI nói JEV đã xem final Structure verdict. JEV có raw normalized candles, không chỉ labels |

Bổ sung boundary: parser dedup exact timestamp, không kiểm candle căn phút hoặc hợp nhất overlapping intervals; coverage là tổng clipped durations rồi cap1. Provider bars đúng chuẩn1m thì phù hợp; nếu payload lệch/overlap, coverage có thể bị phóng đại. Không có runtime evidence hiện tại cho malformed overlapping bars; chưa nâng thành finding production độc lập.

## P. False Confidence Findings / Reproduction

Đã gọi **chỉ** parseMarketHistory/oneShotStructure qua stdin Node+tsx, không instantiate Engine/Store/Gmgn. Không ghi source/test mới. Đây là algorithm counterexamples, không phải provider availability test.

1. Token4h, chỉ4 nến liền phút: đỏ10→9, xanh9→9.3, xanh9.3→9.6, xanh9.6→10.1; total volume=1 mỗi nến; current price10.1; current netFlow1/pressure0.75. Kết quả `availableHistory=240000`, `historyCoverage=0.0666667`, `status=AVAILABLE`, `directionalHistory=UNKNOWN`, cả5 evidence true, `passed=true`, reason CONFIRMED. **H1/M1**. Không cần một field historical buy/sell nào.
2. Chuỗi4 nến tương tự ở đầu60m rồi56 nến flat10.1, current flow positive: cả5 evidence vẫn true, reason CONFIRMED. Không refresh thời điểm buyer defense; chỉ result.at mới. **H2**.
3. Recent candle payload nhưng `_gmgnSnapshot.fetchedAt=now−1day`, `freshness=STALE`: parser trả freshness FRESH. **M2**, production coordinator TTL0 hiện thường cung cấp timestamp local mới nên không coi đây là bằng chứng stale provider response được chấp nhận ngoài đời.

Không có literal `historyCoverage=1` được gán mù trong production: giá trị được tính. Các test coverage1 dùng đầy đủ bars căn phút; không được dùng kết quả đó làm bằng chứng coverage1 của production.

## Q. Production vs Tests

`tests/one-shot-fixtures.ts:21` tạo các nến tổng hợp có sẵn đúng red→green→higher-low→recovery, volume1000; JEV/transport có mock. Chứng minh thuật toán xử lý được shape được dựng, không chứng minh provider có đủ timeline hay absorption thật.

`tests/one-shot.test.ts:85` chứa một bar shape được tài liệu ghi đã capture thật; các timestamp/bar tiếp theo được lặp để kiểm parser, không phải ba giao dịch thật. Có tests seconds/milliseconds, malformed bars, young-token clipping, missing-volume/gaps. Có Fresh Attempt isolation test; static call chain đồng ý kết luận đó.

Runtime SQLite sample hiện tại bổ sung production evidence về **OHLCV timestamps/gaps/coverage** và **one current directional observation**. Không có raw directional historical series tương đương trong production. Không chạy toàn bộ test suite trong phase audit: không cần để chứng minh source provider, tránh các fixture Engine/execution vượt phạm vi chỉ đọc.

## R. Recommended Options — không implement

| Option | Chất lượng/resolution | Latency/cost/rate limit | Complexity / one-shot fit |
|---|---|---|---|
| A. Giữ GMGN K-line, định nghĩa rõ coverage/tail/phase age và downgrade CONFIRMED→INFERRED | Honest OHLCV1m price proxy; vẫn thiếu actual orderflow | Không thêm call nếu chỉ semantic/policy; re-fetch history cuối pipeline sẽ thêm request. Không xác minh giá plan hiện tại | Thấp–vừa; phù hợp one-shot proxy có giới hạn |
| B. Đánh giá historical endpoint provider hiện có cho directional buckets | Cần chứng minh field buy/sell/count/time, không suy từ tên endpoint | Chưa xác minh endpoint/plan/giá. Ít nhất thêm historical read nếu có; pagination tăng budget | Vừa; tốt cho one-shot nếu trả toàn lookback trong budget |
| C. Historical trades/swaps indexer, phân side/quote units, gom bucket | Có thể cung cấp true directional chronology và intraminute order; vẫn cần kiểm pool coverage/side semantics | Nhiều page ở token đông trade; latency/request cost/rate pressure cao hơn, cần đo thực | Cao; one-shot chỉ phù hợp nếu indexed query bounded đủ nhanh |
| D. OHLCV + directional time buckets + liquidity snapshots | Tốt hơn cho selling→absorption→defense, vẫn là inference về chủ ý người mua | Nhiều nguồn/call, đồng bộ timestamps/units, giới hạn time budget; chưa có con số giá đáng tin | Vừa–cao; phù hợp nếu pre-indexed, không chờ bot tự tích lũy |
| E. OHLCV độ phân giải nhỏ hơn | Thêm price detail1s/30s nếu endpoint/plan hỗ trợ; không tự tạo historical side/liquidity | Nhiều rows hơn, có thể plan cao hơn; cost/latency chưa đo | Vừa; bổ sung, không thay thế directional evidence |

Mọi lựa chọn cần benchmark và approval riêng nếu thay logic/provider; audit này không cài package, thêm fallback/provider hoặc sửa threshold.

## S. Files Inspected

`src/market-history.ts`, `src/one-shot-entry.ts`, `src/candidate-attempt.ts`, `src/candidate-lifecycle.ts`, `src/engine.ts`, `src/discovery.ts`, `src/store.ts`, `src/gmgn.ts`, `src/gmgn-coordinator.ts`, `src/capital-flow.ts`, `src/jev.ts`, `src/risk.ts`, `src/position-collector.ts`, `src/solana.ts`, `src/execution-provider.ts`, `src/sniper-structure.ts`, `src/flow-view.ts`, `src/config.ts`; relevant searches over `src`, `tests`, dependency CLI. Read `tests/one-shot.test.ts`, `tests/one-shot-fixtures.ts`; supporting `docs/one-shot-implementation.md`, `docs/history-parser-fix.md`. CLI `commands/market.js`, `client/OpenApiClient.js`, `config.js`, `output.js`.

Solana RPC: wallet SOL balance, parsed token accounts/ownership, mint program/authority/extensions, specific execution receipts/deltas, simulation/confirmation. Không có full-market signature crawling/indexer/time-bucket reconstruction trong entry. Own receipt BUY/SELL classification không phải lịch sử toàn thị trường.

Jupiter: GET `https://api.jup.ag/swap/v2/order` cho quote/routes/entry/exit feasibility; POST `/swap/v2/execute` cho execution; RPC simulation. Không cung cấp history cho pipeline hiện tại.

Trading Memory/Human Experience: fresh entry input không có historicalExperience/human experience/reject history. `Jev.decide` giữ candle timestamps bằng structuredClone cho one-shot, request forced fresh; instructions Memory disabled, historical assessment UNAVAILABLE/strength NONE. Position monitoring vẫn có memory.observe phục vụ hậu kiểm; không được hiểu là Memory bị xóa toàn ứng dụng.

Provider failure: CLI timeout20s, invalid JSON/auth/rate/plan errors propagate; plan upgrade branch ghi history unavailable rồi reject HISTORY_SOURCE_UNAVAILABLE. Sau capability bị đánh dấu unavailable, `run` có thể ném GMGN_PLAN_UPGRADE_REQUIRED trực tiếp trước wrapper, nên reason quan sát có thể khác nhánh mapping; vẫn không tiếp tục BUY. Empty/malformed/stale tail reject. Engine ends attempt, cleanup trong finally; GMGN cooldown/incident policy có thể hoãn các read kế tiếp hoặc system-scope failure halt theo chính sách. Không fabricate history, không tạo candidate Watch, không giữ old verdict để bypass failure.

## T. Safety Confirmation

Tách hai phase rõ ràng: UI Log trước audit có sửa `public/*` và thêm browser test/report/screenshots; backend/config/.env/package/lock có hash giống baseline trước UI. **Trong phase historical audit:**

```text
source modified: NO (bao gồm public sau khi chốt Log)
.env modified: NO
API key modified: NO
process restarted: NO
LIVE killed: NO
DB migration: NO
DB writes by audit: NO
real BUY: NO
real SELL: NO
transaction submitted by audit: NO
provider calls by audit: NO
package installed: NO
```

Chỉ thêm report/evidence trong docs. Hash baseline audit: [historical-audit-integrity.json](historical-audit-integrity.json); runtime sample đã bỏ token/attempt identity không cần thiết. LIVE tự hoạt động có thể tiếp tục cập nhật DB; không tuyên bố DB bất biến khi bot đang chạy.

## 7 câu trả lời bắt buộc

1. **Q1:** GMGN OpenAPI GET `https://openapi.gmgn.ai/v1/market/token_kline`, qua installed gmgn-cli `market kline`, resolution1m, requested60m. Sections C/D.
2. **Q2:** Combination LEVEL3 OHLCV + LEVEL1 snapshot + LEVEL2 rolling buy/sell aggregates. Không có LEVEL3 directional/liquidity trong entry. Sections E/G.
3. **Q3:** **Có khả năng fetch chronological OHLCV60m trước discovery**, không đảm bảo đủ60m cho mọi token và không reconstruct full orderflow. Kết luận scenario A **PARTIAL**.
4. **Q4:** **Có khả năng fetch actual completed bars trong15m lifetime**, không bảo đảm toàn bộ creation→NOW; không padding. **PARTIAL**.
5. **Q5:** Chứng minh được thứ tự price proxies; full SELLING→ABSORPTION→BUYER DEFENSE→RECOVERY là **INFERRED**, actual directional temporal order chưa được chứng minh. Sections H/I/P.
6. **Q6:** **YES**, appearance mới fetch provider history mới không phụ thuộc old candidate evaluation verdict; persistent ownership/pending execution guards vẫn giữ. Section L.
7. **Q7:** **PARTIALLY READY** cho kiến trúc yêu cầu full buyer-recovery evidence: có historical OHLCV thật, thiếu historical orderflow/liquidity và có overclaim/stale phase flags. Chưa đủ cơ sở gắn READY cho việc chứng minh đầy đủ sequence.
