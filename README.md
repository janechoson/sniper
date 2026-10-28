# Super Bot 1M$ — Quan sát agent trên thị trường thật

**Trạng thái hiện tại:** chủ ví đã ủy quyền LIVE; scanner/timers tự chạy, chỉ Solana nằm trong allowlist thực thi. BNB khóa vì thiếu native confirmation trace; Robinhood khóa vì reverse simulation thất bại. Mọi lệnh vẫn phải qua policy và ApprovedTradeIntent. Xem [khởi động LIVE và blocker thực tế](docs/live-start-20261028.md). Các checkpoint dry-run bên dưới là lịch sử kiểm chứng trước activation.

**Chính sách funding mới:** `knownBadFunding` true/false/UNKNOWN chỉ để tham khảo, không chặn entry/readiness hoặc tự thoát. Các chốt rug/honeypot/sellability vẫn giữ. Xem [audit và UNKNOWN còn bắt buộc](docs/funding-informational-20261028.md).

**Cập nhật LIVE_DRY_RUN:** đã bổ sung đường native SOL/BNB/ETH, fee reserve, USD provenance, Jev runtime và khóa RPC chống broadcast. EXECUTION_PREFLIGHT Solana/BNB đã qua quote hai chiều/build/simulation/ký cục bộ; security/risk của chiến lược chưa đạt, Robinhood còn lỗi reverse simulation. Không bật LIVE. Xem [ma trận và báo cáo mới nhất](docs/live-dry-run-report-20261028.md).

**Cập nhật chuẩn bị LIVE:** `.env` hiện chọn dữ liệu thật + `live_dry_run`, tắt observation và tự quét, giữ `LIVE_TRADING_ACK=false`. Helius HTTP/WS và đọc số dư Solana đã kiểm tra thành công. Chưa sẵn sàng phát giao dịch: xem [các điểm chặn và sizing10%](docs/live-activation-20261028.md). Chạy `pnpm verify:live` để tạo báo cáo chỉ đọc tại `data/live-preflight.json`; exit2 hiện có nghĩa chưa đạt. Mô tả observation5USD bên dưới dành cho cấu hình quan sát cũ và `.env.example`, không phải chế độ hiện tại trên máy.

Dashboard tiếng Việt tại http://127.0.0.1:3000. Hiện dùng scanner/RPC, market data, Rug Check và Jev thật. Database cũ đã được sao lưu và dọn; không nạp token TEST-/mock hay số liệu mẫu vào runtime.

Giao diện terminal nền giấy kem theo papertrade.xyz, chữ nâu đậm, màu nhấn olive và card bo góc có bóng đổ mềm (xem [bảng màu](DESIGN.md)); bốn mục Tổng quan, Vị thế, Lịch sử quyết định và Cài đặt. Chỉ số chưa xác minh hiển thị Chưa rõ, không thay bằng số liệu mẫu. Xem [kế hoạch thiết kế](docs/dashboard-redesign-plan.md) và [báo cáo kiểm tra giao diện](docs/dashboard-redesign-report.md).

## Chế độ hiện tại

Solana discovery hiện gồm **Pump.fun, PumpSwap, Raydium CPMM, Meteora DLMM**. Token Pump qua kiểm tra nhận dạng/quote/trạng thái ban đầu trước khi vào phân tích sâu; source/lifecycle và funnel hiện ở dashboard. Xem [nguồn protocol đã xác minh](docs/solana-pump-discovery.md). Chạy `pnpm verify:pump` để kiểm tra dữ liệu PAPER và báo giá hai chiều, không ký hoặc gửi giao dịch.

BNB discovery đã mở rộng thành **10 deployment**, Robinhood thành **16 deployment**: launchpad/curve, PancakeSwap V2/V3/Infinity và Uniswap V2/V3/V4. Có Four.Meme, OpenFour, Flap, Pons V2, Bags, Doppler, Long.xyz và các strategy pools.trade đã xác minh. GraFun và trench.today chưa bật do chưa có ABI hiện hành đủ bằng chứng. Xem [ma trận trước/sau và giới hạn coverage](docs/discovery-coverage-bnb-robinhood.md).

Chạy `pnpm verify:discovery:bnb`, `pnpm verify:discovery:robinhood` hoặc `pnpm verify:discovery:abis` để kiểm tra chỉ đọc. Metrics nguồn và funnel nằm trong **Lịch sử quyết định**. Token chuyển venue được ghép lifecycle theo chain + token; phát hiện không cấp quyền mua. Curve/singleton chưa có market reader hoặc quote chưa có giá USD vẫn hiển thị nhưng dừng trước phân tích sâu. Receipt và log lịch sử BNB dùng endpoint discovery dự phòng trong config khi PublicNode hạn chế phương thức này; endpoint được kiểm tra chain ID, không đổi RPC thực thi hoặc `.env`.

OBSERVATION_ONLY=true, DATA_MODE=real, TRADING_MODE=paper, LIVE_TRADING_ACK=false. Scanner tự bắt đầu cho Solana, BNB và Robinhood đã cấu hình. Dashboard hiển thị tiến trình đọc thị trường/bảo mật, phân loại Jev, lý do bỏ qua và trạng thái RPC.

