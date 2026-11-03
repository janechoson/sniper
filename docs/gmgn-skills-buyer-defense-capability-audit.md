# GMGN Skills / CLI — Buyer Defense & Order-Flow Capability Audit

Ngày 2026-11-01, múi giờ Asia/Bangkok. AUDIT ONLY. Không sửa implementation, trading logic hoặc cấu hình. Phạm vi kết luận: skill/CLI đang cài, HTTP route mà client expose và các probe đọc có giới hạn; không tuyên bố đã kiểm tra mọi API nội bộ của website GMGN.

## A. Executive Verdict

**C — GMGN HAS ONLY PARTIAL SUPPORT.**

Có **LEVEL 3 timestamped participant flow thật**, mạnh hơn OHLCV price proxy: Smart Money feed có BUY/SELL, mint, maker wallet, timestamp, USD amount, transaction hash và tags. Probe thực đã nhận cả buy và sell. Tuy nhiên feed là recent chain-wide snapshot bị giới hạn số bản ghi, không có token/from/to/cursor trong CLI/client method; chưa đủ bảo đảm timeline cho token cụ thể hoặc 60 phút trước discovery. Wallet Activity có đường query theo wallet+token và pagination, nhưng phải chọn ví rồi gọi từng ví; probe lần này gặp rate limit trước khi lấy được response.

**Không tìm thấy LEVEL 4 market-wide historical BUY/SELL của một token trong installed skills/CLI.** Không đủ cơ sở chọn A. Không chọn B ở mức bảo đảm one-shot buyer-defense evidence vì temporal coverage còn thiếu; LEVEL 3 vẫn có thể là **STRONG SUPPORTING EVIDENCE khi response thực có đủ các giao dịch phù hợp**, nhưng không phải mọi candidate đều có.

Các kết quả mới quan trọng:

- Xin `track smartmoney --limit 200`, thực nhận 100 events của **37 token / 36 maker**, chỉ phủ **148 giây** giữa timestamp cũ nhất và mới nhất. Một sample không chứng minh hard cap luôn là100, nhưng chứng minh không được mặc định limit200 trả đủ200 hoặc đủ60m.
- `token traders` trả aggregate theo wallet-token và các timestamp cuối; sample `token_transfer.timestamp=0`, hash/address rỗng. Không thể dùng placeholder đó để dựng giao dịch có thật.
- Skill docs có **mâu thuẫn nội bộ về K-line volume/amount/time** và **mâu thuẫn dấu netflow_usd với response sample**. Không sửa unit mapping hoặc dấu flow trong task này.

Evidence: [inventory/search/hash](gmgn-capability-audit-inventory.json), [bounded runtime probes](gmgn-capability-runtime-probes.json).

## B. GMGN Skills Found

- Project dependency `gmgn-cli` **1.6.9**: `package.json`, `node_modules/gmgn-cli/package.json`.
- Repository declared by package: `https://github.com/GMGNAI/gmgn-skills`. Không có checkout/source Git upstream được xác minh trong audit này.
- `.agents/skills`: **19 skills / 28 Markdown files** và 3 Python implementation scripts. Package cũng ship cùng19 skill/28 Markdown. So sánh từng Markdown sau chuẩn hóa CRLF/LF: **nội dung giống nhau**, byte hash khác do line endings.
- `.claude-plugin/plugin.json` có manifest version **1.0.0**; đây không phải CLI version1.6.9, không suy ra independent skill release version.
- Installed CLI có `dist/*.js`, `.d.ts`, source maps, Readme.md/Readme.zh.md; không ship thư mục TypeScript `src` trong package đang kiểm tra. Audit implementation từ compiled JS. Response types của client là `Promise<unknown>`, không có strict response schema đầy đủ.
- Một số skill link `../../docs/workflow-wallet-analysis.md`, `workflow-smart-money-profile.md`; các target đó **không có ở layout .agents/docs hoặc package/docs hiện tại**. Không dùng nội dung workflow chưa đọc làm bằng chứng.

Danh sách toàn bộ skills đã inventory/search: gmgn-callout, gmgn-callout-score, gmgn-contract-dd, gmgn-cooking, gmgn-dev-score, gmgn-heat-rank, gmgn-holder-analysis, gmgn-kline-pattern, gmgn-market, gmgn-narrative, gmgn-portfolio, gmgn-swap, gmgn-token, gmgn-token-buy, gmgn-track, gmgn-wallet-analysis, gmgn-wallet-review, gmgn-wallet-score, gmgn-wallet-style.

