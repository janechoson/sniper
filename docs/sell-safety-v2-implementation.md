# SELL Safety Architecture V2 — implementation report

Ngày 2026-11-02, Asia/Bangkok. Implementation dựa trên source hiện tại và `position-sell-architecture-jev-authority-audit.md`. Không có Git repository để đối chiếu commit; danh sách thay đổi được đối chiếu hash với baseline trước sửa. Verification: [sell-safety-v2-verification.json](sell-safety-v2-verification.json).

## A. Executive Summary

Đã tách Strategic Exit Analyst, Deterministic Protective Authority và Execution Safety. JEV lỗi/timeout/response không hợp lệ trả NO_DECISION, không tạo affirmative HOLD và không xóa đề xuất SELL trước đó. Security critical, liquidity collapse và structural-collapse confluence có authority riêng, không đợi JEV. Mọi SELL vẫn qua ownership, tracked quantity, claim/intent, Jupiter route, simulation, pre-sign và reconciliation.

Không thêm stop-loss theo PnL, phần trăm giảm giá hoặc thời gian giữ. Gross/Fee/Net và history được giữ nguyên. 385 tests PASS; typecheck, lint, browser fixtures và staging build PASS. **Chưa kích hoạt vào LIVE; root dist giữ nguyên.** Không chứng nhận khả năng thoát mọi token hoặc SLA provider từ fixture tests.

## B. Files Changed

| File | Thay đổi |
|---|---|
| `src/exit-safety.ts` — mới | Typed protective evidence/authority, M1 structural confluence, freshness, recovery predicates, retry, priority và material route comparison |
| `src/position-history-monitor.ts` — mới | Lane OHLCV Position có giới hạn queue/concurrency/cadence, độc lập collector valuation |
| `src/domain.ts` | Explicit analyst states, protective lifecycle/retry, transaction validity/investigation và projection fields; optional JSON fields |
| `src/engine.ts` | Early security/liquidity evaluation, evidence persistence, authority resolver, revalidation, narrow intelligence fallback, retry và latest JEV scheduling |
| `src/jev.ts`, `src/jev-exit-scheduler.ts` | NO_DECISION semantics, preserved parsed analyst response, dirty latest rerun, bounded eligibility/concurrency |
| `src/executor.ts`, `src/solana.ts` | Durable protective proof, transaction validity metadata, bounded UNKNOWN investigation và alerts; giữ receipt/fill authority |
| `src/store.ts` | Lifecycle persistence; explicit legacy protective/HOLD normalization; reconciliation result and retry transition |
| `src/normal-live.ts` | Startup với signed pending vào recovery-only, entries disabled; không tự bật entries sau recovery |
| `src/gmgn.ts` | Optional TTL0 security revalidation; Position minute-aligned K-line cache key/coalescing, giữ candidate default |
| `src/exit-feasibility.ts` | Callback sau background quote update để safety/JEV thấy route deterioration |
| `src/position-view.ts`, `public/app.js`, `public/style.css` | Tách analyst/protection/execution status; NO_DECISION, NO_ROUTE và UNKNOWN rõ; tăng tương phản block JEV |
| `scripts/test-env.mjs` | Chặn fixture đọc production credential files, external fetch và dùng TEMP DB/key path |
| `tests/sell-safety-v2.test.ts` — mới | Policy, analyst failures, scheduler, integration, retry, UNKNOWN, restart, fallback, concurrency fixtures |
| `tests/{capital-flow,jev-exit,normal-live,sniper-recovery-regression}.test.ts` | Cập nhật contracts có chủ đích: lỗi không còn HOLD, startup recovery-only, protection phải có typed evidence |
| `scripts/accounting-ui-test.mjs` | Browser assertions và screenshot cho safety states, giữ accounting/lifecycle cases |

Không đổi `.env`, package/lock, strategy config hoặc root dist. Không cài dependency/provider mới. Full hashes và các file mới trong verification artifact.

