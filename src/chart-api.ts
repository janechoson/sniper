import type { Engine } from "./engine.js";
import type { ChartEvent } from "./chart-store.js";
import { env } from "./config.js";
import { ChartKnowledgeRepository } from "./chart-knowledge.js";
import { classifyChartPattern } from "./chart-pattern-classifier.js";

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
      (SELECT j.last_error FROM chart_auto_learning_jobs j WHERE j.case_id=c.position_id ORDER BY j.requested_at DESC LIMIT 1) autoLearningError,
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
  if (url.pathname === "/api/chart-learning/recover-oversized") {
    return engine.chartLearning.analyzer.recoverOversizedFailures(input.confirm === true, Number(input.limit) || 20);
  }
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
  if (url.pathname === "/api/chart-learning/experiences")
    return experienceGallery(engine, url);
  if (url.pathname === "/api/chart-learning/diagnostics")
    return experienceDiagnostics(engine);
  if (url.pathname === "/api/chart-learning/recovery-preview")
    return engine.chartLearning.analyzer.recoveryPreview(100);
  const experienceDetail = url.pathname.match(/^\/api\/chart-learning\/experiences\/([^/]+)$/);
  if (experienceDetail)
    return experienceReplay(engine, decodeURIComponent(experienceDetail[1]!));
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

function experienceDiagnostics(engine: Engine) {
  const { db, account } = engine.chartLearning.charts;
  const mode = env.TRADING_MODE, accountId = account.call(engine.chartLearning.charts, mode);
  const scalar = (sql: string, ...args: (string | number)[]) => Number((db.prepare(sql).get(...args) as { n: number }).n);
  return {
    closedTrades: scalar("SELECT count(*) n FROM chart_learning_cases WHERE mode=? AND account_id=? AND status='CLOSED'", mode, accountId),
    learningCases: scalar("SELECT count(*) n FROM chart_learning_cases WHERE mode=? AND account_id=?", mode, accountId),
    analyzed: scalar("SELECT count(DISTINCT a.case_id) n FROM chart_case_analyses a JOIN chart_learning_cases c ON c.position_id=a.case_id WHERE c.mode=? AND c.account_id=?", mode, accountId),
    drafts: scalar("SELECT count(*) n FROM chart_rule_versions WHERE status='DRAFT'"),
    validated: scalar("SELECT count(*) n FROM chart_rule_versions WHERE status='VALIDATED'"),
    incomplete: scalar("SELECT count(*) n FROM chart_case_collection s JOIN chart_learning_cases c ON c.position_id=s.case_id WHERE c.mode=? AND c.account_id=? AND s.status='INCOMPLETE'", mode, accountId),
    failedJobs: scalar("SELECT count(*) n FROM chart_auto_learning_jobs j JOIN chart_learning_cases c ON c.position_id=j.case_id WHERE c.mode=? AND c.account_id=? AND j.state='DEAD_LETTER'", mode, accountId),
    pendingValidation: scalar("SELECT count(*) n FROM chart_validation_jobs WHERE state IN ('PENDING','RUNNING')"),
  };
}

function galleryLearningStatus(row: any, analysis: any) {
  if (analysis) return analysis?.knowledgeHypothesis || analysis?.hypothesis ? "ANALYZED" : "ANALYZED_NO_HYPOTHESIS";
  if (row.autoState === "RUNNING" || row.manualState === "RUNNING") return "ANALYZING";
  if (["PENDING", "RETRY_WAIT"].includes(row.autoState) || row.manualState === "PENDING") return "QUEUED";
  if (row.autoState === "DEAD_LETTER") return "DEAD_LETTER";
  if (row.autoState === "FAILED" || row.manualState === "FAILED") return "FAILED";
  if (row.learningStatus !== "READY_FOR_ANALYSIS" && row.learningStatus !== "INCOMPLETE") return "WAITING_FOR_DATA";
  return "QUEUED";
}

