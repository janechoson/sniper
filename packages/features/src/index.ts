import {
  tokenStateSchema,
  type TokenDiscoveryEvent,
  type NormalizedTokenState,
  type CreatorProfile,
  type SecurityAnalysis,
  type HolderAnalysis,
} from "@sniper/core";
export * from "./providers";
export * from "./creator-history";
export interface FeatureSource {
  market(event: TokenDiscoveryEvent): Promise<NormalizedTokenState["market"]>;
  holders(event: TokenDiscoveryEvent): Promise<HolderAnalysis>;
  creator(event: TokenDiscoveryEvent): Promise<CreatorProfile>;
  security(event: TokenDiscoveryEvent): Promise<SecurityAnalysis>;
}
export interface FeatureCollector {
  collect(
    event: TokenDiscoveryEvent,
  ): Promise<
    Partial<
      Pick<NormalizedTokenState, "market" | "holders" | "creator" | "security">
    >
  >;
}
export class MarketFeatureCollector implements FeatureCollector {
  constructor(private readonly source: FeatureSource) {}
  async collect(event: TokenDiscoveryEvent) {
    return { market: await this.source.market(event) };
  }
}
export class HolderFeatureCollector implements FeatureCollector {
  constructor(private readonly source: FeatureSource) {}
  async collect(event: TokenDiscoveryEvent) {
    return { holders: await this.source.holders(event) };
  }
}
export class CreatorFeatureCollector implements FeatureCollector {
  constructor(private readonly source: FeatureSource) {}
  async collect(event: TokenDiscoveryEvent) {
    return { creator: await this.source.creator(event) };
  }
}
export class SecurityFeatureCollector implements FeatureCollector {
  constructor(private readonly source: FeatureSource) {}
  async collect(event: TokenDiscoveryEvent) {
    return { security: await this.source.security(event) };
  }
}
export class FeatureEngine {
  constructor(private readonly collectors: FeatureCollector[]) {}
  async collect(event: TokenDiscoveryEvent): Promise<NormalizedTokenState> {
    const parts = await Promise.all(
      this.collectors.map((c) => c.collect(event)),
    );
    const base = {
      identity: {
        chainId: event.chainId,
        address: event.tokenAddress,
        poolAddress: event.poolAddress,
        dexId: event.dexId,
        source: event.source,
        symbol:
          event.source === "MOCK"
            ? `TEST-${event.tokenAddress.split(":").at(-1)}`
            : undefined,
        ageSec:
          event.source === "MOCK" || event.chainTimestamp !== undefined
            ? Math.max(
                0,
                (Date.now() - (event.chainTimestamp ?? event.timestamp)) / 1000,
              )
            : undefined,
      },
      observedAt: event.timestamp,
      market: {},
      holders: {},
      creator: {},
      security: {},
    };
    const merged: Record<
      "market" | "holders" | "creator" | "security",
      Record<string, unknown>
    > = { market: {}, holders: {}, creator: {}, security: {} };
    let fundingConflict = false;
    for (const part of parts)
      for (const section of [
        "market",
        "holders",
        "creator",
        "security",
      ] as const) {
        for (const [key, value] of Object.entries(part[section] ?? {})) {
          const target = merged[section];
          if (section === "creator" && key === "knownBadFunding") {
            if (fundingConflict) continue;
            // A disagreement in research-only funding data must not abort the
            // security pipeline. Preserve uncertainty, never manufacture SAFE.
            if (
              key in target &&
              target[key] !== undefined &&
              value !== undefined &&
              !Object.is(target[key], value)
            ) {
              target[key] = undefined;
              fundingConflict = true;
              continue;
            }
            if (value === undefined) continue;
          }
          if (key === "evidence" && Array.isArray(value)) {
            target[key] = [
              ...(Array.isArray(target[key]) ? target[key] : []),
              ...value,
            ];
            continue;
          }
          if (key in target && !Object.is(target[key], value))
            throw new Error(`Dữ liệu đặc trưng mâu thuẫn: ${section}.${key}`);
          target[key] = value;
        }
      }
    return tokenStateSchema.parse({
      ...base,
      ...merged,
      ...(fundingConflict
        ? {
            quality: {
              "creator.knownBadFunding": {
                quality: "UNKNOWN",
                source: "CONFLICTING_RESEARCH_EVIDENCE",
                observedAt: Date.now(),
                detail: "Collectors disagree: true/false; informational only",
              },
            },
          }
        : {}),
    });
  }
}
export function createFeatureEngine(source: FeatureSource) {
  return new FeatureEngine([
    new MarketFeatureCollector(source),
    new HolderFeatureCollector(source),
    new CreatorFeatureCollector(source),
    new SecurityFeatureCollector(source),
  ]);
}

