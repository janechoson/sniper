# Capital Flow Intelligence và Jev Adaptive Position Manager

Ngày hoàn tất kiểm chứng source: 29/10/2026, Asia/Bangkok. Dự án hiện tại K1ll of BOT được mở rộng; các báo cáo audit ngày 28/10 vẫn là bằng chứng lịch sử, không đại diện backend mới.

## Kết quả triển khai — 35 mục

| # | Hạng mục | Kết quả và giới hạn |
| --- | --- | --- |
| 1 | Kiến trúc hiện hữu | GMGN → chuẩn hóa market/security → monitor theo vị thế → Jev queue riêng → final authority gate → Executor/Jupiter → receipt/reconciliation → Trading Memory. Giữ cấu trúc này. |
| 2 | File thay đổi | Mới: `src/capital-flow.ts`, `src/runner-memory.ts`, `src/runtime-info.ts`, `tests/capital-flow.test.ts`, `scripts/capital-flow-checkpoint.ts`. Tích hợp: `src/engine.ts`, `domain.ts`, `config.ts`, `store.ts`, `gmgn.ts`, `jev.ts`, `jev-exit-scheduler.ts`, `executor.ts`, `trading-memory.ts`, `learning.ts`, `position-view.ts`; UI: `public/app.js`, `flow.js`, `style.css`; build: `scripts/build.mjs`; cấu hình: `config/strategy.json`; regression: `tests/long-hold.test.ts`, `tests/normal-live.test.ts`, `scripts/position-ui-cases.mjs`. |
| 3 | Migration | Thêm bảng `capital_flow_states` và `position_runner_memory`, migration 8. Deployment này cũng đưa migration 6 (manual/fills) và 7 (Jev decisions) chưa từng chạy trên DB LIVE cũ vào sử dụng. Không reset positions, execution ledger hoặc dữ liệu học cũ. |
| 4 | CapitalFlowEngine | Tính toán cục bộ, đồng bộ và hữu hạn trên market đã lấy bởi monitor; không HTTP/RPC riêng. Lưu state theo position ID, kiểm tra mint identity, xóa cache flow của vị thế đã đóng. |
| 5 | GMGN có thật | `price.volume_*`, `buy_volume_*`, `sell_volume_*`, `buys_*`, `sells_*` theo 1m/5m/1h/6h/24h; giá, vốn hóa, thanh khoản, `holder_count`, `wallet_tags_stat.smart_wallets`. Bằng chứng field: `data/capital-flow-provider-fields.json`. |
| 6 | Chưa có | Smart-money buy/sell **USD** và large-trade buy/sell USD: `null`/UNKNOWN. Số ví smart-money không được chuyển thành USD. Không tuyên bố có tiền nạp ròng on-chain. |
| 7 | Cửa sổ | Ưu tiên cửa sổ ngắn nhất có directional USD; sau đó counts, volume. History mặc định 120 quan sát, tối đa 30 phút; khoảng cách tối thiểu 15 giây. Lookback 1/3/5/15/30 phút chỉ xuất hiện khi có điểm quan sát gần thời điểm cần đọc; giữ timestamp và thời gian thực tế, không nội suy. |
| 8 | Features | Net USD mua−bán, volume ratio/pressure, thay đổi/slope/acceleration của volume và net flow, liquidity/holder/smart-wallet-count trends, price momentum/acceleration và observed peak retracement. Chỉ so sánh cùng source window, chia 0 trả UNKNOWN. |
| 9 | Regime | STRONG_INFLOW, INFLOW_ACCELERATING, HEALTHY_EXPANSION, INFLOW_DECELERATING, NEUTRAL, DISTRIBUTION, OUTFLOW, OUTFLOW_ACCELERATING, INSUFFICIENT_DATA. Đây là mô tả heuristic, không phải tín hiệu BUY hoặc dự báo x10. Volume cao một mình không tạo bullish regime. |
| 10 | Hysteresis | Hai quan sát xác nhận chuyển trạng thái thông thường; ngưỡng thay đổi mặc định 10%; signal key lượng hóa. Đảo chiều bán lớn với buy pressure dưới 30% hiển thị ngay, không đợi hai lần. |
| 11 | Quality | Tối thiểu 3 quan sát trên ít nhất 30 giây. Giữ danh sách available/missing, source window và span. Warmup hoặc insufficient confidence ≤0,4; horizon 1h/6h/24h ≤0,55. Lỗi nguồn có confidence 0 và DEGRADED. UNKNOWN không đồng nghĩa bearish. Confidence là thước đo heuristic, không phải xác suất thắng. |
| 12 | Nhiều vị thế | Monitor market vẫn duyệt tuần tự theo cấu trúc cũ; Jev và SELL worker tách riêng. Một lỗi token được isolate, lượt xử lý tiếp tục. API chậm vẫn có thể làm trễ các vị thế sau; không cam kết 50 token được định giá mỗi 5 giây. |
| 13 | GMGN calls | Flow tái sử dụng info đã có. Trong benchmark 50 vị thế, một monitor dùng 50 security + 50 token-info + 1 SOL-info. Thêm 7.500 cập nhật flow cục bộ không tạo thêm provider call. Feed optional và post-exit của kiến trúc cũ vẫn có lịch riêng. |
| 14 | RPC | Không thêm polling RPC cho market, flow, holders hoặc smart-money. RPC tiếp tục phục vụ ví, token validation, simulation, submission, confirmation và reconciliation. |
| 15 | Jev input | Exact remaining/original quantity, cost, realized/unrealized/total PnL, remaining-position PnL%, MFE/MAE, peak/retracement, exposure, prior partials/decision, execution health; market/security hiện tại; flow features/transitions/lookbacks/quality; historical experience và observed runner examples. |
| 16 | Jev output | HOLD / PARTIAL_SELL / FULL_SELL; fraction NONE/10/20/25/50/75/ALL; confidence/reason; thêm thesis, flow assessment, invalidation signal và reevaluation signal bằng enum có kiểm tra. Identity/revision/quantity do scheduler gắn, không nhận từ provider. |
| 17 | Đánh giá lại | Mặc định 60 giây; sớm hơn khi quantity/revision, material flow, PnL/retracement, liquidity/volume/buy pressure đổi, vẫn cách nhau ít nhất 15 giây. Reevaluation signal của Jev là ngữ cảnh, không được tự đổi config hoặc gửi lệnh. |
| 18 | Concurrency | Mặc định 2, giới hạn cấu hình 1–4; queue 100; một job active mỗi position; waiting job được thay bằng input mới, giữ queue age riêng để aging công bằng. Timeout provider và queue hữu hạn. |
| 19 | Chống stale | Bind mint/position/revision/flow key/quantity/input timestamp/value. Reject kết quả khi quantity hoặc authority revision đổi, giá lệch quá giới hạn, input cũ, position pending/closed hoặc có signature chưa đối soát. Kiểm tra lại trước ký. |
| 20 | Partial SELL | 20/50/75% tính trên số token **đang giữ tại claim**, không phải original buy. Atomic amount lưu bất biến trong intent. Ví dụ 1.000.000 → bán 200.000 → HOLD 800.000 → fresh 50% bán 400.000. Sau fill, scale valuation theo quantity, đánh dấu ESTIMATED_AFTER_FILL và buộc lấy giá mới. |
| 21 | Security | Critical/liquidity protective work thắng Jev HOLD. Ưu tiên emergency full → critical → manual partial → protective → Jev full → Jev partial. Chọn critical trước một protective liquidity cũ trên cùng position. |
| 22 | Manual | Manual request persisted, claim amount gắn execution; confirmation qua recovery cũng tiêu thụ request đúng một lần. Full fill đóng position thì hủy các yêu cầu chưa claim còn dư. Manual vượt SELL retry backoff nhưng không vượt validator. |
| 23 | Backoff | Chỉ trì hoãn retry SELL. Market, PnL, excursions, flow và Jev vẫn quan sát theo lịch market riêng; lỗi market có lịch backoff market riêng. Không xóa holdings vì lỗi. |
| 24 | UNKNOWN | Đóng băng gửi thêm giao dịch trong lúc có signed pending, không thay hoặc phát lại signature. Reconcile single-flight theo execution; terminal CONFIRMED không bị late result đổi thành UNKNOWN. Receipt-local balances và known subsequent confirmed deltas, unique fill ledger, account checks giữ nguyên. |
| 25 | Trading Memory | Exit snapshot gắn Jev decision, authority và observed flow. Lý do Jev chiến lược được phân biệt với OTHER. Failure evidence tách khỏi realized outcomes; ba unsigned failures không trở thành ba losses. |
| 26 | Runner memory | Chỉ tạo khi có confirmed BUY learning evidence. Lưu first-observed milestones +20/+50/+100/x3/x5/x10/x20, observed excursions, flow quanh expansion/peak/collapse, partial exposure, final realized. Reviews 1/5/15 phút chỉ OBSERVED trong cửa sổ phù hợp, quá hạn là UNAVAILABLE; không chế dữ liệu lúc không chạy. Giữ tối đa 128 reviews/64 exit records mỗi position; context rút gọn 3 reviews/8 exits. Retrieve tối đa 200 closed eligible same-mode, other-mint samples, trả tối đa 5; dưới 3 không đủ dùng làm bằng chứng quyết định. |
| 27 | UI | Giữ nền kem PaperDAO và tiếng Việt. Card gọn: flow regime/confidence/window/observations; metrics/timeline/missing trong details; thesis và exposure; xN là giá quan sát so entry, không dự báo. Hai details giữ trạng thái mở riêng qua SSE. Stale valuation/flow cập nhật bằng clock, không chờ payload đổi. Backend cũ thiếu capability được cảnh báo. |
| 28 | Telemetry | Runtime build ID/PID/loadedAt capture khi module load; flow observation/transition/mean compute/payload bytes/regime counts; Jev queue/concurrency/latency/calls-minute; HOLD/partial/full/stale/duplicate counters. New-flow decisions không gắn fill giữ tối đa 256/position, verbose context 128, cleanup mỗi 20 writes; executed evidence được giữ. |
| 29 | Tests thêm | 17 ca Capital Flow, gồm USD outflow với volume cao, UNKNOWN/zero/window switch, acceleration/deceleration, noise/reversal, retention, HOLD ở nhiều mức lời/lỗ, partial lifecycle/cooldown, 20 mixed histories/failure/backoff/security/manual, runner review/retrieval, manual revision, frozen signed UNKNOWN, ba execution failures, 50-position performance, concurrent recovery/manual consumption. Regression cũ tiếp tục chạy. |
| 30 | Hiệu năng | RAM/fixture benchmark: monitor 50 positions **1.606 ms**, 6.500 flow updates **3.465 ms**, mean flow gồm JSON/SQLite **0,503 ms/observation**. 50 retained states ~**1,89 MB payload**; SQLite **3.403.776 bytes** trước/sau thêm 1.000 observations khi đầy retention; heap delta ~**4,27 MB** (có GC/noise). Peak Jev=2, waiting=48, 50 fixture calls trong phút đầu. Đây không phải latency GMGN/Jev thật hoặc SLA. Artifact `data/capital-flow-performance.json`. |
| 31 | pnpm test | **142 passed, 0 failed**; `data/capital-flow-final-tests.log`. |
| 32 | pnpm typecheck | PASS, gồm evidence scripts. |
| 33 | pnpm lint | PASS. |
| 34 | pnpm build | PASS. Isolated browser PASS: navigation/settings/SSE/CSRF, cards 1/3/10/20/50, flow details, exposure, stale clock, responsive; zero browser errors. `data/capital-flow-ui.log`. |
| 35 | LIVE | Deployment/checkpoint thực tế được ghi ở phần cuối báo cáo; build/test không tự được coi là LIVE evidence. |

