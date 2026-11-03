# Báo cáo audit: Theo dõi vị thế và thực hiện SELL

**Dự án:** BOT B / K1ll of BOT  
**Ngày audit:** 28/10/2026 — Asia/Bangkok  
**Checkpoint runtime:** 20:28:04, ngày 28/10/2026  
**Phạm vi:** mã nguồn hiện tại, tiến trình LIVE và dữ liệu lưu tại thời điểm audit.

> Báo cáo này ghi lại kết quả audit đã thực hiện. Không triển khai bản sửa, không thay đổi cấu hình, không khởi động lại tiến trình LIVE và không gửi giao dịch trong quá trình audit. Các tình huống kiểm chứng bổ sung chạy với dữ liệu trong RAM, không truy cập mạng hoặc ví thật. Trạng thái runtime bên dưới là ảnh chụp tại checkpoint, không phải trạng thái được bảo đảm ở thời điểm đọc báo cáo.

## Kết luận chính

Bot có vòng lặp xử lý nhiều vị thế, nhưng **BACKOFF hiện bỏ qua toàn bộ việc theo dõi vị thế đó**, bao gồm market, PnL, MFE/MAE và ExitEngine. Vì vậy không thể bảo đảm IMAGINE sẽ phát hiện mọi lần phục hồi lên +30%.

Runtime còn đặt **`maxHoldSeconds=1800` — thời gian giữ tối đa 30 phút**. Tắt stop loss không đồng nghĩa bot sẽ giữ token nhiều giờ để chờ hồi giá. Điều kiện hết thời gian giữ có ưu tiên cao hơn TP.

Các vấn đề khác được phát hiện:

- Giao dịch UNKNOWN có thể bị kẹt đối soát khi một SELL khác làm thay đổi số dư SOL chung.
- Yêu cầu bán thủ công 50% có thể bị thực hiện thêm lần nữa sau khi giao dịch UNKNOWN được xác nhận qua recovery.
- TP thất bại được lưu vào lịch sử thực thi, nhưng không có yêu cầu TP đang chờ được giữ riêng để retry.

## 1. Runtime thực tế

| Mục | Ghi nhận tại checkpoint |
| --- | --- |
| Tiến trình | PID 16080, chạy `dist/live.js` |
| Chế độ | LIVE thường; không gắn controlled session |
| Mua mới | Đang bật |
| SYSTEM/TRANSACTION halt | Không |
| Vị thế đang giữ | 2 |
| Giao dịch chờ đối soát | Không |
| IMAGINE | Core state `OPEN`, attention `NEEDS_ATTENTION` |
| Lỗi IMAGINE | `TOKEN_SAFETY_FAILED / PRE_SELL / SIMULATED_BALANCE_MISMATCH` |
| Số token IMAGINE lưu trong position | 3.160.729.206 atomic units = 3160.729206 token |
| BACKOFF | `failureCount=3`; còn khoảng 24 phút |
| Tuổi bản định giá IMAGINE | Khoảng 5 phút 40 giây |
| Vị thế còn lại | `billion`, OPEN, khoảng 26 phút tuổi, không có attention |

Hai SELL gần nhất của IMAGINE đều **FAILED, chưa ký**, với lý do **`GMGN liquidity removal/collapse`**. Đây không phải hai lần TP thất bại.

Các giá trị IMAGINE đọc từ SQLite ở checkpoint:

```json
{
  "state": "OPEN",
  "quantity": "3160729206",
  "lastValueLamports": "3349258",
  "remainingCostLamports": "4325575",
  "highWaterLamports": "4325575",
  "mfePercent": 0,
  "maePercent": -23.6489,
  "takenProfits": [],
  "attentionStatus": "NEEDS_ATTENTION",
  "protectiveExit": "BACKOFF",
  "failureCount": 3
}
```

Đây là dữ liệu runtime/persistence được đọc trong audit; báo cáo không khẳng định đã xác minh lại toàn bộ số dư và giao dịch trên chain tại checkpoint này.

## 2. Vòng lặp theo dõi thực tế

Nguồn:

