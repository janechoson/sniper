# Trending-first discovery và kiểm tra khả năng thoát lệnh

Ngày triển khai: **29/10/2026 — Asia/Bangkok**. Dự án hiện tại: **K1ll of BOT / BOT B**.

> Cập nhật lịch sử: hai feed phục hồi; đã review cooldown với chain holdings khớp/pending0 và bật lại entries lúc09:51:26 (`data/trending-cooldown-review-1793242286575.json`). Browser09:51:44 xác nhận entries=true/halt=null. Sau đó chủ dự án yêu cầu dừng bot và PID2292 đã được dừng, cổng3000 đóng. Các checkpoint dưới đây là evidence lịch sử, không phải trạng thái hiện tại. Thay đổi tiếp theo: [V5 Buyer Defense/GMGN Coordinator](sniper-buyer-defense-v5.md); chưa bật LIVE lại.

**Kết quả:** đã triển khai hai nguồn discovery, scheduler chung, lịch sử Trending, kiểm tra thoát lệnh trước BUY và thông tin thanh khoản thoát lệnh sau BUY. **161/161 test đạt**, typecheck/lint/build và kiểm tra UI đạt. Bản biên dịch cuối đã chạy ở chế độ normal LIVE, PID **2292**, `http://127.0.0.1:3000`, policy **TRENDING_EXIT_V1**.

**Giới hạn vận hành tại 09:45–09:46:** tiến trình vẫn chạy nhưng mua mới **đang bị SYSTEM pause** với `GMGN_RATE_LIMIT_COOLDOWN`; hai feed DEGRADED. Không xóa halt này để tạo kết quả nghiệm thu đẹp. Monitoring vẫn được lên lịch, nhưng không thể có market/flow mới khi GMGN từ chối dữ liệu. Vì vậy không tuyên bố LIVE đang giao dịch bình thường hoặc mọi tiêu chí vận hành ngoài mạng đều đạt.

## 1. Kiến trúc hiện tại

```text
GMGN Trending ─┐
              ├─ merge theo mint → bounded priority queue → cheap/security checks
GMGN Trenches ┘       → candidate Capital Flow + Memory → Jev → Risk
                      → exact BUY quote → SELL quote-only 20/50/100%
                      → economic exit gate → inspection/simulation/final guards
                      → local signature persisted → execute once → reconciliation
Owned positions → independent market/flow monitoring → async Jev exit scheduler
               └─ bounded background exit quotes → Jev context, không ép SELL
```

Giữ kiến trúc nhiều vị thế, ledger/reconciliation, memory và quyền quyết định chiến lược của Jev. Discovery không dùng RPC để lập chỉ mục chain.

## 2. Nguồn Trending thực tế

Đã kiểm tra CLI hiện cài, config và response thật. Lệnh runtime là:

```text
gmgn-cli market trending --chain sol --interval 5m --order-by volume --direction desc --limit 100 --raw
```

Response thật có envelope `code=0`, `data.rank` là mảng 100 token. Parser đọc `rank` thật, không gán thứ tự mảng thành hạng. Mẫu công khai: `data/trending-provider-sample.json`. Không giả định một endpoint HTTP chưa xác minh.

## 3. Trường dữ liệu sử dụng

Mint, tên/ký hiệu, rank, giá, market cap, liquidity, volume của cửa sổ chọn, thời gian tạo/mở, holders, activity và các trường risk/authority có trong response. Rank đi kèm basis chain/interval/sort/direction/filter; không so hạng giữa các basis khác nhau. Market cap thật được ưu tiên thay vì giả định circulating supply.

## 4. Trường không có hoặc chưa đủ bằng chứng

Không tạo circulating supply, dòng vốn nạp/rút, rank lịch sử trước lần quan sát, smart-money net USD hay large-trade imbalance khi provider không trả. Volume 5 phút không đổi tên thành volume 24 giờ. Lịch sử rank chỉ bắt đầu từ quan sát thật của bot. Giá trị thiếu giữ UNKNOWN; không coi là kiểm tra an toàn đã đạt.

## 5. Tệp thay đổi

