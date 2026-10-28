import type { ApprovedTradeIntent, ExecutionRecord } from "@sniper/core";
import { DurableExecutionStore } from "./durable";
export class RealPaperExecutor {
  constructor(
    private readonly store: DurableExecutionStore,
    private readonly authorized: (intent: ApprovedTradeIntent) => boolean,
  ) {}
  async execute(intent: ApprovedTradeIntent): Promise<ExecutionRecord> {
    return this.store.lock.run(intent.idempotencyKey, async () => {
      const prior = this.store.get(intent.idempotencyKey);
      if (prior && (prior.state !== "APPROVED" || prior.intentId !== intent.id))
        return prior;
      if (intent.mode !== "PAPER" || !this.authorized(intent))
        throw new Error("PAPER_INTENT_NOT_APPROVED");
      const record = await this.store.begin(intent);
      if (!this.authorized(intent))
        return this.store.put({
          ...record,
          state: "FAILED",
          reasons: ["STALE_OR_REVOKED_INTENT"],
          updatedAt: Date.now(),
        });
      return this.store.put({
        ...record,
        state: "CONFIRMED",
        actualAmountIn: intent.amountIn,
        actualAmountOut: intent.route.quote.minimumAmountOut,
        reasons: [
          "REAL_QUOTE_PAPER_FILL",
          "GAS_COST_UNKNOWN",
          "TRANSFER_TAX_NOT_SIMULATED",
        ],
        updatedAt: Date.now(),
      });
    });
  }
}
