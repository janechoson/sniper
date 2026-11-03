import { test } from "node:test";
import assert from "node:assert/strict";
import { mockExecutionCase, setup } from "./one-shot-fixtures.js";
import { MINT } from "./fixtures.js";
import { known, unknown } from "../src/domain.js";

// Replaces the former PRE_WATCH -> ten-minute Watch integration contract.
// Full Jupiter safety, ownership and security vetoes remain exercised by mocks.
test("Trending reaches all required gates once; there is no Watch admission or retry timer", async () => {
  const f = mockExecutionCase();
  try {
    await f.e.analyze(MINT);
    const a = f.e.attempts.current!;
    assert.equal(a.result, "BOUGHT");
    assert.deepEqual(
      a.logs
        .filter((l) => l.status === "CHECKING")
        .map((l) => l.stage)
        .filter((s) => s !== "KRONOS")
        .filter((s, i, all) => i === 0 || s !== all[i - 1])
        .slice(0, 11),
      [
        "CHEAP_FILTER",
        "SECURITY",
        "COMPATIBILITY",
        "HISTORY",
        "CAPITAL_FLOW",
        "COMMON_RISK",
        "STRUCTURE",
        "JEV",
        "RISK",
        "FINAL_ANALYSIS",
        "OWNERSHIP_CAPITAL",
      ],
    );
    assert.equal(
      f.store.db.prepare("SELECT count(*) n FROM entry_structure_watch").get()!
        .n,
      0,
    );
    assert.equal(f.e.candidates.list().length, 0);
  } finally {
    await f.close();
  }
});
for (const failure of [
  "SECURITY",
  "COMPATIBILITY",
  "OWNERSHIP",
  "CAPITAL",
  "JEV",
  "STRUCTURE",
  "EXIT",
  "SIMULATE",
  "PRE_SIGN",
] as const)
  test(
    "fresh Trending " +
      failure +
      " failure ends immediately with no signing or Watch",
    async () => {
      const f = mockExecutionCase(failure);
      try {
        await assert.rejects(f.e.analyze(MINT));
        assert.equal(f.stats().signed, 0);
        assert.equal(f.e.attempts.current!.result, "REJECTED");
        assert.equal(f.e.candidates.list().length, 0);
        assert.equal(
          f.store.db
            .prepare("SELECT count(*) n FROM entry_structure_watch")
            .get()!.n,
          0,
        );
      } finally {
        await f.close();
      }
    },
  );
test("reject history does not veto next fresh security evaluation", async () => {
  const options = { badSecurity: true };
  const f = setup(options);
  try {
    await assert.rejects(f.engine.analyze(MINT));
    const old = f.engine.attempts.current!.attemptId;
    options.badSecurity = false;
    await f.engine.analyze(MINT);
    assert.notEqual(f.engine.attempts.current!.attemptId, old);
    assert.equal(f.engine.attempts.current!.result, "BOUGHT");
    assert.equal(f.p.calls.filter((a) => a[1] === "security").length, 3);
  } finally {
    await f.engine.stop();
    f.store.close();
  }
});
test("fresh final holders supersede earlier safe concentration and prevent a signature", async () => {
  const f = mockExecutionCase();
  const intelligence = f.e.gmgn.intelligence.bind(f.e.gmgn);
  let calls = 0;
  f.e.gmgn.intelligence = async (...args) => {
    const i = await intelligence(...args);
    if (++calls > 1) i.holders.top1 = known(90);
    return i;
  };
  try {
    await assert.rejects(f.e.analyze(MINT));
    assert.equal(f.stats().signed, 0);
    assert.equal(f.e.attempts.current!.failedStage, "FINAL_ANALYSIS");
    assert.match(f.e.attempts.current!.reasonCode!, /concentration/);
  } finally {
    await f.close();
  }
});
test("unknown critical endpoint evidence is not replaced with old listing PASS", async () => {
  const f = mockExecutionCase();
  const security = f.e.gmgn.security.bind(f.e.gmgn);
  f.e.gmgn.security = async (...args) => ({
    ...(await security(...args)),
    mintRenounced: unknown(),
    freezeRenounced: unknown(),
  });
  try {
    await assert.rejects(f.e.analyze(MINT));
    assert.equal(f.e.attempts.current!.failedStage, "SECURITY");
    assert.equal(f.stats().signed, 0);
    assert.equal(f.e.attempts.current!.stages.JEV, "PENDING");
  } finally {
    await f.close();
  }
});