- Mới: `src/discovery.ts`, `src/exit-feasibility.ts`, `tests/trending-exit-feasibility.test.ts`, `scripts/verify-trending-exits.ts`, `scripts/trending-ui-cases.mjs`, báo cáo này.
- Runtime/schema: `src/domain.ts`, `src/config.ts`, `src/gmgn.ts`, `src/store.ts`, `src/candidate-lifecycle.ts`, `src/capital-flow.ts`, `src/engine.ts`, `src/execution-provider.ts`, `src/executor.ts`, `src/trading-memory.ts`, `src/risk.ts`, `src/server.ts`, `src/live.ts`.
- Cấu hình/UI: `config/strategy.json`, `public/index.html`, `public/app.js`, `public/style.css` và module giao diện liên quan hiện có.
- Kiểm chứng: `tests/execution.test.ts`, `tests/provider.test.ts`, `tests/normal-live.test.ts`, `tests/learning-fixtures.ts`, `scripts/ui-test.mjs`, `scripts/capital-flow-checkpoint.ts`; README và provider contract.

Các helper đọc/đối chiếu triển khai trong `data/` không được import vào ứng dụng. Không sửa `.env`, private key, ACK hoặc slippage để làm giao dịch qua.

## 6. Schema và migration

Additive migration **9**, bảng `candidate_flow_states` và các index phục vụ learning/evidence. Candidate lưu discovery metadata; execution lưu pre-buy exit evidence; position lưu exit-liquidity observation. Entry learning giữ bản chụp evidence tại giao dịch, không thay bằng quote mới sau này.

Đối chiếu ứng dụng đã dừng trước khởi động cuối: **10 holdings, 219 position records, 868 executions, 75 samples**, controlled history và hash accounting **không đổi**. Các migration 1–9 còn nguyên. Evidence: `data/trending-migration-1793241520150.json`; backup `data/backups/pre-trending-final-20261029-093431/`.

## 7. Triển khai Trending

Mặc định lấy tối đa 100 token mỗi 60 giây, cửa sổ 5m/volume desc, freshness 180 giây. Hạn tuổi Trending riêng **30 ngày**; không áp máy móc hạn 1 giờ của Sniper cho token trưởng thành trên Trending. Token vẫn phải qua các kiểm tra liquidity/security/risk hiện tại. Feed có lần thử, lần thành công, số token, lịch tiếp theo và trạng thái độc lập.

## 8. Triển khai Sniper

Giữ discovery Trenches hiện tại với các nhóm new/near-completion/migrated, poll 30 giây và hạn tuổi Sniper hiện có 1 giờ. Response thật trong checkpoint có **180 token**. Sniper-only vẫn có thể BUY sau toàn bộ pipeline; không cần xuất hiện Trending.

## 9. Scheduler thống nhất

Hai feed cập nhật chung token theo mint, sau đó lifecycle chọn công việc. Không có hai BUY queue độc lập. In-flight/qualified/approved được bảo vệ khi thay queue. Đang sở hữu hoặc có giao dịch chưa rõ kết quả vẫn bị guard trùng lệnh hiện tại chặn.

## 10. Quy tắc ưu tiên

Base score sử dụng các dữ kiện market biết được, giới hạn 100. Trending còn mới cộng **40**, đa nguồn cộng **10**. Score là thứ tự phân tích, không phải xác suất thắng hoặc BUY approval. Replacement có hysteresis **10** để giảm xáo trộn queue.

## 11. Công bằng với Sniper

Aging **20 điểm/phút**, giới hạn trong vùng ưu tiên thường. Giữ tối đa **5 slot Watch** cho Sniper phù hợp. Sau **4 lần phân tích Trending liên tiếp**, một Sniper đủ điều kiện đã chờ ít nhất **180 giây** được ưu tiên phân tích. Streak được lưu qua restart; counter promotion tăng khi thực sự nhận phân tích.

Cam kết áp dụng cho candidate còn được giữ, đủ điều kiện và đến hạn. Không bảo đảm xử lý mọi token trong 500 đầu vào: TTL, reject, giới hạn capacity và khả năng provider vẫn có thể loại/hoãn công việc.

## 12. Giới hạn tài nguyên

Queue tối đa 10; Watch/Deferred giữ các giới hạn cấu hình hiện có. Rank history 20; candidate Flow tối đa 250 mint, 120 observations/mint, TTL 30 phút. Post-exit queue tối đa 100, một worker; history status tối đa 12. Diagnostic pre-buy evidence giữ tối đa 500. Các audit/trade record lâu dài không bị xóa vì giới hạn queue.

