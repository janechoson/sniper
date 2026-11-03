# Safe Token-2022 and one-trade controlled live

This extends the existing GMGN → current facts + Trading Memory → typed Jev → deterministic RiskEngine → Jupiter → local signing → confirmed receipt/balance reconciliation → local ExitEngine → learning architecture. It does not add a direct Pump/PumpSwap executor or another router.

## Original rejection

Mint `fGQMKWc5Lx5QdEhTgjcfJ4kQYjYpvRTAPmWSqu4HyLy` is owned by **`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`**, the Token-2022 Program. Its account was 397 bytes. Official SDK parsing found decimals 6, no mint/freeze authority and two extensions: MetadataPointer and TokenMetadata. The previous executor only accepted the legacy Token Program and exactly 82 bytes. It correctly refused to sign, but its generic exception incorrectly paused every candidate.

Program owner is now authoritative. Account length is validated by the official codec, never used as the Token-2022 detector. The original rejected candidate was not automatically replayed and no signature was fabricated for it.

## Official interfaces and extension policy

The project pins `@solana/spl-token` **0.4.15**, compatible with its Web3 1.x dependency, and `@solana/spl-token-metadata` **0.1.6**. `unpackMint`, `getExtensionTypes`, the corresponding official extension state decoders, metadata `unpack`, `unpackAccount` and `getAssociatedTokenAddressSync` implement parsing/account derivation. No custom token binary layout is introduced.

References reviewed:

- [Official Token-2022 program and shared mint/account layout](https://www.solana-program.com/docs/token-2022)
- [Official extension semantics](https://www.solana-program.com/docs/token-2022/extensions)
- [Official maintained token-2022 source](https://github.com/solana-program/token-2022)
- [Jupiter Swap API V2](https://developers.jup.ag/docs/swap)

| Extension | Policy |
| --- | --- |
| MetadataPointer | SUPPORTED_WITH_VALIDATION: official decode, null or self-mint pointer only. External metadata targets are skipped. Metadata update authority is informational and does not authorize token transfers. |
| TokenMetadata | SUPPORTED_WITH_VALIDATION: official variable-length codec, metadata mint must match actual mint. Display strings are never execution authority. |
| DefaultAccountState | SUPPORTED_WITH_VALIDATION only for initialized/unfrozen default accounts and absent freeze authority; otherwise CRITICAL_RISK. |
| MintCloseAuthority | SUPPORTED_WITH_VALIDATION only when disabled; active control is CRITICAL_RISK. |
| PermanentDelegate | SUPPORTED_WITH_VALIDATION only when disabled; active delegate is CRITICAL_RISK. |
| NonTransferable, PausableConfig, PermissionedBurn | CRITICAL_RISK; skip. |
| TransferFeeConfig | UNSUPPORTED in this phase. Actual fee fields are decoded for the report, but withheld balances/future fee changes are not guessed or treated as spendable output. Skip. |
| TransferHook | UNSUPPORTED; additional transfer-program behavior is not accepted merely because a route exists. Skip. |
| Other/unknown extension | UNSUPPORTED; record official name when known and numeric type ID when unknown; skip. |
| Token account ImmutableOwner | Supported on actual Token-2022 token accounts. Other token-account extensions are skipped until implemented. |

A normalized TokenExecutionReport records mint, LEGACY_SPL/TOKEN_2022/UNSUPPORTED, exact owner program, decimals, authority facts, extension IDs/names/policies/reasons, unsupported and critical lists, decision and timestamp. Fresh selected-candidate checks are stored before Jev; normalized facts also reach Jev/RiskEngine and the immutable entry snapshot. Token-2022 with an active mint/freeze authority is rejected independently of Jev. Legacy SPL execution behavior, including the already-verified USDC route, remains supported.

## Execution checks

For the selected token, the correct token program is used when deriving the wallet ATA and decoding pre/post-simulation token accounts. Both account owner/mint and wallet ownership must match. Frozen/uninitialized accounts and unsupported account extensions fail closed; an unexpected delegate, close authority, signer or recipient remains a systemic invariant failure. Only transient wrapped-SOL cleanup is allowed by the existing transaction inspector; unrelated token accounts are not closed.

Jupiter remains the only transaction builder/landing provider. Before signing: exact wallet/direction/mints/atomic amount/slippage/freshness, BUY + quote-only reverse SELL route, token extension compatibility, actual serialized message signer/programs/instructions, exact native principal funding, correct ATA program and successful simulation. Unsupported intermediate ATA/transaction layouts are skipped, never guessed. The transaction's actual wallet SOL/token effects must fit the checked principal/output/fee model. Unaccounted extra rents or protocol costs fail simulation validation; a Jupiter quote is not permission to debit unexplained funds.

Confirmed receipts and fresh actual wallet balances remain authoritative after submission. Actual acquired tokens populate the position; partial/full SELL amounts come from the tracked actual position plus a fresh owned balance, not the original quote. Fee extensions are currently skipped rather than assuming quoted output equals spendable balance. Existing pre-existing-holdings isolation remains in place.

## Typed failure boundary

`CandidateRejected` carries a fixed reason type and structured details. Unsupported program/layout/extension, critical extension, no BUY/SELL route, token simulation failure, pre-sign token safety/fee mismatch, stale quote and decimals mismatch reject that candidate and record `candidate_rejections` plus SKIP_MARKET. They do not pause the scanner and are not trading losses.

The engine continues only if no pending transaction exists for that mint. Even a candidate-coded exception after durable submission cannot be skipped. Unexpected wallet/signer/recipient/account authority, RPC/server/authentication failures, duplicate execution invariant, database failure, UNKNOWN submissions and actual receipt/balance reconciliation mismatch still pause entries. The saved signature is reconciled without blind replay.

Pre-sign simulation mismatch and post-broadcast balance mismatch are different stages: the former rejects an unsigned candidate; the latter remains a global reconciliation halt.

## Controlled-live command

`pnpm live:controlled` requires the existing owner-configured LIVE mode, LIVE_TRADING_ACK, scanner/entry flags and wallet key. It never modifies ACKs or secrets.

Preflight checks mainnet genesis, wallet identity/funds, no pending/open position, real GMGN, actual typed Jev and Jupiter BUY/reverse quote + unsigned simulation. The USDC health probe never broadcasts and is not another real smoke round trip.

The command creates a durable SQLite ControlledSession with a unique run ID, **5,000,000-lamport hard BUY principal cap**, one open position and one completed trade maximum. Existing 1% sizing is retained: if that exact amount exceeds the cap it is skipped, not silently resized. The runtime position limit is 1 without broadening the saved normal strategy.

Reservation, signed submission and session limits are linked to the existing intent/position. The signature/session state is saved before broadcast. Once a BUY is submitted, entries are disabled immediately and the BUY allowance remains consumed across restart/UNKNOWN states. Position monitoring/exits continue while entries are disabled. Partial SELLs may occur under the existing ExitEngine; only a fully reconciled close with a Trading Memory outcome completes the run.

A BUY-confirmed SELL failure stops further automatic attempts and reports the remaining position, mint/program/extensions, BUY signature, available token amount, failure and quote evidence. It never marks CLOSED from a signature or abandons the failure silently. Existing manual/emergency exit code remains available for operator-directed recovery.

On successful full close, the runner verifies one confirmed BUY, confirmed SELL evidence, CLOSED position and saved learning outcome, stops Engine/scanner, closes the local server and exits. It writes immutable run reports and event logs under `data/controlled-live-<run-id>.json` and `.events.jsonl`. Failed pre-sign attempts remain preserved; they do not become WIN/LOSS samples.

## Checks and runtime observations

- Required deterministic checks: **73 tests passed**; typecheck, lint and build passed before live. Coverage includes legacy regression, owner-based Token-2022 detection, official mint/metadata parsing, decimals, safe/unknown/critical extensions, ATA program, candidate skip versus systemic pause, no-route/simulation failures, actual balance evidence, owned-token isolation, controlled cap and one-BUY persistence, complete SELL + memory, duplicate prevention and secret redaction.
- Real wallet/RPC, GMGN, pinned Jev and Jupiter quote/reverse-route/BUY simulation health checks passed. No additional real USDC smoke was submitted.
- Dependency hardening: the SDK's transitive bigint-buffer 1.1.5 is affected by CVE-2025-3194 in its native binding. A committed pnpm patch forces upstream's pure-JavaScript conversion path even if a native binary is later built; wide-buffer conversion is covered by regression tests. Registry audit still identifies the package version; the finding is mitigated by the patch, not hidden by an ignored advisory or fake version. The temporary patch edit directory is ignored; automatic review blocked its cleanup.
- The first controlled attempt (`51b093aa-03f9-419c-a2bb-80a33e39b2c0`) stopped before signing on a simulation SOL-cost mismatch. Five on-chain inspected candidates were Token-2022. No BUY signature/open position existed. Its complete failed-run record is preserved. The classification was corrected so unsigned simulation safety mismatches skip the token while actual post-submission reconciliation failures remain systemic.
- The subsequent controlled run completed one real scanner-selected legacy SPL BUY → automatic SELL, with both transactions independently finalized. The scanner stopped, memory contains the LOSS outcome, and no position remains open. See [the complete controlled verification](token-2022-controlled-verification.md). This is execution proof for the selected legacy route, not a claim of a Token-2022 mainnet round trip.
