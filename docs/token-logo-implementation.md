# GMGN token logos — metadata/UI audit and implementation

Ngày2026-11-02, Asia/Bangkok. Scope chỉ public metadata/presentation. Không restart/kill BOT LIVE hoặc Kronos đang chạy, không sửa `.env`/secrets, không thao tác BUY/SELL/sign/submit. Baseline: `token-logo-baseline.json`; kiểm tra: `token-logo-verification.json`.

## Audit thực tế trước sửa

Đọc parser, discovery merge, Store, API, avatar renderers và CSP. Read-only localhost snapshots: `/api/tokens` có250 token,0 top-level logo,249 `listing.logo`;248 URL ở `https://gmgn.ai/external-res/`,1 ở `https://pump.mypinata.cloud/ipfs/`. `/state` Kronos có50 records,0 logo. Không gọi GMGN OpenAPI để audit/logo.

| Layer | Trước sửa | Sau sửa |
|---|---|---|
| GMGN Trending `rank[].logo` | Giữ trong raw listing, không root field | Validate và preserve `Candidate.logo`; listing vẫn có cùng metadata |
| Legacy listing/trenches row.logo | Whitelist listing bỏ logo | Preserve root/listing logo |
| Discovery merge / Store | Candidate chưa khai báo logo; legacy raw listing có | Refresh logo hợp lệ mới; missing/invalid không xóa valid cũ; đọc legacy hydrate root không migration |
| Tokens API | Đã trả listing.logo | Có root `logo: string|null` nhất quán |
| Position/History API | Không join logo vào identity projection | Join Candidate metadata hiện có theo mint, không đổi Position/accounting |
| Overview/Positions/Flow | Chủ yếu render initials | Shared avatar helper ưu tiên ảnh, fallback initials |
| Log | Có nhánh img nhưng chỉ same-origin | Dùng shared helper, bỏ same-origin-only restriction trong renderer |
| Kronos | Discovery selector/lifecycle/store input bỏ logo | Preserve logo qua discovery → trial JSON → state/API → table/detail |
| CSP | Main img-src self; Lab default-src self chặn external image | Chỉ thêm hai origin/path thực tế đã quan sát |

## Normalization và data flow

`src/token-metadata.ts`: normalizeTokenLogo/tokenLogo/withTokenLogo; chỉ HTTPS, không credentials trong URL, bounded4096 chars, exact origin/path allowlist. Không dựng URL từ mint, không HTML injection, không provider calls. Backend/frontend URL policies có parity test.

Domain Candidate, Position presentation và LabTrial thêm optional `logo?: string|null` để tương thích records cũ; normalized parser/read/API luôn trả string hợp lệ hoặc null. Position name/identity chỉ là projection. `Store.get()` và các generic settings giữ nguyên. Không schema migration hay backfill vào production DB.

```text
GMGN row.logo
 -> parseTrending / parseDiscovery
 -> Candidate.logo + listing.logo
 -> mergeDiscovery / Store JSON + legacy read hydration
 -> tokens / candidate / overview token / positions / history APIs
 -> common frontend metadata cache
 -> shared avatar renderer

Candidate.logo
 -> KronosMarket discovery projection
 -> KronosLab trial/candidate metadata
 -> KronosStore JSON
 -> Lab status/state and relay
 -> Kronos token identity/detail
```

Kronos cùng mint nhận logo hợp lệ mới trong discovery lifecycle thì refresh metadata của record hiện có, không tạo thêm trial hoặc thay quyết định/entry/exit. Không thêm discovery poll khi dataset đã cap50 chỉ để lấy ảnh. Record cũ từng mất metadata và không còn nguồn logo thì vẫn null/fallback; không fabricate hoặc gọi provider để backfill logo. Không truyền logo vào Python; worker/inference code không sửa.

## UI và fallback

`public/token-avatar.js` là helper chung cho Overview carousel/current token/position strip, Position cards, History identity, legacy Flow queue/ghost, Log và Kronos. Các fingerprint render thêm logo để ảnh mới không bị cache UI cũ giữ lại. Token metadata API hiện có được nhớ theo mint; component chỉ có mint vẫn có thể reuse logo trong cache.

Wrapper giữ kích thước/class hiện tại; ảnh fill wrapper với object-fit:cover, border-radius:50%. Khi đang tải, initials vẫn hiện. Chỉ sau load thành công mới ẩn initials/hiện ảnh. Error thì gỡ img khỏi DOM, hiện lại initials; không flash broken-image icon. Alt dùng tên/symbol thật hoặc Unknown Token; dùng `textContent`/DOM properties, không render HTML URL. Referrer policy no-referrer.

