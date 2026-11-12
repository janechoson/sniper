import type { Engine } from "./engine.js";
import type { ChartEvent } from "./chart-store.js";
import { env } from "./config.js";
import { ChartKnowledgeRepository } from "./chart-knowledge.js";

function caseRows(engine: Engine) {
  return engine.chartLearning.charts.db.prepare(
    `SELECT c.position_id caseId,c.mint,c.mode,c.buy_confirmed_at entryAt,c.learning_started_at,
      c.status positionStatus,c.realized_pnl_pct realizedPnlPct,
      s.status collectionStatus,s.data_quality dataQuality,s.last_collected_at lastCollectedAt,
      (SELECT count(*) FROM chart_case_followups f WHERE f.case_id=c.position_id AND f.state='COLLECTED') followupsCollected,
      (SELECT count(*) FROM chart_case_followups f WHERE f.case_id=c.position_id AND f.state IN ('PENDING','FAILED')) followupsPending,
      (SELECT j.state FROM chart_analysis_jobs j WHERE j.case_id=c.position_id ORDER BY j.requested_at DESC LIMIT 1) analysisStatus,
      (SELECT j.id FROM chart_analysis_jobs j WHERE j.case_id=c.position_id ORDER BY j.requested_at DESC LIMIT 1) analysisJobId,
      (SELECT j.id FROM chart_auto_learning_jobs j WHERE j.case_id=c.position_id ORDER BY j.requested_at DESC LIMIT 1) autoLearningJobId,
      (SELECT j.state FROM chart_auto_learning_jobs j WHERE j.case_id=c.position_id ORDER BY j.requested_at DESC LIMIT 1) autoLearningState,
      (SELECT j.eligible_at FROM chart_auto_learning_jobs j WHERE j.case_id=c.position_id ORDER BY j.requested_at DESC LIMIT 1) eligibleAt,
      (SELECT j.completed_at FROM chart_analysis_jobs j WHERE j.case_id=c.position_id AND j.state='COMPLETED' ORDER BY j.completed_at DESC LIMIT 1) lastAnalysisAt
     FROM chart_learning_cases c JOIN chart_case_collection s ON s.case_id=c.position_id
     ORDER BY c.learning_started_at DESC LIMIT 200`,
  ).all();
}

export function chartLearningCommand(engine: Engine, url: URL, body: unknown) {
  if (!body || typeof body !== "object") throw Error("INVALID_ANALYSIS_REQUEST");
  const input = body as Record<string, unknown>;
  const knowledgeControl = url.pathname.match(/^\/api\/chart-learning\/knowledge\/([^/]+)\/(disable|reject|delete|restore)$/);
  if (knowledgeControl) {
    if (!Number.isInteger(input.version)) throw Error("INVALID_KNOWLEDGE_CONTROL_REQUEST");
    const repo=new ChartKnowledgeRepository(engine.store.learningDb),id=decodeURIComponent(knowledgeControl[1]!),version=Number(input.version),reason=typeof input.reason==="string"?input.reason:"User intervention";
    const action=knowledgeControl[2];
    if(action==="disable")return repo.disable(id,version,reason);
    if(action==="reject")return repo.reject(id,version,reason);
    if(action==="delete")return repo.delete(id,version,reason);
    return repo.restore(id,version,reason);
  }
  if (url.pathname === "/api/chart-learning/analyze") {
    if (typeof input.caseId !== "string") throw Error("LEARNING_CASE_ID_REQUIRED");
    return engine.chartLearning.analyzer.request([input.caseId]);
  }
  if (url.pathname === "/api/chart-learning/analyze-batch") {
    const ids = input.ready === true
      ? engine.chartLearning.analyzer.readyCaseIds(20)
      : Array.isArray(input.caseIds) && input.caseIds.every((id) => typeof id === "string")
        ? input.caseIds as string[]
        : [];
    if (!ids.length) throw Error("NO_READY_CASES_SELECTED");
    return engine.chartLearning.analyzer.request(ids);
  }
  const retry = url.pathname.match(/^\/api\/chart-learning\/analysis-jobs\/([^/]+)\/retry$/);
  if (retry) return engine.chartLearning.analyzer.retry(decodeURIComponent(retry[1]!));
  const retryAuto = url.pathname.match(/^\/api\/chart-learning\/auto-learning-jobs\/([^/]+)\/retry$/);
  if (retryAuto) return engine.chartLearning.analyzer.retryAutomatic(decodeURIComponent(retryAuto[1]!));
  throw Error("CHART_COMMAND_NOT_FOUND");
}