## Trả lời trực tiếp 19 câu hỏi

| Câu hỏi | Trả lời |
| --- | --- |
| Jev HOLD ở +30%? | YES |
| HOLD ở +100%? | YES |
| HOLD ở x5? | YES |
| HOLD ở x10? | YES |
| Có fixed profit ceiling? | NO |
| Bán chỉ 20%? | YES |
| Bán 50%? | YES |
| Giữ phần runner còn lại? | YES |
| Sau đó bán thêm runner? | YES, cần fresh valid decision |
| Volume cao tự động bullish? | NO |
| Phân tích hướng flow? | YES |
| Phân tích acceleration/deceleration? | YES |
| Missing data thành zero? | NO |
| Security thắng Jev HOLD với flow mạnh? | YES |
| User thắng Jev HOLD? | YES |
| Jev vượt transaction safety? | NO |
| SELL backoff dừng flow? | NO |
| Stale Jev bán trên position đã đổi? | NO, bị gate từ chối |
| Lỗi flow riêng một position dừng position khác? | NO với lỗi token đã phân loại; lỗi DB/hạ tầng chung vẫn có thể gây SYSTEM halt |

Các câu YES là khả năng cho phép bởi code/test, không phải cam kết Jev sẽ HOLD hoặc có tỷ lệ thắng cụ thể. Không có SELL do PnL âm, tuổi position, mốc TP cũ hoặc x10 **đơn độc**. Security/manual và đủ điều kiện thực thi vẫn quyết định cuối.

