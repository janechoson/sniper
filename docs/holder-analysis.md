# Holder và creator

HolderDataProvider/CreatorDataProvider độc lập chiến lược. Thứ tự ưu tiên: RPC → dataset nội bộ → external đã xác minh và được chọn → UNKNOWN. Không có provider external mặc định; không hardcode Birdeye/Helius/Moralis/Bitquery/Covalent/Bubblemaps.

REAL_ONCHAIN: Solana count/top1/top5/top10 chỉ khi largest token accounts cover toàn bộ supply, cùng context slot, unpack đầy đủ và aggregate owner hợp lệ. EVM chưa có RPC phổ quát cho danh sách holder; để UNKNOWN. Không dùng 20 largest accounts làm toàn bộ phân bố khi supply không khớp.

REAL_INTERNAL: quan hệ pool creator/token/transaction và số token đã quan sát, outcome nội bộ; persist để cải thiện lịch sử sau restart. POOL_CREATOR khác TOKEN_DEPLOYER. Chưa có bằng chứng on-chain tổng quát xác định deployer EVM từ mọi pool.

UNKNOWN: creatorPct khi chưa có creator proof, freshWalletPct, suspiciousClusterPct, lịch sử token ngoài dataset, funding độc hại, holder count/concentration thiếu coverage. Reputation nội bộ chỉ mô tả dữ liệu đã thấy, không xác nhận người tạo an toàn. ESTIMATED: chỉ số quy tắc có ghi chất lượng; EXTERNAL: chưa sử dụng. Provider holder/creator/security bổ sung còn cần chọn trước khi policy LIVE nhận đủ metric bắt buộc.
