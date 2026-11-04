import { PositionCollector } from "./position-collector.js";
import { CandidateAttempts } from "./candidate-attempt.js";
import { oneShotEntry } from "./one-shot-entry.js";
import { tradeAccounting } from "./trade-accounting.js";
import {
  evaluateExitSafety,
  exitEvidenceKey,
  exitPriority,
  validProtection,
  protectiveRetry,
  routeMateriallyChanged,
  securityRecoveryConfirmed,
} from "./exit-safety.js";
import { PositionHistoryMonitor } from "./position-history-monitor.js";
import type { MarketHistory } from "./market-history.js";
import { parseMarketHistory } from "./market-history.js";
import { smartMoneySupport, unavailableSmartMoney } from "./smart-money.js";
import {
  env,
  defaultSettings,
  settingsSchema,
  type Settings,
} from "./config.js";
import {
  Blocked,
  CandidateRejected,
  ProviderFailure,
  type FailureInfo,
  type FailureStage,
  type RiskResult,
  type Position,
} from "./domain.js";
import { Store } from "./store.js";
import { Gmgn, normalizeMarket, numberEvidence, record, SOL } from "./gmgn.js";
import type { ControlledSession } from "./controlled-session.js";
import { TradingMemory } from "./trading-memory.js";
import { Jev } from "./jev.js";
import { Solana } from "./solana.js";
import type { SolanaExecutionProvider } from "./execution-provider.js";
import { Executor } from "./executor.js";
import {
  RiskEngine,
  decision,
  size,
  paperValue,
  protectiveExitDecision,
} from "./risk.js";
import { sleep, safeError } from "./util.js";
import { canBypassRecovery } from "./recovery-guard.js";
import { CandidateLifecycle } from "./candidate-lifecycle.js";
import { failureInfo, ProviderFailures } from "./failures.js";
import { positionViews } from "./position-view.js";
import { flowView } from "./flow-view.js";
import { randomUUID } from "node:crypto";
import { CapitalFlowEngine } from "./capital-flow.js";
import {
  SniperStructure,
  entrySource,
  hasEntryWatchEligibility,
} from "./sniper-structure.js";
import { runtimeInfo } from "./runtime-info.js";
import { currentStructureEvidence } from "./structure-evidence.js";
import { DiscoveryCoordinator, discoveryContext } from "./discovery.js";
import {
  ExitLiquidityMonitor,
  exitLiquidityContext,
} from "./exit-feasibility.js";
import type {
  ManualExitRequest,
  ExitOpportunity,
  JevExitDecision,
  Market,
  Security,
} from "./domain.js";
import { JevExitScheduler, type ExitJob } from "./jev-exit-scheduler.js";
import {
  KronosStrategy,
  type KronosDecisionStrategy,
} from "./kronos-strategy.js";
import { KronosWorker } from "./kronos-worker.js";
import { assertStrategySell } from "./strategy-authority.js";
import { join } from "node:path";
import { homedir } from "node:os";
export class Engine {
  readonly kronos: KronosDecisionStrategy;
  private kronosJobs = new Map<string, Promise<void>>();
  private kronosAttempts = new Map<string, number>();
  private entryEvaluations = new Set<Promise<void>>();
  get entriesStopping() {
    return this.stopping;
  }
  trackEntryEvaluation(work: Promise<void>) {
    const tracked = work.catch(() => {
      this.lastError = "ENTRY_COMPARISON_PERSISTENCE_FAILED";
    });
    this.entryEvaluations.add(tracked);
    void tracked.finally(() => this.entryEvaluations.delete(tracked));
  }
  async settleEntryEvaluations() {
    await Promise.all(this.entryEvaluations);
  }
  readonly gmgn: Gmgn;
  readonly rpc: Solana;
  readonly jev: Jev;
  readonly risk = new RiskEngine();
  readonly memory: TradingMemory;
  readonly executor: Executor;
  readonly candidates: CandidateLifecycle;
  readonly attempts: CandidateAttempts;
  readonly collector = new PositionCollector(
    () => this.settings.positionCollectorConcurrency,
  );
  readonly exitScheduler: JevExitScheduler;
  readonly positionHistory: PositionHistoryMonitor;
  readonly capitalFlow: CapitalFlowEngine;
  readonly discovery: DiscoveryCoordinator;
  readonly exitLiquidity: ExitLiquidityMonitor;
  private discoveryTimer?: NodeJS.Timeout;
  private analysisStarts: Array<{
    at: number;
    source: string;
    waitMs: number;
  }> = [];
  private exitMetrics = {
    hold: 0,
    partialSell: 0,
    fullSell: 0,
    staleRejected: 0,
    duplicateExitPrevented: 0,
  };
  private executionLoop = false;
  private exitScheduled = new Map<string, number>();
  private smartMoneyJobs = new Map<string, Promise<void>>();
  private providerFailures = new ProviderFailures();
  private stages = new Map<string, FailureStage>();
  private metricsBaseline: Record<string, number> = {};
  private flowStartId = 0;
  settings: Settings;
  readonly structure: SniperStructure;
  running = false;
  scanning = false;
  lastTick?: number;
  lastError?: string;
  private stopping = false;
  private monitoring = 0;
  private timer?: NodeJS.Timeout;
  private exitTimer?: NodeJS.Timeout;
  private get manual() {
    return this.store.activeManual(env.TRADING_MODE);
  }
  private get manualReady() {
    return this.manual.some(
      (r) =>
        r.state !== "FAILED_RETRYABLE" ||
        (this.store.positions(r.mode).find((p) => p.id === r.positionId)
          ?.attention?.nextCheckAt ?? 0) <= Date.now(),
    );
  }
  private solPrice?: string;
  private solPriceAt?: number;
  constructor(
    readonly store: Store,
    providers?: {
      gmgn?: Gmgn;
      rpc?: Solana;
      jev?: Jev;
      execution?: SolanaExecutionProvider;
      controlled?: ControlledSession;
      kronos?: KronosDecisionStrategy;
    },
  ) {
    this.kronos =
      providers?.kronos ??
      new KronosStrategy(
        new KronosWorker(
          join(
            process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
            "gmgn-kronos-runtime",
          ),
          undefined,
          undefined,
          process.env.SystemRoot ?? "C:\\Windows",
        ),
      );
    this.gmgn = providers?.gmgn ?? new Gmgn();
    this.rpc = providers?.rpc ?? new Solana();
    this.jev = providers?.jev ?? new Jev();
    this.memory = new TradingMemory(store);
    this.executor = new Executor(
      store,
      this.gmgn,
      this.rpc,
      providers?.execution,
      this.memory,
      providers?.controlled,
    );
    this.settings = settingsSchema.parse(
      store.get("strategyV2") ?? defaultSettings(),
    );
    store.set("strategyV2", this.settings);
    this.gmgn.configure(this.settings);
    this.structure = new SniperStructure(store, () => this.settings);
    this.capitalFlow = new CapitalFlowEngine(store, () => this.settings);
    this.discovery = new DiscoveryCoordinator(
      store,
      this.gmgn,
      () => this.settings,
    );
    this.exitLiquidity = new ExitLiquidityMonitor(
      this.executor.provider,
      store,
      () => this.settings,
      () => env.WALLET_PUBLIC_KEY,
      () =>
        this.executor.isBusy ||
        this.executionLoop ||
        this.stopping ||
        !!this.store.pending().find((e) => e.signature),
      (p) => {
        this.updateExitSafety(p.id, {});
        const current = this.store.positions(p.mode).find((x) => x.id === p.id),
          market = this.store.latest<Market>("position_market", p.mint),
          security = this.store.latest<Security>("position_security", p.mint);
        if (current && market && security)
          this.scheduleExitAnalysis(current, market, security, {});
      },
    );
    this.flowStartId = Number(
      store.db.prepare("SELECT coalesce(max(id),0) id FROM records").get()!.id,
    );
    this.candidates = new CandidateLifecycle(store, () => this.settings);
    this.attempts = new CandidateAttempts(store);
    this.metricsBaseline = {
      ...store.get<Record<string, number>>("faultMetrics"),
    };
    this.store.migrateManualRequests();
    this.store.migrateExitOpportunities();
    this.store.migrateJevExitPolicy();
    this.store.migrateSellSafetyV2(this.settings.maxSnapshotAgeMs);
    // Unsigned decisions are observations, never executable restart orders.
    for (const p of this.store.managedPositions(env.TRADING_MODE)) {
      if (
        this.store
          .pending()
          .some((e) => e.intent.positionId === p.id && e.signature)
      )
        continue;
      const strategic =
        p.pendingExits?.filter((x) => x.kind === "STRATEGIC") ?? [];
      if (!strategic.length) continue;
      p.pendingExits = p.pendingExits!.filter((x) => x.kind !== "STRATEGIC");
      if (p.jevExit) {
        p.jevExit.status = "CANCELLED";
        this.store.saveJevExit(p.jevExit);
      }
      this.store.savePosition(p);
    }
    this.exitScheduler = new JevExitScheduler(
      this.jev,
      () => this.settings,
      (d, job) => {
        try {
          this.applyExitDecision(d, job);
        } catch {
          this.store.halt("Jev exit decision persistence failed", "SYSTEM");
        }
      },
      (job) =>
        this.store
          .managedPositions(env.TRADING_MODE)
          .some(
            (p) =>
              p.id === job.positionId &&
              p.strategy !== "KRONOS" &&
              p.state === "OPEN" &&
              p.quantity === job.quantity,
          ),
    );
    this.positionHistory = new PositionHistoryMonitor(
      this.gmgn,
      (p, h, error) => {
        if (error)
          this.store.pipelineEvent("POSITION_STRUCTURE_UNAVAILABLE", p.mint, {
            positionId: p.id,
          });
        if (p.strategy !== "KRONOS")
          this.updateExitSafety(p.id, { history: h, replaceHistory: true });
        const current = this.store
            .managedPositions(p.mode)
            .find((x) => x.id === p.id),
          m = this.store.latest<Market>("position_market", p.mint),
          sec = this.store.latest<Security>("position_security", p.mint);
        if (current?.strategy === "KRONOS") {
          if (h) {
            this.store.record("position_history", p.mint, h);
            this.scheduleKronosPosition(current, h);
          }
          return;
        }
        if (current && m && sec) this.scheduleExitAnalysis(current, m, sec, {});
      },
      (p) =>
        this.store
          .managedPositions(p.mode)
          .some(
            (x) =>
              x.id === p.id && x.state === "OPEN" && x.quantity === p.quantity,
          ),
    );
  }
  updateSettings(v: unknown) {
    this.settings = settingsSchema.parse(v);
    this.gmgn.configure(this.settings);
    this.store.set("strategyV2", this.settings);
    this.store.event(
      "SETTINGS",
      undefined,
      "Non-secret strategy parameters saved",
    );
  }
  async balance() {
    if (env.TRADING_MODE === "live") {
      if (!env.WALLET_PUBLIC_KEY)
        throw new Blocked("MISSING_WALLET_PUBLIC_KEY");
      return this.rpc.balance(env.WALLET_PUBLIC_KEY);
    }
    let cash = this.store.get<string>("paperCash");
    if (cash === undefined) {
      let initial: bigint;
      let source = "SIMULATED";
      if (env.WALLET_PUBLIC_KEY) {
        initial = await this.rpc.balance(env.WALLET_PUBLIC_KEY);
        source = "PAPER_INITIALIZED_FROM_REAL_BALANCE";
      } else initial = BigInt(Math.floor(env.PAPER_INITIAL_SOL * 1e9));
      cash = initial.toString();
      this.store.set("paperCash", cash);
      this.store.set("paperBalanceSource", source);
    }
    return BigInt(cash);
  }
  async start() {
    this.stopping = false;
    await this.balance().catch(() => {});
    await this.executor.recover(this.settings);
    if (
      this.store
        .positions()
        .some(
          (p) =>
            p.provider !== "JUPITER" &&
            ["OPEN", "PARTIAL_EXIT", "PENDING_ENTRY", "PENDING_EXIT"].includes(
              p.state,
            ),
        )
    )
      this.store.halt(
        "Legacy open positions require review before Jupiter migration",
      );
    if (env.TRADING_MODE === "live" && env.WALLET_PUBLIC_KEY) {
      try {
        await this.monitor();
      } catch {
        this.store.halt("Wallet/open-position recovery is unavailable");
      }
    }
    this.running = true;
    this.exitTimer = setInterval(() => {
      void this.processExits();
      if (env.TRADING_MODE === "live") void this.exitLiquidity.pump();
      this.positionHistory.pump();
      void this.monitor().catch(() => {
        this.lastError = "Position monitoring failed";
      });
    }, 5000);
    if (env.SCANNER_ENABLED) this.schedule(0);
    if (env.SCANNER_ENABLED)
      this.discoveryTimer = setInterval(() => void this.discovery.poll(), 5000);
  }
  private schedule(ms: number) {
    this.timer = setTimeout(() => {
      void this.tick().finally(() => {
        if (this.running) this.schedule(env.SCAN_INTERVAL_MS);
      });
    }, ms);
  }
  async stop() {
    this.stopping = true;
    this.running = false;
    this.kronos.stop();
    if (this.timer) clearTimeout(this.timer);
    if (this.exitTimer) clearInterval(this.exitTimer);
    if (this.discoveryTimer) clearInterval(this.discoveryTimer);
    await this.discovery.stop();
    await this.exitLiquidity.stop();
    await this.positionHistory.stop();
    await this.exitScheduler.stop();
    await Promise.all(this.kronosJobs.values());
    await this.gmgn.coordinator.stop();
    await this.settleEntryEvaluations();
    await Promise.all(this.smartMoneyJobs.values());
    while (
      this.scanning ||
      this.collector.size > 0 ||
      this.monitoring > 0 ||
      this.watchObserving ||
      this.executor.isBusy ||
      this.executionLoop
    )
      await sleep(50);
  }
  dismissPosition(id: string) {
    const p = this.store.dismissPosition(id, env.TRADING_MODE);
    this.exitScheduler.remove(id);
    this.exitLiquidity.prune(
      this.store.managedPositions(env.TRADING_MODE).map((p) => p.id),
    );
    this.exitScheduled.delete(id);
    return p;
  }
  dismissStructureWatch(mint: string) {
    const row = this.structure.dismiss(mint);
    this.candidates.dismiss(mint);
    this.watchAttempts.delete(mint);
    return row;
  }
  emergency(id: string, sellBps = 10000) {
    if (!Number.isInteger(sellBps) || sellBps < 1 || sellBps > 10000)
      throw new Blocked("Sell fraction must be between 0.01% and 100%");
    const p = this.store
      .positions(env.TRADING_MODE)
      .find((p) => p.id === id && p.state === "OPEN" && !p.dismissal);
    if (!p) throw new Blocked("Position is not open");
    this.store.atomic(() => {
      for (const old of this.manual.filter((x) => x.positionId === id)) {
        if (["CLAIMED", "SUBMITTED"].includes(old.state))
          throw new Blocked("MANUAL_EXIT_ALREADY_PENDING");
        old.state = "CANCELLED";
        this.store.saveManual(old);
      }
      this.store.saveManual({
        id: randomUUID(),
        positionId: id,
        mode: p.mode,
        sellBps,
        createdAt: Date.now(),
        state: "REQUESTED",
      });
      const current = this.store.positions(p.mode).find((x) => x.id === id)!;
      current.decisionRevision = (current.decisionRevision ?? 0) + 1;
      this.store.savePosition(current);
    });
    this.store.event("EXIT_SIGNAL", p.mint, "Manual exit queued");
  }
  async solUsd() {
    const info = await this.gmgn.info(SOL, 30000, {
      priority: 0,
      consumer: "sol-valuation",
    });
    const market = normalizeMarket(info);
    if (
      !market.priceUsd ||
      market.price.state !== "KNOWN" ||
      market.price.value <= 0
    )
      throw new Blocked("Real GMGN SOL/USD price is unavailable");
    this.solPrice = market.priceUsd;
    this.solPriceAt = market.at;
    return market.priceUsd;
  }
  solUsdEvidence() {
    return this.solPrice &&
      this.solPriceAt &&
      this.solPriceAt <= Date.now() &&
      Date.now() - this.solPriceAt <= this.settings.maxSnapshotAgeMs
      ? {
          price: this.solPrice,
          at: this.solPriceAt,
          source: "GMGN_TOKEN_INFO_SOL_SNAPSHOT",
        }
      : undefined;
  }
  private async context(
    mint: string,
    excludeId?: string,
    excludeClaimId?: string,
  ) {
    const own = excludeId
      ? this.store.pending().find((e) => e.intent.id === excludeId)
      : undefined;
    return {
      balance: await this.balance(),
      pending:
        this.store.reserved(env.TRADING_MODE) -
        (own?.intent.side === "BUY" ? BigInt(own.intent.amount) : 0n),
      positions: this.store
        .positions(env.TRADING_MODE)
        .filter(
          (p) =>
            ["OPEN", "PENDING_ENTRY", "PENDING_EXIT"].includes(p.state) &&
            p.id !== own?.intent.positionId,
        ).length,
      duplicate: this.store.entryBlocked(
        mint,
        env.TRADING_MODE,
        excludeId,
        excludeClaimId,
      ),
      entriesEnabled: !this.stopping && this.store.entriesEnabled(),
    };
  }
  private saveDecision(mint: string, r: RiskResult, updateLifecycle = true) {
    if (
      (r.outcome === "SKIP_RUG" || r.outcome === "SKIP_MARKET") &&
      hasEntryWatchEligibility(this.structure.get(mint))
    )
      this.structure.invalidate(mint, r.reason);
    if (updateLifecycle) this.candidates.decision(mint, r);
    this.store.db
      .prepare("UPDATE tokens SET processed=1 WHERE mint=?")
      .run(mint);
    this.store.record("risk_decisions", mint, { ...r, mode: env.TRADING_MODE });
    this.store.record("decisions", mint, { ...r, mode: env.TRADING_MODE });
    const learning = this.store.latest<Record<string, unknown>>(
      "learning_decision_log",
      mint,
    );
    if (learning)
      this.store.record("learning_decision_audit", mint, {
        ...learning,
        riskOutcome: r.outcome,
        riskReason: r.reason,
      });
    this.store.event(
      r.allowed
        ? "RISK_ALLOW"
        : r.outcome === "SKIP_RUG"
          ? "RUG_REJECT"
          : "RISK_REJECT",
      mint,
      r.reason,
    );
  }
  private async isolate(
    error: unknown,
    mint: string | undefined,
    stage: FailureStage,
    position?: Position,
    candidateOnly = false,
  ) {
    position ??=
      mint && !candidateOnly
        ? this.store
            .positions(env.TRADING_MODE)
            .find(
              (p) =>
                p.mint === mint &&
                ["OPEN", "PENDING_EXIT"].includes(p.state) &&
                BigInt(p.quantity) > 0n,
            )
        : undefined;
    if (position) {
      const id = position.id;
      position =
        this.store.positions(position.mode).find((p) => p.id === id) ??
        position;
    }
    const submitted = this.store
      .pending()
      .some(
        (e) =>
          (!mint || e.intent.mint === mint) &&
          !!e.signature &&
          (!candidateOnly ||
            !this.attempts.current ||
            e.intent.id === this.attempts.current.summaries.intentId),
      );
    const info = failureInfo(error, {
      mint,
      symbol:
        position?.symbol ?? (mint ? this.store.token(mint)?.symbol : undefined),
      stage,
      position: !!position,
      submitted,
    });
    if (
      (error instanceof CandidateRejected ||
        (error instanceof ProviderFailure && error.retryable)) &&
      !submitted &&
      mint &&
      this.store.candidateAuthority(mint, env.TRADING_MODE)
        .entryWatchDismissedAt &&
      (!position || position.dismissal)
    )
      return true;
    if (
      position?.dismissal &&
      !submitted &&
      (error instanceof CandidateRejected ||
        (error instanceof ProviderFailure && error.retryable))
    )
      return true;
    if (
      error instanceof ProviderFailure &&
      error.provider === "GMGN" &&
      error.retryable &&
      !submitted
    ) {
      if (position) {
        const current = this.store
          .positions(position.mode)
          .find((p) => p.id === position.id);
        if (current) {
          current.monitoring = {
            status: "DEGRADED",
            lastAttemptAt: Date.now(),
            lastSuccessAt: current.monitoring?.lastSuccessAt,
            nextCheckAt: Date.now() + this.settings.positionRecheckMs,
            issue: info,
          };
          this.store.savePosition(current);
        }
      }
      this.store.record("provider_incidents", mint, {
        ...info,
        provider: "GMGN",
        disposition: position
          ? "POSITION_BACKOFF"
          : mint
            ? "CANDIDATE_OUT"
            : "PROVIDER_COOLDOWN",
      });
      return true;
    }
    if (
      error instanceof ProviderFailure &&
      this.providerFailures.observe(error, mint ?? "DISCOVERY")
    ) {
      info.scope = "SYSTEM";
      info.retryable = false;
    }
    if (info.scope === "SYSTEM" || info.scope === "TRANSACTION") {
      this.store.record("scoped_failures", mint, info);
      this.store.halt(`${info.scope} failure: ${info.code}`, info.scope);
      this.lastError = info.code;
      if (position) this.positionIssue(position, info);
      return false;
    }
    if (position) this.positionIssue(position, info);
    else if (!mint) {
      this.store.record("provider_incidents", undefined, info);
      this.store.event("PROVIDER_INVESTIGATION", undefined, info.code);
    } else {
      if (error instanceof CandidateRejected && !info.retryable && mint)
        this.structure.invalidate(mint, info.code);
      this.candidates.fail(info);
      if (mint) {
        this.store.record("candidate_rejections", mint, {
          reason: info.code,
          details: info.details,
          scope: info.scope,
          at: info.detectedAt,
        });
        this.saveDecision(mint, decision("SKIP_MARKET", info.code), false);
      }
    }
    return true;
  }
  private positionIssue(position: Position, issue: FailureInfo) {
    const current = this.store
      .positions(position.mode)
      .find((p) => p.id === position.id);
    if (!current || current.state === "CLOSED") return;
    if (issue.stage === "POSITION_MONITOR") {
      current.monitoring = {
        status: "DEGRADED",
        lastAttemptAt: issue.detectedAt,
        lastSuccessAt: current.monitoring?.lastSuccessAt,
        nextCheckAt: issue.detectedAt + this.settings.positionRecheckMs,
        issue,
      };
      if (current.attention?.issue.stage === "PRE_SELL") {
        this.store.savePosition(current);
        this.store.metric("positionFailures");
        this.store.record("position_failures", current.mint, {
          positionId: current.id,
          ...issue,
        });
        return;
      }
    }
    const count = Math.min(
      this.settings.tokenFailureThreshold,
      (current.attention?.failureCount ?? 0) + 1,
    );
    const cooldown =
      count >= this.settings.tokenFailureThreshold
        ? this.settings.recentRejectTtlMs
        : this.settings.positionRecheckMs;
    current.attention = {
      status:
        issue.scope === "TRANSACTION"
          ? "UNKNOWN"
          : issue.stage === "PRE_SELL"
            ? "NEEDS_ATTENTION"
            : "MONITORING_DEGRADED",
      issue,
      lastChecked: issue.detectedAt,
      nextCheckAt: issue.detectedAt + cooldown,
      failureCount: count,
      protectiveExit: issue.scope === "TRANSACTION" ? "RECONCILING" : "BACKOFF",
    };
    current.exitStatus = issue.code;
    this.store.savePosition(current);
    this.store.metric("positionFailures");
    this.store.record("position_failures", current.mint, {
      positionId: current.id,
      ...issue,
      attention: current.attention,
    });
    this.store.event(
      "POSITION_ATTENTION",
      current.mint,
      `${current.symbol ?? current.mint} · ${issue.code} · protective exit ${current.attention.protectiveExit}`,
    );
  }
  async tick() {
    if (this.scanning) return;
    this.scanning = true;
    try {
      await this.executor.recover(this.settings);
      void this.monitor().catch(() => {
        this.lastError = "Position monitoring failed";
      });
      if (this.stopping) return;
      await this.discovery.poll();
      if (this.gmgn.coordinator.cooling) return;
      let processed = 0;
      const inspected = new Set<string>();
      while (!this.stopping && processed < this.settings.candidatesPerCycle) {
        const queue = this.candidates.refill(this.store.tokens());
        const mint = queue.find((m) => !inspected.has(m));
        if (!mint) break;
        inspected.add(mint);
        processed++;
        this.candidates.setState(mint, "ANALYZING");
        try {
          await this.analyze(mint);
        } catch (error) {
          if (
            !(await this.isolate(
              error,
              mint,
              this.stages.get(mint) ?? "DEEP_CHECK",
              undefined,
              true,
            ))
          )
            break;
        } finally {
          this.candidates.finish(mint);
          this.stages.delete(mint);
        }
        // A deferred/rejected mint is removed before admitting the next best candidate.
        this.candidates.refill(this.store.tokens());
      }
    } catch (error) {
      await this.isolate(error, undefined, "DISCOVERY");
    } finally {
      this.scanning = false;
      this.lastTick = Date.now();
    }
  }
  private analyzing = new Set<string>();
  private watchObserving = false;
  private watchAttempts = new Map<string, number>();
  private watchRefresh = { success: 0, deferred: 0, feedReused: 0 };
  /** Legacy API retained; candidate watches never collect or retry. */
  async observeStructureWatches() {}
  async analyze(mint: string) {
    if (this.analyzing.has(mint) || this.attempts.current?.result === "RUNNING")
      return;
    const candidate = this.store.token(mint);
    if (!candidate)
      throw new CandidateRejected("TOKEN_DATA_INCOMPLETE", { mint });
    this.analyzing.add(mint);
    this.candidates.setState(mint, "ANALYZING");
    this.attempts.begin(candidate);
    this.store.metric("TRENDINGAnalyzed");
    this.store.event("ATTEMPT_STARTED", mint, this.attempts.current!.attemptId);
    try {
      await oneShotEntry(
        this,
        mint,
        (id, claimId) => this.context(mint, id, claimId),
        () => this.manualReady || this.executionLoop || this.stopping,
      );
    } catch (error) {
      const signed = this.store
        .pending()
        .some(
          (e) =>
            e.intent.id === this.attempts.current?.summaries.intentId &&
            e.intent.mode === env.TRADING_MODE &&
            e.signature,
        );
      this.attempts.end(signed ? "RECONCILING" : "REJECTED", error);
      throw error;
    } finally {
      if (String(this.attempts.current?.result) === "RUNNING")
        this.attempts.end(
          "REJECTED",
          Error("ATTEMPT_ENDED_WITHOUT_CONFIRMED_POSITION"),
        );
      this.candidates.finish(mint);
      this.stages.delete(mint);
      this.analyzing.delete(mint);
    }
  }
  async monitor() {
    if (this.stopping) return;
    this.monitoring++;
    try {
      const eligible = new Set(
        this.store
          .managedPositions(env.TRADING_MODE)
          .filter((p) => ["OPEN", "PENDING_EXIT"].includes(p.state))
          .map((p) => p.id),
      );
      for (const id of this.exitScheduled.keys())
        if (!eligible.has(id)) this.exitScheduled.delete(id);
      this.capitalFlow.prune(env.TRADING_MODE, [
        ...eligible,
        ...this.store
          .positions(env.TRADING_MODE)
          .filter((p) => p.dismissal)
          .map((p) => p.id),
      ]);
      this.exitLiquidity.prune([...eligible]);
      this.positionHistory.prune([...eligible]);
      const collection = this.store
        .managedPositions(env.TRADING_MODE)
        .filter(
          (p) =>
            p.provider === "JUPITER" &&
            ["OPEN", "PENDING_EXIT"].includes(p.state),
        )
        .map((position) =>
          this.collector.collect(position.id, async () => {
            const p = this.store
              .positions(position.mode)
              .find((p) => p.id === position.id);
            if (!p || this.stopping) return;
            if (
              p.monitoring?.nextCheckAt &&
              p.monitoring.nextCheckAt > Date.now()
            )
              return;
            if (p.lastQuoteAt && Date.now() - p.lastQuoteAt < 15000) return;
            try {
              const candidate = this.store.token(p.mint) ?? {
                mint: p.mint,
                source: p.source ?? "gmgn",
                discoveredAt: p.entryAt,
              };
              const sec = await this.gmgn.security(candidate, this.settings, {
                priority: 0,
                consumer: "position-monitor",
              });
              if (!this.store.positionManaged(p.id, p.mode)) return;
              this.store.record("position_security", p.mint, sec);
              this.updateExitSafety(p.id, { security: sec });
              if (
                p.state === "OPEN" &&
                sec.findings.some((f) => f.level === "CRITICAL")
              )
                this.rememberProtection(
                  p,
                  "Critical GMGN security deterioration",
                );
              const info = await this.gmgn.info(p.mint, 10000, {
                  priority: 0,
                  consumer: "position-monitor",
                }),
                market = normalizeMarket(info);
              if (!this.store.positionManaged(p.id, p.mode)) return;
              this.store.record("position_market", p.mint, market);
              // Liquidity/security evidence never waits for price, decimals, FX or PnL.
              this.updateExitSafety(p.id, { market, security: sec });
              if (p.state === "OPEN") this.positionHistory.schedule(p);
              if (!market.priceUsd || p.decimals === undefined)
                throw new CandidateRejected("TOKEN_DATA_INCOMPLETE", {
                  mint: p.mint,
                  reason: "POSITION_MARKET_DATA_UNAVAILABLE",
                });
              if (p.state === "PENDING_EXIT") {
                p.monitoring = {
                  status: "DEGRADED",
                  lastAttemptAt: Date.now(),
                  lastSuccessAt: Date.now(),
                  nextCheckAt: Date.now() + 15000,
                };
                const pending = this.store.saveObservation(p);
                if (pending) {
                  pending.flow = this.capitalFlow.observe(
                    pending,
                    market,
                    info,
                  );
                  this.store.savePosition(pending);
                }
                return;
              }
              const solUsd = await this.solUsd();
              if (!this.store.positionManaged(p.id, p.mode)) return;
              const value = paperValue(
                BigInt(p.quantity),
                solUsd,
                market.priceUsd,
                p.decimals,
              );
              p.lastValueLamports = value.toString();
              p.lastQuoteAt = Date.now();
              p.valuationQuantity = p.quantity;
              p.valuationStatus = "OBSERVED";
              const accounting = tradeAccounting(p, this.store.executions());
              if (accounting.grossPnlPct !== null) {
                p.grossMfePercent = Math.max(
                  0,
                  p.grossMfePercent ?? 0,
                  accounting.grossPnlPct,
                );
                p.grossMaePercent = Math.min(
                  0,
                  p.grossMaePercent ?? 0,
                  accounting.grossPnlPct,
                );
                p.mfePercent = p.grossMfePercent;
                p.maePercent = p.grossMaePercent;
              }
              p.grossHighWaterLamports = (
                value >
                BigInt(
                  p.grossHighWaterLamports ??
                    accounting.remainingPrincipalLamports ??
                    "0",
                )
                  ? value
                  : BigInt(
                      p.grossHighWaterLamports ??
                        accounting.remainingPrincipalLamports ??
                        "0",
                    )
              ).toString();
              if (value > BigInt(p.highWaterLamports))
                p.highWaterLamports = value.toString();
              p.monitoring = {
                status: "ACTIVE",
                lastAttemptAt: Date.now(),
                lastSuccessAt: Date.now(),
              };
              const saved = this.store.saveObservation(p);
              if (!saved) return;
              const previousFlow = saved.flow?.signalKey;
              saved.flow = this.capitalFlow.observe(saved, market, info);
              saved.flowRevision =
                (saved.flowRevision ?? 0) +
                Number(previousFlow !== saved.flow.signalKey);
              saved.flowUpdatedAt = saved.flow.at;
              saved.securityUpdatedAt = sec.at;
              if (saved.strategy !== "KRONOS")
                saved.runner = this.memory.runner.observe(
                  saved,
                  market,
                  saved.flow,
                );
              this.store.savePosition(saved);
              this.updateExitSafety(saved.id, { market, security: sec });
              Object.assign(
                saved,
                this.store.positions(saved.mode).find((x) => x.id === saved.id),
              );
              if (env.TRADING_MODE === "live")
                this.exitLiquidity.schedule(saved);
              if (saved.strategy !== "KRONOS")
                this.memory.observe(saved, market, sec, value, {
                  holderCount: numberEvidence(record(info).holder_count),
                  smartMoney: numberEvidence(
                    record(record(info).wallet_tags_stat).smart_wallets,
                  ),
                });
              const protective = protectiveExitDecision(
                saved,
                value,
                this.settings,
                {
                  critical: sec.findings.some((f) => f.level === "CRITICAL"),
                  liquidity:
                    market.liquidity.state === "KNOWN"
                      ? market.liquidity.value
                      : undefined,
                },
              );
              if (protective) this.rememberProtection(saved, protective.reason);
              // Jev remains independently observable even while a higher authority owns execution.
              this.scheduleExitAnalysis(saved, market, sec, info);
              // Optional enrichment never delays price/flow/security collection.
              if (saved.strategy !== "KRONOS")
                this.collectPositionSmartMoney(saved);
            } catch (error) {
              const current = this.store
                .positions(p.mode)
                .find((x) => x.id === p.id);
              if (current && !current.dismissal) {
                current.flow = this.capitalFlow.degraded(current);
                this.store.savePosition(current);
              }
              await this.isolate(error, p.mint, "POSITION_MONITOR", p);
            }
          }),
        );
      await Promise.all(collection);
      for (const item of this.memory.counterfactualDue(env.TRADING_MODE)) {
        this.store.set("learningPostAttempt:" + item.id, Date.now());
        try {
          this.memory.observeAfterExit(
            item.id,
            normalizeMarket(
              await this.gmgn.info(item.outcome.mint, 30000, {
                priority: 5,
                consumer: "post-exit-observation",
                staleMs: 45000,
              }),
            ),
          );
        } catch {
          this.store.event(
            "LEARNING_OBSERVATION_UNAVAILABLE",
            item.outcome.mint,
            "Optional post-exit GMGN observation unavailable",
          );
        }
      }
    } finally {
      this.monitoring--;
      if (this.running) void this.processExits();
    }
  }
  private rememberProtection(p: Position, _reason: string) {
    this.updateExitSafety(p.id, {});
  }
  private updateExitSafety(
    id: string,
    input: {
      market?: Market;
      security?: Security;
      history?: MarketHistory;
      replaceHistory?: boolean;
    },
  ) {
    const p = this.store
      .managedPositions(env.TRADING_MODE)
      .find((x) => x.id === id);
    if (!p || !["OPEN", "PENDING_EXIT"].includes(p.state)) return;
    const m =
        input.market ?? this.store.latest<Market>("position_market", p.mint),
      sec =
        input.security ??
        this.store.latest<Security>("position_security", p.mint);
    const result = evaluateExitSafety(p, this.settings, {
      market: m,
      security: sec,
      history: input.replaceHistory ? input.history : p.exitSafety?.history,
    });
    const previous = p.exitSafety?.key;
    p.exitSafety = result;
    p.pendingExits ??= [];
    for (const proof of result.authorities) {
      const old = p.pendingExits.find(
        (x) => x.kind === "PROTECTIVE" && x.protection?.kind === proof.kind,
      );
      if (old) {
        old.protection = proof;
        if (
          ![
            "BLOCKED",
            "SUBMITTED",
            "RECONCILING",
            "WAITING_EXECUTION",
          ].includes(old.lifecycle ?? "")
        )
          old.lifecycle = "AUTHORIZED";
      } else {
        p.pendingExits.push({
          id: randomUUID(),
          kind: "PROTECTIVE",
          reason: proof.reason,
          sellBps: 10000,
          triggeredAt: Date.now(),
          protection: proof,
          lifecycle: "AUTHORIZED",
        });
        this.store.pipelineEvent("PROTECTIVE_DETECTED", p.mint, {
          positionId: p.id,
          authority: proof,
        });
      }
    }
    const cleared: ExitOpportunity[] = [];
    p.pendingExits = p.pendingExits.filter((o) => {
      if (o.kind !== "PROTECTIVE" || !o.protection) return true;
      const kind = o.protection.kind;
      const recovered =
        kind === "SECURITY_CRITICAL"
          ? result.components.security.fresh &&
            !!sec &&
            securityRecoveryConfirmed(o.protection, sec, this.settings)
          : kind === "LIQUIDITY_COLLAPSE"
            ? result.components.liquidity.fresh &&
              result.components.liquidity.value !== null &&
              result.components.liquidity.baseline !== null &&
              result.components.liquidity.baseline > 0 &&
              !result.components.liquidity.collapsed
            : result.components.price.state === "AVAILABLE" &&
              result.components.flow.fresh &&
              result.components.flow.quality === "READY" &&
              !result.authorities.some((x) => x.kind === kind);
      if (recovered) {
        o.lifecycle = "SUPERSEDED";
        cleared.push(o);
        return false;
      }
      return true;
    });
    if (previous !== result.key || cleared.length)
      p.decisionRevision = (p.decisionRevision ?? 0) + 1;
    this.store.savePosition(p);
    for (const o of cleared)
      this.store.pipelineEvent("PROTECTIVE_REVALIDATED", p.mint, {
        positionId: p.id,
        opportunityId: o.id,
        result: "RECOVERED_SUPERSEDED",
      });
    if (this.running && p.pendingExits.some((o) => o.kind === "PROTECTIVE"))
      void this.processExits();
  }
  private intelligenceFailure(error: unknown) {
    return (
      (error instanceof ProviderFailure && error.provider === "GMGN") ||
      (error instanceof Blocked &&
        [
          "MISSING_GMGN_API_KEY",
          "GMGN_PLAN_UPGRADE_REQUIRED",
          "GMGN_AUTHORIZATION_FAILED",
        ].includes(error.code))
    );
  }
  private async revalidateProtection(id: string, opportunityId: string) {
    let p = this.store.positions(env.TRADING_MODE).find((x) => x.id === id),
      o = p?.pendingExits?.find((x) => x.id === opportunityId);
    if (!p || !o?.protection)
      throw new CandidateRejected("TEMPORARY_RISK_CHANGE", {
        reason: "PROTECTIVE_AUTHORITY_MISSING",
      });
    o.lifecycle = "REVALIDATING";
    this.store.savePosition(p);
    try {
      if (o.protection.kind === "SECURITY_CRITICAL") {
        const sec = await this.gmgn.security(
          {
            mint: p.mint,
            source: p.source ?? "POSITION",
            discoveredAt: p.entryAt,
          },
          this.settings,
          { priority: 0, consumer: "protective-revalidation" },
          true,
        );
        this.store.record("position_security", p.mint, sec);
        this.updateExitSafety(id, { security: sec });
      } else {
        const raw = await this.gmgn.info(p.mint, 0, {
            priority: 0,
            consumer: "protective-revalidation",
          }),
          market = normalizeMarket(raw);
        this.store.record("position_market", p.mint, market);
        if (o.protection.kind === "LIQUIDITY_COLLAPSE")
          this.updateExitSafety(id, { market });
        else {
          const rawHistory = await this.gmgn.marketHistory(
            { mint: p.mint, source: "POSITION", discoveredAt: p.entryAt },
            0,
            { priority: 0, consumer: "protective-revalidation" },
          );
          this.updateExitSafety(id, {
            market,
            replaceHistory: true,
            history: parseMarketHistory(rawHistory, {
              mint: p.mint,
              source: "POSITION",
              discoveredAt: p.entryAt,
            }),
          });
        }
      }
    } catch (error) {
      const current = this.store
          .positions(env.TRADING_MODE)
          .find((x) => x.id === id),
        proof = current?.pendingExits?.find(
          (x) => x.id === opportunityId,
        )?.protection;
      if (
        !this.intelligenceFailure(error) ||
        !current ||
        !validProtection(proof, current)
      )
        throw error;
      this.store.pipelineEvent("PROTECTIVE_REVALIDATED", p.mint, {
        positionId: id,
        result: "INTELLIGENCE_UNAVAILABLE_RECENT_PROOF_RETAINED",
      });
    }
    p = this.store.positions(env.TRADING_MODE).find((x) => x.id === id);
    o = p?.pendingExits?.find((x) => x.id === opportunityId);
    if (!p || !o || !validProtection(o.protection, p)) {
      if (p && o) {
        o.lifecycle = "BLOCKED";
        this.store.savePosition(p);
      }
      throw new CandidateRejected("TEMPORARY_RISK_CHANGE", {
        reason: "PROTECTIVE_RECOVERED_OR_WAITING_FRESH_EVIDENCE",
      });
    }
    o.lifecycle = "AUTHORIZED";
    this.store.savePosition(p);
    this.store.pipelineEvent("PROTECTIVE_AUTHORIZED", p.mint, {
      positionId: id,
      opportunityId,
      kind: o.protection!.kind,
    });
  }
  private scheduleKronosPosition(p: Position, history: MarketHistory) {
    if (
      this.stopping ||
      p.strategy !== "KRONOS" ||
      p.state !== "OPEN" ||
      p.dismissal ||
      this.kronosJobs.has(p.id) ||
      !history.historyTo ||
      history.historyTo === (p.kronosDecision?.inputTo ?? 0) ||
      Date.now() - (this.kronosAttempts.get(p.id) ?? 0) < 60000
    )
      return;
    this.kronosAttempts.set(p.id, Date.now());
    const quantity = p.quantity;
    const job = (async () => {
      this.store.pipelineEvent("KRONOS_POSITION_EVALUATION", p.mint, {
        strategy: "KRONOS",
        positionId: p.id,
        inputTo: history.historyTo,
      });
      try {
        if (
          history.freshness !== "FRESH" ||
          history.fetchedAt > Date.now() ||
          Date.now() - history.fetchedAt > this.settings.maxSnapshotAgeMs
        )
          throw Error("KRONOS_HISTORY_STALE");
        const d = await this.kronos.evaluatePosition({
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
        const current = this.store
          .managedPositions(p.mode)
          .find((x) => x.id === p.id);
        if (
          !current ||
          current.strategy !== "KRONOS" ||
          current.state !== "OPEN" ||
          current.quantity !== quantity ||
          this.stopping
        )
          return;
        if (d.action !== "HOLD" && d.action !== "SELL")
          throw Error("KRONOS_POSITION_ACTION_INVALID");
        const market = this.store.latest<Market>("position_market", p.mint);
        current.kronosDecision = {
          ...d,
          quantity,
          inputTo: history.historyTo!,
          inputPriceUsd:
            market?.price.state === "KNOWN" ? market.price.value : undefined,
        };
        current.pendingExits = (current.pendingExits ?? []).filter(
          (o) => o.kind !== "STRATEGIC",
        );
        if (d.action === "SELL")
          current.pendingExits.push({
            id: randomUUID(),
            kind: "STRATEGIC",
            strategy: "KRONOS",
            decisionSource: "KRONOS",
            decisionId: d.decisionId,
            reason: d.reason,
            sellBps: 10000,
            triggeredAt: d.decisionAt,
          });
        this.store.savePosition(current);
        this.store.record("kronos_decisions", p.mint, {
          ...d,
          positionId: p.id,
          mode: p.mode,
        });
        this.store.pipelineEvent("KRONOS_" + d.action, p.mint, {
          strategy: "KRONOS",
          positionId: p.id,
          decisionId: d.decisionId,
          decisionAt: d.decisionAt,
        });
        if (this.running) void this.processExits();
      } catch {
        const current = this.store
          .managedPositions(p.mode)
          .find((x) => x.id === p.id);
        if (current?.strategy === "KRONOS" && current.state === "OPEN") {
          current.pendingExits = current.pendingExits?.filter(
            (o) => o.kind !== "STRATEGIC",
          );
          this.store.savePosition(current);
        }
        this.store.pipelineEvent("KRONOS_INFERENCE_FAILED", p.mint, {
          strategy: "KRONOS",
          positionId: p.id,
        });
      }
    })().finally(() => this.kronosJobs.delete(p.id));
    this.kronosJobs.set(p.id, job);
  }
  private scheduleExitAnalysis(
    p: Position,
    market: Market,
    security: Security,
    info: unknown,
  ) {
    if (p.strategy === "KRONOS") {
      const history = this.store.latest<MarketHistory>(
        "position_history",
        p.mint,
      );
      if (history) this.scheduleKronosPosition(p, history);
      return;
    }
    if (
      p.dismissal ||
      !this.store.positionManaged(p.id, p.mode) ||
      !p.lastValueLamports
    )
      return;
    const previous = p.jevExit,
      at = Date.now(),
      last = this.exitScheduled.get(p.id) ?? previous?.createdAt ?? 0;
    const accounting = tradeAccounting(p, this.store.executions());
    const pnl = accounting.grossPnlPct ?? 0; // Scheduling priority only; JEV receives explicit nullable accounting.
    const retracement =
      100 *
      (1 -
        Number(p.lastValueLamports) /
          Math.max(1, Number(p.grossHighWaterLamports ?? p.lastValueLamports)));
    const liquidity =
      market.liquidity.state === "KNOWN" ? market.liquidity.value : null;
    const volume = market.volume.state === "KNOWN" ? market.volume.value : null;
    const buyPressure =
      market.buys.state === "KNOWN" &&
      market.sells.state === "KNOWN" &&
      market.buys.value + market.sells.value > 0
        ? market.buys.value / (market.buys.value + market.sells.value)
        : null;
    const changed =
      previous &&
      (routeMateriallyChanged(
        previous.exitLiquidityEvidence,
        p.exitLiquidity,
        this.settings,
      ) ||
        previous.evidenceKey !== exitEvidenceKey(p, this.settings) ||
        previous.quantity !== p.quantity ||
        previous.observed?.exitLiquidityStatus !== p.exitLiquidity?.status ||
        previous.observed?.trendingRank !==
          this.store.token(p.mint)?.discovery?.trending?.rank ||
        previous.positionRevision !== (p.decisionRevision ?? 0) ||
        previous.flowSignalKey !== p.flow?.signalKey ||
        Math.abs(pnl - (previous.observed?.pnlPercent ?? pnl)) >=
          this.settings.jevExitMaterialPnlPoints ||
        Math.abs(
          retracement - (previous.observed?.retracementPercent ?? retracement),
        ) >= this.settings.jevExitMaterialPnlPoints ||
        (liquidity !== null &&
          previous.observed?.liquidityUsd &&
          Math.abs(liquidity / previous.observed.liquidityUsd - 1) >= 0.25) ||
        (volume !== null &&
          previous.observed?.volume24h &&
          Math.abs(volume / previous.observed.volume24h - 1) >= 0.5) ||
        (buyPressure !== null &&
          previous.observed?.buyPressure !== null &&
          previous.observed?.buyPressure !== undefined &&
          Math.abs(buyPressure - previous.observed.buyPressure) >= 0.2));
    if (
      !this.exitScheduler.isActive(p.id) &&
      (at - last < this.settings.jevExitMinIntervalMs ||
        (!changed && at - last < this.settings.jevExitRecheckMs))
    )
      return;
    const state = {
      discovery: discoveryContext(
        this.store.token(p.mint),
        at,
        this.settings.trendingFreshMs,
        this.discovery.feeds.TRENDING,
      ),
      exitLiquidity: exitLiquidityContext(p, this.settings, at),
      gmgnQuality: record(info)._gmgnSnapshot,
      gmgnProvider: this.gmgn.coordinator.status().state,
      currentPosition: {
        positionId: p.id,
        positionRevision: p.positionRevision,
        marketRevision: p.marketRevision,
        flowRevision: p.flowRevision,
        quantityRevision: p.quantityRevision,
        updatedAt: p.updatedAt,
        marketUpdatedAt: p.marketUpdatedAt,
        flowUpdatedAt: p.flowUpdatedAt,
        securityUpdatedAt: p.securityUpdatedAt,
        mint: p.mint,
        symbol: p.symbol,
        entryAt: p.entryAt,
        ageMs: at - p.entryAt,
        originalQuantity: p.originalQuantity,
        remainingQuantity: p.quantity,
        walletDebitLamports: p.costLamports,
        remainingWalletDebitBasisLamports: p.remainingCostLamports,
        entryPrincipalLamports: accounting.principalLamports,
        remainingPrincipalLamports: accounting.remainingPrincipalLamports,
        currentValueLamports: p.lastValueLamports,
        realizedPnlLamports: accounting.grossRealizedPnlLamports,
        unrealizedPnlLamports: accounting.grossUnrealizedPnlLamports,
        totalPnlLamports: accounting.grossPnlLamports,
        grossPnlSol:
          accounting.grossPnlLamports === null
            ? null
            : Number(accounting.grossPnlLamports) / 1e9,
        grossPnlPct: accounting.grossPnlPct,
        feesPaidSol:
          accounting.feesPaidLamports === null
            ? null
            : Number(accounting.feesPaidLamports) / 1e9,
        feesPaidUsd: accounting.feesPaidUsd,
        netPnlSol:
          accounting.netPnlLamports === null
            ? null
            : Number(accounting.netPnlLamports) / 1e9,
        netPnlPct: accounting.netPnlPct,
        accounting,
        mfePercent: p.grossMfePercent ?? null,
        maePercent: p.grossMaePercent ?? null,
        highWaterLamports: p.grossHighWaterLamports ?? null,
        remainingExposureBps:
          BigInt(p.originalQuantity) > 0n
            ? Number((BigInt(p.quantity) * 10000n) / BigInt(p.originalQuantity))
            : null,
        previousPartialExits: p.runner?.partialExits,
        executionHealth: p.attention,
        previousDecision: p.jevExit
          ? {
              action: p.jevExit.action,
              sellBps: p.jevExit.sellBps,
              reason: p.jevExit.reason,
              at: p.jevExit.createdAt,
            }
          : null,
        pnlPercent: accounting.grossPnlPct,
        retracementPercent: retracement,
        // Compatibility for scoped fixture providers, never portfolio-wide authority.
        id: p.id,
        quantity: p.quantity,
      },
      currentToken: {
        market,
        security: { ...security, raw: undefined },
        holderCount: numberEvidence(record(info).holder_count),
        smartWalletCount: numberEvidence(
          record(record(info).wallet_tags_stat).smart_wallets,
        ),
      },
      capitalFlow: p.flow,
      exitSafety: p.exitSafety,
      smartMoneySupport:
        this.settings.smartMoneyExitMode !== "OFF" &&
        p.smartMoneySupport &&
        p.smartMoneySupport.freshness === "FRESH" &&
        p.smartMoneySupport.observedAt !== null &&
        p.smartMoneySupport.observedAt <= at &&
        at - p.smartMoneySupport.observedAt <= this.settings.maxSnapshotAgeMs
          ? p.smartMoneySupport
          : smartMoneySupport(unavailableSmartMoney(), p.mint, {
              from: null,
              to: at,
              maxAgeMs: this.settings.maxSnapshotAgeMs,
            }),
      portfolioContext: {
        openPositions: this.store
          .positions(p.mode)
          .filter((x) => x.state === "OPEN").length,
        positionCountIsNotAnExitReason: true,
      },
      policy: {
        stopLoss: false,
        timeExit: false,
        mandatoryTakeProfit: false,
        profitCeiling: false,
        predictExactTop: false,
        referenceUnits: "percent",
        missingDataIsNotZero: true,
        takeProfitReferences: this.settings.takeProfits,
        trailingReference: {
          activationPercent: this.settings.trailingActivationBps / 100,
          distancePercent: this.settings.trailingStopBps / 100,
        },
        safetyOverrides: true,
      },
    };
    if (
      this.exitScheduler.schedule({
        strategy: p.strategy ?? "STANDARD",
        positionId: p.id,
        evidenceKey: exitEvidenceKey(p, this.settings),
        exitLiquidityEvidence: p.exitLiquidity,
        materialKey: JSON.stringify([
          p.exitLiquidity?.levels.map((l) => l.minimumSolOut),
          p.quantity,
          p.decisionRevision,
          p.flow?.signalKey,
          exitEvidenceKey(p, this.settings),
          Math.floor(pnl / this.settings.jevExitMaterialPnlPoints),
          Math.floor(retracement / this.settings.jevExitMaterialPnlPoints),
        ]),
        revision: p.decisionRevision ?? 0,
        flow: p.flow,
        inputAt: at,
        priceUsd:
          market.price.state === "KNOWN" ? market.price.value : undefined,
        mint: p.mint,
        quantity: p.quantity,
        value: p.lastValueLamports,
        state,
        priority:
          Math.min(500, Math.abs(pnl)) +
          retracement +
          (previous?.flowSignalKey !== p.flow?.signalKey ? 100 : 0),
        queuedAt: at,
        observed: {
          smartMoneyObservedAt: state.smartMoneySupport.observedAt,
          smartMoneyStatus: state.smartMoneySupport.status,
          exitLiquidityStatus: p.exitLiquidity?.status,
          trendingRank: this.store.token(p.mint)?.discovery?.trending?.rank,
          pnlPercent: pnl,
          grossPnlKnown: accounting.grossPnlPct !== null,
          mfePercent: p.mfePercent ?? 0,
          retracementPercent: retracement,
          liquidityUsd: liquidity,
          volume24h: volume,
          buyPressure,
        },
      })
    )
      this.exitScheduled.set(p.id, at);
  }
  private collectPositionSmartMoney(p: Position) {
    if (
      this.stopping ||
      this.settings.smartMoneyExitMode === "OFF" ||
      this.smartMoneyJobs.has(p.id)
    )
      return;
    const work = (async () => {
      const snapshot = await this.gmgn.smartMoneyFeed(
        Math.min(30000, this.settings.maxSnapshotAgeMs),
      );
      if (this.stopping) return;
      const current = this.store
        .managedPositions(p.mode)
        .find((x) => x.id === p.id);
      if (
        !current ||
        current.state !== "OPEN" ||
        current.mint !== p.mint ||
        current.quantity !== p.quantity
      )
        return;
      const now = Date.now();
      const evidence = smartMoneySupport(snapshot, p.mint, {
        from: Math.max(p.entryAt, now - this.settings.structureMaxGapMs),
        to: now,
        maxAgeMs: this.settings.maxSnapshotAgeMs,
      });
      const identity = (value: Position["smartMoneySupport"]) =>
        JSON.stringify(
          value ? [value.status, value.events, value.buys, value.sells] : null,
        );
      if (identity(current.smartMoneySupport) !== identity(evidence))
        current.decisionRevision = (current.decisionRevision ?? 0) + 1;
      current.smartMoneySupport = evidence;
      this.store.savePosition(current);
      const market = this.store.latest<Market>("position_market", current.mint);
      const security = this.store.latest<Security>(
        "position_security",
        current.mint,
      );
      if (market && security)
        this.scheduleExitAnalysis(current, market, security, {});
    })()
      .catch(() => {
        /* Optional evidence cannot stop price collection. */
      })
      .finally(() => this.smartMoneyJobs.delete(p.id));
    this.smartMoneyJobs.set(p.id, work);
  }
  private exitEvidenceChanged(d: JevExitDecision) {
    const latest = this.store.latest<Market>("position_market", d.mint);
    const security = this.store.latest<Security>("position_security", d.mint);
    return (
      routeMateriallyChanged(
        d.exitLiquidityEvidence,
        this.store
          .positions(env.TRADING_MODE)
          .find((p) => p.id === d.positionId)?.exitLiquidity,
        this.settings,
      ) ||
      (d.evidenceKey !== undefined &&
        (() => {
          const p = this.store
            .positions(env.TRADING_MODE)
            .find((p) => p.id === d.positionId);
          return !p || exitEvidenceKey(p, this.settings) !== d.evidenceKey;
        })()) ||
      (d.action !== "HOLD" &&
        ["BUY_SUPPORT", "SELL_PRESSURE", "MIXED"].includes(
          d.observed?.smartMoneyStatus ?? "",
        ) &&
        (d.observed?.smartMoneyObservedAt == null ||
          d.observed.smartMoneyObservedAt > Date.now() ||
          Date.now() - d.observed.smartMoneyObservedAt >
            this.settings.maxSnapshotAgeMs)) ||
      (latest?.price.state === "KNOWN" &&
        d.inputPriceUsd !== undefined &&
        d.inputPriceUsd > 0 &&
        latest.at >= (d.inputAt ?? d.createdAt) &&
        Math.abs(latest.price.value / d.inputPriceUsd - 1) * 100 >
          this.settings.maxDecisionPriceMovePercent) ||
      (security &&
        security.at >= (d.inputAt ?? d.createdAt) &&
        security.findings.some((f) => f.level === "CRITICAL"))
    );
  }
  private applyExitDecision(d: JevExitDecision, job: ExitJob) {
    const p = this.store
      .positions(env.TRADING_MODE)
      .find((x) => x.id === d.positionId);
    if (p?.strategy === "KRONOS") return;
    // An analyst failure is an observation, never a revocation of valid authority.
    if (d.action === "NO_DECISION") {
      this.store.saveJevExit(d);
      if (p && !p.dismissal) {
        p.lastAnalystAttempt = d;
        this.store.savePosition(p);
      }
      this.store.pipelineEvent("JEV_NO_DECISION", d.mint, {
        positionId: d.positionId,
        state: d.decisionState,
        reason: d.reason,
        error: d.error,
      });
      return;
    }
    const signed = this.store
      .pending()
      .some((e) => e.intent.positionId === d.positionId && e.signature);
    if (
      !p ||
      p.dismissal ||
      p.state !== "OPEN" ||
      p.mint !== d.mint ||
      p.quantity !== d.quantity ||
      (p.decisionRevision ?? 0) !== (d.positionRevision ?? 0) ||
      (d.flowSignalKey !== undefined &&
        p.flow?.signalKey !== d.flowSignalKey) ||
      signed ||
      this.exitEvidenceChanged(d) ||
      (d.inputAt ?? job.queuedAt) > Date.now() ||
      Date.now() - (d.inputAt ?? job.queuedAt) >
        this.settings.jevExitDecisionMaxAgeMs ||
      !p.lastQuoteAt ||
      Date.now() - p.lastQuoteAt > this.settings.jevExitDecisionMaxAgeMs ||
      Math.abs(
        Number(p.lastValueLamports) /
          Math.max(1, Number(d.inputValueLamports)) -
          1,
      ) *
        100 >
        this.settings.maxDecisionPriceMovePercent
    ) {
      d.status = "SUPERSEDED";
      d.decisionState = "SUPERSEDED";
      this.store.pipelineEvent("JEV_SUPERSEDED", d.mint, {
        positionId: d.positionId,
      });
      this.exitMetrics.staleRejected++;
      this.store.saveJevExit(d);
      return;
    }
    this.store.atomic(() => {
      if (d.action === "HOLD") this.exitMetrics.hold++;
      else if (d.action === "FULL_SELL") this.exitMetrics.fullSell++;
      else this.exitMetrics.partialSell++;
      const meaningful =
        !p.jevExit ||
        p.jevExit.action !== d.action ||
        p.jevExit.sellBps !== d.sellBps ||
        p.jevExit.reason !== d.reason ||
        p.jevExit.flowSignalKey !== d.flowSignalKey ||
        Math.abs(p.jevExit.confidence - d.confidence) >= 0.15 ||
        Math.abs(
          (p.jevExit.observed?.pnlPercent ?? 0) - (d.observed?.pnlPercent ?? 0),
        ) >= this.settings.jevExitMaterialPnlPoints;
      const last = p.lastStrategicExit;
      if (
        d.action !== "HOLD" &&
        last &&
        (Date.now() - last.at < this.settings.jevExitTradeCooldownMs ||
          (d.flowSignalKey !== undefined &&
            d.flowSignalKey === last.flowSignalKey &&
            d.observed?.grossPnlKnown !== false &&
            last.grossPnlKnown !== false &&
            Math.abs((d.observed?.pnlPercent ?? 0) - (last.pnlPercent ?? 0)) <
              this.settings.jevExitMaterialPnlPoints))
      ) {
        d.status = "CANCELLED";
        d.error = "STRATEGIC_COOLDOWN_OR_UNCHANGED_EVIDENCE";
        this.exitMetrics.duplicateExitPrevented++;
      }
      for (const old of p.pendingExits?.filter((x) => x.kind === "STRATEGIC") ??
        []) {
        const decision = this.store.jevExit(old.decisionId!);
        if (decision) {
          decision.status = "SUPERSEDED";
          this.store.saveJevExit(decision);
        }
      }
      p.pendingExits = (p.pendingExits ?? []).filter(
        (x) => x.kind !== "STRATEGIC",
      );
      if (d.action !== "HOLD" && !d.error) {
        d.status = "QUEUED";
        p.pendingExits.push({
          id: randomUUID(),
          kind: "STRATEGIC",
          reason: d.reason,
          sellBps: d.sellBps,
          triggeredAt: Date.now(),
          decisionId: d.id,
        });
      }
      p.jevExit = d;
      p.lastAnalystAttempt = d;
      this.store.savePosition(p);
      this.store.saveJevExit(d);
      this.memory.runner.decision(d, p);
      if (meaningful)
        this.store.record("jev_exit_context", p.mint, {
          policyVersion: "CAPITAL_FLOW_V1",
          decision: d,
          input: job.state,
        });
      if (meaningful)
        this.store.event(
          "JEV_DECIDED_" + d.action,
          p.mint,
          d.reason + (d.error ? "; not authorized: " + d.error : ""),
        );
    });
    if (this.running) void this.processExits();
  }
  async processExits() {
    if (this.executionLoop || this.executor.isBusy || this.stopping) return;
    this.executionLoop = true;
    try {
      for (const e of this.store
        .pending()
        .filter((e) => e.intent.mode === env.TRADING_MODE && e.signature))
        await this.executor.reconcile(e, this.settings);
      for (let n = 0; n < this.settings.exitExecutionsPerCycle; n++) {
        if (
          this.stopping ||
          this.executor.isBusy ||
          this.store
            .pending()
            .some((e) => e.intent.mode === env.TRADING_MODE && e.signature)
        )
          break;
        const queue = this.store
          .managedPositions(env.TRADING_MODE)
          .filter((p) => p.provider === "JUPITER" && p.state === "OPEN")
          .flatMap((p) => {
            let manual = this.manual.find(
              (r) =>
                r.positionId === p.id &&
                ["REQUESTED", "FAILED_RETRYABLE"].includes(r.state),
            );
            if (
              manual?.state !== "REQUESTED" &&
              (!!manual ||
                !p.pendingExits?.some((x) => x.kind === "PROTECTIVE")) &&
              p.attention?.issue.stage === "PRE_SELL" &&
              p.attention.nextCheckAt > Date.now()
            ) {
              // A backed-off manual request must not suppress independently
              // authorized protection. Keep the manual request for later review.
              if (
                p.pendingExits?.some(
                  (x) =>
                    x.kind === "PROTECTIVE" &&
                    (!x.retry || x.retry.nextAt <= Date.now()),
                )
              )
                manual = undefined;
              else return [];
            }
            const opportunity =
              p.pendingExits
                ?.filter(
                  (x) =>
                    x.kind === "PROTECTIVE" &&
                    (!x.retry || x.retry.nextAt <= Date.now()),
                )
                .sort(
                  (a, b) =>
                    exitPriority(undefined, a) - exitPriority(undefined, b) ||
                    a.triggeredAt - b.triggeredAt,
                )[0] ??
              p.pendingExits?.find(
                (x) =>
                  x.kind === "STRATEGIC" &&
                  (p.strategy === "KRONOS"
                    ? x.decisionSource === "KRONOS"
                    : x.decisionSource !== "KRONOS"),
              );
            if (!manual && !opportunity) return [];
            const rank = exitPriority(manual?.sellBps, opportunity);
            return [
              {
                p,
                manual,
                opportunity,
                rank,
                at: manual?.createdAt ?? opportunity!.triggeredAt,
              },
            ];
          })
          .sort((a, b) => a.rank - b.rank || a.at - b.at);
        const item = queue[0];
        if (!item) break;
        const { p } = item;
        const manual = item.manual;
        let opportunity = manual ? undefined : item.opportunity;
        try {
          const candidate = this.store.token(p.mint) ?? {
            mint: p.mint,
            source: p.source ?? "gmgn",
            discoveredAt: p.entryAt,
          };
          let security: Security | undefined;
          try {
            security = await this.gmgn.security(candidate, this.settings, {
              priority: 0,
              consumer: "exit-safety",
            });
          } catch (error) {
            if (
              !this.intelligenceFailure(error) ||
              !(manual || validProtection(opportunity?.protection, p))
            )
              throw error;
            this.store.record("provider_incidents", p.mint, {
              provider: "GMGN",
              code: safeError(error),
              disposition: "INDEPENDENT_EXIT_CONTINUES",
              at: Date.now(),
            });
          }
          if (!this.store.positionManaged(p.id, p.mode)) continue;
          if (security) {
            this.store.record("position_security", p.mint, security);
            this.updateExitSafety(p.id, { security });
          }
          if (!manual && opportunity?.kind === "STRATEGIC") {
            const market = normalizeMarket(await this.gmgn.info(p.mint));
            this.store.record("position_market", p.mint, market);
            this.updateExitSafety(p.id, { market });
          }
          if (!manual) {
            const current = this.store
              .positions(p.mode)
              .find((x) => x.id === p.id)!;
            const protective = current.pendingExits
              ?.filter(
                (x) =>
                  x.kind === "PROTECTIVE" &&
                  (!x.retry || x.retry.nextAt <= Date.now()),
              )
              .sort(
                (a, b) =>
                  exitPriority(undefined, a) - exitPriority(undefined, b) ||
                  a.triggeredAt - b.triggeredAt,
              )[0];
            opportunity =
              protective ??
              current.pendingExits?.find((x) => x.id === opportunity?.id);
            if (!opportunity) continue;
          }
          if (
            !manual &&
            opportunity?.kind === "STRATEGIC" &&
            p.strategy !== "KRONOS"
          ) {
            if (
              !p.jevExit ||
              p.jevExit.id !== opportunity.decisionId ||
              p.jevExit.quantity !== p.quantity ||
              Date.now() - (p.jevExit.inputAt ?? p.jevExit.createdAt) >
                this.settings.jevExitDecisionMaxAgeMs
            ) {
              const current = this.store
                .positions(p.mode)
                .find((x) => x.id === p.id)!;
              current.pendingExits = current.pendingExits?.filter(
                (x) => x.id !== opportunity!.id,
              );
              if (
                current.jevExit &&
                current.jevExit.id === opportunity.decisionId
              ) {
                current.jevExit.status = "CANCELLED";
                this.store.saveJevExit(current.jevExit);
              }
              this.store.savePosition(current);
              continue;
            }
          }
          if (this.executor.isBusy) break;
          const current = this.store
            .positions(p.mode)
            .find((x) => x.id === p.id)!;
          current.finalExitAction = {
            authority: manual
              ? "MANUAL"
              : opportunity?.kind === "PROTECTIVE"
                ? opportunity.protection?.kind === "SECURITY_CRITICAL"
                  ? "SECURITY"
                  : "PROTECTIVE"
                : current.strategy === "KRONOS"
                  ? "KRONOS"
                  : "JEV",
            reason: manual ? "Manual emergency exit" : opportunity!.reason,
            sellBps: manual?.sellBps ?? opportunity!.sellBps,
            at: Date.now(),
            decisionId: opportunity?.decisionId,
          };
          this.store.savePosition(current);
          this.store.record("exit_authority", p.mint, {
            positionId: p.id,
            strategy: current.strategy ?? "STANDARD",
            latestJev:
              current.strategy === "KRONOS" ? undefined : current.jevExit,
            latestKronos: current.kronosDecision,
            final: current.finalExitAction,
          });
          await this.exitPosition(
            current,
            manual?.sellBps ?? opportunity!.sellBps,
            manual ? "Manual emergency exit" : opportunity!.reason,
            undefined,
            manual,
            opportunity,
          );
        } catch (error) {
          if (opportunity?.kind === "PROTECTIVE") {
            const current = this.store
                .positions(p.mode)
                .find((x) => x.id === p.id),
              o = current?.pendingExits?.find((x) => x.id === opportunity!.id);
            if (current && o) {
              o.retry = protectiveRetry(error, o.retry);
              const signed = this.store
                .pending()
                .some((e) => e.intent.positionId === p.id && !!e.signature);
              if (signed) {
                o.retry.classification = "SIGNED_UNKNOWN";
                o.retry.nextAt = Number.MAX_SAFE_INTEGER;
              }
              o.lifecycle = signed ? "RECONCILING" : "BLOCKED";
              this.store.savePosition(current);
              this.store.pipelineEvent("PROTECTIVE_BLOCKED", p.mint, {
                positionId: p.id,
                kind: o.protection?.kind,
                retry: o.retry,
              });
              this.store.pipelineEvent(
                o.retry.classification === "NO_ROUTE"
                  ? "EXIT_NO_ROUTE"
                  : "EXIT_BACKOFF",
                p.mint,
                { positionId: p.id, retry: o.retry },
              );
            }
          }
          await this.isolate(error, p.mint, "PRE_SELL", p);
          const manualId = manual?.id;
          const r =
            manualId &&
            this.store.manualRequests(p.mode).find((x) => x.id === manualId);
          if (r && r.state === "REQUESTED") {
            r.state = "FAILED_RETRYABLE";
            this.store.saveManual(r);
          }
        }
      }
    } catch {
      this.store.halt(
        "Pending Solana transaction cannot be reconciled",
        "TRANSACTION",
      );
    } finally {
      this.executionLoop = false;
    }
  }
  async settleExitWork() {
    await this.exitScheduler.idle();
    await this.processExits();
    while (this.executionLoop) await sleep(5);
  }

  private async exitPosition(
    p: Position,
    bps: number,
    reason: string,
    takeProfitIndex?: number,
    manual?: ManualExitRequest,
    opportunity?: ExitOpportunity,
  ) {
    if (
      !manual &&
      !opportunity &&
      reason !== "Take profit" &&
      reason !== "Trailing profit"
    ) {
      const current = this.store.positions(p.mode).find((x) => x.id === p.id)!;
      opportunity = current.pendingExits?.find((x) => x.reason === reason);
      if (!opportunity) {
        opportunity = {
          id: randomUUID(),
          kind: "PROTECTIVE",
          reason,
          sellBps: bps,
          triggeredAt: Date.now(),
        };
        current.pendingExits = [...(current.pendingExits ?? []), opportunity];
        this.store.savePosition(current);
      }
    }
    const amount = manual?.amount
      ? BigInt(manual.amount)
      : (BigInt(p.quantity) * BigInt(bps)) / 10000n;
    if (!amount)
      throw new Blocked(
        "Requested partial exit is smaller than one atomic token",
      );
    this.store.event("EXIT_SIGNAL", p.mint, reason);
    const intent = {
      ...this.executor.sellIntent(
        p,
        amount,
        reason,
        this.settings,
        takeProfitIndex,
      ),
      manualRequestId: manual?.id,
      exitOpportunityId: opportunity?.id,
      jevExitDecisionId:
        p.strategy === "KRONOS" ? undefined : opportunity?.decisionId,
      decisionSource: manual
        ? ("MANUAL" as const)
        : opportunity?.kind === "PROTECTIVE"
          ? opportunity.protection?.kind === "SECURITY_CRITICAL"
            ? ("SECURITY" as const)
            : ("PROTECTIVE" as const)
          : p.strategy === "KRONOS"
            ? ("KRONOS" as const)
            : ("JEV" as const),
      decisionId: manual?.id ?? opportunity?.decisionId,
      decisionAt: opportunity?.triggeredAt ?? manual?.createdAt,
      exitAuthority:
        p.finalExitAction?.authority ??
        (manual
          ? "MANUAL"
          : opportunity?.kind === "PROTECTIVE"
            ? opportunity.protection?.kind === "SECURITY_CRITICAL"
              ? "SECURITY"
              : "PROTECTIVE"
            : p.strategy === "KRONOS"
              ? "KRONOS"
              : "JEV"),
    };
    const checkExitAuthority = () => {
      const current = this.store.positions(p.mode).find((x) => x.id === p.id);
      if (
        !current ||
        current.dismissal ||
        current.quantity !== p.quantity ||
        !["OPEN", "PENDING_EXIT"].includes(current.state)
      )
        throw new CandidateRejected("TEMPORARY_RISK_CHANGE", {
          mint: p.mint,
          reason: "EXIT_POSITION_CHANGED",
        });
      if (
        opportunity?.kind === "PROTECTIVE" &&
        !validProtection(
          current.pendingExits?.find((x) => x.id === opportunity!.id)
            ?.protection,
          current,
        )
      )
        throw new CandidateRejected("TEMPORARY_RISK_CHANGE", {
          reason: "PROTECTIVE_EVIDENCE_EXPIRED_OR_REVOKED",
        });
      if (current.strategy === "KRONOS" && opportunity?.kind === "STRATEGIC") {
        assertStrategySell(intent, current);
        const market = this.store.latest<Market>("position_market", p.mint);
        if (
          !market ||
          market.price.state !== "KNOWN" ||
          market.at > Date.now() ||
          Date.now() - market.at > this.settings.maxSnapshotAgeMs ||
          (current.kronosDecision?.inputPriceUsd &&
            Math.abs(
              market.price.value / current.kronosDecision.inputPriceUsd - 1,
            ) *
              100 >
              this.settings.maxDecisionPriceMovePercent)
        )
          throw new CandidateRejected("TEMPORARY_RISK_CHANGE", {
            reason: "KRONOS_EXIT_MARKET_STALE_OR_CHANGED",
          });
      }
      if (
        current.strategy !== "KRONOS" &&
        opportunity?.kind === "STRATEGIC" &&
        (!current.jevExit ||
          this.exitEvidenceChanged(current.jevExit) ||
          (current.jevExit.flowSignalKey !== undefined &&
            current.flow?.signalKey !== current.jevExit.flowSignalKey) ||
          current.jevExit.id !== opportunity.decisionId ||
          (current.decisionRevision ?? 0) !==
            (current.jevExit.positionRevision ?? 0) ||
          current.jevExit.quantity !== current.quantity ||
          Date.now() - (current.jevExit.inputAt ?? current.jevExit.createdAt) >
            this.settings.jevExitDecisionMaxAgeMs ||
          !current.lastQuoteAt ||
          Date.now() - current.lastQuoteAt >
            this.settings.jevExitDecisionMaxAgeMs ||
          Math.abs(
            Number(current.lastValueLamports) /
              Math.max(1, Number(current.jevExit.inputValueLamports)) -
              1,
          ) *
            100 >
            this.settings.maxDecisionPriceMovePercent ||
          this.manual.some((r) => r.positionId === p.id))
      )
        throw new CandidateRejected("TEMPORARY_RISK_CHANGE", {
          mint: p.mint,
          reason: "JEV_EXIT_SUPERSEDED_OR_STALE",
        });
      if (
        opportunity?.kind === "STRATEGIC" &&
        current.pendingExits?.some((x) => x.kind === "PROTECTIVE")
      )
        throw new CandidateRejected("TEMPORARY_RISK_CHANGE", {
          mint: p.mint,
          reason: "SECURITY_OVERRIDE_PENDING",
        });
    };
    const result = await this.executor.execute(
      intent,
      this.settings,
      p.mode === "paper" ? this.solPrice! : "0",
      async () => {
        if (opportunity?.kind === "PROTECTIVE")
          await this.revalidateProtection(p.id, opportunity.id);
        checkExitAuthority();
      },
      checkExitAuthority,
      undefined,
      this.solUsdEvidence(),
    );
    if (result.state === "CONFIRMED") {
      this.store.event("SELL_CONFIRMED", p.mint, reason + "; reconciled");
    }
    if (result.state === "FAILED")
      throw new CandidateRejected("TOKEN_EXECUTION_FAILED", {
        mint: p.mint,
        reason: "ON_CHAIN_SELL_FAILED",
      });
  }
  analytics(strategy?: "STANDARD" | "KRONOS") {
    const positions = this.store
        .positions(env.TRADING_MODE)
        .filter((p) => !strategy || (p.strategy ?? "STANDARD") === strategy),
      closed = positions.filter((p) => p.state === "CLOSED");
    const executions = this.store.executions();
    const settled = positions.filter((p) => BigInt(p.originalQuantity) > 0n);
    const accounting = settled.map((p) => ({
      p,
      a: tradeAccounting(p, executions),
    }));
    const sumKnown = (values: Array<string | null>) =>
      values.some((v) => v === null)
        ? null
        : values.reduce((n, v) => n + BigInt(v!), 0n).toString();
    const closedAccounting = accounting.filter((x) => x.p.state === "CLOSED");
    const decisions = this.store
      .recent("decisions", 100000)
      .map((r) => r.payload as RiskResult & { mode: string })
      .filter((r) => r.mode === env.TRADING_MODE);
    const jev = this.store
      .recent("jev_decisions", 100000)
      .map((r) => r.payload as { mode: string; action: string })
      .filter((r) => r.mode === env.TRADING_MODE);
    return {
      discovered: Number(
        this.store.db.prepare("SELECT count(*) n FROM tokens").get()?.n ?? 0,
      ),
      analyzed: Number(
        this.store.db
          .prepare(
            "SELECT count(DISTINCT mint) n FROM records WHERE kind='security_results'",
          )
          .get()?.n ?? 0,
      ),
      rugRejected: decisions.filter((d) => d.outcome === "SKIP_RUG").length,
      jevCalls: jev.length,
      jevBuy: jev.filter((j) => j.action === "BUY").length,
      jevSkip: jev.filter((j) => j.action === "SKIP").length,
      riskAllow: decisions.filter((d) => d.allowed).length,
      riskReject: decisions.filter((d) => !d.allowed).length,
      bought: positions.filter(
        (p) => !["FAILED", "PENDING_ENTRY"].includes(p.state),
      ).length,
      open: positions.filter(
        (p) => !p.dismissal && ["OPEN", "PENDING_EXIT"].includes(p.state),
      ).length,
      closed: closed.length,
      strategy: strategy ?? "ALL",
      strategyAccounting: {
        closed: closedAccounting.length,
        wins: closedAccounting.filter(
          (x) =>
            x.a.grossPnlLamports !== null && BigInt(x.a.grossPnlLamports) > 0n,
        ).length,
        losses: closedAccounting.filter(
          (x) =>
            x.a.grossPnlLamports !== null && BigInt(x.a.grossPnlLamports) < 0n,
        ).length,
        grossPnlLamports: sumKnown(
          closedAccounting.map((x) => x.a.grossPnlLamports),
        ),
        feesPaidLamports: sumKnown(
          closedAccounting.map((x) => x.a.feesPaidLamports),
        ),
        identifiedFeesLamports: closedAccounting
          .flatMap((x) => x.a.feeRecords)
          .reduce((total, fee) => total + BigInt(fee.feeLamports ?? "0"), 0n)
          .toString(),
        feesComplete: closedAccounting.every(
          (x) => x.a.feesPaidLamports !== null,
        ),
        netPnlLamports: sumKnown(
          closedAccounting.map((x) => x.a.netPnlLamports),
        ),
      },
      realizedLamports: sumKnown(
        accounting.map((x) => x.a.grossRealizedPnlLamports),
      ),
      unrealizedLamports: sumKnown(
        accounting
          .filter(
            (x) =>
              !x.p.dismissal && ["OPEN", "PENDING_EXIT"].includes(x.p.state),
          )
          .map((x) => x.a.grossUnrealizedPnlLamports),
      ),
      pnlBasis: "GROSS_EXCLUDES_FEES",
      winRate:
        closedAccounting.length &&
        closedAccounting.every((x) => x.a.grossPnlLamports !== null)
          ? closedAccounting.filter((x) => BigInt(x.a.grossPnlLamports!) > 0n)
              .length / closedAccounting.length
          : null,
    };
  }
  flowStatus(lifecycle = this.candidates.list()) {
    const executions = this.store.executions();
    const positions = positionViews(
      this.store.positions(env.TRADING_MODE),
      executions,
    );
    return {
      ...flowView(
        this.store,
        lifecycle,
        this.settings,
        this.flowStartId,
        this.stages,
        this.running && env.SCANNER_ENABLED,
        executions,
      ),
      runtime: {
        haltReason: this.store.get("haltReason") ?? null,
        haltScope: this.store.get("haltScope") ?? null,
        newEntriesEnabled: this.store.entriesEnabled(),
        controlled: this.executor.controlled?.read() ?? null,
        positionSummary: {
          count: positions.filter((p) => p.relevant).length,
          attention: positions.filter((p) => p.requiresAttention).length,
        },
      },
    };
  }
  overviewStatus() {
    this.attempts.reconcile();
    const a = this.attempts.current;
    const held = this.store
      .positions(env.TRADING_MODE)
      .filter((p) => !p.dismissal && !["CLOSED", "FAILED"].includes(p.state));
    const positions = positionViews(
      held,
      this.store.executions(),
      (mint) => this.store.token(mint),
    ).filter((p) => p.relevant);
    const preview = positions.slice(0, 10);
    const mints = new Set(preview.map((p) => p.mint));
    return {
      attempt: a ?? null,
      queue: this.candidates
        .list()
        .filter((r) => r.state === "QUEUED")
        .slice(0, 8),
      positions: preview,
      positionTotal: positions.length,
      market: this.store
        .recent("position_market", 100)
        .filter((row) => "mint" in row && mints.has(String(row.mint))),
      scanner: { running: this.running, scanning: this.scanning },
      token: a ? this.store.token(a.mint) : null,
    };
  }
  /** Small dashboard shell projection. No statistics, Memory report, flow or history scans. */
  async dashboardStatus() {
    let balance: bigint | undefined;
    try {
      balance = await this.balance();
    } catch {
      /* Missing balance remains unknown. */
    }
    return {
      mode: env.TRADING_MODE,
      liveAck: env.LIVE_TRADING_ACK,
      runtime: runtimeInfo,
      capabilities: {
        dashboardRoutes: true,
        positionBadgeCount: true,
        configurablePositionSize: true,
        fixedSolPositionSize: true,
        firstBuyWins: true,
        kronosIntegration: true,
        candidateOneShot: true,
        capitalFlowAdaptive: true,
        prebuyExitFeasibility: true,
      },
      balanceLamports: balance?.toString() ?? null,
      solPriceUsd: this.solPrice ?? null,
      solPriceUpdatedAt: this.solPriceAt ?? null,
      newEntriesEnabled: this.store.entriesEnabled(),
      haltReason: this.store.get("haltReason") ?? null,
      haltScope: this.store.get("haltScope") ?? null,
      scanner: {
        running: this.running,
        scanning: this.scanning,
        lastTick: this.lastTick,
        lastError: this.lastError,
      },
    };
  }
  async status() {
    let balance: bigint | undefined;
    try {
      balance = await this.balance();
    } catch {
      /* Wallet configuration is exposed as a clear status, never a made-up balance. */
    }
    const pending = this.store.reserved(env.TRADING_MODE),
      sized =
        balance === undefined
          ? undefined
          : size(
              balance,
              BigInt(this.settings.feeReserveLamports),
              pending,
              this.settings,
            );
    const lifecycle = this.candidates.list();
    const flow = this.flowStatus(lifecycle);
    return {
      overview: this.overviewStatus(),
      mode: env.TRADING_MODE,
      liveAck: env.LIVE_TRADING_ACK,
      runtime: runtimeInfo,
      capabilities: {
        configurablePositionSize: true,
        fixedSolPositionSize: true,
        firstBuyWins: true,
        kronosIntegration: true,
        candidateOneShot: true,
        trendingDiscovery: true,
        sniperBuyerDefense: true,
        gmgnRequestCoordinator: true,
        prebuyExitFeasibility: true,
        capitalFlowAdaptive: true,
        monotonicReconciliation: true,
        independentMonitoring: true,
      },
      wallet: env.WALLET_PUBLIC_KEY || null,
      balanceLamports: balance?.toString() ?? null,
      solPriceUsd: this.solPrice ?? null,
      solPriceUpdatedAt: this.solPriceAt ?? null,
      balanceKind:
        env.TRADING_MODE === "paper"
          ? (this.store.get("paperBalanceSource") ?? "SIMULATED")
          : "ON_CHAIN",
      availableLamports: sized?.available.toString() ?? null,
      nextBuyLamports: sized?.amount.toString() ?? null,
      reservedLamports: pending.toString(),
      newEntriesEnabled: this.store.entriesEnabled(),
      haltReason: this.store.get("haltReason") ?? null,
      haltScope: this.store.get("haltScope") ?? null,
      positionSummary: flow.runtime.positionSummary,
      capitalFlow: {
        ...this.capitalFlow.status(),
        regimes: Object.fromEntries(
          [
            ...new Set(
              this.store
                .positions(env.TRADING_MODE)
                .filter((p) => p.state === "OPEN")
                .map((p) => p.flow?.regime ?? "INSUFFICIENT_DATA"),
            ),
          ].map((regime) => [
            regime,
            this.store
              .positions(env.TRADING_MODE)
              .filter(
                (p) =>
                  p.state === "OPEN" &&
                  (p.flow?.regime ?? "INSUFFICIENT_DATA") === regime,
              ).length,
          ]),
        ),
      },
      adaptiveExitMetrics: this.exitMetrics,
      discovery: this.discovery.status(),
      discoveryMetrics: {
        prebuyProbesLastMinute: Number(
          this.store.db
            .prepare(
              "SELECT coalesce(sum(json_array_length(json_extract(payload,'$.levels'))),0) n FROM records WHERE kind='exit_feasibility' AND at>?",
            )
            .get(Date.now() - 60000)!.n,
        ),
        ...Object.fromEntries(
          Object.entries(
            this.store.get<Record<string, number>>("faultMetrics") ?? {},
          ).filter(([k]) =>
            /^(TRENDING|SNIPER|prebuyExit|multiSource|sniperAged|queueReplacement)/.test(
              k,
            ),
          ),
        ),
        analysisLastMinute: this.analysisStarts.filter(
          (r) => Date.now() - r.at < 60000,
        ).length,
        waitBySource: Object.fromEntries(
          ["TRENDING", "SNIPER"].map((source) => {
            const rows = this.analysisStarts.filter(
              (r) => r.source === source && Date.now() - r.at < 60000,
            );
            return [
              source,
              {
                analysesLastMinute: rows.length,
                averageWaitMs: rows.length
                  ? Math.round(
                      rows.reduce((sum, r) => sum + r.waitMs, 0) / rows.length,
                    )
                  : null,
              },
            ];
          }),
        ),
      },
      exitLiquidity: this.exitLiquidity.status(),
      positionSafetyHistory: this.positionHistory.status(),
      gmgnRequests: this.gmgn.coordinator.status(),
      structureMetrics: (() => {
        const rows = this.structure.list().filter(hasEntryWatchEligibility),
          passed = rows.filter((r) => r.confirmedAt !== undefined);
        return {
          active: rows.filter((r) => r.status === "ACTIVE").length,
          observationAgeMs: rows
            .filter((r) => r.status === "ACTIVE")
            .map((r) => ({
              mint: r.mint,
              ageMs:
                Date.now() - (r.lastObservedAt ?? r.structureWatchStartedAt),
            })),
          oldestObservationAgeMs: Math.max(
            0,
            ...rows
              .filter((r) => r.status === "ACTIVE")
              .map(
                (r) =>
                  Date.now() - (r.lastObservedAt ?? r.structureWatchStartedAt),
              ),
          ),
          refreshSuccess: this.watchRefresh.success,
          feedObservationsReused: this.watchRefresh.feedReused,
          refreshDeferred: this.watchRefresh.deferred,
          refreshDue: rows.filter(
            (r) =>
              r.status === "ACTIVE" &&
              Date.now() - (r.lastObservedAt ?? r.structureWatchStartedAt) >=
                this.settings.structureObservationMs,
          ).length,
          refreshStarved: rows.filter(
            (r) =>
              r.status === "ACTIVE" &&
              Date.now() - (r.lastObservedAt ?? r.structureWatchStartedAt) >
                this.settings.structureMaxGapMs,
          ).length,
          coverageRatio: rows.some((r) => r.status === "ACTIVE")
            ? rows.filter(
                (r) =>
                  r.status === "ACTIVE" &&
                  Date.now() -
                    (r.lastObservedAt ?? r.structureWatchStartedAt) <=
                    this.settings.structureMaxGapMs,
              ).length / rows.filter((r) => r.status === "ACTIVE").length
            : null,
          confirmed: passed.length,
          expired: rows.filter((r) => r.status === "EXPIRED").length,
          averageConfirmationMs: passed.length
            ? Math.round(
                passed.reduce(
                  (n, r) => n + r.confirmedAt! - r.structureWatchStartedAt,
                  0,
                ) / passed.length,
              )
            : null,
          jevCallsAvoided:
            (this.store.get<Record<string, number>>("faultMetrics") ?? {})
              .sniperJevCallsAvoided ?? 0,
        };
      })(),
      structureWatch: this.structure.list().map((r) => ({
        evidenceCurrent: currentStructureEvidence(r),
        eligibleForEntryWatch:
          hasEntryWatchEligibility(r) &&
          !this.store.bought(r.mint, env.TRADING_MODE),
        recoveryGateMode: canBypassRecovery(r, this.settings)
          ? "TEMP_RECOVERY_BYPASS"
          : r.status === "PASSED"
            ? "REAL_RECOVERY"
            : "LOCKED",
        ...r,
        symbol: this.store.token(r.mint)?.symbol,
        progress: {
          selling: !currentStructureEvidence(r)
            ? "PENDING"
            : r.sellingSeen
              ? "COMPLETE"
              : r.sellingCount > 0
                ? "FORMING"
                : "PENDING",
          absorption: !currentStructureEvidence(r)
            ? "PENDING"
            : r.absorptionDetected
              ? "COMPLETE"
              : r.absorptionCount > 0
                ? "FORMING"
                : "PENDING",
          support: !currentStructureEvidence(r)
            ? "PENDING"
            : r.supportConfirmed
              ? "COMPLETE"
              : (r.supportCount ?? 0) > 0
                ? "FORMING"
                : "PENDING",
          recovery: !currentStructureEvidence(r)
            ? "PENDING"
            : r.status === "PASSED"
              ? "COMPLETE"
              : r.recoveryCount > 0
                ? "FORMING"
                : "PENDING",
        },
        dataFreshMs: 10000,
        entryDiscoverySource: hasEntryWatchEligibility(r)
          ? "TRENDING"
          : entrySource(
              this.store.token(r.mint) ?? {
                mint: r.mint,
                source: "SNIPER",
                discoveredAt: r.structureWatchStartedAt,
              },
              this.settings,
            ),
        observations: undefined,
        observationCoverage: r.observationsAccepted,
        quality:
          r.lastObservedAt && Date.now() - r.lastObservedAt <= 10000
            ? r.quality
            : "STALE",
      })),
      jevExit: {
        ...this.exitScheduler.status(),
        executionBusy: this.executionLoop || this.executor.isBusy,
        pendingExits: this.store
          .positions(env.TRADING_MODE)
          .reduce((n, p) => n + (p.pendingExits?.length ?? 0), 0),
        walletFrozen: this.store
          .pending()
          .some((e) => e.intent.mode === env.TRADING_MODE && e.signature),
      },
      candidatePipeline: {
        queue: lifecycle.filter((r) =>
          ["QUEUED", "ANALYZING", "QUALIFIED", "APPROVED"].includes(r.state),
        ),
        watch: lifecycle.filter((r) => r.state === "WATCH"),
        deferred: lifecycle.filter((r) => r.state === "DEFERRED"),
        rejected: lifecycle.filter((r) => r.state === "REJECTED").length,
        capacity: this.settings.candidateQueueSize,
      },
      flow,
      faultMetrics: Object.fromEntries(
        [
          "candidateFailures",
          "candidateDeferred",
          "candidateRecovered",
          "candidateRejectedAfterRetries",
          "positionFailures",
          "systemFailures",
          "globalEntryPauses",
        ].map((key) => [
          key,
          (this.store.get<Record<string, number>>("faultMetrics")?.[key] ?? 0) -
            (this.metricsBaseline[key] ?? 0),
        ]),
      ),
      scanner: {
        running: this.running,
        scanning: this.scanning,
        lastTick: this.lastTick,
        lastError: this.lastError,
      },
      providers: {
        gmgn: this.gmgn.health,
        jev: this.jev.http.health,
        solana: this.rpc.http.health,
        execution: this.executor.provider.health,
      },
      trades: this.store
        .executions()
        .slice(-20)
        .map((e) => ({
          strategy: e.intent.strategy ?? "STANDARD",
          decisionSource: e.intent.decisionSource,
          decisionId: e.intent.decisionId,
          decisionAt: e.intent.decisionAt,
          side: e.intent.side,
          mint: e.intent.mint,
          provider: e.intent.provider,
          state: e.state,
          signature: e.signature,
          error: e.error,
          errorDetails: e.errorDetails,
        })),
      analytics: this.analytics(),
      strategyAnalytics: {
        STANDARD: this.analytics("STANDARD").strategyAccounting,
        KRONOS: this.analytics("KRONOS").strategyAccounting,
      },
      kronos: this.kronos.status(),
      learning: this.memory.report(env.TRADING_MODE),
      controlled: this.executor.controlled?.read() ?? null,
      settings: this.settings,
      events: this.store.recent("events", 30),
    };
  }
}
