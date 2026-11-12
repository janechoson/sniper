import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Candidate, Market, Mode } from "./domain.js";
import type { MarketHistory } from "./market-history.js";
import type { ReasoningRuntime } from "./codex-runtime.js";
import {
  AI_GUARD_PROMPT_VERSION,
  aiGuardResponseSchema,
  type AIGuardResponse,
} from "./codex-ai-guard-contract.js";
import {
  ChartKnowledgeRepository,
  type TradingKnowledge,
} from "./chart-knowledge.js";

export type AIGuardReasonCode =
  | "NO_KNOWLEDGE"
  | "NO_MATCH"
  | "KNOWN_SAFE_MATCH"
  | "KNOWN_DANGEROUS_MATCH"
  | "CONFLICTING_EVIDENCE"
  | "INSUFFICIENT_MARKET_EVIDENCE"
  | "AI_ERROR";
type GuardOutput = Omit<AIGuardResponse, "action"> & {
  action: AIGuardResponse["action"] | "ERROR";
  reasonCode: AIGuardReasonCode;
};
export type AIGuardDecision = GuardOutput & {
  id: string;
  mint: string;
  mode: Mode;
  attemptId: string;
  at: number;
  expiresAt: number;
  inferenceDeadlineAt: number;
  evaluatedAt: number;
  decisionExpiresAt: number;
  marketEvidenceCutoffAt: number;
  model: string | null;
  promptVersion: string;
  knowledgeRevision: number;
  inputHash: string;
  outputHash: string | null;
  durationMs: number;
  queueWaitMs: number;
  runtimeOutcome: string;
  modelProposal?: { action: AIGuardResponse["action"]; summary: string };
};
export interface GuardInput {
  candidate: Candidate;
  market: Market;
  history: MarketHistory;
  mode: Mode;
  attemptId: string;
  maxAgeMs: number;
  maxPriceMovePercent: number;
  context?: {
    security?: unknown;
    intelligence?: unknown;
    capitalFlow?: unknown;
    tokenExecution?: unknown;
  };
}
export interface GuardRevalidation {
  market: Market;
  authorityValid: boolean;
}

const sha = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const bounded = (value: unknown, chars: number) => {
  try {
    const encoded = JSON.stringify(value, (_key, item) =>
      typeof item === "string" ? item.slice(0, 1000) : item,
    );
    return encoded.length <= chars
      ? JSON.parse(encoded)
      : { truncated: true, preview: encoded.slice(0, chars) };
  } catch {
    return null;
  }
};

/** A VALIDATED status is eligible only when its holdout proves the dangerous-trade policy. */
function assertDangerousValidationProvenance(
  db: DatabaseSync,
  knowledge: TradingKnowledge,
) {
  if (!knowledge.validationId)
    throw Error("AI_GUARD_KNOWLEDGE_VALIDATION_PROVENANCE_MISSING");
  const row = db
    .prepare(
      "SELECT knowledge_version,payload FROM chart_knowledge_validations WHERE id=? AND knowledge_id=?",
    )
    .get(knowledge.validationId, knowledge.id) as
    | { knowledge_version: number; payload: string }
    | undefined;
  if (!row) throw Error("AI_GUARD_KNOWLEDGE_VALIDATION_PROVENANCE_MISSING");
  let report: any;
  try {
    report = JSON.parse(row.payload);
  } catch {
    throw Error("AI_GUARD_KNOWLEDGE_VALIDATION_PROVENANCE_INVALID");
  }
  if (
    report.validationId !== knowledge.validationId ||
    report.knowledgeId !== knowledge.id ||
    report.labelPolicy?.name !== "DANGEROUS_TRADE_V1" ||
    report.qualityGate?.passed !== true ||
    !Number.isSafeInteger(report.knowledgeVersion) ||
    Number(row.knowledge_version) !== report.knowledgeVersion ||
    knowledge.version !== report.knowledgeVersion + 1
  )
    throw Error("AI_GUARD_KNOWLEDGE_VALIDATION_PROVENANCE_INVALID");
}

export class CodexAIGuard {
  private activeCount = 0;
  private startedAt = 0;
  private activeControllers = new Set<AbortController>();
  private stopped = false;

  constructor(
    private db: DatabaseSync,
    private runtime: ReasoningRuntime,
  ) {}

