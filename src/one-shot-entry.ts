import type { Engine } from "./engine.js";
import { env } from "./config.js";
import { address, normalizeMarket, record, numberEvidence } from "./gmgn.js";
import {
  CandidateRejected,
  type Snapshot,
  type TokenExecutionReport,
  type Strategy,
  type BuyOwnershipClaim,
} from "./domain.js";
import { requireCompatibleToken } from "./token-program.js";
import { cheapGuard, size } from "./risk.js";
import {
  parseMarketHistory,
  attemptFlow,
  oneShotStructure,
} from "./market-history.js";
import type { AttemptStage, StageStatus } from "./candidate-attempt.js";
import { CONTROLLED_BUY_CAP } from "./controlled-session.js";
import { analyzeManipulationStructure } from "./manipulation-structure.js";
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
  try {
    let candidate = e.store.token(mint)!;
    const attemptId = e.attempts.current!.attemptId;
    e.attempts.summary("strategy", "FIRST_BUY_WINS");
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
      revision: e.store.candidateAuthority(mint, env.TRADING_MODE).revision,
      path: "TRENDING",
      policy: "TRENDING_ONE_SHOT_V1",
    };
    const assertAuthority = () => {
      if (e.entriesStopping) reject("ENGINE_STOPPING");
      e.store.assertEntryAuthority(mint, env.TRADING_MODE, authority);
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
          .positions(env.TRADING_MODE)
          .some(
            (p) => p.mint === mint && !["CLOSED", "FAILED"].includes(p.state),
          )
      )
        reject("OPEN_POSITION_DUPLICATE");
      if (e.store.entryBlocked(mint, env.TRADING_MODE))
        reject("DURABLE_BUY_DUPLICATE");
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
    let tokenExecution: TokenExecutionReport | undefined;
    if (env.TRADING_MODE === "live")
      tokenExecution = await run("COMPATIBILITY", async () => {
        const report = await e.rpc.inspectMint(mint);
        requireCompatibleToken(report);
        if (report.decimals !== market.decimals)
          reject("TOKEN_DECIMALS_MISMATCH");
        return report;
      });
    else
      e.attempts.update(
        "COMPATIBILITY",
        "SKIPPED",
        "Paper fill; on-chain compatibility is not verified",
      );
    e.attempts.summary(
      "compatibility",
      tokenExecution ?? { status: "SKIPPED_PAPER" },
    );
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
    type Winner = {
      snapshot: Snapshot;
      claim: BuyOwnershipClaim;
      structureOptions: () => Parameters<typeof oneShotStructure>[3];
      logStructure: (s: ReturnType<typeof oneShotStructure>) => void;
    };
    let resolveWinner!: (winner: Winner | undefined) => void;
    const firstClaim = new Promise<Winner | undefined>((resolve) => {
      resolveWinner = resolve;
    });
    let completed = 0;
    const failures = new Map<Strategy, unknown>();
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
          if (!e.store.buyOwnership(mint, env.TRADING_MODE, attemptId))
            assertAuthority();
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
        const manipulationStructure =
          strategy === "STANDARD"
            ? analyzeManipulationStructure(history)
            : undefined;
        if (manipulationStructure) {
          summary("manipulationStructure", manipulationStructure);
          e.store.pipelineEvent("MANIPULATION_STRUCTURE_EVALUATED", mint, {
            attemptId: attemptId,
            status: manipulationStructure.status,
            ...manipulationStructure.evidence,
            suspiciousSegments: manipulationStructure.suspiciousSegments,
            reasons: manipulationStructure.reasons,
            limitations: manipulationStructure.limitations,
            policy: manipulationStructure.policy,
          });
        }
        const smartSnapshot =
          strategy === "STANDARD"
            ? await e.gmgn.smartMoneyFeed(0, {
                priority: 4,
                consumer: "candidate-smart-money",
              })
            : undefined;
        const structureOptions = () => ({
          mint,
          smartMoney: smartSnapshot,
          settings: e.settings,
        });
        const logStructure = (
          structure: ReturnType<typeof oneShotStructure>,
        ) => {
          summary("structure", structure);
          e.store.pipelineEvent("STRUCTURE_EVIDENCE_V3", mint, {
            attemptId: attemptId,
            priceStatus: structure.priceStructure.status,
            marketFlowStatus: structure.marketFlow.status,
            smartMoneyStatus: structure.smartMoney.status,
            supportLevel: structure.conclusion.supportLevel,
            evidenceFrom: structure.priceStructure.evidenceFrom,
            evidenceTo: structure.priceStructure.evidenceTo,
            smartMoneyCoverageSeconds:
              structure.smartMoney.coverage.coverageSeconds,
            smartMoneyMatchedEvents:
              structure.smartMoney.coverage.tokenMatchedCount,
            reasons: structure.conclusion.reasons,
            limitations: structure.conclusion.limitations,
            evidence: structure,
          });
        };
        const structure =
          strategy === "STANDARD"
            ? await run("STRUCTURE", () => {
                const result = oneShotStructure(
                  history,
                  flow,
                  market,
                  structureOptions(),
                );
                logStructure(result);
                if (
                  !result.priceStructure.sequenceFresh ||
                  !result.priceStructure.floorHolding ||
                  !result.priceStructure.momentum
                )
                  reject(result.reason);
                // Evidence first; JEV receives conflicts and unknowns. Execution eligibility
                // is enforced by Risk after the advisory decision, not by participant BUYs.
                return result;
              })
            : undefined;
        const jev =
          strategy === "STANDARD"
            ? await run("JEV", async () => {
                if (!e.store.entriesEnabled()) reject("NEW_ENTRIES_DISABLED");
                const input = {
                  attemptId: attemptId,
                  token: {
                    mint,
                    symbol: candidate.symbol,
                    name: candidate.name,
                  },
                  tokenAge: history.tokenAge,
                  marketHistory: history,
                  market,
                  capitalFlow: flow,
                  structureEvidence: structure,
                  manipulationStructure,
                  security: { ...security, raw: undefined },
                  tokenExecution,
                  freshness: {
                    marketAt: market.at,
                    securityAt: security.at,
                    historyAt: history.fetchedAt,
                  },
                };
                e.store.record("jev_inputs", mint, {
                  attemptId: input.attemptId,
                  state: input,
                });
                const answer = await e.jev.decide(input, true);
                e.store.record("jev_decisions", mint, {
                  ...answer,
                  mode: env.TRADING_MODE,
                });
                summary("jev", answer);
                modelDecisionRecorded = true;
                e.attempts.strategy(attemptId, strategy, {
                  decision: answer.action === "BUY" ? "BUY" : "REJECT",
                  decisionId: answer.inputHash,
                  decisionAt: answer.at,
                  reason: answer.action,
                  decisionReason: answer.action,
                });
                e.attempts.logFor(
                  attemptId,
                  "JEV",
                  answer.action === "BUY" ? "PASS" : "SKIPPED",
                  "STANDARD: " + answer.action,
                );
                e.store.pipelineEvent("STANDARD_" + answer.action, mint, {
                  attemptId,
                  strategy,
                  decisionId: answer.inputHash,
                  decisionAt: answer.at,
                });
                if (answer.action !== "BUY" || answer.insufficientData)
                  reject("JEV_DID_NOT_APPROVE");
                return answer;
              })
            : undefined;
        const kronos =
          strategy === "KRONOS"
            ? await run("KRONOS", async () => {
                e.store.pipelineEvent("KRONOS_EVALUATION_STARTED", mint, {
                  strategy,
                  attemptId: common.attemptId,
                });
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
                    mode: env.TRADING_MODE,
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
                    });
                  throw error;
                }
              })
            : undefined;
        const snapshot: Snapshot = {
          strategy,
          kronos,
          attemptId: attemptId,
          entryAuthority: authority,
          entryDiscoverySource: "TRENDING",
          marketHistory: history,
          capitalFlow: flow,
          oneShotStructure: structure,
          manipulationStructure,
          candidate,
          market,
          security,
          intelligence,
          jev,
          tokenExecution,
        };

        const acquire = () => {
          if (!e.store.buyOwnership(mint, env.TRADING_MODE, attemptId))
            assertAuthority();
          const decisionId =
            snapshot.kronos?.decisionId ?? snapshot.jev!.inputHash;
          const decisionAt = snapshot.kronos?.decisionAt ?? snapshot.jev!.at;
          const result = e.store.claimMintForBuy(
            {
              mode: env.TRADING_MODE,
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
          resolveWinner({
            snapshot,
            claim: result.claim,
            structureOptions,
            logStructure,
          });
        };
        if (e.store.buyOwnership(mint, env.TRADING_MODE, attemptId)) {
          e.attempts.strategy(attemptId, strategy, {
            stages: { RISK: "SKIPPED" },
          });
          acquire();
          return;
        }
        const ctx = await context(undefined, owned?.id);
        if (e.store.buyOwnership(mint, env.TRADING_MODE, attemptId)) {
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
          mode: env.TRADING_MODE,
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
        failures.set(strategy, error);
        const reason =
          error instanceof CandidateRejected
            ? String(error.details.reason ?? error.code)
            : safeError(error);
        e.attempts.strategy(attemptId, strategy, {
          ...(!modelDecisionRecorded
            ? {
                decision:
                  strategy === "KRONOS"
                    ? ("ERROR" as const)
                    : ("REJECT" as const),
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
              mode: env.TRADING_MODE,
              ...a.summaries.strategies[strategy],
            });
          }
        } finally {
          if (++completed === 2) resolveWinner(undefined);
        }
      }
    };
    // Both start independently; only the SQL claim resolves firstClaim. No join before execution.
    for (const strategy of ["STANDARD", "KRONOS"] as const)
      e.trackEntryEvaluation(evaluate(strategy));
    const winner = await firstClaim;
    if (!winner)
      throw (
        failures.get("STANDARD") ??
        failures.get("KRONOS") ??
        new CandidateRejected("TEMPORARY_RISK_CHANGE", {
          reason: "NO_VALID_BUY",
        })
      );
    owned = winner.claim;
    const { snapshot, structureOptions, logStructure } = winner;
    const strategy = owned.strategy;
    let structure = snapshot.oneShotStructure;
    const kronos = snapshot.kronos,
      jev = snapshot.jev;
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
        reject(
          strategy === "KRONOS"
            ? "MATERIAL_MARKET_CHANGE_AFTER_KRONOS"
            : "MATERIAL_MARKET_CHANGE_AFTER_JEV",
        );
      security = await e.gmgn.security(
        { ...candidate, listing: {} },
        e.settings,
        { priority: 3, consumer: "pre-buy" },
      );
      if (env.TRADING_MODE === "live") {
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
      if (strategy === "STANDARD") {
        structure = oneShotStructure(history, flow, fresh, structureOptions());
        logStructure(structure);
        if (!structure.passed) reject("FINAL_STRUCTURE_CHANGED");
      }
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
        oneShotStructure: structure,
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
      if (
        env.TRADING_MODE === "live" &&
        (await e.rpc.tokenBalance(env.WALLET_PUBLIC_KEY!, mint)) > 0n
      )
        reject("TOKEN_ALREADY_OWNED");
      if (protectiveBusy() || e.executor.isBusy)
        reject("PROTECTIVE_WORK_PRIORITY");
      const ctx = await context(undefined, owned?.id);
      if (
        e.executor.controlled &&
        size(
          ctx.balance,
          BigInt(e.settings.feeReserveLamports),
          ctx.pending,
          e.settings.positionSizePercent,
        ).amount > CONTROLLED_BUY_CAP
      )
        reject("CONTROLLED_PRINCIPAL_CAP");
      const approved = e.risk.approve(
        snapshot,
        e.settings,
        ctx,
        env.TRADING_MODE,
      );
      return { ...approved, key: approved.key + ":" + snapshot.attemptId };
    });
    e.attempts.summary("entryAmountLamports", intent.amount);
    e.attempts.summary("intentId", intent.id);
    e.store.record("snapshots", mint, snapshot);
    e.store.record("approved_intents", mint, intent);
    const check = () => {
      assertAuthority();
      e.store.assertBuyOwnership(intent);
      if (intent.positionSizePercent !== e.settings.positionSizePercent)
        reject("POSITION_SIZE_SETTING_CHANGED");
      if (protectiveBusy()) reject("PROTECTIVE_WORK_PRIORITY");
      if (
        Date.now() - snapshot.market.at > e.settings.maxSnapshotAgeMs ||
        Date.now() - snapshot.security.at > e.settings.maxSnapshotAgeMs ||
        Date.now() - (kronos?.decisionAt ?? jev!.at) >
          e.settings.maxSnapshotAgeMs
      )
        reject("PRE_SIGN_EVIDENCE_STALE");
    };
    const execution = await e.executor.execute(
      intent,
      e.settings,
      await e.solUsd().catch(() => "0"),
      async () => {
        check();
        const ctx = await context(intent.id, owned!.id);
        const r = e.risk.evaluate(snapshot, e.settings, ctx);
        if (!r.allowed) reject(r.reason);
        if (
          size(
            ctx.balance,
            BigInt(e.settings.feeReserveLamports),
            ctx.pending,
            e.settings.positionSizePercent,
          ).amount !== BigInt(intent.amount)
        )
          reject("EXACT_SIZE_CHANGED");
      },
      check,
      (stage: AttemptStage, status: StageStatus) =>
        e.attempts.update(stage, status),
      e.solUsdEvidence(),
    );
    if (execution.state !== "CONFIRMED")
      reject("BUY_NOT_CONFIRMED_RECONCILE_REQUIRED");
    await run("POSITION", () => {
      if (
        !e.store
          .positions(env.TRADING_MODE)
          .some((p) => p.id === intent.positionId && p.state === "OPEN")
      )
        reject("POSITION_NOT_RECONCILED");
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
