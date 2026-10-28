import { describe, it, expect } from "vitest";
import {
  rugSnapshotSchema,
  evidenceSchema,
  type CandidateRecord,
} from "@sniper/core";
import {
  RugCheckEngine,
  measured,
  refreshRugSnapshot,
  CreatorIntelligenceProvider,
  InternalCreatorHistoryProvider,
  clusterHolderFunding,
} from "@sniper/features";
import { decideRugCheck } from "@sniper/risk";
import { MemoryRepository, NamespacedRepository } from "@sniper/storage";
import { TokenSecurityWorkflow } from "../packages/engine/src/rug-workflow";
import { analyzeCandidate } from "../packages/engine/src/analyzer";
import { defaultSettings } from "@sniper/config";
import { realConfigSchema } from "@sniper/config";
import { FeatureEngine } from "@sniper/features";
import {
  snapshot,
  policy,
  riskAnswer,
  request,
  provider,
  securityState,
  trip,
} from "./rug-fixtures";
describe("Rug Check bằng chứng và quyết định", () => {
  it("override theo chain không tự reset chính sách nền bằng defaults", () => {
    const c = realConfigSchema.parse({
      version: 1,
      rugCheck: {
        policy: { rejectActiveMint: true },
        policyByChain: { bnb: { maxTop1Pct: 20 } },
      },
    });
    expect(c.rugCheck.policy.rejectActiveMint).toBe(true);
    expect(c.rugCheck.policyByChain.bnb).toEqual({ maxTop1Pct: 20 });
    expect(() =>
      realConfigSchema.parse({
        version: 1,
        rugCheck: { policyByChain: { bnb: { maxTop1Pct: "bad" } } },
      }),
    ).toThrow();
  });
  it("không nhận trạng thái authority hoặc số phần trăm giả dạng đúng shape", async () => {
    const s = await snapshot();
    s.contract.mintAuthority!.value = 0;
    expect(() => rugSnapshotSchema.parse(s)).toThrow();
    s.contract.mintAuthority!.value = "REVOKED";
    s.holders.top1Pct!.value = 101;
    expect(() => rugSnapshotSchema.parse(s)).toThrow();
  });
  it("SAFE không nhận null; UNKNOWN không nhận false/0", () => {
    for (const value of [false, 0, "SAFE"])
      expect(() =>
        evidenceSchema.parse({
          ...measured(value, "RPC", "REAL_ONCHAIN"),
          state: "UNKNOWN",
        }),
      ).toThrow();
    expect(() =>
      evidenceSchema.parse({
        ...measured(null, "RPC", "REAL_ONCHAIN"),
        state: "SAFE",
      }),
    ).toThrow();
  });
  it("token nhìn tốt chỉ ALLOW theo policy khi đủ bằng chứng bắt buộc", async () => {
    const s = await snapshot();
    s.jev = riskAnswer(s);
    expect(decideRugCheck(s, policy(), "LIVE").decision).toBe("ALLOW");
    expect(s.contract.arbitraryExternalCalls?.state).toBe("UNKNOWN");
    expect(s.dataQuality.completeness).toBeLessThan(1);
  });
  const cases: [
    string,
    (s: Awaited<ReturnType<typeof snapshot>>) => void,
    string,
  ][] = [
    [
      "honeypot",
      (s) =>
        (s.trading.honeypot = measured(
          "FAIL",
          "external",
          "REAL_EXTERNAL",
          "RISK",
        )),
      "HONEYPOT_DETECTED",
    ],
    [
      "sell simulation thất bại",
      (s) =>
        (s.trading.sellability = measured(
          "NOT_SELLABLE",
          "simulation",
          "REAL_SIMULATION",
          "RISK",
        )),
      "SELL_SIMULATION_FAILED",
    ],
    [
      "sellability chưa rõ",
      (s) =>
        (s.trading.sellability = {
          ...measured(null, "UNKNOWN", "UNKNOWN"),
          state: "UNKNOWN",
        }),
      "SELLABILITY_UNKNOWN",
    ],
    [
      "holder tập trung",
      (s) => (s.holders.top1Pct = measured(80, "RPC", "REAL_ONCHAIN")),
      "TOP1_CONCENTRATION_HIGH",
    ],
    [
      "mint active theo policy",
      (s) =>
        (s.contract.mintAuthority = measured(
          "ACTIVE",
          "RPC",
          "REAL_ONCHAIN",
          "RISK",
        )),
      "MINT_AUTHORITY_ACTIVE",
    ],
    [
      "freeze active theo policy",
      (s) =>
        (s.contract.freezeAuthority = measured(
          "ACTIVE",
          "RPC",
          "REAL_ONCHAIN",
          "RISK",
        )),
      "FREEZE_AUTHORITY_ACTIVE",
    ],
    [
      "blacklist",
      (s) =>
        (s.contract.blacklistCapability = measured(
          true,
          "RPC",
          "REAL_ONCHAIN",
          "RISK",
        )),
      "BLACKLIST_CAPABILITY",
    ],
    [
      "creator incidents",
      (s) =>
        (s.creator.criticalIncidents = measured(
          1,
          "internal",
          "REAL_INTERNAL",
          "RISK",
        )),
      "CREATOR_CRITICAL_HISTORY",
    ],
    [
      "liquidity drop",
      (s) =>
        (s.liquidity.recentRemovalPct = measured(
          95,
          "observation",
          "ESTIMATED",
          "RISK",
        )),
      "LIQUIDITY_REMOVAL_DETECTED",
    ],
    [
      "round-trip lỗ lớn",
      (s) =>
        (s.trading.roundTripLossPct = measured(
          72,
          "simulation",
          "REAL_SIMULATION",
        )),
      "ROUND_TRIP_LOSS_HIGH",
    ],
  ];
  it.each(cases)("từ chối %s dù Jev PASS", async (_label, mutate, code) => {
    const s = await snapshot();
    mutate(s);
    s.jev = riskAnswer(s);
    const result = decideRugCheck(s, policy(), "LIVE");
    expect(result.decision).toBe("REJECT");
    expect(result.reasonCodes).toContain(code);
  });
  it("không tự gán mọi quyền active là rug nếu policy cho phép", async () => {
    const s = await snapshot();
    s.contract.mintAuthority = measured(
      "ACTIVE",
      "RPC",
      "REAL_ONCHAIN",
      "RISK",
    );
    expect(
      decideRugCheck(
        s,
        { ...policy(), rejectActiveMint: false },
        "PAPER",
        "PRECHECK",
      ).decision,
    ).toBe("ALLOW");
  });
  it("LP creator control chỉ reject theo policy; LP burned không xóa thiếu dữ liệu", async () => {
    const s = await snapshot();
    s.liquidity.creatorLpPct = measured(90, "RPC", "REAL_ONCHAIN", "RISK");
    s.liquidity.lpBurned = measured(10, "RPC", "REAL_ONCHAIN");
    expect(
      decideRugCheck(
        s,
        { ...policy(), rejectCreatorLpControl: true },
        "LIVE",
        "PRECHECK",
      ).reasonCodes,
    ).toContain("CREATOR_LP_CONTROL");
    s.creator.history = {
      ...measured(null, "UNKNOWN", "UNKNOWN"),
      state: "UNKNOWN",
    };
    expect(
      decideRugCheck(s, policy(), "LIVE", "HARD_FILTER").reasonCodes,
    ).toContain("SECURITY_DATA_INCOMPLETE");
  });
  it("sellability hết hạn không được dùng lại", async () => {
    const s = await snapshot();
    s.trading.sellability!.observedAt = new Date(
      Date.now() - 6000,
    ).toISOString();
    expect(
      decideRugCheck(s, policy(), "LIVE", "HARD_FILTER").reasonCodes,
    ).toContain("SELLABILITY_UNKNOWN");
  });
  it("hard filter PASS nhưng Jev SKIP vẫn không mở entry", async () => {
    const s = await snapshot();
    s.jev = { ...riskAnswer(s), advisoryAction: "SKIP" };
    expect(decideRugCheck(s, policy(), "LIVE").reasonCodes).toContain(
      "JEV_ADVISORY_SKIP",
    );
  });
  it("điểm rug cao hoặc AI thiếu dữ liệu không fail open", async () => {
    const s = await snapshot();
    s.jev = {
      ...riskAnswer(s),
      rugRiskScore: 4,
      insufficientDataProbability: 0.9,
    };
    expect(decideRugCheck(s, policy(), "LIVE").reasonCodes).toEqual(
      expect.arrayContaining(["JEV_RUG_RISK_HIGH", "JEV_INSUFFICIENT_DATA"]),
    );
    delete s.jev;
    expect(decideRugCheck(s, policy(), "LIVE").reasonCodes).toContain(
      "AI_UNAVAILABLE",
    );
  });
  it("một nguồn PASS không xóa RISK; giữ từng nguồn và bất đồng", async () => {
    const a = provider((r) =>
      r.findings.push({
        section: "contract",
        field: "blacklistCapability",
        evidence: measured(true, "RPC", "REAL_ONCHAIN", "RISK"),
      }),
    );
    const b = {
      ...provider((r) =>
        r.findings.push({
          section: "contract",
          field: "blacklistCapability",
          evidence: measured(false, "external", "REAL_EXTERNAL"),
        }),
      ),
      id: "external",
      analyze: async () => {
        const r = await provider((r) =>
          r.findings.push({
            section: "contract",
            field: "blacklistCapability",
            evidence: measured(false, "external", "REAL_EXTERNAL"),
          }),
        ).analyze(request);
        return { ...r, provider: "external" };
      },
    };
    const s = await new RugCheckEngine([a, b]).collect(
      request,
      securityState(),
    );
    expect(s.contract.blacklistCapability?.value).toBe(true);
    expect(s.disagreements.map((d) => d.field)).toContain(
      "contract.blacklistCapability",
    );
    expect(s.externalProviders).toHaveLength(2);
  });
  it("provider timeout/RPC failure chỉ để UNKNOWN", async () => {
    const failing = {
      ...provider(),
      analyze: async () => {
        throw new Error("network");
      },
    };
    const pending = {
      ...provider(),
      id: "timeout",
      analyze: () => new Promise<never>(() => {}),
    };
    const s = await new RugCheckEngine([failing, pending], 10).collect(
      request,
      securityState(),
    );
    expect(s.externalProviders.map((p) => p.status)).toEqual([
      "UNAVAILABLE",
      "UNAVAILABLE",
    ]);
    expect(s.contract.mintAuthority?.state).toBe("UNKNOWN");
    expect(s.externalProviders[1]?.error).toBe("PROVIDER_TIMEOUT");
  });
  it("không nhận MOCK, sai identity hoặc trường tự bịa của provider", async () => {
    const s = await new RugCheckEngine([
      provider((r) => {
        r.findings[0]!.evidence.origin = "MOCK";
      }),
    ]).collect(request, securityState());
    expect(s.externalProviders[0]?.status).toBe("UNAVAILABLE");
    expect(() =>
      rugSnapshotSchema.parse({
        ...s,
        contract: {
          ...s.contract,
          validToken: { ...measured(true, "mock", "MOCK") },
        },
      }),
    ).not.toThrow();
    expect(
      decideRugCheck({ ...s, source: "MOCK" }, policy(), "LIVE", "PRECHECK")
        .reasonCodes,
    ).toContain("MOCK_SECURITY_FORBIDDEN");
  });
  it("semantic hash không thay vì latency/time nhưng đổi khi bằng chứng đổi", async () => {
    const s = await snapshot(),
      hash = s.snapshotHash;
    s.latencies.rpcLatencyMs = 999;
    s.contract.mintAuthority!.observedAt = new Date().toISOString();
    expect(refreshRugSnapshot(s).snapshotHash).toBe(hash);
    s.contract.mintAuthority!.value = "ACTIVE";
    expect(refreshRugSnapshot(s).snapshotHash).not.toBe(hash);
  });
  it("Hard Filter REJECT ngăn cả Jev risk lẫn Jev giao dịch được gọi", async () => {
    let riskCalls = 0,
      tradeCalls = 0;
    const workflow = new TokenSecurityWorkflow({
      engine: new RugCheckEngine([
        provider((r) =>
          r.findings.push({
            section: "trading",
            field: "honeypot",
            evidence: measured("FAIL", "external", "REAL_EXTERNAL", "RISK"),
          }),
        ),
      ]),
      policy: policy(),
      mode: "LIVE",
      enabled: true,
      prepare: async () => ({
        trip: trip(),
        quoteLatencyMs: 1,
        sellSimulationLatencyMs: 1,
      }),
      classify: async (s) => {
        riskCalls++;
        return riskAnswer(s);
      },
    });
    const state = securityState();
    const features = new (class extends FeatureEngine {
      constructor() {
        super([]);
      }
      override async collect() {
        return state;
      }
    })();
    const record = await analyzeCandidate(
      {
        id: "candidate",
        dexId: "fixture",
        timestamp: Date.now(),
        source: "RPC",
        ...request,
      },
      features,
      {
        id: "fixture-ai",
        classify: async () => {
          tradeCalls++;
          throw new Error("must not call");
        },
      },
      defaultSettings(),
      Date.now(),
      5000,
      1000,
      workflow,
    );
    expect(record.action).toBe("REJECT");
    expect(riskCalls).toBe(0);
    expect(tradeCalls).toBe(0);
  });
  it("workflow đủ bằng chứng mới gọi Jev; quote failure giữ UNKNOWN", async () => {
    let calls = 0;
    const workflow = new TokenSecurityWorkflow({
      engine: new RugCheckEngine([provider()]),
      policy: policy(),
      mode: "LIVE",
      enabled: true,
      prepare: async () => {
        throw new Error("network");
      },
      classify: async (s) => {
        calls++;
        return riskAnswer(s);
      },
    });
    const record: CandidateRecord = {
      id: "c",
      event: {
        id: "e",
        dexId: "fixture",
        timestamp: Date.now(),
        source: "RPC",
        ...request,
      },
      state: securityState(),
      action: "SKIP",
      reasons: [],
      createdAt: Date.now(),
    };
    await workflow.collect(record);
    expect((await workflow.beforeAI(record)).passed).toBe(false);
    expect(record.rugCheck?.trading.sellability?.state).toBe("UNKNOWN");
    expect(calls).toBe(0);
  });
  it("restart không mất snapshot namespace và creator incident không nhân đôi", async () => {
    const root = new MemoryRepository(),
      repo = new NamespacedRepository(root, "real-paper"),
      creators = new InternalCreatorHistoryProvider(repo);
    await creators.record({
      chainId: "solana",
      tokenAddress: request.tokenAddress,
      creatorAddress: "creator",
      transactionId: "tx",
      observedAt: Date.now(),
      evidence: "CREATION_TRANSACTION",
      outcome: "OBSERVED",
    });
    const history = new CreatorIntelligenceProvider(repo, creators);
    const incident = {
      id: "one",
      chainId: "solana",
      tokenAddress: request.tokenAddress,
      creatorAddress: "creator",
      actorAddress: "creator",
      kind: "LIQUIDITY_REMOVAL_CONFIRMED" as const,
      evidenceReference: "tx:real-fixture",
      origin: "REAL_ONCHAIN" as const,
      observedAt: Date.now(),
    };
    await history.recordIncident(incident);
    await history.recordIncident(incident);
    const restored = new CreatorIntelligenceProvider(repo, creators);
    await restored.restore();
    expect(
      (await restored.analyze(request)).findings.find(
        (f) => f.field === "criticalIncidents",
      )?.evidence.value,
    ).toBe(1);
    await expect(
      restored.recordIncident({
        ...incident,
        id: "bad",
        actorAddress: "other",
      }),
    ).rejects.toThrow("CREATOR_INCIDENT_ACTOR_UNPROVEN");
    const s = await snapshot();
    await repo.append({
      id: s.id,
      kind: "rug.snapshot",
      payload: s,
      createdAt: Date.now(),
    });
    expect(
      rugSnapshotSchema.parse(
        (await repo.read()).find((r) => r.kind === "rug.snapshot")?.payload,
      ).snapshotHash,
    ).toBe(s.snapshotHash);
    expect(
      await new NamespacedRepository(root, "real-live").read(),
    ).toHaveLength(0);
  });
  it("clustering cùng funder chỉ là tín hiệu, không suy ra cùng chủ", () => {
    const clusters = clusterHolderFunding(
      ["a", "b", "c"].map((wallet) => ({
        chainId: "solana",
        tokenAddress: request.tokenAddress,
        wallet,
        funder: "fund",
        transactionId: "tx-" + wallet,
        observedAt: Date.now(),
        firstFunderVerified: true,
      })),
      "solana",
      request.tokenAddress,
    );
    expect(clusters[0]?.confidence).toBe("STRONG_SIGNAL");
    expect(clusters[0]?.reasonCodes).toContain(
      "COMMON_FUNDER_DOES_NOT_PROVE_COMMON_OWNER",
    );
  });
});
