import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { chartLearningMigration } from "./chart-learning-schema.js";
import { learningMigration } from "./learning-schema.js";

export function openLearningDatabase(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS database_identity(id INTEGER PRIMARY KEY CHECK(id=1),role TEXT NOT NULL)",
    );
    db.prepare(
      "INSERT OR IGNORE INTO database_identity VALUES(1,'learning')",
    ).run();
    if (
      db.prepare("SELECT role FROM database_identity WHERE id=1").get()!
        .role !== "learning"
    )
      throw Error("DATABASE_ROLE_MISMATCH");
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY,at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,payload TEXT NOT NULL);`);
    db.exec(chartLearningMigration);
    // This file is exclusively shared learning; no mode-partitioned collector queue.
    const queue = db
      .prepare("PRAGMA table_info(chart_observation_queue)")
      .all();
    if (queue.some((c) => c.name === "mode")) {
      if (
        Number(
          db.prepare("SELECT count(*) n FROM chart_observation_queue").get()!.n,
        )
      )
        throw Error("SHARED_QUEUE_MIGRATION_REQUIRED");
      db.exec(
        "DROP TABLE chart_observation_queue; CREATE TABLE chart_observation_queue(mint TEXT PRIMARY KEY,priority INTEGER NOT NULL,due INTEGER NOT NULL,until_at INTEGER NOT NULL,reason TEXT NOT NULL,failures INTEGER NOT NULL DEFAULT 0);",
      );
    }
    db.exec(learningMigration);
    db.exec(`CREATE TABLE IF NOT EXISTS learning_tokens(mint TEXT PRIMARY KEY,at INTEGER NOT NULL,payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS learning_windows(id TEXT PRIMARY KEY,mint TEXT NOT NULL,source TEXT NOT NULL,from_at INTEGER NOT NULL,to_at INTEGER NOT NULL,available_at INTEGER NOT NULL,payload TEXT NOT NULL,UNIQUE(mint,source,from_at,to_at));
    CREATE INDEX IF NOT EXISTS learning_window_time ON learning_windows(mint,to_at);
    CREATE TABLE IF NOT EXISTS learning_records(id TEXT PRIMARY KEY,kind TEXT NOT NULL,mint TEXT,at INTEGER NOT NULL,payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS learning_record_kind ON learning_records(kind,at);
    CREATE TABLE IF NOT EXISTS migration_journal(source_id TEXT PRIMARY KEY,state TEXT NOT NULL,backup_path TEXT NOT NULL,at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS migration_rows(source_id TEXT NOT NULL,table_name TEXT NOT NULL,row_key TEXT NOT NULL,destination TEXT NOT NULL,PRIMARY KEY(source_id,table_name,row_key,destination));
    CREATE TABLE IF NOT EXISTS migration_quarantine(id TEXT PRIMARY KEY,source_id TEXT NOT NULL,table_name TEXT NOT NULL,reason TEXT NOT NULL,payload TEXT NOT NULL);
    INSERT OR IGNORE INTO migrations VALUES(18,unixepoch());`);
    return db;
  } catch (e) {
    db.close();
    throw e;
  }
}
export function sqliteAtomic<T>(db: DatabaseSync, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
