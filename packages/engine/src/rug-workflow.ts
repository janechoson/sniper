import type {
  CandidateRecord,
  RugPolicy,
  ExecutionMode,
  RugTradingCheck,
  JevRiskClassification,
  RugCheckSnapshot,
} from "@sniper/core";
import {
  RugCheckEngine,
  applyRugTrading,
  refreshRugSnapshot,
} from "@sniper/features";
import { decideRugCheck } from "@sniper/risk";
export class TokenSecurityWorkflow {
  constructor(
    private readonly options: {
      engine: RugCheckEngine;
      policy: RugPolicy;
      mode: ExecutionMode;
      enabled: boolean;
      prepare: (record: CandidateRecord) => Promise<RugTradingCheck>;
      classify: (snapshot: RugCheckSnapshot) => Promise<JevRiskClassification>;
    },
  ) {}
  async collect(record: CandidateRecord) {
    if (!record.state) throw new Error("SECURITY_FEATURES_MISSING");
    const snapshot = await this.options.engine.collect(
      {
        chainId: record.event.chainId,
        tokenAddress: record.event.tokenAddress,
        poolAddress: record.event.poolAddress,
      },
      record.state,
    );
    snapshot.decision = this.options.enabled
      ? decideRugCheck(
          snapshot,
          this.options.policy,
          this.options.mode,
          "PRECHECK",
        )
      : {
          decision: "REJECT",
          reasonCodes: ["RUG_CHECK_DISABLED"],
          stage: "PRECHECK",
          decidedAt: new Date().toISOString(),
        };
    record.rugCheck = snapshot;
  }
  async beforeAI(record: CandidateRecord) {
    let snapshot = record.rugCheck;
    if (!snapshot) throw new Error("RUG_SNAPSHOT_MISSING");
    const begin = Date.now();
    let check: RugTradingCheck;
    try {
      check = await this.options.prepare(record);
    } catch {
      check = {
        failure: "TRADE_VALIDATION_UNAVAILABLE",
        quoteLatencyMs: Date.now() - begin,
        sellSimulationLatencyMs: 0,
      };
    }
    snapshot = applyRugTrading(snapshot, check);
    const gate = decideRugCheck(
      snapshot,
      this.options.policy,
      this.options.mode,
      "HARD_FILTER",
    );
    snapshot.decision = gate;
    record.rugCheck = snapshot;
    if (gate.decision !== "ALLOW")
      return {
        passed: false,
        reasons: gate.reasonCodes,
        action:
          gate.decision === "WATCH" ? ("SKIP" as const) : ("REJECT" as const),
      };
    snapshot.jev = await this.options.classify(snapshot);
    snapshot.latencies.jevLatencyMs = snapshot.jev.latencyMs;
    snapshot.decision = decideRugCheck(
      snapshot,
      this.options.policy,
      this.options.mode,
      "FINAL",
    );
    snapshot.latencies.totalRiskPipelineLatencyMs =
      (snapshot.latencies.totalRiskPipelineLatencyMs ?? 0) + Date.now() - begin;
    record.rugCheck = refreshRugSnapshot(snapshot);
    return {
      passed: snapshot.decision.decision === "ALLOW",
      reasons: snapshot.decision.reasonCodes,
      action:
        snapshot.decision.decision === "WATCH"
          ? ("SKIP" as const)
          : ("REJECT" as const),
    };
  }
}
