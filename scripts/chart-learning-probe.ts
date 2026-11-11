import { openResearchSession } from "../src/database-session.js";
import { ChartStore } from "../src/chart-store.js";
import { CodexRuntime, reasoningSchema } from "../src/codex-runtime.js";
import { chartId } from "../src/chart-store.js";

// One bounded real analysis of existing market evidence. No discovery or executor.
const session = openResearchSession(),
  store = session.store,
  charts = new ChartStore(store),
  runtime = new CodexRuntime();
try {
  const mode =
    store.get<"DEMO" | "LIVE">("selectedTradingMode") === "LIVE"
      ? "live"
      : "demo";
  const tradeMode = process.argv[2] === "--trade";
  const replayRow = tradeMode
    ? session.learning
        .prepare("SELECT payload FROM chart_replays ORDER BY at DESC LIMIT 1")
        .get()
    : undefined;
  const replay = replayRow ? JSON.parse(String(replayRow.payload)) : null;
  if (tradeMode && !replay) throw Error("NO_PERSISTED_TRADE_REPLAY");
  const events = charts
    .events(100)
    .filter((e) => e.kind !== "CONTROL" && (!replay || e.mint === replay.mint))
    .slice(0, 8);
  const event = events[0];
  if (!event && !tradeMode) throw Error("NO_PERSISTED_EVENT_FOR_PROBE");
  const input = replay
    ? {
        task: "TRADE_REVIEW",
        positionId: replay.positionId,
        accountId: replay.accountId,
        entryAt: replay.entryAt,
        closedAt: replay.closedAt,
        accounting: replay.accounting,
        candles: replay.candles,
        candidates: replay.candidates,
        fills: replay.fills.map(
          (f: {
            label: string;
            at: number;
            price: string | null;
            source: string;
            executionId: string;
          }) => ({
            label: f.label,
            at: f.at,
            price: f.price,
            source: f.source,
            executionId: f.executionId,
          }),
        ),
        events,
      }
    : { event, policy: "connectivity-and-evidence-review" };
  const id = charts.job(
    tradeMode ? "TRADE_REVIEW" : "RUNTIME_PROBE",
    replay?.positionId ?? event!.id,
    input,
    replay?.mode ?? mode,
  );
  const row = session.learning
    .prepare("SELECT state FROM chart_jobs WHERE id=?")
    .get(id);
  if (row?.state === "COMPLETED") {
    console.log("Existing real analysis already persisted: " + id);
  } else {
    if (row?.state === "RUNNING") throw Error("ANALYSIS_ALREADY_RUNNING");
    session.learning
      .prepare(
        "UPDATE chart_jobs SET state='RUNNING',attempts=attempts+1 WHERE id=? AND state<>'RUNNING'",
      )
      .run(id);
    try {
      const result = reasoningSchema.parse(
        await runtime.analyze({
          task: "Review these actual market/trade observations using only the supplied facts. Return REVIEW. Cover entry and exit reasons, lateness, causal better candidates, reversal warnings, protected profit, failed assumptions and uncertainty. Proposed hypotheses are unvalidated only; this command cannot authorize trades.",
          evidence: input,
        }),
      );
      if (
        result.action !== "REVIEW" ||
        [...result.supportingEventIds, ...result.contradictoryEventIds].some(
          (x) => !events.some((e) => e.id === x),
        )
      )
        throw Error("PROBE_INVALID_EVIDENCE");
      if (tradeMode && result.hypothesis && result.supportingEventIds.length) {
        const h = result.hypothesis,
          ruleId =
            "LR-" + chartId(h.behaviors, h.window, h.action).slice(0, 16);
        if (!charts.rules().some((r) => r.id === ruleId))
          charts.saveRule({
            id: ruleId,
            version: 1,
            at: Date.now(),
            status: "DRAFT",
            name: h.name,
            description: h.description,
            behaviors: h.behaviors,
            window: Number(h.window),
            action: h.action,
            invalidation: h.invalidation,
            supportingEventIds: result.supportingEventIds,
            contradictoryEventIds: result.contradictoryEventIds,
          });
      }
      session.learning
        .prepare(
          "UPDATE chart_jobs SET state='COMPLETED',result=?,error=NULL WHERE id=?",
        )
        .run(
          JSON.stringify({
            analysis: result,
            runtime: runtime.status(),
            at: Date.now(),
          }),
          id,
        );
      console.log(
        JSON.stringify({
          jobId: id,
          eventId: event?.id ?? null,
          positionId: replay?.positionId ?? null,
          state: "COMPLETED",
          runtime: runtime.status(),
        }),
      );
    } catch (e) {
      session.learning
        .prepare("UPDATE chart_jobs SET state='FAILED',error=? WHERE id=?")
        .run(e instanceof Error ? e.message : "PROBE_FAILED", id);
      throw e;
    }
  }
} finally {
  session.close();
}