## 13. Merge và chống trùng

Giữ firstSeen cũ, cập nhật lastSeen và metadata từng nguồn. Token cùng mint từ hai nguồn là một candidate, không hai quyền BUY. Existing position chỉ được enrich metadata, không đổi quantity/cost/signature và không tạo BUY vì xuất hiện lại trong feed.

## 14. Đa nguồn

Ghi TRENDING + SNIPER, cộng boost đa nguồn khi Trending còn fresh. Không coi hai nguồn discovery là hai lần xác nhận an toàn độc lập. Dedup count là số merge observations, không phải số token duy nhất hoặc số giao dịch.

## 15. Rank và lịch sử

Lưu first/last Trending observation, sequence, consecutive observations, rank/basis và lịch sử giới hạn. Phân biệt NEW_ENTRY, tăng/giảm và biến động nhanh từ các quan sát đủ bằng chứng. Rank không đổi không liên tục thêm bản ghi trùng; movement là biến động có ý nghĩa gần nhất, không giả định giá đang tăng. Mất feed hoặc dữ liệu cũ được đánh dấu, không suy diễn token đã rớt hạng từ một lỗi request.

## 16. Jev trước BUY

Snapshot truyền discovery/rank/freshness, candidate Capital Flow và Trading Memory cùng market/security đang có. Mỗi BUY vẫn cần quyết định Jev và RiskEngine mới. Ranking không thể tự cấp phép mua. Unsigned execution failure không trở thành một WIN/LOSS của giao dịch chưa phát sinh.

## 17. Trending trên vị thế đã sở hữu

Jev exit/hold nhận discovery context, hiện diện ở poll thành công gần nhất và rank/history phù hợp. Thay đổi rank là một dữ kiện cho phân tích bounded, không force SELL; quantity, ledger và cost basis giữ nguyên.

## 18. Capital Flow

Candidate có bounded observation state riêng; không giả tạo Position để gọi Flow. Sau BUY tiếp tục kiến trúc Flow vị thế hiện có. Các feature từ rolling directional DEX volume được ghi đúng nghĩa, không gọi chênh lệch rolling volume là tiền nạp/rút chain. Dữ liệu thiếu/stale đi kèm quality.

## 19. Kiến trúc kiểm tra thoát trước BUY

Sau exact BUY quote, trước ký: lấy ba SELL order **quote-only không taker** bằng lượng output dự kiến. Kiểm tra direction/mint/amount/route/slippage và output. Không tạo số dư ví giả, không ký SELL, không gọi execute để thử. Quote-only chỉ là bằng chứng giá/route tại thời điểm đó, không chứng minh transaction tương lai sẽ simulate/land.

## 20. Ba mức thoát

| Mức | Atomic amount |
| --- | --- |
| 20% | floor(expected BUY output × 2000 / 10000) |
| 50% | floor(expected BUY output × 5000 / 10000) |
| 100% | expected BUY output |

Lượng bằng 0 atomic là UNKNOWN/dust, không gửi quote amount 0. Mỗi mức có route availability, expected/min output, conservative cost, minimum net, impact hoặc UNKNOWN, timestamp và lý do.

## 21. Tiêu chí kinh tế

Mặc định chi phí = max(quote fees, **110.000 lamports**): priority cap 100.000 + signature 5.000 + buffer 5.000. Minimum net = minimum output − conservative cost, yêu cầu ít nhất **10.000 lamports**. Known price impact không vượt **15%**. Unknown impact giữ UNKNOWN, không giả thành 0; policy hiện tại vẫn có thể chấp nhận theo net output nếu các điều kiện còn lại đạt.

Ít nhất một mức cấu hình **20% hoặc 50%** phải HEALTHY. Full exit mỏng không tự loại token có partial exit hợp lý; kết quả có thể LIMITED. Quote chỉ 823 lamports là technical route nhưng không meaningful sau phí. Không yêu cầu token có lợi nhuận so với giá BUY ngay lúc vào; đây là gate khả năng thoát, không mục tiêu PnL tức thì. Không có mức hợp lệ thì DEFER/REJECT theo typed lifecycle, không ký BUY.

## 22. Freshness và binding

