import type { Market } from "./domain.js";
import { numberEvidence, record } from "./gmgn.js";
export type FlowRegime =
  | "STRONG_INFLOW"
  | "INFLOW_ACCELERATING"
  | "HEALTHY_EXPANSION"
  | "INFLOW_DECELERATING"
  | "NEUTRAL"
  | "DISTRIBUTION"
  | "OUTFLOW"
  | "OUTFLOW_ACCELERATING"
  | "INSUFFICIENT_DATA";
export interface FlowObservation {
  provenance?: {
    provider: "GMGN";
    mint: string;
    source: string;
    observedAt: number;
    semantics: "WINDOW_TOTAL_SNAPSHOT";
  };
  at: number;
  window: string;
  priceUsd: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  volumeUsd: number | null;
  buyVolumeUsd: number | null;
  sellVolumeUsd: number | null;
  buys: number | null;
  sells: number | null;
  holders: number | null;
  smartWallets: number | null;
  smartMoneyBuyUsd: number | null;
  smartMoneySellUsd: number | null;
  largeBuyUsd: number | null;
  largeSellUsd: number | null;
}
export interface FlowFeatures {
  netFlowUsd: number | null;
  buySellVolumeRatio: number | null;
  buyPressure: number | null;
  volumeChangePercent: number | null;
  volumeSlopeUsdPerMinute: number | null;
  volumeAccelerationUsdPerMinute2: number | null;
  buyVolumeChangePercent: number | null;
  sellVolumeChangePercent: number | null;
  netFlowChangeUsd: number | null;
  netFlowSlopeUsdPerMinute: number | null;
  netFlowAccelerationUsdPerMinute2: number | null;
  liquidityChangePercent: number | null;
  holderGrowthPercent: number | null;
  smartWalletCountChange: number | null;
  smartMoneyNetFlowUsd: number | null;
  largeTradeImbalanceUsd: number | null;
  priceMomentumPercent: number | null;
  momentumAccelerationPointsPerMinute2: number | null;
  peakRetracementPercent: number | null;
}
export interface FlowTransition {
  at: number;
  from: FlowRegime;
  to: FlowRegime;
  confidence: number;
  reason: string;
}
export interface CapitalFlowSummary {
  lookbacks?: Record<
    string,
    {
      fromAt: number;
      toAt: number;
      actualElapsedMs: number;
      priceChangePercent: number | null;
      volumeChangePercent: number | null;
      netFlowChangeUsd: number | null;
    } | null
  >;
  positionId: string;
  mint: string;
  regime: FlowRegime;
  confidence: number;
  window: string;
  at: number;
  lastMeaningfulAt: number;
  signalKey: string;
  features: FlowFeatures;
  transitions: FlowTransition[];
  quality: {
    status: "READY" | "WARMING_UP" | "DEGRADED";
    observations: number;
    spanMs: number;
    available: string[];
    missing: string[];
    basis: string;
    stale: boolean;
  };
}
export interface CapitalFlowState extends CapitalFlowSummary {
  observations: FlowObservation[];
  pendingRegime?: { regime: FlowRegime; count: number };
}
const value = (v: unknown): number | null => {
  const e = record(v);
  return e.state === "KNOWN" &&
    typeof e.value === "number" &&
    Number.isFinite(e.value) &&
    e.value >= 0
    ? e.value
    : null;
};
const rawNumber = (v: unknown) => value(numberEvidence(v));
const subtract = (a: number | null, b: number | null) =>
  a === null || b === null ? null : a - b;
const percent = (a: number | null, b: number | null) =>
  a === null || b === null || b === 0 ? null : 100 * (a / b - 1);
const finite = (n: number | null) =>
  n !== null && Number.isFinite(n) ? n : null;
