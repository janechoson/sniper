> Cập nhật 02/11/2026: [controlled LIVE implementation](controlled-live-jupiter.md). Các trạng thái PAPER ONLY/RUNNING bên dưới là checkpoint lịch sử, không phải activation hiện tại.

# BOT Kronos độc lập — báo cáo triển khai

> **Cập nhật hiện tại:** bot đã chuyển sang REAL GMGN DATA / PAPER, không còn fixed trial cap và đã chạy collection. Xem [continuous-market-overview.md](continuous-market-overview.md). Các checkpoint STOPPED/cap200 bên dưới là lịch sử tại thời điểm tách bot, được giữ để đối chiếu.

**02/11/2026 — Asia/Bangkok. COMPLETE: READY / STOPPED, PAPER ONLY.**

Source BOT B: `C:\Users\admin\Desktop\Tool\gmgn-sniper`.
Destination: `C:\Users\admin\Desktop\Tool\sniper`.

Không migrate trading/runtime data. DB mới bắt đầu từ0. Không bật collection/current-data loop sau kiểm chứng. BOT B và Lab cũ tiếp tục chạy độc lập; tác vụ không restart/kill chúng.

## A. Audit Before Copy

Đã đọc actual source trước khi ghi destination: Kronos domain/lab/store/market/worker/server, GMGN parsers/security, Cheap Filter, history/flow, mint inspector, UI, dependency/config/build files và Python pins/worker.

Destination ban đầu **không hoàn toàn rỗng: chỉ có `.git`**. Đã dừng theo yêu cầu safety, thông báo, rồi tiếp tục sau khi user xác nhận “triển khai đi”. Giữ `.git` sẵn có; không copy Git history từ BOT B, không git init/push/đổi remote. `.git` là metadata version control, không tham gia thuật toán hoặc trading state.

Actual Lab reuse:

```text
KronosMarket → BOT /api/tokens + /api/kronos/settings (fallback /api/status)
             → direct read-only GMGN fallback /rank, /info, /security, /token_kline
             → RPC getAccountInfo
             → pure parsing / cheapGuard / inspectMint / parseMarketHistory / attemptFlow
KronosLab → KronosStore riêng → serial KronosWorker → PAPER-only domain functions
```

Không có reachable Jev, production Engine/Position, Trading Memory, Structure V3, Controlled Markup, Jupiter hoặc signer trong Lab decision path. Các production imports bao quanh shared helpers đã được tách ra, chỉ giữ các hàm/types thực sự cần. Không chỉnh file nguồn của BOT B.

Copy plan đã được thông báo **trước khi copy**:

| Nhóm | Quyết định |
| --- | --- |
| COPY | Kronos PAPER core, worker/vendor/pins/locks, UI assets và pure shared helpers cần thiết |
| DO NOT COPY | DB/WAL/SHM, backups, old trials/trades/history/statistical snapshots, logs, `.env`, private keys, node_modules, dist, source `.git` |
| RECREATE | Package/config/server/start scripts, empty DB, new logs/state/lock, own Python environment |
| REMOVE FROM KRONOS BOT | BOT API bridge, JEV/config/queues, production execution/signing, unrelated Strategy/Memory/Structure/Markup modules |

Evidence: [copy audit/allowlist/source hashes](../evidence/copy-audit.json).

## B. BOT B Directory Size Breakdown

Measured before copy, logical bytes, directory traversal không follow symlinks:

| Nhóm | Bytes |
| --- | ---: |
| src | 641.634 |
| public | 321.427 |
| config | 2.493 |
| scripts | 169.926 |
| tests | 448.394 |
| lab source/vendor/pins | 197.771 |
| node_modules | 298.600.144 |
| data, gồm DB/evidence/backups dưới data | 173.312.356 |
| backups ngoài data | 165.365 |
| dist | 629.411 |

Source/config/UI/scripts/tests khoảng1,8MB, không phải toàn bộ runtime. Full source directory đo ở checkpoint sau khoảng480.149.976bytes; data LIVE có thể tiếp tục đổi độc lập.

