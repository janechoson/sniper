import type { Position, NormalizedTokenState } from "@sniper/core";
import type { Settings } from "@sniper/config";
export function markPosition(position: Position, priceUsd: number): Position {
  if (!Number.isFinite(priceUsd) || priceUsd <= 0)
    throw new Error("Giá định giá vị thế không hợp lệ");
  if (position.closedAt !== undefined) return { ...position };
  return {
    ...position,
    currentPriceUsd: priceUsd,
    highestPriceUsd: Math.max(position.highestPriceUsd, priceUsd),
    unrealizedPnlUsd:
      Number(position.quantity) * priceUsd - position.remainingCostUsd,
  };
}
export function positionPnl(position: Position) {
  return {
    realizedUsd: position.realizedPnlUsd,
    unrealizedUsd: position.unrealizedPnlUsd,
    totalUsd: position.realizedPnlUsd + position.unrealizedPnlUsd,
  };
}
export interface ExitDecision {
  reason: string;
  quantity: number;
  level?: number;
}
export class ExitEngine {
  evaluate(
    position: Position,
    state: NormalizedTokenState,
    settings: Settings,
    now: number,
  ): ExitDecision | undefined {
    if (position.closedAt !== undefined) return;
    const price = state.market.priceUsd;
    if (price === undefined || price <= 0) return;
    const gain = (price / position.entryPriceUsd - 1) * 100;
    const all = Number(position.quantity);
    if (gain <= -settings.stopLossPct)
      return { reason: "STOP_LOSS", quantity: all };
    if ((state.security.creatorRisk ?? 0) > settings.maxSecurityRisk)
      return { reason: "CREATOR_RISK", quantity: all };
    if (state.market.whaleSell === true)
      return { reason: "WHALE_SELL", quantity: all };
    if (
      position.initialLiquidityUsd !== undefined &&
      state.market.liquidityUsd !== undefined &&
      state.market.liquidityUsd <
        position.initialLiquidityUsd * (1 - settings.liquidityCollapsePct / 100)
    )
      return { reason: "LIQUIDITY_COLLAPSE", quantity: all };
    if (now - position.openedAt >= settings.maxHoldingSec * 1000)
      return { reason: "MAX_HOLD_TIME", quantity: all };
    if (
      position.highestPriceUsd > position.entryPriceUsd &&
      price <= position.highestPriceUsd * (1 - settings.trailingStopPct / 100)
    )
      return { reason: "TRAILING_STOP", quantity: all };
    for (let i = 0; i < settings.takeProfit.length; i++) {
      const level = settings.takeProfit[i]!;
      if (gain >= level.gainPct && !position.takenLevels.includes(i))
        return {
          reason: `TAKE_PROFIT_${level.gainPct}`,
          quantity: Math.min(
            all,
            (Number(position.initialQuantity) * level.sellPct) / 100,
          ),
          level: i,
        };
    }
  }
}
export class PositionManager {
  private positions = new Map<string, Position>();
  restore(positions: Position[]) {
    this.positions = new Map(positions.map((p) => [p.id, structuredClone(p)]));
  }
  put(position: Position) {
    this.positions.set(position.id, structuredClone(position));
  }
  all() {
    return structuredClone([...this.positions.values()]);
  }
  open() {
    return this.all().filter((p) => p.closedAt === undefined);
  }
}
export * from "./atomic";
export * from "./atomic-exit";
