import { z } from "zod";
import type { ProviderHealth, RoundTripResult } from "./production";
export const evidenceStateSchema = z.enum([
  "SAFE",
  "RISK",
  "UNKNOWN",
  "NOT_APPLICABLE",
]);
export const evidenceOriginSchema = z.enum([
  "REAL_ONCHAIN",
  "REAL_SIMULATION",
  "REAL_EXTERNAL",
  "REAL_INTERNAL",
  "ESTIMATED",
  "UNKNOWN",
  "MOCK",
]);
export const evidenceSchema = z
  .object({
    value: z.union([
      z.string().max(1024),
      z.number().finite(),
      z.boolean(),
      z.null(),
    ]),
    state: evidenceStateSchema,
    source: z.string().min(1).max(80),
    origin: evidenceOriginSchema,
    observedAt: z.iso.datetime(),
    validUntil: z.iso.datetime().optional(),
    confidence: z.number().min(0).max(1).optional(),
    reasonCodes: z.array(z.string().max(100)).max(30).default([]),
    reference: z.string().max(300).optional(),
  })
  .strict()
  .superRefine((e, ctx) => {
    if (e.state === "UNKNOWN" && e.value !== null)
      ctx.addIssue({ code: "custom", message: "UNKNOWN phải có value=null" });
    if (e.state === "SAFE" && (e.value === null || e.origin === "UNKNOWN"))
      ctx.addIssue({
        code: "custom",
        message: "SAFE cần giá trị và nguồn xác minh",
      });
  });
export type SecurityEvidence = z.infer<typeof evidenceSchema>;
export const securitySections = [
  "contract",
  "trading",
  "liquidity",
  "holders",
  "creator",
] as const;
export type SecuritySection = (typeof securitySections)[number];
export const securityFindingSchema = z
  .object({
    section: z.enum(securitySections),
    field: z.string().min(1).max(80),
    evidence: evidenceSchema,
  })
  .strict();
export const securityRequestSchema = z
  .object({
    chainId: z.string().min(1).max(64),
    tokenAddress: z.string().min(1).max(150),
    poolAddress: z.string().min(1).max(150).optional(),
  })
  .strict();
export type TokenSecurityRequest = z.infer<typeof securityRequestSchema>;
export const securityProviderResultSchema = z
  .object({
    provider: z.string().min(1).max(80),
    chainId: z.string(),
    tokenAddress: z.string(),
    status: z.enum(["OK", "UNAVAILABLE", "UNSUPPORTED", "DISABLED"]),
    checkedAt: z.iso.datetime(),
    latencyMs: z.number().finite().nonnegative(),
    findings: z.array(securityFindingSchema).max(150),
    error: z.string().max(100).optional(),
    documentation: z.string().url().optional(),
  })
  .strict();
export type TokenSecurityProviderResult = z.infer<
  typeof securityProviderResultSchema
>;
export interface TokenSecurityProvider {
  readonly id: string;
  supports(chainId: string): boolean;
  analyze(request: TokenSecurityRequest): Promise<TokenSecurityProviderResult>;
  healthCheck(): Promise<ProviderHealth>;
  invalidate?(chainId: string, tokenAddress: string): void;
}
export const holderClusterSchema = z
  .object({
    wallets: z.array(z.string().max(150)).max(100),
    confidence: z.enum([
      "CONFIRMED",
      "STRONG_SIGNAL",
      "WEAK_SIGNAL",
      "UNKNOWN",
    ]),
    reasonCodes: z.array(z.string()),
    evidence: z.array(evidenceSchema).max(30),
  })
  .strict();
export type HolderCluster = z.infer<typeof holderClusterSchema>;
export const jevRiskSchema = z
  .object({
    status: z.enum(["AVAILABLE", "UNAVAILABLE"]),
    provider: z.literal("jev"),
    model: z.string(),
    resolvedModel: z.string().optional(),
    rugRiskScore: z.number().min(0).max(4).optional(),
    suspiciousProbability: z.number().min(0).max(1).optional(),
    insufficientDataProbability: z.number().min(0).max(1).optional(),
    riskCategory: z
      .enum([
        "CONTRACT",
        "HOLDERS",
        "CREATOR",
        "LIQUIDITY",
        "SELLABILITY",
        "MARKET",
        "MULTIPLE",
        "INSUFFICIENT_DATA",
      ])
      .optional(),
    advisoryAction: z.enum(["PASS", "WATCH", "SKIP"]).optional(),
    confidence: z.number().min(0).max(1).optional(),
    probabilities: z.record(z.string(), z.number().min(0).max(1)).optional(),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    latencyMs: z.number().nonnegative(),
    featureSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
    timestamp: z.iso.datetime(),
    error: z.string().optional(),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (
      r.status === "AVAILABLE" &&
      [
        r.resolvedModel,
        r.rugRiskScore,
        r.suspiciousProbability,
        r.insufficientDataProbability,
        r.riskCategory,
        r.advisoryAction,
      ].some((v) => v === undefined)
    )
      ctx.addIssue({
        code: "custom",
        message: "Kết quả Jev thiếu câu trả lời",
      });
  });
