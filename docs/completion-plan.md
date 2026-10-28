> Cập nhật local 27/10/2026: runtime hiện dùng một Node process + SQLite + ví cố định. Phần PostgreSQL/lease hoặc nhiều ví bên dưới là lịch sử trước refactor; không dùng để khởi động. Hướng dẫn hiện hành: [kiến trúc và migration local](local-migration.md), [Rug Check](rug-check.md).

# Kế hoạch hoàn thiện và audit hiện tại

Ngày 27/10/2026. Giữ nguyên kiến trúc giai đoạn 1–7, UI tiếng Việt, nền trắng và góc bo. REAL không fallback MOCK. Tích hợp Jev đã có tài liệu và SDK chính thức; tài liệu không còn là blocker. Ma trận phân biệt mã đã triển khai, fixture và xác minh trên mạng.

| COMPONENT              | CURRENT STATE                                                            | TARGET STATE                             | IMPLEMENTATION STATUS            | VERIFICATION                                       | BLOCKERS                                                                |
| ---------------------- | ------------------------------------------------------------------------ | ---------------------------------------- | -------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------- |
| Cấu hình               | Tách data/trading, kiểm tra ACK và xung đột biến cũ                      | Cấu hình rõ ràng, mặc định an toàn       | IMPLEMENTED                      | Zod/fixtures                                       | Không                                                                   |
| RPC HTTP/WS            | Scheduler, timeout/retry, reconnect, identity                            | Kết nối thực có coverage                 | PARTIAL                          | HTTP BNB56/RH4663, Solana slot/genesis; WS fixture | RPC/WS riêng, genesis pin                                               |
| EVM discovery          | V2/V3 ABI, confirmations, inbox/cursor, bounded backfill                 | Theo dõi dài hạn không mất event         | PARTIAL                          | ABI fixture; RH public bounded logs                | BNB public log limit; deep reorg cần đối soát thủ công                  |
| Solana discovery       | CPMM initialize/logs; DLMM CPI, IDL pinned hash                          | Theo dõi protocol có coverage            | PARTIAL                          | IDL checksum + encoding fixture                    | RPC capacity/WS; scan lâu dài chưa xác minh                             |
| Market                 | Reserves/bin/slot0, swap windows, source/quality                         | Giá/volume/coverage thật                 | PARTIAL                          | Rolling windows và RPC reader fixtures             | Feed USD, dữ liệu trực tiếp dài hạn                                     |
| Security               | Mint/Token2022, EVM code/ERC20/EIP1967                                   | Bằng chứng đủ policy                     | PARTIAL                          | Parser/UNKNOWN tests                               | Tax/blacklist/funding chưa chứng minh                                   |
| Holder/creator         | RPC holder đầy đủ khi chứng minh; internal relationships                 | Provider agnostic, không fake            | PARTIAL                          | Unknown/case sensitivity/persistence               | Chọn external bổ sung theo metric; không chặn phần độc lập              |
| Jev                    | SDK0.7 typed questions, sanitization/Zod/usage/timeout                   | Phân loại thật                           | IMPLEMENTED / LIVE UNVERIFIED    | 9 transport fixture tests                          | Node22 và TYPESAFE_API_KEY                                              |
| Score/Strategy         | Dùng analyzer/plugin hiện có                                             | AI không vượt quyền Risk                 | IMPLEMENTED                      | Baseline + safety tests                            | Dữ liệu bắt buộc UNKNOWN có thể từ chối                                 |
| Risk                   | Chain/portfolio/daily/failure/pending, immutable intents                 | Quyền cuối trước executor                | IMPLEMENTED                      | Revocation/idempotency fixtures                    | Cần đủ dữ liệu/giá/fee khi REAL                                         |
| EVM swap               | Direct V2, V3 IQuoter V1                                                 | Quote/build được kiểm tra                | PARTIAL                          | Quote mua/bán thật BNB và RH V2; build fixtures    | Không hỗ trợ QuoterV2 ABI tùy ý; route gas optimization chưa có         |
| Solana swap            | Jupiter V2 order/build, instruction/ALT checks                           | Quote/build từ provider thật             | PARTIAL                          | Instruction fixtures                               | JUPITER_API_KEY, program/owner policy                                   |
| Sellability/round-trip | Stateful EVM/Solana balance proof, không fake override                   | Chứng minh mua rồi bán + phí             | PARTIAL                          | Executor simulation fixtures                       | RPC simulation/funds read-only/provider config; full network unverified |
| REAL PAPER             | Quote thật → conservative simulated fill, no broadcast                   | Đo kết quả với dữ liệu thật              | IMPLEMENTED / E2E UNVERIFIED     | Raw fill/restart/partial exit tests                | AI/quoteUSD/security unknown                                            |
| Wallet/signer          | Nhiều ví, env/file, balance reader, public whitelist                     | Local signing có giới hạn                | IMPLEMENTED                      | EVM/Solana ký fixture; secret leak/path tests      | Chưa cấu hình ví; chưa có HSM/hardware                                  |
| Dry-run/LIVE           | Build/guard/simulate/exact approve/nonce/persist/sign/confirm            | LIVE có bằng chứng thực tế               | PARTIAL / NOT READY              | 9 executor fixture tests, không mạng               | Key/RPC/policy/funds/ACK; chưa broadcast/canary                         |
| Position/exit          | Confirmed-only, bigint, partial/TP/trailing/restart, read-only reconcile | Không oversell/resend; quản lý mọi chuỗi | IMPLEMENTED / NETWORK UNVERIFIED | Partial/restart/cost/trailing/lost response tests  | UNKNOWN receipt cần đối soát, quote unavailable vẫn chờ                 |
| Storage                | JSONL fsync + namespaces; Prisma projection + lease/migration            | Lưu bền và đọc lớn có chỉ mục            | PARTIAL                          | Journal tests, schema generate/validate            | Docker/PG không chạy; PostgreSQL paging chưa kiểm tra trên DB chạy      |
| UI                     | Chế độ/UNKNOWN/readiness/ví/số dư/analytics/explicit all-kill            | Giao diện quản lý thực tiếng Việt        | IMPLEMENTED                      | TypeScript/build/Chrome, xem verification.md       | Chưa vận hành với key thật                                              |
| Analytics              | Fills/fees/nullable valuation, groups/buckets/timing/outcomes6h24h       | Báo cáo dữ liệu có phạm vi rõ            | PARTIAL                          | Cost-basis/restart fixtures                        | Cache/coverage giới hạn, chưa có dataset dài hạn                        |
| Docs/verification      | Lệnh verifier chỉ đọc, config tham khảo, tài liệu mỗi module             | Phân biệt REAL/MOCK/UNKNOWN              | IMPLEMENTED                      | verify:idls và RPC reports                         | Chỉ báo cáo đã thực hiện, không suy rộng LIVE                           |