## Giới hạn vận hành

- Net flow là directional DEX volume của cửa sổ trượt. Chênh lệch hai rolling totals không phải số tiền mới đi vào trong khoảng giữa hai lần quan sát.
- Milestone, MFE/MAE và review là những gì thực sự được quan sát; không có dữ liệu liên tục khi ứng dụng tắt hoặc provider lỗi.
- New flow time series/context có retention hữu hạn. Append-only transaction/audit/market records lịch sử của dự án vẫn tăng; benchmark storage không phải cam kết tổng DB không tăng mãi khi giao dịch liên tục.
- Không tự chỉnh chiến lược từ kết quả học. Không thêm stop loss/time stop/profit ceiling, không sửa key hoặc ACK.
- Lệnh pnpm toàn cục có cảnh báo Node 20; scripts dùng project-local Node 22.22.0. SQLite còn experimental warning.
- Independent real System One schema check: `data/jev-exit-provider-check-1793233158931.json`, HOLD/INSUFFICIENT_DATA, 0 submitted transactions và 0 DB writes.

## Checkpoint trước deployment

29/10/2026 **07:19:27 Asia/Bangkok**: không có server ở cổng 3000, entries=false, halt=null, pending=0; balance **0,210491520 SOL**. IMAGINE **3.160.729.206**, LARP **2.367.401.294**, Memelord **2.267.435.022** atomic units đều khớp chain. Production migrations khi đó mới 1–5. Evidence `data/capital-flow-before-1793233167501.json`.

