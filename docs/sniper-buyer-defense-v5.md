# V5 — Phòng vệ người mua Sniper, Structure Watch và điều phối GMGN

**Ngày:** 29/10/2026, Asia/Bangkok. **Phạm vi:** kho mã BOT B / K1ll of BOT hiện tại, chỉ Solana; không thêm EVM, không xây lại bot.

Đã triển khai Buyer Defense chỉ cho **lối vào SNIPER**, Structure Watch tối đa **30 phút**, và bộ điều phối GMGN dùng chung. Trending giữ lối vào riêng. Bot thật được giữ **DỪNG** theo yêu cầu chủ dự án; không khởi động LIVE, không gọi GMGN/Jupiter thật và không ép BUY/SELL để nghiệm thu V5.

## Báo cáo triển khai — 57 mục

| # | Hạng mục | Kết quả và bằng chứng |
| --- | --- | --- |
| 1 | Kiến trúc hiện tại | Giữ Discovery → cheap/security/Token-2022 → Capital Flow/Memory/Jev → Risk → exit feasibility → Jupiter inspection/simulation/signing → receipt/reconciliation; monitor, Jev exit và execution worker độc lập. |
| 2 | GMGN client | Một `Gmgn` trong Engine, gọi pinned `gmgn-cli` 1.6.9 qua `execFile`, allowlist dữ liệu Solana; không đổi sang HTTP endpoint tự đoán. |
| 3 | Toàn bộ call sites | [Call graph trước thay đổi](gmgn-call-graph-v5.md): Trending, Trenches, candidate info/security/holders/creator, SOL/USD, position info/security/smart-money, paper validation và optional post-exit observation. Capital Flow/Jev/UI chủ yếu dùng snapshot đã nhận, không tự tạo mỗi nơi một HTTP request. Các script verify tạo client riêng chỉ khi operator chạy. |
| 4 | Rate limit cũ | FIFO + spacing1,2s, cache tùy caller; thiếu single-flight/recheck cache sau chờ. Rate-limit thật đặt cooldown5phút, một số command failures khác đặt30s. ProviderFailures gom3mint rồi SYSTEM halt. |
| 5 | Root cause | Có request trùng và nhiều lượt info/security TTL0; cooldown dùng chung bị diễn giải thành lỗi nhiều token rồi nâng SYSTEM. Đây là nguyên nhân ở mã nguồn xác minh được. Nhãn lịch sử `GMGN_RATE_LIMIT_COOLDOWN` không lưu raw response ban đầu nên **không chứng minh quota/gói/HTTP429 gốc cụ thể**. Không giả vờ đã tái hiện provider ban thật trong V5. |
| 6 | Trending | Normal pipeline, ưu tiên hiện có, không đi qua gate selling/support/recovery. Vẫn cần Security, token compatibility, Flow, Memory, Jev, Risk, vốn và exit feasibility. |
| 7 | Sniper | Sau các kiểm tra điều kiện/an toàn phía trước và Flow observation: Buyer Defense chưa xác nhận → Structure Watch; chưa gọi Jev BUY. Đủ cấu trúc → tiếp tục normal pipeline mới. |
| 8 | Watch integration | State `STRUCTURE_WATCH` trong lifecycle, bảng companion bounded; dùng cùng candidate scheduler, không tạo timer riêng mỗi token. Refill/queue replacement/provider wait giữ deadline gốc. |
| 9 | Tệp thay đổi | Mới `src/gmgn-coordinator.ts`, `src/sniper-structure.ts`, hai test files `sniper-coordinator.test.ts`/`sniper-recovery-regression.test.ts`, `scripts/sniper-ui-cases.mjs`, `scripts/verify-v5-migration.ts`, call graph và báo cáo. Sửa GMGN/Engine/domain/config/store/lifecycle/flow-view/risk/executor/discovery/Capital Flow/failures/server/runtime-info; UI app/flow/style; strategy và fixtures/harness tương ứng. |
| 10 | Schema | Additive migration **10**: `sniper_structure_watch(mode,mint,updated_at,payload)`. Entry authority/structure thêm vào Snapshot, Position, learning snapshot. Không viết lại dữ liệu lịch sử để gán source hoặc cấu trúc giả. |
| 11 | State machine | NEW/INITIAL_EXPANSION/PEAK_FORMING/WAITING_FOR_SELLING → SELLING_APPEARED → SEARCHING_FOR_SUPPORT/SUPPORT_FORMING → SUPPORT_CONFIRMED → RECOVERY_ATTEMPT → ENTRY_ELIGIBLE với reason RECOVERY_CONFIRMED. SUPPORT_FAILED/RECOVERY_FAILED tiếp tục watch nếu TTL/safety cho phép. Không bắt buộc lưu từng state trung gian trong mỗi observation. |
| 12 | Selling | Ít nhất2 quan sát liên tiếp có sell volume thật, kết hợp sell volume không giảm hoặc buy pressure/net flow yếu đi, cùng phản ứng giá/áp lực. Không lấy drawdown làm detector. |
| 13 | Absorption | Có selling đã xác nhận, sell volume vẫn dương, vận tốc giá đi xuống yếu dần/ổn định qua ít nhất2 quan sát, liquidity còn sống và không giảm trong bước xác nhận. Đây là heuristic quan sát bảo thủ, không xác minh danh tính từng buyer. |
| 14 | Buyer defense | Đòi selling → hấp thụ có persistence → giữ vùng low đã quan sát → buy pressure/net cải thiện và phản ứng giá đi lên. Mất vùng đỡ hoặc thesis phục hồi yếu đi khóa lại entry; không permanently reject chỉ vì lần đỡ đầu thất bại. |
| 15 | Recovery | Ba quan sát phục hồi liên tiếp mặc định: giá tăng, buy pressure tăng, net directional volume cải thiện và liquidity được giữ. Chất lượng thiếu hoặc đổi window/gap dài không được ghép thành chuỗi xác nhận liên tục. |
| 16 | Drop % | **Không có ngưỡng drawdown % cấp quyền BUY.** Drawdown chỉ là field mô tả. Test pullback rất nhỏ vẫn có thể qua khi hành vi đầy đủ; crash lớn/bounce yếu không qua. |
| 17 | Recovery % | **Không có ngưỡng recoveryRatio cấp quyền BUY.** Ratio chỉ được tính/lưu để diễn giải. Persistence/cadence/liquidity là các quy tắc xác nhận riêng, không phải tỷ lệ hồi giá cố định. |
| 18 | Watch30phút | `structureWatchStartedAt` và `structureWatchExpiresAt` đặt một lần; TTL mặc định1.800.000ms, cấu hình có trần30phút. Không dựa vào token age làm bằng chứng an toàn. |
| 19 | Pass sớm | Fixture xác nhận tại **phút2, phút4, phút29**, đi ngay tới ENTRY_ELIGIBLE; không chờ hết30phút. Đây là khả năng khi có đủ dữ liệu hợp lệ, không cam kết thời gian lấy dữ liệu ngoài mạng. |
| 20 | Timer không reset | Test bounce hỏng, peak/low mới, provider wait nhiều lần và khởi tạo lại lớp Watch: cùng expiry ban đầu. Chuyển vị trí queue không cấp thêm TTL. |
| 21 | Expiry | `STRUCTURE_WATCH_EXPIRED`, bỏ khỏi active work, không BUY. Recent-reject/cooldown nội bộ chỉ chặn requeue tức thời; không gán SCAM/MALICIOUS/SECURITY_FAIL. |
| 22 | Hard invalidation | Security critical, mint/layout/extensions không tương thích và các permanent typed token failures có thể kết thúc watch sớm. Kiểm tra an toàn trước watch và final execution guards vẫn có quyền cao hơn. |
| 23 | Sniper→Trending | Merge cùng mint, chọn entry authority TRENDING khi có observation Trending còn fresh; lifecycle bỏ khóa Sniper và phân tích mới. Watch cũ giữ lịch sử nhưng không chiếm capacity Sniper đang hoạt động khi lối Trending còn fresh. |
| 24 | Trending bypass | Không bắt Trending có pullback/support/recovery. UI Trending nói rõ không áp dụng chốt Sniper và không vẽ bộ đếm30phút như điều kiện vào. |
| 25 | Entry source | Snapshot `entryDiscoverySource` tách khỏi toàn bộ `candidate.discovery.sources`. Position lưu authority, sources-at-entry và sniperStructureAtEntry khi hash snapshot khớp intent; Memory giữ immutable Snapshot. Multisource không có nghĩa BUY phải dùng authority SNIPER. |
| 26 | Request Coordinator | Mở rộng cùng GMGN client bằng cache300entries, single-flight map, queue200 mặc định, một outbound job, spacing và provider cooldown. Không thêm client cho từng subsystem hoặc xoay API key. |
| 27 | Shared cache | Successful raw snapshots kèm metadata; các caller dùng chung. Không cache429/timeout/malformed response thành success. Token info sai address/symbol bị chặn trước khi cache. Critical fresh security mới thay cache cũ. |
| 28 | Cache key | Command, chain, mint/wallet và toàn bộ query flags/value; canonical thứ tự flag khi không trùng flag. Window/query khác nhau không gộp. Duplicate flags giữ nguyên tuple để tránh suy đoán last-wins semantics. |
| 29 | TTL/freshness | Info10s, security10s cho phân tích; final pre-buy info/security **TTL0**. SOL/USD30s. Optional holders/creator theo intelligenceCacheMs60s, stale-usable tối đa2×TTL. Smart-money30s. Feed cache bằng nửa poll interval (mặc định Trending30s, Sniper15s), tránh tái dùng qua cả chu kỳ poll. |
| 30 | Single-flight | Các equivalent requests đang chờ/chạy dùng cùng promise; caller quan trọng hơn có thể nâng priority job đang chờ. Một response trả bản clone riêng cho consumer. Cache hit không sinh outbound request. |

