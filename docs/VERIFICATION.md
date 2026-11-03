# Verification: real Solana BUY → SELL

Verified on **2026-10-28, 11:27:08 Asia/Bangkok**. Both signatures were independently queried again and are **finalized**. The scanner/Engine was never started by the smoke command. Exactly one Jupiter BUY and one Jupiter SELL were submitted; the command exited 0 and stopped.

The original request specified 0.0005 SOL; the owner later explicitly said to keep `LIVE_SMOKE_TEST_SOL=0.005`. Code, `.env.example`, tests and the actual run therefore use the revised hard cap of **0.005 SOL / 5,000,000 lamports**. The program did not change the ACK or wallet key.

## Architecture and execution

Before: GMGN intelligence → Jev/Risk → GMGN custodial swap/native price orders → GMGN order/activity recovery.

After: GMGN intelligence → cheap filter → official TypeSafe System One (`jev-1.14.0`) → small deterministic RiskEngine → Jupiter Swap V2 → local backend signing → on-chain confirmation and wallet reconciliation → persistent position → local ExitEngine → Jupiter SELL → confirmation/reconciliation.

GMGN capabilities actually used: Trenches new/near-completion/migrated candidates, token info/security, optional bounded holder analysis, creator launch history, smart-money/KOL counts, and optional smart-money SELL signals. Read-only live verification returned 180 candidates. Unknown optional facts are not silently safe and do not independently block. `knownBadFunding` has no decision role.

Jupiter was selected from its current official API documentation for quote/build, fixed slippage, versioned transactions and managed landing. Metis routes are supported; official routing documentation includes Pump.fun and Pump.fun AMM. This run proves the selected USDC route; other tokens still need valid routes and safety checks. See [provider contract and sources](solana-execution-provider.md).

BUY: fresh wallet balances → exact principal → fresh executable order + quote-only reverse route → quote validation → actual instruction inspection → unsigned RPC simulation → wallet/mint-decimals/final risk checks → local signature → persist signature before broadcast → Jupiter execute once → confirmed receipt → actual SOL/token reconciliation → OPEN.

SELL: local exit reason → fresh tracked token balance → exact token → SOL order → validate/simulate → local signature saved before execution → execute once → confirmation/receipt + actual balance reconciliation → CLOSED. Smoke sold only acquired tokens; normal sizing and Jev/scanner were not used.

Signing uses one backend Solana wallet. The GMGN authentication PEM is not a wallet key. RPC responsibilities are wallet/mint reads, transaction lookup-table resolution and simulation, bounded confirmation/status and receipt/balance reconciliation. No chain discovery, holder/developer indexer or launchpad polling uses RPC.

## Actual smoke evidence

| Item | Observed result |
| --- | --- |
| Provider | Jupiter Swap API V2, Metis |
| Wallet | `DzFFTWXyt82LRexdhZMNEjxLFiyTF7NHrn9fDQQ56fPd` |
| Token | USDC, six decimals |
| Verified mint | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| BUY requested principal | 5,000,000 lamports = **0.005 SOL** |
| BUY actual principal from on-chain System transfer | **5,000,000 lamports** |
| BUY actual wallet SOL debit, including rent/network | 6,529,809 lamports = **0.006529809 SOL** |
| Tokens actually received | 508,277 atomic units = **0.508277 USDC** |
| BUY confirmation | finalized, slot **462340645**; successful receipt; SOL delta −6,529,809, USDC delta +508,277 |
| SELL amount | exactly 508,277 atomic units; no pre-existing tokens sold |
| SELL actual wallet SOL credit, after network fee | 4,992,764 lamports = **0.004992764 SOL** |
| SELL confirmation | finalized, slot **462340669**; successful receipt; SOL delta +4,992,764, USDC delta −508,277 |
| SOL before | 305,050,641 lamports = **0.305050641 SOL** |
| SOL after | 303,513,596 lamports = **0.303513596 SOL** |
| Net SOL difference | **−0.001537045 SOL** |
| BUY network/priority fee | 41,369 lamports |
| SELL network/priority fee | 5,120 lamports |
| Total actual network fees | **46,489 lamports = 0.000046489 SOL** |
| Rent retained in empty USDC token account | **1,488,440 lamports = 0.001488440 SOL**; not a network fee |
| Remaining swap difference | 2,116 lamports = 0.000002116 SOL |
| Smoke token balance before / after | 0 / 0 |
| Remaining smoke position | **0 tokens; closed** |
| Submission retries | 0 |
| Errors in successful Jupiter run | none |
| Final status | **REAL SOLANA BUY → SELL VERIFIED** |

