# Kronos strategy trong MAIN BOT

> Policy chọn một strategy trong báo cáo lịch sử này đã được thay bằng [FIRST BUY WINS](first-buy-wins-ownership.md) ở source mới. Xem báo cáo mới để biết phạm vi kiểm chứng và trạng thái triển khai; checkpoint dưới đây thuộc lần triển khai trước.

**02/11/2026 · IMPLEMENTED / VERIFIED / DEPLOYED.** Bản mới đã nạp vào PID4904 lúc22:28 Bangkok; LIVE mode, giữ nguyên SYSTEM halt và entries=false. Chọn đúng **một entry strategy** trong Cấu hình: `STANDARD` hoặc `KRONOS`; hiện STANDARD. Position đang có giữ owner riêng dù thay lựa chọn entry.

434 tests PASS; typecheck/lint/build PASS. Có 29 tests tích hợp mới, kiểm chứng native model và browser riêng. Không import lịch sử standalone, reset DB, ký hoặc gửi giao dịch thật từ tác vụ.

## Audit và kiến trúc

Actual entry hiện tại là `TRENDING_ONE_SHOT_V1`, không phải pipeline Watch cũ trong các báo cáo tháng 10. Call sites chính: [one-shot-entry](../src/one-shot-entry.ts), [Engine](../src/engine.ts), [Risk](../src/risk.ts), [Executor](../src/executor.ts), [Store](../src/store.ts).

```text
ONE GMGN Trending / discovery queue
  → Cheap Filter
  → fresh Security, không lấy listing làm fallback ở entry
  → LIVE mint compatibility / decimals
  → shared completed M1 History
  → Capital Flow sufficiency
  → COMMON_RISK: holders / freshness / concentration / ownership / capital
  → configured strategy
      STANDARD: Controlled Markup + Structure Evidence V3 → JEV
      KRONOS: isolated OHLC inference → BUY / WAIT
  → shared Risk qualification + fresh final checks
  → shared approved BUY intent / 1% sizing / atomic claim
  → Jupiter BUY quote → bound SELL probes 20/50/100%
  → transaction validation → simulation → final/pre-sign checks
  → main signer → durable signature → submit → reconcile/fill
  → ONE Position store with persisted strategy owner
      STANDARD: existing JEV strategic exits
      KRONOS: new eligible M1 → HOLD / full remaining SELL
  → shared Executor / receipts / accounting / History
```

Fork sau History/Flow, trước Controlled Markup/Structure/JEV. Holder evidence và common Risk được chuyển lên trước fork; thiếu authoritative holders hoặc vốn bị từ chối trước khi tiêu tốn inference. Optional creator history không trở thành required gate. Các final holder checks vẫn chạy lại. Không tăng TTL hoặc giảm yêu cầu dữ liệu để cho Kronos qua.

Kronos dùng History của attempt hiện hữu và `PositionHistoryMonitor` chung, không fetch Trending/info/security/history bằng client riêng. Giữ lane History hiện hữu: global spacing 15s, per-position 60s. Model serial concurrency=1, queued Position được ưu tiên trước queued entry; không preempt inference đã bắt đầu, không cam kết latency SLA.

Không gọi Structure V3, Controlled Markup, smart-money enrichment, JEV BUY/SELL, Trading Memory retrieval hoặc Runner reasoning trong nhánh Kronos. Không tạo learning sample STANDARD từ giao dịch Kronos; History/statistics vẫn đọc shared execution/Position accounting.

## Reference và model parity

