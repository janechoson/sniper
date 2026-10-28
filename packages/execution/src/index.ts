import { randomUUID } from "node:crypto";
import {
  DomainError,
  type NormalizedTokenState,
  type Position,
  type TradeQuote,
} from "@sniper/core";
export interface EntryRequest {
  state: NormalizedTokenState;
  quote: TradeQuote;
  receivedQuantity: number;
  now: number;
}
export interface Executor {
  open(request: EntryRequest): Promise<Position>;
  close(
    position: Position,
    quote: TradeQuote,
    reason: string,
    now: number,
    level?: number,
  ): Promise<Position>;
}
export class PaperExecutor implements Executor {
  async open({
    state,
    quote,
    receivedQuantity,
    now,
  }: EntryRequest): Promise<Position> {
    if (quote.source !== "MOCK" || state.identity.source !== "MOCK")
      throw new DomainError(
        "EXECUTION_FAILURE",
        "Bộ giao dịch mô phỏng V1 chỉ nhận dữ liệu được đánh dấu giả lập rõ ràng",
      );
    if (
      quote.side !== "BUY" ||
      quote.chainId !== state.identity.chainId ||
      quote.tokenAddress !== state.identity.address ||
      quote.expiresAt <= now ||
      !Number.isFinite(quote.inputAmount) ||
      quote.inputAmount <= 0 ||
      !Number.isFinite(quote.priceUsd) ||
      quote.priceUsd <= 0 ||
      !Number.isFinite(receivedQuantity) ||
      receivedQuantity <= 0
    )
      throw new DomainError(
        "EXECUTION_FAILURE",
        "Lệnh mở vị thế mô phỏng không hợp lệ",
      );
    return {
      id: randomUUID(),
      chainId: quote.chainId,
      tokenAddress: quote.tokenAddress,
      symbol: state.identity.symbol ?? "UNKNOWN",
      dexId: quote.dexId,
      entryPriceUsd: quote.inputAmount / receivedQuantity,
      currentPriceUsd: quote.priceUsd,
      investedUsd: quote.inputAmount,
      remainingCostUsd: quote.inputAmount,
      quantity: String(receivedQuantity),
      initialQuantity: String(receivedQuantity),
      openedAt: now,
      highestPriceUsd: quote.priceUsd,
      realizedPnlUsd: 0,
      unrealizedPnlUsd: receivedQuantity * quote.priceUsd - quote.inputAmount,
      exitState: "MONITORING",
      takenLevels: [],
      initialLiquidityUsd: state.market.liquidityUsd,
      source: "MOCK",
    };
  }
  async close(
    position: Position,
    quote: TradeQuote,
    reason: string,
    now: number,
    level?: number,
  ): Promise<Position> {
    const remaining = Number(position.quantity);
    const quantity = quote.inputAmount;
    if (
      position.closedAt !== undefined ||
      quote.side !== "SELL" ||
      quote.chainId !== position.chainId ||
      quote.tokenAddress !== position.tokenAddress ||
      quote.source !== position.source ||
      quote.expiresAt <= now ||
      !Number.isFinite(quantity) ||
      quantity <= 0 ||
      quantity > remaining * (1 + 1e-10) ||
      !Number.isFinite(quote.expectedOutput) ||
      quote.expectedOutput <= 0
    )
      throw new DomainError(
        "EXECUTION_FAILURE",
        "Lệnh thoát vị thế mô phỏng không hợp lệ",
      );
    const fraction = Math.min(1, quantity / remaining);
    const allocatedCost = position.remainingCostUsd * fraction;
    const left = remaining - Math.min(remaining, quantity);
    const closed = left <= Number(position.initialQuantity) * 1e-10;
    return {
      ...position,
      quantity: closed ? "0" : String(left),
      remainingCostUsd: closed ? 0 : position.remainingCostUsd - allocatedCost,
      realizedPnlUsd:
        position.realizedPnlUsd + quote.expectedOutput - allocatedCost,
      unrealizedPnlUsd: closed
        ? 0
        : left * quote.priceUsd - (position.remainingCostUsd - allocatedCost),
      currentPriceUsd: quote.priceUsd,
      exitState: reason,
      closedAt: closed ? now : undefined,
      takenLevels:
        level === undefined
          ? [...position.takenLevels]
          : [...position.takenLevels, level],
    };
  }
}
export class LiveExecutor implements Executor {
  async open(_request: EntryRequest): Promise<Position> {
    throw new DomainError(
      "EXECUTION_FAILURE",
      "LIVE_DISABLED: chưa có bộ ký đã kiểm toán, mô phỏng thật và phê duyệt tích hợp",
    );
  }
  async close(
    _position: Position,
    _quote: TradeQuote,
    _reason: string,
    _now: number,
  ): Promise<Position> {
    throw new DomainError("EXECUTION_FAILURE", "LIVE_DISABLED");
  }
}
export * from "./durable";
export * from "./atomic-paper";
export * from "./evm-live";
export * from "./solana-live";
export * from "./evm-round-trip";
export * from "./solana-round-trip";