- [`Engine.start()`](../src/engine.ts): timer tại dòng 166–170.
- [`Engine.monitor()`](../src/engine.ts): bắt đầu tại dòng 704.
- [`Engine.tick()`](../src/engine.ts): recovery rồi gọi monitor tại dòng 357–362.

### Lịch gọi

- Timer gọi `monitor()` mỗi **5 giây**.
- Chu kỳ scanner cũng gọi `monitor()` sau recovery.
- Một lần gọi trả về ngay nếu đang monitoring, Executor đang bận hoặc Engine đang dừng.
- Với vị thế không có yêu cầu thủ công, bản định giá chưa đủ **15 giây** cũng khiến lượt đó bị bỏ qua.

Vì vậy **timer 5 giây không có nghĩa mỗi vị thế được định giá mỗi 5 giây**. Thời gian thực tế phụ thuộc cả độ trễ dữ liệu, SELL trước đó và thời lượng toàn bộ lượt xử lý.

### Chọn và duyệt vị thế

```ts
for (const p of this.store
  .positions(env.TRADING_MODE)
  .filter((p) => p.provider === "JUPITER" && p.state === "OPEN")) {
  // Xử lý lần lượt từng vị thế.
}
```

Vòng lặp chọn đúng chế độ hiện tại, provider `JUPITER` và core state `OPEN`. Không chỉ chọn vị thế đầu tiên, mới nhất hoặc một vị thế duy nhất. Không có giới hạn số lượng vị thế trong vòng lặp này.

## 3. Theo dõi 10 hoặc nhiều vị thế

Đường xử lý bình thường cho mỗi vị thế đủ điều kiện:

```text
OPEN
→ GMGN security
→ GMGN market + SOL/USD
→ tính giá trị token còn giữ
→ cập nhật PnL, MFE, MAE và high-water
→ Trading Memory observation
→ exitDecision()
→ HOLD hoặc SELL
```

Các vị thế được xử lý **tuần tự**, bằng các lời gọi `await` trong vòng `for`. Một vị thế/API/SELL chậm làm trễ các vị thế phía sau. Không có cam kết rằng cả 10 vị thế đều hoàn tất định giá trong 5 giây.

Hai nhánh LIVE đi thẳng đến SELL trước bước market/TP:

1. Yêu cầu bán thủ công.
2. Security có finding CRITICAL.

Các vị thế đang BACKOFF không đi qua đường xử lý bình thường cho đến hạn kiểm tra.

## 4. Vị thế thua lỗ rồi phục hồi

Không có điều kiện loại một vị thế khỏi monitoring chỉ vì PnL âm.

Kiểm chứng hàm `exitDecision()` trong RAM, với vị thế chưa quá thời gian giữ và không có điều kiện thoát ưu tiên:

| PnL được quan sát | Quyết định |
| ---: | --- |
| −10% | HOLD |
| −30% | HOLD |
| −50% | HOLD |
| +10% | HOLD |
| +30% | TP, bán 50% |

**Kết luận: YES có điều kiện.** Vị thế bình thường được đánh giá lại trong lúc lỗ và có thể TP khi hồi lên +30%, nếu:

- Vẫn còn core state `OPEN`.
- Không bị bỏ qua do BACKOFF.
- Dữ liệu được lấy thành công.
- Không có manual/security/liquidity/max-hold exit ưu tiên.
- Bot thực sự quan sát được mức giá đạt TP.

Nếu giá chạm +30% rồi giảm giữa hai lần quan sát, bot không được bảo đảm bắt được đỉnh đó.

## 5. Take profit hiện tại

Nguồn: [`exitDecision()`](../src/risk.ts), dòng 204–223; cấu hình thực tế đọc từ `/api/status`, đối chiếu [`config/strategy.json`](../config/strategy.json).

| Mốc | Hành động |
| --- | --- |
| +30% | Bán 50% số token còn giữ |
| +70% | Bán 100% số token còn giữ |

Điều kiện:

```text
giá trị token còn lại ≥ remainingCostLamports × ngưỡng TP
```

Đây không phải luôn là phần trăm **Total PnL** trên UI, đặc biệt sau một lần bán một phần.

### Đánh dấu mốc TP

