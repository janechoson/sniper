import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { writeFileSync } from "node:fs";
import { Store } from "../src/store.js";
import { Engine } from "../src/engine.js";
import { settingsSchema } from "../src/config.js";
import { CandidateRejected, type Candidate } from "../src/domain.js";
import { DiscoveryCoordinator, discoveryContext } from "../src/discovery.js";
import { CandidateLifecycle } from "../src/candidate-lifecycle.js";
import { parseTrending } from "../src/gmgn.js";
import {
  probeExits,
  assertEntryExit,
  ExitLiquidityMonitor,
  exitLiquidityContext,
} from "../src/exit-feasibility.js";
import type {
  ExecutionQuote,
  SolanaExecutionProvider,
} from "../src/execution-provider.js";
import {
  candidate,
  provider,
  position,
  quote,
  WALLET,
  MINT,
  info,
} from "./fixtures.js";
import { completedFixture } from "./learning-fixtures.js";
const settings = settingsSchema.parse({ smartMoneyExitMode: "OFF" });
const now = Date.now();
const hold = {
  action: "HOLD" as const,
  sellBps: 0,
  confidence: 0.9,
  reason: "UNCHANGED",
};
function sniper(
  mint = Keypair.generate().publicKey.toBase58(),
  at = now,
): Candidate {
  return {
    ...candidate(),
    mint,
    createdAt: at - 60000,
    discoveredAt: at,
    listing: info(mint),
    discovery: {
      sources: ["SNIPER"],
      firstSeenAt: at,
      lastSeenAt: at,
      sniper: { firstSeenAt: at, lastSeenAt: at },
    },
  };
}
function trending(
  mint = Keypair.generate().publicKey.toBase58(),
  rank = 10,
  at = now,
): Candidate {
  return parseTrending(
    {
      code: 0,
      data: {
        rank: [
          {
            address: mint,
            symbol: "TREND",
            price: 0.1,
            liquidity: 100000,
            market_cap: 1000000,
            volume: 100000,
            buys: 80,
            sells: 20,
            rank,
            creation_timestamp: Math.floor((at - 60000) / 1000),
          },
        ],
      },
    },
    "5m",
    at,
  )[0]!;
}
function ports(response?: (amount: bigint, bps: number) => ExecutionQuote) {
  const amounts: bigint[] = [];
  let sent = 0;
  const p: SolanaExecutionProvider = {
    health: { state: "READY", at: now },
    getWalletBalance: async () => 1000000000n,
    quoteBuy: async (_m, n) => quote("BUY", n),
    quoteSell: async (_m, n) => {
      amounts.push(n);
      const bps =
        amounts.length % 3 === 1
          ? 2000
          : amounts.length % 3 === 2
            ? 5000
            : 10000;
      return response ? response(n, bps) : quote("SELL", n, WALLET, true);
    },
    simulate: async () => {},
    execute: async () => {
      sent++;
      throw Error("Probe must never execute");
    },
    confirm: async () => "CONFIRMED",
  };
  return { p, amounts, sent: () => sent };
}

