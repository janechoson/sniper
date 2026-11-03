# Controlled Markup Guard + Gross/Fee/Net Accounting + Trade History

Ngày 2026-11-01, Asia/Bangkok. Implementation đã kiểm tra bằng mocks/paper fixtures; **chưa nạp vào LIVE**. Không thay `.env`, không giao dịch thật, không restart process. Audit trước sửa: [plan](guard-accounting-plan.md). [Integrity/checks](guard-accounting-verification.json).

## A. Files Changed

| File | Thay đổi |
|---|---|
| `src/manipulation-structure.ts` mới | Deterministic M1 segment analyzer, feature confluence, versioned policy |
| `src/trade-accounting.ts` mới | Exact lamport/quantity accounting, receipt rent evidence, durable lifecycle projection |
| `src/one-shot-entry.ts` | Guard evidence trước JEV, structured event, timestamped SOL FX vào execution |
| `src/risk.ts`, `src/jev.ts` | STRONG deterministic veto; BUY/SELL context và instructions tách risk/accounting |
| `src/domain.ts` | Additive optional accounting/FX/fill/lifecycle/gross-excursion fields |
| `src/executor.ts` | Receipt/paper reconciliation lưu fill economics, actual entry price, final exit và bounded accounting event |
| `src/engine.ts` | Gross MFE/MAE, nullable accounting cho JEV/aggregate PnL, gross-unknown scheduling guard |
| `src/store.ts` | Merge gross observations, persist known/unknown strategic PnL context |
| `src/position-view.ts`, `src/server.ts` | Shared accounting projection cho Positions/History, không dùng signal price giả actual |
| `public/app.js`, `index.html`, `style.css` | Gross/Fee/Net, fee tooltips, lifecycle/partial fills/Tx links, responsive |
| `tests/manipulation-accounting.test.ts` mới | Detector/replay/controls, fee/rent/impact, restart, unknown TX, JEV wire và reconciliation |
| `tests/fixtures.ts`, `long-hold.test.ts`, `normal-live.test.ts` | Seed explicit reconciled BUY accounting cho monitoring fixtures; giữ các assertion SELL/safety |
| `scripts/accounting-ui-test.mjs` mới | Browser-only accounting/lifecycle/mobile verification, mọi request intercepted |
| `scripts/position-ui-cases.mjs` | Legacy browser fixtures khai báo economic projection rõ, ảnh ghi docs thay vì data |

Không có Git repository nên đây là đối chiếu hash baseline + file mới, không phải commit diff. Không đổi provider/skills/package/lock/config.

## B. Controlled Markup Guard

Reuse actual `marketHistory.candles`, chỉ nến M1 đã đóng tại evaluation time; sort, tối đa 61 nến. Scan các cửa sổ liên tục ít nhất 8 nến. Gap phá continuity của segment; dump cũ không xóa khả năng tìm staircase mới sau dump. Không đọc future dump để quyết định pre-BUY.

Features giữ raw normalized values: initial impulse/range dominance so với local history; range compression; body coefficient of variation; directional persistence; path efficiency = `abs(last close-first close)/sum(abs(close delta))`; pullback frequency/travel share/median magnitude/max duration; upper/lower wick share; higher-low/higher-close persistence; step noise; relative late slope acceleration. First visible impulse không được khẳng định là launch thật.

STRONG yêu cầu đồng thời: upward path, efficient path, persistent positive steps, scarce pullbacks, scarce rejection, persistent local floor, low step noise, và compression **hoặc** repetitive bodies. Impulse/late acceleration được ghi riêng vì không phải variant nào cũng có. Rising price hoặc green candle count đơn lẻ không đủ. Smart Money UNKNOWN không cộng risk.

Policy `CONTROLLED_MARKUP_V1` được export/log cùng evidence, **là heuristic chưa hiệu chỉnh false-positive rate**:

| Policy | Giá trị |
|---|---:|
| Minimum contiguous segment | 8 bars |
| Path efficiency / positive step persistence | ≥0.90 / ≥0.80 |
| Negative travel / all absolute travel | ≤0.10 |
| Mean total wick / range | ≤0.45 |
| Higher-low persistence | ≥0.80 |
| Median absolute step deviation / median absolute step | ≤0.75 |
| Body variation for repetitive alternative | ≤0.60 |
| Local range compression alternative | ≤0.80 |
| Relative impulse dominance / late acceleration labels | ≥2 / ≥1.5 |

