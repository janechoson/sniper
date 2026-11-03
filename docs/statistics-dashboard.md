# Statistics dashboard — audit và presentation contract

**DEFERRED theo yêu cầu user:** ưu tiên Global Design/Overview và grouped Logs. Đã rút phần Statistics UI đang làm dở; page giữ implementation trước redesign. Nội dung dưới là audit để tiếp tục sau, không phải báo cáo hoàn thành.

**03/11/2026, Asia/Bangkok.** UI-only `/thongke`, không pause/restart bot, không sửa backend/trading/accounting/schema/config. Reference là ảnh Statistics Dashboard user cung cấp; số trong ảnh không phải fixture thị trường để đưa vào production.

## Audit trước implementation

`dashboard-statistics.js` hiện render Object.entries thành raw labels/JSON, polling5s qua route context. `index.html` chỉ có heading, strategy select và root. Theme cream/border/green/red/purple đã có trong CSS; global navigation/header giữ nguyên. Shell có SOL/USD price + timestamp; không cần provider mới.

Actual GET `/api/statistics?strategy=ALL` trả discovered/analyzed/rugRejected/jevCalls/jevBuy/jevSkip/riskAllow/riskReject/bought/open/closed/strategy, strategyAccounting, realizedLamports, unrealizedLamports, pnlBasis, winRate. strategyAccounting gồm closed/wins/losses/grossPnlLamports/feesPaidLamports/identifiedFeesLamports/feesComplete/netPnlLamports. `STANDARD` và `KRONOS` hiện chỉ trả object accounting, không có discovery/open/bought/JEV/Risk hoặc cả hai strategy trong cùng response.

Checkpoint audit: ALL discovered2321/bought38/open1/closed35; accounting wins14/losses14, gross/net/realized null, unrealized−388426lamports, identifiedFees614915lamports, feesComplete=true, winRate=null. STANDARD closed14/wins3/losses4/gross/net null; KRONOS closed21/wins11/losses10/gross−61083226/net−61498250lamports. Đây là checkpoint LIVE có thể tự thay đổi, không hardcode vào UI. Shell SOL price91.70529801USD, có timestamp; không ghi CSRF/secrets vào báo cáo.

Semantics từ `Engine.analytics`: gross realized gồm các trade đã settled (kể cả realized portion ở OPEN); unrealized chỉ managed OPEN/PENDING_EXIT. Accounting gross/net/fees chỉ nhóm CLOSED có originalQuantity>0. Không cộng các scope này thành total Net mới. Backend winRate là ratio trên toàn closed-accounting cohort khi mọi gross PnL known; null phải giữ unknown. Filtered accounting không có field winRate; nếu derive từ wins/(wins+losses), UI phải nêu denominator là các trade phân loại được, không gán unknown/flat thành loss. JEV BUY rate=jevBuy/jevCalls; Risk allow rate=riskAllow/(riskAllow+riskReject); denominator0→unknown.

Comparison không có dữ liệu đủ trong current statistics response; dùng empty state, không gọi thêm STANDARD/KRONOS/status/history/positions để lấp table. Badge count là global dependency nhỏ đã có của shell/router, tiếp tục giữ; không nhầm `/api/positions/count` với full Positions page API.

Implementation và verification sẽ bổ sung sau kiểm chứng.
