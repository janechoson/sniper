# SOLANA COVERAGE — Pump.fun / PumpSwap

Mốc số liệu thật: **2026-10-27T07:43:27.960Z**. Nguồn: API runtime REAL/PAPER, SQLite đang dùng; không có fixture trong database. Số liệu tiếp tục thay đổi khi scanner chạy.

## PUMP.FUN

- Program: `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`.
- Verified source: [IDL chính thức đã ghim](https://github.com/pump-fun/pump-public-docs/blob/639b87fb45c3adeffa6f7c4a1bf0cb85e392bf22/idl/pump.json).
- Discovery: **IMPLEMENTED**, create/create_v2, SPL Token và Token-2022, PDA/owner/mint/vault được kiểm tra. Token có thể được ghi nhận trước PumpSwap; không gọi đó là quyền mua.
- WS: đăng ký program trong socket phục hồi chung. Trạng thái tại mốc báo cáo: **DEGRADED**, lý do WS_INVALID_FRAME. Có nhận launch thật nhưng không chứng nhận đầy đủ.
- Polling fallback: 5 signature/15 giây/program, decode tối đa 10/lượt, cache transaction chung; TTL/backoff/caps như tài liệu protocol.
- Events detected: **120** curve đã lưu. Candidates: 70 lượt hoàn tất guard, 18 lượt có normalized state.

## PUMPSWAP

- Program: `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`.
- Verified source: [IDL chính thức đã ghim](https://github.com/pump-fun/pump-public-docs/blob/639b87fb45c3adeffa6f7c4a1bf0cb85e392bf22/idl/pump_amm.json).
- Discovery: **IMPLEMENTED**, create_pool cả outer/inner instruction, xác minh PDA index/creator/base/quote và ATA vault. Không suy ra migration chỉ từ index 0.
- WS/polling: cùng hạ tầng giới hạn với Pump.fun; subscriptions độc lập, reconnect không bỏ qua nguồn khác.
- Events detected: **25** pool. Candidates: 25 lượt hoàn tất guard, 7 lượt có normalized state.

## RAYDIUM / METEORA

Raydium CPMM giữ decoder/market/IDL cũ: 7 pool đã lưu (mốc trước triển khai là 6, đã quan sát thêm pool thật). Meteora DLMM giữ watcher/decoder, polling và IDL cũ; 0 pool được ghi nhận. Không có event tạo pool Meteora với cặp quote tin cậy được xác minh trong khoảng quan sát; không thay bằng hoạt động mẫu và không kết luận toàn bộ Meteora không có giao dịch. Regression tests Raydium/Meteora và socket đăng ký bốn nguồn được giữ.

## DEDUPLICATION

Identity token là chain + mint; source và pool tách riêng, lifecycle cache hữu hạn khôi phục từ journal real.pool. Signature outer/inner và notification trùng được dedupe. ObservationBook tiếp tục chống mua trùng mint, kể cả đã đóng hoặc đổi DEX. Đường entry Solana thêm đối chiếu entry đã ghi nhận theo mint cho lifecycle có Pump; portfolio revision, pending execution, locks và idempotency cũ vẫn quyết định cuối.

## CHEAP GUARD

Kiểm tra identity, quote tin cậy, mint initialized/supply, owner/PDA, curve active/dự trữ hoặc vault pool và thị trường USD có bằng chứng trước Features/holder/creator/Rug/Jev. Creator role phân biệt TOKEN_CREATOR với TOKEN_DEPLOYER và POOL_CREATOR. Không thêm ngưỡng volume/buyers/market-cap, không tăng slippage, không dùng UNKNOWN thành SAFE. Trường thiếu là lý do dừng, không tạo dữ liệu thành công giả.

## MARKET WINDOWS / BONDING CURVE

**PARTIAL có chủ đích về coverage**: giá/inventory/reserves on-chain được nối RollingMarketBook; tái sử dụng TradeEvent/BuyEvent/SellEvent từ transaction đã đọc, không gọi RPC riêng cho từng trade. Stream lấy mẫu hoặc có gap không đủ chứng nhận volume/count/unique 5s/15s/60s/5m: giữ UNKNOWN. Không cộng thiếu synthetic post-complete trades rồi công bố volume đầy đủ. Không phát minh phần trăm progress của curve.

PumpSwap xử lý virtual_quote_reserves i128 có dấu; real quote inventory loại protocol/creator fee, không lấy boost làm tiền thật. Trường thêm cuối trên account cũ chỉ dùng default đã được tài liệu chính thức xác nhận; test legacy account đi kèm. Công thức và nguồn nằm trong [tài liệu protocol](solana-pump-discovery.md).

## RUG CHECK / SELLABILITY / JEV / RISK

Giữ pipeline security, holder, creator, Rug Check, HardFilter, Jev, Score và Risk hiện có. Bằng chứng LP/holder/khả năng bán chưa xác minh của protocol mới vẫn UNKNOWN; không có adapter đặc cách an toàn cho Pump. Jev chỉ được gọi sau guard và các bước hiện hành; thiếu dữ liệu hoặc AI lỗi không trở thành BUY.

**SELLABILITY: UNKNOWN khi chỉ có quote**. Thử BUY + SELL không có simulation stateful không chứng minh bán được. Không nới chính sách LIVE.

## PAPER EXECUTION / LIVE

Chế độ hiện tại **PAPER**, ngân sách quan sát **5 USD/tín hiệu**; liveEnabled=false, executions=0. Không đổi sizing, slippage, stop loss, take profit, price impact hoặc ngưỡng Risk. Mục tiêu 10% số dư khả dụng vẫn là bàn giao LIVE riêng, chưa triển khai trong tác vụ này.

**LIVE TRANSACTIONS BROADCAST: NO.** Không import ví, build transaction trực tiếp của Pump, ký hoặc send RPC trong kiểm tra. Không thay key/provider trong .env.

## FUNNEL

| Nguồn        | Phát hiện | Qua guard | Dừng guard | Phân tích sâu | Rug từ chối | Sellability đạt | Gọi Jev | Risk đạt | Mua mô phỏng |
| ------------ | --------: | --------: | ---------: | ------------: | ----------: | --------------: | ------: | -------: | -----------: |
| pump-fun     |       120 |        28 |         42 |            18 |           0 |               0 |       1 |        0 |            0 |
| pump-swap    |        25 |        12 |         13 |             7 |           0 |               0 |       1 |        0 |            0 |
| raydium-cpmm |         7 |         0 |          0 |             7 |           0 |               0 |       1 |        0 |            0 |
| meteora-dlmm |         0 |         0 |          0 |             0 |           0 |               0 |       0 |        0 |            0 |

Phát hiện tính theo curve/pool duy nhất đã lưu, không phải tổng mint tạo toàn chain. Các bước sâu tính theo lượt đánh giá, có thể gồm reanalysis. Số gọi AI gồm lượt gọi, không đồng nghĩa response hợp lệ. Các lượt qua guard nhưng không tạo state do nguồn dữ liệu thiếu/timeout không bị tính thành deep analysis thành công. Những pool đang chờ chưa đi hết funnel.

## RPC REQUEST RATE / QUEUE DEPTH / LATENCY

- Inbox: **110**; active analysis: **2**.
- Events được chấp nhận/s: 0.11; candidate/s: 0.11.
- Average discovery latency: **51291.21 ms**, tính từ chain timestamp tới lần chấp nhận lưu; có backlog/backoff. Average analysis latency: **13281.87 ms**.
- Duplicates bỏ qua tại engine: 9; backpressure: 1826 lần thử, không phải 1826 token khác nhau.

| RPC       | Request logic | Request/s từ lúc khởi động | TB gồm queue/retry | Chờ/active | Lỗi |
| --------- | ------------: | -------------------------: | -----------------: | ---------: | --: |
| solana    |          1791 |                       3.24 |          966.57 ms |          5 |  44 |
| bnb       |          2643 |                       4.78 |         1946.09 ms |         11 |  26 |
| robinhood |          1958 |                       3.54 |          264.53 ms |          1 |   0 |

| Watcher      | Pending hints | Vượt giới hạn | Hết TTL | WS init trùng | Validation lỗi |
| ------------ | ------------: | ------------: | ------: | ------------: | -------------: |
| raydium-cpmm |             5 |             0 |       0 |             0 |              0 |
| meteora-dlmm |             5 |             0 |       0 |             0 |              0 |
| pump-fun     |           109 |            45 |     149 |             0 |              0 |
| pump-swap    |             0 |             0 |       0 |             0 |              0 |

Giới hạn hiện tại: inbox 300; mỗi nguồn Pump 50 kể cả đang ghi; 3 job phân tích, luân phiên nguồn; 128 hint/source; 256 cache transaction/market, 1024 signature dedupe. Những hint mất do giới hạn/TTL được báo rõ. Đây là scanner cục bộ có backpressure, **không phải full-chain indexer**. Trong lần quan sát có backlog và mất tín hiệu: coverage realtime vẫn PARTIAL, cần RPC/WS và công suất tương ứng để giảm mất dữ liệu; không che bằng counter hoặc token giả.

## JUPITER ROUTING — READ ONLY

- **pump-fun**: BUY_AND_SELL_QUOTED; mint `HnBYdk9RL4ANpA51YDzmYYXn3nN2aeL3AzDEUszspump`; BUY/SELL đều có quote; slippage 100 bps; sellability UNKNOWN.
- **pump-swap**: BUY_AND_SELL_QUOTED; mint `Bp6St3epV3baLSQFp6ux8BghtKMt9WtrLuPGNjK9pump`; BUY/SELL đều có quote; slippage 100 bps; sellability UNKNOWN.

Chỉ kiểm tra các mint mẫu đã quan sát ở thời điểm trên; không khẳng định mọi token của một venue đều route được. API key chỉ ở server/script; không xuất credential hoặc Authorization. Không mở allowlist thực thi mới. Source discovery không phải execution venue. Chạy lại `pnpm verify:pump` khi cần checkpoint mới; kết quả JSON ở `data/pump-paper-verification.json`.

## NGUỒN DỮ LIỆU

- REAL_ONCHAIN: transaction, signature, slot/time, instruction accounts, mint/program/curve/pool/vault và reserve.
- REAL_INTERNAL: journal, identity/lifecycle, quan hệ creator sau guard, counters/reasons, queue và timing.
- ESTIMATED: giá cận biên và inventory USD từ reserves/decimals/feed quote, không phải giá khớp lệnh.
- EXTERNAL: quote Jupiter, kết quả provider Rug/Jev theo pipeline đang có.
- UNKNOWN: security/holder/creator funding chưa có bằng chứng, sellability chưa stateful simulation, các market window thiếu coverage, progress chưa có denominator xác minh theo quote.

## KIỂM TRA

Kiểm thử có fixture chỉ trong tests: create/create_v2, create_pool, malformed identity/data, Token-2022, untrusted quote, outer/inner duplicate, cùng mint nhiều nguồn, guard không gọi Features/Rug/Jev, virtual quote âm/fee inventory, account legacy, shared RPC cache, burst/bounded queue, backpressure/backoff, WS duplicate/reconnect, fallback/cursor/restart và ObservationBook chống mua trùng. Không ghi fixture vào DB vận hành.

Kết quả xác minh bản cuối ngày 2026-10-27:

- `pnpm test`: 186 đạt, 4 kiểm tra mạng tùy chọn bỏ qua.
- `pnpm lint`: đạt.
- `pnpm typecheck`: đạt trong `pnpm build`.
- `pnpm build`: đạt, Next.js production build thành công.
- `pnpm verify:idls`: checksum của bốn IDL đạt.
- `pnpm test:browser`: đạt các viewport 1920/1440/1366/820/390, funnel bốn nguồn, kiểm tra SSE và bảo vệ thao tác.
- `pnpm verify:pump`: quote BUY và SELL thật thành công cho hai mint mẫu nêu trên; không build/ký/broadcast transaction.

Sau khởi động lại bản cuối, kiểm tra lúc **2026-10-27T07:53:46.490Z** ghi nhận Pump.fun **174**, PumpSwap **38**, Raydium **8**, Meteora **0** pool/curve đã lưu. REAL/PAPER, budget 5 USD, liveEnabled=false và executions=0 được xác nhận lại; browser smoke bản đang chạy đạt cả năm viewport. Snapshot công khai của lần kiểm tra này lưu tại `data/pump-final-runtime-check.json`. Các bảng funnel/latency ở trên giữ nguyên checkpoint 07:43 để đối chiếu cùng một khoảng đo. WebSocket vẫn DEGRADED, gồm WS_INVALID_FRAME và subscription Meteora chưa sẵn sàng; HTTP fallback còn hoạt động, không tuyên bố coverage đầy đủ sau restart.

## FILES CHANGED

- Chuỗi: `packages/chains/src/real/{pump-discovery,pump-market,solana-transaction,solana-discovery,adapter,idl}.ts`, `packages/chains/src/rpc/http.ts`, `packages/chains/src/index.ts`.
- Cấu hình/IDL: `packages/config/src/production.ts`, `packages/chains/idl/{pump-fun,pump-swap}.json`, manifest, `scripts/vendor-idls.mjs`; thêm deployment vào observation/real.example/real.reference JSON.
- Pipeline: `packages/core/src/index.ts`, `packages/engine/src/{discovery-monitor,real,real-features,analyzer,observation-analysis,schemas}.ts`.
- Creator: `packages/features/src/{creator-history,security-history}.ts` (phân biệt vai trò và lưu quan hệ có bằng chứng).
- UI: `apps/web/components/{discovery-funnel,terminal-overview,decision-panels,observation-panel,tables,format,vi,rug-check-report}`, `apps/web/app/globals.css`.
- Kiểm tra: `tests/pump-discovery.test.ts`, `tests/scanner-websocket.test.ts`, `tests/observation.test.ts`, `scripts/{browser-smoke,verify-pump}.mjs`, `package.json`.
- Tài liệu: `docs/solana-pump-discovery.md`, báo cáo này và `README.md`.
