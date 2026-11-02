# Kronos — Controlled real trading qua Jupiter

**02/11/2026 — Asia/Bangkok. Implemented; LIVE CHƯA KÍCH HOẠT.**

Project `C:\Users\admin\Desktop\Tool\sniper`. BOT B chỉ là reference read-only. Dashboard được giữ **PAPER / PAUSED**, dataset active vẫn rỗng. Chưa cấu hình wallet/Jupiter riêng nên chưa nghiệm thu một giao dịch mainnet. Không có giao dịch thật do triển khai/tests.

## A. Audit actual BOT B execution

Đã đọc `execution-provider.ts`, `executor.ts`, `solana.ts`, `token-program.ts`, `trade-accounting.ts`, các call sites và execution tests trước khi port. Sizing normal của BOT B là 1% sau reserve, slippage default1%, provider Jupiter Metis v2 `order`/`execute`, priority cap100.000lamports, simulation fee ceiling5.000.000lamports.

BUY: approved decision → claim → current wallet/token balance → quote → exit probes → static transaction validation + unsigned simulation → async final checks → wallet re-read → immediate authority → local sign → durable signature → submit → RPC receipt → wallet/token delta reconciliation → atomic fill/Position. SELL dùng exact remaining quantity, cùng quote/simulation/sign/receipt boundary. Acknowledgment HTTP không đủ tạo OPEN/CLOSED.

Executor của BOT B phụ thuộc production Store, RiskEngine snapshots, Memory, controlled-run policy và exit opportunities. Không import nguyên Executor/Engine vào Kronos. Thay vào đó port provider/RPC/accounting helpers và thích nghi các claim/pending/receipt invariants vào ledger nhỏ của Kronos. Đây là adaptation có tests riêng, không tuyên bố mọi call site/accounting feature của BOT B đã được copy nguyên trạng.

## B. Modules reused và file thay đổi

| File | Thay đổi |
| --- | --- |
| `src/execution-provider.ts` | Port quote schema/validation, instruction allowlist, ATA/token-account validation, simulation, local signer, signature-before-submit, Jupiter order/execute và confirmation; thay global BOT B env bằng config Kronos truyền vào constructor |
| `src/solana.ts`, `src/util.ts` | Port RPC receipt/deltas/mainnet reads, serialized bounded HTTP và safe errors; RPC URL riêng |
| `src/token-program.ts` | Giữ nguyên `inspectMint`/compatibility; bổ sung account inspector/address helpers từ BOT B cho execution |
| `src/fill-accounting.ts` | Port decimal/FX helpers, `receiptRentDelta`, `makeFillAccounting`; giữ công thức receipt economics, contract type riêng |
| `src/live-config.ts`, `live-types.ts` | Config ví riêng, fixed1% BigInt sizing và contracts execution/position |
| `src/live-store.ts`, `live-executor.ts` | Own durable ledger, wallet serialization, claim/sign/reconcile, full-close accounting |
| `src/config.ts`, `server.ts` | Mode/activation checks, live adapter wiring, safe status, API filters và execution details |
| `src/kronos-lab.ts`, `kronos-store.ts`, `kronos-domain.ts` | Optional LIVE execution boundary, mode isolation, additive contracts/indexed queries; model functions không đổi |
| `public/index.html`, `overview.js` | Giữ Overview; mode/actual fills/quantity/fees/PnL/explorer và filters |
| `.env.example`, `scripts/build.mjs`, `README.md` | Tên biến riêng, build capability metadata và hướng dẫn |
| Tests/scripts/docs/evidence | `live-execution.test.ts`, `jupiter-validation.test.ts`, `live-ui-test.mjs`, cập nhật guard test PAPER-only cũ; baseline domain chỉ mở rộng type source, không đổi hàm quyết định |

Không đổi dependencies/package lock. Không copy DB, `.env`, wallet state, history, Position hoặc Memory của BOT B. Không import JEV/TypeSafe/Structure V3/Controlled Markup/Trading Memory. Python worker/vendor/model pins giữ nguyên.