- SELL intent chứa `takeProfitIndex`.
- `takenProfits` chỉ được cập nhật khi SELL được xác nhận và đối soát thành công.
- Một mốc đã ghi nhận thành công không tự kích hoạt lại.
- SELL thất bại trước khi ký không đánh dấu mốc TP là hoàn tất.

Nguồn: [`Executor.applyFill()`](../src/executor.ts), dòng 358–382.

### Sau partial SELL

- Giảm quantity theo số token thực bán.
- Phân bổ và giảm remaining cost theo tỷ lệ thực bán.
- Cập nhật realized PnL từ SOL delta thực tế.
- Điều chỉnh high-water theo lượng token còn lại.
- Trở lại `OPEN` nếu còn token.
- Chỉ chuyển `CLOSED` khi bán hết và đã đối soát.

Nếu giá vượt cả hai mốc cùng lúc, vòng TP chọn mốc chưa thực hiện đầu tiên. Mốc tiếp theo được xét ở lần monitoring đủ điều kiện sau.

## 6. Trailing profit và thứ tự ưu tiên

Nguồn: [`exitDecision()`](../src/risk.ts), dòng 187–223.

Điều kiện trailing hiện tại:

- Peak đạt ít nhất **+30%** so với giá vốn còn lại.
- Giá trị hiện tại giảm ít nhất **20% từ peak**.
- Giá trị hiện tại vẫn phải **cao hơn giá vốn còn lại**.
- Khi kích hoạt: bán **100% lượng token còn lại**.

Peak được cập nhật trong những lần định giá thành công. Sau partial SELL, peak giảm theo tỷ lệ lượng token còn giữ; trailing vì vậy tiếp tục có thể hoạt động trên phần còn lại.

Điều kiện `value > cost` ngăn trailing trở thành lệnh cắt lỗ trên phần vị thế còn giữ. Đây là so sánh với remaining cost, không phải toàn bộ kết quả đã thực hiện trước đó của giao dịch.

Thứ tự ưu tiên thực tế:

```text
Manual
→ Security critical
→ Liquidity collapse
→ Smart-money EXIT, nếu được cấu hình
→ Maximum holding time
→ Trailing profit
→ Take profit
```

Runtime đang dùng `smartMoneyExitMode=WARNING`, không phải EXIT.

**Đạt +30% không đồng nghĩa lý do SELL nhất thiết là TP.** Một điều kiện ưu tiên hơn có thể yêu cầu bán hết.

## 7. Stop loss có thực sự bị tắt?

**Có, stop loss theo giá/PnL đã bị tắt trong logic quyết định thoát lệnh hiện tại.**

Đã tìm các chuỗi `STOP_LOSS`, `stopLoss`, `stop_loss`, `loss threshold`, `negative PnL exit` trong mã nguồn và các vùng cấu hình/test/UI/tài liệu liên quan.

Các tham chiếu còn lại chủ yếu là:

- [`src/config.ts`](../src/config.ts): bỏ các khóa stop-loss cũ trong bước chuẩn hóa.
- [`src/learning.ts`](../src/learning.ts): nhận diện lý do stop loss của giao dịch lịch sử.
- Test kiểm tra stop loss đã bị loại và dữ liệu lịch sử.
- Bản dịch UI và tài liệu các lần chạy cũ.

Hàm phân loại `exitReason()` trong `learning.ts` không tạo lệnh SELL.

Không thấy nhánh tự động SELL **chỉ vì PnL âm**. Tuy nhiên bot vẫn có thể bán lỗ do:

- Quá thời gian giữ 30 phút.
- Thanh khoản sụt giảm.
- Security CRITICAL.
- Yêu cầu thủ công.

Đây là các điều kiện độc lập với stop loss và vẫn hoạt động.

## 8. NEEDS_ATTENTION và BACKOFF

Nguồn quyết định: [`Engine.monitor()`](../src/engine.ts), dòng 734–738.

```ts
const request = this.manual.find((x) => x.positionId === p.id);
if (!request && p.attention && p.attention.nextCheckAt > Date.now())
  continue;
```

Điều kiện này nằm **trước** security, market, PnL, MFE/MAE, Memory và ExitEngine.

**BACKOFF hiện có nghĩa: bỏ qua toàn bộ vị thế đến `nextCheckAt`, trừ yêu cầu thủ công.** Nó không chỉ hạn chế retry SELL.

