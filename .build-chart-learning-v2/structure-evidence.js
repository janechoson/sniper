export const STRUCTURE_EVIDENCE_VERSION = "LOCAL_BUYER_DEFENSE_V2";
const finite = (v) => typeof v === "number" && Number.isFinite(v);
const positive = (v) => finite(v) && v > 0;
export function completeStructureObservation(o) {
    return (finite(o.at) &&
        ["1m", "5m", "1h", "6h", "24h"].includes(o.window) &&
        positive(o.priceUsd) &&
        positive(o.liquidityUsd) &&
        finite(o.buyVolumeUsd) &&
        o.buyVolumeUsd >= 0 &&
        finite(o.sellVolumeUsd) &&
        o.sellVolumeUsd >= 0 &&
        (o.buyVolumeUsd > 0 || o.sellVolumeUsd > 0));
}
function share(amount, liquidity) {
    // Bounded equivalent of amount/liquidity, avoids tiny-denominator blowups.
    return amount >= liquidity
        ? 1 / (1 + liquidity / amount)
        : amount / liquidity / (1 + amount / liquidity);
}
const pressure = (o) => share(o.buyVolumeUsd, o.sellVolumeUsd);
const net = (o) => o.buyVolumeUsd - o.sellVolumeUsd;
function sameSeries(a, b) {
    return (a.window === b.window &&
        a.provenance?.provider === b.provenance?.provider &&
        a.provenance?.source === b.provenance?.source &&
        a.provenance?.mint === b.provenance?.mint);
}
function rate(a, b) {
    return ((Math.log(a.priceUsd) - Math.log(b.priceUsd)) / ((a.at - b.at) / 1000));
}
export function currentStructureEvidence(r) {
    return r?.evidenceVersion === STRUCTURE_EVIDENCE_VERSION;
}
function clearSequence(r) {
    r.observations = [];
    r.sellingCount = r.absorptionCount = r.recoveryCount = 0;
    r.supportCount = r.defenseFailureCount = 0;
    r.sellingSeen = r.supportConfirmed = false;
    r.absorptionDetected = false;
    r.status = "ACTIVE";
    r.phase = "WAITING_FOR_SELLING";
    delete r.peak;
    delete r.localLow;
    delete r.confirmedAt;
    delete r.evidence;
    delete r.context;
    r.priceVelocity =
        r.priceAcceleration =
            r.drawdownPercent =
                r.recoveryRatio =
                    null;
}
export function revalidateLegacyStructure(old) {
    if (currentStructureEvidence(old))
        return structuredClone(old);
    const r = structuredClone(old);
    // Preserve the old interpretation, but never upgrade its flags to new proof.
    r.previousStructureEvidence = {
        version: old.evidenceVersion ?? "LEGACY",
        status: old.status,
        phase: old.phase,
        confirmedAt: old.confirmedAt,
        sellingCount: old.sellingCount,
        absorptionCount: old.absorptionCount,
        recoveryCount: old.recoveryCount,
        peak: old.peak,
        localLow: old.localLow,
        observations: structuredClone(old.observations),
        sellingSeen: old.sellingSeen,
        supportConfirmed: old.supportConfirmed,
    };
    clearSequence(r);
    delete r.lastObservedAt;
    r.quality = "UNKNOWN";
    r.reason = "LOCAL_STRUCTURE_REVALIDATION_REQUIRED";
    r.evidenceVersion = STRUCTURE_EVIDENCE_VERSION;
    r.liveObservationsAccepted = 0;
    return r;
}
export function recentStructureContext(observations, mint, now, s) {
    let suffix = [];
    const lookback = Math.min(s.structureWatchTtlMs, 2 * s.structureMaxGapMs);
    for (const o of observations.slice(-120)) {
        const p = o.provenance;
        if (!completeStructureObservation(o) ||
            !p ||
            p.provider !== "GMGN" ||
            p.mint !== mint ||
            !p.source ||
            p.observedAt !== o.at ||
            p.semantics !== "WINDOW_TOTAL_SNAPSHOT" ||
            o.at >= now ||
            now - o.at > lookback) {
            suffix = [];
            continue;
        }
        const b = suffix.at(-1);
        if (b && o.at === b.at)
            continue;
        if (b &&
            (o.at < b.at || o.at - b.at > s.structureMaxGapMs || !sameSeries(o, b)))
            suffix = [];
        if (!suffix.length || o.at - suffix.at(-1).at >= s.structureObservationMs)
            suffix.push(o);
    }
    return suffix.length && now - suffix.at(-1).at <= s.structureMaxGapMs
        ? suffix
        : [];
}
export function evolveLocalStructure(old, mint, o, s, now, contextOnly = false) {
    const r = old
        ? structuredClone(old)
        : {
            mint,
            phase: "NEW",
            status: "ACTIVE",
            structureWatchStartedAt: now,
            structureWatchExpiresAt: now + s.structureWatchTtlMs,
            quality: "UNKNOWN",
            reason: "WAITING_FOR_OBSERVATIONS",
            observations: [],
            sellingCount: 0,
            absorptionCount: 0,
            recoveryCount: 0,
            sellingSeen: false,
            supportConfirmed: false,
            providerUnavailableDuration: 0,
            observationsAccepted: 0,
            priceVelocity: null,
            priceAcceleration: null,
            drawdownPercent: null,
            recoveryRatio: null,
            evidenceVersion: STRUCTURE_EVIDENCE_VERSION,
            supportCount: 0,
            defenseFailureCount: 0,
            absorptionDetected: false,
            liveObservationsAccepted: 0,
        };
    if (["INVALIDATED", "EXPIRED", "USER_REMOVED"].includes(r.status))
        return r;
    const state = currentStructureEvidence(r) ? r : revalidateLegacyStructure(r);
    return advance(state, o, s, now, contextOnly);
}
function advance(r, o, s, now, contextOnly) {
    r.structureWatchExpiresAt = Math.min(r.structureWatchExpiresAt, r.structureWatchStartedAt + s.structureWatchTtlMs);
    if (!contextOnly &&
        now >= r.structureWatchExpiresAt &&
        !(r.status === "PASSED" &&
            r.confirmedAt !== undefined &&
            r.confirmedAt >= r.structureWatchStartedAt &&
            r.confirmedAt < r.structureWatchExpiresAt &&
            r.confirmedAt <= now)) {
        r.status = "EXPIRED";
        r.reason = "STRUCTURE_WATCH_EXPIRED";
        return r;
    }
    if (!o ||
        !completeStructureObservation(o) ||
        o.at > now ||
        now - o.at > s.structureMaxGapMs ||
        (!contextOnly && o.at < r.structureWatchStartedAt)) {
        r.quality = r.lastObservedAt === undefined ? "UNKNOWN" : "STALE";
        r.reason = "OBSERVATION_UNAVAILABLE";
        return r;
    }
    let b = r.observations.at(-1), a = r.observations.at(-2);
    if (b && o.at <= b.at)
        return r;
    if (b && o.at - b.at < s.structureObservationMs)
        return r;
    if (b && (o.at - b.at > s.structureMaxGapMs || !sameSeries(o, b))) {
        r.providerUnavailableDuration += Math.max(0, o.at - b.at - s.structureObservationMs);
        clearSequence(r);
        b = undefined;
        a = undefined;
    }
    r.observations = [...r.observations, o].slice(-120);
    if (!contextOnly) {
        r.lastObservedAt = o.at;
        r.quality = "FRESH";
        r.observationsAccepted++;
        r.liveObservationsAccepted = (r.liveObservationsAccepted ?? 0) + 1;
    }
    r.peak = Math.max(r.peak ?? o.priceUsd, o.priceUsd);
    r.drawdownPercent = (1 - o.priceUsd / r.peak) * 100;
    if (!b) {
        r.reason = "NEED_SEQUENTIAL_EVIDENCE";
        return r;
    }
    const dt = (o.at - b.at) / 1000, v = (o.priceUsd - b.priceUsd) / dt;
    const previousV = a
        ? (b.priceUsd - a.priceUsd) / ((b.at - a.at) / 1000)
        : null;
    r.priceVelocity = v;
    r.priceAcceleration = previousV === null ? null : (v - previousV) / dt;
    const p = pressure(o), bp = pressure(b), n = net(o), bn = net(b);
    const l = o.liquidityUsd, bl = b.liquidityUsd;
    const liquid = l > 0 && l >= bl;
    const sell = o.sellVolumeUsd > 0 &&
        (o.sellVolumeUsd >= b.sellVolumeUsd || p < bp || n < bn);
    const selling = sell && (v < 0 || p < bp || n < bn);
    r.sellingCount = selling ? r.sellingCount + 1 : 0;
    if (r.sellingCount >= s.structureConfirmations)
        r.sellingSeen = true;
    const sellShare = share(o.sellVolumeUsd, l), prevSellShare = share(b.sellVolumeUsd, bl);
    const buyShare = share(o.buyVolumeUsd, l), prevBuyShare = share(b.buyVolumeUsd, bl);
    const priceRate = rate(o, b), down = Math.max(0, -priceRate);
    const prevDown = a ? Math.max(0, -rate(b, a)) : null;
    const countsKnown = finite(o.buys) && finite(b.buys);
    const countTrend = countsKnown ? o.buys - b.buys : null;
    const buyer = o.buyVolumeUsd > 0;
    const stableBuyer = buyer &&
        o.buyVolumeUsd >= b.buyVolumeUsd &&
        buyShare >= prevBuyShare &&
        p >= bp &&
        n >= bn &&
        (countTrend === null || countTrend >= 0);
    const strongerBuyer = stableBuyer && o.buyVolumeUsd > b.buyVolumeUsd;
    // Response relative to comparable observable rolling sell pressure, NOT
    // "new sell USD" or causal per-trade price impact.
    const absorption = o.sellVolumeUsd > 0 &&
        sellShare > 0 &&
        sellShare >= prevSellShare &&
        liquid &&
        prevDown !== null &&
        prevDown > 0 &&
        down < prevDown &&
        down * prevSellShare < prevDown * sellShare;
    const floor = r.localLow;
    const floorHeld = floor !== undefined && o.priceUsd >= floor && v >= 0;
    const previousPositive = a ? Math.max(0, rate(b, a)) : null;
    const responseBacked = previousPositive === null ||
        previousPositive === 0 ||
        (countTrend !== null && countTrend > 0) ||
        Math.max(0, priceRate) * prevBuyShare <= previousPositive * buyShare;
    const recovery = !!r.supportConfirmed &&
        floorHeld &&
        v > 0 &&
        strongerBuyer &&
        liquid &&
        responseBacked;
    r.evidence = {
        at: o.at,
        window: o.window,
        semantics: "WINDOW_TOTAL_SNAPSHOT",
        providerAggregationGuarantee: "UNKNOWN",
        sellerPressure: sell,
        sellLiquidityShare: sellShare,
        buyLiquidityShare: buyShare,
        downsideRate: down,
        absorption: prevDown === null ? null : absorption,
        buyerActivity: buyer,
        buyerStrengthening: strongerBuyer,
        floorHeld: floor === undefined ? null : floorHeld,
        recovery,
        buyTotalTrend: o.buyVolumeUsd - b.buyVolumeUsd,
        buyCountTrend: countTrend,
        pressureTrend: p - bp,
        netTrend: Number.isFinite(n - bn) ? n - bn : null,
        priceResponseRate: priceRate,
    };
    if (!r.sellingSeen) {
        r.phase =
            v > 0
                ? "INITIAL_EXPANSION"
                : v === 0
                    ? "PEAK_FORMING"
                    : "WAITING_FOR_SELLING";
        r.reason = "REAL_SELLING_NOT_CONFIRMED";
        return r;
    }
    if (!r.absorptionDetected) {
        r.absorptionCount = absorption ? r.absorptionCount + 1 : 0;
        r.phase = r.absorptionCount ? "ABSORPTION_FORMING" : "SELLING_APPEARED";
        if (r.absorptionCount >= s.structureConfirmations) {
            r.absorptionDetected = true;
            r.localLow = o.priceUsd;
            r.phase = "ABSORPTION_DETECTED";
        }
        r.reason = r.absorptionDetected
            ? "SELLING_RESPONSE_ABSORPTION_OBSERVED"
            : "NEED_PERSISTENT_ABSORPTION";
        return r;
    }
    const lost = floor !== undefined && o.priceUsd < floor && v < 0 && sell && !stableBuyer;
    r.defenseFailureCount = lost ? (r.defenseFailureCount ?? 0) + 1 : 0;
    if (r.defenseFailureCount >= s.structureConfirmations) {
        r.absorptionDetected = false;
        r.supportConfirmed = false;
        r.supportCount = r.absorptionCount = r.recoveryCount = 0;
        r.status = "ACTIVE";
        r.phase = "SUPPORT_FAILED";
        delete r.confirmedAt;
        delete r.localLow;
        r.reason = "BUYER_DEFENSE_LOST_CONTINUE_WATCH";
        return r;
    }
    if (!r.supportConfirmed) {
        const defense = o.sellVolumeUsd > 0 && floorHeld && stableBuyer && liquid;
        r.supportCount = defense ? (r.supportCount ?? 0) + 1 : 0;
        r.phase = r.supportCount ? "SUPPORT_FORMING" : "SEARCHING_FOR_SUPPORT";
        if (r.supportCount >= s.structureConfirmations) {
            r.supportConfirmed = true;
            r.phase = "SUPPORT_CONFIRMED";
        }
        r.reason = r.supportConfirmed
            ? "BUYER_DEFENSE_CONFIRMED"
            : "NEED_LIVE_BUYER_DEFENSE";
        return r;
    }
    if (contextOnly) {
        r.recoveryCount = 0;
        r.phase = "SUPPORT_CONFIRMED";
        return r;
    }
    if (r.status === "PASSED" && !recovery) {
        if (floorHeld && stableBuyer && liquid) {
            r.phase = "ENTRY_ELIGIBLE";
            return r;
        }
        r.status = "ACTIVE";
        delete r.confirmedAt;
    }
    r.recoveryCount = recovery ? r.recoveryCount + 1 : 0;
    r.phase = recovery
        ? "RECOVERY_ATTEMPT"
        : v < 0
            ? "RECOVERY_FAILED"
            : "SUPPORT_CONFIRMED";
    r.reason = recovery
        ? "NEED_PERSISTENT_BUYER_RETURN"
        : "BUYER_RECOVERY_NOT_CONFIRMED";
    if (r.recoveryCount >= s.structureConfirmations + 1) {
        r.status = "PASSED";
        r.phase = "ENTRY_ELIGIBLE";
        r.confirmedAt ??= now;
        r.reason = "RECOVERY_CONFIRMED";
    }
    r.recoveryRatio =
        r.localLow !== undefined && r.peak !== r.localLow
            ? (o.priceUsd - r.localLow) / (r.peak - r.localLow)
            : null;
    return r;
}
export function seedStructureContext(row, observations, s) {
    let r = structuredClone(row);
    for (const o of observations)
        r = evolveLocalStructure(r, r.mint, o, s, o.at, true);
    if (observations.length)
        r.context = {
            firstAt: observations[0].at,
            lastAt: observations.at(-1).at,
            observations: observations.length,
            window: observations.at(-1).window,
            source: observations.at(-1).provenance.source,
            priorDefenseObserved: r.supportConfirmed,
        };
    r.supportConfirmed = false;
    r.supportCount = 0;
    r.recoveryCount = 0;
    r.status = "ACTIVE";
    delete r.confirmedAt;
    delete r.lastObservedAt;
    r.quality = "UNKNOWN";
    r.phase = r.absorptionDetected
        ? "ABSORPTION_DETECTED"
        : r.sellingSeen
            ? "SELLING_APPEARED"
            : "NEW";
    r.reason = observations.length
        ? "RECENT_CONTEXT_REQUIRES_LIVE_DEFENSE"
        : "WAITING_FOR_OBSERVATIONS";
    return r;
}