export type JevRiskClassification = z.infer<typeof jevRiskSchema>;
export const rugDecisionSchema = z
  .object({
    decision: z.enum(["ALLOW", "WATCH", "REJECT"]),
    reasonCodes: z.array(z.string()),
    decidedAt: z.iso.datetime(),
    stage: z.enum(["PRECHECK", "HARD_FILTER", "FINAL", "MONITOR"]),
  })
  .strict();
export type RugDecision = z.infer<typeof rugDecisionSchema>;
export const rugPolicySchema = z
  .object({
    concentrationBasis: z.enum(["raw", "adjusted"]).default("adjusted"),
    rejectNotSellable: z.boolean().default(true),
    rejectUnknownSellability: z.boolean().default(true),
    rejectBlacklistCapability: z.boolean().default(true),
    rejectTransferRestricted: z.boolean().default(true),
    rejectActiveMint: z.boolean().default(false),
    rejectActiveFreeze: z.boolean().default(false),
    maxTop1Pct: z.number().min(0).max(100).optional(),
    maxTop10Pct: z.number().min(0).max(100).optional(),
    maxTaxPct: z.number().min(0).max(100).optional(),
    minimumLiquidityUsd: z.number().nonnegative().optional(),
    maximumRoundTripLossPct: z.number().min(0).max(100).optional(),
    minimumLockRemainingSec: z.number().nonnegative().optional(),
    rejectCreatorLpControl: z.boolean().default(false),
    rejectCriticalCreatorIncidents: z.boolean().default(true),
    rejectLiquidityRemoval: z.boolean().default(true),
    requiredFields: z
      .array(
        z
          .string()
          .regex(
            /^(contract|trading|liquidity|holders|creator)\.[a-zA-Z0-9]+$/,
          ),
      )
      .default([
        "contract.validToken",
        "contract.mintAuthority",
        "contract.freezeAuthority",
        "trading.sellability",
        "liquidity.usd",
        "holders.top1Pct",
      ]),
    maxEvidenceAgeMs: z.number().int().min(1000).max(300000).default(30000),
    sellabilityMaxAgeMs: z.number().int().min(500).max(30000).default(5000),
    requireJevForLive: z.boolean().default(true),
    maxJevRugRisk: z.number().min(0).max(4).optional(),
    maxJevSuspicious: z.number().min(0).max(1).optional(),
    maxJevInsufficientData: z.number().min(0).max(1).optional(),
  })
  .strict();
export type RugPolicy = z.infer<typeof rugPolicySchema>;
const fields = z.record(z.string().max(80), evidenceSchema);
export const rugSnapshotSchema = z
  .object({
    id: z.string(),
    snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
    chainId: z.string(),
    tokenAddress: z.string(),
    poolAddress: z.string().optional(),
    source: z.enum(["RPC", "MOCK"]),
    contract: fields,
    trading: fields,
    liquidity: fields,
    holders: fields,
    creator: fields,
    holderClusters: z.array(holderClusterSchema).max(50),
    externalProviders: z.array(securityProviderResultSchema).max(12),
    disagreements: z
      .array(z.object({ field: z.string(), providers: z.array(z.string()) }))
      .max(150),
    reasonCodes: z.array(z.string()),
    dataQuality: z.object({
      completeness: z.number().min(0).max(1),
      unknownFields: z.array(z.string()),
      sources: z.array(z.string()),
      collectedAt: z.iso.datetime(),
    }),
    latencies: z.record(z.string(), z.number().finite().nonnegative()),
    jev: jevRiskSchema.optional(),
    decision: rugDecisionSchema.optional(),
  })
  .strict()
  .superRefine((snapshot, ctx) => {
    const bools = new Set([
      "contract.validToken",
      "contract.ownershipRenounced",
      "contract.proxy",
      "contract.mintCapability",
      "contract.pauseCapability",
      "contract.blacklistCapability",
      "contract.whitelistRestriction",
      "contract.transferRestriction",
      "contract.mutableTaxes",
      "contract.tradingControl",
      "contract.nonTransferable",
      "contract.arbitraryExternalCalls",
      "contract.supplyManipulation",
      "contract.verifiedSource",
      "trading.buyQuote",
      "trading.sellQuote",
      "trading.networkFeesKnown",
      "trading.sellRestriction",
      "liquidity.lpLocked",
    ]);
    const rawAmounts = new Set([
      "contract.supply",
      "trading.buyAmount",
      "trading.expectedReceived",
      "trading.sellAmount",
      "trading.expectedReturned",
      "liquidity.baseAmount",
      "liquidity.quoteAmount",
    ]);
    for (const section of securitySections)
      for (const [field, e] of Object.entries(snapshot[section])) {
        if (e.state === "UNKNOWN" || e.state === "NOT_APPLICABLE") continue;
        const path = `${section}.${field}`,
          bad = (message: string) =>
            ctx.addIssue({
              code: "custom",
              path: [section, field, "value"],
              message,
            });
        if (bools.has(path) && typeof e.value !== "boolean")
          bad("Bằng chứng boolean không hợp lệ");
        if (
          rawAmounts.has(path) &&
          (typeof e.value !== "string" ||
            !/^\d{1,78}$/.test(e.value) ||
            BigInt(e.value) >= 2n ** 256n)
        )
          bad("Số lượng nguyên không hợp lệ");
        if (
          ["mintAuthority", "freezeAuthority"].includes(field) &&
          !["ACTIVE", "REVOKED"].includes(String(e.value))
        )
          bad("Trạng thái authority không hợp lệ");
        if (
          field.endsWith("Pct") &&
          !["recentAdditionPct", "roundTripLossPct"].includes(field) &&
          (typeof e.value !== "number" || e.value < 0 || e.value > 100)
        )
          bad("Tỷ lệ ngoài khoảng0..100");
        if (
          path === "trading.sellability" &&
          !["SELLABLE", "NOT_SELLABLE"].includes(String(e.value))
        )
          bad("Trạng thái sellability không hợp lệ");
        if (
          path === "trading.honeypot" &&
          !["PASS", "FAIL"].includes(String(e.value))
        )
          bad("Trạng thái honeypot không hợp lệ");
        if (
          path === "liquidity.usd" &&
          (typeof e.value !== "number" || e.value < 0)
        )
          bad("Thanh khoản USD không hợp lệ");
      }
  });
