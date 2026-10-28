# Thêm DEX

Xác minh family/factory/program/deployment và source chính thức. EVM kiểm tra event ABI/canonical log/confirmation/fromBlock. Solana cần IDL commit/hash, instruction/discriminator, event CPI và token account semantics; không đặt parser log chung cho mọi AMM.

Discovery chỉ cung cấp token/pool/event identity và durable cursor; market collector cần swap/liquidity thật, quality/coverage. Quote qua SwapProvider riêng. Kiểm thử fixture từ encoding thực, duplicates, gap, reorg và unsupported pool; chưa xác minh thì hiển thị PARTIAL/BLOCKED.