Theo quyết định mới nhất của người dùng, mỗi tín hiệu mua mô phỏng tạm dùng5USD. Chỉ khi chiến lược có tín hiệu phù hợp và có quote mua/bán thật đạt policy thì mở virtual position; không tạo ngẫu nhiên toast đã mua. Toast ghi rõ **Đã mua/đã bán mô phỏng**. SELL theo báo giá mới và quy tắc stop-loss/trailing/partial take-profit/max holding; phí/khớp thật chưa xác nhận, không tính toast vào P&L ví thật.

Không cần khóa ví. Trong chế độ này runtime không cấu hình signer từ .env, không gọi executor, không ký/broadcast. Chỉ nhập khóa ví không bật LIVE. Tín hiệu quan sát vẫn lưu lý do LIVE bị chặn; dữ liệu thiếu giữ UNKNOWN. Quote-only sellability vẫn UNKNOWN, không được coi là bán được thật.

## Khởi động

Ubuntu dùng Node22 LTS+ và pnpm10.28.2. Trên máy Windows hiện tại đã có Node22.23.4 local trong data/runtime-download, tải từ nodejs.org và kiểm tra SHA256; launcher tự dùng runtime này khi Node hệ thống còn20.

```bash
pnpm install
# Nếu chưa có .env: cp -n .env.example .env
pnpm dev
```

Lệnh tự migrate SQLite rồi mở bot/API/Next trên cùng một cổng loopback. Giữ .env hiện có. Bản build: pnpm build rồi pnpm start. Khi sửa backend, khởi động lại tiến trình; Next tự cập nhật giao diện trong dev.

Config quan sát: config/observation.json. Feed USD đọc Chainlink on-chain qua BNB RPC, gồm BNB/SOL/ETH/USDC; định giá cross-chain chỉ là tham chiếu và market USD được đánh dấu ESTIMATED. Không mặc định stablecoin1USD. Không coi config này là bản production LIVE đã xác minh đủ.

Key backend: TYPESAFE_API_KEY cho Jev; JUPITER_API_KEY cho quote Solana. Không có key hợp lệ thì báo lỗi/UNKNOWN, không thay mock AI. Giới hạn Jev mặc định một lượt mỗi20giây toàn engine. Địa chỉ/khóa EVM/Solana vẫn có thể để trống khi quan sát.

## Giới hạn dữ liệu thật

EVM quan sát cho phép đọc latest-state non-atomic vì RPC công khai có thể từ chối state block lịch sử; bằng chứng ghi rõ giới hạn. Đường production vẫn mặc định đọc strict theo block. Solana quan sát ưu tiên WS logs của initialize/create rồi xác minh transaction/IDL; fallback lấy tối đa5 signature gần nhất mỗi15giây, không chứng nhận đầy đủ swap windows. Khi mất coverage, volume/unique/holder thiếu bằng chứng vẫn UNKNOWN. RPC công khai có thể rate-limit hoặc lỗi; dashboard phải hiển thị lỗi thật. Không dùng full-chain scan hay phát minh pool để lấp danh sách.

## SQLite và backup

SQLITE_PATH=data/trading.db, WAL/FULL, journal + projections cùng transaction. Quan sát dùng namespace real-observation và virtual ledger riêng; không có execution/position tiền thật từ toast. IMPORT_LEGACY_JOURNAL=false để không phục hồi lại dữ liệu cũ. Backup trước reset được ghi trong data/last-observation-reset.json; journal cũ đã chuyển vào backups.

```bash
pnpm db:backup
pnpm db:restore --from backups/FILE.db --to data/restored.db
```

Restore tạo file mới, không ghi đè active DB; dừng bot rồi thay SQLITE_PATH nếu cần phục hồi. Không xóa backup hoặc đưa .env vào Git.

## Quy ước cho lần chạy thật

Production sizing đã đổi từ ngân sách cố định sang mặc định **10% số dư khả dụng của tài sản đầu vào tại thời điểm phê duyệt**. Tính bằng bigint, kiểm tra native reserve và pending execution, đọc lại balance trước duyệt intent; thay đổi amount cần quote và risk lại. Không tự wrap native, không tính10% tổng giá trị danh mục ví. Cap vẫn có quyền từ chối, không tự giảm phần trăm. Xem [triển khai và giới hạn](docs/live-activation-20261028.md).

Đọc [bàn giao LIVE](docs/live-handoff.md) trước khi làm thay đổi đó. Các chốt RugCheck, HardFilter, Jev, RiskEngine, ApprovedTradeIntent, nonce/idempotency/kill/positions/exits phải giữ. [Audit trước chế độ quan sát](data/audit-current-state-20261027.md) ghi các điểm thiếu provider/coverage cần giải quyết trước LIVE.

## Kiểm tra

```bash
pnpm test
pnpm lint
pnpm typecheck
pnpm build
pnpm test:browser
```

Browser QA đọc server quan sát đang chạy; không tạo token hoặc chèn fixture vào DB. Fixture/mock chỉ còn phục vụ unit tests. Sources: https://nodejs.org/en/download ; https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/json-rpc-endpoint/ ; https://reference-data-directory.vercel.app/feeds-bsc-mainnet.json ; https://solana.publicnode.com/ .
