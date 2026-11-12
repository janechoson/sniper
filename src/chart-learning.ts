import { randomUUID } from "node:crypto";
import type { Candidate, Market, Mode, Position } from "./domain.js";
import {
  CHART_POLICY,
  applies,
  chartFeatures,
  type LearningRule,
} from "./chart-features.js";
import { ChartStore, chartId, type ChartDecision } from "./chart-store.js";
import {
  CodexRuntime,
  type ReasoningRuntime,
  type RuntimeUsage,
} from "./codex-runtime.js";
import { ChartAnalyzer } from "./chart-analyzer.js";
import { ChartValidationEngine } from "./chart-validation-engine.js";
import type { Store } from "./store.js";
import type { Gmgn } from "./gmgn.js";
import { parseMarketHistory, type MarketHistory } from "./market-history.js";
import { createTradeReplay } from "./chart-replay.js";
import { sqliteAtomic } from "./learning-database.js";
import { tradeAccounting } from "./trade-accounting.js";

export class ChartLearning {
  readonly runtime: ReasoningRuntime;
  readonly charts: ChartStore;
  readonly analyzer: ChartAnalyzer;
  readonly validation: ChartValidationEngine;
  private active?: Promise<void>;
  private positionJobs = new Map<string, Promise<void>>();
  private positionDue = new Map<string, number>();
  private stopped = false;
  private next = 0;
  private maintenanceAt = 0;
  private positionRecoveryCursor = 0;
  private lastError: string | null = null;
  private readonly sources: readonly Store[];
  private timer?: NodeJS.Timeout;
  private ruleRevision = -1;
  private compiledRules: LearningRule[] = [];
  constructor(
    private store: Store,
    private gmgn: Gmgn,
    runtime?: ReasoningRuntime,
    sources?: readonly Store[],
  ) {
    this.sources = sources ?? [store];
    this.runtime =
      runtime ??
      new CodexRuntime(undefined, undefined, undefined, {
        read: () => {
          const r = store.learningDb
            .prepare(
              "SELECT payload FROM settings WHERE key='chartRuntimeUsage'",
            )
            .get();
          return r
            ? (JSON.parse(String(r.payload)) as RuntimeUsage)
            : undefined;
        },
        write: (value) => {
          store.learningDb
            .prepare(
              "INSERT INTO settings VALUES('chartRuntimeUsage',?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload",
            )
            .run(JSON.stringify(value));
        },
      });
    this.charts = new ChartStore(store);
    // Preserve legacy automatic analysis records for audit, but never execute them.
    this.charts.db
      .prepare("UPDATE chart_jobs SET state='CANCELLED',error='LEGACY_AUTOMATIC_ANALYSIS_DISABLED' WHERE state IN ('PENDING','RUNNING')")
      .run();
    this.analyzer = new ChartAnalyzer(this.charts, this.runtime);
    this.validation = new ChartValidationEngine(store.learningDb, this.runtime);
  }
  startIndependent() {
    if (!this.timer)
      this.timer = setInterval(() => { this.pump("demo", false); this.analyzer.pump(); this.validation.pump(); }, 5000);
  }
  private validatedRules(at: number) {
    const revision = Number(
      this.charts.db
        .prepare("SELECT coalesce(max(rowid),0) n FROM chart_rule_versions")
        .get()!.n,
    );
    if (revision !== this.ruleRevision) {
      this.compiledRules = this.charts
        .rules(at)
        .filter((r) => r.status === "VALIDATED");
      this.ruleRevision = revision;
    }
    return this.compiledRules.filter((r) => r.at <= at);
  }
  status() {
    return {
      collector: {
        state: this.stopped ? "PAUSED" : this.lastError ? "ERROR" : this.timer || this.active ? "RUNNING" : "READY",
        active: !!this.active,
        positionJobs: this.positionJobs.size,
        lastError: this.lastError,
      },
      analyzer: { ...this.analyzer.status(), runtime: this.runtime.status() },
      validation: this.validation.status(),
      observerEnabled: !!this.timer && !this.stopped,
      observationActive: !!this.active,
      positionJobs: this.positionJobs.size,
      lastError: this.lastError,
    };
  }
  private sourceFor(mode: Mode) {
    return this.sources.find((source) => source.mode === mode) ?? this.store;
  }
  private confirmedBuy(p: Position) {
    return this.sourceFor(p.mode)
      .executions(p.mode)
      .find(
        (execution) =>
          execution.intent.positionId === p.id &&
          execution.intent.side === "BUY" &&
          execution.state === "CONFIRMED",
      );
  }
  private ensureCase(p: Position, now = Date.now()) {
    if (!["OPEN", "PENDING_EXIT", "CLOSED"].includes(p.state)) return null;
    const buy = this.confirmedBuy(p);
    if (!buy) return null;
    const accountId = this.charts.account(p.mode),
      entryAt = buy.accounting?.at ?? buy.at,
      existing = this.charts.db
        .prepare("SELECT * FROM chart_learning_cases WHERE position_id=?")
        .get(p.id);
    if (!existing) {
      const payload = {
        positionId: p.id,
        mint: p.mint,
        mode: p.mode,
        accountId,
        buyExecutionId: buy.id,
        buySignature: buy.signature ?? null,
        simulated: buy.evidence?.simulated === true || p.mode === "demo",
        entryAt,
      };
      sqliteAtomic(this.charts.db, () => {
        this.charts.db
          .prepare(
            "INSERT OR IGNORE INTO chart_learning_cases(position_id,mint,mode,account_id,buy_confirmed_at,learning_started_at,entry_price_usd,entry_quantity,status,entry_snapshot_id,exit_snapshot_id,realized_pnl_lamports,realized_pnl_pct,created_at,updated_at,payload) VALUES(?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,NULL,?,?,?)",
          )
          .run(
            p.id,
            p.mint,
            p.mode,
            accountId,
            entryAt,
            now,
            buy.accounting?.priceUsd ?? p.entryPriceUsd ?? null,
            buy.accounting?.quantityAtomic ?? p.originalQuantity ?? p.quantity,
            "OPEN",
            now,
            now,
            JSON.stringify(payload),
          );
        this.charts.db
          .prepare(
            "INSERT OR IGNORE INTO chart_case_collection(case_id,status,data_quality,updated_at,payload) VALUES(?,'COLLECTING','UNKNOWN',?,?)",
          )
          .run(p.id, now, JSON.stringify({ simulated: buy.evidence?.simulated === true || p.mode === "demo" }));
        this.charts.linkCaseEvidence(
          p.id,
          buy.id,
          "EXECUTION",
          "EXECUTION",
          entryAt,
        );
      });
    }
    const current = this.charts.db
      .prepare("SELECT * FROM chart_learning_cases WHERE position_id=?")
      .get(p.id) as
      | {
          entry_snapshot_id: string | null;
          status: string;
        }
      | undefined;
    if (!current) return null;
    this.charts.db
      .prepare(
        "INSERT OR IGNORE INTO chart_case_collection(case_id,status,data_quality,updated_at,payload) VALUES(?,?,'UNKNOWN',?,?)",
      )
      .run(p.id, p.state === "CLOSED" ? "POSITION_CLOSED" : "COLLECTING", now, JSON.stringify({ legacyCase: true }));
    if (p.state === "CLOSED" && current.status !== "CLOSED") {
      const accounting = tradeAccounting(
        p,
        this.sourceFor(p.mode).executions(p.mode),
      );
      const exit = this.sourceFor(p.mode)
        .executions(p.mode)
        .filter(
          (execution) =>
            execution.intent.positionId === p.id &&
            execution.intent.side === "SELL" &&
            execution.state === "CONFIRMED",
        )
        .at(-1);
      sqliteAtomic(this.charts.db, () => {
        this.charts.db
          .prepare(
            "UPDATE chart_learning_cases SET status='CLOSED',exit_snapshot_id=?,realized_pnl_lamports=?,realized_pnl_pct=?,updated_at=?,payload=json_set(payload,'$.closedAt',?,'$.exitExecutionId',?,'$.sellConfirmedAt',?,'$.accounting',?,'$.exitPriceUsd',?,'$.simulated',?) WHERE position_id=?",
          )
          .run(
            exit?.id ?? null,
            accounting.netPnlLamports,
            accounting.netPnlPct,
            now,
            p.closedAt ?? now,
            exit?.id ?? null,
            exit ? (exit.accounting?.at ?? exit.at) : null,
            JSON.stringify(accounting),
            JSON.stringify(exit?.accounting?.priceUsd ?? null),
            JSON.stringify(p.mode === "demo" || exit?.evidence?.simulated === true),
            p.id,
          );
        if (exit)
          this.charts.linkCaseEvidence(
            p.id,
            exit.id,
            "EXECUTION",
            "EXECUTION",
            exit.accounting?.at ?? exit.at,
          );
      });
    }
    if (p.state === "CLOSED") this.schedulePostSell(p, now);
    return {
      positionId: p.id,
      entryAt,
      snapshotId: current.entry_snapshot_id,
      buy,
    };
  }
  private schedulePostSell(p: Position, now: number) {
    const closedAt = p.closedAt ?? now;
    sqliteAtomic(this.charts.db, () => {
      this.charts.db
        .prepare("UPDATE chart_case_collection SET status='POST_SELL_COLLECTING',updated_at=? WHERE case_id=? AND status IN ('COLLECTING','POSITION_CLOSED','POST_SELL_COLLECTING')")
        .run(now, p.id);
      for (const horizon of [5, 15, 30, 60])
        this.charts.db
          .prepare("INSERT OR IGNORE INTO chart_case_followups(case_id,horizon,due_at,next_attempt_at,state) VALUES(?,?,?,?, 'PENDING')")
          .run(p.id, horizon, closedAt + horizon * 60000, closedAt + horizon * 60000);
    });
  }
  registerBoughtPosition(
    p: Position,
    h?: MarketHistory,
    market?: Market,
    entryEvidence?: { guardDecision?: unknown; kronosDecision?: unknown; riskSnapshot?: unknown },
    now = Date.now(),
  ) {
    const learningCase = this.ensureCase(p, now);
    if (!learningCase) return false;
    if (entryEvidence)
      this.charts.db
        .prepare("UPDATE chart_learning_cases SET payload=json_set(payload,'$.entryEvidence',json(?)),updated_at=? WHERE position_id=?")
        .run(JSON.stringify(entryEvidence), now, p.id);
    if (entryEvidence?.guardDecision)
      this.recordCaseDecision(p.id, "GUARD_ENTRY", entryEvidence.guardDecision, p.mode === "demo");
    if (entryEvidence?.kronosDecision)
      this.recordCaseDecision(p.id, "KRONOS_ENTRY", entryEvidence.kronosDecision, p.mode === "demo");
    if (h && !learningCase.snapshotId) {
      const snapshotId = this.charts.ingest(
        p.mint,
        h,
        {
          positionId: p.id,
          entryAt: learningCase.entryAt,
          buyConfirmedAt: learningCase.entryAt,
          learningStartedAt: now,
          executionId: learningCase.buy.id,
          simulated:
            learningCase.buy.evidence?.simulated === true || p.mode === "demo",
          phase: "POST_BUY_LEARNING",
          market: market ?? null,
        },
        now,
      );
      this.charts.db
        .prepare(
          "UPDATE chart_learning_cases SET entry_snapshot_id=coalesce(entry_snapshot_id,?),updated_at=? WHERE position_id=?",
        )
        .run(snapshotId, now, p.id);
      this.charts.db
        .prepare(
          "UPDATE chart_case_collection SET last_collected_at=?,last_candle_at=max(coalesce(last_candle_at,0),?),data_quality=?,updated_at=? WHERE case_id=?",
        )
        .run(now, h.candles.at(-1)?.at ?? 0, h.candles.length ? "AVAILABLE" : "INCOMPLETE", now, p.id);
    }
    this.charts.watch(
      p.mint,
      p.mode,
      0,
      "POST_BUY_POSITION:" + p.id,
      now,
    );
    return true;
  }
  scheduleBoughtPosition(
    p: Position,
    h: MarketHistory,
    market: Market,
    entryEvidence?: { guardDecision?: unknown; kronosDecision?: unknown; riskSnapshot?: unknown },
  ) {
    setImmediate(() => {
      try {
        this.registerBoughtPosition(p, h, market, entryEvidence);
      } catch (error) {
        this.lastError =
          error instanceof Error ? error.message : "CHART_LEARNING_START_FAILED";
        try {
          this.sourceFor(p.mode).pipelineEvent(
            "CHART_LEARNING_START_FAILED",
            p.mint,
            { positionId: p.id, error: this.lastError },
          );
        } catch {
          // Learning must never affect the confirmed execution.
        }
      }
    });
  }
  async decide(
    candidate: Candidate,
    h: MarketHistory,
    market: Market,
    mode: Mode,
    p?: Position,
  ): Promise<ChartDecision> {
    const priorTimeout = Number(
      Object.values(this.charts.db.prepare("PRAGMA busy_timeout").get()!)[0],
    );
    this.charts.db.exec("PRAGMA busy_timeout=25");
    try {
      const at = Date.now();
      const eligibleCase = p ? this.ensureCase(p, at) : null;
      const snapshotId = eligibleCase
        ? this.charts.ingest(
            candidate.mint,
            h,
            { positionId: p!.id, entryAt: eligibleCase.entryAt, market },
            at,
          )
        : "READ_ONLY_GUARD";
      const features = chartFeatures(h.candles, at);
      const base: ChartDecision = {
        id: randomUUID(),
        mode,
        accountId: this.charts.account(mode),
        mint: candidate.mint,
        positionId: p?.id,
        at,
        action: p ? "HOLD" : "PASS",
        reason: "NO_APPLICABLE_VALIDATED_HISTORY",
        snapshotId,
        policy: CHART_POLICY,
        rules: [],
        observedBehaviors: features.behaviors,
        runtime: "NOT_INVOKED_COLD_START",
        quantity: p?.quantity,
        inputPriceUsd:
          market.price.state === "KNOWN" ? market.price.value : undefined,
        inputTo: h.historyTo ?? undefined,
        expiresAt: at + 15000,
      };
      if (
        h.status !== "AVAILABLE" ||
        h.freshness !== "FRESH" ||
        at - h.fetchedAt > 30000 ||
        h.fetchedAt > at ||
        !h.historyTo ||
        at - h.historyTo > 120000 ||
        market.at > at ||
        at - market.at > 30000 ||
        market.price.state !== "KNOWN" ||
        market.price.value <= 0
      ) {
        base.action = "ERROR";
        base.reason = "INVALID_OR_STALE_MARKET_DATA";
        base.runtime = "NOT_INVOKED_INVALID_DATA";
      } else {
        const rules = this.validatedRules(at).filter(
          (r) =>
            r.status === "VALIDATED" &&
            r.action === (p ? "SELL" : "BLOCK") &&
            applies(r, h.candles, at),
        );
        if (rules.length) {
          base.action = p ? "SELL" : "BLOCK";
          base.rules = rules;
          base.runtime = "COMPILED_VALIDATED_RULES";
          base.reason = rules
            .map(
              (r) =>
                `${r.id} v${r.version}: ${r.name}; conditions ${r.behaviors.join(", ")}; invalidate: ${r.invalidation}`,
            )
            .join(" | ");
        }
      }
      if (eligibleCase) {
        this.charts.linkCaseEvidence(
          p!.id,
          base.id,
          "DECISION",
          "POST_BUY_OBSERVATION",
          at,
        );
        this.charts.decision(base);
        this.recordCaseDecision(p!.id, "GUARD", base, p!.mode === "demo");
      }
      return base;
    } finally {
      this.charts.db.exec("PRAGMA busy_timeout=" + priorTimeout);
    }
  }
  recordCaseDecision(positionId: string, source: string, decision: unknown, simulated: boolean) {
    if (!this.charts.db.prepare("SELECT 1 FROM chart_learning_cases WHERE position_id=?").get(positionId)) return false;
    const value = decision as Record<string, unknown>;
    const decisionId = String(value.decisionId ?? value.id ?? randomUUID());
    const at = Number(value.decisionAt ?? value.at ?? Date.now());
    const action = String(value.action ?? "UNKNOWN");
    this.charts.db.prepare("INSERT OR IGNORE INTO chart_case_decisions VALUES(?,?,?,?,?,?,?)")
      .run(positionId, decisionId, source, at, action, simulated ? 1 : 0, JSON.stringify(decision));
    return true;
  }
  observePosition(
    p: Position,
    h: MarketHistory,
    market: Market,
    onDecision: (d: ChartDecision) => void,
  ) {
    if (
      this.stopped ||
      this.positionJobs.has(p.id) ||
      Date.now() < (this.positionDue.get(p.id) ?? 0)
    )
      return;
    this.positionDue.set(p.id, Date.now() + 60000);
    const c = this.store.token(p.mint) ?? {
      mint: p.mint,
      source: "POSITION",
      discoveredAt: p.entryAt,
    };
    const job = this.decide(c, h, market, p.mode, p)
      .then((d) => {
        if (!this.stopped) onDecision(d);
      })
      .catch(() => {
        this.lastError = "CHART_POSITION_COLLECTION_FAILED";
      })
      .finally(() => this.positionJobs.delete(p.id));
    this.positionJobs.set(p.id, job);
  }
  pump(mode: Mode, criticalBusy: boolean, now = Date.now()) {
    if (this.stopped || this.active || now < this.next) return;
    this.next = now + 15000;
    this.active = this.work(mode, criticalBusy, now)
      .catch((error) => {
        this.lastError =
          error instanceof Error ? error.message : "CHART_WORKER_FAILED";
      })
      .finally(() => {
        this.active = undefined;
      });
  }
  private async work(mode: Mode, criticalBusy: boolean, now: number) {
    const account = this.charts.account(mode);
    // Recovery is position scoped: only confirmed BUYs create cases after restart.
    for (const source of this.sources) {
      const positions = source.positions(source.mode);
      const start = positions.length ? this.positionRecoveryCursor % positions.length : 0;
      const batch = [...positions.slice(start, start + 100), ...positions.slice(0, Math.max(0, start + 100 - positions.length))];
      for (const p of batch) {
        const c = this.ensureCase(p, now);
        if (c && p.state !== "CLOSED")
          this.charts.watch(p.mint, p.mode, 0, "POST_BUY_POSITION:" + p.id, now);
      }
      this.positionRecoveryCursor = positions.length ? (start + 100) % positions.length : 0;
    }
    this.drainOutboxes(now);
    for (const source of this.sources)
      for (const p of source
        .positions(source.mode)
        .filter(
          (p) =>
            p.state === "CLOSED" &&
            this.ensureCase(p, now) !== null &&
            !this.charts.db
              .prepare(
                "SELECT position_id FROM chart_replays WHERE position_id=?",
              )
              .get(p.id),
        )
        .slice(0, 10)) {
        const replay = createTradeReplay(new ChartStore(source), p, now);
        this.charts.db
          .prepare("INSERT OR IGNORE INTO chart_replays VALUES(?,?,?,?,?)")
          .run(p.id, p.mode, replay.accountId, now, JSON.stringify(replay));
      }
    this.followups(mode, now);
    if (criticalBusy) return;
    if (await this.collectPostSellOne(now)) return;
    const row = this.charts.db
      .prepare(
        this.store.sharedLearning
          ? "SELECT * FROM chart_observation_queue WHERE due<=? AND until_at>? ORDER BY priority,due LIMIT 1"
          : "SELECT * FROM chart_observation_queue WHERE mode=? AND account_id=? AND due<=? AND until_at>? ORDER BY priority,due LIMIT 1",
      )
      .get(
        ...(this.store.sharedLearning ? [now, now] : [mode, account, now, now]),
      );
    if (row) {
      const mint = String(row.mint),
        c = this.store.token(mint) ?? {
          mint,
          source: "CHART_FOLLOWUP",
          discoveredAt: now,
        };
      const cases = this.charts.db
        .prepare(
          this.store.sharedLearning
            ? "SELECT position_id, buy_confirmed_at FROM chart_learning_cases WHERE mint=? AND status='OPEN' ORDER BY learning_started_at"
            : "SELECT position_id, buy_confirmed_at FROM chart_learning_cases WHERE mint=? AND mode=? AND account_id=? AND status='OPEN' ORDER BY learning_started_at",
        )
        .all(...(this.store.sharedLearning ? [mint] : [mint, mode, account])) as { position_id: string; buy_confirmed_at: number }[];
      if (!cases.length) {
        this.charts.db
          .prepare(
            this.store.sharedLearning
              ? "DELETE FROM chart_observation_queue WHERE mint=?"
              : "DELETE FROM chart_observation_queue WHERE mode=? AND account_id=? AND mint=?",
          )
          .run(...(this.store.sharedLearning ? [mint] : [mode, account, mint]));
      } else try {
        const raw = await this.gmgn.marketHistory(c, 60000, {
          priority: 6,
          consumer: "chart-learning-observer",
        });
        if (this.stopped) return;
        const h = parseMarketHistory(raw, c);
        if (h.freshness !== "FRESH" || h.status !== "AVAILABLE")
          throw Error("CHART_HISTORY_UNAVAILABLE");
        const collectedAt = Math.max(now, h.fetchedAt);
        for (const learningCase of cases) {
          const snapshotId = this.charts.ingest(
            mint,
            h,
            {
              positionId: learningCase.position_id,
              entryAt: learningCase.buy_confirmed_at,
              phase: "POST_BUY_OBSERVATION",
            },
            collectedAt,
          );
          this.charts.linkCaseEvidence(
            learningCase.position_id,
            snapshotId,
            "SNAPSHOT",
            "POST_BUY_OBSERVATION",
            collectedAt,
          );
          this.charts.db
            .prepare("UPDATE chart_case_collection SET last_collected_at=?,last_candle_at=max(coalesce(last_candle_at,0),?),data_quality='AVAILABLE',updated_at=? WHERE case_id=?")
            .run(collectedAt, h.candles.at(-1)?.at ?? 0, collectedAt, learningCase.position_id);
        }
        for (const e of this.charts.events(100).filter((e) => e.mint === mint && e.kind !== "CONTROL")) {
          for (const learningCase of cases)
            this.charts.linkCaseEvidence(learningCase.position_id, e.id, "EVENT", "POST_BUY_OBSERVATION", collectedAt);
        }
        this.charts.db
          .prepare(
            this.store.sharedLearning
              ? "UPDATE chart_observation_queue SET due=?,failures=0 WHERE mint=?"
              : "UPDATE chart_observation_queue SET due=?,failures=0 WHERE mode=? AND account_id=? AND mint=?",
          )
          .run(
            ...(this.store.sharedLearning
              ? [now + 60000, mint]
              : [now + 60000, mode, account, mint]),
          );
      } catch {
        this.lastError = "CHART_MARKET_PROVIDER_UNAVAILABLE";
        this.charts.db
          .prepare(
            this.store.sharedLearning
              ? "UPDATE chart_observation_queue SET failures=failures+1,due=? WHERE mint=?"
              : "UPDATE chart_observation_queue SET failures=failures+1,due=? WHERE mode=? AND account_id=? AND mint=?",
          )
          .run(
            ...(this.store.sharedLearning
              ? [now + 120000, mint]
              : [now + 120000, mode, account, mint]),
          );
      }
    }
    if (this.stopped) return;
    if (now - this.maintenanceAt > 3600000) {
      this.maintenanceAt = now;
      this.charts.db
        .prepare("DELETE FROM chart_observation_queue WHERE until_at<?")
        .run(now);
      for (const id of this.positionDue.keys())
        if (!this.store.managedPositions(mode).some((p) => p.id === id))
          this.positionDue.delete(id);
    }
  }
  private async collectPostSellOne(now: number) {
    const followup = this.charts.db.prepare(
      "SELECT f.*,c.mint,c.mode,c.account_id,c.buy_confirmed_at,c.payload case_payload FROM chart_case_followups f JOIN chart_learning_cases c ON c.position_id=f.case_id WHERE f.state='PENDING' AND f.due_at<=? AND f.next_attempt_at<=? ORDER BY f.due_at LIMIT 1",
    ).get(now, now) as any;
    if (!followup) return false;
    const caseId = String(followup.case_id), horizon = Number(followup.horizon);
    const dueAt = Number(followup.due_at), casePayload = JSON.parse(String(followup.case_payload));
    if (now > dueAt + 30 * 60000) {
      this.finishPostSell(caseId, horizon, "EXPIRED", now, null, "FOLLOWUP_DATA_WINDOW_EXPIRED");
      return true;
    }
    const source = this.sourceFor(followup.mode as Mode);
    let observedCoverage: number | null = null;
    const candidate = source.token(String(followup.mint)) ?? {
      mint: String(followup.mint), source: "POST_SELL_FOLLOWUP", discoveredAt: Number(followup.buy_confirmed_at),
    };
    try {
      const raw = await this.gmgn.marketHistory(candidate, 60000, {
        priority: 4, consumer: "chart-learning-post-sell-followup",
      });
      if (this.stopped) return true;
      const history = parseMarketHistory(raw, candidate);
      if (history.status !== "AVAILABLE" || history.freshness !== "FRESH")
        throw Error("CHART_HISTORY_UNAVAILABLE");
      const collectedAt = Math.max(now, history.fetchedAt);
      const closedAt = Number(casePayload.closedAt ?? dueAt - horizon * 60000);
      this.charts.ingest(String(followup.mint), history, {
        positionId: caseId, entryAt: Number(followup.buy_confirmed_at),
        phase: "POST_SELL_FOLLOWUP", postSellAt: closedAt, horizon,
      }, collectedAt);
      const candles = history.candles.filter((c) => c.at >= closedAt && c.at <= collectedAt && c.at < closedAt + (horizon + 1) * 60000);
      const coverage = Math.min(1, candles.length / horizon);
      observedCoverage = coverage;
      if (coverage < 0.8) throw Error("POST_SELL_FOLLOWUP_INSUFFICIENT_COVERAGE");
      const exitPrice = Number(casePayload.exitPriceUsd ?? casePayload.accounting?.averageExitPriceUsd ?? 0);
      const close = candles.at(-1)!;
      const outcome = {
        horizon, scheduledAt: dueAt, collectedAt, coverage,
        candleCount: candles.length, firstCandleAt: candles[0]!.at, lastCandleAt: close.at,
        closeReturnPct: exitPrice > 0 ? (close.close / exitPrice - 1) * 100 : null,
        mfePct: exitPrice > 0 ? (Math.max(...candles.map((c) => c.high)) / exitPrice - 1) * 100 : null,
        maePct: exitPrice > 0 ? (Math.min(...candles.map((c) => c.low)) / exitPrice - 1) * 100 : null,
        source: "GMGN_KLINE_1M", simulated: casePayload.simulated === true,
      };
      this.finishPostSell(caseId, horizon, "COLLECTED", collectedAt, outcome, null);
      this.charts.linkCaseEvidence(caseId, `${caseId}:${horizon}m`, "OUTCOME", "OUTCOME", collectedAt);
    } catch (error) {
      const message = error instanceof Error ? error.message : "POST_SELL_FOLLOWUP_FAILED";
      if (now >= dueAt + 30 * 60000)
        this.finishPostSell(caseId, horizon, "EXPIRED", now, { coverage: observedCoverage, source: "GMGN_KLINE_1M" }, message);
      else
        this.charts.db.prepare("UPDATE chart_case_followups SET attempts=attempts+1,next_attempt_at=?,payload=?,error=? WHERE case_id=? AND horizon=?")
          .run(now + 120000, JSON.stringify({ coverage: observedCoverage, source: "GMGN_KLINE_1M" }), message, caseId, horizon);
      this.charts.db.prepare("UPDATE chart_case_collection SET data_quality='INCOMPLETE',updated_at=? WHERE case_id=?")
        .run(now, caseId);
    }
    return true;
  }

