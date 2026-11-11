import { backup, DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync, fsyncSync, renameSync, unlinkSync, } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseRegistry } from "./database-registry.js";
import { chartId } from "./chart-store.js";
import { preEventFeatures } from "./chart-features.js";
const ident = (name) => {
    if (!/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(name))
        throw Error("MIGRATION_IDENTIFIER");
    return '"' + name + '"';
};
const learningTables = new Set([
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
const marketTables = new Set([
    "tokens",
    "discovery_events",
    "candidate_flow_states",
]);
export async function migrateDatabases(legacyPath, directory, options = {}) {
    const sourcePath = resolve(legacyPath), root = resolve(directory);
    mkdirSync(root, { recursive: true });
    const migrationLock = join(root, "database-migration.lock");
    let lockFd;
    try {
        lockFd = openSync(migrationLock, "wx");
    }
    catch {
        const pid = Number(readFileSync(migrationLock, "utf8"));
        let alive = true;
        if (!Number.isInteger(pid) || pid < 1)
            throw Error("MIGRATION_LOCK_REQUIRES_REVIEW");
        try {
            process.kill(pid, 0);
        }
        catch (e) {
            if (e.code === "ESRCH")
                alive = false;
            else
                throw e;
        }
        if (alive)
            throw Error("MIGRATION_ALREADY_RUNNING");
        unlinkSync(migrationLock);
        lockFd = openSync(migrationLock, "wx");
    }
    writeFileSync(lockFd, String(process.pid));
    closeSync(lockFd);
    try {
        const manifest = join(root, "database-split-manifest.json");
        if (existsSync(manifest)) {
            const m = JSON.parse(readFileSync(manifest, "utf8"));
            if (m.sourcePath !== sourcePath)
                throw Error("MIGRATION_SOURCE_CONFLICT");
            const r = new DatabaseRegistry(root, { initializeDemo: false });
            try {
                for (const db of [r.demo.db, r.live.db, r.learning])
                    verify(db);
                return m;
            }
            finally {
                r.close();
            }
        }
        if (!existsSync(sourcePath))
            return { state: "FRESH", sourcePath };
        if ([
            join(root, "demo.sqlite"),
            join(root, "live.sqlite"),
            join(root, "learning.sqlite"),
        ].includes(sourcePath))
            throw Error("LEGACY_SOURCE_IS_DESTINATION");
        const lock = sourcePath + ".lock";
        if (existsSync(lock)) {
            const pid = Number(readFileSync(lock, "utf8"));
            if (pid !== options.lockOwnerPid) {
                let alive = true;
                try {
                    process.kill(pid, 0);
                }
                catch (e) {
                    if (e.code === "ESRCH")
                        alive = false;
                    else
                        throw e;
                }
                if (alive)
                    throw Error("MIGRATION_REQUIRES_OFFLINE_LEGACY_ENGINE");
            }
        }
        const backups = join(root, "backups");
        const custody = new DatabaseSync(sourcePath, { readOnly: true });
        try {
            if (custody
                .prepare("SELECT name FROM sqlite_master WHERE name='engine_sessions'")
                .get())
                for (const session of custody
                    .prepare("SELECT pid FROM engine_sessions WHERE state='RUNNING'")
                    .all()) {
                    try {
                        process.kill(Number(session.pid), 0);
                        throw Error("MIGRATION_REQUIRES_OFFLINE_LEGACY_ENGINE");
                    }
                    catch (e) {
                        if (e.code !== "ESRCH")
                            throw e;
                    }
                }
        }
        finally {
            custody.close();
        }
        mkdirSync(backups, { recursive: true });
        const backupPath = join(backups, "legacy-before-split-" +
            chartId(sourcePath.toLowerCase()).slice(0, 12) +
            ".sqlite");
        if (!existsSync(backupPath)) {
            const original = new DatabaseSync(sourcePath, { readOnly: true });
            try {
                await backup(original, backupPath);
            }
            finally {
                original.close();
            }
        }
        const sourceId = createHash("sha256")
            .update(readFileSync(backupPath))
            .digest("hex");
        const src = new DatabaseSync(backupPath, { readOnly: true }), r = new DatabaseRegistry(root, { initializeDemo: false });
        let copied = 0, quarantined = 0, total = 0;
        try {
            verify(src);
            r.learning
                .prepare("INSERT INTO migration_journal VALUES(?,'COPYING',?,?) ON CONFLICT(source_id) DO UPDATE SET state='COPYING'")
                .run(sourceId, backupPath, Date.now());
            const has = (db, name) => !!db
                .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
                .get(name);
            const modeOf = (table, row) => {
                const values = new Set();
                const add = (v) => {
                    if (v === "DEMO")
                        v = "demo";
                    if (v === "LIVE")
                        v = "live";
                    if (v === "demo" || v === "live")
                        values.add(v);
                };
                add(row.mode);
                add(row.scope_mode);
                let p = {};
                try {
                    p = JSON.parse(String(row.payload ?? "{}"));
                }
                catch {
                    return undefined;
                }
                add(p.mode);
                add(p.intent?.mode);
                {
                    const link = row.execution_id ?? p.executionId;
                    if (link && has(src, "executions")) {
                        const e = src
                            .prepare("SELECT payload FROM executions WHERE id=?")
                            .get(String(link));
                        if (e)
                            add(JSON.parse(String(e.payload)).intent?.mode);
                    }
                    const position = row.position_id ?? p.positionId;
                    if (position && has(src, "positions")) {
                        const pos = src
                            .prepare("SELECT mode FROM positions WHERE id=?")
                            .get(String(position));
                        if (pos)
                            add(pos.mode);
                    }
                    const account = row.account_id ?? p.accountId;
                    if (account && has(src, "demo_accounts")) {
                        const a = src
                            .prepare("SELECT mode FROM demo_accounts WHERE id=?")
                            .get(String(account));
                        if (a)
                            add(a.mode);
                    }
                }
                return values.size === 1
                    ? [...values][0]
                    : undefined;
            };
            const quarantine = (table, key, row, reason) => {
                r.learning
                    .prepare("INSERT OR IGNORE INTO migration_quarantine VALUES(?,?,?,?,?)")
                    .run(chartId(sourceId, table, key), sourceId, table, reason, JSON.stringify(row));
                quarantined++;
                journal(table, key, "quarantine");
            };
            const journal = (table, key, destination) => r.learning
                .prepare("INSERT OR IGNORE INTO migration_rows VALUES(?,?,?,?)")
                .run(sourceId, table, key, destination);
            const copy = (db, table, row) => {
                const cols = db
                    .prepare("PRAGMA table_info(" + ident(table) + ")")
                    .all();
                const names = Object.keys(row).filter((k) => cols.some((c) => c.name === k));
                if (names.length !== Object.keys(row).length)
                    throw Error("DESTINATION_SCHEMA_CANNOT_PRESERVE_COLUMNS");
                db.prepare(`INSERT OR IGNORE INTO ${ident(table)}(${names.map(ident).join(",")}) VALUES(${names.map(() => "?").join(",")})`).run(...names.map((k) => row[k]));
                const pk = cols
                    .filter((c) => Number(c.pk) > 0)
                    .map((c) => String(c.name));
                const keys = pk.length ? pk : names;
                const saved = db
                    .prepare(`SELECT * FROM ${ident(table)} WHERE ${keys.map((k) => ident(k) + " IS ?").join(" AND ")}`)
                    .get(...keys.map((k) => row[k]));
                if (!saved || names.some((k) => String(saved[k]) !== String(row[k])))
                    throw Error("DESTINATION_ROW_CONFLICT");
            };
            const tables = src
                .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid")
                .all()
                .map((x) => String(x.name));
            // Topological table order ensures deferred evidence/ledger FKs survive any
            // source schema creation order. Unknown external parents are quarantined.
            const ordered = [];
            let pending = [...tables];
            while (pending.length) {
                const ready = pending.filter((t) => src
                    .prepare("PRAGMA foreign_key_list(" + ident(t) + ")")
                    .all()
                    .every((f) => !pending.includes(String(f.table)) || f.table === t));
                if (!ready.length)
                    throw Error("MIGRATION_CYCLIC_FOREIGN_KEYS");
                ordered.push(...ready);
                pending = pending.filter((t) => !ready.includes(t));
            }
            for (const table of ordered) {
                const rows = src
                    .prepare("SELECT rowid AS __migration_rowid__,* FROM " + ident(table))
                    .all();
                // Transactions are local to each file. A journal row never suppresses
                // copying/verification on recovery, even if another file rolled back.
                for (let offset = 0; offset < rows.length; offset += 250) {
                    for (const db of [r.demo.db, r.live.db, r.learning])
                        db.exec("BEGIN IMMEDIATE");
                    try {
                        for (const original of rows.slice(offset, offset + 250)) {
                            const { __migration_rowid__, ...raw } = original, key = String(__migration_rowid__);
                            const row = raw;
                            total++;
                            try {
                                if (table === "migrations") {
                                    journal(table, key, "schema-archive");
                                }
                                else if (table === "settings") {
                                    const k = String(row.key);
                                    if (["strategyV2", "selectedTradingMode"].includes(k)) {
                                        for (const s of [r.demo, r.live]) {
                                            copy(s.db, table, row);
                                            journal(table, key, s.mode);
                                        }
                                    }
                                    else if (k.includes("chartRuntimeUsage")) {
                                        r.learning
                                            .prepare("INSERT OR IGNORE INTO settings VALUES(?,?)")
                                            .run(k, row.payload);
                                        journal(table, key, "learning");
                                    }
                                    else if (k.startsWith("demo:")) {
                                        copy(r.demo.db, table, row);
                                        journal(table, key, "demo");
                                    }
                                    else
                                        quarantine(table, key, row, "UNSCOPED_SETTING");
                                }
                                else if (table === "chart_observation_queue") {
                                    r.learning
                                        .prepare("INSERT INTO chart_observation_queue VALUES(?,?,?,?,?,?) ON CONFLICT(mint) DO UPDATE SET priority=min(priority,excluded.priority),due=min(due,excluded.due),until_at=max(until_at,excluded.until_at)")
                                        .run(row.mint, row.priority, row.due, row.until_at, row.reason, row.failures);
                                    journal(table, key, "learning");
                                }
                                else if (table.startsWith("chart_") ||
                                    learningTables.has(table)) {
                                    copy(r.learning, table, row);
                                    journal(table, key, "learning");
                                    if (table === "chart_snapshots") {
                                        const h = JSON.parse(String(row.payload)).history;
                                        if (h &&
                                            Array.isArray(h.candles) &&
                                            Number.isFinite(h.historyFrom) &&
                                            Number.isFinite(h.historyTo))
                                            r.learning
                                                .prepare("INSERT OR IGNORE INTO learning_windows VALUES(?,?,?,?,?,?,?)")
                                                .run(chartId(row.mint, h.source, h.historyFrom, h.historyTo), row.mint, h.source, h.historyFrom, h.historyTo, row.at, JSON.stringify({
                                                features: preEventFeatures(h.candles, h.historyTo),
                                                quality: h.diagnostics,
                                                source: h.source,
                                            }));
                                    }
                                }
                                else if (marketTables.has(table)) {
                                    r.learning
                                        .prepare("INSERT OR IGNORE INTO learning_records VALUES(?,?,?,?,?)")
                                        .run(chartId(sourceId, table, key), "legacy:" + table, row.mint ?? null, Number(row.at ?? Date.now()), JSON.stringify(row));
                                    journal(table, key, "learning");
                                    if (table === "tokens")
                                        r.learning
                                            .prepare("INSERT OR IGNORE INTO learning_tokens VALUES(?,?,?)")
                                            .run(row.mint, row.at, row.payload);
                                }
                                else {
                                    const mode = modeOf(table, row);
                                    if (mode && has(r.forMode(mode).db, table)) {
                                        copy(r.forMode(mode).db, table, row);
                                        journal(table, key, mode);
                                        if (table === "records" &&
                                            [
                                                "kronos_decisions",
                                                "position_history",
                                                "position_market",
                                                "snapshots",
                                            ].includes(String(row.kind)))
                                            r.learning
                                                .prepare("INSERT OR IGNORE INTO learning_records VALUES(?,?,?,?,?)")
                                                .run(chartId(sourceId, table, key), row.kind, row.mint, row.at, row.payload);
                                    }
                                    else
                                        quarantine(table, key, row, "AMBIGUOUS_OR_UNSUPPORTED_OWNERSHIP");
                                }
                                copied++;
                            }
                            catch (e) {
                                quarantine(table, key, row, e instanceof Error ? e.message : "ROW_COPY_FAILED");
                            }
                            if (options.failAfter && total >= options.failAfter)
                                throw Error("MIGRATION_INJECTED_INTERRUPTION");
                        }
                        r.demo.db.exec("COMMIT");
                        r.live.db.exec("COMMIT");
                        r.learning.exec("COMMIT");
                    }
                    catch (e) {
                        for (const db of [r.demo.db, r.live.db, r.learning])
                            if (db.isTransaction)
                                db.exec("ROLLBACK");
                        throw e;
                    }
                }
                const accounted = Number(r.learning
                    .prepare("SELECT count(DISTINCT row_key) n FROM migration_rows WHERE source_id=? AND table_name=?")
                    .get(sourceId, table).n);
                if (accounted !== rows.length)
                    throw Error("MIGRATION_ROW_COUNT_MISMATCH:" + table);
            }
            if (has(src, "settings")) {
                const usages = src
                    .prepare("SELECT payload FROM settings WHERE key LIKE '%chartRuntimeUsage'")
                    .all()
                    .map((x) => JSON.parse(String(x.payload)));
                if (usages.length) {
                    const day = Math.max(...usages.map((u) => u.day)), hour = Math.max(...usages.map((u) => u.hour));
                    r.learning
                        .prepare("INSERT INTO settings VALUES('chartRuntimeUsage',?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload")
                        .run(JSON.stringify({
                        day,
                        hour,
                        dayTokens: usages
                            .filter((u) => u.day === day)
                            .reduce((n, u) => n + u.dayTokens, 0),
                        hourCalls: usages
                            .filter((u) => u.hour === hour)
                            .reduce((n, u) => n + u.hourCalls, 0),
                    }));
                }
            }
            for (const db of [r.demo.db, r.live.db, r.learning])
                verify(db);
            for (const store of [r.demo, r.live])
                if (Number(store.db
                    .prepare("SELECT count(*) n FROM positions WHERE mode<>?")
                    .get(store.mode).n))
                    throw Error("MIGRATION_MODE_LEAK");
            r.learning
                .prepare("UPDATE migration_journal SET state='VERIFIED' WHERE source_id=?")
                .run(sourceId);
            const result = {
                version: 18,
                state: "VERIFIED",
                sourceId,
                sourcePath,
                backupPath,
                totalRows: total,
                processedRows: copied,
                quarantinedRows: quarantined,
                at: Date.now(),
            };
            const pendingManifest = manifest + ".pending", fd = openSync(pendingManifest, "w");
            try {
                writeFileSync(fd, JSON.stringify(result, null, 2));
                fsyncSync(fd);
            }
            finally {
                closeSync(fd);
            }
            renameSync(pendingManifest, manifest);
            return result;
        }
        finally {
            src.close();
            r.close();
        }
    }
    finally {
        unlinkSync(migrationLock);
    }
}
export function verify(db) {
    if (db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok")
        throw Error("DATABASE_INTEGRITY_FAILED");
    if (db.prepare("PRAGMA foreign_key_check").all().length)
        throw Error("DATABASE_FOREIGN_KEYS_FAILED");
}
