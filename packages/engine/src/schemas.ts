import { z } from "zod";
import {
  tokenStateSchema,
  tokenDiscoveryEventSchema,
  aiClassificationSchema,
  rugSnapshotSchema,
  entrySizingSchema,
  type Position,
  type CandidateRecord,
  type OutcomeRecord,
} from "@sniper/core";
const n = z.number().finite();
export const positionSchema: z.ZodType<Position> = z.object({
  id: z.string(),
  chainId: z.string(),
  tokenAddress: z.string(),
  symbol: z.string(),
  dexId: z.string(),
  entryPriceUsd: n.positive(),
  currentPriceUsd: n.positive(),
  investedUsd: n.positive(),
  remainingCostUsd: n.nonnegative(),
  quantity: z
    .string()
    .refine((s) => Number.isFinite(Number(s)) && Number(s) >= 0),
  initialQuantity: z
    .string()
    .refine((s) => Number.isFinite(Number(s)) && Number(s) > 0),
  openedAt: n,
  highestPriceUsd: n.positive(),
  realizedPnlUsd: n,
  unrealizedPnlUsd: n,
  closedAt: n.optional(),
  exitState: z.string(),
  takenLevels: z.array(n.int().nonnegative()),
  initialLiquidityUsd: n.nonnegative().optional(),
  source: z.enum(["MOCK", "RPC"]),
});
const decision = z.object({
  passed: z.boolean(),
  reasons: z.array(z.string()),
});
const event = z.object({
  id: z.string(),
  chainId: z.string(),
  tokenAddress: z.string(),
  poolAddress: z.string(),
  dexId: z.string(),
  timestamp: n,
  source: z.enum(["MOCK", "RPC"]),
  quoteTokenAddress: z.string().optional(),
  transactionId: z.string().optional(),
  chainTimestamp: n.optional(),
  detectedAt: n.optional(),
  rawEvent: z.unknown().optional(),
  pairClassification: z.enum(["TRUSTED_QUOTE", "UNKNOWN_PAIR"]).optional(),
  quoteAsset: tokenDiscoveryEventSchema.shape.quoteAsset,
});
const quote = z.object({
  id: z.string(),
  chainId: z.string(),
  tokenAddress: z.string(),
  dexId: z.string(),
  side: z.enum(["BUY", "SELL"]),
  inputAmount: n.positive(),
  expectedOutput: n.positive(),
  priceUsd: n.positive(),
  priceImpactPct: n.nonnegative(),
  feeUsd: n.nonnegative().optional(),
  expiresAt: n,
  source: z.enum(["MOCK", "RPC"]),
});
export const candidateSchema: z.ZodType<CandidateRecord> = z.object({
  entrySizing: entrySizingSchema.optional(),
  discoveryGuard: decision
    .extend({ latencyMs: n.nonnegative(), deferred: z.boolean().optional() })
    .optional(),
  analysisLatencyMs: n.nonnegative().optional(),
  lifecycle: z
    .object({
      identity: z.string(),
      firstSeenAt: n,
      launchedAt: n.optional(),
      graduatedAt: n.optional(),
      sources: z.array(z.string()),
      pools: z.array(z.string()),
      observations: z
        .array(
          z.object({
            source: z.string(),
            stage: z.string(),
            pool: z.string(),
            transactionId: z.string().optional(),
            creator: z.string().optional(),
            observedAt: n,
            onchainAt: n,
            quoteAsset: tokenDiscoveryEventSchema.shape.quoteAsset,
          }),
        )
        .max(16)
        .optional(),
    })
    .optional(),
  observation: z
    .object({
      stage: z.string(),
      liveBlockingReasons: z.array(z.string()),
      virtualAction: z.enum(["BUY", "WATCH", "SKIP"]).optional(),
      budgetUsd: z.literal("5"),
      sellability: z.enum(["SELLABLE", "NOT_SELLABLE", "UNKNOWN"]),
    })
    .optional(),
  rugCheck: rugSnapshotSchema.optional(),
  id: z.string(),
  strategyId: z.string().optional(),
  event,
  state: tokenStateSchema.optional(),
  hardFilter: decision.optional(),
  ai: aiClassificationSchema.optional(),
  score: z
    .object({
      total: n,
      components: z.record(z.string(), n),
      weights: z.record(z.string(), n),
    })
    .optional(),
  strategy: decision
    .extend({ strategyId: z.string(), action: z.enum(["BUY", "SKIP"]) })
    .optional(),
  risk: decision.optional(),
  quote: quote.optional(),
  aiAttempted: z.boolean().optional(),
  simulation: z
    .object({
      buy: z.object({
        success: z.boolean(),
        receivedAmount: n.positive().optional(),
        reasons: z.array(z.string()),
        source: z.enum(["MOCK", "RPC"]),
      }),
      sell: z.object({
        success: z.boolean(),
        receivedAmount: n.positive().optional(),
        reasons: z.array(z.string()),
        source: z.enum(["MOCK", "RPC"]),
      }),
      sellQuote: quote,
    })
    .optional(),
  action: z.enum(["BUY", "SKIP", "REJECT"]),
  reasons: z.array(z.string()),
  createdAt: n,
  timing: z
    .object({
      chainEvent: n.optional(),
      received: n,
      normalized: n.optional(),
      featuresReady: n.optional(),
      securityReady: n.optional(),
      hardFilterComplete: n.optional(),
      aiComplete: n.optional(),
      riskComplete: n.optional(),
      quoteReady: n.optional(),
      simulationComplete: n.optional(),
      broadcast: n.optional(),
      confirmation: n.optional(),
    })
    .optional(),
});
export const outcomeSchema: z.ZodType<OutcomeRecord> = z.object({
  liquidityByHorizon: z.record(z.string(), n.nonnegative()).optional(),
  candidateId: z.string(),
  chainId: z.string(),
  tokenAddress: z.string(),
  createdAt: n,
  initialPriceUsd: n.optional(),
  initialLiquidityUsd: n.optional(),
  prices: z.record(z.string(), n),
  maxGainPct: n.optional(),
  maxDrawdownPct: n.optional(),
  liquidityChangePct: n.optional(),
  completedHorizons: z.array(n),
  lastObservedAt: n.optional(),
  sampledAt: z.record(z.string(), n).optional(),
  missedHorizons: z.array(n).optional(),
});