## C. Before / After SELL Architecture

```text
BEFORE
Collectors -> security -> price/FX/valuation -> flow -> JEV -> opportunity
                                                    error -> implicit HOLD
opportunity -> GMGN safety -> executor -> receipt reconciliation

AFTER
Security ---------------------\
Liquidity before price/FX ------> Exit Safety Evidence -> typed PROTECTIVE --\
Bounded M1 + current flow ------/                                           |
Valuation/flow/route -> JEV -> explicit DECIDED_* / NO_DECISION_* -> STRATEGIC |
Manual -------------------------------------------------------------------+
                       priority resolver -> execution safety -> reconcile
```

Collector không await JEV hoặc Position history lane. Authority không đồng nghĩa transaction đã gửi. Signed pending vẫn được reconcile trước khi tạo SELL mới.

## D. Authority Matrix

“Có điều kiện” nghĩa authority còn hiệu lực, đúng tracked quantity và toàn bộ execution gates PASS.

| Trigger | Authority | Needs JEV? | JEV can veto? | Can SELL? |
|---|---|---:|---:|---|
| Valid JEV FULL | STRATEGIC | YES | N/A | Có điều kiện |
| Valid JEV HOLD | STRATEGIC assessment | YES | N/A | Không tạo SELL; không veto protective |
| JEV timeout | NONE — NO_DECISION_TIMEOUT | — | — | Không tạo SELL mới; authority cũ vẫn phải được kiểm tra |
| Security critical | PROTECTIVE / SECURITY_CRITICAL | NO | NO | Có điều kiện |
| Liquidity collapse | PROTECTIVE / LIQUIDITY_COLLAPSE | NO | NO | Có điều kiện |
| Structural collapse confluence | PROTECTIVE / STRUCTURE_COLLAPSE hoặc MANIPULATION_STRUCTURE_BREAKDOWN | NO | NO | Có điều kiện |
| OUTFLOW alone | Evidence | — | — | Không |
| Negative PnL alone | Context | — | — | Không |
| Manual FULL | MANUAL | NO | NO | Có điều kiện |
| Manual PARTIAL | MANUAL | NO | NO | Có điều kiện |
| Signed UNKNOWN | EXECUTION LOCK | NO | NO | Không cấp SELL mới trong cùng wallet/mode khi chưa giải quyết |

## E. JEV State Model

Affirmative: `DECIDED_HOLD`, `DECIDED_PARTIAL_SELL`, `DECIDED_FULL_SELL`. No conclusion: `NO_DECISION_PROVIDER_FAILURE`, `NO_DECISION_TIMEOUT`, `NO_DECISION_INVALID_RESPONSE`, `NO_DECISION_SCHEMA_FAILURE`, `NO_DECISION_INSUFFICIENT_DATA`, `NO_DECISION_LOW_CONFIDENCE`. Stale/superseded response: `SUPERSEDED`.

Parser vẫn kiểm action/fraction/confidence/schema. Insufficient data hoặc confidence dưới existing minimum trở thành NO_DECISION. Parsed analyst response được giữ ở `analystResponse` khi có response parse được; transport/JSON failure chỉ có failure metadata, không fabricate raw answer.

`lastAnalystAttempt` lưu lần gọi mới nhất; `jevExit` có thể vẫn là quyết định hợp lệ trước đó. NO_DECISION được persist/log rồi return trước nhánh revoke unsigned strategic opportunity. Quyết định cũ **không được gia hạn**: age, quantity, revision, material state và pre-sign guards vẫn áp dụng. Valid HOLD mới, cùng state và đủ confidence, vẫn có thể thay thế unsigned strategic SELL theo semantics trước; không xóa protective.

## F. Protective Exit Policy

Authority V2 giữ version, typed kind/severity, FULL_SELL/10000bps, tracked remaining quantity, observedAt/expiresAt, source components và limitations. Security critical là CRITICAL; liquidity/structure là HIGH. New V2 priority không match reason string.

