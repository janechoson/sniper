import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeFlowObservation,
  type FlowObservation,
} from "../src/capital-flow.js";
import { normalizeMarket } from "../src/gmgn.js";
import { recoveryGuardConfig } from "../src/recovery-guard.js";
import {
  evolveStructure,
  hasTimelyStructurePass,
  SniperStructure,
  type StructureWatch,
} from "../src/sniper-structure.js";
import { Store } from "../src/store.js";
import {
  recentStructureContext,
  STRUCTURE_EVIDENCE_VERSION,
} from "../src/structure-evidence.js";
import { candidate, info, MINT, settings } from "./fixtures.js";

const start = 10_000_000;
const prices = [100, 96, 93, 93, 94, 95, 96, 97, 98, 99];
function observation(
  i: number,
  price: number,
  buy = i < 3 ? 200 - i * 40 : 120 + (i - 3) * 50,
  sell = i < 3 ? 100 + i * 30 : 160,
): FlowObservation {
  return {
    at: start + i * 20000,
    window: "1m",
    priceUsd: price,
    liquidityUsd: 10000,
    marketCapUsd: null,
    volumeUsd: buy + sell,
    buyVolumeUsd: buy,
    sellVolumeUsd: sell,
    buys: 10,
    sells: 5,
    holders: null,
    smartWallets: null,
    smartMoneyBuyUsd: null,
    smartMoneySellUsd: null,
    largeBuyUsd: null,
    largeSellUsd: null,
  };
}
function run(observations: FlowObservation[], seed?: StructureWatch) {
  let r = seed;
  const trace: StructureWatch[] = [];
  for (const o of observations) {
    r = evolveStructure(r, MINT, o, settings, o.at);
    trace.push(r);
  }
  return { r: r!, trace };
}
const normal = () => prices.map((p, i) => observation(i, p));
function trusted(o: FlowObservation): FlowObservation {
  return {
    ...o,
    provenance: {
      provider: "GMGN",
      source: "token:info",
      mint: MINT,
      observedAt: o.at,
      semantics: "WINDOW_TOTAL_SNAPSHOT",
    },
  };
}

test("all local Structure correctness tests use Recovery bypass OFF", () => {
  assert.equal(recoveryGuardConfig.TEMP_BYPASS_RECOVERY_GUARD, false);
});
test("zero buys and constant decline never confirm absorption/support/recovery", () => {
  const { r } = run(
    [100, 99, 98, 97, 96, 95].map((p, i) => observation(i, p, 0, 100)),
  );
  assert.equal(r.supportConfirmed, false);
  assert.equal(r.absorptionDetected, false);
  assert.notEqual(r.status, "PASSED");
});
test("absorption and buyer defense are independent, then live recovery persists", () => {
  const { r, trace } = run(normal());
  assert(trace[3]!.absorptionDetected);
  assert(!trace[3]!.supportConfirmed);
  assert.equal(trace[4]!.supportCount, 1);
  assert(trace[5]!.supportConfirmed);
  assert.equal(trace[6]!.recoveryCount, 1);
  assert.notEqual(trace[7]!.status, "PASSED");
  assert.equal(trace[8]!.status, "PASSED");
  assert.equal(r.phase, "ENTRY_ELIGIBLE");
});

