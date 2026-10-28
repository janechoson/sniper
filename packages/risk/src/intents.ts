import { randomUUID } from "node:crypto";
import {
  atomicQuoteSchema,
  type ApprovedTradeIntent,
  type ExecutionMode,
  type RoundTripResult,
  type Decision,
} from "@sniper/core";
export interface IntentApproval {
  decisionId: string;
  risk: Decision;
  walletId: string;
  walletAddress?: string;
  side: "BUY" | "SELL";
  mode: ExecutionMode;
  roundTrip: RoundTripResult;
  maxSlippageBps: number;
  maxPriceImpactPct: number;
  maxRoundTripLossPct: number;
  idempotencyKey: string;
  positionId?: string;
  allowQuoteOnlyPaper?: boolean;
  exitLevel?: number;
  positionPolicy?: ApprovedTradeIntent["positionPolicy"];
  entryLiquidityUsd?: number;
  entrySizing?: ApprovedTradeIntent["entrySizing"];
  valuation?: ApprovedTradeIntent["valuation"];
}
export class TradeIntentAuthority {
  private approved = new Map<string, string>();
  constructor(
    private readonly allowedNow: (intent: ApprovedTradeIntent) => boolean,
  ) {}
  invalidate() {
    this.approved.clear();
  }
  approve(input: IntentApproval): ApprovedTradeIntent {
    if (!input.risk.passed) throw new Error("RISK_REJECTED");
    const quote = atomicQuoteSchema.parse(input.roundTrip.buy);
    if (
      input.entrySizing &&
      (input.side !== "BUY" ||
        input.entrySizing.amountIn !== quote.amountIn ||
        input.entrySizing.tokenIn !== quote.tokenIn ||
        Date.now() - input.entrySizing.observedAt > 10000)
    )
      throw new Error("POSITION_SIZE_APPROVAL_MISMATCH");
    if (
      quote.expiresAt <= Date.now() ||
      quote.priceImpactPct === undefined ||
      quote.priceImpactPct > input.maxPriceImpactPct ||
      !input.walletId ||
      !input.idempotencyKey
    )
      throw new Error("INTENT_BOUNDS_INVALID");
    if (input.side === "BUY") {
      const trip = input.roundTrip;
      if (
        trip.roundTripLossPct === undefined ||
        trip.roundTripLossPct > input.maxRoundTripLossPct
      )
        throw new Error("ROUND_TRIP_LOSS");
      if (
        trip.sellability !== "SELLABLE" &&
        !(
          input.mode === "PAPER" &&
          input.allowQuoteOnlyPaper &&
          trip.sell &&
          trip.sellability === "UNKNOWN"
        )
      )
        throw new Error("SELLABILITY_NOT_PROVEN");
      if (
        input.mode !== "PAPER" &&
        (trip.evidence !== "TRANSACTION_SIMULATION" ||
          quote.estimatedNetworkFeeUsd === undefined ||
          trip.sell?.estimatedNetworkFeeUsd === undefined)
      )
        throw new Error("LIVE_COST_OR_SELL_SIMULATION_UNKNOWN");
    }
    const minimum =
      (BigInt(quote.expectedAmountOut) * BigInt(10000 - input.maxSlippageBps)) /
      10000n;
    if (BigInt(quote.minimumAmountOut) < minimum)
      throw new Error("SLIPPAGE_LIMIT");
    const intent: ApprovedTradeIntent = Object.freeze({
      id: randomUUID(),
      idempotencyKey: input.idempotencyKey,
      decisionId: input.decisionId,
      riskDecisionId: randomUUID(),
      walletId: input.walletId,
      walletAddress: input.walletAddress,
      chainId: quote.chainId,
      side: input.side,
      tokenIn: quote.tokenIn,
      tokenOut: quote.tokenOut,
      amountIn: quote.amountIn,
      entrySizing: input.entrySizing
        ? Object.freeze(structuredClone(input.entrySizing))
        : undefined,
      route: Object.freeze({
        quote: Object.freeze(structuredClone(quote)),
        providerId: quote.providerId,
        approvedAt: Date.now(),
      }),
      maxSlippageBps: input.maxSlippageBps,
      maxPriceImpactPct: input.maxPriceImpactPct,
      mode: input.mode,
      createdAt: Date.now(),
      expiresAt: quote.expiresAt,
      positionId: input.positionId,
      exitLevel: input.exitLevel,
      positionPolicy: input.positionPolicy
        ? structuredClone(input.positionPolicy)
        : undefined,
      entryLiquidityUsd: input.entryLiquidityUsd,
      valuation: input.valuation ? structuredClone(input.valuation) : undefined,
    });
    if (!this.allowedNow(intent)) throw new Error("EXECUTION_GATE_CLOSED");
    this.approved.set(intent.id, JSON.stringify(intent));
    return intent;
  }
  accepts(intent: ApprovedTradeIntent) {
    return (
      this.approved.get(intent.id) === JSON.stringify(intent) &&
      intent.expiresAt > Date.now() &&
      this.allowedNow(intent)
    );
  }
}
