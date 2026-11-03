import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { Engine } from "../src/engine.js";
import { Store } from "../src/store.js";
import { Jev, parseJevExit } from "../src/jev.js";
import { JevExitScheduler } from "../src/jev-exit-scheduler.js";
import { settingsSchema } from "../src/config.js";
import { position, provider, info } from "./fixtures.js";
import { SOL } from "../src/gmgn.js";
import type { JevExitDecision } from "../src/domain.js";

const hold = {
  action: "HOLD" as const,
  sellBps: 0,
  confidence: 0.9,
  reason: "UNCHANGED",
};

test("wallet becoming busy during exit preflight preserves queued work without a false SYSTEM halt", async () => {
  const h = harness(1, 15);
  h.jev.decideExit = async () => ({
    action: "FULL_SELL",
    sellBps: 10000,
    confidence: 0.9,
    reason: "ORDER_FLOW",
  });
  let busy = false,
    flip = true;
  const security = h.engine.gmgn.security.bind(h.engine.gmgn);
  try {
    await h.engine.monitor();
    await h.engine.exitScheduler.idle();
    Object.defineProperty(h.engine.executor, "isBusy", {
      get: () => busy,
      configurable: true,
    });
    h.engine.gmgn.security = async (c, s) => {
      const result = await security(c, s);
      if (flip) busy = true;
      return result;
    };
    await h.engine.processExits();
    assert.equal(h.db.executions().length, 0);
    assert.equal(h.db.get("haltReason"), undefined);
    assert.equal(h.db.positions("paper")[0]?.pendingExits?.length, 1);
    busy = false;
    flip = false;
    await h.engine.processExits();
    assert.equal(h.db.positions("paper")[0]?.state, "CLOSED");
  } finally {
    busy = false;
    await h.engine.stop();
    h.db.close();
  }
});

test("delayed Jev response cannot authorize a changed quantity or contaminate another position", async () => {
  const h = harness(2, 15);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  h.jev.decideExit = async () => {
    await gate;
    return {
      action: "FULL_SELL",
      sellBps: 10000,
      confidence: 0.9,
      reason: "ORDER_FLOW",
    };
  };
  try {
    await h.engine.monitor();
    const p = h.db.positions("paper").find((p) => p.id === "p-0")!;
    p.quantity = "800000";
    h.db.savePosition(p);
    release();
    await h.engine.exitScheduler.idle();
    assert.equal(
      h.db.jevExits().find((d) => d.positionId === "p-0")?.status,
      "SUPERSEDED",
    );
    assert.equal(
      h.db.positions("paper").find((p) => p.id === "p-0")?.pendingExits
        ?.length ?? 0,
      0,
    );
    assert.equal(
      h.db.positions("paper").find((p) => p.id === "p-1")?.jevExit?.positionId,
      "p-1",
    );
    assert.equal(h.db.executions().length, 0);
  } finally {
    release();
    await h.engine.stop();
    h.db.close();
  }
});
function harness(count = 1, percent = 35) {
  const db = new Store(":memory:");
  db.set("strategyV2", settingsSchema.parse({ smartMoneyExitMode: "OFF" }));
  const gmgn = provider(async (args) => {
    if (args[0] === "token" && args[1] === "info") {
      const mint = args[args.indexOf("--address") + 1]!,
        data = info(mint);
      return mint === SOL
        ? data
        : {
            ...data,
            price: {
              ...data.price,
              price: String((0.1 * (100 + percent)) / 100),
            },
          };
    }
  }).gmgn;
  const jev = new Jev();
  jev.decideExit = async () => hold;
  const engine = new Engine(db, { gmgn, jev });
  for (let i = 0; i < count; i++)
    db.savePosition({
      ...position(),
      id: `p-${i}`,
      mint: Keypair.generate().publicKey.toBase58(),
      mode: "paper",
      quantity: "1000000",
      originalQuantity: "1000000",
      entryAt: Date.now() - 86400000,
    });
  return { db, engine, jev };
}

