# Temporary Recovery guard bypass

**Ngày:** 30/10/2026 — Asia/Bangkok. **Đã bật flag cấu hình; bot vẫn dừng, không bật LIVE, không BUY/SELL thật.**

Build kiểm chứng: `0aab3d21387e3c98ed09c618266e6269a1714906e23e1f40d6d11d860c07dea6`.

## Phạm vi và boundary

Theo xác nhận bổ sung của user, RiskEngine chỉ được thay predicate Recovery trong EXECUTION để hiểu cùng temporary flag. Các kiểm tra Risk khác giữ nguyên.

Flag duy nhất là **`TEMP_BYPASS_RECOVERY_GUARD`**, đọc tại [recovery-guard.ts](../src/recovery-guard.ts). Giá trị unset/khác `true` đều tắt bypass. `.env` hiện có:

```dotenv
TEMP_BYPASS_RECOVERY_GUARD=true
```

Không bypass ở **PRE_WATCH**. Candidate vẫn phải qua Security, Compatibility, Flow, Memory, Jev và Risk PRE_WATCH để được admit. Sau đó cần ít nhất observation thật đủ dữ liệu để Watch có quality FRESH; UNKNOWN/STALE không được nâng thành fresh để đi tiếp.

Boundary thay đổi là **promotion từ Watch sang fresh execution pipeline** và cùng predicate Recovery khi được kiểm tra lại ở Risk EXECUTION / final validation / immediate pre-sign. Không gọi EXECUTION bằng phase PRE_WATCH để lách guard.

```text
Security / Compatibility / Flow / Memory / fresh Jev / Risk PRE_WATCH
→ Watch admitted, T0/T1 thật
→ observation lane tiếp tục collect/update evidence thật
→ real Recovery PASS
    hoặc TEMP Recovery bypass hợp lệ
→ fresh Security / Compatibility / Flow / Memory / Jev
→ fresh info / Security / holders / Risk EXECUTION
→ fresh capital, ownership, intent/claim
→ fresh Jupiter BUY quote
→ 20/50/100 exit probes và bound Exit Feasibility gate
→ validation / simulation / final Risk / wallet checks
→ immediate authority + Recovery predicate check
→ sign / persist / submit / reconcile như trước
```

Quote vẫn đứng trước exit probes vì report cần expected BUY output và buyQuoteHash. Không sửa thứ tự hoặc validators của Executor/Jupiter.

## Predicate chính xác

Chỉ thay yêu cầu **real Recovery confirmation** bằng:

```text
realRecoveryConfirmed OR validTemporaryRecoveryBypass
```

`validTemporaryRecoveryBypass` yêu cầu cùng flag đang true, Watch mới đã được admit theo policy hiện tại, status ACTIVE, T0 hợp lệ, còn trong deadline gốc, evidence FRESH/không tương lai/không quá max-gap, cùng Watch và authority revision. Không nhận legacy/unadmitted, EXPIRED, INVALIDATED hoặc USER_REMOVED Watch. Snapshot phải có metadata bypass gắn đúng Watch/revision; chỉ flag true đơn độc không phải transaction authorization.

Đây là thay final outcome gate: Watch ACTIVE/fresh có thể đi tiếp dù các pha hành vi chưa hoàn thành. **Các pha không bị đổi thành hoàn thành.** Thuật toán vẫn quan sát Bán → Hấp thụ → Hỗ trợ → Phục hồi và có thể đạt PASS thật theo logic cũ. Không thêm universal drop/recovery %, không sửa confirmations hoặc deadline 10 phút.

Temporary promotion chỉ áp dụng candidate đang STRUCTURE_WATCH; không kéo candidate đang DEFERRED hoặc downstream retry/backoff sang execute sớm. Không tạo concurrent entry mới cho candidate đang QUEUED/ANALYZING/QUALIFIED/APPROVED. Observation vẫn tiếp tục cho Watch chưa owned theo lane chung hiện hữu; sau BUY/pending, ownership/Position lifecycle xử lý như trước. UI loại Watch đã owned khỏi active entry list mà không giả đổi Watch thành PASSED.

## Safety giữ nguyên

