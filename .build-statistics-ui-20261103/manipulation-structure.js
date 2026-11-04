/** Versioned, inspectable heuristics over normalized structure metrics, NOT price
 * change percentages or a learned probability of rug. Require confluence. */
export const manipulationPolicy = Object.freeze({
    version: "CONTROLLED_MARKUP_V1",
    minSegmentBars: 8,
    minPathEfficiency: 0.9,
    minDirectionalPersistence: 0.8,
    maxPullbackTravelShare: 0.1,
    maxMeanWickShare: 0.45,
    minHigherLowPersistence: 0.8,
    maxStepNoise: 0.75,
    maxBodyVariation: 0.6,
    compressionRatio: 0.8,
    impulseDominanceRatio: 2,
    lateAccelerationRatio: 1.5,
});
const mean = (x) => x.length ? x.reduce((s, n) => s + n, 0) / x.length : 0;
const median = (x) => {
    const a = [...x].sort((a, b) => a - b);
    return a.length
        ? (a[Math.floor((a.length - 1) / 2)] + a[Math.floor(a.length / 2)]) / 2
        : 0;
};
const ratio = (a, b) => (b > 0 ? a / b : null);
function features(xs, prior) {
    const steps = xs.slice(1).map((c, i) => c.close - xs[i].close), travel = steps.reduce((s, n) => s + Math.abs(n), 0);
    const positive = steps.filter((n) => n > 0), negative = steps.filter((n) => n < 0);
    const bodies = xs.map((c) => Math.abs(c.close - c.open)), ranges = xs.map((c) => c.high - c.low);
    const bodyMean = mean(bodies), stepMedian = median(steps.map(Math.abs));
    const head = xs.slice(0, Math.ceil(xs.length / 3)), tail = xs.slice(-Math.ceil(xs.length / 3));
    const slope = (cs) => mean(cs.slice(1).map((c, i) => Math.max(0, c.close - cs[i].close)));
    const reference = prior.length ? prior : head;
    const rangeRatio = ratio(median(ranges), median(reference.map((c) => c.high - c.low)));
    const maxNegativeRun = steps.reduce((s, n) => n < 0
        ? { current: s.current + 1, max: Math.max(s.max, s.current + 1) }
        : { current: 0, max: s.max }, { current: 0, max: 0 }).max;
    return {
        initialImpulseDominance: ratio(Math.max(...reference.map((c) => c.high - c.low)), median(ranges)),
        candleCompression: rangeRatio,
        bodyVariation: ratio(Math.sqrt(mean(bodies.map((n) => (n - bodyMean) ** 2))), bodyMean),
        directionalPersistence: steps.length
            ? positive.length / steps.length
            : null,
        pathEfficiency: ratio(Math.abs(xs.at(-1).close - xs[0].close), travel),
        pullbackScarcity: {
            frequency: steps.length ? negative.length / steps.length : null,
            travelShare: ratio(-negative.reduce((s, n) => s + n, 0), travel),
            medianMagnitude: median(negative.map(Math.abs)),
            maxDurationBars: maxNegativeRun,
        },
        wickScarcity: mean(xs.map((c, i) => ranges[i] > 0 ? (ranges[i] - bodies[i]) / ranges[i] : 1)),
        upperWickShare: mean(xs.map((c, i) => ranges[i] > 0 ? (c.high - Math.max(c.open, c.close)) / ranges[i] : 0)),
        lowerWickShare: mean(xs.map((c, i) => ranges[i] > 0 ? (Math.min(c.open, c.close) - c.low) / ranges[i] : 0)),
        higherLowPersistence: mean(xs.slice(1).map((c, i) => Number(c.low >= xs[i].low))),
        higherClosePersistence: mean(xs.slice(1).map((c, i) => Number(c.close >= xs[i].close))),
        pathSmoothness: ratio(median(steps.map((n) => Math.abs(n - median(steps)))), stepMedian),
        lateAcceleration: ratio(slope(tail), slope(head)),
        positiveNetPath: xs.at(-1).close > xs[0].close,
    };
}
export function analyzeManipulationStructure(h, now = Date.now()) {
    const policy = manipulationPolicy;
    const candles = h.candles
        .filter((c) => c.at + 60000 <= now &&
        c.open > 0 &&
        c.low > 0 &&
        c.high >= Math.max(c.open, c.close) &&
        c.low <= Math.min(c.open, c.close))
        .sort((a, b) => a.at - b.at)
        .slice(-61);
    const segments = [];
    let recentFeatures = null;
    let recentRange = null;
    let evaluatedSegments = 0;
    for (let start = 0; start < candles.length; start++) {
        for (let end = start + policy.minSegmentBars; end <= candles.length; end++) {
            const xs = candles.slice(start, end);
            if (xs.some((c, i) => i > 0 && c.at - xs[i - 1].at !== 60000))
                break;
            evaluatedSegments++;
            const f = features(xs, candles.slice(0, start));
            recentFeatures = f;
            recentRange = {
                from: xs[0].at,
                to: xs.at(-1).at + 60000,
                bars: xs.length,
            };
            const confluence = {
                upwardPath: f.positiveNetPath,
                efficientPath: (f.pathEfficiency ?? 0) >= policy.minPathEfficiency,
                directionalPersistence: (f.directionalPersistence ?? 0) >= policy.minDirectionalPersistence,
                scarcePullbacks: f.pullbackScarcity.travelShare !== null &&
                    f.pullbackScarcity.travelShare <= policy.maxPullbackTravelShare,
                scarceRejection: f.wickScarcity <= policy.maxMeanWickShare,
                persistentLocalFloor: f.higherLowPersistence >= policy.minHigherLowPersistence,
                smoothPath: f.pathSmoothness !== null && f.pathSmoothness <= policy.maxStepNoise,
                compressedOrRepetitive: (f.candleCompression !== null &&
                    f.candleCompression <= policy.compressionRatio) ||
                    (f.bodyVariation !== null &&
                        f.bodyVariation <= policy.maxBodyVariation),
            };
            const strong = Object.values(confluence).every(Boolean);
            const moderate = confluence.upwardPath &&
                confluence.efficientPath &&
                confluence.directionalPersistence &&
                confluence.compressedOrRepetitive;
            if (strong || moderate)
                segments.push({
                    from: xs[0].at,
                    to: xs.at(-1).at + 60000,
                    bars: xs.length,
                    status: strong ? "STRONG" : "MODERATE",
                    evidence: f,
                    confluence,
                    initialImpulseDominant: (f.initialImpulseDominance ?? 0) >= policy.impulseDominanceRatio,
                    lateAccelerationObserved: (f.lateAcceleration ?? 0) >= policy.lateAccelerationRatio,
                });
        }
    }
    segments.sort((a, b) => Number(b.status === "STRONG") - Number(a.status === "STRONG") ||
        b.to - a.to ||
        b.bars - a.bars);
    const strongest = segments[0];
    return {
        version: policy.version,
        source: h.source,
        evaluatedAt: now,
        historyFetchedAt: h.fetchedAt,
        evidenceTo: candles.at(-1) ? candles.at(-1).at + 60000 : null,
        status: evaluatedSegments === 0
            ? "INSUFFICIENT_DATA"
            : (strongest?.status ?? "LOW"),
        controlledMarkupDetected: strongest?.status === "STRONG",
        evidence: strongest?.evidence ?? recentFeatures,
        evidenceRange: strongest
            ? { from: strongest.from, to: strongest.to, bars: strongest.bars }
            : recentRange,
        suspiciousSegments: segments.slice(0, 10),
        evaluatedSegments,
        policy,
        reasons: strongest
            ? Object.entries(strongest.confluence)
                .filter(([, v]) => v)
                .map(([k]) => k)
            : ["NO_CONFLUENT_CONTROLLED_MARKUP_SEGMENT"],
        limitations: [
            "OHLCV manipulation risk inference; not RUG_CONFIRMED or a fraud prediction",
            "First visible impulse is not proven launch",
            "Bounded available M1 history; missing segments remain unknown",
            "Heuristic policy/control fixtures are not a calibrated live false-positive rate",
        ],
    };
}
