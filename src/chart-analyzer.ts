import { randomUUID } from "node:crypto";
import { chartId, type ChartStore } from "./chart-store.js";
import { reasoningSchema, type ReasoningRuntime } from "./codex-runtime.js";
import { CHART_POLICY, type LearningRule } from "./chart-features.js";
import { sqliteAtomic } from "./learning-database.js";
import { ChartKnowledgeRepository } from "./chart-knowledge.js";

export const CHART_ANALYSIS_VERSION = "chart-learning-v4";
const MAX_BATCH = 20;

/** Explicitly requested Codex work. No collector code calls this service. */
export class ChartAnalyzer {
  private queue: string[] = [];
  private active?: Promise<void>;

  constructor(
    private charts: ChartStore,
    private runtime: ReasoningRuntime,
  ) {
    charts.db
      .prepare(
        "UPDATE chart_analysis_jobs SET state='FAILED',completed_at=?,error='INTERRUPTED_MANUAL_REQUEST_RETRY_REQUIRED' WHERE state='RUNNING'",
      )
      .run(Date.now());
  }

  request(caseIds: string[], requestedBy = "LOCAL_OPERATOR") {
    if (!Array.isArray(caseIds) || caseIds.length < 1 || caseIds.length > MAX_BATCH)
      throw Error("ANALYSIS_BATCH_LIMIT");
    const ids = [...new Set(caseIds.map((id) => String(id)))];
    if (ids.some((id) => !id || id.length > 160)) throw Error("INVALID_CASE_ID");
    const created: string[] = [];
    const output = sqliteAtomic(this.charts.db, () => {
      const rows = new Map(
        this.charts.db
          .prepare(
            `SELECT c.position_id,c.status,s.status collection_status FROM chart_learning_cases c JOIN chart_case_collection s ON s.case_id=c.position_id WHERE c.position_id IN (${ids.map(() => "?").join(",")})`,
          )
          .all(...ids)
          .map((row: any) => [String(row.position_id), row]),
      );
      const result = [];
      for (const id of ids) {
        const row = rows.get(id) as any;
        if (!row) throw Error("LEARNING_CASE_NOT_FOUND");
        if (row.status !== "CLOSED" || row.collection_status !== "READY_FOR_ANALYSIS")
          throw Error("LEARNING_CASE_NOT_READY");
        const existing = this.charts.db
          .prepare(
            "SELECT id,state FROM chart_analysis_jobs WHERE case_id=? AND state IN ('PENDING','RUNNING') ORDER BY requested_at DESC LIMIT 1",
          )
          .get(id) as { id: string; state: string } | undefined;
        if (existing) {
          result.push({ id: existing.id, caseId: id, state: existing.state, deduplicated: true });
          if (existing.state === "PENDING") created.push(existing.id);
          continue;
        }
        const jobId = randomUUID(), at = Date.now();
        this.charts.db
          .prepare(
            "INSERT INTO chart_analysis_jobs(id,case_id,requested_by,requested_at,state,analysis_version) VALUES(?,?,?,?,'PENDING',?)",
          )
          .run(jobId, id, requestedBy, at, CHART_ANALYSIS_VERSION);
        created.push(jobId);
        result.push({ id: jobId, caseId: id, state: "PENDING", deduplicated: false });
      }
      return result;
    });
    if (created.length) this.explicitlyQueue(created);
    return { jobs: output, batchLimit: MAX_BATCH };
  }

  retry(jobId: string, requestedBy = "LOCAL_OPERATOR") {
    const prior = this.charts.db
      .prepare("SELECT case_id,state,retry_count FROM chart_analysis_jobs WHERE id=?")
      .get(jobId) as { case_id: string; state: string; retry_count: number } | undefined;
    if (!prior) throw Error("ANALYSIS_JOB_NOT_FOUND");
    if (!["FAILED", "PENDING"].includes(prior.state)) throw Error("ANALYSIS_JOB_NOT_RETRYABLE");
    this.charts.db.prepare("UPDATE chart_analysis_jobs SET state='CANCELLED',completed_at=?,error='SUPERSEDED_BY_EXPLICIT_RETRY' WHERE id=?")
      .run(Date.now(), jobId);
    const result = this.request([prior.case_id], requestedBy);
    const newJob = result.jobs[0]!;
    if (!newJob.deduplicated)
      this.charts.db.prepare("UPDATE chart_analysis_jobs SET retry_count=? WHERE id=?")
        .run(Number(prior.retry_count) + 1, newJob.id);
    return result;
  }

