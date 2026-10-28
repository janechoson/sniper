import type {
  Decision,
  NormalizedTokenState,
  Position,
  TradeQuote,
} from "@sniper/core";
import type { Settings } from "@sniper/config";
export interface PortfolioRiskState {
  positions: Position[];
  dailyTrades: number;
  dailyPnlUsd: number;
  consecutiveFailures: number;
  killSwitchActive: boolean;
}
export function assessEntry(
  state: NormalizedTokenState,
  score: number,
  settings: Settings,
  portfolio: PortfolioRiskState,
  quote?: TradeQuote,
): Decision {
  const reasons: string[] = [];
  const open = portfolio.positions.filter((p) => p.closedAt === undefined);
  const exposure = (items: Position[]) =>
    items.reduce(
      (sum, p) =>
        sum +
        Math.max(p.remainingCostUsd, Number(p.quantity) * p.currentPriceUsd),
      0,
    );
  if (portfolio.killSwitchActive) reasons.push("KILL_SWITCH");
  if (settings.tradeSizeUsd > settings.maxTradeUsd)
    reasons.push("MAX_TRADE_USD");
  if (!Number.isFinite(score) || score < settings.minScore)
    reasons.push("LOW_SCORE");
  if (
    state.security.overallRisk === undefined ||
    state.security.overallRisk > settings.maxSecurityRisk
  )
    reasons.push("SECURITY_RISK");
  if (open.length >= settings.maxPositions) reasons.push("MAX_POSITIONS");
  if (exposure(open) + settings.tradeSizeUsd > settings.maxPortfolioExposureUsd)
    reasons.push("PORTFOLIO_EXPOSURE");
  if (
    exposure(
      open.filter(
        (p) =>
          p.chainId === state.identity.chainId &&
          p.tokenAddress === state.identity.address,
      ),
    ) +
      settings.tradeSizeUsd >
    settings.maxTokenExposureUsd
  )
    reasons.push("TOKEN_EXPOSURE");
  if (portfolio.dailyTrades >= settings.maxTradesPerDay)
    reasons.push("DAILY_TRADES");
  if (
    !Number.isFinite(portfolio.dailyPnlUsd) ||
    portfolio.dailyPnlUsd <= -settings.maxDailyLossUsd
  )
    reasons.push("DAILY_LOSS");
  if (portfolio.consecutiveFailures >= settings.maxFailedTransactions)
    reasons.push("FAILED_TRANSACTIONS");
  if (
    quote &&
    (!Number.isFinite(quote.priceImpactPct) ||
      quote.priceImpactPct > settings.maxPriceImpactPct)
  )
    reasons.push("PRICE_IMPACT");
  return { passed: reasons.length === 0, reasons };
}
