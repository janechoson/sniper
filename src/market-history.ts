import { record, numberEvidence } from "./gmgn.js";
import type { Candidate, Market } from "./domain.js";
import {
  normalizeFlowObservation,
  deriveFlow,
  regimeFor,
  type CapitalFlowSummary,
} from "./capital-flow.js";

export interface Candle {
  at: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeUsd: number | null;
}

export interface MarketHistory {
  source: "GMGN_KLINE_1M";
  fetchedAt: number;
  freshness: "FRESH" | "UNKNOWN";
  tokenAge: number | null;
  requestedLookback: number;
  availableHistory: number;
  historyCoverage: number;
  historyStartsAtCreation: boolean;
  historyFrom: number | null;
  historyTo: number | null;
  preCreation: "NOT_AVAILABLE";
  directionalHistory: "UNKNOWN";
  diagnostics: {
    inputRows: number;
    timestampUnit: "SECONDS" | "MILLISECONDS" | "MIXED" | "UNKNOWN";
    rejectedRows: Record<string, number>;
  };
  candles: Candle[];
  status: "AVAILABLE" | "INSUFFICIENT_DATA";
}

const num = (v: unknown) => {
  const e = numberEvidence(v);
  return e.state === "KNOWN" ? e.value : null;
};

export function parseMarketHistory(
  raw: unknown,
  c: Candidate,
  now = Date.now(),
): MarketHistory {
  const envelope = record(raw),
    body = record(envelope.data ?? envelope);
  const from = Math.max(now - 3600000, c.createdAt ?? 0);
  const rows = Array.isArray(body.list) ? body.list : [];
  const byTime = new Map<number, Candle>();
  const timestampUnits = new Set<"SECONDS" | "MILLISECONDS">();
  const rejectedRows: Record<string, number> = {};
  const rejectRow = (reason: string) => {
    rejectedRows[reason] = (rejectedRows[reason] ?? 0) + 1;
  };
  for (const item of rows) {
    const r = record(item),
      timestamp = num(r.time);
    if (timestamp === null) {
      rejectRow("MISSING_TIMESTAMP");
      continue;
    }
    // The live GMGN response uses epoch milliseconds. Also accept legacy
    // seconds, but never multiply an already-millisecond timestamp again.
    const unit = timestamp >= 1_000_000_000_000 ? "MILLISECONDS" : "SECONDS";
    timestampUnits.add(unit);
    const at = unit === "MILLISECONDS" ? timestamp : timestamp * 1000;
    const open = num(r.open),
      high = num(r.high),
      low = num(r.low),
      close = num(r.close);
    if (at < Math.floor(from / 60000) * 60000) {
      rejectRow("BEFORE_REQUESTED_RANGE");
      continue;
    }
    if (at < (c.createdAt ?? 0)) {
      rejectRow("BEFORE_CREATION");
      continue;
    }
    if (at + 60000 > now) {
      rejectRow("UNFINISHED_OR_FUTURE");
      continue;
    }
    if (
      open === null ||
      high === null ||
      low === null ||
      close === null ||
      Math.min(open, low, close) <= 0 ||
      low > Math.min(open, close) ||
      high < Math.max(open, close)
    ) {
      rejectRow("INVALID_OHLC");
      continue;
    }
    // Verified live GMGN K-line payload: volume is USD; amount is token units.
    // Do not use token quantity as dollar volume or substitute it when missing.
    byTime.set(at, { at, open, high, low, close, volumeUsd: num(r.volume) });
  }
  const candles = [...byTime.values()].sort((a, b) => a.at - b.at).slice(-61);
  const availableHistory = candles.reduce(
    (sum, x) =>
      sum + Math.max(0, Math.min(now, x.at + 60000) - Math.max(from, x.at)),
    0,
  );
  const target = Math.max(0, now - from);
  const fetchedAt = num(record(envelope._gmgnSnapshot).fetchedAt);
  return {
    source: "GMGN_KLINE_1M",
    fetchedAt: fetchedAt ?? now,
    freshness: fetchedAt !== null ? "FRESH" : "UNKNOWN",
    tokenAge: c.createdAt ? Math.max(0, now - c.createdAt) : null,
    requestedLookback: 3600000,
    availableHistory,
    historyCoverage: target ? Math.min(1, availableHistory / target) : 0,
    historyStartsAtCreation:
      !!c.createdAt && !!candles[0] && candles[0].at - c.createdAt < 60000,
    historyFrom: candles[0]?.at ?? null,
    historyTo: candles.length ? candles.at(-1)!.at + 60000 : null,
    preCreation: "NOT_AVAILABLE",
    directionalHistory: "UNKNOWN",
    diagnostics: {
      inputRows: rows.length,
      timestampUnit:
        timestampUnits.size === 0
          ? "UNKNOWN"
          : timestampUnits.size === 1
            ? [...timestampUnits][0]!
            : "MIXED",
      rejectedRows,
    },
    candles,
    status: candles.length >= 2 ? "AVAILABLE" : "INSUFFICIENT_DATA",
  };
}

/** One current directional observation plus objective candle context; never manufacture historical buy/sell totals. */
export function attemptFlow(
  c: Candidate,
  market: Market,
  info: unknown,
  h: MarketHistory,
  meaningfulChange: number,
): CapitalFlowSummary {
  const o = normalizeFlowObservation(market, info),
    features = deriveFlow([o]);
  const first = h.candles[0];
  features.priceMomentumPercent =
    first && o.priceUsd !== null ? (o.priceUsd / first.open - 1) * 100 : null;
  const ready =
    o.buyVolumeUsd !== null &&
    o.sellVolumeUsd !== null &&
    o.priceUsd !== null &&
    o.liquidityUsd !== null &&
    h.status === "AVAILABLE";
  return {
    positionId: "attempt:" + c.mint,
    mint: c.mint,
    at: market.at,
    lastMeaningfulAt: market.at,
    regime: ready ? regimeFor(features, meaningfulChange) : "INSUFFICIENT_DATA",
    confidence: ready ? 0.55 : 0,
    window: o.window,
    signalKey: "attempt:" + market.at,
    features,
    transitions: [],
    quality: {
      status: ready ? "READY" : "DEGRADED",
      observations: 1,
      spanMs: h.availableHistory,
      available: Object.keys(o).filter((k) => o[k as keyof typeof o] !== null),
      missing: ["historicalDirectionalVolume", "flowAcceleration"],
      basis:
        "Current GMGN rolling directional volume plus historical OHLCV; directional history UNKNOWN",
      stale: false,
    },
  };
}
