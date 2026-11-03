# BOT B — Trending Local Entry Structure implementation

**Cập nhật sau verification:** theo yêu cầu tiếp theo của user, khoảng22:02 ngày30/10/2026 đã tắt bypass và nạp backend V2 vào LIVE. Xem [activation report](local-structure-live-activation-2026-10-30.md). Nội dung bên dưới ghi lại phạm vi implementation/verification trước khi được cấp phép activation.

**30/10/2026 — Asia/Bangkok. IMPLEMENTED + VERIFIED; BACKEND STAGED, CHƯA NẠP VÀO LIVE.**

Đã sửa SW01–SW03: reuse recent context có provenance, tách Absorption khỏi Buyer Defense, và yêu cầu buyer-side activity củng cố cho Recovery. Không có age bucket hoặc universal drawdown/recovery percentage. Đây vẫn là detector từ market snapshots, không phải bằng chứng causal từng trade hoặc lời khẳng định giá chắc chắn tăng.

Evidence version mới: **`LOCAL_BUYER_DEFENSE_V2`**. Entry admission/authority policy giữ `TRENDING_FINAL_STRUCTURE_V1`, tránh đổi schema/config hoặc đánh đồng semantic version với permission mới.

**Build đã kiểm chứng:** `ead423060b70605ea92bf4a96ebf9abe001c8f8d4d30a5e32315a9ec231c05d3`, tại [`data/structure-generalization-build/dist/`](../data/structure-generalization-build/dist/build-info.json). Digest source khớp bản build này.

Bot LIVE có sẵn vẫn PID11500, build `0aab3d21387e3c98ed09c618266e6269a1714906e23e1f40d6d11d860c07dea6`, một Position đang quản lý. Không restart, không bật LIVE hoặc thay entry switch. Build được chạy trên snapshot riêng để không xóa/rebuild `dist/` của process đang chạy. **Detector mới chưa có hiệu lực trong backend LIVE cũ.** Static UI từ `public/` có thể được server hiện tại đọc lại khi reload; UI mới nhận diện evidence cũ vàa không trình bày nó thành V2 PASS.

## A. Files changed

Application:

- **Mới** [`src/structure-evidence.ts`](../src/structure-evidence.ts): local detector, bounded context selection/replay, versioned legacy revalidation, evidence diagnostics.
- [`src/sniper-structure.ts`](../src/sniper-structure.ts): giữ interface/wrapper/storage, delegation, admission context, semantic-version gate, backward-safe reconciliation.
- [`src/capital-flow.ts`](../src/capital-flow.ts): thêm optional observation provenance từ producer metadata; loại provenance khỏi denominator quality. Không đổi Flow regime formulas.
- [`src/engine.ts`](../src/engine.ts): Structure projection có evidenceCurrent; tách progress Absorption/Support, Recovery progress theo actual count. Không sửa monitor/SELL segment.
- [`src/trading-memory.ts`](../src/trading-memory.ts): compact Jev context nhận actual absorption/support/evidence/context/version; immutable sample vẫn clone Snapshot theo đường cũ.
- [`public/app.js`](../public/app.js): labels Absorption riêng, actual evidence tooltip, không ✓/success cho legacy proof hoặc false recovery progress.

Tests/browser fixtures:

- **Mới** [`tests/generalized-structure.test.ts`](../tests/generalized-structure.test.ts): 19 correctness regressions, bypass OFF.
- [`tests/fixtures.ts`](../tests/fixtures.ts): downstream approved-Structure fixture có fields mới; không dùng fixture này thay test thuật toán.
- [`tests/sniper-coordinator.test.ts`](../tests/sniper-coordinator.test.ts), [`tests/trending-final-gate.test.ts`](../tests/trending-final-gate.test.ts), [`tests/v52-controls.test.ts`](../tests/v52-controls.test.ts): curves có thêm separate live Support confirmations, giữ early/deadline/fresh-execution assertions.
- [`tests/sniper-recovery-regression.test.ts`](../tests/sniper-recovery-regression.test.ts): downstream veto fixture chỉ rõ approved evidence version.
- [`scripts/sniper-ui-cases.mjs`](../scripts/sniper-ui-cases.mjs), [`scripts/v52-ui-verification.mjs`](../scripts/v52-ui-verification.mjs): actual distinct evidence fields, legacy/bypass/no-fake-checkmark regressions.