## Điều phối, hồi phục và nghiệm thu

| # | Hạng mục | Kết quả và bằng chứng |
| --- | --- | --- |
| 31 | Priority | Vị thế/SOL valuation/exit safety priority0; fresh pre-buy1; Trending analysis2; Sniper gần xác nhận3; Sniper/watch/discovery thường4; enrichment/post-exit5. Không preempt một HTTP/CLI call đã bắt đầu. |
| 32 | Aging/fairness | Queue score giảm một tier sau mỗi30s chờ; job cũ có thể vượt analysis mới. Giữ fairness Trending/Sniper ở candidate scheduler đã có. Queue/TTL hữu hạn không cam kết mọi token đều được phân tích trước expiry khi upstream quá tải. |
| 33 | Detection | Các code GMGN CLI thực dùng: ERROR_RATE_LIMIT_BLOCKED, RATE_LIMIT_BANNED_MAX, RATE_LIMIT_BANNED, RATE_LIMIT_EXCEEDED; hoặc status429 rõ ràng. Transport dùng typed GmgnRateLimited; không phân loại token bằng chuỗi lỗi tùy tiện. |
| 34 | Retry-After | Nhận seconds/HTTP-date khi có; CLI hiện tại đọc x-ratelimit-reset và in timestamp có timezone/remaining. Adapter đọc hướng dẫn rõ đó, thêm buffer1s cho reset; không retry trước thời hạn hợp lệ. Hướng dẫn không hợp lệ không coi là timestamp thực. |
| 35 | Backoff | Nếu thiếu authoritative delay: min(cap, base×2^streak với exponent bounded + jitter). Base10s, cap300s mặc định. RATE_LIMIT_BANNED_MAX nghỉ ít nhất300s hoặc lâu hơn nếu hướng dẫn provider yêu cầu. |
| 36 | Jitter | Thêm ngẫu nhiên0–25% ở fallback, clip tại cap. Delay có thẩm quyền không bị giảm để retry sớm. Không có hứa hẹn lịch chính xác đến mili giây. |
| 37 | Cooldown scope | Provider-wide cho một client/key hiện tại; chưa có bằng chứng quota endpoint độc lập. Cooldown process-local, không phải distributed limiter giữa các process/CLI operator khác. Không chạy verify/network probe song song để lách ngân sách này. |
| 38 | Retry storm | Cooldown từ chối outbound mới; queued consumers nhận provider wait thay vì cùng retry. Hết hạn: một job, spacing3× trong6 success đầu rồi về spacing thường; không phát lại transaction. Engine stop hủy jobs đang chờ và chờ outbound đang chạy kết thúc. |
| 39 | Watch requests | Không timer5s/mint; chỉ dùng shared candidate scheduling, info snapshot và Flow normalizer. Tối đa50 active Sniper watches mặc định; observations120/mint, terminal retention250. Không gọi holders/creator/Jev liên tục khi cấu trúc chưa đủ. |
| 40 | Capital Flow cooldown | Giữ observations thật; catch đánh quality degraded, không thêm zero-flow/price/liquidity giả. FetchedAt của cache được giữ: đọc lại cùng snapshot không tạo observation/transition mới chỉ vì clock đã trôi. |
| 41 | Jev cooldown | Entry thiếu dữ liệu không tới Jev/BUY. Position monitor không gọi lại Jev bằng một response lỗi giả snapshot mới; entry/exit context có gmgnQuality/provider state. Counter avoided tăng khi Sniper chưa đủ cấu trúc, không giả là đếm toàn bộ API tiền tiết kiệm. |
| 42 | Open positions | Retryable GMGN failure chỉ gắn monitoring DEGRADED/provider wait; không tăng token failure đến rejection hoặc SYSTEM halt. Manual/đã có PROTECTIVE evidence vẫn tới execution khi GMGN thiếu dữ liệu. Jupiter/RPC validation, reconciliation/UNKNOWN giữ nguyên. Strategic exit nào vẫn cần evidence chưa đủ sẽ chờ, không bịa fresh Security. |
| 43 | Provider UI | Compact cooldown còn lại, queue/cache/joins; đồng thời giữ health/timestamp hiện có. Structure panel: phase, locked/eligible, elapsed/maxTTL, tuổi dữ liệu/cũ. Mốc freshness hiển thị10s khác với maximum gap120s dùng để nối chuỗi cấu trúc. |
| 44 | Telemetry | logicalReads, actualCalls, success/failed/rateLimited, cacheHit/Miss/staleHit, single-flight created/joined, queueDepth/inFlight/wait, cooldown start/extended/recovered, consumers; watch count/confirmed/expired/avg confirmation/Jev calls avoided. Không chứa khóa hoặc raw stderr. |
| 45 | Logical vs HTTP | `actualCalls` đếm **transport/CLI starts**, không phải instrumentation HTTP bên trong CLI. Một CLI có thể bị chặn cục bộ trước HTTP; internal provider behavior không quan sát được hoàn toàn. Các benchmark dùng fixture transport đếm chính xác call boundary; không báo chúng là lưu lượng HTTP LIVE đã đo. |
| 46 | Cache benchmark | **101 logical reads →1 transport call**,99 single-flight joins,1 cache hit; cache-hit ratio riêng≈0,99%, không gọi99 joins là99 cache hits. Evidence `data/v5-cache-benchmark.json`. Không có benchmark HTTP before/after ngoài mạng trong đợt bot dừng này. |
| 47 | 50-watch benchmark |50 active watches, cap được kiểm tra, overflow không tạo thêm watch; **0 per-token polling timers**. State/observations bounded; owned accounting không đổi. `data/v5-load-benchmark.json`. |
| 48 | 100-mixed benchmark |100 logical demands/25 equivalent keys → **25 transport calls,75 joins**, max1active; consumer structure-watch50 + mixed50. Fixture queue average wait120ms ở virtual clock, không phải latency production. Priority/aging kiểm tra riêng cùng fairness scheduler cũ. |
| 49 | Recovery | Test429→cooldown,100 consumers không gửi thêm transport, honor Retry-After, controlled probe,6success để HEALTHY; exponential bounded/jitter. Không stress GMGN thật để tạo ban. |
| 50 | Existing positions | Regression manual/critical SELL cooldown, market/flow backoff, UNKNOWN/restart/receipt và multi-position vẫn giữ. Migration trên bản sao:219positions,870executions/intents,27fills,75learning samples,103.374records; digest từng bảng trước/sau giống nhau và file DB/WAL/SHM gốc không đổi. |
| 51 | Token-2022 | Suite cũ và test kết hợp structure-approved nhưng tokenExecution SKIP/CRITICAL vẫn NO BUY. Không nới extension policy. |
| 52 | Exit feasibility | Giữ gate quote-only20/50/100, net cost/margin, quote/output binding/freshness. Đủ cấu trúc không thay quyền gate này. Các regression Executor cũ vẫn áp dụng. |
| 53 | Execution validators | Không nới SOL debit/rent/token delta/slippage/simulation hoặc receipt checks. 6001 và NO_SELL_ROUTE vẫn là Jupiter/execution incidents, không đổi thành lỗi cấu trúc hay rate limit GMGN. |
| 54 | pnpm test | **PASS — 186/186, 0 failed**, khoảng51,3s. `data/v5-tests.log`; gồm suite cũ và các case V5, không dùng giao dịch giả làm bằng chứng chain. |
| 55 | pnpm typecheck | **PASS**, `data/v5-typecheck.log`. Bao gồm maintenance migration TypeScript. |
| 56 | pnpm lint | **PASS**, `data/v5-lint.log`. |
| 57 | pnpm build | **PASS**, build trong `pnpm test:ui`; toàn bộ browser checks **PASS, zero browser errors** (`data/v5-ui.log`). UI dùng paper server trên port ngẫu nhiên, scanner/credentials tắt, DB riêng; không khởi động bot thật. |

