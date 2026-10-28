# Chiến lược

Giữ new-launch và momentum plugin hiện có: điều kiện token age, động lượng/khối lượng, điểm thành phần và AI. HardFilter chạy trước Jev; ScoreEngine và Strategy quyết định đề xuất; RiskEngine cấp intent cuối cùng sau kiểm tra danh mục, route và simulation.

Strategy chỉ nhận NormalizedTokenState và classification, không import SDK, signer hoặc broadcast. Giới hạn tiền lệnh đến từ settings/policy và lượng quote nguyên, không lấy từ AI. Giữ UNKNOWN và quality khi thêm feature; không ép boolean/number mặc định.
