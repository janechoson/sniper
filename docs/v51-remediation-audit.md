# BOT B V5.1 — Sửa lỗi và kiểm chứng lại

Ngày 29/10/2026, Asia/Bangkok. **Verdict hiện tại: NEEDS FIX. Bot giữ dừng.**

Đã sửa H1, H2, H3, H5 và M1; M2 có cooldown dùng chung trên cùng bản cài đặt. H4 đạt hai workload chính khi feed đủ trường, nhưng biến thể thiếu directional feed vẫn vượt gap120s. Vì vậy chưa nghiệm thu toàn bộ. Báo cáo V5 cũ và các artifact V5 được giữ nguyên.

## H1

- **STATUS:** FIXED, trong phạm vi normalization và đường Risk đã kiểm chứng.
- **FILES:** `src/gmgn.ts`, `tests/v51-remediation.test.ts`.
- **ROOT CAUSE:** safe listing được chọn trước endpoint security bằng `??`.
- **FIX:** endpoint rug known/critical không bị safe listing che. Safe endpoint có timestamp mới hơn được phép thay advisory listing cũ; UNKNOWN không xóa warning listing còn trong `maxSnapshotAgeMs`. Listing hết hạn trở thành UNKNOWN, không thành safe. Rug provenance lưu nguồn, fetchedAt và policy. Mint/freeze fallback listing cũng có tuổi tối đa.
- **TEST:** listing 0 + endpoint 0,99; listing critical + UNKNOWN; endpoint safe mới + listing critical cũ; listing hết hạn; Risk từ chối critical.
- **RESULT:** các regression đạt. Đây không phải bộ nhớ critical vĩnh viễn: thời hạn advisory listing rõ ràng, còn snapshot security thực tế vẫn chịu guard freshness.

## H2

- **STATUS:** FIXED.
- **FILES:** `src/domain.ts`, `src/gmgn.ts`, `src/engine.ts`, `src/risk.ts`, `tests/v51-remediation.test.ts`, `tests/fixtures.ts`.
- **ROOT CAUSE:** mất metadata holder sau SWR; final BUY dùng lại intelligence cũ.
- **FIX:** giữ `riskEvidence` với fetchedAt/freshness/authority. Final BUY đọc holder TTL0; creator/top10 dùng info/security vừa làm mới, bỏ fallback listing cũ ở boundary này. Risk từ chối cả evidence thiếu, stale và timestamp tương lai. Không dựa vào việc caller có tự gắn `gmgnQuality` hay không.
- **TEST:** cached top1 1%, provider chuyển 90%; stale Risk DENY; full Engine final BUY thấy 90%, không gọi Executor, không có holding paper. Cooldown lúc refresh được ném về provider-wait, không cấp quyền từ dữ liệu cũ.
- **RESULT:** không có chữ ký hoặc submitted BUY từ các test này. Fixtures tự tạo snapshot khai báo timestamp hợp lệ; production vẫn lấy metadata từ coordinator.

Phân loại authority:

| Dữ liệu | Vai trò |
| --- | --- |
| Top1, top10, creator hold | BUY_BLOCKING/BUY_AUTHORIZING; phải có freshness hợp lệ ở boundary |
| Market/security | Authority riêng, tiếp tục guard tuổi và critical findings |
| Creator launch history, bundle/sniper, smart-money/KOL counts, composite DD, lịch sử học | ADVISORY; không cấp quyền execution |

Phân tích entry dùng cached advisory intelligence, không chờ holder/creator network enrichment. Holder bắt buộc được refresh khi Jev thật sự BUY; không refresh toàn bộ intelligence ở mọi tick. Creator history không tự fetch trên đường entry critical hiện tại; thiếu là UNKNOWN.

## H3

- **STATUS:** FIXED.
- **FILES:** `src/gmgn-fetch-metadata.ts`, `src/gmgn-rate-metadata.ts`, `src/gmgn.ts`, `tests/v51-remediation.test.ts`.
- **ROOT CAUSE:** CLI 1.6.9 không relay Retry-After trong formatted error.
- **FIX:** child CLI preload bọc fetch hiện có, relay riêng status429 và timing headers hợp lệ. Header text bất kỳ không được chuyển tiếp; chỉ numeric delay/epoch hoặc ngày chuẩn hóa. Không relay request, Authorization, cookie, body hoặc key. Adapter lấy deadline dài nhất trong metadata và guidance cũ; fallback chỉ dùng khi không có delay hợp lệ.
- **TEST:** actual `OpenApiClient`, HTTP Response stub → preload → stderr metadata → adapter → coordinator. Retry-After120s và reset150s chọn ít nhất150s; 50 readers không tạo thêm transport. Seconds/date parsing, fallback/jitter/recovery tiếp tục được test.
- **RESULT:** end-to-end CLI regression đạt, không gọi HTTP thật. Full CLI test chạy riêng khỏi virtual-clock workload; không nhầm helper parser với bằng chứng transport end-to-end.

