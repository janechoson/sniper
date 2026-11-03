# BOT B — One-shot candidate, Position collector và Overview

Ngày: 2026-11-01 · Asia/Bangkok. Thay đổi được triển khai trên project hiện có; không đổi wallet, signer, `.env`, dependency hay chính sách kích thước BUY.

## A. Audit trước sửa

Audit được ghi trước implementation tại [one-shot-audit.md](one-shot-audit.md).

- GMGN Trending đi qua `DiscoveryCoordinator.pollSource` → `Gmgn.trending` → SQLite tokens → `CandidateLifecycle.refill`.
- Candidate cũ lưu WATCH/STRUCTURE_WATCH/DEFERRED, failure count và lịch recheck. Engine dùng structure state cũ, admission PRE_WATCH rồi chờ buyer-defense trong Watch. `candidate_flow_states` giữ observations qua nhiều lần phân tích.
- BUY JEV cũ nhận `TradingMemory.jevContext`. Chưa có historical candles target 60 phút.
- Position có timer riêng và JEV queue bất đồng bộ, nhưng collector `for...of await` và GMGN coordinator đều chờ từng request hoàn tất. Một provider request chậm trì hoãn các vị thế sau.
- UI cũ dùng vanilla JS, sidebar, sơ đồ pipe/tank; SSE full status 5 giây và flow frame 1 giây. SQLite đã có positions, executions, intents, manual exits, observations và Trading Memory.

## B. Những gì đã sửa

| File | Thay đổi |
| --- | --- |
| `src/candidate-attempt.ts` | UUID attempt, 17 stage, trạng thái thật, audit có giới hạn, event subscription, xử lý audit sau crash/reconciliation. |
| `src/candidate-lifecycle.ts` | Queue từ appearance đã nhận; không Watch/Deferred/retry. Cleanup sau attempt; legacy API không tạo Watch. |
| `src/one-shot-entry.ts` | Pipeline mới, dữ liệu fresh, JEV không Memory, deterministic Risk, structure một lượt, final refresh và executor hiện có. |
| `src/market-history.ts` | Parse nến 1m, metadata 60m/coverage, không padding; current Capital Flow và chronological structure evidence. |
| `src/discovery.ts` | Lưu riêng mỗi appearance; backpressure source khi queue đang đầy để không bỏ appearance hoặc tích backlog vô hạn. |
| `src/gmgn.ts`, `src/gmgn-coordinator.ts` | Read-only K-line qua CLI hiện có; giới hạn concurrency và giữ khoảng cách giữa các lần bắt đầu request, cache/coalescing/cooldown. |
| `src/position-collector.ts` | Bounded collection, một job cho mỗi Position; request chậm không khóa các job khác. |
| `src/engine.ts` | Scanner/collector/JEV độc lập; metadata revision/freshness; kiểm tra stale tại apply và sát pre-sign SELL; manual → security → JEV. Ngừng candidate Watch observation/expiry timers. |
| `src/jev-exit-scheduler.ts` | Clone job và input snapshot để dữ liệu collector cập nhật không sửa input đang phân tích. |
| `src/jev.ts` | Giữ timestamp của nến trong one-shot request; câu hỏi xác định Memory bị tắt. |
| `src/risk.ts`, `src/domain.ts`, `src/capital-flow.ts` | Authority `TRENDING_ONE_SHOT_V1`, kiểm tra structure/flow fresh, các kiểu revision và tái sử dụng flow classifier. |
| `src/executor.ts` | Phát progress ở ranh giới quote/exit/validation/simulation/pre-sign/BUY thật. Không nới validator. |
| `src/store.ts` | Schema mới, appearance watermark, duplicate guard dựa ownership/execution thực tế và revision của Position. Lịch sử position đã đóng không trở thành veto scoring cho attempt mới. |
| `src/config.ts` | Concurrency collector/GMGN; config cũ vẫn parse được. |
| `src/server.ts` | SSE Overview riêng, đẩy stage event ngay; snapshot Position không phải chờ full status/balance RPC. |
| `public/index.html`, `public/style.css`, `public/app.js`, `public/flow.js` | Overview theo mockup, top navigation, scanner, ba panel, Action Log, bảng Positions. Không mount animation pipe/tank cũ. Giữ translation và các tab chức năng. Operator controls chuyển vào Cấu hình, dùng handler cũ. |
| `scripts/reset-strategy-data.ts` | Nhận biết bảng mới và watermark trong maintenance; không chạy reset dữ liệu thật. |
| `tests/one-shot.test.ts`, `tests/one-shot-fixtures.ts` | History, freshness, duplicate, cleanup, concurrency, stale JEV và mock Jupiter end-to-end. |
| Các test Candidate/Flow/Normal Live/Trending/Recovery/V51/V52/JEV exit | Cập nhật contract đã bỏ Watch/Deferred và hierarchy manual. Giữ các kiểm tra safety tương ứng. |
| `scripts/one-shot-ui.mjs`, `scripts/ui-test.mjs` | Browser contract mới và bộ test Positions/History hiện có; chỉ server paper tạm. |

