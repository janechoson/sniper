import { randomUUID, createHash } from "node:crypto";
import { Blocked } from "./domain.js";
import { ratioDecimal } from "./trade-accounting.js";
export const LAMPORTS_PER_SOL = 1000000000n;
export const DEMO_INITIAL_LAMPORTS = 100n * LAMPORTS_PER_SOL;
export const demoMigration = `
CREATE TABLE IF NOT EXISTS demo_accounts(id TEXT PRIMARY KEY,mode TEXT NOT NULL CHECK(mode='demo'),cash TEXT NOT NULL,reserved TEXT NOT NULL,realized TEXT NOT NULL,initial TEXT NOT NULL,created_at INTEGER NOT NULL,archived_at INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS demo_current_account ON demo_accounts(mode) WHERE archived_at IS NULL;
CREATE TABLE IF NOT EXISTS demo_ledger(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES demo_accounts(id),idempotency_key TEXT UNIQUE NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL,at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS demo_ledger_account_time ON demo_ledger(account_id,at);
CREATE TABLE IF NOT EXISTS demo_holdings(account_id TEXT NOT NULL REFERENCES demo_accounts(id),position_id TEXT NOT NULL,mint TEXT NOT NULL,quantity TEXT NOT NULL,cost TEXT NOT NULL,PRIMARY KEY(account_id,position_id));
CREATE TABLE IF NOT EXISTS demo_reservations(execution_id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES demo_accounts(id),amount TEXT NOT NULL,active INTEGER NOT NULL,payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS demo_balance_snapshots(id INTEGER PRIMARY KEY,account_id TEXT NOT NULL REFERENCES demo_accounts(id),at INTEGER NOT NULL,cash TEXT NOT NULL,reserved TEXT NOT NULL,realized TEXT NOT NULL,equity TEXT,payload TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS demo_snapshot_time ON demo_balance_snapshots(account_id,at);
INSERT OR IGNORE INTO migrations VALUES(13,unixepoch());`;
/** Additive currency metadata: historical USD balances are never reinterpreted as SOL. */
export const demoCurrencyMigration = `CREATE TABLE IF NOT EXISTS demo_account_units(account_id TEXT PRIMARY KEY REFERENCES demo_accounts(id),currency TEXT NOT NULL CHECK(currency IN ('USD','SOL')),atomic_decimals INTEGER NOT NULL);
INSERT OR IGNORE INTO demo_account_units SELECT id,'USD',12 FROM demo_accounts;
INSERT OR IGNORE INTO migrations VALUES(16,unixepoch());`;
function atomic(db, fn) {
    if (db.isTransaction)
        return fn();
    db.exec("BEGIN IMMEDIATE");
    try {
        const result = fn();
        db.exec("COMMIT");
        return result;
    }
    catch (e) {
        db.exec("ROLLBACK");
        throw e;
    }
}
function unsigned(value) {
    if (typeof value !== "string" || !/^\d+$/.test(value))
        throw new Blocked("DEMO_INVALID_ATOMIC_AMOUNT");
    return BigInt(value);
}
export function freshFx(fx, maxAgeMs, now = Date.now()) {
    if (!fx ||
        !/^\d+(\.\d{1,24})?$/.test(fx.price) ||
        !fx.source ||
        !Number.isFinite(fx.at) ||
        fx.at > now ||
        now - fx.at > maxAgeMs)
        throw new Blocked("DEMO_FRESH_FX_REQUIRED");
    const [whole, fraction = ""] = fx.price.split(".");
    const n = BigInt(whole + fraction), d = 10n ** BigInt(fraction.length);
    if (n <= 0n)
        throw new Blocked("DEMO_FRESH_FX_REQUIRED");
    return { n, d };
}
export class DemoLedger {
    db;
    constructor(db) {
        this.db = db;
    }
    account() {
        const row = this.db
            .prepare("SELECT * FROM demo_accounts WHERE archived_at IS NULL")
            .get();
        if (!row)
            throw new Blocked("DEMO_ACCOUNT_NOT_INITIALIZED");
        const units = this.db
            .prepare("SELECT currency,atomic_decimals FROM demo_account_units WHERE account_id=?")
            .get(String(row.id));
        if (units?.currency !== "SOL" || units.atomic_decimals !== 9)
            throw new Blocked("DEMO_LEGACY_CURRENCY_REQUIRES_RESET");
        return {
            currency: "SOL",
            id: String(row.id),
            cash: unsigned(row.cash),
            reserved: unsigned(row.reserved),
            realized: BigInt(String(row.realized)),
            initial: unsigned(row.initial),
            createdAt: Number(row.created_at),
        };
    }
    initialize() {
        return atomic(this.db, () => {
            if (this.db
                .prepare("SELECT 1 FROM demo_accounts WHERE archived_at IS NULL")
                .get())
                return this.account();
            const id = randomUUID(), at = Date.now();
            this.db
                .prepare("INSERT INTO demo_accounts VALUES(?,'demo',?,'0','0',?,?,NULL)")
                .run(id, String(DEMO_INITIAL_LAMPORTS), String(DEMO_INITIAL_LAMPORTS), at);
            this.db
                .prepare("INSERT INTO demo_account_units VALUES(?,'SOL',9)")
                .run(id);
            this.event(id, `fund:${id}`, "FUNDING", {
                mode: "demo",
                currency: "SOL",
                atomicDecimals: 9,
                cashDelta: String(DEMO_INITIAL_LAMPORTS),
                initialFunding: true,
            }, at);
            this.snapshot();
            return this.account();
        });
    }
    balance() {
        // Existing Store.reserved() subtracts pending BUY lamports; do not subtract them twice.
        return this.account().cash;
    }
    event(account, key, kind, payload, at = Date.now()) {
        this.db
            .prepare("INSERT INTO demo_ledger VALUES(?,?,?,?,?,?)")
            .run(randomUUID(), account, key, kind, JSON.stringify(payload), at);
    }
    reserve(executionId, lamports) {
        return atomic(this.db, () => {
            const a = this.account(), amount = unsigned(String(lamports));
            const previous = this.db
                .prepare("SELECT * FROM demo_reservations WHERE execution_id=?")
                .get(executionId);
            if (previous) {
                if (previous.account_id !== a.id ||
                    previous.amount !== String(amount) ||
                    !previous.active)
                    throw new Blocked("DEMO_RESERVATION_CONFLICT");
                return;
            }
            if (amount > a.cash - a.reserved)
                throw new Blocked("DEMO_INSUFFICIENT_CASH");
            this.db
                .prepare("INSERT INTO demo_reservations VALUES(?,?,?,1,?)")
                .run(executionId, a.id, String(amount), JSON.stringify({ currency: "SOL", lamports: String(lamports) }));
            this.db
                .prepare("UPDATE demo_accounts SET reserved=? WHERE id=?")
                .run(String(a.reserved + amount), a.id);
            this.event(a.id, `reserve:${executionId}`, "RESERVE", {
                executionId,
                reservedDelta: String(amount),
                cashDelta: "0",
            });
            this.snapshot();
        });
    }
    release(executionId) {
        return atomic(this.db, () => {
            const r = this.db
                .prepare("SELECT * FROM demo_reservations WHERE execution_id=? AND active=1")
                .get(executionId);
            if (!r)
                return;
            const a = this.account();
            if (r.account_id !== a.id || unsigned(r.amount) > a.reserved)
                throw new Blocked("DEMO_RESERVATION_CORRUPT");
            this.db
                .prepare("UPDATE demo_accounts SET reserved=? WHERE id=?")
                .run(String(a.reserved - unsigned(r.amount)), a.id);
            this.db
                .prepare("UPDATE demo_reservations SET active=0 WHERE execution_id=?")
                .run(executionId);
            this.event(a.id, `release:${executionId}`, "RELEASE", {
                executionId,
                reservedDelta: String(-unsigned(r.amount)),
                cashDelta: "0",
            });
            this.snapshot();
        });
    }
    settle(fill, maxAgeMs, updatePosition = () => { }) {
        return atomic(this.db, () => {
            const fingerprint = createHash("sha256")
                .update(JSON.stringify(fill))
                .digest("hex");
            const existing = this.db
                .prepare("SELECT payload FROM demo_ledger WHERE idempotency_key=?")
                .get(fill.idempotencyKey);
            if (existing) {
                const payload = JSON.parse(String(existing.payload));
                if (payload.accountId !== this.account().id ||
                    payload.fingerprint !== fingerprint)
                    throw new Blocked("DEMO_IDEMPOTENCY_CONFLICT");
                return payload;
            }
            const a = this.account(), quantity = unsigned(fill.quantity), gross = unsigned(fill.grossLamports), fee = unsigned(fill.feeLamports);
            if (!quantity ||
                !gross ||
                !fill.estimated ||
                !fill.quoteId ||
                !Number.isInteger(fill.decimals) ||
                fill.decimals < 0 ||
                fill.decimals > 255 ||
                !Number.isFinite(fill.quoteAt) ||
                fill.quoteAt > Date.now() ||
                Date.now() - fill.quoteAt > maxAgeMs ||
                unsigned(fill.requestedAmount) !== unsigned(fill.executedAmount) ||
                (fill.side === "BUY" ? gross : quantity) !==
                    unsigned(fill.requestedAmount))
                throw new Blocked("DEMO_INVALID_FILL");
            const holding = this.db
                .prepare("SELECT * FROM demo_holdings WHERE account_id=? AND position_id=?")
                .get(a.id, fill.positionId);
            const oldQuantity = holding ? unsigned(holding.quantity) : 0n;
            const oldCost = holding ? unsigned(holding.cost) : 0n;
            if (holding && holding.mint !== fill.mint)
                throw new Blocked("DEMO_HOLDING_MISMATCH");
            let cashDelta, newQuantity, cost, realized = 0n;
            if (fill.side === "BUY") {
                if (oldQuantity)
                    throw new Blocked("DEMO_DUPLICATE_POSITION");
                cashDelta = -gross - fee;
                newQuantity = quantity;
                cost = -cashDelta;
            }
            else {
                if (!holding || quantity > oldQuantity || !oldQuantity)
                    throw new Blocked("DEMO_OVERSELL");
                cashDelta = gross - fee;
                const allocated = (oldCost * quantity) / oldQuantity;
                newQuantity = oldQuantity - quantity;
                cost = oldCost - allocated;
                realized = cashDelta - allocated;
            }
            const reservation = this.db
                .prepare("SELECT amount FROM demo_reservations WHERE execution_id=? AND account_id=? AND active=1")
                .get(fill.executionId, a.id);
            const released = reservation ? unsigned(reservation.amount) : 0n;
            if (fill.side === "BUY" && (!reservation || -cashDelta > released))
                throw new Blocked("DEMO_FILL_EXCEEDS_RESERVATION");
            const cash = a.cash + cashDelta, reserved = a.reserved - released;
            if (reserved < 0n || cash < reserved)
                throw new Blocked("DEMO_INSUFFICIENT_CASH");
            this.db
                .prepare("UPDATE demo_accounts SET cash=?,reserved=?,realized=? WHERE id=?")
                .run(String(cash), String(reserved), String(a.realized + realized), a.id);
            this.db
                .prepare("INSERT INTO demo_holdings VALUES(?,?,?,?,?) ON CONFLICT(account_id,position_id) DO UPDATE SET quantity=excluded.quantity,cost=excluded.cost")
                .run(a.id, fill.positionId, fill.mint, String(newQuantity), String(cost));
            if (reservation)
                this.db
                    .prepare("UPDATE demo_reservations SET active=0 WHERE execution_id=?")
                    .run(fill.executionId);
            let price;
            if (fill.fx) {
                try {
                    price = freshFx(fill.fx, maxAgeMs);
                }
                catch {
                    /* Optional USD reporting cannot alter SOL settlement. */
                }
            }
            const payload = {
                ...fill,
                fingerprint,
                mode: "demo",
                accountId: a.id,
                status: "CONFIRMED",
                currency: "SOL",
                atomicDecimals: 9,
                priceSol: ratioDecimal(gross * 10n ** BigInt(fill.decimals), quantity * LAMPORTS_PER_SOL),
                priceUsd: price
                    ? ratioDecimal(gross * price.n * 10n ** BigInt(fill.decimals), quantity * price.d * LAMPORTS_PER_SOL)
                    : null,
                priceBasis: "JUPITER_MINIMUM_OUTPUT_ESTIMATE",
                cashDelta: String(cashDelta),
                tokenDelta: String(fill.side === "BUY" ? quantity : -quantity),
                realizedDelta: String(realized),
                reservedDelta: String(-released),
                estimatedFeeLamports: String(fee),
                rounding: "NATIVE_SOL_LAMPORTS_EXACT",
                at: Date.now(),
            };
            this.event(a.id, fill.idempotencyKey, "FILL", payload, payload.at);
            updatePosition(); // Same SQLite transaction as the ledger; any failure rolls everything back.
            this.snapshot();
            return payload;
        });
    }
    snapshot(equity, metadata = {}) {
        const a = this.account();
        if (equity === undefined && !this.holdings().length)
            equity = a.cash;
        this.db
            .prepare("INSERT INTO demo_balance_snapshots(account_id,at,cash,reserved,realized,equity,payload) VALUES(?,?,?,?,?,?,?)")
            .run(a.id, Date.now(), String(a.cash), String(a.reserved), String(a.realized), equity === undefined ? null : String(equity), JSON.stringify(metadata));
    }
    holdings() {
        return this.db
            .prepare("SELECT * FROM demo_holdings WHERE account_id=? AND quantity<>'0'")
            .all(this.account().id);
    }
    history(since, limit = 288) {
        if (!Number.isSafeInteger(since) ||
            since < 0 ||
            !Number.isSafeInteger(limit) ||
            limit < 1 ||
            limit > 1000)
            throw new Blocked("DEMO_INVALID_HISTORY_RANGE");
        return this.db
            .prepare("SELECT * FROM demo_balance_snapshots WHERE account_id=? AND at>=? ORDER BY id DESC LIMIT ?")
            .all(this.account().id, since, limit)
            .reverse();
    }
    reset(confirmation) {
        if (confirmation !== "RESET DEMO")
            throw new Blocked("DEMO_RESET_CONFIRMATION_REQUIRED");
        return atomic(this.db, () => {
            const a = this.account();
            if (a.reserved ||
                this.db
                    .prepare("SELECT 1 FROM executions WHERE json_extract(payload,'$.intent.mode')='demo' AND state NOT IN ('CONFIRMED','FAILED') LIMIT 1")
                    .get())
                throw new Blocked("DEMO_RESET_PENDING_EXECUTION");
            this.event(a.id, `archive:${a.id}`, "RESET_ARCHIVE", {
                cashDelta: "0",
                mode: "demo",
                reason: "USER_CONFIRMED_RESET",
            });
            this.db
                .prepare("UPDATE demo_accounts SET archived_at=? WHERE id=?")
                .run(Date.now(), a.id);
            // Discard only transient DEMO discovery state. Ledger, executions, positions and attempts stay archived.
            if (this.db
                .prepare("SELECT 1 FROM sqlite_master WHERE name='mode_tokens'")
                .get()) {
                this.db.exec("DELETE FROM mode_tokens WHERE mode='demo'; DELETE FROM candidate_lifecycle WHERE mode='demo'; UPDATE trending_appearances SET consumed=1 WHERE mode='demo'; UPDATE buy_ownership_claims SET active=0,payload=json_set(payload,'$.active',json('false'),'$.resolution','DEMO_ACCOUNT_ARCHIVED') WHERE mode='demo' AND active=1;");
                for (const row of this.db
                    .prepare("SELECT payload FROM manual_exits WHERE mode='demo' AND state NOT IN ('CONFIRMED','CANCELLED','FAILED')")
                    .all()) {
                    const r = JSON.parse(String(row.payload));
                    r.state = "CANCELLED";
                    r.error = "DEMO_ACCOUNT_ARCHIVED";
                    this.db
                        .prepare("UPDATE manual_exits SET state='CANCELLED',payload=? WHERE id=?")
                        .run(JSON.stringify(r), r.id);
                }
            }
            return this.initialize(); // All old ledger/holdings stay archived and queryable.
        });
    }
}
