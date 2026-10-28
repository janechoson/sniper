# Kết quả hoàn thiện LIVE_DRY_RUN

Giữ `TRADING_MODE=live_dry_run`, `LIVE_TRADING_ACK=false`, scanner dừng. Không broadcast, approve/wrap/unwrap on-chain, chuyển tiền hoặc tiêu gas. Không reset SQL/import dữ liệu cũ. Ký cục bộ trong EXECUTION_PREFLIGHT chỉ sau khi mô phỏng thành công; không lưu hay trả payload đã ký. Timestamp JSON là UTC của máy chạy.

## FIXED BLOCKERS — Đã sửa

- Native SOL qua Jupiter wrap/unwrap, dựng v0 transaction và đối soát fee/rent/token delta. Không yêu cầu có sẵn WSOL. Không tự đóng tài khoản WSOL có số dư sẵn trong đường hiện tại: trường hợp đó fail closed.
- PancakeSwap V2 native input/output trên BNB/Robinhood: xác minh chain ID, code router/factory, `factory()` và `WETH()` trước build. BUY dùng payable `swapExactETHForTokens`, SELL dùng `swapExactTokensForETH`; path bên trong dùng wrapped native. Không cần approval cho native BUY. Approval token SELL chỉ nằm trong mô phỏng, không gửi lên mạng.
- Sizing10% native sau reserve, token sizing độc lập với gas; pending execution vẫn chặn entry khác. Không hạ phần trăm hay tự giảm để vừa cap.
- Typed fee policy, nguồn giá độc lập chain có provenance, Jev startup probe và trạng thái WS chưa khởi động.
- RPC của engine ở dry-run dùng danh sách phương thức đọc/mô phỏng cho phép. `sendTransaction`, `eth_sendRawTransaction`, approval gửi thật và các phương thức ký/gửi khác bị chặn trước HTTP transport. Jupiter chỉ GET quote/build, không gọi submit/execute.
- Geth mặc định mô phỏng timestamp+12s làm quote10s hết hạn trên BNB. Simulator hiện pin block thật và mô phỏng giây kế tiếp hợp lệ; không lùi thời gian, không sửa balance/allowance/code. Không tăng TTL để né lỗi.

## REMAINING BLOCKERS — Còn bị chặn

Không có candidate được chiến lược phê duyệt trong các bài preflight này. Cập nhật chính sách: knownBadFunding không còn là chốt, mọi giá trị chỉ để nghiên cứu và UNKNOWN vẫn được giữ. Những trường rug/holder/legacy security trực tiếp ảnh hưởng khả năng thoát lệnh vẫn cần chứng minh. Xem [audit thay đổi funding](funding-informational-20261028.md).

Solana có bằng chứng đường thực thi, nhưng lần thử SOL/USDC với vốn hiện tại có chi phí vòng mua/bán khoảng7%, vượt giới hạn5%. Native reserve giữ được vốn phí nhưng không làm chi phí giao dịch biến mất. Không giảm sizing hoặc tăng giới hạn để cho qua.

Robinhood: WETH/USDG không cung cấp được route hợp lệ trong lần thử đầu. Việc duyệt factory có giới hạn cho thấy các pool native khác; IAF và UP đã trả lỗi `TRANSFER_FROM_FAILED` ở chân bán khi mô phỏng. Có lần health router lỗi tạm thời; lần thử lại UP đã xác minh router và đi tới lỗi chân bán. Không suy ra rằng tất cả token/venue trên chain đều lỗi. Chưa chứng minh được một round-trip thành công trên Robinhood.

## SOLANA LIVE_DRY_RUN

`SOL → USDC → SOL`, tiền đầu vào khoảng0,030087208 SOL sau reserve. Quote hai chiều cùng Metis, build có wrap/unwrap, combined stateful simulation, token/native/rent delta và chữ ký Ed25519 cục bộ đã kiểm tra. `executionPreflightReady=true`, không có ApprovedTradeIntent của chiến lược. `liveDryRunReady=false` vì security/risk chưa đạt và chi phí vượt policy.

## BNB LIVE_DRY_RUN

`BNB → WBNB → USDT → WBNB → BNB`, native input0,00432 BNB tại checkpoint. Hai quote, payable build, chuỗi approve/swap/reverse chỉ trong `eth_simulateV1`, native transfer trace và token balance delta thành công. Ký cục bộ và recover địa chỉ từ transaction đã ký thành công, không lưu raw transaction. Round-trip gồm phí khoảng2,83% tại checkpoint. `executionPreflightReady=true`, chiến lược chưa duyệt.

## ROBINHOOD LIVE_DRY_RUN

