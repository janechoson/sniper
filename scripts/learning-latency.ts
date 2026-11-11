import { performance } from "node:perf_hooks";
import { Store } from "../src/store.js";
import { ChartLearning } from "../src/chart-learning.js";
import { candidate, info, provider } from "../tests/fixtures.js";
import { normalizeMarket } from "../src/gmgn.js";
import { candles } from "../tests/one-shot-fixtures.js";
import { parseMarketHistory } from "../src/market-history.js";
const s = new Store(":memory:"),
  c = new ChartLearning(s, provider().gmgn, {
    status: () => ({
      state: "FIXTURE",
      model: "NO_NETWORK",
      promptVersion: "benchmark",
    }),
    analyze: async () => {
      throw Error("LLM_FORBIDDEN");
    },
  });
try {
  const times: number[] = [];
  const h = parseMarketHistory(candles(60), candidate());
  for (let i = 0; i < 2000; i++) {
    const at = performance.now();
    await c.decide(candidate(), h, normalizeMarket(info()), "demo");
    times.push(performance.now() - at);
  }
  times.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      workload:
        "2000 overlapping closed M1 windows, cold-start guard, SQLite in memory, no network",
      p50: times[1000],
      p95: times[1900],
      p99: times[1980],
      windows: 2000,
    }),
  );
} finally {
  await c.stop();
  s.close();
}
