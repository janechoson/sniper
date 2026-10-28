import { createHash, randomUUID } from "node:crypto";
import {
  rugSnapshotSchema,
  securityProviderResultSchema,
  securityRequestSchema,
  rugFieldNames,
  securitySections,
  type RugCheckSnapshot,
  type SecurityEvidence,
  type TokenSecurityProvider,
  type TokenSecurityRequest,
  type TokenSecurityProviderResult,
  type NormalizedTokenState,
  type RugTradingCheck,
  type HolderCluster,
} from "@sniper/core";
export function unknownEvidence(source = "UNKNOWN"): SecurityEvidence {
  return {
    value: null,
    state: "UNKNOWN",
    source,
    origin: "UNKNOWN",
    observedAt: new Date().toISOString(),
    reasonCodes: [],
  };
}
export function measured(
  value: SecurityEvidence["value"],
  source: string,
  origin: SecurityEvidence["origin"],
  state: SecurityEvidence["state"] = "SAFE",
  observedAt = new Date().toISOString(),
): SecurityEvidence {
  return { value, state, source, origin, observedAt, reasonCodes: [] };
}
const semantic = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(semantic);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            ![
              "id",
              "snapshotHash",
              "observedAt",
              "checkedAt",
              "collectedAt",
              "latencies",
              "latencyMs",
              "validUntil",
              "jev",
              "decision",
            ].includes(key),
        )
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, semantic(item)]),
    );
  return value;
};
export function refreshRugSnapshot(
  snapshot: RugCheckSnapshot,
): RugCheckSnapshot {
  const entries = securitySections.flatMap((section) =>
    Object.entries(snapshot[section]).map(([field, evidence]) => ({
      field: `${section}.${field}`,
      evidence,
    })),
  );
  snapshot.dataQuality.unknownFields = entries
    .filter((e) => e.evidence.state === "UNKNOWN")
    .map((e) => e.field);
  snapshot.dataQuality.completeness = entries.length
    ? (entries.length - snapshot.dataQuality.unknownFields.length) /
      entries.length
    : 0;
  snapshot.dataQuality.sources = [
    ...new Set(
      entries
        .filter((e) => e.evidence.state !== "UNKNOWN")
        .map((e) => `${e.evidence.origin}:${e.evidence.source}`),
    ),
  ];
  snapshot.snapshotHash = createHash("sha256")
    .update(
      JSON.stringify(
        semantic({
          ...snapshot,
          dataQuality: undefined,
          reasonCodes: undefined,
        }),
      ),
    )
    .digest("hex");
  return rugSnapshotSchema.parse(snapshot);
}
export class RugCheckEngine {
  constructor(
    private readonly providers: TokenSecurityProvider[],
    private readonly timeoutMs = 5000,
    private readonly clusterProvider?: {
      getClusters(request: TokenSecurityRequest): Promise<HolderCluster[]>;
    },
  ) {}
  async collect(
    request: TokenSecurityRequest,
    state: NormalizedTokenState,
  ): Promise<RugCheckSnapshot> {
    securityRequestSchema.parse(request);
    if (
      state.identity.source !== "RPC" ||
      state.identity.chainId !== request.chainId ||
      state.identity.address !== request.tokenAddress
    )
      throw new Error("RUG_REAL_IDENTITY_REQUIRED");
    const start = Date.now();
    const snapshot: RugCheckSnapshot = {
      id: randomUUID(),
      snapshotHash: "0".repeat(64),
      ...request,
      source: "RPC",
      contract: {},
      trading: {},
      liquidity: {},
      holders: {},
      creator: {},
      holderClusters: [],
      externalProviders: [],
      disagreements: [],
      reasonCodes: [],
      dataQuality: {
        completeness: 0,
        unknownFields: [],
        sources: [],
        collectedAt: new Date().toISOString(),
      },
      latencies: {},
    };
    for (const section of securitySections)
      for (const field of rugFieldNames[section])
        snapshot[section][field] = unknownEvidence();
    const fallback = (
      section: (typeof securitySections)[number],
      field: string,
      value: SecurityEvidence["value"] | undefined,
      origin: SecurityEvidence["origin"] = "REAL_ONCHAIN",
      observedAt?: string,
    ) => {
      if (value !== undefined)
        snapshot[section][field] = measured(
          value,
          origin === "REAL_INTERNAL" ? "internal-creator" : "RPC",
          origin,
          "SAFE",
          observedAt,
        );
    };
    const marketAt = state.quality?.["market.liquidityUsd"]?.observedAt;
    fallback(
      "liquidity",
      "usd",
      state.market.liquidityUsd,
      "ESTIMATED",
      marketAt
        ? new Date(marketAt).toISOString()
        : new Date(state.observedAt).toISOString(),
    );
    fallback(
      "liquidity",
      "poolAgeSec",
      state.identity.ageSec,
      "REAL_ONCHAIN",
      new Date(state.observedAt).toISOString(),
    );
    for (const [field, key] of Object.entries({
      count: "count",
      top1Pct: "top1Pct",
      top5Pct: "top5Pct",
      top10Pct: "top10Pct",
      creatorHoldingPct: "creatorPct",
      suspiciousClusterPct: "suspiciousClusterPct",
      freshWalletPct: "freshWalletPct",
    } as const))
      fallback("holders", field, state.holders[key]);
    fallback("creator", "address", state.creator.address, "REAL_INTERNAL");
    fallback("creator", "role", state.creator.role, "REAL_INTERNAL");
    for (const [field, key] of Object.entries({
      previousTokens: "previousTokens",
      liquidityRemovals: "liquidityRemovals",
    } as const))
      fallback("creator", field, state.creator[key], "REAL_INTERNAL");
    if (state.creator.address)
      fallback("creator", "history", "OBSERVED_DATASET_ONLY", "REAL_INTERNAL");
    if (
      state.creator.liquidityRemovals !== undefined &&
      state.creator.liquidityRemovals > 0
    )
      snapshot.creator.liquidityRemovals = measured(
        state.creator.liquidityRemovals,
        "internal-creator",
        "REAL_INTERNAL",
        "RISK",
      );
    const results = await Promise.all(
      this.providers.map(async (provider) => {
        const at = Date.now();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          if (!provider.supports(request.chainId))
            return {
              provider: provider.id,
              chainId: request.chainId,
              tokenAddress: request.tokenAddress,
              status: "UNSUPPORTED" as const,
              checkedAt: new Date().toISOString(),
              latencyMs: 0,
              findings: [],
            };
          const raw = await Promise.race([
            provider.analyze(request),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("PROVIDER_TIMEOUT")),
                this.timeoutMs,
              );
            }),
          ]);
          const result = securityProviderResultSchema.parse(raw);
          if (
            result.provider !== provider.id ||
            result.chainId !== request.chainId ||
            result.tokenAddress !== request.tokenAddress ||
            result.findings.some((f) => f.evidence.origin === "MOCK")
          )
            throw new Error("PROVIDER_IDENTITY_OR_SOURCE_INVALID");
          return result;
        } catch (error) {
          return {
            provider: provider.id,
            chainId: request.chainId,
            tokenAddress: request.tokenAddress,
            status: "UNAVAILABLE" as const,
            checkedAt: new Date().toISOString(),
            latencyMs: Date.now() - at,
            findings: [],
            error:
              error instanceof Error && error.message === "PROVIDER_TIMEOUT"
                ? "PROVIDER_TIMEOUT"
                : "SECURITY_PROVIDER_UNAVAILABLE",
          };
        } finally {
          clearTimeout(timer);
        }
      }),
    );
    snapshot.holderClusters =
      (await this.clusterProvider?.getClusters(request).catch(() => [])) ?? [];
    const byField = new Map<
      string,
      { provider: string; evidence: SecurityEvidence }[]
    >();
    for (const raw of results) {
      const result = securityProviderResultSchema.parse(raw);
      snapshot.externalProviders.push(result);
      if (result.status !== "DISABLED" && result.status !== "UNSUPPORTED")
        snapshot.latencies[result.provider] = result.latencyMs;
      if (result.status !== "OK") continue;
      for (const finding of result.findings) {
        if (!rugFieldNames[finding.section].includes(finding.field)) continue;
        const path = `${finding.section}.${finding.field}`,
          all = byField.get(path) ?? [];
        all.push({ provider: result.provider, evidence: finding.evidence });
        byField.set(path, all);
      }
    }
    for (const [path, values] of byField) {
      const [section, field] = path.split(".") as [
        (typeof securitySections)[number],
        string,
      ];
      const baseline = snapshot[section][field]!;
      const known = [
        ...(baseline.state !== "UNKNOWN"
          ? [{ provider: baseline.source, evidence: baseline }]
          : []),
        ...values,
      ].filter((v) => v.evidence.state !== "UNKNOWN");
      const conflict =
        new Set(
          known
            .filter((v) => v.evidence.state !== "NOT_APPLICABLE")
            .map((v) => JSON.stringify(v.evidence.value)),
        ).size > 1;
      if (conflict)
        snapshot.disagreements.push({
          field: path,
          providers: [...new Set(known.map((v) => v.provider))],
        });
      const risk = known.find((v) => v.evidence.state === "RISK");
      snapshot[section][field] =
        risk?.evidence ??
        (conflict
          ? {
              ...unknownEvidence("CONFLICT"),
              reasonCodes: ["SECURITY_PROVIDER_DISAGREEMENT"],
            }
          : (known[0]?.evidence ?? baseline));
    }
    if (snapshot.disagreements.some((d) => d.field === "creator.address")) {
      snapshot.creator.history = {
        ...unknownEvidence("CONFLICT"),
        reasonCodes: ["CREATOR_IDENTITY_CONFLICT"],
      };
      snapshot.creator.role = {
        ...unknownEvidence("CONFLICT"),
        reasonCodes: ["CREATOR_IDENTITY_CONFLICT"],
      };
    }
    snapshot.latencies.totalRiskPipelineLatencyMs = Date.now() - start;
    for (const [name, provider] of Object.entries({
      rpcLatencyMs: "on-chain",
      holderAnalysisLatencyMs: "rpc-holders",
      creatorAnalysisLatencyMs: "internal-creator",
    }))
      if (snapshot.latencies[provider] !== undefined)
        snapshot.latencies[name] = snapshot.latencies[provider]!;
    const externalLatencies = snapshot.externalProviders
      .filter(
        (p) =>
          ["goplus", "honeypot", "rugcheck"].includes(p.provider) &&
          p.status !== "DISABLED" &&
          p.status !== "UNSUPPORTED",
      )
      .map((p) => p.latencyMs);
    if (externalLatencies.length)
      snapshot.latencies.securityProviderLatencyMs = Math.max(
        ...externalLatencies,
      );
    return refreshRugSnapshot(snapshot);
  }
  invalidate(chainId: string, tokenAddress: string) {
    for (const provider of this.providers)
      provider.invalidate?.(chainId, tokenAddress);
  }
}
export function applyRugTrading(
  snapshot: RugCheckSnapshot,
  check: RugTradingCheck,
): RugCheckSnapshot {
  const trip = check.trip,
    at = new Date().toISOString(),
    expiry = trip
      ? new Date(
          Math.min(
            trip.buy.expiresAt,
            trip.sell?.expiresAt ?? trip.buy.expiresAt,
          ),
        ).toISOString()
      : undefined;
  const findings: TokenSecurityProviderResult["findings"] = [];
  const set = (
    field: string,
    value: SecurityEvidence["value"],
    state: SecurityEvidence["state"] = "SAFE",
    origin: SecurityEvidence["origin"] = "REAL_ONCHAIN",
  ) => {
    const evidence = {
      ...measured(
        value,
        origin === "REAL_SIMULATION" ? "sell-simulation" : "DEX",
        origin,
        state,
        at,
      ),
      validUntil: expiry,
    };
    if (state === "UNKNOWN") evidence.value = null;
    findings.push({ section: "trading", field, evidence });
    const old = snapshot.trading[field];
    if (old && old.state !== "UNKNOWN" && old.value !== value)
      snapshot.disagreements.push({
        field: `trading.${field}`,
        providers: [old.source, evidence.source],
      });
    if (old?.state !== "RISK" || state === "RISK")
      snapshot.trading[field] = evidence;
  };
  snapshot.latencies.quoteLatencyMs = check.quoteLatencyMs;
  snapshot.latencies.sellSimulationLatencyMs = check.sellSimulationLatencyMs;
  if (!trip) {
    snapshot.trading.sellability = {
      ...unknownEvidence("DEX"),
      reasonCodes: [check.failure ?? "QUOTE_UNAVAILABLE"],
    };
    return refreshRugSnapshot(snapshot);
  }
  set("buyQuote", true);
  set("sellQuote", !!trip.sell, trip.sell ? "SAFE" : "UNKNOWN");
  if (!trip.sell) snapshot.trading.sellQuote = unknownEvidence("DEX");
  const proof = trip.evidence === "TRANSACTION_SIMULATION";
  set(
    "sellability",
    trip.sellability,
    trip.sellability === "SELLABLE" && proof
      ? "SAFE"
      : trip.sellability === "NOT_SELLABLE"
        ? "RISK"
        : "UNKNOWN",
    proof ? "REAL_SIMULATION" : "REAL_ONCHAIN",
  );
  if (snapshot.trading.sellability!.state === "UNKNOWN")
    snapshot.trading.sellability!.value = null;
  if (proof && trip.sellability !== "UNKNOWN")
    set(
      "honeypot",
      trip.sellability === "NOT_SELLABLE" ? "FAIL" : "PASS",
      trip.sellability === "NOT_SELLABLE" ? "RISK" : "SAFE",
      "REAL_SIMULATION",
    );
  set("buyAmount", trip.buy.amountIn);
  set("expectedReceived", trip.buy.minimumAmountOut);
  if (trip.sell) {
    set("sellAmount", trip.sell.amountIn);
    set("expectedReturned", trip.sell.minimumAmountOut);
  }
  if (trip.roundTripLossPct !== undefined)
    set(
      "roundTripLossPct",
      trip.roundTripLossPct,
      "SAFE",
      proof ? "REAL_SIMULATION" : "ESTIMATED",
    );
  if (
    trip.buy.estimatedNetworkFeeUsd !== undefined &&
    trip.sell?.estimatedNetworkFeeUsd !== undefined
  )
    set(
      "networkFeesKnown",
      true,
      "SAFE",
      proof ? "REAL_SIMULATION" : "ESTIMATED",
    );
  if (trip.buy.priceImpactPct !== undefined)
    set("priceImpactPct", trip.buy.priceImpactPct, "SAFE", "ESTIMATED");
  snapshot.externalProviders = snapshot.externalProviders.filter(
    (p) => p.provider !== "trade-validation",
  );
  snapshot.externalProviders.push({
    provider: "trade-validation",
    chainId: snapshot.chainId,
    tokenAddress: snapshot.tokenAddress,
    status: "OK",
    checkedAt: at,
    latencyMs: check.quoteLatencyMs + check.sellSimulationLatencyMs,
    findings,
  });
  return refreshRugSnapshot(snapshot);
}
