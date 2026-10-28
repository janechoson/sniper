# Thêm chiến lược

Implement Strategy plugin sử dụng NormalizedTokenState, score và AI classification; đăng ký ID trong config/schema/UI tiếng Việt. Không thêm private API client/SDK/signer trong strategy.

Dữ liệu thiếu phải là UNKNOWN và có policy rõ. HardFilter/RiskEngine vẫn có quyền từ chối cuối. Kiểm tra deterministic fixtures cho điều kiện trigger, dữ liệu cũ/thiếu, trần rủi ro và trạng thái pause/kill. Analytics gắn strategyId để phân nhóm.
