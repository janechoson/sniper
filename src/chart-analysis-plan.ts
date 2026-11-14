import { createHash } from "node:crypto";

export const ANALYSIS_MAX_INPUT_BYTES = 36_000;
export const ANALYSIS_MAX_ENVELOPE_BYTES = 50_000;
export const HOLD_CANDLE_CHUNK = 96;
const PRE_BUY_CANDLE_WINDOW = 120;
const PRE_SELL_CANDLE_WINDOW = 120;

export type AnalysisStage = "PRE_BUY_REVIEW" | "HOLD_CHUNK" | "PRE_SELL_REVIEW" | "OUTCOME_COMPARISON";
export interface AnalysisTask {
  key: string;
  stage: AnalysisStage;
  input: Record<string, unknown>;
}

export function inputEvidenceIds(input: Record<string, any>) {
  const values = [
    ...(Array.isArray(input.candles) ? input.candles : []),
    ...(Array.isArray(input.events) ? input.events : []),
    ...(Array.isArray(input.snapshots) ? input.snapshots : []),
    ...(Array.isArray(input.decisions) ? input.decisions : []),
    input.execution, input.entryExecution,
  ];
  return new Set(values.filter(Boolean).map((value: any) => String(value.id ?? value.evidenceId ?? value.executionId ?? "")).filter(Boolean));
}

const candle = (row: any) => ({
  id: String(row.id ?? ""), at: Number(row.at), open: Number(row.open), high: Number(row.high),
  low: Number(row.low), close: Number(row.close), volumeUsd: row.volumeUsd == null ? null : Number(row.volumeUsd),
});
const event = (row: any) => ({
  id: String(row.id ?? ""), kind: String(row.kind ?? "UNKNOWN"), at: Number(row.at),
  dropPercent: Number.isFinite(Number(row.dropPercent)) ? Number(row.dropPercent) : null,
  evidenceAvailableAt: Number(row.evidenceAvailableAt ?? row.availableAt ?? row.at),
  phase: String(row.casePhase ?? "UNKNOWN"),
  indicators: compactObject(row.preEvent ?? row.features ?? {}, 12),
});
function compactObject(value: unknown, maxKeys = 16): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (Object.keys(result).length >= maxKeys) break;
    if (raw === null || typeof raw === "boolean" || typeof raw === "number") result[key] = raw;
    else if (typeof raw === "string") result[key] = raw.slice(0, 240);
    else if (Array.isArray(raw)) result[key] = raw.slice(0, 8).map((v) => typeof v === "string" ? v.slice(0, 120) : v);
  }
  return result;
}
function snapshot(row: any) {
  const source = row?.payload;
  if (!source || typeof source !== "object") return { id: String(row?.id ?? ""), at: Number(row?.at), values: {} };
  // Snapshot payloads can contain duplicate provider responses; retain small scalar market/safety evidence only.
  const allowed = /price|liquidity|volume|market.?cap|flow|security|risk|momentum|source|quality|age|holder|slippage/i;
  const flat: Record<string, unknown> = {};
  const visit = (value: unknown, prefix = "", depth = 0) => {
    if (depth > 2 || Object.keys(flat).length >= 28 || !value || typeof value !== "object") return;
    for (const [key, part] of Object.entries(value as Record<string, unknown>)) {
      if (Object.keys(flat).length >= 28) break;
      const name = prefix ? `${prefix}.${key}` : key;
      if (part && typeof part === "object" && !Array.isArray(part)) visit(part, name, depth + 1);
      else if (allowed.test(name) && (part === null || typeof part === "boolean" || typeof part === "number" || typeof part === "string"))
        flat[name] = typeof part === "string" ? part.slice(0, 160) : part;
    }
  };
  visit(source);
  return { id: String(row.id), at: Number(row.at), phase: String(row.phase ?? "UNKNOWN"), values: flat };
}
function decision(row: any) {
  const raw = row?.payload && typeof row.payload === "object" ? row.payload : {};
  return {
    id: String(row.decision_id ?? row.id ?? ""), source: String(row.source ?? "UNKNOWN"),
    at: Number(row.at), action: String(row.action ?? "UNKNOWN"), simulated: Boolean(row.simulated),
    reason: String(raw.reason ?? raw.summary ?? "").slice(0, 480),
    evidenceIds: Array.isArray(raw.evidenceIds) ? raw.evidenceIds.slice(0, 12) : [],
    behaviors: Array.isArray(raw.observedBehaviors) ? raw.observedBehaviors.slice(0, 12) : [],
  };
}