for (const count of [10, 20])
  test(`${count} positions have scoped decisions; slow bounded Jev and busy wallet do not block monitoring`, async () => {
    const h = harness(count);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let active = 0,
      peak = 0;
    h.jev.decideExit = async () => {
      active++;
      peak = Math.max(peak, active);
      await gate;
      active--;
      return hold;
    };
    Object.defineProperty(h.engine.executor, "isBusy", {
      get: () => true,
      configurable: true,
    });
    try {
      await h.engine.monitor();
      assert.equal(
        h.db
          .positions("paper")
          .filter((p) => p.lastQuoteAt && p.monitoring?.status === "ACTIVE")
          .length,
        count,
      );
      assert.equal(h.engine.exitScheduler.status().active, 2);
      assert.equal(h.engine.exitScheduler.status().queued, count - 2);
      assert.equal(h.db.executions().length, 0);
      release();
      await h.engine.exitScheduler.idle();
      assert.equal(peak, 2);
      assert.equal(h.db.jevExits().length, count);
      for (const p of h.db.positions("paper")) {
        assert.equal(p.jevExit?.positionId, p.id);
        assert.equal(p.jevExit?.mint, p.mint);
        assert.equal(p.jevExit?.action, "HOLD");
        assert.equal(p.pendingExits?.length, 0);
      }
    } finally {
      release();
      Object.defineProperty(h.engine.executor, "isBusy", {
        get: () => false,
        configurable: true,
      });
      await h.engine.stop();
      h.db.close();
    }
  });

test("Jev can hold above legacy TP and sell another position early at +15%; confirmed strategy fills remain linked", async () => {
  const h = harness(2, 15);
  h.jev.decideExit = async (state) => {
    const p = (state as { currentPosition: { id: string } }).currentPosition;
    return p.id === "p-0"
      ? hold
      : {
          action: "PARTIAL_SELL",
          sellBps: 2500,
          confidence: 0.9,
          reason: "MOMENTUM_DETERIORATION",
        };
  };
  try {
    await h.engine.monitor();
    await h.engine.settleExitWork();
    const [a, b] = h.db.positions("paper");
    assert.equal(a!.quantity, "1000000");
    assert.equal(b!.quantity, "750000");
    const e = h.db.executions()[0]!;
    assert.equal(e.intent.positionId, "p-1");
    assert.ok(e.intent.jevExitDecisionId);
    assert.equal(b!.jevExit?.status, "CONFIRMED");
    assert.deepEqual(b!.takenProfits, []);
  } finally {
    await h.engine.stop();
    h.db.close();
  }
  const q = harness(1, 90);
  try {
    await q.engine.monitor();
    await q.engine.settleExitWork();
    assert.equal(q.db.executions().length, 0);
    assert.equal(q.db.positions("paper")[0]?.jevExit?.action, "HOLD");
  } finally {
    await q.engine.stop();
    q.db.close();
  }
});

test("Jev outage is scoped NO_DECISION; manual full SELL bypasses it and legacy references never force an exit", async () => {
  const h = harness(2, 80);
  h.jev.decideExit = async () => {
    throw Error("fixture provider unavailable");
  };
  try {
    await h.engine.monitor();
    await h.engine.settleExitWork();
    assert.equal(h.db.get("haltReason"), undefined);
    assert.equal(h.db.executions().length, 0);
    assert.equal(
      h.db.jevExits().filter((d) => d.error && d.action === "NO_DECISION")
        .length,
      2,
    );
    h.engine.emergency("p-0");
    await h.engine.processExits();
    assert.equal(
      h.db.positions("paper").find((p) => p.id === "p-0")?.state,
      "CLOSED",
    );
    assert.equal(
      h.db.positions("paper").find((p) => p.id === "p-1")?.quantity,
      "1000000",
    );
    assert.equal(h.db.manualRequests("paper")[0]?.state, "CONFIRMED");
  } finally {
    await h.engine.stop();
    h.db.close();
  }
});