## Deployment và quan sát LIVE

Đã khởi động normal LIVE **07:23:11 ngày 29/10/2026**, PID **9104**, server báo sẵn sàng **07:23:42**, tại **http://127.0.0.1:3000**. Runtime báo policy `CAPITAL_FLOW_V1`, build `f753c5817a52515b949c8549473aa2c8280de2e0d89a5f24417b874d78216d6c`, cả ba capability mới đều true, Node 22.22.0; migration **1–8** có trên DB thật. Snapshot đầu sau startup chưa lấy được status khi server còn preflight; chỉ các checkpoint tiếp theo có runtime identity mới được dùng để chứng minh server LIVE.

Checkpoint **07:26:18** xác minh ba holding cũ đều khớp chain, không pending, entries=true/halt=null. Cả ba đã có fresh quote/flow timestamp khi PRE_SELL backoff còn đến khoảng 07:53–07:54. Snapshot **07:31:14** ghi thêm một BUY mới thành OPEN, tổng 4 holding khớp chain và pending=0; sau đó có BUY thứ hai được xác minh finalized tại **07:32:23**. Các snapshot đang chạy không phải một transaction DB/RPC nguyên tử; xem từng timestamp.

Hai BUY mới tự phát sinh từ scanner/Jev/Risk thật, không ép giao dịch: **bio999** nhận 4.564.448.873 atomic, signature `5udjNPvq435qjea3bC2vtK8FYwYGRf7do1jgxswaJNxz76tBXMyBJBqMetfCsKibVEgQHNbygi41hhi64DHacYjS`; mint `E1XGR9BnuN2ykn2iqMBq8qo6nWFmKoUcmiPq2u4bnXa1` nhận 4.659.340.962 atomic, signature `SLoQHCinBnNzLV2BBm1MqqU22F2gsyYDjkqsDEpZt3GLBSiHFZ83masCFZwJN7EXHY3Y8P37Tgcq8pWZg71oUeg`. Cả hai receipt independently **finalized**, token balance khớp. Cũng có một BUY failed/finalized vì slippage 6001, chỉ mất phí 5.438 lamports, không nhận token. Không ghi failed BUY thành chiến thắng hoặc holding.

Read-only browser kiểm tra đúng backend LIVE lúc **07:29:12**: ba card/ba flow card tại thời điểm đó, zero browser errors, **zero mutation requests**, screenshot `data/capital-flow-live-ui.png`; về sau số holding thay đổi do normal LIVE. Secret audit sau bổ sung evidence/backup: **927 tệp, zero matches**. Backup trước migration: `data/backups/pre-capital-flow-20261029-072304/`.

Evidence: `data/capital-flow-live-monitor-1793233578559.json`, `data/capital-flow-live-acceptance-1793233730716.json`, `data/capital-flow-final-1793233874095.json`, `data/capital-flow-live-receipts-1793233943233.json`; logs `data/capital-flow-live-20261029-072311.stdout.log` và `.stderr.log`. Báo cáo điều tra riêng: [BUY/SELL route và simulation](live-route-investigation-2026-10-29.md). Sau khi LIVE, chỉ đọc log/DB/báo giá/simulation không ký để điều tra; không sửa logic route, sizing hoặc execution.

**Checkpoint chốt 07:35:41:** PID/build không đổi, scanner running, entries=true, halt=null, **6 OPEN holdings** (3 cũ + 3 mới), tất cả quantity khớp chain; **pending=0**, migrations 1–8. Balance **200.171.787 lamports**. Có thêm BUY mới từ runtime sau checkpoint receipts ở trên, nên không dùng số 4/5 của checkpoint trước làm số hiện tại. Controlled-session history hash và quantity/cost/remaining cost/realized của ba holding cũ vẫn nguyên so với trước migration. Evidence: `data/capital-flow-final-checked-1793234141143.json`. Đây là trạng thái lúc chốt, không hứa số holding hoặc balance đứng yên khi normal LIVE tiếp tục.
