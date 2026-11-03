import { setup } from "./one-shot-fixtures.js";
import { qualifiedWatch, legacyCandidate } from "./fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import {
  GmgnCoordinator,
  GmgnRateLimited,
  retryDelay,
} from "../src/gmgn-coordinator.js";
import {
  evolveStructure,
  SniperStructure,
  type StructureWatch,
} from "../src/sniper-structure.js";
import type { FlowObservation } from "../src/capital-flow.js";
import { Store } from "../src/store.js";
import { CandidateLifecycle } from "../src/candidate-lifecycle.js";
import { Gmgn, normalizeMarket } from "../src/gmgn.js";
import { Engine } from "../src/engine.js";

import { RiskEngine } from "../src/risk.js";
import { ProviderFailure, CandidateRejected } from "../src/domain.js";
import {
  settings,
  candidate,
  MINT,
  info,
  snapshot,
  position,
} from "./fixtures.js";
const start = 10_000_000;
function obs(
  at: number,
  price: number,
  buy = 200,
  sell = 100,
): FlowObservation {
  return {
    at,
    window: "1m",
    priceUsd: price,
    liquidityUsd: 10000,
    marketCapUsd: 100000,
    volumeUsd: buy + sell,
    buyVolumeUsd: buy,
    sellVolumeUsd: sell,
    buys: 10,
    sells: 5,
    holders: 100,
    smartWallets: null,
    smartMoneyBuyUsd: null,
    smartMoneySellUsd: null,
    largeBuyUsd: null,
    largeSellUsd: null,
  };
}
const defensive = [100, 96, 93, 93, 94, 95, 96, 97, 98];
function sequence(prices: number[], step = 15000, offset = 0) {
  let r: StructureWatch | undefined;
  for (const [i, p] of prices.entries()) {
    const buy = i < 3 ? 200 - i * 40 : 120 + (i - 3) * 50,
      sell = i < 3 ? 100 + i * 30 : 160;
    const o = obs(start + offset + i * step, p, buy, sell);
    r = evolveStructure(r, MINT, o, settings, o.at);
  }
  return r!;
}
function clock() {
  let at = 1000;
  const c = new GmgnCoordinator(
    () => ({
      intervalMs: 10,
      baseBackoffMs: 100,
      maxBackoffMs: 800,
      maxQueue: 200,
    }),
    () => at,
    async (ms) => {
      at += ms;
    },
    () => 0.5,
  );
  return {
    c,
    advance: (ms: number) => {
      at += ms;
    },
    now: () => at,
  };
}

