import { describe, it, expect } from "vitest";
import { MemoryRepository } from "@sniper/storage";
import {
  loadEnv,
  realConfigSchema,
  defaultSettings,
  chainsFromEnv,
} from "@sniper/config";
import {
  atomicQuoteSchema,
  tokenStateSchema,
  type TokenDiscoveryEvent,
  type CandidateRecord,
} from "@sniper/core";
import { FeatureEngine, RugCheckEngine } from "@sniper/features";
import { RealTradingEngine } from "@sniper/engine";
import { TradingWallet } from "@sniper/wallet";
import { ObservationBook } from "../packages/engine/src/observation-book";
import { analyzeObservation } from "../packages/engine/src/observation-analysis";
import { rugPolicySchema } from "@sniper/core";
const event: TokenDiscoveryEvent = {
  id: "fixture-observation",
  chainId: "solana",
  tokenAddress: "fixture-token",
  poolAddress: "fixture-pool",
  dexId: "fixture-dex",
  source: "RPC",
  timestamp: Date.now(),
  chainTimestamp: Date.now(),
};
const quote = (amount = "5000000", output = "1000000000") =>
  atomicQuoteSchema.parse({
    id: "fixture-quote",
    providerId: "fixture-provider",
    chainId: "solana",
    tokenIn: "fixture-usd",
    tokenOut: "fixture-token",
    amountIn: amount,
    expectedAmountOut: output,
    minimumAmountOut: output,
    decimalsIn: 6,
    decimalsOut: 9,
    priceImpactPct: 1,
    quotedAt: Date.now(),
    expiresAt: Date.now() + 30000,
    source: "RPC",
    quality: "REAL",
  });
