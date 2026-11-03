# Structure Evidence V3 — implementation report

Hoàn tất 2026-11-01. Scope: Candidate Structure, bounded Smart Money evidence, JEV context, optional Position enrichment và Log mapping. Không thêm provider, Wallet Activity fanout, Watch/Deferred, stop-loss hoặc statistics.

## A. Files Changed

| File | Thay đổi |
|---|---|
| `src/smart-money.ts` (mới) | Normalize snapshot/events, nullable fields, dedup, temporal alignment, participant metrics/cluster/coverage/status |
| `src/market-history.ts` | Refactor `oneShotStructure` tại chỗ thành V3; timestamps/freshness/price inference; giữ parser và USD mapping K-line |
| `src/gmgn.ts` | `smartMoneyFeed`: existing run/coordinator + real `track smartmoney` route, bounded100; optional failures trả unavailable; legacy SELL helper reuse normalized feed |
| `src/one-shot-entry.ts` | Structure trước JEV, TTL0 feed mỗi attempt, structured event, final re-evaluation |
| `src/candidate-attempt.ts` | Stage order theo pipeline mới |
| `src/risk.ts` | Kiểm phase/history freshness tại qualification/execution; bỏ Smart Money → direct SELL authority |
| `src/jev.ts` | BUY/SELL instructions phân biệt inference/current flow/capped participant evidence, missing ≠ no buyers |
| `src/domain.ts` | Optional Position smartMoneySupport và JEV observed Smart Money timestamp/status; không migration |
| `src/engine.ts` | Optional async Position enrichment, revision protection, JEV context, stale Smart Money guard tại apply/pre-sign |
| `public/app.js` | Readable STRUCTURE_EVIDENCE_V3 row, full raw JSON, Overview stage order/caption; không redesign tab khác |
| `tests/structure-v3.test.ts` (mới) | Price/flow/smart-money/candidate/wire/cache/concurrency/freshness regressions |
| `tests/core.test.ts`, `tests/trending-final-gate.test.ts` | Cập nhật contracts direct-Smart-SELL và stage order theo yêu cầu mới; giữ security/liquidity checks |
| `scripts/log-ui-test.mjs` | Browser case cho V3 row và expanded JSON |

Audit trước sửa: [structure-evidence-v3-plan.md](structure-evidence-v3-plan.md). Integrity/verification: [structure-v3-verification.json](structure-v3-verification.json).

## B. Old Structure

`oneShotStructure` cũ dùng nến đỏ có volume làm selling; nến xanh sau đó làm absorption; low/close không giảm làm buyerDefense; close vượt open nến đỏ làm recovery. Kết quả `ONE_SHOT_BUYER_DEFENSE_CONFIRMED` không giữ các timestamp pha trong output. Sau recovery, hàng chục nến flat vẫn giữ các flag; `at` lấy market timestamp mới. JEV chạy trước Structure nên không nhận result này.

Candidate dùng variables/UUID riêng, không đọc candidate_flow_states; kiến trúc Fresh Attempt đó được giữ. Legacy candidate_flow_states không được đưa lại vào V3. Existing Position dùng Smart Money SELL boolean và await feed trước saveObservation; cấu hình EXIT có thể tạo protective SELL trực tiếp.

## C. Structure Evidence V3

```text
Trending appearance → UUID mới
→ Cheap Filter → Fresh Security → Compatibility → History → Current Capital Flow
→ bounded fresh Smart Money snapshot [optional]
→ STRUCTURE_EVIDENCE_V3
    priceStructure: PRICE_INFERENCE
    marketFlow: CURRENT_MARKET_FLOW
    smartMoney: TIMESTAMPED_PARTICIPANT_FLOW / GMGN_SMART_MONEY_SUBSET
    conclusion: supportLevel + categorical confidence + reasons + limitations
→ JEV advisory BUY/SKIP
→ deterministic Risk
→ Final Analysis/re-evaluate evidence age/current market/security/compatibility/holders
→ ownership/capital/existing quote, exit-route probes, simulation, pre-sign → execution
```