Các giá trị là normalized structure policy công khai; không có rule phần trăm tăng/giảm giá để gọi rug. Output gồm status, metrics + evidenceRange, top 10 suspiciousSegments, confluence booleans, policy/reasons/limitations/timestamps. LOW vẫn giữ recent eligible segment metrics để kiểm tra; thiếu segment thì metrics null. Không có arbitrary risk score hoặc `rug=true`.

## C. 6 Losing Trade Replay

Cohort đóng băng lúc đọc DB: sáu CLOSED losing LIVE positions mới nhất theo entryAt tại thời điểm capture. LIVE vẫn hoạt động nên không đổi cohort theo các lệnh đóng sau đó. DB chỉ đọc bằng SQLite readOnly/query_only; fixture lưu [pre-BUY inputs](../tests/fixtures/controlled-markup-prebuy.json). Lấy persisted snapshot trước BUY, giữ provider fetchedAt; mọi nến phải đóng trước snapshotAt và BUY. Không gọi provider mới.

[Full replay/features](controlled-markup-replay-results.json). Số bên dưới là selected segment, không phải toàn lookback:

| Case | Detected pre-BUY? | Risk | Selected segment evidence |
|---|---|---|---|
| NVIDIA | YES | STRONG | 31 bars; efficiency1.00, positive steps1.00, wick share0.257 |
| Gemini | YES | STRONG | 16 bars; efficiency0.997, persistence0.933, low negative travel |
| fomo | YES | STRONG | 9 bars; efficiency1.00, persistence1.00, smooth repetitive bodies |
| Rockstar | YES | STRONG | 10 bars; efficiency1.00, persistence1.00, wick share0.291 |
| tipr | **NO** | LOW | No segment met confluence. Recent 8-bar inspection efficiency0.555, negative travel0.222, wick share0.463 |
| YouTube | YES | STRONG | 21 bars; efficiency0.994, persistence0.90, range compression0.293 |

**5/6, không phải 6/6.** Không giảm thresholds để ép tipr thành STRONG sau khi biết lệnh lỗ. Replay chứng minh detector trên persisted pre-BUY inputs; không chứng minh sẽ tránh mọi lỗ/rug.

## D. Control Set

| Synthetic control | Risk | Incorrect hard reject? |
|---|---|---|
| Organic bullish with repeated retests | LOW | NO |
| Organic/noisy uptrend | LOW | NO |
| Normal volatile launch | LOW | NO |
| Strong green momentum with rejection/price discovery | MODERATE | NO |
| Healthy pullback/recovery | LOW | NO |

Có riêng dump→second staircase và impulse→staircase→acceleration cases: STRONG. Controls là fixtures, không phải ước lượng false positives trên population LIVE hoặc bằng chứng organic ownership.

## E. Candidate Pipeline

Trước: Fresh Attempt → History → Flow → V3 → JEV → Risk → final/execution.

Sau: History → Flow → manipulation analyzer/event → optional bounded Smart Money → V3 → JEV nhận cả V3 và manipulation evidence → **Risk veto STRONG với `CONTROLLED_MARKUP_STRUCTURE`** → final Risk/ownership/capital/quote/exit-feasibility/simulation/pre-sign → execution. Analyzer đặt sớm để vẫn log được risk khi V3 loại candidate. Không Watch, retry accumulation, reuse old verdict hay direct Smart Money authority.

Risk giữ authority: bullish JEV không override STRONG. MODERATE/LOW không tự reject. Các security/execution gates hiện tại vẫn bắt buộc.

## F. PnL Accounting

Lamports và token atomic quantities dùng BigInt. Raw wallet/capital fields được giữ để reconciliation không đổi nghĩa; UI/JEV dùng economic projection.

Với principal P, actual received quantity Q, remaining quantity q:

