import { test, mock, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VersionedTransaction, Connection, PublicKey } from "@solana/web3.js";
import {
  DiscoveryBatches,
  DISCOVERY_BATCH_TTL_MS,
} from "../src/discovery-batch.js";
import { KronosLab } from "../src/kronos-lab.js";
import { KronosLab as PreviousLab } from "./baseline-lab.js";
import { KronosStore } from "../src/kronos-store.js";
import { KronosMarket, type LabMarket } from "../src/kronos-market.js";
import { startKronos } from "../src/server.js";
import { ROOT, runtimeConfig } from "../src/config.js";
import { candidate, bars, forecast } from "./fixtures.js";
import type { Candidate } from "../src/domain.js";

const START = Date.parse("2026-11-02T10:00:12Z");
const flush = () => new Promise<void>((r) => setImmediate(r));

test("measured old/new scheduler comparison: 31 candidates within TTL use old 3 list calls vs new 1", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: START });
  function lane(previous: boolean) {
    const store = new KronosStore(":memory:");
    let list = 0,
      evaluations = 0;
    const market: LabMarket = {
      discover: async () => {
        list++;
        return rows(50);
      },
      prepare: async (_c, stage) => {
        evaluations++;
        for (const n of [
          "CHEAP_FILTER",
          "SECURITY",
          "COMPATIBILITY",
          "HISTORY",
          "CAPITAL_FLOW",
        ])
          await stage(n, async () => ({ fixture: true }));
        return { candles: bars(), evidence: {} };
      },
      history: async () => ({ candles: bars(), evidence: {} }),
      price: async () => undefined,
    };
    const inference = {
      forecast: async (c: ReturnType<typeof bars>, at: number) =>
        forecast(c, at, 0),
      stop() {},
      status: () => ({}),
    };
    const lab = previous
      ? new PreviousLab(store, market, inference)
      : new KronosLab(store, market, inference);
    return { store, lab, counts: () => ({ list, evaluations }) };
  }
  const old = lane(true),
    next = lane(false);
  try {
    await next.lab.discover();
    old.lab.setEnabled(true);
    next.lab.setEnabled(true);
    for (let i = 0; i < 31; i++) {
      t.mock.timers.setTime(START + i * 9000);
      await old.lab.tick();
      await next.lab.tick();
    }
    assert.deepEqual(old.counts(), { list: 3, evaluations: 31 });
    assert.deepEqual(next.counts(), { list: 1, evaluations: 31 });
    writeFileSync(
      "evidence/discovery-batch-efficiency-fixture.json",
      JSON.stringify(
        {
          fixtureOnly: true,
          elapsedMs: 270000,
          received: 50,
          processed: 31,
          old: old.counts(),
          new: next.counts(),
          realProviderRequests: 0,
          realSignatures: 0,
          realSubmissions: 0,
        },
        null,
        2,
      ),
    );
  } finally {
    old.lab.setEnabled(false);
    next.lab.setEnabled(false);
    await old.lab.stop();
    await next.lab.stop();
    old.store.close();
    next.store.close();
  }
});
function rows(n: number, prefix = "mint", sequence = START): Candidate[] {
  return Array.from({ length: n }, (_, i) => {
    const c = candidate();
    c.mint = prefix + i;
    c.discovery!.trending!.sequenceStartedAt = sequence;
    return c;
  });
}
function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ["Date"], now: START });
  const store = new KronosStore(":memory:");
  let calls = 0,
    inferences = 0,
    active = 0,
    maxActive = 0;
  const prepared: string[] = [],
    monitored: string[] = [];
  const batches: Candidate[][] = [rows(50), []];
  const market: LabMarket = {
    discover: async () => {
      calls++;
      return batches.shift() ?? [];
    },
    prepare: async (c, stage) => {
      prepared.push(c.mint);
      for (const s of [
        "CHEAP_FILTER",
        "SECURITY",
        "COMPATIBILITY",
        "HISTORY",
        "CAPITAL_FLOW",
      ])
        await stage(s, async () => ({ fixture: true }));
      return { candles: bars(), evidence: {} };
    },
    history: async (c) => {
      monitored.push(c.mint);
      return { candles: bars(), evidence: {} };
    },
    price: async () => ({
      value: 1,
      observedAt: Date.now(),
      source: "GMGN_TOKEN_INFO",
    }),
  };
  const inference = {
    forecast: async (c: ReturnType<typeof bars>, at: number) => {
      inferences++;
      active++;
      maxActive = Math.max(maxActive, active);
      await flush();
      active--;
      return forecast(c, at, 0);
    },
    stop() {},
    status: () => ({}),
  };
  const lab = new KronosLab(store, market, inference);
  t.after(async () => {
    lab.setEnabled(false);
    await lab.stop();
    store.close();
  });
  return {
    store,
    market,
    inference,
    lab,
    batches,
    prepared,
    monitored,
    clock: (ms: number) => t.mock.timers.setTime(START + ms),
    counts: () => ({ calls, inferences, maxActive }),
  };
}

