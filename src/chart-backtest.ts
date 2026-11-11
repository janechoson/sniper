import { randomUUID } from "node:crypto";
import { applies } from "./chart-features.js";
import type { Candle } from "./market-history.js";
import type { ChartStore } from "./chart-store.js";

export interface ReplayCosts {
  initialCapitalUsd: number;
  positionSizeUsd: number;
  feePerFillUsd: number;
  slippageBps: number;
}
export interface ReplaySignal {
  entry: "BUY" | "WAIT";
  exit: "SELL" | "HOLD";
}
interface ReplayTrade {
  entryAt: number;
  exitAt: number;
  entryPrice: number;
  exitPrice: number;
  netPnl: number;
  fees: number;
  peakPnl: number;
  source: string;
}

/** Research estimates only. Supplied costs are assumptions, never fabricated
 * historical quotes. This report cannot validate a learning rule or authorize trades. */
export async function compareWalkForward(
  charts: ChartStore,
  mint: string,
  from: number,
  to: number,
  costs: ReplayCosts,
  forecast: (candles: Candle[], at: number) => Promise<ReplaySignal>,
) {
  if (
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    from > to ||
    to - from > 120 * 60000 ||
    to > Date.now()
  )
    throw Error("REPLAY_RANGE_MAX_120_MINUTES");
  if (
    !Object.values(costs).every(Number.isFinite) ||
    costs.initialCapitalUsd <= 0 ||
    costs.positionSizeUsd <= 0 ||
    costs.positionSizeUsd > costs.initialCapitalUsd ||
    costs.feePerFillUsd < 0 ||
    costs.slippageBps < 0 ||
    costs.slippageBps > 10000
  )
    throw Error("REPLAY_COSTS_INVALID");
  const names = ["KRONOS_ONLY", "KRONOS_GUARD", "KRONOS_GUARD_SELL"] as const;
  const states = names.map((name) => ({
    name,
    cash: costs.initialCapitalUsd,
    peakEquity: costs.initialCapitalUsd,
    maxDrawdown: 0,
    open: null as null | {
      at: number;
      price: number;
      quantity: number;
      cost: number;
      peakPnl: number;
    },
    trades: [] as ReplayTrade[],
    blocks: [] as { at: number; price: number }[],
    errors: 0,
    fees: 0,
    slippageUsd: 0,
    equity: [] as { at: number; value: number }[],
  }));
  const trace: unknown[] = [];
  const slip = costs.slippageBps / 10000;
  for (let at = from; at <= to; at += 60000) {
    const candles = charts.candles(mint, at - 3600000, at, at);
    if (candles.length < 3) continue;
    const price = candles.at(-1)!.close;
    const rules = charts
      .rules(at)
      .filter((r) => r.status === "VALIDATED" && applies(r, candles, at));
    const block = rules.some((r) => r.action === "BLOCK"),
      sell = rules.some((r) => r.action === "SELL");
    let signal: ReplaySignal;
    try {
      signal = await forecast(candles, at);
    } catch {
      for (const s of states) s.errors++;
      continue;
    }
    trace.push({
      at,
      signal,
      block,
      sell,
      ruleVersions: rules.map((r) => ({ id: r.id, version: r.version })),
    });
    for (const s of states) {
      if (s.open) {
        const o = s.open;
        o.peakPnl = Math.max(o.peakPnl, o.quantity * price - o.cost);
        if (
          signal.exit === "SELL" ||
          (s.name === "KRONOS_GUARD_SELL" && sell)
        ) {
          const exitPrice = price * (1 - slip),
            net = o.quantity * exitPrice - costs.feePerFillUsd;
          s.cash += net;
          s.fees += costs.feePerFillUsd;
          s.slippageUsd += o.quantity * price * slip;
          s.trades.push({
            entryAt: o.at,
            exitAt: at,
            entryPrice: o.price,
            exitPrice,
            netPnl: net - o.cost,
            fees: 2 * costs.feePerFillUsd,
            peakPnl: o.peakPnl,
            source: signal.exit === "SELL" ? "KRONOS" : "CODEX_RULE_POLICY",
          });
          s.open = null;
        }
      } else if (signal.entry === "BUY") {
        if (s.name !== "KRONOS_ONLY" && block) s.blocks.push({ at, price });
        else if (s.cash >= costs.positionSizeUsd + costs.feePerFillUsd) {
          const fill = price * (1 + slip),
            cost = costs.positionSizeUsd + costs.feePerFillUsd;
          s.cash -= cost;
          s.fees += costs.feePerFillUsd;
          s.slippageUsd +=
            costs.positionSizeUsd - costs.positionSizeUsd / (1 + slip);
          s.open = {
            at,
            price: fill,
            quantity: costs.positionSizeUsd / fill,
            cost,
            peakPnl: 0,
          };
        }
      }
      const equity = s.cash + (s.open?.quantity ?? 0) * price;
      s.peakEquity = Math.max(s.peakEquity, equity);
      s.maxDrawdown = Math.max(
        s.maxDrawdown,
        ((s.peakEquity - equity) / s.peakEquity) * 100,
      );
      s.equity.push({ at, value: equity });
    }
  }
  const outcomes = states.map((s) => {
    const wins = s.trades.filter((t) => t.netPnl > 0),
      losses = s.trades.filter((t) => t.netPnl < 0);
    const grossProfit = wins.reduce((a, t) => a + t.netPnl, 0),
      grossLoss = -losses.reduce((a, t) => a + t.netPnl, 0);
    const blocked = s.blocks
      .map((b) => {
        // Outcomes are evaluated AFTER the signal loop, never fed to a decision.
        const future = charts.candles(mint, b.at, b.at + 3600000, Date.now());
        return {
          at: b.at,
          crash: future.some((c) => c.low <= b.price * 0.7),
          missedUpside: future.some((c) => c.high >= b.price * 1.2),
          coverage: future.length / 60,
        };
      })
      .filter((b) => b.coverage >= 0.8);
    const timing = s.trades.map((t) => {
      const future = charts.candles(
        mint,
        t.exitAt,
        t.exitAt + 15 * 60000,
        Date.now(),
      );
      return {
        exitAt: t.exitAt,
        premature:
          future.length >= 12
            ? future.some((c) => c.high >= t.exitPrice * 1.1)
            : null,
        profitRetained: t.peakPnl > 0 ? t.netPnl / t.peakPnl : null,
      };
    });
    return {
      strategy: s.name,
      completedTrades: s.trades.length,
      openPosition: s.open !== null,
      netRealizedPnl: s.trades.reduce((a, t) => a + t.netPnl, 0),
      netEquityPnl: s.equity.length
        ? s.equity.at(-1)!.value - costs.initialCapitalUsd
        : null,
      winRate: s.trades.length ? wins.length / s.trades.length : null,
      maximumDrawdownPct: s.maxDrawdown,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
      averageLoss: losses.length ? -grossLoss / losses.length : null,
      estimatedFees: s.fees,
      estimatedSlippageUsd: s.slippageUsd,
      blockedSignals: s.blocks.length,
      correctlyAvoidedCrashes: blocked.filter((b) => b.crash).length,
      missedProfitableSignals: blocked.filter((b) => b.missedUpside).length,
      falseBlockRate: blocked.length
        ? blocked.filter((b) => b.missedUpside && !b.crash).length /
          blocked.length
        : null,
      sellTiming: timing,
      errors: s.errors,
      trades: s.trades,
      equity: s.equity,
    };
  });
  const report = {
    id: randomUUID(),
    kind: "WALK_FORWARD_COMPARISON",
    policyVersion: "walkforward-cost-v2",
    at: Date.now(),
    mint,
    from,
    to,
    costs,
    executionModel: "CLOSED_PRICE_PLUS_EXPLICIT_COST_ASSUMPTIONS",
    authoritative: false,
    limitations: [
      "Historical routes and market depth not validated",
      "Full historical security/risk gates are not reconstructed; this report cannot establish executable strategy returns",
      "Codex rules replayed deterministically; no retrospective AI claims",
      "No forced terminal liquidation",
      "Unavailable observations stay missing",
    ],
    trace,
    outcomes,
  };
  charts.db
    .prepare("INSERT INTO chart_validations VALUES(?,?,?)")
    .run(report.id, report.at, JSON.stringify(report));
  return report;
}