const candidate = (): CandidateRecord => ({
  id: "fixture-candidate",
  event,
  createdAt: Date.now(),
  action: "SKIP",
  reasons: [],
  observation: {
    stage: "WATCHING",
    budgetUsd: "5",
    sellability: "UNKNOWN",
    liveBlockingReasons: ["UNKNOWN_LIQUIDITY"],
    virtualAction: "BUY",
  },
});
describe("Quan sát dữ liệu thật, thực thi chỉ mô phỏng", () => {
  it("giữ5USD tạm thời, không cho phép mở bằng quote50USD/impact vượt hạn hoặc sự kiện MOCK", async () => {
    const book = new ObservationBook(new MemoryRepository()),
      settings = defaultSettings();
    await expect(
      book.open(candidate(), quote("50000000"), "1", settings),
    ).rejects.toThrow("OBSERVATION_QUOTE_INVALID");
    await expect(
      book.open(candidate(), { ...quote(), priceImpactPct: 8 }, "1", settings),
    ).rejects.toThrow("OBSERVATION_QUOTE_INVALID");
    await expect(
      book.open(
        { ...candidate(), event: { ...event, source: "MOCK" } },
        quote(),
        "1",
        settings,
      ),
    ).rejects.toThrow("OBSERVATION_QUOTE_INVALID");
    expect(book.all()).toHaveLength(0);
  });
  it("số lượng từ quote thật; partial sell/stop loss và restart không mở trùng hay tạo execution", async () => {
    const repository = new MemoryRepository(),
      book = new ObservationBook(repository),
      settings = defaultSettings();
    const opened = await book.open(candidate(), quote(), "1", settings);
    for (const dexId of ["pump-fun", "pump-swap", "raydium-cpmm"]) {
      expect(
        await book.open(
          {
            ...candidate(),
            id: "other-" + dexId,
            event: { ...event, dexId, poolAddress: "other-pool-" + dexId },
          },
          quote(),
          "1",
          settings,
        ),
      ).toBeUndefined();
    }
    expect(opened?.sellability).toBe("UNKNOWN");
    expect(opened?.execution).toBe("SIMULATED");
    const sell = {
      ...quote(),
      tokenIn: "fixture-token",
      tokenOut: "fixture-usd",
      amountIn: "1000000000",
      expectedAmountOut: "6500000",
      minimumAmountOut: "6500000",
      decimalsIn: 9,
      decimalsOut: 6,
    };
    const partial = await book.mark(opened!.id, sell, settings);
    expect(partial?.remainingQuantity).toBe("800000000");
    expect(partial?.realizedQuoteAmount).toBe("1300000");
    expect(partial?.remainingCostQuote).toBe("4000000");
    const reopened = new ObservationBook(repository);
    await reopened.restore();
    expect(reopened.openTrades()).toHaveLength(1);
    expect(
      await reopened.open(candidate(), quote(), "1", settings),
    ).toBeUndefined();
    const closed = await reopened.mark(
      opened!.id,
      {
        ...sell,
        amountIn: "800000000",
        expectedAmountOut: "3000000",
        minimumAmountOut: "3000000",
      },
      settings,
    );
    expect(closed?.state).toBe("CLOSED");
    expect(closed?.remainingQuantity).toBe("0");
    expect(
      (await repository.read()).every((r) => r.kind === "observation.trade"),
    ).toBe(true);
  });
  it("toast ledger không đóng vị thế khi chưa có báo giá thoát còn hiệu lực", async () => {
    const book = new ObservationBook(new MemoryRepository()),
      settings = defaultSettings(),
      opened = await book.open(candidate(), quote(), "1", settings);
    const old = {
      ...quote(),
      tokenIn: "fixture-token",
      tokenOut: "fixture-usd",
      amountIn: "1000000000",
      decimalsIn: 9,
      decimalsOut: 6,
      quotedAt: Date.now() - 20000,
      expiresAt: Date.now() - 10000,
    };
    await expect(book.mark(opened!.id, old, settings)).rejects.toThrow(
      "OBSERVATION_EXIT_QUOTE_INVALID",
    );
    expect(book.openTrades()).toHaveLength(1);
  });
  it("phân loại quan sát giữ nguyên lý do LIVE bị chặn, không tạo quyền BUY", async () => {
    class FixtureFeatures extends FeatureEngine {
      constructor() {
        super([]);
      }
      override async collect() {
        return tokenStateSchema.parse({
          identity: {
            chainId: "solana",
            address: event.tokenAddress,
            source: "RPC",
            ageSec: 1,
          },
          observedAt: Date.now(),
          market: { priceUsd: 1, liquidityUsd: 80000 },
          holders: { top1Pct: 1 },
          creator: {},
          security: {
            validToken: true,
            overallRisk: 0,
            mintRisk: false,
            freezeRisk: false,
            transferRestrictionRisk: false,
            sellRestrictionRisk: false,
          },
        });
      }
    }
    let calls = 0;
    const record = await analyzeObservation(event, {
      features: new FixtureFeatures(),
      ai: {
        id: "fixture-only",
        classify: async () => {
          calls++;
          return { action: "BUY", signal: "strong_buy", confidence: 0.9 };
        },
      },
      rug: new RugCheckEngine([]),
      settings: { ...defaultSettings(), minScore: 0 },
      policy: rugPolicySchema.parse({}),
      aiTimeoutMs: 1000,
      claimAiSlot: () => true,
      stage: () => {},
    });
    expect(calls).toBe(1);
    expect(record.observation?.virtualAction).toBe("BUY");
    expect(record.action).toBe("SKIP");
    expect(record.risk?.passed).toBe(false);
    expect(record.observation?.liveBlockingReasons).not.toContain(
      "UNKNOWN_CREATOR_FUNDING",
    );
    expect(record.observation?.sellability).toBe("UNKNOWN");
  });
  it("khóa executor trong chế độ quan sát và không tự nạp journal cũ", async () => {
    const env = loadEnv({
      DATA_MODE: "real",
      AI_PROVIDER: "jev",
      OBSERVATION_ONLY: "true",
    });
    expect(env.IMPORT_LEGACY_JOURNAL).toBe(false);
    const engine = new RealTradingEngine({
      repository: new MemoryRepository(),
      chains: chainsFromEnv(env),
      env,
      config: realConfigSchema.parse({ version: 1 }),
      wallets: new TradingWallet(chainsFromEnv(env), {}),
      configurationLoaded: true,
    });
    try {
      await engine.initialize();
      await expect(engine.closePosition("anything")).rejects.toThrow(
        "OBSERVATION_EXECUTION_DISABLED",
      );
      const snapshot = await engine.snapshot();
      expect(snapshot.liveEnabled).toBe(false);
      expect(snapshot.observation?.budgetUsd).toBe("5");
      expect(snapshot.executions).toHaveLength(0);
    } finally {
      await engine.shutdown();
    }
    expect(() =>
      loadEnv({
        DATA_MODE: "real",
        OBSERVATION_ONLY: "true",
        TRADING_MODE: "live",
        LIVE_TRADING_ACK: "true",
      }),
    ).toThrow();
  });
});