test("A/C: 50 full eligibility/model attempts in 3m use one rank fetch; exhaustion fetches next immediately", async (t) => {
  const h = setup(t);
  await h.lab.discover();
  h.lab.setEnabled(true);
  const initial = h.lab.discovery.view().batch!;
  assert.equal(DISCOVERY_BATCH_TTL_MS, 300000);
  for (let i = 0; i < 50; i++) {
    h.clock(i * 3600);
    await h.lab.tick();
    if (i < 49) assert.equal(h.counts().calls, 1);
    assert.equal(initial.fetchedAt, START);
    assert.equal(initial.expiresAt, START + 300000);
  }
  await flush();
  assert.equal(h.counts().calls, 2);
  assert.equal(h.counts().inferences, 50);
  assert.equal(h.counts().maxActive, 1);
  const previous = h.store.get("discoverySchedulerV1:PAPER:previous");
  assert.equal(previous.status, "EXHAUSTED");
  assert.equal(previous.processedCount, 50);
  assert.equal(previous.ageMs, 176400);
  assert.equal(
    h.store.trials().filter((x) => x.status === "WAIT_BUY").length,
    50,
  );
});

test("B: TTL expires 31/50 at exactly successful response +5m; 19 unscheduled rows are not rejects/errors/decisions", async (t) => {
  const h = setup(t);
  await h.lab.discover();
  h.lab.setEnabled(true);
  for (let i = 0; i < 31; i++) {
    h.clock(i * 9000);
    await h.lab.tick();
  }
  assert.equal(h.counts().calls, 1);
  const old = h.lab.discovery.view().batch!;
  h.clock(300000);
  h.lab.discovery.poll();
  await flush();
  const expired = h.store.get("discoverySchedulerV1:PAPER:previous");
  assert.equal(expired.batchId, old.batchId);
  assert.equal(expired.status, "EXPIRED");
  assert.equal(expired.processedCount, 31);
  assert.equal(expired.expiredUnprocessedCount, 19);
  assert.equal(h.counts().calls, 2);
  const skipped = h.store
    .trials()
    .filter((x) => x.status === "EXPIRED_UNPROCESSED");
  assert.equal(skipped.length, 19);
  for (const r of skipped) {
    assert.equal(r.checkedAt, undefined);
    assert.equal(r.latest, undefined);
    assert.equal(h.store.decisions(r.id).length, 0);
    assert.deepEqual(r.gates, {});
  }
  await h.lab.tick();
  assert(!h.prepared.some((m) => Number(m.slice(4)) >= 31));
});

