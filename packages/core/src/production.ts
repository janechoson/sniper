import { z } from "zod";
export const executionModeSchema = z.enum(["PAPER", "LIVE_DRY_RUN", "LIVE"]);
export type ExecutionMode = z.infer<typeof executionModeSchema>;
export type DataMode = "mock" | "real";
export type DataQuality = "REAL" | "ESTIMATED" | "UNKNOWN";
export interface FeatureEvidence {
  quality: DataQuality;
  source: string;
  observedAt: number;
  detail?: string;
}
export interface ProviderHealth {
  id: string;
  status: "READY" | "DEGRADED" | "DOWN" | "NOT_STARTED";
  checkedAt: number;
  reasons: string[];
}
export const atomicAmountSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)$/)
  .max(78)
  .refine((s) => BigInt(s) < 2n ** 256n, "Số lượng vượt uint256");
export const usdAmountSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)(\.\d{1,18})?$/)
  .max(100);
export const entrySizingSchema = z
  .object({
    percent: z.number().finite().gt(0).max(100),
    tokenIn: z.string(),
    balanceRaw: atomicAmountSchema,
    reservedRaw: atomicAmountSchema,
    availableRaw: atomicAmountSchema,
    nativeReserveRaw: atomicAmountSchema,
    amountIn: atomicAmountSchema,
    costUsd: usdAmountSchema,
    observedAt: z.number().finite(),
  })
  .strict();
export type EntrySizing = z.infer<typeof entrySizingSchema>;
export const atomicQuoteSchema = z
  .object({
    id: z.string().min(1),
    providerId: z.string().min(1),
    chainId: z.string().min(1),
    tokenIn: z.string().min(1),
    tokenOut: z.string().min(1),
    amountIn: atomicAmountSchema,
    expectedAmountOut: atomicAmountSchema,
    minimumAmountOut: atomicAmountSchema,
    decimalsIn: z.number().int().min(0).max(255),
    decimalsOut: z.number().int().min(0).max(255),
    priceImpactPct: z.number().finite().min(0).max(100).optional(),
    estimatedNetworkFeeUsd: usdAmountSchema.optional(),
    estimatedDexFeeUsd: usdAmountSchema.optional(),
    quotedAt: z.number().finite(),
    expiresAt: z.number().finite(),
    source: z.literal("RPC"),
    quality: z.enum(["REAL", "ESTIMATED"]),
    routeSummary: z.string().optional(),
    rawProviderData: z.unknown().optional(),
    nativeInput: z.boolean().optional(),
    nativeOutput: z.boolean().optional(),
  })
  .strict()
  .superRefine((q, ctx) => {
    if (BigInt(q.minimumAmountOut) > BigInt(q.expectedAmountOut))
      ctx.addIssue({
        code: "custom",
        message: "Đầu ra tối thiểu vượt đầu ra dự kiến",
      });
    if (q.expiresAt <= q.quotedAt)
      ctx.addIssue({ code: "custom", message: "Hạn báo giá không hợp lệ" });
  });
export type AtomicTradeQuote = z.infer<typeof atomicQuoteSchema>;
export interface AtomicQuoteRequest {
  chainId: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  decimalsIn: number;
  decimalsOut: number;
  slippageBps: number;
  walletAddress?: string;
  nativeInput?: boolean;
  nativeOutput?: boolean;
}
export type UnsignedSwapTransaction =
  | {
      family: "evm";
      chainId: string;
      evmChainId: number;
      walletAddress: string;
      quoteId: string;
      providerId: string;
      to: `0x${string}`;
      data: `0x${string}`;
      value: string;
      validUntil: number;
      wrappedNative?: `0x${string}`;
      approval?: {
        token: `0x${string}`;
        spender: `0x${string}`;
        amount: string;
      };
    }
  | {
      family: "solana";
      chainId: string;
      walletAddress: string;
      quoteId: string;
      providerId: string;
      transactionBase64: string;
      lastValidBlockHeight: number;
      validUntil: number;
      allowedPrograms: string[];
    };
