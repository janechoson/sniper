import { describe, it, expect } from "vitest";
import { JevAIProvider, sanitizeJevState } from "@sniper/ai";
import { tokenStateSchema } from "@sniper/core";
const state = () =>
  tokenStateSchema.parse({
    identity: {
      chainId: "solana",
      address: "TOKEN_ADDRESS_PRIVATE_CONTEXT",
      source: "RPC",
    },
    observedAt: Date.now(),
    market: { priceUsd: 0.00001 },
    holders: {},
    creator: { address: "CREATOR_ADDRESS_PRIVATE_CONTEXT" },
    security: { evidence: ["PRIVATE_CONTEXT_NOT_FOR_AI"] },
    privateKey: "NEVER_SEND",
    wallet: { address: "WALLET_CONTEXT" },
  });
const answer = () => ({
  model: "jev-1.14.0",
  answers: {
    action: {
      type: "choice",
      choice: "BUY",
      confidence: 0.8,
      probabilities: { BUY: 0.8, HOLD: 0.1, SKIP: 0.1 },
    },
    momentum: {
      type: "score",
      score: 3,
      confidence: 0.7,
      probabilities: { 0: 0, 1: 0, 2: 0.2, 3: 0.7, 4: 0.1 },
    },
    quality: {
      type: "score",
      score: 4,
      confidence: 0.9,
      probabilities: { 0: 0, 1: 0, 2: 0, 3: 0.1, 4: 0.9 },
    },
    suspicious: { type: "noul", noul: 0.1 },
    insufficient_data: { type: "noul", noul: 0.2 },
  },
  usage: { input_tokens: 120, output_tokens: 30 },
});
describe("Jev chính thức và ranh giới dữ liệu", () => {
  it("probe runtime có đáp án typed và ghim model, không tạo quyết định giao dịch", async () => {
    let body = "";
    const p = new JevAIProvider({
      apiKey: "fixture",
      requireSupportedRuntime: false,
      fetch: async (_, init) => {
        body = String(init?.body);
        return Response.json(answer());
      },
    });
    expect(p.healthCheck().reasons).toContain("JEV_NOT_VERIFIED");
    expect((await p.verify()).status).toBe("READY");
    const sent = JSON.parse(body);
    expect(sent.model).toBe("jev-1.14.0");
    expect(sent.state.identity.chainId).toBe("healthcheck");
    expect(JSON.stringify(sent.state)).not.toMatch(/wallet|balance|privateKey/);
  });
  it("placeholder không phải key hợp lệ và không gọi SDK", async () => {
    let calls = 0;
    const ai = new JevAIProvider({
      apiKey: "YOUR_KEY",
      requireSupportedRuntime: false,
      fetch: async () => {
        calls++;
        throw new Error("UNEXPECTED_NETWORK");
      },
    });
    expect(ai.healthCheck().reasons).toContain("TYPESAFE_API_KEY_MISSING");
    await expect(ai.classify(state())).rejects.toThrow("AI_FAILED");
    expect(calls).toBe(0);
  });
  it("loại địa chỉ ví, người tạo, evidence và khóa khỏi state gửi AI", () => {
    const payload = JSON.stringify(sanitizeJevState(state()));
    expect(payload).not.toMatch(/PRIVATE_CONTEXT|NEVER_SEND|WALLET_CONTEXT/);
    expect(payload).toContain("priceUsd");
    expect(payload).not.toContain("top1Pct");
  });
  it("dùng SDK systemOne với typed questions và chuẩn hóa từng loại đáp án", async () => {
    let requestBody = "";
    let endpoint = "";
    let auth = "";
    const provider = new JevAIProvider({
      apiKey: "fixture-key",
      requireSupportedRuntime: false,
      fetch: async (url, init) => {
        endpoint = url;
        requestBody = String(init?.body);
        auth = new Headers(init?.headers).get("authorization") ?? "";
        return Response.json(answer());
      },
    });
    const result = await provider.classify(state());
    expect(endpoint).toBe("https://api.typesafe.ai/v1/systemone");
    expect(auth).toBe("Bearer fixture-key");
    const sent = JSON.parse(requestBody);
    expect(sent.questions.action.type).toBe("choice");
    expect(sent.questions.momentum.type).toBe("score");
    expect(sent.questions.suspicious.type).toBe("noul");
    expect(result).toMatchObject({
      provider: "jev",
      model: "jev-1.14.0",
      action: "BUY",
      signal: "buy",
      momentumScore: 75,
      qualityScore: 100,
      confidence: 0.8,
      suspiciousProbability: 0.1,
      usage: { inputTokens: 120, outputTokens: 30 },
    });
    expect(JSON.stringify(result)).not.toContain("fixture-key");
  });
  it("không cho đáp án BUY che bằng chứng thiếu dữ liệu", async () => {
    const response = answer();
    response.answers.insufficient_data.noul = 0.8;
    const provider = new JevAIProvider({
      apiKey: "fixture",
      requireSupportedRuntime: false,
      fetch: async () => Response.json(response),
    });
    expect((await provider.classify(state())).signal).toBe("avoid");
  });
  it.each([401, 429, 500])(
    "HTTP %i trả AI_FAILED, không tạo BUY",
    async (status) => {
      const provider = new JevAIProvider({
        apiKey: "fixture",
        requireSupportedRuntime: false,
        fetch: async () =>
          Response.json({ error: "PRIVATE_KEY_MUST_NOT_LEAK" }, { status }),
      });
      await expect(provider.classify(state())).rejects.toThrow(/^AI_FAILED$/);
      expect(provider.healthCheck().status).toBe("DOWN");
    },
  );
  it("schema sai trả AI_FAILED", async () => {
    const response = answer();
    response.answers.momentum.score = 99;
    const provider = new JevAIProvider({
      apiKey: "fixture",
      requireSupportedRuntime: false,
      fetch: async () => Response.json(response),
    });
    await expect(provider.classify(state())).rejects.toThrow("AI_FAILED");
  });
  it("lỗi mạng và timeout không chuyển sang mock", async () => {
    const bad = new JevAIProvider({
      apiKey: "fixture",
      requireSupportedRuntime: false,
      timeoutMs: 30,
      fetch: async () => {
        throw new Error("SECRET_NETWORK_URL");
      },
    });
    await expect(bad.classify(state())).rejects.toThrow(/^AI_FAILED$/);
    const slow = new JevAIProvider({
      apiKey: "fixture",
      requireSupportedRuntime: false,
      timeoutMs: 30,
      fetch: async (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("ABORTED")),
            { once: true },
          );
        }),
    });
    await expect(slow.classify(state())).rejects.toThrow(/^AI_FAILED$/);
  });
  it("thiếu key bị chặn trước khi gọi mạng", async () => {
    let calls = 0;
    const provider = new JevAIProvider({
      requireSupportedRuntime: false,
      fetch: async () => {
        calls++;
        return Response.json(answer());
      },
    });
    await expect(provider.classify(state())).rejects.toThrow("AI_FAILED");
    expect(calls).toBe(0);
  });
});
