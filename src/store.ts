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
  type JevExitDecision,
  type BuyOwnershipClaim,
  type Snapshot,
  type Strategy,
} from "./domain.js";
import { json } from "./util.js";
import { learningMigration } from "./learning-schema.js";
import { mergeDiscovery } from "./discovery.js";
import {
  size,
  positionSizeMatches,
  type PositionSizing,
} from "./position-sizing.js";
export class Store {
  private exitRetentionWrites = 0;
  readonly db: DatabaseSync;
  constructor(path: string, options: { readOnly?: boolean } = {}) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, { readOnly: options.readOnly ?? false });
    if (options.readOnly) {
      this.db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000;");
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
    this.db.exec(learningMigration);
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
  get<T>(key: string): T | undefined {
    const r = this.db
      .prepare("SELECT payload FROM settings WHERE key=?")
      .get(key);
    return r ? JSON.parse(String(r.payload)) : undefined;
  }
  set(key: string, v: unknown) {
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
  halt(reason: string, scope: "SYSTEM" | "TRANSACTION" = "SYSTEM") {
    this.metric("systemFailures");
    if (this.entriesEnabled()) this.metric("globalEntryPauses");
    this.set("newEntriesEnabled", false);
    this.set("haltReason", reason);
    this.set("haltScope", scope);
    this.record("events", undefined, { type: "ERROR", reason, scope });
  }
  record(kind: string, mint: string | undefined, payload: unknown) {
    this.db
      .prepare("INSERT INTO records(kind,mint,payload,at) VALUES(?,?,?,?)")
      .run(kind, mint ?? null, json(payload), Date.now());
  }
  event(type: string, mint?: string, reason?: string) {
    this.record("events", mint, { type, reason, mode: env.TRADING_MODE });
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
      mode: env.TRADING_MODE,
      at: Date.now(),
    });
  }
  latest<T>(kind: string, mint: string): T | undefined {
    const r = this.db
      .prepare(
        "SELECT payload FROM records WHERE kind=? AND mint=? ORDER BY id DESC LIMIT 1",
      )
      .get(kind, mint);
    return r ? JSON.parse(String(r.payload)) : undefined;
  }
  recent(kind: string, limit = 100) {
    return this.db
      .prepare(
        "SELECT mint,payload,at FROM records WHERE kind=? ORDER BY id DESC LIMIT ?",
      )
      .all(kind, limit)
      .map((r) => ({ ...r, payload: JSON.parse(String(r.payload)) }));
  }
  trace(mint: string) {
    return this.db
      .prepare(
        "SELECT kind,payload,at FROM records WHERE mint=? ORDER BY id DESC LIMIT 100",
      )
      .all(mint)
      .map((r) => ({ ...r, payload: JSON.parse(String(r.payload)) }));
  }
  discover(c: Candidate) {
    return this.atomic(() => {
      const old = this.token(c.mint);
      this.db
        .prepare(
          "INSERT INTO tokens(mint,payload,at) VALUES(?,?,?) ON CONFLICT(mint) DO UPDATE SET payload=excluded.payload",
        )
        .run(
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
  enqueueTrending(candidates: Candidate[], mode = env.TRADING_MODE) {
    const key = "oneShotAppearanceWatermark:" + mode;
    const watermark = this.get<number>(key) ?? 0;
    let newest = watermark;
    this.atomic(() => {
      for (const c of candidates) {
        const seen = c.discovery?.trending?.lastSeenAt;
        if (seen === undefined || seen <= watermark) continue;
        this.db
          .prepare(
            "INSERT OR IGNORE INTO trending_appearances(mode,mint,seen_at,payload) VALUES(?,?,?,?)",
          )
          .run(mode, c.mint, seen, JSON.stringify(c));
        newest = Math.max(newest, seen);
      }
      if (newest > watermark) this.set(key, newest);
    });
  }
  token(mint: string): Candidate | undefined {
    const r = this.db
      .prepare("SELECT payload FROM tokens WHERE mint=?")
      .get(mint);
    return r ? withTokenLogo(JSON.parse(String(r.payload))) : undefined;
  }
  tokens(): Candidate[] {
    return this.db
      .prepare("SELECT payload FROM tokens ORDER BY at DESC LIMIT 250")
      .all()
      .map((r) => withTokenLogo(JSON.parse(String(r.payload))));
  }
  savePosition(p: Position) {
    const old = this.db
      .prepare("SELECT payload FROM positions WHERE id=?")
      .get(p.id);
    const prior: Position | undefined = old
      ? JSON.parse(String(old.payload))
      : undefined;
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
    if (p.ownershipClaimId && p.state === "CLOSED" && BigInt(p.quantity) === 0n)
      this.resolveBuyOwnership(p.ownershipClaimId, "CLOSED");
  }
  positions(mode?: Mode): Position[] {
    return this.db
      .prepare("SELECT payload FROM positions" + (mode ? " WHERE mode=?" : ""))
      .all(...(mode ? [mode] : []))
      .map((r) => JSON.parse(String(r.payload)));
  }
  /** History uses Position opening time, never observation or exit time. */
  attempt(
    id: string,
  ): import("./candidate-attempt.js").CandidateAttempt | undefined {
    const row = this.db
      .prepare("SELECT payload FROM candidate_attempts WHERE id=?")
      .get(id);
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
    return this.db
      .prepare(
        "SELECT payload FROM positions WHERE mode=? AND state=? AND CAST(json_extract(payload,'$.originalQuantity') AS INTEGER)>0" +
          (options.strategy
            ? " AND COALESCE(json_extract(payload,'$.strategy'),'STANDARD')=?"
            : "") +
          " ORDER BY CAST(json_extract(payload,'$.entryAt') AS INTEGER) DESC,id DESC LIMIT ? OFFSET ?",
      )
      .all(
        mode,
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
      if (p.jevExit) {
        p.jevExit.status = "CANCELLED";
        this.saveJevExit(p.jevExit);
      }
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
  execution(e: Execution) {
    const previous = this.db
      .prepare("SELECT state FROM executions WHERE id=?")
      .get(e.id);
    this.db
      .prepare(
        "INSERT INTO executions VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,signature=excluded.signature,payload=excluded.payload",
      )
      .run(e.id, e.intent.id, e.state, e.signature ?? null, json(e));
    this.syncManual(e);
    this.syncJevExit(e);
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
  executions(): Execution[] {
    return this.db
      .prepare("SELECT payload FROM executions")
      .all()
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
  saveJevExit(d: JevExitDecision) {
    this.db
      .prepare(
        "INSERT INTO jev_exit_decisions VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,payload=excluded.payload",
      )
      .run(d.id, d.positionId, d.status, json(d));
    if (d.observedFlow && ++this.exitRetentionWrites % 20 === 0) {
      this.db
        .prepare(
          "DELETE FROM jev_exit_decisions WHERE id IN (SELECT d.id FROM jev_exit_decisions d WHERE d.position_id=? AND json_extract(d.payload,'$.observedFlow') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM executions e WHERE json_extract(e.payload,'$.intent.jevExitDecisionId')=d.id) ORDER BY json_extract(d.payload,'$.createdAt') DESC LIMIT -1 OFFSET 256)",
        )
        .run(d.positionId);
      this.db
        .prepare(
          "DELETE FROM records WHERE id IN (SELECT r.id FROM records r WHERE r.kind='jev_exit_context' AND json_extract(r.payload,'$.decision.positionId')=? AND json_extract(r.payload,'$.policyVersion')='CAPITAL_FLOW_V1' AND NOT EXISTS (SELECT 1 FROM executions e WHERE json_extract(e.payload,'$.intent.jevExitDecisionId')=json_extract(r.payload,'$.decision.id')) ORDER BY r.id DESC LIMIT -1 OFFSET 128)",
        )
        .run(d.positionId);
    }
  }
  jevExits(): JevExitDecision[] {
    return this.db
      .prepare("SELECT payload FROM jev_exit_decisions")
      .all()
      .map((r) => JSON.parse(String(r.payload)));
  }
  jevExit(id: string): JevExitDecision | undefined {
    const row = this.db
      .prepare("SELECT payload FROM jev_exit_decisions WHERE id=?")
      .get(id);
    return row ? JSON.parse(String(row.payload)) : undefined;
  }
  migrateJevExitPolicy() {
    if (this.get("jevExitPolicyV1")) return;
    this.atomic(() => {
      for (const p of this.positions().filter(
        (p) => !["CLOSED", "FAILED"].includes(p.state),
      )) {
        const references =
          p.pendingExits?.filter((x) =>
            ["TAKE_PROFIT", "TRAILING"].includes(x.kind),
          ) ?? [];
        if (!references.length) continue;
        p.legacyExitReferences = [
          ...(p.legacyExitReferences ?? []),
          ...references,
        ];
        p.pendingExits = p.pendingExits!.filter((x) => !references.includes(x));
        this.savePosition(p);
        this.record("exit_policy_migration", p.mint, {
          positionId: p.id,
          policy: "JEV",
          legacyReferences: references,
        });
      }
      this.set("jevExitPolicyV1", true);
    });
  }
  migrateSellSafetyV2(maxAgeMs: number) {
    if (this.get("sellSafetyV2Migration")) return;
    this.atomic(() => {
      for (const p of this.positions().filter((p) =>
        ["OPEN", "PENDING_EXIT"].includes(p.state),
      )) {
        if (p.jevExit?.action === "HOLD" && !p.jevExit.decisionState) {
          const legacy = structuredClone(p.jevExit);
          p.lastAnalystAttempt = {
            ...legacy,
            action: "NO_DECISION",
            decisionState: "NO_DECISION_INSUFFICIENT_DATA",
            reason: "LEGACY_ANALYST_RESPONSE_REQUIRES_FRESH_REVIEW",
            status: "FAILED",
            analystResponse: legacy,
          };
          this.saveJevExit(p.lastAnalystAttempt);
          delete p.jevExit;
        }
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
  private syncJevExit(e: Execution) {
    if (!e.intent.jevExitDecisionId) return;
    const decision = this.jevExit(e.intent.jevExitDecisionId);
    if (!decision) throw new Blocked("JEV_EXIT_DECISION_MISSING");
    decision.status =
      e.state === "CONFIRMED"
        ? "CONFIRMED"
        : e.state === "FAILED"
          ? "BACKOFF"
          : "EXECUTING";
    this.saveJevExit(decision);
    const p = this.positions(e.intent.mode).find(
      (p) => p.id === e.intent.positionId,
    );
    if (p?.jevExit?.id === decision.id) {
      p.jevExit = decision;
      if (e.state === "CONFIRMED")
        p.lastStrategicExit = {
          at: e.at,
          decisionId: decision.id,
          flowSignalKey: decision.flowSignalKey,
          pnlPercent: decision.observed?.pnlPercent,
          grossPnlKnown: decision.observed?.grossPnlKnown,
        };
      this.savePosition(p);
    }
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
    return this.atomic(() => {
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
  count(kind: string) {
    return Number(
      this.db.prepare("SELECT count(*) n FROM records WHERE kind=?").get(kind)
        ?.n ?? 0,
    );
  }
  close() {
    this.db.close();
  }
}
