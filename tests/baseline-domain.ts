/** Paper-only contracts. No Engine, signer, wallet or execution imports. */
export const KRONOS = Object.freeze({
  commit: "67b630e67f6a18c9e9be918d9b4337c960db1e9a",
  model: {
    id: "NeoQuasar/Kronos-small",
    revision: "901c26c1332695a2a8f243eb2f37243a37bea320",
  },
  tokenizer: {
    id: "NeoQuasar/Kronos-Tokenizer-base",
    revision: "0e0117387f39004a9016484a186a908917e22426",
  },
  minimumCandles: 32,
  maximumCandles: 60,
  horizon: 5,
  samples: 3,
  maxRecords: 300,
  decisionCap: 720,
  forecastTimeoutMs: 90000,
  inferenceIntervalMs: 60000,
  priceMaxAgeMs: 45000,
  policy: "KRONOS_DIRECTION_V1_UNANIMOUS_TERMINALS",
});
export interface LabCandle {
  at: number;
  open: number;
  high: number;
  low: number;
  close: number;
}
export interface Forecast {
  version: "KRONOS_FORECAST_V1";
  commit: string;
  model: { id: string; revision: string };
  tokenizer: { id: string; revision: string };
  paths: number[][];
  forecastAt: number[];
  inputFrom: number;
  inputTo: number;
  latestClosedCandleAt: number;
  decisionAt: number;
  volumeMode: string;
  seed: number;
  samples: number;
  temperature: number;
  topP: number;
  priceScale: number;
  eval: boolean;
  inferenceMode: boolean;
  loadMs: number;
  latencyMs: number;
  rssBytes: number;
  limitations: string[];
}
export interface LabPrice {
  value: number;
  observedAt: number;
  source: "GMGN_TOKEN_INFO" | "RECONCILED_USD" | "RECONCILED_SOL";
}
export type PaperAction =
  | "WAIT"
  | "PAPER_BUY"
  | "HOLD"
  | "PAPER_SELL"
  | "UNAVAILABLE";
