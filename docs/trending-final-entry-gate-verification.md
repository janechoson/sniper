# BOT B — Trending-only và Structure Watch sau eligibility

**Ngày:** 30/10/2026 — Asia/Bangkok. **Kết quả: PASS trong phạm vi thay đổi entry. Bot giữ dừng, không bật LIVE.** F01/F02 của full-flow audit vẫn còn; đây không phải nghiệm thu toàn bộ độ an toàn của dự án.

Policy build: `TRENDING_FINAL_STRUCTURE_V1`. Build ID: `3eb15bfec3a1be5d92f052d9c7de79af68e9664b55b40a023770c2fe444efa64`.

## Luồng thực tế đã triển khai

```text
GMGN TRENDING — normal discovery duy nhất
→ parse / merge / CandidateLifecycle
→ token-info cần cho cheap filter
→ cheap filter
→ Fresh Security (TTL 0)
→ LIVE token compatibility / decimals
→ Capital Flow candidate observation
→ advisory intelligence + Trading Memory retrieval/context
→ fresh Jev entry analysis
→ fresh info + Security + authoritative holders, price-drift check
→ cùng RiskEngine.evaluate(..., PRE_WATCH)
    ├─ DENY / thiếu critical data / unsupported → không tạo Watch
    └─ allowed + kiểm tra ownership / vốn / freshness lại
        → admit Structure Watch, T0 = thời điểm admission
        → Bán → Hấp thụ → Hỗ trợ → Phục hồi
            ├─ UNKNOWN/STALE/outage: không kết luận failed support; TTL vẫn chạy
            ├─ remove: USER_REMOVED, thu hồi revision
            ├─ chưa PASS đúng hạn 10 phút: EXPIRED, không BUY
            └─ timely Recovery Confirmed: promote ngay
                → chạy lại pipeline phân tích mới, gồm Security/Compatibility/
                  Flow/Memory/Jev/final holders/Risk EXECUTION
                → fresh capital + approved intent + atomic claim
                → fresh Jupiter BUY quote
                → SELL probes 20% / 50% / 100% expected BUY output
                → exit-feasibility classification và binding gate
                → transaction validation / unsigned simulation
                → final Risk/ownership/capital/freshness + wallet re-read
                → immediate authority/Structure pre-sign callback
                → sign → durable signature → submit → receipt/reconcile
                → POSITION
```

**BUY quote đứng trước exit probes** vì Executor cần expected token output và buyQuoteHash để bind báo cáo exit feasibility. Không lấy quote/probes hoặc tạo intent/reservation trong thời gian ACTIVE Watch. PASS không trực tiếp ký. Các bước quote, probes, validation, simulation, signature persistence và receipt vẫn là implementation hiện hữu.

Capital Flow và Memory giữ vai trò evidence/context; không thêm một gate BUY độc lập chỉ vì inflow hoặc historical win rate. Flow có thể đang warming-up hoặc thiếu directional fields; Watch lúc đó vẫn giữ UNKNOWN nếu không có chuỗi hành vi đủ dữ liệu. Chạy qua lớp Flow không có nghĩa mọi field đều đã KNOWN.

## Phân chia authority

- `RiskEngine.evaluate()` có phase `PRE_WATCH` / `EXECUTION`. PRE_WATCH chỉ bỏ yêu cầu timing Structure; các quy tắc Security, holder freshness/concentration, Jev, ownership và vốn vẫn dùng chung. Không sao chép policy sang RiskEngine thứ hai.
- PRE_WATCH không gọi `RiskEngine.approve()`, không tạo executable intent hoặc reservation. Chỉ lưu snapshot/risk records và `pre_watch_approvals` khi admission thành công.
- EXECUTION của normal Trending yêu cầu Watch của policy mới, timely PASS, quality/lastObservedAt hợp lệ, revision khớp; sau đó mới có approved intent.
- Candidate source history vẫn là union; normal entry authority là TRENDING. Watch đã được admit không biến thành Sniper chỉ vì rank timestamp cũ đi trong lúc chờ. Rank không thay thế freshness của Security/market/holders/Jev hoặc Structure.
- Sau PASS, phân tích Jev/Risk chạy mới; không dùng Jev BUY hay safe Security từ nhiều phút trước làm quyền ký. Không tăng Security TTL để giữ approval.
- Immediate callback tiếp tục kiểm tra revision, current Watch PASS/freshness và common Executor guards. Không tuyên bố callback đã trở thành một lần refetch toàn bộ Risk/Security ở last instruction; giới hạn F07 trong full audit không được coi là đã sửa toàn bộ.

