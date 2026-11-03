import { randomUUID } from "node:crypto";
import type { Jev } from "./jev.js";
import type { Settings } from "./config.js";
import type { JevExitDecision } from "./domain.js";
import { Http, hash, safeError } from "./util.js";

export interface ExitJob {
  strategy?: "STANDARD" | "KRONOS";
  exitLiquidityEvidence?: JevExitDecision["exitLiquidityEvidence"];
  evidenceKey?: string;
  materialKey?: string;
  priceUsd?: number;
  inputAt?: number;
  revision?: number;
  flow?: JevExitDecision["observedFlow"];
  positionId: string;
  mint: string;
  quantity: string;
  value: string;
  state: unknown;
  priority: number;
  queuedAt: number;
  observed?: JevExitDecision["observed"];
}
/** Small in-process queue: no wallet access, no transaction execution and no monitor awaits. */
export class JevExitScheduler {
  private jobs = new Map<string, ExitJob>();
  private active = new Set<string>();
  private activeKeys = new Map<string, string>();
  private stopped = false;
  private completed = 0;
  private totalLatency = 0;
  private failures = 0;
  private lastSuccessAt?: number;
  private starts: number[] = [];
  private clients = Array.from({ length: 4 }, () => new Http("JEV_EXIT", 1000));
  constructor(
    private jev: Jev,
    private settings: () => Settings,
    private apply: (decision: JevExitDecision, job: ExitJob) => void,
    private eligible: (job: ExitJob) => boolean = () => true,
  ) {}
  schedule(job: ExitJob) {
    if (this.stopped || job.strategy === "KRONOS") return false;
    const material = job.materialKey ?? hash(job.state);
    if (
      this.active.has(job.positionId) &&
      this.activeKeys.get(job.positionId) === material
    ) {
      this.jobs.delete(job.positionId);
      return false;
    }
    const prior = this.jobs.get(job.positionId);
    if (
      !prior &&
      !this.active.has(job.positionId) &&
      [...this.jobs.keys()].filter((id) => !this.active.has(id)).length >=
        this.settings().jevExitQueueSize
    )
      return false;
    this.jobs.set(job.positionId, {
      ...structuredClone(job),
      queuedAt: prior?.queuedAt ?? job.queuedAt,
    });
    void this.pump();
    return true;
  }
  private async pump() {
    while (
      !this.stopped &&
      this.active.size < this.settings().jevExitConcurrency &&
      this.jobs.size
    ) {
      const job = [...this.jobs.values()]
        .filter((j) => !this.active.has(j.positionId))
        .sort(
          (a, b) =>
            b.priority +
            (Date.now() - b.queuedAt) / 1000 -
            (a.priority + (Date.now() - a.queuedAt) / 1000),
        )[0];
      if (!job) break;
      this.jobs.delete(job.positionId);
      if (!this.eligible(job)) continue;
      this.active.add(job.positionId);
      this.activeKeys.set(job.positionId, job.materialKey ?? hash(job.state));
      const client = this.clients.find(
        (_, index) => !this.busyClients.has(index),
      )!;
      const index = this.clients.indexOf(client);
      this.busyClients.add(index);
      void this.run(job, client).finally(() => {
        this.active.delete(job.positionId);
        this.activeKeys.delete(job.positionId);
        this.busyClients.delete(index);
        void this.pump();
      });
    }
  }
  private busyClients = new Set<number>();
  private async run(job: ExitJob, client: Http) {
    const at = Date.now();
    this.starts = [...this.starts.filter((t) => at - t < 60000), at].slice(
      -300,
    );
    const decision: JevExitDecision = {
      id: randomUUID(),
      positionId: job.positionId,
      mint: job.mint,
      createdAt: at,
      inputAt: job.inputAt ?? job.queuedAt,
      positionRevision: job.revision ?? 0,
      observedFlow: job.flow,
      flowSignalKey: job.flow?.signalKey,
      inputPriceUsd: job.priceUsd,
      model: "jev-1.14.0",
      action: "NO_DECISION",
      decisionState: "NO_DECISION_PROVIDER_FAILURE",
      evidenceKey: job.evidenceKey,
      exitLiquidityEvidence: job.exitLiquidityEvidence,
      sellBps: 0,
      confidence: 0,
      reason: "PROVIDER_UNAVAILABLE",
      inputHash: hash(job.state),
      quantity: job.quantity,
      inputValueLamports: job.value,
      status: "DECIDED",
      observed: job.observed,
    };
    try {
      const answer = await this.jev.decideExit(job.state, client);
      decision.analystResponse =
        answer.analystResponse ?? structuredClone(answer);
      if (answer.action === "NO_DECISION") {
        decision.decisionState =
          answer.decisionState ?? "NO_DECISION_INSUFFICIENT_DATA";
        decision.reason = answer.reason;
        decision.status = "FAILED";
        decision.error = decision.decisionState;
      } else {
        if (
          !["HOLD", "PARTIAL_SELL", "FULL_SELL"].includes(answer.action) ||
          !Number.isInteger(answer.sellBps) ||
          answer.sellBps < 0 ||
          answer.sellBps > 10000 ||
          ![0, 1000, 2000, 2500, 5000, 7500, 10000].includes(answer.sellBps) ||
          !Number.isFinite(answer.confidence) ||
          answer.confidence < 0 ||
          answer.confidence > 1 ||
          (answer.action === "PARTIAL_SELL" &&
            (answer.sellBps === 0 || answer.sellBps === 10000)) ||
          (answer.action === "FULL_SELL" && answer.sellBps !== 10000) ||
          (answer.action === "HOLD" && answer.sellBps !== 0)
        )
          throw new Error("INVALID_JEV_EXIT_DECISION");
        Object.assign(decision, {
          action: answer.action,
          sellBps: answer.sellBps,
          confidence: answer.confidence,
          reason: answer.reason,
          thesis: answer.thesis,
          flowAssessment: answer.flowAssessment,
          invalidationSignals: answer.invalidationSignals?.slice(0, 8),
          reevaluateOn: answer.reevaluateOn?.slice(0, 8),
          decisionState: `DECIDED_${answer.action}`,
        });
        if (answer.confidence < this.settings().jevExitMinConfidence) {
          decision.action = "NO_DECISION";
          decision.sellBps = 0;
          decision.reason = "LOW_CONFIDENCE";
          decision.decisionState = "NO_DECISION_LOW_CONFIDENCE";
          decision.status = "FAILED";
        }
      }
      this.lastSuccessAt = Date.now();
    } catch (error) {
      decision.error = safeError(error);
      decision.status = "FAILED";
      decision.action = "NO_DECISION";
      decision.sellBps = 0;
      const code =
        error instanceof Error
          ? "code" in error
            ? String(error.code)
            : error.message
          : "";
      decision.decisionState = /TIMEOUT/.test(code)
        ? "NO_DECISION_TIMEOUT"
        : /INVALID_RESPONSE|INVALID_JSON/.test(code)
          ? "NO_DECISION_INVALID_RESPONSE"
          : /INVALID_JEV|ZodError/.test(code) ||
              (error instanceof Error && error.name === "ZodError")
            ? "NO_DECISION_SCHEMA_FAILURE"
            : "NO_DECISION_PROVIDER_FAILURE";
    }
    if (decision.action === "NO_DECISION") this.failures++;
    decision.latencyMs = Date.now() - at;
    this.completed++;
    this.totalLatency += decision.latencyMs;
    if (!this.stopped) this.apply(decision, job);
  }
  status() {
    return {
      queued: this.jobs.size,
      active: this.active.size,
      dirty: [...this.jobs.keys()].filter((id) => this.active.has(id)).length,
      concurrency: this.settings().jevExitConcurrency,
      completed: this.completed,
      failures: this.failures,
      callsLastMinute: this.starts.filter((t) => Date.now() - t < 60000).length,
      averageLatencyMs: this.completed
        ? Math.round(this.totalLatency / this.completed)
        : null,
      lastSuccessAt: this.lastSuccessAt ?? null,
    };
  }
  async idle() {
    while (this.jobs.size || this.active.size)
      await new Promise<void>((r) => setTimeout(r, 5));
  }
  remove(positionId: string) {
    this.jobs.delete(positionId);
  }
  isActive(positionId: string) {
    return this.active.has(positionId);
  }
  async stop() {
    this.stopped = true;
    this.jobs.clear();
    await this.idle();
  }
}