export interface LabDecision {
  at: number;
  inputAt: number;
  action: PaperAction;
  reason: string;
  forecast?: Forecast;
  lastObservedClose?: number;
  terminalRangePct?: [number, number];
}
export interface LabTrial {
  logo?: string | null;
  id: string;
  mint: string;
  symbol?: string;
  name?: string;
  discoveredAt: number;
  appearance: string;
  source: "GMGN_TRENDING";
  createdAt: number;
  updatedAt: number;
  status:
    | "ANALYZING"
    | "WAIT_BUY"
    | "OPEN"
    | "CLOSED"
    | "REJECTED"
    | "ERROR"
    | "SELL_DECIDED_PRICE_PENDING";
  gates: Record<
    string,
    {
      status: "PASS" | "FAIL" | "CHECKING";
      reason?: string;
      at: number;
      evidence?: unknown;
    }
  >;
  evidence?: unknown;
  latest?: LabDecision;
  error?: string;
  entry?: LabPrice;
  exit?: LabPrice;
  current?: LabPrice;
  buyDecisionAt?: number;
  sellDecisionAt?: number;
  maxPrice?: number;
  minPrice?: number;
  pnlPct?: number;
  mfePct?: number;
  maePct?: number;
  outcome?: "WIN" | "LOSS" | "FLAT";
  nextAt: number;
  lastInputTo?: number;
  decisionCount: number;
}
export function validPrice(
  price: LabPrice | undefined,
  now: number,
  after = 0,
): price is LabPrice {
  return (
    !!price &&
    Number.isFinite(price.value) &&
    price.value > 0 &&
    price.observedAt >= after &&
    price.observedAt <= now &&
    now - price.observedAt <= KRONOS.priceMaxAgeMs
  );
}
export function validateCandles(rows: LabCandle[], decisionAt: number) {
  if (
    rows.length < KRONOS.minimumCandles ||
    rows.length > KRONOS.maximumCandles
  )
    throw Error("INSUFFICIENT_KRONOS_HISTORY");
  rows.forEach((c, i) => {
    if (
      !Object.values(c).every(Number.isFinite) ||
      c.at % 60000 ||
      c.at + 60000 > decisionAt ||
      (i > 0 && c.at - rows[i - 1]!.at !== 60000) ||
      c.low <= 0 ||
      c.low > Math.min(c.open, c.close) ||
      c.high < Math.max(c.open, c.close)
    )
      throw Error("INVALID_FUTURE_PARTIAL_OR_GAPPED_CANDLES");
  });
  if (decisionAt - (rows.at(-1)!.at + 60000) > KRONOS.priceMaxAgeMs + 60000)
    throw Error("STALE_MODEL_HISTORY");
}
export function decideForecast(
  f: Forecast,
  rows: LabCandle[],
  open: boolean,
  now: number,
): LabDecision {
  validateCandles(rows, f.decisionAt);
  const last = rows.at(-1)!;
  if (
    f.commit !== KRONOS.commit ||
    f.model.id !== KRONOS.model.id ||
    f.model.revision !== KRONOS.model.revision ||
    f.tokenizer.revision !== KRONOS.tokenizer.revision ||
    !f.eval ||
    !f.inferenceMode ||
    f.inputFrom !== rows[0]!.at ||
    f.inputTo !== last.at + 60000 ||
    f.latestClosedCandleAt !== last.at + 60000 ||
    f.decisionAt > now ||
    now - f.decisionAt > KRONOS.forecastTimeoutMs ||
    f.paths.length !== KRONOS.samples ||
    f.forecastAt.length !== KRONOS.horizon ||
    f.forecastAt.some((at, i) => at !== last.at + 60000 * (i + 1)) ||
    f.paths.some(
      (p) =>
        p.length !== KRONOS.horizon ||
        p.some((x) => !Number.isFinite(x) || x <= 0),
    )
  )
    throw Error("INVALID_OR_STALE_MODEL_RESULT");
  const ends = f.paths.map((p) => (p.at(-1)! / last.close - 1) * 100),
    lo = Math.min(...ends),
    hi = Math.max(...ends);
  return {
    at: now,
    inputAt: f.decisionAt,
    action: open
      ? hi < 0
        ? "PAPER_SELL"
        : "HOLD"
      : lo > 0
        ? "PAPER_BUY"
        : "WAIT",
    reason:
      lo > 0
        ? "ALL_SAMPLED_TERMINALS_HIGHER"
        : hi < 0
          ? "ALL_SAMPLED_TERMINALS_LOWER"
          : "DISAGREEMENT_OR_FLAT_UNCERTAIN",
    forecast: f,
    lastObservedClose: last.close,
    terminalRangePct: [lo, hi],
  };
}
export function markPrice(t: LabTrial, p: LabPrice, now: number) {
  if (!validPrice(p, now, t.entry?.observedAt ?? 0)) return;
  t.current = p;
  if (t.entry) {
    t.maxPrice = Math.max(t.maxPrice ?? t.entry.value, p.value);
    t.minPrice = Math.min(t.minPrice ?? t.entry.value, p.value);
    t.pnlPct = (p.value / t.entry.value - 1) * 100;
    t.mfePct = (t.maxPrice / t.entry.value - 1) * 100;
    t.maePct = (t.minPrice / t.entry.value - 1) * 100;
  }
}
export function paperFill(
  t: LabTrial,
  decision: LabDecision,
  price: LabPrice | undefined,
  now: number,
) {
  if (!["PAPER_BUY", "PAPER_SELL"].includes(decision.action)) return;
  if (!validPrice(price, now, decision.at)) {
    t.error =
      decision.action === "PAPER_BUY"
        ? "BUY_PRICE_UNAVAILABLE"
        : "SELL_DECIDED_PRICE_PENDING";
    t.status =
      decision.action === "PAPER_BUY" ? "ERROR" : "SELL_DECIDED_PRICE_PENDING";
    return;
  }
  if (decision.action === "PAPER_BUY" && !t.entry) {
    t.entry = price;
    t.buyDecisionAt = decision.at;
    t.status = "OPEN";
    markPrice(t, price, now);
  } else if (decision.action === "PAPER_SELL" && t.entry && !t.exit) {
    markPrice(t, price, now);
    t.exit = price;
    t.sellDecisionAt = decision.at;
    t.status = "CLOSED";
    t.outcome = t.pnlPct! > 0 ? "WIN" : t.pnlPct! < 0 ? "LOSS" : "FLAT";
  }
}