```text
remainingPrincipal = floor(P*q/Q)
allocatedPrincipal = P-remainingPrincipal
grossRealized = sum(confirmed SELL trading proceeds)-allocatedPrincipal
grossUnrealized = current remaining mark value-remainingPrincipal
grossPnl = grossRealized+grossUnrealized
grossPnlPct = grossPnl/P*100
netPnl = grossPnl-actual identified non-recoverable fees
```

BUY principal là reconciled validated ExactIn input, không phải toàn negative SOL wallet delta. Effective entry = principal / actual token quantity; token transfer effects/route impact nằm trong actual received quantity. Actual SELL gross proceeds được reconstruct từ wallet delta + actual network fee + net rent locked (rent refund âm). Thiếu fee/rent thì SELL gross/Net unknown, không dùng raw net wallet credit giả gross.

Current value là **GMGN mark-to-market**, không phải fresh executable liquidation quote; không trừ future exit fees. CLOSED current value0. Partial exits phân bổ principal trên Q, cộng realized lẫn remaining exposure; không mất realized gain khi bán một phần.

MFE/MAE dùng total gross lifecycle return, không trừ fee; mới BUY bắt đầu0, theo dõi những valuation thực có. Không biến old fee-inclusive extrema thành gross history. Legacy thiếu observations không backfill extrema tùy đoán. JEV retracement dùng gross high-water của remaining exposure, scale khi partial exit.

## G. Fee Accounting

Nguồn actual: reconciled Solana `receipt.meta.fee`, gồm base network + priority trong cùng tổng; không cộng priority quote lần hai. Confirmed failed transaction fees đã biết được tính; unknown không thành0. Paper có explicit simulated fee. Signature/execution dedup, không tính fill hoặc fee hai lần.

Đã trace `execution-provider.ts`: Jupiter `/swap/v2/order` expose signature/prioritization/rent estimates, dùng cho preflight/reserve, **không dùng làm fee đã trả**. `priceImpactPct`, slippageBps và actual execution difference không được coi thêm là fee. Embedded DEX/route/transfer effects giữ trong effective execution price, không trừ lần hai. Không fabricate separate priority/platform/route/transfer/other debit amounts nếu receipt không phân loại được.

Rent: token-account pre/post balances, wallet ownership, wSOL principal subtraction và associated-token create / SPL close instruction proof phải khớp wallet payer/refund recipient. Recoverable rent locked/released tách khỏi permanent fee. Thiếu proof trả null. BUY có unexplained extra SOL debit hoặc historical unknown rent làm Net unknown; không tuyên bố net exact chỉ vì biết network fee. Fee hiển thị ≥ cho identified lower bound khi completeness partial.

## H. Fee USD

Persist `FxEvidence {price,at,source}` trên execution. Reuse fresh GMGN SOL token-info snapshot, validate age trước claim; không thêm historical FX provider. SELL không đợi một FX request mới để thoát; missing cached FX → USD “—”. Paper fixture ghi source/time rõ.

Fee USD = actual fee lamports/1e9 × persisted snapshot SOL/USD. USD là **xấp xỉ theo snapshot có timestamp**, không khẳng định exact block-time historical FX. Restart/history không lấy current SOL rate chuyển lại các fee cũ. Total USD chỉ known khi mọi fee có FX evidence; breakdown giữ FX source/time. Lamports/quantities exact; display percentages/USD approximate.

## I. Position UI

PnL/PnL% trước đây từ wallet cost; nay từ gross projection. Fee SOL + ≈USD và Net riêng; tooltip PnL giải thích trước phí. Active Fee hover có per-execution totals và FX provenance. Entry Price dùng actual effective fill USD hoặc SOL/token nếu thiếu FX; signal price giữ riêng trong History. Current price vẫn GMGN snapshot, valuation label không hứa executable value.

Overview table thêm Fee/Net, scroll ngang trong wrapper; Position cards giữ design hiện tại. MFE/MAE gross. Legacy missing values hiện “—”, không null/undefined/NaN. [Positions preview](previews/accounting-positions.png).

## J. History Lifecycle

Reuse durable Position ID + existing executions, không tạo trade ID mới khi restart. Persist entry/fill quantity, principal/proceeds, signature, effective SOL/USD prices, fee/FX/rent evidence. Time ưu tiên receipt blockTime; thiếu thì đánh dấu RECONCILIATION_TIME.

