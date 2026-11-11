import type { Position } from "./domain.js";
import { chartFeatures } from "./chart-features.js";
import type { ChartStore } from "./chart-store.js";
import { tradeAccounting } from "./trade-accounting.js";

export function createTradeReplay(
  charts: ChartStore,
  p: Position,
  now = Date.now(),
) {
  const executions = (charts.store.sharedLearning?charts.store.db.prepare("SELECT payload FROM executions WHERE json_extract(payload,'$.intent.positionId')=? AND json_extract(payload,'$.intent.mode')=?").all(p.id,p.mode).map(r=>JSON.parse(String(r.payload)) as import('./domain.js').Execution):charts.store.executions(p.mode))
    .filter((e) => e.intent.positionId === p.id && e.state === "CONFIRMED");
  const end = p.closedAt ?? now;
  const candles = charts.candles(
    p.mint,
    p.entryAt - 3600000,
    end + 3600000,
    now,
  );
  const fills = executions.map((e) => ({
    label: e.intent.side === "BUY" ? "ACTUAL BUY" : "ACTUAL SELL",
    at: e.accounting?.at ?? e.at,
    price: e.accounting?.priceUsd ?? null,
    source: e.intent.decisionSource ?? e.intent.strategy,
    executionId: e.id,
    simulated: e.intent.mode==='demo' || e.evidence?.simulated === true,
    evidence: e,
  }));
  // Signals are calculated on closed prefixes; execution actionability remains
  // unknown without a quote captured at that instant. Never label extrema as signals.
  const candidates = candles
    .filter((c) => c.at >= p.entryAt - 900000 && c.at <= end)
    .flatMap((c) => {
      const cutoff = c.at + 60000,
        f = chartFeatures(candles, cutoff, 5);
      if (f.coverage < 0.8) return [];
      const buy =
        f.returnPct !== null &&
        f.returnPct > 0 &&
        f.momentumChange !== null &&
        f.momentumChange > 3 &&
        f.volumeRatio !== null &&
        f.volumeRatio > 1.5;
      const sell =
        f.behaviors.includes("MOMENTUM_EXHAUSTION") &&
        f.behaviors.includes("WEAKENING_VOLUME");
      if (!buy && !sell) return [];
      return [
        {
          label: buy ? "BETTER BUY CANDIDATE" : "BETTER SELL CANDIDATE",
          at: cutoff,
          price: c.close,
          classification: "INSUFFICIENT_DATA",
          signalDetectability: "CAUSALLY_DETECTABLE",
          reason: buy
            ? "Completed-candle acceleration with rising volume"
            : "Completed-candle momentum exhaustion with weakening volume",
          risk: "Signal may fail; historical executable depth/quote missing",
          features: f,
          estimatedExecution: null,
          influencesLearning: false,
        },
      ];
    })
    .slice(0, 100);
  const holding = candles.filter(
    (c) => c.at >= p.entryAt && c.at + 60000 <= end,
  );
  return {
    positionId: p.id,
    mint: p.mint,
    mode: p.mode,
    accountId: p.demoAccountId ?? p.mode,
    createdAt: now,
    entryAt: p.entryAt,
    closedAt: p.closedAt ?? null,
    candles,
    fills,
    candidates,
    markers: [...fills, ...candidates],
    accounting: tradeAccounting(p, executions),
    highestPriceWhileHolding: holding.length
      ? Math.max(...holding.map((c) => c.high))
      : null,
    maximumFavorableExcursion: p.grossMfePercent ?? null,
    maximumAdverseExcursion: p.grossMaePercent ?? null,
    dataQuality: {
      missing: !candles.length ? ["chartHistory"] : [],
      executionEstimates: "NOT_FABRICATED",
    },
    reviewStatus: "QUEUED",
  };
}