test("D: TTL can rotate discovery while an inference runs; active work finishes once and old remaining work never starts", async (t) => {
  const h = setup(t);
  await h.lab.discover();
  h.lab.setEnabled(true);
  h.clock(299000);
  let release!: () => void,
    stopped = 0;
  h.inference.forecast = async (c, at) => {
    await new Promise<void>((r) => {
      release = r;
    });
    return forecast(c, at, 0);
  };
  h.inference.stop = () => {
    stopped++;
  };
  const active = h.lab.tick();
  while (!release) await flush();
  try {
    h.clock(300000);
    await h.lab.tick();
    await flush();
    assert.equal(h.counts().calls, 2);
    assert.equal(stopped, 0);
    assert.equal(h.prepared.length, 1);
    assert.equal(
      h.store.trials().filter((r) => r.status === "EXPIRED_UNPROCESSED").length,
      49,
    );
  } finally {
    release();
    await active;
  }
  assert.equal(
    h.store.trials().find((r) => r.mint === "mint0")!.latest!.action,
    "WAIT",
  );
  assert.equal(h.prepared.length, 1);
  const previous = h.store.get("discoverySchedulerV1:PAPER:previous");
  assert.equal(previous.processedCount, 1);
  assert.equal(previous.expiredUnprocessedCount, 49);
});

test("E: OPEN due monitor precedes 100 current candidates; no new rank fetch and concurrency stays one", async (t) => {
  const h = setup(t);
  h.batches[0] = rows(100);
  await h.lab.discover();
  const p = h.store.add({
    mint: "owned",
    appearance: "owned",
    discoveredAt: START,
  })!;
  p.entry = { value: 1, observedAt: START - 60000, source: "GMGN_TOKEN_INFO" };
  p.status = "OPEN";
  p.nextAt = 0;
  h.store.save(p);
  h.lab.setEnabled(true);
  await h.lab.tick();
  assert.deepEqual(h.monitored, ["owned"]);
  assert.deepEqual(h.prepared, []);
  assert.equal(h.store.trial(p.id)!.latest!.action, "HOLD");
  assert.equal(h.counts().calls, 1);
  assert.equal(h.counts().maxActive, 1);
  assert.equal(h.lab.discovery.view().batch!.pendingCount, 100);
});

test("F: expired unprocessed same appearance can requeue, processed appearance cannot; real new sequence may admit", async (t) => {
  const h = setup(t);
  const same = rows(2);
  h.batches.splice(0, 2, same, same, rows(2, "mint", START + 600000));
  await h.lab.discover();
  h.lab.setEnabled(true);
  await h.lab.tick();
  const first = h.store.trials().find((r) => r.mint === "mint0")!;
  first.status = "REJECTED";
  h.store.save(first);
  const unprocessed = h.store.trials().find((r) => r.mint === "mint1")!;
  h.clock(300000);
  await h.lab.discover();
  assert.equal(h.store.count(), 2);
  assert.equal(h.store.trial(unprocessed.id)!.status, "ANALYZING");
  assert.equal(h.lab.discovery.view().batch!.pendingCount, 1);
  assert.equal(h.lab.discovery.view().batch!.skippedCount, 1);
  h.lab.setEnabled(false);
  await h.lab.step(unprocessed.id);
  const other = h.store.trial(unprocessed.id)!;
  other.status = "REJECTED";
  h.store.save(other);
  h.clock(600000);
  await h.lab.discover();
  assert.equal(h.store.count(), 4);
  assert.equal(h.lab.discovery.view().batch!.pendingCount, 2);
});

