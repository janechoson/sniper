import { tradingDatabasePath } from "../src/database-session.js";
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { env } from "../src/config.js";
import { Store } from "../src/store.js";
import { Solana } from "../src/solana.js";
import { hash, json } from "../src/util.js";
import type { Position } from "../src/domain.js";

// Independent read-only evidence. Never signs, submits, clears halts or changes DB state.
const db = new Store(tradingDatabasePath("live"), { readOnly: true });
try {
  const status = await fetch(`http://127.0.0.1:${env.PORT}/api/status`).then(
    (r) => r.json(),
  );
  const rpc = new Solana();
  const positions = db.positions("live").filter((p) => BigInt(p.quantity) > 0n);
  const checked: Array<
    Pick<
      Position,
      "id" | "mint" | "symbol" | "state" | "quantity" | "attention"
    > & {
      onChainQuantity: string;
      matches: boolean;
      buySignature?: string;
      signatureStatus: unknown;
    }
  > = [];
  for (const p of positions) {
    const owned = await rpc.tokenBalance(env.WALLET_PUBLIC_KEY, p.mint);
    const signatureStatus = p.signature
      ? (
          await rpc.connection.getSignatureStatuses([p.signature], {
            searchTransactionHistory: true,
          })
        ).value[0]
      : null;
    checked.push({
      id: p.id,
      mint: p.mint,
      symbol: p.symbol,
      state: p.state,
      quantity: p.quantity,
      onChainQuantity: owned.toString(),
      matches: owned === BigInt(p.quantity),
      attention: p.attention,
      buySignature: p.signature,
      signatureStatus,
    });
  }
  const started = db.db
    .prepare(
      "SELECT id,at FROM records WHERE kind='normal_live_start' ORDER BY id DESC LIMIT 1",
    )
    .get();
  const buys = db
    .executions()
    .filter(
      (e) =>
        e.intent.mode === "live" &&
        e.intent.side === "BUY" &&
        started &&
        e.intent.createdAt >= Number(started.at),
    )
    .map((e) => ({
      mint: e.intent.mint,
      state: e.state,
      signature: e.signature ?? null,
      error: e.error ?? null,
      amount: e.intent.amount,
      evidence: e.evidence ?? null,
    }));
  const decisionCounts = started
    ? db.db
        .prepare(
          "SELECT json_extract(payload,'$.outcome') outcome,json_extract(payload,'$.reason') reason,count(*) count FROM records WHERE kind='risk_decisions' AND id>? GROUP BY outcome,reason",
        )
        .all(Number(started.id))
    : [];
  const kronosCounts = started
    ? db.db
        .prepare(
          "SELECT json_extract(payload,'$.action') action,count(*) count FROM records WHERE kind='kronos_decisions' AND id>? GROUP BY action",
        )
        .all(Number(started.id))
    : [];
  const beforeFile = "data/normal-live-before.json";
  const baseline = existsSync(beforeFile)
    ? JSON.parse(readFileSync(beforeFile, "utf8"))
    : null;
  const controlledHistoryHash = hash(db.get("controlledLiveRunV1") ?? null);
  const evidence = {
    at: new Date().toISOString(),
    mode: status.mode,
    running: status.scanner,
    entriesEnabled: status.newEntriesEnabled,
    haltReason: status.haltReason,
    haltScope: status.haltScope,
    attachedControlled: status.controlled,
    settings: status.settings,
    positionSummary: status.positionSummary,
    balanceLamports: status.balanceLamports,
    reservedLamports: status.reservedLamports,
    nextBuyLamports: status.nextBuyLamports,
    normalStart: started ?? null,
    controlledHistoryHash,
    controlledHistoryUnchanged: baseline
      ? baseline.controlledHistoryHash === controlledHistoryHash
      : null,
    pending: db.pending().map((e) => ({
      state: e.state,
      mint: e.intent.mint,
      side: e.intent.side,
      signed: !!e.signature,
    })),
    positions: checked,
    normalLiveBuys: buys,
    decisionCounts,
    kronosCounts,
    confirmedIndependentBuyWhileImagineOpen:
      checked.some((p) => p.symbol === "IMAGINE" && p.state === "OPEN") &&
      buys.some(
        (e) =>
          e.state === "CONFIRMED" &&
          e.signature &&
          !checked.some((p) => p.symbol === "IMAGINE" && p.mint === e.mint),
      ),
  };
  const file = process.argv.includes("--before")
    ? beforeFile
    : "data/normal-live-verification.json";
  writeFileSync(file, json(evidence));
  console.log(json(evidence));
} finally {
  db.close();
}