function eventReviews(
  db: Engine["store"]["learningDb"],
  events: ChartEvent[],
) {
  const ids = events.map((event) => event.id);
  const jobs = ids.length
    ? db
        .prepare(
          `SELECT state,error,result,attempts,at,payload FROM chart_jobs WHERE kind='EVENT_REVIEW' AND (json_extract(payload,'$.id') IN (${ids.map(() => "?").join(",")}) OR json_extract(payload,'$.event.id') IN (${ids.map(() => "?").join(",")})) ORDER BY at DESC`,
        )
        .all(...ids, ...ids)
    : [];
  const byEvent = new Map<string, (typeof jobs)[number]>();
  for (const job of jobs) {
    const payload = JSON.parse(String(job.payload));
    const id = payload.event?.id ?? payload.id;
    if (!byEvent.has(id)) byEvent.set(id, job);
  }
  return events.map((event) => {
    const job = byEvent.get(event.id) as
      | { state: string; error: string | null; result: string | null; attempts: number; at: number }
      | undefined;
    return {
      ...event,
      analysisState: job?.state ?? "NOT_QUEUED",
      analysisError: job?.error ?? null,
      analysis: job?.result ? JSON.parse(job.result).analysis ?? null : null,
      analysisRuntime: job?.result ? JSON.parse(job.result).runtime ?? null : null,
      analysisAt: job?.at ?? null,
      analysisAttempts: job?.attempts ?? 0,
    };
  });
}