test("provider raw count vs duplicates, snapshot timestamp TTL, stable fallback survives polling/reopen and empty batches back off", async (t) => {
  const h = setup(t);
  const first = rows(45);
  for (const c of first)
    c.discovery!.trending!.sequenceOrigin = "LOCAL_SNAPSHOT";
  h.batches.splice(0, 2, [...first, ...first.slice(0, 5)], first);
  h.market.discoveryMetadata = () => ({
    fetchedAt: START,
    rawReceivedCount: 50,
  });
  await h.lab.discover();
  const b = h.lab.discovery.view().batch!;
  assert.equal(b.rawReceivedCount, 50);
  assert.equal(b.uniqueCount, 45);
  assert.equal(b.duplicateCount, 5);
  for (const row of h.store.trials()) {
    h.lab.discovery.started(row);
    row.checkedAt = START;
    row.status = "REJECTED";
    h.store.save(row);
    h.lab.discovery.finished(row);
  }
  h.clock(1000);
  for (const c of first) {
    c.discoveredAt = Date.now();
    c.discovery!.trending!.sequenceStartedAt = Date.now();
  }
  h.market.discoveryMetadata = () => ({
    fetchedAt: Date.now(),
    rawReceivedCount: 45,
  });
  await h.lab.discover();
  assert.equal(h.store.count(), 45);
  assert.equal(h.lab.discovery.view().batch!.skippedCount, 45);
  for (let i = 0; i < 20; i++) h.lab.discovery.poll();
  await flush();
  assert.equal(h.counts().calls, 2);
  const reopen = new DiscoveryBatches(h.store, h.market, "PAPER");
  assert.equal(reopen.view().batch!.fetchedAt, START + 1000);
  assert.equal(reopen.view().batch!.expiresAt, START + 301000);
  reopen.poll();
  await flush();
  assert.equal(h.counts().calls, 2);
});

test("H: failed refresh never resurrects expired jobs; bounded retry respects cooldown while OPEN monitoring continues", async (t) => {
  const h = setup(t);
  await h.lab.discover();
  const p = h.store.add({
    mint: "owned",
    appearance: "owned",
    discoveredAt: START,
  })!;
  p.entry = { value: 1, observedAt: START, source: "GMGN_TOKEN_INFO" };
  p.status = "OPEN";
  h.store.save(p);
  let failed = 0,
    cooldown = 0;
  h.market.discover = async () => {
    failed++;
    cooldown = START + 600000;
    throw Error("LAB_PUBLIC_PROVIDER_HTTP_429");
  };
  h.market.retryAt = () => cooldown;
  h.clock(300000);
  h.lab.setEnabled(true);
  await h.lab.tick();
  await flush();
  assert.equal(failed, 1);
  assert.equal(h.lab.discovery.view().fetchStatus, "FETCH_FAILED");
  assert.equal(h.lab.discovery.view().batch!.expiredUnprocessedCount, 50);
  for (let i = 1; i < 299; i++) {
    h.clock(300000 + i * 1000);
    await h.lab.tick();
  }
  assert.equal(failed, 1);
  assert(h.monitored.length >= 4);
  assert.equal(h.prepared.length, 0);
  assert.equal(h.store.trial(p.id)!.status, "OPEN");
  h.clock(600000);
  await h.lab.tick();
  await flush();
  assert.equal(failed, 2);
});

test("successful fetch completion owns TTL; slow fetch single-flight does not start TTL at request or first evaluation", async (t) => {
  const h = setup(t);
  let release!: (c: Candidate[]) => void;
  h.market.discover = () =>
    new Promise((r) => {
      release = r;
    });
  const flight = h.lab.discover();
  for (let i = 0; i < 20; i++) h.lab.discovery.poll();
  assert.equal(h.lab.discovery.view().listFetchCount, 1);
  assert.equal(h.lab.discovery.view().batch, null);
  h.clock(12000);
  release(rows(2));
  await flight;
  assert.equal(h.lab.discovery.view().batch!.fetchedAt, START + 12000);
  assert.equal(h.lab.discovery.view().batch!.expiresAt, START + 312000);
});