## Audit dấu vết cũ

Chạy pnpm audit:production để tái tạo audit-occurrences.md. MOCK_MODE_ONLY/TEST_ONLY không tự là lỗi REAL. Legacy PaperEngine, MockAIProvider, MockDexAdapter, DisabledWalletManager và LiveExecutor cũ chỉ dùng đường mock/tương thích; main chọn RealTradingEngine cho DATA_MODE=real. Cổng cấm MOCK trong đường REAL là bảo vệ, không phải placeholder. Không có mock fallback trong REAL.

## Nguồn triển khai

- [TypeSafe System One](https://docs.typesafe.ai/api/system-one)
- [Robinhood mainnet](https://docs.robinhood.com/chain/connecting/)
- [PancakeSwap V2 deployments](https://developer.pancakeswap.finance/contracts/v2/addresses)
- [Solana clusters](https://solana.com/docs/references/clusters)
- [BNB RPC](https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/json-rpc-endpoint/)
- [Jupiter Swap V2 build](https://github.com/jup-ag/docs/blob/main/swap/build/index.mdx)
- [Geth stateful simulation](https://geth.ethereum.org/docs/interacting-with-geth/rpc/ns-eth)

IDL chính thức được ghim commit/source/hash trong packages/chains/idl/manifest.json. Cấu hình tham khảo không tự bật LIVE, không có giá USD hoặc secret giả.
