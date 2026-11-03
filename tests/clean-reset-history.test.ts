import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { TradingMemory } from "../src/trading-memory.js";
import { SniperStructure } from "../src/sniper-structure.js";
import {
  resetStrategyData,
  assertResetSafe,
} from "../scripts/reset-strategy-data.js";
import { completedFixture } from "./learning-fixtures.js";
import { candidate, position, settings, snapshot } from "./fixtures.js";

test("History is opening-time DESC/id DESC, filters before pages; observations and partial/full exits do not move older positions", () => {
  const db = new Store(":memory:");
  try {
    const a = {
      ...position(),
      id: "A",
      mode: "paper" as const,
      state: "CLOSED" as const,
      entryAt: 1000,
      quantity: "0",
    };
    const b = { ...a, id: "B", entryAt: 2000 };
    const c = { ...a, id: "C", entryAt: 3000 };
    // Deliberately non-chronological insertion order.
    for (const p of [b, a, c]) db.savePosition(p);
    assert.deepEqual(
      db.history("paper").map((p) => p.id),
      ["C", "B", "A"],
    );
    db.savePosition({
      ...a,
      lastQuoteAt: 999999,
      lastValueLamports: "123",
      realizedLamports: "99",
    });
    assert.deepEqual(
      db.history("paper").map((p) => p.id),
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
      db.history("paper", { state: "OPEN" }).map((p) => p.id),
      ["A"],
    );
    assert.deepEqual(
      db.history("paper").map((p) => p.id),
      ["C", "B"],
    );
    db.savePosition({ ...a, closedAt: 2000000 } as typeof a);
    assert.deepEqual(
      db.history("paper").map((p) => p.id),
      ["C", "B", "A"],
    );
    db.savePosition({ ...b, id: "B-tie" });
    db.savePosition({ ...c, id: "newer-open", state: "OPEN" });
    db.savePosition({ ...c, id: "newer-other-mode", mode: "live" });
    db.savePosition({ ...c, id: "no-fill", originalQuantity: "0" });
    assert.deepEqual(
      db.history("paper", { limit: 2, offset: 1 }).map((p) => p.id),
      ["B-tie", "B"],
    );
    assert.deepEqual(
      db.history("paper", { state: "OPEN", limit: 1 }).map((p) => p.id),
      ["newer-open"],
    );
    assert.throws(
      () => db.history("paper", { offset: -1 }),
      /INVALID_HISTORY_PAGE/,
    );
    db.savePosition({ ...c, id: "D", entryAt: 4000 });
    assert.equal(db.history("paper")[0]!.id, "D");
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
        /RESET_ABORT_UNRESOLVED_TRANSACTION/,
      );
      assert.equal(db.tokens().length, 1);
      assert.equal(db.executions().length, 1);
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

test("reset requires backup, clears real Memory/Runner retrieval and Watch/tombstones while preserving config/schema/safety", () => {
  const db = new Store(":memory:"),
    memory = new TradingMemory(db);
  try {
    completedFixture(memory);
    db.discover(candidate());
    db.savePosition({ ...position(), mode: "paper" });
    new SniperStructure(db, () => settings).admit(candidate(), {
      authorityRevision: 0,
      snapshotHash: "fixture",
    });
    db.set("candidateAuthority:paper:old", {
      revision: 5,
      entryWatchDismissedAt: 1,
    });
    db.set("learningPostAttempt:old", 123);
    db.set("faultMetrics", { old: 99 });
    db.set("paperCash", "999");
    db.set("strategyV2", settings);
    db.set("walletKeyReference", "fixture-reference");
    db.set("controlledLiveRunV1", { status: "COMPLETE", consumed: true });
    db.set("haltReason", "preserved safety");
    const schema = db.db
      .prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name")
      .all();
    const migrations = db.db
      .prepare("SELECT * FROM migrations ORDER BY version")
      .all();
    assert.throws(
      () => resetStrategyData(db.db, { backupVerified: false, backupPath: "" }),
      /BACKUP_REQUIRED/,
    );
    const result = resetStrategyData(db.db, {
      backupVerified: true,
      backupPath: "fixture",
    });
    assert(Object.values(result.after).every((n) => n === 0));
    assert.deepEqual(
      db.db
        .prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name")
        .all(),
      schema,
    );
    assert.deepEqual(
      db.db.prepare("SELECT * FROM migrations ORDER BY version").all(),
      migrations,
    );
    assert.deepEqual(db.get("strategyV2"), settings);
    assert.equal(db.get("walletKeyReference"), "fixture-reference");
    assert.deepEqual(db.get("controlledLiveRunV1"), {
      status: "COMPLETE",
      consumed: true,
    });
    assert.equal(db.get("haltReason"), "preserved safety");
    assert.equal(db.entriesEnabled(), false);
    assert.equal(db.get("candidateAuthority:paper:old"), undefined);
    assert.equal(memory.retrieve(snapshot(), "paper").similarTrades, 0);
    assert.equal(memory.runner.similar(position(), undefined).similarTrades, 0);
    assert.equal(memory.report("paper").completedTrades, 0);
    assert.equal(new SniperStructure(db, () => settings).list().length, 0);
    assert.equal(db.history("paper").length, 0);
    assert.equal(
      db.db.prepare("PRAGMA integrity_check").get()!.integrity_check,
      "ok",
    );
  } finally {
    db.close();
  }
});

test("unexpected failure rolls back deletions and immutable trigger removal together", () => {
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
      /fixture failure/,
    );
    assert.equal(db.tokens().length, 1);
    assert.equal(db.positions().length, 1);
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
