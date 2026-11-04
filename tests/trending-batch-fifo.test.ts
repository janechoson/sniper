import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { CandidateLifecycle } from "../src/candidate-lifecycle.js";
import { DiscoveryCoordinator } from "../src/discovery.js";
import { candidate, settings, provider } from "./fixtures.js";
import { CandidateAttempts } from "../src/candidate-attempt.js";
import { env } from "../src/config.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { Engine } from "../src/engine.js";

const batchTime = Date.now();
const appearance = (mint: string, at = batchTime) => {
  const c = candidate();
  c.mint = mint;
  c.symbol = mint;
  c.discovery!.trending!.lastSeenAt = at;
  c.discovery!.lastSeenAt = at;
  return c;
};
test("FIFO selects an older z/y mint before a newer 1/A mint", () => {
  const store = new Store(":memory:");
  const life = new CandidateLifecycle(store, () => settings);
  try {
    assert.deepEqual(
      life.refill([
        appearance("z-old"),
        appearance("y-old"),
        appearance("1-new"),
      ]),
      ["z-old", "y-old", "1-new"],
    );
  } finally {
    store.close();
  }
});

function begin(
  store: Store,
  life: CandidateLifecycle,
  attempts: CandidateAttempts,
) {
  const mint = life.refill([])[0]!;
  const row = life.get(mint)!;
  const c = appearance(mint);
  return store.atomic(() => {
    life.setState(mint, "ANALYZING");
    return attempts.begin(c, {
      appearanceId: row.appearanceId!,
      batchId: row.batchId!,
    });
  });
}
test("100-token batch drains through 10 slots in FIFO order; consumed is not completed", async () => {
  const store = new Store(":memory:"),
    life = new CandidateLifecycle(store, () => ({
      ...settings,
      candidateQueueSize: 10,
    })),
    attempts = new CandidateAttempts(store);
  const rows = Array.from({ length: 100 }, (_, i) =>
    appearance(
      i < 4 ? ["z-Ruby", "y-AMD", "y-1SHARE", "z-old"][i]! : "1-new-" + i,
    ),
  );
  store.enqueueTrending(rows, env.TRADING_MODE, batchTime);
  const g = provider().gmgn;
  let calls = 0;
  g.trending = async () => {
    calls++;
    return [];
  };
  const discovery = new DiscoveryCoordinator(store, g, () => settings);
  try {
    for (let i = 0; i < 100; i++) {
      const a = begin(store, life, attempts);
      assert.equal(a.mint, rows[i]!.mint);
      assert.ok(life.list().length <= 10);
      const progress = store.trendingBatchProgress();
      assert.equal(progress.total, 100);
      assert.equal(progress.completed, i);
      assert.equal(progress.processing, 1);
      assert.equal(progress.waiting, 99 - i);
      assert.equal(
        progress.total,
        progress.completed! + progress.processing + progress.waiting,
      );
      if (i === 71)
        assert.deepEqual(
          [
            progress.total,
            progress.completed,
            progress.processing,
            progress.waiting,
          ],
          [100, 71, 1, 28],
        );
      if (i >= 90) {
        await discovery.poll(batchTime + 1000000 + i);
        assert.equal(calls, 0);
      }
      attempts.end("REJECTED");
      life.finish(a.mint);
    }
    assert.equal(store.trendingBatchProgress().state, "COMPLETE");
    assert.equal(store.trendingBatchProgress().completed, 100);
    await discovery.poll(batchTime + 2000000);
    assert.equal(calls, 1);
  } finally {
    await discovery.stop();
    store.close();
  }
});
test("one mint per snapshot, same mint allowed in a later batch, cached snapshots never re-arm", async () => {
  const store = new Store(":memory:"),
    life = new CandidateLifecycle(store, () => settings),
    attempts = new CandidateAttempts(store),
    g = provider().gmgn;
  const c = appearance("same");
  let response = [c, structuredClone(c)],
    calls = 0;
  g.trending = async () => {
    calls++;
    return response;
  };
  const discovery = new DiscoveryCoordinator(store, g, () => settings);
  try {
    await discovery.poll(batchTime);
    assert.equal(store.trendingBatchProgress().total, 1);
    assert.equal(
      Number(
        store.db.prepare("SELECT count(*) n FROM trending_appearances").get()!
          .n,
      ),
      1,
    );
    const a = begin(store, life, attempts);
    attempts.end("REJECTED");
    life.finish(a.mint);
    await discovery.poll(batchTime + settings.trendingPollMs);
    assert.equal(store.trendingBatchProgress().completed, 1);
    assert.deepEqual(life.refill([]), []);
    response = [appearance("same", batchTime + 1)];
    await discovery.poll(batchTime + 2 * settings.trendingPollMs);
    assert.equal(calls, 3);
    assert.equal(store.trendingBatchProgress().completed, 0);
    assert.equal(begin(store, life, attempts).mint, "same");
  } finally {
    await discovery.stop();
    store.close();
  }
});
test("two poll callers share a single in-flight discovery and error/empty responses respect cadence", async () => {
  const store = new Store(":memory:"),
    g = provider().gmgn;
  let calls = 0,
    release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  g.trending = async () => {
    calls++;
    await wait;
    return [];
  };
  const discovery = new DiscoveryCoordinator(store, g, () => settings);
  try {
    const first = discovery.poll(batchTime),
      second = discovery.poll(batchTime);
    assert.equal(calls, 1);
    release();
    await Promise.all([first, second]);
    assert.equal(store.trendingBatchProgress().total, 0);
    await discovery.poll(batchTime + 1);
    assert.equal(calls, 1);
    g.trending = async () => {
      calls++;
      throw Error("fixture provider");
    };
    await discovery.poll(batchTime + settings.trendingPollMs);
    assert.equal(discovery.feeds.TRENDING.state, "DEGRADED");
    await discovery.poll(batchTime + settings.trendingPollMs + 1);
    assert.equal(calls, 2);
  } finally {
    await discovery.stop();
    store.close();
  }
});
test("legacy multi-batch backlog preserves every appearance, oldest batch first, with unknown original totals", () => {
  const store = new Store(":memory:"),
    life = new CandidateLifecycle(store, () => settings),
    attempts = new CandidateAttempts(store);
  try {
    store.enqueueTrending([
      appearance("z-old", batchTime - 2000),
      appearance("y-old", batchTime - 2000),
    ]);
    store.enqueueTrending([
      appearance("1-new", batchTime - 1000),
      appearance("z-old", batchTime - 1000),
    ]);
    const seen = [];
    for (let i = 0; i < 4; i++) {
      const a = begin(store, life, attempts);
      seen.push(a.mint);
      assert.equal(store.trendingBatchProgress().total, null);
      attempts.end("REJECTED");
      life.finish(a.mint);
    }
    assert.deepEqual(seen, ["z-old", "y-old", "1-new", "z-old"]);
    assert.equal(store.trendingWorkPending(), false);
    assert.equal(
      Number(
        store.db.prepare("SELECT count(*) n FROM trending_appearances").get()!
          .n,
      ),
      4,
    );
  } finally {
    store.close();
  }
});
test("durable batch counters survive real DB reopen, recover an interrupted attempt and never replay it", () => {
  const dir = mkdtempSync(join(tmpdir(), "sniper-trending-fifo-")),
    path = join(dir, "fixture.sqlite");
  let store = new Store(path),
    life = new CandidateLifecycle(store, () => settings),
    attempts = new CandidateAttempts(store);
  try {
    store.enqueueTrending(
      [appearance("z-old"), appearance("1-new")],
      env.TRADING_MODE,
      batchTime,
    );
    const a = begin(store, life, attempts);
    const queuedBeforeRestart = life.get("1-new");
    store.close();
    store = new Store(path);
    life = new CandidateLifecycle(store, () => settings);
    attempts = new CandidateAttempts(store);
    assert.deepEqual(
      life.get("1-new"),
      queuedBeforeRestart,
      "Restart preserves queue identity and original wait timestamps",
    );
    assert.equal(attempts.current!.reasonCode, "PROCESS_INTERRUPTED");
    assert.equal(store.trendingBatchProgress().completed, 1);
    assert.equal(store.trendingBatchProgress().waiting, 1);
    assert.equal(begin(store, life, attempts).mint, "1-new");
    attempts.end("REJECTED");
    life.finish("1-new");
    store.db.prepare("DELETE FROM trending_appearances WHERE consumed=1").run();
    assert.equal(store.trendingBatchProgress().completed, 2);
    assert.equal(store.executions().length, 0);
    assert.ok(a.appearanceId);
  } finally {
    store.close();
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
    rmSync(dir, { recursive: true, force: true });
  }
});
test("RECONCILING remains processing through restart until a real terminal outcome; old branch callbacks cannot count twice", async () => {
  const store = new Store(":memory:"),
    life = new CandidateLifecycle(store, () => settings);
  let attempts = new CandidateAttempts(store);
  const g = provider().gmgn;
  let calls = 0;
  g.trending = async () => {
    calls++;
    return [];
  };
  const discovery = new DiscoveryCoordinator(store, g, () => settings);
  try {
    store.enqueueTrending([appearance("old")], env.TRADING_MODE, batchTime);
    const a = begin(store, life, attempts);
    attempts.summary("intentId", "unresolved-intent");
    store.db.prepare("INSERT INTO executions VALUES(?,?,?,?,?)").run(
      "unresolved",
      "unresolved-intent",
      "UNKNOWN",
      "fixture-signature",
      JSON.stringify({
        id: "unresolved",
        state: "UNKNOWN",
        signature: "fixture-signature",
        intent: {
          id: "unresolved-intent",
          mode: env.TRADING_MODE,
          positionId: "fixture-position",
        },
      }),
    );
    attempts.end("RECONCILING", Error("fixture unresolved"));
    life.finish(a.mint);
    attempts = new CandidateAttempts(store);
    assert.equal(store.trendingBatchProgress().completed, 0);
    assert.equal(store.trendingBatchProgress().processing, 1);
    assert.equal(store.trendingBatchProgress().state, "RECOVERY");
    await discovery.poll(batchTime + 100000);
    assert.equal(calls, 0);
    store.db
      .prepare(
        "UPDATE executions SET state='FAILED',payload=json_set(payload,'$.state','FAILED') WHERE id='unresolved'",
      )
      .run();
    attempts.reconcile();
    assert.equal(store.trendingBatchProgress().completed, 1);
    store.enqueueTrending(
      [appearance("new", batchTime + 1)],
      env.TRADING_MODE,
      batchTime + 1,
    );
    begin(store, life, attempts);
    attempts.strategy(a.attemptId, "STANDARD", {
      decision: "BUY",
      execution: "BLOCKED_OWNER_ALREADY_CLAIMED",
    });
    assert.equal(store.trendingBatchProgress().completed, 0);
    assert.equal(store.trendingBatchProgress().processing, 1);
  } finally {
    await discovery.stop();
    store.close();
  }
});
test("discovery drain does not block the shared GMGN reads used for fresh evidence or Position monitoring", async () => {
  const store = new Store(":memory:"),
    p = provider(),
    d = new DiscoveryCoordinator(store, p.gmgn, () => settings);
  try {
    store.enqueueTrending([appearance("pending")]);
    await d.poll();
    assert.equal(
      p.calls.some((x) => x[1] === "trending"),
      false,
    );
    const c = candidate();
    await p.gmgn.info(c.mint, 0, { consumer: "position-monitor" });
    await p.gmgn.security({ ...c, listing: {} }, settings, {
      consumer: "pre-buy",
    });
    assert.equal(p.calls.filter((x) => x[1] === "info").length, 1);
    assert.equal(p.calls.filter((x) => x[1] === "security").length, 1);
    assert.equal(store.executions().length, 0);
  } finally {
    await d.stop();
    store.close();
  }
});
test("discovery cannot fetch with one appearance waiting below the working queue cap", async () => {
  const store = new Store(":memory:");
  const g = provider().gmgn;
  let calls = 0;
  g.trending = async () => {
    calls++;
    return [];
  };
  const d = new DiscoveryCoordinator(store, g, () => settings);
  try {
    store.enqueueTrending([appearance("old")]);
    await d.poll();
    assert.equal(calls, 0);
  } finally {
    await d.stop();
    store.close();
  }
});