Keyword scan bao phủ buyer/buy/sell/trade/trader/activity/swap/flow/netflow/smartmoney/smart_degen/whale/kol/accumulation/distribution/volume/liquidity/history/historical/timestamp/transaction/cluster trong toàn bộ installed skill Markdown, Python, CLI implementation/declarations và Readmes. Sau đó đọc kỹ các section/method liên quan; không thực thi scoring/trading scripts chỉ vì chúng chứa từ khóa.

## C. Useful Commands

Các dòng dưới là capability reference, **không phải lệnh đã implement vào BOT**:

```text
gmgn-cli track smartmoney --chain sol --limit 200 --raw
gmgn-cli track kol --chain sol --limit 200 --raw
gmgn-cli token traders --chain sol --address <mint> --tag smart_degen --order-by buy_volume_cur --limit 20 --raw
gmgn-cli token traders --chain sol --address <mint> --tag smart_degen --order-by sell_volume_cur --limit 20 --raw
gmgn-cli token holders --chain sol --address <mint> --tag smart_degen --limit 20 --raw
gmgn-cli portfolio activity --chain sol --wallet <public-wallet> --token <mint> --limit 50 --type buy sell --raw
gmgn-cli portfolio activity ... --cursor <next> --raw
gmgn-cli token pool --chain sol --address <mint> --raw
gmgn-cli market kline --chain sol --address <mint> --resolution 1m --from <seconds> --to <seconds> --raw
gmgn-cli market signal --chain sol --signal-type 12 --raw
```

`track follow-wallet` là feed các ví tài khoản GMGN đang follow, không thể thay cho danh sách Smart Money công khai. Nó dùng signed API authentication; không gọi trong audit. `portfolio activity` dùng API key, không cần ký giao dịch.

## D. Endpoint Trace

Base host xác nhận trong `node_modules/gmgn-cli/dist/config.js`: `https://openapi.gmgn.ai`.

| Skill → CLI | Command implementation | OpenApiClient method → HTTP | Phạm vi dữ liệu |
|---|---|---|---|
| gmgn-track → track smartmoney | `dist/commands/track.js:115` | `getSmartMoney` → GET `/v1/user/smartmoney` | Smart Money subset nhiều token |
| gmgn-track → track kol | `track.js:96` | `getKol` → GET `/v1/user/kol` | KOL subset nhiều token |
| gmgn-track → track follow-wallet | `track.js:59` | `getFollowWallet` → signed GET `/v1/trade/follow_wallet` | User-followed subset |
| gmgn-token → token traders | `dist/commands/token.js:79` | `getTokenTopTraders` → GET `/v1/market/token_top_traders` | Top trader subset của token, tag-filterable |
| gmgn-token → token holders | `token.js:51` | `getTokenTopHolders` → GET `/v1/market/token_top_holders` | Top current holder subset |
| gmgn-portfolio → portfolio activity | `dist/commands/portfolio.js:54` | `getWalletActivity` → GET `/v1/user/wallet_activity` | Một ví, optional token filter, paginated ledger |
| gmgn-market → market kline | `dist/commands/market.js:29` | `getTokenKline` → GET `/v1/market/token_kline` | Historical aggregate price/total volume |
| gmgn-token → token info | `token.js:8` | `getTokenInfo` → GET `/v1/token/info` | Current token snapshot/rolling windows |
| gmgn-token → token pool | `token.js:36` | `getTokenPoolInfo` → GET `/v1/token/pool_info` | Current pool state |
| gmgn-market → market signal | `market.js:152` | `getTokenSignalV2` → POST `/v1/market/token_signal` | Recent triggered signals, không phải raw trade ledger |
| gmgn-track → follow-tokens | `track.js:8` | `getFollowTokens` → GET `/v1/user/follow_tokens` | Bookmark/current token metadata, không phải BUY timeline |
| gmgn-callout → callout records/feed | `dist/commands/callout.js` | `/v1/callout/get_record`, `/v1/callout/global` | Public declarations, không phải swap execution |

