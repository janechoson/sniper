import assert from "node:assert/strict";
import { test } from "node:test";
import { ANALYSIS_MAX_INPUT_BYTES, analysisPayloadMetrics, buildAnalysisPlan } from "../src/chart-analysis-plan.js";
import { classifyChartPattern } from "../src/chart-pattern-classifier.js";

function context(minutes: number) {
  const start = 1_700_000_000_000;
  const candles = Array.from({ length: minutes }, (_, i) => {
    const close = 1 + i * 0.003;
    return { id: `c${i}`, at: start + i * 60_000, open: close - 0.001, high: close + 0.001, low: close - 0.002, close, volumeUsd: 100 + i };
  });
  return { case: { positionId: "case", mint: "mint", mode: "DEMO", buyConfirmedAt: start + 10 * 60_000, sellConfirmedAt: start + (minutes - 1) * 60_000 }, candles, events: [], snapshots: [], decisions: [], replay: { fills: [{ executionId: "buy1", label: "ACTUAL BUY", at: start + 10 * 60_000 }, { executionId: "sell1", label: "ACTUAL SELL", at: start + (minutes - 1) * 60_000 }], accounting: {} }, followups: [], cohort: [], policy: {} };
}

test("large legacy evidence is split into bounded, measured stage inputs", () => {
  const ctx = context(601);
  const legacy = { ...ctx, duplicatedRawEvidence: "x".repeat(200_000) };
  assert.ok(analysisPayloadMetrics(legacy).bytes > ANALYSIS_MAX_INPUT_BYTES);
  const plan = buildAnalysisPlan(ctx);
  assert.ok(plan.length > 6);
  assert.ok(plan.every((task) => analysisPayloadMetrics(task.input).bytes <= ANALYSIS_MAX_INPUT_BYTES));
  assert.equal(plan.find((task) => task.key === "BUY")?.input.candles && (plan.find((task) => task.key === "BUY")!.input.candles as any[]).some((c) => c.at + 60_000 > ctx.case.buyConfirmedAt), false);
  const sell = plan.find((task) => task.key === "SELL_1")!;
  assert.ok((sell.input.candles as any[]).every((c) => c.at + 60_000 <= ctx.case.sellConfirmedAt));
  assert.equal(plan.at(-1)?.stage, "OUTCOME_COMPARISON");
});

test("60 minute and 10 hour holds remain contiguous in bounded chunks", () => {
  for (const minutes of [60, 600]) {
    const plan = buildAnalysisPlan(context(minutes));
    const hold = plan.filter((task) => task.stage === "HOLD_CHUNK");
    assert.equal(hold.reduce((sum, task) => sum + (task.input.candles as any[]).length, 0), Math.max(0, minutes - 11));
    assert.ok(hold.every((task) => (task.input.candles as any[]).length <= 96));
    for (let i = 1; i < hold.length; i++) assert.equal((hold[i]!.input.candles as any[])[0]!.at, (hold[i - 1]!.input.candles as any[]).at(-1)!.at + 60_000);
  }
});

test("classifier labels deterministic M1 uptrend and incomplete history", () => {
  const start = 1_700_000_000_000;
  const rising = Array.from({ length: 30 }, (_, i) => ({ id: `p${i}`, at: start + i * 60_000, open: 1 + i * .02, high: 1.025 + i * .02, low: .995 + i * .02, close: 1.02 + i * .02, volumeUsd: 100 }));
  assert.equal(classifyChartPattern(rising).label, "UPTREND");
  const insufficient = classifyChartPattern(rising.slice(0, 5));
  assert.equal(insufficient.label, "UNKNOWN");
  assert.equal(insufficient.coverage.candles, 5);
});
