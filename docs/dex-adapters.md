# Bộ kết nối DEX

Discovery độc lập SwapProvider. EvmFactoryDiscovery xử lý PairCreated/PoolCreated; SolanaProgramDiscovery xử lý chương trình với IDL đã ghim. Chỉ theo dõi pool ghép đúng một tài sản quote tin cậy, kiểm tra identity/metadata/code và lưu sự kiện trước khi tiến cursor.

Không quét từ genesis nếu không có fromBlock rõ ràng. Bootstrap gần head và backfill hữu hạn. Dedupe theo chain/DEX/pool và revision tx/block. Observer swap phát hiện reorg tại các block đã lưu và làm lại coverage; discovery lưu checkpoint block/hash và kiểm tra lại trước tiến cursor. Khôi phục được crash giữa checkpoint và cursor; hash thay đổi thì dừng để đối soát, không tự xóa sự kiện/vị thế đã ghi. Hash cuối khoảng cũng được kiểm tra trước/sau thu thập log.

Raydium CPMM/Meteora DLMM IDL có manifest và pnpm verify:idls. AMM khác cần adapter riêng; khai báo tên DEX không tạo ra connector.
