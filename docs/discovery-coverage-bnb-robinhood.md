# Độ phủ discovery BNB / Robinhood

## Trước thay đổi — kiểm tra ngày 2026-10-27

| Chain            | Protocol       | Factory                                      | Pool    | Cơ chế        | Quote | WS / HTTP                                                                                 | Giới hạn                                                                   |
| ---------------- | -------------- | -------------------------------------------- | ------- | ------------- | ----- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| BNB (56)         | PancakeSwap V2 | `0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73` | V2 pair | `PairCreated` | WBNB  | `newHeads` đánh thức polling; HTTP mỗi 3 giây, 200 block/lượt; cursor/checkpoint bền vững | Chỉ cặp mới có đúng một quote tin cậy; không có launchpad/V3/Infinity      |
| Robinhood (4663) | PancakeSwap V2 | `0x02a84c1b3BBD7401a5f7fa98a384EBC70bB5749E` | V2 pair | `PairCreated` | WETH  | Như BNB                                                                                   | Chỉ một factory; token ghép quote khác bị bỏ qua; không có launchpad/V3/V4 |

Router trước thay đổi: BNB `0x10ED43C718714eb63d5aA57B78B54704E256024E`; Robinhood `0x8cFe327CEc66d1C090Dd72bd0FF11d690C33a2Eb`. Cấu hình vận hành `config/observation.json`; không phụ thuộc số dư WBNB/WETH để nhận PairCreated. Initial lookback 400 block, không quét genesis. ABI V2/V3 có sẵn nhưng chỉ V2 được cấu hình.

Kết quả kiểm tra chỉ đọc trước thay đổi lưu ở `data/evm-discovery-diagnosis-20261027.json`: Robinhood cursor theo sát head, factory có 390 pair, không có PairCreated trong 1.000 block vừa kiểm tra; BNB có 77. Không kết luận toàn hệ sinh thái không có token mới từ một factory.

## Sau thay đổi — cấu hình vận hành

BNB: **10 source deployment**; Robinhood: **16 source deployment**, gồm bốn strategy pools.trade (3.3 creator/standard và 3.2 creator/standard). Tổng 26 EVM source + 4 Solana source. Không cộng version thành protocol độc lập để thổi số liệu.