export interface HolderBalance {
  address: string;
  balance: number;
  creator?: boolean;
  fresh?: boolean;
  fundingWallet?: string;
}
export function analyzeHolders(
  balances: HolderBalance[],
  totalSupply: number,
  complete: boolean,
): HolderAnalysis {
  if (!complete || !Number.isFinite(totalSupply) || totalSupply <= 0) return {};
  if (
    balances.some((h) => !Number.isFinite(h.balance) || h.balance < 0) ||
    new Set(balances.map((h) => h.address)).size !== balances.length
  )
    return {};
  const sorted = [...balances].sort((a, b) => b.balance - a.balance);
  const sum = (items: HolderBalance[]) =>
    (items.reduce((s, h) => s + h.balance, 0) / totalSupply) * 100;
  if (sum(sorted) > 100.000001) return {};
  const groups = new Map<string, HolderBalance[]>();
  for (const holder of balances) {
    if (holder.fundingWallet)
      groups.set(holder.fundingWallet, [
        ...(groups.get(holder.fundingWallet) ?? []),
        holder,
      ]);
  }
  // Chỉ nhận diện nhóm khi có bằng chứng cấp vốn chung; số ví không chứng minh tính độc lập.
  const clustered = [...groups.values()].filter((g) => g.length > 1).flat();
  return {
    count: balances.filter((h) => h.balance > 0).length,
    top1Pct: sum(sorted.slice(0, 1)),
    top5Pct: sum(sorted.slice(0, 5)),
    top10Pct: sum(sorted.slice(0, 10)),
    creatorPct: balances.every((h) => h.creator !== undefined)
      ? sum(balances.filter((h) => h.creator))
      : undefined,
    freshWalletPct: balances.every((h) => h.fresh !== undefined)
      ? sum(balances.filter((h) => h.fresh))
      : undefined,
    suspiciousClusterPct: balances.every((h) => h.fundingWallet !== undefined)
      ? sum(clustered)
      : undefined,
  };
}

export class MockFeatureSource implements FeatureSource {
  private index(event: TokenDiscoveryEvent) {
    return Number(event.tokenAddress.split(":").at(-1)) || 0;
  }
  async market(event: TokenDiscoveryEvent) {
    const index = this.index(event);
    return {
      priceUsd: 0.01 + (index % 5) * 0.002,
      liquidityUsd: index % 8 === 3 ? 1000 : 80000,
      volume5s: 4000,
      volume15s: 10000,
      volume60s: 30000,
      buys5s: 18,
      buys15s: 45,
      sells5s: 4,
      sells15s: 10,
      uniqueBuyers: 40,
      uniqueSellers: 8,
      buyVolume15s: 8000,
      sellVolume15s: 2000,
      buySellRatio: 4,
      priceChange5s: 8,
      priceChange15s: 18,
      priceChange60s: 25,
      liquidityChange15s: 5,
    };
  }
  async holders(event: TokenDiscoveryEvent) {
    return {
      count: 260,
      top1Pct: this.index(event) % 8 === 6 ? 55 : 6,
      top5Pct: 18,
      top10Pct: 30,
      creatorPct: 3,
      suspiciousClusterPct: 5,
      freshWalletPct: 15,
    };
  }
  async creator(_event: TokenDiscoveryEvent) {
    return {
      walletAgeDays: 180,
      previousTokens: 5,
      suspiciousLaunches: 0,
      liquidityRemovals: 0,
      successfulLaunches: 3,
      knownBadFunding: false,
      reputationScore: 85,
    };
  }
  async security(event: TokenDiscoveryEvent): Promise<SecurityAnalysis> {
    const index = this.index(event);
    return {
      validToken: true,
      mintRisk: index % 8 === 4,
      freezeRisk: false,
      blacklistRisk: false,
      upgradeRisk: false,
      pauseRisk: false,
      transferRestrictionRisk: false,
      sellRestrictionRisk: index % 8 === 5 ? undefined : false,
      liquidityRisk: 8,
      creatorRisk: 5,
      overallRisk: 10,
      buyTaxPct: 0,
      sellTaxPct: 0,
      evidence: ["Dữ liệu kiểm thử GIẢ LẬP, chưa phải phân tích trên chuỗi"],
    };
  }
}
export * from "./rug-check";
export * from "./security-providers";
export * from "./security-history";
