import { writeFileSync } from "node:fs";
import { env, settingsSchema } from "../src/config.js";
import { Store } from "../src/store.js";
import { Gmgn, normalizeMarket } from "../src/gmgn.js";
import { Jev } from "../src/jev.js";
import { hash, json } from "../src/util.js";

// Reads real GMGN + System One only. No Engine/Executor, signer, submission or DB writes.
const db = new Store(env.DATABASE_PATH, { readOnly: true });
try {
  const p = db.positions("live").find((p) => p.state === "OPEN");
  if (!p) throw Error("NO_OPEN_POSITION");
  const gmgn = new Gmgn(),
    settings = settingsSchema.parse(db.get("strategyV2"));
  const candidate = db.token(p.mint) ?? {
    mint: p.mint,
    source: p.source ?? "gmgn",
    discoveredAt: p.entryAt,
  };
  const security = await gmgn.security(candidate, settings),
    info = await gmgn.info(p.mint),
    market = normalizeMarket(info);
  const state = {
    currentPosition: p,
    currentToken: { market, security, gmgn: info },
    historicalExperience: {
      usableForDecision: false,
      similarTrades: 0,
      confidence: "NONE",
      reason: "Independent schema check; no history supplied",
    },
    policy: {
      stopLoss: false,
      timeExit: false,
      mandatoryTakeProfit: false,
      takeProfitReferences: settings.takeProfits,
      trailingReference: {
        activationBps: settings.trailingActivationBps,
        distanceBps: settings.trailingStopBps,
      },
      safetyOverrides: true,
    },
  };
  const started = Date.now(),
    answer = await new Jev().decideExit(state);
  const result = {
    at: new Date().toISOString(),
    positionId: p.id,
    mint: p.mint,
    symbol: p.symbol,
    inputHash: hash(state),
    latencyMs: Date.now() - started,
    answer,
    submittedTransactions: 0,
    databaseWrites: 0,
  };
  const file = `data/jev-exit-provider-check-${Date.now()}.json`;
  writeFileSync(file, json(result));
  console.log(json({ file, ...result }));
} finally {
  db.close();
}
