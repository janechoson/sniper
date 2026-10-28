import { describe, it, expect } from "vitest";
import {
  tokenStateSchema,
  rugPolicySchema,
  type ManagedPosition,
  type Position,
} from "@sniper/core";
import { defaultSettings } from "@sniper/config";
import {
  hardFilter,
  assessEntry,
  decideRugCheck,
  TradeIntentAuthority,
} from "@sniper/risk";
import { scoreToken, NewLaunchStrategy } from "@sniper/strategies";
import { ExitEngine, evaluateAtomicExit } from "@sniper/positions";
import { sanitizeJevState } from "@sniper/ai";
import { measured, FeatureEngine } from "@sniper/features";
import { securityReadiness } from "../packages/engine/src/rug-analytics";
import { fundingEvidenceLabel } from "../apps/web/components/vi";
import {
  securityState,
  snapshot,
  riskAnswer,
  trip,
  policy,
} from "./rug-fixtures";
const ai = { signal: "strong_buy" as const, confidence: 0.99 };
const state = (chain: string, funding?: boolean) => {
  const s = securityState();
  s.identity.chainId = chain;
  s.market.liquidityUsd = 100000;
  s.market.priceChange15s = 30;
  s.market.buySellRatio = 10;
  s.holders.suspiciousClusterPct = 0;
  s.creator.reputationScore = 90;
  if (funding !== undefined) s.creator.knownBadFunding = funding;
  else delete s.creator.knownBadFunding;
  if (chain !== "solana")
    Object.assign(s.security, {
      blacklistRisk: false,
      upgradeRisk: false,
      pauseRisk: false,
      buyTaxPct: 0,
      sellTaxPct: 0,
    });
  s.quality = {
    "creator.knownBadFunding": {
      quality: funding === undefined ? "UNKNOWN" : "REAL",
      source: funding === undefined ? "UNKNOWN" : "REAL_INTERNAL",
      observedAt: s.observedAt,
    },
  };
  return s;
};
describe("Funding chỉ tham khảo, không phải chốt giao dịch", () => {
  it("collector funding mâu thuẫn giữ UNKNOWN, không hủy phân tích hoặc sửa thành false", async () => {
    const good = state("solana");
    const engine = new FeatureEngine([
      {
        collect: async () => ({
          market: good.market,
          holders: good.holders,
          creator: { ...good.creator, knownBadFunding: true },
          security: good.security,
        }),
      },
      { collect: async () => ({ creator: { knownBadFunding: false } }) },
      { collect: async () => ({ creator: { knownBadFunding: true } }) },
    ]);
    const value = await engine.collect({
      id: "fixture",
      chainId: "solana",
      dexId: "fixture",
      tokenAddress: "fixture",
      poolAddress: "fixture",
      timestamp: Date.now(),
      chainTimestamp: Date.now(),
      source: "RPC",
    });
    expect(value.creator.knownBadFunding).toBeUndefined();
    expect(value.quality?.["creator.knownBadFunding"]?.quality).toBe("UNKNOWN");
    expect(hardFilter(value, defaultSettings()).passed).toBe(true);
  });
  for (const chain of ["solana", "bnb", "robinhood"])
    for (const funding of [undefined, false, true]) {
      it(`${chain}, funding=${String(funding)}: hard filter/risk/strategy/intent không bị chặn`, async () => {
        const s = state(chain, funding),
          settings = defaultSettings();
        expect(hardFilter(s, settings)).toEqual({ passed: true, reasons: [] });
        const score = scoreToken(s, ai);
        expect(
          await new NewLaunchStrategy().evaluate({
            state: s,
            ai,
            score,
            minimumScore: settings.minScore,
          }),
        ).toMatchObject({ passed: true, action: "BUY" });
        const risk = assessEntry(s, score.total, settings, {
          positions: [],
          dailyTrades: 0,
          dailyPnlUsd: 0,
          consecutiveFailures: 0,
          killSwitchActive: false,
        });
        expect(risk.passed).toBe(true);
        const base = trip();
        const roundTrip = {
          ...base,
          buy: { ...base.buy, chainId: chain },
          sell: { ...base.sell!, chainId: chain },
        };
        for (const mode of ["LIVE_DRY_RUN", "LIVE"] as const) {
          const intent = new TradeIntentAuthority(() => true).approve({
            decisionId: "fixture",
            risk,
            walletId: "fixture",
            walletAddress: "fixture",
            side: "BUY",
            mode,
            roundTrip,
            maxSlippageBps: 100,
            maxPriceImpactPct: 2,
            maxRoundTripLossPct: 5,
            idempotencyKey: `${mode}-${chain}-${String(funding)}`,
          });
          expect(intent.mode).toBe(mode);
          expect(intent.amountIn).toBe(roundTrip.buy.amountIn);
        }
        const stored = tokenStateSchema.parse(JSON.parse(JSON.stringify(s)));
        expect(stored.creator.knownBadFunding).toBe(funding);
      });
    }
  it("score và Jev không bị ảnh hưởng bởi funding hoặc quality metadata của funding", () => {
    const states = [undefined, false, true].map((f) => state("solana", f));
    for (const s of states) s.observedAt = states[0]!.observedAt;
    expect(states.map((s) => scoreToken(s, ai).total)).toEqual(
      Array(3).fill(scoreToken(states[0]!, ai).total),
    );
    expect(sanitizeJevState(states[0]!)).toEqual(sanitizeJevState(states[1]!));
    expect(sanitizeJevState(states[1]!)).toEqual(sanitizeJevState(states[2]!));
    expect(JSON.stringify(sanitizeJevState(states[2]!))).not.toContain(
      "knownBadFunding",
    );
  });
  it("true và UNKNOWN hiển thị tham khảo, không đổi UNKNOWN thành false", () => {
    expect(fundingEvidenceLabel(undefined)).toBe("Chưa rõ");
    expect(fundingEvidenceLabel(true)).toContain("Có bằng chứng");
    expect(fundingEvidenceLabel(false)).toContain("Không ghi nhận");
  });
  it("funding=true không tự tạo lệnh thoát; rủi ro hợp đồng/thanh khoản vẫn có thể thoát", () => {
    const s = state("solana", true),
      settings = defaultSettings(),
      now = Date.now();
    const p = {
      closedAt: undefined,
      entryPriceUsd: s.market.priceUsd,
      highestPriceUsd: s.market.priceUsd,
      quantity: "100",
      openedAt: now,
      takenLevels: [],
    } as unknown as Position;
    expect(new ExitEngine().evaluate(p, s, settings, now)).toBeUndefined();
    const atomic = {
      state: "OPEN",
      remainingQuantity: "100",
      initialQuantity: "100",
      remainingCostQuoteAmount: "100",
      openedAt: now,
      takenLevels: [],
      exitPolicy: {
        stopLossPct: 10,
        trailingStopPct: 10,
        maxHoldingSec: 100,
        takeProfit: [],
      },
    } as unknown as ManagedPosition;
    expect(evaluateAtomicExit(atomic, "100", now, s)).toBeUndefined();
    s.security.creatorRisk = 99;
    expect(evaluateAtomicExit(atomic, "100", now, s)?.reason).toBe(
      "CREATOR_RISK",
    );
  });
  it("security/readiness không yêu cầu funding, kể cả config cũ chứa required field đó", async () => {
    const s = await snapshot();
    s.jev = riskAnswer(s);
    const p = rugPolicySchema.parse({
      concentrationBasis: "raw",
      requiredFields: [...policy().requiredFields, "creator.knownBadFunding"],
    });
    s.decision = decideRugCheck(s, p, "LIVE");
    expect(s.decision.decision).toBe("ALLOW");
    s.creator.history = {
      ...s.creator.history!,
      state: "UNKNOWN",
      value: null,
      origin: "UNKNOWN",
    };
    s.creator.criticalIncidents = { ...s.creator.history };
    s.decision = decideRugCheck(
      s,
      rugPolicySchema.parse({ concentrationBasis: "raw" }),
      "LIVE",
    );
    expect(s.decision.decision).toBe("ALLOW");
    expect(securityReadiness(["solana"], [s], 30000)[0]?.ready).toBe(true);
  });
  it.each([
    "honeypot",
    "sellability",
    "transferRestriction",
    "criticalIncidents",
  ])("%s vẫn REJECT, bất kể funding", async (failure) => {
    const s = await snapshot();
    s.jev = riskAnswer(s);
    if (failure === "honeypot")
      s.trading.honeypot = measured("FAIL", "fixture", "REAL_EXTERNAL", "RISK");
    if (failure === "sellability")
      s.trading.sellability = measured(
        "NOT_SELLABLE",
        "fixture",
        "REAL_SIMULATION",
        "RISK",
      );
    if (failure === "transferRestriction")
      s.contract.transferRestriction = measured(
        true,
        "fixture",
        "REAL_ONCHAIN",
        "RISK",
      );
    if (failure === "criticalIncidents")
      s.creator.criticalIncidents = measured(
        1,
        "fixture",
        "REAL_INTERNAL",
        "RISK",
      );
    expect(decideRugCheck(s, policy(), "LIVE").decision).toBe("REJECT");
  });
  it.each(["UNKNOWN", "NOT_SELLABLE"] as const)(
    "intent từ chối %s và mô phỏng không có bằng chứng",
    (sellability) => {
      const authority = new TradeIntentAuthority(() => true);
      expect(() =>
        authority.approve({
          decisionId: "fixture",
          risk: { passed: true, reasons: [] },
          walletId: "fixture",
          side: "BUY",
          mode: "LIVE_DRY_RUN",
          roundTrip: { ...trip(), sellability },
          maxSlippageBps: 100,
          maxPriceImpactPct: 2,
          maxRoundTripLossPct: 5,
          idempotencyKey: "fixture",
        }),
      ).toThrow("SELLABILITY_NOT_PROVEN");
    },
  );
  it("UNKNOWN các thuộc tính rug bắt buộc vẫn REJECT; không áp tax EVM cho Solana", () => {
    for (const chain of ["solana", "bnb", "robinhood"]) {
      const s = state(chain);
      delete s.security.sellRestrictionRisk;
      expect(hardFilter(s, defaultSettings()).reasons).toContain(
        "UNKNOWN_SELL_RESTRICTION",
      );
    }
    expect(
      hardFilter(state("solana"), defaultSettings()).reasons,
    ).not.toContain("UNKNOWN_TAXES");
    const evm = state("bnb");
    delete evm.security.freezeRisk;
    expect(hardFilter(evm, defaultSettings()).passed).toBe(true);
  });
});
