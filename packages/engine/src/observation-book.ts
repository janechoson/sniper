import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  atomicQuoteSchema,
  type AtomicTradeQuote,
  type ObservationTrade,
  type CandidateRecord,
} from "@sniper/core";
import type { Repository } from "@sniper/storage";
import type { Settings } from "@sniper/config";
import { quoteUnitsForUsd } from "@sniper/shared";
const uint = z.string().regex(/^\d+$/);
const tradeSchema = z.object({
  id: z.string(),
  candidateId: z.string(),
  chainId: z.string(),
  tokenAddress: z.string(),
  symbol: z.string(),
  quoteToken: z.string(),
  quoteDecimals: z.number().int(),
  tokenDecimals: z.number().int(),
  amountIn: uint,
  quantity: uint,
  budgetUsd: z.literal("5"),
  quoteUsdPrice: z.string(),
  openedAt: z.number(),
  closedAt: z.number().optional(),
  exitQuoteAmount: uint.optional(),
  exitReason: z.string().optional(),
  state: z.enum(["OPEN", "CLOSED"]),
  source: z.literal("RPC"),
  execution: z.literal("SIMULATED"),
  sellability: z.literal("UNKNOWN"),
  liveBlockingReasons: z.array(z.string()),
  remainingQuantity: uint,
  remainingCostQuote: uint,
  realizedQuoteAmount: uint,
  takenLevels: z.array(z.number().int()),
  peakNumerator: uint,
  peakDenominator: uint,
});
type StoredTrade = z.infer<typeof tradeSchema>;
/** Quote-based virtual ledger. It cannot obtain a signer, intent, or executor. */
export class ObservationBook {
  private trades = new Map<string, StoredTrade>();
  constructor(private readonly repository: Repository) {}
  async restore() {
    for (const row of await this.repository.read())
      if (row.kind === "observation.trade") {
        const trade = tradeSchema.parse(row.payload);
        this.trades.set(trade.id, trade);
      }
  }
  all(): ObservationTrade[] {
    return [...this.trades.values()].map((t) => structuredClone(t));
  }
  openTrades() {
    return [...this.trades.values()]
      .filter((t) => t.state === "OPEN")
      .map((t) => structuredClone(t));
  }
  private async save(trade: StoredTrade) {
    const value = tradeSchema.parse(trade);
    await this.repository.append({
      id: randomUUID(),
      kind: "observation.trade",
      chainId: trade.chainId,
      tokenAddress: trade.tokenAddress,
      payload: value,
      createdAt: Date.now(),
    });
    this.trades.set(trade.id, value);
    return value;
  }
  async open(
    candidate: CandidateRecord,
    quoteInput: AtomicTradeQuote,
    quoteUsdPrice: string,
    settings: Settings,
  ) {
    const quote = atomicQuoteSchema.parse(quoteInput);
    if (
      candidate.event.source !== "RPC" ||
      quote.chainId !== candidate.event.chainId ||
      quote.tokenOut !== candidate.event.tokenAddress ||
      quote.expiresAt <= Date.now() ||
      quote.priceImpactPct === undefined ||
      quote.priceImpactPct > settings.maxPriceImpactPct ||
      BigInt(quote.amountIn) !==
        quoteUnitsForUsd("5", quoteUsdPrice, quote.decimalsIn)
    )
      throw new Error("OBSERVATION_QUOTE_INVALID");
    if (
      [...this.trades.values()].some(
        (t) =>
          t.chainId === quote.chainId &&
          (quote.chainId === "solana"
            ? t.tokenAddress === quote.tokenOut
            : t.tokenAddress.toLowerCase() === quote.tokenOut.toLowerCase()),
      )
    )
      return;
    if (5 > settings.maxTradeUsd) throw new Error("MAX_TRADE_USD");
    if (5 > settings.maxTokenExposureUsd) throw new Error("TOKEN_EXPOSURE");
    if ((this.openTrades().length + 1) * 5 > settings.maxPortfolioExposureUsd)
      throw new Error("PORTFOLIO_EXPOSURE");
    const chainLimit = settings.maxChainExposureUsd[quote.chainId];
    if (
      chainLimit === undefined ||
      (this.openTrades().filter((t) => t.chainId === quote.chainId).length +
        1) *
        5 >
        chainLimit
    )
      throw new Error("CHAIN_EXPOSURE");
    if (this.openTrades().length >= settings.maxPositions)
      throw new Error("MAX_POSITIONS");
    if (
      [...this.trades.values()].filter(
        (t) =>
          new Date(t.openedAt).toISOString().slice(0, 10) ===
          new Date().toISOString().slice(0, 10),
      ).length >= settings.maxTradesPerDay
    )
      throw new Error("DAILY_TRADES");
    return this.save({
      id: randomUUID(),
      candidateId: candidate.id,
      chainId: quote.chainId,
      tokenAddress: quote.tokenOut,
      symbol: candidate.state?.identity.symbol ?? quote.tokenOut,
      quoteToken: quote.tokenIn,
      quoteDecimals: quote.decimalsIn,
      tokenDecimals: quote.decimalsOut,
      amountIn: quote.amountIn,
      quantity: quote.minimumAmountOut,
      budgetUsd: "5",
      quoteUsdPrice,
      openedAt: Date.now(),
      state: "OPEN",
      source: "RPC",
      execution: "SIMULATED",
      sellability: "UNKNOWN",
      liveBlockingReasons: candidate.observation?.liveBlockingReasons ?? [
        "OBSERVATION_ONLY",
      ],
      remainingQuantity: quote.minimumAmountOut,
      remainingCostQuote: quote.amountIn,
      realizedQuoteAmount: "0",
      takenLevels: [],
      peakNumerator: quote.amountIn,
      peakDenominator: quote.minimumAmountOut,
    });
  }
  async mark(
    id: string,
    quoteInput: AtomicTradeQuote,
    settings: Settings,
    now = Date.now(),
  ) {
    const old = this.trades.get(id);
    if (!old || old.state !== "OPEN") return;
    const q = atomicQuoteSchema.parse(quoteInput);
    if (
      q.chainId !== old.chainId ||
      q.tokenIn !== old.tokenAddress ||
      q.tokenOut !== old.quoteToken ||
      q.amountIn !== old.remainingQuantity ||
      q.expiresAt <= now ||
      q.priceImpactPct === undefined ||
      q.priceImpactPct > settings.maxPriceImpactPct
    )
      throw new Error("OBSERVATION_EXIT_QUOTE_INVALID");
    const quantity = BigInt(old.remainingQuantity),
      cost = BigInt(old.remainingCostQuote),
      proceeds = BigInt(q.minimumAmountOut),
      bps = (p: number) => BigInt(Math.round(p * 100));
    let reason: string | undefined,
      amount = quantity,
      level: number | undefined;
    if (proceeds * 10000n <= cost * (10000n - bps(settings.stopLossPct)))
      reason = "STOP_LOSS";
    else if (now - old.openedAt >= settings.maxHoldingSec * 1000)
      reason = "MAX_HOLD_TIME";
    else if (
      proceeds * BigInt(old.peakDenominator) * 10000n <=
      BigInt(old.peakNumerator) *
        quantity *
        (10000n - bps(settings.trailingStopPct))
    )
      reason = "TRAILING_STOP";
    else
      for (const [i, tp] of settings.takeProfit.entries())
        if (
          !old.takenLevels.includes(i) &&
          proceeds * 10000n >= cost * (10000n + bps(tp.gainPct))
        ) {
          reason = `TAKE_PROFIT_${tp.gainPct}`;
          level = i;
          amount = (BigInt(old.quantity) * bps(tp.sellPct)) / 10000n;
          if (amount > quantity) amount = quantity;
          break;
        }
    const next = { ...old };
    if (
      proceeds * BigInt(old.peakDenominator) >
      BigInt(old.peakNumerator) * quantity
    ) {
      next.peakNumerator = proceeds.toString();
      next.peakDenominator = quantity.toString();
    }
    if (!reason || amount <= 0n) {
      if (next.peakNumerator !== old.peakNumerator) await this.save(next);
      return;
    }
    const exit = (proceeds * amount) / quantity;
    next.remainingQuantity = (quantity - amount).toString();
    next.remainingCostQuote = (cost - (cost * amount) / quantity).toString();
    next.realizedQuoteAmount = (
      BigInt(old.realizedQuoteAmount) + exit
    ).toString();
    next.exitQuoteAmount = exit.toString();
    next.exitReason = reason;
    if (level !== undefined) next.takenLevels = [...next.takenLevels, level];
    if (next.remainingQuantity === "0") {
      next.state = "CLOSED";
      next.closedAt = now;
    }
    return this.save(next);
  }
}