export interface SwapProvider {
  readonly id: string;
  readonly chainId: string;
  supports(request: AtomicQuoteRequest): boolean;
  getQuote(request: AtomicQuoteRequest): Promise<AtomicTradeQuote>;
  buildSwap(
    quote: AtomicTradeQuote,
    walletAddress: string,
  ): Promise<UnsignedSwapTransaction>;
  healthCheck(): Promise<ProviderHealth>;
}
export interface ApprovedRoute {
  quote: AtomicTradeQuote;
  providerId: string;
  approvedAt: number;
}
export interface RoundTripResult {
  buy: AtomicTradeQuote;
  sell?: AtomicTradeQuote;
  sellability: "SELLABLE" | "NOT_SELLABLE" | "UNKNOWN";
  evidence: "QUOTE_ONLY" | "TRANSACTION_SIMULATION";
  roundTripLossPct?: number;
  reasons: string[];
}
export interface ApprovedTradeIntent {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly decisionId: string;
  readonly riskDecisionId: string;
  readonly walletId: string;
  readonly walletAddress?: string;
  readonly chainId: string;
  readonly side: "BUY" | "SELL";
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly amountIn: string;
  readonly entrySizing?: EntrySizing;
  readonly route: ApprovedRoute;
  readonly maxSlippageBps: number;
  readonly maxPriceImpactPct: number;
  readonly mode: ExecutionMode;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly positionId?: string;
  readonly exitLevel?: number;
  readonly positionPolicy?: {
    stopLossPct: number;
    trailingStopPct: number;
    maxHoldingSec: number;
    liquidityCollapsePct?: number;
    takeProfit: { gainPct: number; sellPct: number }[];
  };
  readonly entryLiquidityUsd?: number;
  readonly valuation?: {
    quoteUsdPrice: string;
    nativeUsdPrice?: string;
    nativeDecimals: number;
  };
}
export type ExecutionState =
  | "APPROVED"
  | "BUILDING"
  | "SIMULATING"
  | "DRY_RUN_SUCCEEDED"
  | "SUBMITTING"
  | "PENDING"
  | "CONFIRMED"
  | "FAILED"
  | "UNKNOWN";
export interface ExecutionRecord {
  id: string;
  intentId: string;
  idempotencyKey: string;
  walletId: string;
  chainId: string;
  mode: ExecutionMode;
  state: ExecutionState;
  updatedAt: number;
  transactionId?: string;
  approvalTransactionIds?: string[];
  actualAmountIn?: string;
  actualAmountOut?: string;
  networkFee?: string;
  operation?: "SWAP" | "APPROVAL";
  stages?: Record<string, number>;
  approval?: { token: string; spender: string; amount: string };
  simulation?: {
    amountIn: string;
    amountOut: string;
    evidence: "CALL_RETURN" | "BALANCE_DELTA";
  };
  reasons: string[];
}
export interface PublicWallet {
  id: string;
  label: string;
  address: string;
  family: "evm" | "solana";
  chains: string[];
  enabled: boolean;
  signerType: "local-env" | "local-file" | "watch-only";
}
export interface WalletDefinition {
  id: string;
  label: string;
  family: "evm" | "solana";
  chains: string[];
  enabled: boolean;
  address?: string;
  signerType: "local-env" | "local-file" | "watch-only";
  secretRef?: string;
}
export interface WalletBalance {
  walletId: string;
  chainId: string;
  nativeAmount: string;
  nativeDecimals: number;
  tokens: { address: string; amount: string; decimals: number }[];
  observedAt: number;
  quality: "REAL";
}
export interface ReadinessItem {
  component: string;
  required: boolean;
  status: "READY" | "FAIL" | "DEGRADED" | "NOT_STARTED";
  reasons: string[];
}
export interface LiveReadiness {
  mode: ExecutionMode;
  ready: boolean;
  items: ReadinessItem[];
  checkedAt: number;
  capabilities?: Record<
    string,
    "READY" | "PARTIAL" | "BLOCKED" | "CANARY_REQUIRED" | "LOCKED"
  >;
  liveDryRunReady?: boolean;
  liveReady?: boolean;
}
export interface ManagedPosition {
  id: string;
  walletId: string;
  walletAddress?: string;
  chainId: string;
  tokenAddress: string;
  quoteTokenAddress: string;
  decimals: number;
  quoteDecimals: number;
  providerId: string;
  mode: ExecutionMode;
  state:
    | "PENDING_ENTRY"
    | "OPEN"
    | "PARTIAL_EXIT"
    | "PENDING_EXIT"
    | "CLOSED"
    | "FAILED";
  initialQuantity: string;
  remainingQuantity: string;
  investedQuoteAmount: string;
  remainingCostQuoteAmount: string;
  realizedQuotePnl: string;
  entryTransactionId?: string;
  exitTransactionIds: string[];
  openedAt: number;
  updatedAt: number;
  takenLevels: number[];
  highestPriceUsd?: number;
  entryPriceUsd?: number;
  markPnlUsd?: number;
  executablePnlUsd?: number;
  exitReason?: string;
  initialLiquidityUsd?: number;
  peakExitQuote?: { amount: string; quantity: string };
  latestExitQuoteAmount?: string;
  exitQuoteObservedAt?: number;
  exitPolicy: {
    stopLossPct: number;
    trailingStopPct: number;
    maxHoldingSec: number;
    liquidityCollapsePct?: number;
    takeProfit: { gainPct: number; sellPct: number }[];
  };
}
export interface PipelineTiming {
  chainEvent?: number;
  received: number;
  normalized?: number;
  featuresReady?: number;
  securityReady?: number;
  hardFilterComplete?: number;
  aiComplete?: number;
  riskComplete?: number;
  quoteReady?: number;
  simulationComplete?: number;
  broadcast?: number;
  confirmation?: number;
}
export interface StrategyAnalytics {
  scope: {
    cachedCandidates: number;
    closedTrades: number;
    unknownNetResults: number;
  };
  candidateCount: number;
  tradeCount: number;
  winRate: number | null;
  averageReturnPct: number | null;
  medianReturnPct: number | null;
  profitFactor: number | null;
  maxDrawdownUsd: number | null;
  averageHoldingSec: number | null;
  byChain: Record<
    string,
    { candidates: number; trades: number; netPnlUsd: number | null }
  >;
  byDex: Record<
    string,
    { candidates: number; trades: number; netPnlUsd: number | null }
  >;
  byStrategy: Record<
    string,
    { candidates: number; trades: number; netPnlUsd: number | null }
  >;
  byScoreBucket: Record<string, number>;
  byConfidenceBucket: Record<string, number>;
  latency: Record<
    string,
    { samples: number; averageMs: number | null; medianMs: number | null }
  >;
  realizedEquity: { at: number; pnlUsd: number | null }[];
}
export const approvedIntentSchema = z
  .object({
    id: z.string(),
    idempotencyKey: z.string(),
    decisionId: z.string(),
    riskDecisionId: z.string(),
    walletId: z.string(),
    walletAddress: z.string().optional(),
    chainId: z.string(),
    side: z.enum(["BUY", "SELL"]),
    tokenIn: z.string(),
    tokenOut: z.string(),
    amountIn: atomicAmountSchema,
    entrySizing: entrySizingSchema.optional(),
    route: z.object({
      quote: atomicQuoteSchema,
      providerId: z.string(),
      approvedAt: z.number(),
    }),
    maxSlippageBps: z.number().int().min(0).max(2000),
    maxPriceImpactPct: z.number().min(0).max(100),
    mode: executionModeSchema,
    createdAt: z.number(),
    expiresAt: z.number(),
    positionId: z.string().optional(),
    exitLevel: z.number().int().nonnegative().optional(),
    entryLiquidityUsd: z.number().finite().nonnegative().optional(),
    valuation: z
      .object({
        quoteUsdPrice: usdAmountSchema,
        nativeUsdPrice: usdAmountSchema.optional(),
        nativeDecimals: z.number().int().min(0).max(255),
      })
      .optional(),
    positionPolicy: z
      .object({
        stopLossPct: z.number().positive().max(90),
        trailingStopPct: z.number().positive().max(90),
        maxHoldingSec: z.number().int().positive(),
        liquidityCollapsePct: z.number().positive().max(100).optional(),
        takeProfit: z.array(
          z.object({
            gainPct: z.number().positive(),
            sellPct: z.number().positive().max(100),
          }),
        ),
      })
      .optional(),
  })
  .strict();
