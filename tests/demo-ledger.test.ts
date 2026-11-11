import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  DEMO_INITIAL_LAMPORTS,
  DemoLedger,
  LAMPORTS_PER_SOL,
  demoMigration,
  demoCurrencyMigration,
  type DemoFill,
} from "../src/demo-ledger.js";
function fixture(path = ":memory:") {
  const db = new DatabaseSync(path);
  db.exec(
    "PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY,at INTEGER); CREATE TABLE IF NOT EXISTS executions(state TEXT,payload TEXT);",
  );
  db.exec(demoMigration);
  db.exec(demoCurrencyMigration);
  return { db, ledger: new DemoLedger(db) };
}
const fx = () => ({ price: "100", at: Date.now(), source: "FIXTURE_PRICE" });
function fill(extra: Partial<DemoFill> = {}): DemoFill {
  return {
    executionId: "buy",
    idempotencyKey: "settle:buy",
    positionId: "p",
    mint: "mint",
    side: "BUY",
    requestedAmount: "1000000000",
    executedAmount: "1000000000",
    quantity: "1000",
    grossLamports: "1000000000",
    feeLamports: "1000000",
    decimals: 6,
    fx: fx(),
    quoteAt: Date.now(),
    quoteId: "q",
    estimated: true,
    ...extra,
  };
}
function buy(ledger: DemoLedger) {
  const f = fill();
  ledger.reserve(f.executionId, 1_020_000_000n);
  ledger.settle(f, 45000);
  return f;
}
test("versioned additive migration and funding are repeatable without changing LIVE rows", () => {
  const { db, ledger } = fixture();
  try {
    db.prepare("INSERT INTO executions VALUES('CONFIRMED',?)").run(
      '{"intent":{"mode":"live"},"signature":"real"}',
    );
    const before = db.prepare("SELECT * FROM executions").all();
    const a = ledger.initialize();
    db.exec(demoMigration);
    assert.equal(a.cash, DEMO_INITIAL_LAMPORTS);
    assert.equal(ledger.initialize().id, a.id);
    assert.equal(ledger.account().realized, 0n);
    assert.equal(
      db
        .prepare("SELECT count(*) n FROM demo_ledger WHERE kind='FUNDING'")
        .get()!.n,
      1,
    );
    assert.deepEqual(db.prepare("SELECT * FROM executions").all(), before);
  } finally {
    db.close();
  }
});
test("restart preserves cash/reservations and does not fund again", () => {
  const dir = mkdtempSync(join(tmpdir(), "demo-ledger-test-")),
    path = join(dir, "ledger.sqlite");
  try {
    let f = fixture(path);
    f.ledger.initialize();
    buy(f.ledger);
    const cash = f.ledger.account().cash;
    f.db.close();
    f = fixture(path);
    assert.equal(f.ledger.initialize().cash, cash);
    assert.equal(f.ledger.holdings()[0]!.quantity, "1000");
    f.db.close();
  } finally {
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
    rmSync(dir, { recursive: true, force: true });
  }
});
test("BUY, partial SELL and full SELL allocate entry cost and fees exactly", () => {
  const { db, ledger } = fixture();
  try {
    ledger.initialize();
    buy(ledger);
    assert.equal(ledger.account().cash, 98_999_000_000n);
    ledger.settle(
      fill({
        executionId: "s1",
        idempotencyKey: "settle:s1",
        side: "SELL",
        requestedAmount: "400",
        executedAmount: "400",
        quantity: "400",
        grossLamports: "600000000",
      }),
      45000,
    );
    assert.equal(ledger.holdings()[0]!.quantity, "600");
    assert.equal(ledger.holdings()[0]!.cost, String(600_600_000n));
    assert.equal(ledger.account().realized, 198_600_000n);
    ledger.settle(
      fill({
        executionId: "s2",
        idempotencyKey: "settle:s2",
        side: "SELL",
        requestedAmount: "600",
        executedAmount: "600",
        quantity: "600",
        grossLamports: "900000000",
      }),
      45000,
    );
    assert.equal(ledger.holdings().length, 0);
    assert.equal(ledger.account().cash, 100_497_000_000n);
    assert.equal(ledger.account().realized, 497_000_000n);
  } finally {
    db.close();
  }
});
test("duplicate settlement cannot mint money and conflicting retry is rejected", () => {
  const { db, ledger } = fixture();
  try {
    ledger.initialize();
    const f = buy(ledger),
      before = ledger.account();
    ledger.settle(f, 45000, () => assert.fail("duplicate position callback"));
    assert.deepEqual(ledger.account(), before);
    assert.throws(
      () => ledger.settle({ ...f, quantity: "1001" }, 45000),
      /IDEMPOTENCY_CONFLICT/,
    );
  } finally {
    db.close();
  }
});
test("insufficient SOL, oversell and stale quotes never create a fill", () => {
  const { db, ledger } = fixture();
  try {
    ledger.initialize();
    assert.throws(
      () => ledger.reserve("large", 101_000_000_000n),
      /INSUFFICIENT_CASH/,
    );
    assert.throws(
      () =>
        ledger.settle(
          fill({
            side: "SELL",
            requestedAmount: "1",
            executedAmount: "1",
            quantity: "1",
          }),
          45000,
        ),
      /OVERSELL/,
    );
    assert.throws(
      () => ledger.settle(fill({ quoteAt: Date.now() - 46000 }), 45000),
      /INVALID_FILL/,
    );
    assert.equal(ledger.account().cash, DEMO_INITIAL_LAMPORTS);
    assert.equal(ledger.holdings().length, 0);
  } finally {
    db.close();
  }
});
test("position failure rolls back cash, holding and ledger atomically; release is idempotent", () => {
  const { db, ledger } = fixture();
  try {
    ledger.initialize();
    const f = fill();
    ledger.reserve("buy", 1_020_000_000n);
    assert.throws(
      () =>
        ledger.settle(f, 45000, () => {
          throw Error("crash");
        }),
      /crash/,
    );
    assert.equal(ledger.account().cash, DEMO_INITIAL_LAMPORTS);
    assert.equal(ledger.holdings().length, 0);
    assert.equal(
      db.prepare("SELECT count(*) n FROM demo_ledger WHERE kind='FILL'").get()!
        .n,
      0,
    );
    ledger.release("buy");
    ledger.release("buy");
    assert.equal(ledger.account().reserved, 0n);
  } finally {
    db.close();
  }
});
test("ledger cash deltas reconcile to every balance snapshot and funding is not profit", () => {
  const { db, ledger } = fixture();
  try {
    ledger.initialize();
    buy(ledger);
    let cash = 0n;
    for (const row of db
      .prepare("SELECT payload FROM demo_ledger ORDER BY rowid")
      .all())
      cash += BigInt(JSON.parse(String(row.payload)).cashDelta ?? "0");
    assert.equal(cash, ledger.account().cash);
    assert.equal(ledger.account().realized, 0n);
    assert.equal(ledger.history(0).at(-1)!.cash, String(cash));
    assert.throws(() => ledger.history(0, 1001), /INVALID_HISTORY/);
  } finally {
    db.close();
  }
});
test("reset archives only DEMO and requires confirmation and no pending execution", () => {
  const { db, ledger } = fixture();
  try {
    const old = ledger.initialize();
    buy(ledger);
    assert.throws(() => ledger.reset("yes"), /CONFIRMATION/);
    db.prepare("INSERT INTO executions VALUES('UNKNOWN',?)").run(
      '{"intent":{"mode":"demo"}}',
    );
    assert.throws(() => ledger.reset("RESET DEMO"), /PENDING_EXECUTION/);
    db.exec("DELETE FROM executions");
    const next = ledger.reset("RESET DEMO");
    assert.notEqual(old.id, next.id);
    assert.equal(next.cash, DEMO_INITIAL_LAMPORTS);
    assert.equal(
      db.prepare("SELECT count(*) n FROM demo_accounts").get()!.n,
      2,
    );
    assert.equal(
      db
        .prepare("SELECT count(*) n FROM demo_holdings WHERE account_id=?")
        .get(old.id)!.n,
      1,
    );
    assert.equal(ledger.holdings().length, 0);
  } finally {
    db.close();
  }
});