## C. Kronos authority

Security → compatibility → history → Flow → native Kronos → BUY/WAIT hoặc HOLD/SELL. Các hàm `validateCandles`, `decideForecast`, `validPrice`, `markPrice`, `paperFill` khớp canonical tokens với baseline. Native offline model regression và PAPER lifecycle vẫn chạy trong suite.

Enum model cũ `PAPER_BUY/PAPER_SELL` giữ trong decision evidence để chứng minh parity. Khi trial.mode=LIVE, Node chuyển đúng hai action đó vào real execution; **không gọi `paperFill`**. UI hiển thị BUY/SELL. Execution failure giữ model decision, không đổi thành một kết luận “Kronos unavailable”. Không thêm strategic exit từ executor.

## D. Wallet/signing boundary

Chỉ đọc biến `KRONOS_WALLET_PUBLIC_KEY`, `KRONOS_PRIVATE_KEY` hoặc `KRONOS_KEYPAIR_PATH`, và optional `KRONOS_JUPITER_API_KEY`. Jupiter key không còn là điều kiện bắt buộc của LIVE configuration: để trống thì provider bỏ header `x-api-key`, giống BOT B. Có key thì gửi header như trước; provider lỗi vẫn chặn trước ký. Không tự dùng `SOLANA_PRIVATE_KEY`/wallet/.env của BOT B. Keypair hỗ trợ secret64bytes JSON hoặc base58 theo signer port. Public key phải khớp signer.

Private key chỉ ở Node. Python nhận candles/time qua stdio và explicit env allowlist cũ, không signer/key/signed bytes/full process.env. Signer tạm được zero secret buffer sau signing hoặc pre-sign abort. API/log không trả config secret; execution detail chỉ trả public signature/economics/state. Không persist signed transaction để replay.

## E. 1% sizing

```text
reserve = 20.000.000 + 5.000.000 × số OPEN thực đang có, lamports
spendable = max(current wallet SOL - reserve, 0)
principal = floor(spendable / 100)
```

Toàn bộ transaction amount dùng BigInt lamports, không float amount. Không hard-code $0,10. BUY LIVE cố định1% số dư SOL khả dụng sau reserve. Tab Cấu hình đọc tỷ lệ này từ backend và khóa cố định ở1%; không có env cap tuyệt đối. Biến KRONOS_MAX_BUY_SOL cũ nếu còn trong .env sẽ bị bỏ qua. No-route/minimum-route/fee failure không tăng principal, slippage hoặc đổi router để ép lệnh.

## F. Fee reserve

Base0,02SOL dự phòng BUY/ATA/network/priority/SELL/operational costs; mỗi OPEN thêm0,005SOL. Quote cost >0,005SOL bị chặn, đồng thời phải giữ reserve sau principal. SELL cũng yêu cầu balance đủ quoted fees +0,005SOL. Balance/token reread sau simulation/final checks phải khớp preflight. Dự phòng hiện tại là policy bảo thủ cố định, không bảo đảm mọi fee spike tương lai luôn bán được.

## G. Jupiter BUY

Fresh ownership=0 + no own OPEN/pending → fresh balance/sizing → durable CREATED → fresh ExactIn BUY quote → route/wallet/mint/amount/slippage/impact checks → SELL probes20/50/100% expected output → unsigned validation/simulation → fresh existing entry gates → compatibility/decimals + wallet reread → immediate decision/activation/freshness authority → sign/persist/submit.

Exit probes bound với cùng quote/execution; phải có economically meaningful20% hoặc50% route, impact≤15%, minimum net≥10.000 sau conservative110.000lamports floor. Report chỉ là quote-time feasibility. BUY quote phải fresh, simulation phải gắn đúng object, quote chỉ execute một lần. Price impact missing hoặc>15% chặn execution. Quote20s max; probe boundary15s. Slippage1%, Jupiter priority cap100.000lamports giữ theo provider source, không tự nới.

## H. Jupiter SELL

