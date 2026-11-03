# Điều tra BUY/SELL route khi LIVE — 29/10/2026

**Phạm vi:** quan sát LIVE từ khoảng 07:23 Asia/Bangkok, đọc DB/log/receipt, GET báo giá Jupiter và simulation **không ký**. Không sửa code route, sizing, slippage, transaction validator hoặc cấu hình để làm giao dịch chạy qua. Các script điều tra chỉ nằm trong `data/`; không được import vào ứng dụng.

## Kết luận

Không thể gộp mọi token không mua được thành “lỗi route”. Trong snapshot 24 giờ lúc **07:27:48**, nhóm chính là **SOL debit vượt phí báo trước**; nhóm tiếp theo là **slippage trong simulation**. Chỉ có hai incident NO_BUY_ROUTE, cùng một mint. Những số này là **lần lỗi**, không phải số giao dịch đã gửi và không phải số token độc lập cộng được giữa các nhóm.

| Nhóm trong 24 giờ tại checkpoint trên | Lần | Mint khác nhau | Ý nghĩa |
| --- | ---: | ---: | --- |
| TOKEN_SAFETY_FAILED / SIMULATED_BALANCE_MISMATCH | 71 | 40 | Quote/transaction đã có; kiểm tra số dư mô phỏng chặn trước ký |
| TOKEN_SIMULATION_FAILED | 25 | 23 | Tất cả mẫu ghi `InstructionError[6].Custom=6001` |
| NO_BUY_ROUTE | 2 | 1 | Một mint D, lỗi lịch sử; không chứng minh token vĩnh viễn không có route |
| TOKEN_DECIMALS_MISMATCH | 1 | 1 | Decimals không khớp, độc lập với route |
| UNSUPPORTED_TOKEN_EXTENSION | 1 | 1 | Chính sách Token-2022, độc lập với route |

Trong run LIVE mới có thêm một unsigned BUY mismatch sau checkpoint ban đầu; tổng mismatch ở snapshot **07:29:27** thành **72**. Thống kê là ảnh chụp theo thời gian, bot tiếp tục chạy nên có thể thay đổi.

## 1. Nguyên nhân phổ biến: rent thực tế khác quote fee bound

Điều kiện hiện tại tại `src/execution-provider.ts`, `simulate()`:

```text
BUY:
token nhận mô phỏng ≥ minimumOutput
SOL delta phải âm
SOL debit ≤ principal + signature fee + priority fee + quoted rent
```

Cả **71** mismatch ban đầu đều:

- Token nhận **không thấp hơn** minimum output.
- SOL delta **âm** như BUY bình thường.
- Nhưng debit **vượt** bound principal + quoted fees.

| Vượt bound (lamports) | Số lần ban đầu |
| ---: | ---: |
| 71.120 | 2 |
| 121.920 | 17 |
| 1.559.560 | 5 |
| 1.564.640 | 3 |
| 1.635.760 | 44 |

Đây không phải “Jupiter không tìm được đường mua”: đã có transaction và simulation để kiểm tra delta. Không thể kết luận mọi chênh lệch đều an toàn để bỏ qua chỉ từ thống kê này.

### Tái hiện HERMIT bằng unsigned simulation

Mint: `2JQPPePSXwpJKGVo6a3o2TMhCrgtzVXZXfEZ7NjFynbS`. Thời điểm khoảng **07:26:49**.

| Mục | Lamports |
| --- | ---: |
| Principal, đúng BUY amount đang cấu hình | 1.904.915 |
| Quote signature fee | 5.000 |
| Quote priority fee | 487 |
| Quote rent | 2.976.880 |
| Tổng debit được validator cho phép | **4.887.282** |
| Debit ví trong simulation thành công | **6.451.922** |
| Vượt bound | **1.564.640** |

Đã lấy pre/post các writable accounts bằng RPC simulation. Có **ba tài khoản Token-2022 mới, mỗi tài khoản 170 bytes, mỗi tài khoản giữ 1.513.840 lamports rent**. Tổng rent mới **4.541.520**, chênh đúng **1.564.640** so với quote rent **2.976.880**. Phần SOL debit được giải thích đầy đủ bằng principal + network/priority + ba khoản rent này.

Đây là bằng chứng cụ thể cho một layout bị chặn vì quote rent không phản ánh đủ tài khoản/kích thước tài khoản thực tạo. Chưa xác minh quyền kiểm soát và tính an toàn của mọi rent recipient ở tất cả layout; không nới validator. Không suy rộng rằng cả 72 trường hợp đều cùng chính xác ba tài khoản 170 bytes.

Evidence: `data/route-unsigned-simulation-1793233612516.json`. Script không ký, không gọi execute, không lưu intent hay ghi DB.

## 2. Slippage: có route nhưng giao dịch không đạt output

