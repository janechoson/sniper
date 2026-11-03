import { test } from "node:test";
import assert from "node:assert/strict";
import { mockExecutionCase } from "./one-shot-fixtures.js";
import { MINT } from "./fixtures.js";

// The removed Watch bypass contract is replaced with production one-shot checks.
// Legacy source is retained in data/backups/one-shot-tests for audit.
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
  test("legacy recovery flag cannot bypass one-shot " + failure, async () => {
    const old = process.env.TEMP_BYPASS_RECOVERY_GUARD;
    process.env.TEMP_BYPASS_RECOVERY_GUARD = "true";
    const f = mockExecutionCase(failure);
    try {
      await assert.rejects(f.e.analyze(MINT));
      assert.equal(f.stats().signed, 0);
      assert.equal(f.e.attempts.current!.result, "REJECTED");
      assert.equal(f.e.candidates.list().length, 0);
    } finally {
      await f.close();
      if (old === undefined) delete process.env.TEMP_BYPASS_RECOVERY_GUARD;
      else process.env.TEMP_BYPASS_RECOVERY_GUARD = old;
    }
  });
test("a legacy ACTIVE Watch is neither required nor executable authority for a fresh one-shot entry", async () => {
  const f = mockExecutionCase();
  try {
    const c = f.store.token(MINT)!;
    f.e.structure.admit(c, { authorityRevision: 0, snapshotHash: "legacy" });
    const before = JSON.stringify(f.e.structure.get(MINT));
    await f.e.analyze(MINT);
    assert.equal(f.e.attempts.current!.result, "BOUGHT");
    assert.equal(JSON.stringify(f.e.structure.get(MINT)), before);
    assert.equal(f.stats().signed, 1);
  } finally {
    await f.close();
  }
});