test("real Engine cycles process all 100 in FIFO order with fresh security after a long listing wait", async () => {
  const store = new Store(":memory:");
  store.set("strategyV2", { ...settings, candidatesPerCycle: 5 });
  const p = provider(async (args) =>
    args[1] === "security"
      ? { renounced_mint: false, renounced_freeze_account: true }
      : undefined,
  );
  const e = new Engine(store, { gmgn: p.gmgn });
  const rows = Array.from({ length: 100 }, (_, i) =>
    new PublicKey(new Uint8Array(32).fill(i + 1)).toBase58(),
  )
    .sort()
    .reverse()
    .map((mint) => appearance(mint, batchTime - 3600000));
  let fetched = 0;
  p.gmgn.trending = async () => {
    fetched++;
    return rows;
  };
  try {
    for (let i = 0; i < 20; i++) {
      await e.tick();
      assert.equal(fetched, 1, "No list refresh before all 100 finish");
      assert.equal(store.trendingBatchProgress().completed, (i + 1) * 5);
    }
    const attempts = store.db
      .prepare(
        "SELECT payload FROM candidate_attempts ORDER BY CAST(json_extract(payload,'$.appearanceId') AS INTEGER)",
      )
      .all()
      .map((r) => JSON.parse(String(r.payload)));
    assert.deepEqual(
      attempts.map((a) => a.mint),
      rows.map((c) => c.mint),
    );
    assert.equal(attempts.length, 100);
    for (const a of attempts) {
      assert.equal(a.result, "REJECTED");
      assert.equal(a.failedStage, "SECURITY");
      assert.ok(a.summaries.security.at >= a.startedAt);
      assert.ok(a.summaries.market.at >= a.startedAt);
    }
    assert.equal(p.calls.filter((args) => args[1] === "info").length, 100);
    assert.equal(p.calls.filter((args) => args[1] === "security").length, 100);
    assert.equal(store.executions().length, 0);
    assert.equal(store.get("haltReason"), undefined);
  } finally {
    await e.stop();
    store.close();
  }
});