/** Bounded, read-only gallery projection. It never fetches market data or starts analysis. */
function experienceGallery(engine: Engine, url: URL) {
  const { db, account } = engine.chartLearning.charts;
  const mode = env.TRADING_MODE;
  const page = Math.max(1, Math.min(100000, Number(url.searchParams.get("page")) || 1));
  const limit = Math.max(1, Math.min(48, Number(url.searchParams.get("limit")) || 24));
  const requestedPattern = String(url.searchParams.get("pattern") ?? "ALL").toUpperCase();
  const outcome = String(url.searchParams.get("outcome") ?? "ALL").toUpperCase();
  const days = Math.max(0, Math.min(3650, Number(url.searchParams.get("days")) || 0));
  const cutoff = days ? Date.now() - days * 86400000 : 0;
  const accountId = account.call(engine.chartLearning.charts, mode);
  const candidates = db.prepare(
    `SELECT c.position_id caseId,c.mint,c.mode,c.account_id accountId,c.buy_confirmed_at entryAt,
      c.updated_at updatedAt,c.realized_pnl_pct pnl,c.payload,s.status learningStatus,s.data_quality dataQuality,
      (SELECT a.result FROM chart_case_analyses a WHERE a.case_id=c.position_id ORDER BY a.analyzed_at DESC LIMIT 1) analysis,
      (SELECT e.kind FROM chart_case_evidence ce JOIN chart_events e ON e.id=ce.evidence_id
        WHERE ce.case_id=c.position_id AND ce.evidence_type='EVENT' ORDER BY e.at DESC LIMIT 1) patternEvent,
      (SELECT j.state FROM chart_auto_learning_jobs j WHERE j.case_id=c.position_id ORDER BY j.requested_at DESC LIMIT 1) autoState,
      (SELECT j.last_error FROM chart_auto_learning_jobs j WHERE j.case_id=c.position_id ORDER BY j.requested_at DESC LIMIT 1) autoError,
      (SELECT j.state FROM chart_analysis_jobs j WHERE j.case_id=c.position_id ORDER BY j.requested_at DESC LIMIT 1) manualState,
      (SELECT j.error FROM chart_analysis_jobs j WHERE j.case_id=c.position_id ORDER BY j.requested_at DESC LIMIT 1) manualError,
      (SELECT j.id FROM chart_auto_learning_jobs j WHERE j.case_id=c.position_id ORDER BY j.requested_at DESC LIMIT 1) autoJobId,
      (SELECT j.id FROM chart_analysis_jobs j WHERE j.case_id=c.position_id ORDER BY j.requested_at DESC LIMIT 1) manualJobId
     FROM chart_learning_cases c JOIN chart_case_collection s ON s.case_id=c.position_id
     WHERE c.mode=? AND c.account_id=? AND c.status='CLOSED' AND c.updated_at>=?
     ORDER BY c.updated_at DESC,c.position_id ASC LIMIT 500`,
  ).all(mode, accountId, cutoff) as any[];
  const visible = candidates.map((row) => {
    let payload: Record<string, any> = {};
    let analysis: any = null;
    try { payload = JSON.parse(String(row.payload)); } catch { /* retain the case as incomplete */ }
    try { analysis = row.analysis ? JSON.parse(String(row.analysis)) : null; } catch { /* no usable review */ }
    const pnl = row.pnl === null ? null : Number(row.pnl);
    return {
      caseId: String(row.caseId), mint: String(row.mint), mode: String(row.mode),
      entryAt: Number(row.entryAt), closedAt: Number(payload.closedAt ?? row.updatedAt),
      pnlPct: Number.isFinite(pnl) ? pnl : null, pattern: "UNKNOWN",
      patternEvidence: null,
      learningStatus: String(row.learningStatus), dataQuality: String(row.dataQuality),
      analysisStatus: "UNKNOWN",
      analysisError: null,
      autoState: row.autoState, autoError: row.autoError, manualState: row.manualState, manualError: row.manualError,
      autoJobId: row.autoJobId, manualJobId: row.manualJobId,
      hasAnalysis: Boolean(analysis), analysis,
      tokenName: String(payload.tokenSymbol ?? payload.symbol ?? payload.tokenName ?? ""),
    };
  });
  const allIds = visible.map((item) => item.caseId);
  const candlesByCase = new Map<string, any[]>();
  // 500 IDs stay below SQLite's bind limit; at most 64 OHLCV rows are returned per case.
  if (allIds.length) {
    const candleRows = db.prepare(
      `WITH selected(case_id,mint,entry_at,closed_at) AS (
         SELECT c.position_id,c.mint,c.buy_confirmed_at,coalesce(json_extract(c.payload,'$.closedAt'),c.updated_at)
         FROM chart_learning_cases c WHERE c.position_id IN (${allIds.map(() => "?").join(",")})
       ), series AS (
         SELECT s.case_id,cc.id candle_id,cc.payload,
           row_number() OVER(PARTITION BY s.case_id ORDER BY cc.at) rn,
           count(*) OVER(PARTITION BY s.case_id) total
         FROM selected s JOIN chart_candles cc ON cc.mint=s.mint
           AND cc.at>=s.entry_at-3600000 AND cc.at<=s.closed_at+3600000
       ) SELECT case_id,candle_id,payload FROM series
         WHERE rn=1 OR rn=total OR ((rn-1)*64/total)<>((rn-2)*64/total)
         ORDER BY case_id,rn`,
    ).all(...allIds) as { case_id: string; candle_id: string; payload: string }[];
    for (const row of candleRows) {
      const candle = JSON.parse(row.payload);
      const list = candlesByCase.get(row.case_id) ?? [];
      if (list.length < 66) list.push({ ...candle, id: row.candle_id });
      candlesByCase.set(row.case_id, list);
    }
  }
  const visibleWithPattern = visible.map((item) => {
    const classification = classifyChartPattern(candlesByCase.get(item.caseId) ?? []);
    const state = galleryLearningStatus(item, item.analysis);
    return { ...item, pattern: classification.label, patternEvidence: classification, analysisStatus: state,
      analysisError: item.autoError ?? item.manualError ?? null };
  });
  const filtered = visibleWithPattern.filter((row) => requestedPattern === "ALL" || row.pattern === requestedPattern)
    .filter((row) => outcome === "ALL" || (outcome === "WIN" ? (row.pnlPct ?? 0) > 0 : outcome === "LOSS" ? (row.pnlPct ?? 0) < 0 : true));
  const total = filtered.length;
  const items = filtered.slice((page - 1) * limit, page * limit);
  // One bounded query returns evenly sampled real candles for every visible card.
  const ids = items.map((item) => item.caseId);
  const fillsByCase = new Map<string, unknown[]>();
  if (ids.length) {
    const marks = ids.map(() => "?").join(",");
    const fills = engine.store.db.prepare(
      `SELECT json_extract(payload,'$.intent.positionId') position_id,payload FROM executions
       WHERE json_extract(payload,'$.intent.mode')=? AND json_extract(payload,'$.intent.positionId') IN (${marks})
         AND json_extract(payload,'$.state')='CONFIRMED'
         AND (?<>'demo' OR json_extract(payload,'$.intent.demoAccountId')=?) ORDER BY rowid`,
    ).all(mode, ...ids, mode, accountId) as { position_id: string; payload: string }[];
    for (const row of fills) {
      const execution = JSON.parse(row.payload);
      const list = fillsByCase.get(row.position_id) ?? [];
      list.push({
        side: execution.intent.side, at: execution.accounting?.at ?? execution.at,
        price: execution.accounting?.priceUsd ?? null,
        quantity: execution.accounting?.quantityAtomic ?? execution.intent.quantity ?? null,
      });
      fillsByCase.set(row.position_id, list);
    }
  }
  return {
    items: items.map(({ analysis, hasAnalysis, autoState, autoError, manualState, manualError, autoJobId, manualJobId, ...item }) => ({ ...item, candles: candlesByCase.get(item.caseId) ?? [], fills: fillsByCase.get(item.caseId) ?? [] })),
    page, limit, total, pages: Math.max(1, Math.ceil(total / limit)),
    patterns: [...new Set(visibleWithPattern.map((item) => item.pattern))].sort(),
  };
}

