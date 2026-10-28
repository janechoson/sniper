import { describe, it, expect } from "vitest";
import { ExternalSecurityProvider } from "@sniper/features";
import { JevRiskClassifier, compactRugState } from "@sniper/ai";
import { snapshot, policy } from "./rug-fixtures";
import { decideRugCheck } from "@sniper/risk";
const evm = "0x" + "11".repeat(20);
const external = (
  id: "goplus" | "honeypot" | "rugcheck",
  fetcher: typeof fetch,
) =>
  new ExternalSecurityProvider(id, {
    enabled: true,
    evmChains: new Map([
      ["bnb", 56],
      ["robinhood", 4663],
    ]),
    fetcher,
  });
describe("Adapter bảo mật bên ngoài", () => {
  it("GoPlus xác nhận chain list, scale tax 0..1, thiếu/chuỗi rỗng giữ unknown", async () => {
    let requests = 0;
    const p = external("goplus", async (url) => {
      requests++;
      return Response.json(
        String(url).includes("supported_chains")
          ? { code: 1, result: [{ id: "56" }] }
          : {
              code: 1,
              result: {
                [evm]: {
                  buy_tax: "0.05",
                  sell_tax: "",
                  is_blacklisted: "",
                  is_mintable: "1",
                  holder_count: "123",
                },
              },
            },
      );
    });
    const r = await p.analyze({ chainId: "bnb", tokenAddress: evm });
    expect(r.status).toBe("OK");
    expect(
      r.findings.find((f) => f.field === "buyTaxPct")?.evidence.value,
    ).toBe(5);
    expect(
      r.findings.some(
        (f) => f.field === "sellTaxPct" || f.field === "blacklistCapability",
      ),
    ).toBe(false);
    expect(
      r.findings.find((f) => f.field === "mintCapability")?.evidence.state,
    ).toBe("RISK");
    await p.analyze({ chainId: "bnb", tokenAddress: evm });
    expect(requests).toBe(2);
    p.invalidate("bnb", evm);
    await p.analyze({ chainId: "bnb", tokenAddress: evm });
    expect(requests).toBe(3);
  });
  it("GoPlus không gửi token nếu chain không có trong danh sách chính thức", async () => {
    const urls: string[] = [];
    const p = external("goplus", async (url) => {
      urls.push(String(url));
      return Response.json({ code: 1, result: [{ id: "56" }] });
    });
    expect(
      (await p.analyze({ chainId: "robinhood", tokenAddress: evm })).status,
    ).toBe("UNSUPPORTED");
    expect(urls).toHaveLength(1);
  });
  it("Honeypot trả false không trở thành sellability proof; simulation lỗi không suy ra honeypot", async () => {
    const p = external("honeypot", async () =>
      Response.json({
        token: { address: evm, totalHolders: 10 },
        chain: { id: "56" },
        simulationSuccess: false,
      }),
    );
    const r = await p.analyze({ chainId: "bnb", tokenAddress: evm });
    expect(r.status).toBe("OK");
    expect(
      r.findings.some(
        (f) => f.field === "sellability" || f.field === "honeypot",
      ),
    ).toBe(false);
    expect(p.supports("robinhood")).toBe(false);
  });
  it("Honeypot kiểm tra chain/token/pair, không nhận phản hồi token khác", async () => {
    const p = external("honeypot", async () =>
      Response.json({
        token: { address: "0x" + "22".repeat(20) },
        chain: { id: "56" },
        honeypotResult: { isHoneypot: false },
      }),
    );
    expect(
      (await p.analyze({ chainId: "bnb", tokenAddress: evm })).status,
    ).toBe("UNAVAILABLE");
  });
  it("RugCheck chỉ đọc GET summary, không lấy score thay bằng chứng hoặc tự gắn LP an toàn", async () => {
    let url = "";
    const p = external("rugcheck", async (input) => {
      url = String(input);
      return Response.json({ lpLockedPct: 100, score: 0, risks: [] });
    });
    const r = await p.analyze({
      chainId: "solana",
      tokenAddress: "So11111111111111111111111111111111111111112",
    });
    expect(url).toContain("/report/summary");
    expect(r.findings.map((f) => f.field)).toEqual(["lpLockedPct"]);
    expect(p.supports("bnb")).toBe(false);
  });
  it.each([401, 429, 500])(
    "HTTP %s không tạo evidence SAFE",
    async (status) => {
      const p = external(
        "goplus",
        async () => new Response("error", { status }),
      );
      const r = await p.analyze({ chainId: "bnb", tokenAddress: evm });
      expect(r.status).toBe("UNAVAILABLE");
      expect(r.findings).toEqual([]);
      expect((await p.healthCheck()).status).toBe("DOWN");
    },
  );
  it("provider disabled không gọi mạng", async () => {
    let calls = 0;
    const p = new ExternalSecurityProvider("goplus", {
      enabled: false,
      evmChains: new Map([["bnb", 56]]),
      fetcher: async () => {
        calls++;
        throw new Error();
      },
    });
    expect(
      (await p.analyze({ chainId: "bnb", tokenAddress: evm })).status,
    ).toBe("DISABLED");
    expect(calls).toBe(0);
  });
});
const answer = () => ({
  model: "jev-1.14.0",
  answers: {
    rug_risk: { type: "score", score: 1 },
    suspicious: { type: "noul", noul: 0.1 },
    insufficient_data: { type: "noul", noul: 0.2 },
    risk_category: {
      type: "choice",
      choice: "CONTRACT",
      confidence: 0.8,
      probabilities: {
        CONTRACT: 0.8,
        HOLDERS: 0.05,
        CREATOR: 0.05,
        LIQUIDITY: 0.02,
        SELLABILITY: 0.02,
        MARKET: 0.02,
        MULTIPLE: 0.02,
        INSUFFICIENT_DATA: 0.02,
      },
    },
    action: {
      type: "choice",
      choice: "PASS",
      confidence: 0.9,
      probabilities: { PASS: 0.9, WATCH: 0.05, SKIP: 0.05 },
    },
  },
  usage: { input_tokens: 100, output_tokens: 20 },
});
describe("Jev risk typed SDK", () => {
  it("score giữ thang0..4; hash/usage/model; sanitize và cache theo snapshot", async () => {
    const s = await snapshot();
    s.creator.address!.value = "PRIVATE_CREATOR";
    s.holderClusters = [
      {
        wallets: ["PRIVATE_WALLET"],
        confidence: "WEAK_SIGNAL",
        reasonCodes: [],
        evidence: [],
      },
    ];
    expect(JSON.stringify(compactRugState(s))).not.toMatch(
      /PRIVATE_CREATOR|PRIVATE_WALLET|TOKEN_FIXTURE|POOL_FIXTURE/,
    );
    let body = "",
      calls = 0;
    const ai = new JevRiskClassifier({
      apiKey: "fixture-only-key",
      requireSupportedRuntime: false,
      fetch: async (_url, init) => {
        calls++;
        body = String(init?.body);
        return Response.json(answer());
      },
    });
    const result = await ai.classify(s);
    expect(result).toMatchObject({
      status: "AVAILABLE",
      rugRiskScore: 1,
      resolvedModel: "jev-1.14.0",
      inputTokens: 100,
      outputTokens: 20,
      featureSnapshotHash: s.snapshotHash,
    });
    expect(JSON.parse(body).questions.rug_risk.type).toBe("score");
    expect(JSON.parse(body).questions.risk_category.type).toBe("choice");
    await ai.classify(s);
    expect(calls).toBe(1);
    expect(JSON.stringify(result)).not.toContain("fixture-only-key");
  });
  it.each([401, 429, 500])(
    "Jev HTTP%s thành UNAVAILABLE và LIVE từ chối",
    async (status) => {
      const s = await snapshot(),
        ai = new JevRiskClassifier({
          apiKey: "fixture",
          requireSupportedRuntime: false,
          fetch: async () => new Response("failure", { status }),
        });
      s.jev = await ai.classify(s);
      expect(s.jev.status).toBe("UNAVAILABLE");
      expect(decideRugCheck(s, policy(), "LIVE").reasonCodes).toContain(
        "AI_UNAVAILABLE",
      );
    },
  );
  it("phản hồi thiếu answer bị từ chối", async () => {
    const s = await snapshot(),
      ai = new JevRiskClassifier({
        apiKey: "fixture",
        requireSupportedRuntime: false,
        fetch: async () => Response.json({ model: "jev-1.14.0", answers: {} }),
      });
    expect((await ai.classify(s)).status).toBe("UNAVAILABLE");
  });
  it("timeout hủy fetch và không có fallback PASS", async () => {
    const ai = new JevRiskClassifier({
      apiKey: "fixture",
      requireSupportedRuntime: false,
      timeoutMs: 20,
      fetch: async (_url, init) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("abort")),
            { once: true },
          );
        }),
    });
    expect((await ai.classify(await snapshot())).status).toBe("UNAVAILABLE");
  });
});