Không xóa test hiện hữu. Các fixture curve thay vì chỉ auto-support từ absorption nay phải đi qua hai bước khác nhau. Danh sách changes/added chính xác: [summary](../data/structure-generalization-summary.json). Report này và logs/JSON/copy/build artifacts trong `data/` là outputs bổ sung; không import chúng vào Engine.

## B. Old formulas

Ký hiệu B/S là selected-window buy/sell USD, p=B/(B+S), n=B−S, v là price velocity, L là liquidity:

```text
Selling = S>0 && (S>=prevS || p<prevP || n<prevN)
          && (v<0 || p<prevP || n<prevN)
Absorption = S>0 && L>0 && L>=prevL
             && previousV known && v>=previousV && v<=0
Support = C consecutive Absorption                 // không signal riêng
Recovery = v>0 && p>prevP && n>prevN && liquidityAlive
PASS = C+1 consecutive Recovery
```

Old Watch không hydrate ordered context trước admission. Gap reset counters/sequence nhưng giữ peak/localLow. Audit counterexamples nằm trong [audit trước sửa](structure-watch-trending-audit-2026-10-30.md).

## C. New formulas / evidence

### Inputs, baseline, window và UNKNOWN

Input trực tiếp: current/previous price, liquidity, buy/sell USD, timestamp/window; buy transaction count dùng làm corroboration khi known. Không có invented holder/trader identity, unique buyer count hoặc per-trade flow. Bắt buộc finite positive price/liquidity, finite nonnegative B/S và ít nhất một directional total>0; incomplete/future/too-old observations không append.

Baseline là previous accepted observations của **cùng window/provider/source/mint**. Same/older timestamp không tăng counters; interval15s và maxGap120s giữ từ settings. Context được replay từ source đã ghi nhận, không fake trade history. Missing required fields → quality UNKNOWN/STALE, không seller deterioration/support failure. Missing buy counts giữ `null`; nó không tự xác nhận buyer activity hoặc thay thế mandatory buy USD evidence.

Các feature mới:

```text
sigmaS = S/(S+L)                 // rolling sell/liquidity share, bounded [0,1]
sigmaB = B/(B+L)                 // rolling buy/liquidity share
rho = (log(price)-log(prevPrice))/dtSeconds
d = max(0,-rho)
p = B/(B+S); n = B-S
liquidityAlive = L>0 && L>=prevL
countTrend = buyCount-prevBuyCount, nếu cả hai known; ngược lại null
```

Implementation tính share bằng equivalent ratio branch để tránh `S+L` overflow/tiny-denominator division. Không chia price response cho tiny sell USD. Net-trend không finite được ghi null, không giả numeric precision. Các shares/rates là **response proxies từ window totals**, không “marginal price impact per new sell USD”.

### Selling

Giữ concept/counter chính cũ: observable sell activity cùng deterioration của price hoặc p/n. Không prerequisite Initial Expansion/Peak Forming. C=2 consecutive qualifying evaluations latch sellingSeen. Đây là local pressure observation, không first selling của toàn lifecycle token.

### Absorption riêng

```text
absorption = S>0 && sigmaS>0 && sigmaS>=prevSigmaS
          && liquidityAlive
          && prevDownsideRate known && prevDownsideRate>0
          && d<prevDownsideRate
          && d*prevSigmaS < prevDownsideRate*sigmaS
```

So sánh response với comparable/nondecreasing normalized seller pressure; downside phải **thực sự yếu đi**, không chỉ bằng tốc độ giảm trước. C=2 consecutive absorption evaluations → `absorptionDetected=true`, `ABSORPTION_DETECTED`, localFloor=currentPrice. **Không tự đặt supportConfirmed.** Thiếu previous downside rate thì diagnostic absorption=null, không fabricate confirmation.

### Buyer Defense / Support riêng

```text
buyerActivity = B>0
stableBuyer = buyerActivity
           && B>=prevB && sigmaB>=prevSigmaB
           && p>=prevP && n>=prevN
           && (countTrend unknown || countTrend>=0)
floorHeld = localFloor exists && price>=localFloor && v>=0
defense = absorptionDetected && S>0 && floorHeld
       && stableBuyer && liquidityAlive
```

C=2 live defense evaluations → supportConfirmed, phase SUPPORT_CONFIRMED. Cumulative absorption latch và Support counter **khác nhau**. Đây là price-floor behavior kết hợp buyer-side USD/liquidity/pressure evidence; không phải chỉ “không lower low” hoặc một price band X%.