Preload hoạt động với compiled `.js`; command chạy từ TS dùng `tsx` để nạp `.ts`. Không sửa `node_modules`.

## H4

- **STATUS:** CHƯA NGHIỆM THU TOÀN BỘ.
- **FILES:** `src/engine.ts`, `src/gmgn.ts`, `src/gmgn-coordinator.ts`, `tests/v51-remediation.test.ts`, `data/audit-v51-instrumentation.mjs`.
- **ROOT CAUSE:** monitor/full analysis nối tuần tự, lặp info/security trên Watch, optional enrichment chắn đường tiến triển; tổng nhu cầu distinct requests vượt budget khi không có batch facts đầy đủ.
- **FIX:** một observation lane chung, tối đa4 logical reads đang chờ; transport vẫn concurrency1, spacing2s. Chọn Watch theo deadline/tuổi mẫu, urgency support và TTL. Incomplete Watch không chạy lại full analysis chỉ để lấy mẫu. Scanner không chờ cả vòng monitor. P0 dành cho protective work; routine position, Watch và discovery/analysis chia lượt. Không tăng gap120s hoặc TTL30phút.
- **FEED REUSE:** giữ snapshot feed riêng, tối đa300 mint, không merge trường directional cũ sang snapshot mới. Chỉ dùng mẫu ≤10s có đủ giá, thanh khoản và buy/sell USD volume cùng window. Timestamp từ request thật, không dùng giờ render. Nếu feed đầy đủ vừa hết freshness, chờ regular poll kế tiếp trong thời gian hữu hạn; nếu feed thiếu trường hoặc quá hạn thì fallback vào info lane có throttle. Counts không được chuyển thành USD volume.
- **CADENCE:** chờ batch không được tính là một lần đọc thất bại. Regression bắt và sửa trường hợp cadence15s luôn lệch khỏi fresh window10s; không đổi các ngưỡng này để vượt test.
- **TEST:** shared feed đủ trường tạo observation mà không có per-mint read; cùng fetchedAt không tạo mẫu mới; snapshot mới thiếu directional fields thay toàn bộ snapshot cũ và fallback, không dựng số0. Auth failure ở lane này vẫn SYSTEM. Workload chính và biến thể thiếu directional feed được đo riêng.
- **METRICS:** active, age từng Watch, oldest age, due/success/deferred/starved, coverageRatio và feedObservationsReused trong status. ACTIVE không đồng nghĩa coverage khỏe.
- **RESULT:** xem bảng đo được cập nhật dưới đây. Không tuyên bố PASS từ việc 50/50 chỉ nhận một mẫu.

## H5

- **STATUS:** FIXED.
- **FILES:** `src/trading-memory.ts`, `src/engine.ts`, `tests/v51-remediation.test.ts`.
- **ROOT CAUSE:** whitelist bỏ cả5 fields; serializer còn loại key `at`.
- **FIX:** contract whitelist giữ discovery/path, structure phase/status/TTL/defense counters, Flow regime/features/quality/lookbacks và GMGN quality. Dùng tên timestamp cụ thể: marketObservedAt, securityObservedAt, flowObservedAt, structureUpdatedAt. Không thêm GMGN consumer hoặc gửi observation history/raw provider responses.
- **TEST:** chặn tại `Jev.http.request`, parse POST body cuối cùng; xác nhận cả5 nhóm và timestamps còn tồn tại, history1000 phần tử bị loại.
- **RESULT:** đạt; model vẫn không có quyền vượt Security/Structure/Risk/Exit Feasibility/transaction validators. Immutable entry snapshot và source persistence được suite hiện có kiểm tra tiếp.

## M1

- **STATUS:** FIXED.
- **FILES:** `src/engine.ts`, `tests/v51-remediation.test.ts`.
- **ROOT CAUSE:** nhánh entry Watch chạy trước khi xác định ownership.
- **FIX:** resolve active owned position ngay cả khi caller không truyền position; Watch branch chỉ cho entry chưa sở hữu và không ở POSITION_MONITOR/PRE_SELL.
- **TEST:** OPEN + PASSED structure + BOUGHT + unsigned data failure; quantity/state giữ nguyên, issue và nextCheckAt được ghi, lifecycle không thành STRUCTURE_WATCH.
- **RESULT:** regression đạt; không fake-close, không thêm quyền BUY.

