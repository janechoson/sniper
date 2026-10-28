import { randomUUID } from "node:crypto";
import type {
  AIProvider,
  CandidateRecord,
  TokenDiscoveryEvent,
} from "@sniper/core";
import type { Settings } from "@sniper/config";
import type { FeatureEngine } from "@sniper/features";
import { safeClassify } from "@sniper/ai";
import { hardFilter } from "@sniper/risk";
import { scoreToken, strategyRegistry } from "@sniper/strategies";
import { withTimeout } from "@sniper/shared";
export interface CandidateSecurityHooks {
  collect(record: CandidateRecord): Promise<void>;
  beforeAI(record: CandidateRecord): Promise<{
    passed: boolean;
    reasons: string[];
    action?: "REJECT" | "SKIP";
  }>;
}
export async function analyzeCandidate(
  event: TokenDiscoveryEvent,
  features: FeatureEngine,
  ai: AIProvider,
  policy: Settings,
  now: number,
  featureTimeoutMs = 5000,
  aiTimeoutMs = 3500,
  security?: CandidateSecurityHooks,
  discoveryGuard?: () => Promise<
    NonNullable<CandidateRecord["discoveryGuard"]>
  >,
): Promise<CandidateRecord> {
  const record: CandidateRecord = {
    id: randomUUID(),
    strategyId: policy.strategy,
    event,
    createdAt: now,
    action: "SKIP",
    reasons: [],
  };
  try {
    if (discoveryGuard) {
      record.discoveryGuard = await discoveryGuard();
      if (!record.discoveryGuard.passed) {
        record.reasons = record.discoveryGuard.reasons;
        return record;
      }
    }
    record.timing = {
      received: event.detectedAt ?? now,
      chainEvent: event.chainTimestamp,
      normalized: Date.now(),
    };
    record.state = await withTimeout(features.collect(event), featureTimeoutMs);
    record.timing.featuresReady = Date.now();
    record.timing.securityReady = Date.now();
    await security?.collect(record);
    if (record.rugCheck?.decision?.decision === "REJECT") {
      record.hardFilter = {
        passed: false,
        reasons: record.rugCheck.decision.reasonCodes,
      };
      record.action = "REJECT";
      record.reasons = record.hardFilter.reasons;
      return record;
    }
    record.hardFilter = hardFilter(record.state, policy);
    record.timing.hardFilterComplete = Date.now();
    if (!record.hardFilter.passed) {
      if (record.rugCheck)
        record.rugCheck.decision = {
          decision: "REJECT",
          reasonCodes: record.hardFilter.reasons,
          stage: "HARD_FILTER",
          decidedAt: new Date().toISOString(),
        };
      record.action = "REJECT";
      record.reasons = record.hardFilter.reasons;
      return record;
    }
    if (security) {
      const gate = await security.beforeAI(record);
      if (!gate.passed) {
        record.hardFilter = { passed: false, reasons: gate.reasons };
        record.action = gate.action ?? "REJECT";
        record.reasons = gate.reasons;
        return record;
      }
    }
    record.aiAttempted = true;
    record.ai = await safeClassify(ai, record.state, aiTimeoutMs);
    record.timing.aiComplete = Date.now();
    if (!record.ai) {
      record.reasons = ["AI_UNAVAILABLE"];
      return record;
    }
    record.score = scoreToken(record.state, record.ai);
    record.strategy = await withTimeout(
      strategyRegistry.get(policy.strategy)!.evaluate({
        state: record.state,
        ai: record.ai,
        score: record.score,
        minimumScore: policy.minScore,
      }),
      1000,
    );
    record.reasons = record.strategy.reasons;
  } catch {
    record.action = "SKIP";
    record.reasons = ["ANALYSIS_ERROR"];
  }
  return record;
}