Reference: [janechoson/sniper · develop](https://github.com/janechoson/sniper/tree/develop). Local standalone HEAD và remote develop đã đối chiếu cùng commit `11105df09a2073b54e75b9a3652dc505077bd7dd`; cuối tác vụ Git working tree standalone vẫn sạch. Chỉ dùng làm reference đọc, không copy standalone LiveExecutor/Jupiter/server/DB/env/history.

| Thành phần | Giá trị giữ nguyên |
| --- | --- |
| Vendor commit | `67b630e67f6a18c9e9be918d9b4337c960db1e9a` |
| Model | `NeoQuasar/Kronos-small` |
| Model revision | `901c26c1332695a2a8f243eb2f37243a37bea320` |
| Tokenizer | `NeoQuasar/Kronos-Tokenizer-base` |
| Tokenizer revision | `0e0117387f39004a9016484a186a908917e22426` |
| Input | 32–60 completed contiguous M1 OHLC, không future/partial/gap/padding |
| Forecast | 5 M1, 3 sampled paths, seed1701, temperature1, topP0.9 |
| BUY | Cả 3 terminal forecasts lớn hơn last observed close; còn lại WAIT |
| SELL | Cả 3 terminal forecasts nhỏ hơn last observed close; còn lại HOLD |
| Normal strategic SELL size | Toàn bộ reconciled remaining quantity, không original/forecast quantity |

Reuse pure [domain functions](../src/kronos-domain.ts), pins/vendor/model weights hiện hữu; không đổi forecast math. [Adapter](../src/kronos-strategy.ts) chỉ chuyển tên PAPER_BUY/PAPER_SELL thành decision BUY/SELL cho MAIN BOT. Không thêm SL, TP, trailing, JEV override hoặc PnL threshold.

Fixture OHLC 40 nến trong tests tương ứng standalone `tests/fixtures.ts`. Native verification chạy hai Python workers với cùng input/seed trên bản tích hợp và reference, so output sau khi bỏ telemetry load/latency/RSS: khớp. BUY/WAIT/HOLD/SELL đồng nhất cho bullish, bearish, flat và mixed terminals. Không dùng parity làm bằng chứng profitability hoặc calibrated confidence.

## Custody và secret boundary

Dependency graph: `KronosStrategy → zod + pure kronos-domain`; `KronosWorker → child_process/fs/path/os + strict forecast schema + pure domain`. Không import config loader, Store, RPC, JEV, Executor, wallet parser hoặc signer. MAIN composition truyền explicit nonsecret runtime/SystemRoot. Không đọc full `process.env` trong strategy/worker modules.

Python stdin chỉ có `candles[{at,open,high,low,close}]` và `decisionAt`. Child env dùng allowlist rõ ràng; không spread parent env. Python tiếp tục lọc env ở receiver. File allowlist giới hạn worker/vendor, model/tokenizer, Python runtime và scratch; deny `.env`/key files, source writes, network và subprocess.

Worker result bắt buộc strict schema, đúng pins/model/shape, 3×5 giá finite positive, timestamps/input binding và deterministic parameters. Trường `privateKey`, transaction, arbitrary action/amount/recipient hoặc output sai shape không thành quyền trade. Error/stderr từ worker không được relay nguyên văn vào logs/UI. Model không quyết định amount hoặc transaction construction.

| Câu hỏi | Kết quả trong interface/đường code đã kiểm chứng |
| --- | --- |
| Kronos nhận/đọc wallet private key, mnemonic hoặc signer? | **NO** |
| Kronos nhận full Node env, `.env`, Jupiter/GMGN credentials? | **NO** |
| Kronos ký, submit, chọn recipient hay xây transaction? | **NO** |
| Ai giữ signer/private key? | **MAIN BOT** |
| Ai build/validate/simulate/submit/reconcile transaction? | **MAIN Executor + execution provider + RPC** |
| Ai quyết định Kronos BUY/WAIT/HOLD/SELL? | **Kronos policy** |
| Ai quyết định amount? | **MAIN sizing/Position Engine**, BUY vẫn floor 1% spendable sau reserves |

Synthetic secret values được kiểm tra không có trong child env, stdin/input, stdout/stderr probe, returned evidence, shared decision trace/DB, execution/Position payload và status. Native probe chặn 5/5 thao tác: đọc bot env, đọc file ngoài allowlist, ghi source, subprocess, socket connect.

**Giới hạn bảo mật:** Python audit hooks là giới hạn Python APIs, không phải OS sandbox chống arbitrary hostile native code. Báo cáo này không tuyên bố một native process đã bị chiếm quyền hoàn toàn không thể vượt giới hạn đó. Không đưa signer vào dependency graph hoặc IPC của model.

## BUY/SELL authority audit

| Đường | Quyền sau tích hợp |
| --- | --- |
| STANDARD BUY | Structure/JEV → common Risk.approve → shared Executor |
| KRONOS BUY | Validated Kronos BUY → common Risk.approve → shared Executor; không JEV thay mặt |
| JEV partial/full/retry/late callback | Chỉ STANDARD; Engine routing, scheduler eligibility và apply callback chặn Kronos |
| Kronos strategic SELL | Persisted fresh SELL + matching decision/opportunity/owner/quantity, full remaining amount |
| TP/trailing legacy helpers | Không tạo quyền cho Kronos; central claim/Executor cũng từ chối intent không có quyền |
| Security critical / honeypot finding | Global deterministic safety; fresh `EXIT_SAFETY_V2` proof, full remaining SELL |
| Liquidity collapse | Global deterministic safety; fresh quantity-bound proof, full remaining SELL |
| Structure collapse / Controlled Markup breakdown | STANDARD only, không là exception SELL cho Kronos |
| Manual exit, kể cả partial hiện hữu | Global operational authority; actual persisted manual request + exact bound amount, không JEV |
| Kill switch / Risk halt / circuit breaker | Không được thêm quyền SELL mới; existing entry halt semantics giữ nguyên |
| Submitted/UNKNOWN / recovery/reconcile | Đối soát signed transaction cũ; không replay approval, không chuyển owner hoặc tạo SELL thay thế |

Normal source hiện chỉ tạo BUY intent qua `Risk.approve` trong one-shot entry và SELL intent qua `Engine.exitPosition → Executor.sellIntent`. Operator/legacy callers cũng phải đi qua Store/Executor checks khi dùng common stack. Không copy một executable Kronos trading engine thứ hai.

[Central authority guard](../src/strategy-authority.ts) chạy ở atomic Store.claim và Executor validation, bao gồm pre-sign validations. Nó kiểm tra position/mint/mode/strategy owner, quantity và authority. Kronos không SELL Position STANDARD; JEV không strategic-SELL Position KRONOS, kể cả forged partial/full intents. Exceptions chính xác là manual, critical Security và liquidity collapse ở bảng trên.

## Persistence và restart

`strategy: STANDARD | KRONOS` là field persisted; thiếu field legacy đọc theo STANDARD. Lưu owner ngay từ PENDING_ENTRY claim, không chờ OPEN. `savePosition` từ chối đổi owner của row hiện có. Đổi `entryStrategy` thu hồi unsigned entry đang chạy nếu selection thay đổi, không chuyển owner của Position.

Giữ existing cross-strategy duplicate/wallet freeze gates: CREATED, SUBMITTED, UNKNOWN và OPEN đều chiếm mint lane. Durable signature/no-replay/unique fill/reconciliation giữ nguyên. Snapshot, intent, execution/fill và Position có trace `strategy`, `decisionSource`, `decisionId`, `decisionAt`; latest Kronos position decision có quantity/input binding riêng.

Restart giữ owner, không phục hồi old unsigned strategic approvals. Kronos Position tiếp tục được routed tới model khi có eligible M1; model lỗi giữ OPEN, không fake SELL hoặc JEV takeover. Model hồi phục cho phép đánh giá lại. Signed pending vẫn reconcile trước execution mới.

Không SQL migration/reset/import standalone DB. Không sửa receipts, wallet quantities, existing PnL hoặc trade history production. Không thêm Position-count cap hoặc cap300/200 của Lab vào shared production candidate path.

## UI, History, statistics, logs

- Cấu hình thêm `entryStrategy`, default STANDARD. Cùng form/API hiện hữu.
- Overview thêm Kronos card trong pipeline: CHECKING/BUY/WAIT/ERROR, candle count, 5m horizon, 3 terminal forecasts và reason. Không hiển thị sampled paths như calibrated confidence.
- Position dùng cards/table chung, strategy badge và KRONOS strategic exit authority, HOLD/SELL evidence. Exceptions hiển thị riêng.
- History vẫn một endpoint/store; strategy filter chạy trong SQL **trước** ordering/pagination. Legacy default STANDARD; opening-time sorting giữ nguyên.
- Statistics lọc ALL/STANDARD/KRONOS; mỗi strategy có closed/wins/losses, gross PnL, identified fee subtotal, fee completeness và net PnL nếu accounting complete. Missing accounting giữ null, không giả zero profit/fee completeness.
- Shared log/events gồm KRONOS_EVALUATION_STARTED, BUY/WAIT, POSITION_EVALUATION, HOLD/SELL, INFERENCE_FAILED; execution giữ generic lifecycle và strategy trace.
- Gỡ legacy Kronos Lab tab/proxy khỏi normal dashboard/control path. Legacy control trả410; GET trả integrated status. Không import standalone dashboard.
- Filters mới bị disable khi backend cũ chưa công bố capability tích hợp; tránh gửi query mới tới backend đang chạy bản cũ.

## Kiểm chứng

| Kiểm chứng | Kết quả |
| --- | --- |
| `pnpm test` | **434 passed, 0 failed/cancelled/skipped**, 48.783,9462ms |
| New `tests/kronos-integration.test.ts` | **29 passed**, gồm bổ sung fake-secret trace assertions |
| `pnpm typecheck` | PASS |
| `pnpm lint` | PASS |
| `pnpm build --out-dir .build-kronos-integration` | PASS; không ghi đè active `dist` |
| Native reference/model verification | PASS native forecasts + decision parity; secret leak=false; isolation5/5 |
| Browser thật + isolated PAPER HTTP/temp DB | PASS settings/API, Overview, badges, History filter/page, statistics, 1440/1024/390; 0 browser errors |

Build ID kiểm chứng: `979e86da37f77f50914d1f5b7e9e199655692fcfc55ad7980a3411b24c17fcc1`. Build mặc định vẫn `pnpm build → dist`; thêm explicit `.build-*` output để kiểm chứng khi LIVE đang chạy.

Regression bao gồm selected STANDARD không gọi Kronos; selected KRONOS không gọi Structure/JEV/Memory; Security/compatibility/ownership/capital/exit probes/simulation/pre-sign veto; WAIT/model failure; config switch revocation; manual/security/liquidity exceptions; no forged authority; exact SELL123456 remaining atomic units qua **Engine.processExits → shared Executor**; collisions hai chiều SUBMITTED/UNKNOWN/OPEN; actual SQLite reopen; model recovery; History/statistics owner isolation và unknown accounting.

Reproduce native/browser, không tạo screenshot/evidence dump:

```powershell
pnpm exec tsx --import ./scripts/test-env.mjs scripts/kronos-integration-verify.ts
pnpm exec tsx --import ./scripts/test-env.mjs scripts/kronos-integration-ui.ts
```

Test preload chặn external HTTP và ngăn đọc credentials production. LIVE-named fixtures dùng fake RPC/provider/signature boundary, không mainnet signer. Pnpm launcher Node20 warning vẫn có; local pinned Node22.22.0 dùng cho scripts/test/build. SQLite experimental warning không phải failure.

Native/browser verification không lưu screenshot, raw forecast dump hoặc evidence JSON mới. Temp DB của test reopen/browser được dọn trong `finally`. **Cleanup build bị automatic approval review từ chối (`blocked by policy`)**: `.kronos-integration-build/` và `.build-kronos-integration/` vẫn còn khoảng1,3 MB compiled artifacts. Không thử phương thức xóa khác sau rejection; chúng không được runtime production sử dụng. Không xóa reference repository/history hoặc model runtime.

## Files thay đổi

| Nhóm | Files |
| --- | --- |
| New strategy/authority | `src/kronos-strategy.ts`, `src/strategy-authority.ts` |
| Isolated worker | `src/kronos-worker.ts`, `lab/kronos/worker.py` |
| Routing/config/domain | `src/config.ts`, `src/domain.ts`, `src/candidate-attempt.ts`, `src/one-shot-entry.ts`, `src/risk.ts`, `src/engine.ts` |
| Shared persistence/execution/exit | `src/store.ts`, `src/executor.ts`, `src/jev-exit-scheduler.ts`, `src/exit-lifecycle.ts`, `src/exit-safety.ts`, `src/trading-memory.ts`, `src/position-view.ts`, `src/server.ts` |
| Main UI | `public/index.html`, `public/app.js`, `public/style.css` |
| Verification/build tooling | `tests/kronos-integration.test.ts`, `scripts/kronos-integration-verify.ts`, `scripts/kronos-integration-ui.ts`, `scripts/build.mjs` |
| Fixture/regression updates | `tests/one-shot-fixtures.ts`, `tests/one-shot.test.ts`, `tests/pipeline.test.ts`, `tests/trending-final-gate.test.ts`; optional-JEV typing updates trong core, learning-fixtures, manipulation-accounting, sniper-coordinator, token-program tests |
| Report | File này |

Đối chiếu82 baseline files:63 không đổi,19 thay đổi có chủ đích như bảng trên; new files và tests/tooling được liệt kê riêng. `.env`, package/lock, `config/strategy.json`, model pins/vendor giữ nguyên. Standalone repository working tree sạch. Không tạo/copy keys, cài thêm dependencies hoặc download lại weights.

Standalone scanner/DB/server/UI/LiveExecutor/Jupiter/wallet config và main legacy Lab proxy/dashboard không còn cần cho integrated runtime. Giữ source/reference/history offline, không xóa repository hoặc tự migrate data.

## Checkpoint trước deployment và giới hạn

Source đã kiểm chứng; **không restart/pause/activate Kronos trên BOT LIVE**. PID7656 vẫn listener127.0.0.1:3000; không listener3001. GET checkpoint cuối: mode=LIVE, scannerRunning=true, **entries=false**, halt=`SYSTEM failure: OPERATION_FAILED`; capability Kronos integration chưa có trong backend cũ. Không clear halt hoặc suy diễn nguyên nhân halt từ tác vụ tích hợp này.

Legacy PAPER Lab PID3216/8792 vẫn là service có từ trước, không được tác vụ restart/kill. Trong code normal MAIN BOT mới chỉ có **1 discovery/common security pipeline, 1 Position store, 1 Jupiter stack, 1 wallet/signer authority và 1 Kronos inference strategy**; không tuyên bố mọi service cũ trên máy đã được triển khai/dừng để đạt host-wide single-process state.

Để áp dụng vào runtime cần một deployment/restart riêng của MAIN BOT và chọn KRONOS trong Cấu hình; task này không làm bước đó. Không re-arm entries hoặc LIVE ACK. Mọi Position STANDARD đang mở vẫn thuộc STANDARD sau deployment.

**Task-originated real BUY=0, real SELL=0, real sign=0, real submit=0.** Production Engine có thể tự ghi DB/hoạt động theo trạng thái cũ; không tuyên bố DB LIVE byte-immutable trong thời gian kiểm chứng. Không nghiệm thu profitability, provider quota/latency LIVE hoặc khả năng native OS sandbox. Interface/ownership/security checks được kiểm chứng bằng fixtures và native model offline.

## Deployment được user yêu cầu — 02/11/2026, 22:28 Bangkok

Đã chạy lại typecheck/lint/build PASS và nạp latest build `979e86da37f77f50914d1f5b7e9e199655692fcfc55ad7980a3411b24c17fcc1`. Trước restart:0 executions pending,0 manual CLAIMED/SUBMITTED; signer/mainnet hợp lệ, cả3 core OPEN holdings khớp chain và BUY receipts confirmed. Windows dừng đúng old PID7656, sau đó chạy Node22.22.0 `dist/server.js` bằng hidden process, PID4904, listener127.0.0.1:3000.

Dùng server entrypoint để tiếp tục UI/monitoring với **halt được giữ nguyên**, không gọi normal-live activation để cấp lại entries. `.env`, LIVE ACK, quantities/history và strategy selection không bị sửa bởi operator. Startup vẫn chạy existing recovery/monitoring. Capability `kronosIntegration=true`; Cấu hình hiện STANDARD. Không đổi owner của Position thành Kronos hoặc tạo trade kiểm chứng. Real service logs nằm ở `data/bot-runtime.stdout.log`/`bot-runtime.stderr.log`, không phải test evidence.

`SYSTEM failure: OPERATION_FAILED` vẫn tồn tại, entries=false. Historical scoped failure chỉ lưu DEEP_CHECK/OPERATION_FAILED, không đủ xác lập nguyên nhân gốc; không clear halt theo suy đoán. User có thể xem giao diện bản mới, chọn strategy trong Cấu hình; việc gỡ halt/khôi phục BUY là bước riêng. Legacy PAPER Lab8792 không bị tác vụ restart.