Không có `buyerDefense=true` được dùng để che provenance. Không còn reason `ONE_SHOT_BUYER_DEFENSE_CONFIRMED` ở one-shot implementation. Tên thành công là `PRICE_RECOVERY_INFERRED_WITH_CURRENT_FLOW`.

`supportLevel` là INSUFFICIENT/WEAK/MODERATE/STRONG/CONFLICTED; confidence hiện là cùng phân loại định tính, **không phải xác suất đã hiệu chỉnh**. Components luôn được gửi; không dùng arbitrary numeric score.

`passed` còn lại là **deterministic price/current-flow eligibility**, không có nghĩa market-wide buyer defense được chứng minh, không phải BUY authority. Smart Money positive/negative/missing không tự cấp hoặc thu execution authority. Price eligible + current flow supportive + Smart Money missing có thể MODERATE; price/current-flow supportive + aligned Smart SELL có thể CONFLICTED nhưng vẫn để JEV cân nhắc. JEV BUY và mọi Risk/execution checks vẫn bắt buộc. Current flow thực sự weakening thì eligibility không pass, Risk sẽ chặn sau advisory JEV.

## D. Price Evidence

Nguồn vẫn GMGN historical1m OHLCV và mapping đã dùng trước đây: `volume` USD, `amount` không được dùng thay USD. Không đảo unit theo skill docs đang mâu thuẫn, không thêm price-drop/rebound percentage.

Các phép kiểm tương đối:

- **Selling visible in price:** close<open và known total volume>0. Không gọi seller-orderflow proof.
- **Absorption inferred:** nến sau selling có volume, close>open, close>tracked low.close và low không xấu hơn low nến trước. Đây là price response, không tuyên bố actual sells đã được hấp thụ.
- **Floor holding:** một nến sau absorption có low và close không thấp hơn nến trước. Floor price được giữ để phát hiện subsequent lower-low; breach làm reset các pha sau.
- **Recovery inferred:** một nến sau floor đóng trên open nến selling tham chiếu. Giữ recovery confirmation time theo thời điểm nến đóng.
- **Momentum:** last close không thấp hơn previous close và current price không dưới last close. Điều kiện này không tự làm mới timestamp pha nếu chỉ flat.
- Gap giữa nến khác resolution1m làm reset chuỗi; nến đỏ mới có volume bắt đầu chuỗi selling mới.

Output giữ sellingAt, absorptionAt, floorAt, recoveryConfirmedAt, latestRelevantAt, evidenceFrom/evidenceTo, sequenceAgeMs, maxSequenceAgeMs, historyFresh và historyCoverage. `historicalRecoveryInferred` có thể true trong khi status STALE/recoveryInferred false, để giải thích đúng chuyện đã xảy ra trước đó.

## E. Market Flow Evidence

Reuse `attemptFlow`/`normalizeFlowObservation`/`deriveFlow`; giữ source window, net buy USD, pressure, regime/features, currentWindow có known/unknown buy/sell volume/count, observedAt/freshness và observations.

Candidate vẫn chỉ có **một current directional observation**. Không xếp 1m/5m/1h tại cùng NOW thành t1/t2/t3. Historical directional flow ghi UNKNOWN; acceleration/change/slope thiếu vẫn null, không giả “buy pressure improving”. Market SUPPORTIVE kế thừa điều kiện net>0 và buyPressure>0.5 đang có; đây là current window, không phải historical flow hay capital deposits.

## F. Smart Money Evidence

Nguồn: `Gmgn.run([track, smartmoney, --chain, sol, --limit,100])` → installed CLI → GET `/v1/user/smartmoney`. Không thêm token/from/to không được hỗ trợ; filter `base_address===mint` ở local. Không Wallet Activity, không traders/holders fanout, không token-trader aggregate timeline.

Normalized event giữ mint, maker, side, timestamp milliseconds (từ provider timestamp seconds/milliseconds), amountUsd, transactionHash và tags. Missing/blank/invalid numeric fields giữ null; không lấy fetch time giả trade time hoặc cost basis thay SELL amount.

