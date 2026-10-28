# Trạng thái quan sát —27/10/2026

## Hiện tại

Runtime chỉ nhận DATA_MODE=real. OBSERVATION_ONLY=true, TRADING_MODE=paper, LIVE_TRADING_ACK=false. Phiên bản Node đang dùng trên máy này là22.23.4 local, binary từ nodejs.org có đối chiếu SHA256. Không thay Node hệ thống hoặc gửi khóa ra frontend.

Scanner tự bật cho Solana/BNB/Robinhood đã cấu hình. EVM có cursor và bounded catch-up400block, WS newHeads/HTTPpoll3s; observation xác minh code hiện tại, ghi reference latest-state non-atomic. Production mặc định vẫn strictblock. Solana observation nhận WS initialize theo đúng tên instruction trong IDL, không nhầm InitializeAccount; fallback lấy5signature gần nhất/15s. RPCJSON reader opt-in maxSupportedTransactionVersion=1 cho legacy/v0/v1; không nâng quyền ký/gửi v1. Swap windows khi thiếu coverage giữ UNKNOWN.

Nguồn chính thức v1: https://solana.com/docs/core/transactions/versioned-transactions và https://solana.com/docs/rpc/json-structures . Tài liệu đã đối chiếu với RPC thực tế lỗi-32015 trước khi sửa.

## Không có dữ liệu thị trường giả

SQLite trước reset có1065journal entries, gồm1064commit mock và1marker import. Đã snapshot trước khi xóa business rows, giữ migration; activeDB sau reset journal0. Backup mới nằm ở đường dẫn ghi trong data/last-observation-reset.json. Journal nguồn cũ chuyển vào backups/legacy-journal-before-observation-20261027.jsonl. IMPORT_LEGACY_JOURNAL=false, không tự đưa lịch sử cũ trở lại.

Sau chạy quan sát đã có pool/tokenBNB nguồnRPC, phản hồi Jev providerjev/modeljev-1.14.0 (aliasjev-latest). Ví dụ ở lần kiểm tra thực tế: detected73, analyzed29, aiCalls5; số này tăng trong thời gian chạy. Database executions=0, commit mock=0. Không tạo token giả để lấp bảng hoặc ép phát sinh toast.

FeedUSD từ Chainlink aggregator đọc qua BNB RPC: BNB/SOL/ETH/USDC. USDC được đọc ra0.99966664USD ở một lần kiểm tra, không cố định1USD. Đây là referenceon-chain; marketUSD/cross-chainvaluation giữ ESTIMATED, không chứng nhận wrappedasset peg hoặc khả năng bán. Public RPC có giới hạn, trạng thái lỗi/UNKNOWN được hiển thị.

## Mua/bán mô phỏng

Người dùng chốt ngân sách5USD tạm trong lúc xem agent. Observation analysis lưu Rug/HardFilter/lý do LIVE bị chặn; có thể phân loại quan sát khi thiếu dữ liệu bắt buộc LIVE, nhưng không có quyền approve thực thi. Chỉ khi chiến lược đề xuất và quoteBUY/SELL thật đạt impact/loss thì virtualbook mở vị thế. Quote-only sellability vẫn UNKNOWN; không đổi thành SELLABLE.

Virtual ledger riêng observation.trade, sourceRPC/executionSIMULATED, dùng raw integer từ quote. Có chống mở trùng, maxpositions/day/exposurecaps, quote fresh, partialtakeprofit/stoploss/trailing/maxhold theo policy. Không dùng ledger này làm P&L ví thật, không có signer, không tạo ApprovedTradeIntent hoặc gọi executor. Phí/slippage/khớp thật chưa được chứng minh. Toast ghi rõ đã mua/đã bán mô phỏng; không tạo toast mua nếu không có tín hiệu đạt kiểm tra.

API đóng position thật bị khóa trong OBSERVATION_ONLY, kể cả khi .env về sau có privatekey. Runtime không tạo signer từ secrets ở chế độ này. Chuyển LIVE+OBSERVATION_ONLY bị schema từ chối.

## Kiểm tra

Full Vitest156pass,4network tests bỏ qua mặc định; thêm observation tests bảo vệ5USD, nguồnRPC, impact, staleexit, partialsell/restart/no executions. Solana test chạy cả strict và observation, có v1 và loại trừ hint InitializeAccount. Lint/typecheck/build đạt.

Chrome desktop/mobile/SSE/UI5USD/khóaAPI thực thi đạt trên server nguồnRPC. Kiểm tra toast bằng responseSSE riêng trong trangQA ẩn; không phát event giả từ server hoặc ghi DB, ảnh desktop/mobile chụp trước bước test toast từ trang dữ liệu thật. Các fixture chỉ dành tests.

API snapshot không gọi thêm RPC liên tục ở observation; dùng health background để tránh UIpoll/SSE tạo bão RPC. Một lần kiểm tra API trả74ms thay vì chờ hàng đợiRPC.

## Lần chạy thật sau này

Đã lưu yêu cầu đổi5USD→10% số dư khả dụng vào docs/live-handoff.md và AGENTS.md. Chưa tuyên bố10% đã tích hợp LIVE. Cần triển khai số dư fresh/reserves/atomicreservation/re-quote/risk và kiểm tra lại caps khi người dùng yêu cầu chạy thật. Không tự bật LIVE khi chỉ nhập khóa ví.

Lần kiểm tra cuối lưu tại data/observation-final-health.json: sourceRPC, observationOnly=true, budget5USD, running=true; detected96, analyzed38, aiCalls6, executions0; Solana và RobinhoodSCANNING, BNB đang catch-up/CONNECTING tại thời điểm chụp. Chrome bản release đạt. API không chứa key. Tra cứu tài liệu qua Treg trong đợt này:0USD (call74b6f3d2cda64739819a17370b2d6137).