Kronos SELL đóng toàn bộ actual remaining quantity. Current wallet quantity phải khớp own reconciled OPEN. Không dùng expected output, forecast quantity hoặc UI input. Quote/simulation/final authority còn bắt buộc. Route/simulation failure giữ OPEN, lần reevaluation theo cadence Kronos60s; không giả CLOSED. HOLD/WAIT không gọi executor.

## I. Confirmation/reconciliation

```text
CREATED → SUBMITTED → CONFIRMED → RECONCILED
unsigned failure → FAILED
signed ambiguous/missing/mismatched receipt → UNKNOWN
UNKNOWN → RPC evidence → FAILED hoặc CONFIRMED → RECONCILED
dry run → DRY_RUN (không sign)
```

Signature lưu synchronous FULL trước first possible submit. RPC signature/fee/pre/post SOL/token phải hợp lệ; local before khớp receipt và current wallet khớp after. BUY output không được dưới quoted minimum; SELL quantity phải exact và known trading proceeds phải đạt minimum. Position/fill/trial projection cùng atomic transaction. Unique signature/execution fill chặn double apply. Receipt block time dùng khi có, fallback reconciliation time được ghi rõ.

Recovery chỉ đọc receipt; không resend. Unsigned CREATED sau restart trở thành FAILED, không replay approval. Signed UNKNOWN giữ khóa vô thời hạn nếu chưa có bằng chứng đủ. Routine recovery tối đa một attempt/30s; explicit preflight có thể yêu cầu kiểm tra ngay. Khi restart, server luôn PAUSED; user enable mới monitor/ra quyết định mới. RPC read-only pending recovery có thể tiếp tục dù collection paused trong LIVE mode.

## J. Duplicate protection / persistence

Own `live_executions`, `live_positions`, `live_fills` được tạo additive trong DB Kronos. Partial unique wallet pending, unique request key, unique OPEN(wallet,mint), unique fill signature/execution và one active execution lane. Appearance cũ không được cấp duplicate ownership. PAPER/LIVE active appearance tách mode; real ownership vẫn do RPC quyết định. Reset UI bị chặn khi còn real position, signed record hoặc pending ledger, kể cả chuyển dashboard sang PAPER.

## K. Accounting

```text
BUY trading principal = validated ExactIn principal, reconciled with receipt
BUY actual quantity = confirmed wallet token delta
BUY effective SOL/token = principal × 10^decimals / (quantity × 10^9)
SELL trading proceeds = wallet SOL delta + receipt network fee + known rent delta
SELL effective SOL/token = proceeds × 10^decimals / (sold quantity × 10^9)
closed gross = trading proceeds - BUY principal
identified fees = BUY + SELL receipt fees + on-chain failed execution fees for this trial
closed net = gross - identified fees, only when rent/additional-debit classification is complete
```

Priority fee không trừ lần hai; slippage/impact không là fee bổ sung. Rent theo actual owned-token-account balance/instruction evidence, giữ riêng. Không coi recoverable ATA rent là permanent loss. Unknown rent, extra debit hoặc incomplete accounting → Net UNKNOWN. Fee/gross/net authoritative dùng SOL lamports. USD là FX conversion có timestamp/provenance riêng, không phải một USD fill nhận trực tiếp từ Jupiter; receipt cũ quá45s khi recovery không dùng today's FX giả historical entry. Không có fresh FX → actual USD entry/exit và USD mark return có thể UNKNOWN, vẫn có actual SOL/token.

GMGN mark/MFE/MAE là sampled USD estimate, không executable liquidation value; chưa thêm optional ongoing SELL valuation quotes để tránh tăng provider load. LIVE statistics net/gross/fees scope là CLOSED positions; failed BUY không mở Position vẫn có fee trong execution detail/log, không bị giả thành zero-cost success. Closed statistics trả UNKNOWN nếu có closed position chưa đủ accounting, không cộng partial known subset thành exact total.

## L. PAPER/LIVE separation