Native input khoảng0,0014273592 ETH sau reserve. Hạ tầng/giá/signer và V2 payable route hoạt động; quote BUY/SELL và build đã thực hiện trên pool WETH/token thật. Mô phỏng reverse chưa thành công nên không ký swap ví thật cho chain này. Không đánh dấu sellability hoặc simulation READY. Factory nhỏ được duyệt tối đa512 pool; nếu lớn hơn dùng mẫu có giới hạn. Không quét toàn chain.

## NATIVE/WRAPPED ROUTING

| Venue hiện có trong execution config                                  | Native semantics                                                    | Kết quả                                                     |
| --------------------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------- |
| BNB PancakeSwap V2                                                    | payable BUY; token SELL unwrap qua router; WETH()=WBNB              | READY cho preflight USDT                                    |
| Robinhood PancakeSwap V2                                              | payable BUY; token SELL unwrap qua router; WETH() xác minh bằng RPC | PARTIAL, reverse chưa qua                                   |
| Solana Jupiter Metis                                                  | wrapAndUnwrapSol=true cho SOL economic input/output                 | READY cho preflight USDC                                    |
| Generic EVM V3                                                        | Chưa xác minh native mechanism riêng                                | BLOCKED cho native                                          |
| Infinity/V4, launchpad, Pons/Long/pools.trade và nguồn discovery khác | Chưa có execution adapter trong config hiện tại                     | BLOCKED cho execution; discovery không đồng nghĩa giao dịch |

Không đổi quote tokenized stock/USDG thành WETH tùy ý. Chỉ ánh xạ WRAPPED_NATIVE sang NATIVE khi đó là cùng tài sản kinh tế đã cấu hình. Jupiter hiện giới hạn Raydium CP/Meteora DLMM, khớp deployment/account owners đã xác minh; không tự allow mọi program có trong response.

### Fee reserve và đơn vị

Cấu hình nằm trong `config/live.json`, schema ở `packages/config/src/production.ts`. Đây là safety defaults hiển thị rõ, chỉnh được; không phải cam kết phí cố định.

| Policy                                             | Solana (lamports) |        BNB (wei) | Robinhood (wei) |
| -------------------------------------------------- | ----------------: | ---------------: | --------------: |
| nativeFeeReserveByChain                            |           4178560 | 1800000000000000 | 726408000000000 |
| maxGasWeiByChain, mỗi giao dịch                    |                 — |  300000000000000 | 121068000000000 |
| solanaMaxFeeLamports                               |             50000 |                — |               — |
| solanaMaxNativeDebitLamports, overhead ngoài input |           4078560 |                — |               — |

EVM per-transaction cap dùng3 triệu gas × gas price đo được × hệ số2; reserve bằng6 lần cap cho trường hợp reset/approve/BUY và reset/approve/SELL. Khi giá gas tăng vượt cap, từ chối; không tự tiêu vượt dự phòng. Solana reserve dựa hai tài khoản SPL165byte, rent2039280lamports mỗi tài khoản, cộng hai fee cap50000lamports. Token2022/account lớn hơn hoặc route cần nhiều chi phí hơn phải bị từ chối hoặc cấu hình lại có căn cứ. Priority fee hiện0; fee vẫn đo qua getFeeForMessage, không giả định giao dịch miễn phí.

## PRICE ORACLE — Nguồn giá

BNB dùng Chainlink BNB/USD trên BNB (`REAL_ONCHAIN`). SOL và ETH dùng Coinbase Exchange SOL-USD/ETH-USD (`EXTERNAL`), nguồn USD độc lập chain. Ticker có timestamp giao dịch, bid/ask, kiểm tra giá dương, sai tài sản, tuổi≤30s, thời gian tương lai và spread/tick lệch quá policy. Không coi đây là oracle on-chain hoặc bảo chứng redemption của wrapped token. Giá USDC không mặc định1USD; nếu ticker không đạt thì UNKNOWN. USDG/tokenized stock chưa có feed đáng tin vẫn UNKNOWN.

Provenance gồm asset, source, sourceChain nếu có, observedAt, maxAgeMs và status. Không bịa confidence thống kê cho ticker/Chainlink. Production từ chối Chainlink cross-chain reference và giá hết hạn. Pyth đã thử nhưng trả401; không dùng làm nguồn hiện tại, không cần thêm Pyth key cho cấu hình Coinbase này.

## SECURITY UNKNOWN FIELDS — Phạm vi bằng chứng