test("candidate scheduling respects shared provider cooldown without burning pending rows as SECURITY_REJECT", async (t) => {
  const h = setup(t);
  await h.lab.discover();
  h.market.retryAt = () => START + 120000;
  h.lab.setEnabled(true);
  for (let i = 0; i < 120; i++) {
    h.clock(i * 1000);
    await h.lab.tick();
  }
  assert.equal(h.counts().calls, 1);
  assert.equal(h.prepared.length, 0);
  assert.equal(h.lab.discovery.view().batch!.pendingCount, 50);
  assert(
    h.store
      .trials()
      .every((r) => r.status === "ANALYZING" && r.checkedAt === undefined),
  );
  h.clock(120000);
  await h.lab.tick();
  assert.equal(h.prepared.length, 1);
  assert.equal(h.lab.discovery.view().batch!.processedCount, 1);
});

test("missing provider sequence never turns a previously handled provider appearance into a new stable appearance", async (t) => {
  const h = setup(t);
  const c = rows(1)[0]!;
  h.batches.splice(
    0,
    2,
    [c],
    [
      {
        ...c,
        discovery: {
          ...c.discovery!,
          trending: {
            ...c.discovery!.trending!,
            sequenceOrigin: "LOCAL_SNAPSHOT",
            sequenceStartedAt: START + 300000,
          },
        },
      },
    ],
  );
  await h.lab.discover();
  const r = h.store.trials()[0]!;
  h.lab.discovery.started(r);
  r.checkedAt = START;
  r.status = "REJECTED";
  h.store.save(r);
  h.lab.discovery.finished(r);
  h.clock(300000);
  await h.lab.discover();
  assert.equal(h.store.count(), 1);
  assert.equal(h.lab.discovery.view().batch!.skippedCount, 1);
});

test("reopen keeps original batch deadline; legacy unstarted history is preserved as unevaluated and OPEN/CLOSED rows are untouched", async (t) => {
  const h = setup(t);
  const legacy = h.store.add({
    mint: "legacy",
    appearance: "old-transport-timestamp",
    discoveredAt: START - 600000,
  })!;
  const owned = h.store.add({
    mint: "owned",
    appearance: "owned",
    discoveredAt: START,
  })!;
  owned.entry = { value: 1, observedAt: START, source: "GMGN_TOKEN_INFO" };
  owned.status = "OPEN";
  h.store.save(owned);
  const closed = h.store.add({
    mint: "closed",
    appearance: "closed",
    discoveredAt: START,
  })!;
  closed.status = "CLOSED";
  closed.checkedAt = START;
  h.store.save(closed);
  const before = h.store.db
    .prepare("SELECT payload FROM lab_trials WHERE id IN (?,?) ORDER BY id")
    .all(owned.id, closed.id);
  await h.lab.discover();
  assert.equal(h.store.trial(legacy.id)!.status, "EXPIRED_UNPROCESSED");
  assert.equal(h.store.trial(legacy.id)!.latest, undefined);
  assert.deepEqual(
    h.store.db
      .prepare("SELECT payload FROM lab_trials WHERE id IN (?,?) ORDER BY id")
      .all(owned.id, closed.id),
    before,
  );
  h.clock(200000);
  const reopened = new DiscoveryBatches(h.store, h.market, "PAPER");
  assert.equal(reopened.view().batch!.expiresAt, START + 300000);
  h.clock(300000);
  reopened.poll();
  await reopened.stop();
  assert.equal(
    h.store.get("discoverySchedulerV1:PAPER:previous").expiredUnprocessedCount,
    50,
  );
});

test("actual GMGN adapter keeps requested rank limit50, measures raw rows and labels local timestamp vs explicit provider sequence", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: START });
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (u) => {
    const url = new URL(String(u));
    assert.equal(url.pathname, "/v1/market/rank");
    assert.equal(url.searchParams.get("limit"), "50");
    calls++;
    return Response.json({
      code: 0,
      data: {
        rank: [
          {
            address: new PublicKey(Buffer.alloc(32, 1)).toBase58(),
            symbol: "LOCAL",
          },
          {
            address: new PublicKey(Buffer.alloc(32, 2)).toBase58(),
            sequenceStartedAt: START - 1000,
          },
        ],
      },
    });
  };
  try {
    const m = new KronosMarket("fixture-only");
    const c = await m.discover();
    assert.equal(c.length, 2);
    assert.equal(m.discoveryMetadata()!.rawReceivedCount, 2);
    assert.equal(c[0]!.discovery!.trending!.sequenceOrigin, "LOCAL_SNAPSHOT");
    assert.equal(c[1]!.discovery!.trending!.sequenceOrigin, "PROVIDER");
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = previous;
  }
});