test("actual rank response normalization preserves provider rank/window; malformed/absent ranks never become fabricated rank", () => {
  const c = trending();
  assert.equal(c.discovery?.trending?.rank, 10);
  assert.equal(c.listing?.market_cap, 1000000);
  const unknown = parseTrending({
    data: { rank: [{ address: MINT, price: 1, volume: 0 }] },
  })[0]!;
  assert.equal(unknown.discovery?.trending?.rank, undefined);
  assert.throws(() => parseTrending({ rank: "bad" }));
  assert.equal(
    parseTrending({ data: { rank: [{ address: "bad", rank: 1 }] } }).length,
    0,
  );
});
test("canonical multi-source merge preserves bounded rising/falling evidence and never changes owned accounting", () => {
  const db = new Store(":memory:");
  try {
    const c = sniper(),
      owned = { ...position(), mint: c.mint, mode: "paper" as const };
    db.savePosition(owned);
    db.discover(c);
    for (const [n, r] of [42, 28, 15, 7].entries())
      db.discover(trending(c.mint, r, now + n * 60000));
    let d = db.token(c.mint)!.discovery!;
    assert.deepEqual(d.sources, ["SNIPER", "TRENDING"]);
    assert.equal(d.trending?.movement, "RISING");
    assert.equal(d.trending?.firstSeenAt, now);
    db.discover(trending(c.mint, 31, now + 240000));
    d = db.token(c.mint)!.discovery!;
    assert.equal(d.trending?.movement, "FALLING_FAST");
    for (let n = 5; n < 50; n++)
      db.discover(trending(c.mint, n, now + n * 60000));
    assert.ok(db.token(c.mint)!.discovery!.trending!.history.length <= 20);
    assert.equal(db.positions("paper")[0]?.quantity, owned.quantity);
    assert.equal(
      new CandidateLifecycle(db, () => settings).refill(db.tokens()).length,
      1,
    );
    const ctx = discoveryContext(db.token(c.mint), now + 3000000, 180000, {
      state: "READY",
      lastAttemptAt: now + 3000000,
    });
    assert.equal(ctx.trending?.presentInLatestSuccessfulPoll, false);
  } finally {
    db.close();
  }
});
test("every Trending appearance enters independently; pure Sniper never enters the queue", () => {
  const db = new Store(":memory:"),
    l = new CandidateLifecycle(db, () => settings);
  try {
    const a = sniper(),
      b = trending(),
      multi = sniper();
    db.discover(a);
    db.discover(b);
    db.discover(multi);
    db.discover(trending(multi.mint));
    let q = l.refill(db.tokens(), now);
    assert(!q.includes(a.mint));
    assert(q.includes(multi.mint));
    assert(q.includes(b.mint));
    assert.equal(db.executions().length, 0);
    for (let n = 0; n < 100; n++) db.discover(trending());
    q = l.refill(db.tokens(), now + settings.sniperMaxWaitMs + 1000);
    assert(!q.includes(a.mint));
    assert.equal(l.get(a.mint), undefined);
    assert.ok(q.length <= 10);
    assert(db.token(a.mint), "historical source still readable");
  } finally {
    db.close();
  }
});
test("a legacy Sniper backlog cannot occupy every analysis ahead of fresh equivalent Trending", () => {
  const db = new Store(":memory:"),
    l = new CandidateLifecycle(db, () => settings);
  try {
    const s = sniper(),
      t = trending();
    db.discover(s);
    db.discover(t);
    l.refill(db.tokens(), now);
    const later = now + settings.sniperMaxWaitMs + 1000;
    db.discover(trending(t.mint, 5, later));
    assert.equal(l.refill(db.tokens(), later)[0], t.mint);
    for (let n = 0; n < settings.trendingAnalysisBurst; n++) {
      l.setState(t.mint, "ANALYZING", later);
      l.setState(t.mint, "WATCH", later);
    }
    assert(!l.refill(db.tokens(), later).includes(s.mint));
    assert.equal(l.get(s.mint), undefined);
    l.setState(t.mint, "QUEUED", later);
    assert.equal(l.refill(db.tokens(), later)[0], t.mint);
  } finally {
    db.close();
  }
});
test("active analysis and approved execution ownership are not evicted by discovery reprioritization", () => {
  const db = new Store(":memory:"),
    s = { ...settings, candidateQueueSize: 2 },
    l = new CandidateLifecycle(db, () => s);
  try {
    const a = trending(),
      b = trending();
    db.discover(a);
    db.discover(b);
    l.refill(db.tokens(), now);
    l.setState(a.mint, "ANALYZING");
    l.setState(b.mint, "APPROVED");
    for (let n = 0; n < 20; n++) db.discover(trending());
    l.refill(db.tokens(), now + 1);
    assert.equal(l.get(a.mint)?.state, "ANALYZING");
    assert.equal(l.get(b.mint)?.state, "APPROVED");
    assert.equal(
      l
        .list()
        .filter((r) =>
          ["QUEUED", "ANALYZING", "APPROVED", "QUALIFIED"].includes(r.state),
        ).length,
      2,
    );
  } finally {
    db.close();
  }
});
for (const failed of ["TRENDING", "SNIPER"] as const)
  test(`${failed} feed failure leaves other discovery and position state running without global halt`, async () => {
    const db = new Store(":memory:"),
      g = provider().gmgn,
      c = sniper();
    g.discover = async () => {
      if (failed === "SNIPER") throw Error("fixture source");
      return [c];
    };
    g.trending = async () => {
      if (failed === "TRENDING") throw Error("fixture source");
      return [trending(c.mint)];
    };
    const d = new DiscoveryCoordinator(db, g, () => settings);
    try {
      db.savePosition({ ...position(), mode: "paper" });
      await d.poll(now);
      assert.equal(
        d.feeds[failed].state,
        failed === "TRENDING" ? "DEGRADED" : "DISABLED",
      );
      assert.equal(
        d.feeds[failed === "TRENDING" ? "SNIPER" : "TRENDING"].state,
        failed === "TRENDING" ? "DISABLED" : "READY",
      );
      assert.equal(!!db.token(c.mint), failed !== "TRENDING");
      assert.equal(db.get("haltReason"), undefined);
      assert.equal(db.positions("paper")[0]?.state, "OPEN");
      await d.poll(now + 1);
      assert.equal(d.feeds.TRENDING.calls.length, 1);
      assert.equal(d.feeds.SNIPER.calls.length, 0);
    } finally {
      await d.stop();
      db.close();
    }
  });
