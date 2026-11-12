import assert from "node:assert/strict";
import { test } from "node:test";
import { CodexRuntime, type RuntimeUsage } from "../src/codex-runtime.js";

function response(name: string, input: any) {
  const value = name === "codex_ai_guard"
    ? { action: "PASS", riskLevel: "LOW", confidence: 0.8, summary: "fixture", matchedKnowledge: [], marketObservations: [{ evidenceId: "MARKET-1", explanation: "fixture" }], uncertaintyReasons: [], evidenceCutoffAt: input.evidenceCutoffAt }
    : name === "knowledge_holdout_replay"
      ? { prediction: "PASS", summary: "fixture", supportingEvidenceIds: [], contradictoryEvidenceIds: [], uncertaintyReasons: [] }
      : { action: "HOLD", reason: "fixture", ruleIds: [], supportingEventIds: [], contradictoryEventIds: [], uncertainty: "fixture", hypothesis: null };
  return new Response(JSON.stringify({ status: "completed", output: [{ content: [{ type: "output_text", text: JSON.stringify(value) }] }], usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 } }), { status: 200 });
}

test("31st request and requests beyond 250,000 daily tokens work in all Codex lanes", async () => {
  const previousInterval = process.env.CODEX_MIN_REQUEST_INTERVAL_MS;
  const previousInputPrice = process.env.CODEX_INPUT_USD_PER_1M_TOKENS;
  const previousOutputPrice = process.env.CODEX_OUTPUT_USD_PER_1M_TOKENS;
  process.env.CODEX_MIN_REQUEST_INTERVAL_MS = "0";
  process.env.CODEX_INPUT_USD_PER_1M_TOKENS = "1";
  process.env.CODEX_OUTPUT_USD_PER_1M_TOKENS = "2";
  let used: RuntimeUsage = { day: Math.floor(Date.now() / 86400000), dayTokens: 250001, hour: Math.floor(Date.now() / 3600000), hourCalls: 30, totalCalls: 30 };
  let transportCalls = 0;
  const runtime = new CodexRuntime("fixture", "fixture", async (_url, init) => {
    transportCalls++;
    const body = JSON.parse(String(init?.body));
    return response(body.text.format.name, JSON.parse(body.input));
  }, { read: () => used, write: (next) => { used = { ...next }; } });
  try {
    await runtime.analyze({});
    const cutoff = Date.now();
    await runtime.analyzeGuard({ evidenceCutoffAt: cutoff });
    await runtime.evaluateKnowledge({});
    assert.equal(transportCalls, 3);
    assert.equal(runtime.status().usage.totalCalls, 33);
    assert.equal(runtime.status().usage.hourCalls, 33);
    assert.equal(runtime.status().usage.inputTokens, 300);
    assert.equal(runtime.status().usage.outputTokens, 150);
    assert.equal(runtime.status().usage.totalTokens, 450);
    assert.equal(runtime.status().estimatedCost.configured, true);
    assert.ok(Math.abs(runtime.status().estimatedCost.usd - 0.0006) < 1e-12);
    assert.equal("budget" in runtime.status(), false);
  } finally {
    if (previousInterval === undefined) delete process.env.CODEX_MIN_REQUEST_INTERVAL_MS; else process.env.CODEX_MIN_REQUEST_INTERVAL_MS = previousInterval;
    if (previousInputPrice === undefined) delete process.env.CODEX_INPUT_USD_PER_1M_TOKENS; else process.env.CODEX_INPUT_USD_PER_1M_TOKENS = previousInputPrice;
    if (previousOutputPrice === undefined) delete process.env.CODEX_OUTPUT_USD_PER_1M_TOKENS; else process.env.CODEX_OUTPUT_USD_PER_1M_TOKENS = previousOutputPrice;
  }
});

test("actual provider HTTP 429 is surfaced and applies provider cooldown", async () => {
  const previousInterval = process.env.CODEX_MIN_REQUEST_INTERVAL_MS;
  process.env.CODEX_MIN_REQUEST_INTERVAL_MS = "0";
  let calls = 0;
  const runtime = new CodexRuntime("fixture", "fixture", async () => {
    calls++;
    return new Response("rate limited", { status: 429, headers: { "retry-after": "1" } });
  });
  try {
    const before = Date.now();
    await assert.rejects(runtime.analyze({}), /CODEX_HTTP_429/);
    assert.equal(calls, 1);
    assert.equal(runtime.status().lastError, "CODEX_HTTP_429");
    assert.ok(runtime.status().nextAvailableAt >= before + 1000);
    assert.equal(runtime.status().usage.totalCalls, 1);
  } finally {
    if (previousInterval === undefined) delete process.env.CODEX_MIN_REQUEST_INTERVAL_MS; else process.env.CODEX_MIN_REQUEST_INTERVAL_MS = previousInterval;
  }
});
