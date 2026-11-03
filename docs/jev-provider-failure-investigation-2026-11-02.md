# Điều tra JEV NO_DECISION / PROVIDER_FAILURE

02/11/2026, Asia/Bangkok. **READ-ONLY INVESTIGATION. Không dừng/restart bot, không sửa source/settings/.env hoặc DB, không gọi POST/provider inference thật từ công cụ điều tra.** Bot LIVE hoạt động độc lập trong thời gian đọc; không khẳng định DB/wallet bất biến.

## Kết luận

Nhãn trong ảnh không đủ để kết luận JEV mất kết nối. Lỗi tương ứng được lưu ở DB là **`JEV_EXIT_ACTION_FRACTION_MISMATCH`**: phản hồi đã qua JSON/schema nhưng `action` không khớp `sell_fraction`. Parser từ chối an toàn; scheduler phân loại lỗi này vào nhóm provider quá rộng, khiến UI hiển thị “Jev tạm thời không khả dụng”.

Chuỗi đã xác minh:

```text
JEV response → parseJevExit
→ action / sell_fraction không nhất quán
→ Blocked(JEV_EXIT_ACTION_FRACTION_MISMATCH)
→ scheduler catch không nhận diện mã mismatch
→ NO_DECISION_PROVIDER_FAILURE + PROVIDER_UNAVAILABLE
→ UI: JEV chưa có kết luận hợp lệ · PROVIDER_FAILURE
```

Source: [parser](../src/jev.ts#L342), [scheduler catch](../src/jev-exit-scheduler.ts#L174), [UI projection](../public/app.js#L1953).

Các tổ hợp hợp lệ là HOLD + NONE, FULL_SELL + ALL, PARTIAL_SELL + một percentage được hỗ trợ. Ví dụ HOLD + ALL bị từ chối. **Ví dụ này là fixture, không phải raw response của một incident thật.** Raw response gây mismatch không được persist trước khi parser throw, nên chưa xác định chính xác cặp action/fraction của từng incident LIVE. Mã lỗi chỉ chứng minh một trong các predicate consistency đã thất bại.

## DB/runtime evidence

Snapshot khoảng **11:36:32–11:36:43 Bangkok**, tính từ startup 11:28:18:

| Kết quả đánh giá exit | Số lượt |
| --- | ---: |
| `JEV_EXIT_ACTION_FRACTION_MISMATCH` | 3 |
| `NO_DECISION_INSUFFICIENT_DATA` | 12 |
| Tổng lượt hoàn tất | 15 |

Ba mismatch: GATO lúc **11:29:58** và **11:34:32**; FOCO lúc **11:34:22**. Latency khoảng 390–458ms. Không có HTTP401/403/429/5xx hoặc timeout trong nhóm 15 exit decisions này.

Ở 12 response còn lưu được raw answers, JEV trả HOLD + NONE nhưng `data_sufficiency` chỉ **0,35–0,42**, dưới ngưỡng code **0,7**, nên parser trả NO_DECISION. Đây là **đánh giá sufficiency của JEV**, không phải kết luận độc lập rằng mọi input thực sự thiếu. Một số raw HOLD confidence cao vẫn bị sufficiency guard chặn; hai chỉ số khác nhau. Không hạ ngưỡng để làm quyết định đi qua.

Các mismatch không bắt đầu từ việc nâng Kronos cap: lịch sử retained **trước startup này có 674 rows** mang cùng mã. Hash `jev.ts`, `jev-exit-scheduler.ts`, `engine.ts`, `position-view.ts`, `util.ts` khớp baseline trước thay cap. Không có bằng chứng thay đổi cap 50→300 tạo lỗi parser này.

Evidence: [runtime đầu](../data/jev-provider-investigation-runtime.json), [decisions](../data/jev-provider-investigation-decisions.json), [aggregation](../data/jev-provider-investigation-summary.json).

## Hành vi bot khi lỗi

- `sellBps=0`, action NO_DECISION; response lỗi không cấp strategic SELL mới. NO_DECISION không có nghĩa đã có kết luận HOLD hợp lệ.
- `Engine.applyExitDecision()` lưu failed attempt rồi return; không thu hồi strategic opportunity còn hợp lệ trước đó. Manual/protective exits vẫn có authority riêng và vẫn chịu execution safety.
- Monitoring và lịch re-evaluation vẫn chạy. Current recheck 60s/min interval 15s là scheduler constraints, không bảo đảm mỗi phút có một câu trả lời hợp lệ.
- “Bảo vệ: Không có tín hiệu” nghĩa projection không có protective opportunity hiện hành; không chứng minh token an toàn hoặc JEV đã duyệt HOLD.
- “59 giây” trong ảnh là tuổi của lần đánh giá (`createdAt`), không phải bằng chứng request timeout 59 giây. Timeout HTTP của code là 15s; nhóm mismatch có latency dưới 0,5s.
- `providers.jev=UNKNOWN` theo entry Http client không phản ánh đầy đủ các exit clients riêng. Không dùng nó làm bằng chứng API chưa được gọi.

## Vấn đề provider khác được quan sát

GMGN có `GMGN_RATE_LIMIT_COOLDOWN` ở checkpoint đầu; GATO/FOCO có monitoring/Flow DEGRADED lúc đó. Điều này hạn chế fresh market evidence và có thể ảnh hưởng các vòng đánh giá tiếp theo. **Chưa chứng minh đó là nguyên nhân khiến JEV chấm sufficiency thấp hoặc trả action/fraction mâu thuẫn.** Đến **11:38:16**, GMGN health đã READY trở lại. GMGN cooldown là vấn đề riêng, không phải HTTP failure JEV được chứng minh trong ảnh. Không clear cooldown, tăng traffic hoặc chạy probe bên ngoài.

## Kiểm chứng cô lập và giới hạn

Đã gọi parser/scheduler thật với 3 synthetic inconsistent pairs trong process fixture, credentials bị test preload chặn, không network call. Cả ba đều tái hiện đúng mã mismatch rồi bị scheduler gắn PROVIDER_FAILURE. [Fixture results và source hashes](../data/jev-provider-investigation-parser-fixtures.json). Không sửa test/source đang chạy, không build dist hoặc chạy smoke LIVE.

Hướng xử lý sau điều tra: phân loại mismatch thành response/semantic-consistency failure và hiển thị đúng nguyên nhân; cân nhắc lưu sanitized response evidence trước parser rejection. Việc cải thiện coherence của output hoặc sufficiency cần đánh giá riêng, giữ nguyên guard từ chối inconsistent SELL. **Chưa triển khai bất kỳ sửa chữa nào trong lượt này.**

Bot giữ nguyên PID7656 và được xác nhận qua GET ở [checkpoint cuối](../data/jev-provider-investigation-runtime-final.json); xem timestamp/checkpoint thực tế vì runtime tiếp tục thay đổi.
