import { describe, it, expect } from "vitest";
import { z } from "zod";
import { JsonRpcClient } from "@sniper/chains";
import { MemoryRepository } from "@sniper/storage";
import { JournalRepository, NamespacedRepository } from "@sniper/storage";
import { mkdtemp, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableExecutionStore, RealPaperExecutor } from "@sniper/execution";
import { AtomicPositionManager, evaluateAtomicExit } from "@sniper/positions";
import { TradeIntentAuthority } from "@sniper/risk";
import { defaultSettings } from "@sniper/config";
import { atomicQuoteSchema } from "@sniper/core";
import { valuePortfolio } from "../packages/engine/src/real-accounting";
import { strategyAnalytics } from "../packages/engine/src/analytics";
describe("Phục hồi và kế toán số lượng nguyên", () => {
  it("phân trang toàn bộ journal theo namespace với bộ nhớ theo kích thước trang", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sniper-page-")),
      repository = new JournalRepository(directory),
      paper = new NamespacedRepository(repository, "real-paper"),
      live = new NamespacedRepository(repository, "real-live");
    try {
      for (let i = 0; i < 7; i++)
        await paper.append({
          id: String(i),
          kind: "real.candidate",
          createdAt: i,
          payload: { index: i },
        });
      await live.append({
        id: "foreign",
        kind: "real.candidate",
        createdAt: 99,
        payload: { index: 99 },
      });
      const page = await paper.page("real.candidate", 2, 3);
      expect(page.total).toBe(7);
      expect(page.entries.map((e) => e.id)).toEqual(["4", "3", "2"]);
      expect((await paper.page("real.candidate", 1000000, 3)).entries).toEqual(
        [],
      );
      expect((await live.page("real.candidate", 0, 10)).total).toBe(1);
    } finally {
      await repository.close();
      await unlink(join(directory, "journal.jsonl"));
      await rmdir(directory);
    }
  });
  it.each(["eth_sendRawTransaction", "sendTransaction"])(
    "không tự gửi lại %s khi mất phản hồi",
    async (method) => {
      let requests = 0;
      const rpc = new JsonRpcClient("fixture", "http://127.0.0.1/unused", {
        fetcher: async () => {
          requests++;
          throw new Error("lost response");
        },
      });
      try {
        await expect(
          rpc.request(method, ["signed-fixture"], z.string()),
        ).rejects.toThrow();
        expect(requests).toBe(1);
      } finally {
        rpc.close();
      }
    },
  );
  it("thoát một phần, phục hồi, giữ giá vốn và tổng lợi nhuận đã tính phí", async () => {
    const repository = new MemoryRepository(),
      store = new DurableExecutionStore(repository),
      positions = new AtomicPositionManager(repository),
      authority = new TradeIntentAuthority(() => true),
      settings = defaultSettings();
    const quote = (
      id: string,
      input: string,
      output: string,
      amount: string,
      out: string,
      decimalsIn: number,
      decimalsOut: number,
    ) =>
      atomicQuoteSchema.parse({
        id,
        providerId: "fixture",
        chainId: "bnb",
        tokenIn: input,
        tokenOut: output,
        amountIn: amount,
        expectedAmountOut: out,
        minimumAmountOut: out,
        decimalsIn,
        decimalsOut,
        priceImpactPct: 0,
        estimatedNetworkFeeUsd: "1",
        quotedAt: Date.now(),
        expiresAt: Date.now() + 30000,
        source: "RPC",
        quality: "REAL",
      });
    const buy = quote("buy", "usd", "token", "100000000", "100000000000", 6, 9);
    const entry = authority.approve({
      decisionId: "candidate",
      risk: { passed: true, reasons: [] },
      walletId: "paper",
      side: "BUY",
      mode: "PAPER",
      roundTrip: {
        buy,
        sell: quote(
          "reverse",
          "token",
          "usd",
          buy.minimumAmountOut,
          "99000000",
          9,
          6,
        ),
        sellability: "UNKNOWN",
        evidence: "QUOTE_ONLY",
        roundTripLossPct: 1,
        reasons: [],
      },
      maxSlippageBps: 100,
      maxPriceImpactPct: 2,
      maxRoundTripLossPct: 5,
      allowQuoteOnlyPaper: true,
      idempotencyKey: "entry",
      valuation: { quoteUsdPrice: "1", nativeDecimals: 18 },
    });
    const executor = new RealPaperExecutor(store, (i) => authority.accepts(i));
    const fill = await executor.execute(entry);
    await positions.applyFill(fill, entry, settings);
    const opened = positions.all()[0]!;
    const sell = async (amount: string, out: string, key: string) => {
      const intent = authority.approve({
        decisionId: key,
        risk: { passed: true, reasons: [] },
        walletId: "paper",
        side: "SELL",
        mode: "PAPER",
        roundTrip: {
          buy: quote(key, "token", "usd", amount, out, 9, 6),
          sellability: "UNKNOWN",
          evidence: "QUOTE_ONLY",
          reasons: [],
        },
        maxSlippageBps: 100,
        maxPriceImpactPct: 2,
        maxRoundTripLossPct: 5,
        idempotencyKey: key,
        positionId: opened.id,
        exitLevel: key === "half" ? 50 : undefined,
        valuation: { quoteUsdPrice: "1", nativeDecimals: 18 },
      });
      const result = await executor.execute(intent);
      await positions.applyFill(result, intent, settings);
      return { result, intent };
    };
    const half = await sell("50000000000", "75000000", "half");
    expect(positions.get(opened.id)?.remainingQuantity).toBe("50000000000");
    expect(positions.get(opened.id)?.remainingCostQuoteAmount).toBe("50000000");
    const restarted = new AtomicPositionManager(repository);
    await restarted.restore();
    await restarted.applyFill(half.result, half.intent, settings);
    expect(restarted.get(opened.id)?.remainingQuantity).toBe("50000000000");
    expect(restarted.get(opened.id)?.takenLevels).toEqual([50]);
    await sell("50000000000", "75000000", "rest");
    expect(positions.get(opened.id)?.state).toBe("CLOSED");
    const valuation = valuePortfolio(
      store.all(),
      (id) => store.intent(id),
      positions.all(),
      new Map(),
    );
    expect(valuation.closedTrades[0]?.netPnlUsd).toBe(47);
    expect(valuation.winRate).toBe(100);
    const analytics = strategyAnalytics([], valuation, 1, 1);
    expect(analytics.averageReturnPct).toBeCloseTo((47 / 101) * 100);
    expect(analytics.profitFactor).toBeNull();
  });
  it("giữ UNKNOWN khi chưa có giao dịch đóng; không hiển thị mức drawdown giả", () => {
    const portfolio = valuePortfolio([], () => undefined, [], new Map());
    const analytics = strategyAnalytics([], portfolio, 0, 0);
    expect(analytics.averageReturnPct).toBeNull();
    expect(analytics.maxDrawdownUsd).toBeNull();
    expect(analytics.realizedEquity).toEqual([]);
  });
  it("trailing stop dùng giá bán cho mỗi đơn vị sau khi thoát một phần", async () => {
    const now = Date.now();
    const position = {
      id: "p",
      walletId: "w",
      chainId: "bnb",
      tokenAddress: "t",
      quoteTokenAddress: "q",
      decimals: 9,
      quoteDecimals: 6,
      providerId: "fixture",
      mode: "PAPER" as const,
      state: "PARTIAL_EXIT" as const,
      initialQuantity: "100000000000000000000",
      remainingQuantity: "50000000000000000000",
      investedQuoteAmount: "100000000",
      remainingCostQuoteAmount: "50000000",
      realizedQuotePnl: "0",
      exitTransactionIds: [],
      openedAt: now,
      updatedAt: now,
      takenLevels: [],
      peakExitQuote: { amount: "200000000", quantity: "100000000000000000000" },
      exitPolicy: {
        stopLossPct: 30,
        trailingStopPct: 10,
        maxHoldingSec: 3600,
        takeProfit: [],
      },
    };
    expect(evaluateAtomicExit(position, "95000000", now)).toBeUndefined();
    expect(evaluateAtomicExit(position, "89000000", now)?.reason).toBe(
      "TRAILING_STOP",
    );
  });
});