Model/runtime hiện hữu ở `%LOCALAPPDATA%/gmgn-kronos-runtime`, **ngoài source directory**: model/tokenizer khoảng114,8MB, Python base khoảng73MB, venv khoảng1,375GB. SQLite Lab cũ là `paper-lab.sqlite` ở đó. Không clone thư mục này.

## C. Files Copied

Allowlist copy gốc có23files; đường dẫn và SHA256 ở copy audit. Những nhóm được giữ/adapt:

- `src/kronos-domain.ts`, `kronos-lab.ts`, `kronos-store.ts`, `kronos-worker.ts`, `kronos-market.ts`, `token-metadata.ts`.
- Pure subsets: `domain.ts`, `discovery.ts` chỉ types, `gmgn.ts`, `risk.ts` chỉ cheapGuard/decision, `token-program.ts` chỉ mint compatibility, `market-history.ts`, `capital-flow.ts`.
- `public/index.html` từ standalone UI; `kronos.js`, `token-avatar.js`, CSS.
- `lab/kronos/worker.py`, vendor Python source/license, pins/model-files manifests, requirements input/hash lock.
- Build/TypeScript/ESLint definitions và bigint-buffer patch; dependency versions/lock graph được giữ, bỏ unused gmgn-cli ở root importer/package.

Package mới: **`k1ll-kronos-paper-bot`**. Node dependencies cài bằng `pnpm install --frozen-lockfile`, không copy node_modules. `dist` được build trong destination.

## D. Files Excluded

Không copy source `.env`/env variants, keypair/credential files, SQLite/journal/WAL/SHM/backups, entire data/backups/log/runtime/state directories, old paper records, Candidate/Position/Trading Memory datasets, existing snapshots/evidence reports, node_modules/dist/coverage/cache/tmp, `.git`, Python pycache/pyc hoặc venv cũ.

Audit evidence chỉ chứa source fingerprints, config công khai không secret và process reachability; **không chứa old trial payloads hoặc old PnL/statistics snapshots**. Synthetic fixture/model regression artifacts là kết quả mới của kiểm chứng này, không import history cũ.

## E. Database Isolation

New active DB:

```text
C:\Users\admin\Desktop\Tool\sniper\data\kronos.sqlite
```

Khởi tạo bằng `KronosStore` schema code, không ATTACH/import/copy DB.

| Table | Final active rows |
| --- | ---: |
| lab_trials | 0 |
| lab_decisions | 0 |
| lab_events | 0 |
| lab_meta | 0 |

Summary: Records0 / cap200; Paper Buys0; Open0; Closed0; Wins0; Losses0; Win Rate/PnL `null` → UI `—`. Không có production executions/candidate attempts tables trong schema bot mới; không có Position/Trading Memory schema dư thừa. Không có GATO/Dacity hoặc bất kỳ old trade nào.

`integrity_check=ok`. Six temporary fixture DB directories do tests tạo đã được cleanup sau khi xác minh target nằm dưới own `data/`; không đụng DB thật hoặc file của BOT B. [Initialization](../evidence/fresh-initialization.json), [final clean counts](../evidence/final-clean-state.json).

## F. Secret Isolation

Không tạo `.env` chứa secret và không copy giá trị credentials. Chỉ có `.env.example` rỗng về key. Config chỉ đọc `.env` trong project mới; không đọc global GMGN credential files hoặc `.env` BOT B.

| Biến | Trạng thái/yêu cầu |
| --- | --- |
| `KRONOS_GMGN_API_KEY` | REQUIRED để enable collection; không cần để start paused dashboard |
| `KRONOS_RPC_URL` | OPTIONAL; public mainnet HTTP fallback nếu thiếu; read-only `getAccountInfo` |
| `KRONOS_PORT` | OPTIONAL, default8793 |
| `KRONOS_DATABASE_PATH`, `KRONOS_RUNTIME`, `KRONOS_LOG_DIR` | OPTIONAL; phải resolve trong destination |
| `TRADING_MODE` | Default PAPER; chỉ chấp nhận `paper` |
| `GMGN_API_KEY` | NOT READ; dùng tên KRONOS riêng để tránh vô tình reuse inherited credential |
| `TYPESAFE_API_KEY` | NOT REQUIRED / NOT USED |
| `SOLANA_RPC_HTTP`, `SOLANA_RPC_WS` | NOT READ; dùng `KRONOS_RPC_URL`; không WS consumer |
| wallet/private key/mnemonic/Jupiter credentials | NOT USED |