Dedup theo mint+transaction hash, không theo amount. Duplicate cùng transaction không bị đếm đôi. Nếu representations cùng hash mâu thuẫn side/maker/value/time, giữ event với directional/value unknown và tăng conflictingTransactions; không tạo hai phía flow. Event thiếu hash/maker/time/side/USD vẫn thấy trong aligned timeline nhưng không được dùng tạo support/cluster.

Alignment cho Candidate:

- Giữ event timeline từ selling start đến current evaluation.
- BUY được dùng hỗ trợ recovery chỉ khi xảy ra **sau khi nến absorption đóng**.
- Metric/support chỉ dùng các event còn trong `structureMaxGapMs` so với NOW; old buys/pre-selling/pre-response buys không tạo current support.
- SELL dùng recent aligned interval; BUY counts/USD là **recovery-eligible BUYs**, không phải toàn bộ BUY lifetime. Alignment cutoff được xuất rõ trong result.
- Snapshot freshness riêng theo `maxSnapshotAgeMs`. Fresh fetch không biến old trades thành fresh support.

Status: BUY_SUPPORT, SELL_PRESSURE, MIXED, NO_MATCH_IN_RETURNED_FEED, INSUFFICIENT_COVERAGE, UNAVAILABLE. Nếu có cả hai phía, dùng temporal last-side response và computed net để phân biệt response; không dùng magic3 buyers, dollar minimum hoặc new percentage. `computedNetBuyUsd=eligible buy USD−recent aligned sell USD`; không đọc/reinterpret provider `netflow_usd` đang có sign conflict.

Metrics: buys/sells, distinctBuyers/distinctSellers, buyUsd/sellUsd/computedNetBuyUsd. Zero event count chỉ nói returned aligned sample; missing-side USD giữ null. Missing feed/stale snapshot không có usable totals. Totals không finite không được dùng tạo support.

Cluster tự derive trong existing evaluation window, tối thiểu **hơn một distinct maker** đúng nghĩa “multiple”; nhiều transaction một maker vẫn một buyer. Luôn `independentOwnersProven=false`. Không giả provider có cluster field.

Coverage giữ requestedLimit/returnedCount/oldestTimestamp/newestTimestamp/coverageSeconds/tokenMatchedCount/distinctMakerCount/alignedCount/usableCount/completeness=UNKNOWN_CAPPED_FEED, cùng source/fetched observedAt/events/limitations. Khoảng oldest→newest không được gọi là completeness hoặc historyCoverage100%.

## G. Freshness Fix

Không thêm time threshold bí mật. Reuse `structureMaxGapMs` hiện có, default120s, làm maximum gap từ latest relevant price response tới current evaluation. Candle-tail freshness dùng existing `maxSnapshotAgeMs+1m`; request fetch timestamp dùng `maxSnapshotAgeMs`.

Sau recovery, chỉ **positive non-flat price progress với volume trong chuỗi còn hiệu lực** mới cập nhật latestRelevantAt. Flat bars không làm mới tuổi pha. Nếu gap từ relevant response quá lớn, sequence expired và không được một tiny bounce sau hàng chục flat bars hồi sinh; phải có selling/sequence mới. Risk kiểm lại latestRelevantAt và underlying history fetch/tail trước qualification/execution, thay vì chỉ tin result.at mới.

Regression 56 flat candles: `historicalRecoveryInferred=true`, `priceStructure.status=STALE`, `recoveryInferred=false`, `passed=false`. Sau đó sửa last close tăng nhẹ vẫn false. Pump-only không sinh selling/absorption/floor/recovery.

Final Analysis reuses objective history trong cùng attempt nhưng **rechecks age trực tiếp**, không pretend đã fetch history mới. Nếu pipeline chậm quá freshness budget thì reject, không bypass hoặc tạo Watch.

## H. JEV Input

Sanitized full fixture example: [structure-v3-example.json](structure-v3-example.json), gắn rõ fixtureOnly/notProductionEvidence. Đây là ví dụ test, không phải production capture.