### Recovery / live confirmation

```text
strongerBuyer = stableBuyer && B>prevB
responseBacked = previous positive price-rate unavailable/zero
              || known buyCount increases
              || positiveRho*prevSigmaB <= prevPositiveRho*sigmaB

recovery = supportConfirmed && floorHeld && v>0
        && strongerBuyer && liquidityAlive && responseBacked
```

Price response được corroborate bởi strengthening buy totals/share và các feature khác. Positive price response quá nhạy so với recent buy share không tự trở thành momentum; known count growth có thể corroborate response, nhưng **không** thay mandatory B growth. Không universal minimum BUY USD hoặc fixed spike/recovery percentage.

C+1=3 consecutive recovery evaluations → PASSED / ENTRY_ELIGIBLE / reason RECOVERY_CONFIRMED. Không tăng Recovery confirmation count so với trước. `RECOVERY_ATTEMPT` chỉ khi actual predicate true và count>0; nếu buyer recovery chưa đạt thì giữ Support/search/failure state phù hợp, không giả progress.

Đã PASS: có thể giữ confirmation khi floor còn giữ, buyer-side totals/share/pressure/net không yếu đi và liquidity còn hợp lệ; positive fresh continuation sau T1 giữ **timely original confirmedAt**. Khi authority yếu đi, revoke PASSED về ACTIVE và clear confirmation để không dùng timestamp cũ cho một lần PASS mới. Không có predicted-profit/confidence score bịa thêm.

### Failure / gap

Một noisy low không tự xóa toàn bộ support. Seller-driven loss cần `price<floor && v<0 && sellPressure && !stableBuyer`, C lần liên tiếp mới clear defense/absorption và về SUPPORT_FAILED để tiếp tục trong original deadline. Dù chưa đủ C để tuyên bố support mất, failed recovery predicate đã chặn/tước PASS, nên không dùng tolerance này để ký trên broken recovery.

Gap>maxGap, đổi window hoặc source identity → clear sequence counters/latches, peak, floor, confirmation và dependent diagnostics. Không giữ stale peak/localLow từ chain đã đứt; không reset T0/T1, không blacklist. UNKNOWN không được tính thành một lần failure.

## D. SW01 — bounded recent pre-T0 context

Admission đọc **một** row `candidate_flow_states` cùng mint. Nó chỉ reuse observations thực sự đã tồn tại trong history này; không gọi candles/history provider mới, không nhập raw discovery listing hoặc arbitrary old market records.

Normalizer lưu optional provenance khi raw snapshot có: provider GMGN, freshness FRESH, fetchedAt khớp observation.at, source nonempty và address/mint. Context selector yêu cầu:

- finite/complete directional data; exact mint/provider/source identity;
- timestamp trước T0, chronological/cadence hợp lệ, không future;
- same selected window; gaps≤structureMaxGapMs;
- lookback≤`min(structureWatchTtlMs,2×structureMaxGapMs)` = **240s** ở settings hiện tại; newest point age≤120s;
- chỉ bounded valid suffix, tối đa120 observations. Mismatch/missing provenance phá suffix; không tự sort/merge để fake continuity.

Đây là provenance nội bộ của producer, không chữ ký từ GMGN. **Old Flow rows không có provenance không được mặc định trust.** Sau khi producer mới thu được dữ liệu có provenance, context mới có thể được reuse; không hứa mọi historical row hiện có đều dùng được ngay.

Replay có thể tìm selling/absorption và prior-defense context, nhưng admission ép status ACTIVE, quality UNKNOWN, supportCount/recoveryCount0, supportConfirmed=false, confirmedAt/lastObservedAt unset. `context` ghi firstAt/lastAt/window/source/count/priorDefenseObserved; T0/T1 vẫn là admission. Live phải xác nhận lại defense rồi recovery; không đợi một selling cycle hoàn toàn mới nếu recent evidence còn hợp lệ.

## E. SW02 — vì sao Buy=0/giảm đều không còn Support

Case100→99→98→97, B=0/S>0/liquidity stable:

- constant decline không còn absorption confirmation chỉ vì `v>=previousV`;
- ngay cả một sequence khác **có absorption thật trong proxy nhưng B=0**, `stableBuyer=false` và defense không tăng;
- Support có counter riêng, không inherit ✓ từ Absorption.

