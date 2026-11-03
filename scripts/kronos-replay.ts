// Offline walk-forward smoke replay. No Engine/Store/provider or signing imports.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { KronosWorker, kronosWorkerEnvironment } from "../src/kronos-worker.js";
import {
  KRONOS,
  decideForecast,
  type LabCandle,
} from "../src/kronos-domain.js";
const runtime =
  process.env.KRONOS_RUNTIME ??
  join(process.env.LOCALAPPDATA ?? ".", "gmgn-kronos-runtime");
const worker = new KronosWorker(runtime),
  input = JSON.parse(readFileSync("docs/kronos-replay-input.json", "utf8"));
const rows: LabCandle[] = input.candles;
const probe = spawnSync(
  worker.python,
  ["-I", "-B", "-u", worker.script, "--isolation-probe"],
  {
    cwd: runtime,
    env: kronosWorkerEnvironment(runtime),
    windowsHide: true,
    encoding: "utf8",
    timeout: 15000,
  },
);
if (probe.status !== 0)
  throw Error("ISOLATION_PROBE_FAILED:" + probe.stderr.slice(-300));
const isolation = JSON.parse(probe.stdout);
if (!Object.values(isolation.blocked).every(Boolean))
  throw Error("ISOLATION_BOUNDARY_FAILED");
let open:
  | { price: number; at: number; maximum: number; minimum: number }
  | undefined;
const decisions: unknown[] = [],
  closed: { pnlPct: number; mfePct: number; maePct: number; holdMs: number }[] =
    [],
  latencies: number[] = [];
let buys = 0,
  sells = 0,
  holds = 0,
  waits = 0,
  firstForecast: string | undefined,
  loadMs = 0,
  rssBytes = 0;
try {
  for (let count = KRONOS.minimumCandles; count <= rows.length; count++) {
    const context = rows.slice(Math.max(0, count - 60), count),
      last = context.at(-1)!,
      at = last.at + 60000;
    if (open) {
      open.maximum = Math.max(open.maximum, last.close);
      open.minimum = Math.min(open.minimum, last.close);
    }
    const result = await worker.forecast(context, at);
    loadMs = result.loadMs;
    rssBytes = Math.max(rssBytes, result.rssBytes);
    latencies.push(result.latencyMs);
    if (count === KRONOS.minimumCandles)
      firstForecast = JSON.stringify(result.paths);
    const d = decideForecast(result, context, !!open, at);
    if (d.action === "PAPER_BUY") {
      buys++;
      open = {
        price: last.close,
        at,
        maximum: last.close,
        minimum: last.close,
      };
    } else if (d.action === "PAPER_SELL" && open) {
      sells++;
      closed.push({
        pnlPct: (last.close / open.price - 1) * 100,
        mfePct: (open.maximum / open.price - 1) * 100,
        maePct: (open.minimum / open.price - 1) * 100,
        holdMs: at - open.at,
      });
      open = undefined;
    } else if (d.action === "HOLD") holds++;
    else waits++;
    decisions.push({
      ...d,
      executionPriceProxy: last.close,
      priceProxySource:
        "COMPLETED_M1_CLOSE_AT_DECISION_BOUNDARY_NOT_TOKEN_INFO",
      inputCandles: context.length,
    });
  }
  const same = await worker.forecast(
    rows.slice(0, KRONOS.minimumCandles),
    rows[KRONOS.minimumCandles - 1]!.at + 60000,
  );
  const reproducible = firstForecast === JSON.stringify(same.paths);
  if (!reproducible) throw Error("REPEATED_SEEDED_INFERENCE_DIFFERS");
  const xs = latencies.toSorted((a, b) => a - b),
    values = closed.map((t) => t.pnlPct).toSorted((a, b) => a - b),
    mean = (a: number[]) =>
      a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  const report = {
    kind: "OFFLINE_WALK_FORWARD_TECHNICAL_SMOKE_NOT_PROFITABILITY_VALIDATION",
    inputSource: input.source,
    selection: input.selection,
    policy: KRONOS,
    securityEligibility:
      "NOT_RECONSTRUCTED_AT_EACH_HISTORICAL_POINT; NOT_AN_ELIGIBLE_TOKEN_PERFORMANCE_COHORT",
    priceSemantics:
      "Completed candle-close proxy at decision boundary; not actual post-inference current-price fill",
    inputBars: rows.length,
    inferences: decisions.length,
    buys,
    sells,
    holds,
    waits,
    closedTrades: closed.length,
    wins: closed.filter((x) => x.pnlPct > 0).length,
    losses: closed.filter((x) => x.pnlPct < 0).length,
    winRate: closed.length
      ? closed.filter((x) => x.pnlPct > 0).length / closed.length
      : null,
    averagePnlPct: mean(values),
    medianPnlPct: values.length
      ? (values[Math.floor((values.length - 1) / 2)]! +
          values[Math.floor(values.length / 2)]!) /
        2
      : null,
    totalPaperPnlPct: values.length ? values.reduce((a, b) => a + b, 0) : null,
    averageMfePct: mean(closed.map((x) => x.mfePct)),
    averageMaePct: mean(closed.map((x) => x.maePct)),
    averageHoldMs: mean(closed.map((x) => x.holdMs)),
    openAtEnd: open
      ? {
          ...open,
          unrealizedPnlPct: (rows.at(-1)!.close / open.price - 1) * 100,
        }
      : null,
    baselineCloseProxyBuyHoldPct:
      (rows.at(-1)!.close / rows[KRONOS.minimumCandles - 1]!.close - 1) * 100,
    resource: {
      device: "cpu",
      threads: 2,
      loadMs,
      latencySamples: xs.length,
      p50Ms: xs[Math.floor((xs.length - 1) * 0.5)],
      p95Ms: xs.length >= 20 ? xs[Math.floor((xs.length - 1) * 0.95)] : null,
      rssBytesMaximumObserved: rssBytes,
      gpu: "NOT_USED",
    },
    reproducible,
    isolation,
    closed,
    decisions,
    limitations: [
      ...input.limitations,
      "Single token/short selection, not held-out validation or evidence of superiority",
      "Policy fixed before replay, no tuning on result",
      "No fees/slippage/impact/routes; missing current-price/security historical evidence",
      "Inference uses prefixes only; future timestamps describe forecast targets, no future observed bars passed",
    ],
  };
  writeFileSync(
    "docs/kronos-real-replay-results.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(
    JSON.stringify(
      {
        ...report,
        decisions: report.decisions.length,
        closed: report.closed.length,
      },
      null,
      2,
    ),
  );
} finally {
  worker.stop();
}