| Hạng mục | Trong BACKOFF | Sau khi đến hạn |
| --- | ---: | --- |
| Market monitoring | NO | YES nếu lấy dữ liệu thành công và không đi nhánh thoát sớm |
| Cập nhật PnL | NO | YES nếu định giá thành công |
| MFE | NO | YES nếu định giá thành công |
| MAE | NO | YES nếu định giá thành công |
| Take Profit | NO | Được xét nếu không có exit ưu tiên |
| Trailing Profit | NO | Được xét nếu không có exit ưu tiên |
| Emergency Exit | YES | YES |

### Thời gian backoff

Nguồn: `Engine.positionIssue()`, dòng 317–344.

- Chưa đạt ngưỡng lỗi: `positionRecheckMs=60000` — 60 giây.
- Đạt `tokenFailureThreshold=3`: dùng `recentRejectTtlMs=1800000` — 30 phút.
- Failure count được chặn ở ngưỡng 3; lần lỗi tiếp theo tiếp tục đặt lại cooldown 30 phút.
- Attention và lịch retry được lưu trong position, nên restart không tự xóa cooldown.

Sau khi hết hạn, core state OPEN vẫn được chọn lại. Không có điều kiện loại vĩnh viễn chỉ vì tên attention là NEEDS_ATTENTION.

Fresh market thành công chỉ tự xóa attention có issue `POSITION_MONITOR / POSITION`. Attention từ PRE_SELL không được xóa chỉ vì giá đọc lại được; successful SELL reconciliation mới xóa attention.

## 9. Kịch bản IMAGINE phục hồi

Giả sử giá đi từ −23% lên 0%, +10%, +30%, +50%:

1. **Trong BACKOFF:** bot không định giá IMAGINE, không cập nhật excursion và không xét TP.
2. Nếu giá tăng rồi giảm trước hạn, bot có thể bỏ lỡ toàn bộ đợt tăng.
3. **Đến hạn:** IMAGINE vẫn OPEN, nên được đưa vào vòng lặp lại.
4. Bot kiểm tra security; nếu không thoát sớm thì lấy market, cập nhật giá trị và đánh giá điều kiện thoát.
5. Liquidity collapse và maximum holding time có ưu tiên trước TP.

IMAGINE đã giữ lâu hơn 30 phút. Vì vậy kể cả đang +30%, code có thể chọn:

- **Liquidity collapse**, nếu điều kiện này còn đúng — phù hợp lý do hai SELL gần nhất; hoặc
- **Maximum holding time**, nếu không còn điều kiện ưu tiên cao hơn.

Hai nhánh này yêu cầu bán hết, không phải partial TP 50%.

Nếu SELL tiếp tục không qua simulation, bot quay lại BACKOFF. Nếu SELL thành công và đối soát thành công, position mới được cập nhật hoặc đóng.

## 10. Vòng đời SELL thất bại sau TP

Nguồn: [`Store.claim()`](../src/store.ts), [`Executor.execute()` / `release()`](../src/executor.ts), [`Engine.isolate()` / `positionIssue()`](../src/engine.ts).

```text
TP đạt ngưỡng
→ tạo SELL intent có takeProfitIndex
→ claim: position PENDING_EXIT, execution CREATED
→ quote / validation / simulation
→ TOKEN_SAFETY_FAILED trước khi ký
→ execution FAILED
→ release position về OPEN, giữ nguyên token
→ NEEDS_ATTENTION / BACKOFF
```

### Có nhớ TP từng đạt không?

- **Có lịch sử** intent và lần thử, gồm takeProfitIndex.
- **Không có yêu cầu TP đang chờ được giữ riêng** để buộc retry sau cooldown.
- `takenProfits` chưa được đánh dấu là hoàn tất.

Khi đến hạn, bot xét lại các điều kiện với giá hiện tại:

- Vẫn đạt điều kiện: có thể tạo SELL intent mới.
- Không còn đạt TP, không có exit khác: HOLD.
- Có exit ưu tiên: chọn exit ưu tiên đó.

Kiểm chứng trong RAM: sau lần đạt +30% nhưng chưa SELL thành công, giá còn +20% thì `exitDecision()` trả HOLD trong trường hợp không có exit ưu tiên.