```text
attemptId
token identity / tokenAge
marketHistory: actual candles + coverage + timestamps + preCreation NOT_AVAILABLE
market / capitalFlow
structureEvidence:
  version: STRUCTURE_EVIDENCE_V3
  priceStructure: PRICE_INFERENCE + phase timestamps + sequenceFresh
  marketFlow: CURRENT_MARKET_FLOW + source window + observedAt + metrics
  smartMoney: GMGN_SMART_MONEY_SUBSET + normalized events + alignment + coverage
  conclusion: supportLevel / confidence category / reasons / limitations
security [raw removed] / compatibility / freshness
```

BUY instruction nói rõ capped subset; absence of records≠absence of buyers; missing Smart Money không phải lý do SKIP tự thân; price recovery không phải market-wide order-flow proof; rolling current flow không phải history; không invent liquidity history/independent owners/Level4. Trade Memory/Human Experience vẫn không có trong fresh BUY context.

SELL instruction cũng nhận Smart Money support với limitations. Existing JevExitScheduler vẫn structuredClone frozen input; collectors có thể tiếp tục cập nhật trong lúc JEV chờ. No API key/signing secret đưa vào evidence/event/JEV input.

## I. Candidate Behavior

Giữ Trending appearance→UUID mới→evaluate once→BUY/OUT. Không Watch, Deferred, Pending Review, polling retry hoặc chờ tích lũy vài phút.

Mỗi attempt gọi fresh info/security/history/flow, `smartMoneyFeed(TTL0)`, fresh JEV, Risk, Structure locals. Không dùng verdict UNKNOWN/reject của attempt trước. Coordinator có thể coalesce **đồng thời** cùng request key, nhưng không dùng verdict cache; attempt sau đã hoàn tất previous fetch sẽ request mới. No-match/provider unavailable vẫn gửi rõ cho JEV, không tự OUT vì thiếu Smart Money.

STRUCTURE stage ghi evidence trước JEV. Invalid/stale price sequence fail tại STRUCTURE. Có price sequence nhưng flow conflict vẫn được JEV nhìn thấy trước khi deterministic Risk quyết định eligibility. Structured event `STRUCTURE_EVIDENCE_V3` chứa attemptId/mint/component status/support/timestamps/coverage/matched events/reasons/limitations/full evidence.

Log row hiển thị Price/Market Flow/Smart Money/Support và distinct buyer/seller counts khi thật sự có usable participant evidence. NO_MATCH không được trình bày như “không có buyers trên thị trường”. Expanded JSON giữ full payload. [Browser fixture screenshot](previews/structure-v3-log.png).

## J. Position Behavior

Position vẫn continuous bounded concurrent collection, không chuyển sang candidate one-shot. Không thêm K-line call cho mỗi Position. Reuse cùng Smart Money normalization/participant assessment với recent Position window `max(entryAt,now−structureMaxGapMs)`; không claim Position có historical price recovery nếu chưa lấy candles.

Security/info/value/flow save xong trước khi bắt đầu optional Smart Money enrichment. Có một enrichment job cho mỗi Position; shared coordinator single-flight/cache cùng bounded feed100 cho nhiều Position. Position provider cache TTL `min(30s,maxSnapshotAgeMs)`, không cache support verdict dùng cho decision mới. OFF bỏ qua collection; WARNING và legacy EXIT đều là **advisory**, không direct copy trading.

Enrichment xong chỉ áp vào managed OPEN Position cùng mint/quantity; đọc current state, không ghi đè newer valuation/flow. Thay đổi status/events/usable counts làm tăng decisionRevision. JEV được cung cấp cả BUY/SELL/maker/timestamp/USD/hash; stale context được thay bằng unavailable. Collector không await Smart Money/JEV nên A chậm không chặn A/B/C price/state updates.

Existing revision/quantity/flow/material-price/security/freshness guards giữ nguyên. Bổ sung observed Smart Money time/status vào JEV decision; nếu có usable evidence trong input mà đã quá `maxSnapshotAgeMs`, guard discard cả tại apply và checkExitAuthority trước ký. Missing optional data không tự veto các strategic reasons khác. Security/manual/liquidity-collapse vẫn superior protective authority; không SELL vì PnL âm hoặc tuổi vị thế.