test("process reopen reports interrupted work honestly without inventing a processed candidate or model decision", async (t) => {
  const h = setup(t);
  await h.lab.discover();
  const trial = h.store.trials()[0]!;
  h.lab.discovery.started(trial);
  trial.checkedAt = START;
  h.store.save(trial);
  const reopened = new DiscoveryBatches(h.store, h.market, "PAPER");
  assert.equal(reopened.view().batch!.processedCount, 0);
  assert.equal(reopened.view().batch!.interruptedCount, 1);
  assert.equal(reopened.view().batch!.pendingCount, 49);
  assert.equal(reopened.view().batch!.expiresAt, START + 300000);
  assert.equal(h.store.trial(trial.id)!.latest, undefined);
});

test("G: 300 actual API overview polls plus status/history/statistics/logs create zero extra list calls; no real sign/send", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: START });
  const forbidden = [
    mock.method(VersionedTransaction.prototype, "sign", () => {
      throw Error("SIGN_FORBIDDEN");
    }),
    mock.method(Connection.prototype, "sendTransaction", () => {
      throw Error("SEND_FORBIDDEN");
    }),
  ];
  const dir = mkdtempSync(join(ROOT, "data", "test-batch-api-"));
  let calls = 0;
  const market: LabMarket = {
    discover: async () => {
      calls++;
      return rows(50);
    },
    prepare: async () => ({ candles: bars(), evidence: {} }),
    history: async () => ({ candles: bars(), evidence: {} }),
    price: async () => undefined,
  };
  const port = 53200 + Math.floor(Math.random() * 500);
  const app = await startKronos(
    runtimeConfig({
      KRONOS_PORT: String(port),
      KRONOS_DATABASE_PATH: join(dir, "db.sqlite"),
      KRONOS_RUNTIME: join(dir, "runtime"),
      KRONOS_LOG_DIR: join(dir, "logs"),
    }),
    {
      market,
      inference: {
        forecast: async (c, at) => forecast(c, at, 0),
        stop() {},
        status: () => ({}),
      },
      timer: false,
    },
  );
  try {
    await app.lab.discover();
    const address = app.server.address();
    assert(address && typeof address !== "string");
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 300; i++) {
      t.mock.timers.setTime(START + i * 1000);
      const overview = await fetch(base + "/api/overview");
      assert.equal(overview.status, 200);
      await overview.json();
      if (i % 30 === 0)
        for (const path of [
          "/api/status",
          "/api/history",
          "/api/statistics",
          "/api/logs",
        ]) {
          const response = await fetch(base + path);
          assert.equal(response.status, 200);
          await response.json();
        }
    }
    assert.equal(calls, 1);
    assert.equal(app.lab.discovery.view().candidateEvaluationCount, 0);
    t.mock.timers.setTime(START + 300000);
    app.lab.setEnabled(true);
    await app.lab.tick();
    await flush();
    assert.equal(calls, 2);
    writeFileSync(
      "evidence/discovery-batch-api-fixture.json",
      JSON.stringify(
        {
          overviewPolls: 300,
          otherApiPolls: 40,
          rankCallsDuringWindow: 1,
          rankCallsAfterTtl: 2,
          realSign: 0,
          realSubmit: 0,
          fixtureOnly: true,
        },
        null,
        2,
      ),
    );
  } finally {
    await app.stop();
    for (const f of forbidden) {
      assert.equal(f.mock.callCount(), 0);
      f.mock.restore();
    }
  }
});