  async evaluate(
    input: GuardInput,
    revalidate: () => Promise<GuardRevalidation>,
  ): Promise<AIGuardDecision> {
    const requestedAt = Date.now();
    const id = randomUUID();
    const knowledge = new ChartKnowledgeRepository(this.db);
    const knowledgeRevision = knowledge.revision();
    let inputPayload: unknown = null;
    let inputHash = sha(null);
    let outputHash: string | null = null;
    let response: GuardOutput | null = null;
    let modelProposal: AIGuardDecision["modelProposal"];
    let outcome = "AI_GUARD_RUNTIME_UNAVAILABLE";
    let durationMs = 0;
    let queueWaitMs = 0;
    let claimed = false;
    let abort: AbortController | undefined;
    let inference: Promise<unknown> | undefined;
    let timerId: ReturnType<typeof setTimeout> | undefined;
    let evaluatedAt = requestedAt;
    let decisionExpiresAt = requestedAt;

    const timeoutMs = Number(process.env.AI_GUARD_TIMEOUT_MS ?? 8000);
    const passTtlMs = Number(process.env.AI_GUARD_PASS_TTL_MS ?? 15000);
    const maxAgeMs = Math.max(1000, input.maxAgeMs);
    const cutoff = Date.now();
    const fail = (reason: string): GuardOutput => ({
      action: "ERROR",
      riskLevel: "HIGH",
      confidence: 0,
      summary: reason,
      matchedKnowledge: [],
      marketObservations: [],
      uncertaintyReasons: [reason],
      evidenceCutoffAt: cutoff,
      reasonCode: "AI_ERROR",
    });

    try {
      if (this.stopped) throw Error("AI_GUARD_SHUTDOWN");
      if (process.env.AI_GUARD_ENABLED === "false")
        throw Error("AI_GUARD_DISABLED");
      if (
        input.history.status !== "AVAILABLE" ||
        input.history.freshness !== "FRESH" ||
        input.history.fetchedAt > cutoff ||
        cutoff - input.history.fetchedAt > maxAgeMs ||
        input.market.price.state !== "KNOWN" ||
        !Number.isFinite(input.market.price.value) ||
        input.market.price.value <= 0 ||
        input.market.at > cutoff ||
        cutoff - input.market.at > maxAgeMs
      )
        throw Error("AI_GUARD_STALE_INPUT");

      const facts = input.history.candles
        .filter((candle) => candle.at + 60000 <= cutoff)
        .slice(-60)
        .map((candle, index) => ({
          evidenceId: `CANDLE-${index + 1}`,
          at: candle.at,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          volumeUsd: candle.volumeUsd,
        }));
      if (!facts.length) throw Error("AI_GUARD_NO_CLOSED_CANDLES");

      const validated = knowledge.validatedPreBuy();
      for (const rule of validated)
        assertDangerousValidationProvenance(this.db, rule);

      const contextEvidence = Object.entries(input.context ?? {}).flatMap(
        ([key, value]) => {
          if (!value || typeof value !== "object") return [];
          const item = value as Record<string, unknown>;
          const at = Number(item.at ?? item.fetchedAt);
          if (!Number.isSafeInteger(at) || at <= 0 || at > cutoff) return [];
          return [
            {
              evidenceId: `CONTEXT-${key.toUpperCase()}`,
              at,
              payload: bounded(value, 3000),
            },
          ];
        },
      );
      inputPayload = {
        candidate: {
          mint: input.candidate.mint,
          symbol: input.candidate.symbol?.slice(0, 32),
          name: input.candidate.name?.slice(0, 80),
          source: input.candidate.source?.slice(0, 80),
        },
        market: {
          evidenceId: "MARKET-1",
          at: input.market.at,
          priceUsd: input.market.price,
          liquidity: input.market.liquidity,
          marketCap: input.market.marketCap,
          volume: input.market.volume,
          buys: input.market.buys,
          sells: input.market.sells,
        },
        contextEvidence,
        history: {
          fetchedAt: input.history.fetchedAt,
          historyFrom: input.history.historyFrom,
          historyTo: input.history.historyTo,
          candles: facts,
        },
        validatedKnowledge: validated.map((rule) => ({
          ...rule,
          guardEligibility: {
            active: true,
            dangerousPattern: true,
            validationPolicy: "DANGEROUS_TRADE_V1",
          },
        })),
        knowledgeAvailable: validated.length > 0,
        knowledgeRevision,
        evidenceCutoffAt: cutoff,
        mode: input.mode,
      };
      inputHash = sha(inputPayload);

      if (validated.length === 0) {
        response = {
          action: "PASS",
          riskLevel: "LOW",
          confidence: 0,
          summary:
            "No applicable VALIDATED PRE_BUY knowledge exists; Codex was not called.",
          matchedKnowledge: [],
          marketObservations: [],
          uncertaintyReasons: [],
          evidenceCutoffAt: cutoff,
          reasonCode: "NO_KNOWLEDGE",
        };
        evaluatedAt = Date.now();
        outcome = "NO_KNOWLEDGE_NO_CODEX_CALL";
      } else {
        if (typeof this.runtime.analyzeGuard !== "function")
          throw Error("AI_GUARD_RUNTIME_UNAVAILABLE");
        const encoded = JSON.stringify(inputPayload);
        if (encoded.length > 48000) throw Error("AI_GUARD_INPUT_TOO_LARGE");

        this.activeCount++;
        claimed = true;
        this.startedAt = Date.now();
        abort = new AbortController();
        this.activeControllers.add(abort);
        inference = this.runtime.analyzeGuard(inputPayload, abort.signal, (wait) => {
          queueWaitMs = wait;
        });
        const timeout = new Promise<never>((_resolve, reject) => {
          timerId = setTimeout(() => {
            abort?.abort();
            reject(Error("AI_GUARD_TIMEOUT"));
          }, timeoutMs);
        });
        const raw = await Promise.race([inference, timeout]);
        const evaluated = aiGuardResponseSchema.parse(raw);
        evaluatedAt = Date.now();
        modelProposal = {
          action: evaluated.action,
          summary: evaluated.summary,
        };
        if (evaluated.evidenceCutoffAt !== cutoff)
          throw Error("AI_GUARD_INVALID_CUTOFF");

        const knowledgeByKey = new Set(
          validated.map((item) => `${item.id}:${item.version}`),
        );
        const seenMatches = new Set<string>();
        for (const match of evaluated.matchedKnowledge) {
          const key = `${match.knowledgeId}:${match.version}`;
          if (!knowledgeByKey.has(key)) throw Error("AI_GUARD_UNKNOWN_KNOWLEDGE");
          if (seenMatches.has(key)) throw Error("AI_GUARD_DUPLICATE_KNOWLEDGE_MATCH");
          seenMatches.add(key);
        }
        const available = new Set([
          "MARKET-1",
          ...facts.map((item) => item.evidenceId),
          ...contextEvidence.map((item) => item.evidenceId),
        ]);
        const evidenceIds = [
          ...evaluated.marketObservations.map((item) => item.evidenceId),
          ...evaluated.matchedKnowledge.flatMap((match) =>
            [...match.matchingEvidence, ...match.contradictoryEvidence].map(
              (reference) => reference.evidenceId,
            ),
          ),
        ];
        if (evidenceIds.some((evidenceId) => !available.has(evidenceId)))
          throw Error("AI_GUARD_UNKNOWN_EVIDENCE");
        if (
          evaluated.matchedKnowledge.some(
            (match) =>
              !match.matchingEvidence.length &&
              !match.contradictoryEvidence.length,
          )
        )
          throw Error("AI_GUARD_KNOWLEDGE_MATCH_WITHOUT_EVIDENCE");

        const hasConflict =
          evaluated.matchedKnowledge.some(
            (match) => match.contradictoryEvidence.length > 0,
          ) ||
          evaluated.uncertaintyReasons.some((reason) =>
            /conflict|contradict/i.test(reason),
          );
        const hasApplicableMatch = evaluated.matchedKnowledge.length > 0;
        const hasSupportedMatch = evaluated.matchedKnowledge.some(
          (match) => match.matchingEvidence.length > 0,
        );
        let action: AIGuardResponse["action"];
        let reasonCode: AIGuardReasonCode;
        let summary: string;
        if (!hasApplicableMatch) {
          const unresolvedEvidence =
            evaluated.action === "UNCERTAIN" &&
            (!evaluated.marketObservations.length ||
              evaluated.uncertaintyReasons.some((reason) =>
                /insufficient|missing|ambiguous|unavailable|unclear|inconclusive|conflict|contradict/i.test(
                  reason,
                ),
              ));
          if (unresolvedEvidence) {
            action = "UNCERTAIN";
            reasonCode = "INSUFFICIENT_MARKET_EVIDENCE";
            summary = "Market evidence is genuinely insufficient for a reliable comparison.";
          } else {
            // A model's unsupported BLOCK or unfamiliarity is not Knowledge Guard authority.
            action = "PASS";
            reasonCode = "NO_MATCH";
            summary =
              "No validated experience pattern matched; independent market-risk speculation cannot block here.";
          }
        } else if (hasConflict) {
          action = "UNCERTAIN";
          reasonCode = "CONFLICTING_EVIDENCE";
          summary = "Cited evidence conflicts for a validated experience pattern.";
        } else if (evaluated.action === "BLOCK" && hasSupportedMatch) {
          action = "BLOCK";
          reasonCode = "KNOWN_DANGEROUS_MATCH";
          summary =
            "Validated dangerous pattern " +
            evaluated.matchedKnowledge
              .filter((match) => match.matchingEvidence.length > 0)
              .map((match) => `${match.knowledgeId} v${match.version}`)
              .join(", ") +
            " matched cited market evidence.";
        } else if (evaluated.action === "UNCERTAIN") {
          action = "UNCERTAIN";
          reasonCode = "INSUFFICIENT_MARKET_EVIDENCE";
          summary = "The validated pattern comparison remains genuinely ambiguous.";
        } else if (evaluated.action === "BLOCK") {
          throw Error("AI_GUARD_BLOCK_WITHOUT_SUPPORTED_DANGEROUS_MATCH");
        } else {
          action = "PASS";
          reasonCode = "KNOWN_SAFE_MATCH";
          summary =
            "A validated experience pattern was compared; cited evidence does not support a dangerous match.";
        }
        response = {
          ...evaluated,
          action,
          reasonCode,
          summary,
        };
      }

      const post = await revalidate();
      const activeKnowledge = knowledge.validatedPreBuy();
      for (const rule of activeKnowledge)
        assertDangerousValidationProvenance(this.db, rule);
      const activeKeys = new Set(
        activeKnowledge.map((item) => `${item.id}:${item.version}`),
      );
      if (
        knowledge.revision() !== knowledgeRevision ||
        (response?.matchedKnowledge ?? []).some(
          (match) => !activeKeys.has(`${match.knowledgeId}:${match.version}`),
        )
      )
        throw Error("AI_GUARD_KNOWLEDGE_REVISION_CHANGED");

      const currentAt = Date.now();
      const originalPrice = input.market.price.value;
      const currentPrice =
        post.market.price.state === "KNOWN" ? post.market.price.value : null;
      if (!post.authorityValid) throw Error("AI_GUARD_AUTHORITY_CHANGED");
      if (
        currentPrice === null ||
        !Number.isFinite(currentPrice) ||
        currentPrice <= 0 ||
        post.market.at > currentAt ||
        currentAt - post.market.at > maxAgeMs ||
        currentAt - input.history.fetchedAt > maxAgeMs
      )
        throw Error("AI_GUARD_STALE_AFTER_INFERENCE");
      if (
        Math.abs((currentPrice / originalPrice - 1) * 100) >
        input.maxPriceMovePercent
      )
        throw Error("AI_GUARD_MARKET_CHANGED");

      decisionExpiresAt = Math.min(
        evaluatedAt + passTtlMs,
        input.market.at + maxAgeMs,
        input.history.fetchedAt + maxAgeMs,
        post.market.at + maxAgeMs,
      );
      if (decisionExpiresAt <= currentAt)
        throw Error("AI_GUARD_PASS_EXPIRED_DURING_REVALIDATION");
      outputHash = sha(response);
      if (outcome !== "NO_KNOWLEDGE_NO_CODEX_CALL") outcome = "COMPLETED";
    } catch (error) {
      durationMs = Date.now() - requestedAt;
      outcome = abort?.signal.aborted
        ? this.stopped
          ? "AI_GUARD_CANCELLED"
          : "AI_GUARD_TIMEOUT"
        : error instanceof Error
          ? error.message.slice(0, 120)
          : "AI_GUARD_ERROR";
      response = fail(outcome);
      outputHash = sha(response);
    } finally {
      if (timerId) clearTimeout(timerId);
      if (claimed) {
        this.activeCount = Math.max(0, this.activeCount - 1);
        if (outcome === "AI_GUARD_TIMEOUT" && inference && abort)
          void inference.then(
            () => this.activeControllers.delete(abort!),
            () => this.activeControllers.delete(abort!),
          );
        else if (abort) this.activeControllers.delete(abort);
      }
    }

    durationMs = Date.now() - requestedAt;
    const successfulOutcomes = new Set([
      "COMPLETED",
      "NO_KNOWLEDGE_NO_CODEX_CALL",
    ]);
    const action =
      successfulOutcomes.has(outcome) && response ? response.action : "ERROR";
    const decision: AIGuardDecision = {
      ...(response ?? fail(outcome)),
      ...(modelProposal ? { modelProposal } : {}),
      id,
      mint: input.candidate.mint,
      mode: input.mode,
      attemptId: input.attemptId,
      at: requestedAt,
      expiresAt: decisionExpiresAt,
      inferenceDeadlineAt: requestedAt + timeoutMs,
      evaluatedAt,
      decisionExpiresAt,
      marketEvidenceCutoffAt: cutoff,
      model: this.runtime.status().model || null,
      promptVersion: AI_GUARD_PROMPT_VERSION,
      knowledgeRevision,
      inputHash,
      outputHash,
      durationMs,
      queueWaitMs,
      runtimeOutcome: outcome,
      action,
    };
    this.db
      .prepare(
        "INSERT INTO chart_ai_guard_decisions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        input.attemptId,
        input.candidate.mint,
        input.mode,
        requestedAt,
        action,
        durationMs,
        queueWaitMs,
        outcome,
        decision.model,
        AI_GUARD_PROMPT_VERSION,
        knowledgeRevision,
        inputHash,
        outputHash,
        JSON.stringify(decision),
      );
    return decision;
  }

