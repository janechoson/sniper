# Audit frontend Log — 2026-11-01

Scope theo yêu cầu cập nhật: chỉ màn Log. Thống kê tạm bỏ qua, giữ nguyên implementation hiện tại.

- `public/index.html`: tab `#logs` chỉ có heading và `#terminalAllLogs`.
- `public/app.js`: `BOTOverview.update` đang render mỗi event thành JSON text. Các tab dùng navigation hiện tại; chưa có chart library và task Log không cần dependency mới.
- Nguồn sẵn có: `/api/status` và SSE full status có 30 event gần nhất; SSE `overview` có attempt UUID, mint/symbol, stage/log/timestamps và summaries; SSE `flow` có pipeline transitions. Không có API lịch sử log đầy đủ.
- Metadata token có trong `/api/tokens`, `/api/positions`, `/api/history` đã được frontend tải sẵn và trong snapshot candidate hiện tại. Có thể tái sử dụng cache, không thêm external request.
- Presentation adapter sẽ normalize event, resolve token name, giữ raw payload cho expand/copy, lọc/search theo dữ liệu đã nhận. Buffer và DOM có giới hạn; counts là counts trong buffer, không giả tổng lịch sử database.
- Pause/clear chỉ tác động bản hiển thị Log, không POST, không thay runtime. Export tạo JSON từ dữ liệu đang lọc. Range lọc timestamp có thật; không suy diễn lịch sử chưa tải.
- Chỉ sửa HTML/CSS/JS frontend và thêm browser tests/report/screenshot. Không sửa `src`, config, API, DB, `.env`, trading hay restart bot LIVE.