Legacy trial thiếu mode được đọc như PAPER, không rewrite history. New trials gắn mode. History/Positions có ALL/PAPER/LIVE; SQL filter trước pagination. PAPER statistics luôn bỏ LIVE; LIVE statistics chỉ own reconciled live_positions. Không cộng paper% với executed SOL. Không còn storage cap lifecycle/decisions/events; các read-page/provider/concurrency limits không đổi.

## M. UI

Giữ Overview style BOT B/carousel/current token/evaluation/result/Action Log/Positions. LIVE có badge và MARKET REAL/TRADING LIVE, seven stages kết thúc bằng Execution, BUY/SELL SIGNAL/SUBMITTED/CONFIRMED/RECONCILED/FAILED/UNKNOWN. Paper Decision chỉ hiển thị ở PAPER. Actual entry/exit, atomic quantity, fees/net, market estimate, MFE/MAE, hold và explorer link BUY/SELL riêng; thiếu evidence là `—`. Fees/Principal có trên tooltip vị thế. Settings hiện execution/dry-run/pending state; không có nút bypass UNKNOWN.

## N. Tests

`pnpm test`: **51 passed,0failed,0skipped**. Bao gồm native offline model parity, prior PAPER regression và30execution/validation cases. Final source được kiểm tra lại với toàn suite51tests; targeted execution suite **21passed** cũng PASS. `pnpm typecheck`, `pnpm lint`, `pnpm build`: **PASS**.

Coverage: exact1%/rounding/tiny size, no-route/reserve/impact/security/stale/pause denials; BUY/full SELL exact economics; duplicate SUBMITTED; UNKNOWN BUY/SELL + restart/no replay; failed SELL fee; missing rent→unknown net; PAPER/LIVE filters; real ported transaction signer/recipient/program/authority checks; minimum output/debit/simulation failures; immediate authority abort; dry-run zero sign/submit; same baseline forecast through integrated LIVE adapter with fake RPC/provider.

Tests không kết nối provider thật. Fake signatures chỉ là strings/counters; real validator test abort trước `tx.sign`. No signed mainnet transaction hoặc real submission. Không có JEV/TypeSafe network consumer; test network preload chặn external requests. Full PAPER browser regression giữ geometry so BOT B và5.000-row pagination. LIVE browser fixture kiểm tra7stages, actual entry, quantity/explorer/UNKNOWN net, mode filters và1440/1024/390 không page overflow.

Secret audit113files:0configured-secret matches, loại chính file `.env` khỏi scan; [evidence](../evidence/controlled-live-secrets.json).

Evidence: [full tests](../evidence/controlled-live-tests.log), [execution](../evidence/controlled-live-execution.log), [typecheck](../evidence/controlled-live-typecheck.log), [lint](../evidence/controlled-live-lint.log), [build](../evidence/controlled-live-build.log), [PAPER UI](../evidence/controlled-live-paper-ui.log), [LIVE UI](../evidence/controlled-live-ui.json). Node commands dùng pinned22.22.0; pnpm launcher Node20 engine warning không phải test failure.

## O. Safety / isolation

BOT B protected source/config/public/scripts/tests/dist/package/env: **212files,0changed** tại checkpoint; PID7656/port3000 và Lab cũ PID3216/8792 giữ nguyên. Không claim LIVE DB BOT B immutable khi Engine tự chạy. Không gọi mutation API BOT B, không đọc/copy BOT B key/DB. Tác vụ không ghi Kronos `.env`; fingerprint của file đã đổi ở checkpoint cuối so với đầu lượt, nên không tuyên bố byte-immutable. Không in giá trị thay đổi. Python worker/pins/model strategy giữ nguyên. Main active DB có0 ở cả4lab tables và3live tables, integrity OK; reset backup từ task trước vẫn giữ offline.

Inherited Security/compatibility provider semantics không được coi là đã sửa hay nghiệm thu toàn bộ chỉ vì port execution. Đây không phải audit profitability hoặc chứng minh mọi token sellable. Chưa chạy real Jupiter quote, mainnet sign/submit, crash injection hoặc real round-trip; first actual BUY/SELL cần kiểm tra receipt/quantity/principal/fees/rent/net trong execution detail sau khi user tự cấu hình và activate.

