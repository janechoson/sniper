import { env } from "./config.js";
import { positionViews } from "./position-view.js";
import { hasEntryWatchEligibility } from "./sniper-structure.js";
import { currentStructureEvidence } from "./structure-evidence.js";
import { canBypassRecovery } from "./recovery-guard.js";
import { discoveryContext } from "./discovery.js";
/** Same visibility as positionViews().relevant, without hydration/accounting/provider reads. */
export function dashboardPositionCount(store, mode) {
    const row = store.db
        .prepare(`
    SELECT count(*) AS count FROM positions p
    WHERE p.mode = ? AND p.state NOT IN ('CLOSED','FAILED')
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
  `)
        .get(mode);
    return { count: Number(row.count) };
}
export const DASHBOARD_ROUTES = [
    "/",
    "/positions",
    "/history",
    "/memory",
    "/settings",
    "/logs",
    "/thongke",
    "/watchlist",
    "/deferred",
];
export const DASHBOARD_ASSETS = [
    "/dashboard-router.js",
    "/dashboard-core.js",
    "/dashboard-text.js",
    "/dashboard-overview.js",
    "/dashboard-positions.js",
    "/dashboard-position-tools.js",
    "/dashboard-history.js",
    "/dashboard-memory.js",
    "/dashboard-settings.js",
    "/dashboard-logs.js",
    "/dashboard-statistics.js",
    "/dashboard-watch.js",
];
/** Page-specific, read-only projections; never calls the full status/Memory/statistics facade. */
export function dashboardPositions(engine) {
    const { store, settings } = engine;
    const positions = positionViews(store
        .positions(env.TRADING_MODE)
        .filter((p) => !p.dismissal && !["CLOSED", "FAILED"].includes(p.state)), store.executions(), (mint) => store.token(mint))
        .filter((p) => p.relevant)
        .map((p) => ({
        ...p,
        discovery: discoveryContext(store.token(p.mint), Date.now(), settings.trendingFreshMs, engine.discovery.feeds.TRENDING),
    }));
    return {
        positions,
        settings: {
            takeProfits: settings.takeProfits,
            trailingActivationBps: settings.trailingActivationBps,
            trailingStopBps: settings.trailingStopBps,
        },
        jevExit: engine.exitScheduler.status(),
    };
}
export function dashboardLogs(engine, limit) {
    const { store } = engine;
    const rows = (kind) => store.db
        .prepare("SELECT id,mint,at,payload FROM records WHERE kind=? AND (json_extract(payload,'$.mode')=? OR json_extract(payload,'$.mode') IS NULL) ORDER BY id DESC LIMIT ?")
        .all(kind, env.TRADING_MODE, limit);
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
        ...new Set([...events.map((r) => r.mint), ...transitions.map((r) => r.mint)].filter((mint) => typeof mint === "string")),
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
export function dashboardWatch(engine) {
    const rows = engine.structure
        .list()
        .filter(hasEntryWatchEligibility)
        .map((r) => ({
        ...r,
        symbol: engine.store.token(r.mint)?.symbol,
        evidenceCurrent: currentStructureEvidence(r),
        eligibleForEntryWatch: !engine.store.bought(r.mint, env.TRADING_MODE),
        observations: undefined,
        dataFreshMs: 10000,
        recoveryGateMode: canBypassRecovery(r, engine.settings)
            ? "TEMP_RECOVERY_BYPASS"
            : r.status === "PASSED"
                ? "REAL_RECOVERY"
                : "LOCKED",
        progress: {
            selling: !currentStructureEvidence(r)
                ? "PENDING"
                : r.sellingSeen
                    ? "COMPLETE"
                    : r.sellingCount > 0
                        ? "FORMING"
                        : "PENDING",
            absorption: !currentStructureEvidence(r)
                ? "PENDING"
                : r.absorptionDetected
                    ? "COMPLETE"
                    : r.absorptionCount > 0
                        ? "FORMING"
                        : "PENDING",
            support: !currentStructureEvidence(r)
                ? "PENDING"
                : r.supportConfirmed
                    ? "COMPLETE"
                    : (r.supportCount ?? 0) > 0
                        ? "FORMING"
                        : "PENDING",
            recovery: !currentStructureEvidence(r)
                ? "PENDING"
                : r.status === "PASSED"
                    ? "COMPLETE"
                    : r.recoveryCount > 0
                        ? "FORMING"
                        : "PENDING",
        },
    }));
    return { structureWatch: rows };
}
export function dashboardDeferred(engine) {
    const rows = engine.candidates.list();
    return {
        candidatePipeline: {
            queue: rows.filter((r) => ["QUEUED", "ANALYZING", "QUALIFIED", "APPROVED"].includes(r.state)),
            watch: rows.filter((r) => r.state === "WATCH"),
            deferred: rows.filter((r) => r.state === "DEFERRED"),
            capacity: engine.settings.candidateQueueSize,
        },
        faultMetrics: engine.store.get("faultMetrics") ?? {},
    };
}
