import type { ChainAdapter, TokenDiscoveryEvent } from "@sniper/core";
export class DiscoveryCoordinator {
  private enabledChains = new Set<string>();
  constructor(private readonly adapters: Map<string, ChainAdapter>) {}
  accepting(chainId: string) {
    return this.enabledChains.has(chainId);
  }
  active() {
    return [...this.enabledChains];
  }
  async switchTo(chainId: string) {
    this.enabledChains.clear(); // Chặn lệnh mới trước; dịch vụ quản lý vị thế chạy độc lập.
    const adapter = this.adapters.get(chainId);
    if (!adapter) throw new Error("Không có bộ kết nối chuỗi");
    await adapter.connect();
    const health = await adapter.healthCheck();
    if (health.status !== "healthy")
      throw new Error("Kết nối chuỗi không hoạt động ổn định");
    this.enabledChains.add(chainId);
  }
  async enableAdditional(chainId: string) {
    const adapter = this.adapters.get(chainId);
    if (!adapter) throw new Error("Chuỗi không khả dụng");
    await adapter.connect();
    if ((await adapter.healthCheck()).status !== "healthy")
      throw new Error("Kết nối chuỗi không hoạt động ổn định");
    this.enabledChains.add(chainId);
  }
  pause() {
    this.enabledChains.clear();
  }
}
export function mockDiscoveryEvent(
  chainId: string,
  index: number,
  now = Date.now(),
): TokenDiscoveryEvent {
  return {
    id: `mock:${chainId}:pool:${index}`,
    chainId,
    tokenAddress: `mock:${chainId}:token:${index}`,
    poolAddress: `mock:${chainId}:pool:${index}`,
    dexId: "mock-discovery",
    timestamp: now,
    source: "MOCK",
  };
}