## Persistence và lịch sử

`DiscoveryCoordinator.poll()` chỉ schedule TRENDING; SNIPER hiển thị `DISABLED`. Không gọi trenches trong normal poll. Scheduler và `Engine.analyze()` không chọn pure historical Sniper làm normal entry. Parser/helper và dữ liệu lịch sử Sniper, Trending, dual-source vẫn giữ để đọc/đối chiếu.

Watch policy mới lưu trong **`entry_structure_watch`**, dùng schema payload của observer cũ, thêm eligibility gồm policy, approvedAt, authorityRevision và snapshotHash. Đây là state của Watch, không phải SQL Waiting Queue. `sniper_structure_watch` lịch sử không được chuyển thành fresh eligibility hoặc dùng để unlock normal BUY. Khi cùng mint có Watch mới, projection chọn Watch mới; bản legacy vẫn giữ nguyên trong bảng cũ. Không reset/rewrite trades, fills, learning hoặc token source history.

T0 được tạo sau khi required eligibility hoàn tất; T1 lấy T0 + cấu hình tối đa 600.000ms. Rediscovery, provider recovery và reopen không gia hạn cửa sổ đã admit. Legacy Watch không tự được coi là đã chạy pre-Watch pipeline: muốn vào normal path phải qua phân tích mới rồi admission mới, tách khỏi record lịch sử. Constructor chỉ reconcile TTL của Watch policy mới. Không chạy writable migration trên production DB trong lượt này.

`entryWatchDismissedAt` là tombstone mới, tách với `sniperDismissedAt` lịch sử. Bỏ Watch policy mới chặn tự hồi sinh qua rediscovery Trending và thu hồi unsigned authority. Tombstone Sniper cũ không tự trở thành một lệnh cấm whole-mint mới. Removal vẫn dùng dialog/CSRF/backend acknowledgment; không giao dịch blockchain. Signed/submitted execution vẫn phải recovery/reconcile, không bị giả hủy.

Mapping conceptual → state hiện hữu:

| Khái niệm | State/evidence thực tế |
| --- | --- |
| Discovered / analyzing | tokens + QUEUED / ANALYZING / QUALIFIED |
| Pre-Watch approved | fresh snapshot/risk records; `pre_watch_approvals`; eligibility marker |
| Structure active | STRUCTURE_WATCH + entry_structure_watch ACTIVE |
| Recovery confirmed | PASSED / ENTRY_ELIGIBLE; promote QUEUED |
| Final validation | fresh qualification/Jev/Risk; APPROVED chỉ ở đường execution |
| BUY pending | claim → CREATED + PENDING_ENTRY |
| Position | confirmed/reconciled fill → OPEN |

Không đổi thuật toán buyer defense: selling/absorption/recovery confirmations, failed support được tiếp tục trong deadline gốc, early PASS, gap handling và missing evidence giữ nguyên. Không thêm universal drop/recovery/ATH-distance threshold, Stop Loss, Max Hold hoặc max-open-position cap. Watch admission cap hiện hữu không phải Position cap.

## Kiểm chứng

[Bộ test mới](../tests/trending-final-gate.test.ts) có **19 tests**, dùng Engine/Store/Risk/Executor thật với SQLite RAM, virtual clock và fake provider/RPC. Các test mang mode LIVE chỉ đếm callback giả tại boundary; không dùng wallet signer hoặc blockchain thật.

