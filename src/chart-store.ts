import { createHash, randomUUID } from "node:crypto";
import type { Store } from "./store.js";
import type { Candle, MarketHistory } from "./market-history.js";
import {
  CHART_POLICY,
  chartFeatures,
  preEventFeatures,
  rugDrop,
  validChartCandle,
  type LearningRule,
} from "./chart-features.js";
import type { Mode } from "./domain.js";
import { sqliteAtomic } from "./learning-database.js";

export const chartId = (...parts: unknown[]) =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex");
export interface ChartEvent {
  id: string;
  mint: string;
  kind: string;
  at: number;
  availableAt: number;
  candleId: string;
  candle: Candle;
  dropPercent: number;
  preEvent: ReturnType<typeof preEventFeatures>;
  quality: { source: string; missing: string[] };
}
export interface ChartDecision {
  id: string;
  mode: Mode;
  accountId: string;
  mint: string;
  positionId?: string;
  at: number;
  action: "PASS" | "BLOCK" | "HOLD" | "SELL" | "ERROR";
  reason: string;
  snapshotId: string;
  policy: string;
  rules: LearningRule[];
  observedBehaviors: string[];
  runtime: string;
  quantity?: string;
  inputPriceUsd?: number;
  inputTo?: number;
  expiresAt: number;
}
export class ChartStore {
  constructor(readonly store: Store) {}
  get db() {
    return this.store.learningDb;
  }
  account(mode: Mode) {
    return mode === "demo" ? this.store.demoAccountId() : mode;
  }
  ingest(
    mint: string,
    h: MarketHistory,
    context: unknown = null,
    now = Date.now(),
  ) {
    if (!Number.isSafeInteger(h.fetchedAt) || h.fetchedAt > now)
      throw Error("CHART_INVALID_AVAILABILITY");
    const rows = h.candles.filter((c) =>
      validChartCandle(c, Math.min(now, h.fetchedAt)),
    );
    const caseContext =
      context && typeof context === "object"
      ? (context as { positionId?: string; entryAt?: number; phase?: string; postSellAt?: number })
        : {};
    sqliteAtomic(this.db, () => {
      const insert = this.db.prepare(
        "INSERT OR IGNORE INTO chart_candles VALUES(?,?,?,?,?,?)",
      );
      for (const c of rows) {
        const id = chartId(mint, h.source, c.at),
          observedAt = Math.max(c.at + 60000, Math.min(now, h.fetchedAt));
        insert.run(
          id,
          mint,
          h.source,
          c.at,
          observedAt,
          JSON.stringify({ ...c, complete: true, source: h.source }),
        );
        // A revision is never allowed to silently change evidence already used.
        const saved = this.db
          .prepare("SELECT payload FROM chart_candles WHERE id=?")
          .get(id)!;
        const original = JSON.parse(String(saved.payload)) as Candle;
        if (
          ["open", "high", "low", "close", "volumeUsd"].some(
            (k) => original[k as keyof Candle] !== c[k as keyof Candle],
          )
        )
          continue;
        if (caseContext.positionId)
          this.linkCaseEvidence(
            caseContext.positionId,
            id,
            "CANDLE",
            caseContext.phase === "POST_SELL_FOLLOWUP" && c.at >= (caseContext.postSellAt ?? Infinity)
              ? "OUTCOME"
              : c.at < (caseContext.entryAt ?? now)
                ? "PRE_BUY_CONTEXT"
                : "POST_BUY_OBSERVATION",
            observedAt,
          );
        const drop = rugDrop(c),
          rise = (c.high / c.open - 1) * 100;
        const prefix = rows.filter((x) => x.at < c.at).slice(-5);
        const previousHigh =
          prefix.length === 5 ? Math.max(...prefix.map((x) => x.high)) : null;
        const five = chartFeatures(rows, c.at + 60000, 5),
          fifteen = chartFeatures(rows, c.at + 60000, 15),
          thirty = chartFeatures(rows, c.at + 60000, 30);
        const kinds = [
          ...(drop >= 30 - 1e-10
            ? ["RUG_30"]
            : drop >= 15
              ? ["SHARP_DECLINE"]
              : []),
          ...(rise >= 25 ? ["RAPID_PUMP"] : []),
          ...(drop >= 15 && c.close / c.low >= 1.2 ? ["STRONG_RECOVERY"] : []),
          ...(c.at % 900000 === 0 ? ["CONTROL"] : []),
          ...(previousHigh &&
          c.high > previousHigh * 1.01 &&
          c.close < previousHigh &&
          c.close < c.open
            ? ["FAILED_BREAKOUT"]
            : []),
          ...(c.at % 300000 === 0 &&
          fifteen.coverage >= 0.8 &&
          (fifteen.returnPct ?? 0) <= -20
            ? ["SUSTAINED_DRAWDOWN"]
            : []),
          ...(c.at % 300000 === 0 &&
          five.coverage >= 0.8 &&
          (five.volatility ?? 0) > 8 &&
          (five.volatility ?? 0) > (fifteen.volatility ?? Infinity) * 1.5
            ? ["VOLATILITY_EXPANSION"]
            : []),
          ...(c.at % 300000 === 0 &&
          thirty.coverage >= 0.8 &&
          (thirty.returnPct ?? 0) >= 20 &&
          (thirty.momentumChange ?? -Infinity) >= 0
            ? ["CONTINUED_UPTREND"]
            : []),
        ];
        for (const kind of kinds) {
          const event: ChartEvent = {
            id: chartId(id, kind),
            mint,
            kind,
            at: c.at,
            availableAt: observedAt,
            candleId: id,
            candle: c,
            dropPercent: drop,
            preEvent: preEventFeatures(rows, c.at),
            quality: {
              source: h.source,
              missing: [
                "historicalLiquidity",
                "historicalDepth",
                "historicalHolderMovements",
              ],
            },
          };
          this.db
            .prepare("INSERT OR IGNORE INTO chart_events VALUES(?,?,?,?,?,?,?)")
            .run(event.id, mint, kind, c.at, observedAt, id, JSON.stringify(event));
          if (caseContext.positionId)
            this.linkCaseEvidence(
              caseContext.positionId,
              event.id,
              "EVENT",
              caseContext.phase === "POST_SELL_FOLLOWUP" && c.at >= (caseContext.postSellAt ?? Infinity)
                ? "OUTCOME"
                : c.at < (caseContext.entryAt ?? now)
                  ? "PRE_BUY_CONTEXT"
                  : "POST_BUY_OBSERVATION",
              observedAt,
            );
        }
      }
    });
    if (
      this.store.sharedLearning &&
      h.historyFrom !== null &&
      h.historyTo !== null
    ) {
      const id = chartId(mint, h.source, h.historyFrom, h.historyTo);
      if (
        !this.db.prepare("SELECT id FROM learning_windows WHERE id=?").get(id)
      )
        this.db
          .prepare(
            "INSERT OR IGNORE INTO learning_windows VALUES(?,?,?,?,?,?,?)",
          )
          .run(
            id,
            mint,
            h.source,
            h.historyFrom,
            h.historyTo,
            now,
            JSON.stringify({
              features: preEventFeatures(rows, h.historyTo),
              quality: h.diagnostics,
              source: h.source,
            }),
          );
    }
    const snapshotId = this.snapshot(mint, now, { history: h, context });
    if (caseContext.positionId)
      this.linkCaseEvidence(
        caseContext.positionId,
        snapshotId,
        "SNAPSHOT",
        "POST_BUY_OBSERVATION",
        now,
      );
    return snapshotId;
  }
  linkCaseEvidence(
    positionId: string,
    evidenceId: string,
    evidenceType: string,
    phase: "PRE_BUY_CONTEXT" | "POST_BUY_OBSERVATION" | "EXECUTION" | "OUTCOME",
    availableAt = Date.now(),
  ) {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO chart_case_evidence VALUES(?,?,?,?,?)",
      )
      .run(positionId, evidenceId, evidenceType, phase, availableAt);
  }
  snapshot(mint: string, at: number, payload: unknown) {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO chart_snapshots VALUES(?,?,?,?)")
      .run(id, mint, at, JSON.stringify(payload));
    return id;
  }
  candles(
    mint: string,
    from = 0,
    to = Date.now(),
    availableBy = Date.now(),
  ): Candle[] {
    return this.db
      .prepare(
        "SELECT payload FROM chart_candles WHERE mint=? AND at>=? AND at+60000<=? AND available_at<=? ORDER BY at LIMIT 10080",
      )
      .all(mint, from, to, availableBy)
      .map((r) => JSON.parse(String(r.payload)));
  }
  events(limit = 200): ChartEvent[] {
    return this.db
      .prepare("SELECT payload FROM chart_events ORDER BY at DESC LIMIT ?")
      .all(limit)
      .map((r) => JSON.parse(String(r.payload)));
  }
  rules(cutoff = Date.now()): LearningRule[] {
    return this.db
      .prepare(
        `SELECT v.payload FROM chart_rule_versions v WHERE v.at<=?
      AND v.version=(SELECT max(x.version) FROM chart_rule_versions x WHERE x.id=v.id AND x.at<=?) ORDER BY v.at DESC LIMIT 100`,
      )
      .all(cutoff, cutoff)
      .map((r) => JSON.parse(String(r.payload)));
  }
  saveRule(rule: LearningRule) {
    if (
      !rule.id ||
      !rule.name ||
      !rule.invalidation ||
      rule.at > Date.now() ||
      rule.version < 1 ||
      ![5, 15, 30, 60].includes(rule.window)
    )
      throw Error("CHART_RULE_INVALID");
    if (rule.status === "VALIDATED") {
      const v =
        rule.validationId &&
        this.db
          .prepare("SELECT payload FROM chart_validations WHERE id=? AND at<=?")
          .get(rule.validationId, rule.at);
      const validation = v ? JSON.parse(String(v.payload)) : null;
      if (
        !validation?.passed ||
        validation.ruleId !== rule.id ||
        validation.ruleVersion !== rule.version ||
        validation.definitionHash !==
          chartId(rule.behaviors, rule.window, rule.action)
      )
        throw Error("CHART_VALIDATION_REQUIRED");
    }
    sqliteAtomic(this.db, () => {
      const last = this.db
        .prepare("SELECT max(version) n FROM chart_rule_versions WHERE id=?")
        .get(rule.id);
      if (rule.version !== Number(last?.n ?? 0) + 1)
        throw Error("CHART_RULE_VERSION_CONFLICT");
      this.db
        .prepare("INSERT INTO chart_rule_versions VALUES(?,?,?,?,?)")
        .run(rule.id, rule.version, rule.at, rule.status, JSON.stringify(rule));
      for (const [stance, ids] of [
        ["SUPPORT", rule.supportingEventIds],
        ["CONTRADICT", rule.contradictoryEventIds],
      ] as const) {
        for (const id of ids) {
          if (
            !this.db
              .prepare(
                "SELECT id FROM chart_events WHERE id=? AND available_at<=?",
              )
              .get(id, rule.at)
          )
            throw Error("CHART_FABRICATED_OR_FUTURE_EVIDENCE");
          this.db
            .prepare("INSERT INTO chart_rule_evidence VALUES(?,?,?,?)")
            .run(rule.id, rule.version, id, stance);
        }
      }
    });
  }
  decision(d: ChartDecision) {
    for (const rule of d.rules) {
      const r = this.db
        .prepare(
          "SELECT payload FROM chart_rule_versions WHERE id=? AND version=? AND at<=?",
        )
        .get(rule.id, rule.version, d.at);
      if (
        !r ||
        JSON.stringify(JSON.parse(String(r.payload))) !==
          JSON.stringify(rule) ||
        rule.status !== "VALIDATED"
      )
        throw Error("CHART_INVALID_RULE_REFERENCE");
      for (const id of [
        ...rule.supportingEventIds,
        ...rule.contradictoryEventIds,
      ])
        if (
          !this.db
            .prepare(
              "SELECT id FROM chart_events WHERE id=? AND available_at<=?",
            )
            .get(id, d.at)
        )
          throw Error("CHART_FABRICATED_OR_FUTURE_EVIDENCE");
    }
    if ((d.action === "BLOCK" || d.action === "SELL") && !d.rules.length)
      throw Error("CHART_AUTHORITATIVE_EVIDENCE_REQUIRED");
    this.db
      .prepare("INSERT INTO chart_decisions VALUES(?,?,?,?,?,?,?,?,?)")
      .run(
        d.id,
        d.mode,
        d.accountId,
        d.mint,
        d.positionId ?? null,
        d.at,
        d.action,
        d.snapshotId,
        JSON.stringify(d),
      );
  }
  decisions(mode: Mode, limit = 100): ChartDecision[] {
    if (this.store.sharedLearning)
      return this.db
        .prepare("SELECT payload FROM chart_decisions ORDER BY at DESC LIMIT ?")
        .all(limit)
        .map((r) => JSON.parse(String(r.payload)));
    return this.db
      .prepare(
        "SELECT payload FROM chart_decisions WHERE mode=? AND account_id=? ORDER BY at DESC LIMIT ?",
      )
      .all(mode, this.account(mode), limit)
      .map((r) => JSON.parse(String(r.payload)));
  }
  watch(
    mint: string,
    mode: Mode,
    priority: number,
    reason: string,
    now = Date.now(),
  ) {
    if (this.store.sharedLearning) {
      this.db
        .prepare(
          `INSERT INTO chart_observation_queue VALUES(?,?,?,?,?,0) ON CONFLICT(mint) DO UPDATE SET priority=min(priority,excluded.priority),until_at=max(until_at,excluded.until_at),reason=excluded.reason`,
        )
        .run(mint, priority, now, now + 65 * 60000, reason);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO chart_observation_queue(mode,account_id,mint,priority,due,until_at,reason) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(mode,account_id,mint) DO UPDATE SET priority=min(priority,excluded.priority), until_at=max(until_at,excluded.until_at), reason=excluded.reason`,
      )
      .run(
        mode,
        this.account(mode),
        mint,
        priority,
        now,
        now + 65 * 60000,
        reason,
      );
  }
  job(
    kind: string,
    key: string,
    payload: unknown,
    mode: Mode,
    now = Date.now(),
  ) {
    const id = this.store.sharedLearning
      ? chartId(kind, key)
      : chartId(kind, key, mode, this.account(mode));
    if (this.store.sharedLearning) {
      const prior = this.db
        .prepare(
          "SELECT id FROM chart_jobs WHERE kind=? AND (json_extract(payload,'$.id')=? OR json_extract(payload,'$.positionId')=? OR json_extract(payload,'$.event.id') || ':' || json_extract(payload,'$.outcome.horizon')=? OR json_extract(payload,'$.event.id')=?) ORDER BY CASE state WHEN 'COMPLETED' THEN 0 ELSE 1 END,at LIMIT 1",
        )
        .get(kind, key, key, key, key);
      if (prior) return String(prior.id);
    }
    this.db
      .prepare(
        "INSERT OR IGNORE INTO chart_jobs(id,kind,mode,account_id,at,due,state,payload) VALUES(?,?,?,?,?,?,'PENDING',?)",
      )
      .run(
        id,
        kind,
        this.store.sharedLearning && kind !== "TRADE_REVIEW" ? "shared" : mode,
        this.store.sharedLearning && kind !== "TRADE_REVIEW"
          ? "shared"
          : kind === "TRADE_REVIEW" &&
              payload !== null &&
              typeof payload === "object" &&
              "accountId" in payload &&
              typeof payload.accountId === "string"
            ? payload.accountId
            : this.account(mode),
        now,
        now,
        JSON.stringify(payload),
      );
    return id;
  }
  overview(mode: Mode) {
    if (this.store.sharedLearning) {
      const count = (table: string, where = "") =>
        Number(
          this.db.prepare(`SELECT count(*) n FROM ${table} ${where}`).get()!.n,
        );
      return {
        policy: CHART_POLICY,
        tradesAnalyzed: count("chart_replays"),
        marketEvents: count("chart_events", "WHERE kind<>'CONTROL'"),
        rug30: count("chart_events", "WHERE kind='RUG_30'"),
        eventsAnalyzed: count(
          "chart_jobs",
          "WHERE kind='EVENT_REVIEW' AND state='COMPLETED'",
        ),
        candleCount: count("chart_candles"),
        chartWindows: count("learning_windows"),
        analysesCompleted: count("chart_jobs", "WHERE state='COMPLETED'"),
        rejectedRules: this.rules().filter((r) => r.status === "REJECTED")
          .length,
        retiredRules: this.rules().filter((r) => r.status === "RETIRED").length,
        rules: this.rules().length,
        validatedRules: this.rules().filter((r) => r.status === "VALIDATED")
          .length,
        decisions: Object.fromEntries(
          ["PASS", "BLOCK", "SELL", "ERROR"].map((a) => [
            a,
            count("chart_decisions", `WHERE action='${a}'`),
          ]),
        ),
        jobs: this.db
          .prepare("SELECT state,count(*) n FROM chart_jobs GROUP BY state")
          .all(),
        oldestPendingAt:
          this.db
            .prepare("SELECT min(at) n FROM chart_jobs WHERE state='PENDING'")
            .get()!.n ?? null,
        outcomes: this.db
          .prepare(
            "SELECT json_extract(payload,'$.classification') classification,count(*) n FROM chart_followups GROUP BY classification",
          )
          .all(),
        scope: {
          mode: "SHARED",
          accountId: "shared",
          marketEvidence: "SHARED_REAL_MARKET",
        },
      };
    }
    const count = (sql: string, ...args: (string | number)[]) =>
      Number(this.db.prepare(sql).get(...args)?.n ?? 0);
    const scoped = [mode, this.account(mode)];
    return {
      policy: CHART_POLICY,
      tradesAnalyzed: count(
        "SELECT count(*) n FROM chart_replays WHERE mode=? AND account_id=?",
        ...scoped,
      ),
      marketEvents: count(
        "SELECT count(*) n FROM chart_events WHERE kind<>'CONTROL'",
      ),
      rug30: count("SELECT count(*) n FROM chart_events WHERE kind='RUG_30'"),
      eventsAnalyzed: count(
        "SELECT count(*) n FROM chart_jobs WHERE kind='EVENT_REVIEW' AND state='COMPLETED'",
      ),
      candleCount: count("SELECT count(*) n FROM chart_candles"),
      rules: this.rules().length,
      validatedRules: this.rules().filter((r) => r.status === "VALIDATED")
        .length,
      decisions: Object.fromEntries(
        ["PASS", "BLOCK", "SELL", "ERROR"].map((action) => [
          action,
          count(
            "SELECT count(*) n FROM chart_decisions WHERE mode=? AND account_id=? AND action=?",
            ...scoped,
            action,
          ),
        ]),
      ),
      jobs: this.db
        .prepare(
          "SELECT state,count(*) n FROM chart_jobs WHERE mode=? AND account_id=? GROUP BY state",
        )
        .all(...scoped),
      oldestPendingAt:
        this.db
          .prepare(
            "SELECT min(at) n FROM chart_jobs WHERE mode=? AND account_id=? AND state='PENDING'",
          )
          .get(...scoped)!.n ?? null,
      outcomes: this.db
        .prepare(
          `SELECT json_extract(f.payload,'$.classification') classification,count(*) n FROM chart_followups f JOIN chart_decisions d ON d.id=f.decision_id WHERE d.mode=? AND d.account_id=? GROUP BY classification`,
        )
        .all(...scoped),
      scope: {
        mode,
        accountId: this.account(mode),
        marketEvidence: "SHARED_REAL_MARKET",
      },
    };
  }
}