test("a missing processing attempt is reported as recovery, never silently completed or resent", async () => {
  const store = new Store(":memory:"),
    life = new CandidateLifecycle(store, () => settings),
    attempts = new CandidateAttempts(store),
    g = provider().gmgn;
  let calls = 0;
  g.trending = async () => {
    calls++;
    return [];
  };
  const d = new DiscoveryCoordinator(store, g, () => settings);
  try {
    store.enqueueTrending([appearance("orphan")], env.TRADING_MODE, batchTime);
    const a = begin(store, life, attempts);
    store.db
      .prepare("DELETE FROM candidate_attempts WHERE id=?")
      .run(a.attemptId);
    life.finish(a.mint);
    store.recoverTrendingBatch();
    assert.equal(store.trendingBatchProgress().completed, 0);
    assert.equal(store.trendingBatchProgress().state, "RECOVERY");
    await d.poll();
    assert.equal(calls, 0);
    assert.equal(store.executions().length, 0);
  } finally {
    await d.stop();
    store.close();
  }
});

test("late comparison work holds discovery only until it settles; no wait is added to BUY execution", async () => {
  const store = new Store(":memory:"),
    p = provider(),
    e = new Engine(store, { gmgn: p.gmgn });
  let fetched = 0,
    release!: () => void;
  p.gmgn.trending = async () => {
    fetched++;
    return [];
  };
  e.trackEntryEvaluation(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  try {
    await e.discovery.poll();
    assert.equal(fetched, 0);
    assert.equal(e.overviewStatus().batch.analysisPending, true);
    release();
    await e.settleEntryEvaluations();
    await e.discovery.poll();
    assert.equal(fetched, 1);
    assert.equal(store.executions().length, 0);
  } finally {
    release();
    await e.stop();
    store.close();
  }
});