| Tình huống | Kết quả |
| --- | --- |
| Security critical hoặc missing critical authority | 0 ACTIVE Watch, 0 executions |
| Unsupported token compatibility | Reject trước admission, 0 Watch/BUY |
| Jev BUY nhưng concentration Risk DENY | 0 Watch, 0 execution authority |
| Eligibility hoàn tất sau 35 giây | T0 = discovery + 35s; T1 = T0 + 10m |
| ACTIVE / thiếu Recovery | Không quote, intent, reservation, sign hoặc submit |
| Rediscovery / reopen | T0/T1 của Watch mới giữ nguyên |
| Curve thật PASS ở 2:00, 3:40, 9:59 | Fresh pipeline chạy ngay; fake execution chỉ qua khi mọi gate cho phép |
| Sau PASS: Security đổi critical / không còn vốn / wallet đã có token | Không ký hoặc tạo holding OPEN mới |
| Fresh BUY quote | Được lấy sau confirmedAt; không có quote trong ACTIVE Watch |
| Exit policy fail | Probe exact 20/50/100; chặn trước simulation/sign |
| Remove khi quote đang chạy | Revision thắng; 0 sign/submit |
| UNKNOWN / outage / hết 10m | Không fake failed support hoặc LOSS learning; unconfirmed → EXPIRED |
| Normal discovery | 0 trenches calls; pure historical Sniper không vào normal queue |
| Legacy Watch cùng mint | Payload legacy giữ nguyên sau admission mới/reopen; remove lại sau prune giữ nguyên revision và history |
| Dismissed ownership | Không cấp Watch mới cho mint đã owned theo durable policy |

Regression hiện hữu đã cập nhật kỳ vọng entry trước đây cho phép Trending bypass; giữ các kiểm chứng SELL, manual partial/recovery, UNKNOWN, reconciliation, token programs, fee/debit, exit binding và removal races. Test suite không dùng test-count thay bằng chứng admission hoặc pre-sign boundary.

| Lệnh | Kết quả |
| --- | --- |
| `pnpm test` | **229 passed, 0 failed, 0 cancelled, 0 skipped**; 90.091,5905ms; [log](../data/trending-final-gate-tests.log) |
| `pnpm typecheck` | **PASS**, exit 0; [log](../data/trending-final-gate-typecheck.log) |
| `pnpm lint` | **PASS**, exit 0; [log](../data/trending-final-gate-lint.log) |
| `pnpm build` | **PASS**, exit 0; [log](../data/trending-final-gate-build.log) |
| `pnpm exec node scripts/ui-test.mjs` | **PASS**, exit 0, 0 browser errors; [log](../data/trending-final-gate-ui-regression.log) |
| `pnpm exec node scripts/v52-ui-verification.mjs` | **PASS**, exit 0; actual localhost handlers + browser + temp DB; [evidence](../data/trending-final-gate-ui-verification.json) |

UI chỉ đưa Watch policy mới đã eligible vào ACTIVE list, bỏ Trending exemption, giữ rows desktop **76px**, timer T0/T1 thật và evidence-based progress. Sniper ghi rõ đã tắt nguồn mới, lịch sử vẫn đọc được. Browser kiểm tra 1440/1024/390, removal/cancel/reload/CSRF/409/pending và không horizontal overflow. [Ảnh desktop](../data/trending-final-gate-watch-1440.png), [mobile](../data/trending-final-gate-watch-390.png). Không thêm GMGN consumer cho UI.

Pnpm launcher có Node20 engine warning; process test/build dùng pinned Node22.22.0. SQLite experimental warning không phải test failure. Không chạy verification provider thật, quote thật hoặc live smoke.

Secret audit: **1.209 files, 0 findings**, không in configured secrets; [log](../data/trending-final-gate-secrets.log).

## Bảo toàn và trạng thái vận hành

Trước sửa đã pause new entries, kiểm tra pending = 0 rồi dừng normal LIVE PID14980 để thực hiện yêu cầu giữ LIVE off. Không clear halt hoặc sửa `.env`/LIVE ACK. Checkpoint bảo toàn được tạo **sau khi dừng**, không dùng checkpoint full audit cũ để khẳng định toàn thời gian LIVE bất biến.