Client `getSmartMoney`/`getKol` chỉ tạo query chain/limit. `getWalletActivity` nhận extra token_address/limit/cursor/type từ CLI. `getTokenTopTraders`/Holders nhận extra limit/order_by/direction/tag. Những method nhận extra generic không chứng minh server hỗ trợ một tham số chưa có trong docs/CLI.

`OpenApiClient.parseResponse` kiểm `code===0`, trả `json.data`; CLI printResult sanitize metadata rồi xuất JSON. Không có mapping bí mật từ OHLCV sang directional flow trong CLI.

## E. market kline Raw Capability

Các field được installed reference mô tả: `list[].time/open/high/low/close/volume/amount/source`. Source command chỉ pass raw result; không lọc bỏ buy_volume/sell_volume/buy_count/sell_count/liquidity nếu upstream có thêm field. Tuy nhiên **không có field directional đó trong schema reference đang cài hoặc sample raw đã ghi trước đây**. `.d.ts` trả unknown nên cũng không đảm bảo một schema đóng. Kết luận đúng: **chưa tìm thấy directional field chưa map mà bot có thể tin cậy sử dụng**; không khẳng định server vĩnh viễn không thể bổ sung field.

Tham số: chain/address/resolution/from/to. CLI from/to là Unix seconds, source nhân1000 trước HTTP. Resolutions:1s,30s,1m,5m,15m,1h,4h,1d. `1s` được docs và command help ghi **Pro only**, tối đa500 nến/request theo skill;1s cũng chỉ tăng độ phân giải giá, không tự thêm side.

**Documentation conflict — chưa tự chọn interpretation mới:**

| Nguồn | Unit được mô tả |
|---|---|
| gmgn-market SKILL.md:26 | volume=USD; amount=token units |
| Cùng file:107–119 | time=seconds; volume=token units; amount=USD; khuyên sum amount |
| Cùng file, output summary:969 | sum volume thành USD |
| gmgn-kline-pattern SKILL.md:97–113 | biết có source; bỏ amount ở một hướng dẫn nhưng ngay sau đó nói amount=USD, volume=token units; time=seconds |
| CLI implementation | Không đổi volume/amount, không khai báo unit; chỉ chuyển query from/to seconds→ms |
| Raw sample lưu từ audit trước | time=1793504520000 (milliseconds), volume=1487.10524076, amount=4923681.514648001, price khoảng0.0003 |

Sample trước có `volume/amount≈0.000302`, nằm trong khoảng low/high của nến. Đây là **corroborating dimensional inference** cho volumeUSD/amountToken trên sample đó, không phải contract chính thức giải quyết mâu thuẫn mọi chain/endpoint. Audit này dừng probes sau rate limit nên **không có K-line response mới**; không dùng comment BOT làm bằng chứng độc lập. Mapping hiện tại của BOT giữ nguyên.

## F. token traders / holders

`--address <mint> --tag smart_degen --order-by buy_volume_cur|sell_volume_cur --direction ... --limit ...` là query production có thật. Docs: default20, max100; source không có cursor/from/to hoặc period cho hai command này. Không tự assume đã enumerate mọi smart wallet.

Mỗi row là **wallet-token aggregate**, không phải từng trade:

- `buy_volume_cur`, `sell_volume_cur`, `buy_amount_cur`, `sell_amount_cur`, `buy_tx_count_cur`, `sell_tx_count_cur`;
- `history_bought_cost`, `history_sold_income`, balances/cost/profit;
- `start_holding_at`, `end_holding_at`, `last_active_timestamp`;
- `token_transfer`, `token_transfer_in/out`, `native_transfer`, wallet/tag fields.

**Scope `_cur` chưa đủ rõ để gọi là recent period.** gmgn-token chỉ nói “total” không định nghĩa window/reset; gmgn-holder-analysis nói counts/sells since token creation. CLI chỉ pass raw, không có server aggregation implementation. Sample một wallet có `_cur` buy/sell bằng history_bought_cost/history_sold_income, hỗ trợ aggregate interpretation nhưng không chứng minh reset lifetime/current holding cycle trên mọi record. Kết luận: **wallet-token aggregate; exact reset/window UNKNOWN**. Không được gán vào 1m buckets hay gọi là accumulation đang tăng tại NOW.

Probe thật:

```text
buy_volume_cur = 348.2802516533
sell_volume_cur = 869.03708661018
buy_tx_count_cur = 2; sell_tx_count_cur = 4
history_bought_cost = 348.2802516533
history_sold_income = 869.03708661018
token_transfer = {name:null,address:"",timestamp:0,tx_hash:"",type:"buy"}
netflow_usd = -520.7568349568801
```

`last_active_timestamp` chỉ một mốc cuối, không phải timestamps của2 BUY/4 SELL. `token_transfer` có thể là placeholder; không có USD amount của từng trade trong object reference đó. Transfer-in/out là chuyển token, không tự động là BUY/SELL.

**Netflow sign conflict:** gmgn-token mô tả netflow_usd=sell income−buy cost, nhưng sample bằng **buy−sell**. Không lấy dấu field này làm accumulation signal khi chưa xác minh semantic; nếu cần tính metric từ trades phải định nghĩa chiều dấu riêng rõ ràng.

Có thể tính trên **các row được trả về**: aggregate smartBuyUsd=sum buy_volume_cur, smartSellUsd=sum sell_volume_cur, smartNetFlow=buy−sell theo quy ước đã nêu, số wallet có buy/sell count>0. Nhưng đây là aggregate với scope chưa rõ, top-N selection bias, không có per-bucket counts; missing/unindexed count không được coi là0 thật. `tag=smart_degen` chỉ chọn GMGN-tagged subset.

`gmgn-holder-analysis/analyze.py:462–492` gọi “Accumulating/Distributing” từ sell_amount_percentage/buy counts hiện có; không fetch chronological trades ở nhánh này. Đây là **computed label từ aggregate**, không phải provider xác nhận dòng mua tăng theo thời gian.

## G. gmgn-track Smart Money

**Phân loại: B — recent timestamped trades**, không phải current holdings snapshot; chưa chứng minh C — historical queryable feed có arbitrary range.

| Query feature | smartmoney/kol đang cài |
|---|---|
| chain | Có, server-side |
| token/mint filter | Không có trong command hoặc method request |
| side buy/sell | Có CLI option nhưng **client-side** sau fetch; không mở rộng returned coverage |
| from/to/since/until | Không có |
| limit | Có; docs1–200/default100; source pass-through, probe200→100 |
| pagination/cursor | Không có command option hoặc client query; observed envelope chỉ list |
| maximum lookback/retention | UNKNOWN; không có time-range contract |
| timestamps | Có Unix seconds trong reference và runtime sample |
| latency | Một sample smartmoney986ms; không phải p95/SLA |
| provider indexing delay | Không có SLA/publish timestamp để chứng minh; trade timestamp khác received time |

Runtime response fields thực có: `transaction_hash`, `maker`, `base_address`, `side`, `timestamp`, `amount_usd`, `token_amount`, `base_amount`, `quote_amount`, `buy_cost_usd`, `price`, `price_usd`, `is_open_or_close`, `balance`, `base_token`, `maker_info`. Có `maker_info.tags` chứa smart_degen. `buy_cost_usd` là original cost basis, **không thay amount_usd của SELL hiện tại**. `price_change` có trong interpretation/docs khác, nhưng **không có trong row keys của probe smartmoney này**; không assume luôn trả.

`side` là evidence BUY/SELL; không dùng `is_open_or_close` thay side. Tài liệu giải thích field này khác giữa follow-wallet và smartmoney/kol; không dùng nó để tự khẳng định full open/close nếu chưa đủ contract.

**Cluster:** skill có câu “multiple wallets same direction in short window” và rubric diễn giải. Không có cluster field trong sample, không có getCluster API trong client. Muốn cluster phải **tự group base_address+side+timestamp, dedup transaction, distinct maker**. Không hard-code threshold từ rubric trong audit. Hai địa chỉ khác nhau **không chứng minh hai chủ thể độc lập**; native funding/tags có thể hỗ trợ loại liên hệ, nhưng không chứng minh độc lập tuyệt đối.

Existing BOT (`src/gmgn.ts:957`, `src/engine.ts:808`) hiện gọi smartmoney limit50/cache30s, local filter `base_address===mint && side==='sell' && timestamp*1000>=entryAt`. Output chỉ signature/at/side/amountUsd, bỏ maker/tags/BUY. Đây là **Position SELL subset**, không phải Candidate historical orderflow. Source API có BUY để dùng trong thiết kế tương lai, không cần đặt tên fake endpoint mới; hiện chưa tích hợp vào Fresh Attempt.