  private explicitlyQueue(ids: string[]) {
    this.queue.push(...ids);
    if (this.active) return;
    this.active = (async () => {
      while (this.queue.length) {
        const id = this.queue.shift()!;
        await this.executeOne(id);
      }
    })().finally(() => {
      this.active = undefined;
      if (this.queue.length) this.explicitlyQueue([]);
    });
  }

  private caseContext(caseId: string, now: number) {
    const learningCase = this.charts.db
      .prepare("SELECT * FROM chart_learning_cases WHERE position_id=? AND status='CLOSED'")
      .get(caseId);
    if (!learningCase) throw Error("LEARNING_CASE_NOT_READY");
    const evidence = this.charts.db
      .prepare(
        "SELECT e.id,e.mint,e.kind,e.at,e.available_at,e.payload,ce.phase casePhase,ce.available_at evidenceAvailableAt FROM chart_case_evidence ce JOIN chart_events e ON ce.evidence_type='EVENT' AND ce.evidence_id=e.id WHERE ce.case_id=? AND ce.available_at<=? AND e.available_at<=? ORDER BY e.at LIMIT 500",
      )
      .all(caseId, now, now)
      .map((row: any) => ({ ...JSON.parse(String(row.payload)), availableAt: Number(row.available_at), casePhase: String(row.casePhase), evidenceAvailableAt: Number(row.evidenceAvailableAt) }));
    const candles = this.charts.db
      .prepare(
        "SELECT c.payload FROM chart_case_evidence ce JOIN chart_candles c ON ce.evidence_type='CANDLE' AND ce.evidence_id=c.id WHERE ce.case_id=? AND ce.available_at<=? AND c.available_at<=? ORDER BY c.at LIMIT 1500",
      )
      .all(caseId, now, now)
      .map((row: any) => JSON.parse(String(row.payload)));
    const snapshots = this.charts.db
      .prepare("SELECT s.id,s.at,s.payload,ce.phase,ce.available_at FROM chart_case_evidence ce JOIN chart_snapshots s ON ce.evidence_type='SNAPSHOT' AND ce.evidence_id=s.id WHERE ce.case_id=? AND ce.available_at<=? ORDER BY s.at DESC LIMIT 120")
      .all(caseId, now)
      .map((row: any) => ({ id: String(row.id), at: Number(row.at), phase: String(row.phase), availableAt: Number(row.available_at), payload: JSON.parse(String(row.payload)) }))
      .reverse();
    const decisions = this.charts.db
      .prepare("SELECT decision_id,source,at,action,simulated,payload FROM chart_case_decisions WHERE position_id=? ORDER BY at DESC LIMIT 500")
      .all(caseId)
      .map((row: any) => ({ id: String(row.decision_id), source: String(row.source), at: Number(row.at), action: String(row.action), simulated: Boolean(row.simulated), payload: JSON.parse(String(row.payload)) }))
      .reverse();
    const replay = this.charts.db
      .prepare("SELECT payload FROM chart_replays WHERE position_id=?")
      .get(caseId) as { payload: string } | undefined;
    const followups = this.charts.db
      .prepare("SELECT horizon,state,collected_at,payload,error FROM chart_case_followups WHERE case_id=? ORDER BY horizon")
      .all(caseId);
    if (!replay) throw Error("LEARNING_CASE_REPLAY_UNAVAILABLE");
    const caseData = JSON.parse(String(learningCase.payload));
    const cohort = this.charts.db.prepare("SELECT c.position_id,c.mint,c.mode,c.account_id,c.realized_pnl_pct,c.payload,r.payload replay FROM chart_learning_cases c JOIN chart_replays r ON r.position_id=c.position_id WHERE c.status='CLOSED' AND c.position_id<>? AND c.mint<>? AND c.mode=? AND c.account_id=? ORDER BY c.updated_at DESC LIMIT 30")
      .all(caseId, (learningCase as any).mint, (learningCase as any).mode, (learningCase as any).account_id)
      .map((row: any) => {
        const payload = JSON.parse(String(row.payload)), replayData = JSON.parse(String(row.replay));
        const peerEvents = this.charts.db.prepare("SELECT e.kind,e.at,e.payload FROM chart_case_evidence ce JOIN chart_events e ON ce.evidence_type='EVENT' AND ce.evidence_id=e.id WHERE ce.case_id=? AND ce.available_at<=? ORDER BY e.at LIMIT 40")
          .all(String(row.position_id), now).map((event: any) => ({ kind: String(event.kind), at: Number(event.at), event: JSON.parse(String(event.payload)) }));
        return { caseId: String(row.position_id), mint: String(row.mint), mode: String(row.mode), simulated: payload.simulated === true, realizedPnlPct: row.realized_pnl_pct === null ? null : Number(row.realized_pnl_pct), mfePct: replayData.maximumFavorableExcursion ?? null, maePct: replayData.maximumAdverseExcursion ?? null, eventSamples: peerEvents };
      });
    return {
      case: { ...caseData, buyConfirmedAt: Number((learningCase as any).buy_confirmed_at), sellConfirmedAt: caseData.sellConfirmedAt ?? null },
      replay: JSON.parse(replay.payload),
      candles,
      snapshots,
      decisions,
      events: evidence,
      followups,
      cohort,
      cohortCaseIds: cohort.map((item: any) => item.caseId),
      policy: CHART_POLICY,
      dataAvailabilityCutoff: now,
    };
  }