/** Read-only bounded projections. Mode/account is server authority, not a query parameter. */
export function chartLearningView(engine: Engine, url: URL) {
  const knowledgeDetail=url.pathname.match(/^\/api\/chart-learning\/knowledge\/([^/]+)$/);
  if(knowledgeDetail)return new ChartKnowledgeRepository(engine.store.learningDb).detail(decodeURIComponent(knowledgeDetail[1]!));
  if (url.pathname === "/api/chart-learning/knowledge") return new ChartKnowledgeRepository(engine.store.learningDb).all();
  if (engine.store.sharedLearning) return sharedLearningView(engine, url);
  const charts = engine.chartLearning.charts,
    db = charts.db,
    mode = env.TRADING_MODE,
    account = charts.account(mode);
  const id = url.searchParams.get("id") ?? "";
  const rows = (sql: string, ...args: string[]) =>
    db
      .prepare(sql)
      .all(...args)
      .map((r) => JSON.parse(String(r.payload)));
  if (url.pathname === "/api/chart-learning")
    return {
      overview: charts.overview(mode),
      status: engine.chartLearning.status(),
      aiGuardStatus: engine.codexAIGuard.status(),
      rules: charts.rules(),
      events: eventReviews(
        db,
        charts.events(100).filter((e) => e.kind !== "CONTROL"),
      ),
      decisions: charts.decisions(mode),
      sells: rows(
        "SELECT payload FROM executions WHERE json_extract(payload,'$.intent.mode')=? AND (?<>'demo' OR json_extract(payload,'$.intent.demoAccountId')=?) AND json_extract(payload,'$.intent.side')='SELL' ORDER BY rowid DESC LIMIT 100",
        mode,
        mode,
        account,
      ),
      replays: rows(
        "SELECT payload FROM chart_replays WHERE mode=? AND account_id=? ORDER BY at DESC LIMIT 50",
        mode,
        account,
      ),
      timeline: rows(
        "SELECT payload FROM chart_rule_versions ORDER BY at DESC LIMIT 100",
      ),
      backtests: rows(
        "SELECT payload FROM chart_validations WHERE json_extract(payload,'$.kind')='WALK_FORWARD_COMPARISON' ORDER BY at DESC LIMIT 20",
      ),
      learningCases: caseRows(engine),
      analysisJobs: engine.chartLearning.analyzer.jobs(),
      autoLearningJobs: engine.store.learningDb.prepare("SELECT * FROM chart_auto_learning_jobs ORDER BY requested_at DESC LIMIT 100").all(),
      validationJobs: engine.chartLearning.validation.jobs(),
      autoLearningStatus: engine.chartLearning.analyzer.status(),
      validationStatus: engine.chartLearning.validation.status(),
      knowledge: new ChartKnowledgeRepository(db).all(),
      analysisStatus: {
        automaticEnabled: process.env.AUTO_CHART_LEARNING_ENABLED !== "false",
        ready: Number(db.prepare("SELECT count(*) n FROM chart_case_collection WHERE status='READY_FOR_ANALYSIS'").get()!.n),
        incomplete: Number(db.prepare("SELECT count(*) n FROM chart_case_collection WHERE status='INCOMPLETE'").get()!.n),
        analyzed: Number(db.prepare("SELECT count(DISTINCT case_id) n FROM chart_case_analyses").get()!.n),
        pending: Number(db.prepare("SELECT count(*) n FROM chart_auto_learning_jobs WHERE state IN ('PENDING','RETRY_WAIT')").get()!.n),
        running: Number(db.prepare("SELECT count(*) n FROM chart_auto_learning_jobs WHERE state='RUNNING'").get()!.n),
        failed: Number(db.prepare("SELECT count(*) n FROM chart_auto_learning_jobs WHERE state='DEAD_LETTER'").get()!.n),
        lastAnalyzedAt: db.prepare("SELECT max(analyzed_at) n FROM chart_case_analyses").get()!.n ?? null,
      },
    };
  if (url.pathname === "/api/chart-learning/rule")
    return {
      versions: rows(
        "SELECT payload FROM chart_rule_versions WHERE id=? ORDER BY version",
        id,
      ),
      evidence: db
        .prepare(
          "SELECT e.payload,r.stance,r.version FROM chart_rule_evidence r JOIN chart_events e ON e.id=r.event_id WHERE r.rule_id=? ORDER BY r.version DESC LIMIT 200",
        )
        .all(id)
        .map((r) => ({
          event: JSON.parse(String(r.payload)),
          stance: r.stance,
          version: r.version,
        })),
      decisions: charts
        .decisions(mode, 1000)
        .filter((d) => d.rules.some((r) => r.id === id)),
      validations: rows(
        "SELECT payload FROM chart_validations WHERE json_extract(payload,'$.ruleId')=? ORDER BY at DESC LIMIT 30",
        id,
      ),
    };
  if (url.pathname === "/api/chart-learning/evidence") {
    const event = rows("SELECT payload FROM chart_events WHERE id=?", id)[0];
    if (!event) return { error: "EVENT_NOT_FOUND" };
    return {
      event,
      outcomes: rows(
        "SELECT payload FROM chart_event_outcomes WHERE event_id=? ORDER BY horizon",
        id,
      ),
      candles: charts.candles(
        event.mint,
        event.at - 3600000,
        event.at + 3600000,
      ),
    };
  }
  if (url.pathname === "/api/chart-learning/decision") {
    const decision = rows(
      "SELECT payload FROM chart_decisions WHERE id=? AND mode=? AND account_id=?",
      id,
      mode,
      account,
    )[0];
    if (!decision) return { error: "DECISION_NOT_FOUND" };
    return {
      decision,
      snapshot: rows(
        "SELECT payload FROM chart_snapshots WHERE id=?",
        decision.snapshotId,
      )[0],
      followups: rows(
        "SELECT payload FROM chart_followups WHERE decision_id=? ORDER BY horizon",
        id,
      ),
      executions: engine.store
        .executions(mode)
        .filter((e) => e.intent.decisionId === id),
    };
  }
  if (url.pathname === "/api/chart-learning/replay") {
    const replay = rows(
      "SELECT payload FROM chart_replays WHERE position_id=? AND mode=? AND account_id=?",
      id,
      mode,
      account,
    )[0];
    return {
      replay: replay ?? null,
      decisions: charts
        .decisions(mode, 1000)
        .filter(
          (d) => d.positionId === id || (replay && d.mint === replay.mint),
        ),
      kronos: engine.store
        .recent("kronos_decisions", 1000)
        .filter(
          (r) =>
            r.payload.positionId === id ||
            (replay &&
              r.payload.attemptId ===
                engine.store.positions(mode).find((p) => p.id === id)
                  ?.attemptId),
        ),
      events: replay
        ? charts
            .events(1000)
            .filter(
              (e) =>
                e.mint === replay.mint &&
                e.at >= replay.entryAt &&
                e.at <= replay.closedAt,
            )
        : [],
      reviews: db
        .prepare(
          "SELECT state,result,error FROM chart_jobs WHERE kind='TRADE_REVIEW' AND mode=? AND account_id=? AND json_extract(payload,'$.positionId')=?",
        )
        .all(mode, account, id),
    };
  }
  if (url.pathname === "/api/chart-learning/sell") {
    const execution = rows(
      "SELECT payload FROM executions WHERE id=? AND json_extract(payload,'$.intent.mode')=? AND (?<>'demo' OR json_extract(payload,'$.intent.demoAccountId')=?) AND json_extract(payload,'$.intent.side')='SELL'",
      id,
      mode,
      mode,
      account,
    )[0];
    if (!execution) return { error: "SELL_NOT_FOUND" };
    const p = engine.store
      .positions(mode)
      .find((p) => p.id === execution.intent.positionId);
    return {
      execution,
      source: execution.intent.decisionSource,
      position: p,
      decision:
        execution.intent.decisionSource === "CODEX"
          ? p?.codexDecision
          : p?.kronosDecision,
      simulated: execution.evidence?.simulated === true,
      executionPrice: execution.accounting?.priceUsd ?? null,
    };
  }
  if (url.pathname === "/api/chart-learning/jobs")
    return db
      .prepare(
        "SELECT id,kind,at,due,state,attempts,error,result,json_extract(payload,'$.mint') mint,coalesce(json_extract(payload,'$.event.kind'),json_extract(payload,'$.kind')) referenceKind FROM chart_jobs WHERE mode=? AND account_id=? ORDER BY at DESC LIMIT 100",
      )
      .all(mode, account)
      .map((row) => ({
        ...row,
        result: row.result ? JSON.parse(String(row.result)) : null,
      }));
  if (url.pathname === "/api/chart-learning/analysis-jobs")
    return engine.chartLearning.analyzer.jobs(100);
  if (url.pathname === "/api/chart-learning/auto-learning-jobs")
    return engine.store.learningDb.prepare("SELECT * FROM chart_auto_learning_jobs ORDER BY requested_at DESC LIMIT 100").all();
  if (url.pathname === "/api/chart-learning/validation-jobs")
    return engine.chartLearning.validation.jobs(100);
  const manualJob = url.pathname.match(/^\/api\/chart-learning\/analysis-jobs\/([^/]+)$/);
  if (manualJob)
    return engine.chartLearning.analyzer.job(decodeURIComponent(manualJob[1]!)) ?? { error: "ANALYSIS_JOB_NOT_FOUND" };
  return { error: "CHART_ROUTE_NOT_FOUND" };
}

