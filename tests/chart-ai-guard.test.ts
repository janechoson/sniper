import assert from "node:assert/strict";
import { test } from "node:test";
import { ChartKnowledgeRepository } from "../src/chart-knowledge.js";
import { CodexAIGuard } from "../src/codex-ai-guard.js";
import { CodexRuntime, type ReasoningRuntime } from "../src/codex-runtime.js";
import { normalizeMarket } from "../src/gmgn.js";
import { parseMarketHistory } from "../src/market-history.js";
import { Store } from "../src/store.js";
import { candidate, info } from "./fixtures.js";
import { candles } from "./one-shot-fixtures.js";

const baseKnowledge = {
  id: "KN-DISTRIBUTION", title: "Distribution after rapid pump", category: "DISTRIBUTION" as const,
  applicableStage: "PRE_BUY" as const, description: "Rapid appreciation followed by weakening demand and repeated failed highs.",
  marketContext: "Meme token short interval chart", observedBehaviors: ["Weakening buying pressure"],
  variations: ["Timing and candle count may vary", "Temporary rebounds can occur"],
  supportingIndicators: ["Relative volume loss"], counterexamples: ["Sustained demand with new highs"],
  invalidationConditions: ["Fresh breakout with sustained volume"], supportingCaseIds: ["case-train-1"], contradictoryCaseIds: [],
};
function installValidated(db: Store["db"], id = baseKnowledge.id, stage: "PRE_BUY" | "POST_BUY" = "PRE_BUY") {
  const repo = new ChartKnowledgeRepository(db), draft = repo.createDraft({ ...baseKnowledge, id, applicableStage: stage });
  const validated = { ...draft, version: 2, validationStatus: "VALIDATED" as const, validationId: "validation-1", validationMetrics: { holdoutCases: 3 }, applicableStage: stage };
  db.prepare("INSERT INTO chart_knowledge_versions VALUES(?,?,?,?,?,?,?,?)").run(id, 2, validated.category, stage, "VALIDATED", draft.createdAt, draft.updatedAt + 1, JSON.stringify(validated));
  return validated;
}
function guardInput() {
  const c = candidate();
  return { candidate: c, market: normalizeMarket(info()), history: parseMarketHistory(candles(60), c), mode: "demo" as const, attemptId: "attempt-guard-test", maxAgeMs: 45000, maxPriceMovePercent: 10 };
}
function fakeRuntime(answer: (payload: any) => unknown): ReasoningRuntime {
  return { status: () => ({ state: "READY", model: "MOCK_ONLY", promptVersion: "mock" }), analyze: async () => { throw Error("historical analyzer must not run"); }, analyzeGuard: async (payload) => answer(payload) };
}
const response = (payload: any, patch: Record<string, unknown> = {}) => ({
  action: "PASS", riskLevel: "LOW", confidence: 0.75, summary: "No strong validated pattern match.",
  matchedKnowledge: [], marketObservations: [{ evidenceId: payload.history.candles[0].evidenceId, explanation: "Closed candle facts are available before the cutoff." }],
  uncertaintyReasons: [payload.knowledgeAvailable ? "Context is mixed." : "No validated PRE_BUY knowledge exists."],
  evidenceCutoffAt: payload.evidenceCutoffAt, ...patch,
});
async function evaluate(g: CodexAIGuard, input = guardInput(), revalidate = async () => ({ market: input.market, authorityValid: true })) { return g.evaluate(input, revalidate); }