export type RugCheckSnapshot = z.infer<typeof rugSnapshotSchema>;
export interface RugTradingCheck {
  trip?: RoundTripResult;
  failure?: string;
  quoteLatencyMs: number;
  sellSimulationLatencyMs: number;
}
export interface SecurityReadinessRow {
  chainId: string;
  scope: "LATEST_OBSERVED_TOKEN";
  tokenAddress?: string;
  components: Record<string, "READY" | "PARTIAL" | "NOT_READY" | "UNKNOWN">;
  ready: boolean;
}
export interface RugAnalytics {
  tokensScanned: number;
  tokensRejected: number;
  reasons: Record<string, number>;
  jevActions: Record<string, number>;
  providerDisagreements: number;
  jevDeterministicDisagreements: number;
  sellabilityFailures: number;
  liquidityRemovals: number;
  creatorIncidents: number;
  latency: Record<
    string,
    {
      samples: number;
      p50: number | null;
      p95: number | null;
      p99: number | null;
    }
  >;
  outcomeEvents: {
    liquidityCollapse: number;
    rejectedThenCollapsed: number;
    allowedThenCollapsed: number;
    falsePositiveCandidates: number;
    falseNegativeCandidates: number;
  };
  definitions: Record<string, string>;
}
export const rugFieldNames: Record<SecuritySection, string[]> = {
  contract: [
    "validToken",
    "bytecodeHash",
    "tokenProgram",
    "supply",
    "decimals",
    "owner",
    "ownershipRenounced",
    "implementation",
    "implementationCodeHash",
    "proxy",
    "privilegedRoles",
    "mintAuthority",
    "freezeAuthority",
    "mintCapability",
    "pauseCapability",
    "blacklistCapability",
    "whitelistRestriction",
    "transferRestriction",
    "maxTransaction",
    "maxWallet",
    "mutableTaxes",
    "tradingControl",
    "transferHook",
    "permanentDelegate",
    "defaultAccountState",
    "nonTransferable",
    "metadataAuthority",
    "arbitraryExternalCalls",
    "supplyManipulation",
    "verifiedSource",
    "extensions",
    "externalWarnings",
  ],
  trading: [
    "buyQuote",
    "sellQuote",
    "sellability",
    "honeypot",
    "buyTaxPct",
    "sellTaxPct",
    "transferTaxPct",
    "sellRestriction",
    "buyAmount",
    "expectedReceived",
    "sellAmount",
    "expectedReturned",
    "roundTripLossPct",
    "networkFeesKnown",
    "dexFees",
    "routeFees",
    "priceImpactPct",
    "slippageBps",
  ],
  liquidity: [
    "usd",
    "baseAmount",
    "quoteAmount",
    "poolAgeSec",
    "lpOwnership",
    "lpConcentrationPct",
    "lpBurned",
    "lpLocked",
    "lpLockedPct",
    "unlockAt",
    "creatorLpPct",
    "recentRemovalPct",
    "recentAdditionPct",
  ],
  holders: [
    "count",
    "top1Pct",
    "top5Pct",
    "top10Pct",
    "top20Pct",
    "adjustedTop1Pct",
    "adjustedTop5Pct",
    "adjustedTop10Pct",
    "adjustedTop20Pct",
    "creatorHoldingPct",
    "deployerHoldingPct",
    "excludedSupplyPct",
    "exclusions",
    "coverage",
    "suspiciousClusterPct",
    "freshWalletPct",
  ],
  creator: [
    "address",
    "role",
    "history",
    "previousTokens",
    "activeTokens",
    "shortLivedTokens",
    "criticalIncidents",
    "liquidityRemovals",
    "extremeDumps",
    "sellabilityFailures",
    "previousLifespanSec",
    "previousConcentrationPct",
    "previousLiquidityBehavior",
  ],
};
