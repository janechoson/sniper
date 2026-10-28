import type {
  ApprovedTradeIntent,
  ExecutionRecord,
  ManagedPosition,
} from "@sniper/core";
import { parseUnitsSafe, ratioToNumber, toDisplayNumber } from "@sniper/shared";
interface LedgerPosition {
  quantity: bigint;
  costUsd?: bigint;
  realizedUsd?: bigint;
  openedAt: number;
  chainId: string;
  tokenAddress: string;
  mode: string;
  initialCostUsd?: bigint;
  decisionId: string;
  closedAt?: number;
}
export interface PortfolioValuation {
  closedTrades: {
    positionId: string;
    decisionId: string;
    chainId: string;
    mode: string;
    netPnlUsd?: number;
    returnPct?: number;
    holdingSec: number;
    closedAt: number;
  }[];
  dailyPnlUsd?: number;
  exposureUsd?: number;
  winRate?: number;
  chainExposureUsd: Record<string, number | undefined>;
  tokenExposureUsd: Record<string, number | undefined>;
  reasons: string[];
}
export function valuePortfolio(
  records: ExecutionRecord[],
  intentFor: (id: string) => ApprovedTradeIntent | undefined,
  positions: ManagedPosition[],
  currentQuoteUsd: Map<string, string>,
  now = Date.now(),
): PortfolioValuation {
  const ledger = new Map<string, LedgerPosition>();
  let realizedToday: bigint | undefined = 0n;
  const day = new Date(now).toISOString().slice(0, 10);
  const reasons: string[] = [];
  const price = (value: string, decimals: number, usd: string) =>
    (BigInt(value) * parseUnitsSafe(usd, 18)) / 10n ** BigInt(decimals);
  const fee = (record: ExecutionRecord, intent: ApprovedTradeIntent) =>
    record.networkFee !== undefined && intent.valuation?.nativeUsdPrice
      ? price(
          record.networkFee,
          intent.valuation.nativeDecimals,
          intent.valuation.nativeUsdPrice,
        )
      : intent.mode === "PAPER" &&
          intent.route.quote.estimatedNetworkFeeUsd !== undefined
        ? parseUnitsSafe(intent.route.quote.estimatedNetworkFeeUsd, 18)
        : undefined;
  const approvals = new Map<string, bigint | undefined>();
  const confirmedSwaps = new Set(
    records
      .filter((r) => r.state === "CONFIRMED" && r.operation !== "APPROVAL")
      .map((r) => r.intentId),
  );
  for (const record of records) {
    const intent = intentFor(record.intentId);
    if (!intent) continue;
    if (
      ["UNKNOWN", "SUBMITTING", "PENDING"].includes(record.state) &&
      record.transactionId
    )
      realizedToday = undefined;
    if (
      record.operation === "APPROVAL" &&
      ["CONFIRMED", "FAILED"].includes(record.state) &&
      record.transactionId
    ) {
      const cost = fee(record, intent);
      const old = approvals.get(record.intentId);
      approvals.set(
        record.intentId,
        cost === undefined ||
          (approvals.has(record.intentId) && old === undefined)
          ? undefined
          : (old ?? 0n) + (cost ?? 0n),
      );
      if (
        !confirmedSwaps.has(record.intentId) &&
        new Date(record.updatedAt).toISOString().slice(0, 10) === day
      )
        realizedToday =
          realizedToday === undefined || cost === undefined
            ? undefined
            : realizedToday - cost;
    }
    if (
      record.operation !== "APPROVAL" &&
      record.state === "FAILED" &&
      record.transactionId &&
      new Date(record.updatedAt).toISOString().slice(0, 10) === day
    ) {
      const cost = fee(record, intent);
      realizedToday =
        realizedToday === undefined || cost === undefined
          ? undefined
          : realizedToday - cost;
    }
  }
  for (const record of [...records].sort((a, b) => a.updatedAt - b.updatedAt)) {
    if (record.state !== "CONFIRMED" || record.operation === "APPROVAL")
      continue;
    const intent = intentFor(record.intentId);
    if (
      !intent ||
      record.actualAmountIn === undefined ||
      record.actualAmountOut === undefined
    ) {
      reasons.push("FILL_ACCOUNTING_INCOMPLETE");
      realizedToday = undefined;
      continue;
    }
    const baseFee = fee(record, intent);
    const approvalFee = approvals.has(intent.id)
      ? approvals.get(intent.id)
      : 0n;
    const costFee =
        baseFee === undefined || approvalFee === undefined
          ? undefined
          : baseFee + approvalFee,
      usd = intent.valuation?.quoteUsdPrice;
    if (intent.side === "BUY") {
      const cost =
        usd === undefined || costFee === undefined
          ? undefined
          : price(record.actualAmountIn, intent.route.quote.decimalsIn, usd) +
            costFee;
      ledger.set(`position:${intent.id}`, {
        quantity: BigInt(record.actualAmountOut),
        costUsd: cost,
        realizedUsd: 0n,
        openedAt: record.updatedAt,
        chainId: intent.chainId,
        tokenAddress: intent.tokenOut,
        mode: intent.mode,
        initialCostUsd: cost,
        decisionId: intent.decisionId,
      });
    } else {
      const position = intent.positionId
        ? ledger.get(intent.positionId)
        : undefined;
      if (
        !position ||
        position.quantity <= 0n ||
        BigInt(record.actualAmountIn) > position.quantity
      ) {
        reasons.push("EXIT_ACCOUNTING_INCOMPLETE");
        realizedToday = undefined;
        continue;
      }
      const sold = BigInt(record.actualAmountIn);
      const cost =
        position.costUsd === undefined
          ? undefined
          : (position.costUsd * sold) / position.quantity;
      const pnl =
        usd === undefined || costFee === undefined || cost === undefined
          ? undefined
          : price(record.actualAmountOut, intent.route.quote.decimalsOut, usd) -
            cost -
            costFee;
      position.costUsd =
        position.costUsd === undefined || cost === undefined
          ? undefined
          : position.costUsd - cost;
      position.quantity -= sold;
      position.closedAt = record.updatedAt;
      position.realizedUsd =
        position.realizedUsd === undefined || pnl === undefined
          ? undefined
          : position.realizedUsd + pnl;
      if (new Date(record.updatedAt).toISOString().slice(0, 10) === day)
        realizedToday =
          realizedToday === undefined || pnl === undefined
            ? undefined
            : realizedToday + pnl;
    }
  }
  let exposure: bigint | undefined = 0n,
    unrealized: bigint | undefined = 0n;
  const chains = new Map<string, bigint | undefined>(),
    tokens = new Map<string, bigint | undefined>();
  for (const position of positions) {
    if (position.state === "CLOSED" || position.state === "FAILED") continue;
    const entry = ledger.get(position.id);
    const usd = currentQuoteUsd.get(
      `${position.chainId}:${position.quoteTokenAddress}`,
    );
    const mark =
      usd !== undefined &&
      position.latestExitQuoteAmount !== undefined &&
      position.exitQuoteObservedAt !== undefined &&
      now - position.exitQuoteObservedAt <= 15000
        ? price(position.latestExitQuoteAmount, position.quoteDecimals, usd)
        : undefined;
    const value =
      mark === undefined || entry?.costUsd === undefined
        ? undefined
        : mark > entry.costUsd
          ? mark
          : entry.costUsd;
    const key = `${position.chainId}:${position.tokenAddress}`;
    exposure =
      exposure === undefined || value === undefined
        ? undefined
        : exposure + value;
    chains.set(
      position.chainId,
      (chains.has(position.chainId) &&
        chains.get(position.chainId) === undefined) ||
        value === undefined
        ? undefined
        : (chains.get(position.chainId) ?? 0n) + value,
    );
    tokens.set(
      key,
      (tokens.has(key) && tokens.get(key) === undefined) || value === undefined
        ? undefined
        : (tokens.get(key) ?? 0n) + value,
    );
    if (
      !entry ||
      new Date(entry.openedAt).toISOString().slice(0, 10) !== day ||
      entry.costUsd === undefined ||
      mark === undefined
    )
      unrealized = undefined;
    else if (unrealized !== undefined) unrealized += mark - entry.costUsd;
  }
  const closed = [...ledger.values()].filter((p) => p.quantity === 0n);
  const wins = closed.filter(
    (p) => p.realizedUsd !== undefined && p.realizedUsd > 0n,
  ).length;
  const pnl =
    realizedToday === undefined || unrealized === undefined
      ? undefined
      : toDisplayNumber(realizedToday + unrealized, 18);
  if (pnl === undefined) reasons.push("DAILY_NET_PNL_UNVERIFIED");
  if (exposure === undefined)
    reasons.push("PORTFOLIO_USD_ACCOUNTING_UNVERIFIED");
  return {
    closedTrades: [...ledger.entries()]
      .filter(([, p]) => p.quantity === 0n && p.closedAt !== undefined)
      .map(([positionId, p]) => ({
        positionId,
        decisionId: p.decisionId,
        chainId: p.chainId,
        mode: p.mode,
        netPnlUsd:
          p.realizedUsd === undefined
            ? undefined
            : toDisplayNumber(p.realizedUsd, 18),
        returnPct:
          p.realizedUsd === undefined ||
          p.initialCostUsd === undefined ||
          p.initialCostUsd <= 0n
            ? undefined
            : ratioToNumber(p.realizedUsd * 100n, p.initialCostUsd),
        holdingSec: Math.max(0, (p.closedAt! - p.openedAt) / 1000),
        closedAt: p.closedAt!,
      })),
    dailyPnlUsd: pnl,
    exposureUsd:
      exposure === undefined ? undefined : toDisplayNumber(exposure, 18),
    winRate:
      closed.length === 0 || closed.some((p) => p.realizedUsd === undefined)
        ? undefined
        : ratioToNumber(BigInt(wins) * 100n, BigInt(closed.length)),
    chainExposureUsd: Object.fromEntries(
      [...chains].map(([chain, value]) => [
        chain,
        value === undefined ? undefined : toDisplayNumber(value, 18),
      ]),
    ),
    tokenExposureUsd: Object.fromEntries(
      [...tokens].map(([token, value]) => [
        token,
        value === undefined ? undefined : toDisplayNumber(value, 18),
      ]),
    ),
    reasons: [...new Set(reasons)],
  };
}
