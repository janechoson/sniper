# Controlled live verification: Token-2022 support and one real trade

Final status: **REAL_CONTROLLED_ROUND_TRIP_VERIFIED**. On 2026-10-28 the real GMGN → Trading Memory → Jev → RiskEngine → Jupiter → local signer → confirmation/reconciliation → ExitEngine → SELL → OutcomeAnalyzer pipeline completed exactly one trade and stopped. Both receipts were independently checked again at **12:40:15 Asia/Bangkok** and are finalized. The selected token was legacy SPL; no Token-2022 mainnet BUY/SELL is claimed.

## Implementation and original failure

The original candidate `fGQMKWc5Lx5QdEhTgjcfJ4kQYjYpvRTAPmWSqu4HyLy` has a 397-byte mint owned by `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` (Token-2022), decimals 6, MetadataPointer and TokenMetadata, with no mint/freeze authority. The former legacy-only owner/82-byte check rejected it before signing; a generic failure incorrectly paused the scanner.

Owner-based detection and official SPL codecs now support legacy SPL and a validated Token-2022 subset, including correct ATA program/account decoding. MetadataPointer, TokenMetadata, initialized DefaultAccountState without freeze authority, disabled MintCloseAuthority and disabled PermanentDelegate are supported with validation. Active control authorities, NonTransferable, PausableConfig and PermissionedBurn are critical; TransferFeeConfig, TransferHook, confidential/other/unknown extensions are unsupported and skipped. See [exact extension policy and failure boundary](token-2022-support.md).

Typed candidate errors (unsupported program/mint/layout/extension, no BUY/reverse SELL route, unsigned token simulation/safety failure) record SKIP and continue scanning. Wallet/signer/recipient failures, unhealthy RPC/provider, persistence/invariant failures, UNKNOWN submitted transactions and actual receipt mismatches still stop entries. No pending submitted transaction may be skipped or blindly retried. Existing serialized-instruction inspection, principal cap, reverse quote, simulation, actual-balance reconciliation and acquired-token isolation remain enforced.

Changed files: `src/token-program.ts` (new), `src/controlled-session.ts` (new), `src/live-controlled.ts` (new), `src/domain.ts`, `src/solana.ts`, `src/execution-provider.ts`, `src/engine.ts`, `src/executor.ts`, `src/risk.ts`, `src/trading-memory.ts`, `src/server.ts`; `tests/token-program-fixtures.ts`, `tests/token-program.test.ts`, `tests/provider.test.ts`, `tests/execution.test.ts`, `tests/pipeline.test.ts`; `scripts/read-controlled-evidence.ts`; `package.json`, `pnpm-lock.yaml`, `patches/bigint-buffer@1.1.5.patch`, `.gitignore`; README, SECURITY and provider/Token-2022 documentation. Wallet secrets and ACK values were not changed.

## Checks and live screening

All **73 deterministic tests passed**, with typecheck, lint and build passing before broadcast. Typecheck/lint also passed after adding the independent read-only evidence script. Actual wallet/RPC, GMGN, typed Jev and executable Jupiter BUY/reverse quote + unsigned simulation health checks passed. There was no additional real USDC smoke. Final secret audit inspected **750 files**, including database/artifacts: **zero configured secret values detected**, and no secret values printed. The SDK's transitive native bigint-buffer issue is mitigated by the pinned pure-JavaScript patch; registry audit still flags its package version, as described in the implementation report.

The first attempt `51b093aa-03f9-419c-a2bb-80a33e39b2c0` inspected five Token-2022 candidates and stopped unsigned on a simulation cost mismatch. It submitted no BUY, created no loss sample, and its evidence remains preserved. Pre-sign simulation mismatch was then corrected to candidate rejection; post-submission mismatch remains systemic.

Successful run `30d2385b-4b82-4182-86d8-4a252c402ad8` ran from **12:33:22 to 12:38:35 Asia/Bangkok**. It analyzed **31 distinct candidates**, with **27 on-chain inspection records** and **24 distinct Token-2022 candidates**. The earlier unsigned attempt is reported separately above. Skip-decision counts in the successful run follow; repeated checks mean these are decisions, not disjoint token counts.

| Skip reason | Decisions |
| --- | ---: |
| Jev SKIP | 13 |
| Liquidity below entry policy | 7 |
| Unsigned simulation safety/cost mismatch | 3 |
| Price materially changed after Jev | 3 |
| GMGN critical rug label | 2 |
| Candidate age outside strategy | 1 |
| Missing price/liquidity | 1 |

The three typed `TOKEN_SAFETY_FAILED` rejections were `7zHE96jv9MR2HyansDkmcLiBJHFgmFiFto9eSNtbpump`, `EjtMaFRMmcFRi7MnNHWTcjS1oXmY1dArQc6oew6Rksq8`, and `wMdbJp9kdks7DnnpeYi4xbxMn65U718wW1H4iDd3f37`. Simulated SOL debits did not fit the approved principal/fee model. They remained unsigned and scanning continued; protections were not relaxed to buy them.

## Selected candidate and decisions