Đây là khác biệt giữa **lưu lịch sử lần thử** và **giữ một yêu cầu TP đang chờ**.

## 11. Cô lập lỗi giữa nhiều vị thế

Vòng xử lý mỗi position có `try/catch` riêng ở `Engine.monitor()`, dòng 740–878.

Với lỗi token/dữ liệu đã phân loại được:

- Ghi attention cho position đó.
- Đặt lịch kiểm tra lại.
- Tiếp tục xử lý các vị thế sau trong **cùng lượt monitoring**.

Không có `break` mặc định sau một token SELL failure.

Các giới hạn:

- Xử lý tuần tự nên lỗi chậm/timeout vẫn làm trễ các vị thế sau.
- SYSTEM/TRANSACTION có thể halt mua mới; điều đó không tự động dừng tất cả protective monitoring.
- Nếu chính việc xử lý lỗi hoặc ghi DB ném lỗi tiếp, exception có thể thoát vòng lặp. Cơ chế hiện tại không bảo đảm cô lập mọi lỗi hạ tầng.

## 12. Nhiều SELL gần cùng thời điểm

Bot có thể xử lý A → B → C tuần tự trong vòng monitoring. Mỗi vị thế có SELL intent và quantity riêng.

[`Executor.execute()`](../src/executor.ts), dòng 57–64, có một khóa `busy` chung cho thực thi ví. Khóa được nhả trong `finally`. Đây là tuần tự hóa ví, không phải giới hạn chỉ một position được SELL.

Tuy nhiên, khi một giao dịch đã ký bị UNKNOWN, các SELL khác mint vẫn có thể tiếp tục. Điều này tương tác không an toàn với cách đối soát số dư hiện tại; xem phát hiện HIGH ở mục 19.

## 13. Bảng trạng thái thực tế

Theo [`Position`](../src/domain.ts), core state chỉ gồm:

```text
PENDING_ENTRY | OPEN | PENDING_EXIT | CLOSED | FAILED
```

NEEDS_ATTENTION và MONITORING_DEGRADED là lớp attention. UNKNOWN còn là trạng thái execution/hiển thị; không phải một core state bổ sung của Position.

| Trạng thái thực tế | Market / MFE / MAE | ExitEngine / TP | Emergency |
| --- | --- | --- | --- |
| OPEN, không cooldown | YES khi đủ điều kiện kiểm tra | YES theo thứ tự ưu tiên | YES |
| OPEN + NEEDS_ATTENTION | NO trong cooldown; thử lại khi đến hạn | Tương tự | YES, vượt cooldown |
| OPEN + MONITORING_DEGRADED | Thử lại khi đến hạn | Sau khi đủ dữ liệu | YES |
| PENDING_EXIT | Không qua vòng OPEN | Đối soát; không tạo TP mới | NO |
| Execution UNKNOWN, thường kèm PENDING_EXIT | Đi đối soát | Chưa xét TP mới cho position pending | Không bán chồng |
| PENDING_ENTRY | NO | NO | NO |
| CLOSED | NO | NO | NO |
| FAILED | NO | NO | NO |
| Legacy provider khác Jupiter, dù OPEN | Không thuộc vòng này | Không qua đường Jupiter hiện tại | Không qua đường Jupiter hiện tại |

Một overlay UNKNOWN không tự thay đổi điều kiện chọn core state: nếu core vẫn OPEN, code vẫn xét bộ lọc OPEN và guard cooldown. Trạng thái thật, pending execution và attention phải được đọc cùng nhau.

## 14. MFE/MAE và Trading Memory

Hai tầng khác nhau:

1. **Position fields:** `mfePercent` và `maePercent` cập nhật ở mỗi lần định giá thành công trong `Engine.monitor()`.
2. **Trading Memory observations:** `TradingMemory.observe()` lấy mẫu theo `observationIntervalMs=30000`, có ngoại lệ khi security thay đổi, và yêu cầu có sample cùng BUY evidence hợp lệ.

Nguồn: [`Engine.monitor()`](../src/engine.ts), dòng 785–830; [`TradingMemory.observe()`](../src/trading-memory.ts), dòng 282–339; [`config/learning.json`](../config/learning.json).