Python nhận explicit env allowlist qua `kronosWorkerEnvironment`, chỉ candles/time qua stdin. Không nhận key, DB path/password, full process.env, signer hoặc transaction. Probe thật: đọc `.env`, file ngoài allowlist, ghi source, subprocess và socket connect đều bị chặn. [Isolation probe](../evidence/python-isolation.json).

## G. Kronos Strategy Files

```text
own GMGN rank50 / cycle120s
→ Cheap Filter → fresh Security → mint compatibility
→ closed M1 OHLCV (32–60 candles) → required current Flow sufficiency
→ native Kronos forecast → existing unanimous-terminal policy
→ WAIT / PAPER BUY → OPEN monitor → HOLD / PAPER SELL
→ observable-price fills → gross price-return PnL/MFE/MAE
```

Cap: **old BOT B source300 → new standalone200**. Đây là explicit destination-only change theo mục21/required answer23 của attachment mới; không đổi cap300 của BOT B. Cap gồm mọi retained lifecycle, không phải max OPEN hoặc batch size. Decision storage720/trial, event cap50.000, latest50 decisions/detail giữ nguyên.

Không đổi giá PAPER fills/PnL. Current Lab không có net execution-fee model hoặc real token quantity ledger; không tự thêm fee/quantity/sol balance giả khi tách. PAPER PnL là price-return với equal-notional summary semantics, không phải wallet net profit.

Discovery wait được chuyển thành tracked single-flight promise, không await nó trước OPEN/model lane. Một inference vẫn tại một thời điểm; ưu tiên entry-bearing trial và due time giữ nguyên. GMGN adapter có serialized request tail để background discovery không phá start spacing3s. Đây là thay đổi scheduling/isolation để đáp ứng yêu cầu OPEN monitor; không đổi forecast, gate hoặc entry/exit policy. Shared provider queue/network latency vẫn có thể làm chậm reads; không có deadline SLA.

## H. Removed/Disabled JEV Dependencies

Không copy Jev client, model config, queue/scheduler, prompts, TypeSafe HTTP, production Engine, trading-memory/retrieval/Runner modules. `risk.ts` trong bot mới không chứa RiskEngine: chỉ hai pure functions được Lab gọi. Một legacy outcome type string còn trong extracted type definition không tạo JEV consumer/call.

Start không có `TYPESAFE_API_KEY` đã PASS. Không có JEV fallback cho timeout/invalid model. New candidate lỗi không tạo BUY; OPEN lỗi giữ position, không fabricate SELL, retry theo policy cũ.

## I. Structure/Controlled-Markup Status

Không copy observer/Structure Evidence V3 hoặc Controlled Markup implementation vào runtime bot mới. `oneShotStructure()` không được extract từ market-history; chỉ lấy parser và attemptFlow mà actual Lab dùng. **Không gate Kronos BUY bằng hai thuật toán này.**

## J. GMGN Dependencies

Four allowlisted GET routes: `/v1/market/rank`, `/v1/token/info`, `/v1/token/security`, `/v1/market/token_kline`. Mint compatibility dùng một RPC method `getAccountInfo`. Không gọi BOT API để lấy tokens/settings/logo; listing logo có sẵn được giữ, fallback initials khi thiếu/broken. Không bổ sung logo request.

Security/cheap/history/flow/mint functions được extract từ source thật. Canonical TypeScript token comparison **16 functions đều khớp** với BOT B: parseTrending, market/security normalizers, history/attemptFlow, normalize/derive/regime Flow, mint inspector/requireCompatibleToken, cheapGuard, candle validation/decision/fill/mark/price validity. [Parity/source preservation](../evidence/isolation-final.json).

