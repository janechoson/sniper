import { tradingDatabasePath } from "../src/database-session.js";
import { writeFileSync } from "node:fs";
import { env, settingsSchema } from "../src/config.js";
import { Gmgn } from "../src/gmgn.js";
import { Store } from "../src/store.js";
import { Solana } from "../src/solana.js";
import { JupiterExecutionProvider } from "../src/execution-provider.js";
import { probeExits, assertEntryExit } from "../src/exit-feasibility.js";
import { safeError } from "../src/util.js";
// Provider contract verification ONLY. No Engine/Executor, signing, migration, DB writes or broadcast.
const db = new Store(tradingDatabasePath("live"), { readOnly: true });
try {
  const settings = settingsSchema.parse(db.get("strategyV2")),
    g = new Gmgn();
  const trend = await g.trending(
    settings.trendingInterval,
    settings.trendingLimit,
  );
  const sniper = await g.discover();
  const status = await fetch(`http://127.0.0.1:${env.PORT}/api/status`).then(
    (r) => r.json(),
  );
  const p = new JupiterExecutionProvider(new Solana()),
    mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const q = await p.quoteBuy(
    mint,
    BigInt(status.nextBuyLamports),
    settings.slippagePercent * 100,
  );
  const exits = await probeExits(
    p,
    mint,
    BigInt(q.order.outAmount),
    env.WALLET_PUBLIC_KEY,
    settings,
    "PRE_BUY",
    q,
  );
  let gate = "PASS";
  try {
    assertEntryExit(exits, q, settings);
  } catch (e) {
    gate = safeError(e);
  }
  const result = {
    at: new Date().toISOString(),
    trending: {
      count: trend.length,
      basis: trend[0]?.discovery?.trending?.basis,
      sample: trend
        .slice(0, 5)
        .map((c) => ({
          mint: c.mint,
          symbol: c.symbol,
          rank: c.discovery?.trending?.rank,
          listingKeys: Object.keys(c.listing ?? {}),
        })),
    },
    sniper: { count: sniper.length },
    controlBuy: {
      mint,
      amount: q.amount,
      expectedTokens: q.order.outAmount,
      priceImpactPct: q.order.priceImpactPct ?? null,
    },
    exits,
    entryGate: gate,
    databaseWrites: 0,
    signatures: 0,
    submittedTransactions: 0,
    buySimulationPerformed: false,
  };
  const file = `data/trending-provider-verification-${Date.now()}.json`;
  writeFileSync(file, JSON.stringify(result, null, 2));
  console.log(
    JSON.stringify({
      file,
      trending: trend.length,
      sniper: sniper.length,
      levels: exits.levels.map((l) => ({
        bps: l.sellBps,
        amount: l.amount,
        status: l.status,
        minimumSolOut: l.minimumSolOut,
        net: l.netMinimumLamports,
      })),
      gate,
      signatures: 0,
      submittedTransactions: 0,
    }),
  );
} finally {
  db.close();
}
