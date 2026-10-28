import type { TokenDiscoveryEvent } from "@sniper/core";
import { z } from "zod";
import {
  FeatureEngine,
  MarketFeatureCollector,
  HolderFeatureCollector,
  CreatorFeatureCollector,
  SecurityFeatureCollector,
  type FeatureSource,
  type HolderDataProvider,
  type CreatorDataProvider,
} from "@sniper/features";
import type { ProductionChainAdapter } from "@sniper/chains";
export class ProductionFeatureEngine extends FeatureEngine {
  constructor(
    private readonly adapters: Map<string, ProductionChainAdapter>,
    holders: HolderDataProvider,
    creators: CreatorDataProvider,
  ) {
    const adapter = (event: TokenDiscoveryEvent) => {
      const value = adapters.get(event.chainId);
      if (!value) throw new Error("CHAIN_UNAVAILABLE");
      return value;
    };
    const source: FeatureSource = {
      market: (event) =>
        adapter(event)
          .market(event)
          .catch(() => ({})),
      holders: (event) =>
        holders
          .getHolderAnalysis(event.chainId, event.tokenAddress)
          .catch(() => ({})),
      creator: (event) =>
        creators
          .getCreatorAnalysis(event.chainId, event.tokenAddress)
          .catch(() => ({})),
      security: (event) =>
        adapter(event)
          .analyzeSecurity(event.tokenAddress)
          .catch(() => ({ evidence: ["RPC_SECURITY_UNAVAILABLE"] })),
    };
    super([
      new MarketFeatureCollector(source),
      new HolderFeatureCollector(source),
      new CreatorFeatureCollector(source),
      new SecurityFeatureCollector(source),
    ]);
  }
  override async collect(event: TokenDiscoveryEvent) {
    if (event.source !== "RPC") throw new Error("REAL_SOURCE_REQUIRED");
    const state = await super.collect(event);
    const info = await this.adapters
      .get(event.chainId)!
      .getTokenInfo(event.tokenAddress)
      .catch(() => undefined);
    if (info) {
      state.identity.symbol = info.symbol;
      state.identity.name = info.name;
    }
    if (event.dexId === "pump-fun" || event.dexId === "pump-swap") {
      const metadata = z
        .object({
          symbol: z.string().max(13).optional(),
          name: z.string().max(32).optional(),
        })
        .safeParse(event.rawEvent);
      if (metadata.success) {
        state.identity.symbol ??= metadata.data.symbol;
        state.identity.name ??= metadata.data.name;
      }
      state.protocol = await this.adapters
        .get(event.chainId)!
        .protocolState(event)
        .catch(() => undefined);
    }
    state.observedAt = Date.now();
    const previousQuality = state.quality;
    state.quality = {};
    // Coverage inventory only, not the list of entry gates. Funding stays UNKNOWN
    // in evidence and is excluded from Jev decision features.
    const observedFields: Record<string, string[]> = {
      market: [
        "priceUsd",
        "liquidityUsd",
        "volume5s",
        "volume15s",
        "volume60s",
        "buySellRatio",
        "uniqueBuyers",
        "uniqueSellers",
        "priceChange5s",
        "priceChange15s",
        "priceChange60s",
      ],
      holders: [
        "count",
        "top1Pct",
        "top5Pct",
        "top10Pct",
        "creatorPct",
        "freshWalletPct",
        "suspiciousClusterPct",
      ],
      creator: [
        "address",
        "previousTokens",
        "knownBadFunding",
        "reputationScore",
      ],
      security: [
        "validToken",
        "mintRisk",
        "freezeRisk",
        "upgradeRisk",
        "blacklistRisk",
        "pauseRisk",
        "sellRestrictionRisk",
        "overallRisk",
        "buyTaxPct",
        "sellTaxPct",
      ],
    };
    for (const section of [
      "market",
      "holders",
      "creator",
      "security",
    ] as const) {
      const values: Record<string, unknown> = state[section];
      for (const key of new Set([
        ...Object.keys(values),
        ...observedFields[section]!,
      ])) {
        if (key === "evidence") continue;
        const known = values[key] !== undefined;
        state.quality[`${section}.${key}`] = {
          ...(previousQuality?.[`${section}.${key}`]?.detail
            ? { detail: previousQuality[`${section}.${key}`]!.detail }
            : {}),
          quality: known
            ? (section === "market" &&
                (["priceUsd", "liquidityUsd"].includes(key) ||
                  key.startsWith("volume"))) ||
              (section === "security" && key === "overallRisk")
              ? "ESTIMATED"
              : "REAL"
            : "UNKNOWN",
          source: !known
            ? "UNKNOWN"
            : section === "creator"
              ? "REAL_INTERNAL"
              : "REAL_ONCHAIN",
          observedAt:
            section === "market"
              ? (this.adapters
                  .get(event.chainId)
                  ?.book.lastObservedAt(event.id) ?? state.observedAt)
              : state.observedAt,
        };
      }
    }
    return state;
  }
}
