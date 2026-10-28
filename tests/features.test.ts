import { it, expect, describe } from "vitest";
import {
  createFeatureEngine,
  MockFeatureSource,
  analyzeHolders,
} from "@sniper/features";
import { hardFilter } from "@sniper/risk";
import { defaultSettings } from "@sniper/config";
import { mockDiscoveryEvent } from "@sniper/chains/discovery";
describe("Đặc trưng và bộ lọc cứng", () => {
  it("kết hợp bộ thu thập độc lập thành trạng thái chuẩn hóa", async () => {
    const state = await createFeatureEngine(new MockFeatureSource()).collect(
      mockDiscoveryEvent("solana", 0),
    );
    expect(state.identity.source).toBe("MOCK");
    expect(hardFilter(state, defaultSettings()).passed).toBe(true);
  });
  it.each([
    [3, "LOW_LIQUIDITY"],
    [4, "MINT_CAPABILITY"],
    [5, "UNKNOWN_SELL_RESTRICTION"],
    [6, "HOLDER_CONCENTRATION"],
  ])("từ chối mẫu giả lập %s với lý do %s", async (index, reason) => {
    const state = await createFeatureEngine(new MockFeatureSource()).collect(
      mockDiscoveryEvent("bnb", Number(index)),
    );
    expect(hardFilter(state, defaultSettings()).reasons).toContain(reason);
  });
  it("không suy diễn tính độc lập của ví hoặc quan hệ cấp vốn khi thiếu dữ liệu", () => {
    expect(
      analyzeHolders(
        [
          { address: "a", balance: 10 },
          { address: "b", balance: 5 },
        ],
        100,
        true,
      ).suspiciousClusterPct,
    ).toBeUndefined();
    expect(analyzeHolders([], 100, false)).toEqual({});
  });
  it("nhận diện nhóm ví có bằng chứng cấp vốn chung", () => {
    expect(
      analyzeHolders(
        [
          { address: "a", balance: 10, fundingWallet: "f" },
          { address: "b", balance: 5, fundingWallet: "f" },
        ],
        100,
        true,
      ).suspiciousClusterPct,
    ).toBe(15);
  });
});
