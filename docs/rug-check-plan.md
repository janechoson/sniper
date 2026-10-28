# Kế hoạch Rug Check — 27/10/2026

Mở rộng mã hiện tại, không thay kiến trúc hoặc bật LIVE. Audit: on-chain analyzers đã có mint/Token-2022 và ERC20/EIP1967; holder Solana chỉ tính khi chứng minh full supply; internal creator history có quan hệ pool creator; atomic routes/simulation/executor và hard filter trước AI đã có. Chưa có mô hình evidence đa nguồn, consensus độc lập, Jev risk questions, báo cáo/UI hay dữ liệu Rug Check riêng.

| Thành phần | Thực hiện | Kiểm chứng |
| --- | --- | --- |
| Core | Zod Evidence, snapshot, provider, policy/decision/Jev risk, provenance | UNKNOWN/null, không SAFE khi thiếu mandatory |
| On-chain | Mở rộng details EVM/Solana, không suy diễn capability từ selector | ABI/SPL fixtures và lỗi RPC |
| Holder/creator/LP | Raw/adjusted concentration có exclusions chứng minh; history incidents; LP evidence có nguồn | Bigint, thiếu coverage, không gọi price dump là scam |
| External | Xác minh GoPlus/Honeypot/RugCheck từ nguồn chính thức; opt-in, timeout, bounded cache | Schema/identity/timeout/conflict fixtures; unsupported chain UNKNOWN |
| Engine/risk | Collect → catastrophic gate → fresh trade checks → gate → Jev risk → deterministic decision; giữ legacy trading/risk checks | AI không được gọi khi hard reject, không override, không stale sellability |
| Open positions | Recheck critical evidence, fresh SELL qua intent/executor cũ; không phụ thuộc AI | Không chặn exit khi AI lỗi; all-trading kill vẫn có hiệu lực |
| Storage/analytics | Snapshot/evidence/provider/decision/AI và observations append-only, namespace riêng, projections/index | Dedupe/restart, bounded payload, p50/p95/p99 và disagreement |
| UI/docs | Báo cáo tiếng Việt theo nhóm và nguồn/tuổi dữ liệu; readiness theo chain | Browser MOCK/REAL và mobile |

Các metric không chứng minh được để UNKNOWN. Không chọn explorer/locker/deployer address tùy ý; không quét full chain. Provider không đủ tài liệu để disabled. Threshold số chỉ nằm trong config mẫu bảo thủ hoặc policy rõ ràng, không gọi là ngưỡng sinh lời. Kiểm tra mạng chỉ đọc; không broadcast.
