export type ChartPattern =
  | "UPTREND" | "DOWNTREND" | "BREAKOUT" | "BREAKDOWN" | "SIDEWAYS"
  | "REVERSAL" | "VOLATILITY_SPIKE" | "PUMP_AND_DUMP_CANDIDATE" | "UNKNOWN";

export interface PatternCandle {
  id?: string; at: number; open: number; high: number; low: number; close: number; volumeUsd?: number | null;
}

export interface PatternClassification {
  label: ChartPattern;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  evidence: { metric: string; value: number | string; threshold: string; candleIds: string[] }[];
  coverage: { candles: number; gaps: number; spanMinutes: number };
  note: string;
}

const median = (values: number[]) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b), middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

export function classifyChartPattern(input: readonly PatternCandle[]): PatternClassification {
  const candles = [...input].filter((c) => Number.isSafeInteger(c.at) && c.open > 0 && c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close) && c.low > 0 && Number.isFinite(c.close)).sort((a, b) => a.at - b.at);
  const gaps = candles.slice(1).filter((c, i) => c.at - candles[i]!.at > 60000).length;
  const spanMinutes = candles.length > 1 ? (candles.at(-1)!.at - candles[0]!.at) / 60000 : 0;
  const coverage = { candles: candles.length, gaps, spanMinutes: Number(spanMinutes.toFixed(1)) };
  const unknown = (note: string): PatternClassification => ({ label: "UNKNOWN", confidence: "LOW", evidence: [], coverage, note });
  if (candles.length < 20 || spanMinutes < 18) return unknown("At least 20 observed M1 candles spanning 18 minutes are required.");
  const evidence: PatternClassification["evidence"] = [];
  const returns = candles.slice(1).map((c, i) => c.close / candles[i]!.close - 1);
  const ranges = candles.map((c) => (c.high - c.low) / c.open);
  const typicalRange = median(ranges.slice(0, -1));
  const largestRange = Math.max(...ranges);
  const volumeValues = candles.filter((c) => c.volumeUsd !== null && c.volumeUsd !== undefined).map((c) => Number(c.volumeUsd)).filter(Number.isFinite);
  const volumeMedian = median(volumeValues);
  const totalReturnPct = (candles.at(-1)!.close / candles[0]!.close - 1) * 100;
  const middle = Math.max(1, Math.floor(candles.length * .65));
  const priorMovePct = (Math.max(...candles.slice(0, middle).map((c) => c.high)) / Math.min(...candles.slice(0, middle).map((c) => c.low)) - 1) * 100;
  const finalDrawdownPct = (candles.at(-1)!.close / Math.max(...candles.slice(middle).map((c) => c.high)) - 1) * 100;
  const firstLow = Math.min(...candles.slice(0, -5).map((c) => c.low));
  const recent = candles.slice(-5);
  const priorHigh = Math.max(...candles.slice(0, -5).map((c) => c.high));
  const recentClose = recent.at(-1)!.close;
  const recentVolume = median(recent.map((c) => Number(c.volumeUsd)).filter(Number.isFinite));
  const volumeRatio = volumeMedian > 0 ? recentVolume / volumeMedian : null;
  const ids = (from: number, to = candles.length) => candles.slice(from, to).map((c) => c.id).filter((id): id is string => Boolean(id)).slice(0, 16);

  const pump = priorMovePct >= 45 && finalDrawdownPct <= -30;
  if (pump) {
    evidence.push({ metric: "priorRangeExpansionPct", value: Number(priorMovePct.toFixed(2)), threshold: ">=45", candleIds: ids(0, middle) });
    evidence.push({ metric: "postPeakDrawdownPct", value: Number(finalDrawdownPct.toFixed(2)), threshold: "<=-30", candleIds: ids(middle) });
    return { label: "PUMP_AND_DUMP_CANDIDATE", confidence: gaps > 3 ? "MEDIUM" : "HIGH", evidence, coverage, note: "Price structure only; this is not a confirmed rug or intent claim." };
  }

  const volatilityRatio = typicalRange > 0 ? largestRange / typicalRange : 0;
  if (volatilityRatio >= 3 && largestRange >= .08) {
    const index = ranges.indexOf(largestRange);
    evidence.push({ metric: "rangeToMedianRatio", value: Number(volatilityRatio.toFixed(2)), threshold: ">=3 and candle range >=8%", candleIds: ids(index, index + 1) });
    return { label: "VOLATILITY_SPIKE", confidence: gaps > 3 ? "MEDIUM" : "HIGH", evidence, coverage, note: "A single observed candle range is unusually wide relative to this sample." };
  }

  if (recentClose > priorHigh * 1.005 && totalReturnPct > 5 && (volumeRatio === null || volumeRatio >= 1.2)) {
    evidence.push({ metric: "closeAbovePriorHighPct", value: Number(((recentClose / priorHigh - 1) * 100).toFixed(2)), threshold: ">0.5", candleIds: ids(candles.length - 5) });
    if (volumeRatio !== null) evidence.push({ metric: "recentVolumeRatio", value: Number(volumeRatio.toFixed(2)), threshold: ">=1.2", candleIds: ids(candles.length - 5) });
    return { label: "BREAKOUT", confidence: gaps > 3 ? "MEDIUM" : "HIGH", evidence, coverage, note: "Descriptive price structure only; not a BUY instruction." };
  }
  if (recentClose < firstLow * .995 && totalReturnPct < -5) {
    evidence.push({ metric: "closeBelowPriorLowPct", value: Number(((recentClose / firstLow - 1) * 100).toFixed(2)), threshold: "<-0.5", candleIds: ids(candles.length - 5) });
    return { label: "BREAKDOWN", confidence: gaps > 3 ? "MEDIUM" : "HIGH", evidence, coverage, note: "Descriptive price structure only; not a SELL instruction." };
  }

  const priorReturn = candles[middle]!.close / candles[0]!.close - 1;
  const recentReturn = candles.at(-1)!.close / candles[middle]!.close - 1;
  if (Math.abs(priorReturn) >= .12 && Math.sign(priorReturn) !== Math.sign(recentReturn) && Math.abs(recentReturn) >= .08) {
    evidence.push({ metric: "priorLegReturnPct", value: Number((priorReturn * 100).toFixed(2)), threshold: "absolute >=12", candleIds: ids(0, middle) });
    evidence.push({ metric: "reversalLegReturnPct", value: Number((recentReturn * 100).toFixed(2)), threshold: "opposite direction, absolute >=8", candleIds: ids(middle) });
    return { label: "REVERSAL", confidence: gaps > 3 ? "MEDIUM" : "HIGH", evidence, coverage, note: "Opposing price legs are present; direction is not a trading recommendation." };
  }

  const positiveShare = returns.filter((r) => r > 0).length / returns.length;
  if (totalReturnPct >= 12 && positiveShare >= .55) {
    evidence.push({ metric: "netReturnPct", value: Number(totalReturnPct.toFixed(2)), threshold: ">=12", candleIds: ids(0) });
    evidence.push({ metric: "positiveCloseChangeShare", value: Number(positiveShare.toFixed(3)), threshold: ">=0.55", candleIds: ids(0) });
    return { label: "UPTREND", confidence: gaps > 3 ? "MEDIUM" : "HIGH", evidence, coverage, note: "Repeated rising closes and positive net change in the observed window." };
  }
  if (totalReturnPct <= -12 && positiveShare <= .45) {
    evidence.push({ metric: "netReturnPct", value: Number(totalReturnPct.toFixed(2)), threshold: "<=-12", candleIds: ids(0) });
    evidence.push({ metric: "positiveCloseChangeShare", value: Number(positiveShare.toFixed(3)), threshold: "<=0.45", candleIds: ids(0) });
    return { label: "DOWNTREND", confidence: gaps > 3 ? "MEDIUM" : "HIGH", evidence, coverage, note: "Repeated falling closes and negative net change in the observed window." };
  }
  const fullRange = (Math.max(...candles.map((c) => c.high)) / Math.min(...candles.map((c) => c.low)) - 1) * 100;
  if (Math.abs(totalReturnPct) <= 8 && fullRange <= 25) {
    evidence.push({ metric: "netReturnPct", value: Number(totalReturnPct.toFixed(2)), threshold: "absolute <=8", candleIds: ids(0) });
    evidence.push({ metric: "windowRangePct", value: Number(fullRange.toFixed(2)), threshold: "<=25", candleIds: ids(0) });
    return { label: "SIDEWAYS", confidence: gaps > 3 ? "MEDIUM" : "HIGH", evidence, coverage, note: "No material directional movement in the observed window." };
  }
  return unknown("Candles are available but do not satisfy a supported deterministic pattern threshold.");
}