  private finishPostSell(caseId: string, horizon: number, state: string, now: number, payload: unknown, error: string | null) {
    sqliteAtomic(this.charts.db, () => {
      this.charts.db.prepare("UPDATE chart_case_followups SET state=?,attempts=attempts+1,collected_at=?,payload=?,error=? WHERE case_id=? AND horizon=?")
        .run(state, now, payload === null ? null : JSON.stringify(payload), error, caseId, horizon);
      const remaining = Number(this.charts.db.prepare("SELECT count(*) n FROM chart_case_followups WHERE case_id=? AND state='PENDING'").get(caseId)!.n);
      if (!remaining) {
        const incomplete = Number(this.charts.db.prepare("SELECT count(*) n FROM chart_case_followups WHERE case_id=? AND state<>'COLLECTED'").get(caseId)!.n) > 0;
        this.charts.db.prepare("UPDATE chart_case_collection SET status=?,data_quality=?,updated_at=?,payload=json_set(payload,'$.followupsComplete',true) WHERE case_id=?")
          .run(incomplete ? "INCOMPLETE" : "READY_FOR_ANALYSIS", incomplete ? "INCOMPLETE" : "COMPLETE", now, caseId);
      }
    });
  }
  private followups(mode: Mode, now: number) {
    for (const event of this.charts
      .events(200)
      .filter((e) => e.kind !== "CONTROL" && now - e.at < 90 * 60000 && this.charts.db.prepare("SELECT 1 FROM chart_case_evidence ce JOIN chart_learning_cases lc ON lc.position_id=ce.case_id WHERE ce.evidence_type='EVENT' AND ce.evidence_id=? LIMIT 1").get(e.id))) {
      for (const horizon of [5, 15, 30, 60]) {
        if (
          now < event.at + (horizon + 1) * 60000 ||
          this.charts.db
            .prepare(
              "SELECT at FROM chart_event_outcomes WHERE event_id=? AND horizon=?",
            )
            .get(event.id, horizon)
        )
          continue;
        const candles = this.charts.candles(
          event.mint,
          event.at + 60000,
          event.at + (horizon + 1) * 60000,
          now,
        );
        if (candles.length / horizon < 0.8) continue;
        const result = {
          horizon,
          availableAt: now,
          coverage: candles.length / horizon,
          closeReturnPct:
            (candles.at(-1)!.close / event.candle.close - 1) * 100,
          recoveryFromLowPct:
            (candles.at(-1)!.close / event.candle.low - 1) * 100,
          highestPrice: Math.max(...candles.map((c) => c.high)),
          lowestPrice: Math.min(...candles.map((c) => c.low)),
          sourceCandleIds: candles.map((c) =>
            chartId(event.mint, "GMGN_KLINE_1M", c.at),
          ),
        };
        this.charts.db
          .prepare("INSERT OR IGNORE INTO chart_event_outcomes VALUES(?,?,?,?)")
          .run(event.id, horizon, now, JSON.stringify(result));
      }
    }
    for (const d of this.charts
      .decisions(mode, 200)
      .filter((d) => ["BLOCK", "PASS", "SELL"].includes(d.action) && d.positionId && this.charts.db.prepare("SELECT 1 FROM chart_learning_cases WHERE position_id=?").get(d.positionId))) {
      for (const minutes of [5, 15, 30, 60]) {
        if (now < d.at + minutes * 60000 || !d.inputPriceUsd) continue;
        if (
          this.charts.db
            .prepare(
              "SELECT at FROM chart_followups WHERE decision_id=? AND horizon=?",
            )
            .get(d.id, minutes)
        )
          continue;
        const candles = this.charts.candles(
          d.mint,
          d.at,
          d.at + minutes * 60000,
          now,
        );
        const last = candles.at(-1);
        if (
          !last ||
          candles.length / minutes < 0.8 ||
          Math.abs(last.at + 60000 - (d.at + minutes * 60000)) > 60000
        )
          continue;
        const change = (last.close / d.inputPriceUsd - 1) * 100;
        const classification =
          d.action === "BLOCK"
            ? Math.min(...candles.map((c) => c.low)) / d.inputPriceUsd <= 0.7
              ? "AVOIDED_CRASH"
              : change >= 20
                ? "MISSED_UPSIDE"
                : "NEUTRAL"
            : "OBSERVED";
        this.charts.db
          .prepare("INSERT OR IGNORE INTO chart_followups VALUES(?,?,?,?)")
          .run(
            d.id,
            minutes,
            now,
            JSON.stringify({
              classification,
              changePct: change,
              candleCount: candles.length,
              coverage: candles.length / minutes,
              realizableProfit: null,
              missing: ["historicalExecutionQuotes"],
            }),
          );
      }
    }
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.stopped = true;
    await this.active;
    await Promise.all(this.positionJobs.values());
    await this.analyzer.stop();
    await this.validation.stop();
  }
  drainOutboxes(now = Date.now()) {
    if (!this.store.sharedLearning) return;
    for (const source of this.sources) {
      const rows = source.db
        .prepare(
          "SELECT * FROM learning_outbox WHERE delivered_at IS NULL ORDER BY at LIMIT 100",
        )
        .all();
      sqliteAtomic(this.charts.db, () => {
        for (const row of rows) {
          const id = String(row.id),
            payload = JSON.parse(String(row.payload));
          let eligible = false;
          if (row.kind === "TRADE_CLOSED") {
            eligible = this.ensureCase(payload as Position, now) !== null;
          } else if (row.kind === "EXECUTION") {
            const execution = payload as import("./domain.js").Execution;
            const position = source
              .positions(source.mode)
              .find((p) => p.id === execution.intent.positionId);
            eligible = Boolean(
              execution.state === "CONFIRMED" &&
                position &&
                (execution.intent.side === "BUY"
                  ? this.ensureCase(position, now)
                  : this.charts.db
                      .prepare("SELECT 1 FROM chart_learning_cases WHERE position_id=?")
                      .get(position.id)),
            );
          } else {
            const positionId = payload.payload?.positionId;
            eligible = Boolean(
              positionId &&
                this.charts.db
                  .prepare("SELECT 1 FROM chart_learning_cases WHERE position_id=?")
                  .get(String(positionId)),
            );
          }
          if (!eligible) continue;
          if (row.kind !== "TRADE_CLOSED")
            this.charts.db
              .prepare(
                "INSERT OR IGNORE INTO learning_records VALUES(?,?,?,?,?)",
              )
              .run(
                id,
                row.kind === "EXECUTION" ? "execution" : payload.kind,
                payload.mint ?? payload.intent?.mint ?? null,
                Number(row.at),
                JSON.stringify(
                  row.kind === "EXECUTION"
                    ? payload
                    : {
                        ...payload.payload,
                        executionProvenance: {
                          mode: payload.mode,
                          simulated: payload.simulated,
                        },
                      },
                ),
              );
          else {
            const replay = createTradeReplay(
              new ChartStore(source),
              payload,
              now,
            );
            this.charts.db
              .prepare("INSERT OR IGNORE INTO chart_replays VALUES(?,?,?,?,?)")
              .run(
                payload.id,
                payload.mode,
                replay.accountId,
                now,
                JSON.stringify(replay),
              );
          }
        }
      });
      // Separate-file commits: ACK only after the whole shared batch commits.
      source.atomic(() => {
        for (const row of rows) {
          const id = String(row.id);
          source.db
            .prepare(
              "UPDATE learning_outbox SET delivered_at=? WHERE id=? AND delivered_at IS NULL",
            )
            .run(now, id);
        }
      });
    }
  }
}
