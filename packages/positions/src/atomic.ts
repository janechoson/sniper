import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  managedPositionSchema,
  type ManagedPosition,
  type ExecutionRecord,
  type ApprovedTradeIntent,
} from "@sniper/core";
import type { Settings } from "@sniper/config";
import type { Repository } from "@sniper/storage";
const applied = z.object({
  executionId: z.string(),
  position: managedPositionSchema,
});
export class AtomicPositionManager {
  private positions = new Map<string, ManagedPosition>();
  private executions = new Set<string>();
  constructor(private readonly repository: Repository) {}
  async restore() {
    for (const row of await this.repository.read())
      if (row.kind === "position.atomic") {
        const value = applied.parse(row.payload);
        this.positions.set(value.position.id, value.position);
        this.executions.add(value.executionId);
      } else if (row.kind === "position.mark") {
        const value = managedPositionSchema.parse(row.payload);
        this.positions.set(value.id, value);
      }
  }
  all() {
    return [...this.positions.values()].map((p) => structuredClone(p));
  }
  hasApplied(executionId: string) {
    return this.executions.has(executionId);
  }
  get(id: string) {
    const p = this.positions.get(id);
    return p ? structuredClone(p) : undefined;
  }
  async applyFill(
    record: ExecutionRecord,
    intent: ApprovedTradeIntent,
    settings: Settings,
  ) {
    if (this.executions.has(record.id)) return;
    if (
      record.state !== "CONFIRMED" ||
      record.operation === "APPROVAL" ||
      record.actualAmountIn === undefined ||
      record.actualAmountOut === undefined ||
      record.intentId !== intent.id ||
      record.mode !== intent.mode
    )
      throw new Error("UNCONFIRMED_POSITION_FILL");
    let position: ManagedPosition;
    if (intent.side === "BUY") {
      const quantity = BigInt(record.actualAmountOut);
      if (quantity <= 0n) throw new Error("ZERO_FILL");
      position = {
        id: `position:${intent.id}`,
        walletId: intent.walletId,
        walletAddress: intent.walletAddress,
        chainId: intent.chainId,
        tokenAddress: intent.tokenOut,
        quoteTokenAddress: intent.tokenIn,
        decimals: intent.route.quote.decimalsOut,
        quoteDecimals: intent.route.quote.decimalsIn,
        providerId: intent.route.providerId,
        mode: intent.mode,
        state: "OPEN",
        initialQuantity: quantity.toString(),
        remainingQuantity: quantity.toString(),
        investedQuoteAmount: record.actualAmountIn,
        remainingCostQuoteAmount: record.actualAmountIn,
        realizedQuotePnl: "0",
        entryTransactionId: record.transactionId,
        exitTransactionIds: [],
        openedAt: record.updatedAt,
        updatedAt: record.updatedAt,
        takenLevels: [],
        initialLiquidityUsd: intent.entryLiquidityUsd,
        exitPolicy: intent.positionPolicy ?? {
          stopLossPct: settings.stopLossPct,
          trailingStopPct: settings.trailingStopPct,
          maxHoldingSec: settings.maxHoldingSec,
          liquidityCollapsePct: settings.liquidityCollapsePct,
          takeProfit: structuredClone(settings.takeProfit),
        },
      };
    } else {
      if (!intent.positionId) throw new Error("EXIT_POSITION_REQUIRED");
      const old = this.positions.get(intent.positionId);
      if (
        !old ||
        old.walletId !== intent.walletId ||
        old.walletAddress !== intent.walletAddress ||
        old.chainId !== intent.chainId ||
        old.tokenAddress !== intent.tokenIn ||
        old.quoteTokenAddress !== intent.tokenOut ||
        old.mode !== intent.mode
      )
        throw new Error("EXIT_POSITION_MISMATCH");
      const sold = BigInt(record.actualAmountIn),
        remaining = BigInt(old.remainingQuantity);
      if (sold <= 0n || sold > remaining) throw new Error("EXIT_OVERSELL");
      const cost = (BigInt(old.remainingCostQuoteAmount) * sold) / remaining;
      position = {
        ...old,
        remainingQuantity: (remaining - sold).toString(),
        remainingCostQuoteAmount: (
          BigInt(old.remainingCostQuoteAmount) - cost
        ).toString(),
        realizedQuotePnl: (
          BigInt(old.realizedQuotePnl) +
          BigInt(record.actualAmountOut) -
          cost
        ).toString(),
        state: sold === remaining ? "CLOSED" : "PARTIAL_EXIT",
        exitTransactionIds: record.transactionId
          ? [...old.exitTransactionIds, record.transactionId]
          : old.exitTransactionIds,
        updatedAt: record.updatedAt,
        latestExitQuoteAmount: undefined,
        exitQuoteObservedAt: undefined,
        takenLevels:
          intent.exitLevel === undefined
            ? old.takenLevels
            : [...new Set([...old.takenLevels, intent.exitLevel])],
      };
    }
    const safe = managedPositionSchema.parse(position);
    await this.repository.append({
      id: randomUUID(),
      kind: "position.atomic",
      chainId: position.chainId,
      tokenAddress: position.tokenAddress,
      payload: { executionId: record.id, position: safe },
      createdAt: Date.now(),
    });
    this.positions.set(safe.id, safe);
    this.executions.add(record.id);
  }
  async observeExitQuote(id: string, amount: string, expectedQuantity: string) {
    const current = this.positions.get(id);
    if (
      !current ||
      current.remainingQuantity !== expectedQuantity ||
      current.state === "CLOSED"
    )
      return;
    const quote = BigInt(amount),
      quantity = BigInt(expectedQuantity);
    if (quote <= 0n || quantity <= 0n) return;
    const old = current.peakExitQuote;
    const peak =
      !old || quote * BigInt(old.quantity) > BigInt(old.amount) * quantity
        ? { amount, quantity: expectedQuantity }
        : old;
    const position = managedPositionSchema.parse({
      ...current,
      peakExitQuote: peak,
      latestExitQuoteAmount: amount,
      exitQuoteObservedAt: Date.now(),
      updatedAt: Date.now(),
    });
    await this.repository.append({
      id: randomUUID(),
      kind: "position.mark",
      chainId: position.chainId,
      tokenAddress: position.tokenAddress,
      payload: position,
      createdAt: Date.now(),
    });
    this.positions.set(id, position);
  }
}