## H. Wallet Activity

`gmgn-portfolio` → `portfolio activity` → `getWalletActivity` → GET `/v1/user/wallet_activity`:

```text
chain, wallet_address [required]
token_address [optional, --token]
type [buy/sell/transferIn/transferOut/add/remove]
limit, cursor
```

Reference envelope: `activities` + `next`, không phải list. Trade fields: `event_type` (một số chain type), `token.address`, `timestamp`, `cost_usd`, `token_amount`, `price_usd`, `tx_hash`. Wallet identity là query wallet; không đòi maker field trên mỗi row. Dùng cost_usd cho value của transaction, không buy_cost_usd của SELL làm giá trị SELL. Exclude transfers; `add/remove` có thể cần phân loại riêng, không tự tính là trades.

Có thể query một token cho **một public wallet** rồi paginate ngược theo next. Không có CLI from/to; muốn range phải đi các page đến thời điểm cần, sort/dedup/validate locally. Source không xác nhận max retention hoặc completeness; skill khác ghi limit>50 có thể fallback20, nên không assume arbitrary large page. Không kiểm tra claim đó bằng probe mới lần này.

Khả năng reconstruct subset: lấy relevant wallets từ token traders/holders/feed, fetch mỗi wallet+token, merge timestamps. **YES về capability, PARTIAL về coverage và performance.** TopN/current holders bỏ sót sellers đã thoát và người không thuộc topN; một ví có thể có nhiều page. Không trở thành market-wide ledger chỉ vì ghép nhiều wallet.

Probe Wallet Activity gặp rate-limit-class error sau833ms, **không có successful response mới để xác nhận populated fields/cursor của token đó**. Dừng toàn bộ calls, không retry. Không lưu raw stderr/reset header trong evidence runner nên không có exact retry time; không đoán thời điểm hết cooldown.

## I. Market-Wide Directional Data

Không tìm thấy trong full installed client/command surface một route query `token X + historical all trades BUY/SELL + timestamp + range/cursor`.

- Token info/trending/trenches có window buy/sell/net_buy, là rolling totals tại NOW, không phải time buckets.
- Token traders/holders là subset wallet aggregates.
- Smartmoney/KOL/follow-wallet là participant subsets.
- Wallet Activity là single-wallet ledger.
- Swap/order routes là tạo/tra cứu giao dịch của account, không phải public historical market feed. Không gọi write routes.
- Callout declarations không phải executions.
- `market signal` trả trigger events, không phải toàn bộ swaps. Có signal_type12 smart-degen buy,20 KOL buy,10 bundler sell. Types14/15/16 (large/multi buys) **bị CLI reject** ở flags thường và docs nói API không hỗ trợ; raw groups pass-through không có nghĩa chúng được server hỗ trợ. `data` raw snapshot chưa có guaranteed full trade schema. Creation/open timestamp filters không phải trade-time from/to.

**LEVEL4: chưa được tìm thấy/chứng minh trong installation này**, không phủ định các API GMGN chưa expose ở đây.

## J. Smart Money Directional Data

**LEVEL3 có thật.** Có thể tính trong **returned/deduplicated sample** theo bucket: smartBuyUsd/smartSellUsd từ amount_usd, smartBuyCount/smartSellCount là trade counts, smartBuyerCount/smartSellerCount là distinct maker theo side, smartNetFlow=buyUsd−sellUsd.

Những con số đó phải ghi scope Smart Money subset + coverage của response; không gọi là market volume. Không có token trong returned100 không có nghĩa token không có smart buyers. Feed bị cắt có thể làm một phía biến mất và tạo “net flow improving” giả. Nếu dùng BUY-only và SELL-only queries, cả hai vẫn lọc local trên các snapshot khác thời điểm, không đảm bảo cùng universe.

SMART_MONEY_BUYER_DEFENSE là **STRONG SUPPORTING EVIDENCE có điều kiện** khi timeline subset thật có đủ sells trước/buys sau, multiple distinct wallets, đủ time alignment với giá và coverage. Các dữ liệu hiện có không đảm bảo điều kiện đó cho mọi Fresh Attempt; chưa xác minh ví độc lập về chủ sở hữu hoặc toàn bộ sell intensity thị trường.

