import type {
  HolderAnalysis,
  CreatorProfile,
  FeatureEvidence,
} from "@sniper/core";
export interface HolderDataProvider {
  getHolderAnalysis(
    chainId: string,
    tokenAddress: string,
  ): Promise<HolderAnalysis>;
}
export interface CreatorDataProvider {
  getCreatorAnalysis(
    chainId: string,
    tokenAddress: string,
  ): Promise<CreatorProfile>;
}
export interface ProviderEvidence {
  origin:
    "REAL_ONCHAIN" | "REAL_INTERNAL" | "EXTERNAL" | "ESTIMATED" | "UNKNOWN";
  features: Record<string, FeatureEvidence>;
}
export class CompositeHolderDataProvider implements HolderDataProvider {
  constructor(private readonly providers: HolderDataProvider[]) {}
  async getHolderAnalysis(
    chainId: string,
    address: string,
  ): Promise<HolderAnalysis> {
    const merged: HolderAnalysis = {};
    for (const provider of this.providers) {
      try {
        const value = await provider.getHolderAnalysis(chainId, address);
        for (const [key, item] of Object.entries(value))
          if (
            item !== undefined &&
            merged[key as keyof HolderAnalysis] === undefined
          )
            Object.assign(merged, { [key]: item });
      } catch {
        /* Lỗi một nguồn không biến chỉ số chưa rõ thành số giả. */
      }
    }
    return merged;
  }
}
export class InternalHolderDataProvider implements HolderDataProvider {
  constructor(
    private readonly readCompleteSnapshot: (
      chainId: string,
      address: string,
    ) => Promise<HolderAnalysis | undefined>,
  ) {}
  async getHolderAnalysis(chainId: string, address: string) {
    return (await this.readCompleteSnapshot(chainId, address)) ?? {};
  }
}