Pre-buy validity **15 giây**; bind hash mint/wallet/exact input/expected output/minimum output/quote timestamp/requestId và policy. Kiểm tra sau probes và trước execution/signing. Quote hoặc expected output đổi làm proof cũ vô hiệu. Retry unsigned phải requalify, quote và probe mới; không phát lại lệnh cũ. Safety inspection/simulation/final wallet/risk/expiry và persist-before-broadcast vẫn áp dụng.

## 23. Thanh khoản thoát sau BUY

Refresh theo vị thế tối thiểu **5 phút**, giữa các job tối thiểu **30 giây**, một worker và queue 100. Ba quote dùng quantity hiện còn giữ. Work không await trên market monitor/Jev; yield cho execution. Kết quả chỉ apply nếu vị thế vẫn OPEN và cùng quantity. Partial SELL làm estimate cũ stale. Không có hidden stop loss từ trạng thái POOR/NO_EXIT.

## 24. Jev exit context

Jev nhận level20/50/100, technical/economic status, freshness, lượng token dùng tính quote và lịch sử bounded. Có thể HOLD/partial/full SELL theo policy hiện có. Quote mới không tự thực thi lệnh hoặc bỏ simulation. Legacy TP/trailing chỉ là tham chiếu; không khôi phục stop loss hoặc max-hold.

## 25. Cô lập provider

Transport failure riêng Trending chỉ hạ health nguồn đó; Sniper vẫn có lịch riêng, và ngược lại. Lỗi discovery không tắt timer monitoring/exit. Test deterministic kiểm chứng các nhánh này.

**Ngoại lệ thực:** cả hai dùng cùng GMGN account/service/rate queue. Authentication, service-wide rate ban hoặc cooldown chung có thể làm cả discovery lẫn dữ liệu vị thế không khả dụng. Không thể bảo đảm market observations tiếp tục thành công khi upstream chung từ chối. Tại checkpoint cuối đã quan sát chính trường hợp cooldown chung; không gọi đó là lỗi route Jupiter.

## 26. UI

Giữ PaperDAO/Vietnamese. Dashboard có hai source cards, health, source badges/rank/history và queue đúng thứ tự backend. Candidate detail có pre-buy exit evidence; Positions có discovery cùng các mức20/50/100 và tuổi dữ liệu. Ghi rõ định giá GMGN khác SOL dự kiến thu từ executable exit; stale/UNKNOWN không được vẽ thành an toàn.

Trình duyệt thật LIVE: **10 cards, 10 exit panels, zero page errors, zero mutation requests**. Ảnh `data/trending-live-overview.png`, `data/trending-live-positions.png`; JSON `data/trending-live-ui.json`. Fixture browser còn kiểm tra responsive/stale/settings/SSE/CSRF và bảo toàn SYSTEM halt khi tắt entries.

## 27. Telemetry

Source discovery totals/calls/last success/duplicates/multisource; source analyzed/Jev BUY; queue replacement/aged promotion; source waiting; pre-buy probes; post-check count/queue/active/failures; Jev exit metrics. Một mint đa nguồn tham gia counter của cả hai nguồn. `analysisLastMinute` hiện là số source participations, **không phải distinct deep analyses**. Poll count là lần gọi coordinator, không đồng nghĩa mọi lần tạo HTTP request do cache/cooldown/retry.

## 28. Hiệu năng và giới hạn tần suất

Fixture **100 Trending + 500 Sniper observations** → 500 mint, 100 merges/100 multisource, queue10, lifecycle250; **1.999 ms** trên host hiện tại. Heap delta âm do GC, không phải bằng chứng tiết kiệm RAM. Đây là RAM SQLite/fixture, không benchmark latency GMGN/chain. Evidence `data/trending-performance.json`.

Hai nguồn gọi một lần trong cửa sổ đầu, poll lặp sau1s không gửi lại. GMGN runtime dùng chung spacing1.2s cho CLI; không tuyên bố spacing này bảo đảm đủ quota gói. Jupiter dùng gate HTTP2.2s; background nominal tối đa khoảng2 job/6 logical level probes mỗi phút, không phải SLA6 wire attempts/phút khi tính retry và ranh giới cửa sổ. BUY và SELL thật vẫn cạnh tranh cùng request budget, execution được ưu tiên. Kiểm chứng20positions dùng fixture; LIVE hiện có10. Cooldown GMGN thực chứng minh vẫn có giới hạn upstream chưa thể coi là nghiệm thu tải production dài hạn.

