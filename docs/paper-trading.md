# Giao dịch mô phỏng

MOCK/PAPER giữ nguyên kịch bản xác định để nghiên cứu giao diện và chiến lược, không cần key hoặc RPC. REAL/PAPER lấy discovery/market/security/Jev/quote thật nhưng chỉ ghi fill mô phỏng theo minimum output; không ký hoặc gửi giao dịch.

requireSellSimulation=true là mặc định. Có thể dùng ví watch-only có vốn thực để mô phỏng RPC chỉ đọc; nếu chọn quote-only phải đặt false rõ ràng. Quote đảo chiều không chứng minh token bán được. Giá quote, liquidity, transfer tax và network fee chưa biết được ghi thành hạn chế, không thay bằng số 0.

Vị thế nguyên, thoát bằng quote mới, phí/giá vốn proration và unknown valuation giữ đúng. Real PAPER không phải bằng chứng LIVE đã thực thi được; kết quả giả lập không đảm bảo lợi nhuận tiền thật.