## Các giới hạn cần hiểu đúng

Buyer Defense là heuristic từ rolling directional DEX volume và sampled price response, không chứng minh demand hữu cơ hoặc bảo đảm tránh rug. Không quan sát được mọi tick, không xác định danh tính người mua, không suy diễn dòng nạp/rút chain. Thiếu buy/sell USD có thể khiến cấu trúc chưa đủ xác nhận dù có giá/volume tổng; thiếu không đổi thành0. Window đổi hoặc khoảng trống lớn yêu cầu lập lại chuỗi xác nhận, giữ nguyên TTL gốc.

Fresh pre-buy data không được thay bằng stale-usable analytics. Optional stale-while-revalidate chỉ dành cho dữ liệu không tự cấp quyền thực thi; metadata có provider/source/fetchedAt/ageMs/freshness. Security final vẫn đọc mới. Khi GMGN không khả dụng, độc lập kỹ thuật không có nghĩa mọi hành động đều có đủ dữ liệu để thực hiện: normal BUY/Jev decisions phải chờ bằng chứng cần thiết, còn manual/protective execution và RPC reconciliation vẫn có đường chạy.

Coordinator không chia sẻ quota với CLI/process khác, không tự phát minh quota gói hiện tại, không quay API key và không bảo đảm sẽ không bao giờ bị rate limit. Thời gian cooldown còn trong RAM của client; không nên restart process để né ban. Report chỉ nghiệm thu code/fixture/UI/offline migration. Không tuyên bố V5 đã chạy LIVE hoặc có real trade qua guard mới.