## P. Activation status

**READY FOR CONFIGURATION; LIVE NOT ACTIVATED.** Dashboard hiện PAPER/PAUSED, realExecutionEnabled=false,0trades. WALLET CONFIGURED: **NO**; RPC: **YES**; GMGN: **YES**; JUPITER: **NO**. Không sửa `.env` tự điền key. Dashboard PID14568 vẫn PAPER/PAUSED. Automatic approval review chặn lần reload cuối với lý do chung `blocked by policy`; final build đã PASS nhưng cần restart Kronos thủ công để nạp thay đổi cuối. Không thử vượt chặn. Final checkpoint và source parity: [controlled-live-final.json](../evidence/controlled-live-final.json).

## Q. Exact startup / dry-run / activation

1. Dừng đúng server Kronos riêng đang PAUSED trước khi khởi động process khác; không dừng BOT B3000 hoặc Lab cũ8792. Nếu trước đó process bị force-stop, chỉ xóa `runtime/kronos.lock` sau khi xác minh PID trong file không còn sống.
2. Tự cấu hình own `.env`, không gửi key vào chat. Đặt `KRONOS_WALLET_PUBLIC_KEY`; chọn **một** `KRONOS_PRIVATE_KEY` hoặc `KRONOS_KEYPAIR_PATH` trỏ keypair riêng; `KRONOS_RPC_URL`, `KRONOS_GMGN_API_KEY`; optional `KRONOS_JUPITER_API_KEY` có thể để trống. Tỷ lệ1% hiển thị cố định trong tab Cấu hình; không cần cap SOL trong .env. File example chỉ thêm tên biến rỗng, không chứa secret thật.
3. Bắt đầu bằng `TRADING_MODE=live`, `KRONOS_LIVE_ACK=I_ACCEPT_REAL_TRADING`, `KRONOS_EXECUTION_DRY_RUN=true`. Mode LIVE ở đây vẫn STOP BEFORE SIGN vì dry-run flag. Missing/invalid trading mode → PAPER; LIVE thiếu signer/ACK/GMGN/RPC hợp lệ → startup fail closed.
4. Chạy:

```powershell
cd C:\Users\admin\Desktop\Tool\sniper
pnpm start
```

Mở `http://127.0.0.1:8793`, kiểm tra LIVE + DRY RUN + PAUSED. Bấm enable khi muốn test data/quote/simulation với chính sách1%. Log `DRY_RUN_STOP_BEFORE_SIGN` có exact requested lamports; không có OPEN thật.

5. Sau khi tự kiểm tra dry-run, pause, stop đúng Kronos; đặt `KRONOS_EXECUTION_DRY_RUN=false` (hoặc bỏ biến), giữ mode/ACK/config hợp lệ; restart. Server vẫn PAUSED. **Chỉ khi user bấm enable ở LIVE mode mới có quyền phát sinh BUY/SELL thật.** Enable kiểm tra signer/config, mainnet genesis, pending recovery, existing OPEN balance và reserve. Invalid GMGN/Jupiter response ở fresh pipeline/quote vẫn fail closed trước sign.
6. `TRADING_MODE=paper` quay về PAPER capability; không dùng đổi mode/reset để bỏ qua pending/real holdings. Không clear UNKNOWN để thử lại; recovery cần receipt/wallet evidence. Giữ backup/ledger để audit first real round trip.

## Required direct answers

