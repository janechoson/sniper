import { describe, it, expect } from "vitest";
import {
  FeatureEngine,
  createFeatureEngine,
  MockFeatureSource,
} from "@sniper/features";
import { MockDexAdapter } from "@sniper/dex";
import { RouteEngine } from "@sniper/routing";
import { defaultSettings } from "@sniper/config";
import { hardFilter, assessEntry } from "@sniper/risk";
import { mockDiscoveryEvent } from "@sniper/chains/discovery";
describe("Các ranh giới chặn an toàn khi lỗi", () => {
  it("gộp các đặc trưng độc lập mà không làm mất dữ liệu quan sát", async () => {
    const engine = new FeatureEngine([
      { collect: async () => ({ market: { priceUsd: 1 } }) },
      { collect: async () => ({ market: { liquidityUsd: 50000 } }) },
    ]);
    const state = await engine.collect(mockDiscoveryEvent("solana", 0));
    expect(state.market).toEqual({ priceUsd: 1, liquidityUsd: 50000 });
  });
  it("từ chối bằng chứng mâu thuẫn, không cho bộ thu thập sau ghi đè dữ liệu nguy hiểm thành an toàn", async () => {
    const engine = new FeatureEngine([
      {
        collect: async () => ({
          security: { mintRisk: true, evidence: ["a"] },
        }),
      },
      {
        collect: async () => ({
          security: { mintRisk: false, evidence: ["b"] },
        }),
      },
    ]);
    await expect(
      engine.collect(mockDiscoveryEvent("solana", 0)),
    ).rejects.toThrow("Dữ liệu đặc trưng mâu thuẫn");
  });
  it("giữ yêu cầu riêng từng chuỗi và không coi dữ liệu chưa rõ là không có rủi ro", async () => {
    const state = await createFeatureEngine(new MockFeatureSource()).collect(
      mockDiscoveryEvent("solana", 0),
    );
    state.security.blacklistRisk = undefined;
    expect(hardFilter(state, defaultSettings()).passed).toBe(true);
    expect(state.security.blacklistRisk).toBeUndefined();
    state.identity.chainId = "bnb";
    expect(hardFilter(state, defaultSettings()).reasons).toContain(
      "UNKNOWN_BLACKLIST",
    );
    state.identity.chainId = "unconfigured";
    expect(hardFilter(state, defaultSettings()).reasons).toContain(
      "UNKNOWN_CHAIN_SECURITY_POLICY",
    );
  });
  it("áp dụng trần giá trị lệnh riêng biệt", async () => {
    const state = await createFeatureEngine(new MockFeatureSource()).collect(
      mockDiscoveryEvent("solana", 0),
    );
    expect(
      assessEntry(
        state,
        80,
        { ...defaultSettings(), tradeSizeUsd: 150, maxTradeUsd: 100 },
        {
          positions: [],
          dailyTrades: 0,
          dailyPnlUsd: 0,
          consecutiveFailures: 0,
          killSwitchActive: false,
        },
      ).reasons,
    ).toContain("MAX_TRADE_USD");
  });
  it("cô lập nguồn báo giá lỗi và từ chối định danh không khớp", async () => {
    const dex = new MockDexAdapter("solana", () => ({
      priceUsd: 1,
      liquidityUsd: 100000,
    }));
    const invalid = new MockDexAdapter("solana", () => ({
      priceUsd: 1,
      liquidityUsd: 100000,
    }));
    const get = invalid.getQuote.bind(invalid);
    invalid.getQuote = async (request) => ({
      ...(await get(request)),
      chainId: "bnb",
    });
    const request = {
      chainId: "solana",
      tokenAddress: "mock:token",
      side: "BUY" as const,
      amount: 50,
      slippageBps: 50,
    };
    await expect(new RouteEngine([invalid]).quote(request)).rejects.toThrow(
      "Không có tuyến giao dịch khả dụng",
    );
    expect((await new RouteEngine([invalid, dex]).quote(request)).chainId).toBe(
      "solana",
    );
  });
  it("từ chối báo giá hết hạn và số lượng mô phỏng sai định dạng", async () => {
    let time = 1000;
    const dex = new MockDexAdapter(
      "solana",
      () => ({ priceUsd: 1, liquidityUsd: 100000 }),
      () => time,
    );
    const routes = new RouteEngine([dex], () => time);
    const quote = await routes.quote({
      chainId: "solana",
      tokenAddress: "mock:token",
      side: "BUY",
      amount: 50,
      slippageBps: 50,
    });
    time = 7000;
    expect((await routes.simulate(quote)).success).toBe(false);
    time = 1000;
    dex.simulateSwap = async () => ({
      success: true,
      receivedAmount: Number.NaN,
      reasons: [],
      source: "MOCK",
    });
    await expect(routes.simulate(quote)).rejects.toThrow();
  });
});
