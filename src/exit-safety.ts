import type { Market, Position, Security, ExitOpportunity } from "./domain.js";
import type { Settings } from "./config.js";
import type { MarketHistory } from "./market-history.js";
import { normalizeFlowObservation } from "./capital-flow.js";
import { analyzeManipulationStructure } from "./manipulation-structure.js";
import { hash, safeError } from "./util.js";
import { percent } from "./gmgn.js";

export const exitSafetyPolicy = Object.freeze({
  version: "EXIT_SAFETY_V2",
  localBars: 12,
  minimumBaseBars: 3,
  responseBars: 3,
  historyIntervalMs: 60000,
  historySpacingMs: 15000,
  historyQueue: 100,
});
export interface ProtectiveAuthority {
  version: "EXIT_SAFETY_V2";
  kind:
    | "SECURITY_CRITICAL"
    | "LIQUIDITY_COLLAPSE"
    | "STRUCTURE_COLLAPSE"
    | "MANIPULATION_STRUCTURE_BREAKDOWN";
  severity: "CRITICAL" | "HIGH";
  action: "FULL_SELL";
  sellBps: 10000;
  quantity: string;
  observedAt: number;
  expiresAt: number;
  reason: string;
  evidence: unknown;
  limitations: string[];
}
const fresh = (at: number | null | undefined, age: number, now: number) =>
  typeof at === "number" && Number.isFinite(at) && at <= now && now - at <= age;