Lifecycle gồm DETECTED/AUTHORIZED/WAITING_EXECUTION/BLOCKED/REVALIDATING/SUBMITTED/RECONCILING/COMPLETED/SUPERSEDED; execution state và opportunity persistence giữ tiến độ. Revalidation không biến thời gian fetch thành thời gian event, không gia hạn proof khi provider lỗi. Security/liquidity proof dùng existing `maxSnapshotAgeMs` (default45s); structure proof dùng `min(historyTo,flow.at)+structureMaxGapMs` (default120s). Runtime override được dùng trực tiếp.

Recoverable predicates được kiểm lại trước claim và sau simulation; synchronous before-sign guard kiểm authority vẫn tồn tại, fresh, đúng quantity. Provider thất bại có thể giữ **recent valid proof** trong hạn gốc; hết hạn thì BLOCKED, chờ evidence mới. Không coi toàn bộ critical security evidence là irreversible. Để clear security phải có explicit disproof của các code cũ; field biến mất/UNKNOWN không phải recovery.

## G. Structural Collapse Evidence

Nguồn: actual closed M1 OHLCV từ GMGN; latest tối đa12 bars, baseline ít nhất3 bars và3 response bars, contiguous đúng60s. Missing/stale/gap/insufficient -> không structural authority. History fetch/tail phải trong existing `maxSnapshotAgeMs+60s` (default105s).

Policy tương đối, có thể đọc trực tiếp trong `exit-safety.ts`:

1. Floor là minimum low của baseline trước3 response bars; local range là median(high−low) của baseline.
2. Break bar có low và close dưới floor; displacement từ baseline close tới break close lớn hơn local median range dương.
3. Response bar sau có high vượt break close nhưng close vẫn dưới floor: failed rebound.
4. Bar cuối tiếp tục close thấp hơn response, dưới floor và low không cao hơn break low; break/final đều red.
5. Đồng thời flow fresh, quality READY, negative net, pressure<0.5, regime OUTFLOW/OUTFLOW_ACCELERATING/DISTRIBUTION. Khi có current market snapshot, snapshot phải fresh và actual current directional window cũng negative.

Đủ tất cả mới `STRUCTURE_COLLAPSE`. Nếu pre-break history còn cho controlled-markup STRONG thì tên là `MANIPULATION_STRUCTURE_BREAKDOWN`; markup tag đơn lẻ không cấp SELL. Đây là price inference + current flow, không historical orderflow/rug proof. Các số12/3/3 định nghĩa bounded local pattern, không phải price/PnL stop hoặc xác suất false-positive đã được hiệu chỉnh.

Controls có fixtures: healthy recovery; ordinary red candle; immediate healthy rebound; price-only drop; negative flow-only; stale/gapped/warming history; negative PnL/fee/position age alone. Không case nào tự tạo structural protection.

## H. Liquidity Refactor

Monitor evaluate security trước info; sau normalize info evaluate liquidity **trước** yêu cầu price, decimals, SOL/USD hoặc PnL. Dùng known finite non-negative current liquidity và known positive entry baseline. Giữ strict policy hiện có:

```text
currentLiquidity*10000 < initialLiquidity*(10000−liquidityCollapseBps)
```

Default hiện có5000bps; không retune. Bằng boundary không collapse. Unknown/zero baseline không fabricate tỷ lệ. Fresh liquidity phục hồi thật sẽ supersede pending liquidity protection trước khi ký. Không có historical pool liquidity timeline.

## I. GMGN Failure Fallback

Manual hoặc typed protective proof còn hợp lệ có thể tiếp tục khi GMGN intelligence read gặp recognized GMGN ProviderFailure, bao gồm auth/plan, hoặc known missing-key/plan/auth Blocked code. Provider incident được lưu. Strategic JEV SELL không nhận fallback này. Expired hoặc legacy-unverified proof không được dùng để bypass.