Partial exits là array đầy đủ, mỗi fill giữ own qty/time/price/fees/signature. Average exit SOL price = total trading proceeds / total sold tokens; không dùng final price giả weighted average. Final Exit chỉ xuất hiện khi confirmed fills đã bán hết original qty và Position CLOSED/quantity0; UNKNOWN/submitted TX không finalize. Original execution reconciliation/unique execution_fills + atomic Position/execution persistence giữ idempotence. Trong report/UI timestamp/entry/final từ fill evidence; raw historical lifecycle không bị reset.

History summary: ENTRY → hold → THOÁT CUỐI, Gross/Fees/Net, PROFIT/LOSS. Expand: partial fills, effective vs signal price, entry/final/partial explorer links, entry/exit fees, rent, gross MFE/MAE. [Desktop](previews/accounting-history.png), [mobile](previews/accounting-history-mobile.png).

## K. DB Migration

Schema hiện tại chứa Position/Execution JSON, nên additive optional versioned fields đủ backward compatibility; không cần DDL migration/table song song. New fills persist accounting trong existing atomic boundary. API reconstruct deterministic views từ durable executions; legacy thiếu evidence trả null. Không bulk rewrite hoặc xóa historical data, không write production DB trong task. Restart test đóng/mở SQLite TEMP thật, tiếp tục final SELL fixture trên cùng lifecycle, không duplicate.

## L. JEV Input Changes

BUY nhận raw history + V3 + structured manipulation metrics/segments/policy/reasons/limitations. Prompt: positive momentum không chứng minh organic demand; pattern không chứng minh rug; STRONG deterministic veto không thuộc quyền override của JEV.

SELL nhận `grossPnlSol/grossPnlPct`, `feesPaidSol/feesPaidUsd`, `netPnlSol/netPnlPct`, full accounting, actual principal và gross MFE/MAE. Raw wallet debit đặt tên riêng; không gọi nó economic principal. Unknown fields giữ null. Prompt phân biệt gross trước phí/net sau phí; fee/PnL âm không tự tạo SELL. Existing security/manual/protective hierarchy, continuous Position collection và frozen JEV/revision guards giữ nguyên. Unknown gross có explicit flag để scheduler không hiểu substituted scheduling0 là actual unchanged PnL.

## M. Tests

- `pnpm typecheck`: PASS.
- `pnpm lint`: PASS.
- `pnpm test`: **341 passed, 0 failed/skipped/cancelled**.
- `pnpm exec node scripts/log-ui-test.mjs`: PASS.
- `pnpm exec tsx scripts/accounting-ui-test.mjs`: PASS; isolated browser-only, desktop/mobile390/768/1024/1550, actual effective entry, unknown legacy, Gross/Fee/Net, three exits/links, expanded lifecycle, overflow/invalid-values checks.
- `pnpm build`: PASS trong staging TEMP; không build vào root dist đang dùng bởi LIVE.

New tests kiểm: confluence/segments/acceleration/control/replay/future-candle exclusion, bullish JEV veto; zero fee1→1.1 SOL gross/net+0.1; fee0.02 gross+0.1/net+0.08; actual entry quantity/impact; recoverable rent/wSOL; single final;25/25/50 partials/weighted price/sum fees; SQLite restart; UNKNOWN cannot finalize; JEV wire separates accounting; paper reconciliation/fee không tự SELL. Existing safety tests được giữ; fixture monitoring thêm explicit entry ledger thay vì giả accounting từ bare Position.

Logs kiểm tra nằm TEMP, evidence/screenshots trong docs; không tạo bộ audit logs mới dưới data. [Browser verification](accounting-ui-verification.json).

## N. Remaining Limitations

