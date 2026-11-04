import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { CandidateLifecycle } from "../src/candidate-lifecycle.js";
import { flowView } from "../src/flow-view.js";
import { candidate, settings, MINT, snapshot } from "./fixtures.js";
import { RiskEngine } from "../src/risk.js";
import { CandidateRejected } from "../src/domain.js";
import { failureInfo } from "../src/failures.js";

test("flow transition IDs record actual lifecycle changes, not rank refreshes or repeated saves", () => {
  const db = new Store(":memory:");
  try {
    const c = candidate();
    db.discover(c);
    const life = new CandidateLifecycle(db, () => settings);
    life.refill([c]);
    const first = db.count("pipeline_transitions");
    assert.equal(first, 1);
    life.refill([c]);
    assert.equal(db.count("pipeline_transitions"), first);
    life.setState(MINT, "ANALYZING");
    life.setState(MINT, "ANALYZING");
    assert.equal(db.count("pipeline_transitions"), first + 1);
    const rows = db.db
      .prepare(
        "SELECT id,payload FROM records WHERE kind='pipeline_transitions' ORDER BY id",
      )
      .all();
    assert.ok(Number(rows[1]!.id) > Number(rows[0]!.id));
    assert.equal(
      JSON.parse(String(rows[1]!.payload)).type,
      "CANDIDATE_CHECKING",
    );
  } finally {
    db.close();
  }
});
test("read model exposes true 0/1/9/10 queue occupancy, bounded lists and no invented approvals or confirmed BUYs", () => {
  for (const count of [0, 1, 9, 10]) {
    const db = new Store(":memory:");
    try {
      const life = new CandidateLifecycle(db, () => settings);
      const base = candidate();
      const items = Array.from({ length: count }, (_, i) => ({
        ...structuredClone(base),
        mint: `flow-${i}`,
        symbol: `T${i}`,
      }));
      for (const c of items) db.discover(c);
      life.refill(items);
      const view = flowView(db, life.list(), settings, 0, new Map(), true);
      assert.equal(view.queue.length, count);
      assert.equal(view.counts.queue, count);
      assert.equal(view.limits.queue, 10);
      assert.equal(view.scannerRunning, true);
      assert.equal(view.counts.traded, 0);
      assert.equal(view.counts.approved, 0);
    } finally {
      db.close();
    }
  }
});
test("candidate rejection events reflect terminal backend classification without changing decisions", () => {
  const db = new Store(":memory:");
  try {
    const c = candidate();
    db.discover(c);
    const life = new CandidateLifecycle(db, () => settings);
    life.refill([c]);
    life.fail(
      failureInfo(new CandidateRejected("TOKEN_SAFETY_FAILED"), {
        mint: MINT,
        stage: "PRE_BUY",
      }),
    );
    let view = flowView(db, life.list(), settings, 0, new Map(), true);
    assert.equal(view.deferred.length, 0);
    assert.equal(view.rejected.length, 1);
    assert.equal(view.events.at(-1)?.type, "CANDIDATE_REJECTED");
    life.fail(
      failureInfo(new CandidateRejected("UNSUPPORTED_TOKEN_EXTENSION"), {
        mint: MINT,
        stage: "DEEP_CHECK",
      }),
    );
    view = flowView(db, life.list(), settings, 0, new Map(), true);
    assert.equal(view.deferred.length, 0);
    assert.equal(view.rejected.length, 1);
    assert.equal(view.counts.rejected, 1);
    assert.equal(db.executions().length, 0);
  } finally {
    db.close();
  }
});
test("BUY submitted is never counted as traded; confirmed persistence emits one authoritative event", () => {
  const db = new Store(":memory:");
  try {
    const intent = new RiskEngine().approve(
      snapshot(),
      settings,
      {
        balance: 1000000000n,
        pending: 0n,
        positions: 0,
        duplicate: false,
        entriesEnabled: true,
      },
      "paper",
    );
    const execution = db.claim(intent);
    execution.state = "SUBMITTED";
    execution.signature = "fixture-signature";
    db.execution(execution);
    let view = flowView(db, [], settings, 0, new Map(), true);
    assert.equal(view.counts.traded, 0);
    assert.equal(view.events.at(-1)?.type, "BUY_SUBMITTED");
    execution.state = "CONFIRMED";
    execution.evidence = {
      solDelta: "-9805000",
      tokenDelta: "1000000",
      slot: 1,
      feeLamports: "5000",
    };
    db.execution(execution);
    db.execution(execution);
    view = flowView(db, [], settings, 0, new Map(), true);
    assert.equal(view.counts.traded, 1);
    assert.equal(
      view.events.filter((e) => e.type === "BUY_CONFIRMED").length,
      1,
    );
  } finally {
    db.close();
  }
});
