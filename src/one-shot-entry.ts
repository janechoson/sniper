import type { AttemptStage, StageStatus } from "./candidate-attempt.js";

import { CONTROLLED_BUY_CAP } from "./controlled-session.js";
import {
  CandidateRejected,
  type BuyOwnershipClaim,
  type Snapshot,
  type Strategy,
} from "./domain.js";
import type { Engine } from "./engine.js";
import { address, normalizeMarket, numberEvidence, record } from "./gmgn.js";
import { attemptFlow, parseMarketHistory } from "./market-history.js";
import { validateCandles } from "./kronos-domain.js";
import { positionSizeMatches } from "./position-sizing.js";
import { cheapGuard, size } from "./risk.js";
import { requireCompatibleToken } from "./token-program.js";
import { safeError } from "./util.js";

/** Per-attempt locals only. Authority remains RiskEngine and the existing Executor. */
export async function oneShotEntry(
  e: Engine,
  mint: string,
  context: (
    excludeId?: string,
    excludeClaimId?: string,
  ) => Promise<Parameters<Engine["risk"]["evaluate"]>[2]>,
  protectiveBusy: () => boolean,
) {
  let owned: BuyOwnershipClaim | undefined;
  let aiGuardExpiresAt = Number.POSITIVE_INFINITY;
  let aiGuardKnowledgeRevision: number | undefined;
  let aiGuardPrice: number | undefined;
  try {
    let candidate = e.store.token(mint)!;
    const attemptId = e.attempts.current!.attemptId;
    e.attempts.summary("strategy", "KRONOS");
    const run = <T>(stage: AttemptStage, work: () => Promise<T> | T) =>
      e.attempts.run(stage, async () => {
        assertAuthority();
        const result = await work();
        assertAuthority();
        return result;
      });
    const reject = (reason: string): never => {
      throw new CandidateRejected("TEMPORARY_RISK_CHANGE", { mint, reason });
    };
    const authority: NonNullable<Snapshot["entryAuthority"]> = {
      revision: e.store.candidateAuthority(mint, e.mode).revision,
      path: "TRENDING",
      policy: "TRENDING_ONE_SHOT_V1",
    };
    const assertAuthority = () => {
      if (e.entriesStopping) reject("ENGINE_STOPPING");
      e.store.assertEntryAuthority(mint, e.mode, authority);
      if (Date.now() >= aiGuardExpiresAt) reject("AI_GUARD_PASS_EXPIRED");
      if (aiGuardKnowledgeRevision !== undefined && e.codexAIGuard.status().knowledgeRevision !== aiGuardKnowledgeRevision)
        reject("AI_GUARD_KNOWLEDGE_REVISION_CHANGED");
    };
    const info = await run("CHEAP_FILTER", async () => {
      try {
        address(mint);
      } catch {
        reject("INVALID_MINT");
      }
      if (!candidate.discovery?.sources.includes("TRENDING"))
        reject("TRENDING_ORIGIN_REQUIRED");
      if (
        e.store
          .positions(e.mode)
          .some(
            (p) => p.mint === mint && !["CLOSED", "FAILED"].includes(p.state),
          )
      )
        reject("OPEN_POSITION_DUPLICATE");
      if (e.store.entryBlocked(mint, e.mode)) reject("DURABLE_BUY_DUPLICATE");
      const data = await e.gmgn.info(mint, 0, {
        priority: 4,
        consumer: "candidate-analysis",
      });
      const creation = numberEvidence(record(data).creation_timestamp);
      if (
        !candidate.createdAt &&
        creation.state === "KNOWN" &&
        creation.value > 0
      )
        candidate = { ...candidate, createdAt: creation.value * 1000 };
      const cheap = cheapGuard(candidate, normalizeMarket(data), e.settings);
      if (!cheap.allowed) reject(cheap.reason);
      return data;
    });
    let market = normalizeMarket(info);
    e.attempts.summary("token", { ...candidate, listing: undefined });
    e.attempts.summary("market", market);
    e.attempts.summary("metrics", {
      holders: record(info).holder_count ?? null,
      transactions: null,
    });
    let security = await run("SECURITY", async () => {
      const sec = await e.gmgn.security(
        { ...candidate, listing: {} },
        e.settings,
        { priority: 4, consumer: "pre-buy" },
      );
      e.attempts.summary("security", {
        at: sec.at,
        findings: sec.findings,
        mintRenounced: sec.mintRenounced,
        freezeRenounced: sec.freezeRenounced,
      });
      const critical = sec.findings.find((f) => f.level === "CRITICAL");
      if (critical) reject(critical.reason);
      if (
        sec.mintRenounced.state !== "KNOWN" ||
        sec.freezeRenounced.state !== "KNOWN"
      )
        reject("SECURITY_EVIDENCE_UNKNOWN");
      return sec;
    });
    let tokenExecution = await run("COMPATIBILITY", async () => {
      const report = await e.rpc.inspectMint(mint);
      requireCompatibleToken(report);
      if (report.decimals !== market.decimals)
        reject("TOKEN_DECIMALS_MISMATCH");
      return report;
    });
    e.attempts.summary("compatibility", tokenExecution);
    const history = await run("HISTORY", async () => {
      let raw: unknown;
      try {
        raw = await e.gmgn.marketHistory(candidate);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "GMGN_PLAN_UPGRADE_REQUIRED"
        ) {
          e.attempts.summary("history", {
            ...parseMarketHistory({}, candidate),
            reason: "GMGN_PLAN_UPGRADE_REQUIRED",
          });
          reject("HISTORY_SOURCE_UNAVAILABLE");
        }
        throw error;
      }
      const h = parseMarketHistory(raw, candidate);
      e.attempts.summary("history", h);
      e.attempts.update(
        "HISTORY",
        "CHECKING",
        `GMGN History: ${h.candles.length}/${h.diagnostics.inputRows} nến hợp lệ · ${Math.floor(h.availableHistory / 60000)}m available / 60m lookback · ${h.diagnostics.timestampUnit}`,
      );
      if (
        h.status !== "AVAILABLE" ||
        h.freshness !== "FRESH" ||
        !h.historyTo ||
        Date.now() - h.historyTo > e.settings.maxSnapshotAgeMs + 60000
      )
        reject("INSUFFICIENT_MARKET_HISTORY");
      try {
        validateCandles(
          h.candles.slice(-60).map(({ at, open, high, low, close }) => ({
            at,
            open,
            high,
            low,
            close,
          })),
          Date.now(),
        );
      } catch (error) {
        const reason =
          error instanceof Error && /^[A-Z][A-Z0-9_]{1,80}$/.test(error.message)
            ? error.message
            : "INVALID_KRONOS_MARKET_HISTORY";
        reject(reason);
      }
      return h;
    });
    let flow = await run("CAPITAL_FLOW", () => {
      const f = attemptFlow(
        candidate,
        market,
        info,
        history,
        e.settings.flowMeaningfulChangePercent,
      );
      e.attempts.summary("capitalFlow", f);
      if (f.regime === "INSUFFICIENT_DATA") reject("INSUFFICIENT_DATA");
      return f;
    });
    let intelligence = await run("COMMON_RISK", async () => {
      const intelligence = await e.gmgn.intelligence(
        { ...candidate, listing: {} },
        info,
        security,
        e.settings,
        true,
      );
      const common: Snapshot = {
        attemptId: e.attempts.current!.attemptId,
        entryAuthority: authority,
        entryDiscoverySource: "TRENDING",
        marketHistory: history,
        capitalFlow: flow,
        candidate,
        market,
        security,
        intelligence,
        tokenExecution,
      };
      const eligibility = e.risk.evaluate(
        common,
        e.settings,
        await context(undefined, owned?.id),
        Date.now(),
        "COMMON",
      );
      e.store.record("common_eligibility", mint, {
        ...eligibility,
        strategy: "COMMON",
        attemptId: common.attemptId,
      });
      if (!eligibility.allowed) reject(eligibility.reason);
      return intelligence;
    });
    const common: Snapshot = {
      attemptId: e.attempts.current!.attemptId,
      entryAuthority: authority,
      entryDiscoverySource: "TRENDING",
      marketHistory: history,
      capitalFlow: flow,
      candidate,
      market,
      security,
      intelligence,
      tokenExecution,
    };

    e.store.pipelineEvent("COMMON_PIPELINE_PASS", mint, { attemptId });
    const guard = await run("CODEX_GUARD", async () => {
      const d = await e.codexAIGuard.evaluate({
        candidate, history, market, mode: e.mode, attemptId,
        maxAgeMs: e.settings.maxSnapshotAgeMs,
        maxPriceMovePercent: e.settings.maxDecisionPriceMovePercent,
        context: { security, intelligence, capitalFlow: flow, tokenExecution },
      }, async () => {
        assertAuthority();
        const fresh = normalizeMarket(await e.gmgn.info(mint, 0, { priority: 0, consumer: "ai-guard-revalidation" }));
        let authorityValid = true;
        try { assertAuthority(); } catch { authorityValid = false; }
        return { market: fresh, authorityValid };
      });
      aiGuardExpiresAt = d.decisionExpiresAt;
      aiGuardKnowledgeRevision = d.knowledgeRevision;
      e.attempts.summary("codexGuard", d);
      e.store.pipelineEvent("CODEX_" + d.action, mint, {
        attemptId,
        decisionId: d.id,
        reason: d.summary,
      });
      if (d.action !== "PASS") reject("CODEX_" + d.action + ": " + d.summary);
      const guardedPrice = market.price.state === "KNOWN" ? market.price.value : undefined;
      if (guardedPrice === undefined) reject("CODEX_GUARD_MARKET_PRICE_UNKNOWN");
      aiGuardPrice = guardedPrice;
      return d;
    });
    e.attempts.summary("codexGuardDecisionId", guard.id);
    type Winner = {
      snapshot: Snapshot;
      claim: BuyOwnershipClaim;
    };
    let selected: Winner | undefined;
    let failure: unknown;
    const evaluate = async (strategy: Strategy) => {
      let modelDecisionRecorded = false;
      const summary = (key: string, value: unknown) =>
        e.attempts.summaryFor(attemptId, key, value);
      const run = async <T>(
        stage: AttemptStage,
        work: () => Promise<T> | T,
      ): Promise<T> => {
        e.attempts.branchStage(attemptId, strategy, stage, "CHECKING");
        try {
          assertAuthority();
          const value = await work();
          if (!e.store.buyOwnership(mint, e.mode, attemptId)) assertAuthority();
          e.attempts.branchStage(attemptId, strategy, stage, "PASS");
          return value;
        } catch (error) {
          e.attempts.branchStage(attemptId, strategy, stage, "FAIL");
          throw error;
        }
      };
      const { candidate, market, security, intelligence, tokenExecution } =
        structuredClone(common);
      const flow = structuredClone(common.capitalFlow!);
      e.attempts.strategy(attemptId, strategy, {
        decision: "CHECKING",
        execution: "WAITING_DECISION",
      });
      e.store.pipelineEvent(strategy + "_EVALUATION_STARTED", mint, {
        attemptId,
        strategy,
      });
      try {
        const kronos = await run("KRONOS", async () => {
          try {
            const d = await e.kronos.evaluateEntry({
              candles: history.candles
                .slice(-60)
                .map(({ at, open, high, low, close }) => ({
                  at,
                  open,
                  high,
                  low,
                  close,
                })),
            });
            summary("kronos", d);
            modelDecisionRecorded = true;
            e.attempts.strategy(attemptId, strategy, {
              decision: d.action === "BUY" ? "BUY" : "WAIT",
              decisionId: d.decisionId,
              decisionAt: d.decisionAt,
              reason: d.reason,
              decisionReason: d.reason,
            });
            e.attempts.logFor(
              attemptId,
              "KRONOS",
              d.action === "BUY" ? "PASS" : "SKIPPED",
              "KRONOS: " + d.action,
            );
            e.store.record("kronos_decisions", mint, {
              ...d,
              mode: e.mode,
              attemptId: common.attemptId,
            });
            e.store.pipelineEvent("KRONOS_" + d.action, mint, {
              strategy,
              decisionId: d.decisionId,
              decisionAt: d.decisionAt,
            });
            if (d.action !== "BUY") reject("KRONOS_WAIT");
            return d;
          } catch (error) {
            if (!(error instanceof CandidateRejected))
              e.store.pipelineEvent("KRONOS_INFERENCE_FAILED", mint, {
                strategy,
                attemptId: common.attemptId,
                reason: safeError(error),
              });
            throw error;
          }
        });
        const snapshot: Snapshot = {
          strategy,
          kronos,
          attemptId: attemptId,
          entryAuthority: authority,
          entryDiscoverySource: "TRENDING",
          marketHistory: history,
          capitalFlow: flow,
          candidate,
          market,
          security,
          intelligence,
          tokenExecution,
        };

        const acquire = () => {
          if (!e.store.buyOwnership(mint, e.mode, attemptId)) assertAuthority();
          const decisionId = snapshot.kronos!.decisionId;
          const decisionAt = snapshot.kronos!.decisionAt;
          const result = e.store.claimMintForBuy(
            {
              mode: e.mode,
              mint,
              attemptId,
              strategy,
              decisionId,
              decisionAt,
            },
            authority,
          );
          if (!result.claimed) {
            e.attempts.strategy(attemptId, strategy, {
              execution: "BLOCKED_OWNER_ALREADY_CLAIMED",
              owner: result.owner,
              reason: result.reason,
              executionReason: result.reason,
            });
            e.attempts.branchStage(
              attemptId,
              strategy,
              "OWNERSHIP_CAPITAL",
              "SKIPPED",
              "OWNERSHIP_CLAIM DENIED · " + result.reason,
            );
            e.store.pipelineEvent("OWNERSHIP_CLAIM_DENIED", mint, {
              attemptId,
              strategy,
              owner: result.owner,
              reason: result.reason,
            });
            e.store.pipelineEvent("EXECUTION_BLOCKED", mint, {
              attemptId,
              strategy,
              owner: result.owner,
              reason: result.reason,
            });
            return;
          }
          snapshot.ownershipClaimId = result.claim.id;
          e.attempts.summaryFor(attemptId, "ownershipClaim", result.claim);
          e.attempts.strategy(attemptId, strategy, {
            execution: "OWNERSHIP_CLAIMED",
            owner: strategy,
          });
          e.attempts.logFor(
            attemptId,
            "OWNERSHIP_CAPITAL",
            "PASS",
            strategy + ": OWNERSHIP_CLAIM SUCCESS · OWNER: " + strategy,
          );
          e.store.pipelineEvent("POSITION_OWNER", mint, {
            attemptId,
            strategy,
            owner: strategy,
            claimId: result.claim.id,
          });
          selected = { snapshot, claim: result.claim };
        };
        if (e.store.buyOwnership(mint, e.mode, attemptId)) {
          e.attempts.strategy(attemptId, strategy, {
            stages: { RISK: "SKIPPED" },
          });
          acquire();
          return;
        }
        const ctx = await context(undefined, owned?.id);
        if (e.store.buyOwnership(mint, e.mode, attemptId)) {
          e.attempts.strategy(attemptId, strategy, {
            stages: { RISK: "SKIPPED" },
          });
          acquire();
          return;
        }
        e.attempts.branchStage(attemptId, strategy, "RISK", "CHECKING");
        const risk = e.risk.evaluate(
          snapshot,
          e.settings,
          ctx,
          Date.now(),
          "QUALIFICATION",
        );
        e.attempts.strategy(attemptId, strategy, {
          risk,
          stages: { RISK: risk.allowed ? "PASS" : "FAIL" },
        });
        if (risk.allowed)
          e.attempts.branchStage(attemptId, strategy, "RISK", "PASS");
        e.store.record("risk_decisions", mint, {
          ...risk,
          attemptId,
          strategy,
          mode: e.mode,
        });
        if (!risk.allowed) {
          e.attempts.branchStage(
            attemptId,
            strategy,
            "RISK",
            "FAIL",
            risk.reason,
          );
          reject(risk.reason);
        }
        summary("risk", risk);
        acquire();
      } catch (error) {
        failure = error;
        const reason =
          error instanceof CandidateRejected
            ? String(error.details.reason ?? error.code)
            : safeError(error);
        e.attempts.strategy(attemptId, strategy, {
          ...(!modelDecisionRecorded
            ? {
                decision: "ERROR" as const,
              }
            : {}),
          execution: "NOT_EXECUTED",
          reason,
          executionReason: reason,
        });
        e.store.pipelineEvent(strategy + "_EVALUATION_FAILED", mint, {
          attemptId,
          strategy,
          reason,
        });
      } finally {
        try {
          const row = e.store.db
            .prepare("SELECT payload FROM candidate_attempts WHERE id=?")
            .get(attemptId);
          if (row) {
            const a = JSON.parse(String(row.payload));
            e.store.record("strategy_evaluations", mint, {
              attemptId,
              mode: e.mode,
              ...a.summaries.strategies[strategy],
            });
          }
        } finally {
          // Evaluation evidence is persisted before BUY execution proceeds.
        }
      }
    };
    await evaluate("KRONOS");
    const winner = selected;
    if (!winner)
      throw (
        failure ??
        new CandidateRejected("TEMPORARY_RISK_CHANGE", {
          reason: "NO_VALID_BUY",
        })
      );
    owned = winner.claim;
    const { snapshot } = winner;
    const strategy = owned.strategy;
    const kronos = snapshot.kronos;
    e.attempts.update("RISK", "PASS");
    await run("FINAL_ANALYSIS", async () => {
      const freshInfo = await e.gmgn.info(mint, 0, {
        priority: 3,
        consumer: "pre-buy",
      });
      const fresh = normalizeMarket(freshInfo);
      if (
        market.price.state === "KNOWN" &&
        fresh.price.state === "KNOWN" &&
        Math.abs(fresh.price.value / market.price.value - 1) * 100 >
          e.settings.maxDecisionPriceMovePercent
      )
        reject("MATERIAL_MARKET_CHANGE_AFTER_KRONOS");
      security = await e.gmgn.security(
        { ...candidate, listing: {} },
        e.settings,
        { priority: 3, consumer: "pre-buy" },
      );
      if (e.mode === "live" || e.mode === "demo") {
        tokenExecution = await e.rpc.inspectMint(mint);
        requireCompatibleToken(tokenExecution);
        if (tokenExecution.decimals !== fresh.decimals)
          reject("TOKEN_DECIMALS_MISMATCH");
      }
      flow = attemptFlow(
        candidate,
        fresh,
        freshInfo,
        history,
        e.settings.flowMeaningfulChangePercent,
      );
      if (flow.regime === "INSUFFICIENT_DATA")
        reject("FINAL_FLOW_INSUFFICIENT_DATA");
      intelligence = await e.gmgn.intelligence(
        { ...candidate, listing: {} },
        freshInfo,
        security,
        e.settings,
        true,
      );
      market = fresh;
      Object.assign(snapshot, {
        market,
        security,
        capitalFlow: flow,
        intelligence,
        tokenExecution,
      });
      e.attempts.summary("market", market);
      e.attempts.summary("capitalFlow", flow);
      const result = e.risk.evaluate(
        snapshot,
        e.settings,
        await context(undefined, owned?.id),
      );
      if (!result.allowed) reject(result.reason);
    });
    const intent = await run("OWNERSHIP_CAPITAL", async () => {
      assertAuthority();
      if (protectiveBusy() || e.executor.isBusy)
        reject("PROTECTIVE_WORK_PRIORITY");
      const ctx = await context(undefined, owned?.id);
      if (
        e.executor.controlled &&
        size(
          ctx.balance,
          BigInt(e.settings.feeReserveLamports),
          ctx.pending,
          e.settings,
        ).amount > CONTROLLED_BUY_CAP
      )
        reject("CONTROLLED_PRINCIPAL_CAP");
      const approved = e.risk.approve(snapshot, e.settings, ctx, e.mode);
      return { ...approved, key: approved.key + ":" + snapshot.attemptId };
    });
    e.attempts.summary("entryAmountLamports", intent.amount);
    e.attempts.summary("intentId", intent.id);
    e.store.record("snapshots", mint, snapshot);
    e.store.record("approved_intents", mint, intent);
    const check = () => {
      assertAuthority();
      e.store.assertBuyOwnership(intent);
      if (!positionSizeMatches(intent, e.settings))
        reject("POSITION_SIZE_SETTING_CHANGED");
      if (protectiveBusy()) reject("PROTECTIVE_WORK_PRIORITY");
      if (
        Date.now() - snapshot.market.at > e.settings.maxSnapshotAgeMs ||
        Date.now() - snapshot.security.at > e.settings.maxSnapshotAgeMs ||
        Date.now() - kronos!.decisionAt > e.settings.maxSnapshotAgeMs
      )
        reject("PRE_SIGN_EVIDENCE_STALE");
    };
    const finalValidation = async () => {
      check();
      const data = await e.gmgn.info(mint, 0, { priority: 0, consumer: "ai-guard-final-buy-revalidation" });
      const latest = normalizeMarket(data), checkedAt = Date.now();
      const latestPrice=latest.price.state === "KNOWN" ? latest.price.value : undefined;
      if (latestPrice === undefined) reject("AI_GUARD_FINAL_MARKET_STALE");
      if (latest.at > checkedAt || checkedAt-latest.at > e.settings.maxSnapshotAgeMs)
        reject("AI_GUARD_FINAL_MARKET_STALE");
      if (aiGuardPrice === undefined || latestPrice === undefined || Math.abs(latestPrice/aiGuardPrice-1)*100>e.settings.maxDecisionPriceMovePercent)
        reject("AI_GUARD_FINAL_MARKET_CHANGED");
      market = latest;
      snapshot.market = latest;
      check();
      const ctx = await context(intent.id, owned!.id);
      const latestRisk = e.risk.evaluate(snapshot, e.settings, ctx);
      if (!latestRisk.allowed) reject(latestRisk.reason);
      if (size(ctx.balance, BigInt(e.settings.feeReserveLamports), ctx.pending, e.settings).amount !== BigInt(intent.amount))
        reject("EXACT_SIZE_CHANGED");
    };
    const execution = await e.executor.execute(
      intent,
      e.settings,
      await e.solUsd().catch(() => "0"),
      finalValidation,
      check,
      (stage: AttemptStage, status: StageStatus) =>
        e.attempts.update(stage, status),
      e.solUsdEvidence(),
    );
    if (execution.state !== "CONFIRMED")
      reject("BUY_NOT_CONFIRMED_RECONCILE_REQUIRED");
    await run("POSITION", () => {
      const bought = e.store
        .positions(e.mode)
        .find((p) => p.id === intent.positionId && p.state === "OPEN");
      if (!bought)
        reject("POSITION_NOT_RECONCILED");
      e.chartLearning.scheduleBoughtPosition(bought!, history, market, {
        guardDecision: guard,
        kronosDecision: kronos,
        riskSnapshot: snapshot,
      });
    });
    e.attempts.strategy(attemptId, strategy, {
      execution: "CONFIRMED",
      owner: strategy,
    });
    e.attempts.end("BOUGHT");
  } finally {
    if (owned) {
      e.store.finishBuyOwnership(owned.mint, owned.mode, owned.attemptId);
      const execution = e.store
        .executions()
        .find((x) => x.intent.ownershipClaimId === owned!.id);
      if (execution?.state !== "CONFIRMED")
        e.attempts.strategy(owned.attemptId, owned.strategy, {
          execution: execution?.signature ? "RECONCILING" : "EXECUTION_FAILED",
          owner: owned.strategy,
          executionReason:
            execution?.error ??
            (execution?.signature
              ? "RECONCILIATION_REQUIRED"
              : "WINNING_EXECUTION_FAILED"),
        });
    }
  }
}
