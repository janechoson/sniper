import { DatabaseSync } from "node:sqlite";
import { assertStrategySell } from "./strategy-authority.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { withTokenLogo } from "./token-metadata.js";
import { env } from "./config.js";
import {
  Blocked,
  CandidateRejected,
  type Candidate,
  type Position,
  type Execution,
  type Intent,
  type Mode,
  type ManualExitRequest,
  type ExitOpportunity,
  type BuyOwnershipClaim,
  type Snapshot,
  type Strategy,
} from "./domain.js";
import { json } from "./util.js";
import { learningMigration } from "./learning-schema.js";
import { chartLearningMigration } from "./chart-learning-schema.js";
import {
  demoMigration,
  demoCurrencyMigration,
  DemoLedger,
} from "./demo-ledger.js";
import { sessionMigration } from "./mode-manager.js";
import { mergeDiscovery } from "./discovery.js";
import type { TrendingBatch, TrendingBatchBinding } from "./trending-batch.js";
import {
  size,
  positionSizeMatches,
  type PositionSizing,
} from "./position-sizing.js";
export class Store {
  private closed = false;
  readonly boundMode?: Mode;
  private readonly sharedDb?: DatabaseSync;
  get mode(): Mode {
    return this.boundMode ?? env.TRADING_MODE;
  }
  get learningDb() {
    return this.sharedDb ?? this.db;
  }
  get sharedLearning() {
    return !!this.sharedDb;
  }
  assertMode(mode: Mode) {
    if (this.boundMode && mode !== this.boundMode)
      throw new Blocked("TRADING_DATABASE_MODE_MISMATCH");
  }
  private scopedRecords = false;
  private scopedTokens = false;
  private virtualSchema = false;
  readonly db: DatabaseSync;
  constructor(
    readonly path: string,
    options: {
      readOnly?: boolean;
      mode?: Mode;
      learningDb?: DatabaseSync;
      initializeDemo?: boolean;
    } = {},
  ) {
    this.boundMode = options.mode;
    this.sharedDb = options.learningDb;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, { readOnly: options.readOnly ?? false });
    try {
      if (this.boundMode && !options.readOnly) {
        this.db.exec(
          "CREATE TABLE IF NOT EXISTS database_identity(id INTEGER PRIMARY KEY CHECK(id=1),role TEXT NOT NULL)",
        );
        this.db
          .prepare("INSERT OR IGNORE INTO database_identity VALUES(1,?)")
          .run(this.boundMode);
        if (
          this.db
            .prepare("SELECT role FROM database_identity WHERE id=1")
            .get()!.role !== this.boundMode
        )
          throw new Blocked("DATABASE_ROLE_MISMATCH");
      }
      if (options.readOnly) {
        this.db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000;");
        this.scopedRecords = this.db
          .prepare("PRAGMA table_info(records)")
          .all()
          .some((r) => r.name === "scope_mode");
        this.scopedTokens = !!this.db
          .prepare("SELECT 1 FROM sqlite_master WHERE name='mode_tokens'")
          .get();
        this.virtualSchema = !!this.db
          .prepare("SELECT 1 FROM sqlite_master WHERE name='demo_accounts'")
          .get();
        return;
      }
      this.db
        .exec(`PRAGMA journal_mode=WAL;PRAGMA busy_timeout=5000;PRAGMA synchronous=FULL;PRAGMA foreign_keys=ON;
 CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY,at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS tokens(mint TEXT PRIMARY KEY,payload TEXT NOT NULL,processed INTEGER NOT NULL DEFAULT 0,at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS discovery_events(id INTEGER PRIMARY KEY,mint TEXT NOT NULL,source TEXT NOT NULL,at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS records(id INTEGER PRIMARY KEY,kind TEXT NOT NULL,mint TEXT,payload TEXT NOT NULL,at INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS record_lookup ON records(mint,kind,id);
 CREATE INDEX IF NOT EXISTS records_kind_mode_id ON records(kind,json_extract(payload,'$.mode'),id);
 CREATE INDEX IF NOT EXISTS records_kind_time ON records(kind,at);
 CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,payload TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS trending_appearances(id INTEGER PRIMARY KEY,mode TEXT NOT NULL,mint TEXT NOT NULL,seen_at INTEGER NOT NULL,consumed INTEGER NOT NULL DEFAULT 0,payload TEXT NOT NULL,UNIQUE(mode,mint,seen_at));
 CREATE INDEX IF NOT EXISTS appearance_queue ON trending_appearances(mode,consumed,id);
 CREATE TABLE IF NOT EXISTS candidate_attempts(id TEXT PRIMARY KEY,mode TEXT NOT NULL,mint TEXT NOT NULL,started_at INTEGER NOT NULL,result TEXT NOT NULL,failed_stage TEXT,payload TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS buy_ownership_claims(id TEXT PRIMARY KEY,mode TEXT NOT NULL,mint TEXT NOT NULL,attempt_id TEXT NOT NULL,active INTEGER NOT NULL,payload TEXT NOT NULL,UNIQUE(mode,mint,attempt_id));
 CREATE UNIQUE INDEX IF NOT EXISTS buy_ownership_active ON buy_ownership_claims(mode,mint) WHERE active=1;
 INSERT OR IGNORE INTO migrations VALUES(12,unixepoch());
 CREATE INDEX IF NOT EXISTS attempt_mint_time ON candidate_attempts(mode,mint,started_at);
 CREATE INDEX IF NOT EXISTS attempt_result_time ON candidate_attempts(mode,result,started_at);
 INSERT OR IGNORE INTO migrations VALUES(11,unixepoch());
 CREATE TABLE IF NOT EXISTS candidate_lifecycle(mode TEXT NOT NULL,mint TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(mode,mint));
 CREATE TABLE IF NOT EXISTS positions(id TEXT PRIMARY KEY,mode TEXT NOT NULL,mint TEXT NOT NULL,state TEXT NOT NULL,payload TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS intents(id TEXT PRIMARY KEY,key TEXT UNIQUE NOT NULL,payload TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS executions(id TEXT PRIMARY KEY,intent_id TEXT UNIQUE NOT NULL,state TEXT NOT NULL,signature TEXT,payload TEXT NOT NULL);
 CREATE UNIQUE INDEX IF NOT EXISTS execution_buy_claim ON executions(json_extract(payload,'$.intent.ownershipClaimId')) WHERE json_extract(payload,'$.intent.side')='BUY' AND json_extract(payload,'$.intent.ownershipClaimId') IS NOT NULL;
 CREATE TABLE IF NOT EXISTS manual_exits(id TEXT PRIMARY KEY,position_id TEXT NOT NULL,mode TEXT NOT NULL,state TEXT NOT NULL,payload TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS execution_fills(signature TEXT PRIMARY KEY,execution_id TEXT UNIQUE NOT NULL,slot INTEGER NOT NULL,payload TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS jev_exit_decisions(id TEXT PRIMARY KEY,position_id TEXT NOT NULL,state TEXT NOT NULL,payload TEXT NOT NULL);
 INSERT OR IGNORE INTO migrations VALUES(7,unixepoch());
 CREATE TABLE IF NOT EXISTS capital_flow_states(position_id TEXT PRIMARY KEY,mode TEXT NOT NULL,mint TEXT NOT NULL,updated_at INTEGER NOT NULL,payload TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS position_runner_memory(position_id TEXT PRIMARY KEY,mode TEXT NOT NULL,mint TEXT NOT NULL,updated_at INTEGER NOT NULL,payload TEXT NOT NULL);
 INSERT OR IGNORE INTO migrations VALUES(8,unixepoch());
 CREATE TABLE IF NOT EXISTS candidate_flow_states(mint TEXT PRIMARY KEY,updated_at INTEGER NOT NULL,payload TEXT NOT NULL);
 INSERT OR IGNORE INTO migrations VALUES(9,unixepoch());
 CREATE TABLE IF NOT EXISTS sniper_structure_watch(mode TEXT NOT NULL,mint TEXT NOT NULL,updated_at INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(mode,mint));
 CREATE TABLE IF NOT EXISTS entry_structure_watch(mode TEXT NOT NULL,mint TEXT NOT NULL,updated_at INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(mode,mint));
 INSERT OR IGNORE INTO migrations VALUES(10,unixepoch());
 CREATE INDEX IF NOT EXISTS jev_decision_position ON jev_exit_decisions(position_id,id);
 CREATE INDEX IF NOT EXISTS records_decision_position ON records(kind,json_extract(payload,'$.decision.positionId'),id);
 INSERT OR IGNORE INTO migrations VALUES(6,unixepoch());
 CREATE INDEX IF NOT EXISTS execution_mint_mode ON executions(json_extract(payload,'$.intent.mint'),json_extract(payload,'$.intent.mode'));
 INSERT OR IGNORE INTO migrations VALUES(3,unixepoch());`);
      if (!this.sharedDb) {
        this.db.exec(learningMigration);
        this.db.exec(chartLearningMigration);
      }
      this.db.exec(demoMigration);
      this.db.exec(sessionMigration);
      if (
        !this.db
          .prepare("PRAGMA table_info(records)")
          .all()
          .some((r) => r.name === "scope_mode")
      )
        this.db.exec("ALTER TABLE records ADD COLUMN scope_mode TEXT");
      if (
        !this.db
          .prepare("PRAGMA table_info(records)")
          .all()
          .some((r) => r.name === "scope_account")
      )
        this.db.exec("ALTER TABLE records ADD COLUMN scope_account TEXT");
      this.db
        .exec(`CREATE INDEX IF NOT EXISTS record_mode_lookup ON records(scope_mode,scope_account,kind,mint,id);
      CREATE TABLE IF NOT EXISTS mode_tokens(mode TEXT NOT NULL,mint TEXT NOT NULL,payload TEXT NOT NULL,processed INTEGER NOT NULL DEFAULT 0,at INTEGER NOT NULL,PRIMARY KEY(mode,mint));
      INSERT OR IGNORE INTO mode_tokens SELECT 'live',mint,payload,processed,at FROM tokens;
      INSERT OR IGNORE INTO migrations VALUES(15,unixepoch());`);
      this.db.exec(demoCurrencyMigration);
      this.scopedRecords = this.scopedTokens = this.virtualSchema = true;
      if (!this.sharedDb)
        this.db.exec(
          "CREATE INDEX IF NOT EXISTS failures_sample ON trade_execution_failures(sample_id); CREATE INDEX IF NOT EXISTS evidence_sample ON trade_execution_evidence(sample_id); CREATE INDEX IF NOT EXISTS learning_mode_entry ON trade_learning_samples(mode,entry_at);",
        );
      // Explicit owner-requested policy revision: 1% entries during data collection.
      // Learning itself never changes strategy parameters.
      this.db
        .exec(`UPDATE settings SET payload=json_set(payload,'$.positionSizePercent',1)
      WHERE key='strategyV2' AND json_extract(payload,'$.positionSizePercent')=10
      AND NOT EXISTS(SELECT 1 FROM migrations WHERE version=5);
      INSERT OR IGNORE INTO migrations VALUES(5,unixepoch());`);
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS learning_outbox(id TEXT PRIMARY KEY,kind TEXT NOT NULL,at INTEGER NOT NULL,payload TEXT NOT NULL,delivered_at INTEGER);`,
      );
      if (this.boundMode)
        this.db.exec("INSERT OR IGNORE INTO migrations VALUES(18,unixepoch())");
      if (this.boundMode) {
        if (this.boundMode === "live")
          for (const table of [
            "demo_accounts",
            "demo_ledger",
            "demo_holdings",
            "demo_reservations",
            "demo_balance_snapshots",
            "demo_account_units",
          ])
            for (const op of ["INSERT", "UPDATE"])
              this.db.exec(
                `CREATE TRIGGER IF NOT EXISTS ${table}_live_forbidden_${op.toLowerCase()} BEFORE ${op} ON ${table} BEGIN SELECT RAISE(ABORT,'DEMO_ACCOUNT_IN_LIVE_DATABASE'); END;`,
              );
        for (const table of [
          "positions",
          "manual_exits",
          "candidate_attempts",
          "buy_ownership_claims",
          "candidate_lifecycle",
          "mode_tokens",
          "trending_appearances",
          "capital_flow_states",
          "position_runner_memory",
          "sniper_structure_watch",
          "entry_structure_watch",
        ])
          for (const op of ["INSERT", "UPDATE"])
            this.db.exec(
              `CREATE TRIGGER IF NOT EXISTS ${table}_mode_${op.toLowerCase()} BEFORE ${op} ON ${table} WHEN NEW.mode<>'${this.boundMode}' BEGIN SELECT RAISE(ABORT,'TRADING_DATABASE_MODE_MISMATCH'); END;`,
            );
        for (const [table, expr] of [
          ["intents", "json_extract(NEW.payload,'$.mode')"],
          ["executions", "json_extract(NEW.payload,'$.intent.mode')"],
        ])
          for (const op of ["INSERT", "UPDATE"])
            this.db.exec(
              `CREATE TRIGGER IF NOT EXISTS ${table}_mode_${op.toLowerCase()} BEFORE ${op} ON ${table} WHEN ${expr} IS NULL OR ${expr}<>'${this.boundMode}' BEGIN SELECT RAISE(ABORT,'TRADING_DATABASE_MODE_MISMATCH'); END;`,
            );
      }
      if (this.mode === "demo" && options.initializeDemo !== false)
        new DemoLedger(this.db).initialize();
    } catch (e) {
      this.db.close();
      throw e;
    }
  }
  atomic<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const v = fn();
      this.db.exec("COMMIT");
      return v;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  private scopeKey(key: string) {
    if (
      this.mode !== "demo" ||
      ["strategyV2", "selectedTradingMode"].includes(key)
    )
      return key;
    return "demo:" + this.demoAccountId() + ":" + key;
  }
  demoAccountId() {
    return this.virtualSchema
      ? String(
          this.db
            .prepare("SELECT id FROM demo_accounts WHERE archived_at IS NULL")
            .get()?.id ?? "uninitialized",
        )
      : "uninitialized";
  }
  candidateFlowKey(mint: string) {
    return this.mode === "demo" ? `demo:${this.demoAccountId()}:${mint}` : mint;
  }
  get<T>(key: string): T | undefined {
    key = this.scopeKey(key);
    const r = this.db
      .prepare("SELECT payload FROM settings WHERE key=?")
      .get(key);
    return r ? JSON.parse(String(r.payload)) : undefined;
  }
  set(key: string, v: unknown) {
    key = this.scopeKey(key);
    this.db
      .prepare(
        "INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload",
      )
      .run(key, json(v));
  }
  entriesEnabled() {
    return (
      env.NEW_ENTRIES_ENABLED &&
      (this.get<boolean>("newEntriesEnabled") ??
        (this.get<string>("kill") ?? "RUNNING") === "RUNNING")
    );
  }
  metric(name: string) {
    const metrics = this.get<Record<string, number>>("faultMetrics") ?? {};
    metrics[name] = (metrics[name] ?? 0) + 1;
    this.set("faultMetrics", metrics);
  }
  reportFailure(reason: string, scope: "SYSTEM" | "TRANSACTION" = "SYSTEM") {
    this.metric("systemFailures");
    const failure = { reason, scope, at: Date.now() };
    this.set("lastFailure", failure);
    this.record("events", undefined, {
      type: "ERROR",
      ...failure,
      disposition: "CONTINUE_NEW_ENTRIES",
    });
  }
  // Historical operator API; use the selected LIVE baseline's failure policy.
  halt(reason: string, scope: "SYSTEM" | "TRANSACTION" = "SYSTEM") {
    this.reportFailure(reason, scope);
  }
  record(kind: string, mint: string | undefined, payload: unknown): void {
    if (this.sharedLearning && !this.db.isTransaction)
      return this.atomic(() => this.record(kind, mint, payload));
    this.db
      .prepare(
        "INSERT INTO records(kind,mint,payload,at,scope_mode,scope_account) VALUES(?,?,?,?,?,?)",
      )
      .run(
        kind,
        mint ?? null,
        json(payload),
        Date.now(),
        this.mode,
        this.mode === "demo" ? this.demoAccountId() : null,
      );
    if (
      this.sharedLearning &&
      [
        "kronos_decisions",
        "position_market",
        "position_history",
        "snapshots",
        "common_eligibility",
        "risk_decisions",
      ].includes(kind)
    )
      this.db
        .prepare("INSERT OR IGNORE INTO learning_outbox VALUES(?,?,?,?,NULL)")
        .run(
          randomUUID(),
          "OBSERVATION",
          Date.now(),
          json({
            kind,
            mint,
            payload,
            mode: this.mode,
            simulated: this.mode === "demo",
          }),
        );
  }
  event(type: string, mint?: string, reason?: string) {
    this.record("events", mint, { type, reason, mode: this.mode });
  }
  pipelineEvent(
    type: string,
    mint: string,
    fields: Record<string, unknown> = {},
  ) {
    this.record("pipeline_transitions", mint, {
      ...fields,
      type,
      mint,
      symbol: this.token(mint)?.symbol,
      mode: this.mode,
      at: Date.now(),
    });
  }
  latest<T>(kind: string, mint: string): T | undefined {
    if (!this.scopedRecords) {
      if (this.mode === "demo") return undefined;
      const row = this.db
        .prepare(
          "SELECT payload FROM records WHERE kind=? AND mint=? ORDER BY id DESC LIMIT 1",
        )
        .get(kind, mint);
      return row ? JSON.parse(String(row.payload)) : undefined;
    }
    const r = this.db
      .prepare(
        "SELECT payload FROM records WHERE kind=? AND mint=? AND COALESCE(scope_mode,json_extract(payload,'$.mode'),'live')=? AND (?<>'demo' OR scope_account=?) ORDER BY id DESC LIMIT 1",
      )
      .get(kind, mint, this.mode, this.mode, this.demoAccountId());
    return r ? JSON.parse(String(r.payload)) : undefined;
  }
  recent(kind: string, limit = 100) {
    if (!this.scopedRecords) {
      if (this.mode === "demo") return [];
      return this.db
        .prepare(
          "SELECT mint,payload,at FROM records WHERE kind=? ORDER BY id DESC LIMIT ?",
        )
        .all(kind, limit)
        .map((r) => ({ ...r, payload: JSON.parse(String(r.payload)) }));
    }
    return this.db
      .prepare(
        "SELECT mint,payload,at FROM records WHERE kind=? AND COALESCE(scope_mode,json_extract(payload,'$.mode'),'live')=? AND (?<>'demo' OR scope_account=?) ORDER BY id DESC LIMIT ?",
      )
      .all(kind, this.mode, this.mode, this.demoAccountId(), limit)
      .map((r) => ({ ...r, payload: JSON.parse(String(r.payload)) }));
  }
  trace(mint: string) {
    if (!this.scopedRecords) {
      if (this.mode === "demo") return [];
      return this.db
        .prepare(
          "SELECT kind,payload,at FROM records WHERE mint=? ORDER BY id DESC LIMIT 100",
        )
        .all(mint)
        .map((r) => ({ ...r, payload: JSON.parse(String(r.payload)) }));
    }
    return this.db
      .prepare(
        "SELECT kind,payload,at FROM records WHERE mint=? AND COALESCE(scope_mode,json_extract(payload,'$.mode'),'live')=? AND (?<>'demo' OR scope_account=?) ORDER BY id DESC LIMIT 100",
      )
      .all(mint, this.mode, this.mode, this.demoAccountId())
      .map((r) => ({ ...r, payload: JSON.parse(String(r.payload)) }));
  }
  discover(c: Candidate) {
    return this.atomic(() => {
      const old = this.token(c.mint);
      this.db
        .prepare(
          "INSERT INTO mode_tokens(mode,mint,payload,at) VALUES(?,?,?,?) ON CONFLICT(mode,mint) DO UPDATE SET payload=excluded.payload",
        )
        .run(
          this.mode,
          c.mint,
          json({
            ...mergeDiscovery(old, c),
          }),
          Date.now(),
        );
      const exists = this.db
        .prepare("SELECT id FROM discovery_events WHERE mint=? AND source=?")
        .get(c.mint, c.source);
      if (!exists)
        this.db
          .prepare("INSERT INTO discovery_events(mint,source,at) VALUES(?,?,?)")
          .run(c.mint, c.source, Date.now());
      if (!old) this.event("DISCOVER", c.mint);
      return !old;
    });
  }
  enqueueTrending(
    candidates: Candidate[],
    mode = this.mode,
    fetchedAt?: number,
  ) {
    const key = "oneShotAppearanceWatermark:" + mode;
    const watermark = this.get<number>(key) ?? 0;
    let newest = watermark;
    this.atomic(() => {
      const wasBusy = this.trendingWorkPending(mode);
      const inserted: Array<{ id: number; mint: string; seen: number }> = [];
      for (const c of candidates) {
        const seen = c.discovery?.trending?.lastSeenAt;
        if (seen === undefined || seen <= watermark) continue;
        const result = this.db
          .prepare(
            "INSERT OR IGNORE INTO trending_appearances(mode,mint,seen_at,payload) VALUES(?,?,?,?)",
          )
          .run(mode, c.mint, seen, JSON.stringify(c));
        if (result.changes)
          inserted.push({
            id: Number(result.lastInsertRowid),
            mint: c.mint,
            seen,
          });
        newest = Math.max(newest, seen);
      }
      if (newest > watermark) this.set(key, newest);
      // Only the complete discovery response establishes an exact total.
      // A cached snapshot with no new IDs must not re-arm the batch.
      if (
        fetchedAt !== undefined &&
        !wasBusy &&
        (inserted.length || !candidates.length)
      ) {
        const seen = inserted[0]?.seen ?? fetchedAt;
        const rows = inserted.filter((r) => r.seen === seen);
        this.set("trendingBatchV1:" + mode, {
          id: mode + ":" + seen,
          mode,
          fetchedAt: seen,
          legacy: false,
          total: rows.length,
          entries: rows.map((r) => ({
            appearanceId: r.id,
            mint: r.mint,
            status: "WAITING",
          })),
        } satisfies TrendingBatch);
      }
    });
  }
  trendingBatch(mode = this.mode) {
    return this.get<TrendingBatch>("trendingBatchV1:" + mode);
  }
  /** Admission/startup only; dashboard reads never synthesize batch metadata. */
  prepareTrendingBatch(mode = this.mode) {
    const current = this.trendingBatch(mode);
    if (current?.entries.some((r) => r.status !== "COMPLETE")) return current;
    const first = this.db
      .prepare(
        "SELECT seen_at FROM trending_appearances WHERE mode=? AND consumed=0 ORDER BY id LIMIT 1",
      )
      .get(mode);
    if (!first) return current;
    const seen = Number(first.seen_at);
    const rows = this.db
      .prepare(
        "SELECT id,mint FROM trending_appearances WHERE mode=? AND seen_at=? AND consumed=0 ORDER BY id",
      )
      .all(mode, seen);
    const batch: TrendingBatch = {
      id: mode + ":" + seen,
      mode,
      fetchedAt: seen,
      legacy: true,
      total: null,
      entries: rows.map((r) => ({
        appearanceId: Number(r.id),
        mint: String(r.mint),
        status: "WAITING",
      })),
    };
    this.set("trendingBatchV1:" + mode, batch);
    return batch;
  }
  trendingWorkPending(mode = this.mode) {
    return (
      !!this.db
        .prepare(
          "SELECT 1 FROM trending_appearances WHERE mode=? AND consumed=0 LIMIT 1",
        )
        .get(mode) ||
      !!this.db
        .prepare(
          "SELECT 1 FROM candidate_lifecycle WHERE mode=? AND json_extract(payload,'$.state') IN ('QUEUED','ANALYZING','QUALIFIED','APPROVED') LIMIT 1",
        )
        .get(mode) ||
      !!this.db
        .prepare(
          "SELECT 1 FROM candidate_attempts WHERE mode=? AND result IN ('RUNNING','RECONCILING') LIMIT 1",
        )
        .get(mode) ||
      !!this.trendingBatch(mode)?.entries.some((r) => r.status !== "COMPLETE")
    );
  }
  startTrendingAppearance(
    binding: TrendingBatchBinding,
    attemptId: string,
    mode = this.mode,
  ) {
    const batch = this.prepareTrendingBatch(mode);
    const row = batch?.entries.find(
      (r) => r.appearanceId === binding.appearanceId,
    );
    if (
      !batch ||
      batch.id !== binding.batchId ||
      !row ||
      row.status !== "WAITING"
    )
      throw Error("TRENDING_APPEARANCE_ALREADY_CLAIMED");
    row.status = "PROCESSING";
    row.attemptId = attemptId;
    this.set("trendingBatchV1:" + mode, batch);
    this.db
      .prepare(
        "UPDATE trending_appearances SET consumed=1 WHERE id=? AND mode=?",
      )
      .run(binding.appearanceId, mode);
  }
  settleTrendingAppearance(
    a: TrendingBatchBinding & {
      attemptId: string;
      result: string;
      endedAt?: number;
      mode: string;
    },
  ) {
    if (a.mode !== "paper" && a.mode !== "live" && a.mode !== "demo") return;
    const batch = this.trendingBatch(a.mode);
    const row = batch?.entries.find((r) => r.appearanceId === a.appearanceId);
    if (
      !batch ||
      batch.id !== a.batchId ||
      !row ||
      row.attemptId !== a.attemptId ||
      row.status === "COMPLETE"
    )
      return;
    row.result = a.result;
    if (["BOUGHT", "REJECTED"].includes(a.result)) {
      row.status = "COMPLETE";
      row.endedAt = a.endedAt;
    }
    this.set("trendingBatchV1:" + a.mode, batch);
  }
  finishUnboundTrendingAppearance(id: number, mode = this.mode) {
    const batch = this.trendingBatch(mode);
    const row = batch?.entries.find((r) => r.appearanceId === id);
    const consumed = this.db
      .prepare(
        "SELECT consumed FROM trending_appearances WHERE id=? AND mode=?",
      )
      .get(id, mode)?.consumed;
    // Legacy lifecycle-only callers; bound attempts always need durable outcomes.
    if (!batch || !batch.legacy || !row || row.attemptId || !consumed) return;
    row.status = "COMPLETE";
    row.result = "LEGACY_LIFECYCLE_FINISHED";
    this.set("trendingBatchV1:" + mode, batch);
  }
  recoverTrendingBatch(mode = this.mode) {
    const batch = this.trendingBatch(mode);
    for (const entry of batch?.entries ?? []) {
      if (entry.status !== "PROCESSING" || !entry.attemptId) continue;
      const row = this.db
        .prepare("SELECT payload FROM candidate_attempts WHERE id=? AND mode=?")
        .get(entry.attemptId, mode);
      if (row)
        this.settleTrendingAppearance({
          ...JSON.parse(String(row.payload)),
          appearanceId: entry.appearanceId,
          batchId: batch!.id,
        });
    }
  }
  trendingBatchProgress(mode = this.mode) {
    const batch = this.trendingBatch(mode);
    const waitingAll = Number(
      this.db
        .prepare(
          "SELECT count(*) n FROM trending_appearances WHERE mode=? AND consumed=0",
        )
        .get(mode)!.n,
    );
    const active = Number(
      this.db
        .prepare(
          "SELECT count(*) n FROM candidate_attempts WHERE mode=? AND result IN ('RUNNING','RECONCILING')",
        )
        .get(mode)!.n,
    );
    if (!batch)
      return {
        id: null,
        total: null,
        completed: null,
        processing: active,
        waiting: waitingAll,
        backlogRemaining: waitingAll,
        legacy: !!waitingAll,
        state: waitingAll || active ? "RECOVERY" : "EMPTY",
      };
    const running = batch.entries.filter((r) => r.status === "PROCESSING");
    const processing = batch.legacy
      ? Math.max(running.length, active)
      : running.length;
    const waiting = batch.entries.filter((r) => r.status === "WAITING").length;
    const completed = batch.entries.filter(
      (r) => r.status === "COMPLETE",
    ).length;
    const recovery =
      active > running.length ||
      running.some(
        (r) =>
          r.result === "RECONCILING" ||
          !r.attemptId ||
          !this.db
            .prepare(
              "SELECT 1 FROM candidate_attempts WHERE id=? AND result='RUNNING'",
            )
            .get(r.attemptId),
      );
    return {
      id: batch.id,
      fetchedAt: batch.fetchedAt,
      total: batch.total,
      completed: batch.legacy ? null : completed,
      processing,
      waiting,
      backlogRemaining: waitingAll,
      legacy: batch.legacy,
      state: recovery
        ? "RECOVERY"
        : processing || waiting
          ? "PROCESSING"
          : "COMPLETE",
    };
  }
  token(mint: string): Candidate | undefined {
    if (!this.scopedTokens) {
      if (this.mode === "demo") return;
      const r = this.db
        .prepare("SELECT payload FROM tokens WHERE mint=?")
        .get(mint);
      return r ? withTokenLogo(JSON.parse(String(r.payload))) : undefined;
    }
    const r = this.db
      .prepare("SELECT payload FROM mode_tokens WHERE mode=? AND mint=?")
      .get(this.mode, mint);
    return r ? withTokenLogo(JSON.parse(String(r.payload))) : undefined;
  }
  tokens(): Candidate[] {
    if (!this.scopedTokens) {
      if (this.mode === "demo") return [];
      return this.db
        .prepare("SELECT payload FROM tokens ORDER BY at DESC LIMIT 250")
        .all()
        .map((r) => withTokenLogo(JSON.parse(String(r.payload))));
    }
    return this.db
      .prepare(
        "SELECT payload FROM mode_tokens WHERE mode=? ORDER BY at DESC LIMIT 250",
      )
      .all(this.mode)
      .map((r) => withTokenLogo(JSON.parse(String(r.payload))));
  }
  savePosition(p: Position): void {
    this.assertMode(p.mode);
    if (this.sharedLearning && p.state === "CLOSED" && !this.db.isTransaction)
      return this.atomic(() => this.savePosition(p));
    const old = this.db
      .prepare("SELECT payload FROM positions WHERE id=?")
      .get(p.id);
    const prior: Position | undefined = old
      ? JSON.parse(String(old.payload))
      : undefined;
    if (prior && prior.mode !== p.mode)
      throw new Blocked("POSITION_MODE_IMMUTABLE");
    if (
      prior?.demoAccountId &&
      p.demoAccountId &&
      prior.demoAccountId !== p.demoAccountId
    )
      throw new Blocked("POSITION_ACCOUNT_IMMUTABLE");
    p.demoAccountId ??= prior?.demoAccountId;
    if (!prior && p.mode === "demo") p.demoAccountId ??= this.demoAccountId();
    if (
      prior &&
      (prior.strategy ?? "STANDARD") !==
        (p.strategy ?? prior.strategy ?? "STANDARD")
    )
      throw new Blocked("POSITION_STRATEGY_OWNER_IMMUTABLE");
    p.strategy = prior?.strategy ?? p.strategy ?? "STANDARD";
    if (
      prior?.ownershipClaimId &&
      p.ownershipClaimId &&
      prior.ownershipClaimId !== p.ownershipClaimId
    )
      throw new Blocked("POSITION_BUY_CLAIM_IMMUTABLE");
    p.ownershipClaimId = prior?.ownershipClaimId ?? p.ownershipClaimId;
    p.attemptId = prior?.attemptId ?? p.attemptId;
    p.quantityRevision =
      (prior?.quantityRevision ?? 0) +
      Number(!prior || p.quantity !== prior.quantity);
    p.positionRevision =
      (prior?.positionRevision ?? 0) +
      Number(
        !prior ||
          p.quantity !== prior.quantity ||
          p.state !== prior.state ||
          p.decisionRevision !== prior.decisionRevision,
      );
    p.updatedAt = Date.now();
    if (prior?.dismissal) {
      p = {
        ...p,
        dismissal: prior.dismissal,
        decisionRevision: Math.max(
          p.decisionRevision ?? 0,
          prior.decisionRevision ?? 0,
        ),
      };
    }
    this.db
      .prepare(
        "INSERT INTO positions VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,payload=excluded.payload",
      )
      .run(p.id, p.mode, p.mint, p.state, json(p));
    if (this.sharedLearning && p.state === "CLOSED")
      this.db
        .prepare("INSERT OR IGNORE INTO learning_outbox VALUES(?,?,?,?,NULL)")
        .run("closed:" + p.id, "TRADE_CLOSED", Date.now(), json(p));
    if (p.ownershipClaimId && p.state === "CLOSED" && BigInt(p.quantity) === 0n)
      this.resolveBuyOwnership(p.ownershipClaimId, "CLOSED");
  }
  positions(mode: Mode = this.mode): Position[] {
    return this.db
      .prepare("SELECT payload FROM positions" + (mode ? " WHERE mode=?" : ""))
      .all(...(mode ? [mode] : []))
      .map((r) => JSON.parse(String(r.payload)))
      .filter(
        (p) => mode !== "demo" || p.demoAccountId === this.demoAccountId(),
      );
  }
  /** History uses Position opening time, never observation or exit time. */
  attempt(
    id: string,
  ): import("./candidate-attempt.js").CandidateAttempt | undefined {
    const row = this.db
      .prepare(
        "SELECT payload FROM candidate_attempts WHERE id=? AND mode=? AND (?<>'demo' OR json_extract(payload,'$.demoAccountId')=?)",
      )
      .get(id, this.mode, this.mode, this.demoAccountId());
    return row ? JSON.parse(String(row.payload)) : undefined;
  }
  history(
    mode: Mode,
    options: {
      strategy?: "STANDARD" | "KRONOS";
      state?: Position["state"];
      limit?: number;
      offset?: number;
    } = {},
  ): Position[] {
    const { state = "CLOSED", limit, offset = 0 } = options;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1))
    )
      throw new Error("INVALID_HISTORY_PAGE");
    // Old rows can lack closedAt; use the confirmed final SELL's accounting
    // timestamp when its durable signature exists. Never use a mark/update time.
    const closeTime = `COALESCE(
      json_extract(payload,'$.closedAt'),
      json_extract(payload,'$.accounting.closedAt'),
      (SELECT COALESCE(json_extract(e.payload,'$.accounting.at'),json_extract(e.payload,'$.at'))
       FROM execution_fills f JOIN executions e ON e.id=f.execution_id
       WHERE f.signature=json_extract(positions.payload,'$.sellSignature')
         AND e.state='CONFIRMED' AND json_extract(e.payload,'$.intent.side')='SELL')
    )`;
    return this.db
      .prepare(
        "SELECT payload FROM positions WHERE mode=? AND (?<>'demo' OR json_extract(payload,'$.demoAccountId')=?) AND state=? AND CAST(json_extract(payload,'$.originalQuantity') AS INTEGER)>0" +
          (options.strategy
            ? " AND COALESCE(json_extract(payload,'$.strategy'),'STANDARD')=?"
            : "") +
          ` ORDER BY CASE WHEN state='CLOSED' THEN CAST(${closeTime} AS INTEGER) END DESC,` +
          " CAST(json_extract(payload,'$.entryAt') AS INTEGER) DESC,id DESC LIMIT ? OFFSET ?",
      )
      .all(
        mode,
        mode,
        this.demoAccountId(),
        state,
        ...(options.strategy ? [options.strategy] : []),
        limit ?? -1,
        offset,
      )
      .map((r) => {
        const p = JSON.parse(String(r.payload)) as Position;
        if (!p.attemptId) return p;
        const a = this.attempt(p.attemptId);
        return {
          ...p,
          entryComparison: {
            strategies: a?.summaries.strategies,
            ownershipClaim: this.buyOwnership(p.mint, p.mode, p.attemptId),
          },
        };
      });
  }
  managedPositions(mode?: Mode) {
    return this.positions(mode).filter((p) => !p.dismissal);
  }
  positionManaged(id: string, mode: Mode) {
    return !!this.managedPositions(mode).find((p) => p.id === id);
  }
  dismissPosition(id: string, mode: Mode) {
    return this.atomic(() => {
      const p = this.positions(mode).find((p) => p.id === id);
      if (!p) throw new Blocked("POSITION_NOT_FOUND");
      if (p.dismissal) return p;
      if (
        p.state !== "OPEN" ||
        this.pending().some((e) => e.intent.positionId === id)
      )
        throw new Blocked("POSITION_PENDING_RECONCILIATION_OR_EXECUTION");
      p.dismissal = {
        status: "MANUALLY_REMOVED",
        dismissedAt: Date.now(),
        dismissedBy: "USER",
        reason: "USER_MANUAL",
      };
      p.decisionRevision = (p.decisionRevision ?? 0) + 1;

      for (const r of this.activeManual(mode).filter(
        (r) => r.positionId === id,
      )) {
        r.state = "CANCELLED";
        this.saveManual(r);
      }
      this.savePosition(p);
      this.record("position_dismissals", p.mint, {
        positionId: id,
        ...p.dismissal,
      });
      return p;
    });
  }
  candidateAuthority(mint: string, mode: Mode) {
    return (
      this.get<{
        revision: number;
        sniperDismissedAt?: number;
        entryWatchDismissedAt?: number;
      }>(`candidateAuthority:${mode}:${mint}`) ?? { revision: 0 }
    );
  }
  dismissCandidate(mint: string, mode: Mode, entryWatch = false) {
    const old = this.candidateAuthority(mint, mode);
    const field = entryWatch ? "entryWatchDismissedAt" : "sniperDismissedAt";
    if (old[field]) return old;
    const next = { ...old, revision: old.revision + 1, [field]: Date.now() };
    this.set(`candidateAuthority:${mode}:${mint}`, next);
    this.record("watch_dismissals", mint, {
      ...next,
      dismissedBy: "USER",
      reason: "USER_MANUAL",
      mode,
    });
    return next;
  }
  assertEntryAuthority(
    mint: string,
    mode: Mode,
    authority: Intent["entryAuthority"],
  ) {
    const current = this.candidateAuthority(mint, mode);
    if (
      (!authority && current.revision > 0) ||
      (authority &&
        (authority.revision !== current.revision ||
          (authority.path === "SNIPER" && current.sniperDismissedAt) ||
          (authority.policy === "TRENDING_FINAL_STRUCTURE_V1" &&
            current.entryWatchDismissedAt)))
    )
      throw new CandidateRejected("TEMPORARY_RISK_CHANGE", {
        mint,
        reason: "CANDIDATE_AUTHORITY_REVOKED",
      });
  }
  execution(e: Execution): void {
    this.assertMode(e.intent.mode);
    if (this.sharedLearning && !this.db.isTransaction)
      return this.atomic(() => this.execution(e));
    const previous = this.db
      .prepare("SELECT state,payload FROM executions WHERE id=?")
      .get(e.id);
    const previousIntent = previous
      ? JSON.parse(String(previous.payload)).intent
      : undefined;
    if (
      previousIntent &&
      (previousIntent.mode !== e.intent.mode ||
        (e.intent.demoAccountId &&
          previousIntent.demoAccountId !== e.intent.demoAccountId))
    )
      throw new Blocked("EXECUTION_MODE_ACCOUNT_IMMUTABLE");
    if (e.intent.mode === "demo" && !e.intent.demoAccountId)
      e = {
        ...e,
        intent: {
          ...e.intent,
          demoAccountId: previousIntent?.demoAccountId ?? this.demoAccountId(),
        },
      };
    this.db
      .prepare(
        "INSERT INTO executions VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,signature=excluded.signature,payload=excluded.payload",
      )
      .run(e.id, e.intent.id, e.state, e.signature ?? null, json(e));
    if (this.sharedLearning)
      this.db
        .prepare("INSERT OR IGNORE INTO learning_outbox VALUES(?,?,?,?,NULL)")
        .run(randomUUID(), "EXECUTION", Date.now(), json(e));
    this.syncManual(e);
    if (e.intent.side === "SELL") {
      const p = this.positions(e.intent.mode).find(
          (x) => x.id === e.intent.positionId,
        ),
        o = p?.pendingExits?.find((x) => x.id === e.intent.exitOpportunityId);
      if (p && o) {
        if (
          e.state === "FAILED" &&
          o.retry?.classification === "SIGNED_UNKNOWN"
        )
          delete o.retry;
        o.lifecycle =
          e.state === "CONFIRMED"
            ? "COMPLETED"
            : e.signature && e.state !== "FAILED"
              ? "RECONCILING"
              : e.state === "FAILED"
                ? "BLOCKED"
                : "WAITING_EXECUTION";
        this.savePosition(p);
      }
      if (previous?.state !== e.state)
        this.pipelineEvent(
          e.state === "CONFIRMED"
            ? "EXIT_COMPLETED"
            : e.state === "UNKNOWN"
              ? "EXIT_UNKNOWN_TX"
              : e.signature
                ? "EXIT_RECONCILING"
                : "EXIT_" + e.state,
          e.intent.mint,
          {
            positionId: e.intent.positionId,
            executionId: e.id,
            signature: e.signature,
          },
        );
    }
    if (e.intent.side === "BUY" && previous?.state !== e.state)
      this.pipelineEvent(
        e.state === "CREATED" ? "BUYING" : "BUY_" + e.state,
        e.intent.mint,
        {
          from: previous?.state ?? "APPROVED",
          to: e.state,
          signature: e.signature,
          executionId: e.id,
          reason: e.error,
        },
      );
  }
  executions(mode: Mode = this.mode): Execution[] {
    return this.db
      .prepare(
        "SELECT payload FROM executions WHERE json_extract(payload,'$.intent.mode')=? AND (?<>'demo' OR json_extract(payload,'$.intent.demoAccountId')=?)",
      )
      .all(mode, mode, this.demoAccountId())
      .map((r) => JSON.parse(String(r.payload)));
  }
  manualRequests(mode?: Mode): ManualExitRequest[] {
    return this.db
      .prepare(
        "SELECT payload FROM manual_exits" + (mode ? " WHERE mode=?" : ""),
      )
      .all(...(mode ? [mode] : []))
      .map((r) => JSON.parse(String(r.payload)));
  }
  saveManual(r: ManualExitRequest) {
    this.db
      .prepare(
        "INSERT INTO manual_exits VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,payload=excluded.payload",
      )
      .run(r.id, r.positionId, r.mode, r.state, json(r));
  }
  migrateSellSafetyV2(maxAgeMs: number) {
    if (this.get("sellSafetyV2Migration")) return;
    this.atomic(() => {
      for (const p of this.positions().filter((p) =>
        ["OPEN", "PENDING_EXIT"].includes(p.state),
      )) {
        const removed: ExitOpportunity[] = [];
        p.pendingExits = p.pendingExits?.filter((o) => {
          if (o.kind !== "PROTECTIVE" || o.protection) return true;
          // Translate legacy labels once. V2 resolution never authorizes by label.
          const kind = /smart.?money/i.test(o.reason)
            ? null
            : /critical.*security/i.test(o.reason)
              ? "SECURITY_CRITICAL"
              : /liquidity/i.test(o.reason)
                ? "LIQUIDITY_COLLAPSE"
                : null;
          if (!kind) {
            o.lifecycle = "SUPERSEDED";
            removed.push(o);
            return false;
          }
          o.protection = {
            version: "EXIT_SAFETY_V2",
            kind,
            severity: kind === "SECURITY_CRITICAL" ? "CRITICAL" : "HIGH",
            action: "FULL_SELL",
            sellBps: 10000,
            quantity: p.quantity,
            observedAt: o.triggeredAt,
            expiresAt: o.triggeredAt + maxAgeMs,
            reason: o.reason,
            evidence: { source: "LEGACY_RECORD_REQUIRES_REVALIDATION" },
            limitations: [
              "Legacy predicate must be refreshed; no synthetic freshness",
            ],
          };
          o.lifecycle = "DETECTED";
          return true;
        });
        if (removed.length) {
          p.legacyExitReferences = [
            ...(p.legacyExitReferences ?? []),
            ...removed,
          ];
          p.decisionRevision = (p.decisionRevision ?? 0) + 1;
        }
        this.savePosition(p);
      }
      this.set("sellSafetyV2Migration", true);
    });
  }
  saveObservation(p: Position): Position | undefined {
    const current = this.positions(p.mode).find((x) => x.id === p.id);
    if (
      !current ||
      current.dismissal ||
      current.state !== p.state ||
      current.quantity !== p.quantity ||
      current.remainingCostLamports !== p.remainingCostLamports
    )
      return;
    const merged = {
      ...current,
      marketRevision: (current.marketRevision ?? 0) + 1,
      marketUpdatedAt: p.lastQuoteAt,
      updatedAt: Date.now(),
      lastValueLamports: p.lastValueLamports,
      lastQuoteAt: p.lastQuoteAt,
      valuationQuantity: p.valuationQuantity,
      valuationStatus: p.valuationStatus,
      highWaterLamports: p.highWaterLamports,
      mfePercent: p.mfePercent,
      maePercent: p.maePercent,
      grossMfePercent: p.grossMfePercent,
      grossMaePercent: p.grossMaePercent,
      grossHighWaterLamports: p.grossHighWaterLamports,
      monitoring: p.monitoring,
    };
    if (
      merged.monitoring?.status === "ACTIVE" &&
      merged.attention?.issue.stage === "POSITION_MONITOR" &&
      merged.attention.issue.scope === "POSITION"
    )
      delete merged.attention;
    this.savePosition(merged);
    return merged;
  }
  activeManual(mode: Mode) {
    return this.manualRequests(mode).filter((r) =>
      ["REQUESTED", "CLAIMED", "SUBMITTED", "FAILED_RETRYABLE"].includes(
        r.state,
      ),
    );
  }
  migrateManualRequests() {
    if (this.get("manualExitMigrationV1")) return;
    this.atomic(() => {
      for (const v of this.get<
        Array<string | { positionId: string; sellBps: number }>
      >("manualExitRequests") ?? []) {
        const legacy =
          typeof v === "string" ? { positionId: v, sellBps: 10000 } : v;
        const p = this.positions().find((p) => p.id === legacy.positionId);
        if (!p) continue;
        const linked = this.executions()
          .filter(
            (e) =>
              e.intent.positionId === p.id &&
              e.intent.side === "SELL" &&
              /manual/i.test(e.intent.reason),
          )
          .sort((a, b) => b.intent.createdAt - a.intent.createdAt)[0];
        this.saveManual({
          id: randomUUID(),
          positionId: p.id,
          mode: p.mode,
          sellBps: legacy.sellBps,
          createdAt: Date.now(),
          state:
            linked?.state === "CONFIRMED"
              ? "CONFIRMED"
              : linked?.signature &&
                  this.pending().some((e) => e.id === linked.id)
                ? "SUBMITTED"
                : linked
                  ? "REVIEW_REQUIRED"
                  : p.state === "OPEN"
                    ? "REQUESTED"
                    : "REVIEW_REQUIRED",
          executionId: linked?.id,
          signature: linked?.signature,
          amount: linked?.intent.amount,
        });
      }
      this.set("manualExitMigrationV1", true);
    });
  }
  migrateExitOpportunities() {
    if (this.get("exitOpportunityMigrationV1")) return;
    this.atomic(() => {
      for (const p of this.positions().filter(
        (p) =>
          p.state === "OPEN" &&
          p.attention?.issue.stage === "PRE_SELL" &&
          p.pendingExits === undefined,
      )) {
        const failed = this.executions()
          .filter(
            (e) =>
              e.intent.positionId === p.id &&
              e.intent.side === "SELL" &&
              e.state === "FAILED" &&
              !e.signature,
          )
          .sort((a, b) => b.intent.createdAt - a.intent.createdAt)[0];
        if (!failed || /manual|holding time/i.test(failed.intent.reason))
          continue;
        const kind: ExitOpportunity["kind"] | undefined =
          failed.intent.takeProfitIndex !== undefined
            ? "TAKE_PROFIT"
            : /security|liquidity|smart-money/i.test(failed.intent.reason)
              ? "PROTECTIVE"
              : /trailing profit/i.test(failed.intent.reason)
                ? "TRAILING"
                : undefined;
        if (!kind) continue;
        const amount = BigInt(p.quantity);
        if (amount <= 0n) continue;
        const configured = this.get<{
          takeProfits: Array<{ sellBps: number }>;
        }>("strategyV2");
        const bps =
          kind === "TAKE_PROFIT"
            ? configured?.takeProfits[failed.intent.takeProfitIndex!]?.sellBps
            : 10000;
        if (!bps) continue;
        p.pendingExits = [
          {
            id: randomUUID(),
            kind,
            reason: failed.intent.reason,
            sellBps: bps,
            takeProfitIndex: failed.intent.takeProfitIndex,
            triggeredAt: failed.intent.createdAt,
          },
        ];
        this.savePosition(p);
      }
      this.set("exitOpportunityMigrationV1", true);
    });
  }
  private syncManual(e: Execution) {
    const request = this.manualRequests().find(
      (r) => r.executionId === e.id || r.id === e.intent.manualRequestId,
    );
    if (!request) return;
    request.executionId = e.id;
    request.signature = e.signature;
    if (e.state === "CONFIRMED") request.state = "CONFIRMED";
    else if (
      ["SUBMITTED", "UNKNOWN", "PENDING_CONFIRMATION", "AMBIGUOUS"].includes(
        e.state,
      )
    )
      request.state = "SUBMITTED";
    else if (e.state === "FAILED") {
      request.state = e.signature ? "FAILED_FINAL" : "FAILED_RETRYABLE";
      request.error = e.error;
    }
    this.saveManual(request);
  }
  pending() {
    return this.executions().filter((e) =>
      [
        "CREATED",
        "SUBMITTED",
        "PENDING_CONFIRMATION",
        "UNKNOWN",
        "AMBIGUOUS",
      ].includes(e.state),
    );
  }
  reserved(mode: Mode) {
    return this.pending()
      .filter((e) => e.intent.mode === mode && e.intent.side === "BUY")
      .reduce((n, e) => n + BigInt(e.intent.amount), 0n);
  }
  bought(mint: string, mode: Mode) {
    return (
      !!this.db
        .prepare(
          "SELECT id FROM executions WHERE json_extract(payload,'$.intent.mint')=? AND json_extract(payload,'$.intent.mode')=? AND json_extract(payload,'$.intent.side')='BUY' AND (state!='FAILED' OR signature IS NOT NULL) LIMIT 1",
        )
        .get(mint, mode) ||
      !!this.db
        .prepare(
          "SELECT id FROM positions WHERE mode=? AND mint=? AND state!='FAILED' LIMIT 1",
        )
        .get(mode, mint)
    );
  }
  buyOwnership(
    mint: string,
    mode: Mode,
    attemptId?: string,
  ): BuyOwnershipClaim | undefined {
    const row = attemptId
      ? this.db
          .prepare(
            "SELECT payload FROM buy_ownership_claims WHERE mode=? AND mint=? AND attempt_id=?",
          )
          .get(mode, mint, attemptId)
      : this.db
          .prepare(
            "SELECT payload FROM buy_ownership_claims WHERE mode=? AND mint=? AND active=1",
          )
          .get(mode, mint);
    return row ? JSON.parse(String(row.payload)) : undefined;
  }
  claimMintForBuy(
    input: Pick<
      BuyOwnershipClaim,
      "mode" | "mint" | "attemptId" | "strategy" | "decisionId" | "decisionAt"
    >,
    authority: Snapshot["entryAuthority"],
  ):
    | { claimed: true; claim: BuyOwnershipClaim }
    | {
        claimed: false;
        owner: Strategy;
        reason: string;
        claim?: BuyOwnershipClaim;
      } {
    return this.atomic(() => {
      if (input.strategy !== "KRONOS") throw new Blocked("KRONOS_ONLY");
      const previous =
        this.buyOwnership(input.mint, input.mode, input.attemptId) ??
        this.buyOwnership(input.mint, input.mode);
      if (previous)
        return {
          claimed: false,
          owner: previous.strategy,
          reason: "OWNED_BY_" + previous.strategy,
          claim: previous,
        };
      this.assertEntryAuthority(input.mint, input.mode, authority);
      if (!this.entriesEnabled()) throw new Blocked("ENTRY_CONTROL_DISABLED");
      if (
        !input.attemptId ||
        !input.decisionId ||
        !Number.isFinite(input.decisionAt) ||
        input.decisionAt > Date.now()
      )
        throw new Blocked("INVALID_BUY_CLAIM");
      if (this.entryBlocked(input.mint, input.mode)) {
        const owner =
          this.positions(input.mode).find(
            (p) =>
              p.mint === input.mint && !["CLOSED", "FAILED"].includes(p.state),
          )?.strategy ??
          this.pending().find(
            (e) => e.intent.mint === input.mint && e.intent.mode === input.mode,
          )?.intent.strategy ??
          "STANDARD";
        return { claimed: false, owner, reason: "OWNED_BY_" + owner };
      }
      const claim: BuyOwnershipClaim = {
        ...input,
        id: randomUUID(),
        claimedAt: Date.now(),
        active: true,
        reason: "FIRST_BUY_CLAIM",
      };
      this.db
        .prepare("INSERT INTO buy_ownership_claims VALUES(?,?,?,?,?,?)")
        .run(claim.id, claim.mode, claim.mint, claim.attemptId, 1, json(claim));
      this.pipelineEvent("OWNERSHIP_CLAIM_SUCCESS", claim.mint, {
        ...claim,
        owner: claim.strategy,
      });
      return { claimed: true, claim };
    });
  }
  assertBuyOwnership(i: Intent) {
    if (i.side !== "BUY") return;
    if (i.strategy !== "KRONOS") throw new Blocked("KRONOS_ONLY");
    const active = this.buyOwnership(i.mint, i.mode);
    if (!i.ownershipClaimId) {
      if (active || i.entryAuthority?.policy === "TRENDING_ONE_SHOT_V1")
        throw new Blocked("BUY_OWNERSHIP_CLAIM_REQUIRED");
      return;
    }
    if (
      !active ||
      active.id !== i.ownershipClaimId ||
      active.strategy !== (i.strategy ?? "STANDARD") ||
      active.attemptId !== i.attemptId ||
      active.decisionId !== i.decisionId
    )
      throw new Blocked("BUY_OWNERSHIP_CLAIM_MISMATCH");
  }
  private resolveBuyOwnership(
    id: string,
    resolution: NonNullable<BuyOwnershipClaim["resolution"]>,
  ) {
    const row = this.db
      .prepare(
        "SELECT payload FROM buy_ownership_claims WHERE id=? AND active=1",
      )
      .get(id);
    if (!row) return;
    const claim: BuyOwnershipClaim = {
      ...JSON.parse(String(row.payload)),
      active: false,
      resolution,
    };
    this.db
      .prepare(
        "UPDATE buy_ownership_claims SET active=0,payload=? WHERE id=? AND active=1",
      )
      .run(json(claim), id);
  }
  finishBuyOwnership(mint: string, mode: Mode, attemptId: string) {
    this.atomic(() => {
      const claim = this.buyOwnership(mint, mode, attemptId);
      if (!claim?.active) return;
      const executions = this.executions().filter(
        (e) => e.intent.ownershipClaimId === claim.id,
      );
      const positions = this.positions(mode).filter(
        (p) => p.ownershipClaimId === claim.id,
      );
      if (
        executions.some((e) => e.signature || e.state !== "FAILED") ||
        positions.some((p) => !["FAILED", "CLOSED"].includes(p.state))
      )
        return;
      this.resolveBuyOwnership(claim.id, "FAILED_UNSIGNED");
    });
  }
  entryBlocked(
    mint: string,
    mode: Mode,
    excludeIntentId?: string,
    excludeClaimId?: string,
  ) {
    const claim = this.buyOwnership(mint, mode);
    const own = excludeIntentId
      ? this.executions().find((e) => e.intent.id === excludeIntentId)?.intent
          .positionId
      : undefined;
    return (
      (!!claim && claim.id !== excludeClaimId) ||
      this.positions(mode).some(
        (p) =>
          p.id !== own &&
          p.mint === mint &&
          !["CLOSED", "FAILED"].includes(p.state),
      ) ||
      this.executions().some(
        (e) =>
          e.intent.mint === mint &&
          e.intent.mode === mode &&
          e.intent.side === "BUY" &&
          e.intent.id !== excludeIntentId &&
          e.state !== "CONFIRMED" &&
          (e.state !== "FAILED" || !!e.signature),
      )
    );
  }
  claim(i: Intent, capital?: { balance: bigint; reserve: bigint }): Execution {
    this.assertMode(i.mode);
    i = structuredClone(i);
    return this.atomic(() => {
      if (i.mode === "demo") i.demoAccountId = this.demoAccountId();
      if (i.side === "BUY")
        this.assertEntryAuthority(i.mint, i.mode, i.entryAuthority);
      if (i.side === "BUY") this.assertBuyOwnership(i);
      if (
        i.side === "BUY" &&
        i.ownershipClaimId &&
        this.executions().some(
          (e) =>
            e.intent.side === "BUY" &&
            e.intent.ownershipClaimId === i.ownershipClaimId,
        )
      )
        throw new Blocked("BUY_CLAIM_EXECUTION_ALREADY_CREATED");
      if (
        i.side === "BUY" &&
        (i.entryAuthority?.policy === "TRENDING_ONE_SHOT_V1"
          ? this.entryBlocked(i.mint, i.mode, undefined, i.ownershipClaimId)
          : this.bought(i.mint, i.mode))
      )
        throw new Blocked("Duplicate BUY for owned or unresolved mint");
      if (this.pending().some((e) => e.intent.mode === i.mode && e.signature))
        throw new Blocked("Unresolved wallet transaction; execution frozen");
      if (i.side === "SELL") {
        const owner = this.positions(i.mode).find((p) => p.id === i.positionId);
        if (!owner) throw new Blocked("SELL_POSITION_MISSING");
        if (i.decisionSource === "CODEX" || i.exitAuthority === "CODEX") {
          const proof = this.learningDb
            .prepare(
              "SELECT payload FROM chart_decisions WHERE id=? AND position_id=? AND mode=? AND action='SELL'",
            )
            .get(i.decisionId ?? "", owner.id, owner.mode);
          if (
            !proof ||
            String(proof.payload) !== JSON.stringify(owner.codexDecision)
          )
            throw new Blocked("CODEX_PERSISTED_EXIT_PROOF_REQUIRED");
        }
        assertStrategySell(i, owner);
      }
      if (i.side === "SELL" && !this.positionManaged(i.positionId, i.mode))
        throw new Blocked("POSITION_MANUALLY_REMOVED");
      if (i.side === "BUY") {
        if (this.pending().some((e) => e.intent.mode === i.mode && e.signature))
          throw new Blocked("Unresolved signed transaction blocks new BUY");
        if (capital) {
          const available =
            capital.balance - capital.reserve - this.reserved(i.mode);
          if (
            available <= 0n ||
            BigInt(i.amount) <= 0n ||
            BigInt(i.amount) > available
          )
            throw new CandidateRejected("TEMPORARY_RISK_CHANGE", {
              reason: "WAITING_FOR_CAPITAL: INSUFFICIENT_SPENDABLE_BALANCE",
            });
          const sizing = this.get<PositionSizing>("strategyV2") ?? {};
          if (
            !positionSizeMatches(i, sizing) ||
            BigInt(i.amount) !==
              size(
                capital.balance,
                capital.reserve,
                this.reserved(i.mode),
                sizing,
              ).amount
          )
            throw new CandidateRejected("TEMPORARY_RISK_CHANGE", {
              reason: "EXACT_SIZE_CHANGED",
            });
        }
      }
      if (this.db.prepare("SELECT id FROM intents WHERE key=?").get(i.key))
        throw new Blocked("Duplicate trade intent");
      if (
        this.pending().some(
          (e) => e.intent.mode === i.mode && e.intent.mint === i.mint,
        )
      )
        throw new Blocked("Token already has a pending trade");
      this.db
        .prepare("INSERT INTO intents VALUES(?,?,?)")
        .run(i.id, i.key, json(i));
      const e: Execution = {
        id: randomUUID(),
        intent: i,
        state: "CREATED",
        at: Date.now(),
      };
      if (i.manualRequestId) {
        const r = this.manualRequests(i.mode).find(
          (r) => r.id === i.manualRequestId,
        );
        const p = this.positions(i.mode).find((p) => p.id === i.positionId);
        if (
          !r ||
          !p ||
          r.positionId !== p.id ||
          !["REQUESTED", "FAILED_RETRYABLE"].includes(r.state)
        )
          throw new CandidateRejected("TEMPORARY_RISK_CHANGE", {
            reason: "MANUAL_REQUEST_ALREADY_CLAIMED",
          });
        r.baseQuantity ??= p.quantity;
        r.amount ??= (
          (BigInt(r.baseQuantity) * BigInt(r.sellBps)) /
          10000n
        ).toString();
        if (r.amount !== i.amount)
          throw new Blocked("MANUAL_REQUEST_AMOUNT_MISMATCH");
        r.state = "CLAIMED";
        r.executionId = e.id;
        this.saveManual(r);
      }
      this.execution(e);
      if (i.side === "BUY")
        this.savePosition({
          id: i.positionId,
          demoAccountId: i.demoAccountId,
          strategy: i.strategy ?? "STANDARD",
          attemptId: i.attemptId,
          ownershipClaimId: i.ownershipClaimId,
          decisionSource: i.decisionSource,
          decisionId: i.decisionId,
          decisionAt: i.decisionAt,
          provider: i.provider,
          mint: i.mint,
          mode: i.mode,
          state: "PENDING_ENTRY",
          quantity: "0",
          originalQuantity: "0",
          costLamports: "0",
          remainingCostLamports: "0",
          realizedLamports: "0",
          entryAt: Date.now(),
          highWaterLamports: "0",
          takenProfits: [],
        });
      else {
        const p = this.positions(i.mode).find((p) => p.id === i.positionId);
        if (!p || p.state !== "OPEN") throw new Blocked("Position is not open");
        p.state = "PENDING_EXIT";
        this.savePosition(p);
      }
      return e;
    });
  }
  count(kind: string, since = 0, distinctMint = false) {
    const aggregate = distinctMint ? "count(DISTINCT mint)" : "count(*)";
    if (!this.scopedRecords && this.mode === "demo") return 0;
    const scope = this.scopedRecords
      ? " AND COALESCE(scope_mode,json_extract(payload,'$.mode'),'live')=? AND (?<>'demo' OR scope_account=?)"
      : "";
    const args = this.scopedRecords
      ? [kind, since, this.mode, this.mode, this.demoAccountId()]
      : [kind, since];
    return Number(
      this.db
        .prepare(
          "SELECT " +
            aggregate +
            " n FROM records WHERE kind=? AND at>=?" +
            scope,
        )
        .get(...args)?.n ?? 0,
    );
  }
  tokenCount() {
    return this.scopedTokens
      ? Number(
          this.db
            .prepare("SELECT count(*) n FROM mode_tokens WHERE mode=?")
            .get(this.mode)?.n ?? 0,
        )
      : this.mode === "demo"
        ? 0
        : Number(
            this.db.prepare("SELECT count(*) n FROM tokens").get()?.n ?? 0,
          );
  }
  close() {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
}