test("AI Guard reasons over semantic VALIDATED PRE_BUY knowledge and persists an audit without creating Learning data", async () => {
  const store = new Store(":memory:"), valid = installValidated(store.db);
  let sent: any;
  const runtime = fakeRuntime((payload) => { sent = payload; return response(payload, { matchedKnowledge: [{ knowledgeId: valid.id, version: 2, similarity: 0.83, matchingEvidence: [{ evidenceId: "CANDLE-1", explanation: "The relative demand trend is weakening." }], differences: ["The current pattern developed over fewer candles."], contradictoryEvidence: [] }] }); });
  const g = new CodexAIGuard(store.learningDb, runtime);
  try {
    const input = { ...guardInput(), context: { intelligence: { at: Date.now(), note: "timestamped fixture fact" }, security: { note: "untimestamped value must not reach Codex" } } };
    const result = await evaluate(g, input);
    assert.equal(result.action, "PASS");
    assert.equal(result.reasonCode, "KNOWN_SAFE_MATCH");
    assert.equal(sent.validatedKnowledge.length, 1);
    assert.deepEqual(sent.validatedKnowledge[0].variations, baseKnowledge.variations);
    assert.deepEqual(sent.validatedKnowledge[0].counterexamples, baseKnowledge.counterexamples);
    assert.deepEqual(sent.contextEvidence.map((e: any) => e.evidenceId), ["CONTEXT-INTELLIGENCE"]);
    assert.equal("context" in sent, false);
    assert.equal(result.matchedKnowledge[0]!.version, 2);
    assert.equal(store.db.prepare("SELECT count(*) n FROM chart_learning_cases").get()!.n, 0);
    assert.equal(store.db.prepare("SELECT count(*) n FROM chart_candles").get()!.n, 0);
    assert.equal(store.db.prepare("SELECT count(*) n FROM chart_ai_guard_decisions").get()!.n, 1);
  } finally { store.close(); }
});

