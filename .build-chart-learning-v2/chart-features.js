export const CHART_POLICY = "chart-learning-v1";
export function validChartCandle(c, availableAt) {
    return (Number.isSafeInteger(c.at) &&
        c.at >= 0 &&
        c.at + 60000 <= availableAt &&
        [c.open, c.high, c.low, c.close].every((n) => Number.isFinite(n) && n > 0) &&
        c.low <= Math.min(c.open, c.close) &&
        c.high >= Math.max(c.open, c.close) &&
        (c.volumeUsd === null || (Number.isFinite(c.volumeUsd) && c.volumeUsd >= 0)));
}
export function rugDrop(c) {
    return ((c.open - c.low) / c.open) * 100;
}
/** Cutoff is an availability boundary, never the event candle's close. */
export function chartFeatures(candles, cutoff, minutes = 15) {
    const rows = candles
        .filter((c) => validChartCandle(c, cutoff) && c.at >= cutoff - minutes * 60000)
        .sort((a, b) => a.at - b.at);
    const f = {
        window: minutes,
        count: rows.length,
        coverage: rows.length / minutes,
        returnPct: null,
        momentumChange: null,
        volumeRatio: null,
        volatility: null,
        drawdownPct: null,
        behaviors: [],
    };
    if (rows.length < 3)
        return f;
    const first = rows[0], last = rows.at(-1), half = Math.floor(rows.length / 2), mid = rows[half];
    f.returnPct = (last.close / first.open - 1) * 100;
    f.momentumChange =
        (last.close / mid.open - 1 - (mid.open / first.open - 1)) * 100;
    const volumes = rows.map((c) => c.volumeUsd);
    if (volumes.every((v) => v !== null)) {
        const a = volumes.slice(0, half).reduce((s, n) => s + n, 0) / half;
        const b = volumes.slice(half).reduce((s, n) => s + n, 0) /
            (rows.length - half);
        f.volumeRatio = a > 0 ? b / a : null;
    }
    const returns = rows
        .slice(1)
        .map((c, i) => Math.log(c.close / rows[i].close));
    const mean = returns.reduce((s, n) => s + n, 0) / returns.length;
    f.volatility =
        Math.sqrt(returns.reduce((s, n) => s + (n - mean) ** 2, 0) / returns.length) * 100;
    f.drawdownPct = (last.close / Math.max(...rows.map((c) => c.high)) - 1) * 100;
    if (f.returnPct > 0 && f.returnPct < 20)
        f.behaviors.push("SLOW_RISE");
    if (f.returnPct >= 20)
        f.behaviors.push("RAPID_RISE");
    if (f.returnPct <= -10)
        f.behaviors.push("DECLINE");
    if (f.volumeRatio !== null && f.volumeRatio < 0.6)
        f.behaviors.push("WEAKENING_VOLUME");
    if (f.momentumChange < -3)
        f.behaviors.push("MOMENTUM_EXHAUSTION");
    if (f.drawdownPct < -15)
        f.behaviors.push("DRAWDOWN");
    if (f.volatility > 8)
        f.behaviors.push("VOLATILITY_EXPANSION");
    return f;
}
export function preEventFeatures(candles, eventAt) {
    return [5, 15, 30, 60].map((w) => chartFeatures(candles, eventAt, w));
}
export function applies(rule, candles, cutoff) {
    const f = chartFeatures(candles, cutoff, rule.window);
    return (f.coverage >= 0.8 &&
        rule.behaviors.length > 0 &&
        rule.behaviors.every((b) => f.behaviors.includes(b)));
}