## 29. Phạm vi test

Actual-envelope parser; unknown rank; dedup/basis/history; owned enrichment không đổi accounting; priority/aging/4T→S/reserve; protected queue; hai feed faults; 600observations; exact integer levels/dust; technical vs economic;823lamports; healthy partial/thin full; stale/policy/output binding; no signature; actual Executor gate;20position Jev context; immutable entry evidence/source learning; optional impact sentinel; UI stale/responsive and SYSTEM pause preservation. Không ép trade thật làm bằng chứng.

## 30. Bảo toàn LIVE và dữ liệu

Giữ sizing1%, reserve20m lamports, không position cap, không stop loss/max-hold. Dừng bản cũ sau pause/idle/pending0, backupDB/WAL/SHM, so hash và khởi động normalLIVE cuối. Không reset/delete/fake-close holding, không replay signature UNKNOWN. Script điều tra không submit giao dịch.

Trong triển khai có regression mới: Jupiter trả `priceImpactPct="-1"`; parser tùy chọn mới ban đầu coi là response lỗi, dẫn tới SYSTEM pause sau nhiều mint. Đã tái đọc ba quote HTTP200 và sửa giá trị âm/không hợp lệ thành UNKNOWN, giữ nguyên mandatory quote/transaction guards. Tất cả các attempt gây lỗi này chưa ký. Evidence `data/trending-impact-review-1793241479877.json`.

Đồng thời sửa thao tác disable entries để giữ SYSTEM halt: endpoint cũ xóa reason ngoài ý muốn trong planned pause. Đã phục hồi đúng reason, thêm regression test; chỉ clear incident parser **100992** sau guard exact build/incident/three quotes/pending0, ghi maintenance audit, entries vẫn false cho đến startup recovery. Không áp cách clear đó cho cooldown GMGN xuất hiện sau này.

## 31. Test suite

`pnpm test`: **161 passed, 0 failed**, khoảng37,1s. Evidence `data/trending-final-tests.log`. Không dùng fixture thành bằng chứng mua/bán thật.

## 32. Typecheck

`pnpm typecheck`: PASS trên runtime/test/maintenance TypeScript nằm trong project. Không thay đổi runtime source sau full quality suite cuối.

## 33. Lint

`pnpm lint`: PASS. Secret audit tại09:46: **976 files, zero configured secret findings**, không in giá trị bí mật (`data/trending-secret-audit.log`). Các helper đọc trongdata không import runtime.

## 34. Build và browser

`pnpm build`: PASS; `pnpm test:ui`: PASS/zero browser errors (`data/trending-ui.log`). Node22.22.0. Final build **16fe3aa5173ed31da5ce48edadceedb072bb4d0b51a42d6d224c19f67bcc9a57**, built09:36:46. Global pnpm Node20 engine warning và SQLite experimental warning không phải test failures.

## 35. Quan sát runtime thật

- PID2292 bắt đầu09:38:42, server sẵn sàng09:39:31; normalLIVE, không controlled session mới.
- API snapshot đầu09:41:32 có hai feed READY, Trending100/Sniper180, entries=true, halt=null. Tuy nhiên checkpoint đó đọc chain tuần tự; ở cuối lần đọc DB đã có cooldown halt. Không coi file nhiều bước này là một snapshot nguyên tử hoặc tuyên bố entries vẫn bật sau khi checkpoint hoàn tất.
- Đọc chain độc lập trong `data/capital-flow-trending-final-1793241692960.json`: **10 holdings, tất cả quantity khớp**, saved BUY statuses finalized; pending0. Controlled history giữ nguyên. Không có SELL thành công/closed mới được suy diễn từ quote.
- Theo counters09:45:52: TRENDINGAnalyzed14, SNIPERAnalyzed45; đây là counter persisted, có thể gồm các lần chạy trước, không phải toàn bộ đều thuộc PID cuối. Trong cửa sổ09:41 đầu có4 Trending +3 Sniper source participations/phút, chứng minh cả hai nguồn được phân tích ở run mới. Post-worker hoàn thành10checks/30probes.
- 09:45:49 browser đọc **entries=false**, `SYSTEM failure: GMGN_RATE_LIMIT_COOLDOWN`,10holdings/10panels, không request mutation/error. Scanner timer vẫn running; GMGN BLOCKED, Solana/Jupiter health có request READY gần đó. Monitoring không có freshGMGN trong cooldown.
- Nhãn cooldown là lỗi typed của adapter, không giữ raw response ban đầu trong checkpoint này; không kết luận chính xác HTTP429/gói/quota/providerban duration chỉ từ nhãn. Probe CLI kiểm chứng bổ sung dùng chung tài khoản quota vớiLIVE; không thể loại trừ tác động của chính các lần đọc bổ sung. Dừng các probe GMGN bổ sung sau phát hiện; không gửi thử liên tục, không restart để né cooldown.
- Không có signature/transaction bị ép để nghiệm thu. Không tuyên bố đã có BUY thật qua gate mới chỉ dựa vào fixture hoặc quote-only control. Control provider trước deployment lấy100Trending/180Sniper và partial gatePASS (`data/trending-provider-verification-1793240100903.json`); level20 trong artifact cũUNKNOWN do sentinel đã được sửa sau đó, không đổi lại evidence cũ.

