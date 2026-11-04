import { z } from "zod";
import { record } from "./gmgn.js";
export const LEARNING_VERSION = 1;
export const learningSettingsSchema = z
    .object({
    confidenceThresholds: z
        .tuple([
        z.number().int().min(2),
        z.number().int().min(3),
        z.number().int().min(4),
    ])
        .default([20, 50, 100]),
    recencyHalfLifeDays: z.number().positive().default(14),
    minimumSimilarity: z.number().min(0).max(1).default(0.7),
    minimumSharedFeatures: z.number().int().min(2).default(4),
    maxSimilarTrades: z.number().int().min(20).max(500).default(200),
    observationIntervalMs: z.number().int().min(15000).default(30000),
    checkpointSeconds: z
        .array(z.number().int().positive())
        .default([30, 60, 120, 300, 600]),
    counterfactualWindowSeconds: z.number().int().min(0).max(3600).default(600),
    counterfactualIntervalMs: z.number().int().min(30000).default(60000),
    counterfactualRequestsPerCycle: z.number().int().min(0).max(5).default(2),
    breakevenLamports: z.string().regex(/^\d+$/).default("0"),
    goodEntryMfePercent: z.number().positive().default(20),
    poorCaptureGapPercent: z.number().positive().default(20),
    badEntryMaxMfePercent: z.number().nonnegative().default(5),
    badEntryLossPercent: z.number().positive().default(10),
    counterfactualMovePercent: z.number().positive().default(20),
})
    .strict()
    .refine((s) => s.confidenceThresholds[0] < s.confidenceThresholds[1] &&
    s.confidenceThresholds[1] < s.confidenceThresholds[2], "Confidence thresholds must increase");
export const evidenceNumber = (e) => e?.state === "KNOWN" && Number.isFinite(e.value) ? e.value : null;
const number = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
const scale = (v, max, log = false) => v === null
    ? null
    : Math.min(1, Math.max(0, log ? Math.log1p(v) / Math.log1p(max) : v / max));
