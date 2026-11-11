import assert from "node:assert/strict";
import { test } from "node:test";
import { CandidateLifecycle } from "../src/candidate-lifecycle.js";
import { CapitalFlowEngine } from "../src/capital-flow.js";
import { CandidateRejected } from "../src/domain.js";
import { Engine } from "../src/engine.js";
import { evaluateExitSafety } from "../src/exit-safety.js";
import {
  GmgnCoordinator,
  GmgnRateLimited,
  gmgnRequestKey,
  retryDelay,
} from "../src/gmgn-coordinator.js";
import { Gmgn } from "../src/gmgn.js";
import { RiskEngine } from "../src/risk.js";
import { SniperStructure } from "../src/sniper-structure.js";
import { Store } from "../src/store.js";
import { STRUCTURE_EVIDENCE_VERSION } from "../src/structure-evidence.js";
import {
  candidate,
  info,
  MINT,
  position,
  securityRaw,
  settings,
  snapshot,
} from "./fixtures.js";
import { fakeKronos } from "./kronos-fixtures.js";

test("equivalent flag order shares a request key, meaningful windows remain distinct and invalid retry guidance is ignored", () => {
  const a = ["token", "info", "--chain", "sol", "--address", MINT];
  assert.equal(
    gmgnRequestKey(a),
    gmgnRequestKey(["token", "info", "--address", MINT, "--chain", "sol"]),
  );
  assert.notEqual(
    gmgnRequestKey([...a, "--interval", "1m"]),
    gmgnRequestKey([...a, "--interval", "5m"]),
  );
  assert.equal(
    retryDelay("Rate limit resets at 2026-99-99 99:99:99 GMT+07:00"),
    undefined,
  );
});