test("genuine absorption with zero buyer USD still cannot become Support", () => {
  const { r } = run(
    [100, 96, 93, 93, 93, 93, 94, 95].map((p, i) => observation(i, p, 0, 160)),
  );
  assert(r.absorptionDetected);
  assert.equal(r.supportConfirmed, false);
  assert.equal(r.supportCount, 0);
  assert.notEqual(r.status, "PASSED");
});
test("audit rolling-sell-decay counterexample cannot become Recovery Confirmed", () => {
  const buys = [100, 90, 80, 70, 60, 50, 40],
    sells = [200, 220, 240, 240, 180, 120, 80];
  const { r } = run(
    [100, 96, 93, 93, 94, 95, 96].map((p, i) =>
      observation(i, p, buys[i], sells[i]),
    ),
  );
  assert.notEqual(r.status, "PASSED");
  assert.equal(r.recoveryCount, 0);
});
test("even established support cannot recover on falling buy totals / sell decay alone", () => {
  const base = run(normal().slice(0, 6)).r;
  assert(base.supportConfirmed);
  const { r } = run(
    [96, 97, 98].map((p, i) =>
      observation(i + 6, p, 210 - i * 10, 230 - i * 60),
    ),
    base,
  );
  assert.notEqual(r.status, "PASSED");
  assert.equal(r.recoveryCount, 0);
  assert.notEqual(r.phase, "RECOVERY_ATTEMPT");
});
test("one strong positive spike followed by sellers never immediately PASSes", () => {
  const base = run(normal().slice(0, 6)).r;
  const { r, trace } = run(
    [observation(6, 150, 1000, 160), observation(7, 92, 100, 1000)],
    base,
  );
  assert(trace[0]!.recoveryCount <= 1);
  assert.notEqual(r.status, "PASSED");
  assert.equal(r.recoveryCount, 0);
  assert(base.supportConfirmed);
});
test("one noisy low does not erase support; persistent seller-driven loss does, within same TTL", () => {
  const base = run(normal().slice(0, 6)).r;
  const { r: noise } = run([observation(6, 92, 100, 300)], base);
  assert(noise.supportConfirmed);
  assert.notEqual(noise.status, "PASSED");
  const { r: lost } = run([observation(7, 91, 80, 400)], noise);
  assert(!lost.supportConfirmed);
  assert.equal(lost.phase, "SUPPORT_FAILED");
  assert.equal(lost.structureWatchStartedAt, base.structureWatchStartedAt);
  assert.equal(lost.structureWatchExpiresAt, base.structureWatchExpiresAt);
});
test("thin-liquidity price spikes without strengthening buyers do not confirm recovery", () => {
  const base = run(
    normal()
      .slice(0, 6)
      .map((o) => ({ ...o, liquidityUsd: 1 })),
  ).r;
  const { r } = run(
    [96, 150, 200].map((p, i) => ({
      ...observation(i + 6, p, 220, 160),
      liquidityUsd: 1,
    })),
    base,
  );
  assert.notEqual(r.status, "PASSED");
  assert.equal(r.recoveryCount, 0);
  assert(r.evidence!.buyLiquidityShare! <= 1);
});
test("unknown/zero/tiny denominators remain bounded and do not fabricate support", () => {
  for (const liquidity of [0, Number.MIN_VALUE, null]) {
    const { r } = run(
      [100, 99, 98, 97].map((p, i) => ({
        ...observation(i, p, 0, Number.MIN_VALUE),
        liquidityUsd: liquidity,
      })),
    );
    assert.notEqual(r.status, "PASSED");
    assert(!r.supportConfirmed);
    if (r.evidence)
      for (const v of Object.values(r.evidence))
        if (typeof v === "number") assert(Number.isFinite(v));
  }
});
test("gap/window/source reset clears peak/floor/defense without renewing admission", () => {
  for (const kind of ["gap", "window", "source"]) {
    const base = run(normal().slice(0, 6).map(trusted)).r;
    const next = trusted(observation(6, 40));
    if (kind === "gap")
      next.at = base.lastObservedAt! + settings.structureMaxGapMs + 1;
    if (kind === "window") next.window = "5m";
    if (kind === "source") next.provenance!.source = "TRENDING";
    next.provenance!.observedAt = next.at;
    const r = evolveStructure(base, MINT, next, settings, next.at);
    assert.equal(r.peak, 40);
    assert.equal(r.localLow, undefined);
    assert.equal(r.sellingSeen, false);
    assert.equal(r.supportConfirmed, false);
    assert.equal(r.observations.length, 1);
    assert.equal(r.structureWatchStartedAt, base.structureWatchStartedAt);
    assert.equal(r.structureWatchExpiresAt, base.structureWatchExpiresAt);
  }
});
test("UNKNOWN/repeated/future samples are not bearish evidence or new confirmations", () => {
  const base = run(normal().slice(0, 6)).r;
  for (const sample of [
    undefined,
    { ...observation(6, 0), priceUsd: null },
    { ...observation(6, 97), at: start + 500000 },
  ]) {
    const r = evolveStructure(
      base,
      MINT,
      sample,
      settings,
      base.lastObservedAt! + 20000,
    );
    assert.equal(r.supportConfirmed, base.supportConfirmed);
    assert.equal(r.defenseFailureCount, 0);
  }
  assert.deepEqual(
    evolveStructure(
      base,
      MINT,
      base.observations.at(-1),
      settings,
      base.lastObservedAt!,
    ),
    base,
  );
});
test("bounded trustworthy pre-T0 history seeds context, never PASS, requires live defense and recovery", () => {
  const db = new Store(":memory:");
  try {
    const c = candidate(),
      history = normal().slice(0, 7).map(trusted);
    const t0 = history.at(-1)!.at + 1000;
    db.discover(c);
    db.db
      .prepare("INSERT INTO candidate_flow_states VALUES(?,?,?)")
      .run(
        db.candidateFlowKey(MINT),
        t0 - 1000,
        JSON.stringify({ mint: MINT, observations: history }),
      );
    const w = new SniperStructure(db, () => settings),
      admitted = w.admit(
        c,
        { authorityRevision: 0, snapshotHash: "pre-watch" },
        t0,
      )!;
    assert(admitted.context);
    assert(admitted.sellingSeen);
    assert(admitted.absorptionDetected);
    assert(!admitted.supportConfirmed);
    assert.equal(admitted.status, "ACTIVE");
    assert.equal(admitted.confirmedAt, undefined);
    assert.equal(admitted.lastObservedAt, undefined);
    let r = admitted;
    for (let i = 0; i < 5; i++) {
      const o = trusted(observation(i + 7, 97 + i));
      r = w.observe(c, o, o.at)!;
      if (i < 4) assert.notEqual(r.status, "PASSED");
    }
    assert.equal(r.status, "PASSED");
    assert(r.confirmedAt! > t0);
    assert.equal(r.structureWatchStartedAt, t0);
    assert.equal(r.structureWatchExpiresAt, t0 + 600000);
    assert.equal(r.liveObservationsAccepted, 5);
    assert.equal(db.executions().length, 0);
    assert.equal(
      db.db.prepare("SELECT count(*) n FROM trade_learning_samples").get()!.n,
      0,
    );
    const before = structuredClone(r);
    db.discover({ ...c, discoveredAt: t0 + 300000 });
    assert.deepEqual(
      w.admit(c, { authorityRevision: 0, snapshotHash: "again" }, t0 + 300000),
      before,
    );
  } finally {
    db.close();
  }
});
test("stale, unproven, wrong mint, mixed window and future context cannot authorize entry", () => {
  const history = normal().slice(0, 7).map(trusted),
    now = history.at(-1)!.at + 1000;
  assert.equal(
    recentStructureContext(history, MINT, now + 600000, settings).length,
    0,
  );
  assert.equal(
    recentStructureContext(
      history.map((o) => ({ ...o, provenance: undefined })),
      MINT,
      now,
      settings,
    ).length,
    0,
  );
  assert.equal(
    recentStructureContext(history, "other-mint", now, settings).length,
    0,
  );
  assert.equal(
    recentStructureContext(history, MINT, start - 1, settings).length,
    0,
  );
  const mixed = structuredClone(history);
  mixed[3]!.window = "5m";
  assert(
    recentStructureContext(mixed, MINT, now, settings).every(
      (o) => o.at > mixed[3]!.at,
    ),
  );
});
test("token age does not choose another local algorithm", () => {
  for (const age of [180000, 1800000, 21600000, 172800000]) {
    const db = new Store(":memory:");
    try {
      const c = { ...candidate(), createdAt: start - age };
      db.discover(c);
      const w = new SniperStructure(db, () => settings);
      w.admit(c, { authorityRevision: 0, snapshotHash: "age" }, start - 1);
      for (const o of normal()) w.observe(c, o, o.at);
      assert.equal(w.get(MINT)!.status, "PASSED");
    } finally {
      db.close();
    }
  }
});
test("legacy PASS is not upgraded into new buyer-defense proof, original TTL preserved", () => {
  const legacy = run(normal()).r;
  delete legacy.evidenceVersion;
  assert.equal(hasTimelyStructurePass(legacy, legacy.lastObservedAt!), false);
  const r = evolveStructure(
    legacy,
    MINT,
    observation(10, 100),
    settings,
    start + 200000,
  );
  assert.equal(r.evidenceVersion, STRUCTURE_EVIDENCE_VERSION);
  assert.notEqual(r.status, "PASSED");
  assert.equal(r.previousStructureEvidence!.status, "PASSED");
  assert.equal(r.structureWatchStartedAt, start);
  assert.equal(r.structureWatchExpiresAt, legacy.structureWatchExpiresAt);
});
test("normalizer retains trustworthy snapshot provenance, never invents interval trade flow", () => {
  const raw = {
    ...info(),
    _gmgnSnapshot: {
      provider: "GMGN",
      source: "token:info",
      fetchedAt: start,
      freshness: "FRESH",
    },
  };
  const o = normalizeFlowObservation(normalizeMarket(raw), raw);
  assert.equal(o.provenance!.semantics, "WINDOW_TOTAL_SNAPSHOT");
  assert.equal(o.provenance!.observedAt, start);
  assert.equal(
    normalizeFlowObservation(normalizeMarket(info()), info()).provenance,
    undefined,
  );
});