export function buildAnalysisPlan(context: any): AnalysisTask[] {
  const buyAt = Number(context.case.buyConfirmedAt), sellAt = Number(context.case.sellConfirmedAt ?? context.case.closedAt);
  const bars = (context.candles ?? []).map(candle).filter((c: any) => Number.isFinite(c.at) && Number.isFinite(c.open) && Number.isFinite(c.close));
  const events = (context.events ?? []).map(event);
  const snapshots = (context.snapshots ?? []).map(snapshot);
  const decisions = (context.decisions ?? []).map(decision);
  const fills = (context.replay?.fills ?? []).map((f: any) => {
    const label = String(f.label ?? "").toUpperCase();
    const side = String(f.side ?? (label.includes("BUY") ? "BUY" : label.includes("SELL") ? "SELL" : "UNKNOWN")).toUpperCase();
    const accounting = f.evidence?.accounting ?? {};
    return {
      executionId: String(f.executionId ?? f.id ?? ""), side,
      at: Number(f.at), price: f.price == null ? null : Number(f.price),
      quantity: f.quantity ?? accounting.quantityAtomic ?? null,
      fee: f.fee ?? accounting.networkFeeLamports ?? accounting.feeUsd ?? null,
      simulated: Boolean(f.simulated),
    };
  });
  const identity = {
    caseId: String(context.case.positionId ?? context.case.caseId ?? ""),
    mint: String(context.case.mint ?? ""), mode: String(context.case.mode ?? "unknown"),
    strategy: String(context.case.strategy ?? "unknown"), buyAt, sellAt,
  };
  const tasks: AnalysisTask[] = [];
  const buyCandles = bars.filter((c: any) => c.at + 60000 <= buyAt).slice(-PRE_BUY_CANDLE_WINDOW);
  const buyEvents = events.filter((e: any) => e.at <= buyAt && e.evidenceAvailableAt <= buyAt);
  const buySnapshots = snapshots.filter((s: any) => s.at <= buyAt).slice(-8);
  const buyDecisions = decisions.filter((d: any) => d.at <= buyAt).slice(-20);
  tasks.push({ key: "BUY", stage: "PRE_BUY_REVIEW", input: {
    task: "PRE_BUY_DECISION_REVIEW", identity, decisionCutoff: buyAt,
    instructions: "Review the actual BUY decision using only the supplied candles, snapshots, decisions and events available at or before decisionCutoff. No exit data, future candles, PnL, or outcome is present. Return evidence-backed quality and uncertainty; do not infer correctness from eventual profit.",
    candles: buyCandles, events: buyEvents, snapshots: buySnapshots, decisions: buyDecisions,
    execution: fills.find((f: any) => f.side === "BUY"),
  }});

  const holding = bars.filter((c: any) => c.at >= buyAt && c.at + 60000 <= sellAt);
  for (let offset = 0, chunk = 0; offset < holding.length; offset += HOLD_CANDLE_CHUNK, chunk++) {
    const part = holding.slice(offset, offset + HOLD_CANDLE_CHUNK);
    tasks.push({ key: `HOLD_${chunk + 1}`, stage: "HOLD_CHUNK", input: {
      task: "HOLD_PERIOD_CHART_CHUNK", identity, chunkIndex: chunk + 1,
      chunkCount: Math.ceil(holding.length / HOLD_CANDLE_CHUNK), from: part[0]?.at, to: part.at(-1)?.at,
      instructions: "Describe this contiguous hold-period chunk only. Do not recommend or invent trades. Use the supplied timestamps and OHLCV; state what is observable and uncertainty.",
      candles: part, events: events.filter((e: any) => e.at >= (part[0]?.at ?? 0) && e.at <= (part.at(-1)?.at ?? 0)),
    }});
  }

  const sellFills = fills.filter((f: any) => f.side === "SELL").sort((a: any, b: any) => a.at - b.at);
  for (let index = 0; index < sellFills.length; index++) {
    const fill = sellFills[index] as any;
    const prefix = bars.filter((c: any) => c.at + 60000 <= fill.at).slice(-PRE_SELL_CANDLE_WINDOW);
    tasks.push({ key: `SELL_${index + 1}`, stage: "PRE_SELL_REVIEW", input: {
      task: "PRE_SELL_DECISION_REVIEW", identity, decisionCutoff: fill.at, execution: fill,
      entryExecution: fills.find((f: any) => f.side === "BUY"),
      instructions: "Review this specific actual SELL using only information available at or before this sell execution. Do not use later sells, post-sell candles, final PnL, or future extrema. Assess exit rationale and uncertainty, not outcome luck.",
      candles: prefix, events: events.filter((e: any) => e.at <= fill.at && e.evidenceAvailableAt <= fill.at),
      snapshots: snapshots.filter((s: any) => s.at <= fill.at).slice(-8),
      decisions: decisions.filter((d: any) => d.at <= fill.at).slice(-20),
    }});
  }

  const cohort = (context.cohort ?? []).slice(0, 8).map((item: any) => ({
    caseId: String(item.caseId), mint: String(item.mint), mode: String(item.mode),
    simulated: Boolean(item.simulated), realizedPnlPct: item.realizedPnlPct ?? null,
    mfePct: item.mfePct ?? null, maePct: item.maePct ?? null,
    eventKinds: (item.eventSamples ?? []).slice(0, 8).map((e: any) => ({ kind: String(e.kind), at: Number(e.at) })),
  }));
  const replay = context.replay ?? {};
  const outcome = {
    task: "OUTCOME_COMPARISON_AND_HYPOTHESIS", identity,
    instructions: "Compare the saved decision-time BUY/SELL reviews with the actual outcome. Do not rewrite their original information set. Consider realistic execution costs and uncertainty. Create a hypothesis only when the cohort evidence supports it; null is acceptable.",
    decisionReviews: [], holdChunkKeys: tasks.filter((t) => t.stage === "HOLD_CHUNK").map((t) => t.key),
    fills, pnl: compactObject(replay.accounting ?? context.case.accounting ?? {}, 24),
    mfePct: replay.maximumFavorableExcursion ?? null, maePct: replay.maximumAdverseExcursion ?? null,
    followups: (context.followups ?? []).slice(0, 4).map((f: any) => ({ horizon: f.horizon, state: f.state, payload: compactObject(f.payload, 8) })),
    cohort, cohortCaseIds: cohort.map((c: any) => c.caseId),
    knownEventIds: events.slice(0, 100).map((e: any) => e.id),
    policy: context.policy,
  };
  tasks.push({ key: "OUTCOME", stage: "OUTCOME_COMPARISON", input: outcome });
  return tasks;
}

export function analysisPayloadMetrics(input: unknown) {
  const serialized = JSON.stringify(input);
  const bytes = Buffer.byteLength(serialized, "utf8");
  return { bytes, estimatedTokens: Math.ceil(bytes / 3.5), sha256: createHash("sha256").update(serialized).digest("hex") };
}

export function boundedAnalysisInput(input: Record<string, unknown>) {
  const metrics = analysisPayloadMetrics(input);
  if (metrics.bytes > ANALYSIS_MAX_INPUT_BYTES)
    throw Error(`CODEX_INPUT_TOO_LARGE:bytes=${metrics.bytes}:estimatedTokens=${metrics.estimatedTokens}`);
  return { input, metrics };
}
