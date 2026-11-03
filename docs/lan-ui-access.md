# Truy cập giao diện từ điện thoại trong LAN

Địa chỉ hiện tại: **http://192.168.1.66:3000**. Máy tính có IP này trên Ethernet 2, subnet 192.168.1.0/24.

Backend giữ nguyên listener `127.0.0.1:3000`, Host/Origin và CSRF. Cầu nối riêng trong `scripts/lan-ui-proxy.ts` chỉ bind IP LAN được chỉ định, kiểm tra đúng Host/Origin trước khi chuyển tiếp tới backend cố định ở loopback. CSRF, JSON body, CSP và SSE vẫn được giữ. Không import Engine, Store, cấu hình giao dịch hoặc signer.

Đã chạy cầu nối ở nền ngày 30/10/2026; không restart bot LIVE PID 11500, không sửa `.env`, không gọi POST hoặc tạo giao dịch từ việc kiểm chứng. HTTP qua LAN trả 200 trên máy tính; browser viewport 390 hiển thị giao diện LIVE, 0 browser errors, 0 POST. Chưa xác minh truy cập từ điện thoại thật.

**Firewall đã cấu hình bằng quyền Administrator.** Đã tạo rule Allow dưới đây. Sau khi điện thoại vẫn timeout, kiểm tra ActiveStore phát hiện thêm rule Block TCP cho đúng Node executable trên mạng Public, ưu tiên hơn Allow. Lúc 20:22:55 Bangkok ngày 30/10/2026, đã đổi phạm vi cổng của riêng rule Block TCP đó từ `Any` thành `1-2999,3001-65535`. Chỉ cổng 3000 được loại khỏi Block; các cổng còn lại và rule UDP không đổi. Allow vẫn giới hạn IP máy tính và subnet LAN, không tắt Firewall. Evidence: `data/lan-ui-network-diagnosis-admin-result.json`, `data/lan-ui-firewall-repair-admin-result.json`. Chưa có xác nhận từ điện thoại thật sau bước sửa này.

Rule Allow để tham khảo khi cấu hình lại trong PowerShell **Run as Administrator**:

```powershell
New-NetFirewallRule -Name 'BOTB-LAN-UI-3000' -DisplayName 'BOT B UI - LAN subnet only' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3000 -LocalAddress 192.168.1.66 -RemoteAddress 192.168.1.0/24 -Profile Any
```

Sau đó mở đúng URL `http://192.168.1.66:3000` trên điện thoại cùng LAN. Nếu vẫn không truy cập được, kiểm tra điện thoại có ở guest Wi-Fi/client isolation hoặc VPN hay không. Không cần port forwarding trên router.

Cầu nối hiện là process riêng, chưa đăng ký tự khởi động cùng Windows. Để chạy lại sau khi đóng process hoặc khởi động lại máy, tại thư mục dự án:

```powershell
pnpm exec tsx scripts/lan-ui-proxy.ts 192.168.1.66
```

Lệnh này chỉ mở cầu nối, không khởi động hoặc kích hoạt LIVE. Nếu DHCP đổi IP thì cần dùng IP LAN mới và cập nhật rule tương ứng. Muốn đóng truy cập LAN thì dừng riêng process cầu nối; backend loopback tiếp tục chạy. Rule có thể gỡ bằng `Remove-NetFirewallRule -Name 'BOTB-LAN-UI-3000'` trong PowerShell Administrator.

Kiểm chứng: 3 tests của `tests/lan-ui-proxy.test.ts` đạt (Host/Origin/CSRF, assets/status/SSE, upstream unavailable); typecheck và lint đạt. Không rebuild `dist/` của bot đang LIVE. Evidence: `data/lan-ui-verification.json`, `data/lan-ui-mobile.png`, logs `data/lan-ui-*.log`.