**Inherited discovery issue: YES, trong nghĩa bounded ranking coverage và appearance semantics.** Parser chung còn cap100, adapter chỉ yêu cầu/nhận top50 mỗi cycle; cap200 không bảo đảm200 unique mints. Terminal mint có thể có appearance mới theo timestamp của snapshot và được thử lại. Không có full-rank pagination/cursor bảo đảm duyệt toàn bộ thị trường. Không trộn việc sửa các semantics này vào task.

**Production queue/backpressure không được copy.** Source actual `DiscoveryCoordinator.poll()` còn chặn khi unconsumed appearances >= candidateQueueSize, và `Engine.tick()` refill lifecycle. Bot mới không dùng coordinator/Candidate queue này; nó admit whole received Lab batch rồi xử lý retained trials. Không coi việc bỏ BOT bridge là đã sửa toàn bộ discovery fairness/coverage.

## K. Kronos Model/Revision

| Thành phần | Giá trị giữ nguyên |
| --- | --- |
| Vendor commit | `67b630e67f6a18c9e9be918d9b4337c960db1e9a` |
| Model | `NeoQuasar/Kronos-small` |
| Model revision | `901c26c1332695a2a8f243eb2f37243a37bea320` |
| Tokenizer revision | `0e0117387f39004a9016484a186a908917e22426` |
| Python / torch CPU | 3.11.11 / 2.7.1+cpu |
| Horizon / sampled paths | 5 M1 / 3 |
| Seed / temperature / topP | 1701 (+sample index) /1 /0,9 |
| Inference | eval + torch.inference_mode; deterministic algorithms; CPU2threads |
| Normalization | divide by last observed close, rescale forecast; price-only optional channels disabled |

Chỉ tái sử dụng **bốn immutable public artifacts**, SHA256/bytes kiểm tra theo pinned manifest; tổng **114.823.553bytes**. Tạo bản riêng trong new `runtime/model` và `runtime/tokenizer`, không junction/symlink tới runtime BOT B. Không copy model cache/venv hoặc download lại weights không cần thiết. Python base và venv được install mới riêng trong destination; requirements hash lock giữ nguyên versions.

Regression thật: two native forecasts của cùng input/seed tương đương sau khi bỏ loadMs/latencyMs/rssBytes; old/new decision functions khớp, old Lab baseline và new Lab cho cùng action. Worker Python được copy nguyên source, pins/vendor hashes giữ nguyên. [Native regression input/results](../evidence/model-regression.json).

## L. Port Isolation

| Service | Port / transport |
| --- | --- |
| BOT B | existing127.0.0.1:3000, PID7656 |
| Lab cũ thuộc BOT B | existing127.0.0.1:8792, PID3216 |
| New BOT Kronos HTTP/UI/API | default127.0.0.1:8793, configurable |
| New Python model | stdio child, không network listener |
| WS/metrics riêng | Không có |

8793 được kiểm tra free, dùng cho fresh smoke rồi đóng. Không restart/kill hai service cũ.

## M. Runtime Path Isolation

Defaults dưới destination: `data/kronos.sqlite`, `logs/kronos.log`, `runtime/kronos.lock`, `runtime/venv`, `runtime/python`, model/tokenizer/tmp. Config/Store từ chối path ra ngoài project và kiểm tra realpath ancestor chống symlink/junction escape. Worker script resolve từ module URL, không dựa vào cwd của BOT B.

Search runtime `src/`: **0 references tới `gmgn-sniper`**; 0 BOT API bridge/TypeSafe endpoints. Tests dùng own `data/test-*`; task chỉ gửi GET đọc trạng thái BOT B. Source fingerprint **203 checked, 0 changed**, gồm source/config/public/scripts/tests/dist, `.env`, package/lock. Không build đè BOT B dist.

BOT B LIVE/Lab cũ vẫn có thể tự ghi DB hoặc giao dịch theo quyền đã bật trước task. Vì vậy xác nhận **0 task-originated mutations lên BOT B**, không tuyên bố production DB byte-immutable qua nhiều phút. [Isolation/source comparison](../evidence/isolation-final.json).

## N. UI Changes

