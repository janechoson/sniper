# Rug Check dựa trên bằng chứng

## Quyết định

NormalizedTokenState → Rug Check providers → PRECHECK/hard filters → quote BUY/SELL + round-trip simulation → Jev risk/classification → score → RiskEngine → fresh quote/simulation → ApprovedTradeIntent → executor. Tín hiệu BUY/PASS của Jev chỉ đề nghị tiếp tục đánh giá, không cấp quyền giao dịch. RiskEngine và kill switch quyết định cuối.

Mỗi finding có giá trị, SAFE/RISK/UNKNOWN/NOT_APPLICABLE, nguồn, thời điểm, hạn dùng, độ tin cậy, lý do và tham chiếu. UNKNOWN có value=null; không đổi thành0/false/SAFE. Xung đột không bị trung bình hóa thành an toàn; bằng chứng RISK ưu tiên, mâu thuẫn khác thành UNKNOWN. Không có điểm rug tổng hợp tự đặt hoặc cam kết token không rug.

## Phạm vi và nguồn

| Dữ liệu                                                                                        | Nguồn                        | Giới hạn                                                                                                          |
| ---------------------------------------------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| EVM codehash/supply/decimals/owner; EIP1967 implementation/admin/beacon; EIP1167 exact pattern | REAL_ONCHAIN                 | Cùng block, xác minh hash; đọc owner không chứng minh mọi quyền admin đã mất                                      |
| Solana mint/freeze, Token2022 extension/transfer hook/delegate/fee                             | REAL_ONCHAIN                 | Phân biệt có quyền freeze với token đã frozen; extension chưa hỗ trợ UNKNOWN                                      |
| Phân bố Solana holders raw/adjusted                                                            | REAL_ONCHAIN                 | Chỉ tính khi 20 tài khoản lớn nhất bao phủ đủ supply và mint/accounts cùng slot; thiếu coverage thì UNKNOWN       |
| EVM holders                                                                                    | EXTERNAL hoặc UNKNOWN        | Không full-chain scan; GoPlus raw top1/5/10 nếu có đủ dữ liệu; adjusted cần exclusions đã xác minh                |
| CPMM/DLMM vault reserves, EVM V2 trusted factory reserves                                      | REAL_ONCHAIN                 | CPMM trừ protocol/fund/creator fees; DLMM position NFT/LP ownership chưa suy đoán                                 |
| LP burn/creator LP holding                                                                     | REAL_ONCHAIN hoặc UNKNOWN    | Chỉ theo bằng chứng thực; zero-address LP balance không bảo đảm an toàn toàn pool                                 |
| Locker/vesting/unlock time                                                                     | UNKNOWN hoặc EXTERNAL        | Chưa có adapter locker tổng quát xác minh thời gian/owner                                                         |
| Creator/token relationships, history và incidents có chứng cứ actor                            | REAL_INTERNAL                | Là dataset hệ thống, không phải toàn bộ lịch sử chain; pool creator không đồng nghĩa token deployer               |
| Holder funding cluster                                                                         | REAL_INTERNAL hoặc UNKNOWN   | Dataset có provenance; chung funder chỉ WEAK/STRONG_SIGNAL, không kết luận chung chủ; chưa có RPC funding indexer |
| Giá/liquidity USD từ market state                                                              | ESTIMATED khi derive         | Phải có feed quote USD đã xác minh; không tự gán stablecoin1USD                                                   |
| Sellability/round-trip                                                                         | REAL_SIMULATION hoặc UNKNOWN | Quote SELL được không chứng minh bán được; lỗi mạng không tự gán honeypot                                         |
| Security ngoài                                                                                 | REAL_EXTERNAL                | Opt-in, source riêng, không thay simulation của executor                                                          |

EXTERNAL trong bảng là nhóm nguồn ngoài; origin lưu chính xác REAL_EXTERNAL. MOCK chỉ dành mock/tests và bị từ chối ở REAL. ESTIMATED được ghi rõ. Chưa chọn external provider trả phí cho holder/creator enrichment; adapter/provider-agnostic đã giữ. GoPlus/Honeypot/RugCheck là các adapter security opt-in đã xác minh, không thay nhà cung cấp holder toàn diện.

## Providers