| # | Answer |
| --- | --- |
| 1 | Real BUY capability: **YES**, implemented; chưa activate/verify bằng mainnet fill |
| 2 | Real SELL capability: **YES**, full actual remaining quantity |
| 3 | BUY strategy: **KRONOS** |
| 4 | Strategic SELL: **KRONOS** |
| 5 | JEV: **NO** |
| 6 | Structure V3: **NO** |
| 7 | Controlled Markup: **NO** |
| 8 | Normal size: **1% current safe spendable SOL**, cố định, không absolute cap |
| 9 | Hard-code $0,10: **NO** |
| 10 | Increase size to obtain route: **NO** |
| 11 | Infeasible1%: **SKIP BUY**, precise failure recorded |
| 12 | Actual entry from reconciliation: **YES**, SOL/token; optional evidenced FX conversion |
| 13 | Actual exit from reconciliation: **YES**, same units |
| 14 | Receipt network fees: **YES** |
| 15 | Double-count priority/slippage/impact: **NO** |
| 16 | UNKNOWN BUY auto-second BUY: **NO** |
| 17 | UNKNOWN SELL falsely CLOSED: **NO** |
| 18 | UNKNOWN SELL duplicate SELL: **NO** |
| 19 | PAPER/LIVE distinguishable: **YES** |
| 20 | LIVE-only Net PnL stats: **YES**; incomplete accounting stays UNKNOWN |
| 21 | Python receives wallet secret: **NO** |
| 22 | UI/log exposes wallet secret: **NO** |
| 23 | Default PAPER: **YES** |
| 24 | Automatically start LIVE: **NO** |
| 25 | Real transaction during implementation/tests: **NO** |
| 26 | Modify BOT B: **NO** |
| 27 | Ported modules: provider/RPC/HTTP/account inspector/fill-accounting helpers; xem B |
| 28 | State machine: CREATED→SUBMITTED→CONFIRMED→RECONCILED, FAILED/UNKNOWN/DRY_RUN; xem I |
| 29 | Gross/proven fees/net formulas: xem K; unknown rent/debit prevents exact net |
| 30 | Post-BUY sell funding: per-position reserve, quote fee ceiling, cash reread and simulation; xem F |


## Jupiter API key optional — cập nhật

Đã bỏ đúng predicate `!c.JUPITER_API_KEY` khỏi `requireLiveConfiguration()`. Header logic của provider giữ nguyên; không sửa signing, quote, simulation, receipt/accounting, sizing/reserve hoặc các LIVE config predicates khác. `.env` không được ghi bởi thay đổi này, không bật/restart LIVE hoặc tạo giao dịch thật. Bản build mới cần restart Kronos để nạp vào process đang chạy. Tests thêm: key trống/key có đều qua config khi các điều kiện khác hợp lệ; các điều kiện khác vẫn fail closed; quote header đúng cho hai trường hợp; HTTP401 keyless vẫn reject.

Kiểm chứng cập nhật optional-key: `pnpm test` **54passed,0failed,0skipped**; typecheck/lint/build PASS. [Tests](../evidence/jupiter-optional-key-tests.log), [checkpoint](../evidence/jupiter-optional-key-verification.json).

## Fixed1% sizing — cập nhật theo yêu cầu mới

Đã bỏ KRONOS_MAX_BUY_SOL và maxBuyLamports khỏi config/runtime sizing. Một nguồn LIVE_SIZING_POLICY cung cấp1% cho Executor và API/status/tab Cấu hình. Field phần trăm read-only để luôn giữ1%; backend không nhận tỷ lệ từ browser. Ownership/reserve/duplicate/quote/probes/simulation/pre-sign/reconciliation không được nới. .env thật không được ghi; giá trị cap cũ bị bỏ qua. Không bật LIVE trong kiểm chứng.

Kiểm chứng fixed1%: `pnpm test` **55passed,0failed,0skipped**; typecheck/lint/build PASS; browser PASS với field1% read-only từ backend.7protected files (gồm .env, provider, RPC, token inspector, accounting, model domain và Python worker) không đổi. [Tests](../evidence/fixed-one-percent-tests.log), [UI](../evidence/fixed-one-percent-ui.json), [verification](../evidence/fixed-one-percent-verification.json). Checkpoint cuối không kết nối được dashboard8793; tác vụ không bật hoặc dừng production server. Cần khởi động lại Kronos để nạp build mới.
