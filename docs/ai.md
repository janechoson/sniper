# Jev / TypeSafe System One

JevAIProvider dùng @typesafe-ai/sdk 0.7.0, TypeSafeClient.systemOne, choice/noul/score theo [tài liệu chính thức](https://docs.typesafe.ai/api/system-one). Node.js >=22 cho môi trường REAL. TYPESAFE_API_KEY chỉ phía bot; JEV_MODEL mặc định jev-latest, JEV_TIMEOUT_MS mặc định 3000.

TYPESAFE_API_KEY là nguồn chính. Tương thích một chiều: nếu thiếu biến này thì đọc JEV_API_KEY cũ; hai biến khác nhau làm startup lỗi. Nên xóa biến cũ sau chuyển đổi. Không đưa khóa vào NEXT_PUBLIC_ hoặc frontend.

Typed questions action BUY/HOLD/SKIP, momentum/quality 5 mức, suspicious và insufficientData. Score API 0..4 được đổi 0..100; choice confidence và noul probability xử lý riêng. State được whitelist và sanitize, không gửi ví, số dư, secret, creator address hoặc toàn bộ raw event.

Timeout/401/429/network/SDK/schema lỗi → AI_FAILED, chặn entry REAL. Không fallback mock. BUY chỉ tiếp tục đánh giá, không cấp quyền mua. Telemetry lưu thời điểm, model, loại câu hỏi, normalized answers, latency, usage và trạng thái; không lưu auth/raw state lớn. Bộ fixture đã kiểm tra transport SDK; chưa gọi Jev tài khoản thật do thiếu key và máy đang Node20.

JevRiskClassifier bổ sung typed questions rug_risk/suspicious/insufficient_data/risk_category/PASS-WATCH-SKIP; giữ score0..4 và gắn snapshot hash. Timeout/schema/SDK lỗi thành UNAVAILABLE; chặn entry LIVE theo policy. Chi tiết tại [Rug Check](rug-check.md).
