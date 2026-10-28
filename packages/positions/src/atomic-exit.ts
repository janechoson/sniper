import type { ManagedPosition, NormalizedTokenState } from "@sniper/core";
export interface AtomicExitDecision {
  reason: string;
  amount: string;
  level?: number;
}
export function evaluateAtomicExit(
  position: ManagedPosition,
  exitProceeds: string,
  now: number,
  state?: NormalizedTokenState,
): AtomicExitDecision | undefined {
  if (position.state === "CLOSED" || position.state === "FAILED") return;
  const quantity = BigInt(position.remainingQuantity),
    proceeds = BigInt(exitProceeds),
    cost = BigInt(position.remainingCostQuoteAmount);
  if (quantity <= 0n) return;
  const all = (reason: string): AtomicExitDecision => ({
    reason,
    amount: quantity.toString(),
  });
  const bps = (pct: number) => BigInt(Math.round(pct * 100));
  if (
    proceeds * 10000n <=
    cost * (10000n - bps(position.exitPolicy.stopLossPct))
  )
    return all("STOP_LOSS");
  if (
    state?.security.creatorRisk !== undefined &&
    state.security.creatorRisk > 25
  )
    return all("CREATOR_RISK");
  if (state?.market.whaleSell === true) return all("WHALE_SELL");
  if (
    position.initialLiquidityUsd !== undefined &&
    state?.market.liquidityUsd !== undefined &&
    position.exitPolicy.liquidityCollapsePct !== undefined &&
    state.market.liquidityUsd <
      position.initialLiquidityUsd *
        (1 - position.exitPolicy.liquidityCollapsePct / 100)
  )
    return all("LIQUIDITY_COLLAPSE");
  if (now - position.openedAt >= position.exitPolicy.maxHoldingSec * 1000)
    return all("MAX_HOLD_TIME");
  const peak = position.peakExitQuote;
  if (
    peak &&
    proceeds * BigInt(peak.quantity) * 10000n <=
      BigInt(peak.amount) *
        quantity *
        (10000n - bps(position.exitPolicy.trailingStopPct))
  )
    return all("TRAILING_STOP");
  for (let i = 0; i < position.exitPolicy.takeProfit.length; i++) {
    const level = position.exitPolicy.takeProfit[i]!;
    if (
      position.takenLevels.includes(i) ||
      proceeds * 10000n < cost * (10000n + bps(level.gainPct))
    )
      continue;
    const desired =
      (BigInt(position.initialQuantity) * bps(level.sellPct)) / 10000n;
    const amount = desired > quantity ? quantity : desired;
    if (amount > 0n)
      return {
        reason: `TAKE_PROFIT_${level.gainPct}`,
        amount: amount.toString(),
        level: i,
      };
  }
}
