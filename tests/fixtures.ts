import type { Candidate } from "../src/domain.js";
import { KRONOS, type LabCandle, type Forecast } from "../src/kronos-domain.js";
import { KronosStore } from "../src/kronos-store.js";
import { KronosLab, type LabInference } from "../src/kronos-lab.js";
import type { LabMarket } from "../src/kronos-market.js";
export const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export function candidate(): Candidate {
  const now = Date.now();
  return {
    mint: MINT,
    symbol: "NEW",
    source: "gmgn:trending",
    discoveredAt: now,
    createdAt: now - 3600000,
    discovery: {
      sources: ["TRENDING"],
      firstSeenAt: now,
      lastSeenAt: now,
      trending: {
        firstSeenAt: now,
        lastSeenAt: now,
        sequenceStartedAt: now,
        consecutiveObservations: 1,
        basis: "fixture",
        history: [],
        movement: "UNKNOWN",
      },
    },
  };
}
export function bars(
  tail = Math.floor(Date.now() / 60000) * 60000,
): LabCandle[] {
  return Array.from({ length: 40 }, (_, i) => ({
    at: tail - (40 - i) * 60000,
    open: 1,
    high: 1.02,
    low: 0.98,
    close: 1,
  }));
}
export function forecast(
  rows: LabCandle[],
  at: number,
  direction = 1,
): Forecast {
  const end = rows.at(-1)!.at + 60000;
  return {
    version: "KRONOS_FORECAST_V1",
    commit: KRONOS.commit,
    model: KRONOS.model,
    tokenizer: KRONOS.tokenizer,
    paths: Array.from({ length: 3 }, () =>
      Array.from({ length: 5 }, (_, i) => 1 + direction * (i + 1) * 0.001),
    ),
    forecastAt: Array.from({ length: 5 }, (_, i) => end + i * 60000),
    inputFrom: rows[0]!.at,
    inputTo: end,
    latestClosedCandleAt: end,
    decisionAt: at,
    volumeMode: "PRICE_ONLY_OPTIONAL_CHANNELS_DISABLED",
    priceScale: 1,
    seed: 1701,
    samples: 3,
    temperature: 1,
    topP: 0.9,
    eval: true,
    inferenceMode: true,
    loadMs: 1,
    latencyMs: 1,
    rssBytes: 1,
    limitations: [],
  };
}
export function fixture(path = ":memory:") {
  const store = new KronosStore(path);
  let direction = 1,
    price: number | undefined = 1,
    fail = false,
    calls = 0;
  const market: LabMarket = {
    discover: async () => [candidate()],
    prepare: async (_c, stage) => {
      for (const n of [
        "CHEAP_FILTER",
        "SECURITY",
        "COMPATIBILITY",
        "HISTORY",
        "CAPITAL_FLOW",
      ])
        await stage(n, async () => ({ fixture: true }));
      return { candles: bars(), evidence: { structureNotRequired: true } };
    },
    history: async () => ({ candles: bars(), evidence: {} }),
    price: async () =>
      price === undefined
        ? undefined
        : { value: price, observedAt: Date.now(), source: "GMGN_TOKEN_INFO" },
  };
  const inference: LabInference = {
    forecast: async (rows, at) => {
      calls++;
      if (fail) throw Error("KRONOS_TIMEOUT");
      return forecast(rows, at, direction);
    },
    stop() {},
    status: () => ({}),
  };
  const lab = new KronosLab(store, market, inference);
  return {
    store,
    market,
    inference,
    lab,
    calls: () => calls,
    set(v: { direction?: number; price?: number | null; fail?: boolean }) {
      direction = v.direction ?? direction;
      price = v.price === null ? undefined : (v.price ?? price);
      fail = v.fail ?? fail;
    },
    fresh() {
      const t = store.trials()[0]!;
      delete t.lastInputTo;
      t.nextAt = 0;
      store.save(t);
    },
  };
}