OnChainSecurityProvider, OnChainHolderSecurityProvider, OnChainLiquiditySecurityProvider, SolanaLiquiditySecurityProvider, CreatorIntelligenceProvider và optional ExternalSecurityProvider. Mỗi provider timeout/cache/health riêng, có invalidate; cache bounded. Không một provider lỗi khiến hệ thống bịa dữ liệu hoặc fallback mock. Chỉ dữ liệu token cần quyết định được gửi Jev; không địa chỉ/số dư ví, khóa hoặc credentials.

GoPlus: kiểm tra chain support bằng API trước, giữ UNKNOWN khi field trống; tax fraction đổi sang phần trăm. Honeypot: Ethereum/BNB/Base theo tài liệu đã đọc; Robinhood không hỗ trợ, simulationSuccess=false không đồng nghĩa honeypot. RugCheck: Solana public summary, LP lock percentage/risk warnings; bỏ aggregate score không có semantics nội bộ, không bịa unlock time.

Nguồn đã tra cứu: https://docs.gopluslabs.io/reference/response-details ; https://docs.gopluslabs.io/reference/getchainslistusingget ; https://docs.honeypot.is/ishoneypot ; https://docs.honeypot.is/chains ; https://api.rugcheck.xyz/swagger/doc.json . Adapter gọi GET công khai hiện tại, không thêm biến API key giả cho endpoint không yêu cầu. HTTPtimeout/bodycap/concurrency/cache/inflight dedupe đều giới hạn. Không lưu raw response lớn hay Authorization.

## Jev và policy

Official @typesafe-ai/sdk systemOne với choice/noul/score; câu hỏi rug_risk,suspicious,insufficient_data,risk_category,advisory action PASS/WATCH/SKIP. Score giữ khoảng0..4 theo SDK; probability/confidence chỉ dùng khi đúng kiểu. Zod kiểm tra shape/range. Ghi provider/model đã resolve/hash/latency/usage/timestamp, không credential. Timeout/401/429/schema/network/SDK lỗi thành UNAVAILABLE/AI_FAILED, không chuyển BUY hoặc mock ở REAL.

rugCheck.policy và policyByChain có trường bắt buộc, tuổi bằng chứng/sellability, giới hạn concentration/tax/LP/roundtrip và AI threshold cấu hình. config/rug-policy.conservative.example.json chỉ là ví dụ, không cam kết lợi nhuận/an toàn. Concentration mặc định adjusted: không có adjusted tin cậy thì UNKNOWN; muốn raw phải cấu hình rõ. Chính sách Solana/EVM khác nhau, không suy đoán authority không áp dụng cho chuỗi khác. Legacy hard filters vẫn giữ và có thể chặt hơn policy mới.

## Theo dõi và lưu trữ

SQLite lưu rug_check_snapshots, security_evidence, holder_snapshots/clusters, creator_history, liquidity_snapshots, sellability_checks, round_trip_checks, external_security_results, jev_risk_results, risk_decisions/reason_codes trong cùng transaction journal. Snapshot hash dựa dữ liệu có ý nghĩa, loại timestamp/cache timings; phản hồi AI gắn hash/model/time.

Monitor vị thế đang mở làm mới theo interval mặc định15s, invalidates cache, dùng thông tin liquidity/security đã xác minh; nguy cơ nghiêm trọng đi qua closePosition và mọi chốt execution bình thường, không cần chờ Jev để thoát. ALL_TRADING_DISABLED vẫn chặn cả exits đúng semantics đã xác nhận; entry kill riêng vẫn cho protective exits.

Dashboard: report chi tiết trong token modal, nguồn/tuổi/hạn dữ liệu, disagreements, reason codes, Jev và readiness theo token quan sát gần nhất. Không phải chứng nhận an toàn toàn chain. Analytics tính latency percentiles khi đủ mẫu (p50>=5,p95>=20,p99>=100), cache bounded và outcome horizon thật. Liquidity USD giảm90% là quan sát collapse, chưa chứng minh creator rug; false positive/negative chỉ là ứng viên cần rà soát.

## Xác minh

pnpm verify:rug --chain bnb --token DIA_CHI --pool BE --config config/real.reference.json --external --save data/rug-report.json. Lệnh chỉ đọc, không Jev/signer/broadcast. Kiểm thử fixtures đánh dấu rõ không phải on-chain production. Báo cáo mạng công khai BNB/Robinhood đã trả reserves/code/security ngoài; Solana RPC có thể timeout/rate-limit nên giữ UNKNOWN. Chưa xác minh full production Jev/trade/dry-run vì môi trường/key/feed/coverage còn thiếu. Kiểm tra cuối tại verification.md.