Đã loại direct Smart Money EXIT branch khỏi exitDecision. Config cũ vẫn parse để tương thích, nhưng EXIT không còn nghĩa tự SELL theo một participant event.

## K. Tests / Build

- `pnpm typecheck`: PASS.
- `pnpm lint`: PASS.
- `pnpm test`: **324 passed / 0 failed / 0 skipped / 0 cancelled**.
- `pnpm exec node scripts/log-ui-test.mjs`: PASS, gồm V3 readable row và expanded JSON. Browser-only fixture, không server/trading calls.
- `pnpm build`: PASS tại staging TEMP `gmgn-v3-build-1a383713a3ab4a5d8634e8299bd6adac`; không xóa/ghi đè dist của LIVE.
- Regression log nằm trong TEMP: `gmgn-structure-v3-full-tests.log`, không tạo bộ test logs trong data.
- Không thấy dedicated deterministic replay command trong package scripts; `structure-v3.test.ts` dùng timestamp cố định cho deterministic sequence replay fixtures.

Các case bắt buộc đã có: recent sequence,56 flat/stale + no resurrection,pump-only; SELL→later distinct BUY makers,same maker nhiều BUY,duplicate/conflicting hash,aligned sell pressure,no-match,optional provider failure; pre-selling/pre-response BUY,post-response BUY,stale snapshot; same mint next attempt new feed+UUID; JEV wire/provenance/limitations; raw cache vs TTL0; Risk phase-age guard; SELL Smart Money age guard; A/B/C collectors trong lúc optional Smart Money/JEV pending. Existing full suite tiếp tục kiểm frozen snapshots, stale JEV cannot sell, transaction/ownership/security/risk gates với mock providers.

Hai test contract cũ được cập nhật có chủ đích: Structure chạy trước JEV, và Smart Money EXIT không direct SELL. Không bỏ test hoặc skip safety check để làm suite xanh.

## L. Remaining Limitations

- Không có Level4 historical market-wide BUY/SELL.
- Smart Money feed capped/recent, có thể không chứa candidate hoặc không phủ các pha. **Missing event != no buyers.**
- Historical liquidity chưa có. Không nói liquidity đã healthy suốt recovery.
- Absorption/recovery của OHLCV vẫn là **inference**; short bounce có thể giống recovery trên price structure.
- Không thêm ngưỡng minimum60m/coverage hoặc price percentages; một chuỗi ngắn đủ pha vẫn có thể đủ price eligibility. Coverage/timestamps được gửi để JEV thấy rõ, không gọi đó là full60m proof.
- Distinct maker không chứng minh distinct owner; feed/tags có thể trễ hoặc bị selection bias.
- Smart metric là returned eligible subset, không phải toàn thị trường; USD dùng numeric evidence, không dùng để size/settle transaction.
- Shared provider cooldown vẫn có thể ảnh hưởng các bắt buộc GMGN reads sau đó theo policy có sẵn. Optional Smart Money failure được đánh dấu unavailable, không giả dữ liệu hoặc tự halt Engine.
- Không live benchmark/probe provider trong implementation này; source capabilities dựa audit trước, integration bằng fixtures.

## M. Safety / Activation

```text
real BUY: NO
real SELL: NO
production transaction signed: NO
production transaction submitted: NO
.env modified: NO
package/lock/config/skills modified: NO
LIVE restarted/killed: NO
production DB migration/reset by implementation: NO
new provider or Wallet Activity fanout: NO
```

Tests dùng in-memory/temp stores, paper fills và mock execution/signing hooks, không wallet production/network trade. Protected-file hashes khớp baseline trong verification artifact.

**V3 chưa được nạp vào tiến trình LIVE đang chạy.** Source và build staging đã được kiểm tra; không tự thay runtime của bot đang giữ vị thế. Khi người vận hành chọn thời điểm áp dụng: dừng process hiện tại theo quy trình vận hành, chạy `pnpm build` rồi `pnpm live`. Không chạy build trực tiếp vào dist trong lúc LIVE đang dùng thư mục đó. Public Log assets đã sửa trên đĩa, nhưng event V3 chỉ xuất hiện khi backend mới được nạp.