| Tình huống | Position MFE/MAE | Memory observation |
| --- | --- | --- |
| PnL âm nhưng monitor bình thường | Tiếp tục cập nhật | Tiếp tục lấy mẫu nếu đủ điều kiện |
| NEEDS_ATTENTION đang cooldown | Không cập nhật | Không gọi observe cho position đó |
| Hết cooldown, market thành công | Cập nhật lại | Có thể ghi mẫu mới |
| Manual LIVE hoặc security CRITICAL đi nhánh SELL sớm | Không qua bước định giá trong lượt đó | Không có open observation từ nhánh bị bỏ qua |

MFE/MAE là kết quả từ những lần quan sát đã có, không phải đỉnh/đáy liên tục được bảo đảm. BACKOFF tạo khoảng trống quan sát đáng kể.

## 15. GMGN market failure của một vị thế

Với lỗi token hoặc transport được phân loại ở phạm vi position:

- Gắn MONITORING_DEGRADED.
- Lưu lỗi và `nextCheckAt`.
- Thử lại khi đến hạn.
- Các vị thế sau tiếp tục được xử lý.

Nếu vị thế LIVE đã quá max hold, nhánh catch còn thử full protective SELL khi không có signed pending transaction. Vì vậy lỗi lấy market không nhất thiết ngăn mọi maximum-hold exit.

Provider failure có thể được nâng thành SYSTEM khi có bằng chứng rộng hơn, chẳng hạn lỗi trên ba mint khác nhau trong cửa sổ theo dõi hoặc authentication/permission failure. Đây là nhánh riêng, không phải mỗi lỗi market đều gây global halt.

Nguồn: [`Engine.isolate()`](../src/engine.ts), [`ProviderFailures`](../src/failures.ts).

## 16. Route SELL phục hồi sau 10 phút

Không có một watcher riêng liên tục thử route cho position đang BACKOFF.

- Nếu chưa đến hạn cooldown, route phục hồi cũng chưa được phát hiện bởi monitoring của position đó.
- Khi đến hạn, position OPEN được đánh giá lại.
- Chỉ khi có yêu cầu SELL hiện tại — manual hoặc một exit condition — bot mới đi qua quote/simulation mới và thử thực thi.
- Không cần rebuild hoặc restart để thực hiện vòng đánh giá lại này.
- Nếu không còn điều kiện SELL, bot có thể HOLD mà không kiểm tra route ngay.
- Restart không phải cơ chế xóa attention đã được lưu.

Manual request có thể vượt cooldown, nhưng vẫn phải qua toàn bộ kiểm tra an toàn.

## 17. Manual SELL so với automatic SELL

Đường chung:

```text
exitPosition()
→ Executor.sellIntent()
→ Executor.execute()
→ Jupiter quote / validation / simulation
→ ký và lưu signature trước broadcast
→ submit
→ receipt + wallet reconciliation
→ applyFill()
```

Khác biệt:

| Manual | Automatic TP |
| --- | --- |
| API xếp yêu cầu qua `Engine.emergency()` | ExitEngine quyết định sau định giá |
| 50% hoặc 100% quantity hiện tại | Theo sellBps của mốc TP |
| LIVE vượt cooldown và guard 15 giây | Chịu lịch kiểm tra bình thường |
| LIVE đi thẳng đến SELL, không chờ market/TP | Cần đủ dữ liệu để xét TP |
| Không có takeProfitIndex | Có takeProfitIndex |

Cả hai vẫn dùng cùng provider, simulation, kiểm tra lượng token, receipt và reconciliation.

Nguồn: [`POST /api/exit`](../src/server.ts), [`Engine.emergency()` / `exitPosition()`](../src/engine.ts), [`Executor`](../src/executor.ts).

## 18. Trả lời các câu hỏi quyết định