Artifact tổng hợp: `data/trending-runtime-summary-1793241952195.json` và các checkpoint có timestamp; log tiến trình `data/trending-live-final-20261029-093840.stdout.log`/`.stderr.log`. Live UI vẫn truy cập được ởlocalhost3000. Việc mua mới cần provider hồi phục và xem xét SYSTEM halt; báo cáo này không tự cấp quyền bypass hoặc hứa tự mở lại sau một thời gian cố định.

## Trả lời trực tiếp 21 câu hỏi

| Câu hỏi | YES / NO | Phạm vi |
| --- | --- | --- |
| Có scan Trending? | **YES** | CLI/response thật, feed riêng. |
| Sniper vẫn scan? | **YES** | Trenches hiện có. |
| Trending được ưu tiên? | **YES** | Fresh boost và scheduler. |
| Sniper bị starvation do Trending? | **NO** | Với candidate đủ điều kiện còn được giữ; TTL/capacity/upstream vẫn áp dụng. |
| Trending có tự BUY? | **NO** | Không thay Security/Jev/Risk. |
| Sniper-only có thể BUY? | **YES** | Qua đủ kiểm tra và vốn. |
| Mint trùng được merge? | **YES** | Một candidate theo mint. |
| Đa nguồn tăng ưu tiên? | **YES** | Không đồng nghĩa thêm safety approval. |
| Trending enrich OPEN position? | **YES** | Không đổi accounting. |
| Rank giảm một mình force SELL? | **NO** | Chỉ là context Jev. |
| Mọi BUY cần Security/Jev/Risk? | **YES** | Execution guards vẫn nguyên. |
| Kiểm tra exit trước BUY? | **YES** | Ba quote-only levels. |
| Có từ chối BUY-route nhưng không meaningful SELL? | **YES** | Typed DEFER/REJECT, không ký. |
| Probe ký transaction? | **NO** | Khôngsign/execute/fakebalance. |
| Phân biệt technical/economic exit? | **YES** | Fee budget và minimum net. |
| BUY output đổi vô hiệu probe cũ? | **YES** | Hash binding và freshness. |
| Jev nhận exit-liquidity sau BUY? | **YES** | Bounded async context. |
| Một lỗi Trending riêng dừng Sniper? | **NO** | Service-wide auth/rate cooldown chung là ngoại lệ thật. |
| Một lỗi Sniper riêng dừng Trending? | **NO** | Cùng ngoại lệ upstream chung. |
| Discovery failure dừng monitoring? | **NO** | Timer độc lập; GMGN outage chung vẫn có thể ngăn fresh data. |
| Reset/delete/fake-close vị thế thật? | **NO** | Backup/hash/chain quantity đối chiếu. |

## Learning và giới hạn diễn giải

Source outcome report dùng immutable entry source/Flow/exit evidence, confirmed BUY và CLOSED outcomes; phân nhóm Trending-only/Sniper-only/multi-source/legacyUNKNOWN. Có sample count, PnL đã đối soát, MFE/MAE, runner quan sát được và lỗi execution. Dữ liệu ít được đánh dấu insufficient sample; không tự chỉnh chiến lược/security/position size. Counter nguồn và số incident không dùng làm mẫu số win rate. Quote-only và quan sát vài phút không chứng minh tỷ lệ thắng hoặc khả năng thoát trong tương lai.