## K. Liquidity History

Không tìm thấy historical liquidity/pool-history endpoint trong CLI/client. `token pool` có liquidity/base_reserve/quote_reserve/price/creation_timestamp **hiện tại**. Token info và các feed có liquidity_now, initial_liquidity hoặc launch context không phải liquidity timeline.

Wallet Activity nhận type add/remove có thể hỗ trợ **LP events của wallet được query**, nhưng không có successful sample lần này, không có completeness guarantee và không đủ để suy ra liquidity USD của toàn pool mỗi phút. Không gọi điều đó là historical liquidity sẵn có.

## L. Capability Matrix

✓=supported; △=partial/subset/aggregate/conditional; —=not established. Historical không đồng nghĩa đầy đủ60m.

| GMGN capability | Price timeline | Buy/Sell side | Timestamp | USD amount | Wallet | Smart tag | Market-wide | Historical | One-shot usable |
|---|---|---|---|---|---|---|---|---|---|
| market kline | ✓ | — | candle time✓ | △ unit conflict | — | — | △ aggregate pool/coverage | ✓price | ✓price proxy |
| token info | — | △rolling totals | △fetch/window | ✓window docs | △counts only | △smart count | △provider aggregate | —sequence | ✓current flow |
| token traders | — | △aggregate | △first/last/placeholder | ✓aggregate docs | ✓ | ✓filter/tags | —top traders | △summaries | △wallet selection |
| token holders | — | △aggregate | △first/last | ✓aggregate docs | ✓ | ✓filter/tags | —top holders | △summaries | △selection/context |
| track smartmoney | △trade price subset | ✓ | ✓per trade | ✓amount_usd | ✓maker | ✓ | — | △recent capped feed | △conditional |
| smartmoney API direct | Same underlying route | ✓ | ✓ | ✓ | ✓ | ✓ | — | △no range/cursor exposed | △same limits |
| track kol | △trade price subset | ✓docs | ✓docs | ✓docs | ✓ | KOL | — | △recent feed | △supporting |
| track follow-wallet | △trade price subset | ✓docs | ✓docs | ✓docs | ✓ | △tags | —user-followed | △recent no cursor option | △signed/user-specific |
| portfolio activity | △trade price of wallet | ✓docs | ✓docs | ✓cost_usd docs | ✓query | △needs cohort metadata | — | ✓paginated wallet ledger | △N×pages |
| token pool | —current price | — | △creation only | △liquidity_now | — | — | △one pool | — | ✓current liquidity |
| market signal | △trigger prices/MC | △event class | ✓trigger_at | —trade USD not guaranteed | —not guaranteed | △signal category | —selected signals | △recent capped | △corroboration |
| portfolio holdings/stats | — | △aggregate history | △position times | ✓aggregate | ✓ | △identity tags | —single wallet | △totals | △context only |
| callout | △call price | —declaration | ✓call time | —trade value | ✓caller | △ | — | △call records | —for orderflow |

## M. Buyer Defense Matrix

| Evidence | Available? | Source | Level | Limitation |
|---|---|---|---|---|
| Historical price | YES | market kline |1 | Candle granularity/gaps, no intrabar order |
| Historical total volume | YES, unit conflict documented | kline volume/amount |1 | Side split absent; schema docs conflict |
| Historical market BUY USD | NOT FOUND | none in installed interface |4 absent | Current windows do not form history |
| Historical market SELL USD | NOT FOUND | none |4 absent | Same |
| Historical market BUY count | NOT FOUND | none |4 absent | Same |
| Historical market SELL count | NOT FOUND | none |4 absent | Same |
| Timestamped Smart Money BUY | YES | smartmoney sample + wallet activity reference |3 | Chain feed capped; token/range coverage unknown |
| Timestamped Smart Money SELL | YES | smartmoney sample |3 | Same; BOT currently only uses some Position SELLs |
| Smart buyer cluster | DERIVABLE, not provider field | group timestamped rows by mint/side/time and distinct maker |3 | Distinct wallets≠independent owners; missing rows bias counts |
| Smart seller cluster | DERIVABLE | same |3 | Same |
| Historical liquidity | NOT FOUND as pool timeline | pool snapshot; optional wallet LP events only |0 for historical proof | No per-minute reserve/USD state |
| Current market net flow | YES when directional fields known | token info buy_volume_*−sell_volume_* |2 | Selected rolling window; not capital deposits or timeline |