| Chain     | Protocol/source                                                                                               | Status               | Discovery method                                         | Earliest stage       | Quote assets                             | Graduation destination                             | Real verified                 | Limitations                                                    |
| --------- | ------------------------------------------------------------------------------------------------------------- | -------------------- | -------------------------------------------------------- | -------------------- | ---------------------------------------- | -------------------------------------------------- | ----------------------------- | -------------------------------------------------------------- |
| bnb       | [pancakeswap-v2](https://developer.pancakeswap.finance/contracts/v2/addresses)                                | SUPPORTED discovery  | PairCreated                                              | DEX pool             | quote từ cặp                             | —                                                  | RPC logs + receipt + decode   | market reader hiện có; source mới chưa có executor riêng       |
| robinhood | [pancakeswap-v2](https://developer.pancakeswap.finance/contracts/v2/addresses)                                | PARTIAL verification | PairCreated                                              | DEX pool             | quote từ cặp                             | —                                                  | code/ABI; NO_EVENTS_IN_WINDOW | market reader hiện có; source mới chưa có executor riêng       |
| bnb       | [pancakeswap-v3](https://developer.pancakeswap.finance/contracts/v3/addresses)                                | SUPPORTED discovery  | PoolCreated + fee tier                                   | DEX pool             | hai currency thực                        | —                                                  | RPC logs + receipt + decode   | market reader hiện có; source mới chưa có executor riêng       |
| bnb       | [pancakeswap-infinity-cl](https://developer.pancakeswap.finance/contracts/infinity/resources/addresses)       | SUPPORTED discovery  | CLPoolManager.Initialize + parameters                    | CL pool initialized  | native/ERC20                             | Infinity CL                                        | RPC logs + receipt + decode   | discovery/lifecycle; thị trường sâu/khả năng bán chưa xác minh |
| bnb       | [openfour](https://github.com/four-meme-community/openfour-docs)                                              | SUPPORTED discovery  | TokenCreated; PhaseTransition; MigrateExecuted; Registry | LAUNCH_CREATED       | quoteAsset trong event                   | module migrate; giữ encoded data/version           | RPC logs + receipt + decode   | discovery/lifecycle; thị trường sâu/khả năng bán chưa xác minh |
| bnb       | [flap](https://docs.flap.sh/flap/developers/deployed-contract-addresses)                                      | SUPPORTED discovery  | TokenCreated + TokenQuoteSet cùng receipt                | CURVE_CREATED        | native mặc định theo docs; override thực | BNB theo migrator; RH Uniswap V2                   | RPC logs + receipt + decode   | discovery/lifecycle; thị trường sâu/khả năng bán chưa xác minh |
| bnb       | [uniswap-v2](https://developers.uniswap.org/deployments.json)                                                 | PARTIAL verification | PairCreated                                              | DEX pool             | hai currency thực                        | —                                                  | code/ABI; NO_EVENTS_IN_WINDOW | market reader hiện có; source mới chưa có executor riêng       |
| bnb       | [uniswap-v3](https://developers.uniswap.org/deployments.json)                                                 | PARTIAL verification | PoolCreated + fee tier                                   | DEX pool             | hai currency thực                        | —                                                  | code/ABI; NO_EVENTS_IN_WINDOW | market reader hiện có; source mới chưa có executor riêng       |
| bnb       | [uniswap-v4](https://developers.uniswap.org/deployments.json)                                                 | SUPPORTED discovery  | PoolManager.Initialize + PoolId/PoolKey                  | Pool initialized     | native/ERC20; UNKNOWN giữ nguyên         | singleton                                          | RPC logs + receipt + decode   | discovery/lifecycle; thị trường sâu/khả năng bán chưa xác minh |
| robinhood | [pancakeswap-v3](https://developer.pancakeswap.finance/contracts/v3/addresses)                                | PARTIAL verification | PoolCreated + fee tier                                   | DEX pool             | hai currency thực                        | —                                                  | code/ABI; NO_EVENTS_IN_WINDOW | market reader hiện có; source mới chưa có executor riêng       |
| robinhood | [pancakeswap-infinity-cl](https://developer.pancakeswap.finance/contracts/infinity/resources/addresses)       | PARTIAL verification | CLPoolManager.Initialize + parameters                    | CL pool initialized  | native/ERC20                             | Infinity CL                                        | code/ABI; NO_EVENTS_IN_WINDOW | discovery/lifecycle; thị trường sâu/khả năng bán chưa xác minh |
| robinhood | [openfour](https://github.com/four-meme-community/openfour-docs)                                              | PARTIAL verification | TokenCreated; PhaseTransition; MigrateExecuted; Registry | LAUNCH_CREATED       | quoteAsset trong event                   | module migrate; giữ encoded data/version           | code/ABI; NO_EVENTS_IN_WINDOW | discovery/lifecycle; thị trường sâu/khả năng bán chưa xác minh |
| robinhood | [flap](https://docs.flap.sh/flap/developers/deployed-contract-addresses)                                      | SUPPORTED discovery  | TokenCreated + TokenQuoteSet cùng receipt                | CURVE_CREATED        | native mặc định theo docs; override thực | BNB theo migrator; RH Uniswap V2                   | RPC logs + receipt + decode   | discovery/lifecycle; thị trường sâu/khả năng bán chưa xác minh |
| robinhood | [uniswap-v2](https://developers.uniswap.org/deployments.json)                                                 | SUPPORTED discovery  | PairCreated                                              | DEX pool             | hai currency thực                        | —                                                  | RPC logs + receipt + decode   | market reader hiện có; source mới chưa có executor riêng       |
| robinhood | [uniswap-v3](https://developers.uniswap.org/deployments.json)                                                 | SUPPORTED discovery  | PoolCreated + fee tier                                   | DEX pool             | hai currency thực                        | —                                                  | RPC logs + receipt + decode   | market reader hiện có; source mới chưa có executor riêng       |
| robinhood | [uniswap-v4](https://developers.uniswap.org/deployments.json)                                                 | SUPPORTED discovery  | PoolManager.Initialize + PoolId/PoolKey                  | Pool initialized     | native/ERC20; UNKNOWN giữ nguyên         | singleton                                          | RPC logs + receipt + decode   | discovery/lifecycle; thị trường sâu/khả năng bán chưa xác minh |
| bnb       | [pancakeswap-infinity-bin](https://developer.pancakeswap.finance/contracts/infinity/resources/addresses)      | PARTIAL verification | BinPoolManager.Initialize + activeId                     | Bin pool initialized | native/ERC20                             | Infinity Bin                                       | code/ABI; NO_EVENTS_IN_WINDOW | discovery/lifecycle; thị trường sâu/khả năng bán chưa xác minh |
| bnb       | [four-meme](https://github.com/four-meme-community/fourmeme-docs)                                             | SUPPORTED discovery  | TokenCreate; _tokenInfos; LiquidityAdded                 | CURVE_CREATED        | native/quote thực từ registry            | DEX pool theo evidence; không suy ra V2/V3 cố định | RPC logs + receipt + decode   | discovery/lifecycle; thị trường sâu/khả năng bán chưa xác minh |
| robinhood | [pons-v2](https://docs.ponsfamily.com/docs/v2)                                                                | SUPPORTED discovery  | TokenLaunched; LaunchSwept; PoolGraduated                | CURVE_CREATED        | pairToken thực; native/ERC20/stocks      | Uniswap V4                                         | RPC logs + receipt + decode   | discovery/lifecycle; thị trường sâu/khả năng bán chưa xác minh |
| robinhood | [bags](https://docs.bags.fm/robinhood/contracts)                                                              | PARTIAL verification | TokenCreated + curveForToken                             | CURVE_CREATED        | native ETH                               | Uniswap V4                                         | code/ABI; NO_EVENTS_IN_WINDOW | discovery/lifecycle; thị trường sâu/khả năng bán chưa xác minh |
| robinhood | [doppler](https://github.com/whetstoneresearch/doppler/blob/main/deployments/4663.md)                         | SUPPORTED discovery  | Airlock.Create/Migrate + getAssetData                    | LAUNCH_CREATED       | numeraire thực                           | pool/hook theo event                               | RPC logs + receipt + decode   | discovery/lifecycle; thị trường sâu/khả năng bán chưa xác minh |
| robinhood | [pools-trade-creator-v33](https://developers.uniswap.org/docs/liquidity/liquidity-launchpad/deployments)      | PARTIAL verification | InstantLaunchStrategy.TokenLaunched + PoolKey            | INSTANT_LAUNCHED     | key.currency0 / currency1                | không có curve graduation                          | code/ABI; NO_EVENTS_IN_WINDOW | discovery/lifecycle; thị trường sâu/khả năng bán chưa xác minh |
| robinhood | [pools-trade-standard-v33](https://developers.uniswap.org/docs/liquidity/liquidity-launchpad/deployments)     | PARTIAL verification | InstantLaunchStrategy.TokenLaunched + PoolKey            | INSTANT_LAUNCHED     | key.currency0 / currency1                | không có curve graduation                          | code/ABI; NO_EVENTS_IN_WINDOW | discovery/lifecycle; thị trường sâu/khả năng bán chưa xác minh |
| robinhood | [pools-trade-creator-v32](https://developers.uniswap.org/docs/liquidity/liquidity-launchpad/deployments)      | SUPPORTED discovery  | InstantLaunchStrategy.TokenLaunched + PoolKey            | INSTANT_LAUNCHED     | key.currency0 / currency1                | không có curve graduation                          | RPC logs + receipt + decode   | discovery/lifecycle; thị trường sâu/khả năng bán chưa xác minh |
| robinhood | [long](https://robinhoodchain.blockscout.com/address/0x22e99278308b393ea1260859b181ad7e78f5eeed?tab=contract) | PARTIAL verification | LongLauncher.LaunchCreated (ABI current verified)        | LAUNCH_CREATED       | numeraire thực; không ép WETH            | Doppler / Uniswap V4                               | code/ABI; NO_EVENTS_IN_WINDOW | discovery/lifecycle; thị trường sâu/khả năng bán chưa xác minh |
| robinhood | [pools-trade-standard-v32](https://developers.uniswap.org/docs/liquidity/liquidity-launchpad/deployments)     | PARTIAL verification | InstantLaunchStrategy.TokenLaunched + PoolKey            | INSTANT_LAUNCHED     | key.currency0 / currency1                | không có curve graduation                          | code/ABI; NO_EVENTS_IN_WINDOW | discovery/lifecycle; thị trường sâu/khả năng bán chưa xác minh |

SUPPORTED ở đây nói về discovery có sự kiện thật trong checkpoint, không có nghĩa token an toàn hoặc được phép giao dịch. PARTIAL verification: adapter đã có fixture, ABI/source và code tại địa chỉ; chưa thấy event trong cửa sổ ngắn để xác nhận giải mã live. Không kết luận protocol không hoạt động từ số 0.

### Địa chỉ bật độc lập

| Chain     | Source                   | Contract / manager                           |
| --------- | ------------------------ | -------------------------------------------- |
| bnb       | pancakeswap-v2           | `0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73` |
| robinhood | pancakeswap-v2           | `0x02a84c1b3BBD7401a5f7fa98a384EBC70bB5749E` |
| bnb       | pancakeswap-v3           | `0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865` |
| bnb       | pancakeswap-infinity-cl  | `0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b` |
| bnb       | openfour                 | `0xebe7b6C1089D9F72aD07f34E36d898e44E5e27f3` |
| bnb       | flap                     | `0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0` |
| bnb       | uniswap-v2               | `0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6` |
| bnb       | uniswap-v3               | `0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7` |
| bnb       | uniswap-v4               | `0x28e2Ea090877bF75740558f6BFB36A5ffeE9e9dF` |
| robinhood | pancakeswap-v3           | `0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865` |
| robinhood | pancakeswap-infinity-cl  | `0xeE04c68742e6Bf434bE8039580D2e89BBE55bc6f` |
| robinhood | openfour                 | `0xebe7b6C1089D9F72aD07f34E36d898e44E5e27f3` |
| robinhood | flap                     | `0x26605f322f7fF986f381bB9A6e3f5DAb0bEaEb09` |
| robinhood | uniswap-v2               | `0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f` |
| robinhood | uniswap-v3               | `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` |
| robinhood | uniswap-v4               | `0x8366a39CC670B4001A1121B8F6A443A643e40951` |
| bnb       | pancakeswap-infinity-bin | `0xC697d2898e0D09264376196696c51D7aBbbAA4a9` |
| bnb       | four-meme                | `0x5c952063c7fc8610FFDB798152D69F0B9550762b` |
| robinhood | pons-v2                  | `0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e` |
| robinhood | bags                     | `0xe8Cc4431adF8b5A847C113EF0c6af9043219Cb37` |
| robinhood | doppler                  | `0xeb7c034704ef8dcd2d32324c1545f62fb4ad0862` |
| robinhood | pools-trade-creator-v33  | `0x7c48DDe3B447381F4d986334679b3Afc7F2D35C2` |
| robinhood | pools-trade-standard-v33 | `0xC9566675b1Ea42861546f3c5B74Ace2c79c49572` |
| robinhood | pools-trade-creator-v32  | `0x23f8209572b4a1C2AD88A42749E830791Fb027f1` |
| robinhood | long                     | `0x22e99278308b393ea1260859b181ad7e78f5eeed` |
| robinhood | pools-trade-standard-v32 | `0xAD44D55E7f8337C3cE113fBb591486E85be104b2` |

## Thay đổi kiến trúc

- Dùng watcher chung EvmLaunchDiscovery và decoder theo ABI profile; StrategyEngine/RiskEngine không import launchpad SDK. Mỗi deployment có enabled riêng trong hệ thống config hiện có, không thêm một bộ env song song.
- Pool V2/V3 vẫn có địa chỉ hợp đồng; V4/Infinity lưu PoolId bytes32 và manager riêng. PoolId được tính lại bằng ABI PoolKey, gồm hook, fee, tickSpacing hoặc parameters và manager của Infinity. Không lấy manager address làm địa chỉ từng pool.
- RPC logs được xác minh bằng receipt thành công, hash/number canonical, emitter và log index/data/topics. Callback phải lưu bền vững trước khi cursor/checkpoint tiến. Reorg dừng source với lý do đối soát, không im lặng nhảy qua.
- newHeads đánh thức HTTP; polling dự phòng mỗi 3 giây. Receipt/block/code cache dùng chung; getLogs cùng khoảng block gom địa chỉ và topic, rồi lọc lại theo source. Lỗi một source không dừng source khác.
- Inbox dùng chain + token cho EVM, giữ mọi source/pool/stage trong real.discovery và lifecycle (16 quan sát gần nhất/token). Pool đang chờ được ưu tiên so với curve khi cùng token. Snapshot chỉ có một dòng EVM cho một token; lịch sử quyết định vẫn lưu các lần đánh giá. Chống BUY trùng so địa chỉ EVM không phân biệt hoa thường, kể cả chuyển venue. launchedAt/graduatedAt chỉ có khi quan sát event launch/graduation tương ứng; không suy launch time từ một pool bất kỳ.
- Tách lưu discovery EVM khỏi admission phân tích: khi inbox hoặc quota source đầy, vẫn lưu observation và candidate DISCOVERY_DEFERRED, hiển thị lý do DISCOVERY_ANALYSIS_BACKPRESSURE hoặc DISCOVERY_ANALYSIS_SOURCE_CAP. Không gọi features/security/Jev cho các bản ghi này. Cursor tiến sau khi ghi bền vững; không giữ source đứng yên chỉ vì phân tích chậm. Không tạo hàng đợi retry vô hạn: observation mới có thể được xét lại khi có chỗ. Hành vi backpressure Solana giữ nguyên.
- Kiểm tra identity/receipt/code có giới hạn trước inbox; guard chặn quote chưa được tin cậy và market chưa hỗ trợ trước Features/holder/Rug/Jev. Không dùng số dư WBNB/WETH để lọc discovery. Không đổi UNKNOWN thành SAFE.
- Curve chưa có market reader, pool singleton chưa có market reader, giá quote USD thiếu: vẫn phát hiện và hiển thị; phân tích sâu được tạm dừng có lý do. Đây không phải adapter giao dịch cho các nguồn mới.

### Quote và native/wrapped

QuoteAsset có address, symbol, type và trusted; type gồm NATIVE, WRAPPED_NATIVE, STABLECOIN, TOKENIZED_ASSET, ERC20, UNKNOWN. Native zero address giữ đúng nghĩa native, không đổi thành WETH/WBNB. BNB thêm USDT/USDC từ danh sách chính thức PancakeSwap và kiểm tra decimals/symbol RPC; RH có USDG từ tài liệu indexer và kiểm tra RPC (6 decimals). Các quote này không có feed USD được xác minh vẫn không được giả định giá 1 USD. Long/Pons đọc numeraire/pairToken thực; stock chưa có registry/metadata được xác minh giữ UNKNOWN, không bị loại khỏi discovery.

Nguồn token BNB: https://github.com/pancakeswap/token-list/blob/main/src/tokens/pancakeswap-extended.json . Mạng Robinhood đã đối chiếu https://docs.robinhood.com/chain/connecting/ và eth_chainId = 4663.

### ABI, proxy và phiên bản

14 ABI profile có checksum và link commit đã ghim ở packages/chains/abi/evm-discovery-manifest.json. Năm nhóm event đã đối chiếu trực tiếp artifact JSON chính thức/verified explorer: Four.Meme, OpenFour, Pons V2, Bags, Long. Flap lấy interface chính thức; Infinity dùng ICLPoolManager/IBinPoolManager riêng.

- Pons V1 không bị gán nhầm V2: V1 là V3 pool ngay khi launch, V2 có curve rồi V4. Chỉ bật factory V2 hiện đã xác minh; V1 không tự suy là active.
- LongLauncher hiện verified ABI dùng LaunchCreated(address,address,address,address,address,bytes32,uint48,uint48,string), indexed poolOrHook/asset/numeraire. Ví dụ Created trong tài liệu indexer không khớp bản hiện hành và không được dùng.
- OpenFour kiểm tra Registry.openFourCore trước polling; nếu đổi Core sẽ dừng với DISCOVERY_REGISTRY_CHANGED để xác minh ABI/deployment mới. Không tự đổi địa chỉ hợp đồng âm thầm.
- Các proxy còn có thể nâng cấp sau checkpoint; ABI lỗi không trở thành token an toàn hay BUY. Không tuyên bố checksum proxy code chứng minh implementation không đổi.

Lifecycle có giới hạn theo bằng chứng: Four.Meme có LiquidityAdded, OpenFour có PhaseTransition/MigrateExecuted, Pons có PoolGraduated và Doppler có Migrate. Flap/Bags hiện nhận creation và quan sát pool đích qua DEX chung; không gán graduatedAt chỉ vì thấy pool hoặc cấu hình migrator. Các adapter mới không thu thập toàn bộ giao dịch buy/sell trên curve, không có market reader hoặc executor curve/singleton. Khả năng giao dịch trước migration vẫn UNKNOWN cho đến khi có adapter thị trường riêng được kiểm chứng.

### Receipt và lịch sử logs BNB

PublicNode trả HTTP 403 / RPC -32602 cho eth_getTransactionReceipt và eth_getLogs ở cursor cũ: archive request cần personal token. Dataseed BNB chính thức đọc được receipt nhưng eth_getLogs bị tắt theo tài liệu, kể cả khoảng một block; không dùng nó để chữa log backfill. Endpoint https://rpc-bnb.blockmachine.io được liệt kê trong tài liệu BNB và đã kiểm tra chain 56, cùng canonical hash, 25 PairCreated thật trong khoảng 200 block cũ. discoveryArchiveRpcByChain.bnb cấu hình endpoint này cho receipt discovery và fallback logs chỉ khi primary trả HTTP_403 hoặc RPC_CODE_-32602. Secondary phải qua eth_chainId trước khi đọc; receipt/log vẫn đối chiếu canonical bằng primary. Sai chain hoặc lỗi khác vẫn dừng source. RPC market/execution và .env không bị đổi; không bỏ checkpoint cũ hay receipt check. Nguồn endpoint và giới hạn dataseed: https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/json-rpc-endpoint/ .

## Nguồn đã nghiên cứu nhưng chưa bật

| Chain     | Protocol                                                              | Status                            | Bằng chứng / lý do                                                                                                                                                                                                                                                                                                                                       |
| --------- | --------------------------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BNB       | GraFun                                                                | UNVERIFIED current integration    | https://docs.bitquery.io/docs/blockchain/BSC/gra-fun-api/ chỉ rõ controller 0x8341b19a2a602eae0f22633b6da12e1b016e6451 và createPool call. Chưa lấy được ABI/event đầy đủ của implementation hiện tại từ nguồn xác minh; không suy từ audit 2024 hay bài báo cũ. Không bật adapter giả.                                                                  |
| BNB       | PancakeSwap SpringBoard                                               | UNVERIFIED current deployment     | Đã tìm product/official references; chưa xác minh được factory/ABI/version đang sản xuất. Không dùng V2 PairCreated để gán mọi token là SpringBoard.                                                                                                                                                                                                     |
| BNB       | PinkSale                                                              | NOT_SUPPORTED pre-sale discovery  | https://docs.pinksale.finance/ xác nhận token + initial sale; chưa xác minh registry/event hiện hành cho nguồn độc lập. Pool DEX sau listing vẫn thuộc feed factory/manager chung khi có event. Không gọi presale là tradeable curve.                                                                                                                    |
| BNB       | DxSale / GemPad                                                       | UNVERIFIED                        | Có tín hiệu ecosystem nhưng phiên đọc tài liệu chính thức hiện tại không trả dữ liệu triển khai đủ để bật; không tự kết luận active/inactive hay chế tạo địa chỉ.                                                                                                                                                                                        |
| BNB       | TokenMill / Moonshot / Binance TGE                                    | UNVERIFIED BNB launch feed        | Chưa có bằng chứng hợp đồng launch mainnet BNB hiện hành đủ để tích hợp; không dùng tên marketing làm source.                                                                                                                                                                                                                                            |
| Robinhood | trench.today                                                          | UNVERIFIED current ABI            | https://docs.bitquery.io/docs/blockchain/robinhood/trench-today-api/ công bố proxy 0x77dc6f6361b7b99456fc3761ce5b7dda80d83f9d và implementation cũ 0x5d15bdd2a834c66149c38c5ae19c5f4b60cbc397. Explorer hiện trỏ implementation 0x041c5d0a6C56b7e182FCFc94De32A22602ABfF37, chưa có ABI verified trong response. Không đoán indexed fields từ topic0 cũ. |
| Robinhood | hood.fun / LaunchHood / Virtuals / Klik Finance / Ape.store / Clanker | UNVERIFIED native launch adapters | https://docs.bitquery.io/docs/blockchain/robinhood/robinhood-meme-coin-launches/ đưa ra các địa chỉ và mint-transfer query. Chưa có artifact ABI/current deployment/activity đủ cho adapter protocol riêng; shared DEX pools vẫn có thể được phát hiện.                                                                                                  |
| Robinhood | NOXA Fun / o1 / Fables                                                | UNVERIFIED                        | Được nhận diện trong ecosystem search, chưa có bằng chứng triển khai/ABI chính thức đủ để bật. Không thêm protocol chết để tăng danh sách.                                                                                                                                                                                                               |

Không có nhãn INACTIVE chỉ vì cửa sổ quét không có event.

## Cross-launchpad feed

Doppler Airlock và Uniswap V4 Initialize là nguồn dùng chung nhiều frontend. Giữ source riêng, không gán mọi Doppler launch thành Long/Bankr; Long được nhận riêng bằng LaunchCreated từ verified LongLauncher. Chúng bổ sung discovery ở giai đoạn pool/hook nhưng không chứng nhận đầy đủ mọi pre-launch trên chain.

Bitquery có cross-launch mint feed đã kiểm tra tài liệu (URL ở trên), cần access token. Chưa cấu hình client/credential cho feed này; không phụ thuộc hay giả lập Bitquery để làm bot chạy. Mint Transfer đơn lẻ không chứng minh token mới/đang tradeable, có thể là mint thêm hoặc NFT; không chạy full-chain Transfer scan không giới hạn trên public RPC. Native protocol adapters hiện không phụ thuộc external indexer key.

## Giới hạn tải và phạm vi metrics

- Mỗi source tối đa 200 block/poll, 256 creation/lifecycle log/batch. Lookback mặc định 400, lệnh verify tối đa 2.000; không genesis scan. Khi batch vượt giới hạn log/response hoặc provider trả -32005, giảm đôi khoảng block cho lần sau, tối thiểu một block. Nếu riêng một block vẫn vượt giới hạn, giữ cursor và báo lỗi; không bỏ log âm thầm.
- Shared read cache 1.024 entry; pending không bị thay thế; canonical block reads chỉ ghép request đang chạy, không cache kết quả reorg check. Log batch queue tối đa 60 source.
- Dedup 2.048 log identity/source, token metrics tối đa 2.048 địa chỉ/source; latency 256 mẫu gần nhất. Engine lifecycle tối đa maxPools * 20 token, 8 pool và 16 observation/token.
- Inbox phân tích tổng 300; cap từng source 50 gồm cả lần đang ghi, 3 analysis job và quay vòng theo source. EVM quá cap được lưu ở trạng thái tạm hoãn như trên. Tối đa 60 lượt ghi discovery đang chờ; vượt giới hạn ghi giữ cursor để retry. Không gọi Jev cho mọi launch.
- detected là số log được chấp nhận; candidates là số normalized observations, có thể hai chiều khi cả hai currency chưa tin cậy. uniqueTokens là số địa chỉ trong cửa sổ hữu hạn, không phải tổng unique toàn lịch sử.
- RPC nguồn là logical request trước cache/batching; RPC stats theo endpoint là số request thực của client, riêng archive endpoint (receipt và log fallback) được báo riêng. Reconnect theo source tăng khi socket phục hồi.
- P50/P95 tính từ block timestamp tới hoàn tất normalize, gồm lookback/cache/backlog; latest giữ onchainAt, observedAt và normalizedAt riêng. Không công bố là độ trễ live thuần từ phép đo backfill.

## Lệnh xác minh chỉ đọc

```bash
pnpm verify:discovery:bnb
pnpm verify:discovery:robinhood
pnpm verify:discovery:robinhood --source long --blocks 2000
pnpm test
pnpm lint
pnpm typecheck
pnpm build
```

Hai lệnh verify dùng cursor RAM, không ghi DB/journal vận hành; chỉ ghi báo cáo JSON vào data/discovery-{chain}-verification.json. Không import signer/executor; không ký hoặc broadcast. Báo cáo có source, status, latest event/token/block, timestamps/latency và error. Không có event ghi NO_EVENTS_IN_WINDOW, không tạo token mẫu.

## Checkpoint đọc mạng thật

### bnb — 2026-10-27T12:48:48.578Z

| Source                   | Events | Observations | Unique window |  P50 ms |  P95 ms | Error |
| ------------------------ | -----: | -----------: | ------------: | ------: | ------: | ----- |
| pancakeswap-v2           |     42 |           58 |            50 |  124723 |  164679 | —     |
| pancakeswap-v3           |      1 |            1 |             1 |   51264 |   51264 | —     |
| pancakeswap-infinity-cl  |      3 |            3 |             1 |  116653 |  127582 | —     |
| openfour                 |      0 |            0 |             0 | UNKNOWN | UNKNOWN | —     |
| flap                     |     40 |           40 |            40 |  115148 |  151468 | —     |
| uniswap-v2               |      0 |            0 |             0 | UNKNOWN | UNKNOWN | —     |
| uniswap-v3               |      0 |            0 |             0 | UNKNOWN | UNKNOWN | —     |
| uniswap-v4               |     16 |           32 |            17 |   78623 |  177948 | —     |
| pancakeswap-infinity-bin |      0 |            0 |             0 | UNKNOWN | UNKNOWN | —     |
| four-meme                |     19 |           19 |            19 |  144875 |  168092 | —     |

### robinhood — 2026-10-27T12:43:42.836Z

| Source                   | Events | Observations | Unique window |  P50 ms |  P95 ms | Error |
| ------------------------ | -----: | -----------: | ------------: | ------: | ------: | ----- |
| pancakeswap-v2           |      0 |            0 |             0 | UNKNOWN | UNKNOWN | —     |
| pancakeswap-v3           |      0 |            0 |             0 | UNKNOWN | UNKNOWN | —     |
| pancakeswap-infinity-cl  |      0 |            0 |             0 | UNKNOWN | UNKNOWN | —     |
| openfour                 |      0 |            0 |             0 | UNKNOWN | UNKNOWN | —     |
| flap                     |      2 |            2 |             2 |   13787 |   18740 | —     |
| uniswap-v2               |      2 |            2 |             2 |   14454 |   19763 | —     |
| uniswap-v3               |      0 |            0 |             0 | UNKNOWN | UNKNOWN | —     |
| uniswap-v4               |      4 |            5 |             5 |   24502 |   32235 | —     |
| pons-v2                  |      1 |            1 |             1 |   20266 |   20266 | —     |
| bags                     |      0 |            0 |             0 | UNKNOWN | UNKNOWN | —     |
| doppler                  |      1 |            1 |             1 |   23425 |   23425 | —     |
| pools-trade-creator-v33  |      0 |            0 |             0 | UNKNOWN | UNKNOWN | —     |
| pools-trade-standard-v33 |      0 |            0 |             0 | UNKNOWN | UNKNOWN | —     |
| pools-trade-creator-v32  |      0 |            0 |             0 | UNKNOWN | UNKNOWN | —     |
| long                     |      0 |            0 |             0 | UNKNOWN | UNKNOWN | —     |
| pools-trade-standard-v32 |      0 |            0 |             0 | UNKNOWN | UNKNOWN | —     |

Đây là checkpoint hữu hạn: source có code/ABI nhưng chưa có event vẫn PARTIAL verification. Bảng trên giữ checkpoint đầu tiên; các lượt xác minh bổ sung và runtime bên dưới có thể ghi nhận thêm nguồn.

## An toàn / phạm vi

Giữ REAL/PAPER, observation 5 USD. Không thay sizing, RiskEngine, Jev, slippage, native/wrapped execution hoặc import ví. Không reset SQL, không đưa fixture vào runtime. UI trắng sữa và nhật ký nền đen/cuộn có giới hạn được giữ; bổ sung bảng nguồn EVM thu gọn trong Lịch sử quyết định.

## Xác minh bổ sung ngày 2026-10-27

### bnb — 2026-10-27T13:24:40.978Z

10 nguồn; 69 event, 77 observation; 0 lỗi. Không signing/broadcast.

| Nguồn có sự kiện        | Events | Observations | P50 ms | P95 ms |
| ----------------------- | -----: | -----------: | -----: | -----: |
| pancakeswap-v2          |     26 |           31 | 131630 | 177198 |
| pancakeswap-infinity-cl |      3 |            3 | 115080 | 125933 |
| flap                    |     21 |           21 | 129240 | 176154 |
| uniswap-v4              |      5 |            8 | 134890 | 173770 |
| four-meme               |     14 |           14 | 128680 | 173861 |

Main RPC 187 request, 2.93 RPS. Unique per-source không cộng thành unique toàn chain; số observation có thể lớn hơn số event. Latency gồm lookback, không phải tốc độ live thuần.

### robinhood — 2026-10-27T13:22:47.043Z

16 nguồn; 5 event, 5 observation; 0 lỗi. Không signing/broadcast.

| Nguồn có sự kiện        | Events | Observations | P50 ms | P95 ms |
| ----------------------- | -----: | -----------: | -----: | -----: |
| flap                    |      1 |            1 |  27918 |  27918 |
| uniswap-v2              |      1 |            1 |  28598 |  28598 |
| uniswap-v4              |      2 |            2 |  10005 |  43261 |
| pools-trade-creator-v32 |      1 |            1 |  10005 |  10005 |

Main RPC 46 request, 2.93 RPS. Unique per-source không cộng thành unique toàn chain; số observation có thể lớn hơn số event. Latency gồm lookback, không phải tốc độ live thuần.

Long có thêm lượt riêng 2.000 block, không có event trong cửa sổ; adapter vẫn PARTIAL verification. pools.trade creator v3.2 đã có TokenLaunched thật đối chiếu PoolKey/PoolId; Uniswap V4 cũng nhìn thấy pool cùng token. Uniswap V3 Robinhood đã có PoolCreated thật trong runtime sau khởi động.

## Checkpoint runtime sau deploy — 2026-10-27T13:32:26.939Z

- API và Chrome đã xác nhận PAPER, DATA_MODE real, OBSERVATION_ONLY, ngân sách 5 USD; liveEnabled=false và executions=0. Cả 26 EVM watcher SCANNING ở checkpoint này (BNB 10, Robinhood 16).
- Scanner hiển thị đúng 100 ứng viên: BNB 62, Robinhood 24, Solana 14. Đây là cửa sổ mới nhất, không phải tỷ lệ coverage cả chain. Có 33 dòng tạm hoãn admission phân tích; inbox 295/300, active 3/3; vẫn lưu discovery mới.
- Source PancakeSwap V2 BNB phục hồi từ cursor 130085816 lên 130086016 qua archive fallback; không bỏ cursor cũ. Còn backlog khoảng hơn 11.000 block ở checkpoint, P95 khoảng 5.367 giây do lịch sử cũ. Các nguồn khác có P95 hàng chục đến hơn 100 giây trong lúc backfill/RPC chia tải. Chưa chứng nhận đạt tốc độ sniper hoặc SLO live; cần RPC phù hợp và đo steady-state riêng trước khi tuyên bố.
- OpenFour BNB đã có event thật; bảng status nâng SUPPORTED discovery. Các nguồn không có event trong các lượt kiểm tra vẫn PARTIAL verification; không coi là INACTIVE.
- SQLite chỉ đọc đã xác nhận real.discovery theo source. Chi tiết: data/evm-discovery-storage-verification.json. Snapshot metrics và bằng chứng lifecycle: data/evm-discovery-runtime-verification.json. Số đếm SQL là dữ liệu tích lũy, không so trực tiếp với counter watcher từ lúc khởi động.

Bằng chứng ghép nhiều nguồn trên một identity:

| Token Robinhood                            | Nguồn cùng quan sát                                      |
| ------------------------------------------ | -------------------------------------------------------- |
| 0x21a42b853606752a61b8a465b7fae7636a377777 | robinhood:flap → robinhood:uniswap-v2                    |
| 0x52cbba65683739f4d39e2e58e9841e9e40422590 | robinhood:uniswap-v4 → robinhood:pools-trade-creator-v32 |
| 0x3ac313b3582a5b37ec50d495181d751814a07777 | robinhood:flap → robinhood:uniswap-v2                    |
| 0x70bc037a90a340c830fb2e286e18fae5f8467777 | robinhood:flap → robinhood:uniswap-v2                    |
| 0x649290bf67ab4e94247a5396fe5b920f7bf9a26f | robinhood:pons-v2 → robinhood:uniswap-v4                 |

### Kiểm tra hoàn tất

- pnpm test: 270 passed, 4 optional network tests skipped. Có 84 test EVM coverage, hồi quy Pump/Solana, lifecycle, replay/reorg, burst, nguồn lỗi độc lập, bounded admission và archive wrong-chain.
- pnpm build (gồm typecheck), pnpm lint: đạt. pnpm verify:discovery:abis: đủ 14 profile.
- pnpm test:browser trên bản đang chạy: đạt 1920/1440/1366/820/390, bốn menu, bảng 26 nguồn mở/đóng không tràn ngang trang, scanner/log cuộn, RPC/SSE và không lộ secret. Fixture điều khiển chỉ ở trang cô lập, không ghi DB.
- Hai lệnh verify:discovery mặc định 400 block đã chạy thành công. Lượt cuối với --blocks 80 dùng archive config mới: báo cáo JSON tương ứng chứa cả 10/16 nguồn, không signing/broadcast. --source ghi tệp riêng, không đè báo cáo toàn chain.

### Nhóm tệp thay đổi

- packages/chains/src/real/evm-*.ts và packages/chains/abi: decoder/watchers, cache/batching, xác minh ABI và receipt/canonical, source metrics. adapter.ts nối vào vòng quét hiện có.
- packages/config/src/production.ts cùng config/observation.json, real.example.json, real.reference.json: deployment/quote và archive discovery RPC. Không thêm env key bắt buộc.
- packages/core/src/index.ts, packages/engine/src/{real,schemas,discovery-monitor,observation-book}.ts: quote/lifecycle, identity/dedupe, persistence và giới hạn admission.
- apps/web/components/{evm-discovery,dashboard,discovery-funnel,vi}.tsx/ts: bảng nguồn trong lịch sử, nhãn tiếng Việt, giữ funnel Solana đúng bốn nguồn.
- scripts/verify-discovery.ts, verify-discovery-abis.mjs, browser-smoke.mjs; tests/evm-discovery-coverage.test.ts; tài liệu README/bnb/robinhood và báo cáo này. eslint.config.mjs loại mã tham chiếu bên thứ ba khỏi lint.

Không sửa wallet, executor, RiskEngine, Jev, sizing, .env, SQL schema hoặc import/reset dữ liệu cho tác vụ này.
