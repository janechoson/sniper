import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Candidate, Market, Mode } from "./domain.js";
import type { MarketHistory } from "./market-history.js";
import type { ReasoningRuntime } from "./codex-runtime.js";
import { AI_GUARD_PROMPT_VERSION, aiGuardResponseSchema, type AIGuardResponse } from "./codex-ai-guard-contract.js";
import { ChartKnowledgeRepository } from "./chart-knowledge.js";

type GuardOutput = Omit<AIGuardResponse, "action"> & { action: AIGuardResponse["action"] | "ERROR" };
export type AIGuardDecision = GuardOutput & {
  id: string; mint: string; mode: Mode; attemptId: string; at: number; expiresAt: number;
  model: string | null; promptVersion: string; knowledgeRevision: number;
  inputHash: string; outputHash: string | null; durationMs: number; queueWaitMs: number;
  runtimeOutcome: string;
};
export interface GuardInput {
  candidate: Candidate; market: Market; history: MarketHistory; mode: Mode; attemptId: string;
  maxAgeMs: number; maxPriceMovePercent: number;
  context?: { security?: unknown; intelligence?: unknown; capitalFlow?: unknown; tokenExecution?: unknown };
}
export interface GuardRevalidation { market: Market; authorityValid: boolean }
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const bounded = (value: unknown, chars: number) => {
  try { const encoded = JSON.stringify(value, (_key, item) => typeof item === "string" ? item.slice(0, 1000) : item); return encoded.length <= chars ? JSON.parse(encoded) : { truncated: true, preview: encoded.slice(0, chars) }; }
  catch { return null; }
};
export class CodexAIGuard {
  private active = false;
  private startedAt = 0;
  private activeController?: AbortController;
  private stopped = false;
  constructor(private db: DatabaseSync, private runtime: ReasoningRuntime) {}

