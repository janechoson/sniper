import { tradingDatabasePath } from "../src/database-session.js";
import { writeFileSync } from "node:fs";
import { env } from "../src/config.js";
import { Store } from "../src/store.js";
import { Solana } from "../src/solana.js";
import { hash, json } from "../src/util.js";

// Independent read-only evidence: no Engine, signer, migration or submission.
const label = process.argv[2] ?? "checkpoint";
if (!/^[a-z0-9-]+$/.test(label)) throw Error("INVALID_LABEL");
const store = new Store(tradingDatabasePath("live"), { readOnly: true });
try {
  const rpc = new Solana();
  const status = await fetch(`http://127.0.0.1:${env.PORT}/api/status`, {
    signal: AbortSignal.timeout(5000),
  })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  if(status)delete status.csrf;
  const positions = [];
  for (const p of store
    .positions("live")
    .filter((p) => BigInt(p.quantity) > 0n)) {
    const onChainQuantity = String(
      await rpc.tokenBalance(env.WALLET_PUBLIC_KEY, p.mint),
    );
    const buyStatus = p.signature
      ? (
          await rpc.connection.getSignatureStatuses([p.signature], {
            searchTransactionHistory: true,
          })
        ).value[0]
      : null;
    positions.push({
      ...p,
      onChainQuantity,
      matches: onChainQuantity === p.quantity,
      buyStatus,
    });
  }
  const at = Date.now();
  const result = {
    at: new Date(at).toISOString(),
    label,
    status,
    balanceLamports: String(await rpc.balance(env.WALLET_PUBLIC_KEY)),
    positions,
    custodyHash: hash(
      positions.map((p) => ({
        id: p.id,
        quantity: p.quantity,
        cost: p.costLamports,
        remainingCost: p.remainingCostLamports,
        realized: p.realizedLamports,
      })),
    ),
    controlledHistoryHash: hash(store.get("controlledLiveRunV1") ?? null),
    haltReason: store.get("haltReason") ?? null,
    haltScope: store.get("haltScope") ?? null,
    entriesEnabled: store.entriesEnabled(),
    pending: store
      .pending()
      .filter((e) => e.intent.mode === "live")
      .map((e) => ({
        id: e.id,
        mint: e.intent.mint,
        side: e.intent.side,
        state: e.state,
        signed: !!e.signature,
        signature: e.signature,
      })),
    migrations: store.db
      .prepare("SELECT version FROM migrations ORDER BY version")
      .all(),
    maxRecordId: store.db.prepare("SELECT max(id) id FROM records").get()!.id,
  };
  const file = `data/capital-flow-${label}-${at}.json`;
  writeFileSync(file, json(result));
  console.log(
    json({
      file,
      at: result.at,
      runtime: status?.runtime ?? null,
      capabilities: status?.capabilities ?? null,
      scanner: status?.scanner ?? null,
      entriesEnabled: result.entriesEnabled,
      haltReason: result.haltReason,
      balanceLamports: result.balanceLamports,
      positions: positions.map((p) => ({
        symbol: p.symbol,
        quantity: p.quantity,
        matches: p.matches,
        state: p.state,
        flow: p.flow?.regime,
        flowAt: p.flow?.at,
        lastQuoteAt: p.lastQuoteAt,
        nextSellRetry: p.attention?.nextCheckAt,
      })),
      pending: result.pending,
      migrations: result.migrations,
    }),
  );
} finally {
  store.close();
}
