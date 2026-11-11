import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
/** One conservative local quota domain; no credential material is persisted. */
export class GmgnProviderState {
    db;
    constructor(path) {
        mkdirSync(dirname(path), { recursive: true });
        this.db = new DatabaseSync(path);
        this.db.exec("PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS cooldown (id INTEGER PRIMARY KEY CHECK(id=1), until_ms INTEGER NOT NULL, last_rate_limit_at INTEGER NOT NULL, source TEXT NOT NULL)");
    }
    read() {
        return Number(this.db.prepare("SELECT until_ms FROM cooldown WHERE id=1").get()
            ?.until_ms ?? 0);
    }
    extend(until, at) {
        this.db
            .prepare("INSERT INTO cooldown VALUES(1,?,?,'GMGN_RATE_LIMIT') ON CONFLICT(id) DO UPDATE SET until_ms=MAX(until_ms,excluded.until_ms),last_rate_limit_at=MAX(last_rate_limit_at,excluded.last_rate_limit_at)")
            .run(until, at);
    }
    close() {
        this.db.close();
    }
}