## M2

- **STATUS:** FIXED về shared/persisted active cooldown; giới hạn quota nêu rõ bên dưới.
- **FILES:** `src/gmgn-provider-state.ts`, `src/gmgn-coordinator.ts`, `src/gmgn.ts`, `tests/v51-remediation.test.ts`.
- **ROOT CAUSE:** deadline chỉ trong RAM từng client.
- **FIX:** SQLite provider-state riêng tại `data/gmgn-provider.sqlite`, resolve theo module để không phụ thuộc cwd. Lưu deadline, lastRateLimitAt, source; atomic MAX không rút ngắn deadline. Mỗi client đọc shared deadline trước enqueue/start. Không lưu credential, không migrate DB accounting.
- **TEST:** hai store handles/coordinator độc lập cùng file; A429/120s, B không outbound; reopen store vẫn cooling; extension ngắn không rút deadline dài.
- **RESULT:** đạt bằng fixture, không gửi request GMGN thật.

**Giới hạn:** đây là shared cooldown cùng một bản cài đặt, không phải distributed/global quota lease. Hai process có thể bắt đầu request trước khi process kia nhận429; sau deadline mỗi process vẫn có limiter riêng. Không được chạy nhiều operator tools đồng thời rồi gọi đó là concurrency1 toàn API key. Cài đặt ở máy/thư mục khác không chia file này. Recovery warm-up/streak chưa được chia giữa process.

## Quality, preservation và regressions

- `pnpm test`: 195/195 đạt ở lượt cuối; `data/v51-tests.log`.
- `pnpm typecheck`, `pnpm lint`, `pnpm build`: đạt; các log `data/v51-*.log` tương ứng.
- CLI actual transport/header test, fresh Risk, contradictory rug, scope/ownership và final Jev POST payload nằm trong `tests/v51-remediation.test.ts`.
- Suite cũ tiếp tục kiểm tra Token-2022, simulation/slippage/rent/token delta, exit feasibility, UNKNOWN/reconciliation, manual/critical exit trong cooldown, no SL/no max hold/no position-count cap, original Structure curves2/8/29phút, expiry30phút và Trending transition.
- `data/v51-preservation.json`:16 protected files không đổi so với baseline V5, gồm DB/WAL/SHM thật, `.env`, cấu hình, public, package files và các file transaction validator. Không reset/delete/fake-close position. Không ký/submit giao dịch thật.
- `data/v51-secrets.log`:1046 files,0findings ở checkpoint cuối; không in secret values.
- `data/v51-runtime-stopped.json`:0bot processes,0listeners cổng3000. Các tiến trình kiểm chứng không khởi động Engine thật.

## Kết quả benchmark cuối

Build **5e9a63cfe16e8002288b3d79098dea8c4f10ff643db7675a010f7d9da742e547**; compiled lúc 2026-10-29T07:38:31.164Z. Benchmark 2026-10-29T07:39:55.485Z. Không gọi Engine.start, HTTP thật **0**. Fixtures/RAM SQLite;10phút virtual, spacing2000ms, latency50ms. Actual CLI Response → preload → adapter → coordinator được test độc lập trong suite, không gắn nhãn parser helper là end-to-end.

| Metric | BEFORE V5 | AFTER V5.1 |
| --- | ---: | ---: |
| Mixed logical reads | 504 | 419 |
| Mixed transport demand, kể cả queued | 302 | 302 |
| Reduction vs cùng logical-read naive baseline (%) | 40.08 | 27.92 |
| Max transport concurrency | 1 | 1 |
| Peak queue | 5 | 6 |
| Mean queue wait (ms) | 4964 | 4320.43 |
| p95 queue wait (ms) | 27000 | 15950 |
| Max queue wait (ms) | 47950 | 28000 |
| Mixed Watch có mẫu mới | 0/50 | 50/50 |
| Watch-only max gap (ms) | 470200 | 32000 |
| Watch-only gaps >120s | 46 | 0 |
| Mixed position market updates | 110 | 67 |
| Same-mint4 reads: transport | 1 | 1 |
| Same-mint4 reads: joins | 3 | 3 |
| 10stale readers: refresh | 1 | 1 |
| 50cooldown readers: thêm transport | 0 | 0 |
| Cached second read: thêm transport | 0 | 0 |
| Retry-After end-to-end | FAIL | PASS — actual CLI regression |
| Critical rug precedence | FAIL | PASS |
| Fresh holder Risk | FAIL | PASS; missing metadata cũng DENY |
| Final Jev V5 context | FAIL | PASS |
| Owned position fault scope | FAIL | PASS |
| Restart / shared active cooldown | FAIL | PASS; local deployment |

