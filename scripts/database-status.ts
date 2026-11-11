import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { env } from "../src/config.js";
import { databaseDirectory } from "../src/database-session.js";
const directory = databaseDirectory(),
  result: Record<string, unknown> = {
    directory,
    at: new Date().toISOString(),
    configuredMode: env.TRADING_MODE,
    legacySource: env.DATABASE_PATH,
    models: {
      standard: process.env.CODEX_MODEL ?? null,
      deep: process.env.CODEX_DEEP_MODEL ?? null,
    },
  };
for (const name of ["demo", "live", "learning"]) {
  const path = join(directory, name + ".sqlite");
  if (!existsSync(path)) {
    result[name] = { state: "NOT_INITIALIZED" };
    continue;
  }
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000");
    const has = (t: string) =>
      !!db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
        .get(t);
    const data: Record<string, unknown> = {
      path,
      integrity: db.prepare("PRAGMA quick_check").get()?.quick_check,
    };
    if (name === "learning") {
      for (const table of [
        "chart_candles",
        "chart_events",
        "learning_windows",
        "chart_rule_versions",
        "chart_replays",
        "migration_quarantine",
      ])
        if (has(table))
          data[table] = db.prepare("SELECT count(*) n FROM " + table).get()!.n;
      data.jobs = db
        .prepare("SELECT state,count(*) n FROM chart_jobs GROUP BY state")
        .all();
      data.decisions = db
        .prepare(
          "SELECT action,count(*) n FROM chart_decisions GROUP BY action",
        )
        .all();
    } else {
      data.positions = db
        .prepare(
          "SELECT mode,state,count(*) n FROM positions GROUP BY mode,state",
        )
        .all();
      data.executions = db
        .prepare("SELECT state,count(*) n FROM executions GROUP BY state")
        .all();
      data.sessions = db
        .prepare("SELECT mode,state,pid FROM engine_sessions")
        .all();
      data.pendingOutbox = db
        .prepare(
          "SELECT count(*) n FROM learning_outbox WHERE delivered_at IS NULL",
        )
        .get()!.n;
      if (name === "demo")
        data.virtualAccount =
          db
            .prepare(
              "SELECT id,initial,cash,reserved,realized FROM demo_accounts WHERE archived_at IS NULL",
            )
            .get() ?? null;
    }
    result[name] = data;
  } finally {
    db.close();
  }
}
const manifest = join(directory, "database-split-manifest.json");
if (existsSync(manifest))
  result.migration = JSON.parse(readFileSync(manifest, "utf8"));
console.log(JSON.stringify(result, null, 2));
