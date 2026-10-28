import { describe, expect, it } from "vitest";
import { sizeEntry } from "../packages/engine/src/position-sizing";
import { settingsSchema } from "@sniper/config";
import { SerialQueue } from "../packages/engine/src/queue";
import { TradeIntentAuthority } from "@sniper/risk";
import { atomicQuoteSchema, type RoundTripResult } from "@sniper/core";
import { MemoryRepository } from "@sniper/storage";
import { DurableExecutionStore } from "@sniper/execution";
const base = {
  percent: 10,
  tokenIn: "quote",
  balanceRaw: 1000n,
  reservedRaw: 0n,
  nativeBalanceRaw: 10000n,
  nativeReserveRaw: 100n,
  spendsNative: false,
  decimals: 0,
  quoteUsd: "1",
  observedAt: 1000,
  now: 1000,
  maxTradeUsd: 2000,
  maxTokenExposureUsd: 2000,
};
describe("Khối lượng theo vốn khả dụng", () => {
  it("gắn đúng sizing vào intent bền vững; thay amount phải báo giá/phê duyệt lại", async () => {
    const sizing = sizeEntry({
      ...base,
      observedAt: Date.now(),
      now: Date.now(),
    });
    const buy = atomicQuoteSchema.parse({
      id: "buy",
      providerId: "fixture",
      chainId: "bnb",
      tokenIn: "quote",
      tokenOut: "token",
      amountIn: sizing.amountIn,
      expectedAmountOut: "200",
      minimumAmountOut: "200",
      decimalsIn: 0,
      decimalsOut: 0,
      priceImpactPct: 1,
      quotedAt: Date.now(),
      expiresAt: Date.now() + 10000,
      source: "RPC",
      quality: "REAL",
    });
    const trip: RoundTripResult = {
      buy,
      sell: {
        ...buy,
        id: "sell",
        tokenIn: "token",
        tokenOut: "quote",
        amountIn: "200",
        expectedAmountOut: "100",
        minimumAmountOut: "100",
      },
      sellability: "UNKNOWN",
      evidence: "QUOTE_ONLY",
      roundTripLossPct: 1,
      reasons: [],
    };
    const authority = new TradeIntentAuthority(() => true);
    const input = {
      decisionId: "decision",
      risk: { passed: true, reasons: [] },
      walletId: "paper",
      side: "BUY" as const,
      mode: "PAPER" as const,
      roundTrip: trip,
      maxSlippageBps: 100,
      maxPriceImpactPct: 2,
      maxRoundTripLossPct: 5,
      idempotencyKey: "entry:fixture",
      allowQuoteOnlyPaper: true,
      entrySizing: sizing,
    };
    expect(() =>
      authority.approve({
        ...input,
        entrySizing: { ...sizing, amountIn: "101" },
      }),
    ).toThrow("POSITION_SIZE_APPROVAL_MISMATCH");
    expect(() =>
      authority.approve({
        ...input,
        entrySizing: { ...sizing, observedAt: Date.now() - 10001 },
      }),
    ).toThrow("POSITION_SIZE_APPROVAL_MISMATCH");
    const intent = authority.approve(input);
    expect(authority.accepts({ ...intent, amountIn: "101" })).toBe(false);
    const repository = new MemoryRepository();
    const store = new DurableExecutionStore(repository);
    await store.begin(intent);
    const restored = new DurableExecutionStore(repository);
    await restored.restore();
    expect(restored.intent(intent.id)?.entrySizing).toEqual(sizing);
    expect(restored.get(intent.idempotencyKey)?.state).toBe("APPROVED");
  });
  it.each([
    [100n, 10n],
    [1000n, 100n],
    [10000n, 1000n],
  ])("10%% số dư %s", (balanceRaw, expected) => {
    expect(sizeEntry({ ...base, balanceRaw }).amountIn).toBe(String(expected));
  });
  it("tính lại 1000 → 100 → 90 → 81, không dùng vốn ban đầu", () => {
    let balanceRaw = 1000n;
    const sizes = [];
    for (let i = 0; i < 3; i++) {
      const n = BigInt(sizeEntry({ ...base, balanceRaw }).amountIn);
      sizes.push(n);
      balanceRaw -= n;
    }
    expect(sizes).toEqual([100n, 90n, 81n]);
  });
  it("trừ vốn đã giữ và reserve native đúng tài sản", () => {
    expect(sizeEntry({ ...base, reservedRaw: 100n }).amountIn).toBe("90");
    expect(sizeEntry({ ...base, spendsNative: true }).amountIn).toBe("90");
    expect(sizeEntry({ ...base, spendsNative: false }).amountIn).toBe("100");
  });
  it("không clamp khối lượng khi vượt cap", () => {
    expect(() =>
      sizeEntry({ ...base, balanceRaw: 10000n, maxTradeUsd: 100 }),
    ).toThrow("MAX_TRADE_USD");
    expect(() =>
      sizeEntry({ ...base, balanceRaw: 10000n, maxTokenExposureUsd: 100 }),
    ).toThrow("TOKEN_EXPOSURE");
  });
  it("từ chối số dư cũ, thiếu reserve, số dư 0 và phần trăm không hợp lệ", () => {
    expect(() => sizeEntry({ ...base, now: 11001 })).toThrow(
      "CAPITAL_BALANCE_UNKNOWN",
    );
    expect(() => sizeEntry({ ...base, nativeBalanceRaw: 99n })).toThrow(
      "INSUFFICIENT_NATIVE_RESERVE",
    );
    expect(() => sizeEntry({ ...base, balanceRaw: 0n })).toThrow(
      "INSUFFICIENT_TRADING_CAPITAL",
    );
    for (const percent of [0, -1, 101, NaN])
      expect(() =>
        settingsSchema.parse({ positionSizePercent: percent }),
      ).toThrow();
  });
  it("serialize vốn: hai entry không cùng tính trên số dư cũ", async () => {
    const mutex = new SerialQueue();
    let balanceRaw = 1000n;
    const sizes = await Promise.all(
      [1, 2].map(() =>
        mutex.run(async () => {
          const n = BigInt(sizeEntry({ ...base, balanceRaw }).amountIn);
          await Promise.resolve();
          balanceRaw -= n;
          return n;
        }),
      ),
    );
    expect(sizes).toEqual([100n, 90n]);
  });
  it("giữ số nguyên trên MAX_SAFE_INTEGER", () => {
    const balanceRaw = 900719925474099312345n;
    const result = sizeEntry({ ...base, balanceRaw, decimals: 18 });
    expect(BigInt(result.amountIn)).toBe(balanceRaw / 10n);
  });
});
