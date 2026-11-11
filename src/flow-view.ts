import type { CandidateState } from "./candidate-lifecycle.js";
import { env, type Settings } from "./config.js";
import type { Execution, FailureStage, Market } from "./domain.js";
import { normalizeMarket } from "./gmgn.js";
import type { Store } from "./store.js";

/** Read-only projection of existing lifecycle, execution and transition records. */
export function flowView(
  store: Store,
  lifecycle: CandidateState[],
  settings: Settings,
  startId: number,
  stages: Map<string, FailureStage>,
  scannerRunning: boolean,
  executions: Execution[] = store.executions(),
) {
  const events = store.db
    .prepare(
      "SELECT id,payload FROM records WHERE kind='pipeline_transitions' AND json_extract(payload,'$.mode')=? AND (?<>'demo' OR scope_account=?) ORDER BY id DESC LIMIT 120",
    )
    .all(env.TRADING_MODE, env.TRADING_MODE, store.demoAccountId())
    .map((r) => ({ id: Number(r.id), ...JSON.parse(String(r.payload)) }))
    .reverse();
  const totals = Object.fromEntries(
    store.db
      .prepare(
        "SELECT json_extract(payload,'$.type') type,count(*) n FROM records WHERE kind='pipeline_transitions' AND id>? AND json_extract(payload,'$.mode')=? AND (?<>'demo' OR scope_account=?) GROUP BY type",
      )
      .all(startId, env.TRADING_MODE, env.TRADING_MODE, store.demoAccountId())
      .map((r) => [String(r.type), Number(r.n)]),
  );
  const cache = new Map<string, Record<string, unknown>>();
  const positions = store.managedPositions(env.TRADING_MODE);
  const buys = executions.filter(
    (e) => e.intent.mode === env.TRADING_MODE && e.intent.side === "BUY",
  );
  const detail = (mint: string) => {
    if (cache.has(mint)) return cache.get(mint)!;
    const c = store.token(mint),
      state = lifecycle.find((r) => r.mint === mint);
    const market =
      store.latest<Market>("market_snapshots", mint) ??
      normalizeMarket(c?.listing ?? {});
    const recent = events.filter((e) => e.mint === mint).at(-1);
    const execution = buys
      .filter(
        (e) =>
          e.intent.mint === mint &&
          !(
            e.state === "FAILED" &&
            state &&
            ["QUALIFIED", "APPROVED", "ANALYZING"].includes(state.state) &&
            e.at < state.lastChecked
          ),
      )
      .at(-1);
    const result = {
      symbol: c?.symbol,
      name: c?.name,
      source: c?.source,
      discovery: c?.discovery,
      entryDiscoverySource: c?.discovery?.sources.includes("TRENDING")
        ? "TRENDING"
        : "SNIPER",
      sniperStructure: (() => {
        const r = store.db
          .prepare(
            "SELECT payload FROM (SELECT payload,0 AS priority FROM entry_structure_watch WHERE mode=? AND mint=? UNION ALL SELECT payload,1 AS priority FROM sniper_structure_watch WHERE mode=? AND mint=?) ORDER BY priority LIMIT 1",
          )
          .get(env.TRADING_MODE, mint, env.TRADING_MODE, mint);
        return r ? JSON.parse(String(r.payload)) : undefined;
      })(),
      capitalFlow: c
        ? (() => {
            const row = store.db
              .prepare("SELECT payload FROM candidate_flow_states WHERE mint=?")
              .get(mint);
            return row ? JSON.parse(String(row.payload)) : undefined;
          })()
        : undefined,
      exitFeasibility: store.latest("exit_feasibility", mint),
      createdAt: c?.createdAt,
      discoveredAt: c?.discoveredAt,
      ...state,
      mint,
      market,
      security: store.latest("security_results", mint),
      holders: store.latest("holder_snapshots", mint),
      tokenExecution: store.latest("token_execution_checks", mint),
      reason:
        (recent?.to === state?.state ? recent?.reason : undefined) ??
        (["DEFERRED", "REJECTED"].includes(state?.state ?? "")
          ? state?.issue?.reasonCode
          : undefined) ??
        store.latest<{ reason: string }>("risk_decisions", mint)?.reason,
      activity: stages.get(mint),
      event: recent,
      buyState: execution?.state,
      buySignature: execution?.signature,
      buyAt: execution?.at,
      positionState: positions
        .filter((p) => p.mint === mint && p.state !== "FAILED")
        .at(-1)?.state,
    };
    cache.set(mint, result);
    return result;
  };
  const queue = lifecycle
    .filter((r) =>
      ["QUEUED", "ANALYZING", "QUALIFIED", "APPROVED"].includes(r.state),
    )
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.lastChecked - b.lastChecked ||
        a.mint.localeCompare(b.mint),
    )
    .slice(0, 10);
  const watch = lifecycle
    .filter((r) => ["WATCH", "STRUCTURE_WATCH"].includes(r.state))
    .sort((a, b) => b.score - a.score);
  const deferred = lifecycle
    .filter((r) => r.state === "DEFERRED")
    .sort((a, b) => b.lastChecked - a.lastChecked);
  const rejected = lifecycle
    .filter((r) => r.state === "REJECTED")
    .sort((a, b) => b.lastChecked - a.lastChecked);
  const recentBuys = [...buys].sort((a, b) => b.at - a.at).slice(0, 6);
  const decisions = [
    ...new Set([
      ...lifecycle
        .filter((r) => ["QUALIFIED", "APPROVED"].includes(r.state))
        .map((r) => r.mint),
      ...recentBuys.map((e) => e.intent.mint),
    ]),
  ].slice(0, 6);
  return {
    version: 1,
    scannerRunning,
    limits: {
      queue: settings.candidateQueueSize,
      watch: settings.watchMaxSize,
      deferred: settings.deferredMaxSize,
    },
    counts: {
      scanned: Number(store.tokenCount()),
      perMinute: Number(
        store.db
          .prepare(
            "SELECT count(*) n FROM records WHERE kind='events' AND json_extract(payload,'$.type')='DISCOVER' AND at>? AND COALESCE(scope_mode,json_extract(payload,'$.mode'),'live')=? AND (?<>'demo' OR scope_account=?)",
          )
          .get(
            Date.now() - 60000,
            env.TRADING_MODE,
            env.TRADING_MODE,
            store.demoAccountId(),
          )!.n,
      ),
      queue: queue.length,
      checking: queue.filter((r) => r.state === "ANALYZING").length,
      watch: watch.length,
      deferred: deferred.length,
      rejected: totals.CANDIDATE_REJECTED ?? 0,
      approved: totals.RISK_APPROVED ?? 0,
      traded: totals.BUY_CONFIRMED ?? 0,
    },
    scanner: store
      .tokens()
      .slice(0, 8)
      .map((c) => detail(c.mint)),
    queue: queue.map((c) => detail(c.mint)),
    watch: watch.slice(0, 6).map((c) => detail(c.mint)),
    deferred: deferred.slice(0, 6).map((c) => detail(c.mint)),
    rejected: rejected.slice(0, 6).map((c) => detail(c.mint)),
    decisions: decisions.map(detail),
    events,
  };
}