[Preservation evidence](../data/trending-final-gate-preservation.json): `.env`, package/lock, configuration và các file Executor, execution provider, token program, RPC, Trading Memory, Capital Flow, Jev exit, Runner, Position view, normal-live, exit feasibility/lifecycle không đổi. Nội dung Engine từ `async monitor()` đến trước `async status()` — bao gồm Position/SELL/accounting/analytics — khớp bản trước sửa sau khi chuẩn hóa newline. Chỉ entry-facing projection trong status/flow view được cập nhật.

Production **main DB và WAL bytes không đổi** so với backup sau dừng. SHM coordination file khác byte; không tuyên bố SHM immutable. Không mở app writable constructor lên production DB, không reset DB, không sửa receipts/quantities/outcomes. Một lần thử tạo bản DB copy thứ hai bị ENOSPC; không chạy migration trên copy đó. Do vậy bằng chứng migration/reopen là fixture RAM, cùng đối chiếu production DB/WAL; không giả vờ đã nghiệm thu full production-copy migration.

0 blockchain signature/transaction được tạo/gửi bởi việc kiểm chứng. Bot production tiếp tục dừng; [checkpoint cuối](../data/trending-final-gate-runtime-final.json) xác nhận 0 normal bot processes và 0 listeners cổng 3000, sau cleanup cả hai browser suites.

## Findings còn lại

**F01 HIGH vẫn reachable qua Trending.** Shallow merge listing và discovery timestamp chung vẫn có thể khiến old authority field thành KNOWN khi endpoint thiếu field. Counterexample mới đã kiểm chứng điều này; không sửa `gmgn.ts` hoặc `mergeDiscovery()` để che finding.

**F02 MEDIUM vẫn reachable.** `inspectMint()` Legacy SPL vẫn báo active on-chain mint authority nhưng compatibility ALLOW; test mới dùng mint bytes fixture xác nhận. Không thêm chain-authority security veto trong task này.

Do đó câu “unsafe token không vào Watch” dưới đây nghĩa là token bị required policy hiện hữu phát hiện/reject sẽ không được admit. Không phải bảo đảm mọi rủi ro ngoài đời đều được nhận diện; F01/F02 vẫn là ngoại lệ dữ liệu/authority cần xử lý riêng. Các findings F03–F09 khác không được coi là tự khắc phục bởi thay đổi entry này. Capacity/directional-data/quota LIVE chưa đo; không tăng request rate hoặc giảm freshness để bù thiếu dữ liệu.

## Required direct answers

| # | Question | YES / NO |
| --- | --- | --- |
| 1 | Is Sniper still a normal discovery input? | **NO** |
| 2 | Is Trending the only normal discovery input? | **YES** |
| 3 | Does an unsafe Trending token enter Structure Watch? | **NO** nếu bị required policy reject; đọc giới hạn F01/F02 ở trên |
| 4 | Does Risk DENY enter Structure Watch? | **NO** |
| 5 | Does Structure Watch happen after Security/Flow/Memory/Jev/Risk? | **YES** |
| 6 | Does Structure Watch still use Bán → Hấp thụ → Hỗ trợ → Phục hồi? | **YES** |
| 7 | Is Structure Watch the final market-behavior entry gate? | **YES** |
| 8 | Does Structure PASS directly sign? | **NO** |
| 9 | Is Security/freshness still checked before execution? | **YES** |
| 10 | Is the BUY quote fresh near execution? | **YES** |
| 11 | Does Exit Feasibility still block BUY when necessary? | **YES** |
| 12 | Is Watch maximum 10 minutes? | **YES** |
| 13 | Does Watch T0 begin when candidate becomes eligible for Watch? | **YES**, tại admission sau eligibility |
| 14 | Is 10 minutes mandatory waiting? | **NO** |
| 15 | Can Recovery Confirmed leave Watch early? | **YES** |
| 16 | Does provider UNKNOWN count as failed support? | **NO** |
| 17 | Can manual Watch removal prevent an in-flight BUY? | **YES** trước ký; submitted vẫn reconcile |
| 18 | Are Position and SELL flows unchanged? | **YES** |
| 19 | Does removing Sniper solve F01? | **NO** |
| 20 | Does removing Sniper solve F02? | **NO** |
| 21 | Were execution validators loosened? | **NO** |
| 22 | Was LIVE enabled? | **NO** |
