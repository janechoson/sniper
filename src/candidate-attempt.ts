import { randomUUID } from "node:crypto";
import type { Store } from "./store.js";
import type { Candidate, Strategy, RiskResult } from "./domain.js";
import { env } from "./config.js";
import { safeError } from "./util.js";

export const ATTEMPT_STAGES = [
  "CHEAP_FILTER",
  "SECURITY",
  "COMPATIBILITY",
  "HISTORY",
  "CAPITAL_FLOW",
  "COMMON_RISK",
  "KRONOS",
  "STRUCTURE",
  "JEV",
  "RISK",
  "FINAL_ANALYSIS",
  "OWNERSHIP_CAPITAL",
  "BUY_QUOTE",
  "EXIT_FEASIBILITY",
  "VALIDATE",
  "SIMULATE",
  "PRE_SIGN",
  "BUY",
  "POSITION",
] as const;
export type AttemptStage = (typeof ATTEMPT_STAGES)[number];
export type StageStatus = "PENDING" | "CHECKING" | "PASS" | "FAIL" | "SKIPPED";
export interface StrategyEvaluation {
  strategy: Strategy;
  decision: "CHECKING" | "BUY" | "WAIT" | "REJECT" | "ERROR";
  decisionId?: string;
  decisionAt?: number;
  execution: string;
  owner?: Strategy;
  reason?: string;
  decisionReason?: string;
  executionReason?: string;
  risk?: RiskResult;
  stages: Partial<Record<AttemptStage, StageStatus>>;
}
export interface CandidateAttempt {
  attemptId: string;
  mode: string;
  mint: string;
  symbol?: string;
  source: "GMGN_TRENDING";
  startedAt: number;
  endedAt?: number;
  result: "RUNNING" | "REJECTED" | "BOUGHT" | "RECONCILING";
  stage: AttemptStage;
  failedStage?: AttemptStage;
  reasonCode?: string;
  reasonDetail?: string;
  stages: Record<AttemptStage, StageStatus>;
  summaries: Record<string, unknown>;
  logs: Array<{
    at: number;
    stage: AttemptStage;
    status: StageStatus;
    message: string;
  }>;
}