Ideal bucket fields: timestamp+price available via candles; marketBuyUsd/marketSellUsd/marketBuyCount/marketSellCount historical **not found**; smartBuyUsd/smartSellUsd/smartBuyerCount/smartSellerCount **derivable for covered subset only**; historical liquidity **not found**; transactionCount **partial** (count returned subset events or current swaps totals, not historical market-wide bucket count).

## N. One-Shot Suitability / Plan / Performance

Plan table below is **installed documentation**, not a current subscription audit or fresh pricing lookup. No conclusion about user's exact tier. Standard endpoints are listed under Free/Plus/Pro rate buckets; entitlement beyond the described table is UNKNOWN unless probe succeeds. 1s Pro-only is explicit. No package upgrade or plan purchase recommended by this audit.

| Capability | Auth / documented plan | Calls and bounds | One-shot implication |
|---|---|---|---|
| smartmoney / KOL | API key; standard buckets, weight1 |1 feed call; docs limit≤200, runtime smart returned100 | Fast bounded sample; cannot guarantee candidate appears or time coverage |
| traders / holders | API key; standard buckets, weight5 |1 each/topN≤100 docs; sample traders958ms | Can seed wallets; two sorting calls do not enumerate full cohort |
| wallet activity | API key; standard buckets, weight3 |N wallets×P pages; token filter; limit50 reference | Fullness/latency unbounded without caps. Probe rate-limited, no successful latency benchmark |
| follow-wallet | API key+signed auth; weight10 |1 bounded feed; no pagination option despite next_page_token reference | User-specific; capacity/plan may restrict. Not a public token history substitute |
| standard K-line / pool | API key; standard weights2/1 |1 each when available | Price/current liquidity context; no directional upgrade |
| 1s K-line | **Pro only**; docs≤500 bars/call | More calls for long lookback | Does not supply market-side evidence by itself |
| signal | API key; standard weight1 |1 grouped request; docs max50/group | Recent hints only, no full event ledger |

Probe audit: config --check PASS (local configuration check only); Smart Money986ms success; traders958ms success; Activity833ms **failed** with rate-limit-class error. Requests sequential with ~2.2s spacing, automatic retry wait disabled; **all probes stopped after error**. No p95, no guaranteed publication delay, no full one-shot budget benchmark. Rate-limit budget is shared with other consumers of the key; do not treat successful single calls as proof that N-wallet fanout is production-safe.

Same mint on next Trending appearance can fetch these sources again using a new attempt. This does not require old JEV/Structure verdict. A continuously recorded feed could improve future history, but cannot backfill a first-discovery token's missing past; **watching5–10m to build evidence is NOT SUITABLE FOR the requested one-shot architecture**. No Watch design proposed here.

## O. Recommended Architecture — KHÔNG IMPLEMENT

Vì verdict C, chưa thay Structure và chưa thêm provider. Research tiếp theo trong GMGN:

1. Xác minh server contract của Wallet Activity: token filter/type, actual populated fields, cursor retention/limits, behavior khi mất dữ liệu; benchmark bounded cohort+pages bằng budget riêng khi provider cho phép. Không retry trong audit này.
2. Xác minh có public token-specific full-market trade endpoint ngoài installed CLI không; cần endpoint/schema/range/pagination/entitlement chính thức trước khi nói LEVEL4. Không đoán hidden URL hoặc scrape website.
3. Xác minh unit K-line, `_cur` reset semantics và sign netflow bằng provider contract + đối chiếu ledger; giữ conflict hiển thị rõ thay vì chọn theo tên field.
4. Nếu Level3 coverage đủ cho một attempt, thiết kế evidence độc lập: **PRICE_RECOVERY** từ candles, **MARKET_FLOW_SUPPORT** từ current windows, **SMART_MONEY_SUPPORT/DEFENSE** từ timestamped subset, kèm source/coverage/timestamps/missing/participant limits. Chỉ gọi defense khi actual subset sequence được chứng minh; không merge thành MARKET_WIDE_BUYER_DEFENSE=true.

