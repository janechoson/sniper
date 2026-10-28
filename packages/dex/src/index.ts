import { randomUUID } from "node:crypto";
import {
  DomainError,
  type DexAdapter,
  type PoolEvent,
  type PoolState,
  type QuoteRequest,
  type TradeQuote,
  type SwapRequest,
  type SimulationResult,
} from "@sniper/core";
export interface DexDeployment {
  id: string;
  chainId: string;
  family: "uniswap-v2" | "uniswap-v3" | "pancakeswap" | "raydium" | "meteora";
  factoryOrProgramAddress?: string;
  routerAddress?: string;
  verifiedSource?: string;
}
// Các họ giao thức dùng chung ranh giới chặn an toàn cho đến khi có bộ theo dõi,
// giải mã, báo giá và mô phỏng phù hợp với từng bản triển khai.
export class UnconfiguredDexAdapter implements DexAdapter {
  readonly id: string;
  readonly chainId: string;
  constructor(readonly deployment: DexDeployment) {
    this.id = deployment.id;
    this.chainId = deployment.chainId;
  }
  async *watchPools(): AsyncIterable<PoolEvent> {
    throw new DomainError(
      "CONFIGURATION_ERROR",
      "Cần thông tin triển khai DEX đã xác minh và bộ giải mã sự kiện",
    );
  }
  async getPoolState(_address: string): Promise<PoolState> {
    throw new DomainError(
      "DEX_ERROR",
      "Chưa cấu hình bộ đọc bể thanh khoản DEX",
    );
  }
  async getQuote(_request: QuoteRequest): Promise<TradeQuote> {
    throw new DomainError("DEX_ERROR", "Chưa triển khai bộ báo giá DEX");
  }
  async simulateSwap(_request: SwapRequest): Promise<SimulationResult> {
    return { success: false, reasons: ["DEX_UNCONFIGURED"], source: "RPC" };
  }
}
export class MockDexAdapter implements DexAdapter {
  readonly id = "mock-constant-product";
  constructor(
    readonly chainId: string,
    private readonly market: (
      address: string,
    ) => { priceUsd: number; liquidityUsd: number } | undefined,
    private readonly now = Date.now,
  ) {}
  async *watchPools(): AsyncIterable<PoolEvent> {
    /* Bộ quét giả lập chịu trách nhiệm phát sự kiện bể thanh khoản giả lập. */
  }
  async getPoolState(address: string): Promise<PoolState> {
    return { address, ...this.market(address) };
  }
  async getQuote(request: QuoteRequest): Promise<TradeQuote> {
    const market = this.market(request.tokenAddress);
    if (
      request.chainId !== this.chainId ||
      !market ||
      market.priceUsd <= 0 ||
      market.liquidityUsd <= 0 ||
      !Number.isFinite(request.amount) ||
      request.amount <= 0
    )
      throw new DomainError(
        "DEX_ERROR",
        "Thị trường giả lập hoặc số lượng không hợp lệ",
      );
    const usd =
      request.side === "BUY"
        ? request.amount
        : request.amount * market.priceUsd;
    const feeUsd = usd * 0.003;
    const impact = (usd / (market.liquidityUsd / 2 + usd)) * 100;
    const outputUsd =
      (usd - feeUsd) * (1 - impact / 100) * (1 - request.slippageBps / 10000);
    return {
      id: randomUUID(),
      chainId: this.chainId,
      tokenAddress: request.tokenAddress,
      dexId: this.id,
      side: request.side,
      inputAmount: request.amount,
      expectedOutput:
        request.side === "BUY" ? outputUsd / market.priceUsd : outputUsd,
      priceUsd: market.priceUsd,
      priceImpactPct: impact,
      feeUsd,
      expiresAt: this.now() + 5000,
      source: "MOCK",
    };
  }
  async simulateSwap({ quote }: SwapRequest): Promise<SimulationResult> {
    return {
      success: quote.expiresAt > this.now() && quote.expectedOutput > 0,
      receivedAmount: quote.expectedOutput,
      reasons: quote.expiresAt <= this.now() ? ["STALE_QUOTE"] : [],
      source: "MOCK",
    };
  }
}
export * from "./evm-swap";
export * from "./jupiter";
