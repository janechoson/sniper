import { join } from "node:path";
import { homedir } from "node:os";

import { openResearchSession } from "../src/database-session.js";
import { ChartStore } from "../src/chart-store.js";
import { compareWalkForward } from "../src/chart-backtest.js";
import { KronosWorker } from "../src/kronos-worker.js";
import {
  decideForecast,
  validateCandles,
  type Forecast,
} from "../src/kronos-domain.js";
import { kronosForecastSchema } from "../src/kronos-strategy.js";
import { address } from "../src/gmgn.js";

const [mintRaw, fromRaw, toRaw] = process.argv.slice(2);
const session = openResearchSession(),
  store = session.store,
  charts = new ChartStore(store);
const worker = new KronosWorker(
  join(
    process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
    "gmgn-kronos-runtime",
  ),
);
try {
  const recent =
    mintRaw === "--recent-trade"
      ? store.db
          .prepare("SELECT payload FROM chart_replays ORDER BY at DESC LIMIT 1")
          .get()
      : undefined;
  const replay = recent ? JSON.parse(String(recent.payload)) : null;
  if (!replay && (!mintRaw || !fromRaw || !toRaw))
    throw Error(
      "Usage: learning:replay <mint> <from epoch ms> <to epoch ms; max 120m>, or --recent-trade",
    );
  const mint = address(replay?.mint ?? mintRaw),
    from = replay ? Math.ceil(replay.entryAt / 60000) * 60000 : Number(fromRaw),
    to = replay
      ? Math.min(from + 3 * 60000, Math.floor(replay.closedAt / 60000) * 60000)
      : Number(toRaw);
  const report = await compareWalkForward(
    charts,
    mint,
    from,
    to,
    {
      initialCapitalUsd: 100,
      positionSizeUsd: 1,
      feePerFillUsd: 0.01,
      slippageBps: 100,
    },
    async (candles, at) => {
      const rows = candles.map(({ at, open, high, low, close }) => ({
        at,
        open,
        high,
        low,
        close,
      }));
      validateCandles(rows, at);
      const output = kronosForecastSchema.parse(
        await worker.forecast(rows, at),
      ) as Forecast;
      const entry = decideForecast(output, rows, false, at),
        exit = decideForecast(output, rows, true, at);
      if (entry.action === "UNAVAILABLE" || exit.action === "UNAVAILABLE")
        throw Error("REPLAY_INFERENCE_UNAVAILABLE");
      return {
        entry: entry.action === "PAPER_BUY" ? "BUY" : "WAIT",
        exit: exit.action === "PAPER_SELL" ? "SELL" : "HOLD",
      };
    },
  );
  console.log(
    JSON.stringify(
      {
        id: report.id,
        kind: report.kind,
        observedSteps: report.trace.length,
        executionModel: report.executionModel,
        outcomes: report.outcomes.map(({ trades, equity, ...metrics }) => ({
          ...metrics,
          trades: trades.length,
          equityObservations: equity.length,
        })),
        limitations: report.limitations,
      },
      null,
      2,
    ),
  );
} finally {
  worker.stop();
  session.close();
}