test("initial expansion, one green tick and weak crash never authorize Sniper", () => {
  for (const prices of [
    [100, 120, 150, 180],
    [100, 70, 72],
    [100, 80, 65, 50, 55, 52, 40],
    [100, 70, 76, 72, 61, 40],
  ])
    assert.notEqual(sequence(prices).status, "PASSED");
});
test("real selling then persistent absorption and buyer return passes at two minutes without percent gate", () => {
  const r = sequence(defensive);
  assert.equal(r.status, "PASSED");
  assert.equal(r.phase, "ENTRY_ELIGIBLE");
  assert.equal(r.confirmedAt, start + 120000);
  assert.equal(r.structureWatchExpiresAt, start + settings.structureWatchTtlMs);
  // Same behavior at a very small pullback: no minimum drawdown authority.
  assert.equal(
    sequence([100, 99.96, 99.93, 99.93, 99.94, 99.95, 99.96, 99.97, 99.98])
      .status,
    "PASSED",
  );
});
test("watch can confirm at minute five or nine fifty-nine, but never by merely waiting", () => {
  for (const offset of [180000, 479000]) {
    let r = evolveStructure(undefined, MINT, obs(start, 100), settings, start);
    for (const [i, p] of defensive.entries()) {
      const at = start + offset + i * 15000;
      r = evolveStructure(
        r,
        MINT,
        obs(
          at,
          p,
          i < 3 ? 200 - i * 40 : 120 + (i - 3) * 50,
          i < 3 ? 100 + i * 30 : 160,
        ),
        settings,
        at,
      );
    }
    assert.equal(r.status, "PASSED");
    assert.equal(
      r.structureWatchExpiresAt,
      start + settings.structureWatchTtlMs,
    );
  }
  const flat = sequence(Array(12).fill(100));
  assert.notEqual(flat.status, "PASSED");
});
test("failed bounce keeps original TTL and can later establish buyer defense", () => {
  let r = sequence([100, 70, 76, 72, 61, 40]);
  const expires = r.structureWatchExpiresAt;
  for (const [i, p] of [36, 33, 33, 34, 35, 36, 37, 38, 39].entries()) {
    const at = r.lastObservedAt! + 20000;
    r = evolveStructure(
      r,
      MINT,
      obs(at, p, i < 2 ? 100 - i * 20 : 80 + (i - 2) * 50, 200),
      settings,
      at,
    );
  }
  assert.equal(r.status, "PASSED");
  assert.equal(r.structureWatchExpiresAt, expires);
});
test("missing, repeated, stale and different-window observations cannot manufacture confirmation", () => {
  const r = sequence([100, 96, 93]);
  assert.deepEqual(
    evolveStructure(
      r,
      MINT,
      r.observations.at(-1),
      settings,
      r.lastObservedAt!,
    ),
    r,
  );
  const unknown = evolveStructure(
    r,
    MINT,
    undefined,
    settings,
    r.lastObservedAt! + 30000,
  );
  assert.equal(unknown.phase, r.phase);
  assert.equal(unknown.status, "ACTIVE");
  assert.equal(unknown.quality, "STALE");
  const missing = {
    ...obs(r.lastObservedAt! + 20000, 93),
    sellVolumeUsd: null,
  };
  assert.notEqual(
    evolveStructure(r, MINT, missing, settings, missing.at).status,
    "PASSED",
  );
  const gap = obs(r.lastObservedAt! + 180000, 94);
  const after = evolveStructure(r, MINT, gap, settings, gap.at);
  assert.equal(after.sellingSeen, false);
  assert(after.providerUnavailableDuration > 0);
  const other = { ...obs(r.lastObservedAt! + 20000, 94), window: "5m" };
  assert.equal(
    evolveStructure(r, MINT, other, settings, other.at).sellingSeen,
    false,
  );
});
test("expiry is wall-clock, not scam, and Security can terminate watch immediately", () => {
  const db = new Store(":memory:");
  try {
    const w = new SniperStructure(db, () => settings),
      c = candidate();
    const r = w.admit(
      c,
      { authorityRevision: 0, snapshotHash: "fixture" },
      start,
    )!;
    w.observe(c, undefined, start + 300000);
    assert.equal(
      w.get(MINT)?.structureWatchExpiresAt,
      r.structureWatchExpiresAt,
    );
    w.expire(start + settings.structureWatchTtlMs);
    assert.equal(w.get(MINT)?.reason, "STRUCTURE_WATCH_EXPIRED");
    assert.equal(w.get(MINT)?.status, "EXPIRED");
    const other = { ...c, mint: "other" };
    w.observe(other, obs(start, 100), start);
    w.invalidate("other", "CRITICAL_SECURITY");
    assert.equal(w.get("other")?.status, "INVALIDATED");
  } finally {
    db.close();
  }
});
test("old Structure Watch state cannot defer a newly fetched Trending appearance", async () => {
  const db = new Store(":memory:"),
    life = new CandidateLifecycle(db, () => settings),
    c = candidate();
  try {
    life.refill([c]);
    life.setState(MINT, "ANALYZING");
    life.structureWait(MINT, Date.now() + 600000);
    assert.equal(life.get(MINT)?.state, "REJECTED");
    life.finish(MINT);
    const next = structuredClone(c);
    next.discovery!.trending!.lastSeenAt++;
    life.refill([next]);
    assert.equal(life.get(MINT)?.state, "QUEUED");
    assert.equal(life.get(MINT)?.structureWatchExpiresAt, undefined);
  } finally {
    db.close();
  }
});
test("Jev confidence cannot bypass unfinished or stale structure; pre-Watch review alone skips timing", () => {
  const risk = new RiskEngine(),
    snap = snapshot(),
    ctx = {
      balance: 1000000000n,
      pending: 0n,
      positions: 100,
      duplicate: false,
      entriesEnabled: true,
    };
  snap.entryDiscoverySource = "SNIPER";
  snap.jev!.confidence = 0.99;
  assert.equal(risk.evaluate(snap, settings, ctx).allowed, false);
  snap.sniperStructureAtEntry = sequence(defensive);
  assert.equal(risk.evaluate(snap, settings, ctx).allowed, false);
  snap.entryDiscoverySource = "TRENDING";
  assert.equal(risk.evaluate(snap, settings, ctx).allowed, false);
  assert.equal(
    risk.evaluate(snap, settings, ctx, Date.now(), "PRE_WATCH").allowed,
    true,
  );
});
test("single-flight and cache reduce four consumers and 100 same-key reads to one transport call", async () => {
  const { c } = clock();
  let calls = 0;
  const work = async () => {
    calls++;
    return { price: 100 };
  };
  const rows = await Promise.all(
    Array.from({ length: 100 }, (_, i) =>
      c.read("token:sol:mint:1m", 1000, work, {
        consumer: ["structure", "flow", "jev", "ui"][i % 4],
      }),
    ),
  );
  assert.equal(calls, 1);
  assert.equal(rows.length, 100);
  assert.equal(c.metrics.singleFlightJoined, 99);
  await c.read("token:sol:mint:1m", 1000, work);
  assert.equal(calls, 1);
  assert.equal(c.metrics.cacheHit, 1);
  if (process.env.KEEP_TEST_ARTIFACTS === "true")
    writeFileSync(
      "data/v5-cache-benchmark.json",
      JSON.stringify(
        {
          basis: "deterministic transport fixture",
          ...c.status(),
        },
        null,
        2,
      ),
    );
});
test("meaningful query/window keys stay separate; strict fresh reads never reuse stale cache", async () => {
  const { c, advance } = clock();
  let calls = 0;
  const work = async () => ({ n: ++calls });
  await c.read("mint:1m", 100, work);
  await c.read("mint:5m", 100, work);
  advance(200);
  await c.read("mint:1m", 0, work);
  assert.equal(calls, 3);
});
test("stale-while-revalidate labels cached age and shares one refresh; failures are not healthy cache", async () => {
  const { c, advance } = clock();
  let calls = 0;
  const work = async () => ({ n: ++calls });
  await c.read("optional", 100, work);
  advance(150);
  const stale = (await c.read("optional", 100, work, { staleMs: 500 })) as {
    _gmgnSnapshot: { freshness: string };
  };
  assert.equal(stale._gmgnSnapshot.freshness, "STALE_USABLE");
  await assert.rejects(
    c.read("bad", 100, async () => {
      throw new Error("timeout");
    }),
  );
  assert.equal(c.metadata("bad", 100).freshness, "UNKNOWN");
});
test("429 starts shared cooldown, honors authoritative Retry-After, releases no herd, then recovers", async () => {
  const { c, advance } = clock();
  let calls = 0;
  await assert.rejects(
    c.read("a", 0, async () => {
      calls++;
      throw new GmgnRateLimited(5000);
    }),
  );
  assert.equal(c.status().cooldownRemainingMs, 5000);
  const results = await Promise.allSettled(
    Array.from({ length: 100 }, (_, i) =>
      c.read("blocked" + i, 0, async () => {
        calls++;
        return {};
      }),
    ),
  );
  assert(results.every((r) => r.status === "rejected"));
  assert.equal(calls, 1);
  advance(5000);
  await c.read("probe", 0, async () => {
    calls++;
    return {};
  });
  assert.equal(calls, 2);
  assert.equal(c.status().state, "RECOVERING");
  for (let i = 0; i < 5; i++) await c.read("ok" + i, 0, async () => ({}));
  assert.equal(c.status().state, "HEALTHY");
});
test("bounded exponential backoff has jitter and respects documented CLI reset guidance", async () => {
  const { c, advance } = clock();
  const waits = [];
  for (let i = 0; i < 6; i++) {
    await assert.rejects(
      c.read("rate", 0, async () => {
        throw new GmgnRateLimited();
      }),
    );
    const wait = c.status().cooldownRemainingMs;
    waits.push(wait);
    advance(wait);
  }
  assert(waits[1]! > waits[0]!);
  assert(waits.every((w) => w <= 800));
  assert.equal(waits[0], 113);
  assert.equal(retryDelay("Retry-After: 12"), 12000);
  assert.equal(
    retryDelay(
      "Retry-After: Thu, 29 Oct 2026 04:00:00 GMT",
      Date.parse("2026-10-29T03:59:50Z"),
    ),
    10000,
  );
  assert.equal(
    retryDelay(
      "Rate limit resets at 2026-10-29 11:00:00 GMT+07:00 (~10s remaining)",
      Date.parse("2026-10-29T03:59:50Z"),
    ),
    11000,
  );
  assert.equal(retryDelay("no timing evidence"), undefined);
});
test("priority queue admits protection before enrichment; finite waiting ages older jobs", async () => {
  let unblock!: () => void;
  const order: string[] = [],
    { c } = clock();
  const first = c.read("first", 0, async () => {
    await new Promise<void>((r) => {
      unblock = r;
    });
    return {};
  });
  await new Promise<void>((r) => setImmediate(r));
  const low = c.read(
    "low",
    0,
    async () => {
      order.push("low");
      return {};
    },
    { priority: 5 },
  );
  const high = c.read(
    "high",
    0,
    async () => {
      order.push("high");
      return {};
    },
    { priority: 0 },
  );
  unblock();
  await Promise.all([first, low, high]);
  assert.deepEqual(order, ["high", "low"]);
});
test("actual Gmgn wrappers preserve fetchedAt and dedupe info consumers without caching malformed records", async () => {
  let calls = 0;
  const g = new Gmgn(async (args) => {
    calls++;
    return info(args[args.indexOf("--address") + 1]);
  });
  const rows = await Promise.all([g.info(MINT), g.info(MINT), g.info(MINT)]);
  assert.equal(calls, 1);
  assert.equal(normalizeMarket(rows[0]).at, normalizeMarket(rows[1]).at);
  await g.info(MINT, 0);
  assert.equal(calls, 2);
  const bad = new Gmgn(async () => ({ address: "wrong", symbol: "X" }));
  await assert.rejects(bad.info(MINT));
  assert.equal(bad.coordinator.status().cacheEntries, 0);
  const malformedFeed = new Gmgn(async () => ({
    code: 0,
    data: { rank: "invalid" },
  }));
  await assert.rejects(malformedFeed.trending());
  assert.equal(malformedFeed.coordinator.status().cacheEntries, 0);
});
test("Engine GMGN cooldown does not halt/reject candidate/structure or block independent manual SELL", async () => {
  const db = new Store(":memory:"),
    g = new Gmgn(async () => {
      throw new GmgnRateLimited(10000);
    }),
    engine = new Engine(db, { gmgn: g });
  try {
    const c = candidate();
    db.discover(c);
    engine.candidates.refill([c]);
    qualifiedWatch(engine, c, false);
    const p = { ...position(), mode: "paper" as const };
    db.savePosition(p);
    engine.emergency(p.id, 5000);
    await (
      engine as unknown as {
        isolate: (
          e: unknown,
          m: string,
          s: string,
          p?: unknown,
        ) => Promise<boolean>;
      }
    ).isolate(new GmgnRateLimited(), MINT, "DEEP_CHECK");
    assert.equal(db.get("haltReason"), undefined);
    assert.notEqual(engine.candidates.get(MINT)?.state, "REJECTED");
    assert.equal(engine.structure.get(MINT)?.status, "ACTIVE");
    for (let n = 0; n < 4; n++)
      await (
        engine as unknown as {
          isolate: (e: unknown, m: string, s: string) => Promise<boolean>;
        }
      ).isolate(
        new CandidateRejected("TOKEN_DATA_INCOMPLETE"),
        MINT,
        "DEEP_CHECK",
      );
    assert.notEqual(engine.candidates.get(MINT)?.state, "REJECTED");
    assert.equal(engine.structure.get(MINT)?.phase, "NEW");
    assert.equal(db.activeManual(p.mode).length, 1);
    await (
      engine as unknown as {
        isolate: (
          e: unknown,
          m: string,
          s: string,
          p?: unknown,
        ) => Promise<boolean>;
      }
    ).isolate(
      new ProviderFailure("GMGN_AUTHORIZATION_FAILED", "GMGN", false),
      MINT,
      "DEEP_CHECK",
    );
    assert.match(db.get<string>("haltReason")!, /GMGN_AUTHORIZATION_FAILED/);
  } finally {
    db.close();
  }
});
test("only Trending can start one-shot entry; an old Sniper signal creates no watcher", async () => {
  const f = setup();
  try {
    f.store.discover({ ...candidate(), discovery: undefined });
    f.store.db
      .prepare("UPDATE tokens SET payload=? WHERE mint=?")
      .run(JSON.stringify(legacyCandidate()), MINT);
    await assert.rejects(f.engine.analyze(MINT));
    assert.equal(f.engine.attempts.current!.failedStage, "CHEAP_FILTER");
    assert.equal(f.calls(), 0);
    assert.equal(f.engine.candidates.list().length, 0);
  } finally {
    await f.engine.stop();
    f.store.close();
  }
});
test("50 watches and 100 mixed logical reads remain bounded and preserve owned accounting", async () => {
  const db = new Store(":memory:"),
    { c } = clock();
  try {
    const w = new SniperStructure(db, () => settings);
    for (let i = 0; i < 50; i++)
      w.admit(
        { ...candidate(), mint: "watch" + i },
        { authorityRevision: 0, snapshotHash: "fixture" },
        start,
      );
    assert.equal(w.list().filter((r) => r.status === "ACTIVE").length, 50);
    assert.equal(
      w.admit(
        { ...candidate(), mint: "overflow" },
        { authorityRevision: 0, snapshotHash: "fixture" },
        start,
      ),
      undefined,
    );
    const p = position();
    db.savePosition(p);
    const before = JSON.stringify(db.positions(p.mode));
    let calls = 0;
    await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        c.read(
          "shared-mint" + (i % 25),
          1000,
          async () => {
            calls++;
            return {};
          },
          { priority: i % 6, consumer: i < 50 ? "structure-watch" : "mixed" },
        ),
      ),
    );
    assert.equal(calls, 25);
    assert.equal(JSON.stringify(db.positions(p.mode)), before);
    if (process.env.KEEP_TEST_ARTIFACTS === "true")
      writeFileSync(
        "data/v5-load-benchmark.json",
        JSON.stringify(
          {
            basis: "fixture, no network or real transactions",
            watches: 50,
            transportCalls: calls,
            watchPollingTimers: 0,
            ownedAccountingUnchanged: true,
            ...c.status(),
          },
          null,
          2,
        ),
      );
  } finally {
    db.close();
  }
});
