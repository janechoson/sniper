import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { type LabTrial, type LabDecision } from "./kronos-domain.js";
import { tokenLogo } from "./token-metadata.js";
import { localPath } from "./config.js";
/** Dedicated database, never a production Store. Caller supplies isolated path. */
export class KronosStore {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") localPath(path);
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db
      .exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS lab_trials(id TEXT PRIMARY KEY,mint TEXT NOT NULL,appearance TEXT NOT NULL UNIQUE,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS lab_decisions(id INTEGER PRIMARY KEY,trial_id TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS lab_events(id INTEGER PRIMARY KEY,at INTEGER NOT NULL,kind TEXT NOT NULL,trial_id TEXT,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS lab_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
    this.db.exec(
      "PRAGMA busy_timeout=5000; CREATE INDEX IF NOT EXISTS lab_trials_mint ON lab_trials(mint); CREATE INDEX IF NOT EXISTS lab_trials_state_due ON lab_trials(json_extract(payload,'$.status'),json_extract(payload,'$.nextAt')); CREATE INDEX IF NOT EXISTS lab_trials_pnl ON lab_trials(json_extract(payload,'$.status'),json_extract(payload,'$.pnlPct')); CREATE INDEX IF NOT EXISTS lab_trials_closed ON lab_trials(json_extract(payload,'$.status'),json_extract(payload,'$.exit.observedAt')); CREATE INDEX IF NOT EXISTS lab_events_trial ON lab_events(trial_id,id); CREATE INDEX IF NOT EXISTS lab_decisions_trial ON lab_decisions(trial_id,id);",
    );
  }
  private decode(rows: unknown[]): LabTrial[] {
    return rows.map((r) => {
      const t = JSON.parse((r as { payload: string }).payload);
      return { ...t, logo: tokenLogo(t) };
    });
  }
  trial(id: string) {
    return this.decode(
      this.db.prepare("SELECT payload FROM lab_trials WHERE id=?").all(id),
    )[0];
  }
  count() {
    return Number(
      this.db.prepare("SELECT count(*) n FROM lab_trials").get()!.n,
    );
  }
  due(open: boolean, now = Date.now(), mode = "PAPER") {
    return this.decode(
      this.db
        .prepare(
          "SELECT payload FROM lab_trials WHERE COALESCE(json_extract(payload,'$.mode'),'PAPER')=? AND json_extract(payload,'$.status') IN ('ANALYZING','WAIT_BUY','OPEN','SELL_DECIDED_PRICE_PENDING') AND COALESCE(json_type(payload,'$.entry')='object',0)=? AND json_extract(payload,'$.nextAt')<=? ORDER BY json_extract(payload,'$.nextAt'),rowid LIMIT 1",
        )
        .all(mode, open ? 1 : 0, now),
    )[0];
  }
  queueDepth(now = Date.now()) {
    return Number(
      this.db
        .prepare(
          "SELECT count(*) n FROM lab_trials WHERE json_extract(payload,'$.status') IN ('ANALYZING','WAIT_BUY','OPEN','SELL_DECIDED_PRICE_PENDING') AND json_extract(payload,'$.nextAt')<=?",
        )
        .get(now)!.n,
    );
  }
  page(
    options: {
      cursor?: number;
      limit?: number;
      state?: string;
      openOnly?: boolean;
      activeOnly?: boolean;
      mode?: string;
    } = {},
  ) {
    const limit = Math.max(
      1,
      Math.min(100, Math.trunc(options.limit ?? 50) || 50),
    );
    const where: string[] = [],
      params: Array<string | number> = [];
    if (options.mode && options.mode !== "ALL") {
      if (!["PAPER", "LIVE"].includes(options.mode))
        throw Error("INVALID_MODE_FILTER");
      where.push("COALESCE(json_extract(payload,'$.mode'),'PAPER')=?");
      params.push(options.mode);
    }
    if (options.cursor) {
      where.push("rowid<?");
      params.push(options.cursor);
    }
    if (options.openOnly)
      where.push(
        "json_extract(payload,'$.status') IN ('OPEN','SELL_DECIDED_PRICE_PENDING') AND json_type(payload,'$.entry')='object'",
      );
    else if (options.activeOnly)
      where.push(
        "json_extract(payload,'$.status') IN ('ANALYZING','WAIT_BUY','OPEN','SELL_DECIDED_PRICE_PENDING')",
      );
    else if (options.state && options.state !== "ALL") {
      where.push("json_extract(payload,'$.status')=?");
      params.push(options.state);
    }
    const rows = this.db
      .prepare(
        "SELECT rowid cursor,payload FROM lab_trials" +
          (where.length ? " WHERE " + where.join(" AND ") : "") +
          " ORDER BY rowid DESC LIMIT ?",
      )
      .all(...params, limit + 1);
    const visible = rows.slice(0, limit),
      hasMore = rows.length > limit;
    return {
      rows: this.decode(visible),
      hasMore,
      nextCursor: hasMore ? Number(visible.at(-1)!.cursor) : null,
      pageSize: limit,
    };
  }
  events(trialId?: string, cursor?: number, limit = 100) {
    const where: string[] = [],
      params: Array<string | number> = [];
    if (trialId) {
      where.push("trial_id=?");
      params.push(trialId);
    }
    if (cursor) {
      where.push("id<?");
      params.push(cursor);
    }
    return this.db
      .prepare(
        "SELECT id,at,kind,trial_id,payload FROM lab_events" +
          (where.length ? " WHERE " + where.join(" AND ") : "") +
          " ORDER BY id DESC LIMIT ?",
      )
      .all(...params, Math.max(1, Math.min(100, limit)))
      .map((r) => ({ ...r, payload: JSON.parse(String(r.payload)) }));
  }
  trials(): LabTrial[] {
    return (
      this.db
        .prepare("SELECT payload FROM lab_trials ORDER BY rowid")
        .all() as { payload: string }[]
    ).map((x) => {
      const t = JSON.parse(x.payload);
      return { ...t, logo: tokenLogo(t) };
    });
  }
  save(t: LabTrial) {
    this.db
      .prepare("UPDATE lab_trials SET payload=? WHERE id=?")
      .run(JSON.stringify(t), t.id);
  }
  add(
    input: Pick<
      LabTrial,
      "mint" | "symbol" | "name" | "logo" | "discoveredAt" | "appearance"
    > & { mode?: "PAPER" | "LIVE" },
    now = Date.now(),
  ) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const all = this.decode(
        this.db
          .prepare("SELECT payload FROM lab_trials WHERE mint=?")
          .all(input.mint),
      );
      const logo = tokenLogo(input);
      if (logo)
        for (const existing of all.filter(
          (t) => t.mint === input.mint && t.logo !== logo,
        )) {
          existing.logo = logo;
          this.save(existing);
        }
      if (
        this.db
          .prepare(
            "SELECT id FROM lab_trials WHERE appearance=? UNION ALL SELECT id FROM lab_trials WHERE mint=? AND COALESCE(json_extract(payload,'$.mode'),'PAPER')=? AND json_extract(payload,'$.status') IN ('ANALYZING','WAIT_BUY','OPEN','SELL_DECIDED_PRICE_PENDING') LIMIT 1",
          )
          .get(input.appearance, input.mint, input.mode ?? "PAPER")
      ) {
        this.db.exec("COMMIT");
        return;
      }
      const t: LabTrial = {
        ...input,
        logo: tokenLogo(input),
        id: randomUUID(),
        source: "GMGN_TRENDING",
        createdAt: now,
        updatedAt: now,
        status: "ANALYZING",
        gates: {},
        nextAt: now,
        decisionCount: 0,
      };
      this.db
        .prepare("INSERT INTO lab_trials VALUES(?,?,?,?)")
        .run(
          t.id,
          t.mint,
          t.appearance,
          JSON.stringify({ ...t, mode: input.mode ?? "PAPER" }),
        );
      this.db.exec("COMMIT");
      return t;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  decision(t: LabTrial, d: LabDecision) {
    this.db
      .prepare("INSERT INTO lab_decisions(trial_id,payload) VALUES(?,?)")
      .run(t.id, JSON.stringify(d));
    t.decisionCount++;
    t.latest = d;
  }
  commitDecision(t: LabTrial, d: LabDecision) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.decision(t, d);
      this.save(t);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  decisions(id: string) {
    return (
      this.db
        .prepare(
          "SELECT payload FROM lab_decisions WHERE trial_id=? ORDER BY id DESC LIMIT 50",
        )
        .all(id) as { payload: string }[]
    ).map((x) => JSON.parse(x.payload));
  }
  event(kind: string, t?: LabTrial, payload: unknown = {}) {
    this.db
      .prepare(
        "INSERT INTO lab_events(at,kind,trial_id,payload) VALUES(?,?,?,?)",
      )
      .run(Date.now(), kind, t?.id ?? null, JSON.stringify(payload));
  }
  get(key: string) {
    const row = this.db
      .prepare("SELECT value FROM lab_meta WHERE key=?")
      .get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : undefined;
  }
  set(key: string, value: unknown) {
    this.db
      .prepare("INSERT OR REPLACE INTO lab_meta VALUES(?,?)")
      .run(key, JSON.stringify(value));
  }
  reset(confirmation: string) {
    if (confirmation !== "RESET KRONOS PAPER EXPERIMENT")
      throw Error("RESET_CONFIRMATION_REQUIRED");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (
        this.db
          .prepare(
            "SELECT name FROM sqlite_master WHERE name='live_executions'",
          )
          .get()
      ) {
        const pending = this.db
          .prepare(
            "SELECT id FROM live_executions WHERE state IN ('CREATED','SUBMITTED','CONFIRMED','UNKNOWN') LIMIT 1",
          )
          .get();
        const real = this.db
          .prepare("SELECT id FROM live_positions LIMIT 1")
          .get();
        const signed = this.db
          .prepare(
            "SELECT id FROM live_executions WHERE json_extract(payload,'$.signature') IS NOT NULL LIMIT 1",
          )
          .get();
        if (pending || real || signed)
          throw Error("LIVE_LEDGER_RESET_FORBIDDEN");
      }
      this.db.exec(
        "DELETE FROM lab_trials; DELETE FROM lab_decisions; DELETE FROM lab_events; DELETE FROM lab_meta;",
      );
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  summary() {
    const fields = [
      "count(*) records",
      "sum(CASE WHEN json_extract(payload,'$.checkedAt') IS NOT NULL OR json_extract(payload,'$.decisionCount')>0 OR json_type(payload,'$.gates.CHEAP_FILTER') IS NOT NULL THEN 1 ELSE 0 END) checked",
      "sum(CASE WHEN json_type(payload,'$.entry')='object' THEN 1 ELSE 0 END) buys",
      "sum(CASE WHEN json_type(payload,'$.entry')='object' AND json_type(payload,'$.exit') IS NULL THEN 1 ELSE 0 END) opens",
      "sum(CASE WHEN json_extract(payload,'$.status')='CLOSED' THEN 1 ELSE 0 END) closed",
      ...["wins", "losses", "flats"].map(
        (n, i) =>
          "sum(CASE WHEN json_extract(payload,'$.status')='CLOSED' AND json_extract(payload,'$.pnlPct')" +
          [">0", "<0", "=0"][i] +
          " THEN 1 ELSE 0 END) " +
          n,
      ),
      ...["avg", "sum", "min", "max"].map(
        (f) =>
          f +
          "(CASE WHEN json_extract(payload,'$.status')='CLOSED' THEN json_extract(payload,'$.pnlPct') END) " +
          f,
      ),
      "avg(CASE WHEN json_extract(payload,'$.status')='CLOSED' THEN json_extract(payload,'$.mfePct') END) mfe",
      "avg(CASE WHEN json_extract(payload,'$.status')='CLOSED' THEN json_extract(payload,'$.maePct') END) mae",
      "avg(CASE WHEN json_extract(payload,'$.status')='CLOSED' THEN json_extract(payload,'$.exit.observedAt')-json_extract(payload,'$.entry.observedAt') END) hold",
      ...[
        "CHEAP_FILTER",
        "SECURITY",
        "COMPATIBILITY",
        "HISTORY",
        "CAPITAL_FLOW",
      ].map(
        (g, i) =>
          "sum(CASE WHEN json_extract(payload,'$.gatePasses." +
          g +
          "')=1 OR json_extract(payload,'$.gates." +
          g +
          ".status')='PASS' THEN 1 ELSE 0 END) gate" +
          i,
      ),
    ];
    const a = this.db
      .prepare(
        "SELECT " +
          fields.join(",") +
          " FROM lab_trials WHERE COALESCE(json_extract(payload,'$.mode'),'PAPER')='PAPER'",
      )
      .get()!;
    const valid = Number(
      this.db
        .prepare(
          "SELECT count(*) n FROM lab_trials WHERE COALESCE(json_extract(payload,'$.mode'),'PAPER')='PAPER' AND json_extract(payload,'$.status')='CLOSED' AND json_extract(payload,'$.pnlPct') IS NOT NULL",
        )
        .get()!.n,
    );
    const middle = valid
      ? this.db
          .prepare(
            "SELECT json_extract(payload,'$.pnlPct') pnl FROM lab_trials WHERE COALESCE(json_extract(payload,'$.mode'),'PAPER')='PAPER' AND json_extract(payload,'$.status')='CLOSED' AND json_extract(payload,'$.pnlPct') IS NOT NULL ORDER BY json_extract(payload,'$.pnlPct') LIMIT ? OFFSET ?",
          )
          .all(valid % 2 ? 1 : 2, Math.floor((valid - 1) / 2))
      : [];
    const closed = Number(a.closed ?? 0),
      checked = Number(a.checked ?? 0),
      buys = Number(a.buys ?? 0);
    const rolling = (n: number) => {
      const rows = this.db
        .prepare(
          "SELECT json_extract(payload,'$.pnlPct') pnl FROM lab_trials WHERE COALESCE(json_extract(payload,'$.mode'),'PAPER')='PAPER' AND json_extract(payload,'$.status')='CLOSED' ORDER BY json_extract(payload,'$.exit.observedAt') DESC,rowid DESC LIMIT ?",
        )
        .all(n);
      return rows.length === n
        ? rows.filter((x) => Number(x.pnl) > 0).length / n
        : null;
    };
    const distribution = this.db
      .prepare(
        "SELECT CASE WHEN json_extract(payload,'$.pnlPct')<0 THEN 'LOSS' WHEN json_extract(payload,'$.pnlPct')=0 THEN 'BREAKEVEN' ELSE 'WIN' END bucket,count(*) count FROM lab_trials WHERE COALESCE(json_extract(payload,'$.mode'),'PAPER')='PAPER' AND json_extract(payload,'$.status')='CLOSED' AND json_extract(payload,'$.pnlPct') IS NOT NULL GROUP BY bucket",
      )
      .all();
    return {
      records: Number(a.records),
      tokensChecked: checked,
      kronosPass: buys,
      selectionRate: checked ? buys / checked : null,
      eligible: Number(a.gate4 ?? 0),
      paperBuys: buys,
      open: Number(a.opens ?? 0),
      closed,
      wins: Number(a.wins ?? 0),
      losses: Number(a.losses ?? 0),
      flats: Number(a.flats ?? 0),
      winRate: closed ? Number(a.wins ?? 0) / closed : null,
      averagePnlPct: a.avg as number | null,
      medianPnlPct: middle.length
        ? middle.reduce((n, r) => n + Number(r.pnl), 0) / middle.length
        : null,
      totalPaperPnlPct: a.sum as number | null,
      bestTrade: a.max as number | null,
      worstTrade: a.min as number | null,
      averageMfePct: a.mfe as number | null,
      averageMaePct: a.mae as number | null,
      averageHoldMs: a.hold as number | null,
      rolling20: rolling(20),
      rolling50: rolling(50),
      distribution,
      funnel: Object.fromEntries(
        [
          "CHEAP_FILTER",
          "SECURITY",
          "COMPATIBILITY",
          "HISTORY",
          "CAPITAL_FLOW",
        ].map((g, i) => [g, Number(a["gate" + i] ?? 0)]),
      ),
      winRateDenominator: "ALL_CLOSED_INCLUDING_FLAT",
      totalSemantics:
        "SUM_OF_EQUAL_NOTIONAL_CLOSED_PRICE_RETURNS_NOT_COMPOUNDED",
    };
  }
  close() {
    this.db.close();
  }
}