| Câu hỏi | Kết luận |
| --- | --- |
| **Q1. −50% → +30%, không có lỗi an toàn: bot có tự TP?** | **YES có điều kiện:** vị thế vẫn OPEN, được quan sát, không có exit ưu tiên. Không bảo đảm chờ phục hồi qua giới hạn giữ 30 phút. |
| **Q2. −23% → NEEDS_ATTENTION → +30%: bot còn phát hiện TP?** | **DEPENDS:** không trong BACKOFF; sau hạn được xét lại, nhưng security/liquidity/max-hold có thể ưu tiên hơn TP. |
| **Q3. Một lỗi monitoring/SELL có ngăn vị thế khác?** | **NO với lỗi token đã isolate.** Có thể làm trễ; lỗi hạ tầng/handler có thể ngắt lượt. |
| **Q4. Một SELL lỗi có làm kẹt khỏi TP bình thường?** | **POSSIBLE.** Unsigned failure chỉ tạo cooldown; UNKNOWN và lỗi đối soát có thể giữ position PENDING_EXIT lâu dài. |
| **Q5. BACKOFF dừng riêng protective SELL retry hay toàn position?** | **Toàn bộ monitoring của position**, trừ yêu cầu thủ công. |
| **Q6. 10 OPEN có được theo dõi độc lập cho TP?** | **YES về vòng lặp**, nhưng từng position chịu cooldown, freshness, khả năng lấy dữ liệu và thứ tự xử lý. |
| **Q7. Ba position cùng TP có thể SELL độc lập?** | **YES trong luồng xác nhận bình thường**, tuần tự. Có rủi ro kẹt khi một giao dịch trước đó UNKNOWN. |

## 19. Các vấn đề phát hiện và hướng khắc phục đề xuất

**Chưa triển khai các đề xuất dưới đây.** Tái hiện trong RAM chứng minh nhánh code, không khẳng định mọi vấn đề đã xảy ra trên ví thật.

### HIGH — BACKOFF dừng cả monitoring và cơ hội TP/MFE/MAE

- **File/function:** `src/engine.ts`, `Engine.monitor()`, guard tại dòng 735.
- **Điều kiện:** attention chưa đến `nextCheckAt`.
- **Hậu quả:** bỏ qua toàn bộ dữ liệu và ExitEngine; có thể mất đợt phục hồi trong tối đa 30 phút mỗi lần và thiếu dữ liệu excursion.
- **Bằng chứng:** kiểm chứng trong RAM cho position BACKOFF cho kết quả **0 lần gọi dữ liệu thị trường**.
- **Đề xuất:** tách lịch định giá/ExitEngine khỏi lịch retry SELL. Chỉ hạn chế thử lại giao dịch lỗi, không dừng quan sát giá.

### HIGH — UNKNOWN có thể kẹt vì SELL khác thay đổi SOL chung

- **File/function:** `src/executor.ts`, `Executor.reconcile()`, dòng 445–475; kết hợp vòng pending/OPEN của `Engine.monitor()` và guard trong `Store.claim()`.
- **Điều kiện:** giao dịch A chưa đối soát xong; SELL B khác mint tiếp tục làm thay đổi SOL chung.
- **Cơ chế:** reconciliation A đòi `current SOL === before.sol + delta.sol` của riêng A. BUY có guard signed pending chung; SELL khác mint không có guard tương ứng.
- **Hậu quả:** A có thể tiếp tục UNKNOWN/PENDING_EXIT dù receipt thành công, không trở lại vòng TP của OPEN.
- **Bằng chứng RAM:** receipt A thành công, expected SOL 1100, current SOL 1150 do một SELL độc lập sau đó → `Wallet balances differ from receipt; manual reconciliation required`, execution UNKNOWN, position PENDING_EXIT.
- **Đề xuất:** xử lý thứ tự giao dịch chưa rõ trước các thay đổi ví tiếp theo, hoặc đối soát bằng ledger tính được các giao dịch sau. Không đơn giản bỏ kiểm tra số dư.

### HIGH — Manual bán 50% có thể bị thực hiện thêm sau UNKNOWN

