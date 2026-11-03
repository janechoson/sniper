import type { Store } from "./store.js";
import type { Settings } from "./config.js";
import type { Market, Position, Mode } from "./domain.js";
import { numberEvidence, record } from "./gmgn.js";
import { hash } from "./util.js";

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
const bucket = (v: number | null) =>
  v === null ? null : Math.sign(v) * Math.round(Math.log1p(Math.abs(v)) * 10);
export function evolveFlow(
  previous: CapitalFlowState | undefined,
  positionId: string,
  mint: string,
  observation: FlowObservation,
  s: Settings,
  retracement: number | null = null,
): CapitalFlowState {
  const observations = [
    ...(previous?.observations ?? []).filter(
      (x) => x.at < observation.at && observation.at - x.at <= s.flowHistoryMs,
    ),
    observation,
  ].slice(-s.flowMaxObservations);
  const features = deriveFlow(observations, retracement),
    same = observations.filter((x) => x.window === observation.window),
    spanMs = same.at(-1)!.at - same[0]!.at;
  const fields = Object.entries(observation).filter(
    ([k]) => !["at", "window", "provenance"].includes(k),
  );
  const available = fields.filter(([, v]) => v !== null).map(([k]) => k),
    missing = fields.filter(([, v]) => v === null).map(([k]) => k);
  const ready =
    same.length >= s.flowMinObservations && spanMs >= s.flowMinSpanMs;
  let confidence = Math.min(
    0.95,
    (available.length / fields.length) * 0.35 +
      Math.min(1, same.length / s.flowMinObservations) * 0.35 +
      Math.min(1, spanMs / Math.max(1, s.flowMinSpanMs)) * 0.25,
  );
  if (["1h", "6h", "24h"].includes(observation.window))
    confidence = Math.min(0.55, confidence);
  const candidate = ready
    ? regimeFor(features, s.flowMeaningfulChangePercent)
    : "INSUFFICIENT_DATA";
  if (!ready || candidate === "INSUFFICIENT_DATA")
    confidence = Math.min(0.4, confidence);
  let regime = previous?.regime ?? "INSUFFICIENT_DATA",
    pending = previous?.pendingRegime;
  const reversal =
    features.netFlowUsd !== null &&
    features.netFlowUsd < 0 &&
    (features.buyPressure ?? 1) < 0.3;
  if (candidate !== regime) {
    pending = {
      regime: candidate,
      count: pending?.regime === candidate ? pending.count + 1 : 1,
    };
    if (
      regime === "INSUFFICIENT_DATA" ||
      candidate === "INSUFFICIENT_DATA" ||
      reversal ||
      pending.count >= s.flowRegimeConfirmations
    ) {
      regime = candidate;
      pending = undefined;
    }
  } else pending = undefined;
  const transitioned = regime !== (previous?.regime ?? "INSUFFICIENT_DATA");
  const lookbacks = Object.fromEntries(
    [1, 3, 5, 15, 30].map((minutes) => {
      const target = observation.at - minutes * 60000;
      const base = same
        .filter((x) => x.at < observation.at)
        .sort((a, b) => Math.abs(a.at - target) - Math.abs(b.at - target))[0];
      if (!base || Math.abs(base.at - target) > Math.max(30000, minutes * 6000))
        return [minutes + "m", null];
      return [
        minutes + "m",
        {
          fromAt: base.at,
          toAt: observation.at,
          actualElapsedMs: observation.at - base.at,
          priceChangePercent: percent(observation.priceUsd, base.priceUsd),
          volumeChangePercent: percent(observation.volumeUsd, base.volumeUsd),
          netFlowChangeUsd: subtract(
            subtract(observation.buyVolumeUsd, observation.sellVolumeUsd),
            subtract(base.buyVolumeUsd, base.sellVolumeUsd),
          ),
        },
      ];
    }),
  );
  const signalKey = hash({
    regime,
    window: observation.window,
    net: bucket(features.netFlowUsd),
    pressure:
      features.buyPressure === null
        ? null
        : Math.round(features.buyPressure * 10),
    volume: bucket(observation.volumeUsd),
    liquidity: bucket(observation.liquidityUsd),
    momentum:
      features.priceMomentumPercent === null
        ? null
        : Math.round(features.priceMomentumPercent / 5),
    quality: Math.floor(confidence * 5),
  });
  return {
    positionId,
    mint,
    regime,
    confidence: Number(confidence.toFixed(3)),
    window: observation.window,
    at: observation.at,
    lastMeaningfulAt:
      signalKey !== previous?.signalKey
        ? observation.at
        : previous.lastMeaningfulAt,
    signalKey,
    features,
    lookbacks,
    quality: {
      status: !ready
        ? "WARMING_UP"
        : candidate === "INSUFFICIENT_DATA"
          ? "DEGRADED"
          : "READY",
      observations: same.length,
      spanMs,
      available,
      missing,
      basis:
        "GMGN rolling-window directional DEX volume in USD; changes are changes of rolling totals, not capital deposits",
      stale: false,
    },
    transitions: [
      ...(previous?.transitions ?? []),
      ...(transitioned
        ? [
            {
              at: observation.at,
              from: previous?.regime ?? ("INSUFFICIENT_DATA" as FlowRegime),
              to: regime,
              confidence,
              reason: reversal
                ? "MATERIAL_NEGATIVE_REVERSAL"
                : "OBSERVED_REGIME_CHANGE",
            },
          ]
        : []),
    ].slice(-s.flowMaxTransitions),
    observations,
    pendingRegime: pending,
  };
}
export function flowSummary(state: CapitalFlowState): CapitalFlowSummary {
  const { observations: _, pendingRegime: __, ...summary } = state;
  void _;
  void __;
  return summary;
}
export class CapitalFlowEngine {
  observeCandidate(
    c: import("./domain.js").Candidate,
    market: Market,
    info: unknown,
    now = Date.now(),
  ) {
    const fetched = record(record(info)._gmgnSnapshot).fetchedAt;
    if (typeof fetched === "number") now = fetched;
    const row = this.store.db
      .prepare("SELECT payload FROM candidate_flow_states WHERE mint=?")
      .get(c.mint);
    const previous = row
      ? (JSON.parse(String(row.payload)) as CapitalFlowState)
      : undefined;
    if (
      previous &&
      now - previous.at < this.settings().flowObservationIntervalMs
    )
      return flowSummary(previous);
    const next = evolveFlow(
      previous,
      "candidate:" + c.mint,
      c.mint,
      normalizeFlowObservation(market, info, now),
      this.settings(),
    );
    this.store.db
      .prepare(
        "INSERT INTO candidate_flow_states VALUES(?,?,?) ON CONFLICT(mint) DO UPDATE SET updated_at=excluded.updated_at,payload=excluded.payload",
      )
      .run(c.mint, now, JSON.stringify(next));
    this.store.db
      .prepare(
        "DELETE FROM candidate_flow_states WHERE updated_at<? OR mint IN (SELECT mint FROM candidate_flow_states ORDER BY updated_at DESC LIMIT -1 OFFSET 250)",
      )
      .run(now - this.settings().flowHistoryMs);
    return flowSummary(next);
  }
  private observations = 0;
  private transitions = 0;
  private totalMs = 0;
  constructor(
    private store: Store,
    private settings: () => Settings,
  ) {}
  state(positionId: string): CapitalFlowState | undefined {
    const row = this.store.db
      .prepare("SELECT payload FROM capital_flow_states WHERE position_id=?")
      .get(positionId);
    return row ? JSON.parse(String(row.payload)) : undefined;
  }
  observe(p: Position, market: Market, info: unknown, now = Date.now()) {
    const fetched = record(record(info)._gmgnSnapshot).fetchedAt;
    if (typeof fetched === "number") now = fetched;
    const started = performance.now(),
      previous = this.state(p.id),
      s = this.settings();
    if (previous && previous.mint !== p.mint)
      throw new Error("FLOW_POSITION_IDENTITY_MISMATCH");
    if (previous && now - previous.at < s.flowObservationIntervalMs)
      return flowSummary(previous);
    const observation = normalizeFlowObservation(market, info, now);
    const retracement =
      p.state === "OPEN" &&
      BigInt(p.highWaterLamports) > 0n &&
      p.lastValueLamports !== undefined
        ? 100 * (1 - Number(p.lastValueLamports) / Number(p.highWaterLamports))
        : null;
    const next = evolveFlow(
      previous,
      p.id,
      p.mint,
      observation,
      s,
      retracement,
    );
    this.store.db
      .prepare(
        "INSERT INTO capital_flow_states VALUES(?,?,?,?,?) ON CONFLICT(position_id) DO UPDATE SET updated_at=excluded.updated_at,payload=excluded.payload",
      )
      .run(p.id, p.mode, p.mint, now, JSON.stringify(next));
    this.observations++;
    this.totalMs += performance.now() - started;
    if (
      next.regime !== previous?.regime &&
      next.regime !== "INSUFFICIENT_DATA"
    ) {
      this.transitions++;
      this.store.event("CAPITAL_FLOW_TRANSITION", p.mint, next.regime);
    }
    return flowSummary(next);
  }
  degraded(p: Position, now = Date.now()): CapitalFlowSummary | undefined {
    const previous = this.state(p.id);
    if (!previous) return;
    const summary = flowSummary(previous);
    return {
      ...summary,
      confidence: 0,
      quality: {
        ...summary.quality,
        status: "DEGRADED",
        stale: now - previous.at > this.settings().flowStaleMs,
      },
    };
  }
  prune(mode: Mode, activeIds: string[]) {
    const active = new Set(activeIds);
    for (const row of this.store.db
      .prepare("SELECT position_id FROM capital_flow_states WHERE mode=?")
      .all(mode))
      if (!active.has(String(row.position_id)))
        this.store.db
          .prepare("DELETE FROM capital_flow_states WHERE position_id=?")
          .run(String(row.position_id));
  }
  status() {
    const storage = this.store.db
      .prepare(
        "SELECT count(*) rows,coalesce(sum(length(payload)),0) payloadBytes FROM capital_flow_states",
      )
      .get()!;
    return {
      observations: this.observations,
      transitions: this.transitions,
      averageComputationMs: this.observations
        ? Number((this.totalMs / this.observations).toFixed(3))
        : null,
      retainedPositions: Number(storage.rows),
      retainedPayloadBytes: Number(storage.payloadBytes),
    };
  }
}