- Security findings/missing critical evidence, token compatibility/decimals/extensions và F01/F02-related checks không được thay hoặc bỏ qua. Findings F01/F02 đã biết không được coi là đã sửa bởi flag này.
- GMGN quality; market/Security/Jev/holder freshness; concentration; Jev BUY/data sufficiency/risk/suspiciousness; liquidity và cheap filter vẫn bắt buộc.
- Entry enable/ACK/mode, ownership, duplicate Position/intent, current revision/tombstone/path, capital/reserve/exact sizing và pending-signature freeze vẫn bắt buộc.
- Fresh quote identity/age/slippage, Exit Feasibility, transaction inspection, unsigned simulation, wallet delta và final validation giữ nguyên.
- Immediate pre-sign vẫn chạy common Executor guards và Store/Engine authority checks; chỉ nhánh yêu cầu real Recovery nhận alternative temporary proof. Tắt flag, remove, stale data hoặc hết hạn trước sign đều chặn unsigned entry.
- Không sửa SELL, Position monitoring, PnL/MFE/MAE, UNKNOWN/reconciliation, Memory/Runner implementation hoặc 10-minute observer.

Đối chiếu source: toàn bộ phần Risk bắt đầu từ `if (!ctx.entriesEnabled)` đến trước `approve()` giống bản trước sửa; phần Engine từ `monitor()` đến trước `status()` cũng giống. Executor/Jupiter/Solana/Security/Flow/Jev/Memory/Runner và toàn file sniper-structure.ts không đổi. [Preservation](../data/temp-recovery-preservation.json).

## Logs, UI và metadata

Mỗi lần dùng temporary promotion/fresh-pipeline gate ghi:

```text
[TEMP] RECOVERY_CONFIRMED guard bypassed
```

Risk EXECUTION khi dùng alternative predicate ghi:

```text
[TEMP] Risk EXECUTION Recovery guard bypassed
```

Log bypass không đồng nghĩa mọi Risk check đã ALLOW; những check phía sau vẫn có thể DENY. Candidate promotion dùng reason **`TEMP_RECOVERY_BYPASS_FRESH_PIPELINE_REQUIRED`**, không dùng reason real Recovery PASS.

UI hiển thị **TEMP RECOVERY BYPASS** khi temporary gate khả dụng. Rail/checkmarks vẫn chỉ lấy evidence thật. Không đổi status thành PASSED, phase thành ENTRY_ELIGIBLE hoặc tạo confirmedAt/sellingSeen/supportConfirmed/recoveryCount giả. Các log có cụm RECOVERY_CONFIRMED chỉ mô tả rõ *guard bypassed*, không phải evidence confirmation.

Metadata được bind vào Snapshot và immutable intent:

```text
entryAuthority.recoveryBypass = {
  kind: TEMP_RECOVERY_BYPASS,
  promotedAt,
  watchStartedAt,
  watchExpiresAt,
  authorityRevision
}
```

Có thể đối chiếu tại execution.intent.entryAuthority và `trade_learning_samples.payload.snapshot.entryAuthority.recoveryBypass`, cùng snapshotHash của approval. Trading Memory tự lưu full Snapshot theo implementation cũ: snapshot Structure vẫn là ACTIVE/chưa confirmed nếu đó là evidence thật tại entry. Không sửa Memory để dựng một Recovery PASS.

Trade có fill thực vẫn được lưu/accounting/outcome theo logic cũ, kèm provenance này; task không thêm chính sách loại bỏ toàn bộ bypass trades khỏi statistical retrieval. Không tạo sample/outcome giả chỉ vì promotion hoặc unsigned failure. [Test immutable metadata](../tests/temp-recovery-bypass.test.ts).

## Bật, tắt và rollback

**Bật:** `.env` đặt `TEMP_BYPASS_RECOVERY_GUARD=true`.

**Tắt:** đổi đúng dòng đó thành:

```dotenv
TEMP_BYPASS_RECOVERY_GUARD=false
```

Environment được nạp khi process khởi động, nên **restart ứng dụng để đọc thay đổi file `.env`**. Không cần sửa nhiều gate, đổi DB hoặc rebuild thuật toán. Một process đang chạy không tự hot-reload file `.env`.

