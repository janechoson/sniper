import {
  tokenStateSchema,
  rugPolicySchema,
  atomicQuoteSchema,
  type TokenSecurityProvider,
  type TokenSecurityProviderResult,
  type RugCheckSnapshot,
  type JevRiskClassification,
  type RoundTripResult,
} from "@sniper/core";
import { RugCheckEngine, applyRugTrading, measured } from "@sniper/features";
export const request = {
  chainId: "solana",
  tokenAddress: "TOKEN_FIXTURE",
  poolAddress: "POOL_FIXTURE",
};
export const securityState = () =>
  tokenStateSchema.parse({
    identity: {
      ...request,
      address: request.tokenAddress,
      source: "RPC",
      ageSec: 20,
    },
    observedAt: Date.now(),
    market: {
      priceUsd: 0.001,
      liquidityUsd: 50000,
      volume5s: 1000,
      volume15s: 2000,
      volume60s: 3000,
      priceChange5s: 5,
      priceChange15s: 10,
      priceChange60s: 15,
      buySellRatio: 3,
      uniqueBuyers: 10,
      uniqueSellers: 2,
    },
    holders: { count: 100, top1Pct: 2, top5Pct: 8, top10Pct: 15 },
    creator: {
      address: "CREATOR_PRIVATE_CONTEXT",
      role: "TOKEN_DEPLOYER",
      previousTokens: 2,
      knownBadFunding: false,
    },
    security: {
      validToken: true,
      mintRisk: false,
      freezeRisk: false,
      transferRestrictionRisk: false,
      sellRestrictionRisk: false,
      overallRisk: 1,
      evidence: [],
    },
  });
export const policy = () =>
  rugPolicySchema.parse({
    concentrationBasis: "raw",
    requiredFields: [
      "contract.validToken",
      "contract.mintAuthority",
      "contract.freezeAuthority",
      "trading.sellability",
      "liquidity.usd",
      "holders.top1Pct",
      "creator.history",
    ],
    maxTop1Pct: 20,
    maxTop10Pct: 50,
    minimumLiquidityUsd: 1000,
    maximumRoundTripLossPct: 10,
    maxJevRugRisk: 2,
    maxJevSuspicious: 0.7,
    maxJevInsufficientData: 0.7,
    rejectActiveMint: true,
    rejectActiveFreeze: true,
  });
export function provider(
  change?: (result: TokenSecurityProviderResult) => void,
): TokenSecurityProvider {
  return {
    id: "fixture-rpc",
    supports: () => true,
    healthCheck: async () => ({
      id: "fixture-rpc",
      status: "READY",
      reasons: [],
      checkedAt: Date.now(),
    }),
    analyze: async (r) => {
      const result: TokenSecurityProviderResult = {
        provider: "fixture-rpc",
        chainId: r.chainId,
        tokenAddress: r.tokenAddress,
        status: "OK",
        checkedAt: new Date().toISOString(),
        latencyMs: 1,
        findings: [
          {
            section: "contract",
            field: "validToken",
            evidence: measured(true, "RPC", "REAL_ONCHAIN"),
          },
          {
            section: "contract",
            field: "mintAuthority",
            evidence: measured("REVOKED", "RPC", "REAL_ONCHAIN"),
          },
          {
            section: "contract",
            field: "freezeAuthority",
            evidence: measured("REVOKED", "RPC", "REAL_ONCHAIN"),
          },
        ],
      };
      change?.(result);
      return result;
    },
  };
}
export function trip(): RoundTripResult {
  const buy = atomicQuoteSchema.parse({
    id: "buy",
    providerId: "fixture",
    chainId: "solana",
    tokenIn: "QUOTE_FIXTURE",
    tokenOut: request.tokenAddress,
    amountIn: "1000000",
    expectedAmountOut: "1000000000",
    minimumAmountOut: "1000000000",
    decimalsIn: 6,
    decimalsOut: 9,
    priceImpactPct: 1,
    estimatedNetworkFeeUsd: "0.01",
    quotedAt: Date.now(),
    expiresAt: Date.now() + 30000,
    source: "RPC",
    quality: "REAL",
  });
  return {
    buy,
    sell: {
      ...buy,
      id: "sell",
      tokenIn: buy.tokenOut,
      tokenOut: buy.tokenIn,
      amountIn: buy.minimumAmountOut,
      minimumAmountOut: "990000",
      expectedAmountOut: "990000",
      decimalsIn: 9,
      decimalsOut: 6,
    },
    sellability: "SELLABLE",
    evidence: "TRANSACTION_SIMULATION",
    roundTripLossPct: 1,
    reasons: [],
  };
}
export async function snapshot(
  change?: (result: TokenSecurityProviderResult) => void,
): Promise<RugCheckSnapshot> {
  const value = await new RugCheckEngine([provider(change)]).collect(
    request,
    securityState(),
  );
  return applyRugTrading(value, {
    trip: trip(),
    quoteLatencyMs: 1,
    sellSimulationLatencyMs: 2,
  });
}
export const riskAnswer = (s: RugCheckSnapshot): JevRiskClassification => ({
  provider: "jev",
  model: "jev-latest",
  resolvedModel: "jev-1.14.0",
  status: "AVAILABLE",
  rugRiskScore: 0,
  suspiciousProbability: 0.1,
  insufficientDataProbability: 0.1,
  riskCategory: "CONTRACT",
  advisoryAction: "PASS",
  confidence: 0.9,
  probabilities: { PASS: 0.9, WATCH: 0.05, SKIP: 0.05 },
  featureSnapshotHash: s.snapshotHash,
  latencyMs: 1,
  timestamp: new Date().toISOString(),
});
