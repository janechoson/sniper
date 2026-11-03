# Kronos BUY/SELL Paper Trading Lab — implementation

> **Cập nhật activation 2026-11-02:** Đã bật live-data paper collection tại http://127.0.0.1:8792 theo yêu cầu vận hành tiếp theo; không restart BOT trading. Xem [activation note](kronos-live-paper-activation.md). Các trạng thái “chưa bật” bên dưới mô tả thời điểm chốt implementation trước activation; discovery/settings compatibility đã được bổ sung như note.

Ngày 2026-11-02, Asia/Bangkok. Phạm vi: isolated experimental Lab, source/UI + offline actual-model validation; không activate production. [Audit trước sửa](kronos-lab-architecture-audit.md), [dependency/security inventory](kronos-dependency-security-audit.json), [verification](kronos-lab-verification.json), [actual-model replay](kronos-real-replay-results.json).

## A. Executive Summary

Đã tích hợp **Kronos-small thật**, không mock model cho replay, thành paper-only research module. Có standalone Node Lab + offline Python inference worker, cap50 trial lifecycles, deterministic forecast adapter, price-only paper positions, separate SQLite, restart recovery và tab Kronos. Không nối forecast vào Candidate/JEV/Risk/Position/executor authority của production.

397/397 automated tests PASS; browser Kronos/Log/accounting và staging build PASS. Offline walk-forward59 actual persisted GMGN M1 bars tạo28 forecasts:1 PAPER BUY,1 PAPER SELL,19 HOLD,7 WAIT,1 closed proxy trade +11.17%. **Một token/1 trade, thiếu historical security eligibility và actual token/info fill tại từng mốc: không đủ evidence nói Kronos hữu ích hoặc profitable.** Đây là technical smoke replay, không phải kết quả cohort50 trial live paper.

## B. Existing Architecture Audit

Source được đọc trước khi sửa. DiscoveryCoordinator -> Gmgn.trending/installed CLI -> OpenAPI `/v1/market/rank` -> Store/lifecycle -> Engine.analyze -> oneShotEntry. Entry thực tế gồm cheapGuard/info, fresh Security, LIVE mint compatibility, closed M1 history, attemptFlow, Structure V3/controlled-markup, JEV, Risk/final analysis, ownership/execution. Position Engine/Exit Safety V2 độc lập entry; current price từ token/info; production Store giữ wallet/execution/Position JSON trong SQLite. Server localhost có origin/CSRF; public data-view navigation.

Lab không gọi production entry/monitor/executor, không instantiate Engine/Store/JEV/Solana wallet helpers. Reuse **pure functions** `cheapGuard`, `normalizeMarket`, `normalizeSecurity`, `inspectMint`/`requireCompatibleToken`, `parseMarketHistory`, `attemptFlow`. Original config import có đọc BOT/global .env, nên isolated entrypoint phải preload blocker trước import reusable functions. Lab compatibility được kiểm bằng read-only RPC kể cả paper, không dùng production-paper SKIPPED path.

Production file thay đổi chỉ `src/server.ts` để thêm fixed-localhost relay/public-settings GET và static asset, cùng `public/index.html`, `public/app.js`, `public/style.css` cho tab. Không đổi trading implementation/config/package/lock. Hash `engine`, `one-shot-entry`, `risk`, `jev`, `executor`, `store` production và root dist giữ nguyên so với baseline task này. `scripts/accounting-ui-test.mjs` chỉ thêm asset mới vào browser route fixture.

## C. Kronos Repository / Dependency Security Audit

Đọc upstream README/requirements/model implementations; scan Python của repository cho env/network/subprocess/exec/eval/pickle/torch.load/shell/upload. Vendor chỉ `model/__init__.py`, `model/kronos.py`, `model/module.py` và MIT LICENSE. SHA256 vendor trùng source ở pinned commit, inventory trong JSON audit.

Inference package dùng torch/numpy/pandas/einops/tqdm/HF mixin. Không thấy credential/network/subprocess access trong selected model package; `sys.path.append('../')` tồn tại nên cwd được đổi sang runtime riêng, Python `-I`, file audit allowlist. Training dùng pickle/checkpoint/distributed env; examples có requests; webui có Flask POST, pip/subprocess. **Không import/chạy training, examples, webui hoặc setup scripts đó.** `eval()` là PyTorch inference state, không phải Python dynamic eval.

