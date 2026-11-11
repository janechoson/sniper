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
  reasoningSchema,
  type ReasoningRuntime,
  type RuntimeUsage,
  type ReasoningResult,
} from "./codex-runtime.js";
import type { Store } from "./store.js";
import type { Gmgn } from "./gmgn.js";
import { parseMarketHistory, type MarketHistory } from "./market-history.js";
import { createTradeReplay } from "./chart-replay.js";
import { validateLearningRule } from "./chart-validation.js";
import { sqliteAtomic } from "./learning-database.js";
import { tradeAccounting } from "./trade-accounting.js";

export class ChartLearning {
  readonly runtime: ReasoningRuntime;
  readonly charts: ChartStore;
  private active?: Promise<void>;
  private positionJobs = new Map<string, Promise<void>>();
  private positionDue = new Map<string, number>();
  private stopped = false;
  private next = 0;
  private maintenanceAt = 0;
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
    // One engine owns the database lock. Incomplete inference has no authority.
    store.learningDb
      .prepare(
        "UPDATE chart_jobs SET state='PENDING',error='RESTART_RECOVERY' WHERE state='RUNNING'",
      )
      .run();
  }
  startIndependent() {
    if (!this.timer)
      this.timer = setInterval(() => this.pump("demo", false), 5000);
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
      runtime: this.runtime.status(),
      observerEnabled: !!this.timer && !this.stopped,
      observationActive: !!this.active,
      positionJobs: this.positionJobs.size,
      lastError: this.lastError,
    };
  }
  private checkReferences(result: ReasoningResult, rules: LearningRule[]) {
    if (result.ruleIds.some((id) => !rules.some((r) => r.id === id)))
      throw Error("CODEX_FABRICATED_RULE");
    const support = new Set(rules.flatMap((r) => r.supportingEventIds));
    const contrary = new Set(rules.flatMap((r) => r.contradictoryEventIds));
    if (
      result.supportingEventIds.some((id) => !support.has(id)) ||
      result.contradictoryEventIds.some((id) => !contrary.has(id))
    )
      throw Error("CODEX_FABRICATED_EVIDENCE");
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
            "UPDATE chart_learning_cases SET status='CLOSED',exit_snapshot_id=?,realized_pnl_lamports=?,realized_pnl_pct=?,updated_at=?,payload=json_set(payload,'$.closedAt',?,'$.exitExecutionId',?,'$.accounting',?) WHERE position_id=?",
          )
          .run(
            exit?.id ?? null,
            accounting.netPnlLamports,
            accounting.netPnlPct,
            now,
            p.closedAt ?? now,
            exit?.id ?? null,
            JSON.stringify(accounting),
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
    return {
      positionId: p.id,
      entryAt,
      snapshotId: current.entry_snapshot_id,
      buy,
    };
  }
  private addCaseReview(p: Position, now: number) {
    const replay = createTradeReplay(new ChartStore(this.sourceFor(p.mode)), p, now);
    this.charts.job("CASE_REVIEW", p.id, replay, p.mode, now);
  }
  registerBoughtPosition(
    p: Position,
    h?: MarketHistory,
    market?: Market,
    now = Date.now(),
  ) {
    const learningCase = this.ensureCase(p, now);
    if (!learningCase) return false;
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
    }
    this.charts.watch(
      p.mint,
      p.mode,
      0,
      "POST_BUY_POSITION:" + p.id,
      now,
    );
    if (h) this.addCaseReview(p, now);
    return true;
  }
  scheduleBoughtPosition(
    p: Position,
    h: MarketHistory,
    market: Market,
  ) {
    setImmediate(() => {
      try {
        this.registerBoughtPosition(p, h, market);
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
      }
      return base;
    } finally {
      this.charts.db.exec("PRAGMA busy_timeout=" + priorTimeout);
    }
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
        this.lastError = "CODEX_POSITION_ANALYSIS_FAILED";
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
      for (const p of source.positions(source.mode).slice(0, 100)) {
        const c = this.ensureCase(p, now);
        if (c && p.state !== "CLOSED")
          this.charts.watch(p.mint, p.mode, 0, "POST_BUY_POSITION:" + p.id, now);
      }
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
        this.charts.job("TRADE_REVIEW", p.id, replay, p.mode, now);
      }
    this.followups(mode, now);
    if (criticalBusy) return;
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
          "SELECT position_id, buy_confirmed_at FROM chart_learning_cases WHERE mint=? AND mode=? AND account_id=? AND status='OPEN' ORDER BY learning_started_at",
        )
        .all(mint, mode, account) as { position_id: string; buy_confirmed_at: number }[];
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
        for (const learningCase of cases) {
          const snapshotId = this.charts.ingest(
            mint,
            h,
            {
              positionId: learningCase.position_id,
              entryAt: learningCase.buy_confirmed_at,
              phase: "POST_BUY_OBSERVATION",
            },
            now,
          );
          this.charts.linkCaseEvidence(
            learningCase.position_id,
            snapshotId,
            "SNAPSHOT",
            "POST_BUY_OBSERVATION",
            now,
          );
        }
        for (const e of this.charts.events(100).filter((e) => e.mint === mint && e.kind !== "CONTROL")) {
          for (const learningCase of cases)
            this.charts.linkCaseEvidence(learningCase.position_id, e.id, "EVENT", "POST_BUY_OBSERVATION", now);
          this.charts.job("EVENT_REVIEW", e.id, e, mode);
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
    await this.runJob(mode, now);
    if (now - this.maintenanceAt > 3600000) {
      this.maintenanceAt = now;
      this.charts.db
        .prepare("DELETE FROM chart_observation_queue WHERE until_at<?")
        .run(now);
      // Referenced candles/events remain available for historical decisions.
      this.charts.db
        .prepare(
          `DELETE FROM chart_snapshots WHERE at<? AND id NOT IN (SELECT snapshot_id FROM chart_decisions)`,
        )
        .run(now - 7 * 86400000);
      this.charts.db
        .prepare(
          `DELETE FROM chart_events WHERE at<? AND id NOT IN (SELECT event_id FROM chart_rule_evidence) AND id NOT IN (SELECT event_id FROM chart_event_outcomes)`,
        )
        .run(now - 90 * 86400000);
      this.charts.db
        .prepare(
          `DELETE FROM chart_candles WHERE at<? AND NOT EXISTS (SELECT 1 FROM chart_events e WHERE e.mint=chart_candles.mint AND chart_candles.at BETWEEN e.at-3600000 AND e.at+3600000)`,
        )
        .run(now - 30 * 86400000);
      for (const id of this.positionDue.keys())
        if (!this.store.managedPositions(mode).some((p) => p.id === id))
          this.positionDue.delete(id);
    }
  }
  private followups(mode: Mode, now: number) {
    for (const event of this.charts
      .events(200)
      .filter((e) => e.kind !== "CONTROL" && now - e.at < 90 * 60000)) {
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
        this.charts.job(
          "EVENT_FOLLOWUP",
          event.id + ":" + horizon,
          { event, outcome: result },
          mode,
          now,
        );
      }
    }
    for (const d of this.charts
      .decisions(mode, 200)
      .filter((d) => ["BLOCK", "PASS", "SELL"].includes(d.action))) {
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
  private async runJob(mode: Mode, now: number) {
    const availability = this.runtime.status();
    if (
      availability.state.startsWith("MISSING") ||
      availability.active ||
      Number(availability.nextAvailableAt ?? 0) > Date.now()
    )
      return;
    const job = this.charts.db
      .prepare(
        this.store.sharedLearning
          ? "SELECT * FROM chart_jobs WHERE state='PENDING' AND due<=? ORDER BY CASE kind WHEN 'TRADE_REVIEW' THEN 0 WHEN 'EVENT_FOLLOWUP' THEN 1 ELSE 2 END,at LIMIT 1"
          : "SELECT * FROM chart_jobs WHERE mode=? AND account_id=? AND state='PENDING' AND due<=? ORDER BY CASE kind WHEN 'TRADE_REVIEW' THEN 0 WHEN 'EVENT_FOLLOWUP' THEN 1 ELSE 2 END,at LIMIT 1",
      )
      .get(
        ...(this.store.sharedLearning
          ? [now]
          : [mode, this.charts.account(mode), now]),
      );
    if (!job) return;
    this.charts.db
      .prepare(
        "UPDATE chart_jobs SET state='RUNNING',attempts=attempts+1 WHERE id=?",
      )
      .run(String(job.id));
    try {
      const payload = JSON.parse(String(job.payload));
      const result = reasoningSchema.parse(
        await this.runtime.analyze({
          analysisDepth: job.kind === "DEEP_REVIEW" ? "DEEP" : "STANDARD",
          task: job.kind,
          payload,
          events: this.charts.events(8),
          rules: this.charts.rules(),
          policy: CHART_POLICY,
        }),
      );
      if (result.action !== "REVIEW")
        throw Error("CODEX_REVIEW_ACTION_REQUIRED");
      const available = this.charts
        .events(20000)
        .filter((e) => e.availableAt <= now);
      const ids = new Set(available.map((e) => e.id));
      if (
        [...result.supportingEventIds, ...result.contradictoryEventIds].some(
          (id) => !ids.has(id),
        )
      )
        throw Error("CODEX_FABRICATED_REVIEW_EVIDENCE");
      if (
        result.hypothesis &&
        result.supportingEventIds.length &&
        result.hypothesis.behaviors.length
      ) {
        const h = result.hypothesis;
        const rule: LearningRule = {
          id: "LR-" + chartId(h.behaviors, h.window, h.action).slice(0, 16),
          version: 1,
          at: Date.now(),
          createdAt: Date.now(),
          name: h.name,
          description: h.description,
          status: h.behaviors.every((b) =>
            [
              "SLOW_RISE",
              "RAPID_RISE",
              "DECLINE",
              "WEAKENING_VOLUME",
              "MOMENTUM_EXHAUSTION",
              "DRAWDOWN",
              "VOLATILITY_EXPANSION",
            ].includes(b),
          )
            ? "DRAFT"
            : "REJECTED",
          behaviors: h.behaviors,
          window: Number(h.window),
          action: h.action,
          invalidation: h.invalidation,
          supportingEventIds: result.supportingEventIds,
          contradictoryEventIds: result.contradictoryEventIds,
        };
        if (!this.charts.rules().some((r) => r.id === rule.id))
          this.charts.saveRule(rule);
        if (rule.contradictoryEventIds.length && job.kind !== "DEEP_REVIEW")
          this.charts.job(
            "DEEP_REVIEW",
            rule.id + ":" + rule.version,
            rule,
            mode,
            Date.now(),
          );
      }
      // Full model/prompt/usage metadata is saved with the immutable job result.
      this.charts.db
        .prepare(
          "UPDATE chart_jobs SET state='COMPLETED',result=?,error=NULL WHERE id=?",
        )
        .run(
          JSON.stringify({
            analysis: result,
            runtime: this.runtime.status(),
            at: Date.now(),
          }),
          String(job.id),
        );
      for (const rule of this.charts
        .rules()
        .filter((r) =>
          ["DRAFT", "OBSERVING", "VALIDATING", "VALIDATED"].includes(r.status),
        )) {
        const next = {
          ...rule,
          version: rule.version + 1,
          createdAt: rule.createdAt ?? rule.at,
        };
        if (rule.status === "DRAFT") {
          this.charts.saveRule({
            ...next,
            status: "OBSERVING",
            at: Date.now(),
          });
          continue;
        }
        const v = validateLearningRule(this.charts, next);
        if (rule.status === "OBSERVING" && v.validation.matched >= 20) {
          this.charts.saveRule({
            ...next,
            status: "VALIDATING",
            at: Date.now(),
          });
          continue;
        }
        if (rule.status === "VALIDATING" && v.passed)
          this.charts.saveRule({
            ...next,
            status: "VALIDATED",
            at: Date.now(),
            validationId: v.id,
          });
        else if (
          v.validation.matched >= 20 &&
          v.testing.matched >= 20 &&
          v.validation.precision < 0.35 &&
          v.testing.precision < 0.35
        )
          this.charts.saveRule({
            ...next,
            status: rule.status === "VALIDATED" ? "RETIRED" : "REJECTED",
            at: Date.now(),
          });
      }
    } catch (error) {
      this.charts.db
        .prepare("UPDATE chart_jobs SET state=?,due=?,error=? WHERE id=?")
        .run(
          Number(job.attempts) >= 2 ? "FAILED" : "PENDING",
          now + 60000 * 2 ** Number(job.attempts),
          error instanceof Error ? error.message : "CODEX_JOB_FAILED",
          String(job.id),
        );
    }
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.stopped = true;
    await this.active;
    await Promise.all(this.positionJobs.values());
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
            this.charts.job(
              "TRADE_REVIEW",
              payload.id,
              replay,
              payload.mode,
              now,
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