test("manual and existing critical protective SELL reach execution during GMGN cooldown", async () => {
  for (const kind of ["manual", "critical"]) {
    const db = new Store(":memory:"),
      g = new Gmgn(async () => {
        throw new GmgnRateLimited(10000);
      }),
      engine = new Engine(db, { gmgn: g, kronos: fakeKronos() });
    try {
      const p = { ...position(), mode: "demo" as const };
      if (kind === "critical")
        p.pendingExits = [
          {
            id: "critical",
            kind: "PROTECTIVE",
            reason: "Critical independently verified security deterioration",
            sellBps: 10000,
            triggeredAt: Date.now(),
            protection: evaluateExitSafety(p, settings, {
              security: {
                ...snapshot().security,
                at: Date.now(),
                findings: [
                  {
                    level: "CRITICAL",
                    code: "CONTROL",
                    reason: "fixture verified critical",
                  },
                ],
              },
            }).authorities[0],
          },
        ];
      db.savePosition(p);
      if (kind === "manual") engine.emergency(p.id, 5000);
      const intents: { side: string; amount: string }[] = [];
      engine.executor.execute = async (intent) => {
        intents.push(intent);
        throw new CandidateRejected("NO_SELL_ROUTE");
      };
      await engine.processExits();
      assert.equal(intents.length, 1);
      assert.equal(intents[0]!.side, "SELL");
      assert.equal(intents[0]!.amount, kind === "manual" ? "500" : "1000");
      assert.equal(db.get("haltReason"), undefined);
      assert.equal(db.positions("demo")[0]!.quantity, p.quantity);
    } finally {
      db.close();
    }
  }
});
test("fresh security request replaces older safe cache with newer critical evidence", async () => {
  let unsafe = false,
    calls = 0;
  const g = new Gmgn(async () => {
    calls++;
    return { ...securityRaw, renounced_freeze_account: !unsafe };
  });
  assert(
    !(await g.security(candidate(), settings)).findings.some(
      (f) => f.level === "CRITICAL",
    ),
  );
  unsafe = true;
  const critical = await g.security(candidate(), settings, {
    consumer: "pre-buy",
  });
  assert(critical.findings.some((f) => f.level === "CRITICAL"));
  assert(
    (await g.security(candidate(), settings)).findings.some(
      (f) => f.level === "CRITICAL",
    ),
  );
  assert.equal(calls, 2);
});
test("cached source timestamp cannot create artificial Capital Flow observations", async () => {
  const db = new Store(":memory:"),
    g = new Gmgn(async () => info());
  try {
    const raw = await g.info(MINT),
      flow = new CapitalFlowEngine(db, () => settings),
      p = position();
    const { normalizeMarket } = await import("../src/gmgn.js");
    flow.observe(p, normalizeMarket(raw), raw, Date.now());
    const first = flow.state(p.id)!;
    flow.observe(p, normalizeMarket(raw), raw, Date.now() + 60000);
    assert.equal(
      flow.state(p.id)!.observations.length,
      first.observations.length,
    );
    assert.equal(flow.state(p.id)!.at, first.at);
  } finally {
    db.close();
  }
});
test("old queued low-priority request ages ahead of later high-priority analysis", async () => {
  let now = 1000,
    release!: () => void;
  const order: string[] = [];
  const c = new GmgnCoordinator(
    () => ({
      intervalMs: 0,
      baseBackoffMs: 100,
      maxBackoffMs: 1000,
      maxQueue: 10,
    }),
    () => now,
    async () => {},
    () => 0,
  );
  const blocker = c.read("blocker", 0, async () => {
    await new Promise<void>((r) => {
      release = r;
    });
    return {};
  });
  await new Promise<void>((r) => setImmediate(r));
  const low = c.read(
    "old-watch",
    0,
    async () => {
      order.push("watch");
      return {};
    },
    { priority: 5 },
  );
  now += 200000;
  const high = c.read(
    "new-trending",
    0,
    async () => {
      order.push("trending");
      return {};
    },
    { priority: 2 },
  );
  release();
  await Promise.all([blocker, low, high]);
  assert.deepEqual(order, ["watch", "trending"]);
});
test("legacy Watch history survives restart but cannot schedule a candidate retry", async () => {
  const db = new Store(":memory:");
  try {
    const life = new CandidateLifecycle(db, () => settings),
      watch = new SniperStructure(db, () => settings),
      c = candidate();
    db.discover(c);
    life.refill([c]);
    life.setState(MINT, "ANALYZING");
    const state = watch.observe(c, undefined)!;
    life.providerWait(MINT);
    assert.equal(life.get(MINT)?.state, "REJECTED");
    life.finish(MINT);
    const restarted = new CandidateLifecycle(db, () => settings);
    assert.deepEqual(restarted.refill([c]), []);
    assert.equal(
      new SniperStructure(db, () => settings).get(MINT)
        ?.structureWatchExpiresAt,
      state.structureWatchExpiresAt,
    );
  } finally {
    db.close();
  }
});
test("a structure approval does not override Token-2022 or stale GMGN evidence", () => {
  const snap = snapshot(),
    now = Date.now(),
    ctx = {
      balance: 1000000000n,
      pending: 0n,
      positions: 50,
      duplicate: false,
      entriesEnabled: true,
    };
  snap.entryDiscoverySource = "SNIPER";
  snap.sniperStructureAtEntry = {
    // This test seeds approved structure to isolate downstream vetoes.
    evidenceVersion: STRUCTURE_EVIDENCE_VERSION,
    mint: MINT,
    phase: "ENTRY_ELIGIBLE",
    status: "PASSED",
    confirmedAt: now,
    structureWatchStartedAt: now - 120000,
    structureWatchExpiresAt: now + settings.structureWatchTtlMs - 120000,
    lastObservedAt: now,
    quality: "FRESH",
    reason: "RECOVERY_CONFIRMED",
    observations: [],
    sellingCount: 2,
    absorptionCount: 2,
    recoveryCount: 3,
    sellingSeen: true,
    supportConfirmed: true,
    providerUnavailableDuration: 0,
    observationsAccepted: 7,
    priceVelocity: 1,
    priceAcceleration: 0,
    drawdownPercent: 7,
    recoveryRatio: 0.5,
  };
  const risk = new RiskEngine();
  assert.equal(risk.evaluate(snap, settings, ctx).allowed, true);
  snap.tokenExecution = {
    decision: "SKIP",
    extensionRisk: "CRITICAL",
  } as NonNullable<typeof snap.tokenExecution>;
  assert.equal(risk.evaluate(snap, settings, ctx).allowed, false);
  delete snap.tokenExecution;
  snap.gmgnQuality = {
    provider: "GMGN",
    source: "token:info",
    fetchedAt: now - 60000,
    ageMs: 60000,
    freshness: "STALE_USABLE",
  };
  assert.equal(risk.evaluate(snap, settings, ctx).allowed, false);
});
