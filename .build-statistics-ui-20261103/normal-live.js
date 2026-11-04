import { env } from "./config.js";
import { Blocked } from "./domain.js";
import { localWallet } from "./execution-provider.js";
import { SMOKE_MAINNET_GENESIS } from "./smoke-policy.js";
// Explicit normal-live startup. Historical controlled sessions remain audit data.
export async function activateNormalLive(engine) {
    if (env.TRADING_MODE !== "live" ||
        !env.LIVE_TRADING_ACK ||
        !env.NEW_ENTRIES_ENABLED ||
        !env.SCANNER_ENABLED)
        throw new Blocked("NORMAL_LIVE_REQUIRES_EXISTING_LIVE_ACK_AND_ENABLED_SCANNER_ENTRIES");
    if (engine.executor.controlled)
        throw new Blocked("NORMAL_LIVE_CANNOT_ATTACH_CONTROLLED_SESSION");
    const wallet = localWallet();
    wallet.secretKey.fill(0);
    if ((await engine.rpc.connection.getGenesisHash()) !== SMOKE_MAINNET_GENESIS)
        throw new Blocked("RPC_NOT_SOLANA_MAINNET");
    await engine.executor.recover(engine.settings);
    if (engine.store.pending().some((e) => e.intent.mode === "live" && e.signature)) {
        // Start observation/reconciliation with new entries disabled. Existing signed
        // locks remain enforced by Executor/Store; no unsigned order is replayed.
        engine.store.set("newEntriesEnabled", false);
        engine.store.event("RECOVERY_ONLY_STARTED", undefined, "Signed transaction unresolved; monitoring continues, wallet execution remains locked");
        return;
    }
    if (engine.store.get("haltReason") || engine.store.get("haltScope"))
        throw new Blocked("EXISTING_SYSTEM_OR_TRANSACTION_HALT_REQUIRES_REVIEW");
    const positions = engine.store
        .positions("live")
        .filter((p) => p.state === "OPEN");
    for (const p of positions) {
        if (p.provider !== "JUPITER" || !p.signature)
            throw new Blocked("OPEN_POSITION_REQUIRES_REVIEW");
        const status = (await engine.rpc.connection.getSignatureStatuses([p.signature], {
            searchTransactionHistory: true,
        })).value[0];
        if (!status ||
            status.err ||
            !["confirmed", "finalized"].includes(status.confirmationStatus ?? ""))
            throw new Blocked("OPEN_BUY_RECEIPT_UNRESOLVED");
        if ((await engine.rpc.tokenBalance(env.WALLET_PUBLIC_KEY, p.mint)) !==
            BigInt(p.quantity))
            throw new Blocked("OPEN_POSITION_BALANCE_MISMATCH");
    }
    const balance = await engine.balance();
    engine.store.atomic(() => {
        engine.store.set("newEntriesEnabled", true);
        engine.store.record("normal_live_start", undefined, {
            openPositions: positions.length,
            balanceLamports: balance.toString(),
            positionSizePercent: engine.settings.positionSizePercent,
        });
        engine.store.event("NORMAL_LIVE_STARTED", undefined, `Normal continuous live: ${engine.settings.positionSizePercent}% spendable SOL per BUY; no position-count limit; existing positions recovered`);
    });
}