BUY signature: [3nUWzHPLysbkTTQBSpwXZYFxTTXxe8wavCdVxdVFMTXSnRWckKtbU7nZq8cPUPVfyFamqvENQHd15VtYBW3igt8b](https://solscan.io/tx/3nUWzHPLysbkTTQBSpwXZYFxTTXxe8wavCdVxdVFMTXSnRWckKtbU7nZq8cPUPVfyFamqvENQHd15VtYBW3igt8b).

SELL signature: [3JzGzPvBTeUVBXyvJmm2iNncShJZ8FC7JXBXGAc41mHRCPwrnkZEJE8Sp2rx4DdhYYqCD89CXzbhcpSXHrXeEPGy](https://solscan.io/tx/3JzGzPvBTeUVBXyvJmm2iNncShJZ8FC7JXBXGAc41mHRCPwrnkZEJE8Sp2rx4DdhYYqCD89CXzbhcpSXHrXeEPGy).

Local durable records: `data/live-smoke-test.json`, `data/live-smoke-test.json.once`, `data/live-smoke-test.json.verification.json`. The independent read-only evidence script recomputed principal, receipt deltas, rent, status and current balances. It never broadcasts. The one-shot marker remains in place.

The pre-existing GMGN test had stopped with GMGN_PLAN_UPGRADE_REQUIRED before obtaining an order/signature; all recorded and independently re-read wallet balances were unchanged. The migration maintenance script archived that original record, marker and review as `data/legacy-gmgn-smoke-1793161606874.json*` before the newly authorized Jupiter run. No unresolved transaction was retried and no evidence was overwritten to claim success.

## Checks and limitations

- `pnpm test`: **41 passed**, including integer sizing, revised cap, quote/mint/direction/wallet/amount/slippage checks, serialized-transaction principal and recipient checks, simulation balance mismatch, duplicate prevention, receipt/state/restart behavior, acquired-token isolation, failed/ambiguous smoke legs, signer identity and secret redaction.
- `pnpm typecheck`, `pnpm lint`, `pnpm build`: passed. Typecheck/lint include maintenance/evidence/audit TypeScript scripts.
- Existing browser check passed: dashboard navigation, settings, entry switch, SSE and CSRF rejection, with zero browser errors. It ran against an isolated scanner-disabled test database and submitted no trades.
- Real read-only GMGN, Jev, wallet, executable Jupiter quote, reverse route and BUY simulation checks passed before the real trade.
- Secret audit: **717 files inspected, zero configured secret values detected**, including SQLite/WAL and smoke artifacts. Only counts and credential names would be reported, never values.
- Windows project-local Node **22.22.0** ran the commands. The globally launched pnpm reports a Node 20 engine warning; package scripts resolve the installed Node 22 executable. SQLite emits Node's experimental warning.
- Token-2022, alternate transaction layouts and non-Metis routers are intentionally blocked. Automatic local exits require process uptime. Legacy live GMGN positions/orders require review rather than automatic migration.
- Historical paper/UI tests are retained but are not offered as real execution proof. No continuous autonomous trading was enabled or started.

## Changed files

- Runtime execution/signing: `src/execution-provider.ts` (new), `src/executor.ts`, `src/solana.ts`, `src/smoke-live.ts`, `src/smoke-policy.ts`.
- Intelligence, decisions, persistence and config: `src/gmgn.ts`, `src/jev.ts`, `src/risk.ts`, `src/engine.ts`, `src/store.ts`, `src/domain.ts`, `src/config.ts`, `src/util.ts`, `src/verify.ts`.
- Dashboard/API: `src/server.ts`, `public/app.js`, `public/index.html`.
- Setup: `.env.example`, `config/strategy.json`, `package.json`, `tsconfig.json`. Existing user `.env` secrets/ACK were not edited by the implementation; the owner added the wallet key.
- Safety tests: `tests/core.test.ts`, `tests/execution.test.ts`, `tests/pipeline.test.ts`, `tests/smoke.test.ts`, `tests/fixtures.ts`, `tests/provider.test.ts` (new).
- Operator evidence: `scripts/archive-legacy-smoke.ts`, `scripts/read-smoke-evidence.ts`, `scripts/audit-secrets.ts` (new).
- Documentation: `README.md`, `SECURITY.md`, `docs/gmgn-capability-map.md`, `docs/solana-execution-provider.md` (new), `docs/gmgn-trading.md`, `docs/risk-policy.md`, `docs/VERIFICATION.md`.
