# Overview V3 delivery

Implemented in the existing local vanilla HTML/JS dashboard; no framework,
trading policy, database schema, financial balance or executor changes.
No approved image was attached, so the supplied layout and existing cream/red
palette were used. KRONOS remains purple. Existing Positions HTML and its
renderer were compared against the pre-redesign Git index and are unchanged.

Audit/plan: reuse dashboard-mode.js and authoritative ModeManager APIs; move
mode and session controls into the global header; replace Overview's large
account/chart and carousel with five KPIs and a scanner bar; remove only its
Action Log renderer; retain route lifecycle, backend filters and Positions.
Main risks were scope changes, missing accounting, unconfirmed BUY statuses,
legacy CSS placements, repeated polls and hidden session controls.

Changed files:
- public/index.html: header controls, session dropdown, five KPIs, scanner bar,
  decision evidence action; removes Overview carousel/log/account chart.
- public/dashboard-mode.js: KPI projections, explicit N/A, current-mode account
  validation, retained LIVE/reset confirmations and API actions.
- public/dashboard-router.js: Overview title and connection feedback.
- public/dashboard-overview.js: backend batch progress, compact token metrics,
  Codex Guard stage, WAIT/BLOCK/error/confirmed BUY, stable stage nodes and
  decision details. Existing Positions renderer retained.
- public/style.css: responsive light layout using the existing palette; table
  styles untouched. Old twelve-column token placement is explicitly overridden.
- scripts/demo-live-ui.ts: adapt existing browser checks to compact controls.
- scripts/overview-v3-ui.ts: repeatable fixture browser checks and screenshots.

Financial sources: DEMO /api/account-balance; LIVE wallet from shell's blockchain
balance, equity from fresh account observations, and PnL from existing
/api/statistics (gross, before fees, labelled). Unavailable values remain N/A.
The selector reflects /api/mode and never switches optimistically. A failed
activation shows its error and the authoritative backend mode; backend may
select an inactive LIVE context after rejecting activation, as before.

Verification executed (Node binary: .\\node_modules\\node\\bin\\node.exe):

```powershell
node node_modules/typescript/bin/tsc --noEmit
node node_modules/eslint/bin/eslint.js src tests scripts/*.ts public/*.js
node --import ./scripts/test-env.mjs --import tsx --test tests/*.test.ts
node scripts/build.mjs --out-dir .build-overview-v3
node --import ./scripts/test-env.mjs --import tsx scripts/overview-v3-ui.ts
node --import ./scripts/test-env.mjs --import tsx scripts/demo-live-ui.ts
node --import ./scripts/test-env.mjs --import tsx scripts/three-databases-ui.ts
node --import ./scripts/test-env.mjs --import tsx scripts/chart-learning-ui.ts
```

Full regression: 513 passed, 0 failed. Browser checks cover 1920x1080,
1440x900, 768x1024, 390x844; screenshots inspected; no page overflow; table
scroll remains local. Five KPIs, batch counters, stable unchanged stages,
WAIT -> reconciling -> confirmed BUY, missing financial N/A, confirmation
cancel/failure, Positions row updates/actions, route cleanup, one Overview
poller, Log and Chart Learning routes pass. Expected mocked HTTP 409 is
excluded from application console-error checks; no unexpected browser errors.
Mode/recovery tests use isolated fixtures with external network denied and
zero LIVE submissions. Typecheck, lint and isolated build passed.

The existing realtime polling architecture is retained (1-second Overview,
5-second shell/account refresh); no SSE or additional animation library added.
Temporary builds, screenshots and fixture databases are removed after checks.
The running local BOT was not paused or restarted for UI work; the new assets
are served at http://127.0.0.1:3000/. Refresh the browser to load them.
