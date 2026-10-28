# Thêm nhà cung cấp hoán đổi

Implement supports/getQuote/buildSwap/healthCheck theo SwapProvider. Chỉ nhận endpoint/documentation đã xác minh, key phía bot. Validate output Zod, raw integers và decimals, identity, fee/impact/slippage/expiry. Build liên kết đúng quote và token recipient.

Không tin transaction opaque. Executor phải kiểm tra decoded calldata hoặc program/instructions/ALT/account invariants trước signing. Reverse quote vẫn UNKNOWN sellability đến khi simulation có bằng chứng balance delta. Thêm timeout/429/schema/route mismatch/no resend fixtures trước wiring engine.