test("AI Guard still invokes Codex at cold start and excludes DRAFT and POST_BUY knowledge", async () => {
  const store = new Store(":memory:"), repo = new ChartKnowledgeRepository(store.db);
  repo.createDraft({ ...baseKnowledge, id: "draft-only" });
  installValidated(store.db, "post-buy", "POST_BUY");
  let calls = 0, knowledgeCount = -1;
  const g = new CodexAIGuard(store.learningDb, fakeRuntime((payload) => { calls++; knowledgeCount = payload.validatedKnowledge.length; return response(payload); }));
  try {
    const decision = await evaluate(g);
    assert.equal(decision.action, "PASS");
    assert.equal(decision.reasonCode, "NO_KNOWLEDGE");
    assert.equal(calls, 1);
    assert.equal(knowledgeCount, 0);
  } finally { store.close(); }
});
test("empty knowledge permits successful AI PASS and records NO_KNOWLEDGE", async () => {
  const store = new Store(":memory:");
  const g = new CodexAIGuard(store.learningDb, fakeRuntime((payload) => response(payload)));
  try { const result = await evaluate(g); assert.equal(result.action, "PASS"); assert.equal(result.reasonCode, "NO_KNOWLEDGE"); }
  finally { await g.stop(); store.close(); }
});
test("validated knowledge with no relevant match permits successful PASS as NO_MATCH", async () => {
  const store = new Store(":memory:"); installValidated(store.db);
  const g = new CodexAIGuard(store.learningDb, fakeRuntime((payload) => response(payload)));
  try { const result = await evaluate(g); assert.equal(result.action, "PASS"); assert.equal(result.reasonCode, "NO_MATCH"); }
  finally { store.close(); }
});
test("evidence-supported dangerous match blocks and conflicting evidence remains uncertain", async () => {
  const store = new Store(":memory:"), valid = installValidated(store.db);
  const match = { knowledgeId: valid.id, version: 2, similarity: 0.9, matchingEvidence: [{ evidenceId: "CANDLE-1", explanation: "Observed distribution pattern." }], differences: [], contradictoryEvidence: [] };
  const dangerous = new CodexAIGuard(store.learningDb, fakeRuntime((payload) => response(payload, { action: "BLOCK", riskLevel: "HIGH", matchedKnowledge: [match] })));
  try { const result = await evaluate(dangerous); assert.equal(result.action, "BLOCK"); assert.equal(result.reasonCode, "KNOWN_DANGEROUS_MATCH"); }
  finally { await dangerous.stop(); }
  const conflicting = new CodexAIGuard(store.learningDb, fakeRuntime((payload) => response(payload, { action: "UNCERTAIN", matchedKnowledge: [{ ...match, contradictoryEvidence: [{ evidenceId: "CANDLE-2", explanation: "Counterevidence conflicts with the match." }] }], uncertaintyReasons: ["Conflicting evidence"] })));
  try { const result = await evaluate(conflicting); assert.equal(result.action, "UNCERTAIN"); assert.equal(result.reasonCode, "CONFLICTING_EVIDENCE"); }
  finally { await conflicting.stop(); store.close(); }
});
test("PASS TTL begins after completed evaluation and is independently bounded by evidence freshness", async()=>{
  const previousTimeout=process.env.AI_GUARD_TIMEOUT_MS,previousTtl=process.env.AI_GUARD_PASS_TTL_MS;
  process.env.AI_GUARD_TIMEOUT_MS="1000";process.env.AI_GUARD_PASS_TTL_MS="20000";
  const store=new Store(":memory:");let start=0;
  const g=new CodexAIGuard(store.learningDb,fakeRuntime(async(payload)=>{await new Promise((resolve)=>setTimeout(resolve,35));return response(payload);}));
  try{
    const input=guardInput();input.maxAgeMs=300000;start=Date.now();
    const result=await evaluate(g,input);
    assert.equal(result.action,"PASS");assert.ok(result.evaluatedAt>=start+25);
    assert.equal(result.inferenceDeadlineAt,result.at+1000);
    assert.ok(result.decisionExpiresAt>result.inferenceDeadlineAt);
    assert.ok(result.decisionExpiresAt<=result.evaluatedAt+20000);
    assert.ok(result.decisionExpiresAt<=input.history.fetchedAt+input.maxAgeMs);
    assert.equal(result.expiresAt,result.decisionExpiresAt);
    assert.ok(result.marketEvidenceCutoffAt<=result.evaluatedAt);
  }finally{store.close();if(previousTimeout===undefined)delete process.env.AI_GUARD_TIMEOUT_MS;else process.env.AI_GUARD_TIMEOUT_MS=previousTimeout;if(previousTtl===undefined)delete process.env.AI_GUARD_PASS_TTL_MS;else process.env.AI_GUARD_PASS_TTL_MS=previousTtl;}
});
test("PASS that expires while final market and authority revalidation is pending fails closed", async()=>{
  const previousTtl=process.env.AI_GUARD_PASS_TTL_MS;process.env.AI_GUARD_PASS_TTL_MS="10";
  const store=new Store(":memory:"),g=new CodexAIGuard(store.learningDb,fakeRuntime((payload)=>response(payload)));
  try{
    const input=guardInput();input.maxAgeMs=300000;
    const result=await evaluate(g,input,async()=>{await new Promise((resolve)=>setTimeout(resolve,30));return{market:input.market,authorityValid:true};});
    assert.equal(result.action,"ERROR");assert.equal(result.reasonCode,"AI_ERROR");assert.equal(result.runtimeOutcome,"AI_GUARD_PASS_EXPIRED_DURING_REVALIDATION");
  }finally{store.close();if(previousTtl===undefined)delete process.env.AI_GUARD_PASS_TTL_MS;else process.env.AI_GUARD_PASS_TTL_MS=previousTtl;}
});
test("legacy sample-count promotion endpoint is disabled without replay report", () => {
  const store = new Store(":memory:"), repo = new ChartKnowledgeRepository(store.db);
  try {
    const draft = repo.createDraft({ ...baseKnowledge, supportingCaseIds: [] });
    assert.throws(() => repo.validateDraft(draft.id, draft.version, ["one", "two", "three"], true), /AUTOMATIC_VALIDATION_ONLY/);
    assert.equal(repo.validatedPreBuy().length, 0);
  } finally { store.close(); }
});

test("AI Guard rejects unknown knowledge/evidence references and non-finite or malformed outputs", async () => {
  for (const patch of [
    { matchedKnowledge: [{ knowledgeId: "forged", version: 1, similarity: 0.5, matchingEvidence: [], differences: [], contradictoryEvidence: [] }] },
    { marketObservations: [{ evidenceId: "FUTURE-CANDLE", explanation: "Invented" }] },
    { confidence: Number.NaN },
    { action: "BUY" },
  ]) {
    const store = new Store(":memory:"), g = new CodexAIGuard(store.learningDb, fakeRuntime((payload) => response(payload, patch)));
    try { assert.equal((await evaluate(g)).action, "ERROR"); }
    finally { store.close(); }
  }
});