function experienceReplay(engine: Engine, caseId: string) {
  const charts = engine.chartLearning.charts, { db } = charts, mode = env.TRADING_MODE;
  const row = db.prepare(
    `SELECT c.position_id,c.mint,c.mode,c.account_id,c.buy_confirmed_at,c.entry_price_usd,
      c.entry_quantity,c.realized_pnl_pct,c.payload,s.status learningStatus,s.data_quality dataQuality,
      (SELECT a.result FROM chart_case_analyses a WHERE a.case_id=c.position_id ORDER BY a.analyzed_at DESC LIMIT 1) analysis,
      (SELECT r.payload FROM chart_replays r WHERE r.position_id=c.position_id LIMIT 1) replay,
      (SELECT j.state FROM chart_auto_learning_jobs j WHERE j.case_id=c.position_id ORDER BY j.requested_at DESC LIMIT 1) autoState,
      (SELECT j.last_error FROM chart_auto_learning_jobs j WHERE j.case_id=c.position_id ORDER BY j.requested_at DESC LIMIT 1) autoError,
      (SELECT j.state FROM chart_analysis_jobs j WHERE j.case_id=c.position_id ORDER BY j.requested_at DESC LIMIT 1) manualState,
      (SELECT j.error FROM chart_analysis_jobs j WHERE j.case_id=c.position_id ORDER BY j.requested_at DESC LIMIT 1) manualError
     FROM chart_learning_cases c JOIN chart_case_collection s ON s.case_id=c.position_id WHERE c.position_id=? AND c.mode=?`,
  ).get(caseId, mode) as any;
  if (!row || row.account_id !== charts.account(mode)) return { error: "EXPERIENCE_NOT_FOUND" };
  const payload = JSON.parse(String(row.payload));
  const replay = row.replay ? JSON.parse(String(row.replay)) : null;
  const candles = replay?.candles ?? charts.candles(
    String(row.mint), Number(row.buy_confirmed_at) - 3600000,
    Number(payload.closedAt ?? row.buy_confirmed_at) + 3600000,
  );
  const executions = engine.store.executions(mode).filter((execution) =>
    execution.intent.positionId === caseId && execution.state === "CONFIRMED",
  ).map((execution) => ({
    id: execution.id, side: execution.intent.side, at: execution.accounting?.at ?? execution.at,
    price: execution.accounting?.priceUsd ?? null,
    quantity: execution.accounting?.quantityAtomic ?? null,
    fee: execution.accounting?.networkFeeLamports ?? null,
    signature: execution.signature ?? null,
  })).sort((a, b) => a.at - b.at);
  const analysis = row.analysis ? JSON.parse(String(row.analysis)) : null;
  const knowledge = new ChartKnowledgeRepository(db).all(500).filter((item) =>
    item.supportingCaseIds.includes(caseId) || item.contradictoryCaseIds.includes(caseId),
  );
  return {
    experience: {
      caseId, mint: String(row.mint), mode, entryAt: Number(row.buy_confirmed_at),
      closedAt: payload.closedAt ?? null, entryPrice: row.entry_price_usd ?? null,
      pnlPct: row.realized_pnl_pct ?? null, learningStatus: row.learningStatus,
      dataQuality: row.dataQuality, payload,
      pattern: classifyChartPattern(candles as any[]),
      analysisStatus: galleryLearningStatus(row, row.analysis ? JSON.parse(String(row.analysis)) : null),
      analysisError: row.autoError ?? row.manualError ?? null,
    },
    replay: replay ? { ...replay, fills: executions } : null,
    candles, executions, analysis,
    rules: charts.rules().filter((rule) => rule.sourceCaseId === caseId), knowledge,
    evidence: db.prepare(
      `SELECT evidence_id id,evidence_type type,phase,available_at availableAt FROM chart_case_evidence WHERE case_id=? ORDER BY available_at LIMIT 500`,
    ).all(caseId),
    missingReason: !candles.length ? "NO_PERSISTED_CANDLES" : analysis ? null : "ANALYSIS_PENDING_OR_UNAVAILABLE",
  };
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
