import type { OutcomeRecord, NormalizedTokenState } from "@sniper/core";
export const outcomeHorizons = [60, 300, 900, 3600];
export function observeOutcome(
  outcome: OutcomeRecord,
  state: NormalizedTokenState,
  now: number,
  maxLatenessMs = 15000,
  horizons = outcomeHorizons,
): OutcomeRecord | undefined {
  if (
    outcome.completedHorizons.includes(horizons[horizons.length - 1]!) ||
    outcome.missedHorizons?.includes(horizons[horizons.length - 1]!) ||
    outcome.initialPriceUsd === undefined ||
    outcome.initialPriceUsd <= 0 ||
    state.market.priceUsd === undefined
  )
    return;
  const next = structuredClone(outcome);
  next.sampledAt ??= {};
  next.missedHorizons ??= [];
  const gain = (state.market.priceUsd / outcome.initialPriceUsd - 1) * 100;
  next.maxGainPct = Math.max(next.maxGainPct ?? 0, gain);
  const observedPeak = (1 + next.maxGainPct / 100) * outcome.initialPriceUsd;
  next.maxDrawdownPct = Math.max(
    next.maxDrawdownPct ?? 0,
    ((observedPeak - state.market.priceUsd) / observedPeak) * 100,
  );
  next.lastObservedAt = now;
  if (outcome.initialLiquidityUsd && state.market.liquidityUsd !== undefined)
    next.liquidityChangePct =
      (state.market.liquidityUsd / outcome.initialLiquidityUsd - 1) * 100;
  for (const seconds of horizons) {
    const elapsed = now - outcome.createdAt - seconds * 1000;
    if (
      elapsed < 0 ||
      next.completedHorizons.includes(seconds) ||
      next.missedHorizons.includes(seconds)
    )
      continue;
    if (elapsed > maxLatenessMs) {
      next.missedHorizons.push(seconds);
      continue;
    }
    next.prices[String(seconds)] = state.market.priceUsd;
    if (state.market.liquidityUsd !== undefined) {
      next.liquidityByHorizon ??= {};
      next.liquidityByHorizon[String(seconds)] = state.market.liquidityUsd;
    }
    next.sampledAt[String(seconds)] = now;
    next.completedHorizons.push(seconds);
  }
  return next;
}
