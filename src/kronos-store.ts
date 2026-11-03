import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { KRONOS, type LabTrial, type LabDecision } from "./kronos-domain.js";
import { tokenLogo } from "./token-metadata.js";
/** Dedicated database, never a production Store. Caller supplies isolated path. */
export class KronosStore {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db
      .exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS lab_trials(id TEXT PRIMARY KEY,mint TEXT NOT NULL,appearance TEXT NOT NULL UNIQUE,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS lab_decisions(id INTEGER PRIMARY KEY,trial_id TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS lab_events(id INTEGER PRIMARY KEY,at INTEGER NOT NULL,kind TEXT NOT NULL,trial_id TEXT,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS lab_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
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
    >,
    now = Date.now(),
  ) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const all = this.trials();
      const logo = tokenLogo(input);
      if (logo)
        for (const existing of all.filter(
          (t) => t.mint === input.mint && t.logo !== logo,
        )) {
          existing.logo = logo;
          this.save(existing);
        }
      if (
        all.length >= KRONOS.maxRecords ||
        all.some(
          (t) =>
            t.appearance === input.appearance ||
            (t.mint === input.mint &&
              [
                "ANALYZING",
                "WAIT_BUY",
                "OPEN",
                "SELL_DECIDED_PRICE_PENDING",
              ].includes(t.status)),
        )
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
        .run(t.id, t.mint, t.appearance, JSON.stringify(t));
      this.db.exec("COMMIT");
      return t;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  decision(t: LabTrial, d: LabDecision) {
    if (t.decisionCount >= KRONOS.decisionCap)
      throw Error("DECISION_STORAGE_CAP");
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
    const count = Number(this.get("eventCount") ?? 0);
    if (count >= 50000) return;
    this.db
      .prepare(
        "INSERT INTO lab_events(at,kind,trial_id,payload) VALUES(?,?,?,?)",
      )
      .run(Date.now(), kind, t?.id ?? null, JSON.stringify(payload));
    this.set("eventCount", count + 1);
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
    const ts = this.trials(),
      closed = ts.filter((t) => t.status === "CLOSED"),
      opens = ts.filter((t) => !!t.entry && !t.exit),
      vals = closed
        .map((t) => t.pnlPct!)
        .filter(Number.isFinite)
        .sort((a, b) => a - b),
      mean = (xs: number[]) =>
        xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
    return {
      records: ts.length,
      limit: KRONOS.maxRecords,
      eligible: ts.filter((t) => t.gates.CAPITAL_FLOW?.status === "PASS")
        .length,
      paperBuys: ts.filter((t) => !!t.entry).length,
      open: opens.length,
      closed: closed.length,
      wins: closed.filter((t) => t.outcome === "WIN").length,
      losses: closed.filter((t) => t.outcome === "LOSS").length,
      flats: closed.filter((t) => t.outcome === "FLAT").length,
      winRate: closed.length
        ? closed.filter((t) => t.outcome === "WIN").length / closed.length
        : null,
      averagePnlPct: mean(vals),
      medianPnlPct: vals.length
        ? (vals[Math.floor((vals.length - 1) / 2)]! +
            vals[Math.floor(vals.length / 2)]!) /
          2
        : null,
      totalPaperPnlPct: vals.length ? vals.reduce((a, b) => a + b, 0) : null,
      averageMfePct: mean(closed.map((t) => t.mfePct!).filter(Number.isFinite)),
      averageMaePct: mean(closed.map((t) => t.maePct!).filter(Number.isFinite)),
      averageHoldMs: mean(
        closed.map((t) => t.exit!.observedAt - t.entry!.observedAt),
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
