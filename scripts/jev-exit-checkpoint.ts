import { writeFileSync } from "node:fs";
import { env } from "../src/config.js";
import { Store } from "../src/store.js";
import { Solana } from "../src/solana.js";
import { hash, json } from "../src/util.js";

// Read-only DB, RPC and HTTP. No signer, broadcast, engine, migration or control request.
const label = process.argv[2] ?? "checkpoint";
if (!/^[a-z0-9-]+$/.test(label)) throw Error("Invalid evidence label");
const db = new Store(env.DATABASE_PATH, { readOnly: true });
try {
  const response = await fetch(`http://127.0.0.1:${env.PORT}/api/status`);
  if (!response.ok) throw Error("STATUS_UNAVAILABLE");
  const status = await response.json(),
    rpc = new Solana();
  const tables = new Set(
    db.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => String(r.name)),
  );
  const positions = [];
  for (const p of db.positions("live").filter((p) => BigInt(p.quantity) > 0n)) {
    const quantity = await rpc.tokenBalance(env.WALLET_PUBLIC_KEY, p.mint);
    const signatureStatus = p.signature
      ? (
          await rpc.connection.getSignatureStatuses([p.signature], {
            searchTransactionHistory: true,
          })
        ).value[0]
      : null;
    const observations = tables.has("trade_observations")
      ? db.db
          .prepare(
            "SELECT count(*) n FROM trade_observations WHERE sample_id=? AND phase='OPEN'",
          )
          .get(p.id)?.n
      : null;
    positions.push({
      ...p,
      onChainQuantity: String(quantity),
      matches: quantity === BigInt(p.quantity),
      signatureStatus,
      observations,
    });
  }
  const evidence = {
    at: new Date().toISOString(),
    label,
    mode: status.mode,
    scanner: status.scanner,
    entriesEnabled: status.newEntriesEnabled,
    haltReason: status.haltReason,
    haltScope: status.haltScope,
    controlled: status.controlled,
    controlledHistoryHash: hash(db.get("controlledLiveRunV1") ?? null),
    settings: status.settings,
    jevExit: status.jevExit ?? null,
    balanceLamports: String(await rpc.balance(env.WALLET_PUBLIC_KEY)),
    positions,
    pending: db
      .pending()
      .filter((e) => e.intent.mode === "live")
      .map((e) => ({
        id: e.id,
        state: e.state,
        side: e.intent.side,
        mint: e.intent.mint,
        signed: !!e.signature,
        signature: e.signature,
      })),
    manual: tables.has("manual_exits")
      ? db.manualRequests("live")
      : db.get("manualExitRequests"),
    jevDecisions: tables.has("jev_exit_decisions")
      ? db.jevExits().slice(-30)
      : [],
    migrations: db.db
      .prepare("SELECT version FROM migrations ORDER BY version")
      .all(),
    lastRecordId: db.db.prepare("SELECT max(id) id FROM records").get()?.id,
  };
  const file = `data/jev-exit-${label}-${Date.now()}.json`;
  writeFileSync(file, json(evidence));
  console.log(
    json({
      file,
      at: evidence.at,
      entriesEnabled: evidence.entriesEnabled,
      haltReason: evidence.haltReason,
      controlled: evidence.controlled,
      jevExit: evidence.jevExit,
      positions: positions.map((p) => ({
        id: p.id,
        symbol: p.symbol,
        quantity: p.quantity,
        onChainQuantity: p.onChainQuantity,
        matches: p.matches,
        lastQuoteAt: p.lastQuoteAt,
        attention: p.attention?.protectiveExit,
        monitoring: p.monitoring?.status,
        jev: p.jevExit?.action,
        observations: p.observations,
      })),
      pending: evidence.pending,
      controlledHistoryHash: evidence.controlledHistoryHash,
    }),
  );
} finally {
  db.close();
}
