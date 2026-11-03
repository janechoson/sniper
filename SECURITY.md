# Security

Solana signing takes place only in the backend execution provider. `SOLANA_PRIVATE_KEY` accepts a base58 64-byte key or a JSON array of 64 bytes. Alternatively set `SOLANA_KEYPAIR_PATH` to a Solana CLI JSON keypair. The derived public address must equal `WALLET_PUBLIC_KEY`; a GMGN PEM is never accepted as a wallet signer. Do not paste keys into chat, dashboard settings, logs or source control.

The GMGN child environment includes only process necessities and GMGN's own API authentication; Solana, TypeSafe and Jupiter secrets are not inherited. Jev receives normalized facts only. SQLite and log JSON serialization redact secret-bearing fields and configured secret values; provider failures become sanitized error codes. No signed transaction payload or wallet secret is persisted in SQLite or included in API responses.

The local server binds 127.0.0.1, validates Host/Origin/CSRF on writes, and serves a restrictive CSP. Dashboard metadata uses text nodes. Settings endpoints cannot set keys, RPC endpoints, trading mode or ACKs. `.env`, data, backups and secrets directories are ignored by source control.

Execution validates exact route, wallet, mints, direction, raw atomic amount, fixed slippage and quote freshness. It inspects the actual transaction's signer/programs and native principal transfer, checks on-chain decimals and unsigned simulation balance effects, and saves the derived signature durably before network submission. Confirmed receipts and actual balances are required for OPEN/CLOSED. Uncertainty pauses entries without a blind retry.

The smoke command uses a separate ACK and one-shot marker, a fixed established mint, and the owner-revised 0.005 SOL maximum. It preserves pre-existing USDC holdings and stops after the SELL. Existing markers are never removed by the command. No continuous trader was launched during verification.

Runtime verification scanned the SQLite database and smoke artifacts for configured secret values without printing those values; see docs/VERIFICATION.md. Restrict `.env` and keypair file permissions to the local operator. The production provider trusts the official Jupiter HTTPS service for routing but validates its transaction before signing. Token-2022 is limited to the [validated extension subset](docs/token-2022-support.md); unknown/critical extensions and unsupported transaction layouts reject that candidate. Systemic wallet, signer, recipient and post-submission reconciliation failures still pause entries.