  private async executeOne(id: string) {
    const job = this.charts.db
      .prepare("SELECT * FROM chart_analysis_jobs WHERE id=? AND state='PENDING'")
      .get(id) as { case_id: string; analysis_version: string } | undefined;
    if (!job) return;
    const started = Date.now();
    this.charts.db.prepare("UPDATE chart_analysis_jobs SET state='RUNNING',started_at=?,runtime_model=? WHERE id=? AND state='PENDING'")
      .run(started, this.runtime.status().model ?? null, id);
    try {
      const context = this.caseContext(job.case_id, started);
      const result = reasoningSchema.parse(await this.runtime.analyze({
        analysisDepth: "DEEP",
        task: "COMPLETED_TRADE_CASE_ANALYSIS",
        payload: context,
        events: context.events,
        rules: this.charts.rules().filter((rule) => rule.status === "VALIDATED"),
        policy: CHART_POLICY,
      }));
      if (result.action !== "REVIEW") throw Error("CODEX_REVIEW_ACTION_REQUIRED");
      const allowed = new Set(context.events.map((event: any) => event.id));
      if ([...result.supportingEventIds, ...result.contradictoryEventIds].some((eventId) => !allowed.has(eventId)))
        throw Error("CODEX_CASE_EVIDENCE_NOT_LINKED");
      const analyzedAt = Date.now(), analysisId = randomUUID();
      const saved = { ...result, analysisVersion: job.analysis_version, runtime: this.runtime.status(), caseId: job.case_id, analyzedAt };
      sqliteAtomic(this.charts.db, () => {
        this.charts.db.prepare("INSERT INTO chart_case_analyses VALUES(?,?,?,?,?,?,?)")
          .run(analysisId, job.case_id, id, analyzedAt, job.analysis_version, this.runtime.status().model ?? null, JSON.stringify(saved));
        this.charts.db.prepare("UPDATE chart_analysis_jobs SET state='COMPLETED',completed_at=?,result=?,error=NULL WHERE id=?")
          .run(analyzedAt, JSON.stringify(saved), id);
        const supporting = context.events.filter((event: any) => result.supportingEventIds.includes(event.id));
        const buyEvidenceOnly = supporting.length > 0 && supporting.every((event: any) => event.casePhase === "PRE_BUY_CONTEXT" && event.evidenceAvailableAt <= context.case.buyConfirmedAt);
        const sellEvidenceOnly = supporting.length > 0 && supporting.every((event: any) => event.casePhase === "POST_BUY_OBSERVATION" && event.evidenceAvailableAt <= (context.case.sellConfirmedAt ?? -Infinity));
        if (result.hypothesis && result.supportingEventIds.length && result.hypothesis.behaviors.length && ((result.hypothesis.action === "BLOCK" && buyEvidenceOnly) || (result.hypothesis.action === "SELL" && sellEvidenceOnly))) {
          const hypothesis = result.hypothesis;
          const rule: LearningRule & { category?: string; sourceCaseId?: string } = {
            id: "LR-" + chartId(job.case_id, id, hypothesis.name).slice(0, 16),
            version: 1,
            at: analyzedAt,
            createdAt: analyzedAt,
            name: hypothesis.name,
            description: hypothesis.description,
            status: "DRAFT",
            behaviors: hypothesis.behaviors,
            window: Number(hypothesis.window),
            action: hypothesis.action,
            category: hypothesis.action === "BLOCK" ? "BUY_GUARD" : "SELL_GUARD",
            sourceCaseId: job.case_id,
            invalidation: hypothesis.invalidation,
            supportingEventIds: result.supportingEventIds,
            contradictoryEventIds: result.contradictoryEventIds,
          };
          this.charts.saveRule(rule);
        }
        if (result.knowledgeHypothesis) {
          const knowledge = new ChartKnowledgeRepository(this.charts.db);
          const allowedCases = new Set([job.case_id, ...context.cohortCaseIds]);
          const supportCases = result.knowledgeHypothesis.supportingCaseIds;
          const contradictoryCases = result.knowledgeHypothesis.contradictoryCaseIds;
          if ([...supportCases, ...contradictoryCases].some((caseId) => !allowedCases.has(caseId)) || !supportCases.length || supportCases.some((caseId) => contradictoryCases.includes(caseId))) throw Error("CODEX_KNOWLEDGE_CASE_REFERENCE_INVALID");
          knowledge.createDraft({
            id: "KN-" + chartId(job.case_id, id, result.knowledgeHypothesis.title).slice(0, 20),
            title: result.knowledgeHypothesis.title,
            category: result.knowledgeHypothesis.category,
            applicableStage: result.knowledgeHypothesis.applicableStage,
            description: result.knowledgeHypothesis.description,
            marketContext: result.knowledgeHypothesis.marketContext,
            observedBehaviors: result.knowledgeHypothesis.observedBehaviors,
            variations: result.knowledgeHypothesis.variations,
            supportingIndicators: result.knowledgeHypothesis.supportingIndicators,
            counterexamples: result.knowledgeHypothesis.counterexamples,
            invalidationConditions: result.knowledgeHypothesis.invalidationConditions,
            supportingCaseIds: supportCases,
            contradictoryCaseIds: contradictoryCases,
          });
        }
        this.updateCollectionReadiness(job.case_id, analyzedAt);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "CODEX_ANALYSIS_FAILED";
      this.charts.db.prepare("UPDATE chart_analysis_jobs SET state='FAILED',completed_at=?,error=? WHERE id=?")
        .run(Date.now(), message, id);
    }
  }

  private updateCollectionReadiness(caseId: string, now: number) {
    const status = this.charts.db.prepare("SELECT status FROM chart_case_collection WHERE case_id=?").get(caseId) as {status:string}|undefined;
    if (status?.status === "READY_FOR_ANALYSIS" || status?.status === "INCOMPLETE")
      this.charts.db.prepare("UPDATE chart_case_collection SET updated_at=? WHERE case_id=?").run(now, caseId);
  }

  jobs(limit = 100) {
    return this.charts.db.prepare("SELECT * FROM chart_analysis_jobs ORDER BY requested_at DESC LIMIT ?").all(Math.max(1, Math.min(MAX_BATCH * 5, limit)));
  }

  readyCaseIds(limit = MAX_BATCH) {
    const safeLimit = Math.max(1, Math.min(MAX_BATCH, limit));
    return this.charts.db.prepare(
      "SELECT c.position_id FROM chart_learning_cases c JOIN chart_case_collection s ON s.case_id=c.position_id WHERE c.status='CLOSED' AND s.status='READY_FOR_ANALYSIS' AND NOT EXISTS (SELECT 1 FROM chart_analysis_jobs j WHERE j.case_id=c.position_id AND j.state IN ('PENDING','RUNNING','COMPLETED')) ORDER BY c.updated_at LIMIT ?",
    ).all(safeLimit).map((row: any) => String(row.position_id));
  }

  async stop() {
    await this.active;
  }

  job(id: string) {
    return this.charts.db.prepare("SELECT * FROM chart_analysis_jobs WHERE id=?").get(id) ?? null;
  }

  status() {
    const counts = Object.fromEntries(
      this.charts.db.prepare("SELECT state,count(*) n FROM chart_analysis_jobs GROUP BY state").all()
        .map((row: any) => [String(row.state).toLowerCase(), Number(row.n)]),
    );
    return { mode: "MANUAL", active: Boolean(this.active), jobs: counts };
  }
}