test("exit probes use exact 20/50/100 atomic amounts; quotes with zero fees still use positive conservative cost", async () => {
  const h = ports(),
    buy = quote("BUY", 1900000n);
  buy.order.outAmount = "5000000";
  buy.order.otherAmountThreshold = "4950000";
  const r = await probeExits(
    h.p,
    MINT,
    5000000n,
    WALLET,
    settings,
    "PRE_BUY",
    buy,
  );
  assert.deepEqual(h.amounts, [1000000n, 2500000n, 5000000n]);
  assert.equal(r.status, "HEALTHY");
  assert.equal(r.levels[0]?.estimatedCostLamports, "110000");
  assert.equal(h.sent(), 0);
  assertEntryExit(r, buy, settings);
});
test("BUY route with no SELL routes is rejected; technically returned 823 lamports cannot be healthy", async () => {
  const buy = quote("BUY", 1900000n),
    h = ports(() => {
      throw new CandidateRejected("NO_SELL_ROUTE");
    });
  const none = await probeExits(
    h.p,
    MINT,
    1000000n,
    WALLET,
    settings,
    "PRE_BUY",
    buy,
  );
  assert.equal(none.status, "NO_EXIT");
  assert.throws(
    () => assertEntryExit(none, buy, settings),
    /NO_PREBUY_EXIT_ROUTE/,
  );
  assert.equal(h.sent(), 0);
  const thin = ports((n) => {
    const q = quote("SELL", n, WALLET, true);
    q.order.outAmount = "823";
    q.order.otherAmountThreshold = "815";
    q.order.signatureFeeLamports = 0;
    return q;
  });
  const r = await probeExits(
    thin.p,
    MINT,
    1000000n,
    WALLET,
    settings,
    "PRE_BUY",
    buy,
  );
  assert.equal(r.status, "POOR");
  assert.ok(r.levels.every((l) => !l.economicallyMeaningful));
  assert.throws(
    () => assertEntryExit(r, buy, settings),
    /EXIT_LIQUIDITY_TOO_THIN/,
  );
});
test("healthy partial exits with high-impact full exit are LIMITED but eligible; changed BUY or policy invalidates probes", async () => {
  const buy = quote("BUY", 1900000n),
    h = ports((n, bps) => {
      const q = quote("SELL", n, WALLET, true);
      q.order.priceImpactPct = bps === 10000 ? 30 : 1;
      return q;
    });
  const r = await probeExits(
    h.p,
    MINT,
    1000000n,
    WALLET,
    settings,
    "PRE_BUY",
    buy,
  );
  assert.equal(r.status, "LIMITED");
  assertEntryExit(r, buy, settings);
  const changed = structuredClone(buy);
  changed.order.outAmount = "8000000";
  assert.throws(
    () => assertEntryExit(r, changed, settings),
    /EXIT_FEASIBILITY_STALE/,
  );
  assert.throws(
    () =>
      assertEntryExit(
        r,
        buy,
        settings,
        r.checkedAt + settings.exitProbeMaxAgeMs + 1,
      ),
    /EXIT_FEASIBILITY_STALE/,
  );
  assert.throws(
    () =>
      assertEntryExit(r, buy, {
        ...settings,
        exitProbeMinNetLamports: "10000000",
      }),
    /EXIT_FEASIBILITY_STALE/,
  );
});
test("temporary probe outage is UNKNOWN and amount dust never produces fake executable levels", async () => {
  const buy = quote("BUY", 1900000n),
    h = ports(() => {
      throw new Error("fixture outage");
    });
  const r = await probeExits(
    h.p,
    MINT,
    1000000n,
    WALLET,
    settings,
    "PRE_BUY",
    buy,
  );
  assert.equal(r.status, "UNKNOWN");
  assert.ok(r.levels.every((l) => l.routeAvailable === null));
  assert.throws(
    () => assertEntryExit(r, buy, settings),
    /EXIT_FEASIBILITY_UNAVAILABLE/,
  );
  const dust = ports(),
    small = await probeExits(dust.p, MINT, 1n, WALLET, settings, "PRE_BUY");
  assert.equal(dust.amounts.length, 1);
  assert.equal(small.levels[0]?.reason, "BELOW_ONE_ATOMIC_UNIT");
});
test("20 positions: quote checks are bounded, isolated, and refreshed health reaches independent Jev context", async () => {
  const db = new Store(":memory:"),
    g = provider().gmgn,
    engine = new Engine(db, { gmgn: g });
  const h = ports(),
    bad = Keypair.generate().publicKey.toBase58();
  const quoteSell = h.p.quoteSell;
  h.p.quoteSell = async (m, n, b, r) => {
    if (m === bad) throw new CandidateRejected("NO_SELL_ROUTE");
    const q = await quoteSell(m, n, b, r);
    q.mint = m;
    q.order.inputMint = m;
    q.order.routePlan[0]!.swapInfo.inputMint = m;
    return q;
  };
  const monitor = new ExitLiquidityMonitor(
    h.p,
    db,
    () => settings,
    () => WALLET,
    () => false,
  );
  const seen: unknown[] = [];
  engine.jev.decideExit = async (state) => {
    seen.push(state);
    return hold;
  };
  try {
    for (let n = 0; n < 20; n++) {
      const p = {
        ...position(),
        id: `liq-${n}`,
        mode: "paper" as const,
        mint: n === 0 ? bad : Keypair.generate().publicKey.toBase58(),
        quantity: "1000000",
        originalQuantity: "1000000",
      };
      db.savePosition(p);
      monitor.schedule(p);
    }
    for (let n = 0; n < 20; n++)
      await monitor.pump(now + n * (settings.positionExitProbeSpacingMs + 1));
    assert.equal(monitor.status().checks, 20);
    assert.equal(monitor.status().queued, 0);
    assert.equal(
      db.positions("paper").find((p) => p.id === "liq-0")!.exitLiquidity
        ?.status,
      "NO_EXIT",
    );
    assert.ok(
      db.positions("paper").filter((p) => p.exitLiquidity?.status === "HEALTHY")
        .length === 19,
    );
    assert.equal(h.sent(), 0);
    await engine.monitor();
    await engine.exitScheduler.idle();
    assert.equal(seen.length, 20);
    assert.ok(
      seen.some(
        (s) =>
          (s as { exitLiquidity: { status: string } }).exitLiquidity?.status ===
          "NO_EXIT",
      ),
    );
    assert.equal(db.get("haltReason"), undefined);
    const p = db.positions("paper")[0]!;
    p.quantity = "500000";
    assert.equal(exitLiquidityContext(p, settings)?.stale, true);
  } finally {
    await monitor.stop();
    await engine.stop();
    db.close();
  }
});
test("source learning records immutable discovery/flow and actual exit feasibility, not current token labels", () => {
  const db = new Store(":memory:"),
    engine = new Engine(db, { gmgn: provider().gmgn });
  try {
    const base = Date.now() - 3600000;
    const f = completedFixture(engine.memory, {
      mode: "paper",
      base,
      discovery: trending(undefined, 7, base).discovery,
    });
    db.discover(sniper(f.position.mint));
    const report = engine.memory.report("paper");
    assert.equal(report.discoveryOutcomes.groups[0]?.source, "TRENDING");
    assert.equal(report.discoveryOutcomes.groups[0]?.trades, 1);
    assert.equal(report.discoveryOutcomes.groups[0]?.closed, 1);
    assert.equal(
      engine.memory.sample(f.position.id)?.snapshot.candidate.mint,
      f.position.mint,
    );
  } finally {
    db.close();
  }
});
test("100 Trending plus 500 Sniper observations dedupe, bounded scheduler/history and measured provider budget", async () => {
  const db = new Store(":memory:"),
    g = provider().gmgn;
  const incoming = Array.from({ length: 500 }, () => sniper());
  const trends = incoming.slice(0, 100).map((c, n) => trending(c.mint, n + 1));
  g.discover = async () => incoming;
  g.trending = async () => trends;
  const d = new DiscoveryCoordinator(db, g, () => settings),
    l = new CandidateLifecycle(db, () => settings);
  const start = performance.now(),
    heap = process.memoryUsage().heapUsed;
  try {
    await d.poll(now);
    assert.equal(
      Number(db.db.prepare("SELECT count(*) n FROM tokens").get()!.n),
      100,
    );
    const q = l.refill(db.tokens(), now);
    assert.ok(q.length <= 10);
    assert.ok(l.list().length <= 540);
    assert.equal(d.counters.multiSourceCandidates, 0);
    await d.poll(now + 1000);
    assert.equal(d.feeds.SNIPER.calls.length, 0);
    assert.equal(d.feeds.TRENDING.calls.length, 1);
    if (process.env.KEEP_TEST_ARTIFACTS === "true")
      writeFileSync(
        "data/trending-performance.json",
        JSON.stringify(
          {
            basis:
              "RAM SQLite, deterministic fixture providers, no chain or real execution",
            at: new Date().toISOString(),
            inputObservations: 100,
            uniqueMints: 100,
            duplicateMerged: d.counters.duplicateMerged,
            queue: q.length,
            lifecycleRows: l.list().length,
            elapsedMs: performance.now() - start,
            heapDeltaBytes: process.memoryUsage().heapUsed - heap,
            discovery: d.status(),
            postPositionProbeMaximumPerMinute:
              Math.ceil(60000 / settings.positionExitProbeSpacingMs) * 3,
          },
          null,
          2,
        ),
      );
  } finally {
    await d.stop();
    db.close();
  }
});
