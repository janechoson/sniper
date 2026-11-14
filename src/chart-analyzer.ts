import { randomUUID } from "node:crypto";
import { chartId, type ChartStore } from "./chart-store.js";
import { reasoningSchema, type ReasoningRuntime } from "./codex-runtime.js";
import { CHART_POLICY, type LearningRule } from "./chart-features.js";
import { sqliteAtomic } from "./learning-database.js";
import { ChartKnowledgeRepository } from "./chart-knowledge.js";
import { env } from "./config.js";
import { ANALYSIS_MAX_ENVELOPE_BYTES, analysisPayloadMetrics, boundedAnalysisInput, buildAnalysisPlan, inputEvidenceIds } from "./chart-analysis-plan.js";

export const CHART_ANALYSIS_VERSION = "chart-learning-v4";
const MAX_BATCH = 20;

/** Explicitly requested Codex work. No collector code calls this service. */
export class ChartAnalyzer {
  private queue: string[] = [];
  private active?: Promise<void>;
  private autoActive?: Promise<void>;
  private stopped = false;

  constructor(
    private charts: ChartStore,
    private runtime: ReasoningRuntime,
  ) {
    charts.db
      .prepare(
        "UPDATE chart_analysis_jobs SET state='FAILED',completed_at=?,error='INTERRUPTED_MANUAL_REQUEST_RETRY_REQUIRED' WHERE state='RUNNING'",
      )
      .run(Date.now());
    charts.db.prepare("UPDATE chart_auto_learning_jobs SET state=CASE WHEN attempt_count+1>=3 THEN 'DEAD_LETTER' ELSE 'RETRY_WAIT' END,attempt_count=attempt_count+1,next_attempt_at=?,last_error='INTERRUPTED_RESTART_RECOVERY' WHERE state='RUNNING'").run(Date.now()+30000);
  }

  pump(now=Date.now()) {
    if(!env.AUTO_CHART_LEARNING_ENABLED||this.stopped||this.autoActive)return;
    this.scheduleEligible(now);
    const row=this.charts.db.prepare("SELECT id FROM chart_auto_learning_jobs WHERE state IN ('PENDING','RETRY_WAIT') AND next_attempt_at<=? AND eligible_at+?<=? ORDER BY eligible_at LIMIT 1").get(now,env.AUTO_CHART_LEARNING_DELAY_MS,now) as {id:string}|undefined;
    if(!row)return;
    this.autoActive=this.runAutomatic(row.id).finally(()=>{this.autoActive=undefined;});
  }

  private scheduleEligible(now:number) {
    const cases=this.charts.db.prepare("SELECT c.position_id,c.status,s.status collection_status,s.updated_at,s.data_quality FROM chart_learning_cases c JOIN chart_case_collection s ON s.case_id=c.position_id WHERE c.status='CLOSED' AND s.status IN ('READY_FOR_ANALYSIS','INCOMPLETE') ORDER BY s.updated_at LIMIT 100").all() as any[];
    for(const row of cases){
      if(row.collection_status==="INCOMPLETE"&&!env.AUTO_CHART_LEARNING_ALLOW_INCOMPLETE)continue;
      const caseId=String(row.position_id), count=Number(this.charts.db.prepare("SELECT count(*) n FROM chart_case_evidence WHERE case_id=? AND evidence_type='CANDLE'").get(caseId)!.n);
      if(count<env.AUTO_CHART_LEARNING_MIN_CANDLES)continue;
      const exists=this.charts.db.prepare("SELECT 1 FROM chart_auto_learning_jobs WHERE case_id=? AND analysis_version=?").get(caseId,CHART_ANALYSIS_VERSION);
      if(exists)continue;
      const eligibleAt=Number(row.updated_at)||now, id=randomUUID();
      this.charts.db.prepare("INSERT OR IGNORE INTO chart_auto_learning_jobs(id,case_id,analysis_version,requested_at,eligible_at,state,next_attempt_at) VALUES(?,?,?,?,?,'PENDING',?)").run(id,caseId,CHART_ANALYSIS_VERSION,now,eligibleAt,eligibleAt+env.AUTO_CHART_LEARNING_DELAY_MS);
    }
  }

