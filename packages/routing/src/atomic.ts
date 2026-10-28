import {
  atomicQuoteSchema,
  type AtomicQuoteRequest,
  type AtomicTradeQuote,
  type SwapProvider,
  type RoundTripResult,
} from "@sniper/core";
import { ratioToNumber, withTimeout } from "@sniper/shared";
export class AtomicRouteEngine {
  constructor(
    private readonly providers: SwapProvider[],
    private readonly now = Date.now,
  ) {}
  provider(id: string, chainId: string) {
    const provider = this.providers.find(
      (p) => p.id === id && p.chainId === chainId,
    );
    if (!provider) throw new Error("ROUTE_UNAVAILABLE");
    return provider;
  }
  async quote(
    request: AtomicQuoteRequest,
    maxImpactPct: number,
  ): Promise<AtomicTradeQuote> {
    const results = await Promise.allSettled(
      this.providers
        .filter((p) => p.supports(request))
        .map(async (p) => {
          const quote = atomicQuoteSchema.parse(
            await withTimeout(p.getQuote(request), 10000),
          );
          if (
            quote.providerId !== p.id ||
            quote.chainId !== request.chainId ||
            quote.tokenIn !== request.tokenIn ||
            quote.tokenOut !== request.tokenOut ||
            quote.amountIn !== request.amountIn ||
            (request.nativeInput !== undefined &&
              !!quote.nativeInput !== request.nativeInput) ||
            (request.nativeOutput !== undefined &&
              !!quote.nativeOutput !== request.nativeOutput) ||
            quote.decimalsIn !== request.decimalsIn ||
            quote.decimalsOut !== request.decimalsOut ||
            quote.expiresAt <= this.now() ||
            quote.quotedAt > this.now() + 1000 ||
            BigInt(quote.expectedAmountOut) === 0n ||
            BigInt(quote.minimumAmountOut) === 0n ||
            quote.priceImpactPct === undefined ||
            quote.priceImpactPct > maxImpactPct
          )
            throw new Error("INVALID_OR_UNBOUNDED_QUOTE");
          return quote;
        }),
    );
    const quotes = results.flatMap((r) =>
      r.status === "fulfilled" ? [r.value] : [],
    );
    quotes.sort((a, b) =>
      BigInt(a.minimumAmountOut) > BigInt(b.minimumAmountOut)
        ? -1
        : BigInt(a.minimumAmountOut) < BigInt(b.minimumAmountOut)
          ? 1
          : 0,
    );
    if (!quotes[0]) throw new Error("NO_VALID_REAL_ROUTE");
    return quotes[0];
  }
  async roundTrip(
    request: AtomicQuoteRequest,
    maxImpactPct: number,
  ): Promise<RoundTripResult> {
    const buy = await this.quote(request, maxImpactPct);
    try {
      const sell = await this.quote(
        {
          ...request,
          tokenIn: request.tokenOut,
          tokenOut: request.tokenIn,
          nativeInput: request.nativeOutput,
          nativeOutput: request.nativeInput,
          amountIn: buy.minimumAmountOut,
          decimalsIn: request.decimalsOut,
          decimalsOut: request.decimalsIn,
        },
        maxImpactPct,
      );
      const ratio = ratioToNumber(
        BigInt(sell.minimumAmountOut),
        BigInt(buy.amountIn),
      );
      return {
        buy,
        sell,
        sellability: "UNKNOWN",
        evidence: "QUOTE_ONLY",
        roundTripLossPct:
          ratio === undefined ? undefined : Math.max(0, (1 - ratio) * 100),
        reasons: [
          "QUOTE_IS_NOT_PROOF_OF_SELLABILITY",
          "NETWORK_FEES_NOT_INCLUDED",
        ],
      };
    } catch {
      return {
        buy,
        sellability: "UNKNOWN",
        evidence: "QUOTE_ONLY",
        reasons: ["REVERSE_ROUTE_UNAVAILABLE"],
      };
    }
  }
}