## Trả lời trực tiếp

| Câu hỏi | YES / NO |
| --- | --- |
| Initial strong inflow một mình cho Sniper BUY? | **NO** |
| Sniper bắt buộc hard-coded drop %? | **NO** |
| Sniper bắt buộc hard-coded recovery %? | **NO** |
| Otherwise valid Sniper bị reject ngay khi chưa đủ Buyer Defense? | **NO** |
| Vào Structure Watch? | **YES** |
| Mặc định Watch tối đa30phút? | **YES** |
| Bắt buộc đợi đủ30phút? | **NO** |
| Có thể pass sau2phút? | **YES**, nếu đủ chuỗi observation hợp lệ. |
| Có thể pass sau29phút? | **YES** |
| Expiry tự đồng nghĩa SCAM? | **NO** |
| Hard Security failure kết thúc Watch sớm? | **YES** |
| Trending dùng Sniper Structure Watch? | **NO** |
| Trending phải đợi pullback/support/recovery? | **NO** |
| Watched Sniper thành Trending và đi lối Trending? | **YES** |
| Cần phân tích mới sau chuyển nguồn? | **YES** |
| Jev bypass cấu trúc Sniper chưa đủ? | **NO** |
| GMGN_RATE_LIMIT_COOLDOWN là token failure? | **NO** |
| GMGN cooldown đồng nghĩa SUPPORT_FAILED? | **NO** |
| GMGN cooldown đồng nghĩa RECOVERY_FAILED? | **NO** |
| Thiếu GMGN data đổi thành0? | **NO** |
| GMGN cooldown tự global-halt bot mặc định? | **NO**; auth/signer/submitted ambiguity/genuine invariants vẫn có quyền halt. |
| Equivalent concurrent requests được dedupe? | **YES** |
| Shared cache dùng khi freshness cho phép? | **YES** |
| Watch tự spam mỗi token vài giây? | **NO** |
| Honor Retry-After khi có thông tin hợp lệ? | **YES** |
| Có bounded backoff + jitter? | **YES** |
| Chặn retry storm sau cooldown? | **YES** |
| Stale snapshots được đánh dấu? | **YES** |
| Stale data âm thầm cấp quyền critical BUY? | **NO** |
| Open positions tiếp tục operations độc lập khi GMGN cooldown? | **YES**, theo dữ liệu/quyền an toàn còn khả dụng. |
| Log API keys? | **NO** |
| Nới Jupiter validators? | **NO** |
| Reset/delete/fake-close positions? | **NO** |