test("100 SOL funding and settlement use exact lamports independently of USD prices", () => {
  for (const price of [
    undefined,
    "1",
    "100",
    "9999.123456789012345678901234",
  ]) {
    const { db, ledger } = fixture();
    try {
      ledger.initialize();
      assert.equal(ledger.balance(), 100n * LAMPORTS_PER_SOL);
      const f = fill({ fx: price ? { ...fx(), price } : undefined });
      ledger.reserve(f.executionId, 1_020_000_000n);
      ledger.settle(f, 45000);
      assert.equal(ledger.balance(), 98_999_000_000n);
      assert.equal(ledger.holdings()[0]!.cost, "1001000000");
      assert.equal(ledger.account().currency, "SOL");
    } finally {
      db.close();
    }
  }
});
test("legacy USD account fails closed without reinterpretation or additional funding", () => {
  const { db, ledger } = fixture();
  try {
    db.prepare(
      "INSERT INTO demo_accounts VALUES('legacy','demo','1000000000000000','0','0','1000000000000000',1,NULL)",
    ).run();
    db.exec(demoCurrencyMigration);
    assert.throws(() => ledger.initialize(), /LEGACY_CURRENCY_REQUIRES_RESET/);
    assert.equal(
      db.prepare("SELECT cash FROM demo_accounts WHERE id='legacy'").get()!
        .cash,
      "1000000000000000",
    );
    assert.equal(db.prepare("SELECT count(*) n FROM demo_ledger").get()!.n, 0);
  } finally {
    db.close();
  }
});