  recoveryPreview(limit = 100) {
    const safeLimit = Math.max(1, Math.min(100, limit));
    const where = `j.state='DEAD_LETTER' AND j.last_error LIKE 'CODEX_INPUT_TOO_LARGE%'
      AND a.state='FAILED' AND a.error LIKE 'CODEX_INPUT_TOO_LARGE%'
      AND c.status='CLOSED' AND s.status IN ('READY_FOR_ANALYSIS','INCOMPLETE')
      AND EXISTS (SELECT 1 FROM chart_case_evidence ce WHERE ce.case_id=c.position_id AND ce.evidence_type='CANDLE')
      AND NOT EXISTS (SELECT 1 FROM chart_case_analyses ca WHERE ca.case_id=c.position_id)
      AND NOT EXISTS (SELECT 1 FROM chart_learning_recovery_events re WHERE re.job_id=j.id AND re.action='REQUEUED')`;
    const total = Number((this.charts.db.prepare(`SELECT count(*) n FROM chart_auto_learning_jobs j
      JOIN chart_analysis_jobs a ON a.id=j.analysis_job_id JOIN chart_learning_cases c ON c.position_id=j.case_id
      JOIN chart_case_collection s ON s.case_id=c.position_id WHERE ${where}`).get() as {n:number}).n);
    const jobs = this.charts.db.prepare(`SELECT j.id jobId,j.case_id caseId,j.last_error error,j.attempt_count attempts,
      c.mode,c.account_id accountId,s.status collectionStatus FROM chart_auto_learning_jobs j
      JOIN chart_analysis_jobs a ON a.id=j.analysis_job_id JOIN chart_learning_cases c ON c.position_id=j.case_id
      JOIN chart_case_collection s ON s.case_id=c.position_id WHERE ${where}
      ORDER BY j.requested_at,j.id LIMIT ?`).all(safeLimit) as any[];
    return { dryRun: true, totalEligible: total, returned: jobs.length, jobs };
  }

  recoverOversizedFailures(confirm = false, limit = 20) {
    const preview = this.recoveryPreview(Math.max(1, Math.min(20, limit)));
    if (!confirm) return preview;
    const now = Date.now(), queued: string[] = [];
    sqliteAtomic(this.charts.db, () => {
      for (const candidate of preview.jobs as any[]) {
        const current = this.charts.db.prepare("SELECT state,last_error,case_id FROM chart_auto_learning_jobs WHERE id=?").get(candidate.jobId) as any;
        if (current?.state !== "DEAD_LETTER" || !String(current.last_error).startsWith("CODEX_INPUT_TOO_LARGE")) continue;
        if (this.charts.db.prepare("SELECT 1 FROM chart_case_analyses WHERE case_id=?").get(current.case_id)) continue;
        this.charts.db.prepare("INSERT INTO chart_learning_recovery_events VALUES(?,?,?,?,?,?)")
          .run(randomUUID(), candidate.jobId, candidate.caseId, "REQUEUED", now,
            JSON.stringify({ originalError: current.last_error, attemptsBeforeRecovery: candidate.attempts }));
        this.charts.db.prepare("UPDATE chart_auto_learning_jobs SET state='PENDING',next_attempt_at=?,completed_at=NULL WHERE id=? AND state='DEAD_LETTER'")
          .run(now + env.AUTO_CHART_LEARNING_DELAY_MS, candidate.jobId);
        queued.push(candidate.jobId);
      }
    });
    return { dryRun: false, requested: preview.totalEligible, requeued: queued.length, jobIds: queued };
  }

  private recordRecoveryOutcome(id: string, caseId: string, action: "COMPLETED" | "FAILED", details: unknown) {
    if (!this.charts.db.prepare("SELECT 1 FROM chart_learning_recovery_events WHERE job_id=? AND action='REQUEUED'").get(id)) return;
    this.charts.db.prepare("INSERT INTO chart_learning_recovery_events VALUES(?,?,?,?,?,?)")
      .run(randomUUID(), id, caseId, action, Date.now(), JSON.stringify(details));
  }