Đây là fallback cho intelligence source. Mint/program/extensions, ownership, remaining quantity, Jupiter quote/route constraints, simulation, pre-sign và signature/receipt/fill checks không bị bỏ qua. RPC/Jupiter lỗi không được đổi thành intelligence failure để tiếp tục ký. Tests chạy mock AUTH, PLAN và MISSING_KEY cho cả manual/protective; unsafe quote/simulation vẫn chặn.

## J. Critical Retry Policy

Automatic protective dùng persisted retry riêng, bỏ suppression30 phút của ordinary PRE_SELL attention. Classification: NO_ROUTE, RPC_TEMPORARY, JUPITER_TEMPORARY, SIMULATION_FAILURE, INSUFFICIENT_BALANCE, TOKEN_INCOMPATIBLE, PROVIDER_INTELLIGENCE_FAILURE, SIGNED_UNKNOWN, OTHER. Base delay5s; NO_ROUTE15s; incompatible60s; exponential cap60s. Retry không làm proof fresh; luôn revalidate.

SIGNED_UNKNOWN không retry ký/gửi lại, nextAt bị khóa trong lúc reconcile. Ordinary/manual failed retry vẫn giữ existing controls; fresh manual REQUESTED có ưu tiên hiện hành. Failed manual đang backoff không che một protective opportunity mới đã tới hạn; request manual vẫn được giữ. Không tự chuyển FULL sang partial khi route FULL thiếu: chưa có explicit fallback policy được chứng minh, nên giữ BLOCKED/NO_ROUTE và probe có giới hạn.

## K. UNKNOWN Transaction Recovery

Execution lưu signature, submitted time và blockhash/lastValidBlockHeight nếu quote transaction có metadata hợp lệ. Reconciliation vẫn đọc receipt trước; khi thiếu receipt hoặc receipt RPC lỗi, bounded investigation lấy signature status/search history, finalized block height và blockhash validity bằng existing RPC. Investigation tối đa một batch/30s/execution; facts/errors/result được persist.

Result: CONFIRMED, FAILED, STILL_POSSIBLY_LIVE hoặc UNRESOLVED. **Blockhash invalid hoặc height vượt lastValid không chứng minh transaction chưa từng landed.** Vì chưa có đủ authoritative absence proof, implementation không tự release lock từ expiry hints. Signature/history RPC thiếu hoặc lỗi cũng không được coi FAILED. Receipt proven failed mới đi existing release path; confirmed chỉ apply delta/fill một lần.

`EXECUTION_BLOCKED_BY_UNKNOWN_TX` ghi blocker signature/Position, tuổi submission, wallet/mode và investigation. Position A UNKNOWN vẫn khóa SELL B cùng wallet/mode. Giữ blast radius này vì chưa chứng minh partial concurrent wallet accounting/ownership an toàn; không giảm duplicate protection để tăng tốc. UI thể hiện lock riêng, không gọi đó là HOLD. Startup có signed pending vào recovery-only, entries disabled; không tự bật entries lại sau resolution.

## L. JEV Dirty Rerun

Mỗi active Position chỉ có tối đa một dirty latest job. Khi A đang chạy, B rồi C material states đến thì C thay B. A xong thì pump chạy C ngay khi có slot, không chờ một tick collector; không tạo request song song cùng Position. Nếu state trở lại đúng active A, pending dirty bị xóa. Input structuredClone, không mutate snapshot đang chờ.

Normal queue bounded bởi existing `jevExitQueueSize` (default100), cộng tối đa một coalesced dirty/job active (concurrency tối đa4). Eligibility loại Position đã đóng/dismissed hoặc quantity đổi. Apply/pre-sign guards kiểm revision/freshness thêm lần nữa. Stop xóa queued dirty, chờ active; restart không replay volatile dirty state cũ, collector dựng fresh state.

## M. Stale Decision Guards

