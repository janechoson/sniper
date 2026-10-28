import { describe, it, expect } from "vitest";
import { createFeatureEngine, MockFeatureSource } from "@sniper/features";
import { JevProvider, MockAIProvider, safeClassify } from "@sniper/ai";
import { scoreToken, strategyRegistry } from "@sniper/strategies";
import { assessEntry, KillSwitch } from "@sniper/risk";
import { defaultSettings } from "@sniper/config";
import { mockDiscoveryEvent } from "@sniper/chains/discovery";
const fixture = () =>
  createFeatureEngine(new MockFeatureSource()).collect(
    mockDiscoveryEvent("solana", 0),
  );
describe("Phân loại, chấm điểm và rủi ro", () => {
  it("bỏ qua khi AI chưa cấu hình, sai dữ liệu, quá hạn hoặc gặp lỗi", async () => {
    const state = await fixture();
    expect(await safeClassify(new JevProvider(), state)).toBeUndefined();
    expect(
      await safeClassify(
        new JevProvider(async () => ({ signal: "buy", confidence: 2 })),
        state,
      ),
    ).toBeUndefined();
    expect(
      await safeClassify(
        {
          id: "bad",
          classify: async () => {
            throw new Error("offline");
          },
        },
        state,
      ),
    ).toBeUndefined();
    expect(
      await safeClassify(
        new JevProvider(() => new Promise(() => {}), 5),
        state,
      ),
    ).toBeUndefined();
  });
  it("chấm điểm theo quy tắc và từ chối trọng số không hợp lệ", async () => {
    const state = await fixture();
    const ai = await new MockAIProvider().classify(state);
    const score = scoreToken(state, ai);
    expect(score.total).toBeGreaterThan(60);
    expect(score.weights.ai).toBe(0.1);
    expect(Object.keys(score.components)).toHaveLength(6);
    expect(() =>
      scoreToken(state, ai, {
        momentum: 1,
        holders: 1,
        liquidity: 1,
        creator: 1,
        security: 1,
        ai: 1,
      }),
    ).toThrow();
  });
  it.each(["new-launch", "momentum"])(
    "đánh giá chiến lược %s nhưng không cấp quyền thực thi",
    async (id) => {
      const state = await fixture();
      const ai = await new MockAIProvider().classify(state);
      expect(
        (
          await strategyRegistry.get(id)!.evaluate({
            state,
            ai,
            score: scoreToken(state, ai),
            minimumScore: 60,
          })
        ).action,
      ).toBe("BUY");
    },
  );
  it("áp dụng giới hạn danh mục ở bước cuối", async () => {
    const state = await fixture();
    const settings = defaultSettings();
    const decision = assessEntry(state, 80, settings, {
      positions: [],
      dailyTrades: 30,
      dailyPnlUsd: -200,
      consecutiveFailures: 3,
      killSwitchActive: true,
    });
    expect(decision.reasons).toEqual(
      expect.arrayContaining([
        "KILL_SWITCH",
        "DAILY_TRADES",
        "DAILY_LOSS",
        "FAILED_TRANSACTIONS",
      ]),
    );
  });
  it("ngắt khẩn cấp giữ trạng thái và chỉ được xóa khi kiểm tra trạng thái đạt", () => {
    const kill = new KillSwitch();
    kill.trip("RPC_UNHEALTHY");
    expect(() => kill.reset(false)).toThrow();
    expect(kill.snapshot().active).toBe(true);
    kill.reset(true);
    expect(kill.snapshot().active).toBe(false);
  });
});