  private async runAutomatic(id:string) {
    const job=this.charts.db.prepare("SELECT * FROM chart_auto_learning_jobs WHERE id=? AND state IN ('PENDING','RETRY_WAIT')").get(id) as any;
    if(!job)return;
    const attempt=Number(job.attempt_count)+1,started=Date.now();
    this.charts.db.prepare("UPDATE chart_auto_learning_jobs SET state='RUNNING',attempt_count=?,started_at=?,last_error=NULL WHERE id=?").run(attempt,started,id);
    let analysisJobId=String(job.analysis_job_id??"");
    try {
      const existing=analysisJobId?this.charts.db.prepare("SELECT id,state FROM chart_analysis_jobs WHERE id=?").get(analysisJobId) as any:undefined;
      if(!existing||existing.state!=='PENDING'){
        analysisJobId=randomUUID();
        this.charts.db.prepare("INSERT INTO chart_analysis_jobs(id,case_id,requested_by,requested_at,state,analysis_version,retry_count) VALUES(?,?, 'AUTO_CHART_LEARNING',?,'PENDING',?,?)").run(analysisJobId,job.case_id,started,job.analysis_version,attempt-1);
      }
      this.charts.db.prepare("UPDATE chart_auto_learning_jobs SET analysis_job_id=? WHERE id=?").run(analysisJobId,id);
      await this.executeOne(analysisJobId);
      const result=this.charts.db.prepare("SELECT state,error FROM chart_analysis_jobs WHERE id=?").get(analysisJobId) as any;
      if(result?.state==='COMPLETED'){
        this.charts.db.prepare("UPDATE chart_auto_learning_jobs SET state='COMPLETED',completed_at=?,last_error=NULL WHERE id=?").run(Date.now(),id);
        this.recordRecoveryOutcome(id, String(job.case_id), "COMPLETED", { analysisJobId });
      }
      else {
        const message=String(result?.error??"AUTO_ANALYSIS_FAILED"), transient=/HTTP_429|TIMEOUT|REQUEST_FAILED|BUSY|UNAVAILABLE|fetch failed/.test(message), retry=transient&&attempt<3;
        const retryAt=Math.max(Date.now()+Math.min(300000,30000*2**(attempt-1)),Number(this.runtime.status().nextAvailableAt??0));
        this.charts.db.prepare("UPDATE chart_auto_learning_jobs SET state=?,next_attempt_at=?,completed_at=?,last_error=? WHERE id=?").run(retry?'RETRY_WAIT':'DEAD_LETTER',retryAt,retry?null:Date.now(),message,id);
        this.recordRecoveryOutcome(id, String(job.case_id), "FAILED", { analysisJobId, error: message, retryScheduled: retry });
      }
    } catch(error) {
      const message=error instanceof Error?error.message:"AUTO_ANALYSIS_FAILED", transient=/HTTP_429|TIMEOUT|REQUEST_FAILED|BUSY|UNAVAILABLE|fetch failed/.test(message),retry=transient&&attempt<3;
      const retryAt=Math.max(Date.now()+Math.min(300000,30000*2**(attempt-1)),Number(this.runtime.status().nextAvailableAt??0));
      this.charts.db.prepare("UPDATE chart_auto_learning_jobs SET state=?,next_attempt_at=?,completed_at=?,last_error=? WHERE id=?").run(retry?'RETRY_WAIT':'DEAD_LETTER',retryAt,retry?null:Date.now(),message,id);
      this.recordRecoveryOutcome(id, String(job.case_id), "FAILED", { error: message, retryScheduled: retry });
    }
  }