test("AI Guard fails closed for timeout, unavailable runtime, stale data, changed market, and revoked authority", async () => {
  const originalTimeout = process.env.AI_GUARD_TIMEOUT_MS;
  process.env.AI_GUARD_TIMEOUT_MS = "20";
  try {
    const store = new Store(":memory:"), hanging: ReasoningRuntime = { ...fakeRuntime(() => ({})), analyzeGuard: (_payload, signal) => new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(Error("aborted")), { once: true })) }, g = new CodexAIGuard(store.learningDb, hanging);
    try { const result = await evaluate(g); assert.equal(result.action, "ERROR"); assert.equal(result.reasonCode, "AI_ERROR"); assert.equal(result.runtimeOutcome, "AI_GUARD_TIMEOUT"); }
    finally { store.close(); }
  } finally { if (originalTimeout === undefined) delete process.env.AI_GUARD_TIMEOUT_MS; else process.env.AI_GUARD_TIMEOUT_MS = originalTimeout; }
  {
    const store = new Store(":memory:"), g = new CodexAIGuard(store.learningDb, { status: () => ({ state: "MISSING_OPENAI_API_KEY", model: "", promptVersion: "" }), analyze: async () => { throw Error("unused"); } });
    try { const result = await evaluate(g); assert.equal(result.action, "ERROR"); assert.equal(result.reasonCode, "AI_ERROR"); }
    finally { store.close(); }
  }
  for (const revalidate of [
    async () => ({ market: { ...guardInput().market, price: { state: "KNOWN" as const, value: 2 }, at: Date.now() }, authorityValid: true }),
    async () => ({ market: guardInput().market, authorityValid: false }),
  ]) {
    const store = new Store(":memory:"), g = new CodexAIGuard(store.learningDb, fakeRuntime((payload) => response(payload)));
    try { assert.equal((await evaluate(g, guardInput(), revalidate)).action, "ERROR"); }
    finally { store.close(); }
  }
  {
    const store=new Store(":memory:"),g=new CodexAIGuard(store.learningDb,fakeRuntime((payload)=>response(payload,{action:"UNCERTAIN",marketObservations:[],uncertaintyReasons:["Insufficient market evidence to decide."]})));
    try{const result=await evaluate(g);assert.equal(result.action,"UNCERTAIN");assert.equal(result.reasonCode,"INSUFFICIENT_MARKET_EVIDENCE");}
    finally{store.close();}
  }
  {
    const store = new Store(":memory:"), g = new CodexAIGuard(store.learningDb, fakeRuntime((payload) => response(payload)));
    const input = { ...guardInput(), history: { ...guardInput().history, fetchedAt: Date.now() - 120000 } };
    try { assert.equal((await evaluate(g, input)).runtimeOutcome, "AI_GUARD_STALE_INPUT"); }
    finally { store.close(); }
  }
});

test("CodexRuntime sends strict guard schema and semantic instructions through its real transport method", async () => {
  const payload = { evidenceCutoffAt: Date.now(), history: { candles: [{ evidenceId: "CANDLE-1" }] } };
  let request = "";
  const runtime = new CodexRuntime("fixture-key", "fixture-model", async (_url, init) => {
    request = String(init?.body ?? "");
    return new Response(JSON.stringify({ status: "completed", output: [{ content: [{ type: "output_text", text: JSON.stringify(response(payload)) }] }], usage: { total_tokens: 10 } }), { status: 200 });
  });
  const result = await runtime.analyzeGuard(payload);
  const body = JSON.parse(request);
  assert.equal(result.action, "PASS");
  assert.match(body.instructions, /semantically/);
  assert.match(body.instructions, /not a whitelist/);
  assert.match(body.instructions, /novel chart is not inherently dangerous/);
  assert.match(body.instructions, /never fabricate a match/);
  assert.ok(body.text.format.schema);
  assert.equal("tools" in body, false);
});