const windows = ["1m", "5m", "1h", "6h", "24h"];
/** GMGN directional trade volume is USD over a rolling window, NOT on-chain capital deposits. */
export function normalizeFlowObservation(
  market: Market,
  info: unknown,
  at = market.at,
): FlowObservation {
  const candidates = windows.map((window) => ({
    window,
    data: record(market.windows[window]),
  }));
  const selected = candidates.find(
    (x) =>
      value(x.data.buyVolume) !== null && value(x.data.sellVolume) !== null,
  ) ??
    candidates.find(
      (x) => value(x.data.buys) !== null && value(x.data.sells) !== null,
    ) ??
    candidates.find((x) => value(x.data.volume) !== null) ?? {
      window: "24h",
      data: { volume: market.volume, buys: market.buys, sells: market.sells },
    };
  const data = selected.data,
    raw = record(info);
  const meta = record(raw._gmgnSnapshot);
  const provenance: FlowObservation["provenance"] =
    meta.provider === "GMGN" &&
    meta.freshness === "FRESH" &&
    meta.fetchedAt === at &&
    typeof meta.source === "string" &&
    meta.source.length > 0 &&
    typeof raw.address === "string"
      ? {
          provider: "GMGN",
          mint: raw.address,
          source: meta.source.slice(0, 128),
          observedAt: at,
          semantics: "WINDOW_TOTAL_SNAPSHOT",
        }
      : undefined;
  return {
    ...(provenance ? { provenance } : {}),
    at,
    window: selected.window,
    priceUsd: value(market.price),
    marketCapUsd: value(market.marketCap),
    liquidityUsd: value(market.liquidity),
    volumeUsd: value(data.volume),
    buyVolumeUsd: value(data.buyVolume),
    sellVolumeUsd: value(data.sellVolume),
    buys: value(data.buys),
    sells: value(data.sells),
    holders: rawNumber(raw.holder_count),
    smartWallets: rawNumber(record(raw.wallet_tags_stat).smart_wallets),
    smartMoneyBuyUsd: null,
    smartMoneySellUsd: null,
    largeBuyUsd: null,
    largeSellUsd: null,
  };
}
export function deriveFlow(
  observations: FlowObservation[],
  peakRetracementPercent: number | null = null,
): FlowFeatures {
  const c = observations.at(-1)!;
  const same = observations.filter((x) => x.window === c.window),
    b = same.at(-2),
    a = same.at(-3);
  const dt = b ? (c.at - b.at) / 60000 : 0,
    previousDt = a && b ? (b.at - a.at) / 60000 : 0;
  const net = (o: FlowObservation) => subtract(o.buyVolumeUsd, o.sellVolumeUsd);
  const slope = (x: number | null, y: number | null, minutes: number) =>
    x === null || y === null || minutes <= 0 ? null : finite((x - y) / minutes);
  const acceleration = (field: (o: FlowObservation) => number | null) =>
    a && b && dt > 0 && previousDt > 0
      ? slope(
          slope(field(c), field(b), dt),
          slope(field(b), field(a), previousDt),
          (dt + previousDt) / 2,
        )
      : null;
  const pressure =
    c.buyVolumeUsd !== null && c.sellVolumeUsd !== null
      ? c.buyVolumeUsd + c.sellVolumeUsd > 0
        ? c.buyVolumeUsd / (c.buyVolumeUsd + c.sellVolumeUsd)
        : null
      : c.buys !== null && c.sells !== null && c.buys + c.sells > 0
        ? c.buys / (c.buys + c.sells)
        : null;
  const features: FlowFeatures = {
    netFlowUsd: net(c),
    buySellVolumeRatio:
      c.buyVolumeUsd !== null && c.sellVolumeUsd !== null && c.sellVolumeUsd > 0
        ? c.buyVolumeUsd / c.sellVolumeUsd
        : null,
    buyPressure: pressure,
    volumeChangePercent: b ? percent(c.volumeUsd, b.volumeUsd) : null,
    volumeSlopeUsdPerMinute: b ? slope(c.volumeUsd, b.volumeUsd, dt) : null,
    volumeAccelerationUsdPerMinute2: acceleration((o) => o.volumeUsd),
    buyVolumeChangePercent: b ? percent(c.buyVolumeUsd, b.buyVolumeUsd) : null,
    sellVolumeChangePercent: b
      ? percent(c.sellVolumeUsd, b.sellVolumeUsd)
      : null,
    netFlowChangeUsd: b ? subtract(net(c), net(b)) : null,
    netFlowSlopeUsdPerMinute: b ? slope(net(c), net(b), dt) : null,
    netFlowAccelerationUsdPerMinute2: acceleration(net),
    liquidityChangePercent: b ? percent(c.liquidityUsd, b.liquidityUsd) : null,
    holderGrowthPercent: b ? percent(c.holders, b.holders) : null,
    smartWalletCountChange: b ? subtract(c.smartWallets, b.smartWallets) : null,
    smartMoneyNetFlowUsd: subtract(c.smartMoneyBuyUsd, c.smartMoneySellUsd),
    largeTradeImbalanceUsd: subtract(c.largeBuyUsd, c.largeSellUsd),
    priceMomentumPercent: b ? percent(c.priceUsd, b.priceUsd) : null,
    momentumAccelerationPointsPerMinute2:
      a && b && dt > 0 && previousDt > 0
        ? slope(
            slope(percent(c.priceUsd, b.priceUsd), 0, dt),
            slope(percent(b.priceUsd, a.priceUsd), 0, previousDt),
            (dt + previousDt) / 2,
          )
        : null,
    peakRetracementPercent,
  };
  return Object.fromEntries(
    Object.entries(features).map(([k, v]) => [k, finite(v)]),
  ) as unknown as FlowFeatures;
}
export function regimeFor(f: FlowFeatures, minimumChange: number): FlowRegime {
  const n = f.netFlowUsd,
    p = f.buyPressure,
    delta = f.netFlowChangeUsd,
    acc = f.netFlowAccelerationUsdPerMinute2;
  const relative =
    delta === null || n === null
      ? null
      : (100 * delta) / Math.max(Math.abs(n - delta), 1);
  if (n === null) {
    if (p === null) return "INSUFFICIENT_DATA";
    if (
      (f.priceMomentumPercent ?? 0) > 0 &&
      (f.volumeChangePercent ?? 0) >= minimumChange &&
      p >= 0.6 &&
      (f.liquidityChangePercent ?? -100) >= -5
    )
      return "HEALTHY_EXPANSION";
    return "NEUTRAL";
  }
  if (n < 0) {
    if ((relative ?? 0) <= -minimumChange && (acc ?? 0) < 0)
      return "OUTFLOW_ACCELERATING";
    return (f.priceMomentumPercent ?? -1) >= 0 && (p ?? 1) < 0.45
      ? "DISTRIBUTION"
      : "OUTFLOW";
  }
  if (n === 0) return "NEUTRAL";
  if ((relative ?? 0) <= -minimumChange)
    return (f.priceMomentumPercent ?? -1) >= 0 && (p ?? 1) < 0.55
      ? "DISTRIBUTION"
      : "INFLOW_DECELERATING";
  if ((relative ?? 0) >= minimumChange && (acc ?? 0) > 0 && (p ?? 0) >= 0.55)
    return "INFLOW_ACCELERATING";
  if (
    (f.priceMomentumPercent ?? 0) > 0 &&
    (f.volumeChangePercent ?? 0) >= minimumChange &&
    (p ?? 0) >= 0.6 &&
    (f.liquidityChangePercent ?? -100) >= -5
  )
    return "HEALTHY_EXPANSION";
  return (p ?? 0) >= 0.65 ? "STRONG_INFLOW" : "NEUTRAL";
}