Khi effective flag=false, các alternative predicates đều false: promotion, Risk EXECUTION và pre-sign lại yêu cầu real timely RECOVERY_CONFIRMED cùng các guard cũ. **YES — entry policy trở lại như cũ**, đã kiểm chứng bằng các regression Structure Watch hiện hữu và tests OFF/ON/OFF riêng. Không xóa metadata/log lịch sử hoặc hủy giao dịch đã ký/gửi; recovery của signed execution vẫn là trách nhiệm cũ.

## Kiểm chứng

| Kiểm tra | Kết quả |
| --- | --- |
| `pnpm test` | **277 passed, 0 failed, 0 cancelled, 0 skipped**; 109.094,9251ms; [log](../data/temp-recovery-tests.log) |
| `pnpm typecheck` | **PASS**, exit 0; [log](../data/temp-recovery-typecheck.log) |
| `pnpm lint` | **PASS**, exit 0; [log](../data/temp-recovery-lint.log) |
| `pnpm build` | **PASS**, exit 0; [log](../data/temp-recovery-build.log) |
| Full UI regression | **PASS**, exit 0 khi chạy lại tuần tự; [log](../data/temp-recovery-ui-retry.log) |
| Watch browser verification | **PASS**, exit 0; 76px desktop rows, 1440/1024/390, 0 browser errors; [evidence](../data/temp-recovery-ui-verification.json) |
| Secret audit | **1.268 files, 0 findings**; [log](../data/temp-recovery-secrets.log) |

Giữ nguyên các tests Structure Watch cũ. `scripts/test-env.mjs` đặt **cùng flag** về false cho baseline; suite mới bật/tắt effective flag riêng trong fixtures, không dùng flag thứ hai.

37 tests mới kiểm chứng OFF/chưa Recovery → DENY; ON/bound proof → đi tiếp; Security/concentration/capital/duplicate/entries/Jev/compatibility/freshness/revision/admission/status sai vẫn DENY; marker không bind thì DENY; không mutation/fake PASS. Engine integration dùng fake RPC/provider và chặn network, đi qua quote/probes/simulation thật ở cấp orchestration; Memory snapshot/intent giữ tag và evidence ACTIVE. Exit policy fail, simulation fail, remove, flag OFF hoặc expiry tại pre-sign đều có 0 fake sign/submit. Observer tăng observations khi ON, TTL giữ nguyên, retry/backoff không bị override.

Một lượt UI chạy song song bị Node native OOM; giữ [log lỗi](../data/temp-recovery-ui.log). Chạy lại tuần tự đã PASS; không sửa source để che lỗi đó. Tests có mode LIVE chỉ là RAM/fake-provider fixtures, không phải ký hoặc gửi blockchain thật. Không chạy provider smoke/verification thật.

## Files thay đổi

- `.env`: thêm duy nhất key temporary flag=true; phần cấu hình khác giữ nguyên.
- `src/recovery-guard.ts`: một config getter, temporary eligibility/proof/binding và shared Recovery authorization helper.
- `src/domain.ts`: optional provenance trong entryAuthority; JSON schema hiện hữu, không migration.
- `src/candidate-lifecycle.ts`: promotion nhận reason riêng; default real-Recovery reason giữ nguyên.
- `src/engine.ts`: promotion/fresh execution/recheck/pre-sign Recovery alternative, log và entry UI projection.
- `src/risk.ts`: đúng Recovery predicates EXECUTION và log, theo permission bổ sung của user; các Risk checks khác giữ nguyên.
- `public/app.js`: TEMP badge/tooltip; không fake progress.
- `scripts/test-env.mjs`, `tests/temp-recovery-bypass.test.ts`, `scripts/sniper-ui-cases.mjs`: baseline/regression/UI tests.
- Báo cáo và evidence/backup source trong data/temp-recovery-*.

## Trạng thái cuối

**Flag cấu hình true, bot không chạy, không bật LIVE, không có BUY/SELL thật.** Actual active DB và provider-state DB giữ nguyên hash so với trước task; không ghi thêm trade/Watch/learning vào dataset production. Checkpoint: [runtime](../data/temp-recovery-runtime-final.json).