Giữ quantity, decision revision, security, flow signal/material price, decision age và Smart Money freshness guards. Bổ sung discrete safety/data-quality key, protective evidence revision và route evidence. Route đổi status/quantity/known availability, hoặc minimum output biến động bằng/vượt existing `maxDecisionPriceMovePercent` (default10%), làm decision stale/material. Harmless1% drift trong fixture không tự gây storm.

Background exit quote update notify Engine và scheduler; route-only không tạo protection. Old HOLD sau collapse/material revision bị SUPERSEDED; không clear new protective authority. Before-sign kiểm lại current authority và quantity sau async work. JEV NO_DECISION vẫn giữ old unsigned SELL nhưng không bypass các kiểm tra này.

## N. Manual SELL

Priority giữ manual FULL, manual PARTIAL, CRITICAL security, other HIGH protective, strategic FULL rồi strategic PARTIAL. Manual dùng tracked remaining quantity; không bán toàn bộ token balance không thuộc bot. Manual không cần JEV, vẫn phải qua transaction safety và signed-pending wallet lock. Fraction/claim/manual-request identity và receipt reconciliation giữ nguyên.

## O. Multi-Position Behavior

Existing collector pool bounded/concurrent (default4), JEV default2/max4, Position history lane1 active, queue100, ít nhất15s giữa request toàn lane, per-Position schedule60s. K-line request minute-aligned/cache60s qua coordinator; pre-sign protective revalidation TTL0 riêng khi cần. Không collector await history/JEV. History/coordinator/auth budget vẫn shared với các GMGN consumers khác.

Fixture A JEV pending, B protective, C healthy chứng minh B tạo/thực thi protection bằng mock execution trong lúc C valuation tiếp tục. Không chứng minh nhiều signed transactions có thể chạy song song trong một ví: executor/wallet locks vẫn serialize execution. Provider slowness có timeout nhưng không có live latency SLA từ task này.

## P. Legacy Smart Money Migration

Store startup normalization archive/revoke legacy Smart Money PROTECTIVE, không đưa nó vào typed authority. Reason-only critical-security/liquidity legacy được chuyển thành DETECTED với timestamp gốc và marker `LEGACY_RECORD_REQUIRES_REVALIDATION`; `validProtection` từ chối marker cho tới khi actual evidence mới chứng minh predicate. Unknown legacy protective bị supersede/archive. Existing manual requests không bị mất.

Legacy HOLD thiếu explicit decisionState không được giả định affirmative: lưu original ở analystResponse, đánh dấu NO_DECISION cần fresh review. Unsigned strategic proposals bị cancel theo startup semantics hiện có; signed/pending executions vẫn reconcile. Đây là migration optional JSON records khi code mới được chạy, **không phải DB schema migration đã chạy vào production trong task này**. Restart tests dùng TEMP SQLite.

## Q. Logging / UI Semantics

Events có JEV_DECIDED_*, JEV_NO_DECISION, JEV_SUPERSEDED, PROTECTIVE_DETECTED/AUTHORIZED/REVALIDATED/BLOCKED, EXIT_NO_ROUTE/BACKOFF, EXIT_UNKNOWN_TX/RECONCILING/COMPLETED và EXECUTION_BLOCKED_BY_UNKNOWN_TX. Event JSON chứa typed proof/retry/investigation khi áp dụng.

Position projection tách strategic đang chờ, latest analyst attempt/state, protection pending/blocked và execution preparing/submitted/unknown lock. UI thể hiện “CHƯA CÓ QUYẾT ĐỊNH”, “Cần thoát nhưng chưa có route” và “đang đối soát”, không đổi outage thành “GIỮ”. Nếu trước đó có unsigned SELL, UI nói rõ analyst failure không tự thu hồi nó; vẫn cần validity check. [Browser fixture screenshot](previews/sell-safety-v2-states.png). Đây là fixture, không phải production capture.

## R. Tests

