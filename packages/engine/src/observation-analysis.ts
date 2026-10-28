import { randomUUID } from "node:crypto";
import type {
  AIProvider,
  CandidateRecord,
  TokenDiscoveryEvent,
  RugPolicy,
} from "@sniper/core";
import type { Settings } from "@sniper/config";
import {
  type FeatureEngine,
  type RugCheckEngine,
  refreshRugSnapshot,
} from "@sniper/features";
import { safeClassify } from "@sniper/ai";
import { hardFilter, decideRugCheck } from "@sniper/risk";
import { scoreToken, strategyRegistry } from "@sniper/strategies";
import { withTimeout } from "@sniper/shared";
export async function analyzeObservation(
  event: TokenDiscoveryEvent,
  options: {
    features: FeatureEngine;
    ai: AIProvider;
    rug: RugCheckEngine;
    settings: Settings;
    policy: RugPolicy;
    aiTimeoutMs: number;
    claimAiSlot: () => boolean;
    stage: (stage: string) => void;
    discoveryGuard?: () => Promise<
      NonNullable<CandidateRecord["discoveryGuard"]>
    >;
  },
): Promise<CandidateRecord> {
  if (event.source !== "RPC") throw new Error("REAL_SOURCE_REQUIRED");
  const record: CandidateRecord = {
    id: randomUUID(),
    strategyId: options.settings.strategy,
    event,
    createdAt: Date.now(),
    action: "SKIP",
    reasons: [],
    observation: {
      stage: "DISCOVERED",
      liveBlockingReasons: ["OBSERVATION_ONLY"],
      budgetUsd: "5",
      sellability: "UNKNOWN",
      virtualAction: "WATCH",
    },
  };
  const stage = (name: string) => {
    record.observation!.stage = name;
    options.stage(name);
  };
  try {
    if (options.discoveryGuard) {
      stage("CHEAP_GUARD");
      record.discoveryGuard = await options.discoveryGuard();
      if (!record.discoveryGuard.passed) {
        record.reasons = record.discoveryGuard.reasons;
        record.observation!.virtualAction = "WATCH";
        stage(
          record.discoveryGuard.deferred
            ? "DISCOVERY_DEFERRED"
            : "CHEAP_REJECTED",
        );
        return record;
      }
    }
    stage("MARKET_SECURITY");
    record.state = await withTimeout(options.features.collect(event), 30000);
    stage("RUG_CHECK");
    record.rugCheck = await options.rug.collect(
      {
        chainId: event.chainId,
        tokenAddress: event.tokenAddress,
        poolAddress: event.poolAddress,
      },
      record.state,
    );
    record.rugCheck.decision = decideRugCheck(
      record.rugCheck,
      options.policy,
      "PAPER",
      "PRECHECK",
    );
    record.rugCheck = refreshRugSnapshot(record.rugCheck);
    record.hardFilter = hardFilter(record.state, options.settings);
    record.observation!.liveBlockingReasons = [
      "OBSERVATION_ONLY",
      ...record.hardFilter.reasons,
      "SELLABILITY_UNKNOWN",
    ];
    record.risk = {
      passed: false,
      reasons: record.observation!.liveBlockingReasons,
    };
    if (record.rugCheck.decision?.decision === "REJECT") {
      record.action = "REJECT";
      record.reasons = record.rugCheck.decision.reasonCodes;
      stage("REJECTED");
      return record;
    }
    const blocking = record.hardFilter.reasons.filter(
      (r) => !r.startsWith("UNKNOWN_"),
    );
    if (blocking.length) {
      record.action = "REJECT";
      record.reasons = blocking;
      stage("REJECTED");
      return record;
    }
    if (!options.claimAiSlot()) {
      record.reasons = ["OBSERVATION_AI_RATE_LIMIT"];
      stage("WAITING_AI");
      return record;
    }
    stage("JEV");
    record.aiAttempted = true;
    record.ai = await safeClassify(
      options.ai,
      record.state,
      options.aiTimeoutMs,
    );
    if (!record.ai) {
      record.reasons = ["AI_FAILED"];
      stage("AI_UNAVAILABLE");
      return record;
    }
    record.score = scoreToken(record.state, record.ai);
    record.strategy = await strategyRegistry
      .get(options.settings.strategy)!
      .evaluate({
        state: record.state,
        ai: record.ai,
        score: record.score,
        minimumScore: options.settings.minScore,
      });
    record.reasons = record.strategy.reasons.length
      ? record.strategy.reasons
      : ["OBSERVATION_ONLY"];
    record.observation!.virtualAction = record.strategy.passed
      ? "BUY"
      : record.ai.action === "SKIP"
        ? "SKIP"
        : "WATCH";
    stage(record.strategy.passed ? "CHECKING_REAL_QUOTES" : "WATCHING");
  } catch {
    record.reasons = ["OBSERVATION_ANALYSIS_UNAVAILABLE"];
    stage("DATA_UNAVAILABLE");
  }
  return record;
}