Các test Watch/bypass đã thay contract có bản nguồn cũ tại `data/backups/one-shot-tests/`. Không dùng skip để làm xanh test.

## C. Candidate flow mới

```text
GMGN Trending fetch
  -> persist appearance (mode, mint, provider fetchedAt)
  -> queue -> Fresh Attempt UUID
  -> Cheap Filter (identity / active ownership / durable duplicate / market)
  -> Fresh Security
  -> Token Compatibility [SKIPPED trong paper]
  -> GMGN 1m K-line: requested lookback 60m
  -> Current Capital Flow + objective history
  -> Fresh JEV BUY [không trade memory / reject history]
  -> Risk QUALIFICATION
  -> One-Shot Structure
  -> Fresh Final Analysis: market/security/holders/flow/compatibility/Risk
  -> Capital + Ownership -> fresh intent
  -> Jupiter BUY quote + route validation
  -> Pre-BUY SELL route probes 20% / 50% / 100%
  -> validation -> simulation -> final capital/ownership/Risk
  -> immediate pre-sign check
  -> sign -> durable signature -> submit -> confirm -> reconcile
  -> Position OPEN

FAIL -> exact stage/reason -> terminal audit -> cleanup -> next token
Signed UNKNOWN -> RECONCILING, không gắn BUY PASS, không replay
```

Mỗi appearance thực sự lấy từ provider được lưu riêng. Khi queue đầy, source polling chờ queue drain; không bỏ các appearance đã nhận và không giữ token để chờ market recovery. Cache của cùng một feed snapshot không được tính là appearance mới.

Các trạng thái stage là PENDING/CHECKING/PASS/FAIL/SKIPPED. Paper không đánh dấu PASS cho RPC compatibility, quote, exit probe, simulation hoặc pre-sign chưa chạy.

## D. Position flow mới

```text
Independent monitor timer
  -> PositionCollector [bounded, per-position ownership]
  -> GMGN scheduler [priority / start spacing / bounded concurrent reads]
  -> market/security/value/PnL/MFE/MAE/flow/revisions
  -> Position State Store
       +-> Overview SSE / Positions UI
       +-> event detector / scheduled re-evaluation
            -> immutable scoped snapshot
            -> bounded JevExitScheduler
            -> identity/quantity/revision/flow/age/material market checks
            -> strategic exit opportunity

USER MANUAL / EMERGENCY
  -> SECURITY CRITICAL / protective exit
  -> JEV strategic exit
  -> existing safe SELL executor
  -> fresh quote -> validation -> simulation -> immediate pre-sign check
  -> durable signature -> submit -> confirm -> actual quantity reconciliation
```

Manual partial được thực hiện đúng trước. Nếu có critical security, exit cho phần còn lại vẫn được giữ và xử lý tiếp, không đợi JEV. Không thêm stop-loss hay take-profit phần trăm.

## E. History 60m