/** Entire projection comes from learning.sqlite; execution mode is evidence
 * provenance, never a dashboard partition or a trading database selector. */
function sharedLearningView(engine: Engine, url: URL) {
  const charts = engine.chartLearning.charts,
    db = charts.db,
    id = url.searchParams.get("id") ?? "";
  const rows = (sql: string, ...args: string[]) =>
    db
      .prepare(sql)
      .all(...args)
      .map((r) => JSON.parse(String(r.payload)));
  const replays = () =>
    rows("SELECT payload FROM chart_replays ORDER BY at DESC LIMIT 100");
  const executions = () => {
    const values = [
      ...replays().flatMap((r) =>
        r.fills.map((f: { evidence: unknown }) => f.evidence),
      ),
      ...rows(
        "SELECT payload FROM learning_records WHERE kind='execution' ORDER BY at LIMIT 5000",
      ),
    ];
    return [...new Map(values.map((e) => [e.id, e])).values()];
  };
  if (url.pathname === "/api/chart-learning")
    return {
      overview: charts.overview("demo"),
      status: engine.chartLearning.status(),
      aiGuardStatus: engine.codexAIGuard.status(),
      rules: charts.rules(),
      events: eventReviews(
        db,
        charts.events(100).filter((e) => e.kind !== "CONTROL"),
      ),
      decisions: charts.decisions("demo"),
      sells: executions().filter((e) => e.intent.side === "SELL"),
      replays: replays(),
      timeline: rows(
        "SELECT payload FROM chart_rule_versions ORDER BY at DESC LIMIT 100",
      ),
      backtests: rows(
        "SELECT payload FROM chart_validations WHERE json_extract(payload,'$.kind')='WALK_FORWARD_COMPARISON' ORDER BY at DESC LIMIT 20",
      ),
      learningCases: caseRows(engine),
      analysisJobs: engine.chartLearning.analyzer.jobs(),
      autoLearningJobs: db.prepare("SELECT * FROM chart_auto_learning_jobs ORDER BY requested_at DESC LIMIT 100").all(),
      validationJobs: engine.chartLearning.validation.jobs(),
      autoLearningStatus: engine.chartLearning.analyzer.status(),
      validationStatus: engine.chartLearning.validation.status(),
      knowledge: new ChartKnowledgeRepository(db).all(),
      analysisStatus: {
        automaticEnabled: process.env.AUTO_CHART_LEARNING_ENABLED !== "false",
        ready: Number(db.prepare("SELECT count(*) n FROM chart_case_collection WHERE status='READY_FOR_ANALYSIS'").get()!.n),
        incomplete: Number(db.prepare("SELECT count(*) n FROM chart_case_collection WHERE status='INCOMPLETE'").get()!.n),
        analyzed: Number(db.prepare("SELECT count(DISTINCT case_id) n FROM chart_case_analyses").get()!.n),
        pending: Number(db.prepare("SELECT count(*) n FROM chart_auto_learning_jobs WHERE state IN ('PENDING','RETRY_WAIT')").get()!.n),
        running: Number(db.prepare("SELECT count(*) n FROM chart_auto_learning_jobs WHERE state='RUNNING'").get()!.n),
        failed: Number(db.prepare("SELECT count(*) n FROM chart_auto_learning_jobs WHERE state='DEAD_LETTER'").get()!.n),
        lastAnalyzedAt: db.prepare("SELECT max(analyzed_at) n FROM chart_case_analyses").get()!.n ?? null,
      },
    };
  if (url.pathname === "/api/chart-learning/jobs")
    return db
      .prepare(
        "SELECT id,kind,at,due,state,attempts,error,result,json_extract(payload,'$.mint') mint,coalesce(json_extract(payload,'$.event.kind'),json_extract(payload,'$.kind')) referenceKind FROM chart_jobs ORDER BY at DESC LIMIT 100",
      )
      .all()
      .map((row) => ({
        ...row,
        result: row.result ? JSON.parse(String(row.result)) : null,
      }));
  if (url.pathname === "/api/chart-learning/analysis-jobs")
    return engine.chartLearning.analyzer.jobs(100);
  if (url.pathname === "/api/chart-learning/auto-learning-jobs")
    return db.prepare("SELECT * FROM chart_auto_learning_jobs ORDER BY requested_at DESC LIMIT 100").all();
  if (url.pathname === "/api/chart-learning/validation-jobs")
    return engine.chartLearning.validation.jobs(100);
  const manualJob = url.pathname.match(/^\/api\/chart-learning\/analysis-jobs\/([^/]+)$/);
  if (manualJob)
    return engine.chartLearning.analyzer.job(decodeURIComponent(manualJob[1]!)) ?? { error: "ANALYSIS_JOB_NOT_FOUND" };
  if (url.pathname === "/api/chart-learning/rule")
    return {
      versions: rows(
        "SELECT payload FROM chart_rule_versions WHERE id=? ORDER BY version",
        id,
      ),
      evidence: db
        .prepare(
          "SELECT e.payload,r.stance,r.version FROM chart_rule_evidence r JOIN chart_events e ON e.id=r.event_id WHERE r.rule_id=? ORDER BY r.version DESC LIMIT 200",
        )
        .all(id)
        .map((r) => ({
          event: JSON.parse(String(r.payload)),
          stance: r.stance,
          version: r.version,
        })),
      decisions: charts
        .decisions("demo", 1000)
        .filter((d) => d.rules.some((r) => r.id === id)),
      validations: rows(
        "SELECT payload FROM chart_validations WHERE json_extract(payload,'$.ruleId')=? ORDER BY at DESC LIMIT 30",
        id,
      ),
    };
  if (url.pathname === "/api/chart-learning/evidence") {
    const event = rows("SELECT payload FROM chart_events WHERE id=?", id)[0];
    return event
      ? {
          event,
          outcomes: rows(
            "SELECT payload FROM chart_event_outcomes WHERE event_id=? ORDER BY horizon",
            id,
          ),
          candles: charts.candles(
            event.mint,
            event.at - 3600000,
            event.at + 3600000,
          ),
        }
      : { error: "EVENT_NOT_FOUND" };
  }
  if (url.pathname === "/api/chart-learning/decision") {
    const decision = rows(
      "SELECT payload FROM chart_decisions WHERE id=?",
      id,
    )[0];
    return decision
      ? {
          decision,
          snapshot: rows(
            "SELECT payload FROM chart_snapshots WHERE id=?",
            decision.snapshotId,
          )[0],
          followups: rows(
            "SELECT payload FROM chart_followups WHERE decision_id=?",
            id,
          ),
          executions: executions().filter((e) => e.intent.decisionId === id),
        }
      : { error: "DECISION_NOT_FOUND" };
  }
  if (url.pathname === "/api/chart-learning/replay") {
    const replay = rows(
      "SELECT payload FROM chart_replays WHERE position_id=?",
      id,
    )[0];
    const attempt = replay?.fills.find(
      (f: { label: string }) => f.label === "ACTUAL BUY",
    )?.evidence?.intent?.attemptId;
    return {
      replay: replay ?? null,
      decisions: charts
        .decisions("demo", 1000)
        .filter(
          (d) => d.positionId === id || (replay && d.mint === replay.mint),
        ),
      kronos: rows(
        "SELECT payload FROM learning_records WHERE kind='kronos_decisions' ORDER BY at DESC LIMIT 1000",
      )
        .filter(
          (d) => d.positionId === id || (attempt && d.attemptId === attempt),
        )
        .map((payload) => ({ payload })),
      events: replay
        ? charts
            .events(1000)
            .filter(
              (e) =>
                e.mint === replay.mint &&
                e.at >= replay.entryAt &&
                e.at <= replay.closedAt,
            )
        : [],
      reviews: db
        .prepare(
          "SELECT state,result,error FROM chart_jobs WHERE kind='TRADE_REVIEW' AND json_extract(payload,'$.positionId')=?",
        )
        .all(id),
    };
  }
  if (url.pathname === "/api/chart-learning/sell") {
    const execution = executions().find((e) => e.id === id);
    return execution
      ? {
          execution,
          source: execution.intent.decisionSource,
          simulated: execution.evidence?.simulated === true,
          executionPrice: execution.accounting?.priceUsd ?? null,
        }
      : { error: "SELL_NOT_FOUND" };
  }
  return { error: "CHART_ROUTE_NOT_FOUND" };
}
