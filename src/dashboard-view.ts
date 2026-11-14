import { discoveryContext } from "./discovery.js";
import type { Engine } from "./engine.js";

import { positionViews } from "./position-view.js";
import type { Store } from "./store.js";
import type { Mode } from "./domain.js";

/** Same visibility as positionViews().relevant, without hydration/accounting/provider reads. */
export function dashboardPositionCount(store: Pick<Store, "db">, mode: Mode) {
  const row = store.db
    .prepare(
      `
    SELECT count(*) AS count FROM positions p
    WHERE p.mode = ? AND p.state NOT IN ('CLOSED','FAILED')
      AND (?<>'demo' OR json_extract(p.payload,'$.demoAccountId')=?)
      AND json_extract(p.payload,'$.dismissal') IS NULL
      AND (
        CAST(json_extract(p.payload,'$.quantity') AS INTEGER) > 0
        OR json_extract(p.payload,'$.attention.status') = 'UNKNOWN'
        OR EXISTS (
          SELECT 1 FROM executions e
          WHERE json_extract(e.payload,'$.intent.positionId') = p.id
            AND e.signature IS NOT NULL AND e.signature <> ''
            AND e.state IN ('SUBMITTED','PENDING_CONFIRMATION','UNKNOWN','AMBIGUOUS')
        )
      )
  `,
    )
    .get(
      mode,
      mode,
      store.db
        .prepare("SELECT id FROM demo_accounts WHERE archived_at IS NULL")
        .get()?.id ?? "",
    )!;
  return { count: Number(row.count) };
}

export const DASHBOARD_ROUTES = [
  "/",
  "/positions",
  "/history",
  "/settings",
  "/logs",
  "/thongke",
  "/kronos",
  "/chart-learning",
] as const;
export const DASHBOARD_ASSETS = [
  "/rug-killer-neon.png",
  "/dashboard-router.js",
  "/dashboard-mode.js",
  "/dashboard-core.js",
  "/dashboard-text.js",
  "/dashboard-overview.js",
  "/dashboard-positions.js",
  "/dashboard-position-tools.js",
  "/dashboard-history.js",
  "/dashboard-settings.js",
  "/dashboard-logs.js",
  "/dashboard-statistics.js",
  "/dashboard-kronos.js",
  "/dashboard-learning.js",
  "/dashboard-gallery.js",
];

/** Page-specific, read-only projections; never calls the full status/Memory/statistics facade. */
export function dashboardPositions(engine: Engine) {
  const { store, settings } = engine;
  const positions = positionViews(
    store
      .positions(store.mode)
      .filter((p) => !p.dismissal && !["CLOSED", "FAILED"].includes(p.state)),
    store.executions(),
    (mint) => store.token(mint),
  )
    .filter((p) => p.relevant)
    .map((p) => ({
      ...p,
      discovery: discoveryContext(
        store.token(p.mint),
        Date.now(),
        settings.trendingFreshMs,
        engine.discovery.feeds.TRENDING,
      ),
    }));
  return {
    positions,
  };
}
export function dashboardLogs(engine: Engine, limit: number) {
  const { store } = engine;
  const rows = (kind: string) =>
    store.db
      .prepare(
        "SELECT id,mint,at,payload FROM records WHERE kind=? AND COALESCE(scope_mode,json_extract(payload,'$.mode'),'live')=? AND (?<>'demo' OR scope_account=?) ORDER BY id DESC LIMIT ?",
      )
      .all(kind, store.mode, store.mode, store.demoAccountId(), limit);
  const events = rows("events")
    .map((r) => ({
      id: r.id,
      mint: r.mint,
      at: r.at,
      payload: JSON.parse(String(r.payload)),
    }))
    .reverse();
  const transitions = rows("pipeline_transitions")
    .map((r) => ({ id: r.id, ...JSON.parse(String(r.payload)) }))
    .reverse();
  const mints = [
    ...new Set(
      [...events.map((r) => r.mint), ...transitions.map((r) => r.mint)].filter(
        (mint): mint is string => typeof mint === "string",
      ),
    ),
  ].slice(0, 250);
  const tokens = mints.flatMap((mint) => {
    const token = store.token(mint);
    return token
      ? [{ mint, symbol: token.symbol, name: token.name, logo: token.logo }]
      : [];
  });
  return {
    tokens,
    mode: store.mode,
    events,
    flow: { events: transitions },
    overview: { attempt: engine.attempts.current ?? null },
  };
}

