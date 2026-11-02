# K1ll of BOT — Kronos

Bot Kronos độc lập, **PAPER mặc định**, có execution LIVE qua Jupiter khi được cấu hình và kích hoạt rõ ràng. Không JEV/Structure/Controlled Markup. DB, wallet configuration và logs riêng; không đọc dữ liệu BOT B.

Đã cài dependencies và build tại máy này. Khởi động:

```powershell
cd C:\Users\admin\Desktop\Tool\sniper
pnpm start
```

Mở **http://127.0.0.1:8793**. Server khởi động với collection **PAUSED**. Không tự discovery hoặc gọi model khi vừa start. Dừng bằng Ctrl+C.

Để thu thập market data, tự tạo `.env` của bot mới theo `.env.example` và điền `KRONOS_GMGN_API_KEY`. Không copy `.env`/wallet của bot khác. Sau đó restart bot này và bấm **Bắt đầu collection / trading theo mode**. PAPER không cần wallet/Jupiter; cả hai mode không dùng TypeSafe/JEV.

| Biến | Ý nghĩa |
| --- | --- |
| `TRADING_MODE` | `paper` / `live`; thiếu hoặc không hợp lệ → PAPER; LIVE thiếu cấu hình thì fail closed |
| `KRONOS_GMGN_API_KEY` | Cần khi bắt đầu collection; không cần để mở dashboard |
| `KRONOS_RPC_URL` | HTTP(S) Solana read-only; thiếu dùng public mainnet fallback |
| `KRONOS_PORT` | Mặc định8793, loopback only |
| `KRONOS_DATABASE_PATH` | `data/kronos.sqlite`, bắt buộc nằm trong project |
| `KRONOS_RUNTIME` | `runtime`, Python/model/tmp/lock riêng |
| `KRONOS_LOG_DIR` | `logs`, bắt buộc nằm trong project |

Eligibility config: `config/eligibility.json`. Tám giá trị không chứa secret được tái tạo từ effective policy của Lab tại thời điểm tách; không đọc settings/API của BOT B lúc runtime. Không có JEV/Structure/Controlled-Markup gate.

Pipeline: independent GMGN rank50/cycle120s → cheap/security/mint/M1/flow → Kronos → WAIT/PAPER BUY → OPEN monitor → HOLD/PAPER SELL. **Không giới hạn tổng lifecycle/history**; không xóa hoặc ghi đè records khi đạt số lượng nào. Một model inference tại một thời điểm, GMGN start spacing3s. PAPER PnL là gross price return; LIVE dùng token quantity/receipt đã đối soát, network fees thật và rent classification. Xem hướng dẫn LIVE bên dưới.

Discovery chạy tách khỏi await của model/OPEN loop; vẫn dùng chung transport GMGN tuần tự. Lỗi/timeout provider hoặc model có thể làm chậm observation; không có SLA latency. Listing lại cùng mint sau terminal state có thể thành appearance mới theo timestamp của snapshot; đây là semantics kế thừa, không phải permanent mint blacklist.

Cài lại sạch nếu cần (Node22.22.0/pnpm10.28.2, Python3.11.11 qua `uv`):

```powershell
pnpm install --frozen-lockfile
pnpm exec node scripts/prepare-python.mjs
pnpm run model:prepare
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Không copy `node_modules`, venv, DB hoặc `.env` từ bot khác. `model:prepare` chỉ tải/verify4 public pinned artifacts, khoảng115MB. Python dependency lock có hashes. Model: Kronos-small `901c26c1332695a2a8f243eb2f37243a37bea320`, tokenizer `0e0117387f39004a9016484a186a908917e22426`, vendor commit `67b630e67f6a18c9e9be918d9b4337c960db1e9a`; 3seeded paths/horizon5/price-only, không phải calibrated confidence.

Khi chạy cùng BOT B, hai bot có thể dùng chung quota GMGN/RPC nếu cấu hình cùng credentials. Không có cache/cooldown/DB mutable dùng chung; hãy cấu hình credentials phù hợp. Các trial/trades cũ vẫn nằm ở bot cũ, không xuất hiện ở DB mới.

Overview lấy layout BOT B hiện tại: carousel → current token/evaluation/result/Action Log → Paper Positions. Statistics nằm ở tab riêng. History/Positions50rows/page, logs100/page, overview queue8rows; đây là giới hạn đọc, không phải cap lưu trữ. Không có giới hạn720decisions hoặc50.000events dừng analysis.

Xem [controlled-live-jupiter.md](docs/controlled-live-jupiter.md) (trạng thái hiện tại), `docs/continuous-market-overview.md` (lịch sử PAPER), `docs/standalone-migration-report.md` (lịch sử tách bot) và `evidence/` để kiểm tra phạm vi copy, isolation và kết quả tests.

## Controlled LIVE

Không tự bật LIVE. Server luôn khởi động PAUSED. Xem [hướng dẫn và kết quả kiểm chứng](docs/controlled-live-jupiter.md) trước khi cấu hình ví riêng. Dùng `TRADING_MODE=live`, các tên biến ví/Jupiter trong `.env.example`, BUY cố định1% trong tab Cấu hình và ACK `KRONOS_LIVE_ACK=I_ACCEPT_REAL_TRADING`. Không dùng lại ví BOT B tự động. `KRONOS_JUPITER_API_KEY` là optional như BOT B: để trống vẫn gửi request Jupiter không có `x-api-key`; nếu provider từ chối/rate-limit thì trade vẫn bị chặn theo policy hiện hữu.

Sizing: `floor(max(balance - reserve, 0) / 100)` theo BigInt lamports. Tỷ lệ BUY LIVE cố định1%, hiển thị trong tab Cấu hình từ backend; không cần biến giới hạn SOL tuyệt đối. Base reserve 0,02 SOL +0,005 SOL mỗi OPEN đang có; không tự tăng size để lấy route. Slippage1%, priority cap100.000lamports và fee ceiling5.000.000lamports kế thừa provider BOT B. Unknown execution khóa wallet lane cho đến reconciliation; không tự phát lại transaction.

`KRONOS_EXECUTION_DRY_RUN=true` với cấu hình LIVE hợp lệ chỉ chạy đến final validation rồi STOP BEFORE SIGN. Đặt false hoặc bỏ biến mới cho phép ký khi user chủ động bật collection. Không trộn dry-run với executed trades.

History có filter ALL/PAPER/LIVE; Statistics tách PAPER và LIVE. Actual entry/exit SOL per token được suy từ receipt; USD dùng FX evidence riêng và có thể UNKNOWN. GMGN mark/MFE/MAE là estimate, không phải executable liquidation value.