test("scheduler deduplicates, bounds queue/concurrency and holds malformed or low-confidence output", async () => {
  const j = new Jev(),
    s = settingsSchema.parse({ jevExitQueueSize: 20, jevExitConcurrency: 2 }),
    results: JevExitDecision[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  j.decideExit = async () => {
    await gate;
    return { ...hold, confidence: 0.1 };
  };
  const scheduler = new JevExitScheduler(
    j,
    () => s,
    (d) => results.push(d),
  );
  const job = (n: number) => ({
    positionId: String(n),
    mint: String(n),
    quantity: "1",
    value: "1",
    state: { n },
    priority: 0,
    queuedAt: Date.now(),
  });
  assert.equal(scheduler.schedule(job(0)), true);
  assert.equal(scheduler.schedule(job(0)), false);
  for (let i = 1; i < 22; i++) assert.equal(scheduler.schedule(job(i)), true);
  assert.equal(scheduler.schedule(job(22)), false);
  release();
  await scheduler.idle();
  assert.equal(results.length, 22);
  assert.ok(
    results.every(
      (d) => d.action === "NO_DECISION" && d.reason === "LOW_CONFIDENCE",
    ),
  );
  j.decideExit = async () => ({ ...hold, action: "FULL_SELL", sellBps: 5000 });
  scheduler.schedule(job(23));
  await scheduler.idle();
  assert.equal(results.at(-1)?.status, "FAILED");
  await scheduler.stop();
});

test("strict structured exit parser rejects inconsistent fractions and inadequate data becomes HOLD", () => {
  const choice = (value: string) => ({
    type: "choice",
    choice: value,
    confidence: 0.9,
    probabilities: { [value]: 1 },
  });
  const raw = {
    model: "jev-1.14.0",
    answers: {
      action: choice("FULL_SELL"),
      sell_fraction: choice("PERCENT_50"),
      primary_reason: choice("PROFIT_MANAGEMENT"),
      data_sufficiency: { type: "noul", noul: 0.9 },
    },
  };
  assert.throws(() => parseJevExit(raw));
  raw.answers.sell_fraction = choice("ALL");
  raw.answers.data_sufficiency.noul = 0.2;
  assert.equal(parseJevExit(raw).action, "NO_DECISION");
});

test("manual partial executes first; critical security exits the remainder without waiting for Jev HOLD", async () => {
  const h = harness(2, 40);
  try {
    await h.engine.monitor();
    await h.engine.exitScheduler.idle();
    const security = h.engine.gmgn.security.bind(h.engine.gmgn);
    const mint = h.db.positions("paper")[0]!.mint;
    h.engine.gmgn.security = async (c, s) => ({
      ...(await security(c, s)),
      findings:
        c.mint === mint
          ? [
              {
                level: "CRITICAL",
                code: "CONTROL_RISK",
                reason: "fixture critical evidence",
              },
            ]
          : [],
    });
    h.engine.emergency("p-0", 5000);
    await h.engine.processExits();
    const a = h.db.positions("paper").find((p) => p.id === "p-0")!;
    assert.equal(a.state, "CLOSED");
    assert.equal(a.jevExit?.action, "HOLD");
    assert.equal(a.finalExitAction?.authority, "SECURITY");
    assert.equal(h.db.executions()[0]?.intent.amount, "500000");
    assert.equal(h.db.executions()[1]?.intent.amount, "500000");
    assert.equal(h.db.manualRequests("paper")[0]?.state, "CONFIRMED");
    assert.equal(
      h.db.positions("paper").find((p) => p.id === "p-1")?.quantity,
      "1000000",
    );
  } finally {
    await h.engine.stop();
    h.db.close();
  }
});

test("persistent queue honors manual full then manual partial before Jev; queued exits survive a bounded drain", async () => {
  const h = harness(3, 15);
  h.jev.decideExit = async () => ({
    action: "FULL_SELL",
    sellBps: 10000,
    confidence: 0.9,
    reason: "PROFIT_MANAGEMENT",
  });
  try {
    await h.engine.monitor();
    await h.engine.exitScheduler.idle();
    h.engine.emergency("p-1", 5000);
    h.engine.emergency("p-2");
    await h.engine.processExits();
    assert.deepEqual(
      h.db.executions().map((e) => e.intent.positionId),
      ["p-2", "p-1"],
    );
    assert.equal(
      h.db.positions("paper").find((p) => p.id === "p-0")?.pendingExits?.length,
      1,
    );
    await h.engine.processExits();
    assert.equal(
      h.db.positions("paper").find((p) => p.id === "p-0")?.state,
      "CLOSED",
    );
  } finally {
    await h.engine.stop();
    h.db.close();
  }
});