Hai regression riêng chứng minh cả các trường hợp này; supportConfirmed=false, recoveryCount0, không PASSED.

## F. SW03 — vì sao sell decay không tự tạo Recovery

Mandatory `strongerBuyer` yêu cầu B>prevB và normalized buy share không yếu đi. Falling B70→60→50→40 không đạt, kể cả p/n cải thiện vì S giảm nhanh hơn. Test còn seed **Support đã confirmed** trước khi áp chuỗi falling B/sell decay để chứng minh nó không chỉ bị chặn vì chưa có Support.

B giảm do rolling mechanics **không được kết luận là bearish hoặc tạo SELL**. Detector chỉ chưa có đủ positive evidence để xác nhận/giữ Recovery authority. Conservative false negatives vẫn có thể xảy ra khi genuine new buys bị old-volume decay che mất; không fake precision để bù.

## G. GMGN window semantics: cái biết và UNKNOWN

Exact inputs: `price.price`, `liquidity ?? pool.liquidity`, `price.buy_volume_<w>`, `price.sell_volume_<w>`, optional `price.buys_<w>`, với w chọn từ1m/5m/1h/6h/24h. Timestamp/provenance từ `_gmgnSnapshot`. Tổng volume/sell count/market cap không tự cấp bullish authority.

Đã inspect pinned CLI1.6.9: `/v1/token/info`, `getTokenInfo(...): Promise<unknown>`; artifact không có guarantee riêng cho rolling-vs-tumbling boundaries hoặc mapping snapshot difference→new trades. **Exact provider aggregation mechanics: UNKNOWN trong phạm vi bằng chứng này.** Không gọi provider live/history để suy đoán thêm.

Code xử lý chúng như **window-total snapshots**, có `providerAggregationGuarantee=UNKNOWN` trong evidence. Không cộng totals qua snapshots, không gọi B_t−B_prev là exact new buy USD, không coi S giảm là seller activity mới hoặc bằng chứng buyer return. B growth chỉ là observed aggregate strengthening được corroborate bởi floor/price response/share/persistence và counts nếu có. Không chứng minh independent buyer identities hoặc exact event order bên trong window. Đổi window/source không được nối counters.

Signals trực tiếp: raw sampled prices/liquidity/window USD/counts và producer timestamps. Signals **inferred**: seller-pressure deterioration, normalized downside response, absorption, defended floor, buyer-driven recovery proxy. Detector không được gọi các inference này là causal per-trade proof hoặc guaranteed future appreciation.

## H. Live confirmation — prehistory không tự PASS

Test recent history selling→absorption→support/early recovery trước T0:

```text
admit: ACTIVE, no confirmedAt, supportConfirmed=false, lastObservedAt unset
→ 2 live buyer-defense confirmations
→ 3 live recovery confirmations
→ PASSED, confirmedAt>T0
```

Sau admission không có intent/execution hoặc learning sample chỉ vì history đẹp. Stale/unknown-provenance/wrong-mint/future/mixed-window history không authorize. Context reset/gap không được giữ old floor để pass hoặc fail sequence mới.

## I. Token age

Không đưa age vào detector, không age bucket. Equivalent behavior cho3 phút/30 phút/6 giờ/2 ngày cho cùng kết quả trong wrapper tests; current outer Cheap/Security/Jev/Risk age policy giữ nguyên. Initial Expansion/Peak Forming chỉ là optional observation labels, không prerequisites của Selling.

## J. T0/T1/10-minute TTL và backward data

T0 tiếp tục là admission sau PRE_WATCH eligibility; T1 nguyên gốc, ≤T0+600.000ms. Context không đổi chúng; rediscovery/reopen không grant new window. Early confirmation vẫn được phép, chưa PASS đúng deadline thì EXPIRED; timely9:59 PASS có thể fresh-qualify sau deadline nếu defense/freshness còn hợp lệ.

Không thêm bảng hoặc migration schema. New optional JSON fields mang evidence version. `hasTimelyStructurePass` không nhận old semantic PASS thiếu V2 marker. Active/PASSED old rows khi component reconcile được hạ về cần revalidation trong **original window**, lưu `previousStructureEvidence` gồm phase/status/observations/counters/peak/floor/confirmation cũ. Nếu đã quá original deadline thì expire; không silently upgrade thành stronger evidence. Terminal history không được diễn giải thành V2 proof; UI không ✓/success cho legacy data.