Upstream requirements có unpinned torch/numpy và duplicate pandas. Lab dùng inference subset riêng: Python3.11.11, torch2.7.1+cpu, numpy2.2.6, pandas2.2.3, einops0.8.1, huggingface-hub0.33.1, tqdm4.67.1, safetensors0.6.2, psutil7.0.0. **27 resolved packages** được pin version + hashes trong `lab/kronos/requirements.lock`; không cài vào Node dependencies hoặc global trading environment. Không tuyên bố đã audit toàn bộ source/vulnerabilities của PyTorch/transitive native binaries.

## D. Kronos Version + Model Revision

| Component | Pin |
|---|---|
| Repository | `shiyu-coder/Kronos` |
| Git commit | `67b630e67f6a18c9e9be918d9b4337c960db1e9a` |
| Model | `NeoQuasar/Kronos-small` @ `901c26c1332695a2a8f243eb2f37243a37bea320` |
| Tokenizer | `NeoQuasar/Kronos-Tokenizer-base` @ `0e0117387f39004a9016484a186a908917e22426` |
| Predictor context maximum |512; Lab source currently supplies32..60 valid M1 bars |
| Sampling |3 separate paths, sample_count1/call, seeds1701/1702/1703, T1.0, top_p0.9 |
| Device |CPU,2 intra-op threads,1 inter-op |

Pinned config/weight SHA256 và sizes ở `lab/kronos/model-files.json`. Model safetensors98,980,656bytes; tokenizer15,842,368bytes. Worker verifies pinned file hashes at load, instantiates audited class with local JSON config, loads safetensors state_dict strict=True. Không `trust_remote_code`, remote Python loader, pickle hoặc torch.load. No inference-time HF downloads. Pin/config changes là experiment revision mới cần review; V1 không tự chọn arbitrary remote model ID từ UI.

