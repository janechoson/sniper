# Nhà cung cấp hoán đổi

SwapProvider hỗ trợ supports/getQuote/buildSwap/healthCheck. AtomicRouteEngine gọi các provider phù hợp, kiểm tra chain/token/raw amount/decimals/TTL/slippage/impact, chọn minimum output tốt nhất trong quote hợp lệ. Chưa tối ưu giá ròng sau gas giữa nhiều tuyến.

EvmRouterSwapProvider hỗ trợ V2 direct và V3 IQuoter V1. Build chỉ nhận quote do chính instance phát hành và còn hạn. Deadline, path, recipient, amount, minOut và exact approval được executor giải mã kiểm tra lại. Jupiter V2 trả instruction; build v0 với ALT từ RPC và allowlist; mặc định priority fee bằng 0.

Quote đảo chiều chỉ chứng minh có tuyến báo giá, sellability vẫn UNKNOWN. Chỉ simulation balance delta mới cho bằng chứng TRANSACTION_SIMULATION. Network fee chưa có định giá giữ UNKNOWN. API provider lỗi không thay bằng route mock.