Không hard-code percentage, không chọn threshold, không thêm state tái sử dụng verdict, không triển khai pipeline mới trong task này.

## P. Files Inspected

Full path inventory, keyword-hit counts và baseline hashes trong `gmgn-capability-audit-inventory.json`. Core references:

- `.agents/skills/gmgn-track/SKILL.md`: command/query/response/cluster/rate semantics.
- `.agents/skills/gmgn-token/SKILL.md`: trader/holder summaries/timing/netflow/pool.
- `.agents/skills/gmgn-portfolio/SKILL.md`: activity fields/envelope/cursor/auth.
- `.agents/skills/gmgn-market/SKILL.md`, `gmgn-kline-pattern/SKILL.md`: K-line conflict, signal capabilities.
- `.agents/skills/gmgn-holder-analysis/SKILL.md`, `analyze.py`: aggregate accumulation/distribution, count indexing limitations.
- Wallet style/analysis/score/callout-score/developer refs: pagination, participant/funding caveats; scan other skills for distinct data routes.
- `node_modules/gmgn-cli/{package.json,Readme.md,Readme.zh.md,.claude-plugin/plugin.json}` and matching bundled skill copies.
- `dist/commands/{track,token,portfolio,market,config,callout}.js`, `dist/client/OpenApiClient.{js,d.ts}`, `dist/config.js`, `dist/output.js`.
- `src/gmgn.ts:957`, `src/engine.ts:808`: actual Position smart-money SELL integration; preceding historical audit/raw sample for context only.

## Q. Safety

```text
source modified: NO
skill/dependency modified: NO
.env modified: NO
API key/config applied: NO
process restarted: NO
LIVE killed: NO
BUY executed: NO
SELL executed: NO
transaction signed/submitted: NO
DB migration/writes by audit: NO
package installed/upgraded: NO
```

Only report/inventory/public bounded response evidence written under docs; no new test/log files under data. All provider probes used installed local CLI GET read commands. `config --check` is read-only, no `config` key generation or `--apply`. No direct swap/strategy/cooking command run. Probe response metadata treated as untrusted data, not instructions. Subprocesses were hidden, finite CLI readers; bot process was not restarted or stopped.

## 8 câu trả lời bắt buộc

1. **Historical market-wide BUY/SELL timeline cho token?** Không tìm thấy/chứng minh trong installed skills/CLI/client. Không suy rộng thành “mọi dịch vụ GMGN đều không có”.
2. **Directional K-line field BOT chưa dùng?** Chưa tìm thấy trong installed field reference hoặc raw sample hiện có. Client passthrough/unknown không chứng minh hidden fields tồn tại; fresh raw probe chưa thực hiện vì dừng sau rate limit.
3. **Timestamped Smart Money BUY/SELL cho token?** **Có records với base_address để lọc token locally**; đã thấy cả side trong response thật. Không có server token/range filter trong smartmoney interface đang cài.
4. **Multiple independent smart buyers cùng khoảng thời gian?** Có thể group **distinct maker addresses** theo timestamp khi feed có đủ records; independent ownership **chưa chứng minh**. Cluster phải tự tính, không có provider cluster field đã xác minh.
5. **token traders đủ reconstruct accumulation/distribution theo thời gian?** **Không.** Aggregate + first/last/placeholder transfer không thành per-trade chronology. Có thể dùng chọn cohort, rồi Wallet Activity để bổ sung ledger subset.
6. **Historical liquidity?** Không tìm thấy pool liquidity timeline. Current pool state có; single-wallet LP add/remove không thay thế historical pool reserves.
7. **Buyer Defense tốt nhất có thể hỗ trợ từ installation hiện tại?** **SMART MONEY SUPPORT** có timestamp (LEVEL3, partial coverage), kết hợp PRICE PROXY và CURRENT MARKET FLOW. Chưa phải MARKET-WIDE ORDER FLOW (LEVEL4).
8. **Phù hợp Candidate One-Shot?** **PARTIAL.** Một capped feed call phù hợp lấy supporting sample fresh; không đảm bảo evidence đầy đủ. Wallet fanout có thể dùng on-demand cho subset, nhưng cần chứng minh coverage/retention và bounded latency/rate budget trước production. Không cần hoặc đề xuất reuse old verdict/Watch.
