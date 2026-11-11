import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { DatabaseRegistry } from "../src/database-registry.js";
import { ChartStore, chartId } from "../src/chart-store.js";
import type { LearningRule } from "../src/chart-features.js";
import { DatabaseSync } from "node:sqlite";
import { Engine } from "../src/engine.js";
import {
  fixtureRpc,
  fixtureQuotes,
  fakeKronos,
  fundFixtureHolding,
} from "./kronos-fixtures.js";
import { ChartLearning } from "../src/chart-learning.js";
import { Store } from "../src/store.js";
import { migrateDatabases, verify } from "../src/database-migration.js";
import { ModeManager } from "../src/mode-manager.js";
import { position, provider, candidate, info } from "./fixtures.js";
import { candles } from "./one-shot-fixtures.js";
import { normalizeMarket } from "../src/gmgn.js";
import { parseMarketHistory } from "../src/market-history.js";
import { env } from "../src/config.js";
import { setup, mockExecutionCase } from "./one-shot-fixtures.js";
import { CodexRuntime } from "../src/codex-runtime.js";
import { Worker } from "node:worker_threads";
function directory() {
  return mkdtempSync(join(tmpdir(), "three-database-"));
}
function clean(dir: string) {
  assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
  assert.ok(basename(dir).startsWith("three-database-"));
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
test("immutable contexts isolate physical trading writes and share exactly one learning connection", () => {
  const dir = directory();
  let r: DatabaseRegistry | undefined;
  try {
    r = new DatabaseRegistry(dir);
    assert.notEqual(r.demo.db, r.live.db);
    assert.equal(r.demo.learningDb, r.live.learningDb);
    assert.equal(r.demo.boundMode, "demo");
    assert.equal(r.live.boundMode, "live");
    r.demo.savePosition({ ...position(), mode: "demo" });
    r.live.savePosition({ ...position(), mode: "live" });
    assert.equal(r.demo.positions().length, 1);
    assert.equal(r.live.positions().length, 1);
    assert.throws(
      () => r!.demo.savePosition({ ...position(), mode: "live" }),
      /MODE_MISMATCH/,
    );
    assert.throws(
      () =>
        r!.live.db
          .prepare("INSERT INTO positions VALUES(?,?,?,?,?)")
          .run("wrong", "demo", "mint", "OPEN", "{}"),
      /MODE_MISMATCH/,
    );
    assert.equal(
      r.live.db.prepare("SELECT count(*) n FROM demo_accounts").get()!.n,
      0,
    );
    assert.equal(
      r.demo.db.prepare("SELECT initial FROM demo_accounts").get()!.initial,
      "100000000000",
    );
    const old = env.TRADING_MODE;
    env.TRADING_MODE = "live";
    assert.equal(r.demo.mode, "demo");
    env.TRADING_MODE = old;
    assert.equal(
      r.learning
        .prepare("SELECT count(*) n FROM sqlite_master WHERE name='positions'")
        .get()!.n,
      0,
    );
  } finally {
    r?.close();
    clean(dir);
  }
});
test("shared market observations deduplicate both-mode windows and dashboards have identical scope", () => {
  const dir = directory();
  let r: DatabaseRegistry | undefined;
  try {
    r = new DatabaseRegistry(dir);
    const a = new ChartStore(r.demo),
      b = new ChartStore(r.live),
      h = parseMarketHistory(candles(60), candidate());
    a.ingest(candidate().mint, h);
    b.ingest(candidate().mint, h);
    assert.equal(a.candles(candidate().mint).length, h.candles.length);
    a.watch(candidate().mint, "demo", 4, "DEMO");
    b.watch(candidate().mint, "live", 2, "LIVE");
    assert.equal(
      r.learning
        .prepare("SELECT count(*) n FROM chart_observation_queue")
        .get()!.n,
      1,
    );
    assert.deepEqual(a.overview("demo"), b.overview("live"));
    assert.equal(
      a.job("EVENT_REVIEW", "same-event", {}, "demo"),
      b.job("EVENT_REVIEW", "same-event", {}, "live"),
    );
  } finally {
    r?.close();
    clean(dir);
  }
});
test("pre-buy shared observations are excluded from Learning and never touch financial state", async () => {
  const dir = directory();
  let r: DatabaseRegistry | undefined;
  let c: ChartLearning | undefined;
  try {
    r = new DatabaseRegistry(dir);
    c = new ChartLearning(r.demo, provider().gmgn, undefined, [r.demo, r.live]);
    r.live.record("kronos_decisions", candidate().mint, {
      action: "WAIT",
      mode: "live",
    });
    assert.equal(
      r.live.db
        .prepare(
          "SELECT count(*) n FROM learning_outbox WHERE delivered_at IS NULL",
        )
        .get()!.n,
      1,
    );
    c.drainOutboxes();
    c.drainOutboxes();
    assert.equal(
      r.learning.prepare("SELECT count(*) n FROM learning_records").get()!.n,
      0,
    );
    assert.equal(r.live.db.prepare("SELECT count(*) n FROM learning_outbox WHERE delivered_at IS NULL").get()!.n, 0);
    assert.equal(
      r.demo.db.prepare("SELECT count(*) n FROM records").get()!.n,
      0,
    );
  } finally {
    await c?.stop();
    r?.close();
    clean(dir);
  }
});

test("migration backs up WAL, isolates explicit ownership, quarantines ambiguity, verifies and resumes", async () => {
  const dir = directory(),
    legacy = join(dir, "bot.sqlite");
  let s: Store | undefined, r: DatabaseRegistry | undefined;
  try {
    s = new Store(legacy);
    const demo = { ...position(), mode: "demo" as const },
      live = { ...position(), mode: "live" as const };
    s.savePosition(demo);
    s.savePosition(live);
    s.db
      .prepare(
        "INSERT INTO records(kind,mint,payload,at) VALUES('ambiguous','mint','{}',?)",
      )
      .run(Date.now());
    new ChartStore(s).ingest(
      candidate().mint,
      parseMarketHistory(candles(60), candidate()),
    );
    const before = Number(
      s.db.prepare("SELECT count(*) n FROM positions").get()!.n,
    );
    writeFileSync(legacy + ".lock", String(process.pid));
    await assert.rejects(migrateDatabases(legacy, dir), /REQUIRES_OFFLINE/);
    unlinkSync(legacy + ".lock");
    await assert.rejects(
      migrateDatabases(legacy, dir, { failAfter: 4 }),
      /INJECTED_INTERRUPTION/,
    );
    // The first snapshot was taken while committed data still lived in WAL.
    s.close();
    s = undefined;
    const report = await migrateDatabases(legacy, dir);
    assert.equal(report.state, "VERIFIED");
    assert.ok("backupPath" in report && existsSync(report.backupPath));
    r = new DatabaseRegistry(dir);
    assert.equal(r.demo.positions().length, 1);
    assert.equal(r.live.positions().length, 1);
    assert.equal(r.demo.positions()[0]!.id, demo.id);
    assert.equal(r.live.positions()[0]!.id, live.id);
    assert.equal(
      r.demo.db.prepare("SELECT initial FROM demo_accounts").get()!.initial,
      "100000000000",
    );
    assert.ok(
      Number(
        r.learning.prepare("SELECT count(*) n FROM migration_quarantine").get()!
          .n,
      ) >= 1,
    );
    assert.ok(
      Number(
        r.learning.prepare("SELECT count(*) n FROM chart_candles").get()!.n,
      ) > 0,
    );
    verify(r.demo.db);
    verify(r.live.db);
    verify(r.learning);
    r.close();
    r = undefined;
    assert.deepEqual(await migrateDatabases(legacy, dir), report);
    s = new Store(legacy, { readOnly: true });
    assert.equal(
      s.db.prepare("SELECT count(*) n FROM positions").get()!.n,
      before,
    );
  } finally {
    s?.close();
    r?.close();
    clean(dir);
  }
});
test("learning worker and knowledge persist through both safe mode transitions", async () => {
  const dir = directory();
  let r: DatabaseRegistry | undefined, c: ChartLearning | undefined;
  const old = env.TRADING_MODE;
  try {
    r = new DatabaseRegistry(dir);
    c = new ChartLearning(r.demo, provider().gmgn, undefined, [r.demo, r.live]);
    const worker = c,
      events: string[] = [];
    const manager = new ModeManager(
      r.demo,
      (mode) => ({
        running: false as boolean,
        async start() {
          this.running = true;
          events.push("start:" + mode);
        },
        async stop() {
          this.running = false;
          events.push("stop:" + mode);
        },
      }),
      async () => {},
      undefined,
      undefined,
      r,
    );
    const charts = c.charts;
    charts.ingest(
      candidate().mint,
      parseMarketHistory(candles(60), candidate()),
    );
    const count = charts.overview("demo").candleCount;
    await manager.switch("DEMO");
    r.demo.savePosition({
      ...position(),
      mode: "demo",
      quantity: "0",
      state: "CLOSED",
    });
    await manager.switch("LIVE", "START LIVE");
    assert.equal(c, worker);
    assert.equal(charts.overview("live").candleCount, count);
    assert.equal(r.demo.positions()[0]!.state, "CLOSED");
    assert.equal(r.live.positions().length, 0);
    await manager.switch("DEMO");
    assert.equal(c, worker);
    await manager.stop();
    assert.equal(events.filter((e) => e === "start:DEMO").length, 2);
    const live = {
      ...position(),
      mode: "live" as const,
      strategy: "KRONOS" as const,
    };
    r.live.savePosition(live);
    await manager.switch("LIVE", "START LIVE");
    await assert.rejects(
      manager.switch("DEMO"),
      /LIVE_POSITION_REQUIRES_MONITORING/,
    );
    assert.equal(manager.engine!.running, true);
    await manager.stop();
  } finally {
    env.TRADING_MODE = old;
    await c?.stop();
    r?.close();
    clean(dir);
  }
});

test("DEMO BUY remains in its bound database when global mode changes during quote; LIVE BUY is isolated", async () => {
  const dir = directory(),
    old = env.TRADING_MODE;
  let r: DatabaseRegistry | undefined;
  try {
    r = new DatabaseRegistry(dir);
    const demo = setup({ store: r.demo });
    try {
      const quotes = demo.engine.executor.provider,
        original = quotes.quoteBuy.bind(quotes);
      quotes.quoteBuy = async (...args) => {
        env.TRADING_MODE = "live";
        return original(...args);
      };
      await demo.engine.analyze(candidate().mint);
      await demo.engine.settleEntryEvaluations();
      assert.equal(r.demo.executions().length, 1);
      assert.equal(r.demo.executions()[0]!.intent.mode, "demo");
      assert.equal(r.live.executions().length, 0);
    } finally {
      await demo.engine.stop();
    }
    const live = mockExecutionCase(undefined, {
      strategy: "KRONOS",
      store: r.live,
    });
    try {
      await live.e.analyze(candidate().mint);
      await live.e.settleEntryEvaluations();
      assert.equal(r.live.executions().length, 1);
      assert.equal(r.live.executions()[0]!.intent.mode, "live");
      assert.equal(r.demo.executions().length, 1);
      assert.equal(
        r.live.db.prepare("SELECT count(*) n FROM demo_accounts").get()!.n,
        0,
      );
    } finally {
      await live.close();
    }
  } finally {
    env.TRADING_MODE = old;
    r?.close();
    clean(dir);
  }
});
test("concurrent WAL learning writers deduplicate identical market identities without corrupting SQLite", async () => {
  const dir = directory();
  let r: DatabaseRegistry | undefined;
  try {
    r = new DatabaseRegistry(dir);
    const code = `const {parentPort,workerData}=require('node:worker_threads');const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(workerData);db.exec('PRAGMA busy_timeout=5000');for(let i=0;i<300;i++)db.prepare('INSERT OR IGNORE INTO chart_candles VALUES(?,?,?,?,?,?)').run('concurrent-'+i,'fixture','FIXTURE',i*60000,999999999,JSON.stringify({at:i*60000,open:1,high:1,low:1,close:1,volumeUsd:null}));db.close();parentPort.postMessage('done');`;
    await Promise.all(
      [0, 1].map(
        () =>
          new Promise<void>((resolve, reject) => {
            const worker = new Worker(code, {
              eval: true,
              workerData: join(dir, "learning.sqlite"),
            });
            worker.once("error", reject);
            worker.once("exit", (n) =>
              n ? reject(Error("WORKER_EXIT_" + n)) : resolve(),
            );
          }),
      ),
    );
    assert.equal(
      r.learning.prepare("SELECT count(*) n FROM chart_candles").get()!.n,
      300,
    );
    verify(r.learning);
  } finally {
    r?.close();
    clean(dir);
  }
});
test("standard and contradiction jobs select centrally configured Luna and Sol with auditable usage", async () => {
  const used: string[] = [];
  const transport: typeof fetch = async (_url, init) => {
    used.push(JSON.parse(String(init?.body)).model);
    return new Response(
      JSON.stringify({
        status: "completed",
        usage: { total_tokens: 10 },
        output: [
          {
            content: [
              {
                type: "output_text",
                text: JSON.stringify({
                  action: "REVIEW",
                  reason: "Fixture",
                  ruleIds: [],
                  supportingEventIds: [],
                  contradictoryEventIds: [],
                  uncertainty: "fixture",
                  hypothesis: null,
                }),
              },
            ],
          },
        ],
      }),
    );
  };
  const standard = new CodexRuntime(
    "fixture-key",
    "gpt-6-luna",
    transport,
    undefined,
    "gpt-6.1-sol",
  );
  const deep = new CodexRuntime(
    "fixture-key",
    "gpt-6-luna",
    transport,
    undefined,
    "gpt-6.1-sol",
  );
  await standard.analyze({});
  await deep.analyze({ analysisDepth: "DEEP" });
  assert.deepEqual(used, ["gpt-6-luna", "gpt-6.1-sol"]);
  assert.equal(deep.status().lastModel, "gpt-6.1-sol");
  assert.equal(deep.status().tokensByModel["gpt-6.1-sol"], 10);
});

test("both modes apply the identical validated rule with zero AI calls on the fast path", async () => {
  const dir = directory();
  let r: DatabaseRegistry | undefined, c: ChartLearning | undefined;
  let calls = 0;
  try {
    r = new DatabaseRegistry(dir);
    c = new ChartLearning(
      r.demo,
      provider().gmgn,
      {
        status: () => ({
          state: "FIXTURE",
          model: "NO_NETWORK",
          promptVersion: "fixture",
        }),
        analyze: async () => {
          calls++;
          throw Error("LLM_FORBIDDEN");
        },
      },
      [r.demo, r.live],
    );
    const h = parseMarketHistory(candles(60), candidate());
    h.candles[0]!.low = h.candles[0]!.open * 0.55;
    c.charts.ingest(candidate().mint, h);
    const event = c.charts.events(100).find((e) => e.kind === "RUG_30")!;
    const rule: LearningRule = {
      id: "fixture-shared-rule",
      version: 1,
      at: Date.now(),
      name: "FIXTURE ONLY",
      description: "Not a research conclusion",
      status: "VALIDATED",
      behaviors: ["SLOW_RISE"],
      window: 15,
      action: "BLOCK",
      invalidation: "Fixture ends",
      supportingEventIds: [event.id],
      contradictoryEventIds: [],
      validationId: "fixture-validation",
    };
    r.learning.prepare("INSERT INTO chart_validations VALUES(?,?,?)").run(
      rule.validationId!,
      rule.at,
      JSON.stringify({
        passed: true,
        ruleId: rule.id,
        ruleVersion: 1,
        definitionHash: chartId(rule.behaviors, rule.window, rule.action),
        fixture: true,
      }),
    );
    c.charts.saveRule(rule);
    const a = await c.decide(candidate(), h, normalizeMarket(info()), "demo"),
      b = await c.decide(candidate(), h, normalizeMarket(info()), "live");
    assert.equal(a.action, "BLOCK");
    assert.equal(b.action, "BLOCK");
    assert.deepEqual(a.rules, b.rules);
    assert.equal(calls, 0);
    assert.equal(
      r.demo.db
        .prepare(
          "SELECT count(*) n FROM sqlite_master WHERE name='chart_decisions'",
        )
        .get()!.n,
      0,
    );
    assert.equal(
      r.live.db
        .prepare(
          "SELECT count(*) n FROM sqlite_master WHERE name='chart_decisions'",
        )
        .get()!.n,
      0,
    );
  } finally {
    await c?.stop();
    r?.close();
    clean(dir);
  }
});

test("urgent KRONOS SELL remains executable when the shared learning writer is locked", async () => {
  const dir = directory();
  let r: DatabaseRegistry | undefined,
    e: Engine | undefined,
    writer: DatabaseSync | undefined;
  try {
    r = new DatabaseRegistry(dir);
    e = new Engine(r.demo, {
      gmgn: provider().gmgn,
      rpc: fixtureRpc(),
      demoQuotes: fixtureQuotes(),
      kronos: fakeKronos(0.9),
    });
    const p = {
      ...position(),
      mode: "demo" as const,
      strategy: "KRONOS" as const,
      quantity: "123456",
      originalQuantity: "123456",
    };
    fundFixtureHolding(r.demo, p);
    r.demo.record("position_market", p.mint, normalizeMarket(info()));
    writer = new DatabaseSync(join(dir, "learning.sqlite"));
    writer.exec("BEGIN IMMEDIATE");
    const start = performance.now();
    (e as any).scheduleKronosPosition(
      p,
      parseMarketHistory(candles(60), candidate()),
    );
    await Promise.all((e as any).kronosJobs.values());
    (e as any).solPrice = "100";
    (e as any).solPriceAt = Date.now();
    await e.processExits();
    assert.equal(r.demo.executions()[0]!.state, "CONFIRMED");
    assert.equal(r.demo.positions()[0]!.state, "CLOSED");
    assert.ok(
      performance.now() - start < 1000,
      "Learning busy timeout must not stall urgent exits for seconds",
    );
  } finally {
    if (writer) {
      writer.exec("ROLLBACK");
      writer.close();
    }
    await e?.stop();
    r?.close();
    clean(dir);
  }
});
