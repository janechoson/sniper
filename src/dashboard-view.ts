import { discoveryContext } from "./discovery.js";
import type { Engine } from "./engine.js";
import { env } from "./config.js";
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
] as const;
export const DASHBOARD_ASSETS = [
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
];

/** Page-specific, read-only projections; never calls the full status/Memory/statistics facade. */
export function dashboardPositions(engine: Engine) {
  const { store, settings } = engine;
  const positions = positionViews(
    store
      .positions(env.TRADING_MODE)
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
      .all(
        kind,
        env.TRADING_MODE,
        env.TRADING_MODE,
        store.demoAccountId(),
        limit,
      );
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
    mode: env.TRADING_MODE,
    events,
    flow: { events: transitions },
    overview: { attempt: engine.attempts.current ?? null },
  };
}
