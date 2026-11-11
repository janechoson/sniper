import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertResetSafe,
  resetStrategyData,
} from "../scripts/reset-strategy-data.js";
import { Store } from "../src/store.js";
import { candidate, position } from "./fixtures.js";

test("History preserves canonical final-close ordering and ignores valuation observations", () => {
  const db = new Store(":memory:");
  try {
    const a = {
      ...position(),
      id: "A",
      mode: "demo" as const,
      state: "CLOSED" as const,
      entryAt: 1000,
      quantity: "0",
    };
    const b = { ...a, id: "B", entryAt: 2000 };
    const c = { ...a, id: "C", entryAt: 3000 };
    // Deliberately non-chronological insertion order.
    for (const p of [b, a, c]) db.savePosition(p);
    assert.deepEqual(
      db.history("demo").map((p) => p.id),
      ["C", "B", "A"],
    );
    db.savePosition({
      ...a,
      lastQuoteAt: 999999,
      lastValueLamports: "123",
      realizedLamports: "99",
    });
    assert.deepEqual(
      db.history("demo").map((p) => p.id),
      ["C", "B", "A"],
    );
    db.savePosition({
      ...a,
      state: "OPEN",
      quantity: "500",
      remainingCostLamports: "500",
      lastQuoteAt: 1000000,
    });
    assert.deepEqual(
      db.history("demo", { state: "OPEN" }).map((p) => p.id),
      ["A"],
    );
    assert.deepEqual(
      db.history("demo").map((p) => p.id),
      ["C", "B"],
    );
    db.savePosition({ ...a, closedAt: 2000000 } as typeof a);
    assert.deepEqual(
      db.history("demo").map((p) => p.id),
      ["A", "C", "B"],
    );
    db.savePosition({ ...b, id: "B-tie" });
    db.savePosition({ ...c, id: "newer-open", state: "OPEN" });
    db.savePosition({ ...c, id: "newer-other-mode", mode: "live" });
    db.savePosition({ ...c, id: "no-fill", originalQuantity: "0" });
    assert.deepEqual(
      db.history("demo", { limit: 2, offset: 1 }).map((p) => p.id),
      ["C", "B-tie"],
    );
    assert.deepEqual(
      db.history("demo", { state: "OPEN", limit: 1 }).map((p) => p.id),
      ["newer-open"],
    );
    assert.throws(
      () => db.history("demo", { offset: -1 }),
      /INVALID_HISTORY_PAGE/,
    );
    db.savePosition({ ...c, id: "D", entryAt: 4000 });
    assert.equal(db.history("demo")[0]!.id, "A");
  } finally {
    db.close();
  }
});

for (const state of [
  "UNKNOWN",
  "SIGNED_UNKNOWN",
  "SUBMITTED",
  "PENDING_CONFIRMATION",
  "AMBIGUOUS",
  "RECONCILING",
  "CREATED",
]) {
  test(`reset refuses ${state} and preserves reconciliation evidence`, () => {
    const db = new Store(":memory:");
    try {
      db.discover(candidate());
      db.db
        .prepare("INSERT INTO executions VALUES(?,?,?,?,?)")
        .run(
          "pending",
          "intent",
          state,
          "signed-fixture",
          JSON.stringify({ state }),
        );
      assert.throws(
        () =>
          resetStrategyData(db.db, {
            backupVerified: true,
            backupPath: "fixture",
          }),
        /RESET_ABORT_UNMAPPED_TABLE/,
      );
      assert.equal(db.tokens().length, 1);
      assert.equal(
        Number(db.db.prepare("SELECT count(*) n FROM executions").get()!.n),
        1,
      );
      assert(
        db.db
          .prepare(
            "SELECT name FROM sqlite_master WHERE name='trade_learning_samples_immutable_delete'",
          )
          .get(),
      );
    } finally {
      db.close();
    }
  });
}

test("pending Position or orphan submitted manual request independently aborts reset", () => {
  const db = new Store(":memory:");
  try {
    db.savePosition({ ...position(), state: "PENDING_EXIT" });
    assert.throws(() => assertResetSafe(db.db), /RESET_ABORT/);
    db.db.exec("DELETE FROM positions");
    db.db
      .prepare("INSERT INTO manual_exits VALUES(?,?,?,?,?)")
      .run("manual", "p", "live", "SUBMITTED", "{}");
    assert.throws(() => assertResetSafe(db.db), /RESET_ABORT/);
  } finally {
    db.close();
  }
});

test("legacy destructive reset fails closed on new financial tables and preserves immutable triggers", () => {
  const db = new Store(":memory:");
  try {
    db.discover(candidate());
    db.savePosition(position());
    db.db.exec(
      "CREATE TRIGGER refuse_position_reset BEFORE DELETE ON positions BEGIN SELECT RAISE(ABORT,'fixture failure'); END;",
    );
    assert.throws(
      () =>
        resetStrategyData(db.db, {
          backupVerified: true,
          backupPath: "fixture",
        }),
      /RESET_ABORT_UNMAPPED_TABLE/,
    );
    assert.equal(db.tokens().length, 1);
    assert.equal(
      Number(db.db.prepare("SELECT count(*) n FROM positions").get()!.n),
      1,
    );
    assert(
      db.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='trade_learning_samples_immutable_delete'",
        )
        .get(),
    );
  } finally {
    db.close();
  }
});