- 5/6 real pre-BUY losses detected; tipr chưa bị guard chặn. Không hứa tránh mọi losing trade.
- Small synthetic control set, heuristic policy chưa calibrated trên broad live universe; có thể false-positive/negative. Historical STRONG segment trong lookback có thể chặn dù market đã đổi regime.
- History tối đa khoảng60m và phụ thuộc available provider bars; không full directional orderflow/liquidity timeline, không fraud proof.
- Old receipt/rent/FX evidence thiếu không thể tạo exact gross/net/entry USD bằng suy đoán. History cũ có thể hiện nhiều “—”.
- Network total known không có nghĩa category breakdown known. USD snapshot xấp xỉ, không historical exact FX. Mark value không guarantee executable proceeds.
- Gross excursions chỉ từ observed samples; không reconstruct mọi intraminute extreme. Raw wallet fields còn dùng cho capital/receipt reconciliation; không được label chúng là gross PnL.
- LIVE đang chạy chưa nhận backend mới. Public assets trên đĩa đã đổi; backend cũ có thể chưa cung cấp accounting fields cho tới activation.

## O. Safety / Activation

```text
real BUY: NO
real SELL: NO
transaction signed by task: NO
transaction submitted by task: NO
.env modified: NO
API keys/config/package/lock modified: NO
LIVE restarted/killed: NO
production DB migration/reset/writes by task: NO
provider calls by task: NO
root dist replaced: NO
```

Full suite có mock providers, paper fills, fake signature/sign counters; không private key/signing/broadcast thật. LIVE tự hoạt động có thể ghi DB hoặc giao dịch ngoài task, nên không tuyên bố production DB bất biến.

Staging path/build hash ghi trong verification. Khi người vận hành chọn áp dụng: dừng process đúng quy trình, `pnpm build`, rồi `pnpm live`. Không chạy build ghi đè root dist trong khi process LIVE còn dùng thư mục đó. Task này chưa thực hiện activation.

## 20 câu trả lời bắt buộc

1. **6/6 detected? NO — 5/6.** NVIDIA/Gemini/fomo/Rockstar/YouTube YES; tipr NO. Bảng C và replay JSON.
2. **Evidence:** relative compression/repetition, persistence/path efficiency, pullback/wick scarcity, local floors, smooth steps, segmented history; impulse/acceleration khi có.
3. **Future dump candle? NO.** Nến đóng trước snapshotAt≤entryAt; future candle regression không đổi verdict.
4. **Organic controls rejected? NO**,0/5 STRONG;1 MODERATE. Không suy thành false-positive rate0 ngoài fixtures.
5. **JEV override STRONG? NO.** Risk hard veto trước execution và pre-sign, reason CONTROLLED_MARKUP_STRUCTURE.
6. **PnL gồm fee? NO**, gross before fees; thiếu evidence hiện unknown.
7. **PnL% gồm fee? NO**, gross / actual entry principal.
8. **Fee types:** actual receipt network total gồm priority; known failed transaction fees; paper fee có label. Category split khác unknown nếu không có actual evidence.
9. **Price impact thành extra fee? NO.** Nằm trong effective fill economics.
10. **Slippage thành extra fee? NO.** Không double-count.
11. **Recoverable ATA rent thành permanent fee? NO.** Tách locked/refunded rent khi có proof; không đủ thì unknown.
12. **Bao nhiêu SOL/USD?** Mỗi trade theo actual records, không một con số chung. Browser fixture:0.005 SOL≈$0.75 entry; completed total0.02 SOL≈$3 tại fixture FX150. Historical thiếu FX hiện USD—.
13. **Net:** gross−actual identified incurred non-recoverable fees; unknown classification/rent/fee → Net—.
14. **Entry actual reconciled? YES** cho fill đủ evidence; SOL principal/actual received qty, USD khi persisted FX có. Không dùng signal giả entry.
15. **Entry Tx lưu? YES**, existing durable execution + accounting entry projection/links.
16. **Final Exit Tx lưu? YES**, confirmed final execution/position lifecycle.
17. **Partial exits đầy đủ? YES**, giữ mọi confirmed fill/own fee/qty/signature; restart regression25/25/50.
18. **Final Exit sau reconciliation? YES**; UNKNOWN không finalize.
19. **JEV nhận gross/fee/net riêng? YES**, integration wire assertion + explicit prompt semantics.
20. **Real transaction tạo trong task? NO.** Không real BUY/SELL/sign/submit; không activation LIVE.
