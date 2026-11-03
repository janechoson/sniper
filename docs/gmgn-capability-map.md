# GMGN capabilities actually used

Installed `.agents/skills` were inspected without reinstalling. Runtime uses pinned official `gmgn-cli` **1.6.9** with argument arrays and `--chain sol`. GMGN is intelligence only; the runtime rejects all swap/order/cooking commands before starting a child process.

| Need | Installed capability | Actual use / evidence |
| --- | --- | --- |
| New tokens, Pump.fun, near-completion, migrated tokens | gmgn-market: `market trenches` | One useful feed, `new_creation`, `pump` (or documented `near_completion`), `completed`. Persist mint-normalized candidates and source labels; deduplicate processing and durable BUY intents. No launchpad RPC polling. |
| Trending/search | gmgn-market: `market trending`, `market search` | Supported data allowlist; not extra background polls. Trenches is the scanner's active discovery feed. |
| Price, volume, market cap, liquidity, decimals | gmgn-token: `token info` | Nested price/pool data; market cap is price × circulating supply only when known. Momentum windows are normalized, not fabricated. |
| Security / sellability / rug label | gmgn-token: `token security`; listing `rug_ratio` | CRITICAL/WARNING/INFO/UNKNOWN. Explicit critical inability-to-sell, dangerous controls, tax and rug evidence blocks entries. Missing optional information stays UNKNOWN. |
| Due diligence | gmgn-contract-dd installed rules | Uses field/unit/default rules and normalized findings. The skill derives an agent-side score; there is no invented DD API endpoint and the runtime score remains UNKNOWN. |
| Holders / concentration | gmgn-token: `token holders --limit 20` | Optional, cached. Excludes known burn/DEX/self types from ordinary holder concentration. Missing coverage stays UNKNOWN. |
| Developer identity and holdings | gmgn-token info dev/stat | Creator address and supported fractional holdings. Structural defaults are not treated as verified data. |
| Developer history | gmgn-portfolio: `portfolio created-tokens` | Optional cached creator launch history. No RPC historical indexer. |
| Developer score | gmgn-dev-score | Audited script-derived conduct/power scoring; not run per candidate or replaced by a fabricated score endpoint. The runtime uses actual history facts. |
| Smart-money / KOL information | token info wallet tags | Normalized counts to Jev. No unnecessary global KOL feed. |
| Recent smart-money SELL signals | gmgn-track: `track smartmoney --limit 50` | Optional cached bounded market signal. WARNING by default; local exit policy has OFF/WARNING/EXIT. |
| Position intelligence | token info/security | GMGN market/security monitoring; local ExitEngine decides and Jupiter executes. |
| Deep holder / chart / narrative reports | installed holder-analysis, kline-pattern, narrative skills | Audited; not run for every candidate because extra calls are unnecessary for this small pipeline. |
| GMGN market BUY/SELL, quote, order status, native strategies and cancellation | gmgn-swap | **Removed from runtime. Never execution dependencies. No paid trading entitlement gate.** |

Installed analytical skills are not hidden HTTP endpoints. Optional holder/dev failures do not halt the candidate pipeline. `knownBadFunding` is not sent to Jev or used in RiskEngine, intents, or exits. The GMGN child receives a restricted environment without the Solana wallet secret, TypeSafe key or Jupiter key.

Live read-only verification on 2026-10-28 returned 180 candidates and valid token/security/holder/developer responses. A very new sample had zero price/liquidity and correctly was not trade-ready. Provider connectivity is not itself approval to buy a candidate.