| Item | Evidence |
| --- | --- |
| Token | GROK / GROK COIN |
| Mint | `54Kg1icFZ9iB7TUSHCmPw3vPF4GBfukxNFp7E3a8UD62` |
| Program | LEGACY_SPL, `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` |
| Decimals / extensions | 6 / none; mint and freeze authorities null |
| Discovery | GMGN, source `gmgn:meteora_virtual_curve` |
| Actual Jupiter route | Metis, Pump.fun Amm, both directions |
| GMGN security | No normalized findings; mint/freeze renounced KNOWN true, rug ratio KNOWN 0 |
| Entry liquidity / market cap | Approximately $34,303 / $86,284 |
| Jev | `jev-1.14.0`, BUY, confidence 0.60, MEDIUM; CURRENT_MOMENTUM; suspicious=false, insufficientData=false |
| Historical context | 0 comparable completed trades, INSUFFICIENT confidence, strength NONE; no fabricated history |
| RiskEngine | BUY allowed, final fresh checks allowed; exact normal 1% sizing retained |

## Finalized transaction and accounting evidence

Wallet: `DzFFTWXyt82LRexdhZMNEjxLFiyTF7NHrn9fDQQ56fPd`.

BUY: [2GivzCcmZtv5G1cP8SooHwr7JhpzYMbpxVHddzdH5o1qwb3WpM3diBcw3QLiSVNtciV2qPVdJ1w5ZKiEUiQoYRX4](https://solscan.io/tx/2GivzCcmZtv5G1cP8SooHwr7JhpzYMbpxVHddzdH5o1qwb3WpM3diBcw3QLiSVNtciV2qPVdJ1w5ZKiEUiQoYRX4), finalized slot **462360798**, successful receipt.

SELL: [gRhYiUhmNrgRiBNrQFJpG1Rg7VjGfEz5Q2RCjCyfPYBhrqJ87kdjjmVb4b5oBTbJWP4XSpYuk5wowYcfr8TZVDW](https://solscan.io/tx/gRhYiUhmNrgRiBNrQFJpG1Rg7VjGfEz5Q2RCjCyfPYBhrqJ87kdjjmVb4b5oBTbJWP4XSpYuk5wowYcfr8TZVDW), finalized slot **462360856**, successful receipt.

| Item | Actual result |
| --- | ---: |
| BUY principal, independently decoded System transfer | **2,835,135 lamports = 0.002835135 SOL**, below 0.005 SOL cap |
| Total BUY wallet debit | 4,399,771 lamports = 0.004399771 SOL |
| BUY network/priority fee | 5,076 lamports |
| Actual tokens received | **3,337,013,866 atomic = 3337.013866 GROK** |
| SELL amount | Exactly the acquired 3,337,013,866 atomic; pre-existing balance 0 |
| Actual SELL net SOL credit | **2,817,220 lamports = 0.002817220 SOL** |
| SELL network/priority fee | 5,119 lamports |
| Total network/priority fees | **10,195 lamports = 0.000010195 SOL** |
| New wallet token-account rent retained | **1,488,440 lamports = 0.001488440 SOL**; not network fees |
| Other net BUY cost above principal, network fee and wallet ATA rent | 71,120 lamports; not attributed to network fees or a refundable wallet account |
| Principal minus SELL proceeds before its network fee | 12,796 lamports; includes trading/route/price effects, not asserted to be pure slippage |
| SOL before / after | 303,513,596 / 301,931,045 lamports |
| Net cash PnL | **−1,582,551 lamports = −0.001582551 SOL** |
| Net cash PnL / full BUY wallet debit | **−35.9689%**, includes retained account costs |
| Token balance before / after | 0 / 0 |

Accounting reconciles: 1,488,440 + 71,120 + 12,796 + 10,195 = 1,582,551 lamports. The large cash loss percentage primarily reflects initial account costs at this small order size. It is not evidence that GROK's market price fell 35.97%.

## Exit, learning and stop

The local ExitEngine triggered **STOP_LOSS** from fee-inclusive net position value, approximately −35.51% at its observation; the sampled GMGN price had actually risen approximately 0.32% versus entry. It automatically sold the position. Holding duration was **12,931 ms**. Observed MFE **0%**, observed MAE **−35.9689%**; only one observation plus exit evidence exists, coverage **EXIT_ONLY**, so these are sparse observations, not a continuous price-path measurement.

OutcomeAnalyzer recorded **LOSS**, accountingComplete=true, eligibleForStrategy=true. Entry/exit quality and classifications remain **UNKNOWN** due to limited observations. Trading Memory version 1 sample/position ID: `438c446c-a2d0-4202-a206-759243975155`; trade ID `684d04cc-6cab-4c65-a2cf-c4f54ddc066d`. Both actual transaction signatures are linked. One real completed sample cannot establish a meaningful win rate or strategy confidence.

The session is **COMPLETE**: exactly one confirmed BUY and one confirmed SELL; position CLOSED with quantity 0; **0 open positions, 0 pending transactions**, entries disabled. Engine/scanner stopped, server closed and command exited **0**. Port 3000 has no listener. No second trade was started. No account cleanup or rent recovery was attempted.

Evidence files:

- `data/controlled-live-30d2385b-4b82-4182-86d8-4a252c402ad8.json`: full run/session, decisions, execution/reconciliation and learning records.
- Same base `.events.jsonl`: live candidate and execution observations.
- Same `.json.verification.json`: independent re-read of finalized receipts, actual principal, deltas, wallet ATA rent, current balances and DB stop state. Its `broadcasts: 0` describes the read-only evidence script, not the trading run.
- `scripts/read-controlled-evidence.ts <run-id>` independently rechecks public evidence without signing or broadcasting.

The original USDC smoke evidence and the unsigned failed attempt remain preserved. The older `docs/VERIFICATION.md` describes that historical legacy-only smoke; the policy in this report supersedes its Token-2022 limitation.
