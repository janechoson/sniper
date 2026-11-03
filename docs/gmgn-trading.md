# Retired GMGN execution model

GMGN execution, native TP/SL, order cancellation and GMGN order recovery are no longer used. The runtime only permits GMGN intelligence/data commands. Its paid trading entitlement cannot block Jupiter execution.

The current model is described in [solana-execution-provider.md](solana-execution-provider.md). Existing legacy DB records are preserved; pending/open legacy trades pause entries for review. The previous smoke attempt failed with GMGN_PLAN_UPGRADE_REQUIRED, had no order ID or transaction signature and unchanged balances. It was archived with its marker and an independent current-wallet balance review before the newly authorized Jupiter test.