| Check | Kết quả |
|---|---|
| `pnpm typecheck` | PASS |
| `pnpm lint` | PASS |
| `pnpm test` | **385 passed / 0 failed / 0 skipped / 0 cancelled** |
| `pnpm exec node scripts/log-ui-test.mjs` | PASS — browser-only Log fixture |
| `pnpm exec tsx scripts/accounting-ui-test.mjs` | PASS — accounting/lifecycle/links/desktop/mobile và SELL safety states |
| `pnpm build` trong TEMP staging | PASS; build id `3e3030c9103badefbf5d16f45b69851304646b5af68218cfc4e523e612df31aa` |

Staging path và TEMP full-test log trong verification artifact. Node thực thi qua pnpm là22.22.0; launcher pnpm có warning shell Node20, các checks/build vẫn PASS. Không dùng `test:ui` vì script đó build root dist.

New fixtures cover actual JEV Http/parser chain với mock429/500/invalidJSON/timeout/network, schema/unknown action/low confidence/insufficient; valid HOLD; old SELL preservation; dirty B/C/latest and return-to-A; stale HOLD/revision; liquidity without valuation/FX và recovery; critical retry; AUTH/PLAN/MISSING_KEY fallback; quote/simulation rejection; signed UNKNOWN valid/expired blockhash hints, RPC receipt failure, proven failed receipt; restart; three Positions.

Full suite tiếp tục cover partial fills, ownership, atomic claim, unique fill/receipt reconciliation, frozen snapshots, stale JEV and gross/fee/net accounting. Updated tests có chủ đích cho semantic mới, không skip/delete safety checks. Test preload chặn đọc production credential files và external fetch; mock LIVE paths dùng fake provider callbacks/signature strings, không gọi production signer. Một số existing fixtures tạo ephemeral keypairs trong memory; không đọc production private key và không ký giao dịch.

## S. Remaining Limitations

- M1 structural inference cần đủ baseline +3 response bars; không phát hiện mọi intraminute collapse. No historical market-wide orderflow/liquidity; rug/intent không được chứng minh từ OHLCV.
- Relative pattern là deterministic policy có controls, chưa có production false-positive/false-negative calibration. Không đảm bảo SELL luôn sớm hay luôn có route.
- History lane15s toàn cục có thể làm nhiều Position chờ/stale; không hứa cadence60s cho mọi Position khi queue lớn. Stale/unknown evidence không được fabricate hoặc cấp authority.
- GMGN outage dài hơn proof freshness có thể chặn automatic protection cần fresh predicate; manual có independent intelligence fallback nhưng transaction gates vẫn bắt buộc. JEV outage không cản security/liquidity/structural protection khi những nguồn đó vẫn đủ fresh.
- UNKNOWN chưa có proof engine chứng minh chắc chắn expired-and-never-landed. Lock có thể kéo dài; alert/investigation được cải thiện, không blind retry hoặc auto-unlock bằng expiry hints.
- NO_ROUTE không có guaranteed partial escape; không tự chia order hoặc đổi fraction. Background route estimate là advisory, quote/simulation lúc execution mới quyết định.
- Restart recovery-only không tự enable entries; operator phải xử lý trạng thái và vận hành theo quy trình. No fresh provider/live execution benchmark trong implementation.

## T. Activation Status

**Chưa nạp V2 vào tiến trình LIVE.** Root dist/config/package/lock hashes giữ nguyên; `.env` size/mtime giữ nguyên, không đọc nội dung để hash lại trong task này. Không mở production DB. Test DB là memory/TEMP. Chỉ source/public/test/report files thay đổi; public assets có thể được web process hiện tại phục vụ từ đĩa, nhưng backend V2 chỉ có sau deploy.

Khi operator chọn thời điểm áp dụng: dừng process theo quy trình, build rồi chạy LIVE bằng entrypoint hiện có. Không build đè root dist khi LIVE còn dùng nó. Không tự restart/kill/sign/submit trong task này.

## 27 câu trả lời bắt buộc