export const managedPositionSchema = z
  .object({
    id: z.string(),
    walletId: z.string(),
    walletAddress: z.string().optional(),
    chainId: z.string(),
    tokenAddress: z.string(),
    quoteTokenAddress: z.string(),
    decimals: z.number().int(),
    quoteDecimals: z.number().int(),
    providerId: z.string(),
    mode: executionModeSchema,
    state: z.enum([
      "PENDING_ENTRY",
      "OPEN",
      "PARTIAL_EXIT",
      "PENDING_EXIT",
      "CLOSED",
      "FAILED",
    ]),
    initialQuantity: atomicAmountSchema,
    remainingQuantity: atomicAmountSchema,
    investedQuoteAmount: atomicAmountSchema,
    remainingCostQuoteAmount: atomicAmountSchema,
    realizedQuotePnl: z.string().regex(/^-?\d+$/),
    entryTransactionId: z.string().optional(),
    exitTransactionIds: z.array(z.string()),
    openedAt: z.number(),
    updatedAt: z.number(),
    takenLevels: z.array(z.number().int()),
    highestPriceUsd: z.number().optional(),
    entryPriceUsd: z.number().optional(),
    markPnlUsd: z.number().optional(),
    executablePnlUsd: z.number().optional(),
    exitReason: z.string().optional(),
    initialLiquidityUsd: z.number().finite().nonnegative().optional(),
    peakExitQuote: z
      .object({ amount: atomicAmountSchema, quantity: atomicAmountSchema })
      .optional(),
    latestExitQuoteAmount: atomicAmountSchema.optional(),
    exitQuoteObservedAt: z.number().finite().optional(),
    exitPolicy: z.object({
      stopLossPct: z.number(),
      trailingStopPct: z.number(),
      maxHoldingSec: z.number(),
      liquidityCollapsePct: z.number().optional(),
      takeProfit: z.array(
        z.object({ gainPct: z.number(), sellPct: z.number() }),
      ),
    }),
  })
  .strict();