Sources: [pinned official README](https://github.com/shiyu-coder/Kronos/blob/67b630e67f6a18c9e9be918d9b4337c960db1e9a/README.md), [pinned predictor](https://github.com/shiyu-coder/Kronos/blob/67b630e67f6a18c9e9be918d9b4337c960db1e9a/model/kronos.py), [model revision](https://huggingface.co/NeoQuasar/Kronos-small/tree/901c26c1332695a2a8f243eb2f37243a37bea320), [tokenizer revision](https://huggingface.co/NeoQuasar/Kronos-Tokenizer-base/tree/0e0117387f39004a9016484a186a908917e22426).

## E. Isolation Architecture

```text
Production BOT -- read-only cached discovery/settings HTTP --> Node Kronos Lab
                                                           separate SQLite
GMGN GET + RPC getAccountInfo ------------------------------> bounded collector
                                                                  |
                                                      public candles + time only
                                                                  v
                                                    Offline Python worker stdin
                                                      forecast JSON stdout
                                                                  |
                                                           paper state only
```

Node Lab binds127.0.0.1:8792. No public endpoint/CORS; host+origin+CSRF protect POST. Production relay fixed to127.0.0.1:8792,2s timeout, bounded response; no arbitrary target. Lab not spawned by production server. Only opening Kronos tab polls relay every5s.

Python child gets **explicit env allowlist**, not process.env. No GMGN/JEV/Jupiter credentials, wallet address/balance, private key, mnemonic, DB payload or transaction. Receiver clears unexpected env names too; `PYTHONHASHSEED` is a non-secret reproducibility setting. Dedicated HOME/cache/TEMP, isolated cwd, `-I -B`, local files. Standard Python audit hook denies file access outside source/runtime/interpreter allowlist, secret filenames, writes outside scratch, network connections/binds and subprocess. Probe verified `.env`/outside reads, source writes, network and subprocess denied.

**Actual boundary:** separate same-user local processes + application audit hook, **not an OS/container sandbox against hostile native code**. Native torch/safetensors/psutil/interpreter remain trusted; kernel ACL does not revoke every same-user read permission. Docker CLI exists but daemon unavailable, no container isolation was claimed/tested. No home/wallet/.env mount. Node entrypoint checks mandatory preload marker before dynamic parser/config import, so accidental unsafe launch stops first. Parser preload returns empty for BOT/global credential reads; collector receives only an explicitly supplied Lab GMGN read key. Python receives no key. User .env/private-key contents were not read by implementation.

## F. GMGN → Kronos Pipeline

Lab GETs existing BOT `/api/tokens`, selects fresh TRENDING evidence, max50 rows. No second broad GMGN scanner. Appearance uses mint + actual Trending sequenceStartedAt (fallback actual discoveredAt); stable sequence cannot create repeated trials. Closed/rejected mint can re-enter on a genuinely new appearance with quota remaining.

```text
Fresh trial ID / actual public metadata
 -> CHEAP_FILTER -> fresh SECURITY -> RPC COMPATIBILITY
 -> HISTORY -> CAPITAL_FLOW input sufficiency
 -> Kronos forecast -> transparent policy -> WAIT / PAPER_BUY
 -> OPEN -> new closed M1 -> forecast -> HOLD / PAPER_SELL
```

Lab collector uses only existing GMGN GET routes `/v1/token/info`, `/v1/token/security`, `/v1/market/token_kline`, same installed client auth contract X-APIKEY + timestamp + client_id. Fixed allowlist, no signing helper/CLI/write route. Global spacing3s, one active Lab job,20s read timeout,429 cooldown120s; discovery refresh120s. Shared API quota can still contend with production; operator can pause Lab. No claim of provider capacity SLA.

## G. Security Gates Reused

Reads active **public strategy settings** through new GET `/api/kronos/settings`. Reuse cheapGuard invalid mint/age/price/liquidity checks; enforce existing minLiquidityUsd. Fresh normalizeSecurity rejects critical honeypot/cannot-sell/rug/tax/active controls; unknown mint/freeze controls do not pass. RPC `getAccountInfo` -> exact mint layout/program/extensions and decimals equality with market. No balance/wallet methods.

History and flow must be sufficient/fresh. READY current-flow inputs are eligibility, **not** an extra bullish/bearish decision rule; negative flow alone does not decide Lab action. Dedicated holder-list/Risk/JEV/quote execution checks are not invoked; this is the requested pre-Kronos gate subset, not a claim that full production Risk approval occurred. Security older than45s at proposed BUY fails closed; a fresh post-decision price is mandatory. A rejected/security-incomplete trial counts, with zero inference if failed before Kronos.

## H. Structure V3 Replacement Semantics

Lab does not call Structure V3, controlled-markup or JEV as qualification/exit authority. No Smart Money inference/gate. Production functions remain intact. Test computes actual Structure V3 failure on flat bars and still proves Lab PAPER_BUY when forecast qualifies and Lab gates pass. Shadow comparison is not enabled to avoid extra calls/attribution ambiguity.

## I. Kronos Input Schema

Only `{candles:[{at,open,high,low,close}],decisionAt}` enters worker.32..60 completed contiguous aligned M1 bars; no duplicate, missing interval, nonpositive price, inconsistent OHLC, NaN/Infinity, partial/future candle. Parser retains provider timestamps, sorts/dedups as before, clips token creation, no synthetic timeline/padding. Missing pre-creation remains NOT_AVAILABLE. Young token with<32 valid bars is insufficient, not padded.

Store actual history source/request60m/available bars/coverage/from/to/tokenAge/creation/freshness/diagnostics including real USD volume externally. Worker **price-only optional-channel mode**, supported by upstream. GMGN volume is not silently relabeled token quantity; amount not invented. Upstream's optional missing volume/amount channels become disabled zeros inside documented price-only API, **not filled historical price candles**. Both channel disablement and limitation are explicit in every forecast.

All prices divided by last observed close before predictor, then output multiplied by same scale, to avoid tiny meme prices being dominated by upstream1e-5 normalization epsilon. This does not change market units. Timestamp features use UTC. Record inputFrom/inputTo/decisionAt/latestClosedCandleAt; latest closed end<=decisionAt; forecast target timestamps are generated schedule only, not future observed data.

## J. Kronos Forecast Output

Native predictor returns forecast OHLC/volume/amount DataFrame and internally averages sample_count. Wrapper separately calls sample_count1 three times and stores **close paths**, target timestamps, input bounds, scale, model/revisions/commit, sampling config, eval/inference flags, load/latency/RSS and limitations. Bound is3×5 prices, not giant tensors. Other native output columns are not used as invented decision evidence.

Explicit `model.eval()`, `tokenizer.eval()`, `torch.inference_mode()` and deterministic algorithm/seed settings. Repeated actual inference on same input/config returned identical paths on this CPU environment. Portability across hardware/torch releases is not guaranteed. Min/max three terminal samples describe dispersion, **not calibrated probability/confidence**.

## K. BUY Decision Policy

Frozen before replay: horizon5 M1 steps; if **every sampled terminal close > last observed close**, PAPER_BUY candidate. Otherwise WAIT. No magic score, percentage stop or future outcome tuning. Must still have gates PASS, valid input/model pin and timely inference, fresh eligibility, no open duplicate mint and fresh observed post-inference price. Forecast never becomes entry fill price. WAIT reevaluates only new closed candle after bounded cadence.

## L. SELL Decision Policy

For OPEN: **every terminal close < last observed close** -> PAPER_SELL; disagreement/flat/higher -> HOLD. Current PnL/fees/position age do not trigger SELL. No JEV interpretation. Model error/timeout -> explicit UNAVAILABLE/error, OPEN remains OPEN, market monitoring continues. Never fabricate a failure-driven exit or report failure as affirmative model HOLD.

## M. Paper Price Semantics

Live paper entry/exit use fresh GMGN token/info **after inference decision**, recording value/source/local observedAt + separate decisionAt. No quote, forecast price or future candle used. Current snapshot freshness is local request completion semantics, not proven provider publish latency. Entry price unavailable -> ERROR/BUY_PRICE_UNAVAILABLE with no entry. Exit unavailable -> SELL_DECIDED_PRICE_PENDING, retry price5s under45s decision freshness; expired intent returns to OPEN and requires new inference. Normal model cadence>=60s/new closed bar.

Historical smoke replay cannot reconstruct post-inference token/info. Its separately labeled completed-bar close marks are proxies, stored outside live Lab dataset and **not** reported as actual paper fills from current info. Live metrics start empty until real collection is enabled.

## N. PnL / MFE / MAE Semantics

Open return=(fresh current/entry−1)×100; closed=(exit/entry−1)×100. MFE/MAE are best/worst **observed** prices since entry, not all intraminute highs/lows. Stale current price hides current return, with STALE indication; historic extrema remain recorded. No fee, ATA rent, network fee, slippage or fake Jupiter cost. Wallet/SOL balance untouched.

WIN>0, LOSS<0, FLAT=0. Win rate=wins/all closed including flats, excludes OPEN/rejected/error. Average/median/total use closed returns only. Total is sum of equal virtual-notional price returns, not compounded portfolio return or SOL cash PnL; UI states this. No fabricated growth percentages. Empty denominator -> null/“—”.

## O. 50 Record Limit

One record=one independent trial lifecycle, including REJECTED/ERROR/WAIT_BUY/OPEN/CLOSED. Database transaction prevents51st insertion. No eviction/cherry-picking. One active/OPEN/pending lifecycle per mint; repeated same appearance does not duplicate. Same closed/rejected mint requires new appearance and available quota.

Per trial up to720 persisted decisions; at cap inference pauses explicitly (`DECISION_STORAGE_CAP_INFERENCE_PAUSED`), current-price monitoring continues for OPEN. No automatic history deletion. Events capped50,000/dataset, no old event deletion; decision records remain separately persisted. Detail returns newest50 decision rows for bounded UI, DB retains earlier rows. Reset is Lab-only, requires pause/no active work and exact confirmation string.

## P. Persistence / Restart Recovery

`KronosStore` is independent SQLite schema `lab_trials`, `lab_decisions`, `lab_events`, `lab_meta`, in external runtime, no production migration. Atomic decision+trial commit; unique ID/appearance; historical decisions retained. Restart existing OPEN with same entry/last input bound; CLOSED stays terminal, no real wallet reconciliation. Every service startup is PAUSED even when last run collected, so operator explicitly resumes.

Dedicated process lock prevents two Lab writers. Crash can leave Lab lock; operator must verify its PID is no longer running before removing **that Lab lock only**. No auto-kill/restart of any trading process. Reset deletes only Lab tables and watermark/meta; production Positions/history/Memory/logs unaffected.

## Q. UI Kronos Tab

Added navigation beside Trading Memory; no other tab redesign. PAPER ONLY header/permanent warning, honest summary incl median/MFE/MAE/hold time, records table with token/status/security/decision/prices/return/times. Unknown metadata uses Unknown Token/short mint; no fabricated logo. Detail JSON includes discovery, stage evidence, model/input/sampling and latest50 decisions. Forecast diagram has dashed labeled sample paths and observed last-close reference; does not draw forecasts as historical observations.

Enable/pause/reset controls use existing BOT CSRF plus independent Lab token/origin checks. Offline disables controls; no production fallback action. Screenshots are browser fixtures: [desktop](previews/kronos-lab-desktop.png), [mobile](previews/kronos-lab-mobile.png). Not production trading captures.

## R. Resource Usage

Measured actual CPU inference on same machine: first synthetic smoke load12.43s,3-path forecast0.55s,RSS374MB. A later28-inference replay under concurrent test/build load recorded load37.82s,p50≈0.894s,p95≈1.302s,observed maximum RSS≈356.9MB (decimal). Latest isolated rerun: load5.90s, p500.824s, p951.092s, RSS356.2MB. Exact **latest replay** metrics are in JSON artifact; numbers vary with contention and cold cache, not a production SLA.

One active job/inference worker, two CPU threads; Node Lab and Python request below-normal priority best effort. Python checks available system RAM>=1GiB before request; observed RSS soft limit768MiB after inference;90s timeout kills only owned worker. These are **soft/application limits**, not OS memory/cgroup quotas. Input/output/history/queue bounded. OPEN records prioritized; many OPEN positions can delay new trials, cadence60s is minimum spacing, not a50-position SLA. No production monitor awaits model.

Machine initially lacked usable Python/GPU tooling, Docker daemon unavailable. Installed dedicated CPython/venv and pinned CPU wheels with uv no-cache; model downloads are public pinned HF URLs. Disk free after setup about540MiB; no unrelated user data deleted. Dataset caps matter; do not treat remaining disk as unlimited. No GPU used/measured.

## S. Tests

| Check | Result |
|---|---|
| `pnpm typecheck` |PASS |
| `pnpm lint` |PASS |
| `pnpm test` |397 passed,0 failed/skipped/cancelled |
| `tests/kronos-lab.test.ts` |12 focused cases PASS |
| `pnpm exec node scripts/kronos-ui-test.mjs` |PASS desktop/mobile, metrics/unknowns/stale/offline/XSS, detail/forecast labels and reset confirmation |
| `pnpm exec node scripts/kronos-service-smoke.mjs` |PASS standalone PAUSED localhost service, TEMP DB, CSRF/reset,0 GMGN reads |
| Log and accounting browser suites |PASS; no production server/provider calls |
| `pnpm exec tsx scripts/kronos-replay.ts` |Actual pinned offline model, reproducible paths, isolation probes,28 walk-forward forecasts |
| TEMP staging `pnpm build` |PASS; exact build id/path in verification |

Full paper lifecycle mocks Executor.execute, Jupiter execution, transaction.sign, Connection.sendTransaction, production analyze/processExits: **all0 calls**. Tests cover security no inference; actual Structure V3 failure does not gate Lab; >50 attempts/no eviction; duplicate mint/appearance; future/partial/gap/invalid inputs; transparent direction adapter; missing/stale/future fill prices; +10%/−20%/MFE/MAE; HOLD; model failure/open retention; pending exit price; restart; bounded50-job scheduler and responsive heartbeat; environment names and pin consistency; real reusable safety gates with mocked GET/RPC responses. Existing production tests unchanged except browser asset allowlist.

Model eval/reproducibility verified against actual local weights, not a fake model. Python application isolation probe performed actual denied attempts without reading secret bytes. All test logs in TEMP; no generated audit/test logs added to production data directory.

## T. Historical Replay Results

Selected most recent suitable timeline among bounded200 persisted LIVE candidate attempts, solely by>=36 consecutive valid M1 bars, before inspecting forecast outcomes. Read via `DatabaseSync({readOnly:true})` + `PRAGMA query_only=ON`; never production Store/Engine. Extracted59 actual OHLC bars with identities omitted in `kronos-replay-input.json`. Existing summaries-only audit artifact was insufficient for full replay, so no fake intermediate candles were synthesized.

28 decisions use prefixes32..59 only.1 BUY,19 HOLD,1 SELL,7 WAIT. One closed proxy trade: +11.1700%, observed MFE+11.1700%, MAE−11.9906%,20m hold, no open at end. Same-window close-proxy buy-and-hold≈+11.0331%. A single tiny-window comparison is **not evidence of superiority**; cohort eligibility, latency-adjusted current-price fills, costs/routes and held-out validation are absent. No tuning on this result; policy was written before replay. Dataset record count for future live paper remains0.

## U. Remaining Limitations

- No demonstrated edge on Solana meme M1; small selected replay is technical validation only. Need prospective eligible trials and broader held-out comparisons.
- Price-only mode deliberately discards optional volume channels; no silent USD/token conversion. Context limited to actual existing GMGN60m, minimum32 bars excludes younger tokens/fragmented history.
- Three stochastic seeded sample paths are not calibrated uncertainty. Model trained broadly, not validated for this token universe; normalized close prediction does not guarantee executable return.
- Python audit hook is not a hardened hostile-native-code sandbox; pinned native dependencies are trusted. Stronger container/OS account isolation would require a separately provisioned runtime; none claimed here.
- GMGN/RPC integration uses actual routes/reused logic but new live provider probes/collection were **not enabled**. API entitlement/shared quota and publish lag remain operational risks; spacing/cooldown bound Lab reads but cannot reserve production quota.
- Startup load varies; below-normal priority/soft memory limits do not guarantee zero system contention. Scheduler one active job and OPEN priority can delay other trials/observations; MFE/MAE reflect observations only.
- Paper returns omit real execution costs/route failures. No auto partial/stop-loss/protective/security exit rule is hidden in Kronos decision, no JEV attribution mixing.
- Decision/event caps halt further collection components explicitly; no automatic reset/retention deletion. Disk remaining is limited. Process crash lock may require operator review.

## V. Activation Status

**Source complete and staging build verified; current LIVE not restarted/killed; root dist not overwritten. Current-data paper collection not enabled.** Python/weights prepared outside workspace. Standalone smoke used only TEMP DB and remained PAUSED. No model service left running by tests.

Operator steps when choosing a deployment window:

1. Deploy current backend/UI through normal controlled process; new `/api/kronos/settings` and relay require backend source to be loaded. Do not build root dist while LIVE may use it. This task did not apply previous pending SELL Safety V2 changes to LIVE either.
2. From workspace use Node22 through pnpm. Dedicated runtime already prepared here: `%LOCALAPPDATA%\gmgn-kronos-runtime`. For another machine install Python3.11.11/venv with uv, then sync the hashed inference lock using CPU index. Prepare pinned public model files separately; never copy BOT .env/wallet directories into runtime.
3. Supply **only** explicit `KRONOS_GMGN_API_KEY` read credential, optional `KRONOS_RPC_URL`, `KRONOS_BOT_PORT` (default3000), `KRONOS_RUNTIME`. Do not place wallet secrets in these settings. Key value is not included in report or commands below.
4. Run the standalone entrypoint; it starts PAUSED. Open Kronos tab and explicitly enable paper collection after checking runtime/provider/resource status.

```powershell
# Fresh-machine preparation; on this machine the environment/weights already exist.
$runtime = Join-Path $env:LOCALAPPDATA 'gmgn-kronos-runtime'
$env:UV_PYTHON_INSTALL_DIR = Join-Path $runtime 'python'
uv python install 3.11.11 --no-cache
uv venv --python 3.11.11 --no-project --no-cache (Join-Path $runtime 'venv')
uv pip sync lab/kronos/requirements.lock --python (Join-Path $runtime 'venv/Scripts/python.exe') --extra-index-url https://download.pytorch.org/whl/cpu --index-strategy unsafe-best-match --require-hashes --no-cache
pnpm exec node scripts/kronos-prepare.mjs $runtime

# Read key supplied separately via KRONOS_GMGN_API_KEY; no .env sourcing.
pnpm exec node --import ./scripts/kronos-env.mjs --import tsx ./src/kronos-server.ts
```

Do not rerun venv creation unnecessarily over an existing environment. Copy/deploy `lab/kronos` pinned sources/manifests with project; production build itself emits TypeScript only. Python has no network at inference, so prepare weights before model worker starts. Reset exact phrase `RESET KRONOS PAPER EXPERIMENT`, via confirmed UI, touches Lab dataset only.

## 30 câu trả lời bắt buộc

1. **Process nào?** Separate Node Lab:8792 và its offline Python child; không Engine/signer process.
2. **Đọc BOT .env?** Standard Python file APIs bị audit hook từ chối, probe PASS; Node parser preload chặn credential reads. Không có OS/native adversary isolation guarantee.
3. **Nhận private key/mnemonic?** Không.
4. **Forward toàn process.env?** Không; explicit allowlist, receiver clears extras.
5. **trust_remote_code=True?** Không; local audited classes + safetensors.
6. **Pin revision?** Git67b630e67f6a18c9e9be918d9b4337c960db1e9a; model901c26c1332695a2a8f243eb2f37243a37bea320; tokenizer0e0117387f39004a9016484a186a908917e22426; hashed deps/weights.
7. **Explicit eval?** Cả model/tokenizer + inference_mode; repeated actual output reproducible here.
8. **Tối đa record?**50 total lifecycles, gồm reject/error; không eviction.
9. **Security stages?** Cheap/age/price/liquidity + configured minimum; fresh security/controls/honeypot/tax/rug; read-only RPC mint/program/extensions/decimals; history/flow sufficiency.
10. **Structure V3 block Lab BUY?** Không.
11. **Production Structure V3 đổi?** Không, hash unchanged.
12. **Bao nhiêu nến?**32..60 actual contiguous closed M1; predictor supports512 but current source does not provide512.
13. **Future leakage?** Prefix-only replay, parser/Node/worker reject future/partial candles; future timestamps are forecast schedule only.
14. **Native output?** Predicted OHLC/volume/amount dataframe; wrapper retains3 close paths, không native BUY/SELL.
15. **PAPER_BUY adapter?** All3 terminal closes above observed close + gates/freshness + actual observable price.
16. **PAPER_SELL adapter?** OPEN and all3 terminal closes below observed close; otherwise HOLD; no PnL stop.
17. **BUY price?** Fresh post-decision GMGN token/info; missing -> no entry.
18. **SELL price?** Same source; missing -> pending with expiry, not forecast fill.
19. **PnL?** Price ratio return×100, extrema from observed prices; closed metrics only for win rate/average.
20. **Fees/slippage?** Không, explicit price-only paper warning.
21. **Duplicate open mint?** Không; active lifecycle duplicate excluded and one Lab writer locked.
22. **Timeout ảnh hưởng production?** No trading authority/path; owned worker stopped, Lab error, production does not await it. Shared system resources/provider quota still matter.
23. **Bounded concurrency?**1 active inference/job, queue<=50 trial records,2 model CPU threads,90s timeout.
24. **Restart duplicate BUY?** No: persisted entry/state/input bound, startup PAUSED, same OPEN resumes; fixture PASS.
25. **Jupiter swap từ Lab?** Không,0 calls in full paper lifecycle test.
26. **Sign transaction?** Không.
27. **Submit transaction?** Không.
28. **Wallet balance đổi?** Không đọc/reserve/debit wallet cho Lab.
29. **Replay?**59 bars/28 forecasts/1 closed proxy trade+11.17%, with missing eligibility/current-fill limitations; not live cohort results.
30. **Đủ evidence hữu ích?** Chưa; cần prospective eligible sample + held-out comparison, không kết luận từ1 trade.

## Safety report

```text
Kronos real BUY: NO
Kronos real SELL: NO
Jupiter execution called by Kronos: NO
transaction signed: NO
transaction submitted: NO
private key passed to Kronos: NO
mnemonic passed to Kronos: NO
production wallet modified: NO
production trading logic modified: NO
LIVE restarted/killed: NO
```

Documented non-trading integration: server fixed-localhost relay/public settings/static asset + new UI tab. `.env`, production secrets, trading config/package/lock/root dist unchanged. Production DB read-only for bounded historical extraction; no migration/reset/writes by task. Existing tests may create ephemeral fixture keypairs; no production private key or transaction signature. No profitability or absolute hostile-native-code isolation claim.
