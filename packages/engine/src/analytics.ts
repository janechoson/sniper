import type {
  CandidateRecord,
  StrategyAnalytics,
  PipelineTiming,
} from "@sniper/core";
import type { PortfolioValuation } from "./real-accounting";
const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b),
    mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
};
export function strategyAnalytics(
  candidates: CandidateRecord[],
  portfolio: PortfolioValuation,
  tradeCount: number,
  candidateCount: number,
): StrategyAnalytics {
  const trades = portfolio.closedTrades;
  const unknown = trades.filter((t) => t.netPnlUsd === undefined).length;
  const returns = trades.flatMap((t) =>
    t.returnPct === undefined ? [] : [t.returnPct],
  );
  const mean = (values: number[]) =>
    values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  const count = (key: (c: CandidateRecord) => string) => {
    const groups: Record<
      string,
      { candidates: number; trades: number; netPnlUsd: number | null }
    > = {};
    for (const candidate of candidates) {
      const id = key(candidate);
      groups[id] ??= { candidates: 0, trades: 0, netPnlUsd: 0 };
      groups[id]!.candidates++;
    }
    for (const trade of trades) {
      const candidate = candidates.find((c) => c.id === trade.decisionId);
      const id = candidate ? key(candidate) : "UNKNOWN";
      groups[id] ??= { candidates: 0, trades: 0, netPnlUsd: 0 };
      const group = groups[id]!;
      group.trades++;
      group.netPnlUsd =
        group.netPnlUsd === null || trade.netPnlUsd === undefined
          ? null
          : group.netPnlUsd + trade.netPnlUsd;
    }
    return groups;
  };
  const scores: Record<string, number> = {},
    confidence: Record<string, number> = {},
    latency: StrategyAnalytics["latency"] = {};
  for (const candidate of candidates) {
    const score = candidate.score?.total;
    const scoreKey =
      score === undefined
        ? "UNKNOWN"
        : `${Math.min(90, Math.floor(score / 10) * 10)}-${Math.min(100, Math.floor(score / 10) * 10 + 10)}`;
    scores[scoreKey] = (scores[scoreKey] ?? 0) + 1;
    const value = candidate.ai?.confidence;
    const bucket =
      value === undefined
        ? "UNKNOWN"
        : `${Math.min(4, Math.floor(value * 5)) * 20}-${Math.min(5, Math.floor(value * 5) + 1) * 20}%`;
    confidence[bucket] = (confidence[bucket] ?? 0) + 1;
  }
  const stages: [string, keyof PipelineTiming, keyof PipelineTiming][] = [
    ["discovery", "chainEvent", "received"],
    ["normalization", "received", "normalized"],
    ["features", "normalized", "featuresReady"],
    ["security", "normalized", "securityReady"],
    ["hardFilter", "featuresReady", "hardFilterComplete"],
    ["ai", "hardFilterComplete", "aiComplete"],
    ["risk", "aiComplete", "riskComplete"],
    ["quotes", "riskComplete", "quoteReady"],
    ["simulation", "quoteReady", "simulationComplete"],
    ["submission", "simulationComplete", "broadcast"],
    ["confirmation", "broadcast", "confirmation"],
    ["total", "received", "confirmation"],
  ];
  for (const [name, from, to] of stages) {
    const samples = candidates.flatMap((c) => {
      const a = c.timing?.[from],
        b = c.timing?.[to];
      return a !== undefined && b !== undefined && b >= a ? [b - a] : [];
    });
    latency[name] = {
      samples: samples.length,
      averageMs: mean(samples),
      medianMs: median(samples),
    };
  }
  const positives = trades.reduce(
      (sum, t) => sum + Math.max(0, t.netPnlUsd ?? 0),
      0,
    ),
    negatives = trades.reduce(
      (sum, t) => sum + Math.max(0, -(t.netPnlUsd ?? 0)),
      0,
    );
  let total: number | null = 0,
    peak = 0,
    maxDrawdown = 0;
  const equity = trades
    .slice()
    .sort((a, b) => a.closedAt - b.closedAt)
    .map((t) => {
      total =
        total === null || t.netPnlUsd === undefined
          ? null
          : total + t.netPnlUsd;
      if (total !== null) {
        peak = Math.max(peak, total);
        maxDrawdown = Math.max(maxDrawdown, peak - total);
      }
      return { at: t.closedAt, pnlUsd: total };
    });
  return {
    scope: {
      cachedCandidates: candidates.length,
      closedTrades: trades.length,
      unknownNetResults: unknown,
    },
    candidateCount,
    tradeCount,
    winRate: portfolio.winRate ?? null,
    averageReturnPct:
      unknown || returns.length !== trades.length ? null : mean(returns),
    medianReturnPct:
      unknown || returns.length !== trades.length ? null : median(returns),
    profitFactor: unknown || negatives === 0 ? null : positives / negatives,
    maxDrawdownUsd: unknown || !trades.length ? null : maxDrawdown,
    averageHoldingSec: mean(trades.map((t) => t.holdingSec)),
    byChain: count((c) => c.event.chainId),
    byDex: count((c) => c.event.dexId),
    byStrategy: count(
      (c) => c.strategy?.strategyId ?? c.strategyId ?? "UNKNOWN",
    ),
    byScoreBucket: scores,
    byConfidenceBucket: confidence,
    latency,
    realizedEquity: equity,
  };
}