Standalone dashboard là trang chính, identity **K1ll of BOT — Kronos**, giữ records/stats/price/PnL/MFE/MAE/times/security/status/forecast/detail history/logo. Không đưa lại các tab JEV/production execution/Memory không có consumer. Không redesign UI hoặc thay policy. Bộ đếm dùng backend limit200, reset chỉ tác động own dataset và cần confirmation, paused/idle guard.

[Fresh empty dashboard](previews/initial-empty-dashboard.png). Browser thật: errors0, unexpected requests0, collection disabled. Không có old trades trong UI.

## O. Tests

| Lệnh / kiểm chứng | Kết quả |
| --- | --- |
| `pnpm install --frozen-lockfile` | PASS, clean destination install |
| Own Python3.11.11/hashed requirements | PASS, venv riêng, CPU torch đúng pin |
| `pnpm typecheck` | PASS |
| `pnpm lint` | PASS |
| `pnpm test` | **15 passed, 0 failed/skipped**, khoảng12,8s |
| `pnpm build` | PASS, chỉ destination dist |
| Browser UI regression | PASS, intercepted fixtures; desktop/mobile/offline/stale/XSS/details/reset |
| Actual paused startup | PASS không JEV/provider keys, HTTP200, zero records |
| Python isolation probe | PASS5/5 prohibited operations blocked |
| Pure helper parity | PASS16/16 canonical functions |

Suite bao gồm cap200/no-eviction/dedupe, exact old/new policy, native forecast parity, PAPER BUY→HOLD→SELL, zero network/sign/send, fresh actual gate functions với fake GMGN/RPC, invalid model/timeout không fake trade, pending sell observable-price retry, own DB restart OPEN,200queued jobs concurrency1, slow discovery không chặn OPEN lane, strict own paths/live-mode refusal, paused server/CSRF/no execution endpoint và empty history.

Logs: [tests](../evidence/tests.log), [typecheck](../evidence/typecheck.log), [lint](../evidence/lint.log), [build](../evidence/build.log), [UI](../evidence/ui.log). Pnpm launcher Node20 engine warning; commands/tests/build dùng pinned Node22.22.0, `pnpm exec node --version` xác nhận. SQLite experimental/native optional dependency warnings không phải test failures. Không bật public market-data loop để chứng minh kết quả live.

## P. Disk Usage Before/After

| Mục | Giá trị |
| --- | ---: |
| C free trước | 2.638.061.568bytes (~2,46GiB) |
| Destination logical size checkpoint | 1.739.044.208bytes (~1,62GiB) |
| Own runtime Python/model/venv | 1.534.097.682bytes |
| Own node_modules | 202.636.554bytes |
| Extracted src / public / lab source | 87.048 /92.481 /115.598bytes |
| C free cuối | 1.036.578.816bytes (~0,97GiB) |

Logical directory bytes khác physical delta do package-store links/filesystem overhead; six test dirs đã cleanup sau checkpoint size. Không copy173MB old data hoặc1,375GB old venv. New Python vẫn cần khoảng1,4GB riêng. Đã báo dung lượng trước install; còn trống khoảng1GB cần tính khi phát triển/ghi thêm runtime history.

## Q. Remaining Shared Dependencies

Shared external services: GMGN và Solana RPC nếu user cấu hình cùng quota/key/endpoint. Shared installed tools/OS/Chrome và package-manager content cache là dependency infrastructure, không trading state. Models có own verified copies; DB/cache/cooldown/logs/lock/env/worker runtime không share mutable state với BOT B.

## R. Known Risks