- **File/function:** `src/engine.ts`, manual queue trong `Engine.monitor()` và xóa yêu cầu trong `exitPosition()`.
- **Điều kiện:** manual partial SELL không được xác nhận ngay, rồi được xác nhận qua recovery/pending reconciliation.
- **Cơ chế:** yêu cầu manual chỉ được xóa trên đường `exitPosition()` nhận kết quả CONFIRMED. Nếu xác nhận diễn ra ở nhánh reconciliation khác, position trở lại OPEN nhưng yêu cầu vẫn tồn tại.
- **Hậu quả:** vòng monitor có thể dùng lại cùng yêu cầu 50% trên quantity còn lại, tạo một intent mới ngoài ý định bán một lần.
- **Bằng chứng RAM:** 1000 token → giao dịch cũ xác nhận bán 500 → vòng monitor tạo thêm SELL **250 token**.
- **Đề xuất:** liên kết manual request với execution và tiêu thụ yêu cầu khi execution đó được xác nhận, kể cả qua recovery.

### MEDIUM — Không giữ riêng yêu cầu TP đang chờ sau SELL lỗi

- **File/function:** `src/risk.ts`, `exitDecision()`; SELL failure lifecycle trong `src/executor.ts` và `src/engine.ts`.
- **Điều kiện:** TP đạt ngưỡng nhưng SELL thất bại; giá đã giảm trước lần đánh giá tiếp theo.
- **Hậu quả:** lịch sử ghi nhận lần thử, nhưng không còn một TP request đang chờ. Bot có thể HOLD thay vì retry mốc đã chạm.
- **Bằng chứng RAM:** từng đạt +30%, sau đó +20%, không có exit ưu tiên → HOLD.
- **Đề xuất:** xác định rõ trạng thái TP đang chờ, chính sách retry và điều kiện hủy khi giá thay đổi; vẫn quote/simulate/validate mới cho mỗi lần thử.

### HIGH đối với mục tiêu giữ dài hạn — Max hold 30 phút

- **File/function:** cấu hình runtime, `config/strategy.json`, `src/risk.ts` → `exitDecision()`.
- **Điều kiện:** `now - entryAt > maxHoldSeconds * 1000`, hiện là 1800 giây.
- **Hậu quả:** yêu cầu bán hết có ưu tiên trước trailing/TP, kể cả PnL âm. Bot không mặc nhiên chờ token phục hồi sau nhiều giờ.
- **Phân loại:** đây là **xung đột giữa chính sách hiện tại và mục tiêu sử dụng**, không phải lỗi code thực hiện sai cấu hình.
- **Đề xuất:** quyết định riêng chính sách thời gian giữ trước khi coi bot là hệ thống giữ dài hạn. Audit này không thay đổi tham số.

## 20. Sơ đồ trạng thái thực tế

### Luồng bình thường

```text
BUY đã xác nhận và đối soát
            ↓
           OPEN
            ↓
   Đến lượt monitoring?
      ├─ Chưa → chờ lượt sau
      └─ Có
          ↓
 Security → Market → Giá trị/PnL → MFE/MAE → Memory
          ↓
      exitDecision()
      ├─ Không có exit → HOLD → OPEN ↺
      ├─ Exit ưu tiên → SELL theo lý do đó
      └─ TP → SELL
                ↓
         Xác nhận + đối soát
          ├─ Bán một phần
          │   → giảm quantity/cost/peak
          │   → lưu takenProfits nếu là TP
          │   → OPEN ↺
          └─ Bán hết → CLOSED
```

### Luồng lỗi trước khi ký

```text
SELL ATTEMPT
      ↓
TOKEN_SAFETY_FAILED trước khi ký
      ↓
Execution FAILED
      ↓
Position trở lại OPEN, giữ nguyên token
      ↓
NEEDS_ATTENTION + BACKOFF
      ↓
BỎ QUA TOÀN BỘ MONITORING đến nextCheckAt
      ├─ Manual request → thử SELL qua cùng validator
      └─ Đến hạn
          → lấy dữ liệu / đánh giá lại
          ├─ Không còn exit → HOLD
          ├─ Exit còn đúng → thử SELL mới
          └─ Lại lỗi → BACKOFF tiếp
```

### Luồng đã ký nhưng chưa rõ kết quả

```text
SELL đã ký nhưng chưa rõ kết quả
      ↓
Execution UNKNOWN + Position PENDING_EXIT
      ↓
Đối soát lại, không phát lại lệnh
      ├─ Thành công → OPEN hoặc CLOSED theo fill
      └─ Chưa đối soát được → tiếp tục pending
          → không vào vòng TP của OPEN
```