  status() {
    const knowledge = new ChartKnowledgeRepository(this.db);
    const latest = this.db
      .prepare("SELECT payload FROM chart_ai_guard_decisions ORDER BY at DESC LIMIT 1")
      .get() as { payload: string } | undefined;
    const errors = Number(
      this.db
        .prepare("SELECT count(*) n FROM chart_ai_guard_decisions WHERE action='ERROR'")
        .get()!.n,
    );
    const timeouts = Number(
      this.db
        .prepare("SELECT count(*) n FROM chart_ai_guard_decisions WHERE runtime_outcome LIKE '%TIMEOUT%'")
        .get()!.n,
    );
    const durations = this.db
      .prepare("SELECT duration_ms FROM chart_ai_guard_decisions ORDER BY at DESC LIMIT 1000")
      .all()
      .map((row: any) => Number(row.duration_ms))
      .sort((a, b) => a - b);
    const percentile = (p: number) =>
      durations.length
        ? durations[Math.min(durations.length - 1, Math.ceil(durations.length * p) - 1)]!
        : null;
    const scheduler = this.runtime.status().scheduler as any;
    return {
      enabled: process.env.AI_GUARD_ENABLED !== "false",
      runtime: this.runtime.status(),
      active: this.activeCount > 0,
      activeCount: this.activeCount,
      queued: Number(scheduler?.queuedByPriority?.guard ?? 0),
      timeoutMs: Number(process.env.AI_GUARD_TIMEOUT_MS ?? 8000),
      passTtlMs: Number(process.env.AI_GUARD_PASS_TTL_MS ?? 15000),
      concurrency: 1,
      maxAttempts: 1,
      failPolicy: "BLOCK",
      coldStartPolicy: "NO_KNOWLEDGE_PASS_WITHOUT_CODEX",
      experienceOnly: true,
      latest: latest ? JSON.parse(latest.payload) : null,
      timeoutCount: timeouts,
      errorCount: errors,
      validatedKnowledgeCount: knowledge.validatedPreBuy().length,
      knowledgeRevision: knowledge.revision(),
      latencyMs: {
        sampleCount: durations.length,
        p50: percentile(0.5),
        p95: percentile(0.95),
        p99: percentile(0.99),
      },
    };
  }

  async stop() {
    this.stopped = true;
    for (const controller of this.activeControllers) controller.abort();
  }
}