test("timely PASS at 9:59 remains timely during positive fresh post-deadline recovery", () => {
  const seed = evolveStructure(undefined, MINT, undefined, settings, start);
  const observations = normal().map((o, i) => ({
    ...o,
    at: start + 479000 + i * 15000,
  }));
  const { r } = run(observations, seed);
  assert.equal(r.status, "PASSED");
  assert.equal(r.confirmedAt, start + 599000);
  assert(hasTimelyStructurePass(r, observations.at(-1)!.at));
  assert.equal(r.structureWatchExpiresAt, start + 600000);
});

test("component reopen downgrades old PASS without schema churn, preserves original record evidence and deadline", () => {
  const db = new Store(":memory:");
  try {
    const c = candidate(),
      t0 = Date.now() - 60000;
    const w = new SniperStructure(db, () => settings);
    const legacy = w.admit(
      c,
      { authorityRevision: 0, snapshotHash: "old-policy" },
      t0,
    )!;
    delete legacy.evidenceVersion;
    Object.assign(legacy, {
      status: "PASSED",
      phase: "ENTRY_ELIGIBLE",
      confirmedAt: t0 + 30000,
      supportConfirmed: true,
    });
    db.db
      .prepare("UPDATE entry_structure_watch SET payload=? WHERE mint=?")
      .run(JSON.stringify(legacy), MINT);
    const reopened = new SniperStructure(db, () => settings).get(MINT)!;
    assert.equal(reopened.status, "ACTIVE");
    assert.equal(reopened.quality, "UNKNOWN");
    assert(!reopened.supportConfirmed);
    assert.equal(reopened.previousStructureEvidence!.status, "PASSED");
    assert.equal(reopened.structureWatchStartedAt, t0);
    assert.equal(reopened.structureWatchExpiresAt, t0 + 600000);
    assert.equal(
      db.db.prepare("SELECT count(*) n FROM entry_structure_watch").get()!.n,
      1,
    );
  } finally {
    db.close();
  }
});
