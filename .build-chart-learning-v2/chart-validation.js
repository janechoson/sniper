import { randomUUID } from "node:crypto";
import { applies } from "./chart-features.js";
import { chartId } from "./chart-store.js";
/** Independent nonoverlapping windows; train/validation/test ordered by event time.
 * Historical labels are outcomes only, never inputs to applies(). */
export function validateLearningRule(store, rule, now = Date.now()) {
    const all = store
        .events(20000)
        .filter((e) => e.availableAt <= now)
        .sort((a, b) => a.at - b.at);
    const selected = [];
    const last = new Map();
    for (const e of all) {
        if (e.at - (last.get(e.mint) ?? -Infinity) < 3600000)
            continue;
        last.set(e.mint, e.at);
        selected.push(e);
    }
    const a = Math.floor(selected.length * 0.6), b = Math.floor(selected.length * 0.8);
    const train = selected.slice(0, a), valid = selected.slice(a, b), test = selected.slice(b);
    const measure = (rows) => {
        const matched = rows.filter((e) => {
            const f = e.preEvent.find((f) => f.window === rule.window);
            return (f &&
                f.coverage >= 0.8 &&
                rule.behaviors.length &&
                rule.behaviors.every((x) => f.behaviors.includes(x)));
        });
        const supports = matched.filter((e) => ["RUG_30", "SHARP_DECLINE"].includes(e.kind));
        const base = rows.filter((e) => ["RUG_30", "SHARP_DECLINE"].includes(e.kind)).length /
            Math.max(1, rows.length);
        const precision = supports.length / Math.max(1, matched.length);
        return {
            n: rows.length,
            matched: matched.length,
            independentTokens: new Set(matched.map((e) => e.mint)).size,
            precision,
            baseline: base,
            supportingEventIds: supports.map((e) => e.id),
            contradictoryEventIds: matched
                .filter((e) => !supports.includes(e))
                .map((e) => e.id),
        };
    };
    const validation = measure(valid), testing = measure(test);
    // Require post-hypothesis observations, not a split of already-seen evidence.
    const passed = (valid[0]?.at ?? -Infinity) > (rule.createdAt ?? rule.at) &&
        (test[0]?.at ?? -Infinity) > (valid.at(-1)?.at ?? Infinity) &&
        validation.matched >= 20 &&
        testing.matched >= 20 &&
        validation.independentTokens >= 10 &&
        testing.independentTokens >= 10 &&
        validation.precision >= 0.75 &&
        testing.precision >= 0.75 &&
        validation.precision - validation.baseline >= 0.2 &&
        testing.precision - testing.baseline >= 0.2;
    const result = {
        id: randomUUID(),
        ruleId: rule.id,
        ruleVersion: rule.version,
        definitionHash: chartId(rule.behaviors, rule.window, rule.action),
        at: now,
        passed: !!passed,
        split: {
            training: train.map((e) => e.id),
            validation: valid.map((e) => e.id),
            testing: test.map((e) => e.id),
        },
        validation,
        testing,
        policy: "chronological-independent-v1",
        limitations: [
            "Observed events and controls; not a calibrated crash probability",
            "No executable fill backtest without historical routing evidence",
        ],
    };
    store.db
        .prepare("INSERT INTO chart_validations VALUES(?,?,?)")
        .run(result.id, now, JSON.stringify(result));
    return result;
}
/** Immutable availability gates prevent future market data and rule revisions.
 * A caller must supply a chronological KRONOS strategy, never precomputed future decisions. */
export async function walkForward(store, mint, from, to, kronos) {
    const trace = [];
    for (let at = from; at <= to; at += 60000) {
        const candles = store.candles(mint, at - 3600000, at, at);
        if (candles.length < 3)
            continue;
        const rules = store
            .rules(at)
            .filter((r) => r.status === "VALIDATED" && applies(r, candles, at));
        const guard = rules.some((r) => r.action === "BLOCK") ? "BLOCK" : "PASS";
        // Exit inference still runs when entry is blocked.
        const action = await kronos(candles, at);
        trace.push({
            at,
            kronos: action,
            guard,
            codexSell: rules.some((r) => r.action === "SELL"),
            ruleIds: rules.map((r) => r.id),
        });
    }
    return {
        mint,
        from,
        to,
        trace,
        executionMetrics: null,
        limitation: "Decision replay only: historical executable quotes/fees are required for net PnL comparisons",
    };
}