| Workload | Watch refresh | Mẫu mới, trừ seed | Median gap ms | p95 gap ms | Max gap ms | Gaps >120s | Oldest age ms | Coverage hiện tại | Positions có refresh |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 50Watch / feed đủ | 50/50 | 950 | 30050 | 32000 | 32000 | 0 | 29950 | 1 | 0 |
| Mixed / feed đủ | 50/50 | 550 | 58000 | 70000 | 82000 | 0 | 23950 | 1 | 20 |
| Mixed / feed thiếu directional | 50/50 | 183 | 158000 | 166000 | 170000 | 150 | 165950 | 0.74 | 19 |

Mixed logical-cache savings: **117** transport không cần tạo trên cùng mẫu số logical reads. Local batch reuse: **590** lượt; số này báo riêng, không cộng thành fake HTTP hoặc single-flight joins. Mẫu số logical reads đã đổi vì observation lane và batch reuse, nên tỷ lệ reduction không phải so sánh traffic LIVE/V4/V5 cùng hành vi.

Watch-only: **đạt**. Mixed rich-feed: **đạt**. Biến thể mixed thiếu directional feed: **chưa đạt**. Tất cả50mint vẫn nằm trong mẫu số; không loại các mint không nhận được dữ liệu để cải thiện coverage. Full trace/consumers/endpoints nằm trong JSON.

Hạn chế thực tế: feed thiếu buy/sell USD volume không thể được đổi từ trade counts sang volume. Khi cần50 distinct info reads mỗi chu kỳ, interval2s đã dùng100s cho Watch trước khi tính Positions/discovery/analysis. Nếu không có batch evidence đầy đủ, fairness không tự tạo thêm request capacity. Không nâng gap120s, không giảm safety, không tăng request frequency/concurrency. Vì vậy **H4 chưa hoàn tất trong mọi điều kiện đã kiểm tra**; không kết luận chỉ từ50/50 có một mẫu.

Artifact: data/audit-v51-benchmarks.json; harness data/audit-v51-instrumentation.mjs. Các test structure2/8/29phút, source transition, outage/manual/recovery và counterexamples cũ đều được chạy lại; xem edge/outage/micro trong JSON. **FINAL VERDICT: NEEDS FIX.**

## Câu trả lời trực tiếp

| Câu hỏi | Kết luận hiện tại |
| --- | --- |
| H1 fixed / older safe che new critical? | YES / NO |
| H2 fixed / stale holder cấp BUY / fresh facts bắt buộc? | YES / NO / YES |
| H3 fixed / Retry-After E2E / retry sớm hơn authoritative delay? | YES / YES / NO |
| H4 fixed trong mọi trường hợp đã kiểm tra? | NO; feed thiếu directional vẫn còn giới hạn capacity |
| 50Watch-only có meaningful coverage? | YES khi feed đủ; max gap32s |
| Mixed chính có coverage cho50Watch? | YES khi feed đủ; max gap82s,20/20 Positions có refresh |
| Mixed thiếu directional feed vẫn giữ gap≤120s? | NO; max170s,150gap quá hạn;19/20 Positions có refresh trong cửa sổ10phút |
| Fix bằng uncontrolled spam? | NO; concurrency1/spacing2s vẫn giữ |
| Dedupe / single-flight / cooldown herd protection? | YES / YES / YES; max transport concurrency1 |
| H5 fixed / Flow, discovery path, structure và quality tới Jev? | YES / YES cả4 nhóm |
| M1 fixed / owned OPEN biến thành entry Watch? | YES / NO |
| M2 shared cooldown / new process bỏ qua active deadline? | YES cùng local deployment / NO |
| Jupiter validator bị nới? | NO |
| Existing position reset/deleted/fake-closed? | NO |

**FINAL VERDICT: NEEDS FIX.** Hai workload chính đã đạt nhưng không dùng chúng để che biến thể thiếu dữ liệu batch. Cần nguồn batch có đủ trường cho toàn bộ Watch hoặc một chính sách capacity phù hợp trước khi coi H4 hoàn tất; các snapshot ngoài coverage vẫn phải thể hiện gap/UNKNOWN, không được biến trade counts thành USD volume. Chưa bật LIVE. Không thay gap hoặc giả tạo observation để lấy PASS.