**Production-copy verification:** native SQLite backup từ source readOnly, sau đó chỉ mở Store mới trên [copy](../data/structure-generalization-copy-verification.json). 31 Watch, một row cần revalidate; tất cả T0/T1 giữ nguyên. Counts và payload digests của13bảng positions/intents/executions/fills/tokens/records/learning/outcomes/evidence trước/sau **khớp**; integrity_check=ok. Không chạy writable app migration/revalidation lên active DB trong lượt này.

## K. Risk / execution / Position safety

`src/risk.ts` **không đổi**. PRE_WATCH vẫn kiểm tra eligibility; EXECUTION vẫn fresh pipeline sau Structure và giữ Security/compatibility/ownership/capital/duplicate/concentration/Jev/freshness. Semantic helper nay chỉ coi V2 PASS là current real proof; không weaken Risk.

BUY quote vẫn trước bound SELL probes20/50/100, rồi validators/simulation/final validation/pre-sign/signature persistence/receipt. Không đổi routers, slippage, exit feasibility, UNKNOWN/reconciliation, manual Position removal, Position/SELL architecture hoặc thêm Stop Loss/Max Hold/Max Positions. F01/F02 không sửa hoặc thêm fallback.

[Preservation](../data/structure-generalization-preservation.json):19protected files khớp trước sửa, gồm Risk/recovery-guard/GMGN/token-program/RPC/Executor/Jupiter/discovery/lifecycle/normal-live/exit/Position/Runner/config/`.env`/package/lock. Engine segment `async monitor()`→trước`async status()` khớp normalized bytes. Capital Flow chỉ thêm provenance contract, không đổi regime/classification; Memory chỉ mở evidence projection, không tạo LOSS/sample cho untraded Watch.

## L. Temporary bypass

Feature vẫn tồn tại, cùng một flag và metadata design, **không sửa recovery-guard.ts hoặc `.env`**. Getter unset/false/invalid mặc định OFF; `.env` operator hiện là **true**, giữ nguyên. Bypass không tạo Support/Recovery/PASSED giả; immutable Snapshot vẫn ghi temporary bypass và actual evidence.

19 new correctness tests chạy với flag **false**; test đầu assert điều đó. Existing TEMP-specific tests tự bật/tắt flag trong process fixture để kiểm tra feature riêng; chúng không được dùng chứng minh real detector correctness. Không thay đổi cohort exclusion/retrieval policy của Memory trong task này.

## M. Regression tests / UI / performance

19 test mới cover:

1. Assert bypass OFF cho correctness.
2. B0 + constant decline không absorption/support/PASS.
3. Absorption riêng → Support riêng → persistent recovery.
4. Có absorption nhưng B0 vẫn không Support.
5. Original sell-decay/negative-net counterexample.
6. Sell-decay kể cả khi Support đã confirmed.
7. One strong spike rồi sellers quay lại không PASS.
8. One noisy low vs persistent defense loss, TTL không reset.
9. Thin-liquidity price spikes không strengthening buyers không PASS.
10. Unknown/zero/tiny denominators bounded, không fake Support.
11. Gap/window/source reset cả floor/peak/counters, không T0/T1.
12. UNKNOWN/repeated/future sample không bearish hoặc count mới.
13. Bounded pre-T0/early-recovery context + live defense/recovery + rediscovery persistence; không tự tạo execution/learning sample.
14. Stale/unproven/wrong-mint/future/mixed context không authorize.
15. Equivalent local behavior cho các tuổi khác nhau.
16. Legacy PASS không tự thành V2 proof.
17. Normalizer provenance, không invented interval flow.
18. Timely9:59 PASS giữ đúng original confirmation khi positive fresh continuation vượt10m.
19. Reopen revalidate old row, preserve original evidence/deadline, không duplicate row/schema churn.

Existing fresh Security/concentration/compatibility/capital/ownership vetoes sau real Recovery tiếp tục đạt; no quote/intent trong ACTIVE Watch, removal/pre-sign revocation và signed recovery vẫn qua tests hiện có.