- Source: `gmgn-cli` đã cài, `market kline --chain sol --resolution 1m --from ... --to ...`, endpoint CLI `/v1/market/token_kline`.
- Mỗi attempt fetch fresh với requested lookback 3.600.000 ms. CLI nhận from/to theo Unix seconds. Response thực tế của GMGN trả candle `time` theo milliseconds; parser giữ nguyên milliseconds và cũng hỗ trợ response seconds cũ.
- Đã đối chiếu response LIVE ngày 2026-11-01: `volume` là USD volume, `amount` là token units. Parser dùng `volume`, không thay bằng `amount` khi thiếu. Phần mô tả đơn vị trước đây dựa trên bảng tài liệu CLI không khớp response thực tế và đã được sửa; xem [history-parser-fix.md](history-parser-fix.md).
- Token 15 phút dùng những nến thực sau creation. Nến trước creation, nến chưa đóng, malformed/zero-price và nến tương lai không được dùng. Không thêm row zero để lấp lịch sử.
- Metadata có tokenAge, requestedLookback, availableHistory, historyCoverage, historyStartsAtCreation, historyFrom/historyTo, source, fetchedAt, freshness, preCreation=NOT_AVAILABLE và directionalHistory=UNKNOWN. Duration dùng milliseconds.
- Missing history → INSUFFICIENT_MARKET_HISTORY/OUT. K-line capability thiếu do plan → HISTORY_SOURCE_UNAVAILABLE/OUT, không tự pause cả bot chỉ vì tính năng history không có.
- Structure dùng thứ tự price-response trong các nến liên tục: selling-price response, absorption, defense, recovery, momentum, cộng directional flow hiện tại. Không thêm ngưỡng drop % mới.

## F. Reject cleanup

Xóa row temporary `candidate_lifecycle` và `candidate_flow_states`, giải phóng `analyzing`/`stages` ownership; các local buffer rời scope khi attempt kết thúc. Không tạo per-candidate timer, listener, Watch hay deferred recheck. Candidate stages chạy tuần tự nên không để lại nhánh collection nền sau khi OUT.

Audit là sink, không được đọc lại làm authority/scoring. History nến được fetch lại như objective data. Transaction đã có chữ ký là ngoại lệ: Executor tiếp tục reconcile; không replay BUY/SELL UNKNOWN.

## G. Position latency

- Trước: await tuần tự từng Position và từng GMGN request.
- Sau: `positionCollectorConcurrency` mặc định 4 (1–8), `gmgnReadConcurrency` mặc định 3 (1–4), giữ `gmgnRequestIntervalMs` và cooldown. Position monitor dùng priority cao hơn candidate analysis.
- `jevExitConcurrency`/queue giữ configurable; input clone, không giữ lock của collector.
- Timer collection hiện có là 5 giây; throttle observation/value hiện có 15 giây vẫn được giữ. Đây không phải cam kết tick-by-tick hoặc latency dưới một giây.
- Deadline transport hiện có: GMGN CLI child 20 giây, HTTP/RPC 15 giây mỗi request; queue/rate-limit có thể cộng thêm thời gian. Một request chậm chiếm một slot, không giữ toàn bộ collector. Error được cô lập theo Position; global provider outage/reconciliation ambiguity vẫn có thể pause NEW BUY.
- Test có blocked candidate request, blocked Position A, JEV pending và Position B tiếp tục cập nhật. Không suy diễn kết quả fixture thành benchmark production.

## H. UI

Desktop tái tạo vị trí và tỷ lệ chính của mockup: navigation ở trên, carousel bên trái Action Log, Current Token/Evaluation/Result bên dưới, Positions toàn chiều ngang; dark/neon/border/glow tương ứng. Responsive chuyển thành stack ở viewport nhỏ.

Token giữa dùng attemptId/mint backend. PASS và BUY không được sinh bằng timer frontend; log lấy từ attempt events. SELL 50%/100% dùng `/api/exit` và safe flow cũ, có confirmation. Position frames độc lập với JEV và animation.

Logo dùng initials fallback khi không có asset. Metric thiếu hiển thị N/A; paper hiển thị PAPER. Không có countdown BUY giả. Các tab Positions, History, Trading Memory, Settings giữ chức năng; không thêm Human Experience.

Preview tại `data/one-shot-overview-approved.png`, `data/one-shot-overview-rejected.png`, `data/one-shot-overview-mobile.png`. Đây là dữ liệu browser fixture/paper, không phải lệnh LIVE.

## I. Database/Migration

Migration 11 dùng CREATE IF NOT EXISTS và không đổi schema Positions/trades/history:

- `candidate_attempts`: UUID, mode, mint, started_at, result, failed_stage, bounded payload; indexes mode/mint/time và mode/result/time.
- `trending_appearances`: unique mode/mint/seen_at, consumed flag, queue index.
- Giữ tối đa 2.000 terminal attempt audits và 2.000 consumed appearances. Giới hạn 100 action logs mỗi attempt và 61 nến. Attempt event/input logs mới có retention riêng. Watermark ngăn feed cũ được enqueue lại sau retention.
- Backpressure trước lần fetch tiếp theo giới hạn backlog theo queue threshold cộng tối đa một feed batch; không thêm max-open-positions.
- Legacy Watch tables và Trading Memory vẫn còn để đọc lịch sử; không tham gia entry decision. Watch/deferred settings vẫn parse và được ghi rõ legacy trong UI.

Không migrate/reset DB LIVE trong phiên này. Schema mới sẽ được áp dụng khi runtime mới mở DB.

## J. Tests

Kết quả cuối: **302/302 tests pass; 0 fail, 0 cancelled, 0 skipped. Typecheck, lint, build và browser checks đều PASS.** Artifact: `data/one-shot-verification.json`.

Build ID: `0941a8b5b6247a270296974a73e48466b4c2b1a0d1b09aabf68c98c531b232d0`; hash source hiện tại khớp build.

- Unit + integration: `pnpm test`; bao gồm production-path mock Jupiter với quote/probe/simulation/pre-sign/reconcile, không dùng signer thật.
- Typecheck: `pnpm typecheck`.
- Lint: `pnpm lint`.
- Build + browser: `pnpm test:ui` (script build của project chạy trước browser).
- Browser suites: Overview, Positions, History, Settings; bộ Positions hiện có kiểm tra 1/3/10/20 vị thế, partial PnL, attention, UNKNOWN, confirmation/cancel, responsive và reduced motion.

Log: `data/one-shot-all-tests.log`, `one-shot-typecheck.log`, `one-shot-lint.log`, `one-shot-ui.log`, `one-shot-ui-results.json`.

## K. Known limitations

1. GMGN OHLCV không cung cấp historical directional buy/sell trong schema đang dùng. Nến đỏ/xanh là price-response proxy, không chứng minh lịch sử chuyển vốn hoặc mọi hành vi buyer/seller. Các acceleration/trend không có source vẫn UNKNOWN.
2. Fetch-time FRESH chứng minh wrapper vừa lấy response; không bảo đảm provider có toàn bộ trade hoặc dữ liệu nội bộ tức thời. Missing/gap/incomplete candles được giữ rõ bằng coverage; source thiếu không trở thành SAFE.
3. Token rất trẻ có thể thiếu nến đóng hoặc sequence evidence và OUT vì thiếu evidence, không phải vì một rule tuổi token phải đủ 60 phút.
4. Provider rate limit, plan và liquidity thực có thể khiến candidate OUT. Quote/route feasibility trước BUY không bảo đảm market sẽ còn route khi SELL; actual SELL luôn quote fresh.
5. Chưa chứng minh performance/route/signer trên mạng LIVE. Unit/integration dùng mock, browser dùng paper DB riêng. Không có synthetic trade được dùng làm bằng chứng một swap thật sẽ thành công.
6. Shell Node hiện tại là 20; project yêu cầu >=22.13 và commands dùng Node 22.22.0 được cài trong dependency. pnpm in engine warning về shell; các test/build thực tế dùng Node hỗ trợ SQLite.

## L. LIVE STATUS

- Không restart/stop tiến trình operator. Chỉ khởi chạy rồi dừng các server paper tạm của browser tests.
- Có build mới trong `dist`; phiên này không nạp/deploy build vào LIVE.
- Read-only GET vào cổng local 3000 không kết nối được tại lúc kiểm tra. Vì vậy không xác nhận LIVE backend đang chạy bản mới.
- Không real BUY/SELL hoặc real signing để verification. Các mock đặt mode=live chỉ trong process test; RPC/Jupiter/signing đều fixture, external fetch bị chặn trong mock execution suite.
- `.env` không đổi; SHA-256 trước/sau: `BFE0B93646B7FA0B5C1548422164D503C3DFE86407BAF86785FBF8FC20BE429C`.
