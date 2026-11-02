import type { KronosStore } from "./kronos-store.js";
import type { LiveExecution, LivePosition } from "./live-types.js";
/** Own durable ledger. No BOT B schema, data, wallet state or memory is imported. */
export class LiveStore {
  constructor(readonly store: KronosStore) {
    store.db.exec(`PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS live_executions(id TEXT PRIMARY KEY,request_key TEXT NOT NULL UNIQUE,wallet TEXT NOT NULL,mint TEXT NOT NULL,state TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS live_wallet_pending ON live_executions(wallet) WHERE state IN ('CREATED','SUBMITTED','CONFIRMED','UNKNOWN');
      CREATE TABLE IF NOT EXISTS live_positions(id TEXT PRIMARY KEY,wallet TEXT NOT NULL,mint TEXT NOT NULL,state TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS live_owned_mint ON live_positions(wallet,mint) WHERE state='OPEN';
      CREATE TABLE IF NOT EXISTS live_fills(signature TEXT PRIMARY KEY,execution_id TEXT NOT NULL UNIQUE,payload TEXT NOT NULL);`);
  }
  atomic<T>(work: () => T) {
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.store.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.store.db.exec("ROLLBACK");
      throw e;
    }
  }
  execution(id: string): LiveExecution | undefined {
    const r = this.store.db
      .prepare("SELECT payload FROM live_executions WHERE id=?")
      .get(id);
    return r ? JSON.parse(String(r.payload)) : undefined;
  }
  pending(): LiveExecution[] {
    return this.store.db
      .prepare(
        "SELECT payload FROM live_executions WHERE state IN ('CREATED','SUBMITTED','CONFIRMED','UNKNOWN') ORDER BY rowid",
      )
      .all()
      .map((r) => JSON.parse(String(r.payload)));
  }
  claim(e: LiveExecution) {
    this.store.db
      .prepare("INSERT INTO live_executions VALUES(?,?,?,?,?,?)")
      .run(
        e.id,
        `${e.trialId}:${e.intent.side}:${e.intent.decisionAt}`,
        e.wallet,
        e.mint,
        e.state,
        JSON.stringify(e),
      );
  }
  save(e: LiveExecution) {
    this.store.db
      .prepare("UPDATE live_executions SET state=?,payload=? WHERE id=?")
      .run(e.state, JSON.stringify(e), e.id);
  }
  position(id: string): LivePosition | undefined {
    const r = this.store.db
      .prepare("SELECT payload FROM live_positions WHERE id=?")
      .get(id);
    return r ? JSON.parse(String(r.payload)) : undefined;
  }
  owned(wallet: string, mint: string) {
    return !!this.store.db
      .prepare(
        "SELECT id FROM live_positions WHERE wallet=? AND mint=? AND state='OPEN'",
      )
      .get(wallet, mint);
  }
  savePosition(p: LivePosition) {
    this.store.db
      .prepare(
        "INSERT INTO live_positions VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,payload=excluded.payload",
      )
      .run(p.id, p.wallet, p.mint, p.state, JSON.stringify(p));
  }
  fees(trialId: string): bigint | null {
    const rows = this.store.db
      .prepare(
        "SELECT payload FROM live_executions WHERE json_extract(payload,'$.trialId')=? AND (state='RECONCILED' OR json_extract(payload,'$.failedFeeLamports') IS NOT NULL)",
      )
      .all(trialId);
    let total = 0n;
    for (const r of rows) {
      const e: LiveExecution = JSON.parse(String(r.payload));
      const fee = e.failedFeeLamports ?? e.accounting?.networkFeeLamports;
      if (fee == null) return null;
      total += BigInt(fee);
    }
    return total;
  }
  openCount() {
    return Number(
      this.store.db
        .prepare("SELECT count(*) n FROM live_positions WHERE state='OPEN'")
        .get()!.n,
    );
  }
  positions(wallet: string): LivePosition[] {
    return this.store.db
      .prepare(
        "SELECT payload FROM live_positions WHERE wallet=? AND state='OPEN'",
      )
      .all(wallet)
      .map((r) => JSON.parse(String(r.payload)));
  }
  // LIVE statistics are SQL aggregates; never combined with PAPER price returns.
  summary() {
    const r = this.store.db
      .prepare(
        `SELECT count(*) buys,
      sum(state='OPEN') opens,sum(state='CLOSED') closed,
      sum(state='CLOSED' AND CAST(json_extract(payload,'$.netPnlLamports') AS INTEGER)>0) wins,
      sum(state='CLOSED' AND CAST(json_extract(payload,'$.netPnlLamports') AS INTEGER)<0) losses,
      sum(state='CLOSED' AND json_extract(payload,'$.netPnlLamports') IS NOT NULL) accounted,
      sum(CASE WHEN state='CLOSED' THEN CAST(json_extract(payload,'$.grossPnlLamports') AS INTEGER) END) gross,
      sum(CASE WHEN state='CLOSED' THEN CAST(json_extract(payload,'$.feesLamports') AS INTEGER) END) fees,
      sum(CASE WHEN state='CLOSED' THEN CAST(json_extract(payload,'$.netPnlLamports') AS INTEGER) END) net,
      min(CASE WHEN state='CLOSED' THEN CAST(json_extract(payload,'$.netPnlLamports') AS INTEGER) END) worst,
      max(CASE WHEN state='CLOSED' THEN CAST(json_extract(payload,'$.netPnlLamports') AS INTEGER) END) best
      FROM live_positions`,
      )
      .get()!;
    const n = Number(r.accounted ?? 0),
      closed = Number(r.closed ?? 0);
    const middle = n
      ? this.store.db
          .prepare(
            "SELECT CAST(json_extract(payload,'$.netPnlLamports') AS INTEGER) n FROM live_positions WHERE state='CLOSED' AND json_extract(payload,'$.netPnlLamports') IS NOT NULL ORDER BY n LIMIT ? OFFSET ?",
          )
          .all(n % 2 ? 1 : 2, Math.floor((n - 1) / 2))
      : [];
    const whole = closed > 0 && n === closed;
    return {
      mode: "LIVE",
      buys: Number(r.buys),
      open: Number(r.opens ?? 0),
      closed,
      wins: Number(r.wins ?? 0),
      losses: Number(r.losses ?? 0),
      accounted: n,
      winRate: whole ? Number(r.wins ?? 0) / closed : null,
      grossRealizedLamports: whole && r.gross != null ? String(r.gross) : null,
      actualFeesLamports: whole && r.fees != null ? String(r.fees) : null,
      netRealizedLamports: whole && r.net != null ? String(r.net) : null,
      averageNetLamports: n && whole ? Number(r.net) / n : null,
      medianNetLamports:
        middle.length && whole
          ? middle.reduce((s, v) => s + Number(v.n), 0) / middle.length
          : null,
      bestNetLamports: whole && r.best != null ? String(r.best) : null,
      worstNetLamports: whole && r.worst != null ? String(r.worst) : null,
    };
  }
}
