import type { DatabaseSync } from "node:sqlite";

// Offline maintenance only. Normal Engine/Server never imports this module.
const datasetTables = new Set([
  "tokens",
  "discovery_events",
  "records",
  "candidate_lifecycle",
  "candidate_attempts",
  "buy_ownership_claims",
  "trending_appearances",
  "positions",
  "intents",
  "executions",
  "execution_fills",
  "orders",
  "manual_exits",
  "jev_exit_decisions",
  "capital_flow_states",
  "candidate_flow_states",
  "position_runner_memory",
  "sniper_structure_watch",
  "entry_structure_watch",
  "trade_learning_samples",
  "trade_observations",
  "trade_exit_snapshots",
  "trade_execution_evidence",
  "trade_execution_preflights",
  "trade_execution_failures",
  "trade_outcomes",
  "learning_patterns",
  "learning_versions",
]);
const transientSettings = new Set([
  "paperCash",
  "paperBalanceSource",
  "faultMetrics",
  "manualExitRequests",
]);
const transientPrefixes = [
  "candidateAuthority:",
  "learningPostAttempt:",
  "discoveryTrendingStreak:",
  "trendingBatchV1:",
  "oneShotAppearanceWatermark:",
];
const tables = (db: DatabaseSync) =>
  db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((r) => String(r.name));

export function assertResetSafe(db: DatabaseSync) {
  const present = new Set(tables(db));
  const pending: Array<Record<string, unknown>> = [];
  if (present.has("executions"))
    pending.push(
      ...db
        .prepare(
          "SELECT id,state,signature FROM executions WHERE state NOT IN ('CONFIRMED','FAILED') OR COALESCE(json_extract(payload,'$.state'),state) NOT IN ('CONFIRMED','FAILED')",
        )
        .all(),
    );
  if (present.has("positions"))
    pending.push(
      ...db
        .prepare(
          "SELECT id,state FROM positions WHERE state IN ('PENDING_ENTRY','PENDING_EXIT')",
        )
        .all(),
    );
  if (present.has("manual_exits"))
    pending.push(
      ...db
        .prepare("SELECT id,state FROM manual_exits WHERE state='SUBMITTED'")
        .all(),
    );
  if (pending.length)
    throw new Error(
      "RESET_ABORT_UNRESOLVED_TRANSACTION: " +
        pending.map((p) => p.id + "/" + p.state).join(","),
    );
  if (
    present.has("buy_ownership_claims") &&
    Number(
      db
        .prepare("SELECT count(*) n FROM buy_ownership_claims WHERE active=1")
        .get()?.n,
    ) > 0
  )
    throw Error("RESET_ABORT_ACTIVE_BUY_OWNERSHIP");
  return { pending: 0 };
}

export function resetStrategyData(
  db: DatabaseSync,
  proof: { backupVerified: boolean; backupPath: string },
  now = Date.now(),
) {
  if (!proof.backupVerified || !proof.backupPath)
    throw new Error("RESET_ABORT_BACKUP_REQUIRED");
  const names = tables(db);
  const unknown = names.filter(
    (t) => !datasetTables.has(t) && !["settings", "migrations"].includes(t),
  );
  if (unknown.length)
    throw new Error("RESET_ABORT_UNMAPPED_TABLE: " + unknown.join(","));
  const targets = names.filter((t) => datasetTables.has(t));
  const schema = () =>
    db
      .prepare(
        "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name",
      )
      .all();
  const beforeSchema = JSON.stringify(schema());
  const dependencies = new Map(
    targets.map((t) => [
      t,
      db
        .prepare('PRAGMA foreign_key_list("' + t + '")')
        .all()
        .map((r) => String(r.table)),
    ]),
  );
  const deletionOrder: string[] = [],
    visiting = new Set<string>();
  function visit(name: string) {
    if (deletionOrder.includes(name)) return;
    if (visiting.has(name)) throw new Error("RESET_ABORT_FOREIGN_KEY_CYCLE");
    visiting.add(name);
    for (const child of targets)
      if (dependencies.get(child)!.includes(name)) visit(child);
    visiting.delete(name);
    deletionOrder.push(name);
  }
  for (const t of targets) visit(t);
  const before = Object.fromEntries(
    targets.map((t) => [
      t,
      Number(db.prepare('SELECT count(*) n FROM "' + t + '"').get()!.n),
    ]),
  );
  const immutable = db
    .prepare("SELECT name,tbl_name,sql FROM sqlite_master WHERE type='trigger'")
    .all()
    .filter(
      (r) =>
        targets.includes(String(r.tbl_name)) &&
        r.name === String(r.tbl_name) + "_immutable_delete",
    );
  db.exec("BEGIN IMMEDIATE");
  try {
    // Recheck under the write lock, before removing a single row/trigger.
    assertResetSafe(db);
    for (const trigger of immutable)
      db.exec('DROP TRIGGER "' + trigger.name + '"');
    for (const table of deletionOrder) db.exec('DELETE FROM "' + table + '"');
    const removedSettings: string[] = [];
    for (const row of db.prepare("SELECT key FROM settings").all()) {
      const key = String(row.key);
      if (
        transientSettings.has(key) ||
        transientPrefixes.some((p) => key.startsWith(p))
      ) {
        db.prepare("DELETE FROM settings WHERE key=?").run(key);
        removedSettings.push(key);
      }
    }
    for (const trigger of immutable) db.exec(String(trigger.sql));
    db.prepare(
      "INSERT INTO settings VALUES('newEntriesEnabled','false') ON CONFLICT(key) DO UPDATE SET payload='false'",
    ).run();
    db.prepare(
      "INSERT INTO settings VALUES('strategyDataReset',?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload",
    ).run(
      JSON.stringify({
        at: now,
        reason: "TRENDING_ONLY_CLEAN_START",
        backupPath: proof.backupPath,
      }),
    );
    if (JSON.stringify(schema()) !== beforeSchema)
      throw new Error("RESET_ABORT_SCHEMA_CHANGED");
    if (db.prepare("PRAGMA foreign_key_check").all().length)
      throw new Error("RESET_ABORT_FOREIGN_KEYS");
    const after = Object.fromEntries(
      targets.map((t) => [
        t,
        Number(db.prepare('SELECT count(*) n FROM "' + t + '"').get()!.n),
      ]),
    );
    if (Object.values(after).some((n) => n !== 0))
      throw new Error("RESET_ABORT_DATA_REMAINS");
    db.exec("COMMIT");
    return {
      at: new Date(now).toISOString(),
      before,
      after,
      deletionOrder,
      removedSettings,
      schemaPreserved: true,
      pending: 0,
    };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