1. **JEV timeout/error còn thành HOLD?** Không, explicit NO_DECISION_*.
2. **DECIDED_HOLD khác NO_DECISION?** HOLD là valid sufficient/confident analyst conclusion trên snapshot hợp lệ; NO_DECISION không có conclusion đủ điều kiện và không cấp/revoke authority.
3. **Failure xóa valid unsigned strategic SELL?** Không. Quyết định cũ vẫn phải pass age/revision/quantity/evidence/pre-sign guards.
4. **Security CRITICAL bypass JEV?** Có, typed protective; execution checks vẫn bắt buộc.
5. **Liquidity phụ thuộc price/PnL/FX?** Không; evaluate known liquidity trước valuation.
6. **Structural collapse nào có authority?** Local-floor break + relative displacement + failed rebound + persistent downside + fresh known negative flow, như section G.
7. **Một red candle tự trigger?** Không.
8. **OUTFLOW_ACCELERATING một mình SELL?** Không.
9. **Negative PnL một mình SELL?** Không.
10. **JEV HOLD veto protective?** Không.
11. **JEV outage10 phút, protection nào hoạt động?** Security critical, liquidity collapse và structure confluence nếu nguồn/predicate vẫn fresh; manual không cần JEV. Không duy trì authority10 phút bằng proof45s/120s cũ.
12. **GMGN auth failure chặn manual/protective?** Có fallback cho manual/recent valid proof; expired/unverified protection vẫn chặn. Jupiter/RPC/mint safety phải PASS.
13. **Critical chờ30 phút PRE_SELL?** Không; automatic protective dùng bounded retry riêng, default5s/NO_ROUTE15s/cap60s.
14. **Signed UNKNOWN?** Persist identity/validity, receipt reconcile, bounded status/blockheight/blockhash investigation, explicit wallet-lock alert.
15. **Blind retry UNKNOWN?** Không.
16. **UNKNOWN A block emergency B?** Có cùng wallet/mode, vì chưa có proof để release an toàn và tránh duplicate/quantity corruption. Collector/JEV vẫn chạy.
17. **B/C khi JEV A active?** Coalesce một dirty latest C; chạy ngay sau A nếu còn eligible/slot.
18. **Old HOLD sau material collapse apply?** Không; revision/evidence guards supersede, protective không bị xóa.
19. **Exit feasibility deterioration?** Notify safety/scheduler; material route changes invalidate decision. Route-alone không tạo SELL/protection.
20. **Sticky liquidity revalidate?** Có trước claim và sau simulation; fresh recovery supersede; failure chỉ giữ proof tới hạn cũ.
21. **Legacy Smart Money protection authority?** Không, revoked/archive; không infer typed protection từ label đó.
22. **Manual semantics đổi?** Fraction/tracked quantity/priority/claim/transaction safety giữ; GMGN intelligence fallback rõ hơn. Signed pending vẫn khóa.
23. **Partial/reconciliation regression?** Không thấy trong385 fixture tests; quantity/revision/unique fills giữ, protective FULL rebind tracked remaining sau confirmed partial, không refresh evidence time.
24. **Gross/Fee/Net regression?** Không thấy trong full suite/browser accounting; không thay accounting formula để tạo SELL.
25. **Multi-position isolation?** A analyst pending, B protective, C valuation fixtures PASS; execution vẫn serialized bởi wallet safety.
26. **Real BUY/SELL/sign/submit?** Không.
27. **LIVE restart?** Không; source + staging build, chưa activate.

## Safety report

```text
real BUY: NO
real SELL: NO
transaction signed: NO
transaction submitted: NO
.env modified: NO
private keys accessed/modified: NO
production DB migration/reset: NO
LIVE restarted/killed: NO
```

Private keys trong statement là production/user secrets; existing tests chỉ có ephemeral fixture key generation và fake signer hooks, không transaction signature. Không thực hiện provider/trading probes hoặc start production Engine trong task này. Baseline/verification artifacts không chứa secret content.
