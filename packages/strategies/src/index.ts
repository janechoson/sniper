import { z } from "zod";
import type {
  AIClassification,
  NormalizedTokenState,
  ScoreResult,
  TradingStrategy,
  StrategyContext,
  StrategyDecision,
} from "@sniper/core";
const clamp = (n: number) => Math.min(100, Math.max(0, n));
export const weightsSchema = z
  .object({
    momentum: z.number().nonnegative(),
    holders: z.number().nonnegative(),
    liquidity: z.number().nonnegative(),
    creator: z.number().nonnegative(),
    security: z.number().nonnegative(),
    ai: z.number().nonnegative(),
  })
  .strict()
  .refine(
    (w) => Math.abs(Object.values(w).reduce((a, b) => a + b, 0) - 1) < 0.000001,
    "Tổng các trọng số phải bằng 1",
  );
export type ScoreWeights = z.infer<typeof weightsSchema>;
export const defaultWeights: ScoreWeights = {
  momentum: 0.3,
  holders: 0.2,
  liquidity: 0.15,
  creator: 0.15,
  security: 0.1,
  ai: 0.1,
};
export function scoreToken(
  state: NormalizedTokenState,
  ai: AIClassification,
  weights: ScoreWeights = defaultWeights,
): ScoreResult {
  const w = weightsSchema.parse(weights);
  const signalScore = { strong_buy: 100, buy: 80, neutral: 30, avoid: 0 }[
    ai.signal
  ];
  const components = {
    momentum:
      state.market.priceChange15s === undefined
        ? 0
        : clamp(
            state.market.priceChange15s * 3 +
              (state.market.buySellRatio ?? 0) * 8,
          ),
    holders:
      state.holders.top1Pct === undefined
        ? 0
        : clamp(
            100 -
              state.holders.top1Pct * 2 -
              (state.holders.suspiciousClusterPct ?? 100),
          ),
    liquidity:
      state.market.liquidityUsd === undefined
        ? 0
        : clamp(state.market.liquidityUsd / 1000),
    creator: state.creator.reputationScore ?? 0,
    security:
      state.security.overallRisk === undefined
        ? 0
        : 100 - state.security.overallRisk,
    ai: signalScore * ai.confidence,
  };
  return {
    total: Object.entries(components).reduce(
      (sum, [key, value]) => sum + value * w[key as keyof ScoreWeights],
      0,
    ),
    components,
    weights: w,
  };
}
export class NewLaunchStrategy implements TradingStrategy {
  readonly id = "new-launch";
  async evaluate({
    state,
    ai,
    score,
    minimumScore,
  }: StrategyContext): Promise<StrategyDecision> {
    const reasons: string[] = [];
    if (state.identity.ageSec === undefined || state.identity.ageSec > 300)
      reasons.push("NOT_NEW_LAUNCH");
    if (score.total < minimumScore) reasons.push("LOW_SCORE");
    if (ai.signal !== "buy" && ai.signal !== "strong_buy")
      reasons.push("AI_NOT_POSITIVE");
    return {
      strategyId: this.id,
      action: reasons.length ? "SKIP" : "BUY",
      passed: reasons.length === 0,
      reasons,
    };
  }
}
export class MomentumStrategy implements TradingStrategy {
  readonly id = "momentum";
  async evaluate({
    state,
    ai,
    score,
    minimumScore,
  }: StrategyContext): Promise<StrategyDecision> {
    const reasons: string[] = [];
    if (
      (state.market.priceChange15s ?? 0) < 5 ||
      (state.market.buySellRatio ?? 0) < 1.5
    )
      reasons.push("NO_MOMENTUM");
    if (score.total < minimumScore) reasons.push("LOW_SCORE");
    if (ai.signal !== "buy" && ai.signal !== "strong_buy")
      reasons.push("AI_NOT_POSITIVE");
    return {
      strategyId: this.id,
      action: reasons.length ? "SKIP" : "BUY",
      passed: reasons.length === 0,
      reasons,
    };
  }
}
export const strategyRegistry = new Map<string, TradingStrategy>(
  [new NewLaunchStrategy(), new MomentumStrategy()].map((s) => [s.id, s]),
);
