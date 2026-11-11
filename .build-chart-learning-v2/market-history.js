import { record, numberEvidence } from "./gmgn.js";
import { defaultSettings } from "./config.js";
import { smartMoneySupport, unavailableSmartMoney, } from "./smart-money.js";
import { normalizeFlowObservation, deriveFlow, regimeFor, } from "./capital-flow.js";
const num = (v) => {
    const e = numberEvidence(v);
    return e.state === "KNOWN" ? e.value : null;
};
export function parseMarketHistory(raw, c, now = Date.now()) {
    const envelope = record(raw), body = record(envelope.data ?? envelope);
    const from = Math.max(now - 3600000, c.createdAt ?? 0);
    const rows = Array.isArray(body.list) ? body.list : [];
    const byTime = new Map();
    const timestampUnits = new Set();
    const rejectedRows = {};
    const rejectRow = (reason) => {
        rejectedRows[reason] = (rejectedRows[reason] ?? 0) + 1;
    };
    for (const item of rows) {
        const r = record(item), timestamp = num(r.time);
        if (timestamp === null) {
            rejectRow("MISSING_TIMESTAMP");
            continue;
        }
        // The live GMGN response uses epoch milliseconds. Also accept legacy
        // seconds, but never multiply an already-millisecond timestamp again.
        const unit = timestamp >= 1_000_000_000_000 ? "MILLISECONDS" : "SECONDS";
        timestampUnits.add(unit);
        const at = unit === "MILLISECONDS" ? timestamp : timestamp * 1000;
        const open = num(r.open), high = num(r.high), low = num(r.low), close = num(r.close);
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
        if (open === null ||
            high === null ||
            low === null ||
            close === null ||
            Math.min(open, low, close) <= 0 ||
            low > Math.min(open, close) ||
            high < Math.max(open, close)) {
            rejectRow("INVALID_OHLC");
            continue;
        }
        // Verified live GMGN K-line payload: volume is USD; amount is token units.
        // Do not use token quantity as dollar volume or substitute it when missing.
        byTime.set(at, { at, open, high, low, close, volumeUsd: num(r.volume) });
    }
    const candles = [...byTime.values()].sort((a, b) => a.at - b.at).slice(-61);
    const availableHistory = candles.reduce((sum, x) => sum + Math.max(0, Math.min(now, x.at + 60000) - Math.max(from, x.at)), 0);
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
        historyStartsAtCreation: !!c.createdAt && !!candles[0] && candles[0].at - c.createdAt < 60000,
        historyFrom: candles[0]?.at ?? null,
        historyTo: candles.length ? candles.at(-1).at + 60000 : null,
        preCreation: "NOT_AVAILABLE",
        directionalHistory: "UNKNOWN",
        diagnostics: {
            inputRows: rows.length,
            timestampUnit: timestampUnits.size === 0
                ? "UNKNOWN"
                : timestampUnits.size === 1
                    ? [...timestampUnits][0]
                    : "MIXED",
            rejectedRows,
        },
        candles,
        status: candles.length >= 2 ? "AVAILABLE" : "INSUFFICIENT_DATA",
    };
}
/** One current directional observation plus objective candle context; never manufacture historical buy/sell totals. */
export function attemptFlow(c, market, info, h, meaningfulChange) {
    const o = normalizeFlowObservation(market, info), features = deriveFlow([o]);
    const first = h.candles[0];
    features.priceMomentumPercent =
        first && o.priceUsd !== null ? (o.priceUsd / first.open - 1) * 100 : null;
    const ready = o.buyVolumeUsd !== null &&
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
            available: Object.keys(o).filter((k) => o[k] !== null),
            missing: ["historicalDirectionalVolume", "flowAcceleration"],
            basis: "Current GMGN rolling directional volume plus historical OHLCV; directional history UNKNOWN",
            stale: false,
        },
    };
}
export function oneShotStructure(h, flow, market, options = {}) {
    const now = options.now ?? Date.now(), settings = options.settings ?? defaultSettings();
    const candles = h.candles;
    let sell, low;
    let absorptionAt = null, floorAt = null;
    let recoveryAt = null, latestRelevantAt = null;
    let floorLow = null, expired = false;
    const reset = () => {
        sell = low = undefined;
        absorptionAt = floorAt = recoveryAt = latestRelevantAt = floorLow = null;
        expired = false;
    };
    for (let i = 0; i < candles.length; i++) {
        const x = candles[i], previous = candles[i - 1], end = x.at + 60000;
        if (previous && x.at - previous.at !== 60000)
            reset();
        if (latestRelevantAt !== null &&
            end - latestRelevantAt > settings.structureMaxGapMs)
            expired = true;
        if (x.close < x.open && x.volumeUsd !== null && x.volumeUsd > 0) {
            reset();
            sell = low = x;
        }
        else if (sell &&
            low &&
            !expired &&
            x.at > sell.at &&
            x.volumeUsd !== null &&
            x.volumeUsd > 0) {
            if (floorLow !== null && x.low < floorLow) {
                absorptionAt =
                    floorAt =
                        recoveryAt =
                            latestRelevantAt =
                                floorLow =
                                    null;
            }
            if (x.low < low.low)
                low = x;
            // Relative candle behavior only: no fixed drawdown/rebound percentages.
            if (absorptionAt === null &&
                x.close > x.open &&
                x.close > low.close &&
                previous &&
                x.low >= previous.low) {
                absorptionAt = x.at;
            }
            if (absorptionAt !== null &&
                x.at > absorptionAt &&
                previous &&
                x.low >= previous.low &&
                x.close >= previous.close) {
                floorAt ??= x.at;
                floorLow ??= previous.low;
            }
            if (floorAt !== null && x.at > floorAt && x.close > sell.open) {
                recoveryAt ??= end;
                if (previous && x.close > previous.close)
                    latestRelevantAt = end;
            }
        }
    }
    const last = candles.at(-1), before = candles.at(-2);
    const historyFresh = h.freshness === "FRESH" &&
        h.fetchedAt <= now &&
        now - h.fetchedAt <= settings.maxSnapshotAgeMs &&
        h.historyTo !== null &&
        h.historyTo <= now &&
        now - h.historyTo <= settings.maxSnapshotAgeMs + 60000;
    const sequenceFresh = !expired &&
        historyFresh &&
        recoveryAt !== null &&
        latestRelevantAt !== null &&
        now >= latestRelevantAt &&
        now - latestRelevantAt <= settings.structureMaxGapMs;
    const momentum = !!last &&
        !!before &&
        last.close >= before.close &&
        market.price.state === "KNOWN" &&
        market.price.value >= last.close;
    const priceStructure = {
        source: h.source,
        semantics: "PRICE_INFERENCE",
        status: recoveryAt !== null && !sequenceFresh
            ? "STALE"
            : recoveryAt !== null
                ? "PRICE_RECOVERY_INFERRED"
                : "INSUFFICIENT_PRICE_STRUCTURE",
        sellingObserved: !!sell,
        absorptionInferred: absorptionAt !== null,
        floorHolding: floorAt !== null,
        recoveryInferred: recoveryAt !== null && sequenceFresh,
        historicalRecoveryInferred: recoveryAt !== null,
        sequenceFresh,
        momentum,
        sellingAt: sell?.at ?? null,
        absorptionAt,
        floorAt,
        recoveryConfirmedAt: recoveryAt,
        latestRelevantAt,
        evidenceFrom: sell?.at ?? null,
        evidenceTo: last ? last.at + 60000 : null,
        sequenceAgeMs: latestRelevantAt === null ? null : now - latestRelevantAt,
        maxSequenceAgeMs: settings.structureMaxGapMs,
        historyFresh,
        historyCoverage: h.historyCoverage,
    };
    const marketFresh = flow.at <= now &&
        market.at <= now &&
        now - flow.at <= settings.maxSnapshotAgeMs &&
        now - market.at <= settings.maxSnapshotAgeMs &&
        !flow.quality.stale;
    const net = flow.features.netFlowUsd, pressure = flow.features.buyPressure;
    const flowSupports = marketFresh &&
        flow.regime !== "INSUFFICIENT_DATA" &&
        net !== null &&
        net > 0 &&
        pressure !== null &&
        pressure > 0.5;
    const marketFlow = {
        source: "GMGN_CURRENT_ROLLING_FLOW",
        semantics: "CURRENT_MARKET_FLOW",
        status: !marketFresh || net === null || pressure === null
            ? "UNKNOWN"
            : flowSupports
                ? "SUPPORTIVE"
                : net < 0
                    ? "WEAKENING"
                    : "NEUTRAL",
        observedAt: flow.at,
        freshness: marketFresh ? "FRESH" : "STALE",
        window: flow.window,
        regime: flow.regime,
        metrics: flow.features,
        currentWindow: market.windows[flow.window] ?? null,
        observations: flow.quality.observations,
        historicalDirectionalFlow: "UNKNOWN",
    };
    const smartMoney = smartMoneySupport(options.smartMoney ?? unavailableSmartMoney(), options.mint ?? flow.mint, {
        // Align participant trades after the price response begins, never pre-selling buys.
        from: sell?.at ?? null,
        buySupportFrom: absorptionAt === null ? null : absorptionAt + 60000,
        eventMaxAgeMs: settings.structureMaxGapMs,
        to: now,
        maxAgeMs: settings.maxSnapshotAgeMs,
    });
    const priceEligible = sequenceFresh && momentum && priceStructure.floorHolding;
    const conflicted = priceEligible &&
        (marketFlow.status === "WEAKENING" ||
            smartMoney.status === "SELL_PRESSURE" ||
            (smartMoney.status === "MIXED" &&
                (smartMoney.computedNetBuyUsd ?? 0) < 0));
    const supportLevel = conflicted
        ? "CONFLICTED"
        : !priceEligible
            ? "INSUFFICIENT"
            : !flowSupports
                ? "WEAK"
                : smartMoney.status === "BUY_SUPPORT" && smartMoney.buyerCluster.present
                    ? "STRONG"
                    : "MODERATE";
    const passed = priceEligible && flowSupports;
    const reason = passed
        ? "PRICE_RECOVERY_INFERRED_WITH_CURRENT_FLOW"
        : priceStructure.status === "STALE"
            ? "STALE_PRICE_RECOVERY"
            : "INSUFFICIENT_STRUCTURE_EVIDENCE";
    return {
        version: "STRUCTURE_EVIDENCE_V3",
        passed,
        at: now,
        priceStructure,
        marketFlow,
        smartMoney,
        conclusion: {
            supportLevel,
            confidence: supportLevel,
            reasons: [reason, marketFlow.status, smartMoney.status],
            limitations: [
                "OHLCV absorption/recovery are price inference, not confirmed buyer defense",
                "No Level 4 historical market-wide BUY/SELL timeline",
                "Historical liquidity unavailable",
                "Current rolling flow is not historical directional flow",
                ...smartMoney.limitations,
            ],
        },
        reason,
        basis: "PRICE_INFERENCE + CURRENT_MARKET_FLOW + optional TIMESTAMPED_PARTICIPANT_FLOW",
    };
}
