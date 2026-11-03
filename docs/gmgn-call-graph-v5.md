# Call graph trước triển khai V5

Đọc mã nguồn khi bot đã dừng, 29/10/2026. Không gọi provider trong audit này.

```text
Engine (một Gmgn instance)
 ├─ DiscoveryCoordinator.poll → Gmgn.trending → market trending
 │                           └─ Gmgn.discover → market trenches
 ├─ analyzeCandidate → info → token info
 │                  → security → token security
 │                  → intelligence → token holders / portfolio created-tokens
 │                  → sau Jev: info + security mới trước Risk/BUY
 ├─ solUsd → info(SOL, cache30s)
 ├─ monitor → security + info từng holding → solUsd → smartMoneyExits(cache30s)
 ├─ optional counterfactual after-exit → info(cache30s)
 └─ PAPER execution branch → security + info

info đã nhận → normalizeMarket → CapitalFlow.observe / observeCandidate
                           └─ memory/Jev context (không tự gọi GMGN)
UI GET/SSE → DB/status projection (không tự gọi GMGN)
Executor/Jupiter/RPC → không gọi transport GMGN
```

Gmgn.run là cửa ra duy nhất của runtime; CLI allowlist data-only, execFile chạy pinned gmgn-cli. Các verify/controlled/maintenance scripts có thể tạo Gmgn riêng nếu operator chạy chúng; process-local coordinator không chia quota với một process ngoài. Không chạy các probe này cùng bot để đo tải.

Trước V5: queue FIFO một request, spacing1.2s; cache một số caller, không single-flight và không kiểm tra cache lần nữa sau queue wait. info/security mặc định TTL0; nhiều lượt đọc trùng vẫn lần lượt gọi CLI. Lỗi rate-limit thật đặt cooldown5phút; lỗi command khác có thể đặt cooldown30s. Cùng nhãn GMGN_RATE_LIMIT_COOLDOWN không đủ xác định nguyên nhân HTTP gốc. ProviderFailures gom lỗi trên3mint rồi SYSTEM halt; do đó một upstream cooldown tạo nhiều incident position. GMGN CLI1.6.9 đọc x-ratelimit-reset và in reset timestamp/remaining vào thông báo lỗi; RATE_LIMIT_BANNED_MAX cảnh báo gọi sớm sẽ kéo dài ban. Không có bằng chứng endpoint quotas độc lập: cooldown rate-limit sẽ dùng phạm vi provider chung.

Thiết kế V5 mở rộng đúng client này: shared bounded cache + single-flight + priority/aging queue + một outbound job + configurable spacing/backoff/jitter/reset guidance. Structure Watch tái sử dụng snapshot/Flow qua bounded candidate scheduling, không tạo timer5s/mint. Giao dịch vẫn cần fresh authoritative reads, safety và quote validation; lỗi GMGN retryable là provider wait/degraded, không bằng chứng token/scam/structure fail.
