import { randomUUID } from "node:crypto";
import { Blocked } from "./domain.js";
import { env } from "./config.js";
import { DemoLedger } from "./demo-ledger.js";
import { kronosMigrationPreflight } from "./kronos-migration-preflight.js";
export const migrationSafetyCodes = new Set([
    "LIVE_STANDARD_POSITION_REQUIRES_RESOLUTION",
    "LIVE_LEGACY_EXECUTION_REQUIRES_RESOLUTION",
    "LIVE_TERMINAL_HOLDINGS_REQUIRE_REVIEW",
    "POSITION_EVIDENCE_INVALID",
    "EXECUTION_EVIDENCE_INVALID",
    "LEGACY_ACTIVE_BUY_CLAIM_REQUIRES_REVIEW",
    "MODE_REVIEW_REQUIRED",
    "SCHEMA_REVIEW_REQUIRED",
]);
export const sessionMigration = `CREATE TABLE IF NOT EXISTS engine_sessions(id INTEGER PRIMARY KEY CHECK(id=1),token TEXT NOT NULL,pid INTEGER NOT NULL,mode TEXT NOT NULL,state TEXT NOT NULL,started_at INTEGER NOT NULL);
INSERT OR IGNORE INTO migrations VALUES(14,unixepoch());`;
export class ModeManager {
    controlStore;
    factory;
    verifyLive;
    beforeStop;
    isAlive;
    databases;
    queue = Promise.resolve();
    token;
    selected;
    current;
    transitioning = false;
    recoveryOnly = false;
    sessionStore;
    get store() {
        return this.databases?.forMode(this.selected) ?? this.controlStore;
    }
    constructor(controlStore, factory, verifyLive, beforeStop = async () => { }, isAlive = (pid) => {
        try {
            process.kill(pid, 0);
            return true;
        }
        catch (e) {
            if (e.code === "ESRCH")
                return false;
            throw new Blocked("ENGINE_PROCESS_STATUS_UNKNOWN");
        }
    }, databases) {
        this.controlStore = controlStore;
        this.factory = factory;
        this.verifyLive = verifyLive;
        this.beforeStop = beforeStop;
        this.isAlive = isAlive;
        this.databases = databases;
        const store = controlStore;
        this.selected = store.get("selectedTradingMode") ?? "DEMO";
        if (!["DEMO", "LIVE"].includes(this.selected))
            throw new Blocked("INVALID_PERSISTED_MODE");
        store.set("selectedTradingMode", this.selected);
        env.TRADING_MODE = this.selected === "LIVE" ? "live" : "demo";
    }
    get engine() {
        return this.current;
    }
    get isTransitioning() {
        return this.transitioning;
    }
    status() {
        return {
            mode: this.selected,
            active: !!this.current?.running,
            transitioning: this.transitioning,
            recoveryOnly: this.recoveryOnly,
            liveConfirmationRequired: this.selected === "LIVE" &&
                (!this.current?.running || this.recoveryOnly),
            blockers: this.blockers(),
        };
    }
    blockers() {
        const custody = this.databases?.live ?? this.store;
        const reasons = [];
        for (const p of custody.positions("live"))
            if (!["CLOSED", "FAILED"].includes(p.state) || BigInt(p.quantity) > 0n)
                reasons.push(`LIVE_POSITION_REQUIRES_MONITORING:${p.id}:${p.state}`);
        for (const e of custody.executions("live"))
            if (!["CONFIRMED", "FAILED"].includes(e.state))
                reasons.push(`LIVE_EXECUTION_REQUIRES_RECONCILIATION:${e.id}:${e.state}`);
        for (const m of custody.activeManual("live"))
            reasons.push(`LIVE_PENDING_SELL:${m.id}:${m.state}`);
        return reasons;
    }
    serial(work) {
        const result = this.queue.then(work, work);
        this.queue = result.catch(() => { });
        return result;
    }
    claim(mode) {
        const store = this.databases?.forMode(mode) ?? this.store;
        store.atomic(() => {
            const row = store.db
                .prepare("SELECT * FROM engine_sessions WHERE id=1")
                .get();
            if (row?.state === "RUNNING" && this.isAlive(Number(row.pid)))
                throw new Blocked("ENGINE_SESSION_ALREADY_ACTIVE");
            const token = randomUUID();
            store.db
                .prepare("INSERT INTO engine_sessions VALUES(1,?,?,?,'RUNNING',?) ON CONFLICT(id) DO UPDATE SET token=excluded.token,pid=excluded.pid,mode=excluded.mode,state=excluded.state,started_at=excluded.started_at")
                .run(token, process.pid, mode, Date.now());
            this.token = token;
            this.sessionStore = store;
        });
    }
    release() {
        if (this.token)
            (this.sessionStore ?? this.store).db
                .prepare("UPDATE engine_sessions SET state='STOPPED' WHERE id=1 AND token=?")
                .run(this.token);
        this.token = undefined;
    }
    async startDefault() {
        this.assertMigrationSafe();
        if (this.blockers().length)
            return this.serial(async () => {
                this.claim("LIVE");
                this.selected = "LIVE";
                this.recoveryOnly = true;
                env.TRADING_MODE = "live";
                this.controlStore.set("selectedTradingMode", "LIVE");
                this.store.set("newEntriesEnabled", false);
                try {
                    this.current = this.factory("LIVE");
                    await this.current.start();
                }
                catch (e) {
                    await this.current?.stop();
                    this.release();
                    throw e;
                }
                return this.status();
            });
        // A prior LIVE selection persists, but a process restart never authorizes real execution.
        if (this.selected === "LIVE")
            return this.status();
        return this.switch("DEMO");
    }
    switch(mode, confirmation) {
        return this.serial(async () => {
            if (!["DEMO", "LIVE"].includes(mode))
                throw new Blocked("INVALID_TRADING_MODE");
            this.assertMigrationSafe();
            if (mode === "LIVE" && confirmation !== "START LIVE")
                throw new Blocked("EXPLICIT_LIVE_CONFIRMATION_REQUIRED");
            if (mode === this.selected && this.current?.running) {
                if (mode === "LIVE" && this.recoveryOnly) {
                    await this.verifyLive(this.current);
                    this.recoveryOnly = false;
                }
                return this.status();
            }
            this.transitioning = true;
            try {
                if (this.selected === "LIVE" && mode !== "LIVE") {
                    this.store.set("newEntriesEnabled", false);
                    const reasons = this.blockers();
                    if (reasons.length)
                        throw new Blocked(reasons.join(";"));
                }
                if (this.current) {
                    await this.beforeStop();
                    await this.current.stop();
                }
                if (this.selected === "LIVE" && mode !== "LIVE") {
                    const reasons = this.blockers();
                    if (reasons.length) {
                        // A BUY accepted just before the stop may have settled. Restore LIVE monitoring.
                        this.current = this.factory("LIVE");
                        await this.current.start();
                        throw new Blocked(reasons.join(";"));
                    }
                }
                this.release();
                this.claim(mode);
                this.selected = mode;
                this.recoveryOnly = false;
                env.TRADING_MODE = mode === "LIVE" ? "live" : "demo";
                this.controlStore.set("selectedTradingMode", mode);
                let engine;
                try {
                    if (mode === "DEMO")
                        new DemoLedger(this.store.db).initialize();
                    engine = this.factory(mode);
                    this.current = engine;
                    if (mode === "LIVE")
                        await this.verifyLive(engine);
                    await engine.start();
                }
                catch (error) {
                    await engine?.stop();
                    this.release();
                    throw error;
                }
                this.store.record("mode_events", undefined, {
                    mode: env.TRADING_MODE,
                    action: "START",
                    session: this.token,
                });
                this.transitioning = false;
                return this.status();
            }
            finally {
                this.transitioning = false;
            }
        });
    }
    stopSafely() {
        return this.serial(async () => {
            this.transitioning = true;
            try {
                if (this.selected === "LIVE") {
                    this.store.set("newEntriesEnabled", false);
                    const blockers = this.blockers();
                    if (blockers.length)
                        throw new Blocked(blockers.join(";"));
                }
                if (this.current) {
                    await this.beforeStop();
                    await this.current.stop();
                }
                if (this.selected === "LIVE" && this.blockers().length) {
                    this.recoveryOnly = true;
                    this.current = this.factory("LIVE");
                    await this.current.start();
                    throw new Blocked(this.blockers().join(";"));
                }
                this.release();
            }
            finally {
                this.transitioning = false;
            }
            return this.status();
        });
    }
    stop() {
        return this.serial(async () => {
            if (this.current) {
                await this.beforeStop();
                await this.current.stop();
            }
            this.release();
            return this.status();
        });
    }
    assertMigrationSafe() {
        const blocks = (this.databases ? [this.databases.demo, this.databases.live] : [this.store]).flatMap(s => kronosMigrationPreflight(s.db).blockers).filter((b) => migrationSafetyCodes.has(b.code));
        if (blocks.length)
            throw new Blocked(blocks.map((b) => b.code + ":" + (b.id ?? b.reason)).join(";"));
    }
    resetDemo(confirmation) {
        return this.serial(async () => {
            if (this.selected !== "DEMO")
                throw new Blocked("DEMO_MODE_REQUIRED");
            if (this.current?.running || this.token)
                throw new Blocked("DEMO_RESET_REQUIRES_STOPPED_ENGINE");
            const session = this.store.db
                .prepare("SELECT pid FROM engine_sessions WHERE state='RUNNING'")
                .get();
            if (session && this.isAlive(Number(session.pid)))
                throw new Blocked("DEMO_RESET_REQUIRES_STOPPED_ENGINE");
            const result = new DemoLedger(this.store.db).reset(confirmation);
            this.current = this.factory("DEMO");
            return {
                accountId: result.id,
                currency: "SOL",
                initialSol: "100",
                initialLamports: "100000000000",
            };
        });
    }
}