  retryAutomatic(id:string){const row=this.charts.db.prepare("SELECT state FROM chart_auto_learning_jobs WHERE id=?").get(id) as {state:string}|undefined;if(!row)throw Error("AUTO_LEARNING_JOB_NOT_FOUND");if(row.state!=='DEAD_LETTER')throw Error("AUTO_LEARNING_JOB_NOT_RETRYABLE");this.charts.db.prepare("UPDATE chart_auto_learning_jobs SET state='PENDING',attempt_count=0,next_attempt_at=?,completed_at=NULL,last_error=NULL WHERE id=?").run(Date.now()+env.AUTO_CHART_LEARNING_DELAY_MS,id);return this.charts.db.prepare("SELECT * FROM chart_auto_learning_jobs WHERE id=?").get(id);}

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
        "SELECT c.id,c.payload FROM chart_case_evidence ce JOIN chart_candles c ON ce.evidence_type='CANDLE' AND ce.evidence_id=c.id WHERE ce.case_id=? AND ce.available_at<=? AND c.available_at<=? ORDER BY c.at LIMIT 60000",
      )
      .all(caseId, now, now)
      .map((row: any) => ({ ...JSON.parse(String(row.payload)), id: String(row.id) }));
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
    const replayRow = this.charts.db
      .prepare("SELECT payload FROM chart_replays WHERE position_id=?")
      .get(caseId) as { payload: string } | undefined;
    const followups = this.charts.db
      .prepare("SELECT horizon,state,collected_at,payload,error FROM chart_case_followups WHERE case_id=? ORDER BY horizon")
      .all(caseId);
    if (!replayRow) throw Error("LEARNING_CASE_REPLAY_UNAVAILABLE");
    const fullReplay = JSON.parse(replayRow.payload);
    const replay = {
      positionId: fullReplay.positionId, mint: fullReplay.mint, mode: fullReplay.mode,
      accountId: fullReplay.accountId, entryAt: fullReplay.entryAt, closedAt: fullReplay.closedAt,
      fills: fullReplay.fills, accounting: fullReplay.accounting,
      maximumFavorableExcursion: fullReplay.maximumFavorableExcursion,
      maximumAdverseExcursion: fullReplay.maximumAdverseExcursion, dataQuality: fullReplay.dataQuality,
    };
    const caseData = JSON.parse(String(learningCase.payload));
    const cohort = this.charts.db.prepare("SELECT c.position_id,c.mint,c.mode,c.account_id,c.realized_pnl_pct,c.payload,r.payload replay FROM chart_learning_cases c JOIN chart_replays r ON r.position_id=c.position_id WHERE c.status='CLOSED' AND c.position_id<>? AND c.mint<>? AND c.mode=? AND c.account_id=? ORDER BY c.updated_at DESC LIMIT 30")
      .all(caseId, (learningCase as any).mint, (learningCase as any).mode, (learningCase as any).account_id)
      .map((row: any) => {
        const payload = JSON.parse(String(row.payload)), replayData = JSON.parse(String(row.replay));
        const peerEvents = this.charts.db.prepare("SELECT e.kind,e.at FROM chart_case_evidence ce JOIN chart_events e ON ce.evidence_type='EVENT' AND ce.evidence_id=e.id WHERE ce.case_id=? AND ce.available_at<=? ORDER BY e.at LIMIT 8")
          .all(String(row.position_id), now).map((event: any) => ({ kind: String(event.kind), at: Number(event.at) }));
        return { caseId: String(row.position_id), mint: String(row.mint), mode: String(row.mode), simulated: payload.simulated === true, realizedPnlPct: row.realized_pnl_pct === null ? null : Number(row.realized_pnl_pct), mfePct: replayData.maximumFavorableExcursion ?? null, maePct: replayData.maximumAdverseExcursion ?? null, eventSamples: peerEvents };
      });
    return {
      case: { ...caseData, buyConfirmedAt: Number((learningCase as any).buy_confirmed_at), sellConfirmedAt: caseData.sellConfirmedAt ?? null },
      replay,
      legacyReplay: fullReplay,
      candles,
      snapshots,
      decisions,
      events: evidence,
      followups,
      collection: this.charts.db.prepare("SELECT status,data_quality,payload FROM chart_case_collection WHERE case_id=?").get(caseId),
      missingEvidence: (followups as any[]).filter((f)=>String(f.state)!=="COLLECTED").map((f)=>({horizon:Number(f.horizon),state:String(f.state),error:f.error??null})),
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
      const { legacyReplay, ...measuredContext } = context;
      const legacyInput = {
        analysisDepth: "DEEP", task: "COMPLETED_TRADE_CASE_ANALYSIS", payload: { ...measuredContext, replay: legacyReplay },
        events: context.events,
        rules: this.charts.rules().filter((rule) => rule.status === "VALIDATED"), policy: CHART_POLICY,
      };
      const originalMetrics = analysisPayloadMetrics(legacyInput);
      const plan = buildAnalysisPlan(context);
      const contextHash = analysisPayloadMetrics(plan.map((task) => task.input)).sha256;
      const prior = this.charts.db.prepare(
        "SELECT result FROM chart_analysis_jobs WHERE case_id=? AND id<>? AND state='FAILED' AND result IS NOT NULL ORDER BY requested_at DESC LIMIT 1",
      ).get(job.case_id, id) as { result: string } | undefined;
      let progress: { contextHash: string; stageResults: Record<string, unknown> } = {
        contextHash, stageResults: {},
      };
      if (prior) {
        try {
          const previous = JSON.parse(prior.result);
          if (previous.contextHash === contextHash && previous.stageResults && typeof previous.stageResults === "object")
            progress = previous;
        } catch { /* old single-result jobs are safely reprocessed from the first stage */ }
      }
      for (const task of plan) {
        if (progress.stageResults[task.key]) continue;
        const taskInput = task.stage === "OUTCOME_COMPARISON"
          ? {
              ...task.input,
              decisionReviews: Object.fromEntries(
                Object.entries(progress.stageResults).map(([key, value]: [string, any]) => [key, {
                  stage: value.stage, review: value.review ?? null, reason: value.result.reason,
                  uncertainty: value.result.uncertainty, supportingEventIds: value.result.supportingEventIds,
                  contradictoryEventIds: value.result.contradictoryEventIds,
                }]),
              ),
            }
          : task.input;
        const bounded = boundedAnalysisInput(taskInput);
        const validEvents = Array.isArray((taskInput as any).events) ? (taskInput as any).events : [];
        const rules = task.stage === "PRE_BUY_REVIEW"
          ? this.charts.rules().filter((rule) => rule.status === "VALIDATED").slice(0, 12).map((rule) => ({
              id: rule.id, version: rule.version, name: rule.name, behaviors: rule.behaviors.slice(0, 8),
              invalidation: rule.invalidation.slice(0, 240), action: rule.action,
            }))
          : [];
        const runtimeInput = {
          analysisDepth: "DEEP", task: task.stage, payload: bounded.input,
          events: validEvents, rules, policy: CHART_POLICY,
        };
        const requestMetrics = analysisPayloadMetrics(runtimeInput);
        if (requestMetrics.bytes > ANALYSIS_MAX_ENVELOPE_BYTES)
          throw Error(`CODEX_INPUT_TOO_LARGE:bytes=${requestMetrics.bytes}:estimatedTokens=${requestMetrics.estimatedTokens}`);
        const result = reasoningSchema.parse(await this.runtime.analyze(runtimeInput));
        let review = result.experienceReview ?? null;
        if (task.stage === "PRE_BUY_REVIEW" || task.stage === "PRE_SELL_REVIEW") {
          const allowedIds = inputEvidenceIds(taskInput as Record<string, any>);
          if (review && review.evidence.some((entry) => !allowedIds.has(entry.evidenceId)))
            throw Error("EXPERIENCE_REVIEW_EVIDENCE_NOT_IN_STAGE_INPUT");
          if (!review) review = {
            conclusion: "INSUFFICIENT_EVIDENCE", evidence: [], whatWentRight: [], whatWentWrong: [],
            candidateLesson: "Structured decision-time review was not returned.",
            uncertainty: result.uncertainty || "No structured review evidence.",
          };
        }
        progress.stageResults[task.key] = {
          stage: task.stage, result, review,
          inputBytes: requestMetrics.bytes, estimatedInputTokens: requestMetrics.estimatedTokens,
          inputHash: requestMetrics.sha256,
        };
        this.charts.db.prepare("UPDATE chart_analysis_jobs SET result=? WHERE id=? AND state='RUNNING'")
          .run(JSON.stringify(progress), id);
      }
      const outcome = progress.stageResults.OUTCOME as any;
      if (!outcome?.result) throw Error("ANALYSIS_OUTCOME_STAGE_MISSING");
      const result = reasoningSchema.parse(outcome.result);
      if (result.action !== "REVIEW") throw Error("CODEX_REVIEW_ACTION_REQUIRED");
      const allowed = new Set(context.events.map((event: any) => event.id));
      if ([...result.supportingEventIds, ...result.contradictoryEventIds].some((eventId) => !allowed.has(eventId)))
        throw Error("CODEX_CASE_EVIDENCE_NOT_LINKED");
      const analyzedAt = Date.now(), analysisId = randomUUID();
      const stageResult = (key: string) => (progress.stageResults[key] as any)?.result ?? null;
      const saved = {
        ...result,
        experienceReport: {
          buy: { decisionTime: (progress.stageResults.BUY as any)?.review ?? null, outcomeComparison: result },
          holdChunks: Object.entries(progress.stageResults).filter(([key]) => key.startsWith("HOLD_"))
            .map(([key, value]: [string, any]) => ({ key, summary: value.result.reason, uncertainty: value.result.uncertainty, inputBytes: value.inputBytes })),
          sells: Object.entries(progress.stageResults).filter(([key]) => key.startsWith("SELL_"))
            .map(([key, value]: [string, any]) => ({ key, decisionTime: value.review ?? null, outcomeComparison: result })),
          outcomeComparison: result,
        },
        inputMetrics: {
          originalBytes: originalMetrics.bytes, originalEstimatedTokens: originalMetrics.estimatedTokens,
          optimizedStages: Object.fromEntries(Object.entries(progress.stageResults).map(([key, value]: [string, any]) => [key, {
            bytes: value.inputBytes, estimatedTokens: value.estimatedInputTokens,
          }])),
        },
        analysisVersion: job.analysis_version, runtime: this.runtime.status(), caseId: job.case_id, analyzedAt,
      };
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
            id: "LR-" + chartId(job.case_id, hypothesis.name, hypothesis.action).slice(0, 16),
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
          if (!this.charts.db.prepare("SELECT 1 FROM chart_rule_versions WHERE id=? LIMIT 1").get(rule.id))
            this.charts.saveRule(rule);
        }
        if (result.knowledgeHypothesis) {
          const knowledge = new ChartKnowledgeRepository(this.charts.db);
          const allowedCases = new Set([job.case_id, ...context.cohortCaseIds]);
          const supportCases = result.knowledgeHypothesis.supportingCaseIds;
          const contradictoryCases = result.knowledgeHypothesis.contradictoryCaseIds;
          if ([...supportCases, ...contradictoryCases].some((caseId) => !allowedCases.has(caseId)) || !supportCases.length || supportCases.some((caseId) => contradictoryCases.includes(caseId))) throw Error("CODEX_KNOWLEDGE_CASE_REFERENCE_INVALID");
          const knowledgeId = "KN-" + chartId(job.case_id, result.knowledgeHypothesis.title, result.knowledgeHypothesis.category, result.knowledgeHypothesis.applicableStage).slice(0, 20);
          if (!this.charts.db.prepare("SELECT 1 FROM chart_knowledge_versions WHERE id=? LIMIT 1").get(knowledgeId)) try { knowledge.createDraft({
            id: knowledgeId,
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
          }); } catch(error) {
            if(!(error instanceof Error)||!error.message.startsWith("KNOWLEDGE_SUPPRESSED_BY_USER"))throw error;
          }
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
    this.stopped=true;
    await this.active;
    await this.autoActive;
  }

  job(id: string) {
    return this.charts.db.prepare("SELECT * FROM chart_analysis_jobs WHERE id=?").get(id) ?? null;
  }

  status() {
    const counts = Object.fromEntries(
      this.charts.db.prepare("SELECT state,count(*) n FROM chart_analysis_jobs GROUP BY state").all()
        .map((row: any) => [String(row.state).toLowerCase(), Number(row.n)]),
    );
    const automatic=Object.fromEntries(this.charts.db.prepare("SELECT state,count(*) n FROM chart_auto_learning_jobs GROUP BY state").all().map((row:any)=>[String(row.state).toLowerCase(),Number(row.n)]));
    const next=this.charts.db.prepare("SELECT min(eligible_at+?) at FROM chart_auto_learning_jobs WHERE state IN ('PENDING','RETRY_WAIT')").get(env.AUTO_CHART_LEARNING_DELAY_MS) as {at:number|null};
    return { mode: env.AUTO_CHART_LEARNING_ENABLED?"AUTOMATIC":"DISABLED", enabled:env.AUTO_CHART_LEARNING_ENABLED, active: Boolean(this.active||this.autoActive), jobs: counts, automaticJobs:automatic, nextEligibleAt:next.at, delayMs:env.AUTO_CHART_LEARNING_DELAY_MS, maxConcurrency:1 };
  }
}