const median = (xs: number[]) => {
  const a = [...xs].sort((a, b) => a - b);
  return a.length ? a[Math.floor(a.length / 2)]! : null;
};
export function positionPriceStructure(
  h: MarketHistory | undefined,
  s: Settings,
  now: number,
) {
  const source = "GMGN_CLOSED_M1_PRICE_INFERENCE";
  const xs =
    h?.candles
      .filter((c) => c.at + 60000 <= now)
      .slice(-exitSafetyPolicy.localBars) ?? [];
  const base = xs.slice(0, -3),
    tail = xs.slice(-3);
  const contiguous = xs.every((c, i) => !i || c.at - xs[i - 1]!.at === 60000);
  const current =
    h &&
    fresh(h.fetchedAt, s.maxSnapshotAgeMs + 60000, now) &&
    fresh(h.historyTo, s.maxSnapshotAgeMs + 60000, now);
  const state = !h
    ? "UNAVAILABLE"
    : !current
      ? "STALE"
      : base.length < 3 || !contiguous
        ? "INSUFFICIENT"
        : "AVAILABLE";
  const floor = base.length ? Math.min(...base.map((c) => c.low)) : null;
  const range = median(base.map((c) => c.high - c.low));
  const [br, rebound, last] = tail;
  const supportFailed =
    state === "AVAILABLE" &&
    !!br &&
    floor !== null &&
    br.close < floor &&
    br.low < floor;
  const failedRecovery =
    supportFailed &&
    !!rebound &&
    !!last &&
    rebound.high > br!.close &&
    rebound.close < floor! &&
    last.close < rebound.close &&
    last.close < floor!;
  const downsidePersistent =
    failedRecovery &&
    last!.low <= br!.low &&
    br!.close < br!.open &&
    last!.close < last!.open;
  const relativeDisplacement =
    supportFailed &&
    range !== null &&
    range > 0 &&
    base.at(-1)!.close - br!.close > range;
  return {
    state,
    source,
    observedAt: h?.historyTo ?? null,
    fetchedAt: h?.fetchedAt ?? null,
    ageMs: h?.historyTo == null ? null : now - h.historyTo,
    coverage: h?.historyCoverage ?? null,
    floor,
    localMedianRange: range,
    supportFailed,
    failedRecovery,
    downsidePersistent,
    relativeDisplacement,
    breakdown:
      supportFailed &&
      failedRecovery &&
      downsidePersistent &&
      relativeDisplacement,
    limitations: [
      "Closed M1 OHLCV price inference, not seller-initiated orderflow or rug proof",
      "Three response bars plus local baseline required; no fixed price/PnL stop",
    ],
  };
}
export function evaluateExitSafety(
  p: Position,
  s: Settings,
  input: {
    market?: Market;
    security?: Security;
    history?: MarketHistory;
    now?: number;
  },
) {
  const now = input.now ?? Date.now(),
    m = input.market,
    sec = input.security;
  const price = positionPriceStructure(input.history, s, now);
  const liquidityKnown =
    m?.liquidity.state === "KNOWN" &&
    Number.isFinite(m.liquidity.value) &&
    m.liquidity.value >= 0;
  const liquidityFresh = !!m && fresh(m.at, s.maxSnapshotAgeMs, now);
  const liquidity = {
    source: "GMGN_TOKEN_INFO_POOL_LIQUIDITY",
    observedAt: m?.at ?? null,
    fresh: liquidityFresh,
    value: liquidityKnown
      ? m!.liquidity.state === "KNOWN"
        ? m!.liquidity.value
        : null
      : null,
    baseline: p.initialLiquidity ?? null,
    collapsed: !!(
      liquidityKnown &&
      liquidityFresh &&
      p.initialLiquidity &&
      p.initialLiquidity > 0 &&
      m!.liquidity.state === "KNOWN" &&
      m!.liquidity.value * 10000 <
        p.initialLiquidity * (10000 - s.liquidityCollapseBps)
    ),
  };
  const security = {
    source: "GMGN_TOKEN_SECURITY",
    observedAt: sec?.at ?? null,
    fresh: !!sec && fresh(sec.at, s.maxSnapshotAgeMs, now),
    critical: sec?.findings.filter((f) => f.level === "CRITICAL") ?? [],
  };
  const window = m ? normalizeFlowObservation(m, {}, m.at) : null;
  const windowNegative =
    window?.buyVolumeUsd != null &&
    window.sellVolumeUsd != null &&
    window.buyVolumeUsd < window.sellVolumeUsd;
  const flow = {
    source: "GMGN_ROLLING_DIRECTIONAL_VOLUME",
    observedAt: p.flow?.at ?? null,
    regime: p.flow?.regime ?? "INSUFFICIENT_DATA",
    quality: p.flow?.quality.status ?? "UNAVAILABLE",
    fresh:
      !!p.flow && fresh(p.flow.at, s.flowStaleMs, now) && !p.flow.quality.stale,
    netBuyUsd: p.flow?.features.netFlowUsd ?? null,
    currentWindowNegative: windowNegative,
  };
  const negativeFlow =
    flow.fresh &&
    flow.quality === "READY" &&
    ["OUTFLOW", "OUTFLOW_ACCELERATING", "DISTRIBUTION"].includes(flow.regime) &&
    flow.netBuyUsd !== null &&
    flow.netBuyUsd < 0 &&
    (p.flow?.features.buyPressure ?? 1) < 0.5 &&
    (!m || (liquidityFresh && windowNegative));
  const structural = p.strategy !== "KRONOS" && price.breakdown && negativeFlow;
  const markup =
    structural && input.history
      ? analyzeManipulationStructure(
          { ...input.history, candles: input.history.candles.slice(0, -3) },
          now,
        ).status === "STRONG"
      : false;
  const exitFeasibility = {
    source: "JUPITER_QUOTE_ONLY",
    observedAt: p.exitLiquidity?.checkedAt ?? null,
    status: p.exitLiquidity?.status ?? "UNAVAILABLE",
    fresh:
      !!p.exitLiquidity &&
      p.exitLiquidity.quantity === p.quantity &&
      fresh(p.exitLiquidity.checkedAt, s.positionExitProbeMs * 2, now),
    limitations: [
      "Advisory; never requires background probe before protective execution",
    ],
  };
  const components = {
    price,
    flow,
    liquidity,
    security,
    exitFeasibility,
    dataQuality: {
      evaluatedAt: now,
      limitations: [
        "No historical market-wide directional volume or liquidity reconstruction",
        "PnL, fees, age, one red candle and outflow alone cannot authorize this policy",
      ],
    },
  };
  const authorities: ProtectiveAuthority[] = [];
  const add = (
    kind: ProtectiveAuthority["kind"],
    reason: string,
    at: number,
    maxAge: number,
  ) =>
    authorities.push({
      version: "EXIT_SAFETY_V2",
      kind,
      severity: kind === "SECURITY_CRITICAL" ? "CRITICAL" : "HIGH",
      action: "FULL_SELL",
      sellBps: 10000,
      quantity: p.quantity,
      observedAt: at,
      expiresAt: at + maxAge,
      reason,
      evidence: components,
      limitations: components.dataQuality.limitations,
    });
  if (security.fresh && security.critical.length)
    add(
      "SECURITY_CRITICAL",
      "Critical GMGN security deterioration",
      sec!.at,
      s.maxSnapshotAgeMs,
    );
  if (liquidity.collapsed)
    add(
      "LIQUIDITY_COLLAPSE",
      "GMGN liquidity removal/collapse",
      m!.at,
      s.maxSnapshotAgeMs,
    );
  if (structural)
    add(
      markup ? "MANIPULATION_STRUCTURE_BREAKDOWN" : "STRUCTURE_COLLAPSE",
      markup ? "MANIPULATION_STRUCTURE_BREAKDOWN" : "STRUCTURE_COLLAPSE",
      Math.min(price.observedAt!, flow.observedAt!),
      s.structureMaxGapMs,
    );
  return {
    version: "EXIT_SAFETY_V2" as const,
    at: now,
    quantity: p.quantity,
    history: input.history,
    components,
    authorities,
    key: hash({
      priceState: price.state,
      breakdown: price.breakdown,
      flowQuality: flow.quality,
      flowFresh: flow.fresh,
      liquidityCollapsed: liquidity.collapsed,
      critical: security.critical.map((f) => f.code),
      authorities: authorities.map((a) => a.kind),
    }),
  };
}
export type ExitSafetyEvidence = ReturnType<typeof evaluateExitSafety>;
export function validProtection(
  a: ProtectiveAuthority | undefined,
  p: Position,
  now = Date.now(),
) {
  return (
    !!a &&
    a.action === "FULL_SELL" &&
    a.sellBps === 10000 &&
    Number.isFinite(a.expiresAt) &&
    !(
      a.evidence &&
      typeof a.evidence === "object" &&
      "source" in a.evidence &&
      a.evidence.source === "LEGACY_RECORD_REQUIRES_REVALIDATION"
    ) &&
    a.version === "EXIT_SAFETY_V2" &&
    a.quantity === p.quantity &&
    fresh(a.observedAt, a.expiresAt - a.observedAt, now) &&
    a.expiresAt >= now
  );
}
export function exitPriority(
  manualBps: number | undefined,
  o: ExitOpportunity | undefined,
) {
  return manualBps !== undefined
    ? manualBps === 10000
      ? 1
      : 2
    : o?.kind === "PROTECTIVE"
      ? o.protection?.severity === "CRITICAL"
        ? 3
        : 4
      : o?.sellBps === 10000
        ? 5
        : 6;
}
export function securityRecoveryConfirmed(
  a: ProtectiveAuthority,
  sec: Security,
  s: Settings,
) {
  const evidence = a.evidence as {
    security?: { critical?: Array<{ code: string }> };
  };
  const codes = evidence?.security?.critical?.map((f) => f.code) ?? [];
  if (!codes.length || sec.findings.some((f) => f.level === "CRITICAL"))
    return false;
  return codes.every((code) => {
    if (code === "MINT_CONTROL")
      return sec.mintRenounced.state === "KNOWN" && sec.mintRenounced.value;
    if (code === "FREEZE_CONTROL")
      return sec.freezeRenounced.state === "KNOWN" && sec.freezeRenounced.value;
    if (code === "GMGN_RUG_RISK")
      return (
        sec.rugRatio.state === "KNOWN" &&
        sec.rugRatio.value < s.criticalRugRatio
      );
    if (code === "HONEYPOT_REPORTED")
      return [false, 0, "0", "false", "no"].includes(
        sec.raw.is_honeypot as boolean | number | string,
      );
    if (code === "EXCESSIVE_TAX") {
      const buy = percent(sec.raw.buy_tax),
        sell = percent(sec.raw.sell_tax);
      return (
        buy.state === "KNOWN" &&
        sell.state === "KNOWN" &&
        buy.value <= s.maxTaxPercent &&
        sell.value <= s.maxTaxPercent
      );
    }
    return false;
  });
}
export interface ExitRetry {
  classification:
    | "NO_ROUTE"
    | "RPC_TEMPORARY"
    | "JUPITER_TEMPORARY"
    | "SIMULATION_FAILURE"
    | "INSUFFICIENT_BALANCE"
    | "TOKEN_INCOMPATIBLE"
    | "SIGNED_UNKNOWN"
    | "PROVIDER_INTELLIGENCE_FAILURE"
    | "OTHER";
  attempts: number;
  nextAt: number;
  code: string;
}
export function protectiveRetry(
  error: unknown,
  prior: ExitRetry | undefined,
  now = Date.now(),
): ExitRetry {
  const code = safeError(error),
    classification = /NO.*ROUTE|NO_SELL_ROUTE/.test(code)
      ? "NO_ROUTE"
      : /RPC/.test(code)
        ? "RPC_TEMPORARY"
        : /JUPITER/.test(code)
          ? "JUPITER_TEMPORARY"
          : /SIMULAT|TOKEN_SAFETY_FAILED/.test(code)
            ? "SIMULATION_FAILURE"
            : /BALANCE|INSUFFICIENT/.test(code)
              ? "INSUFFICIENT_BALANCE"
              : /EXTENSION|DECIMALS|MINT_LAYOUT|TOKEN_PROGRAM/.test(code)
                ? "TOKEN_INCOMPATIBLE"
                : /UNKNOWN|UNRESOLVED/.test(code)
                  ? "SIGNED_UNKNOWN"
                  : /GMGN/.test(code)
                    ? "PROVIDER_INTELLIGENCE_FAILURE"
                    : "OTHER";
  const attempts = (prior?.attempts ?? 0) + 1;
  const base =
    classification === "NO_ROUTE"
      ? 15000
      : classification === "TOKEN_INCOMPATIBLE"
        ? 60000
        : 5000;
  return {
    classification,
    attempts,
    nextAt:
      classification === "SIGNED_UNKNOWN"
        ? Number.MAX_SAFE_INTEGER
        : now + Math.min(60000, base * 2 ** Math.min(attempts - 1, 4)),
    code,
  };
}
export function exitEvidenceKey(p: Position, s: Settings, now = Date.now()) {
  const r = p.exitLiquidity;
  return hash({
    safety: p.exitSafety?.key ?? null,
    flowQuality: p.flow?.quality.status,
    flowStale: p.flow
      ? !fresh(p.flow.at, s.flowStaleMs, now) || p.flow.quality.stale
      : null,
    route: r
      ? {
          status: r.status,
          quantity: r.quantity,
          stale: !fresh(r.checkedAt, s.positionExitProbeMs * 2, now),
        }
      : null,
  });
}
export function routeMateriallyChanged(
  a: Position["exitLiquidity"],
  b: Position["exitLiquidity"],
  s: Settings,
) {
  if (!a || !b) return !!a !== !!b;
  if (a.status !== b.status || a.quantity !== b.quantity) return true;
  return a.levels.some((old) => {
    const next = b.levels.find((x) => x.sellBps === old.sellBps);
    if (old.minimumSolOut === undefined) return false;
    if (next?.minimumSolOut === undefined) return true;
    const before = Number(old.minimumSolOut),
      after = Number(next.minimumSolOut);
    return (
      before > 0 &&
      Number.isFinite(after) &&
      Math.abs(after / before - 1) * 100 >= s.maxDecisionPriceMovePercent
    );
  });
}