  async evaluate(input: GuardInput, revalidate: () => Promise<GuardRevalidation>): Promise<AIGuardDecision> {
    const requestedAt = Date.now(), id = randomUUID(), knowledge = new ChartKnowledgeRepository(this.db), knowledgeRevision = knowledge.revision();
    let inputPayload: unknown = null, inputHash = sha(null), outputHash: string | null = null, response: GuardOutput | null = null;
    let outcome = "AI_GUARD_RUNTIME_UNAVAILABLE", durationMs = 0, queueWaitMs = 0, claimed = false, abort: AbortController | undefined, inference: Promise<unknown> | undefined, timerId: ReturnType<typeof setTimeout> | undefined;
    const timeoutMs = Number(process.env.AI_GUARD_TIMEOUT_MS ?? 8000), maxAgeMs = Math.max(1000, input.maxAgeMs);
    const cutoff = Date.now();
    const fail = (reason: string) => ({
      action: "ERROR" as const, riskLevel: "HIGH" as const, confidence: 0, summary: reason,
      matchedKnowledge: [], marketObservations: [], uncertaintyReasons: [reason], evidenceCutoffAt: cutoff,
    });
    try {
      if (process.env.AI_GUARD_ENABLED === "false") throw Error("AI_GUARD_DISABLED");
      if (this.stopped) throw Error("AI_GUARD_SHUTDOWN");
      if (this.active) throw Error("AI_GUARD_BUSY");
      this.active = true; claimed = true; this.startedAt = Date.now(); queueWaitMs = this.startedAt - requestedAt;
      if (typeof this.runtime.analyzeGuard !== "function") throw Error("AI_GUARD_RUNTIME_UNAVAILABLE");
      if (input.history.status !== "AVAILABLE" || input.history.freshness !== "FRESH" || input.history.fetchedAt > cutoff || cutoff - input.history.fetchedAt > maxAgeMs || input.market.price.state !== "KNOWN" || input.market.at > cutoff || cutoff - input.market.at > maxAgeMs)
        throw Error("AI_GUARD_STALE_INPUT");
      const facts = input.history.candles.filter((c) => c.at + 60000 <= cutoff).slice(-60).map((c, index) => ({ evidenceId: `CANDLE-${index + 1}`, at: c.at, open: c.open, high: c.high, low: c.low, close: c.close, volumeUsd: c.volumeUsd }));
      if (!facts.length) throw Error("AI_GUARD_NO_CLOSED_CANDLES");
      const validated = knowledge.validatedPreBuy();
      const contextEvidence = Object.entries(input.context ?? {}).flatMap(([key, value]) => {
        if (!value || typeof value !== "object") return [];
        const item = value as Record<string, unknown>, at = Number(item.at ?? item.fetchedAt);
        if (!Number.isSafeInteger(at) || at <= 0 || at > cutoff) return [];
        return [{ evidenceId: `CONTEXT-${key.toUpperCase()}`, at, payload: bounded(value, 3000) }];
      });
      inputPayload = {
        candidate: { mint: input.candidate.mint, symbol: input.candidate.symbol?.slice(0, 32), name: input.candidate.name?.slice(0, 80), source: input.candidate.source?.slice(0, 80) },
        market: { evidenceId: "MARKET-1", at: input.market.at, priceUsd: input.market.price, liquidity: input.market.liquidity, marketCap: input.market.marketCap, volume: input.market.volume, buys: input.market.buys, sells: input.market.sells },
        contextEvidence,
        history: { fetchedAt: input.history.fetchedAt, historyFrom: input.history.historyFrom, historyTo: input.history.historyTo, candles: facts },
        validatedKnowledge: validated,
        knowledgeAvailable: validated.length > 0,
        knowledgeRevision,
        evidenceCutoffAt: cutoff,
        mode: input.mode,
      };
      inputHash = sha(inputPayload);
      const encoded = JSON.stringify(inputPayload);
      if (encoded.length > 48000) throw Error("AI_GUARD_INPUT_TOO_LARGE");
      abort = new AbortController();
      this.activeController = abort;
      inference = this.runtime.analyzeGuard(inputPayload, abort.signal);
      const timeout = new Promise<never>((_resolve, reject) => { timerId = setTimeout(() => { abort?.abort(); reject(Error("AI_GUARD_TIMEOUT")); }, timeoutMs); });
      const raw = await Promise.race([inference, timeout]);
      response = aiGuardResponseSchema.parse(raw);
      if (response.evidenceCutoffAt !== cutoff) throw Error("AI_GUARD_INVALID_CUTOFF");
      const knowledgeByKey = new Set(validated.map((item) => `${item.id}:${item.version}`));
      for (const match of response.matchedKnowledge) if (!knowledgeByKey.has(`${match.knowledgeId}:${match.version}`)) throw Error("AI_GUARD_UNKNOWN_KNOWLEDGE");
      const available = new Set(["MARKET-1", ...facts.map((item) => item.evidenceId), ...contextEvidence.map((item) => item.evidenceId)]);
      const evidenceIds = [
        ...response.marketObservations.flatMap((item) => [item.evidenceId]),
        ...response.matchedKnowledge.flatMap((item) => [...item.matchingEvidence, ...item.contradictoryEvidence].map((ref) => ref.evidenceId)),
      ];
      if (evidenceIds.some((evidenceId) => !available.has(evidenceId))) throw Error("AI_GUARD_UNKNOWN_EVIDENCE");
      if (response.matchedKnowledge.some((match) => !match.matchingEvidence.length && !match.contradictoryEvidence.length)) throw Error("AI_GUARD_KNOWLEDGE_MATCH_WITHOUT_EVIDENCE");
      if (response.action !== "UNCERTAIN" && !response.marketObservations.length) throw Error("AI_GUARD_DECISION_WITHOUT_MARKET_EVIDENCE");
      if (!validated.length && response.action === "PASS") {
        const policy = process.env.AI_GUARD_COLD_START_POLICY ?? "UNCERTAIN";
        if (policy === "UNCERTAIN") response = { ...response, action: "UNCERTAIN", summary: `Cold start: no validated PRE_BUY knowledge exists. ${response.summary}`.slice(0, 1200), uncertaintyReasons: [...response.uncertaintyReasons, "No validated PRE_BUY knowledge exists; cold-start policy is UNCERTAIN"].slice(0, 20) };
        if (policy === "BLOCK") response = { ...response, action: "BLOCK", riskLevel: "HIGH", summary: `Cold start: no validated PRE_BUY knowledge exists. ${response.summary}`.slice(0, 1200), uncertaintyReasons: [...response.uncertaintyReasons, "No validated PRE_BUY knowledge exists; cold-start policy is BLOCK"].slice(0, 20) };
      }
      const post = await revalidate();
      const currentAt = Date.now(), originalPrice = input.market.price.value, currentPrice = post.market.price.state === "KNOWN" ? post.market.price.value : null;
      if (!post.authorityValid) throw Error("AI_GUARD_AUTHORITY_CHANGED");
      if (!currentPrice || post.market.at > currentAt || currentAt - post.market.at > maxAgeMs || currentAt - input.history.fetchedAt > maxAgeMs) throw Error("AI_GUARD_STALE_AFTER_INFERENCE");
      if (Math.abs(currentPrice / originalPrice - 1) * 100 > input.maxPriceMovePercent) throw Error("AI_GUARD_MARKET_CHANGED");
      outputHash = sha(response);
      outcome = "COMPLETED";
    } catch (error) {
      durationMs = Date.now() - requestedAt;
      outcome = abort?.signal.aborted ? (this.stopped ? "AI_GUARD_CANCELLED" : "AI_GUARD_TIMEOUT") : error instanceof Error ? error.message.slice(0, 120) : "AI_GUARD_ERROR";
      response = fail(outcome);
      outputHash = sha(response);
    } finally {
      if (timerId) clearTimeout(timerId);
      if (claimed) {
        if (outcome === "AI_GUARD_TIMEOUT" && inference) void inference.then(() => { this.active = false; }, () => { this.active = false; });
        else this.active = false;
        this.activeController = undefined;
      }
    }
    durationMs = Date.now() - requestedAt;
    const action = outcome === "COMPLETED" && response ? response.action : "ERROR";
    const decision: AIGuardDecision = {
      ...(response ?? fail(outcome)), id, mint: input.candidate.mint, mode: input.mode, attemptId: input.attemptId,
      at: requestedAt, expiresAt: requestedAt + timeoutMs, model: this.runtime.status().model || null,
      promptVersion: AI_GUARD_PROMPT_VERSION, knowledgeRevision, inputHash, outputHash, durationMs, queueWaitMs,
      runtimeOutcome: outcome,
    };
    this.db.prepare("INSERT INTO chart_ai_guard_decisions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, input.attemptId, input.candidate.mint, input.mode, requestedAt, action, durationMs, queueWaitMs, outcome, decision.model, AI_GUARD_PROMPT_VERSION, knowledgeRevision, inputHash, outputHash, JSON.stringify(decision));
    return decision;
  }

  status() {
    const knowledge = new ChartKnowledgeRepository(this.db), latest = this.db.prepare("SELECT payload FROM chart_ai_guard_decisions ORDER BY at DESC LIMIT 1").get() as {payload:string}|undefined;
    const errors = Number(this.db.prepare("SELECT count(*) n FROM chart_ai_guard_decisions WHERE action='ERROR'").get()!.n);
    const timeouts = Number(this.db.prepare("SELECT count(*) n FROM chart_ai_guard_decisions WHERE runtime_outcome LIKE '%TIMEOUT%'").get()!.n);
    const durations = this.db.prepare("SELECT duration_ms FROM chart_ai_guard_decisions ORDER BY at DESC LIMIT 1000").all().map((row: any) => Number(row.duration_ms)).sort((a, b) => a - b);
    const percentile = (p: number) => durations.length ? durations[Math.min(durations.length - 1, Math.ceil(durations.length * p) - 1)]! : null;
    return { enabled: process.env.AI_GUARD_ENABLED !== "false", runtime: this.runtime.status(), active: this.active, queued: 0, timeoutMs: Number(process.env.AI_GUARD_TIMEOUT_MS ?? 8000), concurrency: 1, maxAttempts: 1, failPolicy: "BLOCK", coldStartPolicy: process.env.AI_GUARD_COLD_START_POLICY ?? "UNCERTAIN", latest: latest ? JSON.parse(latest.payload) : null, timeoutCount: timeouts, errorCount: errors, validatedKnowledgeCount: knowledge.validatedPreBuy().length, knowledgeRevision: knowledge.revision(), latencyMs: { sampleCount: durations.length, p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) } };
  }
  async stop() { this.stopped = true; this.activeController?.abort(); }
}