| Nhóm metric                                                           | Phân loại và giới hạn                                            |
| --------------------------------------------------------------------- | ---------------------------------------------------------------- |
| RPC identity, balance, contract/mint/account data                     | REAL_ONCHAIN khi đọc/validate thành công                         |
| Quan hệ creator/token và lịch sử hệ thống thu thập                    | REAL_INTERNAL, chỉ trong phạm vi đã quan sát                     |
| Coinbase USD                                                          | EXTERNAL, kiểm tra tuổi/spread, không phải dữ liệu on-chain      |
| Chi phí/price impact/giá suy ra từ quote hoặc simulation              | ESTIMATED cho kết quả giao dịch tương lai; nguồn đầu vào thật    |
| Creator funding, lịch sử chưa quan sát, holder metrics thiếu coverage | UNKNOWN                                                          |
| SPL mintAuthority/freezeAuthority trên EVM                            | NOT_APPLICABLE; không bỏ kiểm tra mint/blacklist/pause của ERC20 |

`knownBadFunding` chỉ được lưu và hiển thị tham khảo, không chặn HardFilter/risk/intent/readiness và không tự thoát. Không gửi trường này hoặc quality metadata của nó cho Jev. Không cần provider funding để giao dịch. Holder/security adapter vẫn cần đủ coverage cho các trường rug quan trọng; không hardcode provider chưa xác minh. Solana không bắt buộc EVM tax flags; EVM không bắt buộc SPL authority.

## JEV STATUS

Ghim `jev-1.14.0` trong `.env`, defaults và `.env.example`. Provider startup dùng typed request với trạng thái thiếu dữ liệu được ghi rõ là healthcheck, validate đáp án trước khi READY. Execution preflight thành công về simulation tiếp tục phân tích state token thật bằng Jev; state gửi đi không có ví, số dư ví hay credentials. Health probe không phải BUY, lỗi vẫn AI_FAILED/fail closed.

Lần kiểm tra cuối: Jev phân loại USDC/Solana là SKIP, USDT/BNB là BUY. HardFilter thực tế vẫn từ chối do thiếu dữ liệu bắt buộc và các rủi ro đã biết; không tạo intent từ câu trả lời BUY. Helius trả lỗi khi lấy holder distribution trong preflight Solana nên holder concentration giữ UNKNOWN, không thay bằng0. Không khẳng định gói RPC hiện tại cung cấp đủ holder coverage.

## ROUND-TRIP RESULTS

Các checkpoint đầy đủ tại `data/execution-preflight-solana.json`, `data/execution-preflight-bnb.json`, `data/execution-preflight-robinhood.json`; lịch sử các lần chạy mới tại `data/execution-preflight-history.jsonl`. Mỗi report ghi quote input/output/minimum/impact/age, network cost, round-trip loss và lý do. JSON lớn có số liệu theo đúng thời điểm, không dùng các số trong tài liệu làm giá hay vốn runtime.

Sellability chỉ SELLABLE sau simulation có balance evidence, NOT_SELLABLE khi chứng minh chân bán thất bại với đủ token đã mua, còn trường hợp chưa rõ là UNKNOWN. Quote BUY hoặc self-call không cấp quyền đổi UNKNOWN thành SELLABLE.

## TEST RESULTS

Kiểm tra cuối: full suite307 tests pass,4 optional network tests skip; lint/typecheck và production build pass. Fixtures chỉ ở tests, không nạp runtime/SQL.

Kiểm tra có RPC no-broadcast trước transport, native V2 calldata/value/path tampering, Jupiter wrap/unwrap và cùng build engine, reserve/sizing, giá stale/future/sai asset/cross-chain, Jev startup, WS chưa start, simulation reverse fail/không hỗ trợ, native receipt fee/rent và reverted trace. Không dùng tests để tuyên bố đã xác nhận receipt tiền thật.

Dashboard đã khởi động lại bằng bản cuối tại http://127.0.0.1:3000: LIVE_DRY_RUN, scanner dừng, liveEnabled=false, executions=0, sizing10%. Chrome không có page error/tràn ngang ở5 kích thước390–1920px; snapshot/settings không chứa key ví/API hoặc API key trong RPC URL. Bằng chứng `data/live-dry-run-ui-check.json`. `pnpm verify:live` cuối trả exit2 đúng dự kiến: infrastructure/giá/Jev/WS hoạt động, còn thiếu candidate-specific security/risk. Số dư native ba ví đọc lại không đổi so với đầu tác vụ.

## LIVE_DRY_RUN READINESS MATRIX

READY bên dưới là khả năng đã kiểm tra cho EXECUTION_PREFLIGHT, không duyệt chiến lược hoặc mọi token trên chain.

