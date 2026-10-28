# Thống kê và bằng chứng

REAL dùng raw confirmed fills, giá quote USD tại intent và network fee/approval fee đã biết; thiếu thành phần thì kết quả null/UNKNOWN. Giá vốn được phân bổ khi bán một phần. Daily PnL dùng ngày UTC; vị thế qua nửa đêm thiếu baseline thì không suy ra lãi/lỗ ngày bằng 0.

Thống kê có candidate/trade counts, win rate, average/median return, profit factor, max drawdown USD, holding time, nhóm chain/DEX/strategy và score/confidence buckets. Equity chỉ các vị thế đóng đã định giá, chưa phải equity toàn tài khoản. Phạm vi cache hiển thị rõ; đây chưa phải backtest có ý nghĩa thống kê hoặc tối ưu tham số tự động.

Mốc pipeline từ sự kiện/nhận/chuẩn hóa/features/security/HardFilter/AI/risk/quote/simulation/broadcast/confirmation được ghi khi quan sát được. SecurityReady hiện là thời điểm kết thúc tập features, nên latency security là cận trên chung, không benchmark độc lập. Không tạo mốc confirmation cho dry-run.

Outcome REAL theo dõi 1/5/15/60 phút, 6/24 giờ khi pool còn trong giới hạn theo dõi và có mẫu kịp thời, gồm cả SKIP/REJECT. Mẫu trễ/thiếu ghi missed, không dùng giá muộn làm giá đúng horizon. Có giới hạn maxPools/observations; không đảm bảo bao phủ mọi token trong 24h. MFE/drawdown là từ mẫu thu thập, không phải mọi tick.