export function featureVector(s, confidence) {
    const marketCap = evidenceNumber(s.market.marketCap), liquidity = evidenceNumber(s.market.liquidity), volume = evidenceNumber(s.market.volume);
    const buys = evidenceNumber(s.market.buys), sells = evidenceNumber(s.market.sells);
    const history = s.intelligence.creator.history.state === "KNOWN"
        ? record(s.intelligence.creator.history.value)
        : {};
    const window = record(s.market.windows["5m"]), base = evidenceNumber(window.startPrice), price = evidenceNumber(s.market.price);
    return {
        age: scale(s.candidate.createdAt
            ? Math.max(0, (s.market.at - s.candidate.createdAt) / 1000)
            : null, 86400, true),
        marketCap: scale(marketCap, 1e9, true),
        liquidity: scale(liquidity, 1e8, true),
        volume: scale(volume, 1e9, true),
        liquidityMarketCap: scale(marketCap && liquidity !== null ? liquidity / marketCap : null, 1),
        volumeLiquidity: scale(liquidity && volume !== null ? volume / liquidity : null, 100, true),
        buyRatio: buys !== null && sells !== null && buys + sells > 0
            ? buys / (buys + sells)
            : null,
        holders: scale(evidenceNumber(s.intelligence.holders.count), 100000, true),
        top10: scale(evidenceNumber(s.intelligence.holders.top10), 100),
        developerHolding: scale(evidenceNumber(s.intelligence.creator.holdPercent), 100),
        developerHistory: scale(number(history.open_count), 100, true),
        smartMoney: scale(evidenceNumber(s.intelligence.smartMoney), 1000, true),
        rugRisk: scale(evidenceNumber(s.security.rugRatio), 1),
        momentum5m: base && price !== null
            ? Math.max(0, Math.min(1, (price / base - 1 + 1) / 2))
            : null,
        jevConfidence: confidence ?? null,
    };
}
export function similarity(a, b, minimumShared = 4) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    const shared = keys.filter((k) => a[k] !== null &&
        a[k] !== undefined &&
        b[k] !== null &&
        b[k] !== undefined);
    const available = keys.filter((k) => (a[k] !== null && a[k] !== undefined) ||
        (b[k] !== null && b[k] !== undefined)).length;
    if (shared.length < minimumShared || !available)
        return 0;
    const closeness = shared.reduce((n, k) => n + 1 - Math.min(1, Math.abs(a[k] - b[k])), 0) /
        shared.length;
    return closeness * Math.sqrt(shared.length / available);
}
export function recencyWeight(at, asOf, halfLifeDays) {
    return at > asOf
        ? 0
        : 2 ** (-Math.max(0, asOf - at) / (halfLifeDays * 86400000));
}
export function sampleConfidence(count, thresholds = [20, 50, 100]) {
    return count < thresholds[0]
        ? "INSUFFICIENT"
        : count < thresholds[1]
            ? "LOW"
            : count < thresholds[2]
                ? "MEDIUM"
                : "HIGH";
}
export function pnl(buyDelta, sellDeltas, extraConfirmedFees = 0n, tolerance = 0n) {
    if (buyDelta >= 0n)
        throw new Error("BUY must have a real SOL debit");
    const net = buyDelta +
        sellDeltas.reduce((sum, delta) => sum + delta, 0n) -
        extraConfirmedFees;
    const percent = Number((net * 1000000n) / -buyDelta) / 10000;
    return {
        netLamports: net.toString(),
        netPnlPercent: percent,
        result: net > tolerance
            ? "WIN"
            : net < -tolerance
                ? "LOSS"
                : "BREAKEVEN",
    };
}
export function excursions(values) {
    return {
        mfePercent: Math.max(0, ...values),
        maePercent: Math.min(0, ...values),
    };
}
export function exitReason(reason) {
    if ([
        "ORDER_FLOW",
        "MOMENTUM_DETERIORATION",
        "LIQUIDITY_TREND",
        "SMART_MONEY",
        "HOLDER_BEHAVIOR",
        "DEV_ACTIVITY",
        "PROFIT_MANAGEMENT",
        "HISTORY_CONTEXT",
    ].includes(reason))
        return "JEV_STRATEGIC";
    if (/manual/i.test(reason))
        return "MANUAL";
    if (/liquidity.*(collapse|removal)/i.test(reason))
        return "LIQUIDITY_COLLAPSE";
    if (/rug/i.test(reason))
        return "RUG";
    if (/security/i.test(reason))
        return "SECURITY";
    if (/stop loss/i.test(reason))
        return "STOP_LOSS";
    if (/take profit/i.test(reason))
        return "TAKE_PROFIT";
    if (/trailing profit/i.test(reason))
        return "TRAILING_PROFIT";
    if (/trailing/i.test(reason))
        return "TRAILING_STOP";
    if (/holding time/i.test(reason))
        return "MAX_HOLDING";
    return "OTHER";
}
export class OutcomeAnalyzer {
    settings;
    constructor(settings) {
        this.settings = settings;
    }
    classify(input, counterfactual = []) {
        const classifications = [], lessons = [];
        let entryQuality = "UNKNOWN", exitQuality = "UNKNOWN";
        if (input.exitReasons.includes("RUG"))
            classifications.push("RUG_AFTER_ENTRY");
        if (input.exitReasons.includes("SECURITY"))
            classifications.push("SECURITY_DETERIORATION");
        if (input.exitReasons.includes("LIQUIDITY_COLLAPSE"))
            classifications.push("LIQUIDITY_COLLAPSE");
        if (input.mfePercent >= this.settings.goodEntryMfePercent) {
            entryQuality = "GOOD";
            if (input.netPnlPercent <= 0 ||
                input.mfePercent - input.netPnlPercent >=
                    this.settings.poorCaptureGapPercent) {
                exitQuality = "POOR";
                classifications.push("GOOD_ENTRY_BAD_EXIT");
                lessons.push("PROFIT_WAS_AVAILABLE_BUT_NOT_CAPTURED");
            }
            else {
                exitQuality = "GOOD";
                classifications.push("GOOD_ENTRY_GOOD_EXIT");
            }
        }
        else if (input.coverage === "SAMPLED" &&
            input.mfePercent <= this.settings.badEntryMaxMfePercent &&
            input.netPnlPercent <= -this.settings.badEntryLossPercent &&
            input.maePercent <= -this.settings.badEntryLossPercent) {
            entryQuality = "POOR";
            classifications.push("BAD_ENTRY");
        }
        for (const o of counterfactual) {
            const change = o.tokenPriceChangeSinceExitPercent;
            if (change === undefined)
                continue;
            if (input.exitReasons.includes("TAKE_PROFIT") &&
                change >= this.settings.counterfactualMovePercent) {
                classifications.push("TAKE_PROFIT_TOO_EARLY");
                lessons.push("POST_EXIT_PRICE_ROSE_WITHOUT_ASSUMING_EXECUTABLE_PNL");
            }
            if (input.exitReasons.includes("STOP_LOSS") &&
                change <= -this.settings.counterfactualMovePercent) {
                lessons.push("STOP_LOSS_EFFECTIVE");
            }
        }
        return {
            entryQuality,
            exitQuality,
            classifications: classifications.length
                ? [...new Set(classifications)]
                : ["UNKNOWN"],
            lessons: [...new Set(lessons)],
        };
    }
}
const mean = (v) => v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
const median = (v) => {
    const sorted = [...v].sort((a, b) => a - b);
    return sorted.length
        ? (sorted[Math.floor((sorted.length - 1) / 2)] +
            sorted[Math.ceil((sorted.length - 1) / 2)]) /
            2
        : null;
};
export function aggregate(rows, settings) {
    const outcomes = rows.map((r) => r.outcome), n = outcomes.length, wins = outcomes.filter((o) => o.result === "WIN").length, losses = outcomes.filter((o) => o.result === "LOSS").length;
    const weight = rows.reduce((sum, row) => sum + row.weight, 0);
    const weighted = (f) => weight
        ? rows.reduce((sum, r) => sum + f(r.outcome) * r.weight, 0) / weight
        : null;
    const confidence = sampleConfidence(Math.min(n, weight), settings.confidenceThresholds);
    const counts = (values) => Object.entries(values.reduce((m, k) => {
        m[k] = (m[k] ?? 0) + 1;
        return m;
    }, {}))
        .sort((a, b) => b[1] - a[1])
        .map(([code, count]) => ({ code, count }));
    return {
        similarTrades: n,
        wins,
        losses,
        breakeven: n - wins - losses,
        winRate: n ? wins / n : null,
        netLamports: outcomes
            .reduce((sum, o) => sum + BigInt(o.netLamports), 0n)
            .toString(),
        avgNetPnlPercent: mean(outcomes.map((o) => o.netPnlPercent)),
        medianNetPnlPercent: median(outcomes.map((o) => o.netPnlPercent)),
        avgMfePercent: mean(outcomes.map((o) => o.mfePercent)),
        avgMaePercent: mean(outcomes.map((o) => o.maePercent)),
        weightedWinRate: weighted((o) => (o.result === "WIN" ? 1 : 0)),
        weightedAvgNetPnlPercent: weighted((o) => o.netPnlPercent),
        effectiveSamples: weight,
        confidence,
        usableForDecision: confidence !== "INSUFFICIENT",
        commonWinPatterns: counts(outcomes
            .filter((o) => o.result === "WIN")
            .flatMap((o) => o.classifications)).slice(0, 4),
        commonLossPatterns: counts(outcomes
            .filter((o) => o.result === "LOSS")
            .flatMap((o) => o.classifications)).slice(0, 4),
        exitReasons: counts(outcomes.flatMap((o) => o.exitReasons)),
        entryQuality: counts(outcomes.map((o) => o.entryQuality)),
        exitQuality: counts(outcomes.map((o) => o.exitQuality)),
    };
}