Full UI suite và actual localhost handler/browser verification PASS: desktop76px rows,1440/1024/390,0browser errors, CSRF/removal/reload/pending regressions. Thêm assertions Absorption✓ không tự Support✓; legacy PASS không hiển thị ĐỦ CẤU TRÚC hoặc ✓. Evidence/API tooltip expose actual supportCount, absorptionDetected, context, buy/pressure/net trends, price response, floor/liquidity và version; không confidence score bịa.

Không thêm GMGN request hoặc timer per-Watch. Context đọc một cached row tại admission, replay bounded≤120, cùng existing worker/coordinator/spacing/cooldown. Chưa đo live false-positive/false-negative rate hoặc throughput của detector mới; strict seller/liquidity/buyer conditions có thể defer real recoveries khi available snapshots không đủ corroboration.

## N. Required commands / kết quả

| Lệnh                                                        | Kết quả                                                                                                                                                                        |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm test`                                                 | **299 passed,0failed,0cancelled,0skipped**,38.591,5874ms; [log](../data/structure-generalization-tests.log)                                                                    |
| `pnpm typecheck`                                            | **PASS**, exit0; [log](../data/structure-generalization-typecheck.log)                                                                                                         |
| `pnpm lint`                                                 | **PASS**, exit0; [log](../data/structure-generalization-lint.log)                                                                                                              |
| `pnpm build`                                                | **PASS**, exit0, chạy với cwd snapshot `data/structure-generalization-build`; [log](../data/structure-generalization-build.log)                                                |
| UI suite trên snapshot                                      | **PASS**,0browser errors; [log](../data/structure-generalization-ui.log)                                                                                                       |
| Actual localhost browser verification trên snapshot/temp DB | **PASS**,0signatures/submit; [log](../data/structure-generalization-browser.log), [JSON](../data/structure-generalization-build/data/trending-final-gate-ui-verification.json) |
| Production-copy backward verification                       | **PASS**, ledger digest/counts khớp; [log](../data/structure-generalization-copy.log)                                                                                          |
| Secret audit                                                | **1.464 files,0findings**, không in configured secrets; [log](../data/structure-generalization-secrets.log)                                                                    |

Pnpm launcher Node20 engine warning và SQLite experimental warning không phải test failures; test/build/browser processes dùng pinned Node22.22.0. Source snapshot build không copy `.env`; test/browser dùng RAM/temp DB, fake providers hoặc PAPER/noscanner/blank wallet. Không gọi provider verification thật hoặc live smoke. Không thay `dist/` production; staging dependency junction được cleanup riêng, không xóa workspace dependencies.

## Required direct answers

| #   | Question                                                                  | YES / NO                                 |
| --- | ------------------------------------------------------------------------- | ---------------------------------------- |
| 1   | B0 + steadily falling price vẫn SUPPORT_CONFIRMED?                        | **NO**                                   |
| 2   | Falling B + faster falling S + negative net alone tạo RECOVERY_CONFIRMED? | **NO**                                   |
| 3   | Reuse bounded recent pre-T0 context?                                      | **YES**, chỉ trusted valid suffix        |
| 4   | Pre-T0 context alone tạo PASSED?                                          | **NO**                                   |
| 5   | Live post-T0 confirmation required?                                       | **YES**                                  |
| 6   | Token age chọn algorithms khác nhau?                                      | **NO**                                   |
| 7   | Initial Expansion mandatory?                                              | **NO**                                   |
| 8   | Rediscovery reset T0?                                                     | **NO**                                   |
| 9   | Provider UNKNOWN tính thành Support failure?                              | **NO**                                   |
| 10  | Gap reset evidence chain mà không reset T0?                               | **YES**                                  |
| 11  | One isolated positive spike lập tức Recovery Confirmed?                   | **NO**                                   |
| 12  | Structure PASS bypass fresh Risk EXECUTION?                               | **NO**                                   |
| 13  | Thêm fixed drop/recovery percentages?                                     | **NO**                                   |
| 14  | Bật lại Sniper discovery?                                                 | **NO**                                   |
| 15  | Thực hiện giao dịch thật từ implementation/verification?                  | **NO**; runtime LIVE cũ tiếp tục độc lập |

**Kết quả: IMPLEMENTED AND VERIFIED — backend build staged, chưa triển khai vào process LIVE.** Không đổi active strategy dataset, không bật/tắt bypass/LIVE và không tạo real signature/submission từ task. Snapshot data là inference input, không forecast chắc chắn về giá. Exact provider aggregation/event semantics và empirical trading accuracy vẫn là giới hạn đã nêu.
