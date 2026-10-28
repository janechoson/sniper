import { z } from "zod";
import {
  DomainError,
  type DexAdapter,
  type QuoteRequest,
  type TradeQuote,
  type SimulationResult,
} from "@sniper/core";
import { withTimeout } from "@sniper/shared";
const quoteSchema = z.object({
  id: z.string().min(1),
  chainId: z.string(),
  tokenAddress: z.string(),
  dexId: z.string(),
  side: z.enum(["BUY", "SELL"]),
  inputAmount: z.number().finite().positive(),
  expectedOutput: z.number().finite().positive(),
  priceUsd: z.number().finite().positive(),
  priceImpactPct: z.number().finite().min(0).max(100),
  feeUsd: z.number().finite().nonnegative().optional(),
  expiresAt: z.number().finite(),
  source: z.enum(["MOCK", "RPC"]),
});
const simulationSchema = z.object({
  success: z.boolean(),
  receivedAmount: z.number().finite().positive().optional(),
  reasons: z.array(z.string()),
  source: z.enum(["MOCK", "RPC"]),
});
export class RouteEngine {
  constructor(
    private readonly venues: DexAdapter[],
    private readonly now = Date.now,
  ) {}
  private validate(
    input: unknown,
    request: QuoteRequest,
    venue: DexAdapter,
  ): TradeQuote {
    const quote = quoteSchema.parse(input);
    if (
      quote.chainId !== request.chainId ||
      quote.tokenAddress !== request.tokenAddress ||
      quote.side !== request.side ||
      quote.inputAmount !== request.amount ||
      quote.dexId !== venue.id ||
      quote.expiresAt <= this.now()
    )
      throw new DomainError("DEX_ERROR", "Báo giá không khớp hoặc đã hết hạn");
    return quote;
  }
  async quote(request: QuoteRequest, maxImpactPct = 100): Promise<TradeQuote> {
    const results = await Promise.allSettled(
      this.venues
        .filter((v) => v.chainId === request.chainId)
        .map(async (venue) =>
          this.validate(
            await withTimeout(venue.getQuote(request), 2500),
            request,
            venue,
          ),
        ),
    );
    const quotes = results.flatMap((result) =>
      result.status === "fulfilled" &&
      result.value.priceImpactPct <= maxImpactPct
        ? [result.value]
        : [],
    );
    quotes.sort((a, b) => b.expectedOutput - a.expectedOutput);
    if (!quotes[0])
      throw new DomainError(
        "DEX_ERROR",
        "Không có tuyến giao dịch khả dụng trong giới hạn tác động giá",
      );
    return quotes[0];
  }
  async simulate(quote: TradeQuote): Promise<SimulationResult> {
    if (quote.expiresAt <= this.now())
      return { success: false, reasons: ["STALE_QUOTE"], source: quote.source };
    const venue = this.venues.find(
      (v) => v.id === quote.dexId && v.chainId === quote.chainId,
    );
    if (!venue)
      return {
        success: false,
        reasons: ["ROUTE_UNAVAILABLE"],
        source: quote.source,
      };
    const result = simulationSchema.parse(
      await withTimeout(venue.simulateSwap({ quote }), 2500),
    );
    if (
      result.source !== quote.source ||
      !result.success ||
      !Number.isFinite(result.receivedAmount) ||
      result.receivedAmount! <= 0
    )
      return {
        success: false,
        reasons: result.reasons.length
          ? result.reasons
          : ["INVALID_SIMULATION_OUTPUT"],
        source: quote.source,
      };
    return result;
  }
  async roundTrip(request: QuoteRequest, maxImpactPct: number) {
    const buy = await this.quote({ ...request, side: "BUY" }, maxImpactPct);
    const buySimulation = await this.simulate(buy);
    if (!buySimulation.success)
      throw new DomainError("SIMULATION_FAILURE", "Mô phỏng mua thất bại");
    const sell = await this.quote(
      { ...request, side: "SELL", amount: buySimulation.receivedAmount! },
      maxImpactPct,
    );
    const sellSimulation = await this.simulate(sell);
    if (!sellSimulation.success || sell.source !== buy.source)
      throw new DomainError(
        "SIMULATION_FAILURE",
        "Mô phỏng bán thất bại; đã từ chối mở vị thế",
      );
    return { buy, sell, buySimulation, sellSimulation };
  }
}
export * from "./atomic";
