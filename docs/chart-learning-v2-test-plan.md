# Chart Learning V2 verification plan

## Fixture browser coverage

- Render shared Learning KPIs and collector/provider/queue/validation states without fabricated values.
- Create a deterministic completed M1 RUG_30 fixture, select it, and verify its persisted OHLCV chart and event annotation.
- Exercise RUG_30, analyzed, all-event filters and token search.
- Check event summary, pre-event feature windows, and related rules against the selected event ID.
- Check that existing Decisions detail still opens its persisted candle chart and that routing away/back still works.
- Check page overflow at 1920×1080, 1440×900, 768×1024, and 390×844; capture screenshots only in the script-owned temp directory.
- Assert no browser page errors and no execution side effects.

## Unit and static coverage

- Run the existing Chart Learning test suite for shared storage, event-time integrity, RUG_30 definition, rule validation, and replay evidence.
- Run targeted ESLint, TypeScript typecheck, and production build.

## Evidence limits

- No provider calls or LIVE trades are permitted in UI verification.
- Codex quota subtypes remain unknown where the provider error body was not persisted; show the generic HTTP 429 cause as unknown.
- The dashboard presents only the latest 100 persisted events and latest 100 jobs where the APIs are bounded.