25 simulation incidents ban đầu ghi cùng mã **6001** ở Jupiter Swap program. Tài liệu chính thức định nghĩa 6001 là **SlippageToleranceExceeded**. [Jupiter — Swap program errors](https://developers.jup.ag/docs/swap/v1/common-errors#jupiter-swap-program-errors).

Trong run mới, bot tự BUY mint `78nSGpWPkmvX7G8Q2yneUzNFTgsJYR4YTNox67C115k4` từ điều kiện scanner/Jev/Risk thật; simulation/preflight đã qua nhưng khi landed thì on-chain trả cùng lỗi 6001. Đây là khác biệt giữa trạng thái lúc mô phỏng và lúc transaction thực thi. Không phải thiếu route.

- Signature: [3cuzZ4D…4bWFTNP](https://solscan.io/tx/3cuzZ4Dk2o7tkNeCpF22vbbZRq9GmxEFaCqZN91GWPEQkxaR3nQT9yQDyXUiYWPedTRfpNsBz8YdDyvmt4bWFTNP).
- Đã đọc độc lập: **finalized, failed**, slot **462678791**.
- Network fee **5.438 lamports = 0,000005438 SOL**.
- Token delta **0**, token balance **0**, không mở holding thành công cho giao dịch này.
- Principal không bị chi; ví chỉ giảm network fee của transaction failed.

Không tăng slippage hoặc gửi lại signature. Không coi transaction này là BUY thành công.

## 3. NO_BUY_ROUTE lịch sử của D không phải trạng thái vĩnh viễn

Mint: `7Q7THzb2YNRojp894GZKdf3HAjM8e2dT2qcovrxFpump`.

Hai incident cũ mang NO_BUY_ROUTE, nhưng lúc **07:25:56** báo giá cùng mức BUY hiện tại **1.904.915 lamports** đã trả HTTP 200, Metis, route **Pump.fun AMM**. Unsigned simulation tiếp theo cũng thành công và SOL debit nằm trong bound.

Không có raw HTTP response body được giữ từ hai lần cũ để xác định chắc là lack liquidity, market vừa migrate, lỗi build 400 hay nguyên nhân token cụ thể khác. Code hiện gộp HTTP 400/404/422 tại GET order thành NO_BUY_ROUTE/NO_SELL_ROUTE; vì vậy chỉ nhìn nhãn lịch sử không đủ xác định root cause chi tiết. Điều này được ghi nhận để điều tra, **chưa sửa logging hoặc classifier**.

Evidence: `data/route-quotes-1793233578196.json`, `data/route-unsigned-simulation-1793233612516.json`.

## 4. LARP và Memelord hiện là lỗi SELL route

Đã thử đúng lượng token đang hold, slippage hiện có, cả có taker và **quote-only không taker**:

| Token/mint | Atomic amount | Metis được bot cho phép | Bỏ hạn chế router, quote-only |
| --- | ---: | --- | --- |
| LARP / `8oxrc5tfgYY6yS4hRQfAkTp7QxbyLTezKqzak4qepump` | 2.367.401.294 | HTTP 400: **Insufficient liquidity** | OKX, outAmount **823 lamports** |
| Memelord / `Ge88LedK6Yk337UuPJaG1sgVUrR8q2Ykqcb7u5sVpump` | 2.267.435.022 | HTTP 400: **Insufficient liquidity** | OKX, outAmount **823 lamports** |

Bot chỉ cho Metis, chủ động loại JupiterZ/Dflow/OKX. Vì thế hai token này không có route trong **phạm vi router được phép tại lúc kiểm tra**, dù router khác đưa ra được quote. Quote OKX chỉ **0,000000823 SOL**, nhỏ hơn network fee thông thường, chưa tạo transaction, chưa simulate và chưa chứng minh SELL khả thi/thu SOL dương.

Không mở OKX, không đổi routing policy và không gửi SELL thử. Giá trị định giá GMGN trên UI không tương đương SOL có thể thu thực tế từ một executable SELL quote.

Evidence: `data/route-quotes-1793233578196.json`; đối chứng Metis quote-only cùng điều kiện không taker: `data/route-quotes-1793233857919.json`.

## 5. IMAGINE có quote nhưng SELL sẽ làm giảm SOL

Lỗi PRE_SELL trong run mới ghi:

```text
token delta = -3.160.729.206 atomic (đúng toàn bộ holding)
minimum output = 657 lamports
quoted fees = 5.369 lamports
simulated wallet SOL delta = -4.705 lamports
```

Validator yêu cầu SELL phải thu SOL dương; vì vậy từ chối ký. Cùng tên SIMULATED_BALANCE_MISMATCH với BUY ở mục 1 nhưng **nguyên nhân khác**: output quá nhỏ so với phí, không phải rent BUY vượt bound. Không thể giải thích mọi mismatch bằng cùng một root cause nếu không đọc side và delta.

## 6. Không có chuyện toàn bộ token bị chặn mua

Run mới đã có hai BUY tự nhiên được đọc receipt độc lập lúc **07:32:23** và đều **finalized**:

| Mint | Token nhận atomic | SOL debit thực tế | Network fee | Signature |
| --- | ---: | ---: | ---: | --- |
| `FFpdTfmvm5EhdXQNJx3RVUbb9rGo7JHraK6ABWpH769P` (bio999) | 4.564.448.873 | 3.425.216 lamports | 6.516 lamports | [5udjNPvq…DHacYjS](https://solscan.io/tx/5udjNPvq435qjea3bC2vtK8FYwYGRf7do1jgxswaJNxz76tBXMyBJBqMetfCsKibVEgQHNbygi41hhi64DHacYjS) |
| `E1XGR9BnuN2ykn2iqMBq8qo6nWFmKoUcmiPq2u4bnXa1` | 4.659.340.962 | 3.461.292 lamports | 5.724 lamports | [SLoQHCin…71oUeg](https://solscan.io/tx/SLoQHCinBnNzLV2BBm1MqqU22F2gsyYDjkqsDEpZt3GLBSiHFZ83masCFZwJN7EXHY3Y8P37Tgcq8pWZg71oUeg) |

SOL debit gồm principal, network/priority và retained rent; không được gọi toàn bộ debit là network fee. Principal tương ứng **1.904.860** và **1.870.608** lamports, đúng 1% spendable sau reserve tại lần approval đó.

Đáng chú ý bio999 trước đó từng unsigned mismatch, rồi được requalify bằng dữ liệu/quote mới và BUY thành công với execution ID khác. Probe sau đó lúc **07:32:07** cũng thấy route Pump.fun AMM đơn giản hơn, không cần tạo thêm những account trước đó. Không có thay đổi code nào trong khoảng này. Điều này cho thấy route/layout/account state có thể thay đổi; không có cơ sở loại vĩnh viễn mọi token từng gặp mismatch, cũng không có cơ sở phát lại lệnh cũ.

Trong khoảng đầu 07:23–07:32 đã ghi **35 lần ANALYZE trên 15 mint**, **23 Jev SKIP**, **7 Jev BUY trên 5 mint**. Phần lớn scanner records không thành BUY vì Jev/Risk chưa cho phép, không phải mọi record đều chạm Jupiter rồi mất route. Các bước/counter khác nhau không phải cùng một mẫu số để tính win rate.

## Trạng thái và giới hạn điều tra

- LIVE PID **9104**, policy **CAPITAL_FLOW_V1**, build **f753c5817a52515b949c8549473aa2c8280de2e0d89a5f24417b874d78216d6c**. Cổng 3000, entries bật, không global halt tại các checkpoint đã ghi.
- Ba holding cũ không bị xóa/đóng giả. Market/flow timestamp tiếp tục tăng trong khi PRE_SELL cooldown còn tới khoảng 07:53–07:54; đây là runtime evidence cho việc tách monitoring khỏi SELL backoff.
- Một lần Jev trả action/fraction không khớp bị fallback HOLD; các lần sau tiếp tục được phân tích. Không bypass parser để ép exit.
- `providers.execution=BLOCKED/JUPITER_HTTP_400` có thể là health của **lần request SELL thất bại gần nhất**, không tự đồng nghĩa toàn Jupiter outage hoặc entries bị halt. Đọc timestamp, haltReason và từng receipt cùng nhau.
- Cần giữ nguyên validator trước khi có thiết kế khác được triển khai và kiểm chứng riêng. Điều tra này không sửa bất kỳ logic route/execution nào.
- Lời gọi điều tra gửi **0 signature, 0 transaction**. Các giao dịch thật kể trên do normal LIVE Engine phát sinh từ điều kiện thật; không phải smoke hoặc ép giao dịch chứng minh.
- Không bảo đảm đã lấy lại chính xác quote lịch sử. Quote/simulation là thời điểm kiểm tra, không cam kết route còn tồn tại hoặc landing thành công sau đó.

Artifact tổng hợp: `data/route-investigation-1793233668405.json`, `data/route-investigation-1793233767878.json`; receipts thật: `data/capital-flow-live-receipts-1793233943233.json`. Các tệp JSON có timestamp để phân biệt checkpoint, không sửa lại bằng chứng cũ.

**Chốt quan sát 07:35:41:** normal LIVE vẫn bật, không halt; có **6 holdings**, tất cả số lượng khớp chain, pending=0. Có thêm BUY thật sau mốc 07:32, vì vậy hai BUY trong bảng là mẫu receipt đã phân tích, không phải tổng cuối cùng. Snapshot chốt: `data/capital-flow-final-checked-1793234141143.json`. Tổng thời gian quan sát sau khởi động khoảng 12 phút; sau khi kết thúc lượt chat, tiến trình vẫn chạy nhưng không có một phiên giám sát chủ động vô thời hạn của trợ lý.