Kronos thêm avatar28px trong token cell, giữ cột/table/PnL layout; detail JSON giữ logo. Unknown Token có short mint và placeholder initials. History/Positions dùng name có sẵn từ API khi metadata cache thiếu. Statistics hiện chỉ có aggregate metric cards/charts, không có token identity/avatar nên không thêm nội dung hoặc redesign.

CSP main và standalone:

```text
img-src 'self' https://gmgn.ai/external-res/ https://pump.mypinata.cloud/ipfs/
```

Không `*`, data: hoặc relax script/connect/default policy. Pinata được thêm vì có1 URL thật trong listing đang dùng, không đoán thêm CDN. Nguồn khác chưa được allowlist thì fallback an toàn. Browser image GET là việc tải ảnh bình thường, không thêm GMGN API lookup.

## Verification

- `pnpm typecheck`: PASS.
- `pnpm lint`: PASS.
- `pnpm test`: **403 passed /0 failed /0 skipped /0 cancelled**.
-5 backend metadata tests: actual parser fields, nullable/URL policy, legacy Store hydration+refresh, projection accounting unchanged, Kronos discovery→persisted JSON→API projection cùng URL.
- `pnpm exec tsx scripts/token-logo-ui-test.mjs`: PASS. Actual img rendering, initials hidden after successful load, missing/broken/unsafe/unknown fallback, backend/frontend URL parity, metadata refresh, Overview/Positions/History/Log/Kronos integration, scoped CSP.
- Existing Log/accounting/Kronos browser suites: PASS. Test images intercepted; không external/provider/trading calls.
- Build chỉ trong TEMP staging; root dist không đụng. Exact build id/path trong verification artifact.
- [Kronos browser fixture](previews/token-logos-kronos.png); không phải screenshot đã deploy vào LIVE.

Files changed chủ yếu: `token-metadata.ts`, domain/parser/discovery/Store, position-view + server presentation/CSP, Kronos metadata domain/discovery/store, public avatar/renderers/styles/script loading, tests. Không đổi Candidate qualification, Security, Structure V3, JEV, Risk, BUY/SELL, Jupiter, wallet hoặc PnL formulas. Full suite kiểm tiếp các boundary đó.

## 10 câu trả lời

1. **Field chính xác:** `logo` của GMGN token/listing row; Trending là `rank[].logo`, payload legacy BOT đã có `listing.logo`.
2. **Mất ở đâu:** Trending không mất hoàn toàn vì listing đã giữ; root/domain thiếu, frontend đa số chưa sử dụng, Log chặn cross-origin, CSP chặn ảnh. Legacy parser whitelist và Kronos selectors/store input thực sự làm mất logo.
3. **Field thêm:** unified nullable `logo` trên normalized Candidate/trial/identity projection; optional typing chỉ để đọc được records cũ.
4. **API trả:** `/api/tokens`, `/api/candidate`, overview token qua `/api/status`/events, `/api/positions`, `/api/history`; Kronos `/state`/`/api/kronos` và relay `/api/kronos`. Chỉ là bổ sung field/projection, không thêm provider request.
5. **UI:** Overview, Positions, History, legacy Flow, Log, Kronos. Statistics không có token identity nên giữ nguyên.
6. **Broken logo:** img ban đầu hidden; load thành công mới hiện. Error gỡ img, giữ/hiện initials; URL không hợp lệ không tạo img.
7. **CSP:** Có, chỉ hai exact origin/path ở trên, không wildcard hay disable policy.
8. **Thêm GMGN request chỉ lấy logo?** **NO.** Reuse listing/cached metadata hiện có; chỉ browser tải image URL.
9. **Trading logic đổi?** **NO.** Logo không là qualification/decision/valuation input; Python và execution implementations giữ nguyên.
10. **Tests/typecheck/lint:** PASS như verification ở trên,403 tests và các browser regression suites.

## Activation limit

Không restart bất kỳ process LIVE/Kronos nào theo yêu cầu. Source/build staging đã sửa; backend đang chạy **chưa nạp** normalization/API/CSP/static asset mới. Vì vậy không khẳng định ảnh đã xuất hiện trên UI đang mở. Cần triển khai backend ở thời điểm vận hành phù hợp để policy/API/assets mới có hiệu lực; task này không tự thực hiện bước đó. Không xóa/reset records Kronos hiện tại hoặc dữ liệu production.