/** Audit is a sink. No prior attempt is consulted by the entry decision. */
export class CandidateAttempts {
  current?: CandidateAttempt;
  private listeners = new Set<() => void>();
  constructor(private store: Store) {
    // Crash recovery never restores approval or retries an unfinished candidate.
    for (const row of store.db
      .prepare(
        "SELECT payload FROM candidate_attempts WHERE mode=? AND result='RUNNING'",
      )
      .all(env.TRADING_MODE)) {
      const a = JSON.parse(String(row.payload)) as CandidateAttempt;
      const execution = store
        .executions()
        .find((e) => e.intent.id === a.summaries.intentId);
      const confirmed =
        execution?.state === "CONFIRMED" &&
        store
          .positions(execution.intent.mode)
          .some(
            (p) => p.id === execution.intent.positionId && p.state === "OPEN",
          );
      const signed =
        !!execution?.signature &&
        store.pending().some((e) => e.id === execution.id);
      a.result = confirmed ? "BOUGHT" : signed ? "RECONCILING" : "REJECTED";
      a.endedAt = Date.now();
      if (confirmed) a.stages.BUY = a.stages.POSITION = "PASS";
      else a.reasonCode = "PROCESS_INTERRUPTED";
      if (a.result === "REJECTED") {
        a.failedStage = a.stage;
        a.stages[a.stage] = "FAIL";
      }
      store.db
        .prepare("UPDATE candidate_attempts SET result=?,payload=? WHERE id=?")
        .run(a.result, JSON.stringify(a), a.attemptId);
    }
    const latest = store.db
      .prepare(
        "SELECT payload FROM candidate_attempts WHERE mode=? ORDER BY started_at DESC LIMIT 1",
      )
      .get(env.TRADING_MODE);
    if (latest) this.current = JSON.parse(String(latest.payload));
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  reconcile() {
    const a = this.current;
    if (a?.result !== "RECONCILING") return;
    const e = this.store
      .executions()
      .find((e) => e.intent.id === a.summaries.intentId);
    if (
      e?.state === "CONFIRMED" &&
      this.store
        .positions(e.intent.mode)
        .some((p) => p.id === e.intent.positionId && p.state === "OPEN")
    ) {
      a.result = "BOUGHT";
      a.stages.BUY = a.stages.POSITION = "PASS";
      a.reasonCode = a.reasonDetail = undefined;
      a.failedStage = undefined;
      a.logs.push({
        at: Date.now(),
        stage: "POSITION",
        status: "PASS",
        message: "BUY confirmed · Position reconciled",
      });
      this.persist();
    } else if (e?.state === "FAILED") {
      a.result = "REJECTED";
      a.reasonCode = "TRANSACTION_FAILED_AFTER_RECONCILIATION";
      this.persist();
    }
  }
  begin(candidate: Candidate) {
    if (this.current?.result === "RUNNING")
      throw Error("CANDIDATE_ATTEMPT_BUSY");
    this.current = {
      attemptId: randomUUID(),
      mode: env.TRADING_MODE,
      mint: candidate.mint,
      symbol: candidate.symbol,
      source: "GMGN_TRENDING",
      startedAt: Date.now(),
      result: "RUNNING",
      stage: "CHEAP_FILTER",
      stages: Object.fromEntries(
        ATTEMPT_STAGES.map((s) => [s, "PENDING"]),
      ) as CandidateAttempt["stages"],
      summaries: {},
      logs: [],
    };
    this.update("CHEAP_FILTER", "CHECKING", "Bắt đầu Fresh Attempt");
    return this.current;
  }
  update(
    stage: AttemptStage,
    status: StageStatus,
    message = stage + ": " + status,
  ) {
    const a = this.current;
    if (!a || a.result !== "RUNNING") return;
    a.stage = stage;
    a.stages[stage] = status;
    a.logs.push({
      at: Date.now(),
      stage,
      status,
      message: message.slice(0, 500),
    });
    a.logs = a.logs.slice(-100);
    this.persist();
  }
  summary(key: string, value: unknown) {
    if (this.current) {
      this.current.summaries[key] = value;
      this.persist();
    }
  }
  private mutateAttempt(id: string, mutate: (a: CandidateAttempt) => void) {
    const row =
      this.current?.attemptId === id
        ? undefined
        : this.store.db
            .prepare("SELECT payload FROM candidate_attempts WHERE id=?")
            .get(id);
    const a =
      this.current?.attemptId === id
        ? this.current
        : row
          ? (JSON.parse(String(row.payload)) as CandidateAttempt)
          : undefined;
    if (!a) return;
    mutate(a);
    this.persist(a);
  }
  summaryFor(id: string, key: string, value: unknown) {
    this.mutateAttempt(id, (a) => {
      a.summaries[key] = value;
    });
  }
  logFor(
    id: string,
    stage: AttemptStage,
    status: StageStatus,
    message: string,
  ) {
    this.mutateAttempt(id, (a) => {
      a.logs.push({
        at: Date.now(),
        stage,
        status,
        message: message.slice(0, 500),
      });
    });
  }
  strategy(id: string, strategy: Strategy, patch: Partial<StrategyEvaluation>) {
    this.mutateAttempt(id, (a) => {
      const all = (a.summaries.strategies ?? {}) as Partial<
        Record<Strategy, StrategyEvaluation>
      >;
      const prior = all[strategy];
      all[strategy] = {
        strategy,
        decision: "CHECKING",
        execution: "WAITING_DECISION",
        ...prior,
        ...patch,
        stages: { ...prior?.stages, ...patch.stages },
      };
      a.summaries.strategies = all;
    });
  }
  branchStage(
    id: string,
    strategy: Strategy,
    stage: AttemptStage,
    status: StageStatus,
    message = stage + ": " + status,
  ) {
    this.strategy(id, strategy, { stages: { [stage]: status } });
    this.mutateAttempt(id, (a) => {
      if (a.result === "RUNNING" && !a.summaries.ownershipClaim) {
        a.stage = stage;
        a.stages[stage] = status;
      }
      a.logs.push({
        at: Date.now(),
        stage,
        status,
        message: (strategy + ": " + message).slice(0, 500),
      });
    });
  }
  async run<T>(stage: AttemptStage, work: () => Promise<T> | T): Promise<T> {
    this.update(stage, "CHECKING");
    const value = await work();
    this.update(stage, "PASS");
    return value;
  }
  end(result: CandidateAttempt["result"], error?: unknown) {
    const a = this.current;
    if (!a) return;
    if (error) {
      const detail = safeError(error).slice(0, 500);
      const data =
        error && typeof error === "object" && "details" in error
          ? (error.details as Record<string, unknown>)
          : undefined;
      a.reasonCode = String(data?.reason ?? detail).slice(0, 160);
      a.reasonDetail = detail;
      if (result === "RECONCILING") {
        this.update(
          a.stage,
          "CHECKING",
          "Signed transaction UNKNOWN · Reconciliation required",
        );
      } else {
        a.failedStage = a.stage;
        this.update(a.stage, "FAIL", a.stage + ": FAIL · " + a.reasonCode);
        a.logs.push({
          at: Date.now(),
          stage: a.stage,
          status: "FAIL",
          message: "Token OUT · " + a.reasonCode,
        });
      }
    }
    a.result = result;
    a.endedAt = Date.now();
    this.persist();
    this.store.event(
      "ATTEMPT_" + result,
      a.mint,
      [a.attemptId, a.failedStage, a.reasonCode].filter(Boolean).join(" · "),
    );
    this.store.db
      .prepare(
        "DELETE FROM records WHERE kind='events' AND json_extract(payload,'$.type') LIKE 'ATTEMPT_%' AND id NOT IN (SELECT id FROM records WHERE kind='events' AND json_extract(payload,'$.type') LIKE 'ATTEMPT_%' ORDER BY id DESC LIMIT 4000)",
      )
      .run();
    this.store.db
      .prepare(
        "DELETE FROM records WHERE kind='jev_inputs' AND json_extract(payload,'$.attemptId') IS NOT NULL AND id NOT IN (SELECT id FROM records WHERE kind='jev_inputs' AND json_extract(payload,'$.attemptId') IS NOT NULL ORDER BY id DESC LIMIT 500)",
      )
      .run();
  }
  private persist(a = this.current!) {
    a.logs = a.logs.slice(-100);
    this.store.db
      .prepare(
        "INSERT INTO candidate_attempts VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET result=excluded.result,failed_stage=excluded.failed_stage,payload=excluded.payload",
      )
      .run(
        a.attemptId,
        a.mode,
        a.mint,
        a.startedAt,
        a.result,
        a.failedStage ?? null,
        JSON.stringify(a),
      );
    // Bound both the active UI frame and persistent audit history.
    this.store.db
      .prepare(
        "DELETE FROM candidate_attempts WHERE id IN (SELECT id FROM candidate_attempts WHERE result!='RUNNING' ORDER BY started_at DESC LIMIT -1 OFFSET 2000)",
      )
      .run();
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* A disconnected UI cannot affect execution authority. */
      }
    }
  }
}
