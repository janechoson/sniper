import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { kronosMigrationPreflight } from "../src/kronos-migration-preflight.js";

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE positions(id TEXT,mode TEXT,state TEXT,payload TEXT);
    CREATE TABLE executions(id TEXT,state TEXT,signature TEXT,payload TEXT);
    CREATE TABLE manual_exits(id TEXT,mode TEXT,state TEXT);
    CREATE TABLE buy_ownership_claims(id TEXT,mode TEXT,active INTEGER,payload TEXT);`);
  return db;
}
function position(db: DatabaseSync, overrides: Record<string, unknown>) {
  const p = {
    id: "p",
    mode: "live",
    state: "OPEN",
    strategy: "KRONOS",
    quantity: "10",
    ...overrides,
  };
  db.prepare("INSERT INTO positions VALUES(?,?,?,?)").run(
    p.id,
    p.mode,
    p.state,
    JSON.stringify(p),
  );
}
function inspect(db: DatabaseSync) {
  db.exec("PRAGMA query_only=ON");
  return kronosMigrationPreflight(db);
}
test("preflight is read-only and permits settled historical STANDARD accounting", () => {
  const db = fixture();
  try {
    position(db, { strategy: "STANDARD", state: "CLOSED", quantity: "0" });
    const before = db.prepare("SELECT * FROM positions").all();
    assert.equal(inspect(db).eligible, true);
    assert.deepEqual(db.prepare("SELECT * FROM positions").all(), before);
  } finally {
    db.close();
  }
});
for (const strategy of ["STANDARD", undefined])
  test(`preflight blocks unresolved legacy LIVE owner ${String(strategy)}, including dismissed rows`, () => {
    const db = fixture();
    try {
      position(db, { strategy, dismissal: { at: 1 } });
      assert.ok(
        inspect(db).blockers.some(
          (b) => b.code === "LIVE_STANDARD_POSITION_REQUIRES_RESOLUTION",
        ),
      );
    } finally {
      db.close();
    }
  });
for (const state of [
  "UNKNOWN",
  "SUBMITTED",
  "PENDING_CONFIRMATION",
  "CREATED",
  "AMBIGUOUS",
])
  test(`preflight blocks ${state} execution without changing state`, () => {
    const db = fixture();
    try {
      const e = { state, signature: "receipt", intent: { mode: "live" } };
      db.prepare("INSERT INTO executions VALUES(?,?,?,?)").run(
        "e",
        state,
        e.signature,
        JSON.stringify(e),
      );
      assert.ok(
        inspect(db).blockers.some(
          (b) => b.code === "EXECUTION_RECOVERY_REQUIRED",
        ),
      );
      assert.equal(
        db.prepare("SELECT state FROM executions").get()!.state,
        state,
      );
    } finally {
      db.close();
    }
  });
test("open KRONOS positions retain their owner and are compatible with removal", () => {
  const db = fixture();
  try {
    position(db, {});
    assert.equal(inspect(db).eligible, true);
  } finally {
    db.close();
  }
});
for (const overrides of [
  { state: "CLOSED" },
  { state: "FAILED" },
  { mode: "unknown" },
  { quantity: "-1" },
  { quantity: "1.1" },
  { quantity: undefined },
  { mode: "paper" },
  { state: "PENDING_EXIT" },
])
  test(`preflight fails closed on unsafe position ${JSON.stringify(overrides)}`, () => {
    const db = fixture();
    try {
      position(db, overrides);
      assert.equal(inspect(db).eligible, false);
    } finally {
      db.close();
    }
  });
test("missing schema and malformed evidence never count as a passing check", () => {
  const empty = new DatabaseSync(":memory:");
  try {
    assert.equal(inspect(empty).eligible, false);
  } finally {
    empty.close();
  }
  const db = fixture();
  try {
    db.prepare("INSERT INTO positions VALUES('p','live','OPEN','null')").run();
    assert.equal(inspect(db).eligible, false);
  } finally {
    db.close();
  }
});
test("active legacy claim and manual SELL require review", () => {
  const db = fixture();
  try {
    db.exec(`INSERT INTO manual_exits VALUES('m','live','REQUESTED');
      INSERT INTO buy_ownership_claims VALUES('c','live',1,'{}');`);
    const codes = inspect(db).blockers.map((b) => b.code);
    assert.ok(codes.includes("MANUAL_EXIT_REVIEW_REQUIRED"));
    assert.ok(codes.includes("LEGACY_ACTIVE_BUY_CLAIM_REQUIRES_REVIEW"));
  } finally {
    db.close();
  }
});
