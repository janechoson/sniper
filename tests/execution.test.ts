import { describe, it, expect } from "vitest";
import { createFeatureEngine, MockFeatureSource } from "@sniper/features";
import { MockDexAdapter } from "@sniper/dex";
import { RouteEngine } from "@sniper/routing";
import { PaperExecutor, LiveExecutor } from "@sniper/execution";
import { ExitEngine, markPosition, positionPnl } from "@sniper/positions";
import { defaultSettings } from "@sniper/config";
import { mockDiscoveryEvent } from "@sniper/chains/discovery";
const fixture = async () => {
  const state = await createFeatureEngine(new MockFeatureSource()).collect(
    mockDiscoveryEvent("solana", 0),
  );
  const dex = new MockDexAdapter("solana", () => ({
    priceUsd: 0.01,
    liquidityUsd: 80000,
  }));
  const routes = new RouteEngine([dex]);
  const roundTrip = await routes.roundTrip(
    {
      chainId: "solana",
      tokenAddress: state.identity.address,
      side: "BUY",
      amount: 50,
      slippageBps: 50,
    },
    2,
  );
  const executor = new PaperExecutor();
  const position = await executor.open({
    state,
    quote: roundTrip.buy,
    receivedQuantity: roundTrip.buySimulation.receivedAmount!,
    now: Date.now(),
  });
  return { state, dex, routes, roundTrip, executor, position };
};
describe("Khớp lệnh mô phỏng, lãi/lỗ và thoát lệnh theo quy tắc", () => {
  it("tính phí, tác động giá và trượt giá vào số lượng và lỗ sau vòng mua bán", async () => {
    const { position, roundTrip, executor } = await fixture();
    expect(Number(position.quantity)).toBeLessThan(5000);
    const closed = await executor.close(
      position,
      roundTrip.sell,
      "TEST",
      Date.now(),
    );
    expect(closed.closedAt).toBeDefined();
    expect(closed.realizedPnlUsd).toBeLessThan(0);
    expect(closed.remainingCostUsd).toBe(0);
    expect(positionPnl(closed).totalUsd).toBe(closed.realizedPnlUsd);
  });
  it("bắt buộc mô phỏng bán sau mô phỏng mua", async () => {
    const { state, dex } = await fixture();
    dex.simulateSwap = async ({ quote }) => ({
      success: quote.side === "BUY",
      receivedAmount: quote.expectedOutput,
      reasons: quote.side === "SELL" ? ["SELL_RESTRICTED"] : [],
      source: "MOCK",
    });
    await expect(
      new RouteEngine([dex]).roundTrip(
        {
          chainId: "solana",
          tokenAddress: state.identity.address,
          side: "BUY",
          amount: 50,
          slippageBps: 50,
        },
        2,
      ),
    ).rejects.toThrow("Mô phỏng bán thất bại");
  });
  it("giữ giao dịch tiền thật ở trạng thái bị khóa", async () => {
    const { state, roundTrip } = await fixture();
    await expect(
      new LiveExecutor().open({
        state,
        quote: roundTrip.buy,
        receivedQuantity: 100,
        now: Date.now(),
      }),
    ).rejects.toThrow("LIVE_DISABLED");
  });
  it("định giá phần vị thế còn lại mà không thay đổi lãi/lỗ đã chốt", async () => {
    const { position } = await fixture();
    const marked = markPosition(position, 0.02);
    expect(marked.unrealizedPnlUsd).toBeCloseTo(
      Number(position.quantity) * 0.02 - 50,
    );
    expect(marked.realizedPnlUsd).toBe(0);
  });
  it("chốt lời từng phần đúng một lần và phân bổ chi phí theo tỷ lệ", async () => {
    const { position, state, executor } = await fixture();
    const settings = defaultSettings();
    const price = position.entryPriceUsd * 1.4;
    state.market.priceUsd = price;
    const decision = new ExitEngine().evaluate(
      markPosition(position, price),
      state,
      settings,
      Date.now(),
    )!;
    expect(decision.reason).toBe("TAKE_PROFIT_30");
    expect(decision.quantity).toBeCloseTo(
      Number(position.initialQuantity) * 0.2,
    );
    const dex = new MockDexAdapter("solana", () => ({
      priceUsd: price,
      liquidityUsd: 80000,
    }));
    const quote = await dex.getQuote({
      chainId: "solana",
      tokenAddress: state.identity.address,
      side: "SELL",
      amount: decision.quantity,
      slippageBps: 50,
    });
    const partial = await executor.close(
      position,
      quote,
      decision.reason,
      Date.now(),
      decision.level,
    );
    expect(partial.remainingCostUsd).toBeCloseTo(40);
    expect(
      new ExitEngine().evaluate(partial, state, settings, Date.now()),
    ).toBeUndefined();
  });
  it.each([
    ["STOP_LOSS", 0.7],
    ["TAKE_PROFIT_30", 1.4],
  ])("kích hoạt %s khi giá gấp %s lần", async (reason, multiple) => {
    const { position, state } = await fixture();
    state.market.priceUsd = position.entryPriceUsd * Number(multiple);
    expect(
      new ExitEngine().evaluate(position, state, defaultSettings(), Date.now())
        ?.reason,
    ).toBe(reason);
  });
  it("bám theo đỉnh giá và ưu tiên thoát lệnh khẩn cấp", async () => {
    const { position, state } = await fixture();
    const high = markPosition(position, position.entryPriceUsd * 2);
    state.market.priceUsd = position.entryPriceUsd * 1.6;
    expect(
      new ExitEngine().evaluate(high, state, defaultSettings(), Date.now())
        ?.reason,
    ).toBe("TRAILING_STOP");
    state.market.priceUsd = position.entryPriceUsd * 0.7;
    expect(
      new ExitEngine().evaluate(high, state, defaultSettings(), Date.now())
        ?.reason,
    ).toBe("STOP_LOSS");
  });
});