- Baseline model/policy chưa được nghiệm thu profitability;3paths không là calibrated probability. Gross PAPER return không bảo đảm executable net return.
- Rate limits có thể tăng khi bot mới được user enable; independent3s spacing không là cross-bot key-wide quota lease. Không clear/bypass cooldown của bot cũ.
- Bounded top50 discovery, terminal appearance semantics và finite storage caps giữ nguyên; không khẳng định broad-market coverage/fairness.
- Shared Security/Legacy SPL authority semantics giữ nguyên; không tự sửa các findings ngoài phạm vi fork. Không hạ ngưỡng để làm data PASS.
- Exact provider/end-to-end market operation sau khi user tự cấu hình key chưa được chạy trên bot mới; đã kiểm chứng bằng fake provider pipeline và native offline model thật. Không dùng BOT B credentials để lấp chỗ thiếu.
- Collection luôn PAUSED sau start/restart; dữ liệu own OPEN được recover từ DB nhưng chỉ monitor tiếp khi user enable collection. Giữ fail-safe startup semantics của Lab.

## S. Exact Start Command

```powershell
cd C:\Users\admin\Desktop\Tool\sniper
pnpm start
```

Mở **http://127.0.0.1:8793**. Server start được dù chưa có key, collection PAUSED. Để dùng data thật, tự tạo `.env` mới theo `.env.example`, điền `KRONOS_GMGN_API_KEY` (và optional `KRONOS_RPC_URL`), start/restart **bot mới**, rồi bấm Bắt đầu paper collection. Không copy `.env` BOT B. Dừng bằng Ctrl+C.

## T. Activation Status

**READY / STOPPED**. Không listener8793 sau cleanup. Không current-data collection, không auto-enable. New active DB vẫn0 tất cả dataset tables, integrity ok. BOT B PID7656 và Lab cũ PID3216 giữ nguyên listeners3000/8792. Không real BUY/SELL/sign/submit từ tác vụ hoặc bot mới. Các giao dịch tự động độc lập của BOT B không thuộc tác vụ fork.

## Required direct answers

| # | Câu hỏi | Trả lời |
| --- | --- | --- |
| 1 | Source BOT B | `C:\Users\admin\Desktop\Tool\gmgn-sniper` |
| 2 | Destination | `C:\Users\admin\Desktop\Tool\sniper` |
| 3 | Destination thực sự rỗng? | **NO**, chỉ `.git`; đã dừng rồi tiếp tục sau user authorization, giữ nguyên Git |
| 4 | Copy BOT B SQLite? | **NO** |
| 5 | Copy WAL/SHM? | **NO** |
| 6 | Copy backup? | **NO** |
| 7 | Copy logs? | **NO** |
| 8 | Copy `.env`? | **NO** |
| 9 | Copy private key/mnemonic? | **NO** |
| 10 | Copy node_modules? | **NO**, clean frozen-lock install |
| 11 | Copy build artifacts? | **NO**, rebuild mới |
| 12 | New DB | `sniper\data\kronos.sqlite` (absolute path tại E) |
| 13 | Old trading records trong new DB | **0** |
| 14 | Old GATO/Dacity có xuất hiện? | **NO** |
| 15 | Bot mới đọc DB BOT B? | **NO** |
| 16 | Bot mới ghi runtime vào BOT B? | **NO** |
| 17 | Dùng JEV? | **NO** |
| 18 | Cần TYPESAFE_API_KEY để start? | **NO** |
| 19 | Structure V3 gate BUY? | **NO** |
| 20 | Controlled Markup gate BUY? | **NO** |
| 21 | BUY policy thay đổi? | **NO**, canonical/native parity PASS |
| 22 | SELL policy thay đổi? | **NO**, lifecycle/price/PnL policy giữ nguyên |
| 23 | Trial cap mới | **200**; BOT B vẫn300 |
| 24 | Chạy cùng BOT B không collision? | **YES**, own paths và default8793 đã smoke; provider quota vẫn có thể chung |
| 25 | Real BUY do task? | **NO** |
| 26 | Real SELL do task? | **NO** |
| 27 | Transaction signed do task? | **NO** |
| 28 | Transaction submitted do task? | **NO** |
| 29 | Restart/kill BOT B? | **NO** |
| 30 | Thay source/data BOT B? | **NO task-originated changes**;203protectedfiles unchanged; LIVE autonomous DB writes không bị đóng băng |
| 31 | Trạng thái bot mới | **READY / STOPPED**, collection chưa bật |
| 32 | Start command | `cd C:\Users\admin\Desktop\Tool\sniper` rồi `pnpm start` |