| Capability                               | Solana  | BNB     | Robinhood      |
| ---------------------------------------- | ------- | ------- | -------------- |
| RPC                                      | READY   | READY   | READY          |
| WS transport                             | READY   | READY   | READY          |
| Wallet                                   | READY   | READY   | READY          |
| Signer                                   | READY   | READY   | READY          |
| Native balance                           | READY   | READY   | READY          |
| Fee reserve                              | READY   | READY   | READY          |
| Price oracle/reference                   | READY   | READY   | READY          |
| BUY quote                                | READY   | READY   | READY          |
| SELL quote                               | READY   | READY   | READY          |
| Round-trip                               | READY   | READY   | BLOCKED        |
| Sellability                              | READY   | READY   | BLOCKED        |
| Security                                 | PARTIAL | PARTIAL | PARTIAL        |
| Jev                                      | READY   | READY   | READY (health) |
| Risk                                     | BLOCKED | BLOCKED | BLOCKED        |
| Native route                             | READY   | READY   | PARTIAL        |
| Build TX                                 | READY   | READY   | READY          |
| Simulation                               | READY   | READY   | BLOCKED        |
| Local signing swap                       | READY   | READY   | PARTIAL        |
| Broadcast                                | LOCKED  | LOCKED  | LOCKED         |
| EXECUTION_PREFLIGHT                      | READY   | READY   | BLOCKED        |
| LIVE_DRY_RUN, gồm security/risk/strategy | BLOCKED | BLOCKED | BLOCKED        |
| LIVE                                     | LOCKED  | LOCKED  | LOCKED         |

WS đã thử transport riêng; scanner cố ý dừng hiển thị NOT_STARTED, không giả vờ stream đang chạy. Runtime readiness tách các capability; dữ liệu preflight lịch sử chỉ là bằng chứng, không tự cấp quyền giao dịch.

## LIVE READINESS MATRIX

| Điều kiện còn thiếu                       | Solana          | BNB             | Robinhood       |
| ----------------------------------------- | --------------- | --------------- | --------------- |
| Security/risk/strategy approval hiện hành | BLOCKED         | BLOCKED         | BLOCKED         |
| Native confirmation trên giao dịch thật   | CANARY_REQUIRED | CANARY_REQUIRED | CANARY_REQUIRED |
| Owner activation/ACK                      | LOCKED          | LOCKED          | LOCKED          |
| LIVE_READY                                | BLOCKED         | BLOCKED         | BLOCKED         |

## CANARY REQUIREMENTS

Chưa chạy canary. Trước canary phải có candidate/route đủ security và risk, phí/size/freshness hợp lệ và người dùng kích hoạt riêng. EVM native confirmation cần transaction/receipt cùng hash, transfer logs và callTracer để đối soát native; RPC thiếu trace phải giữ UNKNOWN. Solana native confirmation đối chiếu signature/fee payer, pre/post native balances, token deltas và rent. Có tests/simulation cho machinery này nhưng chưa có bằng chứng receipt tiền thật.

Receipt/trace thiếu hoặc sai không tạo vị thế CONFIRMED; không tự resend hay đổi nonce. Các kỹ năng hạ tầng hoạt động không thay thế canary.

## OWNER ACTIONS STILL REQUIRED

Không cần nhập lại Helius/Jupiter/TypeSafe key và không cần provider funding cho entry. Cần nguồn holder/security đủ coverage cho các trường rug quan trọng còn UNKNOWN. Cần route/token Robinhood vượt qua simulation. Review safety fee policy theo phí/account thực tế; không tăng cap hoặc giảm10% tự động để ép lệnh. Chỉ sau khi các điều kiện đạt, chủ ví mới xét kích hoạt và canary ở tác vụ riêng.

### Lệnh chạy lại không broadcast

```sh
pnpm verify:live
pnpm verify:live-dry-run:solana
pnpm verify:live-dry-run:bnb
pnpm verify:live-dry-run:robinhood
```

`verify:live` exit2 khi chưa đủ readiness. Preflight từng chain exit0 chỉ khi đường thực thi đã qua; không đồng nghĩa risk/strategy/LIVE đạt. Chế độ khác live_dry_run hoặc ACK=true bị preflight từ chối. Launcher Windows dùng Node22 local nếu Node hệ thống cũ.

Nguồn chính thức: [Jupiter build/native wrapping](https://developers.jup.ag/docs/swap/build), [Jupiter build API](https://developers.jup.ag/docs/api-reference/swap/build), [Pancake V2 native functions](https://developer.pancakeswap.finance/contracts/v2/router-v2), [Coinbase public ticker](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-ticker), [Geth simulation](https://geth.ethereum.org/docs/interacting-with-geth/rpc/ns-eth), [TypeSafe models](https://docs.typesafe.ai/models).
