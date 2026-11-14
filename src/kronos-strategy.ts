import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  KRONOS,
  validateCandles,
  decideForecast,
  type LabCandle,
} from "./kronos-domain.js";

// This dependency boundary has no configuration loader, provider, DB or signer.
export const kronosForecastSchema = z
  .object({
    version: z.literal("KRONOS_FORECAST_V1"),
    commit: z.literal(KRONOS.commit),
    model: z
      .object({
        id: z.literal(KRONOS.model.id),
        revision: z.literal(KRONOS.model.revision),
      })
      .strict(),
    tokenizer: z
      .object({
        id: z.literal(KRONOS.tokenizer.id),
        revision: z.literal(KRONOS.tokenizer.revision),
      })
      .strict(),
    paths: z.array(z.array(z.number().finite().positive()).length(5)).length(3),
    forecastAt: z.array(z.number().finite().int()).length(5),
    inputFrom: z.number().finite().int(),
    inputTo: z.number().finite().int(),
    latestClosedCandleAt: z.number().finite().int(),
    decisionAt: z.number().finite().int(),
    volumeMode: z.literal("PRICE_ONLY_OPTIONAL_CHANNELS_DISABLED"),
    priceScale: z.number().finite().positive(),
    seed: z.literal(1701),
    samples: z.literal(3),
    temperature: z.literal(1),
    topP: z.literal(0.9),
    eval: z.literal(true),
    inferenceMode: z.literal(true),
    loadMs: z.number().finite().nonnegative(),
    latencyMs: z.number().finite().nonnegative(),
    rssBytes: z
      .number()
      .finite()
      .nonnegative()
      .max(768 * 1024 * 1024),
    limitations: z.array(z.string().max(500)).max(20),
  })
  .strict();
export type KronosDecision = {
  strategy: "KRONOS";
  decisionId: string;
  decisionAt: number;
  action: "BUY" | "WAIT" | "HOLD" | "SELL";
  reason: string;
  evidence: {
    model: string;
    revision: string;
    tokenizerRevision: string;
    inputFrom: number;
    inputTo: number;
    candleCount: number;
    horizon: 5;
    samples: 3;
    terminalPrices: number[];
    terminalRangePct: number[];
    lastObservedClose: number;
  };
};
export interface KronosInference {
  forecast(candles: LabCandle[], decisionAt: number): Promise<unknown>;
  stop(): void;
  status(): unknown;
}
export interface KronosDecisionStrategy {
  evaluateEntry(input: { candles: LabCandle[] }): Promise<KronosDecision>;
  evaluatePosition(input: { candles: LabCandle[] }): Promise<KronosDecision>;
  stop(): void;
  status(): unknown;
}
function codedError(code: string) {
  return Object.assign(Error(code), { code });
}
function safeFailureCode(error: unknown) {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{1,80}$/.test(code))
      return code;
  }
  if (
    error instanceof Error &&
    /^[A-Z][A-Z0-9_]{1,80}$/.test(error.message)
  )
    return error.message;
  return "KRONOS_INFERENCE_FAILED";
}
export class KronosStrategy implements KronosDecisionStrategy {
  private active = false;
  private stopped = false;
  private queue: Array<{
    position: boolean;
    input: LabCandle[];
    resolve: (d: KronosDecision) => void;
    reject: (e: Error) => void;
  }> = [];
  constructor(private inference: KronosInference) {}
  evaluateEntry(input: { candles: LabCandle[] }) {
    return this.enqueue(input.candles, false);
  }
  evaluatePosition(input: { candles: LabCandle[] }) {
    return this.enqueue(input.candles, true);
  }
  private enqueue(candles: LabCandle[], position: boolean) {
    if (this.stopped || this.queue.length >= 100)
      return Promise.reject(codedError("KRONOS_UNAVAILABLE"));
    // Explicit projection: arbitrary caller fields never enter the worker request.
    const input = candles.map(({ at, open, high, low, close }) => ({
      at,
      open,
      high,
      low,
      close,
    }));
    return new Promise<KronosDecision>((resolve, reject) => {
      this.queue.push({ position, input, resolve, reject });
      void this.pump();
    });
  }
  private async pump() {
    if (this.active || this.stopped) return;
    const index = Math.max(
      0,
      this.queue.findIndex((j) => j.position),
    );
    const job = this.queue.splice(index, 1)[0];
    if (!job) return;
    this.active = true;
    try {
      const at = Date.now();
      validateCandles(job.input, at);
      const output = kronosForecastSchema.parse(
        await this.inference.forecast(job.input, at),
      );
      if (output.decisionAt !== at) throw Error("KRONOS_REQUEST_MISMATCH");
      const decision = decideForecast(
        output,
        job.input,
        job.position,
        Date.now(),
      );
      const action =
        decision.action === "PAPER_BUY"
          ? "BUY"
          : decision.action === "PAPER_SELL"
            ? "SELL"
            : decision.action;
      if (action === "UNAVAILABLE") throw Error("KRONOS_INVALID_DECISION");
      job.resolve({
        strategy: "KRONOS",
        decisionId: randomUUID(),
        decisionAt: at,
        action,
        reason: decision.reason,
        evidence: {
          model: KRONOS.model.id,
          revision: KRONOS.model.revision,
          tokenizerRevision: KRONOS.tokenizer.revision,
          inputFrom: output.inputFrom,
          inputTo: output.inputTo,
          candleCount: job.input.length,
          horizon: 5,
          samples: 3,
          terminalPrices: output.paths.map((p) => p.at(-1)!),
          terminalRangePct: decision.terminalRangePct!,
          lastObservedClose: decision.lastObservedClose!,
        },
      });
    } catch (error) {
      job.reject(codedError(safeFailureCode(error)));
    } finally {
      this.active = false;
      void this.pump();
    }
  }
  stop() {
    this.stopped = true;
    for (const j of this.queue.splice(0)) j.reject(Error("KRONOS_STOPPED"));
    this.inference.stop();
  }
  status() {
    return {
      active: this.active,
      queued: this.queue.length,
      concurrency: 1,
      worker: this.inference.status(),
    };
  }
}