/** Read-only KRONOS call and entry outcome projection for the current mode/account. */
export function dashboardKronos(engine: Engine, range: "all" | "24h" | "7d") {
  const { store } = engine;
  const now = Date.now();
  const since = range === "24h" ? now - 24 * 60 * 60 * 1000 : range === "7d" ? now - 7 * 24 * 60 * 60 * 1000 : null;
  const scope = `COALESCE(scope_mode,json_extract(payload,'$.mode'),'live')=? AND (?<>'demo' OR scope_account=?)`;
  const scopeArgs = [store.mode, store.mode, store.demoAccountId()];
  const timeClause = since === null ? "" : " AND at>=?";
  const args = since === null ? scopeArgs : [...scopeArgs, since];
  const countRecords = (kind: string, types: string[]) => {
    const typeClause = types.map(() => "json_extract(payload,'$.type')=?").join(" OR ");
    const row = store.db.prepare(
      `SELECT count(*) AS n FROM records WHERE kind=? AND ${scope}${timeClause} AND (${typeClause})`,
    ).get(kind, ...args, ...types) as { n: number };
    return Number(row.n);
  };
  const decisionRows = store.db.prepare(
    `SELECT json_extract(payload,'$.action') AS action,count(*) AS n FROM records WHERE kind='kronos_decisions' AND ${scope}${timeClause} GROUP BY action`,
  ).all(...args) as Array<{ action: string | null; n: number }>;
  const decisions = Object.fromEntries(decisionRows.map((row) => [row.action ?? "UNKNOWN", Number(row.n)]));
  const candidateTime = since === null ? "" : " AND started_at>=?";
  const candidateArgs: Array<string | number> = since === null ? [store.mode] : [store.mode, since];
  const accountClause = store.mode === "demo" ? " AND json_extract(payload,'$.demoAccountId')=?" : "";
  if (store.mode === "demo") candidateArgs.push(store.demoAccountId());
  const entry = store.db.prepare(
    `SELECT result,count(*) AS n FROM candidate_attempts WHERE mode=?${candidateTime}${accountClause} AND json_extract(payload,'$.summaries.strategies.KRONOS.decision')='BUY' GROUP BY result`,
  ).all(...candidateArgs) as Array<{ result: string; n: number }>;
  const outcomes = Object.fromEntries(entry.map((row) => [row.result, Number(row.n)]));
  const outcomeCount = Object.values(outcomes).reduce((sum, value) => sum + value, 0);
  const attemptTotal = Number((store.db.prepare(
    `SELECT count(*) AS n FROM candidate_attempts WHERE mode=?${candidateTime}${accountClause}`,
  ).get(...candidateArgs) as { n: number }).n);
  const recent = store.db.prepare(
    `SELECT mint,at,payload FROM records WHERE kind='kronos_decisions' AND ${scope}${timeClause} ORDER BY id DESC LIMIT 50`,
  ).all(...args) as Array<{ mint: string; at: number; payload: string }>;
  const latest = recent.map((row) => {
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    const token = store.token(row.mint);
    return {
      at: Number(row.at),
      symbol: token?.symbol ?? row.mint.slice(0, 8) + "…",
      action: typeof payload.action === "string" ? payload.action : "UNKNOWN",
      reason: typeof payload.reason === "string" ? payload.reason : "",
      attemptId: typeof payload.attemptId === "string" ? payload.attemptId : null,
    };
  });
  const countDistinctTransitions = (type: string, expression: string) => {
    const row = store.db.prepare(
      `SELECT count(DISTINCT ${expression}) AS n FROM records WHERE kind='pipeline_transitions' AND ${scope}${timeClause} AND json_extract(payload,'$.type')=?`,
    ).get(...args, type) as { n: number };
    return Number(row.n);
  };
  // Older builds wrote two start markers per entry attempt; count unique attempt IDs.
  const entryCalls = countDistinctTransitions("KRONOS_EVALUATION_STARTED", "json_extract(payload,'$.attemptId')");
  const positionCalls = countDistinctTransitions("KRONOS_POSITION_EVALUATION", "json_extract(payload,'$.positionId') || ':' || json_extract(payload,'$.inputTo')");
  const totalCalls = entryCalls + positionCalls;
  const inferenceErrors = countRecords("pipeline_transitions", ["KRONOS_INFERENCE_FAILED"]);
  const decisionTotal = Object.values(decisions).reduce((sum, value) => sum + value, 0);
  return {
    mode: store.mode,
    range,
    since,
    calls: { total: totalCalls, entry: entryCalls, position: positionCalls, withoutRecordedOutcome: totalCalls - decisionTotal - inferenceErrors },
    decisions: {
      buy: decisions.BUY ?? 0,
      wait: decisions.WAIT ?? 0,
      hold: decisions.HOLD ?? 0,
      sell: decisions.SELL ?? 0,
      errors: inferenceErrors,
    },
    buyOutcomes: {
      attempts: outcomeCount,
      bought: outcomes.BOUGHT ?? 0,
      rejectedAfterBuy: outcomes.REJECTED ?? 0,
      reconciling: outcomes.RECONCILING ?? 0,
      running: outcomes.RUNNING ?? 0,
      retainedCandidateAttempts: attemptTotal,
      retentionLimit: 2000,
    },
    latest,
    updatedAt: now,
  };
}