## Trạng thái bàn giao

**Bot thật vẫn dừng.** Không bật LIVE trong V5. Giữ nguyên `.env`, ACK, wallet key, số dư, position sizing1%, không thêm stop loss/max hold/position-count cap. Build mới có policy `SNIPER_DEFENSE_V5`; đây là khả năng của artifact, không phải tuyên bố một process LIVE đang chạy.

Evidence migration: `data/v5-migration-verification.json`, bản sao tại `data/backups/v5-copy-1793251639560/`; browser fixture `data/v5-structure-ui.png`.

## Nghiệm thu cuối

- **186/186 tests, typecheck, lint, build và UI PASS**. Bộ test cũ giữ mục đích; các fixture thay đổi market tức thì yêu cầu snapshot mới rõ ràng thay vì giả rằng cache10s đã hết hạn. Entry fixtures thông thường dùng Trending; Sniper có integration tests riêng kiểm tra chưa đủ cấu trúc không gọi Jev.
- Final build ID: **`eae06c1456c7b99f297e7b86fe97aca1f4c000f6ecba9a5da8b32849ef297d37`**, build **12:42:58, 29/10/2026 Asia/Bangkok**. Runtime policy artifact: `SNIPER_DEFENSE_V5`.
- Node chạy script **22.22.0**. Launcher pnpm có warning Node20 và SQLite experimental warning; không phải test failure.
- Secret audit: **1005 files, zero configured secret findings**, không in secret values (`data/v5-secret-audit.log`).
- Đọc DB gốc **read-only, không network** sau kiểm tra: **10 holdings**, pending0/signedPending0, haltReason=null; migrations gốc vẫn **1–9**. Migration10 chỉ được kiểm chứng trên **bản sao**, chưa áp vào DB thật bằng cách khởi động ứng dụng.
- Không tự bật LIVE hoặc gửi request GMGN/Jupiter thật cho V5. Tiến trình bot thật không chạy; cổng3000 không có listener. Chỉ khởi động lại khi chủ dự án yêu cầu.
